# Customer Order Request Flow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a staff member share a persistent link with a registered customer; the customer fills in recipient/items/delivery details themselves at `/order-request/:token`; a staff member reviews the submitted request on a new "Order Requests" screen and approves it by pre-filling the existing `LogOrderScreen` (not a second order-creation form) or declines it with a reason.

**Architecture:** One new additive table (`order_requests`) plus one new nullable column (`users.order_request_token`). A public, unauthenticated, rate-limited route pair (`GET`/`POST /api/order-request/:token`) mirrors the existing `track.js` pattern for the customer-facing submit/status page. A staff-authenticated route pair (`GET /api/order-requests`, `PUT /api/order-requests/:id/decline`) backs a new review screen. "Approve" is not a new route at all — it's `LogOrderScreen` pre-filled via navigation params, and its existing `POST /sales` gains one optional field (`source_order_request_id`) that atomically marks the source request `approved` inside the same DB transaction that creates the sale.

**Tech Stack:** Express.js + `pg` (async pool layer, `server/config/database-async.js`) for all new routes; Expo (React Native, React Navigation) for the frontend; the project's existing `verify-*.js` live-regression-script convention (no jest/mocha in this repo) for backend testing; `app/scripts/babel-check.js` as the frontend syntax gate (this repo has no test runner or linter).

**Spec:** `docs/superpowers/specs/2026-09-19-customer-order-request-design.md` — read both together; this plan implements it section by section and cites section numbers throughout.

## Global Constraints

