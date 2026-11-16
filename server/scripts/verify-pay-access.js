#!/usr/bin/env node
/**
 * Verification of pay visibility (PR 1). Test rows are named VerifyPA.
 * Cleans up only rows this run created.
 * Usage: source test-env.sh; node server/scripts/verify-pay-access.js
 * Every route returning salary, payroll or advance data must be listed here.
 */
require('dotenv').config();
const jwt = require('jsonwebtoken');
const { getDb } = require('../config/database-async');
const { payVisibleIds, canSeePay, salarySqlFilter } = require('../utils/pay-access');

const TEST_LOCATION_ID = 4; // Test Loc
const API_BASE = process.env.API_BASE_URL || 'http://localhost:3001/api';
const checks = [];
const createdUserIds = [];
function check(name, fn) { checks.push({ name, fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const eq = (a, b, what) => assert(JSON.stringify(a) === JSON.stringify(b), `${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

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
async function makeUser(db, { role, name }) {
  const phone = 'pa' + Date.now() + Math.floor(Math.random() * 1e6);
  const row = await db.prepare('INSERT INTO users (phone, password, name, role, is_active) VALUES (?, ?, ?, ?, 1) RETURNING id').get(phone, 'x', name, role);
  createdUserIds.push(row.id);
  await db.prepare('INSERT INTO user_locations (user_id, location_id) VALUES (?, ?)').run(row.id, TEST_LOCATION_ID);
  return row.id;
}

const ctx = {};
async function setup() {
  if (ctx.ready) return ctx;
  const db = await getDb();
  ctx.db = db;
  ctx.owner = (await db.prepare("SELECT id FROM users WHERE role = 'owner' AND is_active = 1 ORDER BY id LIMIT 1").get()).id;
  ctx.mgr = await makeUser(db, { role: 'manager', name: 'VerifyPA Manager' });
  ctx.mgr2 = await makeUser(db, { role: 'manager', name: 'VerifyPA Manager Two' });
  ctx.e1 = await makeUser(db, { role: 'counter_staff', name: 'VerifyPA Staff One' });
  ctx.cust = await makeUser(db, { role: 'customer', name: 'VerifyPA Customer' });
  ctx.ready = true;
  return ctx;
}

check('pay_viewers table exists', async () => {
  const { db } = await setup();
  const r = await db.prepare('SELECT to_regclass(?) AS r').get('public.pay_viewers');
  assert(r.r, 'missing table pay_viewers');
});

check('owner sees all pay', async () => {
  const c = await setup();
  eq(await payVisibleIds(c.db, { id: c.owner, role: 'owner' }), 'all', 'owner');
});

check('a non-manager sees only their own pay', async () => {
  const c = await setup();
  eq(await payVisibleIds(c.db, { id: c.e1, role: 'counter_staff' }), [c.e1], 'staff');
});

check('manager with no rows sees only their own', async () => {
  const c = await setup();
  eq(await payVisibleIds(c.db, { id: c.mgr, role: 'manager' }), [c.mgr], 'manager');
});

check('GET pay-viewers starts empty', async () => {
  const c = await setup();
  const r = await api('GET', `/staff/pay-viewers/${c.mgr}`, c.owner);
  eq(r.status, 200, 'status');
  eq(r.body.data.employee_ids, [], 'ids');
});

check('PUT adds an employee, manager then sees own + that one', async () => {
  const c = await setup();
  const r = await api('PUT', `/staff/pay-viewers/${c.mgr}`, c.owner, { employee_ids: [c.e1] });
  eq(r.status, 200, 'status');
  eq(await payVisibleIds(c.db, { id: c.mgr, role: 'manager' }), [c.mgr, c.e1], 'manager');
  assert(await canSeePay(c.db, { id: c.mgr, role: 'manager' }, c.e1), 'canSeePay e1');
  assert(!(await canSeePay(c.db, { id: c.mgr, role: 'manager' }, c.mgr2)), 'canSeePay other manager');
  const a = await c.db.prepare("SELECT action FROM audit_logs WHERE entity_type = 'pay_viewers' AND entity_id = ? ORDER BY id DESC LIMIT 1").get(c.mgr);
  eq(a && a.action, 'pay_viewers_set', 'audit');
});

check('PUT with an empty list removes access again', async () => {
  const c = await setup();
  const r = await api('PUT', `/staff/pay-viewers/${c.mgr}`, c.owner, { employee_ids: [] });
  eq(r.status, 200, 'status');
  eq(await payVisibleIds(c.db, { id: c.mgr, role: 'manager' }), [c.mgr], 'manager');
});

check('PUT as a manager is refused', async () => {
  const c = await setup();
  const r = await api('PUT', `/staff/pay-viewers/${c.mgr}`, c.mgr, { employee_ids: [c.e1] });
  eq(r.status, 403, 'status');
  const g = await api('GET', `/staff/pay-viewers/${c.mgr}`, c.mgr);
  eq(g.status, 403, 'get status');
});

check('PUT with a customer id is refused', async () => {
  const c = await setup();
  const r = await api('PUT', `/staff/pay-viewers/${c.mgr}`, c.owner, { employee_ids: [c.cust] });
  eq(r.status, 400, 'status');
  eq(r.body.message, "One of those people can't be picked. Refresh and try again.", 'message');
});

check('PUT for a non-manager is refused', async () => {
  const c = await setup();
  const r = await api('PUT', `/staff/pay-viewers/${c.e1}`, c.owner, { employee_ids: [] });
  eq(r.status, 400, 'status');
  eq(r.body.message, 'Pick a manager.', 'message');
});

check('salarySqlFilter shapes', async () => {
  eq(salarySqlFilter('all'), { sql: '', params: [] }, 'all');
  eq(salarySqlFilter([5, 6], 'x'), { sql: " AND (x.category <> 'salary' OR x.employee_id IN (?,?))", params: [5, 6] }, 'ids');
  eq(salarySqlFilter([]), { sql: " AND e.category <> 'salary'", params: [] }, 'empty');
});

async function cleanup() {
  const db = await getDb();
  for (const id of createdUserIds) {
    try {
      await db.prepare("DELETE FROM audit_logs WHERE entity_type = 'pay_viewers' AND entity_id = ?").run(id);
      await db.prepare('DELETE FROM pay_viewers WHERE manager_id = ? OR employee_id = ?').run(id, id);
      await db.prepare('DELETE FROM user_locations WHERE user_id = ?').run(id);
      await db.prepare('DELETE FROM users WHERE id = ?').run(id);
    } catch (e) { console.error('cleanup user ' + id + ': ' + e.message); }
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
