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
  topic: string;
  time: string;
  publishedAt?: number;
  title: string;
  excerpt: string;
  content: string;
  markdownContent?: string;
  url?: string;
  fullFetched?: boolean;
  readabilityUsed?: boolean;
  cards: Omit<AtomCard, "id" | "articleTitle" | "articleId">[];
}
