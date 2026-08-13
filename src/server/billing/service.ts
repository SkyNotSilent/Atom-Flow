import { randomUUID } from "node:crypto";
import { Paddle } from "@paddle/paddle-node-sdk";
import type pg from "pg";
import type { BillingConfig } from "./config.js";
import {
  BillingError,
  type BillingAccessResolution,
  type BillingLogger,
  type BillingPlanCode,
  type MagicWritingAccess,
  type PaddleSubscriptionStatus,
} from "./types.js";

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const asString = (value: unknown) => typeof value === "string" ? value : null;
const asDateString = (value: unknown) => {
  const raw = asString(value);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};
const getField = (record: JsonRecord, snake: string, camel: string) => record[snake] ?? record[camel];
const getCustomData = (value: unknown) => {
  if (!isRecord(value)) return {};
  return {
    atomflow_user_id: asString(value.atomflow_user_id),
    checkout_attempt_id: asString(value.checkout_attempt_id),
    plan_code: asString(value.plan_code),
  };
};

export const mapSubscriptionStatusToAccess = (status: PaddleSubscriptionStatus | null): MagicWritingAccess | null => {
  if (status === "active" || status === "trialing" || status === "past_due") return "full";
  if (status === "paused" || status === "canceled") return "read_only";
  return null;
};

const isSubscriptionStatus = (value: unknown): value is PaddleSubscriptionStatus => (
  value === "active" || value === "trialing" || value === "past_due" || value === "paused" || value === "canceled"
);

const subscriptionStateEventTypes = new Set([
  "subscription.created",
  "subscription.updated",
  "subscription.activated",
  "subscription.past_due",
  "subscription.paused",
  "subscription.resumed",
  "subscription.canceled",
]);

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type NormalizedSubscription = {
  id: string;
  status: PaddleSubscriptionStatus;
  customerId: string;
  productId: string;
  priceId: string;
  customData: ReturnType<typeof getCustomData>;
  currentPeriodStartsAt: string | null;
  currentPeriodEndsAt: string | null;
  scheduledChange: JsonRecord | null;
  paddleUpdatedAt: string | null;
};

const normalizeItemIds = (value: unknown, config?: BillingConfig) => {
  const items = Array.isArray(value) ? value.filter(isRecord) : [];
  const readIds = (item: JsonRecord) => {
    const price = isRecord(item.price) ? item.price : null;
    const product = isRecord(item.product) ? item.product : null;
    return {
      item,
      priceId: asString(item.price_id) || asString(item.priceId) || asString(price?.id) || "",
      productId: asString(item.product_id) || asString(item.productId) || asString(price?.product_id) || asString(price?.productId) || asString(product?.id) || "",
    };
  };
  const normalizedItems = items.map(readIds);
  const selected = config
    ? normalizedItems.find(item => item.productId === config.productId && config.allowedPriceIds.has(item.priceId)) || normalizedItems[0]
    : normalizedItems[0];
  const item = selected?.item || null;
  const price = item && isRecord(item.price) ? item.price : null;
  const product = item && isRecord(item.product) ? item.product : null;
  return {
    priceId: selected?.priceId || asString(price?.id) || "",
    productId: selected?.productId || asString(product?.id) || "",
  };
};

const normalizeItems = (value: unknown) => (Array.isArray(value) ? value.filter(isRecord) : []).map(item => {
  const price = isRecord(item.price) ? item.price : null;
  const product = isRecord(item.product) ? item.product : null;
  return {
    priceId: asString(item.price_id) || asString(item.priceId) || asString(price?.id) || "",
    productId: asString(item.product_id) || asString(item.productId) || asString(price?.product_id) || asString(price?.productId) || asString(product?.id) || "",
    quantity: typeof item.quantity === "number" ? item.quantity : Number(item.quantity ?? 1),
  };
});

/**
 * Destructive subscription operations are only safe for the one-item contract
 * AtomFlow created. Selecting a matching item from a mixed Paddle subscription
 * is not sufficient: canceling that subscription would also cancel unrelated
 * products bundled into the same contract.
 */
const hasExclusiveAtomFlowItem = (value: unknown, config: BillingConfig, expectedPriceId?: string) => {
  const record = isRecord(value) ? value : null;
  const items = normalizeItems(record?.items);
  return items.length === 1
    && items[0].quantity === 1
    && items[0].productId === config.productId
    && config.allowedPriceIds.has(items[0].priceId)
    && (!expectedPriceId || items[0].priceId === expectedPriceId);
};

const normalizeSubscription = (value: unknown, config?: BillingConfig): NormalizedSubscription | null => {
  if (!isRecord(value)) return null;
  const id = asString(value.id);
  const status = getField(value, "status", "status");
  const customerId = asString(getField(value, "customer_id", "customerId"));
  const ids = normalizeItemIds(value.items, config);
  const priceId = ids.priceId || asString(value.priceId) || "";
  const productId = ids.productId || asString(value.productId) || "";
  if (!id || !customerId || !isSubscriptionStatus(status) || !priceId || !productId) return null;
  const period = isRecord(getField(value, "current_billing_period", "currentBillingPeriod"))
    ? getField(value, "current_billing_period", "currentBillingPeriod") as JsonRecord
    : null;
  const scheduled = getField(value, "scheduled_change", "scheduledChange");
  return {
    id,
    status,
    customerId,
    productId,
    priceId,
    customData: getCustomData(getField(value, "custom_data", "customData")),
    currentPeriodStartsAt: period
      ? asDateString(getField(period, "starts_at", "startsAt"))
      : asDateString(value.currentPeriodStartsAt),
    currentPeriodEndsAt: period
      ? asDateString(getField(period, "ends_at", "endsAt"))
      : asDateString(value.currentPeriodEndsAt),
    scheduledChange: isRecord(scheduled) ? scheduled : null,
    paddleUpdatedAt: asDateString(getField(value, "updated_at", "updatedAt")) || asDateString(value.paddleUpdatedAt),
  };
};

const normalizedWebhookPayload = (eventType: string, data: unknown, config: BillingConfig): JsonRecord => {
  if (!isRecord(data)) return {};
  if (eventType.startsWith("subscription.")) {
    const subscription = normalizeSubscription(data, config);
    return subscription ? {
      id: subscription.id,
      status: subscription.status,
      customerId: subscription.customerId,
      productId: subscription.productId,
      priceId: subscription.priceId,
      customData: subscription.customData,
      currentPeriodStartsAt: subscription.currentPeriodStartsAt,
      currentPeriodEndsAt: subscription.currentPeriodEndsAt,
      scheduledChange: subscription.scheduledChange,
      paddleUpdatedAt: subscription.paddleUpdatedAt,
    } : { id: asString(data.id) };
  }
  if (eventType.startsWith("transaction.")) {
    const ids = normalizeItemIds(data.items, config);
    return {
      id: asString(data.id),
      status: asString(data.status),
      customerId: asString(getField(data, "customer_id", "customerId")),
      subscriptionId: asString(getField(data, "subscription_id", "subscriptionId")),
      productId: ids.productId,
      priceId: ids.priceId,
      customData: getCustomData(getField(data, "custom_data", "customData")),
    };
  }
  if (eventType === "adjustment.updated") {
    return {
      id: asString(data.id),
      status: asString(data.status),
      action: asString(data.action),
      type: asString(data.type),
      transactionId: asString(getField(data, "transaction_id", "transactionId")),
      subscriptionId: asString(getField(data, "subscription_id", "subscriptionId")),
    };
  }
  return { id: asString(data.id) };
};

const planCodeForPrice = (config: BillingConfig, priceId: string): BillingPlanCode | null => {
  if (priceId === config.priceIds.pro_monthly) return "pro_monthly";
  if (priceId === config.priceIds.pro_yearly) return "pro_yearly";
  return null;
};

export class BillingService {
  private readonly paddle: Paddle | null;
  private workerTimer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private catalogValidationPromise: Promise<void> | null = null;
  private catalogValidatedUntil = 0;

  constructor(
    private readonly pool: pg.Pool,
    readonly config: BillingConfig,
    private readonly logger: BillingLogger,
  ) {
    this.paddle = config.enabled ? new Paddle(config.apiKey, { environment: config.sdkEnvironment }) : null;
  }

  private requirePaddle() {
    if (!this.config.enabled || !this.paddle) {
      throw new BillingError(503, "BILLING_UNAVAILABLE", "账单服务暂时不可用");
    }
    return this.paddle;
  }

