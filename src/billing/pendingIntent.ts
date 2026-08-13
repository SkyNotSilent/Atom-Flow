import type { BillingPendingIntent } from '../types';

const STORAGE_KEY = 'atomflow:billing-pending-intent:v1';
const MAX_AGE_MS = 30 * 60 * 1000;

export interface StoredBillingIntent {
  version: 1;
  userId: number | null;
  requestId: string;
  createdAt: number;
  expiresAt: number;
  intent: BillingPendingIntent;
}

const validPositiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

const sanitizeIntent = (value: unknown): BillingPendingIntent | null => {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === 'open_write') return { kind: 'open_write' };
  if (candidate.kind === 'open_project' && validPositiveInteger(candidate.projectId)) {
    return { kind: 'open_project', projectId: candidate.projectId };
  }
  if (candidate.kind !== 'add_podcast_episode' || typeof candidate.episodeId !== 'string' || !candidate.episodeId.trim()) return null;
  return {
    kind: 'add_podcast_episode',
    episodeId: candidate.episodeId.slice(0, 256),
    ...(validPositiveInteger(candidate.articleId) ? { articleId: candidate.articleId } : {}),
    ...(validPositiveInteger(candidate.savedArticleId) ? { savedArticleId: candidate.savedArticleId } : {}),
    ...(typeof candidate.sourceUrl === 'string' && /^https?:\/\//i.test(candidate.sourceUrl) ? { sourceUrl: candidate.sourceUrl.slice(0, 2048) } : {}),
    ...(validPositiveInteger(candidate.preferredProjectId) ? { preferredProjectId: candidate.preferredProjectId } : {}),
  };
};

export const createBillingRequestId = () => crypto.randomUUID();

export const storeBillingIntent = (intent: BillingPendingIntent, userId: number | null): StoredBillingIntent => {
  const now = Date.now();
  const stored: StoredBillingIntent = {
    version: 1,
    userId,
    requestId: createBillingRequestId(),
    createdAt: now,
    expiresAt: now + MAX_AGE_MS,
    intent,
  };
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // The immediate login action still works when session storage is blocked.
  }
  return stored;
};

export const readBillingIntent = (currentUserId: number | null): StoredBillingIntent | null => {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredBillingIntent>;
    const intent = sanitizeIntent(parsed.intent);
    if (parsed.version !== 1 || !intent || typeof parsed.requestId !== 'string' || !parsed.requestId || !Number.isFinite(parsed.expiresAt)) {
      window.sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    if (Number(parsed.expiresAt) <= Date.now()) {
      window.sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    if (parsed.userId !== null && parsed.userId !== currentUserId) {
      window.sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return { ...parsed, version: 1, userId: parsed.userId ?? null, intent } as StoredBillingIntent;
  } catch {
    window.sessionStorage.removeItem(STORAGE_KEY);
    return null;
  }
};

export const bindBillingIntentToUser = (userId: number): StoredBillingIntent | null => {
  const stored = readBillingIntent(userId);
  if (!stored) return null;
  const bound = { ...stored, userId };
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(bound));
  } catch {
    return stored;
  }
  return bound;
};

export const clearBillingIntent = (requestId?: string) => {
  if (!requestId) {
    window.sessionStorage.removeItem(STORAGE_KEY);
    return;
  }
  const current = readBillingIntent(null);
  if (!current || current.requestId === requestId) window.sessionStorage.removeItem(STORAGE_KEY);
};
