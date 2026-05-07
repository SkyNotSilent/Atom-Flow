import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppContext } from '../context/AppContext';
import {
  AtomCard,
  NoteSourceReference,
	  SavedArticle,
	  WriteAgentChoice,
	  WriteAgentGraphTraceItem,
	  WriteAgentMessage,
	  WriteAgentSources,
	  WriteAgentThreadState,
	  WriteAgentSkill
	} from '../types';
import { cn } from '../components/Nav';
import { AlertCircle, Check, CheckCircle2, ChevronDown, Copy, Edit3, FileText, Image as ImageIcon, Loader2, MoreHorizontal, Palette, Plus, RotateCcw, Tag, ThumbsDown, ThumbsUp, Trash2, Volume2, Wand2, X, ZoomIn, ZoomOut } from 'lucide-react';
import { NotesPanel } from '../components/NotesPanel';
import { AtomFlowGalaxyIcon } from '../components/AtomFlowGalaxyIcon';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { prepareAgentDraftForNote } from '../utils/agentDraftExport';

type GraphArticle = {
  id: string;
  articleTitle: string;
  articleId?: number;
  cards: AtomCard[];
  x: number;
  y: number;
};

type GraphCardNode = {
  id: string;
  card: AtomCard;
  articleNodeId: string;
  x: number;
  y: number;
  orbitAngle: number;
  orbitRadius: number;
};

type GraphLink = {
  id: string;
  sourceId: string;
  targetId: string;
  kind: 'parent' | 'semantic' | 'article';
  strength?: number;
};

type SimNode = {
  id: string;
  kind: 'article' | 'card';
  x: number;
  y: number;
  vx: number;
  vy: number;
  anchorX: number;
  anchorY: number;
  radius: number;
  articleNodeId?: string;
  orbitAngle?: number;
  orbitRadius?: number;
};

type AssistantMessage = WriteAgentMessage;

type AssistantMeta = NonNullable<WriteAgentMessage['meta']> & {
  uiBlocks?: Array<Record<string, unknown>>;
  sources?: WriteAgentSources;
  choices?: WriteAgentChoice[];
};

type AgentRunStep = {
  node: string;
  label: string;
  status: 'running' | 'done' | 'error';
  durationMs?: number;
  outputSummary?: string;
};

type AgentRunState = {
  id: string;
  status: 'running' | 'done' | 'error';
  collapsed: boolean;
  steps: AgentRunStep[];
  message?: string;
};

type AssistantFeedback = 'liked' | 'disliked' | 'none';

const AGENT_STEP_COPY: Record<string, string> = {
  hydrate_context: '读取当前会话和写作上下文',
  load_effective_skills: '确认本次使用的写作规范',
  classify_intent: '理解你的问题意图',
  retrieve_knowledge: '从知识库里寻找相关素材',
  enrich_sources: '整理来源、摘录和图片线索',
  decide_next: '判断下一步可以怎么推进',
  human_selection: '同步本轮使用的知识节点',
  generate_answer_or_draft: '生成回答',
  persist_memory: '保存本轮对话和引用记录',
  respond: '整理最终回复'
};

const getAgentStepCopy = (node: string) => AGENT_STEP_COPY[node] || '处理写作任务';

const buildRunFromGraphTrace = (trace?: WriteAgentGraphTraceItem[]): AgentRunState | undefined => {
  if (!Array.isArray(trace) || trace.length === 0) return undefined;
  const steps = trace.map(item => ({
    node: item.node,
    label: getAgentStepCopy(item.node),
    status: 'done' as const,
    durationMs: item.durationMs
  }));
  return {
    id: `trace-${trace.map(item => item.node).join('-')}`,
    status: 'done',
    collapsed: true,
    steps,
    message: `已完成思考 · ${steps.length} 步`
  };
};

type RelatedArticleSummary = {
  articleId?: number;
  articleTitle: string;
  count: number;
};

type GraphSignalSet = {
  tags: string[];
  phrases: string[];
};

type GraphSignalMatch = {
  tags: string[];
  phrases: string[];
  score: number;
};

