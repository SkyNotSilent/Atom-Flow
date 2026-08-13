import type { PodcastPreviewItem } from "./podcastPreview";
import { getProxiedImageUrl } from "../../utils/proxiedMedia";

interface PodcastCoverProps {
  item: PodcastPreviewItem;
  isPlaying: boolean;
}

export function PodcastCover({ item, isPlaying }: PodcastCoverProps) {
  const cover = getProxiedImageUrl(item.imageUrl) || "/assets/podcast/editorial-fallback-cover.png";
  return (
    <div className="podcast-cover-stack">
      <img
        className={`podcast-vinyl ${isPlaying ? "podcast-vinyl--playing" : ""}`}
        src="/assets/podcast/vinyl-record.png"
        alt=""
        aria-hidden="true"
      />
      <img className="podcast-cover-art" src={cover} alt={`${item.title} 封面`} />
    </div>
  );
}
