import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import type { Article } from "../src/types";

const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost:1000" });
const previousWindow = globalThis.window;
const previousDocument = globalThis.document;
const previousNavigator = globalThis.navigator;
const previousFetch = globalThis.fetch;
Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });

const vite = await createServer({ appType: "custom", server: { middlewareMode: true } });
const contextModule = await vite.ssrLoadModule("/src/context/AppContext.tsx") as Record<string, unknown>;
const AppProvider = contextModule.AppProvider as React.ComponentType<{ children: React.ReactNode }>;
const useAppContext = contextModule.useAppContext as () => TestContext;
const mergeSavedReadingArticle = contextModule.mergeSavedReadingArticle as (
  current: Article | null,
  identity: Article,
  savedArticle: Article,
) => Article | null;

type TestContext = {
  readingArticle: Article | null;
  setReadingArticle: (article: Article | null) => Promise<void>;
};

type DeferredResponse = {
  promise: Promise<Response>;
  resolve: (response: Response) => void;
};
const deferred = (): DeferredResponse => {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(resolver => { resolve = resolver; });
  return { promise, resolve };
};

const article = (title: string, url: string): Article => ({
  id: 7,
  saved: false,
  source: "测试源",
  topic: "产品",
  time: "今天",
  title,
  excerpt: `${title}摘要`,
  content: "",
  url,
  fullFetched: false,
  cards: [],
});

const first = article("第一篇", "https://example.com/first");
const second = article("第二篇", "https://example.com/second");
const urlLess = { ...article("无链接文章", ""), url: undefined, source: "无链接来源" };
const savedOnly: Article = {
  ...article("收藏中的原文", "https://example.com/saved-only"),
  id: -41,
  saved: true,
  source: "知识库",
};
const firstResponse = deferred();
const secondResponse = deferred();
const requestedUrls: string[] = [];

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  requestedUrls.push(url);
  if (url === "/api/auth/me") {
    return new Response(JSON.stringify({ user: null }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url === "/api/articles") {
    return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.includes("/api/articles/7/full") && url.includes(encodeURIComponent(first.url || ""))) {
    return firstResponse.promise;
  }
  if (url.includes("/api/articles/7/full") && url.includes(encodeURIComponent(second.url || ""))) {
    return secondResponse.promise;
  }
  if (url.includes("/api/articles/7/full") && url.includes("sourceName=%E6%97%A0%E9%93%BE%E6%8E%A5%E6%9D%A5%E6%BA%90")) {
    return new Response(JSON.stringify({ article: { ...urlLess, content: "无链接全文", fullFetched: true } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (url === "/api/saved-articles/41") {
    return new Response(JSON.stringify({
      id: 41,
      title: savedOnly.title,
      url: savedOnly.url,
      source: savedOnly.source,
      topic: savedOnly.topic,
      excerpt: "收藏列表摘要",
      content: "从收藏全文接口拉取的正文",
      audioUrl: "https://cdn.example.com/saved-only.mp3",
      audioDuration: "31:08",
      savedAt: "2026-07-17T00:00:00.000Z",
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  throw new Error(`Unexpected fetch: ${url}`);
}) as typeof fetch;

let context: TestContext | null = null;
function CaptureContext() {
  context = useAppContext();
  return null;
}

const container = document.getElementById("root");
assert.ok(container);
const reactRoot = createRoot(container);

try {
  await act(async () => {
    reactRoot.render(React.createElement(AppProvider, null, React.createElement(CaptureContext)));
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.ok(context);

  await act(async () => {
    context?.setReadingArticle(first);
    context?.setReadingArticle(second);
  });

  await act(async () => {
    secondResponse.resolve(new Response(JSON.stringify({ article: { ...second, content: "第二篇全文", fullFetched: true } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await secondResponse.promise;
  });
  assert.equal(context?.readingArticle?.url, second.url);
  assert.equal(context?.readingArticle?.content, "第二篇全文");

  await act(async () => {
    firstResponse.resolve(new Response(JSON.stringify({ article: { ...first, content: "第一篇全文", fullFetched: true } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await firstResponse.promise;
  });
  assert.equal(context?.readingArticle?.url, second.url, "a stale full-article response must not replace the latest podcast selection");
  assert.ok(requestedUrls.some(url => url.includes(`sourceUrl=${encodeURIComponent(second.url || "")}`)));
  assert.equal(
    mergeSavedReadingArticle(second, first, { ...first, saved: true }),
    second,
    "a late save response for the previous item must not replace the current ReaderPane article",
  );

  await act(async () => {
    context?.setReadingArticle(urlLess);
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(context?.readingArticle?.content, "无链接全文");
  assert.ok(requestedUrls.some(url => url.includes("sourceTitle=%E6%97%A0%E9%93%BE%E6%8E%A5%E6%96%87%E7%AB%A0")));

  await act(async () => {
    await context?.setReadingArticle(savedOnly);
  });
  assert.equal(context?.readingArticle?.content, "从收藏全文接口拉取的正文");
  assert.equal(context?.readingArticle?.audioUrl, "https://cdn.example.com/saved-only.mp3");
  assert.equal(context?.readingArticle?.audioDuration, "31:08");
  assert.equal(context?.readingArticle?.fullFetched, true);
  assert.ok(requestedUrls.includes("/api/saved-articles/41"));
  assert.equal(
    requestedUrls.some(url => url.includes("/api/articles/-41/full")),
    false,
    "saved-only readers must use the authenticated saved article endpoint",
  );

  const serverSource = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
  assert.equal(
    (serverSource.match(/const sourceUrl = typeof req\.query\.sourceUrl/g) || []).length,
    2,
    "both full-article and save routes must resolve the URL identity supplied by ReaderPane",
  );
  assert.equal((serverSource.match(/const sourceName = typeof req\.query\.sourceName/g) || []).length, 2);
  assert.match(serverSource, /UPDATE user_articles SET saved = TRUE[\s\S]{0,140}\[article\.id, req\.session\.userId\]/);
} finally {
  await act(async () => reactRoot.unmount());
  await vite.close();
  Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
  Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNavigator });
  globalThis.fetch = previousFetch;
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  dom.window.close();
}

console.log("PASS: latest ReaderPane selection wins out-of-order full article responses");
