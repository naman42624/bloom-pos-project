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
  const mergedTarget = await mkItem(db, 'VerifyEB Zq Target');
  sg = {
    p1: await mkItem(db, 'VerifyEB Zq Pin One', { pinned: true, pin_order: -2 }),
    p2: await mkItem(db, 'VerifyEB Zq Pin Two', { pinned: true, pin_order: -3 }),
    f: await mkItem(db, 'Zq VerifyEB Often'),
    contains: await mkItem(db, 'VerifyEB Xx Zq Inside', { usual_amount: 75 }),
    g: await mkItem(db, 'VerifyEB Zq Other Shop'),
    h: await mkItem(db, 'VerifyEB Zq Hidden', { is_active: false }),
    m: await mkItem(db, 'VerifyEB Zq Merged', { merged_into: mergedTarget }),
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
  assert(ids.includes(f.f) && ids.indexOf(f.f) > ids.indexOf(f.p1) && ids.indexOf(f.f) > ids.indexOf(f.p2), 'used item missing or before pinned');
  for (const bad of [f.g, f.h, f.m]) assert(!ids.includes(bad), 'unexpected item ' + bad);
  assert(ids.length <= 8, 'more than 8');
  const one = r.body.data[0];
  assert(['id', 'name', 'category', 'usual_amount', 'last_given_to'].every((k) => k in one), 'shape ' + Object.keys(one));
});

