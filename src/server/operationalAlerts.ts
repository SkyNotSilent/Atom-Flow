/**
 * Operational alert delivery.
 *
 * Split into two deliberately separate exports:
 *   - `sendViaEmailChannels` — low level, channel fallback only. Used by any path
 *     that must not be rate limited (verification codes, transactional mail).
 *   - `createOperationalAlertSender` — adds an hourly cap and a backlog. Used only
 *     for operational alerts, so an alert storm can never throttle user mail.
 */

export type MonitorClock = {
  now: () => number;
  setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
};

export const systemClock: MonitorClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => {
    // Background loops and delivery timeouts must never be the reason the process
    // stays alive, matching how the other periodic jobs in this service behave.
    const handle = setTimeout(callback, delayMs);
    handle.unref();
    return handle;
  },
  clearTimeout: handle => clearTimeout(handle),
};

export type EmailChannelName = "resend" | "smtp";

export type EmailMessage = {
  to: string;
  subject: string;
  text?: string;
  html?: string;
};

export type EmailChannel = {
  name: EmailChannelName;
  send: (message: EmailMessage) => Promise<void>;
};

export type OperationalAlertKind =
  | "test"
  | "memory-warning"
  | "memory-paused"
  | "memory-recovered"
  | "database-unreachable"
  | "database-recovered"
  | "error-rate-high"
  | "error-rate-recovered";

export type OperationalAlert = {
  kind: OperationalAlertKind;
  subject: string;
  message: string;
  occurredAt: string;
};

export type AlertSenderStatus = {
  healthy: boolean;
  consecutiveFailures: number;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
  suppressedInWindow: number;
  pendingBacklog: number;
};

export type AlertSenderEvent = {
  event: "alert-sent" | "alert-suppressed" | "alert-failed";
  kind: OperationalAlertKind;
  channel?: EmailChannelName;
  error?: string;
};

export type OperationalAlertSender = {
  send: (alert: OperationalAlert) => Promise<void>;
  getStatus: () => AlertSenderStatus;
};

/**
 * A single delivery attempt is capped well below the 10s envelope that
 * `RssRuntimeController.notify` races against, so a slow transport can never make
 * that layer report a spurious failure for a delivery that later succeeds.
 * Redundancy comes from having two independent providers rather than from
 * retrying one of them, which also keeps the whole call inside that envelope.
 */
const CHANNEL_TIMEOUT_MS = 4000;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const MAX_BACKLOG_ENTRIES = 5;
const DEFAULT_MAX_PER_HOUR = 10;

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const withTimeout = async <T>(
  operation: Promise<T>,
  timeoutMs: number,
  clock: MonitorClock,
  label: string,
): Promise<T> => {
  // Mark the operation as handled so a late rejection after the timeout wins does
  // not surface as an unhandled rejection (which this process logs as fatal).
  operation.catch(() => undefined);
  let handle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        handle = clock.setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (handle !== undefined) clock.clearTimeout(handle);
  }
};

/**
 * Try every channel in order and return the one that accepted the message.
 * Rejects only when all of them fail, with every failure reason preserved.
 */
export const sendViaEmailChannels = async (
  channels: readonly EmailChannel[],
  message: EmailMessage,
  options: { clock?: MonitorClock; timeoutMs?: number } = {},
): Promise<{ channel: EmailChannelName }> => {
  if (channels.length === 0) throw new Error("No email transport is configured");
  const clock = options.clock ?? systemClock;
  const timeoutMs = options.timeoutMs ?? CHANNEL_TIMEOUT_MS;

  const failures: string[] = [];
  for (const channel of channels) {
    try {
      await withTimeout(channel.send(message), timeoutMs, clock, `${channel.name} delivery`);
      return { channel: channel.name };
    } catch (error) {
      failures.push(`${channel.name}: ${errorMessage(error)}`);
    }
  }
  throw new Error(`All email channels failed (${failures.join("; ")})`);
};

