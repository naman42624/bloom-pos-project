// Plain-node tests for src/utils/orderRequestPrefill.js (D44). Run: node scripts/test-order-request-prefill.js
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
const f = loadModule(path.join(__dirname, '../src/utils/orderRequestPrefill.js'));
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('clock times only', () => {
  assert.strictEqual(f.clockTime('18:00'), '18:00');
  assert.strictEqual(f.clockTime('6:30'), '06:30');
  assert.strictEqual(f.clockTime('6:30 PM'), '18:30');
  assert.strictEqual(f.clockTime('12:15 am'), '00:15');
  assert.strictEqual(f.clockTime('12:00 PM'), '12:00');
  assert.strictEqual(f.clockTime('6:30 or later'), null); // B21: was let through before
  assert.strictEqual(f.clockTime('morning'), null);
  assert.strictEqual(f.clockTime('25:00'), null);
  assert.strictEqual(f.clockTime('13:00 PM'), null);
  assert.strictEqual(f.clockTime(''), null);
});

test('delivery request', () => {
  const v = f.requestToForm({
    id: 41, order_type: 'delivery', customer_id: 7, customer_name: 'Asha', customer_phone: '9000000001',
    recipient_name: 'Ravi', recipient_phone: '9000000002', delivery_address: '12 MG Road',
    message: 'Happy birthday', requested_date: '2026-11-08', requested_time: 'morning',
    items_json: [{ product_id: '5', quantity: 2, name: 'Rose bunch' }, { custom: true, description: 'Blue orchids', quantity: 1 }],
  });
  assert.strictEqual(v.orderType, 'delivery');
  assert.strictEqual(v.channel, 'website');
  assert.strictEqual(v.sourceOrderRequestId, 41);
  assert.deepStrictEqual(v.customer, { id: 7, name: 'Asha', phone: '9000000001' });
  assert.deepStrictEqual(v.receiver, { name: 'Ravi', phone: '9000000002' });
  assert.strictEqual(v.address, '12 MG Road');
  assert.strictEqual(v.cardMessage, 'Happy birthday');
  assert.strictEqual(v.scheduledDate, '2026-11-08');
  assert.strictEqual(v.scheduledTime, '');
  assert.strictEqual(v.notes, 'Requested time: morning');
  assert.deepStrictEqual(v.items, [
    { productId: 5, quantity: 2, name: 'Rose bunch' },
    { productId: null, quantity: 1, name: 'Blue orchids' },
  ]);
});

test('pickup request, for the customer themself, real time', () => {
  const v = f.requestToForm({
    id: 9, order_type: 'pickup', customer_phone: '9000000003', recipient_name: 'X', delivery_address: 'ignored',
    requested_date: '2026-11-09T00:00:00.000Z', requested_time: '5:15 pm', items_json: [{ product_id: 3 }],
  });
  assert.strictEqual(v.orderType, 'pickup');
  assert.strictEqual(v.receiver, null);
  assert.strictEqual(v.address, '');
  assert.strictEqual(v.scheduledDate, '2026-11-09');
  assert.strictEqual(v.scheduledTime, '17:15');
  assert.strictEqual(v.notes, '');
  assert.deepStrictEqual(v.items, [{ productId: 3, quantity: 1, name: null }]);
});

test('empty request does not crash', () => {
  const v = f.requestToForm(null);
  assert.strictEqual(v.orderType, 'pickup');
  assert.deepStrictEqual(v.items, []);
  assert.strictEqual(v.customer, null);
});

let passed = 0;
for (const t of tests) {
  try { t.fn(); passed += 1; } catch (e) { console.log(`FAIL ${t.name}: ${e.message}`); }
}
console.log(`${passed}/${tests.length} passed`);
if (passed !== tests.length) process.exit(1);