  private async assertConfiguredCatalogValid() {
    if (Date.now() < this.catalogValidatedUntil) return;
    if (this.catalogValidationPromise) return this.catalogValidationPromise;

    const validation = (async () => {
      const paddle = this.requirePaddle();
      try {
        const [product, ...prices] = await Promise.all([
          paddle.products.get(this.config.productId),
          ...this.config.plans.map(plan => paddle.prices.get(this.config.priceIds[plan.code])),
        ]);
        const problems: string[] = [];
        if (product.id !== this.config.productId || product.status !== "active") {
          problems.push("configured product is missing or inactive");
        }
        for (const [index, plan] of this.config.plans.entries()) {
          const price = prices[index];
          const expectedAmount = String(plan.priceCny * 100);
          if (
            !price
            || price.id !== this.config.priceIds[plan.code]
            || price.productId !== this.config.productId
            || price.status !== "active"
            || price.unitPrice.amount !== expectedAmount
            || price.unitPrice.currencyCode !== plan.currency
            || price.billingCycle?.interval !== plan.interval
            || price.billingCycle.frequency !== 1
            || price.trialPeriod !== null
          ) {
            problems.push(`${plan.code} price does not match the approved catalog`);
          }
        }
        if (problems.length > 0) {
          const error = new Error(problems.join("; "));
          this.logger.error({ err: error, module: "billing-catalog" }, "Paddle catalog validation failed");
          throw new BillingError(503, "BILLING_CATALOG_INVALID", "套餐配置异常，新付款已暂停，请联系客服");
        }
        // Paddle catalog prices are immutable in amount/currency/cycle; a short
        // cache still re-checks active state without adding a startup dependency.
        this.catalogValidatedUntil = Date.now() + 5 * 60_000;
      } catch (error) {
        if (error instanceof BillingError) throw error;
        this.logger.error({ err: error, module: "billing-catalog" }, "Paddle catalog validation request failed");
        throw new BillingError(503, "BILLING_CATALOG_UNAVAILABLE", "套餐状态暂时无法确认，请稍后重试");
      }
    })();
    this.catalogValidationPromise = validation;
    try {
      await validation;
    } finally {
      if (this.catalogValidationPromise === validation) this.catalogValidationPromise = null;
    }
  }

  async getValidatedPlans() {
    if (this.config.enabled) await this.assertConfiguredCatalogValid();
    return this.config.plans;
  }

  private async releaseAdvisoryClient(client: pg.PoolClient, lockKey: string) {
    try {
      const unlocked = (await client.query(
        `SELECT pg_advisory_unlock(hashtext($1)) AS unlocked`,
        [lockKey],
      )).rows[0]?.unlocked === true;
      client.release(unlocked ? undefined : true);
    } catch {
      client.release(true);
    }
  }

  async resolveMagicWritingAccess(userId: number): Promise<BillingAccessResolution> {
    if (!this.config.enabled) {
      return {
        access: "full",
        subscriptionStatus: null,
        planCode: null,
        currentPeriodEndsAt: null,
        scheduledChange: null,
        paymentActionRequired: false,
        hasWritingHistory: false,
        hasBillingCustomer: false,
      };
    }
    try {
      const subscription = (await this.pool.query(
        `SELECT status, plan_code AS "planCode", current_period_ends_at AS "currentPeriodEndsAt",
                scheduled_change AS "scheduledChange"
         FROM billing_subscriptions
         WHERE environment = $1 AND user_id = $2 AND quarantined_at IS NULL
         ORDER BY CASE status
           WHEN 'active' THEN 1 WHEN 'trialing' THEN 2 WHEN 'past_due' THEN 3
           WHEN 'paused' THEN 4 WHEN 'canceled' THEN 5 ELSE 6 END,
           last_event_occurred_at DESC
         LIMIT 1`,
        [this.config.environment, userId],
      )).rows[0] as JsonRecord | undefined;
      const accountState = (await this.pool.query(
        `SELECT (
           EXISTS (SELECT 1 FROM notes WHERE user_id = $1 LIMIT 1)
           OR EXISTS (SELECT 1 FROM write_agent_messages m JOIN write_agent_threads t ON t.id = m.thread_id WHERE t.user_id = $1 LIMIT 1)
           OR EXISTS (SELECT 1 FROM write_style_skills WHERE user_id = $1 LIMIT 1)
           OR EXISTS (SELECT 1 FROM write_canvas_assets WHERE user_id = $1 LIMIT 1)
           OR EXISTS (SELECT 1 FROM write_canvas_nodes WHERE user_id = $1 LIMIT 1)
           OR EXISTS (SELECT 1 FROM write_canvas_agent_messages WHERE user_id = $1 LIMIT 1)
           OR EXISTS (
             SELECT 1 FROM write_canvas_projects
             WHERE user_id = $1 AND (
               document_revision > 0
               OR tldraw_snapshot <> '{"store":{}}'::jsonb
             ) LIMIT 1
           )
         ) AS "hasWritingHistory",
         EXISTS (
           SELECT 1 FROM billing_customers
           WHERE environment = $2 AND user_id = $1
         ) AS "hasBillingCustomer"`,
        [userId, this.config.environment],
      )).rows[0] as JsonRecord | undefined;
      const history = accountState?.hasWritingHistory === true;
      const hasBillingCustomer = accountState?.hasBillingCustomer === true;
      const statusValue = subscription?.status;
      const status = isSubscriptionStatus(statusValue) ? statusValue : null;
      const mapped = mapSubscriptionStatusToAccess(status);
      return {
        access: mapped || (history ? "read_only" : "none"),
        subscriptionStatus: status,
        planCode: subscription?.planCode === "pro_monthly" || subscription?.planCode === "pro_yearly" ? subscription.planCode : null,
        currentPeriodEndsAt: subscription?.currentPeriodEndsAt instanceof Date
          ? subscription.currentPeriodEndsAt.toISOString()
          : asDateString(subscription?.currentPeriodEndsAt),
        scheduledChange: isRecord(subscription?.scheduledChange) ? subscription.scheduledChange : null,
        paymentActionRequired: status === "past_due",
        hasWritingHistory: history,
        hasBillingCustomer,
      };
    } catch (error) {
      if (error instanceof BillingError) throw error;
      this.logger.error({ err: error, module: "billing-access", userId }, "Failed to resolve billing access");
      throw new BillingError(503, "BILLING_UNAVAILABLE", "账单状态暂时无法确认，请稍后重试");
    }
  }

  async createCheckout(userId: number, email: string, planCode: BillingPlanCode, requestId: string) {
    if (!uuidPattern.test(requestId)) throw new BillingError(400, "INVALID_REQUEST_ID", "requestId 必须是 UUID");
    const paddle = this.requirePaddle();
    const priceId = this.config.priceIds[planCode];
    await this.assertConfiguredCatalogValid();

    type ClaimedAttempt = {
      id: string;
      planCode: BillingPlanCode;
      status: string;
      transactionId: string | null;
      customerId: string | null;
      billingCustomerId: string | number | null;
      create: boolean;
    };

    const claimAttempt = async (): Promise<ClaimedAttempt> => {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`atomflow-billing-user:${userId}`]);
        const active = (await client.query(
          `SELECT 1 FROM billing_subscriptions
           WHERE environment = $1 AND user_id = $2 AND quarantined_at IS NULL
             AND status IN ('active', 'trialing', 'past_due', 'paused') LIMIT 1`,
          [this.config.environment, userId],
        )).rowCount;
        if (active) throw new BillingError(409, "BILLING_ALREADY_ACTIVE", "当前账户已有有效订阅");

