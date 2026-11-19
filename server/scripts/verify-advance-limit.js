#!/usr/bin/env node
/**
 * Verification of the per-person advance limit (staff pay PR 3, Task 1).
 * Pure checks on staff-money.js, then live API checks on API_BASE_URL with
 * throwaway VerifyAL users at Test Loc. UPI advances only, so no register.
 * Usage: source test-env.sh; node server/scripts/verify-advance-limit.js
 */
require('dotenv').config();
const jwt = require('jsonwebtoken');
const { getDb } = require('../config/database-async');
const sm = require('../utils/staff-money');
const { hashPin } = require('../utils/pin');
const { todayStr } = require('../utils/time');

const TEST_LOCATION_ID = 4;
const API_BASE = process.env.API_BASE_URL || 'http://localhost:3001/api';
const checks = [];
const createdUserIds = [];
const createdAdvanceIds = [];
function check(name, fn) { checks.push({ name, fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const eq = (a, b, what) => assert(a === b, `${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
function skip(msg) { const e = new Error(msg); e.skip = true; return e; }
function assertLocalTarget() {
  if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '')) { console.error('Refusing to run: DATABASE_URL not local.'); process.exit(1); }
}

async function makeUser(db, { role, name, pin, code, location = TEST_LOCATION_ID }) {
  const phone = 'al' + Date.now() + Math.floor(Math.random() * 1e6);
  const pinHash = pin ? await hashPin(pin) : null;
  const row = await db.prepare(
    'INSERT INTO users (phone, password, name, role, is_active, employee_code, pin_hash) VALUES (?, ?, ?, ?, 1, ?, ?) RETURNING id'
  ).get(phone, 'x', name, role, code || null, pinHash);
  createdUserIds.push(row.id);
  if (location) await db.prepare('INSERT INTO user_locations (user_id, location_id) VALUES (?, ?)').run(row.id, location);
  return row.id;
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
async function give(giver, body) {
  const r = await api('POST', '/staff-money/advance', giver, { location_id: TEST_LOCATION_ID, payment_method: 'upi', ...body });
  if (r.status === 201 && r.body && r.body.data) createdAdvanceIds.push(r.body.data.advance_id);
  return r;
}

// ── Pure ──
const limits = { advanceDay: 500, advanceMonth: 2000, shoppingDay: 1000, lateDays: 3 };
const zero = { advanceToday: 0, advanceMonth: 0, shoppingToday: 0 };
const np = (o) => sm.needsPin({ limits, totals: zero, kind: 'advance', amount: 100, recipientId: 2, giver: { id: 1, role: 'counter_staff' }, ...o });

check('needsPin: a higher personal limit replaces the shop monthly limit', async () => {
  eq(np({ amount: 400, personLimit: 5000, totals: { ...zero, advanceMonth: 1900 } }), null, 'higher personal limit');
});
check('needsPin: a lower personal limit applies', async () => {
  eq(np({ amount: 400, personLimit: 1000, totals: { ...zero, advanceMonth: 1900 } }), 'over_month', 'lower');
});
check('needsPin: personal limit 0 means every advance needs a PIN', async () => {
  eq(np({ amount: 1, personLimit: 0 }), 'over_month', 'limit 0');
});
check('needsPin: null personal limit falls back to the shop limit', async () => {
  eq(np({ amount: 400, personLimit: null, totals: { ...zero, advanceMonth: 1900 } }), 'over_month', 'null');
  eq(np({ amount: 100, personLimit: null, totals: { ...zero, advanceMonth: 1900 } }), null, 'null within shop');
});
check('needsPin: the daily limit still applies with a high personal limit', async () => {
  eq(np({ amount: 300, personLimit: 9000, totals: { ...zero, advanceToday: 300 } }), 'over_day', 'day');
});
check('needsPin: shopping ignores personLimit', async () => {
  eq(np({ kind: 'shopping', amount: 1000, personLimit: 0 }), null, 'shopping');
});
check('publicReason maps advance day and month to over_limit', async () => {
  eq(sm.publicReason('over_day', 'advance'), 'over_limit', 'day');
  eq(sm.publicReason('over_month', 'advance'), 'over_limit', 'month');
  eq(sm.publicReason('over_day', 'shopping'), 'over_day', 'shopping');
  eq(sm.publicReason('self', 'advance'), 'self', 'self');
});
check('needsPinMessage over_limit is the generic copy', async () => {
  eq(sm.OVER_LIMIT_MESSAGE, 'This needs an OK from a manager or the owner. They can confirm with their PIN.', 'constant');
  eq(sm.needsPinMessage('over_limit', { limits, kind: 'advance' }), sm.OVER_LIMIT_MESSAGE, 'message');
});

// ── Live ──
let cast = null;
async function getCast() {
  if (cast) return cast;
  const db = await getDb();
  const s = String(Date.now() % 1e6);
  cast = {
    owner: await makeUser(db, { role: 'owner', name: 'VerifyAL Owner', location: null }),
    mgr: await makeUser(db, { role: 'manager', name: 'VerifyAL Asha', pin: '5932', code: 'VAL' + s }),
    counter: await makeUser(db, { role: 'counter_staff', name: 'VerifyAL Counter' }),
  };
  cast.limits = await sm.getLimits(db);
  return cast;
}
async function recipient(name, personLimit) {
  const db = await getDb();
  const id = await makeUser(db, { role: 'counter_staff', name });
  if (personLimit !== undefined) {
    await db.prepare('INSERT INTO employee_salaries (user_id, monthly_salary, advance_limit, updated_by) VALUES (?, 10000, ?, ?)').run(id, personLimit, (await getCast()).owner);
  }
  return id;
}
async function seedMonth(userId, amount) {
  const today = todayStr();
  if (today.endsWith('-01')) throw skip('first of the month: no earlier day to seed');
  const db = await getDb();
  const row = await db.prepare("INSERT INTO salary_advances (user_id, amount, status, date) VALUES (?, ?, 'approved', CAST(? AS date)) RETURNING id")
    .get(userId, amount, `${today.slice(0, 7)}-01`);
  createdAdvanceIds.push(row.id);
}
const noDigits = (s) => !/\d/.test(s);

check('live: personal limit reached gives 409 over_limit with no amount; manager PIN passes', async () => {
  const c = await getCast();
  if (c.limits.advanceDay < 400) throw skip('daily limit too low for this check');
  const r = await recipient('VerifyAL Limited', 0);
  const db = await getDb();
  const t = await sm.totals(db, { userId: r });
  await db.prepare('UPDATE employee_salaries SET advance_limit = ? WHERE user_id = ?').run(t.advanceMonth + 300, r);
  eq((await give(c.counter, { user_id: r, amount: 200 })).status, 201, 'first 200');
  const over = await give(c.counter, { user_id: r, amount: 200 });
  eq(over.status, 409, 'status ' + JSON.stringify(over.body));
  eq(over.body.needs_pin, 'over_limit', 'reason');
  eq(over.body.message, sm.OVER_LIMIT_MESSAGE, 'copy');
  assert(noDigits(over.body.message), 'message has a digit');
  const ok = await give(c.counter, { user_id: r, amount: 200, approver_id: c.mgr, approver_pin: '5932' });
  eq(ok.status, 201, 'with pin ' + JSON.stringify(ok.body));
});

check('live: over the day limit only and over the month limit only answer identically', async () => {
  const c = await getCast();
  if (c.limits.advanceDay >= c.limits.advanceMonth) throw skip('day limit is not below the month limit');
  const a = await recipient('VerifyAL Day');
  const day = await give(c.counter, { user_id: a, amount: c.limits.advanceDay + 1 });
  eq(day.status, 409, 'day status ' + JSON.stringify(day.body));
  const b = await recipient('VerifyAL Month');
  await seedMonth(b, c.limits.advanceMonth - 1);
  const month = await give(c.counter, { user_id: b, amount: 2 });
  eq(month.status, 409, 'month status ' + JSON.stringify(month.body));
  eq(JSON.stringify({ n: day.body.needs_pin, m: day.body.message }), JSON.stringify({ n: month.body.needs_pin, m: month.body.message }), 'same answer');
  eq(day.body.needs_pin, 'over_limit', 'reason');
});

check('live: a personal limit above the shop limit lets advances through, daily limit still applies', async () => {
  const c = await getCast();
  const r = await recipient('VerifyAL High', c.limits.advanceMonth + 1000);
  await seedMonth(r, c.limits.advanceMonth);
  const amt = Math.min(c.limits.advanceDay, 500);
  const ok = await give(c.counter, { user_id: r, amount: amt });
  eq(ok.status, 201, 'past the shop month limit ' + JSON.stringify(ok.body));
  const over = await give(c.counter, { user_id: r, amount: c.limits.advanceDay - amt + 1 });
  eq(over.status, 409, 'daily limit still applies ' + JSON.stringify(over.body));
  eq(over.body.needs_pin, 'over_limit', 'reason');
});

check('live: personal limit 0 makes every advance need a PIN', async () => {
  const c = await getCast();
  const r = await recipient('VerifyAL Zero', 0);
  const res = await give(c.counter, { user_id: r, amount: 1 });
  eq(res.status, 409, 'status ' + JSON.stringify(res.body));
  eq(res.body.needs_pin, 'over_limit', 'reason');
});

check('live: a person with a salary row but no limit falls back to the shop limit', async () => {
  const c = await getCast();
  const r = await recipient('VerifyAL Null', null);
  await seedMonth(r, c.limits.advanceMonth - 1);
  const res = await give(c.counter, { user_id: r, amount: 2 });
  eq(res.status, 409, 'status ' + JSON.stringify(res.body));
  eq(res.body.needs_pin, 'over_limit', 'reason');
});

async function cleanup() {
  const db = await getDb();
  const del = async (label, sql, ...p) => { try { await db.prepare(sql).run(...p); } catch (e) { console.error(`cleanup ${label}: ${e.message}`); } };
  for (const id of createdAdvanceIds) await del('advance audit', "DELETE FROM audit_logs WHERE entity_type = 'salary_advance' AND entity_id = ?", id);
  for (const id of createdUserIds) {
    await del('expense audits', "DELETE FROM audit_logs WHERE entity_type = 'expense' AND entity_id IN (SELECT id FROM expenses WHERE employee_id = ? OR created_by = ?)", id, id);
    await del('expenses', 'DELETE FROM expenses WHERE employee_id = ? OR created_by = ?', id, id);
    await del('notifications', 'DELETE FROM notifications WHERE user_id = ?', id);
    await del('advances', 'DELETE FROM salary_advances WHERE user_id = ?', id);
    await del('salary config', 'DELETE FROM employee_salaries WHERE user_id = ?', id);
    await del('links', 'DELETE FROM user_locations WHERE user_id = ?', id);
    await del('user ' + id, 'DELETE FROM users WHERE id = ?', id);
  }
}

async function main() {
  assertLocalTarget();
  let pass = 0, fail = 0, skipped = 0;
  try {
    for (const { name, fn } of checks) {
      try { await fn(); console.log(`PASS ${name}`); pass++; }
      catch (err) {
        if (err.skip) { console.log(`SKIP ${name}\n   ${err.message}`); skipped++; continue; }
        console.log(`FAIL ${name}\n   ${err.message}`); fail++;
      }
    }
  } finally { await cleanup(); }
  console.log(`\n${pass}/${pass + fail} checks passed${skipped ? `, ${skipped} skipped` : ''}`);
  process.exit(fail > 0 ? 1 : 0);
}
main();
