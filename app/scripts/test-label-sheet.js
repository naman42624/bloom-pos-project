// Plain-node tests for src/utils/labelSheetHtml.js. Run: node scripts/test-label-sheet.js
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

const { buildLabelSheetHtml } = loadModule(path.join(__dirname, '../src/utils/labelSheetHtml.js'));
const date = new Date(2026, 10, 3);
const item = (o = {}) => ({ name: 'Rose', price: 120, price_mode: 'fixed', qr_data_url: 'data:image/png;base64,AAA', count: 1, ...o });
const count = (s, re) => (s.match(re) || []).length;
const tests = [];
const test = (n, f) => tests.push({ n, f });

test('30 stickers make 2 pages, 24 per page', () => {
  const h = buildLabelSheetHtml({ layout: 'stickers', items: [item({ count: 30 })], showPrice: false, date });
  assert.strictEqual(count(h, /<div class="page">/g), 2);
  assert.strictEqual(count(h, /<div class="cell">/g), 30);
  const first = h.split('<div class="page">')[1];
  assert.strictEqual(count(first, /<div class="cell">/g), 24);
});
test('price hidden by default', () => {
  const h = buildLabelSheetHtml({ layout: 'stickers', items: [item()], date });
  assert.ok(!h.includes('120.00'));
  assert.ok(!h.includes('price on'));
});
test('price shown with date line when on', () => {
  const h = buildLabelSheetHtml({ layout: 'stickers', items: [item()], showPrice: true, date });
  assert.ok(h.includes('₹120.00'));
  assert.ok(h.includes('price on 3 Nov 2026'));
});
test('open price shows hint, not a number', () => {
  const h = buildLabelSheetHtml({ layout: 'stickers', items: [item({ price_mode: 'open', price_hint: 'Ask at counter' })], showPrice: true, date });
  assert.ok(h.includes('Ask at counter'));
  assert.ok(!h.includes('120.00'));
});
test('bucket layout 6 per page', () => {
  const h = buildLabelSheetHtml({ layout: 'bucket', items: [item({ count: 7 })], date });
  assert.strictEqual(count(h, /<div class="page">/g), 2);
  assert.strictEqual(count(h.split('<div class="page">')[1], /<div class="cell">/g), 6);
});
test('names are HTML-escaped', () => {
  const h = buildLabelSheetHtml({ layout: 'stickers', items: [item({ name: '<b>&' })], date });
  assert.ok(h.includes('&lt;b&gt;&amp;'));
  assert.ok(!h.includes('<b>&<'));
});

let failed = 0;
for (const t of tests) {
  try { t.f(); console.log('PASS', t.n); } catch (e) { failed++; console.log('FAIL', t.n, e.message); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
