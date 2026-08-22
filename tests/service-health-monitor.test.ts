import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  type EmailChannel,
  type EmailMessage,
  type MonitorClock,
  type OperationalAlert,
  createOperationalAlertSender,
  sendViaEmailChannels,
} from "../src/server/operationalAlerts.js";
import {
  DB_PROBE_TIMEOUT_MS,
  ERROR_RATE_BUCKET_COUNT,
  ERROR_RATE_BUCKET_MS,
  ServiceHealthMonitor,
} from "../src/server/serviceHealthMonitor.js";

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

// Structurally satisfies MonitorClock. Deliberately duplicated from
// tests/rss-runtime.test.ts rather than imported, because importing from that file
// would drag its whole suite into this one.
class FakeClock implements MonitorClock {
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

const recordingChannel = (name: EmailChannel["name"], sink: EmailMessage[]): EmailChannel => ({
  name,
  send: async message => {
    sink.push(message);
  },
});

const failingChannel = (name: EmailChannel["name"], reason: string): EmailChannel => ({
  name,
  send: async () => {
    throw new Error(reason);
  },
});

const alert = (kind: OperationalAlert["kind"], occurredAt = "2026-08-22T10:00:00.000Z"): OperationalAlert => ({
  kind,
  subject: `[AtomFlow] ${kind}`,
  message: `${kind} fired`,
  occurredAt,
});

// --- delivery channels -------------------------------------------------------

test("falls back to the next channel when the first one fails", async () => {
  const delivered: EmailMessage[] = [];
  const clock = new FakeClock();

  const result = await sendViaEmailChannels(
    [failingChannel("resend", "resend is down"), recordingChannel("smtp", delivered)],
    { to: "ops@example.com", subject: "s", text: "t" },
    { clock },
  );

  assert.equal(result.channel, "smtp");
  assert.equal(delivered.length, 1);
});

test("treats an API-layer rejection that does not throw as a channel failure", async () => {
  // Resend resolves with `{ data: null, error }` instead of throwing. A channel that
  // surfaces that as an exception must still fall through to the next transport.
  const delivered: EmailMessage[] = [];
  const clock = new FakeClock();
  const resendLike: EmailChannel = {
    name: "resend",
    send: async () => {
      const response = { data: null, error: { message: "domain is not verified" } };
      if (response.error) throw new Error(`Resend rejected the message: ${response.error.message}`);
    },
  };

  const result = await sendViaEmailChannels(
    [resendLike, recordingChannel("smtp", delivered)],
    { to: "ops@example.com", subject: "s", text: "t" },
    { clock },
  );

  assert.equal(result.channel, "smtp");
  assert.equal(delivered.length, 1);
});

test("rejects with every channel reason when all transports fail", async () => {
  const clock = new FakeClock();
  await assert.rejects(
    sendViaEmailChannels(
      [failingChannel("resend", "resend is down"), failingChannel("smtp", "smtp refused login")],
      { to: "ops@example.com", subject: "s", text: "t" },
      { clock },
    ),
    (error: Error) => {
      assert.match(error.message, /resend is down/);
      assert.match(error.message, /smtp refused login/);
      return true;
    },
  );
});

test("rejects when no transport is configured at all", async () => {
  await assert.rejects(
    sendViaEmailChannels([], { to: "ops@example.com", subject: "s", text: "t" }),
    /No email transport is configured/,
  );
});

test("times out a hanging channel and moves on to the next one", async () => {
  const clock = new FakeClock();
  const hanging = deferred();
  const delivered: EmailMessage[] = [];
  const stuckChannel: EmailChannel = { name: "resend", send: () => hanging.promise };

  const sending = sendViaEmailChannels(
    [stuckChannel, recordingChannel("smtp", delivered)],
    { to: "ops@example.com", subject: "s", text: "t" },
    { clock },
  );
  await flushPromises();
  assert.equal(delivered.length, 0, "must not try the fallback before the first channel times out");

  await clock.advanceBy(4000);
  assert.equal((await sending).channel, "smtp");
  assert.equal(clock.size, 0, "timeout timers must be cleared");

  // A late rejection from the abandoned attempt must stay handled: this process
  // logs unhandled rejections at fatal level.
  hanging.reject(new Error("late failure"));
  await flushPromises();
});

// --- alert sender: status, rate limiting, backlog ----------------------------

test("reports a healthy sender after a successful delivery", async () => {
  const delivered: EmailMessage[] = [];
  const clock = new FakeClock();
  const sender = createOperationalAlertSender({
    channels: [recordingChannel("resend", delivered)],
    recipient: "ops@example.com",
    clock,
  });

  await sender.send(alert("database-unreachable"));

  const status = sender.getStatus();
  assert.equal(status.healthy, true);
  assert.equal(status.consecutiveFailures, 0);
  assert.equal(status.pendingBacklog, 0);
  assert.notEqual(status.lastSuccessAt, null);
});

test("fails loudly when no recipient is configured", async () => {
  const sender = createOperationalAlertSender({
    channels: [recordingChannel("resend", [])],
    recipient: undefined,
    clock: new FakeClock(),
  });
  await assert.rejects(sender.send(alert("memory-warning")), /SECURITY_CONTACT_EMAIL is not configured/);
});

test("suppresses alerts past the hourly cap without marking the sender unhealthy", async () => {
  const delivered: EmailMessage[] = [];
  const clock = new FakeClock();
  const events: string[] = [];
  const sender = createOperationalAlertSender({
    channels: [recordingChannel("resend", delivered)],
    recipient: "ops@example.com",
    clock,
    maxPerHour: 2,
    onEvent: event => events.push(event.event),
  });

  await sender.send(alert("memory-warning"));
  await sender.send(alert("memory-paused"));
  await sender.send(alert("database-unreachable"));

  assert.equal(delivered.length, 2, "third alert must not be delivered");
  assert.deepEqual(events, ["alert-sent", "alert-sent", "alert-suppressed"]);

  const status = sender.getStatus();
  assert.equal(status.healthy, true, "rate limiting is intended behaviour, not a delivery failure");
  assert.equal(status.consecutiveFailures, 0);
  assert.equal(status.suppressedInWindow, 1);
  assert.equal(status.pendingBacklog, 1);
});

test("reports suppressed alerts in the next message that gets through", async () => {
  const delivered: EmailMessage[] = [];
  const clock = new FakeClock();
  const sender = createOperationalAlertSender({
    channels: [recordingChannel("resend", delivered)],
    recipient: "ops@example.com",
    clock,
    maxPerHour: 1,
  });

  await sender.send(alert("memory-warning", "2026-08-22T10:00:00.000Z"));
  await sender.send(alert("database-unreachable", "2026-08-22T10:05:00.000Z"));
  assert.equal(delivered.length, 1);

  await clock.advanceBy(60 * 60 * 1000 + 1000);
  await sender.send(alert("database-recovered", "2026-08-22T11:10:00.000Z"));

  assert.equal(delivered.length, 2);
  const body = delivered[1].text ?? "";
  assert.match(body, /1 earlier alert\(s\) were not delivered/);
  assert.match(body, /database-unreachable \(suppressed\)/);
  assert.equal(sender.getStatus().pendingBacklog, 0, "backlog clears once it has been reported");
});

test("carries a failed alert into the next successful message", async () => {
  const delivered: EmailMessage[] = [];
  const clock = new FakeClock();
  let transportUp = false;
  const flakyChannel: EmailChannel = {
    name: "resend",
    send: async message => {
      if (!transportUp) throw new Error("resend is down");
      delivered.push(message);
    },
  };
  const sender = createOperationalAlertSender({
    channels: [flakyChannel],
    recipient: "ops@example.com",
    clock,
  });

  await assert.rejects(sender.send(alert("database-unreachable", "2026-08-22T10:00:00.000Z")));
  let status = sender.getStatus();
  assert.equal(status.healthy, false);
  assert.equal(status.consecutiveFailures, 1);
  assert.equal(status.pendingBacklog, 1);
  assert.notEqual(status.lastFailureAt, null);

  transportUp = true;
  await sender.send(alert("database-recovered", "2026-08-22T10:10:00.000Z"));

  assert.equal(delivered.length, 1);
  assert.match(delivered[0].text ?? "", /database-unreachable \(failed\)/);
  status = sender.getStatus();
  assert.equal(status.healthy, true, "a success clears the failure streak");
  assert.equal(status.pendingBacklog, 0);
});

test("bounds the backlog so a long outage cannot grow it without limit", async () => {
  const clock = new FakeClock();
  const sender = createOperationalAlertSender({
    channels: [failingChannel("resend", "down")],
    recipient: "ops@example.com",
    clock,
  });

  for (let index = 0; index < 12; index += 1) {
    await assert.rejects(sender.send(alert("database-unreachable", `2026-08-22T10:${index}0:00.000Z`)));
  }

  assert.equal(sender.getStatus().pendingBacklog, 5);
  assert.equal(sender.getStatus().consecutiveFailures, 12);
});

// --- database probe ----------------------------------------------------------

type ProbeScript = { fail: boolean };

const buildMonitor = (script: ProbeScript, overrides: Record<string, unknown> = {}) => {
  const clock = new FakeClock();
  const alerts: OperationalAlert[] = [];
  let probeCalls = 0;
  const monitor = new ServiceHealthMonitor({
    probeDatabase: async () => {
      probeCalls += 1;
      if (script.fail) throw new Error("connection refused");
      return { rows: [] };
    },
    sendAlert: async candidate => {
      alerts.push(candidate);
    },
    clock,
    ...overrides,
  });
  return { monitor, clock, alerts, probeCalls: () => probeCalls };
};

test("alerts only after the database has failed three consecutive probes", async () => {
  const script: ProbeScript = { fail: true };
  const { monitor, alerts } = buildMonitor(script);

  await monitor.runTick();
  assert.equal(alerts.length, 0);
  await monitor.runTick();
  assert.equal(alerts.length, 0, "a two-probe blip must not page anyone");

  await monitor.runTick();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "database-unreachable");
  assert.equal(monitor.getStatus().database.reachable, false);
  assert.equal(monitor.getStatus().database.consecutiveFailures, 3);
});

