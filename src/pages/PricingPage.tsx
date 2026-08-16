import React, { useEffect } from 'react';
import {
  ArrowRight,
  BookOpen,
  Check,
  FilePenLine,
  Layers3,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { AtomFlowGalaxyIcon } from '../components/AtomFlowGalaxyIcon';

const features = [
  { icon: Layers3, title: '魔法写作画布', detail: '在无限画布上编排素材、卡片、播客与文章结构。' },
  { icon: Sparkles, title: '写作 Agent', detail: '召回你的知识资产，辅助提炼、组织与生成内容。' },
  { icon: BookOpen, title: '可追溯的素材引用', detail: '写作时保留来源上下文，方便核验与回看。' },
  { icon: FilePenLine, title: 'Skills 与文章编辑', detail: '复用个人风格，并持续编辑、保存与导出作品。' },
];

const plans = [
  {
    name: '月付',
    price: '39',
    interval: '月',
    detail: '每月自动续费',
    note: '适合灵活体验完整工作流',
  },
  {
    name: '年付',
    price: '399',
    interval: '年',
    detail: '每年自动续费',
    note: '相较连续月付一年节省 ¥69',
    recommended: true,
  },
];

export function PricingPage() {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = 'AtomFlow 魔法写作 Pro 定价';
    return () => { document.title = previousTitle; };
  }, []);

  return (
    <main className="min-h-screen overflow-hidden bg-[#F4EFE5] text-[#29251F]">
      <div className="pointer-events-none fixed inset-0 opacity-45 [background-image:radial-gradient(#B8AA95_0.65px,transparent_0.65px)] [background-size:19px_19px]" />
      <div className="pointer-events-none fixed -right-24 top-24 h-80 w-80 rounded-full bg-[#D8E7F3]/70 blur-3xl" />
      <div className="pointer-events-none fixed -left-28 bottom-0 h-72 w-72 rounded-full bg-[#EAD6B6]/70 blur-3xl" />

      <div className="relative mx-auto w-full max-w-6xl px-5 pb-10 pt-5 sm:px-8 lg:px-10">
        <header className="flex items-center justify-between border-b border-[#D6CBB9] pb-5">
          <a href="/" className="flex min-h-11 items-center gap-3 rounded-xl pr-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2367AC]">
            <span className="flex h-10 w-10 items-center justify-center rounded-full border border-[#D0C2AD] bg-[#FFFDF8] shadow-sm">
              <AtomFlowGalaxyIcon size={22} />
            </span>
            <span>
              <span className="block font-serif text-base font-bold tracking-tight">Atom<span className="text-[#286AA9]">Flow</span></span>
              <span className="block text-[10px] tracking-[0.12em] text-[#655D53]">知识工作的第二大脑</span>
            </span>
          </a>
          <nav aria-label="定价页导航" className="flex items-center gap-2 sm:gap-4">
            <a href="/legal/terms" className="hidden min-h-11 items-center px-2 text-xs text-[#70665A] hover:text-[#245F9D] sm:flex">条款与联系</a>
            <a href="/?view=write" className="inline-flex min-h-11 items-center gap-2 rounded-full bg-[#235F9E] px-4 text-xs font-semibold text-white shadow-[0_8px_22px_rgba(35,95,158,0.22)] transition hover:bg-[#1C5189] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2367AC] focus-visible:ring-offset-2">
              登录 / 注册 <ArrowRight size={14} />
            </a>
          </nav>
        </header>

        <section className="grid gap-10 pb-14 pt-14 lg:grid-cols-[1.05fr_0.95fr] lg:items-center lg:gap-16 lg:pb-20 lg:pt-20">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-[#C9B99E] bg-[#FFFDF8]/75 px-3 py-1.5 text-[11px] font-bold tracking-[0.16em] text-[#8A6030]">
              <Sparkles size={14} /> MAGIC WRITING PRO
            </div>
            <h1 className="mt-6 max-w-2xl font-serif text-[42px] font-bold leading-[1.12] tracking-[-0.045em] sm:text-6xl">
              让积累的知识，<br />开始替你<span className="text-[#286AA9]">写作</span>。
            </h1>
            <p className="mt-6 max-w-xl text-[15px] leading-8 text-[#6F665B] sm:text-base">
              AtomFlow 魔法写作 Pro 把收藏、原子卡片与写作工具放进同一张画布。不是从空白页开始，而是从你真正读过和沉淀过的内容开始。
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <a href="/?view=write" className="inline-flex min-h-12 items-center gap-2 rounded-xl bg-[#235F9E] px-5 text-sm font-semibold text-white shadow-[0_12px_30px_rgba(35,95,158,0.24)] transition hover:-translate-y-0.5 hover:bg-[#1C5189] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2367AC] focus-visible:ring-offset-2">
                登录并开通 Pro <ArrowRight size={16} />
              </a>
              <a href="#features" className="inline-flex min-h-12 items-center rounded-xl border border-[#CFC2AE] bg-[#FFFDF8]/70 px-5 text-sm font-semibold text-[#5F574E] transition hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2367AC]">
                查看包含功能
              </a>
            </div>
          </div>

          <div className="relative">
            <div className="absolute -inset-3 rotate-2 rounded-[34px] border border-[#C8B99F]/70 bg-[#E9DFC9]/70" />
            <div className="relative rounded-[30px] border border-[#D3C5B1] bg-[#FFFDF8] p-5 shadow-[0_30px_80px_rgba(86,65,38,0.16)] sm:p-7">
              <div className="flex items-center justify-between border-b border-[#E6DED1] pb-5">
                <div>
                  <p className="text-xs font-semibold tracking-[0.12em] text-[#655D53]">一个套餐，完整能力</p>
                  <h2 className="mt-1 font-serif text-2xl font-bold">魔法写作 Pro</h2>
                </div>
                <ShieldCheck className="text-[#2C6EA9]" size={26} />
              </div>
              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                {plans.map(plan => (
                  <article key={plan.name} className={`relative rounded-2xl border p-5 ${plan.recommended ? 'border-[#2A6AA5] bg-[#EEF5FA]' : 'border-[#DDD2C2] bg-[#FAF6EE]'}`}>
                    {plan.recommended ? <span className="absolute -top-2.5 right-4 rounded-full bg-[#2A6AA5] px-2.5 py-1 text-[9px] font-bold tracking-[0.12em] text-white">更省</span> : null}
                    <p className="text-sm font-semibold text-[#534C43]">{plan.name}</p>
                    <div className="mt-3 flex items-end gap-1">
                      <span className="pb-1.5 text-lg font-semibold">¥</span>
                      <span className="font-serif text-5xl font-bold tracking-[-0.06em]">{plan.price}</span>
                      <span className="pb-1.5 text-xs text-[#655D53]">/ {plan.interval}</span>
                    </div>
                    <p className="mt-3 text-xs font-medium text-[#655C51]">{plan.detail}</p>
                    <p className="mt-1 text-[11px] leading-5 text-[#655D53]">{plan.note}</p>
                  </article>
                ))}
              </div>
              <p className="mt-5 text-[11px] leading-5 text-[#655D53]">
                不含免费试用。订阅将按所选周期通过支付宝自动续费，直至取消；可在“会员与账单”中取消下一周期。团队订阅按席位计费，实际开放套餐与应付总额以付款前支付宝签约页为准。
              </p>
            </div>
          </div>
        </section>

        <section id="features" className="border-y border-[#D6CBB9] py-12 sm:py-16">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
            <div>
              <p className="text-[11px] font-bold tracking-[0.18em] text-[#8A6030]">PRO INCLUDES</p>
              <h2 className="mt-2 font-serif text-3xl font-bold tracking-tight">从素材召回到完成初稿</h2>
            </div>
            <p className="max-w-sm text-xs leading-6 text-[#655D53]">知识库、收藏文章和文章原子化不因未订阅 Pro 而受限制；Pro 解锁魔法写作能力。</p>
          </div>
          <div className="mt-8 grid gap-px overflow-hidden rounded-2xl border border-[#D7CCBA] bg-[#D7CCBA] sm:grid-cols-2 lg:grid-cols-4">
            {features.map(({ icon: Icon, title, detail }, index) => (
              <article key={title} className="min-h-52 bg-[#FFFDF8] p-6">
                <div className="flex items-start justify-between">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#E9F1F7] text-[#286AA9]"><Icon size={19} /></span>
                  <span className="font-serif text-sm text-[#756A5E]">0{index + 1}</span>
                </div>
                <h3 className="mt-7 font-serif text-lg font-bold">{title}</h3>
                <p className="mt-2 text-xs leading-6 text-[#655D53]">{detail}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="grid gap-8 py-12 sm:py-16 lg:grid-cols-[0.85fr_1.15fr] lg:gap-16">
          <div>
            <p className="text-[11px] font-bold tracking-[0.18em] text-[#8A6030]">BILLING NOTES</p>
            <h2 className="mt-2 font-serif text-3xl font-bold">付款前，你应该知道</h2>
          </div>
          <div className="grid gap-5 text-sm leading-7 text-[#665E54] sm:grid-cols-2">
            <div className="flex gap-3"><Check className="mt-1 shrink-0 text-[#2B6B45]" size={17} /><p>月付按月、年付按年自动续费。普通取消在当前已付周期结束时生效。</p></div>
            <div className="flex gap-3"><Check className="mt-1 shrink-0 text-[#2B6B45]" size={17} /><p>付款与自动续费签约由支付宝处理；AtomFlow 不存储你的支付密码或完整支付凭据。</p></div>
            <div className="flex gap-3"><Check className="mt-1 shrink-0 text-[#2B6B45]" size={17} /><p>首笔付款 3 个自然日内，且主动发起的魔法写作 AI 操作不超过 5 次，可申请全额退款。</p></div>
            <div className="flex gap-3"><Check className="mt-1 shrink-0 text-[#2B6B45]" size={17} /><p>续费原则上不退款；重复扣款、可归责的重大故障及法律强制要求除外。</p></div>
          </div>
        </section>

        <footer className="flex flex-col gap-5 border-t border-[#D6CBB9] pt-7 text-xs text-[#655D53] sm:flex-row sm:items-center sm:justify-between">
          <p>© {new Date().getFullYear()} AtomFlow · 让知识持续流动</p>
          <nav aria-label="法律与联系" className="flex flex-wrap gap-x-5 gap-y-3">
            <a className="hover:text-[#245F9D]" href="/legal/terms">服务条款与联系</a>
            <a className="hover:text-[#245F9D]" href="/legal/privacy">隐私说明</a>
            <a className="hover:text-[#245F9D]" href="/legal/refunds">退款政策</a>
            <a className="hover:text-[#245F9D]" href="/legal/security">安全说明</a>
          </nav>
        </footer>
      </div>
    </main>
  );
}
