# Attendance, Shift, Overtime & Payroll Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision note (2026-09-16):** this plan was rewritten after an independent Opus-level review found 11 critical issues in the first draft (a timestamp-parsing bug worth ~5.5h of error in every late/OT figure, a test harness that would have deleted real attendance rows, a false claim that this codebase's `db.transaction()` provides real atomicity, three owner/manager capabilities Task 16 would have silently removed, an overtime model that reads a forgotten lunch clock-out as 9 hours of OT, and more) plus four scope additions confirmed directly afterward (a clock-out recovery sweep, a geofence coordinate-precision fix, salary-advance-to-expense linkage, and restoring the three at-risk capabilities). Every task below reflects the corrected version — see `docs/superpowers/specs/2026-09-16-attendance-shift-payroll-redesign-design.md`'s own revision notes for the full corrected claims.

**Goal:** Fix every confirmed attendance/payroll bug (including the ones found during this plan's own review), make split shifts and overtime actually correct end-to-end, close the salary/advance-to-expense-reporting gap, fix the clock-out (not just clock-in) recovery gap the live data shows is the real problem, and replace the buried owner/manager Quick Links pattern with a real hub — without losing any existing capability and without changing the employee clock-in control itself.

**Architecture:** A pure computation module (`server/utils/shift-work.js`, mirroring `order-stage.js`'s "compute fresh, never store" pattern) is the single source of truth for late-minutes and overtime-minutes, using timezone-correct parsing and overlap-based segment matching (not the nearest-start heuristic an earlier draft used, which produced false 9-hour-overtime readings on an ordinary forgotten-lunch-clockout day). Three additive schema changes plus one type-widen (lat/long precision) close the expense/advance/geofence gaps. A new owner/manager hub screen is added *alongside* the existing `AttendanceScreen` (not replacing its only route to it) so outdoor-duty approval, a manager's own clock-in, and Live Map stay reachable. A new end-of-day sweep closes forgotten clock-outs, which the live dev data shows is the actual dominant failure mode, not forgotten clock-ins.

**Tech Stack:** Express.js + `pg` (sync `getDb()` from `database.js` for writes, async `getDb()` from `database-async.js` for reads — matching each touched route's existing layer; note neither layer provides real cross-statement atomicity in this codebase, see Task 9), Expo/React Native + React Navigation, plain-Node `assert`-based verify scripts (no test framework in this codebase).

**Spec:** `docs/superpowers/specs/2026-09-16-attendance-shift-payroll-redesign-design.md`

## Global Constraints

- Every schema change is additive-only (new nullable columns, one widened CHECK constraint) **except** the lat/long precision widen (Task 2), which changes an existing column's type and therefore needs — and has — the explicit sign-off `db-migration-safety` requires for anything beyond additive.
- The employee-facing clock-in button/screen position does not move — only the logic underneath it and additive UI elements.
- Overtime is track-only — never subtracted from or added to `net_amount` anywhere in this plan.
- **No task may remove an existing capability.** Task 18/19 (the owner/manager hub) specifically must leave `AttendanceScreen` reachable — outdoor-duty approval, a manager's own clock-in, and Live Map have no other entry point in the app today.
- Every verify-script run command in this plan is prefixed `cd server &&` — the scripts load `.env` from the process's working directory via `dotenv`, and there is no `.env` at the repo root, only `server/.env`. Running from the repo root silently fails `assertLocalTarget()`'s `DATABASE_URL` check before a single check runs.
- All new/touched date math uses `parseServerDate`/`getTimezone` from `server/utils/time.js` (server) or `app/src/utils/datetime.js` (client) — never a bare `new Date(isoString)` on a value that might be a timezone-naive string, which is exactly the bug this revision fixes in the shift-work module itself.
- New/touched pure logic lives in `server/utils/shift-work.js`; route files call into it rather than re-deriving segment math inline.
- Every touched frontend file must pass `node app/scripts/babel-check.js <file>` before its task is considered done.
- Follow `staff-ux-checklist`: exactly one primary action per roster row, plain-language errors, no existing capability removed.

---

## File Structure

**New files:**
- `server/utils/shift-work.js` — pure overlap-based late/overtime computation, timezone-correct.
- `server/scripts/verify-shift-work.js` — standalone unit-style assertions (mirrors `app/scripts/verify-tracking-steps.js`).
- `server/scripts/verify-attendance-payroll.js` — integration-style regression harness (mirrors `server/scripts/verify-register-expenses.js`), built incrementally.
- `app/src/components/attendance/AttendanceRoster.js` — the "Today" roster (superset of `StaffAttendanceScreen`'s features, not a smaller replacement).
- `app/src/screens/AttendanceHubScreen.js` — owner/manager-only Today/Manage tabs, added *alongside* `AttendanceScreen`.

**Modified files:**
- `server/config/database.js` — 3 additive columns/constraint + 1 type-widen (4 migration items total).
- `server/routes/attendance.js` — segment-aware late/early detection (overlap-based), 10 `florist_staff` authorize() fixes + 3 internal role-array fixes + 1 hardcoded-list fix in `/staff-today`, own late/OT on `/today`, per-person OT on `/staff-today` with dedup, 2 new routes (`undo-auto-clockin` bounded to 15min, `missed-clock-in` deduplicated), `safeParseJSON` import fix.
- `server/routes/staff-management.js` — 4 `florist_staff` authorize() fixes + 1 internal role-array fix (`GET /shifts`) + 1 hardcoded-list fix (`GET /salaries`), geofence-event rewritten (shared segment helpers, fixed re-open guard, explicit `attendance_id` return, server-side proximity check, notification), `payroll/calculate` late/OT fields (with a corrected test assertion), `payroll/disburse` expense linkage (write-ordering fixed, no false atomicity claim), new advance-approval expense linkage.
- `server/server.js` — new end-of-day clock-out sweep in the existing cron, and a fix to that cron's own pre-existing timestamp-parsing bug.
- `app/src/services/api.js` — 2 new methods.
- `app/src/screens/AttendanceScreen.js` — undo banner (15-min bounded), own late/OT line, missed-clock-in shortcut (repositioned below the Clock In button, not above it).
- `app/src/hooks/usePushNotifications.js` — route a tapped auto-clock-in notification to the Attendance tab.
- `app/src/navigation/MainNavigator.js` — register `AttendanceHubScreen` under its own new route (does not replace `AttendanceScreen`'s existing route).
- `app/src/screens/DashboardScreen.js` — "N staff not clocked in" banner, reusing a fetch the screen already makes rather than adding a duplicate.

---

### Task 1: Additive schema changes

**Files:**
- Modify: `server/config/database.js` (two insertion points)
- Test: manual `psql` verification against the local dev DB

**Interfaces:**
- Produces: `expenses.employee_id` (nullable INTEGER FK → `users.id`), `salary_payments.expense_id` (nullable INTEGER FK → `expenses.id`), widened `salary_advances_status_check` (adds `'repaid'`) — all three consumed starting Task 9.

- [ ] **Step 1: Add `expenses.employee_id`**

Find this existing line in `server/config/database.js` (around line 710):

```js
  ensureColumn('expenses', 'is_return', 'INTEGER DEFAULT 0');
```

Add immediately after it:

```js
  // Links a salary-category expense to the actual employee it was paid to —
  // previously pure free text with no structured/queryable link at all.
  // See docs/superpowers/specs/2026-09-16-attendance-shift-payroll-redesign-design.md §4/§9.
  ensureColumn('expenses', 'employee_id', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');
```

- [ ] **Step 2: Add `salary_payments.expense_id` and widen the `salary_advances` status constraint**

Find this existing block (around line 838):

```js
  ensureColumn('salary_advances', 'repaid_amount', 'DECIMAL(10,2) DEFAULT 0');
  ensureColumn('salary_advances', 'date', 'DATE DEFAULT CURRENT_DATE');
```

Add immediately after it:

```js
  // Traceability between a payroll disbursement (or advance approval,
  // Task 10) and the expenses/register reconciliation row it now also
  // writes.
  ensureColumn('salary_payments', 'expense_id', 'INTEGER REFERENCES expenses(id) ON DELETE SET NULL');

  // salary_advances.status CHECK constraint (from schema.sql) doesn't allow
  // 'repaid', but staff-management.js's payroll auto-deduction and
  // attendance.js's PUT /attendance/salary-advance/:id/repay both write
  // exactly that value. Confirmed absent already on the local dev DB
  // (hand-patched at some point, never codified here) — same
  // "hand-patched dev, prod never got it" pattern as users_role_check
  // elsewhere in this file. Widening only.
  try { runPsql('ALTER TABLE salary_advances DROP CONSTRAINT IF EXISTS salary_advances_status_check'); } catch (_) {}
  try {
    runPsql("ALTER TABLE salary_advances ADD CONSTRAINT salary_advances_status_check CHECK(status IN ('pending', 'approved', 'paid', 'rejected', 'repaid'))");
  } catch (_) {}
```

- [ ] **Step 3: Apply and verify against the local dev DB**

Run: `cd server && node server.js`, then Ctrl+C once it logs its normal startup.

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

Before this runs against production: take a backup, confirm the `salary_advances` constraint's actual current state in production specifically, and test against a copy of real production data first.

---

### Task 2: Fix geofence coordinate precision (schema, explicitly approved this session)

**Files:**
- Modify: `server/config/database.js` (one insertion point)
- Test: manual `psql` verification

**Interfaces:**
- Produces: `locations.latitude`/`longitude`, `attendance.clock_in_latitude`/`clock_in_longitude`/`clock_out_latitude`/`clock_out_longitude`, `geofence_events.latitude`/`longitude` widened from `NUMERIC(10,2)` to `NUMERIC(9,6)`. Consumed by Task 11's server-side proximity check (needs real precision to be meaningful) and by whoever re-enters real coordinates after this ships (operational, not part of this plan).

This is a type change, not a new column — per `db-migration-safety`, that needs explicit approval, which was given directly this session in response to being asked whether to do this now. Confirmed harmless to existing data: widening `NUMERIC(10,2)` to `NUMERIC(9,6)` cannot truncate or reject any value already stored (every 2-decimal value is exactly representable with 6), it just allows finer values going forward.

- [ ] **Step 1: Back up first**

Per `db-migration-safety`, even a type-widen gets a backup before running against real data:

```bash
cd server && export $(grep DATABASE_URL .env | xargs) && pg_dump "$DATABASE_URL" -t locations -t attendance -t geofence_events -f /tmp/pre-coordinate-widen-backup.sql
```

- [ ] **Step 2: Add the migration**

In `server/config/database.js`, find the existing block (around line 712):

```js
  ensureColumn('locations', 'gst_number', 'VARCHAR(50)');
  ensureColumn('locations', 'geofence_radius', 'INTEGER DEFAULT 500');
```

Add immediately after it:

```js
  // Geofencing has never actually fired in this shop (confirmed: zero rows
  // in geofence_events, ever) — root cause is that NUMERIC(10,2) gives a
  // ~1.1km grid at this latitude, wider than the 50m geofence radius it's
  // meant to feed. Widening to NUMERIC(9,6) is lossless for anything
  // already stored (every 2-decimal value fits exactly); it only allows
  // more precise values going forward. Explicitly approved this session —
  // a type change, not additive, per db-migration-safety. Existing values
  // must still be RE-ENTERED with real precision afterward; this migration
  // only changes what the column can hold, not the accuracy of what's in
  // it today.
  try { runPsql('ALTER TABLE locations ALTER COLUMN latitude TYPE NUMERIC(9,6)'); } catch (_) {}
  try { runPsql('ALTER TABLE locations ALTER COLUMN longitude TYPE NUMERIC(9,6)'); } catch (_) {}
  try { runPsql('ALTER TABLE attendance ALTER COLUMN clock_in_latitude TYPE NUMERIC(9,6)'); } catch (_) {}
  try { runPsql('ALTER TABLE attendance ALTER COLUMN clock_in_longitude TYPE NUMERIC(9,6)'); } catch (_) {}
  try { runPsql('ALTER TABLE attendance ALTER COLUMN clock_out_latitude TYPE NUMERIC(9,6)'); } catch (_) {}
  try { runPsql('ALTER TABLE attendance ALTER COLUMN clock_out_longitude TYPE NUMERIC(9,6)'); } catch (_) {}
  try { runPsql('ALTER TABLE geofence_events ALTER COLUMN latitude TYPE NUMERIC(9,6)'); } catch (_) {}
  try { runPsql('ALTER TABLE geofence_events ALTER COLUMN longitude TYPE NUMERIC(9,6)'); } catch (_) {}
```

- [ ] **Step 3: Apply and verify**

Run: `cd server && node server.js`, then Ctrl+C once it logs normal startup.

Run:
```bash
cd server && export $(grep DATABASE_URL .env | xargs) && psql "$DATABASE_URL" -c "\d locations" | grep -E "latitude|longitude"
psql "$DATABASE_URL" -c "SELECT id, name, latitude, longitude FROM locations;"
```
Expected: both columns now `numeric(9,6)`; existing values unchanged (e.g. `31.31` still reads as `31.31`, just with more room).

- [ ] **Step 4: Commit**

```bash
git add server/config/database.js
git commit -m "Widen locations/attendance/geofence_events lat/long to NUMERIC(9,6) — geofencing cannot work at 2-decimal precision"
```

- [ ] **Step 5: Note for production rollout**

Before this runs against production: confirm the backup from Step 1 ran against production data specifically (re-run it there), and plan a follow-up (outside this document) for the owner to re-enter each real location's actual coordinates — this migration doesn't fix the values, only what the column can hold.

---

### Task 3: Fix all `florist_staff` gaps (12 spots, not the originally-found 3) + create the test harness

**Files:**
- Modify: `server/routes/attendance.js` (6 authorize() lines, 3 internal role-arrays, 1 hardcoded role list in `/staff-today`)
- Modify: `server/routes/staff-management.js` (4 authorize() lines, 1 internal role-array, 1 hardcoded role list in `GET /salaries`)
- Create: `server/scripts/verify-attendance-payroll.js`

**Interfaces:**
- Produces: `server/scripts/verify-attendance-payroll.js`, a runnable script — later tasks append `check(...)` calls before the final `main()` call. Exports `createFloristStaffSession(ownerToken) -> { token, id }` (real user id, read from `body.data.user.id` — `POST /users`' actual response shape, not `body.data.id`) for every later task's checks to reuse.

- [ ] **Step 1: Fix the 10 originally-found `authorize()` gaps and 3 internal role-scoping arrays**

In `server/routes/attendance.js`, add `'florist_staff'` to these six `authorize(...)` calls (same position it already occupies on `/clock-in`/`/clock-out`):

```js
// line 204
router.get('/today', authorize('owner', 'manager', 'employee', 'counter_staff', 'florist_staff', 'delivery_partner'), async (req, res) => {

// line 407
router.post('/outdoor-duty', authorize('owner', 'manager', 'employee', 'counter_staff', 'florist_staff', 'delivery_partner'), (req, res) => {

// line 513
router.put('/outdoor-duty/:id/complete', authorize('owner', 'manager', 'employee', 'counter_staff', 'florist_staff', 'delivery_partner'), (req, res) => {

// line 568
router.get('/outdoor-duty', authorize('owner', 'manager', 'employee', 'counter_staff', 'florist_staff', 'delivery_partner'), async (req, res) => {

// line 624
router.post('/salary-advance', authorize('owner', 'manager', 'employee', 'counter_staff', 'florist_staff', 'delivery_partner'), (req, res) => {

// line 653
router.get('/salary-advances', authorize('owner', 'manager', 'employee', 'counter_staff', 'florist_staff', 'delivery_partner'), async (req, res) => {
```

Inside `GET /outdoor-duty` (around line 577) and `GET /salary-advances` (around line 661), fix the internal scoping array too — both currently read:
```js
    if (['employee', 'counter_staff', 'delivery_partner'].includes(req.user.role)) {
```
Change both to:
```js
    if (['employee', 'counter_staff', 'florist_staff', 'delivery_partner'].includes(req.user.role)) {
```
Without this, a florist_staff who now passes `authorize()` would fall through to the unscoped branch and see every other employee's data — a leak, not just a 403 fix.

In `server/routes/staff-management.js`, add `'florist_staff'` to these four:

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

`GET /shifts`'s internal scoping (around line 21) has the same leak risk:
```js
    if (['employee', 'counter_staff', 'delivery_partner'].includes(req.user.role)) {
```
Change to:
```js
    if (['employee', 'counter_staff', 'florist_staff', 'delivery_partner'].includes(req.user.role)) {
```

- [ ] **Step 2: Fix the 2 additional gaps found during plan review — these weren't caught by the `authorize()` sweep at all**

`server/routes/attendance.js`'s `GET /staff-today` builds its "who hasn't clocked in" list (around line 955) with a hardcoded role filter that excludes `florist_staff` entirely — not a 403, just silent invisibility on the exact roster this whole redesign builds:
```js
      WHERE u.role IN ('employee', 'counter_staff', 'delivery_partner', 'manager') AND u.is_active = 1
```
Change to:
```js
      WHERE u.role IN ('employee', 'counter_staff', 'florist_staff', 'delivery_partner', 'manager') AND u.is_active = 1
```

`server/routes/staff-management.js`'s `GET /salaries` owner-view branch (around lines 170 and 178) has the same gap — a florist can't be given a salary at all:
```js
        WHERE u.role IN ('manager', 'employee', 'counter_staff', 'delivery_partner') AND u.is_active = 1
```
(appears twice, once for the salaries query and once for the "users without a salary record" query). Change both to:
```js
        WHERE u.role IN ('manager', 'employee', 'counter_staff', 'florist_staff', 'delivery_partner') AND u.is_active = 1
```

- [ ] **Step 3: Create the verify-attendance-payroll.js harness**

```javascript
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
```

- [ ] **Step 4: Run it**

Run: `cd server && VERIFY_OWNER_PHONE=<owner phone> VERIFY_OWNER_PASSWORD=<owner password> node scripts/verify-attendance-payroll.js`
Expected: all 8 checks pass (`8/8 checks passed`).

- [ ] **Step 5: Commit**

```bash
git add server/routes/attendance.js server/routes/staff-management.js server/scripts/verify-attendance-payroll.js
git commit -m "Fix all 12 florist_staff role gaps (10 authorize() + 2 hardcoded role lists) in attendance/shift/salary/geofence routes"
```

---

### Task 4: `shift-work.js` — corrected pure late/overtime computation

**Files:**
- Create: `server/utils/shift-work.js`
- Create: `server/scripts/verify-shift-work.js`

**Interfaces:**
- Produces: `computeShiftWork(sessions, shift) -> { totalLateMinutes, totalOvertimeMinutes, sessions: [{ attendanceId, lateMinutes, overtimeMinutes, startSegment, endSegment }] }`, `normalizeSegments(shiftStart, shiftEnd, shiftSegments) -> [{start, end}]` (minutes since midnight, midnight-crossing segments filtered out), `matchSegmentForTime(minutes, segments) -> {start, end} | null`, `lateMinutesFor`, `overtimeMinutesFor`, `timeStrToMinutes`, `timestampToMinutes`, `dayAdjustedMinutes`, `OVERTIME_GRACE_MINUTES` (30) — all consumed starting Task 5.

**Two corrections from the design review, both load-bearing:**
1. **Timestamp parsing.** An earlier draft used `new Date(ts)` directly. Timestamps read through this codebase's sync `getDb()` layer come back as timezone-naive strings (e.g. `"2026-09-16T12:33:00.000"`, no offset) representing **UTC** wall-clock time (`nowLocal()`'s own storage convention) — `new Date()` on a naive string parses it as the *host machine's local time*, not UTC, producing errors of several hours depending on the shop's offset from the server process's timezone. This function now uses `parseServerDate` from `server/utils/time.js`, the same helper already used everywhere else in this codebase that needs to parse a timestamp that might come from either DB layer.
2. **Segment matching.** An earlier draft matched a session to whichever segment's *start* was numerically nearest the clock-in/out time. Tested against this project's own live 3-segment shift data, that heuristic silently caps lateness at half the gap between segments (arriving 61 minutes late for a 09:00 segment reads as "on time" because 61 minutes past 09:00 is nearer an 11:00 segment's start than 09:00's), and badly over-counts overtime for the single most common real failure this redesign now targets (Task 14's clock-out sweep exists because of it): a session spanning a forgotten lunch clock-out reads as ~9 hours of overtime, because "nearest start" matches the whole span to the segment with the earliest end. The corrected rule: among all segments whose **start** is at-or-before the time in question, take the one with the **latest** start (the segment currently "in effect" at that moment); if none qualify (arrived before the day's first segment), fall back to the earliest segment. Applied once for the clock-in (determines lateness) and once for the clock-out (determines overtime) — the two can be, and often are, different segments.

- [ ] **Step 1: Write the failing test**

Create `server/scripts/verify-shift-work.js`:

```javascript
const assert = require('assert');
const {
  OVERTIME_GRACE_MINUTES,
  timeStrToMinutes,
  timestampToMinutes,
  dayAdjustedMinutes,
  normalizeSegments,
  matchSegmentForTime,
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

// ── timestampToMinutes: must handle a timezone-NAIVE string correctly ──
// (the sync DB layer's actual shape — nowLocal() stores UTC wall-clock with
// no offset marker). This is the exact case an earlier draft's fixtures
// never covered, hiding a ~5.5h real parsing error.
assert.strictEqual(timestampToMinutes('2026-09-16T12:33:00.000'), 1083, 'A naive UTC-wall-clock string must parse to 18:03 IST (1083 min), not silently shift by the host machine\'s local offset');
// An offset-bearing string must parse the same way.
assert.strictEqual(timestampToMinutes('2026-09-16T18:03:00+05:30'), 1083);

// ── normalizeSegments ──
let segs = normalizeSegments('09:00', '18:00', null);
assert.deepStrictEqual(segs, [{ start: 540, end: 1080 }]);

segs = normalizeSegments('09:00', '18:00', [{ start: '07:00', end: '12:00' }, { start: '18:00', end: '22:00' }]);
assert.deepStrictEqual(segs, [{ start: 420, end: 720 }, { start: 1080, end: 1320 }]);

// Malformed shift_segments falls back to the single window, not a crash.
segs = normalizeSegments('09:00', '18:00', 'not-json');
assert.deepStrictEqual(segs, [{ start: 540, end: 1080 }]);

// Double-encoded JSON (a real shape found in the live dev DB —
// employee_shifts id 4 holds a JSON STRING containing JSON, not an array)
// must still resolve to real segments, not silently fall back and
// reinstate the split-shift bug with no warning.
segs = normalizeSegments('09:00', '18:00', JSON.stringify(JSON.stringify([{ start: '07:00', end: '12:00' }])));
assert.deepStrictEqual(segs, [{ start: 420, end: 720 }]);

// A midnight-crossing segment (end <= start) is rejected, not silently
// producing nonsense minutes — POST /shifts (Task 5) blocks these at
// creation time too; this is the defensive second layer.
segs = normalizeSegments('09:00', '18:00', [{ start: '22:00', end: '02:00' }, { start: '07:00', end: '12:00' }]);
assert.deepStrictEqual(segs, [{ start: 420, end: 720 }]);

// ── matchSegmentForTime: the corrected "latest start at-or-before" rule ──
const splitSegs = [{ start: 420, end: 720 }, { start: 1080, end: 1320 }]; // 07-12, 18-22
assert.deepStrictEqual(matchSegmentForTime(1083, splitSegs), { start: 1080, end: 1320 }, 'A 18:03 arrival must match the 18:00 segment, not the 07:00 one (bug #3)');
assert.deepStrictEqual(matchSegmentForTime(425, splitSegs), { start: 420, end: 720 });
// Arrived before the first segment starts — falls back to the earliest.
assert.deepStrictEqual(matchSegmentForTime(400, splitSegs), { start: 420, end: 720 });
assert.strictEqual(matchSegmentForTime(500, []), null);

// The 3-segment live-data case that broke the OLD nearest-start heuristic:
// 61 minutes late for the first segment must NOT be swallowed by a nearer
// second segment's start.
const threeSegs = [{ start: 540, end: 600 }, { start: 660, end: 1080 }, { start: 1200, end: 1350 }]; // 09-10, 11-18, 20-22:30
assert.deepStrictEqual(matchSegmentForTime(601, threeSegs), { start: 540, end: 600 }, 'A 10:01 arrival is still "for" the 09:00-10:00 segment (61 min late), not silently reattributed to 11:00');

// ── lateMinutesFor / overtimeMinutesFor ──
assert.strictEqual(lateMinutesFor(1083, { start: 1080, end: 1320 }), 3);
assert.strictEqual(lateMinutesFor(1075, { start: 1080, end: 1320 }), 0);
assert.strictEqual(lateMinutesFor(601, { start: 540, end: 600 }), 61);
assert.strictEqual(overtimeMinutesFor(1340, { start: 1080, end: 1320 }), 0); // 20 min over, inside 30-min grace
assert.strictEqual(overtimeMinutesFor(1350, { start: 1080, end: 1320 }), 0); // exactly at the grace boundary
assert.strictEqual(overtimeMinutesFor(1365, { start: 1080, end: 1320 }), 15); // 45 min over - 30 grace
assert.strictEqual(overtimeMinutesFor(1200, { start: 1080, end: 1320 }), 0); // left early, not negative

// ── computeShiftWork: the exact live-data regression the review found ──
// Shift 09:00-13:00 / 15:00-22:30. A session spanning the WHOLE midday
// break (forgot to clock out for lunch) must NOT read as ~9 hours of
// overtime — the corrected end-segment match picks the segment actually
// "in effect" at clock-out (15:00-22:30), and the clock-out (22:30) lands
// exactly at that segment's end, so overtime is 0, not (22:30-13:00-30min).
const lunchGapShift = { shift_start: null, shift_end: null, shift_segments: JSON.stringify([{ start: '09:00', end: '13:00' }, { start: '15:00', end: '22:30' }]) };
const lunchGapSession = [{ id: 1, clock_in: '2026-09-16T09:05:00+05:30', clock_out: '2026-09-16T22:30:00+05:30' }];
const lunchGapResult = computeShiftWork(lunchGapSession, lunchGapShift);
assert.strictEqual(lunchGapResult.totalOvertimeMinutes, 0, `A session that spans a forgotten lunch clock-out but ends exactly on time must show 0 OT, got ${lunchGapResult.totalOvertimeMinutes}`);
assert.strictEqual(lunchGapResult.totalLateMinutes, 5, 'Still correctly 5 min late against the 09:00 segment');

// ── computeShiftWork: split-shift day, two real sessions ──
const splitShift = { shift_start: null, shift_end: null, shift_segments: JSON.stringify([{ start: '07:00', end: '12:00' }, { start: '18:00', end: '22:00' }]) };
const today = '2026-09-16';
const sessions = [
  { id: 1, clock_in: `${today}T07:02:00+05:30`, clock_out: `${today}T12:00:00+05:30` }, // 2 min late, on time out
  { id: 2, clock_in: `${today}T18:03:00+05:30`, clock_out: `${today}T22:45:00+05:30` }, // 3 min late for the RIGHT segment, 15 min real OT (45-30 grace)
];
const result = computeShiftWork(sessions, splitShift);
assert.strictEqual(result.totalLateMinutes, 5, `Expected 2 (session 1) + 3 (session 2, correctly matched to its OWN segment) = 5, got ${result.totalLateMinutes}`);
assert.strictEqual(result.totalOvertimeMinutes, 15, `Expected 15 OT minutes, got ${result.totalOvertimeMinutes}`);
assert.strictEqual(result.sessions[1].lateMinutes, 3, 'Session 2 (6pm arrival) must be checked against the 18:00 segment (3 min late), not silently zeroed — the fix is matching the RIGHT segment, not hiding lateness');

// An open session (no clock_out yet) contributes zero overtime.
const openSession = [{ id: 3, clock_in: `${today}T18:00:00+05:30`, clock_out: null }];
assert.strictEqual(computeShiftWork(openSession, splitShift).totalOvertimeMinutes, 0);

// No shift configured — everything zero, not a crash.
const noShiftResult = computeShiftWork(sessions, null);
assert.strictEqual(noShiftResult.totalLateMinutes, 0);
assert.strictEqual(noShiftResult.totalOvertimeMinutes, 0);

// A session genuinely running past midnight (an all-nighter before a big
// order) must not wrap around and look like it ended before it started.
const lateNightShift = { shift_start: null, shift_end: null, shift_segments: JSON.stringify([{ start: '20:00', end: '22:30' }]) };
const lateNightSession = [{ id: 4, clock_in: `${today}T20:05:00+05:30`, clock_out: '2026-09-17T00:30:00+05:30' }];
const lateNightResult = computeShiftWork(lateNightSession, lateNightShift);
assert.strictEqual(lateNightResult.totalOvertimeMinutes, 90, `Expected 90 (worked to 00:30 = 1470 adjusted minutes, minus 1350 segment end, minus 30 grace), got ${lateNightResult.totalOvertimeMinutes}`);

console.log('verify-shift-work: all assertions passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node server/scripts/verify-shift-work.js`
Expected: `Error: Cannot find module '../utils/shift-work'`

- [ ] **Step 3: Implement `server/utils/shift-work.js`**

```javascript
// server/utils/shift-work.js
//
// Pure computation of late-arrival minutes and overtime minutes, aware of
// split shifts (employee_shifts.shift_segments). ALWAYS computed fresh from
// raw clock_in/clock_out timestamps + the shift definition passed in — never
// stored. Mirrors server/utils/order-stage.js's "computed fresh, never
// stored" precedent.
//
// See docs/superpowers/specs/2026-09-16-attendance-shift-payroll-redesign-design.md §6.

const { parseServerDate, getTimezone } = require('./time');

const OVERTIME_GRACE_MINUTES = 30;

// 'HH:MM' (or 'HH:MM:SS') -> minutes since midnight. null for anything that
// doesn't match, so callers can treat bad/missing shift data as "no data"
// rather than crashing.
function timeStrToMinutes(hhmm) {
  if (!hhmm || typeof hhmm !== 'string') return null;
  const m = /^(\d{2}):(\d{2})/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (Number.isNaN(h) || Number.isNaN(min)) return null;
  return h * 60 + min;
}

// Timestamp -> minutes since local midnight, in the shop's configured
// timezone. Uses parseServerDate (not a bare `new Date(ts)`) because
// timestamps read through this codebase's SYNC getDb() layer come back as
// timezone-naive strings representing UTC wall-clock time (nowLocal()'s own
// storage convention) — `new Date()` on a naive string parses it as the
// HOST PROCESS's local time instead, which is wrong by whatever offset
// separates the server's machine timezone from the shop's. This was a real
// bug in an earlier draft of this file, worth ~5.5h of error on every
// figure that used it; parseServerDate is the same helper every other
// timestamp-handling call site in this codebase already relies on for
// exactly this reason.
function timestampToMinutes(ts) {
  const d = parseServerDate(ts);
  if (!d || Number.isNaN(d.getTime())) return null;
  const tz = getTimezone();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const h = Number(parts.find((p) => p.type === 'hour')?.value);
  const min = Number(parts.find((p) => p.type === 'minute')?.value);
  if (Number.isNaN(h) || Number.isNaN(min)) return null;
  return h * 60 + min;
}

// Adds a full day (1440 minutes) per shop-timezone CALENDAR DATE elapsed
// between two timestamps, so a session genuinely running past midnight (an
// all-nighter before a big order — this domain has festival seasons where
// that's real) doesn't wrap its clock-out time around and look like it
// ended before it started. Compares calendar dates, not raw elapsed
// milliseconds / 86400000 — a session that runs from 23:50 to 00:10 has
// crossed one calendar boundary in 20 real minutes, which a
// floor(elapsedMs / dayMs) calculation would miss entirely.
function dayAdjustedMinutes(baseIso, targetIso, targetMinutes) {
  if (targetMinutes == null) return null;
  const base = parseServerDate(baseIso);
  const target = parseServerDate(targetIso);
  if (!base || !target) return targetMinutes;
  const tz = getTimezone();
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const baseDateStr = fmt.format(base);
  const targetDateStr = fmt.format(target);
  if (baseDateStr === targetDateStr) return targetMinutes;
  const daysElapsed = Math.round((new Date(`${targetDateStr}T00:00:00Z`).getTime() - new Date(`${baseDateStr}T00:00:00Z`).getTime()) / 86400000);
  return targetMinutes + Math.max(0, daysElapsed) * 1440;
}

// Normalizes a shift into a list of {start, end} minute-ranges (minutes
// since midnight). A single shift_start/shift_end pair becomes a
// one-segment list, so every caller has exactly one code path regardless of
// split shifts. Handles a real shape found in this project's own live data
// — a shift_segments value that's JSON-encoded TWICE (a string containing a
// JSON string containing the array) — by parsing up to twice before giving
// up, rather than silently falling back to the single window with no
// warning (which would reinstate the split-shift bug this file exists to
// fix). Segments where end <= start (crossing midnight) are dropped —
// POST /shifts (Task 5) blocks these at creation time; this is the
// defensive second layer for shift data that predates that validation.
function normalizeSegments(shiftStart, shiftEnd, shiftSegments) {
  let segments = null;
  if (shiftSegments) {
    let parsed = shiftSegments;
    for (let i = 0; i < 2 && typeof parsed === 'string'; i++) {
      try { parsed = JSON.parse(parsed); } catch (_) { parsed = null; break; }
    }
    if (Array.isArray(parsed) && parsed.length > 0) segments = parsed;
  }
  if (!segments) {
    segments = [{ start: shiftStart, end: shiftEnd }];
  }
  return segments
    .map((seg) => ({ start: timeStrToMinutes(seg.start), end: timeStrToMinutes(seg.end) }))
    .filter((seg) => seg.start != null && seg.end != null && seg.end > seg.start);
}

// The corrected segment-matching rule (see this task's header for why the
// original "nearest start" heuristic was wrong): among segments whose START
// is at-or-before the given time, pick the one with the LATEST start — the
// segment actually "in effect" at that moment. If none qualify (the time is
// before every segment starts), fall back to the earliest segment, so an
// early arrival reads as early rather than "late for the wrong segment."
function matchSegmentForTime(minutes, segments) {
  if (!segments.length || minutes == null) return null;
  const eligible = segments.filter((s) => s.start <= minutes);
  if (eligible.length > 0) {
    return eligible.reduce((latest, s) => (s.start > latest.start ? s : latest));
  }
  return segments.reduce((earliest, s) => (s.start < earliest.start ? s : earliest));
}

function lateMinutesFor(minutes, segment) {
  if (minutes == null || !segment) return 0;
  return Math.max(0, minutes - segment.start);
}

function overtimeMinutesFor(minutes, segment) {
  if (minutes == null || !segment) return 0;
  return Math.max(0, minutes - segment.end - OVERTIME_GRACE_MINUTES);
}

// Main entry point. `sessions` is any list of attendance rows needing at
// minimum { id, clock_in, clock_out } — a single day's rows, or a whole
// payroll period's. `shift` is { shift_start, shift_end, shift_segments } as
// stored on employee_shifts, or null/undefined (every session then
// contributes zero late/OT, matching "no shift configured" being a no-op).
function computeShiftWork(sessions, shift) {
  const segments = shift ? normalizeSegments(shift.shift_start, shift.shift_end, shift.shift_segments) : [];

  let totalLateMinutes = 0;
  let totalOvertimeMinutes = 0;
  const perSession = [];

  for (const session of sessions || []) {
    const clockInMin = timestampToMinutes(session.clock_in);
    const startSegment = matchSegmentForTime(clockInMin, segments);
    const lateMinutes = lateMinutesFor(clockInMin, startSegment);

    let overtimeMinutes = 0;
    let endSegment = null;
    if (session.clock_out) {
      const rawClockOutMin = timestampToMinutes(session.clock_out);
      const clockOutMin = dayAdjustedMinutes(session.clock_in, session.clock_out, rawClockOutMin);
      endSegment = matchSegmentForTime(clockOutMin, segments);
      overtimeMinutes = overtimeMinutesFor(clockOutMin, endSegment);
    }

    totalLateMinutes += lateMinutes;
    totalOvertimeMinutes += overtimeMinutes;
    perSession.push({ attendanceId: session.id, lateMinutes, overtimeMinutes, startSegment, endSegment });
  }

  return { totalLateMinutes, totalOvertimeMinutes, sessions: perSession };
}

module.exports = {
  OVERTIME_GRACE_MINUTES,
  timeStrToMinutes,
  timestampToMinutes,
  dayAdjustedMinutes,
  normalizeSegments,
  matchSegmentForTime,
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
git commit -m "Add shift-work.js: timezone-correct, overlap-aware split-shift late/overtime computation"
```

---

### Task 5: Wire segment-aware late/early detection into clock-in/clock-out + validate shift segments at creation

**Files:**
- Modify: `server/routes/attendance.js:1-10` (imports), `:20-80` (`isLateArrival`/`isEarlyDeparture`), `:171` (call site), end of file (exports)
- Modify: `server/routes/staff-management.js` (`POST /shifts` — reject midnight-crossing segments)
- Modify: `server/scripts/verify-attendance-payroll.js` (append checks)

**Interfaces:**
- Consumes: `normalizeSegments`, `matchSegmentForTime`, `lateMinutesFor`, `overtimeMinutesFor`, `timestampToMinutes`, `dayAdjustedMinutes` from `shift-work.js` (Task 4); `safeParseJSON` from `server/utils/json.js`.
- Produces: `isLateArrival`/`isEarlyDeparture` exported from `attendance.js` for direct testing; `isEarlyDeparture`'s signature changes to `(clockOut, clockIn, operatingHours, userId, locationId)`.

- [ ] **Step 1: Rewrite `isLateArrival` and `isEarlyDeparture`**

Add to `attendance.js`'s existing imports:
```js
const { normalizeSegments, matchSegmentForTime, lateMinutesFor, overtimeMinutesFor, timestampToMinutes, dayAdjustedMinutes } = require('../utils/shift-work');
const { safeParseJSON } = require('../utils/json');
```
(`safeParseJSON` was used at the two lines below already, but was never actually imported anywhere in this file before — a pre-existing bug found during this plan's review: the operating-hours fallback path has always thrown a silently-caught `ReferenceError` and returned `false`. `parseServerDate`/`getTimezone` are already imported at the top of this file.)

Replace the two functions at the top of `server/routes/attendance.js` (lines 20-80):

```js
// ─── Helper: Check if time is late based on shift (segment-aware) OR operating hours ──
// Segment-aware and timezone-correct as of this revision — see shift-work.js
// for why both matter. Employees without a split shift see zero behavior
// change (normalizeSegments falls back to a single window).
function isLateArrival(clockIn, operatingHours, userId, locationId) {
  if (!clockIn) return false;
  try {
    const db = getDb();
    const shift = db.prepare('SELECT shift_start, shift_end, shift_segments FROM employee_shifts WHERE user_id = ? AND location_id = ? AND is_active = 1').get(userId, locationId);
    if (shift && (shift.shift_start || shift.shift_segments)) {
      const segments = normalizeSegments(shift.shift_start, shift.shift_end, shift.shift_segments);
      const clockInMinutes = timestampToMinutes(clockIn);
      const segment = matchSegmentForTime(clockInMinutes, segments);
      return lateMinutesFor(clockInMinutes, segment) > 0;
    }

    // Fallback to location operating_hours when no shift is configured —
    // unchanged in intent, now parsed via parseServerDate like everything
    // else in this file, not a bare `new Date()`.
    if (!operatingHours) return false;
    const tz = getTimezone();
    const d = parseServerDate(clockIn);
    if (!d) return false;
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
// clockIn (this session's OWN clock-in) determines which segment this
// session belongs to — not clockOut, which could be far past every
// segment's end (e.g. a forgotten-lunch-clockout session) and would match
// the wrong one.
function isEarlyDeparture(clockOut, clockIn, operatingHours, userId, locationId) {
  if (!clockOut) return false;
  try {
    const db = getDb();
    const shift = db.prepare('SELECT shift_start, shift_end, shift_segments FROM employee_shifts WHERE user_id = ? AND location_id = ? AND is_active = 1').get(userId, locationId);
    if (shift && (shift.shift_start || shift.shift_segments)) {
      const segments = normalizeSegments(shift.shift_start, shift.shift_end, shift.shift_segments);
      const clockInMinutes = timestampToMinutes(clockIn);
      const rawClockOutMinutes = timestampToMinutes(clockOut);
      const clockOutMinutes = dayAdjustedMinutes(clockIn, clockOut, rawClockOutMinutes);
      const segment = matchSegmentForTime(clockInMinutes, segments);
      if (!segment || clockOutMinutes == null) return false;
      return clockOutMinutes < segment.end;
    }

    if (!operatingHours) return false;
    const tz = getTimezone();
    const d = parseServerDate(clockOut);
    if (!d) return false;
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

- [ ] **Step 3: Reject midnight-crossing shift segments server-side**

In `server/routes/staff-management.js`'s `POST /shifts` handler, right after the existing `const { user_id, location_id, shift_start, shift_end, days_of_week, geofence_timeout_minutes, shift_segments } = req.body;` line, add:

```js
    if (Array.isArray(shift_segments)) {
      for (const seg of shift_segments) {
        if (seg?.start && seg?.end && seg.end <= seg.start) {
          return res.status(400).json({ success: false, message: `A shift segment can't end before it starts (${seg.start}–${seg.end}). Split an overnight shift into two segments on separate days instead.` });
        }
      }
    }
```

- [ ] **Step 4: Export both functions for direct testing**

At the bottom of `server/routes/attendance.js`, find `module.exports = router;` and change to:
```js
module.exports = router;
module.exports.isLateArrival = isLateArrival;
module.exports.isEarlyDeparture = isEarlyDeparture;
```

- [ ] **Step 5: Append the bug #3 regression check**

Add to `verify-attendance-payroll.js`, before `async function cleanup()`:

```javascript
// ═══════════════════════════════════════════════════════════════
// Split-shift late detection (bug #3) — via the corrected shift-work.js
// ═══════════════════════════════════════════════════════════════

check('isLateArrival correctly flags a split-shift employee\'s SECOND-segment clock-in against ITS OWN segment (bug #3)', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const { isLateArrival } = require('../routes/attendance');
  const db = await getDb();

  const shiftResult = await db.prepare(`
    INSERT INTO employee_shifts (user_id, location_id, shift_start, shift_end, shift_segments, is_active)
    VALUES (?, ?, '09:00', '18:00', ?, 1) RETURNING id
  `).get(florist.id, TEST_LOCATION_ID, JSON.stringify([{ start: '07:00', end: '12:00' }, { start: '18:00', end: '22:00' }]));
  createdShiftIds.push(shiftResult.id);

  const today = new Date().toISOString().slice(0, 10);
  // On time for the second segment — must NOT be flagged late against the
  // first segment's 07:00 start (the original bug).
  const onTimeSecondSegment = isLateArrival(`${today}T18:00:00+05:30`, null, florist.id, TEST_LOCATION_ID);
  assert(onTimeSecondSegment === false, `Expected NOT late (exactly on time for segment 2), got late=${onTimeSecondSegment}`);

  // Genuinely 5 min late for the second segment — must correctly flag late
  // against THAT segment (18:00), not read as early against the first.
  const trulyLateSecondSegment = isLateArrival(`${today}T18:05:00+05:30`, null, florist.id, TEST_LOCATION_ID);
  assert(trulyLateSecondSegment === true, `Expected late (5 min after 18:00 segment start), got late=${trulyLateSecondSegment}`);
});

check('isLateArrival does not silently cap lateness at half the gap between segments (the old nearest-start bug)', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const { isLateArrival } = require('../routes/attendance');
  const db = await getDb();

  const shiftResult = await db.prepare(`
    INSERT INTO employee_shifts (user_id, location_id, shift_start, shift_end, shift_segments, is_active)
    VALUES (?, ?, '09:00', '18:00', ?, 1) RETURNING id
  `).get(florist.id, TEST_LOCATION_ID, JSON.stringify([{ start: '09:00', end: '10:00' }, { start: '11:00', end: '18:00' }, { start: '20:00', end: '22:30' }]));
  createdShiftIds.push(shiftResult.id);

  const today = new Date().toISOString().slice(0, 10);
  // 61 minutes late for the 09:00-10:00 segment — the old "nearest start"
  // heuristic would match this to the 11:00 segment instead (only 59 min
  // away vs 61) and read it as "early," hiding real lateness.
  const late = isLateArrival(`${today}T10:01:00+05:30`, null, florist.id, TEST_LOCATION_ID);
  assert(late === true, `Expected late (61 min past the 09:00 segment start), got late=${late}`);
});

check('POST /staff/shifts rejects a midnight-crossing segment with a plain-language message', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const { status, body } = await api('POST', '/staff/shifts', owner.token, {
    user_id: florist.id, location_id: TEST_LOCATION_ID,
    shift_start: '09:00', shift_end: '18:00',
    shift_segments: [{ start: '22:00', end: '02:00' }],
  });
  assert(status === 400, `Expected 400 for a midnight-crossing segment, got ${status}`);
  assert(!/error|exception|undefined/i.test(body.message || ''), `Error message should be plain-language, got: ${body.message}`);
});
```

- [ ] **Step 6: Run it**

Run: `cd server && VERIFY_OWNER_PHONE=<owner phone> VERIFY_OWNER_PASSWORD=<owner password> node scripts/verify-attendance-payroll.js`
Expected: `11/11 checks passed`

- [ ] **Step 7: Commit**

```bash
git add server/routes/attendance.js server/routes/staff-management.js server/scripts/verify-attendance-payroll.js
git commit -m "Fix split-shift late/early detection to match the RIGHT segment; reject midnight-crossing segments at creation"
```

---

### Task 6: `GET /attendance/today` — own late/overtime summary

**Files:**
- Modify: `server/routes/attendance.js` (add `computeShiftWork` to the Task 5 import), `:204-254` (`/today` route)
- Modify: `server/scripts/verify-attendance-payroll.js` (append check)

**Interfaces:**
- Consumes: `computeShiftWork` from `shift-work.js` (Task 4).
- Produces: `GET /attendance/today` response gains `data.lateMinutesToday` and `data.overtimeMinutesToday`, consumed by `AttendanceScreen.js` in Task 17.

- [ ] **Step 1: Add `computeShiftWork` to the existing shift-work import**

Task 5's import line becomes:
```js
const { normalizeSegments, matchSegmentForTime, lateMinutesFor, overtimeMinutesFor, timestampToMinutes, dayAdjustedMinutes, computeShiftWork } = require('../utils/shift-work');
```

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

    // Own late/overtime summary for today — track-only, plain-language
    // display on AttendanceScreen. Uses the CURRENT/latest session's
    // location for the shift lookup, a simplification that assumes
    // single-location attendance per day, matching this project's current
    // single-location-per-shop scope.
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

Run: `cd server && VERIFY_OWNER_PHONE=<owner phone> VERIFY_OWNER_PASSWORD=<owner password> node scripts/verify-attendance-payroll.js`
Expected: `12/12 checks passed`

- [ ] **Step 5: Commit**

```bash
git add server/routes/attendance.js server/scripts/verify-attendance-payroll.js
git commit -m "GET /attendance/today: add own late/overtime minutes summary"
```

---

### Task 7: `GET /attendance/staff-today` — per-person overtime chip data + de-duplicate multi-location staff

**Files:**
- Modify: `server/routes/attendance.js:762-984` (`/staff-today` route)
- Modify: `server/scripts/verify-attendance-payroll.js` (append checks)

**Interfaces:**
- Consumes: `computeShiftWork` (already imported per Task 6, same file).
- Produces: each entry in `data.present[]` gains `late_minutes_today`/`overtime_minutes_today`; `data.absent[]` no longer contains duplicate rows for a staff member assigned to more than one location.

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

In the `byUser` aggregation's initial-entry object (around line 830-854), add `shift_segments: row.shift_segments || null,` right after `shift_end: row.shift_end || null,`, and in the "latest session wins" update block (around line 885-889):

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

- [ ] **Step 4: De-duplicate the "not clocked in" list for multi-location staff**

The `notClocked` query (around line 933-958) currently uses plain `DISTINCT` with `ul.location_id` in the select list, so a staff member assigned to more than one location gets one row per assignment when the owner's "All Locations" view has no `location_id` filter — live data has at least two such users. Replace `DISTINCT` with `DISTINCT ON (u.id)`, add `shift_segments` to the COALESCE pattern already used for `shift_start`/`shift_end`, and add the required `ORDER BY` (Postgres requires `DISTINCT ON`'s expression to lead the `ORDER BY`):

```js
    const notClocked = await db.prepare(`
      SELECT DISTINCT ON (u.id)
        u.id,
        u.name,
        u.phone,
        u.role,
        ul.location_id,
        COALESCE(
          es.shift_start,
          (SELECT es2.shift_start FROM employee_shifts es2 WHERE es2.user_id = u.id AND es2.is_active = 1 ORDER BY es2.updated_at DESC, es2.id DESC LIMIT 1)
        ) as shift_start,
        COALESCE(
          es.shift_end,
          (SELECT es2.shift_end FROM employee_shifts es2 WHERE es2.user_id = u.id AND es2.is_active = 1 ORDER BY es2.updated_at DESC, es2.id DESC LIMIT 1)
        ) as shift_end,
        COALESCE(
          es.shift_segments,
          (SELECT es2.shift_segments FROM employee_shifts es2 WHERE es2.user_id = u.id AND es2.is_active = 1 ORDER BY es2.updated_at DESC, es2.id DESC LIMIT 1)
        ) as shift_segments,
        COALESCE(
          es.days_of_week,
          (SELECT es2.days_of_week FROM employee_shifts es2 WHERE es2.user_id = u.id AND es2.is_active = 1 ORDER BY es2.updated_at DESC, es2.id DESC LIMIT 1)
        ) as days_of_week
      FROM users u
      JOIN user_locations ul ON u.id = ul.user_id
      LEFT JOIN employee_shifts es ON es.user_id = u.id AND es.location_id = ul.location_id AND es.is_active = 1
      WHERE u.role IN ('employee', 'counter_staff', 'florist_staff', 'delivery_partner', 'manager') AND u.is_active = 1
      ${notClockedFilter}
      AND u.id NOT IN (SELECT user_id FROM attendance WHERE date = ?)
      ORDER BY u.id, ul.is_primary DESC, ul.id ASC
    `).all(...notParams, today);
```

(The role list here already includes `florist_staff` per Task 3 Step 2 — this step only adds the dedup and `shift_segments`.)

- [ ] **Step 5: Append the checks**

```javascript
check('GET /attendance/staff-today includes overtime_minutes_today per staff member', async () => {
  const owner = await loginOwner();
  const { status, body } = await api('GET', `/attendance/staff-today?location_id=${TEST_LOCATION_ID}`, owner.token);
  assert(status === 200, `Expected 200, got ${status}`);
  assert(Array.isArray(body.data.present), 'Expected data.present to be an array');
  for (const s of body.data.present) {
    assert(typeof s.overtime_minutes_today === 'number', `Expected overtime_minutes_today on ${s.user_name}`);
    assert(typeof s.late_minutes_today === 'number', `Expected late_minutes_today on ${s.user_name}`);
  }
});

check('GET /attendance/staff-today does not list a multi-location staff member more than once in "absent"', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  // Assign a second location so this user has 2 assignments.
  const db = await getDb();
  const otherLocation = (await db.prepare('SELECT id FROM locations WHERE id != ? AND is_active = 1 LIMIT 1').get(TEST_LOCATION_ID));
  if (otherLocation) {
    await db.prepare('INSERT INTO user_locations (user_id, location_id, is_primary) VALUES (?, ?, 0) ON CONFLICT DO NOTHING').run(florist.id, otherLocation.id);
  }
  const { status, body } = await api('GET', '/attendance/staff-today', owner.token); // no location_id — "All Locations"
  assert(status === 200, `Expected 200, got ${status}`);
  const occurrences = body.data.absent.filter((a) => a.id === florist.id).length;
  assert(occurrences <= 1, `Expected the multi-location florist to appear at most once in absent, got ${occurrences}`);
});
```

- [ ] **Step 6: Run it**

Run: `cd server && VERIFY_OWNER_PHONE=<owner phone> VERIFY_OWNER_PASSWORD=<owner password> node scripts/verify-attendance-payroll.js`
Expected: `14/14 checks passed`

- [ ] **Step 7: Commit**

```bash
git add server/routes/attendance.js server/scripts/verify-attendance-payroll.js
git commit -m "GET /attendance/staff-today: add per-person overtime/late minutes, de-duplicate multi-location staff"
```

---

### Task 8: `POST /staff/payroll/calculate` — total late minutes + overtime minutes

**Files:**
- Modify: `server/routes/staff-management.js:1-6` (imports), `:353-448` (`/payroll/calculate` route)
- Modify: `server/scripts/verify-attendance-payroll.js` (append check)

**Interfaces:**
- Consumes: `computeShiftWork` (Task 4).
- Produces: `POST /staff/payroll/calculate` response's `attendance_summary` gains `total_late_minutes` and `overtime_minutes` — informational only, does not affect `calculation.net_amount`.

- [ ] **Step 1: Add the import**

Near the top of `server/routes/staff-management.js`:
```js
const { computeShiftWork } = require('../utils/shift-work');
```

- [ ] **Step 2: Compute and add the two fields**

Right after the existing `const totalHours = attendance.reduce(...)` line (around line 392), add:

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

An earlier draft of this check asserted `net_amount === 15000` for a brand-new employee with zero attendance over the full period — arithmetically impossible: with `daysWorked=0` over a 31-day period, `absentDays = 31`, and the monthly deduction formula (`monthly_salary/30 × unexcused absences`) produces a deduction of `15500` against a `15000` salary, clamped to `net_amount = 0`. The corrected check asserts that real invariant instead of a wrong magic number:

```javascript
check('POST /staff/payroll/calculate includes total_late_minutes and overtime_minutes, and neither affects net_amount', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  await api('POST', '/staff/salaries', owner.token, { user_id: florist.id, monthly_salary: 15000, salary_type: 'monthly' });
  const period_start = '2026-01-01';
  const period_end = '2026-01-31';
  const { status, body } = await api('POST', '/staff/payroll/calculate', owner.token, { user_id: florist.id, period_start, period_end });
  assert(status === 200, `Expected 200, got ${status}`);
  assert(typeof body.data.attendance_summary.total_late_minutes === 'number', 'Expected total_late_minutes to be a number');
  assert(typeof body.data.attendance_summary.overtime_minutes === 'number', 'Expected overtime_minutes to be a number');
  // Zero attendance over the full period → absentDays=31 → deductions
  // (15000/30 × 31 = 15500) exceed base_pay (15000) → net_amount clamps to
  // 0. This is the real, correct output of today's existing calculation
  // logic (untouched by this task) — asserting it directly rather than a
  // guessed number confirms OT/late are additive-only and don't perturb it.
  const expectedNet = Math.max(0, body.data.calculation.base_pay - body.data.calculation.deductions);
  assert(body.data.calculation.net_amount === expectedNet, `Expected net_amount to equal base_pay - deductions (clamped at 0) = ${expectedNet}, got ${body.data.calculation.net_amount}`);
});
```

- [ ] **Step 4: Run it**

Run: `cd server && VERIFY_OWNER_PHONE=<owner phone> VERIFY_OWNER_PASSWORD=<owner password> node scripts/verify-attendance-payroll.js`
Expected: `15/15 checks passed`

- [ ] **Step 5: Commit**

```bash
git add server/routes/staff-management.js server/scripts/verify-attendance-payroll.js
git commit -m "POST /staff/payroll/calculate: add track-only total_late_minutes and overtime_minutes"
```

---

### Task 9: `POST /staff/payroll/disburse` — salary/expense/register linkage (corrected write ordering)

**Files:**
- Modify: `server/routes/staff-management.js:1-6` (imports), `:451-524` (`/payroll/disburse` route)
- Modify: `server/routes/expenses.js` (widen the `payment_method` validator to accept `bank_transfer`)
- Modify: `server/scripts/verify-attendance-payroll.js` (append checks)

**Interfaces:**
- Consumes: `hasOpenRegister(db, locationId)`, `REGISTER_CLOSED_MESSAGE` from `register-guard.js`; `todayStr` from `server/utils/time.js` (already imported at the top of `attendance.js`, needs adding here).
- Produces: `salary_payments.expense_id` populated; a matching `expenses` row for every disbursement.

**Corrected from an earlier draft, which claimed `POST /payroll/disburse` needed to keep both inserts on the sync `getDb()` layer "so they share a transaction, both commit or neither does."** That claim is false: reading `database.js` directly finds `db.transaction(fn)` is `return (...args) => fn(...args)` — a no-op wrapper, not a real transaction; every statement still runs through its own `spawnSync('psql', ...)` subprocess, autocommitted individually. There is no atomicity to preserve either way. The real fix is **write ordering**, not layer choice: write the `expenses` row *first*. If that fails, no payment is ever recorded as paid. If the subsequent `salary_payments` insert fails, the result is a harmless orphaned expense row, not a salary silently marked "already paid" with the owner having no way to undo it and no route that lets them retry (the existing duplicate-period guard would block a retry). `db.transaction()` is still used below to keep the writes together in one place, matching this codebase's existing style at this call site — but it is not relied on for correctness.

- [ ] **Step 1: Add imports**

Near the top of `server/routes/staff-management.js`:
```js
const { hasOpenRegister, REGISTER_CLOSED_MESSAGE } = require('../utils/register-guard');
const { todayStr } = require('../utils/time');
```
(`computeShiftWork` import already added in Task 8 — same file.)

- [ ] **Step 2: Widen the expenses payment_method validator**

In `server/routes/expenses.js`, find:
```js
    body('payment_method').isIn(['cash', 'card', 'upi']),
```
Change to:
```js
    body('payment_method').isIn(['cash', 'card', 'upi', 'bank_transfer']),
```
`SalaryManagementScreen.js` already offers `bank_transfer` as a disbursement payment method; without this, an expense written with that value would be a shape the public `POST /expenses` route's own validator would reject if anyone ever tried to re-submit or edit it through that path, even though the direct internal `INSERT` this task performs bypasses the validator and would otherwise succeed silently with an inconsistent value.

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
      deductions, bonus, net_amount,
      payment_method, payment_reference, notes,
    } = req.body;
    // advances_deducted is read separately below, after being capped —
    // never trust the client-computed value directly for a write that
    // marks real money as repaid.
    let advancesDeducted = Number(req.body.advances_deducted) || 0;

    if (!user_id || !period_start || !period_end || net_amount === undefined) {
      return res.status(400).json({ success: false, message: 'Missing required fields.' });
    }

    const existing = db.prepare(
      'SELECT id FROM salary_payments WHERE user_id = ? AND period_start = ? AND period_end = ? AND status != ?'
    ).get(user_id, period_start, period_end, 'cancelled');
    if (existing) {
      return res.status(400).json({ success: false, message: `Salary for this period was already recorded (payment #${existing.id}) — check Payroll History rather than disbursing again.` });
    }

    // Cap the advance deduction at what this payment can actually absorb —
    // SalaryManagementScreen already clamps net_amount to Math.max(0, ...)
    // but was still sending the FULL advances_deducted regardless, which
    // would mark an advance fully repaid even when only part of it was
    // really covered by this payment.
    advancesDeducted = Math.min(advancesDeducted, Number(net_amount) || 0);

    const method = payment_method || 'cash';

    // The disbursement also writes a linked expenses row (below) so it
    // shows up in financial reports and register reconciliation. That
    // write needs a real location only when cash is physically involved —
    // payroll itself has no location dimension (employee_salaries is
    // user-scoped), and requiring one for a bank/UPI transfer where no
    // physical drawer is touched would block a disbursement for no reason
    // tied to what's actually happening.
    let locationId = null;
    if (method === 'cash') {
      const employeeLocation = db.prepare(
        'SELECT location_id FROM user_locations WHERE user_id = ? ORDER BY is_primary DESC, id ASC LIMIT 1'
      ).get(user_id);
      locationId = employeeLocation ? employeeLocation.location_id : null;
      if (!locationId) {
        return res.status(400).json({ success: false, message: "This employee isn't assigned to a location yet — assign one before disbursing salary in cash." });
      }
      // Cash disbursements move real money out of the drawer, same as any
      // other cash expense — hard-blocked with no open register instead of
      // silently recording a payment no session's expected_cash accounts
      // for. Worded for what's actually happening here (paying OUT), not
      // the generic "taking a payment" wording other cash routes reuse.
      if (!hasOpenRegister(db, locationId)) {
        return res.status(400).json({ success: false, message: `The cash drawer isn't open at this employee's location — open the register first, or choose UPI/Bank if you're paying this by transfer.` });
      }
    } else {
      // Still attribute the expense to SOME location for reporting, even
      // without a register concern — best-effort, non-blocking.
      const employeeLocation = db.prepare(
        'SELECT location_id FROM user_locations WHERE user_id = ? ORDER BY is_primary DESC, id ASC LIMIT 1'
      ).get(user_id);
      locationId = employeeLocation ? employeeLocation.location_id : null;
    }

    const openRegister = (method === 'cash' && locationId)
      ? db.prepare('SELECT id FROM cash_registers WHERE location_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1').get(locationId)
      : null;

    const disburseTx = db.transaction(() => {
      let expenseId = null;
      // Write the expense FIRST (see this task's header note on why —
      // db.transaction() here does not provide real atomicity). Only when
      // a location is actually known — a disbursement can still proceed
      // with no expense-report linkage rather than blocking entirely on an
      // employee with no location assignment at all when paying by
      // transfer.
      if (locationId) {
        const payeeUser = db.prepare('SELECT name FROM users WHERE id = ?').get(user_id);
        const expenseResult = db.prepare(`
          INSERT INTO expenses (location_id, category, amount, description, payment_method, expense_date, created_by, employee_id, register_id)
          VALUES (?, 'salary', ?, ?, ?, ?, ?, ?, ?)
        `).run(
          locationId, net_amount,
          `Salary payment — ${payeeUser ? payeeUser.name : 'employee'} (${period_start} to ${period_end})`,
          method, todayStr(), req.user.id, user_id,
          openRegister ? openRegister.id : null
        );
        expenseId = expenseResult.lastInsertRowid;

        if (method === 'cash' && openRegister && Number(net_amount) > 0) {
          db.prepare('UPDATE cash_registers SET expected_cash = expected_cash - ? WHERE id = ?').run(net_amount, openRegister.id);
        }
      }

      const paymentResult = db.prepare(`
        INSERT INTO salary_payments (
          user_id, period_start, period_end, base_salary, days_worked, days_in_period,
          hours_worked, late_days, absent_days, leaves_taken, deductions,
          advances_deducted, bonus, net_amount, payment_method, payment_reference,
          status, paid_at, paid_by, notes, expense_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', CURRENT_TIMESTAMP, ?, ?, ?)
      `).run(
        user_id, period_start, period_end,
        base_salary || 0, days_worked || 0, days_in_period || 0,
        hours_worked || 0, late_days || 0, absent_days || 0, leaves_taken || 0,
        deductions || 0, advancesDeducted, bonus || 0, net_amount,
        method, payment_reference || '',
        req.user.id, notes || '', expenseId
      );
      const paymentId = paymentResult.lastInsertRowid;

      if (advancesDeducted > 0) {
        let remaining = advancesDeducted;
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
check('POST /staff/payroll/disburse (cash) requires an open register, writes a linked expense, adjusts expected_cash, and caps advances_deducted at net_amount', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  await api('POST', '/staff/salaries', owner.token, { user_id: florist.id, monthly_salary: 12000, salary_type: 'monthly' });

  const blocked = await api('POST', '/staff/payroll/disburse', owner.token, {
    user_id: florist.id, period_start: '2026-02-01', period_end: '2026-02-28', net_amount: 12000, payment_method: 'cash',
  });
  assert(blocked.status === 400, `Expected 400 with no open register, got ${blocked.status}`);

  const initialStatus = await api('GET', `/sales/register/status?location_id=${TEST_LOCATION_ID}`, owner.token);
  if (initialStatus.body?.isOpen) {
    await api('PUT', '/sales/register/close', owner.token, { location_id: TEST_LOCATION_ID, actual_cash: Number(initialStatus.body.data.expected_cash) || 0 });
  }
  await api('POST', '/sales/register/open', owner.token, { location_id: TEST_LOCATION_ID, opening_balance: 1000 });
  const before = await api('GET', `/sales/register/status?location_id=${TEST_LOCATION_ID}`, owner.token);
  const expectedBefore = Number(before.body.data.expected_cash);

  // advances_deducted (5000) exceeds net_amount (3000) — must be capped to
  // 3000, not repay the full 5000 against real money that was never paid.
  const { status, body } = await api('POST', '/staff/payroll/disburse', owner.token, {
    user_id: florist.id, period_start: '2026-02-01', period_end: '2026-02-28',
    net_amount: 3000, advances_deducted: 5000, payment_method: 'cash',
  });
  assert(status === 201, `Expected 201, got ${status}: ${JSON.stringify(body)}`);
  assert(body.data.advances_deducted === 3000, `Expected advances_deducted capped to 3000, got ${body.data.advances_deducted}`);
  assert(body.data.expense_id != null, 'Expected salary_payments.expense_id to be set');
  createdSalaryIds.push(body.data.id);
  createdExpenseIds.push(body.data.expense_id);

  const db = await getDb();
  const expense = await db.prepare('SELECT * FROM expenses WHERE id = ?').get(body.data.expense_id);
  assert(expense.category === 'salary', `Expected category 'salary', got '${expense.category}'`);
  assert(Number(expense.employee_id) === florist.id, `Expected employee_id ${florist.id}, got ${expense.employee_id}`);

  const after = await api('GET', `/sales/register/status?location_id=${TEST_LOCATION_ID}`, owner.token);
  const expectedAfter = Number(after.body.data.expected_cash);
  assert(Math.abs((expectedBefore - 3000) - expectedAfter) < 0.01, `Expected register to drop by 3000, went from ${expectedBefore} to ${expectedAfter}`);

  await api('PUT', '/sales/register/close', owner.token, { location_id: TEST_LOCATION_ID, actual_cash: expectedAfter });
});

check('POST /staff/payroll/disburse (bank transfer) does not require an open register', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  await api('POST', '/staff/salaries', owner.token, { user_id: florist.id, monthly_salary: 9000, salary_type: 'monthly' });
  const { status, body } = await api('POST', '/staff/payroll/disburse', owner.token, {
    user_id: florist.id, period_start: '2026-03-01', period_end: '2026-03-31', net_amount: 9000, payment_method: 'bank_transfer',
  });
  assert(status === 201, `Expected 201 (no register requirement for a transfer), got ${status}: ${JSON.stringify(body)}`);
  createdSalaryIds.push(body.data.id);
  if (body.data.expense_id) createdExpenseIds.push(body.data.expense_id);
});
```

- [ ] **Step 5: Run it**

Run: `cd server && VERIFY_OWNER_PHONE=<owner phone> VERIFY_OWNER_PASSWORD=<owner password> node scripts/verify-attendance-payroll.js`
Expected: `17/17 checks passed`

- [ ] **Step 6: Commit**

```bash
git add server/routes/staff-management.js server/routes/expenses.js server/scripts/verify-attendance-payroll.js
git commit -m "POST /staff/payroll/disburse: expense-first write ordering, cash-only register guard, capped advance deduction"
```

---

### Task 10: Salary advance approval gets the same expense/register linkage as disbursement

**Files:**
- Modify: `server/routes/attendance.js` (imports, `PUT /salary-advance/:id/:action`)
- Modify: `server/scripts/verify-attendance-payroll.js` (append checks)

**Interfaces:**
- Consumes: `hasOpenRegister`, `REGISTER_CLOSED_MESSAGE` from `register-guard.js`; `todayStr` (already imported at the top of this file).
- Produces: approving an advance now writes a linked `expenses` row and adjusts the register, mirroring Task 9.

`salary_advances` has no `payment_method` column (confirmed against the live DB — `\d salary_advances`), and the request-advance flow never asks for one. Advances are always handed over as physical cash at this shop (there's no UPI/bank path for one anywhere in the data model today), so approval is treated as an unconditional cash write — same register-guard rule as any other cash route, no new field or UI needed to make that determination.

- [ ] **Step 1: Add imports**

Near the top of `server/routes/attendance.js`:
```js
const { hasOpenRegister, REGISTER_CLOSED_MESSAGE } = require('../utils/register-guard');
```

- [ ] **Step 2: Rewrite the approve/reject route**

Replace the existing `PUT /salary-advance/:id/:action` handler (around line 722-757):

```js
router.put('/salary-advance/:id/:action', authorize('owner', 'manager'), (req, res) => {
  try {
    const db = getDb();
    const { id, action } = req.params;

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ success: false, message: 'Invalid action.' });
    }

    const advance = db.prepare('SELECT * FROM salary_advances WHERE id = ?').get(id);
    if (!advance) {
      return res.status(404).json({ success: false, message: 'Advance not found.' });
    }

    if (advance.status !== 'pending') {
      return res.status(400).json({ success: false, message: `Cannot ${action} a ${advance.status} advance.` });
    }

    if (action === 'reject') {
      db.prepare('UPDATE salary_advances SET status = ?, approved_by = ? WHERE id = ?')
        .run('rejected', req.user.id, id);
      const rejected = db.prepare(`
        SELECT sa.*, u.name as user_name, a.name as approver_name
        FROM salary_advances sa JOIN users u ON sa.user_id = u.id LEFT JOIN users a ON sa.approved_by = a.id
        WHERE sa.id = ?
      `).get(id);
      return res.json({ success: true, data: rejected });
    }

    // action === 'approve' — cash physically leaves the drawer here, same
    // as any other cash expense (see this task's header on why there's no
    // payment-method branch: advances have no other path in this data
    // model today).
    const employeeLocation = db.prepare(
      'SELECT location_id FROM user_locations WHERE user_id = ? ORDER BY is_primary DESC, id ASC LIMIT 1'
    ).get(advance.user_id);
    const locationId = employeeLocation ? employeeLocation.location_id : null;

    if (!locationId) {
      return res.status(400).json({ success: false, message: "This employee isn't assigned to a location yet — assign one before approving an advance." });
    }
    if (!hasOpenRegister(db, locationId)) {
      return res.status(400).json({ success: false, message: `The cash drawer isn't open at this employee's location — open the register first to hand over an advance.` });
    }

    const approveTx = db.transaction(() => {
      const openRegister = db.prepare('SELECT id FROM cash_registers WHERE location_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1').get(locationId);
      const advanceUser = db.prepare('SELECT name FROM users WHERE id = ?').get(advance.user_id);

      // Expense written first — see Task 9's header note on why write
      // ordering, not db.transaction(), is what protects against a
      // half-done write here.
      const expenseResult = db.prepare(`
        INSERT INTO expenses (location_id, category, amount, description, payment_method, expense_date, created_by, employee_id, register_id)
        VALUES (?, 'salary', ?, ?, 'cash', ?, ?, ?, ?)
      `).run(
        locationId, advance.amount,
        `Salary advance — ${advanceUser ? advanceUser.name : 'employee'}`,
        todayStr(), req.user.id, advance.user_id,
        openRegister ? openRegister.id : null
      );

      if (openRegister) {
        db.prepare('UPDATE cash_registers SET expected_cash = expected_cash - ? WHERE id = ?').run(advance.amount, openRegister.id);
      }

      db.prepare('UPDATE salary_advances SET status = ?, approved_by = ? WHERE id = ?').run('approved', req.user.id, id);

      return expenseResult.lastInsertRowid;
    });

    approveTx();

    const updated = db.prepare(`
      SELECT sa.*, u.name as user_name, a.name as approver_name
      FROM salary_advances sa JOIN users u ON sa.user_id = u.id LEFT JOIN users a ON sa.approved_by = a.id
      WHERE sa.id = ?
    `).get(id);

    res.json({ success: true, data: updated });
  } catch (error) {
    console.error('Approve/reject advance error:', error);
    res.status(500).json({ success: false, message: `Failed to ${req.params.action} advance.` });
  }
});
```

- [ ] **Step 3: Append the checks**

```javascript
check('PUT /attendance/salary-advance/:id/approve requires an open register and writes a linked expense', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const requestRes = await api('POST', '/attendance/salary-advance', florist.token, { amount: 2000, reason: 'Verify harness test' });
  assert(requestRes.status === 201, `Could not request advance: ${requestRes.status}`);
  createdAdvanceIds.push(requestRes.body.data.id);

  const blocked = await api('PUT', `/attendance/salary-advance/${requestRes.body.data.id}/approve`, owner.token);
  assert(blocked.status === 400, `Expected 400 with no open register, got ${blocked.status}`);

  const initialStatus = await api('GET', `/sales/register/status?location_id=${TEST_LOCATION_ID}`, owner.token);
  if (initialStatus.body?.isOpen) {
    await api('PUT', '/sales/register/close', owner.token, { location_id: TEST_LOCATION_ID, actual_cash: Number(initialStatus.body.data.expected_cash) || 0 });
  }
  await api('POST', '/sales/register/open', owner.token, { location_id: TEST_LOCATION_ID, opening_balance: 5000 });
  const before = await api('GET', `/sales/register/status?location_id=${TEST_LOCATION_ID}`, owner.token);
  const expectedBefore = Number(before.body.data.expected_cash);

  const { status, body } = await api('PUT', `/attendance/salary-advance/${requestRes.body.data.id}/approve`, owner.token);
  assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert(body.data.status === 'approved', `Expected status 'approved', got '${body.data.status}'`);

  const db = await getDb();
  const expense = await db.prepare('SELECT * FROM expenses WHERE employee_id = ? AND category = ? ORDER BY id DESC LIMIT 1').get(florist.id, 'salary');
  assert(expense, 'Expected a linked expense row to exist');
  assert(Number(expense.amount) === 2000, `Expected expense amount 2000, got ${expense.amount}`);
  createdExpenseIds.push(expense.id);

  const after = await api('GET', `/sales/register/status?location_id=${TEST_LOCATION_ID}`, owner.token);
  const expectedAfter = Number(after.body.data.expected_cash);
  assert(Math.abs((expectedBefore - 2000) - expectedAfter) < 0.01, `Expected register to drop by 2000, went from ${expectedBefore} to ${expectedAfter}`);

  await api('PUT', '/sales/register/close', owner.token, { location_id: TEST_LOCATION_ID, actual_cash: expectedAfter });
});
```

- [ ] **Step 4: Run it**

Run: `cd server && VERIFY_OWNER_PHONE=<owner phone> VERIFY_OWNER_PASSWORD=<owner password> node scripts/verify-attendance-payroll.js`
Expected: `18/18 checks passed`

- [ ] **Step 5: Commit**

```bash
git add server/routes/attendance.js server/scripts/verify-attendance-payroll.js
git commit -m "PUT /attendance/salary-advance/:id/approve: register-guard + linked expense, same treatment as disbursement"
```

---

### Task 11: Geofence auto-clock-in — fix the segment bug on this path, fix the re-open guard, add a proximity check and a notification

**Files:**
- Modify: `server/routes/staff-management.js:1-6` (imports), `:283-346` (`/geofence-event`)
- Modify: `server/scripts/verify-attendance-payroll.js` (append checks)

**Interfaces:**
- Consumes: `normalizeSegments`, `matchSegmentForTime`, `lateMinutesFor`, `timestampToMinutes` from `shift-work.js`; `createNotification` from `notifications.js`; `todayStr` (Task 9's import, same file).
- Produces: `POST /staff/geofence-event`'s success response for an `enter` event now includes `attendance_id` explicitly (an earlier draft's harness assumed `data.id` WAS the attendance id — it is not, `data` is the `geofence_events` row, and that id range collides with real attendance ids on the live dev DB). Consumed by Task 12 (undo endpoint) and its own tests.

**Three real bugs fixed here, not just the notification addition an earlier draft focused on:**
1. **Bug #3 was never actually fixed on this path.** An earlier draft of this task left the auto-clock-in's own late-detection exactly as it was — `late = clockTime > shift.shift_start ? 1 : 0` — which is the original bug, still comparing every arrival against a single `shift_start` regardless of which segment it's for. Since auto-clock-in is the *normal* arrival path once geofencing works, this meant the primary path kept the exact bug the whole redesign exists to fix. Now routed through the same `shift-work.js` helpers Task 5 already wired into the manual path.
2. **A split-shift employee's second segment could never auto-clock-in at all.** The original guard fetched `.get()` — the first row of the day, not the most recent or open one — and its "reopen" branch (`existing.clock_out && !existing.clock_in`) is unreachable given how rows are actually written. In practice this meant geofence auto-clock-in fires at most once per day. Now matches `POST /clock-in`'s own "is there an open session" check exactly, so a second segment opens its own new row the same way a manual second clock-in does.
3. **No server-side proximity check at all.** `POST /staff/geofence-event` trusted the client's claimed coordinates completely — any authenticated staff member could `POST` a fake `enter` event from anywhere and be auto-clocked-in. Now recomputes the distance server-side against the location's own coordinates (real precision as of Task 2) and its `geofence_radius`, and refuses to auto-clock-in (falling back to "please use Clock In instead") if it can't verify proximity, rather than trusting an unverifiable claim.

- [ ] **Step 1: Add imports**

Near the top of `server/routes/staff-management.js`:
```js
const { normalizeSegments, matchSegmentForTime, lateMinutesFor, timestampToMinutes } = require('../utils/shift-work');
const { createNotification } = require('./notifications');
```
(`todayStr` already imported per Task 9.)

- [ ] **Step 2: Rewrite the route**

Replace the entire `POST /geofence-event` handler (lines 283-346):

```js
// Haversine distance in meters — a local copy rather than importing
// delivery-tracking.js's own (kilometers, a different unit, and not
// exported) — matches geofence_radius's stored unit (meters) directly.
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

