// Plain-node tests for src/utils/helperBasket.js. Run: node scripts/test-helper-basket.js
const assert = require('assert');
const path = require('path');
const Module = require('module');
const babel = require('@babel/core');

// Resolved from app/, so the script runs from the repo root too.
const PRESET = require.resolve('babel-preset-expo', { paths: [path.join(__dirname, '..')] });

function loadModule(file) {
  const { code } = babel.transformFileSync(file, { presets: [PRESET], babelrc: false, configFile: false });
  const m = new Module(file, module);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(code, file);
  return m.exports;
}

const b = loadModule(path.join(__dirname, '../src/utils/helperBasket.js'));
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const rose = { product_id: 1, option_id: null, name: 'Rose (stem)', unit_price: 30, price_mode: 'fixed', tax_rate: 0 };
const bouquetM = { product_id: 2, option_id: 21, name: 'Bouquet (Medium)', unit_price: 650, price_mode: 'fixed', tax_rate: 0 };
const bouquetL = { product_id: 2, option_id: 22, name: 'Bouquet (Large)', unit_price: 900, price_mode: 'fixed', tax_rate: 0 };
const custom = (price) => ({ product_id: 3, option_id: null, name: 'Arrangement', unit_price: price, price_mode: 'open', tax_rate: 0 });

test('addLine adds, then merges the same product + option + price', () => {
  let basket = [];
  basket = b.addLine(basket, rose);
  assert.strictEqual(basket.length, 1);
  assert.strictEqual(basket[0].qty, 1);
  basket = b.addLine(basket, rose);
  assert.strictEqual(basket.length, 1);
  assert.strictEqual(basket[0].qty, 2);
  basket = b.addLine(basket, bouquetM);
  basket = b.addLine(basket, bouquetL);
  assert.strictEqual(basket.length, 3, 'different sizes are separate lines');
  basket = b.addLine(basket, custom(500));
  basket = b.addLine(basket, custom(700));
  assert.strictEqual(basket.length, 5, 'different typed prices are separate lines');
  basket = b.addLine(basket, custom(500));
  assert.strictEqual(basket.find((l) => l.unit_price === 500).qty, 2);
});

test('addLine never changes the basket it was given', () => {
  const before = b.addLine([], rose);
  const after = b.addLine(before, rose);
  assert.strictEqual(before[0].qty, 1);
  assert.strictEqual(after[0].qty, 2);
});

test('newest line goes on top', () => {
  let basket = b.addLine([], rose);
  basket = b.addLine(basket, bouquetM);
  assert.strictEqual(basket[0].product_id, 2);
});

test('changeQty adds, takes away, and 0 removes the line', () => {
  let basket = b.addLine([], rose);
  const key = basket[0].key;
  basket = b.changeQty(basket, key, 10);
  assert.strictEqual(basket[0].qty, 11);
  basket = b.changeQty(basket, key, -1);
  assert.strictEqual(basket[0].qty, 10);
  basket = b.changeQty(basket, key, -10);
  assert.strictEqual(basket.length, 0);
});

test('changeQty never goes over 9999 and ignores an unknown key', () => {
  let basket = b.addLine([], rose);
  basket = b.changeQty(basket, basket[0].key, 20000);
  assert.strictEqual(basket[0].qty, 9999);
  const same = b.changeQty(basket, 'nope', 1);
  assert.deepStrictEqual(same, basket);
});

test('basketCount counts pieces', () => {
  let basket = b.addLine([], rose);
  basket = b.changeQty(basket, basket[0].key, 9);
  basket = b.addLine(basket, bouquetM);
  assert.strictEqual(b.basketCount(basket), 11);
});

test('basketTotal without discount is the plain sum', () => {
  let basket = b.addLine([], rose);
  basket = b.changeQty(basket, basket[0].key, 9); // 10 x 30
  basket = b.addLine(basket, { ...bouquetM, unit_price: 450 });
  basket = b.addLine(basket, { product_id: 5, option_id: null, name: 'Wrapping', unit_price: 50, price_mode: 'fixed', tax_rate: 0 });
  assert.deepStrictEqual(b.basketTotal(basket, null), { subtotal: 800, discount: 0, total: 800, error: null });
  assert.deepStrictEqual(b.basketTotal([], null), { subtotal: 0, discount: 0, total: 0, error: null });
});

test('basketTotal with a rupee discount', () => {
  let basket = b.addLine([], { ...bouquetM, unit_price: 800 });
  assert.deepStrictEqual(b.basketTotal(basket, { type: 'fixed', value: 50 }), { subtotal: 800, discount: 50, total: 750, error: null });
});

test('basketTotal with a percent discount', () => {
  const basket = b.addLine([], { ...bouquetM, unit_price: 800 });
  assert.deepStrictEqual(b.basketTotal(basket, { type: 'percentage', value: 10 }), { subtotal: 800, discount: 80, total: 720, error: null });
});