test("does not repeat the database alert while the outage continues", async () => {
  const script: ProbeScript = { fail: true };
  const { monitor, alerts } = buildMonitor(script);
  for (let index = 0; index < 8; index += 1) await monitor.runTick();
  assert.equal(alerts.length, 1);
});

test("sends exactly one recovery alert once the database comes back", async () => {
  const script: ProbeScript = { fail: true };
  const { monitor, alerts } = buildMonitor(script);
  for (let index = 0; index < 3; index += 1) await monitor.runTick();
  assert.equal(alerts.length, 1);

  script.fail = false;
  await monitor.runTick();
  assert.equal(alerts.length, 1, "one good probe is not enough to declare recovery");

  await monitor.runTick();
  assert.equal(alerts.length, 2);
  assert.equal(alerts[1].kind, "database-recovered");

  const status = monitor.getStatus();
  assert.equal(status.database.reachable, true);
  assert.equal(status.database.consecutiveFailures, 0);
  assert.equal(status.database.alerted, false);

  // The whole cycle can happen again.
  script.fail = true;
  for (let index = 0; index < 3; index += 1) await monitor.runTick();
  assert.equal(alerts.length, 3);
  assert.equal(alerts[2].kind, "database-unreachable");
});

test("a single failure followed by a success never alerts", async () => {
  const script: ProbeScript = { fail: true };
  const { monitor, alerts } = buildMonitor(script);
  await monitor.runTick();
  script.fail = false;
  await monitor.runTick();
  assert.equal(alerts.length, 0);
  assert.equal(monitor.getStatus().database.consecutiveFailures, 0);
});

