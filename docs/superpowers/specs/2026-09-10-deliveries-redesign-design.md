# Deliveries screen redesign — design

**Sub-project:** second real consumer of the order-list-foundation toolkit (`docs/superpowers/specs/2026-09-05-order-list-screens-redesign-design.md` §7 for the original brief; this doc supersedes/completes it with full detail, revised against lessons learned building Orders Inbox — `docs/superpowers/specs/2026-09-09-orders-inbox-redesign-design.md`).

## 0. Starting point and what's carrying over from Orders Inbox

`DeliveriesScreen.js` (781 lines today) is already a mature, feature-rich screen — Route/Date view toggle, at-risk-first grouping, batch select/assign with "select all in this route," live 60s-tick countdowns, COD badges, dual audience (management view vs. a simplified delivery_partner view), multi-location filter. This redesign is not a rewrite of working functionality — it's the toolkit migration §7 originally scoped, revised with three things the Orders Inbox build surfaced:

1. **A null `nextAction` means "needs a decision," not "nothing to do."** Orders Inbox initially got this wrong (hid the button, no explanation) before being fixed to reuse `resolveDeadEnd` (`OrderCard.js`) properly. Deliveries gets this built in from the start — `resolveDeadEnd`'s `assign_rider`/`reattempt_delivery`/`record_cod`/`collect_payment` cases matter *more* here than on Orders Inbox, since this screen exists specifically to manage deliveries.
2. **Reuse shared components, don't build a second copy.** `AssignPickerModal` (already shared by Dashboard's rider and preparer pickers, and now Orders Inbox's preparer/rider pickers too) replaces this screen's own custom assign modal — see §5.
3. **A horizontal `ScrollView` needs `flexGrow: 0, flexShrink: 0` on its own `style` prop**, or it stretches to fill the column on web (found live on Orders Inbox, 2026-09-10) — applies to any new toolbar/chip row built here.

## 1. Scope

Redesigns `app/src/screens/DeliveriesScreen.js` only. No backend changes are anticipated — §3 confirms every field the new logic needs already exists on `GET /deliveries` rows or is fetched the same way the current screen already fetches it. `DeliveryDetailScreen.js` (per-delivery detail, reattempt/cancel/convert controls, live map) is untouched — this screen's role stays "list, triage, batch-dispatch," not detail management.

## 2. Toolbar & filters