- **Additive-only schema** (`db-migration-safety` skill): only new tables/columns, no `DROP`/`RENAME`/type-narrowing. This is a live-production app.
- **Staff-facing screens** must pass the `staff-ux-checklist` skill's 10 points — concretely in this plan: the Approve/Decline tap sequences are written out with literal counts in Task 9, and no staff screen here exceeds 3 taps to its primary action.
- **Prefer `database-async.js`'s async `pg.Pool` layer for all new route code.** The one exception (Task 5, modifying `server/routes/sales.js`'s existing `POST /` handler) reuses that route's own pre-existing **sync** `getDb()`/`db.transaction()` layer — not because sync is preferred, but because splitting layers mid-transaction there would break the atomicity the spec requires (§5: approve and create-sale must succeed or fail together).
- **No WhatsApp Business API, no payment gateway, no push/SMS.** Sharing is a manual `wa.me` deep link; "I've paid" stays self-reported; status is checked by revisiting the same link. (Spec §2, "Explicitly not in scope".)
- **Every regression check goes into `server/scripts/verify-order-requests.js`**, following this repo's established copy-the-harness-don't-share-a-module convention (confirmed: `verify-register-expenses.js` duplicates `verify-order-flows.js`'s harness rather than importing it). Never remove another task's checks — only add.
- **Frontend verification gate:** `cd app && node scripts/babel-check.js <file>` on every touched/created frontend file — this repo's only automated frontend check.
- Money/currency symbol convention already in use: `₹`.

---

## Before you start (context every task shares)

- The public customer page is reached the same way `/track/:token` is today: **not** React Navigation linking — `app/App.js` does a raw `window.location.pathname` regex check *before* `AuthProvider`/`RootNavigator` ever mount, and renders the target screen as a bare component with zero app state. Task 10 adds a second branch to that same bypass.
- **This exact hosting gap already affects `/track/:token` and will identically affect `/order-request/:token`:** per `CLAUDE.md` and `VPS_DEPLOYMENT_GUIDE.md` §17, nothing in production actually serves the Expo web build at these paths yet — Nginx proxies everything straight to the Express API, which 404s on any non-`/api` path. This plan does **not** fix that (same as the tracking page's own build didn't) — Task 11 records this explicitly in `CLAUDE.md` so it isn't silently assumed to work. Local dev testing (`expo start --web`, hitting `localhost:19006/order-request/:token`) works fine and is what this plan's manual-trace steps use.
- `server/routes/sales.js`'s main create-sale route is `POST /` at (current) line 1526, using the **sync** `getDb()` layer and a `db.transaction(() => {...})` callback (not async). Its DB variable inside that closure is a plain synchronous `db`, matching every other query in that same function.
- `app/src/services/api.js` is a single `ApiService` class; new methods are added as plain class methods (no trailing commas, no `function` keyword), e.g. `getProduct(id) { return this.request('/products/' + id); }`.

---

### Task 1: Database schema — `order_requests` table, `users.order_request_token`, `upi_qr_image_url` setting

**Files:**
- Modify: `server/config/database.js`

**Interfaces:**
- Produces: table `order_requests` (columns per spec §3), column `users.order_request_token`, settings row `upi_qr_image_url` — every later task depends on these existing.

- [ ] **Step 1: Add the `order_requests` table inside `ensureCoreTables()`**

Open `server/config/database.js`. Find the `audit_logs` table block (currently lines 650-663, ending `runPsql('CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC)');`) and the comment right after it (`// ⚡ Note: All other indexes for base tables...`, line 665). Insert the new table **between** the `idx_audit_logs_created_at` line and that comment:

```js
  runPsql(`
    CREATE TABLE IF NOT EXISTS order_requests (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      recipient_name VARCHAR(255),
      recipient_phone VARCHAR(20),
      order_type VARCHAR(20) NOT NULL CHECK (order_type IN ('delivery', 'pickup')),
      delivery_address TEXT,
      message TEXT,
      requested_date DATE,
      requested_time VARCHAR(50),
      items_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      payment_claimed BOOLEAN DEFAULT false,
      payment_reference VARCHAR(100),
      status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
      decline_reason TEXT,
      created_sale_id INTEGER REFERENCES sales(id) ON DELETE SET NULL,
      reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  runPsql('CREATE INDEX IF NOT EXISTS idx_order_requests_customer ON order_requests(customer_id)');
  runPsql('CREATE INDEX IF NOT EXISTS idx_order_requests_status ON order_requests(status)');
```

- [ ] **Step 2: Add the `users.order_request_token` column inside `ensureCompatibilityColumns()`**

In the same file, find the `// ─── users (identity/roles/PIN login) ──────────────────────` block (currently starting line 690, e.g. `ensureColumn('users', 'employee_code', 'TEXT UNIQUE');` at line 691). Add a new line right after that block's existing `ensureColumn` calls for `users`:

```js
  ensureColumn('users', 'order_request_token', 'VARCHAR(64) UNIQUE');
```

- [ ] **Step 3: Seed the `upi_qr_image_url` setting**

Find the `// ─── Seed preference settings (idempotent) ────────────────` block (currently lines 1238-1247, ending with the `pref_counter_marks_delivered` INSERT). Add one more line right after it, in the same style:

```js
    runPsql(`INSERT INTO settings (key, value, description) VALUES ('upi_qr_image_url', '', 'UPI QR code image shown to customers on the order-request page for self-service payment') ON CONFLICT (key) DO NOTHING`);
```

- [ ] **Step 4: Verify the migration runs cleanly**

Run: `cd server && node -e "require('./config/database-async').getDb().then(() => { console.log('OK'); process.exit(0); }).catch(e => { console.error(e); process.exit(1); })"`

Expected: prints `✅ Connected to PostgreSQL (async adapter with pg.Pool)` then `OK`, exit code 0. This runs `ensureCompatibilityColumns()` (which calls `ensureCoreTables()`), so both the new table and the new column get created/verified idempotently against your local dev DB.

- [ ] **Step 5: Confirm the schema directly**

Run: `psql "$DATABASE_URL" -c "\d order_requests"` — expect to see all 18 columns from Step 1, with the two `CHECK` constraints listed.

Run: `psql "$DATABASE_URL" -c "\d users" | grep order_request_token` — expect one line showing `order_request_token | character varying(64)`.

Run: `psql "$DATABASE_URL" -c "SELECT key, value FROM settings WHERE key = 'upi_qr_image_url'"` — expect one row, empty string value.

- [ ] **Step 6: Re-run to confirm idempotency**

Run the Step 4 command a second time. Expected: same success output, no errors (proves every `CREATE TABLE IF NOT EXISTS` / `ensureColumn` / `ON CONFLICT DO NOTHING` is safe to re-run, which is what happens on every real server boot).

- [ ] **Step 7: Commit**

```bash
git add server/config/database.js
git commit -m "feat: add order_requests table, users.order_request_token, upi_qr_image_url setting"
```

---

### Task 2: Order-request token utility + customer link-sharing endpoint

**Files:**
- Create: `server/utils/order-request-token.js`
- Modify: `server/routes/customers.js`
- Create: `server/scripts/verify-order-requests.js`

**Interfaces:**
- Consumes: `order_requests`/`users.order_request_token` from Task 1.
- Produces: `generateOrderRequestToken(): string`, `buildOrderRequestUrl(token: string): string` (used again in Task 3); route `POST /api/customers/:id/order-request-link` → `{ success: true, data: { token, url } }` (consumed by the frontend in Task 7); the verify script's harness (consumed/extended by Tasks 3, 4, 5).

- [ ] **Step 1: Write the token utility**

Create `server/utils/order-request-token.js`:

```js
// Persistent, lazily-generated order-request token — see
// docs/superpowers/specs/2026-09-19-customer-order-request-design.md §6.
// Unlike tracking-token.js's signed-but-unstored token (one HMAC per sale,
// verified fresh every time with nothing in the DB), this token has to be
// persistent: it's shared with a customer once and then reused indefinitely
// by that same customer both to submit new requests and to check the
// status of old ones, not minted fresh per request.
const crypto = require('crypto');

if (process.env.NODE_ENV === 'production' && !process.env.PUBLIC_APP_URL) {
  throw new Error('PUBLIC_APP_URL must be set in production — otherwise order-request links point at localhost.');
}
const PUBLIC_APP_URL = process.env.PUBLIC_APP_URL || 'http://localhost:19006';

function generateOrderRequestToken() {
  return crypto.randomBytes(24).toString('hex');
}

function buildOrderRequestUrl(token) {
  return `${PUBLIC_APP_URL}/order-request/${token}`;
}

module.exports = { generateOrderRequestToken, buildOrderRequestUrl };
```

- [ ] **Step 2: Start the verify script with harness boilerplate + a first (failing) check**

Create `server/scripts/verify-order-requests.js`. This copies the established harness shape verbatim (same as `verify-register-expenses.js` copies `verify-order-flows.js`'s), then adds this task's checks:

```js
#!/usr/bin/env node
/**
 * Live verification of the customer order-request flow: link generation,
 * public submit/status page, staff review (list/decline), and the
 * approve-via-LogOrderScreen wiring in POST /sales. Run directly against
 * the local dev server + DB.
 *
 * Modeled on verify-order-flows.js's harness — extend this file the same
 * way: append checks, never remove another check's coverage.
 *
 * Usage: VERIFY_OWNER_PHONE=... VERIFY_OWNER_PASSWORD=... node server/scripts/verify-order-requests.js
 */
require('dotenv').config();
const { getDb } = require('../config/database-async');

const API_BASE = process.env.API_BASE_URL || 'http://localhost:3001/api';
const TEST_LOCATION_ID = 4; // "Test Loc" — the project's established scratch location

const checks = [];
const createdUserIds = [];
const createdOrderRequestIds = [];
const createdSaleIds = [];

function check(name, fn) {
  checks.push({ name, fn });
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

let staffCounter = 0;
async function createStaff(role, ownerToken) {
  staffCounter += 1;
  const phone = '9' + String(Date.now()).slice(-8) + String(staffCounter % 10);
  const name = `OrderRequestTest ${role} ${staffCounter}`;
  const { status, body } = await api('POST', '/users', ownerToken, {
    name, phone, password: 'testpass123', role, location_ids: [TEST_LOCATION_ID],
  });
  if (status !== 201 && status !== 200) throw new Error(`Could not create test ${role}: ${status} ${JSON.stringify(body)}`);
  const userId = body.data.id || body.data.user?.id;
  createdUserIds.push(userId);
  const loginRes = await api('POST', '/auth/login', null, { phone, password: 'testpass123' });
  if (loginRes.status !== 200) throw new Error(`Could not login as newly created ${role}: ${JSON.stringify(loginRes.body)}`);
  return { token: loginRes.body.data.token, id: userId, role };
}

async function createCustomer(ownerToken) {
  staffCounter += 1;
  const phone = '8' + String(Date.now()).slice(-8) + String(staffCounter % 10);
  const name = `OrderRequestTest customer ${staffCounter}`;
  const { status, body } = await api('POST', '/users', ownerToken, {
    name, phone, password: 'testpass123', role: 'customer',
  });
  if (status !== 201 && status !== 200) throw new Error(`Could not create test customer: ${status} ${JSON.stringify(body)}`);
  const userId = body.data.id || body.data.user?.id;
  createdUserIds.push(userId);
  return { id: userId, name, phone };
}

async function getTestProduct() {
  const db = await getDb();
  const product = await db.prepare(
    "SELECT id, name, selling_price FROM products WHERE is_active = 1 ORDER BY id LIMIT 1"
  ).get();
  if (!product) throw new Error('No active product found in the dev DB — create at least one product before running this script.');
  return product;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

module.exports = {
  check, checks, api, loginOwner, createStaff, createCustomer, getTestProduct, assert,
  TEST_LOCATION_ID, createdUserIds, createdOrderRequestIds, createdSaleIds, getDb, assertLocalTarget,
};

// ─── Task 2: link generation ────────────────────────────────────────────
let sharedCustomer; // set here, reused by later checks in this file
let sharedCustomerToken;

check('owner can generate an order-request link for a customer', async () => {
  const owner = await loginOwner();
  sharedCustomer = await createCustomer(owner.token);
  const { status, body } = await api('POST', `/customers/${sharedCustomer.id}/order-request-link`, owner.token);
  assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert(typeof body.data.token === 'string' && body.data.token.length > 0, 'Expected a non-empty token');
  assert(body.data.url.includes(`/order-request/${body.data.token}`), `Expected url to contain the token, got ${body.data.url}`);
  sharedCustomerToken = body.data.token;
});

check('the same customer\'s link is idempotent — second call returns the same token', async () => {
  const owner = await loginOwner();
  const { status, body } = await api('POST', `/customers/${sharedCustomer.id}/order-request-link`, owner.token);
  assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert(body.data.token === sharedCustomerToken, `Expected the same token on a second call, got a different one`);
});

check('florist_staff cannot generate an order-request link (403)', async () => {
  const owner = await loginOwner();
  const florist = await createStaff('florist_staff', owner.token);
  const { status } = await api('POST', `/customers/${sharedCustomer.id}/order-request-link`, florist.token);
  assert(status === 403, `Expected 403 for florist_staff, got ${status}`);
});

check('counter_staff CAN generate an order-request link', async () => {
  const owner = await loginOwner();
  const counterStaff = await createStaff('counter_staff', owner.token);
  const { status } = await api('POST', `/customers/${sharedCustomer.id}/order-request-link`, counterStaff.token);
  assert(status === 200, `Expected 200 for counter_staff, got ${status}`);
});

async function cleanup() {
  if (createdUserIds.length === 0 && createdOrderRequestIds.length === 0 && createdSaleIds.length === 0) return;
  const db = await getDb();
  for (const saleId of createdSaleIds) {
    try {
      await db.prepare('DELETE FROM production_tasks WHERE sale_id = ?').run(saleId);
      await db.prepare('DELETE FROM payments WHERE sale_id = ?').run(saleId);
      await db.prepare('DELETE FROM sale_items WHERE sale_id = ?').run(saleId);
      await db.prepare('DELETE FROM sales WHERE id = ?').run(saleId);
    } catch (err) {
      console.error(`   (cleanup warning: sale ${saleId}: ${err.message})`);
    }
  }
  for (const id of createdOrderRequestIds) {
    try {
      await db.prepare('DELETE FROM order_requests WHERE id = ?').run(id);
    } catch (err) {
      console.error(`   (cleanup warning: order_request ${id}: ${err.message})`);
    }
  }
  for (const userId of createdUserIds) {
    try {
      await db.prepare('UPDATE users SET order_request_token = NULL WHERE id = ?').run(userId);
      await db.prepare('DELETE FROM user_locations WHERE user_id = ?').run(userId);
      await db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    } catch (err) {
      console.error(`   (cleanup warning: user ${userId}: ${err.message})`);
    }
  }
  console.log(`Cleaned up ${createdSaleIds.length} sale(s), ${createdOrderRequestIds.length} order_request(s), ${createdUserIds.length} user(s)`);
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

- [ ] **Step 3: Run the new script — confirm it fails correctly (route doesn't exist yet)**

Run: `VERIFY_OWNER_PHONE=<your dev owner phone> VERIFY_OWNER_PASSWORD=<your dev owner password> node server/scripts/verify-order-requests.js` (from `server/`, or adjust the path — match how you already run `verify-order-flows.js` in this environment).

Expected: the first check fails with a 404 (route not mounted yet) — confirms the harness itself works and the test is meaningful before the implementation exists.

- [ ] **Step 4: Add the customer link-sharing endpoint**

Open `server/routes/customers.js`. Add the import near the top, alongside the existing `require('../middleware/auth')` line (line 10):

```js
const { generateOrderRequestToken, buildOrderRequestUrl } = require('../utils/order-request-token');
```

Find the end of the `GET /:id` route handler (currently ending `});` at line 348, immediately before the `// ─── POST /api/customers ────────────────────────────────────` comment at line 350). Insert the new route between them:

```js
// ─── POST /api/customers/:id/order-request-link ──────────────────────
// Lazily generates (or returns the existing) shareable order-request link
// for a registered customer. See server/routes/order-request-public.js for
// the public page this URL points to.
router.post(
  '/:id/order-request-link',
  authenticate,
  authorize('owner', 'manager', 'employee', 'counter_staff'),
  async (req, res, next) => {
    try {
      const db = await getAsyncDb();
      const customer = await db.prepare(
        "SELECT id, order_request_token FROM users WHERE id = ? AND role = 'customer'"
      ).get(req.params.id);
      if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

      let token = customer.order_request_token;
      if (!token) {
        token = generateOrderRequestToken();
        await db.prepare('UPDATE users SET order_request_token = ? WHERE id = ?').run(token, customer.id);
      }

      res.json({ success: true, data: { token, url: buildOrderRequestUrl(token) } });
    } catch (err) { next(err); }
  }
);
```

- [ ] **Step 5: Run the verify script again — confirm this task's checks pass**

Run the same command as Step 3.

Expected: `4/4 checks passed` (or however many checks exist if you're re-running after a partial run — all four checks added in Step 2 should now show ✅).

- [ ] **Step 6: Commit**

```bash
git add server/utils/order-request-token.js server/routes/customers.js server/scripts/verify-order-requests.js
git commit -m "feat: add order-request token utility and customer link-sharing endpoint"
```

---

### Task 3: Public order-request route — `GET`/`POST /api/order-request/:token`

**Files:**
- Create: `server/routes/order-request-public.js`
- Modify: `server/server.js`
- Modify: `server/scripts/verify-order-requests.js`

**Interfaces:**
- Consumes: `generateOrderRequestToken`/`buildOrderRequestUrl` pattern from Task 2 (not directly — this route only *validates* tokens, it doesn't generate them); `sharedCustomer`/`sharedCustomerToken` module-level vars from Task 2's checks (same file, checks run in registration order within one `main()` invocation).
- Produces: `GET /api/order-request/:token` → `{ success: true, data: { customer_name, products, upi_qr_image_url, requests } }` or `404 { success: false, message: 'Not found' }`; `POST /api/order-request/:token` → `201 { success: true, data: { id, status: 'pending' } }`. Both consumed by the frontend in Task 10.

- [ ] **Step 1: Write the public route file**

Create `server/routes/order-request-public.js`:

```js
// Public, unauthenticated order-request page — a customer opens a link a
// staff member shared (see server/routes/customers.js's
// POST /:id/order-request-link) and submits their own order request, which
// staff later review and approve into a real order via LogOrderScreen (see
// server/routes/order-requests.js for the staff-side routes, and
// server/routes/sales.js's POST / for the approve wiring — search
// "source_order_request_id").
//
// Same shape as server/routes/track.js (the app's other public route): its
// own self-contained per-IP rate limiter, deliberately NOT sharing state
// with track.js's — see CLAUDE.md's "Known structural debt" note on this
// being one of only two rate-limited routes in the app.
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { getDb: getAsyncDb } = require('../config/database-async');

// ─── Rate limiting (own, self-contained — see file header) ─────────────
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
const rateLimitBuckets = new Map();

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const now = Date.now();
  if (rateLimitBuckets.size > 10000) rateLimitBuckets.clear();
  const bucket = rateLimitBuckets.get(ip);
  if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitBuckets.set(ip, { windowStart: now, count: 1 });
    return next();
  }
  bucket.count += 1;
  if (bucket.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ success: false, message: 'Too many requests. Please try again in a minute.' });
  }
  next();
}

router.use(rateLimit);

// ─── GET /api/order-request/:token ──────────────────────────────────────
router.get('/:token', async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const customer = await db.prepare(
      "SELECT id, name FROM users WHERE order_request_token = ? AND role = 'customer'"
    ).get(req.params.token);
    if (!customer) return res.status(404).json({ success: false, message: 'Not found' });

    const products = await db.prepare(
      'SELECT id, name, description, category, selling_price FROM products WHERE is_active = 1 ORDER BY name ASC LIMIT 200'
    ).all();

    const requests = await db.prepare(`
      SELECT id, order_type, recipient_name, requested_date, requested_time,
             status, decline_reason, items_json, created_at
      FROM order_requests
      WHERE customer_id = ?
      ORDER BY created_at DESC
      LIMIT 10
    `).all(customer.id);

    const qrSetting = await db.prepare("SELECT value FROM settings WHERE key = 'upi_qr_image_url'").get();

    res.json({
      success: true,
      data: {
        customer_name: customer.name,
        products,
        upi_qr_image_url: (qrSetting && qrSetting.value) || null,
        requests,
      },
    });
  } catch (err) { next(err); }
});

// ─── POST /api/order-request/:token ─────────────────────────────────────
router.post(
  '/:token',
  [
    body('recipient_name').trim().notEmpty().withMessage('Recipient name is required'),
    body('recipient_phone').trim().notEmpty().withMessage('Recipient phone is required'),
    body('order_type').isIn(['delivery', 'pickup']),
    body('delivery_address').if(body('order_type').equals('delivery')).trim().notEmpty().withMessage('Delivery address is required'),
    body('message').optional({ nullable: true }).trim(),
    body('requested_date').notEmpty().withMessage('Requested date is required'),
    body('requested_time').optional({ nullable: true }).trim(),
    body('items').isArray({ min: 1 }).withMessage('At least one item is required'),
    body('items.*.quantity').isInt({ min: 1 }),
    body('items.*.product_id').optional({ nullable: true }).isInt(),
    body('items.*.custom').optional().isBoolean(),
    body('items.*.description').optional({ nullable: true }).trim(),
    body('payment_claimed').optional().isBoolean().toBoolean(),
    body('payment_reference').optional({ nullable: true }).trim(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });

      const db = await getAsyncDb();
      const customer = await db.prepare(
        "SELECT id FROM users WHERE order_request_token = ? AND role = 'customer'"
      ).get(req.params.token);
      if (!customer) return res.status(404).json({ success: false, message: 'Not found' });

      const {
        recipient_name, recipient_phone, order_type, delivery_address, message,
        requested_date, requested_time, items, payment_claimed, payment_reference,
      } = req.body;

      // Every item needs either a real catalog product reference or a
      // non-empty custom description — a bare {quantity: 2} with neither is
      // silently useless downstream (LogOrderScreen's prefill has nothing
      // to show for it). Product existence/active-state is deliberately
      // NOT re-validated here — see spec §7: drift is handled entirely at
      // approve time by LogOrderScreen's own live checks, not here.
      const validItems = items.filter((item) => {
        if (item.custom) return typeof item.description === 'string' && item.description.trim().length > 0;
        return Number.isInteger(item.product_id);
      });
      if (validItems.length === 0) {
        return res.status(400).json({ success: false, message: 'At least one item is required' });
      }

      const insertResult = await db.prepare(`
        INSERT INTO order_requests (
          customer_id, recipient_name, recipient_phone, order_type, delivery_address,
          message, requested_date, requested_time, items_json, payment_claimed, payment_reference
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        customer.id, recipient_name.trim(), recipient_phone.trim(), order_type,
        order_type === 'delivery' ? (delivery_address || '').trim() : null,
        message ? message.trim() : null, requested_date, requested_time || null,
        validItems, !!payment_claimed, payment_reference ? payment_reference.trim() : null
      );

      res.status(201).json({ success: true, data: { id: insertResult.lastInsertRowid, status: 'pending' } });
    } catch (err) { next(err); }
  }
);

