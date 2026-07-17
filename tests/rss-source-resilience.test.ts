import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Article } from "../src/types.js";
import { sourceMatches } from "../src/utils/articleDisplay.js";
import {
  BUILTIN_RSS_FEEDS,
  collectSettledFeedArticles,
  createSerializedTaskQueue,
  mergeArticleSourceMemberships,
  mergeWithSourceFallback,
  normalizeArticleUrl,
  removeLegacyMockArticles,
  sanitizeGlobalArticleCache,
  stableArticleId,
} from "../src/server/rss.js";

const root = process.cwd();
const server = readFileSync(path.join(root, "server.ts"), "utf8");
const savedStateResolver = server.slice(
  server.indexOf("async function applyUserSavedStateToArticles"),
  server.indexOf("const SOURCE_PRIORITY"),
);
let nextArticleId = 1;
const article = (source: string, title: string, url?: string): Article => ({
  id: nextArticleId++,
  saved: false,
  source,
  topic: "test",
  time: "刚刚",
  publishedAt: Date.now(),
  title,
  excerpt: title,
  content: title,
  url,
  cards: [],
});

const aiHotDefinitions = BUILTIN_RSS_FEEDS.filter(feed => feed.source.startsWith("AI HOT"));
const samAltmanDefinition = BUILTIN_RSS_FEEDS.find(feed => feed.source === "Sam Altman");
assert.equal(samAltmanDefinition?.urls[0], "https://blog.samaltman.com/posts.atom");
assert.equal(samAltmanDefinition?.urls.includes("rsshub://twitter/user/sama"), true);
assert.deepEqual(
  aiHotDefinitions.map(feed => [feed.source, feed.urls[0]]),
  [
    ["AI HOT 精选", "https://aihot.virxact.com/feed.xml"],
    ["AI HOT 全部", "https://aihot.virxact.com/feed/all.xml"],
  ],
);
assert.equal(
  stableArticleId("AI HOT 精选", { link: "https://example.com/shared/?utm_source=selected", title: "shared" }, 13000, 0),
  stableArticleId("AI HOT 全部", { link: "https://example.com/shared#all", title: "shared" }, 14000, 9),
  "The same linked article must keep one ID across feed membership changes",
);
assert.equal(
  stableArticleId("No-link feed", { guid: "stable-guid", title: "shared" }, 100, 0),
  stableArticleId("No-link feed", { guid: "stable-guid", title: "shared" }, 100, 7),
  "A GUID-backed article ID must not depend on feed order",
);
assert.equal(
  stableArticleId("AI HOT 精选", { guid: "stable-guid", title: "shared" }, 13000, 0),
  stableArticleId("AI HOT 全部", { guid: "stable-guid", title: "shared" }, 14000, 7),
  "A GUID-backed article ID must not depend on feed membership",
);
const sharedGuidId = stableArticleId("AI HOT 精选", { guid: "shared-guid" }, 13000, 0);
const mergedGuidArticles = mergeArticleSourceMemberships([
  { ...article("AI HOT 精选", "shared-guid"), id: sharedGuidId, url: undefined },
  { ...article("AI HOT 全部", "shared-guid"), id: sharedGuidId, url: undefined },
]);
assert.equal(mergedGuidArticles.length, 1, "The same URL-less GUID article must not create duplicate node IDs");
assert.deepEqual(mergedGuidArticles[0].sourceAliases, ["AI HOT 全部"]);
assert.equal(
  normalizeArticleUrl("https://Example.com/article/?utm_source=rss&ref=home#section"),
  "https://example.com/article",
);
assert.notEqual(
  normalizeArticleUrl("https://www.youtube.com/watch?v=video-one"),
  normalizeArticleUrl("https://www.youtube.com/watch?v=video-two"),
  "Semantic query parameters must remain part of article identity",
);

const fulfilledResults: PromiseSettledResult<{ items: string[] }>[] = [
  { status: "fulfilled", value: { items: ["selected"] } },
  { status: "fulfilled", value: { items: ["all-1", "all-2"] } },
];
const fulfilled = collectSettledFeedArticles(
  aiHotDefinitions,
  fulfilledResults,
  (feed, definition) => feed.items.map(title => article(definition.source, title, `https://example.com/${title}`)),
);
assert.deepEqual(fulfilled.counts, { aiHotSelected: 1, aiHotAll: 2 });
assert.deepEqual(fulfilled.articles.map(item => item.source), ["AI HOT 精选", "AI HOT 全部", "AI HOT 全部"]);
assert.ok(fulfilled.articlesBySource, "The collector must expose complete per-source results");
assert.deepEqual(
  fulfilled.articlesBySource.aiHotAll.map(item => item.title),
  ["all-1", "all-2"],
  "The collector must retain complete per-source results for source detail views",
);
assert.deepEqual(fulfilled.failures, []);

