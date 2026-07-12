import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";
import JSZip from "jszip";
import {
  ConcurrencyLimitError,
  ResponseLimitError,
  buildAllowedOrigins,
  createUserConcurrencyGuard,
  fetchBoundedPublicResource,
  isAllowedMutationOrigin,
  isAllowedUploadSignature,
  isPrivateOrReservedIp,
  readBoundedEnvNumber,
  readResponseBuffer,
  validateDocxArchiveBounds,
  validatePublicHttpUrl,
} from "../src/server/security.js";

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
const viteConfig = readFileSync(path.join(root, "vite.config.ts"), "utf8");
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
assert.match(server, /name:\s*["']atomflow\.sid["']/, "Session cookie must not use the framework default name");
assert.match(server, /req\.session\.regenerate\(/, "Authentication must regenerate the session id");
assert.match(server, /app\.post\(["']\/api\/auth\/login-password["'], passwordLoginLimiter,/, "Password login must be brute-force limited");
assert.match(server, /app\.post\(["']\/api\/auth\/send-code["'], verificationSendLimiter,/, "Verification email sends must be limited");
assert.match(server, /app\.post\(["']\/api\/sources\/fetch["'], requireAuth, remoteFetchLimiter,/, "Custom RSS fetch must require authentication and remote-fetch limits");
assert.match(server, /app\.post\(["']\/api\/sources\/retry["'], requireAuth, remoteFetchLimiter,/, "RSS retry must require authentication and remote-fetch limits");
assert.match(server, /app\.delete\(["']\/api\/sources\/:source["'], requireAuth,/, "Subscription deletion must require authentication");
assert.match(server, /app\.patch\(["']\/api\/sources\/rename["'], requireAuth,/, "Subscription rename must require authentication");
assert.doesNotMatch(server, /app\.post\(["']\/api\/articles\/refresh-cache["']/, "Unused global cache mutation must not be publicly routable");
assert.match(server, /app\.post\(["']\/api\/translate["'], requireAuth, paidOperationLimiter,/, "Translation spend must be limited");
assert.match(server, /app\.post\(["']\/api\/write\/canvas\/agents\/:id\/chat\/stream["'], requireAuth, paidOperationLimiter,/, "Canvas Agent spend must be limited");
assert.match(server, /app\.post\(["']\/api\/write\/agent\/chat\/stream["'], requireAuth, paidOperationLimiter,/, "Writing Agent spend must be limited");
assert.match(server, /connectionTimeoutMillis:/, "PostgreSQL connection acquisition must be bounded");
assert.match(server, /idleTimeoutMillis:/, "Idle PostgreSQL connections must be bounded");
assert.match(server, /await validatePublicHttpUrl\(input\)/, "Custom RSS targets must be checked before parsing");
assert.match(server, /fetchBoundedPublicResource\(/, "Remote proxy responses must have redirect, timeout, DNS and byte boundaries");
assert.match(server, /isAllowedUploadSignature\(req\.file\.buffer/, "Canvas uploads must verify file signatures");
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
