// Plain-node tests for src/utils/staffMoney.js. Run: node scripts/test-staff-money.js
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
const s = loadModule(path.join(__dirname, '../src/utils/staffMoney.js'));
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const limits = { advanceDay: 500, advanceMonth: 2000, shoppingDay: 1000 };

test('defaultChange: 500 left, bills 300 -> 200', () => {
  assert.strictEqual(s.defaultChange(500, [{ amount: 300 }]), 200);
  assert.strictEqual(s.defaultChange(500, []), 500);
  assert.strictEqual(s.defaultChange(500, undefined), 500);
});
test('defaultChange: never below 0 when overspent', () => {
  assert.strictEqual(s.defaultChange(500, [{ amount: 620 }]), 0);
});
test('overspend: 500 left, bills 620 -> 120; none when within', () => {
  assert.strictEqual(s.overspend(500, [{ amount: 620 }]), 120);
  assert.strictEqual(s.overspend(500, [{ amount: 300 }]), 0);
  assert.strictEqual(s.overspend(500, [{ amount: 500 }]), 0);
});
test('paise maths: no float drift', () => {
  assert.strictEqual(s.defaultChange(0.3, [{ amount: 0.1 }, { amount: 0.1 }]), 0.1);
  assert.strictEqual(s.overspend(0.3, [{ amount: 0.1 }, { amount: 0.1 }, { amount: 0.2 }]), 0.1);
  assert.strictEqual(s.stillWith(100.1, [{ amount: 50.05 }], 50.05), 0);
});
test('stillWith: left - bills - change, never below 0', () => {
  assert.strictEqual(s.stillWith(500, [{ amount: 300 }], 200), 0);
  assert.strictEqual(s.stillWith(500, [{ amount: 300 }], 0), 200);
  assert.strictEqual(s.stillWith(500, [], 0), 500);
  assert.strictEqual(s.stillWith(500, [{ amount: 620 }], 0), 0);
  assert.strictEqual(s.stillWith(500, [{ amount: 300 }], 250), 0);
});
test('bad amounts count as 0', () => {
  assert.strictEqual(s.defaultChange(500, [{ amount: 'x' }, { amount: null }, {}]), 500);
});
test('heldLabel: today, 1 day, N days', () => {
  const now = new Date(2026, 10, 15, 10, 0, 0);
  assert.strictEqual(s.heldLabel(new Date(2026, 10, 15, 8, 0), now).text, 'Today');
  assert.strictEqual(s.heldLabel(new Date(2026, 10, 14, 23, 0), now).text, '1 day');
  assert.strictEqual(s.heldLabel(new Date(2026, 10, 11, 9, 0), now).text, '4 days');
  assert.strictEqual(s.heldLabel(new Date(2026, 10, 11, 9, 0), now).days, 4);
});
test('heldLabel: late is strictly more than late days (default 3, like the server)', () => {
  const now = new Date(2026, 10, 15, 10, 0, 0);
  assert.strictEqual(s.heldLabel(new Date(2026, 10, 12, 9, 0), now).late, false, '3 days is not late');
  assert.strictEqual(s.heldLabel(new Date(2026, 10, 11, 9, 0), now).late, true, '4 days is late');
  assert.strictEqual(s.heldLabel(new Date(2026, 10, 12, 9, 0), now, 2).late, true, 'setting respected');
  assert.strictEqual(s.heldLabel(new Date(2026, 10, 13, 9, 0), now, 2).late, false);
});
test('heldLabel: bad or future dates do not crash', () => {
  const now = new Date(2026, 10, 15);
  assert.deepStrictEqual(s.heldLabel('nonsense', now), { days: 0, text: 'Today', late: false });
  assert.strictEqual(s.heldLabel(new Date(2026, 10, 20), now).days, 0);
});
test('pinMessage: day limit (advance and shopping money)', () => {
  assert.strictEqual(s.pinMessage('over_day', { limits, name: 'Ramesh' }),
    "That's more than the ₹500 daily advance limit. A manager or owner can confirm with their PIN.");
  assert.strictEqual(s.pinMessage('over_day', { limits, name: 'Ramesh', kind: 'shopping' }),
    "That's more than the ₹1,000 daily shopping money limit. A manager or owner can confirm with their PIN.");
});
test('pinMessage: month limit names the person', () => {
  const m = s.pinMessage('over_month', { limits, name: 'Ramesh' });
  assert.strictEqual(m, 'Ramesh has had ₹2,000 in advances this month — the monthly limit. A manager or owner can confirm with their PIN.');
  assert.ok(m.includes('Ramesh'));
});
test('pinMessage: self', () => {
  assert.strictEqual(s.pinMessage('self', { limits, name: 'Ramesh' }), 'A manager or owner needs to confirm money for yourself.');
});
test('needsPinOf reads the 409 body', () => {
  assert.strictEqual(s.needsPinOf({ status: 409, body: { needs_pin: 'over_month' } }), 'over_month');
  assert.strictEqual(s.needsPinOf({ status: 409, body: { message: 'Already done' } }), null);
  assert.strictEqual(s.needsPinOf({ status: 400, body: { needs_pin: 'self' } }), null);
  assert.strictEqual(s.needsPinOf(null), null);
});

let failed = 0;
for (const t of tests) {
  try { t.fn(); console.log('  ok   ' + t.name); } catch (err) { failed++; console.log('  FAIL ' + t.name + '\n       ' + err.message); }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
