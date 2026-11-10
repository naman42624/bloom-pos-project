// Plain-node tests for src/utils/quickSale.js. Run: node scripts/test-quick-sale.js
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

const q = loadModule(path.join(__dirname, '../src/utils/quickSale.js'));
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('amountError', () => {
  assert.strictEqual(q.amountError(''), 'Type the amount first');
  assert.strictEqual(q.amountError('0'), 'Type the amount first');
  assert.strictEqual(q.amountError('abc'), 'Type the amount first');
  assert.strictEqual(q.amountError('100001'), 'That looks too big — check the amount');
  assert.strictEqual(q.amountError('100000'), '');
  assert.strictEqual(q.amountError('350'), '');
  assert.strictEqual(q.amountError('1,250.50'), '');
  assert.strictEqual(q.amountError(' 1 200 '), '');
  assert.strictEqual(q.amountError('12-3'), 'Type the amount first');
  assert.strictEqual(q.amountError('0.001'), 'Type the amount first');
  assert.strictEqual(q.amountError('1e5'), 'Type the amount first');
  assert.strictEqual(q.amountError('-5'), 'Type the amount first');
  assert.strictEqual(q.amountError('100000.01'), 'That looks too big \u2014 check the amount');
  assert.strictEqual(q.amountError('1,500'), '');
});

test('payload for label', () => {
  const p = q.buildQuickSalePayload({ locationId: 4, method: 'cash', amount: '1,200', label: 'Bouquet' });
  assert.deepStrictEqual(p, {
    location_id: 4, order_type: 'walk_in', channel: 'walk_in', entry_mode: 'quick', skip_assignment: true,
    items: [{ product_name: 'Bouquet', quantity: 1, unit_price: 1200 }],
    payments: [{ method: 'cash', amount: 1200 }],
  });
  assert.strictEqual(q.buildQuickSalePayload({ locationId: 4, method: 'upi', amount: 50 }).items[0].product_name, 'Fresh Flowers');
});

test('payload for product', () => {
  const p = q.buildQuickSalePayload({ locationId: 4, method: 'upi', amount: 90, productId: 7 });
  assert.deepStrictEqual(p.items, [{ product_id: 7, quantity: 1, unit_price: 90, fulfill_from_stock: true }]);
  assert.deepStrictEqual(p.payments, [{ method: 'upi', amount: 90 }]);
});

test('payload for topup', () => {
  const p = q.buildQuickSalePayload({ locationId: 4, method: 'cash', amount: 75, label: q.TOPUP_LABEL, entryMode: 'close_topup' });
  assert.strictEqual(p.entry_mode, 'close_topup');
  assert.strictEqual(p.items[0].product_name, 'Unrecorded sales (booked at close)');
});

test('constants', () => {
  assert.strictEqual(q.MAX_QUICK_AMOUNT, 100000);
  assert.strictEqual(q.DEFAULT_QUICK_LABEL, 'Fresh Flowers');
  assert.deepStrictEqual(q.QUICK_LABELS, ['Fresh Flowers', 'Bouquet', 'Bunch', 'Box', 'Basket', 'Vase', 'Garland', 'Arrangement']);
});

test('tap guard', () => {
  const g = q.createTapGuard();
  assert.strictEqual(g('a', 0), true);
  assert.strictEqual(g('a', 500), false);
  assert.strictEqual(g('b', 100), true);
  assert.strictEqual(g('a', 800), true);
});

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test('sequentialSender keeps tap order', async () => {
  const order = [];
  const delays = [30, 5, 15];
  const s = q.createSequentialSender(async (e) => { await delay(delays[e.n]); order.push(e.n); return { id: 100 + e.n }; }, () => {});
  [0, 1, 2].forEach((n) => s.enqueue({ n }));
  await delay(120);
  assert.deepStrictEqual(order, [0, 1, 2]);
});

test('sequentialSender retries one failed entry once', async () => {
  let calls = 0;
  const failOnce = new Set([1]);
  const state = {};
  const s = q.createSequentialSender(async (e) => {
    calls++;
    if (failOnce.has(e.n)) { failOnce.delete(e.n); throw new Error('boom'); }
    return { id: 200 + e.n };
  }, (id, st) => { state[id] = st; });
  const ids = [0, 1, 2].map((n) => s.enqueue({ n }));
  await delay(50);
  assert.deepStrictEqual(ids.map((i) => state[i].status), ['saved', 'failed', 'saved']);
  assert.strictEqual(state[ids[0]].saleId, 200);
  s.retry(ids[0]); // not failed: ignored
  s.retry(ids[1]);
  await delay(50);
  assert.strictEqual(state[ids[1]].status, 'saved');
  assert.strictEqual(state[ids[1]].saleId, 201);
  assert.strictEqual(calls, 4);
});

test('sequentialSender survives a throwing onChange', async () => {
  let sent = 0, threw = false;
  const final = {};
  const s = q.createSequentialSender(async () => { sent++; return { id: sent }; }, (id, st) => {
    if (!threw) { threw = true; throw new Error('listener broke'); }
    final[id] = st.status;
  });
  [1, 2, 3].forEach((n) => s.enqueue({ n }));
  await delay(50);
  assert.strictEqual(sent, 3);
  assert.deepStrictEqual(Object.values(final).filter((x) => x === 'saved').length, 3);
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log('PASS', t.name); } catch (e) { failed++; console.log('FAIL', t.name, '-', e.message); }
  }
  console.log(`${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
