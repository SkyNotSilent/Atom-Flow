import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Environment, Paddle } from '@paddle/paddle-node-sdk';
import pg from 'pg';
import test from 'node:test';
import { validateLocalBillingTestBaseUrl, validateLocalPostgresUrl } from '../src/server/billing/sandboxSetup.js';

const enabled = process.env.RUN_REAL_BILLING_TESTS === 'true';
const required = (name: string) => {
  const value = process.env[name]?.trim();
  assert.ok(value, `${name} is required when RUN_REAL_BILLING_TESTS=true`);
  return value;
};

test('real Sandbox checkout, idempotency, status and Portal smoke', { skip: !enabled }, async () => {
  assert.equal(process.env.PADDLE_ENVIRONMENT, 'sandbox', 'real billing tests must never target Live');
  assert.ok(/^pdl_sdbx_apikey_/.test(required('PADDLE_API_KEY')), 'PADDLE_API_KEY must be a Sandbox key');
  assert.ok(/^test_/.test(required('VITE_PADDLE_CLIENT_TOKEN')), 'VITE_PADDLE_CLIENT_TOKEN must be a Sandbox token');
  const baseUrl = validateLocalBillingTestBaseUrl(process.env.BILLING_TEST_BASE_URL?.trim() || 'http://localhost:1000');
  const databaseUrl = validateLocalPostgresUrl(required('DATABASE_URL'));
  const email = required('TEST_EMAIL');
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
  const localAccount = (await pool.query(
    `SELECT id FROM users WHERE LOWER(email) = LOWER($1)`,
    [email],
  )).rows;
  assert.equal(localAccount.length, 1, 'TEST_EMAIL must identify exactly one account in the isolated local database');
  const csrf = await fetch(`${baseUrl}/api/csrf-token`, { cache: 'no-store' });
  if (!csrf.ok) assert.fail(`CSRF bootstrap failed (${csrf.status}): ${await csrf.text()}`);
  const bootstrapCookie = csrf.headers.get('set-cookie')?.split(';')[0];
  assert.ok(bootstrapCookie, 'the CSRF bootstrap must receive a session cookie');
  const csrfPayload = await csrf.json() as { csrfToken?: string };
  assert.match(csrfPayload.csrfToken || '', /^[A-Za-z0-9_-]{32,}$/);
  const login = await fetch(`${baseUrl}/api/auth/login-password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: bootstrapCookie,
      'X-CSRF-Token': csrfPayload.csrfToken || '',
    },
    body: JSON.stringify({ email, password: required('TEST_PASSWORD') }),
  });
  if (!login.ok) assert.fail(`login failed (${login.status}): ${await login.text()}`);
  const cookie = login.headers.get('set-cookie')?.split(';')[0] || bootstrapCookie;
  assert.ok(cookie, 'the isolated test account must receive a session cookie');
  const headers = {
    'Content-Type': 'application/json',
    Cookie: cookie,
    'X-CSRF-Token': csrfPayload.csrfToken || '',
  };

  const status = await fetch(`${baseUrl}/api/billing/status`, { headers, cache: 'no-store' });
  if (!status.ok) assert.fail(`billing status failed (${status.status}): ${await status.text()}`);
  const requestId = randomUUID();
  const create = () => fetch(`${baseUrl}/api/billing/checkout`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ planCode: 'pro_monthly', requestId }),
  });
  const first = await create();
  if (!first.ok) assert.fail(`checkout failed (${first.status}): ${await first.text()}`);
  const firstPayload = await first.json() as { transactionId?: string };
  assert.match(firstPayload.transactionId || '', /^txn_/);
  const persistedAttempt = (await pool.query(
    `SELECT a.paddle_transaction_id
     FROM billing_checkout_attempts a
     JOIN users u ON u.id = a.user_id
     WHERE a.environment = 'sandbox' AND LOWER(u.email) = LOWER($1)
       AND a.paddle_transaction_id = $2`,
    [email, firstPayload.transactionId],
  )).rows;
  assert.equal(
    persistedAttempt.length,
    1,
    'the localhost API and DATABASE_URL must point to the same isolated billing database',
  );
  const replay = await create();
  if (!replay.ok) assert.fail(`checkout replay failed (${replay.status}): ${await replay.text()}`);
  const replayPayload = await replay.json() as { transactionId?: string };
  assert.equal(replayPayload.transactionId, firstPayload.transactionId);

  const portal = await fetch(`${baseUrl}/api/billing/portal`, { method: 'POST', headers });
  if (!portal.ok) assert.fail(`portal failed (${portal.status}): ${await portal.text()}`);
  const portalPayload = await portal.json() as { url?: string };
  assert.match(portalPayload.url || '', /^https:\/\//);
  } finally {
    await pool.end();
  }
});

const expectedSimulationScenarios = [
  {
    name: 'AtomFlow checkout success',
    type: 'subscription_creation',
    outcomes: {
      'subscription.created': ['quarantined', 'subscription product or price is not allowed'],
      'subscription.activated': ['quarantined', 'subscription product or price is not allowed'],
      'transaction.completed': ['quarantined', 'transaction does not reference a known checkout attempt or subscription'],
    },
  },
  {
    name: 'AtomFlow payment failure',
    type: 'transaction.payment_failed',
    outcomes: {
      'transaction.payment_failed': ['quarantined', 'transaction does not reference a known checkout attempt or subscription'],
    },
  },
  {
    name: 'AtomFlow renewal failure',
    type: 'subscription.past_due',
    outcomes: {
      'subscription.past_due': ['quarantined', 'subscription product or price is not allowed'],
    },
  },
  {
    name: 'AtomFlow cancellation',
    type: 'subscription_cancellation',
    outcomes: {
      'subscription.updated': ['quarantined', 'subscription product or price is not allowed'],
      'subscription.canceled': ['quarantined', 'subscription product or price is not allowed'],
    },
  },
  {
    name: 'AtomFlow refund',
    type: 'adjustment.updated',
    outcomes: {
      'adjustment.updated': ['ignored', null],
    },
  },
] as const;

test('configured Paddle Sandbox simulations exercise the exact webhook security scenarios', { skip: !enabled }, async () => {
  assert.equal(process.env.PADDLE_ENVIRONMENT, 'sandbox', 'simulation runs must never target Live');
  const simulationIds = required('PADDLE_SANDBOX_SIMULATION_IDS').split(',').map(value => value.trim()).filter(Boolean);
  assert.equal(simulationIds.length, expectedSimulationScenarios.length, 'configure exactly the approved Sandbox simulation scenarios');
  assert.equal(new Set(simulationIds).size, simulationIds.length, 'Sandbox simulation IDs must be unique');
  const databaseUrl = validateLocalPostgresUrl(required('DATABASE_URL'));
  const paddle = new Paddle(required('PADDLE_API_KEY'), { environment: Environment.sandbox });
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    for (const [index, simulationId] of simulationIds.entries()) {
      const expected = expectedSimulationScenarios[index];
      const simulation = await paddle.simulations.get(simulationId);
      assert.equal(simulation.name, expected.name, `Sandbox simulation ${simulationId} has the wrong scenario name`);
      assert.equal(simulation.type, expected.type, `Sandbox simulation ${simulationId} has the wrong scenario type`);
      const created = await paddle.simulationRuns.create(simulationId);
      let current = created;
      const deadline = Date.now() + 60_000;
      while (current.status === 'pending' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 1_000));
        current = await paddle.simulationRuns.get(simulationId, created.id, { include: ['events'] });
      }
      assert.equal(current.status, 'completed', `Sandbox simulation ${simulationId} did not complete`);
      assert.ok((current.events?.length || 0) > 0, `Sandbox simulation ${simulationId} emitted no webhook events`);
      const failedEvents = (current.events || []).filter(event => !['success', 'aborted'].includes(event.status));
      assert.equal(failedEvents.length, 0, `Sandbox simulation ${simulationId} had failed webhook deliveries`);
      const deliveredEvents = (current.events || []).filter(event => event.status === 'success');
      assert.ok(deliveredEvents.length > 0, `Sandbox simulation ${simulationId} delivered no subscribed events`);
      assert.deepEqual(
        deliveredEvents.map(event => event.eventType).sort(),
        Object.keys(expected.outcomes).sort(),
        `Sandbox simulation ${simulationId} delivered an unexpected event set`,
      );
      const eventIds = deliveredEvents.map(event => {
        if (typeof event.request?.body !== 'string') return null;
        try {
          const envelope = JSON.parse(event.request.body) as { event_id?: unknown };
          return typeof envelope.event_id === 'string' ? envelope.event_id : null;
        } catch {
          return null;
        }
      }).filter((value): value is string => typeof value === 'string');
      assert.equal(eventIds.length, deliveredEvents.length, `Sandbox simulation ${simulationId} did not expose stable event IDs`);

      let received: Array<{ event_id: string; event_type: string; processing_status: string; error_message: string | null }> = [];
      const webhookDeadline = Date.now() + 30_000;
      while (Date.now() < webhookDeadline) {
        received = (await pool.query(
          `SELECT event_id, event_type, processing_status, error_message
           FROM billing_webhook_events
           WHERE environment = 'sandbox' AND event_id = ANY($1::text[])`,
          [eventIds],
        )).rows;
        if (
          received.length === eventIds.length
          && received.every(row => ['processed', 'ignored', 'quarantined'].includes(row.processing_status))
        ) break;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      assert.equal(received.length, eventIds.length, `Sandbox simulation ${simulationId} did not reach AtomFlow webhook inbox`);
      for (const row of received) {
        const outcome = expected.outcomes[row.event_type as keyof typeof expected.outcomes];
        assert.ok(outcome, `Sandbox simulation ${simulationId} delivered unexpected event ${row.event_type}`);
        assert.equal(row.processing_status, outcome[0], `${row.event_type} reached the wrong AtomFlow terminal state`);
        assert.equal(row.error_message, outcome[1], `${row.event_type} reached the wrong AtomFlow security reason`);
      }
    }
  } finally {
    await pool.end();
  }
});
