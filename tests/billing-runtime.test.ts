import assert from 'node:assert/strict';
import { Environment } from '@paddle/paddle-node-sdk';
import type pg from 'pg';
import test from 'node:test';
import type { BillingConfig } from '../src/server/billing/config.js';
import { BillingService } from '../src/server/billing/service.js';
import { BillingError } from '../src/server/billing/types.js';

type QueryResult = { rows: Array<Record<string, unknown>>; rowCount?: number };
type QueryHandler = (sql: string, params: readonly unknown[]) => Promise<QueryResult>;

const config: BillingConfig = {
  enabled: true,
  environment: 'sandbox',
  sdkEnvironment: Environment.sandbox,
  apiKey: 'pdl_sdbx_apikey_test_fixture',
  webhookSecret: 'pdl_ntfset_test_fixture',
  clientToken: 'test_client_token',
  productId: 'pro_sandbox',
  priceIds: { pro_monthly: 'pri_monthly', pro_yearly: 'pri_yearly' },
  allowedPriceIds: new Set(['pri_monthly', 'pri_yearly']),
  plans: [
    { code: 'pro_monthly', name: 'AtomFlow 魔法写作 Pro', priceCny: 39, interval: 'month', currency: 'CNY' },
    { code: 'pro_yearly', name: 'AtomFlow 魔法写作 Pro', priceCny: 399, interval: 'year', currency: 'CNY', savingsCny: 69 },
  ],
};

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const emptyResult = (): QueryResult => ({ rows: [], rowCount: 0 });

const fakePool = (handler: QueryHandler) => {
  const client = {
    query: (sql: string, params: readonly unknown[] = []) => handler(sql, params),
    release: () => undefined,
  };
  return { query: client.query, connect: async () => client } as unknown as pg.Pool;
};

const injectPaddle = (service: BillingService, paddle: object) => {
  Object.defineProperty(service, 'paddle', { configurable: true, value: paddle });
};

const validCatalogApi = () => ({
  products: {
    get: async () => ({ id: 'pro_sandbox', status: 'active' }),
  },
  prices: {
    get: async (priceId: string) => ({
      id: priceId,
      productId: 'pro_sandbox',
      status: 'active',
      unitPrice: {
        amount: priceId === 'pri_yearly' ? '39900' : '3900',
        currencyCode: 'CNY',
      },
      billingCycle: {
        interval: priceId === 'pri_yearly' ? 'year' : 'month',
        frequency: 1,
      },
      trialPeriod: null,
    }),
  },
});

const expectBillingError = async (promise: Promise<unknown>, code: string, status: number) => {
  await assert.rejects(promise, error => (
    error instanceof BillingError && error.code === code && error.status === status
  ));
};

