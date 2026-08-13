import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import path from "node:path";
import { WebSocket } from "ws";
import JSZip from "jszip";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import ts from "typescript";
import {
  ConcurrencyLimitError,
  ResponseLimitError,
  buildAllowedOrigins,
  createPinnedLookup,
  createUserConcurrencyGuard,
  fetchBoundedPublicResource,
  isAllowedMutationOrigin,
  isAllowedUploadSignature,
  isPrivateOrReservedIp,
  parseDevProxyUrl,
  readBoundedEnvNumber,
  readResponseBuffer,
  resolvePublicHttpUrl,
  validateDocxArchiveBounds,
  validatePublicHttpUrl,
} from "../src/server/security.js";
import { canChangePassword, isRecentAuthentication } from "../src/server/accountSecurity.js";
import { extractCardsForUser } from "../src/server/articleCardExtraction.js";

assert.equal(readBoundedEnvNumber(undefined, 10, 1, 20), 10);
assert.equal(readBoundedEnvNumber("15", 10, 1, 20), 15);
assert.equal(readBoundedEnvNumber("999", 10, 1, 20), 20);
assert.equal(readBoundedEnvNumber("invalid", 10, 1, 20), 10);

for (const address of [
  "0.0.0.0",
  "10.0.0.1",
  "100.64.0.1",
  "127.0.0.1",
  "169.254.1.1",
  "172.16.0.1",
  "192.168.1.1",
  "198.18.0.1",
  "198.19.255.254",
  "198.51.100.4",
  "203.0.113.8",
  "224.0.0.1",
  "::",
  "::1",
  "::10.0.0.1",
  "::127.0.0.1",
  "::169.254.169.254",
  "::198.18.0.1",
  "::ffff:127.0.0.1",
  "::ffff:0:10.0.0.1",
  "::ffff:0:127.0.0.1",
  "::ffff:0:169.254.169.254",
  "64:ff9b::a9fe:a9fe",
  "64:ff9b:1::a9fe:a9fe",
  "100:0:0:1::1",
  "2001:2::1",
  "3fff::1",
  "5f00::1",
  "fc00::1",
  "fe80::1",
  "2001:db8::1",
]) {
  assert.equal(isPrivateOrReservedIp(address), true, `${address} must be blocked`);
}
assert.equal(isPrivateOrReservedIp("1.1.1.1"), false);
assert.equal(isPrivateOrReservedIp("2606:4700:4700::1111"), false);

const pinnedLookup = createPinnedLookup("198.18.0.1");
await new Promise<void>((resolve, reject) => {
  pinnedLookup("feeds.example.com", { all: true }, (error, addresses) => {
    if (error) return reject(error);
    try {
      assert.deepEqual(addresses, [{ address: "198.18.0.1", family: 4 }]);
      resolve();
    } catch (assertionError) {
      reject(assertionError);
    }
  });
});
await new Promise<void>((resolve, reject) => {
  pinnedLookup("feeds.example.com", { all: false }, (error, address, family) => {
    if (error) return reject(error);
    try {
      assert.equal(address, "198.18.0.1");
      assert.equal(family, 4);
      resolve();
    } catch (assertionError) {
      reject(assertionError);
    }
  });
});

assert.equal(parseDevProxyUrl("http://127.0.0.1:7897").href, "http://127.0.0.1:7897/");
assert.equal(parseDevProxyUrl("http://[::1]:7897").href, "http://[::1]:7897/");
for (const proxyUrl of [
  "https://127.0.0.1:7897",
  "http://localhost:7897",
  "http://10.0.0.1:7897",
  "http://proxy.example:7897",
  "http://user:pass@127.0.0.1:7897",
  "http://127.0.0.1:7897/path",
]) {
  assert.throws(() => parseDevProxyUrl(proxyUrl), /proxy/i, `${proxyUrl} must not be accepted as a local development proxy`);
}

const publicUrl = await validatePublicHttpUrl("https://feeds.example.com/rss", {
  lookup: async hostname => {
    assert.equal(hostname, "feeds.example.com");
    return ["1.1.1.1", "2606:4700:4700::1111"];
  },
});
assert.equal(publicUrl.href, "https://feeds.example.com/rss");

const withClashFakeIpEnvironment = async (
  nodeEnv: string | undefined,
  enabled: string | undefined,
  operation: () => Promise<void>,
) => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousEnabled = process.env.ALLOW_DEV_PROXY_FAKE_IP;
  try {
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
    if (enabled === undefined) delete process.env.ALLOW_DEV_PROXY_FAKE_IP;
    else process.env.ALLOW_DEV_PROXY_FAKE_IP = enabled;
    await operation();
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousEnabled === undefined) delete process.env.ALLOW_DEV_PROXY_FAKE_IP;
    else process.env.ALLOW_DEV_PROXY_FAKE_IP = previousEnabled;
  }
};

await withClashFakeIpEnvironment("production", "true", async () => {
  await assert.rejects(
    () => validatePublicHttpUrl("https://feeds.example.com/rss", { lookup: async () => ["198.18.0.1"] }),
    /private|reserved/i,
    "Production must reject Clash Fake-IP results even when the flag is set",
  );
});

await withClashFakeIpEnvironment("development", "false", async () => {
  await assert.rejects(
    () => validatePublicHttpUrl("https://feeds.example.com/rss", { lookup: async () => ["198.18.0.1"] }),
    /private|reserved/i,
    "Development must reject Clash Fake-IP results unless explicitly enabled",
  );
});