        const selectAttempt = `SELECT a.id, a.paddle_transaction_id AS "transactionId", a.plan_code AS "planCode", a.status,
                 a.billing_customer_id AS "billingCustomerId", c.paddle_customer_id AS "customerId"
          FROM billing_checkout_attempts a
          LEFT JOIN billing_customers c ON c.environment = a.environment AND c.id = a.billing_customer_id`;
        let attempt = (await client.query(
          `${selectAttempt} WHERE a.environment = $1 AND a.user_id = $2 AND a.request_id = $3`,
          [this.config.environment, userId, requestId],
        )).rows[0] as JsonRecord | undefined;
        if (attempt && attempt.planCode !== planCode) {
          throw new BillingError(409, "BILLING_IDEMPOTENCY_CONFLICT", "同一 requestId 不能用于不同套餐");
        }
        if (attempt?.status === "confirmed") {
          throw new BillingError(409, "BILLING_ALREADY_ACTIVE", "当前账户已有有效订阅");
        }
        if (!attempt) {
          attempt = (await client.query(
            `${selectAttempt}
             WHERE a.environment = $1 AND a.user_id = $2
               AND a.status IN ('creating', 'reconciling', 'draft', 'completed')
             ORDER BY a.created_at DESC LIMIT 1`,
            [this.config.environment, userId],
          )).rows[0] as JsonRecord | undefined;
        }
        if (attempt) {
          const status = String(attempt.status);
          if (status === "draft" || status === "completed") {
            if (!attempt.transactionId) throw new BillingError(503, "BILLING_CHECKOUT_PENDING", "结账状态正在确认中，请稍后重试");
            await client.query("COMMIT");
            return {
              id: String(attempt.id), planCode: attempt.planCode as BillingPlanCode, status,
              transactionId: String(attempt.transactionId), customerId: asString(attempt.customerId),
              billingCustomerId: attempt.billingCustomerId as string | number | null, create: false,
            };
          }
          if (status === "creating" || status === "reconciling") {
            throw new BillingError(409, "BILLING_CHECKOUT_PENDING", "当前已有结账正在处理中");
          }
          // A terminal remote transaction may be replaced while retaining the
          // request id as the idempotency identity.
          await client.query(
            `UPDATE billing_checkout_attempts
             SET status = 'creating', paddle_transaction_id = NULL, error_code = NULL,
                 recovery_attempt_count = 0, next_recovery_at = NOW(), updated_at = NOW()
             WHERE environment = $1 AND id = $2 AND user_id = $3
               AND status IN ('payment_failed', 'failed', 'refunded')`,
            [this.config.environment, attempt.id, userId],
          );
        } else {
          attempt = { id: randomUUID(), planCode, status: "creating" };
          await client.query(
            `INSERT INTO billing_checkout_attempts
               (id, environment, user_id, request_id, plan_code, status)
             VALUES ($1, $2, $3, $4, $5, 'creating')`,
            [attempt.id, this.config.environment, userId, requestId, planCode],
          );
        }
        const customer = (await client.query(
          `SELECT id AS "billingCustomerId", paddle_customer_id AS "customerId"
           FROM billing_customers WHERE environment = $1 AND user_id = $2`,
          [this.config.environment, userId],
        )).rows[0] as JsonRecord | undefined;
        await client.query("COMMIT");
        return {
          id: String(attempt.id), planCode, status: "creating", transactionId: null,
          customerId: asString(customer?.customerId),
          billingCustomerId: customer?.billingCustomerId as string | number | null,
          create: true,
        };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    };

    const markAttempt = async (attemptId: string, status: string, errorCode: string, transactionId?: string) => {
      await this.pool.query(
        `UPDATE billing_checkout_attempts
         SET status = $1, error_code = $2,
             paddle_transaction_id = COALESCE($3, paddle_transaction_id), updated_at = NOW()
         WHERE environment = $4 AND id = $5 AND user_id = $6
           AND status IN ('creating', 'reconciling', 'draft', 'completed')`,
        [status, errorCode, transactionId || null, this.config.environment, attemptId, userId],
      );
    };

    for (let pass = 0; pass < 3; pass += 1) {
      const claim = await claimAttempt();
      if (!claim.create && claim.transactionId) {
        let remote: Awaited<ReturnType<typeof paddle.transactions.get>>;
        try {
          remote = await paddle.transactions.get(claim.transactionId);
        } catch (error) {
          this.logger.warn({ err: error, module: "billing-checkout", userId, transactionId: claim.transactionId }, "Unable to verify reusable checkout");
          throw new BillingError(503, "BILLING_CHECKOUT_PENDING", "结账状态暂时无法确认，请稍后重试");
        }
        const custom = getCustomData(remote.customData);
        const owned = remote.id === claim.transactionId
          && Boolean(claim.customerId) && remote.customerId === claim.customerId
          && custom.atomflow_user_id === String(userId)
          && custom.checkout_attempt_id === claim.id
          && custom.plan_code === claim.planCode
          && hasExclusiveAtomFlowItem(remote, this.config, this.config.priceIds[claim.planCode]);
        const completed = remote.status === "completed" || remote.status === "paid" || remote.status === "billed";
        const resumable = remote.status === "draft" || remote.status === "ready";
        if (owned && completed) {
          await markAttempt(claim.id, "completed", "PADDLE_SUBSCRIPTION_PENDING", remote.id);
          if (remote.subscriptionId) {
            try {
              const subscription = await paddle.subscriptions.get(remote.subscriptionId);
              if (!hasExclusiveAtomFlowItem(subscription, this.config, this.config.priceIds[claim.planCode])) {
                throw new Error("completed transaction has a mixed or unexpected subscription item set");
              }
              const db = await this.pool.connect();
              try {
                await db.query("BEGIN");
                const result = await this.upsertTrustedSubscription(db, normalizeSubscription(subscription, this.config), new Date(subscription.updatedAt).toISOString(), true);
                if (!result.ok) throw new Error(result.reason);
                await db.query("COMMIT");
              } catch (error) {
                await db.query("ROLLBACK").catch(() => undefined);
                throw error;
              } finally {
                db.release();
              }
              throw new BillingError(409, "BILLING_ALREADY_ACTIVE", "当前账户已有有效订阅");
            } catch (error) {
              if (error instanceof BillingError) throw error;
              this.logger.warn({ err: error, module: "billing-checkout", userId, attemptId: claim.id }, "Completed checkout subscription is still reconciling");
            }
          }
          throw new BillingError(503, "BILLING_CHECKOUT_PENDING", "付款状态正在确认中，请稍后重试");
        }
        if (owned && resumable && claim.planCode === planCode) {
          return { transactionId: remote.id, reused: true };
        }
        if (owned && resumable && claim.planCode !== planCode) {
          try {
            await paddle.transactions.update(remote.id, { status: "canceled" });
          } catch (error) {
            this.logger.warn({ err: error, module: "billing-checkout", userId, transactionId: remote.id }, "Failed to close the previous draft checkout");
            throw new BillingError(409, "BILLING_CHECKOUT_PENDING", "当前已有结账正在处理中");
          }
        }
        await markAttempt(claim.id, "payment_failed", owned ? "PADDLE_TRANSACTION_STALE" : "PADDLE_TRANSACTION_MISMATCH", remote.id);
        continue;
      }

      let customerId = claim.customerId;
      let billingCustomerId = claim.billingCustomerId;
      if (!customerId) {
        try {
          const candidates = paddle.customers.list({ email: [email], perPage: 50 });
          for await (const candidate of candidates) {
            if (getCustomData(candidate.customData).atomflow_user_id === String(userId)) {
              customerId = candidate.id;
              break;
            }
          }
          if (!customerId) {
            customerId = (await paddle.customers.create({ email, customData: { atomflow_user_id: String(userId) } })).id;
          }
        } catch (error) {
          await markAttempt(claim.id, "reconciling", "PADDLE_CUSTOMER_UNCERTAIN");
          this.logger.error({ err: error, module: "billing-checkout", userId, attemptId: claim.id }, "Paddle customer creation is uncertain");
          throw new BillingError(503, "BILLING_CHECKOUT_PENDING", "结账创建状态正在确认中，请稍后重试");
        }
        const stored = (await this.pool.query(
          `INSERT INTO billing_customers (environment, paddle_customer_id, user_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (environment, user_id) WHERE user_id IS NOT NULL DO UPDATE
           SET paddle_customer_id = EXCLUDED.paddle_customer_id, updated_at = NOW()
           RETURNING id, paddle_customer_id AS "customerId"`,
          [this.config.environment, customerId, userId],
        )).rows[0];
        billingCustomerId = stored.id;
        customerId = String(stored.customerId);
      }
      await this.pool.query(
        `UPDATE billing_checkout_attempts SET billing_customer_id = $1, updated_at = NOW()
         WHERE environment = $2 AND id = $3 AND user_id = $4 AND status = 'creating'`,
        [billingCustomerId, this.config.environment, claim.id, userId],
      );

      try {
        const transaction = await paddle.transactions.create({
          items: [{ priceId, quantity: 1 }], customerId,
          customData: { atomflow_user_id: String(userId), checkout_attempt_id: claim.id, plan_code: planCode },
        });
        await this.pool.query(
          `UPDATE billing_checkout_attempts
           SET paddle_transaction_id = $1, status = 'draft', error_code = NULL, updated_at = NOW()
           WHERE environment = $2 AND id = $3 AND user_id = $4 AND status = 'creating'`,
          [transaction.id, this.config.environment, claim.id, userId],
        );
        return { transactionId: transaction.id, reused: false };
      } catch (error) {
        const recovered = await this.recoverTransaction(customerId, claim.id).catch(() => null);
        if (recovered) {
          const completed = recovered.status === "completed" || recovered.status === "paid" || recovered.status === "billed";
          const resumable = recovered.status === "draft" || recovered.status === "ready";
          const recoveredStatus = completed ? "completed" : recovered.status === "canceled" ? "payment_failed" : resumable ? "draft" : "reconciling";
          await markAttempt(claim.id, recoveredStatus, recoveredStatus === "reconciling" ? "PADDLE_TRANSACTION_UNCERTAIN" : "", recovered.id);
          if (resumable) return { transactionId: recovered.id, reused: true };
          if (completed) throw new BillingError(503, "BILLING_CHECKOUT_PENDING", "付款状态正在确认中，请稍后重试");
          if (recoveredStatus === "payment_failed") throw new BillingError(502, "BILLING_CHECKOUT_FAILED", "结账交易已取消，请重新发起结账");
        }
        await markAttempt(claim.id, "reconciling", "PADDLE_TRANSACTION_UNCERTAIN");
        this.logger.error({ err: error, module: "billing-checkout", userId, attemptId: claim.id }, "Paddle checkout creation failed");
        throw new BillingError(503, "BILLING_CHECKOUT_PENDING", "结账创建状态正在确认中，请稍后重试");
      }
    }
    throw new BillingError(503, "BILLING_CHECKOUT_PENDING", "结账状态正在确认中，请稍后重试");
  }

  private async recoverTransaction(customerId: string, attemptId: string, expectedTransactionId?: string | null) {
    const paddle = this.requirePaddle();
    const transactions = paddle.transactions.list({ customerId: [customerId], perPage: 200 });
    for await (const transaction of transactions) {
      if (
        getCustomData(transaction.customData).checkout_attempt_id === attemptId
        && (!expectedTransactionId || transaction.id === expectedTransactionId)
      ) {
        return { id: transaction.id, status: transaction.status, subscriptionId: transaction.subscriptionId };
      }
    }
    return null;
  }

  async createPortal(userId: number) {
    const paddle = this.requirePaddle();
    const customer = (await this.pool.query(
      `SELECT paddle_customer_id AS "customerId" FROM billing_customers
       WHERE environment = $1 AND user_id = $2`,
      [this.config.environment, userId],
    )).rows[0] as JsonRecord | undefined;
    if (!customer?.customerId) throw new BillingError(404, "BILLING_CUSTOMER_NOT_FOUND", "当前账户还没有账单资料");
    // The general overview already exposes invoices and all subscriptions for
    // this Paddle customer. Passing no IDs also avoids Paddle's 25-ID cap and
    // prevents stale local subscription rows from blocking Portal access.
    const session = await paddle.customerPortalSessions.create(String(customer.customerId), []);
    return { url: session.urls.general.overview };
  }

  async deleteAccountUnderBillingLock(
    userId: number,
    prepareLocalDeletion: (client: pg.PoolClient) => Promise<void>,
    deleteLocalAccount: (client: pg.PoolClient) => Promise<void>,
  ) {
    const lockKey = `atomflow-billing-user:${userId}`;
    const loadCustomers = async (client: pg.PoolClient) => (await client.query(
      `SELECT environment, paddle_customer_id AS "paddleCustomerId"
       FROM (
         SELECT environment, paddle_customer_id FROM billing_customers WHERE user_id = $1
         UNION
         SELECT environment, paddle_customer_id FROM billing_subscriptions WHERE user_id = $1
       ) AS owned_billing_customers
       ORDER BY environment, paddle_customer_id`,
      [userId],
    )).rows as JsonRecord[];

    // Claim the local deletion intent with a short transaction. The network
    // phase below deliberately owns neither a pg client nor an advisory lock.
    const claimClient = await this.pool.connect();
    let customers: JsonRecord[];
    try {
      await claimClient.query("BEGIN");
      await claimClient.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [lockKey]);
      await prepareLocalDeletion(claimClient);
      customers = await loadCustomers(claimClient);
      await claimClient.query("COMMIT");
    } catch (error) {
      await claimClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      claimClient.release();
    }

    if (customers.length > 0) {
      if (!this.config.enabled) {
        throw new BillingError(503, "BILLING_DISABLED_ACCOUNT_REVIEW_REQUIRED", "检测到历史账单资料，收费关闭期间不能自动注销，请联系支持");
      }
      if (customers.some(customer => customer.environment !== this.config.environment)) {
        throw new BillingError(503, "BILLING_CROSS_ENVIRONMENT_REVIEW_REQUIRED", "检测到其他环境的历史订阅，请联系支持完成注销");
      }
      const paddle = this.requirePaddle();
      try {
        for (const customer of customers) {
          const remoteSubscriptions = paddle.subscriptions.list({
            customerId: [String(customer.paddleCustomerId)],
            status: ["active", "trialing", "past_due", "paused"], perPage: 200,
          });
          for await (const remote of remoteSubscriptions) {
            if (String(remote.customerId) !== String(customer.paddleCustomerId)) {
              throw new Error(`Unable to verify active subscription ${remote.id}`);
            }
            const normalizedRemote = normalizeSubscription(remote, this.config);
            if (!normalizedRemote) throw new Error(`Unable to inspect active subscription ${remote.id}`);
            if (!hasExclusiveAtomFlowItem(remote, this.config)) {
              const containsAtomFlowItem = normalizeItems(remote.items).some(item => (
                item.productId === this.config.productId
              ));
              if (containsAtomFlowItem) throw new Error(`Mixed-product subscription ${remote.id} requires manual review`);
              continue;
            }
            const canceled = await paddle.subscriptions.cancel(remote.id, { effectiveFrom: "immediately" });
            if (!hasExclusiveAtomFlowItem(canceled, this.config)) {
              throw new Error(`Cancellation returned a mixed or unexpected subscription ${remote.id}`);
            }
          }
        }
      } catch (error) {
        this.logger.error({ err: error, module: "billing-delete", userId }, "Failed authoritative subscription cancellation before account deletion");
        throw new BillingError(503, "BILLING_CANCELLATION_FAILED", "订阅暂时无法确认取消，账户尚未删除，请稍后重试");
      }
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [lockKey]);
      await prepareLocalDeletion(client);
      const currentCustomers = await loadCustomers(client);
      if (JSON.stringify(currentCustomers) !== JSON.stringify(customers)) {
        throw new BillingError(409, "BILLING_ACCOUNT_CHANGED", "注销期间账单资料已变更，请重试");
      }
      await client.query(
        `UPDATE billing_webhook_events
         SET normalized_payload = normalized_payload #- '{customData,atomflow_user_id}'
         WHERE environment = $1 AND normalized_payload->'customData'->>'atomflow_user_id' = $2`,
        [this.config.environment, String(userId)],
      );
      await deleteLocalAccount(client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async recordUsage(userId: number, operationKey: string, operationType: string) {
    if (!this.config.enabled) return;
    await this.pool.query(
      `INSERT INTO billing_usage_events (environment, user_id, operation_key, operation_type)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (environment, user_id, operation_key) WHERE user_id IS NOT NULL DO NOTHING`,
      [this.config.environment, userId, operationKey.slice(0, 200), operationType.slice(0, 80)],
    );
  }

  async recoverCheckoutAttempts() {
    if (!this.config.enabled) return;
    const attempts = (await this.pool.query(
      `SELECT a.id, a.user_id AS "userId", a.plan_code AS "planCode", a.status,
              a.paddle_transaction_id AS "transactionId",
              a.recovery_attempt_count AS "recoveryAttemptCount", u.email,
              c.id AS "billingCustomerId", c.paddle_customer_id AS "paddleCustomerId"
       FROM billing_checkout_attempts a
       LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN billing_customers c ON c.id = a.billing_customer_id
       WHERE a.environment = $1
         AND ((a.status IN ('creating', 'reconciling') AND a.recovery_attempt_count < 8)
              OR a.status = 'completed')
         AND a.next_recovery_at <= NOW()
       ORDER BY a.created_at ASC LIMIT 25`,
      [this.config.environment],
    )).rows as JsonRecord[];
    for (const scannedAttempt of attempts) {
      let attempt = scannedAttempt;
      const userId = Number(attempt.userId);
      if (!Number.isSafeInteger(userId) || !attempt.email) continue;
      const lockKey = `atomflow-billing-user:${userId}`;
      let confirmedPayment = attempt.status === "completed";
      const claimClient = await this.pool.connect();
      try {
        await claimClient.query("BEGIN");
        await claimClient.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [lockKey]);
        const currentAttempt = (await claimClient.query(
          `SELECT status, recovery_attempt_count AS "recoveryAttemptCount"
           FROM billing_checkout_attempts
           WHERE environment = $1 AND id = $2`,
          [this.config.environment, attempt.id],
        )).rows[0] as JsonRecord | undefined;
        if (!currentAttempt || !["creating", "reconciling", "completed"].includes(String(currentAttempt.status))) {
          await claimClient.query("ROLLBACK");
          continue;
        }
        attempt = { ...attempt, ...currentAttempt };
        confirmedPayment = attempt.status === "completed";
        await claimClient.query("COMMIT");
      } catch (error) {
        await claimClient.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        claimClient.release();
      }

      try {
        let customerId = asString(attempt.paddleCustomerId);
        if (!customerId) {
          const candidates = this.requirePaddle().customers.list({ email: [String(attempt.email)], perPage: 50 });
          for await (const candidate of candidates) {
            if (getCustomData(candidate.customData).atomflow_user_id === String(userId)) {
              customerId = candidate.id;
              break;
            }
          }
          if (customerId) {
            const customer = (await this.pool.query(
              `INSERT INTO billing_customers (environment, paddle_customer_id, user_id)
               VALUES ($1, $2, $3)
               ON CONFLICT (environment, user_id) WHERE user_id IS NOT NULL DO UPDATE
               SET paddle_customer_id = EXCLUDED.paddle_customer_id, updated_at = NOW()
               RETURNING id`,
              [this.config.environment, customerId, userId],
            )).rows[0];
            await this.pool.query(
              `UPDATE billing_checkout_attempts SET billing_customer_id = $1
               WHERE environment = $2 AND id = $3 AND status IN ('creating', 'reconciling', 'completed')`,
              [customer.id, this.config.environment, attempt.id],
            );
          }
        }
        const recovered = customerId ? await this.recoverTransaction(customerId, String(attempt.id), asString(attempt.transactionId)) : null;
        if (recovered) {
          const completed = recovered.status === "completed" || recovered.status === "paid" || recovered.status === "billed";
          confirmedPayment = confirmedPayment || completed;
          const resumable = recovered.status === "draft" || recovered.status === "ready";
          const recoveredStatus = confirmedPayment
            ? "completed"
            : recovered.status === "canceled" ? "payment_failed"
              : resumable ? "draft" : "reconciling";
          await this.pool.query(
            `UPDATE billing_checkout_attempts
             SET paddle_transaction_id = $1, status = $2, error_code = NULL, updated_at = NOW()
             WHERE environment = $3 AND id = $4 AND status IN ('creating', 'reconciling', 'completed')`,
            [recovered.id, recoveredStatus, this.config.environment, attempt.id],
          );
          if (recovered.subscriptionId) {
            const remote = await this.requirePaddle().subscriptions.get(recovered.subscriptionId);
            const db = await this.pool.connect();
            try {
              await db.query("BEGIN");
              const result = await this.upsertTrustedSubscription(db, normalizeSubscription(remote, this.config), remote.updatedAt, true);
              if (!result.ok) throw new Error(result.reason);
              await db.query("COMMIT");
            } catch (error) {
              await db.query("ROLLBACK").catch(() => undefined);
              throw error;
            } finally {
              db.release();
            }
          } else if (confirmedPayment || recoveredStatus === "reconciling") {
            const count = Number(attempt.recoveryAttemptCount || 0) + 1;
            await this.pool.query(
              `UPDATE billing_checkout_attempts
               SET recovery_attempt_count = $1,
                   next_recovery_at = NOW() + ($2 * INTERVAL '1 second'),
                   error_code = $3, updated_at = NOW()
               WHERE environment = $4 AND id = $5 AND status IN ('reconciling', 'completed')`,
              [count, Math.min(3600, 5 * (2 ** Math.min(count, 10))), confirmedPayment ? "PADDLE_SUBSCRIPTION_PENDING" : "PADDLE_TRANSACTION_PENDING", this.config.environment, attempt.id],
            );
          }
          continue;
        }
        const count = Number(attempt.recoveryAttemptCount || 0) + 1;
        const terminal = !confirmedPayment && count >= 8;
        const delaySeconds = Math.min(3600, 5 * (2 ** Math.min(count, 10)));
        await this.pool.query(
          `UPDATE billing_checkout_attempts
           SET status = $1, recovery_attempt_count = $2,
               next_recovery_at = NOW() + ($3 * INTERVAL '1 second'),
               error_code = $4, updated_at = NOW()
           WHERE environment = $5 AND id = $6 AND status IN ('creating', 'reconciling', 'completed')`,
          [terminal ? "failed" : confirmedPayment ? "completed" : "reconciling", count, delaySeconds, terminal ? "PADDLE_RECOVERY_EXHAUSTED" : "PADDLE_RECOVERY_PENDING", this.config.environment, attempt.id],
        );
      } catch (error) {
        this.logger.warn({ err: error, module: "billing-checkout-recovery", attemptId: attempt.id }, "Checkout recovery attempt failed");
        const count = Number(attempt.recoveryAttemptCount || 0) + 1;
        await this.pool.query(
          `UPDATE billing_checkout_attempts
           SET status = $1, recovery_attempt_count = $2,
               next_recovery_at = NOW() + ($3 * INTERVAL '1 second'), error_code = $4, updated_at = NOW()
           WHERE environment = $5 AND id = $6 AND status IN ('creating', 'reconciling', 'completed')`,
          [confirmedPayment ? "completed" : "reconciling", count, Math.min(3600, 5 * (2 ** Math.min(count, 10))), count >= 8 ? "PADDLE_RECOVERY_MANUAL_REVIEW" : "PADDLE_RECOVERY_RETRY", this.config.environment, attempt.id],
        ).catch(() => undefined);
      }
    }
  }

  async receiveWebhook(rawBody: Buffer, signature: string) {
    const paddle = this.requirePaddle();
    if (!signature || rawBody.length === 0) throw new BillingError(400, "INVALID_WEBHOOK", "Webhook signature or body is missing");
    try {
      await paddle.webhooks.unmarshal(rawBody.toString("utf8"), this.config.webhookSecret, signature);
    } catch {
      throw new BillingError(400, "INVALID_WEBHOOK_SIGNATURE", "Webhook signature is invalid");
    }
    let envelope: JsonRecord;
    try {
      const parsed: unknown = JSON.parse(rawBody.toString("utf8"));
      if (!isRecord(parsed)) throw new Error("invalid envelope");
      envelope = parsed;
    } catch {
      throw new BillingError(400, "INVALID_WEBHOOK", "Webhook payload is invalid");
    }
    const eventId = asString(getField(envelope, "event_id", "eventId"));
    const eventType = asString(getField(envelope, "event_type", "eventType"));
    const occurredAt = asDateString(getField(envelope, "occurred_at", "occurredAt"));
    if (!eventId || !eventType || !occurredAt) throw new BillingError(400, "INVALID_WEBHOOK", "Webhook envelope is incomplete");
    const payload = normalizedWebhookPayload(eventType, envelope.data, this.config);
    await this.pool.query(
      `INSERT INTO billing_webhook_events
         (environment, event_id, event_type, occurred_at, normalized_payload)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (environment, event_id) DO NOTHING`,
      [this.config.environment, eventId, eventType, occurredAt, JSON.stringify(payload)],
    );
    void this.processPendingEvents().catch(error => {
      this.logger.error({ err: error, module: "billing-webhook" }, "Background webhook processing failed");
    });
  }

  async processPendingEvents() {
    if (!this.config.enabled) return;
    const events = (await this.pool.query(
      `SELECT event_id AS "eventId" FROM billing_webhook_events
       WHERE environment = $1
         AND processing_status IN ('pending', 'failed', 'processing')
         AND attempt_count < 8
         AND next_attempt_at <= NOW()
       ORDER BY occurred_at ASC LIMIT 50`,
      [this.config.environment],
    )).rows;
    for (const row of events) await this.processEvent(String(row.eventId));
  }

  private async processEvent(eventId: string) {
    const client = await this.pool.connect();
    let transactionOpen = false;
    let clientReleased = false;
    try {
      await client.query("BEGIN");
      transactionOpen = true;
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`atomflow-billing-event:${this.config.environment}:${eventId}`]);
      const event = (await client.query(
        `SELECT event_type AS "eventType", occurred_at AS "occurredAt", normalized_payload AS payload,
                processing_status AS "processingStatus", next_attempt_at AS "nextAttemptAt"
         FROM billing_webhook_events WHERE environment = $1 AND event_id = $2 FOR UPDATE`,
        [this.config.environment, eventId],
      )).rows[0] as JsonRecord | undefined;
      if (!event || event.processingStatus === "processed" || event.processingStatus === "ignored" || event.processingStatus === "quarantined") {
        await client.query("COMMIT");
        transactionOpen = false;
        return;
      }
      if (event.processingStatus === "processing" && event.nextAttemptAt instanceof Date && event.nextAttemptAt.getTime() > Date.now()) {
        await client.query("COMMIT");
        transactionOpen = false;
        return;
      }
      await client.query(
        `UPDATE billing_webhook_events
         SET processing_status = 'processing', error_message = NULL,
             attempt_count = attempt_count + 1,
             next_attempt_at = NOW() + INTERVAL '5 minutes'
         WHERE environment = $1 AND event_id = $2`,
        [this.config.environment, eventId],
      );
      const eventType = String(event.eventType);
      const occurredAt = event.occurredAt instanceof Date ? event.occurredAt.toISOString() : String(event.occurredAt);
      const payload = isRecord(event.payload) ? event.payload : {};
      await client.query("COMMIT");
      transactionOpen = false;

      if (eventType === "adjustment.updated") {
        client.release();
        clientReleased = true;
        await this.processAdjustmentEvent(eventId, payload, occurredAt);
        return;
      }

      await client.query("BEGIN");
      transactionOpen = true;
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`atomflow-billing-event:${this.config.environment}:${eventId}`]);
      let status: "processed" | "ignored" | "quarantined" = "processed";
      let errorMessage: string | null = null;
      if (subscriptionStateEventTypes.has(eventType)) {
        const result = await this.upsertTrustedSubscription(client, normalizeSubscription(payload, this.config), occurredAt, false);
        if (!result.ok) {
          status = "quarantined";
          errorMessage = result.reason;
        }
      } else if (eventType === "transaction.completed" || eventType === "transaction.payment_failed") {
        const result = await this.updateCheckoutAttemptFromTransaction(client, eventType, payload, occurredAt);
        if (!result.ok) {
          status = "quarantined";
          errorMessage = result.reason;
        }
      } else {
        status = "ignored";
      }
      await this.finalizeWebhookEvent(client, eventId, status, errorMessage);
      await client.query("COMMIT");
      transactionOpen = false;
    } catch (error) {
      if (transactionOpen && !clientReleased) await client.query("ROLLBACK").catch(() => undefined);
      const database: pg.Pool | pg.PoolClient = clientReleased ? this.pool : client;
      await database.query(
        `UPDATE billing_webhook_events
         SET processing_status = CASE WHEN attempt_count >= 8 THEN 'quarantined' ELSE 'failed' END,
             error_message = $1,
             next_attempt_at = NOW() + (LEAST(3600, 5 * POWER(2, attempt_count)) * INTERVAL '1 second'),
             processed_at = CASE WHEN attempt_count >= 8 THEN NOW() ELSE NULL END,
             normalized_payload = CASE WHEN attempt_count >= 8
               THEN normalized_payload #- '{customData,atomflow_user_id}'
               ELSE normalized_payload END
         WHERE environment = $2 AND event_id = $3`,
        [error instanceof Error ? error.message.slice(0, 500) : "processing failed", this.config.environment, eventId],
      ).catch(() => undefined);
      this.logger.error({ err: error, module: "billing-webhook", eventId }, "Webhook event processing failed");
    } finally {
      if (!clientReleased) client.release();
    }
  }

  private async finalizeWebhookEvent(
    client: pg.Pool | pg.PoolClient,
    eventId: string,
    status: "processed" | "ignored" | "quarantined",
    errorMessage: string | null,
  ) {
    await client.query(
      `UPDATE billing_webhook_events
       SET processing_status = $1, error_message = $2, processed_at = NOW(), next_attempt_at = NOW(),
           normalized_payload = normalized_payload #- '{customData,atomflow_user_id}'
       WHERE environment = $3 AND event_id = $4`,
      [status, errorMessage, this.config.environment, eventId],
    );
  }

  private async processAdjustmentEvent(eventId: string, payload: JsonRecord, occurredAt: string) {
    const transactionId = asString(payload.transactionId);
    let subscriptionId = asString(payload.subscriptionId);
    const isApprovedFullRefund = payload.status === "approved" && payload.action === "refund" && payload.type === "full";
    const paddle = isApprovedFullRefund ? this.requirePaddle() : null;
    try {
      if (paddle && !subscriptionId && transactionId) {
        subscriptionId = (await paddle.transactions.get(transactionId)).subscriptionId;
      }
      if (!isApprovedFullRefund) {
        await this.finalizeWebhookEvent(this.pool, eventId, "ignored", null);
        return;
      }

      const attempt = transactionId ? (await this.pool.query(
      `SELECT id, user_id AS "userId", billing_customer_id AS "billingCustomerId",
              plan_code AS "planCode", status,
              last_adjustment_occurred_at AS "lastAdjustmentOccurredAt"
       FROM billing_checkout_attempts
       WHERE environment = $1 AND paddle_transaction_id = $2`,
      [this.config.environment, transactionId],
    )).rows[0] as JsonRecord | undefined : undefined;
      const subscription = subscriptionId ? (await this.pool.query(
      `SELECT id, user_id AS "userId", billing_customer_id AS "billingCustomerId",
              paddle_customer_id AS "paddleCustomerId",
              last_adjustment_occurred_at AS "lastAdjustmentOccurredAt"
       FROM billing_subscriptions
       WHERE environment = $1 AND paddle_subscription_id = $2`,
      [this.config.environment, subscriptionId],
      )).rows[0] as JsonRecord | undefined : undefined;
      if (!attempt && !subscription) {
        await this.finalizeWebhookEvent(this.pool, eventId, "quarantined", "adjustment does not reference a known transaction or subscription");
        return;
      }
      const latestCursor = [attempt?.lastAdjustmentOccurredAt, subscription?.lastAdjustmentOccurredAt]
      .map(value => {
        const timestamp = value instanceof Date ? value.getTime() : value ? new Date(String(value)).getTime() : Number.NEGATIVE_INFINITY;
        return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
      })
      .reduce((latest, value) => Math.max(latest, value), Number.NEGATIVE_INFINITY);
      if (latestCursor >= new Date(occurredAt).getTime()) {
        await this.finalizeWebhookEvent(this.pool, eventId, "ignored", "stale adjustment event");
        return;
      }

      if (!subscriptionId) throw new Error("Approved full refund has no subscription linkage");
      const remote = await paddle.subscriptions.get(subscriptionId);
      const normalizedRemote = normalizeSubscription(remote, this.config);
      if (
        !normalizedRemote
        || !hasExclusiveAtomFlowItem(remote, this.config)
        || normalizedRemote.productId !== this.config.productId
        || !this.config.allowedPriceIds.has(normalizedRemote.priceId)
      ) {
        await this.finalizeWebhookEvent(this.pool, eventId, "quarantined", "refund subscription product or price is not allowed");
        return;
      }
      const knownCustomer = (await this.pool.query(
        `SELECT id, user_id AS "userId"
         FROM billing_customers
         WHERE environment = $1 AND paddle_customer_id = $2`,
        [this.config.environment, normalizedRemote.customerId],
      )).rows[0] as JsonRecord | undefined;
      const derivedPlanCode = planCodeForPrice(this.config, normalizedRemote.priceId);
      const existingOwnershipMatches = Boolean(
        subscription?.userId
        && knownCustomer?.userId
        && String(subscription.userId) === String(knownCustomer.userId)
        && String(subscription.billingCustomerId) === String(knownCustomer.id)
        && String(subscription.paddleCustomerId) === normalizedRemote.customerId
      );
      const attemptOwnershipMatches = Boolean(
        !subscription
        && attempt?.userId
        && knownCustomer?.userId
        && String(attempt.userId) === String(knownCustomer.userId)
        && String(attempt.billingCustomerId) === String(knownCustomer.id)
        && derivedPlanCode
        && attempt.planCode === derivedPlanCode
        && ["completed", "confirmed", "refunded"].includes(String(attempt.status))
        && normalizedRemote.customData.checkout_attempt_id === String(attempt.id)
      );
      if (!existingOwnershipMatches && !attemptOwnershipMatches) {
        await this.finalizeWebhookEvent(this.pool, eventId, "quarantined", "refund subscription ownership is unknown or mismatched");
        return;
      }
      const canceled = normalizedRemote?.status === "canceled"
        ? remote
        : await paddle.subscriptions.cancel(subscriptionId, { effectiveFrom: "immediately" });
      const canceledSubscription = normalizeSubscription(canceled, this.config);
      if (!canceledSubscription) throw new Error("Refund cancellation returned an incomplete subscription");

      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`atomflow-billing-event:${this.config.environment}:${eventId}`]);
        const result = await this.upsertTrustedSubscription(client, canceledSubscription, canceledSubscription.paddleUpdatedAt || occurredAt, true);
        if (!result.ok) throw new Error(`Refund cancellation could not update subscription: ${result.reason}`);
        if (transactionId) {
          await client.query(
          `UPDATE billing_checkout_attempts
           SET status = 'refunded', last_adjustment_occurred_at = $1, updated_at = NOW()
           WHERE environment = $2 AND paddle_transaction_id = $3
             AND (last_adjustment_occurred_at IS NULL OR last_adjustment_occurred_at <= $1)`,
          [occurredAt, this.config.environment, transactionId],
        );
        }
        await client.query(
          `UPDATE billing_subscriptions
           SET last_adjustment_occurred_at = $1, updated_at = NOW()
           WHERE environment = $2 AND paddle_subscription_id = $3
             AND (last_adjustment_occurred_at IS NULL OR last_adjustment_occurred_at <= $1)`,
          [occurredAt, this.config.environment, subscriptionId],
        );
        await this.finalizeWebhookEvent(client, eventId, "processed", null);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      throw error;
    }
  }

  private async updateCheckoutAttemptFromTransaction(client: pg.PoolClient, eventType: string, payload: JsonRecord, occurredAt: string) {
    const custom = getCustomData(payload.customData);
    const attemptId = custom.checkout_attempt_id;
    const transactionId = asString(payload.id);
    const attempt = attemptId
      ? (await client.query(
          `SELECT id, user_id AS "userId", billing_customer_id AS "billingCustomerId",
                  paddle_transaction_id AS "transactionId", plan_code AS "planCode"
           FROM billing_checkout_attempts WHERE environment = $1 AND id = $2`,
          [this.config.environment, attemptId],
        )).rows[0]
      : transactionId
        ? (await client.query(
            `SELECT id, user_id AS "userId", billing_customer_id AS "billingCustomerId",
                    paddle_transaction_id AS "transactionId", plan_code AS "planCode"
             FROM billing_checkout_attempts WHERE environment = $1 AND paddle_transaction_id = $2`,
            [this.config.environment, transactionId],
          )).rows[0]
        : null;
    if (!attempt) {
      const subscriptionId = asString(payload.subscriptionId);
      const customerId = asString(payload.customerId);
      const priceId = asString(payload.priceId);
      const productId = asString(payload.productId);
      const knownSubscription = subscriptionId && customerId && priceId && productId === this.config.productId
        && this.config.allowedPriceIds.has(priceId)
        ? (await client.query(
            `SELECT 1 FROM billing_subscriptions
             WHERE environment = $1 AND paddle_subscription_id = $2
               AND paddle_customer_id = $3 AND product_id = $4 AND price_id = $5
               AND quarantined_at IS NULL`,
            [this.config.environment, subscriptionId, customerId, productId, priceId],
          )).rowCount
        : 0;
      if (knownSubscription) return { ok: true as const };
      return { ok: false as const, reason: "transaction does not reference a known checkout attempt or subscription" };
    }
    if (custom.atomflow_user_id && custom.atomflow_user_id !== String(attempt.userId)) {
      return { ok: false as const, reason: "transaction user does not match checkout attempt" };
    }
    if (attempt.transactionId && transactionId !== String(attempt.transactionId)) {
      return { ok: false as const, reason: "transaction id does not match checkout attempt" };
    }
    const priceId = asString(payload.priceId);
    const productId = asString(payload.productId);
    const planCode = planCodeForPrice(this.config, priceId || "");
    if (!priceId || !productId || productId !== this.config.productId || !planCode || planCode !== attempt.planCode) {
      return { ok: false as const, reason: "transaction product or price is not allowed" };
    }
    const customerId = asString(payload.customerId);
    const knownCustomer = customerId ? (await client.query(
      `SELECT 1 FROM billing_customers
       WHERE environment = $1 AND paddle_customer_id = $2 AND user_id = $3 AND id = $4`,
      [this.config.environment, customerId, attempt.userId, attempt.billingCustomerId],
    )).rowCount : 0;
    if (!knownCustomer) return { ok: false as const, reason: "transaction customer is unknown or mismatched" };
    await client.query(
      `UPDATE billing_checkout_attempts
       SET paddle_transaction_id = COALESCE($1, paddle_transaction_id),
           status = $2,
           error_code = $3,
           last_event_occurred_at = $4,
           updated_at = NOW()
       WHERE environment = $5 AND id = $6
         AND status <> 'refunded'
         AND (last_event_occurred_at IS NULL OR last_event_occurred_at <= $4)`,
      [transactionId, eventType === "transaction.completed" ? "completed" : "payment_failed", eventType === "transaction.payment_failed" ? "PAYMENT_FAILED" : null, occurredAt, this.config.environment, attempt.id],
    );
    return { ok: true as const };
  }

  private async upsertTrustedSubscription(
    client: pg.PoolClient,
    subscription: NormalizedSubscription | null,
    occurredAt: string,
    trustedFromApi: boolean,
  ) {
    if (!subscription) return { ok: false as const, reason: "subscription payload is incomplete" };
    const existing = (await client.query(
      `SELECT user_id AS "userId", billing_customer_id AS "billingCustomerId",
              paddle_customer_id AS "paddleCustomerId", plan_code AS "planCode"
       FROM billing_subscriptions WHERE environment = $1 AND paddle_subscription_id = $2`,
      [this.config.environment, subscription.id],
    )).rows[0] as JsonRecord | undefined;
    const priceAllowed = subscription.productId === this.config.productId
      && this.config.allowedPriceIds.has(subscription.priceId);
    if (!priceAllowed) {
      if (existing && (!existing.paddleCustomerId || String(existing.paddleCustomerId) === subscription.customerId)) {
        const remoteUpdatedAt = subscription.paddleUpdatedAt || occurredAt;
        if (trustedFromApi) {
          await client.query(
            `UPDATE billing_subscriptions
             SET quarantined_at = NOW(), quarantine_reason = $1, paddle_updated_at = $2, updated_at = NOW()
             WHERE environment = $3 AND paddle_subscription_id = $4
               AND (paddle_updated_at IS NULL OR paddle_updated_at <= $2)`,
            ["subscription product or price is not allowed", remoteUpdatedAt, this.config.environment, subscription.id],
          );
        } else {
          await client.query(
            `UPDATE billing_subscriptions
             SET quarantined_at = NOW(), quarantine_reason = $1,
                 last_event_occurred_at = $2, paddle_updated_at = GREATEST(paddle_updated_at, $3), updated_at = NOW()
             WHERE environment = $4 AND paddle_subscription_id = $5
               AND last_event_occurred_at <= $2
               AND (paddle_updated_at IS NULL OR $3 IS NULL OR paddle_updated_at <= $3)`,
            ["subscription product or price is not allowed", occurredAt, remoteUpdatedAt, this.config.environment, subscription.id],
          );
        }
      }
      return { ok: false as const, reason: "subscription product or price is not allowed" };
    }
    const customer = (await client.query(
      `SELECT id, user_id AS "userId" FROM billing_customers
       WHERE environment = $1 AND paddle_customer_id = $2`,
      [this.config.environment, subscription.customerId],
    )).rows[0] as JsonRecord | undefined;
    if (!customer?.userId) return { ok: false as const, reason: "subscription customer is unknown or detached" };
    if (existing?.userId && String(existing.userId) !== String(customer.userId)) {
      return { ok: false as const, reason: "subscription owner changed" };
    }
    const derivedPlanCode = planCodeForPrice(this.config, subscription.priceId);
    if (!existing) {
      if (!derivedPlanCode) return { ok: false as const, reason: "legacy prices cannot create a new subscription" };
      const attemptId = subscription.customData.checkout_attempt_id;
      const attempt = attemptId ? (await client.query(
        `SELECT user_id AS "userId", billing_customer_id AS "billingCustomerId",
                plan_code AS "planCode", paddle_transaction_id AS "transactionId", status
         FROM billing_checkout_attempts
         WHERE environment = $1 AND id = $2`,
        [this.config.environment, attemptId],
      )).rows[0] as JsonRecord | undefined : undefined;
      if (
        !attempt?.userId
        || String(attempt.userId) !== String(customer.userId)
        || String(attempt.billingCustomerId) !== String(customer.id)
        || attempt.planCode !== derivedPlanCode
        || !attempt.transactionId
        || attempt.status !== "completed"
      ) {
        return { ok: false as const, reason: "new subscription has no matching checkout attempt" };
      }
    }
    const planCode = derivedPlanCode || existing?.planCode;
    const validPlanCode = planCode === "pro_monthly" || planCode === "pro_yearly" ? planCode : null;
    const values = [
      this.config.environment,
      subscription.id,
      subscription.customerId,
      customer.id,
      customer.userId,
      subscription.productId,
      subscription.priceId,
      validPlanCode,
      subscription.status,
      subscription.currentPeriodStartsAt,
      subscription.currentPeriodEndsAt,
      subscription.scheduledChange ? JSON.stringify(subscription.scheduledChange) : null,
      occurredAt,
      subscription.paddleUpdatedAt || occurredAt,
    ];
    if (trustedFromApi) {
      await client.query(
        `INSERT INTO billing_subscriptions
           (environment, paddle_subscription_id, paddle_customer_id, billing_customer_id, user_id,
            product_id, price_id, plan_code, status, current_period_starts_at, current_period_ends_at,
            scheduled_change, last_event_occurred_at, paddle_updated_at, quarantined_at, quarantine_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, '-infinity', $13, NULL, NULL)
         ON CONFLICT (environment, paddle_subscription_id) DO UPDATE SET
           paddle_customer_id = EXCLUDED.paddle_customer_id,
           billing_customer_id = EXCLUDED.billing_customer_id,
           user_id = EXCLUDED.user_id,
           product_id = EXCLUDED.product_id,
           price_id = EXCLUDED.price_id,
           plan_code = EXCLUDED.plan_code,
           status = EXCLUDED.status,
           current_period_starts_at = EXCLUDED.current_period_starts_at,
           current_period_ends_at = EXCLUDED.current_period_ends_at,
           scheduled_change = EXCLUDED.scheduled_change,
           paddle_updated_at = EXCLUDED.paddle_updated_at,
           quarantined_at = NULL,
           quarantine_reason = NULL,
           updated_at = NOW()
         WHERE billing_subscriptions.paddle_updated_at IS NULL
            OR billing_subscriptions.paddle_updated_at <= EXCLUDED.paddle_updated_at`,
        [...values.slice(0, 12), values[13]],
      );
    } else {
      await client.query(
        `INSERT INTO billing_subscriptions
           (environment, paddle_subscription_id, paddle_customer_id, billing_customer_id, user_id,
            product_id, price_id, plan_code, status, current_period_starts_at, current_period_ends_at,
            scheduled_change, last_event_occurred_at, paddle_updated_at, quarantined_at, quarantine_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NULL, NULL)
         ON CONFLICT (environment, paddle_subscription_id) DO UPDATE SET
           paddle_customer_id = EXCLUDED.paddle_customer_id,
           billing_customer_id = EXCLUDED.billing_customer_id,
           user_id = EXCLUDED.user_id,
           product_id = EXCLUDED.product_id,
           price_id = EXCLUDED.price_id,
           plan_code = EXCLUDED.plan_code,
           status = EXCLUDED.status,
           current_period_starts_at = EXCLUDED.current_period_starts_at,
           current_period_ends_at = EXCLUDED.current_period_ends_at,
           scheduled_change = EXCLUDED.scheduled_change,
           last_event_occurred_at = EXCLUDED.last_event_occurred_at,
           paddle_updated_at = GREATEST(billing_subscriptions.paddle_updated_at, EXCLUDED.paddle_updated_at),
           quarantined_at = NULL,
           quarantine_reason = NULL,
           updated_at = NOW()
         WHERE (billing_subscriptions.last_event_occurred_at IS NULL
                OR billing_subscriptions.last_event_occurred_at <= EXCLUDED.last_event_occurred_at)
           AND (billing_subscriptions.paddle_updated_at IS NULL
                OR EXCLUDED.paddle_updated_at IS NULL
                OR billing_subscriptions.paddle_updated_at <= EXCLUDED.paddle_updated_at)`,
        values,
      );
    }
    const attemptId = subscription.customData.checkout_attempt_id;
    if (attemptId) {
      await client.query(
        `UPDATE billing_checkout_attempts SET status = 'confirmed', error_code = NULL, updated_at = NOW()
         WHERE environment = $1 AND id = $2 AND user_id = $3 AND status = 'completed'`,
        [this.config.environment, attemptId, customer.userId],
      );
    } else if (validPlanCode) {
      await client.query(
        `UPDATE billing_checkout_attempts SET status = 'confirmed', error_code = NULL, updated_at = NOW()
         WHERE environment = $1 AND billing_customer_id = $2 AND plan_code = $3 AND status = 'completed'`,
        [this.config.environment, customer.id, validPlanCode],
      );
    }
    return { ok: true as const };
  }

  startWorkers() {
    if (!this.config.enabled || this.workerTimer || this.reconcileTimer) return;
    const processPending = () => void (async () => {
      await this.processPendingEvents();
      await this.recoverCheckoutAttempts();
    })().catch(error => {
      this.logger.error({ err: error, module: "billing-worker" }, "Billing inbox scan failed");
    });
    const reconcile = () => void this.reconcileSubscriptions().catch(error => {
      this.logger.error({ err: error, module: "billing-reconcile" }, "Billing reconciliation scan failed");
    });
    processPending();
    this.workerTimer = setInterval(processPending, 30_000);
    this.workerTimer.unref();
    this.reconcileTimer = setInterval(reconcile, 15 * 60_000);
    this.reconcileTimer.unref();
  }

  async reconcileSubscriptions() {
    if (!this.config.enabled) return;
    const paddle = this.requirePaddle();
    const lockKey = `atomflow-billing-reconcile:${this.config.environment}`;
    const claimClient = await this.pool.connect();
    let subscriptions: JsonRecord[] = [];
    try {
      await claimClient.query("BEGIN");
      const locked = (await claimClient.query(
        `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked`,
        [lockKey],
      )).rows[0]?.locked === true;
      if (!locked) {
        await claimClient.query("ROLLBACK");
        return;
      }
      subscriptions = (await claimClient.query(
        `SELECT paddle_subscription_id AS id FROM billing_subscriptions
         WHERE environment = $1 AND quarantined_at IS NULL`,
        [this.config.environment],
      )).rows;
      await claimClient.query("COMMIT");
    } catch (error) {
      await claimClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      claimClient.release();
    }
    for (const row of subscriptions) {
      try {
        const remote = await paddle.subscriptions.get(String(row.id));
        const client = await this.pool.connect();
        try {
          await client.query("BEGIN");
          const result = await this.upsertTrustedSubscription(client, normalizeSubscription(remote, this.config), new Date(remote.updatedAt).toISOString(), true);
          if (!result.ok) {
            this.logger.warn({ module: "billing-reconcile", subscriptionId: row.id, reason: result.reason }, "Subscription reconciliation rejected remote state");
          }
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      } catch (error) {
        this.logger.warn({ err: error, module: "billing-reconcile", subscriptionId: row.id }, "Subscription reconciliation failed");
      }
    }
  }
}
