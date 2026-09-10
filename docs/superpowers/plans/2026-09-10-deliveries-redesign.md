# Deliveries Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `DeliveriesScreen.js` on the order-list-foundation toolkit — bounded toolbar, `CollapsibleSection`-based Route/Date/Rider grouping, safe inline actions (reusing `resolveDeadEnd`/`nextAction`/`AssignPickerModal`/`CollectCodModal`/`TaskCompletionModal`), while preserving every existing capability (batch assign, at-risk-first, live countdowns, dual audience).

**Architecture:** `useOrderListData` owns fetch/search/filter/sort/pagination for the primary `GET /deliveries` list; a new `useAtRiskIds` hook (structurally identical to the already-shipped `useSessionsForDates`) owns the separate at-risk flag fetch. A small adapter function maps each raw delivery row into the sale-shaped object `resolveDeadEnd`/`resolvePreparerStep`/`resolveDeliverStep` expect (they were built for `GET /sales` rows; `GET /deliveries` names some of the same concepts differently — `partner_name` vs `delivery_partner_name`, the row's own `id`/`status` vs the sale-shaped `delivery_id`/`delivery_status`). The existing custom assign modal is deleted in favor of the shared `AssignPickerModal`, extended with a batch-mode branch in the caller's own `onPick`, not the component.

**Tech Stack:** Express.js + `pg` (one additive backend field); Expo/React Native, React Navigation, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-10-deliveries-redesign-design.md`.

## Global Constraints

- Every derived/summary value is computed fresh on read, never stored (CLAUDE.md).
- Minimum 44×44pt tap targets on every touchable (staff-ux-checklist #7).
- User-visible errors are plain language via `showAlert` (`app/src/utils/alert.js`), never raw `Alert.alert` or a technical message.
- No offline-first / write-queue work (CLAUDE.md constraint 3).
- No schema changes — Task 1 is a computed SELECT expression, same pattern as `GET /sales`'s `has_unassigned_open_task` addition, no new column.
- Any new horizontal `ScrollView` gets `style={{flexGrow: 0, flexShrink: 0}}` on the ScrollView itself (not just `contentContainerStyle`) — the web stretch bug found and fixed on Orders Inbox, 2026-09-10.
- Navigation to a locally-registered screen (`AddPayment`, `Settlements`, `SaleDetail`, `DeliveryDetail`) uses the bare screen name (`navigation.navigate('AddPayment', {...})`), never a cross-tab form (`navigate('POS', {screen: 'AddPayment', ...})`) — the redirect-to-wrong-screen bug found and fixed on Orders Inbox/Dashboard, 2026-09-10. `AddPayment` and `Settlements` are confirmed registered locally in both `OrdersStack` and `EmployeeOrdersStack` (`app/src/navigation/MainNavigator.js`) — verify `DeliveriesList`'s own host stack(s) the same way before relying on this in Task 6.
- This codebase has no screen-render test harness. Verification per task is `node app/scripts/babel-check.js <file>`, a plain-Node `assert` script for new pure functions, full 3-suite backend regression where backend code changes, and a live manual trace as the final task.

---

### Task 1: Backend — `has_unassigned_open_task` on `GET /deliveries`

**Files:**
- Modify: `server/routes/deliveries.js:121-141` (the `GET /` route's main SELECT)
- Test: `server/scripts/verify-order-flows.js` (add a check)

**Interfaces:**
- Produces: `has_unassigned_open_task` (boolean) on every `GET /deliveries` row — same name, same predicate as `GET /sales`'s field of the same name (`server/routes/sales.js`, added 2026-09-10).

**Why:** a delivery order in its 'new'/pending stage gets a "Start Preparing" `nextAction` exactly like any other order type (order-stage.js's delivery branch reuses the same walk-in/pickup 'new' case). Without this field, Task 6's safe-resolution guard for that action would have no way to know whether firing it blind is safe — the exact gap that made Orders Inbox's next-actions "disappear" before the 2026-09-10 fix. Copy that fix here rather than let Deliveries ship with the same latent gap.

- [ ] **Step 1: Write the failing test**

In `server/scripts/verify-order-flows.js`, find the existing check titled `'NEW: GET /sales list rows carry has_unassigned_open_task, flipping false once the task is assigned (2026-09-10 — Orders Inbox one-tap Start Preparing fix)'` — this task's check is the same shape, against `GET /deliveries` instead. Add a new check directly after it:

```js
check('NEW: GET /deliveries list rows carry has_unassigned_open_task, flipping false once the task is assigned (2026-09-10 — Deliveries one-tap Start Preparing fix)', async () => {
  const db = await getDb();
  const owner = await loginOwner();
  const createRes = await api('POST', '/sales', owner.token, {
    location_id: TEST_LOCATION_ID, order_type: 'delivery', channel: 'phone',
    customer_name: `DeliveryUnassignedTaskCheck${Date.now()}`,
    delivery_address: '123 Test St', receiver_name: 'Test Receiver', receiver_phone: '9998887777',
    items: [{ quantity: 1, unit_price: 100, product_name: 'Test Delivery Unassigned Task Item' }],
  });
  assert(createRes.status === 201, `Expected sale creation to succeed, got ${createRes.status}: ${JSON.stringify(createRes.body)}`);
  const saleId = createRes.body.data.id;
  createdSaleIds.push(saleId);

  const task = await db.prepare('SELECT id, assigned_to FROM production_tasks WHERE sale_id = ? LIMIT 1').get(saleId);
  assert(task, `Expected a production_tasks row to exist for a freshly created delivery sale (id ${saleId}), found none`);
  assert(task.assigned_to == null, `Expected the freshly created task to start unassigned, got assigned_to=${task.assigned_to}`);

  const beforeRes = await api('GET', `/deliveries?location_id=${TEST_LOCATION_ID}&limit=200`, owner.token);
  assert(beforeRes.status === 200, `Expected 200, got ${beforeRes.status}: ${JSON.stringify(beforeRes.body)}`);
  const beforeRow = beforeRes.body.data.deliveries.find((d) => d.sale_id === saleId);
  assert(beforeRow, `Expected a deliveries row for sale ${saleId} to appear`);
  assert(beforeRow.has_unassigned_open_task === true, `Expected has_unassigned_open_task=true before assignment, got ${JSON.stringify(beforeRow.has_unassigned_open_task)}`);

  const assignRes = await api('PUT', `/production/tasks/${task.id}/assign`, owner.token, { assigned_to: owner.id });
  assert(assignRes.status === 200, `Expected task assignment to succeed, got ${assignRes.status}: ${JSON.stringify(assignRes.body)}`);

  const afterRes = await api('GET', `/deliveries?location_id=${TEST_LOCATION_ID}&limit=200`, owner.token);
  const afterRow = afterRes.body.data.deliveries.find((d) => d.sale_id === saleId);
  assert(afterRow, `Expected the deliveries row for sale ${saleId} to still appear after assignment`);
  assert(
    afterRow.has_unassigned_open_task === false,
    `Expected has_unassigned_open_task=false once the task is assigned, got ${JSON.stringify(afterRow.has_unassigned_open_task)}`
  );
});
```

(This reuses `createdSaleIds`/`TEST_LOCATION_ID`/`loginOwner`/`api`/`check`/`assert`/`getDb` — all already in scope in this file. The request body's exact required fields — `delivery_address`, `receiver_name`, `receiver_phone` — are copied verbatim from this same file's existing `createReadyDelivery` helper (search for `order_type: 'delivery'` in this file). Do NOT call that helper directly for this check — it also advances the task through 'preparing' → 'completed', which would defeat the point of this test; build the request body inline as shown above instead.)

- [ ] **Step 2: Run test to verify it fails**

Run: `VERIFY_OWNER_PHONE=<phone> VERIFY_OWNER_PASSWORD=<password> node server/scripts/verify-order-flows.js` (use this repo's actual dev owner credentials — see the project's memory file for the local dev test account, or ask the user)
Expected: the new check fails — `has_unassigned_open_task` is `undefined` on the returned row (field doesn't exist yet).

- [ ] **Step 3: Write the implementation**

In `server/routes/deliveries.js`, the main SELECT (lines 121-141) currently reads:
```js
    let sql = `
      SELECT d.*, s.sale_number, s.grand_total, s.payment_status, s.order_type,
             s.status as order_status, s.pickup_status, s.special_instructions, s.is_credit_sale,
             COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.sale_id = d.sale_id), 0) as total_paid,
             (SELECT COUNT(*) FROM production_tasks pt WHERE pt.sale_id = s.id AND pt.status NOT IN ('completed', 'cancelled')) as open_task_count,
             -- Load-verify indicator — same fields/reasoning as sales.js's
             -- GET / and GET /:id (see either for the full comment).
             (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) as load_total_count,
             (SELECT COUNT(*) FROM delivery_load_checks dlc WHERE dlc.delivery_id = d.id AND dlc.checked = true) as load_checked_count,
             u.name as partner_name, u.phone as partner_phone,
             l.name as location_name,
             ab.name as assigned_by_name,
             r.name as route_name
      FROM deliveries d
```

Add `has_unassigned_open_task` right after `open_task_count`, mirroring `sales.js`'s addition exactly (verbatim predicate):
```js
    let sql = `
      SELECT d.*, s.sale_number, s.grand_total, s.payment_status, s.order_type,
             s.status as order_status, s.pickup_status, s.special_instructions, s.is_credit_sale,
             COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.sale_id = d.sale_id), 0) as total_paid,
             (SELECT COUNT(*) FROM production_tasks pt WHERE pt.sale_id = s.id AND pt.status NOT IN ('completed', 'cancelled')) as open_task_count,
             EXISTS(
               SELECT 1 FROM production_tasks ptu
               WHERE ptu.sale_id = s.id AND ptu.assigned_to IS NULL
                 AND ptu.status IN ('pending', 'in_progress')
             ) as has_unassigned_open_task,
             -- Load-verify indicator — same fields/reasoning as sales.js's
             -- GET / and GET /:id (see either for the full comment).
             (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) as load_total_count,
             (SELECT COUNT(*) FROM delivery_load_checks dlc WHERE dlc.delivery_id = d.id AND dlc.checked = true) as load_checked_count,
             u.name as partner_name, u.phone as partner_phone,
             l.name as location_name,
             ab.name as assigned_by_name,
             r.name as route_name
      FROM deliveries d