module.exports = router;
```

- [ ] **Step 2: Mount the route**

Open `server/server.js`. Add the import near the other route imports, right after `const trackRoutes = require('./routes/track');` (line 25):

```js
const orderRequestPublicRoutes = require('./routes/order-request-public');
```

Find the `app.use('/api/track', trackRoutes);` line (line 88) and add the new mount immediately after it, with a matching comment:

```js
// No `authenticate` middleware — public, like /api/track. Own rate
// limiter (see server/routes/order-request-public.js), not shared with
// track's.
app.use('/api/order-request', orderRequestPublicRoutes);
```

- [ ] **Step 3: Add this task's checks to the verify script**

Open `server/scripts/verify-order-requests.js`. Add these checks right before the `async function cleanup() {` line, after the four Task 2 checks:

```js
// ─── Task 3: public GET/POST /api/order-request/:token ─────────────────
check('GET with an invalid token returns a generic 404', async () => {
  const { status, body } = await api('GET', '/order-request/not-a-real-token', null);
  assert(status === 404, `Expected 404, got ${status}`);
  assert(body.message === 'Not found', `Expected generic "Not found" message, got "${body.message}"`);
});

check('GET with a valid token returns the customer name and product catalog', async () => {
  const { status, body } = await api('GET', `/order-request/${sharedCustomerToken}`, null);
  assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert(body.data.customer_name === sharedCustomer.name, `Expected customer_name "${sharedCustomer.name}", got "${body.data.customer_name}"`);
  assert(Array.isArray(body.data.products), 'Expected products to be an array');
  assert(Array.isArray(body.data.requests), 'Expected requests to be an array');
});

let submittedRequestId;
check('POST with a catalog item creates a pending request', async () => {
  const product = await getTestProduct();
  const { status, body } = await api('POST', `/order-request/${sharedCustomerToken}`, null, {
    recipient_name: 'Test Recipient', recipient_phone: '9876543210',
    order_type: 'pickup', requested_date: '2026-12-25',
    items: [{ product_id: product.id, quantity: 2 }],
  });
  assert(status === 201, `Expected 201, got ${status}: ${JSON.stringify(body)}`);
  assert(body.data.status === 'pending', `Expected status pending, got ${body.data.status}`);
  submittedRequestId = body.data.id;
  createdOrderRequestIds.push(submittedRequestId);
});

check('POST with a custom item creates a pending request', async () => {
  const { status, body } = await api('POST', `/order-request/${sharedCustomerToken}`, null, {
    recipient_name: 'Test Recipient', recipient_phone: '9876543210',
    order_type: 'delivery', delivery_address: '123 Test St', requested_date: '2026-12-25',
    items: [{ custom: true, description: 'A dozen red roses, extra tall', quantity: 1 }],
  });
  assert(status === 201, `Expected 201, got ${status}: ${JSON.stringify(body)}`);
  createdOrderRequestIds.push(body.data.id);
});

check('POST with both a catalog item and a custom item works', async () => {
  const product = await getTestProduct();
  const { status, body } = await api('POST', `/order-request/${sharedCustomerToken}`, null, {
    recipient_name: 'Test Recipient', recipient_phone: '9876543210',
    order_type: 'pickup', requested_date: '2026-12-25',
    items: [{ product_id: product.id, quantity: 1 }, { custom: true, description: 'A ribbon in gold', quantity: 1 }],
  });
  assert(status === 201, `Expected 201, got ${status}: ${JSON.stringify(body)}`);
  createdOrderRequestIds.push(body.data.id);
});

check('POST with an empty items array is rejected', async () => {
  const { status } = await api('POST', `/order-request/${sharedCustomerToken}`, null, {
    recipient_name: 'Test Recipient', recipient_phone: '9876543210',
    order_type: 'pickup', requested_date: '2026-12-25',
    items: [],
  });
  assert(status === 400, `Expected 400 for an empty cart, got ${status}`);
});

check('POST with delivery order_type but no address is rejected', async () => {
  const product = await getTestProduct();
  const { status } = await api('POST', `/order-request/${sharedCustomerToken}`, null, {
    recipient_name: 'Test Recipient', recipient_phone: '9876543210',
    order_type: 'delivery', requested_date: '2026-12-25',
    items: [{ product_id: product.id, quantity: 1 }],
  });
  assert(status === 400, `Expected 400 for delivery with no address, got ${status}`);
});

// Placed last, deliberately: fires 31 rapid requests against the SAME ip,
// which will push every other check above past this rate limiter's window
// if run again within 60s of this one. Nothing later in this file depends
// on hitting /order-request again, so this being last is safe.
check('rate limiter returns 429 after exceeding the per-minute threshold', async () => {
  let last;
  for (let i = 0; i < 31; i += 1) {
    last = await api('GET', `/order-request/${sharedCustomerToken}`, null);
  }
  assert(last.status === 429, `Expected the 31st rapid request to be rate-limited (429), got ${last.status}`);
});
```

- [ ] **Step 4: Run the verify script — confirm all checks (Task 2 + Task 3) pass**

Run the same command as Task 2 Step 3.

Expected: all checks pass (Task 2's 4 + Task 3's 8 = 12/12).

- [ ] **Step 5: Commit**

```bash
git add server/routes/order-request-public.js server/server.js server/scripts/verify-order-requests.js
git commit -m "feat: add public order-request submit/status route with its own rate limiter"
```

---

### Task 4: Staff review routes — list + decline

**Files:**
- Create: `server/routes/order-requests.js`
- Modify: `server/server.js`
- Modify: `server/scripts/verify-order-requests.js`

**Interfaces:**
- Consumes: `submittedRequestId` from Task 3's checks.
- Produces: `GET /api/order-requests?status=pending|approved|declined` → `{ success: true, data: { requests: [...], total } }`; `PUT /api/order-requests/:id/decline` → `{ success: true }`. Both consumed by the frontend in Task 9.

- [ ] **Step 1: Write the staff routes file**

Create `server/routes/order-requests.js`:

```js
// Staff review routes for customer order requests. See
// server/routes/order-request-public.js for the public submission side,
// and server/routes/sales.js's POST / (search "source_order_request_id")
// for how Approve actually works: it is NOT a route in this file — it's
// LogOrderScreen's own existing Save Order action, pre-filled with a
// request's data. See the design doc §5 for why.
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authenticate, authorize } = require('../middleware/auth');
const { getDb: getAsyncDb } = require('../config/database-async');

// ─── GET /api/order-requests ────────────────────────────────────────────
router.get('/', authenticate, authorize('owner', 'manager', 'employee', 'counter_staff'), async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const status = ['pending', 'approved', 'declined'].includes(req.query.status) ? req.query.status : 'pending';
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 50, 100));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

    const requests = await db.prepare(`
      SELECT r.*, u.name as customer_name, u.phone as customer_phone
      FROM order_requests r
      LEFT JOIN users u ON r.customer_id = u.id
      WHERE r.status = ?
      ORDER BY r.created_at DESC
      LIMIT ? OFFSET ?
    `).all(status, limit, offset);

    const totalRow = await db.prepare('SELECT COUNT(*) as count FROM order_requests WHERE status = ?').get(status);

    res.json({ success: true, data: { requests, total: Number(totalRow?.count || 0) } });
  } catch (err) { next(err); }
});

// ─── PUT /api/order-requests/:id/decline ────────────────────────────────
router.put(
  '/:id/decline',
  authenticate,
  authorize('owner', 'manager', 'employee', 'counter_staff'),
  [body('reason').optional({ nullable: true }).trim()],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });

      const db = await getAsyncDb();
      const existing = await db.prepare('SELECT id, status FROM order_requests WHERE id = ?').get(req.params.id);
      if (!existing) return res.status(404).json({ success: false, message: 'Request not found' });
      if (existing.status !== 'pending') {
        return res.status(400).json({ success: false, message: 'This request has already been reviewed.' });
      }

      await db.prepare(`
        UPDATE order_requests
        SET status = 'declined', decline_reason = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(req.body.reason || null, req.user.id, req.params.id);

      res.json({ success: true });
    } catch (err) { next(err); }
  }
);

module.exports = router;
```

- [ ] **Step 2: Mount the route**

In `server/server.js`, add the import near `const customersRoutes = require('./routes/customers');` (line 22):

```js
const orderRequestsRoutes = require('./routes/order-requests');
```

Add the mount right after `app.use('/api/customers', customersRoutes);` (line 83):

```js
app.use('/api/order-requests', orderRequestsRoutes);
```

- [ ] **Step 3: Add this task's checks to the verify script**

Insert before `async function cleanup() {`, after Task 3's checks:

```js
// ─── Task 4: staff list + decline ───────────────────────────────────────
check('staff can list pending order requests and sees the submitted one', async () => {
  const owner = await loginOwner();
  const { status, body } = await api('GET', '/order-requests?status=pending', owner.token);
  assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert(body.data.requests.some((r) => r.id === submittedRequestId), 'Expected the submitted request to appear in the pending list');
  assert(typeof body.data.total === 'number', 'Expected a numeric total');
});

check('florist_staff cannot list order requests (403)', async () => {
  const owner = await loginOwner();
  const florist = await createStaff('florist_staff', owner.token);
  const { status } = await api('GET', '/order-requests?status=pending', florist.token);
  assert(status === 403, `Expected 403 for florist_staff, got ${status}`);
});

let declineTargetId;
check('staff can decline a pending request with a reason', async () => {
  const owner = await loginOwner();
  const product = await getTestProduct();
  const submitRes = await api('POST', `/order-request/${sharedCustomerToken}`, null, {
    recipient_name: 'Decline Test', recipient_phone: '9876543211',
    order_type: 'pickup', requested_date: '2026-12-25',
    items: [{ product_id: product.id, quantity: 1 }],
  });
  declineTargetId = submitRes.body.data.id;
  createdOrderRequestIds.push(declineTargetId);

  const { status, body } = await api('PUT', `/order-requests/${declineTargetId}/decline`, owner.token, { reason: 'Out of stock for this date' });
  assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);

  const db = await getDb();
  const row = await db.prepare('SELECT status, decline_reason, reviewed_by, reviewed_at FROM order_requests WHERE id = ?').get(declineTargetId);
  assert(row.status === 'declined', `Expected status declined, got ${row.status}`);
  assert(row.decline_reason === 'Out of stock for this date', `Expected the decline reason to be saved, got "${row.decline_reason}"`);
  assert(row.reviewed_by === owner.id, `Expected reviewed_by to be the owner's id`);
  assert(row.reviewed_at !== null, 'Expected reviewed_at to be set');
});

