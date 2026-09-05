# Investigation Findings — Dashboard Order-Flow Bugs + Layout

Repo: `/Users/gauravbhatia/Downloads/Projects/test Project`
Branch: `feature/identity-roles-pin-login`. **Note:** actual `HEAD` at the time of this
investigation is `76bc6fe` ("Handoff: dashboard order-flow bugs + owner/manager layout"),
one commit past the `fd60780` named in the brief. The diff between them is doc-only
(`HANDOFF_NEXT_SESSION.md`, +187 lines) — no app/server code changed, so all code-level
findings below are equally valid against either SHA. `HANDOFF_NEXT_SESSION.md` (committed at
`fd60780`) independently records the same root causes as the brief, plus extra traps —
cross-checked against it throughout.

Dev server: confirmed running as `node server.js` (PID 39179, started 2026-09-03 19:23:38,
**before** `fd60780` was committed at 19:34:39 — but that commit only added a doc file, so the
server is serving current code; verified by re-deriving the evidence live rather than trusting
this). Auth: generated JWT tokens directly (`jwt.sign({id, role}, JWT_SECRET)`, mirroring
`server/routes/auth.js`'s `generateToken()`) for owner (id 1), manager (id 2, locations 1/2/3),
and counter_staff (id 148, locations 1 and 4) — no login flow needed since the token shape is
just `{id, role}`. All calls below are real HTTP requests to `localhost:3001`, not DB-only
inference, except where explicitly labeled "DB only."

---

## Issue 1 — owner/manager dashboard shows no orders

**CONFIRMED**, end-to-end through the live API, at **both** locations, and today's numbers are
worse than the previously-recorded evidence.

Reproduced exactly:
- Owner/manager: `GET /api/sales?location_id=<id>&filter_date=<today, local date>&limit=500`
- Counter staff: four calls, `GET /api/sales?status=<pending|confirmed|preparing|ready>&location_id=<id>&limit=30`

| | Location 1 (Main Shop) | Location 4 (Test Loc) |
|---|---|---|
| Owner/manager (`filter_date=2026-09-04`) | **0** rows | **0** rows |
| Counter staff (4 fetches combined) | 26 rows (0+0+18+8) | 67 rows (26+1+21+19) |

Both locations are **zero** for owner/manager today — worse than the evidence in the handoff doc
(location 4 had 7 matches on 2026-09-03; today it has 0). This is a **date-dependent** bug: the
count for owner/manager swings entirely on whether any order happens to be scheduled/created
"today" by the server's date math, while counter staff's undated fetch is stable. On a slow day
at either location, the owner/manager board is empty; today happened to be a slow day at both.

One real find during reproduction, worth flagging even though it didn't change the conclusion: my
first pass used `new Date().toISOString().slice(0,10)` (UTC) to compute "today" and got a
different, non-zero answer at location 4. The **app itself never does this** — `DashboardScreen.js`
builds `filter_date` from **local** `getFullYear()/getMonth()/getDate()` (`:399-402`), which is
correct for a shop in IST. I initially reproduced the request with the wrong "today" and it
silently produced a plausible-looking but wrong result — exactly the "a 200 is not evidence" trap
named in the brief, self-inflicted rather than found in the app. Flagging in case it saves the
next person the same detour: **any script computing "today" for this app must use local date
parts, not `toISOString()`.**

`filter_date`'s SQL (`server/routes/sales.js:206-208`) matches the description exactly:
`scheduled_date = ? OR (scheduled_date IS NULL AND created_at within that day)`.

**Truncation check:** `limit: 30` per status did **not** truncate anything today at either
location — every status's returned count equals its `total` field (confirmed via the API
response, not just row count). Margin is not huge though: location 4's `preparing` returned 21/30
and `ready` 19/30 — comfortably under today, but this limit has no backstop if either status lane
grows past 30 on a single day (no pagination, no "N more" affordance on this particular fetch —
unlike `StageColumn`'s own `COLUMN_CARD_CAP`, which is a client-side render cap on data already
fetched, not a fix for this).

**Conclusion:** the owner/manager board renders **zero cards at both locations right now**,
confirmed live, not just via DB inference. The product question named in the brief (should this
board be date-scoped at all, or show open work like the counter board does) is unresolved and
out of scope for this investigation — flagging, not deciding.

---

## Issue 2 — "Done today · N" chip never appears

