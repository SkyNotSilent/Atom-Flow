/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from "react";
import { AppProvider, useAppContext } from "./context/AppContext";
import { Nav } from "./components/Nav";
import { Toast } from "./components/Toast";
import { FeedPage } from "./pages/FeedPage";
import { KnowledgePage } from "./pages/KnowledgePage";
import { WritePage } from "./pages/WritePage";
import { DiscoverPage } from "./pages/DiscoverPage";
import { ReaderPane } from "./components/ReaderModal";
import { LoginModal } from "./components/LoginModal";
import { ProfileModal } from "./components/ProfileModal";

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
  const [activeTab, setActiveTab] = useState<"feed" | "knowledge" | "write" | "discover">(
    "feed",
  );
  const { readingArticle, showLoginModal, setShowLoginModal, handleLoginSuccess, showProfileModal, setShowProfileModal } = useAppContext();
  const isWriteTab = activeTab === 'write';
  const containerRef = useRef<HTMLDivElement>(null);
  const [navWidth, setNavWidth] = useState(260);
  const [centerWidth, setCenterWidth] = useState(560);
  const [dragging, setDragging] = useState<"nav-center" | "center-right" | null>(null);
  const [hoverCenterRightEdge, setHoverCenterRightEdge] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const EDGE_DRAG_ZONE = 16;
  const SPLITTER = 8;

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768);
    };
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

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
    if (dragging === "center-right") {
      document.body.style.cursor = "col-resize";
      return () => {
        document.body.style.cursor = "";
      };
    }
    document.body.style.cursor = "";
  }, [dragging]);

  return (
    <div
      ref={containerRef}
      className="flex h-screen overflow-hidden bg-bg text-text-main font-sans"
      style={{ cursor: hoverCenterRightEdge || dragging === "center-right" ? "col-resize" : undefined }}
      onMouseMove={(event) => {
        if (isMobile) return;
        const container = containerRef.current;
        if (!container) return;
        const rect = container.getBoundingClientRect();
        const dividerX = rect.left + navWidth + SPLITTER + centerWidth;
        setHoverCenterRightEdge(Math.abs(event.clientX - dividerX) <= EDGE_DRAG_ZONE);
      }}
      onMouseLeave={() => setHoverCenterRightEdge(false)}
      onMouseDownCapture={(event) => {
        if (isMobile || event.button !== 0) return;
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
      {isMobile && mobileNavOpen && (
        <div 
          className="fixed inset-0 bg-black/40 z-40"
          onClick={() => setMobileNavOpen(false)}
        />
      )}
      
      {/* 导航栏 */}
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
            setActiveTab(tab);
            if (isMobile) setMobileNavOpen(false);
          }} 
        />
      </div>

      {/* 桌面端分隔条 */}
      {!isMobile && (
        <div
          className="w-2 shrink-0 cursor-col-resize hover:bg-accent/30 transition-colors"
          onMouseDown={() => setDragging("nav-center")}
        />
      )}

      {/* 中间内容区 */}
      <div
        className={`
          flex flex-col overflow-hidden
          ${isMobile ? 'flex-1' : isWriteTab ? 'flex-1 border-r border-border' : 'shrink-0 border-r border-border'}
          ${isMobile && readingArticle ? 'hidden' : ''}
        `}
        style={{ width: isMobile ? '100%' : isWriteTab ? undefined : centerWidth }}
      >
        {/* 移动端顶部栏 */}
        {isMobile && (
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
            {isMobile ? (
              <div className="min-h-0 flex-1 p-4">
                <WritePage />
              </div>
            ) : (
              <div className="min-h-0 flex-1 p-4">
                <WritePage />
              </div>
            )}
          </div>
        )}
        {activeTab === "discover" && <DiscoverPage />}
      </div>

      {/* 右侧阅读区 / 写作助手区 */}
      {!isWriteTab && (
        <div
          className={`
            ${isMobile ? 'fixed inset-0 z-30 bg-surface' : 'flex-1 min-w-[320px]'}
            overflow-hidden
            ${isMobile && !readingArticle ? 'hidden' : ''}
          `}
        >
          {readingArticle ? (
            <ReaderPane onClose={isMobile ? () => {} : undefined} />
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

export default function App() {
  return (
    <ErrorBoundary>
      <AppProvider>
        <AppContent />
      </AppProvider>
    </ErrorBoundary>
  );
}
