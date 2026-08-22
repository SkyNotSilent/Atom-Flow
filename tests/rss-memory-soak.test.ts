import assert from "node:assert/strict";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import test from "node:test";
import { RssRuntimeController } from "../src/server/rssRuntime.js";
import { fetchBoundedPublicResource } from "../src/server/security.js";

type SoakSource = {
  id: string;
  behavior: "success" | "redirect" | "timeout" | "error";
};

const sources: SoakSource[] = Array.from({ length: 12 }, (_, index) => ({
  id: `source-${index}`,
  behavior: index === 10 ? "timeout" : index === 11 ? "error" : index % 3 === 0 ? "redirect" : "success",
}));

const heapAfterGc = async () => {
  global.gc?.();
  await new Promise<void>(resolve => setImmediate(resolve));
  global.gc?.();
  return process.memoryUsage().heapUsed;
};

const waitForSocketsToClose = async (sockets: Set<Socket>, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  while (sockets.size > 0 && Date.now() < deadline) {
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
};

test("RSS runtime remains bounded across 200 real HTTP success, redirect, timeout and error cycles", {
  skip: typeof global.gc !== "function" ? "run with --expose-gc" : false,
  timeout: 60_000,
}, async () => {
  const processWithHandles = process as typeof process & { _getActiveHandles: () => unknown[] };
  const baselineHandles = processWithHandles._getActiveHandles().length;
  const baselineHeap = await heapAfterGc();
  const sockets = new Set<Socket>();
  let redirectResponses = 0;
  let timeoutRequests = 0;
  let errorResponses = 0;

  const proxyServer = createServer(socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    // Timeout and shutdown cases deliberately make the client reset this socket.
    // That reset is the behaviour under test, not a test-process failure.
    socket.on("error", () => undefined);
    let stage: "connect" | "request" = "connect";
    let buffered = "";
    socket.on("data", chunk => {
      buffered += chunk.toString("latin1");
      while (true) {
        const headerEnd = buffered.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        const headers = buffered.slice(0, headerEnd + 4);
        buffered = buffered.slice(headerEnd + 4);
        if (stage === "connect") {
          assert.match(headers, /^CONNECT 1\.1\.1\.1:80 HTTP\/1\.1\r\n/);
          stage = "request";
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          continue;
        }

        const path = headers.match(/^GET (\S+) HTTP\/1\.1\r\n/)?.[1] || "";
        if (path === "/redirect") {
          redirectResponses += 1;
          socket.end("HTTP/1.1 302 Found\r\nLocation: http://public.example/success\r\nContent-Length: 0\r\n\r\n");
        } else if (path === "/timeout") {
          timeoutRequests += 1;
          // Deliberately leave the response open. The bounded fetch must destroy it.
        } else if (path === "/error") {
          errorResponses += 1;
          socket.end("HTTP/1.1 500 Internal Server Error\r\nContent-Length: 5\r\n\r\nerror");
        } else {
          const body = "<rss><channel><item><title>bounded</title></item></channel></rss>";
          socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/rss+xml\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
        }
        return;
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    proxyServer.once("error", reject);
    proxyServer.listen(0, "127.0.0.1", resolve);
  });
  const address = proxyServer.address();
  assert.ok(address && typeof address === "object");
  const previousProxyUrl = process.env.DEV_PROXY_URL;
  const previousFakeIpAllowance = process.env.ALLOW_DEV_PROXY_FAKE_IP;
  process.env.DEV_PROXY_URL = `http://127.0.0.1:${address.port}`;
  process.env.ALLOW_DEV_PROXY_FAKE_IP = "true";

  let completedCycles = 0;
  const runtime = new RssRuntimeController<SoakSource, Buffer>({
    getSources: () => sources,
    getSourceId: source => source.id,
    refreshSource: async (source, signal) => {
      const resource = await fetchBoundedPublicResource(`http://public.example/${source.behavior}`, {
        timeoutMs: 75,
        maxBytes: 3 * 1024 * 1024,
        maxRedirects: 3,
        signal,
        lookup: async () => ["198.18.0.1"],
        trustedPublicLookup: async () => ["1.1.1.1"],
      });
      if (resource.status >= 400) throw new Error(`RSS returned HTTP ${resource.status}`);
      return resource.body;
    },
    onCycleComplete: ({ results }) => {
      assert.ok(results.size >= 10);
      completedCycles += 1;
    },
  });

  try {
    for (let cycle = 0; cycle < 200; cycle += 1) {
      await runtime.runCycle();
      if (cycle % 20 === 0) await heapAfterGc();
    }
    runtime.shutdown();
    await waitForSocketsToClose(sockets, 1000);
    assert.equal(sockets.size, 0, "all real HTTP sockets must close after timeout/redirect/error cycles");

    const shutdownRuntime = new RssRuntimeController<SoakSource, Buffer>({
      getSources: () => [{ id: "shutdown-blackhole", behavior: "timeout" }],
      getSourceId: source => source.id,
      refreshSource: async (source, signal) => {
        const resource = await fetchBoundedPublicResource(`http://public.example/${source.behavior}`, {
          timeoutMs: 5000,
          maxBytes: 3 * 1024 * 1024,
          maxRedirects: 3,
          signal,
          lookup: async () => ["198.18.0.1"],
          trustedPublicLookup: async () => ["1.1.1.1"],
        });
        return resource.body;
      },
    });
    const timeoutCountBeforeShutdown = timeoutRequests;
    const shutdownCycle = shutdownRuntime.runCycle();
    const requestDeadline = Date.now() + 1000;
    while (timeoutRequests === timeoutCountBeforeShutdown && Date.now() < requestDeadline) {
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
    assert.ok(timeoutRequests > timeoutCountBeforeShutdown, "shutdown test must reach a real hanging socket");
    const shutdownStartedAt = Date.now();
    shutdownRuntime.shutdown();
    await shutdownCycle;
    await waitForSocketsToClose(sockets, 1000);
    assert.ok(Date.now() - shutdownStartedAt < 1000, "runtime shutdown must abort the pinned request before its deadline");
    assert.equal(sockets.size, 0, "runtime shutdown must destroy the hanging HTTP socket");
  } finally {
    runtime.shutdown();
    if (previousProxyUrl === undefined) delete process.env.DEV_PROXY_URL;
    else process.env.DEV_PROXY_URL = previousProxyUrl;
    if (previousFakeIpAllowance === undefined) delete process.env.ALLOW_DEV_PROXY_FAKE_IP;
    else process.env.ALLOW_DEV_PROXY_FAKE_IP = previousFakeIpAllowance;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => proxyServer.close(error => error ? reject(error) : resolve()));
  }

  const finalHeap = await heapAfterGc();
  const finalHandles = processWithHandles._getActiveHandles().length;
  assert.equal(completedCycles, 200);
  assert.ok(redirectResponses > 0, "soak must exercise real HTTP redirects");
  assert.ok(timeoutRequests > 0, "soak must exercise real hanging sockets");
  assert.ok(errorResponses > 0, "soak must exercise real HTTP errors");
  assert.ok(finalHeap - baselineHeap < 20 * 1024 * 1024, `heap drift was ${finalHeap - baselineHeap} bytes`);
  assert.ok(finalHandles <= baselineHandles + 2, `active handles grew from ${baselineHandles} to ${finalHandles}`);
});
