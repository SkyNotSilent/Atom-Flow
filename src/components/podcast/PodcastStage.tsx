import type React from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { PodcastCover } from "./PodcastCover";
import type { PodcastPreviewItem } from "./podcastPreview";

interface PodcastStageProps {
  item: PodcastPreviewItem;
  index: number;
  total: number;
  isPlaying: boolean;
  controls: React.ReactNode;
  onPrevious: () => void;
  onNext: () => void;
}

export function PodcastStage({
  item,
  index,
  total,
  isPlaying,
  controls,
  onPrevious,
  onNext,
}: PodcastStageProps) {
  const kindLabel = item.kind === "native_episode" ? "原生节目" : "文章待解读";
  return (
    <section className="podcast-stage" aria-label={`${item.title}播放区`}>
      <p className="podcast-sr-only" aria-live="polite">
        {item.title}，第 {index + 1} 条，共 {total} 条
      </p>
      <p className="podcast-stage-source">来自 {item.source}</p>
      <PodcastCover item={item} isPlaying={isPlaying} />
      <p className="podcast-stage-meta">
        <span>{kindLabel}</span>
        <span aria-hidden="true">·</span>
        <span>{item.timeLabel}</span>
      </p>
      <h1 className="podcast-stage-title">{item.title}</h1>
      <div className="podcast-stage-controls">{controls}</div>
      <div className="podcast-stage-actions">
        <button type="button" onClick={onPrevious} aria-label="上一条">
          <ChevronUp aria-hidden="true" size={20} />
          <span>上一条</span>
        </button>
        <button type="button" onClick={onNext} aria-label="下一条">
          <span>下一条</span>
          <ChevronDown aria-hidden="true" size={20} />
        </button>
      </div>
    </section>
  );
}
