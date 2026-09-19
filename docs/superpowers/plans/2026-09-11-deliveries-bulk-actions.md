# Deliveries Bulk Actions (Assign Rider + Assign Route) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `DeliveriesScreen.js`'s single-purpose "select → immediately opens Assign Rider" batch flow with a two-button choice (Assign Rider / Assign Route), and build genuinely new backend capability for the second button — no endpoint exists today to change a delivery's route after order creation.

**Architecture:** Assign Rider reuses Task 7's already-built `AssignPickerModal`/`openRiderPickerFor` verbatim — only its entry point changes (a dedicated batch-bar button instead of an auto-opened modal). Assign Route is new end to end: two backend endpoints mirroring the existing `/:id/assign` + `/batch-assign` pattern, and a new `RouteAssignModal` component wrapping the already-existing `RoutePicker` (reused as-is, no changes to it).

**Tech Stack:** Express.js + `pg` (two additive endpoints, no schema change — `deliveries.route_id` already exists); Expo/React Native, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-11-deliveries-bulk-actions-design.md`.

## Global Constraints

- Every derived/summary value is computed fresh on read, never stored (CLAUDE.md) — the overwrite-warning count in Task 3 is computed fresh from `filteredDeliveries` on every render, never cached.
- Minimum 44×44pt tap targets on every touchable (staff-ux-checklist #7).
- User-visible errors are plain language via `showAlert` (`app/src/utils/alert.js`), never raw `Alert.alert` or a technical message.
- No schema changes — `deliveries.route_id` and `delivery_routes` already exist; this plan only adds two routes and one new UPDATE statement shape.
- This codebase has no screen-render test harness. Verification per task is `node app/scripts/babel-check.js <file>`, a full 3-suite backend regression where backend code changes, and a live manual trace as the final task.

---

### Task 1: Backend — `PUT /deliveries/:id/route` + `POST /deliveries/batch-assign-route`

**Files:**
- Modify: `server/routes/deliveries.js` (add both routes near the existing `/:id/assign` (~line 527) and `/batch-assign` (~line 370) routes, same file, same neighborhood)
- Test: `server/scripts/verify-order-flows.js` (add checks)

**Interfaces:**
- Produces: `PUT /deliveries/:id/route` — body `{ route_id: number|null }`, response `{ success: true, data: <delivery row with route_name joined> }` on success, or `{ success: false, message }` with 400/404 on error. `POST /deliveries/batch-assign-route` — body `{ delivery_ids: number[], route_id: number|null }`, response `{ success: true, message, data: { assigned: number, skipped: number } }`.

- [ ] **Step 1: Write the failing tests**

In `server/scripts/verify-order-flows.js`, find the existing `has_unassigned_open_task`/search checks for `GET /deliveries` (search for `NEW: GET /deliveries` to find the neighborhood) and add these four new checks directly after them, reusing `createdSaleIds`/`TEST_LOCATION_ID`/`loginOwner`/`api`/`check`/`assert`/`getDb` already in scope in this file:

```js
check('NEW: PUT /deliveries/:id/route assigns, reassigns, and clears a delivery route (2026-09-11 — bulk actions)', async () => {
  const owner = await loginOwner();
  const createRes = await api('POST', '/sales', owner.token, {
    location_id: TEST_LOCATION_ID, order_type: 'delivery', channel: 'phone',
    customer_name: `RouteAssignSingleCheck${Date.now()}`,
    delivery_address: '789 Route St', receiver_name: 'Test Receiver', receiver_phone: '9995554444',
    items: [{ quantity: 1, unit_price: 100, product_name: 'Test Route Item' }],
  });
  assert(createRes.status === 201, `Expected sale creation to succeed, got ${createRes.status}: ${JSON.stringify(createRes.body)}`);
  const saleId = createRes.body.data.id;
  createdSaleIds.push(saleId);

  const db = await getDb();
  const delivery = await db.prepare('SELECT id FROM deliveries WHERE sale_id = ?').get(saleId);
  assert(delivery, `Expected a deliveries row for sale ${saleId}`);

  const routeAName = `Test Route A ${Date.now()}`;
  const routeARes = await api('POST', '/delivery-routes', owner.token, { name: routeAName, location_id: TEST_LOCATION_ID });
  assert(routeARes.status === 201 || routeARes.status === 200, `Expected route creation to succeed, got ${routeARes.status}: ${JSON.stringify(routeARes.body)}`);
  const routeAId = routeARes.body.data.id;

  const assignRes = await api('PUT', `/deliveries/${delivery.id}/route`, owner.token, { route_id: routeAId });
  assert(assignRes.status === 200, `Expected 200, got ${assignRes.status}: ${JSON.stringify(assignRes.body)}`);
  assert(assignRes.body.data.route_id === routeAId, `Expected route_id ${routeAId}, got ${assignRes.body.data.route_id}`);
  assert(assignRes.body.data.route_name === routeAName, `Expected route_name ${routeAName}, got ${assignRes.body.data.route_name}`);

  const routeBName = `Test Route B ${Date.now()}`;
  const routeBRes = await api('POST', '/delivery-routes', owner.token, { name: routeBName, location_id: TEST_LOCATION_ID });
  const routeBId = routeBRes.body.data.id;
  const reassignRes = await api('PUT', `/deliveries/${delivery.id}/route`, owner.token, { route_id: routeBId });
  assert(reassignRes.status === 200, `Expected reassign to succeed, got ${reassignRes.status}: ${JSON.stringify(reassignRes.body)}`);
  assert(reassignRes.body.data.route_id === routeBId, `Expected overwrite to route_id ${routeBId}, got ${reassignRes.body.data.route_id}`);

  const clearRes = await api('PUT', `/deliveries/${delivery.id}/route`, owner.token, { route_id: null });
  assert(clearRes.status === 200, `Expected clear to succeed, got ${clearRes.status}: ${JSON.stringify(clearRes.body)}`);
  assert(clearRes.body.data.route_id === null, `Expected route_id null after clear, got ${JSON.stringify(clearRes.body.data.route_id)}`);

  const missingKeyRes = await api('PUT', `/deliveries/${delivery.id}/route`, owner.token, {});
  assert(missingKeyRes.status === 400, `Expected 400 when route_id key is missing entirely, got ${missingKeyRes.status}`);

  const badRouteRes = await api('PUT', `/deliveries/${delivery.id}/route`, owner.token, { route_id: 999999999 });
  assert(badRouteRes.status === 404, `Expected 404 for a nonexistent route_id, got ${badRouteRes.status}`);
});

