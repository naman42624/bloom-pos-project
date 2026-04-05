/**
 * Async-first database adapter using pg connection pooling
 * Replaces spawnSync with pg.Pool for non-blocking queries
 * Maintains same interface: prepare(sql).all()/get()/run() returning promises
 */

const { Pool } = require('pg');
const { spawnSync } = require('child_process');
const { addDbTiming } = require('../middleware/request-metrics-context');

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required in .env');
}

// Connection pool with optimized settings
const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

let initialized = false;

// ============ Helper Functions ===================
function normalizeSql(sql) {
  let normalized = String(sql || '').trim();
  if (normalized.endsWith(';')) normalized = normalized.slice(0, -1);
  return normalized;
}

function quoteLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return `'${value.toISOString().replace(/'/g, "''")}'`;
  if (typeof value === 'object') return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
  return `'${String(value).replace(/'/g, "''")}'`;
}

function bindParams(sql, params = []) {
  if (!params || params.length === 0) return sql;

  let paramIndex = 0;
  let inString = false;
  let result = '';

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];

    if (ch === "'") {
      if (inString && sql[i + 1] === "'") {
        result += "''";
        i += 1;
        continue;
      }
      inString = !inString;
      result += ch;
      continue;
    }

    if (!inString && ch === '?') {
      if (paramIndex >= params.length) {
        throw new Error('Insufficient SQL parameters supplied');
      }
      result += quoteLiteral(params[paramIndex]);
      paramIndex += 1;
      continue;
    }

    result += ch;
  }

  if (paramIndex < params.length) {
    throw new Error('Too many SQL parameters supplied');
  }

  return result;
}

// ============ Sync Wrapper for Schema Setup ===================
function _runSyncQuery(sql) {
  const proc = spawnSync('psql', [DATABASE_URL, '-X', '-q', '-t', '-A', '-c', sql], {
    encoding: 'utf8',
  });

  if (proc.status !== 0) {
    const stderr = (proc.stderr || '').trim();
    const stdout = (proc.stdout || '').trim();
    throw new Error(stderr || stdout || 'PostgreSQL query failed');
  }

  return (proc.stdout || '').trim();
}

// Query execution with connection pooling
async function executeQuery(sql) {
  const startedAt = performance.now();
  const client = await pool.connect();
  try {
    const result = await client.query(sql);
    addDbTiming(performance.now() - startedAt);
    return result;
  } catch (err) {
    addDbTiming(performance.now() - startedAt);
    throw new Error(err.message);
  } finally {
    client.release();
  }
}

// ============ Schema Initialization (Sync) ===================
function ensureTableTimestampColumns(tableName, columns, setDefaultColumns = []) {
  const wrapped = `SELECT COALESCE(json_agg(t), '[]'::json)::text FROM (
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = '${tableName}'
    AND column_name IN (${columns.map((c) => `'${c}'`).join(', ')})
  ) t`;
  
  const output = _runSyncQuery(wrapped);
  let cols = [];
  try {
    cols = output && output !== '[]' ? JSON.parse(output) : [];
  } catch {
    cols = [];
  }

  for (const col of cols) {
    const column = col.column_name;
    const type = String(col.data_type || '').toLowerCase();
    const shouldSetDefault = setDefaultColumns.includes(column);

    if (type === 'date') {
      _runSyncQuery(`ALTER TABLE ${tableName} ALTER COLUMN ${column} TYPE TIMESTAMP USING ${column}::timestamp`);
      if (shouldSetDefault) {
        _runSyncQuery(`ALTER TABLE ${tableName} ALTER COLUMN ${column} SET DEFAULT CURRENT_TIMESTAMP`);
      }
      continue;
    }

    if (type === 'text' || type === 'character varying') {
      _runSyncQuery(`
        ALTER TABLE ${tableName}
        ALTER COLUMN ${column} TYPE TIMESTAMP
        USING (
          CASE
            WHEN ${column} IS NULL OR ${column} = '' THEN NULL
            ELSE ${column}::timestamp
          END
        )
      `);
      if (shouldSetDefault) {
        _runSyncQuery(`ALTER TABLE ${tableName} ALTER COLUMN ${column} SET DEFAULT CURRENT_TIMESTAMP`);
      }
    }
  }
}

