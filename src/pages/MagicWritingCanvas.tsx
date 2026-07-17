import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  Tldraw,
  createShapeId,
  getArrowBindings,
  type Editor,
  type TLArrowShape,
  type TLShape,
  type TLShapeId,
} from 'tldraw';
import 'tldraw/tldraw.css';
import {
  ChevronDown,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useAppContext } from '../context/AppContext';
import { CanvasAddDrawer } from '../components/write-canvas/CanvasAddDrawer';
import { CanvasAgentGroupPanel } from '../components/write-canvas/CanvasAgentGroupPanel';
import { CanvasInspector, type AgentDraft } from '../components/write-canvas/CanvasInspector';
import { CanvasNodeCard } from '../components/write-canvas/CanvasNodeCard';
import type { CanvasNodeAction } from '../components/write-canvas/CanvasNodeAddMenu';
import type {
  AtomCard,
  Note,
  SavedArticle,
  WriteAgentTemplate,
  WriteCanvasAgentRun,
  WriteCanvasEdge,
  WriteCanvasAgentGroup,
  WriteCanvasMessage,
  WriteCanvasNode,
  WriteCanvasNodeKind,
  WriteCanvasProject,
  WriteCanvasProjectDetail,
} from '../types';
import { cn } from '../components/Nav';
import { createScenarioSections } from '../utils/canvasDocumentExport';

type AtomFlowShape = {
  id: TLShapeId;
  type: 'atomflow-node';
  x: number;
  y: number;
  props: {
    w: number;
    h: number;
    nodeId: string;
    kind: WriteCanvasNodeKind;
    role: string;
    status: string;
    contentType: string;
    businessRef: string;
    title: string;
    summary: string;
  };
};
type CanvasShape = TLShape | AtomFlowShape;
type CanvasStoreRecord = {
  id: string;
  typeName: string;
  type?: string;
  fromId?: TLShapeId;
  x?: number;
  y?: number;
  props?: Record<string, unknown>;
  meta?: Record<string, unknown>;
};
type PendingNodeGeometry = {
  projectId: number;
  baseUpdatedAt: string;
  x: number;
  y: number;
  width: number;
  height: number;
  persisted: boolean;
};
type ActivePanel = 'add' | 'inspector' | 'agent-group' | null;
type CanvasQuickAction = 'summarize' | 'extract_insights' | 'extract_data' | 'extract_quotes' | 'extract_stories' | 'extract_cases' | 'extract_questions' | 'generate_outline';

const canvasQuickActions: Array<{ value: CanvasQuickAction; label: string; description: string }> = [
  { value: 'summarize', label: '摘要', description: '压缩为可快速阅读的核心内容' },
  { value: 'extract_insights', label: '观点', description: '提炼可复用的判断与洞察' },
  { value: 'extract_data', label: '数据', description: '提取事实、指标和明确数字' },
  { value: 'extract_quotes', label: '金句', description: '保留值得引用的原句与上下文' },
  { value: 'extract_stories', label: '故事', description: '识别经历、冲突和叙事片段' },
  { value: 'extract_cases', label: '案例', description: '整理做法、过程与结果' },
  { value: 'extract_questions', label: '问题', description: '生成后续研究和写作问题' },
  { value: 'generate_outline', label: '大纲', description: '生成可继续编辑的文章结构' },
];

class AtomFlowNodeShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'atomflow-node' as const;
  static override props = {
    w: T.number,
    h: T.number,
    nodeId: T.string,
    kind: T.string,
    role: T.string,
    status: T.string,
    contentType: T.string,
    businessRef: T.string,
    title: T.string,
    summary: T.string,
  };

  override getDefaultProps() {
    return {
      w: 280,
      h: 180,
      nodeId: '',
      kind: 'asset_text',
      role: 'material',
      status: 'ready',
      contentType: 'text',
      businessRef: '',
      title: '未命名节点',
      summary: '',
    };
  }

  override component(shape: AtomFlowShape) {
    const nodeId = Number(shape.props.nodeId);
    return (
      <HTMLContainer id={shape.id} style={{ width: shape.props.w, height: shape.props.h, pointerEvents: 'all' }}>
        <CanvasNodeCard
          node={{ id: Number.isFinite(nodeId) ? nodeId : 0, kind: shape.props.kind, role: shape.props.role, status: shape.props.status, contentType: shape.props.contentType, title: shape.props.title, summary: shape.props.summary }}
          onSelect={nodeId => window.dispatchEvent(new CustomEvent('atomflow-canvas-select', { detail: { nodeId } }))}
        />
      </HTMLContainer>
    );
  }

  override getIndicatorPath(shape: AtomFlowShape) {
    const path = new Path2D();
    path.roundRect(0, 0, shape.props.w, shape.props.h, 8);
    return path;
  }
}

const shapeUtils = [AtomFlowNodeShapeUtil];

const shapeIdForNode = (nodeId: number) => createShapeId(`atomflow-node-${nodeId}`);
const shapeIdForEdge = (edgeId: number) => createShapeId(`atomflow-edge-${edgeId}`);
const edgeIdFromShape = (shapeId: TLShapeId) => {
  const match = String(shapeId).match(/atomflow-edge-(\d+)$/);
  return match ? Number(match[1]) : null;
};
const nodeIdFromShape = (shape: CanvasShape | undefined) => {
  if (!shape || (shape as AtomFlowShape).type !== 'atomflow-node') return null;
  const nodeId = Number((shape as AtomFlowShape).props.nodeId);
  return Number.isFinite(nodeId) ? nodeId : null;
};
const isAtomFlowShape = (shape: CanvasShape): shape is AtomFlowShape => (shape as AtomFlowShape).type === 'atomflow-node';

const NODE_GEOMETRY_DRAFT_KEY_PREFIX = 'atomflow.canvas-node-geometry.v1';
const CANVAS_TAB_ID_SESSION_KEY = 'atomflow.canvas-tab-id.v1';
const QUICK_ACTION_RECONCILE_MAX_ATTEMPTS = 8;
const QUICK_ACTION_RECONCILE_DELAY_MS = 400;