test("counts a hanging probe as a timeout failure without deadlocking the tick", async () => {
  const clock = new FakeClock();
  const hanging = deferred();
  const monitor = new ServiceHealthMonitor({
    probeDatabase: () => hanging.promise,
    clock,
  });

  const tick = monitor.runTick();
  await flushPromises();
  assert.equal(monitor.getStatus().database.consecutiveFailures, 0, "still in flight");

  await clock.advanceBy(DB_PROBE_TIMEOUT_MS);
  await tick;

  const status = monitor.getStatus();
  assert.equal(status.database.consecutiveFailures, 1);
  assert.equal(status.database.lastErrorKind, "timeout");
  assert.equal(clock.size, 0, "the timeout timer must be cleared");

  // The abandoned probe rejecting late must stay handled: unhandled rejections are
  // logged at fatal level by this process.
  hanging.reject(new Error("late connection error"));
  await flushPromises();
});

test("never stores the raw probe error, which would leak through the public health endpoint", async () => {
  const { monitor } = buildMonitor({ fail: true });
  await monitor.runTick();
  const serialized = JSON.stringify(monitor.getStatus());
  assert.doesNotMatch(serialized, /connection refused/);
  assert.match(serialized, /"lastErrorKind":"query-failed"/);
});

test("skips the probe when the previous one is still in flight", async () => {
  const clock = new FakeClock();
  const hanging = deferred();
  let probeCalls = 0;
  const monitor = new ServiceHealthMonitor({
    probeDatabase: () => {
      probeCalls += 1;
      return hanging.promise;
    },
    clock,
  });

  const first = monitor.runTick();
  await flushPromises();
  await monitor.runTick();
  assert.equal(probeCalls, 1, "overlapping ticks must not stack probes");

  await clock.advanceBy(DB_PROBE_TIMEOUT_MS);
  await first;
  hanging.reject(new Error("late"));
  await flushPromises();
});

