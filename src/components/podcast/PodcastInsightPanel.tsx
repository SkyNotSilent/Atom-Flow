import type React from "react";
import { BookOpen, Database, FileAudio, PanelsTopLeft } from "lucide-react";
import type { PodcastPreviewItem } from "./podcastPreview";

interface PodcastInsightPanelProps {
  item: PodcastPreviewItem;
  saving: boolean;
  savingLabel: string | null;
  thoughtAction: React.ReactNode;
  onSave: () => void;
  onGenerate: () => void;
  onAddToCanvas?: (item: PodcastPreviewItem) => void;
}

export function PodcastInsightPanel({
  item,
  saving,
  savingLabel,
  thoughtAction,
  onSave,
  onGenerate,
  onAddToCanvas,
}: PodcastInsightPanelProps) {
  return (
    <section className="podcast-insight-panel" aria-labelledby={`podcast-insight-${item.id}`}>
      <div className="podcast-panel-heading">
        <div>
          <p className="podcast-panel-kicker">基于 RSS 摘要</p>
          <h2 id={`podcast-insight-${item.id}`}>当前观点</h2>
        </div>
        <BookOpen aria-hidden="true" size={20} />
      </div>
      <p className="podcast-insight-summary">{item.summary}</p>
      <div className="podcast-insight-actions">
        {item.sourceUrl && (
          <a
            href={item.sourceUrl}
            target="_blank"
            rel="noreferrer noopener"
            aria-label={`打开${item.source}的《${item.title}》原文`}
          >
            <BookOpen aria-hidden="true" size={16} />
            打开原文
          </a>
        )}
        {item.isSaved ? (
          <button type="button" disabled>
            <Database aria-hidden="true" size={16} />
            已在知识库
          </button>
        ) : item.articleId !== undefined ? (
          <button type="button" disabled={saving} onClick={onSave}>
            <Database aria-hidden="true" size={16} />
            {savingLabel || "存入知识库"}
          </button>
        ) : null}
        {item.kind === "article_pending" && (
          <button type="button" onClick={onGenerate}>
            <FileAudio aria-hidden="true" size={16} />
            生成解读
          </button>
        )}
        {onAddToCanvas && (
          <button type="button" onClick={() => onAddToCanvas(item)}>
            <PanelsTopLeft aria-hidden="true" size={16} />
            添加到画布
          </button>
        )}
        {thoughtAction}
      </div>
    </section>
  );
}