type BacklogEntry = { kind: OperationalAlertKind; occurredAt: string; reason: "failed" | "suppressed" };

const renderBacklogPreamble = (backlog: readonly BacklogEntry[]) => {
  if (backlog.length === 0) return "";
  const lines = backlog.map(entry => `- ${entry.occurredAt} ${entry.kind} (${entry.reason})`);
  return [
    `[${backlog.length} earlier alert(s) were not delivered, reported here instead]`,
    ...lines,
    "",
    "---",
    "",
  ].join("\n");
};

export const createOperationalAlertSender = (options: {
  channels: readonly EmailChannel[];
  recipient: string | undefined;
  clock?: MonitorClock;
  maxPerHour?: number;
  timeoutMs?: number;
  onEvent?: (event: AlertSenderEvent) => void;
}): OperationalAlertSender => {
  const clock = options.clock ?? systemClock;
  const maxPerHour = options.maxPerHour ?? DEFAULT_MAX_PER_HOUR;
  const timeoutMs = options.timeoutMs ?? CHANNEL_TIMEOUT_MS;

  let sentAt: number[] = [];
  let suppressedAt: number[] = [];
  let backlog: BacklogEntry[] = [];
  let consecutiveFailures = 0;
  let lastFailureAt: string | null = null;
  let lastSuccessAt: string | null = null;

  const emit = (event: AlertSenderEvent) => {
    try {
      options.onEvent?.(event);
    } catch {
      // Observability hooks must never break alert delivery.
    }
  };

  const pruneWindows = () => {
    const cutoff = clock.now() - RATE_WINDOW_MS;
    sentAt = sentAt.filter(at => at > cutoff);
    suppressedAt = suppressedAt.filter(at => at > cutoff);
  };

  const pushBacklog = (entry: BacklogEntry) => {
    backlog = [...backlog, entry].slice(-MAX_BACKLOG_ENTRIES);
  };

  const send = async (alert: OperationalAlert): Promise<void> => {
    if (!options.recipient) {
      throw new Error("SECURITY_CONTACT_EMAIL is not configured for operational alerts");
    }

    pruneWindows();
    if (sentAt.length >= maxPerHour) {
      // Rate limiting is intended behaviour, so it must not count as a delivery
      // failure. The alert is preserved and reported with the next one that ships.
      suppressedAt = [...suppressedAt, clock.now()];
      pushBacklog({ kind: alert.kind, occurredAt: alert.occurredAt, reason: "suppressed" });
      emit({ event: "alert-suppressed", kind: alert.kind });
      return;
    }

    const preamble = renderBacklogPreamble(backlog);
    const text = `${preamble}${alert.message}\n\nTime: ${alert.occurredAt}`;

    try {
      const { channel } = await sendViaEmailChannels(
        options.channels,
        { to: options.recipient, subject: alert.subject, text },
        { clock, timeoutMs },
      );
      sentAt = [...sentAt, clock.now()];
      backlog = [];
      consecutiveFailures = 0;
      lastSuccessAt = new Date(clock.now()).toISOString();
      emit({ event: "alert-sent", kind: alert.kind, channel });
    } catch (error) {
      consecutiveFailures += 1;
      lastFailureAt = new Date(clock.now()).toISOString();
      pushBacklog({ kind: alert.kind, occurredAt: alert.occurredAt, reason: "failed" });
      const reason = errorMessage(error);
      emit({ event: "alert-failed", kind: alert.kind, error: reason });
      throw new Error(`Operational alert delivery failed: ${reason}`);
    }
  };

  const getStatus = (): AlertSenderStatus => {
    pruneWindows();
    return {
      healthy: consecutiveFailures === 0,
      consecutiveFailures,
      lastFailureAt,
      lastSuccessAt,
      suppressedInWindow: suppressedAt.length,
      pendingBacklog: backlog.length,
    };
  };

  return { send, getStatus };
};
