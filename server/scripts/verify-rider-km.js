#!/usr/bin/env node
/**
 * Verification of the rider km account (live API). Task 2: readings, gaps,
 * corrections, Km rate, the account view and the Rider petrol item flag.
 * Task 3: settle (preview and commit), drawer, COD and shopping money.
 * Cash checks open their own Test Loc register and close and remove it at
 * the end; a register this run did not open is never touched.
 * Test rows are named VerifyRK. Cleans up only rows this run created and
 * puts the Km rate rows back as they were.
 * Usage: source test-env.sh; node server/scripts/verify-rider-km.js
 */
require('dotenv').config();
const jwt = require('jsonwebtoken');
const { getDb } = require('../config/database-async');
const { todayStr } = require('../utils/time');

const TEST_LOCATION_ID = 4; // Test Loc
const API_BASE = process.env.API_BASE_URL || 'http://localhost:3001/api';
const checks = [];
const createdUserIds = [];
const createdItemIds = [];
const createdRegisterIds = [];
const createdSaleIds = [];
let rateBefore = null;
function check(name, fn) { checks.push({ name, fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const eq = (a, b, what) => assert(a === b, `${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

function assertLocalTarget() {
  if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '')) { console.error('Refusing to run: DATABASE_URL not local.'); process.exit(1); }
}
const tok = (id) => jwt.sign({ id }, process.env.JWT_SECRET);
async function api(method, path, userId, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(userId ? { Authorization: `Bearer ${tok(userId)}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body: json };
}
async function makeUser(db, { role, name, location = TEST_LOCATION_ID }) {
  const phone = 'rk' + Date.now() + Math.floor(Math.random() * 1e6);
  const row = await db.prepare('INSERT INTO users (phone, password, name, role, is_active) VALUES (?, ?, ?, ?, 1) RETURNING id').get(phone, 'x', name, role);
  createdUserIds.push(row.id);
  if (location) await db.prepare('INSERT INTO user_locations (user_id, location_id) VALUES (?, ?)').run(row.id, location);
  return row.id;
}
// Shop-local 'YYYY-MM-DD HH:MM:00' n days before today.
function at(daysAgo, hhmm) {
  const d = new Date(`${todayStr()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return `${d.toISOString().slice(0, 10)} ${hhmm}:00`;
}

let cast = null;
async function getCast() {
  if (cast) return cast;
  const db = await getDb();
  cast = {
    owner: await makeUser(db, { role: 'owner', name: 'VerifyRK Owner', location: null }),
    mgr: await makeUser(db, { role: 'manager', name: 'VerifyRK Manager' }),
    counter: await makeUser(db, { role: 'counter_staff', name: 'VerifyRK Counter' }),
    counter2: await makeUser(db, { role: 'counter_staff', name: 'VerifyRK Counter Two' }),
    florist: await makeUser(db, { role: 'florist_staff', name: 'VerifyRK Florist' }),
    helper: await makeUser(db, { role: 'helper', name: 'VerifyRK Helper' }),
    customer: await makeUser(db, { role: 'customer', name: 'VerifyRK Customer', location: null }),
    rider: await makeUser(db, { role: 'delivery_partner', name: 'VerifyRK Rider' }),
  };
  await db.prepare('UPDATE users SET access_until = CAST(? AS date) + 30 WHERE id = ?').run(todayStr(), cast.helper);
  const rows = await db.prepare('SELECT id, rate, set_by FROM rider_km_rates ORDER BY id').all();
  rateBefore = rows;
  return cast;
}
async function freshRider() {
  return makeUser(await getDb(), { role: 'delivery_partner', name: 'VerifyRK Rider ' + createdUserIds.length });
}
const reading = (rider, kind, meter, readAt, extra) => ({ user_id: rider, location_id: TEST_LOCATION_ID, kind, meter, read_at: readAt, ...(extra || {}) });
async function post(who, rider, kind, meter, readAt, extra) {
  return api('POST', '/rider-km/readings', who, reading(rider, kind, meter, readAt, extra));
}
async function view(who, rider) {
  const r = await api('GET', `/rider-km/${rider}`, who);
  eq(r.status, 200, 'view ' + JSON.stringify(r.body));
  return r.body.data;
}

check('a reading chain answers work and home km', async () => {
  const c = await getCast();
  const r = await freshRider();
  const rates = (await api('GET', '/rider-km/rate', c.mgr)).body.data.history;
  const date = at(3, '09:00').slice(0, 10);
  const rate = Number(rates.filter((x) => x.effective_from <= date).sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1))[0].rate);
  const list = [['arrive', 12340, '09:00'], ['leave', 12386, '12:00'], ['arrive', 12398, '13:00'], ['leave', 12430, '15:00'], ['arrive', 12436, '16:00'], ['leave', 12470, '18:00']];
  for (const [k, m, t] of list) {
    const p = await post(c.counter, r, k, m, at(3, t));
    assert(p.status === 201, `post ${k} ${p.status} ${JSON.stringify(p.body)}`);
  }
  const v = await view(c.mgr, r);
  eq(v.unsettled.paid_km, 112, 'paid km');
  eq(v.open_day, false, 'open_day');
  eq(v.gaps_open, 0, 'gaps');
  eq(v.unsettled.amount_paise, Math.round(112 * rate * 100), 'amount');
  eq(v.readings.length, 6, 'readings listed');
});

check('meter down is refused with the copy', async () => {
  const c = await getCast();
  const r = await freshRider();
  eq((await post(c.counter, r, 'arrive', 1000, at(2, '09:00'))).status, 201, 'first');
  const p = await post(c.counter, r, 'leave', 900, at(2, '10:00'));
  eq(p.status, 409, 'status');
  eq(p.body.code, 'METER_DOWN', 'code');
  eq(p.body.message, "The meter can't go down. Check the number, or tap Type km instead.", 'copy');
  eq((await view(c.mgr, r)).readings.length, 1, 'nothing saved');
  const bad = await post(c.counter, r, 'leave', 'abc', at(2, '10:00'));
  eq(bad.status, 400, 'bad number');
  const kind = await post(c.counter, r, 'sideways', 1100, at(2, '10:00'));
  eq(kind.status, 400, 'bad kind');
  const notRider = await post(c.counter, c.counter2, 'arrive', 5, at(2, '10:00'));
  eq(notRider.status, 400, 'non-rider');
});

check('a 301 km work stretch needs confirm_big', async () => {
  const c = await getCast();
  const r = await freshRider();
  eq((await post(c.counter, r, 'arrive', 1000, at(2, '09:00'))).status, 201, 'first');
  const p = await post(c.counter, r, 'leave', 1301, at(2, '12:00'));
  eq(p.status, 409, 'status');
  eq(p.body.code, 'CONFIRM_BIG', 'code');
  eq(p.body.message, 'Is 1301 right? That is 301 km of work.', 'copy');
  eq((await view(c.mgr, r)).readings.length, 1, 'rolled back');
  const ok = await post(c.counter, r, 'leave', 1301, at(2, '12:00'), { confirm_big: true });
  eq(ok.status, 201, 'confirmed ' + JSON.stringify(ok.body));
  eq((await view(c.mgr, r)).unsettled.paid_km, 301, 'paid');
});

check('a duplicate reading within 2 minutes returns the same row', async () => {
  const c = await getCast();
  const r = await freshRider();
  const a = await post(c.counter, r, 'arrive', 5000, at(2, '09:00'));
  eq(a.status, 201, 'first');
  const b = await post(c.counter2, r, 'arrive', 5000, at(2, '09:01'));
  eq(b.status, 200, 'dup status');
  eq(b.body.data.reading.id, a.body.data.reading.id, 'same id');
  const both = await Promise.all([post(c.counter, r, 'leave', 5030, at(2, '12:00')), post(c.counter2, r, 'leave', 5030, at(2, '12:00'))]);
  eq(both[0].body.data.reading.id, both[1].body.data.reading.id, 'parallel same id');
  const db = await getDb();
  const n = await db.prepare('SELECT COUNT(*) AS c FROM rider_km_readings WHERE user_id = ? AND removed_at IS NULL').get(r);
  eq(Number(n.c), 2, 'two rows only');
});

check('counter staff cannot add a reading 8 days back; manager can', async () => {
  const c = await getCast();
  const r = await freshRider();
  const p = await post(c.counter, r, 'arrive', 100, at(8, '09:00'));
  eq(p.status, 403, 'counter 8 days ' + JSON.stringify(p.body));
  const ok7 = await post(c.counter, r, 'arrive', 100, at(7, '09:00'));
  eq(ok7.status, 201, 'counter 7 days');
  const m2 = await post(c.mgr, r, 'arrive', 90, at(9, '12:00'));
  eq(m2.status, 201, 'manager 9 days back ' + JSON.stringify(m2.body));
});

check('a gap is listed and answered', async () => {
  const c = await getCast();
  const r = await freshRider();
  eq((await post(c.counter, r, 'arrive', 100, at(2, '09:00'))).status, 201, 'a1');
  eq((await post(c.counter, r, 'arrive', 500, at(2, '18:00'))).status, 201, 'a2');
  let v = await view(c.mgr, r);
  eq(v.gaps_open, 1, 'gaps open');
  eq(v.unsettled.paid_km, 0, 'nothing paid yet');
  const gap = v.stretches.find((s) => s.kind === 'gap');
  assert(gap, 'gap stretch listed');
  const body = { user_id: r, from_reading_id: gap.from_reading_id, to_reading_id: gap.to_reading_id };
  eq((await api('POST', '/rider-km/gaps', c.counter, { ...body, answer: 'typed', work_km: 401 })).status, 400, 'above stretch');
  eq((await api('POST', '/rider-km/gaps', c.counter, { ...body, answer: 'typed' })).status, 400, 'typed needs km');
  eq((await api('POST', '/rider-km/gaps', c.counter, { ...body, from_reading_id: body.to_reading_id, answer: 'none' })).status, 400, 'not a gap');
  const ok = await api('POST', '/rider-km/gaps', c.counter, { ...body, answer: 'typed', work_km: 200 });
  eq(ok.status, 200, 'answer ' + JSON.stringify(ok.body));
  v = await view(c.mgr, r);
  eq(v.gaps_open, 0, 'gaps closed');
  eq(v.unsettled.paid_km, 200, 'paid includes 200');
  const again = await api('POST', '/rider-km/gaps', c.counter, { ...body, answer: 'none' });
  eq(again.status, 200, 're-answer');
  eq((await view(c.mgr, r)).unsettled.paid_km, 0, 'none pays nothing');
});

check('change and remove a reading: ownership, window and audit', async () => {
  const c = await getCast();
  const r = await freshRider();
  const a = await post(c.counter, r, 'arrive', 100, at(1, '09:00'));
  const id = a.body.data.reading.id;
  eq((await api('PUT', `/rider-km/readings/${id}`, c.counter2, { meter: 101 })).status, 403, 'other counter staff');
  const own = await api('PUT', `/rider-km/readings/${id}`, c.counter, { meter: 101 });
  eq(own.status, 200, 'own ' + JSON.stringify(own.body));
  eq(own.body.data.reading.meter, 101, 'changed');
  eq((await api('PUT', `/rider-km/readings/${id}`, c.mgr, { meter: 102 })).status, 200, 'manager');
  const db = await getDb();
  const au = await db.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE entity_type = 'rider_km' AND entity_id = ? AND action IN ('km_reading_add','km_reading_change')").get(id);
  eq(Number(au.c), 3, 'audit rows');
  eq((await api('DELETE', `/rider-km/readings/${id}`, c.counter2)).status, 403, 'delete by other');
  eq((await api('DELETE', `/rider-km/readings/${id}`, c.counter)).status, 200, 'delete own');
  eq((await view(c.mgr, r)).readings.length, 0, 'removed from view');
  eq((await api('DELETE', `/rider-km/readings/${id}`, c.mgr)).status, 404, 'already removed');
});

check('a reading inside a settled range is refused', async () => {
  const c = await getCast();
  const r = await freshRider();
  const first = await post(c.mgr, r, 'arrive', 100, at(4, '09:00'));
  const cut = await post(c.mgr, r, 'leave', 140, at(4, '18:00'));
  const db = await getDb();
  await db.prepare("INSERT INTO rider_km_settlements (user_id, location_id, cutoff_reading_id, action, created_by) VALUES (?, ?, ?, 'zero', ?)")
    .run(r, TEST_LOCATION_ID, cut.body.data.reading.id, c.owner);
  const late = await post(c.mgr, r, 'arrive', 120, at(4, '12:00'));
  eq(late.status, 409, 'settled range ' + JSON.stringify(late.body));
  eq(late.body.code, 'SETTLED_RANGE', 'code');
  eq(late.body.message, 'That day is already settled. Ask the owner or a manager to add a correction.', 'copy');
  const edit = await api('PUT', `/rider-km/readings/${first.body.data.reading.id}`, c.mgr, { meter: 99 });
  eq(edit.status, 409, 'edit settled');
  eq(edit.body.code, 'SETTLED', 'edit code');
  eq((await api('DELETE', `/rider-km/readings/${cut.body.data.reading.id}`, c.mgr)).status, 409, 'delete settled');
  const after = await post(c.mgr, r, 'arrive', 150, at(3, '09:00'));
  eq(after.status, 201, 'later reading is fine');
  const v = await view(c.mgr, r);
  eq(v.unsettled.paid_km, 0, 'settled work no longer counted');
  assert(v.last_settlement && v.last_settlement.action === 'zero', 'last settlement shown');
});

check('corrections and usual home ride', async () => {
  const c = await getCast();
  const r = await freshRider();
  eq((await api('POST', '/rider-km/corrections', c.counter, { user_id: r, km: 10, note: 'x' })).status, 403, 'counter correction');
  eq((await api('POST', '/rider-km/corrections', c.mgr, { user_id: r, km: 10 })).status, 400, 'note needed');
  const ok = await api('POST', '/rider-km/corrections', c.mgr, { user_id: r, km: 12.5, note: 'Forgot a trip' });
  eq(ok.status, 201, 'correction ' + JSON.stringify(ok.body));
  eq((await view(c.counter, r)).unsettled.paid_km, 12.5, 'counted');
  eq((await api('PUT', `/rider-km/${r}/usual-home`, c.counter, { km: 8 })).status, 403, 'counter usual');
  eq((await api('PUT', `/rider-km/${r}/usual-home`, c.mgr, { km: 8 })).status, 200, 'manager usual');
  eq((await view(c.mgr, r)).usual_home_km, 8, 'usual shown');
  eq((await view(c.mgr, r)).usual_home_set_km, 8, 'usual set by hand shown');
  eq((await api('PUT', `/rider-km/${r}/usual-home`, c.mgr, { km: null })).status, 200, 'clear');
  eq((await view(c.mgr, r)).usual_home_set_km, null, 'cleared: worked out from the rides');
  const db = await getDb();
  const au = await db.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE entity_type = 'rider_km' AND action IN ('km_correction','km_usual_home_set') AND user_id = ?").get(c.mgr);
  assert(Number(au.c) >= 3, 'audit rows ' + au.c);
});

check('rider list shows unsettled km and gaps', async () => {
  const c = await getCast();
  const r = await freshRider();
  await post(c.counter, r, 'arrive', 10, at(1, '09:00'));
  const list = await api('GET', `/rider-km/riders?location_id=${TEST_LOCATION_ID}`, c.counter);
  eq(list.status, 200, 'list');
  const me = list.body.data.find((x) => x.id === r);
  assert(me, 'rider listed');
  // Spec 7: only an Arriving dated today (shop day) leaves the day open; a
  // missed Going home yesterday is not a rider still out today.
  eq(me.open_day, false, 'an Arriving from yesterday is not an open day');
  eq((await view(c.mgr, r)).open_day, false, 'account view: yesterday is not open');
  eq(me.balance_paise, 0, 'nothing to settle yet is a 0 balance');
  eq((await post(c.counter, r, 'leave', 20, at(1, '18:00'))).status, 201, 'going home yesterday');
  eq((await post(c.counter, r, 'arrive', 25, at(0, '00:01'))).status, 201, 'arriving today');
  const me2 = (await api('GET', `/rider-km/riders?location_id=${TEST_LOCATION_ID}`, c.counter)).body.data.find((x) => x.id === r);
  eq(me2.open_day, true, 'an Arriving today is an open day');
  eq((await view(c.mgr, r)).open_day, true, 'account view: today is open');
});

check('rate: owner sets 4 from today; manager cannot', async () => {
  const c = await getCast();
  eq((await api('PUT', '/rider-km/rate', c.mgr, { rate: 4 })).status, 403, 'manager');
  eq((await api('GET', '/rider-km/rate', c.florist)).status, 403, 'florist read');
  eq((await api('PUT', '/rider-km/rate', c.owner, { rate: 0 })).status, 400, 'zero');
  const ok = await api('PUT', '/rider-km/rate', c.owner, { rate: 4 });
  eq(ok.status, 200, 'owner ' + JSON.stringify(ok.body));
  const g = await api('GET', '/rider-km/rate', c.mgr);
  eq(g.status, 200, 'manager reads');
  eq(g.body.data.rate, 4, 'rate');
  eq(g.body.data.effective_from, todayStr(), 'effective today');
  const again = await api('PUT', '/rider-km/rate', c.owner, { rate: 5 });
  eq(again.status, 200, 'second same day');
  eq((await api('GET', '/rider-km/rate', c.mgr)).body.data.rate, 5, 'newest same-day wins');
  const db = await getDb();
  const au = await db.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE entity_type = 'rider_km' AND action = 'km_rate_set' AND user_id = ?").get(c.owner);
  eq(Number(au.c), 2, 'rate audit');
});

check('rider petrol item flag', async () => {
  const c = await getCast();
  const db = await getDb();
  const item = await db.prepare("INSERT INTO expense_items (name, name_key, category) VALUES ('VerifyRK Fuel', 'verifyrk fuel', 'transport') RETURNING id").get();
  createdItemIds.push(item.id);
  const plain = await db.prepare("INSERT INTO expense_items (name, name_key, category) VALUES ('VerifyRK Plain', 'verifyrk plain', 'transport') RETURNING id").get();
  createdItemIds.push(plain.id);
  eq((await api('PUT', `/expenses/items/${item.id}/rider-petrol`, c.counter, { on: true })).status, 403, 'counter');
  eq((await api('PUT', `/expenses/items/${item.id}/rider-petrol`, c.mgr, { on: true })).status, 403, 'manager');
  const on = await api('PUT', `/expenses/items/${item.id}/rider-petrol`, c.owner, { on: true });
  eq(on.status, 200, 'owner ' + JSON.stringify(on.body));
  eq(on.body.data.is_rider_petrol, true, 'flag on');
  const list = await api('GET', '/expenses/items?q=verifyrk', c.owner);
  const row = list.body.data.find((x) => x.id === item.id);
  eq(row && row.is_rider_petrol, true, 'listed with flag');
  const copy = 'Pick the rider from the list so it counts against their km.';
  const base = { location_id: TEST_LOCATION_ID, amount: 10, payment_method: 'upi', expense_date: todayStr() };
  const typed = await api('POST', '/expenses', c.counter, { ...base, item_id: item.id, given_to_name: 'Some Rider' });
  eq(typed.status, 400, 'typed name ' + JSON.stringify(typed.body));
  eq(typed.body.message, copy, 'copy');
  const picked = await api('POST', '/expenses', c.counter, { ...base, item_id: item.id, given_to_user_id: c.rider });
  eq(picked.status, 201, 'picked rider ' + JSON.stringify(picked.body));
  const nameless = await api('POST', '/expenses', c.counter, { ...base, item_id: item.id });
  eq(nameless.status, 201, 'no one named is not refused ' + JSON.stringify(nameless.body));
  const other = await api('POST', '/expenses', c.counter, { ...base, item_id: plain.id, given_to_name: 'Some Person' });
  eq(other.status, 201, 'other item with a typed name ' + JSON.stringify(other.body));
  const move = await api('PUT', `/expenses/${other.body.data.id}`, c.owner, { item_id: item.id });
  eq(move.status, 400, 'edit to petrol keeps the typed name ' + JSON.stringify(move.body));
  eq(move.body.message, copy, 'edit copy');
  const off = await api('PUT', `/expenses/items/${item.id}/rider-petrol`, c.owner, { on: false });
  eq(off.body.data.is_rider_petrol, false, 'flag off');
  eq((await api('POST', '/expenses', c.counter, { ...base, item_id: item.id, given_to_name: 'Some Rider' })).status, 201, 'off allows it');
});

check('roles: florist, helper, customer get 403 everywhere; the rider sees only their own', async () => {
  const c = await getCast();
  const r = await freshRider();
  const calls = (who) => [
    ['GET', `/rider-km/riders?location_id=${TEST_LOCATION_ID}`],
    ['GET', `/rider-km/${r}`],
    ['GET', '/rider-km/mine'],
    ['POST', '/rider-km/readings', reading(r, 'arrive', 5, at(1, '09:00'))],
    ['PUT', '/rider-km/readings/1', { meter: 5 }],
    ['DELETE', '/rider-km/readings/1'],
    ['POST', '/rider-km/gaps', { user_id: r, from_reading_id: 1, to_reading_id: 2, answer: 'none' }],
    ['POST', '/rider-km/corrections', { user_id: r, km: 1, note: 'x' }],
    ['GET', '/rider-km/rate'],
    ['PUT', '/rider-km/rate', { rate: 9 }],
    ['PUT', `/rider-km/${r}/usual-home`, { km: 5 }],
  ].map(([m, p, b]) => api(m, p, who, b));
  for (const [label, who] of [['florist', c.florist], ['helper', c.helper], ['customer', c.customer]]) {
    const res = await Promise.all(calls(who));
    res.forEach((x, i) => eq(x.status, 403, `${label} call ${i}`));
  }
  // The rider
  await post(c.counter, c.rider, 'arrive', 77, at(1, '09:00'));
  const mine = await api('GET', '/rider-km/mine', c.rider);
  eq(mine.status, 200, 'mine');
  eq(mine.body.data.rider.id, c.rider, 'own data');
  eq((await api('GET', `/rider-km/${c.rider}`, c.rider)).status, 200, 'own by id');
  eq((await api('GET', `/rider-km/${r}`, c.rider)).status, 403, 'another rider');
  const res = await Promise.all(calls(c.rider).slice(3));
  res.forEach((x, i) => eq(x.status, 403, `rider write call ${i}`));
  eq((await api('GET', `/rider-km/riders?location_id=${TEST_LOCATION_ID}`, c.rider)).status, 403, 'rider list');
  eq((await api('GET', '/rider-km/mine', c.counter)).status, 403, 'mine for counter');
});

// ─── Task 3: settle ──────────────────────────────────────────
const COPY = {
  gaps: 'Answer the gaps first, then settle.',
  changed: 'Something changed — check the figures again.',
  pay: 'Open the register to pay cash — or pick UPI.',
  take: 'Open the register to take cash — or pick UPI.',
  ownPetrol: "A rider's own petrol is covered by their km pay — no need to add it.",
};
function skip(msg) { const e = new Error(msg); e.skip = true; return e; }
async function testLocRegister() {
  return (await getDb()).prepare('SELECT id, expected_cash FROM cash_registers WHERE location_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1').get(TEST_LOCATION_ID);
}
async function openOwnRegister() {
  const c = await getCast();
  const open = await testLocRegister();
  if (open) {
    if (createdRegisterIds.includes(open.id)) return open.id;
    throw skip(`Test Loc register #${open.id} is open and is not this run's; skipped.`);
  }
  const op = await api('POST', '/sales/register/open', c.owner, { location_id: TEST_LOCATION_ID, opening_balance: 5000 });
  assert(op.status === 201, `open ${op.status} ${JSON.stringify(op.body)}`);
  createdRegisterIds.push(op.body.data.id);
  return op.body.data.id;
}
async function closeOwnRegister() {
  const c = await getCast();
  const open = await testLocRegister();
  if (!open || !createdRegisterIds.includes(open.id)) return;
  const r = await api('PUT', '/sales/register/close', c.owner, { location_id: TEST_LOCATION_ID, actual_cash: Math.max(0, Number(open.expected_cash) || 0) });
  assert(r.status === 200, `close ${r.status} ${JSON.stringify(r.body)}`);
}
const drawer = async (id) => Number((await (await getDb()).prepare('SELECT expected_cash FROM cash_registers WHERE id = ?').get(id)).expected_cash);
const P = (n) => Math.round(Number(n) * 100);
let petrolItemId = null;
async function petrolItem() {
  if (petrolItemId) return petrolItemId;
  const row = await (await getDb()).prepare('SELECT id FROM expense_items WHERE is_rider_petrol = TRUE ORDER BY id LIMIT 1').get();
  assert(row, 'a Rider petrol item exists');
  petrolItemId = Number(row.id);
  return petrolItemId;
}
// A day of work: arrive 09:00 and leave 18:00, km apart. Returns the leave id.
async function work(rider, daysAgo, km, meter) {
  const c = await getCast();
  const a = await post(c.mgr, rider, 'arrive', meter, at(daysAgo, '09:00'));
  eq(a.status, 201, 'arrive ' + JSON.stringify(a.body));
  const l = await post(c.mgr, rider, 'leave', meter + km, at(daysAgo, '18:00'));
  eq(l.status, 201, 'leave ' + JSON.stringify(l.body));
  return l.body.data.reading.id;
}
// Petrol given to the rider, saved at a shop-local time (created_at moved there).
async function petrol(rider, amount, method, savedAtLocal) {
  const c = await getCast();
  const r = await api('POST', '/expenses', c.counter, {
    location_id: TEST_LOCATION_ID, item_id: await petrolItem(), amount, payment_method: method, given_to_user_id: rider,
  });
  eq(r.status, 201, 'petrol ' + JSON.stringify(r.body));
  await (await getDb()).prepare("UPDATE expenses SET created_at = ((CAST(? AS timestamp) AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'UTC') WHERE id = ?")
    .run(savedAtLocal, r.body.data.id);
  return r.body.data.id;
}
// A delivered COD order for the rider, delivered now. parts: { cash, upi }.
async function cod(rider, parts) {
  const c = await getCast();
  const db = await getDb();
  const total = (parts.cash || 0) + (parts.upi || 0);
  const sale = await db.prepare(`INSERT INTO sales (sale_number, location_id, created_by, order_type, status, payment_status, grand_total, subtotal)
    VALUES (?, ?, ?, 'delivery', 'completed', 'paid', ?, ?) RETURNING id`).get('VRK-' + Date.now() + Math.floor(Math.random() * 1e4), TEST_LOCATION_ID, c.owner, total, total);
  createdSaleIds.push(sale.id);
  const d = await db.prepare(`INSERT INTO deliveries (sale_id, location_id, status, delivery_address, delivery_partner_id, cod_amount, cod_collected, cod_status, delivered_time)
    VALUES (?, ?, 'delivered', 'VerifyRK street', ?, ?, ?, 'collected', (NOW() AT TIME ZONE 'UTC')) RETURNING id`).get(sale.id, TEST_LOCATION_ID, rider, total, total);
  for (const m of ['cash', 'upi']) {
    if (parts[m]) await db.prepare('INSERT INTO delivery_collections (delivery_id, amount, method, collected_by, created_at) VALUES (?, ?, ?, ?, CURRENT_DATE)').run(d.id, parts[m], m, rider);
  }
  return Number(d.id);
}
// Shopping money given by UPI; bills recorded so `held` is still with the rider.
async function shopping(rider, amount, billsAmount) {
  const c = await getCast();
  const g = await api('POST', '/staff-money/shopping', c.owner, { location_id: TEST_LOCATION_ID, user_id: rider, amount, payment_method: 'upi' });
  eq(g.status, 201, 'shopping ' + JSON.stringify(g.body));
  if (billsAmount) {
    const s = await api('POST', `/staff-money/${g.body.data.id}/settle`, c.owner, { bills: [{ description: 'VerifyRK Roses', category: 'supplies', amount: billsAmount }] });
    eq(s.status, 200, 'bills ' + JSON.stringify(s.body));
  }
  return g.body.data.id;
}
async function preview(who, rider, extra) {
  return api('POST', `/rider-km/${rider}/settle`, who, { location_id: TEST_LOCATION_ID, preview: true, ...(extra || {}) });
}
async function okPreview(who, rider, extra) {
  const p = await preview(who, rider, extra);
  eq(p.status, 200, 'preview ' + JSON.stringify(p.body));
  return p.body.data;
}
async function commit(who, rider, pv, body) {
  return api('POST', `/rider-km/${rider}/settle`, who, {
    location_id: TEST_LOCATION_ID, expected_net_paise: pv.net_paise, last_settlement_id: pv.last_settlement_id, ...body,
  });
}
const settlementRow = async (id) => (await getDb()).prepare('SELECT * FROM rider_km_settlements WHERE id = ?').get(id);
const deliveryRow = async (id) => (await getDb()).prepare('SELECT * FROM deliveries WHERE id = ?').get(id);
async function kRate(daysAgo) {
  const c = await getCast();
  const rates = (await api('GET', '/rider-km/rate', c.mgr)).body.data.history;
  const date = at(daysAgo, '09:00').slice(0, 10);
  return Number(rates.filter((x) => x.effective_from <= date).sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1))[0].rate);
}

