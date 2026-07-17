import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import type { PodcastPreviewItem } from "../src/components/podcast/podcastPreview";
import { createPodcastPlaybackState } from "../src/components/podcast/podcastPlayback";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testDir, "..");
const vite = await createServer({ root, appType: "custom", server: { middlewareMode: true } });

const installDomGlobals = (dom: JSDOM) => {
  const keys = [
    "window",
    "document",
    "navigator",
    "Element",
    "HTMLElement",
    "HTMLDialogElement",
    "Node",
    "Event",
    "MouseEvent",
  ] as const;
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const key of keys) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: dom.window[key],
    });
  }
  const actDescriptor = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    writable: true,
    value: true,
  });
  return () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    if (actDescriptor) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", actDescriptor);
    else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  };
};

const createTouchPointerEvent = (
  dom: JSDOM,
  type: "pointerdown" | "pointerup",
  pointerId: number,
  clientX: number,
  clientY: number,
) => {
  const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY });
  Object.defineProperties(event, {
    pointerType: { configurable: true, value: "touch" },
    pointerId: { configurable: true, value: pointerId },
  });
  return event;
};

try {
  const pageModule = await vite.ssrLoadModule("/src/pages/PodcastPage.tsx") as Record<string, unknown>;
  const PodcastPageContent = pageModule.PodcastPageContent as React.ComponentType<Record<string, unknown>>;

  const items: PodcastPreviewItem[] = [
    {
      id: "article:11",
      articleId: 11,
      origin: "subscription",
      kind: "native_episode",
      title: "真实播客",
      source: "产品沉思录",
      topic: "产品",
      publishedAt: "2026-07-17T01:30:00.000Z",
      publishedAtMs: 1784251800000,
      timeLabel: "今天 09:30",
      summary: "这是 RSS 摘要。",
      contextBasis: "rss_summary",
      sourceUrl: "https://example.com/podcast",
      audioUrl: "https://cdn.example.com/episode.mp3",
      audioDuration: "25:12",
      isSaved: false,
    },
    {
      id: "article:12",
      articleId: 12,
      origin: "subscription",
      kind: "article_pending",
      title: "待解读文章",
      source: "少数派",
      topic: "效率",
      publishedAt: "2026-07-17T02:30:00.000Z",
      publishedAtMs: 1784255400000,
      timeLabel: "今天 10:30",
      summary: "这篇文章还没有音频。",
      contextBasis: "rss_summary",
      sourceUrl: "https://example.com/article",
      isSaved: false,
    },
  ];

  const pageProps = {
    items,
    filteredItems: items,
    filter: "for_you",
    range: "today",
    gate: "ready",
    articlesError: null,
    playback: createPodcastPlaybackState(items[0].id),
    savingArticleIds: [],
    getSavingLabel: () => null,
    onFilterChange: () => undefined,
    onRangeChange: () => undefined,
    onBrowse: () => undefined,
    onPrevious: () => undefined,
    onNext: () => undefined,
    onToggle: () => undefined,
    onSeek: () => undefined,
    onSkip: () => undefined,
    onRateChange: () => undefined,
    onContinuousPlayChange: () => undefined,
    onRetry: () => undefined,
    onSave: () => undefined,
    onGenerate: () => undefined,
    onReload: () => undefined,
    onLogin: () => undefined,
    onBack: () => undefined,
    onDiscover: () => undefined,
    renderThoughtAction: () => React.createElement("button", { type: "button" }, "说下我的想法"),
    audioElement: React.createElement("audio", { hidden: true, preload: "metadata" }),
  };
  const pageHtml = renderToStaticMarkup(React.createElement(PodcastPageContent, pageProps));

  assert.equal((pageHtml.match(/<audio/g) || []).length, 1);
  assert.match(pageHtml, /preload="metadata"/);
  assert.match(pageHtml, /播客解读/);
  assert.match(pageHtml, /为你生成/);
  assert.match(pageHtml, /短知识卡/);
  assert.match(pageHtml, /主题速听/);
  assert.match(pageHtml, /深度播客/);
  assert.match(pageHtml, /连续播放/);
  assert.match(pageHtml, /aria-pressed="false"[^>]*>连续播放|aria-pressed="false"[^>]*>[^<]*<[^>]+>[^<]*连续播放/);
  assert.match(pageHtml, /基于 RSS 摘要/);
  assert.match(pageHtml, /说下我的想法/);
  assert.doesNotMatch(pageHtml, /AI 已生成|完整逐字稿/);

  for (const [gate, label] of [
    ["loading", "正在整理今天的可收听内容"],
    ["error", "内容加载失败"],
    ["empty", "今天还没有可收听内容"],
    ["signed_out", "登录后生成你的播客知识流"],
  ] as const) {
    const stateHtml = renderToStaticMarkup(React.createElement(PodcastPageContent, {
      ...pageProps,
      gate,
      filteredItems: [],
    }));
    assert.match(stateHtml, new RegExp(label));
  }

  const cachedErrorHtml = renderToStaticMarkup(React.createElement(PodcastPageContent, {
    ...pageProps,
    articlesError: "refresh failed",
  }));
  assert.match(cachedErrorHtml, /部分内容刷新失败，正在显示上次结果/);
  assert.match(cachedErrorHtml, /重新加载/);
  assert.match(cachedErrorHtml, /真实播客/);

  const generatedEmptyHtml = renderToStaticMarkup(React.createElement(PodcastPageContent, {
    ...pageProps,
    filter: "short",
    filteredItems: [],
  }));
  assert.match(generatedEmptyHtml, /这一层还没有已生成内容/);
  assert.match(generatedEmptyHtml, /回到为你生成/);

  const generatedEmptyWithActiveAudioHtml = renderToStaticMarkup(React.createElement(PodcastPageContent, {
    ...pageProps,
    filter: "short",
    filteredItems: [],
    playback: {
      ...createPodcastPlaybackState(null),
      activeItemId: items[0].id,
      status: "playing",
    },
  }));
  assert.match(generatedEmptyWithActiveAudioHtml, /正在播放的节目/);
  assert.match(generatedEmptyWithActiveAudioHtml, /暂停真实播客/);

  const dom = new JSDOM("<!doctype html><html><body><div id=\"podcast-page-root\"></div></body></html>", {
    url: "https://atomflow.test/",
  });
  const restoreDomGlobals = installDomGlobals(dom);
  const pointerCaptureDescriptor = Object.getOwnPropertyDescriptor(
    dom.window.HTMLElement.prototype,
    "setPointerCapture",
  );
  let mountedRoot: Root | null = null;

  try {
    Object.defineProperty(dom.window.HTMLElement.prototype, "setPointerCapture", {
      configurable: true,
      writable: true,
      value: () => undefined,
    });
    const container = dom.window.document.querySelector<HTMLDivElement>("#podcast-page-root");
    assert.ok(container);
    let browseCalls = 0;
    let toggleCalls = 0;
    let previousCalls = 0;
    let nextCalls = 0;
    mountedRoot = createRoot(container);
    await act(async () => {
      mountedRoot?.render(React.createElement(PodcastPageContent, {
        ...pageProps,
        onBrowse: () => { browseCalls += 1; },
        onToggle: () => { toggleCalls += 1; },
        onPrevious: () => { previousCalls += 1; },
        onNext: () => { nextCalls += 1; },
      }));
    });

    const pendingCard = container.querySelector<HTMLButtonElement>('button[aria-label="浏览：待解读文章"]');
    assert.ok(pendingCard);
    await act(async () => {
      pendingCard.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    assert.equal(browseCalls, 1, "browsing a card must call only the browse action");
    assert.equal(toggleCalls, 0, "browsing a card must never request playback");

    const dispatchSwipe = async (target: Element, pointerId: number) => {
      await act(async () => {
        target.dispatchEvent(createTouchPointerEvent(dom, "pointerdown", pointerId, 100, 180));
        target.dispatchEvent(createTouchPointerEvent(dom, "pointerup", pointerId, 100, 80));
      });
    };
    const controlsRegion = container.querySelector<Element>(".podcast-stage-controls");
    const actionsRegion = container.querySelector<Element>(".podcast-stage-actions");
    const cover = container.querySelector<Element>(".podcast-cover-art");
    assert.ok(controlsRegion);
    assert.ok(actionsRegion);
    assert.ok(cover);

    await dispatchSwipe(controlsRegion, 11);
    await dispatchSwipe(actionsRegion, 12);
    assert.equal(nextCalls, 0, "controls and stage actions must be isolated from swipe navigation");
    assert.equal(previousCalls, 0);

    await dispatchSwipe(cover, 13);
    assert.equal(nextCalls, 1, "the dedicated cover zone must support vertical swipe navigation");
    assert.equal(previousCalls, 0);
  } finally {
    if (mountedRoot) {
      await act(async () => {
        mountedRoot?.unmount();
      });
    }
    if (pointerCaptureDescriptor) {
      Object.defineProperty(dom.window.HTMLElement.prototype, "setPointerCapture", pointerCaptureDescriptor);
    } else {
      Reflect.deleteProperty(dom.window.HTMLElement.prototype, "setPointerCapture");
    }
    restoreDomGlobals();
    dom.window.close();
  }

  console.log("PASS: podcast page mounts one audio element and exposes honest states");
} finally {
  await vite.close();
}
