#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const routesDir = path.join(__dirname, 'routes');

function fixFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf-8');
  const originalContent = content;

  // Fix 1: Remove double await keywords
  content = content.replace(/await\s+await\s+/g, 'await ');

  // Fix 2: Fix wrong async placement: (async (req, res, next) => { to async (req, res, next) => {
  content = content.replace(/\(\s*async\s+\(/g, 'async (');

  // Fix 3: Fix router calls with wrong async: router.get('/', authenticate, (async (req, res, next) =>
  // to: router.get('/', authenticate, async (req, res, next) =>
  content = content.replace(
    /router\.(get|post|put|delete|patch)\(([^)]*)\),\s*\(async\s*\(/g,
    'router.$1($2), async ('
  );

  // Fix 4: Add missing async keywords to route handlers that have db calls but no async
  // This is tricky, but we can identify them by checking if they use await db but don't have async
  
  // Find all route definitions and check if they need async
  const routePattern = /router\.(get|post|put|delete|patch)\(([^)]*)\),\s*([^{]*)\{/g;
  let match;
  
  while ((match = routePattern.exec(content)) !== null) {
    const fullMatch = match[0];
    const params = match[3];
    
    // If params don't have 'async' but the body has 'await'
    if (!params.includes('async') && params.includes('=>')) {
      // Check if the next section has await db calls
      const afterMatch = content.substring(match.index + fullMatch.length, match.index + fullMatch.length + 500);
      if (afterMatch.includes('await db') || afterMatch.includes('await ')) {
        // This needs async
        const newParams = params.replace('=>', '=> ').trim();
        if (!newParams.startsWith('async')) {
          const fixed = fullMatch.replace(params + '{', 'async ' + params + ' {');
          content = content.substring(0, match.index) + fixed + content.substring(match.index + fullMatch.length);
        }
      }
    }
  }

  if (content !== originalContent) {
    fs.writeFileSync(filePath, content, 'utf-8');
    console.log(`✅ Fixed: ${path.basename(filePath)}`);
    return true;
  } else {
    console.log(`⏭️  No changes: ${path.basename(filePath)}`);
    return false;
  }
}

// Get all .js files in routes directory
const files = fs.readdirSync(routesDir).filter(f => f.endsWith('.js'));

files.forEach(file => {
  const filePath = path.join(routesDir, file);
  try {
    fixFile(filePath);
  } catch (err) {
    console.error(`❌ Error fixing ${file}:`, err.message);
  }
});

console.log('\n✨ Fix complete!');
