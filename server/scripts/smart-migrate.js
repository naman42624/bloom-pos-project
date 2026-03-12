/**
 * Smart SQLite to PostgreSQL Migration
 * Dynamically reads SQLite schema and creates PostgreSQL tables
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
 * Convert SQLite type to PostgreSQL type
 */
function convertType(sqliteType) {
  if (!sqliteType) return 'TEXT';
  const type = sqliteType.toUpperCase();
  
  if (type.includes('INT')) return 'INTEGER';
  if (type.includes('REAL') || type.includes('FLOAT')) return 'DECIMAL(10,2)';
  if (type.includes('BOOL')) return 'BOOLEAN';
  if (type.includes('DATE')) return 'DATE';
  if (type.includes('TIME') && !type.includes('DATETIME')) return 'TIME';
  if (type.includes('DATETIME')) return 'TIMESTAMP';
  if (type.includes('TEXT') || type.includes('VARCHAR')) return 'TEXT';
  return 'TEXT';
}

/**
 * Get SQLite table schema
 */
function getSqLiteTableSchema(tableName) {
  const pragma = sqlite.prepare(`PRAGMA table_info(${tableName})`).all();
  return pragma;
}

/**
 * Create PostgreSQL table from SQLite schema
 */
async function createTableInPostgres(tableName, columns) {
  const colDefs = columns.map(col => {
    let def = `"${col.name}" ${convertType(col.type)}`;
    if (col.notnull) def += ' NOT NULL';
    if (col.pk) def += ' PRIMARY KEY';
    else if (col.dflt_value !== null) def += ` DEFAULT ${col.dflt_value}`;
    return def;
  }).join(',\n  ');

  const createSQL = `CREATE TABLE IF NOT EXISTS ${tableName} (\n  ${colDefs}\n);`;
  
  try {
    // Remove primary key if not autoincrement for SERIAL conversion
    const pkCol = columns.find(c => c.pk);
    let finalSQL = createSQL;
    
    if (pkCol) {
      // Replace INTEGER PRIMARY KEY with SERIAL PRIMARY KEY
      finalSQL = finalSQL.replace(
        `"${pkCol.name}" INTEGER PRIMARY KEY`,
        `"${pkCol.name}" SERIAL PRIMARY KEY`
      );
    }
    
    await pool.query(finalSQL);
    return true;
  } catch (err) {
    console.warn(`   ⚠ Failed to create table ${tableName}:`, err.message.split('\n')[0]);
    return false;
  }
}

/**
 * Migrate data from SQLite to PostgreSQL
 */
async function migrateTableData(tableName) {
  console.log(`📋 Migrating ${tableName}...`);
  
  try {
    // Get rows from SQLite
    const rows = sqlite.prepare(`SELECT * FROM ${tableName}`).all();
    
    if (rows.length === 0) {
      console.log(`   ✓ ${tableName}: 0 rows`);
      return;
    }

    // Get column names
    const columnNames = Object.keys(rows[0]);
    
    // Check which columns exist in PostgreSQL
    const pgCols = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
      [tableName]
    );
    const pgColumnNames = pgCols.rows.map(r => r.column_name);
    
    // Filter to only columns that exist in PostgreSQL
    const validCols = columnNames.filter(c => pgColumnNames.includes(c));
    
    if (validCols.length === 0) {
      console.log(`   ⚠ No matching columns found`);
      return;
    }

    const placeholders = validCols.map((_, i) => `$${i + 1}`).join(',');
    const columnList = validCols.map(c => `"${c}"`).join(',');
    const query = `INSERT INTO ${tableName} (${columnList}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;

    // Insert rows
    let inserted = 0;
    for (const row of rows) {
      const values = validCols.map(col => {
        const val = row[col];
        // Handle JSON serialization for text columns that might be JSON
        if (typeof val === 'object' && val !== null) {
          return JSON.stringify(val);
        }
        return val;
      });
      
      try {
        await pool.query(query, values);
        inserted++;
      } catch (err) {
        // Silently skip rows with FK violations
        if (!err.message.includes('foreign key')) {
          console.warn(`   ⚠ Row insert failed:`, err.message.split('\n')[0]);
        }
      }
    }

    console.log(`   ✓ ${tableName}: ${inserted}/${rows.length} rows`);
  } catch (err) {
    console.error(`   ✗ ${tableName} failed:`, err.message);
  }
}

/**
 * Reset sequences
 */
async function resetSequences() {
  console.log('\n🔄 Resetting sequences...');
  
  try {
    const result = await pool.query(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' 
      AND column_default LIKE 'nextval%'
    `);

    for (const row of result.rows) {
      const tableResult = await pool.query(
        `SELECT MAX("${row.column_name}") as max_id FROM "${row.table_name}"`
      );
      const maxId = tableResult.rows[0].max_id || 0;
      const sequenceName = `${row.table_name}_${row.column_name}_seq`;
      
      try {
        await pool.query(`SELECT setval('${sequenceName}', ${maxId + 1})`);
      } catch (e) {
        // Ignore sequence errors
      }
    }
    console.log('   ✓ Sequences reset');
  } catch (err) {
    console.warn('   ⚠ Sequence reset partially failed:', err.message);
  }
}

/**
 * Main migration
 */
async function migrate() {
  console.log('🚀 Starting Smart SQLite → PostgreSQL Migration\n');
  
  try {
    // Get all tables
    const tables = sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite%' ORDER BY name"
    ).all();

    console.log(`Found ${tables.length} tables in SQLite\n`);

    // Create tables
    console.log('📐 Creating tables...\n');
    for (const table of tables) {
      const schema = getSqLiteTableSchema(table.name);
      const created = await createTableInPostgres(table.name, schema);
      if (created) console.log(`   ✓ Created ${table.name}`);
    }

    // Migrate data (do users/locations first for FK integrity)
    console.log('\n📊 Migrating data...\n');
    const priorityTables = ['users', 'locations', 'user_locations', 'settings'];
    const otherTables = tables.filter(t => !priorityTables.includes(t.name));
    
    for (const name of priorityTables) {
      if (tables.find(t => t.name === name)) {
        await migrateTableData(name);
      }
    }
    
    for (const table of otherTables) {
      await migrateTableData(table.name);
    }

    // Reset sequences
    await resetSequences();

    console.log('\n✅ Migration complete!');
    console.log('\n📊 Next steps:');
    console.log('   1. Verify: psql $DATABASE_URL -c "SELECT COUNT(*) FROM users;"');
    console.log('   2. Restart server: npm run dev');
  } catch (err) {
    console.error('\n❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    sqlite.close();
    await pool.end();
  }
}

migrate();
