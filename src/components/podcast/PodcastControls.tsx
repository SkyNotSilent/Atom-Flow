import type React from "react";
import { Gauge, LoaderCircle, Pause, Play, RotateCcw, RotateCw } from "lucide-react";
import {
  PODCAST_PLAYBACK_RATES,
  formatPlaybackTime,
  parseAudioDuration,
  type PodcastPlaybackRate,
  type PodcastPlaybackStatus,
} from "./podcastPlayback";
import type { PodcastPreviewItem } from "./podcastPreview";

export interface PodcastControlsProps {
  item: PodcastPreviewItem;
  isActive: boolean;
  status: PodcastPlaybackStatus;
  currentTime: number;
  duration: number;
  metadataReady: boolean;
  playbackRate: PodcastPlaybackRate;
  error: string | null;
  compact?: boolean;
  onToggle: (item: PodcastPreviewItem) => void;
  onSeek: (seconds: number) => void;
  onSkip: (deltaSeconds: number) => void;
  onRateChange: (rate: PodcastPlaybackRate) => void;
  onRetry: () => void;
}

const sourceLinkLabel = (item: PodcastPreviewItem) =>
  `打开${item.source}的《${item.title}》原节目`;

interface PodcastProgressProps {
  item: PodcastPreviewItem;
  currentTime: number;
  duration: number;
  metadataReady: boolean;
  onSeek: (seconds: number) => void;
}

function PodcastProgress({
  item,
  currentTime,
  duration,
  metadataReady,
  onSeek,
}: PodcastProgressProps) {
  if (!metadataReady || duration <= 0) return null;
  const elapsed = formatPlaybackTime(currentTime);
  const durationLabel = formatPlaybackTime(duration);
  const remaining = formatPlaybackTime(Math.max(0, duration - currentTime));
  const progress = Math.min(100, Math.max(0, currentTime / duration * 100));
  const progressStyle = { "--podcast-progress": `${progress}%` } as React.CSSProperties;

  return (
    <div className="podcast-progress-group">
      <div className="podcast-progress-shell" style={progressStyle}>
        <div className="podcast-progress-texture" aria-hidden="true">
          <span className="podcast-progress-layer podcast-progress-layer--base" />
          <span className="podcast-progress-layer podcast-progress-layer--played" />
        </div>
        <input
          className="podcast-progress-range"
          type="range"
          min={0}
          max={duration}
          step={1}
          value={Math.min(duration, Math.max(0, currentTime))}
          aria-label={`播放进度：${item.title}`}
          aria-valuetext={`${elapsed} / ${durationLabel}`}
          onChange={event => onSeek(Number(event.currentTarget.value))}
        />
      </div>
      <div className="podcast-time-row" aria-hidden="true">
        <span>{elapsed}</span>
        <span>-{remaining}</span>
      </div>
    </div>
  );
}

