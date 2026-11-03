// Plain-node checks for the browser scanner. Run: node scripts/test-scanner-decode.js
//  (a) builds a QR for a label URL with the server's own `qrcode` package and
//      paints its module matrix into an RGBA buffer (no PNG decoder needed)
//  (b) decodes it with jsQR - the fallback decoder ProductScanner.js uses
//  (c) unit-tests the same-code cooldown shared by the web and native scanners
const assert = require('assert');
const path = require('path');
const Module = require('module');
const babel = require('@babel/core');
const jsQR = require('jsqr');
const QRCode = require(path.join(__dirname, '../../server/node_modules/qrcode'));

function loadModule(file) {
  const { code } = babel.transformFileSync(file, { presets: ['babel-preset-expo'], babelrc: false, configFile: false });
  const m = new Module(file, module);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(code, file);
  return m.exports;
}

const cd = loadModule(path.join(__dirname, '../src/components/scan/scanCooldown.js'));

// Paint a qrcode matrix as black-on-white RGBA, `scale` px per module, 4-module quiet zone.
function paint(text, { scale = 4, quiet = 4, invert = false } = {}) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const side = (n + quiet * 2) * scale;
  const data = new Uint8ClampedArray(side * side * 4);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const mr = Math.floor(y / scale) - quiet;
      const mc = Math.floor(x / scale) - quiet;
      const inside = mr >= 0 && mc >= 0 && mr < n && mc < n;
      let dark = inside && qr.modules.get(mr, mc);
      if (invert) dark = !dark;
      const v = dark ? 0 : 255;
      const i = (y * side + x) * 4;
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
  }
  return { data, width: side, height: side };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('jsqr is pinned to 1.4.0', () => {
  assert.strictEqual(require('jsqr/package.json').version, '1.4.0');
  assert.strictEqual(require('../package.json').dependencies.jsqr, '1.4.0');
});

test('jsQR decodes a new label URL', () => {
  const url = 'http://localhost:19006/p/ABCDEFGH';
  const img = paint(url);
  const found = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
  assert.ok(found, 'no QR found');
  assert.strictEqual(found.data, url);
});

test('jsQR decodes a legacy JSON label', () => {
  const legacy = JSON.stringify({ type: 'bloomcart_product', id: 42, name: 'Red Rose Bunch', sku: 'RR-12' });
  const img = paint(legacy, { scale: 3 });
  const found = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
  assert.ok(found, 'no QR found');
  assert.strictEqual(found.data, legacy);
});

test('jsQR finds nothing in a blank frame', () => {
  const side = 200;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  assert.strictEqual(jsQR(data, side, side, { inversionAttempts: 'dontInvert' }), null);
});

test('cooldown: same code within 1.5 s rejected', () => {
  let t = 1000;
  const c = cd.createScanCooldown(cd.SCAN_COOLDOWN_MS, () => t);
  assert.strictEqual(cd.SCAN_COOLDOWN_MS, 1500);
  assert.strictEqual(c.accept('A'), true);
  t += 1499;
  assert.strictEqual(c.accept('A'), false);
});

test('cooldown: different code accepted at once', () => {
  let t = 1000;
  const c = cd.createScanCooldown(1500, () => t);
  assert.strictEqual(c.accept('A'), true);
  t += 10;
  assert.strictEqual(c.accept('B'), true);
  t += 10;
  assert.strictEqual(c.accept('A'), true);
});

test('cooldown: same code after 1.5 s out of view accepted', () => {
  let t = 1000;
  const c = cd.createScanCooldown(1500, () => t);
  assert.strictEqual(c.accept('A'), true);
  t += 1500;
  assert.strictEqual(c.accept('A'), true);
});

test('cooldown: label held in view for 5 s is accepted once', () => {
  let t = 0;
  const c = cd.createScanCooldown(1500, () => t);
  let accepts = 0;
  for (t = 0; t <= 5000; t += 150) if (c.accept('A')) accepts += 1;
  assert.strictEqual(accepts, 1);
});

test('cooldown: hold() after a pause stops a re-report of the label still in view', () => {
  let t = 0;
  const c = cd.createScanCooldown(1500, () => t);
  assert.strictEqual(c.accept('A'), true);
  t = 3000; // camera was paused for a lookup, then restarted
  c.hold();
  t = 3200;
  assert.strictEqual(c.accept('A'), false);
  t = 3200 + 1500;
  assert.strictEqual(c.accept('A'), true);
});

test('cooldown: empty or non-string codes ignored', () => {
  const c = cd.createScanCooldown();
  assert.strictEqual(c.accept(''), false);
  assert.strictEqual(c.accept(null), false);
  assert.strictEqual(c.accept(undefined), false);
});

test('camera error mapping + exact blocked copy', () => {
  assert.strictEqual(cd.cameraErrorKind({ name: 'NotAllowedError' }), 'blocked');
  assert.strictEqual(cd.cameraErrorKind({ name: 'NotFoundError' }), 'noCamera');
  assert.strictEqual(cd.cameraErrorKind({ name: 'NotReadableError' }), 'busy');
  assert.strictEqual(cd.cameraErrorKind(new Error('x')), 'failed');
  assert.strictEqual(cd.SCANNER_COPY.blocked,
    'Camera is blocked. Tap the \u{1F512} next to the web address → Camera → Allow, then tap Try again.');
  assert.strictEqual(cd.SCANNER_COPY.noCamera, 'No camera found on this device. Use Find by name instead.');
});

let failed = 0;
for (const { name, fn } of tests) {
  try { fn(); console.log('PASS', name); } catch (e) { failed += 1; console.log('FAIL', name, '-', e.message); }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
