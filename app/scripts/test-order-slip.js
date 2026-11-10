// Plain-node tests for the order slip's money block (src/utils/printHelpers.js).
// Run: node scripts/test-order-slip.js
// A delivery challan travels with the order and the recipient signs it, so it
// must never show what the sender paid (2026-11-10).
const assert = require('assert');
const path = require('path');
const Module = require('module');
const babel = require('@babel/core');

// The slip builder is pure. Its src imports are compiled with babel here;
// native and print modules are stubbed.
const SRC = path.join(__dirname, '../src');
const cache = new Map();
const stubFor = (request) => {
  if (/^(react-native|expo|@expo|@react-native)/.test(request)) return { Platform: { OS: 'web' }, default: {} };
  if (/services\/api$/.test(request)) return { default: {} };
  if (/utils\/alert$/.test(request)) return { showAlert() {}, default: {} };
  return null;
};

function loadModule(file) {
  if (cache.has(file)) return cache.get(file).exports;
  const { code } = babel.transformFileSync(file, { presets: ['babel-preset-expo'], babelrc: false, configFile: false });
  const m = new Module(file, module);
  cache.set(file, m);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  m.require = (request) => {
    const stub = stubFor(request);
    if (stub) return stub;
    if (request.startsWith('.')) {
      const resolved = require.resolve(path.resolve(path.dirname(file), request));
      if (resolved.startsWith(SRC)) return loadModule(resolved);
    }
    return require(request);
  };
  m._compile(code, file);
  return m.exports;
}

const slip = loadModule(path.join(__dirname, '../src/utils/printHelpers.js'));
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const base = {
  sale_number: 'INV-1', created_at: '2026-11-10 10:00:00', grand_total: 1250,
  items: [{ product_name: 'Red roses', quantity: 2 }],
  receiver_name: 'Asha', delivery_address: '1 Test Road',
};
const shopCopy = (html) => html.split('Customer Copy')[0];

test('paid delivery: no amounts anywhere', () => {
  const html = slip.buildOrderSlipHtml({ ...base, order_type: 'delivery', payments: [{ method: 'upi', amount: 1250 }] });
  assert.ok(!html.includes('1,250'), 'total must not print');
  assert.ok(!/PAID IN FULL/.test(html));
  assert.ok(shopCopy(html).includes('Nothing to collect'));
});

test('credit delivery: no amounts anywhere', () => {
  const html = slip.buildOrderSlipHtml({ ...base, order_type: 'delivery', is_credit_sale: 1, payments: [{ method: 'cash', amount: 250 }] });
  assert.ok(!html.includes('1,250') && !html.includes('₹1,000') && !html.includes('₹250'));
  assert.ok(shopCopy(html).includes('DO NOT COLLECT'));
});

test('part-paid delivery: only the amount to collect', () => {
  const html = slip.buildOrderSlipHtml({ ...base, order_type: 'delivery', payments: [{ method: 'cash', amount: 250 }] });
  assert.ok(shopCopy(html).includes('COLLECT ON DELIVERY'));
  assert.ok(html.includes('₹1,000'), 'balance prints');
  assert.ok(!html.includes('1,250') && !html.includes('Paid ₹250'), 'total and paid do not print');
});

test('pre-order delivered: treated as a delivery', () => {
  const html = slip.buildOrderSlipHtml({ ...base, order_type: 'pre_order', delivery: { status: 'pending' }, payments: [{ method: 'upi', amount: 1250 }] });
  assert.ok(!html.includes('1,250'));
});

test('pickup slip unchanged: still shows total and paid', () => {
  const html = slip.buildOrderSlipHtml({ ...base, order_type: 'pickup', delivery_address: null, payments: [{ method: 'upi', amount: 1250 }] });
  assert.ok(html.includes('PAID IN FULL') && html.includes('₹1,250'));
});

let failed = 0;
for (const t of tests) {
  try { t.fn(); console.log('PASS', t.name); } catch (e) { failed++; console.log('FAIL', t.name, '-', e.message); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