check('NEW: PUT /deliveries/:id/route refuses a delivered or cancelled delivery (2026-09-11 — bulk actions)', async () => {
  const owner = await loginOwner();
  const createRes = await api('POST', '/sales', owner.token, {
    location_id: TEST_LOCATION_ID, order_type: 'delivery', channel: 'phone',
    customer_name: `RouteAssignCancelledCheck${Date.now()}`,
    delivery_address: '321 Cancelled St', receiver_name: 'Test Receiver', receiver_phone: '9994443333',
    items: [{ quantity: 1, unit_price: 100, product_name: 'Test Cancelled Item' }],
  });
  assert(createRes.status === 201, `Expected sale creation to succeed, got ${createRes.status}: ${JSON.stringify(createRes.body)}`);
  const saleId = createRes.body.data.id;
  createdSaleIds.push(saleId);

  const db = await getDb();
  const delivery = await db.prepare('SELECT id FROM deliveries WHERE sale_id = ?').get(saleId);
  await db.prepare("UPDATE deliveries SET status = 'cancelled' WHERE id = ?").run(delivery.id);

  const res = await api('PUT', `/deliveries/${delivery.id}/route`, owner.token, { route_id: null });
  assert(res.status === 400, `Expected 400 for a cancelled delivery, got ${res.status}: ${JSON.stringify(res.body)}`);
});

