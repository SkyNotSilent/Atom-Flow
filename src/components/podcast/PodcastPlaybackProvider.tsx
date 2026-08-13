import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { ChevronDown, ChevronUp, Pause, Play } from "lucide-react";
import { PodcastControls } from "./PodcastControls";
import {
  clampPlaybackTime,
  createPodcastPlaybackState,
  parseAudioDuration,
  podcastPlaybackReducer,
  type PodcastPlaybackAction,
  type PodcastPlaybackRate,
  type PodcastPlaybackState,
} from "./podcastPlayback";
import { buildPodcastPreviewItems, type PodcastPreviewItem } from "./podcastPreview";
import type { Article } from "../../types";
import { getProxiedAudioUrl } from "../../utils/proxiedMedia";
import "./podcast.css";

export const PODCAST_PLAYBACK_ERROR = "该音频暂时无法播放，请重试或打开原节目。";

export interface PodcastAudioElementProps {
  item?: PodcastPreviewItem;
  continuousPlay: boolean;
  playbackRate?: PodcastPlaybackRate;
  onDispatch: (action: PodcastPlaybackAction) => void;
  onPlayNext: (itemId: string) => void;
}

/**
 * The source-scoped media node used by PodcastPlaybackProvider. Keeping this
 * component keyed by source ensures events from a detached source cannot
 * mutate the current playback generation.
 */
export const PodcastAudioElement = React.forwardRef<HTMLAudioElement, PodcastAudioElementProps>(
  function PodcastAudioElement({
    item,
    continuousPlay,
    playbackRate = 1,
    onDispatch,
    onPlayNext,
  }, ref) {
    const audioRef = useRef<HTMLAudioElement>(null);
    React.useImperativeHandle(ref, () => audioRef.current as HTMLAudioElement, []);

    useEffect(() => {
      const audio = audioRef.current;
      return () => {
        // React StrictMode replays effects without detaching the live node.
        if (!audio || audio.isConnected) return;
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      };
    }, []);

    return (
      <audio
        ref={audioRef}
        hidden
        preload="metadata"
        src={getProxiedAudioUrl(item?.audioUrl)}
        data-podcast-item-id={item?.id}
        onLoadedMetadata={event => {
          if (!item) return;
          event.currentTarget.playbackRate = playbackRate;
          const mediaDuration = event.currentTarget.duration;
          onDispatch({
            type: "loaded_metadata",
            itemId: item.id,
            duration: Number.isFinite(mediaDuration)
              ? mediaDuration
              : parseAudioDuration(item.audioDuration) ?? 0,
          });
        }}
        onPlaying={() => item && onDispatch({ type: "playing", itemId: item.id })}
        onPause={() => item && onDispatch({ type: "paused", itemId: item.id })}
        onTimeUpdate={event => item && onDispatch({
          type: "time_update",
          itemId: item.id,
          currentTime: event.currentTarget.currentTime,
        })}
        onEnded={() => {
          if (!item) return;
          onDispatch({ type: "ended", itemId: item.id });
          if (continuousPlay) onPlayNext(item.id);
        }}
        onError={() => item && onDispatch({
          type: "error",
          itemId: item.id,
          message: PODCAST_PLAYBACK_ERROR,
        })}
      />
    );
  },
);

export interface PodcastPlaybackContextValue {
  playback: PodcastPlaybackState;
  activeItem?: PodcastPreviewItem;
  queue: PodcastPreviewItem[];
  setQueue: (items: PodcastPreviewItem[]) => void;
  browse: (itemId: string | null) => void;
  toggle: (item: PodcastPreviewItem) => boolean;
  seek: (seconds: number) => void;
  skip: (deltaSeconds: number) => void;
  setRate: (rate: PodcastPlaybackRate) => void;
  setContinuousPlay: (enabled: boolean) => void;
  retry: () => void;
  registerFullPlayer: () => () => void;
}

const PodcastPlaybackContext = createContext<PodcastPlaybackContextValue | null>(null);

export function usePodcastPlayback(): PodcastPlaybackContextValue {
  const value = useContext(PodcastPlaybackContext);
  if (!value) {
    throw new Error("usePodcastPlayback must be used within PodcastPlaybackProvider");
  }
  return value;
}

