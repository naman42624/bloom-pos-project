// Plain-node tests for src/utils/riderKm.js. Run: node scripts/test-rider-km.js
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
const k = loadModule(path.join(__dirname, '../src/utils/riderKm.js'));
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('suggestKind: none -> arrive', () => assert.strictEqual(k.suggestKind(null), 'arrive'));
test('suggestKind: last arrive -> leave', () => assert.strictEqual(k.suggestKind({ kind: 'arrive' }), 'leave'));
test('suggestKind: last leave -> arrive', () => assert.strictEqual(k.suggestKind({ kind: 'leave' }), 'arrive'));
test('suggestKind: last typed -> arrive', () => assert.strictEqual(k.suggestKind({ kind: 'typed' }), 'arrive'));

test('workKmText: arrive then higher meter', () =>
  assert.strictEqual(k.workKmText({ kind: 'arrive', meter: 12340 }, 12386), '→ 46 km of work'));
test('workKmText: decimals trimmed to one place', () =>
  assert.strictEqual(k.workKmText({ kind: 'arrive', meter: 100 }, 112.5), '→ 12.5 km of work'));
test('workKmText: last leave -> null', () => assert.strictEqual(k.workKmText({ kind: 'leave', meter: 100 }, 150), null));
test('workKmText: meter not above -> null', () => assert.strictEqual(k.workKmText({ kind: 'arrive', meter: 100 }, 100), null));
test('workKmText: no last / empty meter -> null', () => {
  assert.strictEqual(k.workKmText(null, 150), null);
  assert.strictEqual(k.workKmText({ kind: 'arrive', meter: 100 }, ''), null);
  assert.strictEqual(k.workKmText({ kind: 'arrive', meter: 100 }, null), null);
});

test('stretchLabel: work', () => assert.strictEqual(k.stretchLabel({ kind: 'work', km: 46 }), '46 km'));
test('stretchLabel: home', () => assert.strictEqual(k.stretchLabel({ kind: 'home', km: 12 }), 'Home ride 12 km (not paid)'));
test('stretchLabel: open gap', () => assert.strictEqual(k.stretchLabel({ kind: 'gap', km: 314, answer: null }), 'Gap 314 km — answer'));
test('stretchLabel: km with decimals', () => assert.strictEqual(k.stretchLabel({ kind: 'work', km: 12.5 }), '12.5 km'));

test('netText', () => {
  assert.strictEqual(k.netText('L', 22600), 'Shop pays L ₹226');
  assert.strictEqual(k.netText('L', -41400), 'L owes ₹414');
  assert.strictEqual(k.netText('L', 0), 'Nothing to pay');
  assert.strictEqual(k.netText('L', 22650), 'Shop pays L ₹226.5');
});

test('readAtFor: nothing picked -> undefined', () => assert.strictEqual(k.readAtFor({ typedMode: true, when: null }), undefined));
test('readAtFor: typed today before noon -> undefined (no future time)', () => {
  const now = new Date(2026, 10, 15, 9, 5);
  assert.strictEqual(k.readAtFor({ typedMode: true, when: new Date(2026, 10, 15), now }), undefined);
});
test('readAtFor: typed past day -> 12:00', () => {
  const now = new Date(2026, 10, 15, 9, 5);
  assert.strictEqual(k.readAtFor({ typedMode: true, when: new Date(2026, 10, 13, 7, 0), now }), '2026-11-13 12:00');
});
test('readAtFor: picked past time -> YYYY-MM-DD HH:MM', () => {
  const now = new Date(2026, 10, 15, 9, 5);
  assert.strictEqual(k.readAtFor({ typedMode: false, when: new Date(2026, 10, 14, 18, 7), now }), '2026-11-14 18:07');
});
test('readAtFor: picked time later today is held back to now', () => {
  const now = new Date(2026, 10, 15, 9, 5);
  assert.strictEqual(k.readAtFor({ typedMode: false, when: new Date(2026, 10, 15, 17, 0), now }), '2026-11-15 09:05');
});
test('clampToNow', () => {
  const now = new Date(2026, 10, 15, 9, 5);
  assert.strictEqual(k.clampToNow(new Date(2026, 10, 15, 10, 0), now).getHours(), 9);
  assert.strictEqual(k.clampToNow(new Date(2026, 10, 15, 8, 0), now).getHours(), 8);
});

