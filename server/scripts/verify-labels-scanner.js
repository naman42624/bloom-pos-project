#!/usr/bin/env node
/**
 * Live verification of product label codes, options and the labels endpoint.
 * Local dev only.
 */
const h = require('./lib/verify-harness');
const { ALPHABET, ensureLabelCode, generateLabelCode, labelUrl } = require('../utils/label-code');
const { check, api, loginOwner, assert, getDb } = h;

const createdProductIds = [];

async function makeProduct(name, price = 100) {
  const db = await getDb();
  const r = await db.prepare('INSERT INTO products (name, selling_price, is_active) VALUES (?, ?, 1)')
    .run(`${name} ${Date.now()}${Math.floor(Math.random() * 1000)}`, price);
  createdProductIds.push(r.lastInsertRowid);
  return r.lastInsertRowid;
}

check('ensureLabelCode is stable', async () => {
  const db = await getDb();
  const id = await makeProduct('LblStable');
  const a = await ensureLabelCode(db, id);
  const b = await ensureLabelCode(db, id);
  assert(a === b && a.length === 8, `a=${a} b=${b}`);
});

check('codes use only the alphabet', async () => {
  const db = await getDb();
  for (let i = 0; i < 20; i++) {
    const id = await makeProduct('LblAlpha');
    const code = await ensureLabelCode(db, id);
    assert(code.length === 8 && [...code].every((c) => ALPHABET.includes(c)), `bad code ${code}`);
  }
});

check('concurrent ensureLabelCode yields one code', async () => {
  const owner = await loginOwner();
  const id = await makeProduct('LblRace');
  const [r1, r2, r3] = await Promise.all([1, 2, 3].map(() => api('POST', '/products/labels', owner.token, { product_ids: [id] })));
  const codes = [r1, r2, r3].map((r) => r.body?.data?.[0]?.label_code);
  assert(codes[0] && codes.every((c) => c === codes[0]), `codes: ${codes}`);
  const db = await getDb();
  const row = await db.prepare('SELECT label_code FROM products WHERE id = ?').get(id);
  assert(row.label_code === codes[0], 'stored code differs');
});

check('code clash retries', async () => {
  const db = await getDb();
  const a = await makeProduct('LblClashA');
  const b = await makeProduct('LblClashB');
  const codeA = await ensureLabelCode(db, a);
  let n = 0;
  const gen = () => (n++ === 0 ? codeA : generateLabelCode());
  const codeB = await ensureLabelCode(db, b, gen);
  assert(n === 2, `generator called ${n} times`);
  assert(codeB !== codeA && codeB.length === 8, `codeB ${codeB}`);
  const rowA = await db.prepare('SELECT label_code FROM products WHERE id = ?').get(a);
  assert(rowA.label_code === codeA, 'A changed');
});

check('create route stores open price mode and hint', async () => {
  const owner = await loginOwner();
  const name = `LblCreate ${Date.now()}`;
  const { status, body } = await api('POST', '/products', owner.token, { name, selling_price: 0, price_mode: 'open', price_hint: 'Ask staff' });
  assert(status === 201, `status ${status}: ${JSON.stringify(body)}`);
  createdProductIds.push(body.data.id);
  const db = await getDb();
  const row = await db.prepare('SELECT price_mode, price_hint FROM products WHERE id = ?').get(body.data.id);
  assert(row.price_mode === 'open' && row.price_hint === 'Ask staff', JSON.stringify(row));
});

check('labels endpoint returns url and qr', async () => {
  const owner = await loginOwner();
  const id = await makeProduct('LblEndpoint', 250);
  const { status, body } = await api('POST', '/products/labels', owner.token, { product_ids: [id] });
  assert(status === 200, `status ${status}`);
  const d = body.data[0];
  assert(d.product_id === id && d.price === 250 && d.price_mode === 'fixed', JSON.stringify(d));
  assert(d.url === labelUrl(d.label_code) && d.url.endsWith(`/p/${d.label_code}`), d.url);
  assert(d.qr_data_url.startsWith('data:image/png;base64,'), 'qr');
  const bad = await api('POST', '/products/labels', owner.token, { product_ids: [] });
  assert(bad.status === 400, `empty ids -> ${bad.status}`);
});

check('options replace and validate', async () => {
  const owner = await loginOwner();
  const id = await makeProduct('LblOpts');
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ label: `S${i}`, price: 10 + i }));
  const seven = await api('PUT', `/products/${id}/options`, owner.token, { options: mk(7) });
  assert(seven.status === 400, `7 options -> ${seven.status}`);
  const zero = await api('PUT', `/products/${id}/options`, owner.token, { options: [{ label: 'X', price: 0 }] });
  assert(zero.status === 400, `price 0 -> ${zero.status}`);
  const ok = await api('PUT', `/products/${id}/options`, owner.token, { options: mk(3) });
  assert(ok.status === 200 && ok.body.data.length === 3, JSON.stringify(ok.body));
  const again = await api('PUT', `/products/${id}/options`, owner.token, { options: mk(2) });
  assert(again.body.data.length === 2, 'replace');
  const got = await api('GET', `/products/${id}`, owner.token);
  assert(got.body.data.options.length === 2, 'GET options');
});

check('price_mode open saved', async () => {
  const owner = await loginOwner();
  const id = await makeProduct('LblOpen');
  const put = await api('PUT', `/products/${id}`, owner.token, { price_mode: 'open', price_hint: 'Ask for size', is_one_off: 1 });
  assert(put.status === 200 && put.body.data.price_mode === 'open', JSON.stringify(put.body));
  const db = await getDb();
  const row = await db.prepare('SELECT price_mode, price_hint, is_one_off FROM products WHERE id = ?').get(id);
  assert(row.price_mode === 'open' && row.price_hint === 'Ask for size' && Number(row.is_one_off) === 1, JSON.stringify(row));
  const bad = await api('PUT', `/products/${id}`, owner.token, { price_mode: 'weird' });
  assert(bad.status === 400, `bad mode -> ${bad.status}`);
});

async function cleanup() {
  const db = await getDb();
  for (const id of createdProductIds) {
    try {
      await db.prepare('DELETE FROM product_options WHERE product_id = ?').run(id);
      await db.prepare('DELETE FROM products WHERE id = ?').run(id);
    } catch (err) { console.error(`   (cleanup warning: product ${id}: ${err.message})`); }
  }
  console.log(`Cleaned up ${createdProductIds.length} test product(s)`);
}

h.run({ cleanup });
