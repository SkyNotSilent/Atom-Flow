# AtomFlow Podcast Knowledge Feed Interface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a production-honest, themed “播客解读” workspace to AtomFlow that lets signed-in users vertically browse subscription and saved content, play real RSS audio through one audio element, and record short spoken thoughts into the existing knowledge base.

**Architecture:** Keep this delivery frontend-only. Map `Article` and `SavedArticle` into one pure preview model, keep browse selection separate from real audio playback state, render the selected C-direction immersive player plus a responsive source/knowledge panel, and integrate the page as a full-width authenticated app tab. Reuse the existing AppContext save, speech-recognition, theme, auth, and toast capabilities; do not add a server route, table, generation job, transcript, or TTS call.

**Tech Stack:** React 19, TypeScript 5.8 strict mode, Vite 6, Tailwind 4 theme classes, Lucide React (the project’s existing icon system), Node 22 built-in test runner, `tsx`, `react-dom/server`, and the existing Express/AppContext runtime.

## Global Constraints

- The approved product and visual specification is `docs/superpowers/specs/2026-07-17-podcast-knowledge-feed-design.md`.
- The selected visual source is `/var/folders/0r/_djw0jks3ys50q4khgvqb5440000gn/T/codex-clipboard-501d0bd6-d310-467b-92d2-5520a4858aee.png`; copy it into the repository before visual QA so the source truth is durable.
- Add “播客解读” immediately below “魔法写作” and require authentication for it.
- Treat both `write` and `podcast` as full-width workspaces; neither may render or expose the old center/right article splitter.
- Use `--theme-bg`, `--theme-surface`, `--theme-surface2`, `--theme-border`, `--theme-text-main`, `--theme-text2`, `--theme-text3`, `--theme-accent`, and `--theme-accent-light`. The only colored UI emphasis is `--theme-accent`; do not introduce the reference image’s coral accent.
- The local media stage may use the existing warm-dark neutrals `#1C1916`, `#2A2621`, `#38332D`, `#F7F5F0`, and `#A09890`.
- Use the existing Inter and Noto Serif SC font families. Metadata and controls use sans; the title and current insight may use serif.
- Use real `Article.audioUrl` and browser media events. Never create a fake URL, fake playback progress, fake transcript, fake chapter, fake quote, or fake AI-generated claim.
- A `SavedArticle.id` is not an `Article.id`; never pass it to `saveArticle(articleId)`.
- Non-`for_you` filters intentionally return honest capability-empty states until generated episode kinds exist in backend data.
- Keep exactly one `<audio preload="metadata">` mounted on the page. Browsing another card must not replace or stop the current audio; only an explicit play action may replace it.
- “说下我的想法” reuses the existing short speech-to-text flow and persists a manual “灵感” card through `addCard`; its copy must not imply long-form recording or retained source audio.
- Desktop two-column layout starts at `xl` (`1280px`). At `768–1279px`, keep one player column and use the source drawer. Below `768px`, use the existing nav drawer plus a mobile-first player and source drawer.
- Honor `prefers-reduced-motion`; record rotation and card transition must stop.
- Every `.ts` or `.tsx` task ends with `npx tsc --noEmit`. Every test file must be added to the explicit `package.json` test whitelist.
- No changes to `server.ts`, database schema, Railway configuration, or environment variables are in scope.

## Locked File Structure

| File | Responsibility |
|---|---|
| `src/types.ts` | Shared `AppTab` union only. |
| `src/utils/appTabs.ts` | Pure full-width and authenticated-tab rules. |
| `src/context/AppContext.tsx` | Honest article loading/error state, plus existing data/actions. |
| `src/components/podcast/podcastPreview.ts` | Article/saved-article mapping, date/filter behavior, and page-gate resolution. |
| `src/components/podcast/podcastPlayback.ts` | Pure playback reducer, duration parsing, seek clamping, and time formatting. |
| `src/components/podcast/PodcastCover.tsx` | Vinyl and dynamic/fallback cover assets. |
| `src/components/podcast/PodcastControls.tsx` | Presentational full/mini playback controls; it never renders an audio element. |
| `src/components/podcast/PodcastStage.tsx` | Immersive stage composition, title, metadata, cover, and controls slot. |
| `src/components/podcast/PodcastInsightPanel.tsx` | RSS-summary insight, source/save/generate actions, and short spoken-thought entry. |
| `src/components/podcast/PodcastContextPanel.tsx` | Desktop source panel and mobile native dialog body, with honest unavailable states. |
| `src/components/podcast/PodcastCardRail.tsx` | Explicit previous/next and card selection UI with `aria-current`. |
| `src/components/podcast/podcast.css` | Media-stage layout, image treatment, motion, drawer, and responsive rules. |
| `src/pages/PodcastPage.tsx` | AppContext adapter, filters, browse state, one real audio element, gesture routing, and responsive orchestration. |
| `src/App.tsx` | Lazy page route and full-width workspace integration. |
| `src/components/Nav.tsx` | Authenticated top-level navigation item. |
| `src/components/InspirationButton.tsx` | Optional label and correction of undefined theme utility classes. |

---

### Task 1: Honest Podcast Preview Data and Article Load State

**Files:**
- Create: `src/components/podcast/podcastPreview.ts`
- Create: `tests/podcast-preview.test.ts`
- Modify: `src/context/AppContext.tsx:8-31,95-118,147-181,758-766`
- Modify: `package.json:17`

**Interfaces:**
- Consumes: `Article`, `SavedArticle`, and `getDisplaySource(article: Article): string`.
- Produces: `PodcastFilter`, `PodcastDateRange`, `PodcastPreviewKind`, `PodcastPreviewOrigin`, `PodcastPreviewItem`, `PodcastPageGate`, `buildPodcastPreviewItems`, `filterPodcastItems`, and `resolvePodcastPageGate`.
- Adds to `AppState`: `isArticlesLoading: boolean` and `articlesError: string | null`.

- [ ] **Step 1: Write the failing preview-model test**

Create `tests/podcast-preview.test.ts` with fixtures that cover real audio, a normal pending article, a matched saved article, a saved-only article, filter honesty, and page gates:

```ts
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
```

- [ ] **Step 2: Add the test to the CI whitelist and verify the red state**

Append `tests/podcast-preview.test.ts` to the `test` script in `package.json`, then run:

```bash
node --import tsx --test tests/podcast-preview.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/components/podcast/podcastPreview.ts`.

- [ ] **Step 3: Implement the preview contract**

Create `src/components/podcast/podcastPreview.ts` with these exact exported types and rules:

