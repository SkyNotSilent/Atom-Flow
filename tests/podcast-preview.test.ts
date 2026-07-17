import assert from "node:assert/strict";
import type { Article, SavedArticle } from "../src/types";
import {
  buildPodcastPreviewItems,
  filterPodcastItems,
  resolvePodcastPageGate,
} from "../src/components/podcast/podcastPreview";

const now = new Date(2026, 6, 17, 12, 0, 0).getTime();
const baseArticle = (patch: Partial<Article>): Article => ({
  id: 11,
  saved: false,
  source: "产品沉思录",
  topic: "产品",
  time: "今天 09:30",
  publishedAt: now - 30 * 60 * 1000,
  title: "为什么产品需要慢思考",
  excerpt: "<p>这是 RSS 提供的摘要，不是逐字稿。</p>",
  content: "",
  cards: [],
  ...patch,
});

const articles: Article[] = [
  baseArticle({
    id: 11,
    title: "真实播客",
    url: "https://example.com/podcast",
    audioUrl: "https://cdn.example.com/episode.mp3",
    audioDuration: "25:12",
  }),
  baseArticle({ id: 12, title: "待解读文章", url: "https://example.com/article" }),
];

const savedArticles: SavedArticle[] = [
  {
    id: 201,
    title: "待解读文章",
    url: "https://example.com/article",
    source: "产品沉思录",
    topic: "产品",
    excerpt: "收藏版本摘要",
    sourceImages: ["https://cdn.example.com/article-cover.jpg"],
    publishedAt: now - 40 * 60 * 1000,
    savedAt: new Date(now - 20 * 60 * 1000).toISOString(),
  },
  {
    id: 202,
    title: "只存在于收藏中的旧文章",
    url: "https://example.com/saved-only",
    source: "少数派",
    topic: "效率",
    excerpt: "旧收藏仍可进入为你生成候选。",
    publishedAt: now - 20 * 24 * 60 * 60 * 1000,
    savedAt: new Date(now - 10 * 60 * 1000).toISOString(),
  },
];

const items = buildPodcastPreviewItems(articles, savedArticles);
assert.equal(items.length, 3);

const native = items.find(item => item.articleId === 11);
assert.equal(native?.kind, "native_episode");
assert.equal(native?.audioUrl, "https://cdn.example.com/episode.mp3");
assert.equal(native?.audioDuration, "25:12");
assert.equal(native?.contextBasis, "rss_summary");

const matched = items.find(item => item.articleId === 12);
assert.equal(matched?.kind, "article_pending");
assert.equal(matched?.savedArticleId, 201);
assert.equal(matched?.isSaved, true);
assert.equal(matched?.imageUrl, "https://cdn.example.com/article-cover.jpg");
assert.equal(matched?.audioUrl, undefined);

const savedOnly = items.find(item => item.savedArticleId === 202);
assert.equal(savedOnly?.origin, "saved");
assert.equal(savedOnly?.articleId, undefined);
assert.equal(savedOnly?.isSaved, true);
assert.equal(savedOnly?.kind, "article_pending");

assert.equal(filterPodcastItems(items, "for_you", "today", now).length, 3);
assert.deepEqual(filterPodcastItems(items, "short", "today", now), []);
assert.deepEqual(filterPodcastItems(items, "quick", "today", now), []);
assert.deepEqual(filterPodcastItems(items, "deep", "today", now), []);

assert.equal(resolvePodcastPageGate({ isAuthLoading: true, isSignedIn: false, isArticlesLoading: true, articlesError: null, itemCount: 0 }), "auth_loading");
assert.equal(resolvePodcastPageGate({ isAuthLoading: false, isSignedIn: false, isArticlesLoading: false, articlesError: null, itemCount: 0 }), "signed_out");
assert.equal(resolvePodcastPageGate({ isAuthLoading: false, isSignedIn: true, isArticlesLoading: true, articlesError: null, itemCount: 0 }), "loading");
assert.equal(resolvePodcastPageGate({ isAuthLoading: false, isSignedIn: true, isArticlesLoading: false, articlesError: "请求失败", itemCount: 0 }), "error");
assert.equal(resolvePodcastPageGate({ isAuthLoading: false, isSignedIn: true, isArticlesLoading: false, articlesError: null, itemCount: 0 }), "empty");
assert.equal(resolvePodcastPageGate({ isAuthLoading: false, isSignedIn: true, isArticlesLoading: false, articlesError: null, itemCount: 3 }), "ready");

console.log("PASS: podcast preview data remains real, stable, and capability-honest");
