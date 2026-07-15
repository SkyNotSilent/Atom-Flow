import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const server = readFileSync(path.join(root, "server.ts"), "utf-8");
const types = readFileSync(path.join(root, "src", "types.ts"), "utf-8");
const canvas = readFileSync(path.join(root, "src", "pages", "MagicWritingCanvas.tsx"), "utf-8");
const addDrawerPath = path.join(root, "src", "components", "write-canvas", "CanvasAddDrawer.tsx");
const inspectorPath = path.join(root, "src", "components", "write-canvas", "CanvasInspector.tsx");
const canvasUi = [
  canvas,
  existsSync(addDrawerPath) ? readFileSync(addDrawerPath, "utf-8") : "",
  existsSync(inspectorPath) ? readFileSync(inspectorPath, "utf-8") : "",
].join("\n");
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
const genericNodeCreateRoute = routeSegment(
  'app.post("/api/write/canvas/projects/:id/nodes"',
  'app.put("/api/write/canvas/nodes/:id"',
);
const genericNodeUpdateRoute = routeSegment(
  'app.put("/api/write/canvas/nodes/:id"',
  'app.delete("/api/write/canvas/nodes/:id"',
);
const documentUpdateRoute = routeSegment(
  'app.put("/api/write/canvas/documents/:id"',
  'app.get("/api/write/canvas/documents/:id/versions"',
);
const documentCreateRoute = routeSegment(
  'app.post("/api/write/canvas/projects/:projectId/documents"',
  'app.get("/api/write/canvas/documents/:id"',
);
const documentSectionProjectRoute = routeSegment(
  'app.post("/api/write/canvas/documents/:id/sections/:sectionKey/project"',
  'app.post("/api/write/canvas/assets/upload"',
);
const agentSaveResultRoute = routeSegment(
  'app.post("/api/write/canvas/agents/:id/save-result"',
  'app.get("/api/write/agent/threads"',
);
const generatedNodesHelper = routeSegment(
  'const createCanvasGeneratedNodes =',
  'const extractCanvasFileText =',
);
const nodeDeleteRoute = routeSegment(
  'app.delete("/api/write/canvas/nodes/:id"',
  'app.post("/api/write/canvas/edges"',
);
const edgeCreateRoute = routeSegment(
  'app.post("/api/write/canvas/edges"',
  'app.post("/api/write/canvas/edges/replace"',
);
const edgeReplaceRoute = routeSegment(
  'app.post("/api/write/canvas/edges/replace"',
  'app.delete("/api/write/canvas/edges"',
);

assert.match(server, /CREATE TABLE IF NOT EXISTS write_canvas_projects/, "canvas projects table must exist");
assert.match(server, /CREATE TABLE IF NOT EXISTS write_canvas_nodes/, "canvas nodes table must exist");
assert.match(server, /CREATE TABLE IF NOT EXISTS write_canvas_edges/, "canvas edges table must exist");
assert.match(server, /CREATE TABLE IF NOT EXISTS write_agent_templates/, "agent templates table must exist");
assert.match(server, /CREATE TABLE IF NOT EXISTS write_agent_instances/, "agent instances table must exist");
assert.match(server, /CREATE TABLE IF NOT EXISTS write_canvas_assets/, "canvas assets table must exist");
assert.match(server, /CREATE TABLE IF NOT EXISTS write_canvas_agent_messages/, "canvas agent messages table must exist");
assert.match(server, /CREATE TABLE IF NOT EXISTS write_canvas_documents/, "canvas documents table must exist");
assert.match(server, /CREATE TABLE IF NOT EXISTS write_canvas_document_versions/, "canvas document version table must exist");
assert.match(server, /CREATE TABLE IF NOT EXISTS write_canvas_document_sections/, "canvas document section table must exist");
assert.match(server, /node_role/, "canvas nodes must persist semantic roles");
assert.match(server, /content_type/, "canvas nodes must persist content types");
assert.match(server, /document_id/, "canvas nodes must link documents");
assert.match(server, /CASE kind/, "existing canvas nodes must receive deterministic semantic backfills");
assert.match(server, /relation IN \('context', 'derived_from', 'generated', 'structure'\)/, "canvas edges must allow the complete relation vocabulary");
assertOrdered(
  server,
  "ALTER TABLE write_canvas_edges DROP CONSTRAINT write_canvas_edges_relation_check",
  "SET relation = 'derived_from'",
  "the legacy context-only relation constraint must be widened before relation backfills run",
);