const getCanvasTabId = () => {
  try {
    const existing = window.sessionStorage.getItem(CANVAS_TAB_ID_SESSION_KEY);
    if (existing) return existing;
    const created = window.crypto.randomUUID();
    window.sessionStorage.setItem(CANVAS_TAB_ID_SESSION_KEY, created);
    return created;
  } catch {
    return `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
};

const waitForQuickActionReconcile = () => new Promise(resolve => window.setTimeout(resolve, QUICK_ACTION_RECONCILE_DELAY_MS));
const isTerminalQuickActionRun = (run: WriteCanvasAgentRun) => (
  run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled'
);

const hasChangedNodeGeometry = (before: CanvasStoreRecord, after: CanvasStoreRecord) => before.x !== after.x
  || before.y !== after.y
  || before.props?.w !== after.props?.w
  || before.props?.h !== after.props?.h;

const getChangedNodeGeometryRecords = (changes: {
  added: Record<string, unknown>;
  updated: Record<string, unknown>;
}) => {
  const added = Object.values(changes.added) as CanvasStoreRecord[];
  const updated = Object.values(changes.updated).flatMap(value => {
    if (!Array.isArray(value) || value.length < 2) return [];
    const before = value[0] as CanvasStoreRecord;
    const after = value[1] as CanvasStoreRecord;
    return hasChangedNodeGeometry(before, after) ? [after] : [];
  });
  return [...added, ...updated].filter(record => record.typeName === 'shape' && record.type === 'atomflow-node');
};

const getStoredCamera = (viewport?: Record<string, unknown>) => {
  const camera = viewport?.camera;
  if (!camera || typeof camera !== 'object') return null;
  const raw = camera as Record<string, unknown>;
  const x = Number(raw.x);
  const y = Number(raw.y);
  const z = Number(raw.z);
  if (![x, y, z].every(Number.isFinite)) return null;
  return { x, y, z };
};

const parseSseEvents = (chunk: string) => chunk
  .replace(/\r\n/g, '\n')
  .split('\n\n')
  .map(block => block.trim())
  .filter(Boolean)
  .map(block => {
    const event = block.match(/^event:\s*(.+)$/m)?.[1] || 'message';
    const data = block
      .split('\n')
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n');
    if (!data) throw new Error('AI 返回格式错误：事件缺少数据');
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      throw new Error('AI 返回格式错误：事件数据不完整');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('AI 返回格式错误：事件数据无效');
    }
    return { event, payload: payload as Record<string, unknown> };
  });

export const MagicWritingCanvas: React.FC = () => {
  const { user, loginAndDo, showToast, savedCards, savedArticles, notes } = useAppContext();
  const [projects, setProjects] = useState<WriteCanvasProject[]>([]);
  const [currentProjectId, setCurrentProjectId] = useState<number | null>(null);
  const [detail, setDetail] = useState<WriteCanvasProjectDetail | null>(null);
  const [templates, setTemplates] = useState<WriteAgentTemplate[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<number | null>(null);
  const [activePanel, setActivePanel] = useState<ActivePanel>(null);
  const [contextAgentNodeId, setContextAgentNodeId] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [agentInput, setAgentInput] = useState('');
  const [isAgentRunning, setIsAgentRunning] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [aiDecomposeNodeId, setAiDecomposeNodeId] = useState<number | null>(null);
  const [aiQuickAction, setAiQuickAction] = useState<CanvasQuickAction>('extract_insights');
  const [isQuickActionRunning, setIsQuickActionRunning] = useState(false);
  const [quickActionStatus, setQuickActionStatus] = useState('');
  const [initialAgentGroupId, setInitialAgentGroupId] = useState<number | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const detailRef = useRef<WriteCanvasProjectDetail | null>(null);
  const activePanelRef = useRef<ActivePanel>(null);
  const positionSyncTimerRef = useRef<number | null>(null);
  const viewportSyncTimerRef = useRef<number | null>(null);
  const editorChangeTimerRef = useRef<number | null>(null);
  const currentProjectIdRef = useRef<number | null>(null);
  const restoredCameraProjectRef = useRef<number | null>(null);
  const isSyncingEditorRef = useRef(false);
  const pendingArrowIdsRef = useRef(new Set<string>());
  const pendingDeletedNodeIdsRef = useRef(new Set<number>());
  const pendingDeletedEdgeIdsRef = useRef(new Set<number>());
  const pendingCanonicalEdgeIdsRef = useRef(new Set<number>());
  const pendingNodeGeometryRef = useRef(new Map<number, PendingNodeGeometry>());
  const nodeGeometryFlushPromisesRef = useRef(new Map<number, Promise<boolean>>());
  const canvasTabIdRef = useRef('');
  const quickActionAbortControllerRef = useRef<AbortController | null>(null);
  const quickActionRunSequenceRef = useRef(0);
  const detailRequestSequenceRef = useRef(0);
  if (!canvasTabIdRef.current) canvasTabIdRef.current = getCanvasTabId();

  const selectedNode = useMemo(
    () => detail?.nodes.find(node => node.id === selectedNodeId) || null,
    [detail?.nodes, selectedNodeId]
  );
  const selectedAgentMessages = selectedNode?.agent ? detail?.messages[selectedNode.agent.id] || [] : [];
  const contextAgentNode = contextAgentNodeId ? detail?.nodes.find(node => node.id === contextAgentNodeId) || null : null;

  const restorePendingNodeGeometryDraft = useCallback((projectId: number) => {
    try {
      const raw = window.localStorage.getItem(`${NODE_GEOMETRY_DRAFT_KEY_PREFIX}:${projectId}:${canvasTabIdRef.current}`);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { projectId?: unknown; nodes?: unknown };
      if (Number(parsed.projectId) !== projectId || !Array.isArray(parsed.nodes)) return;
      for (const item of parsed.nodes) {
        if (!item || typeof item !== 'object') continue;
        const geometry = item as Record<string, unknown>;
        const nodeId = Number(geometry.nodeId);
        const baseUpdatedAt = typeof geometry.baseUpdatedAt === 'string' ? geometry.baseUpdatedAt : '';
        const values = [geometry.x, geometry.y, geometry.width, geometry.height].map(Number);
        if (!Number.isSafeInteger(nodeId) || nodeId <= 0 || !baseUpdatedAt || !values.every(Number.isFinite)) continue;
        if (!pendingNodeGeometryRef.current.has(nodeId)) {
          pendingNodeGeometryRef.current.set(nodeId, {
            projectId,
            baseUpdatedAt,
            x: values[0],
            y: values[1],
            width: values[2],
            height: values[3],
            persisted: false,
          });
        }
      }
    } catch {
      // Draft recovery is best effort; normal server geometry remains authoritative.
    }
  }, []);

  const persistPendingNodeGeometryDraft = useCallback((projectId = currentProjectIdRef.current) => {
    if (!projectId) return;
    const nodes = [...pendingNodeGeometryRef.current.entries()]
      .filter(([, geometry]) => geometry.projectId === projectId && !geometry.persisted)
      .map(([nodeId, geometry]) => ({ nodeId, baseUpdatedAt: geometry.baseUpdatedAt, x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height }));
    const key = `${NODE_GEOMETRY_DRAFT_KEY_PREFIX}:${projectId}:${canvasTabIdRef.current}`;
    try {
      if (nodes.length) window.localStorage.setItem(key, JSON.stringify({ projectId, nodes }));
      else window.localStorage.removeItem(key);
    } catch {
      // Debounced persistence still handles the common path when storage is unavailable.
    }
  }, []);

  const mergePendingNodeGeometry = useCallback((payload: WriteCanvasProjectDetail) => ({
    ...payload,
    nodes: payload.nodes.map(node => {
      const pending = pendingNodeGeometryRef.current.get(node.id);
      if (!pending || pending.projectId !== payload.project.id) return node;
      if (
        !pending.persisted
        && pending.baseUpdatedAt !== node.updatedAt
        && !nodeGeometryFlushPromisesRef.current.has(node.id)
      ) {
        pendingNodeGeometryRef.current.delete(node.id);
        return node;
      }
      if (
        pending.persisted
        && node.x === pending.x
        && node.y === pending.y
        && node.width === pending.width
        && node.height === pending.height
      ) {
        pendingNodeGeometryRef.current.delete(node.id);
        return node;
      }
      return {
        ...node,
        x: pending.x,
        y: pending.y,
        width: pending.width,
        height: pending.height,
      };
    }),
  }), []);

  const flushPendingNodeGeometry = useCallback(async (projectId = currentProjectIdRef.current) => {
    if (positionSyncTimerRef.current) {
      window.clearTimeout(positionSyncTimerRef.current);
      positionSyncTimerRef.current = null;
    }
    if (!projectId) return true;
    const pendingNodeIds = [...pendingNodeGeometryRef.current.entries()]
      .filter(([, geometry]) => geometry.projectId === projectId && !geometry.persisted)
      .map(([nodeId]) => nodeId);
    if (!pendingNodeIds.length) return true;

    const saved = await Promise.all(pendingNodeIds.map(nodeId => {
      const activeFlush = nodeGeometryFlushPromisesRef.current.get(nodeId);
      if (activeFlush) return activeFlush;

      const flush = (async () => {
        while (true) {
          const geometry = pendingNodeGeometryRef.current.get(nodeId);
          if (!geometry || geometry.projectId !== projectId || geometry.persisted) return true;
          try {
            const response = await fetch(`/api/write/canvas/nodes/${nodeId}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height, expectedUpdatedAt: geometry.baseUpdatedAt }),
            });
            const payload = await response.json().catch(() => null) as { code?: unknown; node?: Partial<WriteCanvasNode> } | null;
            if (!response.ok) {
              if (response.status === 409 && payload?.code === 'NODE_VERSION_CONFLICT' && payload.node) {
                pendingNodeGeometryRef.current.delete(nodeId);
                const canonical = payload.node;
                setDetail(current => {
                  if (!current || current.project.id !== projectId) return current;
                  const next = { ...current, nodes: current.nodes.map(node => node.id === nodeId ? { ...node, ...canonical } : node) };
                  detailRef.current = next;
                  return next;
                });
                showToast('节点位置已在其他窗口更新，已载入服务器布局');
              }
              return false;
            }

            const savedNode = payload?.node;
            if (!savedNode || typeof savedNode.updatedAt !== 'string' || !savedNode.updatedAt) return false;
            const latest = pendingNodeGeometryRef.current.get(nodeId);
            if (!latest) return true;
            latest.baseUpdatedAt = savedNode.updatedAt;
            latest.persisted = latest === geometry;
            setDetail(current => {
              if (!current || current.project.id !== projectId) return current;
              const next = {
                ...current,
                nodes: current.nodes.map(node => node.id === nodeId ? {
                  ...node,
                  ...savedNode,
                  ...(latest === geometry ? {} : {
                    x: latest.x,
                    y: latest.y,
                    width: latest.width,
                    height: latest.height,
                  }),
                } : node),
              };
              detailRef.current = next;
              return next;
            });
            persistPendingNodeGeometryDraft(projectId);
            if (latest === geometry) return true;
          } catch {
            return false;
          }
        }
      })();
      const trackedFlush = flush.finally(() => {
        if (nodeGeometryFlushPromisesRef.current.get(nodeId) === trackedFlush) {
          nodeGeometryFlushPromisesRef.current.delete(nodeId);
        }
      });
      nodeGeometryFlushPromisesRef.current.set(nodeId, trackedFlush);
      return trackedFlush;
    }));
    persistPendingNodeGeometryDraft(projectId);
    return saved.every(Boolean);
  }, [persistPendingNodeGeometryDraft, showToast]);

  const closeQuickAction = useCallback((abortRunning = true) => {
    if (abortRunning) quickActionAbortControllerRef.current?.abort();
    quickActionAbortControllerRef.current = null;
    setAiDecomposeNodeId(null);
    setIsQuickActionRunning(false);
    setQuickActionStatus('');
  }, []);

  const switchProject = useCallback(async (projectId: number | null) => {
    const previousProjectId = currentProjectIdRef.current;
    if (previousProjectId && previousProjectId !== projectId) {
      await flushPendingNodeGeometry(previousProjectId);
    }
    currentProjectIdRef.current = projectId;
    setCurrentProjectId(projectId);
    setProjectMenuOpen(false);
  }, [flushPendingNodeGeometry]);

  const loadProjects = useCallback(async () => {
    if (!user) return;
    const response = await fetch('/api/write/canvas/projects');
    if (!response.ok) return;
    const payload = await response.json();
    const nextProjects: WriteCanvasProject[] = Array.isArray(payload.projects) ? payload.projects : [];
    setProjects(nextProjects);
    setCurrentProjectId(previous => previous || nextProjects[0]?.id || null);
  }, [user]);

  const loadTemplates = useCallback(async () => {
    if (!user) return;
    const response = await fetch('/api/write/agent/templates');
    if (!response.ok) return;
    const payload = await response.json();
    setTemplates(Array.isArray(payload.templates) ? payload.templates : []);
  }, [user]);

  const loadProjectDetail = useCallback(async (projectId: number) => {
    restorePendingNodeGeometryDraft(projectId);
    const requestSequence = ++detailRequestSequenceRef.current;
    const response = await fetch(`/api/write/canvas/projects/${projectId}`);
    if (!response.ok) return null;
    const payload = mergePendingNodeGeometry(await response.json() as WriteCanvasProjectDetail);
    if (requestSequence !== detailRequestSequenceRef.current || currentProjectIdRef.current !== projectId) return null;
    persistPendingNodeGeometryDraft(projectId);
    detailRef.current = payload;
    setDetail(payload);
    setProjects(previous => previous.map(project => project.id === payload.project.id ? payload.project : project));
    setSelectedNodeId(previous => previous && payload.nodes.some(node => node.id === previous) ? previous : null);
    void flushPendingNodeGeometry(projectId);
    return payload;
  }, [flushPendingNodeGeometry, mergePendingNodeGeometry, persistPendingNodeGeometryDraft, restorePendingNodeGeometryDraft]);

  const reconcileQuickActionRun = useCallback(async (
    projectId: number,
    sourceNodeId: number,
    action: CanvasQuickAction,
    observedRunId: number | null,
    runStartedAt: number,
    runSequence: number,
  ) => {
    for (let attempt = 0; attempt < QUICK_ACTION_RECONCILE_MAX_ATTEMPTS; attempt += 1) {
      if (currentProjectIdRef.current !== projectId || quickActionRunSequenceRef.current !== runSequence) return;
      try {
        const response = await fetch(`/api/write/canvas/projects/${projectId}/runs`);
        if (response.ok) {
          const payload = await response.json() as { runs?: WriteCanvasAgentRun[] };
          const runs = Array.isArray(payload.runs) ? payload.runs : [];
          const run = observedRunId
            ? runs.find(item => item.id === observedRunId)
            : runs.find(item => item.sourceNodeId === sourceNodeId
              && item.action === action
              && Date.parse(item.createdAt) >= runStartedAt - 1000);
          if (run && isTerminalQuickActionRun(run)) break;
        }
      } catch {
        // A bounded retry handles transient disconnects while the server commits the run terminal state.
      }
      if (attempt < QUICK_ACTION_RECONCILE_MAX_ATTEMPTS - 1) await waitForQuickActionReconcile();
    }
    if (currentProjectIdRef.current === projectId && quickActionRunSequenceRef.current === runSequence) {
      await loadProjectDetail(projectId);
    }
  }, [loadProjectDetail]);

  useEffect(() => {
    if (!user) {
      setProjects([]);
      setCurrentProjectId(null);
      setDetail(null);
      detailRef.current = null;
      return;
    }
    void loadProjects();
    void loadTemplates();
  }, [loadProjects, loadTemplates, user]);

  useEffect(() => {
    currentProjectIdRef.current = currentProjectId;
    closeQuickAction();
    setActivePanel(null);
    setSelectedNodeId(null);
    setContextAgentNodeId(null);
    editorRef.current?.selectNone();
    if (currentProjectId) void loadProjectDetail(currentProjectId);
  }, [closeQuickAction, currentProjectId, loadProjectDetail]);

  useEffect(() => {
    detailRef.current = detail;
  }, [detail]);

  useEffect(() => {
    activePanelRef.current = activePanel;
  }, [activePanel]);

  useEffect(() => {
    const handlePageHide = () => {
      persistPendingNodeGeometryDraft(currentProjectIdRef.current);
    };
    window.addEventListener('pagehide', handlePageHide);
    return () => {
      window.removeEventListener('pagehide', handlePageHide);
      persistPendingNodeGeometryDraft(currentProjectIdRef.current);
      quickActionRunSequenceRef.current += 1;
      quickActionAbortControllerRef.current?.abort();
    };
  }, [persistPendingNodeGeometryDraft]);

  const closeInspector = useCallback(() => {
    setActivePanel(null);
    setSelectedNodeId(null);
    editorRef.current?.selectNone();
  }, []);

  const selectNode = useCallback((nodeId: number, openInspector = true) => {
    closeQuickAction();
    setSelectedNodeId(nodeId);
    setContextAgentNodeId(null);
    if (openInspector) setActivePanel('inspector');
    const editor = editorRef.current;
    const shapeId = shapeIdForNode(nodeId);
    if (editor?.getShape(shapeId)) editor.select(shapeId);
  }, [closeQuickAction]);

  useEffect(() => {
    const selectHandler = (event: Event) => {
      const nodeId = (event as CustomEvent<{ nodeId: number }>).detail?.nodeId;
      if (Number.isFinite(nodeId)) selectNode(nodeId);
    };
    const keyHandler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setProjectMenuOpen(false);
      setContextAgentNodeId(null);
      if (aiDecomposeNodeId !== null) {
        closeQuickAction();
        return;
      }
      if (activePanelRef.current === 'inspector') closeInspector();
      else setActivePanel(null);
    };
    window.addEventListener('atomflow-canvas-select', selectHandler);
    window.addEventListener('keydown', keyHandler);
    return () => {
      window.removeEventListener('atomflow-canvas-select', selectHandler);
      window.removeEventListener('keydown', keyHandler);
    };
  }, [aiDecomposeNodeId, closeInspector, closeQuickAction, selectNode]);

  const createBoundEdge = useCallback((editor: Editor, edge: WriteCanvasEdge, source: WriteCanvasNode, target: WriteCanvasNode) => {
    const id = shapeIdForEdge(edge.id);
    const sourceId = shapeIdForNode(source.id);
    const targetId = shapeIdForNode(target.id);
    if (!editor.getShape(sourceId) || !editor.getShape(targetId)) return;
    const shapePartial = {
      id,
      type: 'arrow',
      isLocked: edge.relation !== 'context',
      x: source.x + source.width / 2,
      y: source.y + source.height / 2,
      meta: { atomflowCanonical: true, atomflowEdgeId: edge.id, atomflowRelation: edge.relation },
      props: {
        start: { x: 0, y: 0 },
        end: { x: target.x - source.x, y: target.y - source.y },
        color: 'blue',
        dash: 'solid',
        size: 'm',
        arrowheadEnd: 'arrow',
      },
    };
    if (editor.getShape(id)) editor.updateShape(shapePartial as never);
    else editor.createShape(shapePartial as never);

    const upsertBinding = (terminal: 'start' | 'end', toId: TLShapeId) => {
      const matches = editor.getBindingsFromShape(id, 'arrow').filter(binding => binding.props.terminal === terminal);
      const props = { terminal, normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: 'none' as const };
      if (matches[0]) {
        editor.updateBinding({ id: matches[0].id, type: 'arrow', toId, props });
        if (matches.length > 1) editor.deleteBindings(matches.slice(1));
      } else {
        editor.createBinding({ fromId: id, toId, type: 'arrow', props });
      }
    };
    upsertBinding('start', sourceId);
    upsertBinding('end', targetId);
  }, []);

  const syncEditorWithDetail = useCallback((editor: Editor, nextDetail: WriteCanvasProjectDetail) => {
    isSyncingEditorRef.current = true;
    editor.store.mergeRemoteChanges(() => {
      editor.run(() => {
        const backendShapeIds = new Set(nextDetail.nodes.map(node => shapeIdForNode(node.id)));
        const backendEdgeShapeIds = new Set(nextDetail.edges.map(edge => shapeIdForEdge(edge.id)));
        const existingShapes = editor.getCurrentPageShapes() as CanvasShape[];

        for (const shape of existingShapes) {
          if (isAtomFlowShape(shape) && !backendShapeIds.has(shape.id)) editor.deleteShapes([shape.id]);
          if (shape.type === 'arrow' && edgeIdFromShape(shape.id) && !backendEdgeShapeIds.has(shape.id)) editor.deleteShapes([shape.id]);
        }

        for (const node of nextDetail.nodes) {
          const id = shapeIdForNode(node.id);
          const props = {
            w: node.width,
            h: node.height,
            nodeId: String(node.id),
            kind: node.kind,
            role: node.role || 'material',
            status: node.status || 'ready',
            contentType: node.contentType || '',
            businessRef: node.businessRef || '',
            title: node.title,
            summary: node.summary || '',
          };
          if (!editor.getShape(id)) editor.createShape({ id, type: 'atomflow-node', x: node.x, y: node.y, props } as never);
          else editor.updateShape({ id, type: 'atomflow-node', x: node.x, y: node.y, props } as never);
        }

        for (const edge of nextDetail.edges) {
          const source = nextDetail.nodes.find(node => node.id === edge.sourceNodeId);
          const target = nextDetail.nodes.find(node => node.id === edge.targetNodeId);
          if (source && target) createBoundEdge(editor, edge, source, target);
        }
      }, { history: 'ignore', ignoreShapeLock: true });
    });

    const storedCamera = getStoredCamera(nextDetail.project.viewport);
    if (storedCamera && restoredCameraProjectRef.current !== nextDetail.project.id) {
      editor.setCamera(storedCamera);
      restoredCameraProjectRef.current = nextDetail.project.id;
    }
    window.setTimeout(() => { isSyncingEditorRef.current = false; }, 0);
  }, [createBoundEdge]);

  useEffect(() => {
    if (detail && editorRef.current) syncEditorWithDetail(editorRef.current, detail);
  }, [detail, syncEditorWithDetail]);

  useEffect(() => {
    if (activePanel !== 'inspector' || !selectedNodeId) return;
    const editor = editorRef.current;
    const shapeId = shapeIdForNode(selectedNodeId);
    if (editor?.getShape(shapeId) && !editor.getSelectedShapeIds().includes(shapeId)) {
      editor.select(shapeId);
    }
  }, [activePanel, detail, selectedNodeId]);

  const connectNodes = useCallback(async (sourceNodeId: number, targetNodeId: number, options?: { quiet?: boolean }) => {
    const projectId = currentProjectIdRef.current;
    if (!projectId) return false;
    const response = await fetch('/api/write/canvas/edges', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, sourceNodeId, targetNodeId }),
    });
    if (!response.ok) {
      if (!options?.quiet) showToast('连接失败：请从资料节点连接到 Agent');
      return false;
    }
    await loadProjectDetail(projectId);
    if (!options?.quiet) showToast('已加入 Agent 上下文');
    return true;
  }, [loadProjectDetail, showToast]);

  const removeEdge = useCallback(async (edge: WriteCanvasEdge, options?: { quiet?: boolean }) => {
    if (pendingDeletedEdgeIdsRef.current.has(edge.id)) return;
    pendingDeletedEdgeIdsRef.current.add(edge.id);
    let removed = false;
    try {
      const response = await fetch('/api/write/canvas/edges', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: edge.id }),
      });
      const projectId = currentProjectIdRef.current;
      removed = response.ok;
      if (projectId) await loadProjectDetail(projectId);
      if (!removed && !options?.quiet) showToast('断开连接失败');
    } catch {
      if (!options?.quiet) showToast('断开连接失败');
    } finally {
      pendingDeletedEdgeIdsRef.current.delete(edge.id);
      if (!removed) {
        const projectId = currentProjectIdRef.current;
        if (projectId) void loadProjectDetail(projectId);
      }
    }
  }, [loadProjectDetail, showToast]);

  const deleteNodeById = useCallback(async (nodeId: number, options?: { quiet?: boolean }) => {
    if (pendingDeletedNodeIdsRef.current.has(nodeId)) return;
    pendingDeletedNodeIdsRef.current.add(nodeId);
    const nodeProjectId = pendingNodeGeometryRef.current.get(nodeId)?.projectId || currentProjectIdRef.current;
    let removed = false;
    let restoredFromServer = false;
    let failureMessage = '删除节点失败，已恢复画布';
    try {
      const response = await fetch(`/api/write/canvas/nodes/${nodeId}`, { method: 'DELETE' });
      if (response.ok) {
        removed = true;
        pendingNodeGeometryRef.current.delete(nodeId);
        persistPendingNodeGeometryDraft(nodeProjectId);
        if (nodeProjectId && currentProjectIdRef.current === nodeProjectId) await loadProjectDetail(nodeProjectId);
        if (!options?.quiet) showToast('节点已删除');
      } else {
        const payload = await response.json().catch(() => null) as { code?: unknown; error?: unknown } | null;
        failureMessage = payload?.code === 'CANVAS_AI_ACTIVE'
          ? '节点正在执行 AI 任务，完成后才能删除'
          : typeof payload?.error === 'string' && payload.error.trim()
            ? payload.error
            : failureMessage;
        if (payload?.code === 'CANVAS_AI_ACTIVE' && nodeProjectId && currentProjectIdRef.current === nodeProjectId) {
          restoredFromServer = Boolean(await loadProjectDetail(nodeProjectId));
        }
      }
    } catch {
      failureMessage = '网络中断，节点未删除并已恢复画布';
    } finally {
      pendingDeletedNodeIdsRef.current.delete(nodeId);
      if (!removed) {
        const editor = editorRef.current;
        const currentDetail = detailRef.current;
        if (editor && currentDetail && currentDetail.project.id === nodeProjectId) syncEditorWithDetail(editor, currentDetail);
        if (!restoredFromServer && nodeProjectId && currentProjectIdRef.current === nodeProjectId) {
          await loadProjectDetail(nodeProjectId);
        }
        showToast(failureMessage);
      }
    }
  }, [loadProjectDetail, persistPendingNodeGeometryDraft, showToast, syncEditorWithDetail]);

  const reconcileSelection = useCallback((editor: Editor) => {
    const currentDetail = detailRef.current;
    if (!currentDetail) return;

    const selectedIds = editor.getSelectedShapeIds();
    if (selectedIds.length !== 1) {
      setSelectedNodeId(null);
      if (activePanelRef.current === 'inspector') setActivePanel(null);
      return;
    }

    const selectedBusinessShape = editor.getShape(selectedIds[0]);
    const selectedBusinessNodeId = nodeIdFromShape(selectedBusinessShape);
    if (selectedBusinessNodeId) {
      if (activePanelRef.current !== 'add') {
        setSelectedNodeId(selectedBusinessNodeId);
        setActivePanel('inspector');
      }
    } else {
      setSelectedNodeId(null);
      if (activePanelRef.current === 'inspector') setActivePanel(null);
    }
  }, []);

  const reconcileUserDocumentChanges = useCallback((editor: Editor, removedRecords: CanvasStoreRecord[]) => {
    const currentDetail = detailRef.current;
    if (!currentDetail) return;

    for (const record of removedRecords) {
      if (record.typeName !== 'shape') continue;
      if (record.type === 'atomflow-node') {
        const nodeId = Number(record.props?.nodeId);
        if (Number.isFinite(nodeId)) void deleteNodeById(nodeId, { quiet: true });
      }
      if (record.type === 'arrow' && record.meta?.atomflowCanonical === true) {
        const edgeId = Number(record.meta.atomflowEdgeId);
        const edge = currentDetail.edges.find(item => item.id === edgeId);
        if (edge) void removeEdge(edge, { quiet: true });
      }
    }

    for (const shape of editor.getCurrentPageShapes()) {
      if (shape.type !== 'arrow' || edgeIdFromShape(shape.id) || pendingArrowIdsRef.current.has(String(shape.id))) continue;
      const bindings = getArrowBindings(editor, shape as TLArrowShape);
      if (!bindings.start || !bindings.end) continue;
      const sourceNodeId = nodeIdFromShape(editor.getShape(bindings.start.toId));
      const targetNodeId = nodeIdFromShape(editor.getShape(bindings.end.toId));
      if (!sourceNodeId || !targetNodeId) continue;
      const source = currentDetail.nodes.find(node => node.id === sourceNodeId);
      const target = currentDetail.nodes.find(node => node.id === targetNodeId);
      pendingArrowIdsRef.current.add(String(shape.id));
      const targetAcceptsContext = target?.kind === 'agent'
        || (target?.role === 'task' && target?.contentType === 'agent_group');
      if (source && targetAcceptsContext && source.kind !== 'agent' && source.role !== 'task') {
        void connectNodes(source.id, target.id, { quiet: true }).finally(() => {
          editor.store.mergeRemoteChanges(() => {
            editor.run(() => {
              if (editor.getShape(shape.id)) editor.deleteShapes([shape.id]);
            }, { history: 'ignore' });
          });
          pendingArrowIdsRef.current.delete(String(shape.id));
        });
      } else {
        editor.store.mergeRemoteChanges(() => {
          editor.run(() => editor.deleteShapes([shape.id]), { history: 'ignore' });
        });
        pendingArrowIdsRef.current.delete(String(shape.id));
        showToast('上下文连线需要从资料节点指向 Agent');
      }
    }
  }, [connectNodes, deleteNodeById, removeEdge, showToast]);

  const reconcileCanonicalArrowChanges = useCallback(async (editor: Editor, changedRecords: CanvasStoreRecord[]) => {
    const currentDetail = detailRef.current;
    const projectId = currentProjectIdRef.current;
    if (!currentDetail || !projectId) return;

    const affectedArrowIds = new Set<TLShapeId>();
    for (const record of changedRecords) {
      if (record.typeName === 'shape' && record.type === 'arrow') affectedArrowIds.add(record.id as TLShapeId);
      if (record.typeName === 'binding' && record.type === 'arrow' && record.fromId) affectedArrowIds.add(record.fromId);
    }

    for (const arrowId of affectedArrowIds) {
      const shape = editor.getShape(arrowId);
      if (!shape || shape.type !== 'arrow' || shape.meta?.atomflowCanonical !== true) continue;
      const edgeId = Number(shape.meta.atomflowEdgeId);
      const edge = currentDetail.edges.find(item => item.id === edgeId);
      if (!edge || pendingCanonicalEdgeIdsRef.current.has(edgeId)) continue;
      const bindings = getArrowBindings(editor, shape as TLArrowShape);
      const sourceNodeId = bindings.start ? nodeIdFromShape(editor.getShape(bindings.start.toId)) : null;
      const targetNodeId = bindings.end ? nodeIdFromShape(editor.getShape(bindings.end.toId)) : null;
      if (sourceNodeId === edge.sourceNodeId && targetNodeId === edge.targetNodeId) continue;

      if (edge.relation !== 'context') {
        const canonicalSource = currentDetail.nodes.find(node => node.id === edge.sourceNodeId);
        const canonicalTarget = currentDetail.nodes.find(node => node.id === edge.targetNodeId);
        if (canonicalSource && canonicalTarget) {
          editor.store.mergeRemoteChanges(() => {
            editor.run(
              () => createBoundEdge(editor, edge, canonicalSource, canonicalTarget),
              { history: 'ignore', ignoreShapeLock: true },
            );
          });
        }
        continue;
      }

      const source = currentDetail.nodes.find(node => node.id === sourceNodeId);
      const target = currentDetail.nodes.find(node => node.id === targetNodeId);
      pendingCanonicalEdgeIdsRef.current.add(edgeId);
      try {
        const targetAcceptsContext = target?.kind === 'agent'
          || (target?.role === 'task' && target?.contentType === 'agent_group');
        if (source && targetAcceptsContext && source.kind !== 'agent' && source.role !== 'task') {
          const replaceResponse = await fetch('/api/write/canvas/edges/replace', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ edgeId, sourceNodeId: source.id, targetNodeId: target.id }),
          });
          if (!replaceResponse.ok) throw new Error('edge replace failed');
        } else {
          showToast('上下文连线需要从资料节点指向 Agent');
        }
      } catch {
        showToast('连接更新失败，已恢复服务器中的连接');
      } finally {
        pendingCanonicalEdgeIdsRef.current.delete(edgeId);
        await loadProjectDetail(projectId);
      }
    }
  }, [createBoundEdge, loadProjectDetail, showToast]);

  const onMount = useCallback((editor: Editor) => {
    editorRef.current = editor;
    if (detailRef.current) window.setTimeout(() => syncEditorWithDetail(editor, detailRef.current!), 0);
    const stopSelectionListener = editor.store.listen(() => {
      if (editorChangeTimerRef.current) window.clearTimeout(editorChangeTimerRef.current);
      editorChangeTimerRef.current = window.setTimeout(() => reconcileSelection(editor), 80);

      if (viewportSyncTimerRef.current) window.clearTimeout(viewportSyncTimerRef.current);
      viewportSyncTimerRef.current = window.setTimeout(() => {
        const projectId = currentProjectIdRef.current;
        if (projectId) {
          const camera = editor.getCamera();
          void fetch(`/api/write/canvas/projects/${projectId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ viewport: { camera: { x: camera.x, y: camera.y, z: camera.z } } }),
          }).catch(() => undefined);
        }
      }, 700);
    });
    const stopGeometryListener = editor.store.listen(({ changes }) => {
      if (isSyncingEditorRef.current) return;
      const projectId = currentProjectIdRef.current;
      if (!projectId) return;
      const changedRecords = getChangedNodeGeometryRecords(changes as unknown as {
        added: Record<string, unknown>;
        updated: Record<string, unknown>;
      });
      for (const record of changedRecords) {
        const nodeId = Number(record.props?.nodeId);
        const geometry = [record.x, record.y, record.props?.w, record.props?.h].map(Number);
        if (!Number.isSafeInteger(nodeId) || nodeId <= 0 || !geometry.every(Number.isFinite)) continue;
        const previous = pendingNodeGeometryRef.current.get(nodeId);
        const canonical = detailRef.current?.nodes.find(node => node.id === nodeId);
        const baseUpdatedAt = previous?.baseUpdatedAt || canonical?.updatedAt || '';
        if (!baseUpdatedAt) continue;
        pendingNodeGeometryRef.current.set(nodeId, {
          projectId,
          baseUpdatedAt,
          x: geometry[0],
          y: geometry[1],
          width: geometry[2],
          height: geometry[3],
          persisted: false,
        });
      }
      if (!changedRecords.length) return;
      persistPendingNodeGeometryDraft(projectId);
      if (positionSyncTimerRef.current) window.clearTimeout(positionSyncTimerRef.current);
      positionSyncTimerRef.current = window.setTimeout(() => {
        void flushPendingNodeGeometry(projectId);
      }, 700);
    }, { source: 'user', scope: 'document' });
    const stopDocumentListener = editor.store.listen(({ changes }) => {
      const removedRecords = Object.values(changes.removed) as CanvasStoreRecord[];
      const changedRecords = [
        ...Object.values(changes.added),
        ...Object.values(changes.updated).map(change => Array.isArray(change) ? change[1] : change),
        ...removedRecords,
      ] as CanvasStoreRecord[];
      window.setTimeout(() => reconcileUserDocumentChanges(editor, removedRecords), 0);
      window.setTimeout(() => { void reconcileCanonicalArrowChanges(editor, changedRecords); }, 0);
    }, { source: 'user', scope: 'document' });
    return () => {
      stopSelectionListener();
      stopGeometryListener();
      stopDocumentListener();
      if (editorChangeTimerRef.current) window.clearTimeout(editorChangeTimerRef.current);
      if (viewportSyncTimerRef.current) window.clearTimeout(viewportSyncTimerRef.current);
    };
  }, [flushPendingNodeGeometry, persistPendingNodeGeometryDraft, reconcileCanonicalArrowChanges, reconcileSelection, reconcileUserDocumentChanges, syncEditorWithDetail]);

  const getViewportPlacement = useCallback((width: number, height: number) => {
    const bounds = editorRef.current?.getViewportPageBounds();
    if (!bounds) return { x: 180, y: 180, width, height };
    return {
      x: bounds.x + bounds.w / 2 - width / 2,
      y: bounds.y + bounds.h / 2 - height / 2,
      width,
      height,
    };
  }, []);

  const finishNodeAddition = useCallback(async (node: WriteCanvasNode | null) => {
    if (!node) return;
    const targetAgentId = contextAgentNodeId;
    if (targetAgentId && node.kind !== 'agent') {
      await connectNodes(node.id, targetAgentId, { quiet: true });
      selectNode(targetAgentId);
    } else {
      selectNode(node.id);
    }
    setContextAgentNodeId(null);
    setActivePanel('inspector');
  }, [connectNodes, contextAgentNodeId, selectNode]);

  const createNode = useCallback(async (payload: Record<string, unknown>, options?: { open?: boolean }) => {
    const projectId = currentProjectIdRef.current;
    if (!projectId) return null;
    const response = await fetch(`/api/write/canvas/projects/${projectId}/nodes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      showToast('添加节点失败');
      return null;
    }
    const data = await response.json();
    await loadProjectDetail(projectId);
    const node = data.node as WriteCanvasNode | null;
    if (options?.open !== false) await finishNodeAddition(node);
    return node;
  }, [finishNodeAddition, loadProjectDetail, showToast]);

  const createStructureEdge = useCallback(async (sourceNodeId: number, targetNodeId: number) => {
    const projectId = currentProjectIdRef.current;
    if (!projectId) return false;
    const response = await fetch('/api/write/canvas/edges', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, sourceNodeId, targetNodeId, relation: 'structure' }),
    });
    if (!response.ok) {
      showToast('结构连接创建失败');
      return false;
    }
    await loadProjectDetail(projectId);
    return true;
  }, [loadProjectDetail, showToast]);

  const createInsightBranch = useCallback(async (parent: WriteCanvasNode) => {
    const currentDetail = detailRef.current;
    const childCount = currentDetail?.edges.filter(edge => edge.relation === 'structure' && edge.sourceNodeId === parent.id).length || 0;
    const node = await createNode({
      kind: 'asset_text',
      role: 'insight',
      origin: 'manual',
      status: 'editing',
      title: `子节点：${parent.title}`,
      content: '',
      x: parent.x + 380,
      y: parent.y + childCount * 220,
      width: 300,
      height: 180,
    }, { open: false });
    if (!node) return;
    const linked = await createStructureEdge(parent.id, node.id);
    if (!linked) {
      await fetch(`/api/write/canvas/nodes/${node.id}`, { method: 'DELETE' });
      const projectId = currentProjectIdRef.current;
      if (projectId) await loadProjectDetail(projectId);
      return;
    }
    selectNode(node.id);
  }, [createNode, createStructureEdge, loadProjectDetail, selectNode]);

  const createDocumentFromNode = useCallback(async (source: WriteCanvasNode) => {
    const projectId = currentProjectIdRef.current;
    if (!projectId) return;
    const response = await fetch(`/api/write/canvas/projects/${projectId}/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceNodeId: source.id,
        title: `${source.title}作品`,
        summary: source.summary || '',
        scenario: 'custom-longform',
        status: 'editing',
        sections: [{ key: 'opening', heading: '开场', body: '', level: 1, meta: {} }],
        x: source.x + 380,
        y: source.y,
        width: 420,
        height: 320,
      }),
    });
    if (!response.ok) return showToast('创建作品失败');
    const payload = await response.json() as { document?: { id?: number; nodeId?: number } };
    await loadProjectDetail(projectId);
    const documentId = Number(payload.document?.id);
    const nodeId = Number(payload.document?.nodeId) || detailRef.current?.nodes.find(node => node.document?.id === documentId)?.id;
    if (Number.isFinite(nodeId)) selectNode(nodeId);
  }, [loadProjectDetail, selectNode, showToast]);

  const createManualInsight = () => createNode({
    kind: 'asset_text',
    role: 'insight',
    contentType: 'idea',
    origin: 'manual',
    status: 'editing',
    title: '新的知识节点',
    content: '',
    ...getViewportPlacement(300, 180),
  });

  const createBlankDocument = async () => {
    const projectId = currentProjectIdRef.current;
    if (!projectId) return;
    const placement = getViewportPlacement(420, 320);
    const response = await fetch(`/api/write/canvas/projects/${projectId}/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '未命名作品',
        summary: '',
        scenario: 'custom-longform',
        status: 'editing',
        sections: createScenarioSections('custom-longform'),
        ...placement,
      }),
    });
    if (!response.ok) return showToast('创建作品失败');
    const payload = await response.json() as { document?: { id?: number; nodeId?: number } };
    await loadProjectDetail(projectId);
    const nodeId = Number(payload.document?.nodeId);
    setActivePanel(null);
    if (Number.isFinite(nodeId)) selectNode(nodeId);
  };

  const openAgentGroups = useCallback((groupId?: number | null) => {
    closeQuickAction();
    setInitialAgentGroupId(groupId || null);
    setContextAgentNodeId(null);
    setActivePanel('agent-group');
  }, [closeQuickAction]);

  const handleAgentGroupCreated = async (group: WriteCanvasAgentGroup) => {
    const projectId = currentProjectIdRef.current;
    if (!projectId || !Number.isFinite(group.nodeId)) return showToast('Agent 组任务节点创建失败');
    await loadProjectDetail(projectId);
    setInitialAgentGroupId(group.id);
    selectNode(group.nodeId, false);
  };

  const refreshAgentGroupProject = useCallback(async () => {
    const projectId = currentProjectIdRef.current;
    if (projectId) await loadProjectDetail(projectId);
  }, [loadProjectDetail]);

  const handleAgentGroupResults = async (nodeIds: number[]) => {
    const projectId = currentProjectIdRef.current;
    if (projectId) await loadProjectDetail(projectId);
    setActivePanel(null);
    if (nodeIds[0]) selectNode(nodeIds[0]);
  };

  const submitAiDecomposition = async () => {
    const source = detailRef.current?.nodes.find(node => node.id === aiDecomposeNodeId);
    if (!source || isQuickActionRunning) return;
    const projectId = currentProjectIdRef.current;
    if (!projectId) return;
    const abortController = new AbortController();
    const runSequence = ++quickActionRunSequenceRef.current;
    const isCurrentQuickAction = () => quickActionRunSequenceRef.current === runSequence
      && quickActionAbortControllerRef.current === abortController;
    const runStartedAt = Date.now();
    let observedRunId: number | null = null;
    let projectReloaded = false;
    quickActionAbortControllerRef.current = abortController;
    setIsQuickActionRunning(true);
    setQuickActionStatus('正在读取节点内容');
    try {
      const response = await fetch(`/api/write/canvas/nodes/${source.id}/actions/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: aiQuickAction }),
        signal: abortController.signal,
      });
      if (!response.ok || !response.body) throw new Error('AI 操作启动失败');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let outputNodeIds: number[] = [];
      let receivedFinal = false;
      const consumeEvents = (events: ReturnType<typeof parseSseEvents>) => {
        for (const event of events) {
          const eventRunId = Number(event.payload.runId);
          if (Number.isSafeInteger(eventRunId) && eventRunId > 0) observedRunId = eventRunId;
        }
        const errorEvent = events.find(event => event.event === 'error');
        if (errorEvent) throw new Error(String(errorEvent.payload.message || 'AI 操作失败'));
        events
          .filter(event => event.event === 'partial_status')
          .forEach(event => {
            if (isCurrentQuickAction()) setQuickActionStatus(String(event.payload.message || '正在生成'));
          });
        for (const event of events.filter(item => item.event === 'final')) {
          if (!Array.isArray(event.payload.outputNodeIds)) {
            throw new Error('AI 返回格式错误：终态缺少结果节点');
          }
          outputNodeIds = event.payload.outputNodeIds.map(Number).filter(Number.isFinite);
          receivedFinal = true;
        }
      };
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const boundary = buffer.lastIndexOf('\n\n');
        if (boundary < 0) continue;
        consumeEvents(parseSseEvents(buffer.slice(0, boundary + 2)));
        buffer = buffer.slice(boundary + 2);
      }
      buffer += decoder.decode();
      if (buffer.trim()) consumeEvents(parseSseEvents(buffer));
      if (!receivedFinal) throw new Error('AI 返回中断：未收到完成事件');
      await loadProjectDetail(projectId);
      projectReloaded = true;
      if (isCurrentQuickAction()) {
        setAiDecomposeNodeId(null);
        if (outputNodeIds[0]) selectNode(outputNodeIds[0]);
        showToast('AI 结果已生成到画布');
      }
    } catch (error) {
      if (isCurrentQuickAction() && !(error instanceof DOMException && error.name === 'AbortError')) {
        showToast(error instanceof Error ? error.message : 'AI 操作失败');
      }
    } finally {
      if (!projectReloaded && currentProjectIdRef.current === projectId) {
        try {
          await reconcileQuickActionRun(projectId, source.id, aiQuickAction, observedRunId, runStartedAt, runSequence);
        } catch {
          // The next normal project refresh will retry reconciliation.
        }
      }
      if (isCurrentQuickAction()) {
        quickActionAbortControllerRef.current = null;
        setIsQuickActionRunning(false);
        setQuickActionStatus('');
      }
    }
  };

  useEffect(() => {
    const actionHandler = (event: Event) => {
      const detail = (event as CustomEvent<{ nodeId?: number; action?: CanvasNodeAction }>).detail;
      const node = detailRef.current?.nodes.find(item => item.id === Number(detail?.nodeId));
      if (!node || !detail?.action) return;
      if (detail.action === 'new-child') void createInsightBranch(node);
      if (detail.action === 'create-document') void createDocumentFromNode(node);
      if (detail.action === 'ai-decompose') {
        closeQuickAction();
        setActivePanel(null);
        setContextAgentNodeId(null);
        setAiDecomposeNodeId(node.id);
        setAiQuickAction('extract_insights');
        setQuickActionStatus('');
      }
      if (detail.action === 'run-agent-group' && Number.isFinite(Number(node.businessRef))) openAgentGroups(Number(node.businessRef));
    };
    const keyHandler = (event: KeyboardEvent) => {
      const isTab = event.key === 'Tab';
      const isEnter = event.key === 'Enter';
      if (!isTab && !isEnter) return;
      if ((!isTab && event.defaultPrevented) || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (activePanel !== null || activePanelRef.current !== null || aiDecomposeNodeId !== null || projectMenuOpen) return;
      const target = event.target instanceof Element ? event.target : null;
      const activeElement = document.activeElement instanceof Element ? document.activeElement : null;
      const interactiveSelector = 'input, textarea, select, button, a[href], [contenteditable]:not([contenteditable="false"]), [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"]';
      if (target?.closest(interactiveSelector) || activeElement?.closest(interactiveSelector)) return;
      const editor = editorRef.current;
      const selectedShapeIds = editor?.getSelectedShapeIds() || [];
      if (!editor || selectedShapeIds.length !== 1) return;
      const selectedBusinessNodeId = nodeIdFromShape(editor.getShape(selectedShapeIds[0]));
      if (!selectedBusinessNodeId) return;
      const selected = detailRef.current?.nodes.find(node => node.id === selectedBusinessNodeId);
      if (!selected) return;
      event.preventDefault();
      const incomingStructure = detailRef.current?.edges.find(edge => edge.relation === 'structure' && edge.targetNodeId === selected.id);
      const parent = isEnter && incomingStructure
        ? detailRef.current?.nodes.find(node => node.id === incomingStructure.sourceNodeId) || selected
        : selected;
      void createInsightBranch(parent);
    };
    window.addEventListener('atomflow-canvas-node-action', actionHandler);
    window.addEventListener('keydown', keyHandler);
    return () => {
      window.removeEventListener('atomflow-canvas-node-action', actionHandler);
      window.removeEventListener('keydown', keyHandler);
    };
  }, [activePanel, aiDecomposeNodeId, closeQuickAction, createDocumentFromNode, createInsightBranch, openAgentGroups, projectMenuOpen]);

  const createProject = () => loginAndDo(async () => {
    const response = await fetch('/api/write/canvas/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '新的魔法写作项目' }),
    });
    if (!response.ok) return showToast('新建项目失败');
    const payload = await response.json();
    setProjects(previous => [payload.project, ...previous]);
    await switchProject(payload.project.id);
  });

  const renameCurrentProject = () => loginAndDo(async () => {
    if (!detail) return;
    const name = window.prompt('项目名称', detail.project.name)?.trim();
    if (!name || name === detail.project.name) return;
    const response = await fetch(`/api/write/canvas/projects/${detail.project.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!response.ok) return showToast('重命名项目失败');
    const payload = await response.json();
    setProjects(previous => previous.map(project => project.id === payload.project.id ? payload.project : project));
    setDetail(previous => previous ? { ...previous, project: payload.project } : previous);
  });

  const deleteCurrentProject = () => loginAndDo(async () => {
    if (!detail || !window.confirm(`删除项目「${detail.project.name}」？`)) return;
    const response = await fetch(`/api/write/canvas/projects/${detail.project.id}`, { method: 'DELETE' });
    if (!response.ok) return showToast('删除项目失败');
    const projectsResponse = await fetch('/api/write/canvas/projects');
    if (!projectsResponse.ok) return;
    const payload = await projectsResponse.json();
    const nextProjects: WriteCanvasProject[] = Array.isArray(payload.projects) ? payload.projects : [];
    for (const [nodeId, geometry] of pendingNodeGeometryRef.current) {
      if (geometry.projectId === detail.project.id) pendingNodeGeometryRef.current.delete(nodeId);
    }
    setProjects(nextProjects);
    await switchProject(nextProjects[0]?.id || null);
    setActivePanel(null);
  });

  const createAgentFromTemplate = (template?: WriteAgentTemplate, options?: { open?: boolean }) => createNode({
    kind: 'agent',
    title: template?.name || '写作 Agent',
    templateId: template?.id,
    ...getViewportPlacement(360, 260),
  }, options);

  useEffect(() => {
    if (!detail || !currentProjectId || detail.nodes.some(node => node.kind === 'agent')) return;
    void createAgentFromTemplate(undefined, { open: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.project.id, currentProjectId]);

  const addCardNode = (card: AtomCard) => createNode({
    kind: 'atom_card',
    refId: card.id,
    title: `${card.type} · ${card.articleTitle || '原子卡'}`,
    summary: card.content,
    ...getViewportPlacement(300, 180),
  });
  const addArticleNode = (article: SavedArticle) => createNode({
    kind: 'saved_article',
    refId: article.id,
    title: article.title,
    summary: article.excerpt,
    ...getViewportPlacement(320, 190),
  });
  const addNoteNode = (note: Note) => createNode({
    kind: 'note',
    refId: note.id,
    title: note.title || '未命名文章',
    summary: note.content.replace(/<[^>]+>/g, '').slice(0, 180),
    ...getViewportPlacement(320, 200),
  });

  const addPasteNode = async () => {
    const content = pasteText.trim();
    if (!content) return;
    const node = await createNode({
      kind: 'asset_text',
      title: content.slice(0, 24) || '粘贴文本',
      content,
      ...getViewportPlacement(300, 200),
    });
    if (node) setPasteText('');
  };

  const uploadFile = async (file: File) => {
    const projectId = currentProjectIdRef.current;
    if (!projectId) return;
    const placement = getViewportPlacement(file.type.startsWith('image/') ? 280 : 300, file.type.startsWith('image/') ? 220 : 190);
    const form = new FormData();
    form.append('projectId', String(projectId));
    form.append('x', String(placement.x));
    form.append('y', String(placement.y));
    form.append('file', file);
    const response = await fetch('/api/write/canvas/assets/upload', { method: 'POST', body: form });
    if (!response.ok) return showToast('上传失败');
    const payload = await response.json();
    await loadProjectDetail(projectId);
    await finishNodeAddition(payload.node || null);
    showToast('已添加上传资料');
  };

  const updateSelectedAgent = async (data: Record<string, unknown>) => {
    if (!selectedNode?.agent) return;
    const response = await fetch(`/api/write/canvas/nodes/${selectedNode.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const projectId = currentProjectIdRef.current;
    if (!response.ok || !projectId) return showToast('Agent 更新失败');
    await loadProjectDetail(projectId);
    showToast('Agent 设置已保存');
  };

  const updateCanvasNode = async (node: WriteCanvasNode, data: Record<string, unknown>) => {
    const response = await fetch(`/api/write/canvas/nodes/${node.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const projectId = currentProjectIdRef.current;
    if (!response.ok || !projectId) return showToast('节点更新失败');
    await loadProjectDetail(projectId);
  };

  const saveTemplate = async (draft: AgentDraft) => {
    const response = await fetch('/api/write/agent/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: draft.title,
        model: draft.model,
        systemPrompt: draft.systemPrompt,
        temperature: draft.temperature,
        topP: draft.topP,
        maxTokens: draft.maxTokens,
      }),
    });
    if (!response.ok) return showToast('模板保存失败');
    await loadTemplates();
    showToast('已保存为 Agent 模板');
  };

  const sendAgentMessage = async () => {
    if (!selectedNode?.agent || !agentInput.trim()) return;
    const agentId = selectedNode.agent.id;
    const projectId = currentProjectIdRef.current;
    const message = agentInput.trim();
    let observedAgentRunId = '';
    setAgentInput('');
    setIsAgentRunning(true);
    try {
      const response = await fetch(`/api/write/canvas/agents/${agentId}/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      if (!response.ok || !response.body) throw new Error('Agent 请求失败');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let receivedTerminal = false;
      const consumeAgentEvents = async (events: ReturnType<typeof parseSseEvents>) => {
        for (const event of events) {
          if (typeof event.payload.runId === 'string' && event.payload.runId) observedAgentRunId = event.payload.runId;
        }
        const error = events.find(event => event.event === 'error');
        if (error) {
          receivedTerminal = true;
          throw new Error(String(error.payload.message || 'Agent 暂时不可用'));
        }
        if (events.some(event => event.event === 'final')) {
          receivedTerminal = true;
          if (projectId) await loadProjectDetail(projectId);
        }
      };
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const boundary = buffer.lastIndexOf('\n\n');
        if (boundary < 0) continue;
        const events = parseSseEvents(buffer.slice(0, boundary + 2));
        buffer = buffer.slice(boundary + 2);
        await consumeAgentEvents(events);
      }
      if (buffer.trim()) await consumeAgentEvents(parseSseEvents(buffer));
      if (!receivedTerminal) throw new Error('Agent 连接提前结束，请重试');
    } catch (error) {
      let persistedResult = false;
      if (projectId && observedAgentRunId) {
        const refreshed = await loadProjectDetail(projectId);
        persistedResult = Boolean(refreshed?.messages[agentId]?.some(item => (
          item.role === 'assistant' && String(item.meta?.runId || '') === observedAgentRunId
        )));
      }
      if (persistedResult) {
        showToast('Agent 已完成，已恢复生成结果');
      } else {
        setAgentInput(current => current.trim() ? current : message);
        showToast(error instanceof Error ? error.message : 'Agent 暂时不可用');
      }
    } finally {
      setIsAgentRunning(false);
    }
  };

  const saveMessageToCanvas = async (message: WriteCanvasMessage) => {
    if (!selectedNode?.agent) return;
    const response = await fetch(`/api/write/canvas/agents/${selectedNode.agent.id}/save-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId: message.id, title: message.content.slice(0, 24) || 'Agent 输出' }),
    });
    const projectId = currentProjectIdRef.current;
    if (!response.ok || !projectId) return showToast('保存到画布失败');
    const payload = await response.json();
    await loadProjectDetail(projectId);
    if (payload.node?.id) selectNode(Number(payload.node.id));
    showToast('已保存到画布');
  };

  const openAddDrawer = (agentNodeId?: number) => {
    closeQuickAction();
    setContextAgentNodeId(agentNodeId || null);
    setProjectMenuOpen(false);
    setActivePanel('add');
  };

  const deleteSelectedNode = async (node: WriteCanvasNode) => {
    if (!window.confirm(`删除节点「${node.title}」？`)) return;
    closeInspector();
    await deleteNodeById(node.id);
  };

  if (!user) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center rounded-[12px] border border-border bg-surface">
        <button onClick={() => loginAndDo(() => undefined)} className="rounded-[7px] bg-accent px-5 py-3 text-[13px] font-medium text-white">登录后使用魔法写作画布</button>
      </div>
    );
  }

  const licenseKey = (import.meta.env.VITE_TLDRAW_LICENSE_KEY || '') as string;
  const productionMissingLicense = import.meta.env.PROD && !licenseKey;

  return (
    <div className="relative isolate h-full min-h-0 overflow-hidden rounded-[12px] border border-[#D9D8D3] bg-[#F4F4F1]">
      <main className="absolute inset-0 z-0 bg-[#F4F4F1]">
        {productionMissingLicense ? (
          <div className="absolute inset-0 z-[100] flex items-center justify-center bg-white/95 px-8 text-center text-[13px] text-text2">生产环境需要配置 VITE_TLDRAW_LICENSE_KEY 后才能打开画布。</div>
        ) : null}
        <Tldraw shapeUtils={shapeUtils} onMount={onMount} licenseKey={licenseKey || undefined} components={{ DebugPanel: null, SharePanel: null }} />
      </main>

      <div onPointerDown={event => event.stopPropagation()} className="absolute left-4 top-4 z-[70] flex items-start gap-2">
        <div className="relative">
          <button
            type="button"
            onClick={() => setProjectMenuOpen(value => !value)}
            className="flex h-10 max-w-[280px] items-center gap-2 rounded-[7px] border border-[#D9D8D3] bg-white/96 px-3 text-left text-[12px] font-medium text-[#2F343A] shadow-[0_8px_24px_rgba(35,40,48,0.12)] backdrop-blur hover:border-[#9FB8DB]"
          >
            <span className="truncate">{detail?.project.name || '魔法写作项目'}</span>
            <ChevronDown size={14} className="shrink-0 text-[#777C83]" />
          </button>
          {projectMenuOpen ? (
            <div className="absolute left-0 top-full mt-2 w-[280px] overflow-hidden rounded-[8px] border border-[#D9D8D3] bg-white p-1.5 shadow-[0_16px_48px_rgba(35,40,48,0.18)]">
              <div className="max-h-56 overflow-y-auto">
                {projects.map(project => (
                  <button key={project.id} type="button" onClick={() => { void switchProject(project.id); }} className={cn('w-full truncate rounded-[5px] px-3 py-2 text-left text-[11px]', project.id === currentProjectId ? 'bg-[#E7F0FF] font-medium text-[#185ABD]' : 'text-[#555A61] hover:bg-[#F2F1EE]')}>
                    {project.name}
                  </button>
                ))}
              </div>
              <div className="mt-1 border-t border-[#ECEAE5] pt-1">
                <button type="button" onClick={createProject} className="flex w-full items-center gap-2 rounded-[5px] px-3 py-2 text-[11px] text-[#185ABD] hover:bg-[#F2F6FC]"><Plus size={13} />新建项目</button>
                <button type="button" onClick={renameCurrentProject} className="flex w-full items-center gap-2 rounded-[5px] px-3 py-2 text-[11px] text-[#555A61] hover:bg-[#F2F1EE]"><Pencil size={13} />重命名当前项目</button>
                <button type="button" onClick={deleteCurrentProject} className="flex w-full items-center gap-2 rounded-[5px] px-3 py-2 text-[11px] text-[#B34439] hover:bg-[#FCEDEA]"><Trash2 size={13} />删除当前项目</button>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <button
        type="button"
        aria-label="添加节点"
        onPointerDown={event => event.stopPropagation()}
        onClick={() => openAddDrawer()}
        className="absolute bottom-4 left-4 z-[70] inline-flex h-11 items-center gap-2 rounded-[7px] bg-[#1F6FEB] px-4 text-[12px] font-semibold text-white shadow-[0_12px_28px_rgba(31,111,235,0.32)] hover:bg-[#195FC9] md:left-[180px]"
      >
        <Plus size={17} /> 添加节点
      </button>

      {activePanel === 'add' ? (
        <CanvasAddDrawer
          contextAgentTitle={contextAgentNode?.title}
          cards={savedCards}
          articles={savedArticles}
          notes={notes}
          templates={templates}
          query={query}
          pasteText={pasteText}
          onQueryChange={setQuery}
          onPasteTextChange={setPasteText}
          onClose={() => { setActivePanel(null); setContextAgentNodeId(null); }}
          onUpload={file => void uploadFile(file)}
          onAddPaste={() => void addPasteNode()}
          onAddAgent={template => void createAgentFromTemplate(template)}
          onAddInsight={() => void createManualInsight()}
          onAddDocument={() => void createBlankDocument()}
          onOpenAgentGroups={() => openAgentGroups()}
          onAddCard={card => void addCardNode(card)}
          onAddArticle={article => void addArticleNode(article)}
          onAddNote={note => void addNoteNode(note)}
        />
      ) : null}

      {activePanel === 'agent-group' && currentProjectId ? (
        <CanvasAgentGroupPanel
          projectId={currentProjectId}
          initialGroupId={initialAgentGroupId}
          nodes={detail?.nodes || []}
          edges={detail?.edges || []}
          templates={templates}
          onClose={() => setActivePanel(null)}
          onGroupCreated={handleAgentGroupCreated}
          onProjectRefresh={refreshAgentGroupProject}
          onResults={handleAgentGroupResults}
          onToast={showToast}
        />
      ) : null}

      {aiDecomposeNodeId ? (
        <div className="absolute inset-0 z-[90] flex items-end bg-[#20242A]/20 p-0 md:items-start md:justify-end md:bg-transparent md:p-4" onPointerDown={event => event.stopPropagation()}>
          <div className="h-full w-full overflow-y-auto border border-[#D8D7D2] bg-[#FCFCFA] p-4 shadow-[0_24px_72px_rgba(29,32,38,0.18)] md:h-auto md:w-[360px] md:rounded-[8px]">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-[14px] font-semibold text-[#20242A]">AI 拆解</h2>
                <p className="mt-1 text-[11px] leading-5 text-[#747980]">只读取当前节点，结果会作为可追溯的新节点放到画布。</p>
              </div>
              <button type="button" aria-label={isQuickActionRunning ? '取消 AI 拆解' : '关闭 AI 拆解'} onClick={() => closeQuickAction()} className="text-[11px] text-[#777C83] hover:text-[#20242A]">
                {isQuickActionRunning ? '取消生成' : '关闭'}
              </button>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2">
              {canvasQuickActions.map(action => (
                <button key={action.value} type="button" disabled={isQuickActionRunning} onClick={() => setAiQuickAction(action.value)} className={cn('min-h-[66px] rounded-[7px] border p-2.5 text-left transition-colors', aiQuickAction === action.value ? 'border-[#77A4EB] bg-[#EEF5FF]' : 'border-[#DEDDD8] bg-white hover:border-[#A8BBD5]')}>
                  <span className="flex items-center gap-1.5 text-[11px] font-semibold text-[#30353C]"><Sparkles size={12} className="text-[#1F6FEB]" />{action.label}</span>
                  <span className="mt-1 block text-[9px] leading-4 text-[#7B8087]">{action.description}</span>
                </button>
              ))}
            </div>
            {quickActionStatus ? <p className="mt-3 text-center text-[10px] text-[#5F6E82]">{quickActionStatus}</p> : null}
            <button type="button" disabled={isQuickActionRunning} onClick={() => void submitAiDecomposition()} className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-[6px] bg-[#1F6FEB] px-3 py-2 text-[11px] font-medium text-white hover:bg-[#195FC9] disabled:opacity-50">
              {isQuickActionRunning ? '生成中…' : `生成${canvasQuickActions.find(action => action.value === aiQuickAction)?.label || '结果'}`}
            </button>
          </div>
        </div>
      ) : null}

      {activePanel === 'inspector' && selectedNode ? (
        <CanvasInspector
          node={selectedNode}
          nodes={detail?.nodes || []}
          edges={detail?.edges || []}
          messages={selectedAgentMessages}
          agentInput={agentInput}
          isAgentRunning={isAgentRunning}
          onClose={closeInspector}
          onAgentInputChange={setAgentInput}
          onSendAgentMessage={() => void sendAgentMessage()}
          onRemoveEdge={edge => void removeEdge(edge)}
          onSaveAgent={data => void updateSelectedAgent(data)}
          onSaveTemplate={data => void saveTemplate(data)}
          onSaveMessage={message => void saveMessageToCanvas(message)}
          onOpenAddContext={agentNodeId => openAddDrawer(agentNodeId)}
          onConnectToAgent={(sourceNodeId, agentNodeId) => void connectNodes(sourceNodeId, agentNodeId)}
          onUpdateNode={(node, data) => void updateCanvasNode(node, data)}
          onDocumentSaved={() => { if (currentProjectIdRef.current) void loadProjectDetail(currentProjectIdRef.current); }}
          onOpenAgentGroup={groupId => openAgentGroups(groupId)}
          onDeleteNode={node => void deleteSelectedNode(node)}
        />
      ) : null}
    </div>
  );
};
