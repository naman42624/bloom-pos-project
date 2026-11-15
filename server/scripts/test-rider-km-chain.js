// Plain-node tests for utils/rider-km.js. Run: node server/scripts/test-rider-km-chain.js
const assert = require('assert');
const k = require('../utils/rider-km');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
let nextId = 1;
const rd = (kind, meter, at) => ({ id: nextId++, kind, meter, typed_km: null, read_at: at || `2026-11-0${Math.min(9, nextId)} 09:00:00` });
const seq = (list) => { nextId = 1; return list.map(([kind, meter, at]) => rd(kind, meter, at)); };

test('in-out-in-out', () => {
  const r = seq([['arrive', 12340], ['leave', 12386], ['arrive', 12398], ['leave', 12430], ['arrive', 12436], ['leave', 12470]]);
  const c = k.buildChain(r, [], {});
  assert.deepStrictEqual(c.stretches.filter((s) => s.kind === 'work').map((s) => s.km), [46, 32, 34]);
  assert.deepStrictEqual(c.stretches.filter((s) => s.kind === 'home').map((s) => s.km), [12, 6]);
  assert.strictEqual(k.priceStretches(c.stretches, [{ rate: 3, effective_from: '2000-01-01' }], []).paidKm, 112);
  assert.strictEqual(c.openDay, false);
  assert.strictEqual(c.usualHomeKm, 9);
});
test('missed leave', () => {
  const c = k.buildChain(seq([['arrive', 12340], ['arrive', 12700]]), [], {});
  assert.strictEqual(c.stretches.length, 1);
  assert.strictEqual(c.stretches[0].kind, 'gap');
  assert.strictEqual(c.stretches[0].reason, 'missed_leave');
  assert.strictEqual(c.stretches[0].km, 360);
  assert.strictEqual(c.openDay, true);
});
test('missed arrive', () => {
  const c = k.buildChain(seq([['leave', 12386], ['leave', 12500]]), [], {});
  assert.strictEqual(c.stretches[0].reason, 'missed_arrive');
});
test('long home', () => {
  // home stretches 10, 12, 11 then 314
  const r = seq([['leave', 0], ['arrive', 10], ['leave', 20], ['arrive', 32], ['leave', 40], ['arrive', 51], ['leave', 60], ['arrive', 374]]);
  const c = k.buildChain(r, [], {});
  const last = c.stretches[c.stretches.length - 1];
  assert.strictEqual(last.kind, 'gap');
  assert.strictEqual(last.reason, 'long_home');
  assert.strictEqual(last.km, 314);
  const none31 = k.buildChain(seq([['leave', 0], ['arrive', 31]]), [], {});
  assert.strictEqual(none31.stretches[0].reason, 'long_home');
  const none30 = k.buildChain(seq([['leave', 0], ['arrive', 30]]), [], {});
  assert.strictEqual(none30.stretches[0].kind, 'home');
  const owner = k.buildChain(seq([['leave', 0], ['arrive', 25]]), [], { usualHomeKm: 10 });
  assert.strictEqual(owner.stretches[0].reason, 'long_home');
});
test('usualHome median of last 10', () => {
  assert.strictEqual(k.usualHome([]), null);
  const hs = [10, 12, 11].map((km) => ({ kind: 'home', km }));
  assert.strictEqual(k.usualHome(hs), 11);
});
test('answered gap', () => {
  const r = seq([['arrive', 12340, '2026-11-05 09:00:00'], ['arrive', 12540, '2026-11-06 09:00:00']]);
  const rates = [{ rate: 3, effective_from: '2000-01-01' }];
  const typed = k.buildChain(r, [{ from_reading_id: 1, to_reading_id: 2, answer: 'typed', work_km: 200 }], {});
  assert.strictEqual(k.priceStretches(typed.stretches, rates, []).paidKm, 200);
  const none = k.buildChain(r, [{ from_reading_id: 1, to_reading_id: 2, answer: 'none', work_km: 0 }], {});
  assert.strictEqual(k.priceStretches(none.stretches, rates, []).paidKm, 0);
  const open = k.buildChain(r, [], {});
  assert.strictEqual(k.priceStretches(open.stretches, rates, []).paidKm, 0);
});
test('typed km', () => {
  nextId = 1;
  const r = [
    { id: 1, kind: 'arrive', meter: 100, read_at: '2026-11-05 09:00:00' },
    { id: 2, kind: 'typed', meter: null, typed_km: 40, read_at: '2026-11-05 10:00:00' },
    { id: 3, kind: 'leave', meter: 9000, read_at: '2026-11-05 18:00:00' },
  ];
  const c = k.buildChain(r, [], {});
  assert.strictEqual(c.stretches.length, 1);
  assert.strictEqual(c.stretches[0].kind, 'typed');
  assert.strictEqual(k.priceStretches(c.stretches, [{ rate: 3, effective_from: '2000-01-01' }], []).paidKm, 40);
  assert.strictEqual(c.openDay, false);
});
test('rate change', () => {
  const st = [
    { kind: 'work', km: 10, endAt: '2026-11-09 10:00:00', answer: null },
    { kind: 'work', km: 20, endAt: '2026-11-11 10:00:00', answer: null },
  ];
  const rates = [{ rate: 3, effective_from: '2000-01-01' }, { rate: 4, effective_from: '2026-11-10' }];
  const p = k.priceStretches(st, rates, []);
  assert.deepStrictEqual(p.byRate, [{ rate: 3, km: 10, amountPaise: 3000 }, { rate: 4, km: 20, amountPaise: 8000 }]);
  assert.strictEqual(p.amountPaise, 11000);
  assert.strictEqual(k.rateOn(rates, '2026-11-10'), 4);
  assert.strictEqual(k.rateOn(rates, '2026-11-09'), 3);
});
test('corrections', () => {
  const rates = [{ rate: 3, effective_from: '2000-01-01' }, { rate: 4, effective_from: '2026-11-10' }];
  const p = k.priceStretches([], rates, [{ km: 10, for_date: '2026-11-11', created_at: '2026-11-14 09:00:00' }]);
  assert.strictEqual(p.amountPaise, 4000);
  const q = k.priceStretches([], rates, [{ km: 10, for_date: null, created_at: '2026-11-09 09:00:00' }]);
  assert.strictEqual(q.amountPaise, 3000);
});
test('net', () => {
  assert.strictEqual(k.netPaise({ kmPaise: 33600, petrolTakenPaise: 20000, carriedInPaise: -4000, supplyHeldPaise: 10000, codHeldPaise: 50000 }), -50400);
});
test('openDay', () => {
  assert.strictEqual(k.buildChain(seq([['leave', 1], ['arrive', 5]]), [], {}).openDay, true);
  assert.strictEqual(k.buildChain([], [], {}).openDay, false);
});

let pass = 0;
for (const t of tests) {
  try { t.fn(); pass++; } catch (e) { console.log('FAIL', t.name, '-', e.message); }
}
console.log(`${pass}/${tests.length} passed`);
process.exit(pass === tests.length ? 0 : 1);
