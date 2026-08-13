import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AlertTriangle, ArrowLeft, CalendarDays, Headphones, RefreshCw } from "lucide-react";
import { InspirationButton } from "../components/InspirationButton";
import { PodcastControls } from "../components/podcast/PodcastControls";
import { PodcastInsightPanel } from "../components/podcast/PodcastInsightPanel";
import {
  usePodcastFullPlayerPresence,
  usePodcastPlayback,
} from "../components/podcast/PodcastPlaybackProvider";
import { PodcastStage } from "../components/podcast/PodcastStage";
import {
  type PodcastPlaybackRate,
  type PodcastPlaybackState,
} from "../components/podcast/podcastPlayback";
import {
  buildPodcastPreviewItems,
  filterPodcastItems,
  resolvePodcastPageGate,
  type PodcastDateRange,
  type PodcastPageGate,
  type PodcastPreviewItem,
} from "../components/podcast/podcastPreview";
import "../components/podcast/podcast.css";
import { useAppContext } from "../context/AppContext";
import type { Article, SavedArticle } from "../types";
import { findArticleByIdentity } from "../utils/articleIdentity";

// Compatibility export for source-scoped media tests and downstream consumers.
export { PodcastAudioElement } from "../components/podcast/PodcastPlaybackProvider";

export interface PodcastPageProps {
  onBack: () => void;
  onDiscover: () => void;
  onAddToCanvas?: (item: PodcastPreviewItem) => void;
}

export interface PodcastPageContentProps {
  items: PodcastPreviewItem[];
  filteredItems: PodcastPreviewItem[];
  range: PodcastDateRange;
  gate: PodcastPageGate;
  articlesError: string | null;
  playback: PodcastPlaybackState;
  activeItem?: PodcastPreviewItem;
  savingArticleIds: number[];
  getSavingLabel: (articleId: number) => string | null;
  onRangeChange: (range: PodcastDateRange) => void;
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
  onAddToCanvas?: (item: PodcastPreviewItem) => void;
  renderThoughtAction: (item: PodcastPreviewItem) => React.ReactNode;
}

export function resolvePodcastSourceArticle(
  item: PodcastPreviewItem | undefined,
  articles: Article[],
  savedArticles: SavedArticle[],
): Article | null {
  if (!item) return null;
  const article = findArticleByIdentity(articles, {
    id: item.articleId,
    url: item.sourceUrl,
    source: item.source,
    title: item.title,
  });
  if (article) return article;

  const saved = item.savedArticleId === undefined
    ? savedArticles.find(candidate => candidate.url && candidate.url === item.sourceUrl)
    : savedArticles.find(candidate => candidate.id === item.savedArticleId);
  if (!saved) return null;

  return {
    id: -saved.id,
    saved: true,
    source: saved.source,
    sourceIcon: saved.sourceIcon,
    topic: saved.topic,
    time: saved.savedAt,
    publishedAt: saved.publishedAt,
    title: saved.title,
    excerpt: saved.excerpt,
    citationContext: saved.citationContext,
    sourceImages: saved.sourceImages,
    content: saved.content ?? "",
    url: saved.url,
    audioUrl: saved.audioUrl,
    audioDuration: saved.audioDuration,
    fullFetched: saved.content !== undefined,
    cards: [],
  };
}

const isInteractiveTarget = (target: EventTarget | null) =>
  target instanceof Element && Boolean(target.closest(
    'button, a, input, select, textarea, [contenteditable="true"], [role="dialog"], [data-podcast-interactive]',
  ));

const isStageControlTarget = (target: EventTarget | null) =>
  target instanceof Element && Boolean(target.closest(
    ".podcast-stage-controls, .podcast-stage-actions",
  ));

const isSwipeContentTarget = (target: EventTarget | null) =>
  target instanceof Element && Boolean(target.closest(
    ".podcast-cover-stack, .podcast-stage-source, .podcast-stage-meta, .podcast-stage-title",
  ));

interface PageStateProps {
  title: string;
  detail: string;
  children?: React.ReactNode;
}

function PageState({ title, detail, children }: PageStateProps) {
  return (
    <section
      className="mx-auto grid min-h-[360px] w-full max-w-2xl place-items-center rounded-3xl border border-border bg-surface px-6 py-12 text-center shadow-sm"
      aria-live="polite"
    >
      <div className="grid justify-items-center gap-4">
        <Headphones aria-hidden="true" className="text-accent" size={32} />
        <div>
          <h2 className="font-serif text-2xl font-semibold text-text-main">{title}</h2>
          <p className="mt-2 text-sm leading-6 text-text2">{detail}</p>
        </div>
        {children && <div className="flex flex-wrap justify-center gap-3">{children}</div>}
      </div>
    </section>
  );
}

