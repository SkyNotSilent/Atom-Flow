import pg from "pg";
import type { Logger } from "pino";
import { ensureBillingSchema } from "./billing/schema.js";
import { ensureAlipayBillingSchema } from "./billing/alipaySchema.js";
import { normalizeArticleUrl } from "./rss.js";

export const DATABASE_SCHEMA_VERSION = "20260816_alipay_subscription_v1";
export const WRITE_CANVAS_AGENT_RUN_MAX_ATTEMPTS = 3;

export const createDatabasePool = (logger?: Logger) => {
  const production = process.env.NODE_ENV === "production";
  const numberFromEnv = (value: string | undefined, fallback: number, min: number, max: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
  };
  const statementTimeoutMs = numberFromEnv(process.env.DB_STATEMENT_TIMEOUT_MS, 30_000, 1_000, 120_000);
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: production ? { rejectUnauthorized: false } : false,
    max: numberFromEnv(process.env.DB_POOL_MAX, 10, 2, 50),
    connectionTimeoutMillis: numberFromEnv(process.env.DB_CONNECTION_TIMEOUT_MS, 5_000, 1_000, 30_000),
    idleTimeoutMillis: numberFromEnv(process.env.DB_IDLE_TIMEOUT_MS, 30_000, 5_000, 120_000),
    statement_timeout: statementTimeoutMs,
    query_timeout: statementTimeoutMs + 1_000,
  });
  if (logger) {
    pool.on("error", error => {
      logger.error({ err: error, module: "db" }, "Unexpected PostgreSQL pool error");
    });
  }
  return pool;
};

const logMigrationPhase = (logger: Logger, phase: string, startedAt: number) => {
  logger.info({ module: "db", migrationPhase: phase, durationMs: Date.now() - startedAt }, "Database migration phase completed");
};

