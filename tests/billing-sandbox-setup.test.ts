import assert from "node:assert/strict";
import test from "node:test";
import {
  priceMatchesSandboxPlan,
  renderSandboxBillingEnv,
  SANDBOX_PLAN_SPECS,
  SANDBOX_WEBHOOK_EVENTS,
  validateLocalBillingTestBaseUrl,
  validateLocalPostgresUrl,
  validateSandboxWebhookUrl,
} from "../src/server/billing/sandboxSetup.js";

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
