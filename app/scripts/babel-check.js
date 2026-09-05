#!/usr/bin/env node
// app/scripts/babel-check.js
//
// Syntax/transform check for frontend files. This project has no test runner
// and no linter wired up; this is the closest thing to a compile step and is
// the established gate before committing any frontend change.
//
// Run from the `app/` directory:
//   node scripts/babel-check.js src/components/Foo.js src/screens/Bar.js
//
// NOTE: `npx babel --presets babel-preset-expo <file>` does NOT work here —
// the preset does not resolve through npx and every file reports a bogus
// SyntaxError. Go through the Node API, as below.
const babel = require('@babel/core');

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node scripts/babel-check.js <file...>');
  process.exit(2);
}

let failed = 0;
for (const file of files) {
  try {
    babel.transformFileSync(file, {
      presets: [require.resolve('babel-preset-expo')],
      babelrc: false,
      configFile: false,
    });
    console.log('OK   ' + file);
  } catch (err) {
    failed++;
    console.log('FAIL ' + file + ' :: ' + err.message.split('\n')[0]);
  }
}
process.exit(failed ? 1 : 0);
