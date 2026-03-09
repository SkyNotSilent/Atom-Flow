import { Article, AtomCard } from '../types';

const normalizeSource = (source?: string) => (source || '').trim();

export const inferSourceByUrl = (url?: string) => {
  if (!url) return '';
  if (url.includes('woshipm.com')) return '人人都是产品经理';
  if (url.includes('36kr.com')) return '36氪';
  if (url.includes('huxiu.com')) return '虎嗅';
  if (url.includes('sspai.com')) return '少数派';
  return '';
};

export const getDisplaySource = (article: Article) => {
  const normalized = normalizeSource(article.source);
  return normalized || inferSourceByUrl(article.url) || '未知来源';
};

export const sourceMatches = (article: Article, selectedSource: string) => {
  const selected = normalizeSource(selectedSource);
  if (!selected) return true;
  const display = normalizeSource(getDisplaySource(article));
  if (display === selected) return true;
  const raw = normalizeSource(article.source);
  if (raw === selected) return true;
  if (selected === '人人都是产品经理' && article.url?.includes('woshipm.com')) return true;
  if (selected === '36氪' && article.url?.includes('36kr.com')) return true;
  if (selected === '虎嗅' && article.url?.includes('huxiu.com')) return true;
  if (selected === '少数派' && article.url?.includes('sspai.com')) return true;
  return false;
};

export const getCardSourceLabel = (card: AtomCard, articles: Article[]) => {
  const article = findLinkedArticle(card, articles);
  if (!article) return '未知来源';
  return getDisplaySource(article);
};

export const getKnowledgeLinkedArticles = (savedCards: AtomCard[], articles: Article[]) => {
  const usedArticleIds = new Set<number>();
  const usedTitles = new Set<string>();
  for (const card of savedCards) {
    if (card.articleId) usedArticleIds.add(card.articleId);
    const normalizedTitle = (card.articleTitle || '').trim();
    if (normalizedTitle && normalizedTitle !== '手动录入') {
      usedTitles.add(normalizedTitle);
    }
  }
  return articles
    .filter(article => usedArticleIds.has(article.id) || usedTitles.has((article.title || '').trim()))
    .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))
    .map(article => ({
      id: article.id,
      title: article.title,
      source: getDisplaySource(article),
      publishedAt: article.publishedAt ?? 0
    }));
};

export const findLinkedArticle = (card: AtomCard, articles: Article[]) => {
  if (card.articleId) {
    const byId = articles.find(item => item.id === card.articleId);
    if (byId) return byId;
  }
  const normalizedTitle = (card.articleTitle || '').trim();
  if (!normalizedTitle || normalizedTitle === '手动录入') return undefined;
  return articles.find(item => (item.title || '').trim() === normalizedTitle);
};
