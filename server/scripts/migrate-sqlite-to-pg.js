#!/usr/bin/env node
/**
 * SQLite → PostgreSQL Data Migration Script
 *
 * Migrates all data from the existing SQLite database to PostgreSQL.
 *
 * Prerequisites:
 *   1. PostgreSQL database created and schema.sql applied:
 *      psql $DATABASE_URL < config/schema.sql
 *   2. Environment variables set:
 *      DATABASE_URL=postgresql://user:pass@host:5432/bloomcart
 *
 * Usage:
 *   node scripts/migrate-sqlite-to-pg.js
 *
 * The script:
 *   - Reads all data from SQLite
 *   - Transforms types (INTEGER booleans → BOOLEAN, TEXT JSON → JSONB)
 *   - Inserts into PostgreSQL in correct foreign-key order
 *   - Resets sequences to max(id) + 1
 */

require('dotenv').config();

const Database = require('better-sqlite3');
const { Pool } = require('pg');
const path = require('path');

const SQLITE_PATH = path.join(__dirname, '..', 'database.sqlite');

// Tables in dependency order (parents before children)
const TABLES = [
  'users',
  'locations',
  'user_locations',
  'settings',
  'tax_rates',
  'material_categories',
  'materials',
  'material_stock',
  'suppliers',
  'supplier_materials',
  'purchase_orders',
  'purchase_order_items',
  'material_transactions',
  'daily_stock_logs',
  'stock_transfers',
  'products',
  'product_materials',
  'product_images',
  'product_stock',
  'sales',
  'sale_items',
  'payments',
  'refunds',
  'cash_registers',
  'pre_orders',
  'expenses',
  'customer_addresses',
  'credit_payments',
  'special_dates',
  'production_logs',
  'production_tasks',
  'deliveries',
  'delivery_proofs',
  'delivery_collections',
  'delivery_settlements',
  'delivery_settlement_items',
  'attendance',
  'employee_shifts',
  'outdoor_duty_requests',
  'geofence_events',
  'salary_advances',
  'employee_salaries',
  'salary_history',
  'salary_payments',
  'delivery_locations',
  'delivery_partner_daily',
  'recurring_orders',
  'push_tokens',
  'notifications',
];

// Columns that are BOOLEAN in PG but INTEGER in SQLite
const BOOLEAN_COLUMNS = new Set([
  'is_active', 'is_primary', 'is_default', 'has_bundle', 'is_perishable',
  'is_read', 'push_sent', 'stock_deducted', 'materials_deducted',
  'from_product_stock', 'late_arrival', 'early_departure', 'processed',
  'is_moving',
]);

// Columns that are JSONB in PG but TEXT in SQLite
const JSONB_COLUMNS = new Set([
  'operating_hours', 'custom_dates', 'data', 'days_of_week',
  'shift_segments', 'custom_days', 'items',
]);

function transformValue(column, value) {
  if (value === null || value === undefined) return null;

  if (BOOLEAN_COLUMNS.has(column)) {
    return value === 1 || value === true;
  }

  if (JSONB_COLUMNS.has(column)) {
    if (typeof value === 'string') {
      try {
        JSON.parse(value); // Validate it's valid JSON
        return value;
      } catch {
        return '{}';
      }
    }
    return value;
  }

  return value;
}

async function migrate() {
  console.log('🔄 Starting SQLite → PostgreSQL migration...\n');

  // Connect to both databases
  const sqlite = new Database(SQLITE_PATH, { readonly: true });
  sqlite.pragma('foreign_keys = OFF');

  const pg = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });

  const client = await pg.connect();

  try {
    // Disable triggers during import
    await client.query('SET session_replication_role = replica');

    let totalRows = 0;

    for (const table of TABLES) {
      // Check if table exists in SQLite
      const tableExists = sqlite.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
      ).get(table);

      if (!tableExists) {
        console.log(`⏭️  ${table} — not in SQLite, skipping`);
        continue;
      }

      // Get all rows
      const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
      if (rows.length === 0) {
        console.log(`📭 ${table} — empty, skipping`);
        continue;
      }

      // Get column names from first row
      const columns = Object.keys(rows[0]);

      // Build INSERT statement
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
      const insertSQL = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;

      // Insert all rows
      let inserted = 0;
      for (const row of rows) {
        const values = columns.map(col => transformValue(col, row[col]));
        try {
          const result = await client.query(insertSQL, values);
          inserted += result.rowCount;
        } catch (err) {
          console.error(`  ❌ Error inserting into ${table}:`, err.message);
          console.error('  Row:', JSON.stringify(row).substring(0, 200));
        }
      }

      console.log(`✅ ${table} — ${inserted}/${rows.length} rows migrated`);
      totalRows += inserted;

      // Reset sequence to max ID
      if (columns.includes('id')) {
        try {
          await client.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1))`);
        } catch {
          // Not all tables have sequences
        }
      }
    }

    // Re-enable triggers
    await client.query('SET session_replication_role = DEFAULT');

    console.log(`\n✅ Migration complete! ${totalRows} total rows migrated.`);
    console.log('⚠️  Please verify data integrity manually.');

  } catch (err) {
    console.error('\n❌ Migration failed:', err.message);
    throw err;
  } finally {
    client.release();
    await pg.end();
    sqlite.close();
  }
}

// Run
migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