test('basketTotal mirrors the server: % off the GST-inclusive price (10% off ₹1000 at 18% = ₹900)', () => {
  const basket = b.addLine([], { product_id: 9, option_id: null, name: 'Vase', unit_price: 1000, price_mode: 'fixed', tax_rate: 18 });
  assert.deepStrictEqual(b.basketTotal(basket, null), { subtotal: 1000, discount: 0, total: 1000, error: null });
  assert.deepStrictEqual(b.basketTotal(basket, { type: 'percentage', value: 10 }), { subtotal: 1000, discount: 100, total: 900, error: null });
  // A rupee discount comes straight off
  assert.deepStrictEqual(b.basketTotal(basket, { type: 'fixed', value: 100 }), { subtotal: 1000, discount: 100, total: 900, error: null });
});

test('basketTotal mixed tax lines, 15% off (same order of sums as the server)', () => {
  let basket = [];
  basket = b.addLine(basket, { product_id: 9, option_id: null, name: 'Vase', unit_price: 499, price_mode: 'fixed', tax_rate: 12 });
  basket = b.addLine(basket, { product_id: 1, option_id: null, name: 'Rose', unit_price: 30, price_mode: 'fixed', tax_rate: 0 });
  basket = b.changeQty(basket, basket[0].key, 6); // 7 roses
  // Items 210 + 499 = 709 (GST included); 15% of 709 = 106.35 -> 602.65
  const t = b.basketTotal(basket, { type: 'percentage', value: 15 });
  assert.strictEqual(t.total, 602.65);
  assert.strictEqual(t.subtotal, 709);
  assert.strictEqual(t.discount, 106.35);
});

test('basketTotal refuses a rupee discount over the price, like the server', () => {
  const basket = b.addLine([], { product_id: 9, option_id: null, name: 'Vase', unit_price: 1000, price_mode: 'fixed', tax_rate: 18 });
  assert.strictEqual(b.basketTotal(basket, { type: 'fixed', value: 900 }).error, null);
  const t = b.basketTotal(basket, { type: 'fixed', value: 1001 });
  assert.strictEqual(t.error, "The discount can't be more than the price.");
  const p = b.basketTotal(basket, { type: 'percentage', value: 120 });
  assert.strictEqual(p.error, "The discount can't be more than the price.");
});

test('toSalePayload: option_id, typed price only for open lines, client_ref, payments', () => {
  let basket = [];
  basket = b.addLine(basket, rose);
  basket = b.addLine(basket, bouquetM);
  basket = b.addLine(basket, custom(500));
  const p = b.toSalePayload(basket, {
    locationId: 4,
    payments: [{ method: 'upi', amount: 1180, reference: ' 12345 ' }],
    clientRef: 'hb_abc-123',
  });
  assert.deepStrictEqual(p, {
    location_id: 4,
    client_ref: 'hb_abc-123',
    items: [
      { product_id: 3, quantity: 1, unit_price: 500 },
      { product_id: 2, option_id: 21, quantity: 1 },
      { product_id: 1, quantity: 1 },
    ],
    payments: [{ method: 'upi', amount: 1180, reference_number: '12345' }],
  });
});

test('toSalePayload: discount and override', () => {
  const basket = b.addLine([], { ...bouquetM, unit_price: 800 });
  const p = b.toSalePayload(basket, {
    locationId: 4,
    payments: [{ method: 'cash', amount: 400 }, { method: 'upi', amount: 320 }],
    discount: { type: 'percentage', value: 10 },
    override: { employee_code: '1001', pin: '1234' },
    clientRef: 'hb_x',
  });
  assert.strictEqual(p.discount_type, 'percentage');
  assert.strictEqual(p.discount_value, 10);
  assert.deepStrictEqual(p.discount_override, { employee_code: '1001', pin: '1234' });
  assert.deepStrictEqual(p.payments, [{ method: 'cash', amount: 400 }, { method: 'upi', amount: 320 }]);
  const plain = b.toSalePayload(basket, { locationId: 4, payments: [{ method: 'cash', amount: 800 }], discount: null, clientRef: 'hb_x' });
  assert.ok(!('discount_type' in plain));
  assert.ok(!('discount_override' in plain));
});

test('changeDue', () => {
  assert.strictEqual(b.changeDue(800, 1000), 200);
  assert.strictEqual(b.changeDue(915.25, 1000), 84.75);
  assert.strictEqual(b.changeDue(800, 800), 0);
  assert.strictEqual(b.changeDue(800, 500), -300);
  assert.strictEqual(b.changeDue(800, '1,000'), 200);
  assert.strictEqual(b.changeDue(800, ''), null);
  assert.strictEqual(b.changeDue(800, 'abc'), null);
});

