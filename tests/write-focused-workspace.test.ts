import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import type { Article } from "../src/types";
import { shouldPreserveLocalCanvasGeometry } from "../src/utils/canvasGeometrySync";
import { citationArticleIdentity, stableCitationCaptureId } from "../src/utils/citationIdentity";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testDir, "..");
const readSource = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");

const app = readSource("src/App.tsx");
const writePage = readSource("src/pages/WritePage.tsx");
const shell = readSource("src/components/write-workspace/FocusedWriteShell.tsx");
const contextRail = readSource("src/components/write-canvas/CanvasContextRail.tsx");
const canvas = readSource("src/pages/MagicWritingCanvas.tsx");
const reader = readSource("src/components/reader/ArticleReader.tsx");
const readerWrapper = readSource("src/components/ReaderModal.tsx");
const articleModeCitationReader = readSource("src/components/write-workspace/ArticleModeCitationReader.tsx");
const canvasCreateArticleRequests = readSource("src/utils/canvasCreateArticleRequests.ts");
const podcastProvider = readSource("src/components/podcast/PodcastPlaybackProvider.tsx");
const podcastPage = readSource("src/pages/PodcastPage.tsx");
const podcastInsight = readSource("src/components/podcast/PodcastInsightPanel.tsx");
const notesPanel = readSource("src/components/NotesPanel.tsx");