check('declining an already-reviewed request is rejected', async () => {
  const owner = await loginOwner();
  const { status, body } = await api('PUT', `/order-requests/${declineTargetId}/decline`, owner.token, { reason: 'Second attempt' });
  assert(status === 400, `Expected 400 for re-declining, got ${status}: ${JSON.stringify(body)}`);
});

check('the customer\'s own status view reflects the decline and reason', async () => {
  const { body } = await api('GET', `/order-request/${sharedCustomerToken}`, null);
  const declined = body.data.requests.find((r) => r.id === declineTargetId);
  assert(declined, 'Expected the declined request to appear in the customer\'s own status view');
  assert(declined.status === 'declined', `Expected status declined, got ${declined.status}`);
  assert(declined.decline_reason === 'Out of stock for this date', 'Expected the decline reason visible to the customer');
});
```

- [ ] **Step 4: Run the verify script — confirm all checks pass**

Expected: 12 (Tasks 2+3) + 5 (Task 4) = 17/17.

- [ ] **Step 5: Commit**

```bash
git add server/routes/order-requests.js server/server.js server/scripts/verify-order-requests.js
git commit -m "feat: add staff order-request list and decline routes"
```

---

### Task 5: Approve wiring — `source_order_request_id` in `POST /sales`

**Files:**
- Modify: `server/routes/sales.js`
- Modify: `server/scripts/verify-order-requests.js`

**Interfaces:**
- Consumes: `order_requests` table (Task 1).
- Produces: `POST /sales` accepts an optional `source_order_request_id` (int) in its body; when present and the referenced request is still `pending`, the sale creation and the request's approval happen atomically in the same DB transaction. Consumed by `LogOrderScreen` in Task 8.

- [ ] **Step 1: Add the validator**

Open `server/routes/sales.js`. Find the validators array for the `POST /` route (currently lines 1526-1573, ending `body('route_id').optional({ nullable: true }).isInt(),`). Add one more line right after it:

```js
    body('source_order_request_id').optional({ nullable: true }).isInt(),
```

- [ ] **Step 2: Destructure the new field**

Find the destructuring block right after `const db = getDb();` (currently lines 1580-1593, ending `vendor_name, route_id,\n      } = req.body;`). Add `source_order_request_id` to that list:

```js
        vendor_name, route_id, source_order_request_id,
      } = req.body;
```

- [ ] **Step 3: Mark the request approved, inside the same transaction, right before the sale is returned**

Find the line `return { sale: newSale, assignedTaskIds };` (currently line 2099), inside the `createSale = db.transaction(() => { ... })` callback, right after the `newSale` query (lines 2091-2097). Insert the approval update immediately before that `return`:

```js
        // Approve wiring (design doc §5): if this sale is fulfilling a
        // customer order request, mark it approved atomically with the
        // sale itself — same transaction, so either both happen or
        // neither does. The `status = 'pending'` guard means calling this
        // twice with the same source_order_request_id (e.g. a retried
        // request) only links the FIRST successful sale, never overwrites
        // an existing link.
        if (source_order_request_id) {
          db.prepare(`
            UPDATE order_requests
            SET status = 'approved', created_sale_id = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'pending'
          `).run(saleId, req.user.id, source_order_request_id);
        }

        return { sale: newSale, assignedTaskIds };
```

- [ ] **Step 4: Add this task's checks to the verify script**

Insert before `async function cleanup() {`, after Task 4's checks:

```js
// ─── Task 5: approve wiring in POST /sales ──────────────────────────────
check('approving a request via POST /sales links back correctly', async () => {
  const owner = await loginOwner();
  const product = await getTestProduct();

  const submitRes = await api('POST', `/order-request/${sharedCustomerToken}`, null, {
    recipient_name: 'Approve Test', recipient_phone: '9876543212',
    order_type: 'pickup', requested_date: '2026-12-25',
    items: [{ product_id: product.id, quantity: 1 }],
  });
  const requestId = submitRes.body.data.id;
  createdOrderRequestIds.push(requestId);

  const saleRes = await api('POST', '/sales', owner.token, {
    location_id: TEST_LOCATION_ID, order_type: 'pickup',
    items: [{ product_id: product.id, quantity: 1, unit_price: product.selling_price }],
    source_order_request_id: requestId,
  });
  assert(saleRes.status === 201, `Expected 201 creating the sale, got ${saleRes.status}: ${JSON.stringify(saleRes.body)}`);
  const saleId = saleRes.body.data.id;
  createdSaleIds.push(saleId);

  const db = await getDb();
  const row = await db.prepare('SELECT status, created_sale_id, reviewed_by, reviewed_at FROM order_requests WHERE id = ?').get(requestId);
  assert(row.status === 'approved', `Expected status approved, got ${row.status}`);
  assert(row.created_sale_id === saleId, `Expected created_sale_id ${saleId}, got ${row.created_sale_id}`);
  assert(row.reviewed_by === owner.id, 'Expected reviewed_by to be the owner\'s id');
  assert(row.reviewed_at !== null, 'Expected reviewed_at to be set');
});

check('calling POST /sales again with an already-approved source_order_request_id does not re-link', async () => {
  const owner = await loginOwner();
  const product = await getTestProduct();

  const submitRes = await api('POST', `/order-request/${sharedCustomerToken}`, null, {
    recipient_name: 'Double Approve Test', recipient_phone: '9876543213',
    order_type: 'pickup', requested_date: '2026-12-25',
    items: [{ product_id: product.id, quantity: 1 }],
  });
  const requestId = submitRes.body.data.id;
  createdOrderRequestIds.push(requestId);

  const firstSale = await api('POST', '/sales', owner.token, {
    location_id: TEST_LOCATION_ID, order_type: 'pickup',
    items: [{ product_id: product.id, quantity: 1, unit_price: product.selling_price }],
    source_order_request_id: requestId,
  });
  createdSaleIds.push(firstSale.body.data.id);

  const secondSale = await api('POST', '/sales', owner.token, {
    location_id: TEST_LOCATION_ID, order_type: 'pickup',
    items: [{ product_id: product.id, quantity: 1, unit_price: product.selling_price }],
    source_order_request_id: requestId,
  });
  assert(secondSale.status === 201, 'Expected the second sale to still be created successfully');
  createdSaleIds.push(secondSale.body.data.id);

  const db = await getDb();
  const row = await db.prepare('SELECT created_sale_id FROM order_requests WHERE id = ?').get(requestId);
  assert(row.created_sale_id === firstSale.body.data.id, `Expected created_sale_id to stay linked to the FIRST sale (${firstSale.body.data.id}), got ${row.created_sale_id}`);
});
```

- [ ] **Step 5: Run the verify script — confirm all checks pass**

Expected: 17 (Tasks 2-4) + 2 (Task 5) = 19/19.

- [ ] **Step 6: Commit**

```bash
git add server/routes/sales.js server/scripts/verify-order-requests.js
git commit -m "feat: wire order-request approval into POST /sales via source_order_request_id"
```

---

### Task 6: Settings screen — UPI QR code upload field

**Files:**
- Modify: `app/src/screens/SettingsScreen.js`

**Interfaces:**
- Consumes: `upi_qr_image_url` setting (Task 1), `POST /api/upload` (pre-existing route, returns `{ success: true, url }`), `api.getMediaUrl(path)` (pre-existing).

- [ ] **Step 1: Add imports**

At the top of `app/src/screens/SettingsScreen.js`, add `Image` to the existing `react-native` import (line 2-11) and add a new `expo-image-picker` import right after the `@expo/vector-icons` import (line 13):

```js
import * as ImagePicker from 'expo-image-picker';
```
(Add `Image` to the destructured import list from `react-native`.)

- [ ] **Step 2: Add the label**

In the `SETTING_LABELS` object (lines 20-39), add:

```js
  upi_qr_image_url: 'UPI QR Code',
```

- [ ] **Step 3: Add upload state and handler**

Inside the `SettingsScreen` component, right after the existing `handlePrefToggle` function (ending line 162), add:

```js
  const [uploadingQr, setUploadingQr] = useState(false);

  const handlePickQrImage = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission Required', 'Please allow photo library access to upload the QR code.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
    if (result.canceled || !result.assets?.[0]?.uri) return;

    setUploadingQr(true);
    try {
      const uri = result.assets[0].uri;
      const formData = new FormData();
      if (Platform.OS === 'web') {
        const response = await fetch(uri);
        const blob = await response.blob();
        formData.append('image', blob, 'qr-code.jpg');
      } else {
        const filename = uri.split('/').pop();
        const ext = /\.(\w+)$/.exec(filename)?.[1] || 'jpg';
        formData.append('image', { uri, name: filename, type: `image/${ext}` });
      }
      const uploadRes = await api.uploadGenericImage(formData);
      handleChange('upi_qr_image_url', uploadRes.url);
    } catch (err) {
      Alert.alert('Error', err.message || 'Could not upload the image');
    } finally {
      setUploadingQr(false);
    }
  };
```

Note: `Platform` needs to be added to the `react-native` import too (it isn't currently imported in this file).

- [ ] **Step 4: Add the `api.uploadGenericImage` method**

Open `app/src/services/api.js`. Add this method right after `uploadProductImage` (near line 490):

```js
  async uploadGenericImage(formData) {
    const response = await fetch(`${API_BASE_URL}/upload`, {
      method: 'POST',
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
      body: formData,
    });
    const data = await response.json();
    if (!response.ok) throw { status: response.status, message: data.message || 'Upload failed' };
    return data;
  }
```

- [ ] **Step 5: Add the special-case render**

In `SettingsScreen.js`'s `sortedKeys.map((key) => { ... })` loop, find the `supplier_manager_fields` special case (lines 214-245, `if (key === 'supplier_manager_fields') { ... }`). Add a second special case right after that `if` block closes (before the generic `return (...)` at line 247):

```js
            if (key === 'upi_qr_image_url') {
              return (
                <View key={key} style={styles.settingRow}>
                  <Text style={styles.settingLabel}>{SETTING_LABELS[key]}</Text>
                  <Text style={styles.settingDesc}>Shown to customers on the order-request page so they can pay by UPI.</Text>
                  {!!currentValue && (
                    <Image source={{ uri: api.getMediaUrl(currentValue) }} style={{ width: 120, height: 120, borderRadius: BorderRadius.sm, marginTop: Spacing.sm }} resizeMode="contain" />
                  )}
                  {isOwner && (
                    <Button
                      title={currentValue ? 'Replace QR Code' : 'Upload QR Code'}
                      onPress={handlePickQrImage}
                      loading={uploadingQr}
                      variant="outline"
                      size="sm"
                      style={{ marginTop: Spacing.sm, alignSelf: 'flex-start' }}
                    />
                  )}
                </View>
              );
            }