router.post('/geofence-event', authorize('manager', 'employee', 'counter_staff', 'florist_staff', 'delivery_partner'), (req, res) => {
  try {
    const db = getDb();
    const { location_id, event_type, latitude, longitude } = req.body;

    if (!location_id || !event_type || !['enter', 'exit'].includes(event_type)) {
      return res.status(400).json({ success: false, message: 'location_id and valid event_type (enter/exit) required.' });
    }

    const result = db.prepare(`
      INSERT INTO geofence_events (user_id, location_id, event_type, latitude, longitude)
      VALUES (?, ?, ?, ?, ?)
    `).run(req.user.id, location_id, event_type, latitude || null, longitude || null);

    const event = db.prepare('SELECT * FROM geofence_events WHERE id = ?').get(result.lastInsertRowid);

    if (event_type === 'enter') {
      // Proximity check — refuse to auto clock in if we can't verify this
      // claim server-side, rather than trusting the client's coordinates.
      const location = db.prepare('SELECT latitude, longitude, geofence_radius FROM locations WHERE id = ?').get(location_id);
      if (!location || location.latitude == null || location.longitude == null || latitude == null || longitude == null) {
        return res.json({ success: true, data: event, action: 'unverified', message: 'Could not verify your location — use Clock In instead.' });
      }
      const distance = haversineMeters(Number(location.latitude), Number(location.longitude), Number(latitude), Number(longitude));
      if (distance > (location.geofence_radius || 500)) {
        return res.json({ success: true, data: event, action: 'out_of_range', message: 'You do not appear to be at this location.' });
      }

      const today = todayStr();
      const openSession = db.prepare('SELECT id FROM attendance WHERE user_id = ? AND date = ? AND clock_out IS NULL').get(req.user.id, today);

      if (!openSession) {
        const now = nowLocal();
        const shift = db.prepare('SELECT shift_start, shift_end, shift_segments FROM employee_shifts WHERE user_id = ? AND location_id = ? AND is_active = 1').get(req.user.id, location_id);
        let late = 0;
        if (shift && (shift.shift_start || shift.shift_segments)) {
          const segments = normalizeSegments(shift.shift_start, shift.shift_end, shift.shift_segments);
          const clockInMinutes = timestampToMinutes(now);
          const segment = matchSegmentForTime(clockInMinutes, segments);
          late = lateMinutesFor(clockInMinutes, segment) > 0 ? 1 : 0;
        }

        const insertResult = db.prepare(`
          INSERT INTO attendance (user_id, location_id, date, clock_in, clock_in_method, clock_in_latitude, clock_in_longitude, late_arrival, status)
          VALUES (?, ?, ?, ?, 'auto_geofence', ?, ?, ?, 'present')
        `).run(req.user.id, location_id, today, now, latitude || null, longitude || null, late);
        const attendanceId = insertResult.lastInsertRowid;

        db.prepare('UPDATE geofence_events SET processed = 1, auto_action = ? WHERE id = ?').run('clock_in', event.id);

        const locationRow = db.prepare('SELECT name FROM locations WHERE id = ?').get(location_id);
        const friendlyTime = new Intl.DateTimeFormat('en-IN', {
          timeZone: require('../utils/time').getTimezone(), hour: 'numeric', minute: '2-digit', hour12: true,
        }).format(new Date(now));
        createNotification({
          userIds: req.user.id,
          title: 'Clocked in automatically',
          body: `${locationRow ? locationRow.name : 'Shop'}, ${friendlyTime} — not working? Tap to undo.`,
          type: 'attendance_auto_clockin',
          data: { screen: 'Attendance', attendanceId, action: 'undo_auto_clockin' },
        }).catch(() => {});

        // attendance_id is returned EXPLICITLY — `data` above is the
        // geofence_events row, not the attendance row, and their id ranges
        // can collide (confirmed on the live dev DB: geofence_events was
        // empty, so its sequence starts at 1, squarely inside real
        // attendance's id range). Any caller needing the attendance row
        // must use this field, never `data.id`.
        return res.json({ success: true, data: event, attendance_id: attendanceId, action: 'auto_clock_in' });
      }
    }

    if (event_type === 'exit') {
      db.prepare('UPDATE geofence_events SET processed = 0 WHERE id = ?').run(event.id);
      return res.json({ success: true, data: event, action: 'exit_recorded' });
    }

    res.json({ success: true, data: event });
  } catch (error) {
    console.error('Geofence event error:', error);
    res.status(500).json({ success: false, message: 'Failed to record geofence event.' });
  }
});
```

- [ ] **Step 3: Append the checks**

```javascript
check('POST /staff/geofence-event (enter) rejects an out-of-range claim rather than trusting it', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const { status, body } = await api('POST', '/staff/geofence-event', florist.token, {
    location_id: TEST_LOCATION_ID, event_type: 'enter', latitude: 12.9716, longitude: 77.5946, // Bangalore, nowhere near the shop
  });
  assert(status === 200, `Expected 200 (a rejected claim, not an error), got ${status}`);
  assert(body.action !== 'auto_clock_in', `Expected the out-of-range claim to NOT trigger auto clock-in, got action='${body.action}'`);
});

