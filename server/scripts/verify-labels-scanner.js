#!/usr/bin/env node
/**
 * Live verification of product label codes, options and the labels endpoint.
 * Local dev only.
 */
const h = require('./lib/verify-harness');
const { ALPHABET, ensureLabelCode, generateLabelCode, labelUrl } = require('../utils/label-code');
const { publicUrlMissingInProduction, publicUrlHost, DEV_FALLBACK, normalizeBaseUrl } = require('../utils/public-url');
const { check, api, loginOwner, assert, getDb, TEST_LOCATION_ID } = h;

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

const scan = (token, payload, location_id) => api('POST', '/products/scan', token, { payload, location_id });
const UNKNOWN = 'This isn\'t one of our product codes. Try Find by name.';

check('legacy json payload resolves', async () => {
  const owner = await loginOwner();
  const id = await makeProduct('ScanLegacy', 120);
  const r = await scan(owner.token, JSON.stringify({ type: 'bloomcart_product', id, name: 'x' }));
  assert(r.status === 200 && r.body.data.id === id && r.body.data.selling_price === 120, JSON.stringify(r.body));
});

check('url payload resolves', async () => {
  const owner = await loginOwner();
  const db = await getDb();
  const id = await makeProduct('ScanUrl');
  const code = await ensureLabelCode(db, id);
  const r = await scan(owner.token, labelUrl(code));
  assert(r.status === 200 && r.body.data.id === id, JSON.stringify(r.body));
  const other = await scan(owner.token, `https://example.org/p/${code}`);
  assert(other.status === 200 && other.body.data.id === id, 'any host with exact path');
});

check('url with a doubled slash resolves (PUBLIC_APP_URL ending in /)', async () => {
  const owner = await loginOwner();
  const db = await getDb();
  const id = await makeProduct('ScanSlash');
  const code = await ensureLabelCode(db, id);
  const r = await scan(owner.token, `https://shop.example.com//p/${code}`);
  assert(r.status === 200 && r.body.data.id === id, JSON.stringify(r.body));
});

check('url without https:// resolves (PUBLIC_APP_URL set without a scheme)', async () => {
  const owner = await loginOwner();
  const db = await getDb();
  const id = await makeProduct('ScanNoScheme');
  const code = await ensureLabelCode(db, id);
  for (const p of [`shop.example.com/p/${code}`, `shop.example.com//p/${code}/`, `www.shop.example.com:8080/p/${code.toLowerCase()}`]) {
    const r = await scan(owner.token, p);
    assert(r.status === 200 && r.body.data.id === id, `${p} -> ${r.status} ${JSON.stringify(r.body)}`);
  }
  for (const p of [`shop.example.com/x/p/${code}`, `p/${code}`, `/p/${code}`]) {
    const r = await scan(owner.token, p);
    assert(r.status === 400 && r.body.message === UNKNOWN, `${p} -> ${r.status} ${r.body.message}`);
  }
});

check('PUBLIC_APP_URL without a scheme gets https://', async () => {
  assert(normalizeBaseUrl('admin.shop.example.com') === 'https://admin.shop.example.com', 'bare host');
  assert(normalizeBaseUrl('admin.shop.example.com/') === 'https://admin.shop.example.com', 'bare host + slash');
  assert(normalizeBaseUrl('http://localhost:8081') === 'http://localhost:8081', 'http kept');
});

check('PUBLIC_APP_URL trailing slashes are dropped', async () => {
  assert(normalizeBaseUrl('https://shop.example.com/') === 'https://shop.example.com', 'one slash');
  assert(normalizeBaseUrl(' https://shop.example.com// ') === 'https://shop.example.com', 'two slashes + spaces');
  assert(normalizeBaseUrl('https://shop.example.com') === 'https://shop.example.com', 'none');
  assert(normalizeBaseUrl('') === '', 'blank');
});

check('bare code resolves', async () => {
  const owner = await loginOwner();
  const db = await getDb();
  const id = await makeProduct('ScanBare');
  const code = await ensureLabelCode(db, id);
  const r = await scan(owner.token, code.toLowerCase());
  assert(r.status === 200 && r.body.data.id === id, JSON.stringify(r.body));
});