test('splitPayments: cash part + the rest by UPI', () => {
  assert.deepStrictEqual(b.splitPayments(915.25, '500'), {
    error: null,
    payments: [{ method: 'cash', amount: 500 }, { method: 'upi', amount: 415.25 }],
  });
  assert.ok(b.splitPayments(800, '').error);
  assert.ok(b.splitPayments(800, '800').error, 'all cash is not a split');
  assert.ok(b.splitPayments(800, '900').error);
});

test('maskAmount keeps the first digit and the grouping', () => {
  assert.strictEqual(b.maskAmount(5432), '₹5,xxx');
  assert.strictEqual(b.maskAmount(845), '₹8xx');
  assert.strictEqual(b.maskAmount(100), '₹1xx');
  assert.strictEqual(b.maskAmount(45), '₹xx');
  assert.strictEqual(b.maskAmount(99.5), '₹xx');
  assert.strictEqual(b.maskAmount(5), '₹x');
  assert.strictEqual(b.maskAmount(0), '₹x');
  assert.strictEqual(b.maskAmount(123456), '₹1,xx,xxx');
  assert.strictEqual(b.maskAmount(5432.75), '₹5,xxx');
});

test('newClientRef is server-safe and different each time', () => {
  const a = b.newClientRef();
  const c = b.newClientRef();
  assert.ok(/^[A-Za-z0-9_-]{1,64}$/.test(a), a);
  assert.notStrictEqual(a, c);
});

// ─── Fix round 1: duplicate answer vs basket, stale prices ───
const saleItem = (product_id, product_name, quantity) => ({ product_id, product_name, quantity });

test('compareSaved: same items and quantities is the same sale', () => {
  let basket = b.addLine([], rose);
  basket = b.addLine(basket, bouquetM);
  basket = b.changeQty(basket, basket[1].key, 2); // 3 roses
  const r = b.compareSaved(basket, [saleItem(1, 'Rose (stem)', 3), saleItem(2, 'Bouquet (Medium)', 1)]);
  assert.strictEqual(r.same, true);
  assert.deepStrictEqual(r.leftover, []);
});

test('compareSaved: extra items in the basket are left over, with a fresh line each', () => {
  let basket = b.addLine([], rose);
  basket = b.changeQty(basket, basket[0].key, 4); // 5 roses
  basket = b.addLine(basket, bouquetL);
  const r = b.compareSaved(basket, [saleItem(1, 'Rose (stem)', 2)]);
  assert.strictEqual(r.same, false);
  assert.deepStrictEqual(r.leftover.map((l) => [l.name, l.qty]), [['Bouquet (Large)', 1], ['Rose (stem)', 3]]);
});

test('compareSaved: a different size counts as a different item', () => {
  const basket = b.addLine([], bouquetL);
  const r = b.compareSaved(basket, [saleItem(2, 'Bouquet (Medium)', 1)]);
  assert.strictEqual(r.same, false);
  assert.deepStrictEqual(r.leftover.map((l) => l.name), ['Bouquet (Large)']);
});

test('compareSaved: saved sale had more than the basket -> different, nothing left over', () => {
  const basket = b.addLine([], rose);
  const r = b.compareSaved(basket, [saleItem(1, 'Rose (stem)', 2)]);
  assert.strictEqual(r.same, false);
  assert.deepStrictEqual(r.leftover, []);
});

test('compareSaved: two typed prices of one product share the saved quantity in order', () => {
  let basket = b.addLine([], custom(500));
  basket = b.addLine(basket, custom(700));
  const r = b.compareSaved(basket, [saleItem(3, 'Arrangement', 1)]);
  assert.strictEqual(r.same, false);
  assert.strictEqual(r.leftover.length, 1);
});

const product = (over) => ({ id: 1, name: 'Rose (stem)', selling_price: 30, price_mode: 'fixed', tax_percentage: '0.00', options: [], ...over });

test('refreshPrices: a changed fixed price is updated and reported', () => {
  let basket = b.addLine([], rose);
  basket = b.changeQty(basket, basket[0].key, 1);
  const r = b.refreshPrices(basket, { 1: product({ selling_price: 35 }) });
  assert.strictEqual(r.basket[0].unit_price, 35);
  assert.strictEqual(r.basket[0].qty, 2);
  assert.deepStrictEqual(r.changes, [{ name: 'Rose (stem)', price: 35 }]);
  assert.deepStrictEqual(r.blocked, []);
  assert.strictEqual(b.basketTotal(r.basket, null).total, 70);
});

