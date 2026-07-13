export interface User {
  id: number;
  email: string;
  nickname: string | null;
  avatar_url: string | null;
  has_password?: boolean;
}

export interface NoteActivationNode {
  id: string;
  type: AtomCard['type'];
  content: string;
  summary?: string;
  originalQuote?: string;
  context?: string;
  citationNote?: string;
  evidenceRole?: string;
  articleTitle: string;
  articleId?: number;
  savedArticleId?: number;
  sourceName?: string;
  sourceUrl?: string;
  sourceImages?: string[];
  tags: string[];
}

export interface NoteSourceReference {
  savedArticleId?: number;
  articleId?: number;
  title: string;
  source: string;
  url?: string;
  excerpt?: string;
  citationContext?: string;
  sourceImages?: string[];
  savedAt?: string;
}

export interface NoteOutlineSection {
  heading: string;
  goal: string;
}

export interface NoteEvidenceMapping {
  section: string;
  nodeIds: string[];
  note: string;
}

export interface NoteMeta {
  topic?: string;
  style?: string;
  outline?: NoteOutlineSection[];
  activationSummary?: string[];
  activatedNodes?: NoteActivationNode[];
  evidenceMap?: NoteEvidenceMapping[];
  sourceArticles?: NoteSourceReference[];
  styleSkillSnapshot?: WriteAgentSkillSnapshot;
  skillSnapshots?: WriteAgentSkillSnapshot[];
}

export interface Note {
  id: number;
  title: string;
  content: string;
  tags: string[];
  meta?: NoteMeta;
  created_at: string;
  updated_at: string;
}

export interface AtomCard {
  id: string;
  type: "观点" | "数据" | "金句" | "故事" | "灵感";
  content: string;
  summary?: string;
  originalQuote?: string;
  context?: string;
  citationNote?: string;
  evidenceRole?: string;
  tags: string[];
  articleTitle: string;
  articleId?: number;
  origin?: 'manual' | 'ai';
  savedArticleId?: number;
  sourceName?: string;
  sourceUrl?: string;
  sourceExcerpt?: string;
  sourceContext?: string;
  sourceImages?: string[];
  publishedAt?: number;
  savedAt?: string;
}

export interface SavedArticle {
  id: number;
  title: string;
  url?: string;
  source: string;
  sourceIcon?: string;
  topic: string;
  excerpt: string;
  citationContext?: string;
  sourceImages?: string[];
  content?: string;
  publishedAt?: number;
  savedAt: string;
}

export interface Article {
  id: number;
  saved: boolean;
  source: string;
  sourceIcon?: string;
  topic: string;
  time: string;
  publishedAt?: number;
  title: string;
  excerpt: string;
  citationContext?: string;
  sourceImages?: string[];
  content: string;
  markdownContent?: string;
  url?: string;
  audioUrl?: string;
  audioDuration?: string;
  fullFetched?: boolean;
  readabilityUsed?: boolean;
  cards: Omit<AtomCard, "id" | "articleTitle" | "articleId">[];
}

export interface WriteAgentToolResult {
  runId?: string;
  requestedTools?: string[];
  tools?: string[];
  intent?: string;
  reason?: string;
  activeCardIds?: string[];
  recalledCardIds?: string[];
  outline?: NoteOutlineSection[];
  draftPreview?: string;
  noteId?: number;
  noteTitle?: string;
  noteSaved?: boolean;
  noteTopic?: string;
  uiBlocks?: WriteAgentUiBlock[];
  choices?: WriteAgentChoice[];
  sources?: WriteAgentSources;
  graphTrace?: WriteAgentGraphTraceItem[];
  skillSnapshots?: WriteAgentSkillSnapshot[];
  effectiveSkills?: WriteAgentSkillSnapshot[];
  effectiveSkillSnapshots?: {
    baselineSkills: WriteAgentSkillSnapshot[];
    userSelectedSkills: WriteAgentSkillSnapshot[];
  };
  runtime?: string;
  provider?: string;
  model?: string;
}

export interface WriteAgentThreadState {
  focusedTopic?: string;
  activatedNodeIds?: string[];
  activationSummary?: string[];
  selectedStyleSkillId?: number | string;
  selectedSkillIds?: Array<number | string>;
  effectiveSkillIds?: Array<number | string>;
  writingGoal?: string;
  pendingChoice?: WriteAgentPendingChoice;
  selectedCardIds?: string[];
  sourceImageIds?: string[];
  lastIntent?: string;
  latestOutline?: NoteOutlineSection[];
  latestAngle?: string;
  lastGeneratedNoteId?: number;
  lastGeneratedNoteTitle?: string;
}