```

- [ ] **Step 6: Babel-check**

Run: `cd app && node scripts/babel-check.js src/screens/SettingsScreen.js src/services/api.js`

Expected: `OK   src/screens/SettingsScreen.js` and `OK   src/services/api.js`.

- [ ] **Step 7: Manual trace**

Start the app (`cd app && npx expo start --web`), log in as owner, go to Settings, tap "Upload QR Code", pick an image, confirm a preview appears and a "Save Changes" button shows up; tap it; reload Settings and confirm the QR image still shows (persisted).

- [ ] **Step 8: Commit**

```bash
git add app/src/screens/SettingsScreen.js app/src/services/api.js
git commit -m "feat: add UPI QR code upload to Settings screen"
```

---

### Task 7: Customer profile — "Copy Order Link" / WhatsApp share buttons

**Files:**
- Modify: `app/src/screens/CustomerDetailScreen.js`
- Modify: `app/src/utils/contact.js`
- Modify: `app/src/services/api.js`
- Modify: `app/package.json` (add `expo-clipboard`)

**Interfaces:**
- Consumes: `POST /api/customers/:id/order-request-link` (Task 2).
- Produces: `api.getOrderRequestLink(customerId)`; a new `buildMessage('order_request_link', {...})` template.

**Staff-ux-checklist tap count:** from an already-open Customer profile, both actions are **1 tap** each ("Copy Order Link" or "Share via WhatsApp" — no navigation, no modal).

- [ ] **Step 1: Install `expo-clipboard`**

Run: `cd app && npx expo install expo-clipboard`

Expected: adds `expo-clipboard` to `app/package.json` at the SDK-54-matched version.

- [ ] **Step 2: Add the message template**

Open `app/src/utils/contact.js`. Add a new entry to the `TEMPLATES` object (before the closing `general_inquiry` line, i.e. right after the `tracking_link` template ending `};`, currently line 63):

```js
  order_request_link: (p) => {
    const greeting = p.customer_name ? `Hi ${p.customer_name},` : 'Hi,';
    return `${greeting} you can place your order request here:\n${p.order_request_url}`;
  },
```

- [ ] **Step 3: Add the `api.getOrderRequestLink` method**

Open `app/src/services/api.js`. Add this method near `getProduct` (or anywhere in the "Customers" section — search for `// ─── Customers` if one exists, otherwise place near the other customer-related methods):

```js
  getOrderRequestLink(customerId) {
    return this.request(`/customers/${customerId}/order-request-link`, { method: 'POST' });
  }
```

- [ ] **Step 4: Add the buttons to `CustomerDetailScreen.js`**

Open `app/src/screens/CustomerDetailScreen.js`. Update the imports:

```js
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  RefreshControl, Alert, Modal, TextInput, Platform, KeyboardAvoidingView, Linking,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
```

(Add `Linking` to the existing `react-native` import; add the new `expo-clipboard` import right after it.) Also add, alongside the existing `import api from '../services/api';` line:

```js
import { waLink, buildMessage } from '../utils/contact';
```

Inside the `CustomerDetailScreen` component, add this state and these two handlers right after the existing `handleAddPaymentLine`/`updatePaymentLine`/`removePaymentLine` functions (ending line 39):

```js
  const [linkLoading, setLinkLoading] = useState(false);

  const handleCopyOrderLink = async () => {
    setLinkLoading(true);
    try {
      const res = await api.getOrderRequestLink(customer.id);
      await Clipboard.setStringAsync(res.data.url);
      Alert.alert('Copied', 'Order link copied — paste it into a WhatsApp chat or message.');
    } catch (err) {
      Alert.alert('Error', err.message || 'Could not get the order link');
    } finally {
      setLinkLoading(false);
    }
  };

  const handleShareOrderLinkViaWhatsapp = async () => {
    setLinkLoading(true);
    try {
      const res = await api.getOrderRequestLink(customer.id);
      Linking.openURL(waLink(customer.phone, buildMessage('order_request_link', {
        customer_name: customer.name,
        order_request_url: res.data.url,
      })));
    } catch (err) {
      Alert.alert('Error', err.message || 'Could not get the order link');
    } finally {
      setLinkLoading(false);
    }
  };
```

Then, in the render, find the `{canManage && ( <TouchableOpacity style={styles.editBtn} ...> ... </TouchableOpacity> )}` block (lines 267-272), and add a new row right after it, still inside the `header` View (before its closing `</View>` at line 273):

```js
          <View style={styles.linkRow}>
            <TouchableOpacity style={styles.editBtn} onPress={handleCopyOrderLink} disabled={linkLoading}>
              <Ionicons name="link-outline" size={14} color={Colors.primary} />
              <Text style={styles.editText}>Copy Order Link</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.editBtn} onPress={handleShareOrderLinkViaWhatsapp} disabled={linkLoading}>
              <Ionicons name="logo-whatsapp" size={14} color={Colors.primary} />
              <Text style={styles.editText}>Share via WhatsApp</Text>
            </TouchableOpacity>
          </View>
```

Add the `linkRow` style to the `StyleSheet.create({...})` block, near `editBtn`:

```js
  linkRow: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.sm },
```

- [ ] **Step 5: Babel-check**

Run: `cd app && node scripts/babel-check.js src/screens/CustomerDetailScreen.js src/utils/contact.js src/services/api.js`

Expected: `OK` for all three.

- [ ] **Step 6: Manual trace**

Open a customer's profile as owner or counter_staff. Tap "Copy Order Link" — expect an alert confirming the copy. Tap "Share via WhatsApp" — expect it to attempt opening `wa.me` (in a web browser this opens a new tab/prompt; on a device with WhatsApp installed it opens the app pre-filled).

- [ ] **Step 7: Commit**

```bash
git add app/package.json app/package-lock.json app/src/screens/CustomerDetailScreen.js app/src/utils/contact.js app/src/services/api.js
git commit -m "feat: add Copy Order Link / WhatsApp share buttons to customer profile"
```

---

### Task 8: `LogOrderScreen` — accept and apply an order-request pre-fill

**Files:**
- Modify: `app/src/screens/LogOrderScreen.js`

**Interfaces:**
- Consumes: navigation param `prefillRequest` (an `order_requests` row shape: `{ id, customer_id, customer_name, customer_phone, recipient_name, recipient_phone, order_type, delivery_address, message, requested_date, requested_time, items_json }`) and `prefillToken` (a dedup key, `Date.now()`), passed by Task 9's `OrderRequestsScreen`; `api.getProduct(id)` (pre-existing).
- Produces: on `handleSave()`, the payload sent to `api.createSale` gains `source_order_request_id` when the screen was reached via pre-fill — consumed by Task 5's backend wiring.

- [ ] **Step 1: Accept `route` as a prop**

Open `app/src/screens/LogOrderScreen.js`. Change the component signature from `export default function LogOrderScreen({ navigation }) {` to:

```js
export default function LogOrderScreen({ navigation, route }) {
```

- [ ] **Step 2: Add pre-fill state and the apply effect**

Confirm `useEffect` and `useRef` are imported from `react` at the top of the file (add them to the existing React import if not already present). Add this state near the other state declarations (e.g. right after the `vendorName` state, around line 104):

```js
  const [sourceOrderRequestId, setSourceOrderRequestId] = useState(null);
  const prefillAppliedTokenRef = useRef(null);
```

Add this effect right after the state declarations, before the first function definition in the component body:

```js
  useEffect(() => {
    const prefillToken = route.params?.prefillToken;
    const req = route.params?.prefillRequest;
    if (!prefillToken || !req || prefillAppliedTokenRef.current === prefillToken) return;
    prefillAppliedTokenRef.current = prefillToken;

    setSourceOrderRequestId(req.id);
    setFulfilment(req.order_type === 'delivery' ? 'delivery' : 'pickup');
    setReceiverName(req.recipient_name || '');
    setReceiverPhone(req.recipient_phone || '');
    setDeliveryAddress(req.delivery_address || '');
    if (req.message) setNote(`Card message: ${req.message}`);
    if (req.requested_date) setScheduledDate(req.requested_date);
    if (req.requested_time) setScheduledTime(req.requested_time);
    if (req.customer_id) {
      setCustomerId(req.customer_id);
      setCustomerName(req.customer_name || '');
      setCustomerPhone(req.customer_phone || '');
    }

    (async () => {
      const resolvedItems = [];
      for (const item of (req.items_json || [])) {
        if (item.custom) {
          resolvedItems.push({
            product_id: null,
            product_name: item.description,
            quantity: item.quantity || 1,
            unit_price: 0,
          });
          continue;
        }
        try {
          const res = await api.getProduct(item.product_id);
          const product = res.data;
          if (!product || product.is_active === false || product.is_active === 0) {
            throw new Error('inactive');
          }
          resolvedItems.push({
            product_id: product.id,
            product_name: product.name,
            quantity: item.quantity || 1,
            unit_price: Number(product.selling_price) || 0,
          });
        } catch {
          resolvedItems.push({
            product_id: null,
            product_name: `Item no longer available (was product #${item.product_id}) — confirm with customer`,
            quantity: item.quantity || 1,
            unit_price: 0,
          });
        }
      }
      setItems(resolvedItems);
    })();

    navigation.setParams({ prefillRequest: undefined, prefillToken: undefined });
  }, [route.params?.prefillToken]);
```

- [ ] **Step 3: Pass `source_order_request_id` through on save**

In `handleSave()` (lines 303-415), find the object literal passed to `api.createSale(...)` (the payload built around lines 342-365, which already includes fields like `order_type: fulfilment`, `channel`, `customer_id`, `items`, `vendor_name`, etc.). Add one more conditional field to that same object literal:

```js
        ...(sourceOrderRequestId ? { source_order_request_id: sourceOrderRequestId } : {}),
```

Place it anywhere among the payload's other keys (e.g. right next to the existing `vendor_name` handling, since that's already a similarly-conditional owner/manager-only field in the same object).

- [ ] **Step 4: Babel-check**

Run: `cd app && node scripts/babel-check.js src/screens/LogOrderScreen.js`

Expected: `OK`.

- [ ] **Step 5: Manual trace (standalone, before Task 9's screen exists to launch it)**

From a REPL or temporary test, confirm the effect logic works by manually navigating with params once Task 9 exists (this step is re-verified as part of Task 9's own manual trace — for now, confirm the file has no syntax errors and `LogOrderScreen` still opens normally with no params, i.e. the FAB path (`navigation.navigate('LogOrder')` with no params) still works exactly as before, since `route.params?.prefillToken` will simply be `undefined` and the new effect does nothing.

Run the app, tap "Log Order" from Orders Inbox's FAB (no prefill), confirm the screen opens blank exactly as before this change.

- [ ] **Step 6: Commit**

```bash
git add app/src/screens/LogOrderScreen.js
git commit -m "feat: LogOrderScreen accepts an order-request pre-fill via navigation params"
```

---

### Task 9: Staff "Order Requests" screen + navigation + discovery

**Files:**
- Create: `app/src/screens/OrderRequestsScreen.js`
- Modify: `app/src/navigation/MainNavigator.js`
- Modify: `app/src/screens/OrdersHubScreen.js`
- Modify: `app/src/screens/OrdersInboxScreen.js`
- Modify: `app/src/services/api.js`

**Interfaces:**
- Consumes: `GET /api/order-requests` and `PUT /api/order-requests/:id/decline` (Task 4); navigates to `'LogOrder'` with `{ prefillRequest, prefillToken }` (Task 8).

**Staff-ux-checklist tap count (spec §5's "Approve is the load-bearing design decision"):**
- **Approve, from Orders Requests screen already open: 1 tap** ("Approve" button on the row) → lands directly in pre-filled `LogOrderScreen` → **1 more tap** ("Save Order", already existing) = **2 taps total** to turn a reviewed request into a real order.
- **Decline, from Orders Requests screen already open: 1 tap** ("Decline") → a small reason modal → **1 more tap** ("Confirm") = **2 taps total**.
- Both are well under the 4-tap hard-stop line.

- [ ] **Step 1: Add API methods**

Open `app/src/services/api.js`. Add these two methods near `getOrderRequestLink` (added in Task 7):

```js
  getOrderRequests(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.request(`/order-requests${query ? `?${query}` : ''}`);
  }

  declineOrderRequest(id, reason) {
    return this.request(`/order-requests/${id}/decline`, { method: 'PUT', body: JSON.stringify({ reason }) });
  }
