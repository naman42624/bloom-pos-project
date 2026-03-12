/**
 * SQLite to PostgreSQL Migration Script
 * 
 * Exports all data from SQLite database.sqlite and imports into PostgreSQL
 * Usage: node scripts/migrate-sqlite-to-pg.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sqlite3 = require('better-sqlite3');
const { Pool } = require('pg');

const SQLITE_DB = path.join(__dirname, '..', 'database.sqlite');
const DB_URL = process.env.DATABASE_URL;

if (!DB_URL) {
  console.error('❌ DATABASE_URL not set in .env');
  process.exit(1);
}

const sqlite = new sqlite3(SQLITE_DB);
const pool = new Pool({ connectionString: DB_URL });

/**
 * Convert SQLite value to PostgreSQL format
 */
function convertValue(value, columnType) {
  if (value === null || value === undefined) return null;
  if (columnType?.includes('JSONB')) {
    return typeof value === 'string' ? value : JSON.stringify(value);
  }
  if (columnType?.includes('BOOLEAN')) {
    return value ? 1 : 0;
  }
  if (columnType?.includes('DATE')) {
    return value ? value.split(' ')[0] : null;
  }
  if (columnType?.includes('TIMESTAMP')) {
    return value ? new Date(value).toISOString() : null;
  }
  return value;
}

/**
 * Migrate a single table
 */
async function migrateTable(tableName, columns) {
  console.log(`📋 Migrating ${tableName}...`);
  
  try {
    // Fetch all rows from SQLite
    const rows = sqlite.prepare(`SELECT * FROM ${tableName}`).all();
    
    if (rows.length === 0) {
      console.log(`   ✓ ${tableName}: 0 rows`);
      return;
    }

    // Get column names
    const columnNames = Object.keys(rows[0]);
    const placeholders = columnNames.map((_, i) => `$${i + 1}`).join(',');
    const columnList = columnNames.map(c => `"${c}"`).join(',');
    const query = `INSERT INTO ${tableName} (${columnList}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;

    // Insert rows into PostgreSQL
    let inserted = 0;
    for (const row of rows) {
      const values = columnNames.map(col => convertValue(row[col], columns[col]));
      try {
        await pool.query(query, values);
        inserted++;
      } catch (err) {
        console.warn(`   ⚠ Row insert failed in ${tableName}:`, err.message.split('\n')[0]);
      }
    }

    console.log(`   ✓ ${tableName}: ${inserted}/${rows.length} rows`);
  } catch (err) {
    console.error(`   ✗ ${tableName} failed:`, err.message);
  }
}

/**
 * Get column types from PostgreSQL schema
 */
async function getColumnTypes() {
  const result = await pool.query(`
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position
  `);

  const types = {};
  for (const row of result.rows) {
    if (!types[row.table_name]) types[row.table_name] = {};
    types[row.table_name][row.column_name] = row.data_type;
  }
  return types;
}

/**
 * Reset all sequences
 */
async function resetSequences() {
  console.log('\n🔄 Resetting sequences...');
  
  const result = await pool.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND data_type = 'integer' AND column_default LIKE 'nextval%'
  `);

  for (const row of result.rows) {
    // Get max ID from table
    const tableResult = await pool.query(`SELECT MAX("${row.column_name}") as max_id FROM "${row.table_name}"`);
    const maxId = tableResult.rows[0].max_id || 0;
    
    // Reset sequence
    const sequenceName = `${row.table_name}_${row.column_name}_seq`;
    await pool.query(`SELECT setval('${sequenceName}', ${maxId + 1})`);
  }
  
  console.log('   ✓ Sequences reset');
}

/**
 * Main migration function
 */
async function migrate() {
  console.log('🚀 Starting SQLite → PostgreSQL Migration\n');

  try {
    // Get column types
    const columnTypes = await getColumnTypes();

    // Get all table names from SQLite
    const tables = sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite%' ORDER BY name"
    ).all();

    console.log(`Found ${tables.length} tables to migrate\n`);

    // Migrate each table
    for (const table of tables) {
      const tableName = table.name;
      await migrateTable(tableName, columnTypes[tableName] || {});
    }

    // Reset sequences
    await resetSequences();

    console.log('\n✅ Migration complete!');
    console.log('\n📊 Next steps:');
    console.log('   1. Verify data: psql postgresql://bloomcart:bloomcart_local_2026@localhost:5432/bloomcart');
    console.log('   2. Run: SELECT COUNT(*) FROM users;');
    console.log('   3. Restart server: npm run dev');

  } catch (err) {
    console.error('\n❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    sqlite.close();
    await pool.end();
  }
}

migrate();
