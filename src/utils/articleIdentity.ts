const TRACKING_QUERY_PARAMS = new Set([
  'dclid',
  'fbclid',
  'gclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  'msclkid',
]);

export interface ArticleIdentity {
  id?: number;
  url?: string;
  source?: string;
  title?: string;
}

export function findArticleByIdentity<T extends ArticleIdentity>(
  articles: T[],
  identity: ArticleIdentity,
): T | undefined {
  const sourceUrl = identity.url?.trim();
  if (sourceUrl) {
    return articles.find(article => article.url?.trim() === sourceUrl);
  }
  if (identity.source && identity.title) {
    return articles.find(article => article.source === identity.source && article.title === identity.title);
  }
  return identity.id === undefined
    ? undefined
    : articles.find(article => article.id === identity.id);
}

export function matchesArticleIdentity(
  article: ArticleIdentity | null | undefined,
  identity: ArticleIdentity | null | undefined,
): boolean {
  if (!article || !identity) return false;
  return findArticleByIdentity([article], identity) === article;
}

export function articleIdentityKey(identity: ArticleIdentity | null | undefined): string {
  if (!identity) return 'none';
  const sourceUrl = identity.url?.trim();
  if (sourceUrl) return `url:${sourceUrl}`;
  if (identity.source && identity.title) return `source:${identity.source}\u0000title:${identity.title}`;
  return identity.id === undefined ? 'unknown' : `id:${identity.id}`;
}

export function normalizeArticleUrl(url: string | undefined): string | undefined {
  const trimmedUrl = url?.trim();
  if (!trimmedUrl) return undefined;
  try {
    const parsed = new URL(trimmedUrl);
    const removableKeys = Array.from(parsed.searchParams.keys()).filter(key => {
      const normalizedKey = key.toLowerCase();
      return normalizedKey.startsWith('utm_') || TRACKING_QUERY_PARAMS.has(normalizedKey);
    });
    removableKeys.forEach(key => parsed.searchParams.delete(key));
    parsed.searchParams.sort();
    parsed.hash = '';
    if (parsed.pathname.length > 1) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    }
    return parsed.toString();
  } catch {
    return trimmedUrl;
  }
}