```

- [ ] **Step 2: Write the screen**

Create `app/src/screens/OrderRequestsScreen.js`:

```js
import React, { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, Modal, TextInput,
  Alert, ActivityIndicator, RefreshControl,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';
import Button from '../components/Button';
import useSubmitGuard from '../hooks/useSubmitGuard';
import { Colors, Spacing, FontSize, BorderRadius } from '../constants/theme';

const STATUS_FILTERS = [
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'declined', label: 'Declined' },
];

function itemsSummary(itemsJson) {
  const items = Array.isArray(itemsJson) ? itemsJson : [];
  if (items.length === 0) return 'No items';
  const names = items.map((it) => it.custom ? it.description : (it.name || `Product #${it.product_id}`));
  return `${items.length} item${items.length > 1 ? 's' : ''}: ${names.join(', ')}`;
}

export default function OrderRequestsScreen({ navigation }) {
  const guardSubmit = useSubmitGuard();
  const [status, setStatus] = useState('pending');
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [declineTarget, setDeclineTarget] = useState(null);
  const [declineReason, setDeclineReason] = useState('');
  const [declining, setDeclining] = useState(false);

  const fetchRequests = useCallback(async (currentStatus) => {
    try {
      const res = await api.getOrderRequests({ status: currentStatus });
      setRequests(res.data.requests || []);
    } catch (err) {
      Alert.alert('Error', err.message || 'Could not load order requests');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      fetchRequests(status);
    }, [status, fetchRequests])
  );

  const handleApprove = (request) => {
    navigation.navigate('LogOrder', { prefillRequest: request, prefillToken: Date.now() });
  };

  const submitDecline = async () => {
    setDeclining(true);
    try {
      await api.declineOrderRequest(declineTarget.id, declineReason.trim() || undefined);
      setDeclineTarget(null);
      setDeclineReason('');
      fetchRequests(status);
    } catch (err) {
      Alert.alert('Error', err.message || 'Could not decline this request');
    } finally {
      setDeclining(false);
    }
  };

  const renderItem = ({ item }) => (
    <View style={styles.card}>
      <View style={styles.cardTop}>
        <Text style={styles.customerName}>{item.customer_name || 'Unknown customer'}</Text>
        <Text style={styles.orderTypeBadge}>{item.order_type === 'delivery' ? 'Delivery' : 'Pickup'}</Text>
      </View>
      <Text style={styles.recipientText}>For: {item.recipient_name} · {item.recipient_phone}</Text>
      <Text style={styles.dateText}>Requested for {item.requested_date}{item.requested_time ? `, ${item.requested_time}` : ''}</Text>
      <Text style={styles.itemsText} numberOfLines={2}>{itemsSummary(item.items_json)}</Text>
      <View style={styles.metaRow}>
        {item.payment_claimed && (
          <View style={styles.paidChip}><Text style={styles.paidChipText}>Says paid</Text></View>
        )}
        <Text style={styles.submittedAt}>Submitted {new Date(item.created_at).toLocaleDateString()}</Text>
      </View>
      {item.status === 'declined' && item.decline_reason && (
        <Text style={styles.declineReasonText}>Declined: {item.decline_reason}</Text>
      )}
      {item.status === 'pending' && (
        <View style={styles.actionsRow}>
          <Button title="Decline" variant="outline" size="sm" onPress={() => setDeclineTarget(item)} style={{ flex: 1 }} />
          <Button title="Approve" size="sm" onPress={guardSubmit(() => handleApprove(item))} style={{ flex: 1 }} />
        </View>
      )}
    </View>
  );

  return (
    <View style={styles.container}>
      <View style={styles.filterRow}>
        {STATUS_FILTERS.map((f) => (
          <TouchableOpacity key={f.key} style={[styles.filterChip, status === f.key && styles.filterChipActive]} onPress={() => setStatus(f.key)}>
            <Text style={[styles.filterChipText, status === f.key && styles.filterChipTextActive]}>{f.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <ActivityIndicator size="large" color={Colors.primary} style={{ marginTop: Spacing.xl }} />
      ) : (
        <FlatList
          data={requests}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchRequests(status); }} colors={[Colors.primary]} />}
          ListEmptyComponent={<Text style={styles.emptyText}>No {status} requests.</Text>}
        />
      )}

      <Modal visible={!!declineTarget} transparent animationType="fade" onRequestClose={() => setDeclineTarget(null)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Decline this request?</Text>
            <Text style={styles.modalSubtitle}>The customer will see this reason on their status page.</Text>
            <TextInput
              style={styles.modalInput}
              placeholder="Reason (optional)"
              value={declineReason}
              onChangeText={setDeclineReason}
              multiline
              placeholderTextColor={Colors.textLight}
            />
            <View style={styles.modalActions}>
              <Button title="Cancel" variant="ghost" onPress={() => setDeclineTarget(null)} style={{ flex: 1 }} />
              <Button title="Confirm Decline" variant="danger" loading={declining} onPress={guardSubmit(submitDecline)} style={{ flex: 1 }} />
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  filterRow: { flexDirection: 'row', gap: Spacing.sm, padding: Spacing.md },
  filterChip: { paddingVertical: Spacing.xs, paddingHorizontal: Spacing.md, borderRadius: BorderRadius.full, borderWidth: 1, borderColor: Colors.border },
  filterChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  filterChipText: { color: Colors.textSecondary, fontWeight: '600', fontSize: FontSize.sm },
  filterChipTextActive: { color: Colors.white },
  listContent: { padding: Spacing.md, paddingTop: 0 },
  emptyText: { textAlign: 'center', color: Colors.textLight, marginTop: Spacing.xl },
  card: { backgroundColor: Colors.surface, borderRadius: BorderRadius.md, padding: Spacing.md, marginBottom: Spacing.sm },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  customerName: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  orderTypeBadge: { fontSize: FontSize.xs, fontWeight: '700', color: Colors.primary, backgroundColor: Colors.primary + '18', paddingHorizontal: Spacing.sm, paddingVertical: 2, borderRadius: BorderRadius.full },
  recipientText: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 4 },
  dateText: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  itemsText: { fontSize: FontSize.sm, color: Colors.text, marginTop: Spacing.xs },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: Spacing.sm },
  paidChip: { backgroundColor: Colors.success + '18', paddingHorizontal: Spacing.sm, paddingVertical: 2, borderRadius: BorderRadius.full },
  paidChipText: { color: Colors.success, fontSize: FontSize.xs, fontWeight: '700' },
  submittedAt: { fontSize: FontSize.xs, color: Colors.textLight },
  declineReasonText: { fontSize: FontSize.sm, color: Colors.error, marginTop: Spacing.xs, fontStyle: 'italic' },
  actionsRow: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.md },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center', padding: Spacing.lg },
  modalCard: { backgroundColor: Colors.surface, borderRadius: BorderRadius.lg, padding: Spacing.lg, width: '100%', maxWidth: 400 },
  modalTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  modalSubtitle: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: Spacing.xs, marginBottom: Spacing.md },
  modalInput: { backgroundColor: Colors.background, borderRadius: BorderRadius.sm, padding: Spacing.md, minHeight: 60, textAlignVertical: 'top', borderWidth: 1, borderColor: Colors.border, color: Colors.text },
  modalActions: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.lg },
});
```

- [ ] **Step 3: Register the screen in both owner/manager and employee stacks**

Open `app/src/navigation/MainNavigator.js`. Add the import near `import LogOrderScreen from '../screens/LogOrderScreen';` (line 81):

```js
import OrderRequestsScreen from '../screens/OrderRequestsScreen';
```

Add `<Stack.Screen name="OrderRequests" component={OrderRequestsScreen} options={{ title: 'Order Requests' }} />` in **both**:
- `OrdersStack()` — right after the `LogOrder` line (currently line 361).
- `EmployeeOrdersStack()` — right after the `LogOrder` line (currently line 388).

- [ ] **Step 4: Add the Hub tile (owner/manager discovery path)**

Open `app/src/screens/OrdersHubScreen.js`. Add an entry to `SECTIONS` (lines 8-14):

```js
  { key: 'OrderRequests', icon: 'chatbubbles', label: 'Order Requests', color: '#E91E63', countKey: 'orderRequestsCount' },
```

In `fetchCounts` (lines 20-37), add a fourth parallel fetch and its resulting count field:

```js
    const [salesRes, deliveriesRes, pickupsRes, orderRequestsRes] = await Promise.all([
      api.getSales({ limit: 1 }).catch(() => ({ data: {} })),
      api.getDeliveries({ status: 'pending', limit: 1 }).catch(() => ({ data: { deliveries: [] } })),
      api.getSales({ order_type: 'pickup', pickup_status: 'waiting', limit: 1 }).catch(() => ({ data: {} })),
      api.getOrderRequests({ status: 'pending', limit: 1 }).catch(() => ({ data: { total: 0 } })),
    ]);
    setCounts({
      salesCount: salesRes.data?.pagination?.total || 0,
      deliveriesCount: deliveriesRes.data?.total || 0,
      pickupsCount: pickupsRes.data?.pagination?.total || 0,
      orderRequestsCount: orderRequestsRes.data?.total || 0,
    });
```

- [ ] **Step 5: Add the quick-link (employee/counter_staff discovery path)**

Open `app/src/screens/OrdersInboxScreen.js`. Find the `quickLinksRow` block (currently lines 557-568). Add a third link inside it, after the `DeliveriesList` one:

```js
          <TouchableOpacity style={styles.pickupLink} onPress={() => navigation.navigate('OrderRequests')}>
            <Ionicons name="chatbubbles-outline" size={16} color={Colors.primary} />
            <Text style={styles.pickupLinkText}>Order Requests →</Text>
          </TouchableOpacity>
```

- [ ] **Step 6: Babel-check**

Run: `cd app && node scripts/babel-check.js src/screens/OrderRequestsScreen.js src/navigation/MainNavigator.js src/screens/OrdersHubScreen.js src/screens/OrdersInboxScreen.js src/services/api.js`

Expected: `OK` for all five.

- [ ] **Step 7: Manual trace — this is the first point the full staff-side loop can be exercised end to end**

1. Using the Task 3/4 verify script (or the customer page once Task 10 exists) submit at least one pending request against a real dev customer.
2. Log in as owner (or counter_staff), navigate to Orders → Order Requests (Hub tile) or Orders Inbox → "Order Requests →" (employee quick-link).
3. Confirm the pending request appears with the right customer/recipient/date/items summary.
4. Tap **Approve** — confirm exactly one navigation to `LogOrder`, and that recipient name/phone/address/date/items are pre-filled (catalog items show current price; a custom item shows as a free-text line).
5. Tap **Save Order** — confirm the sale is created and you're returned to Orders Inbox.
6. Navigate back to Order Requests — confirm the approved request no longer appears under "Pending" (switch to the "Approved" filter to confirm it moved there).
7. Submit a second pending request, open Order Requests, tap **Decline**, type a reason, confirm — verify it moves to "Declined" and is no longer actionable.

- [ ] **Step 8: Commit**

```bash
git add app/src/screens/OrderRequestsScreen.js app/src/navigation/MainNavigator.js app/src/screens/OrdersHubScreen.js app/src/screens/OrdersInboxScreen.js app/src/services/api.js
git commit -m "feat: add staff Order Requests review screen with Hub tile and employee quick-link"
```

---

### Task 10: Public customer-facing order-request page

**Files:**
- Create: `app/src/screens/OrderRequestScreen.js`
- Modify: `app/App.js`
- Modify: `app/src/services/api.js`

**Interfaces:**
- Consumes: `GET`/`POST /api/order-request/:token` (Task 3), `api.getMediaUrl` (pre-existing), `useSubmitGuard` (pre-existing).
- Produces: nothing consumed by later tasks — this is the leaf of the dependency chain.

- [ ] **Step 1: Add API methods**

Open `app/src/services/api.js`. Add these two methods near `getTrackingInfo` (the public-tracking section):

```js
  getOrderRequestPage(token) {
    return this.request(`/order-request/${token}`);
  }

  submitOrderRequest(token, payload) {
    return this.request(`/order-request/${token}`, { method: 'POST', body: JSON.stringify(payload) });
  }
