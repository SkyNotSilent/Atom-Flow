import React, { useMemo, useState } from 'react';
import {
  Bot,
  FileText,
  ImagePlus,
  Layers3,
  MessageSquareText,
  Search,
  StickyNote,
  Upload,
  X,
} from 'lucide-react';
import type { AtomCard, Note, SavedArticle, WriteAgentTemplate } from '../../types';

type AddFilter = 'all' | 'cards' | 'articles' | 'notes' | 'agents';

type CanvasAddDrawerProps = {
  contextAgentTitle?: string | null;
  cards: AtomCard[];
  articles: SavedArticle[];
  notes: Note[];
  templates: WriteAgentTemplate[];
  query: string;
  pasteText: string;
  onQueryChange: (value: string) => void;
  onPasteTextChange: (value: string) => void;
  onClose: () => void;
  onUpload: (file: File) => void;
  onAddPaste: () => void;
  onAddAgent: (template?: WriteAgentTemplate) => void;
  onAddCard: (card: AtomCard) => void;
  onAddArticle: (article: SavedArticle) => void;
  onAddNote: (note: Note) => void;
};

const filters: Array<{ id: AddFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'cards', label: '原子卡' },
  { id: 'articles', label: '文章' },
  { id: 'notes', label: 'Notes' },
  { id: 'agents', label: 'Agent' },
];

const matchesQuery = (value: string, query: string) => !query || value.toLowerCase().includes(query.toLowerCase());

