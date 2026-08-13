import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import pino from "pino";
import {
  DATABASE_SCHEMA_VERSION,
  runDatabaseMigrations,
  verifyDatabaseSchema,
} from "../src/server/databaseMigrations.js";

const enabled = process.env.RUN_REAL_MIGRATION_TESTS === "true";

test("database migrations run twice against an isolated PostgreSQL database", {
  skip: enabled ? false : "set RUN_REAL_MIGRATION_TESTS=true with an isolated local database",
  timeout: 120_000,
}, async () => {
  const rawUrl = process.env.DATABASE_URL;
  assert.ok(rawUrl, "DATABASE_URL is required");
  const parsed = new URL(rawUrl);
  assert.ok(["", "localhost", "127.0.0.1", "::1"].includes(parsed.hostname), "migration integration tests only allow local PostgreSQL");
  assert.match(parsed.pathname, /^\/atomflow_migration_test/, "migration integration database name must be isolated");

  const pool = new pg.Pool({ connectionString: rawUrl, max: 4 });
  const logger = pino({ level: "silent" });
  try {
    await runDatabaseMigrations(pool, logger);
    await runDatabaseMigrations(pool, logger);
    assert.equal(await verifyDatabaseSchema(pool), true);
    const marker = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM atomflow_schema_migrations WHERE id = $1",
      [DATABASE_SCHEMA_VERSION],
    );
    assert.equal(marker.rows[0]?.count, "1");

    await pool.query("DELETE FROM atomflow_schema_migrations WHERE id = $1", [DATABASE_SCHEMA_VERSION]);
    assert.equal(await verifyDatabaseSchema(pool), false, "health verification must require the final release marker");
    await pool.query(
      "INSERT INTO atomflow_schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING",
      [DATABASE_SCHEMA_VERSION],
    );

    const normalizedUser = (await pool.query<{ id: number }>(
      `INSERT INTO users (email) VALUES ('migration-normalized-url@example.test')
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
       RETURNING id`,
    )).rows[0];
    assert.ok(normalizedUser);
    await pool.query(
      `INSERT INTO saved_articles (user_id, title, url, normalized_url)
       VALUES ($1, 'stale-normalized-url', 'https://example.test/article?utm_source=test', 'https://stale.example.test/value'),
              ($1, 'url-less-stale-value', NULL, 'https://stale.example.test/url-less')`,
      [normalizedUser.id],
    );
    await pool.query(
      `DELETE FROM atomflow_schema_migrations
       WHERE id IN ('20260813_saved_articles_normalized_url_v2', $1)`,
      [DATABASE_SCHEMA_VERSION],
    );
    await pool.query(`DROP INDEX idx_saved_articles_normalized_url_unique`);
    await pool.query(`CREATE INDEX idx_saved_articles_normalized_url_unique ON saved_articles(saved_at)`);
    await runDatabaseMigrations(pool, logger);
    const repairedUrls = await pool.query<{ title: string; normalizedUrl: string | null }>(
      `SELECT title, normalized_url AS "normalizedUrl"
       FROM saved_articles
       WHERE user_id = $1
       ORDER BY title`,
      [normalizedUser.id],
    );
    assert.deepEqual(repairedUrls.rows, [
      { title: "stale-normalized-url", normalizedUrl: "https://example.test/article" },
      { title: "url-less-stale-value", normalizedUrl: null },
    ]);
    const normalizedIndex = (await pool.query<{ isUnique: boolean; definition: string }>(
      `SELECT index_meta.indisunique AS "isUnique", pg_get_indexdef(index_meta.indexrelid) AS definition
       FROM pg_class index_class
       JOIN pg_index index_meta ON index_meta.indexrelid = index_class.oid
       WHERE index_class.relname = 'idx_saved_articles_normalized_url_unique'`,
    )).rows[0];
    assert.equal(normalizedIndex?.isUnique, true);
    assert.match(normalizedIndex?.definition || "", /\(user_id, normalized_url\).*WHERE \(normalized_url IS NOT NULL\)/i);
    await pool.query(
      `INSERT INTO saved_articles (user_id, title, url, normalized_url)
       VALUES ($1, 'conflict-target', 'https://example.test/article', 'https://example.test/article')
       ON CONFLICT (user_id, normalized_url) WHERE normalized_url IS NOT NULL
       DO UPDATE SET title = EXCLUDED.title`,
      [normalizedUser.id],
    );
    await pool.query("DELETE FROM users WHERE id = $1", [normalizedUser.id]);

    const semanticUser = (await pool.query<{ id: number }>(
      `INSERT INTO users (email) VALUES ('migration-semantic-fields@example.test') RETURNING id`,
    )).rows[0];
    assert.ok(semanticUser);
    const semanticProject = (await pool.query<{ id: number }>(
      `INSERT INTO write_canvas_projects (user_id, name) VALUES ($1, 'semantic-upgrade') RETURNING id`,
      [semanticUser.id],
    )).rows[0];
    assert.ok(semanticProject);
    const semanticNode = (await pool.query<{ id: number }>(
      `INSERT INTO write_canvas_nodes
         (user_id, project_id, kind, node_role, content_type, origin, status, title)
       VALUES ($1, $2, 'result', 'task', 'document_section', 'manual', NULL, 'partial-row')
       RETURNING id`,
      [semanticUser.id, semanticProject.id],
    )).rows[0];
    assert.ok(semanticNode);
    await pool.query(
      `DELETE FROM atomflow_schema_migrations
       WHERE id IN ('20260813_creative_canvas_compatibility_v3', $1)`,
      [DATABASE_SCHEMA_VERSION],
    );
    await runDatabaseMigrations(pool, logger);
    const preservedSemanticNode = (await pool.query<{
      nodeRole: string;
      contentType: string;
      origin: string;
      status: string;
    }>(
      `SELECT node_role AS "nodeRole", content_type AS "contentType", origin, status
       FROM write_canvas_nodes WHERE id = $1`,
      [semanticNode.id],
    )).rows[0];
    assert.deepEqual(preservedSemanticNode, {
      nodeRole: "task",
      contentType: "document_section",
      origin: "manual",
      status: "pending_review",
    });
    await pool.query("DELETE FROM users WHERE id = $1", [semanticUser.id]);

    const ambiguousUser = (await pool.query<{ id: number }>(
      `INSERT INTO users (email) VALUES ('migration-ambiguous-asset@example.test') RETURNING id`,
    )).rows[0];
    assert.ok(ambiguousUser);
    const ambiguousProjects = (await pool.query<{ id: number }>(
      `INSERT INTO write_canvas_projects (user_id, name)
       VALUES ($1, 'asset-project-a'), ($1, 'asset-project-b')
       RETURNING id`,
      [ambiguousUser.id],
    )).rows;
    assert.equal(ambiguousProjects.length, 2);
    await pool.query(`ALTER TABLE write_canvas_nodes DROP CONSTRAINT write_canvas_nodes_asset_owner_fkey`);
    const ambiguousAsset = (await pool.query<{ id: number }>(
      `INSERT INTO write_canvas_assets (user_id, project_id, type, title)
       VALUES ($1, NULL, 'text', 'ambiguous-legacy-asset') RETURNING id`,
      [ambiguousUser.id],
    )).rows[0];
    assert.ok(ambiguousAsset);
    for (const project of ambiguousProjects) {
      await pool.query(
        `INSERT INTO write_canvas_nodes
           (user_id, project_id, kind, node_role, content_type, origin, status, asset_id, title)
         VALUES ($1, $2, 'asset_text', 'material', 'text', 'existing', 'ready', $3, 'ambiguous-reference')`,
        [ambiguousUser.id, project.id, ambiguousAsset.id],
      );
    }
    await pool.query(
      `DELETE FROM atomflow_schema_migrations
       WHERE id IN ('20260813_creative_canvas_compatibility_v3', $1)`,
      [DATABASE_SCHEMA_VERSION],
    );
    await assert.rejects(
      runDatabaseMigrations(pool, logger),
      /Legacy canvas asset references multiple projects.*explicit backed-up maintenance migration/,
    );
    const assetAfterRejectedMigration = (await pool.query<{ projectId: number | null }>(
      `SELECT project_id AS "projectId" FROM write_canvas_assets WHERE id = $1`,
      [ambiguousAsset.id],
    )).rows[0];
    assert.equal(assetAfterRejectedMigration?.projectId, null, "the fail-closed migration must roll back the ambiguous asset update");
    await pool.query("DELETE FROM users WHERE id = $1", [ambiguousUser.id]);
    await runDatabaseMigrations(pool, logger);
    assert.equal(await verifyDatabaseSchema(pool), true);
  } finally {
    await pool.end();
  }
});
