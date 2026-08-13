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
import type { PodcastPlaybackContextValue } from "../src/components/podcast/PodcastPlaybackProvider";
import type { Article } from "../src/types";
import {
  createPodcastPlaybackState,
  type PodcastPlaybackAction,
} from "../src/components/podcast/podcastPlayback";

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
  const providerModule = await vite.ssrLoadModule(
    "/src/components/podcast/PodcastPlaybackProvider.tsx",
  ) as Record<string, unknown>;
  const PodcastPageContent = pageModule.PodcastPageContent as React.ComponentType<Record<string, unknown>>;
  const resolvePodcastSourceArticle = pageModule.resolvePodcastSourceArticle as (
    item: PodcastPreviewItem | undefined,
    articles: Array<Record<string, unknown>>,
    savedArticles: Array<Record<string, unknown>>,
  ) => Record<string, unknown> | null;
  const PodcastAudioElement = providerModule.PodcastAudioElement as React.ElementType | undefined;
  const PodcastPlaybackProvider = providerModule.PodcastPlaybackProvider as React.ElementType | undefined;
  const PodcastArticleAudioControls = providerModule.PodcastArticleAudioControls as React.ElementType | undefined;
  const usePodcastPlayback = providerModule.usePodcastPlayback as (() => PodcastPlaybackContextValue) | undefined;
  const usePodcastFullPlayerPresence = providerModule.usePodcastFullPlayerPresence as (() => void) | undefined;
  assert.ok(PodcastAudioElement, "PodcastPage must export its source-scoped audio controller");
  assert.ok(PodcastPlaybackProvider, "podcast playback must expose a root-mountable provider");
  assert.ok(PodcastArticleAudioControls, "Reader audio controls must use the root playback provider");
  assert.ok(usePodcastPlayback);
  assert.ok(usePodcastFullPlayerPresence);
  assert.ok(resolvePodcastSourceArticle, "PodcastPage must expose source-article resolution for ReaderPane sync");

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
  };
  const readerAudioArticle: Article = {
    id: 11,
    saved: false,
    source: "产品沉思录",
    topic: "产品",
    time: "今天 09:30",
    title: "真实播客",
    excerpt: "这是 RSS 摘要。",
    content: "正文",
    url: "https://example.com/podcast",
    audioUrl: "https://cdn.example.com/episode.mp3",
    audioDuration: "25:12",
    fullFetched: true,
    cards: [],
  };
  const pageHtml = renderToStaticMarkup(React.createElement(PodcastPageContent, pageProps));

  assert.equal((pageHtml.match(/<audio/g) || []).length, 0, "the page must not own the global audio node");
  assert.match(pageHtml, /播客解读/);
  assert.doesNotMatch(pageHtml, /为你生成|短知识卡|主题速听|深度播客/);
  assert.doesNotMatch(pageHtml, /浏览：待解读文章|内容上下文|查看上下文/);
  assert.match(pageHtml, /连续播放/);
  assert.match(pageHtml, /aria-pressed="false"[^>]*>连续播放|aria-pressed="false"[^>]*>[^<]*<[^>]+>[^<]*连续播放/);
  assert.equal(
    (pageHtml.match(/min-h-11 rounded-full px-3 text-xs font-semibold/g) || []).length,
    2,
    "both date-range buttons must expose a 44px minimum touch target",
  );
  assert.doesNotMatch(pageHtml, /min-h-9 rounded-full px-3/);
  assert.match(pageHtml, /基于 RSS 摘要/);
  assert.match(pageHtml, /说下我的想法/);
  assert.doesNotMatch(pageHtml, /AI 已生成|完整逐字稿/);

  const sourceArticle = {
    id: 11,
    title: "真实播客",
    url: "https://example.com/podcast",
  };
  assert.equal(resolvePodcastSourceArticle(items[0], [sourceArticle], []), sourceArticle);
  const sameNumericIdArticle = {
    id: 11,
    title: "另一个来源的同 ID 文章",
    url: "https://example.com/other",
  };
  assert.equal(
    resolvePodcastSourceArticle(items[0], [sameNumericIdArticle, sourceArticle], []),
    sourceArticle,
    "ReaderPane sync must prefer the source URL when article ids collide",
  );
  const urlLessPodcastItem = {
    ...items[1],
    id: "article:22:url-less",
    articleId: 22,
    sourceUrl: undefined,
    source: "正确来源",
    title: "无链接文章",
  };
  const wrongUrlLessArticle = { id: 22, source: "错误来源", title: "另一篇文章" };
  const expectedUrlLessArticle = { id: 22, source: "正确来源", title: "无链接文章" };
  assert.equal(
    resolvePodcastSourceArticle(urlLessPodcastItem, [wrongUrlLessArticle, expectedUrlLessArticle], []),
    expectedUrlLessArticle,
    "URL-less podcast sources must use source and title before a colliding numeric id",
  );
  const savedSource = resolvePodcastSourceArticle(
    {
      ...items[1],
      id: "saved:41",
      articleId: undefined,
      savedArticleId: 41,
      origin: "saved",
      sourceUrl: "https://example.com/saved",
    },
    [],
    [{
      id: 41,
      title: "收藏原文",
      url: "https://example.com/saved",
      source: "知识库",
      topic: "产品",
      excerpt: "收藏摘要",
      content: "收藏全文",
      audioUrl: "https://cdn.example.com/saved-reader.mp3",
      audioDuration: "36:10",
      savedAt: "2026-07-17T00:00:00.000Z",
    }],
  );
  assert.equal(savedSource?.title, "收藏原文");
  assert.equal(savedSource?.content, "收藏全文");
  assert.equal(savedSource?.fullFetched, true);
  assert.equal(savedSource?.audioUrl, "https://cdn.example.com/saved-reader.mp3");
  assert.equal(savedSource?.audioDuration, "36:10");

  const savedMetadataOnly = resolvePodcastSourceArticle(
    {
      ...items[1],
      id: "saved:42",
      articleId: undefined,
      savedArticleId: 42,
      origin: "saved",
    },
    [],
    [{
      id: 42,
      title: "待拉取收藏全文",
      source: "知识库",
      topic: "产品",
      excerpt: "这只是摘要，不能充当全文",
      savedAt: "2026-07-17T00:00:00.000Z",
    }],
  );
  assert.equal(savedMetadataOnly?.content, "", "saved-list excerpts must never masquerade as full article content");
  assert.equal(savedMetadataOnly?.fullFetched, false, "saved-only metadata must remain eligible for full-content hydration");

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

  const cachedActivePlayback = {
    ...createPodcastPlaybackState(items[0].id),
    activeItemId: items[0].id,
    status: "playing" as const,
  };
  for (const [gate, stateLabel] of [
    ["signed_out", "登录后生成你的播客知识流"],
    ["auth_loading", "正在确认登录状态"],
    ["error", "内容加载失败"],
  ] as const) {
    const nonStageHtml = renderToStaticMarkup(React.createElement(PodcastPageContent, {
      ...pageProps,
      gate,
      articlesError: gate === "error" ? "cached refresh failed" : null,
      playback: cachedActivePlayback,
    }));
    assert.match(nonStageHtml, new RegExp(stateLabel));
    assert.equal((nonStageHtml.match(/<audio/g) || []).length, 0);
    assert.equal((nonStageHtml.match(/正在播放的节目/g) || []).length, 1);
    assert.match(nonStageHtml, /暂停真实播客/);
    assert.ok(
      nonStageHtml.indexOf(stateLabel) < nonStageHtml.indexOf('aria-label="正在播放的节目"'),
      "the sticky active controls must follow the current page state in DOM order",
    );
  }

  const dom = new JSDOM("<!doctype html><html><body><div id=\"podcast-page-root\"></div></body></html>", {
    url: "https://atomflow.test/",
  });
  const restoreDomGlobals = installDomGlobals(dom);
  const pointerCaptureDescriptor = Object.getOwnPropertyDescriptor(
    dom.window.HTMLElement.prototype,
    "setPointerCapture",
  );
  const mediaPauseDescriptor = Object.getOwnPropertyDescriptor(
    dom.window.HTMLMediaElement.prototype,
    "pause",
  );
  const mediaLoadDescriptor = Object.getOwnPropertyDescriptor(
    dom.window.HTMLMediaElement.prototype,
    "load",
  );
  const mediaPlayDescriptor = Object.getOwnPropertyDescriptor(
    dom.window.HTMLMediaElement.prototype,
    "play",
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

    const strictPauseNodes: HTMLMediaElement[] = [];
    const strictLoadNodes: HTMLMediaElement[] = [];
    Object.defineProperties(dom.window.HTMLMediaElement.prototype, {
      pause: {
        configurable: true,
        value(this: HTMLMediaElement) { strictPauseNodes.push(this); },
      },
      load: {
        configurable: true,
        value(this: HTMLMediaElement) { strictLoadNodes.push(this); },
      },
      play: {
        configurable: true,
        value() { return Promise.resolve(); },
      },
    });
    mountedRoot = createRoot(container);
    await act(async () => {
      mountedRoot?.render(React.createElement(
        React.StrictMode,
        null,
        React.createElement(PodcastAudioElement, {
          item: items[0],
          continuousPlay: false,
          onDispatch: () => undefined,
          onPlayNext: () => undefined,
        }),
      ));
    });
    const strictLiveAudio = container.querySelector<HTMLAudioElement>("audio");
    assert.ok(strictLiveAudio);
    assert.equal(strictPauseNodes.length, 0, "StrictMode effect replay must not pause a connected audio node");
    assert.equal(strictLoadNodes.length, 0, "StrictMode effect replay must not reset a connected audio node");
    assert.equal(strictLiveAudio.hasAttribute("src"), true, "StrictMode replay must preserve the live source");
    await act(async () => {
      mountedRoot?.unmount();
    });
    assert.deepEqual(strictPauseNodes, [strictLiveAudio], "a real StrictMode root unmount must stop the audio once");
    assert.deepEqual(strictLoadNodes, [strictLiveAudio], "a real StrictMode root unmount must release the audio once");
    assert.equal(strictLiveAudio.hasAttribute("src"), false);
    mountedRoot = null;

    const replacementItem: PodcastPreviewItem = {
      ...items[0],
      id: "article:13",
      articleId: 13,
      title: "替换播客",
      audioUrl: "https://cdn.example.com/replacement.mp3",
    };
    const audioDispatches: PodcastPlaybackAction[] = [];
    const continuousNextIds: string[] = [];
    const renderAudio = async (item: PodcastPreviewItem) => {
      await act(async () => {
        mountedRoot?.render(React.createElement(PodcastAudioElement, {
          key: item.id,
          item,
          continuousPlay: true,
          onDispatch: (action: PodcastPlaybackAction) => { audioDispatches.push(action); },
          onPlayNext: (itemId: string) => { continuousNextIds.push(itemId); },
        }));
      });
    };

    mountedRoot = createRoot(container);
    await renderAudio(items[0]);
    const oldAudio = container.querySelector<HTMLAudioElement>("audio");
    assert.ok(oldAudio);
    let oldPauseCalls = 0;
    let oldLoadCalls = 0;
    Object.defineProperties(oldAudio, {
      pause: { configurable: true, value: () => { oldPauseCalls += 1; } },
      load: { configurable: true, value: () => { oldLoadCalls += 1; } },
    });
    await renderAudio(replacementItem);
    const currentAudio = container.querySelector<HTMLAudioElement>("audio");
    assert.ok(currentAudio);
    assert.notEqual(currentAudio, oldAudio, "a source change must remount the audio event generation");
    assert.equal(oldPauseCalls, 1, "switching sources must stop the detached audio node");
    assert.equal(oldAudio.hasAttribute("src"), false, "switching sources must release the old source");
    assert.equal(oldLoadCalls, 1, "switching sources must reset the detached media resource");
    audioDispatches.length = 0;
    continuousNextIds.length = 0;

    for (const eventType of ["pause", "error", "timeupdate", "ended"] as const) {
      oldAudio.dispatchEvent(new dom.window.Event(eventType, { bubbles: true }));
    }
    assert.deepEqual(audioDispatches, [], "events from an unmounted source must be ignored");
    assert.deepEqual(continuousNextIds, [], "an old ended event must not advance continuous play");

    currentAudio.currentTime = 42;
    for (const eventType of ["pause", "error", "timeupdate", "ended"] as const) {
      currentAudio.dispatchEvent(new dom.window.Event(eventType, { bubbles: true }));
    }
    assert.deepEqual(
      audioDispatches.map(action => [action.type, "itemId" in action ? action.itemId : null]),
      [
        ["paused", replacementItem.id],
        ["error", replacementItem.id],
        ["time_update", replacementItem.id],
        ["ended", replacementItem.id],
      ],
      "the current audio generation must dispatch only its captured item id",
    );
    assert.deepEqual(continuousNextIds, [replacementItem.id]);

    let currentPauseCalls = 0;
    let currentLoadCalls = 0;
    Object.defineProperties(currentAudio, {
      pause: { configurable: true, value: () => { currentPauseCalls += 1; } },
      load: { configurable: true, value: () => { currentLoadCalls += 1; } },
    });
    await act(async () => {
      mountedRoot?.unmount();
    });
    assert.equal(currentPauseCalls, 1, "unmounting the controller must stop the current audio node");
    assert.equal(currentAudio.hasAttribute("src"), false, "unmounting must release the current source");
    assert.equal(currentLoadCalls, 1, "unmounting must reset the current media resource");
    mountedRoot = createRoot(container);
    let toggleCalls = 0;
    let previousCalls = 0;
    let nextCalls = 0;
    await act(async () => {
      mountedRoot?.render(React.createElement(PodcastPageContent, {
        ...pageProps,
        onToggle: () => { toggleCalls += 1; },
        onPrevious: () => { previousCalls += 1; },
        onNext: () => { nextCalls += 1; },
      }));
    });

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

    await act(async () => {
      mountedRoot?.unmount();
    });
    mountedRoot = null;

    let playbackController: PodcastPlaybackContextValue | null = null;
    function PlaybackProbe() {
      playbackController = usePodcastPlayback();
      return React.createElement("span", { "data-playback-probe": true }, "playback probe");
    }
    function FullPlayerPresence() {
      usePodcastFullPlayerPresence();
      return React.createElement("span", { "data-full-player": true }, "full player");
    }
    const currentController = () => {
      assert.ok(playbackController, "the provider probe must expose its controller");
      return playbackController;
    };
    const renderProvider = async (
      fullPlayerVisible: boolean,
      ownerIdentity: string | number | null | undefined = 101,
    ) => {
      await act(async () => {
        mountedRoot?.render(React.createElement(
          PodcastPlaybackProvider,
          { showMiniPlayer: true, ownerIdentity },
          React.createElement(
            React.Fragment,
            null,
            React.createElement(PlaybackProbe),
            React.createElement(PodcastArticleAudioControls, { article: readerAudioArticle }),
            fullPlayerVisible ? React.createElement(FullPlayerPresence) : null,
          ),
        ));
      });
    };

    mountedRoot = createRoot(container);
    await renderProvider(true);
    assert.equal(container.querySelectorAll("audio").length, 1, "the provider owns exactly one media node");
    assert.ok(
      container.querySelector('[aria-label="\u6587\u7ae0\u97f3\u9891\uff1a\u771f\u5b9e\u64ad\u5ba2"]'),
      "the regular Reader surface must expose controls without owning a second media element",
    );

    await act(async () => {
      currentController().setQueue([items[0]]);
      assert.equal(currentController().toggle(items[0]), true);
    });
    const persistentAudio = container.querySelector<HTMLAudioElement>("audio");
    assert.ok(persistentAudio);
    assert.match(persistentAudio.src, /episode\.mp3$/);
    assert.equal(
      container.querySelector('[aria-label="\u5168\u5c40\u64ad\u5ba2\u64ad\u653e\u5668"]'),
      null,
      "the mini player stays hidden while the full player is mounted",
    );

    Object.defineProperty(persistentAudio, "duration", { configurable: true, value: 1512 });
    persistentAudio.currentTime = 42;
    await act(async () => {
      persistentAudio.dispatchEvent(new dom.window.Event("loadedmetadata", { bubbles: true }));
      persistentAudio.dispatchEvent(new dom.window.Event("playing", { bubbles: true }));
      persistentAudio.dispatchEvent(new dom.window.Event("timeupdate", { bubbles: true }));
    });
    assert.equal(currentController().playback.status, "playing");
    assert.equal(currentController().playback.currentTime, 42);

    await act(async () => {
      currentController().browse(items[1].id);
    });
    assert.equal(currentController().playback.browseItemId, items[1].id);
    assert.equal(
      currentController().playback.activeItemId,
      items[0].id,
      "browsing a pending item must not replace the playing source",
    );

    await renderProvider(false);
    const audioAfterPageUnmount = container.querySelector<HTMLAudioElement>("audio");
    assert.equal(
      audioAfterPageUnmount,
      persistentAudio,
      "unmounting the full page must preserve the provider-owned media node",
    );
    const miniPlayer = container.querySelector<HTMLElement>('[aria-label="\u5168\u5c40\u64ad\u5ba2\u64ad\u653e\u5668"]');
    assert.ok(miniPlayer, "navigation away must reveal the global mini player");
    assert.match(miniPlayer.textContent || "", /\u771f\u5b9e\u64ad\u5ba2/);
    assert.equal(
      miniPlayer.querySelector<HTMLInputElement>('input[type="range"]')?.value,
      "42",
      "the mini player must retain playback progress",
    );
    const collapseMiniPlayer = miniPlayer.querySelector<HTMLButtonElement>('[aria-label="\u6536\u8d77\u8ff7\u4f60\u64ad\u653e\u5668"]');
    assert.ok(collapseMiniPlayer, "the cross-page mini player must be collapsible");
    await act(async () => {
      collapseMiniPlayer.click();
    });
    const collapsedMiniPlayer = container.querySelector<HTMLElement>('[aria-label="\u5168\u5c40\u64ad\u5ba2\u64ad\u653e\u5668"]');
    assert.equal(collapsedMiniPlayer?.dataset.collapsed, "true");
    assert.equal(container.querySelector("audio"), persistentAudio, "collapsing controls must not replace or stop the media node");
    const expandMiniPlayer = collapsedMiniPlayer?.querySelector<HTMLButtonElement>('[aria-label="\u5c55\u5f00\u8ff7\u4f60\u64ad\u653e\u5668"]');
    assert.ok(expandMiniPlayer);
    await act(async () => {
      expandMiniPlayer.click();
    });
    assert.equal(
      container.querySelector<HTMLInputElement>('[aria-label="\u5168\u5c40\u64ad\u5ba2\u64ad\u653e\u5668"] input[type="range"]')?.value,
      "42",
      "expanding the mini player must reveal the unchanged playback progress",
    );

    await act(async () => {
      currentController().setRate(1.5);
      currentController().seek(90);
    });
    assert.equal(persistentAudio.playbackRate, 1.5);
    assert.equal(persistentAudio.currentTime, 90);
    assert.equal(currentController().playback.currentTime, 90);
    let pendingAccepted = true;
    await act(async () => {
      pendingAccepted = currentController().toggle(items[1]);
    });
    assert.equal(pendingAccepted, false, "a summary-only item must never enter a fake playback state");
    assert.equal(currentController().playback.activeItemId, items[0].id);

    const nextNativeItem: PodcastPreviewItem = {
      ...items[0],
      id: "article:13:continuous",
      articleId: 13,
      title: "\u8fde\u7eed\u64ad\u653e下一集",
      audioUrl: "https://cdn.example.com/next.mp3",
    };
    await act(async () => {
      currentController().setQueue([items[0], items[1], nextNativeItem]);
      currentController().setContinuousPlay(true);
    });
    await act(async () => {
      persistentAudio.dispatchEvent(new dom.window.Event("ended", { bubbles: true }));
      await Promise.resolve();
    });
    const nextAudio = container.querySelector<HTMLAudioElement>("audio");
    assert.ok(nextAudio);
    assert.notEqual(nextAudio, persistentAudio);
    assert.match(nextAudio.src, /next\.mp3$/);
    assert.equal(currentController().playback.activeItemId, nextNativeItem.id);

    await act(async () => {
      nextAudio.dispatchEvent(new dom.window.Event("error", { bubbles: true }));
    });
    assert.equal(currentController().playback.status, "error");
    assert.match(container.textContent || "", /\u8be5\u97f3\u9891\u6682\u65f6\u65e0\u6cd5\u64ad\u653e/);
    await act(async () => {
      currentController().retry();
      await Promise.resolve();
    });
    assert.equal(currentController().playback.status, "loading");

    let logoutPauseCalls = 0;
    Object.defineProperty(nextAudio, "pause", {
      configurable: true,
      value: () => { logoutPauseCalls += 1; },
    });
    nextAudio.currentTime = 27;
    await renderProvider(false, null);
    assert.ok(logoutPauseCalls >= 1, "logout must immediately pause the provider-owned media node");
    assert.equal(currentController().activeItem, undefined, "logout must not retain another user's active episode");
    assert.deepEqual(currentController().queue, [], "logout must clear the user-scoped continuous-play queue");
    assert.equal(currentController().playback.activeItemId, null);
    assert.equal(currentController().playback.browseItemId, null);
    assert.equal(currentController().playback.currentTime, 0);
    assert.equal(currentController().playback.duration, 0);
    assert.equal(currentController().playback.status, "idle");
    assert.equal(currentController().playback.playbackRate, 1);
    assert.equal(currentController().playback.continuousPlay, false);
    assert.equal(
      container.querySelector('[aria-label="\u5168\u5c40\u64ad\u5ba2\u64ad\u653e\u5668"]'),
      null,
      "the signed-out surface must not expose the previous user's episode metadata",
    );
    const signedOutAudio = container.querySelector<HTMLAudioElement>("audio");
    assert.ok(signedOutAudio);
    assert.equal(signedOutAudio.hasAttribute("src"), false);

    await renderProvider(false, 202);
    assert.equal(currentController().activeItem, undefined, "a new account must start with an empty playback session");
    assert.deepEqual(currentController().queue, []);
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
    if (mediaPauseDescriptor) {
      Object.defineProperty(dom.window.HTMLMediaElement.prototype, "pause", mediaPauseDescriptor);
    } else {
      Reflect.deleteProperty(dom.window.HTMLMediaElement.prototype, "pause");
    }
    if (mediaLoadDescriptor) {
      Object.defineProperty(dom.window.HTMLMediaElement.prototype, "load", mediaLoadDescriptor);
    } else {
      Reflect.deleteProperty(dom.window.HTMLMediaElement.prototype, "load");
    }
    if (mediaPlayDescriptor) {
      Object.defineProperty(dom.window.HTMLMediaElement.prototype, "play", mediaPlayDescriptor);
    } else {
      Reflect.deleteProperty(dom.window.HTMLMediaElement.prototype, "play");
    }
    restoreDomGlobals();
    dom.window.close();
  }

  console.log("PASS: podcast playback persists globally with one audio element and honest states");
} finally {
  await vite.close();
}
