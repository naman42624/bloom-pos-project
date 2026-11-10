// Plain-node tests for src/utils/friendlyError.js (D45). Run: node scripts/test-friendly-error.js
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
const f = loadModule(path.join(__dirname, '../src/utils/friendlyError.js'));
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('no connection', () => assert.strictEqual(f.friendlyMessage({ status: 0, message: 'x' }), f.NETWORK_MESSAGE));
test('expired login', () => {
  assert.strictEqual(f.friendlyMessage({ status: 401, message: 'Invalid token.' }), f.LOGIN_ENDED_MESSAGE);
  assert.strictEqual(f.friendlyMessage({ status: 401, message: 'Token has expired. Please login again.' }), f.LOGIN_ENDED_MESSAGE);
});
test('plain 401 kept (wrong PIN, helper access ended)', () => {
  assert.strictEqual(f.friendlyMessage({ status: 401, message: 'Employee code not recognized.' }), 'Employee code not recognized.');
  assert.strictEqual(f.friendlyMessage({ status: 401, message: 'Your access ended on 4 Nov. Ask the owner if you need more days.' }), 'Your access ended on 4 Nov. Ask the owner if you need more days.');
});
test('no permission', () => assert.strictEqual(f.friendlyMessage({ status: 403, message: 'You do not have permission to perform this action.' }), f.NO_PERMISSION_MESSAGE));
test('plain 403 kept', () => assert.strictEqual(f.friendlyMessage({ status: 403, message: "This discount needs the counter's OK." }), "This discount needs the counter's OK."));
test('missing route = old app', () => assert.strictEqual(f.friendlyMessage({ status: 404, message: 'Route POST /api/quick-sale/9/undo not found' }), f.OLD_APP_MESSAGE));
test('plain 404 kept', () => assert.strictEqual(f.friendlyMessage({ status: 404, message: 'Sale not found' }), 'Sale not found'));
test('500 generic', () => {
  assert.strictEqual(f.friendlyMessage({ status: 500, message: 'Internal server error' }), f.SERVER_MESSAGE);
  assert.strictEqual(f.friendlyMessage({ status: 502, message: '' }), f.SERVER_MESSAGE);
});
test('500 with what failed keeps it and adds the next step', () => {
  const m = f.friendlyMessage({ status: 500, message: 'Failed to clock in.' });
  assert.ok(m.startsWith('Failed to clock in. Check whether it saved'), m);
});
test('database text never shown', () => {
  assert.strictEqual(f.friendlyMessage({ status: 400, message: 'null value in column "x" violates not-null constraint' }), f.SERVER_MESSAGE);
  assert.strictEqual(f.friendlyMessage({ status: 500, message: "Cannot read properties of undefined (reading 'id')" }), f.SERVER_MESSAGE);
});
test('validation: default text names the field', () => {
  const m = f.friendlyMessage({ status: 400, message: 'Validation failed', errors: [{ path: 'phone', msg: 'Invalid value' }] });
  assert.strictEqual(m, 'Check the phone number.');
});
test('validation: nested field', () => {
  const m = f.friendlyMessage({ status: 400, message: 'Validation failed', errors: [{ path: 'items[2].quantity', msg: 'Invalid value' }] });
  assert.strictEqual(m, 'Check the item quantity.');
});
test('validation: own message used, duplicates dropped, at most 3', () => {
  const errors = [
    { path: 'name', msg: 'Category name is required' },
    { path: 'name', msg: 'Category name is required' },
    { path: 'unit', msg: 'Invalid value' },
    { path: 'delivery_address', msg: 'Invalid value' },
    { path: 'pincode', msg: 'Invalid value' },
  ];
  const m = f.friendlyMessage({ status: 400, message: 'Validation failed', errors });
  assert.strictEqual(m, 'Category name is required.\nCheck the unit.\nCheck the delivery address.');
});
test('validation with no list', () => assert.ok(/Check the form/.test(f.friendlyMessage({ status: 400, message: 'Validation failed' }))));
test('unknown field turned into words', () => assert.strictEqual(f.fieldLabel('receiver_address_label'), 'receiver address label'));
test('rate limit', () => assert.strictEqual(f.friendlyMessage({ status: 429, message: '' }), f.TOO_MANY_MESSAGE));
test('ordinary 400 kept', () => assert.strictEqual(f.friendlyMessage({ status: 400, message: 'Write-off can be at most ₹10.' }), 'Write-off can be at most ₹10.'));

let failed = 0;
for (const t of tests) {
  try { t.fn(); } catch (e) { failed++; console.log('FAIL', t.name, '-', e.message); }
}
console.log(`${tests.length - failed}/${tests.length} checks passed`);
process.exit(failed ? 1 : 0);
