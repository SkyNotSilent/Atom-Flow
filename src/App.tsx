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
import { ReaderPane } from "./components/ReaderModal";

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
  const [activeTab, setActiveTab] = useState<"feed" | "knowledge" | "write">(
    "feed",
  );
  const { readingArticle } = useAppContext();
  const containerRef = useRef<HTMLDivElement>(null);
  const [navWidth, setNavWidth] = useState(260);
  const [centerWidth, setCenterWidth] = useState(560);
  const [dragging, setDragging] = useState<"nav-center" | "center-right" | null>(null);
  const [hoverCenterRightEdge, setHoverCenterRightEdge] = useState(false);
  const EDGE_DRAG_ZONE = 16;
  const SPLITTER = 8;

  useEffect(() => {
    if (!dragging) return;
    const onMouseMove = (event: MouseEvent) => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const minNav = 220;
      const minCenter = 360;
      const minRight = 320;
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
        const container = containerRef.current;
        if (!container) return;
        const rect = container.getBoundingClientRect();
        const dividerX = rect.left + navWidth + SPLITTER + centerWidth;
        setHoverCenterRightEdge(Math.abs(event.clientX - dividerX) <= EDGE_DRAG_ZONE);
      }}
      onMouseLeave={() => setHoverCenterRightEdge(false)}
      onMouseDownCapture={(event) => {
        if (event.button !== 0) return;
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
      <div className="shrink-0 h-full" style={{ width: navWidth }}>
        <Nav activeTab={activeTab} setActiveTab={setActiveTab} />
      </div>
      <div
        className="w-2 shrink-0 cursor-col-resize hover:bg-accent/30 transition-colors"
        onMouseDown={() => setDragging("nav-center")}
      />
      <div
        className="flex flex-col overflow-hidden shrink-0 border-r border-border"
        style={{ width: centerWidth }}
      >
        {activeTab === "feed" && <FeedPage />}
        {activeTab === "knowledge" && <KnowledgePage />}
        {activeTab === "write" && <WritePage />}
      </div>
      <div className="flex-1 min-w-[320px] overflow-hidden bg-surface">
        {readingArticle ? (
          <ReaderPane />
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

      <Toast />
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
