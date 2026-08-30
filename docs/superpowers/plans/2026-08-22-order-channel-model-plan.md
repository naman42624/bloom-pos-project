# Order Model, Channel & Unified Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `channel` (WhatsApp/email/website/walk-in/phone) and `priority` concept to orders, a unified Orders inbox with a fast multi-channel quick-log form (including optional voice-note instructions), and an extended edit-history mechanism — all additive to the live `sales` schema, with old order screens kept running in parallel until the new inbox is proven.

**Architecture:** Two new additive Postgres columns on `sales` plus one new `sale_attachments` table; a small new Express router (`sale-attachments.js`) mounted alongside the existing `sales` router for photo/voice-note upload; extensions to the existing `sales.js` create/list/detail/update routes; two new Expo screens (`OrdersInboxScreen`, `LogOrderScreen`) and one new component (`VoiceNoteRecorder`) added to the existing `OrdersStack` navigator alongside — not replacing — `SalesScreen`/`DeliveriesScreen`/`PickupOrdersScreen`.

**Tech Stack:** Express + `express-validator`, PostgreSQL via the project's `pg`-backed `getDb()` (async layer, `server/config/database-async.js`), `multer` for file upload, Expo/React Native + React Navigation, `expo-audio` for voice recording (installed fresh — not currently a dependency).

**Spec:** `docs/superpowers/specs/2026-08-22-order-channel-model-design.md`

## Global Constraints

- **Live production data — additive only.** Every schema change is a new nullable/defaulted column or a brand-new table. Nothing existing is dropped, renamed, or restructured. Read `.claude/skills/db-migration-safety/SKILL.md` before Task 1.
- **Non-technical, first-time users.** Every staff-facing screen must be usable with zero training: one obvious primary action, large tap targets, sensible defaults, never block saving on a non-essential field. Read `.claude/skills/staff-ux-checklist/SKILL.md` before any frontend task (8 onward).
- **No offline-first work.** Connectivity is reliable; a plain error message on a failed request is sufficient — don't add retry queues or local-first sync.
- **Parallel run.** `SalesScreen`, `DeliveriesScreen`, `PickupOrdersScreen` are not modified to be removed or hidden. The new `OrdersInboxScreen` is additive navigation.
- **No new automated test framework.** This codebase has no Jest/RNTL setup and no server unit-test framework — only ad-hoc Node scripts that hit a running server (`server/scripts/api-smoke-test.js`) and manual in-app verification. This plan follows that existing convention rather than introducing a new framework: backend tasks extend one growing verification script (`server/scripts/verify-order-channel.js`); frontend tasks specify precise manual verification steps instead of automated ones. Do not add Jest/RNTL as part of this plan.
- **Out of scope** (do not touch in this plan, per spec §3): login/roles, server-side cash-register enforcement (sub-project 3 — this plan only documents the existing mechanism, does not add new register-check code), task assignment, attendance.
- **Voice note cap:** 60 seconds, enforced client-side by stopping the recording automatically, not by rejecting on upload.
- Run backend commands from `server/`, frontend commands from `app/`, unless a step says otherwise. The dev server is assumed running at `http://localhost:3001` for verification-script steps (`npm run dev` from `server/`).

---

### Task 1: Schema — `sales.channel`, `sales.priority`, `sale_attachments` table

**Files:**
- Modify: `server/config/database.js` (inside `ensureCoreTables()` for the new table, `ensureCompatibilityColumns()` for the new columns — follow the existing placement convention in each function)
- Test: `server/scripts/verify-order-channel.js` (new file, this task creates it)

**Interfaces:**
- Produces: `sales.channel TEXT` (nullable, CHECK `IN ('whatsapp','email','website','walk_in','phone')`), `sales.priority TEXT DEFAULT 'normal'` (CHECK `IN ('normal','rush')`), table `sale_attachments(id SERIAL PK, sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE, type TEXT CHECK IN ('photo','voice_note'), file_url TEXT NOT NULL, duration_seconds INTEGER, uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`.

- [ ] **Step 1: Write the verification script (will fail — columns don't exist yet)**

Create `server/scripts/verify-order-channel.js`:

```js
/* eslint-disable no-console */
require('dotenv').config();

const BASE_URL = process.env.API_BASE_URL || 'http://localhost:3001';
const OWNER_PHONE = process.env.SMOKE_OWNER_PHONE || '9876453210';
const OWNER_PASSWORD = process.env.SMOKE_OWNER_PASSWORD || 'naman1234';

async function request(method, path, { token, body, formData } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (!formData) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: formData || (body ? JSON.stringify(body) : undefined),
  });
  let data;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

const results = [];
function assert(label, condition) {
  results.push({ label, ok: !!condition });
  if (!condition) console.error(`FAIL: ${label}`);
  else console.log(`PASS: ${label}`);
}

async function main() {
  const loginRes = await request('POST', '/api/auth/login', { body: { phone: OWNER_PHONE, password: OWNER_PASSWORD } });
  const token = loginRes?.data?.data?.token;
  if (!token) throw new Error('Could not login owner user to continue tests');

  // ─── Task 1: schema columns exist and accept expected values ───
  const locRes = await request('GET', '/api/locations', { token });
  const locationId = locRes?.data?.data?.[0]?.id;
  assert('Task 1: at least one location exists to test against', !!locationId);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run it to confirm the baseline passes (nothing channel-specific yet)**

Run (from `server/`): `node scripts/verify-order-channel.js`
Expected: `1/1 checks passed` (only the location check exists so far — this confirms the script and login work before we build on it).

- [ ] **Step 3: Add the migration**

In `server/config/database.js`, inside `ensureCoreTables()`, near the other small attachment-style tables (next to the existing `delivery_proofs`/`product_images` blocks), add:

```js
  runPsql(`
    CREATE TABLE IF NOT EXISTS sale_attachments (
      id SERIAL PRIMARY KEY,
      sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('photo', 'voice_note')),
      file_url TEXT NOT NULL,
      duration_seconds INTEGER,
      uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  runPsql('CREATE INDEX IF NOT EXISTS idx_sale_attachments_sale ON sale_attachments(sale_id)');
```

In `server/config/database.js`, inside `ensureCompatibilityColumns()`, near the other `sales`-table `ensureColumn` calls, add:

```js
  ensureColumn('sales', 'channel', "TEXT");
  ensureColumn('sales', 'priority', "TEXT DEFAULT 'normal'");
```

Note: deliberately no CHECK constraint added via `ensureColumn` here (it only supports a plain `ADD COLUMN`) — add the CHECK constraints the same way `sales.status`'s constraint is already managed, as a small guarded block near the top of `server/routes/sales.js`'s existing "Auto-migration: expand schema CHECK constraints" section (do not create a second, separate migration mechanism):

```js
  try { db.prepare("ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_channel_check").run(); } catch { }
  try { db.prepare("ALTER TABLE sales ADD CONSTRAINT sales_channel_check CHECK(channel IS NULL OR channel IN ('whatsapp','email','website','walk_in','phone'))").run(); } catch { }
  try { db.prepare("ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_priority_check").run(); } catch { }
  try { db.prepare("ALTER TABLE sales ADD CONSTRAINT sales_priority_check CHECK(priority IN ('normal','rush'))").run(); } catch { }
```

- [ ] **Step 4: Restart the dev server and verify the migration applied**

Run (from `server/`): `npm run dev` (restart if already running — the migration runs at boot)
Then, in a second terminal, from `server/`: `psql "$DATABASE_URL" -c "\d sales" | grep -E "channel|priority"` and `psql "$DATABASE_URL" -c "SELECT to_regclass('public.sale_attachments');"`
Expected: both `channel` and `priority` listed as columns on `sales`; `sale_attachments` resolves to a real table (not blank).

- [ ] **Step 5: Verify no existing row was rejected by the new constraints**

Run: `psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM sales WHERE channel IS NOT NULL AND channel NOT IN ('whatsapp','email','website','walk_in','phone');"`
Expected: `0` — confirms the CHECK constraint addition didn't need to reject any pre-existing data (it couldn't have, since the column is brand new and NULL by default, but this is the concrete additive-migration-safety check called for in the db-migration-safety skill).

- [ ] **Step 6: Run the verification script again**

Run: `node scripts/verify-order-channel.js`
Expected: `1/1 checks passed` (unchanged — schema-only task, no new API behavior yet).

- [ ] **Step 7: Commit**

```bash
git add server/config/database.js server/routes/sales.js server/scripts/verify-order-channel.js
git commit -m "Add sales.channel, sales.priority, sale_attachments (additive)"
```

---

### Task 2: Backend — sale attachment upload & list endpoints

**Files:**
- Create: `server/routes/sale-attachments.js`
- Modify: `server/server.js:20-24,77-81` (require + mount, alongside the existing `salesRoutes`/`deliveriesRoutes` requires)
- Test: `server/scripts/verify-order-channel.js` (extend)

**Interfaces:**
- Consumes: `authenticate`, `authorize` from `../middleware/auth`; `getDb` (async) from `../config/database-async`; `sale_attachments` table from Task 1.
- Produces: `POST /api/sales/:saleId/attachments` (multipart, field `file`, body field `type` = `photo`|`voice_note`, optional `duration_seconds`) → `{ success: true, data: attachment }`. `GET /api/sales/:saleId/attachments` → `{ success: true, data: attachment[] }`, each row `{ id, sale_id, type, file_url, duration_seconds, uploaded_by, uploaded_by_name, created_at }`.

- [ ] **Step 1: Write the failing check**

In `server/scripts/verify-order-channel.js`, before the `const failed = ...` line, add:

```js
  // ─── Task 2: attachment upload + list ───
  const draftSaleRes = await request('GET', '/api/sales?limit=1', { token });
  const anySaleId = draftSaleRes?.data?.data?.sales?.[0]?.id;
  assert('Task 2: at least one sale exists to attach to', !!anySaleId);

  if (anySaleId) {
    const fd = new FormData();
    fd.append('type', 'voice_note');
    fd.append('duration_seconds', '12');
    fd.append('file', new Blob(['fake-audio-bytes'], { type: 'audio/m4a' }), 'note.m4a');
    const uploadRes = await request('POST', `/api/sales/${anySaleId}/attachments`, { token, formData: fd });
    assert('Task 2: attachment upload succeeds', uploadRes.status === 201 && uploadRes.data?.data?.type === 'voice_note');

    const listRes = await request('GET', `/api/sales/${anySaleId}/attachments`, { token });
    assert('Task 2: attachment list includes the uploaded note', listRes.status === 200 && listRes.data?.data?.some((a) => a.type === 'voice_note'));
  }
```

- [ ] **Step 2: Run to verify it fails**

Run: `node scripts/verify-order-channel.js`
Expected: `FAIL: Task 2: attachment upload succeeds` (404, route doesn't exist yet).

- [ ] **Step 3: Implement the route**

Create `server/routes/sale-attachments.js`:

```js
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const { getDb } = require('../config/database-async');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = path.join(__dirname, '..', 'uploads', 'sale-attachments');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    let ext = path.extname(file.originalname);
    if (!ext && file.mimetype) {
      const mimeExt = file.mimetype.split('/')[1];
      if (mimeExt) ext = `.${mimeExt}`;
    }
    cb(null, `attachment-${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp|m4a|mp4|mpeg|mp3|webm|wav/i;
    const extMatch = allowed.test(path.extname(file.originalname));
    const mimeMatch = allowed.test(file.mimetype);
    if (extMatch || mimeMatch) cb(null, true);
    else cb(new Error('Only images (JPEG/PNG/WebP) or audio (M4A/MP3/WebM/WAV) are allowed'));
  },
});

