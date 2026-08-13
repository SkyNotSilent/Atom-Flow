/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { AppProvider, useAppContext } from "./context/AppContext";
import { Nav } from "./components/Nav";
import { Toast } from "./components/Toast";
import { FeedPage } from "./pages/FeedPage";
import { KnowledgePage } from "./pages/KnowledgePage";
import { DiscoverPage } from "./pages/DiscoverPage";
import { ReaderPane } from "./components/ReaderModal";
import { LoginModal } from "./components/LoginModal";
import { ProfileModal } from "./components/ProfileModal";
import type { AppTab } from "./types";
import { isFullWidthAppTab } from "./utils/appTabs";
import { PodcastPlaybackProvider } from "./components/podcast/PodcastPlaybackProvider";
import { buildPodcastPreviewItems, type PodcastPreviewItem } from "./components/podcast/podcastPreview";
import {
  CANVAS_PROJECTS_CHANGED_EVENT,
  readCanvasProjectTarget,
  rememberCanvasProjectTarget,
  resolveCanvasProjectTarget,
  type CanvasProjectsChangedDetail,
} from "./utils/canvasProjectTarget";
import { MagicWriteAccessGate } from "./components/billing/MagicWriteAccessGate";

const WritePage = React.lazy(() => import("./pages/WritePage").then(module => ({ default: module.WritePage })));
const PodcastPage = React.lazy(() => import("./pages/PodcastPage").then(module => ({ default: module.PodcastPage })));

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch() {}

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen items-center justify-center bg-bg text-text-main">
          <div className="w-[520px] max-w-[90vw] rounded-2xl border border-border bg-surface p-8 text-center shadow-lg">
            <div className="text-[18px] font-semibold mb-2">界面加载异常</div>
            <div className="text-[13px] text-text3 mb-6">请刷新页面重试，或稍后再试</div>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 rounded-lg bg-accent text-white text-[13px] font-medium hover:opacity-90"
            >
              刷新页面
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function AppContent() {
  const [activeTab, setActiveTab] = useState<AppTab>(() => {
    if (typeof window === 'undefined') return 'feed';
    return new URLSearchParams(window.location.search).get('view') === 'write' ? 'write' : 'feed';
  });
  const {
    user, articles, savedArticles, readingArticle, setReadingArticle, showLoginModal, setShowLoginModal, handleLoginSuccess,
    showProfileModal, setShowProfileModal, showToast, billingState, refreshBillingStatus,
    requestBillingIntent, consumeBillingIntent, completeBillingIntent,
  } = useAppContext();
  const isWriteTab = activeTab === 'write';
  const isPodcastTab = activeTab === "podcast";
  const isFullWidthTab = isFullWidthAppTab(activeTab);
  const containerRef = useRef<HTMLDivElement>(null);
  const [navWidth, setNavWidth] = useState(260);
  const [centerWidth, setCenterWidth] = useState(560);
  const [dragging, setDragging] = useState<"nav-center" | "center-right" | null>(null);
  const [hoverCenterRightEdge, setHoverCenterRightEdge] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const canvasProjectTargetRef = useRef<{ ownerId: number | null; projectId: number | null }>({
    ownerId: null,
    projectId: null,
  });
  const writeLeaveInFlightRef = useRef(false);
  const pendingPodcastItemsRef = useRef(new Map<string, PodcastPreviewItem>());
  const replayingBillingIntentsRef = useRef(new Set<string>());
  const EDGE_DRAG_ZONE = 16;
  const SPLITTER = 8;

  useEffect(() => {
    const ownerId = user?.id;
    canvasProjectTargetRef.current = {
      ownerId: ownerId ?? null,
      projectId: readCanvasProjectTarget(ownerId),
    };
    if (!ownerId) return;

    const handleProjectsChanged = (event: Event) => {
      const eventDetail = (event as CustomEvent<CanvasProjectsChangedDetail>).detail;
      if (!eventDetail || eventDetail.ownerId !== ownerId) return;
      const currentProjectId = eventDetail.currentProjectId;
      if (currentProjectId !== null && !eventDetail.projects.some(project => project.id === currentProjectId)) return;
      canvasProjectTargetRef.current = { ownerId, projectId: currentProjectId };
      rememberCanvasProjectTarget(ownerId, currentProjectId);
    };
    window.addEventListener(CANVAS_PROJECTS_CHANGED_EVENT, handleProjectsChanged);
    return () => window.removeEventListener(CANVAS_PROJECTS_CHANGED_EVENT, handleProjectsChanged);
  }, [user?.id]);

  const addPodcastToCanvas = useCallback(async (item: PodcastPreviewItem, intentRequestId: string = crypto.randomUUID()): Promise<boolean> => {
    if (!user) {
      pendingPodcastItemsRef.current.set(item.id, item);
      requestBillingIntent({ kind: 'add_podcast_episode', episodeId: item.id, articleId: item.articleId, savedArticleId: item.savedArticleId, sourceUrl: item.sourceUrl });
      return false;
    }
    if (billingState.phase !== 'ready') {
      await refreshBillingStatus();
      pendingPodcastItemsRef.current.set(item.id, item);
      requestBillingIntent({ kind: 'add_podcast_episode', episodeId: item.id, articleId: item.articleId, savedArticleId: item.savedArticleId, sourceUrl: item.sourceUrl });
      setActiveTab('write');
      return false;
    }
    if (billingState.status.access !== 'full') {
      pendingPodcastItemsRef.current.set(item.id, item);
      requestBillingIntent({ kind: 'add_podcast_episode', episodeId: item.id, articleId: item.articleId, savedArticleId: item.savedArticleId, sourceUrl: item.sourceUrl });
      setActiveTab('write');
      showToast(billingState.status.access === 'read_only' ? '当前为只读模式，重新订阅后会继续加入' : '开通 Pro 后会自动将节目加入画布');
      return false;
    }
    try {
      const ownerId = user?.id;
      if (!ownerId) throw new Error('account unavailable');
      const projectsResponse = await fetch('/api/write/canvas/projects');
      if (!projectsResponse.ok) throw new Error('projects unavailable');
      const projectsPayload = await projectsResponse.json() as { projects?: Array<{ id: number }> };
      let projects = Array.isArray(projectsPayload.projects) ? projectsPayload.projects : [];
      if (projects.length === 0) {
        const createResponse = await fetch('/api/write/canvas/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: '我的魔法写作项目', requestId: intentRequestId }),
        });
        if (!createResponse.ok) throw new Error('project unavailable');
        const created = await createResponse.json() as { project?: { id: number } };
        if (!created.project) throw new Error('project unavailable');
        projects = [created.project];
      }
      const preferredProjectId = canvasProjectTargetRef.current.ownerId === ownerId
        ? canvasProjectTargetRef.current.projectId
        : readCanvasProjectTarget(ownerId);
      const projectId = resolveCanvasProjectTarget(projects, preferredProjectId);
      if (!projectId) throw new Error('project unavailable');
      canvasProjectTargetRef.current = { ownerId, projectId };
      rememberCanvasProjectTarget(ownerId, projectId);
      const response = await fetch(`/api/write/canvas/projects/${projectId}/nodes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'podcast_episode',
          refId: item.id,
          title: item.title,
          summary: item.summary,
          x: 220,
          y: 180,
          width: 340,
          height: 210,
          requestId: intentRequestId,
          meta: {
            episodeId: item.id,
            articleId: item.articleId,
            savedArticleId: item.savedArticleId,
            source: item.source,
            sourceUrl: item.sourceUrl,
            audioUrl: item.audioUrl,
            audioDuration: item.audioDuration,
            publishedAt: item.publishedAt,
            contextBasis: item.contextBasis,
          },
        }),
      });
      if (!response.ok) throw new Error('node unavailable');
      showToast('节目已加入魔法写作画布');
      return true;
    } catch {
      showToast('节目加入画布失败，请稍后重试');
      return false;
    }
  }, [billingState, refreshBillingStatus, requestBillingIntent, showToast, user]);

  useEffect(() => {
    if (!user || billingState.phase !== 'ready') return;
    const pending = consumeBillingIntent();
    if (!pending) return;
    if (pending.intent.kind === 'open_write' || pending.intent.kind === 'open_project') {
      setActiveTab('write');
      if (pending.intent.kind === 'open_project') {
        const projectId = pending.intent.projectId;
        rememberCanvasProjectTarget(user.id, projectId);
        window.setTimeout(() => window.dispatchEvent(new CustomEvent('atomflow-canvas-select-project', { detail: { projectId } })), 0);
      }
      completeBillingIntent(pending.requestId);
      return;
    }
    if (pending.intent.kind === 'add_podcast_episode' && billingState.status.access === 'full') {
      const podcastIntent = pending.intent;
      const item = pendingPodcastItemsRef.current.get(podcastIntent.episodeId)
        || buildPodcastPreviewItems(articles, savedArticles).find(candidate => candidate.id === podcastIntent.episodeId);
      if (!item) return;
      if (replayingBillingIntentsRef.current.has(pending.requestId)) return;
      replayingBillingIntentsRef.current.add(pending.requestId);
      void addPodcastToCanvas(item, pending.requestId).then(successful => {
        replayingBillingIntentsRef.current.delete(pending.requestId);
        if (!successful) return;
        completeBillingIntent(pending.requestId);
        pendingPodcastItemsRef.current.delete(podcastIntent.episodeId);
      });
    }
  }, [addPodcastToCanvas, articles, billingState, completeBillingIntent, consumeBillingIntent, savedArticles, user]);

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768);
    };
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  useEffect(() => {
    if (isFullWidthTab) {
      setDragging(null);
      setHoverCenterRightEdge(false);
    }
  }, [isFullWidthTab]);

  useEffect(() => {
    if (!dragging) return;
    const onMouseMove = (event: MouseEvent) => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const minNav = 220;
      const minCenter = 360;
      const minRight = activeTab === 'write' ? 320 : 320;
      const available = rect.width - SPLITTER;
      const maxNav = Math.max(minNav, available - minCenter - minRight);
      const offsetX = event.clientX - rect.left;
      if (dragging === "nav-center") {
        const nextNav = Math.min(maxNav, Math.max(minNav, offsetX));
        setNavWidth(nextNav);
        return;
      }
      const maxCenter = Math.max(minCenter, available - navWidth - minRight);
      const nextCenter = Math.min(maxCenter, Math.max(minCenter, offsetX - navWidth - SPLITTER));
      setCenterWidth(nextCenter);
    };
    const onMouseUp = () => setDragging(null);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [dragging, navWidth]);

  useEffect(() => {
    if (dragging === "center-right" && !isFullWidthTab) {
      document.body.style.cursor = "col-resize";
      return () => {
        document.body.style.cursor = "";
      };
    }
    document.body.style.cursor = "";
  }, [dragging, isFullWidthTab]);

  const leaveWriteWorkspace = useCallback(async () => {
    if (writeLeaveInFlightRef.current) return;
    writeLeaveInFlightRef.current = true;
    try {
      const pendingSaves: Promise<boolean>[] = [];
      window.dispatchEvent(new window.CustomEvent('atomflow:before-write-leave', {
        detail: {
          waitUntil: (pending: Promise<boolean>) => pendingSaves.push(pending),
        },
      }));
      const results = await Promise.allSettled(pendingSaves);
      if (results.some(result => result.status === 'rejected' || result.value !== true)) {
        showToast('写作内容尚未保存，已留在当前页面；请检查网络后重试');
        return;
      }
      setActiveTab('feed');
    } finally {
      writeLeaveInFlightRef.current = false;
    }
  }, [showToast]);

  return (
    <div
      ref={containerRef}
      className="flex h-screen overflow-hidden bg-bg text-text-main font-sans"
      style={{ cursor: !isFullWidthTab && (hoverCenterRightEdge || dragging === "center-right") ? "col-resize" : undefined }}
      onMouseMove={(event) => {
        if (isMobile || isFullWidthTab) return;
        const container = containerRef.current;
        if (!container) return;
        const rect = container.getBoundingClientRect();
        const dividerX = rect.left + navWidth + SPLITTER + centerWidth;
        setHoverCenterRightEdge(Math.abs(event.clientX - dividerX) <= EDGE_DRAG_ZONE);
      }}
      onMouseLeave={() => setHoverCenterRightEdge(false)}
      onMouseDownCapture={(event) => {
        if (isMobile || isFullWidthTab || event.button !== 0) return;
        const container = containerRef.current;
        if (!container) return;
        const rect = container.getBoundingClientRect();
        const dividerX = rect.left + navWidth + SPLITTER + centerWidth;
        if (Math.abs(event.clientX - dividerX) <= EDGE_DRAG_ZONE) {
          event.preventDefault();
          setDragging("center-right");
        }
      }}
    >
      {/* 移动端导航抽屉 */}
      {!isWriteTab && isMobile && mobileNavOpen && (
        <div
          className="fixed inset-0 bg-black/40 z-40"
          onClick={() => setMobileNavOpen(false)}
        />
      )}

      {/* 导航栏 */}
      {!isWriteTab && (
        <div
          className={`
            ${isMobile ? 'fixed top-0 left-0 h-full z-50 transition-transform duration-300' : 'shrink-0 h-full'}
            ${isMobile && !mobileNavOpen ? '-translate-x-full' : 'translate-x-0'}
          `}
          style={{ width: isMobile ? '280px' : navWidth }}
        >
          <Nav
            activeTab={activeTab}
            setActiveTab={(tab) => {
              if (isMobile && isPodcastTab && tab !== "podcast") {
                setReadingArticle(null);
              }
              setActiveTab(tab);
              if (isMobile) setMobileNavOpen(false);
            }}
          />
        </div>
      )}

      {/* 桌面端分隔条 */}
      {!isWriteTab && !isMobile && (
        <div
          className="w-2 shrink-0 cursor-col-resize hover:bg-accent/30 transition-colors"
          onMouseDown={() => setDragging("nav-center")}
        />
      )}

      {/* 中间内容区 */}
      <div
        className={`
          flex flex-col overflow-hidden
          ${isMobile ? 'flex-1' : isFullWidthTab ? 'flex-1' : 'shrink-0 border-r border-border'}
          ${isMobile && !isFullWidthTab && readingArticle && !isPodcastTab ? 'hidden' : ''}
        `}
        style={{ width: isMobile ? '100%' : isFullWidthTab ? undefined : centerWidth }}
      >
        {/* 移动端顶部栏 */}
        {isMobile && !isPodcastTab && !isWriteTab && (
          <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface">
            <button
              onClick={() => setMobileNavOpen(true)}
              className="p-2 hover:bg-surface2 rounded-lg transition-colors"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="3" y1="12" x2="21" y2="12"/>
                <line x1="3" y1="6" x2="21" y2="6"/>
                <line x1="3" y1="18" x2="21" y2="18"/>
              </svg>
            </button>
            <h1 className="font-serif text-[16px] font-bold text-text-main">AtomFlow</h1>
          </div>
        )}
        
        {activeTab === "feed" && <FeedPage />}
        {activeTab === "knowledge" && <KnowledgePage />}
        {activeTab === "write" && (
          <div className="flex h-full min-h-0 flex-col bg-bg">
            <div className="min-h-0 flex-1">
              <MagicWriteAccessGate onBack={() => setActiveTab('feed')}>
                <React.Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-text3">加载中...</div>}>
                  <WritePage onExit={() => { void leaveWriteWorkspace(); }} />
                </React.Suspense>
              </MagicWriteAccessGate>
            </div>
          </div>
        )}
        {activeTab === "podcast" && (
          <React.Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-text3">加载播客解读...</div>}>
            <PodcastPage
              onBack={() => {
                setReadingArticle(null);
                setActiveTab("feed");
              }}
              onDiscover={() => {
                setReadingArticle(null);
                setActiveTab("discover");
              }}
              onAddToCanvas={item => { void addPodcastToCanvas(item); }}
            />
          </React.Suspense>
        )}
        {activeTab === "discover" && <DiscoverPage />}
      </div>

      {/* 右侧阅读区 / 写作助手区 */}
      {!isFullWidthTab && (
        <div
          className={`
            ${isMobile ? 'fixed inset-0 z-30 bg-surface' : 'flex-1 min-w-[320px]'}
            overflow-hidden
            ${isMobile && (!readingArticle || isPodcastTab) ? 'hidden' : ''}
          `}
        >
          {readingArticle ? (
            <ReaderPane audio={isPodcastTab ? false : undefined} onClose={isMobile ? () => {} : undefined} />
          ) : (
            <div className="h-full flex flex-col items-center justify-center bg-surface border-l border-border">
              <div className="w-24 h-24 mb-6 opacity-20">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
                </svg>
              </div>
              <p className="text-text3 text-[15px]">选择一篇文章开始阅读</p>
            </div>
          )}
        </div>
      )}

      <Toast />
      <LoginModal
        isOpen={showLoginModal}
        onClose={() => setShowLoginModal(false)}
        onSuccess={(u) => void handleLoginSuccess(u)}
      />
      <ProfileModal
        isOpen={showProfileModal}
        onClose={() => setShowProfileModal(false)}
      />
    </div>
  );
}

function UserScopedPodcastPlayback() {
  const { user, isAuthLoading } = useAppContext();
  const ownerIdentity = isAuthLoading ? undefined : user?.id ?? null;

  return (
    <PodcastPlaybackProvider ownerIdentity={ownerIdentity}>
      <AppContent />
    </PodcastPlaybackProvider>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppProvider>
        <UserScopedPodcastPlayback />
      </AppProvider>
    </ErrorBoundary>
  );
}
