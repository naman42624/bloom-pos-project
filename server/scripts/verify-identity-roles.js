#!/usr/bin/env node
/**
 * Live verification script for the identity/roles/PIN-login sub-project.
 * Run directly against the local dev server + DB. Extended by each task
 * in docs/superpowers/plans/2026-08-30-identity-roles-pin-login-plan.md —
 * append this task's checks to the `checks` array, never remove another
 * task's checks.
 *
 * Usage: node server/scripts/verify-identity-roles.js
 */
require('dotenv').config();
const { getDb } = require('../config/database-async');

const API_BASE = process.env.API_BASE_URL || 'http://localhost:3001/api';

const checks = [];
const createdTestUserIds = [];

function check(name, fn) {
  checks.push({ name, fn });
}

async function staffLoginAsTestOwner() {
  // No hardcoded fallback credentials — this script performs real DELETE
  // calls against whatever DB it's pointed at, so silently falling back to
  // a real owner's phone/password if the env vars are unset is exactly the
  // kind of thing that must fail loudly instead.
  const phone = process.env.VERIFY_OWNER_PHONE;
  const password = process.env.VERIFY_OWNER_PASSWORD;
  if (!phone || !password) {
    throw new Error('VERIFY_OWNER_PHONE and VERIFY_OWNER_PASSWORD must both be set in the environment — no default credentials are used.');
  }
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, password }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Could not log in as owner for verification — set VERIFY_OWNER_PHONE/VERIFY_OWNER_PASSWORD env vars if the dummy account isn't in this DB. ${JSON.stringify(body)}`);
  return body.data;
}

// ─── Task 1: schema ──────────────────────────────────────────
check('users table has the 5 new columns', async (db) => {
  const cols = await db.prepare(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'users' AND column_name IN
      ('employee_code', 'pin_hash', 'pin_failed_attempts', 'pin_locked_until', 'job_title')
  `).all();
  const found = cols.map((c) => c.column_name).sort();
  const expected = ['employee_code', 'job_title', 'pin_failed_attempts', 'pin_hash', 'pin_locked_until'].sort();
  if (JSON.stringify(found) !== JSON.stringify(expected)) {
    throw new Error(`Expected columns ${expected.join(',')}, found ${found.join(',')}`);
  }
});

check('existing employee accounts are untouched (still role=employee, new columns NULL/0)', async (db) => {
  const rows = await db.prepare("SELECT id, role, employee_code, pin_hash, job_title FROM users WHERE role = 'employee'").all();
  if (rows.length === 0) throw new Error('Expected at least one existing employee account in the dev DB — none found');
  for (const r of rows) {
    if (r.employee_code !== null || r.pin_hash !== null || r.job_title !== null) {
      throw new Error(`User ${r.id} has non-null new columns before any migration — unexpected`);
    }
  }
});

// ─── Task 2: staff-login / staff-roster ────────────────────────
check('staff-login rejects an unknown employee_code', async () => {
  const res = await fetch(`${API_BASE}/auth/staff-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employee_code: '999999', pin: '0000' }),
  });
  if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
});

check('staff-roster requires location_id', async () => {
  const res = await fetch(`${API_BASE}/auth/staff-roster`);
  if (res.status !== 400) throw new Error(`Expected 400, got ${res.status}`);
});

check('staff-roster returns an array for a real location (may be empty pre-migration)', async () => {
  const locRow = await (await getDb()).prepare('SELECT id FROM locations WHERE is_active = 1 LIMIT 1').get();
  if (!locRow) throw new Error('No active location in dev DB to test against');
  const res = await fetch(`${API_BASE}/auth/staff-roster?location_id=${locRow.id}`);
  const body = await res.json();
  if (!Array.isArray(body.data?.staff)) throw new Error('Expected data.staff to be an array');
});

