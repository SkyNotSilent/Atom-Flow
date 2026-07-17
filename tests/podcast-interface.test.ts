import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testDir, "..");
const vite = await createServer({ root, appType: "custom", server: { middlewareMode: true } });
const controlsModule = await vite.ssrLoadModule("/src/components/podcast/PodcastControls.tsx") as Record<string, unknown>;
const contextModule = await vite.ssrLoadModule("/src/components/podcast/PodcastContextPanel.tsx") as Record<string, unknown>;
const PodcastControls = controlsModule.PodcastControls as React.ComponentType<Record<string, unknown>>;
const PodcastContextPanel = contextModule.PodcastContextPanel as React.ComponentType<Record<string, unknown>>;

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
  sourceUrl: "https://example.com/podcast",
  audioUrl: "https://cdn.example.com/episode.mp3",
  audioDuration: "25:12",
  isSaved: false,
};

const controlsHtml = renderToStaticMarkup(React.createElement(PodcastControls, {
  item,
  isActive: true,
  status: "playing",
  currentTime: 42,
  duration: 1512,
  metadataReady: true,
  playbackRate: 1,
  error: null,
  onToggle: () => undefined,
  onSeek: () => undefined,
  onSkip: () => undefined,
  onRateChange: () => undefined,
  onContinuousPlayChange: () => undefined,
  onRetry: () => undefined,
}));
assert.match(controlsHtml, /aria-label="暂停真实播客"/);
assert.match(controlsHtml, /aria-label="快退 15 秒"/);
assert.match(controlsHtml, /aria-label="快进 15 秒"/);
assert.match(controlsHtml, /type="range"/);
assert.doesNotMatch(controlsHtml, /<audio/);

const pendingItem = {
  ...item,
  id: "article:12",
  kind: "article_pending",
  title: "待解读文章",
  audioUrl: undefined,
  audioDuration: undefined,
};
const pendingHtml = renderToStaticMarkup(React.createElement(PodcastControls, {
  item: pendingItem,
  isActive: false,
  status: "idle",
  currentTime: 0,
  duration: 0,
  metadataReady: false,
  playbackRate: 1,
  error: null,
  onToggle: () => undefined,
  onSeek: () => undefined,
  onSkip: () => undefined,
  onRateChange: () => undefined,
  onRetry: () => undefined,
}));
assert.match(pendingHtml, />生成解读</);
assert.match(pendingHtml, /音频生成尚未接入/);
assert.doesNotMatch(pendingHtml, /type="range"|0:00/);

const contextHtml = renderToStaticMarkup(React.createElement(PodcastContextPanel, {
  item,
  variant: "sidebar",
  open: true,
  onClose: () => undefined,
}));
assert.match(contextHtml, /基于 RSS 摘要/);
assert.match(contextHtml, /尚无 AI 章节与逐字稿/);

const css = readFileSync(path.join(root, "src/components/podcast/podcast.css"), "utf8");
const contextSource = readFileSync(path.join(root, "src/components/podcast/PodcastContextPanel.tsx"), "utf8");
assert.match(css, /var\(--theme-accent\)/);
assert.match(css, /prefers-reduced-motion/);
assert.match(css, /waveform-mask\.png/);
assert.match(css, /clip-path:\s*inset\(0 calc\(100% - var\(--podcast-progress\)\)/);
assert.match(css, /\.podcast-progress-range:focus-visible/);
assert.match(css, /\.podcast-control-link:focus-visible/);
assert.doesNotMatch(css, /#ff6b6b|#fb7185|#f97316|coral/i);
assert.doesNotMatch(contextSource, /<dialog[\s\S]*?onClose=\{onClose\}/);

await vite.close();
console.log("PASS: podcast components are accessible, themed, and content-honest");
