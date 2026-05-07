import React, { createContext, useContext, useState, useEffect, useRef, useCallback, ReactNode } from 'react';
import { Article, AtomCard, User, Note, NoteMeta, SavedArticle, WriteAgentSkill, WriteAgentThread } from '../types';
import { logger } from '../utils/logger';

export type WriteWorkspaceMode = 'graph' | 'articles' | 'skills';
export type WriteGraphView = 'all' | 'activated';

interface AppState {
  articles: Article[];
  savedCards: AtomCard[];
  savedArticles: SavedArticle[];
  saveArticle: (articleId: number) => Promise<boolean>;
  addCards: (cards: AtomCard[]) => void;
  addCard: (card: AtomCard) => Promise<void>;
  updateCard: (id: string, card: Partial<AtomCard>) => Promise<void>;
  deleteCard: (id: string) => Promise<void>;
  showToast: (msg: string) => void;
  toastMsg: string | null;
  theme: 'light' | 'dark';
  toggleTheme: () => void;
  viewMode: 'card' | 'compact';
  setViewMode: (mode: 'card' | 'compact') => void;
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
  user: User | null;
  isAuthLoading: boolean;
  showLoginModal: boolean;
  setShowLoginModal: (show: boolean) => void;
  loginAndDo: (action: () => void) => void;
  handleLoginSuccess: (user: User) => void;
  logout: () => Promise<void>;
  updateProfile: (nickname: string) => Promise<void>;
  updateAvatar: (file: File) => Promise<void>;
  showProfileModal: boolean;
  setShowProfileModal: (show: boolean) => void;
  notes: Note[];
  reloadNotes: () => Promise<void>;
  createNote: (data?: Partial<{ title: string; content: string; tags: string[]; meta: NoteMeta }>) => Promise<Note | null>;
  updateNote: (id: number, data: Partial<{ title: string; content: string; tags: string[]; meta: NoteMeta }>) => Promise<void>;
  deleteNote: (id: number) => Promise<void>;
  syncPreferences: (prefs: { source_layout?: any; theme?: string; view_mode?: string }) => void;
  writeWorkspaceMode: WriteWorkspaceMode;
  setWriteWorkspaceMode: (mode: WriteWorkspaceMode) => void;
  writeGraphView: WriteGraphView;
  setWriteGraphView: (view: WriteGraphView) => void;
  writeFocusedTopic: string;
  setWriteFocusedTopic: (topic: string) => void;
  writeActivatedNodeIds: string[];
  setWriteActivatedNodeIds: (ids: string[]) => void;
  writeActivationSummary: string[];
  setWriteActivationSummary: (items: string[]) => void;
  assistantThreads: WriteAgentThread[];
  assistantThreadId: number | null;
  setAssistantThreadId: (id: number | null) => void;
  loadAssistantThreads: (threadType?: 'chat' | 'skill') => Promise<WriteAgentThread[]>;
  createAssistantThread: (threadType?: 'chat' | 'skill') => Promise<WriteAgentThread | null>;
  writeAgentSkills: WriteAgentSkill[];
  selectedStyleSkillId: number | string;
  setSelectedStyleSkillId: (id: number | string) => void;
  selectedSkillIds: Array<number | string>;
  setSelectedSkillIds: (ids: Array<number | string>) => void;
  loadWriteAgentSkills: () => Promise<WriteAgentSkill[]>;
  createWriteAgentSkill: (data: Partial<WriteAgentSkill> & { name: string; prompt: string }) => Promise<WriteAgentSkill | null>;
  updateWriteAgentSkill: (id: number | string, data: Partial<WriteAgentSkill>) => Promise<WriteAgentSkill | null>;
  deleteWriteAgentSkill: (id: number | string) => Promise<boolean>;
}

const AppContext = createContext<AppState | undefined>(undefined);