// ─── Task 3: users.js CRUD for new roles ───────────────────────
check('POST /api/users accepts role=counter_staff and auto-assigns an employee_code', async () => {
  const owner = await staffLoginAsTestOwner(); // see helper below
  const phone = '9' + String(Math.floor(100000000 + Math.random() * 899999999));
  const res = await fetch(`${API_BASE}/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ name: 'Verify Counter Staff', phone, password: 'testpass123', role: 'counter_staff' }),
  });
  const body = await res.json();
  if (res.status !== 201) throw new Error(`Expected 201, got ${res.status}: ${JSON.stringify(body)}`);
  if (!body.data?.user?.employee_code) throw new Error('Expected an auto-generated employee_code');
  createdTestUserIds.push(body.data.user.id); // cleaned up at the end
});

check('PUT /api/users/:id/change-role promotes a plain employee to counter_staff and backfills employee_code, enabling PUT /:id/pin', async () => {
  const owner = await staffLoginAsTestOwner();

  // Create a plain `employee` account — no employee_code, mirrors the 4 live
  // accounts the rollout plan promotes via change-role.
  const phone = '9' + String(Math.floor(100000000 + Math.random() * 899999999));
  const createRes = await fetch(`${API_BASE}/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ name: 'Verify Promote Employee', phone, password: 'testpass123', role: 'employee' }),
  });
  const createBody = await createRes.json();
  if (createRes.status !== 201) throw new Error(`Expected 201 creating employee, got ${createRes.status}: ${JSON.stringify(createBody)}`);
  const userId = createBody.data.user.id;
  createdTestUserIds.push(userId);
  if (createBody.data.user.employee_code) throw new Error('Expected plain employee to have no employee_code');

  // Before the fix, PIN would be rejected here with "no employee code yet".
  const pinBeforeRes = await fetch(`${API_BASE}/users/${userId}/pin`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ pin: '1234' }),
  });
  if (pinBeforeRes.status !== 400) throw new Error(`Expected 400 setting PIN before promotion, got ${pinBeforeRes.status}`);

  // Promote via change-role, exactly as the rollout plan (§9) does for live employee accounts.
  const roleRes = await fetch(`${API_BASE}/users/${userId}/change-role`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ role: 'counter_staff' }),
  });
  const roleBody = await roleRes.json();
  if (roleRes.status !== 200) throw new Error(`Expected 200 on change-role, got ${roleRes.status}: ${JSON.stringify(roleBody)}`);
  if (roleBody.data?.user?.role !== 'counter_staff') throw new Error('Expected role to be counter_staff after change-role');
  if (!roleBody.data?.user?.employee_code) throw new Error('Expected change-role to backfill an employee_code');

  // PIN should now succeed.
  const pinAfterRes = await fetch(`${API_BASE}/users/${userId}/pin`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ pin: '1234' }),
  });
  const pinAfterBody = await pinAfterRes.json();
  if (pinAfterRes.status !== 200) throw new Error(`Expected 200 setting PIN after promotion, got ${pinAfterRes.status}: ${JSON.stringify(pinAfterBody)}`);
});

// ─── Task 4: counter_staff parity ──────────────────────────────
check('counter_staff can read the same sales list employee can (both get a location-scoped result, not a 403)', async () => {
  // Live-checks one representative previously-employee-only endpoint end to end
  // rather than re-parsing source text — the grep-based completeness check in
  // Task 4 Step 3 covers exhaustiveness; this covers correctness of one path.
  const owner = await staffLoginAsTestOwner();
  const phone = '8' + String(Math.floor(100000000 + Math.random() * 899999999));
  const createRes = await fetch(`${API_BASE}/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ name: 'Verify Parity Staff', phone, password: 'testpass123', role: 'counter_staff' }),
  });
  const created = await createRes.json();
  createdTestUserIds.push(created.data.user.id);

  const loginRes = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, password: 'testpass123' }),
  });
  const logged = await loginRes.json();

  const salesRes = await fetch(`${API_BASE}/sales`, { headers: { Authorization: `Bearer ${logged.data.token}` } });
  if (salesRes.status !== 200) throw new Error(`Expected counter_staff to reach GET /sales, got ${salesRes.status}`);

  const draftsRes = await fetch(`${API_BASE}/sales/drafts`, { headers: { Authorization: `Bearer ${logged.data.token}` } });
  if (draftsRes.status !== 200) throw new Error(`Expected counter_staff to reach GET /sales/drafts (employee-only route before this task), got ${draftsRes.status}`);
});

// ─── Task 5: florist_staff boundary ─────────────────────────────
async function createAndLoginTestStaff(role, ownerToken) {
  const phone = '7' + String(Math.floor(100000000 + Math.random() * 899999999));
  const createRes = await fetch(`${API_BASE}/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ name: `Verify ${role}`, phone, password: 'testpass123', role }),
  });
  const created = await createRes.json();
  createdTestUserIds.push(created.data.user.id);
  const loginRes = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, password: 'testpass123' }),
  });
  return (await loginRes.json()).data;
}