export const CanvasAddDrawer: React.FC<CanvasAddDrawerProps> = ({
  contextAgentTitle,
  cards,
  articles,
  notes,
  templates,
  query,
  pasteText,
  onQueryChange,
  onPasteTextChange,
  onClose,
  onUpload,
  onAddPaste,
  onAddAgent,
  onAddCard,
  onAddArticle,
  onAddNote,
}) => {
  const [filter, setFilter] = useState<AddFilter>('all');
  const contextMode = Boolean(contextAgentTitle);
  const visibleCards = useMemo(
    () => cards.filter(card => matchesQuery(`${card.type} ${card.content} ${card.articleTitle} ${(card.tags || []).join(' ')}`, query)).slice(0, 16),
    [cards, query]
  );
  const visibleArticles = useMemo(
    () => articles.filter(article => matchesQuery(`${article.title} ${article.source} ${article.excerpt}`, query)).slice(0, 14),
    [articles, query]
  );
  const visibleNotes = useMemo(
    () => notes.filter(note => matchesQuery(`${note.title} ${note.tags.join(' ')}`, query)).slice(0, 12),
    [notes, query]
  );
  const visibleTemplates = useMemo(
    () => templates.filter(template => matchesQuery(`${template.name} ${template.model}`, query)).slice(0, 10),
    [query, templates]
  );

  return (
    <aside
      data-testid="canvas-add-drawer"
      onPointerDown={event => event.stopPropagation()}
      className="absolute inset-0 z-[80] flex w-full flex-col overflow-hidden border-0 bg-[#FCFCFA]/98 shadow-[0_24px_72px_rgba(29,32,38,0.18)] backdrop-blur md:inset-y-4 md:left-4 md:right-auto md:w-[360px] md:rounded-[8px] md:border md:border-[#D8D7D2]"
    >
      <header className="flex items-start gap-3 border-b border-[#E7E6E1] px-4 py-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[6px] bg-[#1F6FEB] text-white">
          <Layers3 size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[14px] font-semibold text-[#20242A]">添加节点</h2>
          <p className="mt-0.5 truncate text-[11px] text-[#777B82]">
            {contextAgentTitle ? `添加后连接到 ${contextAgentTitle}` : '创建资料、调用知识资产或添加 Agent'}
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="关闭添加节点" className="flex h-8 w-8 items-center justify-center rounded-[6px] text-[#777B82] hover:bg-[#EEEDE9] hover:text-[#20242A]">
          <X size={16} />
        </button>
      </header>

      <div className="border-b border-[#E7E6E1] p-4">
        <div className="grid grid-cols-3 gap-2">
          <label className="flex min-h-[64px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-[7px] border border-[#DCDAD4] bg-white text-[11px] font-medium text-[#34383E] hover:border-[#8FB5F2] hover:bg-[#F4F8FF]">
            <Upload size={17} className="text-[#1F6FEB]" />
            上传资料
            <input
              type="file"
              className="hidden"
              accept=".pdf,.docx,.txt,.md,image/*"
              onChange={event => {
                const file = event.target.files?.[0];
                if (file) onUpload(file);
                event.currentTarget.value = '';
              }}
            />
          </label>
          {contextMode ? (
            <button type="button" onClick={() => setFilter('cards')} className="flex min-h-[64px] flex-col items-center justify-center gap-1.5 rounded-[7px] border border-[#DCDAD4] bg-white text-[11px] font-medium text-[#34383E] hover:border-[#8FB5F2] hover:bg-[#F4F8FF]">
              <Layers3 size={17} className="text-[#1F6FEB]" />
              原子卡
            </button>
          ) : (
            <button type="button" onClick={() => onAddAgent()} className="flex min-h-[64px] flex-col items-center justify-center gap-1.5 rounded-[7px] border border-[#DCDAD4] bg-white text-[11px] font-medium text-[#34383E] hover:border-[#8FB5F2] hover:bg-[#F4F8FF]">
              <Bot size={17} className="text-[#1F6FEB]" />
              空白 Agent
            </button>
          )}
          <button type="button" onClick={() => setFilter('notes')} className="flex min-h-[64px] flex-col items-center justify-center gap-1.5 rounded-[7px] border border-[#DCDAD4] bg-white text-[11px] font-medium text-[#34383E] hover:border-[#8FB5F2] hover:bg-[#F4F8FF]">
            <StickyNote size={17} className="text-[#1F6FEB]" />
            我的 Notes
          </button>
        </div>

        <div className="mt-3 rounded-[7px] border border-[#DCDAD4] bg-white p-2">
          <textarea
            value={pasteText}
            onChange={event => onPasteTextChange(event.target.value)}
            className="h-16 w-full resize-none bg-transparent px-1 text-[12px] leading-5 text-[#34383E] outline-none placeholder:text-[#A4A7AC]"
            placeholder="粘贴文本、截图文字或临时灵感…"
          />
          <div className="flex justify-end border-t border-[#EFEDE8] pt-2">
            <button type="button" onClick={onAddPaste} disabled={!pasteText.trim()} className="inline-flex items-center gap-1.5 rounded-[6px] bg-[#20242A] px-3 py-1.5 text-[11px] font-medium text-white disabled:opacity-40">
              <MessageSquareText size={13} /> 放到画布
            </button>
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col p-4">
        <div className="flex items-center gap-2 rounded-[7px] border border-[#DCDAD4] bg-white px-3 py-2.5 focus-within:border-[#7AA7ED] focus-within:ring-2 focus-within:ring-[#DCEAFF]">
          <Search size={14} className="text-[#8A8E95]" />
          <input value={query} onChange={event => onQueryChange(event.target.value)} placeholder="搜索知识资产或 Agent 模板" className="min-w-0 flex-1 bg-transparent text-[12px] text-[#20242A] outline-none" />
        </div>

        <div className="mt-3 flex gap-1 overflow-x-auto" aria-label="节点类型筛选">
          {filters.filter(item => !contextMode || item.id !== 'agents').map(item => (
            <button
              key={item.id}
              type="button"
              onClick={() => setFilter(item.id)}
              className={`shrink-0 rounded-[5px] px-2.5 py-1.5 text-[11px] ${filter === item.id ? 'bg-[#E7F0FF] font-medium text-[#185ABD]' : 'text-[#72767D] hover:bg-[#EEEDE9]'}`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="mt-3 min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
          {!contextMode && (filter === 'all' || filter === 'agents') && (
            <DrawerSection title="Agent 模板" icon={<Bot size={13} />} empty={visibleTemplates.length === 0}>
              {visibleTemplates.map(template => (
                <AssetRow key={template.id} icon={<Bot size={14} />} title={template.name} meta={template.model} onClick={() => onAddAgent(template)} />
              ))}
            </DrawerSection>
          )}
          {(filter === 'all' || filter === 'cards') && (
            <DrawerSection title="原子卡" icon={<Layers3 size={13} />} empty={visibleCards.length === 0}>
              {visibleCards.map(card => (
                <AssetRow key={card.id} icon={<Layers3 size={14} />} title={`${card.type} · ${card.articleTitle || '原子卡'}`} meta={card.content} onClick={() => onAddCard(card)} />
              ))}
            </DrawerSection>
          )}
          {(filter === 'all' || filter === 'articles') && (
            <DrawerSection title="收藏文章" icon={<FileText size={13} />} empty={visibleArticles.length === 0}>
              {visibleArticles.map(article => (
                <AssetRow key={article.id} icon={<FileText size={14} />} title={article.title} meta={article.excerpt || article.source} onClick={() => onAddArticle(article)} />
              ))}
            </DrawerSection>
          )}
          {(filter === 'all' || filter === 'notes') && (
            <DrawerSection title="我的 Notes" icon={<ImagePlus size={13} />} empty={visibleNotes.length === 0}>
              {visibleNotes.map(note => (
                <AssetRow key={note.id} icon={<StickyNote size={14} />} title={note.title || '未命名文章'} meta={new Date(note.updated_at).toLocaleDateString()} onClick={() => onAddNote(note)} />
              ))}
            </DrawerSection>
          )}
        </div>
      </div>
    </aside>
  );
};

const DrawerSection: React.FC<{ title: string; icon: React.ReactNode; empty: boolean; children: React.ReactNode }> = ({ title, icon, empty, children }) => (
  <section>
    <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-[#4F545B]">{icon}{title}</div>
    <div className="space-y-1.5">
      {empty ? <div className="rounded-[6px] border border-dashed border-[#DCDAD4] px-3 py-4 text-center text-[11px] text-[#96999F]">没有匹配内容</div> : children}
    </div>
  </section>
);

const AssetRow: React.FC<{ icon: React.ReactNode; title: string; meta: string; onClick: () => void }> = ({ icon, title, meta, onClick }) => (
  <button type="button" onClick={onClick} className="flex w-full items-start gap-2.5 rounded-[7px] border border-[#E3E1DC] bg-white px-3 py-2.5 text-left hover:border-[#9ABCF0] hover:bg-[#F8FAFE]">
    <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[5px] bg-[#EDF3FC] text-[#2465BE]">{icon}</span>
    <span className="min-w-0 flex-1">
      <span className="block truncate text-[11px] font-medium text-[#2E3238]">{title}</span>
      <span className="mt-1 block line-clamp-2 text-[10px] leading-4 text-[#80848B]">{meta || '暂无摘要'}</span>
    </span>
  </button>
);
