# Identity, Roles & Employee Code/PIN Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add employee-code+PIN login with a lock-screen quick-switch for a shared counter device, and split today's single `employee` role into `counter_staff` (full parity with `employee`) and `florist_staff` (a new, narrower role excluding payments/checkout/cash-register/expenses) — without disrupting any of the 4 live employee accounts, and without touching owner/manager/customer/delivery_partner login at all.

**Architecture:** Two new `role` values are added to the existing flat `users.role` string column (no CHECK constraint exists, so this is a pure addition). `employee_code`/`pin_hash`/lockout columns are added to `users`, nullable, unused until an account is explicitly migrated. A new `staff-login` endpoint issues the exact same JWT shape `/login` already does, so every existing `authenticate`/`authorize()` call needs zero changes to understand a PIN-authenticated session. `counter_staff` is added everywhere `employee` currently appears (both `authorize()` calls and inline `role === 'employee'` checks) to guarantee true behavioral parity; `florist_staff` is added only to the specific routes/checks the approved permission boundary allows.

**Tech Stack:** Express.js + `bcryptjs` (already a dependency) + PostgreSQL via the existing `pg`/`database-async.js` layer. Expo/React Native, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-30-identity-roles-pin-login-design.md` — read in full before starting; this plan implements it exactly. Executors read both.

## Global Constraints

- Every schema change is additive-only — new nullable columns, no CHECK constraints, no renames. Follow `.claude/skills/db-migration-safety/SKILL.md`.
- `employee` role stays fully valid and untouched indefinitely — never removed from any `authorize()` call, never migrated by a script. The 4 live employee accounts keep logging in with phone+password exactly as today unless the owner manually reassigns them via the existing `UserFormScreen` role-change UI (unaffected by this plan).
- `counter_staff` must be a byte-for-byte access parity with `employee` — every place `role === 'employee'` or `authorize(..., 'employee')` appears (backend or frontend) that isn't explicitly excluded below must also accept `counter_staff`.
- `florist_staff` gets access ONLY to: production/task routes, `sales.js` read routes (already open to any authenticated role, no change needed), `stock.js` `POST /adjust` and `POST /reconcile`, and exactly `attendance.js`'s clock-in/clock-out/own-history routes. It must NOT be added to any payment-writing route, `expenses.js`, cash-register/settlement routes, `customers.js`, `deliveries.js`, `purchase-orders.js`, or `attendance.js`'s salary-advance/outdoor-duty routes.
- No project has a configured test runner for `server/` (`package.json` has no `test` script, no jest config). Follow the established project pattern from sub-project 1: a standalone Node verification script run directly against the real local dev server/DB (`server/scripts/verify-order-channel.js` is the precedent), not a jest suite.
- This project stays on Express/JWT/pg + Expo/React Navigation — do not introduce new dependencies for PIN hashing (reuse `bcryptjs`), idle timing (plain `setInterval`/`onTouchStart`, no new library), or navigation.

---

### Task 1: Schema migration — employee_code, PIN, job_title on `users`

**Files:**
- Modify: `server/config/database.js` (add 5 `ensureColumn()` calls near the other `users` column definitions)
- Create: `server/scripts/verify-identity-roles.js` (new verification script, extended by later tasks)

**Interfaces:**
- Produces: `users.employee_code TEXT UNIQUE`, `users.pin_hash TEXT`, `users.pin_failed_attempts INTEGER DEFAULT 0`, `users.pin_locked_until TIMESTAMP`, `users.job_title TEXT` — every later task in this plan reads/writes these exact column names.

- [ ] **Step 1: Find the existing `users` column block in `database.js`**

Run: `grep -n "ensureColumn('users'" server/config/database.js`

Find the group of `ensureColumn('users', ...)` calls (there will be several, e.g. for `avatar`, `bio`, `credit_balance`). Note the line number right after the last one — that's where the new calls go.

- [ ] **Step 2: Add the 5 new columns**

Insert immediately after the last existing `ensureColumn('users', ...)` call:

```js
  ensureColumn('users', 'employee_code', 'TEXT UNIQUE');
  ensureColumn('users', 'pin_hash', 'TEXT');
  ensureColumn('users', 'pin_failed_attempts', 'INTEGER DEFAULT 0');
  ensureColumn('users', 'pin_locked_until', 'TIMESTAMP');
  ensureColumn('users', 'job_title', 'TEXT');
```

- [ ] **Step 3: Verify `ensureColumn` supports the `UNIQUE` modifier**

Run: `grep -n "function ensureColumn" -A 25 server/config/database.js`

Read the function body. If it builds `ALTER TABLE ... ADD COLUMN IF NOT EXISTS <name> <definition>` by splicing `<definition>` verbatim into the SQL (this is the pattern used elsewhere in the file, e.g. `ensureColumn('sales', 'channel', "TEXT")` type calls with CHECK constraints already present elsewhere), `'TEXT UNIQUE'` works unmodified. If instead it strips or rejects multi-word definitions, adjust Step 2 to add the column as plain `'TEXT'` first and add a separate `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_employee_code ON users(employee_code) WHERE employee_code IS NOT NULL;` (partial unique index — correct here since most rows will have `NULL` employee_code, and `NULL <> NULL` in a plain unique index would already permit multiple NULLs, but a partial index makes the intent explicit) run via the same `runPsql()` helper used elsewhere in the file. Use whichever form matches what you find — do not guess without checking.

- [ ] **Step 4: Create the verification script skeleton**

Create `server/scripts/verify-identity-roles.js`:

```js
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

const checks = [];

