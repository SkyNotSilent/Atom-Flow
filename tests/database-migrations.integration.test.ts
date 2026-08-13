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
  } finally {
    await pool.end();
  }
});
