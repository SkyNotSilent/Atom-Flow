// Direct database schema verification script
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
});

async function verifySchema() {
  console.log('=== Database Schema Verification ===\n');

  try {
    // Check saved_articles columns
    console.log('1. Checking saved_articles table...');
    const articlesColumns = await pool.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'saved_articles'
      ORDER BY ordinal_position
    `);

    console.log('Columns in saved_articles:');
    articlesColumns.rows.forEach(col => {
      const marker = col.column_name === 'content_hash' ? '✅ NEW' : '';
      console.log(`  - ${col.column_name} (${col.data_type}) ${marker}`);
    });

    const hasContentHash = articlesColumns.rows.some(col => col.column_name === 'content_hash');
    console.log(hasContentHash ? '✅ content_hash column exists' : '❌ content_hash column missing');
    console.log('');

    // Check saved_cards columns
    console.log('2. Checking saved_cards table...');
    const cardsColumns = await pool.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'saved_cards'
      ORDER BY ordinal_position
    `);

    console.log('Columns in saved_cards:');
    cardsColumns.rows.forEach(col => {
      const marker = col.column_name === 'updated_at' ? '✅ NEW' : '';
      console.log(`  - ${col.column_name} (${col.data_type}) ${marker}`);
    });

    const hasUpdatedAt = cardsColumns.rows.some(col => col.column_name === 'updated_at');
    console.log(hasUpdatedAt ? '✅ updated_at column exists' : '❌ updated_at column missing');
    console.log('');

    // Check indexes
    console.log('3. Checking indexes...');
    const indexes = await pool.query(`
      SELECT indexname, tablename
      FROM pg_indexes
      WHERE tablename IN ('saved_articles', 'saved_cards')
      AND (indexname LIKE '%content_hash%' OR indexname LIKE '%updated%')
    `);

    console.log('Relevant indexes:');
    indexes.rows.forEach(idx => {
      console.log(`  - ${idx.indexname} on ${idx.tablename}`);
    });
    console.log('');

    // Check sample data
    console.log('4. Checking sample data...');
    const sampleArticles = await pool.query(`
      SELECT id, title, url, content_hash
      FROM saved_articles
      LIMIT 3
    `);

    console.log(`Sample saved_articles (${sampleArticles.rows.length} rows):`);
    sampleArticles.rows.forEach(row => {
      console.log(`  - ID: ${row.id}, Hash: ${row.content_hash ? row.content_hash.slice(0, 16) + '...' : 'NULL'}`);
    });
    console.log('');

    const sampleCards = await pool.query(`
      SELECT id, type, created_at, updated_at
      FROM saved_cards
      LIMIT 3
    `);

    console.log(`Sample saved_cards (${sampleCards.rows.length} rows):`);
    sampleCards.rows.forEach(row => {
      console.log(`  - ID: ${row.id.slice(0, 8)}..., Type: ${row.type}, Updated: ${row.updated_at ? 'YES' : 'NO'}`);
    });
    console.log('');

    // Summary
    console.log('=== Summary ===');
    console.log(hasContentHash ? '✅ content_hash migration successful' : '❌ content_hash migration failed');
    console.log(hasUpdatedAt ? '✅ updated_at migration successful' : '❌ updated_at migration failed');

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await pool.end();
  }
}

verifySchema();