test("shutdown leaves no pending timers behind", async () => {
  const { monitor, clock } = buildMonitor({ fail: false });
  monitor.start();
  assert.ok(clock.size > 0);
  monitor.shutdown();
  assert.equal(clock.size, 0);
  assert.equal(monitor.getStatus().started, false);
});

test("a failing alert transport does not stop the monitoring loop", async () => {
  const clock = new FakeClock();
  let probeCalls = 0;
  const monitor = new ServiceHealthMonitor({
    probeDatabase: async () => {
      probeCalls += 1;
      throw new Error("connection refused");
    },
    sendAlert: async () => {
      throw new Error("both channels down");
    },
    clock,
  });

  for (let index = 0; index < 4; index += 1) await monitor.runTick();
  assert.equal(probeCalls, 4);
  assert.equal(monitor.getStatus().database.consecutiveFailures, 4);
});

// --- error rate --------------------------------------------------------------

const errorRateMonitor = (overrides: Record<string, unknown> = {}) => {
  const clock = new FakeClock();
  const alerts: OperationalAlert[] = [];
  const monitor = new ServiceHealthMonitor({
    probeDatabase: async () => ({ rows: [] }),
    sendAlert: async candidate => {
      alerts.push(candidate);
    },
    clock,
    errorRateThreshold: 0.1,
    errorRateMinRequests: 20,
    ...overrides,
  });
  return { monitor, clock, alerts };
};

const record = (monitor: ServiceHealthMonitor, statusCode: number, times: number) => {
  for (let index = 0; index < times; index += 1) monitor.recordResponse(statusCode);
};

test("ignores a high error ratio that is below the minimum sample size", async () => {
  const { monitor, alerts } = errorRateMonitor();
  record(monitor, 500, 5);
  await monitor.runTick();
  assert.equal(alerts.length, 0, "five requests must not be enough to page on 100% errors");
  assert.equal(monitor.getStatus().errorRate.ratio, 1);
});

test("alerts once the error ratio and the sample size are both met", async () => {
  const { monitor, alerts } = errorRateMonitor();
  record(monitor, 200, 16);
  record(monitor, 500, 4);
  await monitor.runTick();

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "error-rate-high");
  assert.match(alerts[0].message, /4 of 20/);
});

test("stays quiet when enough traffic sits below the threshold", async () => {
  const { monitor, alerts } = errorRateMonitor();
  record(monitor, 200, 39);
  record(monitor, 500, 1);
  await monitor.runTick();
  assert.equal(alerts.length, 0);
});

test("counts 4xx in the denominator but not in the numerator", async () => {
  const { monitor } = errorRateMonitor();
  record(monitor, 404, 19);
  record(monitor, 500, 1);
  const status = monitor.getStatus();
  assert.equal(status.errorRate.totalRequests, 20);
  assert.equal(status.errorRate.serverErrors, 1);
  assert.equal(status.errorRate.ratio, 0.05);
});

test("does not repeat the error-rate alert across evaluations", async () => {
  const { monitor, alerts } = errorRateMonitor();
  record(monitor, 500, 20);
  await monitor.runTick();
  await monitor.runTick();
  await monitor.runTick();
  assert.equal(alerts.length, 1);
});

test("recovers only after two consecutive healthy evaluations", async () => {
  const { monitor, clock, alerts } = errorRateMonitor();
  record(monitor, 500, 20);
  await monitor.runTick();
  assert.equal(alerts.length, 1);

  // Let the bad window age out entirely, then serve clean traffic.
  await clock.advanceBy(ERROR_RATE_BUCKET_MS * (ERROR_RATE_BUCKET_COUNT + 1));
  record(monitor, 200, 30);
  await monitor.runTick();
  assert.equal(alerts.length, 1, "one clean evaluation is not enough");

  await monitor.runTick();
  assert.equal(alerts.length, 2);
  assert.equal(alerts[1].kind, "error-rate-recovered");
  assert.equal(monitor.getStatus().errorRate.alerted, false);
});

