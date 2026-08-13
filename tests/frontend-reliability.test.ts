import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import { resolveFeedPageState } from '../src/utils/feedState';
import type { AtomCard, User } from '../src/types';

assert.equal(resolveFeedPageState({ isLoading: true, error: null, itemCount: 0 }), 'loading');
assert.equal(resolveFeedPageState({ isLoading: false, error: 'failed', itemCount: 0 }), 'error');
assert.equal(resolveFeedPageState({ isLoading: false, error: null, itemCount: 0 }), 'empty');
assert.equal(resolveFeedPageState({ isLoading: true, error: null, itemCount: 2 }), 'ready');

const discoverSource = readFileSync(new URL('../src/pages/DiscoverPage.tsx', import.meta.url), 'utf8');
const navSource = readFileSync(new URL('../src/components/Nav.tsx', import.meta.url), 'utf8');
const knowledgeSource = readFileSync(new URL('../src/pages/KnowledgePage.tsx', import.meta.url), 'utf8');
const inspirationSource = readFileSync(new URL('../src/components/InspirationButton.tsx', import.meta.url), 'utf8');
const appContextSource = readFileSync(new URL('../src/context/AppContext.tsx', import.meta.url), 'utf8');
const notesPanelSource = readFileSync(new URL('../src/components/NotesPanel.tsx', import.meta.url), 'utf8');

