// Plain-node tests for the Usual now helpers in src/utils/expenseBook.js.
// Run: node scripts/test-usual-now.js
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

const tota = { user_id: 7, name: null, display_name: 'Tota Ram', present_today: true };
const tea = { id: 1, name: 'Tea', category: 'food', usual_amount: 60, common_amount: 50, my_last_method: 'cash', last_given_to: tota };

// ── pickDefaults ──
test('pickDefaults: amount is the most common amount', () => {
  assert.strictEqual(e.pickDefaults(tea, { userId: 3 }).amount, 50);
});
test('pickDefaults: falls back to usual_amount when there is no common amount', () => {
  assert.strictEqual(e.pickDefaults({ ...tea, common_amount: null }, { userId: 3 }).amount, 60);
  assert.strictEqual(e.pickDefaults({ ...tea, common_amount: undefined, usual_amount: null }, {}).amount, null);
  assert.strictEqual(e.pickDefaults({ ...tea, common_amount: 0, usual_amount: 0 }, {}).amount, null);
});
test('pickDefaults: person here today is pre-filled (without present_today)', () => {
  assert.deepStrictEqual(e.pickDefaults(tea, { userId: 3 }).givenTo, { user_id: 7, name: null, display_name: 'Tota Ram' });
});
test('pickDefaults: absent person is not pre-filled', () => {
  const away = { ...tea, last_given_to: { ...tota, present_today: false } };
  assert.strictEqual(e.pickDefaults(away, { userId: 3 }).givenTo, null);
  const unknown = { ...tea, last_given_to: { user_id: 7, name: null, display_name: 'Tota Ram' } };
  assert.strictEqual(e.pickDefaults(unknown, { userId: 3 }).givenTo, null);
});
test('pickDefaults: no last person -> null', () => {
  assert.strictEqual(e.pickDefaults({ ...tea, last_given_to: null }, {}).givenTo, null);
});
test('pickDefaults: own method beats another user\'s', () => {
  // The server sends only the caller's own last method; anything else on the
  // item (another person's method) is never used.
  const item = { ...tea, my_last_method: 'upi', last_method: 'cash', payment_method: 'cash' };
  assert.strictEqual(e.pickDefaults(item, { userId: 3 }).method, 'upi');
  const othersOnly = { ...tea, my_last_method: null, last_method: 'upi', payment_method: 'upi' };
  assert.strictEqual(e.pickDefaults(othersOnly, { userId: 3 }).method, 'cash');
});
test('pickDefaults: no method -> cash; odd method -> cash', () => {
  assert.strictEqual(e.pickDefaults({ ...tea, my_last_method: null }, {}).method, 'cash');
  assert.strictEqual(e.pickDefaults({ ...tea, my_last_method: undefined }, {}).method, 'cash');
  assert.strictEqual(e.pickDefaults({ ...tea, my_last_method: 'card' }, {}).method, 'cash');
});
test('pickDefaults: survives a missing item', () => {
  assert.deepStrictEqual(e.pickDefaults(null, {}), { amount: null, method: null, givenTo: null });
});
test('pickDefaults: a type-ahead row (no my_last_method field) knows no method', () => {
  const typedRow = { id: 1, name: 'Tea', category: 'food', usual_amount: 60, last_given_to: null };
  assert.strictEqual(e.pickDefaults(typedRow, {}).method, null);
});

// ── methodAfterPick ──
test('methodAfterPick: a typed pick keeps the current UPI', () => {
  const typedRow = { id: 2, name: 'Petrol', category: 'transport', usual_amount: 200, last_given_to: null };
  assert.strictEqual(e.methodAfterPick('upi', typedRow), 'upi');
  assert.strictEqual(e.methodAfterPick('cash', typedRow), 'cash');
});
test('methodAfterPick: a section row with my_last_method upi sets UPI', () => {
  assert.strictEqual(e.methodAfterPick('cash', { ...tea, my_last_method: 'upi' }), 'upi');
});
test('methodAfterPick: a section row with my_last_method null sets Cash', () => {
  assert.strictEqual(e.methodAfterPick('upi', { ...tea, my_last_method: null }), 'cash');
});

