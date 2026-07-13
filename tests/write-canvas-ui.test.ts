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
assert.match(menu, /新建子节点/);
assert.match(menu, /AI 拆解/);
assert.match(menu, /创建作品/);
assert.match(page, /atomflow-canvas-node-action/, "Canvas page must handle node-local actions");
assert.match(page, /event\.key === 'Tab'|event\.key === "Tab"/, "Tab must create a child branch outside editors");
assert.match(page, /event\.key === 'Enter'|event\.key === "Enter"/, "Enter must create a sibling branch outside editors");
assert.match(inspector, /node\.role === 'document'|node\.role === "document"/, "Inspector must route document nodes to the document editor");
assert.match(editor, /useEditor\(/, "Document editing must use Tiptap");
assert.match(editor, /sections/, "Document editor must keep ordered outline sections and bodies together");

console.log("PASS: unified canvas node and document UI contracts");
