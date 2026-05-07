import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAppContext } from '../context/AppContext';
import { Article, Note, NoteSourceReference } from '../types';
import { cn } from './Nav';
import { ChevronLeft, ChevronRight, FileText, Network, Plus, Trash2, ExternalLink, Bold, Italic, Underline as UnderlineIcon, Strikethrough, Heading1, Heading2, Heading3, Quote, List, ListOrdered, Table as TableIcon, Minus, Undo2, Redo2 } from 'lucide-react';
import { useEditor, EditorContent } from '@tiptap/react';
import { StarterKit } from '@tiptap/starter-kit';
import { Table as TableExt } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableCell } from '@tiptap/extension-table-cell';
import { TableHeader } from '@tiptap/extension-table-header';
import { Placeholder } from '@tiptap/extension-placeholder';
import { Underline as UnderlineExt } from '@tiptap/extension-underline';
import { TextAlign } from '@tiptap/extension-text-align';
import { Highlight } from '@tiptap/extension-highlight';
import { Link } from '@tiptap/extension-link';

const ToolbarButton: React.FC<{
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
}> = ({ onClick, active, disabled, title, children }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    title={title}
    className={cn(
      'flex h-7 w-7 items-center justify-center rounded-md transition-colors',
      active ? 'bg-accent/15 text-accent' : 'text-text3 hover:bg-surface2 hover:text-text-main',
      disabled && 'opacity-30 cursor-not-allowed'
    )}
  >
    {children}
  </button>
);

const Divider = () => <div className="mx-1 h-5 w-px bg-border" />;