export const AppProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [articles, setArticles] = useState<Article[]>([]);
  const [savedCards, setSavedCards] = useState<AtomCard[]>([]);
  const [savedArticles, setSavedArticles] = useState<SavedArticle[]>([]);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [readingArticle, setReadingArticleState] = useState<Article | null>(null);
  const [activeSource, setActiveSource] = useState<string | null>(null);
  const [savingState, setSavingState] = useState<{ articleIds: number[]; stage: string | null }>({ articleIds: [], stage: null });
  const [knowledgeTypeFilter, setKnowledgeTypeFilter] = useState('来源');
  const [knowledgeSourceFilter, setKnowledgeSourceFilter] = useState('全部');
  const [user, setUser] = useState<User | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [viewMode, setViewModeState] = useState<'card' | 'compact'>('card');
  const [notes, setNotes] = useState<Note[]>([]);
  const [writeWorkspaceMode, setWriteWorkspaceMode] = useState<WriteWorkspaceMode>('graph');
  const [writeGraphView, setWriteGraphView] = useState<WriteGraphView>('all');
  const [writeFocusedTopic, setWriteFocusedTopic] = useState('');
  const [writeActivatedNodeIds, setWriteActivatedNodeIds] = useState<string[]>([]);
  const [writeActivationSummary, setWriteActivationSummary] = useState<string[]>([]);
  const [assistantThreads, setAssistantThreads] = useState<WriteAgentThread[]>([]);
  const [assistantThreadId, setAssistantThreadId] = useState<number | null>(null);
  const [writeAgentSkills, setWriteAgentSkills] = useState<WriteAgentSkill[]>([]);
  const [selectedStyleSkillId, setSelectedStyleSkillId] = useState<number | string>('system-columnist');
  const [selectedSkillIds, setSelectedSkillIds] = useState<Array<number | string>>(['system-card-storage', 'system-citation', 'system-writing', 'system-columnist']);
  const syncTimerRef = useRef<number | null>(null);
  const quickOpenMode = true;
  const forceRefetchInTesting = false;
  const saveStages = ['提取全文', '识别要点', '原子化拆分', '提炼入库'];

  const reloadArticles = async () => {
    const articlesRes = await fetch('/api/articles');
    if (articlesRes.ok) {
      setArticles(await articlesRes.json());
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
        logger.error("Failed to fetch full article", { error, articleId: article.id, articleUrl: article.url });
      }
    }
  };
  // Fetch initial data
  useEffect(() => {
    const fetchData = async () => {
      try {
        // Check auth status first
        const authRes = await fetch('/api/auth/me');
        let loggedIn = false;
        if (authRes.ok) {
          const authData = await authRes.json();
          if (authData.user) {
            setUser(authData.user);
            loggedIn = true;
          }
        }
        setIsAuthLoading(false);

        await reloadArticles();

        // Only fetch cards, preferences, and notes if logged in
        if (loggedIn) {
          // loadPreferences must complete before loadUserSubscriptions so that
          // server-synced source_layout is written to localStorage first, then
          // user subscriptions are merged on top (not overwritten).
          const [cardsRes] = await Promise.all([
            fetch('/api/cards'),
            loadPreferences().then(() => loadUserSubscriptions()),
            loadNotes(),
            loadSavedArticles()
          ]);
          if (cardsRes.ok) {
            setSavedCards(await cardsRes.json());
          }
          await reloadArticles(); // reload with user articles merged
        }
      } catch (error) {
        logger.error("Failed to fetch initial data", { error });
        setIsAuthLoading(false);
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

  const toggleTheme = () => setTheme(prev => {
    const next = prev === 'light' ? 'dark' : 'light';
    if (user) syncPreferences({ theme: next });
    return next;
  });

  const setViewMode = (mode: 'card' | 'compact') => {
    setViewModeState(mode);
    if (user) syncPreferences({ view_mode: mode });
  };

  const syncPreferences = useCallback((prefs: { source_layout?: any; theme?: string; view_mode?: string }) => {
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = window.setTimeout(() => {
      fetch('/api/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(prefs)
      }).catch(error => logger.error('Failed to sync preferences', { error, prefs }));
    }, 500);
  }, []);

  const loadPreferences = async () => {
    try {
      const res = await fetch('/api/preferences');
      if (!res.ok) return;
      const prefs = await res.json();
      if (prefs.theme && (prefs.theme === 'light' || prefs.theme === 'dark')) {
        setTheme(prefs.theme);
      }
      if (prefs.view_mode && (prefs.view_mode === 'card' || prefs.view_mode === 'compact')) {
        setViewModeState(prefs.view_mode);
      }
      if (prefs.source_layout) {
        window.localStorage.setItem('atomflow:source-layout:v1', JSON.stringify(prefs.source_layout));
        window.dispatchEvent(new Event('atomflow:preferences-loaded'));
      }
    } catch {}
  };

  const loadNotes = async () => {
    try {
      const res = await fetch('/api/notes');
      if (res.ok) setNotes(await res.json());
    } catch {}
  };
  const reloadNotes = loadNotes;

  const loadSavedArticles = async () => {
    try {
      const res = await fetch('/api/saved-articles');
      if (res.ok) setSavedArticles(await res.json());
    } catch {}
  };

  // Restore user's custom subscriptions into localStorage (cross-device support)
  const loadUserSubscriptions = async () => {
    try {
      const res = await fetch('/api/subscriptions');
      if (!res.ok) return;
      const subs: Array<{ name: string; rssUrl: string; color: string; icon?: string }> = await res.json();
      if (subs.length === 0) return;

      const raw = window.localStorage.getItem('atomflow:source-layout:v1');
      const stored = raw ? JSON.parse(raw) : { version: 2, entries: [] };
      const entries: any[] = stored.version ? stored.entries : stored;

      const existingNames = new Set<string>();
      entries.forEach((e: any) => {
        if (e.type === 'source') existingNames.add(e.name);
        if (e.type === 'collection') e.children?.forEach((c: any) => existingNames.add(c.name));
      });

      let changed = false;
      subs.forEach(sub => {
        if (!existingNames.has(sub.name)) {
          entries.push({
            id: `source:${sub.name}`,
            type: 'source',
            name: sub.name,
            color: sub.color,
            rssUrl: sub.rssUrl,
            icon: sub.icon
          });
          changed = true;
        }
      });

      if (changed) {
        window.localStorage.setItem('atomflow:source-layout:v1', JSON.stringify({ version: 2, entries }));
        window.dispatchEvent(new Event('atomflow:preferences-loaded'));
      }
    } catch {}
  };

  const createNote = async (data?: Partial<{ title: string; content: string; tags: string[]; meta: NoteMeta }>): Promise<Note | null> => {
    try {
      const res = await fetch('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: data?.title || '',
          content: data?.content || '',
          tags: data?.tags || [],
          meta: data?.meta || {}
        })
      });
      if (res.ok) {
        const note = await res.json();
        setNotes(prev => [note, ...prev]);
        return note;
      }
    } catch (error) {
      logger.error('Failed to create note', { error });
    }
    return null;
  };

  const updateNote = async (id: number, data: Partial<{ title: string; content: string; tags: string[]; meta: NoteMeta }>) => {
    try {
      const res = await fetch(`/api/notes/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      if (res.ok) {
        const updated = await res.json();
        setNotes(prev => prev.map(n => n.id === id ? updated : n));
      }
    } catch (error) {
      logger.error('Failed to update note', { error, noteId: id });
    }
  };

  const deleteNote = async (id: number) => {
    try {
      const res = await fetch(`/api/notes/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setNotes(prev => prev.filter(n => n.id !== id));
      }
    } catch (error) {
      logger.error('Failed to delete note', { error, noteId: id });
    }
  };

  const normalizeSkillSelection = (skills: WriteAgentSkill[]) => {
    const defaults = ['card_storage', 'citation', 'writing', 'style'].map(type => (
      skills.find(skill => skill.type === type && skill.visibility === 'user' && skill.isDefault)
      || skills.find(skill => skill.type === type && skill.isDefault)
      || skills.find(skill => skill.type === type)
    )).filter((skill): skill is WriteAgentSkill => Boolean(skill));
    const defaultIds = defaults.map(skill => skill.id);
    setSelectedSkillIds(prev => {
      const available = new Set(skills.map(skill => String(skill.id)));
      const kept = prev.filter(id => available.has(String(id)));
      return kept.length > 0 ? kept : defaultIds;
    });
    const defaultStyle = defaults.find(skill => skill.type === 'style') || skills.find(skill => skill.type === 'style');
    if (defaultStyle) {
      setSelectedStyleSkillId(prev => skills.some(skill => String(skill.id) === String(prev)) ? prev : defaultStyle.id);
    }
  };

  const loadAssistantThreads = useCallback(async (threadType: 'chat' | 'skill' = 'chat') => {
    if (!user) {
      setAssistantThreads([]);
      setAssistantThreadId(null);
      return [];
    }
    try {
      const response = await fetch(`/api/write/agent/threads?type=${threadType}`, { method: 'GET' });
      if (!response.ok) return [];
      const threads: WriteAgentThread[] = await response.json();
      const normalized = Array.isArray(threads) ? threads : [];
      setAssistantThreads(normalized);
      setAssistantThreadId(prev => prev || (normalized[0]?.id ? Number(normalized[0].id) : null));
      return normalized;
    } catch {
      return [];
    }
  }, [user]);

  const createAssistantThread = useCallback(async (threadType: 'chat' | 'skill' = 'chat') => {
    if (!user) {
      setShowLoginModal(true);
      return null;
    }
    try {
      const response = await fetch('/api/write/agent/threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '新的写作会话', threadType })
      });
      if (!response.ok) {
        showToast('新建会话失败');
        return null;
      }
      const thread: WriteAgentThread = await response.json();
      setAssistantThreads(prev => [thread, ...prev.filter(item => Number(item.id) !== Number(thread.id))]);
      setAssistantThreadId(Number(thread.id));
      return thread;
    } catch {
      showToast('网络错误，新建会话失败');
      return null;
    }
  }, [user]);

  const loadWriteAgentSkills = useCallback(async () => {
    if (!user) {
      const fallback: WriteAgentSkill[] = [];
      setWriteAgentSkills(fallback);
      setSelectedStyleSkillId('system-columnist');
      setSelectedSkillIds(['system-card-storage', 'system-citation', 'system-writing', 'system-columnist']);
      return fallback;
    }
    try {
      const response = await fetch('/api/write/agent/skills');
      if (!response.ok) return [];
      const data = await response.json();
      const skills: WriteAgentSkill[] = Array.isArray(data.skills) ? data.skills : [];
      setWriteAgentSkills(skills);
      normalizeSkillSelection(skills);
      return skills;
    } catch {
      return [];
    }
  }, [user]);

  const createWriteAgentSkill = useCallback(async (data: Partial<WriteAgentSkill> & { name: string; prompt: string }) => {
    if (!user) {
      setShowLoginModal(true);
      return null;
    }
    try {
      const response = await fetch('/api/write/agent/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      if (!response.ok) {
        showToast('Skill 保存失败');
        return null;
      }
      const payload = await response.json();
      if (payload.skill) {
        setWriteAgentSkills(prev => [...prev, payload.skill]);
        setSelectedSkillIds(prev => Array.from(new Set([...prev, payload.skill.id])));
        if (payload.skill.type === 'style') setSelectedStyleSkillId(payload.skill.id);
        showToast(`已添加 Skill「${payload.skill.name}」`);
      }
      return payload.skill || null;
    } catch {
      showToast('网络错误，Skill 保存失败');
      return null;
    }
  }, [user]);

  const updateWriteAgentSkill = useCallback(async (id: number | string, data: Partial<WriteAgentSkill>) => {
    if (!user || typeof id === 'string') return null;
    try {
      const response = await fetch(`/api/write/agent/skills/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      if (!response.ok) {
        showToast('Skill 更新失败');
        return null;
      }
      const payload = await response.json();
      if (payload.skill) {
        setWriteAgentSkills(prev => prev.map(skill => String(skill.id) === String(id) ? payload.skill : skill));
        showToast(`已更新 Skill「${payload.skill.name}」`);
      }
      return payload.skill || null;
    } catch {
      showToast('网络错误，Skill 更新失败');
      return null;
    }
  }, [user]);

  const deleteWriteAgentSkill = useCallback(async (id: number | string) => {
    if (!user || typeof id === 'string') return false;
    try {
      const response = await fetch(`/api/write/agent/skills/${id}`, { method: 'DELETE' });
      if (!response.ok) {
        showToast('Skill 删除失败');
        return false;
      }
      setWriteAgentSkills(prev => prev.filter(skill => String(skill.id) !== String(id)));
      setSelectedSkillIds(prev => prev.filter(skillId => String(skillId) !== String(id)));
      showToast('已删除 Skill');
      return true;
    } catch {
      showToast('网络错误，Skill 删除失败');
      return false;
    }
  }, [user]);

  useEffect(() => {
    if (!user) {
      setAssistantThreads([]);
      setAssistantThreadId(null);
      setWriteAgentSkills([]);
      return;
    }
    void loadAssistantThreads();
    void loadWriteAgentSkills();
  }, [loadAssistantThreads, loadWriteAgentSkills, user]);

  const saveArticle = async (articleId: number) => {
    if (!user) {
      setPendingAction(() => () => { void saveArticle(articleId); });
      setShowLoginModal(true);
      return false;
    }
    if (savingState.articleIds.length > 0) return false;
    const setSaveProgress = (ids: number[], stage: string) => {
      setSavingState({ articleIds: Array.from(new Set(ids)), stage });
    };
    try {
      setSaveProgress([articleId], saveStages[0]);
      const targetArticle = articles.find(a => a.id === articleId);
      let resolvedArticleId = articleId;
      let resolvedArticle = targetArticle;
      const refreshArticleIdentity = async () => {
        if (!targetArticle) return false;
        const articlesRes = await fetch('/api/articles', { cache: 'no-store' });
        if (!articlesRes.ok) return false;
        const freshArticles: Article[] = await articlesRes.json();
        setArticles(freshArticles);
        const matched = freshArticles.find(a => targetArticle.url && a.url === targetArticle.url)
          || freshArticles.find(a => a.title === targetArticle.title && a.source === targetArticle.source)
          || freshArticles.find(a => a.title === targetArticle.title);
        if (!matched) return false;
        resolvedArticleId = matched.id;
        resolvedArticle = matched;
        setSaveProgress([articleId, resolvedArticleId], saveStages[0]);
        return true;
      };

      if (quickOpenMode && resolvedArticle?.url) {
        let fullRes = await fetch(`/api/articles/${resolvedArticleId}/full?force=1&t=${Date.now()}`, { cache: 'no-store' });
        if (fullRes.status === 404 && await refreshArticleIdentity()) {
          fullRes = await fetch(`/api/articles/${resolvedArticleId}/full?force=1&t=${Date.now()}`, { cache: 'no-store' });
        }
        if (fullRes.ok) {
          const fullData = await fullRes.json();
          setArticles(prev => prev.map(a => a.id === resolvedArticleId ? fullData.article : a));
          if (readingArticle?.id === articleId || readingArticle?.id === resolvedArticleId) {
            setReadingArticleState(fullData.article);
          }
        }
      }
      setSaveProgress([articleId, resolvedArticleId], saveStages[1]);
      await new Promise(resolve => setTimeout(resolve, 220));
      setSaveProgress([articleId, resolvedArticleId], saveStages[2]);
      let res = await fetch(`/api/articles/${resolvedArticleId}/save`, { method: 'POST' });
      if (res.status === 404 && await refreshArticleIdentity()) {
        res = await fetch(`/api/articles/${resolvedArticleId}/save`, { method: 'POST' });
      }
      if (res.ok) {
        const saveData = await res.json().catch(() => null);
        const savedArticleFromResponse = saveData?.article as Article | undefined;
        setSaveProgress([articleId, resolvedArticleId], saveStages[3]);
        // Refresh data to get the new cards and updated article state
        const [articlesRes, cardsRes, savedArticlesRes] = await Promise.all([
          fetch('/api/articles'),
          fetch('/api/cards'),
          fetch('/api/saved-articles')
        ]);
        if (articlesRes.ok) {
          const freshArticles: Article[] = await articlesRes.json();
          setArticles(freshArticles);
          const freshReadingArticle = freshArticles.find(a => a.id === articleId || a.id === resolvedArticleId)
            || freshArticles.find(a => resolvedArticle?.url && a.url === resolvedArticle.url)
            || freshArticles.find(a => resolvedArticle && a.title === resolvedArticle.title && a.source === resolvedArticle.source)
            || savedArticleFromResponse;
          if (readingArticle && freshReadingArticle && (readingArticle.id === articleId || readingArticle.id === resolvedArticleId || Boolean(readingArticle.url && readingArticle.url === freshReadingArticle.url))) {
            setReadingArticleState({ ...freshReadingArticle, saved: true });
          }
        } else if (readingArticle && savedArticleFromResponse) {
          setReadingArticleState({ ...savedArticleFromResponse, saved: true });
        }
        if (cardsRes.ok) setSavedCards(await cardsRes.json());
        if (savedArticlesRes.ok) setSavedArticles(await savedArticlesRes.json());
        showToast('已存入知识库');
        return true;
      } else {
        const errBody = await res.text().catch(() => '');
        logger.error('Save article API failed', { articleId: resolvedArticleId, originalArticleId: articleId, status: res.status, responseBody: errBody });
        let message = `保存失败: ${res.status}`;
        try {
          const parsed = JSON.parse(errBody);
          if (typeof parsed?.error === 'string') {
            message = parsed.fallbackDisabled
              ? 'AI 原子化失败，规则兜底已关闭'
              : parsed.error;
          }
        } catch {
          // keep status fallback
        }
        showToast(message);
        return false;
      }
    } catch (error) {
      logger.error("Failed to save article", { error, articleId });
      showToast('保存失败: 网络错误');
      return false;
    } finally {
      await new Promise(resolve => setTimeout(resolve, 260));
      setSavingState({ articleIds: [], stage: null });
    }
  };

  const isSavingArticle = (articleId: number) => savingState.articleIds.includes(articleId);
  const getSavingStageText = (articleId: number) => savingState.articleIds.includes(articleId) ? savingState.stage : null;

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
      logger.error("Failed to add card", { error, cardType: card.type });
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
      logger.error("Failed to update card", { error, cardId: id });
    }
  };

  const deleteCard = async (id: string) => {
    try {
      const res = await fetch(`/api/cards/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setSavedCards(prev => prev.filter(c => c.id !== id));
      }
    } catch (error) {
      logger.error("Failed to delete card", { error, cardId: id });
    }
  };

  const loginAndDo = (action: () => void) => {
    if (user) {
      action();
      return;
    }
    setPendingAction(() => action);
    setShowLoginModal(true);
  };

  const handleLoginSuccess = async (userData: User) => {
    setUser(userData);
    setShowLoginModal(false);
    try {
      const [cardsRes] = await Promise.all([
        fetch('/api/cards'),
        loadPreferences().then(() => loadUserSubscriptions()),
        loadNotes(),
        loadSavedArticles()
      ]);
      if (cardsRes.ok) {
        setSavedCards(await cardsRes.json());
      }
      await reloadArticles(); // reload to include user's private articles
    } catch {}
    if (pendingAction) {
      pendingAction();
      setPendingAction(null);
    }
  };

  const logout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {}
    setUser(null);
    setSavedCards([]);
    setSavedArticles([]);
    setNotes([]);
    setAssistantThreads([]);
    setAssistantThreadId(null);
    setWriteAgentSkills([]);
    await reloadArticles(); // reload without user articles
  };

  const updateProfile = async (nickname: string) => {
    const res = await fetch('/api/auth/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || '保存失败');
    }
    const data = await res.json();
    setUser(data.user);
  };

  const updateAvatar = async (file: File) => {
    const formData = new FormData();
    formData.append('avatar', file);
    const res = await fetch('/api/auth/avatar', {
      method: 'POST',
      body: formData
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || '上传失败');
    }
    const data = await res.json();
    setUser(data.user);
  };

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => {
      setToastMsg(null);
    }, 3000);
  };

  return (
    <AppContext.Provider value={{
      articles, savedCards, savedArticles, saveArticle, addCards, addCard, updateCard, deleteCard,
      showToast, toastMsg, theme, toggleTheme,
      viewMode, setViewMode,
      readingArticle, setReadingArticle,
      activeSource, setActiveSource,
      reloadArticles,
      reloadNotes,
      isSavingArticle,
      getSavingStageText,
      knowledgeTypeFilter,
      setKnowledgeTypeFilter,
      knowledgeSourceFilter,
      setKnowledgeSourceFilter,
      user, isAuthLoading, showLoginModal, setShowLoginModal,
      loginAndDo, handleLoginSuccess, logout,
      updateProfile, updateAvatar, showProfileModal, setShowProfileModal,
      notes, createNote, updateNote, deleteNote, syncPreferences,
      writeWorkspaceMode, setWriteWorkspaceMode,
      writeGraphView, setWriteGraphView,
	      writeFocusedTopic, setWriteFocusedTopic,
	      writeActivatedNodeIds, setWriteActivatedNodeIds,
	      writeActivationSummary, setWriteActivationSummary,
	      assistantThreads, assistantThreadId, setAssistantThreadId, loadAssistantThreads, createAssistantThread,
	      writeAgentSkills, selectedStyleSkillId, setSelectedStyleSkillId,
	      selectedSkillIds, setSelectedSkillIds, loadWriteAgentSkills,
	      createWriteAgentSkill, updateWriteAgentSkill, deleteWriteAgentSkill
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
