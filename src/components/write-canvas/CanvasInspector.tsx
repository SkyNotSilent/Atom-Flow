import React, { useEffect, useMemo, useState } from 'react';
import {
  Bot,
  ChevronDown,
  FileText,
  Link2,
  MessageSquare,
  Plus,
  Save,
  Send,
  Settings2,
  Trash2,
  Unlink,
  X,
} from 'lucide-react';
import type { WriteCanvasEdge, WriteCanvasMessage, WriteCanvasNode } from '../../types';
import { CanvasDocumentEditor } from './CanvasDocumentEditor';

type InspectorTab = 'chat' | 'context' | 'settings';

export type AgentDraft = {
  title: string;
  model: string;
  systemPrompt: string;
  temperature: number;
  topP: number;
  maxTokens: number;
};

type CanvasInspectorProps = {
  node: WriteCanvasNode;
  nodes: WriteCanvasNode[];
  edges: WriteCanvasEdge[];
  messages: WriteCanvasMessage[];
  agentInput: string;
  isAgentRunning: boolean;
  onClose: () => void;
  onAgentInputChange: (value: string) => void;
  onSendAgentMessage: () => void;
  onRemoveEdge: (edge: WriteCanvasEdge) => void;
  onSaveAgent: (data: AgentDraft) => void;
  onSaveTemplate: (data: AgentDraft) => void;
  onSaveMessage: (message: WriteCanvasMessage) => void;
  onOpenAddContext: (agentNodeId: number) => void;
  onConnectToAgent: (sourceNodeId: number, agentNodeId: number) => void;
  onUpdateNode: (node: WriteCanvasNode, data: Record<string, unknown>) => void;
  onDocumentSaved: () => void;
  onOpenAgentGroup: (groupId: number) => void;
  onDeleteNode: (node: WriteCanvasNode) => void;
};

const nodeKindLabel: Record<WriteCanvasNode['kind'], string> = {
  asset_text: '粘贴文本',
  asset_file: '上传文件',
  asset_image: '图片资料',
  saved_article: '收藏文章',
  atom_card: '原子卡',
  note: '文章草稿',
  agent: 'Agent',
  result: '输出结果',
};

