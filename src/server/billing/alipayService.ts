import { createHash, randomUUID } from "node:crypto";
import { AlipaySdk, AlipayRequestError } from "alipay-sdk";
import type pg from "pg";
import type { AlipayBillingConfig, AlipayBillingPlan, AlipayPlanCode } from "./alipayConfig.js";
import { BillingError, type BillingLogger } from "./types.js";

type JsonRecord = Record<string, unknown>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAID_TRADE_STATUSES = new Set(["TRADE_SUCCESS", "TRADE_FINISHED"]);
const CLOSED_TRADE_STATUSES = new Set(["TRADE_CLOSED"]);
const asRecord = (value: unknown): JsonRecord => value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
const asString = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
const pick = (record: JsonRecord, snake: string, camel: string) => record[snake] ?? record[camel];
const parseDate = (value: unknown): string | null => {
  const text = asString(value);
  if (!text) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? `${text.replace(" ", "T")}+08:00` : text;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
};
export const parseAlipayMoneyToCents = (value: unknown): number | null => {
  const text = typeof value === "number" ? value.toFixed(2) : String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const [yuan, fraction = ""] = text.split(".");
  const cents = Number(yuan) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
};

type NormalizedTrade = {
  outTradeNo: string;
  tradeNo: string;
  tradeStatus: string;
  totalAmountCents: number;
  refundAmountCents: number | null;
  appId: string | null;
  sellerId: string | null;
  paidAt: string | null;
};