const KM_SETTLED_SALE_COPY = "This sale's COD was settled in the rider's km account, so its payment can't be changed here. Use Refund on the sale instead.";
const flow = {};
check('settle: three signs of net', async () => {
  const c = await getCast();
  const reg = await openOwnRegister();
  const r = await freshRider();
  const leaveId = await work(r, 3, 112, 1000);
  const K = Math.round(112 * (await kRate(3)) * 100);
  const petrolId = await petrol(r, 200, 'cash', at(3, '12:00'));
  const lineId = await shopping(r, 300, 200);
  const codId = await cod(r, { cash: 500 });
  const pv = await okPreview(c.counter, r);
  eq(pv.lines.km_paise, K, 'K');
  eq(pv.lines.paid_km, 112, 'paid km');
  eq(pv.lines.petrol_taken_paise, 20000, 'petrol taken');
  eq(pv.lines.supply_held_paise, 10000, 'supply held');
  eq(pv.lines.cod_held_paise, 50000, 'cod held');
  eq(pv.lines.carried_in_paise, 0, 'carried in');
  eq(pv.lines.cod.length, 1, 'one COD line');
  eq(pv.lines.cod[0].cash_paise, 50000, 'cod cash');
  eq(pv.lines.cod[0].upi_paise, 0, 'cod upi');
  eq(pv.lines.petrol.length, 1, 'one petrol line');
  eq(pv.lines.shopping.length, 1, 'one shopping line');
  eq(pv.net_paise, K - 20000 - 10000 - 50000, 'net');
  if (K === 33600) eq(pv.net_paise, -46400, 'net -464');
  eq(pv.cutoff_reading_id, leaveId, 'cutoff');
  Object.assign(flow, { r, reg, pv, petrolId, lineId, codId, K, leaveId });
  // Positive: only km.
  const r2 = await freshRider();
  await work(r2, 3, 112, 2000);
  eq((await okPreview(c.counter, r2)).net_paise, K, 'positive net');
  // Zero: km equals petrol taken.
  const r3 = await freshRider();
  await work(r3, 3, 10, 3000);
  const K3 = Math.round(10 * (await kRate(3)) * 100);
  await petrol(r3, K3 / 100, 'upi', at(3, '10:00'));
  const pz = await okPreview(c.counter, r3);
  eq(pz.net_paise, 0, 'zero net');
  const badPay = await commit(c.counter, r3, pz, { action: 'pay', amount: 1, method: 'upi' });
  eq(badPay.status, 400, 'pay with net 0 ' + JSON.stringify(badPay.body));
  const z = await commit(c.counter, r3, pz, { action: 'zero' });
  eq(z.status, 201, 'zero ' + JSON.stringify(z.body));
  eq(Number((await settlementRow(z.body.data.settlement_id)).carry_out), 0, 'zero carry');
  const again = await preview(c.counter, r3);
  eq(again.status, 409, 'nothing left ' + JSON.stringify(again.body));
  eq(again.body.code, 'NOTHING', 'NOTHING code');
  eq(again.body.message, 'Nothing to settle yet.', 'NOTHING copy');
});

