import React, { createContext, useContext, useState, useEffect, useRef, useCallback, ReactNode } from 'react';
import {
  Article,
  AtomCard,
  User,
  Note,
  NoteMeta,
  SavedArticle,
  WriteAgentSkill,
  WriteAgentThread,
  type BillingPendingIntent,
  type BillingPlan,
  type BillingPlanCode,
  type BillingStatus,
} from '../types';
import { logger } from '../utils/logger';
import { findArticleByIdentity, matchesArticleIdentity, type ArticleIdentity } from '../utils/articleIdentity';
import { bindBillingIntentToUser, clearBillingIntent, readBillingIntent, storeBillingIntent, type StoredBillingIntent } from '../billing/pendingIntent';
import {
  initializePaddleForPaymentLink,
  openPaddleTransaction,
  readPaddlePaymentLinkTransactionId,
} from '../billing/paddle';
import { clearPendingCheckoutConfirmation, readPendingCheckoutConfirmation, storePendingCheckoutConfirmation } from '../billing/pendingCheckout';
import { normalizeBillingPlans } from '../billing/catalog';

export type WriteWorkspaceMode = 'graph' | 'articles' | 'skills';
export type WriteGraphView = 'all' | 'activated';
const RSS_REFRESH_RETRY_DELAYS_MS = [1500, 3000, 6000, 12000, 24000] as const;
const BILLING_SYNC_CHANNEL = 'atomflow:billing-sync';

const notifyBillingAccessChanged = () => {
  window.dispatchEvent(new Event('atomflow:billing-access-changed'));
  if (typeof BroadcastChannel !== 'function') return;
  const channel = new BroadcastChannel(BILLING_SYNC_CHANNEL);
  channel.postMessage({ type: 'billing-access-changed' });
  channel.close();
};

export type BillingState =
  | { phase: 'idle' | 'loading'; status: null }
  | { phase: 'ready'; status: BillingStatus }
  | { phase: 'error'; status: null; error: string };

export type BillingCatalogState =
  | { phase: 'loading' | 'ready' | 'disabled'; error: null }
  | { phase: 'error'; error: string };

export type CheckoutState =
  | { phase: 'idle'; error: null }
  | { phase: 'creating' | 'open' | 'confirming'; error: null }
  | { phase: 'pending'; error: string }
  | { phase: 'error'; error: string };

type BillingConfirmationMode = 'subscription_purchase' | 'payment_recovery';

interface AppState {
  articles: Article[];
  isArticlesLoading: boolean;
  articlesError: string | null;
  articlesLoaded: boolean;
  sourceArticles: Record<string, Article[]>;
  savedCards: AtomCard[];
  savedArticles: SavedArticle[];
  saveArticle: (articleId: number, identity?: ArticleIdentity) => Promise<boolean>;
  addCards: (cards: AtomCard[]) => void;
  addCard: (card: AtomCard) => Promise<boolean>;
  updateCard: (id: string, card: Partial<AtomCard>) => Promise<boolean>;
  deleteCard: (id: string) => Promise<boolean>;
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
  loadSourceArticles: (source: string) => Promise<Article[]>;
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
  handleLoginSuccess: (user: User) => Promise<void>;
  logout: () => Promise<void>;
  updateProfile: (nickname: string) => Promise<void>;
  updateAvatar: (file: File) => Promise<void>;
  showProfileModal: boolean;
  setShowProfileModal: (show: boolean) => void;
  billingState: BillingState;
  billingPlans: BillingPlan[];
  billingCatalogState: BillingCatalogState;
  checkoutState: CheckoutState;
  refreshBillingStatus: () => Promise<BillingStatus | null>;
  refreshBillingPlans: () => Promise<void>;
  retryBillingConfirmation: () => void;
  startBillingCheckout: (planCode: BillingPlanCode) => Promise<void>;
  openBillingPortal: () => Promise<void>;
  requestBillingIntent: (intent: BillingPendingIntent) => StoredBillingIntent;
  consumeBillingIntent: () => StoredBillingIntent | null;
  completeBillingIntent: (requestId: string) => void;
  notes: Note[];
  reloadNotes: () => Promise<void>;
  createNote: (data?: Partial<{ title: string; content: string; tags: string[]; meta: NoteMeta }>) => Promise<Note | null>;
  updateNote: (id: number, data: Partial<{ title: string; content: string; tags: string[]; meta: NoteMeta }>) => Promise<boolean>;
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

export function mergeSavedReadingArticle(
  current: Article | null,
  identity: ArticleIdentity | null | undefined,
  savedArticle: Article,
): Article | null {
  return matchesArticleIdentity(current, identity)
    ? { ...savedArticle, saved: true }
    : current;
}

const readNullableString = (value: unknown): string | null => (
  typeof value === 'string' && value.trim() ? value : null
);

const normalizeBillingStatus = (payload: unknown): BillingStatus | null => {
  if (!payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>;
  const value = root.status && typeof root.status === 'object' ? root.status as Record<string, unknown> : root;
  const access = value.access;
  if (access !== 'full' && access !== 'read_only' && access !== 'none') return null;
  const rawSubscriptionStatus = value.subscriptionStatus ?? value.subscription_status;
  const subscriptionStatus = ['active', 'trialing', 'past_due', 'paused', 'canceled'].includes(String(rawSubscriptionStatus))
    ? rawSubscriptionStatus as BillingStatus['subscriptionStatus']
    : null;
  const rawPlan = value.planCode ?? value.plan_code;
  const planCode = rawPlan === 'pro_monthly' || rawPlan === 'pro_yearly' ? rawPlan : null;
  const currentPeriodEnd = readNullableString(
    value.currentPeriodEnd
      ?? value.current_period_end
      ?? value.currentPeriodEndsAt
      ?? value.current_period_ends_at,
  );
  const scheduledChange = value.scheduledChange ?? value.scheduled_change;
  const scheduledChangeValue = scheduledChange && typeof scheduledChange === 'object'
    ? scheduledChange as Record<string, unknown>
    : null;
  const isScheduledCancellation = scheduledChangeValue?.action === 'cancel';
  const scheduledCancelAt = readNullableString(
    value.scheduledCancelAt
      ?? value.scheduled_cancel_at
      ?? (isScheduledCancellation
        ? scheduledChangeValue?.effectiveAt ?? scheduledChangeValue?.effective_at ?? currentPeriodEnd
        : null),
  );
  return {
    enabled: value.enabled !== false,
    access,
    subscriptionStatus,
    planCode,
    currentPeriodEnd,
    scheduledCancelAt,
    hasLegacyWriteData: Boolean(
      value.hasLegacyWriteData
        ?? value.has_legacy_write_data
        ?? value.hasWritingHistory
        ?? value.has_writing_history,
    ),
    hasBillingCustomer: Boolean(value.hasBillingCustomer ?? value.has_billing_customer),
    paymentActionRequired: Boolean(value.paymentActionRequired ?? value.payment_action_required ?? subscriptionStatus === 'past_due'),
  };
};

const fetchBillingStatusFromApi = async (): Promise<BillingStatus> => {
  const response = await fetch('/api/billing/status', { cache: 'no-store' });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string; code?: string } | null;
    throw new Error(payload?.code === 'BILLING_UNAVAILABLE' ? '账单系统暂时不可用' : payload?.error || `账单状态加载失败 (${response.status})`);
  }
  const status = normalizeBillingStatus(await response.json());
  if (!status) throw new Error('账单状态数据异常');
  return status;
};

