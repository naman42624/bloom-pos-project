// Plain-node tests for src/utils/helperCash.js. Run: node scripts/test-helper-cash.js
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

const c = loadModule(path.join(__dirname, '../src/utils/helperCash.js'));
const b = loadModule(path.join(__dirname, '../src/utils/helperBasket.js'));
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('short wording', () => {
  const r = c.handoverResult(3200, 3150);
  assert.strictEqual(r.kind, 'short');
  assert.strictEqual(r.line, 'Expected ₹3,200 · Counted ₹3,150 · Short ₹50');
  assert.strictEqual(r.canPartial, true);
  assert.strictEqual(r.remainingIfPartial, 50);
});
test('over wording, partial not offered', () => {
  const r = c.handoverResult(1000, 1010.5);
  assert.strictEqual(r.line, 'Expected ₹1,000 · Counted ₹1,010.5 · Over ₹10.5');
  assert.strictEqual(r.canPartial, false);
});
test('exactly right: no "part of it" (A3)', () => {
  const r = c.handoverResult(845, '845.00');
  assert.strictEqual(r.label, 'Exactly right');
  assert.strictEqual(r.kind, 'exact');
  assert.strictEqual(r.canPartial, false);
  assert.strictEqual(r.remainingIfPartial, 0);
});
test('float noise does not leak', () => {
  const r = c.handoverResult(0.1 + 0.2, 0.3);
  assert.strictEqual(r.kind, 'exact');
});
test('parseMoney rounds to paise and refuses junk', () => {
  assert.strictEqual(c.parseMoney('500'), 500);
  assert.strictEqual(c.parseMoney('500.5'), 500.5);
  assert.strictEqual(c.parseMoney('500.'), 500);
  assert.strictEqual(c.parseMoney(''), null);
  assert.strictEqual(c.parseMoney('-5'), null);
  assert.strictEqual(c.parseMoney('1.234'), null);
  assert.strictEqual(c.parseMoney('123456789'), null);
  assert.strictEqual(c.parseMoney('abc'), null);
});
test('cleanMoneyInput keeps one dot and 2 decimals', () => {
  assert.strictEqual(c.cleanMoneyInput('1,2a3.4.56'), '123.45');
  assert.strictEqual(c.cleanMoneyInput('₹500'), '500');
});
test('floatDefault: last float, else 500', () => {
  assert.strictEqual(c.floatDefault(null), '500');
  assert.strictEqual(c.floatDefault({ amount: 300, created_at: 'x' }), '300');
  assert.strictEqual(c.floatDefault(250.5), '250.5');
  assert.strictEqual(c.floatDefault(0), '500');
});
test('close warning copy, only bags with cash', () => {
  const lines = c.closeWarningLines([
    { staff_id: 1, name: 'Priya', held_masked: '₹1,8xx', has_cash: true },
    { staff_id: 2, name: 'Raju', held_masked: '₹x', has_cash: false },
  ]);
  assert.deepStrictEqual(lines.map((l) => l.text), ['₹1,8xx is still with Priya. Collect it first?']);
});
test('app maskAmount agrees with the server examples', () => {
  const ex = { 5234: '₹5,xxx', 845: '₹8xx', 45: '₹xx', 123456: '₹1,xx,xxx', 0: '₹x' };
  for (const [n, want] of Object.entries(ex)) assert.strictEqual(b.maskAmount(Number(n)), want, n);
});

test('done text after a handover', () => {
  assert.strictEqual(c.handoverDoneText({ name: 'Raju', is_final: true, expected: 1200, counted: 1190, difference: -10 }),
    'Took ₹1,190 from Raju. Expected ₹1,200 · Short ₹10, recorded against Raju.');
  assert.strictEqual(c.handoverDoneText({ name: 'Raju', is_final: false, expected: 1200, counted: 500, difference: 0, remaining: 700 }),
    'Took ₹500 from Raju. ₹700 stays with Raju.');
  assert.strictEqual(c.handoverDoneText({ name: 'Raju', is_final: true, expected: 700, counted: 700, difference: 0 }),
    "Took ₹700 from Raju. Exactly right. Raju's cash is settled.");
});

let failed = 0;
for (const t of tests) {
  try { t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed += 1; console.log(`  FAIL ${t.name}\n       ${err.message}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
