import React, { useState, useEffect, useRef } from 'react';
import { useAppContext } from '../context/AppContext';
import { AtomCard } from '../types';
import { CARD_COLORS } from '../constants';
import { cn } from '../components/Nav';
import { Check, Plus, X, Copy, Download, Sparkles } from 'lucide-react';

export const WritePage: React.FC = () => {
  const { savedCards, showToast, theme } = useAppContext();
  const [topic, setTopic] = useState('');
  const [canvasCards, setCanvasCards] = useState<AtomCard[]>([]);
  const [dragCard, setDragCard] = useState<AtomCard | null>(null);
  
  // Recall State
  const [isRecalling, setIsRecalling] = useState(false);
  const [hasRecalled, setHasRecalled] = useState(false);
  const [recalledCards, setRecalledCards] = useState<AtomCard[]>([]);
  
  // Generation State
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedHtml, setGeneratedHtml] = useState<string | null>(null);
  const [step, setStep] = useState(1);

  const canvasRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (generatedHtml) {
      setStep(4);
    } else if (canvasCards.length > 0) {
      setStep(3);
    } else if (hasRecalled) {
      setStep(2);
    } else {
      setStep(1);
    }
  }, [hasRecalled, canvasCards, generatedHtml]);

  const handleRecall = async () => {
    if (!topic.trim()) return;
    
    setIsRecalling(true);
    setHasRecalled(false);
    setRecalledCards([]);

    // Simulate AI/Network delay
    await new Promise(r => setTimeout(r, 1500));

    const keywords = topic.split(/[\s,、]+/).filter(Boolean);
    let matched = savedCards;

    if (keywords.length > 0) {
      matched = savedCards.filter(c => {
        const text = `${c.content} ${c.tags.join(' ')} ${c.articleTitle}`.toLowerCase();
        return keywords.some(k => text.includes(k.toLowerCase()));
      });
    }

    // Fallback to all cards if less than 2 matched (as per original PRD logic)
    if (keywords.length > 0 && matched.length < 2) {
      matched = savedCards;
    }

    setRecalledCards(matched);
    setHasRecalled(true);
    setIsRecalling(false);
  };

  const handleAddCanvas = (card: AtomCard) => {
    if (!canvasCards.find(c => c.id === card.id)) {
      setCanvasCards(prev => [...prev, card]);
    }
  };

  const handleAddAll = () => {
    const newCards = recalledCards.filter(c => !canvasCards.find(cc => cc.id === c.id));
    if (newCards.length > 0) {
      setCanvasCards(prev => [...prev, ...newCards]);
      showToast(`✦ 已一键加入 ${newCards.length} 张卡片`);
    } else {
      showToast(`✦ 所有卡片已在画布中`);
    }
  };

  const handleRemoveCanvas = (id: string) => {
    setCanvasCards(prev => prev.filter(c => c.id !== id));
  };

  const handleDragStart = (e: React.DragEvent, card: AtomCard) => {
    setDragCard(card);
    e.dataTransfer.effectAllowed = 'copy';
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (canvasRef.current) {
      canvasRef.current.classList.add('border-accent', 'bg-accent-light');
    }
  };

  const handleDragLeave = () => {
    if (canvasRef.current) {
      canvasRef.current.classList.remove('border-accent', 'bg-accent-light');
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    handleDragLeave();
    if (dragCard) {
      handleAddCanvas(dragCard);
      setDragCard(null);
    }
  };

  const handleGenerate = async () => {
    setIsGenerating(true);
    setGeneratedHtml(null);
    
    await new Promise(r => setTimeout(r, 2800));
    
    const html = `
      <p>在探讨“${topic}”这个话题时，我们首先需要理解其背后的深层逻辑。</p>
      ${canvasCards.some(c => c.type === '观点') ? `<h3>问题的根源</h3><p>${canvasCards.filter(c => c.type === '观点').map(c => c.content).join(' ')}</p>` : ''}
      ${canvasCards.some(c => c.type === '数据') ? `<h3>数据说明了什么</h3><p>${canvasCards.filter(c => c.type === '数据').map(c => c.content).join(' ')}</p>` : ''}
      ${canvasCards.some(c => c.type === '案例') ? `<h3>可以参考的路径</h3><p>${canvasCards.filter(c => c.type === '案例').map(c => c.content).join(' ')}</p>` : ''}
      ${canvasCards.some(c => c.type === '论据') ? `<h3>为什么这条路是对的</h3><p>${canvasCards.filter(c => c.type === '论据').map(c => c.content).join(' ')}</p>` : ''}
      ${canvasCards.some(c => c.type === '金句') ? `<h3>最后想说的</h3><p>正如那句话所说：${canvasCards.filter(c => c.type === '金句').map(c => c.content).join(' ')}</p>` : ''}
      <p>综上所述，解决“${topic}”的关键在于将理论与实践相结合，持续迭代。</p>
    `;
    
    setGeneratedHtml(html);
    setIsGenerating(false);
    showToast('✦ 文章已生成，可复制或导出');
  };

  const handleCopy = () => {
    if (generatedHtml) {
      const temp = document.createElement('div');
      temp.innerHTML = generatedHtml;
      navigator.clipboard.writeText(temp.innerText);
      showToast('✓ 已复制全文到剪贴板');
    }
  };

  const handleExport = () => {
    if (generatedHtml) {
      let md = generatedHtml
        .replace(/<h3>(.*?)<\/h3>/g, '\n### $1\n\n')
        .replace(/<p>(.*?)<\/p>/g, '$1\n\n');
      
      const blob = new Blob([md], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${topic || '文章'}.md`;
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  const getStepStatus = (id: number) => {
    if (step > id || (id === 4 && generatedHtml)) return 'done';
    if (step === id) return 'active';
    return 'pending';
  };

  return (
    <div id="page-write" className="flex flex-col h-[calc(100vh-56px)] overflow-hidden p-4 md:p-[22px_32px_0]">
      {/* Header */}
      <div className="shrink-0 mb-2.5">
        <h1 className="font-serif text-[22px] font-bold text-text-main">魔法写作</h1>
      </div>

      {/* Workflow Bar */}
      <div className="shrink-0 mb-3.5 flex items-center gap-2 overflow-x-auto hide-scrollbar pb-1">
        {[
          { id: 1, text: 'Step 1 · 写作主题' },
          { id: 2, text: 'Step 2 · 卡片召回' },
          { id: 3, text: 'Step 3 · 写作画布' },
          { id: 4, text: 'Step 4 · AI 生成文章' }
        ].map((s, i) => {
          const status = getStepStatus(s.id);
          return (
            <React.Fragment key={s.id}>
              <div className={cn(
                "px-4 py-2 rounded-full text-[13px] font-medium border-[1.5px] whitespace-nowrap transition-colors",
                status === 'done' ? "bg-accent2-light text-accent2 border-accent2" :
                status === 'active' ? "bg-accent-light text-accent border-accent" :
                "bg-surface text-text3 border-border"
              )}>
                {s.text}
              </div>
              {i < 3 && <div className="text-border">→</div>}
            </React.Fragment>
          );
        })}
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 flex flex-col md:grid md:grid-cols-[290px_1fr] gap-4 pb-6 overflow-y-auto md:overflow-hidden">
        
        {/* Left Column */}
        <div className="flex flex-col gap-3 min-h-[400px] md:min-h-0 md:h-full">
          {/* Topic Panel */}
          <div className="bg-surface rounded-xl border border-border p-4 shrink-0">
            <div className="flex items-center justify-between mb-2">
              <div className="text-[13px] font-bold text-text-main">Step 1 · 写作主题</div>
              <button
                onClick={handleRecall}
                disabled={!topic.trim() || isRecalling}
                className="px-3 py-1 rounded-lg bg-accent text-white text-[12px] font-medium hover:bg-opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5 shrink-0"
              >
                {isRecalling ? (
                  <>
                    <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    召回中
                  </>
                ) : (
                  <>
                    <Sparkles size={14} /> 智能召回
                  </>
                )}
              </button>
            </div>
            <textarea
              value={topic}
              onChange={e => {
                setTopic(e.target.value);
                setHasRecalled(false); // Reset recall state when topic changes
              }}
              placeholder="输入你想写的主题，例如：内容创作者如何摆脱 AI 腔..."
              className="w-full h-[80px] border-[1.5px] border-border rounded-lg p-2.5 text-[13px] text-text-main bg-surface resize-none focus:outline-none focus:border-accent transition-colors mb-2"
            />
            <div className="flex flex-wrap gap-1.5">
              {['收藏夹焦虑', '摆脱 AI 腔', '创作者变现'].map(t => (
                <button
                  key={t}
                  onClick={() => {
                    setTopic(t);
                    setHasRecalled(false);
                  }}
                  className="px-2.5 py-1 rounded-full bg-surface2 text-text2 text-[11px] hover:bg-accent-light hover:text-accent transition-colors"
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {/* Card Pool Panel */}
          <div className="bg-surface rounded-xl border border-border p-4 flex-1 min-h-[300px] md:min-h-0 flex flex-col overflow-hidden">
            <div className="flex items-center justify-between mb-3 shrink-0">
              <div className="text-[13px] font-bold text-text-main">Step 2 · 卡片召回</div>
              {hasRecalled && recalledCards.length > 0 && (
                <button onClick={handleAddAll} className="text-[12px] text-accent hover:underline font-medium">
                  一键全部加入
                </button>
              )}
            </div>
            
            {hasRecalled && recalledCards.length > 0 && (
              <div className="bg-accent-light text-accent text-[12px] p-2 rounded-lg mb-3 shrink-0 flex items-center gap-1.5 animate-in fade-in duration-300">
                <span>✦</span> 已根据主题召回相关卡片
              </div>
            )}

            <div className="flex-1 overflow-y-auto min-h-0 flex flex-col gap-2 pr-1 hide-scrollbar">
              {!hasRecalled && !isRecalling && (
                <div className="h-full flex flex-col items-center justify-center text-text3 text-[13px] gap-3">
                  <div className="w-12 h-12 rounded-full bg-surface2 flex items-center justify-center text-xl">✨</div>
                  <p>输入主题并点击「智能召回」</p>
                </div>
              )}

              {isRecalling && (
                <div className="h-full flex flex-col items-center justify-center text-accent text-[13px] gap-3">
                  <div className="flex gap-1.5">
                    <div className="w-2 h-2 rounded-full bg-accent animate-bounce" style={{ animationDelay: '0ms' }} />
                    <div className="w-2 h-2 rounded-full bg-accent animate-bounce" style={{ animationDelay: '150ms' }} />
                    <div className="w-2 h-2 rounded-full bg-accent animate-bounce" style={{ animationDelay: '300ms' }} />
                  </div>
                  <p>AI 正在知识库中检索关联卡片...</p>
                </div>
              )}

              {hasRecalled && recalledCards.length === 0 && (
                <div className="text-center py-10 text-text3 text-[13px] animate-in fade-in">
                  没有找到匹配的卡片
                </div>
              )}

              {hasRecalled && recalledCards.map((card, index) => {
                const isUsed = canvasCards.some(c => c.id === card.id);
                const colors = CARD_COLORS[card.type] || { main: '#2B6CB0', bg: '#FAFAF8', darkBg: 'rgba(43, 108, 176, 0.15)' };
                const bg = theme === 'dark' ? colors.darkBg : colors.bg;
                return (
                  <div
                    key={card.id}
                    draggable={!isUsed}
                    onDragStart={(e) => handleDragStart(e, card)}
                    tabIndex={isUsed ? -1 : 0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !isUsed) {
                        e.preventDefault();
                        handleAddCanvas(card);
                      }
                    }}
                    className={cn(
                      "group p-[9px_11px] rounded-lg cursor-grab relative select-none shrink-0 transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-accent",
                      isUsed ? "opacity-30 pointer-events-none" : "hover:translate-x-[3px]",
                      "animate-in slide-in-from-right-8 fade-in fill-mode-backwards"
                    )}
                    style={{ 
                      backgroundColor: bg,
                      borderLeft: `3px solid ${colors.main}`,
                      animationDuration: '500ms',
                      animationDelay: `${index * 100}ms`
                    }}
                  >
                    <div className="text-[11px] font-bold mb-1" style={{ color: colors.main }}>{card.type}</div>
                    <div className="text-[12px] text-text-main line-clamp-2 leading-relaxed">{card.content}</div>
                    
                    {!isUsed && (
                      <button
                        onClick={() => handleAddCanvas(card)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 w-[22px] h-[22px] rounded-full bg-accent text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-sm"
                      >
                        <Plus size={14} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Right Column */}
        <div className="flex flex-col md:grid md:grid-rows-[1fr_50px_1fr] gap-3 min-h-[600px] md:min-h-0 md:h-full">
          
          {/* Canvas */}
          <div 
            ref={canvasRef}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className="border-2 border-dashed border-border rounded-xl bg-surface p-4 flex flex-col overflow-y-auto min-h-[250px] md:min-h-0 transition-colors"
          >
            <div className="flex items-center justify-between mb-4 shrink-0">
              <div className="text-[14px] font-bold text-text-main">Step 3 · 写作画布</div>
              {canvasCards.length > 0 && (
                <button 
                  onClick={() => { setCanvasCards([]); setGeneratedHtml(null); }}
                  className="text-[12px] text-text3 hover:text-red-500 transition-colors"
                >
                  清空
                </button>
              )}
            </div>

            {canvasCards.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center text-text3">
                <div className="w-12 h-12 rounded-xl bg-surface2 flex items-center justify-center mb-3">
                  <Plus className="text-text3" />
                </div>
                <div className="text-[14px] font-medium">拖拽、点击或按 Enter 添加到画布</div>
                <div className="text-[12px] mt-1">支持自由组合与排序</div>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {canvasCards.map(card => {
                  const colors = CARD_COLORS[card.type] || { main: '#2B6CB0', bg: '#F0EDE6', darkBg: 'rgba(43, 108, 176, 0.15)' };
                  const bg = theme === 'dark' ? colors.darkBg : colors.bg;
                  return (
                    <div 
                      key={card.id}
                      className="flex items-start gap-2.5 p-[10px_12px] rounded-lg animate-in slide-in-from-left-2 duration-200"
                      style={{ backgroundColor: bg, borderLeft: `3px solid ${colors.main}` }}
                    >
                      <div className="text-[10.5px] font-bold shrink-0 mt-0.5" style={{ color: colors.main }}>
                        {card.type}
                      </div>
                      <div className="flex-1 text-[13px] text-text-main leading-[1.6]">
                        {card.content}
                      </div>
                      <button 
                        onClick={() => handleRemoveCanvas(card.id)}
                        className="shrink-0 text-text3 hover:text-red-500 transition-colors"
                      >
                        <X size={16} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Generate Button Row */}
          <div className="flex items-center gap-3 h-[50px] shrink-0">
            <button
              disabled={!topic || canvasCards.length === 0 || isGenerating}
              onClick={handleGenerate}
              className="flex-1 h-full rounded-xl bg-gradient-to-br from-[#2B6CB0] to-[#553C9A] text-white font-semibold text-[15px] transition-all duration-180 hover:not-disabled:-translate-y-[1px] hover:not-disabled:shadow-[0_6px_20px_rgba(43,108,176,0.35)] disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              <span>✦</span> AI 生成文章
            </button>
            <div className="w-[180px] text-[12px] text-text3 shrink-0 hidden md:block">
              {!topic ? '请先填写写作主题' :
               canvasCards.length === 0 ? '请添加至少 1 张卡片' :
               `已选 ${canvasCards.length} 张卡片，点击生成`}
            </div>
          </div>

          {/* Output Box */}
          <div className="border border-border rounded-xl bg-surface flex flex-col min-h-[300px] md:min-h-0 overflow-hidden">
            <div className="shrink-0 p-[12px_16px] border-b border-border bg-bg flex items-center justify-between">
              <div className="text-[13px] font-bold text-text-main">Step 4 · 生成结果</div>
              <div className="flex items-center gap-2">
                <button 
                  disabled={!generatedHtml}
                  onClick={handleCopy}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium text-text2 hover:bg-border disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <Copy size={14} /> <span className="hidden md:inline">复制全文</span>
                </button>
                <button 
                  disabled={!generatedHtml}
                  onClick={handleExport}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium text-text2 hover:bg-border disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <Download size={14} /> <span className="hidden md:inline">导出 Markdown</span>
                </button>
              </div>
            </div>
            
            <div className="flex-1 overflow-y-auto p-[14px_16px] relative">
              {isGenerating ? (
                <div className="absolute inset-0 bg-gradient-to-br from-accent-light to-bg flex flex-col items-center justify-center">
                  <div className="flex items-center gap-2 mb-4">
                    <div className="w-1.5 h-1.5 rounded-full bg-accent animate-[pulse_1.2s_infinite]" />
                    <div className="w-1.5 h-1.5 rounded-full bg-accent animate-[pulse_1.2s_infinite_0.2s]" />
                    <div className="w-1.5 h-1.5 rounded-full bg-accent animate-[pulse_1.2s_infinite_0.4s]" />
                  </div>
                  <div className="text-[13px] font-medium text-accent">AI 正在组装你的文章...</div>
                </div>
              ) : generatedHtml ? (
                <div 
                  className="font-serif text-[14px] leading-[1.9] text-text-main prose prose-p:mb-[13px] prose-h3:text-[16px] prose-h3:font-bold prose-h3:mt-6 prose-h3:mb-3"
                  dangerouslySetInnerHTML={{ __html: generatedHtml }}
                />
              ) : (
                <div className="h-full flex items-center justify-center text-text3 text-[13px]">
                  等待生成...
                </div>
              )}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
};
