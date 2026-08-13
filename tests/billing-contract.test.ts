import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

const section = (source: string, start: string, end: string) => {
  const startIndex = source.indexOf(start);
  assert.ok(startIndex >= 0, `missing section start: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(endIndex > startIndex, `missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
};

test('billing schema keeps a minimal idempotent audit cache', () => {
  const schema = read('src/server/billing/schema.ts');
  for (const table of [
    'billing_customers',
    'billing_checkout_attempts',
    'billing_subscriptions',
    'billing_webhook_events',
    'billing_usage_events',
  ]) {
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(schema, /billing_customers[\s\S]*?user_id\s+INTEGER REFERENCES users\(id\) ON DELETE SET NULL/);
  assert.match(schema, /billing_subscriptions[\s\S]*?user_id\s+INTEGER REFERENCES users\(id\) ON DELETE SET NULL/);
  assert.match(schema, /PRIMARY KEY \(environment, event_id\)/, 'webhook event IDs must be environment-scoped and idempotent');
  assert.match(schema, /last_event_occurred_at\s+TIMESTAMPTZ NOT NULL/, 'subscription writes must support occurred_at ordering');
  assert.match(schema, /idx_billing_attempt_request[\s\S]*?environment, user_id, request_id/, 'checkout request IDs must be unique per user and environment');
  assert.match(schema, /idx_billing_attempt_pending_user[\s\S]*?status IN \('creating', 'reconciling', 'draft', 'completed'\)/, 'only genuinely uncertain checkout states may block a new purchase');
  assert.doesNotMatch(schema, /idx_billing_attempt_pending_user[^;]*'failed'/, 'authoritatively failed attempts must not lock an account forever');
  assert.match(schema, /idx_billing_usage_idempotency[\s\S]*?operation_key/, 'refundable AI usage events must be idempotent');
  assert.match(schema, /FOREIGN KEY \(environment, billing_customer_id\)[\s\S]*?REFERENCES billing_customers\(environment, id\)/,
    'billing customer references must be constrained to the same Paddle environment');
  assert.match(schema, /billing customer environment mismatch[\s\S]*?billing_subscription_customer_environment_fkey/,
    'incremental migration must quarantine existing cross-environment subscription references before validation');
  assert.match(schema, /duplicate non-terminal subscription requires manual review[\s\S]*?idx_billing_subscription_nonterminal_user/,
    'migration must quarantine duplicate live subscriptions before enforcing one per user and environment');
  assert.match(schema, /idx_billing_subscription_nonterminal_user[\s\S]*?environment, user_id[\s\S]*?status IN \('active', 'trialing', 'past_due', 'paused'\)/);
  assert.match(schema, /idx_billing_webhook_pending[\s\S]*?environment, next_attempt_at, received_at/,
    'webhook inbox scans must use an environment-leading partial index');
  assert.doesNotMatch(schema, /card_number|card_cvc|paddle_signature|webhook_secret/i, 'billing tables must not persist card data or webhook secrets');
});

test('Paddle webhook preserves the raw body and bypasses only the browser Origin guard', () => {
  const server = read('server.ts');
  const service = read('src/server/billing/service.ts');
  const routeIndex = server.indexOf('/api/billing/webhooks/paddle');
  const jsonIndex = server.indexOf('app.use(express.json(');
  const originGuardIndex = server.indexOf('app.use("/api", mutationOriginGuard)');

  assert.ok(routeIndex >= 0, 'Paddle webhook route must exist');
  assert.ok(routeIndex < jsonIndex, 'Paddle webhook must be mounted before express.json mutates the body');
  assert.ok(routeIndex < originGuardIndex, 'Paddle webhook must be mounted before the browser mutation Origin guard');
  assert.match(server.slice(Math.max(0, routeIndex - 600), routeIndex + 1200), /express\.raw\([\s\S]*?(?:256kb|256\s*\*\s*1024)/i);
  assert.match(server, /Paddle-Signature|paddle-signature/i);
  assert.match(service, /webhooks\.unmarshal\(/, 'the official SDK must verify signatures from the exact raw body');
  assert.match(service, /ON CONFLICT \(environment, event_id\) DO NOTHING/, 'webhook replay must be idempotent');
  assert.match(service, /atomflow-billing-event:\$\{this\.config\.environment\}:\$\{eventId\}/,
    'webhook event advisory locks must be environment-scoped');
  assert.match(service, /atomflow-billing-adjustment:\$\{this\.config\.environment\}:\$\{adjustmentIdentity\}/,
    'refund advisory locks must be environment-scoped');
  assert.match(service, /last_event_occurred_at IS NULL[\s\S]*?last_event_occurred_at <= EXCLUDED\.last_event_occurred_at/, 'subscription webhooks must reject stale occurred_at updates');
  assert.match(service, /payload\.status === "approved" && payload\.action === "refund" && payload\.type === "full"/);
  assert.match(service, /subscriptions\.cancel\(subscriptionId, \{ effectiveFrom: "immediately" \}\)/, 'approved full refunds must immediately cancel the subscription');
  assert.match(server, /refunds:\s*["']REFUNDS\.md["']/, 'the deployed instance must serve its own refund policy');
});

test('production CSP uses exact Paddle origins and same-origin media proxies', () => {
  const server = read('server.ts');
  const csp = section(server, 'const paddleFrameOrigins', 'app.use(compression(');
  assert.doesNotMatch(csp, /imgSrc:\s*\[[^\]]*["']https:["']/);
  assert.doesNotMatch(csp, /mediaSrc:\s*\[[^\]]*["']https:["']/);
  assert.match(csp, /frameSrc:\s*billingConfig\.enabled \? paddleFrameOrigins/);
  assert.match(csp, /scriptSrc:\s*\[[\s\S]*?paddleCdnOrigin/);
  const imageProxy = section(server, 'app.get("/api/image-proxy"', '// Authenticated, bounded proxy for podcast audio');
  assert.match(imageProxy, /referencedByGlobalArticle/);
  assert.match(imageProxy, /req\.session\.userId[\s\S]*?user_articles[\s\S]*?markdown_content[\s\S]*?saved_articles/,
    'custom RSS and saved-article image URLs must be authorized from account-owned content');
  assert.match(imageProxy, /candidateHost !== hostname[\s\S]*?ALLOWED_IMAGE_HOST_SUFFIXES/,
    'redirects from account-owned custom images must remain on the original or a fixed allowlisted host');
  assert.match(imageProxy, /isAllowlistedHost \|\| referencedByGlobalArticle[\s\S]*?public, max-age=31536000, immutable[\s\S]*?private, no-store/,
    'account-owned custom images must never enter a shared public cache after user-scoped authorization');
  assert.match(imageProxy, /fetchBoundedPublicResource[\s\S]*?allowedPorts:\s*PUBLIC_WEB_PORTS/,
    'image fetches and every redirect must remain restricted to normal public web ports');
  assert.match(imageProxy, /fetchBoundedPublicResource/);
  const mediaProxy = section(server, 'app.get("/api/media-proxy"', '// Favicon proxy');
  assert.match(mediaProxy, /requireAuth/);
  assert.match(mediaProxy, /user_articles[\s\S]*?saved_articles/);
  assert.match(mediaProxy, /fetchBoundedPublicResource/);
});

test('writing project reads are side-effect free and deletion does not recreate a project', () => {
  const server = read('server.ts');
  const projectList = section(
    server,
    'app.get("/api/write/canvas/projects"',
    'app.post("/api/write/canvas/projects"',
  );
  const projectDelete = section(
    server,
    'app.delete("/api/write/canvas/projects/:id"',
    'app.post("/api/write/canvas/projects/:id/nodes"',
  );

  assert.doesNotMatch(projectList, /ensureCanvasProject|INSERT INTO write_canvas_projects/);
  assert.doesNotMatch(projectDelete, /INSERT INTO write_canvas_projects/);
});

test('Pro permission boundaries cover writing and Notes without gating the knowledge base', () => {
  const server = read('server.ts');
  const routeLines = server.split('\n').filter(line => /app\.(?:get|post|put|delete)\("\/api\/(?:write|notes)/.test(line));
  assert.ok(routeLines.length >= 30, 'route inventory should include all writing and Notes endpoints');
  const notesGuard = section(server, 'app.use("/api/notes"', 'app.use("/api/write"');
  const writeGuard = section(server, 'app.use("/api/write"', 'const reserveDailyAiBudget');
  for (const [name, guard] of [['Notes', notesGuard], ['write', writeGuard]] as const) {
    assert.match(guard, /requireAuth/);
    assert.match(guard, /req\.method === "GET" \|\| req\.method === "HEAD"[\s\S]*?requireMagicWritingReadAccess/,
      `${name} reads must remain available in read-only mode`);
    assert.match(guard, /:\s*requireMagicWritingFullAccess/, `${name} mutations and AI calls must require full access`);
  }
  assert.match(server, /status\.access === "read_only" \? "MAGIC_WRITE_READ_ONLY" : "MAGIC_WRITE_SUBSCRIPTION_REQUIRED"/);
  assert.match(server, /res\.status\(402\)/);

  const knowledgeRouteLines = server.split('\n').filter(line => (
    /app\.(?:get|post|put|delete)\("\/api\/(?:articles|cards|saved-articles|knowledge)/.test(line)
  ));
  assert.ok(knowledgeRouteLines.length > 0, 'knowledge-base route inventory must not be empty');
  for (const line of knowledgeRouteLines) {
    assert.doesNotMatch(line, /requireMagicWriting(?:Read|Full)Access/, `knowledge route must never return a Pro 402: ${line.trim()}`);
  }
});

test('billing and reasonable-use failures retain distinct HTTP semantics', () => {
  const server = read('server.ts');
  const config = read('src/server/billing/config.ts');

  assert.match(server, /res\.status\(401\)\.json\(\{ error: ['"]请先登录['"] \}\)/);
  assert.match(server, /res\.status\(402\)\.json\(\{ code, error \}\)/);
  assert.match(server, /BILLING_UNAVAILABLE[\s\S]*?res\.status\(503\)|res\.status\(503\)[\s\S]*?BILLING_UNAVAILABLE/);
  assert.match(server, /res\.status\(429\)[\s\S]*?今日 AI 使用额度已达到上限/, 'reasonable-use exhaustion must remain a 429');
  assert.match(server, /INVALID_BILLING_PLAN/);
  assert.match(config, /value === "pro_monthly" \|\| value === "pro_yearly"/, 'client-supplied Price IDs must never select a catalog item');
  const billingStatusRoute = section(server, 'app.get("/api/billing/status"', 'app.post("/api/billing/checkout"');
  assert.match(billingStatusRoute, /Cache-Control["'], ["']private, no-store/, 'authenticated entitlement responses must not be cached');
});

test('the public catalog and every new checkout verify the configured Paddle resources lazily', () => {
  const server = read('server.ts');
  const service = read('src/server/billing/service.ts');
  const plansRoute = section(server, 'app.get("/api/billing/plans"', 'app.get("/api/billing/status"');

  assert.match(plansRoute, /getValidatedPlans/);
  assert.match(service, /paddle\.products\.get\(this\.config\.productId\)/);
  assert.match(service, /paddle\.prices\.get\(this\.config\.priceIds\[plan\.code\]\)/);
  assert.match(service, /price\.status !== "active"/);
  assert.match(service, /price\.unitPrice\.amount !== expectedAmount/);
  assert.match(service, /price\.unitPrice\.currencyCode !== plan\.currency/);
  assert.match(service, /price\.billingCycle\?\.interval !== plan\.interval/);
  assert.match(service, /price\.trialPeriod !== null/);
  assert.match(service, /await this\.assertConfiguredCatalogValid\(\);[\s\S]*?INSERT INTO billing_checkout_attempts/,
    'remote catalog verification must happen before a new checkout attempt is persisted');
  assert.match(plansRoute, /Cache-Control["'], ["']no-store/,
    'temporary Paddle catalog failures must not be cached as a public response');
});

test('refund-eligibility usage cannot be deduplicated with a client-controlled key', () => {
  const server = read('server.ts');
  const skillGenerate = section(server, 'app.post("/api/write/agent/skills/generate"', 'app.get("/api/write/style-skills"');
  const streamingChat = section(server, 'app.post("/api/write/agent/chat/stream"', 'app.post("/api/write/agent/chat"');
  const chat = section(server, 'app.post("/api/write/agent/chat"', '// Vite middleware for development');
  const canvasChat = section(server, 'app.post("/api/write/canvas/agents/:id/chat/stream"', 'app.post("/api/write/canvas/agents/:id/save-result"');

  assert.match(skillGenerate, /skill-generate:\$\{randomUUID\(\)\}/);
  assert.doesNotMatch(skillGenerate, /req\.get\(["']idempotency-key/);
  for (const route of [streamingChat, chat]) {
    assert.match(route, /write-agent:\$\{runId\}/);
    assert.doesNotMatch(route, /operationId|req\.get\(["']idempotency-key/);
    assert.ok(route.indexOf("buildWriteAgentRequest") < route.indexOf("recordUsage"), 'invalid requests must not consume refund-eligibility usage');
  }
  assert.match(canvasChat, /canvas-agent:\$\{req\.params\.id\}:\$\{runId\}/);
  assert.doesNotMatch(canvasChat, /recordUsage[\s\S]{0,200}req\.body\?\.requestId/);
});

test('account export includes minimal billing records but never webhook payloads', () => {
  const server = read('server.ts');
  const exportRoute = section(server, 'app.get("/api/account/export"', 'app.delete("/api/account"');
  assert.match(exportRoute, /billingSubscriptions/);
  assert.match(exportRoute, /billingCheckoutAttempts/);
  assert.match(exportRoute, /billingUsageEvents/);
  assert.doesNotMatch(exportRoute, /billing_webhook_events|normalized_payload|paddle-signature/i);
});
