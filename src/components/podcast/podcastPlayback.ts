export const PODCAST_PLAYBACK_RATES = [1, 1.25, 1.5, 2] as const;
export type PodcastPlaybackRate = (typeof PODCAST_PLAYBACK_RATES)[number];
export type PodcastPlaybackStatus = "idle" | "loading" | "playing" | "paused" | "error";

export interface PodcastPlaybackState {
  browseItemId: string | null;
  activeItemId: string | null;
  status: PodcastPlaybackStatus;
  currentTime: number;
  duration: number;
  metadataReady: boolean;
  playbackRate: PodcastPlaybackRate;
  continuousPlay: boolean;
  error: string | null;
}

export type PodcastPlaybackAction =
  | { type: "browse"; itemId: string | null }
  | { type: "request_play"; itemId: string; initialDuration: number }
  | { type: "loaded_metadata"; itemId: string; duration: number }
  | { type: "playing"; itemId: string }
  | { type: "paused"; itemId: string }
  | { type: "time_update"; itemId: string; currentTime: number }
  | { type: "ended"; itemId: string }
  | { type: "error"; itemId: string; message: string }
  | { type: "set_rate"; rate: PodcastPlaybackRate }
  | { type: "set_continuous_play"; enabled: boolean }
  | { type: "reset_active" };

const finiteNonNegative = (value: number) => Number.isFinite(value) && value >= 0 ? value : 0;

export function createPodcastPlaybackState(browseItemId: string | null = null): PodcastPlaybackState {
  return {
    browseItemId,
    activeItemId: null,
    status: "idle",
    currentTime: 0,
    duration: 0,
    metadataReady: false,
    playbackRate: 1,
    continuousPlay: false,
    error: null,
  };
}

export function podcastPlaybackReducer(
  state: PodcastPlaybackState,
  action: PodcastPlaybackAction,
): PodcastPlaybackState {
  if (action.type === "browse") return { ...state, browseItemId: action.itemId };
  if (action.type === "set_rate") return { ...state, playbackRate: action.rate };
  if (action.type === "set_continuous_play") return { ...state, continuousPlay: action.enabled };
  if (action.type === "reset_active") {
    return {
      ...createPodcastPlaybackState(state.browseItemId),
      playbackRate: state.playbackRate,
      continuousPlay: state.continuousPlay,
    };
  }
  if (action.type === "request_play") {
    const sourceChanged = state.activeItemId !== action.itemId;
    return {
      ...state,
      activeItemId: action.itemId,
      status: "loading",
      currentTime: sourceChanged ? 0 : state.currentTime,
      duration: sourceChanged ? finiteNonNegative(action.initialDuration) : state.duration,
      metadataReady: sourceChanged ? false : state.metadataReady,
      error: null,
    };
  }
  if (state.activeItemId !== action.itemId) return state;
  switch (action.type) {
    case "loaded_metadata":
      return { ...state, duration: finiteNonNegative(action.duration), metadataReady: true, error: null };
    case "playing":
      return { ...state, status: "playing", error: null };
    case "paused":
      return state.status === "error" ? state : { ...state, status: "paused" };
    case "time_update":
      return { ...state, currentTime: clampPlaybackTime(action.currentTime, state.duration) };
    case "ended":
      return { ...state, status: "paused", currentTime: state.duration };
    case "error":
      return { ...state, status: "error", error: action.message };
    default:
      return state;
  }
}

export function parseAudioDuration(value?: string): number | null {
  if (!value?.trim()) return null;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return finiteNonNegative(Number(trimmed));
  const parts = trimmed.split(":").map(Number);
  if (parts.some(part => !Number.isFinite(part) || part < 0)) return null;
  if (parts.length === 2 && parts[1] < 60) return parts[0] * 60 + parts[1];
  if (parts.length === 3 && parts[1] < 60 && parts[2] < 60) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

export function clampPlaybackTime(value: number, duration: number): number {
  const safeDuration = finiteNonNegative(duration);
  return Math.min(safeDuration, Math.max(0, finiteNonNegative(value)));
}

export function formatPlaybackTime(value: number): string {
  const total = Math.floor(finiteNonNegative(value));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}
