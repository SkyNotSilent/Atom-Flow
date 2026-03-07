/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from "react";
import { AppProvider, useAppContext } from "./context/AppContext";
import { Nav } from "./components/Nav";
import { Toast } from "./components/Toast";
import { FeedPage } from "./pages/FeedPage";
import { KnowledgePage } from "./pages/KnowledgePage";
import { WritePage } from "./pages/WritePage";
import { ReaderPane } from "./components/ReaderModal";

function AppContent() {
  const [activeTab, setActiveTab] = useState<"feed" | "knowledge" | "write">(
    "feed",
  );
  const { readingArticle } = useAppContext();

  return (
    <div className="flex h-screen overflow-hidden bg-bg text-text-main font-sans">
      <Nav activeTab={activeTab} setActiveTab={setActiveTab} />

      <div className={`flex flex-col overflow-hidden transition-all duration-300 ${readingArticle ? 'w-[360px] lg:w-[400px] shrink-0 border-r border-border hidden lg:flex' : 'flex-1'}`}>
        {activeTab === "feed" && <FeedPage />}
        {activeTab === "knowledge" && <KnowledgePage />}
        {activeTab === "write" && <WritePage />}
      </div>

      {readingArticle && (
        <div className="flex-1 flex overflow-hidden absolute inset-0 lg:static z-50 lg:z-auto bg-surface">
          <ReaderPane />
        </div>
      )}

      {!readingArticle && (
        <div className="flex-1 hidden lg:flex flex-col items-center justify-center bg-surface border-l border-border">
          <div className="w-24 h-24 mb-6 opacity-20">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
            </svg>
          </div>
          <p className="text-text3 text-[15px]">选择一篇文章开始阅读</p>
        </div>
      )}

      <Toast />
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <AppContent />
    </AppProvider>
  );
}
