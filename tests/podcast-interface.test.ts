import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import sharp from "sharp";
import { createServer } from "vite";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testDir, "..");
const assetPath = (name: string) => path.join(root, "public/assets/podcast", name);

const installTemporaryDomGlobals = (dom: JSDOM) => {
  const domWindow = dom.window;
  const globals: Record<string, unknown> = {
    window: domWindow,
    document: domWindow.document,
    navigator: domWindow.navigator,
    HTMLElement: domWindow.HTMLElement,
    HTMLDialogElement: domWindow.HTMLDialogElement,
    Event: domWindow.Event,
    MouseEvent: domWindow.MouseEvent,
    Node: domWindow.Node,
    getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const originalDescriptors = new Map<string, PropertyDescriptor | undefined>();

  for (const [name, value] of Object.entries(globals)) {
    originalDescriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  }

  return () => {
    for (const [name, descriptor] of originalDescriptors) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, name);
      }
    }
  };
};

const referenceMetadata = await sharp(
  path.join(root, "docs/superpowers/design-references/podcast-player-reference.png"),
).metadata();
assert.equal(referenceMetadata.width, 622);
assert.equal(referenceMetadata.height, 948);

const vinylMetadata = await sharp(assetPath("vinyl-record.png")).metadata();
assert.equal(vinylMetadata.width, vinylMetadata.height);
assert.ok(vinylMetadata.width! >= 1000, "vinyl asset must remain high-resolution");

const coverMetadata = await sharp(assetPath("editorial-fallback-cover.png")).metadata();
assert.equal(coverMetadata.width! * 5, coverMetadata.height! * 4);
assert.ok(coverMetadata.width! >= 800, "fallback cover must remain high-resolution");

const waveformPath = assetPath("waveform-mask.png");
const waveformMetadata = await sharp(waveformPath).metadata();
assert.equal(waveformMetadata.width, 1776);
assert.equal(waveformMetadata.height, 222);
assert.equal(waveformMetadata.width, waveformMetadata.height! * 8);
assert.equal(waveformMetadata.channels, 1, "waveform-mask.png must be stored as grayscale");
assert.equal(waveformMetadata.space, "b-w", "waveform-mask.png must use a grayscale color space");
const waveformRaw = await sharp(waveformPath)
  .toColourspace("b-w")
  .raw()
  .toBuffer({ resolveWithObject: true });
assert.equal(waveformRaw.info.channels, 1);
const waveformValues = [...new Set(waveformRaw.data)].sort((left, right) => left - right);
assert.deepEqual(
  waveformValues,
  [0, 255],
  "waveform-mask.png must contain both black and white and no non-binary values",
);
const whitePixelCount = waveformRaw.data.reduce(
  (total, value) => total + (value === 255 ? 1 : 0),
  0,
);
const whiteCoverage = whitePixelCount / waveformRaw.data.length;
assert.ok(whiteCoverage > 0.05 && whiteCoverage < 0.5, "waveform foreground coverage must remain legible");
for (let x = 0; x < waveformRaw.info.width; x += 1) {
  assert.equal(waveformRaw.data[x], 0, "waveform top edge must remain black");
  const bottomPixel = (waveformRaw.info.height - 1) * waveformRaw.info.width + x;
  assert.equal(waveformRaw.data[bottomPixel], 0, "waveform bottom edge must remain black");
}
for (let y = 0; y < waveformRaw.info.height; y += 1) {
  assert.equal(waveformRaw.data[y * waveformRaw.info.width], 0, "waveform left edge must remain black");
  const rightPixel = y * waveformRaw.info.width + waveformRaw.info.width - 1;
  assert.equal(waveformRaw.data[rightPixel], 0, "waveform right edge must remain black");
}

process.env.DISABLE_HMR = "true";
const vite = await createServer({
  root,
  appType: "custom",
  configFile: false,
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, hmr: false },
});

