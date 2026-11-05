// Plain-node tests for src/utils/productTag.js. Run: node scripts/test-quick-tag.js
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

const { quickTagProblem, parsePrice, printProductTag, QUICK_TAG_MAX } = loadModule(path.join(__dirname, '../src/utils/productTag.js'));
const row = { product_id: 7, name: 'Red rose bunch', price: 750, price_mode: 'fixed', qr_data_url: 'data:image/png;base64,AAA', url: 'https://shop.example.com/p/ABCDEFGH', label_code: 'ABCDEFGH' };

function fakeApi(over = {}) {
  const calls = [];
  return {
    calls,
    api: {
      markProductOneOff: async (id) => { calls.push(['oneOff', id]); if (over.oneOff) throw over.oneOff; },
      getLabels: async (ids) => { calls.push(['labels', ids]); if (over.labels) throw over.labels; return { data: over.rows || [row] }; },
    },
  };
}
const printer = () => { const out = []; return { out, printHtml: async (html, title) => out.push({ html, title }) }; };
const cells = (h) => (h.match(/<div class="cell">/g) || []).length;

const tests = [];
const test = (n, f) => tests.push({ n, f });

test('empty name is refused with what to type', () => {
  assert.match(quickTagProblem({ name: '  ', price: '100', qty: 1 }), /Type what the item is/);
});
test('zero, blank or junk price is refused', () => {
  for (const price of ['', '0', 'abc', '-5']) assert.match(quickTagProblem({ name: 'Rose', price, qty: 1 }), /price/);
});
test('qty must be 1 to the max', () => {
  assert.match(quickTagProblem({ name: 'Rose', price: '10', qty: 0 }), /how many/);
  assert.match(quickTagProblem({ name: 'Rose', price: '10', qty: QUICK_TAG_MAX + 1 }), /up to 48/);
  assert.strictEqual(quickTagProblem({ name: 'Rose', price: '10', qty: QUICK_TAG_MAX }), '');
});
test('good form has no problem; price with commas parses', () => {
  assert.strictEqual(quickTagProblem({ name: 'Rose', price: '1,250.50', qty: 1 }), '');
  assert.strictEqual(parsePrice('1,250.505'), 1250.51);
  assert.strictEqual(parsePrice('750'), 750);
});
test('one tag marks the item one-off and prints one card', async () => {
  const f = fakeApi(); const p = printer();
  await printProductTag({ api: f.api, printHtml: p.printHtml }, { productId: 7, qty: 1 });
  assert.deepStrictEqual(f.calls, [['oneOff', 7], ['labels', [7]]]);
  assert.strictEqual(p.out.length, 1);
  assert.strictEqual(p.out[0].title, 'Tag');
  assert.strictEqual(cells(p.out[0].html), 1);
});
test('several tags: no one-off, one label per piece', async () => {
  const f = fakeApi(); const p = printer();
  await printProductTag({ api: f.api, printHtml: p.printHtml }, { productId: 7, qty: 5, layout: 'stickers' });
  assert.deepStrictEqual(f.calls, [['labels', [7]]]);
  assert.strictEqual(p.out[0].title, 'Labels');
  assert.strictEqual(cells(p.out[0].html), 5);
});
test('price shown on the tag when asked', async () => {
  const f = fakeApi(); const p = printer();
  await printProductTag({ api: f.api, printHtml: p.printHtml }, { productId: 7, qty: 1, showPrice: true });
  assert.ok(p.out[0].html.includes('₹750'));
});
test('server 409 (no web address set) message is passed through as is', async () => {
  const f = fakeApi({ labels: Object.assign(new Error('Labels cannot be printed yet. Ask the owner to set the shop web address.'), { status: 409 }) });
  const p = printer();
  await assert.rejects(printProductTag({ api: f.api, printHtml: p.printHtml }, { productId: 7, qty: 2 }), /Ask the owner to set the shop web address/);
  assert.strictEqual(p.out.length, 0);
});
test('network failure says what to tap, using the button name', async () => {
  const f = fakeApi({ labels: new Error('fetch failed') });
  await assert.rejects(printProductTag({ api: f.api, printHtml: printer().printHtml }, { productId: 7, qty: 2, retry: 'Print 2 tags again' }), /tap "Print 2 tags again" to try again\./);
  const g = fakeApi({ oneOff: new Error('fetch failed') });
  await assert.rejects(printProductTag({ api: g.api, printHtml: printer().printHtml }, { productId: 7, qty: 1, retry: 'Print tag' }), /tap "Print tag" to try again\./);
});
test('403 on one-off keeps the server message', async () => {
  const f = fakeApi({ oneOff: Object.assign(new Error('Only custom-made items can be tagged here.'), { status: 403 }) });
  await assert.rejects(printProductTag({ api: f.api, printHtml: printer().printHtml }, { productId: 7, qty: 1 }), /Only custom-made items/);
});
test('no label rows: refresh message, nothing printed', async () => {
  const f = fakeApi({ rows: [] }); const p = printer();
  await assert.rejects(printProductTag({ api: f.api, printHtml: p.printHtml }, { productId: 7, qty: 1 }), /could not be found/);
  assert.strictEqual(p.out.length, 0);
});

(async () => {
  let pass = 0;
  for (const t of tests) {
    try { await t.f(); pass += 1; console.log(`  ok  ${t.n}`); } catch (e) { console.log(`  FAIL ${t.n}\n       ${e.message}`); }
  }
  console.log(`\n${pass}/${tests.length} passed`);
  process.exit(pass === tests.length ? 0 : 1);
})();
