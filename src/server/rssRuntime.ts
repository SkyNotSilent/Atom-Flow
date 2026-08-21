export const RSS_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
export const RSS_MEMORY_SAMPLE_INTERVAL_MS = 5 * 60 * 1000;
export const RSS_MAX_CONCURRENCY = 4;

export const RSS_MEMORY_WARNING_BYTES = 600 * 1024 * 1024;
export const RSS_MEMORY_PAUSE_BYTES = 700 * 1024 * 1024;
export const RSS_MEMORY_RESUME_BYTES = 550 * 1024 * 1024;

const WARNING_SAMPLE_COUNT = 3;
const RESUME_SAMPLE_COUNT = 6;
const ALERT_TIMEOUT_MS = 10_000;
const SOURCE_FAILURE_LIMIT = 3;
const SOURCE_SKIP_CYCLES = 2;

type TimerHandle = ReturnType<typeof setTimeout>;

export type RssRuntimeClock = {
  now: () => number;
  setTimeout: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
};

export type RssMemorySnapshot = {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
};

export type RssRuntimeAlert = {
  kind: "memory-warning" | "memory-paused" | "memory-recovered";
  rssBytes: number;
  occurredAt: string;
  message: string;
};

export type RssRuntimeEvent = {
  event:
    | "refresh-started"
    | "refresh-completed"
    | "refresh-skipped"
    | "source-skipped"
    | "source-failed"
    | "memory-sampled"
    | "memory-alert-failed";
  at: string;
  details?: Record<string, unknown>;
};

export type RssSourceRuntimeStatus = {
  consecutiveFailures: number;
  skipCyclesRemaining: number;
  circuit: "closed" | "open" | "half-open";
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
};

export type RssRuntimeStatus = {
  started: boolean;
  shuttingDown: boolean;
  refresh: {
    pausedForMemory: boolean;
    inProgress: boolean;
    intervalMs: number;
    concurrency: number;
    nextScheduledAt: string | null;
    lastStartedAt: string | null;
    lastCompletedAt: string | null;
    lastSuccessfulAt: string | null;
    lastDurationMs: number | null;
    cyclesStarted: number;
    cyclesCompleted: number;
    cyclesSkippedForMemory: number;
    activeSources: number;
    maxObservedActiveSources: number;
    lastCycleFailureCount: number;
  };
  memory: {
    sampleIntervalMs: number;
    lastSampleAt: string | null;
    rssBytes: number | null;
    rssMegabytes: number | null;
    heapUsedBytes: number | null;
    heapTotalBytes: number | null;
    externalBytes: number | null;
    arrayBuffersBytes: number | null;
    consecutiveWarningSamples: number;
    consecutivePauseSamples: number;
    consecutiveRecoverySamples: number;
    warningThresholdBytes: number;
    pauseThresholdBytes: number;
    resumeThresholdBytes: number;
    lastAlertError: string | null;
  };
  sources: Record<string, RssSourceRuntimeStatus>;
};

export type RssCycleCompletion<TSource, TResult> = {
  sources: readonly TSource[];
  results: ReadonlyMap<string, TResult>;
  refreshedCount: number;
  skippedSourceCount: number;
  failureCount: number;
  signal: AbortSignal;
};

export type RssRuntimeOptions<TSource, TResult = void> = {
  getSources: () => readonly TSource[] | Promise<readonly TSource[]>;
  getSourceId: (source: TSource) => string;
  refreshSource: (source: TSource, signal: AbortSignal) => Promise<TResult>;
  onCycleComplete?: (completion: RssCycleCompletion<TSource, TResult>) => void | Promise<void>;
  clock?: RssRuntimeClock;
  memoryUsage?: () => RssMemorySnapshot;
  sendAlert?: (alert: RssRuntimeAlert) => Promise<void>;
  onEvent?: (event: RssRuntimeEvent) => void;
  refreshIntervalMs?: number;
  memorySampleIntervalMs?: number;
  concurrency?: number;
  memoryWarningBytes?: number;
  memoryPauseBytes?: number;
  memoryResumeBytes?: number;
};

export type RssRefreshCycleResult = {
  skippedForMemory: boolean;
  sourceCount: number;
  refreshedCount: number;
  skippedSourceCount: number;
  failureCount: number;
};

