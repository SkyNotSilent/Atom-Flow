import type pg from "pg";

type BillingSchemaClient = pg.Pool | pg.PoolClient;

export const ensureBillingSchema = async (pool: BillingSchemaClient) => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS billing_customers (
      id                 BIGSERIAL PRIMARY KEY,
      environment        TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
      paddle_customer_id TEXT NOT NULL,
      user_id            INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (environment, paddle_customer_id)
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_customers_user ON billing_customers(environment, user_id) WHERE user_id IS NOT NULL`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_customers_environment_id ON billing_customers(environment, id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS billing_checkout_attempts (
      id                     UUID PRIMARY KEY,
      environment            TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
      user_id                INTEGER REFERENCES users(id) ON DELETE SET NULL,
      billing_customer_id    BIGINT REFERENCES billing_customers(id) ON DELETE SET NULL,
      request_id             UUID NOT NULL,
      plan_code              TEXT NOT NULL CHECK (plan_code IN ('pro_monthly', 'pro_yearly')),
      paddle_transaction_id  TEXT,
      status                 TEXT NOT NULL DEFAULT 'creating' CHECK (status IN ('creating', 'reconciling', 'draft', 'completed', 'confirmed', 'payment_failed', 'failed', 'refunded')),
      error_code             TEXT,
      last_event_occurred_at TIMESTAMPTZ,
      last_adjustment_occurred_at TIMESTAMPTZ,
      recovery_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (recovery_attempt_count >= 0),
      next_recovery_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE billing_checkout_attempts ADD COLUMN IF NOT EXISTS last_adjustment_occurred_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE billing_checkout_attempts ADD COLUMN IF NOT EXISTS recovery_attempt_count INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE billing_checkout_attempts ADD COLUMN IF NOT EXISTS next_recovery_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await pool.query(`ALTER TABLE billing_checkout_attempts DROP CONSTRAINT IF EXISTS billing_checkout_attempts_recovery_attempt_count_check`);
  await pool.query(`ALTER TABLE billing_checkout_attempts ADD CONSTRAINT billing_checkout_attempts_recovery_attempt_count_check CHECK (recovery_attempt_count >= 0) NOT VALID`);
  await pool.query(`ALTER TABLE billing_checkout_attempts VALIDATE CONSTRAINT billing_checkout_attempts_recovery_attempt_count_check`);
  await pool.query(`
    ALTER TABLE billing_checkout_attempts
      DROP CONSTRAINT IF EXISTS billing_checkout_attempts_status_check,
      ADD CONSTRAINT billing_checkout_attempts_status_check
        CHECK (status IN ('creating', 'reconciling', 'draft', 'completed', 'confirmed', 'payment_failed', 'failed', 'refunded')) NOT VALID
  `);
  await pool.query(`ALTER TABLE billing_checkout_attempts VALIDATE CONSTRAINT billing_checkout_attempts_status_check`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_attempt_request ON billing_checkout_attempts(environment, user_id, request_id) WHERE user_id IS NOT NULL`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_attempt_transaction ON billing_checkout_attempts(environment, paddle_transaction_id) WHERE paddle_transaction_id IS NOT NULL`);
  await pool.query(`DROP INDEX IF EXISTS idx_billing_attempt_pending_user`);
  await pool.query(`CREATE UNIQUE INDEX idx_billing_attempt_pending_user ON billing_checkout_attempts(environment, user_id) WHERE user_id IS NOT NULL AND status IN ('creating', 'reconciling', 'draft', 'completed')`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_billing_attempt_user ON billing_checkout_attempts(user_id, created_at DESC) WHERE user_id IS NOT NULL`);
  // Older application versions only constrained billing_customer_id by its
  // surrogate id. Detach any cross-environment reference before adding the
  // composite FK so incremental migration is deterministic and fail-closed.
  await pool.query(`
    UPDATE billing_checkout_attempts AS attempt
    SET billing_customer_id = NULL, error_code = COALESCE(error_code, 'BILLING_CUSTOMER_ENVIRONMENT_MISMATCH'), updated_at = NOW()
    WHERE billing_customer_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM billing_customers AS customer
        WHERE customer.id = attempt.billing_customer_id
          AND customer.environment = attempt.environment
      )
  `);
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'billing_attempt_customer_environment_fkey'
          AND conrelid = 'billing_checkout_attempts'::regclass
      ) THEN
        ALTER TABLE billing_checkout_attempts
          ADD CONSTRAINT billing_attempt_customer_environment_fkey
          FOREIGN KEY (environment, billing_customer_id)
          REFERENCES billing_customers(environment, id) NOT VALID;
      END IF;
    END $$
  `);
  await pool.query(`ALTER TABLE billing_checkout_attempts VALIDATE CONSTRAINT billing_attempt_customer_environment_fkey`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS billing_subscriptions (
      id                       BIGSERIAL PRIMARY KEY,
      environment              TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
      paddle_subscription_id   TEXT NOT NULL,
      paddle_customer_id       TEXT NOT NULL,
      billing_customer_id      BIGINT REFERENCES billing_customers(id) ON DELETE SET NULL,
      user_id                  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      product_id               TEXT NOT NULL,
      price_id                 TEXT NOT NULL,
      plan_code                TEXT CHECK (plan_code IN ('pro_monthly', 'pro_yearly')),
      status                   TEXT NOT NULL CHECK (status IN ('active', 'trialing', 'past_due', 'paused', 'canceled')),
      current_period_starts_at TIMESTAMPTZ,
      current_period_ends_at   TIMESTAMPTZ,
      scheduled_change         JSONB,
      last_event_occurred_at   TIMESTAMPTZ NOT NULL DEFAULT '-infinity',
      paddle_updated_at        TIMESTAMPTZ,
      last_adjustment_occurred_at TIMESTAMPTZ,
      quarantined_at           TIMESTAMPTZ,
      quarantine_reason        TEXT,
      created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (environment, paddle_subscription_id)
    )
  `);
  await pool.query(`UPDATE billing_subscriptions SET last_event_occurred_at = '-infinity' WHERE last_event_occurred_at IS NULL`);
  await pool.query(`ALTER TABLE billing_subscriptions ALTER COLUMN last_event_occurred_at SET DEFAULT '-infinity'`);
  await pool.query(`ALTER TABLE billing_subscriptions ALTER COLUMN last_event_occurred_at SET NOT NULL`);
  await pool.query(`ALTER TABLE billing_subscriptions ADD COLUMN IF NOT EXISTS paddle_updated_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE billing_subscriptions ADD COLUMN IF NOT EXISTS last_adjustment_occurred_at TIMESTAMPTZ`);
  await pool.query(`
    UPDATE billing_subscriptions AS subscription
    SET billing_customer_id = NULL,
        quarantined_at = COALESCE(quarantined_at, NOW()),
        quarantine_reason = COALESCE(quarantine_reason, 'billing customer environment mismatch'),
        updated_at = NOW()
    WHERE billing_customer_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM billing_customers AS customer
        WHERE customer.id = subscription.billing_customer_id
          AND customer.environment = subscription.environment
      )
  `);
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'billing_subscription_customer_environment_fkey'
          AND conrelid = 'billing_subscriptions'::regclass
      ) THEN
        ALTER TABLE billing_subscriptions
          ADD CONSTRAINT billing_subscription_customer_environment_fkey
          FOREIGN KEY (environment, billing_customer_id)
          REFERENCES billing_customers(environment, id) NOT VALID;
      END IF;
    END $$
  `);
  await pool.query(`ALTER TABLE billing_subscriptions VALIDATE CONSTRAINT billing_subscription_customer_environment_fkey`);
  // A historical bug or manual Paddle operation may have produced more than
  // one non-terminal subscription. Preserve the strongest/latest entitlement,
  // quarantine the rest for manual cancellation, then enforce the invariant.
  await pool.query(`
    WITH ranked AS (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY environment, user_id
               ORDER BY CASE status
                 WHEN 'active' THEN 1 WHEN 'trialing' THEN 2 WHEN 'past_due' THEN 3 WHEN 'paused' THEN 4 ELSE 5
               END,
               COALESCE(paddle_updated_at, last_event_occurred_at, created_at) DESC,
               id DESC
             ) AS position
      FROM billing_subscriptions
      WHERE user_id IS NOT NULL
        AND quarantined_at IS NULL
        AND status IN ('active', 'trialing', 'past_due', 'paused')
    )
    UPDATE billing_subscriptions AS subscription
    SET quarantined_at = NOW(),
        quarantine_reason = 'duplicate non-terminal subscription requires manual review',
        updated_at = NOW()
    FROM ranked
    WHERE ranked.id = subscription.id AND ranked.position > 1
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_subscription_nonterminal_user ON billing_subscriptions(environment, user_id) WHERE user_id IS NOT NULL AND quarantined_at IS NULL AND status IN ('active', 'trialing', 'past_due', 'paused')`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_billing_subscription_user ON billing_subscriptions(user_id, last_event_occurred_at DESC) WHERE user_id IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_billing_subscription_customer ON billing_subscriptions(environment, paddle_customer_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS billing_webhook_events (
      environment        TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
      event_id           TEXT NOT NULL,
      event_type         TEXT NOT NULL,
      occurred_at        TIMESTAMPTZ NOT NULL,
      normalized_payload JSONB NOT NULL,
      processing_status  TEXT NOT NULL DEFAULT 'pending' CHECK (processing_status IN ('pending', 'processing', 'processed', 'ignored', 'quarantined', 'failed')),
      error_message      TEXT,
      attempt_count      INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      received_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processed_at       TIMESTAMPTZ,
      PRIMARY KEY (environment, event_id)
    )
  `);
  await pool.query(`ALTER TABLE billing_webhook_events ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE billing_webhook_events ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await pool.query(`ALTER TABLE billing_webhook_events DROP CONSTRAINT IF EXISTS billing_webhook_events_attempt_count_check`);
  await pool.query(`ALTER TABLE billing_webhook_events ADD CONSTRAINT billing_webhook_events_attempt_count_check CHECK (attempt_count >= 0) NOT VALID`);
  await pool.query(`ALTER TABLE billing_webhook_events VALIDATE CONSTRAINT billing_webhook_events_attempt_count_check`);
  await pool.query(`DROP INDEX IF EXISTS idx_billing_webhook_pending`);
  await pool.query(`CREATE INDEX idx_billing_webhook_pending ON billing_webhook_events(environment, next_attempt_at, received_at) WHERE processing_status IN ('pending', 'failed', 'processing')`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS billing_usage_events (
      id             BIGSERIAL PRIMARY KEY,
      environment    TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
      user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
      operation_key  TEXT NOT NULL CHECK (char_length(operation_key) BETWEEN 1 AND 200),
      operation_type TEXT NOT NULL,
      occurred_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_usage_idempotency ON billing_usage_events(environment, user_id, operation_key) WHERE user_id IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_billing_usage_user ON billing_usage_events(user_id, occurred_at) WHERE user_id IS NOT NULL`);
};