test("an empty window counts as recovery so the alert cannot latch when traffic stops", async () => {
  const { monitor, clock, alerts } = errorRateMonitor();
  record(monitor, 500, 20);
  await monitor.runTick();
  assert.equal(alerts.length, 1);

  await clock.advanceBy(ERROR_RATE_BUCKET_MS * (ERROR_RATE_BUCKET_COUNT + 1));
  await monitor.runTick();
  await monitor.runTick();

  assert.equal(alerts.length, 2);
  assert.equal(alerts[1].kind, "error-rate-recovered");
});

test("ring buckets expire on their own without a sweep timer", async () => {
  const { monitor, clock } = errorRateMonitor();
  record(monitor, 500, 20);
  assert.equal(monitor.getStatus().errorRate.totalRequests, 20);

  await clock.advanceBy(ERROR_RATE_BUCKET_MS * ERROR_RATE_BUCKET_COUNT * 2);
  assert.equal(monitor.getStatus().errorRate.totalRequests, 0);
  assert.equal(clock.size, 0, "expiry must not need a timer");
});

test("evaluates the error rate before probing so a stalled database cannot delay it", async () => {
  const clock = new FakeClock();
  const hanging = deferred();
  const alerts: OperationalAlert[] = [];
  const monitor = new ServiceHealthMonitor({
    probeDatabase: () => hanging.promise,
    sendAlert: async candidate => {
      alerts.push(candidate);
    },
    clock,
    errorRateThreshold: 0.1,
    errorRateMinRequests: 20,
  });

  record(monitor, 500, 20);
  const tick = monitor.runTick();
  await flushPromises();
  assert.equal(alerts.length, 1, "the error-rate alert must not wait on the database probe");

  await clock.advanceBy(DB_PROBE_TIMEOUT_MS);
  await tick;
  hanging.reject(new Error("late"));
  await flushPromises();
});

// --- static wiring checks ----------------------------------------------------

const serverSource = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
const emailChannelsSource = readFileSync(new URL("../src/server/emailChannels.ts", import.meta.url), "utf8");
const alertTestScriptSource = readFileSync(new URL("../scripts/send-test-alert.ts", import.meta.url), "utf8");

test("server routes RSS alert-delivery failures to the error log level", () => {
  assert.match(serverSource, /"memory-alert-failed":\s*"error"/);
  assert.match(serverSource, /logger\[RSS_EVENT_LOG_LEVEL\[event\.event\]\]/);
});

