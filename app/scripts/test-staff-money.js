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

// ── B7: the add sheet's Salary advance / Shopping money / Own pocket ──
const people = [
  { id: 5, name: 'Ramesh Kumar', role: 'counter_staff', recent_rank: 1 },
  { id: 2, name: 'Asha', role: 'manager', recent_rank: 2 },
  { id: 9, name: 'Priya', role: 'counter_staff', recent_rank: null },
  { id: 7, name: 'Tota Ram', role: 'delivery_partner', recent_rank: null },
];
test('moneyLinksFor: typed advance / shopping offer the matching link', () => {
  assert.deepStrictEqual(s.moneyLinksFor('advance'), ['advance']);
  assert.deepStrictEqual(s.moneyLinksFor('  Adv '), ['advance']);
  assert.deepStrictEqual(s.moneyLinksFor('salary advance for ramesh'), ['advance']);
  assert.deepStrictEqual(s.moneyLinksFor('Shop'), ['shopping']);
  assert.deepStrictEqual(s.moneyLinksFor('shopping money'), ['shopping']);
  assert.deepStrictEqual(s.moneyLinksFor('ad'), [], 'two letters are too few');
  assert.deepStrictEqual(s.moneyLinksFor('Tea'), []);
  assert.deepStrictEqual(s.moneyLinksFor(''), []);
});
test('moneyLinksFor: "salary" offers Salary advance only when salary is hidden', () => {
  assert.deepStrictEqual(s.moneyLinksFor('salary', { hideSalary: true }), ['advance']);
  assert.deepStrictEqual(s.moneyLinksFor('salary'), []);
});
test('whoChips: recent people first, then Me, chosen always shown', () => {
  const c = s.whoChips(people, 2, null);
  assert.deepStrictEqual(c.map((x) => x.id), [5, 9, 7, 2]);
  assert.strictEqual(c[3].me, true);
  assert.strictEqual(c[3].label, 'Me');
  assert.strictEqual(c[0].label, 'Ramesh Kumar');
  // Me is not offered when the caller is not in the list (the owner).
  assert.deepStrictEqual(s.whoChips(people, 1, null).map((x) => x.id), [5, 2, 9]);
  // A chosen person from More replaces the last chip.
  assert.deepStrictEqual(s.whoChips(people, 1, 7).map((x) => x.id), [7, 5, 2]);
  assert.deepStrictEqual(s.whoChips([], 1, null), []);
});
test('whoseChips: Me first, then others; chosen always shown', () => {
  const list = [{ id: 1, name: 'Owner' }, ...people];
  assert.deepStrictEqual(s.whoseChips(list, 1, null).map((x) => x.id), [1, 5, 2]);
  assert.strictEqual(s.whoseChips(list, 1, null)[0].label, 'Me');
  assert.deepStrictEqual(s.whoseChips(list, 1, 7).map((x) => x.id), [1, 7, 5]);
  assert.deepStrictEqual(s.whoseChips(list, 1, 1).map((x) => x.id), [1, 5, 2], 'Me picked = no extra chip');
  assert.deepStrictEqual(s.whoseChips([], 1, null).map((x) => x.id), [1], 'Me even before the list loads');
});
test('unpaidAdvances: approved minus taken from pay, paise maths', () => {
  const rows = [
    { user_id: 5, status: 'approved', amount: '300.10', repaid_amount: '100' },
    { user_id: 5, status: 'approved', amount: 900, repaid_amount: null },
    { user_id: 5, status: 'repaid', amount: 500, repaid_amount: 500 },
    { user_id: 5, status: 'pending', amount: 700 },
    { user_id: 6, status: 'approved', amount: 999 },
  ];
  assert.strictEqual(s.unpaidAdvances(rows, 5), 1100.1);
  assert.strictEqual(s.unpaidAdvances([], 5), 0);
  assert.strictEqual(s.unpaidAdvances(null, 5), 0);
});
test('heldBy: sums the person\'s open shopping lines, oldest id first', () => {
  const open = [
    { id: 11, user_id: 5, remaining: 200 },
    { id: 14, user_id: 5, remaining: 300.5 },
    { id: 12, user_id: 9, remaining: 50 },
  ];
  assert.deepStrictEqual(s.heldBy(open, 5), { amount: 500.5, id: 11 });
  assert.deepStrictEqual(s.heldBy(open, 3), { amount: 0, id: null });
  assert.deepStrictEqual(s.heldBy(undefined, 5), { amount: 0, id: null });
});
test('moneyLine: the line under Note (spec 4.2)', () => {
  assert.strictEqual(s.moneyLine('advance', 'Ramesh Kumar', 1200), 'Ramesh: ₹1,200 in advances not yet taken from pay');
  assert.strictEqual(s.moneyLine('shopping', 'Ramesh', 500), 'Ramesh still has ₹500 shopping money');
  assert.strictEqual(s.moneyLine('advance', 'Ramesh', 0), null);
  assert.strictEqual(s.moneyLine('shopping', 'Ramesh', null), null);
  assert.strictEqual(s.moneyLine('advance', 'Ramesh', 300, { me: true }), 'You: ₹300 in advances not yet taken from pay');
  assert.strictEqual(s.moneyLine('shopping', 'Ramesh', 300, { me: true }), 'You still have ₹300 shopping money');
});
test('isBackHint: "Ramesh has ₹500 shopping money — Ramesh is back?"', () => {
  assert.strictEqual(s.isBackHint('Ramesh Kumar', 500), 'Ramesh has ₹500 shopping money — Ramesh is back?');
  assert.strictEqual(s.isBackHint('Ramesh', 0), null);
});
test('parseGiveAmount: rupees with up to 2 decimals, above 0 (server parseMoney)', () => {
  assert.strictEqual(s.parseGiveAmount('300'), 300);
  assert.strictEqual(s.parseGiveAmount(' 300.5 '), 300.5);
  assert.strictEqual(s.parseGiveAmount('300.55'), 300.55);
  assert.strictEqual(s.parseGiveAmount('300.555'), null);
  assert.strictEqual(s.parseGiveAmount('0'), null);
  assert.strictEqual(s.parseGiveAmount(''), null);
  assert.strictEqual(s.parseGiveAmount('1.2.3'), null);
});
test('firstName', () => {
  assert.strictEqual(s.firstName('Ramesh Kumar'), 'Ramesh');
  assert.strictEqual(s.firstName('  '), 'This person');
});