test('checkout idempotency rejects a reused requestId with a different plan', async () => {
  const pool = fakePool(async sql => {
    if (sql.includes('pg_advisory_lock')) return emptyResult();
    if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
    if (sql.includes('SELECT 1 FROM billing_subscriptions')) return emptyResult();
    if (sql.includes('request_id = $3')) {
      return { rows: [{ id: 'attempt-1', transactionId: 'txn_1', planCode: 'pro_monthly', status: 'draft' }] };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  const service = new BillingService(pool, config, logger);
  await expectBillingError(
    service.createCheckout(7, 'reader@example.test', 'pro_yearly', '00000000-0000-4000-8000-000000000001'),
    'BILLING_IDEMPOTENCY_CONFLICT',
    409,
  );
});

test('a completed checkout remains pending until its subscription is confirmed', async () => {
  const pool = fakePool(async sql => {
    if (sql.includes('pg_advisory_lock')) return emptyResult();
    if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
    if (sql.includes('SELECT 1 FROM billing_subscriptions')) return emptyResult();
    if (sql.includes('request_id = $3')) return emptyResult();
    if (sql.includes("status IN ('creating', 'reconciling', 'draft', 'completed')")) {
      return { rows: [{ transactionId: 'txn_paid', planCode: 'pro_monthly', status: 'completed' }] };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  const service = new BillingService(pool, config, logger);
  await expectBillingError(
    service.createCheckout(7, 'reader@example.test', 'pro_monthly', '00000000-0000-4000-8000-000000000002'),
    'BILLING_CHECKOUT_PENDING',
    409,
  );
});

test('a timed-out Paddle create recovers the transaction by checkout attempt custom data', async () => {
  let attemptId = '';
  let recoveredStatus = '';
  const pool = fakePool(async (sql, params) => {
    if (sql.includes('pg_advisory_lock')) return emptyResult();
    if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
    if (sql.includes('SELECT 1 FROM billing_subscriptions')) return emptyResult();
    if (sql.includes('request_id = $3')) return emptyResult();
    if (sql.includes("status IN ('creating', 'reconciling', 'draft', 'completed')")) return emptyResult();
    if (sql.includes('INSERT INTO billing_checkout_attempts')) {
      attemptId = String(params[0]);
      return emptyResult();
    }
    if (sql.includes('FROM billing_customers WHERE')) return { rows: [{ id: 11, paddleCustomerId: 'ctm_1' }] };
    if (sql.includes('SET billing_customer_id')) return emptyResult();
    if (sql.includes('SET paddle_transaction_id = $1, status = $2')) {
      recoveredStatus = String(params[1]);
      return emptyResult();
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  const service = new BillingService(pool, config, logger);
  injectPaddle(service, {
    ...validCatalogApi(),
    transactions: {
      create: async () => { throw new Error('simulated timeout'); },
      list: () => (async function* () {
        yield { id: 'txn_recovered', status: 'draft', subscriptionId: null, customData: { checkout_attempt_id: attemptId } };
      })(),
    },
  });
  const result = await service.createCheckout(
    7,
    'reader@example.test',
    'pro_monthly',
    '00000000-0000-4000-8000-000000000003',
  );
  assert.deepEqual(result, { transactionId: 'txn_recovered', reused: true });
  assert.equal(recoveredStatus, 'draft');
});

test('a mismatched remote Paddle price blocks a new checkout before any attempt is created', async () => {
  let attemptCreated = false;
  let transactionCreated = false;
  const pool = fakePool(async sql => {
    if (sql.includes('pg_advisory_lock')) return emptyResult();
    if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
    if (sql.includes('SELECT 1 FROM billing_subscriptions')) return emptyResult();
    if (sql.includes('request_id = $3')) return emptyResult();
    if (sql.includes("status IN ('creating', 'reconciling', 'draft', 'completed')")) return emptyResult();
    if (sql.includes('INSERT INTO billing_checkout_attempts')) {
      attemptCreated = true;
      return emptyResult();
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  const service = new BillingService(pool, config, logger);
  const catalog = validCatalogApi();
  injectPaddle(service, {
    ...catalog,
    prices: {
      get: async (priceId: string) => ({
        ...(await catalog.prices.get(priceId)),
        unitPrice: { amount: priceId === 'pri_monthly' ? '9900' : '39900', currencyCode: 'CNY' },
      }),
    },
    transactions: {
      create: async () => {
        transactionCreated = true;
        return { id: 'txn_should_not_exist' };
      },
    },
  });

  await expectBillingError(
    service.createCheckout(7, 'reader@example.test', 'pro_monthly', '00000000-0000-4000-8000-000000000004'),
    'BILLING_CATALOG_INVALID',
    503,
  );
  assert.equal(attemptCreated, false);
  assert.equal(transactionCreated, false);
});

test('a canceled customer can still open Portal for invoices and recovery', async () => {
  let portalSubscriptionIds: string[] = [];
  let portalCustomerId = '';
  const pool = fakePool(async (sql, params) => {
    if (sql.includes('FROM billing_customers')) {
      assert.deepEqual(params, ['sandbox', 7], 'Portal customer lookup must stay environment- and user-scoped');
      return { rows: [{ customerId: 'ctm_canceled' }] };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  const service = new BillingService(pool, config, logger);
  injectPaddle(service, {
    customerPortalSessions: {
      create: async (_customerId: string, subscriptionIds: string[]) => {
        portalCustomerId = _customerId;
        portalSubscriptionIds = subscriptionIds;
        return { urls: { general: { overview: 'https://sandbox-login.paddle.com/portal/session' } } };
      },
    },
  });

  assert.deepEqual(await service.createPortal(7), { url: 'https://sandbox-login.paddle.com/portal/session' });
  assert.equal(portalCustomerId, 'ctm_canceled');
  assert.deepEqual(portalSubscriptionIds, []);
});

test('invalid webhook signatures fail before persistence', async () => {
  let queried = false;
  const pool = fakePool(async () => {
    queried = true;
    return emptyResult();
  });
  const service = new BillingService(pool, config, logger);
  injectPaddle(service, { webhooks: { unmarshal: async () => { throw new Error('bad signature'); } } });
  await expectBillingError(
    service.receiveWebhook(Buffer.from('{"event_id":"evt_1"}'), 'bad-signature'),
    'INVALID_WEBHOOK_SIGNATURE',
    400,
  );
  assert.equal(queried, false);
});

test('a signed webhook replay is durably deduplicated by environment and event id', async () => {
  const storedEvents = new Set<string>();
  const pool = fakePool(async (sql, params) => {
    if (sql.includes('INSERT INTO billing_webhook_events')) {
      storedEvents.add(`${String(params[0])}:${String(params[1])}`);
      return emptyResult();
    }
    if (sql.includes('SELECT event_id AS "eventId"')) return emptyResult();
    throw new Error(`unexpected query: ${sql}`);
  });
  const service = new BillingService(pool, config, logger);
  injectPaddle(service, { webhooks: { unmarshal: async () => ({}) } });
  const body = Buffer.from(JSON.stringify({
    event_id: 'evt_replayed',
    event_type: 'transaction.payment_failed',
    occurred_at: '2026-08-11T00:00:00.000Z',
    data: { id: 'txn_1', status: 'past_due', items: [] },
  }));
  await service.receiveWebhook(body, 'valid-signature');
  await service.receiveWebhook(body, 'valid-signature');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([...storedEvents], ['sandbox:evt_replayed']);
});

test('an older subscription webhook cannot overwrite a newer cached subscription', async () => {
  let cachedStatus = 'canceled';
  let cachedCursor = Date.parse('2026-08-12T00:00:00.000Z');
  let finalizedStatus = '';
  const advisoryKeys: string[] = [];
  const staleEvent = {
    eventType: 'subscription.updated',
    occurredAt: new Date('2026-08-11T00:00:00.000Z'),
    processingStatus: 'pending',
    nextAttemptAt: new Date(0),
    payload: {
      id: 'sub_1', status: 'active', customerId: 'ctm_1', productId: 'pro_sandbox', priceId: 'pri_monthly',
      customData: {}, currentPeriodStartsAt: null, currentPeriodEndsAt: null, scheduledChange: null,
      paddleUpdatedAt: '2026-08-11T00:00:00.000Z',
    },
  };
  const pool = fakePool(async (sql, params) => {
    if (sql.includes('SELECT event_id AS "eventId"')) return { rows: [{ eventId: 'evt_stale' }] };
    if (sql.includes('FROM billing_webhook_events WHERE')) return { rows: [staleEvent] };
    if (sql.includes('FROM billing_subscriptions WHERE')) return { rows: [{ userId: 7, billingCustomerId: 11 }] };
    if (sql.includes('FROM billing_customers')) return { rows: [{ id: 11, userId: 7 }] };
    if (sql.includes('INSERT INTO billing_subscriptions')) {
      const occurredAt = Date.parse(String(params[12]));
      if (occurredAt >= cachedCursor) {
        cachedCursor = occurredAt;
        cachedStatus = String(params[8]);
      }
      return emptyResult();
    }
    if (sql.includes('UPDATE billing_checkout_attempts')) return emptyResult();
    if (sql.includes('SET processing_status = $1')) {
      finalizedStatus = String(params[0]);
      return emptyResult();
    }
    if (sql.includes('pg_advisory_xact_lock')) {
      advisoryKeys.push(String(params[0]));
      return emptyResult();
    }
    if (sql.includes('BEGIN') || sql.includes('COMMIT') || sql.includes('ROLLBACK')) return emptyResult();
    if (sql.includes("SET processing_status = 'processing'")) return emptyResult();
    throw new Error(`unexpected query: ${sql}`);
  });
  const service = new BillingService(pool, config, logger);
  await service.processPendingEvents();
  assert.equal(finalizedStatus, 'processed');
  assert.equal(cachedStatus, 'canceled');
  assert.ok(advisoryKeys.length >= 2);
  assert.ok(advisoryKeys.every(key => key.startsWith('atomflow-billing-event:sandbox:')));
});

test('unknown subscription ownership is quarantined instead of granting access', async () => {
  let finalStatus = '';
  const event = {
    eventType: 'subscription.created',
    occurredAt: new Date('2026-08-11T00:00:00.000Z'),
    processingStatus: 'pending',
    nextAttemptAt: new Date(0),
    payload: {
      id: 'sub_unknown', status: 'active', customerId: 'ctm_unknown', productId: 'pro_sandbox', priceId: 'pri_monthly',
      customData: {}, currentPeriodStartsAt: null, currentPeriodEndsAt: null, scheduledChange: null,
      paddleUpdatedAt: '2026-08-11T00:00:00.000Z',
    },
  };
  const pool = fakePool(async (sql, params) => {
    if (sql.includes('SELECT event_id AS "eventId"')) return { rows: [{ eventId: 'evt_unknown' }] };
    if (sql.includes('FROM billing_webhook_events WHERE')) return { rows: [event] };
    if (sql.includes('FROM billing_subscriptions WHERE')) return emptyResult();
    if (sql.includes('FROM billing_customers')) return emptyResult();
    if (sql.includes('SET processing_status = $1')) {
      finalStatus = String(params[0]);
      return emptyResult();
    }
    if (sql.includes('BEGIN') || sql.includes('COMMIT') || sql.includes('ROLLBACK') || sql.includes('pg_advisory_xact_lock')) return emptyResult();
    if (sql.includes("SET processing_status = 'processing'")) return emptyResult();
    throw new Error(`unexpected query: ${sql}`);
  });
  const service = new BillingService(pool, config, logger);
  await service.processPendingEvents();
  assert.equal(finalStatus, 'quarantined');
});

test('account deletion stops when authoritative Paddle cancellation fails', async () => {
  let deleted = false;
  const pool = fakePool(async sql => {
    if (sql.includes('pg_advisory_lock')) return emptyResult();
    if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
    if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return emptyResult();
    if (sql.includes('FROM billing_customers')) return { rows: [{ id: 11, environment: 'sandbox', paddleCustomerId: 'ctm_1' }] };
    throw new Error(`unexpected query: ${sql}`);
  });
  const service = new BillingService(pool, config, logger);
  injectPaddle(service, {
    subscriptions: {
      list: () => (async function* () {
        yield {
          id: 'sub_1', status: 'active', customerId: 'ctm_1',
          items: [{ price: { id: 'pri_monthly', productId: 'pro_sandbox' } }],
          updatedAt: '2026-08-11T00:00:00.000Z', customData: {},
        };
      })(),
      cancel: async () => { throw new Error('Paddle unavailable'); },
    },
  });
  await expectBillingError(
    service.deleteAccountUnderBillingLock(7, async () => undefined, async () => { deleted = true; }),
    'BILLING_CANCELLATION_FAILED',
    503,
  );
  assert.equal(deleted, false);
});

test('account deletion never cancels an unrelated Paddle product', async () => {
  let canceled = false;
  let deleted = false;
  const pool = fakePool(async sql => {
    if (sql.includes('pg_advisory_lock')) return emptyResult();
    if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
    if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return emptyResult();
    if (sql.includes('AS owned_billing_customers')) {
      return { rows: [{ environment: 'sandbox', paddleCustomerId: 'ctm_shared' }] };
    }
    if (sql.includes('UPDATE billing_webhook_events')) return emptyResult();
    throw new Error(`unexpected query: ${sql}`);
  });
  const service = new BillingService(pool, config, logger);
  injectPaddle(service, {
    subscriptions: {
      list: () => (async function* () {
        yield {
          id: 'sub_other_product', status: 'active', customerId: 'ctm_shared',
          items: [{ price: { id: 'pri_other', productId: 'pro_other' } }],
          updatedAt: '2026-08-11T00:00:00.000Z', customData: {},
        };
      })(),
      cancel: async () => {
        canceled = true;
        throw new Error('unrelated subscriptions must not be canceled');
      },
    },
  });

  await service.deleteAccountUnderBillingLock(
    7,
    async () => undefined,
    async () => { deleted = true; },
  );
  assert.equal(canceled, false);
  assert.equal(deleted, true);
});

test('account deletion fails closed for an unrecognized price on the AtomFlow product', async () => {
  let canceled = false;
  let deleted = false;
  const pool = fakePool(async sql => {
    if (sql.includes('pg_advisory_lock')) return emptyResult();
    if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
    if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return emptyResult();
    if (sql.includes('AS owned_billing_customers')) {
      return { rows: [{ environment: 'sandbox', paddleCustomerId: 'ctm_atomflow' }] };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  const service = new BillingService(pool, config, logger);
  injectPaddle(service, {
    subscriptions: {
      list: () => (async function* () {
        yield {
          id: 'sub_unknown_price', status: 'active', customerId: 'ctm_atomflow',
          items: [{ price: { id: 'pri_not_allowlisted', productId: 'pro_sandbox' } }],
          updatedAt: '2026-08-11T00:00:00.000Z', customData: {},
        };
      })(),
      cancel: async () => {
        canceled = true;
        return {};
      },
    },
  });

  await expectBillingError(
    service.deleteAccountUnderBillingLock(7, async () => undefined, async () => { deleted = true; }),
    'BILLING_CANCELLATION_FAILED',
    503,
  );
  assert.equal(canceled, false);
  assert.equal(deleted, false);
});

test('account deletion blocks cross-environment billing identities before any Paddle call', async () => {
  let paddleCalled = false;
  let deleted = false;
  const pool = fakePool(async sql => {
    if (sql.includes('pg_advisory_lock')) return emptyResult();
    if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
    if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return emptyResult();
    if (sql.includes('AS owned_billing_customers')) {
      return { rows: [{ environment: 'production', paddleCustomerId: 'ctm_live' }] };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  const service = new BillingService(pool, config, logger);
  injectPaddle(service, {
    subscriptions: {
      list: () => {
        paddleCalled = true;
        return (async function* () {})();
      },
    },
  });

  await expectBillingError(
    service.deleteAccountUnderBillingLock(7, async () => undefined, async () => { deleted = true; }),
    'BILLING_CROSS_ENVIRONMENT_REVIEW_REQUIRED',
    503,
  );
  assert.equal(paddleCalled, false);
  assert.equal(deleted, false);
});

test('an approved refund quarantines a mismatched product before remote cancellation', async () => {
  let canceled = false;
  let finalStatus = '';
  const event = {
    eventType: 'adjustment.updated',
    occurredAt: new Date('2026-08-11T00:00:00.000Z'),
    processingStatus: 'pending',
    nextAttemptAt: new Date(0),
    payload: {
      status: 'approved', action: 'refund', type: 'full',
      transactionId: 'txn_known', subscriptionId: 'sub_other_product',
    },
  };
  const pool = fakePool(async (sql, params) => {
    if (sql.includes('SELECT event_id AS "eventId"')) return { rows: [{ eventId: 'evt_refund_other' }] };
    if (sql.includes('FROM billing_webhook_events WHERE')) return { rows: [event] };
    if (sql.includes('FROM billing_checkout_attempts')) {
      return { rows: [{ id: '00000000-0000-4000-8000-000000000005', userId: 7, billingCustomerId: 11, planCode: 'pro_monthly', status: 'completed' }] };
    }
    if (sql.includes('FROM billing_subscriptions')) return emptyResult();
    if (sql.includes('SET processing_status = $1')) {
      finalStatus = String(params[0]);
      return emptyResult();
    }
    if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
    if (sql.includes('BEGIN') || sql.includes('COMMIT') || sql.includes('ROLLBACK') || sql.includes('pg_advisory')) return emptyResult();
    if (sql.includes("SET processing_status = 'processing'")) return emptyResult();
    throw new Error(`unexpected query: ${sql}`);
  });
  const service = new BillingService(pool, config, logger);
  injectPaddle(service, {
    subscriptions: {
      get: async () => ({
        id: 'sub_other_product', status: 'active', customerId: 'ctm_other',
        items: [{ price: { id: 'pri_other', productId: 'pro_other' } }],
        updatedAt: '2026-08-11T00:00:00.000Z', customData: {},
      }),
      cancel: async () => {
        canceled = true;
        return {};
      },
    },
  });

  await service.processPendingEvents();
  assert.equal(canceled, false);
  assert.equal(finalStatus, 'quarantined');
});
