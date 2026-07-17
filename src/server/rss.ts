import type { Article } from "../types.js";

export interface BuiltInRssFeedDefinition {
  key: string;
  logName: string;
  source: string;
  topic: string;
  idOffset: number;
  urls: readonly string[];
}

export const BUILTIN_RSS_FEEDS: readonly BuiltInRssFeedDefinition[] = [
  { key: "sspai", logName: "sspai", source: "少数派", topic: "科技资讯", idOffset: 0, urls: ["rsshub://sspai/index"] },
  { key: "woshipm", logName: "woshipm", source: "人人都是产品经理", topic: "产品运营", idOffset: 1000, urls: ["https://www.woshipm.com/feed", "rsshub://woshipm/popular"] },
  { key: "kr36", logName: "36kr", source: "36氪", topic: "创投商业", idOffset: 2000, urls: ["rsshub://36kr/hot-list", "https://36kr.com/feed", "rsshub://36kr/news"] },
  { key: "huxiu", logName: "huxiu", source: "虎嗅", topic: "商业资讯", idOffset: 3000, urls: ["https://www.huxiu.com/rss/0.xml", "rsshub://huxiu/article"] },
  { key: "zslren", logName: "zslren", source: "数字生命卡兹克", topic: "公众号", idOffset: 4000, urls: ["https://wechat2rss.bestblogs.dev/feed/ff621c3e98d6ae6fceb3397e57441ffc6ea3c17f.xml"] },
  { key: "xzy", logName: "xzy", source: "新智元", topic: "公众号", idOffset: 4500, urls: ["https://plink.anyfeeder.com/weixin/AI_era"] },
  { key: "jike", logName: "jike topic", source: "即刻话题", topic: "Jike", idOffset: 6000, urls: ["rsshub://jike/topic/63579abb6724cc583b9bba9a"] },
  { key: "github", logName: "GitHub Blog", source: "GitHub Blog", topic: "Tech", idOffset: 7000, urls: ["https://github.blog/feed/"] },
  { key: "sama", logName: "Sam Altman", source: "Sam Altman", topic: "Official Blog", idOffset: 8000, urls: ["https://blog.samaltman.com/posts.atom", "rsshub://twitter/user/sama"] },
  { key: "xyzfm", logName: "张小珺商业访谈录", source: "张小珺商业访谈录", topic: "Podcast", idOffset: 9000, urls: ["https://feed.xyzfm.space/dk4yh3pkpjp3"] },
  { key: "lex", logName: "Lex Fridman", source: "Lex Fridman", topic: "Podcast", idOffset: 10000, urls: ["rsshub://youtube/user/%40lexfridman", "https://www.youtube.com/feeds/videos.xml?channel_id=UCSHZKyawb77ixDdsGog4iWA"] },
  { key: "yc", logName: "Y Combinator", source: "Y Combinator", topic: "YouTube", idOffset: 11000, urls: ["rsshub://youtube/user/%40ycombinator", "https://www.youtube.com/feeds/videos.xml?channel_id=UCcefcZRL2oaA_uBNeo5UOWg"] },
  { key: "karpathy", logName: "Andrej Karpathy", source: "Andrej Karpathy", topic: "YouTube", idOffset: 12000, urls: ["rsshub://youtube/user/@AndrejKarpathy", "https://www.youtube.com/feeds/videos.xml?channel_id=UCYO_jab_esuFRV4b17AJtAw"] },
  { key: "aiHotSelected", logName: "AI HOT 精选", source: "AI HOT 精选", topic: "AI 资讯", idOffset: 13000, urls: ["https://aihot.virxact.com/feed.xml"] },
  { key: "aiHotAll", logName: "AI HOT 全部", source: "AI HOT 全部", topic: "AI 资讯", idOffset: 14000, urls: ["https://aihot.virxact.com/feed/all.xml"] },
];

const TRACKING_QUERY_PARAMS = new Set(["fbclid", "gclid", "igshid", "mc_cid", "mc_eid", "ref", "spm"]);

export function normalizeArticleUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_") || TRACKING_QUERY_PARAMS.has(key.toLowerCase())) {
        parsed.searchParams.delete(key);
      }
    }
    parsed.searchParams.sort();
    return parsed.href.replace(/\/$/, "");
  } catch {
    return url;
  }
}

export function stableArticleId(
  source: string,
  item: { guid?: string; link?: string; title?: string; pubDate?: string },
  idOffset: number,
  index: number,
) {
  const normalizedLink = normalizeArticleUrl(item.link);
  const key = normalizedLink
    ? `url|${normalizedLink}`
    : item.guid
      ? `guid|${item.guid}`
      : item.title || item.pubDate
        ? ["content", source, item.title || "", item.pubDate || ""].join("|")
        : ["fallback", source, idOffset, index].join("|");
  let hash = 2166136261;
  for (let offset = 0; offset < key.length; offset += 1) {
    hash ^= key.charCodeAt(offset);
    hash = Math.imul(hash, 16777619);
  }
  return 1_000_000_000_000 + (hash >>> 0);
}