function ensureCriticalTimestampColumns() {
  ensureTableTimestampColumns('sales', ['created_at', 'updated_at'], ['created_at', 'updated_at']);
  ensureTableTimestampColumns('payments', ['created_at'], ['created_at']);
  ensureTableTimestampColumns('deliveries', ['created_at', 'updated_at', 'assigned_at', 'pickup_time', 'delivered_time'], ['created_at', 'updated_at']);
  ensureTableTimestampColumns('production_logs', ['created_at'], ['created_at']);
  ensureTableTimestampColumns('attendance', ['clock_in', 'clock_out', 'created_at', 'updated_at'], ['created_at', 'updated_at']);
}

function ensureCompatibilityColumns() {
  try {
    const hasExtension = _runSyncQuery("SELECT 1 FROM pg_extension WHERE extname = 'uuid-ossp'");
    if (!hasExtension) {
      _runSyncQuery('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    }
  } catch {
    // Extension may already exist
  }
}

// ============ Prepared Statement Executor ===================
function createPrepared(sql) {
  const rawSql = String(sql || '');

  return {
    async get(...params) {
      const normalized = normalizeSql(rawSql);
      const statement = bindParams(normalized, params);
      
      try {
        const result = await executeQuery(statement);
        return result.rows[0] || undefined;
      } catch (err) {
        console.error('Query error:', statement, err.message);
        throw err;
      }
    },

    async all(...params) {
      const normalized = normalizeSql(rawSql);
      const statement = bindParams(normalized, params);
      
      try {
        const result = await executeQuery(statement);
        return result.rows;
      } catch (err) {
        console.error('Query error:', statement, err.message);
        throw err;
      }
    },

    async run(...params) {
      const normalized = normalizeSql(rawSql);
      const upper = normalized.toUpperCase();
      let statement = normalized;

      // Add RETURNING for INSERT/UPDATE/DELETE
      if (upper.startsWith('INSERT')) {
        if (!/\bRETURNING\b/i.test(statement)) {
          statement += ' RETURNING id';
        }
      } else if (upper.startsWith('UPDATE') || upper.startsWith('DELETE')) {
        if (!/\bRETURNING\b/i.test(statement)) {
          statement += ' RETURNING 1 as _affected';
        }
      }

      const boundStatement = bindParams(statement, params);

      try {
        const result = await executeQuery(boundStatement);
        
        if (upper.startsWith('INSERT')) {
          const rows = result.rows || [];
          return {
            changes: rows.length,
            lastInsertRowid: rows[0]?.id ?? null,
          };
        }

        return {
          changes: result.rowCount || 0,
          lastInsertRowid: null,
        };
      } catch (err) {
        console.error('Query error:', boundStatement, err.message);
        throw err;
      }
    },
  };
}

// ============ Exported API ===================
async function getDb() {
  if (!initialized) {
    try {
      // Test connection
      _runSyncQuery('SELECT 1');
      // Initialize schema
      ensureCriticalTimestampColumns();
      ensureCompatibilityColumns();
      initialized = true;
      console.log('✅ Connected to PostgreSQL (async adapter with pg.Pool)');
    } catch (err) {
      console.error('Database initialization failed:', err.message);
      throw err;
    }
  }

  return {
    prepare(sql) {
      return createPrepared(sql);
    },
    
    async exec(sql) {
      const normalized = normalizeSql(sql);
      await executeQuery(normalized);
    },
    
    transaction(fn) {
      // Simple transaction wrapper
      return async (...args) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await fn(...args);
          await client.query('COMMIT');
          return result;
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }
      };
    },
  };
}

async function closeDb() {
  initialized = false;
  await pool.end();
}

module.exports = { getDb, closeDb };
