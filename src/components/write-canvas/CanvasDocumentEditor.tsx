import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { StarterKit } from '@tiptap/starter-kit';
import { Bold, ChevronDown, ChevronUp, Download, FileCode2, GripVertical, Heading2, Italic, Plus, Save, Trash2 } from 'lucide-react';
import type { WriteCanvasDocument, WriteCanvasDocumentSection, WriteCanvasNode } from '../../types';
import { CANVAS_DOCUMENT_SCENARIOS, createScenarioSections, downloadCanvasDocument } from '../../utils/canvasDocumentExport';

type CanvasDocumentEditorProps = {
  node: WriteCanvasNode;
  onSaved?: (document: WriteCanvasDocument) => void;
};

export type CanvasDocumentSavePayload = Pick<WriteCanvasDocument, 'title' | 'summary' | 'scenario' | 'status' | 'sections'>;

export const buildCanvasDocumentSavePayload = (document: WriteCanvasDocument): CanvasDocumentSavePayload => ({
  title: document.title,
  summary: document.summary,
  scenario: document.scenario,
  status: document.status,
  sections: document.sections,
});

export const createCanvasDocumentSnapshot = (document: WriteCanvasDocument) => JSON.stringify(buildCanvasDocumentSavePayload(document));

export const shouldApplyCanvasDocumentSaveResult = (
  requestId: number,
  latestRequestId: number,
  requestSnapshot: string,
  currentSnapshot: string,
) => requestId === latestRequestId && requestSnapshot === currentSnapshot;

const AUTOSAVE_DELAY_MS = 900;

type DocumentSaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

