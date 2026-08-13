import type { BillingPendingIntent } from '../types';

const MAX_AGE_MS = 30 * 60 * 1000;
let pendingIntent: StoredBillingIntent | null = null;

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
  const sanitizedIntent = sanitizeIntent(intent);
  if (!sanitizedIntent) throw new TypeError('Unsupported billing intent');
  const now = Date.now();
  const stored: StoredBillingIntent = {
    version: 1,
    userId,
    requestId: createBillingRequestId(),
    createdAt: now,
    expiresAt: now + MAX_AGE_MS,
    intent: sanitizedIntent,
  };
  pendingIntent = stored;
  return stored;
};

export const readBillingIntent = (currentUserId: number | null): StoredBillingIntent | null => {
  const stored = pendingIntent;
  if (!stored) return null;
  if (stored.expiresAt <= Date.now()) {
    pendingIntent = null;
    return null;
  }
  if (stored.userId !== null && stored.userId !== currentUserId) {
    pendingIntent = null;
    return null;
  }
  return stored;
};

export const bindBillingIntentToUser = (userId: number): StoredBillingIntent | null => {
  const stored = readBillingIntent(userId);
  if (!stored) return null;
  const bound = { ...stored, userId };
  pendingIntent = bound;
  return bound;
};

export const clearBillingIntent = (requestId?: string) => {
  if (!requestId) {
    pendingIntent = null;
    return;
  }
  if (!pendingIntent || pendingIntent.requestId === requestId) pendingIntent = null;
};
