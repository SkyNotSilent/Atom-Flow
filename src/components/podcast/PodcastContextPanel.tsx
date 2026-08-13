import { useEffect, useId, useRef, type SyntheticEvent } from "react";
import { X } from "lucide-react";
import type { PodcastPreviewItem } from "./podcastPreview";

interface PodcastContextPanelProps {
  item: PodcastPreviewItem;
  variant: "sidebar" | "dialog";
  open: boolean;
  onClose: () => void;
}

interface ContextContentProps {
  item: PodcastPreviewItem;
  headingId: string;
  closeAction?: () => void;
}

function ContextContent({ item, headingId, closeAction }: ContextContentProps) {
  return (
    <>
      <header className="podcast-context-header">
        <div>
          <p className="podcast-panel-kicker">内容上下文</p>
          <h2 id={headingId}>{item.title}</h2>
        </div>
        {closeAction && (
          <button type="button" onClick={closeAction} aria-label="关闭内容上下文">
            <X aria-hidden="true" size={18} />
          </button>
        )}
      </header>
      <dl className="podcast-context-facts">
        <div><dt>来源</dt><dd>{item.source}</dd></div>
        <div><dt>主题</dt><dd>{item.topic}</dd></div>
        <div><dt>时间</dt><dd>{item.timeLabel}</dd></div>
      </dl>
      <section className="podcast-context-section">
        <p className="podcast-panel-kicker">基于 RSS 摘要</p>
        <p>{item.summary}</p>
      </section>
      <section className="podcast-context-empty" aria-label="AI 内容状态">
        <h3>章节与逐字稿</h3>
        <p>尚无 AI 章节与逐字稿</p>
      </section>
    </>
  );
}

export function PodcastContextPanel({ item, variant, open, onClose }: PodcastContextPanelProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingId = useId();

  useEffect(() => {
    if (variant !== "dialog") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open, variant]);

  if (variant === "sidebar") {
    return (
      <aside className="podcast-context-panel" aria-labelledby={headingId} hidden={!open}>
        <ContextContent item={item} headingId={headingId} />
      </aside>
    );
  }

  const handleCancel = (event: SyntheticEvent<HTMLDialogElement>) => {
    event.preventDefault();
    onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      className="podcast-context-dialog"
      aria-labelledby={headingId}
      onCancel={handleCancel}
    >
      <ContextContent item={item} headingId={headingId} closeAction={onClose} />
    </dialog>
  );
}