check('settle: carry marks COD, shopping and readings settled; drawer unchanged', async () => {
  const c = await getCast();
  assert(flow.r, 'needs the three-signs flow');
  const before = await drawer(flow.reg);
  const res = await commit(c.counter, flow.r, flow.pv, { action: 'carry' });
  eq(res.status, 201, 'carry ' + JSON.stringify(res.body));
  const sid = res.body.data.settlement_id;
  flow.sid = sid;
  const s = await settlementRow(sid);
  eq(P(s.carry_out), flow.pv.net_paise, 'carry_out');
  eq(s.action, 'carry', 'action');
  eq(P(s.net_amount), flow.pv.net_paise, 'net stored');
  eq(s.register_id, null, 'no register');
  assert(s.lines_json && s.lines_json.km_paise === flow.K, 'lines_json kept ' + JSON.stringify(s.lines_json).slice(0, 200));
  const d = await deliveryRow(flow.codId);
  eq(d.cod_status, 'settled', 'COD settled');
  eq(Number(d.km_settlement_id), sid, 'COD linked');
  const db = await getDb();
  eq(Number((await db.prepare('SELECT COUNT(*) AS c FROM delivery_settlement_items WHERE delivery_id = ?').get(flow.codId)).c), 0, 'no delivery_settlements row');
  const pend = await api('GET', `/deliveries/settlements/pending-summary?location_id=${TEST_LOCATION_ID}`, c.counter);
  eq(pend.status, 200, 'pending list');
  assert(!pend.body.data.partners.some((p) => Number(p.delivery_partner_id) === flow.r), 'rider gone from pending COD');
  const uns = await api('GET', `/deliveries/settlements/unsettled?delivery_partner_id=${flow.r}&location_id=${TEST_LOCATION_ID}`, c.counter);
  eq(uns.body.data.deliveries.length, 0, 'nothing unsettled for the rider');
  const mo = await db.prepare('SELECT * FROM staff_money_out WHERE id = ?').get(flow.lineId);
  eq(mo.status, 'settled', 'shopping line settled');
  eq(Number(mo.km_settlement_id), sid, 'line linked');
  assert(mo.closed_at, 'closed_at set');
  const st = await db.prepare("SELECT * FROM staff_money_settles WHERE money_out_id = ? AND returned_method = 'km'").get(flow.lineId);
  assert(st, 'km settle row');
  eq(P(st.returned_amount), 10000, 'returned = remaining');
  eq(st.register_id, null, 'settle row has no register');
  eq(Number((await db.prepare('SELECT km_settlement_id FROM expenses WHERE id = ?').get(flow.petrolId)).km_settlement_id), sid, 'petrol linked');
  const rd = await db.prepare('SELECT COUNT(*) AS c FROM rider_km_readings WHERE user_id = ? AND settlement_id = ?').get(flow.r, sid);
  eq(Number(rd.c), 2, 'readings linked');
  eq(await drawer(flow.reg), before, 'drawer unchanged by carry');
  const au = await db.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE entity_type = 'rider_km' AND entity_id = ? AND action = 'km_settle'").get(sid);
  eq(Number(au.c), 1, 'audit');
  const list = await api('GET', `/rider-km/riders?location_id=${TEST_LOCATION_ID}`, c.counter);
  eq(list.body.data.find((x) => x.id === flow.r).balance_paise, flow.pv.net_paise, 'card balance = carry');
  const next = await okPreview(c.counter, flow.r);
  eq(next.lines.carried_in_paise, flow.pv.net_paise, 'carried in next time');
  eq(next.lines.cod.length, 0, 'COD not offered again');
  eq(next.lines.shopping.length, 0, 'shopping not offered again');
});