check('POST /staff/geofence-event (enter, in range) auto clocks in, returns attendance_id explicitly, and creates a notification', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const db = await getDb();
  const location = await db.prepare('SELECT latitude, longitude FROM locations WHERE id = ?').get(TEST_LOCATION_ID);
  if (!location?.latitude) {
    console.log('   (skipped — Test Loc has no coordinates yet; this check needs Task 2\'s precision fix plus real coordinates entered)');
    return;
  }
  const { status, body } = await api('POST', '/staff/geofence-event', florist.token, {
    location_id: TEST_LOCATION_ID, event_type: 'enter', latitude: Number(location.latitude), longitude: Number(location.longitude),
  });
  assert(status === 200, `Expected 200, got ${status}`);
  assert(body.action === 'auto_clock_in', `Expected action 'auto_clock_in', got '${body.action}'`);
  assert(typeof body.attendance_id === 'number', 'Expected an explicit attendance_id, distinct from data.id (the geofence_events row)');
  createdAttendanceIds.push(body.attendance_id);

  const { body: today } = await api('GET', '/attendance/today', florist.token);
  assert(today.data.attendance?.id === body.attendance_id, 'Expected the returned attendance_id to match the actual open session');

  const { body: notifs } = await api('GET', '/notifications', florist.token);
  const found = notifs.data.notifications.find((n) => n.type === 'attendance_auto_clockin');
  assert(found, 'Expected a notification of type attendance_auto_clockin');
});
```

- [ ] **Step 4: Run it**

Run: `cd server && VERIFY_OWNER_PHONE=<owner phone> VERIFY_OWNER_PASSWORD=<owner password> node scripts/verify-attendance-payroll.js`
Expected: `20/20 checks passed` (the second check above may self-skip with a logged note if `Test Loc` still has no real coordinates entered — that's expected until the operational follow-up from Task 2 happens, not a failure).

- [ ] **Step 5: Commit**

```bash
git add server/routes/staff-management.js server/scripts/verify-attendance-payroll.js
git commit -m "Geofence auto-clock-in: fix bug #3 on this path, fix the re-open guard, add server-side proximity check + notification"
```

---

### Task 12: `POST /attendance/:id/undo-auto-clockin` — bounded to 15 minutes

**Files:**
- Modify: `server/routes/attendance.js` (new route, after `POST /clock-out`)
- Modify: `server/scripts/verify-attendance-payroll.js` (append checks)

**Interfaces:**
- Produces: `POST /api/attendance/:id/undo-auto-clockin`. Consumed by `api.js`'s `undoAutoClockIn(id)` in Task 15.

**Corrected from an earlier draft**, which offered this with no time bound at all — the review found the undo banner would render for the ENTIRE duration of an auto-clocked-in session (hours), and one tap would hard-`DELETE` a whole day's worked attendance with no confirmation dialog, justified on the grounds that it was "low-stakes and reversible." It is neither, past the first few minutes. Bounded to 15 minutes from the actual `clock_in` timestamp now — long enough for "I walked past the shop and it fired by mistake," not long enough to silently erase real work.

- [ ] **Step 1: Add the route**

In `server/routes/attendance.js`, immediately after `POST /clock-out` (after line 199):

```js
const UNDO_AUTO_CLOCKIN_WINDOW_MINUTES = 15;

