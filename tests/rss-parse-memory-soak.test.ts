import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Parser from "rss-parser";
import type { Article } from "../src/types.js";
import { RssRuntimeController } from "../src/server/rssRuntime.js";
import {
  BUILTIN_RSS_FEEDS,
  type BuiltInRssFeedDefinition,
  buildHomepageTimeline,
  extractFeedIcon,
  mergeArticles,
  mergeWithSourceFallback,
  normalizeFeedItems,
} from "../src/server/rss.js";
import { RSS_ARTICLE_CONTENT_MAX_BYTES, RSS_GLOBAL_ARTICLE_LIMIT, RssArticleCache } from "../src/server/rssCache.js";

// The production leak lived in the parse path (rss-memory-soak.test.ts stubs it out):
// full Parser.Output graphs retained across cycles. This soak drives the REAL
// parser -> normalizeFeedItems -> merge -> timeline -> cache pipeline with
// multi-megabyte feeds and asserts the heap plateaus.

const ITEMS_PER_FEED = 12;
const LARGE_CONTENT_BYTES = 80 * 1024; // above RSS_ARTICLE_CONTENT_MAX_BYTES to exercise truncation
const SMALL_CONTENT_BYTES = 12 * 1024;
const SOAK_CYCLES = 100;
const MAX_HEAP_DRIFT_BYTES = 25 * 1024 * 1024;

const heapAfterGc = async () => {
  global.gc?.();
  await new Promise<void>(resolve => setImmediate(resolve));
  global.gc?.();
  return process.memoryUsage().heapUsed;
};

const htmlFiller = (bytes: number, seed: string) => {
  const paragraph = `<p>AtomFlow 解析压测段落 ${seed} — lorem ipsum dolor sit amet, consectetur adipiscing elit. `
    + `<strong>热点</strong> <a href="https://example.com/${seed}">链接</a> 数据与观点交替出现。</p>`;
  return paragraph.repeat(Math.ceil(bytes / paragraph.length));
};

const buildFeedXml = (feed: BuiltInRssFeedDefinition, cycle: number) => {
  const items = Array.from({ length: ITEMS_PER_FEED }, (_, index) => {
    // A third of the items change every cycle so merge/timeline churn like production;
    // the rest keep stable URLs so mergeArticles hits its carry-forward branch.
    const isChurning = index % 3 === 0;
    const slug = isChurning ? `${feed.key}-c${cycle}-i${index}` : `${feed.key}-stable-i${index}`;
    const contentBytes = index % 4 === 0 ? LARGE_CONTENT_BYTES : SMALL_CONTENT_BYTES;
    const published = new Date(Date.UTC(2026, 0, 1) + cycle * 60_000 + index * 1000).toUTCString();
    return `<item>
      <title>${feed.source} ${slug}</title>
      <link>https://example.com/${slug}</link>
      <guid>${slug}</guid>
      <pubDate>${published}</pubDate>
      <category>压测</category>
      <content:encoded><![CDATA[${htmlFiller(contentBytes, slug)}]]></content:encoded>
    </item>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${feed.source}</title>
    <link>https://example.com/${feed.key}</link>
    <image><url>https://example.com/${feed.key}.png</url></image>
    ${items}
  </channel>
</rss>`;
};

test("RSS parse pipeline keeps a flat heap across 100 multi-megabyte refresh cycles", {
  skip: typeof global.gc !== "function" ? "run with --expose-gc" : false,
  timeout: 300_000,
}, async () => {
  const processWithHandles = process as typeof process & { _getActiveHandles: () => unknown[] };
  const cacheDir = mkdtempSync(path.join(tmpdir(), "atomflow-parse-soak-"));
  const cache = new RssArticleCache<Article>(
    path.join(cacheDir, "articles.json"),
    RSS_GLOBAL_ARTICLE_LIMIT,
    RSS_ARTICLE_CONTENT_MAX_BYTES,
  );

  let fullArticles: Article[] = [];
  let timeline: Article[] = [];
  let currentCycle = 0;
  let completedCycles = 0;

  const runtime = new RssRuntimeController<BuiltInRssFeedDefinition, Article[]>({
    getSources: () => BUILTIN_RSS_FEEDS,
    getSourceId: feed => feed.key,
    // Mirrors the production wiring: one parser per parse, normalize inside the
    // per-source refresh so the results map only ever holds small plain articles.
    refreshSource: async feed => {
      const parser = new Parser();
      const parsed = await parser.parseString(buildFeedXml(feed, currentCycle));
      return normalizeFeedItems(parsed.items || [], feed.source, feed.topic, feed.idOffset, extractFeedIcon(parsed));
    },
    onCycleComplete: async ({ results }) => {
      const normalized: Article[] = BUILTIN_RSS_FEEDS.flatMap(feed => results.get(feed.key) ?? []);
      assert.ok(normalized.length > 0, "every soak cycle must produce normalized articles");
      fullArticles = mergeArticles(fullArticles, mergeWithSourceFallback(fullArticles, normalized)).slice(0, RSS_GLOBAL_ARTICLE_LIMIT);
      timeline = mergeArticles(timeline, buildHomepageTimeline(fullArticles));
      await cache.save(fullArticles);
      completedCycles += 1;
    },
  });

  // Warm up module-level state (parser internals, cache digest) before baselining.
  await runtime.runCycle();
  currentCycle += 1;
  const baselineHandles = processWithHandles._getActiveHandles().length;
  const baselineHeap = await heapAfterGc();

  try {
    for (; currentCycle <= SOAK_CYCLES; currentCycle += 1) {
      await runtime.runCycle();
      if (currentCycle % 20 === 0) await heapAfterGc();
    }
  } finally {
    runtime.shutdown();
    rmSync(cacheDir, { recursive: true, force: true });
  }

  const finalHeap = await heapAfterGc();
  const finalHandles = processWithHandles._getActiveHandles().length;
  assert.equal(completedCycles, SOAK_CYCLES + 1);
  assert.ok(fullArticles.length > 0 && fullArticles.length <= RSS_GLOBAL_ARTICLE_LIMIT);
  assert.ok(timeline.length > 0, "the homepage timeline must be produced from soaked feeds");
  const oversized = fullArticles.filter(article => Buffer.byteLength(article.content, "utf8") > RSS_ARTICLE_CONTENT_MAX_BYTES);
  assert.equal(oversized.length, 0, "normalized article content must be truncated to the cache byte limit");
  const drift = finalHeap - baselineHeap;
  assert.ok(drift < MAX_HEAP_DRIFT_BYTES, `heap drift was ${drift} bytes after ${SOAK_CYCLES} parse cycles`);
  assert.ok(finalHandles <= baselineHandles + 2, `active handles grew from ${baselineHandles} to ${finalHandles}`);
});
