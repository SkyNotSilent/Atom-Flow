import type { BillingPlan } from '../types';

export const normalizeBillingPlans = (payload: unknown): BillingPlan[] => {
  const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const values = Array.isArray(root.plans) ? root.plans : Array.isArray(payload) ? payload : [];
  return values.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const plan = item as Record<string, unknown>;
    const code = plan.code ?? plan.planCode ?? plan.plan_code;
    if (code !== 'pro_monthly' && code !== 'pro_yearly' && code !== 'team_monthly' && code !== 'team_yearly') return [];
    const interval = code.endsWith('_yearly') ? 'year' : 'month';
    const amount = Number(plan.priceCny ?? plan.price_cny ?? plan.amountCny);
    if (!Number.isFinite(amount) || amount <= 0) return [];
    const savings = Number(plan.savingsCny ?? plan.savings_cny);
    return [{
      code,
      name: typeof plan.name === 'string' ? plan.name : interval === 'year' ? '年度订阅' : '月度订阅',
      priceCny: amount,
      interval,
      currency: 'CNY' as const,
      audience: code.startsWith('team_') ? 'team' as const : 'individual' as const,
      ...(code.startsWith('team_') ? { minimumQuantity: 2 } : {}),
      ...(interval === 'year' && Number.isFinite(savings) && savings > 0 ? { savingsCny: savings } : {}),
    } satisfies BillingPlan];
  });
};
