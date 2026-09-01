# Dashboard Stage UI Redesign — Design

**Date:** 2026-09-01
**Branch:** `feature/identity-roles-pin-login`
**Status:** Approved, ready for implementation planning
**Predecessor:** `docs/superpowers/specs/2026-09-01-order-lifecycle-delivery-management-design.md`

## 1. Why this exists

The order-lifecycle sub-project built `computeOrderStage()` (`server/utils/order-stage.js`)
to be the single source of truth for what stage an order is in. It computes
`{ key, label, color, nextAction }` and the server attaches it to every order on
`GET /sales` (`server/routes/sales.js:292`) and `GET /sales/:id` (`:1323`).

**Only `nextAction` is consumed anywhere. `label` and `color` are rendered by zero
screens.** Every screen still derives its own status vocabulary from raw
`status` / `payment_status` / `pickup_status` / `delivery_status` — the exact
duplication the stage model was built to remove.

The user hit this live: the counter_staff dashboard shows an old orange "Pending"
badge and a Q/A/IP/D task-pipeline row, not the Stage. Their words on the result:
*"the current dashboard UI is very bad, how orders and information are displayed
and options are provided looks cluttered and unprofessional."*

Three separate problems, addressed together because they touch the same files:

1. **The Stage is computed and thrown away.** Screens disagree with each other and
   with the model the redesign was built around.
2. **No responsive treatment.** `OrderKanbanBoard.js:419` computes
   `isDesktop = width >= 1100` and uses it for exactly one thing at `:507` —
   `previewCount = isDesktop ? 2 : 1`. It changes how many cards preview, never the
   layout. On a 1400px browser the board renders as one mobile-width column in an
   otherwise empty page, by construction.
3. **Card clutter.** One card renders 13 distinct visual elements, several of them
   saying the same thing twice.

## 2. Goals / non-goals

**Goals**
- Render `display_stage.label` / `.color` as the primary status everywhere an order's
  state is shown.
- One unified Stage board that uses the full width of a desktop/tablet viewport.
- A card that shows what is needed to decide, and hides what is merely true.
- No card is ever a dead end — every state offers a way forward.
- Collapse the three coexisting one-tap status mechanisms into one.

**Non-goals**
- No schema change. Nothing here adds a column, table, or migration.
  `display_stage` stays computed-fresh-per-request and is never stored.
- `DashboardScreenV2.js` and the `pref_new_v2_ui` flag are **not** removed. Its
  responsive *ideas* are ported; the file stays on disk as reference. The
  "two parallel dashboards" entry in `CLAUDE.md` stays open.
- No desktop side-panel. Order detail stays in the existing modal
  (`OrderQuickModal`), per explicit user preference.
- No new backend endpoint. §5 is delivered entirely client-side against the
  existing `nextAction: null` contract.

## 3. Stage columns

`computeOrderStage()` emits nine `key` values. The board collapses them to four
live columns plus one closed bucket:

| Column | `display_stage.key` |
| --- | --- |
| **New** | `new` |
| **Preparing** | `preparing` |
| **Ready** | `ready`, `ready_for_pickup` |
| **Out for Delivery** | `out_for_delivery` |
| *(no column)* | `delivered`, `picked_up`, `completed`, `cancelled` |

`ready` and `ready_for_pickup` merge: to the person at the counter they mean the
same thing — the flowers are done and waiting. The per-card type icon already
distinguishes which kind of waiting.

Done and cancelled get no column deliberately. A Done column fills up all day, would
dominate the board by volume, and is the one bucket nobody needs to act on. It
becomes a header count chip (`Done today · 14`) linking to Orders Inbox filtered —
the screen actually built for browsing history, with search, filters, and a
virtualized list.

This mapping lives in `app/src/constants/orderStages.js` as data, not as branching
logic scattered across components.

## 4. Component split

`components/OrderKanbanBoard.js` is 991 lines holding the card, the lane, the
grouping, the SLA math, and all styles. It is the file this work changes most, so
it is split as part of the work rather than grown further:

| File | Responsibility |
| --- | --- |
| `components/orderBoard/OrderCard.js` | One card (§6) |
| `components/orderBoard/StageColumn.js` | Column on wide, collapsible section on narrow — same props both ways |
| `components/orderBoard/OrderKanbanBoard.js` | Grouping, type filter chips, responsive switch |
| `components/StageBadge.js` | Renders `display_stage.label` + `.color` |
| `constants/orderStages.js` | The §3 table, as data |
| `hooks/useBreakpoint.js` | One breakpoint computation |