assert.doesNotMatch(discoverSource, /window\.location\.reload\(\)/, 'adding a source must not reload the app');
assert.match(discoverSource, /dispatchEvent\(new Event\(['"]atomflow:source-layout-changed['"]\)\)/);
assert.match(navSource, /addEventListener\(['"]atomflow:source-layout-changed['"], handler\)/);
assert.match(navSource, /const response = await fetch\(`\/api\/sources\/[\s\S]*?if \(!response\.ok\) \{[\s\S]*?setSourceEntries/);
assert.match(knowledgeSource, /const succeeded = isNew[\s\S]*?if \(!succeeded\) \{[\s\S]*?onClose\(\);/);
assert.match(inspirationSource, /const succeeded = await addCard\(card\);\s*if \(!succeeded\) \{/);
assert.match(appContextSource, /accountEpochRef\.current \+= 1;/, 'account changes must invalidate stale async work');
assert.match(appContextSource, /const resetAccountScopedState = useCallback[\s\S]*?setWriteFocusedTopic\(''\);[\s\S]*?setWriteActivatedNodeIds\(\[\]\);[\s\S]*?setWriteActivationSummary\(\[\]\);/);
assert.match(notesPanelSource, /const successful = await saveRequest;[\s\S]*?if \(!successful\)[\s\S]*?return false;[\s\S]*?pendingSaveRef\.current === pending/);
assert.match(notesPanelSource, /if \(!await flushPendingSave\(\)\) return false;[\s\S]*?setActiveNoteId\(noteId\)/, 'note switches must await durable save');
assert.match(notesPanelSource, /addEventListener\('pagehide', flushWhenPageLeaves\)/);
assert.match(appContextSource, /new TextEncoder\(\)\.encode\(requestBody\)\.byteLength <= 60_000/);

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost:1000' });
const previousWindow = globalThis.window;
const previousDocument = globalThis.document;
const previousNavigator = globalThis.navigator;
const previousFetch = globalThis.fetch;
Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });

let cardPostSucceeds = false;
let delayNextCardPost = false;
let resolveDelayedCardPost: ((response: Response) => void) | null = null;
let lastNoteKeepalive: boolean | undefined;
let logoutFetchCount = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method || 'GET';
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
  if (url === '/api/auth/me') return json({ user: null });
  if (url === '/api/billing/plans') return json({ enabled: false, plans: [] });
  if (url === '/api/billing/status') return json({
    enabled: false,
    access: 'full',
    subscriptionStatus: null,
    planCode: null,
    currentPeriodEnd: null,
    scheduledCancelAt: null,
    paymentActionRequired: false,
    hasLegacyWriteData: false,
  });
  if (url === '/api/articles') return json([]);
  if (url === '/api/cards' && method === 'POST') {
    if (delayNextCardPost) {
      delayNextCardPost = false;
      return await new Promise<Response>(resolve => {
        resolveDelayedCardPost = resolve;
      });
    }
    return cardPostSucceeds
      ? json({ id: 'saved-card', type: '灵感', content: '测试', tags: [], articleTitle: '测试', origin: 'manual' })
      : json({ error: 'failed' }, 500);
  }
  if (url === '/api/cards') return json([]);
  if (url === '/api/notes/123' && method === 'PUT') {
    lastNoteKeepalive = init?.keepalive;
    const body = JSON.parse(String(init?.body || '{}')) as { content?: string };
    return json({ id: 123, title: '大文章', content: body.content || '', tags: [], meta: {} });
  }
  if (url === '/api/preferences') return json({});
  if (url === '/api/subscriptions' || url === '/api/notes' || url === '/api/saved-articles') return json([]);
  if (url === '/api/auth/logout' && method === 'POST') {
    logoutFetchCount += 1;
    return json({ ok: true });
  }
  throw new Error(`Unexpected fetch: ${method} ${url}`);
}) as typeof fetch;

type TestContext = {
  user: User | null;
  savedCards: AtomCard[];
  showLoginModal: boolean;
  setShowLoginModal: (show: boolean) => void;
  loginAndDo: (action: () => void) => void;
  handleLoginSuccess: (user: User) => Promise<void>;
  logout: () => Promise<void>;
  addCard: (card: AtomCard) => Promise<boolean>;
  updateNote: (id: number, data: { content?: string }) => Promise<boolean>;
  writeFocusedTopic: string;
  setWriteFocusedTopic: (topic: string) => void;
  writeActivatedNodeIds: string[];
  setWriteActivatedNodeIds: (ids: string[]) => void;
  writeActivationSummary: string[];
  setWriteActivationSummary: (items: string[]) => void;
};

const vite = await createServer({
  appType: 'custom',
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true },
});
const contextModule = await vite.ssrLoadModule('/src/context/AppContext.tsx') as Record<string, unknown>;
const AppProvider = contextModule.AppProvider as React.ComponentType<{ children: React.ReactNode }>;
const useAppContext = contextModule.useAppContext as () => TestContext;
let context: TestContext | null = null;
function CaptureContext() {
  context = useAppContext();
  return null;
}

const container = document.getElementById('root');
assert.ok(container);
const root = createRoot(container);
const user: User = { id: 1, email: 'test@example.com', nickname: '测试用户', avatar_url: null };
const secondUser: User = { id: 2, email: 'second@example.com', nickname: '第二用户', avatar_url: null };
const card: AtomCard = {
  id: '',
  type: '灵感',
  content: '测试',
  tags: [],
  articleTitle: '测试',
  origin: 'manual',
};

try {
  await act(async () => {
    root.render(React.createElement(AppProvider, null, React.createElement(CaptureContext)));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  assert.ok(context);

  let firstActionCount = 0;
  let latestActionCount = 0;
  await act(async () => {
    context?.loginAndDo(() => { firstActionCount += 1; });
    context?.loginAndDo(() => { latestActionCount += 1; });
    await context?.handleLoginSuccess(user);
  });
  assert.equal(firstActionCount, 0, 'arbitrary login callbacks must never be persisted or replayed');
  assert.equal(latestActionCount, 0, 'post-login work must use a whitelisted session intent');

  await act(async () => {
    assert.equal(await context?.updateNote(123, { content: '长'.repeat(70_000) }), true);
  });
  assert.equal(lastNoteKeepalive, false, 'large articles must bypass the browser keepalive body limit');
  await act(async () => {
    assert.equal(await context?.updateNote(123, { content: '短草稿' }), true);
  });
  assert.equal(lastNoteKeepalive, true, 'small drafts should retain unload-friendly keepalive saves');

  let releaseDraftFlush: ((saved: boolean) => void) | null = null;
  const draftFlushListener = (event: Event) => {
    const waitUntil = (event as CustomEvent<{ waitUntil: (pending: Promise<boolean>) => void }>).detail.waitUntil;
    waitUntil(new Promise<boolean>(resolve => { releaseDraftFlush = resolve; }));
  };
  window.addEventListener('atomflow:before-account-leave', draftFlushListener);
  let logoutPromise: Promise<void> | null = null;
  await act(async () => {
    logoutPromise = context!.logout();
    await Promise.resolve();
  });
  assert.equal(logoutFetchCount, 0, 'logout must not invalidate the server session before pending drafts finish saving');
  assert.ok(releaseDraftFlush);
  (releaseDraftFlush as (saved: boolean) => void)(true);
  await act(async () => { await logoutPromise!; });
  window.removeEventListener('atomflow:before-account-leave', draftFlushListener);
  assert.equal(logoutFetchCount, 1);
  let cancelledActionCount = 0;
  await act(async () => {
    context?.loginAndDo(() => { cancelledActionCount += 1; });
  });
  assert.equal(context?.showLoginModal, true);
  await act(async () => {
    context?.setShowLoginModal(false);
    await context?.handleLoginSuccess(user);
  });
  assert.equal(cancelledActionCount, 0, 'closing login must clear the pending action');

  assert.equal(await context?.addCard(card), false, 'non-2xx card creation must report failure');
  cardPostSucceeds = true;
  await act(async () => {
    assert.equal(await context?.addCard(card), true, 'successful card creation must report success');
  });

  delayNextCardPost = true;
  let delayedSwitchResult: Promise<boolean> | null = null;
  await act(async () => {
    delayedSwitchResult = context!.addCard({ ...card, content: 'A 账号延迟卡片' });
    await Promise.resolve();
  });
  assert.ok(resolveDelayedCardPost, 'the delayed card request must be pending');
  await act(async () => {
    context!.setWriteFocusedTopic('A 账号选题');
    context!.setWriteActivatedNodeIds(['a-node']);
    context!.setWriteActivationSummary(['A 账号摘要']);
    await context!.handleLoginSuccess(secondUser);
  });
  assert.equal(context!.user?.id, secondUser.id);
  assert.equal(context!.writeFocusedTopic, '', 'switching accounts must clear the previous writing topic');
  assert.deepEqual(context!.writeActivatedNodeIds, []);
  assert.deepEqual(context!.writeActivationSummary, []);
  const resolveSwitchRequest = resolveDelayedCardPost as (response: Response) => void;
  resolveDelayedCardPost = null;
  resolveSwitchRequest(new Response(JSON.stringify({ ...card, id: 'stale-a-card' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
  await act(async () => {
    assert.equal(await delayedSwitchResult!, false, 'an A-account mutation must become stale after switching to B');
  });
  assert.equal(context!.savedCards.some(item => item.id === 'stale-a-card'), false, 'A-account data must not rehydrate B');

  delayNextCardPost = true;
  let delayedLogoutResult: Promise<boolean> | null = null;
  await act(async () => {
    delayedLogoutResult = context!.addCard({ ...card, content: 'B 账号延迟卡片' });
    await Promise.resolve();
  });
  assert.ok(resolveDelayedCardPost, 'the second delayed card request must be pending');
  await act(async () => {
    await context!.logout();
  });
  const resolveLogoutRequest = resolveDelayedCardPost as (response: Response) => void;
  resolveDelayedCardPost = null;
  resolveLogoutRequest(new Response(JSON.stringify({ ...card, id: 'stale-b-card' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
  await act(async () => {
    assert.equal(await delayedLogoutResult!, false, 'a mutation must become stale after logout');
  });
  assert.equal(context!.user, null);
  assert.deepEqual(context!.savedCards, [], 'logged-out state must remain empty after the stale response resolves');
} finally {
  await act(async () => root.unmount());
  await vite.close();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previousNavigator });
  globalThis.fetch = previousFetch;
  Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  dom.window.close();
}

console.log('PASS: frontend loading, auth actions, mutations, and source refresh are failure-aware');
