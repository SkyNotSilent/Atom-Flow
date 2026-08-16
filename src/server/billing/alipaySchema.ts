import type pg from "pg";

type SchemaClient = pg.Pool | pg.PoolClient;

export const ensureAlipayBillingSchema = async (client: SchemaClient) => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS alipay_billing_customers (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      alipay_customer_id TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_alipay_customer_user ON alipay_billing_customers(user_id) WHERE user_id IS NOT NULL`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS alipay_billing_checkout_attempts (
      id UUID PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      request_id UUID NOT NULL,
      plan_code TEXT NOT NULL CHECK (plan_code IN ('pro_monthly','pro_yearly','team_monthly','team_yearly')),
      quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
      customer_id TEXT,
      subscription_id TEXT,
      order_no TEXT,
      checkout_url TEXT,
      status TEXT NOT NULL DEFAULT 'creating' CHECK (status IN ('creating','pending','confirmed','expired','failed','canceled')),
      error_code TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_alipay_attempt_request ON alipay_billing_checkout_attempts(user_id, request_id) WHERE user_id IS NOT NULL`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_alipay_attempt_subscription ON alipay_billing_checkout_attempts(subscription_id) WHERE subscription_id IS NOT NULL`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_alipay_attempt_pending_user ON alipay_billing_checkout_attempts(user_id) WHERE user_id IS NOT NULL AND status IN ('creating','pending')`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS alipay_billing_subscriptions (
      id BIGSERIAL PRIMARY KEY,
      alipay_subscription_id TEXT NOT NULL UNIQUE,
      alipay_customer_id TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      product_id TEXT,
      price_id TEXT NOT NULL,
      plan_code TEXT CHECK (plan_code IN ('pro_monthly','pro_yearly','team_monthly','team_yearly')),
      status TEXT NOT NULL CHECK (status IN ('incomplete','active','trialing','past_due','paused','canceled','expired')),
      item_id TEXT,
      quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
      pending_item_id TEXT,
      pending_quantity INTEGER CHECK (pending_quantity IS NULL OR pending_quantity > 0),
      current_period_starts_at TIMESTAMPTZ,
      current_period_ends_at TIMESTAMPTZ,
      cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
      last_change_type TEXT,
      last_notify_at TIMESTAMPTZ NOT NULL DEFAULT '-infinity',
      raw_subscription JSONB NOT NULL DEFAULT '{}'::jsonb,
      quarantined_at TIMESTAMPTZ,
      quarantine_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_alipay_subscription_user ON alipay_billing_subscriptions(user_id, updated_at DESC) WHERE user_id IS NOT NULL`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_alipay_subscription_nonterminal_user ON alipay_billing_subscriptions(user_id) WHERE user_id IS NOT NULL AND quarantined_at IS NULL AND status IN ('incomplete','active','trialing','past_due','paused')`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS alipay_billing_notifications (
      notify_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      subscription_id TEXT,
      change_type TEXT,
      occurred_at TIMESTAMPTZ NOT NULL,
      normalized_payload JSONB NOT NULL,
      processing_status TEXT NOT NULL DEFAULT 'processed' CHECK (processing_status IN ('processed','ignored','quarantined','failed')),
      error_message TEXT,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS billing_teams (
      id UUID PRIMARY KEY,
      owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_team_owner ON billing_teams(owner_user_id)`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS billing_team_members (
      team_id UUID NOT NULL REFERENCES billing_teams(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('owner','member')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (team_id, user_id)
    )
  `);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_team_active_member ON billing_team_members(user_id) WHERE status = 'active'`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS alipay_team_subscriptions (
      team_id UUID PRIMARY KEY REFERENCES billing_teams(id) ON DELETE CASCADE,
      alipay_subscription_id TEXT NOT NULL UNIQUE REFERENCES alipay_billing_subscriptions(alipay_subscription_id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
};
