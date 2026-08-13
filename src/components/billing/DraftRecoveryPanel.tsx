import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Download, FileText, LayoutDashboard, Loader2, RefreshCw, Trash2, X } from 'lucide-react';
import {
  clearProtectedDrafts,
  deleteProtectedDraft,
  downloadProtectedDraftById,
  listProtectedDrafts,
  type ProtectedDraft,
} from '../../billing/draftVault';

type Props = {
  userId: number;
  isOpen: boolean;
  onClose: () => void;
};

const draftLabel = (draft: ProtectedDraft) => {
  if (!draft.payload || typeof draft.payload !== 'object') return draft.kind === 'article' ? '未保存文章' : '未保存画布';
  const payload = draft.payload as Record<string, unknown>;
  if (draft.kind === 'article' && typeof payload.title === 'string' && payload.title.trim()) return payload.title.trim();
  if (draft.kind === 'canvas' && Number.isSafeInteger(payload.projectId)) return `画布项目 ${payload.projectId}`;
  return draft.kind === 'article' ? '未保存文章' : '未保存画布';
};

export const DraftRecoveryPanel: React.FC<Props> = ({ userId, isOpen, onClose }) => {
  const [drafts, setDrafts] = useState<ProtectedDraft[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const generationRef = useRef(0);

  const refresh = useCallback(async () => {
    const generation = ++generationRef.current;
    setLoading(true);
    const nextDrafts = await listProtectedDrafts(userId);
    if (generation !== generationRef.current) return;
    setDrafts(nextDrafts);
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    generationRef.current += 1;
    setDrafts([]);
    setLoading(false);
    if (!isOpen) return undefined;
    setMessage('');
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    void refresh();
    window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      generationRef.current += 1;
      document.removeEventListener('keydown', handleKeyDown);
      previousFocus?.focus();
    };
  }, [isOpen, onClose, refresh, userId]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[210] flex items-center justify-center bg-black/35 p-4" onClick={onClose}>
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="draft-recovery-title" onClick={event => event.stopPropagation()} className="flex max-h-[min(720px,calc(100vh-2rem))] w-full max-w-xl flex-col overflow-hidden rounded-[24px] border border-[#D9CCB9] bg-[#FFFCF6] shadow-[0_28px_80px_rgba(55,43,29,0.28)]">
        <header className="flex items-start justify-between gap-4 border-b border-[#E4DACB] px-5 py-4">
          <div>
            <h2 id="draft-recovery-title" className="font-serif text-lg font-bold text-[#302A24]">本机草稿保护</h2>
            <p className="mt-1 text-[11px] leading-5 text-[#7B7063]">权限变为只读时，AtomFlow 会尝试把未保存内容留在这台设备。下载 JSON 后可安全留存或交由客服协助恢复。</p>
          </div>
          <button ref={closeButtonRef} type="button" onClick={onClose} aria-label="关闭草稿恢复" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-[#776D61] hover:bg-[#F0E9DE]"><X size={17} /></button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {loading ? (
            <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-[#7D7265]"><Loader2 size={17} className="animate-spin" />正在读取本机草稿…</div>
          ) : drafts.length === 0 ? (
            <div className="flex min-h-40 flex-col items-center justify-center rounded-2xl border border-dashed border-[#DCCFBC] bg-[#F8F2E8] px-5 text-center text-sm text-[#807568]">
              <FileText size={26} className="mb-3 opacity-45" />这台设备上暂无可恢复草稿
            </div>
          ) : (
            <div className="space-y-2.5">
              {drafts.map(draft => (
                <article key={draft.id} className="flex items-center gap-3 rounded-2xl border border-[#E1D7C8] bg-white p-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#EDF2F7] text-[#2B65A2]">{draft.kind === 'article' ? <FileText size={17} /> : <LayoutDashboard size={17} />}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px] font-semibold text-[#413A33]">{draftLabel(draft)}</div>
                    <div className="mt-1 text-[10px] text-[#8A8074]">{draft.kind === 'article' ? '文章' : '画布'} · {new Date(draft.createdAt).toLocaleString('zh-CN')}</div>
                  </div>
                  <button type="button" onClick={() => { void downloadProtectedDraftById(userId, draft.id).then(successful => setMessage(successful ? '草稿已下载' : '下载失败')); }} className="flex min-h-10 items-center gap-1.5 rounded-xl border border-[#C8D5E3] px-3 text-[11px] font-semibold text-[#28639F]"><Download size={13} />下载</button>
                  <button type="button" onClick={() => { void deleteProtectedDraft(userId, draft.id).then(successful => { setMessage(successful ? '已清理该草稿' : '草稿清理失败'); if (successful) void refresh(); }); }} aria-label={`清理${draftLabel(draft)}`} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-[#A44A3B] hover:bg-[#FBEDE9]"><Trash2 size={14} /></button>
                </article>
              ))}
            </div>
          )}
          <div aria-live="polite" className="mt-3 min-h-5 text-center text-[11px] text-[#8B5B2E]">{message}</div>
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-[#E4DACB] bg-[#F9F4EB] px-5 py-3">
          <button type="button" onClick={() => void refresh()} className="flex min-h-10 items-center gap-1.5 rounded-xl px-3 text-[11px] font-semibold text-[#31679D]"><RefreshCw size={13} />重新读取</button>
          {drafts.length > 0 ? <button type="button" onClick={() => { if (!window.confirm('确定清理这个账户在本机的全部保护草稿吗？')) return; void clearProtectedDrafts(userId).then(count => { setMessage(count > 0 ? `已清理 ${count} 份草稿` : '没有草稿被清理'); void refresh(); }); }} className="min-h-10 rounded-xl px-3 text-[11px] font-semibold text-[#A34C3E]">清理全部</button> : null}
        </footer>
      </section>
    </div>
  );
};
