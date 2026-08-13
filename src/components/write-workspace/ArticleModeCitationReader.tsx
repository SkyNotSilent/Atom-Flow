import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppContext } from '../../context/AppContext';
import type { WriteCanvasEdge, WriteCanvasNode, WriteCanvasProject, WriteCanvasProjectDetail } from '../../types';
import {
  CANVAS_PROJECTS_CHANGED_EVENT,
  readCanvasProjectTarget,
  resolveCanvasProjectTarget,
  type CanvasProjectsChangedDetail,
} from '../../utils/canvasProjectTarget';
import {
  ReaderPane,
  type CitationAction,
  type CitationActionAvailability,
  type CitationCapture,
} from '../ReaderModal';
import { citationArticleIdentity, stableCitationCaptureId } from '../../utils/citationIdentity';

type ArticleCanvasContextStatus = 'loading' | 'ready' | 'missing' | 'error';

export type ArticleCanvasCitationTarget = {
  projectId: number | null;
  projectName?: string;
  agentNodeId: number | null;
  nodes: WriteCanvasNode[];
  status: ArticleCanvasContextStatus;
};

type ArticleCitationResponse = {
  node?: WriteCanvasNode;
  edge?: WriteCanvasEdge | null;
  created?: boolean;
};

type ArticleCitationRequest = {
  url: string;
  init: RequestInit;
};

type ArticleCitationSubmission = {
  ok: boolean;
  status: number;
  payload?: ArticleCitationResponse;
};

const emptyTarget = (status: ArticleCanvasContextStatus): ArticleCanvasCitationTarget => ({
  projectId: null,
  agentNodeId: null,
  nodes: [],
  status,
});

/** Keep this identity compatible with the canvas reader's durable citation key. */
export const articleCitationCaptureId = (capture: CitationCapture) => {
  return stableCitationCaptureId(capture);
};

export function resolveArticleCitationTarget(
  detail: WriteCanvasProjectDetail,
  preferredAgentNodeId?: number | null,
): ArticleCanvasCitationTarget {
  const preferredAgent = preferredAgentNodeId
    ? detail.nodes.find(node => node.id === preferredAgentNodeId && node.kind === 'agent')
    : null;
  const agent = preferredAgent || detail.nodes.find(node => node.kind === 'agent') || null;
  return {
    projectId: detail.project.id,
    projectName: detail.project.name,
    agentNodeId: agent?.id || null,
    nodes: detail.nodes,
    status: 'ready',
  };
}

export function getArticleCitationAvailability(
  isAuthenticated: boolean,
  target: ArticleCanvasCitationTarget,
): CitationActionAvailability {
  if (!isAuthenticated) {
    const reason = '登录后才能把摘录加入写作画布';
    return {
      'add-to-canvas': { disabled: true, reason },
      'add-and-connect': { disabled: true, reason },
    };
  }
  if (target.status === 'loading') {
    const reason = '正在读取当前画布，请稍候';
    return {
      'add-to-canvas': { disabled: true, reason },
      'add-and-connect': { disabled: true, reason },
    };
  }
  if (target.status === 'error') {
    const reason = '暂时无法读取当前画布，请稍后重试';
    return {
      'add-to-canvas': { disabled: true, reason },
      'add-and-connect': { disabled: true, reason },
    };
  }
  if (!target.projectId || target.status === 'missing') {
    const reason = '请先在“画布”模式创建一个写作项目';
    return {
      'add-to-canvas': { disabled: true, reason },
      'add-and-connect': { disabled: true, reason },
    };
  }
  return {
    'add-to-canvas': { disabled: false },
    'add-and-connect': target.agentNodeId
      ? { disabled: false }
      : { disabled: true, reason: '当前项目还没有 Agent，请先到画布创建或选择 Agent' },
  };
}

const getCitationPosition = (target: ArticleCanvasCitationTarget) => {
  const citationCount = target.nodes.filter(node => node.kind === 'citation').length;
  return {
    x: 180 + (citationCount % 3) * 360,
    y: 180 + Math.floor(citationCount / 3) * 220,
  };
};

