import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAppContext } from '../context/AppContext';
import { Article, Note, NoteSourceReference } from '../types';
import { cn } from './Nav';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Eye, FileText, Network, PenLine, Plus, Trash2, ExternalLink } from 'lucide-react';

export const NotesPanel: React.FC = () => {
  const { notes, createNote, updateNote, deleteNote, showToast, setReadingArticle, setActiveSource, articles } = useAppContext();
  const [activeNoteId, setActiveNoteId] = useState<number | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const saveTimerRef = useRef<number | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);

  const activeNote = notes.find(n => n.id === activeNoteId) || null;

  // When active note changes, load its content
  useEffect(() => {
    if (activeNote) {
      setTitle(activeNote.title);
      setContent(activeNote.content);
    } else {
      setTitle('');
      setContent('');
    }
  }, [activeNoteId]);

  // Auto-select first note on mount
  useEffect(() => {
    if (notes.length > 0 && activeNoteId === null) {
      setActiveNoteId(notes[0].id);
    }
  }, [notes]);

  // Debounced auto-save
  const debouncedSave = useCallback((noteId: number, data: { title?: string; content?: string }) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      updateNote(noteId, data);
    }, 1000);
  }, [updateNote]);

  const handleTitleChange = (value: string) => {
    setTitle(value);
    if (activeNoteId) debouncedSave(activeNoteId, { title: value, content });
  };

  const handleContentChange = (value: string) => {
    setContent(value);
    if (activeNoteId) debouncedSave(activeNoteId, { title, content: value });
  };

  const handleCreate = async () => {
    const note = await createNote();
    if (note) {
      setActiveNoteId(note.id);
      setTimeout(() => titleInputRef.current?.focus(), 100);
    }
  };

  const handleDelete = async (id: number) => {
    if (!window.confirm('确定要删除这篇文章吗？')) return;
    await deleteNote(id);
    if (activeNoteId === id) {
      const remaining = notes.filter(n => n.id !== id);
      setActiveNoteId(remaining.length > 0 ? remaining[0].id : null);
    }
    showToast('文章已删除');
  };

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    const month = (d.getMonth() + 1).toString().padStart(2, '0');
    const day = d.getDate().toString().padStart(2, '0');
    const hours = d.getHours().toString().padStart(2, '0');
    const mins = d.getMinutes().toString().padStart(2, '0');
    return `${month}-${day} ${hours}:${mins}`;
  };

  const openSourceArticle = async (reference: NoteSourceReference) => {
    const liveArticle = articles.find(article => {
      if (reference.articleId && article.id === reference.articleId) return true;
      if (reference.url && article.url === reference.url) return true;
      return article.title === reference.title;
    });

    if (liveArticle) {
      setActiveSource(liveArticle.source || null);
      setReadingArticle(liveArticle);
      return;
    }

    if (!reference.savedArticleId) {
      if (reference.url) {
        window.open(reference.url, '_blank', 'noopener,noreferrer');
        return;
      }
      showToast('未找到原文');
      return;
    }

    try {
      const res = await fetch(`/api/saved-articles/${reference.savedArticleId}`);
      if (!res.ok) {
        showToast('加载原文失败');
        return;
      }
      const data = await res.json();
      const article: Article = {
        id: -(reference.savedArticleId),
        saved: true,
        source: data.source || reference.source,
        sourceIcon: data.sourceIcon || undefined,
        topic: data.topic || '',
        time: reference.savedAt ? new Date(reference.savedAt).toLocaleDateString('zh-CN') : '',
        publishedAt: data.publishedAt || undefined,
        title: data.title || reference.title,
        excerpt: data.excerpt || reference.excerpt || '',
        content: data.content || reference.excerpt || '',
        markdownContent: data.content || undefined,
        url: data.url || reference.url,
        fullFetched: true,
        cards: []
      };
      setActiveSource(article.source || null);
      setReadingArticle(article);
    } catch {
      showToast('网络错误，无法加载原文');
    }
  };

  return (
    <div className="flex h-full">
      <div className="w-[280px] border-r border-border flex flex-col shrink-0 bg-bg/40">
        <div className="p-3 border-b border-border flex items-center justify-between">
          <div>
            <div className="text-[13px] font-semibold text-text-main">文章库</div>
            <div className="mt-0.5 text-[11px] text-text3">{notes.length} 篇 Markdown 文档</div>
          </div>
          <button
            onClick={() => void handleCreate()}
            className="w-7 h-7 rounded-lg bg-accent text-white flex items-center justify-center hover:opacity-90 transition-opacity"
            title="新建文章"
          >
            <Plus size={14} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {notes.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-text3">
              <FileText size={32} className="mb-3 opacity-30" />
              <p className="text-[13px]">暂无文章</p>
              <button
                onClick={() => void handleCreate()}
                className="mt-3 text-[13px] text-accent hover:underline"
              >
                创建第一篇文章
              </button>
            </div>
          ) : (
            notes.map(note => (
              <div
                key={note.id}
                onClick={() => setActiveNoteId(note.id)}
                className={cn(
                  "px-3 py-2.5 border-b border-border cursor-pointer transition-colors group",
                  activeNoteId === note.id
                    ? "bg-accent-light"
                    : "hover:bg-surface2"
                )}
              >
                <div className="flex items-center justify-between">
                  <div className="text-[13px] font-medium text-text-main truncate flex-1">
                    {note.title || '无标题文章'}
                  </div>
                  <button
                    onClick={e => { e.stopPropagation(); void handleDelete(note.id); }}
                    className="w-5 h-5 rounded flex items-center justify-center text-text3 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all shrink-0"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
                <div className="text-[11px] text-text3 truncate mt-0.5">
                  {note.content ? note.content.replace(/[#>*_`\-\[\]()]/g, '').slice(0, 58) : '空白文章'}
                </div>
                {note.meta?.activationSummary?.[0] && (
                  <div className="mt-1 flex items-center gap-1 text-[10px] text-text3/80">
                    <Network size={11} />
                    <span className="truncate">{note.meta.activationSummary[0]}</span>
                  </div>
                )}
                <div className="text-[10px] text-text3/60 mt-1">
                  {formatDate(note.updated_at)}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="flex-1 flex flex-col min-w-0">
        {activeNote ? (
          <>
            <div className="px-6 py-4 border-b border-border shrink-0">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text3">Markdown Article</div>
                <div className="flex rounded-lg bg-surface2 p-1">
                  <button
                    onClick={() => setMode('edit')}
                    className={cn('flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px]', mode === 'edit' ? 'bg-surface text-text-main shadow-sm' : 'text-text3')}
                  >
                    <PenLine size={13} />
                    编辑
                  </button>
                  <button
                    onClick={() => setMode('preview')}
                    className={cn('flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px]', mode === 'preview' ? 'bg-surface text-text-main shadow-sm' : 'text-text3')}
                  >
                    <Eye size={13} />
                    预览
                  </button>
                </div>
              </div>
              <input
                ref={titleInputRef}
                type="text"
                value={title}
                onChange={e => handleTitleChange(e.target.value)}
                placeholder="文章标题"
                className="w-full text-[24px] font-serif font-bold text-text-main bg-transparent outline-none placeholder:text-text3/50"
              />
              <div className="mt-2 text-[11px] text-text3">自动保存 · 最近更新 {formatDate(activeNote.updated_at)}</div>
              {(activeNote.meta?.activationSummary?.length || activeNote.meta?.sourceArticles?.length) && (
                <div className="mt-4 grid gap-3">
                  {(activeNote.meta?.style || activeNote.meta?.outline?.length) && (
                    <div className="rounded-2xl border border-border bg-bg px-4 py-3">
                      <div className="flex items-center gap-2 text-[12px] font-semibold text-text-main">
                        <FileText size={14} />
                        写作 Agent
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {activeNote.meta?.style && (
                          <span className="rounded-full bg-surface2 px-2.5 py-1 text-[11px] text-text2">
                            风格 · {activeNote.meta.style}
                          </span>
                        )}
                        {activeNote.meta?.topic && (
                          <span className="rounded-full bg-surface2 px-2.5 py-1 text-[11px] text-text2">
                            主题 · {activeNote.meta.topic}
                          </span>
                        )}
                      </div>
                      {activeNote.meta?.outline?.length ? (
                        <div className="mt-3 grid gap-2">
                          {activeNote.meta.outline.map(section => (
                            <div key={`${section.heading}-${section.goal}`} className="rounded-xl bg-surface2 px-3 py-2">
                              <div className="text-[12px] font-medium text-text-main">{section.heading}</div>
                              <div className="mt-1 text-[11px] leading-5 text-text3">{section.goal}</div>
                            </div>
                          ))}
                        </div>
                      ) : null}
                      {activeNote.meta?.evidenceMap?.length ? (
                        <div className="mt-3 grid gap-2">
                          {activeNote.meta.evidenceMap.map(item => (
                            <div key={`${item.section}-${item.nodeIds.join('-')}`} className="rounded-xl border border-border/70 bg-surface px-3 py-2">
                              <div className="text-[11px] font-medium text-text-main">{item.section}</div>
                              <div className="mt-1 text-[11px] leading-5 text-text3">{item.note}</div>
                              <div className="mt-1 text-[10px] text-text3/80">节点映射：{item.nodeIds.join('、')}</div>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  )}

                  <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                  <div className="rounded-2xl border border-border bg-bg px-4 py-3">
                    <div className="flex items-center gap-2 text-[12px] font-semibold text-text-main">
                      <Network size={14} />
                      激活网络
                    </div>
                    <div className="mt-1 text-[11px] text-text3">{activeNote.meta?.topic || '未记录主题'}</div>
                    {activeNote.meta?.activationSummary?.length ? (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {activeNote.meta.activationSummary.map(item => (
                          <span key={item} className="rounded-full bg-surface2 px-2.5 py-1 text-[11px] text-text2">
                            {item}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <div className="mt-3 text-[11px] text-text3">这篇文章没有记录激活摘要。</div>
                    )}
                    {activeNote.meta?.activatedNodes?.length ? (
                      <div className="mt-3 grid gap-2">
                        {activeNote.meta.activatedNodes.slice(0, 6).map(node => (
                          <div key={node.id} className="rounded-xl bg-surface2 px-3 py-2">
                            <div className="text-[11px] font-medium text-text3">{node.type}</div>
                            <div className="mt-1 text-[12px] leading-5 text-text-main line-clamp-2">{node.content}</div>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>

                  <div className="rounded-2xl border border-border bg-bg px-4 py-3">
                    <div className="flex items-center gap-2 text-[12px] font-semibold text-text-main">
                      <ExternalLink size={14} />
                      原文来源
                    </div>
                    {activeNote.meta?.sourceArticles?.length ? (
                      <div className="mt-3 grid gap-2">
                        {activeNote.meta.sourceArticles.map(source => (
                          <button
                            key={`${source.savedArticleId ?? source.articleId ?? source.title}`}
                            onClick={() => void openSourceArticle(source)}
                            className="rounded-xl bg-surface2 px-3 py-2 text-left transition-colors hover:bg-accent-light"
                          >
                            <div className="text-[11px] font-medium text-text3">{source.source}</div>
                            <div className="mt-1 text-[12px] leading-5 text-text-main line-clamp-2">{source.title}</div>
                            {source.excerpt && (
                              <div className="mt-1 text-[11px] leading-5 text-text3 line-clamp-2">{source.excerpt}</div>
                            )}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="mt-3 text-[11px] text-text3">这篇文章没有记录原文引用。</div>
                    )}
                  </div>
                </div>
                </div>
              )}
            </div>
            <div className="flex-1 overflow-y-auto">
              {mode === 'edit' ? (
                <textarea
                  value={content}
                  onChange={e => handleContentChange(e.target.value)}
                  placeholder={'用 Markdown 开始写作...\n\n## 小标题\n\n- 要点\n- 引用\n\n> 这里写一段重要观察'}
                  className="min-h-full w-full resize-none bg-transparent px-7 py-6 font-mono text-[14px] leading-[1.9] text-text-main outline-none placeholder:text-text3/50"
                />
              ) : (
                <article className="prose prose-sm max-w-none px-8 py-7 text-text-main prose-headings:font-serif prose-headings:text-text-main prose-p:leading-8 prose-a:text-accent prose-blockquote:border-accent2 prose-blockquote:text-text2">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {content || '暂无内容。切换到编辑模式开始写作。'}
                  </ReactMarkdown>
                </article>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-text3">
            <FileText size={48} className="mb-4 opacity-20" />
            <p className="text-[14px]">选择一篇文章或创建新文章</p>
          </div>
        )}
      </div>
    </div>
  );
};
