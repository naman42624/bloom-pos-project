// Plain-node tests for src/utils/lastClose.js (A9 / D42). Run: node scripts/test-last-close.js
const assert = require('assert');
const path = require('path');
const Module = require('module');
const babel = require('@babel/core');

const PRESET = require.resolve('babel-preset-expo', { paths: [path.join(__dirname, '..')] });
function loadModule(file) {
  const { code } = babel.transformFileSync(file, { presets: [PRESET], babelrc: false, configFile: false });
  const m = new Module(file, module);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(code, file);
  return m.exports;
}
const f = loadModule(path.join(__dirname, '../src/utils/lastClose.js'));
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// 7 Nov 2026, 10:00 in India
const NOW = new Date('2026-11-07T04:30:00Z');

test('last close on another day is used', () => {
  const last = f.lastCloseFromStatus({ last_close: { actual_cash: 2000, closed_at: '2026-11-04 15:00:00' }, todaySessions: [] });
  assert.deepStrictEqual(last, { amount: 2000, closedAt: '2026-11-04 15:00:00' });
  assert.strictEqual(f.lastCloseCashText(last), '2000');
});
test('paise kept, .00 dropped', () => {
  assert.strictEqual(f.lastCloseCashText({ amount: 1250.5 }), '1250.50');
  assert.strictEqual(f.lastCloseCashText({ amount: 0 }), '0');
});
test('no close ever: blank', () => {
  assert.strictEqual(f.lastCloseFromStatus({ last_close: null, todaySessions: [] }), null);
  assert.strictEqual(f.lastCloseCashText(null), '');
  assert.strictEqual(f.lastCloseHint(null), '');
  assert.strictEqual(f.lastCloseFromStatus(null), null);
});
test('older server: falls back to today\'s closed session', () => {
  const last = f.lastCloseFromStatus({ todaySessions: [{ closed_at: null }, { closed_at: '2026-11-07 03:00:00', actual_cash: '500.00' }] });
  assert.deepStrictEqual(last, { amount: 500, closedAt: '2026-11-07 03:00:00' });
});
test('today / yesterday / date words in shop time', () => {
  assert.strictEqual(f.closeDayWords('2026-11-07 01:00:00', NOW), 'today'); // 6:30 AM IST
  assert.strictEqual(f.closeDayWords('2026-11-06 20:00:00', NOW), 'today'); // 1:30 AM IST on the 7th
  assert.strictEqual(f.closeDayWords('2026-11-06 15:00:00', NOW), 'yesterday');
  assert.strictEqual(f.closeDayWords('2026-11-04 15:00:00', NOW), 'on 4 Nov');
  assert.strictEqual(f.closeDayWords(null, NOW), '');
});
test('hint text', () => {
  assert.strictEqual(
    f.lastCloseHint({ amount: 2000, closedAt: '2026-11-06 15:00:00' }, NOW),
    'Filled in from the last close yesterday (₹2000). Change it if the drawer has a different amount.',
  );
});

let passed = 0;
for (const t of tests) {
  try { t.fn(); passed += 1; } catch (e) { console.log(`FAIL ${t.name}: ${e.message}`); }
}
console.log(`${passed}/${tests.length} passed`);
if (passed !== tests.length) process.exit(1);
