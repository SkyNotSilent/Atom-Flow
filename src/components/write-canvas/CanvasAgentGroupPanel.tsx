import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  Check,
  ChevronLeft,
  CircleAlert,
  LoaderCircle,
  Play,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import type {
  WriteAgentTemplate,
  WriteCanvasAgentBatch,
  WriteCanvasAgentGroup,
  WriteCanvasAgentGroupMember,
  WriteCanvasAgentRun,
  WriteCanvasEdge,
  WriteCanvasNode,
} from '../../types';

type CanvasAgentGroupPanelProps = {
  projectId: number;
  initialGroupId?: number | null;
  nodes: WriteCanvasNode[];
  edges?: WriteCanvasEdge[];
  templates: WriteAgentTemplate[];
  onClose: () => void;
  onGroupCreated: (group: WriteCanvasAgentGroup) => void | Promise<void>;
  onResults: (nodeIds: number[]) => void | Promise<void>;
  onToast: (message: string) => void;
};

type MemberDraft = {
  key: string;
  templateId: number | null;
  name: string;
  model: string;
  systemPrompt: string;
  temperature: number;
  topP: number;
  maxTokens: number;
};

type MemberRunState = {
  status: 'idle' | 'running' | 'completed' | 'failed';
  output?: string;
  error?: string;
};

type SseEvent = { type: string; data: Record<string, unknown> };

type AgentGroupBatchHistory = WriteCanvasAgentBatch & {
  runs: WriteCanvasAgentRun[];
};

type AgentGroupBatchHistoryPayload = {
  batches?: Array<WriteCanvasAgentBatch & { runs?: WriteCanvasAgentRun[] }>;
  runs?: WriteCanvasAgentRun[];
};

const fallbackMember = {
  model: '',
  systemPrompt: '',
  temperature: 0.7,
  topP: 1,
  maxTokens: 1200,
};

const nodeRoleLabels: Record<WriteCanvasNode['role'], string> = {
  material: '素材',
  insight: '知识',
  task: '任务',
  document: '作品',
  group: '分组',
};

const batchStatusLabels: Record<WriteCanvasAgentBatch['status'], string> = {
  queued: '等待中',
  running: '生成中',
  completed: '已完成',
  partial: '部分完成',
  failed: '失败',
  cancelled: '已取消',
};

const runStatusLabels: Record<WriteCanvasAgentRun['status'], string> = {
  queued: '等待中',
  running: '生成中',
  completed: '成功',
  failed: '失败',
  cancelled: '已取消',
};

export const getAgentGroupContextNodes = (nodes: WriteCanvasNode[]) => nodes.filter(node => (
  node.kind !== 'agent'
  && node.role !== 'task'
  && node.role !== 'group'
  && node.contentType !== 'agent_group'
  && node.status !== 'rejected'
));

export const getAgentGroupContextIds = (
  edges: WriteCanvasEdge[],
  group: WriteCanvasAgentGroup,
  contextNodes: WriteCanvasNode[],
) => {
  const allowedNodeIds = new Set(contextNodes.map(node => node.id));
  return Array.from(new Set(edges
    .filter(edge => edge.relation === 'context' && edge.targetNodeId === group.nodeId && allowedNodeIds.has(edge.sourceNodeId))
    .map(edge => edge.sourceNodeId)))
    .slice(0, 30);
};

export const normalizeAgentGroupBatchHistory = (
  payload: AgentGroupBatchHistoryPayload,
): AgentGroupBatchHistory[] => {
  const batches = Array.isArray(payload.batches) ? payload.batches : [];
  const siblingRuns = Array.isArray(payload.runs) ? payload.runs : [];
  return batches.map(batch => {
    const embeddedRuns = Array.isArray(batch.runs) ? batch.runs : [];
    return {
      ...batch,
      runs: embeddedRuns.length > 0
        ? embeddedRuns
        : siblingRuns.filter(run => run.batchId === batch.id),
    };
  });
};

