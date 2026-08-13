import { ChevronLeft, ChevronRight } from "lucide-react";
import type { PodcastPreviewItem } from "./podcastPreview";
import { getProxiedImageUrl } from "../../utils/proxiedMedia";

interface PodcastCardRailProps {
  items: PodcastPreviewItem[];
  activeId: string | null;
  onSelect: (itemId: string) => void;
  onPrevious: () => void;
  onNext: () => void;
}

export function PodcastCardRail({
  items,
  activeId,
  onSelect,
  onPrevious,
  onNext,
}: PodcastCardRailProps) {
  const navigationDisabled = items.length < 2;
  return (
    <section className="podcast-card-rail" aria-label="播客内容列表">
      <button
        className="podcast-rail-navigation"
        type="button"
        aria-label="浏览上一条"
        disabled={navigationDisabled}
        onClick={onPrevious}
      >
        <ChevronLeft aria-hidden="true" size={20} />
      </button>
      <div className="podcast-card-track">
        {items.map(item => {
          const active = item.id === activeId;
          return (
            <button
              className={`podcast-card ${active ? "podcast-card--active" : ""}`}
              type="button"
              key={item.id}
              aria-label={`浏览：${item.title}`}
              aria-current={active ? "true" : undefined}
              onClick={() => onSelect(item.id)}
            >
              <img
                src={getProxiedImageUrl(item.imageUrl) || "/assets/podcast/editorial-fallback-cover.png"}
                alt=""
                aria-hidden="true"
              />
              <span className="podcast-card-copy">
                <strong>{item.title}</strong>
                <small>{item.source}</small>
              </span>
            </button>
          );
        })}
      </div>
      <button
        className="podcast-rail-navigation"
        type="button"
        aria-label="浏览下一条"
        disabled={navigationDisabled}
        onClick={onNext}
      >
        <ChevronRight aria-hidden="true" size={20} />
      </button>
    </section>
  );
}
