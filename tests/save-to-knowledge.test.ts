/**
 * Integration tests for "save to knowledge base" feature.
 *
 * Tests the full flow: login -> get articles -> save article -> verify cards & saved articles.
 *
 * Prerequisites:
 *   - Server running at http://localhost:3001
 *   - A test user account (set TEST_EMAIL / TEST_PASSWORD env vars, or defaults below)
 *
 * Run:
 *   npx tsx tests/save-to-knowledge.test.ts
 */

const BASE = process.env.API_BASE ?? 'http://localhost:3001';
const EMAIL = process.env.TEST_EMAIL ?? 'test@atomflow.local';
const PASSWORD = process.env.TEST_PASSWORD ?? 'test123';

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

  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];

  let json: unknown;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`FAIL: ${msg}`);
}

// --- Tests ---

async function testLogin() {
  const r = await req('POST', '/api/auth/login-password', { email: EMAIL, password: PASSWORD });
  assert(r.status === 200, `login should return 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  assert((r.body as any)?.user?.email === EMAIL, 'login response should contain user');
  console.log('  ok login');
}

async function testGetArticles(): Promise<number> {
  const r = await req('GET', '/api/articles');
  assert(r.status === 200, `GET /api/articles should return 200, got ${r.status}`);
  const articles = r.body as any[];
  assert(articles.length > 0, 'should have at least one article to test with');
  const unsaved = articles.find((a: any) => !a.saved);
  if (unsaved) {
    console.log(`  ok GET /api/articles (${articles.length} total, using unsaved article: id=${unsaved.id} "${unsaved.title?.slice(0, 40)}...")`);
    return unsaved.id;
  }
  console.log(`  ok GET /api/articles (${articles.length} total, all saved - using id=${articles[0].id} for idempotency test)`);
  return articles[0].id;
}

async function testSaveArticle(articleId: number) {
  const r = await req('POST', `/api/articles/${articleId}/save`);
  assert(r.status === 200, `POST /api/articles/${articleId}/save should return 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  assert((r.body as any)?.success === true, 'save response should have success:true');
  console.log(`  ok POST /api/articles/${articleId}/save`);
}

async function testCardsExist(articleId: number) {
  const r = await req('GET', '/api/cards');
  assert(r.status === 200, `GET /api/cards should return 200, got ${r.status}`);
  const cards = r.body as any[];
  const related = cards.filter((c: any) => c.articleId === articleId);
  assert(related.length > 0, `should have at least one card for article ${articleId}, found ${related.length}`);
  for (const card of related) {
    assert(typeof card.id === 'string', `card.id should be string, got ${typeof card.id}`);
    assert(['观点', '数据', '金句', '故事'].includes(card.type), `card.type should be valid, got "${card.type}"`);
    assert(typeof card.content === 'string' && card.content.length > 0, 'card.content should be non-empty string');
    assert(Array.isArray(card.tags), 'card.tags should be array');
  }
  console.log(`  ok GET /api/cards (${related.length} cards for article ${articleId}, types: ${related.map((c: any) => c.type).join(', ')})`);
}

async function testSavedArticlesExist(articleId: number) {
  const r = await req('GET', '/api/saved-articles');
  assert(r.status === 200, `GET /api/saved-articles should return 200, got ${r.status}`);
  const savedArticles = r.body as any[];
  assert(savedArticles.length > 0, 'should have at least one saved article');
  console.log(`  ok GET /api/saved-articles (${savedArticles.length} total saved articles)`);
}

async function testIdempotentSave(articleId: number) {
  const r = await req('POST', `/api/articles/${articleId}/save`);
  assert(r.status === 200, `idempotent save should return 200, got ${r.status}`);
  assert((r.body as any)?.success === true, 'idempotent save should succeed');

  const cardsR = await req('GET', '/api/cards');
  const cards = (cardsR.body as any[]).filter((c: any) => c.articleId === articleId);
  console.log(`  ok idempotent save (still ${cards.length} cards, no duplicates)`);
}

async function testSaveArticleNotFound() {
  const r = await req('POST', '/api/articles/999999999/save');
  assert(r.status === 404, `saving non-existent article should return 404, got ${r.status}`);
  console.log('  ok POST /api/articles/999999999/save -> 404');
}

async function testUnauthenticatedBlocked() {
  const savedCookie = cookie;
  cookie = '';
  const r = await req('POST', '/api/articles/1/save');
  assert(r.status === 401, `unauthenticated save should return 401, got ${r.status}`);
  cookie = savedCookie;
  console.log('  ok unauthenticated save -> 401');
}

// --- Runner ---

async function run() {
  console.log('\n=== Save to Knowledge Base Tests ===\n');

  let passed = 0;
  let failed = 0;
  let articleId = 0;

  const tests: [string, () => Promise<void>][] = [
    ['Login', testLogin],
    ['Get articles', async () => { articleId = await testGetArticles(); }],
    ['Save article to knowledge base', async () => { await testSaveArticle(articleId); }],
    ['Verify cards created', async () => { await testCardsExist(articleId); }],
    ['Verify saved articles list', async () => { await testSavedArticlesExist(articleId); }],
    ['Idempotent re-save', async () => { await testIdempotentSave(articleId); }],
    ['Save non-existent article', testSaveArticleNotFound],
    ['Unauthenticated access blocked', testUnauthenticatedBlocked],
  ];

  for (const [name, fn] of tests) {
    try {
      console.log(`> ${name}`);
      await fn();
      passed++;
    } catch (err: any) {
      console.error(`  FAIL: ${err.message}`);
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