type PendingDocumentSave = {
  document: WriteCanvasDocument;
  payload: CanvasDocumentSavePayload;
  snapshot: string;
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
  const [saveStatus, setSaveStatus] = useState<DocumentSaveStatus>(() => document ? 'saved' : 'idle');
  const [error, setError] = useState('');
  const activeSectionKeyRef = useRef<string | null>(null);
  const documentRef = useRef<WriteCanvasDocument | null>(document);
  const lastPersistedSnapshotRef = useRef(document ? createCanvasDocumentSnapshot(document) : '');
  const pendingSaveRef = useRef<PendingDocumentSave | null>(null);
  const saveLoopRef = useRef<Promise<void> | null>(null);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeSaveAbortControllerRef = useRef<AbortController | null>(null);
  const requestSequenceRef = useRef(0);
  const latestRequestIdRef = useRef(0);
  const lastKeepaliveSnapshotRef = useRef('');
  const mountedRef = useRef(true);
  const onSavedRef = useRef(onSaved);

  useEffect(() => {
    onSavedRef.current = onSaved;
  }, [onSaved]);

  const setDocumentDraft = useCallback((update: React.SetStateAction<WriteCanvasDocument | null>) => {
    setDocument(current => {
      const next = typeof update === 'function' ? update(current) : update;
      documentRef.current = next;
      return next;
    });
  }, []);

  const adoptPersistedDocument = useCallback((nextDocument: WriteCanvasDocument) => {
    pendingSaveRef.current = null;
    lastPersistedSnapshotRef.current = createCanvasDocumentSnapshot(nextDocument);
    lastKeepaliveSnapshotRef.current = '';
    setDocumentDraft(nextDocument);
    setSaveStatus('saved');
    setError('');
  }, [setDocumentDraft]);

  const flushLatestDirtyDocument = useCallback(() => {
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    const latest = documentRef.current;
    if (!latest) return;
    const snapshot = createCanvasDocumentSnapshot(latest);
    const keepaliveKey = `${latest.id}:${snapshot}`;
    if (snapshot === lastPersistedSnapshotRef.current || keepaliveKey === lastKeepaliveSnapshotRef.current) return;

    pendingSaveRef.current = null;
    lastKeepaliveSnapshotRef.current = keepaliveKey;
    latestRequestIdRef.current = ++requestSequenceRef.current;
    activeSaveAbortControllerRef.current?.abort();
    activeSaveAbortControllerRef.current = null;
    void fetch(`/api/write/canvas/documents/${latest.id}`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildCanvasDocumentSavePayload(latest)),
      keepalive: true,
    }).catch(() => undefined);
  }, []);

  const runSaveLoop = useCallback((): Promise<void> => {
    if (saveLoopRef.current) return saveLoopRef.current;

    const loop = (async () => {
      while (pendingSaveRef.current) {
        const pending = pendingSaveRef.current;
        pendingSaveRef.current = null;
        if (pending.snapshot === lastPersistedSnapshotRef.current) continue;

        const requestId = ++requestSequenceRef.current;
        latestRequestIdRef.current = requestId;
        const abortController = new AbortController();
        activeSaveAbortControllerRef.current = abortController;
        if (mountedRef.current) {
          setSaveStatus('saving');
          setError('');
        }

        try {
          const response = await fetch(`/api/write/canvas/documents/${pending.document.id}`, {
            method: 'PUT',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(pending.payload),
            signal: abortController.signal,
          });
          if (!response.ok) throw new Error('作品保存失败');
          const payload = await response.json() as { document?: unknown };
          const saved = toDocument(payload.document);
          if (!saved) throw new Error('作品保存失败');
          if (requestId !== latestRequestIdRef.current) continue;

          lastPersistedSnapshotRef.current = pending.snapshot;
          const current = documentRef.current;
          const currentSnapshot = current ? createCanvasDocumentSnapshot(current) : '';
          if (current && shouldApplyCanvasDocumentSaveResult(requestId, latestRequestIdRef.current, pending.snapshot, currentSnapshot)) {
            lastPersistedSnapshotRef.current = createCanvasDocumentSnapshot(saved);
            lastKeepaliveSnapshotRef.current = '';
            setDocumentDraft(saved);
            if (mountedRef.current) {
              setSaveStatus('saved');
              setError('');
              onSavedRef.current?.(saved);
            }
          } else if (mountedRef.current) {
            setSaveStatus('dirty');
          }
        } catch (saveError) {
          const wasAborted = saveError instanceof Error && saveError.name === 'AbortError';
          if (!wasAborted && mountedRef.current && requestId === latestRequestIdRef.current) {
            setSaveStatus('error');
            setError(saveError instanceof Error ? saveError.message : '作品保存失败');
          }
        } finally {
          if (activeSaveAbortControllerRef.current === abortController) activeSaveAbortControllerRef.current = null;
        }
      }
    })();

    saveLoopRef.current = loop;
    void loop.finally(() => {
      if (saveLoopRef.current !== loop) return;
      saveLoopRef.current = null;
      if (pendingSaveRef.current && mountedRef.current) void runSaveLoop();
    });
    return loop;
  }, [setDocumentDraft]);

  const enqueueSave = useCallback((nextDocument: WriteCanvasDocument) => {
    const snapshot = createCanvasDocumentSnapshot(nextDocument);
    if (snapshot === lastPersistedSnapshotRef.current) {
      if (mountedRef.current) setSaveStatus('saved');
      return Promise.resolve();
    }
    pendingSaveRef.current = {
      document: nextDocument,
      payload: buildCanvasDocumentSavePayload(nextDocument),
      snapshot,
    };
    return runSaveLoop();
  }, [runSaveLoop]);

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
      setDocumentDraft(current => current ? {
        ...current,
        sections: current.sections.map(section => section.key === key ? { ...section, body } : section),
      } : current);
    },
  });

  useEffect(() => {
    const embedded = toDocument(node.document);
    if (embedded) {
      const current = documentRef.current;
      if (current && current.id !== embedded.id) flushLatestDirtyDocument();
      if (current && current.id === embedded.id) {
        const currentSnapshot = createCanvasDocumentSnapshot(current);
        const embeddedSnapshot = createCanvasDocumentSnapshot(embedded);
        const hasLocalDraft = currentSnapshot !== lastPersistedSnapshotRef.current;
        if (hasLocalDraft && currentSnapshot !== embeddedSnapshot) return;
      }
      adoptPersistedDocument(embedded);
      setActiveSectionKey(current => current && embedded.sections.some(section => section.key === current) ? current : embedded.sections[0]?.key || null);
      return;
    }
    if (!documentId) {
      flushLatestDirtyDocument();
      setDocumentDraft(null);
      setError('作品内容尚未加载。');
      return;
    }

    if (documentRef.current && documentRef.current.id !== documentId) flushLatestDirtyDocument();

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
        adoptPersistedDocument(nextDocument);
        setActiveSectionKey(current => current && nextDocument.sections.some(section => section.key === current) ? current : nextDocument.sections[0]?.key || null);
      })
      .catch(() => { if (!disposed) setError('作品加载失败。'); })
      .finally(() => { if (!disposed) setIsLoading(false); });
    return () => { disposed = true; };
  }, [adoptPersistedDocument, documentId, flushLatestDirtyDocument, node.document, node.id, setDocumentDraft]);

  useEffect(() => {
    if (!document || document.id !== documentId || isLoading) return;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    const snapshot = createCanvasDocumentSnapshot(document);
    if (snapshot === lastPersistedSnapshotRef.current) {
      if (!saveLoopRef.current) setSaveStatus('saved');
      return;
    }

    setSaveStatus(current => current === 'saving' ? current : 'dirty');
    setError('');
    autosaveTimerRef.current = setTimeout(() => {
      autosaveTimerRef.current = null;
      const latest = documentRef.current;
      if (latest) void enqueueSave(latest);
    }, AUTOSAVE_DELAY_MS);
    return () => {
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
    };
  }, [document, documentId, enqueueSave, isLoading]);

  useEffect(() => {
    mountedRef.current = true;
    const handlePageHide = () => flushLatestDirtyDocument();
    window.addEventListener('pagehide', handlePageHide);
    return () => {
      window.removeEventListener('pagehide', handlePageHide);
      flushLatestDirtyDocument();
      mountedRef.current = false;
    };
  }, [flushLatestDirtyDocument]);

  const activeSection = document?.sections.find(section => section.key === activeSectionKey) || document?.sections[0] || null;

  useEffect(() => {
    if (!activeSection) return;
    if (activeSectionKey !== activeSection.key) setActiveSectionKey(activeSection.key);
    if (editor && editor.getHTML() !== activeSection.body) editor.commands.setContent(activeSection.body || '');
  }, [activeSection, activeSectionKey, editor]);

  const updateDocument = (data: Partial<WriteCanvasDocument>) => setDocumentDraft(current => current ? { ...current, ...data } : current);
  const updateSection = (key: string, data: Partial<WriteCanvasDocumentSection>) => setDocumentDraft(current => current ? {
    ...current,
    sections: current.sections.map(section => section.key === key ? { ...section, ...data } : section),
  } : current);

  const moveSection = (key: string, direction: -1 | 1) => setDocumentDraft(current => {
    if (!current) return current;
    const index = current.sections.findIndex(section => section.key === key);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= current.sections.length) return current;
    const sections = [...current.sections];
    [sections[index], sections[target]] = [sections[target], sections[index]];
    return { ...current, sections };
  });

  const deleteSection = (key: string) => setDocumentDraft(current => {
    if (!current || current.sections.length <= 1) return current;
    const sections = current.sections.filter(section => section.key !== key);
    setActiveSectionKey(active => active === key ? sections[0]?.key || null : active);
    return { ...current, sections };
  });

  const addSection = () => {
    const section = createSection();
    setDocumentDraft(current => current ? { ...current, sections: [...current.sections, section] } : current);
    setActiveSectionKey(section.key);
  };

  const applyScenario = () => {
    if (!document) return;
    const hasWrittenContent = document.sections.some(section => section.heading.trim() || section.body.replace(/<[^>]+>/g, '').trim());
    if (hasWrittenContent && !window.confirm('套用场景结构会替换当前大纲与正文，是否继续？')) return;
    const sections = createScenarioSections(document.scenario);
    setDocumentDraft({ ...document, sections });
    setActiveSectionKey(sections[0]?.key || null);
  };

  const save = async () => {
    const latest = documentRef.current;
    if (!latest) return;
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    await enqueueSave(latest);
  };

  const isSaving = saveStatus === 'saving';

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
        <div className="grid grid-cols-[1fr_auto] items-end gap-2">
          <label className="block text-[10px] font-medium text-[#6D7178]">创作场景
            <select value={document.scenario || 'custom-longform'} onChange={event => updateDocument({ scenario: event.target.value })} className="canvas-field mt-1.5">
              {CANVAS_DOCUMENT_SCENARIOS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
          <button type="button" onClick={applyScenario} className="mb-px h-[34px] rounded-[6px] border border-[#C9D7E9] bg-white px-2.5 text-[10px] font-medium text-[#185ABD] hover:bg-[#EEF4FC]">套用结构</button>
        </div>
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

      <p aria-live="polite" className={`mt-3 text-[10px] ${saveStatus === 'error' ? 'text-[#B34439]' : 'text-[#747980]'}`}>
        {saveStatus === 'saving'
          ? '正在自动保存…'
          : saveStatus === 'saved'
            ? '已保存'
            : saveStatus === 'error'
              ? '自动保存失败，可点击下方按钮重试。'
              : saveStatus === 'dirty'
                ? '有未保存修改'
                : ''}
      </p>
      {error ? <p className="mt-1 text-[11px] text-[#B34439]">{error}</p> : null}
      <div className="mt-5 grid grid-cols-[1fr_auto_auto] gap-2">
        <button type="button" disabled={isSaving} onClick={() => void save()} className="inline-flex items-center justify-center gap-1.5 rounded-[6px] bg-[#1F6FEB] px-3 py-2 text-[11px] font-medium text-white hover:bg-[#195FC9] disabled:opacity-50"><Save size={13} />{isSaving ? '保存中…' : '保存作品'}</button>
        <button type="button" title="导出 Markdown" aria-label="导出 Markdown" onClick={() => downloadCanvasDocument(document, 'markdown')} className="flex h-8 w-8 items-center justify-center rounded-[6px] border border-[#DCDAD4] bg-white text-[#59616A] hover:border-[#9ABCF0] hover:text-[#185ABD]"><Download size={14} /></button>
        <button type="button" title="导出 HTML" aria-label="导出 HTML" onClick={() => downloadCanvasDocument(document, 'html')} className="flex h-8 w-8 items-center justify-center rounded-[6px] border border-[#DCDAD4] bg-white text-[#59616A] hover:border-[#9ABCF0] hover:text-[#185ABD]"><FileCode2 size={14} /></button>
      </div>
    </div>
  );
};

const ToolbarButton: React.FC<{ active?: boolean; title: string; onClick: () => void; children: React.ReactNode }> = ({ active, title, onClick, children }) => (
  <button type="button" title={title} onClick={onClick} className={`flex h-6 w-6 items-center justify-center rounded-[4px] ${active ? 'bg-[#DCEAFF] text-[#185ABD]' : 'text-[#62676E] hover:bg-white'}`}>{children}</button>
);
