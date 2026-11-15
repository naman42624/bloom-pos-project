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

let failed = 0;
for (const t of tests) {
  try { t.fn(); console.log(`ok   ${t.name}`); } catch (e) { failed++; console.log(`FAIL ${t.name}: ${e.message}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
