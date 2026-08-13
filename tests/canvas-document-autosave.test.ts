import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildCanvasDocumentSavePayload,
  createCanvasDocumentDraftRecord,
  createCanvasDocumentSnapshot,
  rebaseCanvasDocumentDraftVersion,
  recoverCanvasDocumentDraft,
  shouldUseCanvasDocumentKeepalive,
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
  currentVersionId: 3,
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
assert.equal(
  shouldApplyCanvasDocumentSaveResult(4, 4, originalSnapshot, originalSnapshot, 9, 10, 2, 3),
  false,
  'a response from another document session must never update the active save baseline',
);
assert.equal(
  shouldApplyCanvasDocumentSaveResult(4, 4, originalSnapshot, originalSnapshot, 9, 9, 2, 3),
  false,
  'an earlier session of the same document must not update a reloaded editor',
);

const dirtyDocument = { ...document, title: '离线恢复标题' };
const draftRecord = createCanvasDocumentDraftRecord(dirtyDocument, originalSnapshot, Date.parse('2026-07-13T00:02:00.000Z'));
assert.deepEqual(recoverCanvasDocumentDraft(document, draftRecord), dirtyDocument, 'a draft based on the current server version must be restored');
assert.equal(
  recoverCanvasDocumentDraft({ ...document, title: '服务器新标题', updatedAt: '2026-07-13T00:03:00.000Z' }, draftRecord),
  null,
  'an older conflicting local draft must not overwrite a newer server document',
);
assert.equal(
  recoverCanvasDocumentDraft({ ...document, title: '服务器新标题', updatedAt: '2026-07-13T00:01:00.000Z' }, draftRecord),
  null,
  'a newer local timestamp must not bypass a mismatched server-version baseline',
);
assert.deepEqual(
  rebaseCanvasDocumentDraftVersion(dirtyDocument, { ...document, currentVersionId: 12, updatedAt: '2026-07-13T00:04:00.000Z' }),
  { ...dirtyDocument, currentVersionId: 12, updatedAt: '2026-07-13T00:04:00.000Z' },
  'same-session edits must carry the version returned by the preceding serialized save',
);
assert.equal(recoverCanvasDocumentDraft(dirtyDocument, draftRecord), null, 'a draft already committed by the server must be discarded');
assert.equal(shouldUseCanvasDocumentKeepalive(buildCanvasDocumentSavePayload(document)), true, 'small documents may use an unload keepalive save');
assert.equal(shouldUseCanvasDocumentKeepalive(buildCanvasDocumentSavePayload({
  ...document,
  sections: [{ ...document.sections[0], body: `<p>${'x'.repeat(70 * 1024)}</p>` }],
})), false, 'documents beyond the keepalive budget must rely on local draft recovery');

const source = readFileSync(path.join(process.cwd(), 'src/components/write-canvas/CanvasDocumentEditor.tsx'), 'utf8');
assert.match(source, /AUTOSAVE_DELAY_MS\s*=\s*\d+/, 'autosave must use an explicit debounce interval');
assert.match(source, /setTimeout\([\s\S]*?\}, AUTOSAVE_DELAY_MS\)/, 'document changes must schedule a debounced save');
assert.match(source, /lastPersistedSnapshotRef/, 'autosave must remember the last persisted snapshot');
assert.match(source, /currentVersionId/, 'every document save must carry its optimistic concurrency version');
assert.match(source, /DOCUMENT_VERSION_CONFLICT/, 'a server version conflict must remain visible instead of silently overwriting remote edits');
assert.match(source, /rebaseCanvasDocumentDraftVersion/, 'serialized saves must rebase later local edits onto the newly persisted version');
assert.match(source, /载入服务器版本/, 'cross-window conflicts must offer an explicit escape from the preserved local draft');
assert.match(source, /saveStatus === 'conflict'/, 'cross-window conflicts must pause ordinary autosave retries');
assert.match(source, /pendingSaveRef/, 'autosave must coalesce edits while a request is in flight');
assert.match(source, /saveLoopRef/, 'save requests must be serialized to prevent stale server writes');
assert.match(source, /CANVAS_DOCUMENT_DRAFT_KEY_PREFIX/, 'dirty documents must use a versioned local draft key');
assert.match(source, /CANVAS_DOCUMENT_TAB_ID_SESSION_KEY/, 'document drafts must use a stable per-tab namespace');
assert.match(
  source,
  /getCanvasDocumentDraftKey\(documentId,\s*tabId\)[\s\S]{0,4000}readCanvasDocumentDraft\(persistedDocument\.id,\s*documentTabIdRef\.current\)/,
  'document draft storage must include the current tab id',
);
const autosaveEffect = source.match(/useEffect\(\(\) => \{[\s\S]*?AUTOSAVE_DELAY_MS\);[\s\S]*?\}, \[([^\]]+)\]\);/)?.[1] || '';
assert.doesNotMatch(autosaveEffect, /saveStatus/, 'save status changes must not schedule a second autosave for the same snapshot');
assert.match(source, /localStorage\.setItem/, 'dirty documents must be journaled outside the unload request');
assert.match(source, /recoverCanvasDocumentDraft/, 'document loading must recover a compatible local draft');
assert.match(source, /activeDocumentSessionRef/, 'save responses must be scoped to the active document session');
assert.match(source, /activeDocumentIdRef/, 'save responses must verify the active document id');
assert.match(source, /activeSaveAbortControllerRef\.current\?\.abort\(\)/, 'switching documents must abort the previous save request');
assert.match(source, /addEventListener\('pagehide'/, 'pagehide must preserve the latest dirty document');
assert.match(source, /shouldUseCanvasDocumentKeepalive/, 'unload keepalive must be gated by the request body size');
assert.match(source, /sections\/\$\{encodeURIComponent\(section\.key\)\}\/project/, 'sections must be projectable to canonical canvas nodes');
assert.match(source, /MAX_PROJECTION_SAVE_ATTEMPTS/, 'section projection must use a bounded fresh-save loop');
assert.match(source, /createCanvasDocumentSnapshot\(currentAfterSave\)[\s\S]{0,200}snapshot/, 'section projection must compare the live document again after saving');
assert.match(source, /作品仍在编辑/, 'continuously changing content must require an explicit projection retry');
assert.match(source, /aria-label="投射段落到画布"/, 'section projection must use an accessible icon action');
assert.match(source, /saveStatus === 'saving'/, 'the UI must expose saving state');
assert.match(source, /saveStatus === 'saved'/, 'the UI must expose saved state');
assert.match(source, /saveStatus === 'error'/, 'the UI must expose autosave errors');

console.log('PASS: canvas document autosave snapshots and lifecycle contracts');
