export interface User {
  id: number;
  email: string;
  nickname: string | null;
  avatar_url: string | null;
  has_password?: boolean;
}

export interface Note {
  id: number;
  title: string;
  content: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface AtomCard {
  id: string;
  type: "观点" | "数据" | "金句" | "故事";
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
