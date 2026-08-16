import { createHash, randomUUID } from "node:crypto";
import { AlipaySdk, AlipayRequestError } from "alipay-sdk";
import type pg from "pg";
import type { AlipayBillingConfig, AlipayBillingPlan, AlipayPlanCode } from "./alipayConfig.js";
import { isTeamPlanCode } from "./alipayConfig.js";
import { BillingError, type BillingLogger } from "./types.js";

type JsonRecord = Record<string, unknown>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const asRecord = (value: unknown): JsonRecord => value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
const asString = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
const pick = (record: JsonRecord, snake: string, camel: string) => record[snake] ?? record[camel];
const parseJsonRecord = (value: unknown): JsonRecord => {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonRecord;
  if (typeof value !== "string") return {};
  try { return asRecord(JSON.parse(value)); } catch { return {}; }
};
const parseItems = (value: unknown): JsonRecord[] => Array.isArray(value) ? value.map(asRecord) : [];
const isValidEmailAddress = (value: string): boolean => {
  if (value.length < 3 || value.length > 254) return false;
  if ([...value].some(character => character === " " || character === "\t" || character === "\n" || character === "\r")) return false;
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@") || at >= value.length - 1) return false;
  const domain = value.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  return dot > 0 && dot < domain.length - 1;
};
const parseDate = (value: unknown): string | null => {
  const text = asString(value);
  if (!text) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? `${text.replace(" ", "T")}+08:00` : text;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
};

type NormalizedSubscription = {
  id: string;
  customerId: string;
  status: "incomplete" | "active" | "trialing" | "past_due" | "paused" | "canceled" | "expired";
  productId: string | null;
  priceId: string;
  itemId: string | null;
  quantity: number;
  pendingItemId: string | null;
  pendingQuantity: number | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  raw: JsonRecord;
};

const mapStatus = (value: unknown): NormalizedSubscription["status"] => {
  switch (String(value || "").toUpperCase()) {
    case "ACTIVE": return "active";
    case "TRIALING": return "trialing";
    case "PAST_DUE": case "UNPAID": return "past_due";
    case "PAUSED": return "paused";
    case "CANCELED": return "canceled";
    case "INCOMPLETE_EXPIRED": return "expired";
    default: return "incomplete";
  }
};

const normalizeSubscription = (input: unknown): NormalizedSubscription | null => {
  const raw = parseJsonRecord(input);
  const items = parseItems(pick(raw, "items", "items"));
  const validItems = parseItems(pick(raw, "valid_items", "validItems"));
  const activeItem = validItems[0] || items.find(item => String(pick(item, "status", "status") || "").toUpperCase() !== "PENDING") || items[0] || {};
  const pendingItems = parseItems(pick(raw, "pending_items", "pendingItems"));
  const pendingItem = pendingItems[0] || items.find(item => String(pick(item, "status", "status") || "").toUpperCase() === "PENDING") || null;
  const id = asString(pick(raw, "subscription_id", "subscriptionId"));
  const customerId = asString(pick(raw, "customer_id", "customerId"));
  const priceId = asString(pick(activeItem, "price_id", "priceId"));
  if (!id || !customerId || !priceId) return null;
  const quantityValue = Number(pick(activeItem, "quantity", "quantity") ?? 1);
  const pendingQuantityValue = pendingItem ? Number(pick(pendingItem, "quantity", "quantity")) : NaN;
  return {
    id,
    customerId,
    status: mapStatus(pick(raw, "subscription_status", "subscriptionStatus")),
    productId: asString(pick(activeItem, "product_id", "productId") ?? pick(raw, "product_id", "productId")),
    priceId,
    itemId: asString(pick(activeItem, "item_id", "itemId")),
    quantity: Number.isSafeInteger(quantityValue) && quantityValue > 0 ? quantityValue : 1,
    pendingItemId: pendingItem ? asString(pick(pendingItem, "item_id", "itemId")) : null,
    pendingQuantity: Number.isSafeInteger(pendingQuantityValue) && pendingQuantityValue > 0 ? pendingQuantityValue : null,
    currentPeriodStart: parseDate(pick(raw, "current_period_start", "currentPeriodStart")),
    currentPeriodEnd: parseDate(pick(raw, "current_period_end", "currentPeriodEnd")),
    cancelAtPeriodEnd: pick(raw, "cancel_at_period_end", "cancelAtPeriodEnd") === true || String(pick(raw, "cancel_at_period_end", "cancelAtPeriodEnd")) === "true",
    raw,
  };
};

