# Order Lifecycle Simplification & Delivery Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace six independently-rendered, screen-specific status fields with one computed "Stage" every screen reads the same way; consolidate the owner/manager and counter_staff dashboards onto one kanban structure with inline one-tap actions on both; add Vendor (owner-only) and Route (normalized, grouped) fields to order entry; and rebuild the Deliveries screen into a dispatch-oriented view (route-grouped batch assign, at-risk-first, per-rider load visibility, a shared load checklist) sized to this shop's actual scale, not a full logistics platform.

**Architecture:** Stage is computed server-side, once, attached to sale objects already returned by `GET /sales`/`GET /sales/:id` — no new queries, no schema change for that piece. The existing owner/manager kanban board (`ordersByTypeAndStatus`/`renderOrderTypeSection`/`renderStatusLane` in `DashboardScreen.js`) is extracted into a shared `OrderKanbanBoard` component so both dashboards render identically instead of maintaining two parallel implementations. Vendor and Route are additive schema changes following the project's `ensureColumn`/idempotent-migration convention. The delivery checklist is a new small table, lazily populated, shared between the counter-staff and rider views (one source of truth, not two parallel checklists).

**Tech Stack:** Express.js + JWT + PostgreSQL (`pg`) via the sync `getDb()` layer for route handlers that already use it (matching each touched file's existing convention — do not introduce new sync-layer usage where a file already uses `database-async.js`); Expo/React Native + React Navigation.

**Spec:** `docs/superpowers/specs/2026-09-01-order-lifecycle-delivery-management-design.md`

## Global Constraints

- Every schema change is additive-only (new tables, new nullable columns) — no `DROP`/`RENAME`/type-narrowing on any column holding live data. Follow the existing `ensureColumn()`/`hasColumn()` idempotent pattern in `server/config/database.js`, matching the precedent set by the `refunds.created_at` type-widening migration (2026-09-01, safe additive widening) and the various `ensureColumn` calls throughout that file.
- **Any derived/summary value (Stage, per-item task indicator, per-rider load count) is computed fresh on every read, never persisted to a column.** This is the spec's non-negotiable principle — a direct lesson from the `pref_manager_override`/`stock_deducted` bug fixed earlier this session. Do not add a "cached" or "denormalized" status column anywhere in this plan.
- New/touched backend routes prefer `database-async.js`'s async `getDb()` for genuinely new query surfaces (the Route/Vendor/checklist endpoints are new files/routes — use async there); when adding a small piece to an existing route, match that route's existing sync-vs-async convention rather than migrating it.
- Every new staff-facing UI element must pass the `staff-ux-checklist` skill's checklist before being considered done — big tap targets, one obvious primary action per card, errors in plain language. Read that skill again before finalizing Tasks 9-11 (dashboard) and Tasks 16-18 (delivery checklist), which are the most staff-facing-UI-heavy tasks in this plan.
- Role/permission additions follow the roles already established this session: `owner`, `manager`, `employee`, `counter_staff`, `florist_staff`, `delivery_partner`. Do not invent a new role or reopen `GET /users` — reuse `GET /auth/staff-roster` or `GET /deliveries/partners` (both already built) for any staff-picker need.
- Live-test every task against the real dev server (Test Loc, location 4, not the real Main Shop location) using the established curl+node pattern from this session before marking a task complete, same rigor as every prior sub-project this session.

---

### Task 1: Backend — Stage computation module

**Files:**
- Create: `server/utils/order-stage.js`
- Test: manual live-test via `node -e` script (this project has no test runner configured — matches the established verification method all session)

**Interfaces:**
- Produces: `computeOrderStage(sale)` — pure function, `sale` is any object with `status`, `order_type`, `payment_status`, `pickup_status`, `delivery_status`, `is_credit_sale` fields (the exact shape `GET /sales` and `GET /sales/:id` already return). Returns `{ key, label, color, nextAction }` where `nextAction` is `{ label, endpoint, method }` or `null`.

- [ ] **Step 1: Write the module**

```js
// server/utils/order-stage.js
//
// Computes a single, order-type-aware "stage" for display, replacing the
// need for every screen to independently interpret sale.status +
// payment_status + pickup_status + delivery_status. ALWAYS computed fresh
// from the sale object passed in — never store this anywhere. See
// docs/superpowers/specs/2026-09-01-order-lifecycle-delivery-management-design.md §3.

const STAGE_COLORS = {
  new: '#FF9800',
  preparing: '#2196F3',
  ready: '#4CAF50',
  ready_for_pickup: '#4CAF50',
  out_for_delivery: '#00BCD4',
  delivered: '#4CAF50',
  picked_up: '#4CAF50',
  completed: '#9E9E9E',
  cancelled: '#F44336',
};

function computeOrderStage(sale) {
  if (sale.status === 'cancelled') {
    return { key: 'cancelled', label: 'Cancelled', color: STAGE_COLORS.cancelled, nextAction: null };
  }

  if (sale.order_type === 'pickup') {
    if (sale.status === 'pending') {
      return { key: 'new', label: 'New', color: STAGE_COLORS.new, nextAction: { label: 'Start Preparing', endpoint: `/sales/${sale.id}/status`, method: 'PUT', body: { status: 'preparing' } } };
    }
    if (sale.status === 'preparing') {
      return { key: 'preparing', label: 'Preparing', color: STAGE_COLORS.preparing, nextAction: { label: 'Mark Ready', endpoint: `/sales/${sale.id}/status`, method: 'PUT', body: { status: 'ready' } } };
    }
    if (sale.status === 'ready' || sale.pickup_status === 'ready_for_pickup') {
      const balanceDue = sale.grand_total != null && sale.total_paid != null ? Number(sale.grand_total) - Number(sale.total_paid) > 0.01 : false;
      return {
        key: 'ready_for_pickup',
        label: 'Ready for Pickup',
        color: STAGE_COLORS.ready_for_pickup,
        nextAction: (balanceDue && !sale.is_credit_sale)
          ? null // needs payment collection — route to the real screen, not a one-tap action
          : { label: 'Confirm Pickup', endpoint: `/deliveries/pickup/${sale.id}/picked-up`, method: 'PUT', body: {} },
      };
    }
    if (sale.status === 'completed' || sale.pickup_status === 'picked_up') {
      return { key: 'picked_up', label: 'Picked Up', color: STAGE_COLORS.picked_up, nextAction: null };
    }
  }

  if (sale.order_type === 'delivery') {
    if (sale.status === 'pending') {
      return { key: 'new', label: 'New', color: STAGE_COLORS.new, nextAction: { label: 'Start Preparing', endpoint: `/sales/${sale.id}/status`, method: 'PUT', body: { status: 'preparing' } } };
    }
    if (sale.status === 'preparing') {
      return { key: 'preparing', label: 'Preparing', color: STAGE_COLORS.preparing, nextAction: { label: 'Mark Ready', endpoint: `/sales/${sale.id}/status`, method: 'PUT', body: { status: 'ready' } } };
    }
    if (sale.status === 'ready' && !['picked_up', 'in_transit', 'delivered'].includes(sale.delivery_status)) {
      return { key: 'ready', label: 'Ready', color: STAGE_COLORS.ready, nextAction: null }; // assigning a rider needs the picker — no one-tap here
    }
    if (['assigned', 'picked_up', 'in_transit'].includes(sale.delivery_status)) {
      const codOutstanding = Number(sale.cod_amount || 0) > Number(sale.cod_collected || 0);
      return {
        key: 'out_for_delivery',
        label: 'Out for Delivery',
        color: STAGE_COLORS.out_for_delivery,
        nextAction: codOutstanding ? null : { label: 'Mark Delivered', endpoint: `/deliveries/${sale.delivery_id}/deliver`, method: 'PUT', body: {} },
      };
    }
    if (sale.delivery_status === 'delivered' || sale.status === 'completed') {
      return { key: 'delivered', label: 'Delivered', color: STAGE_COLORS.delivered, nextAction: null };
    }
  }

  // walk_in and pre_order share the same simple ladder
  if (sale.status === 'pending') {
    return { key: 'new', label: 'New', color: STAGE_COLORS.new, nextAction: { label: 'Start Preparing', endpoint: `/sales/${sale.id}/status`, method: 'PUT', body: { status: 'preparing' } } };
  }
  if (sale.status === 'preparing') {
    return { key: 'preparing', label: 'Preparing', color: STAGE_COLORS.preparing, nextAction: { label: 'Mark Ready', endpoint: `/sales/${sale.id}/status`, method: 'PUT', body: { status: 'ready' } } };
  }
  if (sale.status === 'ready') {
    return { key: 'ready', label: 'Ready', color: STAGE_COLORS.ready, nextAction: { label: 'Complete', endpoint: `/sales/${sale.id}/status`, method: 'PUT', body: { status: 'completed' } } };
  }
  return { key: 'completed', label: 'Completed', color: STAGE_COLORS.completed, nextAction: null };
}

module.exports = { computeOrderStage };
```

- [ ] **Step 2: Verify with a standalone script**

Run:
```bash
cd server && node -e "
const { computeOrderStage } = require('./utils/order-stage');
console.log(computeOrderStage({ id: 1, order_type: 'pickup', status: 'pending' }));
console.log(computeOrderStage({ id: 1, order_type: 'delivery', status: 'ready', delivery_status: 'in_transit', cod_amount: 200, cod_collected: 0, delivery_id: 5 }));
console.log(computeOrderStage({ id: 1, order_type: 'walk_in', status: 'completed' }));
"
```
Expected: first call returns `key: 'new'` with a "Start Preparing" nextAction; second returns `key: 'out_for_delivery'` with `nextAction: null` (COD outstanding); third returns `key: 'completed'`, `nextAction: null`.

- [ ] **Step 3: Commit**

```bash
git add server/utils/order-stage.js
git commit -m "Add computeOrderStage — single order-type-aware stage, computed fresh from existing sale fields"
```

---

### Task 2: Backend — wire `display_stage` into GET /sales and GET /sales/:id

**Files:**
- Modify: `server/routes/sales.js:159-291` (`GET /`), `server/routes/sales.js:1129-1286` (`GET /:id`)

**Interfaces:**
- Consumes: `computeOrderStage` from Task 1. **Important field-shape mismatch to fix here, not in Task 1:** `computeOrderStage` expects flat `delivery_id`/`cod_amount`/`cod_collected` fields. `GET /sales` (list) today only returns `delivery_status` flat — nothing else about the delivery. `GET /sales/:id` (detail) returns a *nested* `sale.delivery` object (`sale.delivery.id`, `sale.delivery.cod_amount`, etc.), not flat fields either. Both need a small adapter at the call site — do NOT make `computeOrderStage` itself branch on nested-vs-flat; keep the pure function simple and always flat, per its Task 1 definition.
- Produces: every sale object in both responses gains `sale.display_stage`.

- [ ] **Step 1: Import in sales.js**

```js
const { computeOrderStage } = require('../utils/order-stage');
```

- [ ] **Step 2: Extend the list query's SELECT with the fields the list endpoint is currently missing**

In `GET /`'s SQL (around line 165-171), add to the existing `d.status as delivery_status` line:
```sql
             d.status as delivery_status, d.id as delivery_id, d.cod_amount, d.cod_collected,
```

- [ ] **Step 3: Attach in the list route, right before the response is sent**

In `GET /` (around line 283-290, where `normalizedSales` is built), after the `.map(normalizeDateFields)` call — the list endpoint's rows are already flat after Step 2, so no adapter needed:

```js
    const normalizedSales = (sales || []).map(s => {
      s.items = s.items || [];
      s.items = s.items.map(normalizeDateFields);
      const normalized = normalizeDateFields(s);
      normalized.display_stage = computeOrderStage(normalized);
      return normalized;
    });
```

- [ ] **Step 4: Attach in the detail route — flatten the nested `sale.delivery`, and compute `total_paid` (also missing as a flat field on this endpoint — only `GET /sales` list selects it; the detail route relies on the frontend summing `sale.payments` client-side, which `computeOrderStage` can't do)**

In `GET /:id`, right before `res.json({ success: true, data: sale });` (around line 1285) — `sale.delivery` is a nested object here (set a few lines earlier), and `sale.payments` is already populated as an array by this point in the route (set earlier in the same handler), so build the flat view `computeOrderStage` expects without mutating what `sale.delivery`/`sale.payments` look like to existing frontend callers:

```js
    const totalPaidForStage = (sale.payments || []).reduce((sum, p) => sum + Number(p.amount || 0), 0);
    sale.display_stage = computeOrderStage({
      ...sale,
      delivery_id: sale.delivery?.id,
      cod_amount: sale.delivery?.cod_amount,
      cod_collected: sale.delivery?.cod_collected,
      delivery_status: sale.delivery?.status,
      total_paid: totalPaidForStage,
    });

    res.json({ success: true, data: sale });
```

- [ ] **Step 5: Live-test**

```bash
curl -s "http://localhost:3001/api/sales/<a real sale id>" -H "Authorization: Bearer $TOKEN" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{console.log(JSON.parse(d).data.display_stage)})"
```
Expected: a real `{key, label, color, nextAction}` object, not `undefined`.

- [ ] **Step 6: Commit**

```bash
git add server/routes/sales.js
git commit -m "Attach computed display_stage to GET /sales and GET /sales/:id responses"
```

---

### Task 3: Backend — per-item task indicator

**Files:**
- Modify: `server/routes/sales.js:1129-1286` (`GET /:id` — the only endpoint that needs this; list views don't need per-item detail, only the order detail screen does)

**Interfaces:**
- Produces: `sale.task_summary` — `{ total, completed, assignees: [names] } | null` (null when the order has ≤1 item or a single assignee, per the spec's "only show when actually relevant" rule).

- [ ] **Step 1: Add the query and computation**

Right after `sale.items` is populated (after the batch-fetch block that attaches `item.production_task`, around line 1216), add:

```js
    // Per-item task indicator — only surfaced when it's actually relevant
    // (multiple items, multiple distinct assignees). See spec §4.
    const taskRows = (sale.items || [])
      .map(i => i.production_task)
      .filter(Boolean);
    const distinctAssignees = new Set(taskRows.map(t => t.assigned_to_name).filter(Boolean));
    sale.task_summary = (sale.items.length > 1 && distinctAssignees.size > 1)
      ? {
          total: taskRows.length,
          completed: taskRows.filter(t => t.status === 'completed').length,
          assignees: [...distinctAssignees],
        }
      : null;
```

- [ ] **Step 2: Live-test against a real multi-item, multi-assignee order**

Create a test sale at Test Loc with 2 items, assign each to a different florist_staff account, then:
```bash
curl -s "http://localhost:3001/api/sales/<id>" -H "Authorization: Bearer $TOKEN" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{console.log(JSON.parse(d).data.task_summary)})"
```
Expected: `{ total: 2, completed: 0, assignees: ['Name1', 'Name2'] }`. Then test a single-item order — expect `task_summary: null`.

- [ ] **Step 3: Commit**

```bash
git add server/routes/sales.js
git commit -m "Add per-item task_summary to GET /sales/:id, conditional on multi-item/multi-assignee"
```

---

### Task 4: Backend — Vendor field schema + create/read

**Files:**
- Modify: `server/config/database.js` (migration), `server/routes/sales.js` (`POST /`, `GET /`, `GET /:id`)

**Interfaces:**
- Produces: `sales.vendor_name` column; `vendor_name` accepted on `POST /sales` (owner/manager only sets it, silently ignored from other roles' bodies); stripped from every response unless `req.user.role === 'owner'`.

- [ ] **Step 1: Additive migration**

In `server/config/database.js`, near the other `ensureColumn('sales', ...)` calls:

```js
  ensureColumn('sales', 'vendor_name', 'VARCHAR(150)');
```

- [ ] **Step 2: Accept on create, owner/manager only**

In `POST /` (Task's body destructuring, around line 1344), add `vendor_name` to the validator list:
```js
    body('vendor_name').optional({ nullable: true }).trim(),
```
and to the destructuring block. In the INSERT statement (search for the main `INSERT INTO sales` in this route), add `vendor_name` as a column — but only pass the value through when the caller is owner/manager:
```js
      const vendorNameToStore = ['owner', 'manager'].includes(req.user.role) ? (vendor_name || null) : null;
```
Use `vendorNameToStore` in place of the raw `vendor_name` wherever the INSERT binds it.

- [ ] **Step 3: Strip on every read except owner**

In `GET /` — inside the `normalizedSales` map from Task 2, add:
```js
      if (req.user.role !== 'owner') delete normalized.vendor_name;
```
In `GET /:id` — right before `res.json`:
```js
    if (req.user.role !== 'owner') delete sale.vendor_name;
```

- [ ] **Step 4: Live-test**

Create a sale as manager with `vendor_name: "Test Vendor Co"`. Confirm: owner's `GET /sales/:id` shows it; manager's own `GET /sales/:id` on the same sale does NOT show it (even though manager created it); counter_staff's read also doesn't show it.

- [ ] **Step 5: Commit**

```bash
git add server/config/database.js server/routes/sales.js
git commit -m "Add sales.vendor_name — owner/manager can set at creation, owner-only on read"
```

---

### Task 5: Frontend — Vendor input on LogOrderScreen

**Files:**
- Modify: `app/src/screens/LogOrderScreen.js`

**Interfaces:**
- Consumes: `user.role` from `useAuth()`.

- [ ] **Step 1: Add the field, gated to owner/manager**

Find where other optional fields (e.g. `special_instructions`) are rendered and add, gated:
```jsx
{(user?.role === 'owner' || user?.role === 'manager') && (
  <View style={styles.field}>
    <Text style={styles.label}>Vendor (optional)</Text>
    <TextInput
      style={styles.input}
      value={vendorName}
      onChangeText={setVendorName}
      placeholder="Who referred this order?"
      placeholderTextColor={Colors.textLight}
    />
  </View>
)}
```
Add `const [vendorName, setVendorName] = useState('');` near the other field state, and include `vendor_name: vendorName || null` in the order-creation payload sent to `api.createSale`/whichever call this screen makes.

- [ ] **Step 2: Verify counter_staff/employee/florist_staff never see the field**

Babel-transform check, then manually confirm via role-conditional render (no live screenshot tooling available — rely on the `user?.role` conditional being correct and matching the same pattern already used elsewhere in this file, e.g. any existing owner/manager-only block).

- [ ] **Step 3: Live-test end to end**

Create an order as manager with a vendor name filled in, confirm via Task 4's live-test that it round-trips correctly (owner sees it, manager doesn't on read-back).

- [ ] **Step 4: Commit**

```bash
git add app/src/screens/LogOrderScreen.js
git commit -m "Add optional owner/manager-only Vendor input to LogOrderScreen"
```

---

### Task 6: Backend — Route field: `delivery_routes` table + create-or-find + list

**Files:**
- Modify: `server/config/database.js` (migration)
- Create: `server/routes/delivery-routes.js`
- Modify: `server/server.js` (mount the new router)

**Interfaces:**
- Produces: `GET /api/delivery-routes?location_id=` (list active routes), `POST /api/delivery-routes { name, location_id }` (create-or-find, normalized).

- [ ] **Step 1: Migration**

```js
  // delivery_routes — manual grouping tag for dispatch, NOT a routing
  // algorithm (explicitly deferred per spec §9.2). normalized_name strips
  // ALL whitespace + lowercases so "Delhi"/"delhi"/"DeLhi"/" delhi"/
  // "de lhi" all collapse to one row — see spec §8.2 for the trade-off
  // this implies (also collapses e.g. "New Delhi"/"Newdelhi").
  runPsql(`
    CREATE TABLE IF NOT EXISTS delivery_routes (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      normalized_name VARCHAR(100) NOT NULL UNIQUE,
      location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
      is_active BOOLEAN DEFAULT true,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  ensureColumn('deliveries', 'route_id', 'INTEGER REFERENCES delivery_routes(id) ON DELETE SET NULL');
```
Place near the other `CREATE TABLE IF NOT EXISTS` calls in `ensureCoreTables()`.

- [ ] **Step 2: Write the route file**

```js
// server/routes/delivery-routes.js
const express = require('express');
const { body, validationResult } = require('express-validator');
const { getDb } = require('../config/database-async');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

function normalize(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, '');
}

// GET /api/delivery-routes — list active routes for the picker
router.get('/', authenticate, authorize('owner', 'manager', 'employee', 'counter_staff'), async (req, res, next) => {
  try {
    const db = await getDb();
    const { location_id } = req.query;
    const locFilter = location_id ? 'AND (location_id = ? OR location_id IS NULL)' : '';
    const params = location_id ? [location_id] : [];
    const routes = await db.prepare(
      `SELECT id, name FROM delivery_routes WHERE is_active = true ${locFilter} ORDER BY name ASC`
    ).all(...params);
    res.json({ success: true, data: { routes } });
  } catch (err) { next(err); }
});

// POST /api/delivery-routes — create-or-find, normalized
router.post(
  '/',
  authenticate,
  authorize('owner', 'manager', 'employee', 'counter_staff'),
  [body('name').trim().notEmpty().withMessage('Route name is required')],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });

      const db = await getDb();
      const { name, location_id } = req.body;
      const normalized = normalize(name);

      const existing = await db.prepare('SELECT id, name FROM delivery_routes WHERE normalized_name = ?').get(normalized);
      if (existing) {
        return res.json({ success: true, data: existing, existed: true });
      }

      try {
        const created = await db.prepare(
          'INSERT INTO delivery_routes (name, normalized_name, location_id, created_by) VALUES (?, ?, ?, ?) RETURNING id, name'
        ).get(name.trim(), normalized, location_id || null, req.user.id);
        return res.status(201).json({ success: true, data: created, existed: false });
      } catch (err) {
        // Race: another request created the same normalized name between
        // our lookup and insert — the UNIQUE constraint is the real
        // backstop here, fall back to returning the now-existing row.
        if (String(err.message || '').toLowerCase().includes('unique')) {
          const raceWinner = await db.prepare('SELECT id, name FROM delivery_routes WHERE normalized_name = ?').get(normalized);
          if (raceWinner) return res.json({ success: true, data: raceWinner, existed: true });
        }
        throw err;
      }
    } catch (err) { next(err); }
  }
);

module.exports = router;
```

- [ ] **Step 3: Mount in server.js**

```js
const deliveryRoutesRoutes = require('./routes/delivery-routes');
// ... near the other app.use('/api/...') calls:
app.use('/api/delivery-routes', deliveryRoutesRoutes);
```

- [ ] **Step 4: Live-test**

```bash
curl -s -X POST http://localhost:3001/api/delivery-routes -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"name":"Delhi","location_id":4}'
curl -s -X POST http://localhost:3001/api/delivery-routes -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"name":"  DeLhi ","location_id":4}'
```
Expected: first call `existed: false`, creates a row; second call `existed: true`, returns the SAME id — confirming the normalization collapses the variant.

- [ ] **Step 5: Commit**

```bash
git add server/config/database.js server/routes/delivery-routes.js server/server.js
git commit -m "Add delivery_routes table + create-or-find/list endpoints (manual grouping tag, not routing)"
```

---

### Task 7: Backend — wire `route_id` into delivery order creation

**Files:**
- Modify: `server/routes/sales.js` (`POST /` — the delivery auto-create block)

**Interfaces:**
- Consumes: `route_id` (optional, int) in `POST /sales` body.

- [ ] **Step 1: Accept the field**

Add to the validator list: `body('route_id').optional({ nullable: true }).isInt()`, and to the destructuring.

- [ ] **Step 2: Pass it into the deliveries INSERT**

Find the `INSERT INTO deliveries` block inside `POST /sales`'s transaction (auto-create for `order_type === 'delivery'`) and add `route_id` as a column, binding the destructured value (`route_id || null`).

- [ ] **Step 3: Return route info on delivery reads**

In `GET /deliveries` (`server/routes/deliveries.js`), add a `LEFT JOIN delivery_routes r ON r.id = d.route_id` and `r.name as route_name` to the SELECT — this is the only backend change §9.1.1 needs; the frontend does the grouping.

- [ ] **Step 4: Live-test**

Create a delivery order with a `route_id`, confirm `GET /deliveries?location_id=4` returns `route_name` for it.

- [ ] **Step 5: Commit**

```bash
git add server/routes/sales.js server/routes/deliveries.js
git commit -m "Accept route_id on delivery order creation, surface route_name on GET /deliveries"
```

---

### Task 8: Frontend — Route dropdown in QuickCheckout + LogOrder

**Files:**
- Create: `app/src/components/RoutePicker.js`
- Modify: `app/src/screens/QuickCheckoutScreen.js`, `app/src/screens/LogOrderScreen.js`
- Modify: `app/src/services/api.js` (add `getDeliveryRoutes`, `createOrFindDeliveryRoute`)

**Interfaces:**
- Produces: `<RoutePicker value={routeId} onChange={setRouteId} locationId={selectedLocation} />` — fetches the list on mount, renders a chip/dropdown list plus an "add new" text input that calls create-or-find and selects the result.

- [ ] **Step 1: api.js methods**

```js
  getDeliveryRoutes(locationId) {
    return this.request(`/delivery-routes${locationId ? `?location_id=${locationId}` : ''}`);
  }

  createOrFindDeliveryRoute(name, locationId) {
    return this.request('/delivery-routes', { method: 'POST', body: JSON.stringify({ name, location_id: locationId }) });
  }
```

- [ ] **Step 2: Build `RoutePicker.js`**

A self-contained component: fetches routes via `api.getDeliveryRoutes(locationId)` on mount, renders as a horizontal chip row (matching the existing chip pattern already used in this codebase, e.g. `SettlementsScreen`'s location chips), plus a trailing "+ Add route" chip that reveals a small `TextInput` + confirm button calling `api.createOrFindDeliveryRoute`, then calls `onChange(newRoute.id)` and refetches the list.

- [ ] **Step 3: Wire into QuickCheckout and LogOrder**

Both screens: render `<RoutePicker ... />` only when the selected order type is `'delivery'`, store `routeId` in local state, include `route_id: routeId` in the order-creation payload.

- [ ] **Step 4: Live-test**

Log a delivery order through each screen with a route selected; confirm the created sale's delivery has the correct `route_id` via a direct DB check.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/RoutePicker.js app/src/screens/QuickCheckoutScreen.js app/src/screens/LogOrderScreen.js app/src/services/api.js
git commit -m "Add RoutePicker, wire into QuickCheckout and LogOrder for delivery orders"
```

---

### Task 9: Frontend — extract `OrderKanbanBoard` shared component

**Files:**
- Create: `app/src/components/OrderKanbanBoard.js`
- Modify: `app/src/screens/DashboardScreen.js` (owner/manager branch — replace inline rendering with the extracted component, behavior-preserving)

**Interfaces:**
- Produces: `<OrderKanbanBoard sales={sales} onOrderPress={fn} onNavigateToQueue={fn} />` — pure presentational, takes the already-fetched `sales` array and callbacks, contains no data-fetching of its own.
- Consumes: `ORDER_TYPES`, `ordersByTypeAndStatus` computation, `renderOrderTypeSection`, `renderStatusLane`, `getOrderLaneSla`, `getLaneTheme`, `formatOrderType` — all currently private to `DashboardScreen.js`, moved into the new file verbatim (no logic changes in this task — pure extraction, verified by the app rendering identically for owner/manager afterward).

- [ ] **Step 1: Move the code**

Cut `ordersByTypeAndStatus` (the `useMemo`), `renderOrderTypeSection`, `renderStatusLane`, `getOrderLaneSla`, `getLaneTheme`, `formatOrderType`, and the `ORDER_TYPES`/`ORDER_PHASE_LABELS`/`normalizeOrderPhase` constants/helpers they depend on, out of `DashboardScreen.js` and into `OrderKanbanBoard.js` as a self-contained component taking `sales`/`onOrderPress`/`onNavigateToQueue` as props (replacing direct references to `navigation`/`setSelectedOrderModal` with the passed-in callbacks).

- [ ] **Step 2: Replace the owner/manager render site**

In `DashboardScreen.js`, replace the `{ORDER_TYPES.map(renderOrderTypeSection)}` block with `<OrderKanbanBoard sales={sales} onOrderPress={(order) => setSelectedOrderModal({ order, tasks: tasksBySaleId.get(order.id) })} onNavigateToQueue={handleNavigateToQueue} />`.

- [ ] **Step 3: Verify zero behavior change for owner/manager**

Babel-transform both files. Manually trace: does the rendered lane structure, SLA counts, and tap-to-navigate behavior match exactly what existed before the extraction? (No visual regression tooling available — this is a careful code-diff review, not a screenshot comparison.)

- [ ] **Step 4: Commit**

```bash
git add app/src/components/OrderKanbanBoard.js app/src/screens/DashboardScreen.js
git commit -m "Extract OrderKanbanBoard from DashboardScreen — pure extraction, no behavior change"
```

---

### Task 10: Frontend — inline one-tap actions on kanban lanes

**Files:**
- Modify: `app/src/components/OrderKanbanBoard.js`
- Modify: `app/src/services/api.js` (a generic `advanceOrder(stage.nextAction)` helper if one doesn't already fit)

**Interfaces:**
- Consumes: `sale.display_stage.nextAction` from Task 2.

- [ ] **Step 1: Add the action button to each order row within a lane**

Within the lane's order preview rows (`renderStatusLane`'s row rendering), add a small inline button when `order.display_stage?.nextAction` is present:
```jsx
{order.display_stage?.nextAction && (
  <TouchableOpacity
    style={styles.laneQuickAction}
    onPress={(e) => { e.stopPropagation(); handleQuickAction(order); }}
  >
    <Text style={styles.laneQuickActionText}>{order.display_stage.nextAction.label}</Text>
  </TouchableOpacity>
)}
```
`handleQuickAction` calls `api.request(nextAction.endpoint, { method: nextAction.method, body: JSON.stringify(nextAction.body) })` (or a small dedicated api.js wrapper), then calls a passed-in `onRefresh` prop to refetch.

- [ ] **Step 2: Live-test**

From the manager dashboard (now rendering via `OrderKanbanBoard`), tap a "Start Preparing" quick action on a real pending order at Test Loc; confirm the sale's status actually advances and the lane view refreshes to reflect it.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/OrderKanbanBoard.js app/src/services/api.js
git commit -m "Add inline one-tap stage-advance actions to kanban lane rows"
```

---

### Task 11: Frontend — rebuild counter_staff's dashboard onto `OrderKanbanBoard`

**Files:**
- Modify: `app/src/screens/DashboardScreen.js` (`isCounterStaff` branch)

**Interfaces:**
- Consumes: `OrderKanbanBoard` from Tasks 9-10.

- [ ] **Step 1: Replace the flat list with the shared kanban component**

Replace the `counterOrdersSplit.dueToday.map(...)` flat-card rendering (built earlier this session) with `<OrderKanbanBoard sales={counterPendingOrders} onOrderPress={...} onNavigateToQueue={...} />` — reusing the exact same component owner/manager now uses.

- [ ] **Step 2: Preserve the counter_staff-specific pieces**

The register-status card, the pending-COD banner, and the today/future split note (all built earlier this session) stay — they render above/around the kanban board, not replaced by it. Confirm no revenue/cash figures leak in via `OrderKanbanBoard` (verified already in the spec's grounding read — the kanban lanes are pure order-count data).

- [ ] **Step 3: Live-test as counter_staff**

Confirm the counter_staff dashboard now shows grouped-by-type-and-lane orders with inline quick actions, and that the register/COD/date-split widgets are still present and correctly scoped (no revenue totals visible).

- [ ] **Step 4: Commit**

```bash
git add app/src/screens/DashboardScreen.js
git commit -m "Rebuild counter_staff dashboard onto OrderKanbanBoard — grouping from manager view, shortcuts from counter view"
```

---

### Task 12: Frontend — SaleDetail inline pickup/delivery actions

**Files:**
- Modify: `app/src/screens/SaleDetailScreen.js`

**Interfaces:**
- Consumes: `sale.display_stage.nextAction` (Task 2) where `nextAction.label` is `'Confirm Pickup'` or `'Mark Delivered'`.

- [ ] **Step 1: Add the inline action button**

Near the existing `handleStatusTransition` buttons (`Start Preparing`/`Mark Ready`/`Complete Order`), add a conditional button rendered when `sale.display_stage?.nextAction?.label` is `'Confirm Pickup'` or `'Mark Delivered'` — calling the same generic action-dispatch helper from Task 10 (extract it to a small shared `app/src/utils/orderActions.js` if used in more than one screen, to avoid duplicating the fetch logic between `OrderKanbanBoard` and `SaleDetailScreen`).

- [ ] **Step 2: Confirm the "needs a form" case still routes correctly**

When `nextAction` is `null` because a balance/COD is outstanding (per Task 1's logic), the existing "navigate to DeliveryDetail/PickupOrders" paths (already built this session) remain the fallback — no change needed there, just confirm they still fire correctly when the inline button doesn't render.

- [ ] **Step 3: Live-test**

A pickup order with no balance due: confirm "Confirm Pickup" appears and works inline. A pickup order with balance due: confirm no inline button appears and the existing PickupOrders flow still works via navigation.

- [ ] **Step 4: Commit**

```bash
git add app/src/screens/SaleDetailScreen.js app/src/utils/orderActions.js
git commit -m "Add inline Confirm Pickup / Mark Delivered actions to SaleDetail for the no-input case"
```

---

### Task 13: Frontend — DeliveriesScreen route-grouped view + at-risk-first default

**Files:**
- Modify: `app/src/screens/DeliveriesScreen.js`

**Interfaces:**
- Consumes: `route_name` from `GET /deliveries` (Task 7); existing `GET /deliveries/at-risk`.

- [ ] **Step 1: Group by route_name instead of a flat SectionList by date**

Add a route-grouping mode alongside the existing date-grouping (keep date-grouping available as a toggle/filter — this is additive, not a removal of an existing capability, per the project's "never cut functionality" principle). Default view: at-risk deliveries first (already fetched via `getAtRiskOrders`, now surfaced as the lead section rather than just used for the "LATE" badge it already drives), then grouped by route.

- [ ] **Step 2: "Select all in this route" batch-assign convenience**

A checkbox/button on each route group header that selects every delivery in that group and opens the existing batch-assign modal (`openBatchAssignModal`) pre-populated — no change to the assign endpoint itself, purely a frontend selection convenience per spec §9.1.1.

- [ ] **Step 3: Live-test**

Create 3 test deliveries at Test Loc with the same route, confirm they group together and "select all in route → assign" correctly batch-assigns all 3 in one action.

- [ ] **Step 4: Commit**

```bash
git add app/src/screens/DeliveriesScreen.js
git commit -m "DeliveriesScreen: route-grouped view with select-all-in-route batch assign, at-risk-first default"
```

---

### Task 14: Frontend — per-rider load count in the assign picker

**Files:**
- Modify: `app/src/screens/DeliveriesScreen.js`, `app/src/screens/DeliveryDetailScreen.js` (both call `openAssignModal`)
- Modify: `server/routes/deliveries.js` (`GET /partners` — add a count)

**Interfaces:**
- Produces: `GET /deliveries/partners` gains an `active_delivery_count` per partner.

- [ ] **Step 1: Backend — add the count**

In the `GET /partners` query (built this session), add a correlated subquery or a second batched query: `(SELECT COUNT(*) FROM deliveries WHERE delivery_partner_id = u.id AND status IN ('assigned','picked_up','in_transit')) as active_delivery_count`.

- [ ] **Step 2: Frontend — render it in the picker**

In both screens' assign-partner modal list item, add `{p.active_delivery_count} stop{p.active_delivery_count !== 1 ? 's' : ''} today` next to the partner's name.

- [ ] **Step 3: Live-test**

Assign 2 deliveries to one rider, 1 to another; confirm the picker shows "2 stops" / "1 stop" correctly.

- [ ] **Step 4: Commit**

```bash
git add server/routes/deliveries.js app/src/screens/DeliveriesScreen.js app/src/screens/DeliveryDetailScreen.js
git commit -m "Show each rider's current active delivery count in the assign picker"
```

---

### Task 15: Backend — `delivery_load_checks` table + endpoints

**Files:**
- Modify: `server/config/database.js` (migration)
- Modify: `server/routes/deliveries.js` (two new endpoints)

**Interfaces:**
- Produces: `GET /deliveries/:id/checklist` (lazily creates + returns one row per sale_item on that delivery), `PUT /deliveries/:id/checklist/:saleItemId` (toggle checked).

- [ ] **Step 1: Migration**

```js
  // delivery_load_checks — packing/manifest checklist, shared between
  // counter-staff (pre-dispatch) and the rider (self-verifying) — ONE
  // set of rows both sides read/write, not two parallel checklists. See
  // spec §9.1.4.
  runPsql(`
    CREATE TABLE IF NOT EXISTS delivery_load_checks (
      id SERIAL PRIMARY KEY,
      delivery_id INTEGER NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
      sale_item_id INTEGER NOT NULL REFERENCES sale_items(id) ON DELETE CASCADE,
      checked BOOLEAN DEFAULT false,
      checked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      checked_at TIMESTAMP,
      UNIQUE(delivery_id, sale_item_id)
    )
  `);
```

- [ ] **Step 2: GET endpoint — lazy row creation**

```js
// GET /api/deliveries/:id/checklist — lazily creates one row per sale_item
// on this delivery's sale, so an item added after assignment still shows
// up next time this is viewed (spec §11, item 2's recommendation).
router.get('/:id(\\d+)/checklist', authenticate, authorize('owner', 'manager', 'employee', 'counter_staff', 'delivery_partner'), async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const delivery = await db.prepare('SELECT id, sale_id, delivery_partner_id, location_id FROM deliveries WHERE id = ?').get(req.params.id);
    if (!delivery) return res.status(404).json({ success: false, message: 'Delivery not found' });
    if (req.user.role === 'delivery_partner' && delivery.delivery_partner_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not your delivery' });
    }

    const items = await db.prepare('SELECT id, product_name, quantity FROM sale_items WHERE sale_id = ?').all(delivery.sale_id);
    for (const item of items) {
      await db.prepare(
        'INSERT INTO delivery_load_checks (delivery_id, sale_item_id) VALUES (?, ?) ON CONFLICT (delivery_id, sale_item_id) DO NOTHING'
      ).run(delivery.id, item.id);
    }

    const checklist = await db.prepare(`
      SELECT dlc.sale_item_id, dlc.checked, dlc.checked_by, dlc.checked_at, si.product_name, si.quantity, u.name as checked_by_name
      FROM delivery_load_checks dlc
      JOIN sale_items si ON si.id = dlc.sale_item_id
      LEFT JOIN users u ON u.id = dlc.checked_by
      WHERE dlc.delivery_id = ?
      ORDER BY si.id ASC
    `).all(delivery.id);

    res.json({ success: true, data: checklist });
  } catch (err) { next(err); }
});