function check(name, fn) {
  checks.push({ name, fn });
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

// ─── Run ──────────────────────────────────────────────────────
async function main() {
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
  console.log(`\n${pass}/${pass + fail} checks passed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
```

- [ ] **Step 5: Restart the dev server so `ensureColumn` runs, then run the script**

Run: `cd server && (pkill -f "node server.js" || true) && nohup node server.js > /tmp/petal-dev-server.log 2>&1 & sleep 2 && node scripts/verify-identity-roles.js`

Expected: `2/2 checks passed`. If the dev server was already running under a different process manager, use whatever restart mechanism is actually running it — check `lsof -iTCP:3001 -sTCP:LISTEN` first to see what's there before killing it.

- [ ] **Step 6: `git add` (do not commit)**

Run: `git add server/config/database.js server/scripts/verify-identity-roles.js`

---

### Task 2: Backend — PIN utility + staff-login + staff-roster endpoints

**Files:**
- Create: `server/utils/pin.js`
- Modify: `server/routes/auth.js`
- Modify: `server/scripts/verify-identity-roles.js` (append checks)

**Interfaces:**
- Consumes: `users.employee_code`/`pin_hash`/`pin_failed_attempts`/`pin_locked_until` from Task 1.
- Produces: `POST /api/auth/staff-login`, `GET /api/auth/staff-roster` — Task 9 (frontend `AuthContext`) and Task 10 (`LockScreen`) call these exact paths/shapes.
  - `staff-login` request: `{employee_code: string, pin: string}`. Response (200): same envelope as `/login` — `{success: true, message, data: {user, token, locations}}`, `user` excludes `password`/`pin_hash`. Response (401): `{success: false, message: 'Wrong PIN — N tries left'}` or `{success:false, message:'Invalid employee code'}`. Response (423, locked): `{success:false, message:'Too many wrong tries — ask your manager to unlock this in 5 minutes'}`.
  - `staff-roster` request: `GET ?location_id=<int>`. Response (200): `{success:true, data:{staff:[{id, name, avatar, employee_code, job_title}]}}`.
- Produces from `server/utils/pin.js`: `hashPin(pin: string): Promise<string>`, `verifyPin(pin: string, hash: string): Promise<boolean>`, `PIN_MAX_ATTEMPTS = 5`, `PIN_LOCKOUT_MINUTES = 5`.

- [ ] **Step 1: Write `server/utils/pin.js`**

```js
const bcrypt = require('bcryptjs');

const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCKOUT_MINUTES = 5;

async function hashPin(pin) {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(pin, salt);
}

async function verifyPin(pin, hash) {
  if (!hash) return false;
  return bcrypt.compare(pin, hash);
}

module.exports = { hashPin, verifyPin, PIN_MAX_ATTEMPTS, PIN_LOCKOUT_MINUTES };
```

- [ ] **Step 2: Verify it against the dev DB directly (no test runner — quick node -e check)**

Run:
```bash
cd server && node -e "
const { hashPin, verifyPin } = require('./utils/pin');
(async () => {
  const hash = await hashPin('4321');
  const ok = await verifyPin('4321', hash);
  const bad = await verifyPin('0000', hash);
  console.log('correct PIN verifies:', ok === true);
  console.log('wrong PIN rejected:', bad === false);
})();
"
```
Expected: both lines print `true`.

- [ ] **Step 3: Add `POST /api/auth/staff-login` to `server/routes/auth.js`**

Insert after the existing `POST /login` block (after the closing `);` that follows line ~205 in the current file — re-check with `grep -n "^router.post(\|^router.get(" server/routes/auth.js` since Task 1 didn't touch this file and line numbers should still match):

```js
// ─── POST /api/auth/staff-login ──────────────────────────────
// Employee code + PIN login for the shared counter device.
const { hashPin, verifyPin, PIN_MAX_ATTEMPTS, PIN_LOCKOUT_MINUTES } = require('../utils/pin');

router.post(
  '/staff-login',
  [
    body('employee_code').trim().notEmpty().withMessage('Employee code is required'),
    body('pin').trim().isLength({ min: 4, max: 4 }).withMessage('Enter your 4-digit PIN'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      }

      const { employee_code, pin } = req.body;
      const db = await getAsyncDb();

      const user = await db.prepare(
        "SELECT * FROM users WHERE employee_code = ? AND role IN ('employee', 'counter_staff', 'florist_staff')"
      ).get(employee_code);

      if (!user) {
        return res.status(401).json({ success: false, message: 'Employee code not recognized.' });
      }

      if (!user.is_active) {
        return res.status(403).json({ success: false, message: 'Your account has been deactivated. Contact your manager.' });
      }

      if (user.pin_locked_until && new Date(user.pin_locked_until) > new Date()) {
        return res.status(423).json({ success: false, message: `Too many wrong tries — ask your manager to unlock this in ${PIN_LOCKOUT_MINUTES} minutes.` });
      }

      const isValidPin = await verifyPin(pin, user.pin_hash);

      if (!isValidPin) {
        const attempts = (user.pin_failed_attempts || 0) + 1;
        const locked = attempts >= PIN_MAX_ATTEMPTS;
        await db.prepare(
          'UPDATE users SET pin_failed_attempts = ?, pin_locked_until = ? WHERE id = ?'
        ).run(attempts, locked ? new Date(Date.now() + PIN_LOCKOUT_MINUTES * 60000) : null, user.id);

        if (locked) {
          return res.status(423).json({ success: false, message: `Too many wrong tries — ask your manager to unlock this in ${PIN_LOCKOUT_MINUTES} minutes.` });
        }
        return res.status(401).json({ success: false, message: `Wrong PIN — ${PIN_MAX_ATTEMPTS - attempts} tries left.` });
      }

      await db.prepare(
        'UPDATE users SET pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = ?'
      ).run(user.id);

      const token = generateToken(user);
      const { password: _pw, pin_hash: _pin, ...userWithoutSecrets } = user;

      const locations = await db.prepare(
        'SELECT l.id, l.name, l.type, l.latitude, l.longitude, l.geofence_radius, ul.is_primary FROM locations l JOIN user_locations ul ON ul.location_id = l.id WHERE ul.user_id = ? AND l.is_active = 1'
      ).all(user.id);

      res.json({
        success: true,
        message: 'Login successful',
        data: { user: userWithoutSecrets, token, locations },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ─── GET /api/auth/staff-roster ──────────────────────────────
// Unauthenticated by design — shown on the lock screen before anyone
// is logged in. Returns only non-sensitive display fields, scoped to
// one location. See design spec §6/§7 for the accepted tradeoff.
router.get('/staff-roster', async (req, res, next) => {
  try {
    const { location_id } = req.query;
    if (!location_id) {
      return res.status(400).json({ success: false, message: 'location_id is required' });
    }
    const db = await getAsyncDb();
    const staff = await db.prepare(`
      SELECT u.id, u.name, u.avatar, u.employee_code, u.job_title
      FROM users u
      JOIN user_locations ul ON ul.user_id = u.id
      WHERE ul.location_id = ?
        AND u.role IN ('employee', 'counter_staff', 'florist_staff')
        AND u.is_active = 1
        AND u.employee_code IS NOT NULL
      ORDER BY u.name ASC
    `).all(location_id);

    res.json({ success: true, data: { staff } });
  } catch (error) {
    next(error);
  }
});
```

- [ ] **Step 4: Verify `generateToken`, `getAsyncDb`, `body`, `validationResult` are already in scope in `auth.js`**

Run: `head -10 server/routes/auth.js`

They were already imported/defined at the top of the file per the existing `/login` route (`generateToken` is a local function, `getAsyncDb` is imported as `getDb: getAsyncDb`, `body`/`validationResult` from `express-validator`) — confirm before assuming; if any name differs from what Step 3's code expects, adjust Step 3 to match the file's actual imports rather than adding a duplicate import.

- [ ] **Step 5: Append verification checks to `server/scripts/verify-identity-roles.js`**

Add before the `// ─── Run` section:

```js
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
```

Add near the top of the file, alongside the existing `require`:

```js
const API_BASE = process.env.API_BASE_URL || 'http://localhost:3001/api';
```

(`fetch` is a global in Node 18+, which this project already targets — verify with `node --version`; if below 18, use `node-fetch` the same way any other script in `server/scripts/` already does — check `server/scripts/verify-order-channel.js` for the exact pattern it used, if any, and match it.)

- [ ] **Step 6: Restart the dev server, run the full script**

Run: `cd server && (pkill -f "node server.js" || true) && nohup node server.js > /tmp/petal-dev-server.log 2>&1 & sleep 2 && node scripts/verify-identity-roles.js`

Expected: all checks so far pass (2 from Task 1, 3 from this task = 5/5).

- [ ] **Step 7: `git add` (do not commit)**

Run: `git add server/utils/pin.js server/routes/auth.js server/scripts/verify-identity-roles.js`

---

### Task 3: Backend — `users.js` staff CRUD extended for the two new roles

**Files:**
- Modify: `server/routes/users.js`
- Modify: `server/scripts/verify-identity-roles.js` (append checks)

**Interfaces:**
- Consumes: `hashPin` from `server/utils/pin.js` (Task 2).
- Produces: `POST /api/users` and `PUT /api/users/:id/change-role` now accept `role: 'counter_staff'|'florist_staff'`; `POST /api/users` auto-generates `employee_code` for those two roles; new `PUT /api/users/:id/pin` (owner/manager only) sets/resets a PIN and clears any lockout. `USER_SELECT_FIELDS` now includes `employee_code, job_title` — every response shape consumers (Task 8's `UserFormScreen`) rely on this.

- [ ] **Step 1: Extend `VALID_ROLES` and `USER_SELECT_FIELDS`**

In `server/routes/users.js`, change:

```js
const USER_SELECT_FIELDS =
  'id, phone, email, name, role, avatar, bio, is_active, created_by, created_at, updated_at';

const VALID_ROLES = ['manager', 'employee', 'delivery_partner', 'customer'];
```

to:

```js
const USER_SELECT_FIELDS =
  'id, phone, email, name, role, avatar, bio, employee_code, job_title, is_active, created_by, created_at, updated_at';

const VALID_ROLES = ['manager', 'employee', 'counter_staff', 'florist_staff', 'delivery_partner', 'customer'];
```

- [ ] **Step 2: Update the three `.isIn([...VALID_ROLES, 'owner'])` validators and the two manager-scoping arrays**

Run: `grep -n "VALID_ROLES\|'employee', 'delivery_partner', 'customer'\|'manager', 'employee', 'delivery_partner'" server/routes/users.js`

This will show: the `GET /` route's `query('role').optional().isIn([...VALID_ROLES, 'owner'])` (now automatically correct since `VALID_ROLES` was extended in Step 1), the manager-visibility filter `" AND u.role IN ('manager', 'employee', 'delivery_partner')"` inside `GET /`, the `POST /` route's role validator (also auto-correct via `VALID_ROLES`) and its `!['employee', 'delivery_partner', 'customer'].includes(role)` manager-restriction check, and the `PUT /:id/change-role` validator (also auto-correct via `VALID_ROLES`).

Change the manager-visibility filter from:
```js
whereClause += " AND u.role IN ('manager', 'employee', 'delivery_partner')";
```
to:
```js
whereClause += " AND u.role IN ('manager', 'employee', 'counter_staff', 'florist_staff', 'delivery_partner')";
```

Change the manager-create-restriction check from:
```js
if (req.user.role === 'manager' && !['employee', 'delivery_partner', 'customer'].includes(role)) {
```
to:
```js
if (req.user.role === 'manager' && !['employee', 'counter_staff', 'florist_staff', 'delivery_partner', 'customer'].includes(role)) {
```

- [ ] **Step 3: Auto-generate `employee_code` on create for the two new roles, inside the existing `POST /` transaction**

Find the `createUser` transaction in `POST /` (the `db.transaction(() => { ... })` block that runs the `INSERT INTO users` statement). Change it from:

```js
      const createUser = db.transaction(() => {
        const result = db
          .prepare(
            'INSERT INTO users (name, phone, email, password, role, created_by) VALUES (?, ?, ?, ?, ?, ?)'
          )
          .run(name, phone, email || null, hashedPassword, role, req.user.id);

        const userId = result.lastInsertRowid;
```

to:

```js
      const createUser = db.transaction(() => {
        let employeeCode = null;
        if (role === 'counter_staff' || role === 'florist_staff') {
          const maxRow = db.prepare(
            "SELECT COALESCE(MAX(CAST(employee_code AS INTEGER)), 1000) as max_code FROM users WHERE employee_code ~ '^[0-9]+$'"
          ).get();
          employeeCode = String(maxRow.max_code + 1);
        }

        const result = db
          .prepare(
            'INSERT INTO users (name, phone, email, password, role, created_by, employee_code) VALUES (?, ?, ?, ?, ?, ?, ?)'
          )
          .run(name, phone, email || null, hashedPassword, role, req.user.id, employeeCode);

        const userId = result.lastInsertRowid;
```

This runs inside the existing transaction, so the `MAX(...)+1` read-then-insert is atomic against concurrent creates — the `db.transaction()` wrapper here is the same synchronous `better-sqlite3`-style transaction already used throughout this file (verify by checking how `db` is obtained at the top of the file — it's `getDb()` from `../config/database`, the sync layer; this matches the file's existing convention, not a new pattern).

- [ ] **Step 4: Add `PUT /api/users/:id/pin`**

Insert after the existing `PUT /:id/reset-password` block:

```js
// ─── PUT /api/users/:id/pin ──────────────────────────────────
// Owner/Manager sets or resets a staff member's PIN. Clears any lockout.
router.put(
  '/:id/pin',
  authorize('owner', 'manager'),
  [
    param('id').isInt(),
    body('pin').trim().isLength({ min: 4, max: 4 }).withMessage('PIN must be exactly 4 digits').isNumeric().withMessage('PIN must be numeric'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const db = getDb();
      const targetUser = db.prepare('SELECT id, role, employee_code FROM users WHERE id = ?').get(req.params.id);

      if (!targetUser) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }
      if (!['employee', 'counter_staff', 'florist_staff'].includes(targetUser.role)) {
        return res.status(400).json({ success: false, message: 'PIN login is only available for staff accounts' });
      }
      if (!targetUser.employee_code) {
        return res.status(400).json({ success: false, message: 'This account has no employee code yet — recreate it as Counter Staff or Florist/Prep Staff, or contact support to backfill one' });
      }

      const hashedPin = await hashPin(req.body.pin);

      db.prepare(
        'UPDATE users SET pin_hash = ?, pin_failed_attempts = 0, pin_locked_until = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
      ).run(hashedPin, req.params.id);

      res.json({ success: true, message: 'PIN set successfully' });
    } catch (error) {
      next(error);
    }
  }
);
```

Add the import at the top of the file: `const { hashPin } = require('../utils/pin');`

- [ ] **Step 5: Append verification checks**

```js
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
```

This introduces two shared helpers the script needs — add them near the top, above the `checks` array:

```js
const createdTestUserIds = [];

async function staffLoginAsTestOwner() {
  // Uses the dummy dev credentials already on file for this project
  // (see memory: phone 9876453210 / password naman1234) — falls back
  // to prompting via an env var if that account isn't present in this DB.
  const phone = process.env.VERIFY_OWNER_PHONE || '9876453210';
  const password = process.env.VERIFY_OWNER_PASSWORD || 'naman1234';
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, password }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Could not log in as owner for verification — set VERIFY_OWNER_PHONE/VERIFY_OWNER_PASSWORD env vars if the dummy account isn't in this DB. ${JSON.stringify(body)}`);
  return body.data;
}
```

And extend `main()`'s cleanup — after the checks loop, before `process.exit`:

```js
  if (createdTestUserIds.length > 0) {
    for (const id of createdTestUserIds) {
      await db.prepare('DELETE FROM user_locations WHERE user_id = ?').run(id);
      await db.prepare('DELETE FROM users WHERE id = ?').run(id);
    }
    console.log(`Cleaned up ${createdTestUserIds.length} test user(s)`);
  }
```

- [ ] **Step 6: Restart dev server, run the script**

Run: `cd server && (pkill -f "node server.js" || true) && nohup node server.js > /tmp/petal-dev-server.log 2>&1 & sleep 2 && node scripts/verify-identity-roles.js`

Expected: all checks pass, including the new one, and the cleanup line confirms the test user was removed.

- [ ] **Step 7: `git add` (do not commit)**

Run: `git add server/routes/users.js server/scripts/verify-identity-roles.js`

---

### Task 4: Backend — `counter_staff` full parity (mechanical, ~13 files)

**Files:**
- Modify: `server/routes/attendance.js`, `customers.js`, `deliveries.js`, `expenses.js`, `production.js`, `products.js`, `purchase-orders.js`, `sale-attachments.js`, `sales.js`, `settings.js`, `staff-management.js`, `stock.js`, `upload.js`
- Modify: `server/scripts/verify-identity-roles.js` (append checks)

**Interfaces:**
- Produces: every backend route currently reachable by `employee` is now equally reachable by `counter_staff`. Task 6 (frontend `MainNavigator`) assumes this is already true before wiring `counter_staff` into the same tabs `employee` uses.

This task is mechanical but must be complete — a reviewer should grep for every remaining bare `'employee'` role-string outside a comment and confirm each one is either (a) now paired with `'counter_staff'`, or (b) listed in the "leave alone" table below with a reason.

- [ ] **Step 1: Add `'counter_staff'` to every `authorize()` call that includes `'employee'`**

The exact current text of every such call site (verified live via `grep -n "authorize(" server/routes/*.js | grep "'employee'"` immediately before writing this plan):

| File:Line | Current text | New text |
|---|---|---|
| `attendance.js`:85,144,204,259,407,513,568,624,653 (9 occurrences, identical text) | `authorize('owner', 'manager', 'employee', 'delivery_partner')` | `authorize('owner', 'manager', 'employee', 'counter_staff', 'delivery_partner')` |
| `customers.js`:15 | `authorize('owner', 'manager', 'employee', 'delivery_partner')` | `authorize('owner', 'manager', 'employee', 'counter_staff', 'delivery_partner')` |
| `customers.js`:354,561 (2 occurrences, identical text) | `  authorize('owner', 'manager', 'employee'),` | `  authorize('owner', 'manager', 'employee', 'counter_staff'),` |
| `deliveries.js`:108 | `authorize('owner', 'manager', 'delivery_partner', 'employee')` | `authorize('owner', 'manager', 'delivery_partner', 'employee', 'counter_staff')` |
| `deliveries.js`:206 | `authorize('owner', 'manager', 'employee')` | `authorize('owner', 'manager', 'employee', 'counter_staff')` |
| `deliveries.js`:1286,1383 (2 occurrences, identical text) | `  authorize('owner', 'manager', 'employee'),` | `  authorize('owner', 'manager', 'employee', 'counter_staff'),` |
| `expenses.js`:92 | `  authorize('owner', 'manager', 'employee'),` | `  authorize('owner', 'manager', 'employee', 'counter_staff'),` |
| `production.js`:19,108,481,511,542 (5 occurrences, identical text) | `  authorize('owner', 'manager', 'employee'),` | `  authorize('owner', 'manager', 'employee', 'counter_staff'),` |
| `production.js`:254 | `authorize('owner', 'manager', 'employee')` | `authorize('owner', 'manager', 'employee', 'counter_staff')` |
| `production.js`:691 | `authorize('owner', 'manager', 'employee')` | `authorize('owner', 'manager', 'employee', 'counter_staff')` |
| `products.js`:265,419,523 (3 occurrences, identical text) | `  authorize('owner', 'manager', 'employee'),` | `  authorize('owner', 'manager', 'employee', 'counter_staff'),` |
| `purchase-orders.js`:358 | `  authorize('owner', 'manager', 'employee'),` | `  authorize('owner', 'manager', 'employee', 'counter_staff'),` |
| `sale-attachments.js`:53 | `authorize('owner', 'manager', 'employee')` | `authorize('owner', 'manager', 'employee', 'counter_staff')` |
| `sales.js`:361,390,495,972 (4 occurrences, identical text) | `authorize('owner', 'manager', 'employee')` | `authorize('owner', 'manager', 'employee', 'counter_staff')` |
| `sales.js`:409,616,661,813,1269,1886,2070,2191,2662 (9 occurrences, identical text) | `  authorize('owner', 'manager', 'employee'),` | `  authorize('owner', 'manager', 'employee', 'counter_staff'),` |
| `settings.js`:98 | `authorize('owner', 'manager', 'employee')` | `authorize('owner', 'manager', 'employee', 'counter_staff')` |
| `staff-management.js`:15,158,527 (3 occurrences, identical text) | `authorize('owner', 'manager', 'employee', 'delivery_partner')` | `authorize('owner', 'manager', 'employee', 'counter_staff', 'delivery_partner')` |
| `staff-management.js`:283 | `authorize('manager', 'employee', 'delivery_partner')` | `authorize('manager', 'employee', 'counter_staff', 'delivery_partner')` |
| `stock.js`:55,187,420 (3 occurrences, identical text) | `  authorize('owner', 'manager', 'employee'),` | `  authorize('owner', 'manager', 'employee', 'counter_staff'),` |
| `upload.js`:27 | `  authorize('owner', 'manager', 'employee'),` | `  authorize('owner', 'manager', 'employee', 'counter_staff'),` |

For each file, use a `replace_all: true` edit matching the exact "Current text" string — every occurrence listed for that file shares identical text, so one edit per distinct pattern per file covers every line in that group. Do NOT match across files with one edit — apply per file.

**Before editing, re-run** `grep -n "authorize(" server/routes/<file>.js | grep "'employee'"` **for each file and confirm the line numbers and text still match this table.** Task 1-3 didn't touch these files, but if anything drifted, trust the live grep output over this table and adjust accordingly — note any discrepancy in your report.

- [ ] **Step 2: Add `'counter_staff'` to every inline `role === 'employee'` check that isn't explicitly a florist/employee-only distinction**

Verified live via `grep -rn "role === 'employee'" server/routes` immediately before writing this plan:

| File:Line | Current text | New text | Why |
|---|---|---|---|
| `attendance.js`:269,577,661 (3 occurrences, identical text) | `    if (req.user.role === 'employee' || req.user.role === 'delivery_partner') {` | `    if (['employee', 'counter_staff', 'delivery_partner'].includes(req.user.role)) {` | Self-scoping (own records only) — counter_staff needs the same scoping employee gets. |
| `attendance.js`:955 | `      WHERE u.role IN ('employee', 'delivery_partner', 'manager') AND u.is_active = 1` | `      WHERE u.role IN ('employee', 'counter_staff', 'delivery_partner', 'manager') AND u.is_active = 1` | Staff-listing query (verify context with `sed -n '940,960p' server/routes/attendance.js` before editing — confirm it's a shift-eligible-staff list, not something narrower, before applying). |
| `sales.js`:219 | `    if (req.user.role === 'employee' || req.user.role === 'manager') {` | `    if (['employee', 'counter_staff', 'manager'].includes(req.user.role)) {` | Location-scoping on the sales list query — without this, a counter_staff account would see every location's sales instead of just their assigned one(s). |
| `sales.js`:982 | `    if (req.user.role === 'employee' && oldSale.created_by !== req.user.id) {` | `    if (['employee', 'counter_staff'].includes(req.user.role) && oldSale.created_by !== req.user.id) {` | Order-edit ownership check inside `PUT /:id`. |
| `stock.js`:434 | `      if (req.user.role === 'employee') {` | `      if (['employee', 'counter_staff'].includes(req.user.role)) {` | Location-assignment check on stock-transfer receive. |
| `deliveries.js`:1520 | `    if ((req.user.role === 'owner' || req.user.role === 'manager' || req.user.role === 'employee') && req.query.customer_id) {` | `    if (['owner', 'manager', 'employee', 'counter_staff'].includes(req.user.role) && req.query.customer_id) {` | |
| `production.js`:300 | `    if (req.user.role === 'employee' || req.user.role === 'manager') {` | `    if (['employee', 'counter_staff', 'florist_staff', 'manager'].includes(req.user.role)) {` | Location-scoping on the production task queue — **both** new roles need this (florist_staff reaches this same route; see Task 5). |
| `production.js`:450 | `      const employee = db.prepare("SELECT id, name FROM users WHERE id = ? AND role IN ('employee','manager','owner')").get(assigned_to);` | `      const employee = db.prepare("SELECT id, name FROM users WHERE id = ? AND role IN ('employee','counter_staff','florist_staff','manager','owner')").get(assigned_to);` | Validates who a task can be assigned to — florist_staff is the role most likely to receive these assignments going forward. |
| `production.js`:521,551 (2 occurrences, identical text) | `      if (req.user.role === 'employee' && task.assigned_to !== req.user.id) {` | `      if (['employee', 'counter_staff', 'florist_staff'].includes(req.user.role) && task.assigned_to !== req.user.id) {` | **Bug this plan is fixing, not just adding parity**: without this, a `florist_staff` token would silently bypass the "not your task" check entirely once `florist_staff` gains `authorize()` access to these routes in Task 5 — the condition would simply never match their role string and the guard would be skipped. Fix this in Task 4 even though `florist_staff` doesn't get route access until Task 5, so the two land together correctly. |
| `purchase-orders.js`:384 | `      if (req.user.role === 'employee') {` | `      if (req.user.role === 'employee' || req.user.role === 'counter_staff') {` | `florist_staff` doesn't get `purchase-orders.js` access at all (not in the approved scope) — no florist addition here. |

**Leave alone (do not touch), with reason:**

- `staff-management.js`:21 (`role === 'employee' || role === 'delivery_partner'` inside `GET /shifts`) — **still needs `counter_staff` added** for parity (it was omitted from the table above by mistake during drafting — add it: `if (['employee', 'counter_staff', 'delivery_partner'].includes(req.user.role)) {`).

- [ ] **Step 3: Confirm no bare `'employee'` role-string was missed**

Run: `grep -rn "'employee'" server/routes | grep -v "'counter_staff'\|'florist_staff'\|VALID_ROLES\|ROLE_LABEL\|// "`

Every remaining line should be one you've already deliberately decided to leave alone with a documented reason (e.g. the `staff-login`/`staff-roster` routes from Task 2, which intentionally list `'employee', 'counter_staff', 'florist_staff'` together and won't show up here since they already contain both new strings). If you find a line that isn't accounted for, decide whether it needs `counter_staff` added per the Global Constraints parity rule, and note your reasoning in your report.

- [ ] **Step 4: Append a verification check confirming parity is real, not just present in the source**

```js
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
```

- [ ] **Step 5: Restart dev server, run the full script**

Run: `cd server && (pkill -f "node server.js" || true) && nohup node server.js > /tmp/petal-dev-server.log 2>&1 & sleep 2 && node scripts/verify-identity-roles.js`

Expected: all checks pass.

- [ ] **Step 6: `git add` (do not commit)**

Run: `git add server/routes/attendance.js server/routes/customers.js server/routes/deliveries.js server/routes/expenses.js server/routes/production.js server/routes/products.js server/routes/purchase-orders.js server/routes/sale-attachments.js server/routes/sales.js server/routes/settings.js server/routes/staff-management.js server/routes/stock.js server/routes/upload.js server/scripts/verify-identity-roles.js`

---

### Task 5: Backend — `florist_staff` narrow permission boundary

**Files:**
- Modify: `server/routes/production.js`, `server/routes/stock.js`, `server/routes/attendance.js`
- Modify: `server/scripts/verify-identity-roles.js` (append checks)

**Interfaces:**
- Consumes: the ownership-check fix from Task 4 Step 2 (`production.js`:521,551 already includes `florist_staff` — do not re-edit those lines here, they're already correct).
- Produces: `florist_staff` can reach production/task routes, `stock.js` `POST /adjust` + `POST /reconcile`, and `attendance.js`'s clock-in/clock-out/own-history routes — and nothing else. Task 6/7 (frontend) assume this exact boundary when deciding what UI florist_staff can be shown.

- [ ] **Step 1: Add `'florist_staff'` to `production.js`'s `authorize()` calls**

All of `production.js`'s `authorize('owner', 'manager', 'employee', 'counter_staff')` calls from Task 4 (lines 19, 108, 254, 481, 511, 542, 691 — re-verify with `grep -n "authorize(" server/routes/production.js` since Task 4 changed this file) get `'florist_staff'` appended too — production/task routes are exactly what florist needs:

Change (all 7 occurrences share this exact post-Task-4 text — use `replace_all: true`):
```js
authorize('owner', 'manager', 'employee', 'counter_staff')
```
to:
```js
authorize('owner', 'manager', 'employee', 'counter_staff', 'florist_staff')
```

(Note: lines 254 and 691 are inline single-line route declarations, the rest are on their own line inside a multi-line route signature — the substring is identical either way, so a single `replace_all: true` on this exact text covers every occurrence correctly regardless of surrounding formatting.)

**Exception — do NOT add `florist_staff` to these two `production.js` routes**, even though they matched the pattern above:
- `POST /product-stock/adjust` (`authorize('owner', 'manager')` — no `employee` at all today, so it's not in this task's scope regardless).
- `GET /material-alerts` (`authorize('owner', 'manager')` — same, already excludes `employee`, unaffected).

These two were never `authorize('...employee...')` to begin with, so they won't have matched Step 1's replace — this note is just confirming that's correct, not an action to take.

- [ ] **Step 2: Add `'florist_staff'` to `stock.js`'s two material-usage routes only**

Re-verify current text with `grep -n "authorize(" server/routes/stock.js` (post-Task-4, all three should read `authorize('owner', 'manager', 'employee', 'counter_staff')`).

Change **only** the `POST /adjust` (around line 55) and `POST /reconcile` (around line 187) occurrences — leave `PUT /transfers/:id/receive` (around line 420) untouched, since stock transfers between locations aren't part of florist's approved scope.

Since both target lines currently share identical text with the one you must leave alone, do this as two targeted single-occurrence edits (not `replace_all`) — use enough surrounding context (the route's `body(...)` validators immediately below each `authorize()` call differ between `/adjust` and `/reconcile`) to match each one individually:

For `POST /adjust` (identify by the following context: `body('material_id').isInt().withMessage('Material ID is required'),` appears shortly after):
```js
  authorize('owner', 'manager', 'employee', 'counter_staff'),
```
→
```js
  authorize('owner', 'manager', 'employee', 'counter_staff', 'florist_staff'),
```

For `POST /reconcile` (identify by the following context: `body('entries').isArray({ min: 1 }).withMessage('At least one entry is required'),` appears shortly after):
```js
  authorize('owner', 'manager', 'employee', 'counter_staff'),
```
→
```js
  authorize('owner', 'manager', 'employee', 'counter_staff', 'florist_staff'),
```

- [ ] **Step 3: Add `'florist_staff'` to `attendance.js`'s clock-in, clock-out, and history routes only**

Re-verify current text with `grep -n "authorize(" server/routes/attendance.js` (post-Task-4, these read `authorize('owner', 'manager', 'employee', 'counter_staff', 'delivery_partner')`).

Change **only** `POST /clock-in` (line ~85) and `POST /clock-out` (line ~144) and `GET /` (line ~259, the "own attendance history" route) — leave `GET /today`, `/outdoor-duty` (both routes), and `/salary-advance` (both routes) untouched, since those are outside florist's approved scope per the design spec.

These three target lines currently share identical text with lines you must leave alone, so use targeted single-occurrence edits identified by surrounding route context (`router.post('/clock-in', ...`, `router.post('/clock-out', ...`, `router.get('/', authorize(...` — the bare `'/'` path distinguishes it from `/today` and `/outdoor-duty`):

```js
authorize('owner', 'manager', 'employee', 'counter_staff', 'delivery_partner')
```
→ (for these 3 specific routes only)
```js
authorize('owner', 'manager', 'employee', 'counter_staff', 'florist_staff', 'delivery_partner')
```

Also update the self-scoping check at line ~269 (inside the `GET /` route body — this line was already changed by Task 4 to include `counter_staff`; extend it once more here):

```js
if (['employee', 'counter_staff', 'delivery_partner'].includes(req.user.role)) {
```
→
```js
if (['employee', 'counter_staff', 'florist_staff', 'delivery_partner'].includes(req.user.role)) {
```

Do NOT touch the identical-looking checks at lines ~577 and ~661 — those are inside `/outdoor-duty` and `/salary-advance`, which florist_staff cannot reach (the `authorize()` guard on those routes rejects them before this line ever executes), so changing them would be dead code at best and a scope violation of the approved boundary at worst.

- [ ] **Step 4: Append verification checks**

```js
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
  if (expensesRes.status !== 403) throw new Error(`Expected florist_staff to be BLOCKED from GET /expenses, got ${expensesRes.status}`);
});

check('florist_staff cannot start a task assigned to someone else (ownership check holds for the new role)', async () => {
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
});
```

- [ ] **Step 5: Restart dev server, run the full script**

Run: `cd server && (pkill -f "node server.js" || true) && nohup node server.js > /tmp/petal-dev-server.log 2>&1 & sleep 2 && node scripts/verify-identity-roles.js`

Expected: all checks pass (the second check may print a skip note if the dev DB has no pending task — that's acceptable, note it in your report rather than fabricating a task to force the check).

- [ ] **Step 6: `git add` (do not commit)**

Run: `git add server/routes/production.js server/routes/stock.js server/routes/attendance.js server/scripts/verify-identity-roles.js`

---

### Task 6: Frontend — `MainNavigator.js` tab wiring

**Files:**
- Modify: `app/src/navigation/MainNavigator.js`

**Interfaces:**
- Consumes: nothing new from earlier tasks (pure frontend routing).
- Produces: a `FloristStack` component and tab entry; `counter_staff` added to every tab `employee` currently gets; `florist_staff` added to the Attendance tab. Task 10 (LockScreen/RootNavigator) doesn't touch this file, but assumes `counter_staff`/`florist_staff` sessions land in a working tab layout once unlocked.

- [ ] **Step 1: Re-verify current line numbers**

Run: `grep -n "role === 'owner' || role === 'manager' || role === 'employee'\|role === 'employee'\|role === 'employee' || role === 'delivery_partner'" app/src/navigation/MainNavigator.js`

Confirm the 4 lines match what's described below before editing (this file wasn't touched by any earlier task in this plan, but re-verify per the project's established discipline of never trusting a plan's line numbers blindly).

- [ ] **Step 2: POS tab — add `counter_staff`**

Change:
```jsx
      {/* POS tab — Owner, Manager, Employee */}
      {(role === 'owner' || role === 'manager' || role === 'employee') && (
```
to:
```jsx
      {/* POS tab — Owner, Manager, Employee, Counter Staff */}
      {(role === 'owner' || role === 'manager' || role === 'employee' || role === 'counter_staff') && (
```

- [ ] **Step 3: EmployeeOrders tab — add `counter_staff`**

Change:
```jsx
      {/* Orders tab — Employee (Orders Inbox + Log Order only, spec §5) */}
      {role === 'employee' && (
```
to:
```jsx
      {/* Orders tab — Employee, Counter Staff (Orders Inbox + Log Order only, spec §5) */}
      {(role === 'employee' || role === 'counter_staff') && (
```

- [ ] **Step 4: Inventory tab — add `counter_staff`**

Change:
```jsx
      {/* Owner, Manager, and Employee see Inventory tab */}
      {(role === 'owner' || role === 'manager' || role === 'employee') && (
```
to:
```jsx
      {/* Owner, Manager, Employee, and Counter Staff see Inventory tab */}
      {(role === 'owner' || role === 'manager' || role === 'employee' || role === 'counter_staff') && (
```

- [ ] **Step 5: Attendance tab — add `counter_staff` and `florist_staff`**

Change:
```jsx
      {/* Attendance tab — Employee & Delivery Partner only (owner/manager access from More) */}
      {(role === 'employee' || role === 'delivery_partner') && (
```
to:
```jsx
      {/* Attendance tab — Employee, Counter Staff, Florist/Prep Staff & Delivery Partner (owner/manager access from More) */}
      {(role === 'employee' || role === 'counter_staff' || role === 'florist_staff' || role === 'delivery_partner') && (
```

- [ ] **Step 6: Add a `FloristStack` component and its tab entry**

Find the `EmployeeOrdersStack` function (added in sub-project 1) with `grep -n "function EmployeeOrdersStack" -A 15 app/src/navigation/MainNavigator.js` — model the new stack on it, using the same `Stack.Navigator`/`stackScreenOptions` pattern:

```jsx
// ─── Florist/Prep Stack (Florist/Prep Staff — Production queue + the
// order detail it links to; no POS/Checkout/Orders-inbox/Inventory/
// Expenses, per the approved florist permission boundary) ──
function FloristStack() {
  return (
    <Stack.Navigator screenOptions={stackScreenOptions}>
      <Stack.Screen name="ProductionQueue" component={ProductionQueueScreen} options={{ title: 'Production Queue' }} />
      <Stack.Screen name="SaleDetail" component={SaleDetailScreen} options={{ title: 'Sale Details' }} />
    </Stack.Navigator>
  );
}
```

Place this function definition near `EmployeeOrdersStack` (both are small, single-role stacks — keeping them adjacent matches the file's existing convention of grouping related stacks together).

Add the tab entry immediately after the Inventory tab block from Step 4:

```jsx
      {/* Production tab — Florist/Prep Staff only */}
      {role === 'florist_staff' && (
        <Tab.Screen
          name="Florist"
          component={FloristStack}
          options={{ tabBarLabel: 'Production' }}
          listeners={({ navigation }) => ({
            tabPress: () => {
              navigation.navigate('Florist', { screen: 'ProductionQueue' });
            },
          })}
        />
      )}
```

`ProductionQueueScreen` and `SaleDetailScreen` are already imported at the top of this file (both are used by the existing `OrdersStack`/`PickupsStack`) — no new imports needed. Verify with `grep -n "^import ProductionQueueScreen\|^import SaleDetailScreen" app/src/navigation/MainNavigator.js` before assuming.

- [ ] **Step 7: Add a role entry to `TAB_ICONS`**

Run: `grep -n "TAB_ICONS = {" -A 10 app/src/navigation/MainNavigator.js`

Add a `Florist` entry alongside the existing ones (matching the pattern already used for `EmployeeOrders`):

```js
  Florist: { active: 'flower', inactive: 'flower-outline' },
```

(`flower`/`flower-outline` are valid Ionicons names — verify with `grep -rn "'flower" node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/glyphmaps/Ionicons.json 2>/dev/null | head -3` if available; if `flower` isn't present in the installed icon set, use `'leaf'`/`'leaf-outline'` instead — the same icon `Inventory` already uses is an acceptable fallback since it's still thematically close and definitely present.)

- [ ] **Step 8: Manual sanity check (no automated test possible for navigation without a running app)**

This project has no eslint config/script — the established verification method from sub-project 1 is a real babel transform using the project's own configured preset. Run:
```bash
cd app && node -e "
const babel = require('@babel/core');
const files = ['src/navigation/MainNavigator.js'];
for (const f of files) {
  try {
    babel.transformFileSync(f, { presets: ['babel-preset-expo'] });
    console.log('✅', f);
  } catch (e) {
    console.error('❌', f, e.message);
    process.exitCode = 1;
  }
}
"
```
Expected: `✅ src/navigation/MainNavigator.js`. This confirms valid syntax and resolvable imports — it cannot verify the tabs actually render correctly for each role — flag that for the owner's own device testing per this plan's final task.

- [ ] **Step 9: `git add` (do not commit)**

Run: `git add app/src/navigation/MainNavigator.js`

---

### Task 7: Frontend — parity/boundary fixes across smaller screens

**Files:**
- Modify: `app/src/screens/DashboardScreen.js`, `app/src/screens/StockOverviewScreen.js`, `app/src/screens/AttendanceScreen.js`, `app/src/screens/SaleDetailScreen.js`, `app/src/screens/ProductsScreen.js`, `app/src/screens/PurchaseOrderDetailScreen.js`, `app/src/screens/ProductionQueueScreen.js`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure frontend).
- Produces: `counter_staff` gets identical dashboard/attendance/products/purchase-order UI to `employee`; `florist_staff` gets the existing employee-flavored dashboard (task widget) and attendance UI reused, plus appears in the task-assignment picker.

- [ ] **Step 1: `DashboardScreen.js` — extend `isEmployee` and `isStaff`**

Re-verify with `grep -n "isStaff = \|isEmployee = " app/src/screens/DashboardScreen.js`. Change:

```js
  const isStaff = role === 'owner' || role === 'manager' || role === 'employee';
  const isOwnerOrManager = role === 'owner' || role === 'manager';
  const isEmployee = role === 'employee';
```

to:

```js
  const isStaff = role === 'owner' || role === 'manager' || role === 'employee' || role === 'counter_staff' || role === 'florist_staff';
  const isOwnerOrManager = role === 'owner' || role === 'manager';
  const isEmployee = role === 'employee' || role === 'counter_staff' || role === 'florist_staff';
```

This means `florist_staff` automatically gets the existing "your production tasks and work queue" dashboard view (task counts, task list) that today's `employee` role already shows — no new dashboard code needed, this is the same `myTasks` widget reused as-is (verify by reading the code around `isEmployee ? 'Your production tasks and work queue'` — `grep -n "isEmployee ? 'Your production" app/src/screens/DashboardScreen.js` — confirm this line and the `myTasks` rendering block still exist unchanged before assuming the reuse is this clean; if the file has drifted, report the discrepancy rather than forcing the change).

- [ ] **Step 2: `StockOverviewScreen.js` — extend `isEmployee`**

Change:
```js
  const isEmployee = user?.role === 'employee';
```
to:
```js
  const isEmployee = user?.role === 'employee' || user?.role === 'counter_staff';
```

Do NOT add `florist_staff` here — florist_staff has no navigation path to this screen at all in this plan (no Inventory tab), so this is dead-but-harmless if left as `employee`/`counter_staff` only; adding florist_staff would be presenting a UI affordance for a screen they can't currently reach via any tab, which is confusing rather than helpful.

- [ ] **Step 3: `AttendanceScreen.js` — extend `isStaff`**

Change:
```js
  const isStaff = role === 'owner' || role === 'manager' || role === 'employee' || role === 'delivery_partner';
```
to:
```js
  const isStaff = role === 'owner' || role === 'manager' || role === 'employee' || role === 'counter_staff' || role === 'florist_staff' || role === 'delivery_partner';
```

- [ ] **Step 4: `SaleDetailScreen.js` — extend the edit-ownership check**

Re-verify with `grep -n "role === 'employee'" app/src/screens/SaleDetailScreen.js`. Change:
```js
      : (user?.role === 'employee' && sale.created_by !== user?.id)
```
to:
```js
      : (['employee', 'counter_staff'].includes(user?.role) && sale.created_by !== user?.id)
```

- [ ] **Step 5: `ProductsScreen.js` and `PurchaseOrderDetailScreen.js` — extend the two remaining OR-chains**

`ProductsScreen.js`, re-verify with `grep -n "role === 'employee'" app/src/screens/ProductsScreen.js`:
```jsx
      {(user?.role === 'owner' || user?.role === 'manager' || user?.role === 'employee') && (
```
→
```jsx
      {(user?.role === 'owner' || user?.role === 'manager' || user?.role === 'employee' || user?.role === 'counter_staff') && (
```

`PurchaseOrderDetailScreen.js`, re-verify with `grep -n "role === 'employee'" app/src/screens/PurchaseOrderDetailScreen.js`:
```jsx
          {!receiveMode && (canReceive || canEdit || canCancel) && (user?.role === 'owner' || user?.role === 'manager' || user?.role === 'employee') && (
```
→
```jsx
          {!receiveMode && (canReceive || canEdit || canCancel) && (user?.role === 'owner' || user?.role === 'manager' || user?.role === 'employee' || user?.role === 'counter_staff') && (
```

- [ ] **Step 6: `ProductionQueueScreen.js` — include the new roles in the assignable-staff picker**

Re-verify with `grep -n "staffList = " app/src/screens/ProductionQueueScreen.js`. Change:
```js
      const staffList = (Array.isArray(allUsers) ? allUsers : []).filter(u => ['owner', 'manager', 'employee'].includes(u.role));
```
to:
```js
      const staffList = (Array.isArray(allUsers) ? allUsers : []).filter(u => ['owner', 'manager', 'employee', 'counter_staff', 'florist_staff'].includes(u.role));
```

- [ ] **Step 7: Lint check**

Same babel-transform method as Task 6 Step 8 (no eslint in this project). Run:
```bash
cd app && node -e "
const babel = require('@babel/core');
const files = [
  'src/screens/DashboardScreen.js', 'src/screens/StockOverviewScreen.js',
  'src/screens/AttendanceScreen.js', 'src/screens/SaleDetailScreen.js',
  'src/screens/ProductsScreen.js', 'src/screens/PurchaseOrderDetailScreen.js',
  'src/screens/ProductionQueueScreen.js',
];
for (const f of files) {
  try { babel.transformFileSync(f, { presets: ['babel-preset-expo'] }); console.log('✅', f); }
  catch (e) { console.error('❌', f, e.message); process.exitCode = 1; }
}
"
```
Expected: all 7 files print ✅.

- [ ] **Step 8: `git add` (do not commit)**

Run: `git add app/src/screens/DashboardScreen.js app/src/screens/StockOverviewScreen.js app/src/screens/AttendanceScreen.js app/src/screens/SaleDetailScreen.js app/src/screens/ProductsScreen.js app/src/screens/PurchaseOrderDetailScreen.js app/src/screens/ProductionQueueScreen.js`

---

### Task 8: Frontend — `UserFormScreen.js` role picker + employee code/PIN management

**Files:**
- Modify: `app/src/screens/UserFormScreen.js`
- Modify: `app/src/constants/theme.js`
- Modify: `app/src/services/api.js`

**Interfaces:**
- Consumes: `PUT /api/users/:id/pin` from Task 3; `employee_code`/`job_title` fields on the user object from Task 3's `USER_SELECT_FIELDS`.
- Produces: `api.setUserPin(userId, pin)` — no other task consumes this (used only within this screen).

- [ ] **Step 1: Add two role colors to `theme.js`**

Re-verify with `grep -n "roleEmployee:" app/src/constants/theme.js`. Add immediately after:

```js
  roleCounterStaff: '#FF9800',
  roleFloristStaff: '#4CAF50',
```

(Reusing `roleEmployee`'s existing orange for `roleCounterStaff` since it IS the same access level, just relabeled going forward, would also be defensible — but a distinct color makes the two new tiles visually distinguishable from legacy `employee` accounts in the staff list, which is more useful during the transition period where all three coexist. Green for florist is a deliberate, thematically-fitting choice — a flower shop's prep staff.)

- [ ] **Step 2: Add `api.setUserPin`**

In `app/src/services/api.js`, find the `// ─── Users ───` section (`grep -n "// ─── Users" app/src/services/api.js`) and add, alongside the other user-management methods:

```js
  setUserPin(userId, pin) {
    return this.request(`/users/${userId}/pin`, {
      method: 'PUT',
      body: JSON.stringify({ pin }),
    });
  }
```

- [ ] **Step 3: Extend `UserFormScreen.js`'s `ROLES` and `ROLE_LABELS`**

Change:
```js
const ROLES = [
  { key: 'owner', label: 'Owner', icon: 'key', color: Colors.roleOwner || '#EAB308' },
  { key: 'manager', label: 'Manager', icon: 'shield', color: Colors.roleManager },
  { key: 'employee', label: 'Employee', icon: 'person', color: Colors.roleEmployee },
  { key: 'delivery_partner', label: 'Delivery Partner', icon: 'bicycle', color: Colors.roleDelivery },
  { key: 'customer', label: 'Customer', icon: 'cart', color: Colors.roleCustomer },
];

const ROLE_LABELS = {
  owner: 'Owner',
  manager: 'Manager',
  employee: 'Employee',
  delivery_partner: 'Delivery Partner',
  customer: 'Customer',
};
```
to:
```js
const ROLES = [
  { key: 'owner', label: 'Owner', icon: 'key', color: Colors.roleOwner || '#EAB308' },
  { key: 'manager', label: 'Manager', icon: 'shield', color: Colors.roleManager },
  { key: 'employee', label: 'Employee (legacy)', icon: 'person', color: Colors.roleEmployee },
  { key: 'counter_staff', label: 'Counter Staff', icon: 'storefront', color: Colors.roleCounterStaff },
  { key: 'florist_staff', label: 'Florist/Prep Staff', icon: 'flower', color: Colors.roleFloristStaff },
  { key: 'delivery_partner', label: 'Delivery Partner', icon: 'bicycle', color: Colors.roleDelivery },
  { key: 'customer', label: 'Customer', icon: 'cart', color: Colors.roleCustomer },
];

const ROLE_LABELS = {
  owner: 'Owner',
  manager: 'Manager',
  employee: 'Employee (legacy)',
  counter_staff: 'Counter Staff',
  florist_staff: 'Florist/Prep Staff',
  delivery_partner: 'Delivery Partner',
  customer: 'Customer',
};
```

("Employee (legacy)" label — not a code change, just makes the transition state legible to the owner in the UI: this role isn't broken or deprecated functionally, but the label should signal "this is the old bucket, consider moving them" without you having to remember that fact yourself weeks from now.)

- [ ] **Step 4: Extend the manager-visible role filter**

Change:
```js
  const availableRoles = isOwner
    ? ROLES
    : ROLES.filter((r) => ['employee', 'delivery_partner', 'customer'].includes(r.key));
```
to:
```js
  const availableRoles = isOwner
    ? ROLES
    : ROLES.filter((r) => ['employee', 'counter_staff', 'florist_staff', 'delivery_partner', 'customer'].includes(r.key));
```

- [ ] **Step 5: Show employee code + a "Set/Reset PIN" control when editing a staff account with a code-capable role**

Find the JSX block that renders the role grid in edit mode (`grep -n "canChangeRole" app/src/screens/UserFormScreen.js` to locate it — this is inside the role-change section added when the file was last touched). Add a new block right after that section, still inside the same `isEditing` guard, following the file's existing `Alert`/`api` call conventions used elsewhere in this file (e.g. the existing role-change handler's `Alert.alert(...)` confirmation pattern):

```jsx
        {isEditing && ['counter_staff', 'florist_staff', 'employee'].includes(existingUser?.role) && (
          <View style={styles.pinSection}>
            <Text style={styles.sectionLabel}>Shared-device login</Text>
            {existingUser?.employee_code ? (
              <>
                <Text style={styles.employeeCodeText}>Employee code: {existingUser.employee_code}</Text>
                <TouchableOpacity style={styles.setPinButton} onPress={handleSetPin}>
                  <Ionicons name="keypad" size={18} color={Colors.primary} />
                  <Text style={styles.setPinButtonText}>Set / Reset PIN</Text>
                </TouchableOpacity>
              </>
            ) : (
              <Text style={styles.noCodeText}>
                No employee code yet — change this account's role to Counter Staff or Florist/Prep Staff above and save, or recreate it as one of those roles, to get a code.
              </Text>
            )}
          </View>
        )}
```

Add the handler function alongside the file's other handlers (near `handleChangeRole`, using the same `Platform.OS === 'web'` branching this codebase already uses elsewhere for `Alert.alert` on web — verify the exact pattern with `grep -n "Platform.OS === 'web'" app/src/screens/*.js | head -3` and match it, since `Alert.alert` with a text-input prompt doesn't exist cross-platform in React Native and this codebase has already solved this exact problem elsewhere for confirmation dialogs; a PIN entry needs an actual input, so use a simple local `useState`-backed inline form instead of `Alert.prompt` — Alert.prompt is iOS-only and unavailable on Android/web, which this codebase must already avoid given it targets all three):

```js
  const [pinModalVisible, setPinModalVisible] = useState(false);
  const [newPin, setNewPin] = useState('');
  const [pinSaving, setPinSaving] = useState(false);

  const handleSetPin = () => {
    setNewPin('');
    setPinModalVisible(true);
  };

  const submitPin = async () => {
    if (!/^\d{4}$/.test(newPin)) {
      Alert.alert('Invalid PIN', 'Enter exactly 4 digits.');
      return;
    }
    setPinSaving(true);
    try {
      await api.setUserPin(existingUser.id, newPin);
      setPinModalVisible(false);
      Alert.alert('PIN Set', `${existingUser.name}'s PIN has been updated.`);
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to set PIN');
    } finally {
      setPinSaving(false);
    }
  };
```

Add a minimal modal for PIN entry, placed at the end of the component's returned JSX (as a sibling to the outermost container, matching how this codebase renders other modals — verify the pattern with `grep -n "Modal" app/src/screens/UserFormScreen.js`; if this file has no existing `Modal` usage to match, use React Native's built-in `Modal` component directly):

```jsx
      <Modal visible={pinModalVisible} transparent animationType="fade" onRequestClose={() => setPinModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Set PIN for {existingUser?.name}</Text>
            <Input
              value={newPin}
              onChangeText={(t) => setNewPin(t.replace(/[^0-9]/g, '').slice(0, 4))}
              keyboardType="number-pad"
              placeholder="4-digit PIN"
              maxLength={4}
              secureTextEntry
            />
            <View style={styles.modalButtons}>
              <Button title="Cancel" variant="secondary" onPress={() => setPinModalVisible(false)} />
              <Button title={pinSaving ? 'Saving…' : 'Save PIN'} onPress={submitPin} disabled={pinSaving} />
            </View>
          </View>
        </View>
      </Modal>
```

Add `Modal` to the `react-native` import line at the top of the file (`grep -n "^import {" app/src/screens/UserFormScreen.js` to find it and add `Modal` to the destructured list).

Add corresponding styles to the file's `StyleSheet.create({...})` block at the bottom, matching the existing style-naming/value conventions already used in this file (check `Spacing`/`BorderRadius`/`Colors` values already in use nearby and reuse the same scale rather than inventing new magic numbers):

```js
  pinSection: { marginTop: Spacing.lg, padding: Spacing.md, backgroundColor: Colors.background, borderRadius: BorderRadius.md },
  sectionLabel: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.textSecondary, marginBottom: Spacing.sm },
  employeeCodeText: { fontSize: FontSize.md, color: Colors.text, marginBottom: Spacing.sm },
  setPinButton: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start' },
  setPinButtonText: { color: Colors.primary, fontWeight: '600' },
  noCodeText: { fontSize: FontSize.sm, color: Colors.textLight },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: Spacing.lg },
  modalCard: { backgroundColor: Colors.white, borderRadius: BorderRadius.lg, padding: Spacing.lg, width: '100%', maxWidth: 360 },
  modalTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, marginBottom: Spacing.md },
  modalButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: Spacing.sm, marginTop: Spacing.md },
```

- [ ] **Step 6: Lint check**

Same babel-transform method as Task 6 Step 8 (no eslint in this project). Run:
```bash
cd app && node -e "
const babel = require('@babel/core');
const files = ['src/screens/UserFormScreen.js', 'src/constants/theme.js', 'src/services/api.js'];
for (const f of files) {
  try { babel.transformFileSync(f, { presets: ['babel-preset-expo'] }); console.log('✅', f); }
  catch (e) { console.error('❌', f, e.message); process.exitCode = 1; }
}
"
```
Expected: all 3 files print ✅.

- [ ] **Step 7: `git add` (do not commit)**

Run: `git add app/src/screens/UserFormScreen.js app/src/constants/theme.js app/src/services/api.js`

---

### Task 9: Frontend — `AuthContext` staff-login/lock state + `api.js` client methods

**Files:**
- Modify: `app/src/context/AuthContext.js`
- Modify: `app/src/services/api.js`

**Interfaces:**
- Consumes: `POST /api/auth/staff-login`, `GET /api/auth/staff-roster` from Task 2.
- Produces: `useAuth()` gains `locked: boolean`, `staffLogin(employeeCode, pin): Promise<response>`, `lock(): void`, `unlock(): void` (called internally by `staffLogin`, exposed in case `LockScreen` in Task 10 needs to force a re-lock e.g. after an owner/manager phone+password login on the shared device). `api.staffLogin(employeeCode, pin)`, `api.getStaffRoster(locationId)` — Task 10's `LockScreen` calls these exact names.

- [ ] **Step 1: Add API client methods**

In `app/src/services/api.js`, add alongside the existing `login` method:

```js
  staffLogin(employeeCode, pin) {
    return this.request('/auth/staff-login', {
      method: 'POST',
      body: JSON.stringify({ employee_code: employeeCode, pin }),
    });
  }

  getStaffRoster(locationId) {
    return this.request(`/auth/staff-roster?location_id=${locationId}`);
  }
```

- [ ] **Step 2: Add `locked` to `AuthContext`'s reducer state**

Change the `initialState` object:
```js
const initialState = {
  user: null,
  token: null,
  locations: [],
  activeLocation: null,
  isLoading: true,
  isAuthenticated: false,
  isSetupComplete: null,
  settings: {},
};
```
to:
```js
const initialState = {
  user: null,
  token: null,
  locations: [],
  activeLocation: null,
  isLoading: true,
  isAuthenticated: false,
  isSetupComplete: null,
  settings: {},
  locked: true,
};
```

- [ ] **Step 3: Add `LOCK`/`UNLOCK` reducer cases, and set `locked: false` in the existing `LOGIN`/`RESTORE_TOKEN` cases**

Change the `RESTORE_TOKEN` case:
```js
    case 'RESTORE_TOKEN':
      return {
        ...state,
        user: action.user,
        token: action.token,
        locations: action.locations || [],
        activeLocation: action.activeLocation || null,
        isLoading: false,
        isAuthenticated: !!action.token,
        isSetupComplete: true,
      };
```
to:
```js
    case 'RESTORE_TOKEN':
      return {
        ...state,
        user: action.user,
        token: action.token,
        locations: action.locations || [],
        activeLocation: action.activeLocation || null,
        isLoading: false,
        isAuthenticated: !!action.token,
        isSetupComplete: true,
        locked: false,
      };
```

(Restoring a saved session on app relaunch counts as "already unlocked" — the idle-lock in Task 10 re-locks it on its own schedule from there; this matches how the app worked before this plan for every existing role, and avoids forcing a PIN/password re-entry on every cold start, which the design spec never asked for.)

Change the `LOGIN` case the same way — add `locked: false,` to its returned object.

Add two new reducer cases, alongside the existing ones:
```js
    case 'LOCK':
      return { ...state, locked: true };
    case 'UNLOCK':
      return { ...state, locked: false };
```

- [ ] **Step 4: Add `staffLogin`, `lock`, `unlock` actions**

Add alongside the existing `login` action (following its exact same shape — same `AsyncStorage` writes, same settings-fetch-after-login behavior):

```js
  const staffLogin = async (employeeCode, pin) => {
    const response = await api.staffLogin(employeeCode, pin);
    const { user, token, locations } = response.data;

    api.setToken(token);
    await AsyncStorage.setItem(STORAGE_KEY_TOKEN, token);
    await AsyncStorage.setItem(STORAGE_KEY_USER, JSON.stringify(user));

    const activeLocation = locations && locations.length > 0 ? locations[0] : null;
    if (activeLocation) {
      await AsyncStorage.setItem(STORAGE_KEY_LOCATION, JSON.stringify(activeLocation));
    }

    dispatch({ type: 'LOGIN', user, token, locations, activeLocation });

    try {
      const settingsRes = await api.getSettings();
      dispatch({ type: 'SET_SETTINGS', settings: settingsRes.data?.settings || {} });
    } catch (e) {
      console.log('Failed to fetch settings after staff login:', e);
    }

    return response;
  };

  const lock = () => dispatch({ type: 'LOCK' });
  const unlock = () => dispatch({ type: 'UNLOCK' });
```

- [ ] **Step 5: Expose the new actions from the context value**

Change:
```js
  const value = {
    ...state,
    login,
    register,
    ownerSetup,
    logout,
    updateUser,
    setActiveLocation,
    refreshSettings,
  };
```
to:
```js
  const value = {
    ...state,
    login,
    staffLogin,
    register,
    ownerSetup,
    logout,
    lock,
    unlock,
    updateUser,
    setActiveLocation,
    refreshSettings,
  };
```

- [ ] **Step 6: Manual verification (no test runner for this file either — a runtime check)**

Same babel-transform method as Task 6 Step 8 (no eslint in this project). Run:
```bash
cd app && node -e "
const babel = require('@babel/core');
const files = ['src/context/AuthContext.js', 'src/services/api.js'];
for (const f of files) {
  try { babel.transformFileSync(f, { presets: ['babel-preset-expo'] }); console.log('✅', f); }
  catch (e) { console.error('❌', f, e.message); process.exitCode = 1; }
}
"
```
Expected: both files print ✅. Full behavioral verification (staff-login actually swapping the session) requires Task 10's `LockScreen` to exist — flag this task as verified-by-lint-only until Task 10 completes, and note in your report that Task 10's implementer should confirm this file's `staffLogin` works end-to-end once the screen calling it exists.

- [ ] **Step 7: `git add` (do not commit)**

Run: `git add app/src/context/AuthContext.js app/src/services/api.js`

---

### Task 10: Frontend — `LockScreen`, idle timer, Switch User button, `RootNavigator` wiring

**Files:**
- Create: `app/src/screens/LockScreen.js`
- Create: `app/src/hooks/useIdleLock.js`
- Create: `app/src/components/SwitchUserButton.js`
- Modify: `app/src/navigation/RootNavigator.js`
- Modify: `app/src/navigation/MainNavigator.js` (wire `SwitchUserButton` into `stackScreenOptions`)
- Modify: `app/src/context/AuthContext.js` (store/read the device's configured location for the roster fetch)

**Interfaces:**
- Consumes: `useAuth().locked`, `staffLogin`, `lock` from Task 9; `api.getStaffRoster` from Task 9.
- Produces: nothing further consumed by later tasks — this is the last piece of the login flow.

- [ ] **Step 1: Persist a device location for the roster fetch**

The lock screen needs to know which location's staff roster to show *before* anyone is logged in (so it can't read `state.activeLocation`, which only exists post-login). Add a new `AsyncStorage` key and a setter in `AuthContext.js`.

Add near the top of `AuthContext.js`, alongside the other `STORAGE_KEY_*` constants:
```js
const STORAGE_KEY_DEVICE_LOCATION = '@bloomcart_device_location';
```

Add a new action, alongside `setActiveLocation`:
```js
  const setDeviceLocationId = async (locationId) => {
    await AsyncStorage.setItem(STORAGE_KEY_DEVICE_LOCATION, String(locationId));
  };

  const getDeviceLocationId = async () => {
    return AsyncStorage.getItem(STORAGE_KEY_DEVICE_LOCATION);
  };
```

Expose both from the context value (add to the object from Task 9 Step 5): `setDeviceLocationId, getDeviceLocationId,`.

This is intentionally simple: the FIRST time any owner/manager logs into a shared device via phone+password, `activeLocation` gets set as it already does today (existing `login` behavior, unchanged) — `LockScreen` (Step 3 below) additionally calls `setDeviceLocationId` whenever it learns the location from a successful login on that device, so subsequent cold starts (before anyone's logged in yet) have a location to fetch the roster for. If no device location is stored yet (a brand-new device that's never had anyone log in), `LockScreen` shows the "Owner/Manager login" link only, with a plain-language note instead of an empty tile grid.

- [ ] **Step 2: `useIdleLock` hook**

```js
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

const IDLE_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

/**
 * Locks the app after a period of inactivity. Call `bump()` on any
 * user-initiated navigation/touch to reset the timer. Does NOT lock
 * on brief backgrounding (e.g. answering a call) — only on sustained
 * foreground idle time or returning from the background after the
 * timeout has already elapsed.
 */
export default function useIdleLock(enabled, onIdle) {
  const lastActivity = useRef(Date.now());

  const bump = () => {
    lastActivity.current = Date.now();
  };

  useEffect(() => {
    if (!enabled) return;

    const interval = setInterval(() => {
      if (Date.now() - lastActivity.current > IDLE_TIMEOUT_MS) {
        onIdle();
      }
    }, 15000);

    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active' && Date.now() - lastActivity.current > IDLE_TIMEOUT_MS) {
        onIdle();
      } else if (nextState === 'active') {
        bump();
      }
    });

    return () => {
      clearInterval(interval);
      sub.remove();
    };
  }, [enabled]);

  return { bump };
}
```

- [ ] **Step 3: `LockScreen.js`**

```jsx
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, FlatList, Image, ActivityIndicator, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

export default function LockScreen({ navigation }) {
  const { staffLogin, getDeviceLocationId, user } = useAuth();
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [locationId, setLocationId] = useState(null);
  const [selectedStaff, setSelectedStaff] = useState(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const loadRoster = useCallback(async () => {
    setLoading(true);
    try {
      // Prefer the currently-locked user's own location if we have one
      // (they were just using this device); otherwise fall back to
      // whatever location this device last saw during any login.
      const locId = user?.locations?.[0]?.id || (await getDeviceLocationId());
      if (!locId) {
        setStaff([]);
        setLoading(false);
        return;
      }
      setLocationId(locId);
      const res = await api.getStaffRoster(locId);
      setStaff(res.data?.staff || []);
    } catch {
      setStaff([]);
    } finally {
      setLoading(false);
    }
  }, [user, getDeviceLocationId]);

  useEffect(() => { loadRoster(); }, [loadRoster]);

  const handleDigit = (d) => {
    if (pin.length >= 4 || submitting) return;
    const next = pin + d;
    setPin(next);
    setError('');
    if (next.length === 4) submitPin(next);
  };

  const handleBackspace = () => setPin((p) => p.slice(0, -1));

  const submitPin = async (fullPin) => {
    setSubmitting(true);
    try {
      await staffLogin(selectedStaff.employee_code, fullPin);
      // AuthContext's LOGIN action already flips locked:false — nothing
      // else to do here, RootNavigator swaps to MainNavigator on its own.
    } catch (err) {
      setError(err.message || 'Something went wrong');
      setPin('');
    } finally {
      setSubmitting(false);
    }
  };

  if (selectedStaff) {
    return (
      <View style={styles.container}>
        <TouchableOpacity style={styles.backLink} onPress={() => { setSelectedStaff(null); setPin(''); setError(''); }}>
          <Ionicons name="chevron-back" size={20} color={Colors.textSecondary} />
          <Text style={styles.backLinkText}>Not {selectedStaff.name}?</Text>
        </TouchableOpacity>
        <Text style={styles.pinTitle}>{selectedStaff.name} — enter PIN</Text>
        <View style={styles.pinDots}>
          {[0, 1, 2, 3].map((i) => (
            <View key={i} style={[styles.pinDot, i < pin.length && styles.pinDotFilled]} />
          ))}
        </View>
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        {submitting ? (
          <ActivityIndicator color={Colors.primary} style={{ marginTop: Spacing.lg }} />
        ) : (
          <View style={styles.keypad}>
            {['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map((k, i) => (
              <TouchableOpacity
                key={i}
                style={styles.keypadKey}
                disabled={k === ''}
                onPress={() => (k === '⌫' ? handleBackspace() : k !== '' && handleDigit(k))}
              >
                <Text style={styles.keypadKeyText}>{k}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Who's working?</Text>
      {loading ? (
        <ActivityIndicator color={Colors.primary} style={{ marginTop: Spacing.xl }} />
      ) : staff.length === 0 ? (
        <Text style={styles.emptyText}>
          No staff set up for shared-device login yet. Ask your manager to set this up, or use owner/manager login below.
        </Text>
      ) : (
        <FlatList
          data={staff}
          numColumns={2}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={styles.tileGrid}
          renderItem={({ item }) => (
            <TouchableOpacity style={styles.tile} onPress={() => setSelectedStaff(item)}>
              {item.avatar ? (
                <Image source={{ uri: api.getMediaUrl(item.avatar) }} style={styles.tileAvatar} />
              ) : (
                <View style={styles.tileAvatarPlaceholder}>
                  <Ionicons name="person" size={32} color={Colors.textLight} />
                </View>
              )}
              <Text style={styles.tileName}>{item.name}</Text>
              {item.job_title ? <Text style={styles.tileJobTitle}>{item.job_title}</Text> : null}
            </TouchableOpacity>
          )}
        />
      )}
      <TouchableOpacity style={styles.ownerLoginLink} onPress={() => navigation.navigate('Login')}>
        <Text style={styles.ownerLoginLinkText}>Owner / Manager login</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background, padding: Spacing.lg, justifyContent: 'center' },
  title: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text, textAlign: 'center', marginBottom: Spacing.lg },
  emptyText: { fontSize: FontSize.md, color: Colors.textSecondary, textAlign: 'center', marginTop: Spacing.xl },
  tileGrid: { paddingVertical: Spacing.md },
  tile: { flex: 1, alignItems: 'center', margin: Spacing.sm, padding: Spacing.lg, backgroundColor: Colors.surface, borderRadius: BorderRadius.lg, minHeight: 140, justifyContent: 'center' },
  tileAvatar: { width: 64, height: 64, borderRadius: 32, marginBottom: Spacing.sm },
  tileAvatarPlaceholder: { width: 64, height: 64, borderRadius: 32, backgroundColor: Colors.background, justifyContent: 'center', alignItems: 'center', marginBottom: Spacing.sm },
  tileName: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, textAlign: 'center' },
  tileJobTitle: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  ownerLoginLink: { marginTop: Spacing.xl, alignSelf: 'center' },
  ownerLoginLinkText: { color: Colors.textSecondary, fontSize: FontSize.sm, textDecorationLine: 'underline' },
  backLink: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.lg },
  backLinkText: { color: Colors.textSecondary, fontSize: FontSize.sm, marginLeft: 4 },
  pinTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, textAlign: 'center', marginBottom: Spacing.lg },
  pinDots: { flexDirection: 'row', justifyContent: 'center', gap: 16, marginBottom: Spacing.md },
  pinDot: { width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: Colors.border },
  pinDotFilled: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  errorText: { color: Colors.error, textAlign: 'center', marginBottom: Spacing.sm },
  keypad: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', marginTop: Spacing.lg, maxWidth: 320, alignSelf: 'center' },
  keypadKey: { width: 90, height: 70, justifyContent: 'center', alignItems: 'center' },
  keypadKeyText: { fontSize: FontSize.xl, fontWeight: '600', color: Colors.text },
});
```

- [ ] **Step 4: `SwitchUserButton.js`**

```jsx
import React from 'react';
import { TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../context/AuthContext';
import { Colors } from '../constants/theme';

export default function SwitchUserButton() {
  const { lock, user } = useAuth();

  // Owner/manager use phone+password on their own personal devices — the
  // button is still shown (they may be covering the shared counter device),
  // but this stays a plain lock action for every role, no special-casing.
  if (!user) return null;

  return (
    <TouchableOpacity onPress={lock} style={{ marginRight: 12 }} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
      <Ionicons name="lock-closed-outline" size={22} color={Colors.text} />
    </TouchableOpacity>
  );
}
```

- [ ] **Step 5: Wire `SwitchUserButton` into `stackScreenOptions`**

Run: `grep -n "const stackScreenOptions" -A 10 app/src/navigation/MainNavigator.js`

Add `headerRight: () => <SwitchUserButton />` to the shared options object (matching whatever other keys are already present — do not remove any existing key). Add the import at the top: `import SwitchUserButton from '../components/SwitchUserButton';`.

- [ ] **Step 6: Wire idle-lock + `LockScreen` into `RootNavigator.js`**

Change:
```jsx
import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import AuthNavigator from './AuthNavigator';
import MainNavigator from './MainNavigator';
import LoadingScreen from '../components/LoadingScreen';

export default function RootNavigator() {
  const { isAuthenticated, isLoading, isSetupComplete } = useAuth();

  if (isLoading) {
    return <LoadingScreen message="Starting Flower point..." />;
  }

  return (
    <NavigationContainer>
      {isAuthenticated ? (
        <MainNavigator />
      ) : (
        <AuthNavigator showSetup={isSetupComplete === false} />
      )}
    </NavigationContainer>
  );
}
```
to:
```jsx
import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useAuth } from '../context/AuthContext';
import AuthNavigator from './AuthNavigator';
import MainNavigator from './MainNavigator';
import LockScreen from '../screens/LockScreen';
import LoadingScreen from '../components/LoadingScreen';
import useIdleLock from '../hooks/useIdleLock';

const LockStack = createNativeStackNavigator();

function LockedNavigator() {
  return (
    <LockStack.Navigator screenOptions={{ headerShown: false }}>
      <LockStack.Screen name="Lock" component={LockScreen} />
      <LockStack.Screen name="Login" component={AuthNavigator} />
    </LockStack.Navigator>
  );
}

export default function RootNavigator() {
  const { isAuthenticated, isLoading, isSetupComplete, locked, lock } = useAuth();
  const { bump } = useIdleLock(isAuthenticated && !locked, lock);

  if (isLoading) {
    return <LoadingScreen message="Starting Flower point..." />;
  }

  return (
    <NavigationContainer onStateChange={bump}>
      {!isAuthenticated ? (
        <AuthNavigator showSetup={isSetupComplete === false} />
      ) : locked ? (
        <LockedNavigator />
      ) : (
        <MainNavigator />
      )}
    </NavigationContainer>
  );
}
```

`@react-navigation/native-stack`'s `createNativeStackNavigator` is already this project's convention — confirmed live in both `AuthNavigator.js` and `MainNavigator.js` — so no substitution is needed here.

Note the branching logic: `!isAuthenticated` (nobody has ever logged in on this device, or they logged out) shows the full `AuthNavigator` (today's phone+password flow, unchanged) — this is the ONLY entry point for a brand-new device or after an explicit logout. `isAuthenticated && locked` (someone's session exists but the device is PIN-locked) shows `LockedNavigator`, which is `LockScreen` by default with a way to drop into `AuthNavigator` for the "Owner/Manager login" link. `isAuthenticated && !locked` shows the normal app. This means the very first login on a fresh device is always via phone+password (by an owner/manager, who then hands the device to staff) — matching the design spec's rollout description in §9, and never inventing a way for a brand-new device to reach `LockScreen` before anyone has ever proven who they are on it.

- [ ] **Step 7: Lint check**

Same babel-transform method as Task 6 Step 8 (no eslint in this project). Run:
```bash
cd app && node -e "
const babel = require('@babel/core');
const files = [
  'src/screens/LockScreen.js', 'src/hooks/useIdleLock.js', 'src/components/SwitchUserButton.js',
  'src/navigation/RootNavigator.js', 'src/navigation/MainNavigator.js', 'src/context/AuthContext.js',
];
for (const f of files) {
  try { babel.transformFileSync(f, { presets: ['babel-preset-expo'] }); console.log('✅', f); }
  catch (e) { console.error('❌', f, e.message); process.exitCode = 1; }
}
"
```
Expected: all 6 files print ✅.

- [ ] **Step 8: `git add` (do not commit)**

Run: `git add app/src/screens/LockScreen.js app/src/hooks/useIdleLock.js app/src/components/SwitchUserButton.js app/src/navigation/RootNavigator.js app/src/navigation/MainNavigator.js app/src/context/AuthContext.js`

---

### Task 11: Final verification pass

**Files:**
- Modify: `server/scripts/verify-identity-roles.js` (append a completeness check)

**Interfaces:**
- Consumes: everything from Tasks 1-10.
- Produces: nothing further — this is the terminal task.

- [ ] **Step 1: Re-run the full backend verification script**

Run: `cd server && (pkill -f "node server.js" || true) && nohup node server.js > /tmp/petal-dev-server.log 2>&1 & sleep 2 && node scripts/verify-identity-roles.js`

Expected: every check from every task passes, `N/N`.

- [ ] **Step 2: Append a grep-based completeness check as a script comment (not an automated check — document it in the report instead)**

Run manually and paste the output into your task report:
```bash
grep -rn "'employee'" server/routes | grep -v "'counter_staff'" | grep -v "VALID_ROLES\|ROLE_LABEL"
```
Every line in the output must be one of the explicitly-documented "leave alone" exceptions from Task 4/5 (`staff-management.js`'s salary-advance/outdoor-duty routes, `purchase-orders.js`, `customers.js`, `deliveries.js`'s standalone routes, or similar) — if anything unexplained shows up, that's a real gap; fix it as part of this task rather than reporting it as a known limitation, since Task 11 is the last chance to catch it before handoff.

- [ ] **Step 3: Confirm the 4 live employee accounts are still completely unaffected**

Run: `psql "$DATABASE_URL" -c "SELECT id, name, role, employee_code, pin_hash FROM users WHERE role = 'employee';"` (or use the project's existing dev DB connection string from `server/.env`).

Expected: all 4 rows show `role='employee'`, `employee_code` and `pin_hash` both `NULL` — proving this entire sub-project shipped without touching a single byte of their live data, exactly as the design spec's Goal 4 requires.

- [ ] **Step 4: Write the final report**

Summarize in the task report: every file touched across all 11 tasks (for the eventual whole-branch review), the full list of "leave alone" decisions made during Task 4/5 with reasons (for the user's final summary), and an explicit list of what needs the owner's own device testing — at minimum: the actual tap-name → PIN-pad flow, the idle-lock timeout firing correctly, the "Owner/Manager login" fallback link, and a real florist_staff account's Dashboard/Production tab experience end to end.

- [ ] **Step 5: `git add` (do not commit)**

Run: `git add server/scripts/verify-identity-roles.js`
