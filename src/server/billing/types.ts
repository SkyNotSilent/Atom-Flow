export type BillingEnvironment = "sandbox" | "production";
export type BillingPlanCode = "pro_monthly" | "pro_yearly";
export type PaddleSubscriptionStatus = "active" | "trialing" | "past_due" | "paused" | "canceled";
export type MagicWritingAccess = "full" | "read_only" | "none";

export type BillingPlan = {
  code: BillingPlanCode;
  name: string;
  priceCny: number;
  interval: "month" | "year";
  currency: "CNY";
  savingsCny?: number;
};

export type BillingAccessResolution = {
  access: MagicWritingAccess;
  subscriptionStatus: PaddleSubscriptionStatus | null;
  planCode: BillingPlanCode | null;
  currentPeriodEndsAt: string | null;
  scheduledChange: Record<string, unknown> | null;
  paymentActionRequired: boolean;
  hasWritingHistory: boolean;
  hasBillingCustomer: boolean;
};

export class BillingError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BillingError";
  }
}

export type BillingLogger = {
  info: (bindings: Record<string, unknown>, message: string) => void;
  warn: (bindings: Record<string, unknown>, message: string) => void;
  error: (bindings: Record<string, unknown>, message: string) => void;
};