export const runDatabaseMigrations = async (pool: pg.Pool, logger: Logger) => {
  const migrationStartedAt = Date.now();
  const schemaLockClient = await pool.connect();
  let schemaLockReleased = false;
  try {
  const lockStartedAt = Date.now();
  await schemaLockClient.query(`SELECT pg_advisory_lock(hashtext('atomflow-schema-migration'))`);
  logMigrationPhase(logger, "advisory-lock", lockStartedAt);
  try {
  const applicationSchemaStartedAt = Date.now();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id           SERIAL PRIMARY KEY,
      email        TEXT NOT NULL UNIQUE,
      nickname     TEXT,
      avatar_url   TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS atomflow_schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  const runSchemaMigrationOnce = async (
    id: string,
    migrate: (client: pg.PoolClient) => Promise<void>,
  ) => {
    const migrationClient = await pool.connect();
    try {
      await migrationClient.query("BEGIN");
      const claimed = await migrationClient.query(
        `INSERT INTO atomflow_schema_migrations (id)
         VALUES ($1)
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [id],
      );
      if (claimed.rowCount === 1) await migrate(migrationClient);
      await migrationClient.query("COMMIT");
    } catch (error) {
      await migrationClient.query("ROLLBACK");
      throw error;
    } finally {
      migrationClient.release();
    }
  };
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_ai_usage_daily (
      user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      usage_date            DATE NOT NULL DEFAULT CURRENT_DATE,
      operation_count       INTEGER NOT NULL DEFAULT 0 CHECK (operation_count >= 0),
      reserved_output_tokens BIGINT NOT NULL DEFAULT 0 CHECK (reserved_output_tokens >= 0),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, usage_date)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_budget_reservations (
      id              BIGSERIAL PRIMARY KEY,
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      usage_date      DATE NOT NULL,
      reserved_tokens BIGINT NOT NULL CHECK (reserved_tokens > 0),
      operation_count INTEGER NOT NULL DEFAULT 1 CHECK (operation_count > 0),
      route            TEXT NOT NULL DEFAULT '',
      state            TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending','provider_started','refunded')),
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ai_budget_reservations_pending ON ai_budget_reservations(updated_at) WHERE state = 'pending'`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS verification_codes (
      id           SERIAL PRIMARY KEY,
      email        TEXT NOT NULL,
      code         TEXT NOT NULL,
      expires_at   TIMESTAMPTZ NOT NULL,
      used         BOOLEAN NOT NULL DEFAULT FALSE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_vc_email ON verification_codes(email, used, expires_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_vc_expires_at ON verification_codes(expires_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_vc_used_created_at ON verification_codes(created_at) WHERE used = TRUE`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS session (
      sid VARCHAR NOT NULL PRIMARY KEY,
      sess JSON NOT NULL,
      expire TIMESTAMP(6) NOT NULL
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON session(expire)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_session_user_id ON session ((sess ->> 'userId'))`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS saved_cards (
      id             TEXT PRIMARY KEY,
      user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type           TEXT NOT NULL,
      content        TEXT NOT NULL,
      tags           JSONB NOT NULL DEFAULT '[]'::jsonb,
      article_title  TEXT NOT NULL DEFAULT '',
      article_id     BIGINT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_saved_cards_user ON saved_cards(user_id)`);
  await pool.query(`ALTER TABLE saved_cards ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_saved_cards_updated ON saved_cards(user_id, updated_at DESC)`);

  // --- Schema migrations for password auth, preferences, notes ---
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT`);
  await pool.query(`ALTER TABLE verification_codes ADD COLUMN IF NOT EXISTS password_hash TEXT`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      source_layout JSONB,
      theme        TEXT DEFAULT 'light',
      view_mode    TEXT DEFAULT 'card',
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notes (
      id           SERIAL PRIMARY KEY,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title        TEXT NOT NULL DEFAULT '',
      content      TEXT NOT NULL DEFAULT '',
      tags         JSONB NOT NULL DEFAULT '[]'::jsonb,
      meta         JSONB NOT NULL DEFAULT '{}'::jsonb,
      creation_key TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE notes ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}'::jsonb`);
  await pool.query(`ALTER TABLE notes ADD COLUMN IF NOT EXISTS creation_key TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_notes_user ON notes(user_id, updated_at DESC)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_creation_key ON notes(user_id, creation_key) WHERE creation_key IS NOT NULL`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS write_agent_threads (
      id           BIGSERIAL PRIMARY KEY,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title        TEXT NOT NULL DEFAULT '新的写作会话',
      summary      TEXT NOT NULL DEFAULT '',
      state        JSONB NOT NULL DEFAULT '{}'::jsonb,
      thread_type  TEXT NOT NULL DEFAULT 'chat' CHECK (thread_type IN ('chat', 'skill', 'canvas')),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_agent_threads_user ON write_agent_threads(user_id, updated_at DESC)`);
  await pool.query(`ALTER TABLE write_agent_threads ADD COLUMN IF NOT EXISTS thread_type TEXT NOT NULL DEFAULT 'chat'`);
  await runSchemaMigrationOnce("20260809_write_agent_threads_canvas_type", async client => {
    await client.query(`
      ALTER TABLE write_agent_threads
        DROP CONSTRAINT IF EXISTS write_agent_threads_thread_type_check,
        ADD CONSTRAINT write_agent_threads_thread_type_check
          CHECK (thread_type IN ('chat', 'skill', 'canvas')) NOT VALID
    `);
    await client.query(`ALTER TABLE write_agent_threads VALIDATE CONSTRAINT write_agent_threads_thread_type_check`);
  });
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_agent_threads_type ON write_agent_threads(user_id, thread_type, updated_at DESC)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS write_agent_messages (
      id           BIGSERIAL PRIMARY KEY,
      thread_id    BIGINT NOT NULL REFERENCES write_agent_threads(id) ON DELETE CASCADE,
      role         TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
      content      TEXT NOT NULL DEFAULT '',
      meta         JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_agent_messages_thread ON write_agent_messages(thread_id, created_at ASC)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_write_agent_canvas_user_request ON write_agent_messages(thread_id, (meta->>'canvasRunRequestKey')) WHERE role = 'user' AND meta ? 'canvasRunRequestKey'`);

  // User custom subscriptions
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_subscriptions (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      rss_url     TEXT NOT NULL,
      color       TEXT NOT NULL DEFAULT '#718096',
      icon        TEXT,
      topic       TEXT NOT NULL DEFAULT '自定义订阅',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, name)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user ON user_subscriptions(user_id)`);

  // Articles from user custom subscriptions (permanently stored, per-user)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_articles (
      id              BIGSERIAL PRIMARY KEY,
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      subscription_id INTEGER NOT NULL REFERENCES user_subscriptions(id) ON DELETE CASCADE,
      source          TEXT NOT NULL,
      source_icon     TEXT,
      topic           TEXT NOT NULL DEFAULT '自定义订阅',
      title           TEXT NOT NULL,
      excerpt         TEXT NOT NULL DEFAULT '',
      content         TEXT NOT NULL DEFAULT '',
      url             TEXT,
      audio_url       TEXT,
      audio_duration  TEXT,
      published_at    BIGINT,
      time_str        TEXT NOT NULL DEFAULT '',
      saved           BOOLEAN NOT NULL DEFAULT FALSE,
      full_fetched    BOOLEAN NOT NULL DEFAULT FALSE,
      markdown_content TEXT,
      fetched_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_articles_unique_url ON user_articles(user_id, url) WHERE url IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_articles_user_source ON user_articles(user_id, source)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_articles_published ON user_articles(user_id, published_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_articles_subscription ON user_articles(subscription_id)`);

  // --- saved_articles: persisted original articles when user saves to knowledge base ---
  await pool.query(`
    CREATE TABLE IF NOT EXISTS saved_articles (
      id            BIGSERIAL PRIMARY KEY,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title         TEXT NOT NULL DEFAULT '',
      url           TEXT,
      source        TEXT NOT NULL DEFAULT '',
      source_icon   TEXT,
      topic         TEXT NOT NULL DEFAULT '',
      excerpt       TEXT NOT NULL DEFAULT '',
      content       TEXT NOT NULL DEFAULT '',
      citation_context TEXT,
      image_urls    JSONB NOT NULL DEFAULT '[]'::jsonb,
      audio_url     TEXT,
      audio_duration TEXT,
      published_at  BIGINT,
      saved_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE saved_articles ADD COLUMN IF NOT EXISTS citation_context TEXT`);
  await pool.query(`ALTER TABLE saved_articles ADD COLUMN IF NOT EXISTS image_urls JSONB NOT NULL DEFAULT '[]'::jsonb`);
  await pool.query(`ALTER TABLE saved_articles ADD COLUMN IF NOT EXISTS audio_url TEXT`);
  await pool.query(`ALTER TABLE saved_articles ADD COLUMN IF NOT EXISTS audio_duration TEXT`);
  await pool.query(`ALTER TABLE saved_articles ADD COLUMN IF NOT EXISTS content_hash TEXT`);
  await pool.query(`ALTER TABLE saved_articles ADD COLUMN IF NOT EXISTS normalized_url TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_saved_articles_user ON saved_articles(user_id, saved_at DESC)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_articles_unique ON saved_articles(user_id, url) WHERE url IS NOT NULL`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS write_agent_events (
      id           BIGSERIAL PRIMARY KEY,
      thread_id    BIGINT NOT NULL REFERENCES write_agent_threads(id) ON DELETE CASCADE,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      node         TEXT NOT NULL,
      duration_ms  INTEGER NOT NULL DEFAULT 0,
      input_summary TEXT,
      output_summary TEXT,
      meta         JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_agent_events_thread ON write_agent_events(thread_id, created_at ASC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_agent_events_user ON write_agent_events(user_id)`);

	  await pool.query(`
	    CREATE TABLE IF NOT EXISTS write_style_skills (
      id           BIGSERIAL PRIMARY KEY,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      description  TEXT NOT NULL DEFAULT '',
      prompt       TEXT NOT NULL,
      examples     JSONB NOT NULL DEFAULT '[]'::jsonb,
      constraints  JSONB NOT NULL DEFAULT '[]'::jsonb,
      is_default   BOOLEAN NOT NULL DEFAULT FALSE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
	  `);
	  await pool.query(`ALTER TABLE write_style_skills ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'style'`);
	  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_style_skills_user ON write_style_skills(user_id, updated_at DESC)`);
	  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_style_skills_user_type ON write_style_skills(user_id, type, updated_at DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS write_canvas_projects (
      id             BIGSERIAL PRIMARY KEY,
      user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name           TEXT NOT NULL DEFAULT '新的魔法写作项目',
      viewport       JSONB NOT NULL DEFAULT '{}'::jsonb,
      tldraw_snapshot JSONB NOT NULL DEFAULT '{"store":{}}'::jsonb,
      -- Kept for one rollback window; all current reads use tldraw_snapshot.
      document_snapshot JSONB NOT NULL DEFAULT '{"store":{}}'::jsonb,
      document_revision BIGINT NOT NULL DEFAULT 0 CHECK (document_revision >= 0),
      document_schema_version INTEGER NOT NULL DEFAULT 0 CHECK (document_schema_version >= 0),
      default_skill_config JSONB NOT NULL DEFAULT '{"mode":"override","inherit":false,"skillIds":[]}'::jsonb,
      last_opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE write_canvas_projects ADD COLUMN IF NOT EXISTS document_snapshot JSONB NOT NULL DEFAULT '{"store":{}}'::jsonb`);
  await pool.query(`ALTER TABLE write_canvas_projects ADD COLUMN IF NOT EXISTS tldraw_snapshot JSONB`);
  await pool.query(`UPDATE write_canvas_projects SET tldraw_snapshot = document_snapshot WHERE tldraw_snapshot IS NULL`);
  await pool.query(`ALTER TABLE write_canvas_projects ALTER COLUMN tldraw_snapshot SET DEFAULT '{"store":{}}'::jsonb`);
  await pool.query(`ALTER TABLE write_canvas_projects ALTER COLUMN tldraw_snapshot SET NOT NULL`);
  await pool.query(`ALTER TABLE write_canvas_projects ADD COLUMN IF NOT EXISTS document_revision BIGINT NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE write_canvas_projects ADD COLUMN IF NOT EXISTS document_schema_version INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE write_canvas_projects ADD COLUMN IF NOT EXISTS default_skill_config JSONB NOT NULL DEFAULT '{"mode":"override","inherit":false,"skillIds":[]}'::jsonb`);
  await pool.query(`ALTER TABLE write_canvas_projects ALTER COLUMN default_skill_config SET DEFAULT '{"mode":"override","inherit":false,"skillIds":[]}'::jsonb`);
  await pool.query(`
    UPDATE write_canvas_projects
    SET default_skill_config = default_skill_config || '{"mode":"override","inherit":false}'::jsonb
    WHERE NOT (default_skill_config ? 'mode') AND NOT (default_skill_config ? 'inherit')
  `);
  await runSchemaMigrationOnce("20260809_write_canvas_project_document_checks", async client => {
    await client.query(`
      ALTER TABLE write_canvas_projects
        DROP CONSTRAINT IF EXISTS write_canvas_projects_document_revision_check,
        DROP CONSTRAINT IF EXISTS write_canvas_projects_document_schema_version_check,
        DROP CONSTRAINT IF EXISTS write_canvas_projects_default_skill_config_check,
        DROP CONSTRAINT IF EXISTS write_canvas_projects_tldraw_snapshot_check,
        ADD CONSTRAINT write_canvas_projects_document_revision_check CHECK (document_revision >= 0) NOT VALID,
        ADD CONSTRAINT write_canvas_projects_document_schema_version_check CHECK (document_schema_version >= 0) NOT VALID,
        ADD CONSTRAINT write_canvas_projects_default_skill_config_check CHECK (jsonb_typeof(default_skill_config) = 'object') NOT VALID,
        ADD CONSTRAINT write_canvas_projects_tldraw_snapshot_check CHECK (jsonb_typeof(tldraw_snapshot) = 'object') NOT VALID
    `);
    await client.query(`
      ALTER TABLE write_canvas_projects
        VALIDATE CONSTRAINT write_canvas_projects_document_revision_check,
        VALIDATE CONSTRAINT write_canvas_projects_document_schema_version_check,
        VALIDATE CONSTRAINT write_canvas_projects_default_skill_config_check,
        VALIDATE CONSTRAINT write_canvas_projects_tldraw_snapshot_check
    `);
  });
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_canvas_projects_user ON write_canvas_projects(user_id, last_opened_at DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS write_canvas_assets (
      id             BIGSERIAL PRIMARY KEY,
      user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id     BIGINT REFERENCES write_canvas_projects(id) ON DELETE CASCADE,
      type           TEXT NOT NULL CHECK (type IN ('text','file','image')),
      title          TEXT NOT NULL DEFAULT '',
      content_text   TEXT NOT NULL DEFAULT '',
      extracted_text TEXT NOT NULL DEFAULT '',
      file_name      TEXT,
      mime_type      TEXT,
      data_url       TEXT,
      meta           JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_canvas_assets_user ON write_canvas_assets(user_id, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_canvas_assets_project ON write_canvas_assets(project_id) WHERE project_id IS NOT NULL`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS write_agent_templates (
      id            BIGSERIAL PRIMARY KEY,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      model         TEXT NOT NULL,
      system_prompt TEXT NOT NULL DEFAULT '',
      temperature   REAL NOT NULL DEFAULT 0.55,
      top_p         REAL NOT NULL DEFAULT 1,
      max_tokens    INTEGER NOT NULL DEFAULT 1200,
      skill_config  JSONB NOT NULL DEFAULT '{"mode":"inherit","inherit":true,"skillIds":[]}'::jsonb,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE write_agent_templates ADD COLUMN IF NOT EXISTS skill_config JSONB NOT NULL DEFAULT '{"mode":"inherit","inherit":true,"skillIds":[]}'::jsonb`);
  await pool.query(`ALTER TABLE write_agent_templates ALTER COLUMN skill_config SET DEFAULT '{"mode":"inherit","inherit":true,"skillIds":[]}'::jsonb`);
  await pool.query(`
    UPDATE write_agent_templates
    SET skill_config = skill_config || CASE
      WHEN jsonb_array_length(CASE WHEN jsonb_typeof(skill_config->'skillIds') = 'array' THEN skill_config->'skillIds' ELSE '[]'::jsonb END) > 0
        OR skill_config ? 'primaryStyleSkillId'
        OR jsonb_array_length(CASE WHEN jsonb_typeof(skill_config->'selectedSkillIds') = 'array' THEN skill_config->'selectedSkillIds' ELSE '[]'::jsonb END) > 0
        OR skill_config ? 'selectedStyleSkillId'
      THEN '{"mode":"override","inherit":false}'::jsonb
      ELSE '{"mode":"inherit","inherit":true}'::jsonb
    END
    WHERE NOT (skill_config ? 'mode') AND NOT (skill_config ? 'inherit')
  `);
  await runSchemaMigrationOnce("20260809_write_agent_template_skill_config_check", async client => {
    await client.query(`
      ALTER TABLE write_agent_templates
        DROP CONSTRAINT IF EXISTS write_agent_templates_skill_config_check,
        ADD CONSTRAINT write_agent_templates_skill_config_check
          CHECK (jsonb_typeof(skill_config) = 'object') NOT VALID
    `);
    await client.query(`ALTER TABLE write_agent_templates VALIDATE CONSTRAINT write_agent_templates_skill_config_check`);
  });
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_agent_templates_user ON write_agent_templates(user_id, updated_at DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS write_agent_instances (
      id            BIGSERIAL PRIMARY KEY,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id    BIGINT NOT NULL REFERENCES write_canvas_projects(id) ON DELETE CASCADE,
      template_id   BIGINT REFERENCES write_agent_templates(id) ON DELETE SET NULL,
      name          TEXT NOT NULL DEFAULT '写作 Agent',
      model         TEXT NOT NULL,
      system_prompt TEXT NOT NULL DEFAULT '',
      temperature   REAL NOT NULL DEFAULT 0.55,
      top_p         REAL NOT NULL DEFAULT 1,
      max_tokens    INTEGER NOT NULL DEFAULT 1200,
      skill_config  JSONB NOT NULL DEFAULT '{"mode":"inherit","inherit":true,"skillIds":[]}'::jsonb,
      agent_thread_id BIGINT REFERENCES write_agent_threads(id) ON DELETE SET NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE write_agent_instances ADD COLUMN IF NOT EXISTS skill_config JSONB NOT NULL DEFAULT '{"mode":"inherit","inherit":true,"skillIds":[]}'::jsonb`);
  await pool.query(`ALTER TABLE write_agent_instances ALTER COLUMN skill_config SET DEFAULT '{"mode":"inherit","inherit":true,"skillIds":[]}'::jsonb`);
  await pool.query(`
    UPDATE write_agent_instances
    SET skill_config = skill_config || CASE
      WHEN jsonb_array_length(CASE WHEN jsonb_typeof(skill_config->'skillIds') = 'array' THEN skill_config->'skillIds' ELSE '[]'::jsonb END) > 0
        OR skill_config ? 'primaryStyleSkillId'
        OR jsonb_array_length(CASE WHEN jsonb_typeof(skill_config->'selectedSkillIds') = 'array' THEN skill_config->'selectedSkillIds' ELSE '[]'::jsonb END) > 0
        OR skill_config ? 'selectedStyleSkillId'
      THEN '{"mode":"override","inherit":false}'::jsonb
      ELSE '{"mode":"inherit","inherit":true}'::jsonb
    END
    WHERE NOT (skill_config ? 'mode') AND NOT (skill_config ? 'inherit')
  `);
  await pool.query(`ALTER TABLE write_agent_instances ADD COLUMN IF NOT EXISTS agent_thread_id BIGINT REFERENCES write_agent_threads(id) ON DELETE SET NULL`);
  await runSchemaMigrationOnce("20260809_write_agent_instance_skill_config_check", async client => {
    await client.query(`
      ALTER TABLE write_agent_instances
        DROP CONSTRAINT IF EXISTS write_agent_instances_skill_config_check,
        ADD CONSTRAINT write_agent_instances_skill_config_check
          CHECK (jsonb_typeof(skill_config) = 'object') NOT VALID
    `);
    await client.query(`ALTER TABLE write_agent_instances VALIDATE CONSTRAINT write_agent_instances_skill_config_check`);
  });
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_write_agent_instances_thread ON write_agent_instances(agent_thread_id) WHERE agent_thread_id IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_agent_instances_project ON write_agent_instances(project_id, updated_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_agent_instances_template ON write_agent_instances(template_id) WHERE template_id IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_agent_instances_user ON write_agent_instances(user_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS write_canvas_nodes (
      id          BIGSERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id  BIGINT NOT NULL REFERENCES write_canvas_projects(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL CHECK (kind IN ('asset_text','asset_file','asset_image','saved_article','atom_card','citation','podcast_episode','note','agent','result')),
      title       TEXT NOT NULL DEFAULT '',
      summary     TEXT NOT NULL DEFAULT '',
      ref_id      TEXT,
      asset_id    BIGINT REFERENCES write_canvas_assets(id) ON DELETE SET NULL,
      agent_id    BIGINT REFERENCES write_agent_instances(id) ON DELETE CASCADE,
      meta        JSONB NOT NULL DEFAULT '{}'::jsonb,
      x           REAL NOT NULL DEFAULT 0,
      y           REAL NOT NULL DEFAULT 0,
      width       REAL NOT NULL DEFAULT 280,
      height      REAL NOT NULL DEFAULT 180,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await runSchemaMigrationOnce("20260809_write_canvas_node_citation_podcast_kinds", async client => {
    await client.query(`
      ALTER TABLE write_canvas_nodes
        DROP CONSTRAINT IF EXISTS write_canvas_nodes_kind_check,
        ADD CONSTRAINT write_canvas_nodes_kind_check
          CHECK (kind IN ('asset_text','asset_file','asset_image','saved_article','atom_card','citation','podcast_episode','note','agent','result')) NOT VALID
    `);
    await client.query(`ALTER TABLE write_canvas_nodes VALIDATE CONSTRAINT write_canvas_nodes_kind_check`);
  });
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_canvas_nodes_project ON write_canvas_nodes(project_id, updated_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_canvas_nodes_user ON write_canvas_nodes(user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_canvas_nodes_asset ON write_canvas_nodes(asset_id) WHERE asset_id IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_canvas_nodes_agent ON write_canvas_nodes(agent_id) WHERE agent_id IS NOT NULL`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_write_canvas_citation_capture ON write_canvas_nodes(user_id, project_id, ref_id) WHERE kind = 'citation' AND ref_id IS NOT NULL`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_write_canvas_result_idempotency ON write_canvas_nodes(user_id, project_id, (meta->>'sourceAgentId'), (meta->>'resultKey')) WHERE kind = 'result' AND meta ? 'sourceAgentId' AND meta ? 'resultKey'`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS write_canvas_action_requests (
      id                BIGSERIAL PRIMARY KEY,
      user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      request_id        UUID NOT NULL,
      action            TEXT NOT NULL CHECK (char_length(action) BETWEEN 1 AND 80),
      result_project_id BIGINT REFERENCES write_canvas_projects(id) ON DELETE CASCADE,
      result_node_id    BIGINT REFERENCES write_canvas_nodes(id) ON DELETE CASCADE,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK ((result_project_id IS NOT NULL)::int + (result_node_id IS NOT NULL)::int = 1),
      UNIQUE (user_id, request_id, action)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_canvas_action_project ON write_canvas_action_requests(result_project_id) WHERE result_project_id IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_canvas_action_node ON write_canvas_action_requests(result_node_id) WHERE result_node_id IS NOT NULL`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS write_canvas_edges (
      id             BIGSERIAL PRIMARY KEY,
      user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id     BIGINT NOT NULL REFERENCES write_canvas_projects(id) ON DELETE CASCADE,
      source_node_id BIGINT NOT NULL REFERENCES write_canvas_nodes(id) ON DELETE CASCADE,
      target_node_id BIGINT NOT NULL REFERENCES write_canvas_nodes(id) ON DELETE CASCADE,
      relation       TEXT NOT NULL DEFAULT 'context' CHECK (relation IN ('context')),
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (project_id, source_node_id, target_node_id, relation)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_canvas_edges_target ON write_canvas_edges(project_id, target_node_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_canvas_edges_user ON write_canvas_edges(user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_canvas_edges_source_node ON write_canvas_edges(source_node_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_canvas_edges_target_node ON write_canvas_edges(target_node_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS write_canvas_agent_messages (
      id         BIGSERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      agent_id   BIGINT NOT NULL REFERENCES write_agent_instances(id) ON DELETE CASCADE,
      role       TEXT NOT NULL CHECK (role IN ('user','assistant')),
      content    TEXT NOT NULL DEFAULT '',
      meta       JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_canvas_agent_messages_agent ON write_canvas_agent_messages(agent_id, created_at ASC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_canvas_agent_messages_user ON write_canvas_agent_messages(user_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS write_canvas_agent_run_requests (
      id                  BIGSERIAL PRIMARY KEY,
      user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      agent_id            BIGINT NOT NULL REFERENCES write_agent_instances(id) ON DELETE CASCADE,
      request_id          TEXT NOT NULL CHECK (char_length(request_id) BETWEEN 1 AND 128),
      request_fingerprint TEXT NOT NULL,
      action              TEXT NOT NULL DEFAULT 'create_article' CHECK (action IN ('create_article')),
      run_id              UUID NOT NULL,
      status              TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
      response_payload    JSONB,
      note_id             INTEGER REFERENCES notes(id) ON DELETE SET NULL,
      thread_id           BIGINT REFERENCES write_agent_threads(id) ON DELETE SET NULL,
      budget_reserved_at  TIMESTAMPTZ,
      provider_started_at TIMESTAMPTZ,
      lease_expires_at    TIMESTAMPTZ,
      attempt_count       INTEGER NOT NULL DEFAULT 0,
      error_message       TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at        TIMESTAMPTZ,
      CONSTRAINT write_canvas_agent_run_attempt_nonnegative_check
        CHECK (attempt_count >= 0),
      CONSTRAINT write_canvas_agent_run_attempt_max_check
        CHECK (attempt_count <= ${WRITE_CANVAS_AGENT_RUN_MAX_ATTEMPTS}),
      UNIQUE (user_id, agent_id, request_id)
    )
  `);
  await runSchemaMigrationOnce("20260809_write_canvas_agent_attempt_accounting", async client => {
    await client.query(`
      ALTER TABLE write_canvas_agent_run_requests
        ADD COLUMN IF NOT EXISTS provider_started_at TIMESTAMPTZ,
        ALTER COLUMN attempt_count SET DEFAULT 0,
        DROP CONSTRAINT IF EXISTS write_canvas_agent_run_requests_attempt_count_check,
        DROP CONSTRAINT IF EXISTS write_canvas_agent_run_attempt_nonnegative_check,
        ADD CONSTRAINT write_canvas_agent_run_attempt_nonnegative_check
          CHECK (attempt_count >= 0) NOT VALID
    `);
    // The legacy budget middleware claimed/incremented before checking quota.
    // Only the final, explicitly recorded quota rejection is knowable from the
    // old row, so restore exactly that one attempt without over-crediting any
    // earlier provider calls on the same request.
    await client.query(`
      UPDATE write_canvas_agent_run_requests
      SET attempt_count = GREATEST(attempt_count - 1, 0)
      WHERE status = 'failed'
        AND error_message = 'daily AI budget exhausted'
        AND budget_reserved_at IS NULL
        AND provider_started_at IS NULL
        AND attempt_count > 0
    `);
    // Older rows only recorded that budget had been reserved. Treat those
    // unfinished runs conservatively as provider-started so a retry cannot
    // reuse an already-consumed paid reservation after this state split.
    await client.query(`
      UPDATE write_canvas_agent_run_requests
      SET provider_started_at = budget_reserved_at
      WHERE status IN ('running', 'failed')
        AND budget_reserved_at IS NOT NULL
        AND provider_started_at IS NULL
    `);
    await client.query(`
      ALTER TABLE write_canvas_agent_run_requests
        VALIDATE CONSTRAINT write_canvas_agent_run_attempt_nonnegative_check
    `);
  });
  // Existing installations predate the attempt ceiling. Clamp historical rows
  // once, then let PostgreSQL preserve the same invariant as the claim path.
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'write_canvas_agent_run_requests'::regclass
          AND conname = 'write_canvas_agent_run_attempt_max_check'
      ) THEN
        UPDATE write_canvas_agent_run_requests
        SET attempt_count = ${WRITE_CANVAS_AGENT_RUN_MAX_ATTEMPTS}
        WHERE attempt_count > ${WRITE_CANVAS_AGENT_RUN_MAX_ATTEMPTS};
        ALTER TABLE write_canvas_agent_run_requests
          ADD CONSTRAINT write_canvas_agent_run_attempt_max_check
          CHECK (attempt_count <= ${WRITE_CANVAS_AGENT_RUN_MAX_ATTEMPTS});
      END IF;
    END $$
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_canvas_agent_run_status ON write_canvas_agent_run_requests(user_id, agent_id, status, updated_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_canvas_agent_run_agent ON write_canvas_agent_run_requests(agent_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_canvas_agent_run_note ON write_canvas_agent_run_requests(note_id) WHERE note_id IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_canvas_agent_run_thread ON write_canvas_agent_run_requests(thread_id) WHERE thread_id IS NOT NULL`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS write_canvas_agent_execution_leases (
      id               BIGSERIAL PRIMARY KEY,
      user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      agent_id         BIGINT NOT NULL REFERENCES write_agent_instances(id) ON DELETE CASCADE,
      thread_id        BIGINT REFERENCES write_agent_threads(id) ON DELETE SET NULL,
      run_id           UUID NOT NULL UNIQUE,
      lease_kind       TEXT NOT NULL DEFAULT 'chat' CHECK (lease_kind IN ('chat')),
      lease_expires_at TIMESTAMPTZ NOT NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, agent_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_canvas_agent_execution_lease_user_expiry ON write_canvas_agent_execution_leases(user_id, lease_expires_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_canvas_agent_execution_lease_agent ON write_canvas_agent_execution_leases(agent_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_write_canvas_agent_execution_lease_thread ON write_canvas_agent_execution_leases(thread_id) WHERE thread_id IS NOT NULL`);

  await runSchemaMigrationOnce("20260813_creative_canvas_schema_v2", async client => {
    // Composite tenant keys are prerequisites for the scoped foreign keys below.
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_write_canvas_projects_tenant_unique ON write_canvas_projects(id, user_id)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_write_canvas_nodes_tenant_project_unique ON write_canvas_nodes(id, user_id, project_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS write_canvas_agent_groups (
        id               BIGSERIAL PRIMARY KEY,
        user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        project_id       BIGINT NOT NULL REFERENCES write_canvas_projects(id) ON DELETE CASCADE,
        node_id          BIGINT,
        current_batch_id BIGINT,
        name             TEXT NOT NULL,
        shared_prompt    TEXT NOT NULL DEFAULT '',
        status           TEXT NOT NULL DEFAULT 'ready'
          CHECK (status IN ('ready','running','completed','partial','failed','cancelled')),
        config_snapshot  JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`ALTER TABLE write_canvas_agent_groups ADD COLUMN IF NOT EXISTS node_id BIGINT`);
    await client.query(`ALTER TABLE write_canvas_agent_groups ADD COLUMN IF NOT EXISTS current_batch_id BIGINT`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_write_canvas_agent_groups_project ON write_canvas_agent_groups(user_id, project_id, updated_at DESC)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS write_canvas_agent_group_members (
        id            BIGSERIAL PRIMARY KEY,
        user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        project_id    BIGINT NOT NULL,
        group_id      BIGINT NOT NULL,
        name          TEXT NOT NULL,
        model         TEXT NOT NULL,
        system_prompt TEXT NOT NULL DEFAULT '',
        temperature   REAL NOT NULL DEFAULT 0.55,
        top_p         REAL NOT NULL DEFAULT 1,
        max_tokens    INTEGER NOT NULL DEFAULT 1200,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`ALTER TABLE write_canvas_agent_group_members ADD COLUMN IF NOT EXISTS project_id BIGINT`);
    await client.query(`
      UPDATE write_canvas_agent_group_members member
      SET project_id = agent_group.project_id
      FROM write_canvas_agent_groups agent_group
      WHERE member.group_id = agent_group.id
        AND member.user_id = agent_group.user_id
        AND member.project_id IS NULL
    `);
    await client.query(`ALTER TABLE write_canvas_agent_group_members ALTER COLUMN project_id SET NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_write_canvas_agent_group_members_group ON write_canvas_agent_group_members(user_id, group_id, id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS write_canvas_agent_batches (
        id               BIGSERIAL PRIMARY KEY,
        user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        project_id       BIGINT NOT NULL REFERENCES write_canvas_projects(id) ON DELETE CASCADE,
        group_id         BIGINT NOT NULL,
        message          TEXT NOT NULL DEFAULT '',
        context_node_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        status           TEXT NOT NULL DEFAULT 'queued'
          CHECK (status IN ('queued','running','completed','partial','failed','cancelled')),
        context_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
        config_snapshot  JSONB NOT NULL DEFAULT '{}'::jsonb,
        output           JSONB NOT NULL DEFAULT '{}'::jsonb,
        error            TEXT,
        started_at       TIMESTAMPTZ,
        completed_at     TIMESTAMPTZ,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_write_canvas_agent_batches_group ON write_canvas_agent_batches(user_id, group_id, created_at DESC)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS write_canvas_agent_runs (
        id               BIGSERIAL PRIMARY KEY,
        user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        project_id       BIGINT NOT NULL,
        group_id         BIGINT,
        group_member_id  BIGINT,
        batch_id         BIGINT,
        source_node_id   BIGINT,
        action           TEXT NOT NULL,
        status           TEXT NOT NULL DEFAULT 'queued'
          CHECK (status IN ('queued','running','completed','failed','cancelled')),
        context_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
        config_snapshot  JSONB NOT NULL DEFAULT '{}'::jsonb,
        output           TEXT NOT NULL DEFAULT '',
        error            TEXT,
        reserved_tokens  BIGINT NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
        reservation_date DATE,
        provider_started BOOLEAN NOT NULL DEFAULT FALSE,
        started_at       TIMESTAMPTZ,
        completed_at     TIMESTAMPTZ,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`ALTER TABLE write_canvas_agent_runs ADD COLUMN IF NOT EXISTS reserved_tokens BIGINT NOT NULL DEFAULT 0`);
    await client.query(`ALTER TABLE write_canvas_agent_runs ADD COLUMN IF NOT EXISTS reservation_date DATE`);
    await client.query(`ALTER TABLE write_canvas_agent_runs ADD COLUMN IF NOT EXISTS provider_started BOOLEAN NOT NULL DEFAULT FALSE`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_write_canvas_agent_runs_user ON write_canvas_agent_runs(user_id, project_id, created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_write_canvas_agent_runs_batch ON write_canvas_agent_runs(batch_id, created_at ASC) WHERE batch_id IS NOT NULL`);

    await client.query(`
      UPDATE write_canvas_agent_groups agent_group
      SET current_batch_id = active_batch.id
      FROM (
        SELECT DISTINCT ON (group_id, user_id, project_id)
          id, group_id, user_id, project_id
        FROM write_canvas_agent_batches
        WHERE status = 'running'
        ORDER BY group_id, user_id, project_id, started_at DESC NULLS LAST, id DESC
      ) active_batch
      WHERE agent_group.id = active_batch.group_id
        AND agent_group.user_id = active_batch.user_id
        AND agent_group.project_id = active_batch.project_id
        AND agent_group.current_batch_id IS NULL
    `);
    await client.query(`
      UPDATE write_canvas_agent_groups agent_group
      SET current_batch_id = NULL,
          status = CASE WHEN status = 'running' THEN 'failed' ELSE status END,
          updated_at = NOW()
      WHERE current_batch_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM write_canvas_agent_batches batch
          WHERE batch.id = agent_group.current_batch_id
            AND batch.user_id = agent_group.user_id
            AND batch.project_id = agent_group.project_id
            AND batch.group_id = agent_group.id
        )
    `);

    await client.query(`
      DO $$ DECLARE constraint_definition TEXT; BEGIN
        SELECT pg_get_constraintdef(oid) INTO constraint_definition
        FROM pg_constraint
        WHERE conrelid = 'write_canvas_agent_groups'::regclass
          AND conname = 'write_canvas_agent_groups_status_check';
        IF constraint_definition IS NULL THEN
          ALTER TABLE write_canvas_agent_groups
            ADD CONSTRAINT write_canvas_agent_groups_status_check
            CHECK (status IN ('ready','running','completed','partial','failed','cancelled'));
        ELSIF POSITION('partial' IN constraint_definition) = 0
           OR POSITION('cancelled' IN constraint_definition) = 0 THEN
          ALTER TABLE write_canvas_agent_groups DROP CONSTRAINT write_canvas_agent_groups_status_check;
          ALTER TABLE write_canvas_agent_groups
            ADD CONSTRAINT write_canvas_agent_groups_status_check
            CHECK (status IN ('ready','running','completed','partial','failed','cancelled'));
        END IF;

        SELECT pg_get_constraintdef(oid) INTO constraint_definition
        FROM pg_constraint
        WHERE conrelid = 'write_canvas_agent_batches'::regclass
          AND conname = 'write_canvas_agent_batches_status_check';
        IF constraint_definition IS NULL THEN
          ALTER TABLE write_canvas_agent_batches
            ADD CONSTRAINT write_canvas_agent_batches_status_check
            CHECK (status IN ('queued','running','completed','partial','failed','cancelled'));
        ELSIF POSITION('partial' IN constraint_definition) = 0
           OR POSITION('cancelled' IN constraint_definition) = 0 THEN
          ALTER TABLE write_canvas_agent_batches DROP CONSTRAINT write_canvas_agent_batches_status_check;
          ALTER TABLE write_canvas_agent_batches
            ADD CONSTRAINT write_canvas_agent_batches_status_check
            CHECK (status IN ('queued','running','completed','partial','failed','cancelled'));
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'write_canvas_agent_runs'::regclass
            AND conname = 'write_canvas_agent_runs_reserved_tokens_check'
        ) THEN
          ALTER TABLE write_canvas_agent_runs
            ADD CONSTRAINT write_canvas_agent_runs_reserved_tokens_check
            CHECK (reserved_tokens >= 0);
        END IF;
      END $$
    `);

    await client.query(`ALTER TABLE write_canvas_nodes ADD COLUMN IF NOT EXISTS node_role TEXT`);
    await client.query(`ALTER TABLE write_canvas_nodes ADD COLUMN IF NOT EXISTS content_type TEXT`);
    await client.query(`ALTER TABLE write_canvas_nodes ADD COLUMN IF NOT EXISTS origin TEXT`);
    await client.query(`ALTER TABLE write_canvas_nodes ADD COLUMN IF NOT EXISTS status TEXT`);
    await client.query(`ALTER TABLE write_canvas_nodes ADD COLUMN IF NOT EXISTS business_ref TEXT`);
    await client.query(`ALTER TABLE write_canvas_nodes ADD COLUMN IF NOT EXISTS document_id BIGINT`);
    await client.query(`
      UPDATE write_canvas_nodes
      SET node_role = COALESCE(node_role, CASE kind
            WHEN 'asset_text' THEN 'material'
            WHEN 'asset_file' THEN 'material'
            WHEN 'asset_image' THEN 'material'
            WHEN 'saved_article' THEN 'material'
            WHEN 'atom_card' THEN 'material'
            WHEN 'agent' THEN 'task'
            WHEN 'result' THEN 'document'
            ELSE 'insight'
          END),
          content_type = COALESCE(content_type, CASE kind
            WHEN 'asset_text' THEN 'text'
            WHEN 'asset_file' THEN 'file'
            WHEN 'asset_image' THEN 'image'
            WHEN 'saved_article' THEN 'article'
            WHEN 'atom_card' THEN 'atom_card'
            WHEN 'agent' THEN 'agent'
            WHEN 'result' THEN 'result'
            ELSE 'note'
          END),
          origin = COALESCE(origin, CASE
            WHEN kind IN ('asset_text','asset_file','asset_image','saved_article','atom_card') THEN 'existing'
            WHEN kind = 'result' THEN 'generated'
            ELSE 'manual'
          END),
          status = COALESCE(status, CASE WHEN kind = 'result' THEN 'pending_review' ELSE 'ready' END)
      WHERE node_role IS NULL OR content_type IS NULL OR origin IS NULL OR status IS NULL
    `);
    // Leave the semantic columns nullable for one rolling-deploy compatibility window.
    await client.query(`ALTER TABLE write_canvas_nodes ALTER COLUMN node_role DROP NOT NULL`);
    await client.query(`ALTER TABLE write_canvas_nodes ALTER COLUMN content_type DROP NOT NULL`);
    await client.query(`ALTER TABLE write_canvas_nodes ALTER COLUMN origin DROP NOT NULL`);
    await client.query(`ALTER TABLE write_canvas_nodes ALTER COLUMN status DROP NOT NULL`);

    const duplicateAgentGroupNode = (await client.query<{ businessRef: string; count: string }>(`
      SELECT business_ref AS "businessRef", COUNT(*)::text AS count
      FROM write_canvas_nodes
      WHERE content_type = 'agent_group' AND business_ref IS NOT NULL
      GROUP BY user_id, project_id, content_type, business_ref
      HAVING COUNT(*) > 1
      LIMIT 1
    `)).rows[0];
    if (duplicateAgentGroupNode) {
      throw new Error(
        `Duplicate canvas Agent-group nodes require an explicit backed-up maintenance migration before deployment (group ${duplicateAgentGroupNode.businessRef}, count ${duplicateAgentGroupNode.count})`,
      );
    }
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_write_canvas_agent_group_business_ref_unique
      ON write_canvas_nodes(user_id, project_id, content_type, business_ref)
      WHERE content_type = 'agent_group' AND business_ref IS NOT NULL
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_write_canvas_document_section_business_ref_unique
      ON write_canvas_nodes(user_id, project_id, content_type, business_ref)
      WHERE content_type = 'document_section' AND business_ref IS NOT NULL
    `);
    await client.query(`
      INSERT INTO write_canvas_nodes
        (user_id, project_id, kind, node_role, content_type, origin, status,
         business_ref, title, summary, meta, x, y, width, height)
      SELECT agent_group.user_id, agent_group.project_id, 'result', 'task',
             'agent_group', 'manual', 'ready', agent_group.id::text,
             agent_group.name, LEFT(agent_group.shared_prompt, 500),
             jsonb_build_object('groupId', agent_group.id), 360, 180, 340, 220
      FROM write_canvas_agent_groups agent_group
      WHERE agent_group.node_id IS NULL
      ON CONFLICT (user_id, project_id, content_type, business_ref)
        WHERE content_type = 'agent_group' AND business_ref IS NOT NULL
        DO NOTHING
    `);
    await client.query(`
      UPDATE write_canvas_agent_groups agent_group
      SET node_id = node.id
      FROM write_canvas_nodes node
      WHERE agent_group.node_id IS NULL
        AND node.user_id = agent_group.user_id
        AND node.project_id = agent_group.project_id
        AND node.content_type = 'agent_group'
        AND node.business_ref = agent_group.id::text
    `);
    await client.query(`ALTER TABLE write_canvas_agent_groups ALTER COLUMN node_id SET NOT NULL`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS write_canvas_documents (
        id                 BIGSERIAL PRIMARY KEY,
        user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        project_id         BIGINT NOT NULL REFERENCES write_canvas_projects(id) ON DELETE CASCADE,
        node_id            BIGINT UNIQUE,
        title              TEXT NOT NULL DEFAULT '',
        summary            TEXT NOT NULL DEFAULT '',
        scenario           TEXT NOT NULL DEFAULT '',
        status             TEXT NOT NULL
          CHECK (status IN ('parsing','ready','running','pending_review','adopted','rejected','editing','completed','failed')),
        current_version_id BIGINT,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_write_canvas_documents_project ON write_canvas_documents(user_id, project_id, updated_at DESC)`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS write_canvas_document_versions (
        id             BIGSERIAL PRIMARY KEY,
        user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        document_id    BIGINT NOT NULL REFERENCES write_canvas_documents(id) ON DELETE CASCADE,
        version_number INTEGER NOT NULL,
        snapshot       JSONB NOT NULL,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (document_id, version_number)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_write_canvas_document_versions_document ON write_canvas_document_versions(document_id, version_number DESC)`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS write_canvas_document_sections (
        id          BIGSERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        document_id BIGINT NOT NULL REFERENCES write_canvas_documents(id) ON DELETE CASCADE,
        stable_key  TEXT NOT NULL,
        sort_order  INTEGER NOT NULL,
        heading     TEXT NOT NULL DEFAULT '',
        body        TEXT NOT NULL DEFAULT '',
        level       INTEGER NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 6),
        meta        JSONB NOT NULL DEFAULT '{}'::jsonb,
        UNIQUE (document_id, stable_key),
        UNIQUE (document_id, sort_order)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_write_canvas_document_sections_document ON write_canvas_document_sections(document_id, sort_order)`);

    const ambiguousLegacyAsset = (await client.query<{
      assetId: number;
      userId: number;
      projectCount: string;
    }>(`
      SELECT asset.id AS "assetId", asset.user_id AS "userId",
             COUNT(DISTINCT node.project_id)::text AS "projectCount"
      FROM write_canvas_assets asset
      JOIN write_canvas_nodes node
        ON node.asset_id = asset.id AND node.user_id = asset.user_id
      WHERE asset.project_id IS NULL
      GROUP BY asset.id, asset.user_id
      HAVING COUNT(DISTINCT node.project_id) > 1
      LIMIT 1
    `)).rows[0];
    if (ambiguousLegacyAsset) {
      throw new Error(
        `Legacy canvas asset references multiple projects and requires an explicit backed-up maintenance migration before deployment (asset ${ambiguousLegacyAsset.assetId}, user ${ambiguousLegacyAsset.userId}, projects ${ambiguousLegacyAsset.projectCount})`,
      );
    }
    await client.query(`
      UPDATE write_canvas_assets asset
      SET project_id = node.project_id
      FROM write_canvas_nodes node
      WHERE node.asset_id = asset.id
        AND node.user_id = asset.user_id
        AND asset.project_id IS NULL
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_write_canvas_assets_tenant_project_key ON write_canvas_assets(id, user_id, project_id)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_write_agent_templates_tenant_key ON write_agent_templates(id, user_id)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_write_agent_instances_tenant_project_key ON write_agent_instances(id, user_id, project_id)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_write_agent_instances_tenant_key ON write_agent_instances(id, user_id)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_write_canvas_documents_tenant_project_key ON write_canvas_documents(id, user_id, project_id)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_write_canvas_documents_tenant_key ON write_canvas_documents(id, user_id)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_write_canvas_document_versions_tenant_document_key ON write_canvas_document_versions(id, user_id, document_id)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_write_canvas_agent_groups_tenant_project_key ON write_canvas_agent_groups(id, user_id, project_id)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_write_canvas_agent_group_members_tenant_group_key ON write_canvas_agent_group_members(id, user_id, project_id, group_id)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_write_canvas_agent_batches_tenant_group_key ON write_canvas_agent_batches(id, user_id, project_id, group_id)`);

    await client.query(`
      DO $$ DECLARE constraint_definition TEXT; BEGIN
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'write_canvas_agent_runs'::regclass AND conname = 'write_canvas_agent_runs_project_id_fkey') THEN
          ALTER TABLE write_canvas_agent_runs DROP CONSTRAINT write_canvas_agent_runs_project_id_fkey;
        END IF;
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'write_canvas_agent_runs'::regclass AND conname = 'write_canvas_agent_runs_group_id_fkey') THEN
          ALTER TABLE write_canvas_agent_runs DROP CONSTRAINT write_canvas_agent_runs_group_id_fkey;
        END IF;
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'write_canvas_agent_runs'::regclass AND conname = 'write_canvas_agent_runs_group_member_id_fkey') THEN
          ALTER TABLE write_canvas_agent_runs DROP CONSTRAINT write_canvas_agent_runs_group_member_id_fkey;
        END IF;
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'write_canvas_agent_runs'::regclass AND conname = 'write_canvas_agent_runs_batch_id_fkey') THEN
          ALTER TABLE write_canvas_agent_runs DROP CONSTRAINT write_canvas_agent_runs_batch_id_fkey;
        END IF;
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'write_canvas_agent_runs'::regclass AND conname = 'write_canvas_agent_runs_source_node_id_fkey') THEN
          ALTER TABLE write_canvas_agent_runs DROP CONSTRAINT write_canvas_agent_runs_source_node_id_fkey;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'write_canvas_projects'::regclass AND conname = 'write_canvas_projects_tenant_key') THEN
          ALTER TABLE write_canvas_projects ADD CONSTRAINT write_canvas_projects_tenant_key UNIQUE (id, user_id);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'write_canvas_nodes'::regclass AND conname = 'write_canvas_nodes_tenant_project_key') THEN
          ALTER TABLE write_canvas_nodes ADD CONSTRAINT write_canvas_nodes_tenant_project_key UNIQUE (id, user_id, project_id);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'write_canvas_agent_groups'::regclass AND conname = 'write_canvas_agent_groups_tenant_project_key') THEN
          ALTER TABLE write_canvas_agent_groups ADD CONSTRAINT write_canvas_agent_groups_tenant_project_key UNIQUE (id, user_id, project_id);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'write_canvas_agent_group_members'::regclass AND conname = 'write_canvas_agent_group_members_tenant_group_key') THEN
          ALTER TABLE write_canvas_agent_group_members ADD CONSTRAINT write_canvas_agent_group_members_tenant_group_key UNIQUE (id, user_id, project_id, group_id);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'write_canvas_agent_batches'::regclass AND conname = 'write_canvas_agent_batches_tenant_group_key') THEN
          ALTER TABLE write_canvas_agent_batches ADD CONSTRAINT write_canvas_agent_batches_tenant_group_key UNIQUE (id, user_id, project_id, group_id);
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'write_canvas_agent_groups'::regclass AND conname = 'write_canvas_agent_groups_project_owner_fkey') THEN
          ALTER TABLE write_canvas_agent_groups ADD CONSTRAINT write_canvas_agent_groups_project_owner_fkey
            FOREIGN KEY (project_id, user_id) REFERENCES write_canvas_projects(id, user_id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'write_canvas_agent_group_members'::regclass AND conname = 'write_canvas_agent_group_members_group_owner_fkey') THEN
          ALTER TABLE write_canvas_agent_group_members ADD CONSTRAINT write_canvas_agent_group_members_group_owner_fkey
            FOREIGN KEY (group_id, user_id, project_id) REFERENCES write_canvas_agent_groups(id, user_id, project_id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'write_canvas_agent_batches'::regclass AND conname = 'write_canvas_agent_batches_group_owner_fkey') THEN
          ALTER TABLE write_canvas_agent_batches ADD CONSTRAINT write_canvas_agent_batches_group_owner_fkey
            FOREIGN KEY (group_id, user_id, project_id) REFERENCES write_canvas_agent_groups(id, user_id, project_id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'write_canvas_agent_groups'::regclass AND conname = 'write_canvas_agent_groups_current_batch_owner_fkey') THEN
          ALTER TABLE write_canvas_agent_groups ADD CONSTRAINT write_canvas_agent_groups_current_batch_owner_fkey
            FOREIGN KEY (current_batch_id, user_id, project_id, id)
            REFERENCES write_canvas_agent_batches(id, user_id, project_id, group_id)
            ON DELETE SET NULL (current_batch_id);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'write_canvas_agent_groups'::regclass AND conname = 'write_canvas_agent_groups_node_owner_fkey') THEN
          ALTER TABLE write_canvas_agent_groups ADD CONSTRAINT write_canvas_agent_groups_node_owner_fkey
            FOREIGN KEY (node_id, user_id, project_id) REFERENCES write_canvas_nodes(id, user_id, project_id) ON DELETE CASCADE;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'write_canvas_agent_runs'::regclass AND conname = 'write_canvas_agent_runs_group_owner_fkey') THEN
          ALTER TABLE write_canvas_agent_runs ADD CONSTRAINT write_canvas_agent_runs_group_owner_fkey
            FOREIGN KEY (group_id, user_id, project_id) REFERENCES write_canvas_agent_groups(id, user_id, project_id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'write_canvas_agent_runs'::regclass AND conname = 'write_canvas_agent_runs_project_owner_fkey') THEN
          ALTER TABLE write_canvas_agent_runs ADD CONSTRAINT write_canvas_agent_runs_project_owner_fkey
            FOREIGN KEY (project_id, user_id) REFERENCES write_canvas_projects(id, user_id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'write_canvas_agent_runs'::regclass AND conname = 'write_canvas_agent_runs_group_member_owner_fkey') THEN
          ALTER TABLE write_canvas_agent_runs ADD CONSTRAINT write_canvas_agent_runs_group_member_owner_fkey
            FOREIGN KEY (group_member_id, user_id, project_id, group_id)
            REFERENCES write_canvas_agent_group_members(id, user_id, project_id, group_id)
            ON DELETE SET NULL (group_member_id);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'write_canvas_agent_runs'::regclass AND conname = 'write_canvas_agent_runs_batch_owner_fkey') THEN
          ALTER TABLE write_canvas_agent_runs ADD CONSTRAINT write_canvas_agent_runs_batch_owner_fkey
            FOREIGN KEY (batch_id, user_id, project_id, group_id)
            REFERENCES write_canvas_agent_batches(id, user_id, project_id, group_id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'write_canvas_agent_runs'::regclass AND conname = 'write_canvas_agent_runs_source_owner_fkey') THEN
          ALTER TABLE write_canvas_agent_runs ADD CONSTRAINT write_canvas_agent_runs_source_owner_fkey
            FOREIGN KEY (source_node_id, user_id, project_id)
            REFERENCES write_canvas_nodes(id, user_id, project_id) ON DELETE SET NULL (source_node_id);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'write_canvas_agent_runs'::regclass AND conname = 'write_canvas_agent_runs_group_fields_check') THEN
          ALTER TABLE write_canvas_agent_runs ADD CONSTRAINT write_canvas_agent_runs_group_fields_check
            CHECK (
              (group_id IS NULL AND group_member_id IS NULL AND batch_id IS NULL)
              OR (group_id IS NOT NULL AND batch_id IS NOT NULL)
            );
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'write_canvas_assets'::regclass AND conname = 'write_canvas_assets_project_owner_fkey') THEN
          ALTER TABLE write_canvas_assets ADD CONSTRAINT write_canvas_assets_project_owner_fkey
            FOREIGN KEY (project_id, user_id) REFERENCES write_canvas_projects(id, user_id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'write_agent_instances'::regclass AND conname = 'write_agent_instances_project_owner_fkey') THEN
          ALTER TABLE write_agent_instances ADD CONSTRAINT write_agent_instances_project_owner_fkey
            FOREIGN KEY (project_id, user_id) REFERENCES write_canvas_projects(id, user_id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'write_agent_instances'::regclass AND conname = 'write_agent_instances_template_owner_fkey') THEN
          ALTER TABLE write_agent_instances ADD CONSTRAINT write_agent_instances_template_owner_fkey
            FOREIGN KEY (template_id, user_id) REFERENCES write_agent_templates(id, user_id) ON DELETE SET NULL (template_id);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'write_canvas_nodes'::regclass AND conname = 'write_canvas_nodes_project_owner_fkey') THEN
          ALTER TABLE write_canvas_nodes ADD CONSTRAINT write_canvas_nodes_project_owner_fkey
            FOREIGN KEY (project_id, user_id) REFERENCES write_canvas_projects(id, user_id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'write_canvas_nodes'::regclass AND conname = 'write_canvas_nodes_asset_owner_fkey') THEN
          ALTER TABLE write_canvas_nodes ADD CONSTRAINT write_canvas_nodes_asset_owner_fkey
            FOREIGN KEY (asset_id, user_id, project_id) REFERENCES write_canvas_assets(id, user_id, project_id) ON DELETE SET NULL (asset_id);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'write_canvas_nodes'::regclass AND conname = 'write_canvas_nodes_agent_owner_fkey') THEN
          ALTER TABLE write_canvas_nodes ADD CONSTRAINT write_canvas_nodes_agent_owner_fkey
            FOREIGN KEY (agent_id, user_id, project_id) REFERENCES write_agent_instances(id, user_id, project_id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'write_canvas_edges'::regclass AND conname = 'write_canvas_edges_project_owner_fkey') THEN
          ALTER TABLE write_canvas_edges ADD CONSTRAINT write_canvas_edges_project_owner_fkey
            FOREIGN KEY (project_id, user_id) REFERENCES write_canvas_projects(id, user_id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'write_canvas_edges'::regclass AND conname = 'write_canvas_edges_source_owner_fkey') THEN
          ALTER TABLE write_canvas_edges ADD CONSTRAINT write_canvas_edges_source_owner_fkey
            FOREIGN KEY (source_node_id, user_id, project_id) REFERENCES write_canvas_nodes(id, user_id, project_id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'write_canvas_edges'::regclass AND conname = 'write_canvas_edges_target_owner_fkey') THEN
          ALTER TABLE write_canvas_edges ADD CONSTRAINT write_canvas_edges_target_owner_fkey
            FOREIGN KEY (target_node_id, user_id, project_id) REFERENCES write_canvas_nodes(id, user_id, project_id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'write_canvas_agent_messages'::regclass AND conname = 'write_canvas_agent_messages_agent_owner_fkey') THEN
          ALTER TABLE write_canvas_agent_messages ADD CONSTRAINT write_canvas_agent_messages_agent_owner_fkey
            FOREIGN KEY (agent_id, user_id) REFERENCES write_agent_instances(id, user_id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'write_canvas_documents'::regclass AND conname = 'write_canvas_documents_project_owner_fkey') THEN
          ALTER TABLE write_canvas_documents ADD CONSTRAINT write_canvas_documents_project_owner_fkey
            FOREIGN KEY (project_id, user_id) REFERENCES write_canvas_projects(id, user_id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'write_canvas_documents'::regclass AND conname = 'write_canvas_documents_node_owner_fkey') THEN
          ALTER TABLE write_canvas_documents ADD CONSTRAINT write_canvas_documents_node_owner_fkey
            FOREIGN KEY (node_id, user_id, project_id) REFERENCES write_canvas_nodes(id, user_id, project_id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'write_canvas_nodes'::regclass AND conname = 'write_canvas_nodes_document_owner_fkey') THEN
          ALTER TABLE write_canvas_nodes ADD CONSTRAINT write_canvas_nodes_document_owner_fkey
            FOREIGN KEY (document_id, user_id, project_id) REFERENCES write_canvas_documents(id, user_id, project_id) ON DELETE SET NULL (document_id);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'write_canvas_document_versions'::regclass AND conname = 'write_canvas_document_versions_document_owner_fkey') THEN
          ALTER TABLE write_canvas_document_versions ADD CONSTRAINT write_canvas_document_versions_document_owner_fkey
            FOREIGN KEY (document_id, user_id) REFERENCES write_canvas_documents(id, user_id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'write_canvas_document_sections'::regclass AND conname = 'write_canvas_document_sections_document_owner_fkey') THEN
          ALTER TABLE write_canvas_document_sections ADD CONSTRAINT write_canvas_document_sections_document_owner_fkey
            FOREIGN KEY (document_id, user_id) REFERENCES write_canvas_documents(id, user_id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'write_canvas_documents'::regclass AND conname = 'write_canvas_documents_current_version_owner_fkey') THEN
          ALTER TABLE write_canvas_documents ADD CONSTRAINT write_canvas_documents_current_version_owner_fkey
            FOREIGN KEY (current_version_id, user_id, id)
            REFERENCES write_canvas_document_versions(id, user_id, document_id)
            ON DELETE SET NULL (current_version_id);
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'write_canvas_nodes'::regclass AND conname = 'write_canvas_nodes_role_check') THEN
          ALTER TABLE write_canvas_nodes ADD CONSTRAINT write_canvas_nodes_role_check
            CHECK (node_role IN ('material','insight','task','document','group'));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'write_canvas_nodes'::regclass AND conname = 'write_canvas_nodes_origin_check') THEN
          ALTER TABLE write_canvas_nodes ADD CONSTRAINT write_canvas_nodes_origin_check
            CHECK (origin IN ('existing','extracted','manual','generated'));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'write_canvas_nodes'::regclass AND conname = 'write_canvas_nodes_status_check') THEN
          ALTER TABLE write_canvas_nodes ADD CONSTRAINT write_canvas_nodes_status_check
            CHECK (status IN ('parsing','ready','running','pending_review','adopted','rejected','editing','completed','failed'));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'write_canvas_nodes'::regclass AND conname = 'write_canvas_nodes_document_id_fkey') THEN
          ALTER TABLE write_canvas_nodes ADD CONSTRAINT write_canvas_nodes_document_id_fkey
            FOREIGN KEY (document_id) REFERENCES write_canvas_documents(id) ON DELETE SET NULL;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'write_canvas_documents'::regclass AND conname = 'write_canvas_documents_node_id_fkey') THEN
          ALTER TABLE write_canvas_documents ADD CONSTRAINT write_canvas_documents_node_id_fkey
            FOREIGN KEY (node_id) REFERENCES write_canvas_nodes(id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'write_canvas_documents'::regclass AND conname = 'write_canvas_documents_current_version_id_fkey') THEN
          ALTER TABLE write_canvas_documents ADD CONSTRAINT write_canvas_documents_current_version_id_fkey
            FOREIGN KEY (current_version_id) REFERENCES write_canvas_document_versions(id) ON DELETE SET NULL;
        END IF;

        SELECT pg_get_constraintdef(oid) INTO constraint_definition
        FROM pg_constraint
        WHERE conrelid = 'write_canvas_edges'::regclass
          AND conname = 'write_canvas_edges_relation_check';
        IF constraint_definition IS NULL THEN
          ALTER TABLE write_canvas_edges ADD CONSTRAINT write_canvas_edges_relation_check
            CHECK (relation IN ('context','derived_from','generated','structure'));
        ELSIF POSITION('derived_from' IN constraint_definition) = 0
           OR POSITION('generated' IN constraint_definition) = 0
           OR POSITION('structure' IN constraint_definition) = 0 THEN
          ALTER TABLE write_canvas_edges DROP CONSTRAINT write_canvas_edges_relation_check;
          ALTER TABLE write_canvas_edges ADD CONSTRAINT write_canvas_edges_relation_check
            CHECK (relation IN ('context','derived_from','generated','structure'));
        END IF;
      END $$
    `);
    await client.query(`
      DELETE FROM write_canvas_edges edge
      USING write_canvas_nodes target_node
      WHERE edge.relation = 'derived_from'
        AND target_node.id = edge.target_node_id
        AND target_node.node_role = 'task'
        AND target_node.content_type = 'agent_group'
        AND EXISTS (
          SELECT 1 FROM write_canvas_edges duplicate
          WHERE duplicate.project_id = edge.project_id
            AND duplicate.source_node_id = edge.source_node_id
            AND duplicate.target_node_id = edge.target_node_id
            AND duplicate.relation = 'context'
        )
    `);
    await client.query(`
      UPDATE write_canvas_edges edge
      SET relation = 'context'
      FROM write_canvas_nodes source_node, write_canvas_nodes target_node
      WHERE edge.relation = 'derived_from'
        AND source_node.id = edge.source_node_id
        AND target_node.id = edge.target_node_id
        AND target_node.node_role = 'task'
        AND target_node.content_type = 'agent_group'
        AND source_node.kind <> 'agent'
        AND NOT (source_node.node_role = 'task' AND source_node.content_type = 'agent_group')
        AND NOT EXISTS (
          SELECT 1 FROM write_canvas_edges duplicate
          WHERE duplicate.project_id = edge.project_id
            AND duplicate.source_node_id = edge.source_node_id
            AND duplicate.target_node_id = edge.target_node_id
            AND duplicate.relation = 'context'
        )
    `);
    await client.query(`
      DELETE FROM write_canvas_edges edge
      USING write_canvas_nodes source_node, write_canvas_nodes target_node
      WHERE edge.relation = 'context'
        AND source_node.id = edge.source_node_id
        AND target_node.id = edge.target_node_id
        AND (
          source_node.kind = 'agent'
          OR (source_node.node_role = 'task' AND source_node.content_type = 'agent_group')
          OR (target_node.kind <> 'agent' AND NOT (target_node.node_role = 'task' AND target_node.content_type = 'agent_group'))
        )
        AND EXISTS (
          SELECT 1 FROM write_canvas_edges duplicate
          WHERE duplicate.project_id = edge.project_id
            AND duplicate.source_node_id = edge.source_node_id
            AND duplicate.target_node_id = edge.target_node_id
            AND duplicate.relation = 'derived_from'
        )
    `);
    await client.query(`
      UPDATE write_canvas_edges edge
      SET relation = 'derived_from'
      FROM write_canvas_nodes source_node, write_canvas_nodes target_node
      WHERE edge.relation = 'context'
        AND source_node.id = edge.source_node_id
        AND target_node.id = edge.target_node_id
        AND (
          source_node.kind = 'agent'
          OR (source_node.node_role = 'task' AND source_node.content_type = 'agent_group')
          OR (target_node.kind <> 'agent' AND NOT (target_node.node_role = 'task' AND target_node.content_type = 'agent_group'))
        )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_write_canvas_nodes_document ON write_canvas_nodes(document_id) WHERE document_id IS NOT NULL`);
  });
  await runSchemaMigrationOnce("20260813_creative_canvas_compatibility_v3", async client => {
    // Re-run the compatible backfill under a new marker because an older
    // instance may have inserted a partially populated row after v2 completed.
    await client.query(`
      UPDATE write_canvas_nodes
      SET node_role = COALESCE(node_role, CASE kind
            WHEN 'asset_text' THEN 'material'
            WHEN 'asset_file' THEN 'material'
            WHEN 'asset_image' THEN 'material'
            WHEN 'saved_article' THEN 'material'
            WHEN 'atom_card' THEN 'material'
            WHEN 'agent' THEN 'task'
            WHEN 'result' THEN 'document'
            ELSE 'insight'
          END),
          content_type = COALESCE(content_type, CASE kind
            WHEN 'asset_text' THEN 'text'
            WHEN 'asset_file' THEN 'file'
            WHEN 'asset_image' THEN 'image'
            WHEN 'saved_article' THEN 'article'
            WHEN 'atom_card' THEN 'atom_card'
            WHEN 'agent' THEN 'agent'
            WHEN 'result' THEN 'result'
            ELSE 'note'
          END),
          origin = COALESCE(origin, CASE
            WHEN kind IN ('asset_text','asset_file','asset_image','saved_article','atom_card') THEN 'existing'
            WHEN kind = 'result' THEN 'generated'
            ELSE 'manual'
          END),
          status = COALESCE(status, CASE WHEN kind = 'result' THEN 'pending_review' ELSE 'ready' END)
      WHERE node_role IS NULL OR content_type IS NULL OR origin IS NULL OR status IS NULL
    `);
    const ambiguousLegacyAsset = (await client.query<{
      assetId: number;
      userId: number;
      projectCount: string;
    }>(`
      SELECT asset.id AS "assetId", asset.user_id AS "userId",
             COUNT(DISTINCT node.project_id)::text AS "projectCount"
      FROM write_canvas_assets asset
      JOIN write_canvas_nodes node
        ON node.asset_id = asset.id AND node.user_id = asset.user_id
      WHERE asset.project_id IS NULL
      GROUP BY asset.id, asset.user_id
      HAVING COUNT(DISTINCT node.project_id) > 1
      LIMIT 1
    `)).rows[0];
    if (ambiguousLegacyAsset) {
      throw new Error(
        `Legacy canvas asset references multiple projects and requires an explicit backed-up maintenance migration before deployment (asset ${ambiguousLegacyAsset.assetId}, user ${ambiguousLegacyAsset.userId}, projects ${ambiguousLegacyAsset.projectCount})`,
      );
    }
    await client.query(`
      UPDATE write_canvas_assets asset
      SET project_id = node.project_id
      FROM write_canvas_nodes node
      WHERE node.asset_id = asset.id
        AND node.user_id = asset.user_id
        AND asset.project_id IS NULL
    `);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'write_canvas_nodes'::regclass
            AND conname = 'write_canvas_nodes_asset_owner_fkey'
        ) THEN
          ALTER TABLE write_canvas_nodes ADD CONSTRAINT write_canvas_nodes_asset_owner_fkey
            FOREIGN KEY (asset_id, user_id, project_id)
            REFERENCES write_canvas_assets(id, user_id, project_id)
            ON DELETE SET NULL (asset_id);
        END IF;
      END $$
    `);
  });

  // --- saved_cards: add origin and saved_article_id columns ---
  await pool.query(`ALTER TABLE saved_cards ADD COLUMN IF NOT EXISTS origin TEXT DEFAULT 'manual'`);
  await pool.query(`ALTER TABLE saved_cards ADD COLUMN IF NOT EXISTS saved_article_id BIGINT REFERENCES saved_articles(id) ON DELETE SET NULL`);
  await pool.query(`ALTER TABLE saved_cards ADD COLUMN IF NOT EXISTS summary TEXT`);
  await pool.query(`ALTER TABLE saved_cards ADD COLUMN IF NOT EXISTS original_quote TEXT`);
  await pool.query(`ALTER TABLE saved_cards ADD COLUMN IF NOT EXISTS context TEXT`);
  await pool.query(`ALTER TABLE saved_cards ADD COLUMN IF NOT EXISTS citation_note TEXT`);
  await pool.query(`ALTER TABLE saved_cards ADD COLUMN IF NOT EXISTS evidence_role TEXT`);
  await pool.query(`ALTER TABLE saved_cards ADD COLUMN IF NOT EXISTS raw_card_meta JSONB NOT NULL DEFAULT '{}'::jsonb`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_saved_cards_saved_article ON saved_cards(saved_article_id)`);
  await runSchemaMigrationOnce("20260813_saved_articles_normalized_url_v1", async client => {
    await client.query(`LOCK TABLE saved_articles IN SHARE ROW EXCLUSIVE MODE`);
    const rows = (await client.query(
      `SELECT id, url FROM saved_articles WHERE url IS NOT NULL AND normalized_url IS NULL`,
    )).rows as Array<{ id: number; url: string }>;
    const normalizedRows = rows
      .map(row => ({ id: row.id, normalizedUrl: normalizeArticleUrl(row.url) }))
      .filter((row): row is { id: number; normalizedUrl: string } => Boolean(row.normalizedUrl));
    for (let offset = 0; offset < normalizedRows.length; offset += 500) {
      const batch = normalizedRows.slice(offset, offset + 500);
      await client.query(
        `UPDATE saved_articles article
         SET normalized_url = normalized.normalized_url
         FROM UNNEST($1::bigint[], $2::text[]) AS normalized(id, normalized_url)
         WHERE article.id = normalized.id`,
        [batch.map(row => row.id), batch.map(row => row.normalizedUrl)],
      );
    }
    const duplicateNormalizedUrl = (await client.query<{ userId: number; normalizedUrl: string; count: string }>(`
      SELECT user_id AS "userId", normalized_url AS "normalizedUrl", COUNT(*)::text AS count
      FROM saved_articles
      WHERE normalized_url IS NOT NULL
      GROUP BY user_id, normalized_url
      HAVING COUNT(*) > 1
      LIMIT 1
    `)).rows[0];
    if (duplicateNormalizedUrl) {
      throw new Error(
        `Normalized saved-article URL duplicates require an explicit backed-up maintenance migration before deployment (user ${duplicateNormalizedUrl.userId}, count ${duplicateNormalizedUrl.count})`,
      );
    }
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_articles_normalized_url_unique ON saved_articles(user_id, normalized_url) WHERE normalized_url IS NOT NULL`);
    await client.query(`ALTER TABLE saved_articles DROP CONSTRAINT IF EXISTS saved_articles_normalized_url_required`);
    await client.query(`ALTER TABLE saved_articles ADD CONSTRAINT saved_articles_normalized_url_required CHECK (url IS NULL OR normalized_url IS NOT NULL)`);
  });
  await runSchemaMigrationOnce("20260813_saved_articles_normalized_url_v2", async client => {
    await client.query(`LOCK TABLE saved_articles IN SHARE ROW EXCLUSIVE MODE`);
    const rows = (await client.query(
      `SELECT id, url, normalized_url AS "normalizedUrl"
       FROM saved_articles
       WHERE url IS NOT NULL`,
    )).rows as Array<{ id: number; url: string; normalizedUrl: string | null }>;
    const invalidRow = rows.find(row => !normalizeArticleUrl(row.url));
    if (invalidRow) {
      throw new Error(
        `Saved article URL cannot be normalized and requires an explicit backed-up maintenance migration before deployment (article ${invalidRow.id})`,
      );
    }
    const changedRows = rows.flatMap(row => {
      const normalizedUrl = normalizeArticleUrl(row.url);
      return normalizedUrl && normalizedUrl !== row.normalizedUrl
        ? [{ id: row.id, normalizedUrl }]
        : [];
    });
    for (let offset = 0; offset < changedRows.length; offset += 500) {
      const batch = changedRows.slice(offset, offset + 500);
      await client.query(
        `UPDATE saved_articles article
         SET normalized_url = normalized.normalized_url
         FROM UNNEST($1::bigint[], $2::text[]) AS normalized(id, normalized_url)
         WHERE article.id = normalized.id`,
        [batch.map(row => row.id), batch.map(row => row.normalizedUrl)],
      );
    }
    await client.query(`UPDATE saved_articles SET normalized_url = NULL WHERE url IS NULL AND normalized_url IS NOT NULL`);

    const duplicateNormalizedUrl = (await client.query<{ userId: number; normalizedUrl: string; count: string }>(`
      SELECT user_id AS "userId", normalized_url AS "normalizedUrl", COUNT(*)::text AS count
      FROM saved_articles
      WHERE normalized_url IS NOT NULL
      GROUP BY user_id, normalized_url
      HAVING COUNT(*) > 1
      LIMIT 1
    `)).rows[0];
    if (duplicateNormalizedUrl) {
      throw new Error(
        `Normalized saved-article URL duplicates require an explicit backed-up maintenance migration before deployment (user ${duplicateNormalizedUrl.userId}, count ${duplicateNormalizedUrl.count})`,
      );
    }

    type NormalizedUrlIndex = {
      indexOid: string;
      isUnique: boolean;
      isValid: boolean;
      isReady: boolean;
      columns: string[];
      predicate: string | null;
      constraintName: string | null;
    };
    const readNormalizedUrlIndex = async () => (await client.query<NormalizedUrlIndex>(`
      SELECT index_class.oid::text AS "indexOid",
             index_meta.indisunique AS "isUnique",
             index_meta.indisvalid AS "isValid",
             index_meta.indisready AS "isReady",
             ARRAY(
               SELECT attribute.attname
               FROM unnest(index_meta.indkey) WITH ORDINALITY AS key(attnum, position)
               JOIN pg_attribute attribute
                 ON attribute.attrelid = index_meta.indrelid AND attribute.attnum = key.attnum
               ORDER BY key.position
             )::text[] AS columns,
             pg_get_expr(index_meta.indpred, index_meta.indrelid) AS predicate,
             constraint_meta.conname AS "constraintName"
      FROM pg_class index_class
      JOIN pg_index index_meta ON index_meta.indexrelid = index_class.oid
      LEFT JOIN pg_constraint constraint_meta ON constraint_meta.conindid = index_class.oid
      WHERE index_class.relname = 'idx_saved_articles_normalized_url_unique'
        AND pg_table_is_visible(index_class.oid)
    `)).rows[0];
    const hasExpectedNormalizedUrlIndexDefinition = (index: NormalizedUrlIndex | undefined) => {
      const normalizedPredicate = (index?.predicate || "").replace(/[()\s"]/g, "").toLowerCase();
      return Boolean(index)
        && index!.isUnique
        && index!.isValid
        && index!.isReady
        && index!.columns.length === 2
        && index!.columns[0] === "user_id"
        && index!.columns[1] === "normalized_url"
        && normalizedPredicate === "normalized_urlisnotnull";
    };
    const existingIndex = await readNormalizedUrlIndex();
    if (existingIndex && !hasExpectedNormalizedUrlIndexDefinition(existingIndex)) {
      if (existingIndex.constraintName) {
        throw new Error(
          `idx_saved_articles_normalized_url_unique backs unexpected constraint ${existingIndex.constraintName}; resolve it in a maintenance window`,
        );
      }
      await client.query(`DROP INDEX idx_saved_articles_normalized_url_unique`);
    }
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_articles_normalized_url_unique
      ON saved_articles(user_id, normalized_url)
      WHERE normalized_url IS NOT NULL
    `);
    const verifiedIndex = await readNormalizedUrlIndex();
    if (!hasExpectedNormalizedUrlIndexDefinition(verifiedIndex)) {
      throw new Error("idx_saved_articles_normalized_url_unique is invalid or has an unexpected definition; resolve it in a maintenance window");
    }
    await client.query(`ALTER TABLE saved_articles DROP CONSTRAINT IF EXISTS saved_articles_normalized_url_required`);
    await client.query(`
      ALTER TABLE saved_articles
      ADD CONSTRAINT saved_articles_normalized_url_required
      CHECK (url IS NULL OR normalized_url IS NOT NULL) NOT VALID
    `);
    await client.query(`ALTER TABLE saved_articles VALIDATE CONSTRAINT saved_articles_normalized_url_required`);
  });
  await runSchemaMigrationOnce("20260811_saved_articles_content_hash_unique_v2", async client => {
    const namedIndex = (await client.query<{
      isUnique: boolean;
      isValid: boolean;
      isReady: boolean;
      definition: string;
    }>(
      `SELECT i.indisunique AS "isUnique",
              i.indisvalid AS "isValid",
              i.indisready AS "isReady",
              pg_get_indexdef(i.indexrelid) AS definition
       FROM pg_class c
       JOIN pg_index i ON i.indexrelid = c.oid
       WHERE c.relname = 'idx_saved_articles_content_hash_unique_v2'
         AND pg_table_is_visible(c.oid)`,
    )).rows[0];
    const namedIndexHasExpectedDefinition = namedIndex
      ? namedIndex.isUnique
        && namedIndex.isValid
        && namedIndex.isReady
        && /\(user_id, content_hash\)/i.test(namedIndex.definition)
        && /WHERE \(content_hash IS NOT NULL\)/i.test(namedIndex.definition)
      : false;
    if (namedIndex && !namedIndexHasExpectedDefinition) {
      throw new Error("idx_saved_articles_content_hash_unique_v2 is invalid or has an unexpected definition; resolve it in a maintenance window");
    }

    const duplicateGroup = (await client.query<{ userId: number; contentHash: string; count: string }>(
      `SELECT user_id AS "userId", content_hash AS "contentHash", COUNT(*)::text AS count
       FROM saved_articles
       WHERE content_hash IS NOT NULL
       GROUP BY user_id, content_hash
       HAVING COUNT(*) > 1
       LIMIT 1`,
    )).rows[0];
    if (duplicateGroup) {
      throw new Error(
        `Saved article duplicates require an explicit backed-up maintenance migration before deployment (user ${duplicateGroup.userId}, count ${duplicateGroup.count})`,
      );
    }

    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_articles_content_hash_unique_v2
       ON saved_articles(user_id, content_hash)
       WHERE content_hash IS NOT NULL`,
    );
  });

  // --- card_relations: knowledge graph (reserved for future use) ---
  await pool.query(`
    CREATE TABLE IF NOT EXISTS card_relations (
      id              SERIAL PRIMARY KEY,
      card_a          TEXT NOT NULL REFERENCES saved_cards(id) ON DELETE CASCADE,
      card_b          TEXT NOT NULL REFERENCES saved_cards(id) ON DELETE CASCADE,
      relation_type   TEXT NOT NULL CHECK (relation_type IN ('supports','conflicts','extends')),
      confidence      REAL DEFAULT 0.5,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (card_a, card_b, relation_type)
    )
  `);
  logMigrationPhase(logger, "application-schema", applicationSchemaStartedAt);

  // --- pgvector: optional semantic search extension ---
  const vectorStartedAt = Date.now();
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    await pool.query('ALTER TABLE saved_cards ADD COLUMN IF NOT EXISTS embedding vector(1536)');
    logger.info({ module: "db" }, "pgvector extension enabled");
  } catch {
    logger.info({ module: "db" }, "pgvector not available, semantic search disabled");
  }
  logMigrationPhase(logger, "optional-pgvector", vectorStartedAt);

  const billingStartedAt = Date.now();
  await runSchemaMigrationOnce("20260811_billing_schema_v1", async client => {
    await ensureBillingSchema(client);
  });
  await runSchemaMigrationOnce("20260816_alipay_subscription_v1", async client => {
    await ensureAlipayBillingSchema(client);
  });
  logMigrationPhase(logger, "billing-schema", billingStartedAt);

  // Backfill: set default nickname for existing users who don't have one
  const backfillStartedAt = Date.now();
  await pool.query("UPDATE users SET nickname = split_part(email, '@', 1) WHERE nickname IS NULL");
  await pool.query(
    `INSERT INTO atomflow_schema_migrations (id)
     VALUES ($1)
     ON CONFLICT (id) DO UPDATE SET applied_at = NOW()`,
    [DATABASE_SCHEMA_VERSION],
  );
  logMigrationPhase(logger, "compatible-backfills-and-version", backfillStartedAt);
  } finally {
    try {
      const unlocked = (await schemaLockClient.query(
        `SELECT pg_advisory_unlock(hashtext('atomflow-schema-migration')) AS unlocked`,
      )).rows[0]?.unlocked === true;
      schemaLockReleased = unlocked;
    } catch (error) {
      logger.error({ err: error, module: "db" }, "Failed to release schema migration lock");
    }
  }
  } catch (err) {
    logger.error({ err, module: "db" }, "Database schema migration failed");
    throw err;
  } finally {
    schemaLockClient.release(schemaLockReleased ? undefined : true);
  }
  logger.info({ module: "db", schemaVersion: DATABASE_SCHEMA_VERSION, durationMs: Date.now() - migrationStartedAt }, "Database migrations completed");
};

export const verifyDatabaseSchema = async (pool: pg.Pool) => {
  const registry = await pool.query<{ registry: string | null }>(
    `SELECT to_regclass('public.atomflow_schema_migrations')::text AS registry`,
  );
  if (!registry.rows[0]?.registry) return false;
  const result = await pool.query<{ ready: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM atomflow_schema_migrations WHERE id = $1
     )
     AND to_regclass('public.users') IS NOT NULL
     AND to_regclass('public.session') IS NOT NULL
     AND to_regclass('public.saved_articles') IS NOT NULL
     AS ready`,
    [DATABASE_SCHEMA_VERSION],
  );
  return result.rows[0]?.ready === true;
};
