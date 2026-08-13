import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { readPaddlePaymentLinkTransactionId } from '../src/billing/paddle.js';
import { MagicWritePaywall } from '../src/components/billing/MagicWritePaywall.js';
import { normalizeBillingPlans } from '../src/billing/catalog.js';
import {
  bindBillingIntentToUser,
  clearBillingIntent,
  readBillingIntent,
  storeBillingIntent,
} from '../src/billing/pendingIntent.js';
import {
  clearPendingCheckoutConfirmation,
  readPendingCheckoutConfirmation,
  storePendingCheckoutConfirmation,
} from '../src/billing/pendingCheckout.js';

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

test('billing status normalizer accepts the canonical server DTO and legacy client aliases', () => {
  const context = read('src/context/AppContext.tsx');
  const profile = read('src/components/ProfileModal.tsx');
  assert.match(context, /currentPeriodEnd[\s\S]*?current_period_end[\s\S]*?currentPeriodEndsAt[\s\S]*?current_period_ends_at/,
    'the server currentPeriodEndsAt field must reach the Profile renewal date');
  assert.match(context, /scheduledChange[\s\S]*?scheduled_change[\s\S]*?action === 'cancel'/,
    'a Paddle scheduled cancellation must reach the Profile cancellation state');
  assert.match(context, /effectiveAt[\s\S]*?effective_at[\s\S]*?currentPeriodEnd/,
    'scheduled cancellation should use its effective date and safely fall back to the period end');
  assert.match(context, /hasLegacyWriteData[\s\S]*?has_legacy_write_data[\s\S]*?hasWritingHistory[\s\S]*?has_writing_history/,
    'the server hasWritingHistory field must preserve legacy read-only UX');
  assert.match(profile, /scheduledCancelAt \?\? billingState\.status\.currentPeriodEnd/,
    'Profile must display the scheduled cancellation date instead of an unrelated renewal date');
  assert.doesNotMatch(context, /localStorage\.setItem\(['"]atomflow:billing-sync/,
    'billing access synchronization must not persist account state in cleartext browser storage');
  assert.match(context, /try\s*{[\s\S]*new BroadcastChannel\(BILLING_SYNC_CHANNEL\)[\s\S]*}\s*catch\s*{[\s\S]*return null;/,
    'billing access synchronization must tolerate browsers that expose but cannot open BroadcastChannel');
  assert.match(context, /openBillingSyncChannel\(\)/,
    'billing access synchronization should use an ephemeral cross-tab channel');
});

test('post-login billing intents are memory-scoped, user-bound and whitelisted', () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost:1000' });
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });

  const openWrite = storeBillingIntent({ kind: 'open_write' }, null);
  assert.match(openWrite.requestId, /^[0-9a-f-]{36}$/i);
  assert.equal(readBillingIntent(null)?.intent.kind, 'open_write');
  assert.equal(bindBillingIntentToUser(41)?.userId, 41);
  assert.equal(readBillingIntent(41)?.intent.kind, 'open_write');
  assert.equal(readBillingIntent(42), null, 'an intent bound to another account must be discarded');

  const podcast = storeBillingIntent({
    kind: 'add_podcast_episode',
    episodeId: 'episode-7',
    articleId: 12,
    sourceUrl: 'https://example.com/episode-7',
  }, 41);
  assert.equal(readBillingIntent(41)?.intent.kind, 'add_podcast_episode');
  clearBillingIntent(podcast.requestId);
  assert.equal(readBillingIntent(41), null, 'a successfully executed request must be consumed once');

  assert.throws(
    () => storeBillingIntent({ kind: 'redirect', url: 'https://evil.example' } as never, null),
    /Unsupported billing intent/,
    'arbitrary redirects must never be accepted',
  );
});