// ── B8: is-back screen, pay back, card ──
test('isBackSums: 500 out, one 300 bill, change 200 -> Done allowed', () => {
  const r = s.isBackSums(500, [{ amount: 300 }], '200');
  assert.strictEqual(r.billsTotal, 300);
  assert.strictEqual(r.afterBills, 200);
  assert.strictEqual(r.still, 0);
  assert.strictEqual(r.over, 0);
  assert.strictEqual(r.canDone, true);
  assert.strictEqual(s.isBackError('Ramesh', r, true), null);
});
test('isBackSums: part settle (change 100) -> only Save, rest later', () => {
  const r = s.isBackSums(500, [{ amount: 300 }], '100');
  assert.strictEqual(r.still, 100);
  assert.strictEqual(r.canDone, false);
  assert.strictEqual(r.canSaveLater, true);
  assert.strictEqual(s.isBackError('Ramesh Kumar', r, true),
    'Ramesh still has ₹100. Add what was bought or the change back — or tap Save, rest later.');
  assert.strictEqual(s.isBackError('Ramesh Kumar', r, false), null);
});
test('isBackSums: overspent 620 -> owes 120, change must be 0', () => {
  const r = s.isBackSums(500, [{ amount: 620 }], '0');
  assert.strictEqual(r.over, 120);
  assert.strictEqual(r.still, 0);
  assert.strictEqual(r.canDone, true);
  assert.strictEqual(s.overspendText('Ramesh', r.over), 'Ramesh spent ₹120 of his own — the shop owes him ₹120.');
  const bad = s.isBackSums(500, [{ amount: 620 }], '10');
  assert.strictEqual(bad.changeError, 'too_much');
  assert.strictEqual(s.isBackError('Ramesh', bad, true), 'Ramesh only has ₹0 left — check the change amount.');
});
test('isBackSums: no bills, all change back -> Done allowed; nothing at all -> refused', () => {
  assert.strictEqual(s.isBackSums(500, [], '500').canDone, true);
  const none = s.isBackSums(500, [], '');
  assert.strictEqual(none.canSaveLater, false);
  assert.strictEqual(s.isBackError('Ramesh', none, false), 'Add what was bought or the change brought back, then tap Done.');
});
test('isBackSums: bad change text', () => {
  const r = s.isBackSums(500, [], '2..0');
  assert.strictEqual(r.changeError, 'format');
  assert.strictEqual(r.change, null);
  assert.strictEqual(s.isBackError('Ramesh', r, true), 'Type the change as an amount, like 200, or 0.');
  assert.strictEqual(s.parseChangeText(''), 0);
  assert.strictEqual(s.parseChangeText('200.50'), 200.5);
});
test('settleBody: item ids kept, typed names sent, method only with change', () => {
  const bills = [{ item_id: 7, name: 'Roses', amount: 300, category: 'supplies' }, { name: 'Tape', amount: 20 }];
  const b = s.settleBody(bills, s.isBackSums(500, bills, '180'), 'cash', true);
  assert.deepStrictEqual(b, {
    bills: [{ amount: 300, item_id: 7, category: 'supplies' }, { amount: 20, item_name: 'Tape' }],
    change_back: 180, final: true, change_method: 'cash',
  });
  const noChange = s.settleBody(bills, s.isBackSums(320, bills, ''), 'upi', true);
  assert.strictEqual(noChange.change_method, undefined);
  assert.strictEqual(noChange.change_back, 0);
});
test('billCheck: name and amount', () => {
  assert.strictEqual(s.billCheck('', '300').field, 'name');
  assert.strictEqual(s.billCheck('Roses', '').field, 'amount');
  assert.deepStrictEqual(s.billCheck('Roses', '300'), { error: null, amount: 300 });
});
test('payBackCheck: part allowed, more than owed refused', () => {
  assert.deepStrictEqual(s.payBackCheck('120', 120, 'Ramesh'), { error: null, amount: 120 });
  assert.deepStrictEqual(s.payBackCheck('50', 120, 'Ramesh'), { error: null, amount: 50 });
  assert.strictEqual(s.payBackCheck('130', 120, 'Ramesh K').error, 'The shop owes Ramesh only ₹120. Type ₹120 or less.');
  assert.strictEqual(s.payBackCheck('0', 120, 'Ramesh').error, 'Type an amount above ₹0, like 300.');
});
test('titles and labels', () => {
  assert.strictEqual(s.isBackTitle('Ramesh Kumar'), 'Ramesh is back — what did he buy?');
  assert.strictEqual(s.hadLine(500, new Date(2026, 10, 12, 10, 0), 'Priya Shah'), 'Had ₹500 · given 12 Nov by Priya');
  assert.strictEqual(s.hadLine(500, null, null), 'Had ₹500');
  assert.strictEqual(s.daysText(0), 'Today');
  assert.strictEqual(s.daysText(1), '1 day');
  assert.strictEqual(s.daysText(4), '4 days');
  assert.strictEqual(s.historyStatus('to_salary'), 'Taken from pay');
});
test('cardHasLines: only while something is out or owed', () => {
  assert.strictEqual(s.cardHasLines(null), false);
  assert.strictEqual(s.cardHasLines({ shopping: [], owes: [] }), false);
  assert.strictEqual(s.cardHasLines({ shopping: [{ id: 1 }], owes: [] }), true);
  assert.strictEqual(s.cardHasLines({ owes: [{ id: 1 }] }), true);
});