```ts
import type { Article, SavedArticle } from "../../types";
import { getDisplaySource } from "../../utils/articleDisplay";

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

const textSummary = (value?: string) => {
  const text = normalize(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
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
    const audioUrl = normalize(article.audioUrl) || undefined;
    return {
      id: `article:${article.id}`,
      articleId: article.id,
      savedArticleId: saved?.id,
      origin: "subscription" as const,
      kind: audioUrl ? "native_episode" as const : "article_pending" as const,
      title: normalize(article.title) || "未命名内容",
      source: getDisplaySource(article),
      topic: normalize(article.topic) || "未分类",
      publishedAt: isoOrEmpty(article.publishedAt),
      publishedAtMs: timestampOf(article.publishedAt),
      timeLabel: normalize(article.time) || "时间未知",
      summary: textSummary(article.excerpt),
      contextBasis: "rss_summary" as const,
      imageUrl: article.sourceImages?.[0] || saved?.sourceImages?.[0] || article.sourceIcon,
      sourceUrl: normalize(article.url) || saved?.url,
      audioUrl,
      audioDuration: audioUrl ? normalize(article.audioDuration) || undefined : undefined,
      isSaved: article.saved || Boolean(saved),
    };
  });

  const savedOnlyItems = savedArticles
    .filter(saved => !consumedSavedIds.has(saved.id))
    .map(saved => {
      const publishedAtMs = timestampOf(saved.publishedAt ?? saved.savedAt);
      return {
        id: `saved:${saved.id}`,
        savedArticleId: saved.id,
        origin: "saved" as const,
        kind: "article_pending" as const,
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
```

- [ ] **Step 4: Add honest loading and error state to AppContext**

In `src/context/AppContext.tsx`, add the two fields to `AppState`, add provider state beside `articles`, replace `reloadArticles`, and include both values in the provider value:

Insert these two declarations immediately after the existing `articles: Article[]` declaration:

```ts
isArticlesLoading: boolean;
articlesError: string | null;
```

Add provider state immediately after the existing `articles` state:

```ts

const [articles, setArticles] = useState<Article[]>([]);
const [isArticlesLoading, setIsArticlesLoading] = useState(true);
const [articlesError, setArticlesError] = useState<string | null>(null);
```

Replace `reloadArticles` with:

```ts

const reloadArticles = async () => {
  setIsArticlesLoading(true);
  setArticlesError(null);
  try {
    const articlesRes = await fetch('/api/articles');
    if (!articlesRes.ok) {
      throw new Error(`文章加载失败 (${articlesRes.status})`);
    }
    const payload = await articlesRes.json() as Article[];
    setArticles(payload);
  } catch (error) {
    logger.error('Failed to reload articles', { error });
    setArticlesError(error instanceof Error ? error.message : '文章加载失败');
  } finally {
    setIsArticlesLoading(false);
  }
};
```

Insert these values immediately after the existing `articles,` entry in the `AppState` provider value:

```ts
isArticlesLoading,
articlesError,
```

In the outer initial `fetchData` catch, add both lines after `setIsAuthLoading(false)` so an authentication-network failure cannot leave the content spinner permanent:

```ts
setIsArticlesLoading(false);
setArticlesError(previous => previous ?? '内容加载失败');
```

Do not clear existing articles when a refresh fails; the podcast page will show a non-blocking warning if stale items remain.

- [ ] **Step 5: Run focused tests and type check**

```bash
node --import tsx --test tests/podcast-preview.test.ts
npx tsc --noEmit
```

Expected: the preview test prints its PASS line and TypeScript exits 0.

- [ ] **Step 6: Commit Task 1**

```bash
git add package.json src/context/AppContext.tsx src/components/podcast/podcastPreview.ts tests/podcast-preview.test.ts
git commit -m "feat: add honest podcast preview data"
```

---

### Task 2: Browse-Safe Playback State Machine

**Files:**
- Create: `src/components/podcast/podcastPlayback.ts`
- Create: `tests/podcast-playback-state.test.ts`
- Modify: `package.json:17`

**Interfaces:**
- Consumes: stable `PodcastPreviewItem.id` values from Task 1.
- Produces: `PODCAST_PLAYBACK_RATES`, `PodcastPlaybackStatus`, `PodcastPlaybackState`, `PodcastPlaybackAction`, `createPodcastPlaybackState`, `podcastPlaybackReducer`, `parseAudioDuration`, `clampPlaybackTime`, and `formatPlaybackTime`.

- [ ] **Step 1: Write the failing state-machine test**

Create `tests/podcast-playback-state.test.ts`:

```ts
import assert from "node:assert/strict";
import {
  clampPlaybackTime,
  createPodcastPlaybackState,
  formatPlaybackTime,
  parseAudioDuration,
  podcastPlaybackReducer,
} from "../src/components/podcast/podcastPlayback";

let state = createPodcastPlaybackState("article:11");
state = podcastPlaybackReducer(state, { type: "request_play", itemId: "article:11", initialDuration: 1512 });
assert.equal(state.activeItemId, "article:11");
assert.equal(state.status, "loading");

state = podcastPlaybackReducer(state, { type: "browse", itemId: "article:12" });
assert.equal(state.browseItemId, "article:12");
assert.equal(state.activeItemId, "article:11", "browsing must not replace current audio");

state = podcastPlaybackReducer(state, { type: "playing", itemId: "article:11" });
assert.equal(state.status, "playing");
state = podcastPlaybackReducer(state, { type: "time_update", itemId: "article:11", currentTime: 42 });
assert.equal(state.currentTime, 42);

const stale = podcastPlaybackReducer(state, { type: "error", itemId: "article:99", message: "stale" });
assert.deepEqual(stale, state, "events from a replaced source must be ignored");

state = podcastPlaybackReducer(state, { type: "set_rate", rate: 1.5 });
assert.equal(state.playbackRate, 1.5);
state = podcastPlaybackReducer(state, { type: "set_continuous_play", enabled: true });
assert.equal(state.continuousPlay, true);
state = podcastPlaybackReducer(state, { type: "error", itemId: "article:11", message: "无法播放" });
assert.equal(state.status, "error");
assert.equal(state.error, "无法播放");

assert.equal(parseAudioDuration("90"), 90);
assert.equal(parseAudioDuration("25:12"), 1512);
assert.equal(parseAudioDuration("1:02:03"), 3723);
assert.equal(parseAudioDuration("unknown"), null);
assert.equal(clampPlaybackTime(-5, 100), 0);
assert.equal(clampPlaybackTime(105, 100), 100);
assert.equal(formatPlaybackTime(3723), "1:02:03");

console.log("PASS: podcast browsing and real playback state remain independent");
```