check('foreign url refused', async () => {
  const owner = await loginOwner();
  const db = await getDb();
  const id = await makeProduct('ScanForeign');
  const code = await ensureLabelCode(db, id);
  for (const p of [`https://example.com/x/p/${code}`, `https://example.com/p/${code}/extra`, 'https://example.com/p/ABCDEFG', `https://example.com/p/${code}0`, 'hello', '{"type":"other","id":1}']) {
    const r = await scan(owner.token, p);
    assert(r.status === 400 && r.body.message === UNKNOWN, `${p} -> ${r.status} ${r.body.message}`);
  }
  const none = await scan(owner.token, 'AAAAAAAA');
  assert(none.status === 404 && none.body.message === UNKNOWN, `unknown code -> ${none.status}`);
});

check('no estimated_cost in scan response', async () => {
  const owner = await loginOwner();
  const id = await makeProduct('ScanNoCost');
  const db = await getDb();
  await db.prepare('UPDATE products SET estimated_cost = 7731 WHERE id = ?').run(id);
  await db.prepare('INSERT INTO product_options (product_id, label, price, sort_order, is_active) VALUES (?, ?, ?, 0, 1)').run(id, 'Small', 99);
  const loc = await db.prepare('SELECT id FROM locations ORDER BY id LIMIT 1').get();
  const r = await scan(owner.token, JSON.stringify({ type: 'bloomcart_product', id }), loc.id);
  assert(r.status === 200, `status ${r.status}`);
  const d = r.body.data;
  assert(!('estimated_cost' in d) && !('materials' in d) && !('stock_quantity' in d) && !JSON.stringify(r.body).includes('7731'), JSON.stringify(d));
  assert(typeof d.in_stock === 'boolean' && d.options.length === 1 && d.options[0].price === 99, JSON.stringify(d));
});

check('inactive product message', async () => {
  const owner = await loginOwner();
  const id = await makeProduct('ScanOff');
  const db = await getDb();
  await db.prepare('UPDATE products SET is_active = 0 WHERE id = ?').run(id);
  const r = await scan(owner.token, JSON.stringify({ type: 'bloomcart_product', id }));
  assert(r.status === 409 && r.body.message === 'Not for sale right now — ask the counter.', JSON.stringify(r.body));
});

check('one-off sold message', async () => {
  const owner = await loginOwner();
  const id = await makeProduct('ScanOneOff');
  const db = await getDb();
  await db.prepare('UPDATE products SET is_one_off = 1 WHERE id = ?').run(id);
  const loc = await db.prepare('SELECT id FROM locations ORDER BY id LIMIT 1').get();
  const sold = await scan(owner.token, JSON.stringify({ type: 'bloomcart_product', id }), loc.id);
  assert(sold.status === 409 && sold.body.message === 'This one-off item is already sold. Check with the counter.', JSON.stringify(sold.body));
  await db.prepare('INSERT INTO product_stock (product_id, location_id, quantity) VALUES (?, ?, 1)').run(id, loc.id);
  const ok = await scan(owner.token, JSON.stringify({ type: 'bloomcart_product', id }), loc.id);
  assert(ok.status === 200 && ok.body.data.in_stock === true, JSON.stringify(ok.body));
});

check('labels rows include active sizes in order, and the url host', async () => {
  const owner = await loginOwner();
  const id = await makeProduct('LblSized', 500);
  const plain = await makeProduct('LblPlain', 200);
  const put = await api('PUT', `/products/${id}/options`, owner.token, { options: [{ label: 'Small', price: 400 }, { label: 'Large', price: 900 }] });
  assert(put.status === 200, `options ${put.status}`);
  const db = await getDb();
  await db.prepare('INSERT INTO product_options (product_id, label, price, sort_order, is_active) VALUES (?, ?, 999, 9, 0)').run(id, 'Gone');
  const { status, body } = await api('POST', '/products/labels', owner.token, { product_ids: [id, plain] });
  assert(status === 200, `status ${status}`);
  const sized = body.data.find((r) => r.product_id === id);
  const flat = body.data.find((r) => r.product_id === plain);
  assert(JSON.stringify(sized.options) === JSON.stringify([{ label: 'Small', price: 400 }, { label: 'Large', price: 900 }]), JSON.stringify(sized.options));
  assert(Array.isArray(flat.options) && flat.options.length === 0, JSON.stringify(flat.options));
  assert(sized.url_host && sized.url.includes(`//${sized.url_host}/p/`), `host ${sized.url_host} url ${sized.url}`);
});

