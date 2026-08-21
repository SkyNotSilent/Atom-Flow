import type Parser from "rss-parser";
import type { Article } from "../types.js";
import { buildFeedExcerpt } from "./contentSecurity.js";
import { RSS_ARTICLE_CONTENT_MAX_BYTES, truncateUtf8 } from "./rssCache.js";
import { detectArticleContentFormat } from "../utils/articleContent.js";

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
  // markdownContent/fullFetched are stripped so a persisted cache can never smuggle
  // per-user full-text state into the process-global in-memory store at boot.
  return removeLegacyMockArticles(input).map(article => ({
    ...article,
    saved: false,
    cards: [],
    markdownContent: undefined,
    fullFetched: false,
  }));
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

const RSS_FEED_EXCERPT_SOURCE_BUDGET_CHARS = 64_000;

export function extractFeedIcon(parsed: Parser.Output<any>): string | undefined {
  // 尝试从多个可能的字段提取图标
  const feed = parsed as any;

  // iTunes podcast image
  if (feed.itunes?.image) return feed.itunes.image;

  // Standard RSS image
  if (feed.image?.url) return feed.image.url;

  // Atom feed icon
  if (feed.icon) return feed.icon;

  // Feed logo
  if (feed.logo) return feed.logo;

  // 从link提取favicon
  if (feed.link) {
    try {
      const url = new URL(feed.link);
      return `${url.origin}/favicon.ico`;
    } catch {
      // ignore
    }
  }

  return undefined;
}

export function getDefaultFeedLimit(source: string) {
  return source === '36氪' || source === '虎嗅' ? 8 : 12;
}

export function normalizeFeedItems(
  items: Parser.Item[],
  source: string,
  defaultTopic: string,
  idOffset: number,
  feedIcon?: string,
  options?: { maxItems?: number | null }
): Article[] {
  const maxItems = options?.maxItems === undefined ? getDefaultFeedLimit(source) : options.maxItems;
  const normalizedItems = maxItems === null ? items : items.slice(0, maxItems);
  const excerptSourceCharsPerItem = Math.min(
    512,
    Math.max(64, Math.floor(RSS_FEED_EXCERPT_SOURCE_BUDGET_CHARS / Math.max(1, normalizedItems.length))),
  );
  return normalizedItems.map((item, index) => {
    const rawContent = item['content:encoded'] || item.content || item.contentSnippet || '';
    const excerptText = buildFeedExcerpt(
      rawContent,
      item.contentSnippet,
      item.title,
      excerptSourceCharsPerItem,
      120,
    );
    const excerpt = excerptText ? `${excerptText}...` : "";
    const topic = (item.categories && item.categories.length > 0) ? item.categories[0] : defaultTopic;
    let timeStr = '刚刚';
    const date = item.pubDate ? new Date(item.pubDate) : null;
    if (date) {
      const now = new Date();
      if (date.toDateString() === now.toDateString()) {
        timeStr = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      } else {
        timeStr = `${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`;
      }
    }
    const publishedAt = date ? date.getTime() : Date.now() - index;

    // 提取音频信息（播客）
    const enclosure = item.enclosure;
    const audioUrl = enclosure?.url;
    const audioDuration = (item as any).itunes?.duration;

    return {
      id: stableArticleId(source, item, idOffset, index),
      saved: false,
      source,
      sourceIcon: feedIcon,
      topic,
      time: timeStr,
      publishedAt,
      title: item.title || '无标题',
      excerpt,
      content: truncateUtf8(rawContent, RSS_ARTICLE_CONTENT_MAX_BYTES),
      contentFormat: detectArticleContentFormat(rawContent),
      url: item.link,
      audioUrl,
      audioDuration,
      cards: []
    };
  });
}

export function mergeArticles(previous: Article[], next: Article[]): Article[] {
  const prevByUrl = new Map(previous.flatMap(article => {
    const normalizedUrl = normalizeArticleUrl(article.url);
    return normalizedUrl ? [[normalizedUrl, article] as const] : [];
  }));
  return next.map(article => {
    const normalizedUrl = normalizeArticleUrl(article.url);
    const prev = normalizedUrl ? prevByUrl.get(normalizedUrl) : undefined;
    if (!prev) return article;
    return {
      ...article,
      id: prev.id,
      saved: prev.saved,
      cards: prev.cards,
      fullFetched: prev.fullFetched,
      markdownContent: prev.markdownContent,
      contentFormat: prev.contentFormat || article.contentFormat,
      readabilityUsed: prev.readabilityUsed
    };
  });
}

const SOURCE_PRIORITY: Record<string, number> = {
  '36氪': 5.5,
  'AI HOT 精选': 5.0,
  'AI HOT 全部': 4.9,
  'Lex Fridman': 4.8,
  'Y Combinator': 4.6,
  'Andrej Karpathy': 4.4,
  'GitHub Blog': 4.2,
  'Sam Altman': 4.0,
  '张小珺商业访谈录': 3.8,
  '数字生命卡兹克': 3.8,
  '新智元': 3.8,
  '人人都是产品经理': 2.5,
  '即刻话题': 1.5,
  '少数派': 1.2,
  '虎嗅': 0
};

const LOW_PRIORITY_SOURCES = new Set(['少数派', '即刻话题']);

function getPriority(article: Article) {
  if (SOURCE_PRIORITY[article.source] !== undefined) return SOURCE_PRIORITY[article.source];
  if (article.topic === '公众号') return 3.4;
  return 2.5;
}

export function rankArticles(articles: Article[]) {
  const sorted = [...articles].sort((a, b) => {
    const pa = getPriority(a);
    const pb = getPriority(b);
    if (pb !== pa) return pb - pa;
    return (b.publishedAt ?? 0) - (a.publishedAt ?? 0);
  });
  const low = sorted.filter(item => LOW_PRIORITY_SOURCES.has(item.source));
  const rest = sorted.filter(item => !LOW_PRIORITY_SOURCES.has(item.source));
  const promotedLow = low.slice(0, 2);
  const remainingLow = low.slice(2);
  const positions = [2, 7];
  const limit = Math.min(promotedLow.length, positions.length);
  for (let i = 0; i < limit; i += 1) {
    const pos = Math.min(positions[i], rest.length);
    rest.splice(pos, 0, promotedLow[i]);
  }
  const combined = [...rest, ...remainingLow];

  // 增加随机性：一半文章按优先级排序，一半随机打乱
  const halfPoint = Math.floor(combined.length / 2);
  const prioritized = combined.slice(0, halfPoint);
  const randomized = combined.slice(halfPoint);

  // Fisher-Yates 洗牌算法
  for (let i = randomized.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [randomized[i], randomized[j]] = [randomized[j], randomized[i]];
  }

  return [...prioritized, ...randomized];
}

export function buildHomepageTimeline(fullArticles: Article[]): Article[] {
  const selected = BUILTIN_RSS_FEEDS.flatMap(feed => fullArticles
    .filter(article => article.source === feed.source || article.sourceAliases?.includes(feed.source))
    .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))
    .slice(0, getDefaultFeedLimit(feed.source)));
  return rankArticles(mergeArticleSourceMemberships(selected));
}