const GRAPH_WIDTH = 920;
const GRAPH_HEIGHT = 640;
const NODE_ORBIT_RADIUS = 82;
const GRAPH_MARGIN = NODE_ORBIT_RADIUS + 48;
const GRAPH_CARD_COLORS: Record<AtomCard['type'], { main: string; bg: string; darkBg: string }> = {
  '观点': { main: '#8C5EAE', bg: '#F6EEFF', darkBg: 'rgba(140, 94, 174, 0.18)' },
  '数据': { main: '#5B9B79', bg: '#EEF8F1', darkBg: 'rgba(91, 155, 121, 0.18)' },
  '金句': { main: '#D06C3F', bg: '#FFF2EA', darkBg: 'rgba(208, 108, 63, 0.18)' },
  '故事': { main: '#C79A38', bg: '#FFF8E7', darkBg: 'rgba(199, 154, 56, 0.18)' },
  '灵感': { main: '#CF6F73', bg: '#FFF0F0', darkBg: 'rgba(207, 111, 115, 0.18)' }
};
const GRAPH_FALLBACK_COLORS = { main: '#A56D4D', bg: '#FFF3EA', darkBg: 'rgba(165, 109, 77, 0.18)' };
const CUE_SPLIT_PATTERN = /[\n\r\t\s,，.。!?！？、;；:："'“”‘’()（）[\]【】<>《》/\\|+-]+/;
const CUE_CLEAN_PATTERN = /[\n\r\t\s,，.。!?！？、;；:："'“”‘’()（）[\]【】<>《》/\\|`~!@#$%^&*_+=-]+/g;
const CUE_STOPWORDS = new Set([
  '这个',
  '那个',
  '这些',
  '那些',
  '就是',
  '以及',
  '还有',
  '已经',
  '可以',
  '应该',
  '我们',
  '你们',
  '他们',
  '她们',
  '没有',
  '一种',
  '一个',
  '一些',
  '进行',
  '因为',
  '所以',
  '然后',
  '如果',
  '但是',
  '自己',
  '其中',
  '如何',
  '什么',
  '这样',
  '那样',
  '现在',
  '这里',
  '那里',
  'this',
  'that',
  'with',
  'from',
  'about',
  'there',
  'their',
  'have',
  'will',
  'would',
  'could',
  'should'
]);
const galaxySwirlPathCache = new Map<string, string>();
const DEFAULT_ASSISTANT_MESSAGES: AssistantMessage[] = [
  { id: 'welcome', role: 'assistant', content: '我会围绕你的知识关系图回答问题，并把 agent 的检索、提纲和写作动作完整记录下来。' }
];
const STYLE_SKILL_SEED_PROMPTS = [
  '深度分析型：用场景开篇、事实和逻辑说服，留白收尾，适合认知升级和趋势分析。',
  '热点事件解析型：四层递进——事件还原→技术拆解→商业价值→行业意义，强调冲击力。',
  '产品经理视角：开篇黄金公式（案例→联系→转折→观点），收尾必须有可执行启示。',
  'AI新闻报道型：感叹号标题、权威背书前置、口语化+数据对比密集。',
  '朋友圈轻量思辨：≤800字，悖论揭示法，三层递进（事件→放下争议→时代映射）。',
  '冷观察·纵横分析：纵轴时间线×横轴对比，冷静克制，交汇出洞察。',
  '教程类指南："学完就会"导向，每步只做一件事，步骤可验证。'
];

const STYLE_COMPONENT_EXAMPLES = [
  { token: '@观点', label: '调用知识库里的判断、机制解释、作者观点' },
  { token: '@数据', label: '调用数字、调研结果、趋势证据' },
  { token: '@金句', label: '调用适合做标题、转场或收尾的表达' },
  { token: '@故事', label: '调用人物、场景、案例和产品体验' }
];

type CardSkin = {
  id: string;
  name: string;
  border: [string, string, string];       // 3 stops for border gradient
  gem: [string, string, string];          // 3 stops for gem radial gradient
  gemGlow: string;                        // gem box-shadow color
  bar: [string, string, string];          // 3 stops for top decoration bar
  hoverGlow: string;                      // hover box-shadow glow
  accent: string;                         // front-side accent (buttons, badges)
  accentLight: string;                    // front-side accent hover bg
  backBg: string;                          // card back base background
  backContentBg: string;                   // content overlay bg
  patternStroke: string;                   // main SVG stroke color
  patternStroke2: string;                  // secondary stroke color
  accentText: string;                      // section label color (back)
  bodyText: string;                        // body text color (back)
  titleText: string;                       // title text color (back)
  borderWidth: string;                     // border thickness
  bgTexture: string;                       // background texture gradient
  bgOpacity: string;                       // background texture opacity
  barPattern: string;                      // top bar pattern overlay
  gemPattern: string;                      // gem radial gradient pattern
  cornerAccent: string;                    // corner decoration gradient
};

const CARD_SKINS: CardSkin[] = [
  {
    id: 'imperial-gold',
    name: '御金',
    border: ['#C9A84C', '#D4AF37', '#8B6914'],
    gem: ['#F5E6B8', '#D4AF37', '#8B6914'],
    gemGlow: 'rgba(212, 175, 55, 0.6)',
    bar: ['#C9A84C', '#D4AF37', '#F5E6B8'],
    hoverGlow: 'rgba(212, 175, 55, 0.2)',
    accent: '#D97706',
    accentLight: '#FEF3C7',
    backBg: '#1C1916',
    backContentBg: 'rgba(28, 25, 22, 0.92)',
    patternStroke: '#D4AF37',
    patternStroke2: '#F5E6B8',
    accentText: 'rgba(212, 175, 55, 0.6)',
    bodyText: 'rgba(254, 243, 199, 0.85)',
    titleText: '#FDE68A',
    borderWidth: '3px',
    bgTexture: 'radial-gradient(circle at 30% 30%, rgba(212, 175, 55, 0.08), transparent 60%)',
    bgOpacity: '0.2',
    barPattern: 'repeating-radial-gradient(circle at 50% 0, transparent 0, transparent 4px, rgba(212, 175, 55, 0.25) 4px, rgba(212, 175, 55, 0.25) 5px)',
    gemPattern: 'radial-gradient(circle at 30% 30%, #F5E6B8, #D4AF37 40%, #8B6914)',
    cornerAccent: 'linear-gradient(135deg, currentColor 0%, currentColor 30%, transparent 30%, transparent 100%), linear-gradient(225deg, currentColor 0%, currentColor 30%, transparent 30%, transparent 100%)',
  },
  {
    id: 'dark-iron',
    name: '玄铁',
    border: ['#71717A', '#A1A1AA', '#52525B'],
    gem: ['#D4D4D8', '#A1A1AA', '#52525B'],
    gemGlow: 'rgba(161, 161, 170, 0.5)',
    bar: ['#71717A', '#A1A1AA', '#D4D4D8'],
    hoverGlow: 'rgba(161, 161, 170, 0.2)',
    accent: '#71717A',
    accentLight: '#F4F4F5',
    backBg: '#18181B',
    backContentBg: 'rgba(24, 24, 27, 0.92)',
    patternStroke: '#A1A1AA',
    patternStroke2: '#D4D4D8',
    accentText: 'rgba(161, 161, 170, 0.6)',
    bodyText: 'rgba(228, 228, 231, 0.85)',
    titleText: '#E4E4E7',
    borderWidth: '2px',
    bgTexture: 'repeating-linear-gradient(90deg, transparent, transparent 2px, rgba(161, 161, 170, 0.03) 2px, rgba(161, 161, 170, 0.03) 4px)',
    bgOpacity: '0.3',
    barPattern: 'repeating-linear-gradient(90deg, transparent 0, transparent 6px, rgba(113, 113, 122, 0.4) 6px, rgba(113, 113, 122, 0.4) 8px, transparent 8px, transparent 14px)',
    gemPattern: 'radial-gradient(circle at 40% 40%, #D4D4D8, #A1A1AA 50%, #52525B)',
    cornerAccent: 'radial-gradient(circle at 0% 0%, currentColor 0%, currentColor 35%, transparent 35%)',
  },
  {
    id: 'cinnabar',
    name: '朱砂',
    border: ['#B91C1C', '#DC2626', '#7F1D1D'],
    gem: ['#FCA5A5', '#DC2626', '#7F1D1D'],
    gemGlow: 'rgba(220, 38, 38, 0.5)',
    bar: ['#B91C1C', '#DC2626', '#FCA5A5'],
    hoverGlow: 'rgba(220, 38, 38, 0.2)',
    accent: '#DC2626',
    accentLight: '#FEE2E2',
    backBg: '#1C1111',
    backContentBg: 'rgba(28, 17, 17, 0.92)',
    patternStroke: '#DC2626',
    patternStroke2: '#FCA5A5',
    accentText: 'rgba(220, 38, 38, 0.6)',
    bodyText: 'rgba(254, 202, 202, 0.85)',
    titleText: '#FCA5A5',
    borderWidth: '3px',
    bgTexture: 'radial-gradient(circle at 50% 50%, rgba(220, 38, 38, 0.06), transparent 70%)',
    bgOpacity: '0.25',
    barPattern: 'repeating-linear-gradient(90deg, transparent 0, rgba(220, 38, 38, 0.3) 3px, transparent 6px, rgba(185, 28, 28, 0.2) 9px, transparent 12px)',
    gemPattern: 'radial-gradient(circle at 35% 35%, #FCA5A5, #DC2626 45%, #7F1D1D)',
    cornerAccent: 'radial-gradient(ellipse at 0% 0%, currentColor 0%, currentColor 40%, transparent 40%), radial-gradient(ellipse at 100% 0%, currentColor 0%, currentColor 25%, transparent 25%)',
  },
  {
    id: 'jade',
    name: '翡翠',
    border: ['#15803D', '#22C55E', '#14532D'],
    gem: ['#86EFAC', '#22C55E', '#14532D'],
    gemGlow: 'rgba(34, 197, 94, 0.5)',
    bar: ['#15803D', '#22C55E', '#86EFAC'],
    hoverGlow: 'rgba(34, 197, 94, 0.2)',
    accent: '#16A34A',
    accentLight: '#DCFCE7',
    backBg: '#111C15',
    backContentBg: 'rgba(17, 28, 21, 0.92)',
    patternStroke: '#22C55E',
    patternStroke2: '#86EFAC',
    accentText: 'rgba(34, 197, 94, 0.6)',
    bodyText: 'rgba(187, 247, 208, 0.85)',
    titleText: '#86EFAC',
    borderWidth: '3px',
    bgTexture: 'repeating-linear-gradient(45deg, transparent, transparent 3px, rgba(34, 197, 94, 0.02) 3px, rgba(34, 197, 94, 0.02) 6px)',
    bgOpacity: '0.3',
    barPattern: 'repeating-linear-gradient(135deg, transparent 0, transparent 2px, rgba(34, 197, 94, 0.25) 2px, rgba(34, 197, 94, 0.25) 4px, transparent 4px, transparent 8px)',
    gemPattern: 'radial-gradient(circle at 35% 35%, #86EFAC, #22C55E 50%, #14532D)',
    cornerAccent: 'radial-gradient(ellipse at 0% 0%, currentColor 0%, currentColor 45%, transparent 45%), linear-gradient(45deg, transparent 50%, currentColor 50%, currentColor 70%, transparent 70%)',
  },
  {
    id: 'amethyst',
    name: '紫晶',
    border: ['#7C3AED', '#A855F7', '#581C87'],
    gem: ['#D8B4FE', '#A855F7', '#581C87'],
    gemGlow: 'rgba(168, 85, 247, 0.5)',
    bar: ['#7C3AED', '#A855F7', '#D8B4FE'],
    hoverGlow: 'rgba(168, 85, 247, 0.2)',
    accent: '#9333EA',
    accentLight: '#F3E8FF',
    backBg: '#1A111C',
    backContentBg: 'rgba(26, 17, 28, 0.92)',
    patternStroke: '#A855F7',
    patternStroke2: '#D8B4FE',
    accentText: 'rgba(168, 85, 247, 0.6)',
    bodyText: 'rgba(233, 213, 255, 0.85)',
    titleText: '#D8B4FE',
    borderWidth: '3px',
    bgTexture: 'conic-gradient(from 45deg at 50% 50%, transparent 0deg, rgba(168, 85, 247, 0.04) 90deg, transparent 180deg, rgba(168, 85, 247, 0.04) 270deg, transparent 360deg)',
    bgOpacity: '0.25',
    barPattern: 'repeating-linear-gradient(90deg, transparent 0, rgba(124, 58, 237, 0.3) 2px, transparent 4px, rgba(168, 85, 247, 0.2) 6px, transparent 8px)',
    gemPattern: 'radial-gradient(circle at 30% 30%, #D8B4FE, #A855F7 45%, #581C87)',
    cornerAccent: 'linear-gradient(135deg, currentColor 0%, currentColor 25%, transparent 25%, transparent 50%, currentColor 50%, currentColor 60%, transparent 60%)',
  },
];

/** 根据 skin.id 渲染不同 SVG 背面纹路 */
function renderCardPattern(skillId: number | string, skinId: string, stroke: string, stroke2: string) {
  const gid = `g-${skillId}`;
  const gid2 = `g2-${skillId}`;
  const defs = (
    <defs>
      <linearGradient id={gid} x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor={stroke} stopOpacity="0.15" />
        <stop offset="50%" stopColor={stroke} stopOpacity="0.25" />
        <stop offset="100%" stopColor={stroke} stopOpacity="0.12" />
      </linearGradient>
      <linearGradient id={gid2} x1="100%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stopColor={stroke2} stopOpacity="0.08" />
        <stop offset="100%" stopColor={stroke} stopOpacity="0.18" />
      </linearGradient>
    </defs>
  );

  const corner = (
    <>
      <path d="M10,10 L50,10 M10,10 L10,50" stroke={stroke} strokeWidth="0.6" opacity="0.15" strokeLinecap="round" />
      <path d="M210,10 L170,10 M210,10 L210,50" stroke={stroke} strokeWidth="0.6" opacity="0.15" strokeLinecap="round" />
      <path d="M10,330 L50,330 M10,330 L10,290" stroke={stroke} strokeWidth="0.6" opacity="0.15" strokeLinecap="round" />
      <path d="M210,330 L170,330 M210,330 L210,290" stroke={stroke} strokeWidth="0.6" opacity="0.15" strokeLinecap="round" />
    </>
  );

  const circles = (
    <>
      <circle cx="110" cy="170" r="45" stroke={stroke} strokeWidth="0.5" fill="none" opacity="0.08" />
      <circle cx="110" cy="170" r="35" stroke={stroke} strokeWidth="0.4" fill="none" opacity="0.06" />
      <circle cx="110" cy="170" r="25" stroke={stroke} strokeWidth="0.3" fill="none" opacity="0.05" />
    </>
  );

  switch (skinId) {
    case 'dark-iron':
      return (
        <svg viewBox="0 0 220 340" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice">
          {defs}
          {/* 六边形网格 */}
          {Array.from({ length: 5 }, (_, row) =>
            Array.from({ length: 4 }, (_, col) => {
              const cx = 30 + col * 52 + (row % 2 ? 26 : 0);
              const cy = 40 + row * 65;
              const pts = Array.from({ length: 6 }, (_, i) => {
                const a = (Math.PI / 3) * i - Math.PI / 6;
                return `${cx + 18 * Math.cos(a)},${cy + 18 * Math.sin(a)}`;
              }).join(' ');
              return <polygon key={`${row}-${col}`} points={pts} stroke={stroke} strokeWidth="0.5" fill="none" opacity={0.12 - row * 0.015} />;
            })
          )}
          {/* 菱形装饰 */}
          <path d="M110,60 L140,100 L110,140 L80,100 Z" stroke={stroke} strokeWidth="0.6" fill="none" opacity="0.1" />
          <path d="M110,200 L140,240 L110,280 L80,240 Z" stroke={stroke} strokeWidth="0.6" fill="none" opacity="0.08" />
          {/* 对角线 */}
          <path d="M20,20 L200,320" stroke={stroke} strokeWidth="0.3" opacity="0.06" />
          <path d="M200,20 L20,320" stroke={stroke} strokeWidth="0.3" opacity="0.06" />
          {corner}
          {circles}
        </svg>
      );

    case 'cinnabar':
      return (
        <svg viewBox="0 0 220 340" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice">
          {defs}
          {/* 祥云纹 */}
          <path d="M30,80 C40,60 60,55 70,65 C80,75 75,90 60,92 C50,94 40,88 38,80 C36,72 45,65 55,68" stroke={`url(#${gid})`} strokeWidth="1.8" fill="none" strokeLinecap="round" />
          <path d="M140,50 C152,35 170,32 178,42 C186,52 180,64 168,66 C158,68 150,62 148,55" stroke={`url(#${gid})`} strokeWidth="1.5" fill="none" strokeLinecap="round" />
          <path d="M80,160 C92,145 110,142 118,152 C126,162 120,174 108,176 C98,178 90,172 88,165" stroke={`url(#${gid})`} strokeWidth="1.6" fill="none" strokeLinecap="round" />
          <path d="M40,240 C50,225 65,222 72,230 C79,238 75,248 64,250 C56,252 48,247 46,240" stroke={`url(#${gid})`} strokeWidth="1.4" fill="none" strokeLinecap="round" />
          <path d="M150,200 C160,185 178,182 186,192 C194,202 188,214 176,216 C166,218 158,212 156,205" stroke={`url(#${gid})`} strokeWidth="1.5" fill="none" strokeLinecap="round" />
          <path d="M100,280 C108,268 122,265 128,272 C134,279 130,288 122,290" stroke={`url(#${gid})`} strokeWidth="1.2" fill="none" strokeLinecap="round" />
          {/* 回纹边饰 */}
          <path d="M15,130 L15,120 L25,120 L25,130 L15,130 M15,140 L15,135 M25,135 L25,140" stroke={stroke} strokeWidth="0.8" fill="none" opacity="0.2" />
          <path d="M195,195 L195,185 L205,185 L205,195 L195,195 M195,205 L195,200 M205,200 L205,205" stroke={stroke} strokeWidth="0.8" fill="none" opacity="0.2" />
          {corner}
          {circles}
        </svg>
      );

    case 'jade':
      return (
        <svg viewBox="0 0 220 340" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice">
          {defs}
          {/* 水波纹 */}
          <path d="M10,70 C40,55 80,55 110,70 C140,85 180,85 210,70" stroke={`url(#${gid})`} strokeWidth="1.5" fill="none" strokeLinecap="round" />
          <path d="M10,90 C40,75 80,75 110,90 C140,105 180,105 210,90" stroke={`url(#${gid})`} strokeWidth="1.2" fill="none" strokeLinecap="round" opacity="0.7" />
          <path d="M10,110 C40,95 80,95 110,110 C140,125 180,125 210,110" stroke={stroke} strokeWidth="0.8" fill="none" strokeLinecap="round" opacity="0.4" />
          <path d="M10,170 C40,155 80,155 110,170 C140,185 180,185 210,170" stroke={`url(#${gid})`} strokeWidth="1.5" fill="none" strokeLinecap="round" />
          <path d="M10,190 C40,175 80,175 110,190 C140,205 180,205 210,190" stroke={`url(#${gid})`} strokeWidth="1.2" fill="none" strokeLinecap="round" opacity="0.7" />
          <path d="M10,210 C40,195 80,195 110,210 C140,225 180,225 210,210" stroke={stroke} strokeWidth="0.8" fill="none" strokeLinecap="round" opacity="0.4" />
          <path d="M10,270 C40,255 80,255 110,270 C140,285 180,285 210,270" stroke={`url(#${gid})`} strokeWidth="1.5" fill="none" strokeLinecap="round" />
          <path d="M10,290 C40,275 80,275 110,290 C140,305 180,305 210,290" stroke={stroke} strokeWidth="0.8" fill="none" strokeLinecap="round" opacity="0.5" />
          {/* 漩涡装饰 */}
          <path d="M50,140 C55,132 65,130 68,136 C71,142 64,146 58,144 C52,142 50,136 54,132" stroke={`url(#${gid2})`} strokeWidth="1" fill="none" strokeLinecap="round" />
          <path d="M160,240 C165,232 175,230 178,236 C181,242 174,246 168,244 C162,242 160,236 164,232" stroke={`url(#${gid2})`} strokeWidth="1" fill="none" strokeLinecap="round" />
          {corner}
          {circles}
        </svg>
      );

    case 'amethyst':
      return (
        <svg viewBox="0 0 220 340" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice">
          {defs}
          {/* 凤凰剪影 */}
          <path d="M110,40 C115,50 120,55 125,52 C130,49 128,42 130,38 C132,34 140,32 142,36 C144,40 138,45 132,48 C126,51 120,55 118,65 C116,75 120,85 125,90 C130,95 138,92 140,85 C142,78 135,75 130,80"
            stroke={`url(#${gid})`} strokeWidth="2" fill="none" strokeLinecap="round" />
          {/* 凤尾 */}
          <path d="M125,90 C130,100 135,115 128,130 C121,145 110,150 105,140 C100,130 108,120 115,125 C122,130 120,140 112,142"
            stroke={`url(#${gid})`} strokeWidth="1.8" fill="none" strokeLinecap="round" />
          <path d="M105,140 C95,150 85,165 90,180 C95,195 110,200 115,190 C120,180 112,170 105,175"
            stroke={`url(#${gid})`} strokeWidth="1.5" fill="none" strokeLinecap="round" />
          <path d="M115,190 C120,205 125,220 118,240 C111,260 100,268 95,258 C90,248 100,240 108,245"
            stroke={`url(#${gid})`} strokeWidth="1.3" fill="none" strokeLinecap="round" />
          {/* 羽毛纹 */}
          <path d="M130,80 C140,78 148,82 145,90 C142,98 132,96 130,90" stroke={stroke} strokeWidth="0.8" fill="none" opacity="0.2" />
          <path d="M120,125 C130,120 140,124 137,132 C134,140 124,138 122,132" stroke={stroke} strokeWidth="0.8" fill="none" opacity="0.18" />
          <path d="M100,175 C110,170 120,174 117,182 C114,190 104,188 102,182" stroke={stroke} strokeWidth="0.8" fill="none" opacity="0.15" />
          {/* 火焰纹 */}
          <path d="M60,60 C65,48 75,45 78,52 C81,59 72,64 67,58" stroke={`url(#${gid2})`} strokeWidth="1" fill="none" strokeLinecap="round" />
          <path d="M160,260 C165,248 175,245 178,252 C181,259 172,264 167,258" stroke={`url(#${gid2})`} strokeWidth="1" fill="none" strokeLinecap="round" />
          {corner}
          {circles}
        </svg>
      );

    default: // imperial-gold 龙纹
      return (
        <svg viewBox="0 0 220 340" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice">
          {defs}
          <path d="M30,280 C40,240 60,220 80,200 C100,180 90,150 110,130 C130,110 120,80 140,60 C155,45 170,50 180,65 C190,80 175,95 165,100 C150,108 140,100 145,90 C150,80 165,75 170,85"
            stroke={`url(#${gid})`} strokeWidth="2.5" fill="none" strokeLinecap="round" />
          <path d="M80,200 C70,210 55,205 60,190 C65,175 85,170 95,180 C105,190 90,200 80,200"
            stroke={`url(#${gid})`} strokeWidth="2" fill="none" strokeLinecap="round" />
          <path d="M30,280 C20,290 15,300 25,310 C35,320 50,315 45,305 C40,295 25,295 30,280"
            stroke={`url(#${gid})`} strokeWidth="2" fill="none" strokeLinecap="round" />
          <path d="M75,205 C72,198 78,192 84,196" stroke={stroke} strokeWidth="0.8" fill="none" opacity="0.2" />
          <path d="M90,185 C87,178 93,172 99,176" stroke={stroke} strokeWidth="0.8" fill="none" opacity="0.2" />
          <path d="M100,165 C97,158 103,152 109,156" stroke={stroke} strokeWidth="0.8" fill="none" opacity="0.2" />
          <path d="M108,145 C105,138 111,132 117,136" stroke={stroke} strokeWidth="0.8" fill="none" opacity="0.2" />
          <path d="M120,125 C117,118 123,112 129,116" stroke={stroke} strokeWidth="0.8" fill="none" opacity="0.2" />
          <path d="M132,105 C129,98 135,92 141,96" stroke={stroke} strokeWidth="0.8" fill="none" opacity="0.2" />
          <path d="M165,100 C170,108 168,118 160,115 M165,100 C172,105 175,115 168,118 M165,100 C162,110 158,118 152,114"
            stroke={`url(#${gid})`} strokeWidth="1.5" fill="none" strokeLinecap="round" />
          <path d="M180,65 C195,55 210,58 205,70 M180,65 C192,60 208,68 200,78"
            stroke={stroke} strokeWidth="1" fill="none" opacity="0.25" strokeLinecap="round" />
          <circle cx="178" cy="68" r="3" fill={stroke} opacity="0.3" />
          <circle cx="178" cy="68" r="1.2" fill={stroke2} opacity="0.4" />
          <path d="M20,40 C30,30 45,30 45,42 C45,54 30,54 30,44 C30,38 38,36 40,42"
            stroke={`url(#${gid2})`} strokeWidth="1.2" fill="none" strokeLinecap="round" />
          <path d="M170,280 C180,270 195,270 195,282 C195,294 180,294 180,284 C180,278 188,276 190,282"
            stroke={`url(#${gid2})`} strokeWidth="1.2" fill="none" strokeLinecap="round" />
          <path d="M5,160 C12,152 22,152 22,160 C22,168 12,168 12,162"
            stroke={`url(#${gid2})`} strokeWidth="1" fill="none" strokeLinecap="round" />
          <path d="M140,55 C145,42 155,38 158,48 C161,58 150,62 145,55 C143,52 148,45 152,48"
            stroke={stroke} strokeWidth="0.8" fill="none" opacity="0.2" strokeLinecap="round" />
          {corner}
          {circles}
        </svg>
      );
  }
}

type SkillsAssistantMessage = {
  id: string;
  role: 'assistant' | 'user';
  content: string;
  draftSkill?: {
    name: string;
    description: string;
    prompt: string;
    constraints: string[];
  };
};

const getCardColors = (type: AtomCard['type']) => GRAPH_CARD_COLORS[type] || GRAPH_FALLBACK_COLORS;
const getArticleNodeId = (card: AtomCard) => `article-${card.articleId ?? card.articleTitle}`;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const getIdSeed = (id: string) => Array.from(id).reduce((sum, char, index) => sum + char.charCodeAt(0) * (index + 1), 0);
const truncateText = (value: string, max = 22) => (value.length > max ? `${value.slice(0, max)}…` : value);
const buildActivationSummary = (cards: AtomCard[]) => cards.slice(0, 5).map(card => `${card.type} · ${card.content.slice(0, 20)}`);
const normalizeCue = (value: string) => value.toLowerCase().replace(CUE_CLEAN_PATTERN, '').trim();
const extractKeywordPhrases = (value: string) => {
  const phrases = new Set<string>();
  value
    .split(CUE_SPLIT_PATTERN)
    .map(part => normalizeCue(part))
    .filter(Boolean)
    .forEach(part => {
      if (part.length < 2 || CUE_STOPWORDS.has(part)) return;
      phrases.add(part);
      if (/^[\u4e00-\u9fff]+$/.test(part) && part.length > 6) {
        const middleStart = Math.max(0, Math.floor(part.length / 2) - 2);
        [part.slice(0, 4), part.slice(middleStart, middleStart + 4), part.slice(-4)].forEach(fragment => {
          if (fragment.length >= 2 && !CUE_STOPWORDS.has(fragment)) {
            phrases.add(fragment);
          }
        });
      }
    });
  return Array.from(phrases).slice(0, 18);
};
const buildCardSignalSet = (card: AtomCard): GraphSignalSet => {
  const tags = Array.from(new Set((card.tags || []).map(tag => normalizeCue(tag)).filter(Boolean)));
  const phrases = Array.from(new Set([
    ...extractKeywordPhrases(card.content || ''),
    ...extractKeywordPhrases(card.summary || ''),
    ...extractKeywordPhrases(card.sourceContext || ''),
    ...extractKeywordPhrases(card.context || ''),
    ...extractKeywordPhrases(card.originalQuote || ''),
    ...extractKeywordPhrases(card.citationNote || ''),
    ...extractKeywordPhrases(card.articleTitle || '')
  ])).filter(phrase => !tags.includes(phrase));
  return { tags, phrases };
};
const buildArticleSignalSet = (articleTitle: string, cards: AtomCard[]): GraphSignalSet => {
  const tags = new Set<string>();
  const phrases = new Set<string>(extractKeywordPhrases(articleTitle || ''));
  cards.forEach(card => {
    const signalSet = buildCardSignalSet(card);
    signalSet.tags.forEach(tag => tags.add(tag));
    signalSet.phrases.forEach(phrase => phrases.add(phrase));
  });
  return { tags: Array.from(tags), phrases: Array.from(phrases).filter(phrase => !tags.has(phrase)) };
};
const cuesOverlap = (left: string, right: string) => {
  if (left === right) return true;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length > right.length ? left : right;
  return shorter.length >= 3 && longer.includes(shorter);
};
const getSharedCues = (left: string[], right: string[]) => {
  const shared = new Set<string>();
  left.forEach(cue => {
    const matchedCue = right.find(candidate => cuesOverlap(cue, candidate));
    if (!matchedCue) return;
    shared.add(cue.length >= matchedCue.length ? cue : matchedCue);
  });
  return Array.from(shared);
};
const getSignalMatch = (left: GraphSignalSet, right: GraphSignalSet): GraphSignalMatch => {
  const tags = getSharedCues(left.tags, right.tags);
  const phrases = getSharedCues(left.phrases, right.phrases).filter(phrase => !tags.some(tag => cuesOverlap(tag, phrase)));
  return {
    tags,
    phrases,
    score: tags.length * 1.85 + phrases.length * 0.9
  };
};
const selectSparseLinks = (candidates: GraphLink[], limitPerNode: number) => {
  const degreeCount = new Map<string, number>();
  return candidates
    .sort((left, right) => (right.strength || 0) - (left.strength || 0) || left.id.localeCompare(right.id))
    .filter(link => {
      const sourceCount = degreeCount.get(link.sourceId) || 0;
      const targetCount = degreeCount.get(link.targetId) || 0;
      if (sourceCount >= limitPerNode || targetCount >= limitPerNode) {
        return false;
      }
      degreeCount.set(link.sourceId, sourceCount + 1);
      degreeCount.set(link.targetId, targetCount + 1);
      return true;
    });
};
const formatDate = (value?: string | number) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('zh-CN');
};
const getGalaxySwirlPath = (radius: number) => {
  const key = radius.toFixed(2);
  const cached = galaxySwirlPathCache.get(key);
  if (cached) return cached;
  const point = (value: number) => Number(value.toFixed(2));
  const path = [
    `M ${point(-1.05 * radius)} ${point(0.02 * radius)}`,
    `C ${point(-0.72 * radius)} ${point(-1.05 * radius)} ${point(0.74 * radius)} ${point(-1.08 * radius)} ${point(1.08 * radius)} ${point(-0.22 * radius)}`,
    `C ${point(1.42 * radius)} ${point(0.64 * radius)} ${point(0.32 * radius)} ${point(1.18 * radius)} ${point(-0.35 * radius)} ${point(0.62 * radius)}`,
    `C ${point(-0.96 * radius)} ${point(0.1 * radius)} ${point(-0.32 * radius)} ${point(-0.5 * radius)} ${point(0.28 * radius)} ${point(-0.25 * radius)}`,
    `C ${point(0.7 * radius)} ${point(-0.08 * radius)} ${point(0.68 * radius)} ${point(0.32 * radius)} ${point(0.38 * radius)} ${point(0.43 * radius)}`
  ].join(' ');
  galaxySwirlPathCache.set(key, path);
  return path;
};

const getErrorMessageFromResponse = async (response: Response, fallback: string) => {
  try {
    const data = await response.json();
    if (typeof data?.error === 'string' && data.error.trim()) {
      return data.error.trim();
    }
    if (typeof data?.message === 'string' && data.message.trim()) {
      return data.message.trim();
    }
  } catch {
    // ignore non-json bodies
  }
  return fallback;
};

export const WritePage: React.FC = () => {
  const {
    showToast,
    user,
    loginAndDo,
    savedCards,
    savedArticles,
    notes,
    reloadNotes,
    createNote,
    writeWorkspaceMode,
    setWriteWorkspaceMode,
    writeGraphView,
    setWriteGraphView,
    writeFocusedTopic,
    setWriteFocusedTopic,
    writeActivatedNodeIds,
    setWriteActivatedNodeIds,
    writeActivationSummary,
    setWriteActivationSummary,
    assistantThreads,
    assistantThreadId,
    setAssistantThreadId,
    loadAssistantThreads,
	    createAssistantThread,
    writeAgentSkills,
	    selectedStyleSkillId,
	    setSelectedStyleSkillId,
	    selectedSkillIds,
	    setSelectedSkillIds,
    createWriteAgentSkill,
    updateWriteAgentSkill,
    deleteWriteAgentSkill
	  } = useAppContext();

  const [isRecalling, setIsRecalling] = useState(false);
  const [isGeneratingDraft, setIsGeneratingDraft] = useState(false);
  const [selectedCardIds, setSelectedCardIds] = useState<string[]>([]);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [assistantInput, setAssistantInput] = useState('');
  const [isAssistantThinking, setIsAssistantThinking] = useState(false);
  const [assistantMessages, setAssistantMessages] = useState<AssistantMessage[]>(DEFAULT_ASSISTANT_MESSAGES);
  const [agentRun, setAgentRun] = useState<AgentRunState | null>(null);
  const [editingSkillId, setEditingSkillId] = useState<number | string | null>(null);
  const [flippedCardId, setFlippedCardId] = useState<number | string | null>(null);
  const [cardSkinId, setCardSkinId] = useState<string>('imperial-gold');
  const [showSkinPicker, setShowSkinPicker] = useState(false);
  const cardSkin = useMemo(() => CARD_SKINS.find(s => s.id === cardSkinId) || CARD_SKINS[0], [cardSkinId]);
  const [skillDraft, setSkillDraft] = useState({
    name: '',
    type: 'writing' as 'card_storage' | 'citation' | 'writing' | 'style',
    description: '',
    prompt: '',
    constraints: ''
  });
  const [skillsAssistantInput, setSkillsAssistantInput] = useState('');
  const [pastedStyleDoc, setPastedStyleDoc] = useState('');
  const [skillsAssistantMessages, setSkillsAssistantMessages] = useState<SkillsAssistantMessage[]>([
    {
      id: 'skills-welcome',
      role: 'assistant',
      content: '我是 Skills 助手。你不用写 prompt，直接描述你想要的写作风格、引用习惯或表达边界；当我判断适合沉淀成风格 Skill 时，会在对话下方给你一个“创建风格 Skill”的确认。'
    }
  ]);
  const [zoom, setZoom] = useState(1);
  const [graphPositions, setGraphPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [draggedNodeId, setDraggedNodeId] = useState<string | null>(null);
  const [hoverTooltip, setHoverTooltip] = useState<{ x: number; y: number; text: string; tone: 'sun' | 'atom' | 'atom-warm' } | null>(null);
  const [showBackgroundDrawer, setShowBackgroundDrawer] = useState(false);
  const [showChatHistory, setShowChatHistory] = useState(false);
  const [showSkillHistory, setShowSkillHistory] = useState(false);

  const applyThreadState = useCallback((state?: WriteAgentThreadState | null) => {
    if (!state) return;
    if (typeof state.focusedTopic === 'string') {
      setWriteFocusedTopic(state.focusedTopic);
    }
    if (Array.isArray(state.activatedNodeIds)) {
      setWriteActivatedNodeIds(state.activatedNodeIds);
      setSelectedCardIds(state.activatedNodeIds);
    }
    if (Array.isArray(state.activationSummary)) {
      setWriteActivationSummary(state.activationSummary);
    }
    if (state.selectedStyleSkillId !== undefined) {
      setSelectedStyleSkillId(state.selectedStyleSkillId);
    }
    if (Array.isArray(state.selectedSkillIds)) {
      setSelectedSkillIds(state.selectedSkillIds);
    }
  }, [setSelectedSkillIds, setSelectedStyleSkillId, setWriteActivatedNodeIds, setWriteActivationSummary, setWriteFocusedTopic]);

  const hydrateThreadMessages = useCallback(async (threadId: number) => {
    try {
      const response = await fetch(`/api/write/agent/threads/${threadId}/messages`);
      if (!response.ok) return;
      const data = await response.json();
      const messages = Array.isArray(data?.messages) ? data.messages : [];
      setAssistantMessages(messages.length > 0
        ? messages.map((message: AssistantMessage) => (
          message.role === 'assistant'
            ? {
              ...message,
              meta: {
                ...(message.meta || {}),
                feedback: message.meta?.feedback || 'none',
                sourceCollapsed: message.meta?.sourceCollapsed ?? true,
                run: message.meta?.run || buildRunFromGraphTrace(message.meta?.graphTrace)
              }
            }
            : message
        ))
        : DEFAULT_ASSISTANT_MESSAGES);
      applyThreadState(data?.thread?.state);
    } catch {
      // ignore history hydration errors
    }
  }, [applyThreadState]);

  const simulationFrameRef = useRef<number | null>(null);
  const simulationHeatRef = useRef(0.3);
  const simulationNodesRef = useRef<SimNode[]>([]);
  const lastStepAtRef = useRef<number | null>(null);
  const suppressClickRef = useRef<string | null>(null);
  const graphSvgRef = useRef<SVGSVGElement | null>(null);
  const graphCanvasRef = useRef<HTMLDivElement | null>(null);
  const agentRunRef = useRef<AgentRunState | null>(null);
  const dragStateRef = useRef<{
    nodeId: string;
    kind: 'article' | 'card';
    pointerId: number;
    offsetX: number;
    offsetY: number;
    lastX: number;
    lastY: number;
    lastMoveAt: number;
    travel: number;
    moved: boolean;
  } | null>(null);

  const visibleCards = savedCards;
  const selectedCards = useMemo(() => visibleCards.filter(card => selectedCardIds.includes(card.id)), [visibleCards, selectedCardIds]);

  const articleGroups = useMemo(() => {
    const grouped = new Map<string, { articleTitle: string; articleId?: number; cards: AtomCard[] }>();
    visibleCards.forEach(card => {
      const key = getArticleNodeId(card);
      const group = grouped.get(key);
      if (group) {
        group.cards.push(card);
        return;
      }
      grouped.set(key, {
        articleTitle: card.articleTitle || '未命名文章',
        articleId: card.articleId,
        cards: [card]
      });
    });
    return Array.from(grouped.entries()).map(([id, group]) => ({ id, ...group }));
  }, [visibleCards]);

  const graph = useMemo(() => {
    const centerX = GRAPH_WIDTH / 2;
    const centerY = GRAPH_HEIGHT / 2;
    const visibleArticleGroups = articleGroups.filter(group => group.cards.length > 0);
    const baseArticleGroups = writeGraphView === 'activated'
      ? visibleArticleGroups.filter(group => group.cards.some(card => selectedCardIds.includes(card.id)))
      : visibleArticleGroups;
    const displayArticleGroups = baseArticleGroups.length > 0 ? baseArticleGroups : visibleArticleGroups;

    const articles: GraphArticle[] = displayArticleGroups.map((group, index) => {
      const count = Math.max(displayArticleGroups.length, 1);
      const seed = getIdSeed(group.id);
      const angle = (Math.PI * 2 * index) / count - Math.PI / 2 + ((seed % 17) - 8) * 0.016;
      const radiusX = count <= 1 ? 0 : Math.min(312, 180 + count * 18);
      const radiusY = count <= 1 ? 0 : Math.min(236, 132 + count * 14);
      const jitterX = Math.sin(seed * 0.013) * 26;
      const jitterY = Math.cos(seed * 0.017) * 22;
      const baseX = centerX + Math.cos(angle) * radiusX + jitterX;
      const baseY = centerY + Math.sin(angle) * radiusY + jitterY;
      return {
        id: group.id,
        articleTitle: group.articleTitle,
        articleId: group.articleId,
        cards: group.cards,
        x: clamp(baseX, GRAPH_MARGIN, GRAPH_WIDTH - GRAPH_MARGIN),
        y: clamp(baseY, GRAPH_MARGIN, GRAPH_HEIGHT - GRAPH_MARGIN)
      };
    });

    const articleMap = new Map(articles.map(article => [article.id, article]));
    const articleSignals = new Map(articles.map(article => [article.id, buildArticleSignalSet(article.articleTitle, article.cards)]));
    const baseCards = writeGraphView === 'activated' && selectedCards.length > 0 ? selectedCards : visibleCards;
    const cardsByArticleNodeId = new Map<string, AtomCard[]>();
    baseCards.forEach(card => {
      const articleNodeId = getArticleNodeId(card);
      if (!articleMap.has(articleNodeId)) return;
      const bucket = cardsByArticleNodeId.get(articleNodeId);
      if (bucket) {
        bucket.push(card);
        return;
      }
      cardsByArticleNodeId.set(articleNodeId, [card]);
    });

    const cards: GraphCardNode[] = [];
    cardsByArticleNodeId.forEach((articleCards, articleNodeId) => {
      const article = articleMap.get(articleNodeId);
      if (!article) return;
      articleCards.forEach((card, localIndex) => {
        const seed = getIdSeed(card.id);
        const orbitRadius = NODE_ORBIT_RADIUS + Math.min(articleCards.length * 3, 16) + ((seed % 11) - 5);
        const orbitAngle = (Math.PI * 2 * localIndex) / Math.max(articleCards.length, 1) - Math.PI / 2 + ((seed % 17) - 8) * 0.055;
        const baseX = article.x + Math.cos(orbitAngle) * orbitRadius;
        const baseY = article.y + Math.sin(orbitAngle) * orbitRadius;
        cards.push({
          id: card.id,
          card,
          articleNodeId,
          x: clamp(baseX, 30, GRAPH_WIDTH - 30),
          y: clamp(baseY, 30, GRAPH_HEIGHT - 30),
          orbitAngle,
          orbitRadius
        });
      });
    });

    const links: GraphLink[] = [];
    const cardSignals = new Map(cards.map(card => [card.id, buildCardSignalSet(card.card)]));
    cards.forEach(card => {
      links.push({
        id: `parent-${card.articleNodeId}-${card.id}`,
        sourceId: card.articleNodeId,
        targetId: card.id,
        kind: 'parent'
      });
    });

    const semanticCandidates: GraphLink[] = [];
    for (let i = 0; i < cards.length; i += 1) {
      for (let j = i + 1; j < cards.length; j += 1) {
        if (cards[i].articleNodeId === cards[j].articleNodeId) continue;
        const leftSignals = cardSignals.get(cards[i].id);
        const rightSignals = cardSignals.get(cards[j].id);
        if (!leftSignals || !rightSignals) continue;
        const match = getSignalMatch(leftSignals, rightSignals);
        if (match.score >= 2.2 && (match.tags.length > 0 || match.phrases.length >= 2)) {
          semanticCandidates.push({
            id: `semantic-${cards[i].id}-${cards[j].id}`,
            sourceId: cards[i].id,
            targetId: cards[j].id,
            kind: 'semantic',
            strength: match.score
          });
        }
      }
    }
    links.push(...selectSparseLinks(semanticCandidates, 2));

    const articleCandidates: GraphLink[] = [];
    for (let i = 0; i < articles.length; i += 1) {
      for (let j = i + 1; j < articles.length; j += 1) {
        const leftSignals = articleSignals.get(articles[i].id);
        const rightSignals = articleSignals.get(articles[j].id);
        if (!leftSignals || !rightSignals) continue;
        const match = getSignalMatch(leftSignals, rightSignals);
        if (match.score >= 2.4 && (match.tags.length > 0 || match.phrases.length >= 2)) {
          articleCandidates.push({
            id: `article-${articles[i].id}-${articles[j].id}`,
            sourceId: articles[i].id,
            targetId: articles[j].id,
            kind: 'article',
            strength: match.score
          });
        }
      }
    }
    links.push(...selectSparseLinks(articleCandidates, 2));

    return { articles, cards, links };
  }, [articleGroups, selectedCardIds, selectedCards, visibleCards, writeGraphView]);

  useEffect(() => {
    const nextNodes: SimNode[] = [
      ...graph.articles.map(article => {
        const existing = simulationNodesRef.current.find(node => node.id === article.id);
        return {
          id: article.id,
          kind: 'article' as const,
          x: existing?.x ?? article.x,
          y: existing?.y ?? article.y,
          vx: existing?.vx ?? 0,
          vy: existing?.vy ?? 0,
          anchorX: article.x,
          anchorY: article.y,
          radius: 18
        };
      }),
      ...graph.cards.map(card => {
        const existing = simulationNodesRef.current.find(node => node.id === card.id);
        return {
          id: card.id,
          kind: 'card' as const,
          articleNodeId: card.articleNodeId,
          x: existing?.x ?? card.x,
          y: existing?.y ?? card.y,
          vx: existing?.vx ?? 0,
          vy: existing?.vy ?? 0,
          anchorX: card.x,
          anchorY: card.y,
          radius: 7,
          orbitAngle: existing?.orbitAngle ?? card.orbitAngle,
          orbitRadius: existing?.orbitRadius ?? card.orbitRadius
        };
      })
    ];

    simulationNodesRef.current = nextNodes;
    simulationHeatRef.current = Math.max(simulationHeatRef.current, 0.55);
    lastStepAtRef.current = null;
    setGraphPositions(Object.fromEntries(nextNodes.map(node => [node.id, { x: node.x, y: node.y }])));
  }, [graph]);

  useEffect(() => {
    const step = (timestamp: number) => {
      const nodes = simulationNodesRef.current;
      if (!nodes.length) {
        lastStepAtRef.current = timestamp;
        simulationFrameRef.current = window.requestAnimationFrame(step);
        return;
      }

      const previousStepAt = lastStepAtRef.current ?? timestamp;
      const elapsed = Math.min(32, timestamp - previousStepAt || 16.667);
      const frame = Math.max(0.85, elapsed / 16.667);
      lastStepAtRef.current = timestamp;

      const nodeMap = new Map(nodes.map(node => [node.id, node]));
      const dragState = dragStateRef.current;
      const draggedId = dragState?.nodeId || null;
      const currentHeat = simulationHeatRef.current;
      let totalVelocity = 0;
      const applyForce = (node: SimNode, fx: number, fy: number) => {
        if (node.id === draggedId) return;
        node.vx += fx;
        node.vy += fy;
      };

      for (let i = 0; i < nodes.length; i += 1) {
        for (let j = i + 1; j < nodes.length; j += 1) {
          const a = nodes[i];
          const b = nodes[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const distance = Math.hypot(dx, dy) || 0.001;
          const nx = dx / distance;
          const ny = dy / distance;
          const chargeRange = (a.kind === 'article' || b.kind === 'article' ? 290 : 228) + currentHeat * 90;
          if (distance < chargeRange) {
            const chargeStrength = ((a.kind === 'article' || b.kind === 'article' ? 250 : 150) * (0.42 + currentHeat * 0.9)) / (distance * distance + 2200);
            applyForce(a, -nx * chargeStrength * frame, -ny * chargeStrength * frame);
            applyForce(b, nx * chargeStrength * frame, ny * chargeStrength * frame);
          }

          const minDistance = a.radius + b.radius + (a.kind === 'article' || b.kind === 'article' ? 18 : 10);
          if (distance < minDistance) {
            const overlap = (minDistance - distance) / minDistance;
            const separationStrength = overlap * (a.kind === 'article' || b.kind === 'article' ? 0.72 : 0.5) * frame;
            applyForce(a, -nx * separationStrength, -ny * separationStrength);
            applyForce(b, nx * separationStrength, ny * separationStrength);
          }
        }
      }

      graph.links.forEach(link => {
        const source = nodeMap.get(link.sourceId);
        const target = nodeMap.get(link.targetId);
        if (!source || !target) return;
        const dx = target.x - source.x;
        const dy = target.y - source.y;
        const distance = Math.hypot(dx, dy) || 0.001;
        const desiredDistance = link.kind === 'parent'
          ? target.orbitRadius ?? NODE_ORBIT_RADIUS
          : link.kind === 'article'
            ? 220 - Math.min(link.strength || 1, 4) * 12
            : 148 - Math.min(link.strength || 1, 4) * 10;
        const delta = distance - desiredDistance;
        const nx = dx / distance;
        const ny = dy / distance;
        const stiffness = link.kind === 'parent' ? 0.0105 : link.kind === 'article' ? 0.0048 : 0.0085;
        const force = delta * stiffness * frame;
        applyForce(source, nx * force, ny * force);
        applyForce(target, -nx * force, -ny * force);
      });

      nodes.forEach(node => {
        const isDragged = draggedId === node.id;
        if (!isDragged) {
          if (node.kind === 'article') {
            const anchorPull = (0.004 + currentHeat * 0.004) * frame;
            applyForce(node, (node.anchorX - node.x) * anchorPull, (node.anchorY - node.y) * anchorPull);
          } else if (node.articleNodeId) {
            const parent = nodeMap.get(node.articleNodeId);
            if (parent) {
              const targetX = parent.x + Math.cos(node.orbitAngle ?? -Math.PI / 2) * (node.orbitRadius ?? NODE_ORBIT_RADIUS);
              const targetY = parent.y + Math.sin(node.orbitAngle ?? -Math.PI / 2) * (node.orbitRadius ?? NODE_ORBIT_RADIUS);
              const orbitPull = (0.012 + currentHeat * 0.005) * frame;
              applyForce(node, (targetX - node.x) * orbitPull, (targetY - node.y) * orbitPull);
            } else {
              const fallbackPull = 0.01 * frame;
              applyForce(node, (node.anchorX - node.x) * fallbackPull, (node.anchorY - node.y) * fallbackPull);
            }
          }
        }

        const damping = node.kind === 'article'
          ? 0.86 + currentHeat * 0.08
          : 0.84 + currentHeat * 0.1;
        const velocityDecay = Math.pow(Math.min(damping, 0.97), frame);
        node.vx *= velocityDecay;
        node.vy *= velocityDecay;

        if (!isDragged) {
          node.x += node.vx * frame;
          node.y += node.vy * frame;

          if (node.x < 24) {
            node.x = 24;
            node.vx *= -0.18;
          } else if (node.x > GRAPH_WIDTH - 24) {
            node.x = GRAPH_WIDTH - 24;
            node.vx *= -0.18;
          }

          if (node.y < 24) {
            node.y = 24;
            node.vy *= -0.18;
          } else if (node.y > GRAPH_HEIGHT - 24) {
            node.y = GRAPH_HEIGHT - 24;
            node.vy *= -0.18;
          }
        }

        totalVelocity += Math.hypot(node.vx, node.vy);
      });

      simulationHeatRef.current = dragState
        ? 1
        : clamp(currentHeat * 0.962 + Math.min(0.085, totalVelocity / Math.max(nodes.length * 18, 1)), 0.03, 1);

      setGraphPositions(Object.fromEntries(nodes.map(node => [node.id, { x: node.x, y: node.y }])));
      simulationFrameRef.current = window.requestAnimationFrame(step);
    };

    lastStepAtRef.current = null;
    simulationFrameRef.current = window.requestAnimationFrame(step);
    return () => {
      if (simulationFrameRef.current) window.cancelAnimationFrame(simulationFrameRef.current);
      lastStepAtRef.current = null;
    };
  }, [graph.links]);

  useEffect(() => {
    setSelectedCardIds(prev => prev.filter(id => visibleCards.some(card => card.id === id)));
  }, [visibleCards]);

  const relatedNodeIds = useMemo(() => {
    const activeId = hoveredNodeId || focusedNodeId;
    const activatedSet = new Set(writeActivatedNodeIds);
    if (!activeId) return activatedSet;
    const ids = new Set<string>([...activatedSet, activeId]);
    graph.links.forEach(link => {
      if (link.sourceId === activeId || link.targetId === activeId) {
        ids.add(link.sourceId);
        ids.add(link.targetId);
      }
    });
    return ids;
  }, [focusedNodeId, graph.links, hoveredNodeId, writeActivatedNodeIds]);

  const focusedCard = useMemo(() => visibleCards.find(card => card.id === focusedNodeId) || null, [focusedNodeId, visibleCards]);
  const focusedArticle = useMemo(() => graph.articles.find(article => article.id === focusedNodeId) || null, [focusedNodeId, graph.articles]);
  const focusedSavedArticle = useMemo<SavedArticle | null>(() => {
    if (focusedCard?.articleId) {
      const matched = savedArticles.find(article => article.id === focusedCard.articleId);
      if (matched) return matched;
    }
    if (focusedArticle?.articleId) {
      const matched = savedArticles.find(article => article.id === focusedArticle.articleId);
      if (matched) return matched;
    }
    return null;
  }, [focusedArticle, focusedCard, savedArticles]);

  const articleCardsForDetail = useMemo(() => {
    if (focusedArticle) return focusedArticle.cards;
    if (focusedCard) {
      return visibleCards.filter(card => getArticleNodeId(card) === getArticleNodeId(focusedCard));
    }
    return [];
  }, [focusedArticle, focusedCard, visibleCards]);
  const relatedArticlesForCard = useMemo<RelatedArticleSummary[]>(() => {
    if (!focusedCard) return [];
    const counts = new Map<string, RelatedArticleSummary>();
    visibleCards.forEach(card => {
      if (card.id === focusedCard.id) return;
      const sharedTags = card.tags.filter(tag => focusedCard.tags.includes(tag));
      if (sharedTags.length === 0) return;
      const key = getArticleNodeId(card);
      const existing = counts.get(key);
      if (existing) {
        existing.count += sharedTags.length;
        return;
      }
      counts.set(key, {
        articleId: card.articleId,
        articleTitle: card.articleTitle || '未命名文章',
        count: sharedTags.length
      });
    });
    return Array.from(counts.values()).sort((a, b) => b.count - a.count).slice(0, 3);
  }, [focusedCard, visibleCards]);

  const backgroundDrawerTitle = focusedCard
    ? focusedSavedArticle?.title || focusedCard.articleTitle || '未命名文章'
    : focusedSavedArticle?.title || focusedArticle?.articleTitle || '未命名文章';
  const backgroundDrawerContext = focusedCard
    ? focusedSavedArticle?.citationContext || focusedCard.sourceContext || focusedCard.context
    : focusedSavedArticle?.citationContext;

  const recentNotes = useMemo(() => notes.slice(0, 6), [notes]);
  const activatedCards = useMemo(() => {
    const activatedSet = new Set(writeActivatedNodeIds);
    return visibleCards.filter(card => activatedSet.has(card.id));
  }, [visibleCards, writeActivatedNodeIds]);
  const buildSourceArticles = (cards: AtomCard[]): NoteSourceReference[] => {
    const byKey = new Map<string, NoteSourceReference>();
    cards.forEach(card => {
      const savedArticle = card.savedArticleId
        ? savedArticles.find(item => item.id === card.savedArticleId)
        : card.articleId
          ? savedArticles.find(item => item.id === card.articleId)
          : savedArticles.find(item => item.title === card.articleTitle);
      const key = savedArticle
        ? `saved-${savedArticle.id}`
        : `article-${card.articleId ?? card.articleTitle}`;
      if (byKey.has(key)) return;
      byKey.set(key, {
        savedArticleId: savedArticle?.id,
        articleId: card.articleId,
        title: savedArticle?.title || card.articleTitle || '未命名文章',
        source: savedArticle?.source || '知识库文章',
        url: savedArticle?.url,
        excerpt: savedArticle?.excerpt || card.sourceContext || card.context || card.content.slice(0, 140),
        citationContext: savedArticle?.citationContext || card.sourceContext,
        savedAt: savedArticle?.savedAt
      });
    });
    return Array.from(byKey.values());
  };
  const activatedSourceArticles = useMemo<NoteSourceReference[]>(() => buildSourceArticles(activatedCards), [activatedCards, savedArticles]);
	  useEffect(() => {
	    const ensureThread = async () => {
	      const threads = await loadAssistantThreads('chat');
	      if (!assistantThreadId && threads[0]?.id) {
	        const threadId = Number(threads[0].id);
	        setAssistantThreadId(threadId);
	        await hydrateThreadMessages(threadId);
	      }
	    };
	    void ensureThread();
	  }, [assistantThreadId, hydrateThreadMessages, loadAssistantThreads, setAssistantThreadId]);

	  useEffect(() => {
	    if (!assistantThreadId) return;
	    void hydrateThreadMessages(assistantThreadId);
	  }, [assistantThreadId, hydrateThreadMessages]);

  useEffect(() => {
    if (writeActivatedNodeIds.length === 0 && writeGraphView === 'activated') {
      setWriteGraphView('all');
    }
  }, [setWriteGraphView, writeActivatedNodeIds.length, writeGraphView]);

  const resetComposition = () => {
    setSelectedCardIds([]);
    setFocusedNodeId(null);
    setHoveredNodeId(null);
    simulationNodesRef.current = [];
    setGraphPositions({});
  };

  const handleRecall = async (promptOverride?: string): Promise<AtomCard[]> => {
    const prompt = (promptOverride ?? writeFocusedTopic).trim();
    if (!prompt) return [];

    setWriteFocusedTopic(prompt);
    setIsRecalling(true);
    let recalledCards: AtomCard[] = [];

    try {
      const res = await fetch('/api/write/recall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: prompt })
      });
      if (res.ok) {
        const data = await res.json();
        const cards: AtomCard[] = data.cards || [];
        recalledCards = cards;
        const nextIds = cards.map(card => card.id);
        setSelectedCardIds(nextIds);
        setWriteActivatedNodeIds(nextIds);
        setWriteActivationSummary(buildActivationSummary(cards));
        showToast(`已聚焦 ${cards.length} 张相关卡片`);
      } else {
        showToast('聚焦失败，请稍后重试');
      }
    } catch {
      showToast('网络错误');
    }

    setIsRecalling(false);
    return recalledCards;
  };

  const applyActivation = (cards: AtomCard[], prompt: string) => {
    const nextIds = cards.map(card => card.id);
    setSelectedCardIds(prev => Array.from(new Set([...prev, ...nextIds])));
    setWriteActivatedNodeIds(nextIds);
    setWriteActivationSummary(buildActivationSummary(cards));
    setWriteFocusedTopic(prompt);
  };

  const toggleCardSelection = (card: AtomCard) => {
    setSelectedCardIds(prev => {
      if (prev.includes(card.id)) {
        const next = prev.filter(id => id !== card.id);
        setWriteActivatedNodeIds(next);
        return next;
      }
      const next = [...prev, card.id];
      setWriteActivatedNodeIds(next);
      return next;
    });
    setFocusedNodeId(card.id);
  };

  const setAgentRunState = (next: AgentRunState | null | ((prev: AgentRunState | null) => AgentRunState | null)) => {
    const resolved = typeof next === 'function' ? (next as (value: AgentRunState | null) => AgentRunState | null)(agentRunRef.current) : next;
    agentRunRef.current = resolved;
    setAgentRun(resolved);
  };

  const upsertAgentRunStep = (node: string, patch: Partial<AgentRunStep>) => {
    setAgentRunState(prev => {
      if (!prev) return prev;
      const label = patch.label || node;
      const existing = prev.steps.find(step => step.node === node);
      const steps = existing
        ? prev.steps.map(step => step.node === node ? { ...step, ...patch, label } : step)
        : [...prev.steps, { node, label, status: patch.status || 'running', ...patch }];
      return { ...prev, steps };
    });
  };

  const appendAssistantResult = async (data: any) => {
    if (data.threadId) {
      const nextThreadId = Number(data.threadId);
      setAssistantThreadId(nextThreadId);
    }
    if (data.assistant?.content || data.assistantMessage) {
      const completedRun = agentRunRef.current
        ? {
          ...agentRunRef.current,
          status: 'done' as const,
          collapsed: true,
          message: `已完成思考 · ${agentRunRef.current.steps.filter(step => step.status === 'done').length} 步`
        }
        : undefined;
      setAssistantMessages(prev => [...prev, {
        id: data.messageId || data.toolResult?.messageId || `assistant-${Date.now()}`,
        role: 'assistant' as const,
        content: data.assistant?.content || data.assistantMessage,
        meta: {
          ...(data.toolResult || {}),
          uiBlocks: data.uiBlocks,
          sources: data.sources,
          choices: data.choices,
          graphTrace: data.graphTrace,
          messageId: data.messageId || data.toolResult?.messageId,
          feedback: 'none',
          sourceCollapsed: true,
          run: completedRun
        }
      }]);
    }
    if (data.threadState) {
      applyThreadState(data.threadState);
    }
    if (data.note?.id) {
      window.localStorage.setItem('atomflow:open-note-id', String(data.note.id));
      await reloadNotes();
      setWriteWorkspaceMode('articles');
      window.dispatchEvent(new Event('atomflow:open-note'));
      showToast(`已创建文章《${data.note.title || '未命名文章'}》`);
    }
    void loadAssistantThreads('chat');
  };

  const readAgentStream = async (response: Response) => {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('浏览器不支持流式响应');
    const decoder = new TextDecoder();
    let buffer = '';
    let finalPayload: any = null;

    const handleEvent = async (raw: string) => {
      const eventLine = raw.split('\n').find(line => line.startsWith('event:'));
      const dataLines = raw.split('\n').filter(line => line.startsWith('data:'));
      if (!eventLine || dataLines.length === 0) return;
      const event = eventLine.replace(/^event:\s*/, '').trim();
      const payloadText = dataLines.map(line => line.replace(/^data:\s*/, '')).join('\n');
      const payload = payloadText ? JSON.parse(payloadText) : {};

      if (event === 'partial_status') {
        setAgentRunState(prev => prev ? { ...prev, message: payload.message || prev.message } : prev);
        return;
      }
      if (event === 'step_start') {
        upsertAgentRunStep(payload.node || 'agent', {
          label: getAgentStepCopy(payload.node || 'agent'),
          status: 'running'
        });
        return;
      }
      if (event === 'step_end') {
        upsertAgentRunStep(payload.node || 'agent', {
          label: getAgentStepCopy(payload.node || 'agent'),
          status: 'done',
          durationMs: payload.durationMs
        });
        return;
      }
      if (event === 'activation') {
        const ids = Array.isArray(payload.activatedNodeIds) ? payload.activatedNodeIds.filter((id: unknown): id is string => typeof id === 'string') : [];
        const summary = Array.isArray(payload.activationSummary) ? payload.activationSummary.filter((item: unknown): item is string => typeof item === 'string') : [];
        if (ids.length > 0) {
          setSelectedCardIds(ids);
          setWriteActivatedNodeIds(ids);
        }
        if (summary.length > 0) {
          setWriteActivationSummary(summary);
        }
        return;
      }
      if (event === 'final') {
        finalPayload = payload;
        return;
      }
      if (event === 'error') {
        throw new Error(payload.message || '写作助手暂时不可用');
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';
      for (const part of parts) {
        await handleEvent(part);
      }
    }
    if (buffer.trim()) {
      await handleEvent(buffer);
    }
    if (!finalPayload) throw new Error('Agent 没有返回最终结果');
    return finalPayload;
  };

  const submitAgentMessage = async (input: {
    message: string;
    action?: 'create_article';
    focusedTopic?: string;
    cards?: AtomCard[];
    appendUserMessage?: boolean;
  }) => {
    const prompt = input.message.trim();
    if (!prompt) return;
    if (!user) {
      loginAndDo(() => {
        void submitAgentMessage(input);
      });
      return;
    }

    const cardsToUse = input.cards || [];
    const activatedIds = cardsToUse.length > 0
      ? cardsToUse.map(card => card.id)
      : writeActivatedNodeIds.length > 0
        ? writeActivatedNodeIds
        : selectedCardIds;
    const activationSummary = cardsToUse.length > 0
      ? buildActivationSummary(cardsToUse)
      : writeActivationSummary;

    if (input.appendUserMessage !== false) {
      setAssistantMessages(prev => [...prev, { id: `user-${Date.now()}`, role: 'user' as const, content: prompt }]);
    }
    setAssistantInput('');
    setAgentRunState({
      id: `run-${Date.now()}`,
      status: 'running',
      collapsed: true,
      steps: [],
      message: '正在思考'
    });
    setIsAssistantThinking(true);
    try {
      const response = await fetch('/api/write/agent/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threadId: assistantThreadId,
          message: prompt,
          focusedTopic: input.focusedTopic || writeFocusedTopic || undefined,
          activatedNodeIds: activatedIds.length > 0 ? activatedIds : undefined,
	          activationSummary: activationSummary.length > 0 ? activationSummary : undefined,
	          selectedStyleSkillId,
	          selectedSkillIds,
	          selectedCardIds: activatedIds.length > 0 ? activatedIds : undefined,
	          action: input.action
        })
      });

      if (!response.ok) {
        const errorMessage = await getErrorMessageFromResponse(
          response,
          response.status === 401 ? '请先登录后再使用写作助手' : '助手暂时不可用，请稍后再试'
        );
        showToast(errorMessage);
        return;
      }

      const data = await readAgentStream(response);
      await appendAssistantResult(data);
      setAgentRunState(null);
    } catch (error) {
      setAgentRunState(prev => prev ? { ...prev, status: 'error', collapsed: true, message: error instanceof Error ? error.message : '思考中断' } : prev);
      showToast(error instanceof Error && error.message ? error.message : '网络错误');
    } finally {
      setIsAssistantThinking(false);
    }
  };

  const handleAssistantSend = async (promptText?: string) => {
    await submitAgentMessage({ message: (promptText ?? assistantInput).trim() });
  };

  const handleGenerateDraft = async (cardOverride?: AtomCard[]) => {
    if (!user) {
      loginAndDo(() => {
        void handleGenerateDraft();
      });
      return;
    }
    setIsGeneratingDraft(true);
    try {
      const topicInput = writeFocusedTopic.trim() || assistantInput.trim();
      let cardsToUse = cardOverride && cardOverride.length > 0 ? cardOverride : activatedCards;

      if (cardsToUse.length === 0 && topicInput) {
        const recalledCards = await handleRecall(topicInput);
        const keywords = topicInput.toLowerCase().split(/[\s，。,.!?！？、]+/).filter(Boolean);
        const localMatched = visibleCards.filter(card => {
          const text = `${card.content} ${card.summary || ''} ${card.sourceContext || ''} ${card.context || ''} ${card.originalQuote || ''} ${card.citationNote || ''} ${(card.tags || []).join(' ')} ${card.articleTitle || ''}`.toLowerCase();
          return keywords.some(keyword => text.includes(keyword));
        }).slice(0, 10);
        cardsToUse = recalledCards.length > 0 ? recalledCards : localMatched;
        if (cardsToUse.length > 0) {
          setSelectedCardIds(cardsToUse.map(card => card.id));
          setWriteActivatedNodeIds(cardsToUse.map(card => card.id));
          setWriteActivationSummary(buildActivationSummary(cardsToUse));
        }
      }

      if (cardsToUse.length === 0) {
        showToast('先激活一些节点，或先输入主题让我帮你召回');
        return;
      }

      const derivedTopic = (() => {
        if (topicInput) return topicInput;
        const tagCounts = new Map<string, number>();
        cardsToUse.forEach(card => {
          (card.tags || []).forEach(tag => {
            tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
          });
        });
        const topTag = Array.from(tagCounts.entries()).sort((left, right) => right[1] - left[1])[0]?.[0];
        return topTag || cardsToUse[0]?.articleTitle || '激活网络草稿';
      })();
      await submitAgentMessage({
        message: derivedTopic,
        focusedTopic: derivedTopic,
        cards: cardsToUse,
        action: 'create_article'
      });
    } catch (error) {
      showToast(error instanceof Error && error.message ? error.message : '网络错误，生成失败');
    } finally {
      setIsGeneratingDraft(false);
    }
  };

  const positionMap = useMemo(() => new Map(Object.entries(graphPositions)), [graphPositions]);
  const zoomLabel = `${Math.round(zoom * 100)}%`;

  const getGraphPoint = (event: React.PointerEvent<Element>) => {
    const svg = graphSvgRef.current;
    if (!svg) return { x: event.clientX, y: event.clientY };
    const matrix = svg.getScreenCTM();
    if (!matrix) return { x: event.clientX, y: event.clientY };
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const transformed = point.matrixTransform(matrix.inverse());
    return { x: transformed.x, y: transformed.y };
  };

  const beginNodeDrag = (event: React.PointerEvent<Element>, nodeId: string, kind: 'article' | 'card') => {
    const position = positionMap.get(nodeId);
    if (!position) return;
    const pointer = getGraphPoint(event);
    const node = simulationNodesRef.current.find(item => item.id === nodeId);
    if (!node) return;
    suppressClickRef.current = null;
    dragStateRef.current = {
      nodeId,
      kind,
      pointerId: event.pointerId,
      offsetX: pointer.x - position.x,
      offsetY: pointer.y - position.y,
      lastX: position.x,
      lastY: position.y,
      lastMoveAt: performance.now(),
      travel: 0,
      moved: false
    };
    setDraggedNodeId(nodeId);
    setHoveredNodeId(null);
    setHoverTooltip(null);
    node.vx = 0;
    node.vy = 0;
    simulationHeatRef.current = 1;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveNodeDrag = (event: React.PointerEvent<Element>, nodeId: string) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.nodeId !== nodeId) return;
    const node = simulationNodesRef.current.find(item => item.id === nodeId);
    if (!node) return;
    const pointer = getGraphPoint(event);
    const nextX = clamp(pointer.x - dragState.offsetX, 24, GRAPH_WIDTH - 24);
    const nextY = clamp(pointer.y - dragState.offsetY, 24, GRAPH_HEIGHT - 24);
    const now = performance.now();
    const dt = Math.max(12, now - dragState.lastMoveAt);
    const dx = nextX - dragState.lastX;
    const dy = nextY - dragState.lastY;
    dragState.travel += Math.hypot(dx, dy);
    dragState.moved = dragState.travel > 6;
    node.x = nextX;
    node.y = nextY;
    node.vx = dx / dt * 18;
    node.vy = dy / dt * 18;
    if (node.kind === 'article') {
      node.anchorX = nextX;
      node.anchorY = nextY;
    } else if (node.articleNodeId) {
      const parent = simulationNodesRef.current.find(item => item.id === node.articleNodeId);
      if (parent) {
        node.orbitAngle = Math.atan2(nextY - parent.y, nextX - parent.x);
        node.orbitRadius = clamp(Math.hypot(nextX - parent.x, nextY - parent.y), 52, 146);
      }
    }
    dragState.lastX = nextX;
    dragState.lastY = nextY;
    dragState.lastMoveAt = now;
    simulationHeatRef.current = 1;
    setGraphPositions(prev => ({ ...prev, [nodeId]: { x: nextX, y: nextY } }));
  };

  const endNodeDrag = (event: React.PointerEvent<Element>) => {
    const dragState = dragStateRef.current;
    if (dragState) {
      if (event.currentTarget.hasPointerCapture(dragState.pointerId)) {
        event.currentTarget.releasePointerCapture(dragState.pointerId);
      }
      if (dragState.moved) {
        suppressClickRef.current = dragState.nodeId;
      }
      simulationHeatRef.current = 0.88;
      dragStateRef.current = null;
      setDraggedNodeId(null);
    }
  };

  const updateHoverTooltip = (event: React.MouseEvent<SVGGElement> | React.PointerEvent<SVGGElement>, text: string, tone: 'sun' | 'atom' | 'atom-warm') => {
    if (dragStateRef.current) return;
    const containerRect = graphCanvasRef.current?.getBoundingClientRect();
    if (!containerRect) return;
    setHoverTooltip({
      x: event.clientX - containerRect.left,
      y: event.clientY - containerRect.top,
      text,
      tone
    });
  };

  const shouldSuppressClick = (nodeId: string) => {
    if (!suppressClickRef.current) return false;
    const matched = suppressClickRef.current === nodeId;
    suppressClickRef.current = null;
    return matched;
  };

  const getProxiedImageUrl = (url: string) => `/api/image-proxy?url=${encodeURIComponent(url)}`;

  const handleAgentChoice = (choice: WriteAgentChoice, sources?: WriteAgentSources) => {
    const cardIds = Array.isArray(choice.payload?.cardIds)
      ? choice.payload.cardIds.filter((id): id is string => typeof id === 'string')
      : [];

    if (choice.action === 'export_to_draft') {
      const rawContent = choice.payload?.content as string || '';

      const { title, content } = prepareAgentDraftForNote(rawContent);

      void createNote({ title, content, tags: [] });
      showToast(`已导出: ${title}`);
      setWriteWorkspaceMode('articles');
      return;
    }

    if (choice.action === 'switch_style') {
      const styleSkillId = choice.payload?.styleSkillId;
      if (styleSkillId) {
        setSelectedStyleSkillId(styleSkillId as string | number);
        const styleSkill = styleSkills.find(skill => String(skill.id) === String(styleSkillId));
        showToast(styleSkill ? `已切换到「${styleSkill.name}」风格` : '已切换写作风格');
      }
      return;
    }

    if (choice.action === 'smart_reply') {
      const context = choice.payload?.context as string || assistantInput || '';
      void submitAgentMessage({ message: context || '继续' });
      return;
    }

    if (choice.action === 'use_cards') {
      const cards = (sources?.cards || []).filter(card => cardIds.includes(card.id));
      setSelectedCardIds(cardIds);
      setWriteActivatedNodeIds(cardIds);
      setWriteActivationSummary(buildActivationSummary(cards));
      showToast(`已选中 ${cardIds.length} 张卡片`);
      return;
    }
    if (choice.action === 'refresh_cards') {
      void handleRecall(writeFocusedTopic || assistantInput || '换一组素材');
      return;
    }
    if (choice.action === 'generate_outline') {
      const cards = (sources?.cards || []).filter(card => cardIds.includes(card.id));
      setSelectedCardIds(cardIds);
      setWriteActivatedNodeIds(cardIds);
      setWriteActivationSummary(buildActivationSummary(cards));
      void submitAgentMessage({
        message: `基于已选 ${cardIds.length} 张卡片生成提纲`,
        cards
      });
      return;
    }
    if (choice.action === 'generate_draft') {
      const cards = (sources?.cards || []).filter(card => cardIds.includes(card.id));
      setSelectedCardIds(cardIds);
      setWriteActivatedNodeIds(cardIds);
      void handleGenerateDraft(cards);
      return;
    }
    if (choice.action === 'select_style' && choice.payload?.styleSkillId) {
      setSelectedStyleSkillId(choice.payload.styleSkillId as string | number);
    }
  };

  const updateAssistantMessageMeta = (messageId: number | string, patch: Partial<NonNullable<AssistantMessage['meta']>>) => {
    setAssistantMessages(prev => prev.map(message => (
      message.id === messageId
        ? { ...message, meta: { ...(message.meta || {}), ...patch } }
        : message
    )));
  };

  const handleCopyAssistantMessage = async (message: AssistantMessage) => {
    try {
      await navigator.clipboard.writeText(message.content);
      showToast('已复制回答');
    } catch {
      showToast('复制失败');
    }
  };

  const handleSpeakAssistantMessage = (message: AssistantMessage) => {
    if (!('speechSynthesis' in window)) {
      showToast('当前浏览器不支持朗读');
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(message.content.replace(/[#*_>`\[\]]/g, ''));
    utterance.lang = 'zh-CN';
    window.speechSynthesis.speak(utterance);
  };

  const handleAssistantFeedback = async (message: AssistantMessage, nextFeedback: Exclude<AssistantFeedback, 'none'>) => {
    const current = message.meta?.feedback || 'none';
    const feedback: AssistantFeedback = current === nextFeedback ? 'none' : nextFeedback;
    updateAssistantMessageMeta(message.id, { feedback });
    const persistedMessageId = message.meta?.messageId || message.id;
    if (String(persistedMessageId).startsWith('assistant-')) return;
    try {
      const response = await fetch(`/api/write/agent/messages/${persistedMessageId}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback })
      });
      if (!response.ok) throw new Error('feedback failed');
    } catch {
      showToast('反馈暂未保存，但本地状态已记录');
    }
  };

  const handleRegenerateAssistantMessage = (message: AssistantMessage) => {
    const index = assistantMessages.findIndex(item => item.id === message.id);
    const previousUserMessage = assistantMessages.slice(0, index).reverse().find(item => item.role === 'user');
    const prompt = previousUserMessage?.content?.trim();
    if (!prompt) {
      showToast('没有找到可重新生成的上一条问题');
      return;
    }
    void submitAgentMessage({ message: prompt, appendUserMessage: false });
  };

  const getAssistantChoiceLabel = (choice: WriteAgentChoice, index: number) => {
    if (choice.action === 'export_to_draft') return '导出文章到草稿';
    if (choice.action === 'switch_style') {
      const styleSkill = styleSkills.find(skill => String(skill.id) === String(choice.payload?.styleSkillId));
      return styleSkill ? `切换到「${styleSkill.name}」风格` : '切换写作风格';
    }
    if (choice.action === 'smart_reply') return choice.label || '继续深入探讨';
    if (choice.action === 'use_cards') return '使用本轮找到的素材';
    if (choice.action === 'refresh_cards') return '换一组更贴近问题的素材';
    if (choice.action === 'generate_outline') return '先生成一版文章提纲';
    if (choice.action === 'generate_draft') {
      const styleSkill = styleSkills.find(skill => String(skill.id) === String(choice.payload?.styleSkillId))
        || styleSkills.find(skill => String(skill.id) === String(selectedStyleSkillId));
      return styleSkill ? `用「${styleSkill.name}」风格改写` : '用当前风格改写';
    }
    if (choice.action === 'select_style') return '切换写作风格';
    return choice.label || `继续推进 ${index + 1}`;
  };

  const getAssistantDisplayChoices = (choices: WriteAgentChoice[], sources?: WriteAgentSources) => {
    const result: WriteAgentChoice[] = [];

    // Button 1: Export to draft (导出文章到草稿)
    const lastAssistantMessage = assistantMessages.filter(m => m.role === 'assistant').slice(-1)[0];
    if (lastAssistantMessage?.content && lastAssistantMessage.content.length > 50) {
      result.push({
        id: 'export-to-draft',
        action: 'export_to_draft',
        label: '导出文章到草稿',
        payload: { messageId: lastAssistantMessage.id, content: lastAssistantMessage.content }
      });
    }

    // Button 2: Switch writing style (切换写作风格)
    const currentStyleSkill = styleSkills.find(skill => String(skill.id) === String(selectedStyleSkillId)) || styleSkills[0];
    const otherStyleSkills = styleSkills.filter(skill => String(skill.id) !== String(selectedStyleSkillId));
    const nextStyleSkill = otherStyleSkills[0] || styleSkills[1] || styleSkills[0];

    if (nextStyleSkill) {
      result.push({
        id: `switch-style-${nextStyleSkill.id}`,
        action: 'switch_style',
        label: nextStyleSkill ? `切换到「${nextStyleSkill.name}」风格` : '切换写作风格',
        payload: { styleSkillId: nextStyleSkill.id }
      });
    }

    // Button 3: Smart context-aware reply (智能推荐回复)
    // Extract smart reply from AI-generated choices or create a default one
    const smartReply = choices.find(c =>
      c.action === 'use_cards' ||
      c.action === 'refresh_cards' ||
      c.action === 'generate_outline' ||
      c.action === 'generate_draft'
    );

    if (smartReply) {
      result.push({
        ...smartReply,
        label: getAssistantChoiceLabel(smartReply, 0)
      });
    } else {
      // Default smart reply based on context
      const cardIds = (sources?.cards || []).map(card => card.id);
      if (cardIds.length > 0) {
        result.push({
          id: 'smart-reply-generate',
          action: 'generate_draft',
          label: '基于素材生成文章',
          payload: { cardIds, styleSkillId: currentStyleSkill?.id }
        });
      } else {
        result.push({
          id: 'smart-reply-recall',
          action: 'smart_reply',
          label: '继续深入探讨',
          payload: { context: assistantInput }
        });
      }
    }

    return result.slice(0, 3);
  };

  const renderAssistantMeta = (message: AssistantMessage) => {
    const meta = message.meta as AssistantMeta | undefined;
    const sources = meta?.sources;
    const choices = getAssistantDisplayChoices(meta?.choices || [], sources);
    const sourceCards = sources?.cards || [];
    const images = sources?.images || [];
    const quotes = sources?.quotes || [];
    const collapsed = meta?.sourceCollapsed !== false;
    const sourceCount = sourceCards.length + quotes.length + images.length;
    if (!sources && choices.length === 0 && !meta?.noteSaved) return null;

    return (
      <div className="mt-3 space-y-3">
        {sourceCount > 0 ? (
          <button
            onClick={() => updateAssistantMessageMeta(message.id, { sourceCollapsed: !collapsed })}
            className="inline-flex items-center gap-1.5 rounded-full bg-bg px-3 py-1.5 text-[11px] text-text3 transition-colors hover:text-text-main"
          >
            <ChevronDown size={12} className={cn('transition-transform', collapsed ? '-rotate-90' : '')} />
            {collapsed ? `查看本轮引用素材 · ${sourceCount} 项` : '收起本轮引用素材'}
          </button>
        ) : null}

        {!collapsed ? (
          <>
        {images.length > 0 ? (
          <div>
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-text3">
              <ImageIcon size={12} />
              原文图片
            </div>
            <div className="grid grid-cols-3 gap-2">
              {images.slice(0, 6).map(image => (
                <div key={image.id} className="overflow-hidden rounded-xl border border-border bg-bg">
                  <img
                    src={getProxiedImageUrl(image.url)}
                    alt={image.articleTitle || '来源图片'}
                    className="h-16 w-full object-cover"
                    loading="lazy"
                    onError={event => { event.currentTarget.style.display = 'none'; }}
                  />
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {sourceCards.length > 0 ? (
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-text3">
              <Tag size={12} />
              本轮召回 {sourceCards.length} 张卡片
            </div>
            {sourceCards.slice(0, 4).map(card => {
              const checked = selectedCardIds.includes(card.id) || writeActivatedNodeIds.includes(card.id);
              return (
                <button
                  key={card.id}
                  onClick={() => toggleCardSelection(card)}
                  className={cn(
                    'w-full rounded-xl border px-3 py-2 text-left transition-colors',
                    checked ? 'border-accent bg-accent-light' : 'border-border bg-bg hover:border-accent/50'
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-medium text-text-main">{card.type} · {card.articleTitle || '知识库'}</span>
                    <span className="text-[10px] text-text3">{checked ? '已激活' : '点击激活'}</span>
                  </div>
                  <div className="mt-1 line-clamp-2 text-[11px] leading-5 text-text2">{card.summary || card.content}</div>
                </button>
              );
            })}
          </div>
        ) : null}

        {quotes.length > 0 ? (
          <div className="rounded-xl border border-border bg-bg px-3 py-2">
            <div className="text-[11px] font-medium text-text3">原文摘录</div>
            <div className="mt-1 line-clamp-3 text-[11px] leading-5 text-text2">
              {quotes[0].quote}
            </div>
          </div>
        ) : null}
          </>
        ) : null}

        {choices.length > 0 ? (
          <div className="space-y-2">
            {choices.map(choice => (
              <button
                key={choice.id}
                onClick={() => handleAgentChoice(choice, sources)}
                className="flex w-full items-center justify-between gap-3 rounded-2xl border border-border bg-bg px-3 py-2 text-left text-[12px] text-text2 transition-colors hover:border-accent hover:text-accent"
              >
                <span className="inline-flex min-w-0 items-center gap-2">
                  <Wand2 size={13} className="shrink-0" />
                  <span className="truncate">{choice.label}</span>
                </span>
                <span className="shrink-0 text-text3">›</span>
              </button>
            ))}
          </div>
        ) : null}

        {meta?.noteSaved && meta.noteTitle ? (
          <button
            onClick={() => setWriteWorkspaceMode('articles')}
            className="inline-flex items-center gap-1 rounded-full border border-accent bg-accent-light px-3 py-1.5 text-[11px] font-medium text-accent transition-colors hover:bg-bg"
          >
            <AtomFlowGalaxyIcon size={12} />
            打开文章《{meta.noteTitle}》
          </button>
        ) : null}
      </div>
    );
  };

  const renderToolMessage = (_message: AssistantMessage) => null;

	  const currentThread = assistantThreads.find(thread => Number(thread.id) === assistantThreadId) || null;
  const selectedSkillIdSet = useMemo(() => new Set(selectedSkillIds.map(id => String(id))), [selectedSkillIds]);
  const styleSkills = useMemo(() => (
    writeAgentSkills.filter(skill => skill.type === 'style')
  ), [writeAgentSkills]);
  const userStyleSkills = useMemo(() => styleSkills.filter(skill => skill.visibility === 'user'), [styleSkills]);
  const systemStyleSkills = useMemo(() => styleSkills.filter(skill => skill.visibility === 'system'), [styleSkills]);
  const enabledStyleSkills = useMemo(() => (
    styleSkills.filter(skill => selectedSkillIdSet.has(String(skill.id)) || String(selectedStyleSkillId) === String(skill.id))
  ), [selectedSkillIdSet, selectedStyleSkillId, styleSkills]);
  const skillUsage = useMemo(() => {
    const map = new Map<string, { usageCount: number; lastUsedAt?: string; recentNotes: Array<{ id: number; title: string; updatedAt?: string }> }>();
    notes.forEach(note => {
      const meta: any = note.meta || {};
      const snapshots = [
        ...(Array.isArray(meta.skillSnapshots) ? meta.skillSnapshots : []),
        ...(Array.isArray(meta.effectiveSkillSnapshots?.userSelectedSkills) ? meta.effectiveSkillSnapshots.userSelectedSkills : []),
        meta.styleSkillSnapshot
      ].filter(Boolean);
      snapshots.forEach((snapshot: any) => {
        if (!snapshot?.id) return;
        const key = String(snapshot.id);
        const current = map.get(key) || { usageCount: 0, recentNotes: [] };
        current.usageCount += 1;
        const updatedAt = note.updated_at || note.created_at;
        if (!current.lastUsedAt || (updatedAt && new Date(updatedAt).getTime() > new Date(current.lastUsedAt).getTime())) {
          current.lastUsedAt = updatedAt;
        }
        if (current.recentNotes.length < 3) {
          current.recentNotes.push({ id: note.id, title: note.title, updatedAt });
        }
        map.set(key, current);
      });
    });
    return map;
  }, [notes]);
  const toggleSkill = (skill: WriteAgentSkill) => {
    if (skill.isBaseline || skill.type !== 'style') return;
    setSelectedSkillIds(selectedSkillIdSet.has(String(skill.id))
      ? selectedSkillIds.filter(id => String(id) !== String(skill.id))
      : [...selectedSkillIds, skill.id]);
    setSelectedStyleSkillId(skill.id);
  };
  const startEditSkill = (skill: WriteAgentSkill) => {
    if (skill.visibility === 'system' || skill.type !== 'style') return;
    setEditingSkillId(skill.id);
    setSkillDraft({
      name: skill.name,
      type: 'style',
      description: skill.description || '',
      prompt: skill.prompt,
      constraints: (skill.constraints || []).join('\n')
    });
  };
  const saveSkillDraft = async () => {
    if (!skillDraft.name.trim() || !skillDraft.prompt.trim()) {
      showToast('先填写 Skill 名称和规则');
      return;
    }
    const payload = {
      name: skillDraft.name.trim(),
      type: 'style' as const,
      description: skillDraft.description.trim(),
      prompt: skillDraft.prompt.trim(),
      constraints: skillDraft.constraints.split('\n').map(item => item.trim()).filter(Boolean),
      isDefault: false
    };
    const saved = editingSkillId
      ? await updateWriteAgentSkill(editingSkillId, payload)
      : await createWriteAgentSkill(payload);
    if (saved) {
      setEditingSkillId(null);
      setSkillDraft({ name: '', type: 'style', description: '', prompt: '', constraints: '' });
    }
  };
  const handleSkillsAssistantSend = async () => {
    const text = skillsAssistantInput.trim();
    if (!text) return;

    setSkillsAssistantInput('');
    setSkillsAssistantMessages(prev => [
      ...prev,
      { id: `skills-user-${Date.now()}`, role: 'user', content: text }
    ]);

    const loadingId = `skills-loading-${Date.now()}`;
    setSkillsAssistantMessages(prev => [
      ...prev,
      { id: loadingId, role: 'assistant', content: '正在分析你的风格描述...' }
    ]);

    try {
      const response = await fetch('/api/write/agent/skills/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userInput: text,
          sampleText: pastedStyleDoc.trim() || undefined
        })
      });

      if (!response.ok) {
        throw new Error('Failed to generate skill');
      }

      const data = await response.json();

      setSkillsAssistantMessages(prev =>
        prev.filter(msg => msg.id !== loadingId).concat([
          {
            id: `skills-assistant-${Date.now()}`,
            role: 'assistant',
            content: '我把你的描述整理成了一个「风格 Skill」草案。它只会影响写作助手的表达、引用和成文方式，不会破坏存入知识库的基础规范。确认后我会直接保存到你的风格库，并设为后续写作可选项。',
            draftSkill: data.skill
          }
        ])
      );

      if (pastedStyleDoc.trim()) {
        setPastedStyleDoc('');
      }
    } catch (error) {
      console.error('Skill generation error:', error);
      setSkillsAssistantMessages(prev =>
        prev.filter(msg => msg.id !== loadingId).concat([
          {
            id: `skills-error-${Date.now()}`,
            role: 'assistant',
            content: '抱歉，生成风格 Skill 时出错了。请稍后重试。'
          }
        ])
      );
    }
  };
  const confirmSkillsAssistantDraft = async (draft: SkillsAssistantMessage['draftSkill']) => {
    if (!draft) return;
    const created = await createWriteAgentSkill({
      name: draft.name,
      type: 'style',
      description: draft.description,
      prompt: draft.prompt,
      constraints: draft.constraints,
      isDefault: false
    });
    if (created) {
      setSkillsAssistantMessages(prev => [
        ...prev,
        {
          id: `skills-created-${Date.now()}`,
          role: 'assistant',
          content: `已创建风格 Skill「${created.name}」。后续写作助手可以用它来生成文章；知识入库仍由基础规范兜底。`
        }
      ]);
    }
  };
  const sendPastedStyleDocToAssistant = () => {
    const text = pastedStyleDoc.trim();
    if (!text) {
      showToast('先粘贴一段你的风格说明');
      return;
    }
    setSkillsAssistantInput(text);
    setPastedStyleDoc('');
  };
  const handleCreateAssistantThread = async (threadType: 'chat' | 'skill' = 'chat') => {
    const thread = await createAssistantThread(threadType);
    if (thread) {
      setAssistantMessages(DEFAULT_ASSISTANT_MESSAGES);
      setAgentRunState(null);
      await loadAssistantThreads(threadType);
    }
  };

  const handleSwitchThread = async (threadId: number) => {
    setAssistantThreadId(threadId);
    await hydrateThreadMessages(threadId);
  };

  const renderRunSteps = (run: AgentRunState) => (
    <div className="mt-2 space-y-1.5 border-l border-border pl-3">
      {run.steps.length === 0 ? (
        <div className="flex items-center gap-2 text-[11px] text-text3">
          <Loader2 size={12} className="animate-spin" />
          正在准备
        </div>
      ) : run.steps.map(step => (
        <div key={step.node} className="flex items-start gap-2 py-1 text-[11px] leading-5 text-text3">
          {step.status === 'running' ? (
            <Loader2 size={12} className="mt-1 shrink-0 animate-spin text-accent" />
          ) : step.status === 'done' ? (
            <CheckCircle2 size={12} className="mt-1 shrink-0 text-[#74A184]" />
          ) : (
            <AlertCircle size={12} className="mt-1 shrink-0 text-[#C75050]" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate">{step.label}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );

  const renderAgentRunPanel = () => {
    if (!agentRun) return null;
    const doneCount = agentRun.steps.filter(step => step.status === 'done').length;
    const isError = agentRun.status === 'error';
    return (
      <div className="self-start w-full max-w-[94%] text-[12px] text-text3">
        <button
          onClick={() => setAgentRunState(prev => prev ? { ...prev, collapsed: !prev.collapsed } : prev)}
          className="inline-flex items-center gap-2 rounded-full px-1 py-1 text-text3 transition-colors hover:text-text-main"
        >
          {isError ? (
            <AlertCircle size={13} className="text-[#C75050]" />
          ) : (
            <Loader2 size={13} className="animate-spin text-text3" />
          )}
          <span>{isError ? '思考中断' : agentRun.message || '正在思考'}</span>
          {doneCount > 0 ? <span>· {doneCount} 步</span> : null}
          <ChevronDown size={12} className={cn('transition-transform', agentRun.collapsed ? '-rotate-90' : '')} />
        </button>
        {!agentRun.collapsed ? renderRunSteps(agentRun) : null}
      </div>
    );
  };

  const renderAssistantRunSummary = (message: AssistantMessage) => {
    const run = message.meta?.run as AgentRunState | undefined;
    if (!run) return null;
    const doneCount = run.steps.filter(step => step.status === 'done').length;
    const isExpanded = run.collapsed === false;
    return (
      <div className="mt-2 text-[11px] text-text3">
        <button
          onClick={() => updateAssistantMessageMeta(message.id, { run: { ...run, collapsed: !run.collapsed } })}
          className="inline-flex items-center gap-1.5 rounded-full px-1 py-1 text-text3 transition-colors hover:text-text-main"
        >
          <span>{run.status === 'error' ? '思考中断' : '已完成思考'}</span>
          <span>· {doneCount} 步</span>
          <ChevronDown size={12} className={cn('transition-transform', !isExpanded ? '-rotate-90' : '')} />
        </button>
        {isExpanded ? renderRunSteps(run) : null}
      </div>
    );
  };

  const renderAssistantActionBar = (message: AssistantMessage) => {
    const feedback = message.meta?.feedback || 'none';
    const actionButtonClass = 'inline-flex h-7 w-7 items-center justify-center rounded-full text-text3 transition-colors hover:bg-bg hover:text-text-main';
    return (
      <div className="mt-2 flex items-center gap-1 text-text3">
        <button className={actionButtonClass} onClick={() => void handleCopyAssistantMessage(message)} title="复制">
          <Copy size={14} />
        </button>
        <button className={actionButtonClass} onClick={() => handleSpeakAssistantMessage(message)} title="朗读">
          <Volume2 size={14} />
        </button>
        <button
          className={cn(actionButtonClass, feedback === 'liked' && 'bg-accent-light text-accent')}
          onClick={() => void handleAssistantFeedback(message, 'liked')}
          title="点赞"
        >
          <ThumbsUp size={14} />
        </button>
        <button
          className={cn(actionButtonClass, feedback === 'disliked' && 'bg-[#FFF0F0] text-[#C75050]')}
          onClick={() => void handleAssistantFeedback(message, 'disliked')}
          title="点踩"
        >
          <ThumbsDown size={14} />
        </button>
        <button className={actionButtonClass} onClick={() => handleRegenerateAssistantMessage(message)} title="重新生成">
          <RotateCcw size={14} />
        </button>
        <button className={actionButtonClass} title="更多">
          <MoreHorizontal size={14} />
        </button>
      </div>
    );
  };

	  const renderAssistantAside = () => {
    const chatThreads = assistantThreads.filter(t => t.thread_type === 'chat');

    return (
    <aside className="hidden min-h-0 w-[360px] shrink-0 overflow-hidden rounded-[28px] border border-border bg-surface xl:flex xl:flex-col">
      <div className="border-b border-border px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[15px] font-semibold text-text-main">Chat 助手</div>
            <div className="mt-1 truncate text-[12px] text-text3">{currentThread?.title || '新的写作会话'}</div>
	          </div>
	          <button
	            onClick={() => void handleCreateAssistantThread('chat')}
	            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-border bg-bg text-text2 transition-colors hover:border-accent hover:text-accent"
	            title="新建会话"
	          >
	            <Plus size={14} />
	          </button>
	        </div>

        {/* Thread History Section */}
        <div className="mt-3">
          <button
            onClick={() => setShowChatHistory(!showChatHistory)}
            className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-[13px] text-text2 transition-colors hover:bg-surface2"
          >
            <span>历史对话</span>
            <ChevronDown size={14} className={cn("transition-transform", showChatHistory && "rotate-180")} />
          </button>

          {showChatHistory && (
            <div className="mt-2 max-h-[200px] space-y-1 overflow-y-auto">
              {chatThreads.length === 0 ? (
                <div className="px-2 py-2 text-[12px] text-text3">暂无历史对话</div>
              ) : (
                chatThreads.map(thread => (
                  <button
                    key={thread.id}
                    onClick={() => void handleSwitchThread(Number(thread.id))}
                    className={cn(
                      "w-full truncate rounded-lg px-2 py-2 text-left text-[12px] transition-colors",
                      Number(thread.id) === assistantThreadId
                        ? "bg-accent-light text-accent"
                        : "text-text2 hover:bg-surface2"
                    )}
                    title={thread.title}
                  >
                    {thread.title}
                  </button>
                ))
              )}
            </div>
          )}
        </div>
	      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="flex flex-col gap-3">
          {assistantMessages.map(message => (
            message.role === 'tool' ? (
              <React.Fragment key={message.id}>
                {renderToolMessage(message)}
              </React.Fragment>
            ) : (
              <div
                key={message.id}
                className={cn(
                  'max-w-[92%] px-4 py-3 text-[13px] leading-6',
                  message.role === 'assistant'
                    ? 'self-start text-text-main'
                    : 'self-end rounded-2xl bg-accent-light text-accent'
                )}
              >
                {message.role === 'assistant' ? (
                  <>
                    {renderAssistantRunSummary(message)}
                    <div className="prose prose-sm max-w-none text-text-main prose-p:my-1.5 prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-strong:text-text-main prose-headings:my-2 prose-headings:text-text-main prose-a:text-accent">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {message.content}
                      </ReactMarkdown>
                    </div>
                    {renderAssistantMeta(message)}
                    {message.id !== 'welcome' ? renderAssistantActionBar(message) : null}
                  </>
                ) : (
                  <div className="whitespace-pre-wrap">{message.content}</div>
                )}
              </div>
            )
          ))}
          {renderAgentRunPanel()}
          {isRecalling && (
            <div className="self-start rounded-2xl bg-surface2 px-4 py-3 text-[13px] text-text3">
              正在聚焦相关知识节点...
            </div>
          )}
        </div>
      </div>
      <div className="border-t border-border p-4">
        <textarea
          value={assistantInput}
          onChange={(event) => setAssistantInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void handleAssistantSend();
            }
          }}
          placeholder="和写作助手对话，召回素材、生成提纲或创建文章"
          className="h-24 w-full resize-none rounded-2xl border border-border bg-bg px-3 py-3 text-[13px] text-text-main outline-none transition-colors focus:border-accent"
        />
        <button
          onClick={() => void handleAssistantSend()}
          disabled={!assistantInput.trim() || isRecalling || isAssistantThinking}
          className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-accent px-4 py-3 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <AtomFlowGalaxyIcon size={14} />
          {user ? '发送' : '登录后使用写作助手'}
        </button>
      </div>
    </aside>
    );
  };

  const renderSkillsAssistantAside = () => (
    <aside className="hidden min-h-0 w-[380px] shrink-0 overflow-hidden rounded-[28px] border border-border bg-surface xl:flex xl:flex-col">
      <div className="border-b border-border px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[15px] font-semibold text-text-main">Skills 助手</div>
            <div className="mt-1 truncate text-[12px] text-text3">把你的写作偏好沉淀成风格 Skill</div>
          </div>
          <AtomFlowGalaxyIcon size={18} />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="flex flex-col gap-3">
          {skillsAssistantMessages.map(message => (
            <div
              key={message.id}
              className={cn(
                'max-w-[94%] rounded-2xl px-4 py-3 text-[13px] leading-6',
                message.role === 'assistant'
                  ? 'self-start bg-surface2 text-text-main'
                  : 'self-end bg-accent-light text-accent'
              )}
            >
              <div className="whitespace-pre-wrap">{message.content}</div>
              {message.draftSkill ? (
                <div className="mt-3 rounded-xl border border-border bg-bg p-3 text-text-main">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[12px] font-semibold">{message.draftSkill.name}</div>
                      <div className="mt-1 text-[11px] leading-5 text-text3">{message.draftSkill.description}</div>
                    </div>
                    <span className="rounded-full bg-accent-light px-2 py-1 text-[10px] text-accent">风格</span>
                  </div>
                  <details className="mt-3 rounded-lg bg-surface px-3 py-2 text-[11px] leading-5 text-text2">
                    <summary className="cursor-pointer text-text3">查看结构化规则</summary>
                    <div className="mt-2 whitespace-pre-wrap">{message.draftSkill.prompt}</div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {message.draftSkill.constraints.map(item => (
                        <span key={item} className="rounded-full bg-bg px-2 py-1 text-[10px] text-text3">{item}</span>
                      ))}
                    </div>
                  </details>
                  <button
                    onClick={() => void confirmSkillsAssistantDraft(message.draftSkill)}
                    className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-3 py-2 text-[12px] font-medium text-white"
                  >
                    <Check size={13} />
                    创建风格 Skill
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>
      <div className="border-t border-border p-4">
        <textarea
          value={skillsAssistantInput}
          onChange={event => setSkillsAssistantInput(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void handleSkillsAssistantSend();
            }
          }}
          placeholder="描述你想要的风格，例如：像产品经理面试复盘，必须讲机制和取舍，不要空泛鸡汤"
          className="h-28 w-full resize-none rounded-2xl border border-border bg-bg px-3 py-3 text-[13px] text-text-main outline-none transition-colors focus:border-accent"
        />
        <button
          onClick={() => void handleSkillsAssistantSend()}
          disabled={!skillsAssistantInput.trim()}
          className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-accent px-4 py-3 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <AtomFlowGalaxyIcon size={14} />
          分析并生成草案
        </button>
      </div>
    </aside>
  );

  const renderSkillsWorkspace = () => (
    <div className="flex h-full min-h-0 gap-4 bg-bg">
      <div id="page-write" className="flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-[28px] border border-border bg-surface">
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <div className="space-y-5">
            <section className="rounded-2xl border border-border bg-bg px-4 py-3">
              <div className="mb-2 flex items-baseline gap-2">
                <div className="shrink-0 text-[13px] font-semibold text-text-main">风格创建建议</div>
                <div className="min-w-0 truncate text-[11px] text-text3">用右侧 Skill 助手描述你想要的写法，会结构化成可复用的写作风格；也可以点击下方示例，助手帮你生成草案。</div>
              </div>
              <div className="overflow-hidden">
                <div className="carousel-track">
                  {[...STYLE_SKILL_SEED_PROMPTS, ...STYLE_SKILL_SEED_PROMPTS].map((prompt, i) => (
                    <button
                      key={`${prompt}-${i}`}
                      onClick={() => setSkillsAssistantInput(prompt)}
                      className="min-w-[240px] max-w-[300px] shrink-0 rounded-xl border border-border bg-surface px-3 py-2 text-left text-[11px] leading-5 text-text2 transition-colors hover:border-accent hover:text-accent"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            </section>

            <section className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[14px] font-semibold text-text-main">我的风格库</div>
                  <div className="mt-1 text-[12px] text-text3">启用一个风格，写作助手会按这个方式组织表达和引用。</div>
                </div>
                <div className="relative">
                  <button
                    onClick={() => setShowSkinPicker(v => !v)}
                    className="flex items-center gap-1.5 rounded-xl border border-border bg-surface px-3 py-1.5 text-[11px] text-text2 transition-colors hover:border-accent hover:text-accent"
                  >
                    <Palette size={13} />
                    <span>{cardSkin.name}</span>
                    <ChevronDown size={11} />
                  </button>
                  {showSkinPicker && (
                    <div className="absolute right-0 top-full z-50 mt-1 w-44 rounded-xl border border-border bg-surface p-1 shadow-lg">
                      {CARD_SKINS.map(skin => (
                        <button
                          key={skin.id}
                          onClick={() => { setCardSkinId(skin.id); setShowSkinPicker(false); }}
                          className={cn(
                            'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[11px] transition-colors',
                            cardSkinId === skin.id ? 'bg-accent-light text-accent' : 'text-text2 hover:bg-surface2'
                          )}
                        >
                          <div
                            className="h-4 w-4 shrink-0 rounded-full border border-white/20"
                            style={{ background: `linear-gradient(135deg, ${skin.border[0]}, ${skin.border[1]}, ${skin.border[2]})` }}
                          />
                          <span className="font-medium">{skin.name}</span>
                          <span className="ml-auto text-[9px] text-text3">
                            {skin.id === 'imperial-gold' ? '龙纹' :
                             skin.id === 'dark-iron' ? '几何' :
                             skin.id === 'cinnabar' ? '云纹' :
                             skin.id === 'jade' ? '水纹' : '凤纹'}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                  {showSkinPicker && <div className="fixed inset-0 z-40" onClick={() => setShowSkinPicker(false)} />}
                </div>
              </div>
              <div className="magic-cards-container">
                {[...userStyleSkills, ...systemStyleSkills.filter(skill => !skill.isBaseline)].map((skill, index, arr) => {
                    const selected = selectedSkillIdSet.has(String(skill.id)) || String(selectedStyleSkillId) === String(skill.id);
                    const usage = skillUsage.get(String(skill.id));
                    const isEditing = String(editingSkillId) === String(skill.id);
                    const total = arr.length;
                    const mid = (total - 1) / 2;
                    const rotateDeg = total > 1 ? ((index - mid) / mid) * 5 : 0;
                    const liftPx = total > 1 ? -Math.abs(index - mid) * 3 : 0;
                    return (
                      <div
                        key={String(skill.id)}
                        className={cn('magic-card w-[220px] shrink-0', flippedCardId === skill.id && 'flipped')}
                        style={{
                          '--card-rotate': `${rotateDeg}deg`,
                          '--card-lift': `${liftPx}px`,
                          '--card-border-width': cardSkin.borderWidth,
                          '--card-border-1': cardSkin.border[0],
                          '--card-border-2': cardSkin.border[1],
                          '--card-border-3': cardSkin.border[2],
                          '--card-gem-pattern': cardSkin.gemPattern,
                          '--card-gem-glow': cardSkin.gemGlow,
                          '--card-bar-1': cardSkin.bar[0],
                          '--card-bar-2': cardSkin.bar[1],
                          '--card-bar-3': cardSkin.bar[2],
                          '--card-bar-pattern': cardSkin.barPattern,
                          '--card-bg-texture': cardSkin.bgTexture,
                          '--card-bg-opacity': cardSkin.bgOpacity,
                          '--card-hover-glow': cardSkin.hoverGlow,
                          '--card-corner-accent': cardSkin.cornerAccent,
                        } as React.CSSProperties}
                        onClick={() => { setFlippedCardId(flippedCardId === skill.id ? null : skill.id); }}
                      >
                        <div className="magic-card-flipper">
                          {/* ── 正面 ── */}
                          <div className="magic-card-front">
                            <div className="magic-card-inner p-4">
                              <div className="magic-card-gem magic-card-gem-tl" />
                              <div className="magic-card-gem magic-card-gem-tr" />
                              <div className="magic-card-gem magic-card-gem-bl" />
                              <div className="magic-card-gem magic-card-gem-br" />

                              <div className="relative z-[1] flex items-start justify-between gap-2">
                                <button
                                  onClick={e => { e.stopPropagation(); toggleSkill(skill); }}
                                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition-colors"
                                  style={selected
                                    ? { borderColor: cardSkin.accent, backgroundColor: cardSkin.accent, color: '#fff' }
                                    : { borderColor: 'var(--theme-border)', backgroundColor: 'var(--theme-surface)', color: 'var(--theme-text3)' }
                                  }
                                  title={selected ? '已启用' : '启用风格'}
                                >
                                  {selected ? <Check size={12} /> : <AtomFlowGalaxyIcon size={12} />}
                                </button>
                                <span
                                  className="shrink-0 rounded-full px-2 py-0.5 text-[9px] font-medium"
                                  style={selected
                                    ? { backgroundColor: cardSkin.accent, color: '#fff' }
                                    : { backgroundColor: 'var(--theme-surface2)', color: 'var(--theme-text3)' }
                                  }
                                >
                                  {selected ? '启用中' : skill.visibility === 'system' ? '示范' : '未启用'}
                                </span>
                              </div>

                              <div className="relative z-[1] mt-3">
                                <div className="font-serif text-[14px] font-bold leading-tight text-text-main">{skill.name}</div>
                                <div className="mt-1.5 line-clamp-2 text-[11px] leading-4 text-text3">
                                  {skill.description || '一套会影响写作助手表达、结构和引用方式的风格规则'}
                                </div>
                              </div>

                              <div className="relative z-[1] mt-3 flex flex-wrap gap-1">
                                {(skill.constraints || []).slice(0, 3).map(item => (
                                  <span key={item} className="rounded-full bg-surface2 px-2 py-0.5 text-[9px] text-text3">{item}</span>
                                ))}
                              </div>

                              <div className="relative z-[1] mt-3 flex items-center justify-between border-t border-border/50 pt-2">
                                <div className="text-[10px] text-text3">
                                  {usage?.usageCount || 0} 次使用
                                </div>
                                <div className="flex items-center gap-0.5">
                                  {skill.visibility === 'system' ? (
                                    <button
                                      onClick={e => {
                                        e.stopPropagation();
                                        void createWriteAgentSkill({
                                          name: `${skill.name}（我的）`,
                                          type: 'style',
                                          description: skill.description || '',
                                          prompt: skill.prompt,
                                          examples: skill.examples || [],
                                          constraints: skill.constraints || []
                                        });
                                      }}
                                      className="rounded-md px-1.5 py-1 text-[10px] transition-colors"
                                      style={{ color: cardSkin.accent }}
                                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = cardSkin.accentLight; }}
                                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent'; }}
                                    >
                                      复制
                                    </button>
                                  ) : (
                                    <>
                                      <button onClick={e => { e.stopPropagation(); startEditSkill(skill); }} className="rounded-md p-1 text-text3 hover:bg-surface2 hover:text-accent" title="编辑">
                                        <Edit3 size={12} />
                                      </button>
                                      <button onClick={e => { e.stopPropagation(); void deleteWriteAgentSkill(skill.id); }} className="rounded-md p-1 text-text3 hover:bg-surface2 hover:text-red-500" title="删除">
                                        <Trash2 size={12} />
                                      </button>
                                    </>
                                  )}
                                </div>
                              </div>

                              <div className="relative z-[1] mt-2 text-center">
                                <span className="text-[9px] text-text3/60">点击翻牌查看详情</span>
                              </div>
                            </div>
                          </div>

                          {/* ── 背面 ── */}
                          <div className="magic-card-back" onClick={e => { e.stopPropagation(); setFlippedCardId(null); }}>
                            <div className="magic-card-gem magic-card-gem-tl" />
                            <div className="magic-card-gem magic-card-gem-tr" />
                            <div className="magic-card-gem magic-card-gem-bl" />
                            <div className="magic-card-gem magic-card-gem-br" />
                            {/* 纹路底纹 */}
                            <div className="magic-card-back-dragon" style={{ background: `linear-gradient(160deg, ${cardSkin.backBg} 0%, ${cardSkin.backBg}cc 40%, ${cardSkin.backBg} 100%)` }}>
                              {renderCardPattern(skill.id, cardSkin.id, cardSkin.patternStroke, cardSkin.patternStroke2)}
                            </div>
                            {/* 内容层 — 延迟显现 */}
                            <div className="magic-card-back-content" style={{ background: cardSkin.backContentBg }} onClick={e => e.stopPropagation()}>
                              <div className="p-4">
                                <div className="flex items-center justify-between gap-2">
                                  <div className="font-serif text-[13px] font-bold" style={{ color: cardSkin.titleText }}>{skill.name}</div>
                                  <button
                                    onClick={e => { e.stopPropagation(); setFlippedCardId(null); }}
                                    className="shrink-0 rounded-full p-1 hover:bg-white/10"
                                    style={{ color: cardSkin.accentText }}
                                    title="翻回"
                                  >
                                    <X size={12} />
                                  </button>
                                </div>
                                <div className="mt-2 h-px" style={{ background: `linear-gradient(to right, transparent, ${cardSkin.patternStroke}33, transparent)` }} />
                                {skill.description && (
                                  <div className="mt-2 text-[10px] leading-4" style={{ color: cardSkin.bodyText, opacity: 0.7 }}>{skill.description}</div>
                                )}
                                <div className="mt-2.5">
                                  <div className="text-[9px] font-semibold uppercase tracking-wider" style={{ color: cardSkin.accentText }}>风格规则</div>
                                  <div className="mt-1 whitespace-pre-wrap text-[10px] leading-[15px]" style={{ color: cardSkin.bodyText }}>{skill.prompt}</div>
                                </div>
                                {(skill.constraints || []).length > 0 && (
                                  <div className="mt-2.5">
                                    <div className="text-[9px] font-semibold uppercase tracking-wider" style={{ color: cardSkin.accentText }}>约束</div>
                                    <div className="mt-1 flex flex-col gap-0.5">
                                      {skill.constraints!.map((c, i) => (
                                        <div key={i} className="text-[10px] leading-4" style={{ color: cardSkin.bodyText, opacity: 0.6 }}>· {c}</div>
                                      ))}
                                    </div>
                                  </div>
                                )}
                                {(skill.examples || []).length > 0 && (
                                  <div className="mt-2.5">
                                    <div className="text-[9px] font-semibold uppercase tracking-wider" style={{ color: cardSkin.accentText }}>示例</div>
                                    <div className="mt-1 flex flex-col gap-1">
                                      {skill.examples!.map((ex, i) => (
                                        <div key={i} className="rounded-md px-2 py-1.5 text-[10px] leading-4" style={{ background: `${cardSkin.patternStroke}0D`, color: cardSkin.bodyText, opacity: 0.6 }}>{ex}</div>
                                      ))}
                                    </div>
                                  </div>
                                )}
                                <div className="mt-3 text-center">
                                  <span className="text-[9px]" style={{ color: cardSkin.accentText, opacity: 0.5 }}>点击任意处翻回</span>
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>

                        {isEditing && (
                          <div className="absolute inset-0 z-20 flex items-center justify-center rounded-[16px] bg-surface/95 p-4 backdrop-blur-sm">
                            <div className="w-full space-y-2">
                              <input
                                value={skillDraft.name}
                                onChange={event => setSkillDraft(prev => ({ ...prev, name: event.target.value }))}
                                className="w-full rounded-lg border border-border bg-bg px-2 py-1.5 text-[12px] outline-none focus:border-accent"
                                placeholder="名称"
                              />
                              <input
                                value={skillDraft.description}
                                onChange={event => setSkillDraft(prev => ({ ...prev, description: event.target.value }))}
                                className="w-full rounded-lg border border-border bg-bg px-2 py-1.5 text-[12px] outline-none focus:border-accent"
                                placeholder="描述"
                              />
                              <textarea
                                value={skillDraft.prompt}
                                onChange={event => setSkillDraft(prev => ({ ...prev, prompt: event.target.value }))}
                                className="h-20 w-full resize-none rounded-lg border border-border bg-bg px-2 py-1.5 text-[11px] leading-4 outline-none focus:border-accent"
                                placeholder="风格规则"
                              />
                              <textarea
                                value={skillDraft.constraints}
                                onChange={event => setSkillDraft(prev => ({ ...prev, constraints: event.target.value }))}
                                placeholder="约束，一行一条"
                                className="h-14 w-full resize-none rounded-lg border border-border bg-bg px-2 py-1.5 text-[11px] leading-4 outline-none focus:border-accent"
                              />
                              <div className="flex gap-1.5">
                                <button onClick={() => void saveSkillDraft()} className="flex-1 rounded-lg bg-accent px-2 py-1.5 text-[11px] font-medium text-white">保存</button>
                                <button onClick={() => setEditingSkillId(null)} className="rounded-lg border border-border px-2 py-1.5 text-[11px] text-text2">取消</button>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-bg p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-[13px] font-semibold text-text-main">粘贴你的风格文档</div>
                  <div className="mt-1 text-[12px] text-text3">可以直接贴公众号样稿、写作原则、禁用词、引用要求。不会立刻保存，会先交给 Skills 助手生成草案。</div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {STYLE_COMPONENT_EXAMPLES.map(item => (
                    <button
                      key={item.token}
                      onClick={() => setPastedStyleDoc(prev => `${prev}${prev ? '\n' : ''}${item.token} ${item.label}`)}
                      className="rounded-full border border-border bg-surface px-2.5 py-1 text-[10px] text-text3 hover:border-accent hover:text-accent"
                      title={item.label}
                    >
                      {item.token}
                    </button>
                  ))}
                </div>
              </div>
              <textarea
                value={pastedStyleDoc}
                onChange={event => setPastedStyleDoc(event.target.value)}
                placeholder={'例：\n我要写科技公众号风。\n开头用 @故事 或一个具体产品现象。\n中段用 @观点 解释机制，用 @数据 支撑判断。\n不要首先其次最后，不要 AI 腔。'}
                className="mt-3 h-28 w-full resize-none rounded-xl border border-border bg-surface px-3 py-3 text-[12px] leading-5 text-text-main outline-none focus:border-accent"
              />
              <div className="mt-3 flex justify-end">
                <button
                  onClick={sendPastedStyleDocToAssistant}
                  className="inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-[12px] font-medium text-white"
                >
                  <AtomFlowGalaxyIcon size={13} />
                  交给 Skills 助手
                </button>
              </div>
            </section>
          </div>
        </div>
      </div>
      {renderSkillsAssistantAside()}
    </div>
  );

	  if (writeWorkspaceMode === 'articles') {
	    return (
      <div className="flex h-full min-h-0 gap-4 bg-bg">
        <div id="page-write" className="flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-[28px] border border-border bg-surface">
          <NotesPanel />
        </div>
        {renderAssistantAside()}
      </div>
	    );
	  }

  if (writeWorkspaceMode === 'skills') {
    return renderSkillsWorkspace();
  }

	  return (
    <div className="flex h-full min-h-0 gap-4 bg-bg">
      <div id="page-write" className="flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-[30px] border border-[#E7DAC0] bg-[#FBF7EF] shadow-[0_20px_48px_rgba(150,120,78,0.1)]">
        <div className="border-b border-[#E9DFC9] bg-[#FFFCF5] px-5 py-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[15px] font-semibold text-[#3C2A19]">知识关系图</div>
              <div className="mt-1 text-[12px] text-[#8B745C]">平面的 2D 受力系统。文章拆成原子星点，父子天然相连，跨节点只保留真实语义连接。</div>
	            </div>
	            <div className="flex items-center gap-2">
	              {writeActivatedNodeIds.length > 0 ? (
	                <div className="flex items-center gap-1 rounded-full border border-[#E5D6BB] bg-white px-1 py-1">
	                  <span className="px-2 text-[11px] text-[#8A7359]">显示范围</span>
	                  {[
	                    { key: 'all', label: '全部' },
	                    { key: 'activated', label: '激活' }
	                  ].map(item => (
	                    <button
	                      key={item.key}
	                      onClick={() => setWriteGraphView(item.key as typeof writeGraphView)}
	                      className={cn(
	                        'rounded-full px-2.5 py-1 text-[11px] transition-colors',
	                        writeGraphView === item.key ? 'bg-[#F1E2C7] text-[#6F4E2D]' : 'text-[#9A8064] hover:bg-[#FCF4E4]'
	                      )}
	                    >
	                      {item.label}
	                    </button>
	                  ))}
	                </div>
	              ) : null}
	              <div className="rounded-full border border-[#E5D6BB] bg-white px-2.5 py-1 text-[11px] text-[#8A7359]">{zoomLabel}</div>
              <button onClick={() => setZoom(prev => Math.min(1.35, +(prev + 0.05).toFixed(2)))} className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#E5D6BB] bg-white text-[#7F654C] transition-colors hover:bg-[#FCF4E4]">
                <ZoomIn size={14} />
              </button>
              <button onClick={() => setZoom(prev => Math.max(0.85, +(prev - 0.05).toFixed(2)))} className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#E5D6BB] bg-white text-[#7F654C] transition-colors hover:bg-[#FCF4E4]">
                <ZoomOut size={14} />
              </button>
            </div>
          </div>
        </div>

        <div ref={graphCanvasRef} className="atomflow-force-canvas relative min-h-0 flex-1 overflow-hidden">
            <div className="atomflow-force-grid absolute inset-0 pointer-events-none" />

            {graph.cards.length === 0 ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center px-8 text-center text-[#8A745D]">
                <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-[22px] border border-[#E7D8BE] bg-white shadow-[0_10px_28px_rgba(145,116,77,0.08)]">
                  <AtomFlowGalaxyIcon size={24} />
                </div>
                <div className="text-[16px] font-medium text-[#3F2C1B]">右侧 Chat 会负责主题聚焦，并同步激活这张知识关系图</div>
                <div className="mt-2 max-w-[420px] text-[12px] leading-6">这里持续展示你的知识库全貌。文章会拆成原子点，只有真正命中的关系才会出现连线。</div>
              </div>
            ) : (
              <svg
                ref={graphSvgRef}
                className="absolute inset-0 h-full w-full"
                viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`}
                preserveAspectRatio="xMidYMid meet"
                style={{ transform: `scale(${zoom})`, transformOrigin: 'center center' }}
              >
                <g className="atomflow-force-link-layer">
                  {graph.links.map(link => {
                    const source = positionMap.get(link.sourceId);
                    const target = positionMap.get(link.targetId);
                    if (!source || !target) return null;
                    const active = !relatedNodeIds.size || relatedNodeIds.has(link.sourceId) || relatedNodeIds.has(link.targetId);
                    const stroke = link.kind === 'parent'
                      ? active ? 'rgba(180, 148, 93, 0.26)' : 'rgba(180, 148, 93, 0.08)'
                      : link.kind === 'semantic'
                        ? active ? 'rgba(151, 112, 86, 0.3)' : 'rgba(151, 112, 86, 0.08)'
                        : active ? 'rgba(214, 138, 74, 0.28)' : 'rgba(214, 138, 74, 0.08)';
                    const strokeWidth = link.kind === 'parent'
                      ? 0.7
                      : link.kind === 'semantic'
                        ? 0.9 + Math.min(link.strength || 1, 4) * 0.12
                        : 0.85 + Math.min(link.strength || 1, 4) * 0.08;

                    if (link.kind === 'semantic') {
                      const mx = (source.x + target.x) / 2;
                      const my = (source.y + target.y) / 2 - Math.hypot(source.x - target.x, source.y - target.y) * 0.08;
                      const path = `M ${source.x} ${source.y} Q ${mx} ${my} ${target.x} ${target.y}`;
                      return (
                        <path
                          key={link.id}
                          d={path}
                          stroke={stroke}
                          strokeWidth={strokeWidth}
                          strokeLinecap="round"
                          fill="none"
                        />
                      );
                    }

                    return (
                      <line
                        key={link.id}
                        x1={source.x}
                        y1={source.y}
                        x2={target.x}
                        y2={target.y}
                        stroke={stroke}
                        strokeWidth={strokeWidth}
                        strokeDasharray={link.kind === 'article' ? '5 5' : undefined}
                        strokeLinecap="round"
                      />
                    );
                  })}
                </g>

                {graph.articles.map(article => {
                  const position = positionMap.get(article.id) || { x: article.x, y: article.y };
                  const isFocused = focusedNodeId === article.id;
                  const isRelated = !relatedNodeIds.size || relatedNodeIds.has(article.id);
                  const isDragging = draggedNodeId === article.id;
                  const markerSize = isFocused || isDragging ? 10.8 : 9.2;
                  return (
                    <g
                      key={article.id}
                      transform={`translate(${position.x} ${position.y})`}
                      className="cursor-grab active:cursor-grabbing"
                      opacity={isRelated ? 1 : 0.24}
                      onClick={() => {
                        if (shouldSuppressClick(article.id)) return;
                        setFocusedNodeId(article.id);
                      }}
                      onMouseEnter={event => {
                        setHoveredNodeId(article.id);
                        updateHoverTooltip(event, `文章 · ${truncateText(article.articleTitle)}`, 'sun');
                      }}
                      onMouseMove={event => updateHoverTooltip(event, `文章 · ${truncateText(article.articleTitle)}`, 'sun')}
                      onMouseLeave={() => {
                        setHoveredNodeId(null);
                        setHoverTooltip(null);
                      }}
                      onPointerDown={event => beginNodeDrag(event, article.id, 'article')}
                      onPointerMove={event => moveNodeDrag(event, article.id)}
                      onPointerUp={endNodeDrag}
                      onPointerCancel={endNodeDrag}
                    >
                      <circle r={18} fill="rgba(255,255,255,0.001)" stroke="none" />
                      <title>{article.articleTitle}</title>
                      {(isFocused || isDragging) && (
                        <circle
                          r={markerSize + 6}
                          fill="none"
                          stroke="rgba(231, 173, 84, 0.24)"
                          strokeWidth="1.3"
                        />
                      )}
                      <circle
                        r={markerSize + 2.6}
                        fill="#FFF7E4"
                        stroke="#E9D7A5"
                        strokeWidth="1"
                      />
                      <circle
                        r={markerSize}
                        fill="#E8A94A"
                        stroke="#FFF9ED"
                        strokeWidth={isFocused || isDragging ? 1.6 : 1.15}
                      />
                      <circle
                        r={markerSize * 0.34}
                        fill="#FFF9EF"
                        opacity={0.94}
                      />
                    </g>
                  );
                })}

                {graph.cards.map(node => {
                  const colors = getCardColors(node.card.type);
                  const position = positionMap.get(node.id) || { x: node.x, y: node.y };
                  const isFocused = focusedNodeId === node.id;
                  const isRelated = !relatedNodeIds.size || relatedNodeIds.has(node.id);
                  const isActivated = selectedCardIds.includes(node.id) || writeActivatedNodeIds.includes(node.id);
                  const isDragging = draggedNodeId === node.id;
                  const outerRadius = isFocused || isDragging ? 9.2 : isActivated ? 8.2 : 7.2;
                  const rotation = ((node.orbitAngle ?? 0) * 180) / Math.PI + 45;
                  const swirlPath = getGalaxySwirlPath(outerRadius);
                  return (
                    <g
                      key={node.id}
                      transform={`translate(${position.x} ${position.y})`}
                      className="cursor-grab active:cursor-grabbing"
                      opacity={isRelated ? 1 : 0.2}
                      onClick={() => {
                        if (shouldSuppressClick(node.id)) return;
                        setFocusedNodeId(node.id);
                        toggleCardSelection(node.card);
                      }}
                      onMouseEnter={event => {
                        setHoveredNodeId(node.id);
                        updateHoverTooltip(event, `${node.card.type} · ${truncateText(node.card.content, 20)}`, 'atom');
                      }}
                      onMouseMove={event => updateHoverTooltip(event, `${node.card.type} · ${truncateText(node.card.content, 20)}`, 'atom')}
                      onMouseLeave={() => {
                        setHoveredNodeId(null);
                        setHoverTooltip(null);
                      }}
                      onPointerDown={event => beginNodeDrag(event, node.id, 'card')}
                      onPointerMove={event => moveNodeDrag(event, node.id)}
                      onPointerUp={endNodeDrag}
                      onPointerCancel={endNodeDrag}
                    >
                      <rect x={-12} y={-12} width={24} height={24} fill="rgba(255,255,255,0.001)" stroke="none" />
                      <title>{`${node.card.type} · ${node.card.content}`}</title>
                      <g transform={`rotate(${rotation})`}>
                        {(isFocused || isDragging || isActivated) && (
                          <path
                            d={`M ${-(outerRadius + 4.2)} ${-(outerRadius + 1.8)} H ${-(outerRadius + 1.8)} V ${-(outerRadius + 4.2)} H ${outerRadius + 1.8} V ${-(outerRadius + 1.8)} H ${outerRadius + 4.2} V ${outerRadius + 1.8} H ${outerRadius + 1.8} V ${outerRadius + 4.2} H ${-(outerRadius + 1.8)} V ${outerRadius + 1.8} H ${-(outerRadius + 4.2)} Z`}
                            fill="none"
                            stroke={colors.main}
                            strokeOpacity="0.2"
                            strokeWidth="1.05"
                          />
                        )}
                        <path
                          d={`M ${-outerRadius * 0.18} ${-outerRadius * 1.02} H ${outerRadius * 0.44} V ${-outerRadius * 0.76} H ${outerRadius * 0.76} V ${-outerRadius * 0.44} H ${outerRadius * 1.02} V ${outerRadius * 0.38} H ${outerRadius * 0.74} V ${outerRadius * 0.72} H ${outerRadius * 0.38} V ${outerRadius * 0.98} H ${-outerRadius * 0.42} V ${outerRadius * 0.72} H ${-outerRadius * 0.74} V ${outerRadius * 0.38} H ${-outerRadius * 1.02} V ${-outerRadius * 0.42} H ${-outerRadius * 0.74} V ${-outerRadius * 0.74} H ${-outerRadius * 0.18} Z`}
                          fill="#0B1E63"
                          opacity="0.92"
                        />
                        <path
                          d={swirlPath}
                          fill="none"
                          stroke="#60A5FA"
                          strokeWidth={isFocused || isDragging ? 1.85 : 1.55}
                          strokeLinecap="butt"
                          strokeLinejoin="miter"
                        />
                        <path
                          d={getGalaxySwirlPath(outerRadius * 0.78)}
                          fill="none"
                          stroke="#2563EB"
                          strokeWidth="1"
                          strokeLinecap="butt"
                          strokeLinejoin="miter"
                          opacity="0.88"
                        />
                        <rect x={outerRadius * -0.58} y={outerRadius * -0.54} width={outerRadius * 0.22} height={outerRadius * 0.22} fill="#BAE6FD" />
                        <rect x={outerRadius * 0.44} y={outerRadius * -0.72} width={outerRadius * 0.2} height={outerRadius * 0.2} fill="#93C5FD" />
                        <rect x={outerRadius * 0.54} y={outerRadius * 0.34} width={outerRadius * 0.24} height={outerRadius * 0.24} fill="#E0F2FE" />
                        <rect x={outerRadius * -0.72} y={outerRadius * 0.4} width={outerRadius * 0.2} height={outerRadius * 0.2} fill="#818CF8" />
                        <path
                          d={`M 0 ${-outerRadius * 0.43} L ${outerRadius * 0.15} ${-outerRadius * 0.08} L ${outerRadius * 0.5} 0 L ${outerRadius * 0.15} ${outerRadius * 0.08} L 0 ${outerRadius * 0.43} L ${-outerRadius * 0.15} ${outerRadius * 0.08} L ${-outerRadius * 0.5} 0 L ${-outerRadius * 0.15} ${-outerRadius * 0.08} Z`}
                          fill="#F8FBFF"
                          opacity="0.94"
                        />
                        <rect x={outerRadius * -0.12} y={outerRadius * -0.12} width={outerRadius * 0.24} height={outerRadius * 0.24} fill="#FFFFFF" opacity="0.88" />
                      </g>
                    </g>
                  );
                })}
              </svg>
            )}
            {hoverTooltip && (
              <div
                className={cn(
                  'pointer-events-none absolute z-20 max-w-[220px] -translate-x-1/2 -translate-y-[135%] rounded-lg border px-3 py-1.5 text-[11.5px] whitespace-nowrap backdrop-blur',
                  hoverTooltip.tone === 'sun'
                    ? 'border-[#E8D7B7] bg-white/96 text-[#3E2C1B]'
                    : hoverTooltip.tone === 'atom-warm'
                      ? 'border-[#E6D1AD] bg-white/96 text-[#9A6124]'
                      : 'border-[#E7D8C2] bg-white/96 text-[#705949]'
                )}
                style={{ left: hoverTooltip.x, top: hoverTooltip.y }}
              >
                {hoverTooltip.text}
              </div>
            )}
            {(focusedCard || focusedArticle) && (
              <div className="absolute bottom-16 right-5 top-5 z-30 flex w-[360px] max-w-[calc(100%-40px)] flex-col overflow-hidden rounded-2xl border border-[#E6D7BE] bg-white/98 shadow-[0_20px_50px_rgba(150,120,78,0.15)] backdrop-blur-sm">
                <div className="flex shrink-0 items-start justify-between gap-3 border-b border-[#F0E2CC] bg-white/98 px-4 py-3">
                  <div className="flex items-center gap-2 text-[13px] font-semibold text-[#3E2B1A]">
                    {focusedCard ? <Tag size={15} /> : <FileText size={15} />}
                    {focusedCard ? '知识节点' : '文章节点'}
                  </div>
                  <div className="flex items-center gap-2">
                    {focusedSavedArticle && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowBackgroundDrawer(true);
                        }}
                        className="flex h-8 items-center gap-1.5 shrink-0 rounded-lg bg-[#FCF4E4] px-3 text-[#8F7861] transition-all hover:bg-[#F5E8D0] hover:text-[#6F4E2D] active:scale-95"
                        title="查看背景详情"
                      >
                        <FileText size={14} strokeWidth={2} />
                        <span className="text-[12px] font-medium">背景详情</span>
                      </button>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setFocusedNodeId(null);
                      }}
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#FCF4E4] text-[#8F7861] transition-all hover:bg-[#F5E8D0] hover:text-[#6F4E2D] active:scale-95"
                      title="关闭"
                    >
                      <X size={16} strokeWidth={2.5} />
                    </button>
                  </div>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
                {focusedCard ? (
                  <div className="mt-1">
                    <div className="text-[15px] font-semibold leading-7 text-[#3E2B1A]">{focusedCard.content}</div>
                    {focusedCard.summary && (
                      <div className="mt-2 rounded-2xl bg-[#FFF9EF] px-3 py-2 text-[12px] leading-5 text-[#6E5845]">
                        {focusedCard.summary}
                      </div>
                    )}
                    <div className="mt-3 flex flex-wrap gap-2">
                      <span className="rounded-full bg-[#FCF1E1] px-3 py-1 text-[11px] text-[#916A3E]">{focusedCard.type}</span>
                      {focusedCard.evidenceRole && (
                        <span className="rounded-full bg-[#F3EFE6] px-3 py-1 text-[11px] text-[#7B654D]">{focusedCard.evidenceRole}</span>
                      )}
                      {(focusedCard.tags || []).slice(0, 4).map(tag => (
                        <span key={tag} className="rounded-full bg-[#FFF6E8] px-3 py-1 text-[11px] text-[#A56B17]">#{tag}</span>
                      ))}
                    </div>
                    <div className="mt-4 rounded-2xl bg-[#FCF8F0] px-3 py-3">
                      <div className="text-[11px] font-semibold text-[#8A735B]">所属文章</div>
                      <div className="mt-2 text-[12px] font-medium leading-6 text-[#3E2B1A] line-clamp-2">{focusedSavedArticle?.title || focusedCard.articleTitle || '未命名文章'}</div>
                    </div>
                    {(focusedSavedArticle?.citationContext || focusedCard.sourceContext) && (
                      <div className="mt-3 rounded-2xl bg-[#FFFCF7] px-3 py-3">
                        <div className="text-[11px] font-semibold text-[#8A735B]">文章引用背景</div>
                        <div className="mt-2 max-h-28 overflow-y-auto text-[12px] leading-6 text-[#6E5845]">
                          {focusedSavedArticle?.citationContext || focusedCard.sourceContext}
                        </div>
                      </div>
                    )}
                    {focusedCard.context && (
                      <div className="mt-3 rounded-2xl bg-[#FCF8F0] px-3 py-3">
                        <div className="text-[11px] font-semibold text-[#8A735B]">卡片语境</div>
                        <div className="mt-2 text-[12px] leading-6 text-[#6E5845]">{focusedCard.context}</div>
                      </div>
                    )}
                    {focusedCard.originalQuote && (
                      <div className="mt-3 rounded-2xl border border-[#EBD8B5] bg-white px-3 py-3">
                        <div className="text-[11px] font-semibold text-[#8A735B]">原文摘录</div>
                        <div className="mt-2 text-[12px] leading-6 text-[#3E2B1A]">{focusedCard.originalQuote}</div>
                      </div>
                    )}
                    {focusedCard.citationNote && (
                      <div className="mt-3 rounded-2xl bg-[#FFF6E8] px-3 py-3">
                        <div className="text-[11px] font-semibold text-[#8A735B]">引用建议</div>
                        <div className="mt-2 text-[12px] leading-6 text-[#6E5845]">{focusedCard.citationNote}</div>
                      </div>
                    )}
                    {relatedArticlesForCard.length > 0 && (
                      <div className="mt-3">
                        <div className="text-[11px] font-semibold text-[#8A735B]">关联线索</div>
                        <div className="mt-2 space-y-2">
                          {relatedArticlesForCard.slice(0, 2).map(item => (
                            <div key={`${item.articleTitle}-${item.count}`} className="rounded-2xl bg-[#FFFCF7] px-3 py-2 text-[12px] text-[#6E5845]">
                              <div className="font-medium text-[#3E2B1A] line-clamp-1">{item.articleTitle}</div>
                              <div className="mt-1 text-[11px] text-[#8A735B]">共享 {item.count} 条语义线索</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ) : focusedArticle ? (
                  <div className="mt-1">
                    <div className="text-[15px] font-semibold leading-7 text-[#3E2B1A]">{focusedSavedArticle?.title || focusedArticle.articleTitle}</div>
                    <div className="mt-2 text-[11px] leading-5 text-[#8A735B]">{focusedSavedArticle?.source || '知识库文章'} · {focusedSavedArticle ? formatDate(focusedSavedArticle.savedAt) : '已沉淀内容'}</div>
                    {focusedSavedArticle?.citationContext && (
                      <div className="mt-3 rounded-2xl bg-[#FFFCF7] px-3 py-3">
                        <div className="text-[11px] font-semibold text-[#8A735B]">文章引用背景</div>
                        <div className="mt-2 max-h-28 overflow-y-auto text-[12px] leading-6 text-[#6E5845]">{focusedSavedArticle.citationContext}</div>
                      </div>
                    )}
                    <div className="mt-3 flex flex-wrap gap-2">
                      <span className="rounded-full bg-[#FCF1E1] px-3 py-1 text-[11px] text-[#916A3E]">{articleCardsForDetail.length} 个节点</span>
                      <span className="rounded-full bg-[#FFF6E8] px-3 py-1 text-[11px] text-[#A56B17]">{articleCardsForDetail.filter(card => writeActivatedNodeIds.includes(card.id)).length} 个已激活</span>
                    </div>
                    <div className="mt-3 space-y-2">
                      {articleCardsForDetail.slice(0, 3).map(card => (
                        <button
                          key={card.id}
                          onClick={() => setFocusedNodeId(card.id)}
                          className="w-full rounded-2xl bg-[#FCF8F0] px-3 py-2 text-left transition-colors hover:bg-[#FCF1E1]"
                        >
                          <div className="text-[11px] font-medium text-[#8A735B]">{card.type}</div>
                          <div className="mt-1 text-[12px] leading-5 text-[#3E2B1A] line-clamp-2">{card.content}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
                </div>
              </div>
            )}
            {showBackgroundDrawer && (focusedCard || focusedArticle) && (
              <div className="absolute inset-0 z-40 flex items-center justify-center bg-[#3E2B1A]/20 p-4 backdrop-blur-[2px]">
                <div className="flex h-full max-h-[calc(100%-16px)] w-[520px] max-w-full flex-col overflow-hidden rounded-[24px] border border-[#E6D7BE] bg-white shadow-[0_24px_70px_rgba(120,90,55,0.28)]">
                <div className="flex shrink-0 items-start justify-between gap-3 border-b border-[#F0E2CC] bg-white px-5 py-4">
                  <div>
                    <div className="text-[12px] font-semibold text-[#9A7B55]">背景详情</div>
                    <div className="mt-1 text-[17px] font-semibold leading-7 text-[#3E2B1A] line-clamp-2">{backgroundDrawerTitle}</div>
                  </div>
                  <button
                    onClick={() => setShowBackgroundDrawer(false)}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#FCF4E4] text-[#8F7861] transition-all hover:bg-[#F5E8D0] hover:text-[#6F4E2D] active:scale-95"
                    title="关闭背景详情"
                  >
                    <X size={16} strokeWidth={2.5} />
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
                  <div className="flex flex-wrap gap-2">
                    <span className="rounded-full bg-[#FCF1E1] px-3 py-1 text-[11px] text-[#916A3E]">{focusedCard ? focusedCard.type : `${articleCardsForDetail.length} 个节点`}</span>
                    {focusedSavedArticle?.source && <span className="rounded-full bg-[#FFF6E8] px-3 py-1 text-[11px] text-[#A56B17]">{focusedSavedArticle.source}</span>}
                    {focusedSavedArticle?.savedAt && <span className="rounded-full bg-[#F3EFE6] px-3 py-1 text-[11px] text-[#7B654D]">{formatDate(focusedSavedArticle.savedAt)}</span>}
                  </div>

                  {focusedCard && (
                    <div className="mt-4 rounded-2xl bg-[#FFF9EF] px-4 py-3">
                      <div className="text-[11px] font-semibold text-[#8A735B]">当前知识节点</div>
                      <div className="mt-2 text-[14px] font-semibold leading-7 text-[#3E2B1A]">{focusedCard.content}</div>
                      {focusedCard.summary && <div className="mt-2 text-[12px] leading-6 text-[#6E5845]">{focusedCard.summary}</div>}
                    </div>
                  )}

                  {backgroundDrawerContext && (
                    <div className="mt-4 rounded-2xl bg-[#FFFCF7] px-4 py-3">
                      <div className="text-[11px] font-semibold text-[#8A735B]">完整背景</div>
                      <div className="mt-2 max-h-56 overflow-y-auto overscroll-contain whitespace-pre-wrap pr-1 text-[13px] leading-7 text-[#5F4A38]">{backgroundDrawerContext}</div>
                    </div>
                  )}

                  {focusedCard?.originalQuote && (
                    <div className="mt-4 rounded-2xl border border-[#EBD8B5] bg-white px-4 py-3">
                      <div className="text-[11px] font-semibold text-[#8A735B]">原文摘录</div>
                      <div className="mt-2 max-h-44 overflow-y-auto overscroll-contain whitespace-pre-wrap pr-1 text-[13px] leading-7 text-[#3E2B1A]">{focusedCard.originalQuote}</div>
                    </div>
                  )}

                  {focusedCard?.citationNote && (
                    <div className="mt-4 rounded-2xl bg-[#FFF6E8] px-4 py-3">
                      <div className="text-[11px] font-semibold text-[#8A735B]">引用建议</div>
                      <div className="mt-2 whitespace-pre-wrap text-[13px] leading-7 text-[#6E5845]">{focusedCard.citationNote}</div>
                    </div>
                  )}

                  <div className="mt-4 rounded-2xl bg-[#FCF8F0] px-4 py-3">
                    <div className="text-[11px] font-semibold text-[#8A735B]">同篇文章的知识节点</div>
                    <div className="mt-3 max-h-72 space-y-2 overflow-y-auto overscroll-contain pr-1">
                      {articleCardsForDetail.map(card => (
                        <button
                          key={card.id}
                          onClick={() => setFocusedNodeId(card.id)}
                          className="w-full rounded-2xl bg-white px-3 py-2 text-left transition-colors hover:bg-[#FCF1E1]"
                        >
                          <div className="text-[11px] font-medium text-[#8A735B]">{card.type}</div>
                          <div className="mt-1 text-[12px] leading-5 text-[#3E2B1A]">{card.content}</div>
                        </button>
                      ))}
                    </div>
                  </div>

                  {focusedCard && relatedArticlesForCard.length > 0 && (
                    <div className="mt-4 rounded-2xl bg-[#FFFCF7] px-4 py-3">
                      <div className="text-[11px] font-semibold text-[#8A735B]">关联线索</div>
                      <div className="mt-3 space-y-2">
                        {relatedArticlesForCard.map(item => (
                          <div key={`${item.articleTitle}-${item.count}`} className="rounded-2xl bg-white px-3 py-2 text-[12px] text-[#6E5845]">
                            <div className="font-medium text-[#3E2B1A]">{item.articleTitle}</div>
                            <div className="mt-1 text-[11px] text-[#8A735B]">共享 {item.count} 条语义线索</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
              </div>
            )}
        </div>
      </div>

      {renderAssistantAside()}
    </div>
  );
};
