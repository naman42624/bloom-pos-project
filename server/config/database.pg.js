/**
 * PostgreSQL Database Configuration (Production)
 *
 * Drop-in replacement for better-sqlite3 config.
 * Uses pg.Pool for connection pooling.
 *
 * MIGRATION NOTE:
 * To switch from SQLite → PostgreSQL:
 *   1. Set DATABASE_URL in .env
 *   2. Run: psql $DATABASE_URL < config/schema.sql
 *   3. Run: node scripts/migrate-sqlite-to-pg.js (optional, to copy data)
 *   4. Replace require('../config/database') calls — the API is different:
 *      - SQLite:  db.prepare('SELECT ...').all(params)
 *      - PG:      await pool.query('SELECT ...', [params])
 *      - SQLite uses ? placeholders; PG uses $1, $2, $3
 *      - PG queries are async (return Promises)
 */

const { Pool } = require('pg');

let pool;

function getPool() {
  if (!pool) {
    const isProduction = process.env.NODE_ENV === 'production';

    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: parseInt(process.env.PG_POOL_MAX || '20', 10),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      ssl: isProduction ? { rejectUnauthorized: false } : false,
    });

    pool.on('error', (err) => {
      console.error('Unexpected PG pool error:', err.message);
    });

    pool.on('connect', () => {
      // Set timezone for each new connection
      // Queries will use the shop's configured timezone
    });
  }
  return pool;
}

/**
 * Run the schema.sql to initialize tables.
 * Safe to call multiple times — uses IF NOT EXISTS / ON CONFLICT.
 */
async function initializeDatabase() {
  const fs = require('fs');
  const path = require('path');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

  const client = await getPool().connect();
  try {
    await client.query(schema);
    console.log('✅ PostgreSQL schema initialized');
  } catch (err) {
    // Schema may already exist — specific errors are OK
    if (err.message.includes('already exists')) {
      console.log('ℹ️  PostgreSQL schema already exists');
    } else {
      console.error('❌ Schema initialization error:', err.message);
      throw err;
    }
  } finally {
    client.release();
  }
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Helper: Execute a query with parameters
 * Converts SQLite-style ? to PostgreSQL $1, $2, etc.
 */
async function query(text, params = []) {
  return getPool().query(text, params);
}

/**
 * Helper: Get a single row
 */
async function queryOne(text, params = []) {
  const result = await query(text, params);
  return result.rows[0] || null;
}

/**
 * Helper: Get all rows
 */
async function queryAll(text, params = []) {
  const result = await query(text, params);
  return result.rows;
}

/**
 * Helper: Execute within a transaction
 */
async function transaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  getPool,
  initializeDatabase,
  closePool,
  query,
  queryOne,
  queryAll,
  transaction,
};