`StageBadge` is a component, not a copied `<View>`, specifically so the
single-source-of-truth property holds across its four consumers: the card,
`SaleDetailScreen`, the Orders Inbox list, and `DeliveriesScreen`.

`useBreakpoint` retires the two independent `width >= 1100` computations that
`DashboardScreen.js:217` and `OrderKanbanBoard.js:419` currently maintain, each
with a comment asking whoever changes one to remember the other.

## 5. Responsive behaviour

One breakpoint at **900px**, from `useBreakpoint()`:

- **≥ 900** — stage columns side by side, each `flex: 1`, filling available width,
  each scrolling independently.
- **< 900** — the same `StageColumn` renders as a stacked collapsible section with
  a count in its header. Pure vertical scroll, no gesture to learn (`CLAUDE.md`
  forbids hidden gestures), and it matches how the board already behaves today.

Ported from `DashboardScreenV2.js`: the 900px threshold and the palette derived from
`constants/theme`. Not ported: the desktop side-panel, and V2's `LANE_DEFS`, which
§3's table supersedes.

Type is a **filter, not a section**. Chips above the board (`All` / `Delivery` /
`Pickup` / `Walk-in` / `Pre-order`) plus a type icon on every card replace the
current nested type→lane→card grouping, which is the structural source of the
cluttered feel. Nothing is lost: any grouped view is one chip tap away.

## 6. The card — exceptions only

**Always shown:** type icon, order number, customer name, amount, `<StageBadge/>`,
and the action row (§7).

**Shown only when true:**

| Element | Condition |
| --- | --- |
| ⚠ late / due soon | existing `getOrderLaneSla()`, now per-card rather than a lane-level count only |
| ⚠ unpaid / partial / credit | existing payment badge, minus the `PAY:` prefix jargon |
| `1 of 3 tasks` | tasks exist and are not all complete |
| scheduled time | `pre_order` / `pickup` / `delivery` only — a real commitment; dropped for `walk_in` |

**Retired from the card** (all still present in the tap-through modal):

- the raw status badge — `StageBadge` replaces it
- the delivery sub-status row and the pickup sub-status row — `display_stage.label`
  already says "Out for Delivery"; the pair rendered "Pending" and "Assigned" as two
  separate elements saying one thing
- the `Placed:` timestamp
- the Q/A/IP/D pipeline dots — `1 of 3 tasks` carries the same information in words a
  first-time user can read without a legend

Net: 13 elements down to 5, plus up to 4 conditional. A healthy order sits at 5.