const createMemberDraft = (template?: WriteAgentTemplate, index = 0): MemberDraft => ({
  key: `${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
  templateId: template?.id ?? null,
  name: template?.name || `Agent ${index + 1}`,
  model: template?.model || fallbackMember.model,
  systemPrompt: template?.systemPrompt || fallbackMember.systemPrompt,
  temperature: template?.temperature ?? fallbackMember.temperature,
  topP: template?.topP ?? fallbackMember.topP,
  maxTokens: template?.maxTokens ?? fallbackMember.maxTokens,
});

const getResponseError = async (response: Response, fallback: string) => {
  try {
    const payload = await response.json() as { error?: unknown };
    return typeof payload.error === 'string' && payload.error.trim() ? payload.error : fallback;
  } catch {
    return fallback;
  }
};

const parseSseStream = async (
  body: ReadableStream<Uint8Array>,
  onEvent: (event: SseEvent) => void | Promise<void>,
) => {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const consumeBlock = async (block: string) => {
    let type = 'message';
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) type = line.slice(6).trim();
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) return;
    try {
      const parsed = JSON.parse(dataLines.join('\n')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        await onEvent({ type, data: parsed as Record<string, unknown> });
      }
    } catch {
      throw new Error('Agent 组返回了无法解析的数据');
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n');
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (block.trim()) await consumeBlock(block);
      boundary = buffer.indexOf('\n\n');
    }
    if (done) break;
  }
  if (buffer.trim()) await consumeBlock(buffer);
};

export const CanvasAgentGroupPanel: React.FC<CanvasAgentGroupPanelProps> = ({
  projectId,
  initialGroupId = null,
  nodes,
  edges,
  templates,
  onClose,
  onGroupCreated,
  onResults,
  onToast,
}) => {
  const [groups, setGroups] = useState<WriteCanvasAgentGroup[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(initialGroupId);
  const [mode, setMode] = useState<'run' | 'create'>(initialGroupId ? 'run' : 'run');
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [name, setName] = useState('');
  const [sharedPrompt, setSharedPrompt] = useState('');
  const [members, setMembers] = useState<MemberDraft[]>(() => [createMemberDraft(templates[0], 0)]);
  const [isCreating, setIsCreating] = useState(false);
  const [message, setMessage] = useState('');
  const [selectedContextIds, setSelectedContextIds] = useState<number[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [runStates, setRunStates] = useState<Record<number, MemberRunState>>({});
  const [runError, setRunError] = useState('');
  const [batchHistory, setBatchHistory] = useState<AgentGroupBatchHistory[]>([]);
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const runAbortRef = useRef<AbortController | null>(null);

  const selectedGroup = useMemo(
    () => groups.find(group => group.id === selectedGroupId) || null,
    [groups, selectedGroupId],
  );
  const contextNodes = useMemo(
    () => getAgentGroupContextNodes(nodes),
    [nodes],
  );
  const canonicalContextIds = useMemo(
    () => selectedGroup && edges ? getAgentGroupContextIds(edges, selectedGroup, contextNodes) : [],
    [contextNodes, edges, selectedGroup],
  );

  const loadGroups = async (signal?: AbortSignal) => {
    setIsLoading(true);
    setLoadError('');
    try {
      const response = await fetch(`/api/write/canvas/projects/${projectId}/agent-groups`, { signal });
      if (!response.ok) throw new Error(await getResponseError(response, 'Agent 组加载失败'));
      const payload = await response.json() as { groups?: WriteCanvasAgentGroup[] };
      const nextGroups = Array.isArray(payload.groups) ? payload.groups : [];
      setGroups(nextGroups);
      setSelectedGroupId(current => {
        if (current && nextGroups.some(group => group.id === current)) return current;
        if (initialGroupId && nextGroups.some(group => group.id === initialGroupId)) return initialGroupId;
        return nextGroups[0]?.id ?? null;
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setLoadError(error instanceof Error ? error.message : 'Agent 组加载失败');
    } finally {
      if (!signal?.aborted) setIsLoading(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    void loadGroups(controller.signal);
    return () => controller.abort();
  }, [projectId]);

  useEffect(() => () => runAbortRef.current?.abort(), []);

  const applyPersistedRuns = useCallback((group: WriteCanvasAgentGroup, history: AgentGroupBatchHistory[]) => {
    const latestRuns = history[0]?.runs || [];
    setRunStates(Object.fromEntries(group.members.map(member => {
      const run = latestRuns.find(item => item.groupMemberId === member.id);
      if (!run) return [member.id, { status: 'idle' } satisfies MemberRunState];
      if (run.status === 'completed') {
        return [member.id, { status: 'completed', output: run.output || '' } satisfies MemberRunState];
      }
      if (run.status === 'running') return [member.id, { status: 'running' } satisfies MemberRunState];
      if (run.status === 'failed' || run.status === 'cancelled') {
        return [member.id, {
          status: 'failed',
          error: run.error || (run.status === 'cancelled' ? '运行已取消' : '生成失败'),
        } satisfies MemberRunState];
      }
      return [member.id, { status: 'idle' } satisfies MemberRunState];
    })));
  }, []);

  const loadBatchHistory = useCallback(async (group: WriteCanvasAgentGroup, signal?: AbortSignal) => {
    setIsHistoryLoading(true);
    setHistoryError('');
    try {
      const response = await fetch(`/api/write/canvas/agent-groups/${group.id}/batches`, { signal });
      if (!response.ok) throw new Error(await getResponseError(response, '运行历史加载失败'));
      const payload = await response.json() as AgentGroupBatchHistoryPayload;
      const history = normalizeAgentGroupBatchHistory(payload);
      setBatchHistory(history);
      applyPersistedRuns(group, history);
      if (edges === undefined) {
        const allowedNodeIds = new Set(contextNodes.map(node => node.id));
        setSelectedContextIds((history[0]?.contextNodeIds || []).filter(id => allowedNodeIds.has(id)).slice(0, 30));
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setHistoryError(error instanceof Error ? error.message : '运行历史加载失败');
    } finally {
      if (!signal?.aborted) setIsHistoryLoading(false);
    }
  }, [applyPersistedRuns, contextNodes, edges]);

  useEffect(() => {
    if (!selectedGroup) {
      setRunStates({});
      setBatchHistory([]);
      setSelectedContextIds([]);
      return;
    }
    setRunStates(Object.fromEntries(selectedGroup.members.map(member => [member.id, { status: 'idle' }])));
    setRunError('');
    const controller = new AbortController();
    void loadBatchHistory(selectedGroup, controller.signal);
    return () => controller.abort();
  }, [loadBatchHistory, selectedGroup]);

  useEffect(() => {
    if (edges !== undefined) setSelectedContextIds(canonicalContextIds);
  }, [canonicalContextIds, edges]);

  const updateMember = (key: string, patch: Partial<MemberDraft>) => {
    setMembers(current => current.map(member => member.key === key ? { ...member, ...patch } : member));
  };

  const seedMemberFromTemplate = (key: string, templateId: number | null) => {
    const template = templates.find(item => item.id === templateId);
    if (!template) {
      updateMember(key, { templateId: null });
      return;
    }
    updateMember(key, {
      templateId: template.id,
      name: template.name,
      model: template.model,
      systemPrompt: template.systemPrompt,
      temperature: template.temperature,
      topP: template.topP,
      maxTokens: template.maxTokens,
    });
  };

  const createGroup = async () => {
    if (isCreating) return;
    if (!name.trim()) {
      onToast('请输入 Agent 组名称');
      return;
    }
    if (members.some(member => !member.name.trim() || !member.model.trim())) {
      onToast('每个成员都需要名称和模型');
      return;
    }
    setIsCreating(true);
    try {
      const response = await fetch(`/api/write/canvas/projects/${projectId}/agent-groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          sharedPrompt: sharedPrompt.trim(),
          members: members.map(({ name: memberName, model, systemPrompt, temperature, topP, maxTokens }) => ({
            name: memberName.trim(),
            model: model.trim(),
            systemPrompt,
            temperature,
            topP,
            maxTokens,
          })),
        }),
      });
      if (!response.ok) throw new Error(await getResponseError(response, 'Agent 组创建失败'));
      const payload = await response.json() as { group?: WriteCanvasAgentGroup };
      if (!payload.group || !Number.isSafeInteger(payload.group.nodeId) || payload.group.nodeId <= 0) {
        throw new Error('Agent 组创建结果缺少画布节点');
      }
      setGroups(current => [payload.group!, ...current.filter(group => group.id !== payload.group!.id)]);
      setSelectedGroupId(payload.group.id);
      setMode('run');
      setName('');
      setSharedPrompt('');
      setMembers([createMemberDraft(templates[0], 0)]);
      onToast('Agent 组已创建');
      try {
        await onGroupCreated(payload.group);
      } catch {
        onToast('Agent 组已创建，但画布刷新失败，请重新打开项目');
      }
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Agent 组创建失败');
    } finally {
      setIsCreating(false);
    }
  };

  const toggleContext = (nodeId: number) => {
    setSelectedContextIds(current => {
      if (current.includes(nodeId)) return current.filter(id => id !== nodeId);
      if (current.length >= 30) {
        onToast('单次最多选择 30 个上下文节点');
        return current;
      }
      return [...current, nodeId];
    });
  };

  const runGroup = async () => {
    if (!selectedGroup || isRunning) return;
    if (!message.trim()) {
      onToast('请输入本次批量任务');
      return;
    }
    const controller = new AbortController();
    runAbortRef.current = controller;
    setIsRunning(true);
    setRunError('');
    setRunStates(Object.fromEntries(selectedGroup.members.map(member => [member.id, { status: 'idle' }])));
    const outputNodeIds = new Set<number>();
    let receivedFinal = false;

    try {
      const response = await fetch(`/api/write/canvas/agent-groups/${selectedGroup.id}/batches/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: message.trim(), contextNodeIds: selectedContextIds }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(await getResponseError(response, 'Agent 组运行失败'));
      if (!response.body) throw new Error('浏览器无法读取流式响应');

      await parseSseStream(response.body, async ({ type, data }) => {
        const memberId = Number(data.memberId);
        if (type === 'member_start' && Number.isSafeInteger(memberId)) {
          setRunStates(current => ({ ...current, [memberId]: { status: 'running' } }));
        }
        if (type === 'member_final' && Number.isSafeInteger(memberId)) {
          const ids = Array.isArray(data.outputNodeIds) ? data.outputNodeIds.map(Number).filter(Number.isSafeInteger) : [];
          ids.forEach(id => outputNodeIds.add(id));
          setRunStates(current => ({
            ...current,
            [memberId]: { status: 'completed', output: typeof data.output === 'string' ? data.output : '' },
          }));
        }
        if (type === 'member_error' && Number.isSafeInteger(memberId)) {
          setRunStates(current => ({
            ...current,
            [memberId]: { status: 'failed', error: typeof data.message === 'string' ? data.message : '生成失败' },
          }));
        }
        if (type === 'final') {
          receivedFinal = true;
          const failures = Array.isArray(data.failures) ? data.failures.length : 0;
          const finalStatus = typeof data.status === 'string' ? data.status : failures > 0 ? 'partial' : 'completed';
          await loadBatchHistory(selectedGroup);
          if (outputNodeIds.size > 0) await onResults([...outputNodeIds]);
          if (finalStatus === 'failed') onToast('批量生成失败');
          else if (finalStatus === 'cancelled') onToast('批量生成已取消');
          else onToast(failures > 0 || finalStatus === 'partial' ? `批量生成部分完成，${failures} 个成员失败` : '批量生成完成');
        }
      });
      if (!receivedFinal) throw new Error('Agent 组运行连接提前结束');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        setRunError('本次运行已取消');
      } else {
        const nextError = error instanceof Error ? error.message : 'Agent 组运行失败';
        setRunError(nextError);
        onToast(nextError);
      }
    } finally {
      if (runAbortRef.current === controller) runAbortRef.current = null;
      setIsRunning(false);
    }
  };

  const close = () => {
    runAbortRef.current?.abort();
    onClose();
  };

  return (
    <aside
      data-testid="canvas-agent-group-panel"
      aria-label="Agent 组"
      onPointerDown={event => event.stopPropagation()}
      className="absolute inset-0 z-[90] flex w-full flex-col overflow-hidden border-0 bg-[#FCFCFA]/98 shadow-[0_24px_72px_rgba(29,32,38,0.18)] backdrop-blur md:inset-y-4 md:left-auto md:right-4 md:w-[420px] md:rounded-[8px] md:border md:border-[#D8D7D2]"
    >
      <header className="flex items-start gap-3 border-b border-[#E7E6E1] px-4 py-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[6px] bg-[#20242A] text-white">
          <Users size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[14px] font-semibold text-[#20242A]">Agent 组</h2>
          <p className="mt-0.5 text-[11px] text-[#777B82]">同一任务交给最多三个 Agent 并行生成</p>
        </div>
        <button type="button" onClick={close} aria-label="关闭 Agent 组" className="flex h-8 w-8 items-center justify-center rounded-[6px] text-[#777B82] hover:bg-[#EEEDE9] hover:text-[#20242A]">
          <X size={16} />
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        {mode === 'create' ? (
          <CreateGroupView
            name={name}
            sharedPrompt={sharedPrompt}
            members={members}
            templates={templates}
            isCreating={isCreating}
            onNameChange={setName}
            onSharedPromptChange={setSharedPrompt}
            onMemberChange={updateMember}
            onTemplateChange={seedMemberFromTemplate}
            onAddMember={() => setMembers(current => [...current, createMemberDraft(templates[0], current.length)])}
            onRemoveMember={key => setMembers(current => current.filter(member => member.key !== key))}
            onBack={() => setMode('run')}
            onCreate={() => void createGroup()}
          />
        ) : (
          <RunGroupView
            groups={groups}
            selectedGroup={selectedGroup}
            contextNodes={contextNodes}
            selectedContextIds={selectedContextIds}
            message={message}
            isLoading={isLoading}
            loadError={loadError}
            isRunning={isRunning}
            runStates={runStates}
            runError={runError}
            batchHistory={batchHistory}
            isHistoryLoading={isHistoryLoading}
            historyError={historyError}
            onSelectGroup={setSelectedGroupId}
            onToggleContext={toggleContext}
            onMessageChange={setMessage}
            onCreate={() => setMode('create')}
            onRetry={() => void loadGroups()}
            onRetryHistory={() => selectedGroup && void loadBatchHistory(selectedGroup)}
            onRun={() => void runGroup()}
            onCancel={() => runAbortRef.current?.abort()}
          />
        )}
      </div>
    </aside>
  );
};

type CreateGroupViewProps = {
  name: string;
  sharedPrompt: string;
  members: MemberDraft[];
  templates: WriteAgentTemplate[];
  isCreating: boolean;
  onNameChange: (value: string) => void;
  onSharedPromptChange: (value: string) => void;
  onMemberChange: (key: string, patch: Partial<MemberDraft>) => void;
  onTemplateChange: (key: string, templateId: number | null) => void;
  onAddMember: () => void;
  onRemoveMember: (key: string) => void;
  onBack: () => void;
  onCreate: () => void;
};

const CreateGroupView: React.FC<CreateGroupViewProps> = ({
  name,
  sharedPrompt,
  members,
  templates,
  isCreating,
  onNameChange,
  onSharedPromptChange,
  onMemberChange,
  onTemplateChange,
  onAddMember,
  onRemoveMember,
  onBack,
  onCreate,
}) => (
  <>
    <div className="flex items-center justify-between border-b border-[#E7E6E1] px-4 py-3">
      <button type="button" onClick={onBack} className="inline-flex items-center gap-1 text-[11px] font-medium text-[#5F646B] hover:text-[#20242A]">
        <ChevronLeft size={14} /> 返回运行
      </button>
      <span className="text-[10px] text-[#8A8E95]">{members.length}/3 成员</span>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
      <div className="space-y-3 border-b border-[#E7E6E1] pb-4">
        <label className="block text-[10px] font-medium text-[#656A71]">组名称
          <input value={name} maxLength={120} onChange={event => onNameChange(event.target.value)} className="canvas-field mt-1.5" placeholder="例如：标题方案对比" />
        </label>
        <label className="block text-[10px] font-medium text-[#656A71]">共享 Prompt
          <textarea value={sharedPrompt} maxLength={8000} onChange={event => onSharedPromptChange(event.target.value)} className="canvas-field mt-1.5 h-24 resize-none leading-5" placeholder="所有成员共同遵循的目标、限制或输出格式" />
        </label>
      </div>

      <div className="flex items-center justify-between py-4">
        <div>
          <h3 className="text-[12px] font-semibold text-[#30343A]">成员配置</h3>
          <p className="mt-0.5 text-[10px] text-[#8A8E95]">可从模板带入，再单独调整参数</p>
        </div>
        <button type="button" onClick={onAddMember} disabled={members.length >= 3} className="inline-flex h-8 items-center gap-1 rounded-[6px] border border-[#D8D7D2] bg-white px-2.5 text-[11px] font-medium text-[#34383E] hover:bg-[#F2F1ED] disabled:opacity-40">
          <Plus size={13} /> 添加成员
        </button>
      </div>

      <div className="divide-y divide-[#E7E6E1] border-y border-[#E7E6E1]">
        {members.map((member, index) => (
          <section key={member.key} className="space-y-3 py-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-[11px] font-semibold text-[#3B4047]"><Bot size={14} className="text-[#2465BE]" />成员 {index + 1}</div>
              <button type="button" aria-label={`删除成员 ${index + 1}`} disabled={members.length === 1} onClick={() => onRemoveMember(member.key)} className="flex h-7 w-7 items-center justify-center rounded-[5px] text-[#92969D] hover:bg-[#FCECEA] hover:text-[#B34439] disabled:opacity-30">
                <Trash2 size={13} />
              </button>
            </div>
            <label className="block text-[10px] text-[#6D7178]">模板
              <select value={member.templateId ?? ''} onChange={event => onTemplateChange(member.key, event.target.value ? Number(event.target.value) : null)} className="canvas-field mt-1.5">
                <option value="">不使用模板</option>
                {templates.map(template => <option key={template.id} value={template.id}>{template.name} · {template.model}</option>)}
              </select>
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="block text-[10px] text-[#6D7178]">名称
                <input value={member.name} maxLength={120} onChange={event => onMemberChange(member.key, { name: event.target.value })} className="canvas-field mt-1.5" />
              </label>
              <label className="block text-[10px] text-[#6D7178]">模型
                <input value={member.model} onChange={event => onMemberChange(member.key, { model: event.target.value })} className="canvas-field mt-1.5" placeholder="mimo-v2.5-pro" />
              </label>
            </div>
            <label className="block text-[10px] text-[#6D7178]">系统提示词
              <textarea value={member.systemPrompt} maxLength={8000} onChange={event => onMemberChange(member.key, { systemPrompt: event.target.value })} className="canvas-field mt-1.5 h-20 resize-none leading-5" />
            </label>
            <div className="grid grid-cols-3 gap-2">
              <NumberField label="温度" value={member.temperature} min={0} max={2} step={0.05} onChange={value => onMemberChange(member.key, { temperature: value })} />
              <NumberField label="Top P" value={member.topP} min={0.01} max={1} step={0.05} onChange={value => onMemberChange(member.key, { topP: value })} />
              <NumberField label="Tokens" value={member.maxTokens} min={128} max={32000} step={128} onChange={value => onMemberChange(member.key, { maxTokens: Math.round(value) })} />
            </div>
          </section>
        ))}
      </div>
    </div>
    <footer className="border-t border-[#E7E6E1] p-4">
      <button type="button" onClick={onCreate} disabled={isCreating} className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-[6px] bg-[#20242A] text-[12px] font-semibold text-white hover:bg-black disabled:opacity-50">
        {isCreating ? <LoaderCircle size={15} className="animate-spin" /> : <Users size={15} />}
        {isCreating ? '正在创建' : '创建 Agent 组'}
      </button>
    </footer>
  </>
);

type RunGroupViewProps = {
  groups: WriteCanvasAgentGroup[];
  selectedGroup: WriteCanvasAgentGroup | null;
  contextNodes: WriteCanvasNode[];
  selectedContextIds: number[];
  message: string;
  isLoading: boolean;
  loadError: string;
  isRunning: boolean;
  runStates: Record<number, MemberRunState>;
  runError: string;
  batchHistory: AgentGroupBatchHistory[];
  isHistoryLoading: boolean;
  historyError: string;
  onSelectGroup: (id: number) => void;
  onToggleContext: (id: number) => void;
  onMessageChange: (value: string) => void;
  onCreate: () => void;
  onRetry: () => void;
  onRetryHistory: () => void;
  onRun: () => void;
  onCancel: () => void;
};

const RunGroupView: React.FC<RunGroupViewProps> = ({
  groups,
  selectedGroup,
  contextNodes,
  selectedContextIds,
  message,
  isLoading,
  loadError,
  isRunning,
  runStates,
  runError,
  batchHistory,
  isHistoryLoading,
  historyError,
  onSelectGroup,
  onToggleContext,
  onMessageChange,
  onCreate,
  onRetry,
  onRetryHistory,
  onRun,
  onCancel,
}) => {
  if (isLoading) return <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-[12px] text-[#72767D]"><LoaderCircle size={15} className="animate-spin" />加载 Agent 组</div>;
  if (loadError) return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
      <CircleAlert size={22} className="text-[#B34439]" />
      <p className="text-[12px] leading-5 text-[#6F747B]">{loadError}</p>
      <button type="button" onClick={onRetry} className="inline-flex items-center gap-1.5 rounded-[6px] border border-[#D8D7D2] bg-white px-3 py-2 text-[11px] font-medium"><RefreshCw size={13} />重试</button>
    </div>
  );

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="flex items-end gap-2 border-b border-[#E7E6E1] pb-4">
          <label className="min-w-0 flex-1 text-[10px] font-medium text-[#656A71]">当前 Agent 组
            <select value={selectedGroup?.id ?? ''} onChange={event => onSelectGroup(Number(event.target.value))} className="canvas-field mt-1.5" disabled={isRunning || groups.length === 0}>
              {groups.length === 0 && <option value="">暂无 Agent 组</option>}
              {groups.map(group => <option key={group.id} value={group.id}>{group.name} · {group.members.length} 人</option>)}
            </select>
          </label>
          <button type="button" onClick={onCreate} disabled={isRunning} className="inline-flex h-9 shrink-0 items-center gap-1 rounded-[6px] border border-[#D8D7D2] bg-white px-2.5 text-[11px] font-medium text-[#34383E] hover:bg-[#F2F1ED] disabled:opacity-40">
            <Plus size={13} /> 新建
          </button>
        </div>

        {!selectedGroup ? (
          <div className="py-16 text-center">
            <Users size={24} className="mx-auto text-[#A2A5AA]" />
            <p className="mt-3 text-[12px] font-medium text-[#4F545B]">还没有 Agent 组</p>
            <p className="mt-1 text-[10px] text-[#8A8E95]">创建后可用同一任务批量生成多个候选结果</p>
          </div>
        ) : (
          <>
            {selectedGroup.sharedPrompt && <p className="border-b border-[#E7E6E1] py-3 text-[10px] leading-4 text-[#74787F]">共享要求：{selectedGroup.sharedPrompt}</p>}

            <section className="border-b border-[#E7E6E1] py-4">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-[11px] font-semibold text-[#3B4047]">上下文节点</h3>
                <span className="text-[10px] text-[#8A8E95]">已选 {selectedContextIds.length}</span>
              </div>
              {contextNodes.length === 0 ? (
                <p className="py-3 text-[10px] text-[#92969D]">画布上暂无可用节点，本次将只使用 Prompt。</p>
              ) : (
                <div className="max-h-36 overflow-y-auto border-y border-[#ECEAE5]">
                  {contextNodes.map(node => (
                    <label key={node.id} className="flex cursor-pointer items-center gap-2 border-b border-[#ECEAE5] px-1 py-2.5 last:border-b-0 hover:bg-[#F5F4F1]">
                      <input type="checkbox" checked={selectedContextIds.includes(node.id)} onChange={() => onToggleContext(node.id)} disabled={isRunning} className="h-3.5 w-3.5 accent-[#1F6FEB]" />
                      <span className="min-w-0 flex-1 truncate text-[11px] text-[#3B4047]">{node.title}</span>
                      <span className="shrink-0 text-[9px] text-[#92969D]">{nodeRoleLabels[node.role]}</span>
                    </label>
                  ))}
                </div>
              )}
            </section>

            <section className="border-b border-[#E7E6E1] py-4">
              <label className="block text-[10px] font-medium text-[#656A71]">本次任务
                <textarea value={message} maxLength={12000} onChange={event => onMessageChange(event.target.value)} disabled={isRunning} className="canvas-field mt-1.5 h-24 resize-none leading-5" placeholder="例如：基于所选资料，分别生成三个公众号文章大纲" />
              </label>
            </section>

            <section className="py-4">
              <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold text-[#3B4047]"><Sparkles size={13} className="text-[#2465BE]" />生成状态</div>
              <div className="divide-y divide-[#E7E6E1] border-y border-[#E7E6E1]">
                {selectedGroup.members.map(member => <MemberRunRow key={member.id} member={member} state={runStates[member.id] || { status: 'idle' }} />)}
              </div>
              {runError && <p role="alert" className="mt-3 flex items-start gap-1.5 text-[10px] leading-4 text-[#B34439]"><CircleAlert size={12} className="mt-0.5 shrink-0" />{runError}</p>}
            </section>

            <section className="border-t border-[#E7E6E1] py-4">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-[11px] font-semibold text-[#3B4047]">最近运行</h3>
                {historyError && (
                  <button type="button" onClick={onRetryHistory} className="inline-flex items-center gap-1 text-[10px] text-[#5F646B] hover:text-[#20242A]">
                    <RefreshCw size={11} /> 重试
                  </button>
                )}
              </div>
              {isHistoryLoading ? (
                <p className="flex items-center gap-1.5 py-3 text-[10px] text-[#8A8E95]"><LoaderCircle size={12} className="animate-spin" />加载历史</p>
              ) : historyError ? (
                <p role="alert" className="py-2 text-[10px] leading-4 text-[#B34439]">{historyError}</p>
              ) : batchHistory.length === 0 ? (
                <p className="py-3 text-[10px] text-[#92969D]">暂无运行记录</p>
              ) : (
                <div className="divide-y divide-[#E7E6E1] border-y border-[#E7E6E1]">
                  {batchHistory.slice(0, 5).map(batch => (
                    <BatchHistoryRow key={batch.id} batch={batch} members={selectedGroup.members} />
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>

      {selectedGroup && (
        <footer className="border-t border-[#E7E6E1] p-4">
          {isRunning ? (
            <button type="button" onClick={onCancel} className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-[6px] border border-[#D8D7D2] bg-white text-[12px] font-semibold text-[#4F545B] hover:bg-[#F2F1ED]">
              <X size={15} /> 取消本次运行
            </button>
          ) : (
            <button type="button" onClick={onRun} disabled={!message.trim()} className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-[6px] bg-[#1F6FEB] text-[12px] font-semibold text-white hover:bg-[#185ABD] disabled:opacity-40">
              <Play size={15} /> 批量生成 {selectedGroup.members.length} 个结果
            </button>
          )}
        </footer>
      )}
    </>
  );
};

const BatchHistoryRow: React.FC<{
  batch: AgentGroupBatchHistory;
  members: WriteCanvasAgentGroupMember[];
}> = ({ batch, members }) => (
  <article className="py-3">
    <div className="flex items-center gap-2">
      <span className={`rounded-[4px] px-1.5 py-0.5 text-[9px] font-medium ${batch.status === 'completed' ? 'bg-[#E7F5EC] text-[#267A47]' : batch.status === 'partial' ? 'bg-[#FFF3D9] text-[#946200]' : batch.status === 'running' || batch.status === 'queued' ? 'bg-[#E7F0FF] text-[#1F6FEB]' : 'bg-[#FCECEA] text-[#B34439]'}`}>
        {batchStatusLabels[batch.status]}
      </span>
      <time className="ml-auto text-[9px] text-[#92969D]" dateTime={batch.createdAt}>
        {new Date(batch.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
      </time>
    </div>
    <p className="mt-2 line-clamp-2 text-[10px] leading-4 text-[#555A61]">{batch.message || '未记录任务内容'}</p>
    {batch.runs.length > 0 && (
      <div className="mt-2 flex flex-wrap gap-1.5">
        {batch.runs.map(run => {
          const memberName = members.find(member => member.id === run.groupMemberId)?.name || `Agent ${run.groupMemberId || ''}`.trim();
          return (
            <span key={run.id} title={run.error || run.output || ''} className={`rounded-[4px] border px-1.5 py-1 text-[9px] ${run.status === 'completed' ? 'border-[#C9E6D3] text-[#267A47]' : run.status === 'running' || run.status === 'queued' ? 'border-[#C9D9F2] text-[#1F6FEB]' : 'border-[#EACBC7] text-[#B34439]'}`}>
              {memberName} · {runStatusLabels[run.status]}
            </span>
          );
        })}
      </div>
    )}
    {batch.error && <p className="mt-2 line-clamp-2 text-[9px] leading-4 text-[#B34439]">{batch.error}</p>}
  </article>
);

const NumberField: React.FC<{ label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void }> = ({ label, value, min, max, step, onChange }) => (
  <label className="block text-[10px] text-[#6D7178]">{label}
    <input type="number" value={value} min={min} max={max} step={step} onChange={event => {
      const next = Number(event.target.value);
      if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, next)));
    }} className="canvas-field mt-1.5" />
  </label>
);

const MemberRunRow: React.FC<{ member: WriteCanvasAgentGroupMember; state: MemberRunState }> = ({ member, state }) => (
  <div className="py-3">
    <div className="flex items-center gap-2">
      <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${state.status === 'completed' ? 'bg-[#E7F5EC] text-[#267A47]' : state.status === 'failed' ? 'bg-[#FCECEA] text-[#B34439]' : state.status === 'running' ? 'bg-[#E7F0FF] text-[#1F6FEB]' : 'bg-[#EEEDE9] text-[#7A7E85]'}`}>
        {state.status === 'completed' ? <Check size={12} /> : state.status === 'failed' ? <CircleAlert size={12} /> : state.status === 'running' ? <LoaderCircle size={12} className="animate-spin" /> : <Bot size={12} />}
      </span>
      <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-[#34383E]">{member.name}</span>
      <span className="shrink-0 text-[9px] text-[#92969D]">{member.model}</span>
    </div>
    {state.output && <p className="ml-8 mt-2 line-clamp-3 whitespace-pre-wrap text-[10px] leading-4 text-[#686D74]">{state.output}</p>}
    {state.error && <p className="ml-8 mt-2 text-[10px] leading-4 text-[#B34439]">{state.error}</p>}
  </div>
);
