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

// ── undoReducer (components/expenses/usualNowUndo.js) ──
const u = loadModule(path.join(__dirname, '../src/components/expenses/usualNowUndo.js'));
const teaExpense = { id: 41, amount: 50 };
const added = (state, now = 1000) => u.undoReducer(u.undoReducer(state, { type: 'add_start' }),
  { type: 'add_done', expense: teaExpense, text: 'Added Tea ₹50 · Cash', now });
test('undoReducer: add -> bar showing for 15 s', () => {
  assert.strictEqual(u.UNDO_MS, 15000);
  const s = added(u.initialUndoState, 1000);
  assert.strictEqual(s.saving, false);
  assert.strictEqual(s.bar.text, 'Added Tea ₹50 · Cash');
  assert.strictEqual(s.bar.expense.id, 41);
  assert.strictEqual(s.bar.expiresAt, 16000);
  assert.ok(u.undoReducer(s, { type: 'expire', now: 15999 }).bar, 'still there just before 15 s');
  assert.strictEqual(u.undoReducer(s, { type: 'expire', now: 16000 }).bar, null);
});
test('undoReducer: undo success -> bar gone', () => {
  const s = u.undoReducer(added(u.initialUndoState), { type: 'undo_start' });
  assert.strictEqual(s.bar.undoing, true);
  // The bar does not expire while the undo is on its way.
  assert.ok(u.undoReducer(s, { type: 'expire', now: 99999 }).bar);
  const done = u.undoReducer(s, { type: 'undo_done' });
  assert.strictEqual(done.bar, null);
  assert.strictEqual(done.message, null);
});
test('undoReducer: undo refused (register closed since) -> server message, entry kept', () => {
  const s = u.undoReducer(added(u.initialUndoState), { type: 'undo_start' });
  const refused = u.undoReducer(s, { type: 'undo_failed', message: 'This register is closed. Ask the owner to change it.' });
  assert.strictEqual(refused.message, 'This register is closed. Ask the owner to change it.');
  assert.strictEqual(refused.bar, null, 'the bar closes; the entry itself stays in the list');
  assert.strictEqual(u.undoReducer(refused, { type: 'message_shown' }).message, null);
  const noMsg = u.undoReducer(s, { type: 'undo_failed' });
  assert.ok(noMsg.message && noMsg.message.length > 0, 'a plain fallback message');
});
test('undoReducer: second add tap while saving is ignored', () => {
  const s1 = u.undoReducer(u.initialUndoState, { type: 'add_start' });
  assert.strictEqual(s1.saving, true);
  assert.strictEqual(u.undoReducer(s1, { type: 'add_start' }), s1);
  assert.strictEqual(u.undoReducer(u.undoReducer(s1, { type: 'add_failed' }), { type: 'add_start' }).saving, true);
});
test('undoReducer: a new add replaces the bar; undo twice is ignored', () => {
  const first = added(u.initialUndoState, 1000);
  const second = u.undoReducer(u.undoReducer(first, { type: 'add_start' }),
    { type: 'add_done', expense: { id: 42 }, text: 'Added Milk ₹60 · UPI', now: 5000 });
  assert.strictEqual(second.bar.expense.id, 42);
  assert.strictEqual(second.bar.expiresAt, 20000);
  // The old bar's timer firing at 16 s does not close the new bar.
  assert.ok(u.undoReducer(second, { type: 'expire', now: 16000 }).bar);
  const undoing = u.undoReducer(second, { type: 'undo_start' });
  assert.strictEqual(u.undoReducer(undoing, { type: 'undo_start' }), undoing);
  assert.strictEqual(u.undoReducer(u.initialUndoState, { type: 'undo_start' }), u.initialUndoState);
});
test('rows: the added row stays in place as "Added ✓" while the bar shows; no reload until it closes', () => {
  const addTea = (st, now) => u.undoReducer(u.undoReducer(st, { type: 'add_start' }),
    { type: 'add_done', itemId: 1, expense: teaExpense, text: 'Added Tea ₹50 · Cash', now });
  const s0 = u.undoReducer(u.initialUndoState, { type: 'add_start' });
  assert.strictEqual(u.rowState(s0, 1), 'saving', 'every row waits during the save');
  assert.strictEqual(u.rowState(s0, 2), 'saving');
  const s = addTea(u.initialUndoState, 1000);
  assert.strictEqual(u.rowState(s, 1), 'added', 'tapped row locked');
  assert.strictEqual(u.rowState(s, 2), 'ready', 'other rows still usable');
  assert.strictEqual(u.needsReload(s), false, 'no reload while the bar shows');
  // A focus or sheet reload while the bar shows waits.
  const later = u.undoReducer(s, { type: 'reload_later' });
  assert.strictEqual(u.needsReload(later), false);
  assert.strictEqual(u.rowState(u.undoReducer(s, { type: 'expire', now: 15999 }), 1), 'added', 'still locked just before 15 s');
  const gone = u.undoReducer(later, { type: 'expire', now: 16000 });
  assert.strictEqual(gone.bar, null);
  assert.deepStrictEqual(gone.added, [1], 'kept until the reload answers');
  assert.strictEqual(u.rowState(gone, 1), 'added');
  assert.strictEqual(u.needsReload(gone), true, 'reload once the bar closes');
  const taken = u.undoReducer(gone, { type: 'reload_taken' });
  assert.strictEqual(u.needsReload(taken), false, 'reload runs once');
});
test('rows: Undo brings back + Add and reloads; a refused Undo reloads too', () => {
  const s = u.undoReducer(u.undoReducer(u.initialUndoState, { type: 'add_start' }),
    { type: 'add_done', itemId: 1, expense: teaExpense, text: 'Added Tea ₹50 · Cash', now: 1000 });
  const undoing = u.undoReducer(s, { type: 'undo_start' });
  assert.strictEqual(u.rowState(undoing, 1), 'added', 'locked while the undo is on its way');
  const done = u.undoReducer(undoing, { type: 'undo_done' });
  assert.strictEqual(u.rowState(done, 1), 'added', 'still locked until the reload answers');
  assert.strictEqual(u.rowState(u.undoReducer(done, { type: 'rows_loaded' }), 1), 'ready');
  assert.strictEqual(u.needsReload(done), true);
  const refused = u.undoReducer(undoing, { type: 'undo_failed', message: 'x' });
  assert.strictEqual(u.rowState(refused, 1), 'added');
  assert.strictEqual(u.rowState(u.undoReducer(refused, { type: 'rows_loaded' }), 1), 'ready');
  assert.strictEqual(u.needsReload(refused), true);
});
test('rows: a second add keeps both rows locked; a sheet save locks its item only while a bar shows', () => {
  let s = u.undoReducer(u.undoReducer(u.initialUndoState, { type: 'add_start' }),
    { type: 'add_done', itemId: 1, expense: teaExpense, text: 'Added Tea ₹50 · Cash', now: 1000 });
  s = u.undoReducer(u.undoReducer(s, { type: 'add_start' }),
    { type: 'add_done', itemId: 2, expense: { id: 42 }, text: 'Added Milk ₹60 · UPI', now: 2000 });
  assert.strictEqual(u.rowState(s, 1), 'added');
  assert.strictEqual(u.rowState(s, 2), 'added');
  s = u.undoReducer(s, { type: 'mark_added', itemId: 3 });
  assert.strictEqual(u.rowState(s, 3), 'added');
  assert.strictEqual(u.undoReducer(u.initialUndoState, { type: 'mark_added', itemId: 3 }), u.initialUndoState, 'no bar: nothing locked');
});
test('rows: after the bar closes the row stays Added until rows_loaded (success or failed reload)', () => {
  const s = u.undoReducer(u.undoReducer(u.initialUndoState, { type: 'add_start' }),
    { type: 'add_done', itemId: 1, expense: teaExpense, text: 'x', now: 1000 });
  for (const close of [{ type: 'expire', now: 16000 }, { type: 'dismiss' },
    { type: 'undo_done' }, { type: 'undo_failed', message: 'm' }]) {
    const base = close.type.startsWith('undo') ? u.undoReducer(s, { type: 'undo_start' }) : s;
    const closedState = u.undoReducer(base, close);
    assert.strictEqual(closedState.bar, null);
    assert.strictEqual(u.rowState(closedState, 1), 'added', close.type + ': locked after close');
    const loaded = u.undoReducer(closedState, { type: 'rows_loaded' });
    assert.strictEqual(u.rowState(loaded, 1), 'ready', close.type + ': cleared by rows_loaded');
    assert.deepStrictEqual(loaded.added, []);
  }
  // A failed reload dispatches the same action, so rows never stay locked.
  // A reload answering while a bar shows does not unlock that bar's rows.
  assert.strictEqual(u.rowState(u.undoReducer(s, { type: 'rows_loaded' }), 1), 'added');
});
test('undoBarText: "Added Tea ₹50 · Cash"', () => {
  assert.strictEqual(u.undoBarText('Tea', 50, 'cash'), 'Added Tea ₹50 · Cash');
  assert.strictEqual(u.undoBarText('Milk', 1250, 'upi'), 'Added Milk ₹1,250 · UPI');
});
test('usualNowBody: same body the sheet sends', () => {
  const body = u.usualNowBody(tea, 5);
  assert.deepStrictEqual(body, {
    location_id: 5, item_id: 1, category: 'food', amount: 50, payment_method: 'cash',
    is_return: false, note: null, employee_id: null, given_to_user_id: 7,
  });
  const typed = u.usualNowBody({ ...tea, my_last_method: 'upi', last_given_to: { user_id: null, name: 'Milkman', display_name: 'Milkman', present_today: true } }, 5);
  assert.strictEqual(typed.given_to_name, 'Milkman');
  assert.strictEqual(typed.payment_method, 'upi');
  const nobody = u.usualNowBody({ ...tea, last_given_to: null }, 5);
  assert.strictEqual(nobody.given_to_user_id, null);
  assert.strictEqual(nobody.given_to_name, null);
  assert.strictEqual(u.usualNowBody({ ...tea, common_amount: null, usual_amount: null }, 5), null, 'no amount -> no 1-tap');
});
test('usualNowRows: up to 3, salary left out', () => {
  const rows = u.usualNowRows({ usual_now: [tea, { ...tea, id: 2 }, { ...tea, id: 9, category: 'salary' }, { ...tea, id: 3 }, { ...tea, id: 4 }] });
  assert.deepStrictEqual(rows.map((r) => r.id), [1, 2, 3]);
  assert.deepStrictEqual(u.usualNowRows(null), []);
  assert.deepStrictEqual(u.usualNowRows({ data: [tea] }), [], 'older server: no Usual now line');
});

let passed = 0;
for (const t of tests) {
  try { t.fn(); passed++; console.log(`  ok   ${t.name}`); } catch (err) { console.log(`  FAIL ${t.name}\n       ${err.message}`); }
}
console.log(`\n${passed}/${tests.length} passed`);
if (passed !== tests.length) process.exit(1);