```

- [ ] **Step 2: Write the screen**

Create `app/src/screens/OrderRequestScreen.js`:

```js
// The customer-facing order-request page — a customer opens a link a staff
// member shared (see CustomerDetailScreen's "Copy Order Link"/WhatsApp
// buttons) and submits their own order request, which staff later review
// and approve into a real order (see OrderRequestsScreen.js + LogOrderScreen
// pre-fill). Rendered via App.js's routing bypass, same pattern as
// TrackingScreen.js — see that file's own header comment for why this
// screen must import NOTHING that depends on AuthContext or React
// Navigation.
import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity,
  ActivityIndicator, Image, Switch,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';
import Button from '../components/Button';
import useSubmitGuard from '../hooks/useSubmitGuard';
import { Colors, Spacing, FontSize, BorderRadius, Shadows } from '../constants/theme';

const WASH = '#FBF3EC';

export default function OrderRequestScreen({ token }) {
  const guardSubmit = useSubmitGuard();
  const [state, setState] = useState({ loading: true, data: null, errorKind: null });
  const [submitted, setSubmitted] = useState(false);

  const [orderType, setOrderType] = useState('delivery');
  const [recipientName, setRecipientName] = useState('');
  const [recipientPhone, setRecipientPhone] = useState('');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [message, setMessage] = useState('');
  const [requestedDate, setRequestedDate] = useState('');
  const [requestedTime, setRequestedTime] = useState('');
  const [items, setItems] = useState([]);
  const [productQuery, setProductQuery] = useState('');
  const [customText, setCustomText] = useState('');
  const [paymentClaimed, setPaymentClaimed] = useState(false);
  const [paymentReference, setPaymentReference] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  const loadPage = () => {
    api.getOrderRequestPage(token)
      .then((res) => setState({ loading: false, data: res.data, errorKind: null }))
      .catch((err) => {
        const kind = err?.status === 404 ? 'not_found' : 'server_error';
        setState({ loading: false, data: null, errorKind: kind });
      });
  };

  useEffect(() => {
    let cancelled = false;
    api.getOrderRequestPage(token)
      .then((res) => { if (!cancelled) setState({ loading: false, data: res.data, errorKind: null }); })
      .catch((err) => {
        if (cancelled) return;
        const kind = err?.status === 404 ? 'not_found' : 'server_error';
        setState({ loading: false, data: null, errorKind: kind });
      });
    return () => { cancelled = true; };
  }, [token]);

  const addProduct = (product) => {
    setItems((prev) => [...prev, { key: `p-${product.id}-${prev.length}`, product_id: product.id, name: product.name, quantity: 1 }]);
    setProductQuery('');
  };

  const addCustomItem = () => {
    if (!customText.trim()) return;
    setItems((prev) => [...prev, { key: `c-${prev.length}-${prev.length + 1}`, custom: true, description: customText.trim(), name: customText.trim(), quantity: 1 }]);
    setCustomText('');
  };

  const changeQuantity = (key, delta) => {
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, quantity: Math.max(1, it.quantity + delta) } : it)));
  };

  const removeItem = (key) => {
    setItems((prev) => prev.filter((it) => it.key !== key));
  };

  const handleSubmit = async () => {
    setFormError('');
    if (!recipientName.trim() || !recipientPhone.trim()) {
      setFormError('Please enter who the order is for, and their phone number.');
      return;
    }
    if (orderType === 'delivery' && !deliveryAddress.trim()) {
      setFormError('Please enter a delivery address.');
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate.trim())) {
      setFormError('Please enter a date like 2026-09-25.');
      return;
    }
    if (items.length === 0) {
      setFormError('Please add at least one item.');
      return;
    }
    setSubmitting(true);
    try {
      await api.submitOrderRequest(token, {
        recipient_name: recipientName.trim(),
        recipient_phone: recipientPhone.trim(),
        order_type: orderType,
        delivery_address: orderType === 'delivery' ? deliveryAddress.trim() : undefined,
        message: message.trim() || undefined,
        requested_date: requestedDate.trim(),
        requested_time: requestedTime.trim() || undefined,
        items: items.map((it) => (it.custom
          ? { custom: true, description: it.description, quantity: it.quantity }
          : { product_id: it.product_id, quantity: it.quantity })),
        payment_claimed: paymentClaimed,
        payment_reference: paymentClaimed ? (paymentReference.trim() || undefined) : undefined,
      });
      setSubmitted(true);
    } catch (err) {
      setFormError(err.message || 'Something went wrong — please try again in a moment.');
    } finally {
      setSubmitting(false);
    }
  };

  const resetForm = () => {
    setSubmitted(false);
    setOrderType('delivery');
    setRecipientName('');
    setRecipientPhone('');
    setDeliveryAddress('');
    setMessage('');
    setRequestedDate('');
    setRequestedTime('');
    setItems([]);
    setPaymentClaimed(false);
    setPaymentReference('');
    setFormError('');
    setState((s) => ({ ...s, loading: true }));
    loadPage();
  };

  if (state.loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={Colors.primary} />
      </View>
    );
  }

  if (state.errorKind || !state.data) {
    const isServerError = state.errorKind === 'server_error';
    return (
      <View style={styles.center}>
        <Ionicons name={isServerError ? 'cloud-offline-outline' : 'link-outline'} size={40} color={Colors.textLight} style={{ marginBottom: Spacing.sm }} />
        <Text style={styles.notFoundTitle}>{isServerError ? "We couldn't load this page" : "This link isn't valid"}</Text>
        <Text style={styles.notFoundText}>
          {isServerError
            ? 'Something went wrong on our end — please try reloading this page in a moment.'
            : 'Please ask the shop to send you a fresh link.'}
        </Text>
      </View>
    );
  }

  const { customer_name, products, upi_qr_image_url, requests } = state.data;
  const filteredProducts = productQuery.trim()
    ? products.filter((p) => p.name.toLowerCase().includes(productQuery.trim().toLowerCase())).slice(0, 8)
    : [];

  if (submitted) {
    return (
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.card}>
          <View style={styles.ribbon} />
          <View style={styles.cardBody}>
            <Ionicons name="checkmark-circle" size={40} color={Colors.success} style={{ alignSelf: 'center', marginBottom: Spacing.sm }} />
            <Text style={styles.saleNumber}>Your request has been sent</Text>
            <Text style={styles.notFoundText}>We'll confirm with you shortly.</Text>
            <Button title="Submit another request" onPress={resetForm} style={{ marginTop: Spacing.lg }} />
          </View>
        </View>
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <View style={styles.card}>
        <View style={styles.ribbon} />
        <View style={styles.cardBody}>
          <Text style={styles.eyebrow}>ORDER REQUEST</Text>
          <Text style={styles.saleNumber}>Hi, {customer_name}</Text>

          {requests.length > 0 && (
            <View style={styles.statusSection}>
              <Text style={styles.sectionTitle}>Your recent requests</Text>
              {requests.map((r) => (
                <View key={r.id} style={styles.statusRow}>
                  <Text style={styles.statusRowText}>{r.requested_date} — {r.order_type === 'delivery' ? 'Delivery' : 'Pickup'}</Text>
                  <Text style={[styles.statusBadge, r.status === 'approved' && styles.statusApproved, r.status === 'declined' && styles.statusDeclined]}>
                    {r.status === 'pending' ? 'Waiting for confirmation' : r.status === 'approved' ? 'Confirmed' : 'Declined'}
                  </Text>
                  {r.status === 'declined' && r.decline_reason && (
                    <Text style={styles.declineReason}>{r.decline_reason}</Text>
                  )}
                </View>
              ))}
            </View>
          )}

          <Text style={styles.sectionTitle}>New request</Text>

          <View style={styles.chipRow}>
            {['delivery', 'pickup'].map((t) => (
              <TouchableOpacity key={t} style={[styles.chip, orderType === t && styles.chipActive]} onPress={() => setOrderType(t)}>
                <Text style={[styles.chipText, orderType === t && styles.chipTextActive]}>{t === 'delivery' ? 'Delivery' : 'Pickup'}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.label}>Who is this order for?</Text>
          <TextInput style={styles.input} placeholder="Recipient's name" value={recipientName} onChangeText={setRecipientName} placeholderTextColor={Colors.textLight} />
          <TextInput style={styles.input} placeholder="Recipient's phone number" value={recipientPhone} onChangeText={setRecipientPhone} keyboardType="phone-pad" placeholderTextColor={Colors.textLight} />

          {orderType === 'delivery' && (
            <TextInput style={[styles.input, styles.multiline]} placeholder="Delivery address" value={deliveryAddress} onChangeText={setDeliveryAddress} multiline placeholderTextColor={Colors.textLight} />
          )}

          <TextInput style={[styles.input, styles.multiline]} placeholder="Card message (optional)" value={message} onChangeText={setMessage} multiline placeholderTextColor={Colors.textLight} />

          <Text style={styles.label}>When would you like this?</Text>
          <TextInput style={styles.input} placeholder="Date (e.g. 2026-09-25)" value={requestedDate} onChangeText={setRequestedDate} placeholderTextColor={Colors.textLight} />
          <TextInput style={styles.input} placeholder="Time (e.g. morning, or 6 PM) — optional" value={requestedTime} onChangeText={setRequestedTime} placeholderTextColor={Colors.textLight} />

          <Text style={styles.label}>What would you like to order?</Text>
          <TextInput style={styles.input} placeholder="Search products…" value={productQuery} onChangeText={setProductQuery} placeholderTextColor={Colors.textLight} />
          {filteredProducts.map((p) => (
            <TouchableOpacity key={p.id} style={styles.suggestionRow} onPress={() => addProduct(p)}>
              <Text style={styles.suggestionText}>{p.name}</Text>
              <Text style={styles.suggestionPrice}>₹{p.selling_price}</Text>
            </TouchableOpacity>
          ))}

          <View style={styles.customRow}>
            <TextInput style={[styles.input, { flex: 1, marginBottom: 0 }]} placeholder="Anything else? (custom request)" value={customText} onChangeText={setCustomText} placeholderTextColor={Colors.textLight} />
            <TouchableOpacity style={styles.addCustomBtn} onPress={addCustomItem}>
              <Ionicons name="add" size={20} color={Colors.white} />
            </TouchableOpacity>
          </View>

          {items.map((it) => (
            <View key={it.key} style={styles.itemRow}>
              <Text style={styles.itemName} numberOfLines={1}>{it.name}</Text>
              <View style={styles.qtyControls}>
                <TouchableOpacity onPress={() => changeQuantity(it.key, -1)} style={styles.qtyBtn}><Text style={styles.qtyBtnText}>−</Text></TouchableOpacity>
                <Text style={styles.qtyText}>{it.quantity}</Text>
                <TouchableOpacity onPress={() => changeQuantity(it.key, 1)} style={styles.qtyBtn}><Text style={styles.qtyBtnText}>+</Text></TouchableOpacity>
              </View>
              <TouchableOpacity onPress={() => removeItem(it.key)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name="close" size={18} color={Colors.textLight} />
              </TouchableOpacity>
            </View>
          ))}

          <Text style={styles.label}>Payment</Text>
          {upi_qr_image_url && (
            <Image source={{ uri: api.getMediaUrl(upi_qr_image_url) }} style={styles.qrImage} resizeMode="contain" />
          )}
          <View style={styles.paidRow}>
            <Text style={styles.paidLabel}>I've already paid</Text>
            <Switch value={paymentClaimed} onValueChange={setPaymentClaimed} trackColor={{ false: Colors.border, true: Colors.primary + '80' }} thumbColor={paymentClaimed ? Colors.primary : Colors.textLight} />
          </View>
          {paymentClaimed && (
            <TextInput style={styles.input} placeholder="UPI reference number (optional)" value={paymentReference} onChangeText={setPaymentReference} placeholderTextColor={Colors.textLight} />
          )}

          {!!formError && <Text style={styles.errorText}>{formError}</Text>}

          <Button title="Send Request" onPress={guardSubmit(handleSubmit)} loading={submitting} style={{ marginTop: Spacing.lg }} />
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.lg, backgroundColor: WASH },
  container: { flexGrow: 1, alignItems: 'center', padding: Spacing.lg, backgroundColor: WASH, minHeight: '100%' },
  card: { backgroundColor: Colors.surface, borderRadius: BorderRadius.lg, width: '100%', maxWidth: 480, overflow: 'hidden', ...Shadows.md, marginVertical: Spacing.lg },
  ribbon: { height: 6, backgroundColor: Colors.primary },
  cardBody: { padding: Spacing.lg },
  eyebrow: { fontSize: FontSize.xs, fontWeight: '700', color: Colors.primary, textAlign: 'center', letterSpacing: 1.5 },
  saleNumber: { fontSize: FontSize.xl, fontWeight: '800', color: Colors.text, textAlign: 'center', marginTop: 4, marginBottom: Spacing.md },
  notFoundTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, textAlign: 'center' },
  notFoundText: { fontSize: FontSize.md, color: Colors.textSecondary, textAlign: 'center', marginTop: Spacing.sm },
  sectionTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, marginTop: Spacing.md, marginBottom: Spacing.sm },
  statusSection: { backgroundColor: Colors.background, borderRadius: BorderRadius.md, padding: Spacing.md, marginBottom: Spacing.md },
  statusRow: { paddingVertical: Spacing.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.border },
  statusRowText: { fontSize: FontSize.sm, color: Colors.text },
  statusBadge: { fontSize: FontSize.xs, fontWeight: '700', color: Colors.textLight, marginTop: 2 },
  statusApproved: { color: Colors.success },
  statusDeclined: { color: Colors.error },
  declineReason: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2, fontStyle: 'italic' },
  chipRow: { flexDirection: 'row', gap: Spacing.sm, marginBottom: Spacing.md },
  chip: { flex: 1, paddingVertical: Spacing.sm, borderRadius: BorderRadius.md, borderWidth: 1.5, borderColor: Colors.border, alignItems: 'center' },
  chipActive: { borderColor: Colors.primary, backgroundColor: Colors.primary + '18' },
  chipText: { color: Colors.textSecondary, fontWeight: '600' },
  chipTextActive: { color: Colors.primary },
  label: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text, marginTop: Spacing.md, marginBottom: Spacing.xs },
  input: { backgroundColor: Colors.background, borderRadius: BorderRadius.sm, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, fontSize: FontSize.md, color: Colors.text, borderWidth: 1, borderColor: Colors.border, marginBottom: Spacing.sm },
  multiline: { minHeight: 60, textAlignVertical: 'top' },
  suggestionRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: Spacing.sm, paddingHorizontal: Spacing.md, backgroundColor: Colors.background, borderRadius: BorderRadius.sm, marginBottom: 2 },
  suggestionText: { color: Colors.text, flex: 1 },
  suggestionPrice: { color: Colors.textSecondary },
  customRow: { flexDirection: 'row', gap: Spacing.sm, alignItems: 'center' },
  addCustomBtn: { backgroundColor: Colors.primary, borderRadius: BorderRadius.sm, width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  itemRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: Spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.border, gap: Spacing.sm },
  itemName: { flex: 1, color: Colors.text },
  qtyControls: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  qtyBtn: { width: 28, height: 28, borderRadius: 14, backgroundColor: Colors.background, alignItems: 'center', justifyContent: 'center' },
  qtyBtnText: { fontSize: FontSize.md, color: Colors.text, fontWeight: '700' },
  qtyText: { minWidth: 20, textAlign: 'center', color: Colors.text },
  qrImage: { width: 180, height: 180, alignSelf: 'center', marginBottom: Spacing.md, borderRadius: BorderRadius.sm },
  paidRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: Spacing.sm },
  paidLabel: { fontSize: FontSize.sm, color: Colors.text },
  errorText: { color: Colors.error, fontSize: FontSize.sm, marginTop: Spacing.sm, textAlign: 'center' },
});
```

- [ ] **Step 3: Wire the `App.js` bypass**

Open `app/App.js`. Add the import right after `import TrackingScreen from './src/screens/TrackingScreen';`:

```js
import OrderRequestScreen from './src/screens/OrderRequestScreen';
```

Add a second token-extraction function right after `getTrackingToken`:

```js
function getOrderRequestToken() {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  const match = /^\/order-request\/([^/]+)$/.exec(window.location.pathname);
  return match ? match[1] : null;
}
```

Update the `App` component to check both, tracking first (matches existing precedence, arbitrary but consistent):

```js
export default function App() {
  const trackingToken = getTrackingToken();
  if (trackingToken) {
    return <TrackingScreen token={trackingToken} />;
  }

  const orderRequestToken = getOrderRequestToken();
  if (orderRequestToken) {
    return <OrderRequestScreen token={orderRequestToken} />;
  }

  return (
    <SafeAreaProvider>
      <AuthProvider>
        <RootNavigator />
        <StatusBar style="auto" />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
```

- [ ] **Step 4: Babel-check**

Run: `cd app && node scripts/babel-check.js src/screens/OrderRequestScreen.js App.js src/services/api.js`

Expected: `OK` for all three.

- [ ] **Step 5: Manual trace**

1. Generate a real link: as owner, open a test customer's profile, tap "Copy Order Link" (Task 7), or query it directly: `curl -X POST http://localhost:3001/api/order-request-link ...` — actually use the customer endpoint from Task 2 with a real auth token to get a real `url`.
2. Run `cd app && npx expo start --web`.
3. Open the printed localhost URL's `/order-request/<token>` path in a browser (e.g. `http://localhost:19006/order-request/<token>`).
4. Confirm the "Hi, {name}" greeting renders, browse/search a product and add it, add a custom item, fill in recipient/date/delivery fields, toggle "I've already paid", tap "Send Request".
5. Confirm the "Your request has been sent" confirmation appears.
6. Reload the same URL — confirm the new request now shows under "Your recent requests" with status "Waiting for confirmation".
7. Cross-check against Task 9's Order Requests screen: the same request should appear there for staff.

- [ ] **Step 6: Commit**

```bash
git add app/src/screens/OrderRequestScreen.js app/App.js app/src/services/api.js
git commit -m "feat: add public customer-facing order-request submit/status page"
```

---

### Task 11: Whole-feature live trace + `CLAUDE.md` update

**Files:**
- Modify: `CLAUDE.md`

No new code — this task is the closing verification + documentation step every prior sub-project in this codebase has ended with.

- [ ] **Step 1: Full regression pass**

Run: `VERIFY_OWNER_PHONE=... VERIFY_OWNER_PASSWORD=... node server/scripts/verify-order-requests.js`

Expected: all 19 checks pass (0 failures).

Also re-run the pre-existing suites to confirm nothing already-working broke:

```bash
VERIFY_OWNER_PHONE=... VERIFY_OWNER_PASSWORD=... node server/scripts/verify-order-flows.js
VERIFY_OWNER_PHONE=... VERIFY_OWNER_PASSWORD=... node server/scripts/verify-register-expenses.js
```

Expected: both still fully pass (Task 5 touched `POST /sales`, the most shared route in the app — this is the check that nothing there regressed).

- [ ] **Step 2: One full live end-to-end trace, start to finish**

1. As owner: Settings → upload a UPI QR code (Task 6).
2. As owner: open a real test customer's profile → "Copy Order Link" → save the URL.
3. In a browser, open that URL (`localhost:19006/order-request/:token`), submit one delivery request with one catalog item and one custom item, with "I've paid" checked and a UPI reference typed in.
4. As counter_staff: Orders Inbox → "Order Requests →" quick-link → confirm the new pending request shows, with the "Says paid" chip visible.
5. Tap **Approve** → confirm `LogOrderScreen` opens with recipient/address/date/items/"Card message: ..." pre-filled, catalog item shows current live price, custom item shows as a free-text line at ₹0 (staff must fill in the real price — confirm this is visually obvious, not silently wrong).
6. Adjust the custom item's price, tap **Save Order** → confirm the sale is created successfully.
7. Return to Order Requests, switch to "Approved" — confirm the request shows there, no longer actionable.
8. Reload the customer's original order-request link — confirm their status view now shows "Confirmed" for that request.

If any step surfaces a bug, fix it before proceeding to Step 3 (this is the equivalent of the fix-round loop other sub-projects' final tasks describe).

- [ ] **Step 3: Update `CLAUDE.md`**

Add a new roadmap entry (or append to the existing order-related entries) documenting: what shipped (link generation, public submit/status page, staff review screen, approve-via-LogOrderScreen wiring), the explicit not-in-scope items already carried over from the spec (§2), and — critically — the same production web-hosting gap that already affects `/track/:token` now also applies to `/order-request/:token` (per `VPS_DEPLOYMENT_GUIDE.md` §17): local dev testing works, but nothing in the current Nginx/deployment setup serves the Expo web build at this path yet, so this feature is not customer-reachable in production until that gap (already flagged, not new) is closed.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: record customer order-request flow completion and known production-hosting gap"
```

---

## Self-review notes (already applied above)

- **Spec coverage:** §3 (schema) → Task 1. §4 (public page) → Tasks 3, 10. §5 (staff review + Approve/Decline) → Tasks 4, 8, 9. §6 (token/sharing) → Tasks 2, 7. §7 (error handling) → generic-404 matched in Task 3, empty-cart rejection in Task 3, stock/price drift handled by Task 8's live `getProduct` re-check, deactivated-product substitution surfaced as a labeled item in Task 8. §8 (testing) → the incrementally-built `verify-order-requests.js` across Tasks 2-5. §9 (migration safety) → Task 1, additive-only, no backfill.
- **Type/name consistency checked:** `source_order_request_id` spelled identically in Task 5 (backend) and Task 8 (frontend payload key); `prefillRequest`/`prefillToken` spelled identically between Task 9 (sender) and Task 8 (receiver); `order_request_token` matches the Task 1 column name everywhere it's queried (Tasks 2, 3); response shape `{ requests, total }` matches between Task 4 (producer) and Tasks 9/11 (consumers).
- **No placeholders:** every task has literal, runnable code for new files and precisely anchored (existing line numbers quoted) snippets for modified files.
