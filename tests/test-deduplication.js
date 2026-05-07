// Test URL normalization and deduplication
import pg from 'pg';
import dotenv from 'dotenv';
import { createHash, randomUUID } from 'crypto';

dotenv.config();

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
});

// Copy the functions from server.ts
function normalizeArticleUrl(url) {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    let normalized = parsed.href.replace(/\/$/, '');
    return normalized;
  } catch {
    return url;
  }
}

function generateContentHash(title, source, excerpt) {
  const content = `${title.trim()}|${source.trim()}|${excerpt.trim().slice(0, 200)}`;
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

async function testDeduplication() {
  console.log('=== Testing Knowledge Base Deduplication ===\n');

  try {
    // Get test user
    const userResult = await pool.query('SELECT id FROM users WHERE email = $1', ['test@atomflow.local']);
    if (userResult.rows.length === 0) {
      console.log('❌ Test user not found');
      return;
    }
    const userId = userResult.rows[0].id;
    console.log(`✅ Test user ID: ${userId}\n`);

    // Test 1: URL Normalization
    console.log('Test 1: URL Normalization');
    const testUrls = [
      'https://example.com/article?utm_source=twitter',
      'https://example.com/article?utm_source=facebook',
      'https://example.com/article#section1',
      'https://example.com/article/',
      'https://example.com/article'
    ];

    console.log('Testing URL normalization:');
    const normalized = testUrls.map(url => normalizeArticleUrl(url));
    const allSame = normalized.every(url => url === normalized[0]);

    testUrls.forEach((url, i) => {
      console.log(`  ${url} -> ${normalized[i]}`);
    });

    console.log(allSame ? '✅ All URLs normalize to same value' : '❌ URLs normalize differently');
    console.log('');

    // Test 2: Content Hash
    console.log('Test 2: Content Hash for Articles Without URL');
    const article1 = {
      title: '测试文章标题',
      source: '测试来源',
      excerpt: '这是一段测试摘要内容，用于验证内容哈希功能是否正常工作。'
    };

    const article2 = {
      title: '测试文章标题',
      source: '测试来源',
      excerpt: '这是一段测试摘要内容，用于验证内容哈希功能是否正常工作。'
    };

    const article3 = {
      title: '测试文章标题',
      source: '不同来源',
      excerpt: '这是一段测试摘要内容，用于验证内容哈希功能是否正常工作。'
    };

    const hash1 = generateContentHash(article1.title, article1.source, article1.excerpt);
    const hash2 = generateContentHash(article2.title, article2.source, article2.excerpt);
    const hash3 = generateContentHash(article3.title, article3.source, article3.excerpt);

    console.log(`  Article 1 hash: ${hash1.slice(0, 16)}...`);
    console.log(`  Article 2 hash: ${hash2.slice(0, 16)}...`);
    console.log(`  Article 3 hash: ${hash3.slice(0, 16)}...`);
    console.log(hash1 === hash2 ? '✅ Same articles produce same hash' : '❌ Hash mismatch for same articles');
    console.log(hash1 !== hash3 ? '✅ Different articles produce different hash' : '❌ Different articles have same hash');
    console.log('');

    // Test 3: Database Deduplication
    console.log('Test 3: Database Deduplication');

    // Insert test article with URL
    const testUrl = 'https://test-dedup.example.com/article-' + Date.now();
    const normalizedTestUrl = normalizeArticleUrl(testUrl);

    console.log(`  Inserting article with URL: ${testUrl}`);
    const insert1 = await pool.query(
      `INSERT INTO saved_articles (user_id, title, url, source, topic, excerpt, content)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, url) WHERE url IS NOT NULL
       DO UPDATE SET title = EXCLUDED.title
       RETURNING id`,
      [userId, 'Test Article', normalizedTestUrl, 'Test Source', 'Test', 'Test excerpt', 'Test content']
    );
    const savedId1 = insert1.rows[0].id;
    console.log(`  ✅ First insert: saved_article_id = ${savedId1}`);

    // Try to insert same article with different query params
    const testUrlWithParams = testUrl + '?utm_source=test&ref=twitter';
    const normalizedTestUrl2 = normalizeArticleUrl(testUrlWithParams);

    console.log(`  Attempting duplicate insert with URL: ${testUrlWithParams}`);
    const insert2 = await pool.query(
      `INSERT INTO saved_articles (user_id, title, url, source, topic, excerpt, content)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, url) WHERE url IS NOT NULL
       DO UPDATE SET title = EXCLUDED.title
       RETURNING id`,
      [userId, 'Test Article Updated', normalizedTestUrl2, 'Test Source', 'Test', 'Test excerpt', 'Test content']
    );
    const savedId2 = insert2.rows[0].id;
    console.log(`  ✅ Second insert: saved_article_id = ${savedId2}`);
    console.log(savedId1 === savedId2 ? '✅ Duplicate detected (same ID returned)' : '❌ Duplicate not detected (different IDs)');
    console.log('');

    // Test 4: Content Hash Deduplication
    console.log('Test 4: Content Hash Deduplication (No URL)');
    const testTitle = 'Test Article No URL ' + Date.now();
    const testSource = 'Test Source';
    const testExcerpt = 'Test excerpt for content hash deduplication';
    const testHash = generateContentHash(testTitle, testSource, testExcerpt);

    console.log(`  Inserting article without URL (hash: ${testHash.slice(0, 16)}...)`);
    const insert3 = await pool.query(
      `INSERT INTO saved_articles (user_id, title, url, source, topic, excerpt, content, content_hash)
       VALUES ($1, $2, NULL, $3, $4, $5, $6, $7)
       RETURNING id`,
      [userId, testTitle, testSource, 'Test', testExcerpt, 'Test content', testHash]
    );
    const savedId3 = insert3.rows[0].id;
    console.log(`  ✅ First insert: saved_article_id = ${savedId3}`);

    // Check if duplicate exists
    const checkDup = await pool.query(
      `SELECT id FROM saved_articles WHERE user_id = $1 AND content_hash = $2`,
      [userId, testHash]
    );
    console.log(checkDup.rows.length > 0 ? '✅ Content hash lookup works' : '❌ Content hash lookup failed');
    console.log('');

    // Test 5: UUID Card IDs
    console.log('Test 5: UUID Card ID Generation');
    const cardIds = [];
    for (let i = 0; i < 5; i++) {
      cardIds.push(randomUUID());
    }

    console.log('  Generated card IDs:');
    cardIds.forEach((id, i) => {
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
      console.log(`    ${i + 1}. ${id} ${isUUID ? '✅' : '❌'}`);
    });

    const allUnique = new Set(cardIds).size === cardIds.length;
    console.log(allUnique ? '✅ All IDs are unique' : '❌ Duplicate IDs found');
    console.log('');

    // Cleanup test data
    console.log('Cleaning up test data...');
    await pool.query('DELETE FROM saved_articles WHERE user_id = $1 AND (url LIKE $2 OR title LIKE $3)',
      [userId, '%test-dedup.example.com%', '%Test Article No URL%']);
    console.log('✅ Cleanup complete');

  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await pool.end();
  }
}

testDeduplication();
