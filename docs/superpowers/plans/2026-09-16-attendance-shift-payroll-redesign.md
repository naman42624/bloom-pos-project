# Attendance, Shift, Overtime & Payroll Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three confirmed attendance/payroll bugs, make split shifts actually work end-to-end (late-detection, overtime tracking), close the salary-expense-reporting gap, and replace the buried owner/manager Quick Links pattern with a real "Attendance & Payroll" hub — without changing the employee clock-in control itself.

**Architecture:** A new pure computation module (`server/utils/shift-work.js`, mirroring the existing `order-stage.js` "compute fresh, never store" pattern) becomes the single source of truth for late-minutes and overtime-minutes, consumed by three existing routes (today-status, staff-today roster, payroll-calculate) with zero new `attendance` columns. Three additive schema changes close the expense/advance gaps. A new owner/manager-only screen (`AttendanceHubScreen`) with a roster sub-component replaces Quick Links; the employee-facing `AttendanceScreen` gains two small additions (own OT/late visibility, missed-clock-in recovery) and is otherwise untouched.

**Tech Stack:** Express.js + `pg` (sync `getDb()` from `database.js` for writes/transactions, async `getDb()` from `database-async.js` for reads — matching each touched route's existing layer), Expo/React Native + React Navigation, plain-Node `assert`-based verify scripts (no test framework in this codebase).

**Spec:** `docs/superpowers/specs/2026-09-16-attendance-shift-payroll-redesign-design.md`

## Global Constraints

- Every schema change is additive-only (new nullable columns, one widened CHECK constraint) — no `DROP`/`RENAME`/narrowing. Per `db-migration-safety`: back up production and test against a copy of real data before running any of this against production (tracked as the last step of Task 1, not done automatically).
- The employee-facing clock-in button/screen position does not move (spec §5) — only the logic underneath it and two additive UI elements.
- Overtime is track-only — never subtracted from or added to `net_amount` anywhere in this plan.
- New/touched pure logic lives in `server/utils/shift-work.js`; route files call into it rather than re-deriving segment math inline (avoids the two-slightly-different-copies bug class already documented in `CLAUDE.md`'s register/checkout history).
- Every touched frontend file must pass `node app/scripts/babel-check.js <file>` before its task is considered done.
- Follow `staff-ux-checklist`: exactly one primary action per roster row, plain-language errors, no existing capability removed (only regrouped).

---

## File Structure

**New files:**
- `server/utils/shift-work.js` — pure late/overtime computation, no DB access of its own.
- `server/scripts/verify-shift-work.js` — standalone unit-style assertions for the pure module (mirrors `app/scripts/verify-tracking-steps.js`'s style: plain `assert`, no framework).
- `server/scripts/verify-attendance-payroll.js` — integration-style regression harness for every route touched in this plan (mirrors `server/scripts/verify-register-expenses.js`'s `check()`/`assert()`/`main()` structure), built incrementally — each backend task appends its own `check()`.
- `app/src/components/attendance/AttendanceRoster.js` — the "Today" roster list (one row per staff member, one primary action each).
- `app/src/screens/AttendanceHubScreen.js` — owner/manager-only Today/Manage tabs container.

**Modified files:**
- `server/config/database.js` — 3 additive migration items.
- `server/routes/attendance.js` — segment-aware late/early detection, 6 `florist_staff` authorize() fixes (2 with an internal role-array fix too), own late/OT on `/today`, per-person OT on `/staff-today`, 2 new routes (`undo-auto-clockin`, `missed-clock-in`).
- `server/routes/staff-management.js` — 4 `florist_staff` authorize() fixes (1 with an internal role-array fix), geofence-event notification, `payroll/calculate` late/OT fields, `payroll/disburse` expense linkage + register-guard.
- `app/src/services/api.js` — 2 new methods.
- `app/src/screens/AttendanceScreen.js` — undo-able auto-clock-in banner, own late/OT line, missed-clock-in shortcut.
- `app/src/hooks/usePushNotifications.js` — route a tapped auto-clock-in notification to the Attendance tab.
- `app/src/navigation/MainNavigator.js` — owner/manager's `Attendance` route repointed at the new hub.
- `app/src/screens/DashboardScreen.js` — "N staff not clocked in" banner for managers/owner.

---

### Task 1: Additive schema changes

**Files:**
- Modify: `server/config/database.js` (two insertion points, both inside the existing patch sequence — see below)
- Test: manual `psql` verification against the local dev DB (no separate test file; this task's "test" is a direct schema check, matching how the codebase's own `users_role_check` fix was verified)

**Interfaces:**
- Produces: `expenses.employee_id` (nullable INTEGER FK → `users.id`), `salary_payments.expense_id` (nullable INTEGER FK → `expenses.id`), widened `salary_advances_status_check` (adds `'repaid'`) — all three consumed starting Task 8.

- [ ] **Step 1: Add `expenses.employee_id`**

Find this existing line in `server/config/database.js` (around line 710):

```js
  ensureColumn('expenses', 'is_return', 'INTEGER DEFAULT 0');
```

Add immediately after it:

```js
  // Links a salary-category expense to the actual employee it was paid to —
  // previously pure free text with no structured/queryable link at all
  // (confirmed by reading expenses.js's real INSERT: no employee column
  // existed). See docs/superpowers/specs/2026-09-16-attendance-shift-payroll-redesign-design.md §4/§5.
  ensureColumn('expenses', 'employee_id', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');
```

- [ ] **Step 2: Add `salary_payments.expense_id` and widen the `salary_advances` status constraint**

Find this existing block in `server/config/database.js` (around line 838):

```js
  ensureColumn('salary_advances', 'repaid_amount', 'DECIMAL(10,2) DEFAULT 0');
  ensureColumn('salary_advances', 'date', 'DATE DEFAULT CURRENT_DATE');
```

Add immediately after it:

```js
  // Traceability between a payroll disbursement and the expenses/register
  // reconciliation row it now also writes (Task 8) — lets either be found
  // from the other.
  ensureColumn('salary_payments', 'expense_id', 'INTEGER REFERENCES expenses(id) ON DELETE SET NULL');

  // salary_advances.status CHECK constraint (from schema.sql) doesn't allow
  // 'repaid', but staff-management.js's POST /payroll/disburse
  // auto-deduction and this file's own PUT /attendance/salary-advance/:id/repay
  // both write exactly that value. Confirmed absent already on the local
  // dev DB (hand-patched at some point, never codified here) — same
  // "hand-patched dev, prod never got it" pattern as users_role_check
  // above. Widening only: adds 'repaid' as an allowed value, cannot reject
  // any row the old constraint already accepted.
  try { runPsql('ALTER TABLE salary_advances DROP CONSTRAINT IF EXISTS salary_advances_status_check'); } catch (_) {}
  try {
    runPsql("ALTER TABLE salary_advances ADD CONSTRAINT salary_advances_status_check CHECK(status IN ('pending', 'approved', 'paid', 'rejected', 'repaid'))");
  } catch (_) {}
```

- [ ] **Step 3: Apply and verify against the local dev DB**

Run: `cd server && node server.js` (or let `nodemon` pick it up if already running), then Ctrl+C once it logs its normal startup (the patch sequence runs synchronously before the server starts listening).

Run:
```bash
cd server && export $(grep DATABASE_URL .env | xargs) && psql "$DATABASE_URL" -c "\d expenses" | grep employee_id
psql "$DATABASE_URL" -c "\d salary_payments" | grep expense_id
psql "$DATABASE_URL" -c "SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'salary_advances'::regclass AND contype='c';"
```
Expected: `employee_id` and `expense_id` both listed as nullable `integer`; the constraint query returns one row whose definition includes `'repaid'`.

- [ ] **Step 4: Commit**

```bash
git add server/config/database.js
git commit -m "Add additive schema for salary-expense linkage + widen salary_advances CHECK constraint"
```

- [ ] **Step 5: Note for production rollout (not performed now)**

Before this runs against the production database: take a backup, confirm the `salary_advances` constraint's actual current state in production specifically (don't assume it matches dev), and ideally test against a copy of real production data first. Per `db-migration-safety` and spec §10 — tracked here, executed as part of the eventual deploy, not part of this implementation task.

---

### Task 2: Fix all 10 `florist_staff` authorize() gaps

**Files:**
- Modify: `server/routes/attendance.js:204,407,513,568,624,653` (authorize lists) and `:568,653` internal role-arrays (see Step 1)
- Modify: `server/routes/staff-management.js:15,158,283,527` (authorize lists) and `:21` internal role-array
- Create: `server/scripts/verify-attendance-payroll.js` (this task creates the harness file; later tasks append to it)

**Interfaces:**
- Produces: `server/scripts/verify-attendance-payroll.js` exporting nothing (it's a runnable script, following `verify-register-expenses.js`'s `main()`-at-bottom pattern) — later tasks append `check(...)` calls to it, before the final `main()` call at the bottom.

- [ ] **Step 1: Fix the 10 authorize() gaps and 3 internal role-scoping arrays**

In `server/routes/attendance.js`, change each of these six `authorize(...)` calls to include `'florist_staff'` (insert it in the same position it already occupies on `/clock-in`/`/clock-out`, i.e. right after `'counter_staff'`):

```js
// line 204
router.get('/today', authorize('owner', 'manager', 'employee', 'counter_staff', 'florist_staff', 'delivery_partner'), async (req, res) => {

// line 407
router.post('/outdoor-duty', authorize('owner', 'manager', 'employee', 'counter_staff', 'florist_staff', 'delivery_partner'), (req, res) => {

// line 513
router.put('/outdoor-duty/:id/complete', authorize('owner', 'manager', 'employee', 'counter_staff', 'florist_staff', 'delivery_partner'), (req, res) => {

// line 568 — ALSO fix the internal scoping array in the same route's body (see below)
router.get('/outdoor-duty', authorize('owner', 'manager', 'employee', 'counter_staff', 'florist_staff', 'delivery_partner'), async (req, res) => {

// line 624
router.post('/salary-advance', authorize('owner', 'manager', 'employee', 'counter_staff', 'florist_staff', 'delivery_partner'), (req, res) => {

// line 653 — ALSO fix the internal scoping array in the same route's body (see below)
router.get('/salary-advances', authorize('owner', 'manager', 'employee', 'counter_staff', 'florist_staff', 'delivery_partner'), async (req, res) => {
```

Inside `GET /outdoor-duty` (around line 577), the internal role-scoping check currently reads:
```js
    if (['employee', 'counter_staff', 'delivery_partner'].includes(req.user.role)) {
```
Change to:
```js
    if (['employee', 'counter_staff', 'florist_staff', 'delivery_partner'].includes(req.user.role)) {
```
Without this, a florist_staff who now passes `authorize()` would fall through to the unscoped branch and see every location's outdoor-duty requests — a data leak, not just a 403 fix.

Inside `GET /salary-advances` (around line 661), same pattern — currently:
```js
    if (['employee', 'counter_staff', 'delivery_partner'].includes(req.user.role)) {
```
Change to:
```js
    if (['employee', 'counter_staff', 'florist_staff', 'delivery_partner'].includes(req.user.role)) {
```
Same reasoning — without this, a florist_staff would see every employee's salary advances, not just their own.

In `server/routes/staff-management.js`, change these four `authorize(...)` calls the same way:

```js
// line 15
router.get('/shifts', authorize('owner', 'manager', 'employee', 'counter_staff', 'florist_staff', 'delivery_partner'), async (req, res) => {

// line 158
router.get('/salaries', authorize('owner', 'manager', 'employee', 'counter_staff', 'florist_staff', 'delivery_partner'), async (req, res) => {

// line 283
router.post('/geofence-event', authorize('manager', 'employee', 'counter_staff', 'florist_staff', 'delivery_partner'), (req, res) => {

// line 527
router.get('/payroll/history', authorize('owner', 'manager', 'employee', 'counter_staff', 'florist_staff', 'delivery_partner'), async (req, res) => {
```

`GET /shifts`'s internal scoping (around line 21) has the same leak risk — currently:
```js
    if (['employee', 'counter_staff', 'delivery_partner'].includes(req.user.role)) {
```
Change to:
```js
    if (['employee', 'counter_staff', 'florist_staff', 'delivery_partner'].includes(req.user.role)) {
```
(`GET /salaries` needs no internal-array fix — it branches on `req.user.role === 'owner'` and treats every other role identically, already correct once `authorize()` lets florist_staff through. `GET /payroll/history` is the same — branches on `!== 'owner'`, not an allowlist.)

- [ ] **Step 2: Create the verify-attendance-payroll.js harness**

```javascript
#!/usr/bin/env node
/**
 * Live verification of the attendance/shift/overtime/payroll redesign:
 * florist_staff role-gap fixes, split-shift late detection, geofence
 * notification, salary-expense linkage, and the two new recovery
 * endpoints (undo-auto-clockin, missed-clock-in).
 *
 * Modeled on verify-register-expenses.js's harness. Extend this file the
 * same way — append checks, never remove another check's coverage.
 *
 * Usage: VERIFY_OWNER_PHONE=... VERIFY_OWNER_PASSWORD=... node server/scripts/verify-attendance-payroll.js
 */
require('dotenv').config();
const { getDb } = require('../config/database-async');

const API_BASE = process.env.API_BASE_URL || 'http://localhost:3001/api';
const TEST_LOCATION_ID = 4; // "Test Loc"

const checks = [];
const createdUserIds = [];
const createdShiftIds = [];
const createdAttendanceIds = [];
const createdSalaryIds = [];
const createdAdvanceIds = [];
const createdExpenseIds = [];

function check(name, fn) {
  checks.push({ name, fn });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

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
  if (!phone || !password) throw new Error('VERIFY_OWNER_PHONE and VERIFY_OWNER_PASSWORD must both be set in the environment — no default credentials are used.');
  const { status, body } = await api('POST', '/auth/login', null, { phone, password });
  if (status !== 200 || !body?.data?.token) throw new Error(`Owner login failed: ${status} ${JSON.stringify(body)}`);
  return { token: body.data.token, id: body.data.user.id, role: body.data.user.role };
}

// Creates a real florist_staff test user, assigns them to TEST_LOCATION_ID,
// and returns a logged-in session for them — every florist_staff-gap check
// below needs a real token for this role, not just the owner's.
//
// POST /users responds with { data: { user, locations } } — the created
// user is nested under data.user, not data itself (verified by reading the
// real route in server/routes/users.js, not assumed).
async function createFloristStaffSession(ownerToken) {
  const phone = `9${Date.now().toString().slice(-9)}`;
  const { status, body } = await api('POST', '/users', ownerToken, {
    name: 'Verify Florist',
    phone,
    password: 'verifypass123',
    role: 'florist_staff',
    location_ids: [TEST_LOCATION_ID],
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
  assert(body.data.every((a) => a.user_id === florist.id), 'Expected only the florist\'s own advances, got someone else\'s — the internal role-array fix is missing or wrong');
});

check('GET /attendance/outdoor-duty no longer 403s for florist_staff, and only returns their own', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const { status, body } = await api('GET', '/attendance/outdoor-duty', florist.token);
  assert(status === 200, `Expected 200, got ${status}`);
  assert(Array.isArray(body.data), 'Expected an array');
  assert(body.data.every((r) => r.user_id === florist.id), 'Expected only the florist\'s own requests, got someone else\'s');
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
  assert(Array.isArray(body.data), 'Expected an array');
  assert(body.data.every((s) => s.user_id === florist.id), 'Expected only the florist\'s own shift, got someone else\'s — the internal role-array fix is missing or wrong');
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

async function cleanup() {
  const db = await getDb();
  for (const id of createdExpenseIds) {
    try { await db.prepare('DELETE FROM expenses WHERE id = ?').run(id); } catch (err) { console.error(`   (cleanup warning: expense ${id}: ${err.message})`); }
  }
  // createdSalaryIds holds real salary_payments.id values only (pushed by
  // the checks that create a payment record) — employee_salaries has no
  // independently-tracked id in this harness and is cleaned up below, by
  // user_id, alongside every other per-user table. Do not push a user id
  // into createdSalaryIds; DELETE ... WHERE id = ? would silently target
  // the wrong row (or none) if given one.
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
    // Deleted explicitly by user_id rather than relied on to CASCADE from
    // the users delete below — this harness doesn't assume unverified FK
    // behavior either way.
    try { await db.prepare('DELETE FROM employee_salaries WHERE user_id = ?').run(id); } catch (_) {}
    try { await db.prepare('DELETE FROM salary_history WHERE user_id = ?').run(id); } catch (_) {}
    try { await db.prepare('DELETE FROM user_locations WHERE user_id = ?').run(id); } catch (_) {}
    try { await db.prepare('DELETE FROM users WHERE id = ?').run(id); } catch (err) { console.error(`   (cleanup warning: user ${id}: ${err.message})`); }
  }
  console.log(`Cleaned up ${createdUserIds.length} test user(s), ${createdShiftIds.length} shift(s), ${createdAttendanceIds.length} attendance row(s), ${createdSalaryIds.length} salary_payment(s), ${createdAdvanceIds.length} advance(s), ${createdExpenseIds.length} expense(s)`);
}

async function main() {
  assertLocalTarget();
  let pass = 0, fail = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      console.log(`✅ ${name}`);
      pass++;
    } catch (err) {
      console.log(`❌ ${name}`);
      console.log(`   ${err.message}`);
      fail++;
    }
  }
  await cleanup();
  console.log(`\n${pass}/${pass + fail} checks passed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
```

- [ ] **Step 3: Run it**

Run: `VERIFY_OWNER_PHONE=<owner phone> VERIFY_OWNER_PASSWORD=<owner password> node server/scripts/verify-attendance-payroll.js`
Expected: all 7 checks pass (`7/7 checks passed`).

- [ ] **Step 4: Commit**

```bash
git add server/routes/attendance.js server/routes/staff-management.js server/scripts/verify-attendance-payroll.js
git commit -m "Fix all 10 florist_staff authorize() gaps in attendance/shift/salary/geofence routes"
```

---

### Task 3: `shift-work.js` — pure late/overtime computation

**Files:**
- Create: `server/utils/shift-work.js`
- Create: `server/scripts/verify-shift-work.js`

**Interfaces:**
- Produces: `computeShiftWork(sessions, shift) -> { totalLateMinutes, totalOvertimeMinutes, sessions: [{ attendanceId, lateMinutes, overtimeMinutes, matchedSegment }] }`, `normalizeSegments(shiftStart, shiftEnd, shiftSegments) -> [{start, end}]` (minutes since midnight), `nearestSegment(clockInMinutes, segments) -> {start, end} | null`, `lateMinutesFor(clockInMinutes, segment) -> number`, `overtimeMinutesFor(clockOutMinutes, segment) -> number`, `timeStrToMinutes('HH:MM') -> number|null`, `timestampToMinutes(isoString) -> number|null`, `OVERTIME_GRACE_MINUTES` (30) — all consumed starting Task 4.

- [ ] **Step 1: Write the failing test**

Create `server/scripts/verify-shift-work.js`:

```javascript
const assert = require('assert');
const {
  OVERTIME_GRACE_MINUTES,
  timeStrToMinutes,
  timestampToMinutes,
  normalizeSegments,
  nearestSegment,
  lateMinutesFor,
  overtimeMinutesFor,
  computeShiftWork,
} = require('../utils/shift-work');

assert.strictEqual(OVERTIME_GRACE_MINUTES, 30);

// ── timeStrToMinutes ──
assert.strictEqual(timeStrToMinutes('07:00'), 420);
assert.strictEqual(timeStrToMinutes('18:30'), 1110);
assert.strictEqual(timeStrToMinutes(null), null);
assert.strictEqual(timeStrToMinutes('not-a-time'), null);

// ── normalizeSegments ──
// Single shift_start/shift_end (no split shift) becomes a one-segment list.
let segs = normalizeSegments('09:00', '18:00', null);
assert.deepStrictEqual(segs, [{ start: 540, end: 1080 }]);

// A real split shift: 7am-12pm, 6pm-10pm.
segs = normalizeSegments('09:00', '18:00', [{ start: '07:00', end: '12:00' }, { start: '18:00', end: '22:00' }]);
assert.deepStrictEqual(segs, [{ start: 420, end: 720 }, { start: 1080, end: 1320 }]);

// Malformed shift_segments falls back to the single window, not a crash.
segs = normalizeSegments('09:00', '18:00', 'not-json');
assert.deepStrictEqual(segs, [{ start: 540, end: 1080 }]);

// ── nearestSegment: THE bug #3 case ──
// A clock-in at 18:03 must match the second segment (start 1080), not the
// first (start 420) — this is the exact fix for "6pm clock-in flagged late
// against a 7am shift_start".
const splitSegs = [{ start: 420, end: 720 }, { start: 1080, end: 1320 }];
assert.deepStrictEqual(nearestSegment(1083, splitSegs), { start: 1080, end: 1320 });
assert.deepStrictEqual(nearestSegment(425, splitSegs), { start: 420, end: 720 });
assert.strictEqual(nearestSegment(500, []), null);

// ── lateMinutesFor ──
assert.strictEqual(lateMinutesFor(1083, { start: 1080, end: 1320 }), 3);
assert.strictEqual(lateMinutesFor(1075, { start: 1080, end: 1320 }), 0); // early, not negative
assert.strictEqual(lateMinutesFor(null, { start: 1080, end: 1320 }), 0);

// ── overtimeMinutesFor: 30-minute grace ──
// 20 minutes over — inside the grace period, zero OT.
assert.strictEqual(overtimeMinutesFor(1340, { start: 1080, end: 1320 }), 0);
// Exactly at the grace boundary — still zero.
assert.strictEqual(overtimeMinutesFor(1350, { start: 1080, end: 1320 }), 0);
// 45 minutes over — 15 minutes of real OT (45 - 30 grace).
assert.strictEqual(overtimeMinutesFor(1365, { start: 1080, end: 1320 }), 15);
// Left early — zero OT, not negative.
assert.strictEqual(overtimeMinutesFor(1200, { start: 1080, end: 1320 }), 0);

// ── computeShiftWork: full split-shift day ──
const shift = { shift_start: null, shift_end: null, shift_segments: JSON.stringify(splitSegs.map((s, i) => (i === 0 ? { start: '07:00', end: '12:00' } : { start: '18:00', end: '22:00' }))) };
const today = '2026-09-16';
const sessions = [
  { id: 1, clock_in: `${today}T07:02:00+05:30`, clock_out: `${today}T12:00:00+05:30` }, // on time, on time out
  { id: 2, clock_in: `${today}T18:03:00+05:30`, clock_out: `${today}T22:45:00+05:30` }, // "false late" case + real 15min OT (45-30 grace)
];
const result = computeShiftWork(sessions, shift);
assert.strictEqual(result.totalLateMinutes, 2, `Expected 2 late minutes (only session 1's 2min), got ${result.totalLateMinutes}`);
assert.strictEqual(result.totalOvertimeMinutes, 15, `Expected 15 OT minutes, got ${result.totalOvertimeMinutes}`);
assert.strictEqual(result.sessions[1].lateMinutes, 0, 'Session 2 (6pm arrival) must NOT be flagged late against the 7am segment — this is bug #3');

// An open session (no clock_out yet) contributes zero OT — in-progress work
// has no overtime until it actually ends.
const openSession = [{ id: 3, clock_in: `${today}T18:00:00+05:30`, clock_out: null }];
const openResult = computeShiftWork(openSession, shift);
assert.strictEqual(openResult.totalOvertimeMinutes, 0);

// No shift configured at all — everything is zero, not a crash (matches
// today's "no shift = no late/OT tracking" behavior).
const noShiftResult = computeShiftWork(sessions, null);
assert.strictEqual(noShiftResult.totalLateMinutes, 0);
assert.strictEqual(noShiftResult.totalOvertimeMinutes, 0);

console.log('verify-shift-work: all assertions passed');
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node server/scripts/verify-shift-work.js`
Expected: `Error: Cannot find module '../utils/shift-work'`

- [ ] **Step 3: Implement `server/utils/shift-work.js`**

```javascript
// server/utils/shift-work.js
//
// Pure computation of late-arrival minutes and overtime minutes for one
// employee's attendance sessions, aware of split shifts
// (employee_shifts.shift_segments). ALWAYS computed fresh from raw
// clock_in/clock_out timestamps + the shift definition passed in — never
// stored. Mirrors server/utils/order-stage.js's own "computed fresh, never
// stored" precedent, so this can't go stale if a shift definition changes
// after the fact.
//
// See docs/superpowers/specs/2026-09-16-attendance-shift-payroll-redesign-design.md §6.

const { getTimezone } = require('./time');

const OVERTIME_GRACE_MINUTES = 30;

// 'HH:MM' (or 'HH:MM:SS') -> minutes since midnight. Returns null for
// anything that doesn't match, so callers can treat a bad/missing shift
// value as "no shift data" instead of crashing.
function timeStrToMinutes(hhmm) {
  if (!hhmm || typeof hhmm !== 'string') return null;
  const m = /^(\d{2}):(\d{2})/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (Number.isNaN(h) || Number.isNaN(min)) return null;
  return h * 60 + min;
}

// ISO/parseable timestamp -> minutes since local midnight, in the shop's
// configured timezone. Returns a number rather than the zero-padded string
// attendance.js's old isLateArrival used to compare, which avoids that
// code's latent 'HH:mm:ss' > 'HH:mm' string-comparison fencepost (where any
// clock-in at exactly hh:mm:01+ was flagged late against a bare hh:mm
// shift start) as a side effect of the segment-matching fix.
function timestampToMinutes(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const tz = getTimezone();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const h = Number(parts.find((p) => p.type === 'hour')?.value);
  const min = Number(parts.find((p) => p.type === 'minute')?.value);
  if (Number.isNaN(h) || Number.isNaN(min)) return null;
  return h * 60 + min;
}

// Normalizes a shift into a list of {start, end} minute-ranges. A single
// shift_start/shift_end pair (the pre-split-shift default) becomes a
// one-segment list, so every caller below has exactly one code path
// regardless of whether the employee has a split shift.
function normalizeSegments(shiftStart, shiftEnd, shiftSegments) {
  let segments = null;
  if (shiftSegments) {
    try {
      const parsed = typeof shiftSegments === 'string' ? JSON.parse(shiftSegments) : shiftSegments;
      if (Array.isArray(parsed) && parsed.length > 0) segments = parsed;
    } catch (_) { /* fall through to single-window */ }
  }
  if (!segments) {
    segments = [{ start: shiftStart, end: shiftEnd }];
  }
  return segments
    .map((seg) => ({ start: timeStrToMinutes(seg.start), end: timeStrToMinutes(seg.end) }))
    .filter((seg) => seg.start != null && seg.end != null);
}

// Given a clock-in time (minutes since midnight) and the shift's segments,
// returns the segment whose start is closest to the clock-in — the fix for
// "a 6pm clock-in flagged late against a 7am shift_start": each session is
// matched against the segment it actually belongs to, not always the first.
function nearestSegment(clockInMinutes, segments) {
  if (!segments.length || clockInMinutes == null) return null;
  let best = segments[0];
  let bestDiff = Math.abs(clockInMinutes - segments[0].start);
  for (const seg of segments.slice(1)) {
    const diff = Math.abs(clockInMinutes - seg.start);
    if (diff < bestDiff) { best = seg; bestDiff = diff; }
  }
  return best;
}

// Late minutes for one session, given its matched segment. Never negative.
function lateMinutesFor(clockInMinutes, segment) {
  if (clockInMinutes == null || !segment) return 0;
  return Math.max(0, clockInMinutes - segment.start);
}

// Overtime minutes for one session, given its matched segment and a
// clock-out time. The 30-minute grace applies uniformly to every segment
// boundary (spec §6) — a split-shift employee running over their midday
// segment gets the same courtesy as someone staying late at close.
function overtimeMinutesFor(clockOutMinutes, segment) {
  if (clockOutMinutes == null || !segment) return 0;
  const overrun = clockOutMinutes - segment.end;
  return Math.max(0, overrun - OVERTIME_GRACE_MINUTES);
}

// Main entry point. `sessions` is any list of attendance rows needing at
// minimum { id, clock_in, clock_out } — a single day's rows, or a whole
// payroll period's, callers decide. `shift` is { shift_start, shift_end,
// shift_segments } as stored on employee_shifts, or null/undefined (every
// session then contributes zero late/OT, matching "no shift configured"
// being a no-op today).
function computeShiftWork(sessions, shift) {
  const segments = shift ? normalizeSegments(shift.shift_start, shift.shift_end, shift.shift_segments) : [];

  let totalLateMinutes = 0;
  let totalOvertimeMinutes = 0;
  const perSession = [];

  for (const session of sessions || []) {
    const clockInMin = timestampToMinutes(session.clock_in);
    const clockOutMin = timestampToMinutes(session.clock_out);
    const segment = nearestSegment(clockInMin, segments);

    const lateMinutes = lateMinutesFor(clockInMin, segment);
    // An open session (no clock_out yet) has no overtime until it actually
    // ends — in-progress work isn't "over" anything yet.
    const overtimeMinutes = session.clock_out ? overtimeMinutesFor(clockOutMin, segment) : 0;

    totalLateMinutes += lateMinutes;
    totalOvertimeMinutes += overtimeMinutes;
    perSession.push({
      attendanceId: session.id,
      lateMinutes,
      overtimeMinutes,
      matchedSegment: segment,
    });
  }

  return { totalLateMinutes, totalOvertimeMinutes, sessions: perSession };
}

module.exports = {
  OVERTIME_GRACE_MINUTES,
  timeStrToMinutes,
  timestampToMinutes,
  normalizeSegments,
  nearestSegment,
  lateMinutesFor,
  overtimeMinutesFor,
  computeShiftWork,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node server/scripts/verify-shift-work.js`
Expected: `verify-shift-work: all assertions passed`

- [ ] **Step 5: Commit**

```bash
git add server/utils/shift-work.js server/scripts/verify-shift-work.js
git commit -m "Add shift-work.js: pure split-shift-aware late/overtime computation"
```

---

### Task 4: Wire segment-aware late/early detection into clock-in/clock-out

**Files:**
- Modify: `server/routes/attendance.js:21-80` (`isLateArrival`/`isEarlyDeparture`), `:171` (call site), end of file (exports)
- Modify: `server/scripts/verify-attendance-payroll.js` (append checks)

**Interfaces:**
- Consumes: `computeShiftWork` is NOT used directly here — this task uses the lower-level `normalizeSegments`, `nearestSegment`, `lateMinutesFor`, `overtimeMinutesFor`... actually only needs `normalizeSegments`, `nearestSegment`, `lateMinutesFor`, `timestampToMinutes` from Task 3.
- Produces: `isLateArrival`/`isEarlyDeparture` now exported from `attendance.js` (for direct testing) with a changed `isEarlyDeparture` signature: `isEarlyDeparture(clockOut, clockIn, operatingHours, userId, locationId)` — the added `clockIn` param is a breaking signature change; its one call site (Step 2) is updated in the same task.

- [ ] **Step 1: Rewrite `isLateArrival` and `isEarlyDeparture`**

Replace the two functions at the top of `server/routes/attendance.js` (lines 20-80):

```js
const { normalizeSegments, nearestSegment, lateMinutesFor, timestampToMinutes } = require('../utils/shift-work');

// ─── Helper: Check if time is late based on shift (segment-aware) OR operating hours ──
// Segment-aware fix (bug #3, 2026-09-16): previously always compared against
// a single shift_start, so a split-shift employee's SECOND session (e.g. a
// 6pm arrival for a 7am-12pm/6pm-10pm shift) was compared against the FIRST
// segment's start and flagged late for arriving exactly on time. Now
// resolves the nearest segment first. Employees without a split shift see
// zero behavior change (normalizeSegments falls back to a single window).
function isLateArrival(clockIn, operatingHours, userId, locationId) {
  if (!clockIn) return false;
  try {
    const db = getDb();
    const shift = db.prepare('SELECT shift_start, shift_end, shift_segments FROM employee_shifts WHERE user_id = ? AND location_id = ? AND is_active = 1').get(userId, locationId);
    if (shift && (shift.shift_start || shift.shift_segments)) {
      const segments = normalizeSegments(shift.shift_start, shift.shift_end, shift.shift_segments);
      const clockInMinutes = timestampToMinutes(clockIn);
      const segment = nearestSegment(clockInMinutes, segments);
      return lateMinutesFor(clockInMinutes, segment) > 0;
    }

    // Fallback to location operating_hours — unchanged from before.
    if (!operatingHours) return false;
    const tz = getTimezone();
    const d = new Date(clockIn);
    if (Number.isNaN(d.getTime())) return false;
    const clockTime = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).format(d);
    const hours = safeParseJSON(operatingHours, {});
    const dayOfWeek = d.toLocaleDateString('en-US', { timeZone: tz, weekday: 'long' }).toLowerCase();
    const dayHours = hours[dayOfWeek];
    if (!dayHours || !dayHours.open) return false;
    return clockTime > dayHours.open;
  } catch (err) {
    console.error(err);
    return false;
  }
}

// ─── Helper: Check early departure based on shift (segment-aware) OR operating hours ──
// clockIn (this session's OWN clock-in, not clockOut) determines which
// segment this session belongs to — matching against clockOut instead would
// risk picking the wrong segment for a departure right at a boundary.
function isEarlyDeparture(clockOut, clockIn, operatingHours, userId, locationId) {
  if (!clockOut) return false;
  try {
    const db = getDb();
    const shift = db.prepare('SELECT shift_start, shift_end, shift_segments FROM employee_shifts WHERE user_id = ? AND location_id = ? AND is_active = 1').get(userId, locationId);
    if (shift && (shift.shift_start || shift.shift_segments)) {
      const segments = normalizeSegments(shift.shift_start, shift.shift_end, shift.shift_segments);
      const clockInMinutes = timestampToMinutes(clockIn);
      const clockOutMinutes = timestampToMinutes(clockOut);
      const segment = nearestSegment(clockInMinutes, segments);
      if (!segment || clockOutMinutes == null) return false;
      return clockOutMinutes < segment.end;
    }

    // Fallback to location operating_hours — unchanged from before.
    if (!operatingHours) return false;
    const tz = getTimezone();
    const d = new Date(clockOut);
    if (Number.isNaN(d.getTime())) return false;
    const clockTime = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).format(d);
    const hours = safeParseJSON(operatingHours, {});
    const dayOfWeek = d.toLocaleDateString('en-US', { timeZone: tz, weekday: 'long' }).toLowerCase();
    const dayHours = hours[dayOfWeek];
    if (!dayHours || !dayHours.close) return false;
    return clockTime < dayHours.close;
  } catch (err) {
    console.error(err);
    return false;
  }
}
```

- [ ] **Step 2: Update the one call site**

In `POST /clock-out` (around line 171), change:
```js
    const early = isEarlyDeparture(now, record.operating_hours, userId, record.location_id) ? 1 : 0;
```
to:
```js
    const early = isEarlyDeparture(now, record.clock_in, record.operating_hours, userId, record.location_id) ? 1 : 0;
```

- [ ] **Step 3: Export both functions for direct testing**

At the bottom of `server/routes/attendance.js`, find:
```js
module.exports = router;
```
Change to:
```js
module.exports = router;
module.exports.isLateArrival = isLateArrival;
module.exports.isEarlyDeparture = isEarlyDeparture;
```

- [ ] **Step 4: Append the bug #3 regression check to verify-attendance-payroll.js**

Add before `async function cleanup()`:

```javascript
// ═══════════════════════════════════════════════════════════════
// Split-shift late detection (bug #3)
// ═══════════════════════════════════════════════════════════════

check('isLateArrival does NOT flag a split-shift employee\'s second-segment clock-in as late (bug #3)', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const { isLateArrival } = require('../routes/attendance');
  const db = await getDb();

  const shiftResult = await db.prepare(`
    INSERT INTO employee_shifts (user_id, location_id, shift_start, shift_end, shift_segments, is_active)
    VALUES (?, ?, '09:00', '18:00', ?, 1) RETURNING id
  `).get(florist.id, TEST_LOCATION_ID, JSON.stringify([{ start: '07:00', end: '12:00' }, { start: '18:00', end: '22:00' }]));
  createdShiftIds.push(shiftResult.id);

  // A clock-in at 18:03 today — the exact bug #3 scenario. Build the
  // timestamp directly rather than waiting for "now" to actually be 6pm.
  const today = new Date().toISOString().slice(0, 10);
  const clockInIso = `${today}T18:03:00+05:30`;

  const wasLate = isLateArrival(clockInIso, null, florist.id, TEST_LOCATION_ID);
  assert(wasLate === false, `Expected NOT late (arrived exactly on time for the second segment), got late=${wasLate}`);
});
```

- [ ] **Step 5: Run it**

Run: `VERIFY_OWNER_PHONE=<owner phone> VERIFY_OWNER_PASSWORD=<owner password> node server/scripts/verify-attendance-payroll.js`
Expected: `8/8 checks passed`

- [ ] **Step 6: Commit**

```bash
git add server/routes/attendance.js server/scripts/verify-attendance-payroll.js
git commit -m "Fix split-shift late/early detection to match the nearest segment, not always the first"
```

---

### Task 5: `GET /attendance/today` — own late/overtime summary

**Files:**
- Modify: `server/routes/attendance.js:1-10` (imports), `:204-254` (`/today` route)
- Modify: `server/scripts/verify-attendance-payroll.js` (append check)

**Interfaces:**
- Consumes: `computeShiftWork` from `server/utils/shift-work.js` (Task 3).
- Produces: `GET /attendance/today` response gains `data.lateMinutesToday` and `data.overtimeMinutesToday` (numbers), consumed by `AttendanceScreen.js` in Task 13.

- [ ] **Step 1: Add the import**

Near the top of `server/routes/attendance.js`, alongside the Task 4 import, add:
```js
const { computeShiftWork } = require('../utils/shift-work');
```
(Can be combined into the same `require('../utils/shift-work')` line Task 4 added.)

- [ ] **Step 2: Extend the route**

Replace the `GET /today` handler body (lines 204-254) with:

```js
router.get('/today', authorize('owner', 'manager', 'employee', 'counter_staff', 'florist_staff', 'delivery_partner'), async (req, res) => {
  try {
    const db = await getAsyncDb();
    const today = todayStr();

    const records = await db.prepare(`
      SELECT a.*, l.name as location_name
      FROM attendance a
      JOIN locations l ON a.location_id = l.id
      WHERE a.user_id = ? AND a.date = ?
      ORDER BY a.id ASC
    `).all(req.user.id, today);

    const current = records.length > 0 ? records[records.length - 1] : null;

    let activeOutdoor = null;
    if (current && !current.clock_out) {
      activeOutdoor = await db.prepare(`
        SELECT * FROM outdoor_duty_requests
        WHERE user_id = ? AND attendance_id = ? AND status IN ('approved', 'requested')
        ORDER BY created_at DESC LIMIT 1
      `).get(req.user.id, current.id);
    }

    let totalHoursToday = 0;
    let totalOutdoorToday = 0;
    for (const r of records) {
      totalHoursToday += Number(r.total_hours) || 0;
      totalOutdoorToday += Number(r.outdoor_hours) || 0;
    }

    // Own late/overtime summary for today (spec §5/§6) — track-only,
    // plain-language display on AttendanceScreen. Uses the CURRENT/latest
    // session's location for the shift lookup, a simplification that
    // assumes single-location attendance per day, matching this project's
    // current single-location-per-shop scope (CLAUDE.md "Locations").
    let shiftWork = { totalLateMinutes: 0, totalOvertimeMinutes: 0, sessions: [] };
    if (current) {
      const shift = await db.prepare(
        'SELECT shift_start, shift_end, shift_segments FROM employee_shifts WHERE user_id = ? AND location_id = ? AND is_active = 1'
      ).get(req.user.id, current.location_id);
      shiftWork = computeShiftWork(records, shift || null);
    }

    res.json({
      success: true,
      data: {
        attendance: current,
        logs: records,
        totalHoursToday: Math.round(totalHoursToday * 100) / 100,
        totalOutdoorToday: Math.round(totalOutdoorToday * 100) / 100,
        totalEffectiveToday: Math.round((totalHoursToday + totalOutdoorToday) * 100) / 100,
        activeOutdoor,
        lateMinutesToday: shiftWork.totalLateMinutes,
        overtimeMinutesToday: shiftWork.totalOvertimeMinutes,
      },
    });
  } catch (error) {
    console.error('Get today attendance error:', error);
    res.status(500).json({ success: false, message: 'Failed to get attendance status.' });
  }
});
```

- [ ] **Step 3: Append the check**

```javascript
check('GET /attendance/today includes lateMinutesToday and overtimeMinutesToday', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const { status, body } = await api('GET', '/attendance/today', florist.token);
  assert(status === 200, `Expected 200, got ${status}`);
  assert(typeof body.data.lateMinutesToday === 'number', 'Expected lateMinutesToday to be a number');
  assert(typeof body.data.overtimeMinutesToday === 'number', 'Expected overtimeMinutesToday to be a number');
});
```

- [ ] **Step 4: Run it**

Run: `VERIFY_OWNER_PHONE=<owner phone> VERIFY_OWNER_PASSWORD=<owner password> node server/scripts/verify-attendance-payroll.js`
Expected: `9/9 checks passed`

- [ ] **Step 5: Commit**

```bash
git add server/routes/attendance.js server/scripts/verify-attendance-payroll.js
git commit -m "GET /attendance/today: add own late/overtime minutes summary"
```

---

### Task 6: `GET /attendance/staff-today` — per-person overtime chip data

**Files:**
- Modify: `server/routes/attendance.js:762-984` (`/staff-today` route)
- Modify: `server/scripts/verify-attendance-payroll.js` (append check)

**Interfaces:**
- Consumes: `computeShiftWork` (Task 3).
- Produces: each entry in `GET /attendance/staff-today`'s `data.present[]` gains `late_minutes_today` and `overtime_minutes_today`, consumed by `AttendanceRoster.js` in Task 14.

- [ ] **Step 1: Carry `shift_segments` through the two shift queries**

In the `allShifts` query (around line 784):
```js
    const shiftsData = await db.prepare(`
      SELECT DISTINCT ON (user_id, location_id) user_id, location_id, shift_start, shift_end, shift_segments, days_of_week
      FROM employee_shifts
      WHERE is_active = 1
      ORDER BY user_id, location_id, updated_at DESC, id DESC
    `).all();