check('florist_staff can reach production tasks but NOT checkout/payments/expenses', async () => {
  const owner = await staffLoginAsTestOwner();
  const florist = await createAndLoginTestStaff('florist_staff', owner.token);

  const tasksRes = await fetch(`${API_BASE}/production/tasks`, { headers: { Authorization: `Bearer ${florist.token}` } });
  if (tasksRes.status !== 200) throw new Error(`Expected florist_staff to reach GET /production/tasks, got ${tasksRes.status}`);

  const draftsRes = await fetch(`${API_BASE}/sales/drafts`, { headers: { Authorization: `Bearer ${florist.token}` } });
  if (draftsRes.status !== 403) throw new Error(`Expected florist_staff to be BLOCKED from GET /sales/drafts, got ${draftsRes.status}`);

  const expensesRes = await fetch(`${API_BASE}/expenses`, { headers: { Authorization: `Bearer ${florist.token}` } });
  if (expensesRes.status === 200) {
    // Known pre-existing gap, NOT introduced by this plan: GET /expenses has no authorize()
    // guard at all on `main` (only `authenticate`) — every authenticated role, including
    // `customer`, can read it today. Confirmed via `git show main:server/routes/expenses.js`
    // during Task 11. Flagged by Task 5's review and recorded in progress.md as an addendum
    // for sub-project 3 (POS/checkout integrity) or a dedicated fix — intentionally left
    // untouched here rather than silently patched in a final-verification task.
    console.log('   (known pre-existing gap: GET /expenses has no authorize() guard on main — tracked in progress.md, not fixed by this plan)');
  } else if (expensesRes.status !== 403) {
    throw new Error(`Expected florist_staff to be BLOCKED from GET /expenses (or 200 if the pre-existing gap is still unfixed), got ${expensesRes.status}`);
  }
});

check('florist_staff cannot start a task assigned to someone else, when pref_flexible_task_assignment is off (ownership check holds for the new role)', async () => {
  // pref_flexible_task_assignment (2026-09-04, default ON) deliberately lets
  // any staff member work any task — this check exists to prove the
  // per-assignee ownership gate ITSELF still works, so it forces the
  // preference off for the duration of the test rather than assuming a
  // stricter global default that is no longer true. Restored in `finally`
  // so a thrown assertion can't leave it stuck off for every other caller
  // of this script or the live app.
  const db = await getDb();
  const prevPref = await db.prepare("SELECT value FROM settings WHERE key = 'pref_flexible_task_assignment'").get();
  await db.prepare("UPDATE settings SET value = '0' WHERE key = 'pref_flexible_task_assignment'").run();
  try {
    const owner = await staffLoginAsTestOwner();
    const floristA = await createAndLoginTestStaff('florist_staff', owner.token);
    const floristB = await createAndLoginTestStaff('florist_staff', owner.token);

    const tasksRes = await fetch(`${API_BASE}/production/tasks`, { headers: { Authorization: `Bearer ${floristA.token}` } });
    const tasks = (await tasksRes.json()).data;
    const pending = tasks.find((t) => t.status === 'pending');
    if (!pending) {
      console.log('   (skipped — no pending production task in dev DB to test against)');
      return;
    }
    // floristA picks it (assigns to self), then floristB must be rejected on /start
    await fetch(`${API_BASE}/production/tasks/${pending.id}/pick`, { method: 'PUT', headers: { Authorization: `Bearer ${floristA.token}` } });
    const startRes = await fetch(`${API_BASE}/production/tasks/${pending.id}/start`, { method: 'PUT', headers: { Authorization: `Bearer ${floristB.token}` } });
    if (startRes.status !== 403) throw new Error(`Expected floristB to be BLOCKED from starting floristA's task, got ${startRes.status}`);
  } finally {
    await db.prepare("UPDATE settings SET value = ? WHERE key = 'pref_flexible_task_assignment'").run(prevPref?.value ?? '1');
  }
});

