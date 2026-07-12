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
  Bot,
  ChevronDown,
  FileText,
  Image as ImageIcon,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import { useAppContext } from '../context/AppContext';
import { CanvasAddDrawer } from '../components/write-canvas/CanvasAddDrawer';
import { CanvasInspector, type AgentDraft } from '../components/write-canvas/CanvasInspector';
import type {
  AtomCard,
  Note,
  SavedArticle,
  WriteAgentTemplate,
  WriteCanvasEdge,
  WriteCanvasMessage,
  WriteCanvasNode,
  WriteCanvasNodeKind,
  WriteCanvasProject,
  WriteCanvasProjectDetail,
} from '../types';
import { cn } from '../components/Nav';

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
  props?: Record<string, unknown>;
  meta?: Record<string, unknown>;
};

type ActivePanel = 'add' | 'inspector' | null;

class AtomFlowNodeShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'atomflow-node' as const;
  static override props = {
    w: T.number,
    h: T.number,
    nodeId: T.string,
    kind: T.string,
    title: T.string,
    summary: T.string,
  };

  override getDefaultProps() {
    return {
      w: 280,
      h: 180,
      nodeId: '',
      kind: 'asset_text',
      title: '未命名节点',
      summary: '',
    };
  }

  override component(shape: AtomFlowShape) {
    const tone = getNodeTone(shape.props.kind as WriteCanvasNodeKind);
    return (
      <HTMLContainer id={shape.id} style={{ width: shape.props.w, height: shape.props.h, pointerEvents: 'all' }}>
        <button
          type="button"
          onPointerDown={() => {
            window.dispatchEvent(new CustomEvent('atomflow-canvas-select', { detail: { nodeId: Number(shape.props.nodeId) } }));
          }}
          className="h-full w-full overflow-hidden rounded-[8px] border bg-white text-left shadow-[0_12px_30px_rgba(36,43,53,0.13)] transition-[box-shadow,border-color] hover:shadow-[0_16px_38px_rgba(36,43,53,0.18)]"
          style={{ borderColor: tone.border }}
        >
          <div className="flex h-full flex-col">
            <div className="flex items-center gap-2 border-b px-3 py-2.5" style={{ borderColor: tone.border, background: tone.bg }}>
              <span className="flex h-7 w-7 items-center justify-center rounded-[5px] bg-white/80" style={{ color: tone.text }}>
                {shape.props.kind === 'agent' ? <Bot size={15} /> : shape.props.kind === 'asset_image' ? <ImageIcon size={15} /> : <FileText size={15} />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] font-semibold text-[#252A31]">{shape.props.title}</div>
                <div className="mt-0.5 text-[10px]" style={{ color: tone.text }}>{getNodeKindLabel(shape.props.kind as WriteCanvasNodeKind)}</div>
              </div>
            </div>
            <div className="min-h-0 flex-1 px-3 py-2.5">
              <div className="line-clamp-6 whitespace-pre-wrap text-[11px] leading-5 text-[#666C74]">
                {shape.props.summary || (shape.props.kind === 'agent' ? '连接资料后开始对话。' : '暂无摘要')}
              </div>
            </div>
          </div>
        </button>
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
  note: '文章草稿',
  agent: 'Agent',
  result: '输出结果',
}[kind]);

const getNodeTone = (kind: WriteCanvasNodeKind) => {
  if (kind === 'agent') return { bg: '#EAF2FF', border: '#AFC9F5', text: '#225DAA' };
  if (kind === 'result') return { bg: '#F4EEFF', border: '#D5C5F1', text: '#6A4C96' };
  if (kind === 'asset_image') return { bg: '#EAF7F1', border: '#B9DFCE', text: '#2C7455' };
  if (kind === 'atom_card') return { bg: '#FFF5E5', border: '#EACF9F', text: '#8C5D20' };
  return { bg: '#F7F5F0', border: '#D7D3CA', text: '#676057' };
};

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
  .split('\n\n')
  .map(block => block.trim())
  .filter(Boolean)
  .map(block => {
    const event = block.match(/^event:\s*(.+)$/m)?.[1] || 'message';
    const data = block.match(/^data:\s*(.+)$/m)?.[1];
    if (!data) return null;
    try {
      return { event, payload: JSON.parse(data) };
    } catch {
      return null;
    }
  })
  .filter((item): item is { event: string; payload: Record<string, unknown> } => Boolean(item));

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
  const editorRef = useRef<Editor | null>(null);
  const detailRef = useRef<WriteCanvasProjectDetail | null>(null);
  const activePanelRef = useRef<ActivePanel>(null);
  const positionSyncTimerRef = useRef<number | null>(null);
  const editorChangeTimerRef = useRef<number | null>(null);
  const currentProjectIdRef = useRef<number | null>(null);
  const restoredCameraProjectRef = useRef<number | null>(null);
  const isSyncingEditorRef = useRef(false);
  const pendingArrowIdsRef = useRef(new Set<string>());
  const pendingDeletedNodeIdsRef = useRef(new Set<number>());
  const pendingDeletedEdgeIdsRef = useRef(new Set<number>());
  const pendingCanonicalEdgeIdsRef = useRef(new Set<number>());
  const detailRequestSequenceRef = useRef(0);

  const selectedNode = useMemo(
    () => detail?.nodes.find(node => node.id === selectedNodeId) || null,
    [detail?.nodes, selectedNodeId]
  );
  const agentNodes = useMemo(() => detail?.nodes.filter(node => node.kind === 'agent') || [], [detail?.nodes]);
  const selectedAgentMessages = selectedNode?.agent ? detail?.messages[selectedNode.agent.id] || [] : [];
  const contextAgentNode = contextAgentNodeId ? detail?.nodes.find(node => node.id === contextAgentNodeId) || null : null;

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
    const requestSequence = ++detailRequestSequenceRef.current;
    const response = await fetch(`/api/write/canvas/projects/${projectId}`);
    if (!response.ok) return null;
    const payload: WriteCanvasProjectDetail = await response.json();
    if (requestSequence !== detailRequestSequenceRef.current || currentProjectIdRef.current !== projectId) return null;
    detailRef.current = payload;
    setDetail(payload);
    setProjects(previous => previous.map(project => project.id === payload.project.id ? payload.project : project));
    setSelectedNodeId(previous => previous && payload.nodes.some(node => node.id === previous) ? previous : null);
    return payload;
  }, []);

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
    setActivePanel(null);
    setSelectedNodeId(null);
    setContextAgentNodeId(null);
    editorRef.current?.selectNone();
    if (currentProjectId) void loadProjectDetail(currentProjectId);
  }, [currentProjectId, loadProjectDetail]);

  useEffect(() => {
    detailRef.current = detail;
  }, [detail]);

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
    const editor = editorRef.current;
    const shapeId = shapeIdForNode(nodeId);
    if (editor?.getShape(shapeId)) editor.select(shapeId);
  }, []);

  useEffect(() => {
    const selectHandler = (event: Event) => {
      const nodeId = (event as CustomEvent<{ nodeId: number }>).detail?.nodeId;
      if (Number.isFinite(nodeId)) selectNode(nodeId);
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
      x: source.x + source.width / 2,
      y: source.y + source.height / 2,
      meta: { atomflowCanonical: true, atomflowEdgeId: edge.id },
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
      }, { history: 'ignore' });
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
    try {
      const response = await fetch(`/api/write/canvas/nodes/${nodeId}`, { method: 'DELETE' });
      const projectId = currentProjectIdRef.current;
      if (response.ok && projectId) {
        await loadProjectDetail(projectId);
        if (!options?.quiet) showToast('节点已删除');
      } else if (!options?.quiet) {
        showToast('删除节点失败');
      }
    } finally {
      pendingDeletedNodeIdsRef.current.delete(nodeId);
    }
  }, [loadProjectDetail, showToast]);

  const reconcileSelection = useCallback((editor: Editor) => {
    const currentDetail = detailRef.current;
    if (!currentDetail) return;

    const selectedIds = editor.getSelectedShapeIds();
    const selectedBusinessShape = selectedIds.length === 1 ? editor.getShape(selectedIds[0]) : undefined;
    const selectedBusinessNodeId = nodeIdFromShape(selectedBusinessShape);
    if (selectedBusinessNodeId) {
      if (activePanelRef.current !== 'add') {
        setSelectedNodeId(selectedBusinessNodeId);
        setActivePanel('inspector');
      }
    } else if (selectedIds.length === 0 && activePanelRef.current === 'inspector') {
      setSelectedNodeId(null);
      setActivePanel(null);
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
      if (source && target?.kind === 'agent' && source.kind !== 'agent') {
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

      const source = currentDetail.nodes.find(node => node.id === sourceNodeId);
      const target = currentDetail.nodes.find(node => node.id === targetNodeId);
      pendingCanonicalEdgeIdsRef.current.add(edgeId);
      try {
        if (source && target?.kind === 'agent' && source.kind !== 'agent') {
          const createResponse = await fetch('/api/write/canvas/edges', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId, sourceNodeId: source.id, targetNodeId: target.id }),
          });
          if (!createResponse.ok) throw new Error('edge create failed');
          const deleteResponse = await fetch('/api/write/canvas/edges', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: edge.id }),
          });
          if (!deleteResponse.ok) throw new Error('edge delete failed');
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
  }, [loadProjectDetail, showToast]);

  const onMount = useCallback((editor: Editor) => {
    editorRef.current = editor;
    if (detailRef.current) window.setTimeout(() => syncEditorWithDetail(editor, detailRef.current!), 0);
    const stopSelectionListener = editor.store.listen(() => {
      if (editorChangeTimerRef.current) window.clearTimeout(editorChangeTimerRef.current);
      editorChangeTimerRef.current = window.setTimeout(() => reconcileSelection(editor), 80);

      if (positionSyncTimerRef.current) window.clearTimeout(positionSyncTimerRef.current);
      positionSyncTimerRef.current = window.setTimeout(() => {
        if (isSyncingEditorRef.current) return;
        const shapes = (editor.getCurrentPageShapes() as CanvasShape[]).filter(isAtomFlowShape);
        for (const shape of shapes) {
          const nodeId = Number(shape.props.nodeId);
          if (!Number.isFinite(nodeId)) continue;
          void fetch(`/api/write/canvas/nodes/${nodeId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ x: shape.x, y: shape.y, width: shape.props.w, height: shape.props.h }),
          }).catch(() => undefined);
        }
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
      stopDocumentListener();
    };
  }, [reconcileCanonicalArrowChanges, reconcileSelection, reconcileUserDocumentChanges, syncEditorWithDetail]);

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

  const createProject = () => loginAndDo(async () => {
    const response = await fetch('/api/write/canvas/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '新的魔法写作项目' }),
    });
    if (!response.ok) return showToast('新建项目失败');
    const payload = await response.json();
    setProjects(previous => [payload.project, ...previous]);
    setCurrentProjectId(payload.project.id);
    setProjectMenuOpen(false);
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
    setProjects(nextProjects);
    setCurrentProjectId(nextProjects[0]?.id || null);
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
    const message = agentInput.trim();
    setAgentInput('');
    setIsAgentRunning(true);
    try {
      const response = await fetch(`/api/write/canvas/agents/${selectedNode.agent.id}/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      if (!response.ok || !response.body) throw new Error('Agent 请求失败');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const boundary = buffer.lastIndexOf('\n\n');
        if (boundary < 0) continue;
        const events = parseSseEvents(buffer.slice(0, boundary + 2));
        buffer = buffer.slice(boundary + 2);
        const error = events.find(event => event.event === 'error');
        if (error) throw new Error(String(error.payload.message || 'Agent 暂时不可用'));
        if (events.some(event => event.event === 'final') && currentProjectIdRef.current) {
          await loadProjectDetail(currentProjectIdRef.current);
        }
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Agent 暂时不可用');
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
                  <button key={project.id} type="button" onClick={() => { setCurrentProjectId(project.id); setProjectMenuOpen(false); }} className={cn('w-full truncate rounded-[5px] px-3 py-2 text-left text-[11px]', project.id === currentProjectId ? 'bg-[#E7F0FF] font-medium text-[#185ABD]' : 'text-[#555A61] hover:bg-[#F2F1EE]')}>
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
          onAddCard={card => void addCardNode(card)}
          onAddArticle={article => void addArticleNode(article)}
          onAddNote={note => void addNoteNode(note)}
        />
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
          onDeleteNode={node => void deleteSelectedNode(node)}
        />
      ) : null}
    </div>
  );
};
