# Pickup Orders screen redesign — design

**Sub-project:** third real consumer of the order-list-foundation toolkit (`docs/superpowers/specs/2026-09-05-order-list-screens-redesign-design.md` §8 for the original brief; this doc supersedes it with full detail and one confirmed root-cause backend fix the brief's author couldn't have known about).

## 0. Starting point, and a real bug found before any design could be trusted

`PickupOrdersScreen.js` (523 lines) is simpler than Deliveries — a 3-tab status structure (Preparing/Ready/Picked Up), date-grouped `SectionList`, a location chip row, and a working custom payment-collection modal for confirming pickup with a balance due.

The original §8 brief proposed routing this screen's "Mark Ready" through the same guarded path every other screen uses — today it calls its own dedicated endpoint (`PUT /deliveries/pickup/:saleId/ready`) which has no production-task-completion guard at all, while the standard path (`PUT /sales/:id/status`) does. Before accepting that change, it was traced end to end rather than assumed safe, because the dedicated endpoint also does something the standard path doesn't: an inline stock/material deduction walk. That tracing found a **real, already-live bug**, fixed today ahead of this redesign (`server/routes/production.js`, commit `7344fc8`): a pickup order's production tasks are, in practice, completed the normal way (`PUT /production/tasks/:id/complete`) — confirmed against live data — and that route's auto-ready transition updated `sales.status` but never `sales.pickup_status`, since only the screen's own dedicated endpoint ever touched that column. One real order (`sale 305`) was found stuck showing under "Preparing" with `status` already `'ready'`. Fixed at the root (the auto-transition now updates both columns, mirroring a guard `sales.js`'s "Fulfill from Stock" route already had) and the one already-affected row corrected directly. Full reasoning and verification trail in that commit.

With that fixed, adopting the generic `nextAction` path for "Mark Ready" is safe: by the time it's ever offered, all production tasks are done (same precondition every other screen's Mark Ready already requires), meaning per-task deduction has already happened correctly for every item with a real material/product link — matching exactly how Orders Inbox and Deliveries already work, no screen-specific special case needed.

**Second finding, folded into scope by request:** `PUT /deliveries/pickup/:saleId/picked-up` (Confirm Pickup) already guards against a balance due server-side (throws a clear "Balance due: ₹X..." error, no money-loss risk) — but Orders Inbox's existing safe-action guard only checks for the COD-delivery case (`nextAction.endpoint?.endsWith('/deliver')`), not this one, so a pickup-type order with a balance due showing in Orders Inbox would hit that raw-ish error on a blind tap instead of collecting inline. Closing this is in scope here (§7), since the shared modal this redesign builds is the natural fix.

## 1. Scope

Redesigns `app/src/screens/PickupOrdersScreen.js`, plus a small wiring addition to `app/src/screens/OrdersInboxScreen.js` (§7) and one shared component both use. The backend fix (§0) is already shipped, not part of this plan's tasks.

## 2. Toolbar & filters

- **Status stays the existing 3 tabs** (Preparing / Ready / Picked Up) — already the right control for 3 mutually exclusive states; no change, per the original brief.
- Search is new — `OrderListToolbar`'s search box (this screen has never had one).
- Location moves from the standalone chip row into `FilterDrawer`, consistent with Orders Inbox and Deliveries.
- Date-range preset chips (Today / Yesterday / This Week) added to `FilterDrawer`, matching the pattern already specified for Deliveries.
- "Urgent first" sort, additive, same flattening rule as the other two screens (though grouping here is date-only to begin with — see §4).

## 3. Data layer

`useOrderListData(fetchFn, { pageSize: 50 })` where `fetchFn = (params) => api.getSales({ ...params, order_type: 'pickup', pickup_status: tab }).then((res) => ({ items: res.data?.sales || [], total: Number(res.data?.total) || 0 }))`. `tab` stays local screen state (`waiting` / `ready_for_pickup` / `picked_up`), always merged into the request — not a generic `useOrderListData` filter, since it's a fixed, mutually-exclusive selector, not an optional dimension.

## 4. Grouping

Stays a plain date-grouped `SectionList` (unlike Deliveries, no `CollapsibleSection` adoption here) — this screen has only one grouping dimension (date), not Deliveries' Route/Date/Rider set, so there's no multi-mode toggle motivating a collapse-capable wrapper. `sort === 'urgency'` flattens to one section, no headers, matching the established rule. The existing client-side re-sort (`sortedOrders`) is deleted in favor of the server's own ordering, same fix already applied to the other two screens.

## 5. Card redesign

- `ContactButtons` added for the customer — phone isn't rendered anywhere on this screen today.
- Item list collapses behind a "N items ▸" disclosure, consistent with the other two screens.
- Card state (payment badge, stage) switches from re-deriving off `payment_status` + the current tab to the shared `display_stage`/`StageBadge` components the other two screens already use.

## 6. Safe actions

- **Mark Ready** (Preparing tab): adopts the generic `nextAction` path, safe per §0. Reuses the exact `openPreparerPicker`/`handlePickPreparer`/`handleLeavePreparerForNow`/`AssignPickerModal` mechanism Orders Inbox and Deliveries already have — a pickup order needing a preparer picked gets the same safe inline picker, not a blind fire.
- **Confirm Pickup** (Ready tab): still `nextAction`'s `PICKUP_PICKED_UP` action (`/deliveries/pickup/:saleId/picked-up`, unchanged endpoint). The safety gap is the client side: firing this blind on a balance-due, non-credit order hits the server's real guard as a failure rather than resolving it. New shared component `CollectPickupPaymentModal` (extracted from this screen's own already-working payment modal — method chips, amount, reference, "Confirm Payment & Complete") replaces the blind fire for that one case, submitting via `api.markPickedUp(saleId, paymentData)` exactly as today.

## 7. Orders Inbox fix

`OrdersInboxScreen.js` gains a `needsPickupPaymentCollect` check alongside its existing `needsPreparerPick`/`needsCodCollect`: `nextAction?.endpoint?.includes('/pickup/') && nextAction?.endpoint?.endsWith('/picked-up') && (Number(item.grand_total||0) - Number(item.total_paid||0)) > 0.01 && !item.is_credit_sale` — opens the same `CollectPickupPaymentModal`, closing the gap named in §0 rather than leaving a newly-shared component's other real call site unfixed.

## 8. Explicitly unchanged / out of scope

`SaleDetailScreen.js` (untouched — still the deep-link destination for full order detail). The backend fix (§0) — already shipped, not a task here. Any change to how `POST /sales` creates pickup orders or their initial `pickup_status` — untouched.

## 9. Testing / verification approach

Same as the other two: `node app/scripts/babel-check.js` per touched/created file, full 3-suite backend regression (no new backend changes in this plan itself, but re-run to confirm no regression), and a live manual trace as the final task — covering Mark Ready's safe preparer-resolution, Confirm Pickup's safe balance-collection (both on Pickup Orders and, via the new check, on Orders Inbox for a pickup-type order), and date/search/location/sort filtering.
