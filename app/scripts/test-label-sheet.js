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
  assert.ok(!h.includes('\u20B9120'));
  assert.ok(!h.includes('price on'));
});
test('price shown with date line when on', () => {
  const h = buildLabelSheetHtml({ layout: 'stickers', items: [item()], showPrice: true, date });
  assert.ok(h.includes('₹120'));
  assert.ok(h.includes('price on 3 Nov 2026'));
});
test('open price shows hint, not a number', () => {
  const h = buildLabelSheetHtml({ layout: 'stickers', items: [item({ price_mode: 'open', price_hint: 'Ask at counter' })], showPrice: true, date });
  assert.ok(h.includes('Ask at counter'));
  assert.ok(!h.includes('\u20B9120'));
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
test('price_card always shows prices, one row per product, ignores count', () => {
  const h = buildLabelSheetHtml({ layout: 'price_card', items: [item({ count: 5 }), item({ name: 'Open', price_mode: 'open' })], showPrice: false, date });
  assert.ok(h.includes('\u20B9120'));
  assert.ok(h.includes('Ask at the counter'));
  assert.strictEqual(count(h, /<div class="cell">/g), 2);
});
test('15 price card products make 2 pages', () => {
  const items = Array.from({ length: 15 }, (_, i) => item({ name: 'P' + i }));
  const h = buildLabelSheetHtml({ layout: 'price_card', items, date });
  assert.strictEqual(count(h, /<div class="page">/g), 2);
});
test('price_hint is HTML-escaped', () => {
  const h = buildLabelSheetHtml({ layout: 'stickers', items: [item({ price_mode: 'open', price_hint: '<i>&' })], showPrice: true, date });
  assert.ok(h.includes('&lt;i&gt;&amp;'));
});
test('fixed price 0 is treated as no price', () => {
  const h = buildLabelSheetHtml({ layout: 'stickers', items: [item({ price: 0 })], showPrice: true, date });
  assert.ok(!h.includes('0.00') && !h.includes('price on'));
});

test('rupees are grouped en-IN, whole rupees without decimals', () => {
  const h = buildLabelSheetHtml({ layout: 'stickers', items: [item({ price: 1250.5 }), item({ price: 99 })], showPrice: true, date });
  assert.ok(h.includes('\u20B91,250.50'));
  assert.ok(h.includes('\u20B999<'));
});

const sized = (o = {}) => item({ name: 'Bouquet', price: 500, options: [{ label: 'Small', price: 400 }, { label: 'Medium', price: 650 }, { label: 'Large', price: 900 }], ...o });
test('sized product sticker shows From cheapest when price is on', () => {
  const h = buildLabelSheetHtml({ layout: 'stickers', items: [sized({ options: [{ label: 'Large', price: 900 }, { label: 'Small', price: 400 }] })], showPrice: true, date });
  assert.ok(h.includes('From \u20B9400'));
  assert.ok(!h.includes('\u20B9500'));
});
test('sized product bucket shows From price, hidden when price is off', () => {
  const on = buildLabelSheetHtml({ layout: 'bucket', items: [sized()], showPrice: true, date });
  assert.ok(on.includes('From \u20B9400'));
  const off = buildLabelSheetHtml({ layout: 'bucket', items: [sized()], showPrice: false, date });
  assert.ok(!off.includes('From'));
});
test('sized product price card lists every size in order', () => {
  const h = buildLabelSheetHtml({ layout: 'price_card', items: [sized()], date });
  assert.ok(h.includes('Small \u20B9400 \u00B7 Medium \u20B9650 \u00B7 Large \u20B9900'));
  assert.ok(h.includes('class="price sizes"'));
});
test('size labels are HTML-escaped on the price card', () => {
  const h = buildLabelSheetHtml({ layout: 'price_card', items: [sized({ options: [{ label: '<x>', price: 10 }] })], date });
  assert.ok(h.includes('&lt;x&gt; \u20B910'));
});
test('sized open-price product shows sizes, not the hint', () => {
  const h = buildLabelSheetHtml({ layout: 'stickers', items: [sized({ price_mode: 'open', price_hint: 'Ask' })], showPrice: true, date });
  assert.ok(h.includes('From \u20B9400'));
  assert.ok(!h.includes('>Ask<'));
});
test('empty options behave like a plain product', () => {
  const h = buildLabelSheetHtml({ layout: 'stickers', items: [item({ options: [] })], showPrice: true, date });
  assert.ok(h.includes('\u20B9120') && !h.includes('From'));
});
test('label host is printed on stickers (own line without price, on date line with price)', () => {
  const it = item({ url: 'https://shop.example.com/p/ABCDEFG' });
  const off = buildLabelSheetHtml({ layout: 'stickers', items: [it], showPrice: false, date });
  assert.ok(off.includes('<div class="hostline">shop.example.com</div>'));
  const on = buildLabelSheetHtml({ layout: 'stickers', items: [it], showPrice: true, date });
  assert.ok(on.includes('price on 3 Nov 2026<span class="host"> \u00B7 shop.example.com</span>'));
});
test('url_host from the server wins, and shows on bucket and price card', () => {
  const it = item({ url: 'http://localhost:8081/p/X', url_host: 'petal.in' });
  assert.ok(buildLabelSheetHtml({ layout: 'bucket', items: [it], date }).includes('petal.in'));
  const card = buildLabelSheetHtml({ layout: 'price_card', items: [it], date });
  assert.ok(card.includes('<span class="host"> \u00B7 petal.in</span>'));
  assert.ok(!card.includes('localhost'));
});
test('no url means no host line', () => {
  const h = buildLabelSheetHtml({ layout: 'stickers', items: [item()], date });
  assert.ok(!h.includes('class="hostline"') && !h.includes('class="host"'));
});

let failed = 0;
for (const t of tests) {
  try { t.f(); console.log('PASS', t.n); } catch (e) { failed++; console.log('FAIL', t.n, e.message); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
