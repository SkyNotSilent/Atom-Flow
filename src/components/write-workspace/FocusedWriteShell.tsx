import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  BookOpenText,
  ChevronLeft,
  ChevronRight,
  FileStack,
  LayoutDashboard,
  Library,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Sparkles,
} from 'lucide-react';
import { useAppContext, type WriteWorkspaceMode } from '../../context/AppContext';
import type { WriteCanvasProject } from '../../types';
import {
  CANVAS_PROJECTS_CHANGED_EVENT,
  CANVAS_PROJECT_SELECTION_RESULT_EVENT,
  createCanvasProjectSelectionRequestId,
  readCanvasProjectTarget,
  rememberCanvasProjectTarget,
  requestCanvasProjectSelection,
  resolveCanvasProjectTarget,
  type CanvasProjectsChangedDetail,
  type CanvasProjectSelectionResultDetail,
} from '../../utils/canvasProjectTarget';
import { AtomFlowGalaxyIcon } from '../AtomFlowGalaxyIcon';
import { cn } from '../Nav';

const STORAGE_KEY = 'atomflow:focused-write-layout:v1';
const DEFAULT_LEFT_WIDTH = 288;
const DEFAULT_RIGHT_WIDTH = 420;
const MIN_LEFT_WIDTH = 232;
const MAX_LEFT_WIDTH = 360;
const MIN_RIGHT_WIDTH = 320;
const MAX_RIGHT_WIDTH = 560;
const MIN_CENTER_WIDTH = 560;

type StoredLayout = {
  leftWidth?: number;
  rightWidth?: number;
  leftCollapsed?: boolean;
  rightCollapsed?: boolean;
};

type FocusedWriteShellProps = {
  children: React.ReactNode;
  onExit?: () => void;
};

type DragTarget = 'left' | 'right' | null;

type PendingProjectSelection = {
  requestId: string;
  projectId: number;
  previousProjectId: number | null;
};

const readStoredLayout = (): Required<StoredLayout> => {
  const defaults = {
    leftWidth: DEFAULT_LEFT_WIDTH,
    rightWidth: DEFAULT_RIGHT_WIDTH,
    leftCollapsed: false,
    rightCollapsed: false,
  };
  if (typeof window === 'undefined') return defaults;
  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}') as StoredLayout;
    return {
      leftWidth: Math.min(MAX_LEFT_WIDTH, Math.max(MIN_LEFT_WIDTH, Number(value.leftWidth) || DEFAULT_LEFT_WIDTH)),
      rightWidth: Math.min(MAX_RIGHT_WIDTH, Math.max(MIN_RIGHT_WIDTH, Number(value.rightWidth) || DEFAULT_RIGHT_WIDTH)),
      leftCollapsed: value.leftCollapsed === true,
      rightCollapsed: value.rightCollapsed === true,
    };
  } catch {
    return defaults;
  }
};

const modeItems: Array<{
  value: WriteWorkspaceMode;
  label: string;
  hint: string;
  icon: React.ReactNode;
}> = [
  { value: 'graph', label: '画布', hint: '自由编排与写作 Agent', icon: <LayoutDashboard size={16} /> },
  { value: 'articles', label: '我的文章', hint: '编辑、引用与自动保存', icon: <BookOpenText size={16} /> },
  { value: 'skills', label: 'Skills', hint: '写作风格与工作流', icon: <Sparkles size={16} /> },
];

