import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getBillingProvider, isAlipayPlanCode, loadAlipayBillingConfig } from "../src/server/billing/alipayConfig.js";
import { normalizeAlipayTrade, parseAlipayMoneyToCents } from "../src/server/billing/alipayService.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Alipay catalog exposes fixed-term individual purchase plans only", () => {
  const previous = { ...process.env };
  try {
    process.env.BILLING_PROVIDER = "alipay";
    process.env.BILLING_ENABLED = "false";
    const base = loadAlipayBillingConfig(false, "https://www.atomflow.cloud");
    assert.deepEqual(base.plans.map(plan => plan.code), ["pro_monthly", "pro_yearly"]);
    assert.ok(base.plans.every(plan => plan.audience === "individual"));
    assert.match(base.plans[0]?.name || "", /月度使用权/);
  } finally {
    process.env = previous;
  }
});

test("Alipay plan validation rejects team and provider resource IDs", () => {
  assert.equal(isAlipayPlanCode("pro_monthly"), true);
  assert.equal(isAlipayPlanCode("team_yearly"), false);
  assert.equal(isAlipayPlanCode("enterprise"), false);
});

test("Alipay money and trade normalization reject ambiguous amounts", () => {
  assert.equal(parseAlipayMoneyToCents("39"), 3900);
  assert.equal(parseAlipayMoneyToCents("399.00"), 39900);
  assert.equal(parseAlipayMoneyToCents("0.01"), 1);
  assert.equal(parseAlipayMoneyToCents("39.001"), null);
  assert.equal(parseAlipayMoneyToCents("-1"), null);
  assert.equal(parseAlipayMoneyToCents("0"), null);
  assert.deepEqual(normalizeAlipayTrade({
    out_trade_no: "ORDER_1",
    trade_no: "TRADE_1",
    trade_status: "trade_success",
    total_amount: "39.00",
    app_id: "APP_PLACEHOLDER",
    seller_id: "SELLER_PLACEHOLDER",
    gmt_payment: "2026-08-17 10:30:00",
  }), {
    outTradeNo: "ORDER_1",
    tradeNo: "TRADE_1",
    tradeStatus: "TRADE_SUCCESS",
    totalAmountCents: 3900,
    refundAmountCents: null,
    appId: "APP_PLACEHOLDER",
    sellerId: "SELLER_PLACEHOLDER",
    paidAt: "2026-08-17T02:30:00.000Z",
  });
  assert.equal(normalizeAlipayTrade({ out_trade_no: "ORDER_1", total_amount: "39.00" }), null);
});

test("unknown billing providers fail closed", () => {
  const previous = process.env.BILLING_PROVIDER;
  try {
    process.env.BILLING_PROVIDER = "unknown-provider";
    assert.throws(() => getBillingProvider(), /must be paddle or alipay/);
  } finally {
    if (previous === undefined) delete process.env.BILLING_PROVIDER;
    else process.env.BILLING_PROVIDER = previous;
  }
});

test("enabled Alipay website payment requires the real seller identity but no subscription catalog IDs", () => {
  const previous = { ...process.env };
  try {
    process.env.BILLING_PROVIDER = "alipay";
    process.env.BILLING_ENABLED = "true";
    process.env.ALIPAY_APP_ID = "APP_PLACEHOLDER";
    process.env.ALIPAY_APP_PRIVATE_KEY = "PRIVATE_KEY_PLACEHOLDER";
    process.env.ALIPAY_PUBLIC_KEY = "PUBLIC_KEY_PLACEHOLDER";
    process.env.ALIPAY_NOTIFY_URL = "https://www.atomflow.cloud/api/billing/webhooks/alipay";
    process.env.ALIPAY_RETURN_URL = "https://www.atomflow.cloud/?view=write&billing_return=alipay";
    delete process.env.ALIPAY_SELLER_ID;
    assert.throws(() => loadAlipayBillingConfig(true, "https://www.atomflow.cloud"), /ALIPAY_SELLER_ID/);
    process.env.ALIPAY_SELLER_ID = "SELLER_PLACEHOLDER";
    assert.equal(loadAlipayBillingConfig(true, "https://www.atomflow.cloud").enabled, true);
  } finally {
    process.env = previous;
  }
});

