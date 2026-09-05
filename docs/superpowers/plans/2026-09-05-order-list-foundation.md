# Order List Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the shared backend endpoints and frontend component/hook toolkit that the Orders Inbox, Deliveries, and Pickup Orders screen redesigns will all consume — landed and independently verified first, so those three screen-specific plans build on real, tested interfaces instead of ones only sketched in a design doc.

**Architecture:** Two additive backend changes (`sort=urgency` on `GET /sales`, a `total` count added to `GET /deliveries`) plus one new backend subsystem (a signed, unstored order-tracking token and its public endpoint) plus one new backend endpoint (per-date register-session listing) — all additive, no schema changes. On the frontend: a small `utils/contact.js` of pure functions, a `ContactButtons` component, a `useOrderListData` data-fetching hook, and the bounded filter/sort toolbar (`SortControl`, `ActiveFilterChips`, `FilterDrawer`, `OrderListToolbar`), plus `CollapsibleSection` and the register-session grouping pieces (`useRegisterSessions` hook + `DateSessionHeader` component).

**Tech Stack:** Express.js + `pg` (async `database-async.js` layer — this plan touches only routes already on that layer), Node's built-in `crypto` module (no new dependency), React Native + Expo, this project's own theme constants (`app/src/constants/theme.js`).

**Spec:** `docs/superpowers/specs/2026-09-05-order-list-screens-redesign-design.md` — §3, §3.1a, §3.2, §3.3, §4, and §5 are what this plan implements. Read it alongside this plan; this plan does not repeat the design rationale, only the concrete steps.

**Follow-on plans (not written yet, deliberately):** Orders Inbox redesign, Deliveries redesign, Pickup Orders redesign, and the Customer Tracking Page each get their own plan document once this one is built — their exact interfaces are locked by what actually gets built here, not guessed at in advance. See §10 of the design doc for why sequencing matters.

## Global Constraints