check('Edit Sale refuses a payment change on a sale whose COD a km settlement counted', async () => {
  const c = await getCast();
  assert(flow.sid, 'needs the carry flow');
  const db = await getDb();
  const saleId = Number((await deliveryRow(flow.codId)).sale_id);
  // A COD payment row (the close counts it as cash, so it is removed again
  // below to keep the later drawer checks to their own money).
  await db.prepare("INSERT INTO payments (sale_id, method, amount, received_by) VALUES (?, 'cash', 500, ?)").run(saleId, flow.r);
  try {
    const before = await drawer(flow.reg);
    const res = await api('PUT', `/sales/${saleId}`, c.owner, { payments: [{ method: 'upi', amount: 500 }] });
    eq(res.status, 409, 'payment change refused ' + JSON.stringify(res.body));
    eq(res.body.message, KM_SETTLED_SALE_COPY, 'copy');
    const pays = await db.prepare('SELECT method, amount FROM payments WHERE sale_id = ?').all(saleId);
    eq(pays.length, 1, 'payment row kept');
    eq(pays[0].method, 'cash', 'method unchanged');
    eq(await drawer(flow.reg), before, 'drawer unchanged');
    // The same payments sent back unchanged with a note still save.
    const ok = await api('PUT', `/sales/${saleId}`, c.owner, { payments: [{ method: 'cash', amount: 500 }], customer_notes: 'VerifyRK note' });
    eq(ok.status, 200, 'unchanged payments + note ' + JSON.stringify(ok.body));
  } finally {
    await db.prepare('DELETE FROM payments WHERE sale_id = ?').run(saleId);
  }
});

check('item merge and sorting leave km-settled rows on their item', async () => {
  const c = await getCast();
  assert(flow.sid, 'needs the carry flow');
  const db = await getDb();
  const tag = String(Date.now()).slice(-7);
  const mk = async (n) => {
    const row = await db.prepare("INSERT INTO expense_items (name, name_key, category) VALUES (?, ?, 'transport') RETURNING id").get(`VerifyRK Merge ${n} ${tag}`, `verifyrk merge ${n.toLowerCase()} ${tag}`);
    createdItemIds.push(row.id);
    return Number(row.id);
  };
  const a = await mk('A');
  const b = await mk('B');
  const exp = async (itemId, kmSid) => Number((await db.prepare(`INSERT INTO expenses (location_id, category, amount, description, payment_method, expense_date, created_by, item_id, km_settlement_id)
    VALUES (?, 'transport', 10, 'VerifyRK merge row', 'upi', CURRENT_DATE, ?, ?, ?) RETURNING id`).get(TEST_LOCATION_ID, c.owner, itemId, kmSid)).id);
  const plain = await exp(a, null);
  const settled = await exp(a, flow.sid);
  let loose = null;
  try {
    const m = await api('POST', `/expenses/items/${a}/merge`, c.owner, { into_id: b });
    eq(m.status, 200, 'merge ' + JSON.stringify(m.body));
    const itemOf = async (id) => Number((await db.prepare('SELECT item_id FROM expenses WHERE id = ?').get(id)).item_id);
    eq(await itemOf(plain), b, 'plain row moved');
    eq(await itemOf(settled), a, 'km-settled row kept its item');
    eq(m.body.data.moved, 1, 'moved count leaves out the settled row');
    // Sorting an entry with no item skips a km-settled row.
    loose = Number((await db.prepare(`INSERT INTO expenses (location_id, category, amount, description, payment_method, expense_date, created_by, km_settlement_id)
      VALUES (?, 'transport', 10, 'VerifyRK loose row', 'upi', CURRENT_DATE, ?, ?) RETURNING id`).get(TEST_LOCATION_ID, c.owner, flow.sid)).id);
    const as = await api('POST', '/expenses/assign-items', c.owner, { assignments: [{ expense_id: loose, item_id: b }] });
    eq(as.status, 200, 'assign ' + JSON.stringify(as.body));
    eq(as.body.data.assigned, 0, 'nothing assigned');
    assert(as.body.data.skipped.includes(loose), 'km-settled row skipped');
    eq((await db.prepare('SELECT item_id FROM expenses WHERE id = ?').get(loose)).item_id, null, 'still no item');
    // Take out (undo) never clears the item of a km-settled row either.
    const un = await api('POST', '/expenses/assign-items/undo', c.owner, { assignments: [{ expense_id: settled, item_id: a }] });
    eq(un.status, 200, 'undo ' + JSON.stringify(un.body));
    eq(un.body.data.undone, 0, 'nothing undone');
    eq(await itemOf(settled), a, 'km-settled row kept its item after undo');
  } finally {
    // These rows are not part of the settlement's money; remove them so the
    // petrol book check below sees only the real settlement rows.
    await db.prepare(`DELETE FROM expenses WHERE id IN (?, ?, ?)`).run(plain, settled, loose || 0);
  }
});

check('settle: petrol book equals K', async () => {
  assert(flow.sid, 'needs the carry flow');
  const db = await getDb();
  const rows = await db.prepare('SELECT * FROM expenses WHERE km_settlement_id = ? ORDER BY id').all(flow.sid);
  const signed = rows.reduce((t, e) => t + (e.is_return ? -P(e.amount) : P(e.amount)), 0);
  eq(signed, flow.K, 'petrol rows + settlement row = K');
  const km = rows.find((e) => e.payment_method === 'km_account');
  assert(km, 'km_account row');
  eq(P(km.amount), flow.K - 20000, 'km row amount');
  eq(Number(km.is_return), 0, 'not a return');
  eq(Number(km.given_to_user_id), flow.r, 'given to the rider');
  eq(km.category, 'transport', 'category');
  eq(km.register_id, null, 'no register');
  eq(Number((await settlementRow(flow.sid)).expense_id), Number(km.id), 'settlement links the row');
  const it = await db.prepare('SELECT is_rider_petrol FROM expense_items WHERE id = ?').get(km.item_id);
  eq(it && it.is_rider_petrol, true, 'Rider petrol item');
  // Settled rows keep their money: no amount change and no removal; a note is fine.
  const c = await getCast();
  eq((await api('PUT', `/expenses/${km.id}`, c.owner, { amount: 1 })).status, 400, 'km row amount locked');
  eq((await api('PUT', `/expenses/${flow.petrolId}`, c.owner, { amount: 1 })).status, 400, 'settled petrol amount locked');
  eq((await api('DELETE', `/expenses/${flow.petrolId}`, c.owner)).status, 400, 'settled petrol not removable');
  eq((await api('DELETE', `/expenses/${km.id}`, c.owner)).status, 400, 'km row not removable');
  const note = await api('PUT', `/expenses/${km.id}`, c.owner, { note: 'VerifyRK note' });
  eq(note.status, 200, 'note change ' + JSON.stringify(note.body));
});

check('settle: K below petrol books a money-back row', async () => {
  const c = await getCast();
  const r = await freshRider();
  await work(r, 3, 10, 500);
  const K = Math.round(10 * (await kRate(3)) * 100);
  await petrol(r, 200, 'upi', at(3, '11:00'));
  const pv = await okPreview(c.counter, r);
  eq(pv.net_paise, K - 20000, 'net');
  const res = await commit(c.counter, r, pv, { action: 'carry' });
  eq(res.status, 201, 'carry ' + JSON.stringify(res.body));
  const km = await (await getDb()).prepare("SELECT * FROM expenses WHERE km_settlement_id = ? AND payment_method = 'km_account'").get(res.body.data.settlement_id);
  eq(P(km.amount), 20000 - K, 'money-back amount');
  eq(Number(km.is_return), 1, 'is_return');
});

check("settle: own-pocket Rider petrol for a rider is refused", async () => {
  const c = await getCast();
  const r = await freshRider();
  const base = { location_id: TEST_LOCATION_ID, item_id: await petrolItem(), amount: 50 };
  const own = await api('POST', '/expenses', c.counter, { ...base, payment_method: 'own_pocket', paid_by_user_id: r });
  eq(own.status, 400, 'create ' + JSON.stringify(own.body));
  eq(own.body.message, COPY.ownPetrol, 'create copy');
  const ok = await api('POST', '/expenses', c.counter, { ...base, payment_method: 'upi', given_to_user_id: r });
  eq(ok.status, 201, 'upi petrol');
  const ch = await api('PUT', `/expenses/${ok.body.data.id}`, c.owner, { payment_method: 'own_pocket', paid_by_user_id: r });
  eq(ch.status, 400, 'change ' + JSON.stringify(ch.body));
  eq(ch.body.message, COPY.ownPetrol, 'change copy');
  const kmMethod = await api('POST', '/expenses', c.counter, { ...base, payment_method: 'km_account', given_to_user_id: r });
  eq(kmMethod.status, 400, 'km_account is never typed in by hand');
});

check('settle: pay cash moves the drawer once; UPI does not; km_account never counts', async () => {
  const c = await getCast();
  const reg = await openOwnRegister();
  const r = await freshRider();
  await work(r, 3, 100, 700);
  const K = Math.round(100 * (await kRate(3)) * 100);
  await petrol(r, (K - 20000) / 100, 'upi', at(3, '10:00'));
  const pv = await okPreview(c.counter, r);
  eq(pv.net_paise, 20000, 'net +200');
  const d0 = await drawer(reg);
  const res = await commit(c.counter, r, pv, { action: 'pay', amount: 200, method: 'cash' });
  eq(res.status, 201, 'pay ' + JSON.stringify(res.body));
  const s = await settlementRow(res.body.data.settlement_id);
  eq(P(s.moved_amount), 20000, 'moved');
  eq(s.moved_method, 'cash', 'moved method');
  eq(Number(s.register_id), reg, 'register');
  eq(P(s.carry_out), 0, 'carry 0');
  eq(P(await drawer(reg)), P(d0) - 20000, 'expected cash -200 once');
  const pvClose = await api('PUT', '/sales/register/close', c.owner, { location_id: TEST_LOCATION_ID, actual_cash: 0, preview: true });
  eq(pvClose.status, 200, 'close preview');
  eq(P(pvClose.body.data.expected_cash), P(await drawer(reg)), 'close preview matches expected cash');
  const st = await api('GET', `/sales/register/status?location_id=${TEST_LOCATION_ID}`, c.owner);
  eq(P(st.body.data.km_paid_out), 20000, 'status shows km paid out');
  // A km_account row, even one wrongly tied to the session, never moves the drawer.
  const db = await getDb();
  const e = await db.prepare(`INSERT INTO expenses (location_id, category, amount, description, payment_method, expense_date, created_by, register_id)
    VALUES (?, 'transport', 999, 'VerifyRK km row', 'km_account', CURRENT_DATE, ?, ?) RETURNING id`).get(TEST_LOCATION_ID, c.owner, reg);
  const pv2 = await api('PUT', '/sales/register/close', c.owner, { location_id: TEST_LOCATION_ID, actual_cash: 0, preview: true });
  await db.prepare('DELETE FROM expenses WHERE id = ?').run(e.id);
  eq(P(pv2.body.data.expected_cash), P(pvClose.body.data.expected_cash), 'km_account row ignored by close');
  // UPI pay: no drawer change.
  const r2 = await freshRider();
  await work(r2, 3, 10, 900);
  const pvu = await okPreview(c.counter, r2);
  const d1 = await drawer(reg);
  const u = await commit(c.counter, r2, pvu, { action: 'pay', amount: pvu.net_paise / 100, method: 'upi' });
  eq(u.status, 201, 'pay upi ' + JSON.stringify(u.body));
  eq(await drawer(reg), d1, 'UPI leaves the drawer');
  const su = await settlementRow(u.body.data.settlement_id);
  eq(su.register_id, null, 'UPI has no register');
  eq(su.moved_method, 'upi', 'UPI method');
});

