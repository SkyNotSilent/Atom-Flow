import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import express from "express";
import helmet from "helmet";
import { WebSocket } from "ws";
import JSZip from "jszip";
import {
  ConcurrencyLimitError,
  ResponseLimitError,
  buildAllowedOrigins,
  createPinnedLookup,
  createUserConcurrencyGuard,
  fetchBoundedPublicResource,
  isAuthenticationPath,
  isAllowedMutationOrigin,
  isAllowedUploadSignature,
  isPrivateOrReservedIp,
  readBoundedEnvNumber,
  readResponseBuffer,
  validateDocxArchiveBounds,
  validatePublicHttpUrl,
} from "../src/server/security.js";
import {
  buildFeedExcerpt,
  buildContentSecurityDirectives,
  contentToPlainText,
  contentToPlainTextWithinBudget,
  createPlainTextBudget,
  normalizeEmailAddress,
  normalizeTextExcerpt,
  stripBareHtmlTagRemnants,
  urlMatchesHostname,
} from "../src/server/contentSecurity.js";
import { installCsrfFetch } from "../src/utils/csrfFetch.js";

assert.equal(readBoundedEnvNumber(undefined, 10, 1, 20), 10);
assert.equal(readBoundedEnvNumber("15", 10, 1, 20), 15);
assert.equal(readBoundedEnvNumber("999", 10, 1, 20), 20);
assert.equal(readBoundedEnvNumber("invalid", 10, 1, 20), 10);
assert.equal(isAuthenticationPath("/auth/login-password"), true);
assert.equal(isAuthenticationPath("/auth/login-password/"), true);
assert.equal(isAuthenticationPath("/AUTH/LOGIN-PASSWORD"), true);
assert.equal(isAuthenticationPath("/auth"), true);
assert.equal(isAuthenticationPath("/authentication/login-password"), false);
assert.equal(isAuthenticationPath("/notes"), false);

assert.equal(
  contentToPlainText('<script>alert(1)</script><style>body{display:none}</style><p>safe</p><!-- hidden -->'),
  "safe",
  "untrusted markup must be parsed and reduced to visible plain text",
);
assert.equal(
  contentToPlainText('<script>alert(1)</script ><p>still safe</p>'),
  "still safe",
  "malformed script end tags must not bypass HTML sanitization",
);
assert.equal(contentToPlainText("# Heading\n\n[Label](https://example.com)"), "Heading Label");
assert.equal(
  contentToPlainText("<p>alpha</p><p>beta</p>"),
  "alpha beta",
  "block elements must retain a plain-text separator",
);
assert.equal(contentToPlainText("alpha<br>beta"), "alpha beta");
assert.equal(contentToPlainText("<table><tr><td>alpha</td><td>beta</td></tr></table>"), "alpha beta");
assert.equal(
  contentToPlainText("before\n\n\n\nafter", true),
  "before\n\nafter",
  "plain-text line normalization must collapse repeated blank lines",
);
assert.equal(
  contentToPlainText("keep <code>drop me</code> after", { dropContentTags: ["code"] }),
  "keep after",
  "translation normalization must be able to discard code content",
);
assert.equal(normalizeEmailAddress(" User@Example.COM "), "user@example.com");
assert.equal(normalizeEmailAddress("foo..bar@example.com"), "foo..bar@example.com");
assert.equal(normalizeEmailAddress("用户@例子.公司"), "用户@例子.公司");
assert.equal(normalizeEmailAddress("not-an-email"), null);
assert.equal(normalizeEmailAddress("user name@example.com"), null);
assert.equal(normalizeEmailAddress(`${"a".repeat(317)}@x.y`), null);
assert.equal(normalizeEmailAddress("user\u0000@example.com"), null);
assert.equal(normalizeTextExcerpt("  alpha\n\t beta  ", 120), "alpha beta");
assert.equal(normalizeTextExcerpt("x".repeat(1_000_000), 120).length, 120);
assert.equal(
  buildFeedExcerpt("<p>正文摘要来自 RSS 内容</p>", undefined, "回退标题", 512, 120),
  "正文摘要来自 RSS 内容",
  "feeds without contentSnippet must derive a bounded excerpt from content",
);

