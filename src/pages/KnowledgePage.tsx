import React, { useState } from 'react';
import { useAppContext } from '../context/AppContext';
import { AtomCard } from '../types';
import { CARD_COLORS } from '../constants';
import { cn } from '../components/Nav';
import { Search, Plus } from 'lucide-react';

export const KnowledgePage: React.FC = () => {
  const { savedCards, theme, showToast, articles, setReadingArticle } = useAppContext();

  const handleSourceClick = (e: React.MouseEvent, articleId?: number) => {
    e.stopPropagation();
    if (!articleId) return;
    const article = articles.find(a => a.id === articleId);
    if (article) {
      setReadingArticle(article);
    } else {
      showToast('未找到原文');
    }
  };
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('全部');
  const [editingCard, setEditingCard] = useState<AtomCard | Partial<AtomCard> | null>(null);

  const types = ['全部', '观点', '数据', '金句', '案例', '论据'];

  const filteredCards = savedCards.filter(card => {
    const matchType = typeFilter === '全部' || card.type === typeFilter;
    const matchSearch = search === '' || 
      card.content.toLowerCase().includes(search.toLowerCase()) || 
      card.tags.some(t => t.toLowerCase().includes(search.toLowerCase()));
    return matchType && matchSearch;
  });

  const uniqueArticlesCount = new Set(savedCards.map(c => c.articleTitle)).size;
  const uniqueTagsCount = new Set(savedCards.flatMap(c => c.tags)).size;

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-6 max-w-6xl mx-auto w-full">
      {/* Stats */}
      <div className="flex flex-col md:flex-row gap-3 mb-6">
        <div className="flex-1 bg-surface rounded-xl border border-border p-5 flex flex-col justify-center">
          <div className="font-serif text-[24px] font-bold text-text-main">{savedCards.length}</div>
          <div className="text-[12px] text-text3 mt-1">原子卡片总数</div>
        </div>
        <div className="flex-1 bg-surface rounded-xl border border-border p-5 flex flex-col justify-center">
          <div className="font-serif text-[24px] font-bold text-text-main">{uniqueArticlesCount}</div>
          <div className="text-[12px] text-text3 mt-1">来源文章数</div>
        </div>
        <div className="flex-1 bg-surface rounded-xl border border-border p-5 flex flex-col justify-center">
          <div className="font-serif text-[24px] font-bold text-text-main">{uniqueTagsCount}</div>
          <div className="text-[12px] text-text3 mt-1">话题标签数</div>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex flex-col md:flex-row items-center gap-4 mb-6">
        <div className="w-full md:flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-text3" size={18} />
          <input 
            type="text" 
            placeholder="搜索卡片内容或标签..." 
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full bg-surface border border-border rounded-xl pl-10 pr-4 py-2.5 text-[14px] text-text-main focus:outline-none focus:border-accent transition-colors"
          />
        </div>
        <div className="w-full md:w-auto flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 bg-surface border border-border p-1 rounded-xl overflow-x-auto hide-scrollbar">
            {types.map(t => (
              <button
                key={t}
                onClick={() => setTypeFilter(t)}
                className={cn(
                  "px-3 py-1.5 rounded-lg text-[13px] font-medium transition-colors whitespace-nowrap",
                  typeFilter === t ? "bg-text-main text-bg" : "text-text2 hover:bg-surface2"
                )}
              >
                {t}
              </button>
            ))}
          </div>
          <button 
            onClick={() => setEditingCard({ type: '观点', content: '', tags: [], articleTitle: '手动录入' })}
            className="shrink-0 bg-accent text-white px-4 py-2 rounded-xl text-[13px] font-medium flex items-center gap-2 hover:bg-opacity-90 transition-colors"
          >
            <Plus size={16} /> 新建卡片
          </button>
        </div>
      </div>

      {/* Grid */}
      {filteredCards.length === 0 ? (
        <div className="text-center py-20 text-text3">
          <div className="text-4xl mb-4">🗂️</div>
          <div className="text-[15px]">还没有卡片，去今日推送存入第一篇文章吧</div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
          {filteredCards.map((card, idx) => {
            const colors = CARD_COLORS[card.type] || { main: '#2B6CB0', bg: '#EBF8FF', darkBg: 'rgba(43, 108, 176, 0.15)' };
            const bg = theme === 'dark' ? colors.darkBg : colors.bg;
            return (
              <div 
                key={card.id || idx}
                onClick={() => setEditingCard(card)}
                className="rounded-xl p-[15px_16px] flex flex-col cursor-pointer hover:shadow-md transition-all duration-200 hover:-translate-y-1"
                style={{ 
                  backgroundColor: bg,
                  borderLeft: `3px solid ${colors.main}`
                }}
              >
                <div className="text-[11px] font-bold" style={{ color: colors.main }}>
                  {card.type}
                </div>
                <div className="text-[13px] text-text-main leading-[1.7] my-2 flex-1">
                  {card.content}
                </div>
                <div className="flex flex-wrap items-center gap-2 mt-2">
                  {card.tags.map(t => (
                    <span key={t} className="bg-surface/60 text-text2 text-[11px] px-2 py-0.5 rounded-md">
                      #{t}
                    </span>
                  ))}
                  <div className="ml-auto flex items-center gap-1">
                    {card.articleId && (
                      <span className="text-[11px] text-accent hover:underline cursor-pointer flex items-center gap-0.5" onClick={(e) => handleSourceClick(e, card.articleId)}>
                        🔗 来源
                      </span>
                    )}
                    <span className="text-[11px] text-text3 truncate max-w-[120px]" title={card.articleTitle}>
                      {card.articleTitle}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editingCard && (
        <EditModal card={editingCard} onClose={() => setEditingCard(null)} />
      )}
    </div>
  );
};

const EditModal = ({ card, onClose }: { card: Partial<AtomCard>, onClose: () => void }) => {
  const { updateCard, addCard, deleteCard, showToast } = useAppContext();
  const [formData, setFormData] = useState(card);
  const isNew = !card.id;

  const handleSave = () => {
    if (!formData.content) return showToast('内容不能为空');
    if (isNew) {
      addCard({ ...formData, id: Math.random().toString(36).substr(2, 9), articleTitle: formData.articleTitle || '手动录入' } as AtomCard);
      showToast('✓ 卡片已创建');
    } else {
      updateCard(card.id!, formData);
      showToast('✓ 卡片已更新');
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[200] flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-[500px] max-w-[95vw] bg-surface rounded-2xl p-6 shadow-xl" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-bold text-text-main mb-4">{isNew ? '新建卡片' : '编辑卡片'}</h2>
        
        <div className="space-y-4">
          <div>
            <label className="block text-xs text-text3 mb-1">类型</label>
            <select 
              value={formData.type} 
              onChange={e => setFormData({...formData, type: e.target.value as any})}
              className="w-full bg-surface border border-border rounded-lg p-2 text-sm text-text-main focus:border-accent outline-none"
            >
              {['观点', '数据', '金句', '案例', '论据'].map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          
          <div>
            <label className="block text-xs text-text3 mb-1">内容</label>
            <textarea 
              value={formData.content}
              onChange={e => setFormData({...formData, content: e.target.value})}
              className="w-full h-24 bg-surface border border-border rounded-lg p-2 text-sm text-text-main focus:border-accent outline-none resize-none"
            />
          </div>

          <div>
            <label className="block text-xs text-text3 mb-1">标签 (用逗号分隔)</label>
            <input 
              type="text"
              value={formData.tags?.join(', ')}
              onChange={e => setFormData({...formData, tags: e.target.value.split(',').map(t => t.trim()).filter(Boolean)})}
              className="w-full bg-surface border border-border rounded-lg p-2 text-sm text-text-main focus:border-accent outline-none"
            />
          </div>
        </div>

        <div className="flex justify-between items-center mt-6">
          {!isNew ? (
            <button onClick={() => { deleteCard(card.id!); onClose(); showToast('已删除卡片'); }} className="text-red-500 text-sm hover:underline">删除卡片</button>
          ) : <div></div>}
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-text2 hover:bg-surface2">取消</button>
            <button onClick={handleSave} className="px-4 py-2 rounded-lg text-sm bg-accent text-white hover:bg-opacity-90">保存</button>
          </div>
        </div>
      </div>
    </div>
  );
};