test('checkout confirmation survives refresh only for the same signed-in account', () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost:1000' });
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
  storePendingCheckoutConfirmation({
    userId: 41,
    requestId: '00000000-0000-4000-8000-000000000041',
    planCode: 'pro_yearly',
    transactionId: 'txn_paid',
  });
  assert.equal(readPendingCheckoutConfirmation(41)?.transactionId, 'txn_paid');
  assert.equal(readPendingCheckoutConfirmation(42), null, 'another account must never inherit a pending payment');
  storePendingCheckoutConfirmation({
    userId: 41,
    requestId: '00000000-0000-4000-8000-000000000042',
    planCode: 'pro_monthly',
    transactionId: null,
  });
  clearPendingCheckoutConfirmation(41);
  assert.equal(readPendingCheckoutConfirmation(41), null);

  storePendingCheckoutConfirmation({
    userId: 41,
    requestId: '00000000-0000-4000-8000-000000000043',
    planCode: null,
    transactionId: 'txn_payment_recovery',
    mode: 'payment_recovery',
  });
  assert.equal(readPendingCheckoutConfirmation(41)?.mode, 'payment_recovery');
  clearPendingCheckoutConfirmation(41);
});

test('blocked session storage never interrupts login or paid-checkout continuation', () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost:1000' });
  Object.defineProperty(dom.window, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: () => null,
      removeItem: () => undefined,
      setItem: () => { throw new dom.window.DOMException('blocked', 'SecurityError'); },
    },
  });
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });

  assert.doesNotThrow(() => storeBillingIntent({ kind: 'open_write' }, null));
  assert.doesNotThrow(() => storePendingCheckoutConfirmation({
    userId: 41,
    requestId: '00000000-0000-4000-8000-000000000044',
    planCode: 'pro_monthly',
    transactionId: 'txn_paid',
  }));
});

test('the write workspace waits for account-level billing and has explicit paywall/read-only states', () => {
  const app = read('src/App.tsx');
  const context = read('src/context/AppContext.tsx');
  const gate = read('src/components/billing/MagicWriteAccessGate.tsx');
  const paywall = read('src/components/billing/MagicWritePaywall.tsx');

  assert.match(app, /<MagicWriteAccessGate[\s\S]*?<WritePage/);
  assert.match(context, /billingState\.phase === 'ready' && billingState\.status\.access !== 'none'/, 'write data must not preload before entitlement is known');
  assert.match(gate, /billingState\.phase === 'idle' \|\| billingState\.phase === 'loading'/);
  assert.match(gate, /status\.access === 'none'[\s\S]*?<MagicWritePaywall/);
  assert.match(gate, /status\.access === 'read_only'/);
  assert.match(gate, /paymentActionRequired/);
  assert.match(gate, /正在等待服务端确认开通/, 'Paddle client events must not unlock access directly');
  assert.match(context, /storePendingCheckoutConfirmation/, 'completed payments must survive a page refresh while webhooks settle');
  assert.match(context, /subscriptionStatus === 'paused'/, 'only a paused subscription is forced through Portal recovery');
  assert.match(gate, /subscriptionStatus === null \|\| status\.subscriptionStatus === 'canceled'/, 'legacy and canceled read-only users need a new checkout path');

  assert.match(paywall, /自动续费/);
  assert.match(paywall, /税费以 Paddle 结账页为准/);
  assert.match(paywall, /3 天内且 AI 写作操作不超过 5 次/);
  assert.match(paywall, /合理使用制/);
  assert.match(paywall, /href="\/legal\/terms"/);
  assert.match(paywall, /href="\/legal\/privacy"/);
  assert.match(paywall, /href="\/legal\/refunds"/);
});

