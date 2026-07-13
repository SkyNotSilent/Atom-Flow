import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildCanvasDocumentSavePayload,
  createCanvasDocumentSnapshot,
  shouldApplyCanvasDocumentSaveResult,
} from '../src/components/write-canvas/CanvasDocumentEditor';
import type { WriteCanvasDocument } from '../src/types';

const document: WriteCanvasDocument = {
  id: 9,
  projectId: 2,
  nodeId: 12,
  title: '公众号长文',
  summary: '摘要',
  scenario: 'wechat-depth',
  status: 'editing',
  currentVersionId: 3,
  sections: [
    { key: 'hook', heading: '开场', body: '<p>旧正文</p>', level: 1, meta: { source: 'manual' } },
    { key: 'body', heading: '正文', body: '<p>论证</p>', level: 2, meta: {} },
  ],
  createdAt: '2026-07-13T00:00:00.000Z',
  updatedAt: '2026-07-13T00:01:00.000Z',
};

const payload = buildCanvasDocumentSavePayload(document);
assert.deepEqual(payload, {
  title: '公众号长文',
  summary: '摘要',
  scenario: 'wechat-depth',
  status: 'editing',
  sections: document.sections,
});

const originalSnapshot = createCanvasDocumentSnapshot(document);
const changed = (patch: Partial<WriteCanvasDocument>) => createCanvasDocumentSnapshot({ ...document, ...patch });
assert.notEqual(changed({ title: '新标题' }), originalSnapshot, 'title edits must make the document dirty');
assert.notEqual(changed({ summary: '新摘要' }), originalSnapshot, 'summary edits must make the document dirty');
assert.notEqual(changed({ scenario: 'tutorial' }), originalSnapshot, 'scenario edits must make the document dirty');
assert.notEqual(changed({ status: 'completed' }), originalSnapshot, 'status edits must make the document dirty');
assert.notEqual(changed({ sections: [...document.sections].reverse() }), originalSnapshot, 'outline reorder must make the document dirty');
assert.notEqual(changed({
  sections: document.sections.map(section => section.key === 'hook' ? { ...section, body: '<p>新正文</p>' } : section),
}), originalSnapshot, 'Tiptap body edits must make the document dirty');

assert.equal(shouldApplyCanvasDocumentSaveResult(4, 4, originalSnapshot, originalSnapshot), true);
assert.equal(shouldApplyCanvasDocumentSaveResult(3, 4, originalSnapshot, originalSnapshot), false, 'older requests must not replace a newer save');
assert.equal(shouldApplyCanvasDocumentSaveResult(4, 4, originalSnapshot, changed({ title: '仍在编辑' })), false, 'responses for older drafts must not replace the live draft');

const source = readFileSync(path.join(process.cwd(), 'src/components/write-canvas/CanvasDocumentEditor.tsx'), 'utf8');
assert.match(source, /AUTOSAVE_DELAY_MS\s*=\s*\d+/, 'autosave must use an explicit debounce interval');
assert.match(source, /setTimeout\([\s\S]*?\}, AUTOSAVE_DELAY_MS\)/, 'document changes must schedule a debounced save');
assert.match(source, /lastPersistedSnapshotRef/, 'autosave must remember the last persisted snapshot');
assert.match(source, /pendingSaveRef/, 'autosave must coalesce edits while a request is in flight');
assert.match(source, /saveLoopRef/, 'save requests must be serialized to prevent stale server writes');
assert.match(source, /addEventListener\('pagehide'/, 'pagehide must flush the latest dirty document');
assert.match(source, /keepalive:\s*true/, 'the unload flush must use a keepalive PUT');
assert.match(source, /saveStatus === 'saving'/, 'the UI must expose saving state');
assert.match(source, /saveStatus === 'saved'/, 'the UI must expose saved state');
assert.match(source, /saveStatus === 'error'/, 'the UI must expose autosave errors');

console.log('PASS: canvas document autosave snapshots and lifecycle contracts');