// ─── Task 6: settle sheet, card line, history ────────────────
test('stretchLabel: answered gaps say what was answered', () => {
  assert.strictEqual(k.stretchLabel({ kind: 'gap', km: 314, answer: { answer: 'typed', work_km: 20 } }), 'Gap 314 km · 20 km work');
  assert.strictEqual(k.stretchLabel({ kind: 'gap', km: 40, answer: { answer: 'none', work_km: null } }), 'Gap 40 km · no work');
  assert.strictEqual(k.stretchLabel({ kind: 'typed', km: 24 }), '24 km (typed)');
});
test('moneyText: plain and signed', () => {
  assert.strictEqual(k.moneyText(33600), '₹336');
  assert.strictEqual(k.moneyText(-20000, true), '−₹200');
  assert.strictEqual(k.moneyText(4000, true), '₹40');
  assert.strictEqual(k.moneyText(12345), '₹123.45');
});
test('dayLabel and rangeLabel', () => {
  assert.strictEqual(k.dayLabel('2026-11-10 18:00:00'), '10 Nov');
  assert.strictEqual(k.dayLabel('2026-11-10'), '10 Nov');
  assert.strictEqual(k.rangeLabel('2026-11-12 18:00:00', '2026-11-14 09:00:00'), '12–14 Nov');
  assert.strictEqual(k.rangeLabel('2026-11-12 13:00:00', '2026-11-12 18:00:00'), '12 Nov');
  assert.strictEqual(k.rangeLabel('2026-10-31 18:00:00', '2026-11-02 09:00:00'), '31 Oct – 2 Nov');
});