- No schema changes of any kind — every backend change here is a new optional query param, a new response field, or a brand-new route. (Design doc §2.)
- `sort=urgency`, when omitted, must leave `GET /sales`'s existing behavior byte-for-byte identical — the user was explicit that no screen's default ordering may change as a side effect of this work. (Design doc §3.2.)
- The tracking token must never be stored anywhere — it's a signature, verified fresh on every request. An invalid token (bad format or bad signature) always returns the same generic 404; never a different error for "malformed" vs. "wrong signature" (that would leak information to someone probing the endpoint). (Design doc §5.)
- This codebase has no unit test runner (no jest/mocha configured in either `package.json`). Its established verification convention is: backend logic gets a permanent check added to a `server/scripts/verify-*.js` script (a live-API-hitting script with `check()`/`assert()`, run against the real local dev DB — see any existing file in that directory for the pattern); frontend syntax gets checked with `node scripts/babel-check.js <file>` (run from `app/`); pure frontend utility functions with no React/DB dependency get a small throwaway Node script using `assert` (matching the spirit of TDD without inventing a new test framework this project doesn't have). Every task below follows whichever of these three actually fits what it's testing — do not introduce jest, RTL, or any other test dependency.
- The dev server must be restarted after every backend change before verifying it (`pkill -f "node server.js"; cd server && nohup node server.js > /tmp/server.log 2>&1 & disown; sleep 3`) — this codebase does not hot-reload.

---

## Task 1: `sort=urgency` on `GET /api/sales`

**Files:**
- Modify: `server/routes/sales.js:165` (param destructuring), `server/routes/sales.js:254` (the `ORDER BY` line)
- Test: `server/scripts/verify-order-flows.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `GET /sales?sort=urgency` — an optional query param. Omitted or any value other than `'urgency'` leaves today's `ORDER BY s.created_at DESC` untouched.

- [ ] **Step 1: Write the failing check**

Add to `server/scripts/verify-order-flows.js`, near the other sales-list-behavior checks:

```js
check('FIXED: sort=urgency puts rush orders first without changing the default sort', async () => {
  const owner = await loginOwner();
  const older = await api('POST', '/sales', owner.token, {
    location_id: TEST_LOCATION_ID, order_type: 'walk_in', channel: 'walk_in',
    items: [{ quantity: 1, unit_price: 100, product_name: 'Test Urgency Sort Older' }],
  });
  createdSaleIds.push(older.body.data.id);
  const rush = await api('POST', '/sales', owner.token, {
    location_id: TEST_LOCATION_ID, order_type: 'walk_in', channel: 'walk_in', priority: 'rush',
    items: [{ quantity: 1, unit_price: 100, product_name: 'Test Urgency Sort Rush' }],
  });
  createdSaleIds.push(rush.body.data.id);

  // Default (no sort param): unchanged, most-recent-first — the rush order,
  // created second, must still lead simply because it's newer, not because
  // of its priority. This is the "default must not change" assertion.
  const defaultRes = await api('GET', `/sales?location_id=${TEST_LOCATION_ID}&limit=2`, owner.token);
  assert(defaultRes.body.data.sales[0].id === rush.body.data.id, 'Expected default sort to still be plain recency (newest first)');

  // sort=urgency: rush leads regardless of recency, even querying with the
  // older order first in creation order.
  const urgencyRes = await api('GET', `/sales?location_id=${TEST_LOCATION_ID}&sort=urgency&limit=50`, owner.token);
  const ids = urgencyRes.body.data.sales.map((s) => s.id);
  const rushIdx = ids.indexOf(rush.body.data.id);
  const olderIdx = ids.indexOf(older.body.data.id);
  assert(rushIdx !== -1 && olderIdx !== -1, 'Expected both test sales in the urgency-sorted result');
  assert(rushIdx < olderIdx, `Expected the rush order to sort before the non-rush order under sort=urgency, got rush at ${rushIdx}, older at ${olderIdx}`);
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd server && VERIFY_OWNER_PHONE=<owner phone> VERIFY_OWNER_PASSWORD=<owner password> node scripts/verify-order-flows.js
```

Expected: this new check fails — `sort=urgency` isn't parsed yet, so the second assertion sees plain recency order (rush at whatever position its actual creation time puts it, likely still first here since it's genuinely newer — if it happens to pass by accident on this data shape, add a third order created *after* the rush one so a truly recency-only sort would put the rush order in the middle. Confirm the test can actually fail before moving on.)

- [ ] **Step 3: Implement**

In `server/routes/sales.js:165`, add `sort` to the destructured query params:

```js
const { location_id, order_type, payment_status, status, pickup_status, channel, priority, date_from, date_to, filter_date, search, sort, limit: lim, offset: off } = req.query;
```

Replace line 254 (`sql += ' ORDER BY s.created_at DESC';`) with:

```js
if (sort === 'urgency') {
  sql += ` ORDER BY
    (s.priority = 'rush') DESC,
    (s.scheduled_date IS NOT NULL) DESC,
    s.scheduled_date ASC NULLS LAST,
    s.scheduled_time ASC NULLS LAST,
    s.created_at ASC`;
} else {
  sql += ' ORDER BY s.created_at DESC';
}
```

- [ ] **Step 4: Restart the server and run the check again**

```bash
pkill -f "node server.js"; cd server && nohup node server.js > /tmp/server.log 2>&1 & disown; sleep 3
VERIFY_OWNER_PHONE=<owner phone> VERIFY_OWNER_PASSWORD=<owner password> node scripts/verify-order-flows.js
```

Expected: PASS, and confirm the full suite still shows the same pass count plus this one new check (no regressions).

- [ ] **Step 5: Commit**

```bash
git add server/routes/sales.js server/scripts/verify-order-flows.js
git commit -m "Add opt-in sort=urgency param to GET /sales (default unchanged)"
```

---

## Task 2: `total` count added to `GET /api/deliveries`

**Files:**
- Modify: `server/routes/deliveries.js` (the list route — the `GET /` handler whose response currently sends a bare array; find it via `router.get('/', authenticate` near the top of the deliveries filtering logic described in the design doc §3.2)
- Modify every current caller of `api.getDeliveries(...)` in `app/src/`: `app/src/screens/DeliveriesScreen.js`, `app/src/screens/LiveDeliveryMapScreen.js`, `app/src/screens/DashboardScreen.js`, and any others — **grep for all of them before starting, don't assume this list is exhaustive**: `grep -rn "getDeliveries(" app/src/`
- Test: `server/scripts/verify-order-flows.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `GET /deliveries` now responds `{ success: true, data: { deliveries: [...], total: N } }` instead of `{ success: true, data: [...] }`. **This is a breaking response-shape change** — every caller must switch from reading `res.data` as the array to reading `res.data.deliveries`, in the same commit as the backend change, so the app is never in a half-migrated state.

- [ ] **Step 1: Find every caller and read the route handler in full**

The route is `router.get('/', authenticate, authorize(...), async (req, res, next) => {...})` at `server/routes/deliveries.js:103` (through roughly line 255 — read the whole handler before editing, to see exactly what filters it already applies — status/location/rider/date — so the new `COUNT(*)` query mirrors the same `WHERE` clause, not a simplified one that would give a wrong total). Find every current frontend caller before touching the response shape:

```bash
cd app && grep -rn "getDeliveries(" src/
```


- [ ] **Step 2: Write the failing check**

Add to `server/scripts/verify-order-flows.js`:

```js
check('FIXED: GET /deliveries returns an accurate total alongside the (still limited) array', async () => {
  const owner = await loginOwner();
  const res = await api('GET', `/deliveries?location_id=${TEST_LOCATION_ID}&limit=1`, owner.token);
  assert(res.status === 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert(Array.isArray(res.body.data.deliveries), `Expected data.deliveries to be an array, got ${JSON.stringify(res.body.data)}`);
  assert(typeof res.body.data.total === 'number', `Expected data.total to be a number, got ${JSON.stringify(res.body.data.total)}`);
  assert(res.body.data.total >= res.body.data.deliveries.length, `Expected total (${res.body.data.total}) to be >= the returned page length (${res.body.data.deliveries.length})`);
});
```

- [ ] **Step 3: Run it to verify it fails**

Expected: fails on `Array.isArray(res.body.data.deliveries)` — today `res.body.data` is itself the array, so `res.body.data.deliveries` is `undefined`.

- [ ] **Step 4: Implement the backend change**

In `server/routes/deliveries.js`'s `GET /` handler, the filtered query is built incrementally into `sql`/`params` (base `SELECT ... FROM deliveries d LEFT JOIN ...` at line 120, then each active filter appends its own `AND ...` at lines 143–170), and `ORDER BY`/`LIMIT`/`OFFSET` are appended last at lines 172–177. Snapshot `sql`/`params` right before that `ORDER BY` line is appended, then wrap the snapshot as a subquery to count matching rows — this guarantees the count always uses the exact same filters as the list, with zero duplicated WHERE-condition logic to drift out of sync later (the same "two divergent calculations for one conceptual value" bug shape this codebase already had to fix twice in the register code):

```js
// Right before the existing `sql += ' ORDER BY CASE d.status ...'` line (172):
const countRow = await db.prepare(`SELECT COUNT(*) as total FROM (${sql}) as filtered`).get(...params);
const total = Number(countRow?.total || 0);

// ...existing ORDER BY / LIMIT / OFFSET / db.prepare(sql).all(...params) code runs unchanged below this...
```

Then change the final response (currently `res.json({ success: true, data: withStage });`):

```js
res.json({ success: true, data: { deliveries: withStage, total } });
```

- [ ] **Step 5: Update every frontend caller in the same commit**

For each call site found in Step 1 (e.g. `DeliveriesScreen.js`, `LiveDeliveryMapScreen.js`, `DashboardScreen.js`), change the line that currently does something like:

```js
const res = await api.getDeliveries(params);
setDeliveries(res.data || []);
```

to:

```js
const res = await api.getDeliveries(params);
setDeliveries(res.data?.deliveries || []);
```

Preserve each call site's own existing variable names and surrounding logic — only the shape being read off `res.data` changes. If a call site also wants the new total (only `DeliveriesScreen.js` needs it, for its future "Load more" pagination in the follow-on plan — leave a `// total available at res.data.total for future pagination` comment there, don't wire pagination yet, that's the Deliveries-screen plan's job).

- [ ] **Step 6: Restart the server, run the check, run the full suite**

```bash
pkill -f "node server.js"; cd server && nohup node server.js > /tmp/server.log 2>&1 & disown; sleep 3
VERIFY_OWNER_PHONE=<owner phone> VERIFY_OWNER_PASSWORD=<owner password> node scripts/verify-order-flows.js
```

Expected: PASS, no regressions in the rest of the suite (a regression here would most likely show up as some other check that calls `GET /deliveries` and reads the old bare-array shape — search the verify scripts for `/deliveries'` GET calls too and fix any that assume the old shape).

- [ ] **Step 7: Babel-check every touched frontend file**

```bash
cd app && node scripts/babel-check.js src/screens/DeliveriesScreen.js src/screens/LiveDeliveryMapScreen.js src/screens/DashboardScreen.js
```

(Add any other files Step 1's grep found.)

- [ ] **Step 8: Manually verify in the running app**

Open Deliveries screen as an owner/manager — list still loads and displays deliveries exactly as before. This is a plumbing change with no visible UI difference yet; the only thing to confirm is nothing broke.

- [ ] **Step 9: Commit**

```bash
git add server/routes/deliveries.js server/scripts/verify-order-flows.js app/src/screens/DeliveriesScreen.js app/src/screens/LiveDeliveryMapScreen.js app/src/screens/DashboardScreen.js
git commit -m "Add total count to GET /deliveries response, update all callers"
```

---

## Task 3: register-session listing endpoint

**Files:**
- Modify: `server/routes/sales.js` (add a new route near the existing `/register/status` and `/register/history` routes, around line 862)
- Test: `server/scripts/verify-register-expenses.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `GET /sales/register/sessions?location_id=X&date=YYYY-MM-DD` (date optional, defaults to today) → `{ success: true, data: { sessions: [...] } }`, each session shaped like a `cash_registers` row (`id, opening_time, opened_at, closed_at, opening_balance, ...`), ordered oldest-first (`ORDER BY cr.id ASC`) — the shape `useRegisterSessions` (Task 12) expects.

- [ ] **Step 1: Write the failing check**

Add to `server/scripts/verify-register-expenses.js`:

```js
check('NEW: GET /register/sessions lists every session for a given date, not just today', async () => {
  const owner = await loginOwner();
  const reg1 = await openRegister(owner.token, TEST_LOCATION_ID, 500);
  await closeRegisterWith(owner.token, TEST_LOCATION_ID, 500);
  const reg2 = await openRegister(owner.token, TEST_LOCATION_ID, 700);

  const today = new Date().toISOString().slice(0, 10);
  const res = await api('GET', `/sales/register/sessions?location_id=${TEST_LOCATION_ID}&date=${today}`, owner.token);
  assert(res.status === 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  const ids = res.body.data.sessions.map((s) => s.id);
  assert(ids.includes(reg1.id) && ids.includes(reg2.id), `Expected both today's sessions (${reg1.id}, ${reg2.id}) in the list, got ${JSON.stringify(ids)}`);
  assert(res.body.data.sessions[0].id === reg1.id, 'Expected sessions ordered oldest-first (reg1 before reg2)');

  await closeRegisterWith(owner.token, TEST_LOCATION_ID, 700);
});
```

- [ ] **Step 2: Run it to verify it fails**

Expected: 404 — the route doesn't exist yet.

- [ ] **Step 3: Implement**

In `server/routes/sales.js`, add after the `/register/history` route (after line 862):

```js
// ─── GET /api/sales/register/sessions ────────────────────────
// Every register session (open or closed) for one location on one date —
// the data DateSessionHeader (app/src/components/orders/DateSessionHeader.js)
// needs to label which session an order's timestamp falls into. Deliberately
// its own route rather than widening /register/status (different semantics —
// that route answers "what's open right now", scoped to today only) or
// /register/history (owner/manager-only; this needs to work for
// counter_staff/employee too, since they use the Orders Inbox).
router.get('/register/sessions', authenticate, authorize('owner', 'manager', 'employee', 'counter_staff'), async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const { location_id, date } = req.query;
    if (!location_id) return res.status(400).json({ success: false, message: 'location_id is required' });
    const targetDate = date || new Date().toISOString().slice(0, 10);

    const sessions = await db.prepare(`
      SELECT cr.*, u1.name as opened_by_name, u2.name as closed_by_name
      FROM cash_registers cr
      LEFT JOIN users u1 ON cr.opened_by = u1.id
      LEFT JOIN users u2 ON cr.closed_by = u2.id
      WHERE cr.location_id = ? AND cr.date = ?
      ORDER BY cr.id ASC
    `).all(location_id, targetDate);

    res.json({ success: true, data: { sessions } });
  } catch (err) { next(err); }
});
```

- [ ] **Step 4: Restart the server, run the check, run the full suite**

```bash
pkill -f "node server.js"; cd server && nohup node server.js > /tmp/server.log 2>&1 & disown; sleep 3
VERIFY_OWNER_PHONE=<owner phone> VERIFY_OWNER_PASSWORD=<owner password> node scripts/verify-register-expenses.js
```

- [ ] **Step 5: Commit**

```bash
git add server/routes/sales.js server/scripts/verify-register-expenses.js
git commit -m "Add GET /sales/register/sessions endpoint for per-date session listing"
```

---

## Task 4: tracking token utility + `GET /api/track/:token`

**Files:**
- Create: `server/utils/tracking-token.js`
- Create: `server/routes/track.js`
- Modify: `server/server.js` (register the new router — find where other routers like `sales.js`/`deliveries.js` get mounted with `app.use('/api/...', ...)` and add the same for this one, with no `authenticate` middleware)
- Modify: `server/.env` and wherever this project documents required env vars (check for a `.env.example` or similar; if none exists, note the new var inline in `server.js` the same way `JWT_SECRET`'s fallback is documented at `server/server.js:119`)
- Test: `server/scripts/verify-order-flows.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `generateTrackingToken(saleId)` → string. `verifyTrackingToken(token)` → the numeric sale ID if valid, or `null` if not (never throws). `GET /api/track/:token` (no `authenticate`) → `200 { success: true, data: {...} }` on a valid token, `404 { success: false, message: 'Not found' }` on anything else.

- [ ] **Step 1: Write the failing check for the token utility**

Create a throwaway verification script `server/scripts/verify-tracking-token.js` (this project's pure-function-testing convention — a plain Node script with `assert`, no server/DB needed):

```js
const assert = require('assert');
process.env.TRACKING_LINK_SECRET = 'test-secret-for-verification-only';
const { generateTrackingToken, verifyTrackingToken } = require('../utils/tracking-token');

// A generated token verifies back to the same sale ID.
const token = generateTrackingToken(897);
assert.strictEqual(verifyTrackingToken(token), 897, 'Expected the token to verify back to sale 897');

// The same sale ID always produces the same token (no randomness, nothing stored).
assert.strictEqual(generateTrackingToken(897), token, 'Expected the token to be deterministic for the same sale ID');

// A tampered signature is rejected.
const [id, sig] = token.split('.');
const tamperedSig = sig.slice(0, -1) + (sig.slice(-1) === '0' ? '1' : '0');
assert.strictEqual(verifyTrackingToken(`${id}.${tamperedSig}`), null, 'Expected a tampered signature to be rejected');

// A guessed sale ID with a made-up signature is rejected.
assert.strictEqual(verifyTrackingToken('898.0000000000000000000000000000000'), null, 'Expected a forged token for a different sale ID to be rejected');

// Malformed input never throws, just returns null.
assert.strictEqual(verifyTrackingToken('not-a-real-token'), null, 'Expected malformed input to return null, not throw');
assert.strictEqual(verifyTrackingToken(''), null, 'Expected empty input to return null');

console.log('✅ tracking-token: all checks passed');
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd server && node scripts/verify-tracking-token.js
```

Expected: `Error: Cannot find module '../utils/tracking-token'`.

- [ ] **Step 3: Implement the token utility**

Create `server/utils/tracking-token.js`:

```js
// Signed, unstored order-tracking token. See CLAUDE.md's non-negotiable #1
// (never lose live data via schema changes) — this deliberately needs NO
// new column: the token is a cryptographic signature of the sale ID,
// verified fresh on every request, nothing to store or migrate.
//
// Format: "<saleId>.<hmac>" — the sale ID is plainly visible (an attacker
// can trivially guess it, IDs are sequential), but the HMAC signature can
// only be produced by someone holding TRACKING_LINK_SECRET, so a guessed ID
// with a made-up signature always fails verification. 128 bits of signature
// (32 hex chars) makes brute-forcing the signature for a guessed ID
// computationally infeasible.
const crypto = require('crypto');

const SECRET = process.env.TRACKING_LINK_SECRET || 'bloomcart-tracking-secret-2026';

function sign(saleId) {
  return crypto.createHmac('sha256', SECRET).update(String(saleId)).digest('hex').slice(0, 32);
}

function generateTrackingToken(saleId) {
  return `${saleId}.${sign(saleId)}`;
}

// Never throws. Returns the numeric sale ID on a valid token, null on
// anything else (malformed, wrong signature, non-numeric ID) — callers
// must treat every null the same way (generic 404), never distinguishing
// "malformed" from "wrong signature" in the response, which would leak
// information to someone probing the endpoint.
function verifyTrackingToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [idPart, sigPart] = token.split('.');
  if (!/^\d+$/.test(idPart)) return null;
  const expectedSig = sign(idPart);
  const expectedBuf = Buffer.from(expectedSig, 'hex');
  const actualBuf = Buffer.from(sigPart || '', 'hex');
  if (expectedBuf.length !== actualBuf.length) return null;
  if (!crypto.timingSafeEqual(expectedBuf, actualBuf)) return null;
  return parseInt(idPart, 10);
}

module.exports = { generateTrackingToken, verifyTrackingToken };
```

- [ ] **Step 4: Run the token check again to verify it passes**

```bash
cd server && node scripts/verify-tracking-token.js
```

Expected: `✅ tracking-token: all checks passed`.

- [ ] **Step 5: Write the failing check for the public endpoint**

Add to `server/scripts/verify-order-flows.js`:

```js
check('NEW: GET /api/track/:token returns status-only data for a valid token, generic 404 otherwise', async () => {
  const owner = await loginOwner();
  const { body: saleBody } = await api('POST', '/sales', owner.token, {
    location_id: TEST_LOCATION_ID, order_type: 'pickup', channel: 'walk_in',
    items: [{ quantity: 1, unit_price: 200, product_name: 'Test Tracking Link Item' }],
  });
  const saleId = saleBody.data.id;
  createdSaleIds.push(saleId);

  const detail = await api('GET', `/sales/${saleId}`, owner.token);
  const trackingUrl = detail.body.data.tracking_url;
  assert(trackingUrl, 'Expected GET /sales/:id to include a tracking_url field');
  const token = trackingUrl.split('/track/')[1];

  // No auth header at all — this must work fully unauthenticated.
  const trackRes = await api('GET', `/track/${token}`, null);
  assert(trackRes.status === 200, `Expected 200 for a valid token, got ${trackRes.status}: ${JSON.stringify(trackRes.body)}`);
  assert(trackRes.body.data.sale_number === saleBody.data.sale_number, 'Expected the right sale_number back');
  assert(trackRes.body.data.stage_label, 'Expected a stage_label field');
  // Never leak sensitive fields on the public endpoint.
  assert(trackRes.body.data.grand_total === undefined, 'tracking endpoint must never return grand_total');
  assert(trackRes.body.data.payment_status === undefined, 'tracking endpoint must never return payment_status');
  assert(trackRes.body.data.customer_phone === undefined, 'tracking endpoint must never return a phone number');

  const forged = await api('GET', `/track/${saleId}.0000000000000000000000000000000`, null);
  assert(forged.status === 404, `Expected 404 for a forged token, got ${forged.status}`);

  const malformed = await api('GET', `/track/not-a-real-token`, null);
  assert(malformed.status === 404, `Expected 404 for a malformed token, got ${malformed.status}`);
});
```

(This check also exercises Task 5's `tracking_url` field — the two tasks are tested together here since Task 4's endpoint has nothing to verify against without it. If executing tasks out of order, implement Task 5's `GET /sales/:id` change first or construct the token directly via `generateTrackingToken` in the test instead.)

- [ ] **Step 6: Run it to verify it fails**

Expected: 404 on the `GET /track/:token` call — the route doesn't exist yet (and `tracking_url` isn't on the sale detail response yet either — see Task 5).

- [ ] **Step 7: Implement the route**

Create `server/routes/track.js`:

```js
// The app's first unauthenticated route. Given a valid signed token
// (server/utils/tracking-token.js), returns only enough for a customer to
// know where their order stands — no login, no app install required.
// See docs/superpowers/specs/2026-09-05-order-list-screens-redesign-design.md §5
// for exactly what is and is not returned, and why.
const express = require('express');
const router = express.Router();
const { getDb: getAsyncDb } = require('../config/database-async');
const { verifyTrackingToken } = require('../utils/tracking-token');
const { computeOrderStage } = require('../utils/order-stage');

router.get('/:token', async (req, res, next) => {
  try {
    const saleId = verifyTrackingToken(req.params.token);
    if (saleId === null) return res.status(404).json({ success: false, message: 'Not found' });

    const db = await getAsyncDb();
    const sale = await db.prepare(`
      SELECT s.*, l.name as location_name,
             d.status as delivery_status, d.cod_amount, d.cod_collected,
             (SELECT COUNT(*) FROM production_tasks pt WHERE pt.sale_id = s.id AND pt.status NOT IN ('completed', 'cancelled')) as open_task_count
      FROM sales s
      LEFT JOIN locations l ON s.location_id = l.id
      LEFT JOIN deliveries d ON d.sale_id = s.id
      WHERE s.id = ?
    `).get(saleId);
    if (!sale) return res.status(404).json({ success: false, message: 'Not found' });

    const stage = computeOrderStage(sale, 'customer', {});

    res.json({
      success: true,
      data: {
        sale_number: sale.sale_number,
        order_type: sale.order_type,
        stage_label: stage.label,
        scheduled_date: sale.scheduled_date,
        scheduled_time: sale.scheduled_time,
        location_name: sale.location_name,
      },
    });
  } catch (err) { next(err); }
});

module.exports = router;
```

Confirmed signature: `computeOrderStage(sale, viewerRole, flags = {})` (`server/utils/order-stage.js:89`). `viewerRole` is only ever used to gate whether `nextAction` gets populated (via `actionFor()`, which checks the role against each endpoint's allowed-roles list — all staff-only endpoints, e.g. `SALE_STATUS`, `DELIVERY_DELIVER`). Passing `'customer'` correctly yields `nextAction: null` on every stage, which doesn't matter here anyway since the route above only reads `stage.label`, never `stage.nextAction`.

In `server/server.js`, add the require near the other route requires (after `const deliveriesRoutes = require('./routes/deliveries');` at line 24):

```js
const trackRoutes = require('./routes/track');
```

Then add the mount near the other `app.use('/api/...')` lines (after `app.use('/api/deliveries', deliveriesRoutes);` at line 84), with no `authenticate` middleware wrapping it — this route file has none applied internally either, by design:

```js
app.use('/api/track', trackRoutes);
```

- [ ] **Step 8: Restart the server, run the checks**

```bash
pkill -f "node server.js"; cd server && nohup node server.js > /tmp/server.log 2>&1 & disown; sleep 3
node scripts/verify-tracking-token.js
VERIFY_OWNER_PHONE=<owner phone> VERIFY_OWNER_PASSWORD=<owner password> node scripts/verify-order-flows.js
```

- [ ] **Step 9: Commit**

```bash
git add server/utils/tracking-token.js server/scripts/verify-tracking-token.js server/routes/track.js server/server.js server/scripts/verify-order-flows.js
git commit -m "Add signed order-tracking token and public GET /api/track/:token endpoint"
```

---

## Task 5: attach `tracking_url` to sale/delivery responses

**Files:**
- Modify: `server/routes/sales.js` (the `GET /` list handler's SELECT/mapping and the `GET /:id` detail handler)
- Modify: `server/routes/deliveries.js` (the `GET /` list handler, touched again after Task 2)
- Modify: `server/.env` (or wherever `JWT_SECRET`-style config lives) to document `TRACKING_LINK_SECRET`, and `PUBLIC_APP_URL` for building the full URL
- Test: extends the check already written in Task 4, Step 5 (that check depends on this task's `GET /sales/:id` change)

**Interfaces:**
- Consumes: `generateTrackingToken` from Task 4.
- Produces: every sale object returned by `GET /sales`, `GET /sales/:id`, and every delivery object returned by `GET /deliveries` gains a `tracking_url` field: `${PUBLIC_APP_URL}/track/${generateTrackingToken(sale.id)}` (falls back to a sane local default if `PUBLIC_APP_URL` isn't set, matching the `JWT_SECRET` fallback convention already in this codebase).

- [ ] **Step 1: Implement a tiny shared helper**

In `server/utils/tracking-token.js` (from Task 4), add the following just above the file's existing `module.exports` line, then **replace** that existing `module.exports = { generateTrackingToken, verifyTrackingToken };` line with the new one shown below (a file can only have one `module.exports`):

```js
const PUBLIC_APP_URL = process.env.PUBLIC_APP_URL || 'http://localhost:19006';

function buildTrackingUrl(saleId) {
  return `${PUBLIC_APP_URL}/track/${generateTrackingToken(saleId)}`;
}

module.exports = { generateTrackingToken, verifyTrackingToken, buildTrackingUrl };
```

- [ ] **Step 2: Wire it into `GET /sales/:id`**

In `server/routes/sales.js`, add the require after line 12 (`const { sumCollectionsByMethod } = require('../utils/settlement-math');`):

```js
const { buildTrackingUrl } = require('../utils/tracking-token');
```

Then in the `GET /:id` handler (`router.get('/:id', authenticate, ...)` at line 1254), the response object is `sale` itself, mutated in place (unlike the list route touched in Step 3 — this one has no separate normalization map). Add the line right after the existing `if (req.user.role !== 'owner') delete sale.vendor_name;` (line 1465) and before `res.json({ success: true, data: sale });` (line 1467):

```js
sale.tracking_url = buildTrackingUrl(sale.id);
```

- [ ] **Step 3: Wire it into `GET /sales` (list)**

The list route's actual response object is `normalizedSales` (built by a `.map()` over the raw `sales` rows at line 314, which is where `display_stage` and the owner-only `vendor_name` gate are already applied per-row) — **not** the earlier `sales` variable, so the field must be added inside that same `.map()` callback to guarantee it survives onto what's actually sent. In `server/routes/sales.js`, inside the existing `normalizedSales` map callback (right after the existing `normalized.display_stage = computeOrderStage(...)` line, before `return normalized;`):

```js
normalized.tracking_url = buildTrackingUrl(normalized.id);
```

- [ ] **Step 4: Wire it into `GET /deliveries` (list)**

In `server/routes/deliveries.js`, add the require after line 15 (`const { computeOrderStage, getStageFlags } = require('../utils/order-stage');`):

```js
const { buildTrackingUrl } = require('../utils/tracking-token');
```

Then in the `GET /` handler (already touched in Task 2), after `withStage` is built (the `.map()` that attaches `display_stage`, per Task 2's Step 1 read-through) and before the final `res.json({ success: true, data: { deliveries: withStage, total } });`, add:

```js
withStage.forEach((d) => { d.tracking_url = buildTrackingUrl(d.sale_id); });
```

- [ ] **Step 5: Document the two new env vars**

Add to `server/.env` (and note in `server/server.js` near the `JWT_SECRET` fallback comment if this project keeps a running list there):

```
TRACKING_LINK_SECRET=<a real random secret for production — the code falls back to a placeholder locally, same pattern as JWT_SECRET>
PUBLIC_APP_URL=http://localhost:19006
```

- [ ] **Step 6: Run Task 4's Step 5 check now that it has what it needs**

```bash
pkill -f "node server.js"; cd server && nohup node server.js > /tmp/server.log 2>&1 & disown; sleep 3
VERIFY_OWNER_PHONE=<owner phone> VERIFY_OWNER_PASSWORD=<owner password> node scripts/verify-order-flows.js
```

Expected: the "GET /api/track/:token" check from Task 4 now passes fully.

- [ ] **Step 7: Commit**

```bash
git add server/routes/sales.js server/routes/deliveries.js server/utils/tracking-token.js server/.env
git commit -m "Attach tracking_url to sale and delivery responses"
```

---

## Task 6: `app/src/utils/contact.js`

**Files:**
- Create: `app/src/utils/contact.js`
- Test: throwaway `app/scripts/verify-contact-utils.js` (pure functions, no React/DB — same plain-Node-assert convention as Task 4)

**Interfaces:**
- Produces: `normalizePhone(raw)`, `telLink(phone)`, `waLink(phone, message)`, `buildMessage(type, params)` — all pure functions, no side effects.

- [ ] **Step 1: Write the failing check**

Create `app/scripts/verify-contact-utils.js`:

```js
const assert = require('assert');
const { normalizePhone, telLink, waLink, buildMessage } = require('../src/utils/contact');

assert.strictEqual(normalizePhone('+91 98765 43210'), '9876543210', 'Expected +91-prefixed with spaces to normalize to bare 10 digits');
assert.strictEqual(normalizePhone('919876543210'), '9876543210', 'Expected a bare 91-prefixed 12-digit number to normalize (not double-prefix later)');
assert.strictEqual(normalizePhone('9876543210'), '9876543210', 'Expected an already-bare number to pass through unchanged');
assert.strictEqual(normalizePhone('98-765-43210'), '9876543210', 'Expected dashes to be stripped');
assert.strictEqual(normalizePhone(''), '', 'Expected empty input to normalize to empty string, not throw');
assert.strictEqual(normalizePhone(null), '', 'Expected null input to normalize to empty string, not throw');

assert.strictEqual(telLink('9876543210'), 'tel:9876543210');

const wa = waLink('9876543210', 'Hi there');
assert.strictEqual(wa, 'https://wa.me/919876543210?text=Hi%20there', `Got: ${wa}`);
// The double-prefix bug this fixes: a number already carrying +91 must not
// end up as wa.me/9191...
const waFromPrefixed = waLink('+919876543210', 'Hi');
assert.strictEqual(waFromPrefixed, 'https://wa.me/919876543210?text=Hi', `Got: ${waFromPrefixed}`);

assert.strictEqual(
  buildMessage('order_ready_pickup', { sale_number: 'INV-123', location_name: 'Main Shop' }),
  'Hi, your order INV-123 is ready for pickup at Main Shop.'
);
assert.strictEqual(
  buildMessage('tracking_link', { sale_number: 'INV-123', tracking_url: 'https://example.com/track/abc' }),
  'Hi, you can track your order INV-123 here: https://example.com/track/abc'
);
assert.strictEqual(
  buildMessage('rider_handoff', { name: 'Vishal', total: 500, count: 3 }),
  'Hi Vishal, please hand over ₹500 from 3 deliveries when you\'re at the shop.'
);
assert.strictEqual(
  buildMessage('unknown_type_xyz', { sale_number: 'INV-123' }),
  'Hi, this is about your order INV-123.',
  'Expected an unrecognized type to fall back to the generic message, not throw'
);

console.log('✅ contact utils: all checks passed');
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd app && node scripts/verify-contact-utils.js
```

Expected: `Cannot find module '../src/utils/contact'`.

- [ ] **Step 3: Implement**

Create `app/src/utils/contact.js`:

```js
// Shared Call/WhatsApp helpers — normalizes phone numbers once, in one
// place, instead of each screen re-deriving its own tel:/wa.me link.
// Fixes a real bug found in this codebase: OrderCard.js and
// SettlementsScreen.js each hardcoded a "91" country prefix directly onto
// whatever was in the phone field, so a number already stored with a
// leading +91/91 produced wa.me/9191... See
// docs/superpowers/specs/2026-09-05-order-list-screens-redesign-design.md §4.

// Strips everything but digits, then removes a leading country code (91)
// if present, always returning a bare 10-digit number (or '' if the input
// doesn't look like a phone number at all).
function normalizePhone(raw) {
  if (!raw) return '';
  const digitsOnly = String(raw).replace(/\D/g, '');
  if (digitsOnly.length === 12 && digitsOnly.startsWith('91')) return digitsOnly.slice(2);
  if (digitsOnly.length === 10) return digitsOnly;
  return digitsOnly.length >= 10 ? digitsOnly.slice(-10) : '';
}

function telLink(phone) {
  return `tel:${normalizePhone(phone)}`;
}

function waLink(phone, message) {
  const num = normalizePhone(phone);
  const encoded = encodeURIComponent(message || '').replace(/%20/g, '%20');
  return `https://wa.me/91${num}?text=${encoded}`;
}

// Message template table — see the design doc §4 for the full catalog and
// why each one is worded the way it is. `general_inquiry` is the fallback
// for both an unrecognized type and no context at all, matching the one
// generic message every Call/WhatsApp touchpoint used before this file
// existed.
const TEMPLATES = {
  order_ready_pickup: (p) => `Hi, your order ${p.sale_number} is ready for pickup at ${p.location_name}.`,
  order_out_for_delivery: (p) => `Hi, your order ${p.sale_number} is out for delivery.`,
  rider_handoff: (p) => `Hi ${p.name}, please hand over ₹${p.total} from ${p.count} deliveries when you're at the shop.`,
  tracking_link: (p) => `Hi, you can track your order ${p.sale_number} here: ${p.tracking_url}`,
  general_inquiry: (p) => `Hi, this is about your order ${p.sale_number}.`,
};

function buildMessage(type, params = {}) {
  const template = TEMPLATES[type] || TEMPLATES.general_inquiry;
  return template(params);
}

module.exports = { normalizePhone, telLink, waLink, buildMessage };
```

Encoding note: `encodeURIComponent` already turns a space into `%20`, so the `.replace(/%20/g, '%20')` line above is a no-op placeholder for readability — remove it and just use `encodeURIComponent(message || '')` directly; keep the function simple.

- [ ] **Step 4: Run the check again to verify it passes**

```bash
cd app && node scripts/verify-contact-utils.js
```

- [ ] **Step 5: Babel-check**

```bash
cd app && node scripts/babel-check.js src/utils/contact.js
```

- [ ] **Step 6: Commit**

```bash
git add app/src/utils/contact.js app/scripts/verify-contact-utils.js
git commit -m "Add shared contact.js: phone normalization and message templates"
```

---

## Task 7: `ContactButtons` component

**Files:**
- Create: `app/src/components/orders/ContactButtons.js`
- Test: babel-check + manual verification (this codebase has no component-testing convention — see Global Constraints)

**Interfaces:**
- Consumes: `normalizePhone`, `telLink`, `waLink`, `buildMessage` from Task 6.
- Produces: `<ContactButtons contacts={[{ label, phone }]} context={{ type, params }} />` — renders a Call icon and a WhatsApp icon. One contact → tapping acts immediately. More than one contact with different (normalized) phone numbers → tapping opens a small inline picker instead of guessing. Contacts with no usable phone number are skipped entirely; if none remain, the component renders nothing.

- [ ] **Step 1: Implement**

Create `app/src/components/orders/ContactButtons.js`:

```jsx
// Call + WhatsApp, usable anywhere a phone number appears on an order.
// See docs/superpowers/specs/2026-09-05-order-list-screens-redesign-design.md
// §4 for the full design rationale (why `contacts` is a list, not a single
// number — a delivery's buyer and receiver can be different people).
import React, { useState } from 'react';
import { View, TouchableOpacity, Text, Modal, StyleSheet, Linking, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Spacing, BorderRadius, FontSize } from '../../constants/theme';
import { normalizePhone, telLink, waLink, buildMessage } from '../../utils/contact';

const MIN_TAP_TARGET = 44; // staff-UX checklist #7 — quick, imprecise taps

export default function ContactButtons({ contacts = [], context = {} }) {
  const [pickerFor, setPickerFor] = useState(null); // 'call' | 'whatsapp' | null

  const usable = contacts.filter((c) => normalizePhone(c.phone));
  if (usable.length === 0) return null;

  const openLink = (url) => {
    Linking.canOpenURL(url).then((supported) => {
      if (supported) Linking.openURL(url);
    }).catch(() => {});
  };

  const act = (kind, contact) => {
    if (kind === 'call') {
      openLink(telLink(contact.phone));
    } else {
      openLink(waLink(contact.phone, buildMessage(context.type, context.params)));
    }
  };

  const handlePress = (kind) => {
    if (usable.length === 1) {
      act(kind, usable[0]);
    } else {
      setPickerFor(kind);
    }
  };

  return (
    <View style={styles.row}>
      <TouchableOpacity style={styles.btn} onPress={() => handlePress('call')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
        <Ionicons name="call" size={18} color={Colors.primary} />
      </TouchableOpacity>
      <TouchableOpacity style={styles.btn} onPress={() => handlePress('whatsapp')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
        <Ionicons name="logo-whatsapp" size={18} color={Colors.secondary} />
      </TouchableOpacity>

      <Modal visible={!!pickerFor} transparent animationType="slide" onRequestClose={() => setPickerFor(null)}>
        <View style={styles.overlay}>
          <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={() => setPickerFor(null)} />
          <View style={styles.sheet}>
            {usable.map((c) => (
              <TouchableOpacity
                key={c.label}
                style={styles.pickerRow}
                onPress={() => { act(pickerFor, c); setPickerFor(null); }}
              >
                <Text style={styles.pickerLabel}>{c.label}</Text>
                <Text style={styles.pickerPhone}>{normalizePhone(c.phone)}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: Spacing.xs },
  btn: {
    width: MIN_TAP_TARGET, height: MIN_TAP_TARGET,
    alignItems: 'center', justifyContent: 'center',
    borderRadius: BorderRadius.full, backgroundColor: Colors.surfaceAlt,
  },
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: { backgroundColor: Colors.surface, borderTopLeftRadius: BorderRadius.lg, borderTopRightRadius: BorderRadius.lg, padding: Spacing.md },
  pickerRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: Spacing.md, borderBottomWidth: 1, borderBottomColor: Colors.border },
  pickerLabel: { fontSize: FontSize.md, color: Colors.text },
  pickerPhone: { fontSize: FontSize.md, color: Colors.textLight },
});
```

- [ ] **Step 2: Babel-check**

```bash
cd app && node scripts/babel-check.js src/components/orders/ContactButtons.js
```

- [ ] **Step 3: Manual verification**

This component has no consumer yet (screens are wired up in the follow-on plans), so manual verification here means a throwaway smoke-test render: temporarily add `<ContactButtons contacts={[{label: 'Test', phone: '+91 98765 43210'}]} context={{type: 'general_inquiry', params: {sale_number: 'TEST-1'}}} />` to any already-rendered screen (e.g. at the top of `DashboardScreen.js`'s return, behind a `__DEV__` check), confirm the Call and WhatsApp icons render at a comfortable tap size and both open the expected native dialog/WhatsApp with the number correctly normalized (no `9191` double-prefix), then remove the temporary render before committing.

- [ ] **Step 4: Commit**

```bash
git add app/src/components/orders/ContactButtons.js
git commit -m "Add ContactButtons component (Call + WhatsApp, contextual messages)"
```

---

## Task 8: `useOrderListData` hook

**Files:**
- Create: `app/src/hooks/useOrderListData.js`
- Test: babel-check + manual verification via a temporary consumer

**Interfaces:**
- Produces: `useOrderListData(fetchFn, { pageSize = 50 } = {})` → `{ items, loading, refreshing, total, hasMore, loadMore, refresh, search, setSearch, filters, setFilter, clearFilters, sort, setSort }`. `fetchFn(params)` is supplied by the caller (e.g. `(params) => api.getSales(params).then(r => ({ items: r.data.sales, total: r.data.total }))`) so this hook has no direct dependency on `api.js` or a specific endpoint shape — each screen's own adapter normalizes its endpoint's response into `{ items, total }` before handing the function to this hook.

- [ ] **Step 1: Implement**

Create `app/src/hooks/useOrderListData.js`:

```js
// Shared list-data hook for Orders Inbox / Deliveries / Pickup Orders —
// centralizes debounced search, filter state, real offset pagination, and
// the request-race protection OrdersInboxScreen already did well on its
// own (a fast typist firing three searches must not let an earlier, slower
// response overwrite a later, faster one).
import { useState, useRef, useCallback, useEffect } from 'react';

const SEARCH_DEBOUNCE_MS = 300;

export default function useOrderListData(fetchFn, { pageSize = 50 } = {}) {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearchState] = useState('');
  const [filters, setFilters] = useState({});
  const [sort, setSort] = useState(null); // null = server default; e.g. 'urgency' when opted in

  const requestIdRef = useRef(0);
  const searchTimerRef = useRef(null);
  const offsetRef = useRef(0);

  const runFetch = useCallback((append) => {
    const myRequestId = ++requestIdRef.current;
    if (!append) setLoading(true);
    const offset = append ? offsetRef.current : 0;
    const params = { ...filters, search, limit: pageSize, offset, ...(sort ? { sort } : {}) };

    return fetchFn(params).then(({ items: newItems, total: newTotal }) => {
      if (myRequestId !== requestIdRef.current) return; // a newer request already landed
      setItems((prev) => (append ? [...prev, ...newItems] : newItems));
      setTotal(newTotal);
      offsetRef.current = offset + newItems.length;
      setLoading(false);
      setRefreshing(false);
    }).catch(() => {
      if (myRequestId !== requestIdRef.current) return;
      setLoading(false);
      setRefreshing(false);
    });
  }, [fetchFn, filters, search, sort, pageSize]);

  useEffect(() => {
    offsetRef.current = 0;
    runFetch(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, sort]);

  const setSearch = useCallback((value) => {
    setSearchState(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      offsetRef.current = 0;
      runFetch(false);
    }, SEARCH_DEBOUNCE_MS);
  }, [runFetch]);

  const setFilter = useCallback((key, value) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }, []);

  const clearFilters = useCallback(() => setFilters({}), []);

  const refresh = useCallback(() => {
    setRefreshing(true);
    offsetRef.current = 0;
    runFetch(false);
  }, [runFetch]);

  const loadMore = useCallback(() => {
    if (loading || items.length >= total) return;
    runFetch(true);
  }, [loading, items.length, total, runFetch]);

  const hasMore = items.length < total;

  return { items, loading, refreshing, total, hasMore, loadMore, refresh, search, setSearch, filters, setFilter, clearFilters, sort, setSort };
}
```

- [ ] **Step 2: Babel-check**

```bash
cd app && node scripts/babel-check.js src/hooks/useOrderListData.js
```

- [ ] **Step 3: Manual verification**

No consumer yet. Verification here is deferred to the Orders Inbox follow-on plan, which is this hook's first real integration — note in that plan's first task to specifically exercise: typing quickly in search (only the last keystroke's result should ever land), toggling a filter (list refetches from offset 0), and scrolling to trigger `loadMore` (appends without duplicating or dropping rows).

- [ ] **Step 4: Commit**

```bash
git add app/src/hooks/useOrderListData.js
git commit -m "Add useOrderListData hook (search/filter/sort/pagination)"
```

---

## Task 9: `SortControl` and `ActiveFilterChips`

**Files:**
- Create: `app/src/components/orders/SortControl.js`
- Create: `app/src/components/orders/ActiveFilterChips.js`
- Test: babel-check + manual verification via temporary consumer

**Interfaces:**
- `<SortControl value={sort} onChange={setSort} options={[{ value: null, label: 'Recent' }, { value: 'urgency', label: 'Urgent first' }]} />` — small popover, defaults visually to whichever option's `value` matches the current `value` prop.
- `<ActiveFilterChips filters={filters} labels={{ status: (v) => `Status: ${v}` }} onRemove={(key) => setFilter(key, undefined)} onClearAll={clearFilters} />` — renders one chip per non-empty entry in `filters`, using `labels[key](value)` to format its text if provided, falling back to `` `${key}: ${value}` ``. Renders nothing when `filters` has no active entries.

- [ ] **Step 1: Implement `SortControl`**

Create `app/src/components/orders/SortControl.js`:

```jsx
// A small, separate control from FilterDrawer — deliberately so sorting is
// never confused with filtering. Defaults to whatever `value` the caller
// passes; callers must default that to null/undefined (server's existing
// order) themselves — this component never picks a non-default option on
// its own. See design doc §3.2: no screen's default sort may change as a
// side effect of adding this control.
import React, { useState } from 'react';
import { View, TouchableOpacity, Text, Modal, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Spacing, BorderRadius, FontSize } from '../../constants/theme';

export default function SortControl({ value, onChange, options }) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value) || options[0];

  return (
    <View>
      <TouchableOpacity style={styles.trigger} onPress={() => setOpen(true)}>
        <Text style={styles.triggerText}>Sort: {current.label}</Text>
        <Ionicons name="chevron-down" size={14} color={Colors.textSecondary} />
      </TouchableOpacity>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={() => setOpen(false)}>
          <View style={styles.menu}>
            {options.map((o) => (
              <TouchableOpacity key={String(o.value)} style={styles.item} onPress={() => { onChange(o.value); setOpen(false); }}>
                <Text style={[styles.itemText, o.value === value && styles.itemTextActive]}>{o.label}</Text>
                {o.value === value && <Ionicons name="checkmark" size={16} color={Colors.primary} />}
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  trigger: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: Spacing.sm, paddingHorizontal: Spacing.md, backgroundColor: Colors.surfaceAlt, borderRadius: BorderRadius.md, minHeight: 44 },
  triggerText: { fontSize: FontSize.sm, color: Colors.textSecondary },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.2)', justifyContent: 'flex-start', alignItems: 'flex-end', paddingTop: 100, paddingRight: Spacing.md },
  menu: { backgroundColor: Colors.surface, borderRadius: BorderRadius.md, paddingVertical: Spacing.xs, minWidth: 160, elevation: 4 },
  item: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: Spacing.sm, paddingHorizontal: Spacing.md, minHeight: 44 },
  itemText: { fontSize: FontSize.md, color: Colors.text },
  itemTextActive: { color: Colors.primary, fontWeight: '600' },
});
```

- [ ] **Step 2: Implement `ActiveFilterChips`**

Create `app/src/components/orders/ActiveFilterChips.js`:

```jsx
import React from 'react';
import { View, ScrollView, TouchableOpacity, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Spacing, BorderRadius, FontSize } from '../../constants/theme';

export default function ActiveFilterChips({ filters, labels = {}, onRemove, onClearAll }) {
  const entries = Object.entries(filters || {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (entries.length === 0) return null;

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
      {entries.map(([key, value]) => (
        <TouchableOpacity key={key} style={styles.chip} onPress={() => onRemove(key)}>
          <Text style={styles.chipText}>{labels[key] ? labels[key](value) : `${key}: ${value}`}</Text>
          <Ionicons name="close" size={14} color={Colors.primary} />
        </TouchableOpacity>
      ))}
      <TouchableOpacity style={styles.clearAll} onPress={onClearAll}>
        <Text style={styles.clearAllText}>Clear all</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: Spacing.xs, paddingVertical: Spacing.xs },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: Colors.primaryLight, borderRadius: BorderRadius.full, paddingVertical: 6, paddingHorizontal: Spacing.sm },
  chipText: { fontSize: FontSize.xs, color: Colors.primaryDark },
  clearAll: { justifyContent: 'center', paddingHorizontal: Spacing.sm },
  clearAllText: { fontSize: FontSize.xs, color: Colors.textLight, textDecorationLine: 'underline' },
});
```

- [ ] **Step 3: Babel-check both**

```bash
cd app && node scripts/babel-check.js src/components/orders/SortControl.js src/components/orders/ActiveFilterChips.js
```

- [ ] **Step 4: Manual verification**

Deferred to the first screen plan that consumes these (same reasoning as Task 8, Step 3).

- [ ] **Step 5: Commit**

```bash
git add app/src/components/orders/SortControl.js app/src/components/orders/ActiveFilterChips.js
git commit -m "Add SortControl and ActiveFilterChips components"
```

---

## Task 10: `FilterDrawer` and `OrderListToolbar`

**Files:**
- Create: `app/src/components/orders/FilterDrawer.js`
- Create: `app/src/components/orders/OrderListToolbar.js`
- Test: babel-check + manual verification via temporary consumer

**Interfaces:**
- `<FilterDrawer visible={bool} onClose={fn} sections={[{ key, label, type: 'chips', options: [{value, label}], value, onChange }]} onClearAll={fn} />` — a slide-up `Modal` (matching this codebase's existing `DateTimePickerModal.js` convention: `<Modal transparent animationType="slide">`), rendering each section as a label plus a horizontally-scrollable chip row for its own `options`.
- `<OrderListToolbar search={str} onSearchChange={fn} activeFilterCount={n} onOpenFilters={fn} sortProps={{value, onChange, options}} viewModeProps={optional {value, onChange, options}} />` — row 1 is search + the Filters button (badge shows `activeFilterCount` when > 0); row 2, only rendered when `viewModeProps` is supplied, is a segmented view-mode control on the left and `SortControl` on the right.

- [ ] **Step 1: Implement `FilterDrawer`**

Create `app/src/components/orders/FilterDrawer.js`:

```jsx
// The slide-up panel holding every filter dimension as a scrollable list —
// see design doc §3.1a for why this replaced permanently-stacked chip rows.
// Adding a new filter dimension in the future means adding one entry to a
// screen's `sections` array, never a new row on the main screen.
import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, Modal, StyleSheet } from 'react-native';
import { Colors, Spacing, BorderRadius, FontSize } from '../../constants/theme';

export default function FilterDrawer({ visible, onClose, sections, onClearAll }) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>Filters</Text>
            <TouchableOpacity onPress={onClose}><Text style={styles.doneText}>Done</Text></TouchableOpacity>
          </View>
          <ScrollView style={styles.body}>
            {sections.map((section) => (
              <View key={section.key} style={styles.section}>
                <Text style={styles.sectionLabel}>{section.label}</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
                  {section.options.map((opt) => (
                    <TouchableOpacity
                      key={String(opt.value)}
                      style={[styles.chip, section.value === opt.value && styles.chipActive]}
                      onPress={() => section.onChange(opt.value)}
                    >
                      <Text style={[styles.chipText, section.value === opt.value && styles.chipTextActive]}>{opt.label}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
            ))}
          </ScrollView>
          <TouchableOpacity style={styles.clearAllBtn} onPress={onClearAll}>
            <Text style={styles.clearAllText}>Clear all filters</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: { backgroundColor: Colors.surface, borderTopLeftRadius: BorderRadius.lg, borderTopRightRadius: BorderRadius.lg, maxHeight: '75%', paddingBottom: Spacing.lg },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: Spacing.md, borderBottomWidth: 1, borderBottomColor: Colors.border },
  title: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  doneText: { fontSize: FontSize.md, color: Colors.primary, fontWeight: '600' },
  body: { paddingHorizontal: Spacing.md },
  section: { marginTop: Spacing.md },
  sectionLabel: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.textSecondary, marginBottom: Spacing.xs },
  chipRow: { gap: Spacing.xs },
  chip: { paddingVertical: Spacing.sm, paddingHorizontal: Spacing.md, borderRadius: BorderRadius.full, backgroundColor: Colors.surfaceAlt, minHeight: 44, justifyContent: 'center' },
  chipActive: { backgroundColor: Colors.primary },
  chipText: { fontSize: FontSize.sm, color: Colors.text },
  chipTextActive: { color: Colors.white, fontWeight: '600' },
  clearAllBtn: { marginTop: Spacing.md, marginHorizontal: Spacing.md, alignItems: 'center', paddingVertical: Spacing.sm },
  clearAllText: { color: Colors.textLight, textDecorationLine: 'underline', fontSize: FontSize.sm },
});
```

- [ ] **Step 2: Implement `OrderListToolbar`**

Create `app/src/components/orders/OrderListToolbar.js`:

```jsx
import React from 'react';
import { View, TextInput, TouchableOpacity, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Spacing, BorderRadius, FontSize } from '../../constants/theme';
import SortControl from './SortControl';

export default function OrderListToolbar({ search, onSearchChange, activeFilterCount = 0, onOpenFilters, sortProps, viewModeProps, placeholder }) {
  return (
    <View>
      <View style={styles.row1}>
        <View style={styles.searchBox}>
          <Ionicons name="search" size={18} color={Colors.textLight} />
          <TextInput
            style={styles.searchInput}
            value={search}
            onChangeText={onSearchChange}
            placeholder={placeholder || 'Search anything…'}
            placeholderTextColor={Colors.textLight}
          />
        </View>
        <TouchableOpacity style={styles.filtersBtn} onPress={onOpenFilters}>
          <Ionicons name="options-outline" size={18} color={Colors.primary} />
          <Text style={styles.filtersBtnText}>Filters</Text>
          {activeFilterCount > 0 && (
            <View style={styles.badge}><Text style={styles.badgeText}>{activeFilterCount}</Text></View>
          )}
        </TouchableOpacity>
      </View>

      {(viewModeProps || sortProps) && (
        <View style={styles.row2}>
          {viewModeProps ? (
            <View style={styles.viewModeGroup}>
              {viewModeProps.options.map((o) => (
                <TouchableOpacity
                  key={o.value}
                  style={[styles.viewModeBtn, viewModeProps.value === o.value && styles.viewModeBtnActive]}
                  onPress={() => viewModeProps.onChange(o.value)}
                >
                  <Text style={[styles.viewModeText, viewModeProps.value === o.value && styles.viewModeTextActive]}>{o.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          ) : <View />}
          {sortProps && <SortControl {...sortProps} />}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row1: { flexDirection: 'row', gap: Spacing.sm, padding: Spacing.md, paddingBottom: Spacing.sm },
  searchBox: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: Spacing.xs, backgroundColor: Colors.surfaceAlt, borderRadius: BorderRadius.md, paddingHorizontal: Spacing.sm, minHeight: 44 },
  searchInput: { flex: 1, fontSize: FontSize.md, color: Colors.text, paddingVertical: 8 },
  filtersBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: Colors.surfaceAlt, borderRadius: BorderRadius.md, paddingHorizontal: Spacing.sm, minHeight: 44 },
  filtersBtnText: { fontSize: FontSize.sm, color: Colors.primary, fontWeight: '600' },
  badge: { backgroundColor: Colors.primary, borderRadius: BorderRadius.full, minWidth: 18, height: 18, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  badgeText: { color: Colors.white, fontSize: 11, fontWeight: '700' },
  row2: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: Spacing.md, paddingBottom: Spacing.sm },
  viewModeGroup: { flexDirection: 'row', backgroundColor: Colors.surfaceAlt, borderRadius: BorderRadius.md, padding: 2 },
  viewModeBtn: { paddingVertical: 6, paddingHorizontal: Spacing.sm, borderRadius: BorderRadius.sm, minHeight: 40, justifyContent: 'center' },
  viewModeBtnActive: { backgroundColor: Colors.primary },
  viewModeText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  viewModeTextActive: { color: Colors.white, fontWeight: '600' },
});
```

- [ ] **Step 3: Babel-check both**

```bash
cd app && node scripts/babel-check.js src/components/orders/FilterDrawer.js src/components/orders/OrderListToolbar.js
```

- [ ] **Step 4: Manual verification**

Deferred to the first screen plan that consumes these — same reasoning as Task 8/9. That plan's first task should specifically confirm: the toolbar never exceeds 2 rows regardless of how many `sections` are passed to `FilterDrawer`, the drawer opens/closes smoothly, and `SortControl`'s selection is visually distinct from `FilterDrawer`'s chips (checklist item: sort must never be confused with filtering).

- [ ] **Step 5: Commit**

```bash
git add app/src/components/orders/FilterDrawer.js app/src/components/orders/OrderListToolbar.js
git commit -m "Add FilterDrawer and OrderListToolbar components"
```

---

## Task 11: `CollapsibleSection`

**Files:**
- Create: `app/src/components/orders/CollapsibleSection.js`
- Test: babel-check + manual verification via temporary consumer

**Interfaces:**
- `<CollapsibleSection title={str} count={n} defaultExpanded={true} children={...} />` — a header row (title, count, chevron) that toggles its children's visibility. `defaultExpanded` defaults to `true` per the design doc's explicit requirement (nothing hidden by default; collapsing is opt-in).

- [ ] **Step 1: Implement**

Create `app/src/components/orders/CollapsibleSection.js`:

```jsx
// Generic expand/collapse wrapper for any grouped section (Route/Date/Rider
// on Deliveries, day-grouping on Orders Inbox). Defaults EXPANDED — per the
// staff-UX checklist, collapsing is something staff opt into to declutter,
// never something that hides an order by default.
import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Spacing, FontSize } from '../../constants/theme';

export default function CollapsibleSection({ title, count, defaultExpanded = true, children }) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <View>
      <TouchableOpacity style={styles.header} onPress={() => setExpanded((v) => !v)}>
        <Text style={styles.title}>{title}{typeof count === 'number' ? ` (${count})` : ''}</Text>
        <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={18} color={Colors.textSecondary} />
      </TouchableOpacity>
      {expanded && children}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: Spacing.sm, paddingHorizontal: Spacing.md, minHeight: 44, backgroundColor: Colors.surfaceAlt },
  title: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.textSecondary },
});
```

- [ ] **Step 2: Babel-check**

```bash
cd app && node scripts/babel-check.js src/components/orders/CollapsibleSection.js
```

- [ ] **Step 3: Manual verification**

Deferred to the Deliveries follow-on plan (its first real consumer).

- [ ] **Step 4: Commit**

```bash
git add app/src/components/orders/CollapsibleSection.js
git commit -m "Add CollapsibleSection component (default-expanded)"
```

---

## Task 12: `useRegisterSessions` hook + `DateSessionHeader` component

**Files:**
- Create: `app/src/hooks/useRegisterSessions.js`
- Create: `app/src/components/orders/DateSessionHeader.js`
- Test: babel-check + manual verification via temporary consumer

**Interfaces:**
- Consumes: `GET /sales/register/sessions` from Task 3, via `api.js` — add a thin client method first (see Step 1).
- Produces: `useRegisterSessions(locationId, dateStr)` → `{ sessions, loading }`, where each session is a raw `cash_registers` row. A pure helper `matchSessionLabel(sessions, timestampStr)` → a human label like `"Morning Session (9:02am–1:15pm)"` or `"Session (9:02am–now)"` for a still-open one, or `null` if no session contains the timestamp (legacy data predating this feature, or a location/date combination with no register activity at all). `<DateSessionHeader dateLabel={str} sessionLabel={str|null} totalAmount={number} />` — pure presentational, renders `sessionLabel` only when non-null (so old data degrades gracefully to just the date).

- [ ] **Step 1: Add the `api.js` client method**

In `app/src/services/api.js`, near `getSales`/other sales methods:

```js
getRegisterSessions(params = {}) {
  const q = new URLSearchParams(params).toString();
  return this.request(`/sales/register/sessions${q ? `?${q}` : ''}`);
}
```

- [ ] **Step 2: Implement `useRegisterSessions`**

Create `app/src/hooks/useRegisterSessions.js`:

```js
// Register-session lookup for DateSessionHeader — no new database column
// (design doc §3.3): a session is fully described by cash_registers'
// opened_at/opening_time -> closed_at window, fetched once per (location,
// date) pair and matched against order timestamps client-side.
import { useState, useEffect } from 'react';
import api from '../services/api';

const cache = new Map(); // `${locationId}:${dateStr}` -> sessions array, cleared on reload — a purely in-memory speedup, not persistence

export default function useRegisterSessions(locationId, dateStr) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!locationId || !dateStr) { setSessions([]); setLoading(false); return; }
    const key = `${locationId}:${dateStr}`;
    if (cache.has(key)) { setSessions(cache.get(key)); setLoading(false); return; }
    setLoading(true);
    api.getRegisterSessions({ location_id: locationId, date: dateStr })
      .then((res) => {
        const list = res.data?.sessions || [];
        cache.set(key, list);
        setSessions(list);
      })
      .catch(() => setSessions([]))
      .finally(() => setLoading(false));
  }, [locationId, dateStr]);

  return { sessions, loading };
}

