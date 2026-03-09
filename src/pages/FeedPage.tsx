import React, { useState } from 'react';
import { useAppContext } from '../context/AppContext';
import { Article } from '../types';
import { cn } from '../components/Nav';
import { Check, LayoutGrid, List, Sparkles } from 'lucide-react';
import { getDisplaySource, sourceMatches } from '../utils/articleDisplay';

export const FeedPage: React.FC = () => {
  const { articles, setReadingArticle, activeSource, saveArticle, isSavingArticle, getSavingStageText } = useAppContext();
  const [showSrcModal, setShowSrcModal] = useState(false);
  const [viewMode, setViewMode] = useState<'card' | 'compact'>('card');
  const [isInitialLoading, setIsInitialLoading] = useState(true);

  // 检测初始加载状态
  React.useEffect(() => {
    if (articles.length > 0) {
      setIsInitialLoading(false);
    }
  }, [articles]);

  const SOURCE_PRIORITY: Record<string, number> = {
    '36氪': 5,
    '虎嗅': 4,
    '即刻话题': 3.6,
    '数字生命卡兹克': 3.6,
    '新智元': 3.6,
    '少数派': 1.6,
    '人人都是产品经理': 1.5
  };

  const LOW_PRIORITY_SOURCES = new Set(['少数派', '人人都是产品经理']);

  const getPriority = (article: Article) => {
    if (SOURCE_PRIORITY[article.source] !== undefined) return SOURCE_PRIORITY[article.source];
    if (article.topic === '公众号') return 3.4;
    return 2.5;
  };

  const rankArticles = (items: Article[]) => {
    const sorted = [...items].sort((a, b) => {
      const pa = getPriority(a);
      const pb = getPriority(b);
      if (pb !== pa) return pb - pa;
      return (b.publishedAt ?? 0) - (a.publishedAt ?? 0);
    });
    const low = sorted.filter(item => LOW_PRIORITY_SOURCES.has(item.source));
    const rest = sorted.filter(item => !LOW_PRIORITY_SOURCES.has(item.source));
    const promotedLow = low.slice(0, 2);
    const remainingLow = low.slice(2);
    const positions = [2, 7];
    const limit = Math.min(promotedLow.length, positions.length);
    for (let i = 0; i < limit; i += 1) {
      const pos = Math.min(positions[i], rest.length);
      rest.splice(pos, 0, promotedLow[i]);
    }
    return [...rest, ...remainingLow];
  };

  const filteredArticles = activeSource
    ? [...articles]
        .filter(a => sourceMatches(a, activeSource || ''))
        .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))
    : rankArticles(articles);

  const handleSave = async (article: Article) => {
    if (article.saved || isSavingArticle(article.id)) return;
    await saveArticle(article.id);
  };

  return (
    <div className="flex-1 overflow-y-auto p-3 sm:p-4 md:p-6 w-full">
      <div className="mb-4 sm:mb-6 flex items-center justify-between">
        <div>
          <h1 className="font-serif text-[18px] sm:text-[20px] font-bold text-text-main">{activeSource || '今日推送'}</h1>
          {isInitialLoading && filteredArticles.length === 0 ? (
            <div className="flex items-center gap-2 mt-1">
              <Sparkles className="text-accent animate-spin" size={14} />
              <p className="text-[11px] sm:text-[12px] text-accent">正在聚合信息源，请稍等...</p>
            </div>
          ) : (
            <p className="text-[11px] sm:text-[12px] text-text3 mt-1">2026年3月7日 · 已聚合 {filteredArticles.length} 篇内容</p>
          )}
        </div>
        <div className="flex items-center gap-1 bg-surface2 p-1 rounded-lg">
          <button onClick={() => setViewMode('card')} className={cn("p-1 rounded transition-colors", viewMode === 'card' ? "bg-surface shadow-sm text-text-main" : "text-text3 hover:text-text-main")}>
            <LayoutGrid size={14} />
          </button>
          <button onClick={() => setViewMode('compact')} className={cn("p-1 rounded transition-colors", viewMode === 'compact' ? "bg-surface shadow-sm text-text-main" : "text-text3 hover:text-text-main")}>
            <List size={14} />
          </button>
        </div>
      </div>

      {isInitialLoading && filteredArticles.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20">
          <Sparkles className="w-16 h-16 text-accent animate-spin mb-4" />
          <p className="text-text2 text-[15px] font-medium mb-2">正在聚合信息源</p>
          <p className="text-text3 text-[13px]">首次加载可能需要几秒钟...</p>
        </div>
      ) : filteredArticles.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20">
          <div className="text-[48px] mb-4 opacity-20">📭</div>
          <p className="text-text3 text-[14px]">暂无内容</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
        {viewMode === 'card' ? filteredArticles.map(article => (
              <div 
                key={article.id}
                onClick={() => setReadingArticle(article)}
                className={cn(
                  "bg-surface rounded-xl border p-3 sm:p-[18px_20px] transition-all duration-150 cursor-pointer",
                  article.saved ? "border-accent2" : "border-border hover:border-accent hover:shadow-[0_1px_4px_rgba(0,0,0,0.07),0_4px_16px_rgba(0,0,0,0.05)] hover:-translate-y-[1px]"
                )}
              >
                <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="bg-accent-light text-accent text-[11px] sm:text-[11.5px] font-semibold px-2 py-0.5 rounded">
                      {getDisplaySource(article)}
                    </span>
                    <span className="bg-surface2 text-text2 text-[10px] sm:text-[11px] px-[7px] py-0.5 rounded">
                      {article.topic}
                    </span>
                    <span className="text-[11px] sm:text-[12px] text-text3">{article.time}</span>
                  </div>
                  {article.saved && (
                    <div className="flex items-center gap-1 text-accent2 text-[11px] sm:text-[12px]">
                      <Check size={14} />
                      <span className="hidden sm:inline">已存入</span>
                    </div>
                  )}
                </div>

                <h2 className="font-serif text-[14px] sm:text-[15.5px] font-semibold text-text-main mb-1.5 leading-snug">
                  {article.audioUrl && <span className="mr-1">🎙️</span>}
                  {article.title}
                </h2>
                <p className="text-[12px] sm:text-[13px] text-text2 leading-[1.7] line-clamp-2">
                  {article.excerpt}
                </p>

                <div className="mt-3 flex gap-2" onClick={e => e.stopPropagation()}>
                  <button 
                    onClick={() => setReadingArticle(article)}
                    className="px-3 py-1.5 rounded-lg text-[12px] sm:text-[13px] font-medium border border-border text-text2 hover:bg-surface2 transition-colors"
                  >
                    阅读全文
                  </button>
                  {!article.saved ? (
                    <button 
                      onClick={() => void handleSave(article)}
                      disabled={isSavingArticle(article.id)}
                      className={cn(
                        "px-3 py-1.5 rounded-lg text-[12px] sm:text-[13px] font-medium transition-colors flex items-center gap-1.5",
                        isSavingArticle(article.id)
                          ? "bg-accent text-white cursor-wait"
                          : "bg-accent-light text-accent hover:bg-accent hover:text-white"
                      )}
                    >
                      <Sparkles size={14} className={cn(isSavingArticle(article.id) && "animate-spin")} />
                      <span className="hidden sm:inline">{isSavingArticle(article.id) ? getSavingStageText(article.id) || '处理中...' : '存入知识库'}</span>
                      <span className="sm:hidden">{isSavingArticle(article.id) ? '处理中' : '存入'}</span>
                    </button>
                  ) : (
                    <button 
                      disabled
                      className="px-3 py-1.5 rounded-lg text-[12px] sm:text-[13px] font-medium bg-accent2-light text-accent2 flex items-center gap-1 opacity-70 cursor-not-allowed"
                    >
                      <Check size={14} /> <span className="hidden sm:inline">已存入知识库</span><span className="sm:hidden">已存入</span>
                    </button>
                  )}
                </div>
              </div>
            )) : filteredArticles.map(article => (
              <div 
                key={article.id}
                onClick={() => setReadingArticle(article)}
                className={cn(
                  "flex items-center gap-2 sm:gap-3 p-2.5 sm:p-3 bg-surface rounded-lg border cursor-pointer transition-colors",
                  article.saved ? "border-accent2" : "border-border hover:border-accent"
                )}
              >
                <span className="text-[10px] sm:text-[11px] bg-surface2 px-1.5 sm:px-2 py-0.5 rounded text-text2 shrink-0">{getDisplaySource(article)}</span>
                <span className="text-[13px] sm:text-[14px] font-medium text-text-main truncate flex-1">{article.title}</span>
                <span className="text-[11px] sm:text-[12px] text-text3 shrink-0 hidden sm:inline">{article.time}</span>
                {article.saved && <Check size={14} className="text-accent2 shrink-0" />}
              </div>
            ))}
        </div>
      )}

      {showSrcModal && (
        <SourceModal onClose={() => setShowSrcModal(false)} />
      )}
    </div>
  );
};

const SourceModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { showToast } = useAppContext();
  const [subs, setSubs] = useState<Record<string, boolean>>({});

  const sources = [
    { icon: '📰', name: '少数派', url: 'sspai.com' }
  ];

  const handleSub = (name: string) => {
    setSubs(prev => ({ ...prev, [name]: true }));
    showToast(`✓ 已成功订阅 ${name}`);
  };

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[200] flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-[620px] max-w-[95vw] bg-surface rounded-2xl flex flex-col shadow-xl overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="p-5 border-b border-border flex items-center justify-between bg-bg">
          <h2 className="font-serif text-[18px] font-bold text-text-main">添加订阅源</h2>
          <button onClick={onClose} className="text-text3 hover:text-text-main text-xl">×</button>
        </div>

        <div className="p-5 flex flex-col gap-4">
          <div className="flex gap-2">
            <input 
              type="text" 
              placeholder="Enter URL, RSSHub route, or keyword..." 
              className="flex-1 bg-surface border-2 border-border focus:border-accent outline-none rounded-xl px-4 py-2.5 text-[14px] text-text-main"
            />
            <button className="bg-accent text-white px-6 rounded-xl font-medium text-[14px] hover:bg-opacity-90 transition-colors">
              搜索
            </button>
          </div>

          <div className="flex flex-col gap-2 max-h-[400px] overflow-y-auto pr-1">
            {sources.map(s => (
              <div key={s.name} className="flex items-center gap-3 p-3 rounded-xl border border-border hover:border-accent-light transition-colors">
                <div className="w-[34px] h-[34px] rounded-full bg-surface2 flex items-center justify-center text-[18px]">
                  {s.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-[14px] text-text-main truncate">{s.name}</div>
                  <div className="text-[12px] text-text3 truncate">{s.url}</div>
                </div>
                {!subs[s.name] ? (
                  <button 
                    onClick={() => handleSub(s.name)}
                    className="ml-2 px-3 py-1.5 rounded-lg text-[13px] font-medium bg-accent-light text-accent hover:bg-accent hover:text-white transition-colors"
                  >
                    + 订阅
                  </button>
                ) : (
                  <button 
                    disabled
                    className="ml-2 px-3 py-1.5 rounded-lg text-[13px] font-medium bg-accent2-light text-accent2 flex items-center gap-1 opacity-80 cursor-not-allowed"
                  >
                    <Check size={14} /> 已订阅
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
