#!/usr/bin/env node
/**
 * Live verification of the attendance/shift/overtime/payroll redesign.
 * Modeled on verify-register-expenses.js's harness. Extend this file the
 * same way — append checks, never remove another check's coverage.
 *
 * Usage (from server/): VERIFY_OWNER_PHONE=... VERIFY_OWNER_PASSWORD=... node scripts/verify-attendance-payroll.js
 */
require('dotenv').config();
const { getDb } = require('../config/database-async');

const API_BASE = process.env.API_BASE_URL || 'http://localhost:3001/api';
const TEST_LOCATION_ID = 4; // "Test Loc"

const checks = [];
const createdUserIds = [];
const createdShiftIds = [];
const createdAttendanceIds = [];
const createdSalaryIds = []; // real salary_payments.id values ONLY — see cleanup()
const createdAdvanceIds = [];
const createdExpenseIds = [];

function check(name, fn) { checks.push({ name, fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

function assertLocalTarget() {
  const isLocalUrl = (url) => {
    try { const { hostname } = new URL(url); return hostname === 'localhost' || hostname === '127.0.0.1'; }
    catch { return false; }
  };
  const problems = [];
  if (!isLocalUrl(API_BASE)) problems.push(`API_BASE_URL ("${API_BASE}")`);
  const databaseUrl = process.env.DATABASE_URL || '';
  if (!isLocalUrl(databaseUrl)) problems.push(`DATABASE_URL ("${databaseUrl.replace(/:[^:@]*@/, ':***@')}")`);
  if (problems.length > 0) {
    console.error(`❌ Refusing to run: ${problems.join(' and ')} do${problems.length === 1 ? 'es' : ''} not point at localhost/127.0.0.1.`);
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
  if (!phone || !password) throw new Error('VERIFY_OWNER_PHONE and VERIFY_OWNER_PASSWORD must both be set — no default credentials are used.');
  const { status, body } = await api('POST', '/auth/login', null, { phone, password });
  if (status !== 200 || !body?.data?.token) throw new Error(`Owner login failed: ${status} ${JSON.stringify(body)}`);
  return { token: body.data.token, id: body.data.user.id, role: body.data.user.role };
}

// POST /users responds with { data: { user, locations } } — the created
// user is nested under data.user, not data itself (verified against the
// real route in server/routes/users.js, not assumed — an earlier draft of
// this harness got this wrong and would have broken every check below it).
async function createFloristStaffSession(ownerToken) {
  const phone = `9${Date.now().toString().slice(-9)}`;
  const { status, body } = await api('POST', '/users', ownerToken, {
    name: 'Verify Florist', phone, password: 'verifypass123',
    role: 'florist_staff', location_ids: [TEST_LOCATION_ID],
  });
  assert(status === 201, `Could not create florist_staff test user: ${status} ${JSON.stringify(body)}`);
  const userId = body.data.user.id;
  createdUserIds.push(userId);
  const login = await api('POST', '/auth/login', null, { phone, password: 'verifypass123' });
  assert(login.status === 200, `Florist test user login failed: ${login.status} ${JSON.stringify(login.body)}`);
  return { token: login.body.data.token, id: userId };
}

module.exports = {
  check, checks, api, assert, loginOwner, createFloristStaffSession,
  TEST_LOCATION_ID, getDb,
  createdUserIds, createdShiftIds, createdAttendanceIds, createdSalaryIds, createdAdvanceIds, createdExpenseIds,
};

// ═══════════════════════════════════════════════════════════════
// florist_staff role-gap fixes
// ═══════════════════════════════════════════════════════════════

check('GET /attendance/today no longer 403s for florist_staff', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const { status } = await api('GET', '/attendance/today', florist.token);
  assert(status === 200, `Expected 200, got ${status}`);
});

check('GET /attendance/salary-advances no longer 403s for florist_staff, and only returns their own', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const { status, body } = await api('GET', '/attendance/salary-advances', florist.token);
  assert(status === 200, `Expected 200, got ${status}`);
  assert(Array.isArray(body.data), 'Expected an array');
  assert(body.data.every((a) => a.user_id === florist.id), 'Expected only the florist\'s own advances');
});

check('GET /attendance/outdoor-duty no longer 403s for florist_staff, and only returns their own', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const { status, body } = await api('GET', '/attendance/outdoor-duty', florist.token);
  assert(status === 200, `Expected 200, got ${status}`);
  assert(body.data.every((r) => r.user_id === florist.id), 'Expected only the florist\'s own requests');
});

check('POST /staff/geofence-event no longer 403s for florist_staff', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const { status } = await api('POST', '/staff/geofence-event', florist.token, {
    location_id: TEST_LOCATION_ID, event_type: 'exit', latitude: 31.31, longitude: 75.57,
  });
  assert(status === 200, `Expected 200, got ${status}`);
});

