#!/usr/bin/env node
/**
 * Live verification of the Expense Book (items, suggestions, history).
 * Append checks with check(name, fn); register anything you create in the
 * cleanup registry (createdItemIds / createdExpenseIds / createdRegisterIds).
 * Test rows are named with the VerifyEB prefix.
 *
 * Usage: source test-env.sh; node server/scripts/verify-expense-book.js
 */
require('dotenv').config();
const jwt = require('jsonwebtoken');
const { getDb } = require('../config/database-async');

const API_BASE = process.env.API_BASE_URL || 'http://localhost:3001/api';
const TEST_LOCATION_ID = 4; // Test Loc

const checks = [];
const createdItemIds = [];
const createdExpenseIds = [];
const createdRegisterIds = [];

function check(name, fn) { checks.push({ name, fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

function assertLocalTarget() {
  const isLocal = (u) => { try { const h = new URL(u).hostname; return h === 'localhost' || h === '127.0.0.1'; } catch { return false; } };
  const bad = [];
  if (!isLocal(API_BASE)) bad.push('API_BASE_URL');
  if (!isLocal(process.env.DATABASE_URL || '')) bad.push('DATABASE_URL');
  if (bad.length) { console.error(`Refusing to run: ${bad.join(', ')} not local.`); process.exit(1); }
}

// Token for a test user without needing a password.
function tokenFor(id) { return jwt.sign({ id }, process.env.JWT_SECRET); }

async function api(method, path, token, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body: json };
}

async function rejects(fn) { try { await fn(); } catch (e) { return e; } return null; }
async function track(item) { if (item && !createdItemIds.includes(item.id)) createdItemIds.push(item.id); return item; }

// ── Task 1: schema and item resolution ──
const { nameKey, resolveItem, rememberOnItem } = require('../utils/expense-items');

check('nameKey trims, lower-cases and squeezes spaces', async () => {
  assert(nameKey('  Petrol  Pump ') === 'petrol pump', 'got ' + nameKey('  Petrol  Pump '));
  assert(nameKey('x'.repeat(100)).length === 80, 'not cut to 80');
});

check('resolveItem creates, then finds the same item by a differently spelled name', async () => {
  const db = await getDb();
  const a = await track(await resolveItem(db, { item_name: 'VerifyEB Petrol', category: 'transport', userId: 7777 }));
  assert(a && a.id && a.category === 'transport', 'not created');
  const b = await track(await resolveItem(db, { item_name: 'verifyeb  petrol', userId: 7777 }));
  assert(b.id === a.id, `different ids ${a.id} vs ${b.id}`);
});

check('a new name without a category is refused in plain words', async () => {
  const e = await rejects(async () => resolveItem(await getDb(), { item_name: 'VerifyEB NoCat', userId: 7777 }));
  assert(e && e.statusCode === 400, 'no 400');
  assert(e.message === 'Pick what kind of expense this is.', 'copy: ' + e.message);
});

check('two parallel resolves of one new name give one item', async () => {
  const db = await getDb();
  const [x, y] = await Promise.all([
    resolveItem(db, { item_name: 'VerifyEB Parallel', category: 'other', userId: 7777 }),
    resolveItem(db, { item_name: 'VerifyEB Parallel', category: 'other', userId: 7777 }),
  ]);
  await track(x);
  assert(x.id === y.id, `ids ${x.id} vs ${y.id}`);
  const n = await db.prepare("SELECT COUNT(*) AS c FROM expense_items WHERE name_key = 'verifyeb parallel'").get();
  assert(Number(n.c) === 1, 'rows: ' + n.c);
});

check('a merged item resolves to its target', async () => {
  const db = await getDb();
  const a = await track(await resolveItem(db, { item_name: 'VerifyEB MergeA', category: 'other', userId: 7777 }));
  const b = await track(await resolveItem(db, { item_name: 'VerifyEB MergeB', category: 'other', userId: 7777 }));
  await db.prepare('UPDATE expense_items SET merged_into = ? WHERE id = ?').run(a.id, b.id);
  const r = await resolveItem(db, { item_name: 'VerifyEB MergeB', userId: 7777 });
  assert(r.id === a.id, `got ${r.id}, wanted ${a.id}`);
  const byId = await resolveItem(db, { item_id: b.id, userId: 7777 });
  assert(byId.id === a.id, 'item_id did not follow merged_into');
});

check('a hidden item resolved by name becomes active again', async () => {
  const db = await getDb();
  const a = await track(await resolveItem(db, { item_name: 'VerifyEB Hidden', category: 'other', userId: 7777 }));
  await db.prepare('UPDATE expense_items SET is_active = FALSE WHERE id = ?').run(a.id);
  const r = await resolveItem(db, { item_name: 'VerifyEB Hidden', userId: 7777 });
  assert(r.id === a.id && r.is_active === true, 'not reactivated');
});

check('rememberOnItem stores usual amount and last given-to', async () => {
  const db = await getDb();
  const a = await track(await resolveItem(db, { item_name: 'VerifyEB Remember', category: 'other', userId: 7777 }));
  await rememberOnItem(db, a.id, { amount: 123.5, given_to_user_id: null, given_to_name: 'VerifyEB Bob' });
  const r = await db.prepare('SELECT usual_amount, last_given_to_name FROM expense_items WHERE id = ?').get(a.id);
  assert(Number(r.usual_amount) === 123.5 && r.last_given_to_name === 'VerifyEB Bob', JSON.stringify(r));
});

// ── Task 2: add and change with item, note, photo, Given to, back-dating ──
const OWNER_ID = 7777, COUNTER_ID = 7778, CUSTOMER_ID = 7779, HELPER_ID = 6783;
const GIVEN_TO_COPY = "That person can't be picked here. Tap Given to and pick again.";
const DATE_COPY = 'Only the owner or a manager can enter an expense for another day.';
const createdUserIds = [];
let riderId = null;

function shopDay(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

async function ensureRider() {
  if (riderId) return riderId;
  const db = await getDb();
  const row = await db.prepare(
    "INSERT INTO users (phone, password, name, role, is_active) VALUES (?, 'x', 'VerifyEB Rider', 'delivery_partner', 1) RETURNING id"
  ).get('9' + String(Date.now()).slice(-9));
  riderId = row.id;
  createdUserIds.push(riderId);
  await db.prepare('INSERT INTO user_locations (user_id, location_id) VALUES (?, ?)').run(riderId, TEST_LOCATION_ID);
  return riderId;
}

async function addExpense(token, body) {
  const r = await api('POST', '/expenses', token, { location_id: TEST_LOCATION_ID, expense_date: shopDay(), ...body });
  if (r.body && r.body.data && r.body.data.id) createdExpenseIds.push(r.body.data.id);
  if (r.body && r.body.data && r.body.data.item_id && !createdItemIds.includes(r.body.data.item_id)) createdItemIds.push(r.body.data.item_id);
  return r;
}

let teaItemId = null;
check('counter staff adds by item name: 201, item_name and description are the item', async () => {
  const r = await addExpense(tokenFor(COUNTER_ID), { item_name: 'VerifyEB Tea', category: 'food', amount: 60, payment_method: 'upi' });
  assert(r.status === 201, `status ${r.status} ${JSON.stringify(r.body)}`);
  assert(r.body.data.item_name === 'VerifyEB Tea', 'item_name ' + r.body.data.item_name);
  assert(r.body.data.description === 'VerifyEB Tea', 'description ' + r.body.data.description);
  assert(r.body.data.item_id, 'no item_id');
  teaItemId = r.body.data.item_id;
});

check('the same name in other case reuses the item', async () => {
  const r = await addExpense(tokenFor(COUNTER_ID), { item_name: 'verifyeb tea', amount: 40, payment_method: 'upi' });
  assert(r.status === 201, `status ${r.status} ${JSON.stringify(r.body)}`);
  assert(r.body.data.item_id === teaItemId, `item ${r.body.data.item_id} vs ${teaItemId}`);
  assert(r.body.data.category === 'food', 'category did not default to the item: ' + r.body.data.category);
});

check('a note is added to the description and kept on its own', async () => {
  const r = await addExpense(tokenFor(COUNTER_ID), { item_name: 'VerifyEB Tea', amount: 50, payment_method: 'upi', note: 'for Sharma wedding' });
  assert(r.status === 201, `status ${r.status} ${JSON.stringify(r.body)}`);
  assert(r.body.data.description === 'VerifyEB Tea — for Sharma wedding', 'description ' + r.body.data.description);
  assert(r.body.data.note === 'for Sharma wedding', 'note ' + r.body.data.note);
});

check('Given to a rider at the shop is saved and remembered on the item', async () => {
  const rider = await ensureRider();
  const r = await addExpense(tokenFor(COUNTER_ID), { item_name: 'VerifyEB Petrol2', category: 'transport', amount: 200, payment_method: 'upi', given_to_user_id: rider });
  assert(r.status === 201, `status ${r.status} ${JSON.stringify(r.body)}`);
  assert(r.body.data.given_to_user_id === rider, 'given_to_user_id ' + r.body.data.given_to_user_id);
  assert(r.body.data.given_to_display === 'VerifyEB Rider', 'display ' + r.body.data.given_to_display);
  const db = await getDb();
  const it = await db.prepare('SELECT last_given_to_user_id, usual_amount FROM expense_items WHERE id = ?').get(r.body.data.item_id);
  assert(it.last_given_to_user_id === rider, 'item last_given_to ' + it.last_given_to_user_id);
  assert(Number(it.usual_amount) === 200, 'usual_amount ' + it.usual_amount);
});

check('Given to a customer is refused with the plain copy', async () => {
  const r = await addExpense(tokenFor(COUNTER_ID), { item_name: 'VerifyEB Tea', amount: 10, payment_method: 'upi', given_to_user_id: CUSTOMER_ID });
  assert(r.status === 400, `status ${r.status}`);
  assert(r.body.message === GIVEN_TO_COPY, 'copy: ' + r.body.message);
});

check('both Given to fields: only the user id is kept', async () => {
  const rider = await ensureRider();
  const r = await addExpense(tokenFor(COUNTER_ID), { item_name: 'VerifyEB Tea', amount: 15, payment_method: 'upi', given_to_user_id: rider, given_to_name: 'VerifyEB Someone' });
  assert(r.status === 201, `status ${r.status} ${JSON.stringify(r.body)}`);
  assert(r.body.data.given_to_user_id === rider && r.body.data.given_to_name == null, JSON.stringify(r.body.data));
});

check('a free Given to name is saved and shown', async () => {
  const r = await addExpense(tokenFor(COUNTER_ID), { item_name: 'VerifyEB Tea', amount: 15, payment_method: 'upi', given_to_name: 'VerifyEB Plumber' });
  assert(r.status === 201, `status ${r.status}`);
  assert(r.body.data.given_to_name === 'VerifyEB Plumber' && r.body.data.given_to_display === 'VerifyEB Plumber', JSON.stringify(r.body.data));
});

check('counter staff cannot enter another day; the owner can', async () => {
  const y = shopDay(-1);
  const r = await addExpense(tokenFor(COUNTER_ID), { item_name: 'VerifyEB Tea', amount: 20, payment_method: 'upi', expense_date: y });
  assert(r.status === 403, `staff status ${r.status}`);
  assert(r.body.message === DATE_COPY, 'copy: ' + r.body.message);
  const o = await addExpense(tokenFor(OWNER_ID), { item_name: 'VerifyEB Tea', amount: 20, payment_method: 'upi', expense_date: y });
  assert(o.status === 201, `owner status ${o.status} ${JSON.stringify(o.body)}`);
  assert(o.body.data.expense_date === y, 'date ' + o.body.data.expense_date);
});

check('a description-only add (old app) still works with no item', async () => {
  const r = await addExpense(tokenFor(COUNTER_ID), { category: 'other', amount: 25, payment_method: 'upi', description: 'VerifyEB old client' });
  assert(r.status === 201, `status ${r.status} ${JSON.stringify(r.body)}`);
  assert(r.body.data.item_id === null, 'item_id ' + r.body.data.item_id);
  assert(r.body.data.description === 'VerifyEB old client', 'description ' + r.body.data.description);
});

check('a photo must be a local upload path', async () => {
  const bad = await addExpense(tokenFor(COUNTER_ID), { item_name: 'VerifyEB Tea', amount: 5, payment_method: 'upi', photo_url: 'https://evil.example/x.png' });
  assert(bad.status === 400, `bad status ${bad.status}`);
  const good = await addExpense(tokenFor(COUNTER_ID), { item_name: 'VerifyEB Tea', amount: 5, payment_method: 'upi', photo_url: '/uploads/x.png' });
  assert(good.status === 201, `good status ${good.status} ${JSON.stringify(good.body)}`);
  assert(good.body.data.photo_url === '/uploads/x.png', 'photo ' + good.body.data.photo_url);
});

check('an empty item name is refused with the plain copy', async () => {
  const r = await addExpense(tokenFor(COUNTER_ID), { item_name: '   ', category: 'food', amount: 5, payment_method: 'upi' });
  assert(r.status === 400, `status ${r.status}`);
  assert(r.body.message === 'Type what this was for, like Petrol.', 'copy: ' + r.body.message);
});

check('PUT (owner) changes item, note and Given to; counter staff cannot move the date', async () => {
  const add = await addExpense(tokenFor(COUNTER_ID), { item_name: 'VerifyEB Tea', amount: 30, payment_method: 'upi' });
  const id = add.body.data.id;
  const r = await api('PUT', `/expenses/${id}`, tokenFor(OWNER_ID), { item_name: 'VerifyEB Snacks', category: 'food', note: 'evening', given_to_name: 'VerifyEB Boy' });
  assert(r.status === 200, `status ${r.status} ${JSON.stringify(r.body)}`);
  if (r.body.data.item_id && !createdItemIds.includes(r.body.data.item_id)) createdItemIds.push(r.body.data.item_id);
  assert(r.body.data.item_name === 'VerifyEB Snacks' && r.body.data.description === 'VerifyEB Snacks — evening', JSON.stringify(r.body.data));
  assert(r.body.data.given_to_display === 'VerifyEB Boy', 'display ' + r.body.data.given_to_display);
  const d = await api('PUT', `/expenses/${id}`, tokenFor(COUNTER_ID), { expense_date: shopDay(-2) });
  assert(d.status === 403 && d.body.message === DATE_COPY, `date move ${d.status} ${d.body && d.body.message}`);
});

check('Review Focus 2: back-dating a closed-session cash expense keeps its register and totals', async () => {
  const owner = tokenFor(OWNER_ID);
  const st = await api('GET', `/sales/register/status?location_id=${TEST_LOCATION_ID}`, owner);
  assert(!(st.body && st.body.isOpen), 'Test Loc already has a register open; close it in the app first.');
  const op = await api('POST', '/sales/register/open', owner, { location_id: TEST_LOCATION_ID, opening_balance: 500 });
  assert(op.status === 201, `open ${op.status} ${JSON.stringify(op.body)}`);
  const regId = op.body.data.id;
  createdRegisterIds.push(regId);
  const add = await addExpense(owner, { item_name: 'VerifyEB Cash', category: 'other', amount: 100, payment_method: 'cash' });
  assert(add.status === 201 && add.body.data.register_id === regId, `add ${add.status} ${JSON.stringify(add.body)}`);
  const cl = await api('PUT', '/sales/register/close', owner, { location_id: TEST_LOCATION_ID, actual_cash: 390 });
  assert(cl.status === 200, `close ${cl.status} ${JSON.stringify(cl.body)}`);
  const db = await getDb();
  const before = await db.prepare('SELECT expected_cash, discrepancy FROM cash_registers WHERE id = ?').get(regId);
  const back = shopDay(-3);
  const r = await api('PUT', `/expenses/${add.body.data.id}`, owner, { expense_date: back });
  assert(r.status === 200, `put ${r.status} ${JSON.stringify(r.body)}`);
  assert(r.body.data.expense_date === back, 'date ' + r.body.data.expense_date);
  assert(r.body.data.register_id === regId, 'register moved to ' + r.body.data.register_id);
  const after = await db.prepare('SELECT expected_cash, discrepancy FROM cash_registers WHERE id = ?').get(regId);
  assert(Number(after.expected_cash) === Number(before.expected_cash), `expected_cash ${before.expected_cash} -> ${after.expected_cash}`);
  assert(Number(after.discrepancy) === Number(before.discrepancy), `discrepancy ${before.discrepancy} -> ${after.discrepancy}`);
});

check('GET /people: staff and riders of the shop, id/name/role only; helpers refused', async () => {
  const rider = await ensureRider();
  const r = await api('GET', `/expenses/people?location_id=${TEST_LOCATION_ID}`, tokenFor(COUNTER_ID));
  assert(r.status === 200, `status ${r.status} ${JSON.stringify(r.body)}`);
  const rows = r.body.data;
  assert(Array.isArray(rows), 'not a list');
  assert(rows.some((p) => p.id === rider), 'rider missing');
  assert(rows.some((p) => p.id === 8447 && p.role === 'florist_staff'), 'florist missing');
  assert(!rows.some((p) => p.id === CUSTOMER_ID || p.role === 'customer' || p.role === 'helper'), 'customer or helper listed');
  for (const p of rows) assert(Object.keys(p).sort().join(',') === 'id,name,role', 'extra fields: ' + Object.keys(p).join(','));
  const h = await api('GET', `/expenses/people?location_id=${TEST_LOCATION_ID}`, tokenFor(HELPER_ID));
  assert(h.status === 403, `helper status ${h.status}`);
});

check('florist staff still cannot add an expense', async () => {
  const r = await addExpense(tokenFor(8447), { item_name: 'VerifyEB Tea', amount: 5, payment_method: 'upi' });
  assert(r.status === 403, `status ${r.status}`);
});

// ── Task 3: quick suggestions and type-ahead ──
async function mkItem(db, name, cols = {}) {
  const row = await db.prepare(
    'INSERT INTO expense_items (name, name_key, category, pinned, pin_order, is_active, merged_into, usual_amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id'
  ).get(name, nameKey(name), 'other', !!cols.pinned, cols.pin_order == null ? null : cols.pin_order, cols.is_active === false ? false : true, cols.merged_into || null, cols.usual_amount == null ? null : cols.usual_amount);
  createdItemIds.push(row.id);
  return row.id;
}
async function useItem(db, itemId, times, locationId) {
  for (let i = 0; i < times; i++) {
    const r = await db.prepare(
      "INSERT INTO expenses (location_id, category, description, amount, payment_method, expense_date, item_id, created_by) VALUES (?, 'other', 'VerifyEB use', 10, 'upi', ?, ?, ?) RETURNING id"
    ).get(locationId, shopDay(-1), itemId, OWNER_ID);
    createdExpenseIds.push(r.id);
  }
}

let sg = null;
async function suggestFixture() {
  if (sg) return sg;
  const db = await getDb();
  const mergedTarget = await mkItem(db, 'VerifyEB Pe Target');
  sg = {
    p1: await mkItem(db, 'VerifyEB Pe Pin One', { pinned: true, pin_order: -2 }),
    p2: await mkItem(db, 'VerifyEB Pe Pin Two', { pinned: true, pin_order: -3 }),
    f: await mkItem(db, 'VerifyEB Pe Often'),
    contains: await mkItem(db, 'VerifyEB Xx Pe Inside', { usual_amount: 75 }),
    g: await mkItem(db, 'VerifyEB Pe Other Shop'),
    h: await mkItem(db, 'VerifyEB Pe Hidden', { is_active: false }),
    m: await mkItem(db, 'VerifyEB Pe Merged', { merged_into: mergedTarget }),
  };
  await useItem(db, sg.f, 3, TEST_LOCATION_ID);
  await useItem(db, sg.contains, 1, TEST_LOCATION_ID);
  await useItem(db, sg.g, 5, 3);
  return sg;
}

check('suggest: empty q gives pinned by pin order, then used items; not other shop, hidden or merged', async () => {
  const f = await suggestFixture();
  const r = await api('GET', `/expenses/suggest?location_id=${TEST_LOCATION_ID}`, tokenFor(COUNTER_ID));
  assert(r.status === 200, `status ${r.status} ${JSON.stringify(r.body)}`);
  const ids = r.body.data.map((x) => x.id);
  assert(ids[0] === f.p2 && ids[1] === f.p1, 'pinned order: ' + ids.slice(0, 3).join(','));
  assert(ids.indexOf(f.f) >= 2, 'used item missing or before pinned');
  for (const bad of [f.g, f.h, f.m]) assert(!ids.includes(bad), 'unexpected item ' + bad);
  assert(ids.length <= 8, 'more than 8');
  const one = r.body.data[0];
  assert(['id', 'name', 'category', 'usual_amount', 'last_given_to'].every((k) => k in one), 'shape ' + Object.keys(one));
});

check('suggest: type-ahead puts prefix matches before contains matches, none hidden or merged', async () => {
  const f = await suggestFixture();
  const r = await api('GET', `/expenses/suggest?location_id=${TEST_LOCATION_ID}&q=${encodeURIComponent('verifyeb pe')}`, tokenFor(COUNTER_ID));
  assert(r.status === 200, `status ${r.status}`);
  const ids = r.body.data.map((x) => x.id);
  assert(ids.includes(f.f) && ids.includes(f.contains), 'matches missing');
  assert(!ids.includes(f.h) && !ids.includes(f.m), 'hidden or merged shown');
  assert(ids.indexOf(f.f) < ids.indexOf(f.contains), 'prefix not before contains');
  const c = r.body.data.find((x) => x.id === f.contains);
  assert(Number(c.usual_amount) === 75, 'usual_amount ' + c.usual_amount);
});

check('suggest: a wildcard in q is taken literally; at most 8; location required', async () => {
  const db = await getDb();
  for (let i = 0; i < 10; i++) await mkItem(db, 'VerifyEB Many ' + i);
  const r = await api('GET', `/expenses/suggest?location_id=${TEST_LOCATION_ID}&q=verifyeb`, tokenFor(OWNER_ID));
  assert(r.status === 200 && r.body.data.length === 8, 'len ' + (r.body.data && r.body.data.length));
  const w = await api('GET', `/expenses/suggest?location_id=${TEST_LOCATION_ID}&q=%25`, tokenFor(OWNER_ID));
  assert(w.status === 200 && w.body.data.length === 0, 'wildcard matched ' + (w.body.data && w.body.data.length));
  const n = await api('GET', '/expenses/suggest', tokenFor(OWNER_ID));
  assert(n.status === 400 && n.body.message === 'Pick a shop first.', `no shop ${n.status}`);
});

check('suggest: last_given_to shows the user name or the free name; helpers refused', async () => {
  const f = await suggestFixture();
  const rider = await ensureRider();
  const db = await getDb();
  await db.prepare('UPDATE expense_items SET last_given_to_user_id = ? WHERE id = ?').run(rider, f.p1);
  await db.prepare("UPDATE expense_items SET last_given_to_name = 'VerifyEB Plumber2' WHERE id = ?").run(f.p2);
  const r = await api('GET', `/expenses/suggest?location_id=${TEST_LOCATION_ID}`, tokenFor(COUNTER_ID));
  const a = r.body.data.find((x) => x.id === f.p1), b = r.body.data.find((x) => x.id === f.p2);
  assert(a.last_given_to && a.last_given_to.user_id === rider && a.last_given_to.display_name === 'VerifyEB Rider', JSON.stringify(a.last_given_to));
  assert(b.last_given_to && b.last_given_to.name === 'VerifyEB Plumber2' && b.last_given_to.display_name === 'VerifyEB Plumber2', JSON.stringify(b.last_given_to));
  const h = await api('GET', `/expenses/suggest?location_id=${TEST_LOCATION_ID}`, tokenFor(HELPER_ID));
  assert(h.status === 403, 'helper ' + h.status);
});

async function cleanup() {
  const db = await getDb();
  for (const id of createdExpenseIds) {
    try { await db.prepare('DELETE FROM expenses WHERE id = ?').run(id); } catch (e) { console.error('cleanup expense', id, e.message); }
  }
  for (const id of createdRegisterIds) {
    try { await db.prepare('DELETE FROM cash_registers WHERE id = ?').run(id); } catch (e) { console.error('cleanup register', id, e.message); }
  }
  for (const id of createdUserIds) {
    try {
      await db.prepare('UPDATE expense_items SET last_given_to_user_id = NULL WHERE last_given_to_user_id = ?').run(id);
      await db.prepare('DELETE FROM user_locations WHERE user_id = ?').run(id);
      await db.prepare('DELETE FROM users WHERE id = ?').run(id);
    } catch (e) { console.error('cleanup user', id, e.message); }
  }
  try {
    await db.prepare("UPDATE expenses SET item_id = NULL WHERE item_id IN (SELECT id FROM expense_items WHERE name LIKE 'VerifyEB%')").run();
    await db.prepare("UPDATE expense_items SET merged_into = NULL WHERE name LIKE 'VerifyEB%'").run();
    await db.prepare("DELETE FROM expense_items WHERE name LIKE 'VerifyEB%'").run();
  } catch (e) { console.error('cleanup items:', e.message); }
}

async function main() {
  assertLocalTarget();
  let pass = 0, fail = 0;
  try {
    for (const { name, fn } of checks) {
      try { await fn(); console.log(`PASS ${name}`); pass++; }
      catch (err) { console.log(`FAIL ${name}\n   ${err.message}`); fail++; }
    }
  } finally {
    await cleanup();
  }
  console.log(`\n${pass}/${pass + fail} checks passed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