export const NotesPanel: React.FC = () => {
  const { notes, createNote, updateNote, deleteNote, showToast, setReadingArticle, setActiveSource, articles } = useAppContext();
  const [activeNoteId, setActiveNoteId] = useState<number | null>(null);
  const [title, setTitle] = useState('');
  const [isLibraryCollapsed, setIsLibraryCollapsed] = useState(() => window.localStorage.getItem('atomflow:notes-library-collapsed') === 'true');
  const titleRef = useRef('');
  const saveTimerRef = useRef<number | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);

  const activeNote = notes.find(n => n.id === activeNoteId) || null;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      TableExt.configure({ resizable: true }),
      TableRow,
      TableCell,
      TableHeader,
      Placeholder.configure({ placeholder: '开始写作...' }),
      UnderlineExt,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Highlight.configure({ multicolor: false }),
      Link.configure({ openOnClick: false }),
    ],
    content: '',
    editorProps: {
      attributes: {
        class: 'prose prose-sm max-w-none px-8 py-6 text-text-main outline-none min-h-full prose-headings:font-serif prose-headings:text-text-main prose-p:leading-8 prose-a:text-accent prose-blockquote:border-accent2 prose-blockquote:text-text2 focus:outline-none',
      },
    },
    onUpdate: ({ editor: ed }) => {
      if (!activeNoteId) return;
      const html = ed.getHTML();
      debouncedSave(activeNoteId, { title: titleRef.current, content: html });
    },
  });

  // Load content when active note changes
  useEffect(() => {
    if (activeNote && editor) {
      setTitle(activeNote.title);
      titleRef.current = activeNote.title;
      // Only set content if it actually differs to avoid cursor jump
      if (editor.getHTML() !== activeNote.content) {
        editor.commands.setContent(activeNote.content || '');
      }
    } else if (!activeNote && editor) {
      setTitle('');
      titleRef.current = '';
      editor.commands.setContent('');
    }
  }, [activeNoteId, activeNote]);

  // Auto-select first note on mount
  useEffect(() => {
    if (notes.length > 0 && activeNoteId === null) {
      setActiveNoteId(notes[0].id);
    }
  }, [notes]);

  useEffect(() => {
    window.localStorage.setItem('atomflow:notes-library-collapsed', String(isLibraryCollapsed));
  }, [isLibraryCollapsed]);

  useEffect(() => {
    const openPendingNote = () => {
      const pendingId = Number(window.localStorage.getItem('atomflow:open-note-id'));
      if (!pendingId) return;
      if (notes.some(note => note.id === pendingId)) {
        setActiveNoteId(pendingId);
        window.localStorage.removeItem('atomflow:open-note-id');
      }
    };

    openPendingNote();
    window.addEventListener('atomflow:open-note', openPendingNote);
    return () => window.removeEventListener('atomflow:open-note', openPendingNote);
  }, [notes]);

  // Debounced auto-save
  const debouncedSave = useCallback((noteId: number, data: { title?: string; content?: string }) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      updateNote(noteId, data);
    }, 800);
  }, [updateNote]);

  const handleTitleChange = (value: string) => {
    setTitle(value);
    titleRef.current = value;
    if (activeNoteId && editor) {
      debouncedSave(activeNoteId, { title: value, content: editor.getHTML() });
    }
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

  const addTable = () => {
    if (!editor) return;
    editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
  };

  const setLink = () => {
    if (!editor) return;
    const previousUrl = editor.getAttributes('link').href;
    const url = window.prompt('输入链接 URL', previousUrl);
    if (url === null) return;
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  };

  return (
    <div className="flex h-full">
      <div
        className={cn(
          "border-r border-border flex flex-col shrink-0 bg-bg/40 transition-[width] duration-200",
          isLibraryCollapsed ? "w-12" : "w-[280px]"
        )}
      >
        {isLibraryCollapsed ? (
          <div className="flex h-full flex-col items-center gap-2 py-3">
            <button
              onClick={() => setIsLibraryCollapsed(false)}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-text2 transition-colors hover:bg-surface2 hover:text-text-main"
              title="展开文章库"
            >
              <ChevronRight size={16} />
            </button>
            <button
              onClick={() => void handleCreate()}
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-white transition-opacity hover:opacity-90"
              title="新建文章"
            >
              <Plus size={15} />
            </button>
            <div className="mt-2 flex flex-col items-center gap-1 text-text3">
              <FileText size={15} />
              <span className="text-[10px] leading-none">{notes.length}</span>
            </div>
          </div>
        ) : (
          <>
            <div className="p-3 border-b border-border flex items-center justify-between">
              <div>
                <div className="text-[13px] font-semibold text-text-main">文章库</div>
                <div className="mt-0.5 text-[11px] text-text3">{notes.length} 篇文档</div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setIsLibraryCollapsed(true)}
                  className="w-7 h-7 rounded-lg text-text3 flex items-center justify-center hover:bg-surface2 hover:text-text-main transition-colors"
                  title="收起文章库"
                >
                  <ChevronLeft size={15} />
                </button>
                <button
                  onClick={() => void handleCreate()}
                  className="w-7 h-7 rounded-lg bg-accent text-white flex items-center justify-center hover:opacity-90 transition-opacity"
                  title="新建文章"
                >
                  <Plus size={14} />
                </button>
              </div>
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
                      <div className={cn(
                        "text-[13px] font-medium truncate flex-1",
                        note.title ? "text-text-main" : "text-text3 italic"
                      )}>
                        {note.title || (note.content ? note.content.replace(/<[^>]*>/g, '').slice(0, 20) + '...' : '无标题文章')}
                      </div>
                      <button
                        onClick={e => { e.stopPropagation(); void handleDelete(note.id); }}
                        className="w-5 h-5 rounded flex items-center justify-center text-text3 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all shrink-0"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                    <div className="text-[11px] text-text3 truncate mt-0.5">
                      {note.content ? note.content.replace(/<[^>]*>/g, '').slice(0, 58) : '空白文章'}
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
          </>
        )}
      </div>

      <div className="flex-1 flex flex-col min-w-0">
        {activeNote ? (
          <>
            <div className="px-6 pt-4 pb-2 border-b border-border shrink-0">
              <input
                ref={titleInputRef}
                type="text"
                value={title}
                onChange={e => handleTitleChange(e.target.value)}
                placeholder="请输入文章标题..."
                className="w-full text-[24px] font-serif font-bold text-text-main bg-transparent outline-none placeholder:text-text3/60 focus:placeholder:text-text3/40"
              />
              <div className="mt-1 mb-3 text-[11px] text-text3">自动保存 · 最近更新 {formatDate(activeNote.updated_at)}</div>

              {/* Toolbar */}
              {editor && (
                <div className="mb-2 flex flex-wrap items-center gap-0.5">
                  <ToolbarButton onClick={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()} title="撤销">
                    <Undo2 size={14} />
                  </ToolbarButton>
                  <ToolbarButton onClick={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()} title="重做">
                    <Redo2 size={14} />
                  </ToolbarButton>

                  <Divider />

                  <ToolbarButton onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} active={editor.isActive('heading', { level: 1 })} title="一级标题">
                    <Heading1 size={14} />
                  </ToolbarButton>
                  <ToolbarButton onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} active={editor.isActive('heading', { level: 2 })} title="二级标题">
                    <Heading2 size={14} />
                  </ToolbarButton>
                  <ToolbarButton onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} active={editor.isActive('heading', { level: 3 })} title="三级标题">
                    <Heading3 size={14} />
                  </ToolbarButton>

                  <Divider />

                  <ToolbarButton onClick={() => editor.chain().focus().toggleBold().run()} active={editor.isActive('bold')} title="加粗">
                    <Bold size={14} />
                  </ToolbarButton>
                  <ToolbarButton onClick={() => editor.chain().focus().toggleItalic().run()} active={editor.isActive('italic')} title="斜体">
                    <Italic size={14} />
                  </ToolbarButton>
                  <ToolbarButton onClick={() => editor.chain().focus().toggleUnderline().run()} active={editor.isActive('underline')} title="下划线">
                    <UnderlineIcon size={14} />
                  </ToolbarButton>
                  <ToolbarButton onClick={() => editor.chain().focus().toggleStrike().run()} active={editor.isActive('strike')} title="删除线">
                    <Strikethrough size={14} />
                  </ToolbarButton>
                  <ToolbarButton onClick={() => editor.chain().focus().toggleHighlight().run()} active={editor.isActive('highlight')} title="高亮">
                    <span className="text-[11px] font-bold px-0.5 bg-yellow-200 rounded">A</span>
                  </ToolbarButton>

                  <Divider />

                  <ToolbarButton onClick={() => editor.chain().focus().toggleBlockquote().run()} active={editor.isActive('blockquote')} title="引用">
                    <Quote size={14} />
                  </ToolbarButton>
                  <ToolbarButton onClick={() => editor.chain().focus().toggleBulletList().run()} active={editor.isActive('bulletList')} title="无序列表">
                    <List size={14} />
                  </ToolbarButton>
                  <ToolbarButton onClick={() => editor.chain().focus().toggleOrderedList().run()} active={editor.isActive('orderedList')} title="有序列表">
                    <ListOrdered size={14} />
                  </ToolbarButton>

                  <Divider />

                  <ToolbarButton onClick={addTable} title="插入表格">
                    <TableIcon size={14} />
                  </ToolbarButton>
                  <ToolbarButton onClick={() => editor.chain().focus().setHorizontalRule().run()} title="分割线">
                    <Minus size={14} />
                  </ToolbarButton>
                  <ToolbarButton onClick={setLink} active={editor.isActive('link')} title="插入链接">
                    <span className="text-[11px] font-bold">🔗</span>
                  </ToolbarButton>
                </div>
              )}

              {/* Agent meta info */}
              {(activeNote.meta?.activationSummary?.length || activeNote.meta?.sourceArticles?.length) && (
                <div className="mb-2 grid gap-3">
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
              <EditorContent editor={editor} className="h-full" />
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