// ─── POST /api/sales/:saleId/attachments ──────────────────────
router.post('/:saleId(\\d+)/attachments', authenticate, upload.single('file'), async (req, res, next) => {
  try {
    const db = await getDb();
    const sale = await db.prepare('SELECT id FROM sales WHERE id = ?').get(req.params.saleId);
    if (!sale) return res.status(404).json({ success: false, message: 'Sale not found' });
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

    const type = req.body.type === 'photo' ? 'photo' : 'voice_note';
    const durationSeconds = req.body.duration_seconds ? parseInt(req.body.duration_seconds, 10) : null;
    const fileUrl = `/uploads/sale-attachments/${req.file.filename}`;

    const result = await db.prepare(
      'INSERT INTO sale_attachments (sale_id, type, file_url, duration_seconds, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP) RETURNING *'
    ).get(req.params.saleId, type, fileUrl, durationSeconds, req.user.id);

    res.status(201).json({ success: true, data: result });
  } catch (err) { next(err); }
});

// ─── GET /api/sales/:saleId/attachments ───────────────────────
router.get('/:saleId(\\d+)/attachments', authenticate, async (req, res, next) => {
  try {
    const db = await getDb();
    const rows = await db.prepare(`
      SELECT sa.*, u.name as uploaded_by_name
      FROM sale_attachments sa
      LEFT JOIN users u ON sa.uploaded_by = u.id
      WHERE sa.sale_id = ?
      ORDER BY sa.created_at ASC
    `).all(req.params.saleId);
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

module.exports = router;
```

In `server/server.js`, near line 20-24 (existing route requires), add:

```js
const saleAttachmentsRoutes = require('./routes/sale-attachments');
```

Near line 77-81 (existing route mounts), add, directly after the `salesRoutes` mount:

```js
app.use('/api/sales', saleAttachmentsRoutes);
```

Also confirm `server.js` already serves `/uploads` statically (check for an existing `express.static` line mounting the `uploads` directory — the product-image upload feature depends on this already existing, so no new static-serve line should be needed; if none exists, add `app.use('/uploads', express.static(path.join(__dirname, 'uploads')));` near the other middleware setup).

- [ ] **Step 4: Run to verify it passes**

Run: `node scripts/verify-order-channel.js`
Expected: `PASS: Task 2: attachment upload succeeds`, `PASS: Task 2: attachment list includes the uploaded note`.

- [ ] **Step 5: Commit**

```bash
git add server/routes/sale-attachments.js server/server.js server/scripts/verify-order-channel.js
git commit -m "Add sale attachment upload/list endpoints (photo + voice note)"
```

---

### Task 3: Backend — `POST /api/sales` accepts `channel` and `priority`

**Files:**
- Modify: `server/routes/sales.js:1196-1258` (validators + destructure), `server/routes/sales.js:1506-1528` (INSERT statement)
- Test: `server/scripts/verify-order-channel.js` (extend)

**Interfaces:**
- Consumes: existing `POST /api/sales` request shape.
- Produces: `sales.channel`, `sales.priority` populated from request body; both optional (default `channel = NULL`, `priority = 'normal'` when omitted — matches walk-in POS calls that won't send `channel` until Task 14).

- [ ] **Step 1: Write the failing check**

Add to `server/scripts/verify-order-channel.js`, before `const failed = ...`:

```js
  // ─── Task 3: channel/priority on sale creation ───
  const productsRes = await request('GET', '/api/products?limit=1', { token });
  const anyProductId = productsRes?.data?.data?.products?.[0]?.id;
  if (anyProductId && locationId) {
    const createRes = await request('POST', '/api/sales', {
      token,
      body: {
        location_id: locationId,
        order_type: 'pickup',
        channel: 'whatsapp',
        priority: 'rush',
        items: [{ product_id: anyProductId, quantity: 1, unit_price: 100 }],
      },
    });
    assert('Task 3: sale creation accepts channel + priority', createRes.status === 201);
    assert('Task 3: created sale echoes channel=whatsapp', createRes.data?.data?.channel === 'whatsapp');
    assert('Task 3: created sale echoes priority=rush', createRes.data?.data?.priority === 'rush');
  }
```

- [ ] **Step 2: Run to verify it fails**

Run: `node scripts/verify-order-channel.js`
Expected: sale creation succeeds (201) but `channel`/`priority` are `undefined` in the response — the two new assertions fail.

- [ ] **Step 3: Implement**

In `server/routes/sales.js`, in the `POST '/'` validator array (around line 1200), add after the `order_type` validator:

```js
    body('channel').optional({ nullable: true }).isIn(['whatsapp', 'email', 'website', 'walk_in', 'phone']),
    body('priority').optional().isIn(['normal', 'rush']),
```

In the destructure block (around line 1246-1258), add `channel, priority,` to the destructured fields.

In the `INSERT INTO sales (...)` statement (around line 1508), add `channel, priority` to the column list and `?, ?` to the `VALUES` placeholders, and in the `.run(...)` call add `channel || null, priority || 'normal',` in the matching position (keep every other column/value pair in the same relative order — only insert these two, don't reorder existing ones).

- [ ] **Step 4: Run to verify it passes**

Run: `node scripts/verify-order-channel.js`
Expected: all three Task 3 checks pass.

- [ ] **Step 5: Commit**

```bash
git add server/routes/sales.js server/scripts/verify-order-channel.js
git commit -m "POST /api/sales accepts channel and priority"
```

---

### Task 4: Backend — `GET /api/sales` filters by `channel` and `priority`

**Files:**
- Modify: `server/routes/sales.js:152-281` (list route: query destructure, WHERE clause, count-query WHERE clause)
- Test: `server/scripts/verify-order-channel.js` (extend)

**Interfaces:**
- Consumes: sale created in Task 3 (channel=whatsapp, priority=rush).
- Produces: `GET /api/sales?channel=whatsapp`, `GET /api/sales?priority=rush` filters supported; `channel`/`priority` already present per-row via `SELECT s.*` (no SELECT change needed — confirmed against the existing query).

- [ ] **Step 1: Write the failing check**

Add to `server/scripts/verify-order-channel.js`:

```js
  // ─── Task 4: list filtering by channel/priority ───
  const byChannelRes = await request('GET', '/api/sales?channel=whatsapp', { token });
  assert('Task 4: channel filter returns only whatsapp sales', byChannelRes.status === 200 &&
    byChannelRes.data?.data?.sales?.length > 0 &&
    byChannelRes.data.data.sales.every((s) => s.channel === 'whatsapp'));

  const byPriorityRes = await request('GET', '/api/sales?priority=rush', { token });
  assert('Task 4: priority filter returns only rush sales', byPriorityRes.status === 200 &&
    byPriorityRes.data?.data?.sales?.length > 0 &&
    byPriorityRes.data.data.sales.every((s) => s.priority === 'rush'));
```

- [ ] **Step 2: Run to verify it fails**

Run: `node scripts/verify-order-channel.js`
Expected: both `?channel=` and `?priority=` are silently ignored (unfiltered results), so `.every(...)` fails on any non-matching row present.

- [ ] **Step 3: Implement**

In `server/routes/sales.js`'s `GET '/'` handler (around line 155), add `channel, priority` to the destructured `req.query` fields.

Around line 178-179 (after the existing `pickup_status`/`status` filter lines), add:

```js
    if (channel) { sql += ' AND s.channel = ?'; params.push(channel); }
    if (priority) { sql += ' AND s.priority = ?'; params.push(priority); }
```

Add the matching pair to the `countSql` block (around line 259-269, mirroring exactly how `order_type`/`payment_status` are duplicated there):

```js
    if (channel) { countSql += ' AND s.channel = ?'; countParams.push(channel); }
    if (priority) { countSql += ' AND s.priority = ?'; countParams.push(priority); }
```

- [ ] **Step 4: Run to verify it passes**

Run: `node scripts/verify-order-channel.js`
Expected: both Task 4 checks pass.

- [ ] **Step 5: Commit**

```bash
git add server/routes/sales.js server/scripts/verify-order-channel.js
git commit -m "GET /api/sales supports channel and priority filters"
```

---

### Task 5: Backend — `GET /api/sales/:id` returns attachments

**Files:**
- Modify: `server/routes/sales.js:1042-1195` (detail route — read this range first to find the exact response-assembly point before the final `res.json(...)`)
- Test: `server/scripts/verify-order-channel.js` (extend)

**Interfaces:**
- Consumes: `sale_attachments` rows from Task 2.
- Produces: `GET /api/sales/:id` response gains `data.attachments: Array<{id, type, file_url, duration_seconds, uploaded_by_name, created_at}>`.

- [ ] **Step 1: Write the failing check**

Add to `server/scripts/verify-order-channel.js`:

```js
  // ─── Task 5: sale detail includes attachments ───
  if (anySaleId) {
    const detailRes = await request('GET', `/api/sales/${anySaleId}`, { token });
    assert('Task 5: sale detail includes attachments array', Array.isArray(detailRes.data?.data?.attachments) && detailRes.data.data.attachments.length > 0);
  }
```

- [ ] **Step 2: Run to verify it fails**

Run: `node scripts/verify-order-channel.js`
Expected: `FAIL: Task 5: sale detail includes attachments array` (`attachments` is `undefined`).

- [ ] **Step 3: Implement**

Read `server/routes/sales.js:1042-1195` to find where the sale object is assembled before `res.json`. Immediately before the final response is sent, add:

```js
    const attachments = await db.prepare(`
      SELECT sa.*, u.name as uploaded_by_name
      FROM sale_attachments sa
      LEFT JOIN users u ON sa.uploaded_by = u.id
      WHERE sa.sale_id = ?
      ORDER BY sa.created_at ASC
    `).all(req.params.id);
    sale.attachments = attachments;
```

(Use whatever the existing local variable holding the sale response object is actually named at that point in the function — inspect the surrounding code in this range rather than assuming `sale`, since this route may build the response under a different variable name than the list route does.)

- [ ] **Step 4: Run to verify it passes**

Run: `node scripts/verify-order-channel.js`
Expected: Task 5 check passes.

- [ ] **Step 5: Commit**

```bash
git add server/routes/sales.js server/scripts/verify-order-channel.js
git commit -m "GET /api/sales/:id includes attachments"
```

---

### Task 6: Backend — extend `PUT /api/sales/:id` to allow item/price/address edits with audit log

**Files:**
- Modify: `server/routes/sales.js:961-1038` (existing edit route)
- Test: `server/scripts/verify-order-channel.js` (extend)

**Interfaces:**
- Consumes: existing `audit_logs` table, existing `sale_items` table, existing same-day/register-closed guard logic already in this route (unchanged).
- Produces: `PUT /api/sales/:id` body may now additionally include `items: [{ id, product_name, quantity, unit_price }]` (updates existing rows by `id`; does not add/remove rows in this task — scope stays to editing existing items, matching "customer calls to swap an item's quantity or price" from the spec, not full cart re-composition) and `delivery_address`. Existing narrower field set (`customer_name`, `customer_phone`, `payment_status`, `payments`, `order_notes`) stays supported unchanged. `previous_state`/`new_state` audit snapshots now include `sale_items` rows, not just the sale row.

- [ ] **Step 1: Write the failing check**

Add to `server/scripts/verify-order-channel.js`:

```js
  // ─── Task 6: edit history covers item price changes ───
  if (anySaleId) {
    const beforeDetail = await request('GET', `/api/sales/${anySaleId}`, { token });
    const firstItem = beforeDetail.data?.data?.items?.[0];
    if (firstItem) {
      const newPrice = Number(firstItem.unit_price) + 5;
      const editRes = await request('PUT', `/api/sales/${anySaleId}`, {
        token,
        body: { items: [{ id: firstItem.id, unit_price: newPrice }] },
      });
      assert('Task 6: item price edit accepted', editRes.status === 200);

      const auditRes = await request('GET', `/api/sales/${anySaleId}/audit-logs`, { token });
      const latest = auditRes.data?.data?.[0];
      assert('Task 6: audit log captured item change', !!latest && JSON.stringify(latest.new_state).includes(String(newPrice)));
    }
  }
```

- [ ] **Step 2: Run to verify it fails**

Run: `node scripts/verify-order-channel.js`
Expected: `editRes.status === 200` may pass (the route silently ignores unknown fields today) but the audit-log check fails because no item change was actually applied or logged.

- [ ] **Step 3: Implement**

Read `server/routes/sales.js:961-1038` in full before editing (already reviewed once during planning — re-read live since Tasks 3-5 may have shifted line numbers). Modify:

1. In the destructure of `req.body` (currently `customer_name, customer_phone, payment_status, payments, order_notes`), add `items, delivery_address`.
2. After the existing `oldPayments`/`oldState` capture (which already fetches `payments` for the audit snapshot), also fetch and include existing items: `const oldItems = await db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(saleId); oldState.items = oldItems;` (add this line right after `const oldState = { ...oldSale, payments: oldPayments };`).
3. Add `delivery_address` to the existing `updates`/`params` field-update block, following the exact same `if (x !== undefined) { updates.push('x = ?'); params.push(x); }` pattern already used for the other fields.
4. After the existing `payments` update block (`if (payments && Array.isArray(payments)) {...}`), add an items-update block:

```js
    if (items && Array.isArray(items)) {
      const updateItem = db.prepare('UPDATE sale_items SET quantity = COALESCE(?, quantity), unit_price = COALESCE(?, unit_price), product_name = COALESCE(?, product_name) WHERE id = ? AND sale_id = ?');
      for (const item of items) {
        if (!item.id) continue;
        await updateItem.run(item.quantity ?? null, item.unit_price ?? null, item.product_name ?? null, item.id, saleId);
      }
      // Recalculate totals after item edits, reusing the existing helper
      recalcSaleTotals(db, saleId);
    }
```

   Note: `recalcSaleTotals` is a synchronous-`db`-style helper defined earlier in this file (line ~50) using the sync `getDb()` pattern (`db.prepare(...).run(...)` without `await`) — this route uses the async `getDb` (`getAsyncDb`). Check which `db` instance is in scope in this route (it's the async one, per the route's existing `const db = await getAsyncDb();` at its top) and either `await` the equivalent async calls inline (recompute `subtotal`/`grand_total` directly here using the same formula as `recalcSaleTotals`, since that helper is written for the sync layer, not the async one) rather than calling `recalcSaleTotals` directly across the two DB layers. Concretely, add:

```js
      const updatedItems = await db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(saleId);
      const newSubtotal = updatedItems.reduce((s, i) => s + (Number(i.unit_price) * Number(i.quantity)), 0);
      const currentSale = await db.prepare('SELECT discount_amount, tax_total, delivery_charges FROM sales WHERE id = ?').get(saleId);
      const newGrandTotal = Math.max(0, newSubtotal - (currentSale.discount_amount || 0)) + (currentSale.tax_total || 0) + (currentSale.delivery_charges || 0);
      await db.prepare('UPDATE sales SET subtotal = ?, grand_total = ? WHERE id = ?').run(newSubtotal, newGrandTotal, saleId);
```

   in place of calling `recalcSaleTotals`.
5. After the new-state capture (`const newSale = ...`), also capture `const newItems = await db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(saleId); newState.items = newItems;` before the `audit_logs` INSERT, so the snapshot includes items on both sides.

- [ ] **Step 4: Run to verify it passes**

Run: `node scripts/verify-order-channel.js`
Expected: both Task 6 checks pass.

- [ ] **Step 5: Commit**

```bash
git add server/routes/sales.js server/scripts/verify-order-channel.js
git commit -m "PUT /api/sales/:id supports item price/quantity and address edits with audit log"
```

---

### Task 7: Frontend — `api.js` methods for attachments

**Files:**
- Modify: `app/src/services/api.js` (near the existing `getSaleAuditLogs`/`updateSale` methods, ~line 501-507)

**Interfaces:**
- Consumes: `Platform` from `react-native` (already imported in this file, confirmed via the existing `uploadProductImage` method), `this.token`, `API_BASE_URL` (both already used identically by `uploadProductImage`).
- Produces: `uploadSaleAttachment(saleId, fileUri, type, durationSeconds)`, `getSaleAttachments(saleId)`.

- [ ] **Step 1: Implement (no separate test — this is a thin pass-through wrapper matching an already-proven pattern; verified end-to-end in Task 9's manual steps)**

Add directly after `getSaleAuditLogs`:

```js
  async uploadSaleAttachment(saleId, fileUri, type, durationSeconds) {
    const formData = new FormData();
    if (Platform.OS === 'web') {
      const response = await fetch(fileUri);
      const blob = await response.blob();
      formData.append('file', blob, fileUri.split('/').pop() || `attachment.${type === 'voice_note' ? 'webm' : 'jpg'}`);
    } else {
      const filename = fileUri.split('/').pop();
      const match = /\.(\w+)$/.exec(filename);
      const ext = match ? match[1] : (type === 'voice_note' ? 'm4a' : 'jpg');
      const mimeType = type === 'voice_note' ? `audio/${ext}` : `image/${ext}`;
      formData.append('file', { uri: fileUri, name: filename, type: mimeType });
    }
    formData.append('type', type);
    if (durationSeconds) formData.append('duration_seconds', String(durationSeconds));

    const url = `${API_BASE_URL}/sales/${saleId}/attachments`;
    const headers = {};
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;

    const response = await fetch(url, { method: 'POST', headers, body: formData });
    const data = await response.json();
    if (!response.ok) throw { status: response.status, message: data.message || 'Upload failed' };
    return data;
  }

  getSaleAttachments(saleId) {
    return this.request(`/sales/${saleId}/attachments`);
  }
```

- [ ] **Step 2: Commit**

```bash
git add app/src/services/api.js
git commit -m "Add api.uploadSaleAttachment / api.getSaleAttachments"
```

---

### Task 8: Frontend — `VoiceNoteRecorder` component

**Files:**
- Create: `app/src/components/VoiceNoteRecorder.js` (native implementation)
- Create: `app/src/components/VoiceNoteRecorder.web.js` (web implementation)
- Create: `app/src/components/VoiceNoteRecorder.shared.js` (shared UI: the button + timer, imported by both platform files)

**Interfaces:**
- Consumes: `expo-audio` (new dependency — install first; native file only, never imported by the `.web.js` file).
- Produces: `<VoiceNoteRecorder onRecorded={(uri, durationSeconds) => void} maxSeconds={60} />` — a self-contained record button that stops itself at `maxSeconds`, shows elapsed time while recording, and calls `onRecorded` with a local file URI (mobile) or blob URL (web) once the user stops (or the cap is hit).

**Why two files instead of one `Platform.OS` branch:** `expo-audio`'s `useAudioRecorder` hook cannot be called conditionally (`Platform.OS !== 'web' ? useAudioRecorder(...) : null`) without breaking React's rules of hooks — Metro/Expo's standard fix is a `.web.js` platform-specific file, resolved automatically at bundle time for the same unqualified import path (`import VoiceNoteRecorder from '../components/VoiceNoteRecorder'` picks up `VoiceNoteRecorder.web.js` on web, `VoiceNoteRecorder.js` elsewhere) — so no hook is ever called conditionally within a single component.

- [ ] **Step 1: Install the dependency**

Run (from `app/`): `npx expo install expo-audio`
Expected: adds `expo-audio` to `app/package.json` at the SDK-matched version.

- [ ] **Step 2: Implement the shared button/timer UI**

Create `app/src/components/VoiceNoteRecorder.shared.js`:

```js
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

export function RecorderButton({ isRecording, elapsed, maxSeconds, onPress }) {
  return (
    <View style={styles.container}>
      <TouchableOpacity
        style={[styles.button, isRecording && styles.buttonRecording]}
        onPress={onPress}
        activeOpacity={0.8}
      >
        <Ionicons name={isRecording ? 'stop' : 'mic'} size={22} color={Colors.white} />
        <Text style={styles.buttonText}>
          {isRecording ? `Recording… ${elapsed}s / ${maxSeconds}s` : 'Record voice note'}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginVertical: Spacing.sm },
  button: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: Colors.primary, borderRadius: BorderRadius.lg,
    paddingVertical: 14, paddingHorizontal: Spacing.lg, gap: 8,
  },
  buttonRecording: { backgroundColor: '#D32F2F' },
  buttonText: { color: Colors.white, fontSize: FontSize.md, fontWeight: '600' },
});
```

- [ ] **Step 3: Implement the native recorder**

Create `app/src/components/VoiceNoteRecorder.js`:

```js
import React, { useState, useRef, useEffect } from 'react';
import { useAudioRecorder, RecordingPresets, AudioModule } from 'expo-audio';
import { RecorderButton } from './VoiceNoteRecorder.shared';

const MAX_SECONDS_DEFAULT = 60;

export default function VoiceNoteRecorder({ onRecorded, maxSeconds = MAX_SECONDS_DEFAULT }) {
  const [isRecording, setIsRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef(null);
  const startTimeRef = useRef(null);
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);

  useEffect(() => { AudioModule.requestRecordingPermissionsAsync(); }, []);

  const stop = async () => {
    if (timerRef.current) clearInterval(timerRef.current);
    setIsRecording(false);
    const durationSeconds = Math.round((Date.now() - startTimeRef.current) / 1000);
    await audioRecorder.stop();
    if (audioRecorder.uri) onRecorded(audioRecorder.uri, durationSeconds);
  };

  const start = async () => {
    setElapsed(0);
    startTimeRef.current = Date.now();
    setIsRecording(true);
    timerRef.current = setInterval(() => {
      setElapsed((e) => {
        const next = e + 1;
        if (next >= maxSeconds) stop();
        return next;
      });
    }, 1000);
    await audioRecorder.prepareToRecordAsync();
    audioRecorder.record();
  };

  return <RecorderButton isRecording={isRecording} elapsed={elapsed} maxSeconds={maxSeconds} onPress={isRecording ? stop : start} />;
}
```

- [ ] **Step 4: Implement the web recorder**

Create `app/src/components/VoiceNoteRecorder.web.js` (no `expo-audio` import anywhere in this file):

```js
import React, { useState, useRef } from 'react';
import { RecorderButton } from './VoiceNoteRecorder.shared';

const MAX_SECONDS_DEFAULT = 60;

export default function VoiceNoteRecorder({ onRecorded, maxSeconds = MAX_SECONDS_DEFAULT }) {
  const [isRecording, setIsRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef(null);
  const startTimeRef = useRef(null);
  const recorderRef = useRef(null);

  const stop = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    setIsRecording(false);
    if (recorderRef.current) recorderRef.current.stop();
  };

  const start = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    const chunks = [];
    recorder.ondataavailable = (e) => chunks.push(e.data);
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: 'audio/webm' });
      const url = URL.createObjectURL(blob);
      const durationSeconds = Math.round((Date.now() - startTimeRef.current) / 1000);
      onRecorded(url, durationSeconds);
      stream.getTracks().forEach((t) => t.stop());
    };
    recorderRef.current = recorder;

    setElapsed(0);
    startTimeRef.current = Date.now();
    setIsRecording(true);
    timerRef.current = setInterval(() => {
      setElapsed((e) => {
        const next = e + 1;
        if (next >= maxSeconds) stop();
        return next;
      });
    }, 1000);
    recorder.start();
  };

  return <RecorderButton isRecording={isRecording} elapsed={elapsed} maxSeconds={maxSeconds} onPress={isRecording ? stop : start} />;
}
```

- [ ] **Step 5: Manual verification (mobile)**

Run: `npx expo start` from `app/`, open on a physical device or simulator with mic support, temporarily render `<VoiceNoteRecorder onRecorded={(uri, dur) => console.log('RECORDED', uri, dur)} />` on any existing screen (e.g. drop it into `ProfileScreen.js` temporarily).
Expected: tapping the button prompts for microphone permission the first time, then shows "Recording… 1s / 60s" counting up; tapping again stops and logs a `file://...` URI and a duration close to elapsed seconds; leaving it running for the full 60 seconds auto-stops and logs the same. Remove the temporary render before committing.

