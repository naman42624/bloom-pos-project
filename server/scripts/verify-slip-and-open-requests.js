#!/usr/bin/env node
/**
 * Live verification for the slip QR scan page, open order-request link and
 * checkout fixes (spec 2026-10-28-slip-qr-open-orders-checkout-design.md).
 * Same harness shape as verify-order-flows.js: append checks, never remove.
 *
 * Usage: TRACKING_LINK_SECRET=... VERIFY_OWNER_PHONE=... VERIFY_OWNER_PASSWORD=... node scripts/verify-slip-and-open-requests.js
 */
require('dotenv').config();
const { getDb } = require('../config/database-async');
const { generateSlipToken, verifySlipToken } = require('../utils/slip-token');
const { generateTrackingToken, verifyTrackingToken } = require('../utils/tracking-token');

const API_BASE = process.env.API_BASE_URL || 'http://localhost:3001/api';
const TEST_LOCATION_ID = 4; // "Test Loc" — the project's established scratch location

const checks = [];
const createdSaleIds = [];

function check(name, fn) {
  checks.push({ name, fn });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertLocalTarget() {
  const isLocalUrl = (url) => {
    try {
      const { hostname } = new URL(url);
      return hostname === 'localhost' || hostname === '127.0.0.1';
    } catch {
      return false;
    }
  };
  const problems = [];
  if (!isLocalUrl(API_BASE)) problems.push(`API_BASE_URL ("${API_BASE}")`);
  const databaseUrl = process.env.DATABASE_URL || '';
  if (!isLocalUrl(databaseUrl)) problems.push(`DATABASE_URL ("${databaseUrl.replace(/:[^:@]*@/, ':***@')}")`);
  if (problems.length > 0) {
    console.error(`Refusing to run: ${problems.join(' and ')} do${problems.length === 1 ? 'es' : ''} not point at localhost/127.0.0.1.`);
    process.exit(1);
  }
}

async function api(method, path, token, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON response */ }
  return { status: res.status, body: json };
}

async function loginOwner() {
  const phone = process.env.VERIFY_OWNER_PHONE;
  const password = process.env.VERIFY_OWNER_PASSWORD;
  if (!phone || !password) throw new Error('VERIFY_OWNER_PHONE and VERIFY_OWNER_PASSWORD must both be set in the environment — no default credentials are used.');
  const { status, body } = await api('POST', '/auth/login', null, { phone, password });
  if (status !== 200 || !body?.data?.token) throw new Error(`Owner login failed: ${status} ${JSON.stringify(body)}`);
  return { token: body.data.token, id: body.data.user.id, role: body.data.user.role };
}

async function cleanup() {
  if (createdSaleIds.length === 0) return;
  const db = await getDb();
  for (const saleId of createdSaleIds) {
    try {
      await db.prepare('DELETE FROM pickup_load_checks WHERE sale_id = ?').run(saleId);
      await db.prepare('DELETE FROM delivery_load_checks WHERE delivery_id IN (SELECT id FROM deliveries WHERE sale_id = ?)').run(saleId);
      await db.prepare('DELETE FROM delivery_collections WHERE delivery_id IN (SELECT id FROM deliveries WHERE sale_id = ?)').run(saleId);
      await db.prepare('DELETE FROM deliveries WHERE sale_id = ?').run(saleId);
      await db.prepare('DELETE FROM production_tasks WHERE sale_id = ?').run(saleId);
      await db.prepare('DELETE FROM sale_attachments WHERE sale_id = ?').run(saleId);
      await db.prepare('DELETE FROM payments WHERE sale_id = ?').run(saleId);
      await db.prepare('DELETE FROM refunds WHERE sale_id = ?').run(saleId);
      await db.prepare('DELETE FROM sale_items WHERE sale_id = ?').run(saleId);
      await db.prepare('DELETE FROM pre_orders WHERE sale_id = ?').run(saleId);
      await db.prepare('DELETE FROM sales WHERE id = ?').run(saleId);
    } catch (err) {
      console.log(`   cleanup of sale ${saleId} failed: ${err.message}`);
    }
  }
}

async function columnOrTableExists(table, column) {
  const db = await getDb();
  const row = column
    ? await db.prepare('SELECT 1 AS ok FROM information_schema.columns WHERE table_name = ? AND column_name = ?').get(table, column)
    : await db.prepare('SELECT 1 AS ok FROM information_schema.tables WHERE table_name = ?').get(table);
  return !!row;
}

