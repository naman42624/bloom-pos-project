# Deliveries bulk actions (Assign Rider + Assign Route) — design

**Sub-project:** small follow-on to the just-completed Deliveries screen redesign (`docs/superpowers/specs/2026-09-10-deliveries-redesign-design.md`), which built the batch-select mechanism (`batchMode`/`selectedIds`, "select all in this route") and the consolidated `AssignPickerModal` (single + batch rider assignment) this design builds directly on top of.

## 0. Why this exists

Today, selecting deliveries (via "Select today's (N)" or long-press multi-select) jumps straight into the rider-assign flow — the only bulk action available. Live use surfaced two gaps: (1) that single-purpose jump doesn't scale to a second bulk action, and (2) there is no way at all, today, to assign or change a delivery's route tag after the order was created — `route_id` is only ever set once, at order-creation time, via `RoutePicker` in `LogOrderScreen`/`QuickCheckoutScreen`. Confirmed by reading `server/routes/deliveries.js` in full: zero endpoints touch `route_id` on an existing delivery.

## 1. Scope

Exactly two bulk actions, both reachable after selecting one or more deliveries on `DeliveriesScreen`: **Assign Rider** (already fully built, Task 7 of the prior redesign — this project only wires a second entry point to it) and **Assign Route** (new, including new backend capability). Not building a generic/extensible action-menu architecture — two fixed buttons, confirmed with the user rather than assumed. Single-delivery route (re)assignment outside of select mode, and any other future bulk action, are explicitly out of scope (§6).

## 2. Interaction

The existing batch-mode bar (currently "N selected — [Assign All] [Cancel]") becomes:

```
N selected   [Assign Rider]  [Assign Route]  [Cancel]
```

Both buttons are always present once `batchMode` is active with a non-empty selection — no separate "choose an action" screen or menu (confirmed with the user: a two-button bar, not a sheet/menu, since the fixed 2-action scope doesn't need one). "Assign Rider" calls the existing `openRiderPickerFor(selectedIds)` (Task 7) unchanged — no new code for this button beyond wiring it into the new bar layout. "Assign Route" opens a new modal (§4).

The existing "select all in this route" header button (Route view only) is unaffected — it still populates `selectedIds` and enters batch mode exactly as today; both new buttons act on whatever is currently selected, regardless of how it was selected (long-press, "select all in this route", or a future selection method).

## 3. Backend — two new endpoints

Mirrors the existing `/:id/assign` + `/batch-assign` pattern exactly (same file, same auth roles, same single/batch shape):

- `PUT /deliveries/:id/route` — body `{ route_id }`. Sets `deliveries.route_id` for one delivery. `authorize('owner', 'manager', 'counter_staff')`, matching `/:id/assign`'s own role list (this is a dispatch-prep action, same audience). Follows `/:id/assign`'s exact validation shape (`server/routes/deliveries.js:527-581`, read directly): 404 if the delivery doesn't exist, an explicit 400 `Cannot assign a route to a delivery in ${status} status` if `status` is `delivered`/`cancelled` (not a silent no-op), 404 if `route_id` doesn't exist in `delivery_routes`, then the update.
- `POST /deliveries/batch-assign-route` — body `{ delivery_ids: [...], route_id }`. Sets `route_id` for every listed delivery, following `/batch-assign`'s own exact pattern (read directly, `server/routes/deliveries.js:370-420`): one prepared `UPDATE ... WHERE id = ? AND status ...` run per id inside a transaction, counting `assigned`/`skipped` from each statement's affected-row count, returned as `{ success, message, data: { assigned, skipped } }`. Route assignment is not status-sensitive the way rider assignment is (a route tag makes sense on any non-terminal delivery), so the WHERE clause is `status NOT IN ('delivered', 'cancelled')` — narrower exclusion than `/batch-assign`'s `IN ('pending','assigned','failed')` allow-list, since a route tag remains meaningful through `picked_up`/`in_transit` too, unlike a rider (re)assignment.

Both endpoints accept `route_id: null` to allow clearing a route (skipping the "route exists" check when null) — not required by this design's UI (the `RoutePicker`-based modal always picks an existing-or-new route, never "no route"), but cheap to support at the data layer and consistent with how `route_id` already behaves at order-creation time (optional there too).

## 4. Frontend — `RouteAssignModal` (new) + batch-bar wiring

New component `app/src/components/orderBoard/RouteAssignModal.js`, structurally similar to `AssignPickerModal`'s shell (`visible`, `onClose`, a title) but wrapping `RoutePicker` (`app/src/components/RoutePicker.js`, reused as-is — inherits create-or-find for free, no changes to that component) instead of a people list, plus a single "Apply to N deliveries" confirm button (disabled until a route is picked). `RoutePicker`'s existing `locationId` prop is fed from the same `selectedLocation` this screen already threads everywhere else.

**Overwrite warning:** before applying, if any selected delivery already has a *different* `route_id` than the one being applied, show a plain-language confirmation ("3 of 5 selected already have a route — this moves them to North Zone. Continue?") rather than silently overwriting — matches the guard-rail pattern used throughout the prior redesign (e.g. Task 6's fire-blind guards). Computed client-side from the already-loaded `route_name` field on each selected item — no extra fetch needed.

On confirm: single delivery (`selectedIds.size === 1`) → `PUT /:id/route`; more than one → `POST /batch-assign-route`, exactly mirroring `handlePickRiderConsolidated`'s existing size-based branch (Task 7) — same file, same pattern, adjacent code.

On success: close the modal, exit batch mode, clear selection, `list.refresh()` — identical cleanup to the existing rider-assign success path.

## 5. Testing / verification approach

Same as the prior redesign: TDD regression checks in `server/scripts/verify-order-flows.js` for both new endpoints (single assign, batch assign, the skip-terminal-status behavior, and the `route_id: null` clear case), `node app/scripts/babel-check.js` per touched/created frontend file, full 3-suite backend regression, and a code-level trace substituting for a live UI walkthrough (this codebase has no screen-render test harness — unchanged fact, not a new gap introduced here).

## 6. Explicitly out of scope

Single-delivery route (re)assignment outside of select mode (no per-card "Change Route" button — `DeliveryDetailScreen.js` stays untouched, same boundary the prior redesign already drew). A generic/extensible bulk-action-menu architecture for actions beyond these two — if a third bulk action is wanted later, it gets its own brainstorm at that point rather than speculative scaffolding now. Route optimization/stop-sequencing (unchanged from the original order-list-foundation design's own explicit deferral — a route stays a manual dispatch tag, not a routing algorithm).