const sourceSection = (source: string, startMarker: string, endMarker: string) => {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `missing source marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `missing source marker after ${startMarker}: ${endMarker}`);
  return source.slice(start, end);
};
const writeAgentClient = sourceSection(
  writePage,
  "const readAgentStream",
  "const handleAssistantSend",
);
const writeAssistantResultClient = sourceSection(
  writePage,
  "const appendAssistantResult",
  "const readAgentStream",
);
const canvasProjectLoader = sourceSection(
  canvas,
  "const loadProjectDetail",
  "useEffect(() => {",
);
const canvasEditorSync = sourceSection(
  canvas,
  "const syncEditorWithDetail",
  "useEffect(() => {",
);
const canvasProjectListLoader = sourceSection(
  canvas,
  "const loadProjects",
  "const loadTemplates",
);
const canvasAgentClient = sourceSection(
  canvas,
  "const sendAgentMessage",
  "const saveMessageToCanvas",
);
const canvasResultSaveClient = sourceSection(
  canvas,
  "const saveMessageToCanvas",
  "const openAddDrawer",
);
const canvasProjectDeletion = sourceSection(
  canvas,
  "const deleteCurrentProject",
  "const saveProjectSkills",
);
const canvasDocumentPersistence = sourceSection(
  canvas,
  "const captureDocumentSnapshot",
  "const scheduleDocumentSave",
);
const canvasBusinessShapeCleanup = sourceSection(
  canvas,
  "const removeNonCanonicalBusinessShapeCopies",
  "const reconcileUserDocumentChanges",
);
const canvasBusinessDeletion = sourceSection(
  canvas,
  "const reconcileUserDocumentChanges",
  "const reconcileCanonicalArrowChanges",
);
const canvasCanonicalArrowReconciliation = sourceSection(
  canvas,
  "const reconcileCanonicalArrowChanges",
  "const captureDocumentSnapshot",
);
const canvasStoreListeners = sourceSection(
  canvas,
  "const onMount",
  "const getViewportPlacement",
);
const legacyGraphRuntime = sourceSection(
  writePage,
  "const articleGroups",
  "const relatedNodeIds",
);

// The writing tab owns the whole viewport: AtomFlow's global navigation and
// legacy splitters are not mounted behind the focused workspace.
assert.match(app, /const isWriteTab = activeTab === ['"]write['"]/);
const globalNavigation = sourceSection(app, "{/* 导航栏 */}", "{/* 中间内容区 */}");
assert.match(globalNavigation, /!isWriteTab && \(/, "the global Nav must be absent while writing");
assert.match(globalNavigation, /<Nav\b/);
assert.match(globalNavigation, /!isWriteTab && !isMobile && \(/, "the legacy desktop splitter must also be absent while writing");
assert.match(app, /<WritePage onExit=\{\(\) => \{ void leaveWriteWorkspace\(\); \}\}/, "the focused shell must provide a durable-save route back to AtomFlow");
assert.match(writePage, /<FocusedWriteShell key=\{`write-shell-\$\{ownerKey\}`\} onExit=\{onExit\}>[\s\S]*?<MagicWritingCanvas key=\{`canvas-\$\{ownerKey\}`\}[\s\S]*?<WritePageCore key=\{`write-core-\$\{ownerKey\}`\}[\s\S]*?<\/FocusedWriteShell>/);
assert.equal((writePage.match(/<MagicWritingCanvas\b/g) || []).length, 1, "the native canvas must have one persistent owner");
assert.match(writePage, /const USE_LEGACY_WRITE_WORKSPACE = import\.meta\.env\.VITE_LEGACY_WRITE_WORKSPACE === ['"]true['"]/);
assert.match(writePage, /writeWorkspaceMode === ['"]graph['"] && !USE_LEGACY_WRITE_WORKSPACE \? ['"]block['"] : ['"]hidden['"][\s\S]*?<MagicWritingCanvas\b/);
assert.match(writePage, /writeWorkspaceMode === ['"]graph['"] && !USE_LEGACY_WRITE_WORKSPACE \? ['"]hidden['"] : ['"]block['"][\s\S]*?<WritePageCore\b/);
assert.match(writePage, /writeWorkspaceMode === ['"]articles['"] \? ['"]block['"] : ['"]hidden['"][\s\S]*?\{articlesWorkspace\}[\s\S]*?writeWorkspaceMode === ['"]skills['"] \? ['"]block['"] : ['"]hidden['"]/, "article drafts and Skills state must remain mounted across mode switches");
assert.match(writePage, /const legacyGraphActive = USE_LEGACY_WRITE_WORKSPACE && writeWorkspaceMode === ['"]graph['"]/);
assert.match(writePage, /const legacyAssistantActive = writeWorkspaceMode === ['"]articles['"] \|\| legacyGraphActive/);
assert.match(legacyGraphRuntime, /const articleGroups = useMemo[\s\S]*?if \(!legacyGraphActive\) return \[\];/, "the hidden legacy graph must not group every knowledge card");
assert.match(legacyGraphRuntime, /const graph = useMemo[\s\S]*?if \(!legacyGraphActive\) return \{ articles: \[\], cards: \[\], links: \[\] \};/, "the hidden legacy graph must skip semantic O(n²) construction");
assert.match(legacyGraphRuntime, /if \(!legacyGraphActive\) \{[\s\S]*?simulationNodesRef\.current = \[\][\s\S]*?setGraphPositions\(\{\}\)/, "inactive legacy simulation state must be released");
assert.match(legacyGraphRuntime, /if \(!legacyGraphActive\) \{[\s\S]*?cancelAnimationFrame\(simulationFrameRef\.current\)[\s\S]*?return;[\s\S]*?const step =/, "the hidden legacy graph must not retain a requestAnimationFrame loop");
assert.match(writePage, /useEffect\(\(\) => \{\s*if \(!legacyAssistantActive\) return;[\s\S]*?loadAssistantThreads\(['"]chat['"]\)/, "Skills and the new canvas must not hydrate the legacy assistant in the background");
assert.match(writePage, /if \(!legacyAssistantActive \|\| !assistantThreadId\) return;[\s\S]*?hydrateThreadMessages\(assistantThreadId\)/);
assert.match(writePage, /const ownerKey = user\?\.id \?\? ['"]guest['"]/, "writing state must remount when the authenticated owner changes");
assert.match(writePage, /<FocusedWriteShell key=\{`write-shell-\$\{ownerKey\}`\}/, "project navigation state must also be account scoped");
assert.match(writePage, /const assistantStreamAbortControllerRef = useRef<AbortController \| null>\(null\)/);
assert.match(writePage, /useEffect\(\(\) => \(\) => \{[\s\S]*?assistantStreamAbortControllerRef\.current = null;[\s\S]*?controller\?\.abort\(\)/, "account-key remounts must abort the active ordinary Agent stream");
assert.match(writeAgentClient, /const readAgentStream = async \(response: Response, signal: AbortSignal\)/);
assert.match(writeAgentClient, /assistantStreamAbortControllerRef\.current\?\.abort\(\)[\s\S]*?new AbortController\(\)/, "a newer ordinary Agent request must abort its predecessor");
assert.match(writeAgentClient, /signal: requestController\.signal/);
assert.match(writeAgentClient, /requestController\.signal\.aborted \|\| \(error instanceof DOMException && error\.name === 'AbortError'\)\) return/, "request cancellation must not surface a misleading assistant error");
assert.match(writeAgentClient, /if \(assistantStreamAbortControllerRef\.current === requestController\) \{[\s\S]*?setIsAssistantThinking\(false\)/, "an old request must not clear the current request's loading state");
assert.match(writeAgentClient, /buffer \+= decoder\.decode\(\)[\s\S]*?handleBufferedEvents\(true\)/, "an unterminated final SSE event and a split UTF-8 code point must still be consumed");
assert.match(writeAgentClient, /buffer\.split\(\/\\r\?\\n\\r\?\\n\/\)/, "ordinary Agent SSE parsing must accept CRLF delimiters");
assert.match(writeAssistantResultClient, /await reloadNotes\(\);[\s\S]*?assertCurrentRequest\(\);[\s\S]*?setWriteWorkspaceMode\(['"]articles['"]\)/, "a superseded create-article response must not switch modes after note hydration");
assert.match(writeAssistantResultClient, /assistantStreamAbortControllerRef\.current !== requestController[\s\S]*?AbortError/, "final result hydration must be owned by the active request");

assert.match(canvasProjectLoader, /const knownRevision = documentRevisionByProjectRef\.current\.get\(projectId\) \?\? 0/);
assert.match(canvasProjectLoader, /if \(revision < knownRevision\) return null;[\s\S]*?detailRef\.current = payload/, "a late project detail must be rejected before it can replace the current snapshot");
assert.match(canvasProjectLoader, /hasDirtyLocalDocument[\s\S]*?revision > knownRevision[\s\S]*?preserveLocalDocumentProjectRef\.current = projectId[\s\S]*?setDocumentConflict/, "a newer remote snapshot must enter conflict state instead of overwriting a dirty local document");
assert.match(canvasProjectListLoader, /Math\.max\(knownRevision, revision\)/, "a late project-list response must not lower the revision guard used by detail loading");
assert.match(canvas, /const preserveLocalDocument = preserveLocalDocumentProjectRef\.current === nextDetail\.project\.id[\s\S]*?if \(!preserveLocalDocument && restoredDocumentKeyRef\.current !== documentKey\)/, "business refreshes must merge canonical nodes without restoring the remote tldraw snapshot during a conflict");
assert.match(canvas, /if \(response\.status === 409\)[\s\S]*?preserveLocalDocumentProjectRef\.current = projectId/, "a save-time 409 must preserve local free-canvas edits until explicit resolution");
assert.match(canvas, /loadProjectDetail\(projectId, \{ forceDocument: true \}\)/, "loading the latest version must be an explicit conflict-resolution action");
const cleanGeometryState = {
  isCurrentEditorProject: true,
  restoredDocument: false,
  forceServerGeometry: false,
  documentChangeVersion: 4,
  savedChangeVersion: 4,
  hasQueuedDocumentSave: false,
  hasDocumentSaveInFlight: false,
};
assert.equal(shouldPreserveLocalCanvasGeometry(cleanGeometryState), false, "clean business-node geometry must continue to follow the server");
assert.equal(shouldPreserveLocalCanvasGeometry({ ...cleanGeometryState, documentChangeVersion: 5 }), true, "a dirty local drag must not jump back during a business refresh");
assert.equal(shouldPreserveLocalCanvasGeometry({ ...cleanGeometryState, hasQueuedDocumentSave: true }), true, "queued document geometry remains locally authoritative");
assert.equal(shouldPreserveLocalCanvasGeometry({ ...cleanGeometryState, hasDocumentSaveInFlight: true }), true, "in-flight document geometry remains locally authoritative");
assert.equal(shouldPreserveLocalCanvasGeometry({ ...cleanGeometryState, documentChangeVersion: 5, restoredDocument: true }), false, "initial snapshot restoration must apply canonical server geometry");
assert.equal(shouldPreserveLocalCanvasGeometry({ ...cleanGeometryState, documentChangeVersion: 5, forceServerGeometry: true }), false, "loading the latest document must explicitly apply server geometry");
assert.match(canvasEditorSync, /const preserveExistingNodeGeometry = shouldPreserveLocalCanvasGeometry\(\{/);
assert.match(canvasEditorSync, /if \(!existingShape\) \{[\s\S]*?editor\.createShape\(\{ id, type: 'atomflow-node', x: node\.x, y: node\.y, props \}/, "new business nodes must still use backend initial geometry");
const protectedGeometryBranch = sourceSection(
  canvasEditorSync,
  "else if (preserveExistingNodeGeometry",
  "} else {",
);
assert.match(protectedGeometryBranch, /w: existingShape\.props\.w, h: existingShape\.props\.h/);
assert.doesNotMatch(protectedGeometryBranch, /x: node\.x|y: node\.y/, "dirty refreshes must only synchronize node props, not local geometry");
assert.match(canvasEditorSync, /else \{[\s\S]*?editor\.updateShape\(\{ id, type: 'atomflow-node', x: node\.x, y: node\.y, props \}/, "clean refreshes must continue to synchronize server geometry");
assert.match(canvas, /syncEditorWithDetail\(editorRef\.current, latest, \{ forceServerGeometry: true \}\)/);
assert.match(canvas, /const agentStreamAbortControllerRef = useRef<AbortController \| null>\(null\)/);
assert.match(canvas, /useEffect\(\(\) => \(\) => \{[\s\S]*?agentStreamAbortControllerRef\.current = null;[\s\S]*?controller\?\.abort\(\)/, "account-key remounts must abort the active canvas Agent stream");
assert.match(canvasAgentClient, /agentStreamAbortControllerRef\.current\?\.abort\(\)[\s\S]*?new AbortController\(\)/, "a newer canvas Agent request must abort its predecessor");
assert.match(canvasAgentClient, /signal: requestController\.signal/);
assert.match(canvasAgentClient, /buffer \+= decoder\.decode\(\)[\s\S]*?handleBufferedEvents\(true\)[\s\S]*?if \(!receivedFinal\)/, "canvas Agent streams must parse an unterminated final SSE event before deciding the connection was interrupted");
assert.match(canvasAgentClient, /requestController\.signal\.aborted \|\| \(error instanceof DOMException && error\.name === 'AbortError'\)\) return/, "canvas Agent cancellation must stay silent");
assert.match(canvasAgentClient, /if \(agentStreamAbortControllerRef\.current === requestController\) \{[\s\S]*?setIsAgentRunning\(false\)/, "an old canvas request must not clear the current request's running state");
assert.match(canvasAgentClient, /buildCanvasCreateArticleRequestKey\(requestProjectId, requestAgentId, message\)/, "create-article retries must use a bounded project-and-Agent-scoped fingerprint key");
assert.match(canvasAgentClient, /rememberPendingCanvasCreateArticleRequest\([\s\S]*?const requestHandlePersisted = persistPendingCanvasCreateArticleRequests\([\s\S]*?if \(!requestHandlePersisted\) \{[\s\S]*?为避免重复计费[\s\S]*?return;[\s\S]*?agentStreamAbortControllerRef\.current\?\.abort\(\)/, "the paid create-article request must not start unless its recovery id is durable");
assert.match(canvasAgentClient, /if \(!response\.ok\) \{[\s\S]*?await response\.json\(\)[\s\S]*?shouldReplaceCanvasCreateArticleRequestId\(errorPayload\?\.code\)[\s\S]*?clearPendingCreationRequest\(\)/, "terminal idempotency errors must parse their code and retire the dead request id");
assert.match(canvasAgentClient, /if \(!receivedFinal\) throw new Error[\s\S]*?clearPendingCreationRequest\(\)/, "only a consumed final event may clear a successful pending recovery handle");
assert.match(canvas, /readPendingCanvasCreateArticleRequests\([\s\S]*?getCanvasRequestSessionStorage\(\)[\s\S]*?ownerId/, "pending handles must hydrate from a user-scoped session store");
assert.match(canvasCreateArticleRequests, /CANVAS_CREATE_ARTICLE_REQUEST_STORAGE_PREFIX = 'atomflow:canvas-create-article-requests:v1:'/);
assert.match(canvasCreateArticleRequests, /CANVAS_CREATE_ARTICLE_REQUEST_MAX_ENTRIES = 24/);
assert.match(canvasCreateArticleRequests, /CANVAS_RUN_ATTEMPTS_EXHAUSTED[\s\S]*?CANVAS_REQUEST_ID_REUSED/);
assert.doesNotMatch(canvasCreateArticleRequests, /NON_REUSABLE_CANVAS_CREATE_ARTICLE_CODES[\s\S]*?CANVAS_RUN_IN_PROGRESS/, "a recoverable in-progress response must keep the original request id");
assert.match(canvasAgentClient, /const requestProjectId = currentProjectIdRef\.current;[\s\S]*?const requestAgentId = agentNode\.agent\.id;[\s\S]*?const requestAgentNodeId = agentNode\.id;/, "canvas streams must capture immutable project and Agent ownership before starting");
assert.match(canvasAgentClient, /const assertCurrentAgentRequest =[\s\S]*?currentProjectIdRef\.current !== requestProjectId[\s\S]*?canvasDetailContainsAgent\(candidateDetail, requestProjectId, requestAgentNodeId, requestAgentId\)[\s\S]*?AbortError/, "every streamed mutation must still belong to the captured project and Agent");
assert.match(canvasAgentClient, /for \(const part of parts\) \{[\s\S]*?assertCurrentAgentRequest\(\);[\s\S]*?parseSseEvents\(part\)/, "a late partial or final event must be rejected before changing current-project UI");
assert.match(canvasAgentClient, /const refreshedDetail = await loadProjectDetail\(requestProjectId\);[\s\S]*?assertCurrentAgentRequest\(refreshedDetail\)/, "SSE final must refresh the captured project rather than whichever project is current later");
assert.match(canvasAgentClient, /if \(!refreshedDetail\) \{[\s\S]*?assertCurrentAgentRequest\(\);[\s\S]*?请重试以恢复结果/, "a same-project hydration failure must restore the prompt while preserving its recovery request id");
assert.match(canvasAgentClient, /refreshedDetail\.nodes\.some\(node => node\.id === noteNodeId && node\.kind === 'note'\)[\s\S]*?assertCurrentAgentRequest\(refreshedDetail\);[\s\S]*?selectNode\(noteNodeId\)/, "a returned Note may be selected only after it appears in the owned refreshed project");
assert.doesNotMatch(canvasAgentClient, /loadProjectDetail\(currentProjectIdRef\.current\)/, "an old SSE final must never redirect its refresh into a newly selected project");
assert.match(canvasProjectDeletion, /if \(isAgentRunning\) return showToast\('Agent 正在运行，请等待本次生成结束后删除项目'\)/, "the delete handler must reject programmatic clicks while generation is running");
assert.match(canvas, /onClick=\{deleteCurrentProject\}[\s\S]*?disabled=\{isAgentRunning\}[\s\S]*?Agent 运行期间不能删除当前项目/, "the project menu must expose the same generation-time deletion guard");
assert.match(canvasResultSaveClient, /const requestProjectId = currentProjectIdRef\.current;[\s\S]*?const requestAgentId = agentNode\.agent\.id;[\s\S]*?canvasDetailContainsAgent\(detailRef\.current, requestProjectId, requestAgentNodeId, requestAgentId\)/, "saving an answer must bind its response to the originating project and Agent");
assert.match(canvasResultSaveClient, /currentProjectIdRef\.current !== requestProjectId[\s\S]*?loadProjectDetail\(requestProjectId\)[\s\S]*?canvasDetailContainsAgent\(refreshedDetail, requestProjectId, requestAgentNodeId, requestAgentId\)/, "a result save that finishes after navigation must not hydrate the new project");
assert.match(canvasResultSaveClient, /refreshedDetail\.nodes\.some\(node => node\.id === resultNodeId && node\.kind === 'result'\)[\s\S]*?selectNode\(resultNodeId\)/, "a result node may be selected only when the captured project's refresh contains it");

// Business nodes and context edges are database-owned. A pasted or duplicated
// record may carry copied props/meta, but only its deterministic canonical id
// is allowed to select, persist, update, or delete server data.
assert.match(canvas, /const canonicalNodeIdFromShapeRecord[\s\S]*?String\(record\.id\) === String\(shapeIdForNode\(nodeId\)\) \? nodeId : null/);
assert.match(canvas, /const canonicalEdgeIdFromShapeRecord[\s\S]*?String\(record\.id\) === String\(shapeIdForEdge\(edgeId\)\) \? edgeId : null/);
assert.match(canvas, /onPointerDown=\{\(\) => \{[\s\S]*?const nodeId = nodeIdFromShape\(shape\);[\s\S]*?detail: \{ nodeId \}/, "business-node pointer selection must derive identity from the canonical shape id");
assert.match(canvas, /detailRef\.current\?\.nodes\.some\(node => node\.id === nodeId\)[\s\S]*?selectNode\(nodeId\)/, "synthetic node-selection events must also belong to the loaded project");
assert.match(canvasDocumentPersistence, /const captureCanvasViewport[\s\S]*?editor\.getCamera\(\)/, "camera state must join the revisioned document save");
assert.match(canvasDocumentPersistence, /form\.append\('viewport', JSON\.stringify\(viewport\)\)/, "business layout, camera, and native document changes must share one optimistic save request");
assert.doesNotMatch(canvas, /fetch\(`\/api\/write\/canvas\/nodes\/\$\{nodeId\}`,[\s\S]*?width: shape\.props\.w/, "layout autosave must not fan out one request per business node");
assert.match(canvasBusinessShapeCleanup, /isNonCanonicalBusinessShapeRecord\(record\)[\s\S]*?mergeRemoteChanges\(\(\) => \{[\s\S]*?deleteShapes\(invalidShapeIds\)[\s\S]*?history: 'ignore'/, "copied business shapes must be removed outside user history and backend reconciliation");
assert.match(canvas, /const claimsCanonicalIdentity = asRecord\(record\.meta\)\?\.atomflowCanonical === true[\s\S]*?edgeIdFromShapeId\(record\.id as TLShapeId\) !== null[\s\S]*?canonicalEdgeIdFromShapeRecord\(record\) === null/, "copied edge metadata and tampered reserved edge ids must both be cleaned without reaching the backend");
assert.match(canvasBusinessDeletion, /canonicalNodeIdFromShapeRecord\(record\)[\s\S]*?currentDetail\.nodes\.some\(node => node\.id === nodeId\)[\s\S]*?deleteNodeById\(nodeId/);
assert.match(canvasBusinessDeletion, /canonicalEdgeIdFromShapeRecord\(record\)[\s\S]*?currentDetail\.edges\.find\(item => item\.id === edgeId\)[\s\S]*?removeEdge\(edge/);
assert.doesNotMatch(canvasBusinessDeletion, /Number\([^\n]*props[^\n]*nodeId|edgeIdFromShapeId/, "business DELETEs must never be inferred from copied props or an id suffix alone");
assert.match(canvasCanonicalArrowReconciliation, /const edgeId = canonicalEdgeIdFromShape\(shape\)[\s\S]*?currentDetail\.edges\.find\(item => item\.id === edgeId\)/, "context-edge PUTs must use the canonical shape identity and loaded edge");
assert.match(canvasStoreListeners, /const addedOrUpdatedRecords =[\s\S]*?removeNonCanonicalBusinessShapeCopies\(editor, addedOrUpdatedRecords\)[\s\S]*?queueBusinessReconciliation\(\{ editor, removedRecords, changedRecords \}\)/, "copy cleanup must be separated from queued canonical deletion reconciliation");
assert.match(canvas, /\['copy', 'cut', 'duplicate', 'delete'\][\s\S]*?selection\.some\(isCanonicalBusinessShape\)[\s\S]*?return;/, "standard tldraw copy, cut, duplicate, and delete actions must be disabled for canonical business shapes");
assert.match(canvasStoreListeners, /registerBeforeDeleteHandler\('shape'[\s\S]*?source === 'user'[\s\S]*?isCanonicalBusinessShape[\s\S]*?return false/, "eraser and other native delete paths must not put database-owned shapes into tldraw undo history");
assert.match(canvasStoreListeners, /registerExternalAssetHandler\('file', null\)[\s\S]*?registerExternalContentHandler\('files'[\s\S]*?registerExternalContentHandler\('file-replace'/, "native media insertion must be routed away from tldraw's embedded data URL store");
assert.match(canvasStoreListeners, /registerExternalAssetHandler\('url', null\)[\s\S]*?registerExternalContentHandler\('url'[\s\S]*?type: 'text'[\s\S]*?text: externalContent\.url/, "pasted URLs must remain plain canvas text instead of creating unmanaged bookmark assets");
assert.match(canvasStoreListeners, /registerExternalContentHandler\('embed', rejectNativeMedia\)/, "iframe and supported-site paste must not create unmanaged embed shapes");
assert.match(canvasStoreListeners, /registerExternalContentHandler\('tldraw'[\s\S]*?content\.assets\.length > 0[\s\S]*?containsRestrictedContent[\s\S]*?rejectNativeMedia/, "tldraw clipboard payloads with assets or reserved business shapes must not bypass the bounded upload flow");
assert.match(canvas, /\['insert-media', 'insert-embed', 'convert-to-embed', 'convert-to-bookmark'\][\s\S]*?delete nextActions\[actionId\][\s\S]*?delete nextTools\.asset[\s\S]*?delete nextTools\.embed/, "native media and embed affordances must be hidden in favor of bounded uploads and plain text links");
assert.match(canvas, /const removeUnmanagedNativeMediaRecords[\s\S]*?editor\.store\.allRecords\(\)[\s\S]*?editor\.store\.remove\(recordIds as never\)[\s\S]*?history: 'ignore'/, "unexpected native media must be removed outside undo history before autosave");
assert.match(canvasStoreListeners, /addedOrUpdatedRecords\.some\(isUnmanagedNativeMediaRecord\)[\s\S]*?removeUnmanagedNativeMediaRecords\(editor\)/, "the document listener must provide a last-resort unmanaged-media cleanup");
assert.match(canvas, /if \(removeUnmanagedNativeMediaRecords\(editor\) > 0\)[\s\S]*?旧画布中的原生媒体已移除/, "legacy snapshots must be sanitized on load so future saves cannot deadlock on server validation");
assert.match(canvasStoreListeners, /sessionRecords\.some\(record => record\.typeName === 'camera'\)[\s\S]*?scheduleDocumentSave\(\)[\s\S]*?\{ scope: 'session' \}/, "selection changes must not trigger layout writes while camera changes remain revisioned");
assert.match(canvas, /catch \{[\s\S]*?blankDocumentSnapshotRef\.current[\s\S]*?loadStoreSnapshot\(blankDocument as never\)[\s\S]*?history: 'ignore'/, "a malformed project snapshot must clear the previous project's native document before compatibility recovery");
assert.match(canvas, /<Tldraw[^>]*overrides=\{canvasUiOverrides\}/, "the business-shape action guard must be installed on the editor");

// Desktop layout defaults and every user-adjustable state are persisted as one
// versioned preference. The center retains the approved working width.
assert.match(shell, /STORAGE_KEY\s*=\s*['"]atomflow:focused-write-layout:v1['"]/);
assert.match(shell, /DEFAULT_LEFT_WIDTH\s*=\s*288/);
assert.match(shell, /DEFAULT_RIGHT_WIDTH\s*=\s*420/);
assert.match(shell, /MIN_CENTER_WIDTH\s*=\s*560/);
assert.match(shell, /window\.localStorage\.getItem\(STORAGE_KEY\)/);
assert.match(shell, /window\.localStorage\.setItem\(STORAGE_KEY, JSON\.stringify\(\{[\s\S]*?leftWidth,[\s\S]*?rightWidth,[\s\S]*?leftCollapsed,[\s\S]*?rightCollapsed,/);
assert.match(shell, /type DragTarget = ['"]left['"] \| ['"]right['"] \| null/);
assert.match(shell, /aria-label="调整左栏宽度"/);
assert.match(shell, /aria-label="调整右栏宽度"/);
assert.match(shell, /setLeftCollapsed\(/);
assert.match(shell, /setRightCollapsed\(/);
assert.match(shell, /rect\.width - [\s\S]*?MIN_CENTER_WIDTH/, "drag bounds must reserve the center workspace");
assert.match(shell, /new ResizeObserver[\s\S]*?width - occupiedLeft - MIN_CENTER_WIDTH/, "stored widths must be clamped again when the viewport changes");
assert.doesNotMatch(shell, /\blg:(?:flex|block|hidden|h-full)\b/, "the focused workspace must not mix tablet and desktop breakpoints at 1024-1279px");
assert.match(shell, /xl:flex/, "the persistent left rail must appear only on xl desktop");
assert.match(shell, /xl:block/, "desktop splitters must appear only on xl desktop");
assert.match(shell, /xl:hidden/, "the focused workspace must expose the compact drawer layout below xl desktop");
assert.match(shell, /h-\[calc\(100%-3rem\)\] min-h-0 xl:h-full/, "the compact top bar height must be removed only when the xl desktop shell is active");
assert.match(notesPanel, /window\.innerWidth < 768/, "the article editor must switch to a single-main-region layout on mobile");
assert.match(notesPanel, /activeNote \? "hidden md:flex" : "flex w-full"/, "the mobile article library must not squeeze the editor beside it");
assert.match(notesPanel, /activeNote \? "flex" : "hidden md:flex"/, "the mobile editor must replace the library after selection");
assert.match(notesPanel, /onClick=\{\(\) => void selectActiveNote\(null\)\}[\s\S]*?文章库/, "mobile article editing must provide a route back to the library");

for (const [value, label] of [
  ["graph", "画布"],
  ["articles", "我的文章"],
  ["skills", "Skills"],
] as const) {
  assert.match(shell, new RegExp(`value: ['\"]${value}['\"][^\\n]*label: ['\"]${label}['\"]`));
}
assert.match(shell, /aria-label="写作模式"/);
assert.match(shell, /普通箭头只作视觉标注/);
assert.match(shell, /只有“上下文连接”会授权 Agent 使用素材/);

// The right context rail has four stable modes, follows the selected business
// object by default, and pins identity while continuing to render live state.
assert.match(contextRail, /export type CanvasContextTab = ['"]assistant['"] \| ['"]original['"] \| ['"]node['"] \| ['"]skills['"]/);
assert.match(contextRail, /w-\[min\(100vw,420px\)\][\s\S]*?xl:w-\[var\(--write-context-width,420px\)\]/, "mobile context drawers must stay viewport-bounded even when the persisted desktop rail is collapsed");
for (const label of ["助手", "原文", "节点", "Skills"]) {
  assert.match(contextRail, new RegExp(`label: ['\"]${label}['\"]`));
}
assert.match(contextRail, /const \[pinnedContext, setPinnedContext\] = useState/);
assert.match(contextRail, /if \(!pinned\) setTab\(preferredTabForNode\(selectedNode\)\)/);
assert.match(contextRail, /nodes\.find\(node => node\.id === pinnedContext\.selectedNodeId\)/);
assert.match(contextRail, /nodes\.find\(node => node\.id === pinnedContext\.assistantNodeId\)/);
assert.match(contextRail, /renderInspectorPanel\([\s\S]*?activeAssistantNode/, "a pinned Agent panel must rerender with current input, messages and run state");
assert.match(contextRail, /const snapshots = selectedNode\?\.agent \? selectedNode\.agent\.effectiveSkills : project\?\.effectiveSkills/, "the Skills tab must render the selected Agent's resolved override instead of unioning it with project defaults");
assert.match(contextRail, /effectiveConfig\?\.primaryStyleSkillId[\s\S]*?ids\.add\(String\(effectiveConfig\.primaryStyleSkillId\)\)/, "the effective primary style must remain visible even when it is stored separately from skillIds");
assert.doesNotMatch(contextRail, /projectSkillIds[\s\S]*?agentSkillIds[\s\S]*?\|\| agentSkillIds/, "Agent override display must not union project-only Skills back into the effective set");
assert.doesNotMatch(contextRail, /assistantPanel: React\.ReactNode|nodePanel: React\.ReactNode/, "pinning must not freeze rendered React elements");
assert.match(contextRail, /onClick=\{\(\) => setPinnedContext\(current => current \? null : \{/);
assert.match(contextRail, /node\.kind === ['"]agent['"][^\n]*return ['"]assistant['"]/);
assert.match(contextRail, /node\.kind === ['"]saved_article['"] \|\| node\.kind === ['"]citation['"] \|\| node\.kind === ['"]podcast_episode['"]/);
assert.match(contextRail, /<ArticleReader[\s\S]*?variant="compact"[\s\S]*?audio=\{false\}/);
assert.match(contextRail, /fetch\(`\/api\/saved-articles\/\$\{requestedArticleId\}`,[\s\S]*?signal: controller\.signal/, "saved article nodes must load their authenticated full text and cancel stale reads");
assert.match(contextRail, /全文加载失败，仍可查看摘要并打开原文/);
assert.match(canvas, /<CanvasContextRail[\s\S]*?nodes=\{detail\?\.nodes \|\| \[\]\}[\s\S]*?assistantNode=\{defaultAgentNode\}[\s\S]*?onCitationCapture=\{handleCitationCapture\}/);
assert.match(contextRail, /onCitationCapture\(capture, action, activeAssistantNode\)/, "pinned article captures must connect to the pinned Agent identity");
assert.match(writePage, /<ArticleModeCitationReader active=\{writeWorkspaceMode === ['"]articles['"]\}/, "article mode must enable its citation-aware original reader");
assert.match(articleModeCitationReader, /<ReaderPane[\s\S]*?onCitationCapture=\{handleCitationCapture\}[\s\S]*?citationActionAvailability=\{availability\}/);
assert.match(articleModeCitationReader, /\/api\/write\/canvas\/projects\/\$\{target\.projectId\}\/citations/);
assert.match(articleModeCitationReader, /resolveCanvasProjectTarget\(projects, readCanvasProjectTarget\(user\.id\)\)/, "article mode must use the same remembered current project as canvas and podcast actions");
assert.match(articleModeCitationReader, /detail\.ownerId !== user\.id/, "canvas targeting events must not cross account boundaries");
assert.doesNotMatch(articleModeCitationReader, /\/api\/(?:articles\/[^'"`]*\/save|cards|write\/canvas\/agents\/[^'"`]*\/chat)/, "article excerpts must not enter knowledge or invoke a paid Agent route");
assert.match(notesPanel, /pendingSaveRef/);
assert.match(notesPanel, /const flushPendingSave[\s\S]*?const successful = await saveRequest[\s\S]*?if \(!successful\)[\s\S]*?return false/, "failed autosaves must retain the pending draft for retry");
assert.match(notesPanel, /const selectActiveNote[\s\S]*?if \(!await flushPendingSave\(\)\) return false/, "switching notes must await a successful save of the previous draft");
assert.match(notesPanel, /visibilityState === ['"]hidden['"][\s\S]*?addEventListener\(['"]pagehide['"]/, "page lifecycle changes must actively flush the current draft");
assert.match(notesPanel, /const flushBeforeAccountLeave[\s\S]*?waitUntil\?\.\(flushPendingSave\(\)\)[\s\S]*?atomflow:before-account-leave/, "logout must be able to await the editor's durable save queue before clearing account state");
assert.match(canvas, /const handleBeforeDurableLeave[\s\S]*?waitUntil\?\.\(flushAll\(\)\)[\s\S]*?addEventListener\('atomflow:before-account-leave', handleBeforeDurableLeave\)[\s\S]*?addEventListener\('atomflow:before-write-leave', handleBeforeDurableLeave\)/, "logout and workspace exit must await both business mutations and the tldraw document save");
assert.match(notesPanel, /addEventListener\('atomflow:before-write-leave', flushBeforeAccountLeave\)/, "workspace exit must await the rich-text draft queue too");
assert.match(app, /const leaveWriteWorkspace = useCallback\(async \(\) => \{[\s\S]*?atomflow:before-write-leave[\s\S]*?Promise\.allSettled\(pendingSaves\)[\s\S]*?setActiveTab\('feed'\)/, "the focused shell must remain mounted until every registered save succeeds");
assert.match(app, /<WritePage onExit=\{\(\) => \{ void leaveWriteWorkspace\(\); \}\}/);
assert.match(notesPanel, /setContent\([^)]*\{ emitUpdate: false \}\)/, "loading another draft must not enqueue a write for the wrong note");
assert.match(canvas, /skillConfig: draft\.skillConfig/, "saving an Agent template must retain the Agent's Skill configuration");
assert.match(canvas, /savingResultMessageKeysRef\.current\.has\(messageKey\)[\s\S]*?setSavedResultMessageKeys/, "saving an Agent response must be guarded against duplicate UI submissions");

// Article selection is behavioral rather than a source-only contract: the
// capture records an exact quote, bounded surrounding context, containing
// paragraph, nearest prior heading, and stable article identity.
process.env.DISABLE_HMR = "true";
const vite = await createServer({
  root,
  appType: "custom",
  configFile: false,
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, hmr: false },
});
const readerModule = await vite.ssrLoadModule("/src/components/reader/ArticleReader.tsx") as Record<string, unknown>;
const articleModeCitationModule = await vite.ssrLoadModule("/src/components/write-workspace/ArticleModeCitationReader.tsx") as Record<string, unknown>;
await vite.close();
const buildCitationCapture = readerModule.buildCitationCapture as (
  articleBody: HTMLElement,
  selection: Selection | null,
  article: Article,
) => {
  exact: string;
  prefix: string;
  suffix: string;
  paragraph: string;
  heading: string | null;
  articleId: number;
  articleTitle: string;
  source: string;
  sourceUrl?: string;
} | null;
assert.ok(buildCitationCapture, "the shared reader must export citation capture behavior");
const articleCitationCaptureId = articleModeCitationModule.articleCitationCaptureId as (capture: NonNullable<ReturnType<typeof buildCitationCapture>>) => string;
const buildArticleCitationRequest = articleModeCitationModule.buildArticleCitationRequest as (
  capture: NonNullable<ReturnType<typeof buildCitationCapture>>,
  action: 'add-to-canvas' | 'add-and-connect',
  target: { projectId: number | null; agentNodeId: number | null; nodes: unknown[]; status: string },
  capturedAt: string,
) => { url: string; init: RequestInit } | null;
const submitArticleCitation = articleModeCitationModule.submitArticleCitation as (
  capture: NonNullable<ReturnType<typeof buildCitationCapture>>,
  action: 'add-to-canvas' | 'add-and-connect',
  target: { projectId: number | null; agentNodeId: number | null; nodes: unknown[]; status: string },
  options: { capturedAt: string; fetcher: typeof fetch },
) => Promise<{ ok: boolean; status: number; payload?: Record<string, unknown> }>;
const getArticleCitationAvailability = articleModeCitationModule.getArticleCitationAvailability as (
  authenticated: boolean,
  target: { projectId: number | null; agentNodeId: number | null; nodes: unknown[]; status: string },
) => Record<'add-to-canvas' | 'add-and-connect', { disabled?: boolean; reason?: string }>;
assert.ok(articleCitationCaptureId && buildArticleCitationRequest && submitArticleCitation && getArticleCitationAvailability);

const dom = new JSDOM("<!doctype html><html><body><article id=body></article></body></html>", {
  url: "https://atomflow.test/reader",
});
const articleBody = dom.window.document.querySelector<HTMLElement>("#body");
assert.ok(articleBody);
const before = "前".repeat(140);
const exact = "选中的正文";
const after = "后".repeat(140);
articleBody.innerHTML = `<h2>最近章节</h2><p>${before}${exact}${after}</p>`;
const paragraphText = articleBody.querySelector("p")?.firstChild;
assert.ok(paragraphText);
const selection = dom.window.getSelection();
assert.ok(selection);
const range = dom.window.document.createRange();
range.setStart(paragraphText, before.length);
range.setEnd(paragraphText, before.length + exact.length);
selection.removeAllRanges();
selection.addRange(range);

const article: Article = {
  id: 42,
  saved: false,
  source: "测试来源",
  topic: "写作",
  time: "刚刚",
  title: "可追溯文章",
  excerpt: "摘要",
  content: articleBody.textContent || "",
  url: "https://example.com/article/42",
  cards: [],
};
const capture = buildCitationCapture(articleBody, selection, article);
assert.ok(capture);
assert.equal(capture.exact, exact);
assert.equal(capture.prefix, "前".repeat(120));
assert.equal(capture.suffix, "后".repeat(120));
assert.equal(capture.paragraph, `${before}${exact}${after}`);
assert.equal(capture.heading, "最近章节");
assert.deepEqual(
  {
    articleId: capture.articleId,
    articleTitle: capture.articleTitle,
    source: capture.source,
    sourceUrl: capture.sourceUrl,
  },
  {
    articleId: 42,
    articleTitle: "可追溯文章",
    source: "测试来源",
    sourceUrl: "https://example.com/article/42",
  },
);

const target = {
  projectId: 7,
  agentNodeId: 91,
  nodes: [],
  status: 'ready',
};
const capturedAt = '2026-08-09T12:34:56.000Z';
const addRequest = buildArticleCitationRequest(capture, 'add-to-canvas', target, capturedAt);
const connectRequest = buildArticleCitationRequest(capture, 'add-and-connect', target, capturedAt);
assert.ok(addRequest && connectRequest);
assert.equal(addRequest.url, '/api/write/canvas/projects/7/citations');
assert.equal(connectRequest.url, addRequest.url, 'both article-mode actions must share the durable citation endpoint');
const addBody = JSON.parse(String(addRequest.init.body)) as Record<string, unknown>;
const connectBody = JSON.parse(String(connectRequest.init.body)) as Record<string, unknown>;
assert.equal(addBody.captureId, articleCitationCaptureId(capture));
assert.equal(connectBody.captureId, addBody.captureId, 'the two actions must use the same stable citation identity');
assert.equal('targetAgentNodeId' in addBody, false, 'adding a citation alone must not silently authorize an Agent');
assert.equal(connectBody.targetAgentNodeId, 91, 'connecting must name one explicit Agent node');
assert.deepEqual(addBody.articleIdentity, {
  id: 42,
  title: '可追溯文章',
  source: '测试来源',
  url: 'https://example.com/article/42',
  stableIdentity: 'url:https://example.com/article/42',
});
assert.deepEqual(addBody.selection, {
  exact,
  prefix: '前'.repeat(120),
  suffix: '后'.repeat(120),
  paragraph: `${before}${exact}${after}`,
  heading: '最近章节',
  capturedAt,
});

const noAgentTarget = { ...target, agentNodeId: null };
assert.equal(buildArticleCitationRequest(capture, 'add-and-connect', noAgentTarget, capturedAt), null);
assert.equal(getArticleCitationAvailability(true, noAgentTarget)['add-to-canvas'].disabled, false);
assert.equal(getArticleCitationAvailability(true, noAgentTarget)['add-and-connect'].disabled, true);
assert.match(getArticleCitationAvailability(true, noAgentTarget)['add-and-connect'].reason || '', /Agent/);
assert.equal(getArticleCitationAvailability(false, target)['add-to-canvas'].disabled, true);

const postedRequests: Array<{ url: string; body: Record<string, unknown> }> = [];
const fakeCitationFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  postedRequests.push({
    url: String(input),
    body: JSON.parse(String(init?.body || '{}')) as Record<string, unknown>,
  });
  return new Response(JSON.stringify({ node: { id: 501 }, created: postedRequests.length === 1 }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;
const firstSubmission = await submitArticleCitation(capture, 'add-and-connect', target, { capturedAt, fetcher: fakeCitationFetch });
const retrySubmission = await submitArticleCitation(capture, 'add-and-connect', target, { capturedAt, fetcher: fakeCitationFetch });
assert.equal(firstSubmission.ok, true);
assert.equal(retrySubmission.ok, true);
assert.equal(postedRequests.length, 2);
assert.equal(postedRequests[0].url, '/api/write/canvas/projects/7/citations');
assert.equal(postedRequests[0].body.captureId, postedRequests[1].body.captureId, 'a lost-response retry must retain its durable capture identity');
assert.equal(postedRequests[0].body.targetAgentNodeId, 91);

const savedVersionOfCapture = {
  ...capture,
  articleId: 9001,
  sourceUrl: 'https://example.com/article/42?utm_source=feed#section',
};
assert.equal(
  citationArticleIdentity(savedVersionOfCapture),
  citationArticleIdentity(capture),
  'saving a feed article must not change its canonical URL identity',
);
assert.equal(
  stableCitationCaptureId(savedVersionOfCapture),
  stableCitationCaptureId(capture),
  'the same quote must stay idempotent when a feed article receives a saved-article id',
);
assert.notEqual(
  stableCitationCaptureId({ ...capture, paragraph: `${capture.paragraph}另一段` }),
  stableCitationCaptureId(capture),
  'paragraph context participates in the durable collision fingerprint',
);
assert.equal(
  citationArticleIdentity({ ...capture, sourceUrl: undefined, articleTitle: '更新后的标题' }),
  citationArticleIdentity({ ...capture, sourceUrl: undefined }),
  'a title edit must not change a URL-less source-scoped article id',
);

const tooLongText = "字".repeat(2001);
articleBody.innerHTML = `<p>${tooLongText}</p>`;
const tooLongNode = articleBody.querySelector("p")?.firstChild;
assert.ok(tooLongNode);
const tooLongRange = dom.window.document.createRange();
tooLongRange.selectNodeContents(tooLongNode);
selection.removeAllRanges();
selection.addRange(tooLongRange);
assert.equal(buildCitationCapture(articleBody, selection, article), null, "quotes longer than 2000 characters must be rejected");

assert.match(reader, /const CITATION_CONTEXT_LENGTH = 120/);
assert.match(reader, /const MAX_CITATION_LENGTH = 2000/);
assert.match(reader, /document\.addEventListener\(['"]selectionchange['"]/, "keyboard selections must receive the same capture toolbar");
assert.match(reader, /handleCitationAction\(['"]add-to-canvas['"]\)/);
assert.match(reader, /handleCitationAction\(['"]add-and-connect['"]\)/);
assert.match(reader, />\s*加入画布\s*</);
assert.match(reader, />\s*加入并连接当前 Agent\s*</);
assert.match(reader, /disabled=\{citationActionAvailability\?\.\[['"]add-and-connect['"]\]\?\.disabled\}/);
assert.match(reader, /data-reader-citation-guidance="true"/);
assert.match(readerWrapper, /export \{[\s\S]*?ArticleReader,[\s\S]*?buildCitationCapture/);

// Podcast playback is provider-owned. Presentational pages and the reader never
// create competing media nodes; the app-level callback creates a traceable
// podcast_episode node with its real audio metadata.
assert.equal((podcastProvider.match(/<audio\b/g) || []).length, 1, "the provider must own exactly one audio element");
assert.equal((podcastPage.match(/<audio\b/g) || []).length, 0, "PodcastPage must consume, not own, audio playback");
assert.equal((reader.match(/<audio\b/g) || []).length, 0, "ArticleReader must not create a second podcast audio instance");
assert.doesNotMatch(reader, /张小珺商业访谈录/, "the shared reader must not identify podcasts by a hard-coded source name");
assert.match(app, /function UserScopedPodcastPlayback\(\)[\s\S]*?ownerIdentity[\s\S]*?<PodcastPlaybackProvider ownerIdentity=\{ownerIdentity\}>[\s\S]*?<AppContent\s*\/>/);
assert.match(readerWrapper, /PodcastArticleAudioControls/, "the default Feed reader audio entry must control the provider-owned singleton");
assert.match(podcastProvider, /ownerIdentity[\s\S]*?media\?\.pause\(\)[\s\S]*?setActiveItem\(undefined\)[\s\S]*?setQueueState\(\[\]\)/);
assert.match(podcastPage, /setQueue\(user \? filteredItems : \[\]\)/, "the signed-out podcast page must not repopulate a cleared user queue");
assert.match(app, /const addPodcastToCanvas = useCallback/);
assert.match(app, /kind:\s*['"]podcast_episode['"]/);
for (const field of ["sourceUrl", "audioUrl", "audioDuration", "publishedAt", "contextBasis"]) {
  assert.match(app, new RegExp(`${field}: item\\.${field}`));
}
assert.match(app, /<PodcastPage[\s\S]*?onAddToCanvas=\{item => \{ void addPodcastToCanvas\(item\); \}\}/);
assert.match(podcastInsight, /onAddToCanvas\(item\)/);
assert.match(podcastInsight, /添加到画布/);

console.log("PASS: focused three-column writing workspace and cross-surface contracts");
