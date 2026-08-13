import assert from "node:assert/strict";
import test from "node:test";
import { reconcileSandboxNotificationSetting } from "../scripts/setup-paddle-sandbox.js";
import {
  priceMatchesSandboxPlan,
  renderSandboxBillingEnv,
  SANDBOX_NOTIFICATION_DESCRIPTION,
  SANDBOX_PLAN_SPECS,
  SANDBOX_WEBHOOK_EVENTS,
  validateLocalBillingTestBaseUrl,
  validateLocalPostgresUrl,
  validateSandboxWebhookUrl,
} from "../src/server/billing/sandboxSetup.js";

type NotificationFixture = {
  id: string;
  description: string;
  type: string;
  destination: string;
  active: boolean;
  includeSensitiveFields: boolean;
  trafficSource: string;
  subscribedEvents: Array<{ name: string }>;
  endpointSecretKey: string;
};

const notificationFixture = (overrides: Partial<NotificationFixture> = {}): NotificationFixture => ({
  id: "ntfset_atomflow",
  description: SANDBOX_NOTIFICATION_DESCRIPTION,
  type: "url",
  destination: "https://old-tunnel.example.com/api/billing/webhooks/paddle",
  active: true,
  includeSensitiveFields: false,
  trafficSource: "all",
  subscribedEvents: SANDBOX_WEBHOOK_EVENTS.map(name => ({ name })),
  endpointSecretKey: "pdl_ntfset_fixture",
  ...overrides,
});

test("Sandbox webhook setup accepts only the exact public HTTPS billing endpoint", () => {
  assert.equal(
    validateSandboxWebhookUrl("https://billing-test.example.com/api/billing/webhooks/paddle"),
    "https://billing-test.example.com/api/billing/webhooks/paddle",
  );
  for (const invalid of [
    "http://billing-test.example.com/api/billing/webhooks/paddle",
    "https://localhost/api/billing/webhooks/paddle",
    "https://127.0.0.1/api/billing/webhooks/paddle",
    "https://user:pass@billing-test.example.com/api/billing/webhooks/paddle",
    "https://billing-test.example.com/api/billing/webhooks/paddle?secret=x",
    "https://billing-test.example.com/not-the-webhook",
  ]) {
    assert.throws(() => validateSandboxWebhookUrl(invalid));
  }
});

test("Sandbox test targets cannot escape the local app or database through URL overrides", () => {
  assert.equal(validateLocalBillingTestBaseUrl("http://localhost:1000"), "http://localhost:1000");
  assert.equal(validateLocalPostgresUrl("postgresql://atomflow:secret@127.0.0.1:5432/atomflow"), "postgresql://atomflow:secret@127.0.0.1:5432/atomflow");
  for (const invalid of [
    "https://production.example.com",
    "http://localhost:1001",
    "http://user:password@localhost:1000",
  ]) assert.throws(() => validateLocalBillingTestBaseUrl(invalid));
  for (const invalid of [
    "postgresql://user:password@production.example.com/atomflow",
    "postgresql://user:password@localhost/atomflow?host=production.example.com",
    "postgresql://user:password@localhost/atomflow?sslmode=require",
  ]) assert.throws(() => validateLocalPostgresUrl(invalid));
});

test("Sandbox prices are pinned to CNY, exact cycles and no trial", () => {
  for (const spec of SANDBOX_PLAN_SPECS) {
    assert.equal(priceMatchesSandboxPlan({
      unitPrice: { amount: spec.amount, currencyCode: spec.currencyCode },
      billingCycle: { interval: spec.interval, frequency: spec.frequency },
      trialPeriod: null,
    }, spec), true);
    assert.equal(priceMatchesSandboxPlan({
      unitPrice: { amount: `${Number(spec.amount) + 1}`, currencyCode: spec.currencyCode },
      billingCycle: { interval: spec.interval, frequency: spec.frequency },
      trialPeriod: null,
    }, spec), false);
    assert.equal(priceMatchesSandboxPlan({
      unitPrice: { amount: spec.amount, currencyCode: spec.currencyCode },
      billingCycle: { interval: spec.interval, frequency: spec.frequency },
      trialPeriod: { interval: "day", frequency: 7 },
    }, spec), false);
  }
});

test("Sandbox webhooks cover dedicated subscription lifecycle transitions", () => {
  for (const eventType of [
    "subscription.created",
    "subscription.updated",
    "subscription.activated",
    "subscription.past_due",
    "subscription.paused",
    "subscription.resumed",
    "subscription.canceled",
  ]) assert.ok(SANDBOX_WEBHOOK_EVENTS.includes(eventType as (typeof SANDBOX_WEBHOOK_EVENTS)[number]));
});

