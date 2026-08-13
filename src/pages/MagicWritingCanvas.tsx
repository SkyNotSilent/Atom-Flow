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
  type TLUiOverrides,
} from 'tldraw';
import 'tldraw/tldraw.css';
import {
  Bot,
  ChevronDown,
  FileText,
  Image as ImageIcon,
  PanelRightOpen,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useAppContext } from '../context/AppContext';
import { CanvasAddDrawer } from '../components/write-canvas/CanvasAddDrawer';
import { CanvasInspector, type AgentDraft, type CanvasRecallCandidate } from '../components/write-canvas/CanvasInspector';
import { CanvasContextRail } from '../components/write-canvas/CanvasContextRail';
import { CanvasAgentGroupPanel } from '../components/write-canvas/CanvasAgentGroupPanel';
import { CanvasNodeCard } from '../components/write-canvas/CanvasNodeCard';
import type { CanvasNodeAction } from '../components/write-canvas/CanvasNodeAddMenu';
import type { CitationAction, CitationCapture } from '../components/ReaderModal';
import { htmlToPlainText } from '../utils/htmlToPlainText';
import type {
  Article,
  AtomCard,
  Note,
  SavedArticle,
  WriteAgentTemplate,
  WriteCanvasAgentRun,
  WriteCanvasAgentGroup,
  WriteCanvasEdge,
  WriteCanvasMessage,
  WriteCanvasNode,
  WriteCanvasNodeKind,
  WriteCanvasDocumentSnapshot,
  WriteCanvasProject,
  WriteCanvasProjectDetail,
  WriteSkillSelection,
} from '../types';
import { cn } from '../components/Nav';
import {
  CANVAS_EXTERNAL_CONTENT_CHANGED_EVENT,
  CANVAS_PROJECT_SELECTION_REQUEST_EVENT,
  publishCanvasProjectsChanged,
  publishCanvasProjectSelectionResult,
  readCanvasProjectTarget,
  resolveCanvasProjectTarget,
  type CanvasExternalContentChangedDetail,
  type CanvasProjectSelectionRequestDetail,
} from '../utils/canvasProjectTarget';
import { shouldPreserveLocalCanvasGeometry } from '../utils/canvasGeometrySync';
import {
  buildCanvasCreateArticleRequestKey,
  forgetPendingCanvasCreateArticleRequest,
  persistPendingCanvasCreateArticleRequests,
  readPendingCanvasCreateArticleRequests,
  rememberPendingCanvasCreateArticleRequest,
  shouldReplaceCanvasCreateArticleRequestId,
  type PendingCanvasCreateArticleRequests,
} from '../utils/canvasCreateArticleRequests';
import { citationArticleIdentity, stableCitationCaptureId } from '../utils/citationIdentity';
import { resolveCanvasDocumentSchemaVersion } from '../server/canvasDocument';
import { protectDraft } from '../billing/draftVault';
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

type CanvasBusinessReconciliationBatch = {
  editor: Editor;
  removedRecords: CanvasStoreRecord[];
  changedRecords: CanvasStoreRecord[];
};