```

In the main `logs` query (around line 794):
```js
    const logs = await db.prepare(`
      SELECT
        a.*,
        u.name as user_name,
        u.phone as user_phone,
        u.role as user_role,
        l.name as location_name,
        es.shift_start,
        es.shift_end,
        es.shift_segments,
        es.days_of_week
      FROM attendance a
      JOIN users u ON a.user_id = u.id
      JOIN locations l ON a.location_id = l.id
      LEFT JOIN employee_shifts es ON es.user_id = a.user_id AND es.location_id = a.location_id AND es.is_active = 1
      WHERE a.date = ? ${locFilter}
      ORDER BY a.clock_in ASC, a.id ASC
    `).all(...params);
```

- [ ] **Step 2: Carry `shift_segments` through the default-shift merge and per-row aggregation**

In the merge-default-shift block (around line 813):
```js
    for (const log of logs) {
      if (!log.shift_start && !log.shift_end) {
        const defaultShift = allShifts.get(`${log.user_id}-${log.location_id}`);
        if (defaultShift) {
          log.shift_start = defaultShift.shift_start;
          log.shift_end = defaultShift.shift_end;
          log.shift_segments = defaultShift.shift_segments;
          log.days_of_week = defaultShift.days_of_week;
        }
      }
    }
```

In the `byUser` aggregation's initial-entry object (around line 830-854), add `shift_segments: row.shift_segments || null,` right after the existing `shift_end: row.shift_end || null,` line, and in the "latest session wins" update block (around line 885-889) add `existing.shift_segments = row.shift_segments || null;` alongside the existing `shift_start`/`shift_end` updates:

```js
        if (row.shift_start || row.shift_end || row.shift_segments) {
          existing.shift_start = row.shift_start || null;
          existing.shift_end = row.shift_end || null;
          existing.shift_segments = row.shift_segments || null;
          existing.days_of_week = row.days_of_week || null;
        }
