import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import {
  CANVAS_EXTERNAL_CONTENT_CHANGED_EVENT,
  CANVAS_PROJECTS_CHANGED_EVENT,
  CANVAS_PROJECT_SELECTION_REQUEST_EVENT,
  CANVAS_PROJECT_SELECTION_RESULT_EVENT,
  readCanvasProjectTarget,
  rememberCanvasProjectTarget,
  resolveCanvasProjectTarget,
} from '../src/utils/canvasProjectTarget';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testDir, '..');
const readSource = (relativePath: string) => readFileSync(path.join(root, relativePath), 'utf8');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://atomflow.test' });
const storage = dom.window.localStorage;

rememberCanvasProjectTarget(7, 22, storage);
rememberCanvasProjectTarget(8, 33, storage);
assert.equal(readCanvasProjectTarget(7, storage), 22, 'the recent project target must be restored for its owner');
assert.equal(readCanvasProjectTarget(8, storage), 33, 'project targets must not leak between accounts');
assert.equal(resolveCanvasProjectTarget([{ id: 11 }, { id: 22 }], 22), 22, 'an existing recent project wins over list order');
assert.equal(resolveCanvasProjectTarget([{ id: 11 }, { id: 22 }], 99), 11, 'a deleted recent project falls back to an available project');
assert.equal(resolveCanvasProjectTarget([], 22), null, 'an empty project list has no target');
rememberCanvasProjectTarget(7, null, storage);
assert.equal(readCanvasProjectTarget(7, storage), null, 'clearing one account target must be durable');
assert.equal(readCanvasProjectTarget(8, storage), 33, 'clearing one account must preserve another account target');

assert.equal(CANVAS_PROJECTS_CHANGED_EVENT, 'atomflow-canvas-projects-changed');
assert.equal(CANVAS_PROJECT_SELECTION_REQUEST_EVENT, 'atomflow-canvas-select-project');
assert.equal(CANVAS_PROJECT_SELECTION_RESULT_EVENT, 'atomflow-canvas-select-project-result');
assert.equal(CANVAS_EXTERNAL_CONTENT_CHANGED_EVENT, 'atomflow-canvas-external-content-changed');

const app = readSource('src/App.tsx');
const shell = readSource('src/components/write-workspace/FocusedWriteShell.tsx');
const canvas = readSource('src/pages/MagicWritingCanvas.tsx');

assert.match(app, /canvasProjectTargetRef\.current\.ownerId === ownerId[\s\S]*?canvasProjectTargetRef\.current\.projectId[\s\S]*?: readCanvasProjectTarget\(ownerId\)/, 'the live in-memory target must win for its owner, with durable storage as account-scoped fallback');
assert.match(app, /resolveCanvasProjectTarget\(projects, preferredProjectId\)/);
assert.doesNotMatch(app, /projectsPayload\.projects\?\.\[0\]\?\.id/, 'podcasts must not always target the first project');
assert.match(app, /eventDetail\.ownerId !== ownerId/, 'project-change events must be account scoped');

assert.match(shell, /type PendingProjectSelection/);
assert.match(shell, /requestCanvasProjectSelection\(\{ ownerId: user\.id, requestId: request\.requestId, projectId \}\)/);
assert.match(shell, /CANVAS_PROJECT_SELECTION_RESULT_EVENT, handleSelectionResult/);
assert.match(shell, /setCurrentProjectId\(detail\.currentProjectId\)/, 'confirmation and rejection must reconcile the shell with the actual canvas project');
assert.match(shell, /setCurrentProjectId\(request\.previousProjectId\)/, 'a missing response must eventually roll back optimistic project highlighting');
assert.match(shell, /pendingProjectSelection\?\.projectId \?\? currentProjectId/);

assert.match(canvas, /Promise<CanvasProjectSwitchOutcome>/);
assert.match(canvas, /if \(!user \|\| !projectsLoadedRef\.current\) return;[\s\S]*?publishCanvasProjectsChanged/, 'the empty pre-load render must not erase the remembered project');
assert.match(canvas, /reason: 'agent-running'/);
assert.match(canvas, /reason: documentConflictRef\.current\?\.projectId === sourceProjectId \? 'document-conflict' : 'save-failed'/);
assert.match(canvas, /publishCanvasProjectSelectionResult\(\{/);
assert.match(canvas, /currentProjectId: currentProjectIdRef\.current/);
assert.match(canvas, /CANVAS_EXTERNAL_CONTENT_CHANGED_EVENT, handleExternalContentChanged/);
assert.match(canvas, /projectId !== currentProjectIdRef\.current/);
assert.match(canvas, /const refreshedDetail = await loadProjectDetail\(projectId\)/);
assert.match(canvas, /refreshedDetail\.nodes\.some\(node => node\.id === nodeId\)[\s\S]*?selectNode\(nodeId\)/);
assert.match(
  canvas,
  /const selectedBusinessNodeId = nodeIdFromShape\(selectedBusinessShape\);[\s\S]*?currentDetail\.nodes\.find\(node => node\.id === selectedBusinessNodeId\)[\s\S]*?if \(selectedBusinessNode\)[\s\S]*?else if \(activePanelRef\.current === 'inspector'\) \{[\s\S]*?setSelectedNodeId\(null\);[\s\S]*?setActivePanel\(null\);/,
  'selecting one native tldraw shape must clear the stale business-node context',
);

console.log('PASS: canvas project targeting, switch acknowledgement, and native selection synchronization');