export const normalizeAlipayTrade = (input: unknown): NormalizedTrade | null => {
  const raw = asRecord(input);
  const outTradeNo = asString(pick(raw, "out_trade_no", "outTradeNo"));
  const tradeNo = asString(pick(raw, "trade_no", "tradeNo"));
  const tradeStatus = String(pick(raw, "trade_status", "tradeStatus") || "").toUpperCase();
  const totalAmountCents = parseAlipayMoneyToCents(pick(raw, "total_amount", "totalAmount"));
  if (!outTradeNo || !tradeNo || !tradeStatus || totalAmountCents === null) return null;
  return {
    outTradeNo,
    tradeNo,
    tradeStatus,
    totalAmountCents,
    refundAmountCents: parseAlipayMoneyToCents(
      pick(raw, "refund_amount", "refundAmount") ?? pick(raw, "refund_fee", "refundFee"),
    ),
    appId: asString(pick(raw, "app_id", "appId")),
    sellerId: asString(pick(raw, "seller_id", "sellerId")),
    paidAt: parseDate(pick(raw, "gmt_payment", "gmtPayment") ?? pick(raw, "send_pay_date", "sendPayDate")),
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
    if (!this.config.enabled || !this.sdk) throw new BillingError(503, "BILLING_UNAVAILABLE", "支付宝收款暂未启用");
    return this.sdk;
  }

  private apiParams(bizContent: JsonRecord, common: JsonRecord = {}): JsonRecord {
    return { bizContent, ...common, ...(this.config.appAuthToken ? { appAuthToken: this.config.appAuthToken } : {}) };
  }

  private async exec(method: string, bizContent: JsonRecord, common: JsonRecord = {}): Promise<JsonRecord> {
    try {
      const result = asRecord(await this.requireSdk().exec(method, this.apiParams(bizContent, common), { validateSign: true }));
      if (String(result.code) !== "10000") {
        throw new BillingError(
          502,
          String(pick(result, "sub_code", "subCode") || "ALIPAY_API_ERROR"),
          String(pick(result, "sub_msg", "subMsg") || result.msg || "支付宝请求失败"),
        );
      }
      return result;
    } catch (error) {
      if (error instanceof BillingError) throw error;
      const code = error instanceof AlipayRequestError ? error.code : undefined;
      this.logger.error({ err: error, module: "alipay-api", method, code }, "Alipay API request failed");
      throw new BillingError(503, "ALIPAY_API_UNAVAILABLE", "支付宝暂时无法响应，请勿重复付款，稍后重新检查");
    }
  }

  async getValidatedPlans(): Promise<readonly AlipayBillingPlan[]> {
    return this.config.plans;
  }

  private plan(planCode: AlipayPlanCode): AlipayBillingPlan {
    const plan = this.config.plans.find(candidate => candidate.code === planCode);
    if (!plan) throw new BillingError(400, "INVALID_BILLING_PLAN", "该套餐尚未开放");
    return plan;
  }

  private assertTrustedTrade(trade: NormalizedTrade, expectedAmountCents: number) {
    if (trade.appId && trade.appId !== this.config.appId) throw new BillingError(400, "ALIPAY_APP_MISMATCH", "支付宝应用不匹配");
    if (trade.sellerId && trade.sellerId !== this.config.sellerId) throw new BillingError(400, "ALIPAY_SELLER_MISMATCH", "支付宝收款方不匹配");
    if (trade.totalAmountCents !== expectedAmountCents) throw new BillingError(400, "ALIPAY_AMOUNT_MISMATCH", "支付宝订单金额不匹配");
  }

  async createCheckout(userId: number, _email: string, planCode: AlipayPlanCode, requestId: string) {
    if (!UUID_PATTERN.test(requestId)) throw new BillingError(400, "INVALID_REQUEST_ID", "requestId 必须是 UUID");
    const plan = this.plan(planCode);
    const expectedAmountCents = Math.round(plan.priceCny * 100);
    const client = await this.pool.connect();
    let outTradeNo = "";
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`atomflow-alipay-user:${userId}`]);
      const same = (await client.query(
        `SELECT plan_code AS "planCode", checkout_url AS "checkoutUrl", out_trade_no AS "outTradeNo", status
         FROM alipay_one_time_orders WHERE user_id=$1 AND request_id=$2`, [userId, requestId],
      )).rows[0] as JsonRecord | undefined;
      if (same) {
        if (same.planCode !== planCode) throw new BillingError(409, "BILLING_IDEMPOTENCY_CONFLICT", "同一 requestId 不能用于不同套餐");
        if (same.checkoutUrl && (same.status === "creating" || same.status === "pending")) {
          await client.query("COMMIT");
          return { provider: "alipay", checkoutUrl: String(same.checkoutUrl), requestId, outTradeNo: String(same.outTradeNo) };
        }
        throw new BillingError(409, same.status === "paid" ? "BILLING_ORDER_ALREADY_PAID" : "BILLING_CHECKOUT_PENDING", "该付款请求已处理，请刷新会员状态");
      }
      const pending = await client.query(
        `SELECT 1 FROM alipay_one_time_orders WHERE user_id=$1 AND status IN ('creating','pending') LIMIT 1`, [userId],
      );
      if (pending.rowCount) throw new BillingError(409, "BILLING_CHECKOUT_PENDING", "当前已有付款正在确认中");
      outTradeNo = `AFMWP${Date.now()}${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      await client.query(
        `INSERT INTO alipay_one_time_orders (id,user_id,request_id,plan_code,out_trade_no,total_amount_cents,status)
         VALUES ($1,$2,$3,$4,$5,$6,'creating')`,
        [randomUUID(), userId, requestId, planCode, outTradeNo, expectedAmountCents],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    try {
      const checkoutUrl = this.requireSdk().pageExec("alipay.trade.page.pay", "GET", {
        bizContent: {
          out_trade_no: outTradeNo,
          total_amount: plan.priceCny.toFixed(2),
          subject: plan.name,
          body: "固定期限使用权，到期后可手动续费，不自动扣款",
          product_code: "FAST_INSTANT_TRADE_PAY",
          timeout_express: "30m",
        },
        notifyUrl: this.config.notifyUrl,
        returnUrl: this.config.returnUrl,
        ...(this.config.appAuthToken ? { appAuthToken: this.config.appAuthToken } : {}),
      });
      if (!/^https:\/\/openapi\.alipay\.com\/gateway\.do\?/i.test(checkoutUrl)) {
        throw new BillingError(502, "ALIPAY_CHECKOUT_INVALID", "支付宝未返回有效付款链接");
      }
      await this.pool.query(
        `UPDATE alipay_one_time_orders SET checkout_url=$1,status='pending',updated_at=NOW()
         WHERE user_id=$2 AND request_id=$3 AND status='creating'`, [checkoutUrl, userId, requestId],
      );
      return { provider: "alipay", checkoutUrl, requestId, outTradeNo };
    } catch (error) {
      await this.pool.query(
        `UPDATE alipay_one_time_orders SET status='failed',error_code=$1,updated_at=NOW()
         WHERE user_id=$2 AND request_id=$3 AND status='creating'`,
        [error instanceof BillingError ? error.code : "ALIPAY_CREATE_FAILED", userId, requestId],
      );
      throw error;
    }
  }

  private async recomputeEntitlement(client: pg.PoolClient, userId: number) {
    const timeline = (await client.query(
      `WITH RECURSIVE paid_orders AS (
         SELECT id,plan_code,paid_at,
                ROW_NUMBER() OVER (ORDER BY paid_at,id) AS sequence
         FROM alipay_one_time_orders
         WHERE user_id=$1 AND status='paid' AND paid_at IS NOT NULL
       ), entitlement_timeline AS (
         SELECT id,plan_code,sequence,paid_at AS access_start,
                paid_at + CASE WHEN plan_code='pro_yearly' THEN INTERVAL '1 year' ELSE INTERVAL '1 month' END AS access_end
         FROM paid_orders WHERE sequence=1
         UNION ALL
         SELECT next_order.id,next_order.plan_code,next_order.sequence,
                GREATEST(previous.access_end,next_order.paid_at) AS access_start,
                GREATEST(previous.access_end,next_order.paid_at)
                  + CASE WHEN next_order.plan_code='pro_yearly' THEN INTERVAL '1 year' ELSE INTERVAL '1 month' END AS access_end
         FROM entitlement_timeline previous
         JOIN paid_orders next_order ON next_order.sequence=previous.sequence+1
       ), updated_orders AS (
         UPDATE alipay_one_time_orders order_row
         SET entitlement_starts_at=timeline.access_start,
             entitlement_ends_at=timeline.access_end,
             updated_at=NOW()
         FROM entitlement_timeline timeline
         WHERE order_row.id=timeline.id
         RETURNING order_row.id
       )
       SELECT id AS "lastOrderId",plan_code AS "planCode",access_end AS "accessEndsAt",
              (SELECT access_start FROM entitlement_timeline ORDER BY sequence LIMIT 1) AS "accessStartsAt"
       FROM entitlement_timeline ORDER BY sequence DESC LIMIT 1`,
      [userId],
    )).rows[0] as JsonRecord | undefined;
    await client.query(
      `UPDATE alipay_one_time_orders SET entitlement_starts_at=NULL,entitlement_ends_at=NULL,updated_at=NOW()
       WHERE user_id=$1 AND status<>'paid' AND (entitlement_starts_at IS NOT NULL OR entitlement_ends_at IS NOT NULL)`,
      [userId],
    );
    if (!timeline?.lastOrderId) {
      await client.query(`DELETE FROM alipay_one_time_entitlements WHERE user_id=$1`, [userId]);
      return;
    }
    await client.query(
      `INSERT INTO alipay_one_time_entitlements
         (user_id,plan_code,access_starts_at,access_ends_at,last_order_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id) DO UPDATE SET
         plan_code=EXCLUDED.plan_code,access_starts_at=EXCLUDED.access_starts_at,
         access_ends_at=EXCLUDED.access_ends_at,last_order_id=EXCLUDED.last_order_id,updated_at=NOW()`,
      [userId, timeline.planCode, timeline.accessStartsAt, timeline.accessEndsAt, timeline.lastOrderId],
    );
  }

  private async fulfillOrder(trade: NormalizedTrade, source: "notification" | "query") {
    if (!PAID_TRADE_STATUSES.has(trade.tradeStatus)) return false;
    if (!trade.paidAt) throw new BillingError(400, "ALIPAY_PAYMENT_TIME_INVALID", "支付宝交易缺少有效付款时间");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const initialOrder = (await client.query(
        `SELECT user_id AS "userId" FROM alipay_one_time_orders WHERE out_trade_no=$1`, [trade.outTradeNo],
      )).rows[0] as JsonRecord | undefined;
      if (!initialOrder?.userId) throw new BillingError(404, "ALIPAY_ORDER_NOT_FOUND", "支付宝订单未关联 AtomFlow 账户");
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`atomflow-alipay-user:${initialOrder.userId}`]);
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`atomflow-alipay-order:${trade.outTradeNo}`]);
      const order = (await client.query(
        `SELECT id,user_id AS "userId",plan_code AS "planCode",total_amount_cents AS "totalAmountCents",
                alipay_trade_no AS "alipayTradeNo",status
         FROM alipay_one_time_orders WHERE out_trade_no=$1 FOR UPDATE`, [trade.outTradeNo],
      )).rows[0] as JsonRecord | undefined;
      if (!order?.id || !order.userId) throw new BillingError(404, "ALIPAY_ORDER_NOT_FOUND", "支付宝订单未关联 AtomFlow 账户");
      this.assertTrustedTrade(trade, Number(order.totalAmountCents));
      if (order.status === "refunded") {
        await client.query("COMMIT");
        return false;
      }
      if (order.status === "paid") {
        if (order.alipayTradeNo !== trade.tradeNo) throw new BillingError(409, "ALIPAY_TRADE_MISMATCH", "订单已由其他支付宝交易完成");
        await client.query("COMMIT");
        return true;
      }
      const duplicate = await client.query(
        `SELECT 1 FROM alipay_one_time_orders WHERE alipay_trade_no=$1 AND id<>$2 LIMIT 1`, [trade.tradeNo, order.id],
      );
      if (duplicate.rowCount) throw new BillingError(409, "ALIPAY_TRADE_REUSED", "支付宝交易号已用于其他订单");
      await client.query(
        `UPDATE alipay_one_time_orders SET status='paid',alipay_trade_no=$1,paid_at=$2,
           refund_amount_cents=COALESCE($3,refund_amount_cents),checkout_url=NULL,error_code=NULL,updated_at=NOW()
         WHERE id=$4`,
        [trade.tradeNo, trade.paidAt, trade.refundAmountCents, order.id],
      );
      await this.recomputeEntitlement(client, Number(order.userId));
      await client.query("COMMIT");
      this.logger.info({ module: "alipay-payment", source, outTradeNo: trade.outTradeNo, userId: order.userId }, "Alipay payment granted a fixed-term entitlement");
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async markOrderRefunded(trade: NormalizedTrade, source: "notification" | "query") {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const initialOrder = (await client.query(
        `SELECT user_id AS "userId" FROM alipay_one_time_orders WHERE out_trade_no=$1`, [trade.outTradeNo],
      )).rows[0] as JsonRecord | undefined;
      if (!initialOrder?.userId) throw new BillingError(404, "ALIPAY_ORDER_NOT_FOUND", "支付宝订单未关联 AtomFlow 账户");
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`atomflow-alipay-user:${initialOrder.userId}`]);
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`atomflow-alipay-order:${trade.outTradeNo}`]);
      const order = (await client.query(
        `SELECT id,user_id AS "userId",total_amount_cents AS "totalAmountCents",
                alipay_trade_no AS "alipayTradeNo",status
         FROM alipay_one_time_orders WHERE out_trade_no=$1 FOR UPDATE`, [trade.outTradeNo],
      )).rows[0] as JsonRecord | undefined;
      if (!order?.id || !order.userId) throw new BillingError(404, "ALIPAY_ORDER_NOT_FOUND", "支付宝订单未关联 AtomFlow 账户");
      this.assertTrustedTrade(trade, Number(order.totalAmountCents));
      if (trade.refundAmountCents === null || trade.refundAmountCents < Number(order.totalAmountCents)) {
        throw new BillingError(409, "ALIPAY_REFUND_NOT_FULL", "仅全额退款可撤销完整使用期");
      }
      if (order.alipayTradeNo && order.alipayTradeNo !== trade.tradeNo) {
        throw new BillingError(409, "ALIPAY_TRADE_MISMATCH", "退款交易与原订单不匹配");
      }
      if (order.status !== "refunded") {
        await client.query(
          `UPDATE alipay_one_time_orders SET status='refunded',refund_amount_cents=$1,refunded_at=NOW(),
             checkout_url=NULL,error_code=NULL,updated_at=NOW() WHERE id=$2`,
          [trade.refundAmountCents, order.id],
        );
        await this.recomputeEntitlement(client, Number(order.userId));
      }
      await client.query("COMMIT");
      this.logger.info({ module: "alipay-payment", source, outTradeNo: trade.outTradeNo, userId: order.userId }, "Alipay full refund revoked the order entitlement");
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async applyTradeState(trade: NormalizedTrade, source: "notification" | "query", expectedAmountCents: number) {
    this.assertTrustedTrade(trade, expectedAmountCents);
    if (trade.refundAmountCents !== null && trade.refundAmountCents >= expectedAmountCents) {
      return this.markOrderRefunded(trade, source);
    }
    if (trade.refundAmountCents !== null) {
      await this.pool.query(
        `UPDATE alipay_one_time_orders SET refund_amount_cents=GREATEST(COALESCE(refund_amount_cents,0),$1),updated_at=NOW()
         WHERE out_trade_no=$2 AND alipay_trade_no=$3 AND status='paid'`,
        [trade.refundAmountCents, trade.outTradeNo, trade.tradeNo],
      );
    }
    if (PAID_TRADE_STATUSES.has(trade.tradeStatus)) return this.fulfillOrder(trade, source);
    if (CLOSED_TRADE_STATUSES.has(trade.tradeStatus)) {
      await this.pool.query(
        `UPDATE alipay_one_time_orders SET status='closed',checkout_url=NULL,updated_at=NOW()
         WHERE out_trade_no=$1 AND status IN ('creating','pending')`,
        [trade.outTradeNo],
      );
      return true;
    }
    return false;
  }

  async receiveNotification(params: Record<string, unknown>) {
    if (!this.requireSdk().checkNotifySignV2(params)) throw new BillingError(400, "ALIPAY_SIGNATURE_INVALID", "支付宝通知签名无效");
    const trade = normalizeAlipayTrade(params);
    const notifyId = asString(params.notify_id) || createHash("sha256")
      .update(JSON.stringify({ outTradeNo: trade?.outTradeNo, tradeNo: trade?.tradeNo, status: trade?.tradeStatus, notifyTime: params.notify_time }))
      .digest("hex");
    const occurredAt = parseDate(params.notify_time) || new Date().toISOString();
    const eventType = asString(params.notify_type) || "trade_status_sync";
    const payload = JSON.stringify({
      out_trade_no: trade?.outTradeNo,
      trade_no: trade?.tradeNo,
      trade_status: trade?.tradeStatus,
      total_amount_cents: trade?.totalAmountCents,
      refund_amount_cents: trade?.refundAmountCents,
      app_id: trade?.appId,
      seller_id: trade?.sellerId,
      notify_time: params.notify_time,
    });
    const storeNotification = async (processingStatus: "processed" | "ignored" | "quarantined" | "failed", errorMessage?: string) => {
      await this.pool.query(
        `INSERT INTO alipay_payment_notifications
           (notify_id,event_type,out_trade_no,trade_no,occurred_at,normalized_payload,processing_status,error_message)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
         ON CONFLICT (notify_id) DO UPDATE SET
           processing_status=EXCLUDED.processing_status,error_message=EXCLUDED.error_message`,
        [notifyId, eventType, trade?.outTradeNo || null, trade?.tradeNo || null, occurredAt, payload, processingStatus, errorMessage || null],
      );
    };
    if (!trade) {
      await storeNotification("quarantined", "invalid trade payload");
      throw new BillingError(400, "ALIPAY_NOTIFICATION_INVALID", "支付宝通知缺少订单字段");
    }
    if (trade.appId !== this.config.appId || trade.sellerId !== this.config.sellerId) {
      await storeNotification("quarantined", "app or seller mismatch");
      throw new BillingError(400, "ALIPAY_NOTIFICATION_UNTRUSTED", "支付宝通知商户信息不匹配");
    }
    try {
      const order = (await this.pool.query(
        `SELECT total_amount_cents AS "totalAmountCents" FROM alipay_one_time_orders WHERE out_trade_no=$1`,
        [trade.outTradeNo],
      )).rows[0] as JsonRecord | undefined;
      if (!order) throw new BillingError(404, "ALIPAY_ORDER_NOT_FOUND", "支付宝订单未关联 AtomFlow 账户");
      const applied = await this.applyTradeState(trade, "notification", Number(order.totalAmountCents));
      await storeNotification(applied ? "processed" : "ignored");
    } catch (error) {
      await storeNotification(error instanceof BillingError && error.status < 500 ? "quarantined" : "failed", error instanceof Error ? error.message.slice(0, 500) : "notification processing failed");
      throw error;
    }
  }

  private async reconcileOrder(order: JsonRecord) {
    try {
      const response = await this.exec("alipay.trade.query", { out_trade_no: String(order.outTradeNo) });
      const trade = normalizeAlipayTrade(response);
      if (!trade) throw new BillingError(502, "ALIPAY_QUERY_INVALID", "支付宝订单查询结果不完整");
      await this.applyTradeState(trade, "query", Number(order.totalAmountCents));
      await this.pool.query(
        `UPDATE alipay_one_time_orders SET last_reconciled_at=NOW() WHERE out_trade_no=$1`,
        [order.outTradeNo],
      );
    } catch (error) {
      if (error instanceof BillingError && (error.code === "ACQ.TRADE_NOT_EXIST" || error.code === "TRADE_NOT_EXIST")) {
        await this.pool.query(
          `UPDATE alipay_one_time_orders SET status='failed',error_code='ALIPAY_TRADE_NOT_FOUND',checkout_url=NULL,
             last_reconciled_at=NOW(),updated_at=NOW()
           WHERE out_trade_no=$1 AND status IN ('creating','pending') AND created_at < NOW()-INTERVAL '30 minutes'`, [order.outTradeNo],
        );
        return;
      }
      throw error;
    }
  }

  private async reconcileUser(userId: number) {
    if (!this.config.enabled) return;
    const orders = (await this.pool.query(
      `SELECT out_trade_no AS "outTradeNo",total_amount_cents AS "totalAmountCents"
       FROM alipay_one_time_orders WHERE user_id=$1 AND status IN ('creating','pending') ORDER BY created_at DESC LIMIT 2`, [userId],
    )).rows as JsonRecord[];
    for (const order of orders) await this.reconcileOrder(order);
  }

  async resolveMagicWritingAccess(userId: number) {
    const hasPending = (await this.pool.query(
      `SELECT 1 FROM alipay_one_time_orders WHERE user_id=$1 AND status IN ('creating','pending') LIMIT 1`, [userId],
    )).rowCount;
    if (hasPending && this.config.enabled) await this.reconcileUser(userId).catch(error => {
      this.logger.warn({ err: error, module: "alipay-reconcile", userId }, "Unable to reconcile pending Alipay payment");
    });
    const entitlement = (await this.pool.query(
      `SELECT plan_code AS "planCode",access_starts_at AS "accessStartsAt",access_ends_at AS "accessEndsAt",
              access_ends_at > NOW() AS active
       FROM alipay_one_time_entitlements WHERE user_id=$1`, [userId],
    )).rows[0] as JsonRecord | undefined;
    const latestOrder = (await this.pool.query(
      `SELECT request_id AS "requestId",status FROM alipay_one_time_orders
       WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [userId],
    )).rows[0] as JsonRecord | undefined;
    const account = (await this.pool.query(
      `SELECT (
         EXISTS (SELECT 1 FROM notes WHERE user_id=$1) OR
         EXISTS (SELECT 1 FROM write_agent_threads WHERE user_id=$1) OR
         EXISTS (SELECT 1 FROM write_canvas_projects WHERE user_id=$1)
       ) AS "hasWritingHistory",
       EXISTS (SELECT 1 FROM alipay_one_time_orders WHERE user_id=$1) AS "hasPurchaseHistory"`, [userId],
    )).rows[0] as JsonRecord;
    const full = entitlement?.active === true;
    const pendingCheckout = Boolean((await this.pool.query(
      `SELECT 1 FROM alipay_one_time_orders WHERE user_id=$1 AND status IN ('creating','pending') LIMIT 1`, [userId],
    )).rowCount);
    const history = account.hasWritingHistory === true;
    const accessEndsAt = entitlement?.accessEndsAt instanceof Date ? entitlement.accessEndsAt.toISOString() : asString(entitlement?.accessEndsAt);
    return {
      access: full ? "full" : history ? "read_only" : "none",
      subscriptionStatus: full ? "active" : entitlement ? "canceled" : null,
      planCode: asString(entitlement?.planCode),
      currentPeriodEndsAt: accessEndsAt,
      entitlementEndsAt: accessEndsAt,
      billingMode: "prepaid_term",
      scheduledChange: null,
      paymentActionRequired: false,
      pendingCheckout,
      latestCheckoutRequestId: asString(latestOrder?.requestId),
      latestCheckoutStatus: asString(latestOrder?.status),
      hasWritingHistory: history,
      hasBillingCustomer: account.hasPurchaseHistory === true,
      hasPurchaseHistory: account.hasPurchaseHistory === true,
      quantity: 1,
      pendingQuantity: null,
    };
  }

  async createPortal() {
    return { url: "/?view=write&billing=manage", local: true };
  }

  async deleteAccountUnderBillingLock(
    userId: number,
    prepareLocalDeletion: (client: pg.PoolClient) => Promise<void>,
    deleteLocalAccount: (client: pg.PoolClient) => Promise<void>,
  ) {
    const claimClient = await this.pool.connect();
    try {
      await claimClient.query("BEGIN");
      await claimClient.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`atomflow-alipay-user:${userId}`]);
      await prepareLocalDeletion(claimClient);
      const pending = await claimClient.query(
        `SELECT 1 FROM alipay_one_time_orders WHERE user_id=$1 AND status IN ('creating','pending') LIMIT 1`,
        [userId],
      );
      await claimClient.query("COMMIT");
      if (pending.rowCount) {
        if (!this.config.enabled) {
          throw new BillingError(503, "BILLING_REVIEW_REQUIRED", "账户仍有支付宝付款待确认，请稍后重试注销");
        }
        await this.closePendingOrdersForDeletion(userId);
      }
    } catch (error) {
      await claimClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      claimClient.release();
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`atomflow-alipay-user:${userId}`]);
      await prepareLocalDeletion(client);
      const pending = await client.query(
        `SELECT 1 FROM alipay_one_time_orders WHERE user_id=$1 AND status IN ('creating','pending') LIMIT 1`,
        [userId],
      );
      if (pending.rowCount) {
        throw new BillingError(409, "BILLING_CHECKOUT_PENDING", "支付宝付款仍在处理中，账户尚未删除");
      }
      await deleteLocalAccount(client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async closePendingOrdersForDeletion(userId: number) {
    const orders = (await this.pool.query(
      `SELECT out_trade_no AS "outTradeNo",total_amount_cents AS "totalAmountCents",created_at AS "createdAt"
       FROM alipay_one_time_orders WHERE user_id=$1 AND status IN ('creating','pending') ORDER BY created_at`,
      [userId],
    )).rows as JsonRecord[];
    for (const order of orders) {
      await this.reconcileOrder(order);
      const current = (await this.pool.query(
        `SELECT status,created_at AS "createdAt" FROM alipay_one_time_orders WHERE user_id=$1 AND out_trade_no=$2`,
        [userId, order.outTradeNo],
      )).rows[0] as JsonRecord | undefined;
      if (!current || (current.status !== "creating" && current.status !== "pending")) continue;
      try {
        await this.exec("alipay.trade.close", { out_trade_no: String(order.outTradeNo) });
        await this.pool.query(
          `UPDATE alipay_one_time_orders SET status='closed',checkout_url=NULL,last_reconciled_at=NOW(),updated_at=NOW()
           WHERE user_id=$1 AND out_trade_no=$2 AND status IN ('creating','pending')`,
          [userId, order.outTradeNo],
        );
      } catch (error) {
        if (error instanceof BillingError && (error.code === "ACQ.TRADE_NOT_EXIST" || error.code === "TRADE_NOT_EXIST")) {
          const createdAt = current.createdAt instanceof Date ? current.createdAt.getTime() : Date.parse(String(current.createdAt));
          if (Number.isFinite(createdAt) && createdAt < Date.now() - 30 * 60_000) {
            await this.pool.query(
              `UPDATE alipay_one_time_orders SET status='failed',error_code='ALIPAY_TRADE_NOT_FOUND',checkout_url=NULL,
                 last_reconciled_at=NOW(),updated_at=NOW()
               WHERE user_id=$1 AND out_trade_no=$2 AND status IN ('creating','pending')`,
              [userId, order.outTradeNo],
            );
            continue;
          }
        }
        await this.reconcileOrder(order).catch(() => undefined);
        const stillPending = await this.pool.query(
          `SELECT 1 FROM alipay_one_time_orders WHERE user_id=$1 AND out_trade_no=$2 AND status IN ('creating','pending')`,
          [userId, order.outTradeNo],
        );
        if (stillPending.rowCount) {
          throw new BillingError(409, "BILLING_CHECKOUT_PENDING", "支付宝付款仍在处理中，请关闭付款后稍后重试注销");
        }
      }
    }
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
      const orders = (await this.pool.query(
        `SELECT orders.out_trade_no AS "outTradeNo",orders.total_amount_cents AS "totalAmountCents"
         FROM alipay_one_time_orders orders
         WHERE orders.status IN ('creating','pending')
            OR (orders.status='paid'
                AND EXISTS (
                  SELECT 1 FROM alipay_one_time_entitlements entitlement
                  WHERE entitlement.user_id=orders.user_id AND entitlement.access_ends_at > NOW()
                )
                AND (orders.last_reconciled_at IS NULL OR orders.last_reconciled_at < NOW()-INTERVAL '1 hour'))
         ORDER BY CASE WHEN orders.status IN ('creating','pending') THEN 0 ELSE 1 END,orders.created_at
         LIMIT 100`,
      )).rows as JsonRecord[];
      for (const order of orders) await this.reconcileOrder(order).catch(error => {
        this.logger.warn({ err: error, module: "alipay-reconcile", outTradeNo: order.outTradeNo }, "Alipay payment reconciliation failed");
      });
    })().catch(error => this.logger.error({ err: error, module: "alipay-reconcile" }, "Alipay reconciliation failed")), 5 * 60_000);
    this.reconcileTimer.unref();
  }
}