const LEGACY_MOCK_ARTICLE_KEYS = new Set([
  "少数派\t为什么你的收藏夹是一个知识坟墓？",
  "虎嗅网\t中国内容创作者的变现困境：流量有了，钱在哪里？",
  "科技爱好者周刊\t用 AI 写的文章，为什么一眼就能看出来？",
  "少数派\t第二大脑的幻觉：我们为什么建了知识库却不用它？",
  "虎嗅网\tNewsletter 的复兴：当读者愿意为内容付费",
  "科技爱好者周刊\t输入决定输出：为什么大量阅读是创作的基础设施",
]);

const articleSources = (article: Article) => new Set([article.source, ...(article.sourceAliases || [])]);

export function mergeArticleSourceMemberships(input: Article[]): Article[] {
  const merged: Article[] = [];
  const indexByIdentity = new Map<string, number>();

  for (const article of input) {
    const normalizedUrl = normalizeArticleUrl(article.url);
    const identity = normalizedUrl ? `url:${normalizedUrl}` : `id:${article.id}`;
    const existingIndex = indexByIdentity.get(identity);
    if (existingIndex === undefined) {
      indexByIdentity.set(identity, merged.length);
      merged.push(article);
      continue;
    }
    const existing = merged[existingIndex];
    const memberships = new Set([...articleSources(existing), ...articleSources(article)]);
    memberships.delete(existing.source);
    merged[existingIndex] = { ...existing, sourceAliases: [...memberships] };
  }

  return merged;
}

export function mergeWithSourceFallback(previous: Article[], next: Article[]): Article[] {
  const nextSources = new Set(next.flatMap(article => [...articleSources(article)]));
  const fallback = previous.flatMap(article => {
    const missingSources = [...articleSources(article)].filter(source => !nextSources.has(source));
    if (missingSources.length === 0) return [];
    const source = missingSources.includes(article.source) ? article.source : missingSources[0];
    return [{ ...article, source, sourceAliases: missingSources.filter(item => item !== source) }];
  });
  const combined = mergeArticleSourceMemberships([...next, ...fallback]);
  const unique = new Map<string, Article>();
  for (const article of combined) {
    const normalizedUrl = normalizeArticleUrl(article.url);
    const key = normalizedUrl ? `url:${normalizedUrl}` : `st:${article.source}:${article.title}`;
    if (!unique.has(key)) unique.set(key, article);
  }
  return [...unique.values()];
}

export function removeLegacyMockArticles(input: Article[]): Article[] {
  return input.filter(article => article.url || !LEGACY_MOCK_ARTICLE_KEYS.has(`${article.source}\t${article.title}`));
}

export function sanitizeGlobalArticleCache(input: Article[]): Article[] {
  return removeLegacyMockArticles(input).map(article => ({ ...article, saved: false, cards: [] }));
}

export function createSerializedTaskQueue<T>(task: (value: T) => Promise<void>) {
  let tail = Promise.resolve();
  return (value: T): Promise<void> => {
    const run = tail.then(() => task(value));
    tail = run.catch(() => undefined);
    return run;
  };
}

export function collectSettledFeedArticles<TFeed>(
  definitions: readonly BuiltInRssFeedDefinition[],
  results: readonly PromiseSettledResult<TFeed>[],
  normalize: (feed: TFeed, definition: BuiltInRssFeedDefinition) => Article[],
) {
  if (definitions.length !== results.length) {
    throw new Error("RSS feed definitions and results are out of sync");
  }

  const articles: Article[] = [];
  const articlesBySource: Record<string, Article[]> = {};
  const counts: Record<string, number> = {};
  const failures: Array<{ definition: BuiltInRssFeedDefinition; error: unknown }> = [];
  definitions.forEach((definition, index) => {
    const result = results[index];
    if (result.status === "fulfilled") {
      try {
        const normalized = normalize(result.value, definition);
        counts[definition.key] = normalized.length;
        articlesBySource[definition.key] = normalized;
        articles.push(...normalized);
      } catch (error) {
        counts[definition.key] = 0;
        articlesBySource[definition.key] = [];
        failures.push({ definition, error });
      }
      return;
    }
    counts[definition.key] = 0;
    articlesBySource[definition.key] = [];
    failures.push({ definition, error: result.reason });
  });

  return { articles: mergeArticleSourceMemberships(articles), articlesBySource, counts, failures };
}
