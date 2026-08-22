import {
  type MonitorClock,
  type OperationalAlert,
  systemClock,
} from "./operationalAlerts.js";

/**
 * Periodic self-checks for the two failure modes the RSS memory guard cannot see:
 * the database becoming unreachable, and a deploy driving the server error rate up.
 *
 * Deliberately has no logger dependency - observability goes out through the
 * injected `onEvent` hook, the same shape RssRuntimeController uses, which is what
 * keeps this module drivable by a fake clock in tests.
 */

export const DB_PROBE_FAILURE_THRESHOLD = 3;
export const DB_PROBE_RECOVERY_THRESHOLD = 2;
export const DB_PROBE_TIMEOUT_MS = 5000;
export const ERROR_RATE_BUCKET_MS = 60_000;
export const ERROR_RATE_BUCKET_COUNT = 5;
export const ERROR_RATE_RECOVERY_EVALUATIONS = 2;

const DEFAULT_PROBE_INTERVAL_MS = 30_000;
const DEFAULT_ERROR_RATE_THRESHOLD = 0.1;
const DEFAULT_ERROR_RATE_MIN_REQUESTS = 20;

export type ServiceHealthEvent = {
  event:
    | "started"
    | "shutdown"
    | "probe-succeeded"
    | "probe-failed"
    | "probe-skipped"
    | "alert-delivery-failed";
  at: string;
  details?: Record<string, unknown>;
};

export type ServiceHealthStatus = {
  started: boolean;
  database: {
    reachable: boolean | null;
    consecutiveFailures: number;
    consecutiveSuccesses: number;
    lastProbeAt: string | null;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    lastErrorKind: "timeout" | "query-failed" | null;
    alerted: boolean;
  };
  errorRate: {
    windowMs: number;
    totalRequests: number;
    serverErrors: number;
    ratio: number;
    thresholdRatio: number;
    minRequests: number;
    alerted: boolean;
    consecutiveHealthyEvaluations: number;
  };
};

export type ServiceHealthMonitorOptions = {
  probeDatabase: () => Promise<unknown>;
  sendAlert?: (alert: OperationalAlert) => Promise<void>;
  onEvent?: (event: ServiceHealthEvent) => void;
  clock?: MonitorClock;
  probeIntervalMs?: number;
  probeTimeoutMs?: number;
  errorRateThreshold?: number;
  errorRateMinRequests?: number;
};

type Bucket = { bucketId: number; total: number; serverErrors: number };

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const toIso = (epochMs: number) => new Date(epochMs).toISOString();

const roundRatio = (value: number) => Math.round(value * 1000) / 1000;

export class ServiceHealthMonitor {
  private readonly probeDatabase: ServiceHealthMonitorOptions["probeDatabase"];
  private readonly sendAlert?: ServiceHealthMonitorOptions["sendAlert"];
  private readonly onEvent?: ServiceHealthMonitorOptions["onEvent"];
  private readonly clock: MonitorClock;
  private readonly probeIntervalMs: number;
  private readonly probeTimeoutMs: number;
  private readonly errorRateThreshold: number;
  private readonly errorRateMinRequests: number;

  private started = false;
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private probeRunning = false;

  private dbReachable: boolean | null = null;
  private dbConsecutiveFailures = 0;
  private dbConsecutiveSuccesses = 0;
  private dbLastProbeAt: string | null = null;
  private dbLastSuccessAt: string | null = null;
  private dbLastFailureAt: string | null = null;
  private dbLastErrorKind: "timeout" | "query-failed" | null = null;
  private dbAlerted = false;

  private readonly buckets: Bucket[];
  private errorRateAlerted = false;
  private consecutiveHealthyEvaluations = 0;

  constructor(options: ServiceHealthMonitorOptions) {
    this.probeDatabase = options.probeDatabase;
    this.sendAlert = options.sendAlert;
    this.onEvent = options.onEvent;
    this.clock = options.clock ?? systemClock;
    this.probeIntervalMs = options.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
    this.probeTimeoutMs = options.probeTimeoutMs ?? DB_PROBE_TIMEOUT_MS;
    this.errorRateThreshold = options.errorRateThreshold ?? DEFAULT_ERROR_RATE_THRESHOLD;
    this.errorRateMinRequests = options.errorRateMinRequests ?? DEFAULT_ERROR_RATE_MIN_REQUESTS;
    this.buckets = Array.from({ length: ERROR_RATE_BUCKET_COUNT }, () => ({
      bucketId: -1,
      total: 0,
      serverErrors: 0,
    }));
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.emit("started");
    this.scheduleTick(0);
  }

