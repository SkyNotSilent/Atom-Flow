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

interface AuthUser {
  id: string;
  email: string;
}

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
  const { readingArticle } = useAppContext();
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
          ${isMobile ? 'flex-1' : 'shrink-0 border-r border-border'}
          ${isMobile && readingArticle ? 'hidden' : ''}
        `}
        style={{ width: isMobile ? '100%' : centerWidth }}
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
        {activeTab === "write" && <WritePage />}
        {activeTab === "discover" && <DiscoverPage />}
      </div>

      {/* 右侧阅读区 */}
      <div 
        className={`
          ${isMobile ? 'fixed inset-0 z-30 bg-surface' : 'flex-1 min-w-[320px]'}
          overflow-hidden bg-surface
          ${isMobile && !readingArticle ? 'hidden' : ''}
        `}
      >
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

function AuthScreen({
  onSuccess,
  onClose,
  canClose
}: {
  onSuccess: (user: AuthUser) => void;
  onClose: () => void;
  canClose: boolean;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (loading) return;
    setError("");
    setLoading(true);
    try {
      const endpoint = mode === "login" ? "/api/auth/login" : "/api/auth/register";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      if (!res.ok) {
        setError(typeof data?.error === "string" ? data.error : "登录失败");
        return;
      }
      if (data?.user?.id && data?.user?.email) {
        onSuccess(data.user);
      } else {
        setError("登录状态异常，请重试");
      }
    } catch {
      setError("网络异常，请稍后重试");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-6 md:p-8 shadow-sm">
      {canClose && (
        <div className="flex justify-end -mt-1 mb-1">
          <button onClick={onClose} className="text-text3 hover:text-text-main text-[16px] leading-none">×</button>
        </div>
      )}
      <h1 className="font-serif text-[22px] font-bold mb-2">原子流笔记</h1>
      <p className="text-[13px] text-text3 mb-6">邮箱登录后，知识库卡片会按用户隔离存储。</p>
      <div className="space-y-3">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="邮箱"
          className="w-full bg-bg border border-border rounded-xl px-3 py-2.5 text-[14px] outline-none focus:border-accent"
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={mode === "login" ? "密码" : "密码（至少8位）"}
          className="w-full bg-bg border border-border rounded-xl px-3 py-2.5 text-[14px] outline-none focus:border-accent"
        />
        {error && <div className="text-[12px] text-red-500">{error}</div>}
        <button
          onClick={submit}
          disabled={loading || !email.trim() || !password.trim()}
          className="w-full h-10 rounded-xl bg-accent text-white text-[14px] font-medium disabled:opacity-50"
        >
          {loading ? "处理中..." : mode === "login" ? "登录" : "注册并登录"}
        </button>
      </div>
      <button
        onClick={() => {
          setMode(prev => prev === "login" ? "register" : "login");
          setError("");
        }}
        className="mt-4 text-[12px] text-accent hover:underline"
      >
        {mode === "login" ? "没有账号？去注册" : "已有账号？去登录"}
      </button>
    </div>
  );
}

export default function App() {
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authModalOpen, setAuthModalOpen] = useState(false);

  useEffect(() => {
    const init = async () => {
      try {
        const res = await fetch("/api/auth/me");
        const data = await res.json();
        if (data?.user?.id && data?.user?.email) {
          setAuthUser(data.user);
        }
      } finally {
        setAuthLoading(false);
      }
    };
    init();
  }, []);

  useEffect(() => {
    const handler = () => setAuthModalOpen(true);
    window.addEventListener('auth-required', handler as EventListener);
    return () => window.removeEventListener('auth-required', handler as EventListener);
  }, []);

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    setAuthUser(null);
  };

  return (
    <ErrorBoundary>
      <AppProvider key={authUser?.id || 'guest'}>
        <div className="fixed bottom-3 left-3 z-[80] flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5">
          {authLoading ? (
            <span className="text-[11px] text-text3">...</span>
          ) : authUser ? (
            <>
              <span className="text-[11px] text-text2 max-w-[180px] truncate">{authUser.email}</span>
              <button onClick={logout} className="text-[11px] text-accent hover:underline">退出</button>
            </>
          ) : (
            <button onClick={() => setAuthModalOpen(true)} className="text-[11px] text-accent hover:underline">登录</button>
          )}
        </div>
        <AppContent />
        {authModalOpen && (
          <div className="fixed inset-0 z-[120] bg-black/40 p-4 flex items-center justify-center">
            <AuthScreen
              onSuccess={(user) => {
                setAuthUser(user);
                setAuthModalOpen(false);
              }}
              onClose={() => setAuthModalOpen(false)}
              canClose
            />
          </div>
        )}
      </AppProvider>
    </ErrorBoundary>
  );
}
