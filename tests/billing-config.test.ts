import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { isBillingPlanCode, loadBillingConfig } from '../src/server/billing/config.js';

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

const BILLING_ENV_KEYS = [
  'BILLING_ENABLED',
  'PADDLE_ENVIRONMENT',
  'VITE_PADDLE_ENVIRONMENT',
  'PADDLE_API_KEY',
  'PADDLE_WEBHOOK_SECRET',
  'VITE_PADDLE_CLIENT_TOKEN',
  'PADDLE_MAGIC_WRITE_PRODUCT_ID',
  'PADDLE_MAGIC_WRITE_MONTHLY_PRICE_ID',
  'PADDLE_MAGIC_WRITE_YEARLY_PRICE_ID',
  'PADDLE_MAGIC_WRITE_LEGACY_PRICE_IDS',
] as const;

const withBillingEnv = <T>(values: Partial<Record<(typeof BILLING_ENV_KEYS)[number], string>>, run: () => T): T => {
  const previous = new Map(BILLING_ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of BILLING_ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);
  try {
    return run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const completeSandboxEnv = {
  BILLING_ENABLED: 'true',
  PADDLE_ENVIRONMENT: 'sandbox',
  VITE_PADDLE_ENVIRONMENT: 'sandbox',
  PADDLE_API_KEY: 'pdl_sdbx_apikey_test_fixture',
  PADDLE_WEBHOOK_SECRET: 'sandbox_webhook_secret',
  VITE_PADDLE_CLIENT_TOKEN: 'test_client_token',
  PADDLE_MAGIC_WRITE_PRODUCT_ID: 'pro_sandbox',
  PADDLE_MAGIC_WRITE_MONTHLY_PRICE_ID: 'pri_monthly',
  PADDLE_MAGIC_WRITE_YEARLY_PRICE_ID: 'pri_yearly',
  PADDLE_MAGIC_WRITE_LEGACY_PRICE_IDS: 'pri_legacy_one, pri_legacy_two',
} as const;

test('billing configuration is fail-closed and keeps catalog values server-owned', () => {
  const disabled = withBillingEnv({}, () => loadBillingConfig(false));
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.environment, 'sandbox');
  assert.equal(disabled.allowedPriceIds.size, 0);

  assert.throws(
    () => withBillingEnv({ BILLING_ENABLED: 'true' }, () => loadBillingConfig(false)),
    /Billing configuration is incomplete/,
  );
  assert.throws(
    () => withBillingEnv({ ...completeSandboxEnv, PADDLE_ENVIRONMENT: 'production' }, () => loadBillingConfig(false)),
    /Development and test billing must use.*sandbox/,
  );
  assert.throws(
    () => withBillingEnv(completeSandboxEnv, () => loadBillingConfig(true)),
    /Production billing must use.*production/,
  );
  assert.throws(
    () => withBillingEnv({ ...completeSandboxEnv, VITE_PADDLE_ENVIRONMENT: '' }, () => loadBillingConfig(false)),
    /VITE_PADDLE_ENVIRONMENT/,
  );
  assert.throws(
    () => withBillingEnv({ ...completeSandboxEnv, VITE_PADDLE_ENVIRONMENT: 'production' }, () => loadBillingConfig(false)),
    /must exactly match/,
  );

  const production = withBillingEnv({
    ...completeSandboxEnv,
    PADDLE_ENVIRONMENT: 'production',
    VITE_PADDLE_ENVIRONMENT: 'production',
    PADDLE_API_KEY: 'pdl_live_apikey_test_fixture',
    VITE_PADDLE_CLIENT_TOKEN: 'live_client_token',
  }, () => loadBillingConfig(true));
  assert.equal(production.enabled, true);
  assert.deepEqual(production.plans.map(plan => [plan.code, plan.priceCny, plan.currency]), [
    ['pro_monthly', 39, 'CNY'],
    ['pro_yearly', 399, 'CNY'],
  ]);
  assert.equal(production.plans[1]?.savingsCny, 69);
  assert.deepEqual([...production.allowedPriceIds].sort(), [
    'pri_legacy_one',
    'pri_legacy_two',
    'pri_monthly',
    'pri_yearly',
  ]);
  assert.equal(isBillingPlanCode('pro_monthly'), true);
  assert.equal(isBillingPlanCode('pro_yearly'), true);
  assert.equal(isBillingPlanCode('pri_monthly'), false, 'clients must submit plan codes, never price IDs');
});

test('billing dependencies and deployment configuration are explicit', () => {
  const packageJson = JSON.parse(read('package.json')) as {
    dependencies?: Record<string, string>;
  };
  const env = read('.env.example');
  const deployment = read('DEPLOYMENT.md');
  const workflow = read('.github/workflows/ci.yml');

  assert.ok(packageJson.dependencies?.['@paddle/paddle-js'], 'Paddle.js must be a declared runtime dependency');
  assert.ok(packageJson.dependencies?.['@paddle/paddle-node-sdk'], 'the official Paddle Node SDK must be declared');

  for (const name of [
    'BILLING_ENABLED',
    'PADDLE_ENVIRONMENT',
    'VITE_PADDLE_ENVIRONMENT',
    'PADDLE_API_KEY',
    'PADDLE_WEBHOOK_SECRET',
    'VITE_PADDLE_CLIENT_TOKEN',
    'PADDLE_MAGIC_WRITE_PRODUCT_ID',
    'PADDLE_MAGIC_WRITE_MONTHLY_PRICE_ID',
    'PADDLE_MAGIC_WRITE_YEARLY_PRICE_ID',
    'PADDLE_MAGIC_WRITE_LEGACY_PRICE_IDS',
    'REFUND_CONTACT_EMAIL',
  ]) {
    assert.match(env, new RegExp(`^${name}=`, 'm'), `${name} must be documented in .env.example`);
    assert.match(deployment, new RegExp(name), `${name} must be covered by the deployment guide`);
  }

  assert.match(env, /^BILLING_ENABLED=false$/m, 'billing must default off for a safe staged rollout');
  assert.match(env, /^PADDLE_ENVIRONMENT=sandbox$/m, 'shared local configuration must default to sandbox');
  assert.match(workflow, /^\s*RUN_REAL_BILLING_TESTS:\s*["']false["']\s*$/m, 'public CI must disable real billing tests');
  assert.doesNotMatch(workflow, /secrets\.(?:PADDLE|BILLING|VITE_PADDLE)/i, 'public CI must not receive Paddle credentials');
});

test('billing legal documents disclose the complete purchase and retention policy', () => {
  const terms = read('TERMS.md');
  const privacy = read('PRIVACY.md');
  const refunds = read('REFUNDS.md');

  for (const document of [terms, privacy, refunds]) {
    assert.match(document, /Paddle/, 'each billing-facing policy must identify Paddle');
  }

  assert.match(terms, /Merchant of Record|名义销售方/);
  assert.match(terms, /自动续费/);
  assert.match(terms, /月付人民币 39 元/);
  assert.match(terms, /年付人民币 399 元/);
  assert.match(terms, /合理使用制/);
  assert.match(terms, /不接触或存储完整银行卡号/);
  assert.match(terms, /3 天内/);
  assert.match(terms, /不超过 5 次/);
  assert.match(terms, /\/legal\/refunds/);

  assert.match(privacy, /Paddle Customer\/Subscription\/Transaction/);
  assert.match(privacy, /最小化的非卡片账单审计记录/);
  assert.match(privacy, /不保存完整卡号或 webhook 签名/);

  assert.match(refunds, /首笔订阅付款完成后的 3 个自然日内/);
  assert.match(refunds, /不超过 5 次/);
  assert.match(refunds, /续费付款原则上不退款/);
  assert.match(refunds, /重复扣款/);
  assert.match(refunds, /立即取消相关订阅/);
  assert.match(refunds, /\[REFUND_CONTACT_EMAIL\]/, 'refund requests must use a deployment-owned refund contact');
});