// Tested on the helper, not the live server: the dev server runs without
// NODE_ENV=production, and restarting it in production mode just for this
// would change other behaviour for the rest of the run.
check('production without PUBLIC_APP_URL refuses labels (helper)', async () => {
  assert(publicUrlMissingInProduction({ NODE_ENV: 'production' }) === true, 'prod + unset');
  assert(publicUrlMissingInProduction({ NODE_ENV: 'production', PUBLIC_APP_URL: '   ' }) === true, 'prod + blank');
  assert(publicUrlMissingInProduction({ NODE_ENV: 'production', PUBLIC_APP_URL: 'https://shop.example.com' }) === false, 'prod + set');
  assert(publicUrlMissingInProduction({ NODE_ENV: 'development' }) === false, 'dev + unset');
  assert(publicUrlMissingInProduction({}) === false, 'no env');
  assert(DEV_FALLBACK === 'http://localhost:8081', DEV_FALLBACK);
  assert(publicUrlHost('https://shop.example.com/x') === 'shop.example.com', 'host');
  // This dev server is not production, so labels still print here.
  const owner = await loginOwner();
  const id = await makeProduct('LblDevOk');
  const r = await api('POST', '/products/labels', owner.token, { product_ids: [id] });
  assert(r.status === 200, `dev labels ${r.status}`);
});

const createdUserIds = [];
async function createCounterStaff(ownerToken) {
  const phone = '9' + String(Date.now()).slice(-8) + String(createdUserIds.length % 10);
  const { status, body } = await api('POST', '/users', ownerToken, {
    name: 'LabelsTest staff', phone, password: 'testpass123', role: 'counter_staff', location_ids: [TEST_LOCATION_ID],
  });
  if (status !== 201 && status !== 200) throw new Error(`Could not create test staff: ${status} ${JSON.stringify(body)}`);
  createdUserIds.push(body.data.id || body.data.user?.id);
  const login = await api('POST', '/auth/login', null, { phone, password: 'testpass123' });
  if (login.status !== 200) throw new Error(`staff login ${login.status}`);
  return { token: login.body.data.token };
}

check('lookup scan: owner opens a switched-off product, counter_staff still refused', async () => {
  const owner = await loginOwner();
  const staff = await createCounterStaff(owner.token);
  const id = await makeProduct('ScanLookupOff');
  const db = await getDb();
  await db.prepare('UPDATE products SET is_active = 0 WHERE id = ?').run(id);
  const payload = JSON.stringify({ type: 'bloomcart_product', id });
  const ownerLookup = await api('POST', '/products/scan', owner.token, { payload, purpose: 'lookup' });
  assert(ownerLookup.status === 200 && ownerLookup.body.data.id === id && ownerLookup.body.data.is_active === 0, JSON.stringify(ownerLookup.body));
  const ownerCounter = await api('POST', '/products/scan', owner.token, { payload });
  assert(ownerCounter.status === 409, `owner without lookup -> ${ownerCounter.status}`);
  const staffLookup = await api('POST', '/products/scan', staff.token, { payload, purpose: 'lookup' });
  assert(staffLookup.status === 409 && staffLookup.body.message === 'Not for sale right now — ask the counter.', JSON.stringify(staffLookup.body));
  // An active product still reports is_active 1 on a lookup.
  const on = await makeProduct('ScanLookupOn');
  const onR = await api('POST', '/products/scan', owner.token, { payload: JSON.stringify({ type: 'bloomcart_product', id: on }), purpose: 'lookup' });
  assert(onR.status === 200 && onR.body.data.is_active === 1, JSON.stringify(onR.body));
});

check('concurrent option saves leave one list', async () => {
  const owner = await loginOwner();
  const id = await makeProduct('LblOptsRace');
  const lists = [
    [{ label: 'A', price: 1 }, { label: 'B', price: 2 }],
    [{ label: 'C', price: 3 }, { label: 'D', price: 4 }, { label: 'E', price: 5 }],
  ];
  const rs = await Promise.all([0, 1, 0, 1].map((i) => api('PUT', `/products/${id}/options`, owner.token, { options: lists[i] })));
  assert(rs.every((r) => r.status === 200), rs.map((r) => r.status).join(','));
  const db = await getDb();
  const rows = await db.prepare('SELECT label FROM product_options WHERE product_id = ? ORDER BY sort_order, id').all(id);
  const labels = rows.map((r) => r.label).join('');
  assert(labels === 'AB' || labels === 'CDE', `mixed list: ${labels}`);
});