export interface WriteAgentThread {
  id: number;
  title: string;
  summary?: string;
  state?: WriteAgentThreadState;
  thread_type: 'chat' | 'skill';
  created_at: string;
  updated_at: string;
}

export interface WriteAgentMessage {
  id: number | string;
  role: 'assistant' | 'user' | 'tool';
  content: string;
  meta?: WriteAgentToolResult & {
    state?: WriteAgentThreadState;
    run?: {
      id: string;
      status: 'running' | 'done' | 'error';
      collapsed: boolean;
      message?: string;
      steps: Array<{
        node: string;
        label: string;
        status: 'running' | 'done' | 'error';
        durationMs?: number;
        outputSummary?: string;
      }>;
    };
    feedback?: 'liked' | 'disliked' | 'none';
    messageId?: number | string;
    sourceCollapsed?: boolean;
  };
  created_at?: string;
}

export type WriteCanvasNodeKind =
  | 'asset_text'
  | 'asset_file'
  | 'asset_image'
  | 'saved_article'
  | 'atom_card'
  | 'note'
  | 'agent'
  | 'result';

export interface WriteCanvasProject {
  id: number;
  name: string;
  viewport?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
}

export interface WriteCanvasAsset {
  id: number;
  type: 'text' | 'file' | 'image';
  title: string;
  contentText?: string;
  extractedText?: string;
  fileName?: string;
  mimeType?: string;
  dataUrl?: string;
  meta?: Record<string, unknown>;
  createdAt: string;
}

export interface WriteAgentTemplate {
  id: number;
  name: string;
  model: string;
  systemPrompt: string;
  temperature: number;
  topP: number;
  maxTokens: number;
  createdAt: string;
  updatedAt: string;
}

export interface WriteAgentInstance {
  id: number;
  projectId: number;
  templateId?: number | null;
  name: string;
  model: string;
  systemPrompt: string;
  temperature: number;
  topP: number;
  maxTokens: number;
  createdAt: string;
  updatedAt: string;
}

export interface WriteCanvasNode {
  id: number;
  projectId: number;
  kind: WriteCanvasNodeKind;
  role: 'material' | 'insight' | 'task' | 'document' | 'group';
  contentType: string;
  origin: 'existing' | 'extracted' | 'manual' | 'generated';
  status: 'parsing' | 'ready' | 'running' | 'pending_review' | 'adopted' | 'rejected' | 'editing' | 'completed' | 'failed';
  businessRef?: string | null;
  title: string;
  summary?: string;
  refId?: string | number | null;
  asset?: WriteCanvasAsset | null;
  agent?: WriteAgentInstance | null;
  document?: WriteCanvasDocument | null;
  meta?: Record<string, unknown>;
  x: number;
  y: number;
  width: number;
  height: number;
  createdAt: string;
  updatedAt: string;
}

export interface WriteCanvasDocumentSection {
  key: string;
  heading: string;
  body: string;
  level: number;
  meta: Record<string, unknown>;
}

export interface WriteCanvasDocument {
  id: number;
  projectId: number;
  nodeId: number;
  title: string;
  summary: string;
  scenario: string;
  status: 'parsing' | 'ready' | 'running' | 'pending_review' | 'adopted' | 'rejected' | 'editing' | 'completed' | 'failed';
  currentVersionId?: number | null;
  sections: WriteCanvasDocumentSection[];
  createdAt: string;
  updatedAt: string;
}

export interface WriteCanvasEdge {
  id: number;
  projectId: number;
  sourceNodeId: number;
  targetNodeId: number;
  relation: 'context' | 'derived_from' | 'generated' | 'structure';
  createdAt: string;
}

export interface WriteCanvasMessage {
  id: number;
  agentId: number;
  role: 'user' | 'assistant';
  content: string;
  meta?: Record<string, unknown>;
  createdAt: string;
}

export type WriteCanvasAgentRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type WriteCanvasAgentBatchStatus = WriteCanvasAgentRunStatus | 'partial';
export type WriteCanvasAgentGroupStatus = 'ready' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';

