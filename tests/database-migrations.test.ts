import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import type pg from "pg";
import { DATABASE_SCHEMA_VERSION, verifyDatabaseSchema } from "../src/server/databaseMigrations.js";

const root = process.cwd();
const server = readFileSync(path.join(root, "server.ts"), "utf8");
const migrations = readFileSync(path.join(root, "src/server/databaseMigrations.ts"), "utf8");
const migrationCommand = readFileSync(path.join(root, "scripts/migrate.ts"), "utf8");
const railway = JSON.parse(readFileSync(path.join(root, "railway.json"), "utf8")) as {
  deploy?: { preDeployCommand?: string; healthcheckTimeout?: number };
};

assert.doesNotMatch(server, /CREATE TABLE IF NOT EXISTS users/, "Web startup must not run the full migration");
assert.match(server, /schemaReady = await verifyDatabaseSchema\(pool\)/, "Web startup must verify the schema marker");
assert.match(migrations, /pg_advisory_lock\(hashtext\('atomflow-schema-migration'\)\)/, "Migrations must hold the shared advisory lock");
assert.match(migrations, /runSchemaMigrationOnce\("20260811_billing_schema_v1"/, "Billing rewrites must be a one-time transaction");
assert.match(migrations, /HAVING COUNT\(\*\) > 1[\s\S]*?explicit backed-up maintenance migration/, "Duplicate article cleanup must require a maintenance migration");
assert.match(migrations, /indisvalid AS "isValid"[\s\S]*?indisready AS "isReady"[\s\S]*?pg_get_indexdef/, "Existing unique indexes must be valid, ready, and structurally verified");
assert.doesNotMatch(migrations, /DELETE FROM saved_articles/, "Automatic pre-deploy must not delete saved articles");
assert.match(migrationCommand, /finally \{[\s\S]*?await pool\.end\(\)/, "The migration command must always close its pool");
assert.equal(railway.deploy?.preDeployCommand, "npm run migrate");
assert.equal(railway.deploy?.healthcheckTimeout, 180);

const missingRegistryPool = {
  query: async () => ({ rows: [{ registry: null }] }),
} as unknown as pg.Pool;
assert.equal(await verifyDatabaseSchema(missingRegistryPool), false);

const observedParameters: unknown[][] = [];
const readyPool = {
  query: async (_sql: string, parameters?: unknown[]) => {
    if (!parameters) return { rows: [{ registry: "atomflow_schema_migrations" }] };
    observedParameters.push(parameters);
    return { rows: [{ ready: true }] };
  },
} as unknown as pg.Pool;
assert.equal(await verifyDatabaseSchema(readyPool), true);
assert.deepEqual(observedParameters, [[DATABASE_SCHEMA_VERSION]]);

console.log("PASS: database pre-deploy migration governance");
