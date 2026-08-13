import assert from 'node:assert/strict';
import {
  CANVAS_CREATE_ARTICLE_REQUEST_MAX_ENTRIES,
  CANVAS_CREATE_ARTICLE_REQUEST_STORAGE_PREFIX,
  buildCanvasCreateArticleRequestKey,
  forgetPendingCanvasCreateArticleRequest,
  persistPendingCanvasCreateArticleRequests,
  readPendingCanvasCreateArticleRequests,
  rememberPendingCanvasCreateArticleRequest,
  shouldReplaceCanvasCreateArticleRequestId,
  type PendingCanvasCreateArticleRequests,
} from '../src/utils/canvasCreateArticleRequests';

class MemorySessionStorage {
  readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

const projectId = 41;
const agentId = 73;
const ownerId = 19;
const prompt = '把这些素材整理成一篇结构清晰的文章';
const requestKey = buildCanvasCreateArticleRequestKey(projectId, agentId, prompt);
assert.ok(requestKey);
assert.equal(requestKey, buildCanvasCreateArticleRequestKey(projectId, agentId, `  ${prompt}  `));
assert.notEqual(requestKey, buildCanvasCreateArticleRequestKey(projectId, agentId, `${prompt}。`));
assert.notEqual(requestKey, buildCanvasCreateArticleRequestKey(projectId + 1, agentId, prompt));
assert.notEqual(requestKey, buildCanvasCreateArticleRequestKey(projectId, agentId + 1, prompt));
assert.equal(requestKey.includes(prompt), false, 'pending storage keys must not contain raw writing prompts');
assert.equal(buildCanvasCreateArticleRequestKey(0, agentId, prompt), null);
assert.equal(buildCanvasCreateArticleRequestKey(projectId, Number.NaN, prompt), null);
assert.equal(buildCanvasCreateArticleRequestKey(projectId, agentId, '   '), null);

const maxServerMessage = 'x'.repeat(120_000);
assert.equal(
  buildCanvasCreateArticleRequestKey(projectId, agentId, `${maxServerMessage}ignored-tail`),
  buildCanvasCreateArticleRequestKey(projectId, agentId, maxServerMessage),
  'the recovery key must hash the same bounded message the server fingerprints',
);

const requests: PendingCanvasCreateArticleRequests = new Map();
assert.equal(rememberPendingCanvasCreateArticleRequest(requests, requestKey, 'request-first-valid', 10), true);
assert.equal(requests.get(requestKey)?.requestId, 'request-first-valid');
assert.equal(rememberPendingCanvasCreateArticleRequest(requests, 'invalid key', 'request-valid-value', 11), false);
assert.equal(rememberPendingCanvasCreateArticleRequest(requests, requestKey, 'bad id with spaces', 11), false);
assert.equal(rememberPendingCanvasCreateArticleRequest(requests, requestKey, 'request-valid-value', -1), false);

for (let index = 0; index < CANVAS_CREATE_ARTICLE_REQUEST_MAX_ENTRIES + 5; index += 1) {
  const key = buildCanvasCreateArticleRequestKey(projectId, agentId, `pending-${index}`);
  assert.ok(key);
  assert.equal(rememberPendingCanvasCreateArticleRequest(requests, key, `request-pending-${index}`, 100 + index), true);
}
assert.equal(requests.size, CANVAS_CREATE_ARTICLE_REQUEST_MAX_ENTRIES);
assert.equal(requests.has(requestKey), false, 'the oldest recovery handle must be evicted at the capacity boundary');
assert.equal(
  requests.has(buildCanvasCreateArticleRequestKey(projectId, agentId, 'pending-0') || ''),
  false,
  'capacity pruning must retain the newest pending handles',
);

const storage = new MemorySessionStorage();
assert.equal(persistPendingCanvasCreateArticleRequests(storage, ownerId, requests), true);
const ownerStorageKey = `${CANVAS_CREATE_ARTICLE_REQUEST_STORAGE_PREFIX}${ownerId}`;
const serialized = storage.getItem(ownerStorageKey);
assert.ok(serialized);
assert.equal(serialized.includes(prompt), false);

const restored = readPendingCanvasCreateArticleRequests(storage, ownerId);
assert.deepEqual([...restored.entries()], [...requests.entries()]);
assert.equal(readPendingCanvasCreateArticleRequests(storage, ownerId + 1).size, 0, 'another account must not read this owner key');

storage.setItem(ownerStorageKey, JSON.stringify({
  version: 1,
  ownerId: ownerId + 1,
  entries: [],
}));
assert.equal(readPendingCanvasCreateArticleRequests(storage, ownerId).size, 0);
assert.equal(storage.getItem(ownerStorageKey), null, 'an owner mismatch must invalidate the scoped payload');

storage.setItem(ownerStorageKey, JSON.stringify({
  version: 1,
  ownerId,
  entries: [
    { key: requestKey, requestId: 'request-older-value', updatedAt: 10 },
    { key: requestKey, requestId: 'request-newer-value', updatedAt: 20 },
    { key: 'invalid key', requestId: 'request-invalid-key', updatedAt: 30 },
    { key: requestKey, requestId: 'invalid id', updatedAt: 40 },
  ],
}));
const sanitized = readPendingCanvasCreateArticleRequests(storage, ownerId);
assert.equal(sanitized.size, 1);
assert.equal(sanitized.get(requestKey)?.requestId, 'request-newer-value');
assert.equal(forgetPendingCanvasCreateArticleRequest(sanitized, requestKey), true);
assert.equal(persistPendingCanvasCreateArticleRequests(storage, ownerId, sanitized), true);
assert.equal(storage.getItem(ownerStorageKey), null, 'final completion must remove empty owner storage');

storage.setItem(ownerStorageKey, '{not-json');
assert.equal(readPendingCanvasCreateArticleRequests(storage, ownerId).size, 0);
assert.equal(storage.getItem(ownerStorageKey), null);
storage.setItem(ownerStorageKey, 'x'.repeat(32_769));
assert.equal(readPendingCanvasCreateArticleRequests(storage, ownerId).size, 0);
assert.equal(storage.getItem(ownerStorageKey), null, 'oversized untrusted storage must be discarded before JSON parsing');

const unavailableStorage = {
  getItem() { throw new Error('blocked'); },
  setItem() { throw new Error('blocked'); },
  removeItem() { throw new Error('blocked'); },
};
assert.equal(readPendingCanvasCreateArticleRequests(unavailableStorage, ownerId).size, 0);
assert.equal(persistPendingCanvasCreateArticleRequests(unavailableStorage, ownerId, requests), false);

assert.equal(shouldReplaceCanvasCreateArticleRequestId('CANVAS_RUN_ATTEMPTS_EXHAUSTED'), true);
assert.equal(shouldReplaceCanvasCreateArticleRequestId('CANVAS_REQUEST_ID_REUSED'), true);
assert.equal(shouldReplaceCanvasCreateArticleRequestId('CANVAS_RUN_IN_PROGRESS'), false);
assert.equal(shouldReplaceCanvasCreateArticleRequestId(undefined), false);

console.log('PASS: user-scoped canvas create-article recovery handles');
