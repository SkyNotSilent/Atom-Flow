import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const server = readFileSync(path.join(process.cwd(), "server.ts"), "utf8");
const routeSegment = (start: string, end: string) => {
  const startIndex = server.indexOf(start);
  const endIndex = server.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing route start: ${start}`);
  assert.notEqual(endIndex, -1, `missing route end: ${end}`);
  return server.slice(startIndex, endIndex);
};
const assertOrdered = (source: string, before: string, after: string, message: string) => {
  const beforeIndex = source.indexOf(before);
  const afterIndex = source.indexOf(after);
  assert.ok(beforeIndex >= 0 && afterIndex >= 0 && beforeIndex < afterIndex, message);
};

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

assert.match(server, /WRITE_CANVAS_MAX_AGGREGATE_CONTEXT_CHARS[\s\S]{0,180}=\s*readBoundedEnvNumber\([^\n]*120000/, "Each request needs an aggregate context bound near 120k chars");
assert.match(server, /estimateCanvasInputTokens/, "AI reservations must account for estimated input tokens");
assert.match(server, /estimateCanvasInputTokens[\s\S]{0,700}imageDataUrl/, "Image context must contribute to estimated input tokens");
assert.match(server, /assertCanvasAggregateContextWithinLimit/, "Oversized aggregate context must be rejected before provider calls");
assert.match(server, /assertCanvasStorageQuota/, "Durable AI metadata must use the canvas storage quota");
for (const table of ["write_canvas_agent_groups", "write_canvas_agent_group_members", "write_canvas_agent_runs", "write_canvas_agent_batches"]) {
  assert.match(server, new RegExp(`FROM ${table} WHERE user_id = \\$1`), `${table} must be included in canvas storage accounting`);
}
assert.match(server, /'partial'/, "Mixed batches need a terminal partial status");
assert.match(
  server,
  /write_canvas_agent_groups[\s\S]{0,700}status IN \('ready','running','completed','partial','failed','cancelled'\)/,
  "Cancelled batches must have a valid atomic group terminal status",
);
assert.match(server, /finishCanvasAgentBatch/, "Batch and group terminal state should be finalized by one transactional helper");
assert.match(server, /WRITE_CANVAS_AGENT_BATCH_STALE_MS/, "Stale running batches need bounded recovery");
assert.match(server, /FOR UPDATE[\s\S]{0,1200}已有批次正在运行/, "A row lock must reject a second active batch for the same group");

const quickActionRoute = routeSegment(
  'app.post("/api/write/canvas/nodes/:id/actions/stream"',
  'app.post("/api/write/canvas/agent-groups/:id/batches/stream"',
);
const groupBatchRoute = routeSegment(
  'app.post("/api/write/canvas/agent-groups/:id/batches/stream"',
  'app.post("/api/write/canvas/agents/:id/chat/stream"',
);
const groupBatchHistoryRoute = routeSegment(
  'app.get("/api/write/canvas/agent-groups/:id/batches"',
  'app.get("/api/write/canvas/projects/:projectId/agent-groups"',
);
assertOrdered(quickActionRoute, 'res.once("close"', "resolveCanvasOwnedNodeContext", "Quick action cancellation must be registered before context resolution");
assertOrdered(groupBatchRoute, 'res.once("close"', "resolveCanvasOwnedNodeContext", "Batch cancellation must be registered before context resolution");
assert.match(groupBatchRoute, /requestAbortController\.signal\.throwIfAborted\(\)[\s\S]{0,500}requestCanvasAgentCompletion/, "Batch must check cancellation immediately before provider calls");

assert.match(
  server,
  /FOREIGN KEY \(group_member_id, user_id, project_id, group_id\)[\s\S]{0,180}ON DELETE SET NULL \(group_member_id\)/,
  "Historical runs must survive member deletion without weakening tenant ownership",
);
assert.match(server, /node_id\s+BIGINT/, "Agent groups must own a canonical task node");
assert.match(server, /UNIQUE \(id, user_id, project_id\)/, "Tenant-owned records need composite identity constraints");
assert.match(server, /FOREIGN KEY \(group_id, user_id, project_id\)/, "Cross-table group ownership must be enforced by a composite foreign key");
assert.match(server, /'agent_group'/, "Canonical group task nodes need the agent_group content type");
assert.match(server, /business_ref[\s\S]{0,800}groupId/, "Group task nodes must expose the group id as their business reference");
assert.match(groupBatchRoute, /source_node_id, target_node_id, relation[\s\S]{0,500}context/, "Selected context must connect to the group task node");
assert.match(groupBatchRoute, /sourceNodeId:\s*Number\(group\.node_id\)/, "Generated candidates must originate from the group task node");

assert.match(server, /app\.get\("\/api\/write\/canvas\/projects\/:projectId\/runs", requireAuth/, "Project run history must be discoverable");
assert.match(server, /app\.get\("\/api\/write\/canvas\/agent-groups\/:id\/batches", requireAuth/, "Group batch history must be discoverable");
assert.match(groupBatchHistoryRoute, /write_canvas_agent_runs WHERE group_id = \$1 AND user_id = \$2/, "Group history runs must be tenant-scoped");
assert.match(groupBatchHistoryRoute, /res\.json\(\{ batches, runs \}\)/, "Group history must restore batch member outcomes");
assert.match(server, /requireCanvasCompletionContent/, "Empty provider responses must fail before persistence");

console.log("PASS: canvas quick AI and Agent group API contracts");