function formatTime(isoString) {
  const d = new Date(isoString);
  return d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }).replace(' ', '').toLowerCase();
}

// Exported separately (not a hook) so it's a pure, independently testable
// function — given the sessions already fetched, find which one a specific
// order timestamp falls into.
export function matchSessionLabel(sessions, timestampStr) {
  if (!sessions || sessions.length === 0 || !timestampStr) return null;
  const t = new Date(timestampStr).getTime();
  const idx = sessions.findIndex((s) => {
    const start = new Date(s.opening_time || s.opened_at).getTime();
    const end = s.closed_at ? new Date(s.closed_at).getTime() : Infinity;
    return t >= start && t < end;
  });
  if (idx === -1) return null;
  const s = sessions[idx];
  const label = sessions.length > 1 ? `Session ${idx + 1}` : 'Session';
  const startLabel = formatTime(s.opening_time || s.opened_at);
  const endLabel = s.closed_at ? formatTime(s.closed_at) : 'now';
  return `${label} (${startLabel}–${endLabel})`;
}
```

- [ ] **Step 3: Implement `DateSessionHeader`**

Create `app/src/components/orders/DateSessionHeader.js`:

```jsx
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Colors, Spacing, FontSize } from '../../constants/theme';

export default function DateSessionHeader({ dateLabel, sessionLabel, totalAmount }) {
  return (
    <View style={styles.container}>
      <Text style={styles.dateText}>
        {dateLabel}
        {sessionLabel ? ` · ${sessionLabel}` : ''}
        {typeof totalAmount === 'number' ? ` · ₹${totalAmount.toFixed(0)}` : ''}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingVertical: Spacing.sm, paddingHorizontal: Spacing.md, backgroundColor: Colors.background },
  dateText: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.textSecondary },
});
```

- [ ] **Step 4: Babel-check**

```bash
cd app && node scripts/babel-check.js src/hooks/useRegisterSessions.js src/components/orders/DateSessionHeader.js src/services/api.js
```

- [ ] **Step 5: Manual verification**

Deferred to the Orders Inbox follow-on plan (its first real consumer) — that plan's first task should specifically confirm a legacy order (one predating this feature, if any exist in the dev DB) degrades to showing just the date, not a broken or blank session label.

- [ ] **Step 6: Commit**

```bash
git add app/src/hooks/useRegisterSessions.js app/src/components/orders/DateSessionHeader.js app/src/services/api.js
git commit -m "Add useRegisterSessions hook and DateSessionHeader component"
```

---

## Task 13: full regression pass

**Files:** none new — this task only runs and confirms.

- [ ] **Step 1: Run every backend verify script**

```bash
pkill -f "node server.js"; cd server && nohup node server.js > /tmp/server.log 2>&1 & disown; sleep 3
VERIFY_OWNER_PHONE=<owner phone> VERIFY_OWNER_PASSWORD=<owner password> node scripts/verify-order-flows.js
VERIFY_OWNER_PHONE=<owner phone> VERIFY_OWNER_PASSWORD=<owner password> node scripts/verify-register-expenses.js
VERIFY_OWNER_PHONE=<owner phone> VERIFY_OWNER_PASSWORD=<owner password> node scripts/verify-identity-roles.js
node scripts/verify-tracking-token.js
```

Expected: every suite passes, including all of this plan's new checks, with zero regressions in pre-existing ones.

- [ ] **Step 2: Run the pure frontend utility check**

```bash
cd app && node scripts/verify-contact-utils.js
```

- [ ] **Step 3: Babel-check every new frontend file at once**

```bash
cd app && node scripts/babel-check.js src/utils/contact.js src/hooks/useOrderListData.js src/hooks/useRegisterSessions.js src/components/orders/ContactButtons.js src/components/orders/SortControl.js src/components/orders/ActiveFilterChips.js src/components/orders/FilterDrawer.js src/components/orders/OrderListToolbar.js src/components/orders/CollapsibleSection.js src/components/orders/DateSessionHeader.js src/services/api.js
```

- [ ] **Step 4: Confirm no temporary/dev-only render code was left behind**

```bash
grep -rn "ContactButtons\|__DEV__.*Test" app/src/screens/DashboardScreen.js
```

Remove anything left over from Task 7's manual-verification smoke test if it wasn't already cleaned up.

- [ ] **Step 5: Final commit if anything was cleaned up in Step 4**

```bash
git add -A
git commit -m "Clean up temporary verification renders from foundation plan"
```

(Skip this step entirely if Step 4 found nothing.)