check('NEW: POST /deliveries/batch-assign-route assigns to multiple deliveries and skips terminal ones (2026-09-11 — bulk actions)', async () => {
  const owner = await loginOwner();
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const createRes = await api('POST', '/sales', owner.token, {
      location_id: TEST_LOCATION_ID, order_type: 'delivery', channel: 'phone',
      customer_name: `RouteAssignBatchCheck${Date.now()}_${i}`,
      delivery_address: `${i} Batch Route St`, receiver_name: 'Test Receiver', receiver_phone: '9993332222',
      items: [{ quantity: 1, unit_price: 100, product_name: 'Test Batch Route Item' }],
    });
    assert(createRes.status === 201, `Expected sale ${i} creation to succeed, got ${createRes.status}: ${JSON.stringify(createRes.body)}`);
    createdSaleIds.push(createRes.body.data.id);
    const db = await getDb();
    const delivery = await db.prepare('SELECT id FROM deliveries WHERE sale_id = ?').get(createRes.body.data.id);
    ids.push(delivery.id);
  }
  // Mark the third one delivered so it must be skipped, not assigned.
  const db = await getDb();
  await db.prepare("UPDATE deliveries SET status = 'delivered' WHERE id = ?").run(ids[2]);

  const routeRes = await api('POST', '/delivery-routes', owner.token, { name: `Test Batch Route ${Date.now()}`, location_id: TEST_LOCATION_ID });
  const routeId = routeRes.body.data.id;

  const batchRes = await api('POST', '/deliveries/batch-assign-route', owner.token, { delivery_ids: ids, route_id: routeId });
  assert(batchRes.status === 200, `Expected 200, got ${batchRes.status}: ${JSON.stringify(batchRes.body)}`);
  assert(batchRes.body.data.assigned === 2, `Expected 2 assigned (first two, both non-terminal), got ${batchRes.body.data.assigned}`);
  assert(batchRes.body.data.skipped === 1, `Expected 1 skipped (the delivered one), got ${batchRes.body.data.skipped}`);

  const first = await db.prepare('SELECT route_id FROM deliveries WHERE id = ?').get(ids[0]);
  assert(first.route_id === routeId, `Expected first delivery's route_id to be ${routeId}, got ${first.route_id}`);
  const third = await db.prepare('SELECT route_id FROM deliveries WHERE id = ?').get(ids[2]);
  assert(third.route_id === null, `Expected the delivered (skipped) delivery to keep route_id null, got ${third.route_id}`);
});