  shutdown(): void {
    this.started = false;
    this.clearTick();
    this.emit("shutdown");
  }

  /**
   * Called from the response hot path, so it stays synchronous and allocation free.
   * Buckets expire lazily on reuse, which removes the need for a sweep timer.
   */
  recordResponse(statusCode: number): void {
    const bucketId = Math.floor(this.clock.now() / ERROR_RATE_BUCKET_MS);
    const slot = this.buckets[bucketId % ERROR_RATE_BUCKET_COUNT];
    if (slot.bucketId !== bucketId) {
      slot.bucketId = bucketId;
      slot.total = 0;
      slot.serverErrors = 0;
    }
    slot.total += 1;
    if (statusCode >= 500) slot.serverErrors += 1;
  }

  async runTick(): Promise<void> {
    // Error rate first: it is synchronous, so a slow or hanging database probe
    // can never delay a deploy-regression alert.
    for (const alert of this.evaluateErrorRate()) await this.notify(alert);

    if (this.probeRunning) {
      this.emit("probe-skipped");
      return;
    }
    this.probeRunning = true;
    try {
      for (const alert of await this.runDatabaseProbe()) await this.notify(alert);
    } finally {
      this.probeRunning = false;
    }
  }

  getStatus(): ServiceHealthStatus {
    const window = this.aggregateWindow();
    return {
      started: this.started,
      database: {
        reachable: this.dbReachable,
        consecutiveFailures: this.dbConsecutiveFailures,
        consecutiveSuccesses: this.dbConsecutiveSuccesses,
        lastProbeAt: this.dbLastProbeAt,
        lastSuccessAt: this.dbLastSuccessAt,
        lastFailureAt: this.dbLastFailureAt,
        lastErrorKind: this.dbLastErrorKind,
        alerted: this.dbAlerted,
      },
      errorRate: {
        windowMs: ERROR_RATE_BUCKET_MS * ERROR_RATE_BUCKET_COUNT,
        totalRequests: window.total,
        serverErrors: window.serverErrors,
        ratio: roundRatio(window.ratio),
        thresholdRatio: this.errorRateThreshold,
        minRequests: this.errorRateMinRequests,
        alerted: this.errorRateAlerted,
        consecutiveHealthyEvaluations: this.consecutiveHealthyEvaluations,
      },
    };
  }

  // --- database ---------------------------------------------------------------

  private async runDatabaseProbe(): Promise<OperationalAlert[]> {
    const startedAt = this.clock.now();
    let failureKind: "timeout" | "query-failed" | null = null;
    let failureReason = "";

    try {
      await this.probeOnce();
    } catch (error) {
      failureReason = errorMessage(error);
      failureKind = failureReason.includes("timed out") ? "timeout" : "query-failed";
    }

    this.dbLastProbeAt = toIso(startedAt);
    const alerts: OperationalAlert[] = [];

    if (failureKind === null) {
      this.dbReachable = true;
      this.dbConsecutiveFailures = 0;
      this.dbConsecutiveSuccesses += 1;
      this.dbLastSuccessAt = toIso(startedAt);
      this.emit("probe-succeeded");
      if (this.dbAlerted && this.dbConsecutiveSuccesses >= DB_PROBE_RECOVERY_THRESHOLD) {
        this.dbAlerted = false;
        alerts.push({
          kind: "database-recovered",
          subject: "[AtomFlow] database-recovered",
          message: `Database connectivity has been restored for ${DB_PROBE_RECOVERY_THRESHOLD} consecutive probes.`,
          occurredAt: toIso(startedAt),
        });
      }
      return alerts;
    }

    this.dbReachable = false;
    this.dbConsecutiveSuccesses = 0;
    this.dbConsecutiveFailures += 1;
    this.dbLastFailureAt = toIso(startedAt);
    this.dbLastErrorKind = failureKind;
    // The reason is emitted for the logs but never stored: this status is projected
    // into the unauthenticated health endpoint.
    this.emit("probe-failed", {
      kind: failureKind,
      reason: failureReason,
      consecutiveFailures: this.dbConsecutiveFailures,
    });

    if (this.dbConsecutiveFailures >= DB_PROBE_FAILURE_THRESHOLD && !this.dbAlerted) {
      this.dbAlerted = true;
      alerts.push({
        kind: "database-unreachable",
        subject: "[AtomFlow] database-unreachable",
        message:
          `The database has failed ${this.dbConsecutiveFailures} consecutive health probes ` +
          `(last failure: ${failureKind}).`,
        occurredAt: toIso(startedAt),
      });
    }
    return alerts;
  }