// ── suggestionSections ──
test('suggestionSections: Usual now then Often, Often minus Usual now', () => {
  const res = { data: [tea], usual_now: [tea], often: [tea, { ...tea, id: 2, name: 'Milk' }] };
  const s = e.suggestionSections(res, { hideSalary: false });
  assert.deepStrictEqual(s.usualNow.map((r) => r.id), [1]);
  assert.deepStrictEqual(s.often.map((r) => r.id), [2]);
});
test('suggestionSections: older server (only data) shows data as Often', () => {
  const s = e.suggestionSections({ data: [tea] }, {});
  assert.deepStrictEqual(s.usualNow, []);
  assert.deepStrictEqual(s.often.map((r) => r.id), [1]);
});
test('suggestionSections: salary items hidden for counter staff', () => {
  const pay = { ...tea, id: 9, name: 'Pay', category: 'salary' };
  const s = e.suggestionSections({ usual_now: [pay], often: [tea, pay] }, { hideSalary: true });
  assert.deepStrictEqual(s.usualNow, []);
  assert.deepStrictEqual(s.often.map((r) => r.id), [1]);
  const boss = e.suggestionSections({ usual_now: [pay], often: [tea] }, { hideSalary: false });
  assert.deepStrictEqual(boss.usualNow.map((r) => r.id), [9]);
});
test('suggestionSections: empty / bad input', () => {
  assert.deepStrictEqual(e.suggestionSections(null, {}), { usualNow: [], often: [] });
});

// ── suggestionLine ──
test('suggestionLine: method and person, as it will be filled', () => {
  assert.strictEqual(e.suggestionLine(tea), 'Cash · Tota Ram');
  assert.strictEqual(e.suggestionLine({ ...tea, my_last_method: 'upi', last_given_to: null }), 'UPI');
  assert.strictEqual(e.suggestionLine({ ...tea, last_given_to: { ...tota, present_today: false } }), 'Cash');
});

// ── recentPeopleChips ──
const people = [
  { id: 1, name: 'Asha', role: 'counter_staff' },
  { id: 7, name: 'Tota Ram', role: 'employee' },
  { id: 9, name: 'Ramesh', role: 'delivery_partner' },
  { id: 4, name: 'Owner', role: 'owner' },
];
test('recentPeopleChips: recent people first, then the people list, 3 max', () => {
  const items = [tea, { ...tea, id: 2, last_given_to: { user_id: 9, name: null, display_name: 'Ramesh', present_today: false } }, tea];
  const chips = e.recentPeopleChips(items, people, null);
  assert.deepStrictEqual(chips.map((c) => c.display_name), ['Tota Ram', 'Ramesh', 'Asha']);
  assert.ok(chips.every((c) => !('present_today' in c)));
});
test('recentPeopleChips: typed names count as people; duplicates by name dropped', () => {
  const items = [{ ...tea, last_given_to: { user_id: null, name: 'Milkman', display_name: 'Milkman' } },
    { ...tea, last_given_to: { user_id: null, name: 'milkman ', display_name: 'milkman ' } }];
  const chips = e.recentPeopleChips(items, people, null);
  assert.deepStrictEqual(chips.map((c) => c.display_name), ['Milkman', 'Asha', 'Tota Ram']);
  assert.strictEqual(chips[0].user_id, null);
});
test('recentPeopleChips: the chosen person is always one of the chips', () => {
  const chosen = { user_id: 4, name: 'Owner', display_name: 'Owner' };
  const chips = e.recentPeopleChips([], people, chosen);
  assert.strictEqual(chips.length, 3);
  assert.strictEqual(chips[0].user_id, 4);
  assert.deepStrictEqual(chips.map((c) => c.display_name), ['Owner', 'Asha', 'Tota Ram']);
  // Already among the three: order stays as it was.
  const same = e.recentPeopleChips([], people, { user_id: 7, name: null, display_name: 'Tota Ram' });
  assert.deepStrictEqual(same.map((c) => c.display_name), ['Asha', 'Tota Ram', 'Ramesh']);
});
test('recentPeopleChips: nothing known -> empty', () => {
  assert.deepStrictEqual(e.recentPeopleChips(null, null, null), []);
});

let passed = 0;
for (const t of tests) {
  try { t.fn(); passed++; console.log(`  ok   ${t.name}`); } catch (err) { console.log(`  FAIL ${t.name}\n       ${err.message}`); }
}
console.log(`\n${passed}/${tests.length} passed`);
if (passed !== tests.length) process.exit(1);