check('NEW: POST /deliveries/batch-assign-route requires delivery_ids and route_id key (2026-09-11 — bulk actions)', async () => {
  const owner = await loginOwner();
  const noIdsRes = await api('POST', '/deliveries/batch-assign-route', owner.token, { route_id: null });
  assert(noIdsRes.status === 400, `Expected 400 with no delivery_ids, got ${noIdsRes.status}`);

  const noRouteKeyRes = await api('POST', '/deliveries/batch-assign-route', owner.token, { delivery_ids: [1] });
  assert(noRouteKeyRes.status === 400, `Expected 400 when route_id key is missing entirely, got ${noRouteKeyRes.status}`);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `VERIFY_OWNER_PHONE=9876453210 VERIFY_OWNER_PASSWORD=naman1234 node server/scripts/verify-order-flows.js`
Expected: all four new checks fail — the routes don't exist yet (404/wrong-shape responses).

- [ ] **Step 3: Write the implementation**

In `server/routes/deliveries.js`, find the existing `router.put('/:id(\\d+)/assign', ...)` route (~line 527). Add this new route directly after it (same file, same auth/validation idioms — `authorize`, `validationResult`/`body` are already imported and used by the neighboring route, confirm the exact import names at the top of this file before writing):

```js
// ─── PUT /api/deliveries/:id/route ───────────────────────────
// Assign, reassign, or clear a delivery's route tag — a manual dispatch
// grouping label (delivery_routes), not a routing/stop-sequencing feature.
// Mirrors /:id/assign's exact validation shape. Unlike rider assignment,
// route assignment is not status-sensitive except at the two terminal
// states — a route tag stays meaningful through picked_up/in_transit.
router.put(
  '/:id(\\d+)/route',
  authenticate,
  authorize('owner', 'manager', 'counter_staff'),
  (req, res, next) => {
    try {
      if (!('route_id' in req.body)) {
        return res.status(400).json({ success: false, message: 'route_id is required (pass null to clear).' });
      }
      const { route_id } = req.body;
      if (route_id != null && !Number.isInteger(route_id)) {
        return res.status(400).json({ success: false, message: 'route_id must be an integer or null.' });
      }

      const db = getDb();
      const delivery = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(req.params.id);
      if (!delivery) return res.status(404).json({ success: false, message: 'Delivery not found' });
      if (['delivered', 'cancelled'].includes(delivery.status)) {
        return res.status(400).json({ success: false, message: `Cannot assign a route to a delivery in ${delivery.status} status` });
      }

      if (route_id != null) {
        const route = db.prepare('SELECT id FROM delivery_routes WHERE id = ?').get(route_id);
        if (!route) return res.status(404).json({ success: false, message: 'Route not found' });
      }

      db.prepare('UPDATE deliveries SET route_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(route_id, delivery.id);

      const updated = db.prepare(`
        SELECT d.*, r.name as route_name FROM deliveries d
        LEFT JOIN delivery_routes r ON r.id = d.route_id WHERE d.id = ?
      `).get(delivery.id);

      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  }
);
```

Now find the existing `router.post('/batch-assign', ...)` route (~line 370). Add this new route directly after it:

```js
// ─── POST /api/deliveries/batch-assign-route ─────────────────
// Bulk route assignment — mirrors /batch-assign's exact per-id
// WHERE-filtered UPDATE + affected-row counting pattern. Excludes only
// the two terminal statuses (a route tag on a finished/cancelled delivery
// is meaningless); every other status is eligible, wider than
// /batch-assign's rider allow-list since a route tag stays meaningful
// through picked_up/in_transit.
router.post(
  '/batch-assign-route',
  authenticate,
  authorize('owner', 'manager', 'counter_staff'),
  (req, res, next) => {
    try {
      const { delivery_ids } = req.body;
      if (!Array.isArray(delivery_ids) || delivery_ids.length === 0) {
        return res.status(400).json({ success: false, message: 'delivery_ids array required.' });
      }
      if (!('route_id' in req.body)) {
        return res.status(400).json({ success: false, message: 'route_id is required (pass null to clear).' });
      }
      const { route_id } = req.body;
      if (route_id != null && !Number.isInteger(route_id)) {
        return res.status(400).json({ success: false, message: 'route_id must be an integer or null.' });
      }

      const db = getDb();
      if (route_id != null) {
        const route = db.prepare('SELECT id FROM delivery_routes WHERE id = ?').get(route_id);
        if (!route) return res.status(404).json({ success: false, message: 'Route not found.' });
      }

      let assigned = 0;
      let skipped = 0;

      const assignStmt = db.prepare(`
        UPDATE deliveries SET route_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status NOT IN ('delivered', 'cancelled')
      `);

      const assignAll = db.transaction(() => {
        for (const id of delivery_ids) {
          const result = assignStmt.run(route_id, Number(id));
          if (result.changes > 0) assigned++;
          else skipped++;
        }
      });

      assignAll();

      res.json({
        success: true,
        message: `Assigned route to ${assigned} deliver${assigned === 1 ? 'y' : 'ies'}.${skipped > 0 ? ` ${skipped} skipped (delivered/cancelled).` : ''}`,
        data: { assigned, skipped },
      });
    } catch (err) { next(err); }
  }
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run the same command as Step 2. Expected: all four new checks pass, plus every pre-existing check still passes (full suite clean).

- [ ] **Step 5: Commit**

```bash
git add server/routes/deliveries.js server/scripts/verify-order-flows.js
git commit -m "Add PUT /deliveries/:id/route and POST /deliveries/batch-assign-route"
```

---

### Task 2: `api.js` additions + new `RouteAssignModal` component

**Files:**
- Modify: `app/src/services/api.js`
- Create: `app/src/components/orderBoard/RouteAssignModal.js`

**Interfaces:**
- Consumes: `RoutePicker` (`app/src/components/RoutePicker.js`, existing, unmodified — `<RoutePicker value={routeId} onChange={setRouteId} locationId={locationId} />`).
- Produces: `api.assignDeliveryRoute(deliveryId, { route_id })`, `api.batchAssignRoute({ delivery_ids, route_id })` (Task 1's two endpoints). `RouteAssignModal({ visible, deliveryCount, routeId, onChangeRoute, warning, locationId, confirming, onConfirm, onClose })` — a fully controlled component (the screen owns `routeId` and `warning`; this component only renders `RoutePicker` + a confirm button). Task 3 is the only consumer.

- [ ] **Step 1: Add the two `api.js` methods**

In `app/src/services/api.js`, find `batchAssignDeliveries(data) { ... }` (search for it — sits right after `assignDelivery`). Add these two new methods directly after it:

```js
  assignDeliveryRoute(deliveryId, data) {
    return this.request(`/deliveries/${deliveryId}/route`, { method: 'PUT', body: JSON.stringify(data) });
  }

  batchAssignRoute(data) {
    return this.request('/deliveries/batch-assign-route', { method: 'POST', body: JSON.stringify(data) });
  }
```

- [ ] **Step 2: Create `RouteAssignModal.js`**

Create `app/src/components/orderBoard/RouteAssignModal.js`:

```js
import React from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { Colors } from '../../constants/theme';
import { FONT_FAMILY } from '../../constants/orderDisplay';
import RoutePicker from '../RoutePicker';

/**
 * Bulk route (re)assignment — the Assign Route counterpart to
 * AssignPickerModal's Assign Rider flow (same screen, same batch-select
 * mechanism, see docs/superpowers/specs/2026-09-11-deliveries-bulk-actions-
 * design.md). Fully controlled: the screen owns `routeId` and `warning`
 * (the overwrite check needs the current selection's own route_id values,
 * which live in the screen's data, not in here) — this component only
 * renders RoutePicker plus a confirm button.
 */
export default function RouteAssignModal({ visible, deliveryCount, routeId, onChangeRoute, warning, locationId, confirming, onConfirm, onClose }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.title}>
            {deliveryCount > 1 ? `Assign Route — ${deliveryCount} Deliveries` : 'Assign Route'}
          </Text>
          {warning ? <Text style={styles.notice}>{warning}</Text> : null}
          <RoutePicker value={routeId} onChange={onChangeRoute} locationId={locationId} />
          <TouchableOpacity
            style={[styles.confirm, (!routeId || confirming) && styles.confirmDisabled]}
            onPress={onConfirm}
            disabled={!routeId || confirming}
            activeOpacity={0.7}
          >
            {confirming
              ? <ActivityIndicator color="#fff" size="small" />
              : <Text style={styles.confirmText}>{`Apply to ${deliveryCount} deliver${deliveryCount === 1 ? 'y' : 'ies'}`}</Text>}
          </TouchableOpacity>
          <TouchableOpacity style={styles.cancel} onPress={onClose} activeOpacity={0.7}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#00000055', justifyContent: 'center', padding: 20 },
  sheet: { backgroundColor: '#FFFFFF', borderRadius: 16, padding: 16, maxWidth: 420, width: '100%', alignSelf: 'center' },
  title: { fontSize: 17, fontWeight: '800', color: Colors.text, fontFamily: FONT_FAMILY, marginBottom: 10 },
  notice: { fontSize: 13, lineHeight: 18, color: '#92400E', backgroundColor: Colors.warningLight, fontFamily: FONT_FAMILY, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, marginBottom: 10 },
  confirm: { minHeight: 44, backgroundColor: Colors.primary, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginTop: 12 },
  confirmDisabled: { backgroundColor: Colors.border },
  confirmText: { fontSize: 15, fontWeight: '700', color: '#fff', fontFamily: FONT_FAMILY },
  cancel: { minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  cancelText: { fontSize: 15, fontWeight: '700', color: Colors.textSecondary, fontFamily: FONT_FAMILY },
});
```

- [ ] **Step 3: Babel-check**

Run: `node app/scripts/babel-check.js app/src/components/orderBoard/RouteAssignModal.js app/src/services/api.js`

- [ ] **Step 4: Commit**

```bash
git add app/src/services/api.js app/src/components/orderBoard/RouteAssignModal.js
git commit -m "Add assignDeliveryRoute/batchAssignRoute API methods and RouteAssignModal component"
```

---

### Task 3: `DeliveriesScreen.js` — wire the two-button batch bar

**Files:**
- Modify: `app/src/screens/DeliveriesScreen.js`

**Interfaces:**
- Consumes: `RouteAssignModal` (Task 2), `api.assignDeliveryRoute`/`api.batchAssignRoute` (Task 2), `openRiderPickerFor` (existing, Task 7 of the prior redesign — unchanged, just given a new direct call site).

- [ ] **Step 1: Add the import**

Near the other `orderBoard` imports (e.g. `import AssignPickerModal from '../components/orderBoard/AssignPickerModal';`), add:
```js
import RouteAssignModal from '../components/orderBoard/RouteAssignModal';
```

- [ ] **Step 2: Rename `openBatchAssignModal` to stop auto-opening the rider picker**

Find `openBatchAssignModal` (search for it — currently sets batch mode/selection then calls `openRiderPickerFor(ids)`). Replace it with a narrower version that only enters batch mode with a given selection, renamed `selectForBatch` (its only remaining job — the batch bar's own buttons below now open each picker directly):

```js
// Enters batch mode with a specific id set — used by "select all in this
// route" and (indirectly) long-press. Deliberately does NOT open any
// picker itself: since this screen now has two bulk actions (Assign
// Rider / Assign Route), opening one automatically would silently pick
// for the user. The batch bar's own two buttons open the right picker
// once the user chooses.
const selectForBatch = (idsOverride) => {
  const ids = idsOverride && idsOverride.size > 0 ? idsOverride : selectedIds;
  if (ids.size === 0) {
    showAlert('Info', 'Select at least one delivery');
    return;
  }
  setBatchMode(true);
  setSelectedIds(ids);
};
```

Find `selectAllInRoute` (search for it) and change its call from `openBatchAssignModal(ids);` to `selectForBatch(ids);` — no other change to that function.

- [ ] **Step 3: Add Assign Route state and handlers**

Near the existing `riderPicker`/`riderReqRef` declarations, add:

```js
  // Assign Route — the Assign Rider counterpart. Fully controlled (see
  // RouteAssignModal.js's own header comment for why): this screen owns
  // routeId and computes the overwrite warning fresh from filteredDeliveries
  // on every render, never stored (CLAUDE.md's "derived values computed
  // fresh" rule).
  const [routeAssignPicker, setRouteAssignPicker] = useState(null); // { deliveryIds: Set } | null
  const [routeAssignRouteId, setRouteAssignRouteId] = useState(null);
  const [routeAssignConfirming, setRouteAssignConfirming] = useState(false);

  const openRouteAssignModal = (deliveryIds) => {
    setRouteAssignRouteId(null);
    setRouteAssignPicker({ deliveryIds });
  };

  const closeRouteAssignModal = () => {
    setRouteAssignPicker(null);
    setRouteAssignRouteId(null);
  };

  // How many of the currently-targeted deliveries already carry a
  // DIFFERENT route than the one about to be applied. Zero (no warning)
  // until the user has actually picked a route to apply.
  const routeAssignOverwriteCount = (routeAssignPicker && routeAssignRouteId)
    ? filteredDeliveries.filter((d) => routeAssignPicker.deliveryIds.has(d.id) && d.route_id != null && d.route_id !== routeAssignRouteId).length
    : 0;

  const routeAssignWarning = routeAssignOverwriteCount > 0
    ? `${routeAssignOverwriteCount} of ${routeAssignPicker.deliveryIds.size} selected already ${routeAssignOverwriteCount === 1 ? 'has' : 'have'} a different route — applying this will replace it.`
    : null;

  const handleConfirmRouteAssign = async () => {
    if (!routeAssignPicker || !routeAssignRouteId || routeAssignConfirming) return;
    setRouteAssignConfirming(true);
    try {
      const ids = routeAssignPicker.deliveryIds;
      if (ids.size > 1) {
        const res = await api.batchAssignRoute({ delivery_ids: Array.from(ids), route_id: routeAssignRouteId });
        showAlert('Success', res.message || `Assigned route to ${ids.size} deliveries`);
      } else {
        await api.assignDeliveryRoute(Array.from(ids)[0], { route_id: routeAssignRouteId });
      }
      closeRouteAssignModal();
      setBatchMode(false);
      setSelectedIds(new Set());
      list.refresh();
    } catch (err) {
      showAlert('Error', err?.message || 'Failed to assign route');
    } finally {
      setRouteAssignConfirming(false);
    }
  };
```

- [ ] **Step 4: Replace the batch bar's single button with two buttons**

Find the batch-mode bar JSX (search for `styles.batchBar` — the block currently rendering `{selectedIds.size} selected` plus one "Assign All" button and a "Cancel" button). Replace the buttons row with:

```jsx
          <View style={{ flexDirection: 'row', gap: Spacing.sm, flexWrap: 'wrap' }}>
            <TouchableOpacity
              style={styles.batchAssignBtn}
              onPress={() => {
                if (selectedIds.size === 0) { showAlert('Info', 'Select at least one delivery'); return; }
                openRiderPickerFor(selectedIds);
              }}
            >
              <Ionicons name="people" size={16} color="#fff" />
              <Text style={styles.batchAssignText}>Assign Rider</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.batchAssignBtn}
              onPress={() => {
                if (selectedIds.size === 0) { showAlert('Info', 'Select at least one delivery'); return; }
                openRouteAssignModal(selectedIds);
              }}
            >
              <Ionicons name="map" size={16} color="#fff" />
              <Text style={styles.batchAssignText}>Assign Route</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.batchCancelBtn}
              onPress={() => { setBatchMode(false); setSelectedIds(new Set()); }}
            >
              <Text style={styles.batchCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
```

(Leave the `{selectedIds.size} selected` `Text` above this row untouched — only the buttons row changes. `styles.batchAssignBtn`/`batchAssignText`/`batchCancelBtn`/`batchCancelText` already exist and need no changes — both buttons reuse the same style.)

- [ ] **Step 5: Render `RouteAssignModal`**

Near the existing `<AssignPickerModal ... />` renders (after the rider one), add:

```jsx
      {/* Assign Route — the Assign Rider counterpart. See RouteAssignModal.js's
          own header comment; this screen owns routeId/warning, the modal is
          a thin controlled shell around RoutePicker. */}
      <RouteAssignModal
        visible={routeAssignPicker !== null}
        deliveryCount={routeAssignPicker?.deliveryIds?.size || 0}
        routeId={routeAssignRouteId}
        onChangeRoute={setRouteAssignRouteId}
        warning={routeAssignWarning}
        locationId={selectedLocation}
        confirming={routeAssignConfirming}
        onConfirm={handleConfirmRouteAssign}
        onClose={closeRouteAssignModal}
      />
```

- [ ] **Step 6: Babel-check**

Run: `node app/scripts/babel-check.js app/src/screens/DeliveriesScreen.js`

- [ ] **Step 7: Manual smoke check (code-level trace — no screen-render harness exists)**

Trace through, citing the actual code: (a) long-press a card → `batchMode`/`selectedIds` set, batch bar shows both buttons, no picker auto-opens (confirms `selectForBatch`'s auto-open removal didn't leave a stray call anywhere — grep the whole file for `openBatchAssignModal` to confirm zero remaining references to the old name); (b) "select all in this route" → same (via `selectForBatch`); (c) tapping "Assign Rider" with a selection → `openRiderPickerFor` fires with the right `Set`, byte-identical to before this task (nothing about that path changed except its entry point); (d) tapping "Assign Route" → `RouteAssignModal` opens, `RoutePicker` loads routes for `selectedLocation`, confirm button stays disabled until a route is picked; (e) picking a route that differs from an already-routed selected item → `routeAssignWarning` text appears with the correct count; (f) confirming with 1 selected → `api.assignDeliveryRoute` fires (not batch); confirming with 2+ → `api.batchAssignRoute` fires.

- [ ] **Step 8: Commit**

```bash
git add app/src/screens/DeliveriesScreen.js
git commit -m "Wire Deliveries batch bar to two actions: Assign Rider, Assign Route"
```

---

### Task 4: Full regression + live manual trace

**Files:** none (verification only)

- [ ] **Step 1: Run every regression script**

```bash
VERIFY_OWNER_PHONE=9876453210 VERIFY_OWNER_PASSWORD=naman1234 node server/scripts/verify-order-flows.js
node server/scripts/verify-register-expenses.js
node server/scripts/verify-identity-roles.js
node app/scripts/babel-check.js app/src/screens/DeliveriesScreen.js app/src/components/orderBoard/RouteAssignModal.js app/src/services/api.js
```
All must pass clean before continuing.

- [ ] **Step 2: Live trace — management account (owner/manager/counter_staff)**

Confirm, in order: (a) long-press a card and "select all in this route" both enter batch mode without auto-opening any picker; (b) "Assign Rider" opens the same picker as before this plan, single and batch both still work correctly (byte-identical behavior to the prior redesign — this plan didn't touch `openRiderPickerFor`/`handlePickRiderConsolidated`); (c) "Assign Route" opens `RouteAssignModal`, lists real routes for the current location, supports creating a new route inline (via `RoutePicker`'s own "+ Add route"); (d) applying a route to a single delivery calls the single endpoint, applying to 2+ calls the batch endpoint; (e) reassigning a route already-set delivery shows the overwrite warning with an accurate count; (f) a delivered/cancelled delivery included in a batch route-assign is correctly skipped (not errored) and the success message reports the skip count.

- [ ] **Step 3: Final commit (if Step 1-2 required any fix-up)**

If any check required a fix, commit it with a message describing exactly what regression check or trace step caught it. If everything passed on the first attempt, there's nothing to commit for this task.
