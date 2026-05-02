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
  articleTitle: string;
  articleId?: number;
  tags: string[];
}

export interface NoteSourceReference {
  savedArticleId?: number;
  articleId?: number;
  title: string;
  source: string;
  url?: string;
  excerpt?: string;
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
  tags: string[];
  articleTitle: string;
  articleId?: number;
  origin?: 'manual' | 'ai';
  savedArticleId?: number;
}

export interface SavedArticle {
  id: number;
  title: string;
  url?: string;
  source: string;
  sourceIcon?: string;
  topic: string;
  excerpt: string;
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
  requestedTools?: string[];
  tools?: string[];
  reason?: string;
  activeCardIds?: string[];
  recalledCardIds?: string[];
  outline?: NoteOutlineSection[];
  draftPreview?: string;
  noteId?: number;
  noteTitle?: string;
  noteSaved?: boolean;
  noteTopic?: string;
}

export interface WriteAgentThreadState {
  focusedTopic?: string;
  activatedNodeIds?: string[];
  activationSummary?: string[];
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
  created_at: string;
  updated_at: string;
}

export interface WriteAgentMessage {
  id: number | string;
  role: 'assistant' | 'user' | 'tool';
  content: string;
  meta?: WriteAgentToolResult & {
    state?: WriteAgentThreadState;
  };
  created_at?: string;
}