export const AppProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [articles, setArticles] = useState<Article[]>([]);
  const [isArticlesLoading, setIsArticlesLoading] = useState(true);
  const [articlesError, setArticlesError] = useState<string | null>(null);
  const [articlesLoaded, setArticlesLoaded] = useState(false);
  const [sourceArticles, setSourceArticles] = useState<Record<string, Article[]>>({});
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
  const [showLoginModal, setShowLoginModalState] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [billingState, setBillingState] = useState<BillingState>({ phase: 'idle', status: null });
  const [billingPlans, setBillingPlans] = useState<BillingPlan[]>([]);
  const [billingCatalogState, setBillingCatalogState] = useState<BillingCatalogState>({ phase: 'loading', error: null });
  const [checkoutState, setCheckoutState] = useState<CheckoutState>({ phase: 'idle', error: null });
  const [viewMode, setViewModeState] = useState<'card' | 'compact'>('card');
  const [notes, setNotes] = useState<Note[]>([]);
  const [writeWorkspaceMode, setWriteWorkspaceMode] = useState<WriteWorkspaceMode>(() => {
    if (typeof window === 'undefined') return 'graph';
    const stored = window.localStorage.getItem('atomflow:write-workspace-mode');
    return stored === 'articles' || stored === 'skills' || stored === 'graph' ? stored : 'graph';
  });
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
  const readingRequestRef = useRef(0);
  const billingStatusRef = useRef<BillingStatus | null>(null);
  const billingStatusRequestRef = useRef(0);
  const checkoutStateRef = useRef<CheckoutState>({ phase: 'idle', error: null });
  const billingPollRef = useRef<number | null>(null);
  const billingConfirmationModeRef = useRef<BillingConfirmationMode>('subscription_purchase');
  const paddleUnsubscribeRef = useRef<(() => void) | null>(null);
  const restoredPendingUserRef = useRef<number | null>(null);
  const userRef = useRef<User | null>(null);
  const accountEpochRef = useRef(0);
  const articleRetryTimerRef = useRef<number | null>(null);
  const sourceRetryTimersRef = useRef<Map<string, number>>(new Map());
  const quickOpenMode = false;

  const updateCheckoutState = useCallback((nextState: CheckoutState) => {
    checkoutStateRef.current = nextState;
    setCheckoutState(nextState);
  }, []);

  const showToast = useCallback((msg: string) => {
    setToastMsg(msg);
    window.setTimeout(() => setToastMsg(null), 3000);
  }, []);

  const captureAccountScope = useCallback(() => ({
    epoch: accountEpochRef.current,
    userId: userRef.current?.id ?? null,
  }), []);
  const isAccountScopeCurrent = useCallback((scope: { epoch: number; userId: number | null }) => (
    accountEpochRef.current === scope.epoch && (userRef.current?.id ?? null) === scope.userId
  ), []);
  const replaceAccountOwner = useCallback((nextUser: User | null) => {
    accountEpochRef.current += 1;
    readingRequestRef.current += 1;
    if (syncTimerRef.current !== null) {
      window.clearTimeout(syncTimerRef.current);
      syncTimerRef.current = null;
    }
    setSavingState({ articleIds: [], stage: null });
    userRef.current = nextUser;
    setUser(nextUser);
    return accountEpochRef.current;
  }, []);

  const resetAccountScopedState = useCallback(() => {
    if (billingPollRef.current !== null) {
      window.clearTimeout(billingPollRef.current);
      billingPollRef.current = null;
    }
    paddleUnsubscribeRef.current?.();
    paddleUnsubscribeRef.current = null;
    billingConfirmationModeRef.current = 'subscription_purchase';
    restoredPendingUserRef.current = null;
    billingStatusRequestRef.current += 1;
    setArticles([]);
    setIsArticlesLoading(false);
    setArticlesError(null);
    setArticlesLoaded(false);
    setSourceArticles({});
    if (articleRetryTimerRef.current !== null) {
      window.clearTimeout(articleRetryTimerRef.current);
      articleRetryTimerRef.current = null;
    }
    sourceRetryTimersRef.current.forEach(timer => window.clearTimeout(timer));
    sourceRetryTimersRef.current.clear();
    setSavedCards([]);
    setSavedArticles([]);
    setNotes([]);
    setAssistantThreads([]);
    setAssistantThreadId(null);
    setWriteAgentSkills([]);
    setSelectedStyleSkillId('system-columnist');
    setSelectedSkillIds(['system-card-storage', 'system-citation', 'system-writing', 'system-columnist']);
    setWriteGraphView('all');
    setWriteFocusedTopic('');
    setWriteActivatedNodeIds([]);
    setWriteActivationSummary([]);
    setReadingArticleState(null);
    setActiveSource(null);
    setKnowledgeTypeFilter('来源');
    setKnowledgeSourceFilter('全部');
    setShowProfileModal(false);
    billingStatusRef.current = null;
    setBillingState({ phase: 'idle', status: null });
    updateCheckoutState({ phase: 'idle', error: null });
    setTheme('light');
    setViewModeState('card');
    window.localStorage.removeItem('atomflow:source-layout:v1');
    window.dispatchEvent(new window.Event('atomflow:preferences-loaded'));
  }, [updateCheckoutState]);

  useEffect(() => {
    window.localStorage.setItem('atomflow:write-workspace-mode', writeWorkspaceMode);
  }, [writeWorkspaceMode]);
  const forceRefetchInTesting = false;
  const saveStages = ['提取全文', '识别要点', '原子化拆分', '提炼入库'];

  const setShowLoginModal = useCallback((show: boolean) => {
    setShowLoginModalState(show);
  }, []);

  const appendArticleIdentityParams = (params: URLSearchParams, article: ArticleIdentity) => {
    if (article.url) {
      params.set('sourceUrl', article.url);
      return;
    }
    if (article.source && article.title) {
      params.set('sourceName', article.source);
      params.set('sourceTitle', article.title);
    }
  };

  const reloadArticles = async (retryAttempt = 0): Promise<void> => {
    const accountScope = captureAccountScope();
    setIsArticlesLoading(true);
    setArticlesError(null);
    let retryScheduled = articleRetryTimerRef.current !== null;
    try {
      const articlesRes = await fetch('/api/articles');
      if (!articlesRes.ok) {
        throw new Error(`文章加载失败 (${articlesRes.status})`);
      }
      const payload = await articlesRes.json() as Article[];
      if (!isAccountScopeCurrent(accountScope)) return;
      setArticles(payload);
      const retryPending = payload.length === 0
        && articlesRes.headers.get('X-AtomFlow-RSS-Refreshing') === 'true';
      if (retryPending && retryAttempt < RSS_REFRESH_RETRY_DELAYS_MS.length) {
        retryScheduled = true;
        if (articleRetryTimerRef.current === null) {
          articleRetryTimerRef.current = window.setTimeout(() => {
            articleRetryTimerRef.current = null;
            void reloadArticles(retryAttempt + 1).catch(error => logger.error('Failed to retry article loading', { error }));
          }, RSS_REFRESH_RETRY_DELAYS_MS[retryAttempt]);
        }
      } else {
        retryScheduled = false;
      }
    } catch (error) {
      if (!isAccountScopeCurrent(accountScope)) return;
      logger.error('Failed to reload articles', { error });
      setArticlesError(error instanceof Error ? error.message : '文章加载失败');
      retryScheduled = false;
    } finally {
      if (isAccountScopeCurrent(accountScope) && !retryScheduled) {
        if (articleRetryTimerRef.current !== null) {
          window.clearTimeout(articleRetryTimerRef.current);
          articleRetryTimerRef.current = null;
        }
        setArticlesLoaded(true);
        setIsArticlesLoading(false);
      }
    }
  };

  const loadSourceArticles = async (source: string, retryAttempt = 0): Promise<Article[]> => {
    const response = await fetch(`/api/articles?source=${encodeURIComponent(source)}`, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Failed to load source: ${response.status}`);
    }
    const nextArticles = await response.json() as Article[];
    const existingTimer = sourceRetryTimersRef.current.get(source);
    const refreshPending = response.headers.get('X-AtomFlow-RSS-Refreshing') === 'true';
    if (nextArticles.length > 0) {
      setSourceArticles(current => ({ ...current, [source]: nextArticles }));
    }
    if (refreshPending && retryAttempt < RSS_REFRESH_RETRY_DELAYS_MS.length && existingTimer === undefined) {
      const timer = window.setTimeout(() => {
        sourceRetryTimersRef.current.delete(source);
        void loadSourceArticles(source, retryAttempt + 1).catch(error => logger.error('Failed to retry source loading', { error, source }));
      }, RSS_REFRESH_RETRY_DELAYS_MS[retryAttempt]);
      sourceRetryTimersRef.current.set(source, timer);
    } else if (!refreshPending && existingTimer !== undefined) {
      window.clearTimeout(existingTimer);
      sourceRetryTimersRef.current.delete(source);
    }

    return nextArticles;
  };

  const updateSourceArticleCache = (articleId: number, patch: Partial<Article>) => {
    setSourceArticles(current => Object.fromEntries(
      Object.entries(current).map(([source, sourceItems]) => [
        source,
        sourceItems.map(item => item.id === articleId ? { ...item, ...patch } : item),
      ]),
    ));
  };

  useEffect(() => () => {
    if (articleRetryTimerRef.current !== null) {
      window.clearTimeout(articleRetryTimerRef.current);
    }
    sourceRetryTimersRef.current.forEach(timer => window.clearTimeout(timer));
    sourceRetryTimersRef.current.clear();
  }, []);
  
  const setReadingArticle = useCallback(async (article: Article | null) => {
    const requestId = ++readingRequestRef.current;
    setReadingArticleState(article);
    if (quickOpenMode) {
      return;
    }

    // Podcast saved-only items use a negative reader id so they cannot collide
    // with RSS/user article ids. Hydrate them from the authenticated saved
    // article endpoint instead of treating the excerpt as full content.
    if (article?.saved && Number.isSafeInteger(article.id) && article.id < 0) {
      try {
        const response = await fetch(`/api/saved-articles/${Math.abs(article.id)}`, { cache: 'no-store' });
        if (!response.ok) return;
        const saved = await response.json() as SavedArticle;
        if (requestId !== readingRequestRef.current) return;
        setReadingArticleState({
          ...article,
          title: saved.title,
          source: saved.source,
          sourceIcon: saved.sourceIcon,
          topic: saved.topic,
          publishedAt: saved.publishedAt,
          excerpt: saved.excerpt,
          citationContext: saved.citationContext,
          sourceImages: saved.sourceImages,
          content: saved.content ?? '',
          url: saved.url,
          audioUrl: saved.audioUrl,
          audioDuration: saved.audioDuration,
          fullFetched: true,
        });
      } catch (error) {
        logger.error('Failed to fetch saved article content', { error, savedArticleId: Math.abs(article.id) });
      }
      return;
    }
    
    const shouldForceRefetch = Boolean(article && article.url && forceRefetchInTesting);
    const fullParams = new URLSearchParams();
    if (article) appendArticleIdentityParams(fullParams, article);
    if (shouldForceRefetch) {
      fullParams.set('force', '1');
      fullParams.set('t', String(Date.now()));
    }
    const fullApiUrl = article
      ? `/api/articles/${article.id}/full${fullParams.size ? `?${fullParams.toString()}` : ''}`
      : '';
    if (article && (!article.fullFetched || shouldForceRefetch)) {
      try {
        const res = await fetch(fullApiUrl, { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json() as { article: Article };
          if (requestId !== readingRequestRef.current) return;
          setArticles(prev => prev.map(a => matchesArticleIdentity(a, article) ? data.article : a));
          updateSourceArticleCache(article.id, data.article);
          setReadingArticleState(data.article);
          return;
        }
        const articlesRes = await fetch('/api/articles');
        if (articlesRes.ok) {
          const freshArticles = await articlesRes.json() as Article[];
          if (requestId !== readingRequestRef.current) return;
          setArticles(freshArticles);
          const matched = findArticleByIdentity(freshArticles, article);
          if (matched) {
            setReadingArticleState(matched);
            const shouldRefetchMatched = Boolean(matched.url && forceRefetchInTesting);
            if (!matched.fullFetched || shouldRefetchMatched) {
              const retryParams = new URLSearchParams();
              appendArticleIdentityParams(retryParams, matched);
              if (shouldRefetchMatched) {
                retryParams.set('force', '1');
                retryParams.set('t', String(Date.now()));
              }
              const retryRes = await fetch(`/api/articles/${matched.id}/full${retryParams.size ? `?${retryParams.toString()}` : ''}`, { cache: 'no-store' });
              if (retryRes.ok) {
                const data = await retryRes.json() as { article: Article };
                if (requestId !== readingRequestRef.current) return;
                setArticles((prev: Article[]) => prev.map(a => matchesArticleIdentity(a, matched) ? data.article : a));
                updateSourceArticleCache(matched.id, data.article);
                setReadingArticleState(data.article);
              }
            }
          }
        }
      } catch (error) {
        logger.error("Failed to fetch full article", { error, articleId: article.id });
      }
    }
  }, []);
  // Fetch initial data
  useEffect(() => {
    const fetchData = async () => {
      const initialAccountScope = captureAccountScope();
      let activeAccountScope = initialAccountScope;
      try {
        // Check auth status first
        const authRes = await fetch('/api/auth/me');
        if (!isAccountScopeCurrent(initialAccountScope)) return;
        let loggedIn = false;
        if (authRes.ok) {
          const authData = await authRes.json();
          if (!isAccountScopeCurrent(initialAccountScope)) return;
          if (authData.user) {
            replaceAccountOwner(authData.user);
            activeAccountScope = captureAccountScope();
            resetAccountScopedState();
            loggedIn = true;
          } else {
            resetAccountScopedState();
          }
        } else {
          resetAccountScopedState();
        }
        if (!isAccountScopeCurrent(activeAccountScope)) return;
        setIsAuthLoading(false);

        await reloadArticles();

        // Only fetch cards, preferences, and notes if logged in
        if (loggedIn) {
          setBillingState({ phase: 'loading', status: null });
          const billingRequestId = ++billingStatusRequestRef.current;
          // loadPreferences must complete before loadUserSubscriptions so that
          // server-synced source_layout is written to localStorage first, then
          // user subscriptions are merged on top (not overwritten).
          const [cardsRes, status] = await Promise.all([
            fetch('/api/cards'),
            fetchBillingStatusFromApi(),
            loadPreferences().then(() => loadUserSubscriptions()),
            loadSavedArticles()
          ]);
          if (isAccountScopeCurrent(activeAccountScope) && billingRequestId === billingStatusRequestRef.current) {
            billingStatusRef.current = status;
            setBillingState({ phase: 'ready', status });
            if (status.access !== 'none') await loadNotes();
          }
          if (cardsRes.ok && isAccountScopeCurrent(activeAccountScope)) {
            const cards = await cardsRes.json();
            if (isAccountScopeCurrent(activeAccountScope)) setSavedCards(cards);
          }
          if (isAccountScopeCurrent(activeAccountScope)) {
            await reloadArticles(); // reload with user articles merged
          }
        }
      } catch (error) {
        if (!isAccountScopeCurrent(activeAccountScope)) return;
        logger.error("Failed to fetch initial data", { error });
        setIsAuthLoading(false);
        setIsArticlesLoading(false);
        setArticlesError(previous => previous ?? '内容加载失败');
        if (userRef.current) {
          const confirmedStatus = billingStatusRef.current;
          setBillingState(confirmedStatus
            ? { phase: 'ready', status: confirmedStatus }
            : { phase: 'error', status: null, error: error instanceof Error ? error.message : '账单系统暂时不可用' });
        }
      }
    };
    fetchData();
  }, []);

  const refreshBillingPlans = useCallback(async () => {
    setBillingCatalogState({ phase: 'loading', error: null });
    try {
      const response = await fetch('/api/billing/plans', { cache: 'no-store' });
      if (!response.ok) throw new Error(`套餐加载失败 (${response.status})`);
      const payload = await response.json() as { enabled?: unknown };
      if (payload?.enabled === false) {
        setBillingPlans([]);
        setBillingCatalogState({ phase: 'disabled', error: null });
        return;
      }
      const plans = normalizeBillingPlans(payload);
      if (plans.length === 0) throw new Error('套餐暂时不可用');
      setBillingPlans(plans);
      setBillingCatalogState({ phase: 'ready', error: null });
    } catch (error) {
      setBillingPlans([]);
      setBillingCatalogState({
        phase: 'error',
        error: error instanceof Error ? error.message : '套餐暂时不可用',
      });
    }
  }, []);

  useEffect(() => {
    void refreshBillingPlans();
  }, [refreshBillingPlans]);

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
    const accountScope = captureAccountScope();
    if (accountScope.userId === null) return;
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = window.setTimeout(() => {
      syncTimerRef.current = null;
      if (!isAccountScopeCurrent(accountScope)) return;
      fetch('/api/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(prefs)
      }).catch(error => logger.error('Failed to sync preferences', { error, prefs }));
    }, 500);
  }, [captureAccountScope, isAccountScopeCurrent]);

  const loadPreferences = async () => {
    const accountScope = captureAccountScope();
    try {
      const res = await fetch('/api/preferences');
      if (!isAccountScopeCurrent(accountScope) || accountScope.userId === null || !res.ok) return;
      const prefs = await res.json();
      if (!isAccountScopeCurrent(accountScope) || accountScope.userId === null) return;
      if (prefs.theme && (prefs.theme === 'light' || prefs.theme === 'dark')) {
        setTheme(prefs.theme);
      }
      if (prefs.view_mode && (prefs.view_mode === 'card' || prefs.view_mode === 'compact')) {
        setViewModeState(prefs.view_mode);
      }
      if (prefs.source_layout) {
        window.localStorage.setItem('atomflow:source-layout:v1', JSON.stringify(prefs.source_layout));
        window.dispatchEvent(new window.Event('atomflow:preferences-loaded'));
      }
    } catch {}
  };

  const loadNotes = async () => {
    const accountScope = captureAccountScope();
    try {
      const res = await fetch('/api/notes');
      if (res.ok && isAccountScopeCurrent(accountScope) && accountScope.userId !== null) {
        const nextNotes = await res.json();
        if (isAccountScopeCurrent(accountScope) && accountScope.userId !== null) setNotes(nextNotes);
      }
    } catch {}
  };
  const reloadNotes = loadNotes;

  const refreshBillingStatus = useCallback(async (): Promise<BillingStatus | null> => {
    if (!userRef.current) {
      billingStatusRef.current = null;
      setBillingState({ phase: 'idle', status: null });
      return null;
    }
    const scope = captureAccountScope();
    const requestId = ++billingStatusRequestRef.current;
    setBillingState(previous => previous.phase === 'ready' ? previous : { phase: 'loading', status: null });
    try {
      const status = await fetchBillingStatusFromApi();
      if (!isAccountScopeCurrent(scope) || requestId !== billingStatusRequestRef.current) return null;
      const previousAccess = billingStatusRef.current?.access;
      billingStatusRef.current = status;
      setBillingState({ phase: 'ready', status });
      const pendingIsConfirmed = status.access === 'full'
        && (billingConfirmationModeRef.current === 'subscription_purchase' || !status.paymentActionRequired);
      if (pendingIsConfirmed && checkoutStateRef.current.phase === 'pending') {
        clearPendingCheckoutConfirmation(scope.userId!);
        updateCheckoutState({ phase: 'idle', error: null });
        notifyBillingAccessChanged();
      }
      if (status.access !== 'none' && previousAccess === 'none') await loadNotes();
      return status;
    } catch (error) {
      if (!isAccountScopeCurrent(scope) || requestId !== billingStatusRequestRef.current) return null;
      const confirmedStatus = billingStatusRef.current;
      if (confirmedStatus) {
        setBillingState({ phase: 'ready', status: confirmedStatus });
        showToast('账单状态刷新失败，仍显示上次确认结果');
      } else {
        setBillingState({ phase: 'error', status: null, error: error instanceof Error ? error.message : '账单系统暂时不可用' });
      }
      return null;
    }
  }, [captureAccountScope, isAccountScopeCurrent, showToast, updateCheckoutState]);

  const pollBillingConfirmation = useCallback((mode: BillingConfirmationMode = 'subscription_purchase') => {
    if (billingPollRef.current !== null) window.clearTimeout(billingPollRef.current);
    billingConfirmationModeRef.current = mode;
    const scope = captureAccountScope();
    const startedAt = Date.now();
    const poll = async () => {
      if (!isAccountScopeCurrent(scope) || scope.userId === null) return;
      const status = await refreshBillingStatus();
      if (!isAccountScopeCurrent(scope)) return;
      const confirmed = status?.access === 'full'
        && (mode === 'subscription_purchase' || !status.paymentActionRequired);
      if (confirmed) {
        updateCheckoutState({ phase: 'idle', error: null });
        if (userRef.current) clearPendingCheckoutConfirmation(userRef.current.id);
        showToast(mode === 'payment_recovery' ? '付款信息已更新' : '魔法写作 Pro 已开通');
        notifyBillingAccessChanged();
        return;
      }
      if (Date.now() - startedAt >= 90_000) {
        updateCheckoutState({
          phase: 'pending',
          error: mode === 'payment_recovery'
            ? '付款信息已提交，仍在等待服务端确认。请重新检查，不要重复操作。'
            : '付款已提交，权限仍在确认中。请重新检查，不要重复付款。',
        });
        return;
      }
      billingPollRef.current = window.setTimeout(() => { void poll(); }, 2_500);
    };
    void poll();
  }, [captureAccountScope, isAccountScopeCurrent, refreshBillingStatus, showToast, updateCheckoutState]);

  const retryBillingConfirmation = useCallback(() => {
    if (!userRef.current || checkoutStateRef.current.phase !== 'pending') return;
    updateCheckoutState({ phase: 'confirming', error: null });
    pollBillingConfirmation(billingConfirmationModeRef.current);
  }, [pollBillingConfirmation, updateCheckoutState]);

  useEffect(() => {
    const transactionId = readPaddlePaymentLinkTransactionId();
    if (!transactionId) return;
    let active = true;
    let terminal = false;
    let unsubscribe: (() => void) | null = null;
    const clearPaymentLinkParameter = () => {
      const url = new URL(window.location.href);
      url.searchParams.delete('_ptxn');
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    };
    void initializePaddleForPaymentLink(event => {
      if (!active) return;
      if (event.name === 'checkout.loaded') {
        updateCheckoutState({ phase: 'open', error: null });
      } else if (event.name === 'checkout.completed' || event.name === 'transaction.completed') {
        terminal = true;
        unsubscribe?.();
        clearPaymentLinkParameter();
        if (userRef.current) {
          storePendingCheckoutConfirmation({
            userId: userRef.current.id,
            requestId: crypto.randomUUID(),
            planCode: null,
            transactionId,
            mode: 'payment_recovery',
          });
          updateCheckoutState({ phase: 'confirming', error: null });
          pollBillingConfirmation('payment_recovery');
        } else {
          showToast('付款信息已提交，请登录确认会员状态');
          setShowLoginModalState(true);
        }
      } else if (event.name === 'checkout.closed') {
        terminal = true;
        unsubscribe?.();
        clearPaymentLinkParameter();
        updateCheckoutState({ phase: 'idle', error: null });
      } else if (event.name === 'checkout.error' || event.name === 'checkout.failed' || event.name === 'transaction.payment_failed') {
        terminal = true;
        unsubscribe?.();
        clearPaymentLinkParameter();
        const message = '付款未完成，请检查付款信息后重试';
        updateCheckoutState({ phase: 'error', error: message });
        showToast(message);
      }
    }).then(cleanup => {
      if (!active || terminal) cleanup();
      else unsubscribe = cleanup;
    }).catch(error => {
      if (!active) return;
      const message = error instanceof Error ? error.message : '无法恢复 Paddle 付款页面';
      updateCheckoutState({ phase: 'error', error: message });
      showToast(message);
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [pollBillingConfirmation, showToast, updateCheckoutState]);

  const startBillingCheckout = useCallback(async (planCode: BillingPlanCode) => {
    if (!userRef.current) {
      storeBillingIntent({ kind: 'open_write' }, null);
      setShowLoginModalState(true);
      return;
    }
    const checkoutScope = captureAccountScope();
    if (billingStatusRef.current?.subscriptionStatus === 'paused') {
      showToast('请通过账单管理恢复或更新原订阅');
      return;
    }
    if (['creating', 'open', 'confirming', 'pending'].includes(checkoutStateRef.current.phase)) {
      showToast('付款或权限正在处理中，请勿重复结账');
      return;
    }
    updateCheckoutState({ phase: 'creating', error: null });
    try {
      const requestId = crypto.randomUUID();
      const response = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planCode, requestId }),
      });
      if (!isAccountScopeCurrent(checkoutScope)) return;
      const payload = await response.json().catch(() => null) as { transactionId?: string; transaction_id?: string; error?: string; code?: string } | null;
      if (!isAccountScopeCurrent(checkoutScope)) return;
      if (!response.ok) {
        if (payload?.code === 'BILLING_CHECKOUT_PENDING' || payload?.code === 'BILLING_ALREADY_ACTIVE') {
          storePendingCheckoutConfirmation({ userId: checkoutScope.userId!, requestId, planCode, transactionId: null });
          updateCheckoutState({ phase: 'pending', error: '已有付款或结账正在确认中。请稍后重新检查，不要重复付款。' });
          pollBillingConfirmation();
          return;
        }
        if (payload?.code === 'BILLING_UNAVAILABLE') throw new Error('账单系统暂时不可用，请勿重复付款');
        throw new Error(payload?.error || '无法创建结账');
      }
      const transactionId = payload?.transactionId || payload?.transaction_id;
      if (!transactionId) throw new Error('结账交易数据异常');
      paddleUnsubscribeRef.current?.();
      let terminalEventReceived = false;
      let checkoutUnsubscribe: (() => void) | null = null;
      const unsubscribe = await openPaddleTransaction(transactionId, event => {
        if (!isAccountScopeCurrent(checkoutScope)) return;
        if (event.name === 'checkout.completed' || event.name === 'transaction.completed') {
          terminalEventReceived = true;
          checkoutUnsubscribe?.();
          paddleUnsubscribeRef.current = null;
          updateCheckoutState({ phase: 'confirming', error: null });
          const checkoutUser = userRef.current;
          if (checkoutUser) storePendingCheckoutConfirmation({ userId: checkoutUser.id, requestId, planCode, transactionId });
          pollBillingConfirmation();
        } else if (event.name === 'checkout.closed') {
          terminalEventReceived = true;
          checkoutUnsubscribe?.();
          paddleUnsubscribeRef.current = null;
          updateCheckoutState({ phase: 'idle', error: null });
        } else if (event.name === 'checkout.error' || event.name === 'checkout.failed' || event.name === 'transaction.payment_failed') {
          terminalEventReceived = true;
          checkoutUnsubscribe?.();
          paddleUnsubscribeRef.current = null;
          updateCheckoutState({ phase: 'error', error: '付款未完成，请检查付款信息后重试' });
        }
      });
      checkoutUnsubscribe = unsubscribe;
      if (!isAccountScopeCurrent(checkoutScope)) {
        unsubscribe();
        return;
      }
      if (terminalEventReceived) {
        unsubscribe();
        return;
      }
      paddleUnsubscribeRef.current = unsubscribe;
      updateCheckoutState({ phase: 'open', error: null });
    } catch (error) {
      if (!isAccountScopeCurrent(checkoutScope)) return;
      updateCheckoutState({ phase: 'error', error: error instanceof Error ? error.message : '结账暂时不可用' });
    }
  }, [captureAccountScope, isAccountScopeCurrent, pollBillingConfirmation, updateCheckoutState]);

  useEffect(() => {
    if (!user || billingState.phase !== 'ready') return;
    if (billingState.status.access === 'full'
      && (billingConfirmationModeRef.current === 'subscription_purchase' || !billingState.status.paymentActionRequired)) {
      clearPendingCheckoutConfirmation(user.id);
      restoredPendingUserRef.current = null;
      return;
    }
    const pending = readPendingCheckoutConfirmation(user.id);
    if (!pending || restoredPendingUserRef.current === user.id) return;
    restoredPendingUserRef.current = user.id;
    billingConfirmationModeRef.current = pending.mode;
    updateCheckoutState({
      phase: 'pending',
      error: pending.mode === 'payment_recovery'
        ? '付款信息已提交，仍在等待服务端确认。请重新检查，不要重复操作。'
        : '付款已提交，权限仍在确认中。请重新检查，不要重复付款。',
    });
    pollBillingConfirmation(pending.mode);
  }, [billingState, pollBillingConfirmation, updateCheckoutState, user]);

  const openBillingPortal = useCallback(async () => {
    const portalScope = captureAccountScope();
    if (portalScope.userId === null) return;
    try {
      const response = await fetch('/api/billing/portal', { method: 'POST' });
      const payload = await response.json().catch(() => null) as { url?: string; portalUrl?: string; error?: string } | null;
      if (!isAccountScopeCurrent(portalScope)) return;
      if (!response.ok) throw new Error(payload?.error || '无法打开账单管理');
      const url = payload?.url || payload?.portalUrl;
      if (!url || !/^https:\/\//i.test(url)) throw new Error('账单管理链接无效');
      window.location.assign(url);
    } catch (error) {
      if (!isAccountScopeCurrent(portalScope)) return;
      showToast(error instanceof Error ? error.message : '无法打开账单管理');
    }
  }, [captureAccountScope, isAccountScopeCurrent]);

  const requestBillingIntent = useCallback((intent: BillingPendingIntent) => {
    const stored = storeBillingIntent(intent, userRef.current?.id ?? null);
    if (!userRef.current) setShowLoginModalState(true);
    return stored;
  }, []);

  const consumeBillingIntent = useCallback(() => {
    const currentUser = userRef.current;
    if (!currentUser) return null;
    return bindBillingIntentToUser(currentUser.id) || readBillingIntent(currentUser.id);
  }, []);

  const completeBillingIntent = useCallback((requestId: string) => clearBillingIntent(requestId), []);

  useEffect(() => {
    if (!user) return;
    const refresh = () => { void refreshBillingStatus(); };
    const channel = typeof BroadcastChannel === 'function'
      ? new BroadcastChannel(BILLING_SYNC_CHANNEL)
      : null;
    const handleFocus = () => refresh();
    channel?.addEventListener('message', refresh);
    window.addEventListener('atomflow:billing-access-changed', refresh);
    window.addEventListener('focus', handleFocus);
    return () => {
      channel?.removeEventListener('message', refresh);
      channel?.close();
      window.removeEventListener('atomflow:billing-access-changed', refresh);
      window.removeEventListener('focus', handleFocus);
    };
  }, [refreshBillingStatus, user]);

  useEffect(() => () => {
    if (billingPollRef.current !== null) window.clearTimeout(billingPollRef.current);
    paddleUnsubscribeRef.current?.();
  }, []);

  useEffect(() => {
    if (billingState.phase !== 'ready') return;
    if (billingState.status.access !== 'full') {
      window.dispatchEvent(new CustomEvent('atomflow:billing-read-only', { detail: billingState.status }));
    }
  }, [billingState]);

  const loadSavedArticles = async () => {
    const accountScope = captureAccountScope();
    try {
      const res = await fetch('/api/saved-articles');
      if (res.ok && isAccountScopeCurrent(accountScope) && accountScope.userId !== null) {
        const nextSavedArticles = await res.json();
        if (isAccountScopeCurrent(accountScope) && accountScope.userId !== null) setSavedArticles(nextSavedArticles);
      }
    } catch {}
  };

  // Restore user's custom subscriptions into localStorage (cross-device support)
  const loadUserSubscriptions = async () => {
    const accountScope = captureAccountScope();
    try {
      const res = await fetch('/api/subscriptions');
      if (!isAccountScopeCurrent(accountScope) || accountScope.userId === null || !res.ok) return;
      const subs: Array<{ name: string; rssUrl: string; color: string; icon?: string }> = await res.json();
      if (!isAccountScopeCurrent(accountScope) || accountScope.userId === null) return;
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
        window.dispatchEvent(new window.Event('atomflow:preferences-loaded'));
      }
    } catch {}
  };

  const createNote = async (data?: Partial<{ title: string; content: string; tags: string[]; meta: NoteMeta }>): Promise<Note | null> => {
    const accountScope = captureAccountScope();
    if (accountScope.userId === null || billingStatusRef.current?.access !== 'full') return null;
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
      if (!isAccountScopeCurrent(accountScope)) return null;
      if (res.status === 402) {
        await refreshBillingStatus();
        return null;
      }
      if (res.ok) {
        const note = await res.json();
        if (!isAccountScopeCurrent(accountScope)) return null;
        setNotes(prev => [note, ...prev]);
        return note;
      }
    } catch (error) {
      logger.error('Failed to create note', { error });
    }
    return null;
  };

  const updateNote = async (
    id: number,
    data: Partial<{ title: string; content: string; tags: string[]; meta: NoteMeta }>,
  ): Promise<boolean> => {
    const accountScope = captureAccountScope();
    if (accountScope.userId === null || billingStatusRef.current?.access !== 'full') return false;
    try {
      const requestBody = JSON.stringify(data);
      // Fetch keepalive has a browser-enforced ~64 KiB body budget. Keep the
      // unload-friendly path for small drafts without making large articles
      // permanently unsaveable during ordinary autosave.
      const keepalive = new TextEncoder().encode(requestBody).byteLength <= 60_000;
      const res = await fetch(`/api/notes/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: requestBody,
        keepalive,
      });
      if (!isAccountScopeCurrent(accountScope)) return false;
      if (res.status === 402) {
        await refreshBillingStatus();
        return false;
      }
      if (!res.ok) return false;
      const updated = await res.json();
      if (!isAccountScopeCurrent(accountScope)) return false;
      setNotes(prev => prev.map(n => n.id === id ? updated : n));
      return true;
    } catch (error) {
      logger.error('Failed to update note', { error, noteId: id });
      return false;
    }
  };

  const deleteNote = async (id: number) => {
    const accountScope = captureAccountScope();
    if (accountScope.userId === null || billingStatusRef.current?.access !== 'full') return;
    try {
      const res = await fetch(`/api/notes/${id}`, { method: 'DELETE' });
      if (!isAccountScopeCurrent(accountScope)) return;
      if (res.status === 402) {
        await refreshBillingStatus();
        return;
      }
      if (res.ok && isAccountScopeCurrent(accountScope)) {
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
    if (!user || !billingStatusRef.current || billingStatusRef.current.access === 'none') {
      setAssistantThreads([]);
      setAssistantThreadId(null);
      return [];
    }
    const accountScope = captureAccountScope();
    try {
      const response = await fetch(`/api/write/agent/threads?type=${threadType}`, { method: 'GET' });
      if (!isAccountScopeCurrent(accountScope) || accountScope.userId !== user.id || !response.ok) return [];
      const threads: WriteAgentThread[] = await response.json();
      if (!isAccountScopeCurrent(accountScope) || accountScope.userId !== user.id) return [];
      const normalized = Array.isArray(threads) ? threads : [];
      setAssistantThreads(normalized);
      setAssistantThreadId(prev => prev || (normalized[0]?.id ? Number(normalized[0].id) : null));
      return normalized;
    } catch {
      return [];
    }
  }, [captureAccountScope, isAccountScopeCurrent, user]);

  const createAssistantThread = useCallback(async (threadType: 'chat' | 'skill' = 'chat') => {
    if (!user) {
      setShowLoginModal(true);
      return null;
    }
    if (billingStatusRef.current?.access !== 'full') {
      showToast('当前为只读模式');
      return null;
    }
    const accountScope = captureAccountScope();
    try {
      const response = await fetch('/api/write/agent/threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '新的写作会话', threadType })
      });
      if (!isAccountScopeCurrent(accountScope) || accountScope.userId !== user.id) return null;
      if (!response.ok) {
        showToast('新建会话失败');
        return null;
      }
      const thread: WriteAgentThread = await response.json();
      if (!isAccountScopeCurrent(accountScope) || accountScope.userId !== user.id) return null;
      setAssistantThreads(prev => [thread, ...prev.filter(item => Number(item.id) !== Number(thread.id))]);
      setAssistantThreadId(Number(thread.id));
      return thread;
    } catch {
      if (isAccountScopeCurrent(accountScope) && accountScope.userId === user.id) {
        showToast('网络错误，新建会话失败');
      }
      return null;
    }
  }, [captureAccountScope, isAccountScopeCurrent, user]);

  const loadWriteAgentSkills = useCallback(async () => {
    if (!user || !billingStatusRef.current || billingStatusRef.current.access === 'none') {
      const fallback: WriteAgentSkill[] = [];
      setWriteAgentSkills(fallback);
      setSelectedStyleSkillId('system-columnist');
      setSelectedSkillIds(['system-card-storage', 'system-citation', 'system-writing', 'system-columnist']);
      return fallback;
    }
    const accountScope = captureAccountScope();
    try {
      const response = await fetch('/api/write/agent/skills');
      if (!isAccountScopeCurrent(accountScope) || accountScope.userId !== user.id || !response.ok) return [];
      const data = await response.json();
      if (!isAccountScopeCurrent(accountScope) || accountScope.userId !== user.id) return [];
      const skills: WriteAgentSkill[] = Array.isArray(data.skills) ? data.skills : [];
      setWriteAgentSkills(skills);
      normalizeSkillSelection(skills);
      return skills;
    } catch {
      return [];
    }
  }, [captureAccountScope, isAccountScopeCurrent, user]);

  const createWriteAgentSkill = useCallback(async (data: Partial<WriteAgentSkill> & { name: string; prompt: string }) => {
    if (!user) {
      setShowLoginModal(true);
      return null;
    }
    if (billingStatusRef.current?.access !== 'full') return null;
    const accountScope = captureAccountScope();
    try {
      const response = await fetch('/api/write/agent/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      if (!isAccountScopeCurrent(accountScope) || accountScope.userId !== user.id) return null;
      if (!response.ok) {
        showToast('Skill 保存失败');
        return null;
      }
      const payload = await response.json();
      if (!isAccountScopeCurrent(accountScope) || accountScope.userId !== user.id) return null;
      if (payload.skill) {
        setWriteAgentSkills(prev => [...prev, payload.skill]);
        setSelectedSkillIds(prev => Array.from(new Set([...prev, payload.skill.id])));
        if (payload.skill.type === 'style') setSelectedStyleSkillId(payload.skill.id);
        showToast(`已添加 Skill「${payload.skill.name}」`);
      }
      return payload.skill || null;
    } catch {
      if (isAccountScopeCurrent(accountScope) && accountScope.userId === user.id) {
        showToast('网络错误，Skill 保存失败');
      }
      return null;
    }
  }, [captureAccountScope, isAccountScopeCurrent, user]);

  const updateWriteAgentSkill = useCallback(async (id: number | string, data: Partial<WriteAgentSkill>) => {
    if (!user || typeof id === 'string' || billingStatusRef.current?.access !== 'full') return null;
    const accountScope = captureAccountScope();
    try {
      const response = await fetch(`/api/write/agent/skills/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      if (!isAccountScopeCurrent(accountScope) || accountScope.userId !== user.id) return null;
      if (!response.ok) {
        showToast('Skill 更新失败');
        return null;
      }
      const payload = await response.json();
      if (!isAccountScopeCurrent(accountScope) || accountScope.userId !== user.id) return null;
      if (payload.skill) {
        setWriteAgentSkills(prev => prev.map(skill => String(skill.id) === String(id) ? payload.skill : skill));
        showToast(`已更新 Skill「${payload.skill.name}」`);
      }
      return payload.skill || null;
    } catch {
      if (isAccountScopeCurrent(accountScope) && accountScope.userId === user.id) {
        showToast('网络错误，Skill 更新失败');
      }
      return null;
    }
  }, [captureAccountScope, isAccountScopeCurrent, user]);

  const deleteWriteAgentSkill = useCallback(async (id: number | string) => {
    if (!user || typeof id === 'string' || billingStatusRef.current?.access !== 'full') return false;
    const accountScope = captureAccountScope();
    try {
      const response = await fetch(`/api/write/agent/skills/${id}`, { method: 'DELETE' });
      if (!isAccountScopeCurrent(accountScope) || accountScope.userId !== user.id) return false;
      if (!response.ok) {
        showToast('Skill 删除失败');
        return false;
      }
      if (!isAccountScopeCurrent(accountScope) || accountScope.userId !== user.id) return false;
      setWriteAgentSkills(prev => prev.filter(skill => String(skill.id) !== String(id)));
      setSelectedSkillIds(prev => prev.filter(skillId => String(skillId) !== String(id)));
      showToast('已删除 Skill');
      return true;
    } catch {
      if (isAccountScopeCurrent(accountScope) && accountScope.userId === user.id) {
        showToast('网络错误，Skill 删除失败');
      }
      return false;
    }
  }, [captureAccountScope, isAccountScopeCurrent, user]);

  useEffect(() => {
    const canLoadWriteData = billingState.phase === 'ready' && billingState.status.access !== 'none';
    if (!user || !canLoadWriteData) {
      setAssistantThreads([]);
      setAssistantThreadId(null);
      setWriteAgentSkills([]);
      return;
    }
    void loadAssistantThreads();
    void loadWriteAgentSkills();
  }, [billingState, loadAssistantThreads, loadWriteAgentSkills, user]);

  const saveArticle = async (articleId: number, identity?: ArticleIdentity) => {
    if (!userRef.current) {
      setShowLoginModalState(true);
      return false;
    }
    const accountScope = captureAccountScope();
    if (accountScope.userId === null) return false;
    if (savingState.articleIds.length > 0) return false;
    const isCurrentAccount = () => isAccountScopeCurrent(accountScope);
    const setSaveProgress = (ids: number[], stage: string) => {
      if (!isCurrentAccount()) return;
      setSavingState({ articleIds: Array.from(new Set(ids)), stage });
    };
    try {
      if (!isCurrentAccount()) return false;
      setSaveProgress([articleId], saveStages[0]);
      const targetArticle = findArticleByIdentity(articles, identity || { id: articleId });
      if (!targetArticle) {
        if (isCurrentAccount()) showToast('文章已更新，请刷新后重试');
        return false;
      }
      let resolvedArticleId = articleId;
      let resolvedArticle = targetArticle;
      const refreshArticleIdentity = async () => {
        if (!isCurrentAccount()) return false;
        const articlesRes = await fetch('/api/articles', { cache: 'no-store' });
        if (!articlesRes.ok || !isCurrentAccount()) return false;
        const freshArticles: Article[] = await articlesRes.json();
        if (!isCurrentAccount()) return false;
        const matched = findArticleByIdentity(freshArticles, targetArticle);
        if (!matched) return false;
        setArticles(freshArticles);
        resolvedArticleId = matched.id;
        resolvedArticle = matched;
        setSaveProgress([articleId, resolvedArticleId], saveStages[0]);
        return true;
      };

      if (quickOpenMode && resolvedArticle?.url) {
        const buildForcedFullUrl = () => {
          const params = new URLSearchParams({ force: '1', t: String(Date.now()) });
          if (resolvedArticle) appendArticleIdentityParams(params, resolvedArticle);
          return `/api/articles/${resolvedArticleId}/full?${params.toString()}`;
        };
        if (!isCurrentAccount()) return false;
        let fullRes = await fetch(buildForcedFullUrl(), { cache: 'no-store' });
        if (!isCurrentAccount()) return false;
        if (fullRes.status === 404 && await refreshArticleIdentity()) {
          fullRes = await fetch(buildForcedFullUrl(), { cache: 'no-store' });
          if (!isCurrentAccount()) return false;
        }
        if (fullRes.ok) {
          const fullData = await fullRes.json();
          if (!isCurrentAccount()) return false;
          setArticles(prev => prev.map(a => matchesArticleIdentity(a, resolvedArticle) ? fullData.article : a));
          setReadingArticleState(current => matchesArticleIdentity(current, resolvedArticle) ? fullData.article : current);
          updateSourceArticleCache(resolvedArticleId, fullData.article);
        }
      }
      setSaveProgress([articleId, resolvedArticleId], saveStages[1]);
      await new Promise(resolve => setTimeout(resolve, 220));
      if (!isCurrentAccount()) return false;
      setSaveProgress([articleId, resolvedArticleId], saveStages[2]);
      const saveParams = new URLSearchParams();
      if (resolvedArticle) appendArticleIdentityParams(saveParams, resolvedArticle);
      let res = await fetch(`/api/articles/${resolvedArticleId}/save${saveParams.size ? `?${saveParams.toString()}` : ''}`, { method: 'POST' });
      if (!isCurrentAccount()) return false;
      if (res.status === 404 && await refreshArticleIdentity()) {
        const retrySaveParams = new URLSearchParams();
        if (resolvedArticle) appendArticleIdentityParams(retrySaveParams, resolvedArticle);
        res = await fetch(`/api/articles/${resolvedArticleId}/save${retrySaveParams.size ? `?${retrySaveParams.toString()}` : ''}`, { method: 'POST' });
        if (!isCurrentAccount()) return false;
      }
      if (res.ok) {
        const saveData = await res.json().catch(() => null);
        if (!isCurrentAccount()) return false;
        const savedArticleFromResponse = saveData?.article as Article | undefined;
        updateSourceArticleCache(resolvedArticleId, { ...savedArticleFromResponse, saved: true });
        if (resolvedArticleId !== articleId) {
          updateSourceArticleCache(articleId, { ...savedArticleFromResponse, saved: true });
        }
        setSaveProgress([articleId, resolvedArticleId], saveStages[3]);
        // Refresh data to get the new cards and updated article state
        const [articlesRes, cardsRes, savedArticlesRes] = await Promise.all([
          fetch('/api/articles'),
          fetch('/api/cards'),
          fetch('/api/saved-articles')
        ]);
        if (!isCurrentAccount()) return false;
        const freshArticles: Article[] | null = articlesRes.ok
          ? await articlesRes.json() as Article[]
          : null;
        const freshCards: AtomCard[] | null = cardsRes.ok
          ? await cardsRes.json() as AtomCard[]
          : null;
        const freshSavedArticles: SavedArticle[] | null = savedArticlesRes.ok
          ? await savedArticlesRes.json() as SavedArticle[]
          : null;
        if (!isCurrentAccount()) return false;
        if (freshArticles) {
          setArticles(freshArticles);
          const freshReadingArticle = (resolvedArticle
            ? findArticleByIdentity(freshArticles, resolvedArticle)
            : undefined) || savedArticleFromResponse;
          if (freshReadingArticle) {
            setReadingArticleState(current => mergeSavedReadingArticle(current, resolvedArticle, freshReadingArticle));
          }
        } else if (savedArticleFromResponse) {
          setReadingArticleState(current => mergeSavedReadingArticle(current, resolvedArticle, savedArticleFromResponse));
        }
        if (freshCards) setSavedCards(freshCards);
        if (freshSavedArticles) setSavedArticles(freshSavedArticles);
        showToast('已存入知识库');
        return true;
      } else {
        const errBody = await res.text().catch(() => '');
        if (!isCurrentAccount()) return false;
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
      if (!isCurrentAccount()) return false;
      logger.error("Failed to save article", { error, articleId });
      showToast('保存失败: 网络错误');
      return false;
    } finally {
      if (isCurrentAccount()) {
        await new Promise(resolve => setTimeout(resolve, 260));
        if (isCurrentAccount()) setSavingState({ articleIds: [], stage: null });
      }
    }
  };

  const isSavingArticle = (articleId: number) => savingState.articleIds.includes(articleId);
  const getSavingStageText = (articleId: number) => savingState.articleIds.includes(articleId) ? savingState.stage : null;

  const addCards = (cards: AtomCard[]) => {
    // This is mostly handled by saveArticle now, but keeping for compatibility if needed
    setSavedCards(prev => [...cards, ...prev]);
  };

  const addCard = async (card: AtomCard): Promise<boolean> => {
    const accountScope = captureAccountScope();
    if (accountScope.userId === null) return false;
    try {
      const res = await fetch('/api/cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(card)
      });
      if (!isAccountScopeCurrent(accountScope)) return false;
      if (res.ok) {
        const newCard = await res.json();
        if (!isAccountScopeCurrent(accountScope)) return false;
        setSavedCards(prev => [newCard, ...prev]);
        return true;
      }
      if (isAccountScopeCurrent(accountScope)) {
        logger.error("Add card API failed", { status: res.status, cardType: card.type });
      }
    } catch (error) {
      if (isAccountScopeCurrent(accountScope)) {
        logger.error("Failed to add card", { error, cardType: card.type });
      }
    }
    return false;
  };

  const updateCard = async (id: string, updated: Partial<AtomCard>): Promise<boolean> => {
    const accountScope = captureAccountScope();
    if (accountScope.userId === null) return false;
    try {
      const res = await fetch(`/api/cards/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated)
      });
      if (!isAccountScopeCurrent(accountScope)) return false;
      if (res.ok) {
        const updatedCard = await res.json();
        if (!isAccountScopeCurrent(accountScope)) return false;
        setSavedCards(prev => prev.map(c => c.id === id ? updatedCard : c));
        return true;
      }
      if (isAccountScopeCurrent(accountScope)) {
        logger.error("Update card API failed", { status: res.status, cardId: id });
      }
    } catch (error) {
      if (isAccountScopeCurrent(accountScope)) {
        logger.error("Failed to update card", { error, cardId: id });
      }
    }
    return false;
  };

  const deleteCard = async (id: string): Promise<boolean> => {
    const accountScope = captureAccountScope();
    if (accountScope.userId === null) return false;
    try {
      const res = await fetch(`/api/cards/${id}`, { method: 'DELETE' });
      if (!isAccountScopeCurrent(accountScope)) return false;
      if (res.ok && isAccountScopeCurrent(accountScope)) {
        setSavedCards(prev => prev.filter(c => c.id !== id));
        return true;
      }
      if (!res.ok && isAccountScopeCurrent(accountScope)) {
        logger.error("Delete card API failed", { status: res.status, cardId: id });
      }
    } catch (error) {
      if (isAccountScopeCurrent(accountScope)) {
        logger.error("Failed to delete card", { error, cardId: id });
      }
    }
    return false;
  };

  const loginAndDo = useCallback((action: () => void) => {
    if (userRef.current) {
      action();
      return;
    }
    setShowLoginModalState(true);
  }, []);

  const handleLoginSuccess = async (userData: User) => {
    const previousUserId = userRef.current?.id ?? null;
    replaceAccountOwner(userData);
    const accountScope = captureAccountScope();
    if (previousUserId !== userData.id) {
      resetAccountScopedState();
    }
    setIsAuthLoading(false);
    setShowLoginModalState(false);
    bindBillingIntentToUser(userData.id);
    setBillingState({ phase: 'loading', status: null });
    const billingRequestId = ++billingStatusRequestRef.current;
    setSourceArticles({});
    try {
      const [cardsRes, status] = await Promise.all([
        fetch('/api/cards'),
        fetchBillingStatusFromApi(),
        loadPreferences().then(() => loadUserSubscriptions()),
        loadSavedArticles()
      ]);
      if (isAccountScopeCurrent(accountScope) && billingRequestId === billingStatusRequestRef.current) {
        billingStatusRef.current = status;
        setBillingState({ phase: 'ready', status });
        if (status.access !== 'none') await loadNotes();
      }
      if (cardsRes.ok && isAccountScopeCurrent(accountScope)) {
        const cards = await cardsRes.json();
        if (isAccountScopeCurrent(accountScope)) setSavedCards(cards);
      }
      if (isAccountScopeCurrent(accountScope)) await reloadArticles(); // reload to include user's private articles
    } catch (error) {
      if (isAccountScopeCurrent(accountScope) && billingRequestId === billingStatusRequestRef.current) {
        const confirmedStatus = billingStatusRef.current;
        setBillingState(confirmedStatus
          ? { phase: 'ready', status: confirmedStatus }
          : { phase: 'error', status: null, error: error instanceof Error ? error.message : '账单系统暂时不可用' });
      }
    }
  };

  const logout = async () => {
    const pendingDraftFlushes: Promise<boolean>[] = [];
    window.dispatchEvent(new window.CustomEvent('atomflow:before-account-leave', {
      detail: {
        waitUntil: (pending: Promise<boolean>) => pendingDraftFlushes.push(pending),
      },
    }));
    const flushResults = await Promise.allSettled(pendingDraftFlushes);
    if (flushResults.some(result => result.status === 'rejected' || result.value !== true)) {
      showToast('文章草稿尚未保存，已取消退出；请检查网络后重试');
      return;
    }
    const logoutRequest = fetch('/api/auth/logout', { method: 'POST' }).catch(() => null);
    // Clear account-scoped UI state before waiting on the network. This also
    // synchronously changes the podcast provider owner and tears down playback.
    replaceAccountOwner(null);
    const loggedOutScope = captureAccountScope();
    resetAccountScopedState();
    setIsAuthLoading(false);
    clearBillingIntent();
    setShowLoginModalState(false);
    const logoutResponse = await logoutRequest;
    if (!isAccountScopeCurrent(loggedOutScope)) return;
    if (logoutResponse?.ok) {
      await reloadArticles(); // reload without user articles
    } else {
      showToast('退出请求未完成，已清空本地账户数据；请检查网络后重试');
    }
  };

  const updateProfile = async (nickname: string) => {
    const accountScope = captureAccountScope();
    if (accountScope.userId === null) throw new Error('请先登录');
    const res = await fetch('/api/auth/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname })
    });
    if (!isAccountScopeCurrent(accountScope)) return;
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (!isAccountScopeCurrent(accountScope)) return;
      throw new Error(data.error || '保存失败');
    }
    const data = await res.json();
    if (!isAccountScopeCurrent(accountScope)) return;
    userRef.current = data.user;
    setUser(data.user);
  };

  const updateAvatar = async (file: File) => {
    const accountScope = captureAccountScope();
    if (accountScope.userId === null) throw new Error('请先登录');
    const formData = new FormData();
    formData.append('avatar', file);
    const res = await fetch('/api/auth/avatar', {
      method: 'POST',
      body: formData
    });
    if (!isAccountScopeCurrent(accountScope)) return;
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (!isAccountScopeCurrent(accountScope)) return;
      throw new Error(data.error || '上传失败');
    }
    const data = await res.json();
    if (!isAccountScopeCurrent(accountScope)) return;
    userRef.current = data.user;
    setUser(data.user);
  };

  return (
    <AppContext.Provider value={{
      articles, isArticlesLoading, articlesError, articlesLoaded, sourceArticles, savedCards, savedArticles, saveArticle, addCards, addCard, updateCard, deleteCard,
      showToast, toastMsg, theme, toggleTheme,
      viewMode, setViewMode,
      readingArticle, setReadingArticle,
      activeSource, setActiveSource,
      reloadArticles, loadSourceArticles,
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
      billingState, billingPlans, billingCatalogState, checkoutState,
      refreshBillingStatus, refreshBillingPlans, retryBillingConfirmation, startBillingCheckout, openBillingPortal,
      requestBillingIntent, consumeBillingIntent, completeBillingIntent,
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
