import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const server = readFileSync(path.join(process.cwd(), "server.ts"), "utf8");

assert.match(server, /CREATE TABLE IF NOT EXISTS write_canvas_agent_runs/, "Quick and explicit AI work needs durable runs");
assert.match(server, /CREATE TABLE IF NOT EXISTS write_canvas_agent_groups/, "Reusable Agent groups must be persisted");
assert.match(server, /CREATE TABLE IF NOT EXISTS write_canvas_agent_group_members/, "Agent group member configuration must be persisted");
assert.match(server, /CREATE TABLE IF NOT EXISTS write_canvas_agent_batches/, "Batch status must survive request completion");
assert.match(server, /app\.post\("\/api\/write\/canvas\/nodes\/:id\/actions\/stream"/, "Nodes must expose one-off AI actions");
assert.match(server, /extract_insights/);
assert.match(server, /extract_data/);
assert.match(server, /extract_quotes/);
assert.match(server, /extract_stories/);
assert.match(server, /generate_outline/);
assert.match(server, /app\.get\("\/api\/write\/canvas\/runs\/:id"/, "Users must be able to reload run state");
assert.match(server, /app\.post\("\/api\/write\/canvas\/projects\/:projectId\/agent-groups"/);
assert.match(server, /app\.post\("\/api\/write\/canvas\/agent-groups\/:id\/batches\/stream"/);
assert.match(server, /WRITE_CANVAS_MAX_AGENT_GROUP_MEMBERS\s*=\s*3/, "Initial batches must cap members at three");
assert.match(server, /reserveDailyAiBudget[\s\S]{0,1600}member/, "Batch execution must reserve budget per member call");
assert.match(server, /'generated'/, "AI output lineage must use the generated relation");

console.log("PASS: canvas quick AI and Agent group API contracts");
