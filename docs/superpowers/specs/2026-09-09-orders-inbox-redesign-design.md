# Orders Inbox screen redesign — design

**Status:** drafted from brainstorming, awaiting user review.
**Sub-project:** first follow-on plan consuming the order-list-foundation toolkit (`docs/superpowers/specs/2026-09-05-order-list-screens-redesign-design.md`, `docs/superpowers/plans/2026-09-05-order-list-foundation.md`, PR #5 into `feature/identity-roles-pin-login`). Builds `app/src/screens/OrdersInboxScreen.js` against the toolkit's real, as-shipped interfaces — several of which evolved through that plan's own review cycle (e.g. `useOrderListData` gained `error`/`activeFilterCount` fields not in the original high-level design) — rather than the toolkit's originally-sketched shape.

## 1. Scope

This redesigns exactly one screen: `OrdersInboxScreen.js`. It is the first real consumer of `useOrderListData`, `OrderListToolbar`, `FilterDrawer`, `SortControl`, `ActiveFilterChips`, `ContactButtons`, `useRegisterSessions`/`DateSessionHeader` — establishing the integration pattern the Deliveries and Pickup Orders follow-on plans will reuse. Nothing outside this one screen changes: `OrdersHubScreen.js`'s tile-count fix already shipped in the foundation PR; the Dashboard, `SaleDetailScreen`, and every other screen are untouched.

## 2. Data & grouping model

`useOrderListData(fetchFn, { pageSize: 50 })` where:
```js
const fetchFn = (params) => api.getSales(params).then((r) => ({ items: r.data.sales, total: r.data.total }));
```

**Grouping is two-level, computed client-side from the flat `items` array `useOrderListData` returns — no new backend endpoint, no new query:**

1. **By calendar day**, shop-timezone-aware (matching `DeliveriesScreen.js`'s existing `extractLocalDate` helper — reused, not reinvented).
2. **Within a day, by register session** — but only when the current view is scoped to a single location. That's already true for every role except an owner with no location filter selected (owner/manager/employee/counter_staff are all location-scoped server-side already; `OrdersInboxScreen` never sends `location_id` today, so this redesign must determine "single location" from `user.role !== 'owner'` or an owner having explicitly picked one, not assume it). When scoped to one location: call `useRegisterSessions(locationId, dateStr)` once per distinct day present in the currently-loaded page, then for each order in that day call `matchSessionLabel(sessions, order.created_at)`. Two sessions on the same day render as two separate `DateSessionHeader` groups ("Today · Session 1 (9:02am–1:15pm)" then "Today · Session 2 (2:00pm–now)"), each with its own rows. An order with no matching session (legacy data, or a day with no register activity) falls under a plain day header with no session portion — `DateSessionHeader` already does this gracefully via its `sessionLabel: null` case, unchanged.
   - **Owner, no location filter (mixed locations):** plain day grouping only, no session sub-header. Matching sessions across multiple locations for a mixed list is real added complexity for a case CLAUDE.md explicitly de-prioritizes ("single location today... don't over-invest in multi-location UI polish yet") — confirmed with the user rather than assumed.
3. Rendered as a `SectionList` (not `FlatList`) — day/session boundaries are real section headers via `DateSessionHeader`, not synthetic rows mixed into the data array.

**Hooks-rules note for implementation:** `useRegisterSessions` is scoped to one `(locationId, dateStr)` pair per call and is a real React hook — it cannot be called in a loop over however many distinct days are on screen. The plan must call it from a small per-day wrapper component (one `useRegisterSessions` call per distinct day, each day rendered as its own component instance), not from the top-level screen component directly.

## 3. Toolbar & filters

- `OrderListToolbar` (search + Filters button; no `viewModeProps` — this screen has no route/rider view-mode toggle like Deliveries does) with `sortProps` wired to `useOrderListData`'s `sort`/`setSort`: `options: [{ value: null, label: 'Recent' }, { value: 'urgency', label: 'Urgent first' }]`. Default stays `null` (today's `created_at DESC` behavior) — never auto-selected, matching the hard constraint from the combined design doc §3.2.
- `FilterDrawer` sections, same values the screen already filters by today (no new filter dimensions invented):
  - Status: `[null, 'pending', 'confirmed', 'preparing', 'ready', 'completed']` (labels from the existing `STATUS_LABELS` map)
  - Channel: `[null, 'whatsapp', 'email', 'website', 'walk_in', 'phone']`
  - Rush: a single-entry section toggling `priority: 'rush'` on/off
- `ActiveFilterChips` rendered below the toolbar, driven by `useOrderListData`'s `filters`/`setFilter`/`clearFilters` — shows a removable chip per active filter, "Clear all" when more than one is active.
- `route.params?.status` seeding (the Dashboard's "Done" chip lands here pre-filtered) is preserved exactly: on mount, if `route.params.status !== undefined`, call `setFilter('status', route.params.status)` once instead of the old local `useState(route.params?.status ?? null)`. The existing re-sync effect (status arriving again while the screen is already mounted) is preserved the same way.

## 4. Row redesign

Each row gains, over today's rendering:
- `location_name` (currently invisible when viewing "All Locations" — already returned by `GET /sales`, just not rendered today).
- The order's time (alongside the existing `sale_number`/customer/items summary).
- **One dominant action**: `display_stage.nextAction`, rendered as a filled, primary-styled button — the same `api.advanceOrder(nextAction)` mechanism `OrderCard` already uses on the Dashboard kanban board. Rendered only when `nextAction` is non-null (most stages have one; terminal/no-action stages fall back to tap-row-for-detail only, no empty placeholder button).
- **Secondary, smaller icons** beside the primary action — never competing with it visually, per the combined design doc's §4 placement rule:
  - `ContactButtons` built as `[{ label: 'Customer', phone: item.customer_display_phone || item.customer_phone }, { label: 'Recipient', phone: item.receiver_display_phone }].filter(c => c.phone)`. `context.type` maps from `item.display_stage.key` using only the two templates `contact.js` actually defines for a specific stage — `'ready_for_pickup' → 'order_ready_pickup'`, `'out_for_delivery' → 'order_out_for_delivery'` — and falls back to `'general_inquiry'` (already `buildMessage`'s own default for every other key, so no explicit mapping is needed for them). `context.params: { sale_number: item.sale_number, location_name: item.location_name }`. `ContactButtons`' own phone-dedup already collapses this to a single tap when customer and recipient are the same person (the common case) — no extra logic needed here.
  - **Share Tracking Link** — a small standalone icon, *not* folded into `ContactButtons` (which only knows "call" and "message about the order generically"). Implemented directly against the already-exported low-level utilities: `Linking.openURL(waLink(contactPhone, buildMessage('tracking_link', { sale_number: item.sale_number, tracking_url: item.tracking_url })))`. Chosen over extending `ContactButtons` itself to avoid reopening an already-shipped, already-reviewed foundation component for a screen-specific need.
- Minimum 44×44pt tap targets on both new icons, matching every other icon button built in the foundation work.

## 5. Pagination

Real "Load more": a `SectionList` `ListFooterComponent` showing a button when `hasMore` is true, calling `loadMore()`, disabled/hidden while `loading`. Replaces the current silent 100-row cutoff (`GET /sales`'s `total` was already returned and discarded before this). Kept as an explicit tap rather than silent `onEndReached` infinite-scroll — matches the combined design doc's original wording; no reason surfaced to deviate from an already-approved choice.

## 6. Explicitly unchanged

- The quick-links row (Pickup Orders / Deliveries) and secondary Customers FAB, both `employee`/`counter_staff`-only — untouched, including their exact role gate.
- The primary Log Order FAB — untouched.
- `OrdersHubScreen.js`'s tile-count fix — already shipped in the foundation PR (Finding 4 of that plan's final review), not part of this plan.
- `PickupOrdersScreen.js` and `DeliveriesScreen.js` — separate follow-on plans, not touched here.

## 7. Testing / verification approach

This codebase has no screen-render test harness (confirmed throughout the foundation build — every one of its components was verified by `babel-check` plus reading, never by rendering). This screen is the first real render of `useOrderListData`, `OrderListToolbar`, `FilterDrawer`, `ActiveFilterChips`, `ContactButtons`, and `useRegisterSessions`/`DateSessionHeader` together — the foundation plan's own final review flagged this combination as the one place a bug could still be hiding despite every existing check passing (which is exactly how its live-verified filter-removal bug was found — by reading, not running). The implementation plan for this screen must include a live manual trace through the actual running app (not just `babel-check`) as an explicit task step: search, apply and remove each filter type, switch sort, scroll into a second page, tap a `nextAction` button, tap Call/WhatsApp/Share-tracking-link on a row with matching customer/recipient numbers and on one with different numbers, and view a day with two register sessions.

## 8. Explicitly out of scope / deferred

Deliveries and Pickup Orders screens (separate follow-on plans); the public tracking page itself (a different follow-on plan — this screen only originates the share action, it doesn't render the tracking page); any new filter dimension beyond the three the screen already has today; infinite-scroll pagination (kept as explicit Load More, see §5); multi-location session matching for the owner's "All Locations" view (confirmed deferred with the user, see §2).