const systemClock: RssRuntimeClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: handle => clearTimeout(handle),
};

const defaultMemoryUsage = (): RssMemorySnapshot => {
  const usage = process.memoryUsage();
  return {
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
  };
};

const toIso = (timestamp: number) => new Date(timestamp).toISOString();

const errorMessage = (error: unknown) => (
  error instanceof Error ? error.message : String(error)
);

export async function mapWithConcurrency<TItem, TResult>(
  items: readonly TItem[],
  concurrency: number,
  worker: (item: TItem, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("concurrency must be a positive integer");
  }

  const results = new Array<TResult>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }));

  return results;
}

export class RssRuntimeController<TSource, TResult = void> {
  private readonly getSources: RssRuntimeOptions<TSource, TResult>["getSources"];
  private readonly getSourceId: RssRuntimeOptions<TSource, TResult>["getSourceId"];
  private readonly refreshSource: RssRuntimeOptions<TSource, TResult>["refreshSource"];
  private readonly onCycleComplete?: RssRuntimeOptions<TSource, TResult>["onCycleComplete"];
  private readonly clock: RssRuntimeClock;
  private readonly memoryUsage: () => RssMemorySnapshot;
  private readonly sendAlert?: RssRuntimeOptions<TSource>["sendAlert"];
  private readonly onEvent?: RssRuntimeOptions<TSource>["onEvent"];
  private readonly refreshIntervalMs: number;
  private readonly memorySampleIntervalMs: number;
  private readonly concurrency: number;
  private readonly memoryWarningBytes: number;
  private readonly memoryPauseBytes: number;
  private readonly memoryResumeBytes: number;

  private started = false;
  private shuttingDown = false;
  private refreshTimer: TimerHandle | null = null;
  private memoryTimer: TimerHandle | null = null;
  private refreshAbortController: AbortController | null = null;
  private refreshInFlight: Promise<RssRefreshCycleResult> | null = null;
  private nextScheduledAt: string | null = null;
  private pausedForMemory = false;
  private warningNotified = false;

  private readonly sourceStates = new Map<string, RssSourceRuntimeStatus>();
  private lastStartedAt: string | null = null;
  private lastCompletedAt: string | null = null;
  private lastSuccessfulAt: string | null = null;
  private lastDurationMs: number | null = null;
  private cyclesStarted = 0;
  private cyclesCompleted = 0;
  private cyclesSkippedForMemory = 0;
  private activeSources = 0;
  private maxObservedActiveSources = 0;
  private lastCycleFailureCount = 0;

  private lastMemorySampleAt: string | null = null;
  private lastMemorySnapshot: RssMemorySnapshot | null = null;
  private consecutiveWarningSamples = 0;
  private consecutivePauseSamples = 0;
  private consecutiveRecoverySamples = 0;
  private lastAlertError: string | null = null;

  constructor(options: RssRuntimeOptions<TSource, TResult>) {
    this.getSources = options.getSources;
    this.getSourceId = options.getSourceId;
    this.refreshSource = options.refreshSource;
    this.onCycleComplete = options.onCycleComplete;
    this.clock = options.clock ?? systemClock;
    this.memoryUsage = options.memoryUsage ?? defaultMemoryUsage;
    this.sendAlert = options.sendAlert;
    this.onEvent = options.onEvent;
    this.refreshIntervalMs = options.refreshIntervalMs ?? RSS_REFRESH_INTERVAL_MS;
    this.memorySampleIntervalMs = options.memorySampleIntervalMs ?? RSS_MEMORY_SAMPLE_INTERVAL_MS;
    this.concurrency = options.concurrency ?? RSS_MAX_CONCURRENCY;
    this.memoryWarningBytes = options.memoryWarningBytes ?? RSS_MEMORY_WARNING_BYTES;
    this.memoryPauseBytes = options.memoryPauseBytes ?? RSS_MEMORY_PAUSE_BYTES;
    this.memoryResumeBytes = options.memoryResumeBytes ?? RSS_MEMORY_RESUME_BYTES;

    if (!Number.isInteger(this.concurrency) || this.concurrency < 1) {
      throw new RangeError("concurrency must be a positive integer");
    }
    if (!(this.memoryResumeBytes < this.memoryWarningBytes && this.memoryWarningBytes < this.memoryPauseBytes)) {
      throw new RangeError("memory thresholds must satisfy resume < warning < pause");
    }
  }

