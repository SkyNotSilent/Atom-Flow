import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAppContext } from '../context/AppContext';
import { Note } from '../types';
import { cn } from './Nav';
import { Plus, Trash2, FileText } from 'lucide-react';

export const NotesPanel: React.FC = () => {
  const { notes, createNote, updateNote, deleteNote, showToast } = useAppContext();
  const [activeNoteId, setActiveNoteId] = useState<number | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
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
    if (!window.confirm('确定要删除这篇笔记吗？')) return;
    await deleteNote(id);
    if (activeNoteId === id) {
      const remaining = notes.filter(n => n.id !== id);
      setActiveNoteId(remaining.length > 0 ? remaining[0].id : null);
    }
    showToast('笔记已删除');
  };

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    const month = (d.getMonth() + 1).toString().padStart(2, '0');
    const day = d.getDate().toString().padStart(2, '0');
    const hours = d.getHours().toString().padStart(2, '0');
    const mins = d.getMinutes().toString().padStart(2, '0');
    return `${month}-${day} ${hours}:${mins}`;
  };

  return (
    <div className="flex h-full">
      {/* Left sidebar: note list */}
      <div className="w-[240px] border-r border-border flex flex-col shrink-0">
        <div className="p-3 border-b border-border flex items-center justify-between">
          <span className="text-[13px] font-semibold text-text-main">我的笔记</span>
          <button
            onClick={() => void handleCreate()}
            className="w-7 h-7 rounded-lg bg-accent text-white flex items-center justify-center hover:opacity-90 transition-opacity"
            title="新建笔记"
          >
            <Plus size={14} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {notes.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-text3">
              <FileText size={32} className="mb-3 opacity-30" />
              <p className="text-[13px]">暂无笔记</p>
              <button
                onClick={() => void handleCreate()}
                className="mt-3 text-[13px] text-accent hover:underline"
              >
                创建第一篇笔记
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
                    {note.title || '无标题'}
                  </div>
                  <button
                    onClick={e => { e.stopPropagation(); void handleDelete(note.id); }}
                    className="w-5 h-5 rounded flex items-center justify-center text-text3 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all shrink-0"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
                <div className="text-[11px] text-text3 truncate mt-0.5">
                  {note.content ? note.content.slice(0, 50) : '空白笔记'}
                </div>
                <div className="text-[10px] text-text3/60 mt-1">
                  {formatDate(note.updated_at)}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Right: editor */}
      <div className="flex-1 flex flex-col min-w-0">
        {activeNote ? (
          <>
            <div className="p-4 border-b border-border shrink-0">
              <input
                ref={titleInputRef}
                type="text"
                value={title}
                onChange={e => handleTitleChange(e.target.value)}
                placeholder="笔记标题"
                className="w-full text-[18px] font-serif font-bold text-text-main bg-transparent outline-none placeholder:text-text3/50"
              />
            </div>
            <div className="flex-1 overflow-y-auto">
              <textarea
                value={content}
                onChange={e => handleContentChange(e.target.value)}
                placeholder="开始写作..."
                className="w-full h-full p-4 text-[14px] text-text-main bg-transparent outline-none resize-none leading-[1.8] placeholder:text-text3/50"
              />
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-text3">
            <FileText size={48} className="mb-4 opacity-20" />
            <p className="text-[14px]">选择一篇笔记或创建新笔记</p>
          </div>
        )}
      </div>
    </div>
  );
};
