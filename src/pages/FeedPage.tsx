import React, { useState } from 'react';
import { useAppContext } from '../context/AppContext';
import { Article } from '../types';
import { cn } from '../components/Nav';
import { Check, Plus, LayoutGrid, List } from 'lucide-react';

export const FeedPage: React.FC = () => {
  const { articles, setReadingArticle, activeTopic } = useAppContext();
  const [showSrcModal, setShowSrcModal] = useState(false);
  const [showSplitAnim, setShowSplitAnim] = useState<Article | null>(null);
  const [viewMode, setViewMode] = useState<'card' | 'compact'>('card');

  const filteredArticles = activeTopic === '全部' 
    ? articles 
    : articles.filter(a => a.topic === activeTopic);

  const handleSave = (article: Article) => {
    setShowSplitAnim(article);
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-6 w-full">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="font-serif text-[20px] font-bold text-text-main">{activeTopic === '全部' ? '今日推送' : activeTopic}</h1>
          <p className="text-[12px] text-text3 mt-1">2026年3月7日 · 已聚合 {filteredArticles.length} 篇内容</p>
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

      <div className="flex flex-col gap-2.5">
        {viewMode === 'card' ? filteredArticles.map(article => (
              <div 
                key={article.id}
                onClick={() => setReadingArticle(article)}
                className={cn(
                  "bg-surface rounded-xl border p-[18px_20px] transition-all duration-150 cursor-pointer",
                  article.saved ? "border-accent2" : "border-border hover:border-accent hover:shadow-[0_1px_4px_rgba(0,0,0,0.07),0_4px_16px_rgba(0,0,0,0.05)] hover:-translate-y-[1px]"
                )}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="bg-accent-light text-accent text-[11.5px] font-semibold px-2 py-0.5 rounded">
                      {article.source}
                    </span>
                    <span className="bg-surface2 text-text2 text-[11px] px-[7px] py-0.5 rounded">
                      {article.topic}
                    </span>
                    <span className="text-[12px] text-text3 ml-1">{article.time}</span>
                  </div>
                  {article.saved && (
                    <div className="flex items-center gap-1 text-accent2 text-[12px]">
                      <Check size={14} />
                      <span>已存入</span>
                    </div>
                  )}
                </div>

                <h2 className="font-serif text-[15.5px] font-semibold text-text-main mb-1.5 leading-snug">
                  {article.title}
                </h2>
                <p className="text-[13px] text-text2 leading-[1.7] line-clamp-2">
                  {article.excerpt}
                </p>

                <div className="mt-3 flex gap-2" onClick={e => e.stopPropagation()}>
                  <button 
                    onClick={() => setReadingArticle(article)}
                    className="px-3 py-1.5 rounded-lg text-[13px] font-medium border border-border text-text2 hover:bg-surface2 transition-colors"
                  >
                    阅读全文
                  </button>
                  {!article.saved ? (
                    <button 
                      onClick={() => handleSave(article)}
                      className="px-3 py-1.5 rounded-lg text-[13px] font-medium bg-accent-light text-accent hover:bg-accent hover:text-white transition-colors flex items-center gap-1"
                    >
                      <span className="text-[14px]">✦</span> 存入知识库
                    </button>
                  ) : (
                    <button 
                      disabled
                      className="px-3 py-1.5 rounded-lg text-[13px] font-medium bg-accent2-light text-accent2 flex items-center gap-1 opacity-70 cursor-not-allowed"
                    >
                      <Check size={14} /> 已存入知识库
                    </button>
                  )}
                </div>
              </div>
            )) : filteredArticles.map(article => (
              <div 
                key={article.id}
                onClick={() => setReadingArticle(article)}
                className={cn(
                  "flex items-center gap-3 p-3 bg-surface rounded-lg border cursor-pointer transition-colors",
                  article.saved ? "border-accent2" : "border-border hover:border-accent"
                )}
              >
                <span className="text-[11px] bg-surface2 px-2 py-0.5 rounded text-text2 shrink-0 hidden sm:block">{article.source}</span>
                <span className="text-[14px] font-medium text-text-main truncate flex-1">{article.title}</span>
                <span className="text-[12px] text-text3 shrink-0">{article.time}</span>
                {article.saved && <Check size={14} className="text-accent2 shrink-0" />}
              </div>
            ))}
          </div>

      {showSplitAnim && (
        <SplitAnimationModal 
          article={showSplitAnim} 
          onClose={() => setShowSplitAnim(null)} 
        />
      )}

      {showSrcModal && (
        <SourceModal onClose={() => setShowSrcModal(false)} />
      )}
    </div>
  );
};