test("Sandbox webhook setup rotates a temporary tunnel in place and is idempotent", async () => {
  const newWebhookUrl = "https://new-tunnel.example.com/api/billing/webhooks/paddle";
  let settings = [notificationFixture()];
  let createCalls = 0;
  let updateCalls = 0;
  const resource = {
    create: async () => {
      createCalls += 1;
      throw new Error("must not create a second managed webhook");
    },
    update: async (id: string, body: Record<string, unknown>) => {
      updateCalls += 1;
      const current = settings.find(item => item.id === id);
      assert.ok(current);
      const updated = notificationFixture({
        ...current,
        ...body,
        id,
        subscribedEvents: Array.isArray(body.subscribedEvents)
          ? body.subscribedEvents.map(name => ({ name: String(name) }))
          : current.subscribedEvents,
      });
      settings = settings.map(item => item.id === id ? updated : item);
      return updated;
    },
  };

  const rotated = await reconcileSandboxNotificationSetting({
    notificationSettings: settings,
    webhookUrl: newWebhookUrl,
    verifyOnly: false,
    resource,
  });
  assert.equal(rotated.id, "ntfset_atomflow");
  assert.equal(rotated.destination, newWebhookUrl);
  assert.equal(createCalls, 0);
  assert.equal(updateCalls, 1);

  await reconcileSandboxNotificationSetting({
    notificationSettings: settings,
    webhookUrl: newWebhookUrl,
    verifyOnly: false,
    resource,
  });
  assert.equal(createCalls, 0);
  assert.equal(updateCalls, 1, "a second setup run must not mutate an already-correct webhook");
});

test("Sandbox webhook setup disables duplicate active managed destinations safely", async () => {
  const currentWebhookUrl = "https://current-tunnel.example.com/api/billing/webhooks/paddle";
  let settings = [
    notificationFixture({ id: "ntfset_old" }),
    notificationFixture({ id: "ntfset_current", destination: currentWebhookUrl }),
  ];
  const updates: Array<{ id: string; body: Record<string, unknown> }> = [];
  const resource = {
    create: async () => {
      throw new Error("must not create when a managed webhook exists");
    },
    update: async (id: string, body: Record<string, unknown>) => {
      updates.push({ id, body });
      const current = settings.find(item => item.id === id);
      assert.ok(current);
      const updated = notificationFixture({
        ...current,
        ...body,
        id,
        subscribedEvents: Array.isArray(body.subscribedEvents)
          ? body.subscribedEvents.map(name => ({ name: String(name) }))
          : current.subscribedEvents,
      });
      settings = settings.map(item => item.id === id ? updated : item);
      return updated;
    },
  };

  const resolved = await reconcileSandboxNotificationSetting({
    notificationSettings: settings,
    webhookUrl: currentWebhookUrl,
    verifyOnly: false,
    resource,
  });
  assert.equal(resolved.id, "ntfset_current");
  assert.deepEqual(updates, [{ id: "ntfset_old", body: { active: false } }]);
  assert.equal(settings.find(item => item.id === "ntfset_old")?.active, false);

  await assert.rejects(
    reconcileSandboxNotificationSetting({
      notificationSettings: settings.map(item => item.id === "ntfset_old" ? { ...item, active: true } : item),
      webhookUrl: currentWebhookUrl,
      verifyOnly: true,
      resource,
    }),
    /Multiple active AtomFlow Sandbox webhook settings/,
  );
});

test("generated Sandbox billing environment is explicit and stays opt-in for real tests", () => {
  const body = renderSandboxBillingEnv({
    apiKey: "pdl_sdbx_apikey_fixture",
    webhookSecret: "pdl_ntfset_fixture",
    clientToken: "test_fixture",
    productId: "pro_fixture",
    monthlyPriceId: "pri_monthly_fixture",
    yearlyPriceId: "pri_yearly_fixture",
    webhookUrl: "https://billing-test.example.com/api/billing/webhooks/paddle",
    testEmail: "billing-sandbox@example.com",
    testPassword: "fixture-password",
  });
  assert.match(body, /^BILLING_ENABLED=true$/m);
  assert.match(body, /^PADDLE_ENVIRONMENT=sandbox$/m);
  assert.match(body, /^VITE_PADDLE_ENVIRONMENT=sandbox$/m);
  assert.match(body, /^RUN_REAL_BILLING_TESTS=false$/m);
  assert.match(body, /^TEST_EMAIL="billing-sandbox@example\.com"$/m);
  assert.match(body, /^TEST_PASSWORD="fixture-password"$/m);
  assert.doesNotMatch(body, /^PADDLE_ENVIRONMENT=production$/m);
  assert.doesNotMatch(body, /^VITE_PADDLE_ENVIRONMENT=production$/m);
  assert.doesNotMatch(body, /^PADDLE_API_KEY="pdl_live/i);
  assert.doesNotMatch(body, /^VITE_PADDLE_CLIENT_TOKEN="live_/im);
});
