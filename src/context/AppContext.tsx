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
  activeTopic: string;
  setActiveTopic: (topic: string) => void;
}

const AppContext = createContext<AppState | undefined>(undefined);

export const AppProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [articles, setArticles] = useState<Article[]>([]);
  const [savedCards, setSavedCards] = useState<AtomCard[]>([]);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [readingArticle, setReadingArticleState] = useState<Article | null>(null);
  
  const setReadingArticle = async (article: Article | null) => {
    setReadingArticleState(article);
    
    // If we just selected an article and it hasn't been fully fetched yet
    if (article && !article.fullFetched) {
      try {
        const res = await fetch(`/api/articles/${article.id}/full`);
        if (res.ok) {
          const data = await res.json();
          // Update the articles list with the fetched full content
          setArticles(prev => prev.map(a => a.id === article.id ? data.article : a));
          // Update the currently reading article state so the UI re-renders
          setReadingArticleState(data.article);
        }
      } catch (error) {
        console.error("Failed to fetch full article:", error);
      }
    }
  };
  const [activeTopic, setActiveTopic] = useState('全部');

  // Fetch initial data
  useEffect(() => {
    const fetchData = async () => {
      try {
        const [articlesRes, cardsRes] = await Promise.all([
          fetch('/api/articles'),
          fetch('/api/cards')
        ]);
        const articlesData = await articlesRes.json();
        const cardsData = await cardsRes.json();
        setArticles(articlesData);
        setSavedCards(cardsData);
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
    try {
      const res = await fetch(`/api/articles/${articleId}/save`, { method: 'POST' });
      if (res.ok) {
        // Refresh data to get the new cards and updated article state
        const [articlesRes, cardsRes] = await Promise.all([
          fetch('/api/articles'),
          fetch('/api/cards')
        ]);
        setArticles(await articlesRes.json());
        setSavedCards(await cardsRes.json());
      }
    } catch (error) {
      console.error("Failed to save article:", error);
    }
  };

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
      activeTopic, setActiveTopic
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