export function buildArticleCitationRequest(
  capture: CitationCapture,
  action: CitationAction,
  target: ArticleCanvasCitationTarget,
  capturedAt: string,
): ArticleCitationRequest | null {
  if (!target.projectId) return null;
  if (action === 'add-and-connect' && !target.agentNodeId) return null;
  return {
    url: `/api/write/canvas/projects/${target.projectId}/citations`,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        captureId: articleCitationCaptureId(capture),
        articleIdentity: {
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
          capturedAt,
        },
        position: getCitationPosition(target),
        targetAgentNodeId: action === 'add-and-connect' ? target.agentNodeId : undefined,
      }),
    },
  };
}

export async function submitArticleCitation(
  capture: CitationCapture,
  action: CitationAction,
  target: ArticleCanvasCitationTarget,
  options: {
    capturedAt?: string;
    fetcher?: typeof fetch;
  } = {},
): Promise<ArticleCitationSubmission> {
  const request = buildArticleCitationRequest(
    capture,
    action,
    target,
    options.capturedAt || new Date().toISOString(),
  );
  if (!request) return { ok: false, status: 400 };
  const response = await (options.fetcher || fetch)(request.url, request.init);
  if (!response.ok) return { ok: false, status: response.status };
  return {
    ok: true,
    status: response.status,
    payload: await response.json() as ArticleCitationResponse,
  };
}