**CONFIRMED**, both structurally (code reading) and empirically (live DB query, zero
counter-examples).

`OrderKanbanBoard.js:118-153`: `doneCount` increments only when `isClosedStage(sale.display_stage.key)`
is true, gated on `CLOSED_STAGE_KEYS = ['delivered', 'picked_up', 'completed', 'cancelled']`
(`app/src/constants/orderStages.js:33`). The chip itself is gated on `doneCount > 0`
(`OrderKanbanBoard.js:189`).

Counter staff's four fetches (`pending`, `confirmed`, `preparing`, `ready`) never request
`completed` or `cancelled` sales, so on paper `doneCount` should always be 0. I checked whether a
sale could reach a closed `display_stage.key` (`delivered`/`picked_up`) while its raw
`sales.status` is still one of the four fetched values — `computeOrderStage()` derives
`picked_up`/`delivered` partly from `pickup_status`/`delivery_status`, not only from
`sales.status`, so this isn't automatically impossible from reading the ladder alone. I checked
both ways:

- **Code**: `PUT /deliveries/pickup/:saleId/picked-up` and `PUT /deliveries/:id/deliver` both set
  `sales.status = 'completed'` in the **same transaction** as the field that flips the closed
  `display_stage.key` (`pickup_status='picked_up'` / `deliveries.status='delivered'`) — so the two
  can never be observed apart mid-flight from a fresh read.
- **Data**: live query for any sale with `status IN ('pending','confirmed','preparing','ready')`
  AND (`pickup_status='picked_up'` OR a joined delivery `status='delivered'`) — **0 rows**,
  DB-wide, not just at Test Loc.