- [ ] **Step 2: Add the test to `package.json` and verify failure**

```bash
node --import tsx --test tests/podcast-playback-state.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `podcastPlayback.ts`.

- [ ] **Step 3: Implement the reducer and playback utilities**

Create `src/components/podcast/podcastPlayback.ts`:

```ts
export const PODCAST_PLAYBACK_RATES = [1, 1.25, 1.5, 2] as const;
export type PodcastPlaybackRate = (typeof PODCAST_PLAYBACK_RATES)[number];
export type PodcastPlaybackStatus = "idle" | "loading" | "playing" | "paused" | "error";

export interface PodcastPlaybackState {
  browseItemId: string | null;
  activeItemId: string | null;
  status: PodcastPlaybackStatus;
  currentTime: number;
  duration: number;
  metadataReady: boolean;
  playbackRate: PodcastPlaybackRate;
  continuousPlay: boolean;
  error: string | null;
}

export type PodcastPlaybackAction =
  | { type: "browse"; itemId: string | null }
  | { type: "request_play"; itemId: string; initialDuration: number }
  | { type: "loaded_metadata"; itemId: string; duration: number }
  | { type: "playing"; itemId: string }
  | { type: "paused"; itemId: string }
  | { type: "time_update"; itemId: string; currentTime: number }
  | { type: "ended"; itemId: string }
  | { type: "error"; itemId: string; message: string }
  | { type: "set_rate"; rate: PodcastPlaybackRate }
  | { type: "set_continuous_play"; enabled: boolean }
  | { type: "reset_active" };

const finiteNonNegative = (value: number) => Number.isFinite(value) && value >= 0 ? value : 0;

export function createPodcastPlaybackState(browseItemId: string | null = null): PodcastPlaybackState {
  return {
    browseItemId,
    activeItemId: null,
    status: "idle",
    currentTime: 0,
    duration: 0,
    metadataReady: false,
    playbackRate: 1,
    continuousPlay: false,
    error: null,
  };
}

export function podcastPlaybackReducer(
  state: PodcastPlaybackState,
  action: PodcastPlaybackAction,
): PodcastPlaybackState {
  if (action.type === "browse") return { ...state, browseItemId: action.itemId };
  if (action.type === "set_rate") return { ...state, playbackRate: action.rate };
  if (action.type === "set_continuous_play") return { ...state, continuousPlay: action.enabled };
  if (action.type === "reset_active") {
    return {
      ...createPodcastPlaybackState(state.browseItemId),
      playbackRate: state.playbackRate,
      continuousPlay: state.continuousPlay,
    };
  }
  if (action.type === "request_play") {
    const sourceChanged = state.activeItemId !== action.itemId;
    return {
      ...state,
      activeItemId: action.itemId,
      status: "loading",
      currentTime: sourceChanged ? 0 : state.currentTime,
      duration: sourceChanged ? finiteNonNegative(action.initialDuration) : state.duration,
      metadataReady: sourceChanged ? false : state.metadataReady,
      error: null,
    };
  }
  if (state.activeItemId !== action.itemId) return state;
  switch (action.type) {
    case "loaded_metadata":
      return { ...state, duration: finiteNonNegative(action.duration), metadataReady: true, error: null };
    case "playing":
      return { ...state, status: "playing", error: null };
    case "paused":
      return state.status === "error" ? state : { ...state, status: "paused" };
    case "time_update":
      return { ...state, currentTime: clampPlaybackTime(action.currentTime, state.duration) };
    case "ended":
      return { ...state, status: "paused", currentTime: state.duration };
    case "error":
      return { ...state, status: "error", error: action.message };
    default:
      return state;
  }
}

