import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { StarterKit } from '@tiptap/starter-kit';
import { Bold, ChevronDown, ChevronUp, Download, FileCode2, GripVertical, Heading2, Italic, PanelTopOpen, Plus, Save, Trash2 } from 'lucide-react';
import type { WriteCanvasDocument, WriteCanvasDocumentSection, WriteCanvasNode } from '../../types';
import { CANVAS_DOCUMENT_SCENARIOS, createScenarioSections, downloadCanvasDocument } from '../../utils/canvasDocumentExport';

type CanvasDocumentEditorProps = {
  node: WriteCanvasNode;
  onSaved?: (document: WriteCanvasDocument) => void;
};

export type CanvasDocumentSavePayload = Pick<WriteCanvasDocument, 'title' | 'summary' | 'scenario' | 'status' | 'sections'> & {
  currentVersionId: number | null;
};

export type CanvasDocumentDraftRecord = {
  version: 1;
  documentId: number;
  baseSnapshot: string;
  document: WriteCanvasDocument;
  savedAt: number;
};

export const buildCanvasDocumentSavePayload = (document: WriteCanvasDocument): CanvasDocumentSavePayload => ({
  currentVersionId: document.currentVersionId ?? null,
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
  requestDocumentId?: number | null,
  activeDocumentId?: number | null,
  requestSessionId?: number,
  activeSessionId?: number,
) => requestId === latestRequestId
  && requestSnapshot === currentSnapshot
  && (requestDocumentId === undefined || activeDocumentId === undefined || requestDocumentId === activeDocumentId)
  && (requestSessionId === undefined || activeSessionId === undefined || requestSessionId === activeSessionId);

const AUTOSAVE_DELAY_MS = 900;
const MAX_PROJECTION_SAVE_ATTEMPTS = 3;
const CANVAS_DOCUMENT_KEEPALIVE_MAX_BYTES = 48 * 1024;
const CANVAS_DOCUMENT_DRAFT_KEY_PREFIX = 'atomflow.canvas-document-draft.v1';
const CANVAS_DOCUMENT_TAB_ID_SESSION_KEY = 'atomflow.canvas-document-tab-id.v1';

export const createCanvasDocumentDraftRecord = (
  document: WriteCanvasDocument,
  baseSnapshot: string,
  savedAt = Date.now(),
): CanvasDocumentDraftRecord => ({ version: 1, documentId: document.id, baseSnapshot, document, savedAt });

export const recoverCanvasDocumentDraft = (
  persisted: WriteCanvasDocument,
  record: CanvasDocumentDraftRecord | null,
) => {
  if (!record || record.version !== 1 || record.documentId !== persisted.id || record.document.id !== persisted.id) return null;
  const persistedSnapshot = createCanvasDocumentSnapshot(persisted);
  const draftSnapshot = createCanvasDocumentSnapshot(record.document);
  if (draftSnapshot === persistedSnapshot) return null;
  if (record.baseSnapshot === persistedSnapshot) return record.document;
  return null;
};

export const rebaseCanvasDocumentDraftVersion = (
  draft: WriteCanvasDocument,
  persisted: WriteCanvasDocument,
): WriteCanvasDocument => ({
  ...draft,
  currentVersionId: persisted.currentVersionId,
  updatedAt: persisted.updatedAt,
});

export const shouldUseCanvasDocumentKeepalive = (payload: CanvasDocumentSavePayload) => (
  new TextEncoder().encode(JSON.stringify(payload)).byteLength <= CANVAS_DOCUMENT_KEEPALIVE_MAX_BYTES
);

type DocumentSaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'conflict';

type PendingDocumentSave = {
  document: WriteCanvasDocument;
  payload: CanvasDocumentSavePayload;
  snapshot: string;
  sessionId: number;
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

const getCanvasDocumentTabId = () => {
  try {
    const existing = window.sessionStorage.getItem(CANVAS_DOCUMENT_TAB_ID_SESSION_KEY);
    if (existing) return existing;
    const created = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    window.sessionStorage.setItem(CANVAS_DOCUMENT_TAB_ID_SESSION_KEY, created);
    return created;
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
};

const getCanvasDocumentDraftKey = (documentId: number, tabId: string) => `${CANVAS_DOCUMENT_DRAFT_KEY_PREFIX}:${documentId}:${tabId}`;

const readCanvasDocumentDraft = (documentId: number, tabId: string): CanvasDocumentDraftRecord | null => {
  try {
    const draftKey = getCanvasDocumentDraftKey(documentId, tabId);
    const legacyKey = `${CANVAS_DOCUMENT_DRAFT_KEY_PREFIX}:${documentId}`;
    let raw = window.localStorage.getItem(draftKey);
    if (!raw) {
      raw = window.localStorage.getItem(legacyKey);
      if (raw) {
        window.localStorage.setItem(draftKey, raw);
        window.localStorage.removeItem(legacyKey);
      }
    }
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const document = toDocument(parsed.document);
    if (parsed.version !== 1 || Number(parsed.documentId) !== documentId || !document) return null;
    const savedAt = Number(parsed.savedAt);
    return {
      version: 1,
      documentId,
      baseSnapshot: typeof parsed.baseSnapshot === 'string' ? parsed.baseSnapshot : '',
      document,
      savedAt: Number.isFinite(savedAt) ? savedAt : 0,
    };
  } catch {
    return null;
  }
};

const persistCanvasDocumentDraft = (document: WriteCanvasDocument, baseSnapshot: string, tabId: string) => {
  try {
    window.localStorage.setItem(
      getCanvasDocumentDraftKey(document.id, tabId),
      JSON.stringify(createCanvasDocumentDraftRecord(document, baseSnapshot)),
    );
    return true;
  } catch {
    return false;
  }
};

const clearCanvasDocumentDraft = (documentId: number, tabId: string, expectedSnapshot?: string) => {
  try {
    if (expectedSnapshot) {
      const current = readCanvasDocumentDraft(documentId, tabId);
      if (current && createCanvasDocumentSnapshot(current.document) !== expectedSnapshot) return;
    }
    window.localStorage.removeItem(getCanvasDocumentDraftKey(documentId, tabId));
  } catch {
    // Storage cleanup is best effort.
  }
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
  const [conflictDocument, setConflictDocument] = useState<WriteCanvasDocument | null>(null);
  const [error, setError] = useState('');
  const [projectingSectionKey, setProjectingSectionKey] = useState<string | null>(null);
  const [projectedSectionKey, setProjectedSectionKey] = useState<string | null>(null);
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
  const activeDocumentIdRef = useRef<number | null>(documentId);
  const activeDocumentSessionRef = useRef(1);
  const mountedRef = useRef(true);
  const onSavedRef = useRef(onSaved);
  const conflictDocumentRef = useRef<WriteCanvasDocument | null>(null);
  const documentTabIdRef = useRef('');
  if (!documentTabIdRef.current) documentTabIdRef.current = getCanvasDocumentTabId();

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

  const setActiveConflictDocument = useCallback((next: WriteCanvasDocument | null) => {
    conflictDocumentRef.current = next;
    setConflictDocument(next);
  }, []);

  const adoptLoadedDocument = useCallback((persistedDocument: WriteCanvasDocument) => {
    if (activeDocumentIdRef.current !== persistedDocument.id) return;
    pendingSaveRef.current = null;
    const persistedSnapshot = createCanvasDocumentSnapshot(persistedDocument);
    lastPersistedSnapshotRef.current = persistedSnapshot;
    lastKeepaliveSnapshotRef.current = '';
    const draftRecord = readCanvasDocumentDraft(persistedDocument.id, documentTabIdRef.current);
    const recovered = recoverCanvasDocumentDraft(persistedDocument, draftRecord);
    if (recovered) {
      setActiveConflictDocument(null);
      setDocumentDraft(recovered);
      setSaveStatus('dirty');
    } else if (draftRecord && createCanvasDocumentSnapshot(draftRecord.document) !== persistedSnapshot) {
      setActiveConflictDocument(persistedDocument);
      setDocumentDraft(draftRecord.document);
      setSaveStatus('conflict');
      setError('作品已在其他窗口更新，本地草稿已保留。可先导出本地稿，再载入服务器版本。');
      return;
    } else {
      setActiveConflictDocument(null);
      clearCanvasDocumentDraft(persistedDocument.id, documentTabIdRef.current);
      setDocumentDraft(persistedDocument);
      setSaveStatus('saved');
    }
    setError('');
  }, [setActiveConflictDocument, setDocumentDraft]);

  const flushLatestDirtyDocument = useCallback(() => {
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    const latest = documentRef.current;
    if (!latest) return;
    const snapshot = createCanvasDocumentSnapshot(latest);
    const keepaliveKey = `${latest.id}:${snapshot}`;
    if (snapshot === lastPersistedSnapshotRef.current) {
      clearCanvasDocumentDraft(latest.id, documentTabIdRef.current);
      return;
    }

    persistCanvasDocumentDraft(latest, lastPersistedSnapshotRef.current, documentTabIdRef.current);
    if (conflictDocumentRef.current?.id === latest.id) return;
    const payload = buildCanvasDocumentSavePayload(latest);
    if (!shouldUseCanvasDocumentKeepalive(payload)
      || keepaliveKey === lastKeepaliveSnapshotRef.current
      || activeSaveAbortControllerRef.current
      || saveLoopRef.current) return;
    lastKeepaliveSnapshotRef.current = keepaliveKey;
    void fetch(`/api/write/canvas/documents/${latest.id}`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => undefined);
  }, []);

  useLayoutEffect(() => {
    if (activeDocumentIdRef.current === documentId) return;
    flushLatestDirtyDocument();
    activeDocumentIdRef.current = documentId;
    activeDocumentSessionRef.current += 1;
    latestRequestIdRef.current = ++requestSequenceRef.current;
    pendingSaveRef.current = null;
    setActiveConflictDocument(null);
    activeSaveAbortControllerRef.current?.abort();
    activeSaveAbortControllerRef.current = null;
    lastPersistedSnapshotRef.current = '';
    lastKeepaliveSnapshotRef.current = '';
  }, [documentId, flushLatestDirtyDocument, setActiveConflictDocument]);

  const runSaveLoop = useCallback((): Promise<void> => {
    if (saveLoopRef.current) return saveLoopRef.current;

    const loop = (async () => {
      while (pendingSaveRef.current) {
        const pending = pendingSaveRef.current;
        pendingSaveRef.current = null;
        const isActiveSession = () => pending.document.id === activeDocumentIdRef.current
          && pending.sessionId === activeDocumentSessionRef.current;
        if (isActiveSession() && pending.snapshot === lastPersistedSnapshotRef.current) continue;

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
          if (!response.ok) {
            const errorPayload = await response.json().catch(() => null) as { code?: unknown; error?: unknown } | null;
            if (response.status === 409 && errorPayload?.code === 'DOCUMENT_VERSION_CONFLICT') {
              const currentResponse = await fetch(`/api/write/canvas/documents/${pending.document.id}`, {
                credentials: 'same-origin',
                signal: abortController.signal,
              });
              const currentPayload = currentResponse.ok
                ? await currentResponse.json().catch(() => null) as { document?: unknown } | null
                : null;
              const currentServerDocument = toDocument(currentPayload?.document);
              if (!currentServerDocument) throw new Error('作品版本冲突，且无法载入服务器版本；本地草稿已保留');
              pendingSaveRef.current = null;
              if (isActiveSession() && requestId === latestRequestIdRef.current) {
                setActiveConflictDocument(currentServerDocument);
                setSaveStatus('conflict');
                setError('作品已在其他窗口更新，本地草稿已保留。可先导出本地稿，再载入服务器版本。');
              }
              continue;
            }
            throw new Error(typeof errorPayload?.error === 'string' ? errorPayload.error : '作品保存失败');
          }
          const payload = await response.json() as { document?: unknown };
          const saved = toDocument(payload.document);
          if (!saved) throw new Error('作品保存失败');
          clearCanvasDocumentDraft(pending.document.id, documentTabIdRef.current, pending.snapshot);
          if (!isActiveSession() || requestId !== latestRequestIdRef.current) continue;

          const savedSnapshot = createCanvasDocumentSnapshot(saved);
          lastPersistedSnapshotRef.current = savedSnapshot;
          const current = documentRef.current;
          const currentSnapshot = current ? createCanvasDocumentSnapshot(current) : '';
          if (current && shouldApplyCanvasDocumentSaveResult(
            requestId,
            latestRequestIdRef.current,
            pending.snapshot,
            currentSnapshot,
            pending.document.id,
            activeDocumentIdRef.current,
            pending.sessionId,
            activeDocumentSessionRef.current,
          )) {
            lastPersistedSnapshotRef.current = createCanvasDocumentSnapshot(saved);
            lastKeepaliveSnapshotRef.current = '';
            setDocumentDraft(saved);
            if (mountedRef.current) {
              setSaveStatus('saved');
              setError('');
              onSavedRef.current?.(saved);
            }
          } else if (current && isActiveSession()) {
            const rebased = rebaseCanvasDocumentDraftVersion(current, saved);
            const rebasedSnapshot = createCanvasDocumentSnapshot(rebased);
            setDocumentDraft(rebased);
            persistCanvasDocumentDraft(rebased, savedSnapshot, documentTabIdRef.current);
            pendingSaveRef.current = {
              document: rebased,
              payload: buildCanvasDocumentSavePayload(rebased),
              snapshot: rebasedSnapshot,
              sessionId: pending.sessionId,
            };
            if (mountedRef.current) {
              setSaveStatus('dirty');
              setError('');
              onSavedRef.current?.(saved);
            }
          }
        } catch (saveError) {
          const wasAborted = saveError instanceof Error && saveError.name === 'AbortError';
          if (!wasAborted && mountedRef.current && isActiveSession() && requestId === latestRequestIdRef.current) {
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
  }, [setActiveConflictDocument, setDocumentDraft]);

  const enqueueSave = useCallback((nextDocument: WriteCanvasDocument) => {
    if (nextDocument.id !== activeDocumentIdRef.current) return Promise.resolve();
    if (conflictDocumentRef.current?.id === nextDocument.id) return Promise.resolve();
    const snapshot = createCanvasDocumentSnapshot(nextDocument);
    if (snapshot === lastPersistedSnapshotRef.current) {
      clearCanvasDocumentDraft(nextDocument.id, documentTabIdRef.current);
      if (mountedRef.current) setSaveStatus('saved');
      return Promise.resolve();
    }
    pendingSaveRef.current = {
      document: nextDocument,
      payload: buildCanvasDocumentSavePayload(nextDocument),
      snapshot,
      sessionId: activeDocumentSessionRef.current,
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
      adoptLoadedDocument(embedded);
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
        adoptLoadedDocument(nextDocument);
        setActiveSectionKey(current => current && nextDocument.sections.some(section => section.key === current) ? current : nextDocument.sections[0]?.key || null);
      })
      .catch(() => { if (!disposed) setError('作品加载失败。'); })
      .finally(() => { if (!disposed) setIsLoading(false); });
    return () => { disposed = true; };
  }, [adoptLoadedDocument, documentId, flushLatestDirtyDocument, node.document, node.id, setDocumentDraft]);

  useEffect(() => {
    if (!document || document.id !== documentId || isLoading) return;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    const snapshot = createCanvasDocumentSnapshot(document);
    if (snapshot === lastPersistedSnapshotRef.current) {
      clearCanvasDocumentDraft(document.id, documentTabIdRef.current);
      if (!saveLoopRef.current) setSaveStatus('saved');
      return;
    }

    persistCanvasDocumentDraft(document, lastPersistedSnapshotRef.current, documentTabIdRef.current);
    if (conflictDocumentRef.current?.id === document.id) {
      setSaveStatus('conflict');
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

  const loadServerConflictVersion = () => {
    const serverDocument = conflictDocumentRef.current;
    if (!serverDocument || serverDocument.id !== activeDocumentIdRef.current) return;
    pendingSaveRef.current = null;
    clearCanvasDocumentDraft(serverDocument.id, documentTabIdRef.current);
    setActiveConflictDocument(null);
    const serverSnapshot = createCanvasDocumentSnapshot(serverDocument);
    lastPersistedSnapshotRef.current = serverSnapshot;
    lastKeepaliveSnapshotRef.current = '';
    setDocumentDraft(serverDocument);
    setSaveStatus('saved');
    setError('');
    onSavedRef.current?.(serverDocument);
  };

  const projectSectionToCanvas = async (section: WriteCanvasDocumentSection) => {
    const latest = documentRef.current;
    if (!latest || projectingSectionKey) return;
    const projectionDocumentId = latest.id;
    setProjectingSectionKey(section.key);
    setError('');
    try {
      let stableDocument: WriteCanvasDocument | null = null;
      for (let attempt = 0; attempt < MAX_PROJECTION_SAVE_ATTEMPTS; attempt += 1) {
        const currentBeforeSave = documentRef.current;
        if (!currentBeforeSave || currentBeforeSave.id !== projectionDocumentId) throw new Error('作品已切换，请重新投射');
        const snapshot = createCanvasDocumentSnapshot(currentBeforeSave);
        await enqueueSave(currentBeforeSave);
        const currentAfterSave = documentRef.current;
        if (!currentAfterSave || currentAfterSave.id !== projectionDocumentId) throw new Error('作品已切换，请重新投射');
        if (createCanvasDocumentSnapshot(currentAfterSave) === snapshot && lastPersistedSnapshotRef.current === snapshot) {
          stableDocument = currentAfterSave;
          break;
        }
      }
      if (!stableDocument) throw new Error('作品仍在编辑，请停止输入后重试投射');
      if (!stableDocument.sections.some(item => item.key === section.key)) throw new Error('段落已被删除，无法投射');
      const response = await fetch(`/api/write/canvas/documents/${stableDocument.id}/sections/${encodeURIComponent(section.key)}/project`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error('段落投射失败');
      setProjectedSectionKey(section.key);
      onSavedRef.current?.(stableDocument);
    } catch (projectionError) {
      setError(projectionError instanceof Error ? projectionError.message : '段落投射失败');
    } finally {
      setProjectingSectionKey(null);
    }
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
              <button
                type="button"
                title={projectedSectionKey === section.key ? '段落已投射到画布' : '投射段落到画布'}
                aria-label="投射段落到画布"
                disabled={projectingSectionKey !== null}
                onClick={() => void projectSectionToCanvas(section)}
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-[4px] disabled:opacity-35 ${projectedSectionKey === section.key ? 'text-[#267A47]' : 'text-[#777C83] hover:bg-white hover:text-[#185ABD]'}`}
              >
                <PanelTopOpen size={13} className={projectingSectionKey === section.key ? 'animate-pulse' : ''} />
              </button>
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

      <p aria-live="polite" className={`mt-3 text-[10px] ${saveStatus === 'error' || saveStatus === 'conflict' ? 'text-[#B34439]' : 'text-[#747980]'}`}>
        {saveStatus === 'saving'
          ? '正在自动保存…'
          : saveStatus === 'saved'
            ? '已保存'
            : saveStatus === 'error'
              ? '自动保存失败，可点击下方按钮重试。'
              : saveStatus === 'conflict'
                ? '检测到其他窗口的新版本，已暂停自动保存。'
              : saveStatus === 'dirty'
                ? '有未保存修改'
                : ''}
      </p>
      {error ? <p className="mt-1 text-[11px] text-[#B34439]">{error}</p> : null}
      {conflictDocument ? (
        <button type="button" onClick={loadServerConflictVersion} className="mt-2 w-full rounded-[6px] border border-[#C9D7E9] bg-white px-3 py-2 text-[11px] font-medium text-[#185ABD] hover:bg-[#EEF4FC]">
          载入服务器版本
        </button>
      ) : null}
      <div className="mt-5 grid grid-cols-[1fr_auto_auto] gap-2">
        <button type="button" disabled={isSaving || saveStatus === 'conflict'} onClick={() => void save()} className="inline-flex items-center justify-center gap-1.5 rounded-[6px] bg-[#1F6FEB] px-3 py-2 text-[11px] font-medium text-white hover:bg-[#195FC9] disabled:opacity-50"><Save size={13} />{isSaving ? '保存中…' : '保存作品'}</button>
        <button type="button" title="导出 Markdown" aria-label="导出 Markdown" onClick={() => downloadCanvasDocument(document, 'markdown')} className="flex h-8 w-8 items-center justify-center rounded-[6px] border border-[#DCDAD4] bg-white text-[#59616A] hover:border-[#9ABCF0] hover:text-[#185ABD]"><Download size={14} /></button>
        <button type="button" title="导出 HTML" aria-label="导出 HTML" onClick={() => downloadCanvasDocument(document, 'html')} className="flex h-8 w-8 items-center justify-center rounded-[6px] border border-[#DCDAD4] bg-white text-[#59616A] hover:border-[#9ABCF0] hover:text-[#185ABD]"><FileCode2 size={14} /></button>
      </div>
    </div>
  );
};

const ToolbarButton: React.FC<{ active?: boolean; title: string; onClick: () => void; children: React.ReactNode }> = ({ active, title, onClick, children }) => (
  <button type="button" title={title} onClick={onClick} className={`flex h-6 w-6 items-center justify-center rounded-[4px] ${active ? 'bg-[#DCEAFF] text-[#185ABD]' : 'text-[#62676E] hover:bg-white'}`}>{children}</button>
);