/** Suppresses the floating mini player while the full podcast surface is mounted. */
export function usePodcastFullPlayerPresence(): void {
  const { registerFullPlayer } = usePodcastPlayback();
  useEffect(() => registerFullPlayer(), [registerFullPlayer]);
}

export interface PodcastMiniPlayerProps {
  hidden?: boolean;
}

export function PodcastMiniPlayer({ hidden = false }: PodcastMiniPlayerProps) {
  const [collapsed, setCollapsed] = useState(false);
  const {
    activeItem,
    playback,
    toggle,
    seek,
    skip,
    setRate,
    setContinuousPlay,
    retry,
  } = usePodcastPlayback();

  if (hidden || !activeItem?.audioUrl) return null;

  if (collapsed) {
    const isPlaying = playback.status === "playing";
    return (
      <aside
        className="podcast-mini-player podcast-mini-player--collapsed"
        aria-label="全局播客播放器"
        data-podcast-interactive
        data-collapsed="true"
      >
        <div className="podcast-mini-collapsed-copy">
          <strong>{activeItem.title}</strong>
          <span>{activeItem.source}</span>
        </div>
        <button
          type="button"
          className="podcast-control-round podcast-control-round--primary"
          aria-label={`${isPlaying ? "暂停" : "播放"}${activeItem.title}`}
          onClick={() => toggle(activeItem)}
        >
          {isPlaying
            ? <Pause aria-hidden="true" size={17} fill="currentColor" />
            : <Play aria-hidden="true" size={17} fill="currentColor" />}
        </button>
        <button
          type="button"
          className="podcast-mini-collapse-toggle"
          aria-label="展开迷你播放器"
          aria-expanded="false"
          onClick={() => setCollapsed(false)}
        >
          <ChevronUp aria-hidden="true" size={16} />
        </button>
      </aside>
    );
  }

  return (
    <aside
      className="podcast-mini-player"
      aria-label="全局播客播放器"
      data-podcast-interactive
    >
      <button
        type="button"
        className="podcast-mini-collapse-toggle"
        aria-label="收起迷你播放器"
        aria-expanded="true"
        onClick={() => setCollapsed(true)}
      >
        <ChevronDown aria-hidden="true" size={16} />
      </button>
      <PodcastControls
        item={activeItem}
        compact
        isActive
        status={playback.status}
        currentTime={playback.currentTime}
        duration={playback.duration}
        metadataReady={playback.metadataReady}
        playbackRate={playback.playbackRate}
        error={playback.error}
        onToggle={toggle}
        onSeek={seek}
        onSkip={skip}
        onRateChange={setRate}
        onRetry={retry}
      />
      <button
        className="podcast-mini-continuous"
        type="button"
        aria-pressed={playback.continuousPlay}
        onClick={() => setContinuousPlay(!playback.continuousPlay)}
      >
        连续播放
      </button>
    </aside>
  );
}

/**
 * Reader-facing controls backed by the provider-owned media element. This
 * component intentionally renders controls only; all playback stays in the
 * single global media element managed by PodcastPlaybackProvider.
 */
export function PodcastArticleAudioControls({ article }: { article: Article }) {
  const {
    playback,
    activeItem,
    toggle,
    seek,
    skip,
    setRate,
    retry,
  } = usePodcastPlayback();
  const item = useMemo(
    () => buildPodcastPreviewItems([article], [])[0],
    [article],
  );

  if (!item?.audioUrl) return null;
  const isActive = activeItem?.id === item.id && activeItem.audioUrl === item.audioUrl;

  return (
    <section
      className="mb-8 rounded-2xl border border-border bg-surface2 p-4"
      aria-label={`文章音频：${item.title}`}
      data-podcast-interactive
    >
      <PodcastControls
        item={item}
        isActive={isActive}
        status={playback.status}
        currentTime={isActive ? playback.currentTime : 0}
        duration={isActive ? playback.duration : 0}
        metadataReady={isActive && playback.metadataReady}
        playbackRate={playback.playbackRate}
        error={isActive ? playback.error : null}
        onToggle={toggle}
        onSeek={seek}
        onSkip={skip}
        onRateChange={setRate}
        onRetry={retry}
      />
    </section>
  );
}

