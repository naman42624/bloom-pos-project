// Plain-node tests for src/utils/expenseBook.js. Run: node scripts/test-expense-book.js
const assert = require('assert');
const path = require('path');
const Module = require('module');
const babel = require('@babel/core');

function loadModule(file) {
  const { code } = babel.transformFileSync(file, { presets: ['babel-preset-expo'], babelrc: false, configFile: false });
  const m = new Module(file, module);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(code, file);
  return m.exports;
}

const e = loadModule(path.join(__dirname, '../src/utils/expenseBook.js'));
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('periodRange today', () => {
  assert.deepStrictEqual(e.periodRange('today', '2026-11-13'), { from: '2026-11-13', to: '2026-11-13' });
});
test('periodRange month', () => {
  assert.deepStrictEqual(e.periodRange('month', '2026-11-13'), { from: '2026-11-01', to: '2026-11-13' });
});
test('periodRange last_month', () => {
  assert.deepStrictEqual(e.periodRange('last_month', '2026-11-13'), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepStrictEqual(e.periodRange('last_month', '2026-01-05'), { from: '2025-12-01', to: '2025-12-31' });
  assert.deepStrictEqual(e.periodRange('last_month', '2026-03-10'), { from: '2026-02-01', to: '2026-02-28' });
});
test('periodRange week starts Monday', () => {
  assert.deepStrictEqual(e.periodRange('week', '2026-11-13'), { from: '2026-11-09', to: '2026-11-13' });
  assert.strictEqual(e.periodRange('week', '2026-11-16').from, '2026-11-16');
  assert.strictEqual(e.periodRange('week', '2026-11-15').from, '2026-11-09');
});
test('changeLabel', () => {
  assert.deepStrictEqual(e.changeLabel(null), { text: 'new', tone: 'new' });
  assert.strictEqual(e.changeLabel(undefined).text, 'new');
  assert.deepStrictEqual(e.changeLabel(12.4), { text: '▲ 12%', tone: 'up' });
  assert.deepStrictEqual(e.changeLabel(-4), { text: '▼ 4%', tone: 'down' });
  assert.deepStrictEqual(e.changeLabel(0), { text: '—', tone: 'flat' });
});
test('lastSevenDays', () => {
  const d = e.lastSevenDays('2026-11-13');
  assert.strictEqual(d.length, 7);
  assert.deepStrictEqual(d[0], { date: '2026-11-13', label: 'Today' });
  assert.deepStrictEqual(d[1], { date: '2026-11-12', label: 'Yesterday' });
  assert.deepStrictEqual(d[2], { date: '2026-11-11', label: 'Tue 11 Nov' });
  assert.deepStrictEqual(d[6], { date: '2026-11-07', label: 'Sat 7 Nov' });
});
test('givenToText', () => {
  assert.strictEqual(e.givenToText({ given_to_display: 'Raju' }), 'given to Raju');
  assert.strictEqual(e.givenToText({ given_to_display: '' }), null);
  assert.strictEqual(e.givenToText({}), null);
  assert.strictEqual(e.givenToText(null), null);
});

let failed = 0;
for (const t of tests) {
  try { t.fn(); console.log('ok   ' + t.name); } catch (err) { failed++; console.log('FAIL ' + t.name + ': ' + err.message); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
