import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const serverRuntime = readFileSync(path.join(root, "server.ts"), "utf-8");
const databaseMigrations = readFileSync(path.join(root, "src", "server", "databaseMigrations.ts"), "utf-8");
const server = `${serverRuntime}\n${databaseMigrations}`;
const packageJson = readFileSync(path.join(root, "package.json"), "utf-8");
const types = readFileSync(path.join(root, "src", "types.ts"), "utf-8");
const canvas = readFileSync(path.join(root, "src", "pages", "MagicWritingCanvas.tsx"), "utf-8");
const addDrawerPath = path.join(root, "src", "components", "write-canvas", "CanvasAddDrawer.tsx");
const inspectorPath = path.join(root, "src", "components", "write-canvas", "CanvasInspector.tsx");
const contextRailPath = path.join(root, "src", "components", "write-canvas", "CanvasContextRail.tsx");
const canvasUi = [
  canvas,
  existsSync(addDrawerPath) ? readFileSync(addDrawerPath, "utf-8") : "",
  existsSync(inspectorPath) ? readFileSync(inspectorPath, "utf-8") : "",
  existsSync(contextRailPath) ? readFileSync(contextRailPath, "utf-8") : "",
].join("\n");

const section = (source: string, startMarker: string, endMarker: string) => {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `missing source marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `missing source marker after ${startMarker}: ${endMarker}`);
  return source.slice(start, end);
};

const documentRoute = section(
  server,
  "const canvasDocumentMultipart",
  'app.post("/api/write/canvas/projects/:id/citations"',
);
const projectCreateRoute = section(
  server,
  'app.post("/api/write/canvas/projects"',
  'app.get("/api/write/canvas/projects/:id"',
);
const citationRoute = section(
  server,
  'app.post("/api/write/canvas/projects/:id/citations"',
  'app.delete("/api/write/canvas/projects/:id"',
);
const projectDeleteRoute = section(
  server,
  'app.delete("/api/write/canvas/projects/:id"',
  'app.post("/api/write/canvas/projects/:id/nodes"',
);
const nodeCreateRoute = section(
  server,
  'app.post("/api/write/canvas/projects/:id/nodes"',
  'app.put("/api/write/canvas/nodes/:id"',
);
const nodeDeleteRoute = section(
  server,
  'app.delete("/api/write/canvas/nodes/:id"',
  'app.post("/api/write/canvas/edges"',
);
const nodeUpdateRoute = section(
  server,
  'app.put("/api/write/canvas/nodes/:id"',
  'app.delete("/api/write/canvas/nodes/:id"',
);
const ensureCanvasAgentThread = section(
  server,
  "const ensureCanvasAgentThread",
  "const fetchCanvasProjectDetail",
);
const edgeRoute = section(
  server,
  'app.post("/api/write/canvas/edges"',
  'app.delete("/api/write/canvas/edges"',
);
const edgeUpdateRoute = section(
  server,
  'app.put("/api/write/canvas/edges/:id"',
  'app.delete("/api/write/canvas/edges"',
);
const contextResolver = section(
  server,
  "const resolveCanvasContextItems",
  "const canvasContextsToWritingCards",
);
const canvasContextCardMapper = section(
  server,
  "const canvasContextsToWritingCards",
  "const canvasModelSupportsImages",
);
const recallConfirmationRoute = section(
  server,
  'app.post("/api/write/canvas/agents/:id/recall/confirm"',
  'app.post("/api/write/canvas/agents/:id/chat/stream"',
);
const canvasAgentRoute = section(
  server,
  'app.post("/api/write/canvas/agents/:id/chat/stream"',
  'app.post("/api/write/canvas/agents/:id/save-result"',
);
const canvasSaveResultRoute = section(
  server,
  'app.post("/api/write/canvas/agents/:id/save-result"',
  'app.get("/api/write/agent/threads"',
);
const canvasAgentValidation = section(
  server,
  "const canvasAgentChatValidationMiddleware",
  "const canvasAgentExecutionValidationMiddleware",
);
const canvasAgentExecutionValidation = section(
  server,
  "const canvasAgentExecutionValidationMiddleware",
  "const canvasCreateArticleReplayMiddleware",
);
const canvasAgentContextValidation = section(
  server,
  "const canvasAgentContextValidationMiddleware",
  "const canvasCreateArticleReplayMiddleware",
);
const canvasAgentReplay = section(
  server,
  "const canvasCreateArticleReplayMiddleware",
  "const canvasCreateArticleClaimMiddleware",
);
const canvasAgentClaim = section(
  server,
  "const canvasCreateArticleClaimMiddleware",
  "const canvasCreateArticleNoteRecoveryMiddleware",
);
const canvasAgentNoteRecoveryClaim = section(
  canvasAgentClaim,
  "} else if (noteExists) {",
  "} else if (Number(row.attempt_count)",
);
const canvasAgentPaidRetryClaim = section(
  canvasAgentClaim,
  "} else {\n          const retried",
  'await client.query("COMMIT")',
);
const canvasAgentRecovery = section(
  server,
  "const canvasCreateArticleNoteRecoveryMiddleware",
  "const canvasAgentExecutionLeaseMiddleware",
);
const activeCanvasAgentRunGuard = section(
  server,
  "const hasActiveCanvasAgentRun",
  "const acquireCanvasAgentExecutionLease",
);
const canvasAgentExecutionLeaseAcquire = section(
  server,
  "const acquireCanvasAgentExecutionLease",
  "const updateCanvasAgentExecutionLeaseThread",
);
const canvasAgentExecutionLeaseMiddleware = section(
  server,
  "const canvasAgentExecutionLeaseMiddleware",
  "const beginCanvasCreateArticleProviderAttempt",
);
const canvasAgentLeaseRenewal = section(
  server,
  "const renewCanvasAgentExecutionLease",
  "const releaseCanvasAgentExecutionLease",
);
const canvasAgentProviderAttempt = section(
  server,
  "const beginCanvasCreateArticleProviderAttempt",
  "const canvasAgentDailyBudgetMiddleware",
);
const canvasAgentBudget = section(
  server,
  "const canvasAgentDailyBudgetMiddleware",
  "// --- Set/Change password",
);
const threadDeleteRoute = section(
  server,
  'app.delete("/api/write/agent/threads/:id"',
  'app.get("/api/write/agent/threads/:id/messages"',
);
const accountDeleteRoute = section(
  server,
  'app.delete("/api/account"',
  'app.post("/api/auth/avatar"',
);
const cloneRoute = section(
  server,
  'app.post("/api/write/canvas/projects/:id/clone"',
  'app.post("/api/write/canvas/projects/:id/citations"',
);
const openAiRuntime = section(
  server,
  "const runOpenAIWriteAgentRuntime",
  "const SkillCreationGraphAnnotation",
);
const fallbackRuntime = section(
  server,
  "const runWriteAgentGraph",
  "type OpenAIWriteAgentContext",
);
const cloneMetadataRemapper = section(
  server,
  "const remapCanvasCloneMetadata",
  "const getDefaultCanvasAgentConfig",
);
const projectDetailLoader = section(
  canvas,
  "const loadProjectDetail",
  "useEffect(() => {",
);
const canvasAgentClient = section(
  canvas,
  "const sendAgentMessage",
  "const saveMessageToCanvas",
);
const citationMetaType = section(
  types,
  "export interface WriteCanvasCitationMeta",
  "export interface WriteCanvasPodcastMeta",
);
const podcastMetaType = section(
  types,
  "export interface WriteCanvasPodcastMeta",
  "export interface WriteSkillSelection",
);

assert.match(
  projectCreateRoute,
  /filterCanvasSkillConfig\(pool[\s\S]*?resolveEffectiveCanvasSkills\(pool[\s\S]*?const client = await pool\.connect\(\)/,
  "project creation must resolve Skills before checking out its transaction client",
);
assert.doesNotMatch(
  nodeCreateRoute,
  /filterCanvasSkillConfig\(pool/,
  "Agent node creation must not borrow a second pool connection while holding its transaction client",
);
assert.match(nodeCreateRoute, /filterCanvasSkillConfig\(client/);
assert.match(
  nodeCreateRoute,
  /finally \{[\s\S]*?client\.release\(\);[\s\S]*?\}[\s\S]*?fetchCanvasProjectDetail\(pool/,
  "node creation must release its transaction client before loading the response detail",
);
assert.match(
  ensureCanvasAgentThread,
  /BEGIN[\s\S]*?lockCanvasUser\(client, userId\)[\s\S]*?FROM write_agent_instances[\s\S]*?FOR UPDATE/,
  "lazy canvas-thread migration must use the global User→Agent lock order",
);
assert.match(
  server,
  /WRITE_CANVAS_LEGACY_THREAD_MIGRATION_MAX_BYTES\s*=\s*readBoundedEnvNumber\([\s\S]*?CANVAS_LEGACY_THREAD_MIGRATION_MAX_MB[\s\S]*?\)\s*\*\s*1024\s*\*\s*1024/,
  "legacy canvas-thread migration must have an explicit byte ceiling",
);
assert.match(
  ensureCanvasAgentThread,
  /ROW_NUMBER\(\) OVER \(ORDER BY created_at DESC, id DESC\) AS message_rank[\s\S]*?SUM\([\s\S]*?octet_length\(COALESCE\(content, ''\)::text\)[\s\S]*?octet_length\(COALESCE\(meta, '\{\}'::jsonb\)::text\)[\s\S]*?\) OVER \(ORDER BY created_at DESC, id DESC\) AS cumulative_message_bytes/,
  "legacy canvas-thread migration must rank recent messages and compute cumulative bytes before copying",
);
assert.match(
  ensureCanvasAgentThread,
  /WHERE message_rank <= \$4[\s\S]*?AND cumulative_message_bytes <= \$5[\s\S]*?ORDER BY created_at ASC, id ASC/,
  "legacy canvas-thread migration must retain only bounded recent history and insert it in chronological order",
);
assert.match(
  ensureCanvasAgentThread,
  /WRITE_CANVAS_MAX_MESSAGES_PER_AGENT[\s\S]*?WRITE_CANVAS_LEGACY_THREAD_MIGRATION_MAX_BYTES/,
  "legacy canvas-thread migration must pass both count and byte limits to the query",
);
assert.match(
  nodeDeleteRoute,
  /BEGIN[\s\S]*?lockCanvasUser[\s\S]*?FROM write_canvas_projects[\s\S]*?FOR UPDATE[\s\S]*?FROM write_canvas_nodes[\s\S]*?FOR UPDATE/,
  "node deletion must lock User→Project→Node before cascading to Agent or Asset",
);
assert.match(
  nodeUpdateRoute,
  /BEGIN[\s\S]*?lockCanvasUser[\s\S]*?FROM write_canvas_projects[\s\S]*?FOR UPDATE[\s\S]*?FROM write_canvas_nodes[\s\S]*?FOR UPDATE[\s\S]*?FROM write_agent_instances[\s\S]*?FOR UPDATE/,
  "Agent updates must lock User→Project→Node→Agent in one transaction",
);
assert.match(nodeUpdateRoute, /UPDATE write_canvas_nodes[\s\S]*?UPDATE write_agent_instances[\s\S]*?COMMIT/);
assert.match(
  databaseMigrations,
  /ALTER TABLE write_agent_threads[\s\S]*?DROP CONSTRAINT IF EXISTS write_agent_threads_thread_type_check,[\s\S]*?ADD CONSTRAINT write_agent_threads_thread_type_check/,
  "expanded thread constraints must be replaced atomically",
);
assert.match(
  databaseMigrations,
  /ALTER TABLE write_canvas_nodes[\s\S]*?DROP CONSTRAINT IF EXISTS write_canvas_nodes_kind_check,[\s\S]*?ADD CONSTRAINT write_canvas_nodes_kind_check/,
  "expanded node-kind constraints must be replaced atomically",
);

assert.match(databaseMigrations, /CREATE TABLE IF NOT EXISTS write_canvas_projects/, "canvas projects table must exist");
assert.match(databaseMigrations, /CREATE TABLE IF NOT EXISTS write_canvas_nodes/, "canvas nodes table must exist");
assert.match(databaseMigrations, /CREATE TABLE IF NOT EXISTS write_canvas_edges/, "canvas edges table must exist");
assert.match(databaseMigrations, /CREATE TABLE IF NOT EXISTS write_agent_templates/, "agent templates table must exist");
assert.match(databaseMigrations, /CREATE TABLE IF NOT EXISTS write_agent_instances/, "agent instances table must exist");
assert.match(databaseMigrations, /CREATE TABLE IF NOT EXISTS write_canvas_assets/, "canvas assets table must exist");
assert.match(databaseMigrations, /CREATE TABLE IF NOT EXISTS write_canvas_agent_messages/, "canvas agent messages table must exist");
assert.match(databaseMigrations, /CREATE TABLE IF NOT EXISTS write_canvas_agent_run_requests/, "create-article requests must have durable run ownership");
assert.match(databaseMigrations, /CREATE TABLE IF NOT EXISTS write_canvas_agent_execution_leases/, "ordinary canvas chat must have durable cross-process execution ownership");
assert.match(databaseMigrations, /CREATE TABLE IF NOT EXISTS atomflow_schema_migrations[\s\S]*?const runSchemaMigrationOnce/, "constraint rewrites must be recorded as one-time schema migrations");
assert.match(databaseMigrations, /runSchemaMigrationOnce\("20260809_write_canvas_project_document_checks"[\s\S]*?NOT VALID[\s\S]*?VALIDATE CONSTRAINT/, "large-table checks must not be dropped and revalidated on every startup");
assert.match(databaseMigrations, /UNIQUE \(user_id, agent_id, request_id\)/, "run request identity must be scoped to one user and Agent");
assert.match(databaseMigrations, /status\s+TEXT NOT NULL DEFAULT 'running' CHECK \(status IN \('running', 'completed', 'failed'\)\)/);
assert.match(databaseMigrations, /response_payload\s+JSONB/, "completed SSE payloads must be durable for exact retry replay");
assert.match(databaseMigrations, /budget_reserved_at\s+TIMESTAMPTZ/, "one logical request must remember its daily budget reservation");
assert.match(databaseMigrations, /provider_started_at\s+TIMESTAMPTZ/, "durable retries must distinguish budget reservation from provider invocation");
assert.match(databaseMigrations, /20260809_write_canvas_agent_attempt_accounting[\s\S]*?SET attempt_count = GREATEST\(attempt_count - 1, 0\)[\s\S]*?error_message = 'daily AI budget exhausted'[\s\S]*?budget_reserved_at IS NULL[\s\S]*?provider_started_at IS NULL/, "the migration must restore the one legacy attempt provably consumed by quota rejection");
assert.match(databaseMigrations, /20260809_write_canvas_agent_attempt_accounting[\s\S]*?SET provider_started_at = budget_reserved_at[\s\S]*?status IN \('running', 'failed'\)/, "the attempt-accounting migration must conservatively classify legacy paid runs");
assert.match(databaseMigrations, /lease_expires_at\s+TIMESTAMPTZ/, "abandoned runs must become safely retryable");
assert.match(databaseMigrations, /attempt_count\s+INTEGER NOT NULL DEFAULT 0/, "claiming a request must not itself consume a provider attempt");
assert.match(databaseMigrations, /write_canvas_agent_run_attempt_nonnegative_check[\s\S]*?attempt_count >= 0/, "zero-attempt claimed requests must be valid database state");
assert.match(databaseMigrations, /const WRITE_CANVAS_AGENT_RUN_MAX_ATTEMPTS = 3;/, "paid canvas retries must have a small, explicit attempt ceiling");
assert.match(databaseMigrations, /CONSTRAINT write_canvas_agent_run_attempt_max_check[\s\S]*?attempt_count <= \$\{WRITE_CANVAS_AGENT_RUN_MAX_ATTEMPTS\}/, "the database must preserve the run-attempt ceiling");
assert.match(databaseMigrations, /idx_write_agent_canvas_user_request/, "retrying a failed run must not append the same user instruction twice");
assert.match(databaseMigrations, /idx_write_canvas_agent_run_agent ON write_canvas_agent_run_requests\(agent_id\)/, "Agent deletion cascades must have a leading foreign-key index");
assert.match(databaseMigrations, /UNIQUE \(user_id, agent_id\)[\s\S]*?idx_write_canvas_agent_execution_lease_agent ON write_canvas_agent_execution_leases\(agent_id\)/, "ordinary chat leases must serialize per Agent and index their cascading foreign key");
assert.match(databaseMigrations, /tldraw_snapshot\s+JSONB/, "projects must persist the complete tldraw document in the planned canonical column");
assert.match(server, /SET tldraw_snapshot = \$1,[\s\S]*?document_snapshot = \$1/, "the rollback-window legacy snapshot must mirror canonical writes");
assert.match(databaseMigrations, /document_revision\s+BIGINT/, "projects must own an optimistic document revision");
assert.match(databaseMigrations, /document_schema_version\s+INTEGER/, "projects must persist the tldraw schema version");
assert.match(databaseMigrations, /default_skill_config\s+JSONB/, "projects must persist default Skills");
assert.match(databaseMigrations, /agent_thread_id\s+BIGINT/, "canvas Agent instances must point at the shared thread runtime");
assert.match(databaseMigrations, /skill_config\s+JSONB/, "Agent templates and instances must persist Skills selection");
assert.match(databaseMigrations, /thread_type IN \('chat', 'skill', 'canvas'\)/, "shared writing threads must support canvas sessions");
assert.match(databaseMigrations, /ALTER TABLE saved_articles ADD COLUMN IF NOT EXISTS audio_url TEXT/, "saved podcast articles must preserve the real audio URL");
assert.match(databaseMigrations, /ALTER TABLE saved_articles ADD COLUMN IF NOT EXISTS audio_duration TEXT/, "saved podcast articles must preserve audio duration");
assert.match(databaseMigrations, /kind IN \([^)]*'citation'[^)]*'podcast_episode'/, "canvas nodes must support citation and podcast episode nodes");

assert.match(server, /app\.get\("\/api\/write\/canvas\/projects", requireAuth/, "project list route must require auth");
assert.match(server, /app\.get\("\/api\/write\/canvas\/projects"[\s\S]*?const availableSkills = await fetchWriteAgentSkills\(pool, req\.session\.userId\)[\s\S]*?rows\.map\(row =>[\s\S]*?resolveEffectiveCanvasSkillsFromAvailable\(availableSkills/, "project Skills must be resolved from one shared query instead of an N+1 loop");
assert.match(server, /app\.post\("\/api\/write\/canvas\/projects", requireAuth/, "project create route must require auth");
assert.match(server, /app\.post\("\/api\/write\/canvas\/projects\/:id\/nodes", requireAuth/, "node create route must require auth");
assert.match(server, /app\.delete\("\/api\/write\/canvas\/nodes\/:id", requireAuth/, "node delete route must require auth");
assert.match(server, /app\.post\("\/api\/write\/canvas\/edges", requireAuth/, "edge create route must require auth");
assert.match(server, /app\.put\("\/api\/write\/canvas\/edges\/:id", requireAuth/, "edge reassignment route must require auth");
assert.match(server, /app\.post\("\/api\/write\/canvas\/assets\/upload", requireAuth,[^\n]*canvasAssetUpload\.single/, "asset upload route must require auth");
assert.match(server, /app\.post\("\/api\/write\/canvas\/agents\/:id\/chat\/stream", requireAuth/, "canvas agent stream route must require auth");
assert.match(server, /app\.put\("\/api\/write\/canvas\/projects\/:id\/document", requireAuth, canvasDocumentMultipart/, "document upload must require auth and multipart parsing");
assert.match(server, /app\.post\("\/api\/write\/canvas\/projects\/:id\/clone", requireAuth, canvasDocumentMultipart/, "project clone must require auth and use the bounded multipart parser");
assert.match(server, /app\.post\("\/api\/write\/canvas\/projects\/:id\/citations", requireAuth/, "citation capture must require auth");
assert.match(server, /app\.post\("\/api\/write\/canvas\/agents\/:id\/recall\/confirm", requireAuth/, "global recall confirmation must be an authenticated explicit action");
assert.match(server, /canvasModelSupportsImages/, "canvas agent must include hidden multimodal capability gate");

// A tldraw document is one bounded multipart payload with explicit optimistic
// concurrency. Native tldraw records are allowed, but embedded media is not.
assert.match(server, /WRITE_CANVAS_DOCUMENT_MAX_BYTES\s*=\s*2\s*\*\s*1024\s*\*\s*1024/);
assert.match(server, /WRITE_CANVAS_DOCUMENT_MAX_RECORDS\s*=\s*5000/);
assert.match(server, /const canvasDocumentUpload = multer\([\s\S]*?fileSize:\s*WRITE_CANVAS_DOCUMENT_MAX_BYTES[\s\S]*?files:\s*1/);
assert.match(documentRoute, /\{ name: "snapshot", maxCount: 1 \}/, "snapshot must be accepted as multipart data");
assert.match(documentRoute, /req\.body\?\.baseRevision/, "document writes must include the caller's base revision");
assert.match(documentRoute, /req\.body\?\.schemaVersion/, "document writes must include the schema version");
assert.match(server, /const validateCanvasDocumentSnapshotInput[\s\S]*?Buffer\.byteLength\([\s\S]*?WRITE_CANVAS_DOCUMENT_MAX_BYTES/);
assert.match(server, /const validateCanvasDocumentSnapshotInput[\s\S]*?WRITE_CANVAS_DOCUMENT_MAX_RECORDS/);
assert.match(server, /const validateCanvasDocumentSnapshotInput[\s\S]*?hasEmbeddedCanvasMedia\(snapshot\)/);
assert.match(server, /const validateCanvasDocumentSnapshotInput[\s\S]*?EMBEDDED_CANVAS_MEDIA_REJECTED/);
assert.match(documentRoute, /validateCanvasDocumentSnapshotInput\(rawSnapshot\)/, "document save and clone must share snapshot validation");
assert.match(documentRoute, /currentRevision !== baseRevision/);
assert.match(documentRoute, /status\(409\)/, "a stale base revision must return 409 instead of overwriting");
assert.match(documentRoute, /extractCanvasBusinessLayouts\(snapshot\)[\s\S]*?UPDATE write_canvas_nodes AS node[\s\S]*?jsonb_to_recordset/, "canonical business geometry must be persisted in one bounded batch");
assert.match(documentRoute, /viewport = COALESCE\(\$6::jsonb, viewport\)/, "camera state must commit with the same document revision");
assert.ok(
  documentRoute.indexOf("currentRevision !== baseRevision") < documentRoute.indexOf("UPDATE write_canvas_nodes AS node")
    && documentRoute.indexOf("UPDATE write_canvas_nodes AS node") < documentRoute.indexOf("document_revision = document_revision + 1"),
  "the revision check, business layout batch, and snapshot increment must share one transaction",
);
assert.match(documentRoute, /document_revision = document_revision \+ 1/);
assert.match(documentRoute, /CANVAS_REVISION_CONFLICT/);

// The client serializes document writes per project and blocks project
// transitions until every edit observed during an in-flight save is flushed.
assert.match(canvas, /type CanvasDocumentSaveTask = \{[\s\S]*?projectId: number;[\s\S]*?changeVersion: number;/);
assert.match(canvas, /documentRevisionByProjectRef = useRef\(new Map<number, number>\(\)\)/);
assert.match(canvas, /documentSaveInFlightRef = useRef<Promise<boolean> \| null>/);
assert.match(canvas, /const saveDocumentTask[\s\S]*?fetch\(`\/api\/write\/canvas\/projects\/\$\{projectId\}\/document`/);
assert.match(canvas, /form\.append\('viewport', JSON\.stringify\(viewport\)\)/, "the client must send camera state through the revisioned document endpoint");
assert.match(canvas, /const startDocumentSaveDrain[\s\S]*?while \(documentSaveQueuedRef\.current\)/);
assert.match(canvas, /flushDocumentRef\.current = async \(\) => \{[\s\S]*?savedChangeVersion < currentChangeVersion[\s\S]*?await activeSave/);
assert.match(canvas, /const switchProject[\s\S]*?await flushDocumentRef\.current\(\)[\s\S]*?activateProject\(projectId\)/);
assert.match(canvas, /const switchProject[\s\S]*?flushBusinessMutationsRef\.current\(\)[\s\S]*?flushDocumentRef\.current\(\)/, "project switches must drain business rows before the document snapshot");
assert.match(canvas, /const trackBusinessMutation[\s\S]*?pendingBusinessMutationsRef\.current\.add/);
assert.match(canvas, /const performBusinessFetch[\s\S]*?trackBusinessMutation\(fetch\(input, init\)/, "network failures must settle tracked mutations without leaking rejected promises");
assert.match(canvas, /const createNode[\s\S]*?performBusinessFetch\(`\/api\/write\/canvas\/projects/);
assert.match(canvas, /flushBusinessMutationsRef\.current = async[\s\S]*?drainBusinessReconciliationsRef\.current\(\)[\s\S]*?pendingBusinessMutationsRef\.current/, "deferred authority changes must drain before a document save or project exit");
assert.match(canvas, /visibilityState === 'hidden'[\s\S]*?flushBusinessMutationsRef\.current\(\)[\s\S]*?flushDocumentRef\.current\(\)/, "page hiding must flush business rows and then the tldraw document");
assert.match(canvas, /const saveConflictAsNewProject[\s\S]*?captureDocumentSnapshot\(\)[\s\S]*?new FormData\(\)[\s\S]*?\/clone/);
assert.match(projectDetailLoader, /const knownRevision = documentRevisionByProjectRef\.current\.get\(projectId\) \?\? 0/);
assert.match(projectDetailLoader, /if \(revision < knownRevision\) return null/);
assert.ok(
  projectDetailLoader.indexOf("if (revision < knownRevision) return null")
    < projectDetailLoader.indexOf("detailRef.current = payload"),
  "a late project GET must be rejected before it can replace a newer saved document",
);