// ═══════════════════════════════════════════════════════════════
// UNDO AN AUTOMATIC (GEOFENCE) CLOCK-IN — bounded to 15 minutes
// ═══════════════════════════════════════════════════════════════
// Only undoes a record that was actually auto-created by geofence entry,
// is still open (no clock_out — if they've since clocked out, whatever
// they did while "in" is real work, not a mis-fire), AND is within 15
// minutes of the clock-in itself. Past that window this deliberately
// refuses rather than silently deleting a real day's attendance on one
// tap with no confirmation — see this task's header.
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
    const clockInDate = parseServerDate(record.clock_in);
    const minutesSinceClockIn = clockInDate ? (Date.now() - clockInDate.getTime()) / 60000 : Infinity;
    if (minutesSinceClockIn > UNDO_AUTO_CLOCKIN_WINDOW_MINUTES) {
      return res.status(400).json({ success: false, message: `This can only be undone within ${UNDO_AUTO_CLOCKIN_WINDOW_MINUTES} minutes of clocking in — ask a manager to fix it from here instead.` });
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
check('POST /attendance/:id/undo-auto-clockin deletes an open auto-geofence session within the window', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const db = await getDb();
  const location = await db.prepare('SELECT latitude, longitude FROM locations WHERE id = ?').get(TEST_LOCATION_ID);
  if (!location?.latitude) { console.log('   (skipped — Test Loc has no coordinates)'); return; }
  const geo = await api('POST', '/staff/geofence-event', florist.token, {
    location_id: TEST_LOCATION_ID, event_type: 'enter', latitude: Number(location.latitude), longitude: Number(location.longitude),
  });
  assert(geo.body.action === 'auto_clock_in', `Setup failed — expected auto_clock_in, got '${geo.body.action}'`);

  const { status, body } = await api('POST', `/attendance/${geo.body.attendance_id}/undo-auto-clockin`, florist.token);
  assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);

  const { body: today } = await api('GET', '/attendance/today', florist.token);
  assert(today.data.attendance === null, 'Expected no active attendance record after undo');
});