const rssExcerptStartedAt = performance.now();
const rssExcerptSourceCharsPerItem = Math.floor(64_000 / 500);
for (let index = 0; index < 500; index += 1) {
  const excerpt = buildFeedExcerpt(
    `<p>第 ${index} 条正文 ${"内容".repeat(2000)}</p><script>${"x".repeat(5000)}</script>`,
    undefined,
    `标题 ${index}`,
    rssExcerptSourceCharsPerItem,
    120,
  );
  assert.ok(excerpt.length <= 120);
}
assert.ok(
  performance.now() - rssExcerptStartedAt < 2_000,
  "500 bounded RSS excerpts must complete without a multi-second event-loop stall",
);

const contextBudget = createPlainTextBudget(120_000, 240_000);
const contextOutputs: string[] = [];
const contextNormalizationStartedAt = performance.now();
for (let index = 0; index < 30; index += 1) {
  contextOutputs.push(contentToPlainTextWithinBudget(
    `<p>${"context ".repeat(20_000)}</p><script>${"ignored ".repeat(20_000)}</script>`,
    contextBudget,
    60_000,
  ));
}
assert.ok(contextOutputs.reduce((total, value) => total + value.length, 0) <= 120_000);
assert.equal(contextBudget.remainingSourceChars, 0, "all contexts must share one source parsing budget");
assert.ok(
  performance.now() - contextNormalizationStartedAt < 2_000,
  "30 hostile contexts must be bounded by one aggregate parsing budget",
);
assert.equal(
  stripBareHtmlTagRemnants("正文。p\np\n保留"),
  "正文。\n保留",
  "translation cleanup must remove incomplete HTML tag remnants",
);
assert.equal(urlMatchesHostname("https://news.36kr.com/p/123", "36kr.com"), true);
assert.equal(urlMatchesHostname("https://36kr.com.evil.example/p/123", "36kr.com"), false);
assert.equal(urlMatchesHostname("https://evil.example/36kr.com/p/123", "36kr.com"), false);

const originalWindow = globalThis.window;
const csrfTokens = [
  "first-csrf-token-value-with-more-than-32-characters",
  "second-csrf-token-value-with-more-than-32-characters",
];
const csrfMutationHeaders: string[] = [];
let csrfTokenRequests = 0;
let rejectNextMutationToken = false;
const browserBaseUrl = "https://atomflow.example";
const browserFetch: typeof fetch = async (input, init) => {
  const request = input instanceof Request
    ? new Request(input, init)
    : new Request(new URL(input.toString(), browserBaseUrl), init);
  if (new URL(request.url).pathname === "/api/csrf-token") {
    const token = csrfTokens[Math.min(csrfTokenRequests, csrfTokens.length - 1)];
    csrfTokenRequests += 1;
    return Response.json({ csrfToken: token });
  }
  csrfMutationHeaders.push(request.headers.get("x-csrf-token") || "");
  if (rejectNextMutationToken) {
    rejectNextMutationToken = false;
    return new Response(null, { status: 403, headers: { "X-CSRF-Token-Invalid": "1" } });
  }
  return new Response(null, { status: 204 });
};
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    fetch: browserFetch,
    location: { href: `${browserBaseUrl}/`, origin: browserBaseUrl },
  },
});
try {
  installCsrfFetch();
  const firstMutation = await window.fetch("/api/notes", { method: "POST", body: "{}" });
  assert.equal(firstMutation.status, 204);
  assert.equal(csrfTokenRequests, 1);
  assert.equal(csrfMutationHeaders[0], csrfTokens[0]);

  rejectNextMutationToken = true;
  const retriedMutation = await window.fetch("/api/notes", { method: "POST", body: "{}" });
  assert.equal(retriedMutation.status, 204);
  assert.equal(csrfTokenRequests, 2, "an invalid session token must trigger one token refresh");
  assert.deepEqual(csrfMutationHeaders.slice(1), [csrfTokens[0], csrfTokens[1]]);
} finally {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
}