  start(): void {
    if (this.started && !this.shuttingDown) return;
    this.started = true;
    this.shuttingDown = false;
    this.scheduleRefresh(0);
    this.scheduleMemorySample(0);
  }

  shutdown(): void {
    this.shuttingDown = true;
    this.started = false;
    this.clearRefreshTimer();
    this.clearMemoryTimer();
    this.refreshAbortController?.abort(new Error("RSS runtime is shutting down"));
  }

  runCycle(): Promise<RssRefreshCycleResult> {
    if (this.refreshInFlight) return this.refreshInFlight;

    const cycle = this.executeCycle();
    this.refreshInFlight = cycle;
    const clearInFlight = () => {
      if (this.refreshInFlight === cycle) this.refreshInFlight = null;
    };
    void cycle.then(clearInFlight, clearInFlight);
    return cycle;
  }

  async sampleMemory(): Promise<RssRuntimeStatus["memory"]> {
    const snapshot = this.memoryUsage();
    const sampledAt = this.clock.now();
    this.lastMemorySnapshot = snapshot;
    this.lastMemorySampleAt = toIso(sampledAt);

    if (snapshot.rss >= this.memoryWarningBytes) {
      this.consecutiveWarningSamples += 1;
    } else {
      this.consecutiveWarningSamples = 0;
      this.warningNotified = false;
    }

    if (snapshot.rss >= this.memoryPauseBytes) {
      this.consecutivePauseSamples += 1;
    } else {
      this.consecutivePauseSamples = 0;
    }

    if (this.pausedForMemory && snapshot.rss < this.memoryResumeBytes) {
      this.consecutiveRecoverySamples += 1;
    } else {
      this.consecutiveRecoverySamples = 0;
    }

    const alerts: RssRuntimeAlert[] = [];
    if (this.consecutiveWarningSamples >= WARNING_SAMPLE_COUNT && !this.warningNotified) {
      this.warningNotified = true;
      alerts.push({
        kind: "memory-warning",
        rssBytes: snapshot.rss,
        occurredAt: toIso(sampledAt),
        message: "AtomFlow RSS runtime memory has exceeded the warning threshold for three samples.",
      });
    }

    if (snapshot.rss >= this.memoryPauseBytes && !this.pausedForMemory) {
      this.pausedForMemory = true;
      this.clearRefreshTimer();
      this.refreshAbortController?.abort(new Error("RSS refresh paused by memory guard"));
      alerts.push({
        kind: "memory-paused",
        rssBytes: snapshot.rss,
        occurredAt: toIso(sampledAt),
        message: "AtomFlow RSS refresh has been paused immediately after crossing the critical memory threshold.",
      });
    }

    if (this.pausedForMemory && this.consecutiveRecoverySamples >= RESUME_SAMPLE_COUNT) {
      this.pausedForMemory = false;
      this.consecutivePauseSamples = 0;
      this.consecutiveRecoverySamples = 0;
      this.warningNotified = false;
      alerts.push({
        kind: "memory-recovered",
        rssBytes: snapshot.rss,
        occurredAt: toIso(sampledAt),
        message: "AtomFlow RSS refresh has resumed after memory remained below the recovery threshold for 30 minutes.",
      });
      if (this.started && !this.shuttingDown) this.scheduleRefresh(0);
    }

    for (const alert of alerts) await this.notify(alert);

    this.emit("memory-sampled", {
      rssBytes: snapshot.rss,
      heapUsedBytes: snapshot.heapUsed,
      externalBytes: snapshot.external,
      pausedForMemory: this.pausedForMemory,
    });
    return this.getStatus().memory;
  }