const preview = {
  net_paise: -50400,
  lines: {
    stretches_by_day: [
      { date: '2026-11-10', paid_km: 46, stretches: [{ kind: 'work', paid_km: 46 }, { kind: 'home', paid_km: 0 }] },
      { date: '2026-11-11', paid_km: 66, stretches: [{ kind: 'work', paid_km: 34 }, { kind: 'home', paid_km: 0 }, { kind: 'work', paid_km: 32 }] },
      { date: '2026-11-12', paid_km: 0, stretches: [{ kind: 'home', paid_km: 0 }] },
    ],
    by_rate: [{ rate: 3, km: 112, amount_paise: 33600 }],
    corrections: [],
    paid_km: 112, km_paise: 33600,
    petrol: [{ id: 1, amount_paise: 10000 }, { id: 2, amount_paise: 10000 }], petrol_taken_paise: 20000,
    carried_in_paise: -4000,
    shopping: [{ id: 9, remaining_paise: 10000 }], supply_held_paise: 10000,
    cod: [{ delivery_id: 5, cash_paise: 50000, upi_paise: 0, own_upi: false }, { delivery_id: 6, cash_paise: 0, upi_paise: 30000, own_upi: false }],
    cod_held_paise: 50000,
  },
};
test('settleDays: the sketch day lines, trips counted, unpaid days left out', () => {
  assert.deepStrictEqual(k.settleDays(preview.lines), [
    { date: '2026-11-10', label: '10 Nov', text: '46 km' },
    { date: '2026-11-11', label: '11 Nov', text: '66 km (2 trips)' },
  ]);
});
test('settleMoneyLines: the sketch money lines with signs', () => {
  assert.deepStrictEqual(k.settleMoneyLines(preview.lines, 'L').map((x) => [x.label, k.moneyText(x.paise, true)]), [
    ['112 km × ₹3', '₹336'],
    ['Petrol taken (2)', '−₹200'],
    ['Carried from last time', '−₹40'],
    ['Supply money with L', '−₹100'],
    ['COD with L (1 order)', '−₹500'],
  ]);
});
test('settleMoneyLines: one line per rate, corrections and zero lines left out', () => {
  const lines = {
    ...preview.lines, by_rate: [{ rate: 3, km: 100, amount_paise: 30000 }, { rate: 4, km: 12, amount_paise: 4800 }],
    petrol: [], petrol_taken_paise: 0, carried_in_paise: 0, shopping: [], supply_held_paise: 0, cod: [], cod_held_paise: 0,
  };
  assert.deepStrictEqual(k.settleMoneyLines(lines, 'L').map((x) => x.label), ['100 km × ₹3', '12 km × ₹4']);
});
test('settleMoneyLines: an own-UPI order counts in COD orders', () => {
  const lines = { ...preview.lines, cod: [{ delivery_id: 5, cash_paise: 50000, upi_paise: 0 }, { delivery_id: 6, cash_paise: 0, upi_paise: 30000, own_upi: true }], cod_held_paise: 80000 };
  assert.strictEqual(k.settleMoneyLines(lines, 'L').find((x) => x.key === 'cod').label, 'COD with L (2 orders)');
});
test('upiCodOrders: only orders with a UPI part', () => {
  assert.deepStrictEqual(k.upiCodOrders(preview.lines).map((d) => d.delivery_id), [6]);
});
test('settleChoices: by the sign of net', () => {
  assert.deepStrictEqual(k.settleChoices(22600, 'L', { owner: false }), {
    primary: { action: 'pay', label: 'Pay L ₹226' }, carry: 'Carry ₹226 to next time', take: null, salary: null,
  });
  assert.deepStrictEqual(k.settleChoices(-50400, 'L', { owner: true }), {
    primary: { action: 'carry', label: 'Carry ₹504 to next time' }, carry: null, take: 'Take some now', salary: 'Take from salary',
  });
  assert.deepStrictEqual(k.settleChoices(0, 'L', { owner: true }), {
    primary: { action: 'zero', label: 'Settle' }, carry: null, take: null, salary: null,
  });
});
test('moveButtonLabel: the amount and the method', () => {
  assert.strictEqual(k.moveButtonLabel('pay', 'L', '226', 'upi'), 'Pay L ₹226 (UPI)');
  assert.strictEqual(k.moveButtonLabel('take', 'L', '100.5', 'cash'), 'Take ₹100.5 from L (Cash)');
});
test('checkMoveAmount: 0.01 up to the net', () => {
  assert.strictEqual(k.checkMoveAmount('226', 22600), null);
  assert.strictEqual(k.checkMoveAmount('0', 22600), 'Type an amount from ₹0.01 to ₹226.');
  assert.strictEqual(k.checkMoveAmount('300', -22600), 'Type an amount from ₹0.01 to ₹226.');
  assert.strictEqual(k.checkMoveAmount('1.234', 22600), 'Type an amount from ₹0.01 to ₹226.');
  assert.strictEqual(k.checkMoveAmount('', 22600), 'Type an amount from ₹0.01 to ₹226.');
});
test('riderCardLine', () => {
  assert.strictEqual(k.riderCardLine({ name: 'L', unsettled_km: 142, gaps: 0, balance_paise: -41400 }), 'L · 142 km · L owes ₹414');
  assert.strictEqual(k.riderCardLine({ name: 'L', unsettled_km: 20, gaps: 1, balance_paise: null }), 'L · 20 km · Gaps to answer');
  assert.strictEqual(k.riderCardLine({ name: 'Aman', unsettled_km: 0, gaps: 0, balance_paise: 22600 }), 'Aman · 0 km · Shop pays Aman ₹226');
});
test('cardRiders: only riders with readings', () => {
  assert.deepStrictEqual(k.cardRiders([{ id: 1, has_account: true }, { id: 2, has_account: false }, { id: 3 }]).map((r) => r.id), [1]);
});
test('pastSettlementText', () => {
  assert.strictEqual(k.pastSettlementText({ created_at: '2026-11-08T12:00:00.000Z', paid_km: 210, action: 'pay', moved_amount: 380, moved_method: 'upi', carry_out: 0 }), '8 Nov · 210 km · paid ₹380 (UPI)');
  assert.strictEqual(k.pastSettlementText({ created_at: '2026-11-03T12:00:00.000Z', paid_km: 95, action: 'carry', carry_out: -40 }), '3 Nov · 95 km · carried −₹40');
  assert.strictEqual(k.pastSettlementText({ created_at: '2026-11-03T12:00:00.000Z', paid_km: 95, action: 'take', moved_amount: 100, moved_method: 'cash', carry_out: 0 }), '3 Nov · 95 km · took ₹100 (Cash)');
  assert.strictEqual(k.pastSettlementText({ created_at: '2026-11-03T12:00:00.000Z', paid_km: 10, action: 'zero', carry_out: 0 }), '3 Nov · 10 km · settled');
  assert.strictEqual(k.pastSettlementText({ created_at: '2026-11-03T12:00:00.000Z', paid_km: 0, action: 'salary', carry_out: 0 }), '3 Nov · 0 km · taken at payroll');
});
test('kmHistoryLine', () => {
  assert.strictEqual(k.kmHistoryLine({ rider_name: 'L', paid_km: 112, cod_held_paise: 50000 }), 'Km · L · 112 km · COD ₹500');
  assert.strictEqual(k.kmHistoryLine({ rider_name: 'L', paid_km: 12.5, cod_held_paise: 0 }), 'Km · L · 12.5 km · COD ₹0');
});
test('mergeSettlementHistory: newest first by created_at, km rows tagged', () => {
  const out = k.mergeSettlementHistory(
    [{ id: 1, created_at: '2026-11-10T10:00:00.000Z' }, { id: 2, created_at: '2026-11-12T10:00:00.000Z' }],
    [{ id: 1, created_at: '2026-11-11T10:00:00.000Z' }, { id: 7, created_at: '2026-11-13T10:00:00.000Z' }],
  );
  assert.deepStrictEqual(out.map((x) => x.key), ['km7', 'd2', 'km1', 'd1']);
  assert.strictEqual(out[0].kind, 'km');
  assert.strictEqual(out[1].kind, 'delivery');
});

let failed = 0;
for (const t of tests) {
  try { t.fn(); console.log(`ok   ${t.name}`); } catch (e) { failed++; console.log(`FAIL ${t.name}: ${e.message}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