check('slip token round-trips to the sale id', async () => {
  const t = generateSlipToken(42);
  assert(verifySlipToken(t) === 42, `Expected 42, got ${verifySlipToken(t)}`);
});

check('tampered slip token and a tracking token are rejected', async () => {
  const t = generateSlipToken(42);
  const [id, sig] = t.split('.');
  const flipped = sig.slice(0, -1) + (sig.slice(-1) === '0' ? '1' : '0');
  assert(verifySlipToken(`${id}.${flipped}`) === null, 'Tampered signature should be null');
  assert(verifySlipToken(`43.${sig}`) === null, 'Swapped id should be null');
  assert(verifySlipToken(generateTrackingToken(42)) === null, 'Tracking token must not verify as a slip token');
  assert(verifySlipToken('garbage') === null && verifySlipToken(undefined) === null, 'Garbage should be null');
});

check('a slip token is not accepted as a tracking token', async () => {
  assert(verifyTrackingToken(generateSlipToken(42)) === null, 'Slip token must not verify as a tracking token');
});

check('pickup_load_checks table, checked_via and status_token columns exist', async () => {
  assert(await columnOrTableExists('pickup_load_checks'), 'pickup_load_checks missing');
  assert(await columnOrTableExists('delivery_load_checks', 'checked_via'), 'delivery_load_checks.checked_via missing');
  assert(await columnOrTableExists('order_requests', 'status_token'), 'order_requests.status_token missing');
  for (const c of ['requester_name', 'requester_phone', 'source']) {
    assert(await columnOrTableExists('order_requests', c), `order_requests.${c} missing`);
  }
});

// ─── Task 2: public slip API, shared load checklist, slip fields ───

function mintToken(userId) {
  const jwt = require('jsonwebtoken');
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

async function createSlipSale(ownerToken, orderType, extra = {}) {
  const body = {
    location_id: TEST_LOCATION_ID, order_type: orderType, channel: 'phone',
    items: [
      { quantity: 2, unit_price: 350, product_name: 'Slip Test Roses' },
      { quantity: 1, unit_price: 120, product_name: 'Slip Test Card' },
    ],
    ...extra,
  };
  if (orderType === 'delivery') {
    Object.assign(body, { delivery_address: '42 Secret Lane', receiver_name: 'Slip Receiver', receiver_phone: '9998887777' }, extra);
  }
  const res = await api('POST', '/sales', ownerToken, body);
  if (res.status !== 201 && res.status !== 200) throw new Error(`Could not create ${orderType} sale: ${res.status} ${JSON.stringify(res.body)}`);
  const saleId = res.body.data.id;
  createdSaleIds.push(saleId);
  const db = await getDb();
  const items = await db.prepare('SELECT id FROM sale_items WHERE sale_id = ? ORDER BY id').all(saleId);
  const delivery = await db.prepare('SELECT id FROM deliveries WHERE sale_id = ?').get(saleId);
  return { saleId, itemIds: items.map((i) => i.id), deliveryId: delivery ? delivery.id : null, token: generateSlipToken(saleId) };
}

const slipCtx = {};
async function slipOwner() {
  if (!slipCtx.owner) slipCtx.owner = await loginOwner();
  return slipCtx.owner;
}
async function slipDeliverySale() {
  if (!slipCtx.delivery) slipCtx.delivery = await createSlipSale((await slipOwner()).token, 'delivery');
  return slipCtx.delivery;
}

const DENIED_KEYS = ['price', 'unit_price', 'total', 'grand_total', 'amount', 'phone', 'address', 'customer_name', 'receiver_name', 'partner_name', 'created_by_name'];
function findDeniedKeys(value, path = '$', found = []) {
  if (Array.isArray(value)) value.forEach((v, i) => findDeniedKeys(v, `${path}[${i}]`, found));
  else if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) {
      if (DENIED_KEYS.includes(k)) found.push(`${path}.${k}`);
      findDeniedKeys(value[k], `${path}.${k}`, found);
    }
  }
  return found;
}