const isolatedFailure = collectSettledFeedArticles(
  aiHotDefinitions,
  [
    { status: "rejected", reason: new Error("selected unavailable") },
    { status: "fulfilled", value: { items: ["all-still-works"] } },
  ],
  (feed, definition) => feed.items.map(title => article(definition.source, title, `https://example.com/${title}`)),
);
assert.deepEqual(isolatedFailure.counts, { aiHotSelected: 0, aiHotAll: 1 });
assert.deepEqual(isolatedFailure.articles.map(item => item.source), ["AI HOT 全部"]);
assert.equal(isolatedFailure.failures.length, 1);
assert.equal(isolatedFailure.failures[0].definition.source, "AI HOT 精选");

const isolatedNormalizeFailure = collectSettledFeedArticles(
  aiHotDefinitions,
  fulfilledResults,
  (feed, definition) => {
    if (definition.source === "AI HOT 精选") throw new Error("invalid selected payload");
    return feed.items.map(title => article(definition.source, title, `https://example.com/${title}`));
  },
);
assert.equal(isolatedNormalizeFailure.articles.length, 2);
assert.deepEqual(isolatedNormalizeFailure.counts, { aiHotSelected: 0, aiHotAll: 2 });
assert.equal(isolatedNormalizeFailure.failures[0].definition.source, "AI HOT 精选");

const overlapping = collectSettledFeedArticles(
  aiHotDefinitions,
  [
    { status: "fulfilled", value: { items: ["shared"] } },
    { status: "fulfilled", value: { items: ["shared"] } },
  ],
  (feed, definition) => feed.items.map(title => article(
    definition.source,
    title,
    definition.source === "AI HOT 精选"
      ? "https://example.com/shared/?utm_source=selected"
      : "https://example.com/shared#all",
  )),
);
assert.equal(overlapping.articles.length, 1, "Overlapping feeds must not duplicate the global timeline");
assert.equal(sourceMatches(overlapping.articles[0], "AI HOT 精选"), true);
assert.equal(sourceMatches(overlapping.articles[0], "AI HOT 全部"), true);

const cachedSam = article("Sam Altman", "cached upstream article", "https://x.com/sama/status/1");
const cachedAiHot = article("AI HOT 全部", "old all article", "https://example.com/old-all");
const freshSelected = article("AI HOT 精选", "new selected article", "https://example.com/new-selected");
const fallback = mergeWithSourceFallback([cachedSam, cachedAiHot], [freshSelected]);
assert.deepEqual(
  new Set(fallback.map(item => item.title)),
  new Set(["cached upstream article", "old all article", "new selected article"]),
  "Failed sources must retain their last real cached articles",
);

const cachedOverlap = {
  ...article("AI HOT 全部", "shared cached article", "https://example.com/shared-cache"),
  sourceAliases: ["AI HOT 精选"],
};
const refreshedAll = article("AI HOT 全部", "shared refreshed article", "https://example.com/shared-cache");
const partialMembershipFallback = mergeWithSourceFallback([cachedOverlap], [refreshedAll]);
assert.equal(partialMembershipFallback.length, 1);
assert.equal(sourceMatches(partialMembershipFallback[0], "AI HOT 全部"), true);
assert.equal(
  sourceMatches(partialMembershipFallback[0], "AI HOT 精选"),
  true,
  "A failed source must retain its cached membership when an overlapping source refreshes",
);

const legacyMock = article("虎嗅网", "中国内容创作者的变现困境：流量有了，钱在哪里？");
const legitimateWithoutUrl = article("Internal source", "A legitimate URL-less article");
assert.deepEqual(removeLegacyMockArticles([legacyMock, legitimateWithoutUrl]), [legitimateWithoutUrl]);

const pollutedCachedArticle = {
  ...article("AI HOT 全部", "cached saved state", "https://example.com/saved"),
  saved: true,
  cards: [{ id: "private-card", type: "观点" as const, content: "user-specific extraction", tags: [] }],
};
assert.deepEqual(
  sanitizeGlobalArticleCache([legacyMock, pollutedCachedArticle]),
  [{ ...pollutedCachedArticle, saved: false, cards: [] }],
  "Startup must remove legacy prototypes and clear user-specific state from the global cache",
);