check('POST /attendance/:id/undo-auto-clockin refuses past the 15-minute window', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const db = await getDb();
  const location = await db.prepare('SELECT latitude, longitude FROM locations WHERE id = ?').get(TEST_LOCATION_ID);
  if (!location?.latitude) { console.log('   (skipped — Test Loc has no coordinates)'); return; }
  const geo = await api('POST', '/staff/geofence-event', florist.token, {
    location_id: TEST_LOCATION_ID, event_type: 'enter', latitude: Number(location.latitude), longitude: Number(location.longitude),
  });
  createdAttendanceIds.push(geo.body.attendance_id);
  // Backdate the clock-in 20 minutes, simulating time having passed —
  // same technique verify-register-expenses.js's own backdateToYesterday
  // uses.
  await db.prepare("UPDATE attendance SET clock_in = clock_in - INTERVAL '20 minutes' WHERE id = ?").run(geo.body.attendance_id);

  const { status } = await api('POST', `/attendance/${geo.body.attendance_id}/undo-auto-clockin`, florist.token);
  assert(status === 400, `Expected 400 past the 15-minute window, got ${status}`);

  await api('POST', '/attendance/clock-out', florist.token, { method: 'manual' });
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

Run: `cd server && VERIFY_OWNER_PHONE=<owner phone> VERIFY_OWNER_PASSWORD=<owner password> node scripts/verify-attendance-payroll.js`
Expected: `23/23 checks passed` (minus any self-skipped for missing Test Loc coordinates, logged not failed).

- [ ] **Step 4: Commit**

```bash
git add server/routes/attendance.js server/scripts/verify-attendance-payroll.js
git commit -m "Add POST /attendance/:id/undo-auto-clockin, bounded to 15 minutes"
```

---

### Task 13: `POST /attendance/missed-clock-in` — deduplicated once per person per day

**Files:**
- Modify: `server/routes/attendance.js` (new route, after Task 12's route)
- Modify: `server/scripts/verify-attendance-payroll.js` (append checks)

**Interfaces:**
- Consumes: `notifyByRole` from `notifications.js`.
- Produces: `POST /api/attendance/missed-clock-in`. Consumed by `api.js`'s `reportMissedClockIn(data)` in Task 15.

**Corrected from an earlier draft**, which had no dedup at all — `missedClockInSent` was only component state, resetting on every screen remount, so a confused employee could notify every manager repeatedly. Deduplicated server-side, once per person per calendar day, using the `notifications` table's own `data` field (stored as `text`, cast to `jsonb` for the lookup — the column already always holds valid JSON since it's written via `JSON.stringify`).

- [ ] **Step 1: Add the route**

In `server/routes/attendance.js`, immediately after Task 12's `undo-auto-clockin` route:

```js
// ═══════════════════════════════════════════════════════════════
// REPORT A MISSED CLOCK-IN (employee self-service recovery)
// ═══════════════════════════════════════════════════════════════
// Doesn't create any attendance record itself — a manager still does that
// (the one-tap roster action, Task 17) — this only closes the "how do they
// even find out" gap. Deduplicated: at most one notification per person
// per calendar day, so a confused employee can't spam every manager.
router.post('/missed-clock-in', authorize('owner', 'manager', 'employee', 'counter_staff', 'florist_staff', 'delivery_partner'), async (req, res) => {
  try {
    const db = getDb();
    const { location_id } = req.body;
    if (!location_id) {
      return res.status(400).json({ success: false, message: 'Location is required.' });
    }

    const today = todayStr();
    const alreadySent = db.prepare(
      "SELECT id FROM notifications WHERE type = 'attendance_missed_clockin' AND (data::jsonb->>'userId')::int = ? AND created_at::date = ?"
    ).get(req.user.id, today);
    if (alreadySent) {
      return res.json({ success: true, message: 'Your manager has already been notified today.', already_sent: true });
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

- [ ] **Step 2: Append the checks**

```javascript
check('POST /attendance/missed-clock-in notifies owner/manager and deduplicates within the same day', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);

  const first = await api('POST', '/attendance/missed-clock-in', florist.token, { location_id: TEST_LOCATION_ID });
  assert(first.status === 200, `Expected 200, got ${first.status}`);
  assert(!first.body.already_sent, 'Expected the first call to actually send');

  const { body: notifs } = await api('GET', '/notifications', owner.token);
  const matching = notifs.data.notifications.filter((n) => n.type === 'attendance_missed_clockin' && n.body.includes('Verify Florist'));
  assert(matching.length === 1, `Expected exactly 1 notification, got ${matching.length}`);

  const second = await api('POST', '/attendance/missed-clock-in', florist.token, { location_id: TEST_LOCATION_ID });
  assert(second.status === 200, `Expected 200, got ${second.status}`);
  assert(second.body.already_sent === true, 'Expected the second same-day call to be deduplicated');

  const { body: notifsAfter } = await api('GET', '/notifications', owner.token);
  const matchingAfter = notifsAfter.data.notifications.filter((n) => n.type === 'attendance_missed_clockin' && n.body.includes('Verify Florist'));
  assert(matchingAfter.length === 1, `Expected still exactly 1 notification after the deduplicated second call, got ${matchingAfter.length}`);
});
```

- [ ] **Step 3: Run it**

Run: `cd server && VERIFY_OWNER_PHONE=<owner phone> VERIFY_OWNER_PASSWORD=<owner password> node scripts/verify-attendance-payroll.js`
Expected: `24/24 checks passed` (minus any self-skipped).

- [ ] **Step 4: Commit**

```bash
git add server/routes/attendance.js server/scripts/verify-attendance-payroll.js
git commit -m "Add POST /attendance/missed-clock-in, deduplicated once per person per day"
```

---

### Task 14: Clock-out recovery sweep (new scope) + fix the existing cron's own timestamp bug

**Files:**
- Modify: `server/server.js:1-43` (imports), `:185-247` (the geofence-timeout `setInterval`)
- Modify: `server/scripts/verify-attendance-payroll.js` (append check)

**Interfaces:**
- Consumes: `normalizeSegments`, `timestampToMinutes` from `shift-work.js`; `todayStr`, `parseServerDate`, `getTimezone` from `server/utils/time.js`.
- Produces: attendance rows still open well past their shift can now close themselves, marked `clock_out_method = 'auto_shift_end'`, visible on the manager roster (Task 17).

**Two real bugs fixed in the EXISTING cron while touching this file, found during review — not the new sweep itself:**
1. `const totalHours = clockIn ? Math.max(0, (new Date(now) - new Date(clockIn)) / (1000 * 60 * 60)) : 0;` parses `clockIn` (read via the sync `getDb()` layer, a timezone-naive string) with a bare `new Date()` — the exact class of bug fixed everywhere else in this plan, here specifically overstating recorded hours by the offset between the server process's machine timezone and the shop's. Fixed with `parseServerDate`.
2. `today` is computed from `new Date().getFullYear()`/`getMonth()`/`getDate()` — the server PROCESS's local calendar date, not the shop's. Near midnight, if these differ, the query looks at the wrong day's attendance entirely. Fixed with `todayStr()`.

**Why the sweep matters more than the clock-in-side fixes this plan otherwise focuses on:** the live dev DB has 6 attendance sessions still open, one since June — direct evidence that "forgot to clock in" (this redesign's original focus) is not the dominant real failure; "forgot to clock out, and the phone stopped running its background task before the exit-timeout cron above could ever see an exit event" is. This sweep needs no geofence activity at all to fire.

- [ ] **Step 1: Add imports**

Near the top of `server/server.js`, alongside the existing route imports:
```js
const { todayStr, parseServerDate, getTimezone } = require('./utils/time');
const { normalizeSegments, timestampToMinutes } = require('./utils/shift-work');
```

- [ ] **Step 2: Fix the existing cron's two bugs and add the new sweep**

Replace the entire `setInterval` block (lines 185-247):

```js
  // ─── Geofence timeout auto clock-out (check every 60 seconds) ──
  const CLOCKOUT_SWEEP_GRACE_HOURS = 4; // hours past the last matched shift-segment end before auto-closing
  const CLOCKOUT_SWEEP_FALLBACK_HOURS = 16; // no shift configured at all — flat safety net
  setInterval(() => {
    try {
      const db = getDb();
      const today = todayStr();

      // ── Part 1: existing geofence-exit-triggered timeout (unchanged
      // in intent, two real bugs fixed — see this task's header) ──
      const exitEvents = db.prepare(`
        SELECT ge.*, es.geofence_timeout_minutes,
               a.id as attendance_id, a.clock_in, a.clock_out
        FROM geofence_events ge
        JOIN employee_shifts es ON ge.user_id = es.user_id AND ge.location_id = es.location_id AND es.is_active = 1
        LEFT JOIN attendance a ON a.user_id = ge.user_id AND a.date = ?
        WHERE ge.event_type = 'exit' AND ge.processed = 0
        AND ge.created_at + (es.geofence_timeout_minutes * INTERVAL '1 minute') <= NOW()
        AND a.clock_in IS NOT NULL AND a.clock_out IS NULL
      `).all(today);

      for (const event of exitEvents) {
        const reenter = db.prepare(`
          SELECT id FROM geofence_events
          WHERE user_id = ? AND location_id = ? AND event_type = 'enter'
          AND created_at > ?
          LIMIT 1
        `).get(event.user_id, event.location_id, event.created_at);

        if (reenter) {
          db.prepare('UPDATE geofence_events SET processed = 1, auto_action = ? WHERE id = ?').run('cancelled_returned', event.id);
          continue;
        }

        const activeOutdoor = db.prepare(`
          SELECT id FROM outdoor_duty_requests
          WHERE user_id = ? AND attendance_id = ? AND status IN ('approved', 'requested')
        `).get(event.user_id, event.attendance_id);

        if (activeOutdoor) continue;

        const nowDate = new Date();
        const now = nowDate.toISOString();
        const clockInDate = parseServerDate(event.clock_in);
        const totalHours = clockInDate ? Math.max(0, (nowDate.getTime() - clockInDate.getTime()) / (1000 * 60 * 60)) : 0;

        db.prepare(`
          UPDATE attendance SET clock_out = ?, clock_out_method = 'auto_timeout',
          total_hours = ?, effective_hours = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(now, Math.round(totalHours * 100) / 100, Math.round(totalHours * 100) / 100, event.attendance_id);

        db.prepare('UPDATE geofence_events SET processed = 1, auto_action = ? WHERE id = ?').run('auto_clock_out', event.id);

        console.log(`⏰ Auto clock-out: user ${event.user_id} after ${event.geofence_timeout_minutes}min geofence timeout`);
      }

      // ── Part 2: clock-out recovery sweep (new) — catches sessions with
      // NO geofence activity at all, e.g. the phone died or the app was
      // force-quit before any exit event could fire. Needs no join to
      // geofence_events. ──
      const openSessions = db.prepare(`
        SELECT a.*, es.shift_start, es.shift_end, es.shift_segments
        FROM attendance a
        LEFT JOIN employee_shifts es ON es.user_id = a.user_id AND es.location_id = a.location_id AND es.is_active = 1
        WHERE a.clock_out IS NULL
      `).all();

      for (const session of openSessions) {
        const clockInDate = parseServerDate(session.clock_in);
        if (!clockInDate) continue;

        let estimatedEndEpoch = null; // best-guess "should have left by" instant
        const segments = normalizeSegments(session.shift_start, session.shift_end, session.shift_segments);
        const clockInMinutesOfDay = timestampToMinutes(session.clock_in);
        if (segments.length > 0 && clockInMinutesOfDay != null) {
          const lastSegmentEndMinutes = Math.max(...segments.map((s) => s.end));
          // Anchor to shop-timezone midnight of the clock-in's own day via
          // epoch arithmetic (avoids constructing a Date with an explicit
          // UTC-offset string, which Intl doesn't hand back directly).
          const shopMidnightEpoch = clockInDate.getTime() - clockInMinutesOfDay * 60000;
          estimatedEndEpoch = shopMidnightEpoch + lastSegmentEndMinutes * 60000;
        }

        const closeAfterEpoch = estimatedEndEpoch != null
          ? estimatedEndEpoch + CLOCKOUT_SWEEP_GRACE_HOURS * 60 * 60 * 1000
          : clockInDate.getTime() + CLOCKOUT_SWEEP_FALLBACK_HOURS * 60 * 60 * 1000;

        if (Date.now() < closeAfterEpoch) continue; // not due yet

        // Record the estimated shift-end time as the clock-out when one
        // was available — closer to reality than "whenever this cron tick
        // happened to run," which could be hours after the grace window
        // opened. Fallback path (no shift) has nothing better than now.
        const clockOutEpoch = estimatedEndEpoch != null ? estimatedEndEpoch : Date.now();
        const clockOutIso = new Date(clockOutEpoch).toISOString();
        const totalHours = Math.max(0, (clockOutEpoch - clockInDate.getTime()) / (1000 * 60 * 60));

        db.prepare(`
          UPDATE attendance SET clock_out = ?, clock_out_method = 'auto_shift_end',
          total_hours = ?, effective_hours = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(clockOutIso, Math.round(totalHours * 100) / 100, Math.round(totalHours * 100) / 100, session.id);

        console.log(`⏰ Clock-out sweep: closed session ${session.id} for user ${session.user_id}, open since ${session.clock_in}`);
      }
    } catch (e) {
      // Silent — don't crash the server for cron errors
    }
  }, 60 * 1000);
```

- [ ] **Step 3: Append the check**

This exercises the sweep's fallback path directly against the DB (the shift-based path is covered by `verify-shift-work.js`'s own fixtures for the underlying math; this check confirms the cron's query and update actually fire):

```javascript
check('Clock-out sweep closes a session open well past the fallback window (no shift configured)', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const clockIn = await api('POST', '/attendance/clock-in', florist.token, { location_id: TEST_LOCATION_ID, method: 'manual' });
  const attendanceId = clockIn.body.data.id;
  createdAttendanceIds.push(attendanceId);

  const db = await getDb();
  // Backdate 18 hours — past the 16-hour no-shift fallback window.
  await db.prepare("UPDATE attendance SET clock_in = clock_in - INTERVAL '18 hours' WHERE id = ?").run(attendanceId);

  // The sweep runs on a 60s server-process interval — wait for one tick
  // rather than trying to invoke it directly (it's not exported; this is
  // an integration check of the real running process, matching how this
  // codebase's other cron-dependent behavior gets verified live).
  await new Promise((resolve) => setTimeout(resolve, 65000));

  const updated = await db.prepare('SELECT * FROM attendance WHERE id = ?').get(attendanceId);
  assert(updated.clock_out !== null, 'Expected the sweep to have closed this session');
  assert(updated.clock_out_method === 'auto_shift_end', `Expected clock_out_method 'auto_shift_end', got '${updated.clock_out_method}'`);
});
```

- [ ] **Step 4: Run it**

Run: `cd server && VERIFY_OWNER_PHONE=<owner phone> VERIFY_OWNER_PASSWORD=<owner password> node scripts/verify-attendance-payroll.js`

This specific check needs the actual dev server (`node server.js`) running in the background for its cron to fire — start it first if it isn't already. Expected: `25/25 checks passed` (this check takes over a minute by design — the harness's total runtime grows accordingly; acceptable for a check that's exercising a real timer, not something to fake by hand).

- [ ] **Step 5: Commit**

```bash
git add server/server.js server/scripts/verify-attendance-payroll.js
git commit -m "Add clock-out recovery sweep; fix the existing geofence-timeout cron's own timestamp and today-date bugs"
```

---

### Task 15: `api.js` — two new methods

**Files:**
- Modify: `app/src/services/api.js` (add near the existing Attendance methods, after `getTodayAttendance`)

**Interfaces:**
- Produces: `api.undoAutoClockIn(attendanceId)`, `api.reportMissedClockIn({ location_id })` — consumed by `AttendanceScreen.js` in Task 16.

- [ ] **Step 1: Add the methods**

Right after the existing `getTodayAttendance()` method:

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

### Task 16: `AttendanceScreen.js` — undo-able auto-clock-in banner, own late/overtime visibility, missed-clock-in recovery

**Files:**
- Modify: `app/src/screens/AttendanceScreen.js`
- Modify: `app/src/hooks/usePushNotifications.js`

**Interfaces:**
- Consumes: `data.lateMinutesToday`/`data.overtimeMinutesToday` from `GET /attendance/today` (Task 6); `api.undoAutoClockIn`/`api.reportMissedClockIn` (Task 15); `api.getShifts()` (existing); the `{ screen: 'Attendance', attendanceId, action: 'undo_auto_clockin' }` notification payload (Task 11).

**Two corrections from the review, both applied here:**
1. **Wording.** "into overtime" / "OT" is jargon for someone who's never used business software. Rewritten in plain terms — worked time past the shift, not "overtime."
2. **Placement and gating of the missed-clock-in link.** An earlier draft rendered it ABOVE the primary Clock In button, competing with it (`staff-ux-checklist` #2 — one primary action per screen), and showed it immediately at any time of day, including before the person's shift had even started. Now below the button, visually de-emphasized, and gated on actually being past the person's own shift start (fetched once via the existing `api.getShifts()` — if they have no shift configured, the gate defaults open rather than silently hiding a real feature).

- [ ] **Step 1: Add state and fetch the two new fields + the user's own shift start**

Add near the existing `useState` calls (around line 39-49):
```js
  const [lateMinutesToday, setLateMinutesToday] = useState(0);
  const [overtimeMinutesToday, setOvertimeMinutesToday] = useState(0);
  const [missedClockInSent, setMissedClockInSent] = useState(false);
  const [myShiftStart, setMyShiftStart] = useState(null);