```

- [ ] **Step 3: Compute OT/late per staff member when building the final `staff` array**

Replace the existing `const staff = ...` block (around line 911):

```js
    const staff = Array.from(byUser.values()).map((s) => {
      const shiftWork = computeShiftWork(s.logs, { shift_start: s.shift_start, shift_end: s.shift_end, shift_segments: s.shift_segments });
      return {
        ...s,
        total_hours: Math.round(s.total_hours * 100) / 100,
        outdoor_hours: Math.round(s.outdoor_hours * 100) / 100,
        effective_hours: Math.round(s.effective_hours * 100) / 100,
        late_minutes_today: shiftWork.totalLateMinutes,
        overtime_minutes_today: shiftWork.totalOvertimeMinutes,
      };
    });
```

(`computeShiftWork` is already imported per Task 5's Step 1 — same file.)

- [ ] **Step 4: Append the check**

```javascript
check('GET /attendance/staff-today includes overtime_minutes_today per staff member', async () => {
  const owner = await loginOwner();
  const { status, body } = await api('GET', `/attendance/staff-today?location_id=${TEST_LOCATION_ID}`, owner.token);
  assert(status === 200, `Expected 200, got ${status}`);
  assert(Array.isArray(body.data.present), 'Expected data.present to be an array');
  for (const s of body.data.present) {
    assert(typeof s.overtime_minutes_today === 'number', `Expected overtime_minutes_today on ${s.user_name}, got ${typeof s.overtime_minutes_today}`);
    assert(typeof s.late_minutes_today === 'number', `Expected late_minutes_today on ${s.user_name}, got ${typeof s.late_minutes_today}`);
  }
});
```

- [ ] **Step 5: Run it**

Run: `VERIFY_OWNER_PHONE=<owner phone> VERIFY_OWNER_PASSWORD=<owner password> node server/scripts/verify-attendance-payroll.js`
Expected: `10/10 checks passed`

- [ ] **Step 6: Commit**

```bash
git add server/routes/attendance.js server/scripts/verify-attendance-payroll.js
git commit -m "GET /attendance/staff-today: add per-person overtime/late minutes for the roster"
```

---

### Task 7: `POST /staff/payroll/calculate` — total late minutes + overtime minutes

**Files:**
- Modify: `server/routes/staff-management.js:1-6` (imports), `:353-448` (`/payroll/calculate` route)
- Modify: `server/scripts/verify-attendance-payroll.js` (append check)

**Interfaces:**
- Consumes: `computeShiftWork` (Task 3).
- Produces: `POST /staff/payroll/calculate` response's `attendance_summary` gains `total_late_minutes` and `overtime_minutes` — informational only, does not affect `calculation.net_amount`.

- [ ] **Step 1: Add the import**

Near the top of `server/routes/staff-management.js`:
```js
const { computeShiftWork } = require('../utils/shift-work');
```

- [ ] **Step 2: Compute and add the two fields**

In the `/payroll/calculate` handler, right after the existing `const totalHours = attendance.reduce(...)` line (around line 392), add:

```js
    const shift = db.prepare(
      'SELECT shift_start, shift_end, shift_segments FROM employee_shifts WHERE user_id = ? AND is_active = 1 ORDER BY updated_at DESC, id DESC LIMIT 1'
    ).get(user_id);
    const shiftWork = computeShiftWork(attendance, shift || null);