interface PendingPlayback {
  itemId: string;
  reload: boolean;
  restart: boolean;
}

export interface PodcastPlaybackProviderProps {
  children: React.ReactNode;
  showMiniPlayer?: boolean;
  /** Undefined means auth is still resolving; null means signed out. */
  ownerIdentity?: string | number | null;
}

export function PodcastPlaybackProvider({
  children,
  showMiniPlayer = true,
  ownerIdentity,
}: PodcastPlaybackProviderProps) {
  const [playback, dispatch] = useReducer(
    podcastPlaybackReducer,
    null,
    createPodcastPlaybackState,
  );
  const [activeItem, setActiveItem] = useState<PodcastPreviewItem>();
  const [queue, setQueueState] = useState<PodcastPreviewItem[]>([]);
  const [fullPlayerCount, setFullPlayerCount] = useState(0);
  const audioRef = useRef<HTMLAudioElement>(null);
  const activeItemRef = useRef<PodcastPreviewItem | undefined>(undefined);
  const playbackRef = useRef(playback);
  const queueRef = useRef<PodcastPreviewItem[]>([]);
  const pendingPlaybackRef = useRef<PendingPlayback | null>(null);
  const normalizedOwnerIdentity = ownerIdentity === undefined
    ? undefined
    : ownerIdentity === null
      ? null
      : String(ownerIdentity);
  const ownerIdentityRef = useRef<string | null | undefined>(normalizedOwnerIdentity);

  playbackRef.current = playback;
  activeItemRef.current = activeItem;

  useEffect(() => {
    if (normalizedOwnerIdentity === undefined) return;
    const previousOwnerIdentity = ownerIdentityRef.current;
    ownerIdentityRef.current = normalizedOwnerIdentity;
    if (previousOwnerIdentity === undefined || previousOwnerIdentity === normalizedOwnerIdentity) return;

    const media = audioRef.current;
    media?.pause();
    if (media) {
      try {
        media.currentTime = 0;
      } catch {
        // Some browsers reject seeking before metadata; source teardown below is sufficient.
      }
    }
    pendingPlaybackRef.current = null;
    activeItemRef.current = undefined;
    queueRef.current = [];
    setActiveItem(undefined);
    setQueueState([]);
    dispatch({ type: "browse", itemId: null });
    dispatch({ type: "set_rate", rate: 1 });
    dispatch({ type: "set_continuous_play", enabled: false });
    dispatch({ type: "reset_active" });
  }, [normalizedOwnerIdentity]);

  const reportPlayFailure = useCallback((itemId: string) => {
    dispatch({ type: "error", itemId, message: PODCAST_PLAYBACK_ERROR });
  }, []);

  const playMountedAudio = useCallback((pending: PendingPlayback): boolean => {
    const media = audioRef.current;
    if (!media || media.dataset.podcastItemId !== pending.itemId) return false;
    if (pending.reload) media.load();
    if (pending.restart) media.currentTime = 0;
    media.playbackRate = playbackRef.current.playbackRate;
    const playPromise = media.play();
    if (playPromise) void playPromise.catch(() => reportPlayFailure(pending.itemId));
    return true;
  }, [reportPlayFailure]);

  useEffect(() => {
    const pending = pendingPlaybackRef.current;
    if (!pending || pending.itemId !== activeItem?.id) return;
    if (playMountedAudio(pending)) pendingPlaybackRef.current = null;
  }, [activeItem?.audioUrl, activeItem?.id, playMountedAudio]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = playback.playbackRate;
  }, [playback.playbackRate]);

  const setQueue = useCallback((items: PodcastPreviewItem[]) => {
    const nextQueue = [...items];
    queueRef.current = nextQueue;
    setQueueState(nextQueue);
  }, []);

  const browse = useCallback((itemId: string | null) => {
    dispatch({ type: "browse", itemId });
  }, []);

  const requestPlayback = useCallback((
    item: PodcastPreviewItem,
    options: { reload?: boolean; restart?: boolean } = {},
  ): boolean => {
    if (!item.audioUrl) return false;

    const currentItem = activeItemRef.current;
    const sourceChanged = currentItem?.id !== item.id || currentItem.audioUrl !== item.audioUrl;
    const pending = {
      itemId: item.id,
      reload: options.reload ?? sourceChanged,
      restart: options.restart ?? false,
    };

    activeItemRef.current = item;
    setActiveItem(item);
    dispatch({ type: "browse", itemId: item.id });
    dispatch({
      type: "request_play",
      itemId: item.id,
      initialDuration: parseAudioDuration(item.audioDuration) ?? 0,
    });

    if (!sourceChanged && playMountedAudio(pending)) {
      pendingPlaybackRef.current = null;
    } else {
      pendingPlaybackRef.current = pending;
    }
    return true;
  }, [playMountedAudio]);

  const toggle = useCallback((item: PodcastPreviewItem): boolean => {
    if (!item.audioUrl) return false;
    const state = playbackRef.current;
    const isCurrentSource = activeItemRef.current?.id === item.id
      && activeItemRef.current.audioUrl === item.audioUrl;

    if (isCurrentSource && state.status === "playing") {
      audioRef.current?.pause();
      dispatch({ type: "paused", itemId: item.id });
      return true;
    }
    if (isCurrentSource && state.status === "loading") return true;

    const restart = isCurrentSource
      && state.duration > 0
      && state.currentTime >= state.duration;
    return requestPlayback(item, { reload: state.status === "error", restart });
  }, [requestPlayback]);

  const seek = useCallback((seconds: number) => {
    const media = audioRef.current;
    const itemId = activeItemRef.current?.id;
    if (!media || !itemId) return;
    const nextTime = clampPlaybackTime(seconds, playbackRef.current.duration);
    media.currentTime = nextTime;
    dispatch({ type: "time_update", itemId, currentTime: nextTime });
  }, []);

  const skip = useCallback((deltaSeconds: number) => {
    const media = audioRef.current;
    if (!media) return;
    seek(media.currentTime + deltaSeconds);
  }, [seek]);

  const setRate = useCallback((rate: PodcastPlaybackRate) => {
    if (audioRef.current) audioRef.current.playbackRate = rate;
    dispatch({ type: "set_rate", rate });
  }, []);

  const setContinuousPlay = useCallback((enabled: boolean) => {
    dispatch({ type: "set_continuous_play", enabled });
  }, []);

  const retry = useCallback(() => {
    const item = activeItemRef.current;
    if (!item?.audioUrl) return;
    void requestPlayback(item, { reload: true });
  }, [requestPlayback]);

  const playNext = useCallback((currentItemId: string) => {
    const currentQueue = queueRef.current;
    const currentIndex = currentQueue.findIndex(item => item.id === currentItemId);
    if (currentIndex < 0 || currentQueue.length < 2) return;
    for (let offset = 1; offset < currentQueue.length; offset += 1) {
      const candidate = currentQueue[(currentIndex + offset) % currentQueue.length];
      if (!candidate.audioUrl) continue;
      void requestPlayback(candidate, { restart: true });
      return;
    }
  }, [requestPlayback]);

  const registerFullPlayer = useCallback(() => {
    let registered = true;
    setFullPlayerCount(count => count + 1);
    return () => {
      if (!registered) return;
      registered = false;
      setFullPlayerCount(count => Math.max(0, count - 1));
    };
  }, []);

  const value = useMemo<PodcastPlaybackContextValue>(() => ({
    playback,
    activeItem,
    queue,
    setQueue,
    browse,
    toggle,
    seek,
    skip,
    setRate,
    setContinuousPlay,
    retry,
    registerFullPlayer,
  }), [
    activeItem,
    browse,
    playback,
    queue,
    registerFullPlayer,
    retry,
    seek,
    setContinuousPlay,
    setQueue,
    setRate,
    skip,
    toggle,
  ]);

  return (
    <PodcastPlaybackContext.Provider value={value}>
      {children}
      <PodcastAudioElement
        key={activeItem ? `${activeItem.id}:${activeItem.audioUrl ?? ""}` : "podcast-idle"}
        ref={audioRef}
        item={activeItem}
        continuousPlay={playback.continuousPlay}
        playbackRate={playback.playbackRate}
        onDispatch={dispatch}
        onPlayNext={playNext}
      />
      {showMiniPlayer && <PodcastMiniPlayer hidden={fullPlayerCount > 0} />}
    </PodcastPlaybackContext.Provider>
  );
}