export function PodcastControls({
  item,
  isActive,
  status,
  currentTime,
  duration,
  metadataReady,
  playbackRate,
  error,
  compact = false,
  onToggle,
  onSeek,
  onSkip,
  onRateChange,
  onRetry,
}: PodcastControlsProps) {
  const isPlaying = isActive && status === "playing";
  const isLoading = isActive && status === "loading";
  const activeError = isActive && (status === "error" || Boolean(error));
  const toggleLabel = `${isPlaying ? "暂停" : "播放"}${item.title}`;
  const rateIndex = PODCAST_PLAYBACK_RATES.indexOf(playbackRate);
  const nextRate = PODCAST_PLAYBACK_RATES[(rateIndex + 1) % PODCAST_PLAYBACK_RATES.length] ?? 1;

  if (item.kind === "article_pending") {
    return (
      <div className="podcast-controls">
        <button className="podcast-control-primary" type="button" onClick={() => onToggle(item)}>
          生成解读
        </button>
        <p className="podcast-control-note">音频生成尚未接入</p>
      </div>
    );
  }

  if (compact) {
    return (
      <div className="podcast-controls podcast-controls--compact">
        <div className="podcast-compact-copy">
          <strong>{item.title}</strong>
          <span>{item.source}</span>
        </div>
        <div className="podcast-compact-actions">
          <button
            className="podcast-control-round"
            type="button"
            aria-label="快退 15 秒"
            disabled={isLoading || activeError}
            onClick={() => onSkip(-15)}
          >
            <RotateCcw aria-hidden="true" size={17} />
          </button>
          <button
            className="podcast-control-round podcast-control-round--primary"
            type="button"
            aria-label={isLoading ? `正在加载${item.title}` : toggleLabel}
            disabled={isLoading}
            onClick={() => onToggle(item)}
          >
            {isLoading ? (
              <LoaderCircle aria-hidden="true" size={18} />
            ) : isPlaying ? (
              <Pause aria-hidden="true" size={18} fill="currentColor" />
            ) : (
              <Play aria-hidden="true" size={18} fill="currentColor" />
            )}
          </button>
          <button
            className="podcast-control-round"
            type="button"
            aria-label="快进 15 秒"
            disabled={isLoading || activeError}
            onClick={() => onSkip(15)}
          >
            <RotateCw aria-hidden="true" size={17} />
          </button>
          <button
            className="podcast-rate-button"
            type="button"
            aria-label={`播放速度 ${playbackRate} 倍，切换为 ${nextRate} 倍`}
            disabled={isLoading || activeError}
            onClick={() => onRateChange(nextRate)}
          >
            {playbackRate}×
          </button>
        </div>
        <PodcastProgress
          item={item}
          currentTime={currentTime}
          duration={duration}
          metadataReady={metadataReady}
          onSeek={onSeek}
        />
        {isLoading && <p className="podcast-control-note" role="status">正在加载音频</p>}
        {activeError && (
          <div className="podcast-compact-error" role="alert">
            <p className="podcast-control-error">{error}</p>
            <button className="podcast-control-primary" type="button" onClick={onRetry}>重试播放</button>
            {item.sourceUrl && (
              <a
                className="podcast-control-link"
                href={item.sourceUrl}
                target="_blank"
                rel="noreferrer noopener"
                aria-label={sourceLinkLabel(item)}
              >
                打开原节目
              </a>
            )}
          </div>
        )}
      </div>
    );
  }

  if (!isActive) {
    const parsedDuration = parseAudioDuration(item.audioDuration);
    return (
      <div className="podcast-controls">
        <button
          className="podcast-control-primary"
          type="button"
          aria-label={`播放${item.title}`}
          onClick={() => onToggle(item)}
        >
          <Play aria-hidden="true" size={18} fill="currentColor" />
          播放节目
        </button>
        {parsedDuration !== null && (
          <span className="podcast-duration-meta">时长 {formatPlaybackTime(parsedDuration)}</span>
        )}
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="podcast-controls">
        <button
          className="podcast-control-primary"
          type="button"
          aria-label={`正在加载${item.title}`}
          disabled
        >
          <LoaderCircle aria-hidden="true" size={18} />
          加载中
        </button>
        <p className="podcast-control-note" role="status">正在加载音频</p>
      </div>
    );
  }

  if (activeError) {
    return (
      <div className="podcast-controls">
        <p className="podcast-control-error" role="alert">{error}</p>
        <div className="podcast-control-actions">
          <button className="podcast-control-primary" type="button" onClick={onRetry}>重试播放</button>
          {item.sourceUrl && (
            <a
              className="podcast-control-link"
              href={item.sourceUrl}
              target="_blank"
              rel="noreferrer noopener"
              aria-label={sourceLinkLabel(item)}
            >
              打开原节目
            </a>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="podcast-controls">
      <PodcastProgress
        item={item}
        currentTime={currentTime}
        duration={duration}
        metadataReady={metadataReady}
        onSeek={onSeek}
      />

      <div className="podcast-control-cluster">
        <button
          className="podcast-control-round"
          type="button"
          aria-label="快退 15 秒"
          onClick={() => onSkip(-15)}
        >
          <RotateCcw aria-hidden="true" size={20} />
        </button>
        <button
          className="podcast-control-round podcast-control-round--primary"
          type="button"
          aria-label={toggleLabel}
          onClick={() => onToggle(item)}
        >
          {isPlaying ? (
            <Pause aria-hidden="true" size={22} fill="currentColor" />
          ) : (
            <Play aria-hidden="true" size={22} fill="currentColor" />
          )}
        </button>
        <button
          className="podcast-control-round"
          type="button"
          aria-label="快进 15 秒"
          onClick={() => onSkip(15)}
        >
          <RotateCw aria-hidden="true" size={20} />
        </button>
        <button
          className="podcast-rate-button"
          type="button"
          aria-label={`播放速度 ${playbackRate} 倍，切换为 ${nextRate} 倍`}
          onClick={() => onRateChange(nextRate)}
        >
          <Gauge aria-hidden="true" size={16} />
          {playbackRate}×
        </button>
      </div>
    </div>
  );
}
