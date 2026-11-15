#!/usr/bin/env node
/**
 * Verification of the rider km account, Task 2: readings, gaps, corrections,
 * Km rate, the account view and the Rider petrol item flag (live API).
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
  eq((await api('PUT', `/rider-km/${r}/usual-home`, c.mgr, { km: null })).status, 200, 'clear');
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
  eq(me.open_day, true, 'open day');
  eq(me.balance_paise, null, 'balance null for now');
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

async function cleanup() {
  const db = await getDb();
  const del = async (label, sql, ...p) => { try { await db.prepare(sql).run(...p); } catch (e) { console.error(`cleanup ${label}: ${e.message}`); } };
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
      catch (err) { console.log(`FAIL ${name}\n   ${err.message}`); fail++; }
    }
  } finally { await cleanup(); }
  console.log(`\n${pass}/${pass + fail} checks passed`);
  process.exit(fail > 0 ? 1 : 0);
}
main();
