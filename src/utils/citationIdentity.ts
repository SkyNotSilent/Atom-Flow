import { normalizeArticleUrl } from './articleIdentity';

export interface CitationIdentityInput {
  articleId?: number;
  articleTitle?: string;
  source?: string;
  sourceUrl?: string;
}

export interface CitationCaptureIdentityInput extends CitationIdentityInput {
  exact: string;
  prefix: string;
  suffix: string;
  paragraph: string;
  heading?: string | null;
}

/**
 * A citation must survive the feed article becoming a saved article. URLs are
 * therefore canonical when available; without one, the source-scoped article
 * id is preferred so a later title edit does not change the identity.
 */
export function citationArticleIdentity(input: CitationIdentityInput): string {
  const normalizedUrl = normalizeArticleUrl(input.sourceUrl);
  if (normalizedUrl) return `url:${normalizedUrl}`;

  const source = input.source?.trim() || '';
  if (Number.isSafeInteger(input.articleId)) {
    return source
      ? `source:${source}\u0000article-id:${input.articleId}`
      : `article-id:${input.articleId}`;
  }

  const title = input.articleTitle?.trim() || '';
  if (source && title) return `source:${source}\u0000title:${title}`;
  return title ? `title:${title}` : 'article:unknown';
}

export function stableCitationCaptureId(input: CitationCaptureIdentityInput): string {
  const identity = citationArticleIdentity(input);
  const fingerprint = [
    identity,
    input.exact,
    input.prefix,
    input.suffix,
    input.paragraph,
    input.heading || '',
  ].join('\u0000');
  // Four independently seeded 32-bit lanes keep the browser implementation
  // synchronous while making accidental capture-id collisions negligible.
  const hashes = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  for (let index = 0; index < fingerprint.length; index += 1) {
    const code = fingerprint.charCodeAt(index);
    for (let lane = 0; lane < hashes.length; lane += 1) {
      hashes[lane] = Math.imul((hashes[lane] ^ code ^ lane) >>> 0, 16777619 + lane * 2) >>> 0;
    }
  }
  return `capture-${hashes.map(hash => hash.toString(16).padStart(8, '0')).join('')}`;
}