export function parseAudioDuration(value?: string): number | null {
  if (!value?.trim()) return null;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return finiteNonNegative(Number(trimmed));
  const parts = trimmed.split(":").map(Number);
  if (parts.some(part => !Number.isFinite(part) || part < 0)) return null;
  if (parts.length === 2 && parts[1] < 60) return parts[0] * 60 + parts[1];
  if (parts.length === 3 && parts[1] < 60 && parts[2] < 60) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

export function clampPlaybackTime(value: number, duration: number): number {
  const safeDuration = finiteNonNegative(duration);
  return Math.min(safeDuration, Math.max(0, finiteNonNegative(value)));
}

export function formatPlaybackTime(value: number): string {
  const total = Math.floor(finiteNonNegative(value));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}
```

- [ ] **Step 4: Run focused tests and type check**

```bash
node --import tsx --test tests/podcast-playback-state.test.ts
npx tsc --noEmit
```

Expected: PASS and exit 0.

- [ ] **Step 5: Commit Task 2**

```bash
git add package.json src/components/podcast/podcastPlayback.ts tests/podcast-playback-state.test.ts
git commit -m "feat: add podcast playback state machine"
```

---

### Task 3: Themed Visual Assets and Presentational Components

**Files:**
- Create: `docs/superpowers/design-references/podcast-player-reference.png`
- Create: `public/assets/podcast/vinyl-record.png`
- Create: `public/assets/podcast/editorial-fallback-cover.png`
- Create: `public/assets/podcast/waveform-mask.png`
- Create: `src/components/podcast/PodcastCover.tsx`
- Create: `src/components/podcast/PodcastControls.tsx`
- Create: `src/components/podcast/PodcastStage.tsx`
- Create: `src/components/podcast/PodcastInsightPanel.tsx`
- Create: `src/components/podcast/PodcastContextPanel.tsx`
- Create: `src/components/podcast/PodcastCardRail.tsx`
- Create: `src/components/podcast/podcast.css`
- Create: `tests/podcast-interface.test.ts`
- Modify: `src/components/InspirationButton.tsx:6-15,115-220`
- Modify: `package.json:17`

**Interfaces:**
- Consumes: `PodcastPreviewItem` from Task 1 and playback types/utilities from Task 2.
- Produces: presentational components with no data fetching and no audio ownership. `PodcastControls` never renders `<audio>`.

- [ ] **Step 1: Preserve and inspect the visual source**

Create the destination directory, copy the exact selected reference, and verify dimensions:

```bash
mkdir -p docs/superpowers/design-references public/assets/podcast
cp /var/folders/0r/_djw0jks3ys50q4khgvqb5440000gn/T/codex-clipboard-501d0bd6-d310-467b-92d2-5520a4858aee.png docs/superpowers/design-references/podcast-player-reference.png
sips -g pixelWidth -g pixelHeight docs/superpowers/design-references/podcast-player-reference.png
```

Expected: the durable reference reports `616 × 948` pixels. Cataloged visible image assets are the black vinyl record, the editorial cover, and the waveform texture; the iPhone frame is reference chrome and must not appear in AtomFlow.

- [ ] **Step 2: Generate the two missing production assets with ImageGen**

Use the selected reference as visual grounding and make three separate image-generation calls. Save and inspect the returned images at the exact paths below.

Vinyl prompt for `public/assets/podcast/vinyl-record.png`:

```text
Create a square, photoreal top-down black vinyl record asset for a premium knowledge-audio player. Centered record, concentric physical grooves, subtle realistic specular highlights, warm near-black background matching #1C1916, restrained and editorial, no label text, no logo, no icon, no typography, no device frame. The circle must fit fully inside the square with generous safe edges. High resolution.
```

Fallback cover prompt for `public/assets/podcast/editorial-fallback-cover.png`:

```text
Create a portrait 4:5 editorial book-cover image for AtomFlow audio insights. Quiet architectural arches and a distant circular opening, warm ivory paper texture, deep AtomFlow blue accents close to #2B6CB0, thoughtful philosophy-journal mood, clean central composition, no words, no letters, no logo, no mockup frame. It must remain legible when cropped to a small podcast cover.
```

Waveform-mask prompt for `public/assets/podcast/waveform-mask.png`:

```text
Create a very wide 8:1 monochrome podcast waveform mask, evenly distributed varied vertical rounded bars, high visual density but calm rhythm, pure black background and pure white waveform only, no color, no gradient, no shadow, no text, no numbers, no icon, no logo. The left and right edges must finish cleanly so it can be used as a CSS luminance mask behind a real accessible progress slider.
```

Open all three outputs with the image viewer. Reject any output containing text, logos, a phone frame, clipped record edges, coral/purple branding, a non-monochrome waveform, or unreadable low-contrast cover geometry.

- [ ] **Step 3: Write the failing component contract test**

Create `tests/podcast-interface.test.ts` using Vite SSR and `react-dom/server`. The test must render a native item and a pending item and assert:

```ts
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

const contextHtml = renderToStaticMarkup(React.createElement(PodcastContextPanel, {
  item,
  variant: "sidebar",
  open: true,
  onClose: () => undefined,
}));
assert.match(contextHtml, /基于 RSS 摘要/);
assert.match(contextHtml, /尚无 AI 章节与逐字稿/);

const css = readFileSync(path.join(root, "src/components/podcast/podcast.css"), "utf8");
assert.match(css, /var\(--theme-accent\)/);
assert.match(css, /prefers-reduced-motion/);
assert.match(css, /waveform-mask\.png/);
assert.doesNotMatch(css, /#ff6b6b|#fb7185|#f97316|coral/i);

await vite.close();
console.log("PASS: podcast components are accessible, themed, and content-honest");
```

Add `tests/podcast-interface.test.ts` to the `package.json` test script and run it. Expected: FAIL because the components do not exist.

- [ ] **Step 4: Implement `PodcastCover` and the media-stage CSS**

`PodcastCover` has this complete prop contract and DOM structure:

```tsx
import type { PodcastPreviewItem } from "./podcastPreview";

interface PodcastCoverProps {
  item: PodcastPreviewItem;
  isPlaying: boolean;
}

export function PodcastCover({ item, isPlaying }: PodcastCoverProps) {
  const cover = item.imageUrl || "/assets/podcast/editorial-fallback-cover.png";
  return (
    <div className="podcast-cover-stack">
      <img
        className={`podcast-vinyl ${isPlaying ? "podcast-vinyl--playing" : ""}`}
        src="/assets/podcast/vinyl-record.png"
        alt=""
        aria-hidden="true"
      />
      <img className="podcast-cover-art" src={cover} alt={`${item.title} 封面`} />
    </div>
  );
}
```

In `podcast.css`, implement the image stack with a 1:1 record behind a 4:5 cover, use `object-fit: cover`, limit the stack to `min(52vw, 390px)` on desktop and `min(72vw, 280px)` on mobile, rotate only `.podcast-vinyl--playing` with `18s linear infinite`, and disable the animation under `@media (prefers-reduced-motion: reduce)`. Use `var(--theme-accent)` for selected/progress/focus rules and the allowed warm-dark neutral values for the stage.

For ready real audio only, use `/assets/podcast/waveform-mask.png` as a luminance mask twice: the base layer uses the stage’s muted text color and the foreground layer uses `var(--theme-accent)` with its width driven by the real `currentTime / duration` ratio. Place the accessible range input over the texture. Mark the raster texture `aria-hidden`; do not call it an audio-derived waveform in visible or accessible copy.

- [ ] **Step 5: Implement the control and stage components**

Use this exact `PodcastControls` interface:

```ts
interface PodcastControlsProps {
  item: PodcastPreviewItem;
  isActive: boolean;
  status: PodcastPlaybackStatus;
  currentTime: number;
  duration: number;
  metadataReady: boolean;
  playbackRate: PodcastPlaybackRate;
  error: string | null;
  compact?: boolean;
  onToggle: (item: PodcastPreviewItem) => void;
  onSeek: (seconds: number) => void;
  onSkip: (deltaSeconds: number) => void;
  onRateChange: (rate: PodcastPlaybackRate) => void;
  onRetry: () => void;
}
```

Render these states exactly:

- `item.kind === "article_pending"`: one primary button labeled `生成解读`, supporting copy `音频生成尚未接入`, and no slider or elapsed-time value.
- Native item not active: one primary button with `aria-label="播放{title}"`, the parsed RSS duration as metadata only, and no slider.
- Active loading item: disabled primary control with `aria-label="正在加载{title}"` and `role="status"` copy `正在加载音频`.
- Active ready item: buttons for previous 15 seconds, dynamic play/pause, next 15 seconds, and rate; show the slider only when `metadataReady && duration > 0`.
- Error: `role="alert"`, the exact error string, `重试播放`, and an `打开原节目` link when `sourceUrl` exists.
- `compact`: title, source, dynamic play/pause, and error status only; it still never renders `<audio>`.

Use `formatPlaybackTime` for elapsed/remaining text, `PODCAST_PLAYBACK_RATES` for rate cycling, real `<button>` elements, and a real `<input type="range">` with `aria-valuetext="{elapsed} / {duration}"`.

`PodcastStage` accepts the selected item, index, total, playing boolean, a `controls: React.ReactNode` slot, and previous/next/context callbacks. Its visible order is: source collection label → cover/vinyl → kind/time metadata → serif title → controls → explicit previous/next/context buttons. Use `aria-live="polite"` for `{title}，第 {index + 1} 条，共 {total} 条`.

The kind label is exactly `原生节目` for `native_episode` and `文章待解读` for `article_pending`. Do not use `AI 解读` until an actual generated-episode record exists.

- [ ] **Step 6: Implement insight, context, and card rail components**

Use these prop contracts:

```ts
interface PodcastInsightPanelProps {
  item: PodcastPreviewItem;
  saving: boolean;
  savingLabel: string | null;
  thoughtAction: React.ReactNode;
  onSave: () => void;
  onGenerate: () => void;
  onOpenContext: () => void;
}

interface PodcastContextPanelProps {
  item: PodcastPreviewItem;
  variant: "sidebar" | "dialog";
  open: boolean;
  onClose: () => void;
}

interface PodcastCardRailProps {
  items: PodcastPreviewItem[];
  activeId: string | null;
  onSelect: (itemId: string) => void;
  onPrevious: () => void;
  onNext: () => void;
}
```

`PodcastInsightPanel` must render `当前观点`, the real `summary`, and `基于 RSS 摘要`. It renders `打开原文` only when `sourceUrl` exists. If `isSaved`, render disabled `已在知识库`; otherwise render a save button only when `articleId` exists and show `savingLabel || "存入知识库"`. Render the supplied `thoughtAction` node in the action row; the presentational component must not call `useAppContext` itself.

Every external source link opens with `target="_blank"` and `rel="noreferrer noopener"` and includes the source/title in its accessible name.

`PodcastContextPanel` uses an `<aside>` for `sidebar` and a native `<dialog>` for `dialog`. It renders source, topic, time, real summary, `基于 RSS 摘要`, and the explicit empty statement `尚无 AI 章节与逐字稿`. The dialog calls `showModal()` when `open` becomes true, closes when false, handles native `cancel`, and restores focus to the invoker through normal dialog behavior.

`PodcastCardRail` renders one button per real item, exposes `aria-current="true"` on the selected button, labels every button `浏览：{title}`, and includes 44px previous/next controls. Do not render decorative fake cards.

- [ ] **Step 7: Make the existing short speech note entry theme-correct and labelable**

In `src/components/InspirationButton.tsx`, add `label?: string`, default it to `记录灵感`, and use it for the trigger title/text and panel heading. Replace every undefined theme utility with an existing token:

```tsx
interface InspirationButtonProps {
  articleTitle: string;
  articleId?: number;
  savedArticleId?: number;
  compact?: boolean;
  label?: string;
}
```

Replace the existing function parameter list with the exact destructuring sequence `articleTitle, articleId, savedArticleId, compact, label = "记录灵感"`. Preserve the current recording consent, transcript synchronization, and `addCard` body; then apply the theme-class replacements below to that body.

Apply these replacements: `text-text1` → `text-text-main`, `bg-background` → `bg-bg`, `focus:ring-primary` → `focus:ring-accent`, and `bg-primary`/`hover:bg-primary/90` → `bg-accent`/`hover:opacity-90`. Keep the existing disclosure that audio is streamed to the configured speech-recognition service and stops sending when recording ends.

- [ ] **Step 8: Run the component contract test and type check**

```bash
node --import tsx --test tests/podcast-interface.test.ts
npx tsc --noEmit
```

Expected: PASS and exit 0.

- [ ] **Step 9: Commit Task 3**

```bash
git add -f docs/superpowers/design-references/podcast-player-reference.png
git add public/assets/podcast src/components/InspirationButton.tsx src/components/podcast tests/podcast-interface.test.ts package.json
git commit -m "feat: build themed podcast player components"
```

---

### Task 4: Page Orchestration, One Real Audio Element, and Responsive Browsing

**Files:**
- Create: `src/pages/PodcastPage.tsx`
- Create: `tests/podcast-page.test.ts`
- Modify: `package.json:17`

**Interfaces:**
- Consumes from `useAppContext`: `articles`, `savedArticles`, `isArticlesLoading`, `articlesError`, `reloadArticles`, `user`, `isAuthLoading`, `setShowLoginModal`, `saveArticle`, `isSavingArticle`, `getSavingStageText`, and `showToast`.
- Produces: `PodcastPage({ onBack, onDiscover })` and exported `PodcastPageContent` for SSR contract testing.

- [ ] **Step 1: Write the failing page contract test**

Create `tests/podcast-page.test.ts` with Vite SSR. Render `PodcastPageContent` with one native item and one pending item. Define the fixtures and assert:

```ts
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import type { PodcastPreviewItem } from "../src/components/podcast/podcastPreview";
import { createPodcastPlaybackState } from "../src/components/podcast/podcastPlayback";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testDir, "..");
const vite = await createServer({ root, appType: "custom", server: { middlewareMode: true } });
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
assert.match(pageHtml, /为你生成/);
assert.match(pageHtml, /短知识卡/);
assert.match(pageHtml, /主题速听/);
assert.match(pageHtml, /深度播客/);
assert.match(pageHtml, /连续播放/);
assert.match(pageHtml, /基于 RSS 摘要/);
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

await vite.close();
console.log("PASS: podcast page mounts one audio element and exposes honest states");
```

Add the test to `package.json` and verify it fails because `PodcastPage.tsx` does not exist.

- [ ] **Step 2: Implement the AppContext adapter and pure page-content boundary**

Create these exported props in `src/pages/PodcastPage.tsx`:

```ts
export interface PodcastPageProps {
  onBack: () => void;
  onDiscover: () => void;
}

export interface PodcastPageContentProps {
  items: PodcastPreviewItem[];
  filteredItems: PodcastPreviewItem[];
  filter: PodcastFilter;
  range: PodcastDateRange;
  gate: PodcastPageGate;
  articlesError: string | null;
  playback: PodcastPlaybackState;
  savingArticleIds: number[];
  getSavingLabel: (articleId: number) => string | null;
  onFilterChange: (filter: PodcastFilter) => void;
  onRangeChange: (range: PodcastDateRange) => void;
  onBrowse: (itemId: string) => void;
  onPrevious: () => void;
  onNext: () => void;
  onToggle: (item: PodcastPreviewItem) => void;
  onSeek: (seconds: number) => void;
  onSkip: (deltaSeconds: number) => void;
  onRateChange: (rate: PodcastPlaybackRate) => void;
  onContinuousPlayChange: (enabled: boolean) => void;
  onRetry: () => void;
  onSave: (item: PodcastPreviewItem) => void;
  onGenerate: (item: PodcastPreviewItem) => void;
  onReload: () => void;
  onLogin: () => void;
  onBack: () => void;
  onDiscover: () => void;
  renderThoughtAction: (item: PodcastPreviewItem) => React.ReactNode;
  audioElement?: React.ReactNode;
}
```

Import `../components/podcast/podcast.css` once at the top of `PodcastPage.tsx`; no child component should import it again.

`PodcastPage` builds items with `buildPodcastPreviewItems`, filters them with `filterPodcastItems`, resolves the page gate, owns `filter`, `range`, reducer state, and context-drawer state, then passes one `audioElement` into `PodcastPageContent`. It also passes this exact knowledge-linked thought renderer:

```tsx
renderThoughtAction={item => (
  <InspirationButton
    label="说下我的想法"
    articleTitle={item.title}
    articleId={item.articleId}
    savedArticleId={item.savedArticleId}
  />
)}
```

`PodcastPageContent` must remain fetch-free and AppContext-free so the SSR test is deterministic; it passes `renderThoughtAction(browseItem)` into `PodcastInsightPanel.thoughtAction`.

- [ ] **Step 3: Implement the single audio controller**

Mount exactly this one media element from `PodcastPage`; do not mount audio in any child:

```tsx
<audio
  ref={audioRef}
  hidden
  preload="metadata"
  src={activeItem?.audioUrl}
  onLoadStart={() => activeItem && dispatch({ type: "request_play", itemId: activeItem.id, initialDuration: parseAudioDuration(activeItem.audioDuration) ?? 0 })}
  onLoadedMetadata={event => {
    if (!activeItem) return;
    const mediaDuration = event.currentTarget.duration;
    dispatch({
      type: "loaded_metadata",
      itemId: activeItem.id,
      duration: Number.isFinite(mediaDuration) ? mediaDuration : parseAudioDuration(activeItem.audioDuration) ?? 0,
    });
  }}
  onPlaying={() => activeItem && dispatch({ type: "playing", itemId: activeItem.id })}
  onPause={() => activeItem && dispatch({ type: "paused", itemId: activeItem.id })}
  onTimeUpdate={event => activeItem && dispatch({ type: "time_update", itemId: activeItem.id, currentTime: event.currentTarget.currentTime })}
  onEnded={() => {
    if (!activeItem) return;
    dispatch({ type: "ended", itemId: activeItem.id });
    if (playback.continuousPlay) playNextNativeAfter(activeItem.id);
  }}
  onError={() => activeItem && dispatch({ type: "error", itemId: activeItem.id, message: "该音频暂时无法播放，请重试或打开原节目。" })}
/>
```

Use a `pendingAutoplayItemIdRef` to distinguish an explicit user play from passive rendering. When a new real item is clicked, set the ref, dispatch `request_play`, and let an effect keyed by `activeItem?.audioUrl` call `audio.load()` and `audio.play()`. Clear the ref before calling play. On a same-item toggle, call `pause()` when playing or `play()` when paused/error. Convert rejected `play()` promises into the same reducer `error` action. Never call `play()` during initial render or during browse/filter changes.

Render a `连续播放` button with `aria-pressed={playback.continuousPlay}` and default it to off. `playNextNativeAfter` searches cyclically after the active item for the next `filteredItems` entry with a real `audioUrl`; when found, it browses that item and uses the same explicit-autoplay pipeline. It runs only from `onEnded` after the user has enabled the switch. If no other playable item exists, leave the ended item paused.

Implement that search with this exact loop:

```ts
const playNextNativeAfter = (currentItemId: string) => {
  const currentIndex = filteredItems.findIndex(item => item.id === currentItemId);
  if (currentIndex < 0 || filteredItems.length < 2) return;
  for (let offset = 1; offset < filteredItems.length; offset += 1) {
    const candidate = filteredItems[(currentIndex + offset) % filteredItems.length];
    if (!candidate.audioUrl) continue;
    pendingAutoplayItemIdRef.current = candidate.id;
    dispatch({ type: "browse", itemId: candidate.id });
    dispatch({
      type: "request_play",
      itemId: candidate.id,
      initialDuration: parseAudioDuration(candidate.audioDuration) ?? 0,
    });
    return;
  }
};
```

`onSeek` writes `audio.currentTime = clampPlaybackTime(seconds, playback.duration)`. `onSkip` adds `±15`. `onRateChange` writes both `audio.playbackRate` and reducer state. `onRetry` is user-triggered and calls `load()` then `play()`.

- [ ] **Step 4: Implement filtering, card navigation, and action honesty**

Define the visible filter labels exactly:

```ts
const FILTERS: Array<{ id: PodcastFilter; label: string }> = [
  { id: "for_you", label: "为你生成" },
  { id: "short", label: "短知识卡" },
  { id: "quick", label: "主题速听" },
  { id: "deep", label: "深度播客" },
];
```

Render every filter as a real button with `aria-pressed={filter === option.id}`. The selected label and `aria-pressed` state must remain understandable without color.

When a generated filter is empty, show `这一层还没有已生成内容` plus `回到为你生成`; do not insert demo data. When the `for_you` today range is empty, show `今天还没有可收听内容` plus buttons `查看过去 3 天` and `前往发现订阅源`.

If `articlesError` is non-null while `filteredItems` still contains cached data, keep the content visible and show a compact warning `部分内容刷新失败，正在显示上次结果` with a `重新加载` button. Reserve the full `内容加载失败` screen for zero-item error state.

Previous/next wraps within `filteredItems`. Wheel navigation only runs inside the card-stage region, requires an accumulated vertical delta of 72px, locks for 400ms after one switch, and ignores events originating from `button`, `a`, `input`, `select`, `textarea`, `[role="dialog"]`, or `[data-podcast-interactive]`. ArrowUp/ArrowDown uses the same navigation rule and ignores form/editable focus. Explicit previous/next buttons remain available at all viewports.

Add a dedicated `[data-podcast-swipe-zone]` around the cover/title area, with `touch-action: pan-x` so vertical gestures belong to card navigation while controls, insight content, and the drawer remain normal interactive/scrollable regions. Use pointer capture and this threshold rule:

```ts
const isInteractiveTarget = (target: EventTarget | null) =>
  target instanceof Element && Boolean(target.closest(
    'button, a, input, select, textarea, [contenteditable="true"], [role="dialog"], [data-podcast-interactive]',
  ));

const swipeStartRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);