```

In `fetchData`, right after `setActiveOutdoor(todayRes.data?.activeOutdoor || null);` (around line 71):
```js
      setLateMinutesToday(todayRes.data?.lateMinutesToday || 0);
      setOvertimeMinutesToday(todayRes.data?.overtimeMinutesToday || 0);
      if (!isManagerOrOwner) {
        api.getShifts().then((res) => setMyShiftStart((res.data || [])[0]?.shift_start || null)).catch(() => {});
      }
```

- [ ] **Step 2: Add the undo, missed-clock-in, and time-gating helpers**

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
      const res = await api.reportMissedClockIn({ location_id: locationId });
      setMissedClockInSent(true);
      if (res.data?.already_sent) {
        // Server-side dedup already covered this today — still show the
        // "sent" state locally so the link disappears either way.
      }
    } catch (e) {
      Alert.alert('Error', e.message || 'Could not send that — try again.');
    } finally {
      setActionLoading(false);
    }
  };

  // Gates the missed-clock-in shortcut on actually being past this
  // person's own shift start — defaults open (shows the shortcut) when no
  // shift is configured, rather than silently hiding a real feature.
  const isPastMyShiftStart = () => {
    if (!myShiftStart) return true;
    const nowStr = currentTime.toLocaleTimeString('en-GB', { timeZone: DEFAULT_TZ, hour: '2-digit', minute: '2-digit', hour12: false });
    return nowStr >= myShiftStart.slice(0, 5);
  };
```