const headerTestApp = express();
headerTestApp.get("/production-headers", helmet({
  contentSecurityPolicy: { directives: buildContentSecurityDirectives(true) },
}), (_req, res) => res.sendStatus(204));
headerTestApp.use(helmet({
  contentSecurityPolicy: { directives: buildContentSecurityDirectives(false) },
}));
const headerAllowedOrigins = buildAllowedOrigins("https://atomflow.example", undefined);
headerTestApp.use("/api", (req, res, next) => {
  if (isAllowedMutationOrigin({
    method: req.method,
    path: req.path,
    origin: req.get("origin") || undefined,
    referer: req.get("referer") || undefined,
    isAuthenticated: true,
  }, headerAllowedOrigins)) {
    next();
    return;
  }
  res.status(403).json({ error: "untrusted origin" });
});
headerTestApp.get("/headers", (_req, res) => res.sendStatus(204));
headerTestApp.post("/api/mutation", (_req, res) => res.sendStatus(204));
const headerTestServer = createHttpServer(headerTestApp);
await new Promise<void>((resolve, reject) => {
  headerTestServer.once("error", reject);
  headerTestServer.listen(0, "127.0.0.1", () => {
    headerTestServer.off("error", reject);
    resolve();
  });
});
try {
  const address = headerTestServer.address();
  assert.ok(address && typeof address === "object");
  const headerBase = `http://127.0.0.1:${address.port}`;
  const headerResponse = await fetch(`${headerBase}/headers`);
  const csp = headerResponse.headers.get("content-security-policy") || "";
  assert.match(csp, /font-src 'self' data: https:\/\/fonts\.gstatic\.com/);
  assert.match(csp, /style-src 'self' 'unsafe-inline' https:\/\/fonts\.googleapis\.com/);
  assert.doesNotMatch(csp, /upgrade-insecure-requests/);
  const productionHeaderResponse = await fetch(`${headerBase}/production-headers`);
  const productionCsp = productionHeaderResponse.headers.get("content-security-policy") || "";
  assert.match(productionCsp, /connect-src 'self';/);
  assert.doesNotMatch(productionCsp, /connect-src[^;]*wss:/);
  assert.match(productionCsp, /upgrade-insecure-requests/);
  assert.doesNotMatch(productionCsp, /script-src[^;]*unsafe/);
  const deniedMutation = await fetch(`${headerBase}/api/mutation`, {
    method: "POST",
    headers: { origin: "https://evil.example" },
  });
  assert.equal(deniedMutation.status, 403);
  const allowedMutation = await fetch(`${headerBase}/api/mutation`, {
    method: "POST",
    headers: { origin: "https://atomflow.example" },
  });
  assert.equal(allowedMutation.status, 204);
} finally {
  headerTestServer.closeAllConnections();
  await new Promise<void>((resolve, reject) => headerTestServer.close(error => error ? reject(error) : resolve()));
}

for (const address of [
  "0.0.0.0",
  "10.0.0.1",
  "100.64.0.1",
  "127.0.0.1",
  "169.254.1.1",
  "172.16.0.1",
  "192.168.1.1",
  "198.51.100.4",
  "203.0.113.8",
  "224.0.0.1",
  "::",
  "::1",
  "::ffff:127.0.0.1",
  "fc00::1",
  "fe80::1",
  "2001:db8::1",
]) {
  assert.equal(isPrivateOrReservedIp(address), true, `${address} must be blocked`);
}
assert.equal(isPrivateOrReservedIp("1.1.1.1"), false);
assert.equal(isPrivateOrReservedIp("2606:4700:4700::1111"), false);

const pinnedLookup = createPinnedLookup("1.1.1.1");
await new Promise<void>((resolve, reject) => {
  pinnedLookup("feeds.example.com", { all: true }, (error, addresses) => {
    if (error) return reject(error);
    try {
      assert.deepEqual(addresses, [{ address: "1.1.1.1", family: 4 }]);
      resolve();
    } catch (assertionError) {
      reject(assertionError);
    }
  });
});

const publicUrl = await validatePublicHttpUrl("https://feeds.example.com/rss", {
  lookup: async hostname => {
    assert.equal(hostname, "feeds.example.com");
    return ["1.1.1.1", "2606:4700:4700::1111"];
  },
});
assert.equal(publicUrl.href, "https://feeds.example.com/rss");

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