const handleSwipeStart = (event: React.PointerEvent<HTMLElement>) => {
  if (event.pointerType !== "touch" || isInteractiveTarget(event.target)) return;
  swipeStartRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  event.currentTarget.setPointerCapture(event.pointerId);
};

const handleSwipeEnd = (event: React.PointerEvent<HTMLElement>) => {
  const start = swipeStartRef.current;
  swipeStartRef.current = null;
  if (!start || start.pointerId !== event.pointerId) return;
  const deltaX = event.clientX - start.x;
  const deltaY = event.clientY - start.y;
  if (Math.abs(deltaY) < 64 || Math.abs(deltaY) <= Math.abs(deltaX) * 1.25) return;
  if (deltaY < 0) onNext();
  else onPrevious();
};
```

Handle `pointercancel` by clearing `swipeStartRef`. Dragging the progress slider, scrolling the source dialog, or pressing any button must never reach these handlers.

For a pending item, `onGenerate` calls `showToast("音频生成尚未接入；当前先展示真实来源摘要。")`. For save, call `saveArticle(item.articleId)` only when `articleId` exists and `isSaved` is false. Do nothing for saved-only records because they are already in the knowledge base.

- [ ] **Step 5: Implement the C-direction responsive composition**

`PodcastPageContent` renders:

```text
page header: back, “播客解读”, item/range status, filter tabs
main grid:
  left: card rail + immersive stage + current insight
  right at >=1280: persistent source/context panel
