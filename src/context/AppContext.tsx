import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { Article, AtomCard } from '../types';

interface AppState {
  articles: Article[];
  savedCards: AtomCard[];
  saveArticle: (articleId: number) => Promise<void>;
  addCards: (cards: AtomCard[]) => void;
  addCard: (card: AtomCard) => Promise<void>;
  updateCard: (id: string, card: Partial<AtomCard>) => Promise<void>;
  deleteCard: (id: string) => Promise<void>;
  showToast: (msg: string) => void;
  toastMsg: string | null;
  theme: 'light' | 'dark';
  toggleTheme: () => void;
  readingArticle: Article | null;
  setReadingArticle: (article: Article | null) => void;
  activeSource: string | null;
  setActiveSource: (source: string | null) => void;
  reloadArticles: () => Promise<void>;
  isSavingArticle: (articleId: number) => boolean;
  getSavingStageText: (articleId: number) => string | null;
  knowledgeTypeFilter: string;
  setKnowledgeTypeFilter: (filter: string) => void;
  knowledgeSourceFilter: string;
  setKnowledgeSourceFilter: (filter: string) => void;
}

const AppContext = createContext<AppState | undefined>(undefined);

export const AppProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [articles, setArticles] = useState<Article[]>([]);
  const [savedCards, setSavedCards] = useState<AtomCard[]>([]);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [readingArticle, setReadingArticleState] = useState<Article | null>(null);
  const [activeSource, setActiveSource] = useState<string | null>(null);
  const [savingState, setSavingState] = useState<{ articleId: number | null; stage: string | null }>({ articleId: null, stage: null });
  const [knowledgeTypeFilter, setKnowledgeTypeFilter] = useState('来源');
  const [knowledgeSourceFilter, setKnowledgeSourceFilter] = useState('全部');
  const quickOpenMode = true;
  const forceRefetchInTesting = false;
  const saveStages = ['提取全文', '识别要点', '原子化拆分', '提炼入库'];
  const triggerAuthRequired = () => window.dispatchEvent(new CustomEvent('auth-required'));

  const reloadArticles = async () => {
    const articlesRes = await fetch('/api/articles');
    if (articlesRes.ok) {
      const next = await articlesRes.json();
      setArticles(Array.isArray(next) ? next : []);
    }
  };
  
  const setReadingArticle = async (article: Article | null) => {
    setReadingArticleState(article);
    if (quickOpenMode) {
      return;
    }
    
    const shouldForceRefetch = Boolean(article && article.url && forceRefetchInTesting);
    const fullApiUrl = article
      ? `/api/articles/${article.id}/full${shouldForceRefetch ? `?force=1&t=${Date.now()}` : ''}`
      : '';
    if (article && (!article.fullFetched || shouldForceRefetch)) {
      try {
        const res = await fetch(fullApiUrl, { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          setArticles(prev => prev.map(a => a.id === article.id ? data.article : a));
          setReadingArticleState(data.article);
          return;
        }
        const articlesRes = await fetch('/api/articles');
        if (articlesRes.ok) {
          const freshArticles = await articlesRes.json();
          setArticles(freshArticles);
          const matched = freshArticles.find((a: Article) => a.url && article.url && a.url === article.url)
            || freshArticles.find((a: Article) => a.title === article.title);
          if (matched) {
            setReadingArticleState(matched);
            const shouldRefetchMatched = Boolean(matched.url && forceRefetchInTesting);
            if (!matched.fullFetched || shouldRefetchMatched) {
              const retryRes = await fetch(`/api/articles/${matched.id}/full${shouldRefetchMatched ? `?force=1&t=${Date.now()}` : ''}`, { cache: 'no-store' });
              if (retryRes.ok) {
                const data = await retryRes.json();
                setArticles((prev: Article[]) => prev.map(a => a.id === matched.id ? data.article : a));
                setReadingArticleState(data.article);
              }
            }
          }
        }
      } catch (error) {
        console.error("Failed to fetch full article:", error);
      }
    }
  };
  // Fetch initial data
  useEffect(() => {
    const fetchData = async () => {
      try {
        const cardsRes = await fetch('/api/cards');
        await reloadArticles();
        if (cardsRes.ok) {
          const cardsData = await cardsRes.json();
          setSavedCards(Array.isArray(cardsData) ? cardsData : []);
        } else {
          setSavedCards([]);
        }
      } catch (error) {
        console.error("Failed to fetch initial data:", error);
      }
    };
    fetchData();
  }, []);

  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [theme]);

  const toggleTheme = () => setTheme(prev => prev === 'light' ? 'dark' : 'light');

  const saveArticle = async (articleId: number) => {
    if (savingState.articleId !== null) return;
    try {
      setSavingState({ articleId, stage: saveStages[0] });
      const targetArticle = articles.find(a => a.id === articleId);
      if (quickOpenMode && targetArticle?.url) {
        const fullRes = await fetch(`/api/articles/${articleId}/full?force=1&t=${Date.now()}`, { cache: 'no-store' });
        if (fullRes.ok) {
          const fullData = await fullRes.json();
          setArticles(prev => prev.map(a => a.id === articleId ? fullData.article : a));
          if (readingArticle?.id === articleId) {
            setReadingArticleState(fullData.article);
          }
        }
      }
      setSavingState({ articleId, stage: saveStages[1] });
      await new Promise(resolve => setTimeout(resolve, 220));
      setSavingState({ articleId, stage: saveStages[2] });
      const res = await fetch(`/api/articles/${articleId}/save`, { method: 'POST' });
      if (res.ok) {
        setSavingState({ articleId, stage: saveStages[3] });
        // Refresh data to get the new cards and updated article state
        const [articlesRes, cardsRes] = await Promise.all([
          fetch('/api/articles'),
          fetch('/api/cards')
        ]);
        if (articlesRes.ok) {
          const nextArticles = await articlesRes.json();
          setArticles(Array.isArray(nextArticles) ? nextArticles : []);
        }
        if (cardsRes.ok) {
          const nextCards = await cardsRes.json();
          setSavedCards(Array.isArray(nextCards) ? nextCards : []);
        }
      } else if (res.status === 401) {
        triggerAuthRequired();
      }
    } catch (error) {
      console.error("Failed to save article:", error);
    } finally {
      await new Promise(resolve => setTimeout(resolve, 260));
      setSavingState({ articleId: null, stage: null });
    }
  };

  const isSavingArticle = (articleId: number) => savingState.articleId === articleId;
  const getSavingStageText = (articleId: number) => savingState.articleId === articleId ? savingState.stage : null;

  const addCards = (cards: AtomCard[]) => {
    // This is mostly handled by saveArticle now, but keeping for compatibility if needed
    setSavedCards(prev => [...cards, ...prev]);
  };

  const addCard = async (card: AtomCard) => {
    try {
      const res = await fetch('/api/cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(card)
      });
      if (res.ok) {
        const newCard = await res.json();
        setSavedCards(prev => [newCard, ...prev]);
      } else if (res.status === 401) {
        triggerAuthRequired();
      }
    } catch (error) {
      console.error("Failed to add card:", error);
    }
  };

  const updateCard = async (id: string, updated: Partial<AtomCard>) => {
    try {
      const res = await fetch(`/api/cards/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated)
      });
      if (res.ok) {
        const updatedCard = await res.json();
        setSavedCards(prev => prev.map(c => c.id === id ? updatedCard : c));
      } else if (res.status === 401) {
        triggerAuthRequired();
      }
    } catch (error) {
      console.error("Failed to update card:", error);
    }
  };

  const deleteCard = async (id: string) => {
    try {
      const res = await fetch(`/api/cards/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setSavedCards(prev => prev.filter(c => c.id !== id));
      } else if (res.status === 401) {
        triggerAuthRequired();
      }
    } catch (error) {
      console.error("Failed to delete card:", error);
    }
  };

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => {
      setToastMsg(null);
    }, 3000);
  };

  return (
    <AppContext.Provider value={{ 
      articles, savedCards, saveArticle, addCards, addCard, updateCard, deleteCard, 
      showToast, toastMsg, theme, toggleTheme,
      readingArticle, setReadingArticle,
      activeSource, setActiveSource,
      reloadArticles,
      isSavingArticle,
      getSavingStageText,
      knowledgeTypeFilter,
      setKnowledgeTypeFilter,
      knowledgeSourceFilter,
      setKnowledgeSourceFilter
    }}>
      {children}
    </AppContext.Provider>
  );
};

export const useAppContext = () => {
  const context = useContext(AppContext);
  if (context === undefined) {
    throw new Error('useAppContext must be used within an AppProvider');
  }
  return context;
};