- Search and the **view-mode toggle stay always-visible, primary controls** — never in the drawer. View-mode gains a third option, **By Rider** (groups the already-fetched batch by `partner_name`, same client-side technique as Route grouping), alongside the existing Route (management default) and Date (forced for `delivery_partner`'s own simplified view — unchanged).
- **Status stays a visible one-tap chip row** (revising the original §7 brief's "status... moves into FilterDrawer," based on what shipped for Orders Inbox: moving status behind a drawer cost taps on the single most frequent filter action for no row-count savings). All 8 existing `STATUS_TABS` values stay, `active` stays the default.
- **Location and a new rider filter** (`delivery_partner_id` — server already accepts it on `GET /deliveries`, currently unused) move into `FilterDrawer`, replacing the standalone location-chip row. `useOrderListData`'s `filters.location_id` becomes the single source of truth — no separate `selectedLocation` state.
- `SortControl`'s "Urgent first" is additive; when active it **flattens all grouping** (Route/Date/Rider, and the at-risk lead section) into one flat rush-first list — same rule as Orders Inbox, confirmed with the user rather than assumed, even though Route view already has its own at-risk-lead ordering built in (one consistent mental model for "show me what's urgent" beats a per-view-mode special case).
- Date-range filter: quick preset chips (Today / Yesterday / This Week) plus a picker for anything else, in `FilterDrawer` — new, from the original §7 brief.

## 3. Data layer

`useOrderListData(fetchFn, { pageSize: 50 })` where `fetchFn = (params) => api.getDeliveries(params).then((res) => ({ items: res.data?.deliveries || [], total: Number(res.data?.total) || 0 }))` — the foundation plan's own earlier fix already made `GET /deliveries` return an accurate `total`.

At-risk detection stays a **separate fetch**, not folded into `fetchFn` — it's a different shape of data (a flag set, not the primary paginated list) fetched from a different endpoint (`GET /deliveries/at-risk`). New hook `useAtRiskIds(locationId, resetToken)`, structurally identical to `useSessionsForDates`'s reset-token pattern (same screen-never-unmounts staleness problem Orders Inbox already hit and fixed): fetches `api.getAtRiskOrders(locationId ? { location_id: locationId } : {})`, returns a `Set` of `delivery_id`s, refetched whenever `locationId` changes or `resetToken` bumps (the screen's own `useFocusEffect` bumps it on every focus-regain, exactly like Orders Inbox's `sessionsResetToken`).

## 4. Grouping

Sections are computed with a `useMemo` over `list.items`, keyed on `(list.items, list.sort, viewMode)`:

- **`sort === 'urgency'`:** one flat section, no headers, server order (rush → soonest-scheduled → oldest), matching Orders Inbox's rule exactly.
- **Route view (management default):** at-risk items lead in their own section (`Needs Attention (N)`) regardless of route, exactly as today — still also appearing in their own route group below (dropping them would break "select all in route"). Then one `CollapsibleSection` per route (`route_name` or "No Route Assigned," sorted alphabetically with "No Route Assigned" last — unchanged from today's logic).
- **Date view:** one `CollapsibleSection` per date, ordered by scheduled date/time. The blank `_unscheduled` section header bug (`formatShopDateLabel('_unscheduled')` → `''`) gets a real label: "No Date Set."
- **By Rider (new):** one `CollapsibleSection` per `partner_name` (or "Unassigned"), same grouping technique as Route.
- Every `CollapsibleSection` defaults expanded (`defaultExpanded={true}`) — collapsing is opt-in, never hides an order by default (staff-ux-checklist).
- The client's own re-sort (`sortedDeliveries`, `:269-275` today) is deleted — trusting the server's `sort` param (default status-ladder order, or `sort=urgency`) once it's properly passed through via `useOrderListData`.

**Architecture note:** `CollapsibleSection` wraps `children` directly, not a `data`+`renderItem` contract — adopting it means this screen renders via a plain `ScrollView` containing a sequence of `CollapsibleSection`s, not today's `SectionList`. Accepted tradeoff: no virtualization, in exchange for real collapse/expand (which the existing `SectionList`'s decorative-only headers don't have). Justified because this screen's realistic volume is bounded (a shop's active/route-scoped deliveries, not Orders Inbox's full historical long-tail) — not adopted blindly, a deliberate choice for this screen's actual data shape.

## 5. Card redesign

- The always-inline full item list becomes a collapsed **"3 items ▸" disclosure**, opened on tap — should roughly halve card height, addressing the "~2 cards visible per screen" density problem the original brief named. Time/countdown, address, rider name, and COD/payment badge stay visible by default — what staff actually scan a delivery card for.
- `ContactButtons` added for **both** customer (currently plain text, no tap action) and rider (currently reachable only by opening the assign modal) — same shared component Orders Inbox uses.
- **Safe one-tap actions**, reusing exactly what Orders Inbox now has: `nextAction` fires directly when safe (Mark Picked Up, Mark Delivered when no COD outstanding — else opens `CollectCodModal`, already shared); when `nextAction` is null, `resolveDeadEnd(order, canManageDeliveries, canTakeMoney)` decides between a secondary route button, a plain status line, or nothing — `assign_rider` and `finish_tasks` open modals (see below), `reattempt_delivery`/`collect_payment`/`record_cod` navigate (using the *local* screen name — `navigate('AddPayment', ...)`, not `navigate('POS', {screen: 'AddPayment', ...})` — per the cross-tab redirect bug already found and fixed on Orders Inbox/Dashboard; confirm `AddPayment`/`Settlements` are registered locally in whichever stack(s) host this screen before relying on this).
- **Assign consolidation (confirmed):** the existing custom assign modal (`assignModalVisible`/`selectedDelivery`/`partners`/`handleAssign`) is replaced by `AssignPickerModal` — same component now used by Dashboard's rider/preparer pickers and Orders Inbox's rider/preparer pickers (its 4th reuse). Extended to cover what this screen already does that those callers don't: **batch mode** (`onPick` assigns to every delivery in the current selection set, not just one) and the **per-rider active-delivery-count** already shown in today's picker (`p.active_delivery_count`, "N on the road") — both preserved, not dropped.
- `TaskCompletionModal` reused as-is for a delivery order's `finish_tasks` case (same component Dashboard/Orders Inbox now use) — deliveries can have production tasks too (pre-order-fulfilled-by-delivery, etc.), so this isn't a hypothetical case.

## 6. Batch assign / Select-all-in-route

Preserved exactly — batch mode (long-press or "select all in this route" header button), the `isDueForDispatch` safety filter (never sweeps a future-dated delivery into a blind "select all"), the batch-mode bar with count + Assign All / Cancel. Re-homed onto the new `CollapsibleSection`-based rendering (the "select all in this route" button moves into each Route-mode `CollapsibleSection`'s header) and onto the consolidated `AssignPickerModal` (§5) for the actual picker UI.

## 7. Bug fixes folded in

- Blank `_unscheduled` date section header → "No Date Set" (§4).
- Client-side re-sort deleted in favor of the server's own ordering (§4).
- The `flexGrow: 0, flexShrink: 0` fix (§0.3) applied to every new horizontal `ScrollView` this redesign adds (view-mode toggle row if built as a scroll, any new chip rows).

## 8. Explicitly unchanged / out of scope

`GET /deliveries/at-risk`'s own detection logic (server-side, untouched). `DeliveryDetailScreen.js` — reattempt, cancel, convert-to-pickup/credit, live map tracking all stay there, one level deeper, not duplicated here. The delivery_partner's own simplified view (Date-only, no batch/route tools) — unchanged in substance, just riding on the same new toolkit components. Per-rider active-delivery-count data source — unchanged, just now surfaced through `AssignPickerModal` instead of the old custom modal.

## 9. Testing / verification approach

Same as Orders Inbox: `node app/scripts/babel-check.js` per touched/created file, a plain-Node `assert` script for any new pure function (e.g. if `useAtRiskIds` needs one), full 3-suite backend regression, and a live manual trace as the final task — covering Route/Date/Rider view switching, urgent-sort flattening, batch assign (single + multi), the consolidated `AssignPickerModal`'s single/batch modes, at-risk lead section correctness, and the safe-action guard on a real COD-outstanding delivery (must never fire blind).