  getStatus(): RssRuntimeStatus {
    const snapshot = this.lastMemorySnapshot;
    return {
      started: this.started,
      shuttingDown: this.shuttingDown,
      refresh: {
        pausedForMemory: this.pausedForMemory,
        inProgress: this.refreshInFlight !== null,
        intervalMs: this.refreshIntervalMs,
        concurrency: this.concurrency,
        nextScheduledAt: this.nextScheduledAt,
        lastStartedAt: this.lastStartedAt,
        lastCompletedAt: this.lastCompletedAt,
        lastSuccessfulAt: this.lastSuccessfulAt,
        lastDurationMs: this.lastDurationMs,
        cyclesStarted: this.cyclesStarted,
        cyclesCompleted: this.cyclesCompleted,
        cyclesSkippedForMemory: this.cyclesSkippedForMemory,
        activeSources: this.activeSources,
        maxObservedActiveSources: this.maxObservedActiveSources,
        lastCycleFailureCount: this.lastCycleFailureCount,
      },
      memory: {
        sampleIntervalMs: this.memorySampleIntervalMs,
        lastSampleAt: this.lastMemorySampleAt,
        rssBytes: snapshot?.rss ?? null,
        rssMegabytes: snapshot ? Math.round((snapshot.rss / 1024 / 1024) * 10) / 10 : null,
        heapUsedBytes: snapshot?.heapUsed ?? null,
        heapTotalBytes: snapshot?.heapTotal ?? null,
        externalBytes: snapshot?.external ?? null,
        arrayBuffersBytes: snapshot?.arrayBuffers ?? null,
        consecutiveWarningSamples: this.consecutiveWarningSamples,
        consecutivePauseSamples: this.consecutivePauseSamples,
        consecutiveRecoverySamples: this.consecutiveRecoverySamples,
        warningThresholdBytes: this.memoryWarningBytes,
        pauseThresholdBytes: this.memoryPauseBytes,
        resumeThresholdBytes: this.memoryResumeBytes,
        lastAlertError: this.lastAlertError,
      },
      sources: Object.fromEntries(
        Array.from(this.sourceStates.entries(), ([sourceId, state]) => [sourceId, { ...state }]),
      ),
    };
  }

  private async executeCycle(): Promise<RssRefreshCycleResult> {
    if (this.pausedForMemory) {
      this.cyclesSkippedForMemory += 1;
      this.emit("refresh-skipped", { reason: "memory" });
      return {
        skippedForMemory: true,
        sourceCount: 0,
        refreshedCount: 0,
        skippedSourceCount: 0,
        failureCount: 0,
      };
    }

    const startedAt = this.clock.now();
    const memoryAtStart = this.memoryUsage();
    this.lastStartedAt = toIso(startedAt);
    this.cyclesStarted += 1;
    this.maxObservedActiveSources = 0;
    this.refreshAbortController = new AbortController();
    const signal = this.refreshAbortController.signal;
    let sources: TSource[] = [];
    let refreshedCount = 0;
    let skippedSourceCount = 0;
    let failureCount = 0;
    const failedSourceIds = new Set<string>();
    const results = new Map<string, TResult>();

    try {
      sources = Array.from(await this.getSources());
      this.emit("refresh-started", { sourceCount: sources.length });
      await mapWithConcurrency(sources, this.concurrency, async source => {
        const sourceId = this.getSourceId(source);
        const state = this.getOrCreateSourceState(sourceId);
        if (state.skipCyclesRemaining > 0) {
          state.skipCyclesRemaining -= 1;
          if (state.skipCyclesRemaining === 0) state.circuit = "half-open";
          skippedSourceCount += 1;
          this.emit("source-skipped", { sourceId, skipCyclesRemaining: state.skipCyclesRemaining });
          return;
        }
        if (signal.aborted || this.shuttingDown) return;

        state.lastAttemptAt = toIso(this.clock.now());
        this.activeSources += 1;
        this.maxObservedActiveSources = Math.max(this.maxObservedActiveSources, this.activeSources);
        try {
          const result = await this.refreshSource(source, signal);
          if (signal.aborted || this.shuttingDown) return;
          results.set(sourceId, result);
          state.consecutiveFailures = 0;
          state.skipCyclesRemaining = 0;
          state.circuit = "closed";
          state.lastSuccessAt = toIso(this.clock.now());
          state.lastError = null;
          refreshedCount += 1;
        } catch (error) {
          if (signal.aborted || this.shuttingDown) return;
          state.consecutiveFailures += 1;
          state.lastFailureAt = toIso(this.clock.now());
          state.lastError = errorMessage(error);
          failureCount += 1;
          failedSourceIds.add(sourceId);
          if (state.consecutiveFailures >= SOURCE_FAILURE_LIMIT) {
            state.circuit = "open";
            state.skipCyclesRemaining = SOURCE_SKIP_CYCLES;
          }
          this.emit("source-failed", {
            sourceId,
            consecutiveFailures: state.consecutiveFailures,
            error: state.lastError,
          });
        } finally {
          this.activeSources -= 1;
        }
      });
      if (!signal.aborted && !this.shuttingDown) {
        await this.onCycleComplete?.({
          sources,
          results,
          refreshedCount,
          skippedSourceCount,
          failureCount,
          signal,
        });
      }
    } catch (error) {
      failureCount += 1;
      throw error;
    } finally {
      results.clear();
      const completedAt = this.clock.now();
      const memoryAtEnd = this.memoryUsage();
      this.lastCompletedAt = toIso(completedAt);
      this.lastDurationMs = Math.max(0, completedAt - startedAt);
      this.lastCycleFailureCount = failureCount;
      this.cyclesCompleted += 1;
      if (refreshedCount > 0 && failureCount === 0 && skippedSourceCount === 0 && !signal.aborted) {
        this.lastSuccessfulAt = this.lastCompletedAt;
      }
      this.refreshAbortController = null;
      this.emit("refresh-completed", {
        sourceCount: sources.length,
        refreshedCount,
        skippedSourceCount,
        failureCount,
        durationMs: this.lastDurationMs,
        failedSourceIds: Array.from(failedSourceIds),
        heapUsedDeltaBytes: memoryAtEnd.heapUsed - memoryAtStart.heapUsed,
        rssDeltaBytes: memoryAtEnd.rss - memoryAtStart.rss,
        externalDeltaBytes: memoryAtEnd.external - memoryAtStart.external,
      });
    }

    return {
      skippedForMemory: false,
      sourceCount: sources.length,
      refreshedCount,
      skippedSourceCount,
      failureCount,
    };
  }

