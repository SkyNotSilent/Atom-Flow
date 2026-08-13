import assert from "node:assert/strict";
import test from "node:test";
import {
  RSS_MEMORY_PAUSE_BYTES,
  RSS_MEMORY_RESUME_BYTES,
  RSS_MEMORY_WARNING_BYTES,
  RSS_REFRESH_INTERVAL_MS,
  RssRuntimeController,
  mapWithConcurrency,
  type RssMemorySnapshot,
  type RssRuntimeAlert,
  type RssRuntimeClock,
} from "../src/server/rssRuntime.js";

const flushPromises = async () => {
  await new Promise<void>(resolve => setImmediate(resolve));
};

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const memorySnapshot = (rss: number): RssMemorySnapshot => ({
  rss,
  heapUsed: Math.floor(rss / 2),
  heapTotal: Math.floor(rss * 0.75),
  external: 1024,
  arrayBuffers: 512,
});

class FakeClock implements RssRuntimeClock {
  private currentTime = Date.UTC(2026, 7, 11);
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  now = () => this.currentTime;

  setTimeout = (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { at: this.currentTime + delayMs, callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  };

  clearTimeout = (handle: ReturnType<typeof setTimeout>) => {
    this.timers.delete(handle as unknown as number);
  };

  get size() {
    return this.timers.size;
  }

  delays() {
    return Array.from(this.timers.values(), timer => timer.at - this.currentTime).sort((a, b) => a - b);
  }

  async advanceBy(delayMs: number) {
    const target = this.currentTime + delayMs;
    while (true) {
      const next = Array.from(this.timers.entries())
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!next) break;
      this.timers.delete(next[0]);
      this.currentTime = next[1].at;
      next[1].callback();
      await flushPromises();
    }
    this.currentTime = target;
    await flushPromises();
  }
}

test("runCycle is single-flight while a refresh is in progress", async () => {
  const pendingRefresh = deferred();
  let calls = 0;
  const runtime = new RssRuntimeController({
    getSources: () => ["source-a"],
    getSourceId: source => source,
    refreshSource: async () => {
      calls += 1;
      await pendingRefresh.promise;
    },
  });

  const firstCycle = runtime.runCycle();
  const secondCycle = runtime.runCycle();
  await flushPromises();
  assert.equal(calls, 1);
  assert.equal(runtime.getStatus().refresh.inProgress, true);

  pendingRefresh.resolve();
  const [firstResult, secondResult] = await Promise.all([firstCycle, secondCycle]);
  assert.deepEqual(firstResult, secondResult);
  assert.equal(runtime.getStatus().refresh.cyclesStarted, 1);
  assert.equal(runtime.getStatus().refresh.cyclesCompleted, 1);
});

test("mapWithConcurrency never exceeds its configured worker limit", async () => {
  let active = 0;
  let maxActive = 0;
  const releases = Array.from({ length: 8 }, () => deferred());

  const mapped = mapWithConcurrency(
    Array.from({ length: 8 }, (_, index) => index),
    4,
    async index => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await releases[index].promise;
      active -= 1;
      return index * 2;
    },
  );

  await flushPromises();
  assert.equal(active, 4);
  assert.equal(maxActive, 4);

  for (const release of releases) {
    release.resolve();
    await flushPromises();
  }
  assert.deepEqual(await mapped, [0, 2, 4, 6, 8, 10, 12, 14]);
  assert.equal(maxActive, 4);
});

test("a source opens after three failures, skips two cycles, then probes half-open", async () => {
  let attempts = 0;
  const runtime = new RssRuntimeController({
    getSources: () => ["unstable"],
    getSourceId: source => source,
    refreshSource: async () => {
      attempts += 1;
      if (attempts <= 3) throw new Error(`failure-${attempts}`);
    },
  });

  await runtime.runCycle();
  await runtime.runCycle();
  await runtime.runCycle();
  assert.equal(attempts, 3);
  assert.deepEqual(runtime.getStatus().sources.unstable, {
    consecutiveFailures: 3,
    skipCyclesRemaining: 2,
    circuit: "open",
    lastAttemptAt: runtime.getStatus().sources.unstable.lastAttemptAt,
    lastSuccessAt: null,
    lastFailureAt: runtime.getStatus().sources.unstable.lastFailureAt,
    lastError: "failure-3",
  });

  const firstSkip = await runtime.runCycle();
  const secondSkip = await runtime.runCycle();
  assert.equal(firstSkip.skippedSourceCount, 1);
  assert.equal(secondSkip.skippedSourceCount, 1);
  assert.equal(attempts, 3);
  assert.equal(runtime.getStatus().sources.unstable.circuit, "half-open");
  assert.equal(runtime.getStatus().refresh.lastSuccessfulAt, null, "fully skipped cycles must not be reported as successful");

  const probe = await runtime.runCycle();
  assert.equal(probe.refreshedCount, 1);
  assert.equal(attempts, 4);
  assert.equal(runtime.getStatus().sources.unstable.circuit, "closed");
  assert.equal(runtime.getStatus().sources.unstable.consecutiveFailures, 0);
});

