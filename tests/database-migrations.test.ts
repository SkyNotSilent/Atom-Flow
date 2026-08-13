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
assert.match(migrations, /runSchemaMigrationOnce\("20260813_creative_canvas_schema_v2"/, "Creative canvas schema changes must be a one-time transaction");
assert.match(migrations, /runSchemaMigrationOnce\("20260813_creative_canvas_compatibility_v3"/, "Creative canvas compatibility repairs must run after the first rollout marker");
assert.match(migrations, /runSchemaMigrationOnce\("20260813_saved_articles_normalized_url_v2"/, "Normalized URL repairs must run even if the first rollout marker already exists");
assert.match(migrations, /CREATE TABLE IF NOT EXISTS ai_budget_reservations/, "Durable paid-operation reservations must be created by pre-deploy migrations");
for (const table of [
  "write_canvas_agent_groups",
  "write_canvas_agent_group_members",
  "write_canvas_agent_batches",
  "write_canvas_agent_runs",
  "write_canvas_documents",
  "write_canvas_document_versions",
  "write_canvas_document_sections",
]) {
  assert.match(migrations, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`), `${table} must be created by pre-deploy migrations`);
}
for (const column of ["node_role", "content_type", "origin", "status", "business_ref", "document_id"]) {
  assert.match(migrations, new RegExp(`write_canvas_nodes ADD COLUMN IF NOT EXISTS ${column}`), `write_canvas_nodes.${column} must be migrated idempotently`);
}
assert.match(migrations, /write_canvas_agent_groups_current_batch_owner_fkey/, "Agent-group batch leases must be tenant scoped");
assert.match(migrations, /write_canvas_documents_current_version_owner_fkey/, "Document versions must be tenant scoped");
assert.match(migrations, /Duplicate canvas Agent-group nodes require an explicit backed-up maintenance migration/, "Canvas deduplication must require an explicit maintenance migration");
assert.match(migrations, /SET node_role = COALESCE\(node_role,[\s\S]*content_type = COALESCE\(content_type,[\s\S]*origin = COALESCE\(origin,[\s\S]*status = COALESCE\(status,/, "Partial canvas semantic upgrades must preserve populated fields");
assert.match(migrations, /Legacy canvas asset references multiple projects[\s\S]*explicit backed-up maintenance migration/, "Ambiguous legacy canvas assets must fail before project backfill");
assert.match(migrations, /indisunique AS "isUnique"[\s\S]*indisvalid AS "isValid"[\s\S]*idx_saved_articles_normalized_url_unique/, "The normalized URL index must be structurally verified");
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