// PUT /api/deliveries/:id/checklist/:saleItemId — toggle checked
router.put('/:id(\\d+)/checklist/:saleItemId(\\d+)', authenticate, authorize('owner', 'manager', 'employee', 'counter_staff', 'delivery_partner'), async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const delivery = await db.prepare('SELECT id, delivery_partner_id FROM deliveries WHERE id = ?').get(req.params.id);
    if (!delivery) return res.status(404).json({ success: false, message: 'Delivery not found' });
    if (req.user.role === 'delivery_partner' && delivery.delivery_partner_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not your delivery' });
    }
    const { checked } = req.body;
    await db.prepare(
      `UPDATE delivery_load_checks SET checked = ?, checked_by = ?, checked_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END
       WHERE delivery_id = ? AND sale_item_id = ?`
    ).run(!!checked, req.user.id, !!checked, req.params.id, req.params.saleItemId);
    res.json({ success: true });
  } catch (err) { next(err); }
});
```

- [ ] **Step 3: Live-test**

`GET` a fresh delivery's checklist — confirm rows are created matching its items. `PUT` to check one item, `GET` again — confirm it's persisted with `checked_by`. Confirm `delivery_partner` role gets 403 on someone else's delivery.

- [ ] **Step 4: Commit**

```bash
git add server/config/database.js server/routes/deliveries.js
git commit -m "Add delivery_load_checks table + checklist get/toggle endpoints, shared between counter staff and rider"
```

---

### Task 16: Frontend — counter-staff-side checklist UI

**Files:**
- Create: `app/src/components/DeliveryChecklist.js`
- Modify: `app/src/screens/DeliveriesScreen.js` (or `DeliveryDetailScreen.js` — attach where staff prep a rider's load)

**Interfaces:**
- Produces: `<DeliveryChecklist deliveryId={id} />` — fetches via `GET /deliveries/:id/checklist`, renders each item with a checkbox, calls the toggle endpoint on tap.

- [ ] **Step 1: Build the component**

Simple list, one row per item (`quantity`x `product_name`), a checkbox toggling on tap, `checked_by_name` shown in small text once checked (e.g. "✓ Priya, 2:14 PM").

- [ ] **Step 2: Wire in**

Add an entry point (e.g. a "Verify Load" button on a delivery's row/detail) that opens this component in a modal or dedicated screen.

- [ ] **Step 3: Live-test**

Check off items as counter_staff, confirm state persists on reload.

- [ ] **Step 4: Commit**

```bash
git add app/src/components/DeliveryChecklist.js app/src/screens/DeliveriesScreen.js
git commit -m "Add counter-staff-side load checklist UI"
```

---

### Task 17: Frontend — rider-side checklist UI

**Files:**
- Modify: `app/src/navigation/MainNavigator.js` (`DeliveryPartnerStack` — register if needed)
- Modify: whichever screen in `DeliveryPartnerStack` shows a rider's assigned deliveries (`DeliveriesScreen` as `MyDeliveries`)

**Interfaces:**
- Consumes: `DeliveryChecklist` from Task 16 — same component, reused (this is the "one shared checklist state" requirement — reusing the identical component guarantees both sides render the same data the same way).

- [ ] **Step 1: Add entry point on the rider's own delivery list**

Same "Verify Load" affordance as Task 16, reachable from `MyDeliveries` (the rider's own view within `DeliveryPartnerStack`).

- [ ] **Step 2: Live-test**

As a `delivery_partner` account, check off an item; as counter_staff, confirm the SAME state is visible (shared rows, not a separate rider-only copy).

- [ ] **Step 3: Commit**

```bash
git add app/src/navigation/MainNavigator.js app/src/screens/DeliveriesScreen.js
git commit -m "Add rider-side entry point to the shared load checklist"
```

---

### Task 18: Final verification pass

**Files:** none (verification only)

- [ ] **Step 1: Full regression**

```bash
cd server && VERIFY_OWNER_PHONE=9876453210 VERIFY_OWNER_PASSWORD=naman1234 node scripts/verify-identity-roles.js
```
Expected: 10/10, unchanged.

- [ ] **Step 2: Babel-transform every touched frontend file**

```bash
cd app && node -e "
const babel = require('@babel/core');
const files = [/* every frontend file touched across Tasks 1-17 */];
for (const f of files) { try { babel.transformFileSync(f, { presets: ['babel-preset-expo'] }); console.log('OK:', f); } catch (e) { console.log('FAIL:', f, e.message); } }
"
```

- [ ] **Step 3: End-to-end live trace of one full order lifecycle per type**

At Test Loc: one walk_in order New→Ready→Completed via inline dashboard actions; one pickup order New→Preparing→Ready for Pickup→Picked Up including a real balance-due case (confirm no inline action, routes to PickupOrders); one delivery order New→Preparing→Ready→assign-with-route→Out for Delivery→Delivered including a real COD case (confirm no inline action) — verifying `display_stage` matches the real state at every step and the checklist is populated and shared correctly for the delivery order.

- [ ] **Step 4: Clean up all test data created during this plan's verification**

Matching the established pattern all session — delete test sales/deliveries/routes/checklist rows created at Test Loc, leave nothing behind.

- [ ] **Step 5: Update CLAUDE.md's roadmap**

Mark this continuation of sub-project 5 as done, matching the format used for every prior sub-project this session, including what (if anything) got parked mid-implementation.