const UNMANAGED_NATIVE_MEDIA_SHAPE_TYPES = new Set(['image', 'video', 'embed', 'bookmark']);
const isUnmanagedNativeMediaRecord = (record: CanvasStoreRecord) => (
  record.typeName === 'asset'
  || (record.typeName === 'shape' && typeof record.type === 'string' && UNMANAGED_NATIVE_MEDIA_SHAPE_TYPES.has(record.type))
);
const removeUnmanagedNativeMediaRecords = (editor: Editor) => {
  const recordIds = editor.store.allRecords()
    .filter(record => isUnmanagedNativeMediaRecord(record as CanvasStoreRecord))
    .map(record => record.id);
  if (recordIds.length === 0) return 0;
  editor.store.mergeRemoteChanges(() => {
    editor.run(() => editor.store.remove(recordIds as never), { history: 'ignore' });
  });
  return recordIds.length;
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
const QUICK_ACTION_RECONCILE_MAX_ATTEMPTS = 8;
const QUICK_ACTION_RECONCILE_DELAY_MS = 400;
const waitForQuickActionReconcile = () => new Promise(resolve => window.setTimeout(resolve, QUICK_ACTION_RECONCILE_DELAY_MS));
const isTerminalQuickActionRun = (run: WriteCanvasAgentRun) => (
  run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled'
);

const NODE_GEOMETRY_DRAFT_KEY_PREFIX = 'atomflow.canvas-node-geometry.v1';
const CANVAS_TAB_ID_SESSION_KEY = 'atomflow.canvas-tab-id.v1';

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

type CanvasDocumentConflict = {
  projectId: number;
  currentRevision: number;
};

type CanvasDocumentSaveTask = {
  projectId: number;
  snapshot: WriteCanvasDocumentSnapshot;
  viewport: { camera: { x: number; y: number; z: number } };
  schemaVersion: number;
  changeVersion: number;
};

type CanvasProjectSwitchOutcome = {
  status: 'confirmed' | 'rejected';
  reason?: string;
};

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
        <div
          className="h-full w-full"
          onPointerDown={() => {
            const nodeId = nodeIdFromShape(shape);
            if (!nodeId) return;
            window.dispatchEvent(new CustomEvent('atomflow-canvas-select', { detail: { nodeId } }));
          }}
        >
          <CanvasNodeCard
            node={{ id: Number.isFinite(nodeId) ? nodeId : 0, kind: shape.props.kind, role: shape.props.role, status: shape.props.status, contentType: shape.props.contentType, title: shape.props.title, summary: shape.props.summary }}
            onSelect={nodeId => window.dispatchEvent(new CustomEvent('atomflow-canvas-select', { detail: { nodeId } }))}
          />
        </div>
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

const getNodeKindLabel = (kind: WriteCanvasNodeKind) => ({
  asset_text: '粘贴文本',
  asset_file: '上传文件',
  asset_image: '图片资料',
  saved_article: '收藏文章',
  atom_card: '原子卡',
  citation: '文章引用',
  podcast_episode: '播客单集',
  note: '文章草稿',
  agent: 'Agent',
  result: '输出结果',
}[kind]);

const getNodeTone = (kind: WriteCanvasNodeKind) => {
  if (kind === 'agent') return { bg: '#EAF2FF', border: '#AFC9F5', text: '#225DAA' };
  if (kind === 'result') return { bg: '#F4EEFF', border: '#D5C5F1', text: '#6A4C96' };
  if (kind === 'asset_image') return { bg: '#EAF7F1', border: '#B9DFCE', text: '#2C7455' };
  if (kind === 'atom_card') return { bg: '#FFF5E5', border: '#EACF9F', text: '#8C5D20' };
  if (kind === 'citation') return { bg: '#FFF8E7', border: '#E4C98E', text: '#805D1F' };
  if (kind === 'podcast_episode') return { bg: '#EAF5F8', border: '#A9D1DA', text: '#276979' };
  return { bg: '#F7F5F0', border: '#D7D3CA', text: '#676057' };
};

const savedArticleToArticle = (article: SavedArticle): Article => ({
  id: article.id,
  saved: true,
  source: article.source,
  sourceIcon: article.sourceIcon,
  topic: article.topic,
  time: article.savedAt,
  publishedAt: article.publishedAt,
  title: article.title,
  excerpt: article.excerpt,
  citationContext: article.citationContext,
  sourceImages: article.sourceImages,
  content: article.content || '',
  url: article.url,
  fullFetched: Boolean(article.content),
  cards: [],
});

const citationNodeToArticle = (node: WriteCanvasNode): Article | null => {
  if (node.kind !== 'citation') return null;
  const meta = node.meta || {};
  const selection = meta.selection && typeof meta.selection === 'object'
    ? meta.selection as Record<string, unknown>
    : {};
  const article = meta.article && typeof meta.article === 'object'
    ? meta.article as Record<string, unknown>
    : {};
  const exact = typeof selection.exact === 'string' ? selection.exact : node.summary || '';
  const articleId = Number(article.id ?? meta.articleId ?? node.refId);
  return {
    id: Number.isFinite(articleId) ? articleId : node.id,
    saved: false,
    source: String(article.source ?? meta.sourceName ?? '引用来源'),
    topic: '画布引用',
    time: String(selection.capturedAt ?? node.createdAt),
    title: String(article.title ?? meta.sourceTitle ?? node.title),
    excerpt: exact,
    content: [selection.heading, selection.paragraph || exact].filter(Boolean).join('\n\n'),
    url: typeof article.url === 'string' ? article.url : typeof meta.sourceUrl === 'string' ? meta.sourceUrl : undefined,
    fullFetched: false,
    cards: [],
  };
};

const createClientRequestId = () => globalThis.crypto?.randomUUID?.()
  || `request-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;

const getCanvasRequestSessionStorage = () => {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

const shapeIdForNode = (nodeId: number) => createShapeId(`atomflow-node-${nodeId}`);
const shapeIdForEdge = (edgeId: number) => createShapeId(`atomflow-edge-${edgeId}`);

type CanvasBusinessShapeIdentity = {
  id: string;
  type?: string;
  props?: unknown;
  meta?: unknown;
};

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

export const canonicalNodeIdFromShapeRecord = (record: CanvasBusinessShapeIdentity | undefined) => {
  if (!record || record.type !== 'atomflow-node') return null;
  const nodeId = Number(asRecord(record.props)?.nodeId);
  if (!Number.isSafeInteger(nodeId) || nodeId <= 0) return null;
  return String(record.id) === String(shapeIdForNode(nodeId)) ? nodeId : null;
};

export const canonicalEdgeIdFromShapeRecord = (record: CanvasBusinessShapeIdentity | undefined) => {
  if (!record || record.type !== 'arrow') return null;
  const meta = asRecord(record.meta);
  if (meta?.atomflowCanonical !== true) return null;
  const edgeId = Number(meta.atomflowEdgeId);
  if (!Number.isSafeInteger(edgeId) || edgeId <= 0) return null;
  return String(record.id) === String(shapeIdForEdge(edgeId)) ? edgeId : null;
};

const edgeIdFromShapeId = (shapeId: TLShapeId) => {
  const match = String(shapeId).match(/atomflow-edge-(\d+)$/);
  if (!match) return null;
  const edgeId = Number(match[1]);
  if (!Number.isSafeInteger(edgeId) || edgeId <= 0) return null;
  return String(shapeId) === String(shapeIdForEdge(edgeId)) ? edgeId : null;
};

const nodeIdFromShape = (shape: CanvasShape | undefined) => {
  if (!shape) return null;
  return canonicalNodeIdFromShapeRecord(shape);
};
const isAtomFlowShape = (shape: CanvasShape): shape is AtomFlowShape => (shape as AtomFlowShape).type === 'atomflow-node';
const isCanonicalAtomFlowShape = (shape: CanvasShape): shape is AtomFlowShape => (
  isAtomFlowShape(shape) && nodeIdFromShape(shape) !== null
);
const canonicalEdgeIdFromShape = (shape: CanvasShape | undefined) => (
  shape ? canonicalEdgeIdFromShapeRecord(shape) : null
);

export const isNonCanonicalBusinessShapeRecord = (record: CanvasBusinessShapeIdentity) => {
  if (record.type === 'atomflow-node') return canonicalNodeIdFromShapeRecord(record) === null;
  if (record.type !== 'arrow') return false;
  const claimsCanonicalIdentity = asRecord(record.meta)?.atomflowCanonical === true
    || edgeIdFromShapeId(record.id as TLShapeId) !== null;
  if (!claimsCanonicalIdentity) return false;
  return canonicalEdgeIdFromShapeRecord(record) === null;
};

const isCanonicalBusinessShape = (shape: CanvasShape) => (
  nodeIdFromShape(shape) !== null || canonicalEdgeIdFromShape(shape) !== null
);

const canvasDetailContainsAgent = (
  currentDetail: WriteCanvasProjectDetail | null | undefined,
  projectId: number,
  agentNodeId: number,
  agentId: number,
) => Boolean(
  currentDetail?.project.id === projectId
  && currentDetail.nodes.some(node => node.id === agentNodeId && node.agent?.id === agentId)
);

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
  .split(/\r?\n\r?\n/)
  .map(block => block.trim())
  .filter(Boolean)
  .map(block => {
    const lines = block.split(/\r?\n/);
    const event = lines.find(line => line.startsWith('event:'))?.replace(/^event:\s*/, '').trim() || 'message';
    const data = lines
      .filter(line => line.startsWith('data:'))
      .map(line => line.replace(/^data:\s*/, ''))
      .join('\n');
    if (!data) return null;
    try {
      return { event, payload: JSON.parse(data) };
    } catch {
      return null;
    }
  })
  .filter((item): item is { event: string; payload: Record<string, unknown> } => Boolean(item));

const getRecallCandidates = (payload: Record<string, unknown>): CanvasRecallCandidate[] => {
  const context = payload.context && typeof payload.context === 'object'
    ? payload.context as Record<string, unknown>
    : null;
  const raw = Array.isArray(payload.globalRecallCandidates)
    ? payload.globalRecallCandidates
    : Array.isArray(context?.globalRecallCandidates)
      ? context.globalRecallCandidates
      : [];
  return raw.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const candidate = item as Record<string, unknown>;
    const cardId = typeof candidate.cardId === 'string' ? candidate.cardId : '';
    if (!cardId) return [];
    return [{
      cardId,
      type: typeof candidate.type === 'string' ? candidate.type : undefined,
      title: typeof candidate.title === 'string' ? candidate.title : '知识卡片',
      preview: typeof candidate.preview === 'string' ? candidate.preview : '',
      requiresConfirmation: candidate.requiresConfirmation !== false,
    }];
  });
};

export const MagicWritingCanvas: React.FC = () => {
  const { user, billingState, refreshBillingStatus, loginAndDo, showToast, savedCards, savedArticles, notes, writeAgentSkills } = useAppContext();
  const canWrite = billingState.phase === 'ready' && billingState.status.access === 'full';
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
  const [documentConflict, setDocumentConflict] = useState<CanvasDocumentConflict | null>(null);
  const [documentSaveState, setDocumentSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [recallCandidatesByAgent, setRecallCandidatesByAgent] = useState<Record<number, CanvasRecallCandidate[]>>({});
  const [savingResultMessageKeys, setSavingResultMessageKeys] = useState<Set<string>>(() => new Set());
  const [savedResultMessageKeys, setSavedResultMessageKeys] = useState<Set<string>>(() => new Set());
  const [mobileContextOpen, setMobileContextOpen] = useState(false);
  const [activeAgentNodeId, setActiveAgentNodeId] = useState<number | null>(null);
  const [aiDecomposeNodeId, setAiDecomposeNodeId] = useState<number | null>(null);
  const [aiQuickAction, setAiQuickAction] = useState<CanvasQuickAction>('extract_insights');
  const [isQuickActionRunning, setIsQuickActionRunning] = useState(false);
  const [quickActionStatus, setQuickActionStatus] = useState('');
  const [initialAgentGroupId, setInitialAgentGroupId] = useState<number | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const blankDocumentSnapshotRef = useRef<WriteCanvasDocumentSnapshot | null>(null);
  const editorDocumentProjectIdRef = useRef<number | null>(null);
  const detailRef = useRef<WriteCanvasProjectDetail | null>(null);
  const activePanelRef = useRef<ActivePanel>(null);
  const positionSyncTimerRef = useRef<number | null>(null);
  const viewportSyncTimerRef = useRef<number | null>(null);
  const editorChangeTimerRef = useRef<number | null>(null);
  const currentProjectIdRef = useRef<number | null>(null);
  const restoredCameraProjectRef = useRef<number | null>(null);
  const isSyncingEditorRef = useRef(false);
  const pendingDeletedNodeIdsRef = useRef(new Set<number>());
  const pendingDeletedEdgeIdsRef = useRef(new Set<number>());
  const pendingCanonicalEdgeIdsRef = useRef(new Set<number>());
  const pendingNodeGeometryRef = useRef(new Map<number, PendingNodeGeometry>());
  const nodeGeometryFlushPromisesRef = useRef(new Map<number, Promise<boolean>>());
  const canvasTabIdRef = useRef('');
  const detailRequestSequenceRef = useRef(0);
  const documentSaveTimerRef = useRef<number | null>(null);
  const documentRevisionRef = useRef(0);
  const documentRevisionByProjectRef = useRef(new Map<number, number>());
  const documentChangeVersionRef = useRef(0);
  const documentSavedChangeVersionByProjectRef = useRef(new Map<number, number>());
  const documentConflictRef = useRef<CanvasDocumentConflict | null>(null);
  const documentSaveInFlightRef = useRef<Promise<boolean> | null>(null);
  const documentSaveQueuedRef = useRef<CanvasDocumentSaveTask | null>(null);
  const preserveGeometryOnNextSyncProjectRef = useRef<number | null>(null);
  const flushDocumentRef = useRef<() => Promise<boolean>>(async () => true);
  const pendingBusinessMutationsRef = useRef(new Set<Promise<boolean>>());
  const flushBusinessMutationsRef = useRef<() => Promise<boolean>>(async () => true);
  const pendingBusinessReconciliationsRef = useRef<CanvasBusinessReconciliationBatch[]>([]);
  const businessReconciliationTimerRef = useRef<number | null>(null);
  const businessReconciliationInFlightRef = useRef<Promise<boolean> | null>(null);
  const drainBusinessReconciliationsRef = useRef<() => Promise<boolean>>(async () => true);
  const createArticleRequestIdsRef = useRef<PendingCanvasCreateArticleRequests>(new Map());
  const createArticleRequestOwnerIdRef = useRef<number | null>(null);
  const agentStreamAbortControllerRef = useRef<AbortController | null>(null);
  const projectTransitionInFlightRef = useRef(false);
  const projectsLoadedRef = useRef(false);
  const restoredDocumentKeyRef = useRef<string | null>(null);
  const preserveLocalDocumentProjectRef = useRef<number | null>(null);
  const savingResultMessageKeysRef = useRef(new Set<string>());
  const savedResultMessageKeysRef = useRef(new Set<string>());
  const quickActionAbortControllerRef = useRef<AbortController | null>(null);
  const quickActionRunSequenceRef = useRef(0);
  const canWriteRef = useRef(canWrite);
  if (!canvasTabIdRef.current) canvasTabIdRef.current = getCanvasTabId();

  useEffect(() => {
    const wasWritable = canWriteRef.current;
    canWriteRef.current = canWrite;
    editorRef.current?.updateInstanceState({ isReadonly: !canWrite });
    if (canWrite || !wasWritable) return;
    agentStreamAbortControllerRef.current?.abort();
    agentStreamAbortControllerRef.current = null;
    setIsAgentRunning(false);
    if (documentSaveTimerRef.current) window.clearTimeout(documentSaveTimerRef.current);
    documentSaveTimerRef.current = null;
    documentSaveQueuedRef.current = null;
    pendingBusinessReconciliationsRef.current = [];
    setDocumentSaveState('idle');
    const editor = editorRef.current;
    const projectId = currentProjectIdRef.current;
    if (user && editor && projectId) {
      const snapshot = editor.store.getStoreSnapshot('document') as unknown as WriteCanvasDocumentSnapshot;
      void protectDraft({
        id: `canvas:${user.id}:${projectId}:${Date.now()}`,
        userId: user.id,
        kind: 'canvas',
        createdAt: new Date().toISOString(),
        payload: { projectId, snapshot, viewport: editor.getCamera() },
      }).then(saved => showToast(saved
        ? '订阅状态已变更，未保存画布已备份到本机'
        : '订阅状态已变更，画布本机备份失败'));
    }
  }, [canWrite, showToast, user]);

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
      // Geometry draft recovery is best effort; server geometry remains authoritative.
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

  const mergePendingNodeGeometry = useCallback((payload: WriteCanvasProjectDetail): WriteCanvasProjectDetail => ({
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
      return { ...node, x: pending.x, y: pending.y, width: pending.width, height: pending.height };
    }),
  }), []);

  const getCreateArticleRequestStore = () => {
    const ownerId = Number(user?.id);
    if (!Number.isSafeInteger(ownerId) || ownerId <= 0) return null;
    if (createArticleRequestOwnerIdRef.current !== ownerId) {
      createArticleRequestIdsRef.current = readPendingCanvasCreateArticleRequests(
        getCanvasRequestSessionStorage(),
        ownerId,
      );
      createArticleRequestOwnerIdRef.current = ownerId;
    }
    return { ownerId, requests: createArticleRequestIdsRef.current };
  };

  const selectedNode = useMemo(
    () => detail?.nodes.find(node => node.id === selectedNodeId) || null,
    [detail?.nodes, selectedNodeId]
  );
  const agentNodes = useMemo(() => detail?.nodes.filter(node => node.kind === 'agent') || [], [detail?.nodes]);
  const contextAgentNode = contextAgentNodeId ? detail?.nodes.find(node => node.id === contextAgentNodeId) || null : null;
  const defaultAgentNode = selectedNode?.kind === 'agent'
    ? selectedNode
    : agentNodes.find(node => node.id === activeAgentNodeId) || agentNodes[0] || null;
  const getArticleForNode = useCallback((node: WriteCanvasNode | null): Article | null => {
    if (!node) return null;
    if (node.kind === 'saved_article') {
      const savedArticle = savedArticles.find(article => String(article.id) === String(node.refId));
      return savedArticle ? savedArticleToArticle(savedArticle) : null;
    }
    return citationNodeToArticle(node);
  }, [savedArticles]);

  const canvasUiOverrides = useMemo<TLUiOverrides>(() => ({
    actions(editor, actions) {
      const nextActions = { ...actions };
      for (const actionId of ['insert-media', 'insert-embed', 'convert-to-embed', 'convert-to-bookmark']) {
        delete nextActions[actionId];
      }
      for (const actionId of ['copy', 'cut', 'duplicate', 'delete'] as const) {
        const action = actions[actionId];
        if (!action) continue;
        nextActions[actionId] = {
          ...action,
          onSelect(source) {
            const selection = editor.getSelectedShapes() as CanvasShape[];
            if (selection.some(isCanonicalBusinessShape)) {
              showToast('业务节点由项目数据管理，不能复制或剪切；请从素材库添加新节点');
              return;
            }
            return action.onSelect(source);
          },
        };
      }
      return nextActions;
    },
    tools(_editor, tools) {
      const nextTools = { ...tools };
      delete nextTools.asset;
      delete nextTools.embed;
      return nextTools;
    },
  }), [showToast]);

  const trackBusinessMutation = useCallback(<T,>(
    operation: Promise<T>,
    isSuccessful: (value: T) => boolean = () => true,
  ): Promise<T> => {
    const tracked = operation.then(isSuccessful, () => false);
    pendingBusinessMutationsRef.current.add(tracked);
    void tracked.finally(() => pendingBusinessMutationsRef.current.delete(tracked));
    return operation;
  }, []);

  const performBusinessFetch = useCallback(async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response | null> => {
    if (!canWriteRef.current) {
      showToast('当前为只读模式，无法修改画布');
      return null;
    }
    try {
      const response = await trackBusinessMutation(fetch(input, init), response => response.ok);
      if (response.status === 402) await refreshBillingStatus();
      return response;
    } catch {
      return null;
    }
  }, [refreshBillingStatus, showToast, trackBusinessMutation]);

  const flushPendingNodeGeometry = useCallback(async (projectId = currentProjectIdRef.current) => {
    if (positionSyncTimerRef.current) {
      window.clearTimeout(positionSyncTimerRef.current);
      positionSyncTimerRef.current = null;
    }
    if (!projectId || !canWriteRef.current) return true;
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
          const response = await performBusinessFetch(`/api/write/canvas/nodes/${nodeId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              x: geometry.x,
              y: geometry.y,
              width: geometry.width,
              height: geometry.height,
              expectedUpdatedAt: geometry.baseUpdatedAt,
            }),
          });
          if (!response) return false;
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
                ...(latest === geometry ? {} : { x: latest.x, y: latest.y, width: latest.width, height: latest.height }),
              } : node),
            };
            detailRef.current = next;
            return next;
          });
          persistPendingNodeGeometryDraft(projectId);
          if (latest === geometry) return true;
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
  }, [performBusinessFetch, persistPendingNodeGeometryDraft, showToast]);

  useEffect(() => {
    flushBusinessMutationsRef.current = async () => {
      if (businessReconciliationTimerRef.current !== null) {
        window.clearTimeout(businessReconciliationTimerRef.current);
        businessReconciliationTimerRef.current = null;
      }
      let successful = true;
      while (true) {
        if (
          pendingBusinessReconciliationsRef.current.length > 0
          || businessReconciliationInFlightRef.current
        ) {
          if (!await drainBusinessReconciliationsRef.current()) successful = false;
        }
        const mutations = [...pendingBusinessMutationsRef.current];
        if (mutations.length > 0) {
          const results = await Promise.all(mutations);
          if (results.some(result => !result)) successful = false;
          continue;
        }
        if (
          pendingBusinessReconciliationsRef.current.length === 0
          && !businessReconciliationInFlightRef.current
        ) break;
      }
      return successful;
    };
  }, []);

  const loadProjects = useCallback(async () => {
    if (!user) return;
    const response = await fetch('/api/write/canvas/projects').catch(() => null);
    if (!response) {
      showToast('画布项目加载失败，请检查网络');
      return;
    }
    if (!response.ok) return;
    const payload = await response.json();
    const nextProjects: WriteCanvasProject[] = Array.isArray(payload.projects) ? payload.projects : [];
    for (const project of nextProjects) {
      const revision = project.documentRevision || project.tldrawRevision || 0;
      const knownRevision = documentRevisionByProjectRef.current.get(project.id) ?? 0;
      documentRevisionByProjectRef.current.set(project.id, Math.max(knownRevision, revision));
    }
    const rememberedProjectId = readCanvasProjectTarget(user.id);
    const nextCurrentProjectId = resolveCanvasProjectTarget(
      nextProjects,
      currentProjectIdRef.current ?? rememberedProjectId,
    );
    projectsLoadedRef.current = true;
    setProjects(nextProjects);
    setCurrentProjectId(previous => resolveCanvasProjectTarget(nextProjects, previous ?? rememberedProjectId));
    publishCanvasProjectsChanged({ ownerId: user.id, projects: nextProjects, currentProjectId: nextCurrentProjectId });
  }, [showToast, user]);

  const loadTemplates = useCallback(async () => {
    if (!user) return;
    const response = await fetch('/api/write/agent/templates').catch(() => null);
    if (!response) return;
    if (!response.ok) return;
    const payload = await response.json();
    setTemplates(Array.isArray(payload.templates) ? payload.templates : []);
  }, [user]);

  const loadProjectDetail = useCallback(async (projectId: number, options?: { forceDocument?: boolean }) => {
    restorePendingNodeGeometryDraft(projectId);
    const requestSequence = ++detailRequestSequenceRef.current;
    const response = await fetch(`/api/write/canvas/projects/${projectId}`).catch(() => null);
    if (!response) return null;
    if (!response.ok) return null;
    const payload = mergePendingNodeGeometry(await response.json() as WriteCanvasProjectDetail);
    if (requestSequence !== detailRequestSequenceRef.current || currentProjectIdRef.current !== projectId) return null;
    const revision = payload.project.documentRevision || payload.project.tldrawRevision || 0;
    const knownRevision = documentRevisionByProjectRef.current.get(projectId) ?? 0;
    if (revision < knownRevision) return null;
    const savedChangeVersion = documentSavedChangeVersionByProjectRef.current.get(projectId) ?? -1;
    const hasDirtyLocalDocument = editorDocumentProjectIdRef.current === projectId
      && documentChangeVersionRef.current > savedChangeVersion;
    const protectDirtyLocalDocument = !options?.forceDocument
      && revision > knownRevision
      && hasDirtyLocalDocument;
    if (protectDirtyLocalDocument) {
      preserveLocalDocumentProjectRef.current = projectId;
      documentSaveQueuedRef.current = null;
      if (documentSaveTimerRef.current) {
        window.clearTimeout(documentSaveTimerRef.current);
        documentSaveTimerRef.current = null;
      }
      const conflict = { projectId, currentRevision: revision };
      documentConflictRef.current = conflict;
      setDocumentConflict(conflict);
      setDocumentSaveState('error');
    } else {
      if (options?.forceDocument) preserveLocalDocumentProjectRef.current = null;
      documentRevisionByProjectRef.current.set(projectId, revision);
      documentRevisionRef.current = revision;
    }
    if (
      editorDocumentProjectIdRef.current === projectId
      && (
        documentChangeVersionRef.current > savedChangeVersion
        || documentSaveQueuedRef.current?.projectId === projectId
        || documentSaveInFlightRef.current !== null
      )
    ) preserveGeometryOnNextSyncProjectRef.current = projectId;
    detailRef.current = payload;
    setDetail(payload);
    setProjects(previous => previous.map(project => project.id === payload.project.id ? payload.project : project));
    setSelectedNodeId(previous => previous && payload.nodes.some(node => node.id === previous) ? previous : null);
    persistPendingNodeGeometryDraft(projectId);
    void flushPendingNodeGeometry(projectId);
    return payload;
  }, [flushPendingNodeGeometry, mergePendingNodeGeometry, persistPendingNodeGeometryDraft, restorePendingNodeGeometryDraft]);

  const closeQuickAction = useCallback((abortRunning = true) => {
    if (abortRunning) quickActionAbortControllerRef.current?.abort();
    quickActionAbortControllerRef.current = null;
    setAiDecomposeNodeId(null);
    setIsQuickActionRunning(false);
    setQuickActionStatus('');
  }, []);

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
      const response = await fetch(`/api/write/canvas/projects/${projectId}/runs`).catch(() => null);
      if (response?.ok) {
        const payload = await response.json() as { runs?: WriteCanvasAgentRun[] };
        const run = observedRunId
          ? payload.runs?.find(item => item.id === observedRunId)
          : payload.runs?.find(item => item.sourceNodeId === sourceNodeId
            && item.action === action
            && Date.parse(item.createdAt) >= runStartedAt - 1000);
        if (run && isTerminalQuickActionRun(run)) break;
      }
      if (attempt < QUICK_ACTION_RECONCILE_MAX_ATTEMPTS - 1) await waitForQuickActionReconcile();
    }
    if (currentProjectIdRef.current === projectId && quickActionRunSequenceRef.current === runSequence) {
      await loadProjectDetail(projectId);
    }
  }, [loadProjectDetail]);

  useEffect(() => {
    if (!user) {
      projectsLoadedRef.current = false;
      setProjects([]);
      setCurrentProjectId(null);
      setDetail(null);
      detailRef.current = null;
      editorDocumentProjectIdRef.current = null;
      return;
    }
    void loadProjects();
    void loadTemplates();
  }, [loadProjects, loadTemplates, user]);

  useEffect(() => () => {
    const controller = agentStreamAbortControllerRef.current;
    agentStreamAbortControllerRef.current = null;
    controller?.abort();
  }, []);

  useEffect(() => {
    const ownerId = Number(user?.id);
    createArticleRequestOwnerIdRef.current = null;
    createArticleRequestIdsRef.current = new Map();
    if (!Number.isSafeInteger(ownerId) || ownerId <= 0) return;
    createArticleRequestIdsRef.current = readPendingCanvasCreateArticleRequests(
      getCanvasRequestSessionStorage(),
      ownerId,
    );
    createArticleRequestOwnerIdRef.current = ownerId;
  }, [user?.id]);

  useEffect(() => {
    currentProjectIdRef.current = currentProjectId;
    if (editorDocumentProjectIdRef.current !== currentProjectId) editorDocumentProjectIdRef.current = null;
    if (currentProjectId && !documentSavedChangeVersionByProjectRef.current.has(currentProjectId)) {
      documentSavedChangeVersionByProjectRef.current.set(currentProjectId, documentChangeVersionRef.current);
    }
    setActivePanel(null);
    setSelectedNodeId(null);
    setContextAgentNodeId(null);
    editorRef.current?.selectNone();
    if (currentProjectId) void loadProjectDetail(currentProjectId);
  }, [currentProjectId, loadProjectDetail]);

  useEffect(() => {
    if (!user || !projectsLoadedRef.current) return;
    publishCanvasProjectsChanged({ ownerId: user.id, projects, currentProjectId });
  }, [currentProjectId, projects, user]);

  useEffect(() => {
    detailRef.current = detail;
    if (detail && detail.project.id === currentProjectIdRef.current) {
      if (preserveLocalDocumentProjectRef.current === detail.project.id) return;
      const revision = detail.project.documentRevision || detail.project.tldrawRevision || 0;
      const knownRevision = documentRevisionByProjectRef.current.get(detail.project.id) ?? 0;
      const latestRevision = Math.max(knownRevision, revision);
      documentRevisionByProjectRef.current.set(detail.project.id, latestRevision);
      documentRevisionRef.current = Math.max(documentRevisionRef.current, latestRevision);
    }
  }, [detail]);

  useEffect(() => {
    if (selectedNode?.kind === 'agent') setActiveAgentNodeId(selectedNode.id);
  }, [selectedNode?.id, selectedNode?.kind]);

  useEffect(() => {
    documentConflictRef.current = documentConflict;
  }, [documentConflict]);

  useEffect(() => {
    activePanelRef.current = activePanel;
  }, [activePanel]);

  const closeInspector = useCallback(() => {
    setActivePanel(null);
    setSelectedNodeId(null);
    editorRef.current?.selectNone();
  }, []);

  const selectNode = useCallback((nodeId: number, openInspector = true) => {
    setSelectedNodeId(nodeId);
    setContextAgentNodeId(null);
    if (openInspector) setActivePanel('inspector');
    if (typeof window !== 'undefined' && window.innerWidth < 1280) setMobileContextOpen(true);
    const editor = editorRef.current;
    const shapeId = shapeIdForNode(nodeId);
    if (editor?.getShape(shapeId)) editor.select(shapeId);
  }, []);

  useEffect(() => {
    const selectHandler = (event: Event) => {
      const nodeId = (event as CustomEvent<{ nodeId: number }>).detail?.nodeId;
      if (
        Number.isSafeInteger(nodeId)
        && detailRef.current?.nodes.some(node => node.id === nodeId)
      ) selectNode(nodeId);
    };
    const keyHandler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setProjectMenuOpen(false);
      setContextAgentNodeId(null);
      if (activePanelRef.current === 'inspector') closeInspector();
      else setActivePanel(null);
    };
    window.addEventListener('atomflow-canvas-select', selectHandler);
    window.addEventListener('keydown', keyHandler);
    return () => {
      window.removeEventListener('atomflow-canvas-select', selectHandler);
      window.removeEventListener('keydown', keyHandler);
    };
  }, [closeInspector, selectNode]);

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

  const syncEditorWithDetail = useCallback((
    editor: Editor,
    nextDetail: WriteCanvasProjectDetail,
    options?: { forceServerGeometry?: boolean },
  ) => {
    isSyncingEditorRef.current = true;
    const documentSnapshot = nextDetail.project.documentSnapshot || nextDetail.project.tldrawSnapshot || null;
    const documentRevision = nextDetail.project.documentRevision || nextDetail.project.tldrawRevision || 0;
    const documentKey = `${nextDetail.project.id}:${documentRevision}`;
    const preserveLocalDocument = preserveLocalDocumentProjectRef.current === nextDetail.project.id;
    let restoredDocument = false;
    if (!preserveLocalDocument && restoredDocumentKeyRef.current !== documentKey) {
      try {
        editor.store.mergeRemoteChanges(() => {
          if (documentSnapshot?.store && documentSnapshot.schema) {
            editor.store.loadStoreSnapshot(documentSnapshot as never);
          } else {
            const currentShapes = editor.getCurrentPageShapes();
            if (currentShapes.length > 0) editor.deleteShapes(currentShapes.map(shape => shape.id));
          }
        });
        restoredDocumentKeyRef.current = documentKey;
        restoredDocument = true;
      } catch {
        showToast('画布文档恢复失败，已使用业务节点兼容模式');
        const blankDocument = blankDocumentSnapshotRef.current;
        editor.store.mergeRemoteChanges(() => {
          editor.run(() => {
            if (blankDocument?.store && blankDocument.schema) {
              editor.store.loadStoreSnapshot(blankDocument as never);
            } else {
              const documentRecordIds = editor.store.allRecords()
                .filter(record => ['shape', 'binding', 'asset'].includes(record.typeName))
                .map(record => record.id);
              if (documentRecordIds.length > 0) editor.store.remove(documentRecordIds as never);
            }
          }, { history: 'ignore' });
        });
      }
    }
    if (removeUnmanagedNativeMediaRecords(editor) > 0) {
      showToast('旧画布中的原生媒体已移除；请通过“添加素材”重新上传');
    }
    const savedChangeVersion = documentSavedChangeVersionByProjectRef.current.get(nextDetail.project.id) ?? -1;
    const preserveExistingNodeGeometry = shouldPreserveLocalCanvasGeometry({
      isCurrentEditorProject: editorDocumentProjectIdRef.current === nextDetail.project.id,
      restoredDocument,
      forceServerGeometry: options?.forceServerGeometry,
      documentChangeVersion: documentChangeVersionRef.current,
      savedChangeVersion,
      hasQueuedDocumentSave: documentSaveQueuedRef.current?.projectId === nextDetail.project.id,
      hasDocumentSaveInFlight: documentSaveInFlightRef.current !== null
        || preserveGeometryOnNextSyncProjectRef.current === nextDetail.project.id,
    });
    editor.store.mergeRemoteChanges(() => {
      editor.run(() => {
        const backendShapeIds = new Set(nextDetail.nodes.map(node => shapeIdForNode(node.id)));
        const backendEdgeShapeIds = new Set(nextDetail.edges.map(edge => shapeIdForEdge(edge.id)));
        const existingShapes = editor.getCurrentPageShapes() as CanvasShape[];

        for (const shape of existingShapes) {
          if (isAtomFlowShape(shape)) {
            const nodeId = nodeIdFromShape(shape);
            if (nodeId === null || !backendShapeIds.has(shape.id)) editor.deleteShapes([shape.id]);
            continue;
          }
          if (shape.type === 'arrow') {
            const claimsCanonicalIdentity = shape.meta?.atomflowCanonical === true || edgeIdFromShapeId(shape.id) !== null;
            if (claimsCanonicalIdentity && (
              canonicalEdgeIdFromShape(shape) === null
              || !backendEdgeShapeIds.has(shape.id)
            )) editor.deleteShapes([shape.id]);
          }
        }

        for (const node of nextDetail.nodes) {
          const id = shapeIdForNode(node.id);
          const props = {
            w: node.width,
            h: node.height,
            nodeId: String(node.id),
            kind: node.kind,
            role: node.role,
            status: node.status,
            contentType: node.contentType,
            businessRef: node.businessRef === null || node.businessRef === undefined ? '' : String(node.businessRef),
            title: node.title,
            summary: node.summary || '',
          };
          const existingShape = editor.getShape(id) as CanvasShape | undefined;
          if (!existingShape) {
            // New business nodes have no local geometry to protect.
            editor.createShape({ id, type: 'atomflow-node', x: node.x, y: node.y, props } as never);
          } else if (preserveExistingNodeGeometry && isAtomFlowShape(existingShape)) {
            editor.updateShape({
              id,
              type: 'atomflow-node',
              props: { ...props, w: existingShape.props.w, h: existingShape.props.h },
            } as never);
          } else {
            editor.updateShape({ id, type: 'atomflow-node', x: node.x, y: node.y, props } as never);
          }
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
    editorDocumentProjectIdRef.current = nextDetail.project.id;
    if (restoredDocument) {
      documentSavedChangeVersionByProjectRef.current.set(nextDetail.project.id, documentChangeVersionRef.current);
    }
    if (preserveGeometryOnNextSyncProjectRef.current === nextDetail.project.id) {
      preserveGeometryOnNextSyncProjectRef.current = null;
    }
    window.setTimeout(() => { isSyncingEditorRef.current = false; }, 0);
  }, [createBoundEdge, showToast]);

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
    const response = await performBusinessFetch('/api/write/canvas/edges', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, sourceNodeId, targetNodeId }),
    });
    if (!response?.ok) {
      if (!options?.quiet) showToast('连接失败：请从资料节点连接到 Agent');
      return false;
    }
    await loadProjectDetail(projectId);
    if (!options?.quiet) showToast('已加入 Agent 上下文');
    return true;
  }, [loadProjectDetail, performBusinessFetch, showToast]);

  const removeEdge = useCallback(async (edge: WriteCanvasEdge, options?: { quiet?: boolean }) => {
    if (pendingDeletedEdgeIdsRef.current.has(edge.id)) return true;
    pendingDeletedEdgeIdsRef.current.add(edge.id);
    let removed = false;
    try {
      const response = await performBusinessFetch('/api/write/canvas/edges', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: edge.id }),
      });
      const projectId = currentProjectIdRef.current;
      removed = Boolean(response?.ok);
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
    return removed;
  }, [loadProjectDetail, performBusinessFetch, showToast]);

  const deleteNodeById = useCallback(async (nodeId: number, options?: { quiet?: boolean }) => {
    if (pendingDeletedNodeIdsRef.current.has(nodeId)) return true;
    pendingDeletedNodeIdsRef.current.add(nodeId);
    const nodeProjectId = pendingNodeGeometryRef.current.get(nodeId)?.projectId || currentProjectIdRef.current;
    let removed = false;
    let restoredFromServer = false;
    let failureMessage = '删除节点失败，已恢复画布';
    try {
      const response = await performBusinessFetch(`/api/write/canvas/nodes/${nodeId}`, { method: 'DELETE' });
      if (response?.ok) {
        removed = true;
        pendingNodeGeometryRef.current.delete(nodeId);
        persistPendingNodeGeometryDraft(nodeProjectId);
        if (nodeProjectId && currentProjectIdRef.current === nodeProjectId) await loadProjectDetail(nodeProjectId);
        if (!options?.quiet) showToast('节点已删除');
        return true;
      }
      const payload = await response?.json().catch(() => null) as { code?: unknown; error?: unknown } | null;
      failureMessage = payload?.code === 'CANVAS_AI_ACTIVE'
        ? '节点正在执行 AI 任务，完成后才能删除'
        : typeof payload?.error === 'string' && payload.error.trim()
          ? payload.error
          : failureMessage;
      if (payload?.code === 'CANVAS_AI_ACTIVE' && nodeProjectId && currentProjectIdRef.current === nodeProjectId) {
        restoredFromServer = Boolean(await loadProjectDetail(nodeProjectId));
      }
      return false;
    } catch {
      failureMessage = '网络中断，节点未删除并已恢复画布';
      return false;
    } finally {
      pendingDeletedNodeIdsRef.current.delete(nodeId);
      if (!removed) {
        const editor = editorRef.current;
        const currentDetail = detailRef.current;
        if (editor && currentDetail && currentDetail.project.id === nodeProjectId) syncEditorWithDetail(editor, currentDetail);
        if (!restoredFromServer && nodeProjectId && currentProjectIdRef.current === nodeProjectId) {
          await loadProjectDetail(nodeProjectId);
        }
        if (!options?.quiet) showToast(failureMessage);
      }
    }
  }, [loadProjectDetail, performBusinessFetch, persistPendingNodeGeometryDraft, showToast, syncEditorWithDetail]);

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
    const selectedBusinessNode = selectedBusinessNodeId
      ? currentDetail.nodes.find(node => node.id === selectedBusinessNodeId)
      : null;
    if (selectedBusinessNode) {
      if (activePanelRef.current !== 'add') {
        setSelectedNodeId(selectedBusinessNode.id);
        setActivePanel('inspector');
      }
    } else if (activePanelRef.current === 'inspector') {
      // A native tldraw shape (or a mixed selection) has no business context.
      // Clear the previous node so the shared rail follows what is actually selected.
      setSelectedNodeId(null);
      setActivePanel(null);
    }

  }, []);

  const removeNonCanonicalBusinessShapeCopies = useCallback((editor: Editor, changedRecords: CanvasStoreRecord[]) => {
    const invalidShapeIds = changedRecords.flatMap(record => {
      if (record.typeName !== 'shape' || !isNonCanonicalBusinessShapeRecord(record)) return [];
      return editor.getShape(record.id as TLShapeId) ? [record.id as TLShapeId] : [];
    });
    if (invalidShapeIds.length === 0) return;

    // Treat duplicate/paste artifacts as non-user state so removing them cannot
    // enter the business deletion reconciler or the persisted canvas history.
    editor.store.mergeRemoteChanges(() => {
      editor.run(() => editor.deleteShapes(invalidShapeIds), { history: 'ignore' });
    });
  }, []);

  const reconcileUserDocumentChanges = useCallback(async (_editor: Editor, removedRecords: CanvasStoreRecord[]) => {
    const currentDetail = detailRef.current;
    if (!currentDetail) return true;

    let successful = true;
    const removedNodeIds = new Set(removedRecords.flatMap(record => {
      if (record.typeName !== 'shape' || record.type !== 'atomflow-node') return [];
      const nodeId = canonicalNodeIdFromShapeRecord(record);
      return nodeId ? [nodeId] : [];
    }));

    for (const record of removedRecords) {
      if (record.typeName !== 'shape') continue;
      if (record.type === 'atomflow-node') {
        const nodeId = canonicalNodeIdFromShapeRecord(record);
        if (nodeId && currentDetail.nodes.some(node => node.id === nodeId)) {
          if (!await deleteNodeById(nodeId, { quiet: true })) successful = false;
        }
      }
    }
    for (const record of removedRecords) {
      if (record.typeName !== 'shape') continue;
      if (record.type === 'arrow') {
        const edgeId = canonicalEdgeIdFromShapeRecord(record);
        const edge = currentDetail.edges.find(item => item.id === edgeId);
        if (
          edge
          && !removedNodeIds.has(edge.sourceNodeId)
          && !removedNodeIds.has(edge.targetNodeId)
          && !await removeEdge(edge, { quiet: true })
        ) successful = false;
      }
    }
    return successful;
  }, [deleteNodeById, removeEdge]);

  const reconcileCanonicalArrowChanges = useCallback(async (editor: Editor, changedRecords: CanvasStoreRecord[]) => {
    const currentDetail = detailRef.current;
    const projectId = currentProjectIdRef.current;
    if (!currentDetail || !projectId) return true;
    let successful = true;

    const affectedArrowIds = new Set<TLShapeId>();
    for (const record of changedRecords) {
      if (record.typeName === 'shape' && record.type === 'arrow') affectedArrowIds.add(record.id as TLShapeId);
      if (record.typeName === 'binding' && record.type === 'arrow' && record.fromId) affectedArrowIds.add(record.fromId);
    }

    for (const arrowId of affectedArrowIds) {
      const shape = editor.getShape(arrowId);
      if (!shape || shape.type !== 'arrow') continue;
      const edgeId = canonicalEdgeIdFromShape(shape);
      if (!edgeId) continue;
      const edge = currentDetail.edges.find(item => item.id === edgeId);
      if (!edge || pendingCanonicalEdgeIdsRef.current.has(edgeId)) continue;
      const bindings = getArrowBindings(editor, shape as TLArrowShape);
      const sourceNodeId = bindings.start ? nodeIdFromShape(editor.getShape(bindings.start.toId)) : null;
      const targetNodeId = bindings.end ? nodeIdFromShape(editor.getShape(bindings.end.toId)) : null;
      if (sourceNodeId === edge.sourceNodeId && targetNodeId === edge.targetNodeId) continue;

      const source = currentDetail.nodes.find(node => node.id === sourceNodeId);
      const target = currentDetail.nodes.find(node => node.id === targetNodeId);
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
      pendingCanonicalEdgeIdsRef.current.add(edgeId);
      try {
        const targetAcceptsContext = target?.kind === 'agent'
          || (target?.role === 'task' && target?.contentType === 'agent_group');
        if (source && targetAcceptsContext && source.kind !== 'agent' && source.role !== 'task') {
          const replaceResponse = await performBusinessFetch('/api/write/canvas/edges/replace', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ edgeId, sourceNodeId: source.id, targetNodeId: target.id }),
          });
          if (!replaceResponse?.ok) throw new Error('edge replace failed');
        } else {
          showToast('上下文连线需要从资料节点指向 Agent');
        }
      } catch {
        successful = false;
        showToast('连接更新失败，已恢复服务器中的连接');
      } finally {
        pendingCanonicalEdgeIdsRef.current.delete(edgeId);
        await loadProjectDetail(projectId);
      }
    }
    return successful;
  }, [createBoundEdge, loadProjectDetail, performBusinessFetch, showToast]);

  const drainBusinessReconciliations = useCallback((): Promise<boolean> => {
    if (businessReconciliationInFlightRef.current) return businessReconciliationInFlightRef.current;
    const drain = (async () => {
      let successful = true;
      while (pendingBusinessReconciliationsRef.current.length > 0) {
        const batch = pendingBusinessReconciliationsRef.current.shift();
        if (!batch) continue;
        if (!await reconcileUserDocumentChanges(batch.editor, batch.removedRecords)) successful = false;
        if (!await reconcileCanonicalArrowChanges(batch.editor, batch.changedRecords)) successful = false;
      }
      return successful;
    })().catch(() => false);
    businessReconciliationInFlightRef.current = drain;
    void drain.finally(() => {
      if (businessReconciliationInFlightRef.current === drain) {
        businessReconciliationInFlightRef.current = null;
      }
    });
    return drain;
  }, [reconcileCanonicalArrowChanges, reconcileUserDocumentChanges]);

  useEffect(() => {
    drainBusinessReconciliationsRef.current = drainBusinessReconciliations;
  }, [drainBusinessReconciliations]);

  const queueBusinessReconciliation = useCallback((batch: CanvasBusinessReconciliationBatch) => {
    pendingBusinessReconciliationsRef.current.push(batch);
    if (businessReconciliationTimerRef.current !== null) return;
    businessReconciliationTimerRef.current = window.setTimeout(() => {
      businessReconciliationTimerRef.current = null;
      void trackBusinessMutation(drainBusinessReconciliations(), result => result).then(successful => {
        if (!successful) showToast('业务节点或上下文连接保存失败，请检查网络后重试');
      });
    }, 0);
  }, [drainBusinessReconciliations, showToast, trackBusinessMutation]);

  const captureDocumentSnapshot = useCallback((expectedProjectId = currentProjectIdRef.current): WriteCanvasDocumentSnapshot | null => {
    const editor = editorRef.current;
    if (!editor || !expectedProjectId || editorDocumentProjectIdRef.current !== expectedProjectId) return null;
    removeUnmanagedNativeMediaRecords(editor);
    return editor.store.getStoreSnapshot('document') as unknown as WriteCanvasDocumentSnapshot;
  }, []);

  const captureCanvasViewport = useCallback((expectedProjectId = currentProjectIdRef.current) => {
    const editor = editorRef.current;
    if (!editor || !expectedProjectId || editorDocumentProjectIdRef.current !== expectedProjectId) return null;
    const camera = editor.getCamera();
    return { camera: { x: camera.x, y: camera.y, z: camera.z } };
  }, []);

  const saveDocumentTask = useCallback(async (task: CanvasDocumentSaveTask): Promise<boolean> => {
    const { projectId, snapshot, viewport, schemaVersion, changeVersion } = task;
    const isCurrentProject = () => currentProjectIdRef.current === projectId;
    const snapshotBlob = new Blob([JSON.stringify(snapshot)], { type: 'application/json' });
    if (snapshotBlob.size > 2 * 1024 * 1024) {
      if (isCurrentProject()) {
        setDocumentSaveState('error');
        showToast('画布文档超过 2MB，请删除内嵌媒体后重试');
      }
      return false;
    }

    const baseRevision = documentRevisionByProjectRef.current.get(projectId) ?? 0;
    if (isCurrentProject()) setDocumentSaveState('saving');
    try {
      const form = new FormData();
      form.append('snapshot', snapshotBlob, 'canvas-document.json');
      form.append('baseRevision', String(baseRevision));
      form.append('schemaVersion', String(schemaVersion));
      form.append('viewport', JSON.stringify(viewport));
      const response = await fetch(`/api/write/canvas/projects/${projectId}/document`, {
        method: 'PUT',
        body: form,
      });
      if (response.status === 402) await refreshBillingStatus();
      const payload = await response.json().catch(() => ({})) as {
        code?: string;
        error?: string;
        currentRevision?: number;
        revision?: number;
        project?: WriteCanvasProject;
      };
      if (response.status === 409) {
        const currentRevision = Number(payload.currentRevision) || baseRevision;
        documentRevisionByProjectRef.current.set(projectId, currentRevision);
        if (isCurrentProject()) {
          preserveLocalDocumentProjectRef.current = projectId;
          const conflict = { projectId, currentRevision };
          documentConflictRef.current = conflict;
          setDocumentConflict(conflict);
          setDocumentSaveState('error');
        }
        return false;
      }
      if (!response.ok) {
        if (isCurrentProject()) showToast(payload.error ? `画布保存失败：${payload.error}` : '画布保存失败，请检查内容后重试');
        throw new Error(payload.code || 'document save failed');
      }

      const nextRevision = Number(payload.revision ?? payload.project?.documentRevision ?? baseRevision + 1);
      documentRevisionByProjectRef.current.set(projectId, nextRevision);
      documentSavedChangeVersionByProjectRef.current.set(
        projectId,
        Math.max(documentSavedChangeVersionByProjectRef.current.get(projectId) ?? -1, changeVersion),
      );
      setProjects(previous => previous.map(project => project.id === projectId
        ? payload.project || {
          ...project,
          documentSnapshot: snapshot,
          documentRevision: nextRevision,
          documentSchemaVersion: schemaVersion,
        }
        : project));
      if (isCurrentProject()) {
        documentRevisionRef.current = nextRevision;
        restoredDocumentKeyRef.current = `${projectId}:${nextRevision}`;
        setDocumentSaveState('saved');
        preserveGeometryOnNextSyncProjectRef.current = projectId;
        setDetail(previous => previous?.project.id === projectId ? {
          ...previous,
          project: payload.project || {
            ...previous.project,
            documentSnapshot: snapshot,
            documentRevision: nextRevision,
            documentSchemaVersion: schemaVersion,
          },
        } : previous);
      }
      return true;
    } catch {
      if (isCurrentProject()) setDocumentSaveState('error');
      return false;
    }
  }, [refreshBillingStatus, showToast]);

  const startDocumentSaveDrain = useCallback((): Promise<boolean> => {
    const activeSave = documentSaveInFlightRef.current;
    if (activeSave) return activeSave;

    const drainPromise = (async () => {
      while (documentSaveQueuedRef.current) {
        const task = documentSaveQueuedRef.current;
        documentSaveQueuedRef.current = null;
        if (documentConflictRef.current?.projectId === task.projectId) return false;
        const saved = await saveDocumentTask(task);
        if (!saved) {
          documentSaveQueuedRef.current = null;
          return false;
        }
      }
      return true;
    })();
    documentSaveInFlightRef.current = drainPromise;
    void drainPromise.finally(() => {
      if (documentSaveInFlightRef.current === drainPromise) documentSaveInFlightRef.current = null;
    });
    return drainPromise;
  }, [saveDocumentTask]);

  const persistDocumentSnapshot = useCallback(async (snapshotOverride?: WriteCanvasDocumentSnapshot): Promise<boolean> => {
    if (!canWriteRef.current) return true;
    const projectId = currentProjectIdRef.current;
    if (!projectId || documentConflictRef.current?.projectId === projectId) return false;
    const snapshot = snapshotOverride || captureDocumentSnapshot();
    if (!snapshot) return true;
    const viewport = captureCanvasViewport(projectId);
    if (!viewport) return false;
    const currentDetail = detailRef.current;
    const project = currentDetail?.project.id === projectId
      ? currentDetail.project
      : projects.find(item => item.id === projectId);
    documentSaveQueuedRef.current = {
      projectId,
      snapshot,
      viewport,
      schemaVersion: resolveCanvasDocumentSchemaVersion(snapshot, project?.documentSchemaVersion ?? 1),
      changeVersion: documentChangeVersionRef.current,
    };
    return startDocumentSaveDrain();
  }, [captureCanvasViewport, captureDocumentSnapshot, projects, startDocumentSaveDrain]);

  useEffect(() => {
    flushDocumentRef.current = async () => {
      if (!canWriteRef.current) return true;
      if (documentSaveTimerRef.current) {
        window.clearTimeout(documentSaveTimerRef.current);
        documentSaveTimerRef.current = null;
      }
      const projectId = currentProjectIdRef.current;
      if (!projectId) return true;
      if (documentConflictRef.current?.projectId === projectId) return false;

      while (true) {
        if (documentSaveTimerRef.current) {
          window.clearTimeout(documentSaveTimerRef.current);
          documentSaveTimerRef.current = null;
        }
        const currentChangeVersion = documentChangeVersionRef.current;
        const savedChangeVersion = documentSavedChangeVersionByProjectRef.current.get(projectId) ?? -1;
        if (savedChangeVersion < currentChangeVersion && !documentSaveQueuedRef.current) {
          const snapshot = captureDocumentSnapshot(projectId);
          if (!snapshot) return false;
          const viewport = captureCanvasViewport(projectId);
          if (!viewport) return false;
          const currentDetail = detailRef.current;
          const project = currentDetail?.project.id === projectId
            ? currentDetail.project
            : projects.find(item => item.id === projectId);
          documentSaveQueuedRef.current = {
            projectId,
            snapshot,
            viewport,
            schemaVersion: resolveCanvasDocumentSchemaVersion(snapshot, project?.documentSchemaVersion ?? 1),
            changeVersion: currentChangeVersion,
          };
        }
        if (!documentSaveQueuedRef.current && !documentSaveInFlightRef.current) {
          return documentConflictRef.current?.projectId !== projectId;
        }
        const activeSave = documentSaveInFlightRef.current || startDocumentSaveDrain();
        if (!await activeSave) return false;
      }
    };
  }, [captureCanvasViewport, captureDocumentSnapshot, projects, startDocumentSaveDrain]);

  const scheduleDocumentSave = useCallback(() => {
    if (!canWriteRef.current) return;
    if (isSyncingEditorRef.current || documentConflictRef.current) return;
    if (documentSaveTimerRef.current) window.clearTimeout(documentSaveTimerRef.current);
    documentSaveTimerRef.current = window.setTimeout(() => {
      documentSaveTimerRef.current = null;
      void persistDocumentSnapshot();
    }, 800);
  }, [persistDocumentSnapshot]);

  useEffect(() => {
    const flushAll = async (): Promise<boolean> => {
      const geometrySaved = await flushPendingNodeGeometry();
      if (!geometrySaved) return false;
      const businessSaved = await flushBusinessMutationsRef.current();
      if (!businessSaved) return false;
      return flushDocumentRef.current();
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        persistPendingNodeGeometryDraft(currentProjectIdRef.current);
        void flushPendingNodeGeometry().then(flushAll);
      }
    };
    const handlePageHide = () => {
      persistPendingNodeGeometryDraft(currentProjectIdRef.current);
      void flushAll();
    };
    const handleBeforeDurableLeave = (event: Event) => {
      const waitUntil = (event as CustomEvent<{
        waitUntil?: (pending: Promise<boolean>) => void;
      }>).detail?.waitUntil;
      waitUntil?.(flushAll());
    };
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('atomflow:before-account-leave', handleBeforeDurableLeave);
    window.addEventListener('atomflow:before-write-leave', handleBeforeDurableLeave);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('atomflow:before-account-leave', handleBeforeDurableLeave);
      window.removeEventListener('atomflow:before-write-leave', handleBeforeDurableLeave);
      persistPendingNodeGeometryDraft(currentProjectIdRef.current);
      void flushAll();
    };
  }, [flushPendingNodeGeometry, persistPendingNodeGeometryDraft]);

  const onMount = useCallback((editor: Editor) => {
    editorRef.current = editor;
    editor.updateInstanceState({ isReadonly: !canWriteRef.current });
    blankDocumentSnapshotRef.current = editor.store.getStoreSnapshot('document') as unknown as WriteCanvasDocumentSnapshot;
    editor.registerExternalAssetHandler('file', null);
    editor.registerExternalAssetHandler('url', null);
    const rejectNativeMedia = () => {
      showToast('图片和文件请使用“添加素材”中的受限上传入口');
    };
    editor.registerExternalContentHandler('files', rejectNativeMedia);
    editor.registerExternalContentHandler('file-replace', rejectNativeMedia);
    editor.registerExternalContentHandler('url', externalContent => editor.putExternalContent({
      type: 'text',
      text: externalContent.url,
      point: externalContent.point,
    }));
    editor.registerExternalContentHandler('embed', rejectNativeMedia);
    editor.registerExternalContentHandler('tldraw', externalContent => {
      const containsRestrictedContent = externalContent.content.assets.length > 0
        || externalContent.content.shapes.some(shape => (
          ['image', 'video', 'embed', 'bookmark'].includes(shape.type)
          || isCanonicalBusinessShape(shape as CanvasShape)
          || isNonCanonicalBusinessShapeRecord(shape)
        ));
      if (containsRestrictedContent) {
        rejectNativeMedia();
        return;
      }
      editor.putContentOntoCurrentPage(externalContent.content, { point: externalContent.point });
    });
    const stopBusinessShapeDelete = editor.sideEffects.registerBeforeDeleteHandler('shape', (shape, source) => {
      if (source === 'user' && isCanonicalBusinessShape(shape as CanvasShape)) {
        showToast('业务节点和上下文连接请从详情面板删除');
        return false;
      }
      return undefined;
    });
    if (detailRef.current) window.setTimeout(() => syncEditorWithDetail(editor, detailRef.current!), 0);
    const stopSelectionListener = editor.store.listen(({ changes }) => {
      if (editorChangeTimerRef.current) window.clearTimeout(editorChangeTimerRef.current);
      editorChangeTimerRef.current = window.setTimeout(() => reconcileSelection(editor), 80);
      const sessionRecords = [
        ...Object.values(changes.added),
        ...Object.values(changes.updated).map(change => Array.isArray(change) ? change[1] : change),
      ] as CanvasStoreRecord[];
      if (!isSyncingEditorRef.current && sessionRecords.some(record => record.typeName === 'camera')) {
        documentChangeVersionRef.current += 1;
        scheduleDocumentSave();
      }
    }, { scope: 'session' });
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
      documentChangeVersionRef.current += 1;
      const removedRecords = Object.values(changes.removed) as CanvasStoreRecord[];
      const addedOrUpdatedRecords = [
        ...Object.values(changes.added),
        ...Object.values(changes.updated).map(change => Array.isArray(change) ? change[1] : change),
      ] as CanvasStoreRecord[];
      const changedRecords = [
        ...addedOrUpdatedRecords,
        ...removedRecords,
      ] as CanvasStoreRecord[];
      window.setTimeout(() => removeNonCanonicalBusinessShapeCopies(editor, addedOrUpdatedRecords), 0);
      window.setTimeout(() => {
        if (addedOrUpdatedRecords.some(isUnmanagedNativeMediaRecord) && removeUnmanagedNativeMediaRecords(editor) > 0) {
          rejectNativeMedia();
        }
      }, 0);
      queueBusinessReconciliation({ editor, removedRecords, changedRecords });
      scheduleDocumentSave();
    }, { source: 'user', scope: 'document' });
    return () => {
      stopBusinessShapeDelete();
      stopSelectionListener();
      stopGeometryListener();
      stopDocumentListener();
      if (positionSyncTimerRef.current) window.clearTimeout(positionSyncTimerRef.current);
      if (viewportSyncTimerRef.current) window.clearTimeout(viewportSyncTimerRef.current);
    };
  }, [flushPendingNodeGeometry, persistPendingNodeGeometryDraft, queueBusinessReconciliation, reconcileSelection, removeNonCanonicalBusinessShapeCopies, scheduleDocumentSave, showToast, syncEditorWithDetail]);

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
    const response = await performBusinessFetch(`/api/write/canvas/projects/${projectId}/nodes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response?.ok) {
      showToast('添加节点失败');
      return null;
    }
    const data = await response.json();
    await loadProjectDetail(projectId);
    const node = data.node as WriteCanvasNode | null;
    if (options?.open !== false) await finishNodeAddition(node);
    return node;
  }, [finishNodeAddition, loadProjectDetail, performBusinessFetch, showToast]);

  const createStructureEdge = useCallback(async (sourceNodeId: number, targetNodeId: number) => {
    const projectId = currentProjectIdRef.current;
    if (!projectId) return false;
    const response = await performBusinessFetch('/api/write/canvas/edges', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, sourceNodeId, targetNodeId, relation: 'structure' }),
    });
    if (!response?.ok) return false;
    await loadProjectDetail(projectId);
    return true;
  }, [loadProjectDetail, performBusinessFetch]);

  const createInsightBranch = useCallback(async (parent: WriteCanvasNode) => {
    const childCount = detailRef.current?.edges.filter(edge => edge.relation === 'structure' && edge.sourceNodeId === parent.id).length || 0;
    const node = await createNode({
      kind: 'asset_text', role: 'insight', origin: 'manual', status: 'editing',
      title: `子节点：${parent.title}`, content: '',
      x: parent.x + 380, y: parent.y + childCount * 220, width: 300, height: 180,
    }, { open: false });
    if (!node) return;
    const linked = await createStructureEdge(parent.id, node.id);
    if (!linked) {
      await performBusinessFetch(`/api/write/canvas/nodes/${node.id}`, { method: 'DELETE' });
      const projectId = currentProjectIdRef.current;
      if (projectId) await loadProjectDetail(projectId);
      return;
    }
    selectNode(node.id);
  }, [createNode, createStructureEdge, loadProjectDetail, performBusinessFetch, selectNode]);

  const createDocumentFromNode = useCallback(async (source: WriteCanvasNode) => {
    const projectId = currentProjectIdRef.current;
    if (!projectId) return;
    const response = await performBusinessFetch(`/api/write/canvas/projects/${projectId}/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceNodeId: source.id,
        title: `${source.title}作品`, summary: source.summary || '', scenario: 'custom-longform', status: 'editing',
        sections: [{ key: 'opening', heading: '开场', body: '', level: 1, meta: {} }],
        x: source.x + 380, y: source.y, width: 420, height: 320,
      }),
    });
    if (!response?.ok) return showToast('创建作品失败');
    const payload = await response.json() as { document?: { nodeId?: number } };
    await loadProjectDetail(projectId);
    const nodeId = Number(payload.document?.nodeId);
    if (Number.isFinite(nodeId)) selectNode(nodeId);
  }, [loadProjectDetail, performBusinessFetch, selectNode, showToast]);

  const activateProject = useCallback((projectId: number) => {
    detailRequestSequenceRef.current += 1;
    documentSaveQueuedRef.current = null;
    preserveGeometryOnNextSyncProjectRef.current = null;
    documentConflictRef.current = null;
    preserveLocalDocumentProjectRef.current = null;
    currentProjectIdRef.current = projectId;
    documentRevisionRef.current = documentRevisionByProjectRef.current.get(projectId) || 0;
    documentSavedChangeVersionByProjectRef.current.set(projectId, documentChangeVersionRef.current);
    detailRef.current = null;
    editorDocumentProjectIdRef.current = null;
    restoredDocumentKeyRef.current = null;
    restoredCameraProjectRef.current = null;
    setDetail(null);
    setDocumentConflict(null);
    setDocumentSaveState('idle');
    setCurrentProjectId(projectId);
  }, []);

  const switchProject = useCallback(async (projectId: number): Promise<CanvasProjectSwitchOutcome> => {
    if (!projects.some(project => project.id === projectId)) return { status: 'rejected', reason: 'project-unavailable' };
    if (projectId === currentProjectIdRef.current) return { status: 'confirmed' };
    if (projectTransitionInFlightRef.current) return { status: 'rejected', reason: 'transition-in-progress' };
    if (isAgentRunning) {
      showToast('Agent 正在运行，请等待本次生成结束后切换项目');
      return { status: 'rejected', reason: 'agent-running' };
    }
    projectTransitionInFlightRef.current = true;
    const sourceProjectId = currentProjectIdRef.current;
    try {
      const businessSaved = await flushBusinessMutationsRef.current();
      const saved = businessSaved && await flushDocumentRef.current();
      if (!saved) {
        showToast(documentConflictRef.current?.projectId === sourceProjectId
          ? '请先处理画布版本冲突'
          : '画布尚未保存，已取消切换');
        return {
          status: 'rejected',
          reason: documentConflictRef.current?.projectId === sourceProjectId ? 'document-conflict' : 'save-failed',
        };
      }
      if (currentProjectIdRef.current !== sourceProjectId) {
        return currentProjectIdRef.current === projectId
          ? { status: 'confirmed' }
          : { status: 'rejected', reason: 'project-changed' };
      }
      activateProject(projectId);
      return { status: 'confirmed' };
    } catch {
      showToast('画布保存失败，已取消切换');
      return { status: 'rejected', reason: 'save-failed' };
    } finally {
      projectTransitionInFlightRef.current = false;
    }
  }, [activateProject, isAgentRunning, projects, showToast]);

  const createProject = () => loginAndDo(async () => {
    if (!canWriteRef.current) return showToast('当前为只读模式');
    if (projectTransitionInFlightRef.current) return;
    if (isAgentRunning) return showToast('Agent 正在运行，请等待本次生成结束后新建项目');
    projectTransitionInFlightRef.current = true;
    const sourceProjectId = currentProjectIdRef.current;
    try {
      const businessSaved = await flushBusinessMutationsRef.current();
      const saved = businessSaved && await flushDocumentRef.current();
      if (!saved) {
        showToast(documentConflictRef.current?.projectId === sourceProjectId
          ? '请先处理画布版本冲突'
          : '画布尚未保存，已取消新建项目');
        return;
      }
      if (currentProjectIdRef.current !== sourceProjectId) return;
      const response = await performBusinessFetch('/api/write/canvas/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '新的魔法写作项目' }),
      });
      if (!response?.ok) return showToast('新建项目失败');
      const payload = await response.json() as { project?: WriteCanvasProject };
      if (!payload.project) return showToast('新建项目失败');
      documentRevisionByProjectRef.current.set(payload.project.id, payload.project.documentRevision || 0);
      setProjects(previous => [payload.project!, ...previous.filter(project => project.id !== payload.project!.id)]);
      activateProject(payload.project.id);
      setProjectMenuOpen(false);
    } finally {
      projectTransitionInFlightRef.current = false;
    }
  });

  const renameCurrentProject = () => loginAndDo(async () => {
    if (!detail) return;
    const name = window.prompt('项目名称', detail.project.name)?.trim();
    if (!name || name === detail.project.name) return;
    const response = await performBusinessFetch(`/api/write/canvas/projects/${detail.project.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!response?.ok) return showToast('重命名项目失败');
    const payload = await response.json();
    setProjects(previous => previous.map(project => project.id === payload.project.id ? payload.project : project));
    setDetail(previous => previous ? { ...previous, project: payload.project } : previous);
  });

  const deleteCurrentProject = () => loginAndDo(async () => {
    if (isAgentRunning) return showToast('Agent 正在运行，请等待本次生成结束后删除项目');
    if (!detail || !window.confirm(`删除项目「${detail.project.name}」？`)) return;
    const response = await performBusinessFetch(`/api/write/canvas/projects/${detail.project.id}`, { method: 'DELETE' });
    if (!response?.ok) return showToast('删除项目失败');
    const projectsResponse = await fetch('/api/write/canvas/projects').catch(() => null);
    if (!projectsResponse?.ok) return showToast('项目已删除，请刷新项目列表');
    const payload = await projectsResponse.json();
    const nextProjects: WriteCanvasProject[] = Array.isArray(payload.projects) ? payload.projects : [];
    for (const project of nextProjects) {
      documentRevisionByProjectRef.current.set(project.id, project.documentRevision || project.tldrawRevision || 0);
    }
    setProjects(nextProjects);
    if (nextProjects[0]) {
      activateProject(nextProjects[0].id);
    } else {
      detailRequestSequenceRef.current += 1;
      currentProjectIdRef.current = null;
      editorDocumentProjectIdRef.current = null;
      detailRef.current = null;
      setCurrentProjectId(null);
      setDetail(null);
    }
    setActivePanel(null);
  });

  const saveProjectSkills = async (selection: WriteSkillSelection) => {
    const projectId = currentProjectIdRef.current;
    if (!projectId) return;
    const response = await performBusinessFetch(`/api/write/canvas/projects/${projectId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultSkillConfig: selection }),
    });
    if (!response?.ok) return showToast('项目 Skills 保存失败');
    await loadProjectDetail(projectId);
    showToast('项目默认 Skills 已更新');
  };

  const createAgentFromTemplate = (template?: WriteAgentTemplate, options?: { open?: boolean }) => createNode({
    kind: 'agent',
    title: template?.name || '写作 Agent',
    templateId: template?.id,
    ...getViewportPlacement(360, 260),
  }, options);

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
    const response = await performBusinessFetch(`/api/write/canvas/projects/${projectId}/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '未命名作品',
        summary: '',
        scenario: 'custom-longform',
        status: 'editing',
        sections: createScenarioSections('custom-longform'),
        ...getViewportPlacement(420, 320),
      }),
    });
    if (!response?.ok) return showToast('创建作品失败');
    const payload = await response.json() as { document?: { nodeId?: number } };
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
    const projectId = currentProjectIdRef.current;
    if (!source || !projectId || isQuickActionRunning) return;
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
      if (response.status === 402) await refreshBillingStatus();
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
        events.filter(event => event.event === 'partial_status').forEach(event => {
          if (isCurrentQuickAction()) setQuickActionStatus(String(event.payload.message || '正在生成'));
        });
        for (const event of events.filter(item => item.event === 'final')) {
          if (!Array.isArray(event.payload.outputNodeIds)) throw new Error('AI 返回格式错误：终态缺少结果节点');
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
        await reconcileQuickActionRun(projectId, source.id, aiQuickAction, observedRunId, runStartedAt, runSequence).catch(() => undefined);
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
      const actionDetail = (event as CustomEvent<{ nodeId?: number; action?: CanvasNodeAction }>).detail;
      const node = detailRef.current?.nodes.find(item => item.id === Number(actionDetail?.nodeId));
      if (!node || !actionDetail?.action) return;
      if (actionDetail.action === 'new-child') void createInsightBranch(node);
      if (actionDetail.action === 'create-document') void createDocumentFromNode(node);
      if (actionDetail.action === 'ai-decompose') {
        closeQuickAction();
        setActivePanel(null);
        setContextAgentNodeId(null);
        setAiDecomposeNodeId(node.id);
        setAiQuickAction('extract_insights');
        setQuickActionStatus('');
      }
      if (actionDetail.action === 'run-agent-group' && Number.isFinite(Number(node.businessRef))) {
        openAgentGroups(Number(node.businessRef));
      }
    };
    const keyHandler = (event: KeyboardEvent) => {
      const isTab = event.key === 'Tab';
      const isEnter = event.key === 'Enter';
      if (!isTab && !isEnter) return;
      if ((!isTab && event.defaultPrevented) || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (activePanelRef.current !== null || aiDecomposeNodeId !== null || projectMenuOpen) return;
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
  }, [aiDecomposeNodeId, closeQuickAction, createDocumentFromNode, createInsightBranch, openAgentGroups, projectMenuOpen]);

  useEffect(() => {
    if (!canWrite || !detail || !currentProjectId || detail.nodes.some(node => node.kind === 'agent')) return;
    void createAgentFromTemplate(undefined, { open: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canWrite, detail?.project.id, currentProjectId]);

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
    summary: htmlToPlainText(note.content).slice(0, 180),
    ...getViewportPlacement(320, 200),
  });

  const addRecallCandidateToAgent = async (candidate: CanvasRecallCandidate, agentNode: WriteCanvasNode) => {
    if (!agentNode.agent) return;
    const response = await performBusinessFetch(`/api/write/canvas/agents/${agentNode.agent.id}/recall/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cardIds: [candidate.cardId] }),
    });
    if (!response?.ok) return showToast('候选素材加入失败，请重新搜索');
    const projectId = currentProjectIdRef.current;
    if (projectId) await loadProjectDetail(projectId);
    setRecallCandidatesByAgent(previous => ({
      ...previous,
      [agentNode.agent!.id]: (previous[agentNode.agent!.id] || []).filter(item => item.cardId !== candidate.cardId),
    }));
    selectNode(agentNode.id);
    showToast('候选素材已加入画布并连接，将从下一轮开始生效');
  };

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
    const response = await performBusinessFetch('/api/write/canvas/assets/upload', { method: 'POST', body: form });
    if (!response?.ok) return showToast('上传失败');
    const payload = await response.json();
    await loadProjectDetail(projectId);
    await finishNodeAddition(payload.node || null);
    showToast('已添加上传资料');
  };

  const updateAgentNode = async (node: WriteCanvasNode, data: Record<string, unknown>) => {
    if (!node.agent) return;
    const response = await performBusinessFetch(`/api/write/canvas/nodes/${node.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const projectId = currentProjectIdRef.current;
    if (!response?.ok || !projectId) return showToast('Agent 更新失败');
    await loadProjectDetail(projectId);
    showToast('Agent 设置已保存');
  };

  const updateCanvasNode = async (node: WriteCanvasNode, data: Record<string, unknown>) => {
    const response = await performBusinessFetch(`/api/write/canvas/nodes/${node.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const projectId = currentProjectIdRef.current;
    if (!response?.ok || !projectId) return showToast('节点更新失败');
    await loadProjectDetail(projectId);
  };

  const saveTemplate = async (draft: AgentDraft) => {
    const response = await performBusinessFetch('/api/write/agent/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: draft.title,
        model: draft.model,
        systemPrompt: draft.systemPrompt,
        temperature: draft.temperature,
        topP: draft.topP,
        maxTokens: draft.maxTokens,
        skillConfig: draft.skillConfig,
      }),
    });
    if (!response?.ok) return showToast('模板保存失败');
    await loadTemplates();
    showToast('已保存为 Agent 模板');
  };

  const sendAgentMessage = async (agentNode: WriteCanvasNode, action?: 'create_article') => {
    if (!canWriteRef.current) return showToast('当前为只读模式，不能调用 Agent');
    if (!agentNode.agent || !agentInput.trim()) return;
    const requestProjectId = currentProjectIdRef.current;
    const requestAgentId = agentNode.agent.id;
    const requestAgentNodeId = agentNode.id;
    if (
      !requestProjectId
      || !canvasDetailContainsAgent(detailRef.current, requestProjectId, requestAgentNodeId, requestAgentId)
    ) {
      showToast('该 Agent 已不在当前项目中');
      return;
    }
    const message = agentInput.trim();
    let observedAgentRunId = '';
    const creationRequestKey = action === 'create_article'
      ? buildCanvasCreateArticleRequestKey(requestProjectId, requestAgentId, message)
      : null;
    if (action === 'create_article' && !creationRequestKey) {
      showToast('无法创建文章请求，请检查当前项目与 Agent');
      return;
    }
    const creationRequestStore = creationRequestKey ? getCreateArticleRequestStore() : null;
    const requestId = creationRequestKey
      ? creationRequestStore?.requests.get(creationRequestKey)?.requestId || createClientRequestId()
      : undefined;
    if (creationRequestKey && requestId) {
      if (!creationRequestStore || !rememberPendingCanvasCreateArticleRequest(
        creationRequestStore.requests,
        creationRequestKey,
        requestId,
      )) {
        showToast('无法保存创建文章的恢复句柄，请稍后重试');
        return;
      }
      const requestHandlePersisted = persistPendingCanvasCreateArticleRequests(
        getCanvasRequestSessionStorage(),
        creationRequestStore.ownerId,
        creationRequestStore.requests,
      );
      if (!requestHandlePersisted) {
        showToast('浏览器无法保存创建文章的恢复句柄；为避免重复计费，已取消本次请求');
        return;
      }
    }
    agentStreamAbortControllerRef.current?.abort();
    const requestController = new AbortController();
    agentStreamAbortControllerRef.current = requestController;
    const assertCurrentAgentRequest = (candidateDetail: WriteCanvasProjectDetail | null | undefined = detailRef.current) => {
      requestController.signal.throwIfAborted();
      if (
        agentStreamAbortControllerRef.current !== requestController
        || currentProjectIdRef.current !== requestProjectId
        || !canvasDetailContainsAgent(candidateDetail, requestProjectId, requestAgentNodeId, requestAgentId)
      ) {
        throw new DOMException('The canvas Agent request is no longer current', 'AbortError');
      }
    };
    const clearPendingCreationRequest = () => {
      if (!creationRequestKey || !requestId || !creationRequestStore) return;
      if (creationRequestStore.requests.get(creationRequestKey)?.requestId !== requestId) return;
      forgetPendingCanvasCreateArticleRequest(creationRequestStore.requests, creationRequestKey);
      persistPendingCanvasCreateArticleRequests(
        getCanvasRequestSessionStorage(),
        creationRequestStore.ownerId,
        creationRequestStore.requests,
      );
    };
    setAgentInput('');
    setIsAgentRunning(true);
    setRecallCandidatesByAgent(previous => ({ ...previous, [requestAgentId]: [] }));
    try {
      assertCurrentAgentRequest();
      const response = await fetch(`/api/write/canvas/agents/${requestAgentId}/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, action, requestId }),
        signal: requestController.signal,
      });
      if (response.status === 402) await refreshBillingStatus();
      if (!response.ok) {
        const errorPayload = await response.json().catch(() => null) as Record<string, unknown> | null;
        assertCurrentAgentRequest();
        if (shouldReplaceCanvasCreateArticleRequestId(errorPayload?.code)) {
          clearPendingCreationRequest();
        }
        const errorMessage = typeof errorPayload?.error === 'string' && errorPayload.error.trim()
          ? errorPayload.error.trim()
          : typeof errorPayload?.message === 'string' && errorPayload.message.trim()
            ? errorPayload.message.trim()
          : 'Agent 请求失败';
        throw new Error(errorMessage);
      }
      if (!response.body) throw new Error('Agent 请求失败');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let receivedFinal = false;

      const handleBufferedEvents = async (includeTail = false) => {
        const parts = buffer.split(/\r?\n\r?\n/);
        buffer = parts.pop() || '';
        if (includeTail && buffer.trim()) {
          parts.push(buffer);
          buffer = '';
        }
        for (const part of parts) {
          assertCurrentAgentRequest();
          const events = parseSseEvents(part);
          for (const event of events) {
            if (typeof event.payload.runId === 'string' && event.payload.runId) {
              observedAgentRunId = event.payload.runId;
            }
          }
          const error = events.find(event => event.event === 'error');
          if (error) throw new Error(String(error.payload.message || 'Agent 暂时不可用'));
          const candidates = events.flatMap(event => getRecallCandidates(event.payload));
          if (candidates.length > 0) {
            setRecallCandidatesByAgent(previous => ({ ...previous, [requestAgentId]: candidates }));
          }
          const finalEvent = events.find(event => event.event === 'final');
          if (finalEvent) {
            assertCurrentAgentRequest();
            receivedFinal = true;
            const refreshedDetail = await loadProjectDetail(requestProjectId);
            if (!refreshedDetail) {
              assertCurrentAgentRequest();
              throw new Error('文章已生成，但画布刷新失败；请重试以恢复结果');
            }
            assertCurrentAgentRequest(refreshedDetail);
            const noteNode = finalEvent.payload.noteNode && typeof finalEvent.payload.noteNode === 'object'
              ? finalEvent.payload.noteNode as Record<string, unknown>
              : null;
            const noteNodeId = Number(noteNode?.id);
            if (
              Number.isSafeInteger(noteNodeId)
              && noteNodeId > 0
              && refreshedDetail.nodes.some(node => node.id === noteNodeId && node.kind === 'note')
            ) {
              assertCurrentAgentRequest(refreshedDetail);
              selectNode(noteNodeId);
              showToast('文章已创建，并加入当前画布');
            }
          }
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        requestController.signal.throwIfAborted();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        await handleBufferedEvents();
      }
      buffer += decoder.decode();
      await handleBufferedEvents(true);
      if (!receivedFinal) throw new Error('Agent 连接中断，请重试');
      clearPendingCreationRequest();
    } catch (error) {
      if (requestController.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return;
      let persistedResult = false;
      if (requestProjectId && observedAgentRunId) {
        const refreshedDetail = await loadProjectDetail(requestProjectId);
        persistedResult = Boolean(refreshedDetail?.messages[requestAgentId]?.some(item => (
          item.role === 'assistant' && String(item.meta?.runId || '') === observedAgentRunId
        )));
      }
      if (persistedResult) {
        clearPendingCreationRequest();
        showToast('Agent 已完成，已恢复生成结果');
      } else {
        setAgentInput(current => current || message);
        showToast(error instanceof Error ? error.message : 'Agent 暂时不可用');
      }
    } finally {
      if (agentStreamAbortControllerRef.current === requestController) {
        agentStreamAbortControllerRef.current = null;
        setIsAgentRunning(false);
      }
    }
  };

  const saveMessageToCanvas = async (agentNode: WriteCanvasNode, message: WriteCanvasMessage) => {
    if (!agentNode.agent) return;
    const requestProjectId = currentProjectIdRef.current;
    const requestAgentId = agentNode.agent.id;
    const requestAgentNodeId = agentNode.id;
    if (
      !requestProjectId
      || !canvasDetailContainsAgent(detailRef.current, requestProjectId, requestAgentNodeId, requestAgentId)
    ) return showToast('该 Agent 已不在当前项目中');
    const messageKey = `${requestAgentId}:${message.id}`;
    if (savingResultMessageKeysRef.current.has(messageKey) || savedResultMessageKeysRef.current.has(messageKey)) return;
    savingResultMessageKeysRef.current.add(messageKey);
    setSavingResultMessageKeys(previous => new Set(previous).add(messageKey));
    try {
      const response = await performBusinessFetch(`/api/write/canvas/agents/${requestAgentId}/save-result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId: message.id, title: message.content.slice(0, 24) || 'Agent 输出' }),
      });
      if (!response?.ok) return showToast('保存到画布失败');
      const payload = await response.json();
      savedResultMessageKeysRef.current.add(messageKey);
      setSavedResultMessageKeys(previous => new Set(previous).add(messageKey));
      if (
        currentProjectIdRef.current !== requestProjectId
        || !canvasDetailContainsAgent(detailRef.current, requestProjectId, requestAgentNodeId, requestAgentId)
      ) return;
      const refreshedDetail = await loadProjectDetail(requestProjectId);
      if (
        currentProjectIdRef.current !== requestProjectId
        || !canvasDetailContainsAgent(refreshedDetail, requestProjectId, requestAgentNodeId, requestAgentId)
      ) return;
      const resultNodeId = Number(payload.node?.id);
      if (
        Number.isSafeInteger(resultNodeId)
        && resultNodeId > 0
        && refreshedDetail.nodes.some(node => node.id === resultNodeId && node.kind === 'result')
      ) selectNode(resultNodeId);
      showToast(payload.created === false ? '该输出已在画布中' : '已保存到画布');
    } catch {
      showToast('保存到画布失败');
    } finally {
      savingResultMessageKeysRef.current.delete(messageKey);
      setSavingResultMessageKeys(previous => {
        const next = new Set(previous);
        next.delete(messageKey);
        return next;
      });
    }
  };

  const openAddDrawer = (agentNodeId?: number) => {
    setContextAgentNodeId(agentNodeId || null);
    setProjectMenuOpen(false);
    setActivePanel('add');
  };

  useEffect(() => {
    const handleSelectProject = (event: Event) => {
      const eventDetail = (event as CustomEvent<Partial<CanvasProjectSelectionRequestDetail>>).detail;
      const projectId = Number(eventDetail?.projectId);
      if (!user || !Number.isSafeInteger(projectId) || projectId <= 0) return;
      if (eventDetail.ownerId !== undefined && eventDetail.ownerId !== user.id) return;
      void (async () => {
        const outcome = await switchProject(projectId);
        if (typeof eventDetail.requestId !== 'string' || !eventDetail.requestId) return;
        publishCanvasProjectSelectionResult({
          ownerId: user.id,
          requestId: eventDetail.requestId,
          projectId,
          status: outcome.status,
          currentProjectId: currentProjectIdRef.current,
          reason: outcome.reason,
        });
      })();
    };
    const handleExternalContentChanged = (event: Event) => {
      const eventDetail = (event as CustomEvent<CanvasExternalContentChangedDetail>).detail;
      const projectId = Number(eventDetail?.projectId);
      const nodeId = Number(eventDetail?.nodeId);
      if (!Number.isSafeInteger(projectId) || projectId <= 0 || projectId !== currentProjectIdRef.current) return;
      void (async () => {
        const refreshedDetail = await loadProjectDetail(projectId);
        if (!refreshedDetail || currentProjectIdRef.current !== projectId) return;
        if (Number.isSafeInteger(nodeId) && nodeId > 0 && refreshedDetail.nodes.some(node => node.id === nodeId)) {
          selectNode(nodeId);
        }
      })();
    };
    const handleCreateProject = () => createProject();
    const handleOpenAdd = () => openAddDrawer();
    window.addEventListener(CANVAS_PROJECT_SELECTION_REQUEST_EVENT, handleSelectProject);
    window.addEventListener(CANVAS_EXTERNAL_CONTENT_CHANGED_EVENT, handleExternalContentChanged);
    window.addEventListener('atomflow-canvas-create-project', handleCreateProject);
    window.addEventListener('atomflow-canvas-open-add', handleOpenAdd);
    return () => {
      window.removeEventListener(CANVAS_PROJECT_SELECTION_REQUEST_EVENT, handleSelectProject);
      window.removeEventListener(CANVAS_EXTERNAL_CONTENT_CHANGED_EVENT, handleExternalContentChanged);
      window.removeEventListener('atomflow-canvas-create-project', handleCreateProject);
      window.removeEventListener('atomflow-canvas-open-add', handleOpenAdd);
    };
  }, [loadProjectDetail, selectNode, switchProject, user]);

  const deleteSelectedNode = async (node: WriteCanvasNode) => {
    if (!window.confirm(`删除节点「${node.title}」？`)) return;
    closeInspector();
    await deleteNodeById(node.id);
  };

  const loadLatestDocument = async () => {
    const projectId = currentProjectIdRef.current;
    if (!projectId || projectTransitionInFlightRef.current) return;
    projectTransitionInFlightRef.current = true;
    try {
      const businessSaved = await flushBusinessMutationsRef.current();
      if (!businessSaved) return showToast('业务节点尚未保存，已取消载入最新版本');
      if (documentSaveTimerRef.current) {
        window.clearTimeout(documentSaveTimerRef.current);
        documentSaveTimerRef.current = null;
      }
      documentSaveQueuedRef.current = null;
      const activeSave = documentSaveInFlightRef.current;
      if (activeSave) await activeSave;
      if (currentProjectIdRef.current !== projectId) return;

      restoredDocumentKeyRef.current = null;
      const latest = await loadProjectDetail(projectId, { forceDocument: true });
      if (latest) {
        if (editorRef.current) syncEditorWithDetail(editorRef.current, latest, { forceServerGeometry: true });
        const revision = latest.project.documentRevision || latest.project.tldrawRevision || 0;
        documentRevisionByProjectRef.current.set(projectId, revision);
        documentRevisionRef.current = revision;
        documentConflictRef.current = null;
        setDocumentConflict(null);
        setDocumentSaveState('saved');
        showToast('已载入画布最新版本');
      }
    } finally {
      projectTransitionInFlightRef.current = false;
    }
  };

  const saveConflictAsNewProject = async () => {
    const conflict = documentConflictRef.current;
    const sourceProjectId = currentProjectIdRef.current;
    if (!conflict || !sourceProjectId || conflict.projectId !== sourceProjectId || projectTransitionInFlightRef.current) return;
    projectTransitionInFlightRef.current = true;
    try {
      const businessSaved = await flushBusinessMutationsRef.current();
      if (!businessSaved) return showToast('业务节点尚未保存，另存已取消');
      if (documentSaveTimerRef.current) {
        window.clearTimeout(documentSaveTimerRef.current);
        documentSaveTimerRef.current = null;
      }
      const activeSave = documentSaveInFlightRef.current;
      if (activeSave) await activeSave;
      if (currentProjectIdRef.current !== sourceProjectId) return;

      // Capture at the moment the user resolves the conflict so edits made after the
      // original 409 are preserved in the cloned project.
      const latestSnapshot = captureDocumentSnapshot();
      if (!latestSnapshot) return showToast('无法读取当前画布，另存失败');
      const localViewport = captureCanvasViewport(sourceProjectId);
      if (!localViewport) return showToast('无法读取当前画布视图，另存失败');
      const snapshotBlob = new Blob([JSON.stringify(latestSnapshot)], { type: 'application/json' });
      if (snapshotBlob.size > 2 * 1024 * 1024) {
        setDocumentSaveState('error');
        return showToast('画布文档超过 2MB，请删除内嵌媒体后重试');
      }

      const sourceProject = detailRef.current?.project.id === sourceProjectId
        ? detailRef.current.project
        : projects.find(project => project.id === sourceProjectId);
      const cloneSchemaVersion = resolveCanvasDocumentSchemaVersion(
        latestSnapshot,
        sourceProject?.documentSchemaVersion ?? 1,
      );
      const form = new FormData();
      form.append('name', `${sourceProject?.name || '魔法写作项目'} · 冲突副本`);
      form.append('snapshot', snapshotBlob, 'canvas-document.json');
      form.append('schemaVersion', String(cloneSchemaVersion));
      form.append('documentSchemaVersion', String(cloneSchemaVersion));
      form.append('viewport', JSON.stringify(localViewport));
      const cloneResponse = await performBusinessFetch(`/api/write/canvas/projects/${sourceProjectId}/clone`, {
        method: 'POST',
        body: form,
      });
      if (!cloneResponse?.ok) return showToast('另存项目失败');
      const clonePayload = await cloneResponse.json() as {
        project?: WriteCanvasProject;
        detail?: WriteCanvasProjectDetail;
      };
      const project = clonePayload.project || clonePayload.detail?.project;
      if (!project) return showToast('另存项目失败');

      documentRevisionByProjectRef.current.set(project.id, project.documentRevision || project.tldrawRevision || 0);
      setProjects(previous => [project, ...previous.filter(item => item.id !== project.id)]);
      activateProject(project.id);
      showToast('已完整另存画布、节点、连线与 Agent');
    } finally {
      projectTransitionInFlightRef.current = false;
    }
  };

  const handleCitationCapture = async (
    capture: CitationCapture,
    action: CitationAction,
    targetAgentNode: WriteCanvasNode | null,
  ) => {
    const projectId = currentProjectIdRef.current;
    if (!projectId) return;
    const placement = getViewportPlacement(320, 190);
    const targetAgentNodeId = action === 'add-and-connect' ? targetAgentNode?.id : undefined;
    if (action === 'add-and-connect' && !targetAgentNodeId) {
      showToast('画布中还没有可连接的 Agent');
      return;
    }
    const response = await performBusinessFetch(`/api/write/canvas/projects/${projectId}/citations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        captureId: stableCitationCaptureId(capture),
        article: {
          id: capture.articleId,
          title: capture.articleTitle,
          source: capture.source,
          url: capture.sourceUrl,
          stableIdentity: citationArticleIdentity(capture),
        },
        selection: {
          exact: capture.exact,
          prefix: capture.prefix,
          suffix: capture.suffix,
          paragraph: capture.paragraph,
          heading: capture.heading,
          capturedAt: new Date().toISOString(),
        },
        position: { x: placement.x, y: placement.y },
        targetAgentNodeId,
      }),
    });
    if (!response?.ok) return showToast('摘录加入画布失败');
    const payload = await response.json() as { node?: WriteCanvasNode; created?: boolean };
    await loadProjectDetail(projectId);
    if (payload.node?.id) selectNode(payload.node.id);
    showToast(action === 'add-and-connect' ? '摘录已加入并连接当前 Agent' : '摘录已加入画布');
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

  const renderInspectorPanel = (node: WriteCanvasNode | null, emptyMessage: string) => node ? (
    <CanvasInspector
      embedded
      readOnly={!canWrite}
      node={node}
      nodes={detail?.nodes || []}
      edges={detail?.edges || []}
      messages={node.agent ? detail?.messages[node.agent.id] || [] : []}
      agentInput={agentInput}
      isAgentRunning={isAgentRunning}
      onClose={closeInspector}
      onAgentInputChange={setAgentInput}
      onSendAgentMessage={() => void sendAgentMessage(node)}
      onCreateArticle={() => void sendAgentMessage(node, 'create_article')}
      onRemoveEdge={edge => void removeEdge(edge)}
      onSaveAgent={data => void updateAgentNode(node, data)}
      onSaveTemplate={data => void saveTemplate(data)}
      onSaveMessage={message => void saveMessageToCanvas(node, message)}
      savingMessageKeys={savingResultMessageKeys}
      savedMessageKeys={new Set([
        ...savedResultMessageKeys,
        ...(detail?.nodes || []).flatMap(item => {
          if (item.kind !== 'result' || !node.agent) return [];
          const sourceAgentId = Number(item.meta?.sourceAgentId);
          const messageId = Number(item.meta?.messageId);
          return sourceAgentId === node.agent.id && Number.isSafeInteger(messageId) && messageId > 0
            ? [`${sourceAgentId}:${messageId}`]
            : [];
        }),
      ])}
      onOpenAddContext={agentNodeId => openAddDrawer(agentNodeId)}
      onConnectToAgent={(sourceNodeId, agentNodeId) => void connectNodes(sourceNodeId, agentNodeId)}
      onUpdateNode={(item, data) => void updateCanvasNode(item, data)}
      onDocumentSaved={() => { if (currentProjectIdRef.current) void loadProjectDetail(currentProjectIdRef.current); }}
      onOpenAgentGroup={groupId => openAgentGroups(groupId)}
      onDeleteNode={item => void deleteSelectedNode(item)}
      recallCandidates={node.agent ? recallCandidatesByAgent[node.agent.id] || [] : []}
      onAddRecallCandidate={candidate => { void addRecallCandidateToAgent(candidate, node); }}
    />
  ) : (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center text-[11px] leading-5 text-[#8A8279]">
      {emptyMessage}
    </div>
  );

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-[#F4F1EA]">
      <section className="relative isolate min-w-0 flex-1 overflow-hidden border-r border-[#D9D4CB] bg-[#F4F4F1] xl:min-w-[560px]">
        <main className="absolute inset-0 z-0 bg-[#F4F4F1]">
          {productionMissingLicense ? (
            <div className="absolute inset-0 z-[100] flex items-center justify-center bg-white/95 px-8 text-center text-[13px] text-text2">生产环境需要配置 VITE_TLDRAW_LICENSE_KEY 后才能打开画布。</div>
          ) : null}
          <Tldraw shapeUtils={shapeUtils} overrides={canvasUiOverrides} onMount={onMount} licenseKey={licenseKey || undefined} components={{ DebugPanel: null, SharePanel: null }} />
        </main>

        <div onPointerDown={event => event.stopPropagation()} className="absolute left-4 top-4 z-[70] flex items-start gap-2">
          <div className="relative">
            <button
              type="button"
              onClick={() => setProjectMenuOpen(value => !value)}
              className="flex h-10 max-w-[300px] items-center gap-2 rounded-[7px] border border-[#D9D8D3] bg-white/96 px-3 text-left text-[12px] font-medium text-[#2F343A] shadow-[0_8px_24px_rgba(35,40,48,0.12)] backdrop-blur hover:border-[#9FB8DB]"
            >
              <span className="truncate">{detail?.project.name || '魔法写作项目'}</span>
              <span className={cn('ml-auto h-1.5 w-1.5 shrink-0 rounded-full', documentSaveState === 'saving' ? 'animate-pulse bg-[#D08A2F]' : documentSaveState === 'error' ? 'bg-[#C84A3D]' : 'bg-[#57A276]')} title={documentSaveState === 'saving' ? '正在保存' : documentSaveState === 'error' ? '保存异常' : '已保存'} />
              <ChevronDown size={14} className="shrink-0 text-[#777C83]" />
            </button>
            {projectMenuOpen ? (
              <div className="absolute left-0 top-full mt-2 w-[280px] overflow-hidden rounded-[8px] border border-[#D9D8D3] bg-white p-1.5 shadow-[0_16px_48px_rgba(35,40,48,0.18)]">
                <div className="max-h-56 overflow-y-auto">
                  {projects.map(project => (
                    <button key={project.id} type="button" onClick={() => {
                      setProjectMenuOpen(false);
                      window.dispatchEvent(new CustomEvent('atomflow-canvas-select-project', { detail: { projectId: project.id } }));
                    }} className={cn('w-full truncate rounded-[5px] px-3 py-2 text-left text-[11px]', project.id === currentProjectId ? 'bg-[#E7F0FF] font-medium text-[#185ABD]' : 'text-[#555A61] hover:bg-[#F2F1EE]')}>
                      {project.name}
                    </button>
                  ))}
                </div>
                {canWrite ? <div className="mt-1 border-t border-[#ECEAE5] pt-1">
                  <button type="button" onClick={createProject} className="flex w-full items-center gap-2 rounded-[5px] px-3 py-2 text-[11px] text-[#185ABD] hover:bg-[#F2F6FC]"><Plus size={13} />新建项目</button>
                  <button type="button" onClick={renameCurrentProject} className="flex w-full items-center gap-2 rounded-[5px] px-3 py-2 text-[11px] text-[#555A61] hover:bg-[#F2F1EE]"><Pencil size={13} />重命名当前项目</button>
                  <button
                    type="button"
                    onClick={deleteCurrentProject}
                    disabled={isAgentRunning}
                    title={isAgentRunning ? 'Agent 运行期间不能删除当前项目' : undefined}
                    className="flex w-full items-center gap-2 rounded-[5px] px-3 py-2 text-[11px] text-[#B34439] hover:bg-[#FCEDEA] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
                  >
                    <Trash2 size={13} />删除当前项目
                  </button>
                </div> : null}
              </div>
            ) : null}
          </div>
        </div>

        {documentConflict ? (
          <div onPointerDown={event => event.stopPropagation()} className="absolute left-1/2 top-4 z-[75] flex max-w-[calc(100%-360px)] -translate-x-1/2 items-center gap-3 rounded-lg border border-[#E4B8AD] bg-[#FFF7F4]/98 px-4 py-2.5 text-[11px] text-[#7F3D34] shadow-lg backdrop-blur">
            <span>检测到其他标签页的新版本，已停止自动覆盖。</span>
            <button type="button" onClick={() => void loadLatestDocument()} className="rounded-md bg-[#8F4035] px-2.5 py-1.5 font-medium text-white">载入最新版本</button>
            <button type="button" onClick={() => void saveConflictAsNewProject()} className="rounded-md border border-[#D7A89E] bg-white px-2.5 py-1.5 font-medium">另存为新项目</button>
          </div>
        ) : null}

        {canWrite ? <button
          type="button"
          aria-label="添加节点"
          onPointerDown={event => event.stopPropagation()}
          onClick={() => openAddDrawer()}
          className="absolute bottom-4 left-4 z-[70] inline-flex h-11 items-center gap-2 rounded-[7px] bg-[#1F6FEB] px-4 text-[12px] font-semibold text-white shadow-[0_12px_28px_rgba(31,111,235,0.32)] hover:bg-[#195FC9] md:left-[180px]"
        >
          <Plus size={17} /> 添加节点
        </button> : null}

        <button
          type="button"
          aria-label="打开上下文栏"
          onPointerDown={event => event.stopPropagation()}
          onClick={() => setMobileContextOpen(true)}
          className="absolute bottom-4 right-4 z-[70] flex h-11 items-center gap-2 rounded-[7px] border border-[#CCD5E0] bg-white/95 px-3 text-[11px] font-medium text-[#275F9E] shadow-lg backdrop-blur xl:hidden"
        >
          <PanelRightOpen size={16} />上下文
        </button>

        {canWrite && activePanel === 'add' ? (
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
                <div><h2 className="text-[14px] font-semibold text-[#20242A]">AI 拆解</h2><p className="mt-1 text-[11px] leading-5 text-[#747980]">只读取当前节点，结果会作为可追溯的新节点放到画布。</p></div>
                <button type="button" aria-label={isQuickActionRunning ? '取消 AI 拆解' : '关闭 AI 拆解'} onClick={() => closeQuickAction()} className="text-[11px] text-[#777C83] hover:text-[#20242A]">{isQuickActionRunning ? '取消生成' : '关闭'}</button>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-2">
                {canvasQuickActions.map(action => <button key={action.value} type="button" disabled={isQuickActionRunning} onClick={() => setAiQuickAction(action.value)} className={cn('min-h-[66px] rounded-[7px] border p-2.5 text-left', aiQuickAction === action.value ? 'border-[#77A4EB] bg-[#EEF5FF]' : 'border-[#DEDDD8] bg-white')}><span className="flex items-center gap-1.5 text-[11px] font-semibold"><Sparkles size={12} />{action.label}</span><span className="mt-1 block text-[9px] leading-4 text-[#7B8087]">{action.description}</span></button>)}
              </div>
              {quickActionStatus ? <p className="mt-3 text-center text-[10px] text-[#5F6E82]">{quickActionStatus}</p> : null}
              <button type="button" disabled={isQuickActionRunning} onClick={() => void submitAiDecomposition()} className="mt-4 inline-flex w-full items-center justify-center rounded-[6px] bg-[#1F6FEB] px-3 py-2 text-[11px] font-medium text-white disabled:opacity-50">{isQuickActionRunning ? '生成中…' : `生成${canvasQuickActions.find(action => action.value === aiQuickAction)?.label || '结果'}`}</button>
            </div>
          </div>
        ) : null}
      </section>

      <CanvasContextRail
        readOnly={!canWrite}
        nodes={detail?.nodes || []}
        selectedNode={selectedNode}
        assistantNode={defaultAgentNode}
        project={detail?.project || null}
        skills={writeAgentSkills}
        getArticleForNode={getArticleForNode}
        renderInspectorPanel={renderInspectorPanel}
        onCitationCapture={handleCitationCapture}
        onSaveProjectSkills={saveProjectSkills}
        onSaveAgentSkills={(node, selection) => updateAgentNode(node, { skillConfig: selection })}
        mobileOpen={mobileContextOpen}
        onMobileClose={() => setMobileContextOpen(false)}
      />
    </div>
  );
};
