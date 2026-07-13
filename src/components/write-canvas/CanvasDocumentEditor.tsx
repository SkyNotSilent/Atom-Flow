import React, { useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { StarterKit } from '@tiptap/starter-kit';
import { Bold, ChevronDown, ChevronUp, GripVertical, Heading2, Italic, Plus, Save, Trash2 } from 'lucide-react';
import type { WriteCanvasDocument, WriteCanvasDocumentSection, WriteCanvasNode } from '../../types';

type CanvasDocumentEditorProps = {
  node: WriteCanvasNode;
  onSaved?: (document: WriteCanvasDocument) => void;
};

const documentStatuses = [
  ['editing', '编辑中'],
  ['pending_review', '待审核'],
  ['completed', '已完成'],
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const getDocumentId = (node: WriteCanvasNode) => {
  const embedded = node.document as unknown;
  if (isRecord(embedded) && Number.isFinite(Number(embedded.id))) return Number(embedded.id);
  const nodeRecord = node as unknown as Record<string, unknown>;
  const meta = isRecord(nodeRecord.meta) ? nodeRecord.meta : null;
  const candidate = nodeRecord.documentId ?? meta?.documentId;
  return Number.isFinite(Number(candidate)) ? Number(candidate) : null;
};

const toDocument = (value: unknown): WriteCanvasDocument | null => {
  if (!isRecord(value) || !Number.isFinite(Number(value.id))) return null;
  const sections = Array.isArray(value.sections) ? value.sections.map((section, index) => {
    const raw = isRecord(section) ? section : {};
    return {
      key: typeof raw.key === 'string' && raw.key ? raw.key : `section-${index + 1}`,
      heading: typeof raw.heading === 'string' ? raw.heading : '',
      body: typeof raw.body === 'string' ? raw.body : '',
      level: Number.isFinite(Number(raw.level)) ? Math.min(6, Math.max(1, Number(raw.level))) : 1,
      meta: isRecord(raw.meta) ? raw.meta : {},
    };
  }) : [];
  return {
    id: Number(value.id),
    projectId: Number(value.projectId) || 0,
    nodeId: Number(value.nodeId) || 0,
    title: typeof value.title === 'string' ? value.title : '未命名文档',
    summary: typeof value.summary === 'string' ? value.summary : '',
    scenario: typeof value.scenario === 'string' ? value.scenario : '',
    status: typeof value.status === 'string' ? value.status as WriteCanvasDocument['status'] : 'editing',
    currentVersionId: Number.isFinite(Number(value.currentVersionId)) ? Number(value.currentVersionId) : null,
    sections,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
  };
};

const createSection = (): WriteCanvasDocumentSection => ({
  key: `section-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  heading: '新的段落',
  body: '',
  level: 1,
  meta: {},
});

export const CanvasDocumentEditor: React.FC<CanvasDocumentEditorProps> = ({ node, onSaved }) => {
  const documentId = useMemo(() => getDocumentId(node), [node]);
  const [document, setDocument] = useState<WriteCanvasDocument | null>(() => toDocument(node.document));
  const [activeSectionKey, setActiveSectionKey] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');
  const activeSectionKeyRef = useRef<string | null>(null);

  useEffect(() => {
    activeSectionKeyRef.current = activeSectionKey;
  }, [activeSectionKey]);

  const editor = useEditor({
    extensions: [StarterKit.configure({ heading: { levels: [1, 2, 3] } })],
    content: '',
    editorProps: {
      attributes: {
        class: 'min-h-40 rounded-[6px] border border-[#DCDAD4] bg-white px-3 py-2 text-[12px] leading-6 text-[#30343A] outline-none focus:border-[#78A5EB] focus:ring-2 focus:ring-[#DCEAFF]',
      },
    },
    onUpdate: ({ editor: nextEditor }) => {
      const key = activeSectionKeyRef.current;
      if (!key) return;
      const body = nextEditor.getHTML();
      setDocument(current => current ? {
        ...current,
        sections: current.sections.map(section => section.key === key ? { ...section, body } : section),
      } : current);
    },
  });

  useEffect(() => {
    const embedded = toDocument(node.document);
    if (embedded) {
      setDocument(embedded);
      setActiveSectionKey(current => current && embedded.sections.some(section => section.key === current) ? current : embedded.sections[0]?.key || null);
      setError('');
      return;
    }
    if (!documentId) {
      setDocument(null);
      setError('作品内容尚未加载。');
      return;
    }

    let disposed = false;
    setIsLoading(true);
    setError('');
    void fetch(`/api/write/canvas/documents/${documentId}`)
      .then(async response => {
        if (!response.ok) throw new Error('作品加载失败');
        const payload = await response.json() as { document?: unknown };
        return toDocument(payload.document);
      })
      .then(nextDocument => {
        if (disposed || !nextDocument) {
          if (!disposed) setError('作品内容无效。');
          return;
        }
        setDocument(nextDocument);
        setActiveSectionKey(current => current && nextDocument.sections.some(section => section.key === current) ? current : nextDocument.sections[0]?.key || null);
      })
      .catch(() => { if (!disposed) setError('作品加载失败。'); })
      .finally(() => { if (!disposed) setIsLoading(false); });
    return () => { disposed = true; };
  }, [documentId, node.document, node.id]);

  const activeSection = document?.sections.find(section => section.key === activeSectionKey) || document?.sections[0] || null;

  useEffect(() => {
    if (!activeSection) return;
    if (activeSectionKey !== activeSection.key) setActiveSectionKey(activeSection.key);
    if (editor && editor.getHTML() !== activeSection.body) editor.commands.setContent(activeSection.body || '');
  }, [activeSection, activeSectionKey, editor]);

  const updateDocument = (data: Partial<WriteCanvasDocument>) => setDocument(current => current ? { ...current, ...data } : current);
  const updateSection = (key: string, data: Partial<WriteCanvasDocumentSection>) => setDocument(current => current ? {
    ...current,
    sections: current.sections.map(section => section.key === key ? { ...section, ...data } : section),
  } : current);

  const moveSection = (key: string, direction: -1 | 1) => setDocument(current => {
    if (!current) return current;
    const index = current.sections.findIndex(section => section.key === key);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= current.sections.length) return current;
    const sections = [...current.sections];
    [sections[index], sections[target]] = [sections[target], sections[index]];
    return { ...current, sections };
  });

  const deleteSection = (key: string) => setDocument(current => {
    if (!current || current.sections.length <= 1) return current;
    const sections = current.sections.filter(section => section.key !== key);
    setActiveSectionKey(active => active === key ? sections[0]?.key || null : active);
    return { ...current, sections };
  });

  const addSection = () => {
    const section = createSection();
    setDocument(current => current ? { ...current, sections: [...current.sections, section] } : current);
    setActiveSectionKey(section.key);
  };

  const save = async () => {
    if (!document || isSaving) return;
    setIsSaving(true);
    setError('');
    try {
      const response = await fetch(`/api/write/canvas/documents/${document.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: document.title,
          summary: document.summary,
          scenario: document.scenario,
          status: document.status,
          sections: document.sections,
        }),
      });
      if (!response.ok) throw new Error('作品保存失败');
      const payload = await response.json() as { document?: unknown };
      const saved = toDocument(payload.document);
      if (!saved) throw new Error('作品保存失败');
      setDocument(saved);
      onSaved?.(saved);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '作品保存失败');
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) return <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-[12px] text-[#7B8087]">加载作品…</div>;
  if (!document) return <div className="min-h-0 flex-1 p-4 text-[12px] text-[#B34439]">{error || '作品内容不可用。'}</div>;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="space-y-3">
        <label className="block text-[10px] font-medium text-[#6D7178]">作品标题
          <input value={document.title} onChange={event => updateDocument({ title: event.target.value })} className="canvas-field mt-1.5" />
        </label>
        <label className="block text-[10px] font-medium text-[#6D7178]">摘要
          <textarea value={document.summary} onChange={event => updateDocument({ summary: event.target.value })} className="canvas-field mt-1.5 h-20 resize-none leading-5" />
        </label>
        <label className="block text-[10px] font-medium text-[#6D7178]">状态
          <select value={document.status} onChange={event => updateDocument({ status: event.target.value as WriteCanvasDocument['status'] })} className="canvas-field mt-1.5">
            {documentStatuses.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      </div>

      <section className="mt-5">
        <div className="flex items-center justify-between">
          <h3 className="text-[12px] font-semibold text-[#30343A]">大纲</h3>
          <button type="button" onClick={addSection} className="inline-flex items-center gap-1 rounded-[5px] border border-[#C9D7E9] bg-white px-2 py-1 text-[10px] font-medium text-[#185ABD] hover:bg-[#EEF4FC]"><Plus size={12} />添加段落</button>
        </div>
        <div className="mt-2 space-y-1.5">
          {document.sections.map((section, index) => (
            <div key={section.key} className={`flex items-center gap-1 rounded-[6px] border px-1.5 py-1 ${section.key === activeSection?.key ? 'border-[#8FB5F2] bg-[#F4F8FE]' : 'border-[#E2E0DB] bg-white'}`}>
              <GripVertical size={13} className="shrink-0 text-[#A0A4AA]" />
              <button type="button" onClick={() => setActiveSectionKey(section.key)} className="min-w-0 flex-1 truncate px-1 text-left text-[11px] text-[#41464D]">{section.heading || `段落 ${index + 1}`}</button>
              <button type="button" disabled={index === 0} onClick={() => moveSection(section.key, -1)} aria-label="上移段落" className="p-1 text-[#777C83] disabled:opacity-30"><ChevronUp size={13} /></button>
              <button type="button" disabled={index === document.sections.length - 1} onClick={() => moveSection(section.key, 1)} aria-label="下移段落" className="p-1 text-[#777C83] disabled:opacity-30"><ChevronDown size={13} /></button>
              <button type="button" disabled={document.sections.length <= 1} onClick={() => deleteSection(section.key)} aria-label="删除段落" className="p-1 text-[#B34439] disabled:opacity-30"><Trash2 size={12} /></button>
            </div>
          ))}
        </div>
      </section>

      {activeSection ? (
        <section className="mt-4 space-y-2">
          <input value={activeSection.heading} onChange={event => updateSection(activeSection.key, { heading: event.target.value })} placeholder="段落标题" className="canvas-field font-medium" />
          <div className="flex items-center gap-1 border-x border-t border-[#DCDAD4] bg-[#F8F8F6] px-2 py-1.5">
            <ToolbarButton active={editor?.isActive('bold')} title="加粗" onClick={() => editor?.chain().focus().toggleBold().run()}><Bold size={13} /></ToolbarButton>
            <ToolbarButton active={editor?.isActive('italic')} title="斜体" onClick={() => editor?.chain().focus().toggleItalic().run()}><Italic size={13} /></ToolbarButton>
            <ToolbarButton active={editor?.isActive('heading', { level: 2 })} title="二级标题" onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}><Heading2 size={13} /></ToolbarButton>
          </div>
          <EditorContent editor={editor} />
        </section>
      ) : null}

      {error ? <p className="mt-3 text-[11px] text-[#B34439]">{error}</p> : null}
      <button type="button" disabled={isSaving} onClick={() => void save()} className="mt-5 inline-flex w-full items-center justify-center gap-1.5 rounded-[6px] bg-[#1F6FEB] px-3 py-2 text-[11px] font-medium text-white hover:bg-[#195FC9] disabled:opacity-50"><Save size={13} />{isSaving ? '保存中…' : '保存作品'}</button>
    </div>
  );
};

const ToolbarButton: React.FC<{ active?: boolean; title: string; onClick: () => void; children: React.ReactNode }> = ({ active, title, onClick, children }) => (
  <button type="button" title={title} onClick={onClick} className={`flex h-6 w-6 items-center justify-center rounded-[4px] ${active ? 'bg-[#DCEAFF] text-[#185ABD]' : 'text-[#62676E] hover:bg-white'}`}>{children}</button>
);
