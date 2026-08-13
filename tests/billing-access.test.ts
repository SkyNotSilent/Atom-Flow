import assert from 'node:assert/strict';
import { Environment } from '@paddle/paddle-node-sdk';
import type pg from 'pg';
import test from 'node:test';
import type { BillingConfig } from '../src/server/billing/config.js';
import { BillingService, mapSubscriptionStatusToAccess } from '../src/server/billing/service.js';
import type { PaddleSubscriptionStatus } from '../src/server/billing/types.js';

const config: BillingConfig = {
  enabled: true,
  environment: 'sandbox',
  sdkEnvironment: Environment.sandbox,
  apiKey: 'sandbox_api_key',
  webhookSecret: 'sandbox_webhook_secret',
  clientToken: 'test_client_token',
  productId: 'pro_sandbox',
  priceIds: { pro_monthly: 'pri_monthly', pro_yearly: 'pri_yearly' },
  allowedPriceIds: new Set(['pri_monthly', 'pri_yearly']),
  plans: [],
};

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const fakeAccessPool = (
  status: PaddleSubscriptionStatus | null,
  hasWritingHistory: boolean,
  hasBillingCustomer = Boolean(status),
) => ({
  query: async (sql: string, params: readonly unknown[] = []) => {
    if (sql.includes('FROM billing_subscriptions')) {
      assert.deepEqual(params, ['sandbox', 7], 'subscription access must stay environment- and user-scoped');
      return {
        rows: status ? [{
          status,
          planCode: 'pro_monthly',
          currentPeriodEndsAt: new Date('2026-09-01T00:00:00.000Z'),
          scheduledChange: status === 'active' ? { action: 'cancel' } : null,
        }] : [],
      };
    }
    if (sql.includes('AS "hasWritingHistory"')) {
      assert.deepEqual(params, [7, 'sandbox'], 'history and customer lookup must stay user- and environment-scoped');
      return { rows: [{ hasWritingHistory, hasBillingCustomer }] };
    }
    throw new Error(`unexpected query in billing access test: ${sql.slice(0, 80)}`);
  },
}) as unknown as pg.Pool;

test('subscription status mapping follows the Paddle access recommendation', () => {
  assert.equal(mapSubscriptionStatusToAccess('active'), 'full');
  assert.equal(mapSubscriptionStatusToAccess('trialing'), 'full');
  assert.equal(mapSubscriptionStatusToAccess('past_due'), 'full');
  assert.equal(mapSubscriptionStatusToAccess('paused'), 'read_only');
  assert.equal(mapSubscriptionStatusToAccess('canceled'), 'read_only');
  assert.equal(mapSubscriptionStatusToAccess(null), null);
});

test('access resolution preserves paid access through scheduled cancellation and marks past due', async () => {
  const scheduledCancel = await new BillingService(fakeAccessPool('active', true), config, logger)
    .resolveMagicWritingAccess(7);
  assert.equal(scheduledCancel.access, 'full');
  assert.deepEqual(scheduledCancel.scheduledChange, { action: 'cancel' });
  assert.equal(scheduledCancel.currentPeriodEndsAt, '2026-09-01T00:00:00.000Z');

  const pastDue = await new BillingService(fakeAccessPool('past_due', true), config, logger)
    .resolveMagicWritingAccess(7);
  assert.equal(pastDue.access, 'full');
  assert.equal(pastDue.paymentActionRequired, true);
});

test('accounts without a usable subscription fall back to read-only only when writing history exists', async () => {
  for (const status of ['paused', 'canceled'] as const) {
    const resolution = await new BillingService(fakeAccessPool(status, true), config, logger)
      .resolveMagicWritingAccess(7);
    assert.equal(resolution.access, 'read_only');
  }

  const legacy = await new BillingService(fakeAccessPool(null, true), config, logger)
    .resolveMagicWritingAccess(7);
  assert.equal(legacy.access, 'read_only');
  assert.equal(legacy.hasWritingHistory, true);
  assert.equal(legacy.hasBillingCustomer, false);

  const legacyWithBillingHistory = await new BillingService(fakeAccessPool(null, true, true), config, logger)
    .resolveMagicWritingAccess(7);
  assert.equal(legacyWithBillingHistory.access, 'read_only');
  assert.equal(legacyWithBillingHistory.hasBillingCustomer, true);

  const newAccount = await new BillingService(fakeAccessPool(null, false), config, logger)
    .resolveMagicWritingAccess(7);
  assert.equal(newAccount.access, 'none');
  assert.equal(newAccount.hasWritingHistory, false);
});

test('disabled billing keeps the existing product fully available', async () => {
  const disabled = new BillingService(fakeAccessPool(null, false), { ...config, enabled: false }, logger);
  const resolution = await disabled.resolveMagicWritingAccess(7);
  assert.equal(resolution.access, 'full');
  assert.equal(resolution.hasBillingCustomer, false);
});
