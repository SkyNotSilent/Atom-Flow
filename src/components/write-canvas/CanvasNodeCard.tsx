import React from 'react';
import { Bot, FileText, Image as ImageIcon, Sparkles } from 'lucide-react';
import { CanvasNodeAddMenu } from './CanvasNodeAddMenu';

type CanvasNodeCardNode = {
  id: number;
  kind?: string | null;
  role?: string | null;
  status?: string | null;
  contentType?: string | null;
  title?: string | null;
  summary?: string | null;
};

type CanvasNodeCardProps = {
  node: CanvasNodeCardNode;
  onSelect: (nodeId: number) => void;
};

const kindLabels: Record<string, string> = {
  asset_text: '粘贴文本',
  asset_file: '上传文件',
  asset_image: '图片资料',
  saved_article: '收藏文章',
  atom_card: '原子卡',
  note: '文章草稿',
  agent: 'Agent',
  result: '输出结果',
};

const roleLabels: Record<string, string> = {
  material: '资料',
  insight: '洞察',
  task: '任务',
  document: '作品',
  group: '分组',
};

const statusLabels: Record<string, string> = {
  parsing: '解析中',
  ready: '就绪',
  running: '执行中',
  pending_review: '待审核',
  adopted: '已采纳',
  rejected: '已拒绝',
  editing: '编辑中',
  completed: '已完成',
  failed: '失败',
};

export const getCanvasNodeKindLabel = (kind?: string | null) => kindLabels[kind || ''] || '内容节点';
export const getCanvasNodeRoleLabel = (role?: string | null, kind?: string | null) => roleLabels[role || ''] || getCanvasNodeKindLabel(kind);
export const getCanvasNodeStatusLabel = (status?: string | null) => statusLabels[status || ''] || '待处理';

export const getCanvasNodeTone = (kind?: string | null) => {
  if (kind === 'agent') return { bg: '#EAF2FF', border: '#AFC9F5', text: '#225DAA' };
  if (kind === 'result') return { bg: '#F4EEFF', border: '#D5C5F1', text: '#6A4C96' };
  if (kind === 'asset_image') return { bg: '#EAF7F1', border: '#B9DFCE', text: '#2C7455' };
  if (kind === 'atom_card') return { bg: '#FFF5E5', border: '#EACF9F', text: '#8C5D20' };
  return { bg: '#F7F5F0', border: '#D7D3CA', text: '#676057' };
};

export const CanvasNodeCard: React.FC<CanvasNodeCardProps> = ({ node, onSelect }) => {
  const tone = getCanvasNodeTone(node.kind);
  const roleLabel = getCanvasNodeRoleLabel(node.role, node.kind);
  const statusLabel = getCanvasNodeStatusLabel(node.status);
  const Icon = node.kind === 'agent' ? Bot : node.kind === 'asset_image' ? ImageIcon : node.kind === 'result' ? Sparkles : FileText;

  return (
    <div
      onPointerDown={() => onSelect(node.id)}
      className="relative h-full w-full overflow-hidden rounded-[8px] border bg-white text-left shadow-[0_12px_30px_rgba(36,43,53,0.13)] transition-[box-shadow,border-color] hover:shadow-[0_16px_38px_rgba(36,43,53,0.18)]"
      style={{ borderColor: tone.border }}
    >
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-2 border-b px-3 py-2.5" style={{ borderColor: tone.border, background: tone.bg }}>
          <span className="flex h-7 w-7 items-center justify-center rounded-[5px] bg-white/80" style={{ color: tone.text }}>
            <Icon size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] font-semibold text-[#252A31]">{node.title || '未命名节点'}</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[10px]" style={{ color: tone.text }}>
              <span>{roleLabel}</span>
              <span className="opacity-60">{getCanvasNodeKindLabel(node.kind)}</span>
            </div>
          </div>
          <span className="rounded-[4px] bg-white/75 px-1.5 py-0.5 text-[9px] font-medium" style={{ color: tone.text }}>{statusLabel}</span>
        </div>
        <div className="min-h-0 flex-1 px-3 py-2.5 pr-10">
          <div className="line-clamp-6 whitespace-pre-wrap text-[11px] leading-5 text-[#666C74]">
            {node.summary || (node.kind === 'agent' ? '连接资料后开始对话。' : '暂无摘要')}
          </div>
        </div>
      </div>
      <CanvasNodeAddMenu nodeId={node.id} isAgentGroup={node.contentType === 'agent_group'} />
    </div>
  );
};