check('settle: take cash with the register closed is refused, UPI and carry allowed', async () => {
  const c = await getCast();
  await closeOwnRegister();
  const foreign = await testLocRegister();
  const r = await freshRider();
  await work(r, 3, 10, 100);
  const K = Math.round(10 * (await kRate(3)) * 100);
  await petrol(r, (K + 7000) / 100, 'upi', at(3, '10:00'));
  const pv = await okPreview(c.counter, r);
  eq(pv.net_paise, -7000, 'rider owes 70');
  if (!foreign) {
    const t = await commit(c.counter, r, pv, { action: 'take', amount: 70, method: 'cash' });
    eq(t.status, 409, 'take cash closed ' + JSON.stringify(t.body));
    eq(t.body.message, COPY.take, 'take copy');
  }
  const big = await commit(c.counter, r, pv, { action: 'take', amount: 71, method: 'upi' });
  eq(big.status, 400, 'more than owed');
  const tu = await commit(c.counter, r, pv, { action: 'take', amount: 70, method: 'upi' });
  eq(tu.status, 201, 'take upi ' + JSON.stringify(tu.body));
  eq(P((await settlementRow(tu.body.data.settlement_id)).carry_out), 0, 'carry 0');
  const r2 = await freshRider();
  await work(r2, 3, 10, 200);
  const p2 = await okPreview(c.counter, r2);
  if (!foreign) {
    const pc = await commit(c.counter, r2, p2, { action: 'pay', amount: 10, method: 'cash' });
    eq(pc.status, 409, 'pay cash closed ' + JSON.stringify(pc.body));
    eq(pc.body.message, COPY.pay, 'pay copy');
  }
  const cr = await commit(c.counter, r2, p2, { action: 'carry' });
  eq(cr.status, 201, 'carry with register closed ' + JSON.stringify(cr.body));
  if (foreign) throw skip(`Test Loc register #${foreign.id} is open and is not this run's; cash refusals skipped, UPI and carry passed.`);
});

check('settle: carry chains across three settlements', async () => {
  const c = await getCast();
  const r = await freshRider();
  await work(r, 5, 10, 100);
  const K5 = Math.round(10 * (await kRate(5)) * 100);
  await petrol(r, 200, 'upi', at(5, '10:00'));
  const p1 = await okPreview(c.counter, r);
  const s1 = await commit(c.counter, r, p1, { action: 'carry' });
  eq(s1.status, 201, 's1');
  eq(P((await settlementRow(s1.body.data.settlement_id)).carry_out), K5 - 20000, 's1 carry');
  await work(r, 4, 20, 112);
  const K4 = Math.round(20 * (await kRate(4)) * 100);
  const p2 = await okPreview(c.counter, r);
  eq(p2.lines.carried_in_paise, K5 - 20000, 's2 carried in');
  eq(p2.net_paise, K4 + K5 - 20000, 's2 net');
  assert(p2.net_paise < 0, 's2 rider owes');
  const s2 = await commit(c.counter, r, p2, { action: 'take', amount: -p2.net_paise / 100, method: 'upi' });
  eq(s2.status, 201, 's2 ' + JSON.stringify(s2.body));
  eq(P((await settlementRow(s2.body.data.settlement_id)).carry_out), 0, 's2 carry 0');
  await work(r, 3, 5, 134);
  const p3 = await okPreview(c.counter, r);
  eq(p3.lines.carried_in_paise, 0, 's3 carried in 0');
  const s3 = await commit(c.counter, r, p3, { action: 'pay', amount: p3.net_paise / 100, method: 'upi' });
  eq(s3.status, 201, 's3 ' + JSON.stringify(s3.body));
  eq(P((await settlementRow(s3.body.data.settlement_id)).carry_out), 0, 's3 carry 0');
});

check('settle: Paid to own UPI switch', async () => {
  const c = await getCast();
  const r = await freshRider();
  await work(r, 3, 112, 100);
  const own = await cod(r, { upi: 300 });
  const other = await cod(r, { upi: 100 });
  const pv = await okPreview(c.counter, r);
  eq(pv.lines.cod_held_paise, 0, 'UPI not held by default');
  const line = pv.lines.cod.find((x) => x.delivery_id === own);
  eq(line && line.upi_paise, 30000, 'UPI part listed');
  const stale = await commit(c.counter, r, pv, { action: 'carry', upi_own_delivery_ids: [own] });
  eq(stale.status, 409, 'expected must include the switch');
  eq(stale.body.code, 'CHANGED', 'code');
  const ok = await commit(c.counter, r, { ...pv, net_paise: pv.net_paise - 30000 }, { action: 'carry', upi_own_delivery_ids: [own] });
  eq(ok.status, 201, 'with switch ' + JSON.stringify(ok.body));
  const s = await settlementRow(ok.body.data.settlement_id);
  eq(P(s.cod_held), 30000, 'cod held 300');
  eq(JSON.parse(s.upi_own_delivery_ids).map(Number).join(','), String(own), 'switch saved');
  eq((await deliveryRow(own)).cod_status, 'settled', 'own UPI COD settled');
  const o = await deliveryRow(other);
  eq(o.cod_status, 'collected', 'shop UPI COD left for Settlements');
  eq(o.km_settlement_id, null, 'not linked');
});

check('settle: stale expected_net is refused with CHANGED', async () => {
  const c = await getCast();
  const r = await freshRider();
  await work(r, 3, 112, 100);
  const pv = await okPreview(c.counter, r);
  eq((await api('POST', '/rider-km/corrections', c.mgr, { user_id: r, km: 10, note: 'VerifyRK late trip' })).status, 201, 'correction');
  const res = await commit(c.counter, r, pv, { action: 'carry' });
  eq(res.status, 409, 'stale ' + JSON.stringify(res.body));
  eq(res.body.code, 'CHANGED', 'code');
  eq(res.body.message, COPY.changed, 'copy');
  const n = await (await getDb()).prepare('SELECT COUNT(*) AS c FROM rider_km_settlements WHERE user_id = ?').get(r);
  eq(Number(n.c), 0, 'nothing written');
});

check('settle: open gaps block settling', async () => {
  const c = await getCast();
  const r = await freshRider();
  await post(c.mgr, r, 'arrive', 100, at(3, '09:00'));
  await post(c.mgr, r, 'arrive', 500, at(3, '13:00'));
  await post(c.mgr, r, 'leave', 540, at(3, '18:00'));
  const p = await preview(c.counter, r);
  eq(p.status, 409, 'gaps ' + JSON.stringify(p.body));
  eq(p.body.code, 'GAPS_OPEN', 'code');
  eq(p.body.message, COPY.gaps, 'copy');
  const cm = await api('POST', `/rider-km/${r}/settle`, c.counter, { location_id: TEST_LOCATION_ID, expected_net_paise: 0, action: 'carry' });
  eq(cm.status, 409, 'commit too');
  eq(cm.body.code, 'GAPS_OPEN', 'commit code');
  const list = await api('GET', `/rider-km/riders?location_id=${TEST_LOCATION_ID}`, c.counter);
  eq(list.body.data.find((x) => x.id === r).balance_paise, null, 'balance null with gaps');
  const v = await view(c.mgr, r);
  const gap = v.stretches.find((s) => s.kind === 'gap');
  eq((await api('POST', '/rider-km/gaps', c.counter, { user_id: r, from_reading_id: gap.from_reading_id, to_reading_id: gap.to_reading_id, answer: 'none' })).status, 200, 'answer');
  eq((await preview(c.counter, r)).status, 200, 'settles after the answer');
});

// A shop-local 'YYYY-MM-DD HH:MM:SS' (IST) as the UTC wall clock that
// expenses.created_at holds, worked out here in JS rather than in SQL.
function istToUtcWall(local) {
  return new Date(`${local.replace(' ', 'T')}+05:30`).toISOString().slice(0, 19).replace('T', ' ');
}
// Petrol whose created_at is set straight from a UTC literal.
async function petrolUtc(rider, amount, method, utcWall) {
  const c = await getCast();
  const r = await api('POST', '/expenses', c.counter, {
    location_id: TEST_LOCATION_ID, item_id: await petrolItem(), amount, payment_method: method, given_to_user_id: rider,
  });
  eq(r.status, 201, 'petrol ' + JSON.stringify(r.body));
  await (await getDb()).prepare('UPDATE expenses SET created_at = CAST(? AS timestamp) WHERE id = ?').run(utcWall, r.body.data.id);
  return r.body.data.id;
}

check('settle: petrol window follows the cutoff reading and the account start', async () => {
  const c = await getCast();
  const r = await freshRider();
  await work(r, 3, 10, 100);
  // The cutoff is the 18:00 IST going-home reading, which is 12:30 UTC.
  const cutUtc = istToUtcWall(at(3, '18:00'));
  assert(cutUtc.endsWith(' 12:30:00'), 'cutoff in UTC ' + cutUtc);
  const day = cutUtc.slice(0, 10);
  const inside = await petrolUtc(r, 50, 'upi', `${day} 12:29:00`);
  const after = await petrolUtc(r, 70, 'upi', `${day} 12:31:00`);
  const before = await petrolUtc(r, 90, 'upi', istToUtcWall(at(4, '12:00')));
  const p1 = await okPreview(c.counter, r);
  eq(p1.lines.petrol.map((x) => x.id).join(','), String(inside), 'only the petrol saved before the cutoff');
  eq(p1.lines.petrol_taken_paise, 5000, 'petrol taken');
  const s1 = await commit(c.counter, r, p1, { action: 'carry' });
  eq(s1.status, 201, 's1');
  await work(r, 2, 10, 112);
  const p2 = await okPreview(c.counter, r);
  eq(p2.lines.petrol.map((x) => x.id).join(','), String(after), 'the later petrol comes next time');
  const db = await getDb();
  eq((await db.prepare('SELECT km_settlement_id FROM expenses WHERE id = ?').get(before)).km_settlement_id, null, 'petrol before the account start ignored');
});