export const FocusedWriteShell: React.FC<FocusedWriteShellProps> = ({ children, onExit }) => {
  const {
    user,
    writeWorkspaceMode,
    setWriteWorkspaceMode,
    savedArticles,
    savedCards,
    notes,
    billingState,
  } = useAppContext();
  const canWrite = billingState.phase === 'ready' && billingState.status.access === 'full';
  const initialLayout = useMemo(readStoredLayout, []);
  const [leftWidth, setLeftWidth] = useState(initialLayout.leftWidth);
  const [rightWidth, setRightWidth] = useState(initialLayout.rightWidth);
  const [leftCollapsed, setLeftCollapsed] = useState(initialLayout.leftCollapsed);
  const [rightCollapsed, setRightCollapsed] = useState(initialLayout.rightCollapsed);
  const [mobileLibraryOpen, setMobileLibraryOpen] = useState(false);
  const [projects, setProjects] = useState<WriteCanvasProject[]>([]);
  const [currentProjectId, setCurrentProjectId] = useState<number | null>(null);
  const [pendingProjectSelection, setPendingProjectSelection] = useState<PendingProjectSelection | null>(null);
  const [dragTarget, setDragTarget] = useState<DragTarget>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const pendingProjectSelectionRef = useRef<PendingProjectSelection | null>(null);
  const projectSelectionTimeoutRef = useRef<number | null>(null);

  const loadProjects = useCallback(async () => {
    if (!user) {
      setProjects([]);
      setCurrentProjectId(null);
      return;
    }
    const response = await fetch('/api/write/canvas/projects');
    if (!response.ok) return;
    const payload = await response.json() as { projects?: WriteCanvasProject[] };
    const nextProjects = Array.isArray(payload.projects) ? payload.projects : [];
    const rememberedProjectId = readCanvasProjectTarget(user.id);
    setProjects(nextProjects);
    setCurrentProjectId(current => resolveCanvasProjectTarget(nextProjects, current ?? rememberedProjectId));
  }, [user]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    const handleProjects = (event: Event) => {
      const detail = (event as CustomEvent<CanvasProjectsChangedDetail>).detail;
      if (!user || !detail || detail.ownerId !== user.id) return;
      if (Array.isArray(detail.projects)) setProjects(detail.projects);
      setCurrentProjectId(detail.currentProjectId);
      rememberCanvasProjectTarget(user.id, detail.currentProjectId);

      const pending = pendingProjectSelectionRef.current;
      if (!pending || (detail.currentProjectId !== pending.projectId && detail.currentProjectId === pending.previousProjectId)) return;
      if (projectSelectionTimeoutRef.current) window.clearTimeout(projectSelectionTimeoutRef.current);
      projectSelectionTimeoutRef.current = null;
      pendingProjectSelectionRef.current = null;
      setPendingProjectSelection(null);
    };
    const handleSelectionResult = (event: Event) => {
      const detail = (event as CustomEvent<CanvasProjectSelectionResultDetail>).detail;
      const pending = pendingProjectSelectionRef.current;
      if (!user || !detail || detail.ownerId !== user.id || !pending || detail.requestId !== pending.requestId) return;
      if (projectSelectionTimeoutRef.current) window.clearTimeout(projectSelectionTimeoutRef.current);
      projectSelectionTimeoutRef.current = null;
      pendingProjectSelectionRef.current = null;
      setPendingProjectSelection(null);
      setCurrentProjectId(detail.currentProjectId);
      rememberCanvasProjectTarget(user.id, detail.currentProjectId);
    };
    window.addEventListener(CANVAS_PROJECTS_CHANGED_EVENT, handleProjects);
    window.addEventListener(CANVAS_PROJECT_SELECTION_RESULT_EVENT, handleSelectionResult);
    return () => {
      window.removeEventListener(CANVAS_PROJECTS_CHANGED_EVENT, handleProjects);
      window.removeEventListener(CANVAS_PROJECT_SELECTION_RESULT_EVENT, handleSelectionResult);
      if (projectSelectionTimeoutRef.current) window.clearTimeout(projectSelectionTimeoutRef.current);
      projectSelectionTimeoutRef.current = null;
      pendingProjectSelectionRef.current = null;
    };
  }, [user]);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      leftWidth,
      rightWidth,
      leftCollapsed,
      rightCollapsed,
    } satisfies StoredLayout));
  }, [leftCollapsed, leftWidth, rightCollapsed, rightWidth]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width || root.getBoundingClientRect().width;
      // Below xl the context rail becomes an overlay, so it no longer consumes
      // center width. Desktop widths are clamped whenever the viewport changes.
      if (width < 1280) return;
      let nextLeft = leftWidth;
      let nextRight = rightWidth;
      if (!rightCollapsed) {
        const occupiedLeft = leftCollapsed ? 68 : nextLeft;
        nextRight = Math.max(MIN_RIGHT_WIDTH, Math.min(nextRight, width - occupiedLeft - MIN_CENTER_WIDTH));
      }
      if (!leftCollapsed) {
        const occupiedRight = rightCollapsed ? 0 : nextRight;
        nextLeft = Math.max(MIN_LEFT_WIDTH, Math.min(nextLeft, width - occupiedRight - MIN_CENTER_WIDTH));
      }
      if (nextLeft !== leftWidth) setLeftWidth(nextLeft);
      if (nextRight !== rightWidth) setRightWidth(nextRight);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [leftCollapsed, leftWidth, rightCollapsed, rightWidth]);

  useEffect(() => {
    if (!dragTarget) return;
    const handleMove = (event: PointerEvent) => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      if (dragTarget === 'left') {
        const maxAllowed = Math.min(MAX_LEFT_WIDTH, rect.width - (rightCollapsed ? 0 : rightWidth) - MIN_CENTER_WIDTH);
        setLeftWidth(Math.max(MIN_LEFT_WIDTH, Math.min(maxAllowed, event.clientX - rect.left)));
        return;
      }
      const occupiedLeft = leftCollapsed ? 68 : leftWidth;
      const maxAllowed = Math.min(MAX_RIGHT_WIDTH, rect.width - occupiedLeft - MIN_CENTER_WIDTH);
      setRightWidth(Math.max(MIN_RIGHT_WIDTH, Math.min(maxAllowed, rect.right - event.clientX)));
    };
    const handleUp = () => setDragTarget(null);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp, { once: true });
    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
  }, [dragTarget, leftCollapsed, leftWidth, rightCollapsed, rightWidth]);

  const selectProject = (projectId: number) => {
    if (!user || projectId === currentProjectId || pendingProjectSelectionRef.current) return;
    const request: PendingProjectSelection = {
      requestId: createCanvasProjectSelectionRequestId(),
      projectId,
      previousProjectId: currentProjectId,
    };
    pendingProjectSelectionRef.current = request;
    setPendingProjectSelection(request);
    setWriteWorkspaceMode('graph');
    setMobileLibraryOpen(false);
    window.setTimeout(() => {
      requestCanvasProjectSelection({ ownerId: user.id, requestId: request.requestId, projectId });
    }, 0);
    projectSelectionTimeoutRef.current = window.setTimeout(() => {
      if (pendingProjectSelectionRef.current?.requestId !== request.requestId) return;
      pendingProjectSelectionRef.current = null;
      projectSelectionTimeoutRef.current = null;
      setPendingProjectSelection(null);
      setCurrentProjectId(request.previousProjectId);
    }, 10_000);
  };

  const openMaterials = () => {
    if (!canWrite) return;
    setWriteWorkspaceMode('graph');
    setMobileLibraryOpen(false);
    window.setTimeout(() => window.dispatchEvent(new Event('atomflow-canvas-open-add')), 0);
  };

  const effectiveLeftWidth = leftCollapsed ? 68 : leftWidth;
  const effectiveRightWidth = rightCollapsed ? 0 : rightWidth;
  const shellStyle = {
    '--write-left-width': `${effectiveLeftWidth}px`,
    '--write-context-width': `${effectiveRightWidth}px`,
  } as React.CSSProperties;

  return (
    <div
      ref={rootRef}
      className={cn(
        'atomflow-focused-write relative flex h-full min-h-0 w-full overflow-hidden bg-[#F3EFE7] text-[#24211D]',
        rightCollapsed && 'atomflow-write-context-collapsed',
      )}
      style={shellStyle}
    >
      <aside
        className={cn(
          'relative z-[110] hidden h-full shrink-0 flex-col border-r border-[#DCD4C7] bg-[#F9F5ED] xl:flex',
          leftCollapsed ? 'items-center' : '',
        )}
        style={{ width: effectiveLeftWidth }}
      >
        <div className={cn('flex h-16 items-center border-b border-[#E2DACF]', leftCollapsed ? 'justify-center px-2' : 'justify-between px-4')}>
          <button
            type="button"
            onClick={onExit}
            className={cn('group flex min-w-0 items-center gap-3 rounded-lg text-left', leftCollapsed ? 'h-10 w-10 justify-center' : 'px-1 py-2')}
            title="返回 AtomFlow"
          >
            {leftCollapsed ? <ArrowLeft size={18} className="text-[#57514A]" /> : (
              <>
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[#D9D0C2] bg-white text-[#1F64B5] shadow-sm">
                  <AtomFlowGalaxyIcon size={18} />
                </span>
                <span className="min-w-0">
                  <span className="block truncate font-serif text-[14px] font-bold tracking-wide">AtomFlow</span>
                  <span className="mt-0.5 block text-[10px] text-[#948A7E] group-hover:text-[#2969B4]">返回工作台</span>
                </span>
              </>
            )}
          </button>
          {!leftCollapsed ? (
            <button type="button" onClick={() => setLeftCollapsed(true)} className="flex h-8 w-8 items-center justify-center rounded-md text-[#8B8278] hover:bg-[#ECE6DC] hover:text-[#39352F]" title="折叠左栏">
              <ChevronLeft size={16} />
            </button>
          ) : null}
        </div>

        <div className={cn('border-b border-[#E2DACF]', leftCollapsed ? 'px-2 py-3' : 'px-3 py-4')}>
          {!leftCollapsed ? <div className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#A09587]">写作空间</div> : null}
          <nav className="space-y-1" aria-label="写作模式">
            {modeItems.map(item => (
              <button
                key={item.value}
                type="button"
                onClick={() => setWriteWorkspaceMode(item.value)}
                title={leftCollapsed ? item.label : undefined}
                className={cn(
                  'flex w-full items-center rounded-lg transition-colors',
                  leftCollapsed ? 'h-10 justify-center' : 'gap-3 px-3 py-2.5 text-left',
                  writeWorkspaceMode === item.value
                    ? 'bg-[#E4EDF9] text-[#1F5FA8]'
                    : 'text-[#665F57] hover:bg-[#EEE8DE] hover:text-[#28241F]',
                )}
              >
                <span className="shrink-0">{item.icon}</span>
                {!leftCollapsed ? (
                  <span className="min-w-0">
                    <span className="block text-[12px] font-semibold">{item.label}</span>
                    <span className="mt-0.5 block truncate text-[10px] text-[#958C82]">{item.hint}</span>
                  </span>
                ) : null}
              </button>
            ))}
          </nav>
        </div>

        {!leftCollapsed ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
            <div className="flex items-center justify-between px-2">
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#A09587]">画布项目</div>
              {canWrite ? <button type="button" onClick={() => {
                setWriteWorkspaceMode('graph');
                window.setTimeout(() => window.dispatchEvent(new Event('atomflow-canvas-create-project')), 0);
              }} className="flex h-7 w-7 items-center justify-center rounded-md text-[#82796E] hover:bg-[#E9E2D7] hover:text-[#1F64B5]" title="新建项目">
                <Plus size={14} />
              </button> : null}
            </div>
            <div className="mt-2 space-y-1">
              {projects.length > 0 ? projects.map(project => (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => selectProject(project.id)}
                  aria-current={currentProjectId === project.id ? 'page' : undefined}
                  aria-busy={pendingProjectSelection?.projectId === project.id || undefined}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[11px]',
                    writeWorkspaceMode === 'graph' && (pendingProjectSelection?.projectId ?? currentProjectId) === project.id
                      ? 'bg-white font-medium text-[#245E9F] shadow-sm ring-1 ring-[#DED6CA]'
                      : 'text-[#675F56] hover:bg-[#EFE9DF]',
                  )}
                >
                  <FileStack size={13} className={cn('shrink-0', pendingProjectSelection?.projectId === project.id && 'animate-pulse')} />
                  <span className="truncate">{project.name}</span>
                </button>
              )) : (
                <div className="rounded-lg border border-dashed border-[#DCD3C5] px-3 py-4 text-center text-[10px] leading-5 text-[#9A9083]">{canWrite ? '创建你的第一个写作画布' : '当前账户没有可查看的历史画布'}</div>
              )}
            </div>

            <div className="mt-6 px-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#A09587]">素材库</div>
            {canWrite ? <button type="button" onClick={openMaterials} className="mt-2 flex w-full items-center gap-3 rounded-lg border border-[#DDD4C7] bg-white/70 px-3 py-3 text-left hover:border-[#9CB9DC] hover:bg-white">
              <Library size={16} className="shrink-0 text-[#2A67AA]" />
              <span className="min-w-0 flex-1">
                <span className="block text-[11px] font-semibold text-[#403B35]">添加到画布</span>
                <span className="mt-1 block truncate text-[10px] text-[#968C80]">文章、原子卡、文件与 Agent</span>
              </span>
            </button> : null}
            <div className="mt-2 grid grid-cols-3 gap-1.5">
              <LibraryStat value={savedArticles.length} label="文章" />
              <LibraryStat value={savedCards.length} label="卡片" />
              <LibraryStat value={notes.length} label="草稿" />
            </div>
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center gap-2 py-4">
            {canWrite ? <button type="button" onClick={openMaterials} className="flex h-10 w-10 items-center justify-center rounded-lg text-[#696158] hover:bg-[#E9E2D7] hover:text-[#1F64B5]" title="素材库"><Library size={17} /></button> : null}
            <button type="button" onClick={() => setLeftCollapsed(false)} className="mt-auto flex h-10 w-10 items-center justify-center rounded-lg text-[#696158] hover:bg-[#E9E2D7]" title="展开左栏"><ChevronRight size={17} /></button>
          </div>
        )}

        {!leftCollapsed ? (
          <div className="border-t border-[#E2DACF] px-4 py-3 text-[10px] leading-4 text-[#9A9083]">
            普通箭头只作视觉标注；只有“上下文连接”会授权 Agent 使用素材。
          </div>
        ) : null}
      </aside>

      {!leftCollapsed ? (
        <div
          role="separator"
          aria-label="调整左栏宽度"
          aria-orientation="vertical"
          onPointerDown={() => setDragTarget('left')}
          className="group relative z-[120] hidden w-1 shrink-0 cursor-col-resize xl:block"
        >
          <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent group-hover:bg-[#5F8FC7]" />
        </div>
      ) : null}

      <section className="relative min-w-0 flex-1 overflow-hidden bg-[#F3EFE7]">
        <div className="flex h-12 items-center justify-between border-b border-[#DDD5C9] bg-[#FAF7F1] px-3 xl:hidden">
          <button type="button" onClick={() => setMobileLibraryOpen(true)} className="flex h-8 items-center gap-2 rounded-md px-2 text-[12px] font-medium text-[#4C4640] hover:bg-[#ECE6DC]">
            <Library size={15} /> 工作区
          </button>
          <div className="font-serif text-[13px] font-semibold">{modeItems.find(item => item.value === writeWorkspaceMode)?.label}</div>
          <button type="button" onClick={onExit} className="flex h-8 items-center gap-1 rounded-md px-2 text-[11px] text-[#716960] hover:bg-[#ECE6DC]"><ArrowLeft size={14} />返回</button>
        </div>
        <div className="h-[calc(100%-3rem)] min-h-0 xl:h-full">{children}</div>

        {!rightCollapsed ? (
          <div
            role="separator"
            aria-label="调整右栏宽度"
            aria-orientation="vertical"
            onPointerDown={() => setDragTarget('right')}
            className="group absolute inset-y-0 z-[105] hidden w-2 -translate-x-1/2 cursor-col-resize xl:block"
            style={{ right: rightWidth }}
          >
            <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[#DDD5C9] group-hover:bg-[#4B83C4]" />
          </div>
        ) : null}

        <button
          type="button"
          onClick={() => setRightCollapsed(value => !value)}
          className="absolute top-3 z-[130] hidden h-8 w-8 items-center justify-center rounded-md border border-[#DCD4C8] bg-[#FEFCF8]/95 text-[#756D64] shadow-sm hover:border-[#91ACCC] hover:text-[#1F64B5] xl:flex"
          style={{ right: rightCollapsed ? 12 : rightWidth + 8 }}
          title={rightCollapsed ? '展开右栏' : '折叠右栏'}
        >
          {rightCollapsed ? <PanelRightOpen size={15} /> : <PanelRightClose size={15} />}
        </button>
      </section>

      {mobileLibraryOpen ? (
        <div className="fixed inset-0 z-[200] xl:hidden">
          <button type="button" aria-label="关闭工作区菜单" onClick={() => setMobileLibraryOpen(false)} className="absolute inset-0 bg-black/35" />
          <div className="absolute inset-y-0 left-0 flex w-[min(88vw,320px)] flex-col border-r border-[#D9D0C3] bg-[#FBF7EF] p-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <div className="font-serif text-[15px] font-semibold">魔法写作</div>
              <button type="button" onClick={() => setMobileLibraryOpen(false)} className="rounded-md p-2 text-[#786F65] hover:bg-[#ECE6DC]"><ChevronLeft size={17} /></button>
            </div>
            <div className="mt-5 space-y-1">
              {modeItems.map(item => (
                <button key={item.value} type="button" onClick={() => { setWriteWorkspaceMode(item.value); setMobileLibraryOpen(false); }} className={cn('flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-[12px]', item.value === writeWorkspaceMode ? 'bg-[#E4EDF9] text-[#1F5FA8]' : 'text-[#5E574F] hover:bg-[#EEE8DE]')}>
                  {item.icon}<span>{item.label}</span>
                </button>
              ))}
            </div>
            <button type="button" onClick={openMaterials} className="mt-5 flex items-center gap-2 rounded-lg border border-[#DCD3C6] bg-white px-3 py-3 text-[12px] text-[#275F9E]"><Plus size={15} />添加素材到画布</button>
          </div>
        </div>
      ) : null}
    </div>
  );
};

const LibraryStat: React.FC<{ value: number; label: string }> = ({ value, label }) => (
  <div className="rounded-md bg-[#ECE6DC] px-2 py-2 text-center">
    <div className="text-[11px] font-semibold text-[#514A43]">{value}</div>
    <div className="mt-0.5 text-[9px] text-[#978D81]">{label}</div>
  </div>
);
