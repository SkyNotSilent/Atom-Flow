import assert from "node:assert/strict";
import {
  clampPlaybackTime,
  createPodcastPlaybackState,
  formatPlaybackTime,
  parseAudioDuration,
  podcastPlaybackReducer,
} from "../src/components/podcast/podcastPlayback";

let state = createPodcastPlaybackState("article:11");
state = podcastPlaybackReducer(state, { type: "request_play", itemId: "article:11", initialDuration: 1512 });
assert.equal(state.activeItemId, "article:11");
assert.equal(state.status, "loading");

state = podcastPlaybackReducer(state, { type: "browse", itemId: "article:12" });
assert.equal(state.browseItemId, "article:12");
assert.equal(state.activeItemId, "article:11", "browsing must not replace current audio");

state = podcastPlaybackReducer(state, { type: "playing", itemId: "article:11" });
assert.equal(state.status, "playing");
state = podcastPlaybackReducer(state, { type: "time_update", itemId: "article:11", currentTime: 42 });
assert.equal(state.currentTime, 42);

const stale = podcastPlaybackReducer(state, { type: "error", itemId: "article:99", message: "stale" });
assert.deepEqual(stale, state, "events from a replaced source must be ignored");

state = podcastPlaybackReducer(state, { type: "set_rate", rate: 1.5 });
assert.equal(state.playbackRate, 1.5);
state = podcastPlaybackReducer(state, { type: "set_continuous_play", enabled: true });
assert.equal(state.continuousPlay, true);
state = podcastPlaybackReducer(state, { type: "error", itemId: "article:11", message: "无法播放" });
assert.equal(state.status, "error");
assert.equal(state.error, "无法播放");

assert.equal(parseAudioDuration("90"), 90);
assert.equal(parseAudioDuration("25:12"), 1512);
assert.equal(parseAudioDuration("1:02:03"), 3723);
assert.equal(parseAudioDuration("unknown"), null);
assert.equal(clampPlaybackTime(-5, 100), 0);
assert.equal(clampPlaybackTime(105, 100), 100);
assert.equal(formatPlaybackTime(3723), "1:02:03");

console.log("PASS: podcast browsing and real playback state remain independent");
