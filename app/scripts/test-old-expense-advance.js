// Plain-node tests for src/utils/oldExpenseAdvance.js. Run: node scripts/test-old-expense-advance.js
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
const o = loadModule(path.join(__dirname, '../src/utils/oldExpenseAdvance.js'));
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const TODAY = '2026-11-19';
const row = (over = {}) => ({
  id: 1, category: 'food', payment_method: 'cash', is_return: 0,
  money_out_id: null, km_settlement_id: null, expense_date: '2026-11-10', ...over,
});

test('plain cash row is ok', () => assert.strictEqual(o.canMarkSalaryAdvance(row(), TODAY), true));
test('plain upi row is ok', () => assert.strictEqual(o.canMarkSalaryAdvance(row({ payment_method: 'upi' }), TODAY), true));
test('salary row: hidden', () => assert.strictEqual(o.canMarkSalaryAdvance(row({ category: 'salary' }), TODAY), false));
test('own pocket: hidden', () => assert.strictEqual(o.canMarkSalaryAdvance(row({ payment_method: 'own_pocket' }), TODAY), false));
test('shopping money and card: hidden', () => {
  assert.strictEqual(o.canMarkSalaryAdvance(row({ payment_method: 'shopping_money' }), TODAY), false);
  assert.strictEqual(o.canMarkSalaryAdvance(row({ payment_method: 'card' }), TODAY), false);
});
test('return: hidden (1 or true)', () => {
  assert.strictEqual(o.canMarkSalaryAdvance(row({ is_return: 1 }), TODAY), false);
  assert.strictEqual(o.canMarkSalaryAdvance(row({ is_return: true }), TODAY), false);
  assert.strictEqual(o.canMarkSalaryAdvance(row({ is_return: false }), TODAY), true);
});
test('money_out_id: hidden', () => assert.strictEqual(o.canMarkSalaryAdvance(row({ money_out_id: 7 }), TODAY), false));
test('km_settlement_id: hidden', () => assert.strictEqual(o.canMarkSalaryAdvance(row({ km_settlement_id: 3 }), TODAY), false));
test('60 days old: ok; 61 days old: hidden', () => {
  // 2026-11-19 minus 60 days = 2026-09-20.
  assert.strictEqual(o.daysBetween('2026-09-20', TODAY), 60);
  assert.strictEqual(o.canMarkSalaryAdvance(row({ expense_date: '2026-09-20' }), TODAY), true);
  assert.strictEqual(o.canMarkSalaryAdvance(row({ expense_date: '2026-09-19' }), TODAY), false);
});
test('today ok; future or missing date hidden', () => {
  assert.strictEqual(o.canMarkSalaryAdvance(row({ expense_date: TODAY }), TODAY), true);
  assert.strictEqual(o.canMarkSalaryAdvance(row({ expense_date: '2026-11-20' }), TODAY), false);
  assert.strictEqual(o.canMarkSalaryAdvance(row({ expense_date: null }), TODAY), false);
  assert.strictEqual(o.canMarkSalaryAdvance(null, TODAY), false);
});
test('days across a month and DST-free', () => {
  assert.strictEqual(o.daysBetween('2026-02-28', '2026-03-01'), 1);
  assert.strictEqual(o.daysBetween('2026-03-28', '2026-03-30'), 2);
});
test('copy: sheet line, warning, success', () => {
  assert.strictEqual(o.sheetLine(1500, '2026-11-02'), '₹1,500 on 2 Nov becomes a salary advance. It will be taken off their next salary.');
  assert.strictEqual(o.paidAfterWarning('Ramesh', []), null);
  assert.strictEqual(
    o.paidAfterWarning('Ramesh', [{ id: 9, paid_on: '2026-11-07', net_amount: 9000 }, { id: 4, paid_on: '2026-11-03', net_amount: 1 }]),
    "Ramesh was already paid salary on 7 Nov. If you already took this off that pay, don't mark it."
  );
  assert.deepStrictEqual(o.successAlert(250, 'Asha'), { title: 'Marked as salary advance', message: "₹250 will be taken off Asha's next salary." });
});
test('payrollPeople: active payroll roles, sorted by name', () => {
  const list = o.payrollPeople([
    { id: 1, name: 'zara', role: 'counter_staff', is_active: 1 },
    { id: 2, name: 'Owner', role: 'owner', is_active: 1 },
    { id: 3, name: 'Asha', role: 'delivery_partner', is_active: true },
    { id: 4, name: 'Gone', role: 'employee', is_active: 0 },
    { id: 5, name: 'Cust', role: 'customer', is_active: 1 },
    { id: 6, name: 'Mohan', role: 'manager', is_active: 1 },
    { id: 7, name: 'Helper', role: 'helper', is_active: 1 },
  ]);
  assert.deepStrictEqual(list.map((u) => u.id), [3, 6, 1]);
});

let failed = 0;
for (const t of tests) {
  try { t.fn(); console.log(`  ok  ${t.name}`); } catch (e) { failed += 1; console.log(`  FAIL ${t.name}\n       ${e.message}`); }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