// Each canvas Agent stream has one owner. A newer request or account-scoped
// unmount aborts the old reader, and only the current controller may clear UI state.
assert.match(canvas, /const agentStreamAbortControllerRef = useRef<AbortController \| null>\(null\)/);
assert.match(canvas, /useEffect\(\(\) => \(\) => \{[\s\S]*?agentStreamAbortControllerRef\.current = null;[\s\S]*?controller\?\.abort\(\)/);
assert.match(canvasAgentClient, /agentStreamAbortControllerRef\.current\?\.abort\(\)[\s\S]*?new AbortController\(\)/);
assert.match(canvasAgentClient, /signal: requestController\.signal/);
assert.match(canvasAgentClient, /requestController\.signal\.aborted \|\| \(error instanceof DOMException && error\.name === 'AbortError'\)\) return/);
assert.match(canvasAgentClient, /if \(agentStreamAbortControllerRef\.current === requestController\) \{[\s\S]*?setIsAgentRunning\(false\)/);

// Citations preserve a small, traceable quote snapshot. The route is
// intentionally independent from knowledge saving and paid atomization.
assert.match(citationRoute, /selection\.exact is required/);
assert.match(citationRoute, /exact\.length > 2000/);
assert.match(citationRoute, /const exact = typeof rawSelection\.exact === "string" \? rawSelection\.exact : "";/, "citation exact must preserve the source selection verbatim");
assert.match(citationRoute, /if \(!exact\.trim\(\)\)/, "citation exact may trim only for the non-empty check");
assert.doesNotMatch(citationRoute, /const exact =[^;]*\.trim\(\)/, "citation exact must not trim the persisted quote");
assert.match(citationRoute, /prefix:[\s\S]*?slice\(-120\)/);
assert.match(citationRoute, /suffix:[\s\S]*?slice\(0, 120\)/);
assert.match(citationRoute, /paragraph:[\s\S]*?slice\(0, 8000\)/);
assert.match(citationRoute, /heading:[\s\S]*?slice\(0, 500\)/);
assert.match(citationRoute, /capturedAt/);
assert.match(citationRoute, /fetchedAt: new Date\(\)\.toISOString\(\)/, "citation article snapshots must record when the server resolved the source");
assert.ok(
  citationRoute.indexOf("let existingCitationNode") < citationRoute.indexOf('if (!article) return res.status(404)'),
  "citation retries must resolve the durable capture before requiring a live source article",
);
assert.match(citationRoute, /if \(existingCitationNode\)[\s\S]*?created: false/);
assert.match(citationRoute, /kind = 'citation' AND ref_id = \$3/, "captureId must be the idempotency identity");
assert.match(citationRoute, /const citationMatchesRequest[\s\S]*?storedSelection\.exact === selection\.exact/, "capture retries must compare the durable article and quote fingerprint");
assert.match(citationRoute, /const stableArticleIdentity = citationArticleIdentity[\s\S]*?requestedStableIdentity !== stableArticleIdentity[\s\S]*?CITATION_ARTICLE_IDENTITY_MISMATCH/, "the server must recompute stable article identity instead of trusting the browser");
assert.match(citationRoute, /if \(existingCitationNode && !citationMatchesRequest\(existingCitationNode\)\)[\s\S]*?CITATION_CAPTURE_ID_REUSED/, "an early citation replay must reject captureId reuse with different content");
assert.match(citationRoute, /if \(!citationMatchesRequest\(existing\)\)[\s\S]*?CITATION_CAPTURE_ID_REUSED/, "a concurrent citation replay must reject captureId reuse inside the locked insertion transaction");
assert.match(citationRoute, /ON CONFLICT DO NOTHING/);
assert.match(citationRoute, /created,/, "idempotent retries must tell clients whether a new node was created");
assert.match(citationRoute, /targetAgentNodeId/);
assert.match(citationRoute, /INSERT INTO write_canvas_edges[\s\S]*?'context'/, "add-and-connect must create an explicit context edge");
assert.doesNotMatch(citationRoute, /INSERT INTO (?:saved_articles|saved_cards)|extractCardsWithAI|buildCardsFromArticleContent/, "capturing a citation must never save or atomize the article");

// Podcast episode metadata follows the flat shape emitted by App.tsx. Legacy
// nested records remain readable, but transcript data is outside this release.
assert.match(nodeCreateRoute, /episode\.sourceUrl/, "podcast nodes must use the flat sourceUrl metadata field");
assert.doesNotMatch(contextResolver, /episode\.transcript/, "podcast transcript data must not enter Agent context");

// Cloning is one tenant-scoped transaction. The latest multipart document is
// validated, every persisted relation is remapped, and quotas are rechecked.
assert.match(cloneRoute, /client\.query\("BEGIN"\)/);
assert.doesNotMatch(cloneRoute, /REPEATABLE READ/, "the User lock must be acquired from a current snapshot before quota checks");
assert.match(cloneRoute, /lockCanvasUser\(client, req\.session\.userId\)/);
assert.match(cloneRoute, /WHERE id = \$1 AND user_id = \$2[\s\S]*?FOR (?:SHARE|UPDATE)/, "the source project must be locked through the authenticated tenant");
assert.match(cloneRoute, /WRITE_CANVAS_MAX_PROJECTS_PER_USER/);
assert.match(cloneRoute, /WRITE_CANVAS_MAX_NODES_PER_PROJECT/);
assert.match(cloneRoute, /getCanvasStoredBytes\(client, req\.session\.userId\)/);
assert.match(cloneRoute, /canvasUserStorageMaxBytes/);
assert.match(cloneRoute, /validateCanvasDocumentSnapshotInput\(/);
assert.match(cloneRoute, /documentSchemaVersion[\s\S]*?schemaVersion/);
assert.match(documentRoute, /embeddedSchemaVersion !== requestedSchemaVersion[\s\S]*?CANVAS_SCHEMA_VERSION_MISMATCH/, "document metadata cannot contradict the uploaded tldraw schema");
assert.match(cloneRoute, /INSERT INTO write_canvas_projects/);
assert.match(cloneRoute, /INSERT INTO write_canvas_assets/);
assert.match(cloneRoute, /INSERT INTO write_agent_instances/);
assert.match(cloneRoute, /INSERT INTO write_agent_threads/);
assert.match(cloneRoute, /INSERT INTO write_agent_messages/);
assert.doesNotMatch(cloneRoute, /INSERT INTO write_canvas_agent_messages/, "legacy messages must not be duplicated after migration into the shared thread");
assert.match(cloneRoute, /FROM write_canvas_agent_messages/, "pre-thread legacy Agents must still migrate their retained history");
assert.match(cloneRoute, /INSERT INTO write_canvas_nodes/);
assert.match(cloneRoute, /INSERT INTO write_canvas_edges/);
assert.match(cloneRoute, /assetIdMap/);
assert.match(cloneRoute, /agentIdMap/);
assert.match(cloneRoute, /threadIdMap/);
assert.match(cloneRoute, /nodeIdMap/);
assert.match(cloneRoute, /remapCanvasCloneMetadata/);
assert.match(cloneMetadataRemapper, /"sourceAgentId"/, "cloned provenance must point at the cloned Agent");
assert.match(cloneRoute, /node\.kind === "agent" && clonedAgentId \? String\(clonedAgentId\) : node\.ref_id/, "Agent node ref_id must match its cloned Agent id");
assert.match(cloneRoute, /messageIdsByAgent/);
assert.match(cloneRoute, /__atomflowCloneSourceAgentId/);
assert.match(cloneRoute, /__atomflowCloneSourceMessageId/);
assert.match(
  cloneRoute,
  /JSON\.stringify\(\{[\s\S]*?\.\.\.sourceState,[\s\S]*?__atomflowCloneSourceAgentId: Number\(agent\.id\),[\s\S]*?canvasAgentId: Number\(agent\.id\)/,
  "thread state must retain the source Agent identity until message pointers are remapped",
);
assert.match(
  cloneRoute,
  /node\.agent_id \?\? \(node\.kind === "agent" \? node\.ref_id : null\)/,
  "legacy Agent nodes must remap an Agent id stored only in ref_id",
);
assert.match(cloneMetadataRemapper, /\["messageId", "assistantMessageId"\]/, "message pointers must be remapped into cloned threads");
assert.match(cloneMetadataRemapper, /field === "resultKey"[\s\S]*?\^message:\(\\d\+\)\$[\s\S]*?`message:\$\{replacement\}`/, "cloned result idempotency keys must follow remapped assistant message ids");
assert.match(cloneRoute, /jsonb_to_recordset\(\$1::jsonb\)/, "cloned metadata must be rewritten in bounded bulk updates");
assert.match(server, /WRITE_CANVAS_CLONE_MAX_ROWS\s*=\s*10_000/);
assert.match(server, /WRITE_CANVAS_CLONE_MAX_MESSAGE_BYTES\s*=\s*16 \* 1024 \* 1024/);
assert.match(server, /WRITE_CANVAS_CLONE_MAX_METADATA_BYTES\s*=\s*8 \* 1024 \* 1024/);
assert.match(server, /WRITE_CANVAS_CLONE_METADATA_BATCH_SIZE\s*=\s*250/);
assert.match(cloneRoute, /clonedRowCount > WRITE_CANVAS_CLONE_MAX_ROWS/);
assert.match(cloneRoute, /clonedMessageBytes > WRITE_CANVAS_CLONE_MAX_MESSAGE_BYTES/);
assert.match(cloneRoute, /clonedMetadataBytes > WRITE_CANVAS_CLONE_MAX_METADATA_BYTES/);
assert.match(cloneRoute, /offset \+= WRITE_CANVAS_CLONE_METADATA_BATCH_SIZE/);
assert.match(cloneRoute, /slice\(offset, offset \+ WRITE_CANVAS_CLONE_METADATA_BATCH_SIZE\)/);
assert.match(cloneRoute, /WRITE_CANVAS_DOCUMENT_MAX_RECORDS \+ 1[\s\S]*?项目上下文连线数量超过克隆上限/);
assert.match(cloneRoute, /thread_type = 'canvas'/, "only canvas threads can be cloned into canvas Agents");
assert.match(cloneRoute, /WHERE template\.id = ai\.template_id AND template\.user_id = ai\.user_id/, "template references must remain tenant scoped");
assert.match(cloneRoute, /remapClonedCanvasDocumentSnapshot/);
assert.match(cloneRoute, /localBusinessLayouts[\s\S]*?nodeIdMap\.get\(layout\.nodeId\)[\s\S]*?UPDATE write_canvas_nodes AS node/, "conflict cloning must apply local canonical geometry only to cloned node ids");
assert.match(cloneRoute, /viewportInput\.viewport \|\| sourceProject\.viewport/, "conflict cloning must preserve the local camera without mutating the source project");
assert.match(cloneRoute, /await client\.query\("COMMIT"\)/);
assert.match(cloneRoute, /RETURNING id, name, viewport, tldraw_snapshot AS "documentSnapshot"/);
assert.match(cloneRoute, /res\.json\(\{ project: clonedProject \}\)/);
assert.doesNotMatch(cloneRoute, /await fetchCanvasProjectDetail[\s\S]*?COMMIT/, "a committed clone response must not depend on a later mutating detail load");

// Canvas conversation memory is user-instruction-only. Assistant/tool output
// remains available to the UI, but cannot survive a disconnected context edge.
assert.match(server, /const summarizeCanvasUserInstructions[\s\S]*?filter\(message => message\.role === ["']user["']\)/);
assert.match(server, /const getRecentCanvasUserInstructions[\s\S]*?role = 'user'/);
assert.match(server, /const getRecentCanvasUserInstructions[\s\S]*?beforeMessageId\?: number[\s\S]*?id < \$3/, "the current Canvas instruction must not be included in its own history summary");
assert.match(openAiRuntime, /const isCanvasRun = input\.threadType === "canvas"/);
assert.match(
  openAiRuntime,
  /WHERE id = \$1 AND user_id = \$2 AND thread_type = \$3[\s\S]*?expectedThreadType/,
  "a supplied thread id must match the runtime surface type",
);
assert.match(openAiRuntime, /isCanvasRun[\s\S]*?getRecentCanvasUserInstructions/);
assert.match(openAiRuntime, /RETURNING id[\s\S]*?currentUserMessageId[\s\S]*?meta->>'canvasRunRequestKey'[\s\S]*?getRecentCanvasUserInstructions\(pool, normalizedThreadId, 10, currentUserMessageId\)/, "new and idempotently replayed requests must exclude their own durable user message from prior context");
assert.match(openAiRuntime, /summary:\s*summarizeCanvasUserInstructions\(previousMessages\)/);
assert.match(openAiRuntime, /activatedNodeIds:\s*isCanvasRun[\s\S]*?input\.userState\.activatedNodeIds/);
assert.match(openAiRuntime, /activationSummary:\s*isCanvasRun[\s\S]*?input\.userState\.activationSummary/);
assert.match(
  openAiRuntime,
  /selectedStyleSkillId:\s*isCanvasRun\s*\?[\s\S]*?input\.userState\.selectedStyleSkillId\s*:/,
  "canvas runs must not revive a removed style from stale thread state",
);
assert.match(openAiRuntime, /isCanvasRun[\s\S]*?summarizeCanvasUserInstructions\(finalMessages/);
assert.match(openAiRuntime, /getRecentThreadMessages\(pool, normalizedThreadId, 14\)/, "ordinary writing threads must retain their existing history behavior");
assert.match(openAiRuntime, /summarizeAgentMessages\(/, "ordinary writing threads must retain assistant/tool summaries");
assert.match(server, /const resolveWriteAgentSkillsFromAvailable[\s\S]*?primaryStyleKey[\s\S]*?result\.push\(primaryStyle\)[\s\S]*?selected\.forEach/, "the declared primary style must precede auxiliary styles in the effective Skill list");
assert.match(server, /const selectPrimaryWriteStyleSkill[\s\S]*?String\(skill\.id\) === primaryKey[\s\S]*?return skills\.find\(skill => skill\.type === "style"\)/);
assert.equal((server.match(/selectPrimaryWriteStyleSkill\(agentSkills,/g) || []).length, 2, "both writing runtimes must honor the explicit primary style");
assert.match(activeCanvasAgentRunGuard, /FROM write_canvas_agent_run_requests[\s\S]*?status = 'running'[\s\S]*?lease_expires_at > NOW\(\)[\s\S]*?UNION ALL[\s\S]*?FROM write_canvas_agent_execution_leases[\s\S]*?lease_expires_at > NOW\(\)/, "destructive routes must share one database-backed guard for create-article and ordinary chat leases");
assert.match(activeCanvasAgentRunGuard, /active_run\.project_id = \$2[\s\S]*?active_run\.agent_id = \$3/, "the unified active-run guard must preserve project and Agent scoping");
assert.match(projectDeleteRoute, /FOR UPDATE[\s\S]*?hasActiveCanvasAgentRun\(client, req\.session\.userId, \{ projectId \}\)[\s\S]*?CANVAS_AGENT_RUN_ACTIVE[\s\S]*?DELETE FROM write_canvas_projects/, "a project cannot cascade-delete an active cross-tab Agent run");
assert.match(nodeDeleteRoute, /FROM write_agent_instances[\s\S]*?FOR UPDATE[\s\S]*?hasActiveCanvasAgentRun\(client, req\.session\.userId, \{ agentId: Number\(agent\.id\) \}\)[\s\S]*?CANVAS_AGENT_RUN_ACTIVE[\s\S]*?DELETE FROM write_canvas_nodes/, "an Agent node cannot be deleted while either kind of durable generation lease is active");
assert.match(server, /type CanvasContextItem = \{[\s\S]*?nodeId: number[\s\S]*?sourceUrl\?: string[\s\S]*?originalQuote\?: string[\s\S]*?captureId\?: string[\s\S]*?citationPrefix\?: string[\s\S]*?citationSuffix\?: string/, "authorized context items must carry durable provenance alongside model text");
assert.match(contextResolver, /kind === "citation"[\s\S]*?originalQuote: exact \|\| undefined[\s\S]*?captureId:[\s\S]*?citationPrefix:[\s\S]*?citationSuffix:/, "citation authorization must preserve its exact quote and stable capture identity");
assert.match(contextResolver, /kind === "saved_article"[\s\S]*?sourceUrl: article\.url[\s\S]*?savedArticleId: Number\(article\.id\)/, "saved article authorization must retain its original URL");
assert.match(contextResolver, /kind === "podcast_episode"[\s\S]*?sourceUrl: episodeSourceUrl[\s\S]*?articleId:[\s\S]*?savedArticleId:/, "podcast authorization must retain episode provenance");
for (const provenanceField of ["sourceUrl", "sourceContext", "originalQuote", "canvasNodeId", "captureId", "citationPrefix", "citationSuffix"]) {
  assert.match(canvasContextCardMapper, new RegExp(`${provenanceField}:`), `synthetic writing cards must retain ${provenanceField}`);
}
assert.match(server, /const buildNoteActivatedNodes[\s\S]*?canvasNodeId: card\.canvasNodeId[\s\S]*?captureId: card\.captureId/);
assert.match(server, /const buildSourceArticlesFromCards[\s\S]*?capture_\$\{card\.captureId\}[\s\S]*?exact: card\.originalQuote[\s\S]*?prefix: card\.citationPrefix[\s\S]*?suffix: card\.citationSuffix/, "generated Note metadata must retain citation-level traceability");
assert.match(server, /const buildAgentSources[\s\S]*?canvasNodeId: card\.canvasNodeId[\s\S]*?captureId: card\.captureId[\s\S]*?quote: card\.originalQuote[\s\S]*?sourceUrl: card\.sourceUrl/, "final SSE sources must keep a route back to the authorized canvas node and original URL");

// Only canonical business edges grant context. A normal tldraw arrow remains
// in the document snapshot and is ignored by the authorization reconciler.
assert.match(canvas, /const edgeId = canonicalEdgeIdFromShape\(shape\)[\s\S]*?if \(!edgeId\) continue/, "copied canonical metadata is insufficient without the deterministic edge shape id");
assert.match(canvas, /performBusinessFetch\(`\/api\/write\/canvas\/edges\/\$\{edge\.id\}`,[\s\S]*?method: 'PUT'/, "canonical arrows must rebind through one tracked atomic server operation");
assert.match(edgeRoute, /source(?:\?\.|\.)kind === "agent"/, "Agent nodes cannot be context sources");
assert.match(edgeRoute, /target(?:\?\.|\.)kind !== "agent"/, "context edges must target Agent nodes");
assert.match(edgeRoute, /VALUES \(\$1, \$2, \$3, \$4, 'context'\)/);
assert.match(edgeRoute, /BEGIN[\s\S]*?FOR UPDATE[\s\S]*?UPDATE write_canvas_edges[\s\S]*?COMMIT/, "edge reassignment must be tenant-scoped and atomic");
assert.match(
  edgeUpdateRoute,
  /BEGIN[\s\S]*?lockCanvasUser[\s\S]*?FROM write_canvas_projects[\s\S]*?ORDER BY id ASC[\s\S]*?FROM write_canvas_edges[\s\S]*?UPDATE write_canvas_edges[\s\S]*?COMMIT/,
  "edge reassignment must lock user, project, sorted nodes, then edge rows",
);
assert.match(contextResolver, /FROM write_canvas_edges e/);
assert.match(contextResolver, /e\.target_node_id = \$3 AND e\.relation = 'context'/);
assert.doesNotMatch(contextResolver, /tldraw|document_snapshot|type = 'arrow'/, "native tldraw arrows must not authorize AI context");

// Full-library recall is candidate-only. Confirmation materializes the card on
// the canvas and connects it; only the next run can resolve it from edges.
assert.match(canvasAgentRoute, /resolveCanvasContextItems\(pool, userId/);
assert.match(canvasAgentRoute, /runOpenAIWriteAgentRuntime\(pool/);
assert.match(canvasAgentRoute, /requiresConfirmation:\s*true/);
assert.match(canvasAgentRoute, /confirmationEndpoint:/);
assert.doesNotMatch(canvasAgentRoute, /req\.body\?\.(?:confirmedGlobalRecallCardIds|confirmedGlobalRecallIds)/, "chat input must not directly authorize full-library candidates");
assert.match(recallConfirmationRoute, /INSERT INTO write_canvas_nodes[\s\S]*?'atom_card'/);
assert.match(recallConfirmationRoute, /INSERT INTO write_canvas_edges[\s\S]*?'context'/);
assert.match(recallConfirmationRoute, /usableOnNextGeneration:\s*true/);
assert.match(canvasAgentValidation, /req\.body\?\.action === "create_article"/);
assert.match(canvasAgentValidation, /requestId is required for create_article/);
assert.match(canvasAgentValidation, /getCanvasAgentNode\(pool, userId, agentId\)/);
assert.match(canvasAgentExecutionValidation, /isAllowedCanvasAgentModel\(prepared\.agentRow\.model\)/);
assert.doesNotMatch(canvasAgentValidation, /reserveDailyAiBudget/, "invalid messages, Agents and models must be rejected before daily budget use");
assert.match(canvasAgentContextValidation, /resolveCanvasContextItems[\s\S]*?canvasContextsToWritingCards\(contexts\)[\s\S]*?CANVAS_CONTEXT_REQUIRED/, "a create-article request without usable connected material must fail before budget reservation");
assert.match(canvasAgentContextValidation, /creation_key = \$2[\s\S]*?if \(durableNoteExists\) return next\(\)/, "durable Note recovery must remain possible after its original context is removed");
assert.match(canvasAgentReplay, /status === "completed"[\s\S]*?sendCanvasRunFinal/);
assert.match(canvasAgentReplay, /existing\.status === "running" && existing\.lease_active\)[\s\S]*?sendCanvasRunRetryable/, "an active owner must win even after its Note becomes durable");
assert.doesNotMatch(canvasAgentReplay, /existing\.status === "running" && existing\.lease_active && !?existing\.note_exists/, "Note existence must never let a concurrent replay bypass an active finalizer");
assert.match(canvasAgentReplay, /!existing\.note_exists[\s\S]*?attempt_count[\s\S]*?WRITE_CANVAS_AGENT_RUN_MAX_ATTEMPTS[\s\S]*?sendCanvasRunAttemptsExhausted/, "an exhausted request without a durable Note must fail before claiming concurrency or budget");
assert.match(canvasAgentClaim, /ON CONFLICT \(user_id, agent_id, request_id\) DO NOTHING/);
assert.match(canvasAgentClaim, /lockCanvasUser\(client, prepared\.userId\)[\s\S]*?FROM write_agent_instances[\s\S]*?FOR UPDATE[\s\S]*?hasActiveCanvasAgentRun/, "cross-replica claims must share the deletion and ordinary-chat lock order");
assert.match(canvasAgentClaim, /FROM write_canvas_agent_run_requests[\s\S]*?FOR UPDATE/, "cross-replica retries must serialize on the durable run request");
assert.doesNotMatch(canvasAgentClaim, /attempt_count = attempt_count \+ 1/, "claiming or taking over a request must not consume a provider attempt");
assert.match(canvasAgentPaidRetryClaim, /budget_reserved_at = CASE[\s\S]*?WHEN provider_started_at IS NULL THEN budget_reserved_at[\s\S]*?ELSE NULL[\s\S]*?provider_started_at = NULL/, "a retry must reuse pre-provider budget but clear the marker after a real provider attempt");
assert.match(canvasAgentPaidRetryClaim, /attempt_count < \$6[\s\S]*?WRITE_CANVAS_AGENT_RUN_MAX_ATTEMPTS/, "the locked takeover update must enforce the attempt ceiling atomically");
assert.doesNotMatch(canvasAgentNoteRecoveryClaim, /attempt_count = attempt_count \+ 1|budget_reserved_at = NULL|provider_started_at = NOW/, "repairing an already-created Note must not become or charge a new AI attempt");
assert.ok(
  canvasAgentClaim.indexOf("row.status === \"running\" && row.lease_active") < canvasAgentClaim.indexOf("} else if (noteExists)"),
  "an active finalizer must return in-progress before expired-lease Note recovery can claim ownership",
);
assert.match(canvasAgentClaim, /type: "attempts_exhausted"[\s\S]*?sendCanvasRunAttemptsExhausted/, "the lock-protected ceiling must return a terminal response");
assert.match(server, /code: "CANVAS_RUN_ATTEMPTS_EXHAUSTED"[\s\S]*?retryable: false/, "attempt exhaustion must tell clients to use a new requestId instead of retrying forever");
assert.match(canvasAgentRecovery, /FROM notes[\s\S]*?creation_key = \$2/);
assert.match(canvasAgentRecovery, /try \{[\s\S]*?FROM notes[\s\S]*?catch \(error\)[\s\S]*?failCanvasRunRequest\([\s\S]*?userId: prepared\.userId[\s\S]*?agentId: prepared\.agentId[\s\S]*?requestId: prepared\.requestId[\s\S]*?runId/, "the initial Note lookup must release only its exact durable claim when recovery cannot start");
assert.match(canvasAgentRecovery, /ensureCanvasGeneratedNoteNode/, "a Note committed before a crash must be rematerialized without rerunning the model");
assert.match(canvasAgentRecovery, /completeCanvasRunRequest/, "Note recovery must become a replayable completed run");
assert.doesNotMatch(canvasAgentRecovery, /runOpenAIWriteAgentRuntime/, "Note recovery must never invoke the model again");
assert.match(canvasAgentExecutionLeaseAcquire, /BEGIN[\s\S]*?lockCanvasUser[\s\S]*?FROM write_agent_instances[\s\S]*?FOR UPDATE[\s\S]*?DELETE FROM write_canvas_agent_execution_leases[\s\S]*?hasActiveCanvasAgentRun[\s\S]*?INSERT INTO write_canvas_agent_execution_leases[\s\S]*?COMMIT/, "ordinary chat leases must be acquired transactionally under the global User→Agent lock order");
assert.match(canvasAgentExecutionLeaseMiddleware, /if \(prepared\.isCreateArticle\) return next\(\)[\s\S]*?acquireCanvasAgentExecutionLease[\s\S]*?res\.locals\.canvasAgentRunId = runId[\s\S]*?releaseCanvasAgentExecutionLease/, "ordinary chat must get a non-idempotency execution lease and a scoped release callback");
assert.match(canvasAgentLeaseRenewal, /UPDATE write_canvas_agent_execution_leases[\s\S]*?user_id = \$1 AND agent_id = \$2 AND run_id = \$3[\s\S]*?lease_expires_at > NOW\(\)[\s\S]*?UPDATE write_canvas_agent_run_requests[\s\S]*?request_id = \$3 AND run_id = \$4[\s\S]*?status = 'running'[\s\S]*?lease_expires_at > NOW\(\)/, "every provider boundary must renew the exact still-owned ordinary or create-article lease without resurrecting an expired owner");
assert.match(canvasAgentProviderAttempt, /attempt_count = attempt_count \+ 1[\s\S]*?provider_started_at = NOW\(\)[\s\S]*?budget_reserved_at IS NOT NULL[\s\S]*?provider_started_at IS NULL[\s\S]*?attempt_count < \$5/, "only the provider-start transition may atomically consume a create-article attempt");
assert.match(server, /const getWriteAgentOutputReservation[\s\S]*?perTurn \* Math\.max\(1, Math\.round\(modelTurnLimit\)\)/);
assert.match(canvasAgentBudget, /!prepared\.isCreateArticle[\s\S]*?getWriteAgentOutputReservation\(prepared\.agentRow\.max_tokens, 6, 260\)/, "ordinary canvas Agent runs must reserve the coordinator's full turn ceiling plus router output");
assert.match(canvasAgentBudget, /getWriteAgentOutputReservation\(prepared\.agentRow\.max_tokens, 2\)[\s\S]*?client/, "create_article must reserve both outline and draft output ceilings atomically");
assert.match(canvasAgentBudget, /run\.budget_reserved_at[\s\S]*?outcome = "ready"/, "a retry that never reached the provider must reuse its existing budget reservation");
assert.doesNotMatch(canvasAgentBudget, /attempt_count = attempt_count \+ 1/, "budget rejection or middleware failure must never consume a provider attempt");
assert.match(canvasAgentBudget, /status = 'failed', lease_expires_at = NULL,[\s\S]*?daily AI budget exhausted/, "budget rejection must durably release create-article ownership without incrementing attempts");
assert.match(canvasAgentBudget, /let client: pg\.PoolClient \| null = null[\s\S]*?try \{[\s\S]*?client = await pool\.connect\(\)[\s\S]*?catch \(error\)[\s\S]*?failCanvasRunRequest\([\s\S]*?requestId: prepared\.requestId[\s\S]*?runId/, "pool acquisition failures must release only the exact create-article claim");
assert.match(canvasAgentBudget, /catch \(error\)[\s\S]*?ROLLBACK[\s\S]*?failCanvasRunRequest\([\s\S]*?requestId: prepared\.requestId[\s\S]*?runId[\s\S]*?throw error/, "a budget transaction error must release only its exact durable create-article claim before propagating");
assert.match(openAiRuntime, /const runtimeModelSettings = \{[\s\S]*?maxTokens:[\s\S]*?modelSettings: runtimeModelSettings/, "every SDK Agent call must receive the same server-capped per-turn output ceiling used by quota reservation");
assert.match(openAiRuntime, /await withStep\("respond"[\s\S]*?const completedTrace = \[\.\.\.trace\][\s\S]*?jsonb_set\(COALESCE\(meta, '\{\}'::jsonb\), '\{graphTrace\}'[\s\S]*?toolPayload = \{ \.\.\.toolPayload, graphTrace: completedTrace \}/, "persisted assistant messages and live SSE must both expose the complete trace through respond");
assert.match(server, /const writingAgentDailyBudgetMiddleware[\s\S]*?getWriteAgentOutputReservation\(getCanvasAgentMaxOutputTokens\(\), 6, 260\)/);
assert.match(server, /app\.post\("\/api\/write\/agent\/chat\/stream"[\s\S]*?writingAgentDailyBudgetMiddleware[\s\S]*?app\.post\("\/api\/write\/agent\/chat"[\s\S]*?writingAgentDailyBudgetMiddleware/, "ordinary full writing runtimes must reserve their multi-turn ceiling without overcharging unrelated one-call AI routes");
assert.match(
  canvasAgentRoute,
  /canvasAgentChatValidationMiddleware, canvasCreateArticleReplayMiddleware, canvasAgentExecutionValidationMiddleware, canvasAgentContextValidationMiddleware, paidConcurrencyMiddleware, canvasAgentConcurrencyMiddleware, canvasCreateArticleClaimMiddleware, canvasCreateArticleNoteRecoveryMiddleware, canvasAgentExecutionLeaseMiddleware, canvasAgentDailyBudgetMiddleware/,
  "request validation and replay must precede model/context validation, then durable ownership must be established before charging a canvas generation",
);
assert.doesNotMatch(canvasAgentRoute.split("asyncHandler", 1)[0], /dailyPaidOperationBudgetMiddleware/, "canvas chat must use its idempotency-aware budget middleware");
assert.match(canvasAgentRoute.split("asyncHandler", 1)[0], /canvasAgentExecutionValidationMiddleware, canvasAgentContextValidationMiddleware[\s\S]*?canvasCreateArticleClaimMiddleware[\s\S]*?canvasAgentExecutionLeaseMiddleware[\s\S]*?canvasAgentDailyBudgetMiddleware/, "context validation must precede durable claim/lease acquisition and paid budget use");
assert.match(threadDeleteRoute, /FROM write_agent_threads[\s\S]*?FOR UPDATE[\s\S]*?FROM write_agent_instances[\s\S]*?FOR UPDATE[\s\S]*?hasActiveCanvasAgentRun[\s\S]*?CANVAS_AGENT_RUN_ACTIVE[\s\S]*?CANVAS_THREAD_MANAGED[\s\S]*?DELETE FROM write_agent_threads/, "shared thread deletion must not orphan a bound canvas Agent or its active run");
assert.match(accountDeleteRoute, /BEGIN[\s\S]*?lockCanvasUser\(client, userId\)[\s\S]*?hasActiveCanvasAgentRun\(client, userId, \{\}\)[\s\S]*?CANVAS_AGENT_RUN_ACTIVE[\s\S]*?DELETE FROM users/, "account deletion must serialize with both lease acquisitions and reject while any Canvas provider run is active");
assert.match(canvasAgentRoute, /requestKey: isCreateArticle \? creationKey : undefined/);
assert.match(openAiRuntime, /canvasRunRequestKey/);
assert.match(openAiRuntime, /ON CONFLICT DO NOTHING/, "a failed retry must not duplicate the durable user message");
assert.match(canvasAgentRoute, /requestAbortController\.signal\.throwIfAborted\(\)/);
assert.match(canvasAgentRoute, /signal: requestAbortController\.signal/);
assert.match(canvasAgentRoute, /req\.once\("aborted", abortDisconnectedRequest\)[\s\S]*?res\.once\("close", abortDisconnectedRequest\)[\s\S]*?req\.aborted \|\| res\.destroyed/, "disconnects that occur during lease or budget middleware must abort before provider use");
assert.match(canvasAgentRoute, /onBeforeProvider: isCreateArticle[\s\S]*?beginCanvasCreateArticleProviderAttempt/, "only create_article runs must install the durable provider-attempt hook");
assert.match(canvasAgentRoute, /onProviderBoundary: isCreateArticle[\s\S]*?renewCanvasCreateArticleRunLease[\s\S]*?renewCanvasAgentExecutionLease/, "both run kinds must renew exact ownership at every provider boundary");
assert.match(server, /const canvasAgentRunDeadlineMs = Math\.max\([\s\S]*?canvasAgentRunLeaseMs - Math\.min\(/, "the Canvas runtime deadline must remain strictly shorter than its durable lease");
assert.match(canvasAgentRoute, /canvasAgentRunDeadlineAt[\s\S]*?runDeadlineRemainingMs[\s\S]*?Canvas Agent run deadline exceeded[\s\S]*?runDeadlineTimer\?\.unref\(\)[\s\S]*?finally[\s\S]*?clearTimeout\(runDeadlineTimer\)/, "the whole Canvas runtime must abort before its durable lease can expire and always clear its timer");
assert.match(openAiRuntime, /onBeforeProvider\?: \(\) => void \| Promise<void>/);
assert.match(openAiRuntime, /onProviderBoundary\?: \(\) => void \| Promise<void>/);
assert.match(openAiRuntime, /let providerStartPromise: Promise<void> \| null = null[\s\S]*?beforeProviderInvocation[\s\S]*?await input\.onProviderBoundary\?\.\(\)[\s\S]*?providerStartPromise = Promise\.resolve\(input\.onBeforeProvider\?\.\(\)\)/, "each provider boundary must renew ownership while the durable attempt transition remains once per logical run");
assert.equal((openAiRuntime.match(/await beforeProviderInvocation\(\);/g) || []).length, 4, "every potential provider entry point must pass through the one-shot attempt hook");
assert.match(openAiRuntime, /beforeProviderInvocation\(\)[\s\S]*?requestAiChatCompletion\(/, "the model intent router must not bypass durable attempt accounting");
assert.equal((openAiRuntime.match(/beforeProviderInvocation\(\)[\s\S]{0,1800}?runner\.run\(/g) || []).length, 3, "outline, draft, and coordinator provider calls must all use the durable attempt hook");
assert.match(canvasAgentRoute, /updateCanvasAgentExecutionLeaseThread[\s\S]*?runOpenAIWriteAgentRuntime/, "ordinary chat must bind its durable lease to the Canvas thread before provider use");
assert.match(canvasAgentRoute, /releaseCanvasAgentExecutionLease[\s\S]*?send\("final"[\s\S]*?catch \(error\)[\s\S]*?releaseCanvasAgentExecutionLease[\s\S]*?finally[\s\S]*?releaseCanvasAgentExecutionLease/, "ordinary chat must release its durable lease after success, failure, and disconnect cleanup");
assert.match(canvasAgentRoute, /ensureCanvasGeneratedNoteNode\(/, "create_article must materialize its idempotent Note node on the canvas");
assert.match(canvasAgentRoute, /noteNode,/, "the final SSE event must expose the resulting Note node");
assert.match(canvasAgentRoute, /completeCanvasRunRequest\([\s\S]*?send\("final", finalPayload\)/, "completion must be durable before the final SSE event is emitted");
assert.match(canvasAgentRoute, /failCanvasRunRequest/, "failed or disconnected requests must release their durable lease for retry");
assert.match(packageJson, /tests\/canvas-create-article-requests\.test\.ts/, "the create-article request regression suite must remain in the default npm test command");
assert.match(canvasSaveResultRoute, /meta->>'resultKey'/, "saving one Agent response must be durably idempotent");
assert.match(
  canvasSaveResultRoute,
  /if \(!content\) \{[\s\S]*?ROLLBACK[\s\S]*?status\(409\)/,
  "a result deleted between the optimistic lookup and locked transaction must not be recreated as an empty asset",
);
assert.match(server, /creation_key\s+TEXT/);
assert.match(server, /CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_creation_key ON notes\(user_id, creation_key\) WHERE creation_key IS NOT NULL/);
assert.match(server, /ON CONFLICT \(user_id, creation_key\) WHERE creation_key IS NOT NULL/);
assert.match(openAiRuntime, /signal\?: AbortSignal/);
assert.match(openAiRuntime, /signal: input\.signal/, "the shared runtime must pass disconnect cancellation into model runs");

// generate_draft is a conversational response tool. Persisting a Note is a
// separate, explicit create_article operation in both runtime implementations.
assert.match(fallbackRuntime, /state\.isCreateArticle \|\| state\.requestedTools\.includes\("generate_draft"\)/);
assert.match(openAiRuntime, /input\.isCreateArticle \|\| requestedTools\.includes\("generate_draft"\)/);
assert.equal(
  (fallbackRuntime.match(/createAgentDraftNote/g) || []).length,
  1,
  "the fallback runtime must have exactly one guarded Note persistence path",
);
assert.equal(
  (openAiRuntime.match(/createAgentDraftNote/g) || []).length,
  1,
  "the shared OpenAI runtime must have exactly one guarded Note persistence path",
);
assert.match(
  fallbackRuntime,
  /if \(generatedDraftText\.trim\(\) && state\.isCreateArticle\) \{[\s\S]*?createAgentDraftNote/,
  "the fallback runtime may persist a generated draft only for create_article",
);
assert.match(
  openAiRuntime,
  /if \(generatedDraftText && input\.isCreateArticle\) \{[\s\S]*?createAgentDraftNote/,
  "the shared OpenAI runtime may persist a generated draft only for create_article",
);

assert.match(types, /export type WriteCanvasNodeKind/, "canvas node kind must be typed");
assert.match(types, /export interface WriteCanvasProjectDetail/, "canvas project detail must be typed");
assert.match(types, /export interface WriteAgentTemplate/, "agent templates must be typed");
assert.match(types, /export interface WriteSkillSelection/);
assert.match(types, /export interface WriteCanvasCitationMeta/);
assert.match(types, /export interface WriteCanvasPodcastMeta/);
assert.match(types, /export interface WriteCanvasDocumentSnapshot/);
assert.match(citationMetaType, /fetchedAt: string;/, "citation metadata must type the article fetch time");
assert.match(podcastMetaType, /episodeId: string;/);
assert.match(podcastMetaType, /sourceUrl\?: string;/);
assert.match(podcastMetaType, /contextBasis: 'rss_summary';/);
assert.doesNotMatch(podcastMetaType, /episode\s*:/, "podcast metadata must remain flat");
assert.doesNotMatch(podcastMetaType, /transcript/, "podcast metadata must not advertise transcript support");

assert.match(canvas, /<Tldraw/, "magic writing canvas must render tldraw");
assert.match(canvas, /shapeUtils=\{shapeUtils\}/, "tldraw must register AtomFlow custom shapes");
assert.match(canvas, /CanvasAddDrawer/, "canvas must use an on-demand add-node drawer");
assert.match(canvas, /CanvasInspector/, "canvas must use an on-demand node inspector");
assert.match(canvas, /CanvasContextRail/, "canvas must provide the persistent contextual right rail");
assert.match(canvasUi, /aria-label="添加节点"/, "canvas must expose a floating add-node control");
assert.match(canvas, /getViewportPageBounds/, "new nodes must be placed from the visible canvas viewport");
assert.match(canvas, /getArrowBindings/, "canvas edges must use tldraw arrow bindings");
assert.match(canvas, /setTimeout\([\s\S]*?800\)/, "native document changes must auto-save after an 800ms debounce");
assert.match(canvas, /visibilityState === 'hidden'/, "hidden pages must flush pending document changes");
assert.match(canvas, /载入最新版本/);
assert.match(canvas, /另存为新项目/);
assert.match(canvasUi, /保存到画布/, "assistant outputs must be manually saved to canvas");

if (process.env.RUN_REAL_CANVAS_TESTS === "true") {
  const base = process.env.API_BASE || "http://localhost:1000";
  const email = process.env.TEST_EMAIL?.trim();
  const password = process.env.TEST_PASSWORD;
  assert.ok(email && password, "set TEST_EMAIL and TEST_PASSWORD for real canvas tests");
  let cookie = "";

  const request = async (method: string, route: string, body?: unknown) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    return { status: response.status, json };
  };
  const record = (value: unknown) => value && typeof value === "object" ? value as Record<string, unknown> : {};

  const unauthorizedList = await request("GET", "/api/write/canvas/projects");
  assert.equal(unauthorizedList.status, 401, "unauthenticated project reads should return 401");
  const unauthorizedDelete = await request("DELETE", "/api/write/canvas/nodes/999999999");
  assert.equal(unauthorizedDelete.status, 401, "unauthenticated node deletes should return 401");

  const login = await request("POST", "/api/auth/login-password", { email, password });
  assert.equal(login.status, 200, "test account login should succeed");

  const createdProject = await request("POST", "/api/write/canvas/projects", { name: `Canvas integration ${Date.now()}` });
  assert.equal(createdProject.status, 200, "canvas project creation should succeed");
  const projectId = Number(record(record(createdProject.json).project).id);
  assert.ok(Number.isFinite(projectId), "created project should return an id");

  try {
    const invalidAssetReference = await request("POST", `/api/write/canvas/projects/${projectId}/nodes`, {
      kind: "agent",
      title: "Invalid asset agent",
      assetId: 999999999,
    });
    assert.equal(invalidAssetReference.status, 400, "non-asset nodes must reject assetId");

    const missingReference = await request("POST", `/api/write/canvas/projects/${projectId}/nodes`, {
      kind: "saved_article",
      title: "Missing article",
      refId: 999999999,
    });
    assert.equal(missingReference.status, 404, "reference nodes must reject resources outside the current user");

    const createdAgent = await request("POST", `/api/write/canvas/projects/${projectId}/nodes`, {
      kind: "agent",
      title: "Canvas integration agent",
      x: 500,
      y: 200,
    });
    const agentNodeId = Number(record(record(createdAgent.json).node).id);
    assert.ok(Number.isFinite(agentNodeId), "agent node creation should return an id");

    const createdText = await request("POST", `/api/write/canvas/projects/${projectId}/nodes`, {
      kind: "asset_text",
      title: "Canvas integration source",
      content: "This text must only be available while its context edge exists.",
      x: 100,
      y: 200,
    });
    const textNodeId = Number(record(record(createdText.json).node).id);
    assert.ok(Number.isFinite(textNodeId), "text node creation should return an id");

    const createdEdge = await request("POST", "/api/write/canvas/edges", {
      projectId,
      sourceNodeId: textNodeId,
      targetNodeId: agentNodeId,
    });
    assert.equal(createdEdge.status, 200, "context edge creation should succeed");

    const beforeDelete = record(await (await fetch(`${base}/api/write/canvas/projects/${projectId}`, { headers: { Cookie: cookie } })).json());
    assert.ok((beforeDelete.edges as unknown[]).some(edge => Number(record(edge).sourceNodeId) === textNodeId), "created edge should be persisted");

    const deletedNode = await request("DELETE", `/api/write/canvas/nodes/${textNodeId}`);
    assert.equal(deletedNode.status, 200, "owned node deletion should succeed");
    const afterDelete = record(await (await fetch(`${base}/api/write/canvas/projects/${projectId}`, { headers: { Cookie: cookie } })).json());
    assert.equal((afterDelete.nodes as unknown[]).some(node => Number(record(node).id) === textNodeId), false, "deleted node must not reload");
    assert.equal((afterDelete.edges as unknown[]).some(edge => Number(record(edge).sourceNodeId) === textNodeId), false, "deleting a source node must remove its context edge");

    const deletedAgent = await request("DELETE", `/api/write/canvas/nodes/${agentNodeId}`);
    assert.equal(deletedAgent.status, 200, "agent node deletion should succeed");
  } finally {
    const cleanup = await request("DELETE", `/api/write/canvas/projects/${projectId}`);
    assert.equal(cleanup.status, 200, "integration project cleanup should succeed");
  }
}

console.log("PASS: write canvas API contract");