assert.match(server, /app\.get\("\/api\/write\/canvas\/projects", requireAuth/, "project list route must require auth");
assert.match(server, /app\.post\("\/api\/write\/canvas\/projects", requireAuth/, "project create route must require auth");
assert.match(server, /app\.post\("\/api\/write\/canvas\/projects\/:id\/nodes", requireAuth/, "node create route must require auth");
assert.match(server, /app\.delete\("\/api\/write\/canvas\/nodes\/:id", requireAuth/, "node delete route must require auth");
assert.match(server, /app\.post\("\/api\/write\/canvas\/edges", requireAuth/, "edge create route must require auth");
assert.match(server, /app\.post\("\/api\/write\/canvas\/edges\/replace", requireAuth/, "edge replacement must use an authenticated atomic route");
assert.match(server, /app\.post\("\/api\/write\/canvas\/projects\/:projectId\/documents", requireAuth/, "document create route must require auth");
assert.match(server, /app\.get\("\/api\/write\/canvas\/documents\/:id", requireAuth/, "document read route must require auth");
assert.match(server, /app\.put\("\/api\/write\/canvas\/documents\/:id", requireAuth/, "document update route must require auth");
assert.match(server, /app\.get\("\/api\/write\/canvas\/documents\/:id\/versions", requireAuth/, "document version route must require auth");
assert.match(server, /app\.post\("\/api\/write\/canvas\/documents\/:id\/sections\/:sectionKey\/project", requireAuth/, "document sections must project onto the canvas through an owned route");
assert.match(server, /app\.post\("\/api\/write\/canvas\/assets\/upload", requireAuth,[^\n]*canvasAssetUpload\.single/, "asset upload route must require auth");
assert.match(server, /app\.get\("\/api\/write\/canvas\/assets\/:id\/original", requireAuth/, "original uploads must remain available through an authenticated route");
assert.match(server, /app\.post\("\/api\/write\/canvas\/agents\/:id\/chat\/stream", requireAuth/, "canvas agent stream route must require auth");
assert.match(server, /resolveCanvasContextItems\(pool, req\.session\.userId/, "agent run must resolve context from canvas edges");
assert.match(server, /const targetAcceptsContext = target\?\.kind === "agent"[\s\S]{0,180}content_type === "agent_group"/, "context edges must target Agent or Agent-group task nodes");
assert.match(server, /canvasModelSupportsImages/, "canvas agent must include hidden multimodal capability gate");

assert.match(types, /export type WriteCanvasNodeKind/, "canvas node kind must be typed");
assert.match(types, /role: 'material' \| 'insight' \| 'task' \| 'document' \| 'group'/, "canvas node semantic role must be typed");
assert.match(types, /origin: 'existing' \| 'extracted' \| 'manual' \| 'generated'/, "canvas node origin must be typed");
assert.match(types, /export interface WriteCanvasDocument/, "canvas documents must be typed");
assert.match(types, /export interface WriteCanvasProjectDetail/, "canvas project detail must be typed");
assert.match(types, /export interface WriteAgentTemplate/, "agent templates must be typed");

assert.match(server, /normalizeCanvasNodeRole/, "node role input must be allowlisted");
assert.match(server, /normalizeCanvasNodeOrigin/, "node origin input must be allowlisted");
assert.match(server, /normalizeCanvasNodeStatus/, "node status input must be allowlisted");
assert.match(genericNodeCreateRoute, /kind === "atom_card" \? String\(refId \|\| ""\)/, "atom-card references must preserve UUID identifiers");
assert.match(server, /const sourceAcceptsContext = source\?\.kind !== "agent"[\s\S]{0,180}source\?\.node_role !== "task"/, "Agent task nodes must not be accepted as context sources");
assert.match(server, /resolveCanvasDocumentContext/, "canonical document title, outline and body must resolve as AI context");
assert.match(server, /sourceNodeId[\s\S]{0,1000}'generated'/, "documents created from nodes must persist source lineage");
assert.match(server, /content_type, business_ref[\s\S]{0,800}'document_section'[\s\S]{0,1000}'structure'/, "projected document sections must remain canonical structure children");
assert.match(server, /const dataUrl = `data:\$\{req\.file\.mimetype\};base64/, "all uploaded originals must be retained even when extraction fails");
assert.match(server, /'dataUrl', CASE WHEN a\.type = 'image' THEN '\/api\/write\/canvas\/assets\/' \|\| a\.id \|\| '\/original'/, "project detail must serve image previews without embedding original base64 payloads");
assert.match(server, /extractionError \? "failed" : "ready"/, "failed extraction must be visible on the material node");
assert.match(server, /write_canvas_nodes_project_owner_fkey/, "nodes must enforce project ownership in the database");
assert.match(server, /write_canvas_edges_source_owner_fkey/, "edges must enforce source-node tenant ownership in the database");
assert.match(server, /write_canvas_documents_current_version_owner_fkey/, "document versions must enforce tenant ownership in the database");
assert.match(server, /FROM write_canvas_agent_messages WHERE user_id = \$1/, "Agent messages must be included in canvas storage accounting");
assert.match(server, /COALESCE\(meta->>'status', 'completed'\) = 'completed'/, "failed and pending Agent turns must stay out of subsequent history");
assert.match(server, /const previousMessages = \(await pool\.query\([\s\S]{0,900}assertCanvasAggregateContextWithinLimit\(contexts, message, agentRow\.system_prompt, previousMessages\)/, "Agent history must be loaded before aggregate context validation");
assert.match(server, /estimateCanvasInputTokens\(contexts, message, agentRow\.system_prompt, previousMessages\)/, "Agent history must be included in daily input-token reservation");
assert.match(server, /cancelPendingCanvasAgentMessage/, "failed Agent turns must atomically finalize their daily reservation");
assert.match(server, /meta\.providerStarted !== true[\s\S]{0,500}releaseDailyAiBudget/, "provider-dispatched turns must remain charged when persistence fails");
assert.match(server, /cancelPendingCanvasAgentMessage[\s\S]{0,1300}DELETE FROM write_canvas_agent_messages/, "failed Agent turns must remove incomplete user messages");
assert.match(server, /VALUES \(\$1, \$2, \$3, \$4, 'generated'\)[\s\S]{0,500}lockedAgent\.node_id[\s\S]{0,80}nodeId/, "manual result promotion must persist Agent-to-result lineage");
assert.match(server, /write_canvas_document_versions[\s\S]*snapshot/, "document updates must create immutable snapshots");
assert.match(server, /write_canvas_documents t WHERE user_id = \$1/, "document content must be included in export preflight");
assert.match(server, /write_canvas_document_sections t WHERE user_id = \$1/, "document sections must be included in export preflight");
assert.match(genericNodeCreateRoute, /documentId is managed by document APIs/, "generic node creation must reject documentId");
assert.doesNotMatch(genericNodeCreateRoute, /document_id/, "generic node creation must not attach documents");
assert.match(genericNodeUpdateRoute, /documentId is managed by document APIs/, "generic node updates must reject documentId");
assert.doesNotMatch(genericNodeUpdateRoute, /document_id\s*=/, "generic node updates must preserve document links");
assert.match(genericNodeUpdateRoute, /GEOMETRY_VERSION_REQUIRED/, "geometry updates must require an optimistic concurrency version");
assert.match(genericNodeUpdateRoute, /fresh\.updated_at[\s\S]{0,300}expectedUpdatedAt/, "geometry updates must compare the locked node version");
assert.match(genericNodeUpdateRoute, /NODE_VERSION_CONFLICT/, "stale geometry updates must return a machine-readable conflict");
assert.match(server, /const getCanvasDocumentUpdateAdditionalBytes =/, "document update quota must use a dedicated delta helper");
assert.match(
  server,
  /getCanvasDocumentSnapshotBytes\(nextDocument, nextSections\)[\s\S]*Math\.max\(0, getCanvasDocumentMutableBytes\(nextDocument, nextSections\) - getCanvasDocumentMutableBytes\(currentDocument, currentSections\)\)/,
  "document updates must charge a new snapshot plus only positive mutable growth",
);
assert.match(documentUpdateRoute, /const additionalBytes = getCanvasDocumentUpdateAdditionalBytes\(/, "document PUT must calculate its quota from the update delta");
assert.match(documentUpdateRoute, /current_version_id/, "document PUT must lock and compare the canonical version");
assert.match(documentUpdateRoute, /DOCUMENT_VERSION_CONFLICT/, "stale document saves must return a dedicated conflict response");
assert.match(documentUpdateRoute, /pruneCanvasDocumentVersions[\s\S]{0,500}getCanvasStoredBytes/, "document history must be pruned before evaluating the next snapshot quota");
assert.match(server, /CANVAS_DOCUMENT_MAX_VERSIONS/, "document history must have a bounded retention limit");
assert.match(server, /DELETE FROM write_canvas_document_versions[\s\S]{0,500}OFFSET \$3/, "old full-document snapshots must be removed transactionally");
assert.match(documentUpdateRoute, /storedBytes \+ additionalBytes > canvasUserStorageMaxBytes/, "document PUT must apply the delta to stored bytes");
assert.doesNotMatch(documentUpdateRoute, /storedBytes \+ getCanvasDocumentBytes\(/, "document PUT must not charge the full replacement size");
assertOrdered(nodeDeleteRoute, 'lockCanvasUser(client, req.session.userId)', 'FROM write_canvas_nodes', "node deletion must follow the global user-first lock order");
assert.match(nodeDeleteRoute, /content_type = 'document_section'[\s\S]{0,180}meta->>'documentId'/, "deleting a document node must remove projected section nodes");
assert.match(server, /const assertNoActiveCanvasAiWork =/, "destructive canvas operations must preserve active run reservation records");
assert.match(server, /assertNoActiveCanvasAiWork[\s\S]{0,900}write_canvas_agent_batches[\s\S]{0,220}status = 'running'/, "a running batch lease must block deletion through the finalization window");
assert.match(nodeDeleteRoute, /assertNoActiveCanvasAiWork/, "node deletion must be blocked while its project has active AI work");
assert.match(server, /app\.delete\("\/api\/write\/canvas\/projects\/:id"[\s\S]{0,1200}assertNoActiveCanvasAiWork/, "project deletion must be blocked while active AI work owns durable reservations");
assert.match(server, /code:\s*"CANVAS_AI_ACTIVE"/, "active-run deletion conflicts must be machine-readable");
assert.match(documentUpdateRoute, /DELETE FROM write_canvas_nodes[\s\S]{0,300}meta->>'sectionKey'/, "removing document sections must clean projected section nodes");
assert.match(edgeCreateRoute, /WRITE_CANVAS_MAX_EDGES_PER_PROJECT/, "edge creation must enforce a per-project cardinality limit");
assert.match(edgeCreateRoute, /relation === "structure"/, "the authenticated edge route must support user-created structure branches");
assert.match(edgeCreateRoute, /WITH RECURSIVE descendants/, "structure edges must reject hierarchy cycles");
assert.match(server, /const assertCanvasEdgeCapacity =/, "all edge-producing business paths must share one project cardinality guard");
assert.match(server, /WRITE_CANVAS_AGENT_BATCH_STALE_MS = Math\.max\([\s\S]{0,180}AI_REQUEST_TIMEOUT_MS \+ 60_000/, "batch takeover must not precede the provider timeout window");
assert.match(generatedNodesHelper, /assertCanvasEdgeCapacity/, "AI-generated lineage edges must respect the project edge limit");
assert.match(documentCreateRoute, /assertCanvasEdgeCapacity/, "document source lineage must respect the project edge limit");
assert.match(documentSectionProjectRoute, /assertCanvasEdgeCapacity/, "document section projection must respect the project edge limit");
assert.match(agentSaveResultRoute, /assertCanvasEdgeCapacity/, "Agent result lineage must respect the project edge limit");
assert.match(agentSaveResultRoute, /error instanceof CanvasStorageLimitError[\s\S]{0,120}status\(413\)/, "Agent result edge-limit failures must be returned as a client capacity error");
assert.match(edgeCreateRoute, /assertCanvasStorageQuota/, "edge creation must enforce the shared storage quota");
assertOrdered(edgeCreateRoute, 'lockCanvasUser(client, req.session.userId)', 'INSERT INTO write_canvas_edges', "edge creation must serialize quota checks and writes per user");
assert.match(edgeReplaceRoute, /UPDATE write_canvas_edges[\s\S]{0,300}source_node_id = \$1, target_node_id = \$2/, "context rewiring must update one edge atomically");

assert.match(canvas, /<Tldraw/, "magic writing canvas must render tldraw");
assert.match(canvas, /shapeUtils=\{shapeUtils\}/, "tldraw must register AtomFlow custom shapes");
assert.match(canvas, /CanvasAddDrawer/, "canvas must use an on-demand add-node drawer");
assert.match(canvas, /CanvasInspector/, "canvas must use an on-demand node inspector");
assert.match(canvasUi, /aria-label="添加节点"/, "canvas must expose a floating add-node control");
assert.match(canvas, /getViewportPageBounds/, "new nodes must be placed from the visible canvas viewport");
assert.match(canvas, /getArrowBindings/, "canvas edges must use tldraw arrow bindings");
assert.doesNotMatch(canvas, /w-\[300px\].*shrink-0/, "canvas must not reserve a fixed left rail");
assert.doesNotMatch(canvas, /w-\[360px\].*shrink-0/, "canvas must not reserve a fixed right inspector rail");
assert.match(canvasUi, /保存到画布/, "assistant outputs must be manually saved to canvas");
assert.match(canvas, /let receivedTerminal = false/, "single-Agent streams must track whether a terminal SSE event arrived");
assert.match(canvas, /if \(!receivedTerminal\) throw new Error\(/, "premature single-Agent EOF must be surfaced as a failure");
assert.match(canvas, /setAgentInput\(current => current\.trim\(\) \? current : message\)/, "failed single-Agent sends must restore the user's prompt without overwriting new input");

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
