export type BillingProvider = "paddle" | "alipay";
export type AlipayPlanCode = "pro_monthly" | "pro_yearly";

export type AlipayBillingPlan = {
  code: AlipayPlanCode;
  name: string;
  priceCny: number;
  interval: "month" | "year";
  currency: "CNY";
  audience: "individual";
  savingsCny?: number;
};

export type AlipayBillingConfig = {
  enabled: boolean;
  provider: "alipay";
  appId: string;
  sellerId: string;
  privateKey: string;
  alipayPublicKey: string;
  keyType: "PKCS1" | "PKCS8";
  appAuthToken: string;
  endpoint: "https://openapi.alipay.com";
  notifyUrl: string;
  returnUrl: string;
  plans: readonly AlipayBillingPlan[];
};

const required = (name: string) => process.env[name]?.trim() || "";
const normalizePem = (value: string) => value.replace(/\\n/g, "\n");

export const getBillingProvider = (): BillingProvider => {
  const value = required("BILLING_PROVIDER").toLowerCase();
  if (!value || value === "paddle") return "paddle";
  if (value === "alipay") return "alipay";
  throw new Error("BILLING_PROVIDER must be paddle or alipay");
};

export const loadAlipayBillingConfig = (isProduction: boolean, appUrl?: string): AlipayBillingConfig => {
  const enabled = required("BILLING_ENABLED").toLowerCase() === "true" && getBillingProvider() === "alipay";
  const appId = required("ALIPAY_APP_ID");
  const sellerId = required("ALIPAY_SELLER_ID");
  const privateKey = normalizePem(required("ALIPAY_APP_PRIVATE_KEY"));
  const alipayPublicKey = normalizePem(required("ALIPAY_PUBLIC_KEY"));
  const keyTypeValue = required("ALIPAY_KEY_TYPE") || "PKCS8";
  if (keyTypeValue !== "PKCS1" && keyTypeValue !== "PKCS8") {
    throw new Error("ALIPAY_KEY_TYPE must be PKCS1 or PKCS8");
  }
  const origin = (appUrl || required("APP_URL")).replace(/\/$/, "");
  const notifyUrl = required("ALIPAY_NOTIFY_URL") || (origin ? `${origin}/api/billing/webhooks/alipay` : "");
  const returnUrl = required("ALIPAY_RETURN_URL") || (origin ? `${origin}/?view=write&billing_return=alipay` : "");
  const plans: AlipayBillingPlan[] = [
    { code: "pro_monthly", name: "AtomFlow 魔法写作 Pro 月度使用权", priceCny: 39, interval: "month", currency: "CNY", audience: "individual" },
    { code: "pro_yearly", name: "AtomFlow 魔法写作 Pro 年度使用权", priceCny: 399, interval: "year", currency: "CNY", audience: "individual", savingsCny: 69 },
  ];

  if (enabled) {
    const missing = [
      ["ALIPAY_APP_ID", appId],
      ["ALIPAY_SELLER_ID", sellerId],
      ["ALIPAY_APP_PRIVATE_KEY", privateKey],
      ["ALIPAY_PUBLIC_KEY", alipayPublicKey],
      ["ALIPAY_NOTIFY_URL", notifyUrl],
      ["ALIPAY_RETURN_URL", returnUrl],
    ].filter(([, value]) => !value).map(([name]) => name);
    if (missing.length) throw new Error(`Alipay billing configuration is incomplete: ${missing.join(", ")}`);
    if (!isProduction) {
      // AI webpage payment uses the production gateway. Local development may
      // generate signed requests, but it must use an HTTPS public callback and
      // real merchant test orders.
      if (!/^https:\/\//i.test(notifyUrl)) throw new Error("ALIPAY_NOTIFY_URL must be public HTTPS when billing is enabled");
    }
    if (!/^https:\/\//i.test(returnUrl) || !/^https:\/\//i.test(notifyUrl)) {
      throw new Error("Alipay return and notification URLs must use HTTPS");
    }
  }

  return {
    enabled,
    provider: "alipay",
    appId,
    sellerId,
    privateKey,
    alipayPublicKey,
    keyType: keyTypeValue,
    appAuthToken: required("ALIPAY_APP_AUTH_TOKEN"),
    endpoint: "https://openapi.alipay.com",
    notifyUrl,
    returnUrl,
    plans,
  };
};

export const isAlipayPlanCode = (value: unknown): value is AlipayPlanCode => (
  value === "pro_monthly" || value === "pro_yearly"
);