```

Add a one-line comment above the `let sql =` line (immediately after the existing `open_task_count` comment block that ends `// All three copies MUST stay identical.`), noting this is a fourth copy of the same kind of guard field and must stay in sync with `sales.js`'s `has_unassigned_open_task`.

- [ ] **Step 4: Run test to verify it passes**

Run the same command as Step 2.
Expected: all checks pass, including the new one.

- [ ] **Step 5: Commit**

```bash
git add server/routes/deliveries.js server/scripts/verify-order-flows.js
git commit -m "Add has_unassigned_open_task to GET /deliveries (Deliveries redesign)"
```

---

### Task 2: `useAtRiskIds` hook

**Files:**
- Create: `app/src/hooks/useAtRiskIds.js`

**Interfaces:**
- Consumes: `api.getAtRiskOrders(params)` (existing, returns `{ data: [{ delivery_id, sale_id, type: 'delivery'|'pickup', ... }] }`).
- Produces: `export default function useAtRiskIds(locationId, resetToken)` → `{ atRiskIds }`, a `Set` of `delivery_id` values. Task 5 reads this to build the at-risk lead section and to badge individual cards.

**Interfaces (structural precedent):** this hook is deliberately built exactly like the already-shipped `app/src/hooks/useSessionsForDates.js` — same `resetToken`-triggers-refetch shape (see that file's own header comment for the full "why a reset token, not just a dependency change" reasoning: this screen never unmounts on a focus loss/regain, so without an explicit reset signal a stale fetch would never refresh). Read that file before writing this one; the two should read as siblings, not independent designs.

- [ ] **Step 1: Write the implementation**

Create `app/src/hooks/useAtRiskIds.js`:
```js
// At-risk delivery/pickup detection for the Deliveries screen's lead
// section — structurally identical to useSessionsForDates.js's resetToken
// pattern (see that file's header comment for the full reasoning: this
// screen never unmounts on a focus loss/regain, so a plain dependency-array
// fetch would never refresh once mounted). See
// docs/superpowers/specs/2026-09-10-deliveries-redesign-design.md §3.
import { useState, useEffect } from 'react';
import api from '../services/api';

export default function useAtRiskIds(locationId, resetToken) {
  const [atRiskIds, setAtRiskIds] = useState(new Set());

  useEffect(() => {
    let cancelled = false;
    api.getAtRiskOrders(locationId ? { location_id: locationId } : {})
      .then((res) => {
        if (cancelled) return;
        const ids = new Set();
        for (const row of res.data || []) {
          if (row.delivery_id) ids.add(row.delivery_id);
        }
        setAtRiskIds(ids);
      })
      .catch(() => { if (!cancelled) setAtRiskIds(new Set()); });
    return () => { cancelled = true; };
  }, [locationId, resetToken]);

  return { atRiskIds };
}
```

- [ ] **Step 2: Babel-check**

Run: `node app/scripts/babel-check.js app/src/hooks/useAtRiskIds.js`

- [ ] **Step 3: Commit**

```bash
git add app/src/hooks/useAtRiskIds.js
git commit -m "Add useAtRiskIds hook for Deliveries redesign"
```

---

### Task 3: `DeliveriesScreen.js` — swap data layer to `useOrderListData` + `useAtRiskIds`

**Files:**
- Modify: `app/src/screens/DeliveriesScreen.js`

**Interfaces:**
- Consumes: `useOrderListData(fetchFn, { pageSize })` (existing, see `app/src/hooks/useOrderListData.js` for the exact returned shape — `items, loading, refreshing, error, total, hasMore, loadMore, refresh, search, setSearch, filters, setFilter, clearFilters, sort, setSort, activeFilterCount`). `useAtRiskIds(locationId, resetToken)` (Task 2).
- Produces: this task only replaces internal state; the screen's exported default is unchanged. Later tasks build on the `list`/`atRiskIds` objects this task creates. The existing `SectionList`-based render stays wired to the new data source for now (Task 5 replaces it) — same incremental-migration approach used for Orders Inbox.

- [ ] **Step 1: Replace `fetchDeliveries`/`selectedLocation`/`atRiskIds` state**

In `app/src/screens/DeliveriesScreen.js`, add imports:
```js
import useOrderListData from '../hooks/useOrderListData';
import useAtRiskIds from '../hooks/useAtRiskIds';
```

Replace the `deliveries`/`loading`/`atRiskIds` state and the `fetchDeliveries` callback (current lines ~57-64, ~122-148) with:
```js
const fetchFn = useCallback(
  (params) => api.getDeliveries(params).then((res) => ({ items: res.data?.deliveries || [], total: Number(res.data?.total) || 0 })),
  []
);
const list = useOrderListData(fetchFn, { pageSize: 50 });
// Bumped on every focus-regain (see useFocusEffect below) — same reset-
// token pattern useSessionsForDates/useAtRiskIds both use, for the same
// reason (this screen never unmounts on a focus loss/regain).
const [resetToken, setResetToken] = useState(0);
const { atRiskIds } = useAtRiskIds(list.filters.location_id, resetToken);
```

Remove the `deliveries`/`loading` `useState` declarations and the old `atRiskIds` `useState` declaration (all superseded by `list`/`useAtRiskIds` above). Keep `assignModalVisible`, `selectedDelivery`, `partners`, `now`, `tickRef`, `batchMode`, `selectedIds`, `viewMode` as-is for now — Tasks 6/7 revisit `assignModalVisible`/`selectedDelivery`/`partners` specifically.

- [ ] **Step 2: Replace the location chip row's state with `list.filters.location_id`**

The current `locations`/`selectedLocation` `useState` pair and `fetchLocations` callback (lines ~69-118) stay for now — Task 4 moves location selection into `FilterDrawer`, driven by `list.setFilter('location_id', ...)` instead of local `selectedLocation` state. This task only needs `list.filters.location_id` to exist as a read target for `useAtRiskIds` above; leave the existing chip-row UI functioning as today until Task 4.

Actually — since `useAtRiskIds` above reads `list.filters.location_id`, and the existing screen's location selection writes to local `selectedLocation` state (not `list.filters`), wire the two together for this task only: after the `list`/`useAtRiskIds` declarations above, add
```js
useEffect(() => {
  list.setFilter('location_id', selectedLocation || undefined);
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [selectedLocation]);
```
This keeps the existing location-chip UI (untouched until Task 4) working as the single source of truth for both `list`'s own fetch and `useAtRiskIds`, without a bigger rewrite in this task.

- [ ] **Step 3: Replace `useFocusEffect` and the SectionList's data source**

Replace the existing `useFocusEffect(useCallback(() => { fetchDeliveries(); }, [fetchDeliveries]));` with:
```js
useFocusEffect(useCallback(() => {
  list.refresh();
  setResetToken((g) => g + 1);
}, [list.refresh]));
```

Change the existing `SectionList`'s `refreshing`/`onRefresh` props from `loading`/`fetchDeliveries` to `list.refreshing`/`list.refresh`. Change every read of the old `deliveries` array (in `filteredDeliveries`, `sortedDeliveries`, etc.) to read `list.items` instead. Change every read of the old `atRiskIds` variable to the new `atRiskIds` from `useAtRiskIds` (same variable name, no further changes needed at call sites). Leave `filteredDeliveries`/`sortedDeliveries`/`dateSections`/`routeSections` logic itself untouched for this task — Task 5 replaces that whole block.

- [ ] **Step 4: Babel-check**

Run: `node app/scripts/babel-check.js app/src/screens/DeliveriesScreen.js`

- [ ] **Step 5: Manual smoke check**

Run the app, open Deliveries, confirm: the list loads, location chips still filter, Route/Date toggle still works, at-risk lead section still appears for genuinely at-risk deliveries, pull-to-refresh still works, navigating away and back still refetches.

- [ ] **Step 6: Commit**

```bash
git add app/src/screens/DeliveriesScreen.js
git commit -m "Swap Deliveries data layer to useOrderListData + useAtRiskIds"
```

---

### Task 4: `DeliveriesScreen.js` — toolbar & filters

**Files:**
- Modify: `app/src/screens/DeliveriesScreen.js`

**Interfaces:**
- Consumes: `OrderListToolbar({ search, onSearchChange, activeFilterCount, onOpenFilters, sortProps, viewModeProps, placeholder })`, `FilterDrawer({ visible, onClose, sections, onClearAll })`, `ActiveFilterChips({ filters, labels, onRemove, onClearAll })` — all existing, unmodified interfaces (see `app/src/components/orders/*.js`).

- [ ] **Step 1: Replace the search row, location-chip row, and view-mode row**

Remove the manual `searchRow` `TextInput` block and the `locationTabsRow` `ScrollView` (location chips) — replace with:
```jsx
<OrderListToolbar
  search={list.search}
  onSearchChange={list.setSearch}
  activeFilterCount={list.activeFilterCount}
  onOpenFilters={() => setFiltersOpen(true)}
  viewModeProps={canManageDeliveries ? {
    value: viewMode,
    onChange: setViewMode,
    options: [
      { value: 'route', label: 'By Route' },
      { value: 'date', label: 'By Date' },
      { value: 'rider', label: 'By Rider' },
    ],
  } : undefined}
  sortProps={{
    value: list.sort,
    onChange: list.setSort,
    options: [{ value: null, label: 'Recent' }, { value: 'urgency', label: 'Urgent first' }],
  }}
  placeholder="Search by order #, customer, partner…"
/>
```
(`viewModeProps` undefined for a `delivery_partner` viewer — matches today's `canManageDeliveries` gate on the existing view-mode row exactly; their view stays forced to `'date'`, unchanged, via the existing `effectiveViewMode` logic already in the file.)

Add `const [filtersOpen, setFiltersOpen] = useState(false);` near the other `useState` declarations.

Keep the existing `STATUS_TABS` `ScrollView` chip row exactly as it is (spec §2: Status stays a visible one-tap row) — only wrap its outer `<ScrollView horizontal ...>` with `style={styles.statusTabsScroll}` if it doesn't already have an explicit `style` prop with `flexGrow: 0, flexShrink: 0` (check the existing `tabsRow` style — if it already has `flexGrow: 0, flexShrink: 0` as its `style` prop value, as `DeliveriesScreen.js`'s current styles already do per the spec's own §0.3 note that this pattern already existed here, no change needed).

- [ ] **Step 2: Add `FilterDrawer` (location, rider, date-range) and `ActiveFilterChips`**

Add after the toolbar:
```jsx
<ActiveFilterChips
  filters={{ location_id: list.filters.location_id, delivery_partner_id: list.filters.delivery_partner_id, date_from: list.filters.date_from, date_to: list.filters.date_to }}
  labels={{
    location_id: (v) => `Location: ${locations.find((l) => l.id === v)?.name || v}`,
    delivery_partner_id: (v) => `Rider: ${partners.find((p) => p.id === v)?.name || v}`,
    date_from: (v) => `From: ${v}`,
    date_to: (v) => `To: ${v}`,
  }}
  onRemove={(key) => { if (key === 'location_id') setSelectedLocation(null); else list.setFilter(key, undefined); }}
  onClearAll={() => { setSelectedLocation(null); list.setFilter('delivery_partner_id', undefined); list.setFilter('date_from', undefined); list.setFilter('date_to', undefined); }}
/>

<FilterDrawer
  visible={filtersOpen}
  onClose={() => setFiltersOpen(false)}
  onClearAll={() => { setSelectedLocation(null); list.setFilter('delivery_partner_id', undefined); list.setFilter('date_from', undefined); list.setFilter('date_to', undefined); setFiltersOpen(false); }}
  sections={[
    ...(isManager ? [{
      key: 'location', label: 'Location', value: selectedLocation ?? null,
      onChange: (v) => setSelectedLocation(v),
      options: [{ value: null, label: isOwner ? 'All Locations' : 'My Location' }, ...locations.map((l) => ({ value: l.id, label: l.name }))],
    }] : []),
    {
      key: 'rider', label: 'Rider', value: list.filters.delivery_partner_id ?? null,
      onChange: (v) => list.setFilter('delivery_partner_id', v || undefined),
      options: [{ value: null, label: 'Any rider' }, ...partners.map((p) => ({ value: p.id, label: p.name }))],
    },
    {
      key: 'date_range', label: 'Date range', value: dateRangePreset ?? null,
      onChange: (v) => applyDateRangePreset(v),
      options: [
        { value: null, label: 'All dates' },
        { value: 'today', label: 'Today' },
        { value: 'yesterday', label: 'Yesterday' },
        { value: 'this_week', label: 'This Week' },
      ],
    },
  ]}
/>
```

Note `partners` here reuses the SAME state the assign modal already fetches (`const [partners, setPartners] = useState([]);`) — this task doesn't fetch it separately, but that state is currently populated lazily only when the assign modal opens (`openAssignModal`), so it will often be empty when the drawer first renders. Fetch it once on mount instead, using the same `api.getDeliveryPartners(selectedLocation)` call already in the file:
```js
useEffect(() => {
  api.getDeliveryPartners(selectedLocation).then((res) => {
    const users = res.data?.users || res.data || [];
    setPartners(Array.isArray(users) ? users : []);
  }).catch(() => {});
}, [selectedLocation]);
```
Remove the now-redundant partner-fetching from `openAssignModal`/`openBatchAssignModal` in Task 7 once `AssignPickerModal` replaces them (they'll fetch their own list on open, matching the Orders Inbox rider-picker pattern — see Task 7).

Add a small pure helper near the top of the file (or inline where `dateRangePreset` state is declared) for the date-range preset → `date_from`/`date_to` mapping:
```js
const [dateRangePreset, setDateRangePreset] = useState(null);
const applyDateRangePreset = (preset) => {
  setDateRangePreset(preset);
  const todayStr = getShopTodayStr(timezone);
  if (preset === 'today') {
    list.setFilter('date_from', todayStr); list.setFilter('date_to', todayStr);
  } else if (preset === 'yesterday') {
    const y = new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: timezone });
    list.setFilter('date_from', y); list.setFilter('date_to', y);
  } else if (preset === 'this_week') {
    const now = getShopNow(timezone);
    const day = now.getDay(); // 0 = Sunday
    const monday = new Date(now); monday.setDate(now.getDate() - ((day + 6) % 7));
    const mondayStr = monday.toLocaleDateString('en-CA', { timeZone: timezone });
    list.setFilter('date_from', mondayStr); list.setFilter('date_to', todayStr);
  } else {
    list.setFilter('date_from', undefined); list.setFilter('date_to', undefined);
  }
};
```
(`getShopTodayStr`/`getShopNow` are already imported in this file per its existing imports list — no new import needed. `GET /deliveries` already accepts `date_from`/`date_to` per the route read in Task 1's investigation.)

- [ ] **Step 3: Babel-check**

Run: `node app/scripts/babel-check.js app/src/screens/DeliveriesScreen.js`

- [ ] **Step 4: Manual smoke check**

Confirm: search/filters/view-mode/sort row renders correctly (no stretched chips — if any do, the ScrollView `style` fix from Global Constraints is missing somewhere new); Filters drawer shows Location/Rider/Date range; selecting each filters correctly and shows a removable chip; Status row still one-tap; "By Rider" appears as a third view-mode option for management roles only.

- [ ] **Step 5: Commit**

```bash
git add app/src/screens/DeliveriesScreen.js
git commit -m "Rebuild Deliveries toolbar with FilterDrawer, add By Rider view mode"
```

---

### Task 5: `DeliveriesScreen.js` — `CollapsibleSection`-based grouping, replacing `SectionList`

**Files:**
- Modify: `app/src/screens/DeliveriesScreen.js`

**Interfaces:**
- Consumes: `CollapsibleSection({ title, count, defaultExpanded, children })` (existing, `app/src/components/orders/CollapsibleSection.js`).

**Grouping rule (spec §4, confirmed with the user):** `sort === 'urgency'` → one flat list, no headers, no at-risk lead section, server order. Otherwise: Route view leads with an at-risk section then one `CollapsibleSection` per route; Date view is one `CollapsibleSection` per date (with the `_unscheduled` → "No Date Set" fix); Rider view is one `CollapsibleSection` per `partner_name`.

- [ ] **Step 1: Delete the client-side re-sort and replace `SectionList` with a `ScrollView` of `CollapsibleSection`s**

Delete the `sortedDeliveries` block (current lines ~269-276, the manual `[...filteredDeliveries].sort(...)`) entirely — the server's own `ORDER BY` (default status-ladder, or `sort=urgency` once passed through `list.sort`) is now trusted. Replace every remaining reference to `sortedDeliveries` in the grouping logic below with `filteredDeliveries` directly (the search-filter step stays; only the extra client re-sort is removed).

Fix the blank `_unscheduled` label — find `const getDateLabel = (dateStr) => formatShopDateLabel(dateStr, timezone);` and the `dateSections` loop's `key = extractLocalDate(item.scheduled_date) || '_unscheduled'`. Change the section-title assignment at that loop (`title: getDateLabel(key)`) to:
```js
title: key === '_unscheduled' ? 'No Date Set' : getDateLabel(key),
```

Add the new Rider grouping, alongside the existing `routeSections`-building block:
```js
const NO_RIDER_KEY = '_no_rider';
const riderSections = [];
const byRider = {};
const riderKeys = [];
for (const item of filteredDeliveries) {
  const key = item.partner_name || NO_RIDER_KEY;
  if (!byRider[key]) {
    byRider[key] = { key, title: item.partner_name || 'Unassigned', data: [], isAtRisk: false, isRoute: false };
    riderKeys.push(key);
  }
  byRider[key].data.push(item);
}
riderKeys.sort((a, b) => {
  if (a === NO_RIDER_KEY) return 1;
  if (b === NO_RIDER_KEY) return -1;
  return a.localeCompare(b);
});
for (const key of riderKeys) riderSections.push(byRider[key]);
```

Change the `sections` selection line from
```js
const sections = effectiveViewMode === 'route' ? routeSections : dateSections;
```
to:
```js
const sections = list.sort === 'urgency'
  ? [{ key: '_flat', title: null, data: filteredDeliveries, isAtRisk: false, isRoute: false }]
  : effectiveViewMode === 'route' ? routeSections
  : effectiveViewMode === 'rider' ? riderSections
  : dateSections;
```

Replace the `<SectionList ... />` block with a `ScrollView` of `CollapsibleSection`s:
```jsx
<ScrollView
  refreshControl={<RefreshControl refreshing={list.refreshing} onRefresh={list.refresh} colors={[Colors.primary]} />}
  contentContainerStyle={{ padding: Spacing.md, paddingBottom: 100 }}
>
  {sections.length === 0 ? (
    <View style={styles.empty}>
      <Ionicons name="bicycle-outline" size={48} color={Colors.textLight} />
      <Text style={styles.emptyText}>No deliveries found</Text>
    </View>
  ) : list.sort === 'urgency' ? (
    sections[0].data.map((item) => <View key={item.id}>{renderDelivery({ item })}</View>)
  ) : (
    sections.map((section) => {
      const selectableCount = section.isRoute ? section.data.filter(isDueForDispatch).length : 0;
      return (
        <CollapsibleSection key={section.key} title={section.title} count={section.data.length} defaultExpanded>
          {section.isRoute && canManageDeliveries && selectableCount > 0 && (
            <TouchableOpacity style={styles.selectRouteBtn} onPress={() => selectAllInRoute(section.data)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="checkmark-done-outline" size={16} color={Colors.primary} />
              <Text style={styles.selectRouteBtnText}>Select today's ({selectableCount})</Text>
            </TouchableOpacity>
          )}
          {section.data.map((item) => <View key={item.id}>{renderDelivery({ item })}</View>)}
        </CollapsibleSection>
      );
    })
  )}
</ScrollView>
```

Note the at-risk lead section (`routeSections`'s existing `_at_risk` entry, built earlier in the file) is now just another entry in `routeSections` and renders through the same `CollapsibleSection` path above — no special-case JSX needed for it, matching how it already worked as a `SectionList` section before this task. Add the import: `import CollapsibleSection from '../components/orders/CollapsibleSection';`. `SectionList` import can be removed from the `react-native` import line if nothing else in the file uses it — check before removing (`ScrollView` must be added to that same import line if not already present — it already is, per the file's existing `searchRow`/`locationTabsRow` usage).

- [ ] **Step 2: Babel-check**

Run: `node app/scripts/babel-check.js app/src/screens/DeliveriesScreen.js`

- [ ] **Step 3: Manual smoke check**

Confirm: Route/Date/Rider view switching all render correctly with real collapse/expand (tap a section header, confirm it collapses and the chevron flips); "No Date Set" shows instead of a blank header for undated deliveries in Date view; "Urgent first" sort shows one flat list with zero section headers and zero at-risk lead section; "select all in this route" still appears only in Route view sections and only where a selectable delivery exists.

- [ ] **Step 4: Commit**

```bash
git add app/src/screens/DeliveriesScreen.js
git commit -m "Replace Deliveries SectionList with CollapsibleSection grouping, add By Rider view"
```

---

### Task 6: `DeliveriesScreen.js` — card redesign: item collapse, `ContactButtons`, safe actions

**Files:**
- Modify: `app/src/screens/DeliveriesScreen.js`

**Interfaces:**
- Consumes: `ContactButtons({ contacts, context })` (existing), `resolveDeadEnd(order, canManageDeliveries, canTakeMoney)`, `resolvePreparerStep`, `resolveDeliverStep` (all exported from `app/src/components/orderBoard/OrderCard.js`), `CollectCodModal({ visible, order, onClose, onDone })`, `TaskCompletionModal({ visible, order, onClose, onDone })` (both existing, `app/src/components/orderBoard/`).

**The delivery-row → sale-shaped adapter (spec §3, load-bearing — do not skip):** `resolveDeadEnd`/`resolvePreparerStep`/`resolveDeliverStep` were built against `GET /sales` rows. A `GET /deliveries` row names some of the same concepts differently: the row's own `id` is the delivery id (what a sale-shaped object calls `delivery_id`), its own `status` is the delivery status (what a sale-shaped object calls `delivery_status`), and its rider's name is `partner_name` (not `delivery_partner_name`). `display_stage`/`nextAction`/`open_task_count`/`has_unassigned_open_task`/`cod_amount`/`cod_collected`/`grand_total`/`total_paid`/`is_credit_sale` are already named identically on both routes — no mapping needed for those. Without this adapter, `resolveDeadEnd`'s `order.delivery_partner_name` read would silently return `undefined` for every delivery row, breaking its "X has it" status lines and its `assign_rider`/`reattempt_delivery` branching (both keyed on `delivery_status`/`delivery_partner_name`).

- [ ] **Step 1: Add the adapter function and role flags**

Near the top of `app/src/screens/DeliveriesScreen.js` (module scope, alongside other helper functions like `getTimeInfo`), add:
```js
// GET /deliveries rows aren't sale-shaped — resolveDeadEnd/resolvePreparerStep/
// resolveDeliverStep (OrderCard.js) were built against GET /sales rows. See
// this task's own interface note in docs/superpowers/plans/2026-09-10-
// deliveries-redesign.md Task 6 for the full field-name mapping and why it's
// required, not optional.
function toSaleShape(delivery) {
  return {
    ...delivery,
    id: delivery.sale_id,
    delivery_id: delivery.id,
    delivery_status: delivery.status,
    delivery_partner_name: delivery.partner_name,
  };
}
```

Inside the component body, add the same role-flag consts already used in `OrdersInboxScreen.js` (copied from `OrderCard.js`'s own, not re-derived):
```js
const canTakeMoney = ['owner', 'manager', 'employee', 'counter_staff'].includes(user?.role);
// canManageDeliveries already exists in this file (line ~87) — reuse it directly, it's the same role list resolveDeadEnd's doc comment expects for canManageDeliveries.
```

- [ ] **Step 2: Add state for the new modals**

Alongside the other `useState` declarations:
```js
const [codCollectOrder, setCodCollectOrder] = useState(null);
const [taskCompletionOrder, setTaskCompletionOrder] = useState(null);
const [advancingId, setAdvancingId] = useState(null);
```

- [ ] **Step 3: Collapse the item list behind a disclosure**

Find the always-inline item list block in `renderDelivery` (the `{(item.items && item.items.length > 0) && (...)}` block). Add local state for which card's items are expanded (a single `expandedItemsId` at component scope is enough — only one card is likely to be expanded at a time in practice, and this matches the simplicity of the existing `assignModalVisible`-style single-item state elsewhere in this file):
```js
const [expandedItemsId, setExpandedItemsId] = useState(null);
```
Replace the always-rendered item block with:
```jsx
{(item.items && item.items.length > 0) && (
  <TouchableOpacity
    onPress={(e) => { e.stopPropagation(); setExpandedItemsId((id) => (id === item.id ? null : item.id)); }}
    style={{ marginHorizontal: Spacing.md, marginTop: 8 }}
  >
    <Text style={{ fontSize: FontSize.sm, color: Colors.primary, fontWeight: '600' }}>
      {expandedItemsId === item.id ? '▾' : '▸'} {item.items.length} item{item.items.length !== 1 ? 's' : ''}
    </Text>
    {expandedItemsId === item.id && (
      <View style={{ marginTop: 8, backgroundColor: Colors.background, padding: 8, borderRadius: 6 }}>
        {item.items.map((it, idx) => (
          <View key={idx} style={{ marginBottom: idx === item.items.length - 1 ? 0 : 4 }}>
            <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary }}>{it.quantity}x {it.product_name}</Text>
            {it.item_special_instructions ? (
              <Text style={{ fontSize: FontSize.xs, color: '#F57C00', marginLeft: 8, fontWeight: '500' }}>* {it.item_special_instructions}</Text>
            ) : null}
          </View>
        ))}
      </View>
    )}
  </TouchableOpacity>
)}
```

- [ ] **Step 4: Add `ContactButtons` for customer and rider, and the safe-action row**

In `renderDelivery`, after the existing `cardFooter` block (COD badge / Assign button), add a new block computing the safe action and rendering `ContactButtons`:
```js
const saleShaped = toSaleShape(item);
const nextAction = saleShaped.display_stage?.nextAction;
const needsPreparerPick = nextAction?.body?.status === 'preparing'
  && item.has_unassigned_open_task && user?.role !== 'employee';
const needsCodCollect = nextAction?.endpoint?.endsWith('/deliver')
  && (Number(item.cod_amount || 0) - Number(item.cod_collected || 0)) > 0.01;
const selfAssign = nextAction?.body?.status === 'preparing'
  && item.has_unassigned_open_task && user?.role === 'employee' && user?.id != null
  ? { assigned_to: user.id } : undefined;
const deadEnd = !nextAction ? resolveDeadEnd(saleShaped, canManageDeliveries, canTakeMoney) : null;
const isAdvancing = advancingId === item.id;

const handleAdvance = async () => {
  if (advancingId) return;
  setAdvancingId(item.id);
  try {
    await api.advanceOrder(nextAction, selfAssign);
    list.refresh();
  } catch (err) {
    showAlert('Could not update this order', err?.message || 'Please try again, or open the order to see what it needs.');
  } finally {
    setAdvancingId(null);
  }
};
const handlePress = () => {
  if (needsPreparerPick) { openPreparerPicker(item); return; }
  if (needsCodCollect) { setCodCollectOrder(saleShaped); return; }
  handleAdvance();
};
const handleDeadEndPress = () => {
  if (!deadEnd || deadEnd.type !== 'route') return;
  if (deadEnd.kind === 'assign_rider') { openAssignModal(item); return; }
  if (deadEnd.kind === 'finish_tasks') { setTaskCompletionOrder(saleShaped); return; }
  if (deadEnd.kind === 'reattempt_delivery') { navigation.navigate('DeliveryDetail', { deliveryId: item.id }); return; }
  if (deadEnd.kind === 'collect_payment') {
    const due = Number(item.grand_total || 0) - Number(item.total_paid || 0);
    navigation.navigate('AddPayment', { saleId: item.sale_id, due });
    return;
  }
  if (deadEnd.kind === 'record_cod') { navigation.navigate('Settlements'); }
};
```
(`openPreparerPicker` is added in this task too — see Step 5. For now, call the existing `openAssignModal(item)` here exactly as today's `cardFooter` Assign button already does elsewhere in this file — it still works as-is at this point in the plan. Task 7 deletes `openAssignModal` entirely and replaces it with `openRiderPickerFor(new Set([item.id]))`; that task's own Step 1 explicitly updates this call site when it does. Do not "pre-rename" this call in Task 6 — keep it exactly as `openAssignModal(item)` so Task 6 stays independently correct and testable before Task 7 runs.)

Render, replacing the existing bare `cardFooter` COD-badge/Assign-button block's `Assign` button specifically (leave the COD badge display itself untouched) with the safe-action button plus `ContactButtons`, in a new row below `cardFooter`:
```jsx
<View style={styles.actionsRow}>
  {nextAction ? (
    <TouchableOpacity
      style={[styles.actionBtn, isAdvancing && styles.actionBtnDisabled]}
      onPress={(e) => { e.stopPropagation(); handlePress(); }}
      disabled={isAdvancing}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
    >
      {isAdvancing ? <ActivityIndicator size="small" color={Colors.white} /> : <Text style={styles.actionBtnText}>{nextAction.label || 'Next step'}</Text>}
    </TouchableOpacity>
  ) : deadEnd?.type === 'route' ? (
    <TouchableOpacity style={styles.deadEndBtn} onPress={(e) => { e.stopPropagation(); handleDeadEndPress(); }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
      <Text style={styles.deadEndBtnText}>{deadEnd.label}</Text>
    </TouchableOpacity>
  ) : deadEnd?.type === 'status' ? (
    <Text style={styles.deadEndStatus}>{deadEnd.text}</Text>
  ) : <View style={{ flex: 1 }} />}
  <ContactButtons
    contacts={[
      { label: 'Customer', phone: item.customer_phone },
      { label: 'Rider', phone: item.partner_phone },
    ]}
    context={{
      type: item.status === 'in_transit' ? 'order_out_for_delivery' : 'general_inquiry',
      params: { sale_number: item.sale_number, location_name: item.location_name },
    }}
  />
</View>
```
Remove the now-redundant existing `canManageDeliveries && item.status === 'pending' && (<TouchableOpacity ... Assign ...>)` block from `cardFooter` — the safe-action row above covers this via `resolveDeadEnd`'s own `assign_rider` case (which already handles the `status === 'pending'` / no-rider-yet condition, among the other cases `resolveDeadEnd` covers that the old bare "Assign" button didn't — failed/cancelled deliveries needing reassignment).

- [ ] **Step 5: Add the preparer-picker (copy from `OrdersInboxScreen.js`, do not re-derive)**

`OrdersInboxScreen.js` already has a complete, tested `openPreparerPicker`/`closePreparerPicker`/`handlePickPreparer`/`handleLeavePreparerForNow` implementation plus its `<AssignPickerModal>` render (search that file for `preparerPicker` to find all of it — the state declaration, all four functions, and the JSX block). Copy all of it into `DeliveriesScreen.js` verbatim, with these substitutions: `list.refresh()` stays `list.refresh()` (same hook, same call); `PREP_ROLES`/`STAFF_ROLE_LABELS` need the same import added (`import { PREP_ROLES, STAFF_ROLE_LABELS } from '../constants/orderDisplay';`); `showAlert`/`api` are already imported in this file.

Add the `<AssignPickerModal>` JSX (the preparer one, title "Who is making this?") near this screen's other modals.

- [ ] **Step 6: Add `CollectCodModal` and `TaskCompletionModal`**

```jsx
<CollectCodModal
  visible={codCollectOrder !== null}
  order={codCollectOrder}
  onClose={() => setCodCollectOrder(null)}
  onDone={() => { setCodCollectOrder(null); list.refresh(); }}
/>
<TaskCompletionModal
  visible={taskCompletionOrder !== null}
  order={taskCompletionOrder}
  onClose={() => setTaskCompletionOrder(null)}
  onDone={() => list.refresh()}
/>
```
Add imports: `import CollectCodModal from '../components/orderBoard/CollectCodModal'; import TaskCompletionModal from '../components/orderBoard/TaskCompletionModal';`.

- [ ] **Step 7: Babel-check**

Run: `node app/scripts/babel-check.js app/src/screens/DeliveriesScreen.js`

- [ ] **Step 8: Manual smoke check — safety-critical, do not skip**

Find or create a COD delivery with a task still unassigned and status 'pending' — confirm the card shows "Start Preparing" with NO blind fire (tap it, confirm the preparer picker opens rather than immediately advancing). Find or create an out-for-delivery order with COD outstanding — confirm "Mark Delivered" opens `CollectCodModal` pre-filled with the right amount, not a blind fire. Find a 'ready' delivery with no rider assigned — confirm "Assign Rider" appears and opens the (still Task-7-unconsolidated, still-custom-for-now) assign modal correctly. Confirm `ContactButtons` calls the customer and the rider correctly (different phone numbers, if the test data has both).

- [ ] **Step 9: Commit**

```bash
git add app/src/screens/DeliveriesScreen.js
git commit -m "Add safe inline actions and ContactButtons to Deliveries cards"
```

---

### Task 7: Consolidate the custom assign modal into `AssignPickerModal` (single + batch)

**Files:**
- Modify: `app/src/screens/DeliveriesScreen.js`

**Interfaces:**
- Consumes: `AssignPickerModal({ visible, title, notice, people, loading, onPick, onClose, footer })` (existing).

- [ ] **Step 1: Replace `assignModalVisible`/`selectedDelivery`/`partners`-driven custom modal with `AssignPickerModal`**

The existing `openAssignModal(delivery)` and `openBatchAssignModal(idsOverride)` functions both already fetch partners via `api.getDeliveryPartners(selectedLocation)` and set `partners`/`assignModalVisible`/`selectedDelivery`. Restructure them to populate a single new picker state instead, matching the shape `AssignPickerModal` + this screen's `handleAssign` already expect:

```js
const [riderPicker, setRiderPicker] = useState(null); // { deliveryIds: Set, loading, showingEveryone, people }
const riderReqRef = useRef(0);

const openRiderPickerFor = useCallback(async (deliveryIds) => {
  const reqId = ++riderReqRef.current;
  setRiderPicker({ deliveryIds, loading: true, people: [] });
  try {
    const res = await api.getDeliveryPartners(selectedLocation);
    let people = res.data?.users || res.data || [];
    if (!Array.isArray(people)) people = [];
    let showingEveryone = false;
    if (people.length === 0 && selectedLocation) {
      const all = await api.getDeliveryPartners();
      const allList = all.data?.users || all.data || [];
      if (Array.isArray(allList) && allList.length > 0) { people = allList; showingEveryone = true; }
    }
    if (riderReqRef.current !== reqId) return;
    setRiderPicker({
      deliveryIds, loading: false, showingEveryone,
      people: people.map((p) => ({ id: p.id, name: p.name, meta: `${p.active_delivery_count || 0} stop${Number(p.active_delivery_count) !== 1 ? 's' : ''} today` })),
    });
  } catch (err) {
    if (riderReqRef.current !== reqId) return;
    setRiderPicker(null);
    showAlert('Riders', err?.message || 'Could not load the rider list. Please try again.');
  }
}, [selectedLocation]);

const closeRiderPicker = useCallback(() => { riderReqRef.current += 1; setRiderPicker(null); }, []);

const handlePickRiderConsolidated = useCallback(async (person) => {
  const picker = riderPicker;
  if (!picker || picker.loading) return;
  const reqId = ++riderReqRef.current;
  setRiderPicker((prev) => (prev ? { ...prev, loading: true } : prev));
  try {
    if (picker.deliveryIds.size > 1) {
      const res = await api.batchAssignDeliveries({ delivery_ids: Array.from(picker.deliveryIds), delivery_partner_id: person.id });
      showAlert('Success', res.message || `Assigned ${picker.deliveryIds.size} deliveries`);
    } else {
      await api.assignDelivery(Array.from(picker.deliveryIds)[0], { delivery_partner_id: person.id });
    }
    if (riderReqRef.current === reqId) setRiderPicker(null);
    setBatchMode(false);
    setSelectedIds(new Set());
    list.refresh();
  } catch (err) {
    if (riderReqRef.current !== reqId) return;
    setRiderPicker(null);
    showAlert('Error', err?.message || 'Failed to assign');
  }
}, [riderPicker, list.refresh]);
```

Replace `openAssignModal(delivery)` calls (Task 6's `handleDeadEndPress`'s `assign_rider` case, and the `cardFooter`'s old Assign button already removed in Task 6) — actually already routed correctly in Task 6 via `openAssignModal(item)`; change that call site to `openRiderPickerFor(new Set([item.id]))` instead now that this task exists. Replace `openBatchAssignModal(idsOverride)`'s body (used by both the batch-bar "Assign All" button and `selectAllInRoute`) to call `openRiderPickerFor(idsOverride && idsOverride.size > 0 ? idsOverride : selectedIds)` after the existing empty-selection guard (`if (ids.size === 0) { ...; return; }` stays unchanged — only the partner-fetch/modal-open tail changes).

Delete `openAssignModal`, `handleAssign`, the old `assignModalVisible`/`selectedDelivery`/`partners`-driven `<Modal>` JSX block (the whole `partnerItem`-mapping modal at the bottom of the file) — all superseded by the above. Keep `partners` state itself (still used by Task 4's `FilterDrawer` rider-filter section).

- [ ] **Step 2: Render `AssignPickerModal`**

```jsx
<AssignPickerModal
  visible={riderPicker !== null}
  title={riderPicker?.deliveryIds?.size > 1 ? `Assign ${riderPicker.deliveryIds.size} Deliveries` : 'Assign Delivery Partner'}
  notice={
    riderPicker?.loading ? null
      : riderPicker?.showingEveryone
        ? 'No delivery partners set up at this location — showing everyone.'
        : (riderPicker?.people || []).length === 0
          ? 'No delivery partners found. Add staff with the "delivery_partner" role.'
          : null
  }
  people={riderPicker?.people || []}
  loading={!!riderPicker?.loading}
  onPick={handlePickRiderConsolidated}
  onClose={closeRiderPicker}
/>
```
Add the import if not already present from Task 6: `import AssignPickerModal from '../components/orderBoard/AssignPickerModal';`.

- [ ] **Step 3: Babel-check**

Run: `node app/scripts/babel-check.js app/src/screens/DeliveriesScreen.js`

- [ ] **Step 4: Manual smoke check**

Confirm single-delivery Assign (from the safe-action row) opens the picker, shows real riders with their "N stops today" meta, and assigning writes correctly. Confirm batch mode (long-press a card, or "select all in this route") opens the SAME picker with the right title ("Assign N Deliveries"), and confirms assignment lands on every selected delivery via `api.batchAssignDeliveries`.

- [ ] **Step 5: Commit**

```bash
git add app/src/screens/DeliveriesScreen.js
git commit -m "Consolidate Deliveries' custom assign modal into shared AssignPickerModal"
```

---

### Task 8: Full regression + live manual trace

**Files:** none (verification only)

- [ ] **Step 1: Run every regression script**

```bash
node server/scripts/verify-order-flows.js   # (with VERIFY_OWNER_PHONE/PASSWORD set)
node server/scripts/verify-register-expenses.js
node server/scripts/verify-identity-roles.js
node app/scripts/babel-check.js app/src/screens/DeliveriesScreen.js app/src/hooks/useAtRiskIds.js
```
All must pass clean before continuing.

- [ ] **Step 2: Live trace — management account (owner/manager/counter_staff)**

Open Deliveries. Confirm, in order: (a) Route/Date/Rider view switching all work with real collapse/expand; (b) at-risk lead section appears correctly in Route view and disappears entirely under "Urgent first" sort; (c) Status chip row still one-tap; (d) Filters drawer's Location/Rider/Date range all filter correctly and show removable chips; (e) search still filters; (f) item-list "N items ▸" disclosure expands/collapses; (g) a safe next-action fires directly; (h) a COD-outstanding delivery's "Mark Delivered" opens the collect form, never fires blind; (i) a pending order with an unassigned task opens the preparer picker, never fires blind; (j) "Assign Rider" (single and via "select all in this route" batch) both open the same picker and correctly write the assignment; (k) Call/WhatsApp buttons reach the customer and the rider correctly; (l) load more/pagination still works if the location has 50+ matching deliveries.

- [ ] **Step 3: Live trace — delivery_partner account**

Confirm their simplified Date-only view (no view-mode toggle, no batch tools) still works exactly as before, and that their own deliveries' safe actions (Mark Picked Up, Mark Delivered) behave correctly.

- [ ] **Step 4: Final commit (if Steps 1-3 required any fix-up)**

If any check required a fix, commit it with a message describing exactly what regression check or trace step caught it. If everything passed on the first attempt, there's nothing to commit for this task.
