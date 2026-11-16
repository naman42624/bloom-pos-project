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

// ── Task 2: salary, payroll history and advance routes ──
const createdSalaryUserIds = [];
async function payCtx() {
  const c = await setup();
  if (c.pay) return c;
  c.e2 = await makeUser(c.db, { role: 'counter_staff', name: 'VerifyPA Staff Two' });
  c.e3 = await makeUser(c.db, { role: 'counter_staff', name: 'VerifyPA Staff Elsewhere' });
  await c.db.prepare('DELETE FROM user_locations WHERE user_id = ?').run(c.e3);
  for (const [id, amt] of [[c.e1, 7311], [c.e2, 8423]]) {
    await c.db.prepare('INSERT INTO employee_salaries (user_id, monthly_salary, updated_by) VALUES (?, ?, ?)').run(id, amt, c.owner);
    createdSalaryUserIds.push(id);
  }
  const adv = async (uid, amt, status) => (await c.db.prepare("INSERT INTO salary_advances (user_id, amount, status, reason) VALUES (?, ?, ?, 'VerifyPA') RETURNING id").get(uid, amt, status)).id;
  c.adv1 = await adv(c.e1, 111, 'approved');
  c.adv2 = await adv(c.e2, 222, 'approved');
  c.advPend = await adv(c.e2, 333, 'pending');
  c.advElse = await adv(c.e3, 444, 'pending');
  await api('PUT', `/staff/pay-viewers/${c.mgr}`, c.owner, { employee_ids: [c.e1] });
  c.pay = true;
  return c;
}

check('manager with access sees that salary only, not others', async () => {
  const c = await payCtx();
  const r = await api('GET', '/staff/salaries', c.mgr);
  eq(r.status, 200, 'status');
  const t = JSON.stringify(r.body);
  assert(t.includes('7311'), 'should contain E1 salary');
  assert(!t.includes('8423'), 'must not contain E2 salary');
  assert(Array.isArray(r.body.data.salaries), 'salaries list');
  assert('salary' in r.body.data, 'own salary key');
});
check('manager with no access sees neither salary', async () => {
  const c = await payCtx();
  const t = JSON.stringify((await api('GET', '/staff/salaries', c.mgr2)).body);
  assert(!t.includes('7311') && !t.includes('8423'), 'leak');
});
check('counter staff sees neither salary from the list route', async () => {
  const c = await payCtx();
  const r = await api('GET', '/staff/salaries', c.e3);
  const t = JSON.stringify(r.body);
  assert(!t.includes('7311') && !t.includes('8423'), 'leak');
  const own = await api('GET', '/staff/salaries', c.e1);
  assert(JSON.stringify(own.body).includes('7311') && !JSON.stringify(own.body).includes('8423'), 'own only');
});
check('manager payroll history for a hidden person is refused', async () => {
  const c = await payCtx();
  const r = await api('GET', `/staff/payroll/history?user_id=${c.e2}`, c.mgr);
  eq(r.status, 403, 'status');
  eq(r.body.message, "You can't see this person's pay. Ask the owner.", 'message');
  eq((await api('GET', `/staff/payroll/history?user_id=${c.e1}`, c.mgr)).status, 200, 'allowed person');
  eq((await api('GET', '/staff/payroll/history', c.mgr)).status, 200, 'own');
});
check('manager advances list: allowed person, plus pending at own shop, not others approved', async () => {
  const c = await payCtx();
  const r = await api('GET', '/attendance/salary-advances', c.mgr);
  eq(r.status, 200, 'status');
  const ids = r.body.data.map(a => a.id);
  assert(ids.includes(c.adv1), 'E1 advance');
  assert(!ids.includes(c.adv2), 'E2 approved must be hidden');
  assert(ids.includes(c.advPend), 'E2 pending request shown');
  assert(!ids.includes(c.advElse), 'pending at another shop hidden');
  const q = await api('GET', `/attendance/salary-advances?user_id=${c.e2}`, c.mgr);
  const qids = q.body.data.map(a => a.id);
  assert(qids.includes(c.advPend) && !qids.includes(c.adv2), 'user_id filter only shows pending');
});
check('manager with no access sees only pending requests', async () => {
  const c = await payCtx();
  const ids = (await api('GET', '/attendance/salary-advances', c.mgr2)).body.data.map(a => a.id);
  assert(!ids.includes(c.adv1) && !ids.includes(c.adv2), 'approved leak');
  assert(ids.includes(c.advPend), 'pending shown');
});
check('manager without access cannot mark repaid; with access can', async () => {
  const c = await payCtx();
  const r = await api('PUT', `/attendance/salary-advance/${c.adv1}/repay`, c.mgr2, { amount: 1 });
  eq(r.status, 403, 'status');
  eq(r.body.message, "You can't see this person's pay. Ask the owner.", 'message');
  eq((await api('PUT', `/attendance/salary-advance/${c.adv1}/repay`, c.mgr, { amount: 1 })).status, 200, 'allowed');
});
check('manager cannot reject a request from staff at another shop', async () => {
  const c = await payCtx();
  const r = await api('PUT', `/attendance/salary-advance/${c.advElse}/reject`, c.mgr, {});
  eq(r.status, 403, 'status');
  eq(r.body.message, "This person isn't at your shop.", 'message');
  eq((await api('PUT', `/attendance/salary-advance/${c.advPend}/reject`, c.mgr, {})).status, 200, 'own shop reject');
});
check('a person still sees their own advances and salary', async () => {
  const c = await payCtx();
  const ids = (await api('GET', '/attendance/salary-advances', c.e1)).body.data.map(a => a.id);
  eq(ids, [c.adv1], 'own advances');
});

async function cleanup() {
  const db = await getDb();
  try {
    const ids = createdUserIds.length ? createdUserIds : [0];
    const ph = ids.map(() => '?').join(',');
    await db.prepare(`DELETE FROM salary_advances WHERE user_id IN (${ph})`).run(...ids);
    await db.prepare(`DELETE FROM employee_salaries WHERE user_id IN (${ph})`).run(...ids);
  } catch (e) { console.error('cleanup pay rows: ' + e.message); }
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