Also fixed here: `OrderKanbanBoard.js:297` has a stray `\` in JSX text before
`Placed:`, rendering as a literal backslash.

## 7. No card is ever a dead end

`nextAction` is `null` in more states than the card currently handles, and the card
treats null as "render nothing" — leaving a wall. Audited across every ladder in
`order-stage.js` for a counter_staff viewer:

| Order type | New | Preparing | Ready | Out for delivery |
| --- | --- | --- | --- | --- |
| walk_in / pre_order | Start Preparing | Mark Ready | Complete | — |
| pickup | Start Preparing | Mark Ready | **null if balance due** | — |
| delivery | Start Preparing | Mark Ready | **always null** | **null for counter_staff** |

Four dead-end states. Each gets a secondary action routing to the screen that can
resolve it, in plain language:

| State | Card shows | Routes to |
| --- | --- | --- |
| Pickup ready, balance due | `Collect ₹1,200 →` | payment flow |
| Delivery ready, no rider | `Assign Rider →` | rider picker |
| Delivery out, COD owed | `Record COD →` | settlement |
| Delivery out, counter_staff | *no button* — `Ravi has it · out 40 min` | detail on tap |

The last row is intentionally not a button. Marking a delivery delivered is not
counter staff's action — `ENDPOINT_ROLES.DELIVERY_DELIVER` omits `counter_staff`
deliberately — and inventing a button would hand them a 403. They still need the
information (customers ring up asking), so it renders as status, not as a control.

No backend change. `nextAction: null` already means "not safe as a blind one-tap";
the client stops reading that as "render nothing" and starts reading it as "route to
where a human decides."

## 8. One status mechanism, not three

Three independent one-tap status mechanisms currently coexist in this flow:

| # | Where | Driven by |
| --- | --- | --- |
| 1 | `OrderKanbanBoard.handleQuickAction` (`:447`) | `display_stage.nextAction` |
| 2 | `DashboardScreen.advanceOrderStatus` — "Orders Needing Attention" | raw `status` |
| 3 | `OrderQuickModal` status buttons (`QuickModals.js:170–179`) | raw `status` |

All three converge onto `display_stage.nextAction` + §7 routing.

Mechanism 3 matters most and was nearly missed: `OrderQuickModal` is what opens when
a card is tapped. Leaving it on raw status would mean the card shows the new Stage
vocabulary and the modal one tap behind it shows the old — reproducing the exact
mismatch this work exists to remove, one level deeper. Its raw status badge and its
`PAY: UNPAID` badge are replaced by `StageBadge` and the §6 payment treatment.

## 9. Stage badge beyond the dashboard

`<StageBadge/>` also replaces the locally-derived status display on:

- `SaleDetailScreen`
- Orders Inbox list rows
- `DeliveriesScreen`

`GET /sales` already carries `display_stage`, so Orders Inbox and SaleDetail need no
backend work.

`GET /deliveries` (`server/routes/deliveries.js:141`) does **not** — the file never
imports `computeOrderStage`. Attaching it there is an additive response-shape change,
no schema change, but it needs an adapter rather than a direct call, because the
delivery row's field names collide with what `computeOrderStage()` expects:

| `computeOrderStage()` expects | Delivery row has |
| --- | --- |
| `status` (the *sale's* status) | `order_status` — `status` is the **delivery's** status |
| `delivery_status` | `status` |
| `delivery_id` | `id` |
| `id` (sale id) | `sale_id` |

Passing the row directly would silently feed the delivery's status in as the sale's
and produce a wrong stage on every row. `server/routes/sales.js:1323` already
establishes the adapter pattern (`computeOrderStage({ ...mapped fields })`) — follow
it. The `SELECT` also needs `s.pickup_status` added; `d.*` already supplies the COD
fields.

## 10. Pre-order completion guard (ships first, independently)

Found during this brainstorm and separable from all UI work. `server/routes/sales.js`
has two completion guards, both keyed on `order_type`:

- `:2268` — `status === 'completed' && sale.order_type === 'delivery'` blocks
  completing while a delivery is not yet `delivered`
- `:2279` — `status === 'completed' && sale.order_type === 'pickup'` blocks
  completing while a balance is due

A `pre_order` fulfilled by either route **bypasses both**. It can be one-tap completed
with a rider still holding the flowers and with money still owed. The handoff from the
prior session flagged only the delivery half; the payment half is the same bug.

Fix: both conditions widen to include a `pre_order` that has a delivery row / an
outstanding balance. Additive condition change, no schema change, no new endpoint.
Ships before the UI work — it is a live money-and-data-integrity risk and shares no
code with the rest of this design.

Note the ordering interaction: this fix starts rejecting a completion the card
currently offers. §7 is what makes that acceptable — the card offers
`Assign Rider →` rather than a button that now fails.

## 11. Staff UX checklist

Run per `.claude/skills/staff-ux-checklist`. The two items that changed the design:

- **#2 (exactly one obvious next action)** and **#6 (errors say what to do next)** —
  both failed on the four dead-end states. A card showing that something is stuck
  without saying what to do about it is the same failure class as a technical error
  message. §7 exists because of this.
- **#8 (role's home screen shows only what that role needs)** — drove the
  counter_staff out-for-delivery treatment in §7: they need the information, not a
  control they cannot use.

Other items: **#7** (tap targets) — the §6 card has fewer, larger elements. **#9**
(functionality moved, not missing) — everything retired from the card in §6 remains
in the modal; the type grouping removed in §5 returns via filter chips.

## 12. Verification

No automated test runner exists in this project. The established method:

- `verify-identity-roles.js` — expect 10/10, unchanged
- babel-transform clean on every touched frontend file
- live curl + on-screen tracing against the dev server at **Test Loc
  (`location_id 4`)** — never Main Shop (`location_id 1`)

Traces required: one order of each of the four types walked through every stage of its
ladder, plus each of §7's four dead-end states reached deliberately and confirmed to
offer the routing action rather than nothing. §10's guard verified by attempting to
complete a `pre_order` with an undelivered delivery and with an outstanding balance,
confirming both are now refused with a plain-language message.

## 13. Explicitly deferred

- Retiring `DashboardScreenV2.js` and the `pref_new_v2_ui` flag — user chose to keep
  V2 as reference. `CLAUDE.md`'s two-dashboards debt entry stays open.
- The `sort=urgency` param on `GET /sales` and the capped dashboard page from
  roadmap item 3. It was raised as a natural companion to converging mechanism #2 and
  was **not** selected for this scope.
- The per-rider aggregate load manifest (per-delivery checklist shipped; aggregate
  view never built).
- `ProductionQueueScreen` audit — still flagged for a future pass.
