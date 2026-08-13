import React, { useMemo, useState } from 'react';
import { ArrowLeft, BookOpen, Check, Loader2, ShieldCheck, Sparkles } from 'lucide-react';
import type { BillingPlan, BillingPlanCode } from '../../types';

type Props = {
  plans: BillingPlan[];
  catalogPhase: 'loading' | 'ready' | 'disabled' | 'error';
  catalogError: string | null;
  busy: boolean;
  busyLabel?: string;
  error: string | null;
  onCheckout: (planCode: BillingPlanCode) => void;
  onRetryPlans: () => void;
  canRetryConfirmation?: boolean;
  onRetryConfirmation?: () => void;
  onBack?: () => void;
};

export const MagicWritePaywall: React.FC<Props> = ({
  plans,
  catalogPhase,
  catalogError,
  busy,
  busyLabel,
  error,
  onCheckout,
  onRetryPlans,
  canRetryConfirmation = false,
  onRetryConfirmation,
  onBack,
}) => {
  const available = catalogPhase === 'ready' ? plans : [];
  const [selected, setSelected] = useState<BillingPlanCode>('pro_yearly');
  const plan = useMemo(() => available.find(item => item.code === selected) || available[0], [available, selected]);

  return (
    <main className="relative flex h-full min-h-0 overflow-y-auto bg-[#F3EEE4] text-[#2C2822]">
      <div className="pointer-events-none absolute inset-0 opacity-50 [background-image:radial-gradient(#B7A991_0.7px,transparent_0.7px)] [background-size:18px_18px]" />
      <div className="relative mx-auto flex w-full max-w-5xl flex-col px-5 py-6 sm:px-8 lg:py-10">
        <div className="flex items-center justify-between">
          <button type="button" onClick={onBack} className="flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm text-[#6F665A] hover:bg-white/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2367AC]">
            <ArrowLeft size={17} />返回 AtomFlow
          </button>
          <span className="rounded-full border border-[#D1C4B1] bg-[#FFFDF8]/80 px-3 py-1 text-[11px] font-semibold tracking-[0.14em] text-[#2766A5]">MAGIC WRITING PRO</span>
        </div>

        <section className="mt-8 grid flex-1 items-center gap-8 lg:grid-cols-[1.05fr_0.95fr] lg:gap-12">
          <div>
            <div className="inline-flex items-center gap-2 text-xs font-semibold tracking-[0.18em] text-[#8B6A3F]"><Sparkles size={15} />从素材到作品</div>
            <h1 className="mt-4 max-w-2xl font-serif text-4xl font-bold leading-[1.12] tracking-[-0.035em] sm:text-5xl">把你积累的知识，<br />变成可发布的文章。</h1>
            <p className="mt-5 max-w-xl text-sm leading-7 text-[#71685D]">Pro 解锁魔法画布、素材召回、写作 Agent 和 Skills。你的知识库、收藏和原子卡片始终保持可用。</p>
            <ul className="mt-7 grid gap-3 text-sm text-[#514A42] sm:grid-cols-2">
              {['自由编排的魔法画布', '可追溯引用的写作 Agent', '个人 Skills 与风格复用', '文章编辑与自动保存'].map(item => (
                <li key={item} className="flex items-start gap-2"><Check size={16} className="mt-0.5 shrink-0 text-[#2A70AF]" />{item}</li>
              ))}
            </ul>
          </div>

          <div className="rounded-[28px] border border-[#D9CCB9] bg-[#FFFCF6] p-5 shadow-[0_28px_70px_rgba(101,79,49,0.16)] sm:p-7">
            {available.length > 0 ? (
              <div role="tablist" aria-label="付费周期" className="grid grid-cols-2 rounded-2xl bg-[#EEE6D9] p-1.5">
                {available.map(item => (
                  <button key={item.code} role="tab" aria-selected={selected === item.code} type="button" onClick={() => setSelected(item.code)} className={`min-h-11 rounded-xl px-3 text-sm font-semibold transition ${selected === item.code ? 'bg-white text-[#235F9E] shadow-sm' : 'text-[#72685C] hover:text-[#39332C]'}`}>
                    {item.interval === 'year' ? '年付' : '月付'}{item.savingsCny ? <span className="ml-1 text-[10px] text-[#A25B2A]">省¥{item.savingsCny}</span> : null}
                  </button>
                ))}
              </div>
            ) : (
              <div className="rounded-2xl border border-[#DED2C1] bg-[#F8F3EA] px-4 py-5 text-center text-sm text-[#756B5E]" role="status">
                {catalogPhase === 'loading' ? '正在读取安全套餐信息…' : catalogError || '套餐暂时不可用'}
                {catalogPhase === 'error' ? (
                  <button type="button" onClick={onRetryPlans} className="mx-auto mt-3 flex min-h-10 items-center justify-center rounded-xl border border-[#CFC0A8] bg-white px-4 text-xs font-semibold text-[#285F98]">重新加载套餐</button>
                ) : null}
              </div>
            )}
            {plan ? (
              <div className="mt-7 flex items-end gap-2">
                <span className="font-serif text-5xl font-bold tracking-tight">¥{plan.priceCny}</span>
                <span className="pb-1.5 text-sm text-[#7D7366]">/ {plan.interval === 'year' ? '年' : '月'}</span>
              </div>
            ) : null}
            <p className="mt-2 text-xs leading-5 text-[#8A8073]">自动续费，可随时在账单中取消下一周期。税费以 Paddle 结账页为准。</p>
            <button type="button" disabled={busy || !plan || catalogPhase !== 'ready'} onClick={() => plan && onCheckout(plan.code)} className="mt-6 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#2367AC] px-4 text-sm font-semibold text-white shadow-[0_10px_26px_rgba(35,103,172,0.25)] hover:bg-[#1D5997] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2367AC] focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60">
              {busy ? <Loader2 size={17} className="animate-spin" /> : <ShieldCheck size={17} />}{busy ? busyLabel || '正在准备安全结账…' : '开通魔法写作 Pro'}
            </button>
            {canRetryConfirmation && onRetryConfirmation ? (
              <button type="button" onClick={onRetryConfirmation} className="mt-2 min-h-11 w-full rounded-xl border border-[#C9B99F] bg-white px-4 text-sm font-semibold text-[#285F98]">重新检查开通状态</button>
            ) : null}
            <div aria-live="polite" className="mt-3 min-h-5 text-center text-xs text-[#B24D3C]">{error}</div>
            <div className="mt-3 flex items-start gap-2 rounded-xl border border-[#E4D9C9] bg-[#F8F3EA] p-3 text-[11px] leading-5 text-[#756B5E]"><BookOpen size={15} className="mt-0.5 shrink-0" />首笔付款 3 天内且 AI 写作操作不超过 5 次，可联系客服申请退款。Pro 采用合理使用制。</div>
          </div>
        </section>

        <footer className="mt-8 flex flex-wrap justify-center gap-x-5 gap-y-2 text-[11px] text-[#82786B]">
          <a className="hover:text-[#245F9D]" href="/legal/terms" target="_blank" rel="noreferrer">服务条款</a>
          <a className="hover:text-[#245F9D]" href="/legal/privacy" target="_blank" rel="noreferrer">隐私说明</a>
          <a className="hover:text-[#245F9D]" href="/legal/refunds" target="_blank" rel="noreferrer">退款规则</a>
        </footer>
      </div>
    </main>
  );
};