const root = process.cwd();
const server = readFileSync(path.join(root, "server.ts"), "utf8");
const securitySource = readFileSync(path.join(root, "src/server/security.ts"), "utf8");
const contentSecuritySource = readFileSync(path.join(root, "src/server/contentSecurity.ts"), "utf8");
const csrfFetchSource = readFileSync(path.join(root, "src/utils/csrfFetch.ts"), "utf8");
const mainSource = readFileSync(path.join(root, "src/main.tsx"), "utf8");
const loggerSource = readFileSync(path.join(root, "src/utils/logger.ts"), "utf8");
const viteConfig = readFileSync(path.join(root, "vite.config.ts"), "utf8");
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  scripts?: { test?: string };
};
assert.doesNotMatch(viteConfig, /GEMINI_API_KEY|process\.env\.[A-Z0-9_]+[^\n]*JSON\.stringify/, "Server API keys must never be injected into the browser bundle");
assert.match(server, /import helmet from "helmet"/, "Helmet must protect HTTP responses");
assert.match(server, /import compression from "compression"/, "Large JSON and static responses must be compressed");
assert.match(server, /import \{[^}]*rateLimit[^}]*\} from "express-rate-limit"/, "Express rate limiting must be installed");
assert.match(server, /app\.disable\(["']x-powered-by["']\)/, "Express fingerprint must be disabled");
assert.match(server, /express\.json\(\{\s*limit:/, "JSON request size must be explicit");
assert.match(server, /app\.use\(["']\/api["'], apiLimiter\)/, "API routes must have a general limiter");
assert.match(server, /app\.use\(["']\/api["'], mutationOriginGuard\)/, "API mutations must enforce production origin policy");
assert.match(server, /directives:\s*buildContentSecurityDirectives\(isProduction\)/, "Helmet CSP must use the tested shared directive builder");
assert.match(server, /sameSite:\s*["']lax["']/, "Session cookies must retain same-site CSRF defense without breaking external navigation");
assert.match(server, /csrfToken\?: string/, "Session state must carry a server-generated CSRF token");
assert.match(server, /app\.get\(["']\/api\/csrf-token["']/, "The browser must have a same-origin CSRF token bootstrap endpoint");
assert.match(server, /app\.use\(["']\/api["'], csrfProtection\)/, "Every mutating API route must pass through CSRF token validation");
assert.match(server, /!isAuthenticationPath\(req\.path\)/, "Anonymous authentication routes must use normalized CSRF path matching");
assert.match(server, /submittedCsrfToken !== req\.session\.csrfToken/, "CSRF validation must compare the request header with the session token");
assert.match(server, /randomBytes\(32\)\.toString\(["']base64url["']\)/, "CSRF tokens must use cryptographically secure randomness");
assert.match(csrfFetchSource, /headers\.set\(["']X-CSRF-Token["']/, "Same-origin mutations must carry the CSRF token header");
assert.match(csrfFetchSource, /\/api\/csrf-token/, "The fetch wrapper must bootstrap tokens from the server");
assert.match(csrfFetchSource, /X-CSRF-Token-Invalid/, "The fetch wrapper must recover after session rotation invalidates a token");
assert.match(mainSource, /installCsrfFetch\(\)/, "CSRF-aware fetch must be installed before the React app starts");
assert.doesNotMatch(loggerSource, /sendBeacon/, "Client logging must not bypass the CSRF-aware fetch wrapper");
assert.match(server, /app\.get\(["']\/api\/health["']/, "Railway health endpoint must exist");
assert.match(server, /const sessionMiddleware = session\(/, "HTTP and WebSocket paths must share one session parser");
assert.match(server, /if \(isProduction && \(!process\.env\.SESSION_SECRET[\s\S]{0,220}configuredSessionSecret === DEV_SESSION_SECRET/, "Production must reject a missing or placeholder session secret");
assert.match(server, /name:\s*["']atomflow\.sid["']/, "Session cookie must not use the framework default name");
assert.match(server, /req\.session\.regenerate\(/, "Authentication must regenerate the session id");
assert.match(server, /app\.post\(["']\/api\/auth\/login-password["'], passwordLoginLimiter,/, "Password login must be brute-force limited");
assert.match(server, /app\.post\(["']\/api\/auth\/send-code["'], verificationSendLimiter,/, "Verification email sends must be limited");
assert.match(server, /app\.post\(["']\/api\/sources\/fetch["'], requireAuth, remoteFetchLimiter,/, "Custom RSS fetch must require authentication and remote-fetch limits");
assert.match(server, /app\.post\(["']\/api\/sources\/retry["'], requireAuth, remoteFetchLimiter,/, "RSS retry must require authentication and remote-fetch limits");
assert.match(server, /app\.post\(["']\/api\/sources\/fetch["'], requireAuth, remoteFetchLimiter, remoteFetchConcurrencyMiddleware,/, "Custom RSS fetches must have global and per-user concurrency limits");
assert.match(server, /app\.post\(["']\/api\/sources\/retry["'], requireAuth, remoteFetchLimiter, remoteFetchConcurrencyMiddleware,/, "RSS retries must have global and per-user concurrency limits");
assert.match(server, /RSS_FEED_EXCERPT_SOURCE_BUDGET_CHARS = 64_000/, "RSS excerpt parsing must have a refresh-level source budget");
assert.match(server, /buildFeedExcerpt\([\s\S]{0,180}excerptSourceCharsPerItem/, "RSS excerpts must use the bounded structured fallback");
assert.doesNotMatch(server, /source === '即刻话题' \? formatJikeContent\(rawContent\)/, "RSS refresh must defer expensive Jike formatting until a single article is opened");
assert.match(server, /PLAIN_TEXT_NORMALIZATION_MAX_SOURCE_CHARS = 250_000/, "Main-thread rich-text normalization must have a hard source bound");
assert.match(server, /Math\.max\(boundedOutputChars \* 2, 2048\)[\s\S]{0,180}contentToPlainText\(\(content \|\| ''\)\.slice\(0, sourceLimit\)\)/, "General plain-text normalization must slice according to the requested output before parsing");
assert.match(contentSecuritySource, /compileHtmlToText/, "Plain-text HTML conversion must reuse the parser's compiled batch API");
assert.match(contentSecuritySource, /plainTextConverterCache\.set\(cacheKey, converter\)/, "Compiled text converters must be cached");
assert.match(server, /createCanvasContextPlainTextBudget[\s\S]{0,300}PLAIN_TEXT_NORMALIZATION_MAX_SOURCE_CHARS/, "Canvas context parsing must cap aggregate source work");
assert.match(server, /for \(const nodeId of contextNodeIds\)[\s\S]{0,300}contextTextBudget/, "Agent groups must resolve contexts against one shared budget");
assert.equal(packageJson.dependencies?.["html-to-text"], "^10.0.0", "The maintained structured HTML-to-text parser must be a direct dependency");
assert.match(server, /beginRemoteFetchProcessing/, "RSS concurrency ownership must transfer to the route task");
const sourceFetchRoute = server.slice(server.indexOf('app.post("/api/sources/fetch"'), server.indexOf('app.post("/api/sources/retry"'));
const sourceRetryRoute = server.slice(server.indexOf('app.post("/api/sources/retry"'), server.indexOf('app.delete("/api/sources/:source"'));
assert.match(sourceFetchRoute, /finally \{\s*releaseRemoteFetchConcurrency\(\)/, "RSS fetch locks must release when processing actually ends");
assert.match(sourceRetryRoute, /finally \{\s*releaseRemoteFetchConcurrency\(\)/, "RSS retry locks must release when processing actually ends");
assert.match(server, /app\.delete\(["']\/api\/sources\/:source["'], requireAuth,/, "Subscription deletion must require authentication");
assert.match(server, /app\.patch\(["']\/api\/sources\/rename["'], requireAuth,/, "Subscription rename must require authentication");
assert.doesNotMatch(server, /app\.post\(["']\/api\/articles\/refresh-cache["']/, "Unused global cache mutation must not be publicly routable");
assert.match(server, /app\.post\(["']\/api\/translate["'], requireAuth, paidOperationLimiter,/, "Translation spend must be limited");
assert.match(server, /app\.post\(["']\/api\/write\/canvas\/agents\/:id\/chat\/stream["'], requireAuth, paidOperationLimiter,/, "Canvas Agent spend must be limited");
assert.match(server, /app\.post\(["']\/api\/write\/agent\/chat\/stream["'], requireAuth, paidOperationLimiter,/, "Writing Agent spend must be limited");
assert.match(server, /connectionTimeoutMillis:/, "PostgreSQL connection acquisition must be bounded");
assert.match(server, /idleTimeoutMillis:/, "Idle PostgreSQL connections must be bounded");
assert.match(server, /await validatePublicHttpUrl\(input, \{ allowedPorts: PUBLIC_WEB_PORTS \}\)/, "Custom RSS targets must be checked before parsing");
assert.match(server, /validatePublicHttpUrl\(input, \{ allowedPorts: PUBLIC_WEB_PORTS \}\)/, "Custom RSS targets must be restricted to normal web ports");
assert.match(server, /fetchBoundedPublicResource\(/, "Remote proxy responses must have redirect, timeout, DNS and byte boundaries");
assert.match(server, /isAllowedUploadSignature\(req\.file\.buffer/, "Canvas uploads must verify file signatures");
assert.match(server, /beginCanvasUploadProcessing/, "Canvas upload slots must remain owned while parsing continues after a disconnect");
const canvasUploadRoute = server.slice(server.indexOf('app.post("/api/write/canvas/assets/upload"'), server.indexOf('app.get("/api/write/canvas/assets/:id/original"'));
assert.match(canvasUploadRoute, /const releaseCanvasUploadConcurrency/, "Canvas upload processing must own an explicit release callback");
assert.match(canvasUploadRoute, /finally \{\s*releaseCanvasUploadConcurrency\(\)/, "Canvas uploads must release their processing slot from the route finally block");
assert.match(server, /new WebSocketServer\(\{\s*noServer:\s*true,[\s\S]*maxPayload:\s*asrMaxFrameBytes,[\s\S]*perMessageDeflate:\s*false/, "ASR WebSocket payload and compression must be bounded");
assert.match(server, /sessionMiddleware\(upgradeRequest/, "ASR upgrades must parse the authenticated session");
assert.match(server, /pendingAudioBytes/, "ASR pending audio bytes must be bounded");
assert.match(server, /asrSessionTimeout/, "ASR sessions must have a maximum duration");
assert.match(server, /instanceof multer\.MulterError/, "Multipart limit failures must be handled explicitly");
assert.match(server, /entity\.too\.large/, "Oversized JSON bodies must return a payload error instead of 500");
assert.match(server, /let schemaReady = false/, "Readiness must distinguish a connected database from a completed schema migration");
assert.match(server, /schemaReady = true/, "Successful schema migration must mark the service ready");
assert.match(server, /if \(isProduction\) throw err;[\s\S]{0,200}Database schema migration failed/, "Production must fail closed when schema migration fails");
assert.match(server, /!schemaReady/, "Health checks must reject half-migrated instances");
assert.doesNotMatch(server, /else \{\s*await refreshFeeds\(\);\s*\}/, "Initial RSS refresh must never block HTTP startup");
assert.match(server, /\.on\(["']error["'],[^\n]*pool|pool[^\n]*\.on\(["']error["']/, "PostgreSQL pool background errors must be observed");
assert.match(server, /SIGTERM/, "Railway shutdown must drain the HTTP server and database pool");
assert.match(server, /randomInt\(100000, 1000000\)/, "Authentication codes must use a cryptographic random source");
assert.doesNotMatch(server, /Math\.floor\(100000 \+ Math\.random\(\) \* 900000\)/, "Authentication codes must not use Math.random");
assert.match(server, /verificationCodeDigest\(email, code\)/, "Verification codes must be stored and compared as keyed digests");
assert.match(server, /verificationCheckIpLimiter/, "Verification attempts must also have an IP-wide limiter");
const resetPasswordRoute = server.slice(server.indexOf('app.post("/api/auth/reset-password"'), server.indexOf('// --- Account data export'));
assert.ok(
  resetPasswordRoute.indexOf("if (!record)") >= 0
    && resetPasswordRoute.indexOf("const passwordHash = await bcrypt.hash") > resetPasswordRoute.indexOf("if (!record)"),
  "Password reset must reject an invalid verification code before running bcrypt",
);
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
assert.match(server, /CREATE UNIQUE INDEX idx_saved_articles_content_hash_unique_v2/, "URL-less saved articles must have a per-user content hash identity constraint");
assert.match(server, /ON CONFLICT \(user_id, content_hash\) WHERE content_hash IS NOT NULL/, "URL-less article writes must handle concurrent identity conflicts");
assert.match(server, /UPDATE write_canvas_nodes n\s+SET ref_id = duplicates\.keep_id::text/, "Content-hash deduplication must preserve canvas article references");
assert.match(server, /canvasAgentConcurrencyGuard\.acquire\(`\$\{authenticatedUserKey\(req\)\}:\$\{agentId\}`\)/, "Canvas Agent locks must use the canonical numeric id");
assert.match(server, /write_agent_templates WHERE user_id = \$1\) < 100/, "Agent template creation must match the list capacity");
assert.match(securitySource, /requestPinnedPublicResource/, "Remote fetches must pin a validated address to the actual socket");
assert.match(securitySource, /lookup,[\s\S]{0,100}servername: parsed\.hostname/, "Pinned HTTP requests must preserve TLS hostname validation");
assert.doesNotMatch(server, /parser\.parseURL\(/, "Built-in RSS refreshes must not use unbounded parser network requests");
assert.match(server, /fetchBoundedPublicResource\(candidate,/, "Built-in RSS refreshes must use bounded, abortable fetches");
assert.match(server, /getAllowedCanvasAgentModels/, "Canvas Agent models must be controlled by a server-side allowlist");
assert.match(server, /isAllowedCanvasAgentModel/, "Canvas Agent model writes and runtime calls must enforce the allowlist");
assert.match(server, /CREATE TABLE IF NOT EXISTS user_ai_usage_daily/, "Paid AI operations must have a shared daily budget ledger");
assert.match(server, /CREATE TABLE IF NOT EXISTS ai_budget_reservations/, "generic paid routes must persist each budget reservation independently");
assert.match(server, /state\s+TEXT NOT NULL DEFAULT 'pending'[\s\S]{0,180}pending[\s\S]{0,120}provider_started[\s\S]{0,120}refunded/, "durable reservations must record the provider billing boundary and refunds");
assert.match(server, /reserveDailyAiBudget/, "Paid AI routes must reserve durable daily budget before provider calls");
assert.match(server, /const markDailyAiBudgetProviderStarted =/, "paid routes must explicitly commit their reservation at provider dispatch");
assert.match(server, /markDailyAiBudgetProviderStarted[\s\S]{0,900}UPDATE ai_budget_reservations[\s\S]{0,240}state = 'provider_started'/, "provider dispatch must be persisted before a generic paid request reaches the upstream API");
assert.match(server, /refundDailyAiBudgetReservation[\s\S]{0,1400}FROM ai_budget_reservations[\s\S]{0,700}releaseDailyAiBudget[\s\S]{0,500}state = 'refunded'/, "generic reservation refunds must update the daily ledger and durable record atomically");
assert.match(server, /recoverStaleCanvasAiWork[\s\S]{0,9000}ai_budget_reservations[\s\S]{0,900}state = 'refunded'/, "periodic recovery must retry stale generic reservations that never reached a provider");
assert.match(server, /refundIfUnused[\s\S]{0,500}refundDailyAiBudgetReservation[\s\S]{0,500}res\.once\("finish", refundIfUnused\)/, "unused paid-operation reservations must be refunded when a response finishes");
assert.match(server, /res\.once\("close", refundIfUnused\)/, "unused paid-operation reservations must be refunded when a request disconnects");
assert.match(server, /writeAgentDailyPaidOperationBudgetMiddleware/, "multi-turn writing Agent requests need a dedicated worst-case budget reservation");
assert.match(server, /WRITE_AGENT_MAX_PROVIDER_CALLS\s*=\s*15/, "writing Agent budget must cover routing, outline, draft, and coordinator turns");
assert.match(server, /translationDailyPaidOperationBudgetMiddleware/, "multi-segment translation must reserve budget per provider call");
assert.match(server, /const baiduTranslate[\s\S]{0,500}await markDailyAiBudgetProviderStarted\(res\)/, "translation must await the durable provider-start boundary before dispatch");
assert.match(server, /modelSettings:\s*\{\s*maxTokens:\s*getCanvasAgentMaxOutputTokens\(\)\s*\}/, "OpenAI SDK Agent turns must enforce the same per-call output ceiling used by the budget");
assert.match(server, /onProviderStart/, "provider-backed graph runtimes must expose the durable dispatch boundary");
assert.match(server, /app\.get\("\/api\/favicon-proxy", requireAuth, remoteFetchLimiter/, "Favicon egress proxy must require authentication");
assert.match(server, /invalidateUserSessions/, "Password changes and resets must invalidate prior sessions");
assert.doesNotMatch(
  server,
  /write_canvas_nodes ALTER COLUMN (?:node_role|content_type|origin|status) SET NOT NULL/,
  "New canvas semantic columns must remain compatible with old instances during rolling deploys",
);
assert.match(
  server,
  /write_canvas_nodes ALTER COLUMN node_role DROP NOT NULL/,
  "Startup must relax semantic columns that an interrupted earlier rollout may already have tightened",
);
assert.match(packageJson.scripts?.test || "", /tests\/write-canvas-ui\.test\.ts/, "Default tests must include the canvas UI contract suite");
assert.match(server, /app\.put\("\/api\/auth\/set-password", requireAuth, accountActionLimiter,/, "Password changes must use the sensitive-account action limiter");
assert.match(server, /app\.put\("\/api\/auth\/set-password"[\s\S]{0,900}currentPassword[\s\S]{0,300}bcrypt\.compare\(currentPassword, user\.password_hash\)/, "Changing an existing password must verify the current password");
assert.match(server, /invalidateUserSessions[\s\S]{0,220}client\.query\([\s\S]{0,120}DELETE FROM session/, "Session invalidation must use the caller's transaction client");
assert.match(server, /BEGIN[\s\S]{0,1200}UPDATE users SET password_hash[\s\S]{0,600}invalidateUserSessions\([^,]+, client\)[\s\S]{0,300}COMMIT/, "Password updates and old-session invalidation must be atomic");
assert.match(server, /safeRequestPath/, "HTTP logs must strip query strings");
assert.match(server, /app\.get\("\/api\/account\/export", requireAuth/, "Users must be able to export their account data");
assert.match(server, /estimateAccountExportBytes[\s\S]{0,1200}Promise\.all/, "Account exports must reject oversized datasets before materializing rows");
assert.match(server, /requireRecentAuthentication/, "Sensitive account exports must require recent authentication");
assert.match(server, /app\.delete\("\/api\/account", requireAuth/, "Users must be able to delete their account data");
assert.match(server, /app\.delete\("\/api\/saved-articles\/:id", requireAuth/, "Users must be able to delete saved source articles");
assert.match(server, /app\.delete\("\/api\/saved-articles\/:id"[\s\S]{0,900}lockCanvasUser\(client, req\.session\.userId\)[\s\S]{0,900}assertNoActiveCanvasAiWork/, "Deleting an article must preserve canvas runs that still reference it");
assert.match(server, /app\.delete\("\/api\/write\/agent\/threads\/:id", requireAuth/, "Users must be able to delete writing conversations");
assert.match(server, /DELETE FROM verification_codes[\s\S]{0,120}expires_at/, "Expired verification records must be cleaned up");
assert.match(server, /pg_try_advisory_xact_lock[\s\S]{0,800}DELETE FROM verification_codes/, "Verification cleanup must elect one bounded database worker");
assert.match(server, /idx_vc_expires_at/, "Verification cleanup must have an expiry index");
assert.match(server, /idx_session_user_id/, "Session invalidation must have a JSON user-id index");
assert.match(server, /pg_advisory_lock/, "Schema initialization must be serialized across replicas");
assert.match(server, /new Worker\(/, "Document parsing must run outside the main event loop");
assert.match(server, /resourceLimits:/, "Document parser workers must have a memory limit");

const railway = readFileSync(path.join(root, "railway.json"), "utf8");
const railwayConfig = JSON.parse(railway) as { deploy?: { drainingSeconds?: unknown } };
const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
const nixpacks = readFileSync(path.join(root, "nixpacks.toml"), "utf8");
const envExample = readFileSync(path.join(root, ".env.example"), "utf8");
const agentsDoc = readFileSync(path.join(root, "AGENTS.md"), "utf8");
const claudeDoc = readFileSync(path.join(root, "CLAUDE.md"), "utf8");
const deploymentDoc = readFileSync(path.join(root, "DEPLOYMENT.md"), "utf8");
assert.match(railway, /"healthcheckPath"\s*:\s*"\/api\/health"/, "Railway must gate deployments on health");
assert.match(railway, /"healthcheckTimeout"\s*:/, "Railway healthcheck timeout must be explicit");
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
assert.match(ciWorkflow, /npm test/, "CI must run the offline TypeScript regression suite");
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
for (const [name, content] of [["AGENTS.md", agentsDoc], ["CLAUDE.md", claudeDoc]] as const) {
  assert.match(content, /## Production Security And Scale/, `${name} must document the production security contract`);
  assert.match(content, /GitHub auto-?deploy/i, `${name} must retain the GitHub to Railway deployment trigger`);
  assert.match(content, /Cloudflare|WAF/, `${name} must identify the edge protection launch gate`);
  assert.match(content, /Redis/, `${name} must identify the distributed rate-limit launch gate`);
  assert.match(content, /object storage/i, `${name} must identify the upload storage launch gate`);
  assert.match(content, /VITE_TLDRAW_LICENSE_KEY/, `${name} must document the production tldraw license gate`);
}
assert.doesNotMatch(deploymentDoc, /Start Command:\s*`?npm run dev/i, "production guides must not run the Vite development server");
assert.match(deploymentDoc, /Wait for CI/i, "Railway autodeploy must wait for CI before production rollout");

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