const serializedEvents: string[] = [];
let releaseFirstWrite: (() => void) | undefined;
const firstWriteGate = new Promise<void>(resolve => { releaseFirstWrite = resolve; });
const serializedWriter = createSerializedTaskQueue<string>(async value => {
  serializedEvents.push(`start:${value}`);
  if (value === "first") await firstWriteGate;
  serializedEvents.push(`end:${value}`);
});
const firstWrite = serializedWriter("first");
const secondWrite = serializedWriter("second");
await new Promise(resolve => setTimeout(resolve, 0));
assert.deepEqual(serializedEvents, ["start:first"], "Cache writes must not overlap");
releaseFirstWrite?.();
await Promise.all([firstWrite, secondWrite]);
assert.deepEqual(serializedEvents, ["start:first", "end:first", "start:second", "end:second"]);

assert.doesNotMatch(server, /import \{ MOCK_ARTICLES \}/, "The production server must not depend on prototype feed data");
assert.match(server, /collectSettledFeedArticles\(/, "The production refresh must use the behavior-tested collector");
assert.match(server, /sanitizeGlobalArticleCache\(cachedArticles\)/, "Startup must sanitize persisted global feed state");
assert.match(server, /X-AtomFlow-RSS-Refreshing/, "The API must expose whether its initial refresh is still pending");
assert.doesNotMatch(server, /refreshBuiltInSource/, "User requests must not mutate globally shared built-in sources");
assert.match(server, /内置订阅源由服务器统一刷新/, "Built-in source refreshes must remain server-owned");
assert.match(server, /createSerializedTaskQueue/, "Article cache writes must be serialized");
assert.match(server, /fs\.rename\(/, "Article cache replacement must be atomic");
assert.doesNotMatch(server, /article\.saved\s*=\s*true/, "One user's save must not mutate the process-global article state");
assert.doesNotMatch(server, /article\.cards\s*=/, "One user's extraction must not mutate the process-global article state");
assert.match(
  savedStateResolver,
  /normalizeArticleUrl\(row\.url\)/,
  "Saved database URLs must be normalized before identity comparison",
);
assert.match(
  savedStateResolver,
  /normalizeArticleUrl\(article\.url\)/,
  "Feed URLs must be normalized before matching saved state",
);
assert.match(
  server,
  /ADD COLUMN IF NOT EXISTS normalized_url TEXT/,
  "Saved articles must persist a canonical URL identity",
);
assert.match(
  server,
  /CREATE UNIQUE INDEX[^\n]+saved_articles[^\n]+\(user_id, normalized_url\)/,
  "Canonical saved-article URLs must be unique per user at the database layer",
);
assert.match(
  server,
  /runSchemaTransaction\(async client[\s\S]+LOCK TABLE saved_articles IN SHARE ROW EXCLUSIVE MODE/,
  "Canonical URL backfill and deduplication must run in one locked schema transaction",
);
assert.match(
  server,
  /CHECK \(url IS NULL OR normalized_url IS NOT NULL\)/,
  "Old application instances must not bypass canonical URL identity during a rolling deploy",
);

const appContext = readFileSync(path.join(root, "src/context/AppContext.tsx"), "utf8");
const feedPage = readFileSync(path.join(root, "src/pages/FeedPage.tsx"), "utf8");
const nav = readFileSync(path.join(root, "src/components/Nav.tsx"), "utf8");
const discoverPage = readFileSync(path.join(root, "src/pages/DiscoverPage.tsx"), "utf8");
const recommendedSourceHandler = discoverPage.slice(
  discoverPage.indexOf("const handleAddSource"),
  discoverPage.indexOf("const handleAddCustomSource"),
);
const setReadingArticleHandler = appContext.slice(
  appContext.indexOf("const setReadingArticle"),
  appContext.indexOf("// Fetch initial data"),
);
const saveArticleHandler = appContext.slice(
  appContext.indexOf("const saveArticle"),
  appContext.indexOf("const loginAndDo"),
);
const saveArticleRoute = server.slice(
  server.indexOf('app.post("/api/articles/:id/save"'),
  server.indexOf('app.get("/api/articles/:id/full"'),
);
const fullArticleRoute = server.slice(
  server.indexOf('app.get("/api/articles/:id/full"'),
  server.indexOf('app.get("/api/image-proxy"'),
);
const retrySourceRoute = server.slice(
  server.indexOf('app.post("/api/sources/retry"'),
  server.indexOf('app.delete("/api/sources/:source"'),
);
assert.match(appContext, /articlesLoaded/, "Article loading must have an explicit terminal state even when the result is empty");
assert.match(feedPage, /isInitialLoading\s*=\s*!articlesLoaded/, "The feed must stop loading after an empty API response");
assert.match(appContext, /X-AtomFlow-RSS-Refreshing/, "An empty cold-start response must schedule an automatic retry");
assert.match(
  appContext,
  /reloadArticles\(retryAttempt \+ 1\)/,
  "Homepage cold-start retries must advance an explicit attempt counter",
);
assert.match(
  appContext,
  /if \(retryPending && retryAttempt < RSS_REFRESH_RETRY_DELAYS_MS\.length\) \{\s*retryScheduled = true;\s*if \(articleRetryTimerRef\.current === null\)/,
  "Concurrent auth reloads must preserve an already scheduled homepage retry",
);
assert.match(
  appContext,
  /RSS_REFRESH_RETRY_DELAYS_MS\.length/,
  "Homepage and per-source cold-start retries must share a bounded backoff schedule",
);
assert.match(nav, /BUILTIN_SOURCE_NAMES\.has\(source\.name\)/, "Opening a built-in source must only use shared cached content");
assert.match(server, /fullBuiltInArticles/, "Built-in source details must use a full-feed server view");
assert.match(
  server,
  /fullBuiltInArticles\s*=\s*sanitizeGlobalArticleCache\(cachedArticles\)/,
  "Startup must restore the persisted full-feed cache before deriving the homepage timeline",
);
assert.match(
  server,
  /saveArticlesCache\(fullBuiltInArticles\)/,
  "Successful refreshes must persist full-feed data for restart fallback",
);
assert.match(server, /req\.query\.source/, "The article API must accept a source detail query");
assert.match(saveArticleRoute, /fullBuiltInArticles/, "Articles outside the homepage slice must still be saveable");
assert.match(
  saveArticleRoute,
  /savedArticleResult = existingSavedArticleId/,
  "Legacy saved-article identities must be reused instead of inserting duplicates",
);
assert.doesNotMatch(
  saveArticleRoute,
  /title = \$3 AND source = \$4/,
  "Linked articles must never be deduplicated by title and source",
);
assert.match(
  savedStateResolver,
  /!normalizedArticleUrl && savedSourceTitles\.has/,
  "Title/source saved-state fallback must only apply to articles without URLs",
);
assert.match(fullArticleRoute, /fullBuiltInArticles/, "Articles outside the homepage slice must still open in full view");
assert.match(
  fullArticleRoute,
  /applyUserSavedStateToArticles/,
  "Opening full content must preserve the authenticated user's saved state",
);
assert.match(appContext, /loadSourceArticles/, "The client must load full built-in source details on demand");
assert.doesNotMatch(
  appContext,
  /nextArticles\.length > 0 \|\| !refreshPending/,
  "An empty source response must not become a sticky source-cache override",
);
assert.match(
  appContext,
  /retryAttempt\s*<\s*RSS_REFRESH_RETRY_DELAYS_MS\.length/,
  "Cold-start source retries must have a hard attempt limit",
);
assert.match(feedPage, /sourceArticles/, "The feed page must prefer on-demand source details over the homepage timeline");
assert.match(feedPage, /\/api\/sources\/retry/, "The explicit retry action must use the controlled server refresh route");
assert.match(retrySourceRoute, /runFeedRefresh\(\)/, "Built-in retries must share the server refresh single-flight");
assert.match(
  retrySourceRoute,
  /lastSuccessfulFeedRefreshSources\.has\(source\)/,
  "Built-in retries must report whether the requested source actually refreshed",
);
assert.match(
  feedPage,
  /refreshResult\.refreshed\s*===\s*false/,
  "The client must not report a cooldown or failed source refresh as successful",
);
assert.match(
  retrySourceRoute,
  /added\s*\+=\s*insertResult\.rowCount\s*\?\?\s*0/,
  "Custom source retries must report rows actually inserted",
);
assert.match(
  setReadingArticleHandler,
  /updateSourceArticleCache/,
  "Opening full content must update the on-demand source cache",
);
assert.match(
  saveArticleHandler,
  /updateSourceArticleCache/,
  "Saving a full-feed article must immediately update the on-demand source cache",
);
assert.doesNotMatch(
  recommendedSourceHandler,
  /\/api\/sources\/fetch/,
  "Adding a recommended built-in source must not call the protected source mutation endpoint",
);

console.log("PASS: RSS source refresh remains isolated and production data stays real");