check('settle: settle-now and km settle race on one COD', async () => {
  const c = await getCast();
  await openOwnRegister();
  for (let round = 0; round < 2; round++) {
    const r = await freshRider();
    await work(r, 3, 112, 100);
    const d = await cod(r, { cash: 500 });
    const pv = await okPreview(c.counter, r);
    const sn = () => api('POST', '/deliveries/settlements/settle-now', c.counter, { delivery_partner_id: r, delivery_ids: [d], location_id: TEST_LOCATION_ID });
    const km = () => commit(c.counter, r, pv, { action: 'carry' });
    const [a, b] = round === 0 ? await Promise.all([sn(), km()]) : (await Promise.all([km(), sn()])).reverse();
    const db = await getDb();
    const items = Number((await db.prepare('SELECT COUNT(*) AS c FROM delivery_settlement_items WHERE delivery_id = ?').get(d)).c);
    const row = await deliveryRow(d);
    const viaKm = row.km_settlement_id != null ? 1 : 0;
    eq(items + viaKm, 1, `round ${round}: settled exactly once (settle-now ${a.status}, km ${b.status})`);
    if (viaKm) {
      eq(b.status, 201, 'km won');
      eq(a.status, 400, 'settle-now skipped it ' + JSON.stringify(a.body));
    } else {
      eq(a.status, 201, 'settle-now won ' + JSON.stringify(a.body));
      eq(b.status, 409, 'km lost ' + JSON.stringify(b.body));
      eq(b.body.code, 'CHANGED', 'km CHANGED');
    }
    eq(row.cod_status, 'settled', 'settled');
    console.log(`   race round ${round}: ${viaKm ? 'km settlement' : 'settle-now'} won`);
  }
  // Round 3: the km settlement reaches the delivery row lock first (a test
  // transaction holds the row, km queues, then settle-now queues behind it).
  const { Client } = require('pg');
  const r = await freshRider();
  await work(r, 3, 112, 100);
  const d = await cod(r, { cash: 500 });
  const pv = await okPreview(c.counter, r);
  const holder = new Client({ connectionString: process.env.DATABASE_URL });
  await holder.connect();
  let kmP; let snP;
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM deliveries WHERE id = $1 FOR UPDATE', [d]);
    kmP = commit(c.counter, r, pv, { action: 'carry' });
    await new Promise((ok) => setTimeout(ok, 700));
    snP = api('POST', '/deliveries/settlements/settle-now', c.counter, { delivery_partner_id: r, delivery_ids: [d], location_id: TEST_LOCATION_ID });
    await new Promise((ok) => setTimeout(ok, 700));
  } finally {
    await holder.query('ROLLBACK');
    await holder.end();
  }
  const [k, n] = await Promise.all([kmP, snP]);
  eq(k.status, 201, 'km got the row first ' + JSON.stringify(k.body));
  eq(n.status, 400, 'settle-now then skipped it ' + JSON.stringify(n.body));
  const row = await deliveryRow(d);
  assert(row.km_settlement_id != null, 'km linked');
  eq(Number((await (await getDb()).prepare('SELECT COUNT(*) AS c FROM delivery_settlement_items WHERE delivery_id = ?').get(d)).c), 0, 'no settle-now row');
  const all = await api('POST', '/deliveries/settlements/settle-now', c.counter, { delivery_partner_id: r, location_id: TEST_LOCATION_ID });
  eq(all.status, 400, 'settle all finds nothing left');
});

check('settle: two settles at once, one wins', async () => {
  const c = await getCast();
  const r = await freshRider();
  await work(r, 3, 112, 100);
  const pv = await okPreview(c.counter, r);
  const both = await Promise.all([commit(c.counter, r, pv, { action: 'carry' }), commit(c.counter2, r, pv, { action: 'carry' })]);
  const st = both.map((x) => x.status).sort().join(',');
  eq(st, '201,409', 'one wins ' + JSON.stringify(both.map((x) => x.body)));
  eq(both.find((x) => x.status === 409).body.code, 'CHANGED', 'loser CHANGED');
  const n = await (await getDb()).prepare('SELECT COUNT(*) AS c FROM rider_km_settlements WHERE user_id = ?').get(r);
  eq(Number(n.c), 1, 'one settlement');
});

check('settle: counter staff can settle; florist 403; salary action owner only', async () => {
  const c = await getCast();
  const r = await freshRider();
  await work(r, 3, 10, 100);
  for (const who of [c.florist, c.helper, c.customer, c.rider]) {
    eq((await preview(who, r)).status, 403, 'preview 403 for ' + who);
  }
  eq((await api('GET', `/rider-km/riders?location_id=${TEST_LOCATION_ID}`, c.florist)).status, 403, 'florist list');
  const pv = await okPreview(c.counter, r);
  const ms = await commit(c.mgr, r, pv, { action: 'salary' });
  eq(ms.status, 403, 'manager salary');
  const cs = await commit(c.counter, r, pv, { action: 'salary' });
  eq(cs.status, 403, 'counter salary');
  const os = await commit(c.owner, r, pv, { action: 'salary' });
  eq(os.status, 201, 'owner salary ' + JSON.stringify(os.body));
  const s = await settlementRow(os.body.data.settlement_id);
  eq(s.action, 'carry', 'salary commits as a carry');
  eq(s.lines_json && s.lines_json.for_salary, true, 'flagged for salary');
  eq(s.salary_payment_id, null, 'no payment yet');
  eq(P(s.carry_out), pv.net_paise, 'carry = net');
  const r2 = await freshRider();
  await work(r2, 3, 10, 100);
  const cc = await commit(c.counter, r2, await okPreview(c.counter, r2), { action: 'carry' });
  eq(cc.status, 201, 'counter settles');
});

check('gap answer is paid no more than the stretch after a reading change', async () => {
  const c = await getCast();
  const r = await freshRider();
  await post(c.mgr, r, 'arrive', 100, at(2, '09:00'));
  const a2 = await post(c.mgr, r, 'arrive', 500, at(2, '18:00'));
  const v = await view(c.mgr, r);
  const gap = v.stretches.find((s) => s.kind === 'gap');
  eq((await api('POST', '/rider-km/gaps', c.counter, { user_id: r, from_reading_id: gap.from_reading_id, to_reading_id: gap.to_reading_id, answer: 'typed', work_km: 200 })).status, 200, 'answer 200');
  eq((await api('PUT', `/rider-km/readings/${a2.body.data.reading.id}`, c.mgr, { meter: 200 })).status, 200, 'meter now 200');
  eq((await view(c.mgr, r)).unsettled.paid_km, 100, 'paid no more than the 100 km stretch');
});

check('an impossible date is a plain 400', async () => {
  const c = await getCast();
  const r = await freshRider();
  for (const t of ['2026-02-30 25:00', '2026-02-30 10:00', '2026-01-10 10:75']) {
    const p = await post(c.mgr, r, 'arrive', 100, t);
    eq(p.status, 400, t + ' ' + JSON.stringify(p.body));
    eq(p.body.message, 'Pick the date and time again.', 'copy');
  }
});

check('settle: rate back-dated after a settlement changes only unsettled km', async () => {
  const c = await getCast();
  const r = await freshRider();
  await work(r, 4, 112, 100);
  const pv = await okPreview(c.counter, r);
  const s1 = await commit(c.counter, r, pv, { action: 'carry' });
  eq(s1.status, 201, 's1');
  const before = await settlementRow(s1.body.data.settlement_id);
  const db = await getDb();
  const eff = at(6, '09:00').slice(0, 10);
  try {
    const set = await api('PUT', '/rider-km/rate', c.owner, { rate: 7, effective_from: eff });
    eq(set.status, 200, 'rate set ' + JSON.stringify(set.body));
    await work(r, 2, 10, 215);
    const p2 = await okPreview(c.counter, r);
    eq(p2.lines.km_paise, 7000, 'new km at the new rate');
    eq(p2.lines.carried_in_paise, pv.net_paise, 'settled amount carried unchanged');
    const after = await settlementRow(s1.body.data.settlement_id);
    eq(P(after.km_amount), P(before.km_amount), 'settled km amount never moves');
    eq((await view(c.mgr, r)).unsettled.paid_km, 10, 'only unsettled km open');
  } finally {
    await db.prepare('DELETE FROM rider_km_rates WHERE effective_from = CAST(? AS date) AND rate = 7').run(eff);
  }
});

