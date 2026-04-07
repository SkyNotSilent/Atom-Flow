export interface User {
  id: number;
  email: string;
  nickname: string | null;
  avatar_url: string | null;
}

export interface AtomCard {
  id: string;
  type: "观点" | "数据" | "金句" | "故事";
  content: string;
  tags: string[];
  articleTitle: string;
  articleId?: number;
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
