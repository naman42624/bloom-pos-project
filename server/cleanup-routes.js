#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const routesDir = path.join(__dirname, 'routes');

function cleanupFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf-8');
  const originalContent = content;

  // Fix 1: Make helper functions async if they use await
  content = content.replace(
    /^(function\s+(\w+)\s*\([^)]*\)\s*\{)/gm,
    (match, fullMatch, funcName) => {
      // Check if this function body contains 'await'
      const funcStart = content.indexOf(match);
      let braceCount = 0;
      let funcEnd = funcStart;
      let inFunc = false;
      
      for (let i = funcStart + fullMatch.length; i < content.length; i++) {
        if (content[i] === '{') braceCount++;
        else if (content[i] === '}') {
          if (braceCount === 0) {
            funcEnd = i;
            break;
          }
          braceCount--;
        }
      }
      
      const funcBody = content.substring(funcStart, funcEnd);
      if (funcBody.includes('await ')) {
        return match.replace('function ', 'async function ');
      }
      return match;
    }
  );

  // Fix 2: Remove await inside db.transaction callbacks
  // This is tricky because we need to identify the transaction block and remove awaits from within it
  content = content.replace(
    /db\.transaction\s*\(\s*\(\)\s*=>\s*\{/g,
    (match) => {
      // Mark transaction start - we'll handle this differently
      return match;
    }
  );

  // More targeted fix: Remove "await db" that appears inside transaction blocks
  // This regex finds patterns like: db.transaction(() => { ... await db.prepare ... })
  const transactionRegex = /db\.transaction\s*\(\s*\(\)\s*=>\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}\s*\)/g;
  
  content = content.replace(transactionRegex, (match) => {
    // Remove awaits inside this transaction
    const cleaned = match.replace(/await\s+(db\.prepare)/g, '$1');
    return cleaned;
  });

  // Fix 3: Also handle arrow functions used as transactions
  content = content.replace(
    /db\.transaction\s*\(\s*\(\)\s*=>\s*\{/g,
    'db.transaction(() => {'
  );

  if (content !== originalContent) {
    fs.writeFileSync(filePath, content, 'utf-8');
    console.log(`✅ Cleaned: ${path.basename(filePath)}`);
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
    cleanupFile(filePath);
  } catch (err) {
    console.error(`❌ Error cleaning ${file}:`, err.message);
  }
});

console.log('\n✨ Cleanup complete!');