export function PodcastPageContent({
  items,
  filteredItems,
  range,
  gate,
  articlesError,
  playback,
  activeItem: providedActiveItem,
  savingArticleIds,
  getSavingLabel,
  onRangeChange,
  onPrevious,
  onNext,
  onToggle,
  onSeek,
  onSkip,
  onRateChange,
  onContinuousPlayChange,
  onRetry,
  onSave,
  onGenerate,
  onReload,
  onLogin,
  onBack,
  onDiscover,
  onAddToCanvas,
  renderThoughtAction,
}: PodcastPageContentProps) {
  const wheelDeltaRef = useRef(0);
  const wheelLockedUntilRef = useRef(0);
  const swipeStartRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);

  const browseItem = filteredItems.find(item => item.id === playback.browseItemId)
    ?? filteredItems[0];
  const activeItem = providedActiveItem
    ?? items.find(item => item.id === playback.activeItemId);
  const browseIndex = browseItem
    ? Math.max(0, filteredItems.findIndex(item => item.id === browseItem.id))
    : 0;

  const handleWheel = (event: React.WheelEvent<HTMLElement>) => {
    if (isInteractiveTarget(event.target) || isStageControlTarget(event.target)) return;
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    const now = Date.now();
    if (now < wheelLockedUntilRef.current) {
      wheelDeltaRef.current = 0;
      return;
    }
    wheelDeltaRef.current += event.deltaY;
    if (Math.abs(wheelDeltaRef.current) < 72) return;
    event.preventDefault();
    if (wheelDeltaRef.current > 0) onNext();
    else onPrevious();
    wheelDeltaRef.current = 0;
    wheelLockedUntilRef.current = now + 400;
  };

  const handleStageKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (isInteractiveTarget(event.target) || isStageControlTarget(event.target)) return;
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    if (event.key === "ArrowDown") onNext();
    else onPrevious();
  };

  const handleSwipeStart = (event: React.PointerEvent<HTMLElement>) => {
    if (
      event.pointerType !== "touch"
      || isInteractiveTarget(event.target)
      || !isSwipeContentTarget(event.target)
    ) return;
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

  const rangeLabel = range === "today" ? "今天" : "过去 3 天";
  const stateButtonClass = "min-h-11 rounded-full border border-border bg-surface px-5 text-sm font-semibold text-text-main transition-colors hover:border-accent hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
  const stageControlsVisible = gate === "ready" && Boolean(browseItem);
  const compactActiveControls = activeItem?.audioUrl
    && (!stageControlsVisible || activeItem.id !== browseItem?.id) ? (
    <section
      className="sticky bottom-3 z-20 rounded-2xl border border-border bg-surface p-3 shadow-lg"
      aria-label="正在播放的节目"
      data-podcast-interactive
    >
      <PodcastControls
        item={activeItem}
        compact
        isActive
        status={playback.status}
        currentTime={playback.currentTime}
        duration={playback.duration}
        metadataReady={playback.metadataReady}
        playbackRate={playback.playbackRate}
        error={playback.error}
        onToggle={onToggle}
        onSeek={onSeek}
        onSkip={onSkip}
        onRateChange={onRateChange}
        onRetry={onRetry}
      />
    </section>
  ) : null;

  let content: React.ReactNode;
  if (gate === "auth_loading") {
    content = <PageState title="正在确认登录状态" detail="请稍候，正在准备你的播客知识流。" />;
  } else if (gate === "signed_out") {
    content = (
      <PageState title="登录后生成你的播客知识流" detail="从你的订阅与知识库中整理真实来源内容。">
        <button type="button" className={stateButtonClass} onClick={onLogin}>登录</button>
      </PageState>
    );
  } else if (gate === "loading") {
    content = <PageState title="正在整理今天的可收听内容" detail="正在读取订阅源与知识库摘要。" />;
  } else if (gate === "error") {
    content = (
      <PageState title="内容加载失败" detail="暂时无法读取订阅内容，请稍后重试。">
        <button type="button" className={stateButtonClass} onClick={onReload}>重新加载</button>
      </PageState>
    );
  } else if (gate === "empty" || !browseItem) {
    content = (
      <PageState
        title={range === "today" ? "今天还没有可收听内容" : "过去 3 天还没有可收听内容"}
        detail="可以扩展时间范围，或去发现页添加订阅源。"
      >
        {range === "today" && (
          <button type="button" className={stateButtonClass} onClick={() => onRangeChange("three_days")}>查看过去 3 天</button>
        )}
        <button type="button" className={stateButtonClass} onClick={onDiscover}>前往发现订阅源</button>
      </PageState>
    );
  } else {
    const browseIsActive = playback.activeItemId === browseItem.id;
    const saving = browseItem.articleId !== undefined && savingArticleIds.includes(browseItem.articleId);
    const savingLabel = browseItem.articleId === undefined ? null : getSavingLabel(browseItem.articleId);
    const controls = (
      <PodcastControls
        item={browseItem}
        isActive={browseIsActive}
        status={playback.status}
        currentTime={playback.currentTime}
        duration={playback.duration}
        metadataReady={playback.metadataReady}
        playbackRate={playback.playbackRate}
        error={playback.error}
        onToggle={onToggle}
        onSeek={onSeek}
        onSkip={onSkip}
        onRateChange={onRateChange}
        onRetry={onRetry}
      />
    );

    content = (
      <div className="grid min-h-0 gap-4 pb-6">
          <div
            className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&_.podcast-cover-stack]:touch-pan-x [&_.podcast-stage-meta]:touch-pan-x [&_.podcast-stage-source]:touch-pan-x [&_.podcast-stage-title]:touch-pan-x"
            data-podcast-swipe-zone
            tabIndex={0}
            aria-label="播客卡片浏览区，可用上下方向键切换"
            onWheel={handleWheel}
            onKeyDown={handleStageKeyDown}
            onPointerDown={handleSwipeStart}
            onPointerUp={handleSwipeEnd}
            onPointerCancel={() => { swipeStartRef.current = null; }}
          >
            <PodcastStage
              item={browseItem}
              index={browseIndex}
              total={filteredItems.length}
              isPlaying={browseIsActive && playback.status === "playing"}
              controls={controls}
              onPrevious={onPrevious}
              onNext={onNext}
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              className={stateButtonClass}
              aria-pressed={playback.continuousPlay}
              onClick={() => onContinuousPlayChange(!playback.continuousPlay)}
            >
              连续播放
            </button>
          </div>

          <PodcastInsightPanel
            item={browseItem}
            saving={saving}
            savingLabel={savingLabel}
            thoughtAction={renderThoughtAction(browseItem)}
            onSave={() => onSave(browseItem)}
            onGenerate={() => onGenerate(browseItem)}
            onAddToCanvas={onAddToCanvas}
          />
      </div>
    );
  }

  return (
    <main className="podcast-page flex h-full min-h-0 flex-col overflow-x-hidden bg-bg text-text-main">
      <header className="border-b border-border bg-bg px-4 py-4 sm:px-6 lg:px-8">
        <div className="mx-auto grid w-full max-w-[720px] gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <button
                type="button"
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full border border-border bg-surface text-text-main focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                onClick={onBack}
                aria-label="返回"
              >
                <ArrowLeft aria-hidden="true" size={20} />
              </button>
              <div className="min-w-0">
                <h1 className="truncate font-serif text-2xl font-semibold text-text-main">播客解读</h1>
                <p className="mt-1 flex items-center gap-1.5 text-xs text-text2">
                  <CalendarDays aria-hidden="true" size={14} />
                  {filteredItems.length} 条·{rangeLabel}
                </p>
              </div>
            </div>

            <div className="flex min-h-11 items-center rounded-full border border-border bg-surface p-1" aria-label="时间范围">
              {([
                ["today", "今天"],
                ["three_days", "过去 3 天"],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`min-h-11 rounded-full px-3 text-xs font-semibold ${range === value ? "bg-accent text-bg" : "text-text2"}`}
                  aria-pressed={range === value}
                  onClick={() => onRangeChange(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

        </div>
      </header>

      <div className="mx-auto grid min-h-0 w-full max-w-[720px] flex-1 content-start gap-4 overflow-y-auto px-4 py-4 sm:px-6">
        {articlesError && filteredItems.length > 0 && (
          <aside className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-surface px-4 py-3 text-sm text-text2" role="status">
            <span className="flex items-center gap-2">
              <AlertTriangle aria-hidden="true" className="text-accent" size={17} />
              部分内容刷新失败，正在显示上次结果
            </span>
            <button type="button" className={stateButtonClass} onClick={onReload}>
              <RefreshCw aria-hidden="true" size={16} />
              重新加载
            </button>
          </aside>
        )}
        {content}
        {compactActiveControls}
      </div>
    </main>
  );
}

export function PodcastPage({ onBack, onDiscover, onAddToCanvas }: PodcastPageProps) {
  const {
    articles,
    savedArticles,
    isArticlesLoading,
    articlesError,
    reloadArticles,
    user,
    isAuthLoading,
    setShowLoginModal,
    saveArticle,
    isSavingArticle,
    getSavingStageText,
    showToast,
    setReadingArticle,
  } = useAppContext();
  const [range, setRange] = useState<PodcastDateRange>("today");
  const syncedBrowseSourceRef = useRef<string | null>(null);
  const {
    playback,
    activeItem,
    setQueue,
    browse,
    toggle,
    seek,
    skip,
    setRate,
    setContinuousPlay,
    retry,
  } = usePodcastPlayback();
  usePodcastFullPlayerPresence();

  const items = useMemo(
    () => buildPodcastPreviewItems(articles, savedArticles),
    [articles, savedArticles],
  );
  const filteredItems = useMemo(
    () => filterPodcastItems(items, "for_you", range),
    [items, range],
  );
  const gate = resolvePodcastPageGate({
    isAuthLoading,
    isSignedIn: Boolean(user),
    isArticlesLoading,
    articlesError,
    itemCount: items.length,
  });

  useEffect(() => {
    setQueue(user ? filteredItems : []);
  }, [filteredItems, setQueue, user]);

  useEffect(() => {
    if (!user) {
      browse(null);
      return;
    }
    const currentStillVisible = filteredItems.some(item => item.id === playback.browseItemId);
    if (currentStillVisible) return;
    browse(filteredItems[0]?.id ?? null);
  }, [browse, filteredItems, playback.browseItemId, user]);

  const browseItem = filteredItems.find(item => item.id === playback.browseItemId)
    ?? filteredItems[0];
  const sourceArticle = useMemo(
    () => resolvePodcastSourceArticle(browseItem, articles, savedArticles),
    [articles, browseItem, savedArticles],
  );
  const sourceKey = `${browseItem?.id ?? "none"}:${sourceArticle?.id ?? "none"}`;

  useEffect(() => {
    if (syncedBrowseSourceRef.current === sourceKey) return;
    syncedBrowseSourceRef.current = sourceKey;
    void setReadingArticle(sourceArticle);
  }, [setReadingArticle, sourceArticle, sourceKey]);

  const browseBy = useCallback((offset: -1 | 1) => {
    if (filteredItems.length === 0) return;
    const currentIndex = filteredItems.findIndex(item => item.id === playback.browseItemId);
    const nextIndex = currentIndex < 0
      ? (offset > 0 ? 0 : filteredItems.length - 1)
      : (currentIndex + offset + filteredItems.length) % filteredItems.length;
    browse(filteredItems[nextIndex].id);
  }, [browse, filteredItems, playback.browseItemId]);

  const handleToggle = useCallback((item: PodcastPreviewItem) => {
    if (!item.audioUrl) {
      showToast("音频生成尚未接入；当前先展示真实来源摘要。");
      return;
    }
    void toggle(item);
  }, [showToast, toggle]);

  const handleSave = useCallback((item: PodcastPreviewItem) => {
    if (item.articleId === undefined || item.isSaved) return;
    void saveArticle(item.articleId, {
      id: item.articleId,
      url: item.sourceUrl,
      source: item.source,
      title: item.title,
    });
  }, [saveArticle]);

  const handleGenerate = useCallback(() => {
    showToast("音频生成尚未接入；当前先展示真实来源摘要。");
  }, [showToast]);

  const savingArticleIds = items.flatMap(item =>
    item.articleId !== undefined && isSavingArticle(item.articleId) ? [item.articleId] : []
  );

  return (
    <PodcastPageContent
      items={items}
      filteredItems={filteredItems}
      range={range}
      gate={gate}
      articlesError={articlesError}
      playback={playback}
      activeItem={activeItem}
      savingArticleIds={savingArticleIds}
      getSavingLabel={getSavingStageText}
      onRangeChange={setRange}
      onPrevious={() => browseBy(-1)}
      onNext={() => browseBy(1)}
      onToggle={handleToggle}
      onSeek={seek}
      onSkip={skip}
      onRateChange={setRate}
      onContinuousPlayChange={setContinuousPlay}
      onRetry={retry}
      onSave={handleSave}
      onGenerate={handleGenerate}
      onReload={() => { void reloadArticles(); }}
      onLogin={() => setShowLoginModal(true)}
      onBack={onBack}
      onDiscover={onDiscover}
      onAddToCanvas={onAddToCanvas}
      renderThoughtAction={item => (
        <InspirationButton
          label="说下我的想法"
          articleTitle={item.title}
          articleId={item.articleId}
          savedArticleId={item.savedArticleId}
        />
      )}
    />
  );
}
