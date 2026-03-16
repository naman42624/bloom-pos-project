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

function ensureCoreTables() {
  runPsql(`
    CREATE TABLE IF NOT EXISTS material_categories (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      unit VARCHAR(50) DEFAULT 'pcs',
      has_bundle INTEGER DEFAULT 0,
      default_bundle_size DECIMAL(10,2) DEFAULT 1,
      is_perishable INTEGER DEFAULT 1,
      default_storage VARCHAR(100) DEFAULT 'room_temp',
      is_active INTEGER DEFAULT 1,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  runPsql(`
    CREATE TABLE IF NOT EXISTS supplier_materials (
      id SERIAL PRIMARY KEY,
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
      material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
      default_price_per_unit DECIMAL(10,2) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(supplier_id, material_id)
    )
  `);
  runPsql('CREATE INDEX IF NOT EXISTS idx_supplier_materials_supplier ON supplier_materials(supplier_id)');
  runPsql('CREATE INDEX IF NOT EXISTS idx_supplier_materials_material ON supplier_materials(material_id)');

  runPsql(`
    CREATE TABLE IF NOT EXISTS material_transactions (
      id SERIAL PRIMARY KEY,
      material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
      location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      type VARCHAR(50) NOT NULL,
      quantity DECIMAL(10,2) NOT NULL,
      unit VARCHAR(50),
      reference_type VARCHAR(50),
      reference_id INTEGER,
      notes TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  runPsql('CREATE INDEX IF NOT EXISTS idx_material_txn_material ON material_transactions(material_id)');
  runPsql('CREATE INDEX IF NOT EXISTS idx_material_txn_location ON material_transactions(location_id)');
  runPsql('CREATE INDEX IF NOT EXISTS idx_material_txn_created_at ON material_transactions(created_at)');

  runPsql(`
    CREATE TABLE IF NOT EXISTS daily_stock_logs (
      id SERIAL PRIMARY KEY,
      material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
      location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      date DATE NOT NULL,
      opening_stock DECIMAL(10,2) DEFAULT 0,
      stock_in DECIMAL(10,2) DEFAULT 0,
      stock_out DECIMAL(10,2) DEFAULT 0,
      closing_stock DECIMAL(10,2) DEFAULT 0,
      expected_closing DECIMAL(10,2) DEFAULT 0,
      wastage DECIMAL(10,2) DEFAULT 0,
      notes TEXT,
      counted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(material_id, location_id, date)
    )
  `);
  runPsql('CREATE INDEX IF NOT EXISTS idx_daily_stock_logs_date ON daily_stock_logs(date)');

  runPsql(`
    CREATE TABLE IF NOT EXISTS stock_transfers (
      id SERIAL PRIMARY KEY,
      from_location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      to_location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
      quantity DECIMAL(10,2) NOT NULL,
      unit VARCHAR(50) DEFAULT 'pcs',
      status VARCHAR(50) DEFAULT 'initiated',
      notes TEXT,
      initiated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      received_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  runPsql(`
    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      method VARCHAR(50) DEFAULT 'cash',
      amount DECIMAL(10,2) NOT NULL,
      reference_number VARCHAR(255),
      received_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  runPsql('CREATE INDEX IF NOT EXISTS idx_payments_sale ON payments(sale_id)');
  runPsql('CREATE INDEX IF NOT EXISTS idx_payments_method ON payments(method)');
  runPsql('CREATE INDEX IF NOT EXISTS idx_stock_transfers_from ON stock_transfers(from_location_id)');
  runPsql('CREATE INDEX IF NOT EXISTS idx_stock_transfers_to ON stock_transfers(to_location_id)');
  runPsql('CREATE INDEX IF NOT EXISTS idx_stock_transfers_status ON stock_transfers(status)');

  runPsql(`
    CREATE TABLE IF NOT EXISTS production_logs (
      id SERIAL PRIMARY KEY,
      product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
      location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
      quantity DECIMAL(10,2) NOT NULL DEFAULT 0,
      sale_id INTEGER REFERENCES sales(id) ON DELETE SET NULL,
      task_id INTEGER REFERENCES production_tasks(id) ON DELETE SET NULL,
      produced_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  runPsql('CREATE INDEX IF NOT EXISTS idx_production_logs_created_at ON production_logs(created_at)');
  runPsql('CREATE INDEX IF NOT EXISTS idx_production_logs_produced_by ON production_logs(produced_by)');

  runPsql(`
    CREATE TABLE IF NOT EXISTS refunds (
      id SERIAL PRIMARY KEY,
      sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      amount DECIMAL(10,2) NOT NULL DEFAULT 0,
      reason TEXT,
      refunded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  runPsql('CREATE INDEX IF NOT EXISTS idx_refunds_sale ON refunds(sale_id)');

  runPsql(`
    CREATE TABLE IF NOT EXISTS product_stock (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      quantity DECIMAL(10,2) DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(product_id, location_id)
    )
  `);
  runPsql('CREATE INDEX IF NOT EXISTS idx_product_stock_location ON product_stock(location_id)');

  runPsql(`
    CREATE TABLE IF NOT EXISTS employee_salaries (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      monthly_salary DECIMAL(10,2) NOT NULL DEFAULT 0,
      salary_type VARCHAR(50) DEFAULT 'monthly',
      notes TEXT,
      effective_from DATE DEFAULT CURRENT_DATE,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  runPsql(`
    CREATE TABLE IF NOT EXISTS salary_history (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      old_salary DECIMAL(10,2) DEFAULT 0,
      new_salary DECIMAL(10,2) DEFAULT 0,
      salary_type VARCHAR(50) DEFAULT 'monthly',
      reason TEXT,
      changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  runPsql('CREATE INDEX IF NOT EXISTS idx_salary_history_user ON salary_history(user_id)');

  runPsql(`
    CREATE TABLE IF NOT EXISTS salary_payments (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      period_start DATE NOT NULL,
      period_end DATE NOT NULL,
      base_salary DECIMAL(10,2) DEFAULT 0,
      days_worked DECIMAL(10,2) DEFAULT 0,
      days_in_period DECIMAL(10,2) DEFAULT 0,
      hours_worked DECIMAL(10,2) DEFAULT 0,
      late_days INTEGER DEFAULT 0,
      absent_days INTEGER DEFAULT 0,
      leaves_taken INTEGER DEFAULT 0,
      deductions DECIMAL(10,2) DEFAULT 0,
      advances_deducted DECIMAL(10,2) DEFAULT 0,
      bonus DECIMAL(10,2) DEFAULT 0,
      net_amount DECIMAL(10,2) DEFAULT 0,
      payment_method VARCHAR(50) DEFAULT 'cash',
      payment_reference VARCHAR(255),
      status VARCHAR(50) DEFAULT 'paid',
      paid_at TIMESTAMP,
      paid_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  runPsql('CREATE INDEX IF NOT EXISTS idx_salary_payments_user_period ON salary_payments(user_id, period_start, period_end)');

  // Purchase order line items (separate table instead of JSONB column in purchase_orders)
  runPsql(`
    CREATE TABLE IF NOT EXISTS purchase_order_items (
      id SERIAL PRIMARY KEY,
      purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
      expected_quantity DECIMAL(10,2) DEFAULT 0,
      expected_unit VARCHAR(50) DEFAULT 'pieces',
      expected_price_per_unit DECIMAL(10,2) DEFAULT 0,
      received_quantity DECIMAL(10,2) DEFAULT 0,
      received_unit VARCHAR(50),
      actual_price_per_unit DECIMAL(10,2) DEFAULT 0,
      quality VARCHAR(100),
      received_at TIMESTAMP,
      received_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      notes TEXT
    )
  `);
  runPsql('CREATE INDEX IF NOT EXISTS idx_po_items_order ON purchase_order_items(purchase_order_id)');
  runPsql('CREATE INDEX IF NOT EXISTS idx_po_items_material ON purchase_order_items(material_id)');

  // Seed default material categories if table is empty
  const catCount = runPsql("SELECT COUNT(*) FROM material_categories");
  if (catCount.trim() === '0') {
    const defaultCategories = [
      ['Flowers', 'stems', 1, 20, 1, 'room_temp'],
      ['Ribbons', 'pieces', 0, 1, 0, 'shop'],
      ['Vases', 'pieces', 0, 1, 0, 'warehouse'],
      ['Wrapping Paper', 'sheets', 0, 1, 0, 'shop'],
      ['Floral Foam', 'blocks', 1, 24, 0, 'shop'],
      ['Baskets', 'pieces', 0, 1, 0, 'warehouse'],
      ['Decorative Items', 'pieces', 0, 1, 0, 'shop'],
    ];
    for (const [name, unit, has_bundle, bundle_size, is_perishable, storage] of defaultCategories) {
      runPsql(`INSERT INTO material_categories (name, unit, has_bundle, default_bundle_size, is_perishable, default_storage) VALUES ('${name}', '${unit}', ${has_bundle}, ${bundle_size}, ${is_perishable}, '${storage}') ON CONFLICT (name) DO NOTHING`);
    }
  }
}

function ensureCompatibilityColumns() {
  ensureCoreTables();

  ensureColumn('settings', 'updated_by', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');
  ensureColumn('locations', 'gst_number', 'VARCHAR(50)');
  ensureColumn('locations', 'geofence_radius', 'INTEGER DEFAULT 500');
  ensureColumn('user_locations', 'is_primary', 'INTEGER DEFAULT 0');
  ensureColumn('production_tasks', 'picked_by', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');
  ensureColumn('materials', 'min_stock_alert', 'INTEGER DEFAULT 10');
    // Materials: add columns expected by routes but missing from schema.sql
    ensureColumn('materials', 'bundle_size_override', 'DECIMAL(10,2)');
    ensureColumn('materials', 'image_url', 'TEXT');
    ensureColumn('materials', 'created_by', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');

    // Suppliers: add columns expected by routes but missing from schema.sql
    ensureColumn('suppliers', 'gst_number', 'VARCHAR(50)');
    ensureColumn('suppliers', 'notes', "TEXT DEFAULT ''");
    ensureColumn('suppliers', 'created_by', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');

    // Purchase orders: add columns expected by routes
    ensureColumn('purchase_orders', 'expected_date', 'DATE');
    ensureColumn('purchase_orders', 'expected_time', 'TIME');

    // material_stock: if cost_per_unit NOT NULL exists (from schema.sql), make it nullable
    if (hasColumn('material_stock', 'cost_per_unit')) {
      try { runPsql('ALTER TABLE material_stock ALTER COLUMN cost_per_unit SET DEFAULT 0'); } catch (_) {}
      try { runPsql('ALTER TABLE material_stock ALTER COLUMN cost_per_unit DROP NOT NULL'); } catch (_) {}
    }

    // Fix wrong FK on materials.category_id: schema.sql mistakenly references categories(id)
    // instead of material_categories(id). Drop the wrong constraint so material creation works.
    const wrongMatFk = runSelect(`
      SELECT tc.constraint_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND kcu.table_schema = 'public'
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name AND ccu.table_schema = 'public'
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
        AND tc.table_name = 'materials'
        AND kcu.column_name = 'category_id'
        AND ccu.table_name = 'categories'
    `);
    for (const row of wrongMatFk) {
      try { runPsql(`ALTER TABLE materials DROP CONSTRAINT "${row.constraint_name}"`); } catch (_) {}
    }

    // Drop over-restrictive CHECK constraint on purchase_orders.status
    // (schema.sql only allows 'pending','received','partial','cancelled' but routes use 'expected','partially_received')
    try { runPsql('ALTER TABLE purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_status_check'); } catch (_) {}
  ensureColumn('products', 'tax_rate_id', 'INTEGER REFERENCES tax_rates(id) ON DELETE SET NULL');
  ensureColumn('products', 'type', "VARCHAR(50) DEFAULT 'standard'");
  ensureColumn('products', 'category', 'VARCHAR(100)');
  ensureColumn('products', 'location_id', 'INTEGER REFERENCES locations(id) ON DELETE SET NULL');
  ensureColumn('products', 'estimated_cost', 'DECIMAL(10,2) DEFAULT 0');
  ensureColumn('products', 'created_by', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');
  ensureColumn('tax_rates', 'percentage', 'DECIMAL(5,2) DEFAULT 0');

  ensureColumn('payments', 'reference_number', 'VARCHAR(255)');
  ensureColumn('payments', 'received_by', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');
  ensureColumn('payments', 'created_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP');

  ensureColumn('production_logs', 'sale_id', 'INTEGER REFERENCES sales(id) ON DELETE SET NULL');
  ensureColumn('production_logs', 'task_id', 'INTEGER REFERENCES production_tasks(id) ON DELETE SET NULL');
  ensureColumn('production_logs', 'created_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP');

  ensureColumn('deliveries', 'delivery_partner_id', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');
  ensureColumn('delivery_settlements', 'delivery_partner_id', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');
  ensureColumn('employee_shifts', 'days_of_week', "JSONB DEFAULT '[0,1,2,3,4,5]'::jsonb");
  ensureColumn('employee_shifts', 'shift_segments', 'JSONB');
  ensureColumn('employee_shifts', 'created_by', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');

  if (hasColumn('deliveries', 'partner_id')) {
    runPsql('UPDATE deliveries SET delivery_partner_id = COALESCE(delivery_partner_id, partner_id)');
  }
  if (hasColumn('delivery_settlements', 'partner_id')) {
    runPsql('UPDATE delivery_settlements SET delivery_partner_id = COALESCE(delivery_partner_id, partner_id)');
  }

  if (hasColumn('locations', 'geofence_radius_meters')) {
    runPsql('UPDATE locations SET geofence_radius = COALESCE(geofence_radius, geofence_radius_meters, 500)');
  }

  if (hasColumn('materials', 'warning_stock')) {
    runPsql('UPDATE materials SET min_stock_alert = COALESCE(min_stock_alert, warning_stock, 10)');
  }

  if (hasColumn('tax_rates', 'rate')) {
    runPsql('UPDATE tax_rates SET percentage = COALESCE(percentage, rate, 0)');
  }

  runPsql('ALTER TABLE locations ALTER COLUMN geofence_radius SET DEFAULT 500');
  runPsql('ALTER TABLE materials ALTER COLUMN min_stock_alert SET DEFAULT 10');
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
