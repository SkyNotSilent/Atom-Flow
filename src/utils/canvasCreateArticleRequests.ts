export const CANVAS_CREATE_ARTICLE_REQUEST_STORAGE_PREFIX = 'atomflow:canvas-create-article-requests:v1:';
export const CANVAS_CREATE_ARTICLE_REQUEST_MAX_ENTRIES = 24;

const CANVAS_CREATE_ARTICLE_REQUEST_STORAGE_VERSION = 1;
const CANVAS_CREATE_ARTICLE_REQUEST_MAX_MESSAGE_LENGTH = 120_000;
const CANVAS_CREATE_ARTICLE_REQUEST_MAX_STORAGE_CHARS = 32_768;
const CANVAS_CREATE_ARTICLE_REQUEST_KEY_PATTERN = /^p[1-9]\d{0,15}:a[1-9]\d{0,15}:m(?:0|[1-9]\d{0,5}):[0-9a-f]{16}$/;
const CANVAS_CREATE_ARTICLE_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export type PendingCanvasCreateArticleRequest = {
  requestId: string;
  updatedAt: number;
};

export type PendingCanvasCreateArticleRequests = Map<string, PendingCanvasCreateArticleRequest>;

type SessionStorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const isPositiveSafeInteger = (value: number) => Number.isSafeInteger(value) && value > 0;

const isValidRequestKey = (value: unknown): value is string => (
  typeof value === 'string'
  && value.length <= 128
  && CANVAS_CREATE_ARTICLE_REQUEST_KEY_PATTERN.test(value)
);

const isValidRequestId = (value: unknown): value is string => (
  typeof value === 'string'
  && CANVAS_CREATE_ARTICLE_REQUEST_ID_PATTERN.test(value)
);

const storageKeyForOwner = (ownerId: number) => (
  `${CANVAS_CREATE_ARTICLE_REQUEST_STORAGE_PREFIX}${ownerId}`
);

const hashCreateArticleMessage = (message: string) => {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < message.length; index += 1) {
    const code = message.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 0x01000193);
    second ^= code + index;
    second = Math.imul(second, 0x85ebca6b);
    second ^= second >>> 13;
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
};

export const buildCanvasCreateArticleRequestKey = (
  projectId: number,
  agentId: number,
  message: string,
) => {
  if (!isPositiveSafeInteger(projectId) || !isPositiveSafeInteger(agentId) || typeof message !== 'string') return null;
  const normalizedMessage = message.trim().slice(0, CANVAS_CREATE_ARTICLE_REQUEST_MAX_MESSAGE_LENGTH);
  if (!normalizedMessage) return null;
  return `p${projectId}:a${agentId}:m${normalizedMessage.length}:${hashCreateArticleMessage(normalizedMessage)}`;
};

const normalizePendingRequests = (requests: PendingCanvasCreateArticleRequests) => {
  const entries = [...requests.entries()]
    .filter(([key, value]) => (
      isValidRequestKey(key)
      && isValidRequestId(value?.requestId)
      && Number.isSafeInteger(value?.updatedAt)
      && value.updatedAt > 0
    ))
    .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
    .slice(-CANVAS_CREATE_ARTICLE_REQUEST_MAX_ENTRIES);
  requests.clear();
  for (const [key, value] of entries) requests.set(key, value);
  return entries;
};

export const rememberPendingCanvasCreateArticleRequest = (
  requests: PendingCanvasCreateArticleRequests,
  key: string,
  requestId: string,
  updatedAt = Date.now(),
) => {
  if (
    !isValidRequestKey(key)
    || !isValidRequestId(requestId)
    || !Number.isSafeInteger(updatedAt)
    || updatedAt <= 0
  ) return false;
  requests.delete(key);
  requests.set(key, { requestId, updatedAt });
  normalizePendingRequests(requests);
  return true;
};

export const forgetPendingCanvasCreateArticleRequest = (
  requests: PendingCanvasCreateArticleRequests,
  key: string,
) => requests.delete(key);

export const readPendingCanvasCreateArticleRequests = (
  storage: SessionStorageLike | null | undefined,
  ownerId: number,
): PendingCanvasCreateArticleRequests => {
  const requests: PendingCanvasCreateArticleRequests = new Map();
  if (!storage || !isPositiveSafeInteger(ownerId)) return requests;
  const storageKey = storageKeyForOwner(ownerId);
  try {
    const raw = storage.getItem(storageKey);
    if (!raw) return requests;
    if (raw.length > CANVAS_CREATE_ARTICLE_REQUEST_MAX_STORAGE_CHARS) {
      storage.removeItem(storageKey);
      return requests;
    }
    const payload = JSON.parse(raw) as {
      version?: unknown;
      ownerId?: unknown;
      entries?: unknown;
    };
    if (
      payload?.version !== CANVAS_CREATE_ARTICLE_REQUEST_STORAGE_VERSION
      || payload.ownerId !== ownerId
      || !Array.isArray(payload.entries)
    ) {
      storage.removeItem(storageKey);
      return requests;
    }
    for (const item of payload.entries) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const entry = item as Record<string, unknown>;
      if (
        !isValidRequestKey(entry.key)
        || !isValidRequestId(entry.requestId)
        || !Number.isSafeInteger(entry.updatedAt)
        || Number(entry.updatedAt) <= 0
      ) continue;
      const current = requests.get(entry.key);
      if (!current || Number(entry.updatedAt) >= current.updatedAt) {
        requests.set(entry.key, {
          requestId: entry.requestId,
          updatedAt: Number(entry.updatedAt),
        });
      }
    }
    normalizePendingRequests(requests);
  } catch {
    try {
      storage.removeItem(storageKey);
    } catch {
      // sessionStorage may be unavailable; the in-memory map remains usable.
    }
  }
  return requests;
};

export const persistPendingCanvasCreateArticleRequests = (
  storage: SessionStorageLike | null | undefined,
  ownerId: number,
  requests: PendingCanvasCreateArticleRequests,
) => {
  if (!storage || !isPositiveSafeInteger(ownerId)) return false;
  const storageKey = storageKeyForOwner(ownerId);
  const entries = normalizePendingRequests(requests);
  try {
    if (entries.length === 0) {
      storage.removeItem(storageKey);
      return true;
    }
    storage.setItem(storageKey, JSON.stringify({
      version: CANVAS_CREATE_ARTICLE_REQUEST_STORAGE_VERSION,
      ownerId,
      entries: entries.map(([key, value]) => ({ key, ...value })),
    }));
    return true;
  } catch {
    return false;
  }
};

const NON_REUSABLE_CANVAS_CREATE_ARTICLE_CODES = new Set([
  'CANVAS_RUN_ATTEMPTS_EXHAUSTED',
  'CANVAS_REQUEST_ID_REUSED',
]);

export const shouldReplaceCanvasCreateArticleRequestId = (code: unknown) => (
  typeof code === 'string' && NON_REUSABLE_CANVAS_CREATE_ARTICLE_CODES.has(code)
);
