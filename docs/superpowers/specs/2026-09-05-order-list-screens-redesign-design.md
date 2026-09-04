# Order visibility & communication redesign — design

**Status:** drafted from brainstorming, awaiting user review.
**Sub-project:** new — extends sub-project 5 (task assignment & delivery workflow) and sub-project 3's deferred urgency-sort proposal, but scoped as its own initiative since it touches three screens plus a new public-facing surface, not a continuation of either prior spec's own scope.

## 1. Problem statement

In the user's own words: the Orders Inbox is "a simple long list, without any kind of filters or sort or grouping, no date context, no register context." Deliveries and Pickup Orders are "almost useless" — despite Deliveries already having route-grouping and at-risk sorting from the 2026-09-01 redesign.

A research pass (full findings in the session transcript, not repeated verbatim here) confirmed and sharpened this:

- **Orders Inbox** (`app/src/screens/OrdersInboxScreen.js`) actually has search + status/channel/rush filter chips already — the real gaps are *sort* (fixed `created_at DESC`, no urgency ordering), *grouping* (none — flat list), *date/register context* (none), and a silent 100-row cutoff with no pagination.
- **Deliveries** (`app/src/screens/DeliveriesScreen.js`, 780 lines) has real structure (Route/Date view modes, at-risk-first sorting, batch assign) but: no rider filter or grouping, no date range (only Today/Tomorrow labels), groups aren't collapsible, and its own card is 250–400px tall (full item list always inline), leaving ~2 visible per screen.
- **Pickup Orders** (`app/src/screens/PickupOrdersScreen.js`, 523 lines) is the least developed of the three: no search at all, doesn't render customer phone, doesn't use the `display_stage` model the other two screens share, and its "Mark Ready" action skips a guard every other Mark Ready path in the app enforces.
- **Call/WhatsApp** exists in exactly one place order-adjacent to these screens (`OrderCard`, the Dashboard kanban card) and nowhere else — not on any of the three list screens, not on `SaleDetailScreen`/`DeliveryDetailScreen` (phones render as plain unclickable text there). The few sites that do exist have real bugs: a hardcoded `91` country-code prefix, no phone normalization, and wildly inconsistent message quality (Settlements' rider-handoff message is specific and useful; `OrderCard`'s is a generic opener).
- Mid-brainstorm, the user added a fourth piece: a public, no-login order-tracking link, shareable over free-tier WhatsApp (`wa.me`), so a customer can check their own order's status without an account.

## 2. Scope & non-goals

**In scope:** Orders Inbox, Deliveries, Pickup Orders redesigns; a shared component/hook toolkit powering all three; Call/WhatsApp available and improved everywhere a phone number appears in these flows; a new public order-tracking page and link-sharing action.

