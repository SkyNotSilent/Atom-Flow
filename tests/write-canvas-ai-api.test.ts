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
assert.match(server, /reserved_tokens\s+BIGINT/, "AI runs must persist their budget reservation for crash recovery");
assert.match(server, /provider_started\s+BOOLEAN/, "AI runs must persist the provider billing boundary");
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
assert.match(server, /reserveCanvasAgentRunBudget[\s\S]{0,1600}member/, "Batch execution must durably reserve budget per member call");
assert.match(server, /'generated'/, "AI output lineage must use the generated relation");

assert.match(server, /WRITE_CANVAS_MAX_AGGREGATE_CONTEXT_CHARS[\s\S]{0,180}=\s*readBoundedEnvNumber\([^\n]*120000/, "Each request needs an aggregate context bound near 120k chars");
assert.match(server, /estimateCanvasInputTokens/, "AI reservations must account for estimated input tokens");
assert.match(server, /\$2::bigint <= \$4::bigint/, "PostgreSQL budget reservations must use stable numeric parameter types");
assert.match(server, /RETURNING usage_date::text AS usage_date/, "Budget reservation dates must cross the PostgreSQL boundary without timezone conversion");
assert.match(server, /operation_count = GREATEST\(0, operation_count - \$4::integer\)/, "Aggregated crash recovery must refund every abandoned operation, not only one row");
assert.match(server, /estimateCanvasInputTokens[\s\S]{0,700}imageDataUrl/, "Image context must contribute to estimated input tokens");
assert.match(server, /assertCanvasAggregateContextWithinLimit/, "Oversized aggregate context must be rejected before provider calls");
assert.match(server, /assertCanvasStorageQuota/, "Durable AI metadata must use the canvas storage quota");
for (const table of ["write_canvas_agent_messages", "write_canvas_agent_groups", "write_canvas_agent_group_members", "write_canvas_agent_runs", "write_canvas_agent_batches"]) {
  assert.match(server, new RegExp(`FROM ${table} WHERE user_id = \\$1`), `${table} must be included in canvas storage accounting`);
}
assert.match(server, /'partial'/, "Mixed batches need a terminal partial status");
assert.match(
  server,
  /write_canvas_agent_groups[\s\S]{0,700}status IN \('ready','running','completed','partial','failed','cancelled'\)/,
  "Cancelled batches must have a valid atomic group terminal status",
);
assert.match(server, /finishCanvasAgentBatch/, "Batch and group terminal state should be finalized by one transactional helper");
assert.match(server, /CANVAS_AI_RECOVERY_STALE_MS/, "Stale AI work needs a timeout-aware recovery threshold");
assert.match(server, /CANVAS_AI_RECOVERY_INTERVAL_MS/, "Stale AI work must be reconciled periodically, not only at process startup");
assert.match(server, /FOR UPDATE[\s\S]{0,1200}已有批次正在运行/, "A row lock must reject a second active batch for the same group");
assert.match(server, /current_batch_id\s+BIGINT/, "Agent groups need a persisted current-batch lease");
assert.match(server, /write_canvas_agent_groups_current_batch_owner_fkey[\s\S]{0,350}REFERENCES write_canvas_agent_batches\(id, user_id, project_id, group_id\)/, "The current batch lease must be tenant and group scoped in PostgreSQL");
assert.match(server, /write_canvas_agent_runs_group_fields_check[\s\S]{0,400}group_id IS NULL[\s\S]{0,250}batch_id IS NOT NULL/, "Nullable group run fields must have an explicit consistency check");
assert.match(server, /assertCurrentCanvasAgentBatchLease/, "Output persistence must validate the current batch lease");
assert.match(
  server,
  /status = CASE[\s\S]{0,500}status = 'completed'[\s\S]{0,300}THEN 'partial'[\s\S]{0,100}ELSE 'failed'/,
  "Stale recovery must preserve partial success",
);

const quickActionRoute = routeSegment(
  'app.post("/api/write/canvas/nodes/:id/actions/stream"',
  'app.post("/api/write/canvas/agent-groups/:id/batches/stream"',
);
const groupBatchRoute = routeSegment(
  'app.post("/api/write/canvas/agent-groups/:id/batches/stream"',
  'app.post("/api/write/canvas/agents/:id/chat/stream"',
);
assert.match(
  groupBatchRoute,
  /SET status = CASE[\s\S]{0,400}status <> 'completed'[\s\S]{0,180}THEN 'partial' ELSE 'completed'/,
  "request-driven recovery must distinguish all-success batches from partial batches",
);
const singleAgentRoute = routeSegment(
  'app.post("/api/write/canvas/agents/:id/chat/stream"',
  'app.post("/api/write/canvas/agents/:id/save-result"',
);
const groupBatchHistoryRoute = routeSegment(
  'app.get("/api/write/canvas/agent-groups/:id/batches"',
  'app.get("/api/write/canvas/projects/:projectId/agent-groups"',
);
assertOrdered(quickActionRoute, 'res.once("close"', "resolveCanvasOwnedNodeContext", "Quick action cancellation must be registered before context resolution");
assertOrdered(groupBatchRoute, 'res.once("close"', "resolveCanvasOwnedNodeContext", "Batch cancellation must be registered before context resolution");
assert.match(quickActionRoute, /requestAbortController\.signal\.aborted\s*\?\s*"cancelled"\s*:\s*"failed"/, "Aborted quick actions must persist cancelled rather than failed");
assert.match(groupBatchRoute, /requestAbortController\.signal\.throwIfAborted\(\)[\s\S]{0,500}requestCanvasAgentCompletion/, "Batch must check cancellation immediately before provider calls");
assert.match(groupBatchRoute, /node\.kind === "agent" \|\| node\.node_role === "task" \|\| node\.status === "rejected"/, "Agent groups must reject task, self and rejected context nodes on the server");
assert.match(groupBatchRoute, /failCanvasAgentRunIfLeaseCurrent/, "Failed or cancelled group members must atomically finalize their budget reservation");
assert.match(quickActionRoute, /failStandaloneCanvasAgentRun/, "Failed or cancelled quick actions must atomically finalize their budget reservation");
assert.match(server, /markCanvasAgentRunProviderStarted[\s\S]{0,500}provider_started = TRUE/, "Provider dispatch must have a durable run boundary");
assertOrdered(quickActionRoute, "markCanvasAgentRunProviderStarted", "requestCanvasAgentCompletion", "Quick AI must persist the provider billing boundary before dispatch");
assertOrdered(groupBatchRoute, "markCanvasAgentRunProviderStarted", "requestCanvasAgentCompletion", "Agent group members must persist the provider billing boundary before dispatch");
assertOrdered(singleAgentRoute, 'providerStarted: true', "requestCanvasAgentCompletion", "Single Agent turns must persist the provider billing boundary before dispatch");
assert.match(server, /failStandaloneCanvasAgentRun[\s\S]{0,1600}!run\.provider_started[\s\S]{0,400}releaseDailyAiBudget/, "Quick AI may refund only before provider dispatch");
assert.match(server, /failCanvasAgentRunIfLeaseCurrent[\s\S]{0,1600}!run\.provider_started[\s\S]{0,500}releaseDailyAiBudget/, "Agent group members may refund only before provider dispatch");
assert.match(server, /cancelPendingCanvasAgentMessage[\s\S]{0,1400}meta\.providerStarted !== true[\s\S]{0,500}releaseDailyAiBudget/, "Single Agent turns may refund only before provider dispatch");
assert.match(groupBatchRoute, /assertCurrentCanvasAgentBatchLease[\s\S]{0,600}createCanvasGeneratedNodes/, "Superseded batches must be rejected before output nodes are created");
assert.match(groupBatchRoute, /current_batch_id\s*=\s*\$1/, "Batch creation must acquire the group lease");
assert.match(
  server,
  /assertCurrentCanvasAgentBatchLease[\s\S]{0,1200}b\.status = 'running'[\s\S]{0,300}g\.current_batch_id = b\.id/,
  "The lease guard must lock the running batch selected by the group",
);
assert.match(
  server,
  /finishCanvasAgentBatch[\s\S]{0,1600}assertCurrentCanvasAgentBatchLease[\s\S]{0,1200}current_batch_id = NULL/,
  "Terminal batch and group updates must use the same lease CAS",
);

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
assert.match(server, /target_node\.content_type = 'agent_group'[\s\S]{0,1000}SET relation = 'context'/, "startup repair must preserve Agent-group context authorization");
assert.match(server, /target_node\.kind <> 'agent' AND NOT \(target_node\.node_role = 'task' AND target_node\.content_type = 'agent_group'\)/, "context cleanup must recognize Agent-group task targets");
assert.match(server, /recoverStaleCanvasAiWork[\s\S]{0,5000}write_canvas_agent_batches[\s\S]{0,1800}current_batch_id = NULL/, "stale recovery must converge abandoned Agent-group batches without killing fresh leases");
assert.match(server, /recoverStaleCanvasAiWork[\s\S]{0,7000}write_canvas_agent_messages[\s\S]{0,900}meta->>'status' = 'pending'/, "periodic recovery must clean stale incomplete Agent messages");
assert.match(server, /recoverStaleCanvasAiWork[\s\S]{0,2200}refundReservations[\s\S]{0,1200}releaseDailyAiBudget/, "stale undispatched work must release durable budget reservations");
assert.match(server, /refundReservations[\s\S]{0,1200}operationCount[\s\S]{0,500}operationCount \+= 1/, "stale reservation aggregation must preserve operation cardinality");
assert.match(server, /staleRuns[\s\S]{0,1000}!run\.provider_started[\s\S]{0,500}reservedTokens/, "stale runs may be refunded only when provider dispatch never started");
assert.match(groupBatchRoute, /staleRuns[\s\S]{0,1000}run\.provider_started[\s\S]{0,700}releaseDailyAiBudget/, "request-driven stale takeover must refund undispatched durable reservations");
assert.match(groupBatchRoute, /reserved_tokens = CASE WHEN provider_started THEN reserved_tokens ELSE 0 END/, "stale takeover must clear only refundable run reservations");
assert.doesNotMatch(
  server,
  /requestCanvasAgentCompletion[\s\S]{0,3600}AbortSignal\.any\(\[input\.signal/,
  "a durably dispatched Canvas request must finish provider execution after the browser disconnects",
);
assert.match(server, /fetch\(chatCompletionsUrl,[\s\S]{0,700}signal: AbortSignal\.timeout\(AI_REQUEST_TIMEOUT_MS\)/, "Canvas provider dispatch must retain a bounded server timeout");
assert.match(
  server,
  /let canvasAiRecoveryTimer:[\s\S]{0,120}= null;[\s\S]{0,300}if \(pool\) \{[\s\S]{0,500}canvasAiRecoveryTimer = setInterval/,
  "Canvas AI recovery must not start in the database-free development mode",
);
assert.match(server, /if \(canvasAiRecoveryTimer\) clearInterval\(canvasAiRecoveryTimer\)/, "shutdown must tolerate a disabled Canvas AI recovery timer");

assert.match(server, /app\.get\("\/api\/write\/canvas\/projects\/:projectId\/runs", requireAuth/, "Project run history must be discoverable");
assert.match(server, /app\.get\("\/api\/write\/canvas\/agent-groups\/:id\/batches", requireAuth/, "Group batch history must be discoverable");
assert.match(groupBatchHistoryRoute, /write_canvas_agent_runs WHERE group_id = \$1 AND user_id = \$2/, "Group history runs must be tenant-scoped");
assert.match(groupBatchHistoryRoute, /res\.json\(\{ batches, runs \}\)/, "Group history must restore batch member outcomes");
assert.match(server, /requireCanvasCompletionContent/, "Empty provider responses must fail before persistence");

const legacyConstraintMigration = routeSegment(
  'await runSchemaTransaction(async client => {',
  'ALTER TABLE write_canvas_nodes ADD COLUMN IF NOT EXISTS node_role TEXT',
);
const canonicalGroupNodeMigration = routeSegment(
  'ALTER TABLE write_canvas_nodes ADD COLUMN IF NOT EXISTS node_role TEXT',
  'CREATE TABLE IF NOT EXISTS write_canvas_documents',
);
assert.match(server, /runSchemaTransaction[\s\S]{0,700}BEGIN[\s\S]{0,500}COMMIT[\s\S]{0,500}ROLLBACK/, "Schema transaction helper must commit or roll back on one client");
assert.match(legacyConstraintMigration, /runSchemaTransaction\(async client =>/, "Legacy FK drops and replacements must be one transaction");
assert.match(legacyConstraintMigration, /pg_get_constraintdef[\s\S]{0,2200}DROP CONSTRAINT[\s\S]{0,500}ADD CONSTRAINT/, "status constraints must only be replaced when their definitions are stale");
assert.doesNotMatch(legacyConstraintMigration, /DROP CONSTRAINT IF EXISTS/, "startup must not acquire table locks for absent legacy constraints");
assert.match(canonicalGroupNodeMigration, /runSchemaTransaction\(async client =>/, "Canonical group-node backfill must be transactional");
assert.match(canonicalGroupNodeMigration, /CREATE UNIQUE INDEX[\s\S]{0,300}agent_group[\s\S]{0,1800}ON CONFLICT/, "Canonical group nodes need an idempotent unique business reference");

console.log("PASS: canvas quick AI and Agent group API contracts");