  private async probeOnce(): Promise<void> {
    const probe = Promise.resolve(this.probeDatabase());
    // Keep the abandoned attempt handled: a late rejection after the timeout wins
    // would otherwise reach the process-level unhandledRejection handler, which
    // logs at fatal level.
    probe.catch(() => undefined);

    let handle: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        probe,
        new Promise<never>((_resolve, reject) => {
          handle = this.clock.setTimeout(
            () => reject(new Error(`database probe timed out after ${this.probeTimeoutMs}ms`)),
            this.probeTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (handle !== undefined) this.clock.clearTimeout(handle);
    }
  }

  // --- error rate -------------------------------------------------------------

  private aggregateWindow(): { total: number; serverErrors: number; ratio: number } {
    const currentBucketId = Math.floor(this.clock.now() / ERROR_RATE_BUCKET_MS);
    const oldestBucketId = currentBucketId - (ERROR_RATE_BUCKET_COUNT - 1);
    let total = 0;
    let serverErrors = 0;
    for (const bucket of this.buckets) {
      if (bucket.bucketId < oldestBucketId || bucket.bucketId > currentBucketId) continue;
      total += bucket.total;
      serverErrors += bucket.serverErrors;
    }
    return { total, serverErrors, ratio: total === 0 ? 0 : serverErrors / total };
  }

  private evaluateErrorRate(): OperationalAlert[] {
    const { total, serverErrors, ratio } = this.aggregateWindow();
    const occurredAt = toIso(this.clock.now());

    const breaching = total >= this.errorRateMinRequests && ratio >= this.errorRateThreshold;
    if (breaching) {
      this.consecutiveHealthyEvaluations = 0;
      if (this.errorRateAlerted) return [];
      this.errorRateAlerted = true;
      return [{
        kind: "error-rate-high",
        subject: `[AtomFlow] error-rate-high (${Math.round(ratio * 100)}%)`,
        message:
          `Server error rate is ${Math.round(ratio * 100)}% over the last ` +
          `${(ERROR_RATE_BUCKET_MS * ERROR_RATE_BUCKET_COUNT) / 60_000} minutes ` +
          `(${serverErrors} of ${total} API responses were 5xx).`,
        occurredAt,
      }];
    }

    if (!this.errorRateAlerted) {
      this.consecutiveHealthyEvaluations = 0;
      return [];
    }

    // An empty window also counts as healthy: no errors observed for a full window
    // is recovery, and without this the alert would latch forever once traffic stops.
    const clearlyHealthy = total === 0
      || (total >= this.errorRateMinRequests && ratio < this.errorRateThreshold / 2);
    if (!clearlyHealthy) {
      this.consecutiveHealthyEvaluations = 0;
      return [];
    }

    this.consecutiveHealthyEvaluations += 1;
    if (this.consecutiveHealthyEvaluations < ERROR_RATE_RECOVERY_EVALUATIONS) return [];

    this.errorRateAlerted = false;
    this.consecutiveHealthyEvaluations = 0;
    return [{
      kind: "error-rate-recovered",
      subject: "[AtomFlow] error-rate-recovered",
      message:
        `Server error rate has returned to normal (${serverErrors} of ${total} API ` +
        `responses were 5xx over the last window).`,
      occurredAt,
    }];
  }

  // --- plumbing ---------------------------------------------------------------

  private async notify(alert: OperationalAlert): Promise<void> {
    if (!this.sendAlert) return;
    try {
      await this.sendAlert(alert);
    } catch (error) {
      this.emit("alert-delivery-failed", { kind: alert.kind, reason: errorMessage(error) });
    }
  }

  private scheduleTick(delayMs: number): void {
    this.clearTick();
    if (!this.started) return;
    this.tickTimer = this.clock.setTimeout(() => {
      this.tickTimer = null;
      void this.runTick().then(
        () => this.scheduleTick(this.probeIntervalMs),
        () => this.scheduleTick(this.probeIntervalMs),
      );
    }, delayMs);
  }

  private clearTick(): void {
    if (this.tickTimer !== null) this.clock.clearTimeout(this.tickTimer);
    this.tickTimer = null;
  }

  private emit(event: ServiceHealthEvent["event"], details?: Record<string, unknown>): void {
    try {
      this.onEvent?.({ event, at: toIso(this.clock.now()), details });
    } catch {
      // Observability hooks must never interrupt the monitoring loop.
    }
  }
}
