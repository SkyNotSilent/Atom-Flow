export type UserScopedExtractionSkill = {
  type: string;
};

export type UserScopedExtractionCard = {
  tags?: string[];
};

export type UserScopedCardExtractionResult<TCard, TSkill> = {
  cards: TCard[];
  articleCitationContext: string;
  origin: "ai" | "manual";
  extractionSkills: TSkill[];
};

type ExtractCardsForUserOptions<TArticle, TCard extends UserScopedExtractionCard, TSkill extends UserScopedExtractionSkill> = {
  article: TArticle;
  userId: number;
  defaultArticleCitationContext: string;
  resolveSkills: (userId: number) => Promise<TSkill[]>;
  extractWithAI: (article: TArticle, skills: TSkill[]) => Promise<{
    cards: TCard[];
    articleCitationContext?: string;
  }>;
  buildFallbackCards: (article: TArticle) => TCard[];
  fallbackDisabled: boolean;
};

/**
 * Extract cards for one user's save operation.
 *
 * Deliberately does not inspect or mutate `article.cards`: built-in RSS articles are
 * shared process state, while extraction Skills and generated cards are user-scoped.
 */
export const extractCardsForUser = async <
  TArticle,
  TCard extends UserScopedExtractionCard,
  TSkill extends UserScopedExtractionSkill,
>(options: ExtractCardsForUserOptions<TArticle, TCard, TSkill>): Promise<UserScopedCardExtractionResult<TCard, TSkill> | null> => {
  const extractionSkills = (await options.resolveSkills(options.userId))
    .filter(skill => skill.type === "card_storage" || skill.type === "citation");
  const extracted = await options.extractWithAI(options.article, extractionSkills);
  const articleCitationContext = extracted.articleCitationContext || options.defaultArticleCitationContext;

  if (extracted.cards.length > 0) {
    return {
      cards: extracted.cards,
      articleCitationContext,
      origin: "ai",
      extractionSkills,
    };
  }

  if (options.fallbackDisabled) return null;

  return {
    cards: options.buildFallbackCards(options.article).map(card => ({
      ...card,
      tags: Array.from(new Set([...(card.tags || []), "自动提取"])),
    })),
    articleCitationContext,
    origin: "manual",
    extractionSkills,
  };
};