// ─── Task 4: payroll and the rider's own view ────────────────
// Only riders and staff this run made are ever paid; their salary rows are
// made here and removed in cleanup.
async function salaried(role) {
  const c = await getCast();
  const db = await getDb();
  const u = role === 'delivery_partner' ? await freshRider() : await makeUser(db, { role, name: 'VerifyRK Staff ' + createdUserIds.length });
  await db.prepare("INSERT INTO employee_salaries (user_id, monthly_salary, salary_type, updated_by) VALUES (?, 15000, 'monthly', ?)").run(u, c.owner);
  return u;
}
let payYear = 2001;
function payPeriod() { const y = payYear++; return { period_start: `${y}-01-01`, period_end: `${y}-01-31` }; }
async function calcPay(userId, period) {
  const c = await getCast();
  const r = await api('POST', '/staff/payroll/calculate', c.owner, { user_id: userId, ...(period || payPeriod()) });
  eq(r.status, 200, 'calculate ' + JSON.stringify(r.body));
  return r.body.data;
}
async function payRider(userId, period, extra) {
  const c = await getCast();
  return api('POST', '/staff/payroll/disburse', c.owner, {
    user_id: userId, ...period, base_salary: 15000, deductions: 0, bonus: 0, advances_deducted: 0,
    payment_method: 'upi', net_amount: 15000, ...extra,
  });
}
// A rider with one settled day and a carry; returns { r, carry }.
async function riderWithCarry({ km = 20, codCash = 500, meter = 100, salary = true } = {}) {
  const c = await getCast();
  const r = salary ? await salaried('delivery_partner') : await freshRider();
  await work(r, 4, km, meter);
  if (codCash) await cod(r, { cash: codCash });
  const pv = await okPreview(c.counter, r);
  const res = await commit(c.counter, r, pv, { action: 'carry' });
  eq(res.status, 201, 'carry ' + JSON.stringify(res.body));
  return { r, carry: pv.net_paise };
}
const lastSettlementOf = async (r) => (await getDb()).prepare('SELECT * FROM rider_km_settlements WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(r);

check('payroll shows a rider carry and Settle km first', async () => {
  const { r, carry } = await riderWithCarry();
  assert(carry < 0, 'rider owes ' + carry);
  let k = (await calcPay(r)).km;
  assert(k, 'km block');
  eq(k.carried_paise, carry, 'carried');
  eq(k.unsettled, false, 'nothing unsettled');
  eq(k.settle_first_message, null, 'no message');
  await work(r, 2, 10, 125);
  k = (await calcPay(r)).km;
  eq(k.unsettled, true, 'new km is unsettled');
  eq(k.settle_first_message, 'VerifyRK has km not settled — Settle km first', 'copy');
  eq(k.carried_paise, carry, 'carry unchanged');
  // Petrol taken after a settled day, with no new readings, is unsettled too.
  const { r: r2 } = await riderWithCarry({ codCash: 0 });
  eq((await calcPay(r2)).km.unsettled, false, 'clean after the settle');
  await petrol(r2, 30, 'upi', at(1, '10:00'));
  eq((await calcPay(r2)).km.unsettled, true, 'petrol alone is unsettled');
  // Open shopping money is unsettled too.
  const { r: r3 } = await riderWithCarry({ codCash: 0 });
  await shopping(r3, 100, 0);
  eq((await calcPay(r3)).km.unsettled, true, 'shopping money is unsettled');
  eq((await calcPay(r3)).calculation.open_shopping_money_total, 0, 'riders still never get the shopping money tick');
});

check('applying the carry takes it off pay and zeroes the balance', async () => {
  const c = await getCast();
  const { r, carry } = await riderWithCarry();
  const period = payPeriod();
  eq((await calcPay(r, period)).km.carried_paise, carry, 'calculate shows it');
  const res = await payRider(r, period, { apply_km_carry: true, expected_km_carry_paise: carry });
  eq(res.status, 201, 'pay ' + JSON.stringify(res.body));
  eq(P(res.body.data.net_amount), 1500000 + carry, 'pay less what the rider owes');
  const s = await lastSettlementOf(r);
  eq(s.action, 'salary', 'salary row');
  eq(P(s.carry_out), 0, 'carry zeroed');
  eq(P(s.carried_in), carry, 'carried in');
  eq(P(s.moved_amount), Math.abs(carry), 'moved = |carry|');
  eq(Number(s.salary_payment_id), Number(res.body.data.id), 'linked to the payment');
  eq(s.cutoff_reading_id, null, 'covers no readings');
  eq(s.register_id, null, 'UPI pay: no register');
  const exp = await (await getDb()).prepare('SELECT amount FROM expenses WHERE id = ?').get(res.body.data.expense_id);
  eq(P(exp.amount), 1500000, 'salary expense is the salary only (km is in the petrol book)');
  eq((await calcPay(r)).km.carried_paise, 0, 'balance now 0');
  const pv = await preview(c.counter, r);
  eq(pv.status, 409, 'nothing left to settle, old km not back ' + JSON.stringify(pv.body));
  eq((await view(c.mgr, r)).unsettled.paid_km, 0, 'old km stays settled');
  // Not a rider; a carry bigger than the pay; no carry to apply.
  const staff = await salaried('counter_staff');
  const ns = await payRider(staff, payPeriod(), { apply_km_carry: true, expected_km_carry_paise: 0 });
  eq(ns.status, 400, 'not a rider ' + JSON.stringify(ns.body));
  const { r: big, carry: bigCarry } = await riderWithCarry({ codCash: 20000, meter: 500 });
  const bp = await payRider(big, payPeriod(), { net_amount: 100, apply_km_carry: true, expected_km_carry_paise: bigCarry });
  eq(bp.status, 400, 'carry bigger than the pay ' + JSON.stringify(bp.body));
  eq(Number((await (await getDb()).prepare('SELECT COUNT(*) AS c FROM salary_payments WHERE user_id = ?').get(big)).c), 0, 'nothing paid');
  const zr = await salaried('delivery_partner');
  const z = await payRider(zr, payPeriod(), { apply_km_carry: true, expected_km_carry_paise: 0 });
  eq(z.status, 201, 'zero carry pays as normal ' + JSON.stringify(z.body));
  eq(P(z.body.data.net_amount), 1500000, 'unchanged net');
  eq(await lastSettlementOf(zr), undefined, 'no settlement row for a zero carry');
});

check('applying a shop-owes carry in cash adds it to pay and the drawer adds up', async () => {
  const c = await getCast();
  const reg = await openOwnRegister();
  const { r, carry } = await riderWithCarry({ codCash: 0, meter: 700 });
  assert(carry > 0, 'shop owes ' + carry);
  const closeExpected = async () => {
    const p = await api('PUT', '/sales/register/close', c.owner, { location_id: TEST_LOCATION_ID, actual_cash: 0, preview: true });
    eq(p.status, 200, 'close preview ' + JSON.stringify(p.body));
    return P(p.body.data.expected_cash);
  };
  const before = await drawer(reg);
  const beforeClose = await closeExpected();
  const res = await payRider(r, payPeriod(), { payment_method: 'cash', apply_km_carry: true, expected_km_carry_paise: carry });
  eq(res.status, 201, 'pay ' + JSON.stringify(res.body));
  eq(P(res.body.data.net_amount), 1500000 + carry, 'pay plus what the shop owes');
  eq(P(await drawer(reg)), P(before) - 1500000 - carry, 'drawer down by all the cash paid');
  eq(beforeClose - (await closeExpected()), 1500000 + carry, 'close count agrees with the drawer');
  const s = await lastSettlementOf(r);
  eq(Number(s.register_id), reg, 'register on the row');
  eq(s.moved_method, 'cash', 'cash');
});

check('a stale carry at pay is refused', async () => {
  const c = await getCast();
  const { r, carry } = await riderWithCarry();
  const period = payPeriod();
  eq((await calcPay(r, period)).km.carried_paise, carry, 'calculated');
  await work(r, 2, 10, 125);
  const pv = await okPreview(c.counter, r);
  eq((await commit(c.counter, r, pv, { action: 'carry' })).status, 201, 'second carry');
  const res = await payRider(r, period, { apply_km_carry: true, expected_km_carry_paise: carry });
  eq(res.status, 409, 'stale ' + JSON.stringify(res.body));
  eq(res.body.code, 'CHANGED', 'code');
  eq(res.body.message, 'Something changed — check the figures again.', 'copy');
  const missing = await payRider(r, period, { apply_km_carry: true });
  eq(missing.status, 409, 'no expected figure');
  const db = await getDb();
  eq(Number((await db.prepare('SELECT COUNT(*) AS c FROM salary_payments WHERE user_id = ?').get(r)).c), 0, 'nothing paid');
  eq((await lastSettlementOf(r)).action, 'carry', 'no salary row');
});

check('the settle sheet Take from salary carry shows at payroll', async () => {
  const c = await getCast();
  const r = await salaried('delivery_partner');
  await work(r, 3, 20, 100);
  const pv = await okPreview(c.owner, r);
  const res = await commit(c.owner, r, pv, { action: 'salary' });
  eq(res.status, 201, 'salary ' + JSON.stringify(res.body));
  const k = (await calcPay(r)).km;
  eq(k.carried_paise, pv.net_paise, 'payroll shows that carry');
  eq(k.unsettled, false, 'settled');
  eq(k.for_salary, true, 'marked for salary');
});

check('rider /mine has the km block', async () => {
  const c = await getCast();
  const r = await freshRider();
  await work(r, 3, 20, 100);
  await petrol(r, 30, 'upi', at(3, '12:00'));
  await cod(r, { cash: 200 });
  const pv = await okPreview(c.counter, r);
  let m = await api('GET', '/staff-money/mine', r);
  eq(m.status, 200, 'mine ' + JSON.stringify(m.body));
  let k = m.body.data.km;
  assert(k, 'km block');
  eq(k.unsettled_km, pv.lines.paid_km, 'km');
  eq(k.unsettled_paise, pv.lines.km_paise, 'km money');
  eq(k.petrol_taken_paise, 3000, 'petrol');
  eq(k.cod_held_paise, 20000, 'cod');
  eq(k.balance_paise, pv.net_paise, 'balance');
  eq(k.last.length, 0, 'no settlements yet');
  eq((await commit(c.counter, r, pv, { action: 'carry' })).status, 201, 'carry');
  m = await api('GET', '/staff-money/mine', r);
  k = m.body.data.km;
  eq(k.unsettled_km, 0, 'nothing unsettled');
  eq(k.balance_paise, pv.net_paise, 'balance = carry');
  eq(k.last.length, 1, 'one settlement');
  eq(k.last[0].carry_out_paise, pv.net_paise, 'carry shown');
  eq(k.last[0].paid_km, pv.lines.paid_km, 'km shown');
  const staff = await api('GET', '/staff-money/mine', c.counter);
  eq(staff.status, 200, 'counter mine');
  eq(staff.body.data.km, undefined, 'no km block for counter staff');
});

check('a non-rider payroll is unchanged', async () => {
  const u = await salaried('counter_staff');
  const d = await calcPay(u);
  eq(Object.keys(d).sort().join(','), 'attendance_summary,calculation,partial_days,period,salary_config,user', 'data keys');
  eq(Object.keys(d.calculation).sort().join(','), 'base_pay,deductions,net_amount,open_shopping_money_total,pending_advances', 'calculation keys');
});

check('a settlement with no new readings keeps old km settled', async () => {
  const c = await getCast();
  const { r } = await riderWithCarry({ codCash: 0, salary: false });
  await cod(r, { cash: 100 });
  const p2 = await okPreview(c.counter, r);
  eq(p2.lines.paid_km, 0, 'no km on the COD-only settle');
  eq(p2.cutoff_reading_id, null, 'no cutoff');
  eq((await commit(c.counter, r, p2, { action: 'carry' })).status, 201, 'carry COD only');
  const p3 = await okPreview(c.counter, r);
  eq(p3.lines.paid_km, 0, 'old km not back');
  eq(p3.lines.km_paise, 0, 'old km money not back');
  eq((await view(c.mgr, r)).unsettled.paid_km, 0, 'view agrees');
});

check('a rider who has left can still be viewed and settled, but gets no new readings', async () => {
  const c = await getCast();
  const r = await freshRider();
  await work(r, 3, 20, 100);
  const db = await getDb();
  await db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(r);
  eq((await api('GET', `/rider-km/${r}`, c.mgr)).status, 200, 'view');
  const pv = await okPreview(c.counter, r);
  eq((await post(c.mgr, r, 'arrive', 500, at(1, '09:00'))).status, 400, 'no new reading');
  const res = await commit(c.counter, r, pv, { action: 'pay', amount: pv.net_paise / 100, method: 'upi' });
  eq(res.status, 201, 'final settle ' + JSON.stringify(res.body));
  eq(P((await lastSettlementOf(r)).carry_out), 0, 'nothing left');
});

check('a rider who has left with an open gap can have it answered, then settle', async () => {
  const c = await getCast();
  const r = await freshRider();
  eq((await post(c.mgr, r, 'arrive', 100, at(3, '09:00'))).status, 201, 'a1');
  eq((await post(c.mgr, r, 'leave', 120, at(3, '18:00'))).status, 201, 'l1');
  eq((await post(c.mgr, r, 'arrive', 500, at(2, '09:00'))).status, 201, 'a2');
  eq((await post(c.mgr, r, 'leave', 520, at(2, '18:00'))).status, 201, 'l2');
  await (await getDb()).prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(r);
  const blocked = await preview(c.counter, r);
  eq(blocked.status, 409, 'gap first ' + JSON.stringify(blocked.body));
  eq(blocked.body.code, 'GAPS_OPEN', 'GAPS_OPEN');
  const gap = (await view(c.mgr, r)).stretches.find((x) => x.kind === 'gap');
  assert(gap, 'gap listed');
  const ans = await api('POST', '/rider-km/gaps', c.counter, { user_id: r, from_reading_id: gap.from_reading_id, to_reading_id: gap.to_reading_id, answer: 'none' });
  eq(ans.status, 200, 'answer for a rider who left ' + JSON.stringify(ans.body));
  const cor = await api('POST', '/rider-km/corrections', c.mgr, { user_id: r, km: 2, note: 'VerifyRK last trip' });
  eq(cor.status, 201, 'correction for a rider who left ' + JSON.stringify(cor.body));
  const pv = await okPreview(c.counter, r);
  eq(pv.lines.paid_km, 42, 'two days + correction');
  const res = await commit(c.counter, r, pv, { action: 'pay', amount: pv.net_paise / 100, method: 'upi' });
  eq(res.status, 201, 'final settle ' + JSON.stringify(res.body));
  eq(P((await lastSettlementOf(r)).carry_out), 0, 'nothing left');
});

check('applying a rider-owes carry in cash keeps it back from pay and the drawer adds up', async () => {
  const c = await getCast();
  const reg = await openOwnRegister();
  const { r, carry } = await riderWithCarry({ codCash: 500, meter: 900 });
  assert(carry < 0, 'rider owes ' + carry);
  const closeExpected = async () => {
    const p = await api('PUT', '/sales/register/close', c.owner, { location_id: TEST_LOCATION_ID, actual_cash: 0, preview: true });
    eq(p.status, 200, 'close preview ' + JSON.stringify(p.body));
    return P(p.body.data.expected_cash);
  };
  const before = await drawer(reg);
  const beforeClose = await closeExpected();
  const res = await payRider(r, payPeriod(), { payment_method: 'cash', apply_km_carry: true, expected_km_carry_paise: carry });
  eq(res.status, 201, 'pay ' + JSON.stringify(res.body));
  eq(P(res.body.data.net_amount), 1500000 + carry, 'pay less what the rider owes');
  eq(P(before) - P(await drawer(reg)), 1500000 + carry, 'drawer down by salary less the carry');
  eq(beforeClose - (await closeExpected()), 1500000 + carry, 'close count agrees with the drawer');
  const s = await lastSettlementOf(r);
  eq(Number(s.register_id), reg, 'register on the row');
  eq(s.moved_method, 'cash', 'cash');
  eq(P(s.carried_in), carry, 'carried in < 0');
});

check('an old own-pocket rider petrol row can still get a note', async () => {
  const c = await getCast();
  const db = await getDb();
  const item = await db.prepare("INSERT INTO expense_items (name, name_key, category) VALUES ('VerifyRK Fuel Old', 'verifyrk fuel old', 'transport') RETURNING id").get();
  createdItemIds.push(item.id);
  const r = await freshRider();
  const base = { location_id: TEST_LOCATION_ID, item_id: item.id, amount: 40, expense_date: todayStr() };
  const own = await api('POST', '/expenses', c.counter, { ...base, payment_method: 'own_pocket', paid_by_user_id: r });
  eq(own.status, 201, 'own pocket before the flag ' + JSON.stringify(own.body));
  const upi = await api('POST', '/expenses', c.counter, { ...base, payment_method: 'upi', given_to_user_id: r });
  eq(upi.status, 201, 'upi petrol');
  eq((await api('PUT', `/expenses/items/${item.id}/rider-petrol`, c.owner, { on: true })).status, 200, 'flag on');
  try {
    const note = await api('PUT', `/expenses/${own.body.data.id}`, c.owner, { note: 'VerifyRK note' });
    eq(note.status, 200, 'note only ' + JSON.stringify(note.body));
    const same = await api('PUT', `/expenses/${own.body.data.id}`, c.owner, { payment_method: 'own_pocket', paid_by_user_id: r, note: 'again' });
    eq(same.status, 200, 'same method and person sent back ' + JSON.stringify(same.body));
    const into = await api('PUT', `/expenses/${upi.body.data.id}`, c.owner, { payment_method: 'own_pocket', paid_by_user_id: r });
    eq(into.status, 400, 'changing to own pocket is refused ' + JSON.stringify(into.body));
    eq(into.body.message, COPY.ownPetrol, 'copy');
  } finally {
    await api('PUT', `/expenses/items/${item.id}/rider-petrol`, c.owner, { on: false });
  }
});

// ─── Task 6: settlements history and riders who have left ────
check('km settlements history lists a settlement with its COD total', async () => {
  const c = await getCast();
  const r = await freshRider();
  await work(r, 2, 30, 700);
  await cod(r, { cash: 250 });
  await cod(r, { cash: 100, upi: 50 });
  const pv = await okPreview(c.counter, r);
  eq(pv.lines.cod_held_paise, 35000, 'cash COD held');
  const res = await commit(c.counter, r, pv, { action: 'carry' });
  eq(res.status, 201, 'carry ' + JSON.stringify(res.body));
  const sid = res.body.data.settlement_id;
  const list = await api('GET', `/rider-km/settlements?location_id=${TEST_LOCATION_ID}&limit=50`, c.counter);
  eq(list.status, 200, 'list ' + JSON.stringify(list.body));
  const row = list.body.data.find((x) => x.id === sid);
  assert(row, 'settlement listed');
  eq(row.user_id, r, 'rider id');
  eq(row.rider_name, 'VerifyRK Rider ' + (createdUserIds.indexOf(r)), 'rider name');
  eq(row.paid_km, 30, 'km');
  eq(row.cod_held_paise, 35000, 'COD settled');
  eq(row.cod_orders, 2, 'COD orders');
  eq(row.net_paise, pv.net_paise, 'net');
  eq(row.action, 'carry', 'action');
  eq(row.moved_paise, 0, 'nothing moved');
  eq(row.moved_method, null, 'no method');
  eq(row.carry_out_paise, pv.net_paise, 'carry out');
  assert(row.created_at, 'created_at');
  const ids = list.body.data.map((x) => x.id);
  assert(ids.every((id, i) => i === 0 || ids[i - 1] > id), 'newest first');
  eq((await api('GET', `/rider-km/settlements?location_id=${TEST_LOCATION_ID}`, c.florist)).status, 403, 'florist 403');
  eq((await api('GET', `/rider-km/settlements?location_id=${TEST_LOCATION_ID}`, c.rider)).status, 403, 'rider 403');
  const other = await api('GET', '/rider-km/settlements?location_id=999999', c.counter);
  eq(other.status, 403, 'not their shop ' + JSON.stringify(other.body));
});

check('rider list keeps a rider who has left while money is still open', async () => {
  const c = await getCast();
  const db = await getDb();
  const listed = async (id) => (await api('GET', `/rider-km/riders?location_id=${TEST_LOCATION_ID}`, c.counter)).body.data.find((x) => x.id === id);
  // Left with km not settled: listed, marked inactive.
  const open = await freshRider();
  await work(open, 2, 15, 300);
  await db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(open);
  const o = await listed(open);
  assert(o, 'left rider with unsettled km listed');
  eq(o.is_active, false, 'marked as left');
  eq(o.unsettled_km, 15, 'unsettled km');
  eq(o.has_account, true, 'has account');
  // Left with a carry and nothing else: listed.
  const carried = await freshRider();
  await work(carried, 2, 10, 400);
  await cod(carried, { cash: 900 });
  const pv = await okPreview(c.counter, carried);
  eq((await commit(c.counter, carried, pv, { action: 'carry' })).status, 201, 'carry');
  await db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(carried);
  const cr = await listed(carried);
  assert(cr, 'left rider with a carry listed');
  eq(cr.balance_paise, pv.net_paise, 'carry shown');
  // Left and fully settled: not listed.
  const done = await freshRider();
  await work(done, 2, 10, 500);
  const pd = await okPreview(c.counter, done);
  eq((await commit(c.counter, done, pd, { action: 'pay', amount: pd.net_paise / 100, method: 'upi' })).status, 201, 'paid');
  await db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(done);
  eq(await listed(done), undefined, 'settled leaver not listed');
  // Left after a settlement, with petrol handed over since: listed.
  const petrolLeaver = await freshRider();
  await work(petrolLeaver, 2, 10, 600);
  const pp = await okPreview(c.counter, petrolLeaver);
  eq((await commit(c.counter, petrolLeaver, pp, { action: 'pay', amount: pp.net_paise / 100, method: 'upi' })).status, 201, 'paid before petrol');
  await petrol(petrolLeaver, 80, 'upi', at(0, '00:01'));
  await db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(petrolLeaver);
  assert(await listed(petrolLeaver), 'leaver with petrol since the last settlement listed');
  // Left after a settlement, with COD collected since: listed.
  const codLeaver = await freshRider();
  await work(codLeaver, 2, 10, 800);
  const pc = await okPreview(c.counter, codLeaver);
  eq((await commit(c.counter, codLeaver, pc, { action: 'pay', amount: pc.net_paise / 100, method: 'upi' })).status, 201, 'paid before COD');
  await cod(codLeaver, { cash: 120 });
  await db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(codLeaver);
  assert(await listed(codLeaver), 'leaver with COD since the last settlement listed');
  // Active riders are marked active; one with no readings has no account.
  const fresh = await freshRider();
  const f = await listed(fresh);
  assert(f, 'active rider listed');
  eq(f.is_active, true, 'active');
  eq(f.has_account, false, 'no readings yet');
});

check('account view: readings carry created_by; a Take from salary settlement says for_salary', async () => {
  const c = await getCast();
  const r = await freshRider();
  await work(r, 2, 12, 900);
  const v = await view(c.mgr, r);
  eq(v.readings[0].created_by, c.mgr, 'created_by on a reading');
  const pv = await okPreview(c.owner, r);
  const res = await commit(c.owner, r, pv, { action: 'salary' });
  eq(res.status, 201, 'salary ' + JSON.stringify(res.body));
  const h = (await view(c.mgr, r)).history[0];
  eq(h.for_salary, true, 'for_salary in history');
  eq(h.action, 'carry', 'saved as a carry');
});

async function cleanup() {
  const db = await getDb();
  const del = async (label, sql, ...p) => { try { await db.prepare(sql).run(...p); } catch (e) { console.error(`cleanup ${label}: ${e.message}`); } };
  try { await closeOwnRegister(); } catch (e) { console.error('cleanup close: ' + e.message); }
  for (const id of createdUserIds) {
    await del('salary payments', 'DELETE FROM salary_payments WHERE user_id = ?', id);
    await del('salary config', 'DELETE FROM employee_salaries WHERE user_id = ?', id);
    await del('settle-now items', 'DELETE FROM delivery_settlement_items WHERE settlement_id IN (SELECT id FROM delivery_settlements WHERE delivery_partner_id = ?)', id);
    await del('settle-now rows', 'DELETE FROM delivery_settlements WHERE delivery_partner_id = ?', id);
    await del('collections', 'DELETE FROM delivery_collections WHERE delivery_id IN (SELECT id FROM deliveries WHERE delivery_partner_id = ?)', id);
    await del('deliveries', 'DELETE FROM deliveries WHERE delivery_partner_id = ?', id);
    await del('money settles', 'DELETE FROM staff_money_settles WHERE money_out_id IN (SELECT id FROM staff_money_out WHERE user_id = ?)', id);
    await del('money audits', "DELETE FROM audit_logs WHERE entity_type = 'staff_money_out' AND entity_id IN (SELECT id FROM staff_money_out WHERE user_id = ?)", id);
    await del('shop owes', 'DELETE FROM shop_owes WHERE user_id = ?', id);
    await del('expenses on lines', 'DELETE FROM expenses WHERE money_out_id IN (SELECT id FROM staff_money_out WHERE user_id = ?)', id);
  }
  for (const id of createdSaleIds) await del('sale payments ' + id, 'DELETE FROM payments WHERE sale_id = ?', id);
  for (const id of createdSaleIds) await del('sale audits ' + id, "DELETE FROM audit_logs WHERE entity_type = 'sale' AND entity_id = ?", id);
  for (const id of createdSaleIds) await del('sale ' + id, 'DELETE FROM sales WHERE id = ?', id);
  if (rateBefore) {
    const keep = rateBefore.map((x) => x.id);
    await del('rates', `DELETE FROM rider_km_rates WHERE id NOT IN (${keep.map(() => '?').join(',') || '0'})`, ...keep);
    for (const x of rateBefore) await del('rate restore', 'UPDATE rider_km_rates SET rate = ?, set_by = ? WHERE id = ?', x.rate, x.set_by, x.id);
  }
  for (const id of createdUserIds) {
    await del('km audits', "DELETE FROM audit_logs WHERE entity_type = 'rider_km' AND user_id = ?", id);
    await del('expense audits', "DELETE FROM audit_logs WHERE entity_type = 'expense' AND entity_id IN (SELECT id FROM expenses WHERE created_by = ?)", id);
    await del('expense item audits', "DELETE FROM audit_logs WHERE entity_type = 'expense_item' AND user_id = ?", id);
    await del('expenses', 'DELETE FROM expenses WHERE created_by = ?', id);
    await del('gap answers', 'DELETE FROM rider_km_gap_answers WHERE user_id = ?', id);
    await del('corrections', 'DELETE FROM rider_km_corrections WHERE user_id = ?', id);
    await del('settlements', 'DELETE FROM rider_km_settlements WHERE user_id = ?', id);
    await del('readings', 'DELETE FROM rider_km_readings WHERE user_id = ?', id);
    await del('notifications', 'DELETE FROM notifications WHERE user_id = ?', id);
  }
  for (const id of createdItemIds) {
    await del('item ' + id, "DELETE FROM expense_items WHERE id = ? AND name_key LIKE 'verifyrk%'", id);
  }
  for (const id of createdUserIds) await del('money lines', 'DELETE FROM staff_money_out WHERE user_id = ?', id);
  for (const id of createdRegisterIds) {
    await del('register audits', "DELETE FROM audit_logs WHERE entity_type = 'cash_register' AND entity_id = ?", id);
    await del('register expenses', 'DELETE FROM expenses WHERE register_id = ?', id);
    await del('register ' + id, 'DELETE FROM cash_registers WHERE id = ?', id);
  }
  for (const id of createdUserIds) {
    await del('links', 'DELETE FROM user_locations WHERE user_id = ?', id);
    await del('user ' + id, 'DELETE FROM users WHERE id = ?', id);
  }
}

async function main() {
  assertLocalTarget();
  let pass = 0, fail = 0;
  try {
    for (const { name, fn } of checks) {
      try { await fn(); console.log(`PASS ${name}`); pass++; }
      catch (err) {
        if (err.skip) { console.log(`SKIP ${name}\n   ${err.message}`); continue; }
        console.log(`FAIL ${name}\n   ${err.message}`); fail++;
      }
    }
  } finally { await cleanup(); }
  console.log(`\n${pass}/${pass + fail} checks passed`);
  process.exit(fail > 0 ? 1 : 0);
}
main();