check('suggest: type-ahead puts prefix matches before contains matches, none hidden or merged', async () => {
  const f = await suggestFixture();
  const r = await api('GET', `/expenses/suggest?location_id=${TEST_LOCATION_ID}&q=${encodeURIComponent('zq')}`, tokenFor(COUNTER_ID));
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

// ── Task 4: list filters and the staff 7-day limit ──
const dayAgo = (n) => require('../utils/time').todayStr(new Date(Date.now() - n * 86400000));
let listFx = null;
async function listFixtures() {
  if (listFx) return listFx;
  const db = await getDb();
  const item = await track(await resolveItem(db, { item_name: 'VerifyEB ListItem', category: 'other', userId: OWNER_ID }));
  const mk = async (loc, date, desc, extra = {}) => {
    const r = await db.prepare(`INSERT INTO expenses (location_id, category, amount, description, payment_method, expense_date, created_by, item_id, note, given_to_user_id, given_to_name)
      VALUES (?, 'other', 5, ?, 'upi', ?, ?, ?, ?, ?, ?) RETURNING id`)
      .get(loc, desc, date, extra.by || OWNER_ID, extra.item || null, extra.note || null, extra.givenUser || null, extra.givenName || null);
    createdExpenseIds.push(r.id);
    return r.id;
  };
  listFx = {
    item,
    recent: await mk(TEST_LOCATION_ID, dayAgo(2), 'VerifyEB recent', { item: item.id, givenUser: 8117, by: COUNTER_ID }),
    old: await mk(TEST_LOCATION_ID, dayAgo(20), 'VerifyEB old backdated', { note: 'paid to Sharma ji' }),
    edge: await mk(TEST_LOCATION_ID, dayAgo(6), 'VerifyEB edge', { givenName: 'Ramu' }),
    cut: await mk(TEST_LOCATION_ID, dayAgo(7), 'VerifyEB cut'),
    other: await mk(3, dayAgo(1), 'VerifyEB other shop'),
  };
  return listFx;
}
const ownerT = () => tokenFor(OWNER_ID);
const counterT = () => tokenFor(COUNTER_ID);

check('staff list is limited to the last 7 days and says so', async () => {
  const fx = await listFixtures();
  const r = await api('GET', `/expenses?start_date=${dayAgo(30)}&location_id=${TEST_LOCATION_ID}&q=VerifyEB`, counterT());
  assert(r.status === 200, 'status ' + r.status);
  assert(r.body.limited_to_days === 7, 'limited_to_days ' + r.body.limited_to_days);
  const ids = r.body.data.map((x) => x.id);
  assert(r.body.data.every((x) => String(x.expense_date).slice(0, 10) >= dayAgo(6)), 'older row leaked');
  assert(ids.includes(fx.recent) && ids.includes(fx.edge), 'missing in-window rows');
  assert(!ids.includes(fx.old) && !ids.includes(fx.cut), 'old rows present');
});

check('staff asking for a shop they are not linked to see only their own shops', async () => {
  const fx = await listFixtures();
  const r = await api('GET', `/expenses?location_id=3&q=VerifyEB`, counterT());
  assert(r.status === 200, 'status ' + r.status);
  assert(r.body.data.every((x) => Number(x.location_id) === TEST_LOCATION_ID), 'other shop rows');
  assert(!r.body.data.some((x) => x.id === fx.other), 'other shop fixture leaked');
});

check('owner gets the back-dated row and no staff limit', async () => {
  const fx = await listFixtures();
  const r = await api('GET', `/expenses?start_date=${dayAgo(30)}&q=VerifyEB`, ownerT());
  assert(r.body.limited_to_days === undefined, 'limited_to_days set for owner');
  const ids = r.body.data.map((x) => x.id);
  assert(ids.includes(fx.old) && ids.includes(fx.other), 'owner missing rows');
});

check('item_id and given_to_user_id filters return only matching rows', async () => {
  const fx = await listFixtures();
  const a = await api('GET', `/expenses?item_id=${fx.item.id}`, ownerT());
  assert(a.body.data.length === 1 && a.body.data[0].id === fx.recent, 'item filter rows ' + a.body.data.length);
  assert(a.body.data[0].item_name === 'VerifyEB ListItem', 'item_name ' + a.body.data[0].item_name);
  assert(a.body.data[0].created_by_name, 'created_by_name missing');
  const b = await api('GET', `/expenses?given_to_user_id=8117`, ownerT());
  assert(b.body.data.length >= 1 && b.body.data.every((x) => Number(x.given_to_user_id) === 8117), 'given_to filter');
  assert(b.body.data.every((x) => x.given_to_display), 'given_to_display missing');
  const c = await api('GET', `/expenses?created_by=${COUNTER_ID}&q=VerifyEB%20recent`, ownerT());
  assert(c.body.data.length === 1 && c.body.data[0].id === fx.recent, 'created_by filter');
});

check('q finds the note row and the item name, ignoring case', async () => {
  const fx = await listFixtures();
  const a = await api('GET', `/expenses?q=sharma`, ownerT());
  assert(a.body.data.some((x) => x.id === fx.old), 'note not found');
  const b = await api('GET', `/expenses?q=verifyeb%20listitem`, ownerT());
  assert(b.body.data.some((x) => x.id === fx.recent), 'item name not found');
  const w = await api('GET', `/expenses?q=%25`, ownerT());
  assert(w.body.data.length === 0 || w.body.data.every((x) => /%/.test(`${x.description}${x.note}${x.item_name}`)), 'wildcard not escaped');
});

check('given_to_display falls back to the typed name', async () => {
  const fx = await listFixtures();
  const r = await api('GET', `/expenses?q=VerifyEB%20edge`, ownerT());
  const row = r.body.data.find((x) => x.id === fx.edge);
  assert(row && row.given_to_display === 'Ramu', 'display ' + (row && row.given_to_display));
});

// ── Task 5: period summary and item history ──
const { previousRange, changePct } = require('../utils/expense-book');
const { todayStr: shopToday } = require('../utils/time');

check('previousRange and changePct', async () => {
  const r = previousRange('2026-11-01', '2026-11-13');
  assert(r.from === '2026-10-19' && r.to === '2026-10-31', JSON.stringify(r));
  assert(changePct(110, 100) === 10, 'pct');
  assert(changePct(50, 0) === null, 'null pct');
});

let sumFx = null;
async function summaryFixtures() {
  if (sumFx) return sumFx;
  const db = await getDb();
  const X = await track(await resolveItem(db, { item_name: 'VerifyEB SumX', category: 'supplies', userId: OWNER_ID }));
  const W = await track(await resolveItem(db, { item_name: 'VerifyEB SumW', category: 'supplies', userId: OWNER_ID }));
  const Z = await track(await resolveItem(db, { item_name: 'VerifyEB SumZ', category: 'supplies', userId: OWNER_ID }));
  const mk = async (date, amount, item, desc, ret = 0, cat = 'supplies') => {
    const r = await db.prepare(`INSERT INTO expenses (location_id, category, amount, description, payment_method, expense_date, created_by, item_id, is_return)
      VALUES (?, ?, ?, ?, 'upi', ?, ?, ?, ?) RETURNING id`).get(TEST_LOCATION_ID, cat, amount, desc, date, OWNER_ID, item, ret);
    createdExpenseIds.push(r.id);
    return r.id;
  };
  await mk('2024-03-12', 300, X.id, 'VerifyEB x spend');
  await mk('2024-03-13', 50, X.id, 'VerifyEB x return', 1);
  await mk('2024-03-05', 200, X.id, 'VerifyEB x prev');
  await mk('2024-03-14', 70, Z.id, 'VerifyEB z only');
  await mk('2024-03-15', 40, null, 'VerifyEB no item');
  await mk('2024-03-06', 100, null, 'VerifyEB prev no item');
  await mk('2024-03-07', 60, W.id, 'VerifyEB w prev only');
  sumFx = { X, Z, W };
  return sumFx;
}
const SUM_Q = `from=2024-03-11&to=2024-03-20&location_id=${TEST_LOCATION_ID}`;

check('summary compares with the previous period, nets returns, groups old rows', async () => {
  const { X, Z, W } = await summaryFixtures();
  const r = await api('GET', `/expenses/summary-by-item?${SUM_Q}`, ownerT());
  assert(r.status === 200, 'status ' + r.status);
  const d = r.body.data || r.body;
  const sup = d.categories.find((c) => c.category === 'supplies');
  const x = sup.items.find((i) => i.item_id === X.id);
  assert(x.amount === 250 && x.previous_amount === 200 && x.change_pct === 25, JSON.stringify(x));
  const z = sup.items.find((i) => i.item_id === Z.id);
  assert(z.amount === 70 && z.change_pct === null, JSON.stringify(z));
  const old = d.older.find((o) => o.category === 'supplies');
  assert(old && old.amount === 40 && old.count === 1 && old.previous_amount === 100 && old.change_pct === -60, JSON.stringify(d.older));
  const w = sup.items.find((i) => i.item_id === W.id);
  assert(w && w.amount === 0 && w.previous_amount === 60 && w.change_pct === -100, JSON.stringify(w));
  assert(sup.items[sup.items.length - 1].item_id === W.id, 'previous-only item not last');
  assert(sup.amount === 320 && sup.previous_amount === 260 && sup.change_pct === 23.1, JSON.stringify({ a: sup.amount, p: sup.previous_amount, c: sup.change_pct }));
  const sum = d.categories.reduce((a, c) => a + c.amount, 0) + d.older.reduce((a, o) => a + o.amount, 0);
  assert(Math.abs(sum - d.total) < 0.005, `total ${d.total} vs parts ${sum}`);
  assert(d.previous_total >= 200 && typeof d.total === 'number', 'totals');
  assert(typeof d.unsorted_count === 'number' && d.unsorted_count >= 1, 'unsorted_count');
  for (let i = 1; i < d.categories.length; i += 1) assert(d.categories[i - 1].amount >= d.categories[i].amount, 'not sorted');
});

check('item history gives 6 months and includes merged items', async () => {
  const db = await getDb();
  const X = await track(await resolveItem(db, { item_name: 'VerifyEB HistX', category: 'other', userId: OWNER_ID }));
  const Y = await track(await resolveItem(db, { item_name: 'VerifyEB HistY', category: 'other', userId: OWNER_ID }));
  await db.prepare('UPDATE expense_items SET merged_into = ? WHERE id = ?').run(X.id, Y.id);
  const today = shopToday();
  const mk = async (date, amount, item, desc) => {
    const r = await db.prepare(`INSERT INTO expenses (location_id, category, amount, description, payment_method, expense_date, created_by, item_id)
      VALUES (?, 'other', ?, ?, 'upi', ?, ?, ?) RETURNING id`).get(TEST_LOCATION_ID, amount, desc, date, OWNER_ID, item);
    createdExpenseIds.push(r.id);
    return r.id;
  };
  const here = await mk(today, 100, X.id, 'VerifyEB hist here');
  const merged = await mk(shopToday(new Date(Date.now() - 62 * 86400000)), 30, Y.id, 'VerifyEB hist merged');
  const r = await api('GET', `/expenses/items/${X.id}/history?months=6`, ownerT());
  assert(r.status === 200, 'status ' + r.status);
  const d = r.body.data || r.body;
  assert(d.item.id === X.id, 'item');
  assert(d.months.length === 6, 'months ' + d.months.length);
  assert(d.months[5].month === today.slice(0, 7) && d.months[5].amount === 100, JSON.stringify(d.months[5]));
  assert(d.months.reduce((a, m) => a + m.amount, 0) === 130, 'month sum ' + JSON.stringify(d.months));
  const ids = d.entries.map((e) => e.id);
  assert(ids.includes(here) && ids.includes(merged), 'entries ' + ids);
  assert('item_name' in d.entries[0] && 'created_by_name' in d.entries[0], 'row shape');
  assert(d.months.filter((m) => m.amount === 0).length >= 3, 'zero months kept');
});

check('non-numeric location or person gives a plain 400, not a 500', async () => {
  const a = await api('GET', `/expenses/summary-by-item?from=2024-03-11&to=2024-03-20&location_id=abc`, ownerT());
  const b = await api('GET', `/expenses/items/1/history?location_id=abc`, ownerT());
  const c = await api('GET', `/expenses/items/1/history?given_to_user_id=abc`, ownerT());
  assert(a.status === 400 && b.status === 400 && c.status === 400, `${a.status} ${b.status} ${c.status}`);
  assert(a.body.message === 'Pick a shop first.', a.body.message);
});

check('counter staff cannot read the summary or item history', async () => {
  const a = await api('GET', `/expenses/summary-by-item?${SUM_Q}`, counterT());
  const b = await api('GET', `/expenses/items/1/history`, counterT());
  assert(a.status === 403 && b.status === 403, `${a.status} ${b.status}`);
});

// ── Task 6: owner item tools ──
const MANAGER_ID = 8117;
const managerT = () => tokenFor(MANAGER_ID);
const SALARY_COPY = "Salary items can't be moved to another kind. Use Payroll for salary.";
const MERGE_TARGET_COPY = 'Pick a different item to merge into.';

async function rawExpense(itemId, category, desc) {
  const db = await getDb();
  const r = await db.prepare(`INSERT INTO expenses (location_id, category, amount, description, payment_method, expense_date, created_by, item_id)
    VALUES (?, ?, 10, ?, 'upi', ?, ?, ?) RETURNING id`).get(TEST_LOCATION_ID, category, desc, shopDay(), OWNER_ID, itemId);
  createdExpenseIds.push(r.id);
  return r.id;
}
async function newItem(name, category = 'other') {
  return track(await resolveItem(await getDb(), { item_name: name, category, userId: OWNER_ID }));
}
async function auditCount(itemId, action) {
  const r = await (await getDb()).prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE entity_type = 'expense_item' AND entity_id = ? AND action = ?").get(itemId, action);
  return Number(r.c);
}

check('GET /items lists items with use count; merged ones only with include_hidden', async () => {
  const a = await newItem('VerifyEB ListA');
  const m = await newItem('VerifyEB ListMerged');
  await rawExpense(a.id, 'other', 'VerifyEB list a1');
  await rawExpense(a.id, 'other', 'VerifyEB list a2');
  await (await getDb()).prepare('UPDATE expense_items SET merged_into = ?, is_active = FALSE WHERE id = ?').run(a.id, m.id);
  const r = await api('GET', '/expenses/items?q=verifyeb%20list', ownerT());
  assert(r.status === 200, 'status ' + r.status);
  const row = r.body.data.find((i) => i.id === a.id);
  assert(row && row.use_count === 2 && row.name === 'VerifyEB ListA' && row.category === 'other', JSON.stringify(row));
  for (const k of ['usual_amount', 'pinned', 'pin_order', 'is_active', 'merged_into']) assert(k in row, 'missing ' + k);
  assert(!r.body.data.some((i) => i.id === m.id), 'merged item listed');
  const h = await api('GET', '/expenses/items?q=verifyeb%20list&include_hidden=1', ownerT());
  assert(h.body.data.some((i) => i.id === m.id && i.merged_into === a.id), 'merged item missing with include_hidden');
});

check('renaming to an existing name is refused; a free name renames and updates name_key', async () => {
  await newItem('VerifyEB Tea', 'food');
  const x = await newItem('VerifyEB TeaTypo', 'food');
  const r = await api('PUT', `/expenses/items/${x.id}`, ownerT(), { name: 'verifyeb  tea' });
  assert(r.status === 400, 'status ' + r.status);
  assert(r.body.message === 'There is already an item called VerifyEB Tea. Merge them instead.', 'copy: ' + r.body.message);
  const ok = await api('PUT', `/expenses/items/${x.id}`, ownerT(), { name: 'VerifyEB  Chai ', usual_amount: 25 });
  assert(ok.status === 200, `status ${ok.status} ${JSON.stringify(ok.body)}`);
  const row = await (await getDb()).prepare('SELECT name, name_key, usual_amount FROM expense_items WHERE id = ?').get(x.id);
  assert(row.name === 'VerifyEB Chai' && row.name_key === 'verifyeb chai' && Number(row.usual_amount) === 25, JSON.stringify(row));
  assert(await auditCount(x.id, 'expense_item_update') >= 1, 'no update audit');
});

check('category change moves past rows only with move_past, audited', async () => {
  const it = await newItem('VerifyEB Recat', 'supplies');
  const e1 = await rawExpense(it.id, 'supplies', 'VerifyEB recat 1');
  const e2 = await rawExpense(it.id, 'supplies', 'VerifyEB recat 2');
  const db = await getDb();
  const a = await api('PUT', `/expenses/items/${it.id}`, ownerT(), { category: 'maintenance' });
  assert(a.status === 200, `status ${a.status} ${JSON.stringify(a.body)}`);
  let rows = await db.prepare('SELECT category FROM expenses WHERE id IN (?, ?)').all(e1, e2);
  assert(rows.every((r) => r.category === 'supplies'), 'moved without move_past');
  assert((await db.prepare('SELECT category FROM expense_items WHERE id = ?').get(it.id)).category === 'maintenance', 'item category');
  const b = await api('PUT', `/expenses/items/${it.id}`, ownerT(), { category: 'transport', move_past: true });
  assert(b.status === 200, `status ${b.status} ${JSON.stringify(b.body)}`);
  assert(b.body.data.recategorised === 2, 'recategorised ' + b.body.data.recategorised);
  rows = await db.prepare('SELECT category FROM expenses WHERE id IN (?, ?)').all(e1, e2);
  assert(rows.every((r) => r.category === 'transport'), 'not moved: ' + JSON.stringify(rows));
  assert(await auditCount(it.id, 'expense_item_recategorise') === 1, 'no recategorise audit');
});

check('salary rows are never moved; moving to or from salary is refused', async () => {
  const it = await newItem('VerifyEB SalMix', 'other');
  const sal = await rawExpense(it.id, 'salary', 'VerifyEB salary row');
  const oth = await rawExpense(it.id, 'other', 'VerifyEB other row');
  const db = await getDb();
  const r = await api('PUT', `/expenses/items/${it.id}`, ownerT(), { category: 'food', move_past: true });
  assert(r.status === 200, 'status ' + r.status);
  assert((await db.prepare('SELECT category FROM expenses WHERE id = ?').get(sal)).category === 'salary', 'salary row moved');
  assert((await db.prepare('SELECT category FROM expenses WHERE id = ?').get(oth)).category === 'food', 'other row not moved');
  const to = await api('PUT', `/expenses/items/${it.id}`, ownerT(), { category: 'salary', move_past: true });
  assert(to.status === 400 && to.body.message === SALARY_COPY, `to salary ${to.status} ${to.body && to.body.message}`);
  const s = await newItem('VerifyEB SalItem', 'salary');
  const from = await api('PUT', `/expenses/items/${s.id}`, ownerT(), { category: 'other' });
  assert(from.status === 400 && from.body.message === SALARY_COPY, `from salary ${from.status} ${from.body && from.body.message}`);
  const bad = await api('PUT', `/expenses/items/${it.id}`, ownerT(), { category: 'nonsense' });
  assert(bad.status === 400, 'bad category ' + bad.status);
});

check('PUT /items/pins sets the suggest order', async () => {
  const a = await newItem('VerifyEB PinA');
  const b = await newItem('VerifyEB PinB');
  const r = await api('PUT', '/expenses/items/pins', ownerT(), { ids: [b.id, a.id] });
  assert(r.status === 200, `status ${r.status} ${JSON.stringify(r.body)}`);
  const s = await api('GET', `/expenses/suggest?location_id=${TEST_LOCATION_ID}`, ownerT());
  const ids = s.body.data.map((i) => i.id);
  assert(ids.indexOf(b.id) === 0 && ids.indexOf(a.id) === 1, 'order ' + ids);
  const au = await (await getDb()).prepare("SELECT id, new_state FROM audit_logs WHERE entity_type = 'expense_item' AND entity_id = 0 AND action = 'expense_item_pins' AND user_id = ? ORDER BY id DESC LIMIT 1").get(OWNER_ID);
  assert(au && JSON.stringify(au.new_state.ids) === JSON.stringify([b.id, a.id]), 'pins audit ' + JSON.stringify(au));
  const r2 = await api('PUT', '/expenses/items/pins', ownerT(), { ids: [a.id] });
  assert(r2.status === 200, 'status ' + r2.status);
  const row = await (await getDb()).prepare('SELECT pinned FROM expense_items WHERE id = ?').get(b.id);
  assert(row.pinned === false, 'b still pinned after leaving the list');
  await api('PUT', '/expenses/items/pins', ownerT(), { ids: [] });
});

let mergeFx = null;
check('merge A into B moves rows, marks A merged and hidden, returns moved', async () => {
  const A = await newItem('VerifyEB MgA', 'supplies');
  const B = await newItem('VerifyEB MgB', 'food');
  const C = await newItem('VerifyEB MgC', 'other');
  const e1 = await rawExpense(A.id, 'supplies', 'VerifyEB mg a1');
  const e2 = await rawExpense(A.id, 'supplies', 'VerifyEB mg a2');
  const e3 = await rawExpense(B.id, 'food', 'VerifyEB mg b1');
  const r = await api('POST', `/expenses/items/${A.id}/merge`, ownerT(), { into_id: B.id });
  assert(r.status === 200, `status ${r.status} ${JSON.stringify(r.body)}`);
  assert(r.body.data.moved === 2, 'moved ' + r.body.data.moved);
  const db = await getDb();
  const a = await db.prepare('SELECT merged_into, is_active FROM expense_items WHERE id = ?').get(A.id);
  assert(a.merged_into === B.id && a.is_active === false, JSON.stringify(a));
  const rows = await db.prepare('SELECT item_id, category, description FROM expenses WHERE id IN (?, ?) ORDER BY id').all(e1, e2);
  assert(rows.every((x) => x.item_id === B.id && x.category === 'supplies' && x.description.startsWith('VerifyEB mg a')), JSON.stringify(rows));
  const ma = await db.prepare("SELECT new_state FROM audit_logs WHERE entity_type = 'expense_item' AND entity_id = ? AND action = 'expense_item_merge'").all(A.id);
  assert(ma.length === 1 && ma[0].new_state.moved === 2 && ma[0].new_state.merged_into === B.id, 'merge audit ' + JSON.stringify(ma));
  mergeFx = { A, B, C, all: [e1, e2, e3] };
});

check('merge B into C afterwards: A points at C, every row on C, A resolves to C', async () => {
  const { A, B, C, all } = mergeFx;
  const r = await api('POST', `/expenses/items/${B.id}/merge`, ownerT(), { into_id: C.id });
  assert(r.status === 200 && r.body.data.moved === 3, `status ${r.status} ${JSON.stringify(r.body)}`);
  const db = await getDb();
  const a = await db.prepare('SELECT merged_into FROM expense_items WHERE id = ?').get(A.id);
  assert(a.merged_into === C.id, 'A merged_into ' + a.merged_into);
  const rows = await db.prepare(`SELECT item_id FROM expenses WHERE id IN (${all.map(() => '?').join(',')})`).all(...all);
  assert(rows.every((x) => x.item_id === C.id), JSON.stringify(rows));
  const res = await resolveItem(db, { item_name: 'VerifyEB MgA', userId: OWNER_ID });
  assert(res.id === C.id, 'resolved to ' + res.id);
});

check('merge refuses itself, a merged item and a hidden item', async () => {
  const { A, C } = mergeFx;
  const H = await newItem('VerifyEB MgHidden');
  await (await getDb()).prepare('UPDATE expense_items SET is_active = FALSE WHERE id = ?').run(H.id);
  const self = await api('POST', `/expenses/items/${C.id}/merge`, ownerT(), { into_id: C.id });
  const merged = await api('POST', `/expenses/items/${C.id}/merge`, ownerT(), { into_id: A.id });
  const hidden = await api('POST', `/expenses/items/${C.id}/merge`, ownerT(), { into_id: H.id });
  for (const [n, x] of [['self', self], ['merged', merged], ['hidden', hidden]]) {
    assert(x.status === 400 && x.body.message === MERGE_TARGET_COPY, `${n}: ${x.status} ${x.body && x.body.message}`);
  }
  const c = await (await getDb()).prepare('SELECT merged_into, is_active FROM expense_items WHERE id = ?').get(C.id);
  assert(c.merged_into == null && c.is_active === true, 'C changed by a refused merge');
});

check('merge across the salary line is refused both ways, nothing moves', async () => {
  const S = await newItem('VerifyEB MgSalary', 'salary');
  const N = await newItem('VerifyEB MgNonSal', 'other');
  const es = await rawExpense(S.id, 'salary', 'VerifyEB mg sal row');
  const en = await rawExpense(N.id, 'other', 'VerifyEB mg non row');
  const into = await api('POST', `/expenses/items/${N.id}/merge`, ownerT(), { into_id: S.id });
  const out = await api('POST', `/expenses/items/${S.id}/merge`, ownerT(), { into_id: N.id });
  assert(into.status === 400 && into.body.message === SALARY_COPY, `into salary ${into.status} ${into.body && into.body.message}`);
  assert(out.status === 400 && out.body.message === SALARY_COPY, `out of salary ${out.status} ${out.body && out.body.message}`);
  const db = await getDb();
  const rows = await db.prepare('SELECT id, item_id FROM expenses WHERE id IN (?, ?) ORDER BY id').all(es, en);
  assert(rows[0].item_id === S.id && rows[1].item_id === N.id, 'rows moved ' + JSON.stringify(rows));
  const items = await db.prepare('SELECT merged_into FROM expense_items WHERE id IN (?, ?)').all(S.id, N.id);
  assert(items.every((i) => i.merged_into == null), 'item marked merged');
});

check('a manager gets 403 on every owner item tool', async () => {
  const t = managerT();
  const rs = [
    await api('GET', '/expenses/items', t),
    await api('PUT', '/expenses/items/pins', t, { ids: [] }),
    await api('PUT', '/expenses/items/1', t, { pinned: true }),
    await api('POST', '/expenses/items/1/merge', t, { into_id: 2 }),
  ];
  assert(rs.every((r) => r.status === 403), rs.map((r) => r.status).join(' '));
});

// ── Task 7: sort old entries into items ──
let sortFx = null;
async function sortFixtures() {
  if (sortFx) return sortFx;
  const db = await getDb();
  const item = await track(await resolveItem(db, { item_name: 'VerifyEB Petrol', category: 'transport', userId: OWNER_ID }));
  const teak = await track(await resolveItem(db, { item_name: 'VerifyEB Tea', category: 'food', userId: OWNER_ID }));
  const mk = async (desc, cat) => {
    const r = await db.prepare(`INSERT INTO expenses (location_id, category, amount, description, payment_method, expense_date, created_by)
      VALUES (?, ?, 7.5, ?, 'upi', ?, ?) RETURNING id`).get(TEST_LOCATION_ID, cat, desc, dayAgo(40), OWNER_ID);
    createdExpenseIds.push(r.id);
    return r.id;
  };
  sortFx = {
    item, teak,
    exact: await mk('verifyeb petrol', 'transport'),
    prefix: await mk('VerifyEB Petrol Nov', 'transport'),
    word: await mk('VerifyEB Teakwood', 'other'),
    plain: await mk('VerifyEB mystery', 'other'),
    salary: await mk('VerifyEB salary row', 'salary'),
  };
  return sortFx;
}

check('unsorted rows carry exact and prefix suggestions, never salary', async () => {
  const fx = await sortFixtures();
  const r = await api('GET', '/expenses/unsorted?limit=200', ownerT());
  assert(r.status === 200 && Array.isArray(r.body.data), 'status ' + r.status);
  const by = (id) => r.body.data.find((x) => Number(x.id) === id);
  assert(by(fx.exact) && by(fx.exact).suggested_item && by(fx.exact).suggested_item.id === fx.item.id, 'exact ' + JSON.stringify(by(fx.exact)));
  assert(by(fx.prefix).suggested_item && by(fx.prefix).suggested_item.name === 'VerifyEB Petrol', 'prefix');
  assert(by(fx.word) && by(fx.word).suggested_item === null, 'word boundary: ' + JSON.stringify(by(fx.word).suggested_item));
  assert(by(fx.plain) && by(fx.plain).suggested_item === null, 'plain');
  assert(!by(fx.salary), 'salary row listed');
  assert(r.body.data.every((x) => x.item_id == null && x.category !== 'salary'), 'sorted/salary rows leaked');
});

check('assigning sets item_id only, skips assigned and salary rows, and audits', async () => {
  const fx = await sortFixtures();
  const db = await getDb();
  const before = await db.prepare('SELECT amount, expense_date, category, description, register_id FROM expenses WHERE id = ?').get(fx.exact);
  const r = await api('POST', '/expenses/assign-items', ownerT(), { assignments: [
    { expense_id: fx.exact, item_id: fx.item.id },
    { expense_id: fx.plain, item_name: 'VerifyEB Mystery Thing' },
    { expense_id: fx.salary, item_id: fx.item.id },
  ] });
  assert(r.status === 200 && r.body.data.assigned === 2, JSON.stringify(r.body));
  assert(r.body.data.skipped.map(Number).join() === String(fx.salary), 'skipped ' + JSON.stringify(r.body.data.skipped));
  const after = await db.prepare('SELECT amount, expense_date, category, description, register_id, item_id FROM expenses WHERE id = ?').get(fx.exact);
  assert(Number(after.item_id) === fx.item.id, 'item not set');
  for (const k of Object.keys(before)) assert(String(before[k]) === String(after[k]), k + ' changed');
  const made = await db.prepare("SELECT ei.id, ei.category FROM expenses e JOIN expense_items ei ON ei.id = e.item_id WHERE e.id = ?").get(fx.plain);
  assert(made && made.category === 'other', 'new item category ' + JSON.stringify(made));
  await track(made);
  const sal = await db.prepare('SELECT item_id FROM expenses WHERE id = ?').get(fx.salary);
  assert(sal.item_id == null, 'salary assigned');
  const again = await api('POST', '/expenses/assign-items', ownerT(), { assignments: [{ expense_id: fx.exact, item_id: fx.teak.id }] });
  assert(again.body.data.assigned === 0 && again.body.data.skipped.map(Number).join() === String(fx.exact), 'reassign ' + JSON.stringify(again.body));
  const still = await db.prepare('SELECT item_id FROM expenses WHERE id = ?').get(fx.exact);
  assert(Number(still.item_id) === fx.item.id, 'overwritten');
  const au = await db.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'expense_assign_items' AND user_id = ?").get(OWNER_ID);
  assert(Number(au.c) >= 1, 'no audit row');
});

check('a manager gets 403 on unsorted and assign-items', async () => {
  const a = await api('GET', '/expenses/unsorted', managerT());
  const b = await api('POST', '/expenses/assign-items', managerT(), { assignments: [] });
  assert(a.status === 403 && b.status === 403, `${a.status} ${b.status}`);
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
    await db.prepare("DELETE FROM audit_logs WHERE entity_type = 'expense_item' AND entity_id = 0 AND action = 'expense_assign_items' AND user_id = ?").run(OWNER_ID);
    await db.prepare("DELETE FROM audit_logs WHERE entity_type = 'expense_item' AND entity_id = 0 AND action = 'expense_item_pins' AND user_id = ?").run(OWNER_ID);
    await db.prepare("DELETE FROM audit_logs WHERE entity_type = 'expense_item' AND entity_id IN (SELECT id FROM expense_items WHERE name LIKE '%VerifyEB%')").run();
    await db.prepare("UPDATE expenses SET item_id = NULL WHERE item_id IN (SELECT id FROM expense_items WHERE name LIKE '%VerifyEB%')").run();
    await db.prepare("UPDATE expense_items SET merged_into = NULL WHERE name LIKE '%VerifyEB%'").run();
    await db.prepare("DELETE FROM expense_items WHERE name LIKE '%VerifyEB%'").run();
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