mobile/tablet: “查看来源与文字” opens the native dialog panel
conditional mini controls: visible when active audio item differs from browse item
```

Use `grid-template-columns: minmax(0, 1.85fr) minmax(320px, 1fr)` at `xl`. The left area owns vertical overflow. The drawer uses `max-height: 78dvh`, a rounded top border, and `padding-bottom: max(1rem, env(safe-area-inset-bottom))`. On mobile the cover max is 280px, all primary touch targets are at least 44px, and there is no horizontal overflow.

The stage spins only when `playback.activeItemId === browseItem.id && playback.status === "playing"`. If another item is playing, render `PodcastControls` in `compact` mode for the active item; do not spin the browse item.

- [ ] **Step 6: Run the page test and type check**

```bash
node --import tsx --test tests/podcast-page.test.ts
npx tsc --noEmit
```

Expected: PASS, one audio element in SSR output, and exit 0.

- [ ] **Step 7: Commit Task 4**

```bash
git add src/pages/PodcastPage.tsx tests/podcast-page.test.ts package.json
git commit -m "feat: orchestrate podcast knowledge feed"
```

---

### Task 5: Authenticated Navigation and Full-Width App Integration

**Files:**
- Create: `src/utils/appTabs.ts`
- Create: `tests/podcast-navigation.test.ts`
- Modify: `src/types.ts:1`
- Modify: `src/App.tsx:7-14,49-56,75-150,165-245`
- Modify: `src/components/Nav.tsx:1-18,379-389,1001-1009`
- Modify: `package.json:17`

**Interfaces:**
- Consumes: `PodcastPage({ onBack, onDiscover })` from Task 4.
- Produces: shared `AppTab`, `isFullWidthAppTab(tab)`, and `requiresAuthenticatedAppTab(tab)` used by both App and Nav.

- [ ] **Step 1: Write the failing app-tab and navigation test**

Create `tests/podcast-navigation.test.ts`:

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isFullWidthAppTab, requiresAuthenticatedAppTab } from "../src/utils/appTabs";

assert.equal(isFullWidthAppTab("write"), true);
assert.equal(isFullWidthAppTab("podcast"), true);
assert.equal(isFullWidthAppTab("feed"), false);
assert.equal(requiresAuthenticatedAppTab("knowledge"), true);
assert.equal(requiresAuthenticatedAppTab("write"), true);
assert.equal(requiresAuthenticatedAppTab("podcast"), true);
assert.equal(requiresAuthenticatedAppTab("discover"), false);

const testDir = path.dirname(fileURLToPath(import.meta.url));
const navSource = readFileSync(path.join(testDir, "../src/components/Nav.tsx"), "utf8");
const appSource = readFileSync(path.join(testDir, "../src/App.tsx"), "utf8");
assert.ok(navSource.indexOf("魔法写作") < navSource.indexOf("播客解读"));
assert.match(appSource, /activeTab === ["']podcast["']/);
assert.match(appSource, /!isFullWidthTab\s*&&/);

console.log("PASS: podcast is an authenticated full-width app workspace");
```