// ---- Public price page (no auth). Rate-limit check MUST stay last: it uses up this IP's budget. ----
const PUBLIC_BASE = process.env.API_BASE_URL || 'http://localhost:3001/api';
async function pub(code) {
  const res = await fetch(`${PUBLIC_BASE}/price/${code}`);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const NOT_FOUND_COPY = "We couldn't find this item — please ask at the counter.";

check('public price works without auth', async () => {
  const db = await getDb();
  const id = await makeProduct('PubPrice', 250);
  const code = await ensureLabelCode(db, id);
  await db.prepare('INSERT INTO product_options (product_id, label, price, sort_order, is_active) VALUES (?, ?, 300, 2, 1)').run(id, 'Large');
  await db.prepare('INSERT INTO product_options (product_id, label, price, sort_order, is_active) VALUES (?, ?, 100, 1, 1)').run(id, 'Small');
  await db.prepare('INSERT INTO product_options (product_id, label, price, sort_order, is_active) VALUES (?, ?, 999, 3, 0)').run(id, 'Hidden');
  const r = await pub(code);
  const d = r.body.data;
  assert(r.status === 200 && r.body.success && d.price === 250 && d.price_mode === 'fixed' && d.available === true, JSON.stringify(r.body));
  assert(d.options.length === 2 && d.options[0].label === 'Small' && d.options[1].label === 'Large', JSON.stringify(d.options));
  assert(typeof d.shop_name === 'string' && d.shop_name.length > 0, 'shop_name');
});

check('public price hides cost and stock', async () => {
  const db = await getDb();
  const id = await makeProduct('PubHide');
  await db.prepare('UPDATE products SET estimated_cost = 7731 WHERE id = ?').run(id);
  const code = await ensureLabelCode(db, id);
  const r = await pub(code);
  const keys = Object.keys(r.body.data).sort().join(',');
  assert(keys === 'available,image_url,name,options,price,price_hint,price_mode,shop_name', keys);
  assert(!JSON.stringify(r.body).includes('7731') && !/estimated_cost|quantity|stock|supplier|material/i.test(JSON.stringify(r.body)), JSON.stringify(r.body));
});

check('public price: sold one-off and inactive', async () => {
  const db = await getDb();
  const id = await makeProduct('PubOneOff');
  await db.prepare('UPDATE products SET is_one_off = 1 WHERE id = ?').run(id);
  const code = await ensureLabelCode(db, id);
  const r = await pub(code);
  assert(r.status === 200 && r.body.data.available === false, JSON.stringify(r.body));
  await db.prepare('UPDATE products SET is_active = 0 WHERE id = ?').run(id);
  const r2 = await pub(code);
  assert(r2.status === 404 && r2.body.message === NOT_FOUND_COPY, JSON.stringify(r2.body));
});

check('unknown code 404 copy', async () => {
  for (const c of ['ZZZZZZZZ', 'bad', 'ABCDEFG0']) {
    const r = await pub(c);
    assert(r.status === 404 && r.body.success === false && r.body.message === NOT_FOUND_COPY, `${c}: ${JSON.stringify(r.body)}`);
  }
});

check('rate limited', async () => {
  let last;
  for (let i = 0; i < 31; i++) last = await pub('ZZZZZZZZ');
  assert(last.status === 429 && last.body.message === 'Too many requests — please try again in a minute.', JSON.stringify(last));
});

async function cleanup() {
  const db = await getDb();
  for (const id of createdProductIds) {
    try {
      await db.prepare('DELETE FROM product_stock WHERE product_id = ?').run(id);
      await db.prepare('DELETE FROM product_options WHERE product_id = ?').run(id);
      await db.prepare('DELETE FROM products WHERE id = ?').run(id);
    } catch (err) { console.error(`   (cleanup warning: product ${id}: ${err.message})`); }
  }
  for (const id of createdUserIds) {
    try {
      await db.prepare('DELETE FROM audit_logs WHERE user_id = ?').run(id);
      await db.prepare('DELETE FROM user_locations WHERE user_id = ?').run(id);
      await db.prepare('DELETE FROM users WHERE id = ?').run(id);
    } catch (err) { console.error(`   (cleanup warning: user ${id}: ${err.message})`); }
  }
  console.log(`Cleaned up ${createdProductIds.length} test product(s) and ${createdUserIds.length} test user(s)`);
}

h.run({ cleanup });