export const CanvasInspector: React.FC<CanvasInspectorProps> = ({
  node,
  nodes,
  edges,
  messages,
  agentInput,
  isAgentRunning,
  onClose,
  onAgentInputChange,
  onSendAgentMessage,
  onRemoveEdge,
  onSaveAgent,
  onSaveTemplate,
  onSaveMessage,
  onOpenAddContext,
  onConnectToAgent,
  onUpdateNode,
  onDocumentSaved,
  onOpenAgentGroup,
  onDeleteNode,
}) => {
  const [tab, setTab] = useState<InspectorTab>('chat');
  const [targetAgentNodeId, setTargetAgentNodeId] = useState<number | null>(null);
  const [draft, setDraft] = useState<AgentDraft>(() => toAgentDraft(node));
  const agentNodes = useMemo(() => nodes.filter(item => item.kind === 'agent'), [nodes]);

  useEffect(() => {
    setTab(node.kind === 'agent' ? 'chat' : 'context');
    setDraft(toAgentDraft(node));
  }, [node.id]);

  useEffect(() => {
    setDraft(toAgentDraft(node));
  }, [node.agent?.updatedAt]);

  useEffect(() => {
    setTargetAgentNodeId(current => current && agentNodes.some(agent => agent.id === current) ? current : agentNodes[0]?.id || null);
  }, [agentNodes]);

  const connectedEdges = node.kind === 'agent'
    ? edges.filter(edge => edge.targetNodeId === node.id)
    : edges.filter(edge => edge.sourceNodeId === node.id || edge.targetNodeId === node.id);

  return (
    <aside
      data-testid="canvas-inspector"
      onPointerDown={event => event.stopPropagation()}
      className="absolute inset-0 z-[80] flex w-full flex-col overflow-hidden border-0 bg-[#FCFCFA]/98 shadow-[0_24px_72px_rgba(29,32,38,0.18)] backdrop-blur md:inset-y-4 md:left-auto md:right-4 md:w-[380px] md:rounded-[8px] md:border md:border-[#D8D7D2]"
    >
      <header className="border-b border-[#E7E6E1] px-4 py-4">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[6px] bg-[#E8F1FF] text-[#1F61BD]">
            {node.kind === 'agent' ? <Bot size={18} /> : <FileText size={18} />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-medium uppercase text-[#83878E]">{node.role || nodeKindLabel[node.kind]} · {node.status || 'ready'}</div>
            <h2 className="mt-0.5 truncate text-[15px] font-semibold text-[#20242A]">{node.title}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭节点详情" className="flex h-8 w-8 items-center justify-center rounded-[6px] text-[#777B82] hover:bg-[#EEEDE9] hover:text-[#20242A]">
            <X size={16} />
          </button>
        </div>
        {node.summary ? <p className="mt-3 line-clamp-3 text-[11px] leading-5 text-[#71757C]">{node.summary}</p> : null}
      </header>

      {node.role === 'document' ? (
        <CanvasDocumentEditor node={node} onSaved={onDocumentSaved} />
      ) : node.kind === 'agent' && node.agent ? (
        <>
          <nav className="grid grid-cols-3 border-b border-[#E7E6E1] bg-[#F5F4F1] p-1" aria-label="Agent Inspector">
            <InspectorTabButton active={tab === 'chat'} icon={<MessageSquare size={13} />} onClick={() => setTab('chat')}>对话</InspectorTabButton>
            <InspectorTabButton active={tab === 'context'} icon={<Link2 size={13} />} onClick={() => setTab('context')}>上下文</InspectorTabButton>
            <InspectorTabButton active={tab === 'settings'} icon={<Settings2 size={13} />} onClick={() => setTab('settings')}>设置</InspectorTabButton>
          </nav>

          {tab === 'chat' ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
                {messages.length === 0 ? (
                  <div className="flex h-full min-h-40 flex-col items-center justify-center text-center">
                    <MessageSquare size={22} className="text-[#A7ABB1]" />
                    <p className="mt-3 text-[12px] font-medium text-[#555A61]">从已连接资料开始写作</p>
                    <p className="mt-1 max-w-56 text-[11px] leading-5 text-[#8B8F95]">Agent 只会读取“上下文”标签中已连接的节点。</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {messages.map(message => (
                      <div key={message.id} className={`rounded-[7px] px-3 py-2.5 text-[12px] leading-5 ${message.role === 'assistant' ? 'border border-[#E2E0DB] bg-white text-[#33373D]' : 'ml-8 bg-[#E7F0FF] text-[#245A9F]'}`}>
                        <div className="whitespace-pre-wrap">{message.content}</div>
                        {message.role === 'assistant' ? (
                          <button type="button" onClick={() => onSaveMessage(message)} className="mt-2 inline-flex items-center gap-1 rounded-[5px] border border-[#DAD8D2] bg-[#FAFAF8] px-2 py-1 text-[10px] font-medium text-[#555A61] hover:border-[#8FB5F2] hover:text-[#185ABD]">
                            <Plus size={11} /> 保存到画布
                          </button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="border-t border-[#E7E6E1] bg-white p-3">
                <textarea value={agentInput} onChange={event => onAgentInputChange(event.target.value)} className="h-24 w-full resize-none rounded-[7px] border border-[#DCDAD4] px-3 py-2 text-[12px] leading-5 text-[#30343A] outline-none focus:border-[#78A5EB] focus:ring-2 focus:ring-[#DCEAFF]" placeholder={connectedEdges.length ? '基于已连接上下文提问或生成…' : '先到“上下文”添加资料…'} />
                <button type="button" onClick={onSendAgentMessage} disabled={!agentInput.trim() || isAgentRunning} className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-[6px] bg-[#1F6FEB] px-3 py-2 text-[12px] font-medium text-white hover:bg-[#195FC9] disabled:opacity-50">
                  <Send size={14} /> {isAgentRunning ? '生成中…' : '发送'}
                </button>
                <p className="mt-2 text-center text-[10px] leading-4 text-[#858990]">
                  发送后，消息和已连接资料会交给实例配置的 AI 服务商处理。{' '}
                  <a href="/legal/privacy" target="_blank" rel="noreferrer" className="hover:text-[#1F6FEB]">隐私说明</a>
                </p>
              </div>
            </div>
          ) : null}

          {tab === 'context' ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-[12px] font-semibold text-[#30343A]">已连接上下文</h3>
                  <p className="mt-1 text-[10px] text-[#858990]">删除连接后，下一次生成不再引用该资料。</p>
                </div>
                <button type="button" onClick={() => onOpenAddContext(node.id)} className="inline-flex items-center gap-1.5 rounded-[6px] bg-[#20242A] px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-black">
                  <Plus size={12} /> 添加上下文
                </button>
              </div>
              <div className="mt-4 space-y-2">
                {connectedEdges.length === 0 ? <EmptyState text="暂无连接资料" /> : connectedEdges.map(edge => {
                  const source = nodes.find(item => item.id === edge.sourceNodeId);
                  return (
                    <div key={edge.id} className="flex items-center gap-2 rounded-[7px] border border-[#E2E0DB] bg-white px-3 py-2.5">
                      <FileText size={14} className="shrink-0 text-[#5E7FA9]" />
                      <div className="min-w-0 flex-1 truncate text-[11px] text-[#41464D]">{source?.title || `节点 ${edge.sourceNodeId}`}</div>
                      <button type="button" onClick={() => onRemoveEdge(edge)} className="flex h-7 w-7 items-center justify-center rounded-[5px] text-[#94989E] hover:bg-[#FCEBE9] hover:text-[#C44337]" title="断开上下文">
                        <Unlink size={13} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          {tab === 'settings' ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <div className="space-y-3">
                <Field label="Agent 名称"><input value={draft.title} onChange={event => setDraft(current => ({ ...current, title: event.target.value }))} className="canvas-field" /></Field>
                <Field label="模型"><input value={draft.model} onChange={event => setDraft(current => ({ ...current, model: event.target.value }))} className="canvas-field" /></Field>
                <div className="grid grid-cols-2 gap-3">
                  <NumberField label="Temperature" value={draft.temperature} min={0} max={2} step={0.05} onChange={temperature => setDraft(current => ({ ...current, temperature }))} />
                  <NumberField label="Top P" value={draft.topP} min={0.01} max={1} step={0.05} onChange={topP => setDraft(current => ({ ...current, topP }))} />
                </div>
                <NumberField label="Max tokens" value={draft.maxTokens} min={128} max={8000} step={128} onChange={maxTokens => setDraft(current => ({ ...current, maxTokens }))} />
                <Field label="系统提示词"><textarea value={draft.systemPrompt} onChange={event => setDraft(current => ({ ...current, systemPrompt: event.target.value }))} className="canvas-field h-36 resize-none leading-5" /></Field>
              </div>
              <div className="mt-4 flex gap-2">
                <button type="button" onClick={() => onSaveAgent(draft)} className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-[6px] bg-[#1F6FEB] px-3 py-2 text-[11px] font-medium text-white hover:bg-[#195FC9]"><Save size={13} />保存设置</button>
                <button type="button" onClick={() => onSaveTemplate(draft)} className="inline-flex items-center justify-center gap-1.5 rounded-[6px] border border-[#D8D6D0] bg-white px-3 py-2 text-[11px] font-medium text-[#4D5259] hover:border-[#8FB5F2]"><Bot size={13} />保存模板</button>
              </div>
              <DeleteNodeButton onClick={() => onDeleteNode(node)} />
            </div>
          ) : null}
        </>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {node.contentType === 'agent_group' && Number.isFinite(Number(node.businessRef)) ? (
              <button type="button" onClick={() => onOpenAgentGroup(Number(node.businessRef))} className="mb-4 inline-flex w-full items-center justify-center gap-2 rounded-[6px] bg-[#1F6FEB] px-3 py-2 text-[11px] font-medium text-white hover:bg-[#195FC9]">
                <Bot size={14} /> 配置或运行 Agent 组
              </button>
            ) : null}
            {node.asset?.dataUrl ? <img src={node.asset.dataUrl} alt={node.title} className="mb-3 max-h-56 w-full rounded-[7px] border border-[#E2E0DB] bg-white object-contain" /> : null}
            <div className="whitespace-pre-wrap rounded-[7px] border border-[#E2E0DB] bg-white p-3 text-[12px] leading-6 text-[#4F545B]">
              {node.asset?.extractedText || node.asset?.contentText || node.summary || '这个节点没有可预览文本。'}
            </div>

            <section className="mt-5">
              <h3 className="text-[12px] font-semibold text-[#30343A]">节点状态</h3>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <label className="text-[10px] font-medium text-[#6D7178]">角色
                  <select value={node.role || 'material'} onChange={event => onUpdateNode(node, { role: event.target.value })} className="canvas-field mt-1">
                    <option value="material">资料</option>
                    <option value="insight">洞察</option>
                    <option value="task">任务</option>
                    <option value="group">分组</option>
                  </select>
                </label>
                <label className="text-[10px] font-medium text-[#6D7178]">状态
                  <select value={node.status || 'ready'} onChange={event => onUpdateNode(node, { status: event.target.value })} className="canvas-field mt-1">
                    <option value="ready">就绪</option>
                    <option value="editing">编辑中</option>
                    <option value="pending_review">待审核</option>
                    <option value="adopted">已采纳</option>
                    <option value="rejected">已拒绝</option>
                    <option value="completed">已完成</option>
                  </select>
                </label>
              </div>
            </section>

            <section className="mt-5">
              <h3 className="text-[12px] font-semibold text-[#30343A]">连接到 Agent</h3>
              {agentNodes.length > 0 ? (
                <div className="mt-2 flex gap-2">
                  <label className="relative min-w-0 flex-1">
                    <select value={targetAgentNodeId || ''} onChange={event => setTargetAgentNodeId(Number(event.target.value))} className="h-9 w-full appearance-none rounded-[6px] border border-[#DCDAD4] bg-white pl-3 pr-8 text-[11px] text-[#41464D] outline-none focus:border-[#78A5EB]">
                      {agentNodes.map(agent => <option key={agent.id} value={agent.id}>{agent.title}</option>)}
                    </select>
                    <ChevronDown size={13} className="pointer-events-none absolute right-2.5 top-3 text-[#858990]" />
                  </label>
                  <button type="button" disabled={!targetAgentNodeId} onClick={() => targetAgentNodeId && onConnectToAgent(node.id, targetAgentNodeId)} className="inline-flex items-center gap-1.5 rounded-[6px] bg-[#1F6FEB] px-3 text-[11px] font-medium text-white disabled:opacity-40"><Link2 size={13} />连接</button>
                </div>
              ) : <EmptyState text="先在画布中添加一个 Agent" />}
              {connectedEdges.length > 0 ? (
                <div className="mt-3 space-y-1.5">
                  {connectedEdges.map(edge => {
                    const target = nodes.find(item => item.id === edge.targetNodeId);
                    return <div key={edge.id} className="flex items-center gap-2 rounded-[6px] border border-[#E2E0DB] bg-white px-3 py-2 text-[11px] text-[#555A61]"><Link2 size={12} className="text-[#4B78B4]" /><span className="min-w-0 flex-1 truncate">{target?.title || 'Agent'}</span><button type="button" onClick={() => onRemoveEdge(edge)} title="断开" className="text-[#94989E] hover:text-[#C44337]"><Unlink size={12} /></button></div>;
                  })}
                </div>
              ) : null}
            </section>
            <DeleteNodeButton onClick={() => onDeleteNode(node)} />
          </div>
        </div>
      )}
    </aside>
  );
};

const toAgentDraft = (node: WriteCanvasNode): AgentDraft => ({
  title: node.agent?.name || node.title,
  model: node.agent?.model || '',
  systemPrompt: node.agent?.systemPrompt || '',
  temperature: node.agent?.temperature ?? 0.55,
  topP: node.agent?.topP ?? 1,
  maxTokens: node.agent?.maxTokens ?? 1200,
});

const InspectorTabButton: React.FC<{ active: boolean; icon: React.ReactNode; onClick: () => void; children: React.ReactNode }> = ({ active, icon, onClick, children }) => (
  <button type="button" onClick={onClick} className={`flex items-center justify-center gap-1.5 rounded-[5px] px-2 py-2 text-[11px] ${active ? 'bg-white font-medium text-[#1D5DAF] shadow-sm' : 'text-[#73777E] hover:text-[#30343A]'}`}>{icon}{children}</button>
);

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => <label className="block text-[10px] font-medium text-[#6D7178]">{label}<div className="mt-1.5">{children}</div></label>;

const NumberField: React.FC<{ label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void }> = ({ label, value, min, max, step, onChange }) => (
  <Field label={label}><input type="number" value={value} min={min} max={max} step={step} onChange={event => onChange(Number(event.target.value))} className="canvas-field" /></Field>
);

const EmptyState: React.FC<{ text: string }> = ({ text }) => <div className="mt-3 rounded-[7px] border border-dashed border-[#DCDAD4] px-3 py-5 text-center text-[11px] text-[#92969C]">{text}</div>;

const DeleteNodeButton: React.FC<{ onClick: () => void }> = ({ onClick }) => (
  <button type="button" onClick={onClick} className="mt-6 inline-flex items-center gap-1.5 text-[11px] font-medium text-[#B34439] hover:text-[#D13A2E]"><Trash2 size={13} />删除节点</button>
);
