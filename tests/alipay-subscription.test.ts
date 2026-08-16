import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getBillingProvider, isAlipayPlanCode, isTeamPlanCode, loadAlipayBillingConfig } from "../src/server/billing/alipayConfig.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Alipay catalog exposes individual plans and hides incomplete team configuration", () => {
  const previous = { ...process.env };
  try {
    process.env.BILLING_PROVIDER = "alipay";
    process.env.BILLING_ENABLED = "false";
    delete process.env.ALIPAY_TEAM_PRODUCT_ID;
    delete process.env.ALIPAY_TEAM_MONTHLY_PRICE_ID;
    delete process.env.ALIPAY_TEAM_MONTHLY_PRICE_CNY;
    const base = loadAlipayBillingConfig(false, "https://www.atomflow.cloud");
    assert.deepEqual(base.plans.map(plan => plan.code), ["pro_monthly", "pro_yearly"]);

    process.env.ALIPAY_TEAM_PRODUCT_ID = "product_team";
    process.env.ALIPAY_TEAM_MONTHLY_PRICE_ID = "price_team_month";
    process.env.ALIPAY_TEAM_MONTHLY_PRICE_CNY = "59";
    const withTeam = loadAlipayBillingConfig(false, "https://www.atomflow.cloud");
    assert.deepEqual(withTeam.plans.map(plan => plan.code), ["pro_monthly", "pro_yearly", "team_monthly"]);
    assert.equal(withTeam.plans[2]?.minimumQuantity, 2);
  } finally {
    process.env = previous;
  }
});

test("Alipay plan validation distinguishes individual and seat subscriptions", () => {
  assert.equal(isAlipayPlanCode("pro_monthly"), true);
  assert.equal(isAlipayPlanCode("team_yearly"), true);
  assert.equal(isAlipayPlanCode("enterprise"), false);
  assert.equal(isTeamPlanCode("team_monthly"), true);
  assert.equal(isTeamPlanCode("pro_yearly"), false);
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

test("Alipay integration follows the subscription skill's trust and seat boundaries", () => {
  const service = read("src/server/billing/alipayService.ts");
  const server = read("server.ts");
  const schema = read("src/server/billing/alipaySchema.ts");
  assert.match(service, /if \(teamPlan\) item\.quantity = quantity; \/\/ individual subscriptions must omit quantity/);
  assert.match(service, /deduct_type: "SUBSCRIBE_DEDUCT"/);
  assert.match(service, /checkNotifySignV2\(params\)/);
  assert.match(service, /INCREASE_QUANTITY/);
  assert.match(service, /DECREASE_QUANTITY/);
  assert.match(service, /pending_item_id/);
  assert.match(service, /item_id AS "itemId"/);
  assert.match(service, /value\.length > 254/);
  assert.doesNotMatch(service, /\^\[\^\\s@\]\+@\[\^\\s@\]\+\\\.\[\^\\s@\]\+\$/);
  assert.match(schema, /UNIQUE INDEX IF NOT EXISTS idx_alipay_attempt_request/);
  assert.match(schema, /CHECK \(quantity > 0\)/);
  assert.match(server, /\/api\/billing\/webhooks\/alipay/);
  assert.match(server, /status\(200\)\.type\("text\/plain"\)\.send\("success"\)/);
  assert.ok(server.indexOf('/api/billing/webhooks/alipay') < server.indexOf('app.use(express.json'), "Alipay notification route must run before the global JSON parser");
});

test("browser return never directly grants access", () => {
  const context = read("src/context/AppContext.tsx");
  assert.match(context, /billing_return/);
  assert.match(context, /pollBillingConfirmation\('subscription_purchase'\)/);
  assert.doesNotMatch(context, /billing_return[\s\S]{0,300}access:\s*'full'/);
});

test("official Alipay SDK is a runtime dependency and secrets are server-only", () => {
  const packageJson = JSON.parse(read("package.json"));
  const env = read(".env.example");
  assert.ok(packageJson.dependencies?.["alipay-sdk"]);
  assert.match(env, /ALIPAY_APP_PRIVATE_KEY/);
  assert.doesNotMatch(env, /VITE_ALIPAY_(?:PRIVATE|PUBLIC|AUTH)/);
  assert.match(env, /BILLING_PROVIDER=alipay/);
});
