/**
 * Integration tests for user subscription persistence.
 *
 * Prerequisites:
 *   - Server running at http://localhost:3001
 *   - A test user account already created (set TEST_EMAIL / TEST_PASSWORD env vars,
 *     or defaults below are used)
 *
 * Run:
 *   npx tsx tests/subscriptions.test.ts
 */

const BASE = process.env.API_BASE ?? 'http://localhost:3001';
const EMAIL = process.env.TEST_EMAIL ?? 'test@example.com';
const PASSWORD = process.env.TEST_PASSWORD ?? 'test123456';

// A real public RSS feed for testing (no RSSHub required)
const TEST_SOURCE_NAME = '__test_atomflow_sub__';
const TEST_RSS_URL = 'https://github.blog/feed/';

let cookie = '';

async function req(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });

  // Capture Set-Cookie
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];

  let json: unknown;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`FAIL: ${msg}`);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testLogin() {
  const r = await req('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
  assert(r.status === 200, `login should return 200, got ${r.status}`);
  assert((r.body as any)?.user?.email === EMAIL, 'login response should contain user');
  console.log('  ✓ login');
}

async function testGetSubscriptionsEmpty() {
  // Clean up any leftover test sub first
  await req('DELETE', `/api/sources/${encodeURIComponent(TEST_SOURCE_NAME)}`);

  const r = await req('GET', '/api/subscriptions');
  assert(r.status === 200, `GET /api/subscriptions should return 200, got ${r.status}`);
  const subs = r.body as any[];
  const existing = subs.find((s: any) => s.name === TEST_SOURCE_NAME);
  assert(!existing, 'test subscription should not exist before creation');
  console.log('  ✓ GET /api/subscriptions (pre-state clean)');
}

async function testAddCustomSubscription() {
  const r = await req('POST', '/api/sources/fetch', {
    source: TEST_SOURCE_NAME,
    input: TEST_RSS_URL,
    color: '#123456'
  });
  assert(r.status === 200, `POST /api/sources/fetch should return 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  assert((r.body as any)?.success === true, 'fetch response should have success:true');
  console.log(`  ✓ POST /api/sources/fetch (added ${(r.body as any).added} articles)`);
}

async function testSubscriptionPersisted() {
  const r = await req('GET', '/api/subscriptions');
  assert(r.status === 200, `GET /api/subscriptions should return 200, got ${r.status}`);
  const subs = r.body as any[];
  const sub = subs.find((s: any) => s.name === TEST_SOURCE_NAME);
  assert(!!sub, 'subscription should appear in list after creation');
  assert(sub.rssUrl === TEST_RSS_URL, 'rssUrl should match');
  assert(sub.color === '#123456', 'color should match');
  console.log('  ✓ GET /api/subscriptions (subscription persisted)');
}

async function testArticlesIncludeUserSource() {
  const r = await req('GET', '/api/articles');
  assert(r.status === 200, `GET /api/articles should return 200, got ${r.status}`);
  const articles = r.body as any[];
  const fromSub = articles.filter((a: any) => a.source === TEST_SOURCE_NAME);
  assert(fromSub.length > 0, 'articles from user subscription should appear in /api/articles');
  console.log(`  ✓ GET /api/articles (${fromSub.length} articles from user subscription)`);
}

async function testRenameSubscription() {
  const newName = TEST_SOURCE_NAME + '_renamed';
  const r = await req('PATCH', '/api/sources/rename', { from: TEST_SOURCE_NAME, to: newName });
  assert(r.status === 200, `PATCH /api/sources/rename should return 200, got ${r.status}: ${JSON.stringify(r.body)}`);

  const listR = await req('GET', '/api/subscriptions');
  const subs = listR.body as any[];
  assert(subs.some((s: any) => s.name === newName), 'renamed subscription should appear');
  assert(!subs.some((s: any) => s.name === TEST_SOURCE_NAME), 'old name should not appear');

  // Rename back for cleanup step
  await req('PATCH', '/api/sources/rename', { from: newName, to: TEST_SOURCE_NAME });
  console.log('  ✓ PATCH /api/sources/rename');
}

async function testDeleteSubscription() {
  const r = await req('DELETE', `/api/sources/${encodeURIComponent(TEST_SOURCE_NAME)}`);
  assert(r.status === 200, `DELETE /api/sources/:source should return 200, got ${r.status}: ${JSON.stringify(r.body)}`);

  const listR = await req('GET', '/api/subscriptions');
  const subs = listR.body as any[];
  assert(!subs.some((s: any) => s.name === TEST_SOURCE_NAME), 'deleted subscription should not appear');
  console.log('  ✓ DELETE /api/sources/:source');
}

async function testArticlesExcludeAfterDelete() {
  const r = await req('GET', '/api/articles');
  assert(r.status === 200, `GET /api/articles should return 200, got ${r.status}`);
  const articles = r.body as any[];
  const fromSub = articles.filter((a: any) => a.source === TEST_SOURCE_NAME);
  assert(fromSub.length === 0, 'articles from deleted subscription should not appear');
  console.log('  ✓ GET /api/articles (user articles removed after delete)');
}

async function testUnauthenticatedSubscriptionsBlocked() {
  // Simulate a fresh unauthenticated request (without cookie)
  const savedCookie = cookie;
  cookie = '';
  const r = await req('GET', '/api/subscriptions');
  assert(r.status === 401, `GET /api/subscriptions without auth should return 401, got ${r.status}`);
  cookie = savedCookie;
  console.log('  ✓ GET /api/subscriptions unauthenticated → 401');
}

async function testLogout() {
  const r = await req('POST', '/api/auth/logout');
  assert(r.status === 200, `logout should return 200, got ${r.status}`);
  console.log('  ✓ logout');
}

// ─── Runner ──────────────────────────────────────────────────────────────────

async function run() {
  const tests = [
    ['Login', testLogin],
    ['GET subscriptions (pre-clean)', testGetSubscriptionsEmpty],
    ['Add custom subscription', testAddCustomSubscription],
    ['Subscription persisted in DB', testSubscriptionPersisted],
    ['Articles include user source', testArticlesIncludeUserSource],
    ['Rename subscription', testRenameSubscription],
    ['Delete subscription', testDeleteSubscription],
    ['Articles exclude deleted source', testArticlesExcludeAfterDelete],
    ['Unauthenticated access blocked', testUnauthenticatedSubscriptionsBlocked],
    ['Logout', testLogout],
  ] as const;

  let passed = 0;
  let failed = 0;

  console.log('\n=== Subscription Persistence Tests ===\n');

  for (const [name, fn] of tests) {
    try {
      console.log(`▶ ${name}`);
      await fn();
      passed++;
    } catch (err: any) {
      console.error(`  ✗ ${err.message}`);
      failed++;
    }
  }

  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