**Conclusion: unreachable by construction**, exactly as stated. Fixing Issue 1 fixes the
owner/manager half (empty `sales` → `doneCount` 0 is a pure symptom). The counter half needs its
own fix (the brief's own suggestion — deriving the count from the API's `total` field rather than
requiring a fifth fetch — looks sound based on what's now confirmed, but that's a build decision,
not this investigation's call).

**Additional, not previously noted:** `app/src/screens/DashboardScreenV2.js` (the parallel,
flag-toggled dashboard, `pref_new_v2_ui` currently `'0'` in the live settings table — so V1 is
what's actually rendering today) has the **identical** `filter_date`-from-`dateScope`-defaulting-
to-today pattern for owner/manager (`DashboardScreenV2.js:602-603`). Not exercised further since
it's not the active screen, but if `pref_new_v2_ui` is ever flipped on, Issue 1 reproduces there
too. Worth a line if/when V2 is picked back up.

---

## Issue 3 — owner/manager board squeezed by Team & Finance column

Facts gathered, no design work done, per instructions.

**JSX** (`app/src/screens/DashboardScreen.js:1646-1747`, the owner/manager branch, inside the
screen's single outer `ScrollView`, `:1066`–`:1750`):
```
1646  <View style={[styles.layout, isDesktop && styles.layoutDesktop]}>
1647    <View style={[styles.feedCol, isDesktop && { flex: 2 }]}>
          ...OrderKanbanBoard...
1671    <View style={[styles.healthCol, isDesktop && { flex: 1 }]}>
          ...Team & Finance widgets...
1746    </View>
1747  </View>
```
**Styles** (`:2073-2076`): `layout: { gap: 16 }`, `layoutDesktop: { flexDirection: 'row', alignItems: 'flex-start' }`,
`feedCol: { gap: 8 }`, `healthCol: { gap: 8 }`. The two-column split is purely `isDesktop`
(`useBreakpoint.js`, **1100px**), matching the brief exactly.

**Widgets in `healthCol`, with line numbers and role gating:**
| Widget | Lines | Gated on |
|---|---|---|
| Staff Pulse | `:1667-1683` | none — every owner/manager sees it |
| Registers | `:1685-1710` | `isOwner` only |
| Revenue Snapshot (Today/Yesterday/Week) | `:1712-1745` | `isOwner` only |

Worth surfacing for the eventual design pass: **a manager sees only Staff Pulse** in that column —
two of its three widgets are owner-gated — so today a manager's side column is one small card
consuming a full `flex: 1` (roughly a third of desktop width). The squeeze the owner reported is
worse, proportionally, for managers than for the owner.

**What would make the move non-trivial:**
- **Nothing structural.** Both columns live inside the one screen-level `ScrollView` — no nested
  scroll containers, no separate scroll position to reconcile. Reordering is a plain JSX move.
- **No cross-column shared state** beyond the single `fetchDashboard()` populating `sales`,
  `registers`, `reportKPIs`, `staffPulse` together — a JSX reorder doesn't touch data fetching.
- **The FAB** (`styles.fab`, `position: 'absolute'`) is unaffected by column order.
- **Real (but design, not engineering) work**: `layoutDesktop`'s `flexDirection: 'row'` and the
  inline `flex: 2` / `flex: 1` splits are keyed to a side-by-side layout; stacking below needs
  those conditional styles replaced with a stacked equivalent, and `widgetCard` (`:2095-2107`,
  a narrow vertical card shape) plus the Revenue Snapshot's stat layout were sized for a ~1/3-width
  column — moved to full width below the board they'll likely want a row-of-cards treatment
  instead of stretching one column's worth of copy across the whole page. That's exactly the kind
  of decision the brief said not to make here.
- The known `isWide`(900)/`isDesktop`(1100) breakpoint split is unrelated to this move and doesn't
  need touching — the board's own column count is governed by `isWide` regardless of where
  `healthCol` ends up.

---

## Order-flow testing (Test Loc, `location_id = 4`, read-only — no writes were made)

All four order types were fetched live and their `display_stage` checked for coherence, endpoint
preconditions were compared against `order-stage.js`'s own mirrored guard comments, and
`GET /sales` was diffed against `GET /deliveries` for every Test Loc sale with a delivery row (25
of them). **No writes were made anywhere** during this investigation (all calls were `GET`); no
fixture cleanup is needed.

### `GET /sales` vs `GET /deliveries` for `display_stage`
**No mismatches.** All 25 Test Loc sales with a delivery row (spanning `pending`, `assigned`,
`picked_up`, `in_transit`, `delivered`, `failed`, `cancelled` delivery statuses) returned
byte-identical `display_stage` from both routes.

### New findings

1. **Low severity / cosmetic — a card can say "`<rider>` has it" for a delivery only *assigned*,
   not yet physically picked up from the shop.** `OrderCard.js`'s `resolveDeadEnd()` (the ready/
   ready_for_pickup branch, `:92-129`) treats any non-`delivered`/`cancelled` delivery status —
   including `assigned` — as "has an open delivery," and once `delivery_partner_name` is set it
   renders `"${partner_name} has it"`. Live example: sale 313 (Test Loc, `pre_order` fulfilled by
   delivery, delivery `assigned` to rider "Vishal", not yet picked up) would show "Vishal has it"
   on the dashboard card, which reads as "left the shop" when the item is still on the counter.
   This is a sharper, user-facing manifestation of the gap CLAUDE.md's roadmap already names
   ("assigned-but-not-collected has no distinct sub-state") — that entry frames it as a missing
   stage/action; this is the same root cause producing a literally inaccurate status line, which
   is a step further than "cosmetic" for a UX principle this project holds explicitly (no
   misleading status text). Confirmed live for both a `pre_order`-with-delivery (sale 313) and
   plain `delivery` orders (sales 307, 309) — same code path, same result. Not a dead end (a
   status line does render) and not a new root cause — flagging as a concrete instance of the
   already-known, already-deferred gap, worth linking if that gap is ever picked up.

2. **Data-only inconsistency, no functional impact — `pickup_status` lags `status` on 2 live Test
   Loc orders.** Sales 305 and 354: `status = 'ready'` but `pickup_status` still `'waiting'`
   (not `'ready_for_pickup'`). `computeOrderStage()`'s pickup ladder ORs the two fields
   (`sale.status === 'ready' || sale.pickup_status === 'ready_for_pickup'`), so both still compute
   the correct `ready_for_pickup` stage and correct (balance-due-gated) `nextAction`, confirmed via
   `GET /sales/305` and `/354`. Not investigated further — root cause of the field drift (some
   write path sets `status` without also setting `pickup_status`) is outside this investigation's
   scope, but noted since the two fields are meant to move together.

3. **Fact, not a bug — every `preparing` order in the whole live DB (39 of 39, all locations) has
   at least one open production task**, so **zero** live orders currently reach `preparing` with a
   one-tap "Mark Ready" available; all require clearing tasks first. Confirmed this is handled
   correctly, not a dead end: `OrderCard.js`'s `preparing` branch of `resolveDeadEnd()` renders an
   "N tasks to finish" routing button rather than nothing. Recorded because it means the
   Mark-Ready-guard code path (the 2026-09-02 fix CLAUDE.md documents) has **no live positive
   test today** — every observation of it in this session was the guard correctly blocking, never
   correctly allowing. Worth a synthetic check next time that code is touched.

4. **Re-checked and ruled out — the documented "'assigned' delivery could get a dead-end 'Mark
   Delivered' button" risk does not occur.** Reading `order-stage.js`'s branch order in isolation
   suggested `delivery_status='assigned'` combined with `cod_amount=0` could fall into the
   `out_for_delivery` branch and offer "Mark Delivered" against an endpoint that only accepts
   `picked_up`/`in_transit` (4 of 7 live `assigned` deliveries DB-wide have `cod_amount=0` and
   would hit this if it were real). Live API calls against the actual sales (`GET /sales/134`,
   `/106`, `/129`, `/234`, all Main Shop, read-only — no location-1 write was made) all returned
   `display_stage.key: 'ready'`, `nextAction: null`. Re-reading the branch order: the plain
   `'ready'` branch's condition excludes only `picked_up`/`in_transit`/`delivered` from
   `delivery_status`, not `assigned` — so `assigned` matches the **first** (`ready`) branch and the
   code never reaches the `out_for_delivery` branch at all. This is exactly the pre-existing,
   already-documented CLAUDE.md gap ("computeOrderStage()'s delivery ladder checks the plain
   'Ready' branch... before the 'Out for Delivery' branch... cosmetic only... nothing gets
   stranded") — recording that I chased what looked like a new endpoint-precondition bug, and live
   API evidence (not just code reading) ruled it out as already covered by that known entry.

### Everything else checked and found consistent
- `walk_in` initial-status claim in CLAUDE.md ("only ever `preparing` or `completed`, never
  `pending`") — confirmed DB-wide: zero `walk_in` rows with `status='pending'` exist anywhere.
  (One `walk_in`, sale 306, is `status='confirmed'` — not a contradiction, since the claim is
  specifically about `'pending'`; `computeOrderStage()`'s `isNew` check already treats `pending`
  and `confirmed` identically, and live API calls as both owner and counter_staff on sale 306
  correctly returned `{key: 'new', nextAction: 'Start Preparing'}`.)
- COD-outstanding `out_for_delivery` orders (sale 303: `nextAction: null`) and unassigned-rider
  `ready` delivery orders (sale 310: `nextAction: null`) both correctly route to a status
  line/action via `OrderCard.js`'s `resolveDeadEnd()` rather than rendering blank — no failure-
  class-C dead end found in either case.
- `Mark Delivered` on a genuinely `picked_up` delivery (sale 356) correctly offers the action and
  the target endpoint's own guard (`picked_up`/`in_transit` accepted) would accept it.

---

## What could not be verified

- **Nothing rendered in a browser.** Per `HANDOFF_NEXT_SESSION.md` §7, no prior session ever opened
  the app in a browser either — this investigation is API/DB/code evidence only, same as the
  established root causes it's confirming. The layout facts in Issue 3 are code-derived; actual
  rendered crowding at 900–1100px was not visually confirmed here.
- **The "$X still to collect" / "Record COD" / "Assign Rider" status-line and routing paths in
  `OrderCard.js`'s `resolveDeadEnd()`** were confirmed to be *reached* (the right branch, the right
  copy) but the destination screens themselves (`AddPaymentScreen`, `SettlementsScreen`,
  `DeliveryDetailScreen`'s rider assignment) were not opened or exercised — only code-read, per the
  file's own extensive comments about which roles each destination actually admits.
- **No mutating call was made against any endpoint**, including ones with preconditions I traced
  by reading code (e.g. `/deliveries/:id/deliver`'s status guard). Confidence there rests on
  reading the guard plus a live *read* of the delivery/sale rows it would act on, not on actually
  firing the call — consistent with the instruction to prefer read-only verification and only
  write against Test Loc with cleanup, which no finding here required.
- **Manager-role location scoping** (whether a manager token for a location outside their
  `user_locations` rows is correctly rejected/scoped) was not tested — out of scope for the three
  reported issues, not attempted.
- **V2 dashboard** (`DashboardScreenV2.js`) was read but not live-tested (its `pref_new_v2_ui` flag
  is off in the live settings table, so it isn't reachable today) — the Issue-1-shaped pattern in
  its code was noted, not reproduced via API.