export const ArticleModeCitationReader: React.FC<{ active: boolean }> = ({ active }) => {
  const { user, showToast, billingState } = useAppContext();
  const canWrite = billingState.phase === 'ready' && billingState.status.access === 'full';
  const [target, setTarget] = useState<ArticleCanvasCitationTarget>(() => emptyTarget(user ? 'loading' : 'missing'));
  const targetRef = useRef(target);
  const currentProjectIdRef = useRef<number | null>(null);
  const preferredAgentByProjectRef = useRef(new Map<number, number>());
  const detailRequestRef = useRef<AbortController | null>(null);
  const projectListRequestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    targetRef.current = target;
  }, [target]);

  const loadProjectTarget = useCallback(async (projectId: number, preferredAgentNodeId?: number | null) => {
    detailRequestRef.current?.abort();
    const controller = new AbortController();
    detailRequestRef.current = controller;
    currentProjectIdRef.current = projectId;
    setTarget(previous => ({
      ...previous,
      projectId,
      status: 'loading',
    }));
    try {
      const response = await fetch(`/api/write/canvas/projects/${projectId}`, { signal: controller.signal });
      if (!response.ok) {
        if (response.status === 404) {
          currentProjectIdRef.current = null;
          setTarget(emptyTarget('missing'));
        } else {
          setTarget(previous => ({ ...previous, status: 'error' }));
        }
        return null;
      }
      const detail = await response.json() as WriteCanvasProjectDetail;
      if (controller.signal.aborted || currentProjectIdRef.current !== projectId) return null;
      const preferred = preferredAgentNodeId || preferredAgentByProjectRef.current.get(projectId);
      const nextTarget = resolveArticleCitationTarget(detail, preferred);
      if (nextTarget.agentNodeId) preferredAgentByProjectRef.current.set(projectId, nextTarget.agentNodeId);
      setTarget(nextTarget);
      return nextTarget;
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return null;
      setTarget(previous => ({ ...previous, status: 'error' }));
      return null;
    }
  }, []);

  useEffect(() => {
    detailRequestRef.current?.abort();
    projectListRequestRef.current?.abort();
    currentProjectIdRef.current = null;
    preferredAgentByProjectRef.current.clear();
    if (!user) {
      setTarget(emptyTarget('missing'));
      return;
    }
    setTarget(emptyTarget('loading'));
    const controller = new AbortController();
    projectListRequestRef.current = controller;
    void (async () => {
      try {
        const response = await fetch('/api/write/canvas/projects', { signal: controller.signal });
        if (!response.ok) {
          setTarget(emptyTarget('error'));
          return;
        }
        const payload = await response.json() as { projects?: WriteCanvasProject[] };
        if (controller.signal.aborted || currentProjectIdRef.current) return;
        const projects = Array.isArray(payload.projects) ? payload.projects : [];
        const projectId = resolveCanvasProjectTarget(projects, readCanvasProjectTarget(user.id));
        if (!projectId) {
          setTarget(emptyTarget('missing'));
          return;
        }
        await loadProjectTarget(projectId);
      } catch (error) {
        if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return;
        setTarget(emptyTarget('error'));
      }
    })();
    return () => {
      controller.abort();
      detailRequestRef.current?.abort();
    };
  }, [loadProjectTarget, user?.id]);

  useEffect(() => {
    const handleProjectsChanged = (event: Event) => {
      const detail = (event as CustomEvent<CanvasProjectsChangedDetail>).detail;
      if (!user || !detail || detail.ownerId !== user.id) return;
      const projectId = Number(detail.currentProjectId);
      if (!Number.isSafeInteger(projectId) || projectId <= 0) {
        currentProjectIdRef.current = null;
        setTarget(emptyTarget('missing'));
        return;
      }
      void loadProjectTarget(projectId);
    };
    const handleCanvasSelection = (event: Event) => {
      const nodeId = Number((event as CustomEvent<{ nodeId?: number }>).detail?.nodeId);
      const projectId = currentProjectIdRef.current;
      if (!Number.isSafeInteger(nodeId) || !projectId) return;
      const selected = targetRef.current.nodes.find(node => node.id === nodeId);
      if (selected?.kind === 'agent') {
        preferredAgentByProjectRef.current.set(projectId, nodeId);
        setTarget(previous => ({ ...previous, agentNodeId: nodeId }));
        return;
      }
      if (!selected) void loadProjectTarget(projectId, nodeId);
    };
    window.addEventListener(CANVAS_PROJECTS_CHANGED_EVENT, handleProjectsChanged);
    window.addEventListener('atomflow-canvas-select', handleCanvasSelection);
    return () => {
      window.removeEventListener(CANVAS_PROJECTS_CHANGED_EVENT, handleProjectsChanged);
      window.removeEventListener('atomflow-canvas-select', handleCanvasSelection);
    };
  }, [loadProjectTarget, user]);

  useEffect(() => {
    const projectId = currentProjectIdRef.current;
    if (active && user && projectId) void loadProjectTarget(projectId);
  }, [active, loadProjectTarget, user]);

  const availability = useMemo(
    () => canWrite
      ? getArticleCitationAvailability(Boolean(user), target)
      : {
          'add-to-canvas': { disabled: true, reason: '只读模式不能将摘录加入画布' },
          'add-and-connect': { disabled: true, reason: '只读模式不能连接新素材' },
        },
    [canWrite, target, user],
  );

  const handleCitationCapture = useCallback(async (capture: CitationCapture, action: CitationAction) => {
    if (!canWrite) return showToast('当前为只读模式');
    const currentTarget = targetRef.current;
    const actionAvailability = getArticleCitationAvailability(Boolean(user), currentTarget)[action];
    if (actionAvailability?.disabled) {
      showToast(actionAvailability.reason || '当前无法加入画布');
      return;
    }
    try {
      const result = await submitArticleCitation(capture, action, currentTarget);
      if (!result.ok) {
        if (result.status === 401) showToast('登录后才能把摘录加入写作画布');
        else if (result.status === 404 && action === 'add-and-connect') {
          showToast('当前 Agent 已不存在，请返回画布重新选择');
          if (currentTarget.projectId) void loadProjectTarget(currentTarget.projectId);
        } else showToast('摘录加入画布失败，请稍后重试');
        return;
      }
      const citationNode = result.payload?.node;
      if (citationNode) {
        setTarget(previous => ({
          ...previous,
          nodes: previous.nodes.some(node => node.id === citationNode.id)
            ? previous.nodes
            : [...previous.nodes, citationNode],
        }));
      }
      window.dispatchEvent(new CustomEvent('atomflow-canvas-external-content-changed', {
        detail: {
          projectId: currentTarget.projectId,
          nodeId: result.payload?.node?.id,
        },
      }));
      if (action === 'add-and-connect') {
        showToast(result.payload?.created === false ? '该摘录已连接当前 Agent' : '摘录已加入画布并连接当前 Agent');
      } else {
        showToast(result.payload?.created === false ? '该摘录已在画布中' : '摘录已加入画布');
      }
    } catch {
      showToast('摘录加入画布失败，请稍后重试');
    }
  }, [canWrite, loadProjectTarget, showToast, user]);

  return (
    <ReaderPane
      variant="compact"
      audio={false}
      onCitationCapture={handleCitationCapture}
      citationActionAvailability={availability}
    />
  );
};