test("Alipay website payment grants only verified, idempotent fixed-term access", () => {
  const service = read("src/server/billing/alipayService.ts");
  const server = read("server.ts");
  const schema = read("src/server/billing/alipaySchema.ts");
  assert.match(service, /pageExec\("alipay\.trade\.page\.pay"/);
  assert.match(service, /product_code: "FAST_INSTANT_TRADE_PAY"/);
  assert.match(service, /不自动扣款/);
  assert.match(service, /checkNotifySignV2\(params\)/);
  assert.match(service, /trade\.appId !== this\.config\.appId/);
  assert.match(service, /trade\.sellerId !== this\.config\.sellerId/);
  assert.match(service, /trade\.totalAmountCents !== expectedAmountCents/);
  assert.match(service, /WITH RECURSIVE paid_orders[\s\S]*?status='paid'[\s\S]*?entitlement_timeline/);
  assert.match(service, /status='refunded'[\s\S]*?recomputeEntitlement/,
    "a verified full refund must revoke that order and rebuild the user's entitlement timeline");
  assert.match(service, /refundAmountCents >= expectedAmountCents[\s\S]*?markOrderRefunded/);
  assert.match(service, /pick\(result, "sub_code", "subCode"\)/,
    "camel-cased Alipay SDK errors must release orders from unrecoverable pending states");
  assert.match(service, /alipay\.trade\.query/);
  assert.match(service, /alipay\.trade\.close/,
    "account deletion must close remotely payable orders before deleting the user");
  assert.match(service, /alipay_one_time_entitlements entitlement[\s\S]*?entitlement\.access_ends_at > NOW\(\)[\s\S]*?orders\.last_reconciled_at IS NULL/,
    "every paid order contributing to a still-active entitlement must be queried for merchant-side refunds");
  assert.match(service, /appAuthToken: this\.config\.appAuthToken/,
    "authorized third-party merchant calls must carry their optional app authorization token");
  assert.doesNotMatch(service, /alipay\.trade\.subscription\./);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS alipay_one_time_orders/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS alipay_one_time_entitlements/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS alipay_payment_notifications/);
  assert.match(schema, /idx_alipay_one_time_pending_user/);
  assert.match(schema, /refund_amount_cents/);
  assert.match(schema, /last_reconciled_at/);
  assert.match(server, /\/api\/billing\/webhooks\/alipay/);
  assert.match(server, /status\(200\)\.type\("text\/plain"\)\.send\("success"\)/);
  assert.ok(server.indexOf('/api/billing/webhooks/alipay') < server.indexOf('app.use(express.json'), "Alipay notification route must run before the global JSON parser");
});

test("browser return never directly grants access", () => {
  const context = read("src/context/AppContext.tsx");
  assert.match(context, /billing_return/);
  assert.match(context, /pollBillingConfirmation\('term_purchase'\)/);
  assert.doesNotMatch(context, /billing_return[\s\S]{0,300}access:\s*'full'/);
});

test("official Alipay SDK is a runtime dependency and secrets are server-only", () => {
  const packageJson = JSON.parse(read("package.json"));
  const env = read(".env.example");
  assert.ok(packageJson.dependencies?.["alipay-sdk"]);
  assert.match(env, /ALIPAY_APP_PRIVATE_KEY/);
  assert.match(env, /ALIPAY_SELLER_ID/);
  assert.doesNotMatch(env, /VITE_ALIPAY_(?:PRIVATE|PUBLIC|AUTH)/);
  assert.match(env, /BILLING_PROVIDER=alipay/);
});
