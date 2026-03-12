#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const routesDir = path.join(__dirname, 'routes');
const files = [
  'materials.js', 'suppliers.js', 'customers.js', 'deliveries.js',
  'products.js', 'purchase-orders.js', 'stock.js', 'sales.js',
  'production.js', 'expenses.js', 'recurring-orders.js', 'attendance.js',
  'staff-management.js', 'delivery-tracking.js', 'reports.js', 'notifications.js'
];

function convertFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf-8');
  const originalContent = content;

  // Pattern 1: Convert route handlers without async to async
  // Examples: router.get('/', (req, res, next) => {
  content = content.replace(
    /router\.(get|post|put|delete|patch)\(['"]([\w\/-:]*)['"](,\s*\[)?/g,
    (match, method, path, hasValidation) => {
      // Don't replace if already has async
      if (content.includes(`router.${method}('${path}'`) && 
          content.split(`router.${method}('${path}'`)[1].split('\n')[0].includes('async')) {
        return match;
      }
      return match;
    }
  );

  // Pattern 2: Convert (req, res, next) => { to async (req, res, next) => {
  // But only if not already async
  content = content.replace(
    /([,\s]\(\s*req,\s*res,\s*next\s*\)\s*=>)/g,
    (match) => {
      // Check if already preceded by async
      const index = content.indexOf(match);
      const before = content.substring(Math.max(0, index - 10), index);
      if (before.includes('async')) {
        return match;
      }
      return match.replace(/(req,\s*res,\s*next\s*\)\s*=>)/, 'async (req, res, next) =>');
    }
  );

  // Pattern 3: Add await to db.prepare().get()
  content = content.replace(
    /(\s+)(const\s+\w+\s*=\s*)db\.prepare\(/g,
    '$1$2await db.prepare('
  );
  content = content.replace(
    /(\s+)(let\s+\w+\s*=\s*)db\.prepare\(/g,
    '$1$2await db.prepare('
  );

  // Pattern 4: Add await before standalone db.prepare calls  
  content = content.replace(
    /^\s*db\.prepare\(/gm,
    (match) => match.replace('db.prepare', 'await db.prepare')
  );

  // Pattern 5: Add await to .run() calls that aren't in transactions
  content = content.replace(
    /(\bdb\.prepare\([^)]*\)\.run\()/g,
    'await $1'
  );

  // Pattern 6: Add await to .all() calls
  content = content.replace(
    /(\bdb\.prepare\([^)]*\)\.all\()/g,
    'await $1'
  );

  // Pattern 7: Add await to .get() calls
  content = content.replace(
    /(\bdb\.prepare\([^)]*\)\.get\()/g,
    'await $1'
  );

  if (content !== originalContent) {
    fs.writeFileSync(filePath, content, 'utf-8');
    console.log(`✅ Converted: ${path.basename(filePath)}`);
    return true;
  } else {
    console.log(`⏭️  No changes: ${path.basename(filePath)}`);
    return false;
  }
}

// Convert files
files.forEach(file => {
  const filePath = path.join(routesDir, file);
  if (fs.existsSync(filePath)) {
    try {
      convertFile(filePath);
    } catch (err) {
      console.error(`❌ Error processing ${file}:`, err.message);
    }
  } else {
    console.log(`⚠️  File not found: ${file}`);
  }
});

console.log('\n✨ Conversion complete!');