**Explicitly out of scope / deferred** (named per this project's convention, not silently dropped):
- WhatsApp Business API / automated customer notifications — already deferred project-wide (CLAUDE.md, sub-project 4).
- Live rider location on the public tracking page — the user chose "status only" for v1.
- Automatic (non-staff-triggered) message sending — the user chose manual "staff taps Share."
- Merging the three screens into one unified workspace — considered and rejected in favor of a shared toolkit with three distinct screens (see §3 approach note).
- Route optimization/stop-sequencing, rider capacity balancing — already out of scope per the 2026-09-01 delivery-management spec, unaffected by this work.
- `ProductionQueueScreen`'s own separately-flagged issues, and `DashboardScreen.js`'s own duplicate one-tap advance mechanism — both already known, separately tracked items; not touched here.

**Non-negotiable constraint carried in:** no destructive schema changes, and — as it turns out — **no new schema at all**. Every piece below is either purely additive (a new optional query param) or requires no persistence whatsoever (the tracking token is a computed signature, not a stored value).

## 3. Architecture: shared toolkit, three distinct screens

Considered and rejected: merging Orders Inbox/Deliveries/Pickup into one screen with a type switcher. It would have given a single search box spanning all order types, but at the cost of reworking navigation (the Orders Hub tiles), and forcing three genuinely different action sets (payment collection on Pickup, batch-assign on Deliveries, neither on Inbox) into one shared shell — a bigger rewrite for a benefit ("one search box") the user didn't ask for.

Instead: extract the pieces that are duplicated or missing across all three into shared, independently-testable units; keep each screen as its own file with its own card design suited to its own job. This also pays down existing debt — the research found three near-identical `getTimeInfo`/date-section-builder implementations already independently written in `DeliveriesScreen.js` and `PickupOrdersScreen.js`.

### 3.1 New shared modules

```
app/src/
  hooks/
    useOrderListData.js       — fetch + debounced search + filter state + real pagination + sort param + request-race protection
  components/orders/
    OrderListToolbar.js       — bounded search + filters-button + sort-control row (replaces the old per-filter chip rows — see §3.1a)
    FilterDrawer.js           — the slide-up sheet holding every filter as a scrollable list, opened from the toolbar
    SortControl.js            — small separate "Sort: Recent ▾" popover, deliberately not part of FilterDrawer
    ActiveFilterChips.js      — one bounded, horizontally-scrollable row of removable chips, rendered only when ≥1 filter is active
    ContactButtons.js         — Call + WhatsApp, contextual message templates, phone normalization
    DateSessionGroup.js       — section header: "Today · Morning Session (9:02am–1:15pm) · ₹8,400"
    CollapsibleSection.js     — generic expand/collapse wrapper for any grouped section (Route/Date/Rider/Day)
  utils/
    contact.js                — normalizePhone(), telLink(), waLink(), buildMessage(context)
```

`useOrderListData(endpoint, { extraParams, sort })` centralizes exactly what `OrdersInboxScreen` already does well (debounced search, `requestIdRef` race protection) and adds real "Load more" pagination via `offset`, reading the server's already-accurate `total`.

`CollapsibleSection` is deliberately generic (title, count, `defaultExpanded`, children) so Deliveries' Route/Date/Rider sections and any future Inbox day-grouping all use the same expand/collapse behavior and the same visual language.

### 3.1a Why the filter UI is a new component, not a reuse of the existing chip rows

Reading the actual code changed this part of the design mid-brainstorm. `DeliveriesScreen.js` today stacks up to five independent fixed-height rows above its list — search, status tabs, location chips, the Route/Date view toggle, and (when active) the batch-assign bar — with no collapse or overflow mechanism. Every new filter dimension this spec adds (rider, date range) would be a *sixth* and *seventh* row on top of that, worsening the exact "filters become unreachable / crowd out the list" problem the user flagged, not fixing it.

Replacement: a **bounded toolbar**, capped at three rows no matter how many filter dimensions exist, ever:

```
Row 1:  🔍 Search anything...          [≣ Filters (2)]
Row 2:  [By Route▾][By Date][By Rider]     [Sort: Recent ▾]     ← only on screens with a view-mode toggle
Row 3 (only when ≥1 filter is active):
        Status: Ready ✕   Channel: WhatsApp ✕
```

`FilterDrawer` holds every filter (status, channel, rush, rider, location, date range) as a vertically-scrollable list inside a slide-up panel — adding a filter dimension in the future means adding a row *inside the drawer*, never a new row on the main screen. The Route/Date/Rider view-mode toggle stays a primary, always-visible segmented control (it's a frequent, not rare, action) rather than being buried in the drawer; `SortControl` is deliberately its own small control, separate from `FilterDrawer`, so sorting is never confused with filtering. The batch-assign bar (Deliveries only) replaces row 2 while active rather than adding a fourth row.

### 3.2 Backend: two additive changes, nothing else

1. **`sort=urgency` on `GET /api/sales`** (`server/routes/sales.js`) — optional param, default behavior (`created_at DESC`) unchanged when omitted, **and unchanged as the frontend's default too** — the user was explicit that the Orders Inbox's default order must not change. `sort=urgency` is only ever sent when a staff member explicitly picks "Urgent first" from the new `SortControl` (§3.1a); "Recent" (today's behavior) stays selected by default on every screen. When requested: `ORDER BY (priority = 'rush') DESC, (scheduled_date IS NOT NULL) DESC, scheduled_date ASC NULLS LAST, scheduled_time ASC NULLS LAST, created_at ASC`. This is the urgency-sort proposal CLAUDE.md already recorded as deferred (originally scoped to the counter_staff dashboard only, and originally imagined as a default there too) — same param now serves Orders Inbox as an opt-in choice, not a default.
2. **`total` added to `GET /api/deliveries`'s response** (`server/routes/deliveries.js`), mirroring the `{ sales, total, limit, offset }` shape `GET /sales` already returns. Currently this endpoint returns a bare array — **this changes the response shape**, so every existing caller (`DeliveriesScreen.js`, `LiveDeliveryMapScreen.js`, `DashboardScreen.js`, any others found during implementation) must be updated in the same change to read `data.deliveries` instead of `data`. The implementation plan must enumerate every current call site before touching the route.

Deliveries' own server-side sort (status ladder → scheduled_date → created_at, `server/routes/deliveries.js:172`) already does roughly what's wanted and is currently discarded by the client's own re-sort (`DeliveriesScreen.js:269-275`) — removing that client re-sort is a deletion, not a new backend feature.

### 3.3 Register-session grouping — no new column

A register session is already fully described by existing data (`cash_registers.opened_at`/`opening_time` → `closed_at`, per location). `DateSessionGroup` fetches that day's sessions for the sale's location once per date shown and matches each order's `created_at` against the session windows client-side — no join, no new column, no migration. **The exact existing endpoint to reuse for "list this day's sessions" needs confirming during implementation planning** — recent register/expense work this project already built session-awareness (e.g. `register_opened_at` on expenses, a `todaySessions` listing CLAUDE.md notes has its own known gap for a register opened yesterday) — the plan should read that code directly rather than this spec guessing at an endpoint name.

## 4. Call/WhatsApp: `ContactButtons` and `utils/contact.js`

**`normalizePhone(raw)`** strips any existing `+91`/`91`/spaces/dashes down to a bare 10-digit number, then every call site formats consistently from that — fixing the `wa.me/9191...` double-prefix bug found in `OrderCard.js`/`SettlementsScreen.js`.

**`telLink(phone)`** → `tel:<10 digits>`. **`waLink(phone, message)`** → `https://wa.me/91<10 digits>?text=<encoded message>`.

**`buildMessage(context)`** — a small template table keyed by `context.type`, replacing today's one-generic-message-fits-all:

| `context.type` | Template |
|---|---|
| `order_ready_pickup` | "Hi, your order {sale_number} is ready for pickup at {location_name}." |
| `order_out_for_delivery` | "Hi, your order {sale_number} is out for delivery." |
| `rider_handoff` | Reuses Settlements' existing good template verbatim: "Hi {name}, please hand over ₹{total} from {N} deliveries when you're at the shop." |
| `tracking_link` | "Hi, you can track your order {sale_number} here: {tracking_url}" |
| `general_inquiry` | Falls back to `OrderCard`'s existing generic opener: "Hi, this is about your order {sale_number}." |

**`ContactButtons({ contacts, context })`** — `contacts` is a list (not a single number), because a delivery order's buyer and receiver can be different people with different numbers (`sender_*`/`receiver_*`/`customer_*` on the sale). One contact → the icon acts immediately. More than one with different numbers → tap opens a two-line picker ("Call the sender" / "Call the recipient") rather than silently guessing precedence, which is what `OrderCard` does today.

Wired into: every row of all three list screens (customer/receiver, plus rider on Deliveries), and `SaleDetailScreen`/`DeliveryDetailScreen` (currently plain text). Minimum 44×44pt tap target, adequate spacing from neighboring icons — these are quick, imprecise taps per the staff-UX checklist, not careful clicks.

**Placement rule carried through every screen below:** on a list row, the one-tap stage action (`nextAction`, when present) is the visually dominant control; Call/WhatsApp/Share-link are smaller, grouped, secondary icons beside it — never equal-weight competing buttons (staff-UX checklist #2).

## 5. Customer order tracking link

**Token — signed, not stored.** `token = "<sale_id>.<hmac>"`, where `hmac = HMAC-SHA256(TRACKING_LINK_SECRET, String(sale_id))` truncated to 32 hex characters (128 bits — infeasible to brute-force). The server verifies by splitting on `.`, recomputing the HMAC for the claimed `sale_id`, and comparing with a constant-time comparison (`crypto.timingSafeEqual`) to avoid timing side-channels on public, unauthenticated code. An invalid token returns a generic 404 — never distinguishing "bad format" from "bad signature," which would leak information to someone probing the endpoint.

Requires one new environment variable, `TRACKING_LINK_SECRET`, alongside however `JWT_SECRET` is already configured. No database column, no lookup table — the same order always produces the same link, and nothing needs to be regenerated or expired.

**`GET /api/track/:token`** — the app's first route with no `authenticate` middleware. Given a valid token, returns only: `sale_number`, a customer-facing stage label (reusing `computeOrderStage()`'s existing labels — already plain language, e.g. "Out for Delivery," not internal jargon), `order_type`, `scheduled_date`/`scheduled_time` if set, and `location_name`. Never returned: amount, payment status, address, any phone number, staff/rider names, cost/margin data.

**Public page** — one new screen registered outside the authenticated navigator, reachable as a plain web URL (`https://<deployed domain>/track/<token>` — assumes the web build referenced in `WEB_DEPLOYMENT_GUIDE.md`/`VPS_DEPLOYMENT_GUIDE.md` is where this resolves; confirm during implementation). No app install, no login.

**Sharing it** — the server attaches a computed `tracking_url` field (a pure function of the sale's `id`, no extra query) to every response that already carries a sale or delivery row and feeds a screen with `ContactButtons`: `GET /sales` (list), `GET /sales/:id` (detail), and `GET /deliveries` (list — via its existing `sale_id`), so no screen needs an extra round-trip to get it. A "Share Tracking Link" action uses `ContactButtons`/`buildMessage('tracking_link', ...)` exactly like every other WhatsApp touchpoint — staff tap, WhatsApp opens pre-filled, they hit send. Nothing sent without a human tapping through.

## 6. Orders Inbox screen

- `OrderListToolbar` (search + a single Filters button opening `FilterDrawer` with status/channel/rush, + `SortControl`) replaces the current two bare chip rows.
- List reorganized under `DateSessionGroup` headers. Default sort stays exactly as today (`created_at DESC`, most recent first) — `SortControl` offers "Urgent first" (rush → soonest-scheduled → oldest-pending, via `sort=urgency`) as an explicit choice staff can switch to, never applied automatically.
- Each row gains: `location_name` (currently invisible when viewing "All Locations" — an owner/manager-relevant gap), the order's time, and the one dominant `nextAction` button (the same mechanism `OrderCard` already uses — `api.advanceOrder`), plus secondary `ContactButtons`/Share-link icons per §4's placement rule.
- Real "Load more" pagination via `useOrderListData`, replacing the silent 100-row cutoff (`total` already returned by `GET /sales` and currently discarded).
- Bug fix folded in: `OrdersHubScreen.js`'s tile count badges read a `data.pagination.total` field that doesn't exist anywhere in the API — they've always rendered 0. One-line fix to read the real `data.total`.

## 7. Deliveries screen

- Moves onto `OrderListToolbar`: search stays visible; status tabs, location, and the new rider filter (server already accepts `delivery_partner_id`, currently unused) all move into `FilterDrawer` instead of permanently-stacked rows. The view-mode toggle (Route/Date, management-only; Date forced for riders) stays a primary, always-visible control — not moved into the drawer — and gains a third option, **By Rider**, grouping the already-fetched batch by `partner_name`, the same client-side technique already used for Route grouping. Route stays the default for management; nothing about the existing default changes. `SortControl` is available here too (default unchanged, "Urgent first" opt-in) even though at-risk-first ordering already exists independently within Route view.
- Every section (Route, Date, or Rider) becomes a `CollapsibleSection`, **default expanded** — collapsing is something staff opt into to declutter, never something that hides an order by default.
- Card redesign: the always-inline full item list becomes a collapsed "3 items ▸" disclosure, opened on tap. Time/countdown, address, rider name, and COD/payment badge stay visible by default — those are what staff actually scan a delivery card for. This should roughly halve the card's height, addressing "~2 cards visible per screen."
- `ContactButtons` added for both customer (currently plain text) and rider (currently buried inside the assign modal).
- The same inline `nextAction` button rows get elsewhere.
- Date range filter: quick preset chips (Today / Yesterday / This Week) plus a picker for anything else, alongside the existing Today/Tomorrow labels in Date view.
- Bugs folded in: the blank section header for unscheduled deliveries (`formatShopDateLabel('_unscheduled')` currently returns `''`) gets a real label, "No Date Set"; the client's own re-sort (`:269-275`) is deleted in favor of trusting the server's existing status-ladder ordering, once `sort` is properly passed through.

## 8. Pickup Orders screen — brought to parity

- Gains `OrderListToolbar` (search didn't exist at all — status stays as tabs, since three mutually-exclusive tabs is already the right control for this screen and doesn't need a drawer), `ContactButtons` (phone isn't even rendered today), the item-list collapse and date-range filter (in `FilterDrawer`) from §7, and switches from re-deriving state off `payment_status` + the current tab to using the shared `display_stage`/`StageBadge` the other two screens already use.
- Starts consuming `GET /deliveries/at-risk`'s pickup rows (`type: 'pickup'`, already returned by that endpoint, currently read by nobody) to flag overdue pickups the same way Deliveries flags at-risk deliveries.
- **Deliberate behavior change, flagged explicitly:** today `PUT /deliveries/pickup/:saleId/ready` has no open-production-task guard, while `PUT /sales/:id/status → 'ready'` (used everywhere else "Mark Ready" appears) blocks with "Cannot mark as ready — N production task(s) still pending." Routing this screen's action through the same guarded path makes it consistent with every other Mark Ready path in the app — meaning a pickup order with unfinished tasks will now correctly block, where before it silently didn't. Per the staff-UX checklist, the existing plain-language error message must actually surface on this screen (not get swallowed by a generic handler) — this is a stated requirement for the implementation plan to verify, not an assumption.

## 9. Staff-UX checklist compliance notes

Checked explicitly against `.claude/skills/staff-ux-checklist` before finalizing this design:
- **#3 (common case is the shortest path) / #7 (tap targets):** the bounded toolbar (§3.1a) exists specifically so the filter UI can never grow to crowd out the list or push controls out of easy reach, regardless of how many filter dimensions this or a future spec adds — the failure mode diagnosed in the current `DeliveriesScreen.js`.
- **#9 (nothing removed, only relocated):** every filter that moves into `FilterDrawer` is still one tap away (open drawer, tap filter) — none are deleted, just no longer permanently occupying screen space for the common case of "no filters active."
- **#2 (one obvious next action):** the placement rule in §4 exists specifically to prevent the new Call/WhatsApp/Share/nextAction icons from turning into a wall of equal-weight buttons on every row.
- **#6 (errors say what to do):** the Pickup Mark Ready guard change (§8) is flagged precisely because it's a new blocking path staff will hit; the existing plain-language message must reach this screen, not a raw error.
- **#7 (tap targets):** 44×44pt minimum and spacing called out explicitly in §4, since this design adds 2–3 new icon buttons per row where 0–1 existed before.
- **#8 (role-scoped views):** the rider filter and By Rider view are gated behind the same `canManageDeliveries`/`isManager` checks already governing Route-mode and location chips today — a rider still only ever sees their own deliveries, unchanged.
- **#9 (nothing removed, only relocated):** collapsing the item list behind a tap doesn't delete information, and deleting the client's redundant re-sort doesn't change what's shown, only how it's ordered. The Pickup guard change is the one exception — it's an intentional tightening, called out rather than silently shipped.

## 10. Testing / verification approach

Following this project's established pattern (`server/scripts/verify-*.js`): the two backend changes (`sort=urgency`, `GET /deliveries` response shape, the new `GET /api/track/:token` route) get permanent regression checks added to an existing or new verify script — the tracking-token check specifically must assert that a tampered/guessed token returns 404 (not partial data), and that a valid token never leaks fields outside the allowed set. Frontend changes get `node scripts/babel-check.js` per touched file, per this project's established workflow. Given the scope (three screens, a new shared toolkit, a new public route), the implementation plan should sequence work so each shared module lands and is verified before the screens that depend on it are rewritten, rather than building everything in parallel and integrating at the end.
