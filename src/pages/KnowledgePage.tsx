import React, { useCallback, useMemo, useState } from 'react';
import { useAppContext } from '../context/AppContext';
import { Article, AtomCard, SavedArticle } from '../types';
import { CARD_COLORS } from '../constants';
import { Search, Plus, ExternalLink } from 'lucide-react';
import { InspirationButton } from '../components/InspirationButton';
import { findLinkedArticle, getCardSourceLabel } from '../utils/articleDisplay';

export const KnowledgePage: React.FC = () => {
  const { savedCards, savedArticles, showToast, articles, setReadingArticle, knowledgeTypeFilter, knowledgeSourceFilter, setActiveSource } = useAppContext();

  /** 从数据库加载已保存文章的全文并打开阅读面板 */
  const openSavedArticle = useCallback(async (sa: SavedArticle) => {
    // 优先从内存中找到 live article（RSS缓存还在时）
    const liveArticle = articles.find(a => (a.url && sa.url && a.url === sa.url) || a.title === sa.title);
    if (liveArticle) {
      setActiveSource(liveArticle.source || null);
      setReadingArticle(liveArticle);
      return;
    }
    // 内存中没有 → 从数据库获取全文
    try {
      const res = await fetch(`/api/saved-articles/${sa.id}`);
      if (!res.ok) {
        showToast('加载原文失败');
        return;
      }
      const data = await res.json();
      // 构造为 Article 格式供阅读面板使用
      const article: Article = {
        id: -(sa.id), // 负数ID避免与RSS文章冲突
        saved: true,
        source: data.source || sa.source,
        sourceIcon: data.sourceIcon || sa.sourceIcon,
        topic: data.topic || sa.topic,
        time: sa.savedAt ? new Date(sa.savedAt).toLocaleDateString('zh-CN') : '',
        publishedAt: data.publishedAt || sa.publishedAt,
        title: data.title || sa.title,
        excerpt: data.excerpt || sa.excerpt,
        content: data.content || sa.excerpt,
        markdownContent: data.content || undefined,
        url: data.url || sa.url,
        fullFetched: true,
        cards: [],
      };
      setActiveSource(article.source || null);
      setReadingArticle(article);
    } catch {
      showToast('网络错误，无法加载原文');
    }
  }, [articles, setActiveSource, setReadingArticle, showToast]);

  const handleSourceClick = (e: React.MouseEvent, articleId?: number) => {
    e.stopPropagation();
    if (!articleId) return;
    const article = articles.find(a => a.id === articleId);
    if (article) {
      setActiveSource(article.source || null);
      setReadingArticle(article);
    } else {
      showToast('未找到原文');
    }
  };
  const [search, setSearch] = useState('');
  const [editingCard, setEditingCard] = useState<AtomCard | Partial<AtomCard> | null>(null);

  // 来源 view now uses persisted savedArticles (survives server restart)
  const filteredSourceArticles = useMemo(() => {
    return savedArticles.filter(sa => {
      const keyword = search.trim().toLowerCase();
      const matchSearch = keyword === ''
        || sa.title.toLowerCase().includes(keyword)
        || sa.excerpt.toLowerCase().includes(keyword)
        || sa.topic.toLowerCase().includes(keyword)
        || sa.source.toLowerCase().includes(keyword);
      const matchSource = knowledgeSourceFilter === '全部'
        || knowledgeSourceFilter === `article:${sa.id}`;
      return matchSearch && matchSource;
    });
  }, [savedArticles, knowledgeSourceFilter, search]);

  const filteredCards = savedCards.filter(card => {
    const sourceLabel = getCardSourceLabel(card, articles);
    const matchType = knowledgeTypeFilter === '来源' || card.type === knowledgeTypeFilter;
    const matchSource = knowledgeSourceFilter === '全部'
      || (knowledgeSourceFilter.startsWith('article:') && card.articleId === Number(knowledgeSourceFilter.replace('article:', '')))
      || sourceLabel === knowledgeSourceFilter;
    const matchSearch = search === '' || 
      card.content.toLowerCase().includes(search.toLowerCase()) || 
      card.tags.some(t => t.toLowerCase().includes(search.toLowerCase()));
    return matchType && matchSource && matchSearch;
  });

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-6 max-w-6xl mx-auto w-full">
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
          <button 
            onClick={() => setEditingCard({ type: '观点', content: '', tags: [], articleTitle: '手动录入' })}
            className="shrink-0 bg-accent text-white px-4 py-2 rounded-xl text-[13px] font-medium flex items-center gap-2 hover:bg-opacity-90 transition-colors"
          >
            <Plus size={16} /> 新建卡片
          </button>
        </div>
      </div>

      {knowledgeTypeFilter === '来源' ? (
        filteredSourceArticles.length === 0 ? (
          <div className="text-center py-20 text-text3">
            <div className="text-4xl mb-4">🗂️</div>
            <div className="text-[15px]">还没有已存入知识库的原文</div>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {filteredSourceArticles.map(sa => {
              return (
              <div
                key={sa.id}
                onClick={() => openSavedArticle(sa)}
                className="bg-surface rounded-xl border border-border hover:border-accent hover:shadow-[0_1px_4px_rgba(0,0,0,0.07),0_4px_16px_rgba(0,0,0,0.05)] p-[18px_20px] transition-all duration-150 cursor-pointer"
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="bg-accent-light text-accent text-[11.5px] font-semibold px-2 py-0.5 rounded">
                      {sa.source}
                    </span>
                    <span className="bg-surface2 text-text2 text-[11px] px-[7px] py-0.5 rounded">
                      {sa.topic}
                    </span>
                    {sa.savedAt && (
                      <span className="text-[12px] text-text3 ml-1">{new Date(sa.savedAt).toLocaleDateString('zh-CN')}</span>
                    )}
                  </div>
                </div>
                <h2 className="font-serif text-[15.5px] font-semibold text-text-main mb-1.5 leading-snug">
                  {sa.title}
                </h2>
                <p className="text-[13px] text-text2 leading-[1.7] line-clamp-2">
                  {sa.excerpt}
                </p>
                <div className="mt-3 flex gap-2" onClick={e => e.stopPropagation()}>
                  <InspirationButton
                    articleTitle={sa.title}
                    savedArticleId={sa.id}
                  />
                  {sa.url && (
                    <a
                      href={sa.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-3 py-1.5 rounded-lg text-[13px] font-medium bg-accent-light text-accent hover:bg-accent hover:text-white transition-colors flex items-center gap-1"
                    >
                      原文链接
                      <ExternalLink size={12} />
                    </a>
                  )}
                </div>
              </div>
              );
            })}
          </div>
        )
      ) : filteredCards.length === 0 ? (
        <div className="text-center py-20 text-text3">
          <div className="text-4xl mb-4">🗂️</div>
          <div className="text-[15px]">还没有卡片，去今日推送存入第一篇文章吧</div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {filteredCards.map((card, idx) => {
            const colors = CARD_COLORS[card.type] || { main: '#2B6CB0', bg: '#EBF8FF', darkBg: 'rgba(43, 108, 176, 0.15)' };
            const linkedArticle = findLinkedArticle(card as AtomCard, articles);
            const isQuote = card.type === '金句';
            const isData = card.type === '数据';
            return (
              <div
                key={card.id || idx}
                onClick={() => setEditingCard(card)}
                className="flex bg-surface rounded-xl overflow-hidden cursor-pointer transition-all duration-200 hover:shadow-[0_4px_16px_rgba(0,0,0,0.07)] border border-border"
              >
                {/* 内容区 */}
                <div className="flex-1 flex items-start gap-3 px-4 py-3 min-w-0">
                  {/* 圆点 + 类型 */}
                  <div className="shrink-0 flex items-center gap-1.5 mt-0.5">
                    <span className="w-2 h-2 rounded-full" style={{ background: colors.main }} />
                    <span className="text-[11px] text-text3 font-medium">{card.type}</span>
                  </div>
                  {/* 主内容 */}
                  <div className="flex-1 min-w-0">
                    {isData && (() => {
                      const numMatch = card.content.match(/[\d,.]+\s*[%亿万美元份个年月天]+/);
                      return numMatch ? (
                        <span className="text-[18px] font-bold mr-2" style={{ color: colors.main }}>
                          {numMatch[0]}
                        </span>
                      ) : null;
                    })()}
                    <div className={`text-text-main leading-[1.7] line-clamp-2 ${isQuote ? 'font-serif text-[15px] font-semibold' : 'text-[13.5px]'}`}>
                      {card.content}
                    </div>
                  </div>
                  {/* 右侧标签 + 来源 */}
                  <div className="shrink-0 flex flex-col items-end gap-1.5 ml-2">
                    <div className="flex flex-wrap justify-end gap-1">
                      {card.tags.slice(0, 3).map(t => (
                        <span
                          key={t}
                          className="text-[10px] text-white/90 px-1.5 py-0.5 rounded-full"
                          style={{ background: colors.main, opacity: 0.7 }}
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                    {(linkedArticle || card.articleTitle) && (
                      <div className="text-[10px] text-text3 max-w-[120px] truncate">
                        {linkedArticle?.title || card.articleTitle}
                      </div>
                    )}
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
              {['观点', '数据', '金句', '故事', '灵感'].map(t => <option key={t} value={t}>{t}</option>)}
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
