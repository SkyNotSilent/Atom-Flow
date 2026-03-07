import React, { useState } from 'react';
import { useAppContext } from '../context/AppContext';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { Sun, Moon, Menu, X, Plus, LayoutGrid, List, Check } from 'lucide-react';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface NavProps {
  activeTab: 'feed' | 'knowledge' | 'write';
  setActiveTab: (tab: 'feed' | 'knowledge' | 'write') => void;
}

export const Nav: React.FC<NavProps> = ({ activeTab, setActiveTab }) => {
  const { articles, savedCards, theme, toggleTheme, activeTopic, setActiveTopic } = useAppContext();
  
  const unreadCount = articles.filter(a => !a.saved).length;
  
  const handleTabClick = (tab: 'feed' | 'knowledge' | 'write') => {
    setActiveTab(tab);
  };

  const topics = [
    { name: '全部', icon: '🗂' },
    { name: '产品思维', icon: '🛠' },
    { name: '商业洞察', icon: '💼' },
    { name: 'AI 方向', icon: '🤖' },
    { name: '内容创作', icon: '✍️' },
  ];

  const sources = [
    { name: '少数派', color: '#553C9A', count: 2 },
    { name: '虎嗅网', color: '#2F855A', count: 2 },
    { name: '科技爱好者周刊', color: '#2B6CB0', count: 2 },
  ];

  return (
    <nav className="w-[240px] h-full bg-surface border-r border-border flex flex-col shrink-0 transition-colors">
      <div className="h-14 flex items-center px-6 shrink-0">
        <div className="font-serif font-bold text-[18px] text-text-main">
          Atom<span className="text-accent">Flow</span>
        </div>
      </div>
      
      <div className="flex-1 overflow-y-auto py-4 px-3 flex flex-col gap-1">
        <TabButton active={activeTab === 'feed'} onClick={() => handleTabClick('feed')} badge={unreadCount} fullWidth>今日推送</TabButton>
        <TabButton active={activeTab === 'knowledge'} onClick={() => handleTabClick('knowledge')} badge={savedCards.length} fullWidth>我的知识库</TabButton>
        <TabButton active={activeTab === 'write'} onClick={() => handleTabClick('write')} fullWidth>魔法写作</TabButton>

        {activeTab === 'feed' && (
          <div className="mt-6">
            <div className="text-[11px] font-semibold uppercase text-text3 mb-2 px-3">话题聚合</div>
            <div className="flex flex-col gap-0.5">
              {topics.map(t => {
                const count = t.name === '全部' ? articles.length : articles.filter(a => a.topic === t.name).length;
                return (
                  <button
                    key={t.name}
                    onClick={() => setActiveTopic(t.name)}
                    className={cn(
                      "flex items-center justify-between px-3 py-1.5 rounded-lg text-[13px] transition-colors",
                      activeTopic === t.name ? "bg-accent-light text-accent font-medium" : "text-text2 hover:bg-surface2"
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span>{t.icon}</span>
                      <span>{t.name}</span>
                    </div>
                    <span className="text-[11px] opacity-60">{count}</span>
                  </button>
                );
              })}
            </div>

            <div className="flex items-center justify-between mt-6 mb-2 px-3">
              <div className="text-[11px] font-semibold uppercase text-text3">我的订阅源</div>
              <button 
                className="w-5 h-5 rounded-full bg-accent-light text-accent flex items-center justify-center hover:bg-accent hover:text-white transition-colors"
              >
                <Plus size={12} />
              </button>
            </div>
            
            <div className="flex flex-col gap-0.5">
              {sources.map(s => (
                <div key={s.name} className="group flex items-center justify-between px-3 py-1.5 rounded-lg text-[13px] text-text2 hover:bg-surface2 cursor-pointer">
                  <div className="flex items-center gap-2">
                    <div className="w-[6px] h-[6px] rounded-full" style={{ backgroundColor: s.color }} />
                    <span>{s.name}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] opacity-60 group-hover:hidden">{s.count}</span>
                    <button 
                      className="hidden group-hover:flex w-4 h-4 rounded-full bg-border items-center justify-center hover:bg-accent hover:text-white"
                    >
                      <Plus size={10} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      
      <div className="p-4 border-t border-border flex items-center justify-between shrink-0">
        <div className="text-[12px] text-text3">演示原型 · v0.2</div>
        <button onClick={toggleTheme} className="p-2 rounded-md text-text2 hover:bg-surface2 transition-colors">
          {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </button>
      </div>
    </nav>
  );
};

const TabButton: React.FC<{
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  badge?: number;
  fullWidth?: boolean;
}> = ({ active, onClick, children, badge, fullWidth }) => {
  return (
    <button
      onClick={onClick}
      className={cn(
        "px-4 py-2 md:py-1.5 rounded-md text-[14px] font-medium transition-colors flex items-center gap-2",
        fullWidth && "w-full justify-between",
        active ? "bg-accent-light text-accent" : "text-text2 hover:bg-surface2"
      )}
    >
      {children}
      {badge !== undefined && badge > 0 && (
        <span className="bg-accent text-white text-[11px] rounded-full px-1.5 min-w-[18px] h-[18px] flex items-center justify-center">
          {badge}
        </span>
      )}
    </button>
  );
};
