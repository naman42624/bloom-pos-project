# Order lifecycle simplification & delivery management — design

**Status:** drafted from brainstorming, awaiting user review.
**Sub-project:** 5 continuation (task assignment & delivery workflow) — the permission-parity pass already shipped; this is the deeper workflow/UX redesign the user asked for afterward, having judged the parity fixes insufficient on their own.

## 1. Problem statement

Real usage revealed three compounding problems, in the user's own words:

1. "Skip assignment is used mostly" — the granular per-item production flow (pick → start → complete, 3 taps × N items, across a dedicated screen) is too slow for busy, urgent periods. Staff route around it.
2. "The order life and statuses based on order type is too complex to maintain" — up to six semi-independent status fields per order (`sales.status`, `payment_status`, `pickup_status`, `production_tasks.status` per item, `deliveries.status`, `deliveries.cod_status`), each rendered differently by whichever of five screens happens to show it.
3. "Multiple screens and update flows make deliveries a little ugly to manage" — finishing one order can mean hopping SaleDetail → DeliveryDetail/PickupOrders → back, and at real scale (50+ deliveries/day, time windows, limited riders, geographic spread) there's no dispatch-oriented view at all.

A serious, adjacent bug was found and already fixed during this brainstorm (separate commit, not part of this spec's implementation): `pref_manager_override` — the existing "skip the per-item dance" shortcut — was silently faking inventory deduction instead of running it for real. Fixed by extracting the real completion logic into a shared `completeProductionTaskCore()` function used by both the single-task endpoint and the bulk shortcut. This spec assumes that fix is in place and builds on top of a now-truthful bulk-advance path.

## 2. Non-negotiable principle carried into every piece below

**Any derived/summary value must be computed fresh on every read, never stored.** This is a direct lesson from the bug in §1 — a persisted "shortcut" value is exactly how truth and stored state drift apart. The Stage concept (§3), the per-item task indicator (§4), and per-rider load counts (§7) are all computed live from the existing authoritative tables, never cached in a column.

## 3. The computed "Stage" concept

One order-level field, computed server-side (not duplicated in `app/` — no shared-package infrastructure exists between `server/` and `app/`, and writing the logic twice risks exactly the kind of drift this whole effort is trying to eliminate), derived purely from fields `GET /sales` and `GET /sales/:id` already return today: `sale.status`, `order_type`, `payment_status`, `pickup_status`, and the existing `delivery_status` LEFT JOIN. **No new queries, no schema change for this piece.**

### 3.1 Stage ladder per order type

| `order_type` | Sequence |
|---|---|
| `walk_in` | New → Preparing → Ready → Completed |
| `pickup` | New → Preparing → Ready for Pickup → Picked Up |
| `delivery` | New → Preparing → Ready → Out for Delivery → Delivered |
| `pre_order` | New → Preparing → Ready → Completed |

"New → Ready" directly (skipping a visible "Preparing" step) is a valid, already-occurring path — `fulfill-from-stock` already auto-advances `sale.status` to `ready` once every item is covered that way, and this needs no special-casing; the stage computation just reads the resulting `sale.status` like any other transition.

### 3.2 Shape of the computed value

```js
{
  key: 'ready',                    // stable identifier
  label: 'Ready',                  // display text
  color: '#4CAF50',                // matches existing STATUS_COLORS conventions per screen
  nextAction: {                    // null when no further staff action applies (e.g. already Completed/Delivered)
    label: 'Mark Delivered',
    endpoint: 'PUT /deliveries/:id/deliver',   // or whichever bulk-advance/completion endpoint applies
    // params supplied by the calling screen (deliveryId, saleId, etc.)
  } | null,
}
```

Attached to the sale object as `sale.display_stage` in `GET /sales` and `GET /sales/:id`. Every screen (Dashboard, OrdersInbox, SaleDetail, DeliveriesScreen) renders this instead of independently interpreting the raw fields — this is the piece that actually fixes "screens disagree with each other."

### 3.3 Payment/COD stays a separate badge

Deliberately not folded into Stage — "where is the order" and "has it been paid for" are orthogonal, and merging them would create a new confusing state ("why does it say Ready if it's unpaid?"). Payment badge rendering is unchanged from today, just kept alongside Stage rather than replaced by it.

## 4. Per-item task indicator — separate from Stage

When an order has more than one item and they're assigned to different people, a secondary, *conditional* indicator appears: `"2/3 items done — Rahul, Priya"`, computed from `production_tasks` grouped by `sale_id`. For a single-item order or one fulfilled entirely from stock, this indicator doesn't render at all — the common case stays visually simple; complexity only surfaces when it's actually present. This is a read-only summary; the underlying per-item assign/pick/start/complete flow (`ProductionQueueScreen`) is unchanged and remains available for staff who want to delegate specific items to specific florists.

## 5. Dashboard shortcuts — extending what's already there

The Dashboard's per-order card (built for counter_staff in an earlier phase) already has "Start Preparing"/"Mark Ready" quick actions calling the now-truthful bulk-advance endpoint. Extending this to the post-ready step, but only where it's unambiguous with no extra input required:

- **"Confirm Pickup"** — pickup orders with no balance due (`payment_status === 'paid'` or `is_credit_sale`).
- **"Mark Delivered"** — delivery orders with no COD outstanding.

Anything requiring input (collecting a balance, recording a failed-delivery reason) is explicitly *not* added as a card shortcut — it routes to the real screen, same split as §6.

## 5.5. Dashboard consolidation — counter_staff gets the manager dashboard's grouping, both get inline shortcuts

User's addition after reviewing the first draft: both the owner/manager and counter_staff dashboards should carry order-progressing shortcuts, and the counter_staff dashboard specifically should become a merge of the two — today's manager dashboard's *organization* plus today's counter dashboard's *action-orientation* — "so grouping and viewing and updating can be done in a single quick way."

**What the manager dashboard already has that counter_staff's doesn't:** a kanban-style board (`ordersByTypeAndStatus`, `renderOrderTypeSection`/`renderStatusLane`) — orders grouped by `order_type` (delivery/pickup/walk_in) into cards, each card broken into status lanes (Pending/Preparing/Ready, plus In Transit for delivery), with per-lane overdue/due-soon SLA counts and sub-status hints ("3 assigned · 1 in transit · 1 failed" for delivery, "2 ready to collect · 1 waiting" for pickup). This is pure order-count/status information, not revenue or cash figures — nothing here conflicts with the existing "no revenue totals, no exact register cash" boundary already agreed for counter_staff's dashboard, so it's safe to bring over largely as-is.

**What the manager dashboard is missing, that counter_staff's has:** inline per-order quick actions. Today, tapping a lane on the manager dashboard navigates *away* to a filtered queue screen (`handleNavigateToQueue`) — there's no one-tap "Mark Ready" directly on the dashboard itself, unlike the shortcuts already built for counter_staff's flat list (§5). This is a real gap on the manager side too, not something to leave behind when consolidating.

**The consolidated design:**
- Counter_staff's dashboard is rebuilt on the same kanban-by-type-and-lane structure as the manager dashboard (grouping/viewing), still excluding revenue/cash totals per the existing boundary.
- Individual orders within a lane get the inline one-tap actions from §5/§6 (Start Preparing / Mark Ready / Confirm Pickup / Mark Delivered, whichever applies to that order's Stage) directly on the card — no navigating to a queue screen just to advance a status.
- The *same* inline actions are added to the manager dashboard's existing lanes too, closing that gap for owner/manager as well — this isn't a counter-only enhancement, both get it.
- The existing counter_staff-specific pieces already built this session (today/future split, pending-COD banner, register-status card) carry over unchanged into the new layout — they're not being replaced, just re-hosted inside the richer kanban structure.

## 6. SaleDetail inline actions (sub-project 5's "approach C")

Deliberately **not** a full consolidation of `DeliveryDetailScreen`/`PickupOrdersScreen` into `SaleDetailScreen` — those screens carry real weight (GPS tracking, COD collection with method/reference, proof-of-delivery, assign-a-rider) that would bloat SaleDetail if inlined wholesale.

Instead: the common, no-extra-input case gets a one-tap action directly on SaleDetail (same two actions as §5 — "Mark Picked Up" / "Mark Delivered" when there's nothing else to collect). Anything needing a form still navigates to the dedicated screen, which remains the full-detail, full-capability view — explicitly preserved per the user's "still available if someone taps into DeliveryDetail" instruction.

## 7. Vendor field

- New column: `sales.vendor_name` (`VARCHAR`, nullable, additive).
- Input available to owner and manager when logging an order (`LogOrderScreen`) — not to counter_staff/employee/florist_staff.
- **Read access is owner-only, even manager is stripped on the way back out** — user's explicit decision, overriding the more common "owner+manager" pattern used elsewhere in this app. Follows the same precedent as `materials.avg_purchase_cost` (hard-coded `req.user.role !== 'owner'` strip), not the configurable `supplier_manager_fields`-style toggle used for supplier pricing — this field has no toggle, it's always owner-only.
- Purpose: grouping/reporting by referring vendor. Optional field, never blocks order creation.

## 8. Route field

### 8.1 Storage

New table `delivery_routes`:

```sql
CREATE TABLE delivery_routes (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,           -- display form, as first successfully entered
  normalized_name VARCHAR(100) NOT NULL UNIQUE,
  is_active BOOLEAN DEFAULT true,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

`deliveries.route_id` — new nullable FK column, additive, set in the same transaction that already creates the `deliveries` row at order-creation time (QuickCheckout and LogOrder, delivery orders only).

### 8.2 Normalization (the "Delhi"/"delhi"/"DeLhi"/" delhi"/"de lhi" requirement)

`normalize(s) = s.trim().toLowerCase().replace(/\s+/g, '')` — strips *all* whitespace, not just extra/leading/trailing. This is more aggressive than a typical slug (it would also collapse "New Delhi" and "Newdelhi"), which is a real trade-off worth restating: for a small, real list of shop delivery zones this is very likely the correct behavior, but it means two legitimately-different route names that happen to share letters once spacing is removed cannot both exist. Flagged, not hidden.

### 8.3 Create-or-find flow

`POST /api/delivery-routes { name }`: normalize the input, look up `normalized_name`; if found, return the existing route (no duplicate created, not even via a race — the DB-level `UNIQUE` constraint on `normalized_name` is the actual backstop, the app-level lookup is just to avoid a wasted round trip / expected-conflict noise); if not found, insert and return the new row. `GET /api/delivery-routes?location_id=` lists active routes for the dropdown, scoped by location once multi-location matters.

### 8.4 UI

A dropdown in QuickCheckout and LogOrder, delivery orders only, with an "add new route" option that opens a small text input and calls the create-or-find endpoint above. Optional — never blocks order creation.

## 9. Deliveries screen — dispatch-oriented redesign

Explicitly scoped against real logistics patterns, keeping only what fits this shop's actual scale (a handful of riders, not a fleet-management problem):

### 9.1 In scope

1. **Route-grouped view and batch dispatch.** Once §8 exists, the default view groups unassigned/at-risk deliveries by route ("North Zone — 8 deliveries") rather than a flat list. Select a whole route group and batch-assign to one rider in one action. **No backend change needed for this specifically** — `GET /deliveries` already returns per-delivery data and just needs `route_id`/route name added to its SELECT (trivial, since `deliveries.route_id` exists once §8 lands); the frontend groups by that field for display and a "select all in this route" convenience, then calls the existing `batch-assign` endpoint (already built, already counter_staff-accessible per the sub-project 5 permission work) with the gathered `delivery_ids` — same endpoint, unchanged contract, route-awareness lives entirely in how the frontend presents and selects, not in a new assignment mechanism.
2. **At-risk-first default view.** `GET /deliveries/at-risk` already exists and is already counter_staff-readable (confirmed during the sub-project 5 audit) but isn't surfaced prominently anywhere. This becomes the *default* sort/filter on the Deliveries screen — what's late or about to be leads, not something you have to think to check.
3. **Simple per-rider load visibility.** "Aman: 6 stops today, Vishal: 3" — a plain count next to each rider's name in the assign picker, computed live from their current unfinished `deliveries` rows. Not a capacity-planning algorithm (explicitly deferred, §9.2) — just visibility so whoever's dispatching doesn't have to mentally tally it.
4. **Load checklist / manifest — both counter-staff-side and rider-side** (user confirmed "both is fine").
   - **Scope: per-rider, not per literal `batch_id`.** `batch_id` already exists but is only stamped by the batch-assign action, not individual `PUT /:id/assign` calls — keying the checklist to it would fragment a rider's day across disconnected batches every time one delivery gets assigned individually alongside a batch. Instead: "everything currently assigned to Rider X, not yet picked up" (`deliveries WHERE delivery_partner_id = ? AND status IN ('assigned')`), computed live, covering both individually- and batch-assigned deliveries in one running list.
   - **New table**, additive, delivery-scoped (kept out of `sale_items` since only delivery orders need this — a pickup/walk-in order has no "loaded onto a vehicle" concept):
     ```sql
     CREATE TABLE delivery_load_checks (
       id SERIAL PRIMARY KEY,
       delivery_id INTEGER NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
       sale_item_id INTEGER NOT NULL REFERENCES sale_items(id) ON DELETE CASCADE,
       checked BOOLEAN DEFAULT false,
       checked_by INTEGER REFERENCES users(id),
       checked_at TIMESTAMP,
       UNIQUE(delivery_id, sale_item_id)
     );
     ```
   - **One shared checklist state, not two parallel ones.** Counter staff (pre-dispatch, loading the vehicle) and the rider (their own app, self-verifying before departure) read and write the *same* rows — whoever checks an item off first is what both sides see. Avoids double-tracking and matches "both is fine" as both roles having access to one source of truth, not each maintaining their own separate list.
   - Rows are lazily created (or upserted) the first time a delivery's checklist is viewed, one row per `sale_item` on that delivery — no bulk pre-population needed at assignment time.

### 9.2 Explicitly deferred — named, not silently dropped

- **Automated stop-sequencing / route optimization** (suggesting an optimal visiting order using live mapping/geocoding). This needs a real external mapping API — cost, external dependency, same category of decision as the WhatsApp Business API question from sub-project 4. Route (§8) is a manual grouping tag, not a routing algorithm. User confirmed: defer, revisit as its own brainstorm if wanted later.
- **Rider capacity limits / auto-balancing assignment.** Real fleets need this at a scale where a human dispatcher can't reason about it by eye. User confirmed this shop's scale doesn't need it — §9.1.3's plain visibility is the whole of what's being built here.
- **`ProductionQueueScreen` fixes and improvements** — added to the deferred list per the user's explicit request when reviewing this spec. Not investigated yet in this session, so no concrete issues are named here; flagged as a future audit-and-fix pass (matching the shape of sub-project 4/5's "audit first, then fix" approach) rather than left implicitly fine.

## 10. Explicitly out of scope for this spec

- Any change to the underlying six status fields themselves (Stage is a read-layer computation over them, not a schema consolidation).
- `ProductionQueueScreen`'s granular per-item flow itself (assign/pick/start/complete, per item) — unchanged in this pass, remains available for delegated multi-item orders. **`ProductionQueueScreen`'s own fixes/improvements are separately deferred to a future pass — see §9.2.** No specific issues identified yet (unlike the other deferred items, this wasn't backed by an investigation this session); it's flagged per the user's request as something to come back and audit, not something with known concrete problems right now.
- Full CRUD/admin management UI for `delivery_routes` (deactivating unused routes, renaming) — the create-or-find flow is enough to start; a management screen can follow later if the list needs pruning.

## 11. Open items for spec review

1. Route normalization's aggressiveness (§8.2) — confirm the "New Delhi"/"Newdelhi" collision trade-off is acceptable, not just the originally-cited examples.
2. Whether `delivery_load_checks` rows should be pre-created at assignment time (so a rider sees a fully-populated but all-unchecked list immediately) versus lazily created on first view (current proposal) — functionally near-identical, but worth confirming no edge case (e.g. an item added to the order *after* assignment) is missed by the lazy approach. Lazy creation naturally handles that case (a newly-added item just gets its row created whenever the checklist is next viewed); pre-population would need an explicit sync step. Recommending lazy creation for this reason.
