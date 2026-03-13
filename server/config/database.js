const { spawnSync } = require('child_process');

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required in .env');
}

let initialized = false;

function ensureTableTimestampColumns(tableName, columns, setDefaultColumns = []) {
  const cols = runSelect(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = '${tableName}'
      AND column_name IN (${columns.map((c) => `'${c}'`).join(', ')})
  `);

  for (const col of cols) {
    const column = col.column_name;
    const type = String(col.data_type || '').toLowerCase();
    const shouldSetDefault = setDefaultColumns.includes(column);

    if (type === 'date') {
      runPsql(`ALTER TABLE ${tableName} ALTER COLUMN ${column} TYPE TIMESTAMP USING ${column}::timestamp`);
      if (shouldSetDefault) {
        runPsql(`ALTER TABLE ${tableName} ALTER COLUMN ${column} SET DEFAULT CURRENT_TIMESTAMP`);
      }
      continue;
    }

    if (type === 'text' || type === 'character varying') {
      runPsql(`
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
        runPsql(`ALTER TABLE ${tableName} ALTER COLUMN ${column} SET DEFAULT CURRENT_TIMESTAMP`);
      }
    }
  }
}

function ensureCriticalTimestampColumns() {
  ensureTableTimestampColumns('sales', ['created_at', 'updated_at'], ['created_at', 'updated_at']);
  ensureTableTimestampColumns('payments', ['created_at'], ['created_at']);
  ensureTableTimestampColumns('deliveries', ['created_at', 'updated_at', 'assigned_at', 'pickup_time', 'delivered_time'], ['created_at', 'updated_at']);
  ensureTableTimestampColumns('production_logs', ['created_at'], ['created_at']);
}

function hasColumn(tableName, columnName) {
  const cols = runSelect(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = '${tableName}'
      AND column_name = '${columnName}'
  `);

  return cols.length > 0;
}

function ensureColumn(tableName, columnName, definitionSql) {
  if (!hasColumn(tableName, columnName)) {
    runPsql(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definitionSql}`);
  }
}

function ensureCompatibilityColumns() {
  ensureColumn('settings', 'updated_by', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');
  ensureColumn('locations', 'gst_number', 'VARCHAR(50)');
  ensureColumn('locations', 'geofence_radius', 'INTEGER DEFAULT 500');
  ensureColumn('user_locations', 'is_primary', 'INTEGER DEFAULT 0');

  if (hasColumn('locations', 'geofence_radius_meters')) {
    runPsql('UPDATE locations SET geofence_radius = COALESCE(geofence_radius, geofence_radius_meters, 500)');
  }

  runPsql('ALTER TABLE locations ALTER COLUMN geofence_radius SET DEFAULT 500');
}

function normalizeSql(sql) {
  let normalized = String(sql || '').trim();
  if (normalized.endsWith(';')) normalized = normalized.slice(0, -1);

  normalized = normalized
    .replace(/datetime\('now'\)/gi, 'CURRENT_TIMESTAMP')
    .replace(/date\('now'\)/gi, 'CURRENT_DATE');

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

function runPsql(sql) {
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

function runSelect(sql) {
  const wrapped = `SELECT COALESCE(json_agg(t), '[]'::json)::text FROM (${sql}) t`;
  const output = runPsql(wrapped);

  if (!output) return [];

  const payload = output
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .join('\n') || '[]';
  try {
    return JSON.parse(payload);
  } catch {
    return [];
  }
}

function runMutation(sql, mode) {
  const output = runPsql(sql);
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (mode === 'insert') {
    const first = lines[0];
    const parsed = first != null && first !== '' && !Number.isNaN(Number(first))
      ? Number(first)
      : first || null;
    return {
      changes: lines.length,
      lastInsertRowid: parsed,
    };
  }

  return {
    changes: lines.length,
    lastInsertRowid: null,
  };
}

function toRunStatement(sql) {
  const normalized = normalizeSql(sql);
  const upper = normalized.toUpperCase();
  const isInsertIgnore = /^\s*INSERT\s+OR\s+IGNORE\s+INTO\s+/i.test(normalized);

  let statement = normalized.replace(/^\s*INSERT\s+OR\s+IGNORE\s+INTO\s+/i, 'INSERT INTO ');

  if (isInsertIgnore) {
    statement += ' ON CONFLICT DO NOTHING';
  }

  if (upper.startsWith('INSERT')) {
    if (!/\bRETURNING\b/i.test(statement)) {
      statement += ' RETURNING id';
    }
    return { statement, mode: 'insert' };
  }

  if (upper.startsWith('UPDATE') || upper.startsWith('DELETE')) {
    if (!/\bRETURNING\b/i.test(statement)) {
      statement += ' RETURNING 1 as _affected';
    }
    return { statement, mode: 'mutate' };
  }

  return { statement, mode: 'other' };
}

function createPrepared(sql) {
  const rawSql = String(sql || '');

  return {
    get(...params) {
      const statement = bindParams(normalizeSql(rawSql), params);
      const rows = runSelect(statement);
      return rows[0] || undefined;
    },
    all(...params) {
      const statement = bindParams(normalizeSql(rawSql), params);
      return runSelect(statement);
    },
    run(...params) {
      const { statement: base, mode } = toRunStatement(rawSql);
      const statement = bindParams(base, params);

      if (mode === 'insert' || mode === 'mutate') {
        return runMutation(statement, mode);
      }

      runPsql(statement);
      return { changes: 0, lastInsertRowid: null };
    },
  };
}

function getDb() {
  if (!initialized) {
    runPsql('SELECT 1');
    ensureCriticalTimestampColumns();
    ensureCompatibilityColumns();
    initialized = true;
    console.log('✅ Connected to PostgreSQL');
  }

  return {
    prepare(sql) {
      return createPrepared(sql);
    },
    exec(sql) {
      runPsql(normalizeSql(sql));
    },
    transaction(fn) {
      return (...args) => fn(...args);
    },
  };
}

function closeDb() {
  initialized = false;
}

module.exports = { getDb, closeDb };