export interface WriteCanvasAgentRun {
  id: number;
  projectId: number;
  groupId?: number | null;
  groupMemberId?: number | null;
  batchId?: number | null;
  sourceNodeId?: number | null;
  action: string;
  status: WriteCanvasAgentRunStatus;
  contextSnapshot: Record<string, unknown>;
  configSnapshot: Record<string, unknown>;
  output?: string;
  error?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WriteCanvasAgentGroupMember {
  id: number;
  projectId: number;
  name: string;
  model: string;
  systemPrompt: string;
  temperature: number;
  topP: number;
  maxTokens: number;
  createdAt: string;
  updatedAt: string;
}

export interface WriteCanvasAgentGroup {
  id: number;
  projectId: number;
  nodeId: number;
  name: string;
  sharedPrompt: string;
  status: WriteCanvasAgentGroupStatus;
  configSnapshot: Record<string, unknown>;
  members: WriteCanvasAgentGroupMember[];
  createdAt: string;
  updatedAt: string;
}

export interface WriteCanvasAgentBatch {
  id: number;
  projectId: number;
  groupId: number;
  message: string;
  contextNodeIds: number[];
  status: WriteCanvasAgentBatchStatus;
  contextSnapshot: Record<string, unknown>;
  configSnapshot: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WriteCanvasProjectDetail {
  project: WriteCanvasProject;
  nodes: WriteCanvasNode[];
  edges: WriteCanvasEdge[];
  messages: Record<number, WriteCanvasMessage[]>;
}

export type WriteAgentSkillType = 'card_storage' | 'citation' | 'writing' | 'style';
export type WriteAgentSkillScenario = 'storage' | 'citation' | 'drafting' | 'style';

export interface WriteAgentSkillSnapshot {
  id?: number | string;
  name: string;
  type?: WriteAgentSkillType;
  scenario?: WriteAgentSkillScenario;
  description?: string;
  prompt: string;
  examples?: string[];
  constraints?: string[];
  isBaseline?: boolean;
}

export interface WriteAgentSkill extends WriteAgentSkillSnapshot {
  id: number | string;
  type: WriteAgentSkillType;
  scenario?: WriteAgentSkillScenario;
  visibility: 'system' | 'user';
  isDefault?: boolean;
  isBaseline?: boolean;
  usageCount?: number;
  lastUsedAt?: string;
  recentNotes?: Array<{ id: number; title: string; updatedAt?: string }>;
  recentCards?: Array<{ id: string; content: string; articleTitle?: string; createdAt?: string }>;
  generatedPrompt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export type WriteStyleSkillSnapshot = WriteAgentSkillSnapshot;
export type WriteStyleSkill = WriteAgentSkill;

export interface WriteAgentChoice {
  id: string;
  label: string;
  action: 'use_cards' | 'exclude_card' | 'refresh_cards' | 'generate_outline' | 'generate_draft' | 'select_style' | 'export_to_draft' | 'switch_style' | 'smart_reply';
  payload?: Record<string, unknown>;
}

export interface WriteAgentPendingChoice {
  type: 'card_selection' | 'style_selection' | 'draft_confirmation';
  prompt: string;
  cardIds?: string[];
  styleSkillIds?: Array<number | string>;
  createdAt?: string;
}

export interface WriteAgentSourceArticle {
  id?: number;
  title: string;
  source?: string;
  url?: string;
  citationContext?: string;
  imageUrls?: string[];
}

export interface WriteAgentSources {
  cards: AtomCard[];
  articles: WriteAgentSourceArticle[];
  quotes: Array<{
    cardId: string;
    articleTitle?: string;
    quote: string;
  }>;
  images: Array<{
    id: string;
    url: string;
    articleTitle?: string;
  }>;
}

export interface WriteAgentGraphTraceItem {
  node: string;
  durationMs: number;
  inputSummary?: string;
  outputSummary?: string;
  meta?: Record<string, unknown>;
  createdAt?: string;
}

export type WriteAgentUiBlock =
  | { type: 'answer'; markdown: string }
  | { type: 'source_gallery'; images: WriteAgentSources['images'] }
  | { type: 'card_selector'; cards: AtomCard[]; selectedCardIds: string[] }
  | { type: 'action_bar'; choices: WriteAgentChoice[] }
  | { type: 'draft_created'; noteId: number; noteTitle: string };
