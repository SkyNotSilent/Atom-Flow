type PaddleEvent = { name?: string; data?: unknown };

const DEFAULT_CHECKOUT_SETTINGS = {
  displayMode: 'overlay',
  theme: 'light',
  locale: 'zh-Hans',
} as const;

type PaddleApi = {
  Environment?: { set: (environment: 'sandbox' | 'production') => void };
  Initialize?: (options: {
    token: string;
    eventCallback: (event: PaddleEvent) => void;
    checkout?: { settings: typeof DEFAULT_CHECKOUT_SETTINGS };
  }) => void;
  Setup?: (options: {
    token: string;
    eventCallback: (event: PaddleEvent) => void;
    checkout?: { settings: typeof DEFAULT_CHECKOUT_SETTINGS };
  }) => void;
  Checkout: { open: (options: { transactionId: string; settings?: Record<string, unknown> }) => void };
};

declare global {
  interface Window { Paddle?: PaddleApi }
}

let loader: Promise<PaddleApi> | null = null;
const listeners = new Set<(event: PaddleEvent) => void>();
let initializedToken: string | null = null;
let initializedEnvironment: 'sandbox' | 'production' | null = null;

const dispatch = (event: PaddleEvent) => listeners.forEach(listener => listener(event));

export const loadPaddle = async (): Promise<PaddleApi> => {
  if (window.Paddle) return window.Paddle;
  if (loader) return loader;
  const pending = new Promise<PaddleApi>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-atomflow-paddle]');
    const script = existing || document.createElement('script');
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      script.remove();
      reject(error);
    };
    const timeout = window.setTimeout(() => fail(new Error('Paddle.js 加载超时')), 15_000);
    const finish = () => {
      if (settled) return;
      window.clearTimeout(timeout);
      if (window.Paddle) {
        settled = true;
        resolve(window.Paddle);
      } else {
        fail(new Error('Paddle.js 不可用'));
      }
    };
    script.addEventListener('load', finish, { once: true });
    script.addEventListener('error', () => fail(new Error('Paddle.js 加载失败')), { once: true });
    if (!existing) {
      script.src = 'https://cdn.paddle.com/paddle/v2/paddle.js';
      script.async = true;
      script.dataset.atomflowPaddle = 'true';
      document.head.appendChild(script);
    }
  });
  loader = pending;
  try {
    return await pending;
  } catch (error) {
    if (loader === pending) loader = null;
    throw error;
  }
};

const getPaddleEnvironment = (): 'sandbox' | 'production' => {
  const configured = import.meta.env.VITE_PADDLE_ENVIRONMENT?.trim().toLowerCase();
  if (configured === 'sandbox' || configured === 'production') return configured;
  throw new Error('Paddle 环境未配置，请设置 VITE_PADDLE_ENVIRONMENT');
};

export const readPaddlePaymentLinkTransactionId = (
  search = typeof window === 'undefined' ? '' : window.location.search,
): string | null => {
  const transactionId = new URLSearchParams(search).get('_ptxn')?.trim() || '';
  return /^txn_[a-z0-9]+$/i.test(transactionId) ? transactionId : null;
};

const initializePaddleClient = async (onEvent?: (event: PaddleEvent) => void) => {
  const token = import.meta.env.VITE_PADDLE_CLIENT_TOKEN?.trim();
  if (!token) throw new Error('结账尚未配置，请联系客服');
  const environment = getPaddleEnvironment();
  if (onEvent) listeners.add(onEvent);
  try {
    const paddle = await loadPaddle();
    if (!initializedToken) {
      paddle.Environment?.set(environment);
      const options = {
        token,
        eventCallback: dispatch,
        checkout: { settings: DEFAULT_CHECKOUT_SETTINGS },
      };
      // Paddle.js methods read internal state from their owning Paddle object.
      // Calling a detached Initialize/Setup function loses that receiver and
      // fails inside Paddle.js with "Cannot read ... _setup".
      if (paddle.Initialize) paddle.Initialize(options);
      else if (paddle.Setup) paddle.Setup(options);
      else throw new Error('Paddle.js 初始化接口不可用');
      initializedToken = token;
      initializedEnvironment = environment;
    } else if (initializedToken !== token || initializedEnvironment !== environment) {
      throw new Error('Paddle 客户端环境已变更，请刷新页面后重试');
    }
    return { paddle, unsubscribe: () => { if (onEvent) listeners.delete(onEvent); } };
  } catch (error) {
    if (onEvent) listeners.delete(onEvent);
    throw error;
  }
};

export const initializePaddleForPaymentLink = async (onEvent?: (event: PaddleEvent) => void) => {
  const { unsubscribe } = await initializePaddleClient(onEvent);
  return unsubscribe;
};

export const openPaddleTransaction = async (
  transactionId: string,
  onEvent: (event: PaddleEvent) => void,
) => {
  const { paddle, unsubscribe } = await initializePaddleClient(onEvent);
  try {
    paddle.Checkout.open({
      transactionId,
      settings: DEFAULT_CHECKOUT_SETTINGS,
    });
  } catch (error) {
    unsubscribe();
    throw error;
  }
  return unsubscribe;
};