test("server checks the Resend error field instead of assuming a resolved send succeeded", () => {
  assert.match(emailChannelsSource, /if \(result\.error\) throw new Error\(`Resend rejected the message/);
});

test("the live alert smoke script is explicit and uses the production delivery path", () => {
  assert.match(alertTestScriptSource, /ALLOW_LIVE_ALERT_TEST !== "true"/);
  assert.match(alertTestScriptSource, /createConfiguredEmailChannels\(\)/);
  assert.match(alertTestScriptSource, /createOperationalAlertSender\(/);
  assert.match(alertTestScriptSource, /SECURITY_CONTACT_EMAIL/);
});

test("login and registration verification emails use provider fallback and remove failed records", () => {
  const loginRoute = serverSource.slice(
    serverSource.indexOf('app.post("/api/auth/send-code"'),
    serverSource.indexOf('app.post("/api/auth/verify"'),
  );
  const registrationRoute = serverSource.slice(
    serverSource.indexOf('app.post("/api/auth/register"'),
    serverSource.indexOf('app.post("/api/auth/register/verify"'),
  );

  for (const [name, route] of [["login", loginRoute], ["registration", registrationRoute]] as const) {
    assert.match(route, /RETURNING id/, `${name} must retain the inserted record id for cleanup`);
    assert.match(route, /await sendViaEmailChannels\(/, `${name} must use Resend-to-SMTP fallback`);
    assert.match(
      route,
      /DELETE FROM verification_codes WHERE id = \$1/,
      `${name} must remove an undeliverable code so an immediate retry is not rate-limited`,
    );
    assert.doesNotMatch(route, /resend\.emails\.send/, `${name} must not bypass the shared provider checks`);
  }
});

test("health endpoint exposes alert health without leaking the failure reason", () => {
  assert.match(serverSource, /alerting: \{\s*\n\s*healthy: alertingStatus\.healthy/);
  assert.doesNotMatch(serverSource, /alerting:[\s\S]{0,200}lastAlertError/);
});

test("alert health is attached to the 200 response, never to a failure status", () => {
  // Railway gates deploys on /api/health, so a broken notification path must not
  // be able to make this route fail and restart the container.
  const healthHandler = serverSource.slice(
    serverSource.indexOf('app.get("/api/health"'),
    serverSource.indexOf('app.get("/api/health"') + 2000,
  );
  const okIndex = healthHandler.indexOf('status: "ok"');
  const alertingIndex = healthHandler.indexOf("alerting: {");
  assert.ok(okIndex > 0 && alertingIndex > okIndex, "alerting must sit inside the status:ok payload");

  const unhealthyBranch = healthHandler.slice(0, healthHandler.indexOf("await pool.query"));
  assert.match(unhealthyBranch, /status\(503\)/, "sanity: the 503 branch is where we think it is");
  assert.doesNotMatch(unhealthyBranch, /alerting/, "the 503 branch must not carry alert state");
});

test("log sanitiser redacts API-key shaped tokens", () => {
  assert.match(serverSource, /\(\?:re\|sk\|pk\|rk\)_\[A-Za-z0-9_-\]\{8,\}/);
});

test("the response counter is mounted before the billing webhook routes", () => {
  const counterIndex = serverSource.indexOf("serviceHealthMonitor?.recordResponse");
  const paddleIndex = serverSource.indexOf('app.post("/api/billing/webhooks/paddle"');
  const pinoIndex = serverSource.indexOf("app.use(pinoHttp(");
  assert.ok(counterIndex > 0 && paddleIndex > 0 && pinoIndex > 0);
  assert.ok(counterIndex < paddleIndex, "webhook responses must be counted");
  assert.ok(counterIndex < pinoIndex, "counting must not depend on pino-http running");
});

test("the response counter skips the health endpoint", () => {
  assert.match(serverSource, /pathname === "\/api\/health"\) return;/);
});

test("the health monitor is torn down during graceful shutdown", () => {
  assert.match(serverSource, /rssRuntime\?\.shutdown\(\);\s*\n\s*serviceHealthMonitor\?\.shutdown\(\);/);
});

test("the database probe deliberately skips advisory-lock leader election", () => {
  const constructionIndex = serverSource.indexOf("new ServiceHealthMonitor(");
  const block = serverSource.slice(constructionIndex - 600, constructionIndex + 400);
  assert.match(block, /no pg_try_advisory_xact_lock leader election/);
  assert.doesNotMatch(block, /pg_try_advisory_xact_lock\(hashtext/);
});

// --- documentation sync ------------------------------------------------------

const envExample = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
const deploymentGuide = readFileSync(new URL("../DEPLOYMENT.md", import.meta.url), "utf8");
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

const MONITORING_ENV_DEFAULTS = [
  ["DB_PROBE_INTERVAL_SECONDS", "30"],
  ["ERROR_RATE_THRESHOLD_PERCENT", "10"],
  ["ERROR_RATE_MIN_REQUESTS", "20"],
  ["ALERT_MAX_PER_HOUR", "10"],
] as const;

for (const [variable, expected] of MONITORING_ENV_DEFAULTS) {
  test(`${variable} is documented everywhere it needs to be`, () => {
    assert.match(envExample, new RegExp(`^${variable}=${expected}$`, "m"), `.env.example must document ${variable} with its code default`);
    assert.match(deploymentGuide, new RegExp(variable), `${variable} must be covered by the deployment guide`);
    assert.match(readme, new RegExp(variable), `${variable} must be covered by the README`);
    assert.match(
      serverSource,
      new RegExp(`process\\.env\\.${variable}, ${expected},`),
      `${variable} default in server.ts must match the documented value`,
    );
  });
}

test("the SMTP fallback credentials are documented in .env.example", () => {
  // They were read at runtime but missing from the example file, so a fresh
  // deployment had no way to know the fallback channel existed.
  assert.match(envExample, /^SMTP_USER=/m);
  assert.match(envExample, /^SMTP_PASS=/m);
});

test("the deployment guide records what Railway can and cannot alert on", () => {
  // Railway has no log-based alerting, and Monitors are Pro-only, so the guide has
  // to spell out that project webhooks are the only platform-side mechanism.
  assert.match(deploymentGuide, /Deployment\.failed/);
  assert.match(deploymentGuide, /Deployment\.crashed/);
  assert.match(deploymentGuide, /没有基于日志的告警功能/);
  assert.match(deploymentGuide, /Monitors[^\n]*Pro 套餐/);
});