check('public slip GET on a delivery sale returns its items with a delivery checklist', async () => {
  const s = await slipDeliverySale();
  const res = await api('GET', `/slip/${s.token}`, null);
  assert(res.status === 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  const d = res.body.data;
  assert(d.checklist && d.checklist.kind === 'delivery' && d.checklist.enabled === true, `Expected enabled delivery checklist, got ${JSON.stringify(d.checklist)}`);
  assert(d.display_type === 'Delivery', `Expected display_type Delivery, got ${d.display_type}`);
  assert(Array.isArray(d.items) && d.items.length === 2, `Expected 2 items, got ${JSON.stringify(d.items)}`);
  assert(d.items[0].name === 'Slip Test Roses' && Number(d.items[0].quantity) === 2, `Unexpected first item ${JSON.stringify(d.items[0])}`);
  assert(Array.isArray(d.items[0].voice_notes) && Array.isArray(d.order_voice_notes), 'voice_notes arrays missing');
  assert(d.checklist.items.length === 2 && d.checklist.items.every((i) => i.checked === false), `Expected 2 unchecked rows, got ${JSON.stringify(d.checklist.items)}`);
});

check('public slip GET leaks no prices, phones, addresses or names (recursive key walk)', async () => {
  const s = await slipDeliverySale();
  const res = await api('GET', `/slip/${s.token}`, null);
  assert(res.status === 200, `Expected 200, got ${res.status}`);
  const found = findDeniedKeys(res.body);
  assert(found.length === 0, `Denied keys present: ${found.join(', ')}`);
  const raw = JSON.stringify(res.body);
  assert(!raw.includes('9998887777'), 'Receiver phone appears in the public body');
  assert(!raw.includes('Secret Lane') && !raw.includes('Slip Receiver'), 'Address or receiver name appears in the public body');
});

check('public slip tick shows in the app delivery checklist, and an app tick shows on the slip', async () => {
  const owner = await slipOwner();
  const s = await slipDeliverySale();
  const put = await api('PUT', `/slip/${s.token}/check/${s.itemIds[0]}`, null, { checked: true });
  assert(put.status === 200, `Public PUT expected 200, got ${put.status}: ${JSON.stringify(put.body)}`);
  assert(put.body.data.items.find((i) => i.sale_item_id === s.itemIds[0]).checked === true, 'PUT response does not show the tick');
  const app = await api('GET', `/deliveries/${s.deliveryId}/checklist`, owner.token);
  assert(app.status === 200, `App checklist GET ${app.status}`);
  const row = app.body.data.find((r) => r.sale_item_id === s.itemIds[0]);
  assert(row && row.checked === true, `App does not see the public tick: ${JSON.stringify(app.body.data)}`);
  const db = await getDb();
  const via = await db.prepare('SELECT checked_via, checked_by FROM delivery_load_checks WHERE delivery_id = ? AND sale_item_id = ?').get(s.deliveryId, s.itemIds[0]);
  assert(via.checked_via === 'slip_qr' && via.checked_by === null, `Expected slip_qr/null, got ${JSON.stringify(via)}`);

  const appPut = await api('PUT', `/deliveries/${s.deliveryId}/checklist/${s.itemIds[1]}`, owner.token, { checked: true });
  assert(appPut.status === 200, `App PUT ${appPut.status}: ${JSON.stringify(appPut.body)}`);
  const via2 = await db.prepare('SELECT checked_via, checked_by FROM delivery_load_checks WHERE delivery_id = ? AND sale_item_id = ?').get(s.deliveryId, s.itemIds[1]);
  assert(via2.checked_via === 'app' && via2.checked_by === owner.id, `Expected app/owner, got ${JSON.stringify(via2)}`);
  const pub = await api('GET', `/slip/${s.token}`, null);
  const pubRow = pub.body.data.checklist.items.find((i) => i.sale_item_id === s.itemIds[1]);
  assert(pubRow && pubRow.checked === true && pubRow.checked_at, `Slip does not see the app tick: ${JSON.stringify(pub.body.data.checklist)}`);
});

check('pickup sale: public tick and /sales/:id/pickup-checks round-trip both ways', async () => {
  const owner = await slipOwner();
  const s = await createSlipSale(owner.token, 'pickup');
  slipCtx.pickup = s;
  const pub = await api('GET', `/slip/${s.token}`, null);
  assert(pub.status === 200 && pub.body.data.checklist.kind === 'pickup', `Expected pickup checklist, got ${pub.status} ${JSON.stringify(pub.body)}`);
  assert(pub.body.data.display_type === 'Pickup', `Expected Pickup, got ${pub.body.data.display_type}`);
  const put = await api('PUT', `/slip/${s.token}/check/${s.itemIds[0]}`, null, { checked: true });
  assert(put.status === 200, `Public PUT ${put.status}: ${JSON.stringify(put.body)}`);
  const app = await api('GET', `/sales/${s.saleId}/pickup-checks`, owner.token);
  assert(app.status === 200, `App pickup GET ${app.status}: ${JSON.stringify(app.body)}`);
  assert(app.body.data.kind === 'pickup', `App kind ${app.body.data.kind}`);
  assert(app.body.data.items.find((i) => i.sale_item_id === s.itemIds[0]).checked === true, 'App does not see public pickup tick');
  const appPut = await api('PUT', `/sales/${s.saleId}/pickup-checks/${s.itemIds[1]}`, owner.token, { checked: true });
  assert(appPut.status === 200, `App pickup PUT ${appPut.status}: ${JSON.stringify(appPut.body)}`);
  const db = await getDb();
  const via = await db.prepare('SELECT checked_via, checked_by FROM pickup_load_checks WHERE sale_id = ? AND sale_item_id = ?').get(s.saleId, s.itemIds[1]);
  assert(via.checked_via === 'app' && via.checked_by === owner.id, `Expected app/owner, got ${JSON.stringify(via)}`);
  const pub2 = await api('GET', `/slip/${s.token}`, null);
  assert(pub2.body.data.checklist.items.every((i) => i.checked === true), `Slip does not see app pickup tick: ${JSON.stringify(pub2.body.data.checklist)}`);
  // Untick also round-trips.
  const untick = await api('PUT', `/slip/${s.token}/check/${s.itemIds[0]}`, null, { checked: false });
  assert(untick.status === 200 && untick.body.data.items.find((i) => i.sale_item_id === s.itemIds[0]).checked === false, 'Untick did not apply');
});

check('pickup-checks routes reject a customer and a rider (403)', async () => {
  const s = slipCtx.pickup || await createSlipSale((await slipOwner()).token, 'pickup');
  const cust = await api('GET', `/sales/${s.saleId}/pickup-checks`, mintToken(11));
  const rider = await api('PUT', `/sales/${s.saleId}/pickup-checks/${s.itemIds[0]}`, mintToken(8), { checked: true });
  assert(cust.status === 403 && rider.status === 403, `Expected 403/403, got ${cust.status}/${rider.status}`);
});

check('a delivery converted to pickup gives a pickup checklist on the slip', async () => {
  const owner = await slipOwner();
  const s = await createSlipSale(owner.token, 'delivery');
  const conv = await api('PUT', `/sales/${s.saleId}/convert-type`, owner.token, { new_order_type: 'pickup' });
  assert(conv.status === 200, `Convert ${conv.status}: ${JSON.stringify(conv.body)}`);
  const pub = await api('GET', `/slip/${s.token}`, null);
  assert(pub.status === 200 && pub.body.data.checklist.kind === 'pickup', `Expected 200/pickup, got ${pub.status} ${JSON.stringify(pub.body?.data?.checklist)}`);
  const put = await api('PUT', `/slip/${s.token}/check/${s.itemIds[0]}`, null, { checked: true });
  assert(put.status === 200 && put.body.data.kind === 'pickup', `Expected PUT 200/pickup after convert, got ${put.status} ${JSON.stringify(put.body)}`);
});

check('a pre_order without a delivery uses the pickup checklist; a walk_in is disabled', async () => {
  const owner = await slipOwner();
  const pre = await createSlipSale(owner.token, 'pre_order', { scheduled_date: '2026-12-01' });
  const preRes = await api('GET', `/slip/${pre.token}`, null);
  assert(preRes.status === 200 && preRes.body.data.checklist.kind === 'pickup' && preRes.body.data.checklist.enabled, `pre_order: ${preRes.status} ${JSON.stringify(preRes.body?.data?.checklist)}`);
  const walk = await createSlipSale(owner.token, 'walk_in');
  const walkRes = await api('GET', `/slip/${walk.token}`, null);
  assert(walkRes.status === 200 && walkRes.body.data.checklist.enabled === false && walkRes.body.data.checklist.items.length === 0, `walk_in: ${walkRes.status} ${JSON.stringify(walkRes.body?.data?.checklist)}`);
  const put = await api('PUT', `/slip/${walk.token}/check/${walk.itemIds[0]}`, null, { checked: true });
  assert(put.status === 409, `walk_in PUT expected 409, got ${put.status}`);
});

check('a saleItemId from another sale gives 404; a delivered sale gives 409', async () => {
  const s = await slipDeliverySale();
  const other = slipCtx.pickup || await createSlipSale((await slipOwner()).token, 'pickup');
  const wrong = await api('PUT', `/slip/${s.token}/check/${other.itemIds[0]}`, null, { checked: true });
  assert(wrong.status === 404, `Expected 404, got ${wrong.status}: ${JSON.stringify(wrong.body)}`);
  const owner = await slipOwner();
  const d = await createSlipSale(owner.token, 'delivery');
  const db = await getDb();
  await db.prepare("UPDATE deliveries SET status = 'delivered' WHERE id = ?").run(d.deliveryId);
  const fin = await api('PUT', `/slip/${d.token}/check/${d.itemIds[0]}`, null, { checked: true });
  assert(fin.status === 409 && /delivered/i.test(fin.body?.message || ''), `Expected 409 "delivered", got ${fin.status}: ${JSON.stringify(fin.body)}`);
  const appFin = await api('PUT', `/deliveries/${d.deliveryId}/checklist/${d.itemIds[0]}`, owner.token, { checked: true });
  assert(appFin.status === 409, `App toggle on a delivered delivery expected 409, got ${appFin.status}`);
});

check('bad token, tracking token, and missing sale give 404', async () => {
  const s = await slipDeliverySale();
  const a = await api('GET', `/slip/${generateTrackingToken(s.saleId)}`, null);
  const b = await api('GET', `/slip/garbage`, null);
  const c = await api('GET', `/slip/${generateSlipToken(999999999)}`, null);
  assert(a.status === 404 && b.status === 404 && c.status === 404, `Expected 404s, got ${a.status}/${b.status}/${c.status}`);
});

check('slip expires 7 days after completion: 8 days gives 404, 6 days gives 200', async () => {
  const owner = await slipOwner();
  const s = await createSlipSale(owner.token, 'pickup');
  const db = await getDb();
  await db.prepare("UPDATE sales SET status = 'completed', updated_at = NOW() - INTERVAL '8 days' WHERE id = ?").run(s.saleId);
  const old = await api('GET', `/slip/${s.token}`, null);
  const oldPut = await api('PUT', `/slip/${s.token}/check/${s.itemIds[0]}`, null, { checked: true });
  await db.prepare("UPDATE sales SET status = 'completed', updated_at = NOW() - INTERVAL '6 days' WHERE id = ?").run(s.saleId);
  const recent = await api('GET', `/slip/${s.token}`, null);
  assert(old.status === 404 && oldPut.status === 404, `Expected 404/404 at 8 days, got ${old.status}/${oldPut.status}`);
  assert(recent.status === 200, `Expected 200 at 6 days, got ${recent.status}`);
  // An open order never expires, however old.
  await db.prepare("UPDATE sales SET status = 'preparing', updated_at = NOW() - INTERVAL '30 days' WHERE id = ?").run(s.saleId);
  const open = await api('GET', `/slip/${s.token}`, null);
  assert(open.status === 200, `Expected 200 for an old open order, got ${open.status}`);
});

check('GET /sales/:id gives owner and rider slip_url + slip_qr_svg, customer neither', async () => {
  const owner = await slipOwner();
  const s = await slipDeliverySale();
  const res = await api('GET', `/sales/${s.saleId}`, owner.token);
  assert(res.status === 200, `GET ${res.status}`);
  assert(typeof res.body.data.slip_url === 'string' && res.body.data.slip_url.endsWith(s.token), `slip_url ${res.body.data.slip_url}`);
  assert(typeof res.body.data.slip_qr_svg === 'string' && res.body.data.slip_qr_svg.trim().startsWith('<svg'), `slip_qr_svg starts ${String(res.body.data.slip_qr_svg).slice(0, 30)}`);
  const rider = await api('GET', `/sales/${s.saleId}`, mintToken(8));
  assert(rider.status === 200 && rider.body.data.slip_url && rider.body.data.slip_qr_svg, `Rider should get slip fields (${rider.status})`);
  const cust = await api('GET', `/sales/${s.saleId}`, mintToken(11));
  assert(cust.status === 200, `Customer GET expected 200 (route is authenticate-only), got ${cust.status}`);
  assert(!('slip_url' in cust.body.data) && !('slip_qr_svg' in cust.body.data), 'Customer must not get slip fields');
});

check('public slip GET reports final/final_message: open false/null, delivered and picked-up true + message', async () => {
  const owner = await slipOwner();
  const open = await createSlipSale(owner.token, 'pickup');
  const o = await api('GET', `/slip/${open.token}`, null);
  assert(o.body.data.checklist.final === false && o.body.data.checklist.final_message === null, `Open: ${JSON.stringify(o.body.data.checklist)}`);
  assert(findDeniedKeys(o.body.data).length === 0, 'deny-list tripped on open slip');
  const put = await api('PUT', `/slip/${open.token}/check/${open.itemIds[0]}`, null, { checked: true });
  assert(put.body.data.final === false && put.body.data.final_message === null, `PUT open: ${JSON.stringify(put.body.data)}`);
  const db = await getDb();
  const d = await createSlipSale(owner.token, 'delivery');
  await db.prepare("UPDATE deliveries SET status = 'delivered' WHERE id = ?").run(d.deliveryId);
  const dg = await api('GET', `/slip/${d.token}`, null);
  assert(dg.body.data.checklist.final === true && /delivered/i.test(dg.body.data.checklist.final_message || ''), `Delivered: ${JSON.stringify(dg.body.data.checklist)}`);
  assert(findDeniedKeys(dg.body.data).length === 0, 'deny-list tripped on final slip');
  const p = await createSlipSale(owner.token, 'pickup');
  await db.prepare("UPDATE sales SET pickup_status = 'picked_up' WHERE id = ?").run(p.saleId);
  const pg = await api('GET', `/slip/${p.token}`, null);
  assert(pg.body.data.checklist.final === true && /picked up/i.test(pg.body.data.checklist.final_message || ''), `Picked up: ${JSON.stringify(pg.body.data.checklist)}`);
});

// ─── Task 4: general (open) order-request link, register-on-approve ───

const openCtx = { requestIds: [], phones: [] };

async function freeTestPhone(prefix) {
  const db = await getDb();
  for (let i = 0; i < 50; i++) {
    const p = prefix + String(Math.floor(Math.random() * 100000)).padStart(5, '0');
    const hit = await db.prepare("SELECT 1 AS ok FROM users WHERE regexp_replace(phone, '[^0-9]', '', 'g') LIKE ?").get(`%${p}`);
    if (!hit) { openCtx.phones.push(p); return p; }
  }
  throw new Error('No free test phone found');
}

async function usersCount() {
  const db = await getDb();
  return Number((await db.prepare('SELECT COUNT(*) AS c FROM users').get()).c);
}

function openBody(extra = {}) {
  return {
    requester_name: 'Open Link Tester', requester_phone: openCtx.phone,
    recipient_name: 'Open Recipient', recipient_phone: '9000000001',
    order_type: 'pickup', requested_date: '2026-12-20', requested_time: '10:00',
    items: [{ custom: true, description: 'Open test bouquet', quantity: 2 }],
    ...extra,
  };
}

async function submitOpen(extra) {
  const res = await api('POST', '/order-request/open', null, openBody(extra));
  if (res.status === 201) {
    const token = String(res.body?.data?.status_url || '').split('/').pop();
    const db = await getDb();
    const row = await db.prepare('SELECT id FROM order_requests WHERE status_token = ?').get(token);
    if (row) openCtx.requestIds.push(row.id);
    return { res, token, id: row ? row.id : null };
  }
  return { res };
}

check('GET /order-request/open returns the catalog and no customer data', async () => {
  const res = await api('GET', '/order-request/open', null);
  assert(res.status === 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert(Array.isArray(res.body.data.products), 'products missing');
  assert(!('customer_name' in res.body.data) && !('requests' in res.body.data), `Customer data present: ${Object.keys(res.body.data)}`);
});

check('open submit: one row, customer_id NULL, source general_link, users unchanged, status pending', async () => {
  openCtx.phone = await freeTestPhone('98765');
  const before = await usersCount();
  const { res, token, id } = await submitOpen();
  assert(res.status === 201, `Expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert(/^\/order-request\/status\/[0-9a-f]{48}$/.test(res.body.data.status_url), `status_url ${res.body.data.status_url}`);
  const db = await getDb();
  const rows = await db.prepare('SELECT * FROM order_requests WHERE status_token = ?').all(token);
  assert(rows.length === 1, `Expected 1 row, got ${rows.length}`);
  const r = rows[0];
  assert(r.customer_id === null && r.source === 'general_link', `Got customer_id=${r.customer_id} source=${r.source}`);
  assert(r.requester_name === 'Open Link Tester' && r.requester_phone === openCtx.phone, `Requester ${r.requester_name}/${r.requester_phone}`);
  assert((await usersCount()) === before, 'users count changed on public submit');
  openCtx.first = { token, id };
  const st = await api('GET', `/order-request/status/${token}`, null);
  assert(st.status === 200 && st.body.data.status === 'pending', `Status ${st.status} ${JSON.stringify(st.body)}`);
  assert(Array.isArray(st.body.data.items_summary) && st.body.data.items_summary[0].quantity === 2, `items_summary ${JSON.stringify(st.body.data.items_summary)}`);
  const raw = JSON.stringify(st.body);
  assert(!raw.includes(openCtx.phone) && !raw.includes('9000000001'), 'Status page leaks a phone');
});

check('random status token gives generic 404', async () => {
  const res = await api('GET', `/order-request/status/${'ab'.repeat(24)}`, null);
  assert(res.status === 404 && res.body.success === false && res.body.message === 'Not found', `Got ${res.status} ${JSON.stringify(res.body)}`);
});

check('missing name or a 9-digit phone gives 400 with a plain message', async () => {
  const a = await api('POST', '/order-request/open', null, openBody({ requester_name: '' }));
  const b = await api('POST', '/order-request/open', null, openBody({ requester_phone: '987654321' }));
  assert(a.status === 400 && /name/i.test(a.body.message), `Missing name: ${a.status} ${JSON.stringify(a.body)}`);
  assert(b.status === 400 && /phone/i.test(b.body.message), `9-digit phone: ${b.status} ${JSON.stringify(b.body)}`);
});

check('resolve-customer: new phone creates one customer, second call returns the same id', async () => {
  const owner = await slipOwner();
  const before = await usersCount();
  const list = await api('GET', '/order-requests?status=pending&limit=100', owner.token);
  const row = list.body.data.requests.find((r) => r.id === openCtx.first.id);
  assert(row && row.matched_customer === null && row.source === 'general_link' && row.requester_name === 'Open Link Tester', `List row ${JSON.stringify(row)}`);
  const r1 = await api('POST', `/order-requests/${openCtx.first.id}/resolve-customer`, owner.token);
  assert(r1.status === 200 && r1.body.data.created === true && r1.body.data.customer_id, `First resolve ${r1.status} ${JSON.stringify(r1.body)}`);
  const r2 = await api('POST', `/order-requests/${openCtx.first.id}/resolve-customer`, owner.token);
  assert(r2.status === 200 && r2.body.data.created === false && r2.body.data.customer_id === r1.body.data.customer_id, `Second resolve ${JSON.stringify(r2.body)}`);
  assert((await usersCount()) === before + 1, 'Expected exactly one new user');
  const db = await getDb();
  const u = await db.prepare('SELECT role, phone, name FROM users WHERE id = ?').get(r1.body.data.customer_id);
  assert(u.role === 'customer' && u.phone === openCtx.phone && u.name === 'Open Link Tester', `User ${JSON.stringify(u)}`);
  const req = await db.prepare('SELECT customer_id FROM order_requests WHERE id = ?').get(openCtx.first.id);
  assert(req.customer_id === r1.body.data.customer_id, 'customer_id not set on request');
  openCtx.customerId = r1.body.data.customer_id;
});

check('a second open request in +91 format resolves to the same customer; tokens do not cross', async () => {
  const owner = await slipOwner();
  const p = openCtx.phone;
  const { res, token, id } = await submitOpen({ requester_phone: `+91 ${p.slice(0, 5)} ${p.slice(5)}`, requester_name: 'Open Tester Again' });
  assert(res.status === 201, `Submit ${res.status} ${JSON.stringify(res.body)}`);
  assert(id && id !== openCtx.first.id && token !== openCtx.first.token, 'Second submit reused the first request or token');
  const list = await api('GET', '/order-requests?status=pending&limit=100', owner.token);
  const row = list.body.data.requests.find((r) => r.id === id);
  assert(row && row.matched_customer && row.matched_customer.id === openCtx.customerId, `matched_customer ${JSON.stringify(row && row.matched_customer)}`);
  const r = await api('POST', `/order-requests/${id}/resolve-customer`, owner.token);
  assert(r.status === 200 && r.body.data.customer_id === openCtx.customerId && r.body.data.created === false, `Resolve ${JSON.stringify(r.body)}`);
});

check('an existing customer stored as "+91 xxxxx xxxxx" is matched by a 0-prefixed phone', async () => {
  const owner = await slipOwner();
  const p = await freeTestPhone('98764');
  const db = await getDb();
  const ins = await db.prepare("INSERT INTO users (name, phone, password, role) VALUES ('Open Legacy Format', ?, 'x', 'customer')").run(`+91 ${p.slice(0, 5)} ${p.slice(5)}`);
  const { res, id } = await submitOpen({ requester_phone: `0${p.slice(0, 5)} ${p.slice(5)}` });
  assert(res.status === 201, `Submit ${res.status} ${JSON.stringify(res.body)}`);
  const before = await usersCount();
  const r = await api('POST', `/order-requests/${id}/resolve-customer`, owner.token);
  assert(r.status === 200 && r.body.data.customer_id === ins.lastInsertRowid && r.body.data.created === false, `Resolve ${JSON.stringify(r.body)}`);
  assert((await usersCount()) === before, 'users count changed');
});

check('declining an unresolved open request leaves users unchanged', async () => {
  const owner = await slipOwner();
  openCtx.phone = await freeTestPhone('98763');
  const { res, token, id } = await submitOpen();
  assert(res.status === 201, `Submit ${res.status}`);
  const before = await usersCount();
  const d = await api('PUT', `/order-requests/${id}/decline`, owner.token, { reason: 'Out of stock' });
  assert(d.status === 200, `Decline ${d.status} ${JSON.stringify(d.body)}`);
  assert((await usersCount()) === before, 'users count changed on decline');
  const db = await getDb();
  const row = await db.prepare('SELECT customer_id FROM order_requests WHERE id = ?').get(id);
  assert(row.customer_id === null, 'customer_id set on decline');
  const st = await api('GET', `/order-request/status/${token}`, null);
  assert(st.body.data.status === 'declined' && st.body.data.decline_reason === 'Out of stock', `Status ${JSON.stringify(st.body)}`);
  // Another request's token never returns this one: the first request is still pending.
  const other = await api('GET', `/order-request/status/${openCtx.first.token}`, null);
  assert(other.status === 200 && other.body.data.status === 'pending' && other.body.data.decline_reason === null, `Other token ${JSON.stringify(other.body)}`);
});

check('resolve-customer rejects a rider (403)', async () => {
  const rider = await api('POST', `/order-requests/${openCtx.first.id}/resolve-customer`, mintToken(8));
  assert(rider.status === 403, `Rider expected 403, got ${rider.status}`);
});

check('resolve-customer on a staff phone gives a plain 409 and creates nobody', async () => {
  const owner = await slipOwner();
  const db = await getDb();
  const ownerPhone = (await db.prepare('SELECT phone FROM users WHERE id = ?').get(owner.id)).phone;
  const { res, id } = await submitOpen({ requester_phone: ownerPhone });
  assert(res.status === 201, `Submit ${res.status}`);
  const before = await usersCount();
  const r = await api('POST', `/order-requests/${id}/resolve-customer`, owner.token);
  assert(r.status === 409 && /staff/i.test(r.body.message), `Expected 409 staff message, got ${r.status} ${JSON.stringify(r.body)}`);
  assert((await usersCount()) === before, 'users count changed');
  const row = await db.prepare('SELECT customer_id FROM order_requests WHERE id = ?').get(id);
  assert(row.customer_id === null, 'customer_id set despite 409');
});

async function cleanupOpenRequests() {
  const db = await getDb();
  for (const id of openCtx.requestIds) {
    try { await db.prepare('DELETE FROM order_requests WHERE id = ?').run(id); } catch (e) { console.log(`   cleanup request ${id}: ${e.message}`); }
  }
  for (const p of openCtx.phones) {
    try {
      await db.prepare("DELETE FROM users WHERE role = 'customer' AND regexp_replace(phone, '[^0-9]', '', 'g') LIKE ? AND name IN ('Open Link Tester', 'Open Tester Again', 'Open Legacy Format')").run(`%${p}`);
    } catch (e) { console.log(`   cleanup phone ${p}: ${e.message}`); }
  }
}

// Must stay last: it exhausts this process's public slip budget.
check('61 rapid public slip GETs hit the 60/min limiter (429)', async () => {
  const owner = await slipOwner();
  const s = await createSlipSale(owner.token, 'pickup');
  const statuses = await Promise.all(Array.from({ length: 61 }, () => api('GET', `/slip/${s.token}`, null).then((r) => r.status)));
  assert(statuses.includes(429), `No 429 in 61 requests: ${[...new Set(statuses)].join(',')}`);
});

async function main() {
  assertLocalTarget();
  let pass = 0, fail = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      console.log(`PASS ${name}`);
      pass++;
    } catch (err) {
      console.log(`FAIL ${name}`);
      console.log(`   ${err.message}`);
      fail++;
    }
  }
  await cleanup();
  await cleanupOpenRequests();
  console.log(`\n${pass}/${pass + fail} checks passed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
