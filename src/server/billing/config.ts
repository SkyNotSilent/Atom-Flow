import { Environment } from "@paddle/paddle-node-sdk";
import type { BillingEnvironment, BillingPlan, BillingPlanCode } from "./types.js";
import { getBillingProvider } from "./alipayConfig.js";

export type BillingConfig = {
  enabled: boolean;
  environment: BillingEnvironment;
  sdkEnvironment: Environment;
  apiKey: string;
  webhookSecret: string;
  clientToken: string;
  productId: string;
  priceIds: Record<BillingPlanCode, string>;
  allowedPriceIds: ReadonlySet<string>;
  plans: readonly BillingPlan[];
};

const PLANS: readonly BillingPlan[] = [
  {
    code: "pro_monthly",
    name: "AtomFlow 魔法写作 Pro",
    priceCny: 39,
    interval: "month",
    currency: "CNY",
  },
  {
    code: "pro_yearly",
    name: "AtomFlow 魔法写作 Pro",
    priceCny: 399,
    interval: "year",
    currency: "CNY",
    savingsCny: 69,
  },
];

const required = (name: string) => process.env[name]?.trim() || "";

export const loadBillingConfig = (isProduction: boolean): BillingConfig => {
  const enabled = required("BILLING_ENABLED").toLowerCase() === "true" && getBillingProvider() === "paddle";
  const environmentValue = required("PADDLE_ENVIRONMENT") || "sandbox";
  if (environmentValue !== "sandbox" && environmentValue !== "production") {
    throw new Error("PADDLE_ENVIRONMENT must be sandbox or production");
  }
  const environment: BillingEnvironment = environmentValue;
  const clientEnvironment = required("VITE_PADDLE_ENVIRONMENT");
  const apiKey = required("PADDLE_API_KEY");
  const webhookSecret = required("PADDLE_WEBHOOK_SECRET");
  const clientToken = required("VITE_PADDLE_CLIENT_TOKEN");
  const productId = required("PADDLE_MAGIC_WRITE_PRODUCT_ID");
  const monthlyPriceId = required("PADDLE_MAGIC_WRITE_MONTHLY_PRICE_ID");
  const yearlyPriceId = required("PADDLE_MAGIC_WRITE_YEARLY_PRICE_ID");
  const legacyPriceIds = required("PADDLE_MAGIC_WRITE_LEGACY_PRICE_IDS")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);

  if (enabled) {
    const missing = [
      ["PADDLE_API_KEY", apiKey],
      ["PADDLE_WEBHOOK_SECRET", webhookSecret],
      ["VITE_PADDLE_ENVIRONMENT", clientEnvironment],
      ["VITE_PADDLE_CLIENT_TOKEN", clientToken],
      ["PADDLE_MAGIC_WRITE_PRODUCT_ID", productId],
      ["PADDLE_MAGIC_WRITE_MONTHLY_PRICE_ID", monthlyPriceId],
      ["PADDLE_MAGIC_WRITE_YEARLY_PRICE_ID", yearlyPriceId],
    ].filter(([, value]) => !value).map(([name]) => name);
    if (missing.length > 0) throw new Error(`Billing configuration is incomplete: ${missing.join(", ")}`);
    if (isProduction && environment !== "production") {
      throw new Error("Production billing must use PADDLE_ENVIRONMENT=production");
    }
    if (!isProduction && environment !== "sandbox") {
      throw new Error("Development and test billing must use PADDLE_ENVIRONMENT=sandbox");
    }
    if (clientEnvironment !== environment) {
      throw new Error("VITE_PADDLE_ENVIRONMENT must exactly match PADDLE_ENVIRONMENT");
    }
    const apiKeyMatchesEnvironment = environment === "sandbox"
      ? /^pdl_sdbx_apikey_/i.test(apiKey)
      : /^pdl_live_apikey_/i.test(apiKey);
    const clientTokenMatchesEnvironment = environment === "sandbox"
      ? /^test_/i.test(clientToken)
      : /^live_/i.test(clientToken);
    if (!apiKeyMatchesEnvironment || !clientTokenMatchesEnvironment) {
      throw new Error(`Paddle credentials do not match PADDLE_ENVIRONMENT=${environment}`);
    }
  }

  return {
    enabled,
    environment,
    sdkEnvironment: environment === "sandbox" ? Environment.sandbox : Environment.production,
    apiKey,
    webhookSecret,
    clientToken,
    productId,
    priceIds: { pro_monthly: monthlyPriceId, pro_yearly: yearlyPriceId },
    allowedPriceIds: new Set([monthlyPriceId, yearlyPriceId, ...legacyPriceIds].filter(Boolean)),
    plans: PLANS,
  };
};

export const isBillingPlanCode = (value: unknown): value is BillingPlanCode => (
  value === "pro_monthly" || value === "pro_yearly"
);
