#!/usr/bin/env node
/**
 * Verification of Usual now / Often ranking (pure checks + one route check).
 * Test rows use the VerifyUN prefix and are removed by id.
 * Usage: source test-env.sh; node server/scripts/verify-usual-now.js
 */
require('dotenv').config();
const jwt = require('jsonwebtoken');
const { getDb } = require('../config/database-async');
const { findSlots, commonAmount, rankSuggestions, toShopLocal } = require('../utils/usual-now');

const API_BASE = process.env.API_BASE_URL || 'http://localhost:3001/api';
const TEST_LOCATION_ID = 4;
const OWNER_ID = 7777, COUNTER_ID = 7778;
const checks = [];
const createdItemIds = [], createdExpenseIds = [], createdUserIds = [], createdAttendanceIds = [];
function check(name, fn) { checks.push({ name, fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const tokenFor = (id) => jwt.sign({ id }, process.env.JWT_SECRET);

function assertLocalTarget() {
  const isLocal = (u) => { try { const h = new URL(u).hostname; return h === 'localhost' || h === '127.0.0.1'; } catch { return false; } };
  if (!isLocal(API_BASE) || !isLocal(process.env.DATABASE_URL || '')) { console.error('Refusing to run: not local.'); process.exit(1); }
}

// Shop-local wall clock Date: day offset from a fixed base day, hour, minute.
const BASE = Date.UTC(2026, 5, 20);
const at = (day, h, m = 0) => new Date(BASE + day * 86400000 + (h * 60 + m) * 60000);
const entry = (day, h, m = 0, amount = 50) => ({ at: at(day, h, m), amount, method: 'upi', created_by: 1 });
const item = (id, entries, extra = {}) => ({ id, pinned: false, pin_order: null, uses30: entries.length, entries, last_given_to: null, ...extra });

// Tea at ~11:00 and ~16:00 every day for days 0..9; "today" is day 10.
function teaEntries(todayExtra = []) {
  const e = [];
  for (let d = 0; d < 10; d += 1) { e.push(entry(d, 11, d % 3)); e.push(entry(d, 16, d % 4)); }
  return e.concat(todayExtra);
}
const ids = (list) => list.map((i) => i.id);

check('findSlots chains entries within 120 min and keeps count >= 3', () => {
  const s = findSlots([660, 662, 700, 960, 961, 962, 963, 100]);
  assert(s.length === 2, JSON.stringify(s));
  assert(s[0].start === 660 && s[0].end === 700 && s[0].count === 3, JSON.stringify(s[0]));
  assert(s[1].start === 960 && s[1].count === 4, JSON.stringify(s[1]));
});

check('findSlots drops a pair of entries', () => {
  assert(findSlots([600, 601]).length === 0, 'kept a slot of 2');
});

check('commonAmount [50,50,60] is 50; tie goes to most recent', () => {
  assert(commonAmount([entry(0, 9, 0, 50), entry(1, 9, 0, 50), entry(2, 9, 0, 60)]) === 50, 'mode');
  assert(commonAmount([entry(0, 9, 0, 50), entry(1, 9, 0, 60)]) === 60, 'tie most recent');
  assert(commonAmount([entry(5, 9, 0, 50), entry(1, 9, 0, 60)]) === 50, 'tie most recent by time not order');
  assert(commonAmount([]) === null, 'empty');
});

check('tea at 11:05 after an 11:00 entry today is not usual', () => {
  const now = at(10, 11, 5);
  const r = rankSuggestions([item(1, teaEntries([entry(10, 11, 0)]))], now);
  assert(!ids(r.usual_now).includes(1), 'was usual');
});

check('tea at 15:30 with only the morning entry today is usual', () => {
  const now = at(10, 15, 30);
  const r = rankSuggestions([item(1, teaEntries([entry(10, 11, 0)]))], now);
  assert(ids(r.usual_now).includes(1), JSON.stringify(ids(r.usual_now)));
});

check('tea with no entry yet today at 10:30 is usual', () => {
  const r = rankSuggestions([item(1, teaEntries())], at(10, 10, 30));
  assert(ids(r.usual_now).includes(1), 'not usual');
});

check('tea at 14:00 (between slots, outside both windows) is not usual but is in often', () => {
  const r = rankSuggestions([item(1, teaEntries())], at(10, 14, 0));
  assert(!ids(r.usual_now).includes(1) && ids(r.often).includes(1), 'bad placement');
});

check('petrol every 3 days, last yesterday: not usual, still in often', () => {
  const clean = [entry(0, 10), entry(3, 10), entry(6, 10), entry(9, 10)];
  const r = rankSuggestions([item(2, clean)], at(10, 10, 30));
  assert(!ids(r.usual_now).includes(2), 'was usual');
  assert(ids(r.often).includes(2), 'missing from often');
});

check('petrol every 3 days becomes usual once 3 days have passed', () => {
  const clean = [entry(0, 10), entry(3, 10), entry(6, 10)];
  const r = rankSuggestions([item(2, clean)], at(9, 10, 30));
  assert(ids(r.usual_now).includes(2), 'not usual on the due day');
});

check('an item added 30 minutes ago is in neither list', () => {
  const r = rankSuggestions([item(3, [entry(10, 10, 0)], { pinned: true, pin_order: 1 })], at(10, 10, 30));
  assert(!ids(r.usual_now).includes(3) && !ids(r.often).includes(3), 'present');
});

check('often is never empty when items exist and none are recent', () => {
  const r = rankSuggestions([item(4, [entry(2, 9)]), item(5, [], { pinned: true, pin_order: 1 })], at(10, 12, 0));
  assert(r.often.length === 2 && r.often[0].id === 5, JSON.stringify(ids(r.often)));
});

check('usual_now holds at most 3 and the total at most 8', () => {
  const many = [];
  for (let i = 0; i < 12; i += 1) many.push(item(100 + i, teaEntries()));
  const r = rankSuggestions(many, at(10, 10, 30));
  assert(r.usual_now.length === 3, 'usual ' + r.usual_now.length);
  assert(r.usual_now.length + r.often.length === 8, 'total ' + (r.usual_now.length + r.often.length));
  assert(!r.often.some((o) => ids(r.usual_now).includes(o.id)), 'overlap');
});

check('often orders pinned by pin_order, then by uses in 30 days', () => {
  const r = rankSuggestions([
    item(1, [entry(1, 9)], { uses30: 9 }),
    item(2, [entry(1, 9)], { uses30: 1, pinned: true, pin_order: 2 }),
    item(3, [entry(1, 9)], { uses30: 1, pinned: true, pin_order: 1 }),
    item(4, [entry(1, 9)], { uses30: 5 }),
  ], at(10, 12, 0));
  assert(JSON.stringify(ids(r.often)) === '[3,2,1,4]', JSON.stringify(ids(r.often)));
});

check('toShopLocal converts a real instant to shop wall clock', () => {
  const d = toShopLocal(new Date('2026-06-20T03:30:00Z'), 'Asia/Kolkata');
  assert(d.getUTCHours() === 9 && d.getUTCMinutes() === 0 && d.getUTCDate() === 20, d.toISOString());
});

// ── Route ──
async function api(path, token) {
  const res = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  let body = null; try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}
const sqlUtc = (d) => d.toISOString().replace('T', ' ').slice(0, 19);

check('route: usual_now/often added, data kept, my_last_method is the caller own, present_today follows attendance', async () => {
  const db = await getDb();
  const rider = await db.prepare("INSERT INTO users (phone, password, name, role, is_active) VALUES (?, 'x', 'VerifyUN Rider', 'delivery_partner', 1) RETURNING id").get('9' + String(Date.now()).slice(-9));
  createdUserIds.push(rider.id);
  const it = await db.prepare(`INSERT INTO expense_items (name, name_key, category, last_given_to_user_id, last_given_to_name) VALUES ('VerifyUN Tea', 'verifyun tea', 'food', ?, 'VerifyUN Rider') RETURNING id`).get(rider.id);
  createdItemIds.push(it.id);
  // Twelve past days at 09:00 shop time (03:30 UTC). Owner cash on day 1 (newest), counter upi on day 2.
  const now = Date.now();
  for (let d = 1; d <= 12; d += 1) {
    const created = new Date(now - d * 86400000); created.setUTCHours(3, 30, 0, 0);
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(created);
    const by = d === 1 ? OWNER_ID : COUNTER_ID;
    const method = d === 1 ? 'cash' : 'upi';
    const amount = d === 3 ? 60 : 50;
    const row = await db.prepare(`INSERT INTO expenses (location_id, category, amount, description, payment_method, expense_date, created_by, created_at, item_id) VALUES (?, 'food', ?, 'VerifyUN Tea', ?, ?, ?, ?, ?) RETURNING id`)
      .get(TEST_LOCATION_ID, amount, method, day, by, sqlUtc(created), it.id);
    createdExpenseIds.push(row.id);
  }
  const find = (b, id) => b.usual_now.concat(b.often).find((x) => x.id === id);
  const asCounter = await api(`/expenses/suggest?location_id=${TEST_LOCATION_ID}`, tokenFor(COUNTER_ID));
  assert(asCounter.status === 200 && Array.isArray(asCounter.body.data), 'data missing');
  assert(Array.isArray(asCounter.body.usual_now) && Array.isArray(asCounter.body.often), 'sections missing');
  assert(asCounter.body.usual_now.length <= 3 && asCounter.body.usual_now.length + asCounter.body.often.length <= 8, 'caps');
  const mine = find(asCounter.body, it.id);
  assert(mine, 'item in neither list');
  assert(mine.common_amount === 50, 'common_amount ' + mine.common_amount);
  assert(mine.my_last_method === 'upi', 'counter saw ' + mine.my_last_method);
  assert(mine.last_given_to && mine.last_given_to.present_today === false, 'present_today should be false: ' + JSON.stringify(mine.last_given_to));
  const asOwner = await api(`/expenses/suggest?location_id=${TEST_LOCATION_ID}`, tokenFor(OWNER_ID));
  assert(find(asOwner.body, it.id).my_last_method === 'cash', 'owner saw ' + find(asOwner.body, it.id).my_last_method);

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const att = await db.prepare("INSERT INTO attendance (user_id, location_id, date, clock_in, status) VALUES (?, ?, ?, CURRENT_TIMESTAMP, 'present') RETURNING id").get(rider.id, TEST_LOCATION_ID, today);
  createdAttendanceIds.push(att.id);
  const clocked = await api(`/expenses/suggest?location_id=${TEST_LOCATION_ID}`, tokenFor(COUNTER_ID));
  assert(find(clocked.body, it.id).last_given_to.present_today === true, 'present_today should be true');
  await db.prepare('UPDATE attendance SET clock_out = CURRENT_TIMESTAMP WHERE id = ?').run(att.id);
  const out = await api(`/expenses/suggest?location_id=${TEST_LOCATION_ID}`, tokenFor(COUNTER_ID));
  assert(find(out.body, it.id).last_given_to.present_today === false, 'clocked out should be false');
});

check('route: typing a search still finds items', async () => {
  const r = await api(`/expenses/suggest?location_id=${TEST_LOCATION_ID}&q=verifyun`, tokenFor(COUNTER_ID));
  assert(r.status === 200 && r.body.data.some((x) => x.name === 'VerifyUN Tea'), 'search broke');
});

check('route: a typed-name Given to (no user_id, e.g. a vendor) counts as present', async () => {
  const db = await getDb();
  const it = await db.prepare("SELECT id FROM expense_items WHERE name_key = 'verifyun tea'").get();
  assert(it, 'VerifyUN Tea missing (earlier check failed?)');
  await db.prepare("UPDATE expense_items SET last_given_to_user_id = NULL, last_given_to_name = 'VerifyUN Milkman' WHERE id = ?").run(it.id);
  const r = await api(`/expenses/suggest?location_id=${TEST_LOCATION_ID}`, tokenFor(COUNTER_ID));
  const row = r.body.usual_now.concat(r.body.often).find((x) => x.id === Number(it.id));
  assert(row && row.last_given_to, 'no last_given_to: ' + JSON.stringify(row));
  assert(row.last_given_to.user_id === null && row.last_given_to.display_name === 'VerifyUN Milkman', JSON.stringify(row.last_given_to));
  assert(row.last_given_to.present_today === true, 'typed name should be present_today true: ' + JSON.stringify(row.last_given_to));
});

async function cleanup() {
  const db = await getDb();
  const del = async (label, sql, ...p) => { try { await db.prepare(sql).run(...p); } catch (e) { console.error(`cleanup ${label}:`, e.message); } };
  for (const id of createdAttendanceIds) await del('attendance', 'DELETE FROM attendance WHERE id = ?', id);
  for (const id of createdExpenseIds) await del('expense', 'DELETE FROM expenses WHERE id = ?', id);
  for (const id of createdItemIds) await del('item', 'DELETE FROM expense_items WHERE id = ?', id);
  for (const id of createdUserIds) {
    await del('links', 'DELETE FROM user_locations WHERE user_id = ?', id);
    await del('user', 'DELETE FROM users WHERE id = ?', id);
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