Add it to `package.json` and run it. Expected: FAIL because `src/utils/appTabs.ts` does not exist.

- [ ] **Step 2: Add the shared app-tab rules**

Add to `src/types.ts`:

```ts
export type AppTab = "feed" | "discover" | "knowledge" | "write" | "podcast";
```

Create `src/utils/appTabs.ts`:

```ts
import type { AppTab } from "../types";

export const isFullWidthAppTab = (tab: AppTab) => tab === "write" || tab === "podcast";

export const requiresAuthenticatedAppTab = (tab: AppTab) =>
  tab === "knowledge" || tab === "write" || tab === "podcast";
```

- [ ] **Step 3: Integrate PodcastPage without the old reader pane or phantom divider**

In `src/App.tsx`, lazy-load `PodcastPage`, type state as `AppTab`, and derive:

```tsx
const PodcastPage = React.lazy(() => import("./pages/PodcastPage").then(module => ({ default: module.PodcastPage })));
const [activeTab, setActiveTab] = useState<AppTab>("feed");
const isWriteTab = activeTab === "write";
const isPodcastTab = activeTab === "podcast";
const isFullWidthTab = isFullWidthAppTab(activeTab);
```

Apply these exact layout rules:

- The center/right hover cursor and `onMouseDownCapture` return immediately when `isFullWidthTab`.
- Add `useEffect(() => { if (isFullWidthTab) { setDragging(null); setHoverCenterRightEdge(false); } }, [isFullWidthTab]);` so switching tabs cannot leave a stale resize cursor or drag session.
- The center container uses `flex-1` and no fixed `centerWidth` when `isFullWidthTab`.
- The mobile hide condition is `!isFullWidthTab && readingArticle`.
- Hide the generic mobile AtomFlow header for `isPodcastTab`; PodcastPage owns its screen header.
- Render PodcastPage inside the same Suspense fallback pattern as WritePage, without the write page’s outer `p-4`.
- Change the ReaderPane conditional guard from `!isWriteTab` to `!isFullWidthTab`; preserve both current reader and empty-reader branches inside that guard.

Use this route body:

```tsx
{activeTab === "podcast" && (
  <React.Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-text3">加载播客解读...</div>}>
    <PodcastPage
      onBack={() => setActiveTab("feed")}
      onDiscover={() => setActiveTab("discover")}
    />
  </React.Suspense>
)}
```