try {
  const [
    controlsModule,
    coverModule,
    stageModule,
    insightModule,
    contextModule,
    railModule,
  ] = await Promise.all([
    vite.ssrLoadModule("/src/components/podcast/PodcastControls.tsx"),
    vite.ssrLoadModule("/src/components/podcast/PodcastCover.tsx"),
    vite.ssrLoadModule("/src/components/podcast/PodcastStage.tsx"),
    vite.ssrLoadModule("/src/components/podcast/PodcastInsightPanel.tsx"),
    vite.ssrLoadModule("/src/components/podcast/PodcastContextPanel.tsx"),
    vite.ssrLoadModule("/src/components/podcast/PodcastCardRail.tsx"),
  ]) as Array<Record<string, unknown>>;

  const PodcastControls = controlsModule.PodcastControls as React.ComponentType<Record<string, unknown>>;
  const PodcastCover = coverModule.PodcastCover as React.ComponentType<Record<string, unknown>>;
  const PodcastStage = stageModule.PodcastStage as React.ComponentType<Record<string, unknown>>;
  const PodcastInsightPanel = insightModule.PodcastInsightPanel as React.ComponentType<Record<string, unknown>>;
  const PodcastContextPanel = contextModule.PodcastContextPanel as React.ComponentType<Record<string, unknown>>;
  const PodcastCardRail = railModule.PodcastCardRail as React.ComponentType<Record<string, unknown>>;

  const noop = () => undefined;
  const item = {
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
    imageUrl: "https://images.example.com/episode-cover.jpg",
    sourceUrl: "https://example.com/podcast",
    audioUrl: "https://cdn.example.com/episode.mp3",
    audioDuration: "25:12",
    isSaved: false,
  };
  const pendingItem = {
    ...item,
    id: "article:12",
    kind: "article_pending",
    title: "待解读文章",
    imageUrl: undefined,
    audioUrl: undefined,
    audioDuration: undefined,
  };
  const baseControlsProps = {
    item,
    isActive: true,
    status: "playing",
    currentTime: 42,
    duration: 1512,
    metadataReady: true,
    playbackRate: 1,
    error: null,
    onToggle: noop,
    onSeek: noop,
    onSkip: noop,
    onRateChange: noop,
    onRetry: noop,
  };
  const renderControls = (overrides: Record<string, unknown> = {}) =>
    renderToStaticMarkup(React.createElement(PodcastControls, {
      ...baseControlsProps,
      ...overrides,
    }));
  const count = (html: string, pattern: RegExp) => html.match(pattern)?.length ?? 0;
  const assertSafeExternalLink = (html: string, accessibleName: string) => {
    assert.match(html, /target="_blank"/);
    assert.match(html, /rel="noreferrer noopener"/);
    assert.ok(html.includes(`aria-label="${accessibleName}"`));
  };

  const customCoverHtml = renderToStaticMarkup(React.createElement(PodcastCover, {
    item,
    isPlaying: true,
  }));
  assert.match(customCoverHtml, /src="\/assets\/podcast\/vinyl-record\.png"/);
  assert.match(customCoverHtml, /podcast-vinyl--playing/);
  assert.match(customCoverHtml, /alt="" aria-hidden="true"/);
  assert.match(customCoverHtml, /src="https:\/\/images\.example\.com\/episode-cover\.jpg"/);
  assert.match(customCoverHtml, /alt="真实播客 封面"/);

  const fallbackCoverHtml = renderToStaticMarkup(React.createElement(PodcastCover, {
    item: pendingItem,
    isPlaying: false,
  }));
  assert.match(fallbackCoverHtml, /src="\/assets\/podcast\/editorial-fallback-cover\.png"/);
  assert.match(fallbackCoverHtml, /alt="待解读文章 封面"/);
  assert.doesNotMatch(fallbackCoverHtml, /podcast-vinyl--playing/);

  const stageHtml = renderToStaticMarkup(React.createElement(PodcastStage, {
    item,
    index: 1,
    total: 4,
    isPlaying: true,
    controls: React.createElement("span", { "data-controls-slot": "true" }, "播放器控件"),
    onPrevious: noop,
    onNext: noop,
    onOpenContext: noop,
  }));
  assert.match(stageHtml, /aria-live="polite">真实播客，第 2 条，共 4 条/);
  const visibleStageHtml = stageHtml.slice(stageHtml.indexOf("<section"));
  const stageMarkers = [
    "来自 产品沉思录",
    "/assets/podcast/vinyl-record.png",
    "原生节目",
    "今天 09:30",
    '<h1 class="podcast-stage-title">真实播客</h1>',
    'data-controls-slot="true"',
    'aria-label="上一条"',
  ];
  let priorMarkerIndex = -1;
  for (const marker of stageMarkers) {
    const markerIndex = visibleStageHtml.indexOf(marker);
    assert.ok(markerIndex > priorMarkerIndex, `stage marker must be visible in order: ${marker}`);
    priorMarkerIndex = markerIndex;
  }
  assert.match(stageHtml, /aria-label="下一条"/);
  assert.match(stageHtml, /aria-label="查看真实播客的内容上下文"/);
  const pendingStageHtml = renderToStaticMarkup(React.createElement(PodcastStage, {
    item: pendingItem,
    index: 0,
    total: 1,
    isPlaying: false,
    controls: null,
    onPrevious: noop,
    onNext: noop,
    onOpenContext: noop,
  }));
  assert.match(pendingStageHtml, /文章待解读/);
  assert.doesNotMatch(pendingStageHtml, /AI 解读/);

  const thoughtAction = React.createElement(
    "button",
    { type: "button", "data-thought-action": "true" },
    "说下我的想法",
  );
  const insightProps = {
    item,
    saving: false,
    savingLabel: null,
    thoughtAction,
    onSave: noop,
    onGenerate: noop,
    onOpenContext: noop,
  };
  const insightHtml = renderToStaticMarkup(React.createElement(PodcastInsightPanel, insightProps));
  assert.match(insightHtml, /基于 RSS 摘要/);
  assert.match(insightHtml, /当前观点/);
  assert.match(insightHtml, /这是 RSS 摘要。/);
  assert.match(insightHtml, /data-thought-action="true"/);
  assert.match(insightHtml, />存入知识库</);
  assert.doesNotMatch(insightHtml, />生成解读</);
  assertSafeExternalLink(insightHtml, "打开产品沉思录的《真实播客》原文");

  const savingInsightHtml = renderToStaticMarkup(React.createElement(PodcastInsightPanel, {
    ...insightProps,
    saving: true,
    savingLabel: "保存中",
  }));
  assert.match(savingInsightHtml, /disabled=""/);
  assert.match(savingInsightHtml, />保存中</);

  const savedInsightHtml = renderToStaticMarkup(React.createElement(PodcastInsightPanel, {
    ...insightProps,
    item: { ...item, isSaved: true },
  }));
  assert.match(savedInsightHtml, /disabled=""/);
  assert.match(savedInsightHtml, />已在知识库</);
  assert.doesNotMatch(savedInsightHtml, />存入知识库</);

  const pendingInsightHtml = renderToStaticMarkup(React.createElement(PodcastInsightPanel, {
    ...insightProps,
    item: pendingItem,
  }));
  assert.match(pendingInsightHtml, />生成解读</);

  const noSourceOrArticleInsightHtml = renderToStaticMarkup(React.createElement(PodcastInsightPanel, {
    ...insightProps,
    item: { ...item, articleId: undefined, sourceUrl: undefined },
  }));
  assert.doesNotMatch(noSourceOrArticleInsightHtml, /打开原文|存入知识库/);

  const sidebarHtml = renderToStaticMarkup(React.createElement(PodcastContextPanel, {
    item,
    variant: "sidebar",
    open: true,
    onClose: noop,
  }));
  assert.match(sidebarHtml, /^<aside/);
  assert.doesNotMatch(sidebarHtml, /hidden=""/);
  assert.match(sidebarHtml, /产品沉思录/);
  assert.match(sidebarHtml, /产品/);
  assert.match(sidebarHtml, /今天 09:30/);
  assert.match(sidebarHtml, /这是 RSS 摘要。/);
  assert.match(sidebarHtml, /基于 RSS 摘要/);
  assert.match(sidebarHtml, /尚无 AI 章节与逐字稿/);
  const hiddenSidebarHtml = renderToStaticMarkup(React.createElement(PodcastContextPanel, {
    item,
    variant: "sidebar",
    open: false,
    onClose: noop,
  }));
  assert.match(hiddenSidebarHtml, /hidden=""/);
  const dialogHtml = renderToStaticMarkup(React.createElement(PodcastContextPanel, {
    item,
    variant: "dialog",
    open: false,
    onClose: noop,
  }));
  assert.match(dialogHtml, /^<dialog/);
  assert.match(dialogHtml, /aria-labelledby=/);

  const dom = new JSDOM(
    "<!doctype html><html><body><button id=\"context-invoker\">打开上下文</button><div id=\"podcast-root\"></div></body></html>",
    { url: "https://atomflow.test/" },
  );
  const restoreDomGlobals = installTemporaryDomGlobals(dom);
  const dialogPrototype = dom.window.HTMLDialogElement.prototype;
  const originalShowModal = Object.getOwnPropertyDescriptor(dialogPrototype, "showModal");
  const originalClose = Object.getOwnPropertyDescriptor(dialogPrototype, "close");
  let mountedRoot: Root | null = null;

  try {
    const invoker = dom.window.document.querySelector<HTMLButtonElement>("#context-invoker");
    const container = dom.window.document.querySelector<HTMLDivElement>("#podcast-root");
    assert.ok(invoker);
    assert.ok(container);

    let showModalCalls = 0;
    let closeCalls = 0;
    let focusBeforeShow: { focus: () => void } | null = null;
    Object.defineProperty(dialogPrototype, "showModal", {
      configurable: true,
      writable: true,
      value(this: HTMLDialogElement) {
        showModalCalls += 1;
        const activeElement = dom.window.document.activeElement;
        focusBeforeShow = activeElement
          && "focus" in activeElement
          && typeof activeElement.focus === "function"
          ? activeElement
          : null;
        this.setAttribute("open", "");
        this.tabIndex = -1;
        this.focus();
      },
    });
    Object.defineProperty(dialogPrototype, "close", {
      configurable: true,
      writable: true,
      value(this: HTMLDialogElement) {
        closeCalls += 1;
        this.removeAttribute("open");
        focusBeforeShow?.focus();
        this.dispatchEvent(new dom.window.Event("close"));
      },
    });

    let onCloseCalls = 0;
    const onClose = () => {
      onCloseCalls += 1;
    };
    const renderDialog = async (open: boolean) => {
      await act(async () => {
        mountedRoot?.render(React.createElement(PodcastContextPanel, {
          item,
          variant: "dialog",
          open,
          onClose,
        }));
      });
    };

    invoker.focus();
    assert.equal(dom.window.document.activeElement, invoker);
    mountedRoot = createRoot(container);
    await renderDialog(false);
    const controlledDialog = container.querySelector<HTMLDialogElement>("dialog");
    assert.ok(controlledDialog);
    assert.equal(showModalCalls, 0);
    assert.equal(closeCalls, 0);

    await renderDialog(true);
    assert.equal(showModalCalls, 1, "false -> true must call showModal exactly once");
    assert.equal(controlledDialog.open, true);
    assert.equal(dom.window.document.activeElement, controlledDialog);

    await renderDialog(false);
    assert.equal(closeCalls, 1, "true -> false must call close exactly once");
    assert.equal(controlledDialog.open, false);
    assert.equal(onCloseCalls, 0, "a controlled close must not call onClose");
    assert.equal(dom.window.document.activeElement, invoker, "focus must return to the invoker");

    await renderDialog(true);
    assert.equal(showModalCalls, 2);
    const cancelEvent = new dom.window.Event("cancel", { bubbles: false, cancelable: true });
    await act(async () => {
      controlledDialog.dispatchEvent(cancelEvent);
    });
    assert.equal(cancelEvent.defaultPrevented, true, "cancel must prevent the browser default");
    assert.equal(onCloseCalls, 1, "cancel must notify the controlled parent exactly once");
    assert.equal(closeCalls, 1, "cancel must wait for the controlled parent to close the dialog");
    assert.equal(controlledDialog.open, true);

    await renderDialog(false);
    assert.equal(closeCalls, 2, "the parent close after cancel must close exactly once");
    assert.equal(onCloseCalls, 1, "the parent rerender must not duplicate the cancel callback");
    assert.equal(controlledDialog.open, false);
    assert.equal(dom.window.document.activeElement, invoker, "focus must return after cancel closes");
  } finally {
    if (mountedRoot) {
      await act(async () => {
        mountedRoot?.unmount();
      });
    }
    if (originalShowModal) {
      Object.defineProperty(dialogPrototype, "showModal", originalShowModal);
    } else {
      Reflect.deleteProperty(dialogPrototype, "showModal");
    }
    if (originalClose) {
      Object.defineProperty(dialogPrototype, "close", originalClose);
    } else {
      Reflect.deleteProperty(dialogPrototype, "close");
    }
    restoreDomGlobals();
    dom.window.close();
  }

  const railItems = [item, pendingItem];
  const railHtml = renderToStaticMarkup(React.createElement(PodcastCardRail, {
    items: railItems,
    activeId: item.id,
    onSelect: noop,
    onPrevious: noop,
    onNext: noop,
  }));
  assert.equal(count(railHtml, /aria-label="浏览：/g), railItems.length);
  assert.equal(count(railHtml, /aria-current="true"/g), 1);
  assert.match(railHtml, /aria-label="浏览：真实播客"/);
  assert.match(railHtml, /aria-label="浏览：待解读文章"/);
  assert.match(railHtml, /aria-label="浏览上一条"/);
  assert.match(railHtml, /aria-label="浏览下一条"/);
  assert.match(railHtml, /src="\/assets\/podcast\/editorial-fallback-cover\.png"/);
  const singleRailHtml = renderToStaticMarkup(React.createElement(PodcastCardRail, {
    items: [item],
    activeId: item.id,
    onSelect: noop,
    onPrevious: noop,
    onNext: noop,
  }));
  assert.equal(count(singleRailHtml, /class="podcast-rail-navigation"[^>]*disabled=""/g), 2);

  const pendingControlsHtml = renderControls({
    item: pendingItem,
    isActive: false,
    status: "idle",
    currentTime: 0,
    duration: 0,
    metadataReady: false,
  });
  assert.equal(count(pendingControlsHtml, /<button\b/g), 1);
  assert.match(pendingControlsHtml, />生成解读</);
  assert.match(pendingControlsHtml, /音频生成尚未接入/);
  assert.doesNotMatch(pendingControlsHtml, /type="range"|0:00/);

  const inactiveControlsHtml = renderControls({
    isActive: false,
    status: "idle",
    currentTime: 0,
    duration: 0,
    metadataReady: false,
  });
  assert.match(inactiveControlsHtml, /aria-label="播放真实播客"/);
  assert.match(inactiveControlsHtml, /时长 25:12/);
  assert.doesNotMatch(inactiveControlsHtml, /type="range"|快退 15 秒|快进 15 秒/);

  const loadingControlsHtml = renderControls({ status: "loading", metadataReady: false });
  assert.match(loadingControlsHtml, /aria-label="正在加载真实播客"[^>]*disabled=""/);
  assert.match(loadingControlsHtml, /role="status">正在加载音频/);
  assert.doesNotMatch(loadingControlsHtml, /type="range"/);

  const readyControlsHtml = renderControls();
  assert.match(readyControlsHtml, /aria-label="暂停真实播客"/);
  assert.match(readyControlsHtml, /aria-label="快退 15 秒"/);
  assert.match(readyControlsHtml, /aria-label="快进 15 秒"/);
  assert.match(readyControlsHtml, /aria-label="播放速度 1 倍，切换为 1.25 倍"/);
  assert.match(readyControlsHtml, /type="range"/);
  assert.match(readyControlsHtml, /aria-valuetext="0:42 \/ 25:12"/);
  assert.match(readyControlsHtml, /podcast-progress-texture" aria-hidden="true"/);
  assert.match(readyControlsHtml, /podcast-progress-layer podcast-progress-layer--base/);
  assert.match(readyControlsHtml, /podcast-progress-layer podcast-progress-layer--played/);

  const pausedControlsHtml = renderControls({ status: "paused" });
  assert.match(pausedControlsHtml, /aria-label="播放真实播客"/);
  const rateWrapControlsHtml = renderControls({ playbackRate: 2 });
  assert.match(rateWrapControlsHtml, /播放速度 2 倍，切换为 1 倍/);

  const metadataUnreadyHtml = renderControls({ metadataReady: false });
  assert.doesNotMatch(metadataUnreadyHtml, /type="range"|aria-valuetext/);
  const zeroDurationHtml = renderControls({ duration: 0, currentTime: 0 });
  assert.doesNotMatch(zeroDurationHtml, /type="range"|aria-valuetext/);

  const errorControlsHtml = renderControls({
    status: "error",
    error: "媒体加载失败",
    metadataReady: false,
  });
  assert.match(errorControlsHtml, /role="alert">媒体加载失败/);
  assert.match(errorControlsHtml, />重试播放</);
  assert.match(errorControlsHtml, />打开原节目</);
  assertSafeExternalLink(errorControlsHtml, "打开产品沉思录的《真实播客》原节目");
  const noSourceErrorHtml = renderControls({
    item: { ...item, sourceUrl: undefined },
    status: "error",
    error: "媒体加载失败",
    metadataReady: false,
  });
  assert.doesNotMatch(noSourceErrorHtml, /打开原节目|target="_blank"/);

  const compactControlsHtml = renderControls({ compact: true });
  assert.match(compactControlsHtml, /真实播客/);
  assert.match(compactControlsHtml, /产品沉思录/);
  assert.match(compactControlsHtml, /aria-label="暂停真实播客"/);
  assert.doesNotMatch(compactControlsHtml, /type="range"|快退 15 秒|快进 15 秒|播放速度/);
  const compactErrorHtml = renderControls({
    compact: true,
    status: "error",
    error: "迷你播放器失败",
  });
  assert.match(compactErrorHtml, /role="alert">迷你播放器失败/);

  const allControlsHtml = [
    pendingControlsHtml,
    inactiveControlsHtml,
    loadingControlsHtml,
    readyControlsHtml,
    pausedControlsHtml,
    errorControlsHtml,
    compactControlsHtml,
  ].join("");
  assert.doesNotMatch(allControlsHtml, /<audio/);

  const css = readFileSync(path.join(root, "src/components/podcast/podcast.css"), "utf8");
  const controlsSource = readFileSync(
    path.join(root, "src/components/podcast/PodcastControls.tsx"),
    "utf8",
  );
  const contextSource = readFileSync(
    path.join(root, "src/components/podcast/PodcastContextPanel.tsx"),
    "utf8",
  );
  const presentationalSource = [
    controlsSource,
    readFileSync(path.join(root, "src/components/podcast/PodcastCover.tsx"), "utf8"),
    readFileSync(path.join(root, "src/components/podcast/PodcastStage.tsx"), "utf8"),
    readFileSync(path.join(root, "src/components/podcast/PodcastInsightPanel.tsx"), "utf8"),
    contextSource,
    readFileSync(path.join(root, "src/components/podcast/PodcastCardRail.tsx"), "utf8"),
  ].join("\n");
  assert.doesNotMatch(presentationalSource, /\bfetch\s*\(/);
  assert.doesNotMatch(presentationalSource, /\buseAppContext\b/);
  assert.doesNotMatch(presentationalSource, /<audio\b/);
  assert.doesNotMatch(controlsSource, /<audio\b/);
  assert.match(contextSource, /dialog\.showModal\(\)/);
  assert.match(contextSource, /dialog\.close\(\)/);
  assert.match(contextSource, /onCancel=\{handleCancel\}/);
  assert.match(contextSource, /event\.preventDefault\(\)/);
  assert.doesNotMatch(contextSource, /<dialog[\s\S]*?onClose=\{onClose\}/);

  assert.match(css, /width: min\(52vw, 390px\)/);
  assert.match(css, /width: min\(72vw, 280px\)/);
  assert.match(css, /animation: podcast-vinyl-spin 18s linear infinite/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /waveform-mask\.png/);
  assert.match(css, /mask-mode: luminance/);
  assert.match(css, /clip-path:\s*inset\(0 calc\(100% - var\(--podcast-progress\)\)/);
  assert.match(css, /\.podcast-progress-range:focus-visible/);
  assert.match(css, /\.podcast-control-link:focus-visible/);
  assert.match(css, /\.podcast-controls button:focus-visible/);
  assert.match(css, /\.podcast-rail-navigation\s*\{[\s\S]*?width: 44px/);
  assert.match(
    css,
    /\.podcast-control-primary,\s*\.podcast-control-round,\s*\.podcast-rate-button\s*\{[^}]*border: 1px solid var\(--theme-border\);[^}]*background: var\(--theme-surface\);[^}]*color: var\(--theme-text-main\);/,
  );
  assert.match(
    css,
    /\.podcast-control-link\s*\{[^}]*border-color: var\(--theme-border\);[^}]*background: var\(--theme-surface\);[^}]*color: var\(--theme-text-main\);/,
  );
  assert.match(
    css,
    /\.podcast-stage \.podcast-control-primary,\s*\.podcast-stage \.podcast-control-round,\s*\.podcast-stage \.podcast-rate-button,\s*\.podcast-stage \.podcast-control-link\s*\{[^}]*border-color: #4a443c;[^}]*background: #2a2621;[^}]*color: #f7f5f0;/,
  );
  assert.match(
    css,
    /\.podcast-insight-panel,\s*\.podcast-context-panel,\s*\.podcast-context-dialog\s*\{[^}]*box-shadow: [^;}]*rgba\(0, 0, 0,/,
  );
  assert.match(
    css,
    /\.podcast-context-dialog::backdrop\s*\{[^}]*background: rgba\(0, 0, 0,/,
  );
  const warmDarkValue = /#1c1916|#2a2621|#4a443c|#f7f5f0|#a09890|rgba\(28, 25, 22/i;
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!warmDarkValue.test(rule[2])) continue;
    const selectors = rule[1]
      .replace(/@media[^{}]+/g, "")
      .trim()
      .split(",")
      .map(selector => selector.trim())
      .filter(Boolean);
    for (const selector of selectors) {
      assert.match(selector, /\.podcast-stage(?:\s|$)/, `warm-dark value leaked outside stage: ${selector}`);
    }
  }
  assert.doesNotMatch(css, /:root\s*\{|\.dark\s*\{/);
  assert.doesNotMatch(css, /#ff6b6b|#fb7185|#f97316|coral/i);
} finally {
  await vite.close();
}

console.log("PASS: podcast components, states, assets, and theme contracts");