  private getOrCreateSourceState(sourceId: string): RssSourceRuntimeStatus {
    const existing = this.sourceStates.get(sourceId);
    if (existing) return existing;
    const state: RssSourceRuntimeStatus = {
      consecutiveFailures: 0,
      skipCyclesRemaining: 0,
      circuit: "closed",
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastError: null,
    };
    this.sourceStates.set(sourceId, state);
    return state;
  }

  private scheduleRefresh(delayMs: number): void {
    if (!this.started || this.shuttingDown || this.pausedForMemory) return;
    this.clearRefreshTimer();
    this.nextScheduledAt = toIso(this.clock.now() + delayMs);
    this.refreshTimer = this.clock.setTimeout(() => {
      this.refreshTimer = null;
      this.nextScheduledAt = null;
      const scheduleNext = () => {
        if (this.started && !this.shuttingDown && !this.pausedForMemory) {
          this.scheduleRefresh(this.refreshIntervalMs);
        }
      };
      void this.runCycle().then(scheduleNext, scheduleNext);
    }, delayMs);
  }

  private scheduleMemorySample(delayMs: number): void {
    if (!this.started || this.shuttingDown) return;
    this.clearMemoryTimer();
    this.memoryTimer = this.clock.setTimeout(() => {
      this.memoryTimer = null;
      const scheduleNext = () => {
        if (this.started && !this.shuttingDown) {
          this.scheduleMemorySample(this.memorySampleIntervalMs);
        }
      };
      void this.sampleMemory().then(scheduleNext, scheduleNext);
    }, delayMs);
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer !== null) this.clock.clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.nextScheduledAt = null;
  }

  private clearMemoryTimer(): void {
    if (this.memoryTimer !== null) this.clock.clearTimeout(this.memoryTimer);
    this.memoryTimer = null;
  }

  private async notify(alert: RssRuntimeAlert): Promise<void> {
    if (!this.sendAlert) return;
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.sendAlert(alert),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new DOMException("RSS alert delivery timed out", "TimeoutError")), ALERT_TIMEOUT_MS);
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      this.lastAlertError = null;
    } catch (error) {
      this.lastAlertError = errorMessage(error);
      this.emit("memory-alert-failed", { kind: alert.kind, error: this.lastAlertError });
    }
  }

  private emit(event: RssRuntimeEvent["event"], details?: Record<string, unknown>): void {
    try {
      this.onEvent?.({ event, at: toIso(this.clock.now()), details });
    } catch {
      // Observability hooks must never interrupt refresh scheduling or cleanup.
    }
  }
}
