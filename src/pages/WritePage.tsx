import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppContext } from '../context/AppContext';
import { AtomCard, NoteSourceReference, SavedArticle, WriteAgentMessage, WriteAgentThreadState } from '../types';
import { cn } from '../components/Nav';
import { FileText, Sparkles, Tag, X, ZoomIn, ZoomOut } from 'lucide-react';
import { NotesPanel } from '../components/NotesPanel';

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
const TOPIC_SUGGESTIONS = ['收藏夹焦虑', '摆脱 AI 腔', '创作者变现'];
const ASSISTANT_QUICK_PROMPTS = ['帮我梳理这个主题的核心观点', '按冲突关系点亮最值得写的内容', '给我一条适合开头的知识路径'];
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
const starPathCache = new Map<string, string>();
const DEFAULT_ASSISTANT_MESSAGES: AssistantMessage[] = [
  { id: 'welcome', role: 'assistant', content: '我会围绕你的知识关系图回答问题，并把 agent 的检索、提纲和写作动作完整记录下来。' }
];

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
const getStarPath = (outerRadius: number, innerRadius: number, points = 4) => {
  const key = `${outerRadius.toFixed(2)}:${innerRadius.toFixed(2)}:${points}`;
  const cached = starPathCache.get(key);
  if (cached) return cached;
  const segments: string[] = [];
  for (let index = 0; index < points * 2; index += 1) {
    const angle = (Math.PI / points) * index - Math.PI / 2;
    const radius = index % 2 === 0 ? outerRadius : innerRadius;
    const x = Number((Math.cos(angle) * radius).toFixed(2));
    const y = Number((Math.sin(angle) * radius).toFixed(2));
    segments.push(`${index === 0 ? 'M' : 'L'} ${x} ${y}`);
  }
  const path = `${segments.join(' ')} Z`;
  starPathCache.set(key, path);
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
    writeFocusedTopic,
    setWriteFocusedTopic,
    writeActivatedNodeIds,
    setWriteActivatedNodeIds,
    writeActivationSummary,
    setWriteActivationSummary
  } = useAppContext();

  const [isRecalling, setIsRecalling] = useState(false);
  const [isGeneratingDraft, setIsGeneratingDraft] = useState(false);
  const [selectedCardIds, setSelectedCardIds] = useState<string[]>([]);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [assistantInput, setAssistantInput] = useState('');
  const [assistantThreadId, setAssistantThreadId] = useState<number | null>(null);
  const [isAssistantThinking, setIsAssistantThinking] = useState(false);
  const [assistantMessages, setAssistantMessages] = useState<AssistantMessage[]>(DEFAULT_ASSISTANT_MESSAGES);
  const [zoom, setZoom] = useState(1);
  const [graphPositions, setGraphPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [draggedNodeId, setDraggedNodeId] = useState<string | null>(null);
  const [hoverTooltip, setHoverTooltip] = useState<{ x: number; y: number; text: string; tone: 'sun' | 'atom' | 'atom-warm' } | null>(null);

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
  }, [setWriteActivatedNodeIds, setWriteActivationSummary, setWriteFocusedTopic]);

  const hydrateThreadMessages = useCallback(async (threadId: number) => {
    try {
      const response = await fetch(`/api/write/agent/threads/${threadId}/messages`);
      if (!response.ok) return;
      const data = await response.json();
      const messages = Array.isArray(data?.messages) ? data.messages : [];
      setAssistantMessages(messages.length > 0 ? messages : DEFAULT_ASSISTANT_MESSAGES);
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
        excerpt: savedArticle?.excerpt || card.content.slice(0, 140),
        savedAt: savedArticle?.savedAt
      });
    });
    return Array.from(byKey.values());
  };
  const activatedSourceArticles = useMemo<NoteSourceReference[]>(() => buildSourceArticles(activatedCards), [activatedCards, savedArticles]);
  useEffect(() => {
    const ensureThread = async () => {
      try {
        const response = await fetch('/api/write/agent/threads', { method: 'GET' });
        if (!response.ok) return;
        const threads = await response.json();
        if (Array.isArray(threads) && threads[0]?.id) {
          const threadId = Number(threads[0].id);
          setAssistantThreadId(threadId);
          await hydrateThreadMessages(threadId);
        }
      } catch {
        // ignore bootstrap errors; thread will be created lazily on first send
      }
    };
    void ensureThread();
  }, [hydrateThreadMessages]);
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

  const handleAssistantSend = async (promptText?: string) => {
    const prompt = (promptText ?? assistantInput).trim();
    if (!prompt) return;
    if (!user) {
      loginAndDo(() => {
        void handleAssistantSend(prompt);
      });
      return;
    }
    // Append user message immediately for responsive UX
    setAssistantMessages(prev => [...prev, { id: `user-${Date.now()}`, role: 'user' as const, content: prompt }]);
    setAssistantInput('');
    setIsAssistantThinking(true);
    try {
      const response = await fetch('/api/write/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threadId: assistantThreadId,
          message: prompt,
          focusedTopic: writeFocusedTopic || undefined,
          activatedNodeIds: writeActivatedNodeIds.length > 0 ? writeActivatedNodeIds : undefined,
          activationSummary: writeActivationSummary.length > 0 ? writeActivationSummary : undefined
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

      const data = await response.json();
      if (data.threadId) {
        const nextThreadId = Number(data.threadId);
        setAssistantThreadId(nextThreadId);
        // Append assistant response directly instead of full hydration to preserve flow
        if (data.assistant?.content) {
          setAssistantMessages(prev => [...prev, { id: `assistant-${Date.now()}`, role: 'assistant' as const, content: data.assistant.content }]);
        }
      }
      if (data.threadState) {
        applyThreadState(data.threadState);
      }
      if (data.note?.id) {
        await reloadNotes();
        showToast(`已生成草稿《${data.note.title || '未命名文章'}》`);
      }
    } catch (error) {
      showToast(error instanceof Error && error.message ? error.message : '网络错误');
    } finally {
      setIsAssistantThinking(false);
    }
  };

  const handleGenerateDraft = async () => {
    if (!user) {
      loginAndDo(() => {
        void handleGenerateDraft();
      });
      return;
    }
    setIsGeneratingDraft(true);
    try {
      const topicInput = writeFocusedTopic.trim() || assistantInput.trim();
      let cardsToUse = activatedCards;

      if (cardsToUse.length === 0 && topicInput) {
        const recalledCards = await handleRecall(topicInput);
        const keywords = topicInput.toLowerCase().split(/[\s，。,.!?！？、]+/).filter(Boolean);
        const localMatched = visibleCards.filter(card => {
          const text = `${card.content} ${(card.tags || []).join(' ')} ${card.articleTitle || ''}`.toLowerCase();
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

      const response = await fetch('/api/write/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threadId: assistantThreadId || undefined,
          message: derivedTopic,
          focusedTopic: derivedTopic,
          activatedNodeIds: cardsToUse.map(card => card.id),
          activationSummary: buildActivationSummary(cardsToUse),
          action: 'create_article'
        })
      });

      if (!response.ok) {
        const errorMessage = await getErrorMessageFromResponse(
          response,
          response.status === 401 ? '请先登录后再生成文章' : '文章生成失败，请稍后重试'
        );
        showToast(errorMessage);
        return;
      }

      const data = await response.json();

      if (data.threadId && data.threadId !== assistantThreadId) {
        setAssistantThreadId(data.threadId);
      }
      if (data.threadState) {
        applyThreadState(data.threadState);
      }

      if (data.assistantMessage) {
        setAssistantMessages(prev => [...prev, { id: `assistant-draft-${Date.now()}`, role: 'assistant' as const, content: data.assistantMessage }]);
      }

      if (data.noteCreated && data.note?.id) {
        await reloadNotes();
        setWriteWorkspaceMode('articles');
        showToast('文章已创建，可在「我的文章」中查看和编辑');
      } else if (data.assistantMessage) {
        showToast('Agent 建议先继续讨论，请查看对话');
      } else {
        showToast('文章创建失败，请稍后重试');
      }
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

  const renderToolMessage = (message: AssistantMessage) => {
    const tools = message.meta?.requestedTools || message.meta?.tools || [];
    const outline = Array.isArray(message.meta?.outline) ? message.meta?.outline : [];
    const draftPreview = message.meta?.draftPreview || '';
    return (
      <div className="self-start max-w-[94%] rounded-2xl border border-[#E8D9BE] bg-[#FFF9ED] px-4 py-3 text-[12px] leading-6 text-[#6D5741]">
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#A6875E]">Agent Actions</div>
        {tools.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {tools.map(tool => (
              <span key={tool} className="rounded-full border border-[#E8D9BE] bg-white px-2.5 py-1 text-[11px] text-[#7B6245]">
                {tool}
              </span>
            ))}
          </div>
        ) : null}
        {message.meta?.reason ? (
          <div className="mt-2 text-[11px] text-[#8D7457]">{message.meta.reason}</div>
        ) : null}
        {outline.length > 0 ? (
          <div className="mt-3 grid gap-2">
            {outline.map(item => (
              <div key={`${item.heading}-${item.goal}`} className="rounded-xl bg-white/80 px-3 py-2">
                <div className="text-[12px] font-medium text-[#4B3621]">{item.heading}</div>
                <div className="mt-1 text-[11px] leading-5 text-[#8B745C]">{item.goal}</div>
              </div>
            ))}
          </div>
        ) : null}
        {draftPreview ? (
          <div className="mt-3 rounded-xl border border-[#F0E3CA] bg-white px-3 py-2 whitespace-pre-wrap text-[11px] leading-5 text-[#6B5641]">
            {draftPreview}
          </div>
        ) : null}
        {message.meta?.noteSaved && message.meta?.noteTitle ? (
          <div className="mt-3 rounded-xl bg-[#FFF2D8] px-3 py-2 text-[11px] text-[#8A5B1F]">
            已落成文章：{message.meta.noteTitle}
          </div>
        ) : null}
      </div>
    );
  };

  const renderAssistantAside = () => (
    <aside className="hidden min-h-0 w-[360px] shrink-0 overflow-hidden rounded-[28px] border border-border bg-surface xl:flex xl:flex-col">
      <div className="border-b border-border px-5 py-4">
        <div className="text-[15px] font-semibold text-text-main">Chat 助手</div>
        <div className="mt-1 text-[12px] text-text3">主题聚焦放在这里。每次提问都会驱动知识关系图激活，并生成带引用标记的文章草稿。</div>
      </div>
      <div className="flex flex-wrap gap-2 px-5 pt-4">
        {TOPIC_SUGGESTIONS.map(suggestion => (
          <button
            key={suggestion}
            onClick={() => {
              setAssistantInput(suggestion);
            }}
            className="rounded-full bg-surface2 px-3 py-1.5 text-[11px] text-text2 transition-colors hover:bg-accent-light hover:text-accent"
          >
            {suggestion}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2 px-5 pt-2">
        {ASSISTANT_QUICK_PROMPTS.map(prompt => (
          <button
            key={prompt}
            onClick={() => {
              setAssistantInput(prompt);
            }}
            className="rounded-full border border-border bg-bg px-3 py-1.5 text-[11px] text-text2 transition-colors hover:border-accent hover:text-accent"
          >
            {prompt}
          </button>
        ))}
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
                  'max-w-[92%] rounded-2xl px-4 py-3 text-[13px] leading-6',
                  message.role === 'assistant'
                    ? 'self-start bg-surface2 text-text-main'
                    : 'self-end bg-accent-light text-accent'
                )}
              >
                <div>{message.content}</div>
              </div>
            )
          ))}
          {isRecalling && (
            <div className="self-start rounded-2xl bg-surface2 px-4 py-3 text-[13px] text-text3">
              正在聚焦相关知识节点...
            </div>
          )}
          {isAssistantThinking && (
            <div className="self-start rounded-2xl bg-surface2 px-4 py-3 text-[13px] text-text3">
              助手正在结合当前线程和激活网络思考...
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
          placeholder="和写作助手对话，积累素材后点击创建文章"
          className="h-24 w-full resize-none rounded-2xl border border-border bg-bg px-3 py-3 text-[13px] text-text-main outline-none transition-colors focus:border-accent"
        />
        <button
          onClick={() => void handleAssistantSend()}
          disabled={!assistantInput.trim() || isRecalling || isAssistantThinking}
          className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-accent px-4 py-3 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Sparkles size={14} />
          {user ? '发送' : '登录后使用写作助手'}
        </button>
        <button
          onClick={() => void handleGenerateDraft()}
          disabled={isRecalling || isGeneratingDraft}
          className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-border bg-bg px-4 py-3 text-[13px] font-medium text-text-main transition-colors hover:bg-surface2 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <FileText size={14} />
          {isGeneratingDraft ? '正在创建文章...' : user ? '创建文章' : '登录后创建文章'}
        </button>
      </div>
    </aside>
  );

  if (writeWorkspaceMode === 'articles') {
    return (
      <div className="flex h-full min-h-0 gap-4 bg-bg">
        <div id="page-write" className="flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-[28px] border border-border bg-surface">
          <div className="border-b border-border px-5 py-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-[15px] font-semibold text-text-main">我的文章</div>
                <div className="mt-1 text-[12px] text-text3">统一存放 AI 生成、手写草稿和可继续修改的 Markdown 文章。</div>
              </div>
              <div className="rounded-2xl border border-border bg-bg px-3 py-2 text-right text-[11px] text-text3">
                <div>{notes.length} 篇文档</div>
                <div className="mt-1">最近更新 {recentNotes[0] ? formatDate(recentNotes[0].updated_at || recentNotes[0].created_at) : '暂无'}</div>
              </div>
            </div>
          </div>
          <div className="min-h-0 flex-1">
            <NotesPanel />
          </div>
        </div>
        {renderAssistantAside()}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 gap-4 bg-bg">
      <div id="page-write" className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[30px] border border-[#E7DAC0] bg-[#FBF7EF] shadow-[0_20px_48px_rgba(150,120,78,0.1)]">
        <div className="border-b border-[#E9DFC9] bg-[#FFFCF5] px-5 py-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[15px] font-semibold text-[#3C2A19]">知识关系图</div>
              <div className="mt-1 text-[12px] text-[#8B745C]">平面的 2D 受力系统。文章拆成原子星点，父子天然相连，跨节点只保留真实语义连接。</div>
            </div>
            <div className="flex items-center gap-2">
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
                  <Sparkles size={24} />
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
                  const innerRadius = outerRadius * 0.46;
                  const isWarm = node.card.type === '金句' || node.card.type === '故事';
                  const rotation = ((node.orbitAngle ?? 0) * 180) / Math.PI + 45;
                  const starPath = getStarPath(outerRadius, innerRadius);
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
                        updateHoverTooltip(event, `${node.card.type} · ${truncateText(node.card.content, 20)}`, isWarm ? 'atom-warm' : 'atom');
                      }}
                      onMouseMove={event => updateHoverTooltip(event, `${node.card.type} · ${truncateText(node.card.content, 20)}`, isWarm ? 'atom-warm' : 'atom')}
                      onMouseLeave={() => {
                        setHoveredNodeId(null);
                        setHoverTooltip(null);
                      }}
                      onPointerDown={event => beginNodeDrag(event, node.id, 'card')}
                      onPointerMove={event => moveNodeDrag(event, node.id)}
                      onPointerUp={endNodeDrag}
                      onPointerCancel={endNodeDrag}
                    >
                      <circle r={12} fill="rgba(255,255,255,0.001)" stroke="none" />
                      <title>{`${node.card.type} · ${node.card.content}`}</title>
                      <g transform={`rotate(${rotation})`}>
                        {(isFocused || isDragging || isActivated) && (
                          <path
                            d={getStarPath(outerRadius + 3.4, innerRadius + 1.5)}
                            fill="none"
                            stroke={colors.main}
                            strokeOpacity="0.2"
                            strokeWidth="1.05"
                          />
                        )}
                        <path
                          d={starPath}
                          fill={colors.bg}
                          stroke={colors.main}
                          strokeWidth={isFocused || isDragging ? 1.5 : 1.2}
                        />
                        <circle
                          r={outerRadius * 0.18}
                          fill={colors.main}
                          opacity={0.88}
                        />
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
              <div className="absolute bottom-16 right-5 z-20 w-[360px] max-w-[calc(100%-40px)] rounded-2xl border border-[#E6D7BE] bg-white/96 p-4 shadow-[0_20px_50px_rgba(150,120,78,0.12)] backdrop-blur">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2 text-[13px] font-semibold text-[#3E2B1A]">
                    {focusedCard ? <Tag size={15} /> : <FileText size={15} />}
                    {focusedCard ? '知识节点' : '文章节点'}
                  </div>
                  <button
                    onClick={() => setFocusedNodeId(null)}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[#8F7861] transition-colors hover:bg-[#FCF4E4]"
                  >
                    <X size={14} />
                  </button>
                </div>

                {focusedCard ? (
                  <div className="mt-4">
                    <div className="text-[15px] font-semibold leading-7 text-[#3E2B1A]">{focusedCard.content}</div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <span className="rounded-full bg-[#FCF1E1] px-3 py-1 text-[11px] text-[#916A3E]">{focusedCard.type}</span>
                      {(focusedCard.tags || []).slice(0, 4).map(tag => (
                        <span key={tag} className="rounded-full bg-[#FFF6E8] px-3 py-1 text-[11px] text-[#A56B17]">#{tag}</span>
                      ))}
                    </div>
                    <div className="mt-4 rounded-2xl bg-[#FCF8F0] px-3 py-3">
                      <div className="text-[11px] font-semibold text-[#8A735B]">所属文章</div>
                      <div className="mt-2 text-[12px] font-medium leading-6 text-[#3E2B1A] line-clamp-2">{focusedSavedArticle?.title || focusedCard.articleTitle || '未命名文章'}</div>
                    </div>
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
                  <div className="mt-4">
                    <div className="text-[15px] font-semibold leading-7 text-[#3E2B1A]">{focusedSavedArticle?.title || focusedArticle.articleTitle}</div>
                    <div className="mt-2 text-[11px] leading-5 text-[#8A735B]">{focusedSavedArticle?.source || '知识库文章'} · {focusedSavedArticle ? formatDate(focusedSavedArticle.savedAt) : '已沉淀内容'}</div>
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
            )}
        </div>
      </div>

      {renderAssistantAside()}
    </div>
  );
};
