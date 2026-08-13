import pg from "pg";
import type { Logger } from "pino";
import { ensureBillingSchema } from "./billing/schema.js";

export const DATABASE_SCHEMA_VERSION = "20260811_predeploy_schema_v1";
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