test("memory guard warns, pauses, then resumes only after six low samples", async () => {
  let currentRss = RSS_MEMORY_WARNING_BYTES;
  const alerts: RssRuntimeAlert[] = [];
  const runtime = new RssRuntimeController({
    getSources: () => ["source-a"],
    getSourceId: source => source,
    refreshSource: async () => undefined,
    memoryUsage: () => memorySnapshot(currentRss),
    sendAlert: async alert => {
      alerts.push(alert);
    },
  });

  await runtime.sampleMemory();
  await runtime.sampleMemory();
  await runtime.sampleMemory();
  assert.deepEqual(alerts.map(alert => alert.kind), ["memory-warning"]);
  assert.equal(runtime.getStatus().refresh.pausedForMemory, false);

  currentRss = RSS_MEMORY_PAUSE_BYTES;
  await runtime.sampleMemory();
  assert.deepEqual(alerts.map(alert => alert.kind), ["memory-warning", "memory-paused"]);
  assert.equal(runtime.getStatus().refresh.pausedForMemory, true);
  const skipped = await runtime.runCycle();
  assert.equal(skipped.skippedForMemory, true);

  currentRss = RSS_MEMORY_RESUME_BYTES - 1;
  for (let index = 0; index < 5; index += 1) await runtime.sampleMemory();
  assert.equal(runtime.getStatus().refresh.pausedForMemory, true);
  assert.equal(runtime.getStatus().memory.consecutiveRecoverySamples, 5);

  await runtime.sampleMemory();
  assert.equal(runtime.getStatus().refresh.pausedForMemory, false);
  assert.deepEqual(alerts.map(alert => alert.kind), [
    "memory-warning",
    "memory-paused",
    "memory-recovered",
  ]);
});

test("critical memory pauses RSS before a slow alert transport completes", async () => {
  const alertDelivery = deferred();
  const runtime = new RssRuntimeController({
    getSources: () => ["source-a"],
    getSourceId: source => source,
    refreshSource: async () => undefined,
    memoryUsage: () => memorySnapshot(RSS_MEMORY_PAUSE_BYTES),
    sendAlert: async () => alertDelivery.promise,
  });

  const sampling = runtime.sampleMemory();
  await flushPromises();
  assert.equal(runtime.getStatus().refresh.pausedForMemory, true);
  const skipped = await runtime.runCycle();
  assert.equal(skipped.skippedForMemory, true);
  alertDelivery.resolve();
  await sampling;
});

test("scheduled refresh waits 30 minutes after completion and shutdown clears timers and aborts work", async () => {
  const clock = new FakeClock();
  const pendingRefresh = deferred();
  let aborted = false;
  const runtime = new RssRuntimeController({
    getSources: () => ["source-a"],
    getSourceId: source => source,
    refreshSource: async (_source, signal) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        pendingRefresh.resolve();
      }, { once: true });
      await pendingRefresh.promise;
    },
    clock,
    memoryUsage: () => memorySnapshot(200 * 1024 * 1024),
  });

  runtime.start();
  assert.deepEqual(clock.delays(), [0, 0]);
  await clock.advanceBy(0);
  assert.equal(runtime.getStatus().refresh.inProgress, true);

  runtime.shutdown();
  await flushPromises();
  assert.equal(aborted, true);
  assert.equal(clock.size, 0);
  assert.equal(runtime.getStatus().started, false);
  assert.equal(runtime.getStatus().shuttingDown, true);

  const completedRuntime = new RssRuntimeController({
    getSources: () => ["source-b"],
    getSourceId: source => source,
    refreshSource: async () => undefined,
    clock,
    memoryUsage: () => memorySnapshot(200 * 1024 * 1024),
  });
  completedRuntime.start();
  await clock.advanceBy(0);
  assert.equal(completedRuntime.getStatus().refresh.cyclesCompleted, 1);
  assert.ok(clock.delays().includes(RSS_REFRESH_INTERVAL_MS));
  completedRuntime.shutdown();
  assert.equal(clock.size, 0);
});