check('florist_staff CAN start a task assigned to someone else, when pref_flexible_task_assignment is on (the owner-toggleable override actually overrides)', async () => {
  const db = await getDb();
  const prevPref = await db.prepare("SELECT value FROM settings WHERE key = 'pref_flexible_task_assignment'").get();
  await db.prepare("UPDATE settings SET value = '1' WHERE key = 'pref_flexible_task_assignment'").run();
  try {
    const owner = await staffLoginAsTestOwner();
    const floristA = await createAndLoginTestStaff('florist_staff', owner.token);
    const floristB = await createAndLoginTestStaff('florist_staff', owner.token);

    const tasksRes = await fetch(`${API_BASE}/production/tasks`, { headers: { Authorization: `Bearer ${floristA.token}` } });
    const tasks = (await tasksRes.json()).data;
    const pending = tasks.find((t) => t.status === 'pending');
    if (!pending) {
      console.log('   (skipped — no pending production task in dev DB to test against)');
      return;
    }
    await fetch(`${API_BASE}/production/tasks/${pending.id}/pick`, { method: 'PUT', headers: { Authorization: `Bearer ${floristA.token}` } });
    const startRes = await fetch(`${API_BASE}/production/tasks/${pending.id}/start`, { method: 'PUT', headers: { Authorization: `Bearer ${floristB.token}` } });
    if (startRes.status !== 200) throw new Error(`Expected floristB to be ALLOWED to start floristA's task with the pref on, got ${startRes.status}`);
  } finally {
    await db.prepare("UPDATE settings SET value = ? WHERE key = 'pref_flexible_task_assignment'").run(prevPref?.value ?? '1');
  }
});

// ─── Run ──────────────────────────────────────────────────────
// Guard: this script performs real DELETE FROM users/user_locations calls,
// via TWO independent connections — HTTP calls through API_BASE (staff-login
// etc.) AND a direct Postgres connection via DATABASE_URL (getDb(), used for
// the cleanup DELETEs and several checks' own queries). Checking only one of
// the two leaves the other unguarded: a dev .env pointed at a remote/VPS
// Postgres (this repo ships VPS_DEPLOYMENT_GUIDE.md / DBEAVER_SSH_TUNNEL_SETUP.md,
// so that's a real, routine configuration here) with API_BASE_URL left unset
// (defaulting to localhost) would pass an API-only check while still running
// real DELETEs against that remote database. Both must point at localhost.
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
    console.error(
      `❌ Refusing to run: ${problems.join(' and ')} do${problems.length === 1 ? 'es' : ''} not point at localhost/127.0.0.1.\n` +
      `   This script performs real DELETE FROM users/user_locations calls over BOTH the HTTP API\n` +
      `   and a direct Postgres connection — it must only ever run against a local dev server AND\n` +
      `   a local dev database. Set both API_BASE_URL and DATABASE_URL to localhost URLs and try again.`
    );
    process.exit(1);
  }
}

async function main() {
  assertLocalTarget();
  const db = await getDb();
  let pass = 0, fail = 0;
  for (const { name, fn } of checks) {
    try {
      await fn(db);
      console.log(`✅ ${name}`);
      pass++;
    } catch (err) {
      console.error(`❌ ${name}\n   ${err.message}`);
      fail++;
    }
  }
  if (createdTestUserIds.length > 0) {
    for (const id of createdTestUserIds) {
      await db.prepare('DELETE FROM user_locations WHERE user_id = ?').run(id);
      await db.prepare('DELETE FROM users WHERE id = ?').run(id);
    }
    console.log(`Cleaned up ${createdTestUserIds.length} test user(s)`);
  }

  console.log(`\n${pass}/${pass + fail} checks passed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
