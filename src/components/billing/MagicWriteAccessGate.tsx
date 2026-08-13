import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ArchiveRestore, CreditCard, Loader2, RefreshCw } from 'lucide-react';
import { useAppContext } from '../../context/AppContext';
import { MagicWritePaywall } from './MagicWritePaywall';
import { DraftRecoveryPanel } from './DraftRecoveryPanel';

type Props = { children: React.ReactNode; onBack?: () => void };

export const MagicWriteAccessGate: React.FC<Props> = ({ children, onBack }) => {
  const {
    user,
    isAuthLoading,
    billingState,
    billingPlans,
    billingCatalogState,
    checkoutState,
    refreshBillingStatus,
    refreshBillingPlans,
    retryBillingConfirmation,
    startBillingCheckout,
    openBillingPortal,
    requestBillingIntent,
  } = useAppContext();
  const [showDraftRecovery, setShowDraftRecovery] = useState(false);
  const closeDraftRecovery = useCallback(() => setShowDraftRecovery(false), []);

  useEffect(() => {
    if (!isAuthLoading && !user) requestBillingIntent({ kind: 'open_write' });
  }, [isAuthLoading, requestBillingIntent, user]);

  if (isAuthLoading || (user && (billingState.phase === 'idle' || billingState.phase === 'loading'))) {
    return <div className="flex h-full items-center justify-center gap-3 bg-[#F3EEE4] text-sm text-[#786E61]" aria-live="polite"><Loader2 size={18} className="animate-spin" />正在确认你的写作权限…</div>;
  }
  if (!user) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-[#F3EEE4] text-sm text-[#786E61]">
        <span>请先登录后使用魔法写作。</span>
        <div className="flex flex-wrap justify-center gap-2">
          <button type="button" onClick={() => requestBillingIntent({ kind: 'open_write' })} className="min-h-11 rounded-xl bg-[#285F98] px-4 font-semibold text-white">登录 / 注册</button>
          <button type="button" onClick={onBack} className="min-h-11 rounded-xl border border-[#D1C5B4] bg-white px-4 text-[#285F98]">返回 AtomFlow</button>
        </div>
      </div>
    );
  }
  if (billingState.phase === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-[#F3EEE4] px-6 text-center">
        <AlertTriangle size={26} className="text-[#A76533]" />
        <h1 className="mt-4 font-serif text-xl font-bold text-[#332E28]">账单系统暂时不可用</h1>
        <p className="mt-2 max-w-md text-sm leading-6 text-[#786E61]">我们无法安全确认当前权限。为避免重复付款，请稍后重试。</p>
        <button type="button" onClick={() => void refreshBillingStatus()} className="mt-5 flex min-h-11 items-center gap-2 rounded-xl border border-[#CFC2AF] bg-white px-4 text-sm font-semibold text-[#285F98]"><RefreshCw size={15} />重新检查</button>
      </div>
    );
  }
  const status = billingState.status;
  if (status && !status.enabled) {
    return <div className="flex h-full min-h-0 flex-col"><div className="min-h-0 flex-1">{children}</div></div>;
  }
  const checkoutLocked = ['creating', 'open', 'confirming', 'pending'].includes(checkoutState.phase);
  if (!status || status.access === 'none') {
    const awaitingConfirmation = checkoutState.phase === 'confirming' || checkoutState.phase === 'pending';
    return <MagicWritePaywall plans={billingPlans} catalogPhase={billingCatalogState.phase} catalogError={billingCatalogState.phase === 'error' ? billingCatalogState.error : null} busy={checkoutLocked} busyLabel={awaitingConfirmation ? '付款已提交，正在确认开通…' : undefined} error={checkoutState.error} onCheckout={plan => void startBillingCheckout(plan)} onRetryPlans={() => void refreshBillingPlans()} canRetryConfirmation={checkoutState.phase === 'pending'} onRetryConfirmation={retryBillingConfirmation} onBack={onBack} />;
  }
  const shouldUsePortal = status.hasBillingCustomer
    && (status.subscriptionStatus === 'paused' || status.subscriptionStatus === 'canceled' || status.paymentActionRequired || status.access === 'full');
  const canRestartSubscription = status.access === 'read_only'
    && (status.subscriptionStatus === null || status.subscriptionStatus === 'canceled');

  return (
    <div className="flex h-full min-h-0 flex-col">
      {status.access === 'read_only' || status.paymentActionRequired || checkoutState.phase === 'confirming' || checkoutState.phase === 'pending' || checkoutState.phase === 'error' ? (
        <div className={`flex min-h-11 shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 py-2 text-center text-xs ${status.paymentActionRequired ? 'bg-[#8B3F31] text-white' : 'border-b border-[#D9C9B3] bg-[#F5E7CE] text-[#684E2E]'}`} role="status">
          <span>{checkoutState.phase === 'confirming' ? '付款已完成，正在等待服务端确认开通…' : checkoutState.phase === 'pending' || checkoutState.phase === 'error' ? checkoutState.error : status.paymentActionRequired ? '付款需要更新，完成前仍可继续使用。' : '当前为只读模式：可查看、复制与下载历史内容。'}</span>
          {shouldUsePortal ? <button type="button" disabled={checkoutLocked} onClick={() => void openBillingPortal()} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-[#255F9E] px-3 font-semibold text-white disabled:opacity-50"><CreditCard size={13} />管理 / 恢复订阅</button> : null}
          {canRestartSubscription && billingCatalogState.phase === 'ready' ? billingPlans.map(plan => <button key={plan.code} type="button" disabled={checkoutLocked} onClick={() => void startBillingCheckout(plan.code)} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-[#255F9E] px-3 font-semibold text-white disabled:opacity-50"><CreditCard size={13} />{plan.interval === 'year' ? `重新订阅年付 ¥${plan.priceCny}` : `月付 ¥${plan.priceCny}`}</button>) : null}
          {canRestartSubscription && billingCatalogState.phase === 'error' ? <button type="button" onClick={() => void refreshBillingPlans()} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-[#BCA784] bg-white/80 px-3 font-semibold text-[#785A31]"><RefreshCw size={13} />重新加载套餐</button> : null}
          {checkoutState.phase === 'pending' ? <button type="button" onClick={retryBillingConfirmation} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-[#BCA784] bg-white/80 px-3 font-semibold text-[#285F98]"><RefreshCw size={13} />重新检查开通状态</button> : null}
          {status.access === 'read_only' ? <button type="button" onClick={() => setShowDraftRecovery(true)} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-[#BCA784] bg-white/80 px-3 font-semibold text-[#785A31]"><ArchiveRestore size={13} />恢复 / 下载本机草稿</button> : null}
        </div>
      ) : null}
      <div className="min-h-0 flex-1">{children}</div>
      <DraftRecoveryPanel userId={user.id} isOpen={showDraftRecovery} onClose={closeDraftRecovery} />
    </div>
  );
};