export class AlipayBillingService {
  private readonly sdk: AlipaySdk | null;
  private reconcileTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly pool: pg.Pool,
    private readonly config: AlipayBillingConfig,
    private readonly logger: BillingLogger,
  ) {
    this.sdk = config.appId && config.privateKey && config.alipayPublicKey ? new AlipaySdk({
      appId: config.appId,
      privateKey: config.privateKey,
      alipayPublicKey: config.alipayPublicKey,
      keyType: config.keyType,
      signType: "RSA2",
      endpoint: config.endpoint,
    }) : null;
  }

  private requireSdk() {
    if (!this.config.enabled || !this.sdk) throw new BillingError(503, "BILLING_UNAVAILABLE", "支付宝订阅暂未启用");
    return this.sdk;
  }

  private apiParams(bizContent: JsonRecord, common: JsonRecord = {}): JsonRecord {
    return { bizContent, ...common, ...(this.config.appAuthToken ? { appAuthToken: this.config.appAuthToken } : {}) };
  }

  private async exec(method: string, bizContent: JsonRecord, common: JsonRecord = {}): Promise<JsonRecord> {
    try {
      const result = asRecord(await this.requireSdk().exec(method, this.apiParams(bizContent, common), { validateSign: true }));
      if (String(result.code) !== "10000") {
        throw new BillingError(502, String(result.sub_code || "ALIPAY_API_ERROR"), String(result.sub_msg || result.msg || "支付宝请求失败"));
      }
      return result;
    } catch (error) {
      if (error instanceof BillingError) throw error;
      const code = error instanceof AlipayRequestError ? error.code : undefined;
      this.logger.error({ err: error, module: "alipay-api", method, code }, "Alipay API request failed");
      throw new BillingError(503, "ALIPAY_API_UNAVAILABLE", "支付宝暂时无法响应，请勿重复付款，稍后重新检查");
    }
  }

  private planForPrice(priceId: string): AlipayPlanCode | null {
    for (const [code, configured] of Object.entries(this.config.priceIds)) {
      if (configured && configured === priceId) return code as AlipayPlanCode;
    }
    return null;
  }

  async getValidatedPlans(): Promise<readonly AlipayBillingPlan[]> {
    if (!this.config.enabled) return this.config.plans;
    for (const plan of this.config.plans) {
      const response = await this.exec("alipay.trade.price.query", { price_id: this.config.priceIds[plan.code], query_options: ["product"] });
      const actualPriceId = asString(pick(response, "price_id", "priceId") ?? response.id);
      const actualProductId = asString(pick(response, "product_id", "productId"));
      const amountFen = Number(pick(response, "unit_amount", "unitAmount"));
      const expectedProductId = plan.audience === "team" ? this.config.productIds.team : this.config.productIds.individual;
      if (actualPriceId !== this.config.priceIds[plan.code] || actualProductId !== expectedProductId || amountFen !== Math.round(plan.priceCny * 100)) {
        throw new BillingError(503, "BILLING_CATALOG_MISMATCH", `支付宝套餐 ${plan.code} 与服务器配置不一致`);
      }
    }
    return this.config.plans;
  }

  private async ensureCustomer(userId: number, email: string): Promise<string> {
    const existing = (await this.pool.query(
      `SELECT alipay_customer_id AS "customerId" FROM alipay_billing_customers WHERE user_id = $1`, [userId],
    )).rows[0] as JsonRecord | undefined;
    if (existing?.customerId) return String(existing.customerId);
    const user = (await this.pool.query(`SELECT nickname FROM users WHERE id = $1`, [userId])).rows[0] as JsonRecord | undefined;
    const response = await this.exec("alipay.trade.customer.create", {
      name: asString(user?.nickname) || email.split("@")[0] || `AtomFlow 用户 ${userId}`,
      email,
      description: "AtomFlow 订阅客户",
    });
    const customerId = asString(pick(response, "customer_id", "customerId"));
    if (!customerId) throw new BillingError(502, "ALIPAY_CUSTOMER_INVALID", "支付宝未返回客户编号");
    const inserted = await this.pool.query(
      `INSERT INTO alipay_billing_customers (user_id, alipay_customer_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id) WHERE user_id IS NOT NULL DO UPDATE SET updated_at = NOW()
       RETURNING alipay_customer_id AS "customerId"`,
      [userId, customerId],
    );
    return String(inserted.rows[0]?.customerId || customerId);
  }

  async createCheckout(userId: number, email: string, planCode: AlipayPlanCode, requestId: string, requestedQuantity?: number) {
    if (!UUID_PATTERN.test(requestId)) throw new BillingError(400, "INVALID_REQUEST_ID", "requestId 必须是 UUID");
    const teamPlan = isTeamPlanCode(planCode);
    const quantity = teamPlan ? Number(requestedQuantity) : 1;
    if (teamPlan && (!Number.isSafeInteger(quantity) || quantity < 2 || quantity > 1000)) {
      throw new BillingError(400, "INVALID_TEAM_QUANTITY", "团队订阅席位数必须为 2–1000 的整数");
    }
    if (!this.config.priceIds[planCode] || !this.config.plans.some(plan => plan.code === planCode)) {
      throw new BillingError(400, "INVALID_BILLING_PLAN", "该套餐尚未开放");
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`atomflow-alipay-user:${userId}`]);
      const active = await client.query(
        `SELECT 1 FROM alipay_billing_subscriptions
         WHERE user_id = $1 AND quarantined_at IS NULL AND status IN ('active','trialing','past_due','paused') LIMIT 1`, [userId],
      );
      if (active.rowCount) throw new BillingError(409, "BILLING_ALREADY_ACTIVE", "当前账户已有有效订阅");
      const activeTeamMembership = await client.query(
        `SELECT 1 FROM billing_team_members m
         JOIN alipay_team_subscriptions ts ON ts.team_id=m.team_id
         JOIN alipay_billing_subscriptions s ON s.alipay_subscription_id=ts.alipay_subscription_id
         WHERE m.user_id=$1 AND m.status='active' AND s.quarantined_at IS NULL AND s.status IN ('active','trialing','past_due','paused') LIMIT 1`, [userId],
      );
      if (activeTeamMembership.rowCount) throw new BillingError(409, "BILLING_ALREADY_ACTIVE", "当前账户已由团队订阅授权，不能重复购买");
      const same = (await client.query(
        `SELECT plan_code AS "planCode", quantity, checkout_url AS "checkoutUrl", status
         FROM alipay_billing_checkout_attempts WHERE user_id = $1 AND request_id = $2`, [userId, requestId],
      )).rows[0] as JsonRecord | undefined;
      if (same) {
        if (same.planCode !== planCode || Number(same.quantity) !== quantity) {
          throw new BillingError(409, "BILLING_IDEMPOTENCY_CONFLICT", "同一 requestId 不能用于不同套餐或席位数");
        }
        if (same.checkoutUrl && same.status === "pending") {
          await client.query("COMMIT");
          return { provider: "alipay", checkoutUrl: String(same.checkoutUrl), requestId };
        }
        throw new BillingError(409, "BILLING_CHECKOUT_PENDING", "当前已有结账正在确认中");
      }
      const pending = await client.query(
        `SELECT 1 FROM alipay_billing_checkout_attempts WHERE user_id = $1 AND status IN ('creating','pending') LIMIT 1`, [userId],
      );
      if (pending.rowCount) throw new BillingError(409, "BILLING_CHECKOUT_PENDING", "当前已有结账正在确认中");
      await client.query(
        `INSERT INTO alipay_billing_checkout_attempts (id, user_id, request_id, plan_code, quantity)
         VALUES ($1, $2, $3, $4, $5)`, [randomUUID(), userId, requestId, planCode, quantity],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    try {
      const customerId = await this.ensureCustomer(userId, email);
      const item: JsonRecord = { price_id: this.config.priceIds[planCode] };
      if (teamPlan) item.quantity = quantity; // individual subscriptions must omit quantity
      const attempt = (await this.pool.query(
        `SELECT id FROM alipay_billing_checkout_attempts WHERE user_id = $1 AND request_id = $2`, [userId, requestId],
      )).rows[0] as JsonRecord;
      const response = await this.exec("alipay.trade.subscription.create", {
        customer_id: customerId,
        items: [item],
        subscribe_title: teamPlan ? "AtomFlow 团队订阅" : "AtomFlow 魔法写作 Pro",
        deduct_type: "SUBSCRIBE_DEDUCT",
        effective_type: "IMMEDIATE_EFFECTIVE",
        metadata: JSON.stringify({ atomflow_user_id: String(userId), checkout_attempt_id: String(attempt.id), plan_code: planCode }),
      }, { notifyUrl: this.config.notifyUrl, returnUrl: this.config.returnUrl });
      const subscriptionId = asString(pick(response, "subscription_id", "subscriptionId"));
      const orderNo = asString(pick(response, "order_no", "orderNo"));
      const checkoutUrl = asString(pick(response, "alipay_schema", "alipaySchema") ?? pick(response, "alipay_jump_schema", "alipayJumpSchema"));
      if (!subscriptionId || !checkoutUrl || !/^(https:|alipays:)/i.test(checkoutUrl)) {
        throw new BillingError(502, "ALIPAY_CHECKOUT_INVALID", "支付宝未返回有效的签约链接");
      }
      await this.pool.query(
        `UPDATE alipay_billing_checkout_attempts
         SET customer_id = $1, subscription_id = $2, order_no = $3, checkout_url = $4, status = 'pending', updated_at = NOW()
         WHERE user_id = $5 AND request_id = $6 AND status = 'creating'`,
        [customerId, subscriptionId, orderNo, checkoutUrl, userId, requestId],
      );
      return { provider: "alipay", checkoutUrl, subscriptionId, requestId };
    } catch (error) {
      const uncertain = error instanceof BillingError && error.code === "ALIPAY_API_UNAVAILABLE";
      await this.pool.query(
        `UPDATE alipay_billing_checkout_attempts SET status = 'failed', error_code = $1, updated_at = NOW()
         WHERE user_id = $2 AND request_id = $3 AND status = 'creating'`,
        [error instanceof BillingError ? error.code : "ALIPAY_CREATE_FAILED", userId, requestId],
      );
      if (uncertain) {
        await this.pool.query(
          `UPDATE alipay_billing_checkout_attempts SET status='pending', updated_at=NOW()
           WHERE user_id=$1 AND request_id=$2 AND status='failed'`, [userId, requestId],
        );
      }
      throw error;
    }
  }

  private async upsertSubscription(subscription: NormalizedSubscription, occurredAt: string, changeType: string | null) {
    const planCode = this.planForPrice(subscription.priceId);
    const customer = (await this.pool.query(
      `SELECT user_id AS "userId" FROM alipay_billing_customers WHERE alipay_customer_id = $1`, [subscription.customerId],
    )).rows[0] as JsonRecord | undefined;
    if (!customer?.userId || !planCode) {
      await this.pool.query(
        `UPDATE alipay_billing_subscriptions SET quarantined_at = NOW(), quarantine_reason = $1, updated_at = NOW()
         WHERE alipay_subscription_id = $2`, [!planCode ? "unapproved price id" : "unknown customer", subscription.id],
      );
      return false;
    }
    const expectedProduct = isTeamPlanCode(planCode) ? this.config.productIds.team : this.config.productIds.individual;
    if (subscription.productId && expectedProduct && subscription.productId !== expectedProduct) return false;
    await this.pool.query(
      `INSERT INTO alipay_billing_subscriptions
         (alipay_subscription_id, alipay_customer_id, user_id, product_id, price_id, plan_code, status,
          item_id, quantity, pending_item_id, pending_quantity, current_period_starts_at, current_period_ends_at,
          cancel_at_period_end, last_change_type, last_notify_at, raw_subscription)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
       ON CONFLICT (alipay_subscription_id) DO UPDATE SET
         alipay_customer_id=EXCLUDED.alipay_customer_id, user_id=EXCLUDED.user_id, product_id=EXCLUDED.product_id,
         price_id=EXCLUDED.price_id, plan_code=EXCLUDED.plan_code, status=EXCLUDED.status,
         item_id=EXCLUDED.item_id, quantity=EXCLUDED.quantity, pending_item_id=EXCLUDED.pending_item_id,
         pending_quantity=EXCLUDED.pending_quantity, current_period_starts_at=EXCLUDED.current_period_starts_at,
         current_period_ends_at=EXCLUDED.current_period_ends_at, cancel_at_period_end=EXCLUDED.cancel_at_period_end,
         last_change_type=EXCLUDED.last_change_type, last_notify_at=EXCLUDED.last_notify_at,
         raw_subscription=EXCLUDED.raw_subscription, quarantined_at=NULL, quarantine_reason=NULL, updated_at=NOW()
       WHERE alipay_billing_subscriptions.last_notify_at <= EXCLUDED.last_notify_at`,
      [subscription.id, subscription.customerId, Number(customer.userId), subscription.productId, subscription.priceId, planCode,
        subscription.status, subscription.itemId, subscription.quantity, subscription.pendingItemId, subscription.pendingQuantity,
        subscription.currentPeriodStart, subscription.currentPeriodEnd, subscription.cancelAtPeriodEnd, changeType, occurredAt,
        JSON.stringify(subscription.raw)],
    );
    await this.pool.query(
      `UPDATE alipay_billing_checkout_attempts SET status = $1, updated_at = NOW()
       WHERE subscription_id = $2 AND user_id = $3 AND status IN ('creating','pending')`,
      [subscription.status === "active" || subscription.status === "trialing" ? "confirmed" : subscription.status === "canceled" ? "canceled" : subscription.status === "expired" ? "expired" : "pending", subscription.id, customer.userId],
    );
    if (isTeamPlanCode(planCode)) {
      const team = await this.pool.query(
        `INSERT INTO billing_teams (id, owner_user_id, name)
         VALUES ($1, $2, $3)
         ON CONFLICT (owner_user_id) DO UPDATE SET updated_at = NOW()
         RETURNING id`, [randomUUID(), customer.userId, "我的 AtomFlow 团队"],
      );
      const teamId = team.rows[0]?.id;
      await this.pool.query(
        `INSERT INTO billing_team_members (team_id, user_id, role) VALUES ($1,$2,'owner')
         ON CONFLICT (team_id,user_id) DO UPDATE SET role='owner', status='active', updated_at=NOW()`, [teamId, customer.userId],
      );
      await this.pool.query(
        `INSERT INTO alipay_team_subscriptions (team_id, alipay_subscription_id) VALUES ($1,$2)
         ON CONFLICT (team_id) DO UPDATE SET alipay_subscription_id=EXCLUDED.alipay_subscription_id, updated_at=NOW()`, [teamId, subscription.id],
      );
    }
    return true;
  }

  async receiveNotification(params: Record<string, unknown>) {
    if (!this.requireSdk().checkNotifySignV2(params)) throw new BillingError(400, "ALIPAY_SIGNATURE_INVALID", "支付宝通知签名无效");
    const eventType = asString(params.msg_method ?? params.method ?? params.notify_type) || "alipay.trade.subscription.changed";
    const changeType = asString(params.change_type);
    const subscription = normalizeSubscription(params.subscription);
    const notifyId = asString(params.notify_id) || createHash("sha256")
      .update(JSON.stringify({ eventType, changeType, subscription: params.subscription, notifyTime: params.notify_time, sign: params.sign }))
      .digest("hex");
    const occurredAt = parseDate(params.notify_time) || new Date().toISOString();
    const inserted = await this.pool.query(
      `INSERT INTO alipay_billing_notifications
         (notify_id,event_type,subscription_id,change_type,occurred_at,normalized_payload,processing_status)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,'processed') ON CONFLICT (notify_id) DO NOTHING`,
      [notifyId, eventType, subscription?.id || null, changeType, occurredAt, JSON.stringify({ ...params, sign: undefined })],
    );
    if (!inserted.rowCount) return;
    if (eventType !== "alipay.trade.subscription.changed" || !subscription) {
      await this.pool.query(`UPDATE alipay_billing_notifications SET processing_status='ignored' WHERE notify_id=$1`, [notifyId]);
      return;
    }
    const trusted = await this.upsertSubscription(subscription, occurredAt, changeType);
    if (!trusted) {
      await this.pool.query(
        `UPDATE alipay_billing_notifications SET processing_status='quarantined', error_message='untrusted customer, product, or price' WHERE notify_id=$1`, [notifyId],
      );
    }
  }

  private async reconcileUser(userId: number) {
    if (!this.config.enabled) return;
    const customer = (await this.pool.query(
      `SELECT alipay_customer_id AS "customerId" FROM alipay_billing_customers WHERE user_id=$1`, [userId],
    )).rows[0] as JsonRecord | undefined;
    if (!customer?.customerId) return;
    const response = await this.exec("alipay.trade.subscription.query", { customer_id: String(customer.customerId) });
    const subscriptions = Array.isArray(response.subscriptions) ? response.subscriptions : [];
    for (const raw of subscriptions) {
      const normalized = normalizeSubscription(raw);
      if (normalized) await this.upsertSubscription(normalized, new Date().toISOString(), "query_reconcile");
    }
    if (subscriptions.length === 0) {
      await this.pool.query(
        `UPDATE alipay_billing_checkout_attempts SET status='failed', error_code='ALIPAY_CREATE_NOT_FOUND', updated_at=NOW()
         WHERE user_id=$1 AND status='pending' AND created_at < NOW() - INTERVAL '30 minutes'`, [userId],
      );
    }
  }

  async resolveMagicWritingAccess(userId: number) {
    const hasPending = (await this.pool.query(
      `SELECT 1 FROM alipay_billing_checkout_attempts WHERE user_id=$1 AND status='pending' LIMIT 1`, [userId],
    )).rowCount;
    if (hasPending && this.config.enabled) await this.reconcileUser(userId).catch(error => {
      this.logger.warn({ err: error, module: "alipay-reconcile", userId }, "Unable to reconcile pending Alipay subscription");
    });
    const subscription = (await this.pool.query(
      `SELECT s.status, s.plan_code AS "planCode", s.current_period_ends_at AS "currentPeriodEndsAt",
              s.cancel_at_period_end AS "cancelAtPeriodEnd", s.quantity, s.pending_quantity AS "pendingQuantity"
       FROM alipay_billing_subscriptions s
       LEFT JOIN alipay_team_subscriptions ts ON ts.alipay_subscription_id=s.alipay_subscription_id
       LEFT JOIN billing_team_members tm ON tm.team_id=ts.team_id AND tm.user_id=$1 AND tm.status='active'
       WHERE s.quarantined_at IS NULL AND (s.user_id=$1 OR tm.user_id=$1)
       ORDER BY CASE s.status WHEN 'active' THEN 1 WHEN 'trialing' THEN 2 WHEN 'past_due' THEN 3 WHEN 'paused' THEN 4 ELSE 5 END,
                s.updated_at DESC LIMIT 1`, [userId],
    )).rows[0] as JsonRecord | undefined;
    const account = (await this.pool.query(
      `SELECT (
         EXISTS (SELECT 1 FROM notes WHERE user_id=$1) OR
         EXISTS (SELECT 1 FROM write_agent_threads WHERE user_id=$1) OR
         EXISTS (SELECT 1 FROM write_canvas_projects WHERE user_id=$1)
       ) AS "hasWritingHistory",
       EXISTS (SELECT 1 FROM alipay_billing_customers WHERE user_id=$1) AS "hasBillingCustomer"`, [userId],
    )).rows[0] as JsonRecord;
    const status = asString(subscription?.status);
    const full = status === "active" || status === "trialing";
    const history = account.hasWritingHistory === true;
    return {
      access: full ? "full" : history ? "read_only" : "none",
      subscriptionStatus: status === "incomplete" || status === "expired" ? null : status,
      planCode: asString(subscription?.planCode),
      currentPeriodEndsAt: subscription?.currentPeriodEndsAt instanceof Date ? subscription.currentPeriodEndsAt.toISOString() : asString(subscription?.currentPeriodEndsAt),
      scheduledChange: subscription?.cancelAtPeriodEnd === true ? { action: "cancel", effectiveAt: subscription.currentPeriodEndsAt } : subscription?.pendingQuantity ? { action: "quantity_change", quantity: Number(subscription.pendingQuantity) } : null,
      paymentActionRequired: status === "past_due",
      hasWritingHistory: history,
      hasBillingCustomer: account.hasBillingCustomer === true,
      quantity: Number(subscription?.quantity || 1),
      pendingQuantity: subscription?.pendingQuantity ? Number(subscription.pendingQuantity) : null,
    };
  }

  async createPortal() {
    return { url: "/?view=write&billing=manage", local: true };
  }

  async cancelSubscription(userId: number) {
    const row = (await this.pool.query(
      `SELECT alipay_subscription_id AS "subscriptionId" FROM alipay_billing_subscriptions
       WHERE user_id=$1 AND quarantined_at IS NULL AND status IN ('active','trialing','past_due','paused')
       ORDER BY updated_at DESC LIMIT 1`, [userId],
    )).rows[0] as JsonRecord | undefined;
    if (!row?.subscriptionId) throw new BillingError(404, "BILLING_SUBSCRIPTION_NOT_FOUND", "没有可取消的订阅");
    await this.exec("alipay.trade.subscription.modify", {
      subscription_id: String(row.subscriptionId), modify_type: "CANCEL", cancel_at_period_end: true,
    });
    await this.reconcileUser(userId);
    return { success: true, pending: true };
  }

  async changeTeamQuantity(userId: number, targetQuantity: number) {
    if (!Number.isSafeInteger(targetQuantity) || targetQuantity < 2 || targetQuantity > 1000) {
      throw new BillingError(400, "INVALID_TEAM_QUANTITY", "团队席位数必须为 2–1000 的整数");
    }
    const row = (await this.pool.query(
      `SELECT alipay_subscription_id AS "subscriptionId", item_id AS "itemId", quantity
       FROM alipay_billing_subscriptions WHERE user_id=$1 AND plan_code IN ('team_monthly','team_yearly')
         AND quarantined_at IS NULL AND status IN ('active','trialing') ORDER BY updated_at DESC LIMIT 1`, [userId],
    )).rows[0] as JsonRecord | undefined;
    if (!row?.subscriptionId || !row.itemId) throw new BillingError(404, "TEAM_SUBSCRIPTION_NOT_FOUND", "没有可调整的团队订阅");
    const sourceQuantity = Number(row.quantity);
    if (sourceQuantity === targetQuantity) return { success: true, quantity: sourceQuantity, pending: false };
    const increase = targetQuantity > sourceQuantity;
    if (!increase) {
      const occupied = Number((await this.pool.query(
        `SELECT COUNT(*)::int AS count FROM billing_team_members m
         JOIN billing_teams t ON t.id=m.team_id WHERE t.owner_user_id=$1 AND m.status='active'`, [userId],
      )).rows[0]?.count || 0);
      if (targetQuantity < occupied) throw new BillingError(409, "TEAM_SEATS_IN_USE", `当前有 ${occupied} 个已占用席位，请先移除成员`);
    }
    const response = await this.exec("alipay.trade.subscription.modify", {
      subscription_id: String(row.subscriptionId),
      modify_type: increase ? "INCREASE_QUANTITY" : "DECREASE_QUANTITY",
      ...(increase ? { preserve_billing_cycle: true } : {}),
      items: [{ item_id: String(row.itemId), source_quantity: sourceQuantity, target_quantity: targetQuantity }],
      description: increase ? "AtomFlow 团队席位扩容" : "AtomFlow 团队席位缩容",
    });
    const checkoutUrl = asString(pick(response, "alipay_schema", "alipaySchema") ?? pick(response, "alipay_jump_schema", "alipayJumpSchema"));
    await this.reconcileUser(userId);
    return { success: true, quantity: targetQuantity, pending: !increase, checkoutUrl };
  }

  async getTeam(userId: number) {
    const team = (await this.pool.query(
      `SELECT t.id, t.name, t.owner_user_id AS "ownerUserId", s.quantity, s.pending_quantity AS "pendingQuantity"
       FROM billing_teams t
       JOIN alipay_team_subscriptions ts ON ts.team_id=t.id
       JOIN alipay_billing_subscriptions s ON s.alipay_subscription_id=ts.alipay_subscription_id
       WHERE t.owner_user_id=$1 AND s.quarantined_at IS NULL AND s.status IN ('active','trialing','past_due','paused')`, [userId],
    )).rows[0] as JsonRecord | undefined;
    if (!team) throw new BillingError(404, "TEAM_NOT_FOUND", "当前账户没有可管理的团队订阅");
    const members = (await this.pool.query(
      `SELECT m.user_id AS "userId", u.email, u.nickname, m.role
       FROM billing_team_members m JOIN users u ON u.id=m.user_id
       WHERE m.team_id=$1 AND m.status='active' ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END, m.created_at`, [team.id],
    )).rows;
    return { ...team, members };
  }

  async addTeamMember(userId: number, email: string) {
    const normalizedEmail = email.trim().toLowerCase();
    if (!isValidEmailAddress(normalizedEmail)) throw new BillingError(400, "INVALID_EMAIL", "请输入有效的成员邮箱");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`atomflow-team-owner:${userId}`]);
      const team = (await client.query(
        `SELECT t.id, s.quantity
         FROM billing_teams t JOIN alipay_team_subscriptions ts ON ts.team_id=t.id
         JOIN alipay_billing_subscriptions s ON s.alipay_subscription_id=ts.alipay_subscription_id
         WHERE t.owner_user_id=$1 AND s.quarantined_at IS NULL AND s.status IN ('active','trialing')`, [userId],
      )).rows[0] as JsonRecord | undefined;
      if (!team) throw new BillingError(404, "TEAM_NOT_FOUND", "当前账户没有有效的团队订阅");
      const member = (await client.query(`SELECT id FROM users WHERE lower(email)=$1`, [normalizedEmail])).rows[0] as JsonRecord | undefined;
      if (!member?.id) throw new BillingError(404, "TEAM_MEMBER_ACCOUNT_REQUIRED", "该邮箱尚未注册 AtomFlow，请让成员先注册账号");
      const ownSubscription = await client.query(
        `SELECT 1 FROM alipay_billing_subscriptions WHERE user_id=$1 AND quarantined_at IS NULL AND status IN ('active','trialing','past_due','paused') LIMIT 1`, [member.id],
      );
      if (ownSubscription.rowCount) throw new BillingError(409, "TEAM_MEMBER_HAS_SUBSCRIPTION", "该成员已有个人或团队订阅，不能重复占席");
      const occupied = Number((await client.query(
        `SELECT COUNT(*)::int AS count FROM billing_team_members WHERE team_id=$1 AND status='active'`, [team.id],
      )).rows[0]?.count || 0);
      if (occupied >= Number(team.quantity)) throw new BillingError(409, "TEAM_SEAT_LIMIT_REACHED", "团队席位已用满，请先扩容");
      const otherTeam = await client.query(
        `SELECT 1 FROM billing_team_members WHERE user_id=$1 AND status='active' AND team_id<>$2 LIMIT 1`, [member.id, team.id],
      );
      if (otherTeam.rowCount) throw new BillingError(409, "TEAM_MEMBER_ALREADY_ASSIGNED", "该成员已加入其他团队");
      await client.query(
        `INSERT INTO billing_team_members (team_id,user_id,role,status) VALUES ($1,$2,'member','active')
         ON CONFLICT (team_id,user_id) DO UPDATE SET status='active', updated_at=NOW()`, [team.id, member.id],
      );
      await client.query("COMMIT");
      return this.getTeam(userId);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async removeTeamMember(userId: number, memberUserId: number) {
    if (!Number.isSafeInteger(memberUserId) || memberUserId <= 0 || memberUserId === userId) {
      throw new BillingError(400, "INVALID_TEAM_MEMBER", "不能移除团队所有者");
    }
    const result = await this.pool.query(
      `UPDATE billing_team_members m SET status='removed', updated_at=NOW()
       FROM billing_teams t WHERE m.team_id=t.id AND t.owner_user_id=$1 AND m.user_id=$2 AND m.role='member' AND m.status='active'`,
      [userId, memberUserId],
    );
    if (!result.rowCount) throw new BillingError(404, "TEAM_MEMBER_NOT_FOUND", "团队成员不存在");
    return this.getTeam(userId);
  }

  async deleteAccountUnderBillingLock(
    userId: number,
    prepareLocalDeletion: (client: pg.PoolClient) => Promise<void>,
    deleteLocalAccount: (client: pg.PoolClient) => Promise<void>,
  ) {
    const active = (await this.pool.query(
      `SELECT alipay_subscription_id AS "subscriptionId" FROM alipay_billing_subscriptions
       WHERE user_id=$1 AND status IN ('active','trialing','past_due','paused') AND quarantined_at IS NULL`, [userId],
    )).rows as JsonRecord[];
    if (active.length && !this.config.enabled) throw new BillingError(503, "BILLING_DISABLED_ACCOUNT_REVIEW_REQUIRED", "检测到支付宝订阅，收费关闭期间不能自动注销，请联系支持");
    for (const row of active) {
      await this.exec("alipay.trade.subscription.modify", {
        subscription_id: String(row.subscriptionId), modify_type: "CANCEL", cancel_at_period_end: false,
      });
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`atomflow-alipay-user:${userId}`]);
      await prepareLocalDeletion(client);
      await deleteLocalAccount(client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async recordUsage(userId: number, operationKey: string, operationType: string) {
    if (!this.config.enabled) return;
    await this.pool.query(
      `INSERT INTO billing_usage_events (environment,user_id,operation_key,operation_type)
       VALUES ('production',$1,$2,$3)
       ON CONFLICT (environment,user_id,operation_key) WHERE user_id IS NOT NULL DO NOTHING`,
      [userId, operationKey.slice(0, 200), operationType.slice(0, 80)],
    );
  }

  startWorkers() {
    if (!this.config.enabled || this.reconcileTimer) return;
    this.reconcileTimer = setInterval(() => void (async () => {
      const users = (await this.pool.query(
        `SELECT DISTINCT user_id FROM (
           SELECT user_id FROM alipay_billing_subscriptions WHERE user_id IS NOT NULL AND status IN ('active','trialing','past_due','paused')
           UNION SELECT user_id FROM alipay_billing_checkout_attempts WHERE user_id IS NOT NULL AND status='pending'
         ) candidates LIMIT 100`,
      )).rows as Array<{ user_id: number }>;
      for (const user of users) await this.reconcileUser(user.user_id);
    })().catch(error => this.logger.error({ err: error, module: "alipay-reconcile" }, "Alipay reconciliation failed")), 15 * 60_000);
    this.reconcileTimer.unref();
  }
}