- [ ] **Step 4: Add the authenticated navigation item below Magic Writing**

In `src/components/Nav.tsx`, import `AppTab`, `requiresAuthenticatedAppTab`, and `Headphones`. Change `NavProps` and `handleTabClick` to use `AppTab`. Replace the login guard with:

```ts
const handleTabClick = (tab: AppTab) => {
  if (requiresAuthenticatedAppTab(tab) && !user) {
    loginAndDo(() => setActiveTab(tab));
    return;
  }
  setActiveTab(tab);
  if (tab === "feed") setActiveSource(null);
};
```

Insert immediately after the “魔法写作” button:

```tsx
<TabButton active={activeTab === "podcast"} onClick={() => handleTabClick("podcast")} fullWidth>
  <Headphones size={14} className="inline mr-1" />
  播客解读
</TabButton>
```

Do not add podcast-specific subscription controls to the left nav; all podcast filters belong inside PodcastPage.

- [ ] **Step 5: Run navigation, focused feature, and type checks**

```bash
node --import tsx --test tests/podcast-navigation.test.ts tests/podcast-preview.test.ts tests/podcast-playback-state.test.ts tests/podcast-interface.test.ts tests/podcast-page.test.ts
npx tsc --noEmit
```

Expected: all five tests pass and TypeScript exits 0.

- [ ] **Step 6: Commit Task 5**

```bash
git add src/types.ts src/utils/appTabs.ts src/App.tsx src/components/Nav.tsx tests/podcast-navigation.test.ts package.json
git commit -m "feat: add podcast workspace navigation"
```

---

### Task 6: Browser Design QA, Accessibility, Reviews, and Final Verification

**Files:**
- Create: `design-qa.md`
- Create: `artifacts/design-qa/podcast-mobile-light.png`
- Create: `artifacts/design-qa/podcast-desktop-light.png`
- Create: `artifacts/design-qa/podcast-desktop-dark.png`
- Modify only files required by verified P0/P1/P2 QA, quality-gate, or code-review findings.

**Interfaces:**
- Consumes: completed Tasks 1–5 and the durable reference image.
- Produces: browser-verified interface, passing `design-qa.md`, and a clean full-project quality gate.

- [ ] **Step 1: Run repository-level static verification**

```bash
npx tsc --noEmit
npm run lint
npm test
npm run build
git diff --check
```

Expected: every command exits 0. `npm test` must visibly include all five podcast tests.

- [ ] **Step 2: Start the real AtomFlow app on the fixed local port**

Run `npm run dev`. If port 1000 is occupied, first identify the listener and verify whether it is an old AtomFlow Node process; stop only that exact stale process, then rerun. Do not change `.env`, `package.json`, Vite config, or the port.

Use the Product Design browser rule: open the Codex in-app browser at `http://localhost:1000`, not a separate browser profile. Sign in with the existing local test session or uncommitted `TEST_EMAIL`/`TEST_PASSWORD`; never print credentials in command output or store them in the repository.

- [ ] **Step 3: Exercise the core interaction matrix in the browser**

Verify and capture:

1. `1440×900`, light theme: two-column 65/35 layout, real source panel, filters, rail, stage, insight, and no old ReaderPane.
2. `1440×900`, dark theme: warm stage remains distinct from theme surface; all colored state uses AtomFlow accent.
3. `1280×800`: minimum persistent two-column layout without clipped controls.
4. `1024×768`: one stage column plus functional native source dialog.
5. `390×844` and `430×932`: nav drawer, 280px-or-smaller cover, safe-area drawer, no horizontal scroll, and 44px controls.
6. Reduced motion: vinyl is static and card transitions have no movement.
7. Keyboard: filter → rail → play → skip → progress → rate → source/save/thought → source dialog; Escape closes the dialog.
8. Native RSS item: a user click loads and plays, slider follows real media events, skip/seek/rate work, and only one audio element exists.
9. Browse a pending item while native audio plays: audio continues and compact controls identify the playing source.
10. Pending, generated-filter empty, initial loading, true empty, refresh error, and media error states use the exact honest copy from prior tasks.
11. “说下我的想法”: mic consent remains visible, transcript is editable, and saving creates a manual “灵感” knowledge card linked with the available article/saved-article IDs.

Check the browser console after each primary route. There must be no uncaught error, missing key warning, invalid DOM nesting warning, failed local asset load, or accessibility name omission.

- [ ] **Step 4: Run blocking visual comparison and write `design-qa.md`**

Open `docs/superpowers/design-references/podcast-player-reference.png` and each implementation capture in the same comparison input. Compare mobile reference/player composition first, then desktop C-direction adaptation. Explicitly evaluate fonts, spacing/layout rhythm, theme colors, image fidelity/crop, icon fidelity, and copy.

Write `design-qa.md` with these exact facts at the top: source visual truth path `docs/superpowers/design-references/podcast-player-reference.png`, implementation screenshot path `artifacts/design-qa/podcast-mobile-light.png`, viewport `390 × 844`, and state `signed-in, native episode selected, metadata loaded, paused`. Then add complete sections for full-view evidence, focused cover/vinyl/title/control evidence, severity-ordered findings with location/evidence/impact/fix, and comparison history with each blocking finding, applied change, and recaptured evidence. End the file with:

```md
final result: passed
```

The final line must be exactly `final result: passed`. If any P0/P1/P2 remains, keep it `final result: blocked`, apply the concrete fix, recapture the same viewport/state, and compare again. P3 polish may remain documented.

- [ ] **Step 5: Run the required autonomous reviews**

Dispatch the repository’s `quality-gate` sub-agent against all Task 1–5 changes and a separate `code-reviewer` sub-agent for correctness, accessibility, playback races, and regression risk. A DB review is not required because this plan never modifies `server.ts` schema/query code. Fix every Critical/Important/P0/P1/P2 finding directly, then rerun the focused test that covers the fix and `npx tsc --noEmit`.

- [ ] **Step 6: Re-run the final gate after all fixes**

```bash
npx tsc --noEmit
npm run lint
npm test
npm run build
git diff --check
```

Expected: all commands exit 0, `design-qa.md` says `final result: passed`, and the local browser still shows the working podcast workspace at `http://localhost:1000`.

- [ ] **Step 7: Commit the verified polish**

```bash
git add design-qa.md artifacts/design-qa src public tests package.json docs/superpowers/design-references
git commit -m "fix: polish podcast workspace experience"
```

Do not stage unrelated user changes if the worktree becomes dirty during execution.