- [ ] **Step 3: Render the undo banner, the late/overtime line, and the (repositioned) missed-clock-in shortcut**

Right after the `{attendance && (<View style={styles.timeRow}>...)}` block closes (around line 291, right before the "Location Selector" comment), add:

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
              <Text style={styles.ownStatusText}>You clocked in {lateMinutesToday} min after your shift started today</Text>
            )}
            {overtimeMinutesToday > 0 && (
              <Text style={styles.ownStatusText}>You've worked {overtimeMinutesToday} min past your shift end today</Text>
            )}
          </View>
        )}
```

Then, right AFTER the existing "Clock In / Clock Out Buttons" `<View style={styles.actionRow}>...</View>` block closes (do not place this above the buttons — checklist #2, one primary action shouldn't compete with a secondary one for attention), add:

```jsx
        {!isClockedIn && !isClockedOut && !missedClockInSent && isPastMyShiftStart() && (
          <TouchableOpacity style={styles.missedClockInLink} onPress={handleMissedClockIn} disabled={actionLoading}>
            <Ionicons name="alert-circle-outline" size={14} color={Colors.textLight} />
            <Text style={styles.missedClockInText}>Didn't get a chance to clock in? Let your manager know</Text>
          </TouchableOpacity>
        )}
        {missedClockInSent && (
          <Text style={styles.missedClockInSentText}>Your manager has been notified.</Text>
        )}
```

- [ ] **Step 4: Add the new styles**

In the `StyleSheet.create({...})` block, add alongside the existing `outdoorBanner`/`outdoorBannerTitle` styles:

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
  // De-emphasized on purpose — this is a secondary, occasional-use link
  // sitting below the primary Clock In/Out action, not competing with it.
  missedClockInLink: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingVertical: Spacing.xs, justifyContent: 'center', marginTop: Spacing.xs,
  },
  missedClockInText: { fontSize: FontSize.xs, color: Colors.textLight, fontWeight: '500' },
  missedClockInSentText: { fontSize: FontSize.sm, color: Colors.textLight, textAlign: 'center', paddingVertical: Spacing.sm },
```

- [ ] **Step 5: Route a tapped auto-clock-in notification to the Attendance tab**

In `app/src/hooks/usePushNotifications.js`, inside the existing `if (navigationRef?.current) { try { ... } }` block, add one more branch after the existing `else if` chain:

```js
            } else if (data.screen === 'Attendance') {
              // Top-level tab for staff roles — the banner/undo affordance
              // itself lives directly on AttendanceScreen (Step 3 above),
              // so landing on the tab is enough; no params needed. Owner/
              // manager don't have this tab (they reach AttendanceScreen
              // via More → My Attendance, Task 19) and won't receive this
              // notification type in the first place — auto-clock-in only
              // applies to roles that actually clock in.
              navigationRef.current.navigate('Attendance');
            }
```

- [ ] **Step 6: Verify**

Run: `node app/scripts/babel-check.js app/src/screens/AttendanceScreen.js app/src/hooks/usePushNotifications.js`
Expected: `OK` for both.

- [ ] **Step 7: Commit**

```bash
git add app/src/screens/AttendanceScreen.js app/src/hooks/usePushNotifications.js
git commit -m "AttendanceScreen: undo-able auto-clock-in banner, own late/overtime visibility, repositioned missed-clock-in recovery"
```

---

### Task 17: `AttendanceRoster.js` component — a genuine superset of `StaffAttendanceScreen`, not a smaller replacement

**Files:**
- Create: `app/src/components/attendance/AttendanceRoster.js`