await withClashFakeIpEnvironment("development", "true", async () => {
  for (const address of ["198.18.0.1", "198.19.255.254"]) {
    const trustedAddresses = ["1.1.1.1", "2606:4700:4700::1111"];
    const resolved = await resolvePublicHttpUrl("https://feeds.example.com/rss", {
      lookup: async hostname => {
        assert.equal(hostname, "feeds.example.com");
        return [address];
      },
      trustedPublicLookup: async hostname => {
        assert.equal(hostname, "feeds.example.com");
        return trustedAddresses;
      },
    });
    assert.equal(resolved.parsed.hostname, "feeds.example.com", `${address} may be accepted only as a DNS result in local development`);
    assert.deepEqual(
      resolved.addresses,
      trustedAddresses,
      "The connection must pin the independently verified public addresses, never the Clash Fake-IP",
    );
  }

  for (const literalAddress of ["198.18.0.1", "198.19.255.254", "10.0.0.1", "192.168.1.1", "169.254.169.254"]) {
    await assert.rejects(
      () => validatePublicHttpUrl(`http://${literalAddress}/rss`, {
        lookup: async () => { throw new Error("Literal IPs must not use DNS lookup"); },
      }),
      /private|reserved/i,
      `${literalAddress} must remain blocked when submitted directly`,
    );
  }

  await assert.rejects(
    () => validatePublicHttpUrl("http://localhost/admin", { lookup: async () => ["198.18.0.1"] }),
    /hostname|private|reserved/i,
    "localhost must remain blocked when the local exception is enabled",
  );

  for (const literalUrl of [
    "http://[::1]/admin",
    "http://[::10.0.0.1]/admin",
    "http://[::127.0.0.1]/admin",
    "http://[::169.254.169.254]/latest/meta-data",
    "http://[::198.18.0.1]/admin",
    "http://[::ffff:127.0.0.1]/admin",
    "http://[::ffff:0:10.0.0.1]/admin",
    "http://[::ffff:0:127.0.0.1]/admin",
    "http://[::ffff:0:169.254.169.254]/latest/meta-data",
    "http://[64:ff9b::a9fe:a9fe]/latest/meta-data",
    "http://[64:ff9b:1::a9fe:a9fe]/latest/meta-data",
    "http://[fc00::1]/admin",
    "http://[fe80::1]/admin",
  ]) {
    let literalLookupCalled = false;
    await assert.rejects(
      () => validatePublicHttpUrl(literalUrl, {
        lookup: async () => {
          literalLookupCalled = true;
          return ["198.18.0.1"];
        },
        trustedPublicLookup: async () => ["1.1.1.1"],
      }),
      /private|reserved/i,
      `${literalUrl} must remain blocked as a literal IPv6 target`,
    );
    assert.equal(literalLookupCalled, false, "Literal IPv6 targets must not be sent through DNS");
  }

  for (const [hostname, address] of [
    ["private-10.example", "10.0.0.1"],
    ["private-192.example", "192.168.1.1"],
    ["metadata.google.internal", "169.254.169.254"],
  ] as const) {
    await assert.rejects(
      () => validatePublicHttpUrl(`https://${hostname}/rss`, { lookup: async () => [address] }),
      /hostname|public|private|reserved/i,
      `${hostname} resolving to ${address} must remain blocked`,
    );
  }

  await assert.rejects(
    () => validatePublicHttpUrl("https://mixed.example/rss", {
      lookup: async () => ["198.18.0.1", "10.0.0.1"],
      trustedPublicLookup: async () => ["1.1.1.1"],
    }),
    /private|reserved/i,
    "One Clash Fake-IP result must not mask another private DNS result",
  );

  for (const [hostname, trustedAddress] of [
    ["metadata.google.internal", "169.254.169.254"],
    ["host.docker.internal", "192.168.65.2"],
    ["attacker.example", "10.0.0.8"],
  ] as const) {
    await assert.rejects(
      () => validatePublicHttpUrl(`https://${hostname}/rss`, {
        lookup: async () => ["198.18.0.1"],
        trustedPublicLookup: async () => [trustedAddress],
      }),
      /public|private|reserved/i,
      `${hostname} hidden behind Clash Fake-IP must still be rejected`,
    );
  }

  await assert.rejects(
    () => validatePublicHttpUrl("https://unverifiable.example/rss", {
      lookup: async () => ["198.18.0.1"],
      trustedPublicLookup: async () => { throw new Error("trusted DNS unavailable"); },
    }),
    /public|DNS|unavailable/i,
    "The local exception must fail closed when independent public DNS verification is unavailable",
  );

  let redirectFetchCalls = 0;
  await assert.rejects(
    () => fetchBoundedPublicResource("https://feeds.example.com/start", {
      timeoutMs: 1000,
      maxBytes: 1024,
      maxRedirects: 2,
      lookup: async () => ["198.18.0.1"],
      trustedPublicLookup: async () => ["1.1.1.1"],
      fetchImpl: async () => {
        redirectFetchCalls += 1;
        return new Response(null, { status: 302, headers: { location: "http://198.18.0.2/internal" } });
      },
    }),
    /private|reserved/i,
    "Redirects to literal Fake-IP targets must remain blocked",
  );
  assert.equal(redirectFetchCalls, 1, "A blocked redirect target must not be fetched");

  let metadataRedirectFetchCalls = 0;
  await assert.rejects(
    () => fetchBoundedPublicResource("https://feeds.example.com/start", {
      timeoutMs: 1000,
      maxBytes: 1024,
      maxRedirects: 2,
      lookup: async () => ["198.18.0.1"],
      trustedPublicLookup: async hostname => hostname === "feeds.example.com" ? ["1.1.1.1"] : ["169.254.169.254"],
      fetchImpl: async () => {
        metadataRedirectFetchCalls += 1;
        if (metadataRedirectFetchCalls === 1) {
          return new Response(null, { status: 302, headers: { location: "http://metadata.google.internal/latest/meta-data" } });
        }
        return new Response("secret", { status: 200 });
      },
    }),
    /public|private|reserved/i,
    "Redirects to metadata hostnames hidden by Fake-IP must remain blocked",
  );
  assert.equal(metadataRedirectFetchCalls, 1, "A metadata hostname behind Fake-IP must not be fetched");

  let proxyFirstRequest = "";
  let tunneledRequest = "";
  const proxyServer = createServer(socket => {
    let stage: "proxy" | "tunnel" = "proxy";
    let buffered = "";
    socket.on("data", chunk => {
      buffered += chunk.toString("latin1");
      const headerEnd = buffered.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const headers = buffered.slice(0, headerEnd + 4);
      buffered = buffered.slice(headerEnd + 4);
      if (stage === "proxy") {
        proxyFirstRequest = headers;
        if (headers.startsWith("CONNECT ")) {
          stage = "tunnel";
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          return;
        }
        socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Type: text/plain\r\n\r\nok");
        return;
      }
      tunneledRequest = headers;
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Type: text/plain\r\n\r\nok");
    });
  });
  await new Promise<void>((resolve, reject) => {
    proxyServer.once("error", reject);
    proxyServer.listen(0, "127.0.0.1", resolve);
  });
  const proxyAddress = proxyServer.address();
  assert.ok(proxyAddress && typeof proxyAddress === "object");
  const previousDevProxyUrl = process.env.DEV_PROXY_URL;
  process.env.DEV_PROXY_URL = `http://127.0.0.1:${proxyAddress.port}`;
  try {
    const proxiedHttpResource = await fetchBoundedPublicResource("http://public.example/rss", {
      timeoutMs: 1000,
      maxBytes: 1024,
      maxRedirects: 0,
      lookup: async () => ["198.18.0.1"],
      trustedPublicLookup: async () => ["1.1.1.1"],
    });
    assert.equal(proxiedHttpResource.status, 200);
    assert.equal(proxiedHttpResource.body.toString("utf8"), "ok");
  } finally {
    if (previousDevProxyUrl === undefined) delete process.env.DEV_PROXY_URL;
    else process.env.DEV_PROXY_URL = previousDevProxyUrl;
    await new Promise<void>((resolve, reject) => proxyServer.close(error => error ? reject(error) : resolve()));
  }
  assert.match(proxyFirstRequest, /^CONNECT 1\.1\.1\.1:80 HTTP\/1\.1\r\n/, "HTTP targets must tunnel to the independently verified IP");
  assert.match(tunneledRequest, /^GET \/rss HTTP\/1\.1\r\n/, "HTTP requests inside the tunnel must use origin-form paths");
  assert.match(tunneledRequest, /\r\nHost: public\.example\r\n/i, "The original hostname must be preserved only as the HTTP Host header");

  const blackholeSockets = new Set<Socket>();
  let blackholeConnectRequest = "";
  const blackholeProxy = createServer(socket => {
    blackholeSockets.add(socket);
    socket.once("close", () => blackholeSockets.delete(socket));
    socket.once("data", chunk => {
      blackholeConnectRequest = chunk.toString("latin1");
    });
  });
  await new Promise<void>((resolve, reject) => {
    blackholeProxy.once("error", reject);
    blackholeProxy.listen(0, "127.0.0.1", resolve);
  });
  const blackholeAddress = blackholeProxy.address();
  assert.ok(blackholeAddress && typeof blackholeAddress === "object");
  const previousBlackholeProxyUrl = process.env.DEV_PROXY_URL;
  process.env.DEV_PROXY_URL = `http://127.0.0.1:${blackholeAddress.port}`;
  const blackholeStartedAt = Date.now();
  try {
    const boundedResult = fetchBoundedPublicResource("https://public.example/rss", {
      timeoutMs: 100,
      maxBytes: 1024,
      maxRedirects: 0,
      lookup: async () => ["198.18.0.1"],
      trustedPublicLookup: async () => ["1.1.1.1"],
    }).then(
      () => ({ outcome: "resolved" as const, error: null }),
      error => ({ outcome: "rejected" as const, error }),
    );
    const result = await Promise.race([
      boundedResult,
      new Promise<{ outcome: "pending"; error: null }>(resolve => {
        setTimeout(() => resolve({ outcome: "pending", error: null }), 750);
      }),
    ]);
    assert.equal(result.outcome, "rejected", "A proxy that never completes CONNECT must not leave the request pending");
    assert.match(String(result.error), /timed out|timeout/i);
    assert.ok(Date.now() - blackholeStartedAt < 750, "The wall-clock timeout must cover proxy CONNECT negotiation");
    assert.match(
      blackholeConnectRequest,
      /^CONNECT 1\.1\.1\.1:443 HTTP\/1\.1\r\n/,
      "HTTPS targets must remain pinned to the independently verified public IP",
    );
  } finally {
    if (previousBlackholeProxyUrl === undefined) delete process.env.DEV_PROXY_URL;
    else process.env.DEV_PROXY_URL = previousBlackholeProxyUrl;
    for (const socket of blackholeSockets) socket.destroy();
    await new Promise<void>((resolve, reject) => blackholeProxy.close(error => error ? reject(error) : resolve()));
  }

  const oversizedHeaderSockets = new Set<Socket>();
  const oversizedHeaderProxy = createServer(socket => {
    oversizedHeaderSockets.add(socket);
    socket.once("close", () => oversizedHeaderSockets.delete(socket));
    socket.once("data", () => {
      socket.write(`HTTP/1.1 200 Connection Established\r\nX-Fill: ${"x".repeat(20 * 1024)}`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    oversizedHeaderProxy.once("error", reject);
    oversizedHeaderProxy.listen(0, "127.0.0.1", resolve);
  });
  const oversizedHeaderAddress = oversizedHeaderProxy.address();
  assert.ok(oversizedHeaderAddress && typeof oversizedHeaderAddress === "object");
  const previousOversizedHeaderProxyUrl = process.env.DEV_PROXY_URL;
  process.env.DEV_PROXY_URL = `http://127.0.0.1:${oversizedHeaderAddress.port}`;
  try {
    await assert.rejects(
      () => fetchBoundedPublicResource("http://public.example/rss", {
        timeoutMs: 1000,
        maxBytes: 1024,
        maxRedirects: 0,
        lookup: async () => ["198.18.0.1"],
        trustedPublicLookup: async () => ["1.1.1.1"],
      }),
      /headers are too large/i,
      "An oversized proxy CONNECT response must be rejected before it can consume unbounded memory",
    );
  } finally {
    if (previousOversizedHeaderProxyUrl === undefined) delete process.env.DEV_PROXY_URL;
    else process.env.DEV_PROXY_URL = previousOversizedHeaderProxyUrl;
    for (const socket of oversizedHeaderSockets) socket.destroy();
    await new Promise<void>((resolve, reject) => oversizedHeaderProxy.close(error => error ? reject(error) : resolve()));
  }

  let expiredDeadlineProxyConnections = 0;
  const expiredDeadlineProxy = createServer(socket => {
    expiredDeadlineProxyConnections += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    expiredDeadlineProxy.once("error", reject);
    expiredDeadlineProxy.listen(0, "127.0.0.1", resolve);
  });
  const expiredDeadlineProxyAddress = expiredDeadlineProxy.address();
  assert.ok(expiredDeadlineProxyAddress && typeof expiredDeadlineProxyAddress === "object");
  const previousExpiredDeadlineProxyUrl = process.env.DEV_PROXY_URL;
  process.env.DEV_PROXY_URL = `http://127.0.0.1:${expiredDeadlineProxyAddress.port}`;
  try {
    await assert.rejects(
      () => fetchBoundedPublicResource("https://late-fake-ip.example/rss", {
        timeoutMs: 30,
        maxBytes: 1024,
        maxRedirects: 0,
        lookup: async () => {
          await new Promise(resolve => setTimeout(resolve, 70));
          return ["198.18.0.1"];
        },
      }),
      /timed out|timeout/i,
      "An expired fetch must reject before starting a trusted-DNS proxy request",
    );
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(
      expiredDeadlineProxyConnections,
      0,
      "An operation that resolves after its deadline must not leave a proxy CONNECT running",
    );
  } finally {
    if (previousExpiredDeadlineProxyUrl === undefined) delete process.env.DEV_PROXY_URL;
    else process.env.DEV_PROXY_URL = previousExpiredDeadlineProxyUrl;
    await new Promise<void>((resolve, reject) => expiredDeadlineProxy.close(error => error ? reject(error) : resolve()));
  }
});

const unresolvedLookupStartedAt = Date.now();
await assert.rejects(
  () => fetchBoundedPublicResource("https://never-resolves.example/rss", {
    timeoutMs: 50,
    maxBytes: 1024,
    maxRedirects: 2,
    lookup: async () => new Promise<string[]>(() => {}),
  }),
  /timed out|timeout/i,
  "The fetch deadline must include DNS resolution",
);
assert.ok(Date.now() - unresolvedLookupStartedAt < 250, "DNS resolution must not outlive the public fetch deadline");

const redirectDeadlineStartedAt = Date.now();
await assert.rejects(
  () => fetchBoundedPublicResource("https://redirect-deadline.example/0", {
    timeoutMs: 75,
    maxBytes: 1024,
    maxRedirects: 5,
    lookup: async () => ["1.1.1.1"],
    fetchImpl: async input => {
      await new Promise(resolve => setTimeout(resolve, 45));
      const current = Number(new URL(input).pathname.slice(1) || 0);
      return new Response(null, {
        status: 302,
        headers: { location: `https://redirect-deadline.example/${current + 1}` },
      });
    },
  }),
  /timed out|timeout/i,
  "Redirect hops must share one absolute fetch deadline",
);
assert.ok(Date.now() - redirectDeadlineStartedAt < 200, "Redirects must not reset the public fetch deadline");

await assert.rejects(
  () => validatePublicHttpUrl("http://localhost/admin", { lookup: async () => ["127.0.0.1"] }),
  /hostname|private|reserved/i,
);
await assert.rejects(
  () => validatePublicHttpUrl("http://user:pass@example.com/private", { lookup: async () => ["1.1.1.1"] }),
  /credentials/i,
);
await assert.rejects(
  () => validatePublicHttpUrl("file:///etc/passwd", { lookup: async () => ["1.1.1.1"] }),
  /protocol/i,
);
await assert.rejects(
  () => validatePublicHttpUrl("https://feeds.example.com:8443/rss", {
    allowedPorts: new Set(["", "80", "443"]),
    lookup: async () => ["1.1.1.1"],
  }),
  /port/i,
);

const allowedOrigins = buildAllowedOrigins("https://atomflow.example", "https://preview.atomflow.example, https://atomflow.example/");
assert.deepEqual([...allowedOrigins].sort(), ["https://atomflow.example", "https://preview.atomflow.example"]);
assert.equal(isAllowedMutationOrigin({ method: "GET", path: "/api/articles" }, allowedOrigins), true);
assert.equal(isAllowedMutationOrigin({ method: "POST", path: "/api/notes", origin: "https://atomflow.example" }, allowedOrigins), true);
assert.equal(isAllowedMutationOrigin({ method: "DELETE", path: "/api/notes/1", referer: "https://preview.atomflow.example/write" }, allowedOrigins), true);
assert.equal(isAllowedMutationOrigin({ method: "POST", path: "/api/notes", origin: "https://evil.example" }, allowedOrigins), false);
assert.equal(isAllowedMutationOrigin({ method: "POST", path: "/api/notes", isAuthenticated: true }, allowedOrigins), false);
assert.equal(isAllowedMutationOrigin({ method: "POST", path: "/api/auth/login-password" }, allowedOrigins), false);

const smallResponse = new Response(new Uint8Array([1, 2, 3]), { headers: { "content-length": "3" } });
assert.deepEqual([...await readResponseBuffer(smallResponse, 3)], [1, 2, 3]);
await assert.rejects(
  () => readResponseBuffer(new Response(new Uint8Array(5), { headers: { "content-length": "5" } }), 4),
  error => error instanceof ResponseLimitError,
);
await assert.rejects(
  () => readResponseBuffer(new Response(new Uint8Array(5)), 4),
  error => error instanceof ResponseLimitError,
);

const guard = createUserConcurrencyGuard(2);
let releaseFirst: (() => void) | undefined;
let releaseSecond: (() => void) | undefined;
const first = guard.run("user:1", () => new Promise<void>(resolve => { releaseFirst = resolve; }));
const second = guard.run("user:1", () => new Promise<void>(resolve => { releaseSecond = resolve; }));
await assert.rejects(
  () => guard.run("user:1", async () => undefined),
  error => error instanceof ConcurrencyLimitError,
);
assert.equal(guard.active("user:1"), 2);
releaseFirst?.();
await first;
assert.equal(guard.active("user:1"), 1);
releaseSecond?.();
await second;
assert.equal(guard.active("user:1"), 0);
await assert.rejects(() => guard.run("user:2", async () => { throw new Error("task failed"); }), /task failed/);

const recentAuthNow = 1_000_000;
assert.equal(isRecentAuthentication(recentAuthNow - 60_000, recentAuthNow), true);
assert.equal(isRecentAuthentication(recentAuthNow - 16 * 60_000, recentAuthNow), false);
assert.equal(isRecentAuthentication(recentAuthNow + 1, recentAuthNow), false, "Future timestamps must not count as recent authentication");
assert.equal(await canChangePassword({
  existingPasswordHash: "stored-hash",
  currentPassword: "correct-password",
  reauthenticatedAt: recentAuthNow - 16 * 60_000,
  now: recentAuthNow,
  comparePassword: async password => password === "correct-password",
}), true, "An existing password is valid secondary authentication");
assert.equal(await canChangePassword({
  existingPasswordHash: "stored-hash",
  currentPassword: "wrong-password",
  reauthenticatedAt: recentAuthNow - 16 * 60_000,
  now: recentAuthNow,
  comparePassword: async password => password === "correct-password",
}), false, "A stale session and wrong current password must not authorize replacement");
assert.equal(await canChangePassword({
  existingPasswordHash: "stored-hash",
  currentPassword: "",
  reauthenticatedAt: recentAuthNow - 60_000,
  now: recentAuthNow,
  comparePassword: async () => false,
}), true, "A recent login may authorize an existing account password change");
assert.equal(await canChangePassword({
  existingPasswordHash: null,
  currentPassword: "",
  reauthenticatedAt: recentAuthNow - 60_000,
  now: recentAuthNow,
  comparePassword: async () => false,
}), true, "A passwordless account may set its first password after a recent OTP login");
assert.equal(await canChangePassword({
  existingPasswordHash: null,
  currentPassword: "",
  reauthenticatedAt: recentAuthNow - 16 * 60_000,
  now: recentAuthNow,
  comparePassword: async () => false,
}), false, "A stale passwordless session must not set a password");

const sharedArticle = {
  title: "Shared built-in article",
  cards: [{ content: "cached card from another user", tags: ["cached"] }],
};
const extractionForUser = async (userId: number) => extractCardsForUser({
  article: sharedArticle,
  userId,
  defaultArticleCitationContext: "default citation",
  resolveSkills: async resolvedUserId => [{ type: "card_storage", prompt: `user-${resolvedUserId}` }],
  extractWithAI: async (_article, skills) => ({
    cards: [{ content: skills[0].prompt, tags: [skills[0].prompt] }],
  }),
  buildFallbackCards: () => [{ content: "fallback", tags: [] }],
  fallbackDisabled: false,
});
const [firstUserExtraction, secondUserExtraction] = await Promise.all([
  extractionForUser(1),
  extractionForUser(2),
]);
assert.equal(firstUserExtraction?.cards[0].content, "user-1");
assert.equal(secondUserExtraction?.cards[0].content, "user-2");
assert.equal(sharedArticle.cards[0].content, "cached card from another user", "Extraction must not mutate the shared RSS article");
assert.notEqual(firstUserExtraction?.cards[0].content, sharedArticle.cards[0].content, "Cached shared cards must never bypass user-scoped extraction");

const fallbackExtraction = await extractCardsForUser({
  article: sharedArticle,
  userId: 3,
  defaultArticleCitationContext: "fallback citation",
  resolveSkills: async () => [{ type: "citation" }],
  extractWithAI: async () => ({ cards: [] }),
  buildFallbackCards: () => [{ content: "fallback", tags: ["规则"] }],
  fallbackDisabled: false,
});
assert.deepEqual(fallbackExtraction?.cards[0].tags, ["规则", "自动提取"]);
assert.equal(await extractCardsForUser({
  article: sharedArticle,
  userId: 4,
  defaultArticleCitationContext: "strict citation",
  resolveSkills: async () => [],
  extractWithAI: async () => ({ cards: [] }),
  buildFallbackCards: () => [{ content: "must not be used", tags: [] }],
  fallbackDisabled: true,
}), null, "Strict AI mode must reject rather than use rule fallback");
assert.equal(guard.active("user:2"), 0, "rejected tasks must release their slot");
const releaseThird = guard.acquire("user:3");
assert.equal(guard.active("user:3"), 1);
releaseThird();
releaseThird();
assert.equal(guard.active("user:3"), 0, "manual release must be idempotent");

assert.equal(isAllowedUploadSignature(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png", "image.png"), true);
assert.equal(isAllowedUploadSignature(Buffer.from("%PDF-1.7\n"), "application/pdf", "paper.pdf"), true);
assert.equal(isAllowedUploadSignature(Buffer.from("hello"), "text/plain", "notes.txt"), true);
assert.equal(isAllowedUploadSignature(Buffer.from("<script>alert(1)</script>"), "image/png", "image.png"), false);
assert.equal(isAllowedUploadSignature(Buffer.from([0x50, 0x4b, 0x03, 0x04]), "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "paper.exe"), false);

const docxArchive = new JSZip();
docxArchive.file("[Content_Types].xml", "<Types />");
docxArchive.file("word/document.xml", "<document><body>bounded document</body></document>");
const docxBuffer = await docxArchive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
assert.equal(await validateDocxArchiveBounds(docxBuffer), true, "small DOCX archives should be accepted");
assert.equal(
  await validateDocxArchiveBounds(docxBuffer, { maxUncompressedBytes: 20 }),
  false,
  "DOCX archives must be rejected when declared uncompressed content exceeds the bound",
);

let publicFetchCalls = 0;
await assert.rejects(
  () => fetchBoundedPublicResource("https://public.example/start", {
    timeoutMs: 1000,
    maxBytes: 1024,
    maxRedirects: 2,
    lookup: async hostname => hostname === "public.example" ? ["1.1.1.1"] : ["127.0.0.1"],
    fetchImpl: async () => {
      publicFetchCalls += 1;
      return new Response(null, { status: 302, headers: { location: "http://internal.example/admin" } });
    },
  }),
  /private|reserved/i,
);
assert.equal(publicFetchCalls, 1, "private redirect must be blocked before a second fetch");

let restrictedPortFetchCalls = 0;
await assert.rejects(
  () => fetchBoundedPublicResource("https://public.example/start", {
    timeoutMs: 1000,
    maxBytes: 1024,
    maxRedirects: 2,
    allowedPorts: new Set(["", "80", "443"]),
    lookup: async () => ["1.1.1.1"],
    fetchImpl: async () => {
      restrictedPortFetchCalls += 1;
      return new Response(null, { status: 302, headers: { location: "https://public.example:8443/feed" } });
    },
  }),
  /port/i,
);
assert.equal(restrictedPortFetchCalls, 1, "restricted redirect port must be blocked before a second fetch");

const fetchedResource = await fetchBoundedPublicResource("https://public.example/image.png", {
  timeoutMs: 1000,
  maxBytes: 4,
  maxRedirects: 0,
  lookup: async () => ["1.1.1.1"],
  fetchImpl: async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "content-type": "image/png" } }),
});
assert.deepEqual([...fetchedResource.body], [1, 2, 3, 4]);
await assert.rejects(
  () => fetchBoundedPublicResource("https://public.example/large.png", {
    timeoutMs: 1000,
    maxBytes: 3,
    maxRedirects: 0,
    lookup: async () => ["1.1.1.1"],
    fetchImpl: async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }),
  }),
  error => error instanceof ResponseLimitError,
);

const parentFetchAbort = new AbortController();
let boundedFetchObservedAbort = false;
let markBoundedFetchStarted!: () => void;
const boundedFetchStarted = new Promise<void>(resolve => {
  markBoundedFetchStarted = resolve;
});
const abortableFetch = fetchBoundedPublicResource("https://public.example/feed.xml", {
  timeoutMs: 1000,
  maxBytes: 1024,
  maxRedirects: 0,
  signal: parentFetchAbort.signal,
  lookup: async () => ["1.1.1.1"],
  fetchImpl: async (_input, init) => new Promise<Response>((_resolve, reject) => {
    markBoundedFetchStarted();
    const rejectForAbort = () => {
      boundedFetchObservedAbort = true;
      reject(init.signal?.reason || new DOMException("aborted", "AbortError"));
    };
    if (init?.signal?.aborted) rejectForAbort();
    else init?.signal?.addEventListener("abort", rejectForAbort, { once: true });
  }),
});
await boundedFetchStarted;
parentFetchAbort.abort(new DOMException("cycle stopped", "AbortError"));
await assert.rejects(() => abortableFetch, /cycle stopped|aborted/i);
assert.equal(boundedFetchObservedAbort, true, "A parent RSS abort must reach the active fetch implementation");

const dnsPhaseAbort = new AbortController();
const dnsAbortStartedAt = Date.now();
const dnsAbortableFetch = fetchBoundedPublicResource("https://dns-hangs.example/feed.xml", {
  timeoutMs: 1000,
  maxBytes: 1024,
  maxRedirects: 0,
  signal: dnsPhaseAbort.signal,
  lookup: async () => new Promise<string[]>(() => {}),
});
dnsPhaseAbort.abort(new DOMException("cycle stopped during DNS", "AbortError"));
await assert.rejects(() => dnsAbortableFetch, /cycle stopped during DNS|aborted/i);
assert.ok(Date.now() - dnsAbortStartedAt < 250, "A parent abort must stop DNS/URL validation without waiting for the deadline");

const root = process.cwd();
const serverRuntime = readFileSync(path.join(root, "server.ts"), "utf8");
const databaseMigrations = readFileSync(path.join(root, "src", "server", "databaseMigrations.ts"), "utf8");
const rssCacheSource = readFileSync(path.join(root, "src", "server", "rssCache.ts"), "utf8");
const server = `${serverRuntime}\n${databaseMigrations}`;
const securitySource = readFileSync(path.join(root, "src/server/security.ts"), "utf8");
const viteConfig = readFileSync(path.join(root, "vite.config.ts"), "utf8");
const fullArticleHelperStart = server.indexOf("type FullArticleResourceFetcher");
const fullArticleHelperEnd = server.indexOf("const ALLOWED_IMAGE_HOST_SUFFIXES", fullArticleHelperStart);
assert.ok(fullArticleHelperStart >= 0 && fullArticleHelperEnd > fullArticleHelperStart, "Full article helper must remain independently testable");
const fullArticleHelperSource = server.slice(fullArticleHelperStart, fullArticleHelperEnd);
const compiledFullArticleHelper = ts.transpileModule(fullArticleHelperSource, {
  compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
}).outputText;
type TestFullArticleResource = {
  url: URL;
  status: number;
  headers: Headers;
  body: Buffer;
};
type TestFullArticleFetcher = (url: string, options: Record<string, unknown>) => Promise<TestFullArticleResource>;
type TestFullArticleHelper = (url: string, fetcher: TestFullArticleFetcher) => Promise<string | null>;
const loadFullArticleHelper = new Function(
  "fetchBoundedPublicResource",
  "JSDOM",
  "Readability",
  "PUBLIC_WEB_PORTS",
  `${compiledFullArticleHelper}\nreturn fetchReadableArticleContent;`,
) as (
  defaultFetcher: TestFullArticleFetcher,
  dom: typeof JSDOM,
  readability: typeof Readability,
  ports: Set<string>,
) => TestFullArticleHelper;
const unreachableDefaultFetcher: TestFullArticleFetcher = async () => {
  throw new Error("The injected test fetcher must be used");
};
const testFullArticleHelper = loadFullArticleHelper(
  unreachableDefaultFetcher,
  JSDOM,
  Readability,
  new Set(["", "80", "443"]),
);
let fullArticleFetchOptions: Record<string, unknown> | undefined;
const readableHtml = `<!doctype html><html><head><title>Bounded article</title></head><body><article><h1>Bounded article</h1><p>${"Useful article text ".repeat(40)}<a href="../sources">Source</a><img src="./cover.jpg" alt="Cover"></p></article></body></html>`;
const extractedArticleHtml = await testFullArticleHelper(
  "https://public.example/start",
  async (_url, options) => {
    fullArticleFetchOptions = options;
    return {
      url: new URL("https://public.example/news/entry"),
      status: 200,
      headers: new Headers({ "content-type": "Text/HTML; charset=UTF-8" }),
      body: Buffer.from(readableHtml),
    };
  },
);
assert.ok(extractedArticleHtml, "Successful HTML responses should yield Readability content");
assert.match(extractedArticleHtml, /href="https:\/\/public\.example\/sources"/, "Readability links must resolve against the final response URL");
assert.match(extractedArticleHtml, /src="https:\/\/public\.example\/news\/cover\.jpg"/, "Readability images must resolve against the final response URL");
assert.deepEqual(
  {
    timeoutMs: fullArticleFetchOptions?.timeoutMs,
    maxBytes: fullArticleFetchOptions?.maxBytes,
    maxRedirects: fullArticleFetchOptions?.maxRedirects,
    allowedPorts: [...(fullArticleFetchOptions?.allowedPorts as Set<string>)],
  },
  { timeoutMs: 10_000, maxBytes: 3 * 1024 * 1024, maxRedirects: 3, allowedPorts: ["", "80", "443"] },
  "Full article fetches must preserve SSRF, timeout, byte and redirect boundaries",
);
for (const [status, contentType] of [[404, "text/html"], [200, "application/json"], [200, "text/plain"]] as const) {
  assert.equal(
    await testFullArticleHelper("https://public.example/article", async () => ({
      url: new URL("https://public.example/article"),
      status,
      headers: new Headers({ "content-type": contentType }),
      body: Buffer.from(readableHtml),
    })),
    null,
    `Full article helper must reject status ${status} with ${contentType}`,
  );
}
assert.ok(
  await testFullArticleHelper("https://public.example/article.xhtml", async () => ({
    url: new URL("https://public.example/article.xhtml"),
    status: 200,
    headers: new Headers({ "content-type": "application/xhtml+xml; charset=utf-8" }),
    body: Buffer.from(readableHtml),
  })),
  "XHTML article responses should be accepted",
);
const articleSaveRoute = server.slice(
  server.indexOf('app.post("/api/articles/:id/save"'),
  server.indexOf('// Fetch full content for an article'),
);
const setPasswordRoute = server.slice(
  server.indexOf('app.put("/api/auth/set-password"'),
  server.indexOf('// --- Reset password'),
);
assert.match(articleSaveRoute, /extractCardsForUser\(\{/, "Article saves must run user-scoped extraction");
assert.doesNotMatch(articleSaveRoute, /article\.cards/, "Article saves must not read or mutate cards on shared RSS articles");
assert.match(articleSaveRoute, /requireAuth, remoteFetchLimiter, paidOperationLimiter,/, "Article saves must rate-limit remote fetches before reserving paid AI work");
assert.match(articleSaveRoute, /article = \{ \.\.\.article, cards: \[\] \}/, "Article saves must work on a request-local article copy");
assert.match(articleSaveRoute, /article = await buildFullArticleView\(article\);[\s\S]*extractCardsForUser\(\{\s*article,/, "Article saves must extract and persist from fetched full content");
assert.doesNotMatch(articleSaveRoute, /article\.saved\s*=/, "Article saves must not mutate shared saved state");
assert.match(rssCacheSource, /cards: \[\]/, "RSS cache normalization must discard extracted user cards");
assert.match(rssCacheSource, /markdownContent: undefined/, "RSS cache normalization must discard full article bodies");
assert.match(setPasswordRoute, /SELECT id, email, password_hash FROM users WHERE id = \$1/, "Password changes must load the existing credential state");
assert.match(setPasswordRoute, /canChangePassword\(\{/, "Password changes must enforce secondary authentication");
assert.match(setPasswordRoute, /currentPassword/, "Existing-password accounts must accept current-password proof");
assert.doesNotMatch(viteConfig, /GEMINI_API_KEY|process\.env\.[A-Z0-9_]+[^\n]*JSON\.stringify/, "Server API keys must never be injected into the browser bundle");
assert.match(server, /import helmet from "helmet"/, "Helmet must protect HTTP responses");
assert.match(server, /import compression from "compression"/, "Large JSON and static responses must be compressed");
assert.match(server, /import \{[^}]*rateLimit[^}]*\} from "express-rate-limit"/, "Express rate limiting must be installed");
assert.match(server, /app\.disable\(["']x-powered-by["']\)/, "Express fingerprint must be disabled");
assert.match(server, /express\.json\(\{\s*limit:/, "JSON request size must be explicit");
assert.match(server, /app\.use\(["']\/api["'], apiLimiter\)/, "API routes must have a general limiter");
assert.match(server, /app\.use\(["']\/api["'], mutationOriginGuard\)/, "API mutations must enforce production origin policy");
assert.match(server, /app\.get\(["']\/api\/health["']/, "Railway health endpoint must exist");
assert.match(server, /const sessionMiddleware = session\(/, "HTTP and WebSocket paths must share one session parser");
assert.match(server, /if \(isProduction && \(!process\.env\.SESSION_SECRET[\s\S]{0,220}configuredSessionSecret === DEV_SESSION_SECRET/, "Production must reject a missing or placeholder session secret");
assert.match(server, /name:\s*["']atomflow\.sid["']/, "Session cookie must not use the framework default name");
assert.match(server, /req\.session\.regenerate\(/, "Authentication must regenerate the session id");
assert.match(server, /app\.post\(["']\/api\/auth\/login-password["'], passwordLoginLimiter,/, "Password login must be brute-force limited");
assert.match(server, /app\.post\(["']\/api\/auth\/send-code["'], verificationSendLimiter,/, "Verification email sends must be limited");
assert.match(server, /app\.post\(["']\/api\/sources\/fetch["'], requireAuth, remoteFetchLimiter,/, "Custom RSS fetch must require authentication and remote-fetch limits");
assert.match(server, /app\.post\(["']\/api\/sources\/retry["'], requireAuth, remoteFetchLimiter,/, "RSS retry must require authentication and remote-fetch limits");
assert.match(server, /app\.get\(["']\/api\/articles\/:id\/full["'], remoteFetchLimiter,/, "Full article fetching must be rate limited");
assert.match(server, /app\.delete\(["']\/api\/sources\/:source["'], requireAuth,/, "Subscription deletion must require authentication");
assert.match(server, /app\.patch\(["']\/api\/sources\/rename["'], requireAuth,/, "Subscription rename must require authentication");
assert.doesNotMatch(server, /app\.post\(["']\/api\/articles\/refresh-cache["']/, "Unused global cache mutation must not be publicly routable");
assert.match(server, /app\.post\(["']\/api\/translate["'], requireAuth, paidOperationLimiter,/, "Translation spend must be limited");
assert.match(server, /app\.post\(["']\/api\/write\/canvas\/agents\/:id\/chat\/stream["'], requireAuth, paidOperationLimiter,/, "Canvas Agent spend must be limited");
assert.match(server, /app\.post\(["']\/api\/write\/agent\/chat\/stream["'], requireAuth, paidOperationLimiter,/, "Writing Agent spend must be limited");
assert.match(databaseMigrations, /connectionTimeoutMillis:/, "PostgreSQL connection acquisition must be bounded");
assert.match(databaseMigrations, /idleTimeoutMillis:/, "Idle PostgreSQL connections must be bounded");
assert.match(server, /await validatePublicHttpUrl\(input, \{ allowedPorts: PUBLIC_WEB_PORTS \}\)/, "Custom RSS targets must be checked before parsing");
assert.match(server, /validatePublicHttpUrl\(input, \{ allowedPorts: PUBLIC_WEB_PORTS \}\)/, "Custom RSS targets must be restricted to normal web ports");
assert.match(server, /fetchBoundedPublicResource\(/, "Remote proxy responses must have redirect, timeout, DNS and byte boundaries");
assert.match(fullArticleHelperSource, /fetchResource:\s*FullArticleResourceFetcher\s*=\s*fetchBoundedPublicResource/, "Full article extraction must use an injectable bounded fetcher");
assert.match(fullArticleHelperSource, /new JSDOM\([\s\S]*url:\s*resource\.url\.toString\(\)/, "Readability must receive the final response URL for relative links");
assert.match(server, /decodeHtmlAttributeEntities[\s\S]*?matchAll\(\/<img[\s\S]*?add\(decodeHtmlAttributeEntities\(match\[1\]\)\)/, "Server-side image authorization must decode HTML attribute entities before URL normalization");
assert.match(fullArticleHelperSource, /contentType !== "text\/html" && contentType !== "application\/xhtml\+xml"/, "Only HTML and XHTML responses may reach Readability");
const fullArticleRouteSource = server.slice(
  server.indexOf('app.get("/api/articles/:id/full"'),
  server.indexOf("// Image proxy to bypass CSP", server.indexOf('app.get("/api/articles/:id/full"')),
);
assert.match(fullArticleHelperSource, /catch \(error\)[\s\S]*using RSS content/, "Full article failures must fall back to RSS content");
assert.match(fullArticleHelperSource, /cachedFullContent\s*=\s*article\.markdownContent[\s\S]*fallbackContent\s*=\s*cachedFullContent/, "A transient refetch failure must preserve an already cached full article");
assert.match(fullArticleHelperSource, /return \{\s*\.\.\.article,[\s\S]*markdownContent,[\s\S]*readabilityUsed,[\s\S]*fullFetched:\s*true/, "Full article hydration must use a request-local article copy");
assert.match(fullArticleRouteSource, /const fullArticle = await buildFullArticleView\(article\)[\s\S]*article:\s*fullArticle/, "Full article responses must use the shared safe hydration helper");
assert.doesNotMatch(fullArticleRouteSource, /article\.(?:markdownContent|readabilityUsed|fullFetched)\s*=/, "Fetched article content must not mutate the shared article cache");
assert.match(fullArticleRouteSource, /if \(userArticleId && req\.session\.userId\) \{[\s\S]*?if \(fullArticle\.markdownContent[\s\S]*?UPDATE user_articles[\s\S]*?\n\s*\}\n\s*\} else \{[\s\S]*?rememberFullArticleImages/, "Account-owned full articles must never fall through into the global image authorization cache");
assert.match(server, /isAllowedUploadSignature\(req\.file\.buffer/, "Canvas uploads must verify file signatures");
assert.match(server, /new WebSocketServer\(\{\s*noServer:\s*true,[\s\S]*maxPayload:\s*asrMaxFrameBytes,[\s\S]*perMessageDeflate:\s*false/, "ASR WebSocket payload and compression must be bounded");
assert.match(server, /sessionMiddleware\(upgradeRequest/, "ASR upgrades must parse the authenticated session");
assert.match(server, /pendingAudioBytes/, "ASR pending audio bytes must be bounded");
assert.match(server, /asrSessionTimeout/, "ASR sessions must have a maximum duration");
assert.match(server, /instanceof multer\.MulterError/, "Multipart limit failures must be handled explicitly");
assert.match(server, /entity\.too\.large/, "Oversized JSON bodies must return a payload error instead of 500");
assert.match(server, /let schemaReady = false/, "Readiness must distinguish a connected database from a completed schema migration");
assert.match(server, /schemaReady = await verifyDatabaseSchema\(pool\)/, "Startup must verify the pre-deploy schema version without rerunning migrations");
assert.doesNotMatch(serverRuntime, /CREATE TABLE IF NOT EXISTS users/, "The web process must not execute the full schema migration during startup");
assert.match(databaseMigrations, /pg_advisory_lock\(hashtext\('atomflow-schema-migration'\)\)/, "Pre-deploy migration must serialize schema changes across replicas");
assert.match(databaseMigrations, /throw err/, "Migration failures must fail the pre-deploy command closed");
assert.match(server, /!schemaReady/, "Health checks must reject half-migrated instances");
assert.doesNotMatch(server, /else \{\s*await refreshFeeds\(\);\s*\}/, "Initial RSS refresh must never block HTTP startup");
assert.match(databaseMigrations, /pool\.on\(["']error["']/, "PostgreSQL pool background errors must be observed");
assert.match(server, /SIGTERM/, "Railway shutdown must drain the HTTP server and database pool");
assert.match(server, /randomInt\(100000, 1000000\)/, "Authentication codes must use a cryptographic random source");
assert.doesNotMatch(server, /Math\.floor\(100000 \+ Math\.random\(\) \* 900000\)/, "Authentication codes must not use Math.random");
assert.match(server, /verificationCodeDigest\(email, code\)/, "Verification codes must be stored and compared as keyed digests");
assert.equal((server.match(/\) AND used = FALSE\s+RETURNING id/g) || []).length, 3, "Every OTP update must reject an already-consumed row");
assert.match(server, /\) AND used = FALSE\s+RETURNING id, password_hash/, "Registration OTP updates must reject an already-consumed row");
assert.match(server, /asrMaxSessionAudioBytes/, "ASR sessions must have a total audio byte limit");
assert.match(server, /asrMaxBytesPerSecond/, "ASR sessions must have a byte-rate limit");
assert.match(server, /asrMaxUpstreamBufferedBytes/, "ASR upstream queues must have backpressure limits");
assert.match(server, /asrMaxGlobalConnections/, "ASR must have an instance-wide connection limit");
assert.match(server, /maxTranslationSegments = 50/, "Translation requests must cap provider fan-out");
assert.match(server, /maxTranslationCharacters = 50_000/, "Translation requests must cap total work");
assert.match(server, /validateDocxArchiveBounds\(req\.file\.buffer\)/, "DOCX uploads must be bounded before parsing");
assert.match(server, /canvasUserStorageMaxBytes/, "Canvas uploads must enforce a per-user storage quota");
assert.match(server, /lockCanvasUser\(client, req\.session\.userId\)/, "Canvas mutations must serialize per-user quota and project changes");
assert.match(server, /WRITE_CANVAS_MAX_CONTEXT_ITEMS/, "Canvas Agent context must cap linked item count");
assert.match(server, /WRITE_CANVAS_MAX_CONTEXT_CHARS/, "Canvas Agent context must cap aggregate text");
assert.match(server, /WRITE_CANVAS_MAX_CONTEXT_IMAGE_BYTES/, "Canvas Agent context must cap aggregate image bytes");
assert.match(server, /canvasAgentConcurrencyMiddleware/, "Each canvas Agent must serialize generation runs");
assert.match(server, /requestAbortController\.signal/, "Canvas Agent requests must cancel the upstream provider after disconnects");
assert.match(server, /saved_articles WHERE id = \$14 AND user_id = \$2/, "Manual cards must only reference the current user's saved articles");
assert.match(server, /articleSaveConcurrencyMiddleware/, "Concurrent article saves must be serialized per user and article");
assert.match(server, /CREATE UNIQUE INDEX(?: IF NOT EXISTS)? idx_saved_articles_content_hash_unique_v2/, "URL-less saved articles must have a per-user content hash identity constraint");
assert.match(server, /ON CONFLICT \(user_id, content_hash\) WHERE content_hash IS NOT NULL/, "URL-less article writes must handle concurrent identity conflicts");
assert.match(databaseMigrations, /HAVING COUNT\(\*\) > 1[\s\S]*?explicit backed-up maintenance migration/, "Automatic pre-deploy must stop instead of destructively merging duplicate articles");
assert.doesNotMatch(databaseMigrations, /DELETE FROM saved_articles/, "Automatic pre-deploy must not delete saved articles");
assert.match(server, /canvasAgentConcurrencyGuard\.acquire\(`\$\{authenticatedUserKey\(req\)\}:\$\{agentId\}`\)/, "Canvas Agent locks must use the canonical numeric id");
assert.match(server, /write_agent_templates WHERE user_id = \$1\) < 100/, "Agent template creation must match the list capacity");
assert.match(securitySource, /requestPinnedPublicResource/, "Remote fetches must pin a validated address to the actual socket");
assert.match(securitySource, /lookup,[\s\S]{0,100}servername: parsed\.hostname/, "Pinned HTTP requests must preserve TLS hostname validation");
assert.doesNotMatch(server, /parser\.parseURL\(/, "Built-in RSS refreshes must not use unbounded parser network requests");
assert.match(server, /fetchBoundedPublicResource\(candidate,/, "Built-in RSS refreshes must use bounded, abortable fetches");
assert.match(server, /if \(result\.error\) throw new Error\(`Resend RSS alert failed:/, "RSS alert delivery must surface Resend API errors");
assert.match(server, /articleCount: articles\.length/, "RSS runtime logs must include the bounded article count");
assert.match(server, /getAllowedCanvasAgentModels/, "Canvas Agent models must be controlled by a server-side allowlist");
assert.match(server, /isAllowedCanvasAgentModel/, "Canvas Agent model writes and runtime calls must enforce the allowlist");
assert.match(server, /CREATE TABLE IF NOT EXISTS user_ai_usage_daily/, "Paid AI operations must have a shared daily budget ledger");
assert.match(server, /reserveDailyAiBudget/, "Paid AI routes must reserve durable daily budget before provider calls");
assert.match(server, /app\.get\("\/api\/favicon-proxy", requireAuth, remoteFetchLimiter/, "Favicon egress proxy must require authentication");
assert.match(server, /invalidateUserSessions/, "Password changes and resets must invalidate prior sessions");
assert.match(server, /invalidateUserSessions[\s\S]{0,220}client\.query\([\s\S]{0,120}DELETE FROM session/, "Session invalidation must use the caller's transaction client");
assert.match(server, /BEGIN[\s\S]{0,1200}UPDATE users SET password_hash[\s\S]{0,600}invalidateUserSessions\([^,]+, client\)[\s\S]{0,300}COMMIT/, "Password updates and old-session invalidation must be atomic");
assert.match(server, /safeRequestPath/, "HTTP logs must strip query strings");
assert.match(server, /app\.get\("\/api\/account\/export", requireAuth/, "Users must be able to export their account data");
assert.match(server, /estimateAccountExportBytes[\s\S]{0,1200}Promise\.all/, "Account exports must reject oversized datasets before materializing rows");
assert.match(server, /requireRecentAuthentication/, "Sensitive account exports must require recent authentication");
assert.match(server, /app\.delete\("\/api\/account", requireAuth/, "Users must be able to delete their account data");
assert.match(server, /app\.delete\("\/api\/saved-articles\/:id", requireAuth/, "Users must be able to delete saved source articles");
assert.match(server, /app\.delete\("\/api\/write\/agent\/threads\/:id", requireAuth/, "Users must be able to delete writing conversations");
assert.match(server, /DELETE FROM verification_codes[\s\S]{0,120}expires_at/, "Expired verification records must be cleaned up");
assert.match(server, /pg_try_advisory_xact_lock[\s\S]{0,800}DELETE FROM verification_codes/, "Verification cleanup must elect one bounded database worker");
assert.match(server, /idx_vc_expires_at/, "Verification cleanup must have an expiry index");
assert.match(server, /idx_session_user_id/, "Session invalidation must have a JSON user-id index");
assert.match(databaseMigrations, /pg_advisory_lock/, "Schema initialization must be serialized across replicas");
assert.match(server, /new Worker\(/, "Document parsing must run outside the main event loop");
assert.match(server, /resourceLimits:/, "Document parser workers must have a memory limit");

const railway = readFileSync(path.join(root, "railway.json"), "utf8");
const railwayConfig = JSON.parse(railway) as { deploy?: { drainingSeconds?: unknown; healthcheckTimeout?: unknown; preDeployCommand?: unknown } };
const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
const nixpacks = readFileSync(path.join(root, "nixpacks.toml"), "utf8");
const envExample = readFileSync(path.join(root, ".env.example"), "utf8");
const gitignore = readFileSync(path.join(root, ".gitignore"), "utf8");
const deploymentDoc = readFileSync(path.join(root, "DEPLOYMENT.md"), "utf8");
assert.match(railway, /"healthcheckPath"\s*:\s*"\/api\/health"/, "Railway must gate deployments on health");
assert.match(railway, /"healthcheckTimeout"\s*:/, "Railway healthcheck timeout must be explicit");
assert.equal(railwayConfig.deploy?.healthcheckTimeout, 180, "Railway must allow enough time for the new container health gate");
assert.equal(railwayConfig.deploy?.preDeployCommand, "npm run migrate", "Railway must migrate before starting the new container");
assert.equal(railwayConfig.deploy?.drainingSeconds, 20, "Railway must preserve enough time for graceful shutdown");
assert.match(dockerfile, /FROM node:22-alpine/, "Docker runtime must match the documented Node.js 22 requirement");
assert.match(dockerfile, /ENV NODE_ENV=production/, "Docker production mode must be explicit");
assert.match(dockerfile, /npm ci --include=dev/, "Docker build must install the Vite and tsx toolchain");
assert.match(dockerfile, /ARG VITE_TLDRAW_LICENSE_KEY/, "Docker builds must accept the tldraw production license at build time");
assert.match(dockerfile, /ENV VITE_TLDRAW_LICENSE_KEY=\$VITE_TLDRAW_LICENSE_KEY/, "Docker must expose the tldraw license to Vite during the build");
assert.ok(dockerfile.indexOf("ENV NODE_ENV=production") > dockerfile.indexOf("RUN npm run build"), "NODE_ENV=production must not omit build dependencies during npm ci");
assert.match(dockerfile, /USER node/, "Docker runtime must not run as root");
assert.match(dockerfile, /mkdir -p \/app\/\.cache/, "The non-root runtime must have a writable cache directory");
assert.match(dockerfile, /chown[^\n]*node:node[^\n]*\/app\/\.cache/, "The runtime cache directory must belong to the node user");
assert.match(nixpacks, /nodejs[-_]22/, "Railway Nixpacks must use the documented Node.js 22 runtime");
const ciWorkflowPath = path.join(root, ".github/workflows/ci.yml");
assert.equal(existsSync(ciWorkflowPath), true, "Wait for CI requires a real GitHub Actions workflow");
const ciWorkflow = readFileSync(ciWorkflowPath, "utf8");
const workflowDirectory = path.join(root, ".github/workflows");
const allWorkflowContent = readdirSync(workflowDirectory, { recursive: true, encoding: "utf8" })
  .filter(file => /\.ya?ml$/i.test(file))
  .map(file => readFileSync(path.join(workflowDirectory, file), "utf8"))
  .join("\n");
assert.match(ciWorkflow, /npm test/, "CI must run the offline TypeScript regression suite");
for (const variable of [
  "RUN_REAL_SECURITY_TESTS",
  "RUN_REAL_WRITE_AGENT_TESTS",
  "RUN_REAL_CANVAS_TESTS",
]) {
  assert.match(ciWorkflow, new RegExp(`${variable}:\\s*[\"']?false[\"']?`), `${variable} must stay disabled in public CI`);
  assert.doesNotMatch(allWorkflowContent, new RegExp(`${variable}\\s*(?::|=)\\s*[\"']?true[\"']?`, "i"), `${variable} must not be enabled by any public workflow`);
}
assert.doesNotMatch(allWorkflowContent, /secrets\.(?:TEST_EMAIL|TEST_PASSWORD|DATABASE_URL|AI_API_KEY|OPENAI_API_KEY)/i, "Public CI must not receive local or production test credentials");
for (const localOnlyDocument of ["AGENTS.md", "CLAUDE.md", "CLOUD.md"]) {
  assert.match(gitignore, new RegExp(`^${localOnlyDocument.replace(".", "\\.")}$`, "m"), `${localOnlyDocument} must remain local-only`);
}
const trackedLocalDocuments = execFileSync("git", ["ls-files", "--", "AGENTS.md", "CLAUDE.md", "CLOUD.md"], {
  cwd: root,
  encoding: "utf8",
}).trim();
assert.equal(trackedLocalDocuments, "", "Local agent and cloud documents must not be tracked by Git");
for (const variable of [
  "APP_URL",
  "ALLOWED_ORIGINS",
  "API_RATE_LIMIT",
  "AUTH_LOGIN_RATE_LIMIT",
  "PAID_OPERATION_RATE_LIMIT",
  "PAID_OPERATION_CONCURRENCY",
  "REMOTE_FETCH_RATE_LIMIT",
  "CANVAS_UPLOAD_MAX_MB",
  "CANVAS_MAX_CONTEXT_ITEMS",
  "CANVAS_MAX_CONTEXT_CHARS",
  "CANVAS_MAX_CONTEXT_IMAGE_MB",
  "ASR_MAX_SESSION_SECONDS",
  "DB_CONNECTION_TIMEOUT_MS",
  "VITE_TLDRAW_LICENSE_KEY",
]) {
  assert.match(envExample, new RegExp(`^${variable}=`, "m"), `.env.example must document ${variable}`);
}
for (const [variable, expected] of [
  ["API_RATE_LIMIT", "300"],
  ["AUTH_CODE_IP_RATE_LIMIT", "5"],
  ["AUTH_CODE_EMAIL_RATE_LIMIT", "3"],
  ["PAID_OPERATION_RATE_LIMIT", "20"],
  ["REMOTE_RSS_MAX_ITEMS", "500"],
  ["IMAGE_PROXY_MAX_MB", "8"],
  ["IMAGE_PROXY_TIMEOUT_MS", "8000"],
  ["ASR_MAX_PENDING_MB", "2"],
  ["ASR_MAX_SESSION_SECONDS", "600"],
  ["DB_CONNECTION_TIMEOUT_MS", "5000"],
] as const) {
  assert.match(envExample, new RegExp(`^${variable}=${expected}$`, "m"), `.env.example ${variable} must match the server default`);
}
assert.doesNotMatch(deploymentDoc, /Start Command:\s*`?npm run dev/i, "production guides must not run the Vite development server");
assert.match(deploymentDoc, /Wait for CI/i, "Railway autodeploy must wait for CI before production rollout");
assert.match(deploymentDoc, /Railway[\s\S]{0,240}(?:部署状态和日志|deployment and logs)/i, "Railway deployment verification must include status and logs");
assert.match(deploymentDoc, /Cloudflare|WAF/, "Public deployment guide must identify the edge protection launch gate");
assert.match(deploymentDoc, /Redis/, "Public deployment guide must identify the distributed rate-limit launch gate");
assert.match(deploymentDoc, /object storage|对象存储/i, "Public deployment guide must identify the upload storage launch gate");
assert.match(deploymentDoc, /VITE_TLDRAW_LICENSE_KEY/, "Public deployment guide must document the production tldraw license gate");

if (process.env.RUN_REAL_SECURITY_TESTS === "true") {
  const base = process.env.API_BASE || "http://localhost:1000";
  const testEmail = process.env.TEST_EMAIL?.trim();
  const testPassword = process.env.TEST_PASSWORD;
  assert.ok(testEmail && testPassword, "set TEST_EMAIL and TEST_PASSWORD for real security tests");
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200, "healthy local service should return 200");
  assert.equal(health.headers.get("x-powered-by"), null, "HTTP responses must hide Express");
  assert.equal(health.headers.get("x-content-type-options"), "nosniff", "Helmet nosniff header must be present");

  const anonymousRss = await fetch(`${base}/api/sources/fetch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "security-test", input: "https://example.com/feed.xml" }),
  });
  assert.equal(anonymousRss.status, 401, "anonymous callers must not trigger remote RSS fetches");

  const anonymousDelete = await fetch(`${base}/api/sources/security-test`, { method: "DELETE" });
  assert.equal(anonymousDelete.status, 401, "anonymous callers must not delete subscription data");
  const anonymousRename = await fetch(`${base}/api/sources/rename`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from: "a", to: "b" }),
  });
  assert.equal(anonymousRename.status, 401, "anonymous callers must not rename subscription data");
  const removedGlobalMutation = await fetch(`${base}/api/articles/refresh-cache`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(removedGlobalMutation.status, 404, "unused global cache mutation must be removed");

  const login = await fetch(`${base}/api/auth/login-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: testEmail,
      password: testPassword,
    }),
  });
  assert.equal(login.status, 200, "security integration checks require the local test account");
  const sessionCookie = login.headers.get("set-cookie")?.split(";")[0];
  assert.ok(sessionCookie, "password login must issue a session cookie");

  const builtinDelete = await fetch(`${base}/api/sources/${encodeURIComponent("GitHub Blog")}`, {
    method: "DELETE",
    headers: { cookie: sessionCookie },
  });
  assert.equal(builtinDelete.status, 403, "ordinary users must not mutate built-in RSS state");

  const translationFanout = await fetch(`${base}/api/translate`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: sessionCookie },
    body: JSON.stringify({ segments: Array.from({ length: 51 }, () => "bounded") }),
  });
  assert.equal(translationFanout.status, 413, "one translation request must not fan out beyond the segment cap");

  const oversizedJson = await fetch(`${base}/api/log`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ level: "warn", message: "x".repeat(300 * 1024) }),
  });
  assert.equal(oversizedJson.status, 413, "oversized JSON bodies must be rejected before route handling");

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("anonymous ASR upgrade did not finish")), 3000);
    const socket = new WebSocket(base.replace(/^http/, "ws") + "/api/asr");
    socket.once("unexpected-response", (_request, response) => {
      clearTimeout(timeout);
      assert.equal(response.statusCode, 401, "anonymous callers must not open paid ASR sockets");
      response.resume();
      resolve();
    });
    socket.once("open", () => {
      clearTimeout(timeout);
      socket.close();
      reject(new Error("anonymous ASR socket unexpectedly opened"));
    });
    socket.once("error", error => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

console.log("PASS: security hardening primitives");
