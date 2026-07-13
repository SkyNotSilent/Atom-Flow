import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

const cardPath = "src/components/write-canvas/CanvasNodeCard.tsx";
const menuPath = "src/components/write-canvas/CanvasNodeAddMenu.tsx";
const editorPath = "src/components/write-canvas/CanvasDocumentEditor.tsx";

assert.equal(existsSync(path.join(root, cardPath)), true, "Unified canvas node card must exist");
assert.equal(existsSync(path.join(root, menuPath)), true, "Contextual node plus menu must exist");
assert.equal(existsSync(path.join(root, editorPath)), true, "Canvas document editor must exist");

const page = read("src/pages/MagicWritingCanvas.tsx");
const card = read(cardPath);
const menu = read(menuPath);
const editor = read(editorPath);
const inspector = read("src/components/write-canvas/CanvasInspector.tsx");

assert.match(card, /node\.role|roleLabel/, "Node shell must render semantic roles");
assert.match(card, /node\.status|statusLabel/, "Node shell must render persisted status");
assert.match(card, /CanvasNodeAddMenu/, "Every business card must expose its contextual plus menu");
assert.doesNotMatch(card, /role="button"/, "Node shell must not wrap its menu buttons in another interactive control");
assert.match(menu, /新建子节点/);
assert.match(menu, /AI 拆解/);
assert.match(menu, /创建作品/);
assert.match(page, /atomflow-canvas-node-action/, "Canvas page must handle node-local actions");
assert.match(page, /event\.key === 'Tab'|event\.key === "Tab"/, "Tab must create a child branch outside editors");
assert.match(page, /event\.key === 'Enter'|event\.key === "Enter"/, "Enter must create a sibling branch outside editors");
assert.match(page, /\[role="button"\]/, "Global branch shortcuts must ignore interactive role targets");
assert.match(page, /if \(!linked\)[\s\S]{0,300}method: 'DELETE'/, "Failed structure links must roll back their orphan child node");
assert.match(page, /let receivedFinal = false/, "Quick AI must distinguish a terminal final event from a truncated stream");
assert.match(page, /if \(!receivedFinal\)[\s\S]{0,120}throw new Error/, "Quick AI must reject streams that close before the final event");
assert.match(page, /quickActionAbortControllerRef/, "Quick AI must keep an AbortController for explicit cancellation");
assert.match(page, /signal:\s*abortController\.signal/, "Quick AI requests must be wired to the cancellation signal");
assert.match(page, /取消生成/, "Quick AI must expose an explicit cancel action while running");
assert.match(page, /setActivePanel\(null\)[\s\S]{0,220}setAiDecomposeNodeId\(node\.id\)/, "Opening Quick AI must close other canvas overlays");
assert.match(page, /pendingNodeGeometryRef/, "User geometry edits must be tracked before the debounce expires");
assert.match(page, /mergePendingNodeGeometry/, "Server detail reloads must preserve optimistic local geometry");
assert.match(page, /flushPendingNodeGeometry/, "Pending node geometry must be flushable before project changes");
assert.match(page, /selectedIds\.length !== 1[\s\S]{0,220}setSelectedNodeId\(null\)/, "Multi-selection and arrow selection must clear stale business selection");
assert.match(inspector, /node\.role === 'document'|node\.role === "document"/, "Inspector must route document nodes to the document editor");
assert.match(editor, /useEditor\(/, "Document editing must use Tiptap");
assert.match(editor, /sections/, "Document editor must keep ordered outline sections and bodies together");
assert.match(editor, /CANVAS_DOCUMENT_SCENARIOS/, "Document editor must expose the first content-creation scenarios");
assert.match(editor, /downloadCanvasDocument/, "Completed work must be exportable without leaving the canvas");

console.log("PASS: unified canvas node and document UI contracts");