**Interfaces:**
- Consumes: `api.getStaffToday(params)`, `api.getLocations()`, `api.clockIn`, `api.clockOut` (all existing), `useSubmitGuard` (existing, `app/src/hooks/useSubmitGuard.js`).
- Produces: `<AttendanceRoster />` — fully self-contained (owns its own location filter, matching `StaffAttendanceScreen`'s pattern), consumed by `AttendanceHubScreen.js` in Task 18.

**Corrected from an earlier draft**, which the review found was a functional *regression* against the screen it was replacing, not a superset: it dropped the location filter, the four summary tiles, per-session expansion for a split-shift day, and offered "Clock Out" to someone who'd already finished and left hours ago (any `present` row, not gated on `active_session`) — a real `staff-ux-checklist` #6 violation (tapping it hit a plain "No active clock-in found" error). Also wrapped the wrong way for double-tap safety, and didn't retry its fetch after a failed action. All fixed below.

- [ ] **Step 1: Write the component**

```javascript
// app/src/components/attendance/AttendanceRoster.js
//
// The "Today" tab's live roster — a superset of StaffAttendanceScreen's own
// features (location filter, summary tiles, per-session expansion), not a
// smaller replacement, PLUS the OT/late chips and the one-tap manual
// clock-in/out promoted directly onto each row (previously three taps deep
// inside StaffAttendanceScreen: More → Attendance → Staff Today → row).
// See spec §7.
import React, { useState, useCallback, useEffect } from 'react';
import { View, Text, StyleSheet, SectionList, TouchableOpacity, ActivityIndicator, Alert, Platform, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '../../context/AuthContext';
import api from '../../services/api';
import useSubmitGuard from '../../hooks/useSubmitGuard';
import { Colors, FontSize, Spacing, BorderRadius } from '../../constants/theme';
import { formatTime as formatServerTime } from '../../utils/datetime';

function formatTime(iso) {
  if (!iso) return '--:--';
  return formatServerTime(iso, 'en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}

function formatExtra(minutes) {
  if (!minutes || minutes <= 0) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `+${h}h ${m}m` : `+${m}m`;
}

const confirmClockOut = (name, onOk) => {
  const msg = `Clock out ${name}?`;
  if (Platform.OS === 'web') { if (window.confirm(msg)) onOk(); }
  else Alert.alert('Clock Out', msg, [{ text: 'Cancel', style: 'cancel' }, { text: 'OK', onPress: onOk }]);
};

export default function AttendanceRoster() {
  const { user, activeLocation } = useAuth();
  const isOwner = user?.role === 'owner';
  const guardSubmit = useSubmitGuard();

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [present, setPresent] = useState([]);
  const [absent, setAbsent] = useState([]);
  const [summary, setSummary] = useState(null);
  const [locations, setLocations] = useState([]);
  // Owner defaults to "All Locations" (null); manager defaults to their
  // own assigned location — same pattern OrdersInboxScreen's location
  // filter already established.
  const [selectedLoc, setSelectedLoc] = useState(isOwner ? null : (activeLocation?.id || null));
  const [expandedUsers, setExpandedUsers] = useState({});
  const [actionLoadingKey, setActionLoadingKey] = useState(null);

  const fetchData = useCallback(async () => {
    try {
      const params = selectedLoc ? { location_id: selectedLoc } : {};
      const [staffRes, locsRes] = await Promise.all([api.getStaffToday(params), api.getLocations()]);
      setPresent(staffRes.data?.present || []);
      setAbsent(staffRes.data?.absent || []);
      setSummary(staffRes.data?.summary || null);
      setLocations((locsRes.data?.locations || locsRes.data || []).filter((l) => (l.type === 'shop' || l.type == null) && l.is_active !== 0));
    } catch (e) {
      console.error('Fetch staff-today error:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [selectedLoc]);

  useFocusEffect(useCallback(() => { fetchData(); }, [fetchData]));

  const toggleExpanded = useCallback((userId) => {
    setExpandedUsers((prev) => ({ ...prev, [userId]: !prev[userId] }));
  }, []);

  const doClockIn = async (staffId, locId) => {
    setActionLoadingKey(`in-${staffId}`);
    try {
      await api.clockIn({ user_id: staffId, location_id: locId, method: 'manual' });
    } catch (e) {
      Alert.alert('Error', e.message || 'Failed to clock in staff.');
    } finally {
      // Refetch regardless of success/failure — a failed request that
      // actually succeeded server-side (lost response, not lost request)
      // would otherwise leave a stale "Not clocked in" row inviting a
      // duplicate tap.
      await fetchData();
      setActionLoadingKey(null);
    }
  };

  const doClockOut = (staffId, staffName) => {
    confirmClockOut(staffName, async () => {
      setActionLoadingKey(`out-${staffId}`);
      try {
        await api.clockOut({ user_id: staffId, method: 'manual' });
      } catch (e) {
        Alert.alert('Error', e.message || 'Failed to clock out staff.');
      } finally {
        await fetchData();
        setActionLoadingKey(null);
      }
    });
  };

  if (loading) {
    return <View style={styles.center}><ActivityIndicator size="large" color={Colors.primary} /></View>;
  }

  const sections = [
    { key: 'present', title: `Present (${present.length})`, data: present },
    { key: 'absent', title: `Not Clocked In (${absent.length})`, data: absent },
  ];

  return (
    <SectionList
      sections={sections}
      keyExtractor={(item, index) => `${item.user_id || item.id}-${index}`}
      contentContainerStyle={styles.list}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchData(); }} colors={[Colors.primary]} />}
      ListHeaderComponent={
        <>
          {/* Location filter — restored; an earlier draft dropped this
              entirely and locked the owner to "All" with no way to narrow it. */}
          <View style={styles.locRow}>
            <TouchableOpacity style={[styles.locChip, !selectedLoc && styles.locChipActive]} onPress={() => setSelectedLoc(null)}>
              <Text style={[styles.locChipText, !selectedLoc && styles.locChipTextActive]}>All</Text>
            </TouchableOpacity>
            {locations.map((loc) => (
              <TouchableOpacity key={loc.id} style={[styles.locChip, selectedLoc === loc.id && styles.locChipActive]} onPress={() => setSelectedLoc(loc.id)}>
                <Text style={[styles.locChipText, selectedLoc === loc.id && styles.locChipTextActive]}>{loc.name}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Summary tiles — restored from StaffAttendanceScreen, using the
              same summary object GET /attendance/staff-today already returns. */}
          <View style={styles.summaryRow}>
            <View style={[styles.summaryCard, { backgroundColor: '#E8F5E9' }]}>
              <Ionicons name="checkmark-circle" size={22} color={Colors.secondary} />
              <Text style={styles.summaryCount}>{summary?.present_count ?? present.length}</Text>
              <Text style={styles.summaryLabel}>Present</Text>
            </View>
            <View style={[styles.summaryCard, { backgroundColor: '#E3F2FD' }]}>
              <Ionicons name="pulse" size={22} color={Colors.primary} />
              <Text style={styles.summaryCount}>{summary?.active_count ?? 0}</Text>
              <Text style={styles.summaryLabel}>Active Now</Text>
            </View>
            <View style={[styles.summaryCard, { backgroundColor: '#FFEBEE' }]}>
              <Ionicons name="close-circle" size={22} color={Colors.danger} />
              <Text style={styles.summaryCount}>{summary?.absent_count ?? absent.length}</Text>
              <Text style={styles.summaryLabel}>Not Clocked In</Text>
            </View>
            <View style={[styles.summaryCard, { backgroundColor: '#FFF3E0' }]}>
              <Ionicons name="alert-circle" size={22} color={Colors.warning} />
              <Text style={styles.summaryCount}>{summary?.late_count ?? 0}</Text>
              <Text style={styles.summaryLabel}>Late</Text>
            </View>
          </View>
        </>
      }
      renderSectionHeader={({ section }) => <Text style={styles.sectionTitle}>{section.title}</Text>}
      renderItem={({ item, section }) => {
        if (section.key === 'absent') {
          const busy = actionLoadingKey === `in-${item.id}`;
          return (
            <View style={styles.row}>
              <View style={styles.rowInfo}>
                <Text style={styles.name}>{item.name}</Text>
                <Text style={[styles.metaText, styles.notIn]}>Not clocked in</Text>
              </View>
              {busy ? (
                <ActivityIndicator size="small" color={Colors.primary} />
              ) : (
                <TouchableOpacity style={styles.actionBtnIn} onPress={guardSubmit(() => doClockIn(item.id, item.location_id || selectedLoc))}>
                  <Ionicons name="log-in-outline" size={16} color="#fff" />
                  <Text style={styles.actionBtnText}>Clock In</Text>
                </TouchableOpacity>
              )}
            </View>
          );
        }

        // Present section — gate "Clock Out" strictly on active_session,
        // the exact fix for the earlier draft's staff-ux-checklist #6
        // violation (offering it to someone already gone for the day).
        const isActive = !!item.active_session;
        const busy = actionLoadingKey === `out-${item.user_id}`;
        const otLabel = formatExtra(item.overtime_minutes_today);
        const canExpand = (item.sessions_count || 1) > 1;
        const isExpanded = !!expandedUsers[item.user_id];

        return (
          <View>
            <TouchableOpacity
              style={styles.row}
              onPress={canExpand ? () => toggleExpanded(item.user_id) : undefined}
              activeOpacity={canExpand ? 0.6 : 1}
            >
              <View style={styles.rowInfo}>
                <Text style={styles.name}>{item.user_name}</Text>
                <View style={styles.metaRow}>
                  <Text style={styles.metaText}>
                    {isActive ? `In since ${formatTime(item.clock_in)}` : 'Shift complete'}
                  </Text>
                  {otLabel && <Text style={styles.otChip}>{otLabel}</Text>}
                  {item.late_minutes_today > 0 && <Text style={styles.lateChip}>{item.late_minutes_today}m late</Text>}
                  {item.clock_out_method === 'auto_shift_end' && <Text style={styles.autoClosedChip}>Auto-closed</Text>}
                  {canExpand && <Ionicons name={isExpanded ? 'chevron-up' : 'chevron-down'} size={14} color={Colors.textLight} />}
                </View>
              </View>
              {busy ? (
                <ActivityIndicator size="small" color={Colors.primary} />
              ) : isActive ? (
                <TouchableOpacity style={styles.actionBtnOut} onPress={guardSubmit(() => doClockOut(item.user_id, item.user_name))}>
                  <Ionicons name="log-out-outline" size={16} color="#fff" />
                  <Text style={styles.actionBtnText}>Clock Out</Text>
                </TouchableOpacity>
              ) : null /* shift complete — no action, per staff-ux-checklist #6 */}
            </TouchableOpacity>
            {canExpand && isExpanded && (item.logs || []).map((log, idx) => (
              <View key={log.id || idx} style={styles.sessionRow}>
                <Text style={styles.sessionText}>{formatTime(log.clock_in)} → {log.clock_out ? formatTime(log.clock_out) : 'Active'}</Text>
                {log.location_name && <Text style={styles.sessionLocation}>{log.location_name}</Text>}
              </View>
            ))}
          </View>
        );
      }}
      ListEmptyComponent={<Text style={styles.emptyText}>No staff assigned to this location.</Text>}
    />
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: Spacing.xl },
  list: { padding: Spacing.md },
  emptyText: { fontSize: FontSize.sm, color: Colors.textLight, textAlign: 'center', paddingVertical: Spacing.lg },

  locRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.xs, marginBottom: Spacing.sm },
  locChip: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16,
    backgroundColor: Colors.background, borderWidth: 1, borderColor: Colors.border,
  },
  locChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  locChipText: { fontSize: FontSize.sm, color: Colors.text, fontWeight: '500' },
  locChipTextActive: { color: '#fff' },

  summaryRow: { flexDirection: 'row', gap: Spacing.xs, marginBottom: Spacing.md },
  summaryCard: { flex: 1, borderRadius: BorderRadius.md, padding: Spacing.sm, alignItems: 'center' },
  summaryCount: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text, marginTop: 2 },
  summaryLabel: { fontSize: 10, color: Colors.textLight, textAlign: 'center' },

  sectionTitle: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.textLight, marginTop: Spacing.md, marginBottom: Spacing.xs },

  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    padding: Spacing.md, marginBottom: Spacing.xs,
    shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 4, elevation: 1,
    minHeight: 44,
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
  autoClosedChip: {
    fontSize: 10, fontWeight: '600', color: Colors.textLight, backgroundColor: Colors.background,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, borderWidth: 1, borderColor: Colors.border, overflow: 'hidden',
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

  sessionRow: { paddingLeft: Spacing.lg, paddingVertical: 4 },
  sessionText: { fontSize: FontSize.xs, color: Colors.text },
  sessionLocation: { fontSize: 10, color: Colors.textLight },
});
```

- [ ] **Step 2: Verify**

Run: `node app/scripts/babel-check.js app/src/components/attendance/AttendanceRoster.js`
Expected: `OK   app/src/components/attendance/AttendanceRoster.js`

- [ ] **Step 3: Commit**

```bash
git add app/src/components/attendance/AttendanceRoster.js
git commit -m "Add AttendanceRoster: superset of StaffAttendanceScreen with one-tap actions, OT/late chips, gated on active_session"
```

---

### Task 18: `AttendanceHubScreen.js` — Today/Manage tabs, added alongside `AttendanceScreen` (not replacing it)

**Files:**
- Create: `app/src/screens/AttendanceHubScreen.js`

**Interfaces:**
- Consumes: `AttendanceRoster` (Task 17, now fully self-contained — the hub no longer needs to manage a `locationId` itself).
- Produces: `<AttendanceHubScreen navigation={...} />`, registered under a NEW route in Task 19 — `AttendanceScreen`'s existing route is untouched.

**Corrected from an earlier draft**, which pointed owner/manager's *only* route to `AttendanceScreen` at this hub, silently removing three capabilities that live nowhere else in the app (outdoor-duty approval, a manager's own clock-in, Live Map — see Task 19's header for the full finding). The Manage tab now has three more rows pointing at that same still-reachable screen.

- [ ] **Step 1: Write the screen**

```javascript
// app/src/screens/AttendanceHubScreen.js
//
// Owner/manager's new Attendance & Payroll hub — added ALONGSIDE
// AttendanceScreen (not replacing its route, see Task 19) since three real
// capabilities (outdoor-duty approval, a manager's own clock-in, Live Map)
// exist only there. Two tabs: Today (live roster) and Manage (the six
// existing screens including AttendanceScreen's own sections, reached
// directly instead of nested inside Quick Links). See spec §7.
import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';
import AttendanceRoster from '../components/attendance/AttendanceRoster';

const TABS = [{ key: 'today', label: 'Today' }, { key: 'manage', label: 'Manage' }];

export default function AttendanceHubScreen({ navigation }) {
  const { user } = useAuth();
  const isOwner = user?.role === 'owner';
  const [tab, setTab] = useState('today');
  const [advancesPendingCount, setAdvancesPendingCount] = useState(0);

  useEffect(() => {
    api.getSalaryAdvances({ status: 'pending' }).then((res) => {
      setAdvancesPendingCount((res.data || []).length);
    }).catch(() => {});
  }, []);

  const manageLinks = [
    // These three point at the EXISTING 'Attendance' route (AttendanceScreen,
    // untouched — see Task 19) — nothing an owner/manager could do before
    // this hub shipped becomes unreachable after.
    { key: 'Attendance', label: 'My Attendance', icon: 'time' },
    { key: 'Attendance', label: 'Outdoor Requests', icon: 'walk', params: { scrollTo: 'outdoorRequests' } },
    { key: 'LiveDeliveryMap', label: 'Live Map', icon: 'map', showFor: isOwner || user?.role === 'manager' },
    { key: 'ShiftManagement', label: 'Shifts', icon: 'calendar' },
    { key: 'SalaryAdvances', label: 'Advances', icon: 'cash', badge: advancesPendingCount },
    { key: 'AttendanceReport', label: 'Reports', icon: 'bar-chart' },
    ...(isOwner ? [{ key: 'SalaryManagement', label: 'Salaries & Payroll', icon: 'wallet' }] : []),
  ].filter((l) => l.showFor !== false);

  return (
    <View style={styles.container}>
      <View style={styles.tabBar}>
        {TABS.map((t) => (
          <TouchableOpacity key={t.key} style={[styles.tabBtn, tab === t.key && styles.tabBtnActive]} onPress={() => setTab(t.key)}>
            <Text style={[styles.tabText, tab === t.key && styles.tabTextActive]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {tab === 'today' ? (
        <AttendanceRoster />
      ) : (
        <ScrollView contentContainerStyle={styles.manageList}>
          {manageLinks.map((link, idx) => (
            <TouchableOpacity key={`${link.key}-${idx}`} style={styles.manageRow} onPress={() => navigation.navigate(link.key, link.params)}>
              <Ionicons name={link.icon} size={22} color={Colors.primary} />
              <Text style={styles.manageRowText}>{link.label}</Text>
              {!!link.badge && <View style={styles.badge}><Text style={styles.badgeText}>{link.badge}</Text></View>}
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

Note: `{ scrollTo: 'outdoorRequests' }` is passed as a param to `AttendanceHome` for the "Outdoor Requests" row, but `AttendanceScreen.js` itself doesn't currently read any such param — this is a deliberate no-op placeholder for now (the screen already shows pending outdoor requests inline for managers/owner without needing to scroll to find them, so the param currently does nothing but also breaks nothing). If a future pass wants an actual scroll-to-section behavior, wiring `route.params?.scrollTo` in `AttendanceScreen.js` is a small follow-up, explicitly not required for this task — the row still functions correctly today (it navigates to the screen where outdoor requests are visible).

- [ ] **Step 2: Verify**

Run: `node app/scripts/babel-check.js app/src/screens/AttendanceHubScreen.js`
Expected: `OK   app/src/screens/AttendanceHubScreen.js`

- [ ] **Step 3: Commit**

```bash
git add app/src/screens/AttendanceHubScreen.js
git commit -m "Add AttendanceHubScreen: Today/Manage tabs, added alongside (not replacing) AttendanceScreen"
```

---

### Task 19: Wire the hub in as a NEW route — `AttendanceScreen`'s existing route stays exactly as it is

**Files:**
- Modify: `app/src/navigation/MainNavigator.js` (import, one new `Stack.Screen` in `MoreStack`)
- Modify: `app/src/screens/MoreScreen.js` (repoint the top-level "Attendance" tile)

**Interfaces:**
- Consumes: `AttendanceHubScreen` (Task 18).

**Corrected from an earlier draft**, which repointed `MoreStack`'s existing `Attendance` route at the new hub directly — found during review to strand three capabilities with no other entry point in the app: outdoor-duty request approval/rejection (`AttendanceScreen.js:445-459`, the only UI anywhere that can approve one — a requesting employee would be stuck mid-request, permanently, with no error shown), a manager's own clock-in/out (`canClockInOut` evaluates true for `role==='manager'`; `POST /clock-in` only 403s `owner`), and Live Map (`AttendanceScreen.js:491`, the only context-free entry point into live delivery tracking). This task instead adds a NEW route for the hub and leaves the existing one completely untouched.

- [ ] **Step 1: Import the new screen**

In `app/src/navigation/MainNavigator.js`, alongside the existing Phase 8 imports:
```js
import AttendanceHubScreen from '../screens/AttendanceHubScreen';
```

- [ ] **Step 2: Register the hub as a new screen in `MoreStack`**

Find the existing line (around line 494):
```js
      <Stack.Screen name="Attendance" component={AttendanceScreen} options={{ title: 'Attendance' }} />
```
Leave it exactly as it is, and add immediately after it:
```js
      <Stack.Screen name="AttendanceHub" component={AttendanceHubScreen} options={{ title: 'Attendance & Payroll' }} />
```

Do not touch `AttendanceStack` (the employee/counter_staff/florist_staff/delivery_partner stack reached via the bottom "Attendance" tab) at all — it keeps pointing `AttendanceHome` at the original `AttendanceScreen`, matching spec §5's "the clock-in control itself does not move."

- [ ] **Step 3: Repoint the top-level "Attendance" menu tile at the hub**

In `app/src/screens/MoreScreen.js`, find:
```js
  { key: 'Attendance', icon: 'time', label: 'Attendance', roles: ['owner', 'manager'] },
```
Change to:
```js
  { key: 'AttendanceHub', icon: 'time', label: 'Attendance', roles: ['owner', 'manager'] },
```
(The tile's visible label stays "Attendance" — only the route it navigates to changes, since this file's generic renderer calls `navigation.navigate(item.key)` directly.)

- [ ] **Step 4: Verify**

Run: `node app/scripts/babel-check.js app/src/navigation/MainNavigator.js app/src/screens/MoreScreen.js`
Expected: `OK` for both.

- [ ] **Step 5: Manual trace**

Log in as owner → tap More → tap "Attendance" (the tile) → confirm this now opens the NEW hub (Today tab shows the live roster) → switch to Manage tab → confirm every link works: Shifts, Advances (with correct pending-count badge), Reports, Salaries & Payroll (owner only), My Attendance (opens the original `AttendanceScreen`, including its own Quick Links/outdoor-duty/clock-in-for-manager UI, completely unchanged), Outdoor Requests (same screen), Live Map. Confirm a MANAGER (not owner) can still clock themselves in/out from "My Attendance" and can still approve a pending outdoor-duty request there. Log in as employee/counter_staff/florist_staff → tap the bottom Attendance tab → confirm it's the ORIGINAL unchanged clock-in screen — no hub, no regression.

- [ ] **Step 6: Commit**

```bash
git add app/src/navigation/MainNavigator.js app/src/screens/MoreScreen.js
git commit -m "Add AttendanceHub as a new route reached from More; AttendanceScreen's own route is untouched"
```

---

### Task 20: Dashboard "N staff not clocked in" banner — reusing the fetch already made, not a duplicate

**Files:**
- Modify: `app/src/screens/DashboardScreen.js`

**Interfaces:**
- Consumes: the `absent` array from `DashboardScreen.js`'s own existing `api.getStaffToday(filters)` call (line 486) — de-duplicated automatically by Task 7's `DISTINCT ON` fix, no new work needed here for that.

**Corrected from an earlier draft**, which added a brand-new `api.getStaffToday()` call for this banner alone — the review found this screen already fetches exactly this data (`results[2]`, used to build `staffPulse` a few lines later) and was about to be fetched a second time for no reason.

- [ ] **Step 1: Add state and set it from the existing fetch**

Near the component's other `useState` calls:
```js
  const [notClockedInCount, setNotClockedInCount] = useState(0);
```

Right after the existing `const absent = staffRes?.data?.absent || [];` line (around line 520), add:
```js
        setNotClockedInCount(absent.length);
```

- [ ] **Step 2: Render the banner**

Following the exact `codBannerCompact` pattern already used for the "Add an expense" / pending-COD banners in this file, add near those existing banners:

```jsx
        {isOwnerOrManager && notClockedInCount > 0 && (
          <TouchableOpacity
            style={styles.codBannerCompact}
            onPress={() => navigation.navigate('More', { screen: 'AttendanceHub' })}
          >
            <Ionicons name="alert-circle-outline" size={16} color={Colors.warning} />
            <Text style={styles.codBannerCompactText}>
              {notClockedInCount} staff not clocked in
            </Text>
          </TouchableOpacity>
        )}
```

Navigates to `AttendanceHub` (Task 19's new route) — the hub's Today tab is the one consolidated roster; routing to the older standalone `StaffAttendance` screen instead would recreate the "two competing one-tap mechanisms" problem this redesign exists to fix.

(Reuses the existing `codBannerCompact`/`codBannerCompactText` styles already defined in this file — no new styles needed.)

- [ ] **Step 3: Verify**

Run: `node app/scripts/babel-check.js app/src/screens/DashboardScreen.js`
Expected: `OK   app/src/screens/DashboardScreen.js`

- [ ] **Step 4: Manual trace**

Log in as manager/owner with at least one staff member not yet clocked in today → confirm the banner shows the correct count (matching Task 17's roster de-duplicated count for the same location) and tapping it lands on the new hub's Today tab.

- [ ] **Step 5: Note on `DashboardScreenV2.js`**

This task only touches `DashboardScreen.js` (the "V1" dashboard `CLAUDE.md` documents as still coexisting with `DashboardScreenV2.js`, gated by a settings flag). Whether `DashboardScreenV2.js` needs the same banner depends on which owners/managers are actually toggled onto it — not determined by this plan; flagged here rather than silently applied to one dashboard and not mentioned for the other.

- [ ] **Step 6: Commit**

```bash
git add app/src/screens/DashboardScreen.js
git commit -m "Dashboard: add 'N staff not clocked in' banner, reusing the existing getStaffToday fetch"
```

---

### Task 21: Full regression + live manual trace

**Files:**
- None new — this task runs everything already built.

- [ ] **Step 1: Real coordinates for Test Loc**

Several checks in Tasks 11/12 self-skip (logged, not failed) if `TEST_LOCATION_ID` (location 4, "Test Loc") has no real lat/long — true on the dev DB as of this plan being written. Before running the full suite, either enter real coordinates for Test Loc via the app/DB directly, or accept that those specific checks will self-skip and confirm their coverage instead via the live manual trace in Step 4 below.

- [ ] **Step 2: Run all backend regression suites (note the `cd server` prefix)**

```bash
cd server
VERIFY_OWNER_PHONE=<owner phone> VERIFY_OWNER_PASSWORD=<owner password> node scripts/verify-shift-work.js
VERIFY_OWNER_PHONE=<owner phone> VERIFY_OWNER_PASSWORD=<owner password> node scripts/verify-attendance-payroll.js
VERIFY_OWNER_PHONE=<owner phone> VERIFY_OWNER_PASSWORD=<owner password> node scripts/verify-order-flows.js
VERIFY_OWNER_PHONE=<owner phone> VERIFY_OWNER_PASSWORD=<owner password> node scripts/verify-register-expenses.js
```
`verify-attendance-payroll.js` needs the dev server (`node server.js`) already running in the background — Task 14's sweep check waits on a real 60-second cron tick. Expected: every suite reports 100% passed (minus any self-skips per Step 1, logged not failed), with `verify-order-flows.js` and `verify-register-expenses.js`'s pass counts unchanged from before this plan started — confirms nothing here regressed the register/expense or order-flow work from prior sub-projects.

- [ ] **Step 3: Babel-check every touched frontend file in one pass**

```bash
node app/scripts/babel-check.js \
  app/src/services/api.js \
  app/src/screens/AttendanceScreen.js \
  app/src/hooks/usePushNotifications.js \
  app/src/components/attendance/AttendanceRoster.js \
  app/src/screens/AttendanceHubScreen.js \
  app/src/navigation/MainNavigator.js \
  app/src/screens/MoreScreen.js \
  app/src/screens/DashboardScreen.js
```
Expected: `OK` for all eight.

- [ ] **Step 4: Live manual trace**

Using the real app against the local dev server:

1. **Split-shift correctness.** As owner, set a real split shift (07:00-12:00, 18:00-22:00) for a test florist_staff via Shifts. As that employee, clock in for the second segment around 18:00 — confirm no LATE tag. Stay clocked in past 22:30 — confirm the roster's OT chip appears (as manager) and the employee's own screen shows the plain-language "worked past your shift end" line.
2. **Geofence — if Test Loc has real coordinates (Step 1):** approach the shop with the app installed and location permission granted, confirm auto-clock-in fires with a push notification, tap "Undo" within 15 minutes and confirm it's removed; separately confirm the undo option is GONE if you check back after 15 minutes.
3. **Clock-out sweep.** Manually backdate a test session's `clock_in` in the DB to simulate a forgotten clock-out well past a configured shift's end — confirm it auto-closes on the next cron tick, marked `auto_shift_end`, and shows the "Auto-closed" chip on the manager's roster.
4. **Manager one-tap clock-in for a "forgot" case.** As a staff member, skip clocking in. As manager, open the new Attendance hub → Today → confirm that person shows "Not clocked in" with a one-tap Clock In button directly on their row — tap it, confirm it works, and confirm the Dashboard's "N not clocked in" banner count drops by one afterward.
5. **Full payroll cycle with expense linkage.** As owner, run Payroll → Calculate for a test employee with at least one late/overtime day this period — confirm the late/OT figures display. Disburse via cash with a register open — confirm success, then check Expenses shows the new salary expense linked to that employee, and the register's expected cash dropped by the net amount. Repeat with a bank transfer — confirm it succeeds with no register requirement.
6. **Advance approval linkage.** As an employee, request an advance. As owner/manager with a register open, approve it — confirm a linked expense appears and the register drops by the advance amount.
7. **Capability preservation (Task 19).** As manager (not owner), confirm you can still clock yourself in/out via Attendance hub → Manage → My Attendance. As owner or manager, confirm you can still approve/reject a pending outdoor-duty request from that same screen, and that Live Map still opens.
8. **florist_staff, end to end.** As a florist_staff test user, confirm: today's status loads, salary advances list loads (own only), shifts load (own only), salaries load, payroll history loads, and — the specific gap found during plan review — that this person actually shows up on the manager's roster (both present and not-clocked-in states) and can be given a salary via Salaries & Payroll.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "Attendance/shift/overtime/payroll redesign: full regression pass complete"
```