const SplitAnimationModal: React.FC<{ article: Article; onClose: () => void }> = ({ article, onClose }) => {
  const { saveArticle, showToast, theme } = useAppContext();
  const [step, setStep] = useState(0);
  const [progress, setProgress] = useState(0);

  React.useEffect(() => {
    let timer: any;
    const runAnimation = async () => {
      await new Promise(r => setTimeout(r, 300));
      setStep(1); setProgress(25);
      await new Promise(r => setTimeout(r, 900));
      setStep(2); setProgress(55);
      await new Promise(r => setTimeout(r, 900));
      setStep(3); setProgress(80);
      await new Promise(r => setTimeout(r, 900));
      setStep(4); setProgress(100);
      await new Promise(r => setTimeout(r, 900));
      setStep(5);
      await saveArticle(article.id);
      await new Promise(r => setTimeout(r, 600));
      onClose();
      showToast(`✦ 已拆分并存入知识库`);
    };
    runAnimation();
    return () => clearTimeout(timer);
  }, []);

  const steps = [
    { id: 1, text: '提取文章核心论点' },
    { id: 2, text: '识别数据与案例' },
    { id: 3, text: '提炼高价值金句' },
    { id: 4, text: '自动打标签 & 归档' },
  ];

  const getStepStatus = (id: number) => {
    if (step > id || step === 5) return 'done';
    if (step === id) return 'active';
    return 'pending';
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-md z-[300] flex items-center justify-center p-4">
      <div className="w-[600px] max-w-[95vw] bg-surface rounded-2xl p-[26px] shadow-2xl">
        <h3 className="font-serif text-[18px] font-bold text-text-main mb-6 flex items-center gap-2">
          <span className="text-accent text-[20px]">✦</span> 
          正在原子化拆分...
        </h3>

        <div className="h-[5px] bg-surface2 rounded-full mb-8 overflow-hidden">
          <div 
            className="h-full bg-accent transition-all duration-600 ease-out rounded-full"
            style={{ width: `${progress}%` }}
          />
        </div>

        <div className="flex flex-col gap-4">
          {steps.map(s => {
            const status = getStepStatus(s.id);
            return (
              <div key={s.id} className="flex flex-col gap-2">
                <div className={cn(
                  "flex items-center gap-3 p-3 rounded-xl transition-colors duration-300",
                  status === 'done' ? "bg-accent2-light text-accent2" :
                  status === 'active' ? "bg-accent-light text-accent" :
                  "bg-surface2 text-text2"
                )}>
                  <div className={cn(
                    "w-6 h-6 rounded-full flex items-center justify-center text-[12px] font-bold transition-colors duration-300",
                    status === 'done' ? "bg-accent2 text-white" :
                    status === 'active' ? "bg-accent text-white" :
                    "bg-border text-text3"
                  )}>
                    {status === 'done' ? <Check size={14} /> : s.id}
                  </div>
                  <span className="font-medium text-[14px]">{s.text}</span>
                </div>

                {status === 'done' && s.id === 1 && article.cards.filter(c => c.type === '观点').map((c, i) => (
                  <MiniCard key={i} card={c} theme={theme} />
                ))}
                {status === 'done' && s.id === 2 && article.cards.filter(c => c.type === '数据' || c.type === '案例').map((c, i) => (
                  <MiniCard key={i} card={c} theme={theme} />
                ))}
                {status === 'done' && s.id === 3 && article.cards.filter(c => c.type === '金句' || c.type === '论据').map((c, i) => (
                  <MiniCard key={i} card={c} theme={theme} />
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

const MiniCard: React.FC<{ card: any, theme: string }> = ({ card, theme }) => {
  const colors: Record<string, string> = {
    '观点': '#805AD5',
    '论据': '#3182CE',
    '数据': '#38A169',
    '金句': '#DD6B20',
    '案例': '#D69E2E',
  };
  
  return (
    <div 
      className="ml-9 p-[9px_12px] rounded-lg bg-surface2 mb-[7px] animate-in slide-in-from-bottom-2 fade-in duration-300"
      style={{ borderLeft: `3px solid ${colors[card.type] || '#2B6CB0'}` }}
    >
      <div className="text-[11px] font-bold mb-1" style={{ color: colors[card.type] }}>{card.type}</div>
      <div className="text-[13px] text-text-main line-clamp-1">{card.content}</div>
    </div>
  );
};

const SourceModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { showToast } = useAppContext();
  const [cat, setCat] = useState('全部');
  const [subs, setSubs] = useState<Record<string, boolean>>({});

  const cats = ['全部', '📱 科技', '💼 商业', '✍️ 创作', '🛠 产品'];
  const sources = [
    { icon: '📰', name: '少数派', url: 'sspai.com', cat: '📱 科技' },
    { icon: '🔬', name: '科技爱好者周刊', url: 'ruanyifeng.com', cat: '📱 科技' },
    { icon: '💼', name: '虎嗅网', url: 'huxiu.com', cat: '💼 商业' },
    { icon: '📈', name: '36氪', url: '36kr.com', cat: '💼 商业' },
    { icon: '✍️', name: '人人都是产品经理', url: 'woshipm.com', cat: '🛠 产品' },
    { icon: '🎯', name: '产品沉思录', url: 'pmthinking.com', cat: '🛠 产品' },
    { icon: '🖊️', name: '新榜', url: 'newrank.cn', cat: '✍️ 创作' },
    { icon: '🌐', name: 'V2EX·技术', url: 'v2ex.com', cat: '📱 科技' },
  ];

  const filtered = cat === '全部' ? sources : sources.filter(s => s.cat === cat);

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

          <div className="flex gap-2 overflow-x-auto pb-1 hide-scrollbar">
            {cats.map(c => (
              <button
                key={c}
                onClick={() => setCat(c)}
                className={cn(
                  "px-3 py-1.5 rounded-lg text-[13px] whitespace-nowrap transition-colors",
                  cat === c ? "bg-text-main text-bg" : "bg-surface2 text-text2 hover:bg-border"
                )}
              >
                {c}
              </button>
            ))}
          </div>

          <div className="flex flex-col gap-2 max-h-[400px] overflow-y-auto pr-1">
            {filtered.map(s => (
              <div key={s.name} className="flex items-center gap-3 p-3 rounded-xl border border-border hover:border-accent-light transition-colors">
                <div className="w-[34px] h-[34px] rounded-full bg-surface2 flex items-center justify-center text-[18px]">
                  {s.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-[14px] text-text-main truncate">{s.name}</div>
                  <div className="text-[12px] text-text3 truncate">{s.url}</div>
                </div>
                <div className="text-[11px] bg-surface2 text-text2 px-2 py-1 rounded-md hidden sm:block">
                  {s.cat.split(' ')[1] || s.cat}
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