- [ ] **Step 6: Manual verification (web)**

Run: `npx expo start --web`, same temporary render.
Expected: browser prompts for mic permission; recording/stop behaves the same; logged URI is a `blob:` URL. Confirm in the browser devtools Network/Sources tab that `expo-audio` is not part of the web bundle for this component (the `.web.js` file was picked, not the native one).

- [ ] **Step 7: Commit**

```bash
git add app/package.json app/src/components/VoiceNoteRecorder.js app/src/components/VoiceNoteRecorder.web.js app/src/components/VoiceNoteRecorder.shared.js
git commit -m "Add VoiceNoteRecorder component (mobile + web, 60s cap)"
```

---

### Task 9: Frontend — `LogOrderScreen` (quick-log form)

**Files:**
- Create: `app/src/screens/LogOrderScreen.js`

**Interfaces:**
- Consumes: `api.customerLookup(phone)`, `api.createSale(data)` (both existing, unchanged signatures), `api.uploadSaleAttachment` and `VoiceNoteRecorder` (Tasks 7-8), `expo-image-picker` (already a dependency — `~17.0.10`, confirmed in `app/package.json`; pattern copied from the existing usage in `ProductDetailScreen.js:201-223`, no install step needed here unlike Task 8's `expo-audio`).
- Produces: a screen registered as `LogOrder` in `OrdersStack` (wired in Task 11) that creates a sale with `channel` set and, per spec §6, requires only a channel + one item/note to save.

- [ ] **Step 1: Implement**

Create `app/src/screens/LogOrderScreen.js`:

```js
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity, ActivityIndicator, Alert, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import api from '../services/api';
import VoiceNoteRecorder from '../components/VoiceNoteRecorder';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';
import { useAuth } from '../context/AuthContext';

const CHANNELS = [
  { key: 'whatsapp', label: 'WhatsApp', icon: 'logo-whatsapp' },
  { key: 'email', label: 'Email', icon: 'mail' },
  { key: 'website', label: 'Website', icon: 'globe' },
  { key: 'phone', label: 'Phone', icon: 'call' },
];
const LAST_CHANNEL_KEY = 'lastLogOrderChannel';

export default function LogOrderScreen({ navigation }) {
  const { user, activeLocation } = useAuth();
  const [channel, setChannel] = useState('whatsapp');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerId, setCustomerId] = useState(null);
  const [note, setNote] = useState('');
  const [items, setItems] = useState([]);
  const [customItemName, setCustomItemName] = useState('');
  const [customItemPrice, setCustomItemPrice] = useState('');
  const [fulfilment, setFulfilment] = useState('pickup');
  const [receiverName, setReceiverName] = useState('');
  const [receiverPhone, setReceiverPhone] = useState('');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [priority, setPriority] = useState('normal');
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // Remember last-used channel per staff member, per staff-ux-checklist §4
    try {
      const AsyncStorage = require('@react-native-async-storage/async-storage').default;
      AsyncStorage.getItem(LAST_CHANNEL_KEY).then((v) => { if (v) setChannel(v); });
    } catch { /* ignore */ }
  }, []);

  const selectChannel = (key) => {
    setChannel(key);
    try {
      const AsyncStorage = require('@react-native-async-storage/async-storage').default;
      AsyncStorage.setItem(LAST_CHANNEL_KEY, key);
    } catch { /* ignore */ }
  };

  const lookupCustomer = useCallback(async () => {
    if (!customerPhone || customerPhone.length < 10) return;
    try {
      const res = await api.customerLookup(customerPhone);
      if (res.data?.id) {
        setCustomerId(res.data.id);
        setCustomerName(res.data.name || customerName);
      }
    } catch { /* not found — quick-add path, leave fields as typed */ }
  }, [customerPhone]);

  const pickReferencePhoto = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission Required', 'Please allow access to your photo library.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8, allowsEditing: true });
    if (result.canceled) return;
    setPendingAttachments((prev) => [...prev, { uri: result.assets[0].uri, type: 'photo', durationSeconds: null }]);
  };

  const addCustomItem = () => {
    if (!customItemName.trim()) return;
    setItems((prev) => [...prev, {
      product_id: null,
      product_name: customItemName.trim(),
      quantity: 1,
      unit_price: parseFloat(customItemPrice) || 0,
    }]);
    setCustomItemName('');
    setCustomItemPrice('');
  };

  const removeItem = (idx) => setItems((prev) => prev.filter((_, i) => i !== idx));

  const canSave = !saving && (items.length > 0 || note.trim().length > 0);

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const payload = {
        location_id: activeLocation?.id,
        order_type: fulfilment,
        channel,
        priority,
        customer_id: customerId,
        customer_name: customerName || undefined,
        customer_phone: customerPhone || undefined,
        items: items.length > 0 ? items : [{ product_id: null, product_name: 'See notes', quantity: 1, unit_price: 0 }],
        notes: note || undefined,
        receiver_name: fulfilment === 'delivery' ? receiverName : undefined,
        receiver_phone: fulfilment === 'delivery' ? receiverPhone : undefined,
        delivery_address: fulfilment === 'delivery' ? deliveryAddress : undefined,
        skip_assignment: true,
      };
      const res = await api.createSale(payload);
      const saleId = res.data?.id;
      for (const att of pendingAttachments) {
        await api.uploadSaleAttachment(saleId, att.uri, att.type, att.durationSeconds);
      }
      Alert.alert('Order logged', 'The order has been added to the inbox.', [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    } catch (err) {
      Alert.alert('Could not save order', err.message || 'Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.sectionLabel}>Where did this order come from?</Text>
      <View style={styles.chipRow}>
        {CHANNELS.map((c) => (
          <TouchableOpacity
            key={c.key}
            style={[styles.chip, channel === c.key && styles.chipSelected]}
            onPress={() => selectChannel(c.key)}
          >
            <Ionicons name={c.icon} size={18} color={channel === c.key ? Colors.white : Colors.text} />
            <Text style={[styles.chipText, channel === c.key && styles.chipTextSelected]}>{c.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={styles.sectionLabel}>Customer (optional for now)</Text>
      <TextInput
        style={styles.input}
        placeholder="Phone number"
        keyboardType="phone-pad"
        value={customerPhone}
        onChangeText={setCustomerPhone}
        onBlur={lookupCustomer}
      />
      <TextInput style={styles.input} placeholder="Name" value={customerName} onChangeText={setCustomerName} />

      <Text style={styles.sectionLabel}>What are they ordering?</Text>
      {items.map((it, idx) => (
        <View key={idx} style={styles.itemRow}>
          <Text style={styles.itemText}>{it.product_name} × {it.quantity} — ₹{it.unit_price}</Text>
          <TouchableOpacity onPress={() => removeItem(idx)}>
            <Ionicons name="close-circle" size={20} color={Colors.textLight} />
          </TouchableOpacity>
        </View>
      ))}
      <View style={styles.customItemRow}>
        <TextInput style={[styles.input, styles.customItemInput]} placeholder="Item / description" value={customItemName} onChangeText={setCustomItemName} />
        <TextInput style={[styles.input, styles.priceInput]} placeholder="₹" keyboardType="numeric" value={customItemPrice} onChangeText={setCustomItemPrice} />
        <TouchableOpacity style={styles.addButton} onPress={addCustomItem}>
          <Ionicons name="add" size={22} color={Colors.white} />
        </TouchableOpacity>
      </View>
      <TextInput
        style={[styles.input, styles.noteInput]}
        placeholder="Or just jot a note if details are still being worked out…"
        value={note}
        onChangeText={setNote}
        multiline
      />

      <Text style={styles.sectionLabel}>Pickup or delivery?</Text>
      <View style={styles.chipRow}>
        <TouchableOpacity style={[styles.chip, fulfilment === 'pickup' && styles.chipSelected]} onPress={() => setFulfilment('pickup')}>
          <Text style={[styles.chipText, fulfilment === 'pickup' && styles.chipTextSelected]}>Pickup</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.chip, fulfilment === 'delivery' && styles.chipSelected]} onPress={() => setFulfilment('delivery')}>
          <Text style={[styles.chipText, fulfilment === 'delivery' && styles.chipTextSelected]}>Delivery</Text>
        </TouchableOpacity>
      </View>

      {fulfilment === 'delivery' && (
        <View>
          <Text style={styles.sectionLabel}>Recipient (if different from customer)</Text>
          <TextInput style={styles.input} placeholder="Recipient name" value={receiverName} onChangeText={setReceiverName} />
          <TextInput style={styles.input} placeholder="Recipient phone" keyboardType="phone-pad" value={receiverPhone} onChangeText={setReceiverPhone} />
          <TextInput style={styles.input} placeholder="Delivery address" value={deliveryAddress} onChangeText={setDeliveryAddress} multiline />
        </View>
      )}

      <Text style={styles.sectionLabel}>Rush order?</Text>
      <View style={styles.chipRow}>
        <TouchableOpacity style={[styles.chip, priority === 'normal' && styles.chipSelected]} onPress={() => setPriority('normal')}>
          <Text style={[styles.chipText, priority === 'normal' && styles.chipTextSelected]}>Normal</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.chip, priority === 'rush' && styles.chipSelected]} onPress={() => setPriority('rush')}>
          <Text style={[styles.chipText, priority === 'rush' && styles.chipTextSelected]}>Rush</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.sectionLabel}>Reference photo or voice note (optional)</Text>
      <TouchableOpacity style={styles.photoButton} onPress={pickReferencePhoto}>
        <Ionicons name="camera" size={20} color={Colors.text} />
        <Text style={styles.photoButtonText}>Add reference photo</Text>
      </TouchableOpacity>
      <VoiceNoteRecorder
        onRecorded={(uri, durationSeconds) => setPendingAttachments((prev) => [...prev, { uri, type: 'voice_note', durationSeconds }])}
      />
      {pendingAttachments.map((a, i) => (
        <Text key={i} style={styles.attachmentNote}>
          {a.type === 'photo' ? '📷 Photo attached' : `🎤 Voice note recorded (${a.durationSeconds}s)`} — will attach on save
        </Text>
      ))}

      <TouchableOpacity
        style={[styles.saveButton, !canSave && styles.saveButtonDisabled]}
        onPress={handleSave}
        disabled={!canSave}
      >
        {saving ? <ActivityIndicator color={Colors.white} /> : <Text style={styles.saveButtonText}>Save Order</Text>}
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.md, paddingBottom: 60 },
  sectionLabel: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.textSecondary, marginTop: Spacing.lg, marginBottom: Spacing.sm, textTransform: 'uppercase' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 10, paddingHorizontal: 14, borderRadius: BorderRadius.lg, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, minHeight: 44 },
  chipSelected: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: FontSize.md, color: Colors.text, fontWeight: '600' },
  chipTextSelected: { color: Colors.white },
  input: { backgroundColor: Colors.surface, borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border, padding: 12, fontSize: FontSize.md, marginBottom: Spacing.sm },
  noteInput: { minHeight: 60, textAlignVertical: 'top' },
  itemRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8 },
  itemText: { fontSize: FontSize.md, color: Colors.text, flex: 1 },
  customItemRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  customItemInput: { flex: 2 },
  priceInput: { flex: 1 },
  addButton: { backgroundColor: Colors.primary, borderRadius: BorderRadius.md, width: 44, height: 44, justifyContent: 'center', alignItems: 'center', marginBottom: Spacing.sm },
  photoButton: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, borderRadius: BorderRadius.lg, paddingVertical: 12, paddingHorizontal: Spacing.md, marginBottom: Spacing.sm },
  photoButtonText: { fontSize: FontSize.md, color: Colors.text, fontWeight: '600' },
  attachmentNote: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 4 },
  saveButton: { backgroundColor: Colors.primary, borderRadius: BorderRadius.lg, paddingVertical: 16, alignItems: 'center', marginTop: Spacing.xl },
  saveButtonDisabled: { backgroundColor: Colors.border },
  saveButtonText: { color: Colors.white, fontSize: FontSize.lg, fontWeight: '700' },
});
```

Check `app/src/context/AuthContext.js` for the exact exported shape (`user`, `activeLocation`) before this step — if the hook or field names differ from `useAuth()` / `activeLocation`, adjust to match the real export (other screens like `POSScreen.js` already consume this context; mirror whatever it actually exposes there rather than the names guessed above).

- [ ] **Step 2: Manual verification**

With the dev server running and the app open (navigation wiring lands in Task 11, so temporarily add `<Stack.Screen name="LogOrderTest" component={LogOrderScreen} />` to any existing stack to reach it, then remove after verifying):
1. Open the screen — default channel should be WhatsApp (or the last-used one if `AsyncStorage` already has a value).
2. Tap "Save Order" with everything empty — button should be disabled (no item, no note).
3. Type a note only, no items — Save should now be enabled; save succeeds, order appears via `GET /api/sales` with the note and no items besides the placeholder.
4. Add a custom item ("Rose Bouquet", ₹500), select Delivery, fill recipient name/phone/address, select Rush, attach a reference photo, record a voice note, Save.
5. Confirm via `GET /api/sales/:id` (or the existing `SaleDetailScreen`, reachable by navigating to the created sale) that `channel`, `priority`, `receiver_name`, `delivery_address`, and both attachments (photo + voice note) are present.

- [ ] **Step 3: Commit**

```bash
git add app/src/screens/LogOrderScreen.js
git commit -m "Add LogOrderScreen (multi-channel quick-log form)"
```

---

### Task 10: Frontend — `OrdersInboxScreen` (unified feed)

**Files:**
- Create: `app/src/screens/OrdersInboxScreen.js`

**Interfaces:**
- Consumes: `api.getSales({ status, channel, priority, order_type, limit, offset })` (extended in Tasks 3-4).
- Produces: a screen registered as `OrdersInbox` in `OrdersStack` (Task 11), navigating to the existing `SaleDetail` screen on row tap (reuses the existing detail screen per spec §5 — no new detail screen).

- [ ] **Step 1: Implement**

Create `app/src/screens/OrdersInboxScreen.js`:

```js
import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, RefreshControl, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import api from '../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const STATUS_LABELS = { pending: 'Received', confirmed: 'Confirmed', preparing: 'In Preparation', ready: 'Ready', completed: 'Completed', cancelled: 'Cancelled', draft: 'Draft' };
const CHANNEL_ICONS = { whatsapp: 'logo-whatsapp', email: 'mail', website: 'globe', walk_in: 'walk', phone: 'call' };
const STATUS_FILTERS = [null, 'pending', 'confirmed', 'preparing', 'ready', 'completed'];
const CHANNEL_FILTERS = [null, 'whatsapp', 'email', 'website', 'walk_in', 'phone'];

export default function OrdersInboxScreen({ navigation }) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [statusFilter, setStatusFilter] = useState(null);
  const [channelFilter, setChannelFilter] = useState(null);
  const [priorityOnly, setPriorityOnly] = useState(false);

  const fetchOrders = useCallback(async () => {
    try {
      const params = { limit: 100 };
      if (statusFilter) params.status = statusFilter;
      if (channelFilter) params.channel = channelFilter;
      if (priorityOnly) params.priority = 'rush';
      const res = await api.getSales(params);
      setOrders(res.data?.sales || []);
    } catch {
      setOrders([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [statusFilter, channelFilter, priorityOnly]);

  useFocusEffect(useCallback(() => { setLoading(true); fetchOrders(); }, [fetchOrders]));

  const renderItem = ({ item }) => (
    <TouchableOpacity style={styles.row} onPress={() => navigation.navigate('SaleDetail', { saleId: item.id })}>
      <Ionicons name={CHANNEL_ICONS[item.channel] || 'ellipse'} size={20} color={Colors.textSecondary} style={styles.channelIcon} />
      <View style={styles.rowMain}>
        <Text style={styles.saleNumber}>{item.sale_number}{item.priority === 'rush' ? '  🔥 Rush' : ''}</Text>
        <Text style={styles.customerName}>{item.customer_display_name || item.customer_name || 'Walk-in'}</Text>
      </View>
      <Text style={styles.statusBadge}>{STATUS_LABELS[item.status] || item.status}</Text>
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      <View style={styles.filterRow}>
        {STATUS_FILTERS.map((s) => (
          <TouchableOpacity key={s || 'all'} style={[styles.filterChip, statusFilter === s && styles.filterChipSelected]} onPress={() => setStatusFilter(s)}>
            <Text style={[styles.filterChipText, statusFilter === s && styles.filterChipTextSelected]}>{s ? STATUS_LABELS[s] : 'All'}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <View style={styles.filterRow}>
        {CHANNEL_FILTERS.map((c) => (
          <TouchableOpacity key={c || 'all'} style={[styles.filterChip, channelFilter === c && styles.filterChipSelected]} onPress={() => setChannelFilter(c)}>
            <Text style={[styles.filterChipText, channelFilter === c && styles.filterChipTextSelected]}>{c || 'Any channel'}</Text>
          </TouchableOpacity>
        ))}
        <TouchableOpacity style={[styles.filterChip, priorityOnly && styles.filterChipSelected]} onPress={() => setPriorityOnly((v) => !v)}>
          <Text style={[styles.filterChipText, priorityOnly && styles.filterChipTextSelected]}>🔥 Rush only</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={Colors.primary} />
      ) : (
        <FlatList
          data={orders}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderItem}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchOrders(); }} colors={[Colors.primary]} />}
          ListEmptyComponent={<Text style={styles.empty}>No orders match these filters.</Text>}
          contentContainerStyle={{ padding: Spacing.md }}
        />
      )}

      <TouchableOpacity style={styles.fab} onPress={() => navigation.navigate('LogOrder')}>
        <Ionicons name="add" size={28} color={Colors.white} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: Spacing.md, paddingTop: Spacing.sm },
  filterChip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: BorderRadius.lg, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, minHeight: 36 },
  filterChipSelected: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  filterChipText: { fontSize: FontSize.sm, color: Colors.text, fontWeight: '600' },
  filterChipTextSelected: { color: Colors.white },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.surface, borderRadius: BorderRadius.lg, padding: Spacing.md, marginBottom: Spacing.sm },
  channelIcon: { marginRight: Spacing.sm },
  rowMain: { flex: 1 },
  saleNumber: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  customerName: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  statusBadge: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.primary },
  empty: { textAlign: 'center', color: Colors.textLight, marginTop: 40 },
  fab: { position: 'absolute', right: Spacing.lg, bottom: Spacing.lg, width: 56, height: 56, borderRadius: 28, backgroundColor: Colors.primary, justifyContent: 'center', alignItems: 'center', elevation: 4, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 4 },
});
```

Confirmed against the live code: `SaleDetailScreen.js:48` reads `const { saleId } = route.params;` and `SalesScreen.js:158` already navigates with `{ saleId: item.id }` — the param name above (`saleId`) is correct as written, no adjustment needed.

- [ ] **Step 2: Manual verification**

Temporarily add to any existing stack (removed after verifying, wiring lands properly in Task 11): confirm the status/channel filter chips narrow the list correctly against the orders created in Tasks 3 and 9's manual step, confirm tapping a row opens the existing `SaleDetailScreen` with the right order, confirm the FAB navigates toward `LogOrder`.

- [ ] **Step 3: Commit**

```bash
git add app/src/screens/OrdersInboxScreen.js
git commit -m "Add OrdersInboxScreen (unified multi-channel order feed)"
```

---

### Task 11: Frontend — navigation wiring (parallel run)

**Files:**
- Modify: `app/src/navigation/MainNavigator.js:343-363` (`OrdersStack`, add imports near the existing screen imports at the top of the file)
- Modify: `app/src/screens/OrdersHubScreen.js:8-13` (`SECTIONS` array)

**Interfaces:**
- Consumes: `OrdersInboxScreen`, `LogOrderScreen` (Tasks 9-10).
- Produces: both reachable from the existing Orders tab, alongside — not replacing — `SalesList`/`DeliveriesList`/`PickupOrders`.

- [ ] **Step 1: Implement**

In `app/src/navigation/MainNavigator.js`, near the existing screen imports (alongside the `PickupOrdersScreen`/`OrdersHubScreen` imports around lines 74-79), add:

```js
import OrdersInboxScreen from '../screens/OrdersInboxScreen';
import LogOrderScreen from '../screens/LogOrderScreen';
```

In the `OrdersStack` function (lines 343-363), add two new `Stack.Screen` entries — after `OrdersHub`, before `SalesList`, so the inbox reads as a peer of the existing list screens, not buried:

```js
      <Stack.Screen name="OrdersInbox" component={OrdersInboxScreen} options={{ title: 'Orders Inbox' }} />
      <Stack.Screen name="LogOrder" component={LogOrderScreen} options={{ title: 'Log Order' }} />
```

In `app/src/screens/OrdersHubScreen.js`, add a new entry at the top of the `SECTIONS` array (before `SalesList`), so it's the first, most prominent tile:

```js
  { key: 'OrdersInbox', icon: 'file-tray-full', label: 'Orders Inbox (New)', color: Colors.primary, countKey: 'inboxCount' },
```

Leave the existing four `SECTIONS` entries (`SalesList`, `DeliveriesList`, `PickupOrders`, `ProductionQueue`) untouched — this is the parallel-run requirement from spec §12: old destinations stay reachable exactly as they are.

- [ ] **Step 2: Manual verification**

Run the app, navigate to the Orders tab as owner/manager: confirm "Orders Inbox (New)" appears as the first tile, tapping it opens `OrdersInboxScreen`; confirm the FAB there reaches `LogOrderScreen` and saving returns to the inbox; confirm the four pre-existing tiles (Sales, Deliveries, Pickups, Production) still work exactly as before — this is the one regression check that matters most for this task, since it's touching shared navigation.

- [ ] **Step 3: Commit**

```bash
git add app/src/navigation/MainNavigator.js app/src/screens/OrdersHubScreen.js
git commit -m "Wire OrdersInboxScreen + LogOrderScreen into navigation (parallel run)"
```

---

### Task 12: Frontend — `SaleDetailScreen`: channel/priority badges + attachments section

**Files:**
- Modify: `app/src/screens/SaleDetailScreen.js` (read the file's current structure first — it's 79KB; locate the existing header/status-badge section and the end of the main content `ScrollView` before editing)

**Interfaces:**
- Consumes: `sale.channel`, `sale.priority`, `sale.attachments` (Tasks 3-5), `api.getSaleAttachments`, `api.uploadSaleAttachment`, `VoiceNoteRecorder` (Tasks 7-8).
- Produces: no new exported interface — this task only adds a display section.

- [ ] **Step 1: Read the file's current structure**

Before writing code, grep `SaleDetailScreen.js` for its existing status-badge rendering (likely near a `STATUS_COLORS` or similar constant, per the earlier codebase survey) and its main `ScrollView`'s closing tag, so the new section is added in a place consistent with the screen's existing layout rather than guessed blindly.

- [ ] **Step 2: Implement — channel/priority badges**

Near wherever the existing status badge renders (in the sale header area), add a channel icon + label (reuse the `CHANNEL_ICONS` mapping approach from `OrdersInboxScreen.js` — either import it if `OrdersInboxScreen` exports it, or duplicate the small constant locally to avoid coupling a detail screen's import to an inbox screen) and, when `sale.priority === 'rush'`, a small "🔥 Rush" badge next to it.

- [ ] **Step 3: Implement — attachments section**

Add a new section (photos rendered as thumbnails using the existing `Image`-display pattern already used elsewhere in this screen for item images; voice notes rendered as a row with a play button using `expo-audio`'s `useAudioPlayer` hook, one row per `sale.attachments` entry where `type === 'voice_note'`) plus, at the bottom of that section, an inline `VoiceNoteRecorder` and a photo-picker button (reuse `expo-image-picker` if already a dependency — check `app/package.json` first; if present, follow whatever existing screen already uses it for a consistent picker UX) that both call `api.uploadSaleAttachment(sale.id, uri, type, duration)` on completion and then re-fetch attachments via `api.getSaleAttachments(sale.id)` to refresh the list in place.

- [ ] **Step 4: Manual verification**

Open an order created in Task 9 (which already has a voice note) via the Orders Inbox: confirm the channel icon and rush badge (if applicable) show correctly in the header, confirm the existing voice note appears and plays back, confirm recording a new voice note or adding a photo from this screen appends to the list without removing the earlier one (per spec §6/§9 — attachments are append-only).

- [ ] **Step 5: Commit**

```bash
git add app/src/screens/SaleDetailScreen.js
git commit -m "SaleDetailScreen: show channel/priority badges and attachments"
```

---

### Task 13: Frontend — `SaleDetailScreen`: edit-history section + item edit UI

**Files:**
- Modify: `app/src/screens/SaleDetailScreen.js` (same file as Task 12 — separate task because it's a materially different concern: history display + an edit flow, not just read-only badges)

**Interfaces:**
- Consumes: `api.getSaleAuditLogs(sale.id)` (existing method, already used per Task 6's backend work), `api.updateSale(sale.id, { items: [...] })` (extended in Task 6).

- [ ] **Step 1: Implement — edit-history section**

Add a collapsible "History" section (owner/manager only — check the existing role-gating pattern already used elsewhere in this screen, e.g. for cost/pricing sections, and follow the same `req.user.role`-equivalent client-side check) that calls `api.getSaleAuditLogs(sale.id)` on expand and renders each entry as "`{user_name}` changed `{action}` on `{formatted created_at}`" with a diff summary — for a first pass, list the specific fields that differ between `previous_state` and `new_state` (compare item arrays by `id` and each of `quantity`/`unit_price`, compare top-level `delivery_address`/`payment_status`) rather than dumping the raw JSON, since a non-technical owner reading this needs "quantity changed from 2 to 3," not a JSON blob.

- [ ] **Step 2: Implement — item edit UI**

Add an "Edit" affordance next to each line item (owner/manager, and per the existing `PUT /api/sales/:id` route's own rule, employees only on same-day sales they created — surface that constraint as a disabled state with a plain-language reason, e.g. "Can only edit on the day the order was placed," rather than a raw 400 error reaching the user) that opens a small inline editor for quantity and unit price, calling `api.updateSale(sale.id, { items: [{ id: item.id, quantity, unit_price }] })` on save and refreshing the sale detail afterward.

- [ ] **Step 3: Manual verification**

On the sale edited in Task 6's backend verification (or a fresh one, same-day): edit an item's price from this screen, confirm the grand total updates, confirm the History section shows the change with the old and new price; attempt an edit on a sale from a previous day (or simulate by checking the disabled state logic) and confirm the plain-language block message appears instead of a raw error.

- [ ] **Step 4: Commit**

```bash
git add app/src/screens/SaleDetailScreen.js
git commit -m "SaleDetailScreen: edit history and item price/quantity edit UI"
```

---

### Task 14: Frontend — POS defaults `channel: 'walk_in'` silently

**Files:**
- Modify: `app/src/screens/QuickCheckoutScreen.js` (find the existing `api.createSale(...)` call — the sale-creation payload assembly point)

**Interfaces:**
- Consumes: nothing new.
- Produces: every sale created through the counter flow now carries `channel: 'walk_in'` without any new UI or tap added to that screen, per spec §6's explicit requirement not to add friction to the highest-volume flow.

- [ ] **Step 1: Implement**

Find the object passed to `api.createSale(...)` in `QuickCheckoutScreen.js` and add `channel: 'walk_in',` to it — a one-line change, no new state, no new UI element.

- [ ] **Step 2: Manual verification**

Complete one full walk-in sale through the normal counter flow; confirm via `GET /api/sales/:id` (or the Orders Inbox filtered to "walk_in") that the created sale has `channel: 'walk_in'` and that nothing about the checkout flow's screens, taps, or timing changed.

- [ ] **Step 3: Commit**

```bash
git add app/src/screens/QuickCheckoutScreen.js
git commit -m "POS: default channel=walk_in on sale creation"
```

---

### Task 15: Final verification pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full backend verification script one more time**

Run (from `server/`): `node scripts/verify-order-channel.js`
Expected: every check across Tasks 1-6 passes (`N/N checks passed`).

- [ ] **Step 2: Confirm the migration is safe to re-run**

Run (from `server/`): restart the dev server a second time (`npm run dev`) and confirm it boots cleanly with no errors from the Task 1 migration block — this is the idempotency check the db-migration-safety skill requires (safe to re-run on every boot).

- [ ] **Step 3: Full manual walkthrough**

Working through the four flows named in the spec's Testing section: log one order per channel (WhatsApp, email, website, phone) via `LogOrderScreen`, verify all four appear correctly filtered in `OrdersInboxScreen`; complete one plain walk-in sale via the untouched POS flow and confirm it shows with `channel: walk_in`; open one delivery order created via quick-log with a different buyer and recipient and confirm both display correctly in `SaleDetailScreen` and on the existing delivery challan; edit an item's price on a same-day order and confirm the History section reflects it.

- [ ] **Step 4: Confirm parallel run is intact**

Confirm `SalesScreen`, `DeliveriesScreen`, and `PickupOrdersScreen` are all still reachable and functioning exactly as before this plan — nothing in Tasks 1-14 should have modified their behavior.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "Sub-project 1 complete: order channel, unified inbox, voice notes, edit history"
```