test('read-only mode reaches the canvas, article editor and Notes mutation boundaries', () => {
  const context = read('src/context/AppContext.tsx');
  const canvas = read('src/pages/MagicWritingCanvas.tsx');
  const writePage = read('src/pages/WritePage.tsx');
  const notes = read('src/components/NotesPanel.tsx');
  const draftRecovery = read('src/components/billing/DraftRecoveryPanel.tsx');

  assert.match(canvas, /billingState\.status\.access === ['"]full['"]/);
  assert.match(canvas, /isReadonly:\s*!canWrite/, 'tldraw itself must enter read-only mode');
  assert.match(canvas, /performBusinessFetch[\s\S]*?!canWriteRef\.current/, 'all canvas business mutations need a shared client-side gate');
  assert.match(writePage, /<NotesPanel/, 'the article editor must stay behind the guarded Notes component');
  assert.match(notes, /setEditable\(canWrite\)/, 'Notes editor must become read-only');
  assert.match(notes, /if \(!canWrite\) return/, 'Notes mutations must stop before making a request');
  assert.match(context, /res\.status === 402[\s\S]*?refreshBillingStatus\(\)/,
    'a server-side entitlement change must make a rejected Notes autosave refresh billing immediately');
  assert.match(canvas, /response\.status === 402[\s\S]*?refreshBillingStatus\(\)/,
    'a server-side entitlement change must make rejected canvas saves enter local draft protection');
  assert.match(draftRecovery, /generationRef/, 'draft reads must be generation-scoped across account switches');
  assert.match(draftRecovery, /downloadProtectedDraftById\(userId, draft\.id\)/, 'downloads must re-check the current user instead of trusting stale UI state');
  assert.match(draftRecovery, /event\.key !== 'Tab'/, 'the recovery dialog must trap keyboard focus');
});

test('billing recovery UX fails closed and always offers an explicit way forward', () => {
  const context = read('src/context/AppContext.tsx');
  const gate = read('src/components/billing/MagicWriteAccessGate.tsx');
  const paywall = read('src/components/billing/MagicWritePaywall.tsx');
  const paddleClient = read('src/billing/paddle.ts');
  const profile = read('src/components/ProfileModal.tsx');

  assert.doesNotMatch(paywall, /fallbackPlans/, 'a failed catalog request must never create payable fallback prices');
  assert.match(context, /retryBillingConfirmation/, 'timed-out payment confirmation needs an explicit retry action');
  assert.match(gate, /重新检查开通状态/);
  assert.match(gate, /登录 \/ 注册/, 'closing the initial sign-in modal must not strand a deep-linked visitor');
  assert.match(gate, /checkoutState\.phase === 'error'[\s\S]*?checkoutState\.error/, 'read-only checkout errors must remain visible while retry buttons are enabled');
  assert.match(profile, /status\.enabled/, 'billing-disabled accounts must not be presented as paid subscribers');
  assert.match(profile, /checkoutState\.error/, 'checkout errors started from Profile must be visible in Profile');
  assert.match(profile, /hasBillingCustomer/, 'canceled or legacy read-only customers must retain Portal access');
  assert.match(paddleClient, /if \(paddle\.Initialize\) paddle\.Initialize\(options\)/, 'Paddle.Initialize must keep the Paddle object as its method receiver');
  assert.match(paddleClient, /else if \(paddle\.Setup\) paddle\.Setup\(options\)/, 'legacy Paddle.Setup must keep the Paddle object as its method receiver');

  const unavailable = renderToStaticMarkup(React.createElement(MagicWritePaywall, {
    plans: [],
    catalogPhase: 'error',
    catalogError: '套餐暂时不可用',
    busy: false,
    error: null,
    onCheckout: () => undefined,
    onRetryPlans: () => undefined,
  }));
  assert.match(unavailable, /套餐暂时不可用/);
  assert.doesNotMatch(unavailable, /¥(?:39|399)/, 'unverified prices must not be rendered');
  assert.match(unavailable, /disabled=""/, 'checkout must stay disabled while catalog data is unavailable');

  assert.deepEqual(normalizeBillingPlans({ plans: [{ code: 'pro_monthly', name: '月付' }] }), [], 'missing prices must not fall back to a made-up amount');
  assert.deepEqual(normalizeBillingPlans({ plans: [{ code: 'pro_monthly', name: '月付', priceCny: 39 }] }), [{
    code: 'pro_monthly',
    name: '月付',
    priceCny: 39,
    interval: 'month',
    currency: 'CNY',
  }]);
});

test('Paddle default payment links initialize only for a valid _ptxn transaction', () => {
  assert.equal(readPaddlePaymentLinkTransactionId('?_ptxn=txn_01h2b0qpjc0xt8k5aw6nsdec4p'), 'txn_01h2b0qpjc0xt8k5aw6nsdec4p');
  assert.equal(readPaddlePaymentLinkTransactionId('?view=write'), null);
  assert.equal(readPaddlePaymentLinkTransactionId('?_ptxn=https%3A%2F%2Fevil.example'), null);

  const context = read('src/context/AppContext.tsx');
  assert.match(context, /readPaddlePaymentLinkTransactionId/);
  assert.match(context, /initializePaddleForPaymentLink/);
  assert.match(context, /checkout\.error/);
  assert.match(context, /checkout\.failed/);
  assert.match(context, /mode: 'payment_recovery'/, 'payment-link confirmation must survive refresh while webhooks settle');
});
