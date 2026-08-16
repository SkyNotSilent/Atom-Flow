import type { BillingPlanCode } from '../types';

const STORAGE_KEY = 'atomflow:billing-checkout-confirmation:v1';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type PendingCheckoutConfirmation = {
  version: 1;
  userId: number;
  requestId: string;
  planCode: BillingPlanCode | null;
  transactionId: string | null;
  mode: 'subscription_purchase' | 'payment_recovery';
  expiresAt: number;
};

const isPlanCode = (value: unknown): value is BillingPlanCode => (
  value === 'pro_monthly' || value === 'pro_yearly' || value === 'team_monthly' || value === 'team_yearly'
);

export const storePendingCheckoutConfirmation = (
  input: Omit<PendingCheckoutConfirmation, 'version' | 'expiresAt' | 'mode'> & { mode?: PendingCheckoutConfirmation['mode'] },
) => {
  const stored: PendingCheckoutConfirmation = {
    ...input,
    mode: input.mode ?? 'subscription_purchase',
    version: 1,
    expiresAt: Date.now() + MAX_AGE_MS,
  };
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Checkout confirmation must continue even when storage is unavailable.
  }
  return stored;
};

export const readPendingCheckoutConfirmation = (userId: number): PendingCheckoutConfirmation | null => {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) || 'null') as Partial<PendingCheckoutConfirmation> | null;
    if (!parsed || parsed.version !== 1 || parsed.userId !== userId || (parsed.planCode !== null && !isPlanCode(parsed.planCode))
      || typeof parsed.requestId !== 'string' || typeof parsed.expiresAt !== 'number' || parsed.expiresAt <= Date.now()
      || (parsed.transactionId !== null && typeof parsed.transactionId !== 'string')) {
      window.sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    const mode = parsed.mode === 'payment_recovery' ? 'payment_recovery' : 'subscription_purchase';
    return { ...parsed, planCode: parsed.planCode ?? null, mode } as PendingCheckoutConfirmation;
  } catch {
    window.sessionStorage.removeItem(STORAGE_KEY);
    return null;
  }
};

export const clearPendingCheckoutConfirmation = (userId: number) => {
  const stored = readPendingCheckoutConfirmation(userId);
  if (stored) window.sessionStorage.removeItem(STORAGE_KEY);
};
