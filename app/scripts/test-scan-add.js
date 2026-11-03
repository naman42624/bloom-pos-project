// Plain-node tests for src/utils/scanAddLine.js. Run: node scripts/test-scan-add.js
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

const {
  blankLine, buildScannedLine, mergeScannedLine, parseTypedPrice, productLineFields, readyQtyFor,
} = loadModule(path.join(__dirname, '../src/utils/scanAddLine.js'));

const rose = { id: 7, name: 'Rose', selling_price: 120, tax_percentage: 5, stock: [{ location_id: 4, quantity: 3 }], total_ready_qty: 3 };
const bouquet = { id: 9, name: 'Bouquet', selling_price: 500, tax_percentage: null, stock: [] };
const medium = { id: 21, label: 'Medium', price: 650 };
const large = { id: 22, label: 'Large', price: 900 };
const tests = [];
const test = (n, f) => tests.push({ n, f });

test('first scan into an empty order adds one line', () => {
  const r = mergeScannedLine([], buildScannedLine(rose, { locationId: 4 }));
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(r.result, 'added');
  assert.strictEqual(r.items[0].name, 'Rose');
  assert.strictEqual(r.items[0].price, '120');
  assert.strictEqual(r.items[0].quantity, '1');
  assert.strictEqual(r.items[0].tax_percentage, 5);
  assert.strictEqual(r.items[0].fulfill_from_stock, true);
});
test('same product scanned again -> quantity 2, still one line', () => {
  let items = mergeScannedLine([], buildScannedLine(rose)).items;
  const r = mergeScannedLine(items, buildScannedLine(rose));
  assert.strictEqual(r.result, 'merged');
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(r.items[0].quantity, '2');
  items = mergeScannedLine(r.items, buildScannedLine(rose)).items;
  assert.strictEqual(items[0].quantity, '3');
});
test('merge does not mutate the previous array', () => {
  const items = mergeScannedLine([], buildScannedLine(rose)).items;
  mergeScannedLine(items, buildScannedLine(rose));
  assert.strictEqual(items[0].quantity, '1');
});
test('same product + same option -> quantity +1', () => {
  let items = mergeScannedLine([], buildScannedLine(bouquet, { option: medium })).items;
  const r = mergeScannedLine(items, buildScannedLine(bouquet, { option: medium }));
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(r.items[0].quantity, '2');
  assert.strictEqual(r.items[0].name, 'Bouquet (Medium)');
  assert.strictEqual(r.items[0].price, '650');
  assert.strictEqual(r.items[0].option_label, 'Medium');
});
test('different option -> new line', () => {
  const items = mergeScannedLine([], buildScannedLine(bouquet, { option: medium })).items;
  const r = mergeScannedLine(items, buildScannedLine(bouquet, { option: large }));
  assert.strictEqual(r.result, 'added');
  assert.strictEqual(r.items.length, 2);
  assert.strictEqual(r.items[1].name, 'Bouquet (Large)');
  assert.strictEqual(r.items[1].price, '900');
});
test('only the newest line is merged into', () => {
  let items = mergeScannedLine([], buildScannedLine(rose)).items;
  items = mergeScannedLine(items, buildScannedLine(bouquet, { option: medium })).items;
  const r = mergeScannedLine(items, buildScannedLine(rose));
  assert.strictEqual(r.items.length, 3);
  assert.strictEqual(r.items[0].quantity, '1');
});
test('empty trailing blank line is replaced, not left above', () => {
  const items = [buildScannedLine(rose), blankLine()];
  const r = mergeScannedLine(items, buildScannedLine(bouquet, { option: medium }));
  assert.strictEqual(r.items.length, 2);
  assert.strictEqual(r.items[1].name, 'Bouquet (Medium)');
  assert.strictEqual(r.index, 1);
});
test('a blank line the person started typing in is kept', () => {
  const typed = { ...blankLine(), name: 'Custom wrap' };
  const r = mergeScannedLine([typed], buildScannedLine(rose));
  assert.strictEqual(r.items.length, 2);
  assert.strictEqual(r.items[0].name, 'Custom wrap');
});
test('open price: same typed price stacks, different price is a new line', () => {
  const open = { id: 30, name: 'Loose flowers', selling_price: 0, price_mode: 'open' };
  let items = mergeScannedLine([], buildScannedLine(open, { price: 80 })).items;
  assert.strictEqual(items[0].price, '80');
  items = mergeScannedLine(items, buildScannedLine(open, { price: 80 })).items;
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].quantity, '2');
  items = mergeScannedLine(items, buildScannedLine(open, { price: 150 })).items;
  assert.strictEqual(items.length, 2);
});
test('one-off already in the order is not added twice', () => {
  const tag = { id: 40, name: 'Red box', selling_price: 1500, is_one_off: 1 };
  const items = mergeScannedLine([], buildScannedLine(tag)).items;
  const r = mergeScannedLine(items, buildScannedLine(tag));
  assert.strictEqual(r.result, 'already_in_order');
  assert.strictEqual(r.items, items);
  assert.strictEqual(r.items[0].quantity, '1');
});
test('picker fields match the scanned line fields', () => {
  const listRow = { id: 7, name: 'Rose', selling_price: 120, tax_percentage: 5, ready_qty: 0 };
  const f = productLineFields(listRow, { materials: [] });
  assert.deepStrictEqual(Object.keys(f).sort(), ['baseMaterial', 'baseProduct', 'fulfill_from_stock', 'materials', 'name', 'price', 'tax_percentage', 'tax_rate'].sort());
  assert.strictEqual(f.fulfill_from_stock, false);
  assert.ok(!('materials' in productLineFields(listRow)));
});
test('ready qty: list row, full row by location, full row without location', () => {
  assert.strictEqual(readyQtyFor({ ready_qty: 2 }), 2);
  assert.strictEqual(readyQtyFor(rose, 4), 3);
  assert.strictEqual(readyQtyFor(rose, 5), 0);
  assert.strictEqual(readyQtyFor(rose, null), 3);
});
test('typed price must be more than 0', () => {
  assert.strictEqual(parseTypedPrice('250'), 250);
  assert.strictEqual(parseTypedPrice('₹1,250.50'), 1250.5);
  assert.strictEqual(parseTypedPrice('0'), null);
  assert.strictEqual(parseTypedPrice(''), null);
  assert.strictEqual(parseTypedPrice('-5'), null);
  assert.strictEqual(parseTypedPrice('abc'), null);
});

let failed = 0;
for (const t of tests) {
  try { t.f(); console.log(`PASS ${t.n}`); } catch (e) { failed += 1; console.log(`FAIL ${t.n}\n  ${e.message}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
