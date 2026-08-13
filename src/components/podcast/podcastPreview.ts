import type { Article, SavedArticle } from "../../types";
import { getDisplaySource } from "../../utils/articleDisplay";
import { htmlToPlainText } from "../../utils/htmlToPlainText";

export type PodcastFilter = "for_you" | "short" | "quick" | "deep";
export type PodcastDateRange = "today" | "three_days";
export type PodcastPreviewKind = "native_episode" | "article_pending";
export type PodcastPreviewOrigin = "subscription" | "saved";
export type PodcastPageGate = "auth_loading" | "signed_out" | "loading" | "error" | "empty" | "ready";

export interface PodcastPreviewItem {
  id: string;
  articleId?: number;
  savedArticleId?: number;
  origin: PodcastPreviewOrigin;
  kind: PodcastPreviewKind;
  title: string;
  source: string;
  topic: string;
  publishedAt: string;
  publishedAtMs?: number;
  timeLabel: string;
  summary: string;
  contextBasis: "rss_summary";
  imageUrl?: string;
  sourceUrl?: string;
  audioUrl?: string;
  audioDuration?: string;
  isSaved: boolean;
}

interface PodcastPageGateInput {
  isAuthLoading: boolean;
  isSignedIn: boolean;
  isArticlesLoading: boolean;
  articlesError: string | null;
  itemCount: number;
}

const normalize = (value?: string) => (value || "").trim();
const itemKey = (url: string | undefined, source: string, title: string) =>
  normalize(url)
    ? `url:${normalize(url)}`
    : `title:${normalize(source).toLocaleLowerCase()}::${normalize(title).toLocaleLowerCase()}`;
const previewItemId = (article: Article, source: string) =>
  `article:${article.id}:${encodeURIComponent(itemKey(article.url, source, article.title))}`;

const textSummary = (value?: string) => {
  const text = htmlToPlainText(normalize(value));
  return text || "该来源没有提供可展示的 RSS 摘要。";
};

const isoOrEmpty = (value?: number | string) => {
  if (value === undefined || value === "") return "";
  const time = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : "";
};

const timestampOf = (value?: number | string) => {
  if (value === undefined || value === "") return undefined;
  const time = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
};

const matchSavedArticle = (article: Article, savedArticles: SavedArticle[]) => {
  const source = getDisplaySource(article);
  const key = itemKey(article.url, source, article.title);
  return savedArticles.find(saved => itemKey(saved.url, saved.source, saved.title) === key);
};

export function buildPodcastPreviewItems(
  articles: Article[],
  savedArticles: SavedArticle[],
): PodcastPreviewItem[] {
  const consumedSavedIds = new Set<number>();
  const subscriptionItems = articles.map(article => {
    const saved = matchSavedArticle(article, savedArticles);
    if (saved) consumedSavedIds.add(saved.id);
    const audioUrl = normalize(article.audioUrl) || normalize(saved?.audioUrl) || undefined;
    const source = getDisplaySource(article);
    return {
      id: previewItemId(article, source),
      articleId: article.id,
      savedArticleId: saved?.id,
      origin: "subscription" as const,
      kind: audioUrl ? "native_episode" as const : "article_pending" as const,
      title: normalize(article.title) || "未命名内容",
      source,
      topic: normalize(article.topic) || "未分类",
      publishedAt: isoOrEmpty(article.publishedAt),
      publishedAtMs: timestampOf(article.publishedAt),
      timeLabel: normalize(article.time) || "时间未知",
      summary: textSummary(article.excerpt),
      contextBasis: "rss_summary" as const,
      imageUrl: article.sourceImages?.[0] || saved?.sourceImages?.[0] || article.sourceIcon,
      sourceUrl: normalize(article.url) || saved?.url,
      audioUrl,
      audioDuration: audioUrl
        ? normalize(article.audioDuration) || normalize(saved?.audioDuration) || undefined
        : undefined,
      isSaved: article.saved || Boolean(saved),
    };
  });

  const savedOnlyItems = savedArticles
    .filter(saved => !consumedSavedIds.has(saved.id))
    .map(saved => {
      const publishedAtMs = timestampOf(saved.publishedAt ?? saved.savedAt);
      const audioUrl = normalize(saved.audioUrl) || undefined;
      return {
        id: `saved:${saved.id}`,
        savedArticleId: saved.id,
        origin: "saved" as const,
        kind: audioUrl ? "native_episode" as const : "article_pending" as const,
        title: normalize(saved.title) || "未命名收藏",
        source: normalize(saved.source) || "未知来源",
        topic: normalize(saved.topic) || "未分类",
        publishedAt: isoOrEmpty(saved.publishedAt ?? saved.savedAt),
        publishedAtMs,
        timeLabel: "来自我的收藏",
        summary: textSummary(saved.excerpt),
        contextBasis: "rss_summary" as const,
        imageUrl: saved.sourceImages?.[0] || saved.sourceIcon,
        sourceUrl: normalize(saved.url) || undefined,
        audioUrl,
        audioDuration: audioUrl ? normalize(saved.audioDuration) || undefined : undefined,
        isSaved: true,
      };
    });

  return [...subscriptionItems, ...savedOnlyItems].sort((left, right) =>
    (right.publishedAtMs ?? 0) - (left.publishedAtMs ?? 0)
  );
}

export function filterPodcastItems(
  items: PodcastPreviewItem[],
  filter: PodcastFilter,
  range: PodcastDateRange,
  now = Date.now(),
): PodcastPreviewItem[] {
  if (filter !== "for_you") return [];
  const localStart = new Date(now);
  localStart.setHours(0, 0, 0, 0);
  const threshold = range === "today" ? localStart.getTime() : now - 3 * 24 * 60 * 60 * 1000;
  return items.filter(item => item.origin === "saved" || item.publishedAtMs === undefined || item.publishedAtMs >= threshold);
}

export function resolvePodcastPageGate(input: PodcastPageGateInput): PodcastPageGate {
  if (input.isAuthLoading) return "auth_loading";
  if (!input.isSignedIn) return "signed_out";
  if (input.isArticlesLoading && input.itemCount === 0) return "loading";
  if (input.articlesError && input.itemCount === 0) return "error";
  if (input.itemCount === 0) return "empty";
  return "ready";
}
