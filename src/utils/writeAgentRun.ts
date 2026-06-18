export type WriteAgentRunPhase =
  | '理解需求'
  | '查找素材'
  | '组织结构'
  | '生成内容'
  | '保存结果';

const NODE_PHASES: Record<string, WriteAgentRunPhase> = {
  hydrate_context: '理解需求',
  load_effective_skills: '理解需求',
  classify_intent: '理解需求',
  retrieve_knowledge: '查找素材',
  enrich_sources: '查找素材',
  decide_next: '组织结构',
  human_selection: '组织结构',
  generate_answer_or_draft: '生成内容',
  persist_memory: '保存结果',
  respond: '保存结果',
};

const MESSAGE_PHASES: Array<[RegExp, WriteAgentRunPhase]> = [
  [/召回|知识|素材|来源|引用|节点/, '查找素材'],
  [/提纲|结构|规划|角度/, '组织结构'],
  [/生成|正文|草稿|回答|文章/, '生成内容'],
  [/保存|写入|引用链路|结果/, '保存结果'],
];

export const getWriteAgentRunPhase = (node?: string, message?: string): WriteAgentRunPhase => {
  if (node && NODE_PHASES[node]) return NODE_PHASES[node];
  const text = message || '';
  const matched = MESSAGE_PHASES.find(([pattern]) => pattern.test(text));
  return matched ? matched[1] : '理解需求';
};

export type ParsedSseEvent = {
  event: string;
  payload: Record<string, unknown>;
};

export const parseWriteAgentSseChunk = (raw: string): ParsedSseEvent | null => {
  const eventLine = raw.split('\n').find(line => line.startsWith('event:'));
  const dataLines = raw.split('\n').filter(line => line.startsWith('data:'));
  if (!eventLine || dataLines.length === 0) return null;
  const event = eventLine.replace(/^event:\s*/, '').trim();
  const payloadText = dataLines.map(line => line.replace(/^data:\s*/, '')).join('\n');
  const payload = payloadText ? JSON.parse(payloadText) : {};
  return {
    event,
    payload: payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : { data: payload },
  };
};