```

Then in the response's `attendance_summary` object (around line 428-435), add the two new fields:

```js
        attendance_summary: {
          days_worked: daysWorked,
          half_days: halfDays,
          absent_days: absentDays,
          late_days: lateDays,
          leave_days: leaveDays,
          total_hours: Math.round(totalHours * 100) / 100,
          total_late_minutes: shiftWork.totalLateMinutes,
          overtime_minutes: shiftWork.totalOvertimeMinutes,
        },
```

`calculation.net_amount` is untouched — these two fields are purely informational, matching the track-only decision.

- [ ] **Step 3: Append the check**

```javascript
check('POST /staff/payroll/calculate includes total_late_minutes and overtime_minutes, and does not affect net_amount', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  await api('POST', '/staff/salaries', owner.token, { user_id: florist.id, monthly_salary: 15000, salary_type: 'monthly' });
  const period_start = '2026-01-01';
  const period_end = '2026-01-31';
  const { status, body } = await api('POST', '/staff/payroll/calculate', owner.token, { user_id: florist.id, period_start, period_end });
  assert(status === 200, `Expected 200, got ${status}`);
  assert(typeof body.data.attendance_summary.total_late_minutes === 'number', 'Expected total_late_minutes to be a number');
  assert(typeof body.data.attendance_summary.overtime_minutes === 'number', 'Expected overtime_minutes to be a number');
  assert(body.data.calculation.net_amount === 15000, `Expected net_amount unaffected by OT (still 15000), got ${body.data.calculation.net_amount}`);
});
```

- [ ] **Step 4: Run it**

Run: `VERIFY_OWNER_PHONE=<owner phone> VERIFY_OWNER_PASSWORD=<owner password> node server/scripts/verify-attendance-payroll.js`
Expected: `11/11 checks passed`

- [ ] **Step 5: Commit**

```bash
git add server/routes/staff-management.js server/scripts/verify-attendance-payroll.js
git commit -m "POST /staff/payroll/calculate: add track-only total_late_minutes and overtime_minutes"
```

---

### Task 8: `POST /staff/payroll/disburse` — salary/expense/register linkage

**Files:**
- Modify: `server/routes/staff-management.js:1-6` (imports), `:451-524` (`/payroll/disburse` route)
- Modify: `app/src/screens/SalaryManagementScreen.js` (no payload changes needed — see note in Step 1)
- Modify: `server/scripts/verify-attendance-payroll.js` (append checks)

**Interfaces:**
- Consumes: `hasOpenRegister(db, locationId)`, `REGISTER_CLOSED_MESSAGE` from `server/utils/register-guard.js` (existing).
- Produces: `salary_payments.expense_id` populated on every disbursement; a matching `expenses` row (`category='salary'`, `employee_id` set) now exists for every disbursement, and a cash disbursement decrements the open register's `expected_cash` exactly like any other cash expense.

- [ ] **Step 1: Note on `location_id`**

Payroll has no location dimension today (`employee_salaries` is user-scoped, not location-scoped), but `expenses.location_id` is `NOT NULL` in the real schema (verified directly against the live dev DB, not the stale `schema.sql`). Rather than adding a new field to `SalaryManagementScreen.js`'s disburse form, the location is derived server-side from the employee's own location assignment — no frontend change needed for this task.

- [ ] **Step 2: Add imports**

Near the top of `server/routes/staff-management.js`:
```js
const { hasOpenRegister, REGISTER_CLOSED_MESSAGE } = require('../utils/register-guard');
```
(`computeShiftWork` import already added in Task 7 — same file.)

- [ ] **Step 3: Rewrite the route**

Replace the entire `POST /payroll/disburse` handler (lines 451-524):

```js
router.post('/payroll/disburse', authorize('owner'), (req, res) => {
  try {
    const db = getDb();
    const {
      user_id, period_start, period_end,
      base_salary, days_worked, days_in_period, hours_worked,
      late_days, absent_days, leaves_taken,
      deductions, advances_deducted, bonus, net_amount,
      payment_method, payment_reference, notes,
    } = req.body;

    if (!user_id || !period_start || !period_end || net_amount === undefined) {
      return res.status(400).json({ success: false, message: 'Missing required fields.' });
    }

    const existing = db.prepare(
      'SELECT id FROM salary_payments WHERE user_id = ? AND period_start = ? AND period_end = ? AND status != ?'
    ).get(user_id, period_start, period_end, 'cancelled');
    if (existing) {
      return res.status(400).json({ success: false, message: 'Payment already exists for this period.' });
    }

    const method = payment_method || 'cash';

    // The disbursement also writes a linked expenses row (below) so it
    // shows up in financial reports and register reconciliation — closing
    // the gap where a structured, employee-linked salary_payments row was
    // previously invisible to both (spec §5). That write needs a real
    // location; payroll itself has no location dimension, so it's derived
    // here from the employee's own location assignment rather than adding
    // a location picker to a screen that's never needed one before.
    const employeeLocation = db.prepare(
      'SELECT location_id FROM user_locations WHERE user_id = ? ORDER BY is_primary DESC, id ASC LIMIT 1'
    ).get(user_id);
    const locationId = employeeLocation ? employeeLocation.location_id : null;

    if (!locationId) {
      return res.status(400).json({ success: false, message: "This employee isn't assigned to a location yet — assign one before disbursing salary." });
    }

    // Cash disbursements move real money out of the drawer, same as any
    // other cash expense — hard-blocked with no open register instead of
    // silently recording a payment no session's expected_cash accounts for
    // (the same rule server/utils/register-guard.js already enforces on
    // every other cash-write route; POST /expenses is the sibling this
    // mirrors).
    if (method === 'cash' && !hasOpenRegister(db, locationId)) {
      return res.status(400).json({ success: false, message: REGISTER_CLOSED_MESSAGE });
    }
    const openRegister = method === 'cash'
      ? db.prepare('SELECT id FROM cash_registers WHERE location_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1').get(locationId)
      : null;

    const disburseTx = db.transaction(() => {
      const paymentResult = db.prepare(`
        INSERT INTO salary_payments (
          user_id, period_start, period_end, base_salary, days_worked, days_in_period,
          hours_worked, late_days, absent_days, leaves_taken, deductions,
          advances_deducted, bonus, net_amount, payment_method, payment_reference,
          status, paid_at, paid_by, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', CURRENT_TIMESTAMP, ?, ?)
      `).run(
        user_id, period_start, period_end,
        base_salary || 0, days_worked || 0, days_in_period || 0,
        hours_worked || 0, late_days || 0, absent_days || 0, leaves_taken || 0,
        deductions || 0, advances_deducted || 0, bonus || 0, net_amount,
        method, payment_reference || '',
        req.user.id, notes || ''
      );
      const paymentId = paymentResult.lastInsertRowid;

      const payeeUser = db.prepare('SELECT name FROM users WHERE id = ?').get(user_id);
      const expenseResult = db.prepare(`
        INSERT INTO expenses (location_id, category, amount, description, payment_method, expense_date, created_by, employee_id, register_id)
        VALUES (?, 'salary', ?, ?, ?, CURRENT_DATE, ?, ?, ?)
      `).run(
        locationId,
        net_amount,
        `Salary payment — ${payeeUser ? payeeUser.name : 'employee'} (${period_start} to ${period_end})`,
        method,
        req.user.id,
        user_id,
        openRegister ? openRegister.id : null
      );
      db.prepare('UPDATE salary_payments SET expense_id = ? WHERE id = ?').run(expenseResult.lastInsertRowid, paymentId);

      if (method === 'cash' && openRegister) {
        db.prepare('UPDATE cash_registers SET expected_cash = expected_cash - ? WHERE id = ?').run(net_amount, openRegister.id);
      }

      if (advances_deducted && advances_deducted > 0) {
        let remaining = advances_deducted;
        const advances = db.prepare(
          'SELECT * FROM salary_advances WHERE user_id = ? AND status = ? AND repaid_amount < amount ORDER BY date'
        ).all(user_id, 'approved');
        for (const adv of advances) {
          if (remaining <= 0) break;
          const owed = adv.amount - adv.repaid_amount;
          const toDeduct = Math.min(owed, remaining);
          db.prepare('UPDATE salary_advances SET repaid_amount = repaid_amount + ?, status = CASE WHEN repaid_amount + ? >= amount THEN ? ELSE status END WHERE id = ?')
            .run(toDeduct, toDeduct, 'repaid', adv.id);
          remaining -= toDeduct;
        }
      }

      return paymentId;
    });

    const paymentId = disburseTx();
    const payment = db.prepare(`
      SELECT sp.*, u.name as user_name, u.role as user_role, p.name as paid_by_name
      FROM salary_payments sp
      JOIN users u ON sp.user_id = u.id
      LEFT JOIN users p ON sp.paid_by = p.id
      WHERE sp.id = ?
    `).get(paymentId);

    res.status(201).json({ success: true, data: payment });
  } catch (error) {
    console.error('Disburse salary error:', error);
    res.status(500).json({ success: false, message: 'Failed to disburse salary.' });
  }
});
```

- [ ] **Step 4: Append the checks**

```javascript
check('POST /staff/payroll/disburse (cash) requires an open register and writes a linked, employee-tagged expense that adjusts expected_cash', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  await api('POST', '/staff/salaries', owner.token, { user_id: florist.id, monthly_salary: 12000, salary_type: 'monthly' });

  // No open register yet — must be rejected, not silently recorded.
  const blocked = await api('POST', '/staff/payroll/disburse', owner.token, {
    user_id: florist.id, period_start: '2026-02-01', period_end: '2026-02-28', net_amount: 12000, payment_method: 'cash',
  });
  assert(blocked.status === 400, `Expected 400 with no open register, got ${blocked.status}`);

  // Defensive close-then-open, matching verify-register-expenses.js's own
  // ensureClosed precedent — a register left open by an earlier/unrelated
  // run on this same TEST_LOCATION_ID would otherwise make this check
  // flaky (POST /register/open refuses a second open on an already-open
  // location).
  const initialStatus = await api('GET', `/sales/register/status?location_id=${TEST_LOCATION_ID}`, owner.token);
  if (initialStatus.body?.isOpen) {
    await api('PUT', '/sales/register/close', owner.token, { location_id: TEST_LOCATION_ID, actual_cash: Number(initialStatus.body.data.expected_cash) || 0 });
  }
  await api('POST', '/sales/register/open', owner.token, { location_id: TEST_LOCATION_ID, opening_balance: 1000 });
  const before = await api('GET', `/sales/register/status?location_id=${TEST_LOCATION_ID}`, owner.token);
  const expectedBefore = Number(before.body.data.expected_cash);

  const { status, body } = await api('POST', '/staff/payroll/disburse', owner.token, {
    user_id: florist.id, period_start: '2026-02-01', period_end: '2026-02-28', net_amount: 12000, payment_method: 'cash',
  });
  assert(status === 201, `Expected 201, got ${status}: ${JSON.stringify(body)}`);
  assert(body.data.expense_id != null, 'Expected salary_payments.expense_id to be set');
  createdSalaryIds.push(body.data.id);
  createdExpenseIds.push(body.data.expense_id);

  const db = await getDb();
  const expense = await db.prepare('SELECT * FROM expenses WHERE id = ?').get(body.data.expense_id);
  assert(expense.category === 'salary', `Expected category 'salary', got '${expense.category}'`);
  assert(Number(expense.employee_id) === florist.id, `Expected employee_id ${florist.id}, got ${expense.employee_id}`);

  const after = await api('GET', `/sales/register/status?location_id=${TEST_LOCATION_ID}`, owner.token);
  const expectedAfter = Number(after.body.data.expected_cash);
  assert(Math.abs((expectedBefore - 12000) - expectedAfter) < 0.01, `Expected register to drop by 12000, went from ${expectedBefore} to ${expectedAfter}`);

  await api('PUT', '/sales/register/close', owner.token, { location_id: TEST_LOCATION_ID, actual_cash: expectedAfter });
});
```

- [ ] **Step 5: Run it**

Run: `VERIFY_OWNER_PHONE=<owner phone> VERIFY_OWNER_PASSWORD=<owner password> node server/scripts/verify-attendance-payroll.js`
Expected: `12/12 checks passed`

- [ ] **Step 6: Commit**

```bash
git add server/routes/staff-management.js server/scripts/verify-attendance-payroll.js
git commit -m "POST /staff/payroll/disburse: link to expenses (register-guarded) and employee_id"
```

---

### Task 9: Geofence auto-clock-in stays automatic, adds a visible notification

**Files:**
- Modify: `server/routes/staff-management.js:1-6` (imports), `:283-346` (`/geofence-event` route)
- Modify: `server/scripts/verify-attendance-payroll.js` (append check)

**Interfaces:**
- Consumes: `createNotification` from `server/routes/notifications.js` (existing).
- Produces: every geofence-triggered auto-clock-in now creates a `notifications` row (and push) with `data: { screen: 'Attendance', attendanceId, action: 'undo_auto_clockin' }`, consumed by `AttendanceScreen.js` in Task 13 and the undo endpoint in Task 10.

- [ ] **Step 1: Add the import**

Near the top of `server/routes/staff-management.js`:
```js
const { createNotification } = require('./notifications');
```

- [ ] **Step 2: Add the notification call**

In the `POST /geofence-event` handler's `if (event_type === 'enter')` block (around line 300-333), the auto-clock-in logic stays exactly as-is (per direct confirmation this session: auto-clock-in remains fully automatic, zero added tap). Add a notification immediately after, replacing the two `return res.json(...)` calls for the auto-clock-in paths:

```js
    // If enter event → auto clock-in (unchanged — stays fully automatic,
    // zero added tap per spec §5). What changes: it stops being silent.
    if (event_type === 'enter') {
      const n = new Date();
      const today = `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;
      const existing = db.prepare('SELECT * FROM attendance WHERE user_id = ? AND date = ?').get(req.user.id, today);

      if (!existing || (existing.clock_out && !existing.clock_in)) {
        const now = nowLocal();
        const shift = db.prepare('SELECT * FROM employee_shifts WHERE user_id = ? AND location_id = ? AND is_active = 1').get(req.user.id, location_id);
        let late = 0;
        if (shift) {
          const tz = require('../utils/time').getTimezone();
          const clockTime = new Intl.DateTimeFormat('en-GB', { 
            timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false 
          }).format(new Date(now));
          late = clockTime > shift.shift_start ? 1 : 0;
        }

        let attendanceId;
        if (!existing) {
          const insertResult = db.prepare(`
            INSERT INTO attendance (user_id, location_id, date, clock_in, clock_in_method, clock_in_latitude, clock_in_longitude, late_arrival, status)
            VALUES (?, ?, ?, ?, 'auto_geofence', ?, ?, ?, 'present')
          `).run(req.user.id, location_id, today, now, latitude || null, longitude || null, late);
          attendanceId = insertResult.lastInsertRowid;
        } else {
          db.prepare(`
            UPDATE attendance SET clock_in = ?, clock_in_method = 'auto_geofence', clock_in_latitude = ?, clock_in_longitude = ?,
            clock_out = NULL, clock_out_method = NULL, late_arrival = ?, status = 'present', updated_at = CURRENT_TIMESTAMP WHERE id = ?
          `).run(now, latitude || null, longitude || null, late, existing.id);
          attendanceId = existing.id;
        }

        db.prepare('UPDATE geofence_events SET processed = 1, auto_action = ? WHERE id = ?').run('clock_in', event.id);

        const location = db.prepare('SELECT name FROM locations WHERE id = ?').get(location_id);
        const friendlyTime = new Intl.DateTimeFormat('en-IN', {
          timeZone: require('../utils/time').getTimezone(), hour: 'numeric', minute: '2-digit', hour12: true,
        }).format(new Date(now));
        createNotification({
          userIds: req.user.id,
          title: 'Clocked in automatically',
          body: `${location ? location.name : 'Shop'}, ${friendlyTime} — not working? Tap to undo.`,
          type: 'attendance_auto_clockin',
          data: { screen: 'Attendance', attendanceId, action: 'undo_auto_clockin' },
        }).catch(() => {});

        return res.json({ success: true, data: event, action: 'auto_clock_in' });
      }
    }
```

(The `if (event_type === 'exit')` block below is unchanged — per spec §5, exit-timeout auto-clock-out stays fully automatic with no notification, since there's no ambiguity for the employee to resolve.)

- [ ] **Step 3: Append the check**

```javascript
check('POST /staff/geofence-event (enter) still auto clocks in AND creates a visible notification', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const { status, body } = await api('POST', '/staff/geofence-event', florist.token, {
    location_id: TEST_LOCATION_ID, event_type: 'enter', latitude: 31.31, longitude: 75.57,
  });
  assert(status === 200, `Expected 200, got ${status}`);
  assert(body.action === 'auto_clock_in', `Expected action 'auto_clock_in', got '${body.action}'`);
  createdAttendanceIds.push(body.data.id);

  const { body: today } = await api('GET', '/attendance/today', florist.token);
  assert(today.data.attendance?.clock_in_method === 'auto_geofence', 'Expected an open auto_geofence session');

  const { body: notifs } = await api('GET', '/notifications', florist.token);
  const found = notifs.data.notifications.find((n) => n.type === 'attendance_auto_clockin');
  assert(found, 'Expected a notification of type attendance_auto_clockin to have been created');
});
```

- [ ] **Step 4: Run it**

Run: `VERIFY_OWNER_PHONE=<owner phone> VERIFY_OWNER_PASSWORD=<owner password> node server/scripts/verify-attendance-payroll.js`
Expected: `13/13 checks passed`

- [ ] **Step 5: Commit**

```bash
git add server/routes/staff-management.js server/scripts/verify-attendance-payroll.js
git commit -m "Geofence auto-clock-in: stays automatic, now sends a visible undo-able notification"
```

---

### Task 10: `POST /attendance/:id/undo-auto-clockin`

**Files:**
- Modify: `server/routes/attendance.js` (new route, placed after `POST /clock-out`)
- Modify: `server/scripts/verify-attendance-payroll.js` (append checks)

**Interfaces:**
- Produces: `POST /api/attendance/:id/undo-auto-clockin` — deletes an auto-geofence-created, still-open attendance row. Consumed by `api.js`'s `undoAutoClockIn(id)` in Task 12.

- [ ] **Step 1: Add the route**

In `server/routes/attendance.js`, immediately after the `POST /clock-out` handler (after line 199):

```js
// ═══════════════════════════════════════════════════════════════
// UNDO AN AUTOMATIC (GEOFENCE) CLOCK-IN
// ═══════════════════════════════════════════════════════════════
// Only undoes a record that was actually auto-created by geofence entry
// AND is still open (no clock_out yet — if they've since clocked out,
// whatever they did while "in" is real work, not a mis-fire). Deletes the
// row outright rather than clocking out, since an undone auto-clock-in
// never represents real work — a clock-out would still count a few
// minutes of attendance that never happened. See spec §5.
router.post('/:id/undo-auto-clockin', authorize('owner', 'manager', 'employee', 'counter_staff', 'florist_staff', 'delivery_partner'), (req, res) => {
  try {
    const db = getDb();
    const record = db.prepare('SELECT * FROM attendance WHERE id = ?').get(req.params.id);
    if (!record) {
      return res.status(404).json({ success: false, message: 'Attendance record not found.' });
    }
    if (record.user_id !== req.user.id && !['owner', 'manager'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Not authorized.' });
    }
    if (record.clock_in_method !== 'auto_geofence') {
      return res.status(400).json({ success: false, message: 'Only an automatic clock-in can be undone this way.' });
    }
    if (record.clock_out) {
      return res.status(400).json({ success: false, message: 'This session has already been clocked out — ask a manager to fix it instead.' });
    }
    db.prepare('DELETE FROM attendance WHERE id = ?').run(record.id);
    res.json({ success: true, message: 'Undone — you are no longer clocked in.' });
  } catch (error) {
    console.error('Undo auto clock-in error:', error);
    res.status(500).json({ success: false, message: 'Failed to undo.' });
  }
});
```

- [ ] **Step 2: Append the checks**

```javascript
check('POST /attendance/:id/undo-auto-clockin deletes an open auto-geofence session', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const geo = await api('POST', '/staff/geofence-event', florist.token, {
    location_id: TEST_LOCATION_ID, event_type: 'enter', latitude: 31.31, longitude: 75.57,
  });
  const attendanceId = geo.body.data.id;

  const { status, body } = await api('POST', `/attendance/${attendanceId}/undo-auto-clockin`, florist.token);
  assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);

  const { body: today } = await api('GET', '/attendance/today', florist.token);
  assert(today.data.attendance === null, 'Expected no active attendance record after undo');
});

check('POST /attendance/:id/undo-auto-clockin refuses a manual clock-in', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const manual = await api('POST', '/attendance/clock-in', florist.token, { location_id: TEST_LOCATION_ID, method: 'manual' });
  createdAttendanceIds.push(manual.body.data.id);

  const { status } = await api('POST', `/attendance/${manual.body.data.id}/undo-auto-clockin`, florist.token);
  assert(status === 400, `Expected 400 for a manual (non-auto) clock-in, got ${status}`);

  await api('POST', '/attendance/clock-out', florist.token, { method: 'manual' });
});
```

- [ ] **Step 3: Run it**

Run: `VERIFY_OWNER_PHONE=<owner phone> VERIFY_OWNER_PASSWORD=<owner password> node server/scripts/verify-attendance-payroll.js`
Expected: `15/15 checks passed`

- [ ] **Step 4: Commit**

```bash
git add server/routes/attendance.js server/scripts/verify-attendance-payroll.js
git commit -m "Add POST /attendance/:id/undo-auto-clockin"
```

---

### Task 11: `POST /attendance/missed-clock-in`

**Files:**
- Modify: `server/routes/attendance.js` (new route, placed after the undo route from Task 10)
- Modify: `server/scripts/verify-attendance-payroll.js` (append check)

**Interfaces:**
- Consumes: `notifyByRole` from `server/routes/notifications.js` (existing).
- Produces: `POST /api/attendance/missed-clock-in` — notifies owner/manager at the given location. Consumed by `api.js`'s `reportMissedClockIn(data)` in Task 12.

- [ ] **Step 1: Add the route**

In `server/routes/attendance.js`, immediately after the `undo-auto-clockin` route from Task 10:

```js
// ═══════════════════════════════════════════════════════════════
// REPORT A MISSED CLOCK-IN (employee self-service recovery)
// ═══════════════════════════════════════════════════════════════
// Today, forgetting to clock in leaves someone wrong for the day with no
// self-service fix (spec §5). This doesn't create any attendance record
// itself — a manager still needs to do that (the same manual clock-in
// StaffAttendanceScreen/AttendanceRoster already have) — it just closes
// the "how do they even find out" gap.
router.post('/missed-clock-in', authorize('owner', 'manager', 'employee', 'counter_staff', 'florist_staff', 'delivery_partner'), async (req, res) => {
  try {
    const db = getDb();
    const { location_id } = req.body;
    if (!location_id) {
      return res.status(400).json({ success: false, message: 'Location is required.' });
    }
    const location = db.prepare('SELECT name FROM locations WHERE id = ?').get(location_id);
    const { notifyByRole } = require('./notifications');
    await notifyByRole({
      roles: ['owner', 'manager'],
      locationId: Number(location_id),
      title: 'Missed clock-in',
      body: `${req.user.name} forgot to clock in at ${location ? location.name : 'the shop'} — tap to clock them in.`,
      type: 'attendance_missed_clockin',
      data: { screen: 'StaffAttendance', userId: req.user.id, locationId: Number(location_id) },
    });
    res.json({ success: true, message: 'Your manager has been notified.' });
  } catch (error) {
    console.error('Missed clock-in report error:', error);
    res.status(500).json({ success: false, message: 'Could not send that — try again.' });
  }
});
```

- [ ] **Step 2: Append the check**

```javascript
check('POST /attendance/missed-clock-in notifies owner/manager at that location', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const { status } = await api('POST', '/attendance/missed-clock-in', florist.token, { location_id: TEST_LOCATION_ID });
  assert(status === 200, `Expected 200, got ${status}`);

  const { body: notifs } = await api('GET', '/notifications', owner.token);
  const found = notifs.data.notifications.find((n) => n.type === 'attendance_missed_clockin');
  assert(found, 'Expected the owner to have received an attendance_missed_clockin notification');
});
```

- [ ] **Step 3: Run it**

Run: `VERIFY_OWNER_PHONE=<owner phone> VERIFY_OWNER_PASSWORD=<owner password> node server/scripts/verify-attendance-payroll.js`
Expected: `16/16 checks passed`

- [ ] **Step 4: Commit**

```bash
git add server/routes/attendance.js server/scripts/verify-attendance-payroll.js
git commit -m "Add POST /attendance/missed-clock-in"
```

---

### Task 12: `api.js` — two new methods

**Files:**
- Modify: `app/src/services/api.js` (add near the existing Attendance/Outdoor Duty methods, after `getTodayAttendance`)

**Interfaces:**
- Produces: `api.undoAutoClockIn(attendanceId)`, `api.reportMissedClockIn({ location_id })` — consumed by `AttendanceScreen.js` in Task 13.

- [ ] **Step 1: Add the methods**

In `app/src/services/api.js`, right after the existing `getTodayAttendance()` method:

```js
  undoAutoClockIn(attendanceId) {
    return this.request(`/attendance/${attendanceId}/undo-auto-clockin`, { method: 'POST' });
  }

  reportMissedClockIn(data) {
    return this.request('/attendance/missed-clock-in', { method: 'POST', body: JSON.stringify(data) });
  }
```

- [ ] **Step 2: Verify**

Run: `node app/scripts/babel-check.js app/src/services/api.js`
Expected: `OK   app/src/services/api.js`

- [ ] **Step 3: Commit**

```bash
git add app/src/services/api.js
git commit -m "api.js: add undoAutoClockIn and reportMissedClockIn"
```

---

### Task 13: `AttendanceScreen.js` — auto-clock-in undo, own late/OT visibility, missed-clock-in recovery

**Files:**
- Modify: `app/src/screens/AttendanceScreen.js`
- Modify: `app/src/hooks/usePushNotifications.js`

**Interfaces:**
- Consumes: `data.lateMinutesToday`/`data.overtimeMinutesToday` from `GET /attendance/today` (Task 5), `api.undoAutoClockIn`/`api.reportMissedClockIn` (Task 12), the `{ screen: 'Attendance', attendanceId, action: 'undo_auto_clockin' }` notification payload (Task 9).

Note: this task closes a gap the plan's own self-review caught — Task 9 sends a notification with an "undo" action and Task 10 builds the endpoint for it, but neither wires an actual button. That happens here.

- [ ] **Step 1: Capture the two new fields from `fetchData`**

In the `fetchData` callback (around line 60-92), add two new state variables near the top of the component (with the other `useState` calls, around line 39-49):

```js
  const [lateMinutesToday, setLateMinutesToday] = useState(0);
  const [overtimeMinutesToday, setOvertimeMinutesToday] = useState(0);
  const [missedClockInSent, setMissedClockInSent] = useState(false);
```

In `fetchData`, right after `setActiveOutdoor(todayRes.data?.activeOutdoor || null);` (around line 71):

```js
      setLateMinutesToday(todayRes.data?.lateMinutesToday || 0);
      setOvertimeMinutesToday(todayRes.data?.overtimeMinutesToday || 0);
```

- [ ] **Step 2: Add the undo and missed-clock-in handlers**

Right after `handleClockOut` (around line 125):

```js
  const handleUndoAutoClockIn = async () => {
    if (!attendance?.id) return;
    setActionLoading(true);
    try {
      await api.undoAutoClockIn(attendance.id);
      await fetchData();
    } catch (e) {
      Alert.alert('Error', e.message || 'Failed to undo.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleMissedClockIn = async () => {
    const locationId = selectedLocation?.id || activeLocation?.id || locations[0]?.id;
    if (!locationId) return;
    setActionLoading(true);
    try {
      await api.reportMissedClockIn({ location_id: locationId });
      setMissedClockInSent(true);
    } catch (e) {
      Alert.alert('Error', e.message || 'Could not send that — try again.');
    } finally {
      setActionLoading(false);
    }
  };
```

- [ ] **Step 3: Render the undo banner, the late/OT line, and the missed-clock-in shortcut**

In the JSX, right after the `{attendance && (<View style={styles.timeRow}>...)}` block closes (around line 291, right before the "Location Selector" comment), add:

```jsx
        {isClockedIn && attendance?.clock_in_method === 'auto_geofence' && (
          <View style={styles.autoClockInBanner}>
            <Ionicons name="information-circle-outline" size={18} color={Colors.primary} />
            <Text style={styles.autoClockInText}>
              Clocked in automatically at {attendance.location_name || 'this location'}, {formatTime(attendance.clock_in)}.
            </Text>
            <TouchableOpacity onPress={handleUndoAutoClockIn} disabled={actionLoading}>
              <Text style={styles.undoLink}>Not working? Undo</Text>
            </TouchableOpacity>
          </View>
        )}

        {(lateMinutesToday > 0 || overtimeMinutesToday > 0) && (
          <View style={styles.ownStatusLine}>
            {lateMinutesToday > 0 && (
              <Text style={styles.ownStatusText}>You clocked in {lateMinutesToday} min late today</Text>
            )}
            {overtimeMinutesToday > 0 && (
              <Text style={styles.ownStatusText}>You're {overtimeMinutesToday} min into overtime today</Text>
            )}
          </View>
        )}

        {!isClockedIn && !isClockedOut && !missedClockInSent && (
          <TouchableOpacity style={styles.missedClockInLink} onPress={handleMissedClockIn} disabled={actionLoading}>
            <Ionicons name="alert-circle-outline" size={16} color={Colors.warning} />
            <Text style={styles.missedClockInText}>Didn't get a chance to clock in? Let your manager know</Text>
          </TouchableOpacity>
        )}
        {missedClockInSent && (
          <Text style={styles.missedClockInSentText}>Your manager has been notified.</Text>
        )}
```

- [ ] **Step 4: Add the new styles**

In the `StyleSheet.create({...})` block at the bottom of the file, add alongside the existing `outdoorBanner`/`outdoorBannerTitle` styles:

```js
  autoClockInBanner: {
    flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6,
    backgroundColor: '#E3F2FD', borderRadius: BorderRadius.md,
    padding: Spacing.sm, marginBottom: Spacing.sm,
  },
  autoClockInText: { flex: 1, fontSize: FontSize.sm, color: Colors.text },
  undoLink: { fontSize: FontSize.sm, color: Colors.primary, fontWeight: '700' },
  ownStatusLine: { marginTop: Spacing.xs, marginBottom: Spacing.sm },
  ownStatusText: { fontSize: FontSize.sm, color: Colors.text, fontWeight: '500' },
  missedClockInLink: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingVertical: Spacing.sm, justifyContent: 'center',
  },
  missedClockInText: { fontSize: FontSize.sm, color: Colors.warning, fontWeight: '600' },
  missedClockInSentText: { fontSize: FontSize.sm, color: Colors.textLight, textAlign: 'center', paddingVertical: Spacing.sm },
```

- [ ] **Step 5: Route a tapped auto-clock-in notification to the Attendance tab**

`usePushNotifications.js`'s response listener already handles a handful of `data.screen` values (`SaleDetail`, `DeliveryDetail`, `ProductionQueue`, `CustomerOrderDetail`) by navigating there when a notification is tapped. Task 9's notification carries `data.screen === 'Attendance'`. Unlike those others, `Attendance` is a top-level bottom tab (not nested inside a stack that needs a `{screen, params}` pair), so it needs its own branch.

In `app/src/hooks/usePushNotifications.js`, inside the existing `if (navigationRef?.current) { try { ... } }` block (around line 79-105), add one more branch after the existing `else if` chain:

```js
            } else if (data.screen === 'Attendance') {
              // Top-level tab, not nested in a stack — the banner/undo
              // affordance itself lives directly on AttendanceScreen
              // (Task 13, Step 3), so simply landing on the tab is enough;
              // no params needed.
              navigationRef.current.navigate('Attendance');
            }
```

This is a courtesy for the case where the employee taps the OS notification directly — the undo banner from Step 3 above is the primary, more robust path (it shows any time they open the Attendance tab while an auto-clocked-in session is still open, whether or not they ever tapped the notification).

- [ ] **Step 6: Verify**

Run: `node app/scripts/babel-check.js app/src/screens/AttendanceScreen.js app/src/hooks/usePushNotifications.js`
Expected: `OK` for both files.

- [ ] **Step 7: Commit**

```bash
git add app/src/screens/AttendanceScreen.js app/src/hooks/usePushNotifications.js
git commit -m "AttendanceScreen: undo-able auto-clock-in banner, own late/OT today, missed-clock-in recovery"
```

---

### Task 14: `AttendanceRoster.js` component

**Files:**
- Create: `app/src/components/attendance/AttendanceRoster.js`

**Interfaces:**
- Consumes: `api.getStaffToday(params)`, `api.clockIn({ user_id, location_id, method })`, `api.clockOut({ user_id, method })` (all existing).
- Produces: `<AttendanceRoster locationId={number|null} onDataChange={fn} />` — a self-contained list (fetches its own data on mount/`locationId` change), consumed by `AttendanceHubScreen.js` in Task 15. `onDataChange({ notClockedInCount })` fires after every successful fetch so the Dashboard banner (Task 17) and the hub's own header can both read the same figure without duplicating the fetch.

- [ ] **Step 1: Write the component**

```javascript
// app/src/components/attendance/AttendanceRoster.js
//
// The "Today" tab's live roster — one row per staff member, exactly one
// primary contextual action each (staff-ux-checklist #2): "Clock In" for
// someone who hasn't, nothing extra for someone already in. An OT chip
// appears once someone crosses their grace period for the day (spec §6/§7).
import React, { useState, useCallback, useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, Alert, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../../constants/theme';
import { formatTime as formatServerTime } from '../../utils/datetime';

function formatTime(iso) {
  if (!iso) return '--:--';
  return formatServerTime(iso, 'en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}

function formatOvertime(minutes) {
  if (!minutes || minutes <= 0) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `+${h}h ${m}m OT` : `+${m}m OT`;
}

const confirmClockOut = (name, onOk) => {
  const msg = `Clock out ${name}?`;
  if (Platform.OS === 'web') { if (window.confirm(msg)) onOk(); }
  else Alert.alert('Clock Out', msg, [{ text: 'Cancel', style: 'cancel' }, { text: 'OK', onPress: onOk }]);
};

export default function AttendanceRoster({ locationId, onDataChange }) {
  const [loading, setLoading] = useState(true);
  const [present, setPresent] = useState([]);
  const [absent, setAbsent] = useState([]);
  const [actionLoadingId, setActionLoadingId] = useState(null);

  const fetchData = useCallback(async () => {
    try {
      const params = locationId ? { location_id: locationId } : {};
      const res = await api.getStaffToday(params);
      const presentRows = res.data?.present || [];
      const absentRows = res.data?.absent || [];
      setPresent(presentRows);
      setAbsent(absentRows);
      if (onDataChange) onDataChange({ notClockedInCount: absentRows.length });
    } catch (e) {
      console.error('Fetch staff-today error:', e);
    } finally {
      setLoading(false);
    }
  }, [locationId, onDataChange]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleClockIn = async (staffId) => {
    const target = absent.find((a) => a.id === staffId);
    const locId = target?.location_id || locationId;
    if (!locId) return;
    setActionLoadingId(staffId);
    try {
      await api.clockIn({ user_id: staffId, location_id: locId, method: 'manual' });
      await fetchData();
    } catch (e) {
      Alert.alert('Error', e.message || 'Failed to clock in staff.');
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleClockOut = (staffId, staffName) => {
    confirmClockOut(staffName, async () => {
      setActionLoadingId(staffId);
      try {
        await api.clockOut({ user_id: staffId, method: 'manual' });
        await fetchData();
      } catch (e) {
        Alert.alert('Error', e.message || 'Failed to clock out staff.');
      } finally {
        setActionLoadingId(null);
      }
    });
  };

  const rows = [
    ...present.map((p) => ({ ...p, _status: 'in' })),
    ...absent.map((a) => ({ ...a, _status: 'out' })),
  ];

  if (loading) {
    return <View style={styles.center}><ActivityIndicator size="large" color={Colors.primary} /></View>;
  }

  return (
    <FlatList
      data={rows}
      keyExtractor={(item) => `${item._status}-${item.id || item.user_id}`}
      contentContainerStyle={styles.list}
      ListEmptyComponent={<Text style={styles.emptyText}>No staff assigned to this location.</Text>}
      renderItem={({ item }) => {
        const busy = actionLoadingId === (item.user_id || item.id);
        const otLabel = formatOvertime(item.overtime_minutes_today);
        return (
          <View style={styles.row}>
            <View style={styles.rowInfo}>
              <Text style={styles.name}>{item.user_name || item.name}</Text>
              <View style={styles.metaRow}>
                {item._status === 'in' ? (
                  <Text style={styles.metaText}>In since {formatTime(item.clock_in)}</Text>
                ) : (
                  <Text style={[styles.metaText, styles.notIn]}>Not clocked in</Text>
                )}
                {otLabel && <Text style={styles.otChip}>{otLabel}</Text>}
                {item.late_minutes_today > 0 && <Text style={styles.lateChip}>{item.late_minutes_today}m late</Text>}
              </View>
            </View>
            {busy ? (
              <ActivityIndicator size="small" color={Colors.primary} />
            ) : item._status === 'in' ? (
              <TouchableOpacity style={styles.actionBtnOut} onPress={() => handleClockOut(item.user_id, item.user_name)}>
                <Ionicons name="log-out-outline" size={16} color="#fff" />
                <Text style={styles.actionBtnText}>Clock Out</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity style={styles.actionBtnIn} onPress={() => handleClockIn(item.id)}>
                <Ionicons name="log-in-outline" size={16} color="#fff" />
                <Text style={styles.actionBtnText}>Clock In</Text>
              </TouchableOpacity>
            )}
          </View>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: Spacing.xl },
  list: { padding: Spacing.md },
  emptyText: { fontSize: FontSize.sm, color: Colors.textLight, textAlign: 'center', paddingVertical: Spacing.lg },
  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    padding: Spacing.md, marginBottom: Spacing.sm,
    shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 4, elevation: 1,
  },
  rowInfo: { flex: 1, marginRight: Spacing.sm },
  name: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2, flexWrap: 'wrap' },
  metaText: { fontSize: FontSize.sm, color: Colors.textLight },
  notIn: { color: Colors.warning },
  otChip: {
    fontSize: 10, fontWeight: '700', color: '#fff', backgroundColor: Colors.warning,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, overflow: 'hidden',
  },
  lateChip: {
    fontSize: 10, fontWeight: '700', color: '#fff', backgroundColor: Colors.danger,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, overflow: 'hidden',
  },
  actionBtnIn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: Colors.secondary, paddingVertical: 8, paddingHorizontal: 12, borderRadius: BorderRadius.md,
    minHeight: 36,
  },
  actionBtnOut: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: Colors.danger, paddingVertical: 8, paddingHorizontal: 12, borderRadius: BorderRadius.md,
    minHeight: 36,
  },
  actionBtnText: { color: '#fff', fontSize: FontSize.sm, fontWeight: '700' },
});
```

- [ ] **Step 2: Verify**

Run: `node app/scripts/babel-check.js app/src/components/attendance/AttendanceRoster.js`
Expected: `OK   app/src/components/attendance/AttendanceRoster.js`

- [ ] **Step 3: Commit**

```bash
git add app/src/components/attendance/AttendanceRoster.js
git commit -m "Add AttendanceRoster: one-tap manual clock-in/out with OT/late chips"
```

---

### Task 15: `AttendanceHubScreen.js` — Today/Manage tabs

**Files:**
- Create: `app/src/screens/AttendanceHubScreen.js`

**Interfaces:**
- Consumes: `AttendanceRoster` (Task 14), `api.getLocations()` (existing).
- Produces: `<AttendanceHubScreen navigation={...} />`, registered in `MainNavigator.js` in Task 16.

- [ ] **Step 1: Write the screen**

```javascript
// app/src/screens/AttendanceHubScreen.js
//
// Replaces AttendanceScreen's owner/manager Quick Links pattern with two
// tabs: Today (live roster, one-tap actions) and Manage (the same five
// existing screens — Shifts/Salaries/Payroll/Advances/Reports — reached
// directly instead of nested). No existing capability removed, only
// regrouped (staff-ux-checklist #9). Employee-facing AttendanceScreen is
// untouched by this file. See spec §7.
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';
import AttendanceRoster from '../components/attendance/AttendanceRoster';

const TABS = [{ key: 'today', label: 'Today' }, { key: 'manage', label: 'Manage' }];

export default function AttendanceHubScreen({ navigation }) {
  const { user, activeLocation } = useAuth();
  const isOwner = user?.role === 'owner';
  const [tab, setTab] = useState('today');
  const [locationId, setLocationId] = useState(null);
  const [advancesPendingCount, setAdvancesPendingCount] = useState(0);

  // Default scope: manager sees their own assigned location, owner sees
  // "All" (locationId stays null) as a deliberate choice, not an accidental
  // default — same pattern OrdersInboxScreen's location filter already
  // established.
  useEffect(() => {
    if (!isOwner && activeLocation?.id) setLocationId(activeLocation.id);
  }, [isOwner, activeLocation?.id]);

  useEffect(() => {
    api.getSalaryAdvances({ status: 'pending' }).then((res) => {
      setAdvancesPendingCount((res.data || []).length);
    }).catch(() => {});
  }, []);

  const manageLinks = [
    { key: 'ShiftManagement', label: 'Shifts', icon: 'calendar' },
    { key: 'SalaryAdvances', label: 'Advances', icon: 'cash', badge: advancesPendingCount },
    { key: 'AttendanceReport', label: 'Reports', icon: 'bar-chart' },
    ...(isOwner ? [{ key: 'SalaryManagement', label: 'Salaries & Payroll', icon: 'wallet' }] : []),
  ];

  return (
    <View style={styles.container}>
      <View style={styles.tabBar}>
        {TABS.map((t) => (
          <TouchableOpacity
            key={t.key}
            style={[styles.tabBtn, tab === t.key && styles.tabBtnActive]}
            onPress={() => setTab(t.key)}
          >
            <Text style={[styles.tabText, tab === t.key && styles.tabTextActive]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {tab === 'today' ? (
        <AttendanceRoster locationId={locationId} />
      ) : (
        <ScrollView contentContainerStyle={styles.manageList}>
          {manageLinks.map((link) => (
            <TouchableOpacity key={link.key} style={styles.manageRow} onPress={() => navigation.navigate(link.key)}>
              <Ionicons name={link.icon} size={22} color={Colors.primary} />
              <Text style={styles.manageRowText}>{link.label}</Text>
              {!!link.badge && (
                <View style={styles.badge}><Text style={styles.badgeText}>{link.badge}</Text></View>
              )}
              <Ionicons name="chevron-forward" size={20} color={Colors.textLight} />
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  tabBar: { flexDirection: 'row', backgroundColor: Colors.surface, borderBottomWidth: 1, borderColor: Colors.border },
  tabBtn: { flex: 1, paddingVertical: Spacing.md, alignItems: 'center', borderBottomWidth: 3, borderColor: 'transparent' },
  tabBtnActive: { borderColor: Colors.primary },
  tabText: { fontSize: FontSize.md, fontWeight: '600', color: Colors.textLight },
  tabTextActive: { color: Colors.primary },
  manageList: { padding: Spacing.md },
  manageRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    padding: Spacing.md, marginBottom: Spacing.sm,
    shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 4, elevation: 1,
  },
  manageRowText: { flex: 1, fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  badge: {
    backgroundColor: Colors.danger, borderRadius: 10, minWidth: 20, height: 20,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5,
  },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
});
```

- [ ] **Step 2: Verify**

Run: `node app/scripts/babel-check.js app/src/screens/AttendanceHubScreen.js`
Expected: `OK   app/src/screens/AttendanceHubScreen.js`

- [ ] **Step 3: Commit**

```bash
git add app/src/screens/AttendanceHubScreen.js
git commit -m "Add AttendanceHubScreen: owner/manager Today/Manage tabs"
```

---

### Task 16: Route owner/manager into the new hub

**Files:**
- Modify: `app/src/navigation/MainNavigator.js:88-101` (imports), `:493-499` (`MoreStack`'s `Attendance` screen registration)

**Interfaces:**
- Consumes: `AttendanceHubScreen` (Task 15).

- [ ] **Step 1: Import the new screen**

In `app/src/navigation/MainNavigator.js`, alongside the existing Phase 8 imports (around line 89):

```js
import AttendanceHubScreen from '../screens/AttendanceHubScreen';
```

- [ ] **Step 2: Point `MoreStack`'s `Attendance` route at the hub**

In `MoreStack` (around line 494), change:
```js
      <Stack.Screen name="Attendance" component={AttendanceScreen} options={{ title: 'Attendance' }} />
```
to:
```js
      <Stack.Screen name="Attendance" component={AttendanceHubScreen} options={{ title: 'Attendance & Payroll' }} />
```

Leave `AttendanceStack` (around line 517, the employee/counter_staff/florist_staff/delivery_partner stack reached via the bottom "Attendance" tab) completely unchanged — it keeps pointing `AttendanceHome` at the original `AttendanceScreen`, matching spec §5's "the clock-in control itself does not move." The five `StaffAttendance`/`AttendanceReport`/`SalaryAdvances`/`ShiftManagement`/`SalaryManagement` screen registrations stay in both stacks exactly as before — `AttendanceHubScreen`'s Manage tab navigates to them by the same route names already registered in `MoreStack`.

- [ ] **Step 3: Verify**

Run: `node app/scripts/babel-check.js app/src/navigation/MainNavigator.js`
Expected: `OK   app/src/navigation/MainNavigator.js`

- [ ] **Step 4: Manual trace**

Log in as owner → tap More → tap Attendance → confirm the Today tab shows the live roster (not the old Quick Links layout) → switch to Manage tab → confirm all 4 links (5 for owner, including Salaries & Payroll) navigate correctly. Log in as employee/counter_staff/florist_staff → tap the bottom Attendance tab → confirm it's the ORIGINAL unchanged clock-in screen, not the hub.

- [ ] **Step 5: Commit**

```bash
git add app/src/navigation/MainNavigator.js
git commit -m "Route owner/manager's Attendance entry to the new AttendanceHubScreen"
```

---

### Task 17: Dashboard "N staff not clocked in" banner

**Files:**
- Modify: `app/src/screens/DashboardScreen.js`

**Interfaces:**
- Consumes: `api.getStaffToday(params)` (existing, same endpoint `AttendanceRoster` uses).

- [ ] **Step 1: Fetch the count for managers/owner**

Near the other manager-scoped data fetches in `DashboardScreen.js`'s main data-loading effect (the block gated by `if (isOwnerOrManager) { ... }`, around line 485 or 515 per the earlier grep), add a fetch of the not-clocked-in count. Add a new state near the top of the component:

```js
  const [notClockedInCount, setNotClockedInCount] = useState(0);
```

Inside the existing `if (isOwnerOrManager) { ... }` data-loading block, add:

```js
        api.getStaffToday(activeLocation?.id ? { location_id: activeLocation.id } : {})
          .then((res) => setNotClockedInCount((res.data?.absent || []).length))
          .catch(() => {});
```

- [ ] **Step 2: Render the banner**

Following the exact `codBannerCompact` pattern already used for the "Add an expense" / pending-COD banners in this same file, add near those existing banners (the block around line 1520-1580):

```jsx
        {isOwnerOrManager && notClockedInCount > 0 && (
          <TouchableOpacity
            style={styles.codBannerCompact}
            onPress={() => navigation.navigate('More', { screen: 'Attendance' })}
          >
            <Ionicons name="alert-circle-outline" size={16} color={Colors.warning} />
            <Text style={styles.codBannerCompactText}>
              {notClockedInCount} staff not clocked in
            </Text>
          </TouchableOpacity>
        )}
```

Navigates to `Attendance` (the new `AttendanceHubScreen`, Task 16), not the older standalone `StaffAttendance` screen — the hub's Today tab is now the one consolidated roster; routing here to the old screen instead would recreate the exact "two competing one-tap mechanisms" problem this redesign exists to fix (see `CLAUDE.md`'s own note on `DashboardScreen`'s old "Orders Needing Attention" list for what that failure mode looks like). `StaffAttendanceScreen` itself is left in place, unlinked from this new path — same "don't delete, just stop routing to it" treatment this codebase already gives `DashboardScreen` v1.

(Reuses the existing `codBannerCompact`/`codBannerCompactText` styles already defined in this file's `StyleSheet.create({...})` — no new styles needed.)

- [ ] **Step 3: Verify**

Run: `node app/scripts/babel-check.js app/src/screens/DashboardScreen.js`
Expected: `OK   app/src/screens/DashboardScreen.js`

- [ ] **Step 4: Manual trace**

Log in as manager/owner with at least one staff member not yet clocked in today → confirm the banner shows the correct count and tapping it navigates to Staff Today.

- [ ] **Step 5: Commit**

```bash
git add app/src/screens/DashboardScreen.js
git commit -m "Dashboard: add 'N staff not clocked in' banner for managers/owner"
```

---

### Task 18: Full regression + live manual trace

**Files:**
- None new — this task runs everything already built.

- [ ] **Step 1: Run all three backend regression suites**

```bash
VERIFY_OWNER_PHONE=<owner phone> VERIFY_OWNER_PASSWORD=<owner password> node server/scripts/verify-shift-work.js
VERIFY_OWNER_PHONE=<owner phone> VERIFY_OWNER_PASSWORD=<owner password> node server/scripts/verify-attendance-payroll.js
VERIFY_OWNER_PHONE=<owner phone> VERIFY_OWNER_PASSWORD=<owner password> node server/scripts/verify-order-flows.js
VERIFY_OWNER_PHONE=<owner phone> VERIFY_OWNER_PASSWORD=<owner password> node server/scripts/verify-register-expenses.js
```
Expected: every suite reports 100% passed, with no unrelated suite's pass count having dropped from before this plan started (confirms nothing in this plan regressed the register/expense or order-flow work from prior sub-projects).

- [ ] **Step 2: Babel-check every touched frontend file in one pass**

```bash
node app/scripts/babel-check.js \
  app/src/services/api.js \
  app/src/screens/AttendanceScreen.js \
  app/src/hooks/usePushNotifications.js \
  app/src/components/attendance/AttendanceRoster.js \
  app/src/screens/AttendanceHubScreen.js \
  app/src/navigation/MainNavigator.js \
  app/src/screens/DashboardScreen.js
```
Expected: `OK` for all seven.

- [ ] **Step 3: Live manual trace — split-shift employee, full day**

Using the real app (not the verify script) against the local dev server: as owner, set a real split shift (7:00-12:00, 18:00-22:00) for a test florist_staff via Shifts. As that employee, clock in around midday for the second segment — confirm the app does NOT show a LATE tag. Stay clocked in past the segment end + 30 minutes — confirm the roster's OT chip appears for that person (as manager) and the employee's own screen shows "into overtime."

- [ ] **Step 4: Live manual trace — manager one-tap clock-in for a "forgot" case**

As a staff member, skip clocking in. As manager, open Attendance → Today → confirm that person shows "Not clocked in" with a one-tap Clock In button directly on their row (not three taps deep) — tap it, confirm it works.

- [ ] **Step 5: Live manual trace — full payroll cycle with expense linkage**

As owner, run Payroll → Calculate for a test employee with at least one late/overtime day this period — confirm the late/OT figures display. Disburse via cash with a register open — confirm success, then check Expenses screen shows the new salary expense linked to that employee, and the register's expected cash dropped by the net amount.

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "Attendance/shift/overtime/payroll redesign: full regression pass complete"
```
