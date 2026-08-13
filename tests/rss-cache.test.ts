import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  RSS_ARTICLE_CONTENT_MAX_BYTES,
  RssArticleCache,
  truncateUtf8,
} from "../src/server/rssCache.js";

type TestArticle = Record<string, unknown> & { id: number; content: string };

test("RSS cache enforces UTF-8 byte and article limits with serialized atomic writes", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "atomflow-rss-cache-"));
  const cacheFile = path.join(directory, "articles.json");
  const cache = new RssArticleCache<TestArticle>(cacheFile);
  try {
    const oversized = "中文🙂".repeat(30_000);
    const first = Array.from({ length: 300 }, (_, id) => ({ id, content: oversized, markdownContent: "full", cards: ["x"] }));
    const second = Array.from({ length: 300 }, (_, id) => ({ id: id + 1000, content: `second-${id}` }));
    await Promise.all([cache.save(first), cache.save(second)]);
    await cache.flush();

    const onDisk = JSON.parse(await fs.readFile(cacheFile, "utf8")) as TestArticle[];
    assert.equal(onDisk.length, 250);
    assert.equal(onDisk[0].id, 1000, "serialized writes must leave the last queued complete payload");
    assert.ok(onDisk.every(article => Buffer.byteLength(article.content, "utf8") <= RSS_ARTICLE_CONTENT_MAX_BYTES));
    assert.ok(onDisk.every(article => article.markdownContent === undefined && article.fullFetched === false));
    assert.ok(onDisk.every(article => Array.isArray(article.cards) && article.cards.length === 0));

    const loaded = await cache.load();
    assert.equal(loaded.length, 250);
    assert.equal(loaded[0].id, 1000);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("RSS cache removes temporary files after an atomic replacement failure", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "atomflow-rss-cache-failure-"));
  const cacheFile = path.join(directory, "articles.json");
  await fs.mkdir(cacheFile);
  const cache = new RssArticleCache<TestArticle>(cacheFile);
  try {
    await assert.rejects(() => cache.save([{ id: 1, content: "bounded" }]));
    const entries = await fs.readdir(directory);
    assert.deepEqual(entries, ["articles.json"], "failed replacement must not leave temporary cache files");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("truncateUtf8 never splits a multi-byte code point or exceeds 64 KiB", () => {
  const truncated = truncateUtf8("🙂中文".repeat(30_000));
  assert.ok(Buffer.byteLength(truncated, "utf8") <= RSS_ARTICLE_CONTENT_MAX_BYTES);
  assert.doesNotMatch(truncated, /�/);
});