test('changeMethodDefault: UPI only when the register is known closed', () => {
  assert.strictEqual(s.changeMethodDefault(false), 'upi');
  assert.strictEqual(s.changeMethodDefault(true), 'cash');
  assert.strictEqual(s.changeMethodDefault(undefined), 'cash');
});
test('canOfferRemove: only while nothing is accounted for', () => {
  assert.strictEqual(s.canOfferRemove({ amount: 500, remaining: 500 }), true);
  assert.strictEqual(s.canOfferRemove({ amount: 500, remaining: 200 }), false);
  assert.strictEqual(s.canOfferRemove({ amount: 500, remaining: 0 }), false);
  assert.strictEqual(s.canOfferRemove({ remaining: 500 }), false);
  assert.strictEqual(s.canOfferRemove(null), false);
});
test('removeConfirmText: cash back into the drawer / UPI just removed', () => {
  assert.strictEqual(s.removeConfirmText({ user_name: 'Ramesh K', amount: 500, payment_method: 'cash' }),
    'The ₹500 cash goes back into the drawer and Ramesh no longer holds it. Use this only if it was typed by mistake.');
  assert.strictEqual(s.removeConfirmText({ user_name: 'Ramesh', amount: 500, payment_method: 'upi' }),
    'The ₹500 UPI shopping money given to Ramesh is removed. Use this only if it was typed by mistake.');
});

let failed = 0;
for (const t of tests) {
  try { t.fn(); console.log('  ok   ' + t.name); } catch (err) { failed++; console.log('  FAIL ' + t.name + '\n       ' + err.message); }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