check('GET /staff/shifts no longer 403s for florist_staff, and only returns their own', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const { status, body } = await api('GET', '/staff/shifts', florist.token);
  assert(status === 200, `Expected 200, got ${status}`);
  assert(body.data.every((s) => s.user_id === florist.id), 'Expected only the florist\'s own shift');
});

check('GET /staff/salaries no longer 403s for florist_staff', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const { status } = await api('GET', '/staff/salaries', florist.token);
  assert(status === 200, `Expected 200, got ${status}`);
});

check('GET /staff/payroll/history no longer 403s for florist_staff', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const { status } = await api('GET', '/staff/payroll/history', florist.token);
  assert(status === 200, `Expected 200, got ${status}`);
});

check('GET /staff/salaries (owner view) includes a florist_staff in salaries or unset', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const { status, body } = await api('GET', '/staff/salaries', owner.token);
  assert(status === 200, `Expected 200, got ${status}`);
  const inSalaries = (body.data.salaries || []).some((s) => s.user_id === florist.id);
  const inUnset = (body.data.unset || []).some((u) => u.id === florist.id);
  assert(inSalaries || inUnset, 'Expected the new florist_staff to appear in either salaries or unset — they were previously invisible to this query entirely');
});

async function cleanup() {
  const db = await getDb();
  for (const id of createdExpenseIds) {
    try { await db.prepare('DELETE FROM expenses WHERE id = ?').run(id); } catch (err) { console.error(`   (cleanup warning: expense ${id}: ${err.message})`); }
  }
  // createdSalaryIds holds real salary_payments.id values only — employee_salaries
  // has no independently-tracked id here and is cleaned up below, by user_id.
  for (const id of createdSalaryIds) {
    try { await db.prepare('DELETE FROM salary_payments WHERE id = ?').run(id); } catch (err) { console.error(`   (cleanup warning: salary_payment ${id}: ${err.message})`); }
  }
  for (const id of createdAdvanceIds) {
    try { await db.prepare('DELETE FROM salary_advances WHERE id = ?').run(id); } catch (err) { console.error(`   (cleanup warning: advance ${id}: ${err.message})`); }
  }
  for (const id of createdAttendanceIds) {
    try { await db.prepare('DELETE FROM attendance WHERE id = ?').run(id); } catch (err) { console.error(`   (cleanup warning: attendance ${id}: ${err.message})`); }
  }
  for (const id of createdShiftIds) {
    try { await db.prepare('DELETE FROM employee_shifts WHERE id = ?').run(id); } catch (err) { console.error(`   (cleanup warning: shift ${id}: ${err.message})`); }
  }
  for (const id of createdUserIds) {
    try { await db.prepare('DELETE FROM employee_salaries WHERE user_id = ?').run(id); } catch (_) {}
    try { await db.prepare('DELETE FROM salary_history WHERE user_id = ?').run(id); } catch (_) {}
    try { await db.prepare('DELETE FROM user_locations WHERE user_id = ?').run(id); } catch (_) {}
    try { await db.prepare('DELETE FROM geofence_events WHERE user_id = ?').run(id); } catch (_) {}
    try { await db.prepare('DELETE FROM notifications WHERE user_id = ?').run(id); } catch (_) {}
    try { await db.prepare('DELETE FROM users WHERE id = ?').run(id); } catch (err) { console.error(`   (cleanup warning: user ${id}: ${err.message})`); }
  }
  console.log(`Cleaned up ${createdUserIds.length} test user(s), ${createdShiftIds.length} shift(s), ${createdAttendanceIds.length} attendance row(s), ${createdSalaryIds.length} salary_payment(s), ${createdAdvanceIds.length} advance(s), ${createdExpenseIds.length} expense(s)`);
}

async function main() {
  assertLocalTarget();
  let pass = 0, fail = 0;
  for (const { name, fn } of checks) {
    try { await fn(); console.log(`✅ ${name}`); pass++; }
    catch (err) { console.log(`❌ ${name}`); console.log(`   ${err.message}`); fail++; }
  }
  await cleanup();
  console.log(`\n${pass}/${pass + fail} checks passed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