test('refreshPrices: option price, tax rate, typed price kept', () => {
  let basket = b.addLine([], bouquetM);
  basket = b.addLine(basket, custom(500));
  const r = b.refreshPrices(basket, {
    2: product({ id: 2, name: 'Bouquet', selling_price: 400, tax_percentage: '5.00', options: [{ id: 21, label: 'Medium', price: '700.00' }] }),
    3: product({ id: 3, name: 'Arrangement', selling_price: 0, price_mode: 'open' }),
  });
  const m = r.basket.find((l) => l.product_id === 2);
  assert.strictEqual(m.unit_price, 700);
  assert.strictEqual(m.tax_rate, 5);
  assert.strictEqual(r.basket.find((l) => l.product_id === 3).unit_price, 500);
  assert.deepStrictEqual(r.changes, [{ name: 'Bouquet (Medium)', price: 700 }]);
});

test('refreshPrices: unchanged prices report nothing', () => {
  const basket = b.addLine([], rose);
  const r = b.refreshPrices(basket, { 1: product({}) });
  assert.deepStrictEqual(r.changes, []);
  assert.strictEqual(r.basket[0].tax_rate, 0);
});

test('refreshPrices: gone product or removed size blocks that line; unknown keeps it', () => {
  let basket = b.addLine([], rose);
  basket = b.addLine(basket, bouquetM);
  basket = b.addLine(basket, { product_id: 7, option_id: null, name: 'Card', unit_price: 50, price_mode: 'fixed', tax_rate: 0 });
  const r = b.refreshPrices(basket, {
    1: null, // 404 / switched off
    2: product({ id: 2, name: 'Bouquet', options: [{ id: 22, label: 'Large', price: 900 }] }), // Medium gone
    // 7: not loaded (network) -> left as it was
  });
  assert.strictEqual(r.basket.find((l) => l.product_id === 1).unavailable, true);
  assert.strictEqual(r.basket.find((l) => l.product_id === 2).unavailable, true);
  assert.ok(!r.basket.find((l) => l.product_id === 7).unavailable);
  assert.strictEqual(r.blocked.length, 2);
  // fixed again later -> the mark goes
  const again = b.refreshPrices(r.basket, { 1: product({}) });
  assert.ok(!again.basket.find((l) => l.product_id === 1).unavailable);
});

test('refreshPrices: a new price that equals another line merges them', () => {
  let basket = b.addLine([], { ...rose, unit_price: 30 });
  basket = b.addLine(basket, { ...rose, unit_price: 35 }); // an older line at 35 (e.g. restored)
  const r = b.refreshPrices(basket, { 1: product({ selling_price: 35 }) });
  assert.strictEqual(r.basket.length, 1);
  assert.strictEqual(r.basket[0].qty, 2);
});

test('refreshPrices: open -> fixed uses the catalog price, not the old typed one', () => {
  const basket = b.addLine([], custom(500));
  const r = b.refreshPrices(basket, { 3: product({ id: 3, name: 'Arrangement', selling_price: 650, price_mode: 'fixed' }) });
  const l = r.basket[0];
  assert.strictEqual(l.unit_price, 650);
  assert.strictEqual(l.price_mode, 'fixed');
  assert.ok(!l.unavailable);
  assert.deepStrictEqual(r.blocked, []);
  // the payload no longer sends a typed price
  assert.strictEqual(b.toSalePayload(r.basket, { locationId: 1, payments: [], clientRef: 'x' }).items[0].unit_price, undefined);
});

test('refreshPrices: fixed -> open blocks the line with pick-again text', () => {
  const basket = b.addLine([], rose);
  const r = b.refreshPrices(basket, { 1: product({ price_mode: 'open' }) });
  const l = r.basket[0];
  assert.strictEqual(l.unavailable, true);
  assert.strictEqual(l.repick, true);
  assert.strictEqual(l.price_mode, 'open');
  assert.strictEqual(l.blocked_text, 'Scan or pick Rose (stem) again — its price has changed.');
  assert.deepStrictEqual(r.blocked, [l.key]);
  assert.strictEqual(b.basketCount(b.changeQty(r.basket, l.key, -l.qty)), 0); // one-tap Remove
});

test('refreshPrices: sizes added to a plain product blocks the line', () => {
  const basket = b.addLine([], rose);
  const r = b.refreshPrices(basket, { 1: product({ options: [{ id: 31, label: 'Bunch of 10', price: 280 }] }) });
  assert.strictEqual(r.basket[0].unavailable, true);
  assert.strictEqual(r.basket[0].repick, true);
  assert.strictEqual(r.blocked.length, 1);
  // product back to plain -> the mark goes
  const again = b.refreshPrices(r.basket, { 1: product({}) });
  assert.ok(!again.basket[0].unavailable && !again.basket[0].repick && !again.basket[0].blocked_text);
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log('PASS', t.name); } catch (e) { failed++; console.log('FAIL', t.name, '-', e.message); }
  }
  console.log(`${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
