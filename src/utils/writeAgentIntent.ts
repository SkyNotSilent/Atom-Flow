export type WriteAgentIntentName =
  | 'chat'
  | 'select_material'
  | 'outline'
  | 'draft'
  | 'revise'
  | 'continue_note';

export type WriteAgentIntentClassification = {
  intent: {
    tools: string[];
    reason: string;
    intent: WriteAgentIntentName;
    confidence: 'high' | 'medium' | 'low';
    needsModelRouter?: boolean;
  };
  requestedTools: string[];
};

const TOOL_ORDER = [
  'recall_cards',
  'get_active_network',
  'list_recent_notes',
  'generate_outline',
  'generate_draft',
  'revise_note',
] as const;

const uniqueTools = (tools: Iterable<string>) => {
  const selected = new Set(tools);
  return TOOL_ORDER.filter(tool => selected.has(tool));
};

const has = (pattern: RegExp, text: string) => pattern.test(text);

export const normalizeWriteAgentIntent = (rawIntent?: string): WriteAgentIntentName => {
  if (
    rawIntent === 'chat' ||
    rawIntent === 'select_material' ||
    rawIntent === 'outline' ||
    rawIntent === 'draft' ||
    rawIntent === 'revise' ||
    rawIntent === 'continue_note'
  ) {
    return rawIntent;
  }
  return 'chat';
};

export const normalizeWriteAgentTools = (tools: unknown): string[] => {
  if (!Array.isArray(tools)) return [];
  return uniqueTools(tools.filter((tool): tool is string => typeof tool === 'string'));
};

export const classifyWriteAgentIntent = (
  message: string,
  isCreateArticle: boolean
): WriteAgentIntentClassification => {
  if (isCreateArticle) {
    return {
      intent: {
        tools: ['recall_cards', 'generate_outline', 'generate_draft'],
        reason: 'user explicitly requested create_article',
        intent: 'draft',
        confidence: 'high',
      },
      requestedTools: ['recall_cards', 'generate_outline', 'generate_draft'],
    };
  }

  const text = message.trim();
  const requestedTools = new Set<string>();
  const matchedSignals: string[] = [];

  const materialSignal = has(/(知识库|素材|节点|卡片|原文|图片|引用|来源|基于|围绕|总结|提炼|选题|观点|证据|资料|找一下|找些|召回|相关内容|相关资料)/, text);
  const recentNoteSignal = has(/(最近文章|之前草稿|我的文章|继续改|接着写|上次写|上一篇|刚才那篇|那篇文章)/, text);
  const outlineSignal = has(/(提纲|大纲|结构|章节|写作角度|角度|框架|目录)/, text);
  const negatedDraftSignal = has(/(不要|不用|无需|先别|别|暂时不|不需要).{0,8}(写一篇|成文|正文|草稿|直接写|生成文章|创建文章|完整文章)/, text);
  const draftSignal = !negatedDraftSignal && has(/(写一篇|成文|正文|草稿|直接写|生成文章|创建文章|完整文章|起承转合|Scratch)/i, text);
  const reviseSignal = has(/(继续改|润色|改写|修改|优化|重写|扩写|缩短|删掉|调整|换个风格|切换风格|更像|不够好)/, text);
  const activeNetworkSignal = has(/(当前网络|当前节点|激活网络|这些节点|这组卡片|选中的卡片)/, text);

  if (materialSignal) {
    requestedTools.add('recall_cards');
    matchedSignals.push('material');
  }
  if (activeNetworkSignal) {
    requestedTools.add('get_active_network');
    matchedSignals.push('active_network');
  }
  if (recentNoteSignal) {
    requestedTools.add('list_recent_notes');
    matchedSignals.push('recent_note');
  }
  if (outlineSignal) {
    requestedTools.add('recall_cards');
    requestedTools.add('generate_outline');
    matchedSignals.push('outline');
  }
  if (draftSignal) {
    requestedTools.add('recall_cards');
    requestedTools.add('generate_outline');
    requestedTools.add('generate_draft');
    matchedSignals.push('draft');
  }
  if (reviseSignal) {
    requestedTools.add('list_recent_notes');
    requestedTools.add('revise_note');
    matchedSignals.push('revise');
  }

  const tools = uniqueTools(requestedTools);
  const intent: WriteAgentIntentName = tools.includes('generate_draft')
    ? 'draft'
    : tools.includes('generate_outline')
      ? 'outline'
      : tools.includes('revise_note')
        ? 'revise'
        : tools.includes('list_recent_notes')
          ? 'continue_note'
          : tools.includes('recall_cards') || tools.includes('get_active_network')
            ? 'select_material'
            : 'chat';
  const confidence: WriteAgentIntentClassification['intent']['confidence'] = matchedSignals.length === 0
    ? (text.length <= 4 ? 'low' : 'medium')
    : matchedSignals.length === 1 || intent === 'draft'
      ? 'high'
      : 'medium';
  const needsModelRouter = confidence === 'low' || (matchedSignals.length >= 3 && intent !== 'draft');

  return {
    intent: {
      tools,
      reason: matchedSignals.length > 0
        ? `local rules matched: ${matchedSignals.join(',')}`
        : 'local rules did not require writing tools',
      intent,
      confidence,
      needsModelRouter,
    },
    requestedTools: tools,
  };
};

export const mergeWriteAgentModelRouterResult = (
  local: WriteAgentIntentClassification,
  modelResult: { tools?: unknown; intent?: unknown; reason?: unknown } | null
): WriteAgentIntentClassification => {
  if (!modelResult) return local;
  const tools = normalizeWriteAgentTools(modelResult.tools);
  if (tools.length === 0) return local;
  const intent = normalizeWriteAgentIntent(typeof modelResult.intent === 'string' ? modelResult.intent : undefined);
  return {
    intent: {
      tools,
      reason: typeof modelResult.reason === 'string' && modelResult.reason.trim()
        ? modelResult.reason.trim().slice(0, 240)
        : 'model router refined local intent',
      intent: intent === 'chat' && tools.length > 0 ? local.intent.intent : intent,
      confidence: 'medium',
    },
    requestedTools: tools,
  };
};
