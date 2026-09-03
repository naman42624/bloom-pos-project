# SDD ledger — plan: docs/superpowers/plans/2026-09-02-dashboard-stage-ui-redesign.md

Spec: docs/superpowers/specs/2026-09-01-dashboard-stage-ui-redesign-design.md (read, binding authority)
Branch: feature/identity-roles-pin-login
Merge base for final review: de08e17

## Ruling: no separate worktree
Work continues on feature/identity-roles-pin-login rather than an isolated worktree.
Why: this plan's ONLY verification method is live tracing against the running dev
server + Expo web at localhost:8081, both pointed at this checkout. A worktree would
need a second server/DB wiring for zero isolation benefit — the branch is already
isolated from main, and nothing here touches main.
Cost if wrong: work lands on the feature branch instead of a throwaway one. Reversible
by branching from any commit.

## Pre-flight conflict scan

### Task pairs sharing a file or interface
| Pair | Produces → Consumes | Finding |
|---|---|---|
| T1 ↔ T4 | both edit `server/routes/sales.js` | Disjoint regions: T1 at ~2267-2288 (guards), T4 at ~200-205 (SELECT). T4's region precedes T1's, so T1-first leaves T4's line refs valid. CLEAN |
| T2 → T5 | `TYPE_ICONS` | Signature match. CLEAN |
| T2 → T7 | `STAGE_COLUMNS`, `TYPE_FILTERS`, `columnKeyForStage`, `isClosedStage` | All four exported by T2, all four imported by T7. CLEAN |
| T2 → T7,T8 | `useBreakpoint` default export → `{width,isWide}` | CLEAN |
| T3 → T5,T9,T10 | `StageBadge` default export, props `{stage,size}` | CLEAN |
| T4 → T5 | `delivery_partner_name` on GET /sales → `resolveDeadEnd` status line | CLEAN |
| T4 → T10 | `display_stage` on GET /deliveries | CLEAN |
| T5 → T7 | OrderCard props | T7's `renderCard` passes exactly T5's 7 props. CLEAN (after the plan's own self-review dropped the unused `viewerRole` from both) |
| T6 → T7 | StageColumn props `{column,orders,isWide,collapsed,onToggleCollapse,renderCard}` | T7 passes all six. CLEAN |
| T7 → T8 | new board module path + prop set | T8 drops `onNavigateToQueue`/`taskActionLoading`/`onTaskPress`, which T7 no longer accepts. CLEAN |
| T5 ↔ T8 | `formatCardDateTime` | **CONFLICT — see Ruling below** |
| T8 → T11 | deletion of old board → grep-clean assertions | T11 asserts `ORDER_PHASE_LABELS` greps clean; verified it is defined and used ONLY in the file T8 deletes. CLEAN |
| T9, T10 | independent of each other, both depend only on T3 | CLEAN |

### Per-task internal consistency
| Task | Finding |
|---|---|
| T1 | Guard code + babel-check script + its own verification step agree. CLEAN |
| T2 | Exports match the Step 4 sanity-check's expected output. CLEAN |
| T3 | CLEAN |
| T4 | Adapter reads `row.pickup_status`, which Step 2 adds to the SELECT. CLEAN |
| T5 | `getOrderSla` returns `{level:'late'\|'soon'}`; card checks `level==='late'`. All `Colors.*` tokens verified present in theme.js. CLEAN except the import ruled on below |
| T6 | `Colors.surfaceAlt` verified present. CLEAN |
| T7 | All imports used; buckets keyed off STAGE_COLUMNS. CLEAN |
| T8 | Both call sites written out explicitly; `isDesktop` confirmed still used at :1167 so it is replaced not deleted. CLEAN |
| T9 | Line refs :80/:170-179/:201-209/:262 verified against the file. CLEAN |
| T10 | Instructs the implementer to locate each screen's badge before editing rather than assuming — intentional, those three screens were not read during planning. CLEAN |
| T11 | Verification file list covers every file created or modified by T1-T10. CLEAN |

## Ruling: formatCardDateTime — import it, do not move it
Finding: Task 5 Step 3 tells the implementer to move `formatCardDateTime` out of
`components/OrderKanbanBoard.js:85` into `constants/orderDisplay.js`. Two problems:
(1) it ALREADY exists as an exported function at `app/src/utils/datetime.js:61` and is
already imported from there by printHelpers.js, SaleDetailScreen.js and
OrdersInboxScreen.js — the board's copy is a redundant shadowing duplicate, so the plan
would have created a THIRD location; (2) genuinely moving it out of the old board would
break that board, which DashboardScreen still imports until Task 8 — a transient broken
tree across three tasks.
Verified the two implementations are functionally identical; the utils/datetime.js one
is strictly better (guards NaN date parts, which the board's copy does not).
Decision: Task 5 imports `formatCardDateTime` from `../../utils/datetime`, alongside the
`minutesSinceServerDate`/`minutesUntilShopDateTime` it already imports from there.
`constants/orderDisplay.js` is NOT touched by Task 5. The duplicate dies with the file
in Task 8.
Cost if wrong: near zero — same function, same signature, one import line's difference.

## Task log

## Ruling: Task 10 — exactly which badge on each screen (resolved ahead of dispatch)
The plan told the Task 10 implementer to locate each screen's badge idiom before
editing, because those three screens were not read during planning. Read them during
Task 1's run; resolving here so the dispatch carries a decision, not a question.

- `SaleDetailScreen.js:859` — `{sale.status?.toUpperCase()}` — REPLACE with StageBadge.
  This is the order-status badge. LEAVE ALONE the sibling badges at :904 (payment),
  :976 (`sale.delivery.status`), :1000 (`sale.pickup_status`), :1074 (task status),
  :1291 (`sale.pre_order.status`). On a DETAIL screen the delivery/pickup lifecycle is
  legitimate detail, not a dashboard-level restatement of the stage — spec §9 says
  replace only the badge restating the order's status.
- `OrdersInboxScreen.js:110` — `STATUS_LABELS[item.status]` — REPLACE with StageBadge.
  Note this screen carries a THIRD status vocabulary in its local `STATUS_LABELS` at
  :10 ('Received', 'In Preparation') that matches neither raw status nor
  computeOrderStage. **Do NOT delete `STATUS_LABELS`** — :164 still uses it for the
  filter chips, which filter on raw `status` values server-side and must keep raw
  semantics. Only the row badge changes.
- `DeliveriesScreen.js:431-433` — `item.status` — **LEAVE ALONE.** On a delivery row
  this is the DELIVERY's own dispatch status (assigned/picked_up/in_transit), which is
  this screen's actual subject and what riders and counter staff dispatch against.
  ADD a StageBadge for the order stage alongside it; do not replace it. Losing the
  dispatch status here would be a functionality regression (staff-ux-checklist #9).

Cost if wrong: a badge shows in the wrong place on one screen; cosmetic, one-line
revert, no data risk.

## Task 1
Base f7a79ca → 55bae4b. Implementer status DONE, 4 concerns raised.

### Ruling: API port is 3001, not 5000
Plan's curl examples used :5000; `server/.env` sets PORT=3001. Corrected the plan
(3 occurrences) and regenerated briefs 4 and 11 which carry curl commands.
Cost if wrong: a curl fails loudly and is retried. Zero risk.

### Ruling: the widened payment guard now also covers walk_in — keep it
The plan's condition is `order_type !== 'delivery'`, which by construction covers
walk_in as well as the pre_order the spec's §10 named. The implementer flagged this as
a new block staff can hit.
Decision: keep. Refusing to mark an unpaid order completed is correct business
behaviour, `is_credit_sale` is the existing legitimate escape hatch, and the
implementer verified the plain-language message actually reaches staff (api.js:68
shapes `data.message`; all 6 callers pass it to an Alert), which is the
staff-ux-checklist #6 requirement. Real-world blast radius is small: this guard sits in
PUT /:id/status, and a walk_in's initial status is set by POST /sales, not through it.
Cost if wrong: counter staff hit a block on an unpaid walk_in they expected to close.
Recoverable by marking it a credit sale; revert is a one-word condition change.

### Deferred (surface to user at finish, NOT fixed here)
Task 1: minor (deferred): `pref_walkin_auto_complete` (production.js:764) and
PUT /deliveries/:id/deliver (deliveries.js:667) both write `sales.status='completed'`
via direct UPDATE, bypassing PUT /:id/status entirely — so an unpaid walk_in can still
reach completed without meeting the widened payment guard. Pre-existing, predates this
plan, out of its scope. Genuinely open, not implied-solved.

### Task 1 review: Spec ✅, quality approved, 2 Important + 4 Minor
Reviewer independently re-ran the live curls and the babel negative test rather than
trusting the report. Confirmed Main Shop untouched (newest loc-1 write predates the
session by 15h).

### Ruling: Important 1 is real and load-bearing — fix now, in Task 1's fix round
Finding: `server/utils/order-stage.js:139-146` (walk_in/pre_order `ready` branch)
returns an UNCONDITIONAL `Complete` nextAction — no balance check, no delivery check —
unlike the pickup ladder at :90-99 which correctly returns null on a due balance. Task 1
widened the endpoint's preconditions without mirroring them, so the server now emits a
one-tap button it will then 400. Live repro: sales 313 and 314.
Decision: fix inside Task 1's fix loop rather than deferring. This is a regression this
task introduced (before it, those calls returned 200), it is exactly the failure
order-stage.js's own header comment exists to prevent, and Task 5's dead-end router
CANNOT cover it — that router only engages when nextAction is null, and here it is not.
Cost if wrong: a Ready pre_order with an open delivery loses its one-tap Complete and
instead routes to the delivery. That is the correct behaviour anyway.

### Ruling: the same order_type-keying bug exists in MY plan's Task 5 — patch the plan
`resolveDeadEnd`'s delivery branch is gated on `order.order_type === 'delivery'`, so a
pre_order fulfilled by delivery would fall through it — the identical mistake Task 1
fixes in the backend. Rewriting Task 5's `ready` branch to key on the data
(`delivery_id` + `delivery_status`) instead of `order_type`, and to merge `ready` with
`ready_for_pickup` so payment and delivery blocks are handled once for every order type.
Cost if wrong: contained to one function in one not-yet-written file.

### Ruling: Important 2 + Minor 3 fixed together
Important 2: the guard tells staff "Mark the delivery as delivered first", but a
`failed` delivery is reachable (PUT /deliveries/:id/fail pushes the sale back to `ready`)
and CANNOT be marked delivered (deliveries.js:601 rejects anything not picked_up/
in_transit). Staff are instructed to do something the API refuses — a direct
staff-ux-checklist #6 violation.
Minor 3 (raw `in_transit`/`picked_up` enum leaking into that same staff-facing string)
is literally the same line, so folding it in is zero marginal cost rather than scope
creep. Normally minors never enter the loop; this one rides along only because it shares
the line being rewritten anyway.
Cost if wrong: a message string reads awkwardly. No behaviour change.

### Deferred minors (surface at finish, triage at final review)
Task 1: minor (deferred): `babel-preset-expo` is not in app/package.json devDependencies
— resolves only via npm hoist from `expo`. Fails CLOSED (every file would FAIL loudly),
so no silent-pass risk; left alone to avoid a reinstall mid-run.
Task 1: minor (deferred): `configFile: false` in babel-check.js decouples it from
app/babel.config.js. Verified identical today; would drift silently if a plugin is ever
added there.
Task 1: minor (deferred): report §5.5 misstates why the arithmetic is safe (claims JS
string coercion; actually runSelect json_agg-round-trips real JSON numbers). Doc-only.
Task 1: latent (deferred): the payment guard's delivery exemption still keys on
`order_type` while the delivery guard no longer does — a half-fixed asymmetry. Reviewer
traced every path and could not construct a reachable case today. Becomes real if any
future path leaves a delivered-delivery sale at `ready`.

Task 1: fix round 1/5 (3 addressed, 0 open — Important 1 dead-end button, Important 2
failed-delivery message, Minor 3 enum leak; commits 55bae4b..b698a15)
Re-reviewer ran a 116,640-combination differential harness (old vs new module vs a
verbatim mirror of the endpoint's gates) and found zero "too strict" cases — the fix
never hides a button the endpoint would accept.
Task 1: complete (commits f7a79ca..b698a15, review clean)

### Ruling: Task 4 must pass a real total_paid, not null
Re-review found my plan's Task 4 passes `total_paid: null` into computeOrderStage from
GET /deliveries, justified by "the pickup ladder never runs for a delivery row". Task 1's
own fix invalidated that: the balance check now also lives in the SHARED walk_in/pre_order
ladder, which IS reachable from a deliveries row (a pre_order whose delivery is
cancelled/delivered but still owes money — live row 321). With null it evaluates to
"nothing due" and re-emits the Complete button that 400s — the very defect Task 1 just
closed, through a different route.
Decision: Task 4 adds the same COALESCE(SUM(payments)) expression GET /sales already uses,
and verifies that exact shape.
Cost if wrong: one extra correlated subquery per deliveries row. Negligible.

### Ruling: extend Task 10 to gate SaleDetail's Complete Order button
SaleDetailScreen still mirrors the OLD order_type keying (`:449` delivery, `:469` pickup)
and its Complete Order button (`:1424`) renders regardless of whether nextAction exists.
For the shapes Task 1 widened, staff can still tap through to a 400 — and the
collect-payment modal only fires for order_type 'pickup', so an unpaid pre_order/walk_in
gets a raw error rather than a way to take the money. Pre-existing, but 55bae4b widened
its blast radius, and the plan explicitly left this button alone.
Decision: extend Task 10 with a step applying spec §7 to this screen.
Cost if wrong: contained to one screen; the button either shows or routes.

### Deferred minors added this round
Task 1: minor (deferred): for a `pending` delivery the new message reads "...is not
assigned to a rider yet. Mark the delivery as delivered first." — the halves contradict
each other. Not new breakage (the old string was equally mismatched; the plain-word map
just makes it legible) and not a dead end (pending→assigned→delivered is live), so it is
NOT reopening the loop. One-line `pending` branch; triage at final review.
Task 1: minor (deferred): /reattempt and /cancel are owner/manager/counter_staff only
(deliveries.js:755, :885) but PUT /sales/:id/status admits `employee` — so an employee
reading the new failed-delivery message is pointed at two endpoints they would 403 on.
Task 1: minor (deferred): no uniqueness constraint on deliveries.sale_id; sales.js:2289
uses LIMIT 1 with no ORDER BY while the detail and list routes each pick independently.
Zero sales currently have >1 delivery row. Predates this plan.

## Tasks 2 + 3 (batched — three leaf modules, one review surface)
Base 631e4a7 → 82eaa2d (Task 2: orderStages.js, useBreakpoint.js) → c08ddd7 (Task 3:
StageBadge.js). Implementer DONE, no concerns, no deviations.
Review: Spec ✅, quality approved, ZERO findings in any category.
Reviewer independently diffed all three files byte-for-byte against the briefs, re-ran
babel-check and the mapping script itself, and extended the check beyond the brief's
5 sampled keys to all 9 keys computeOrderStage actually emits — confirming
STAGE_COLUMNS(5) + CLOSED_STAGE_KEYS(4) cover all 9 with zero gaps and zero overlap.
Also confirmed STAGE_COLORS are all 6-digit hex, so StageBadge's `color + '18'`
alpha-suffix produces valid 8-digit hex at runtime.
Task 2: complete (commits 631e4a7..82eaa2d, review clean)
Task 3: complete (commits 82eaa2d..c08ddd7, review clean)

### Ruling: serialize implementers, overlap only implementer-with-reviewer
Reviewers are read-only, so running one alongside an implementer is safe and is what
this run does. Two implementers at once is not: both would `git add && git commit` into
the same working tree and can collide on .git/index.lock. Recoverable, but it can send an
agent into odd recovery behaviour mid-task.
Cost if wrong: some wall-clock left on the table. Chosen deliberately over a corrupted
or confused commit.

## Task 4
Base c08ddd7 → e46f317. Implementer DONE_WITH_CONCERNS.

### Ruling: the brief's Step 4 spot-check was wrong; the implementer was right not to "fix" the code
My brief asserted that a `ready` sale with an `assigned` delivery must read
`Out for Delivery`. It reads `Ready`, correctly — computeOrderStage's delivery ladder
evaluates the plain-Ready branch before the out-for-delivery branch and `assigned` is not
in its exclusion list, so EVERY caller sees Ready for that shape. This is the
pre-existing cosmetic quirk already recorded in CLAUDE.md (sub-project 5, Task 18).
The implementer created the case live, confirmed the behaviour, declined to retune the
shared util (which also feeds GET /sales, GET /sales/:id and the dashboard), and proved
the adapter correct with three discriminating rows instead. Correct judgment.
Decision: leave the ladder alone. Patched the plan's verification step to use
discriminating rows plus a cross-route agreement check (GET /deliveries vs GET /sales,
which compute the stage independently — they agreed on key AND nextAction for all 21 rows).
Not expanding scope to add an "Assigned" stage key: the spec's §3 defines four columns
over the existing keys, and Task 5's dead-end router already covers this shape usefully —
an assigned-but-not-collected delivery will render "Ready" plus the status line
"<rider> has it", which tells staff the truth even though the stage word is coarse.
Cost if wrong: the Ready column mixes not-yet-assigned and assigned-but-not-collected
deliveries, distinguishable only by the per-card status line. Cosmetic.

### Deferred minors added this round
Task 4: minor (deferred): only the `owner` role was exercised live — no non-owner dev
credentials were available to the implementer. Role-gated behaviour of these two routes
is unverified for counter_staff/employee. verify-identity-roles.js is 10/10 unchanged,
which covers the authorize() lists but not the response shape per role.
Task 4: minor (deferred): GET /deliveries now runs one additional correlated subquery
per row (the total_paid sum). Accepted deliberately — the alternative was the dead-end
button. Worth knowing if that route ever gets slow.
Task 4: note: delivery 93 was left `assigned` at Test Loc as a live fixture.

## INTERRUPTION 2026-09-02 ~07:4x IST — session API limit
Two agents died mid-flight with "session limit · resets 7:40am (Asia/Calcutta)":
  - Task 4 REVIEW (never produced a verdict) — must be re-dispatched
  - Task 5 IMPLEMENTER (produced nothing; `app/src/components/orderBoard/` does not
    exist, working tree clean) — safe to re-dispatch from scratch, no partial state
Verified at 07:55 IST: HEAD = 3944f2e, no uncommitted changes to app/src, server/routes,
server/utils or app/scripts. Nothing to unwind.
Task 4 code IS committed (e46f317) and stands; only its review is outstanding.
RESUME POINT: re-dispatch Task 4 review (base c08ddd7 → e46f317, package already written
to review-c08ddd7..e46f317.diff) and Task 5 implementer (base 3944f2e).

## Task 5 (after the interruption)
Base 3944f2e → 435b889. Implementer DONE_WITH_CONCERNS. File verified byte-exact against
the brief's 5 code blocks; babel gate confirmed live with a negative test.

### Deferred minor: the timezone argument is a codebase-wide no-op
Implementer flagged that `getOrderSla` passes `timezone` to `minutesSinceServerDate` and
`minutesUntilShopDateTime`, neither of which accepts it.
VERIFIED independently: `utils/datetime.js:204` `minutesUntilShopDateTime(dateStr, timeStr)`
and `:215` `minutesSinceServerDate(value)` — the extra arg is silently dropped, so both
use DEVICE-LOCAL time rather than shop time. NINE call sites pass it uselessly, eight of
them predating this plan (DashboardScreenV2 ×2, ProductionQueueScreen ×5, the old
OrderKanbanBoard ×2).
Decision: defer, keep the call verbatim. Fixing it means changing a shared util that
ProductionQueueScreen depends on, and that screen is explicitly out of scope (spec §13).
Consequence today is nil — shop devices run on shop time. It would bite a device set to
another timezone: SLA "late" warnings drift.
Cost if wrong: the late/due-soon warning is computed against device clock instead of shop
clock on a misconfigured device. One-line fix in utils/datetime.js covers all nine sites.

Task 5: minor (deferred): the above.

### Task 4 review (retry after the interruption): Spec ✅, quality approved
No Critical, no Important. Reviewer verified all 11 adapter fields across all 21 Test Loc
delivery rows against the independently-computed GET /sales stage — 0 diffs, 0
stage/nextAction mismatches. Proved `id: row.sale_id` via delivery 92, whose emitted
action carries `/sales/307/status` (the SALE id, not the delivery id). Directly
reproduced the total_paid:null failure mode against the util (it does emit the dead-end
`Complete`), confirming the subquery is what prevents it. No fan-out (57 rows / 57 unique
sale ids). No `--` SQL comments, so the bindParams apostrophe footgun is not armed.
Confirmed the deliveries SELECT names sale columns individually rather than `s.*`, so
owner-only `vendor_name` cannot leak to a rider.
Task 4: complete (commits c08ddd7..e46f317, review clean)

### Deferred minors from Task 4's review
Task 4: minor (deferred): `sales.js:176` — the new outer alias `dp` is shadowed by an
inner `dp` at `:208` (EXISTS ... JOIN users dp). Legal and live search works, but a latent
trap: if anyone later removes the inner join, `dp.name` silently resolves to the outer
correlated alias instead of erroring. Rename outer to `dpart`.
Task 4: minor (deferred): `deliveries.js:148-149` — `s.pickup_status` and `total_paid`
land unaliased on a delivery row while the colliding sibling IS aliased (`order_status`).
Safe today; a future `deliveries.pickup_status` column would silently flip its meaning.
Task 4: minor (deferred): a sale at `completed` with delivery `assigned` yields
`Out for Delivery` + a `Mark Delivered` action that 400s ("Cannot deliver from assigned
status"). SAME dead-end-button family as Task 1's Important 1, and it already exists on
GET /sales. Narrow now: Task 1's widened guard prevents NEW occurrences via the guarded
route, no such row exists at Test Loc, and only legacy rows or the deferred direct-UPDATE
paths could produce one.
### Ruling: do NOT reorder the delivery ladder mid-run to fix that
The clean fix is moving the terminal `status === 'completed'` check ahead of the
out_for_delivery check — two lines. Declined here: that ladder feeds GET /sales,
GET /sales/:id and the whole dashboard, and reordering it without its own verification
pass is precisely the unreviewed improvisation that causes regressions. It belongs with
the Step 4 ladder-ordering quirk as ONE deliberate follow-up, not as a drive-by.
Cost if wrong: a legacy completed-sale-with-assigned-delivery row shows a button that
errors. No data risk; the guard rejects the write.
Task 4: minor (deferred): computeOrderStage has no null-guard, so a delivery whose
LEFT JOIN sales yields nulls renders as `Completed` (no action, no crash). Already
documented in CLAUDE.md.

## Task 6
Base 435b889 → b91aa5f. Implementer DONE, no concerns.
Review: Spec ✅, quality approved. Byte-identical to the brief under independent diff.
Reviewer confirmed all four Colors tokens exist, ran babel-check itself, and verified the
structural claims rather than the stylistic ones: wide/narrow render the SAME `header` and
`body` local variables (not parallel copies) so they cannot drift; the wide branch never
reads `collapsed`, making an unreachable-collapsed wide column structurally impossible;
narrow has no ScrollView or swipe handler, satisfying the no-hidden-gestures rule.
Task 6: complete (commits 435b889..b91aa5f, review clean)

Task 6: minor (deferred): `orders.length` has no guard, so rendering StageColumn without
an `orders` array throws. Reviewer checked the only planned caller (Task 7) and confirmed
`STAGE_COLUMNS.reduce` seeds every column key with a real array, so the path is
unreachable today. Matches computeOrderStage's already-accepted no-null-check house style.

## Task 5 review: Spec ✅, quality approved
Byte-exact transcription of all five brief blocks (reviewer reassembled them and diffed).
Every import verified against disk with the named export present. Reviewer traced
`sales.js:1844` to confirm the data-keyed branch is sound in both directions: a pre_order
WITH a delivery_address does get a deliveries row (so it reaches the delivery branch), and
a pickup never gets one (so it can never be mis-offered "Assign Rider"). Confirmed the
card can never render a button plus a contradicting status line — `nextAction ? null :
resolveDeadEnd(order)` makes the paths mutually exclusive. Confirmed no falsy-&& string
leak (React 19.1.0 skips '' children).
Task 5: complete (commits 3944f2e..435b889, review clean)

### Ruling: the dropped viewerRole reasoning was half-wrong — carry a note, don't add the prop back
My preflight ruling removed `viewerRole` from OrderCard on the grounds that "the role gate
is already baked into nextAction being null". The reviewer correctly points out that is
INVERTED for `resolveDeadEnd`, which runs precisely WHEN that gate closed — so a
`customer` or `delivery_partner` viewer would be offered `Assign Rider` / `Collect ₹X`.
Unreachable today: neither role reaches this board (MainNavigator.js:700 routes
delivery_partner to DeliveryPartnerStack; customers never see the dashboard).
Decision: do NOT re-add a client-side role check. Duplicating a server-side authorization
decision in the client is the exact anti-pattern this plan exists to remove, and the
routing targets are themselves role-gated screens. INSTEAD carry an explicit constraint
into Task 8's dispatch: this board must never be rendered on a rider or customer surface.
Cost if wrong: if someone later renders this board for a rider, they see two buttons that
route to screens not in their stack. No data leak — the card exposes nothing a rider
cannot already see on their own delivery.

Task 5: minor (deferred): `getOrderSla`'s `if (!order ...)` guard is unreachable-as-
protection — `getPaymentWarning(order)` dereferences `order.is_credit_sale` unguarded
first. Cosmetic, verbatim from the brief.
Task 5: minor (deferred): primaryAction/secondaryAction styles have no paddingHorizontal,
so a long label (`Collect ₹1,23,456`) in a narrow column can reach the border. Grows the
button rather than breaking layout.

## Task 7 review: Spec ✅ (byte-identical), quality approved WITH one required correction
Reviewer re-ran babel, confirmed the old board and DashboardScreen:24 untouched, ran the
grouping body over six scenarios (12 mixed orders, [], undefined, null, filter-excludes-
all, filter-matches) confirming every STAGE_COLUMNS key holds a real array in all six —
so StageColumn's unguarded orders.map cannot crash. Confirmed isWide genuinely drives
layout (boardWide flexDirection row vs boardNarrow column, and forwarded to StageColumn),
which was the specific defect being fixed. Confirmed all 9 server stage keys handled.

### ★ HIGH SEVERITY, PRE-EXISTING: customers reach the owner/manager dashboard
The reviewer challenged the JSDoc safety claim I instructed be added, and was right.
I independently verified both halves:
  - MainNavigator.js:623 registers the Dashboard tab with NO role gate. The
    delivery_partner block at :700 ADDS a Deliveries tab, it does not redirect. Customers
    get Shop (:718) and MyOrders (:727) IN ADDITION TO Dashboard.
  - DashboardScreen's chain is isDeliveryPartner ?(671) : isCounterStaff ?(810) :
    isEmployee ?(913) : owner/manager(1143). No customer branch → role='customer' falls
    through to the owner/manager branch, which renders the board at :1155.
  - It is a DATA leak, not only a UI one: isStaff (:207) excludes customer but is only
    consulted for EXTRA requests; reqs[0] is a sales fetch issued for every role and
    setSales() at :374 is unconditional. CLAUDE.md records GET /api/sales as deliberately
    having no server-side role guard.
So a logged-in customer's device fetches shop-wide sales and renders them on the
owner/manager dashboard. Pre-existing — NOT introduced by this plan.

### Ruling: fix it in Task 8, on the screen, not in the navigator
Task 8 rewrites this exact file, the whole redesign is about what each role sees on the
dashboard, and staff-ux-checklist #8 is explicitly "does this role's home screen show only
what that role needs". Shipping a dashboard redesign while knowingly leaving customers on
the owner view would be indefensible.
Fix has two halves — early-return in fetchDashboard so the data never reaches the device,
AND an isCustomer render branch before the owner/manager fall-through.
Rejected the alternative of unregistering the Dashboard tab in MainNavigator: that changes
the customer's initial route and risks breaking deep links to 'Dashboard' — a larger
navigation change than this task should carry.
Cost if wrong: customers see a simpler dashboard than before. No staff-facing impact.
SURFACE THIS TO THE USER — it affects the live app now, ahead of this branch merging.

### Task 7 fix round pending: the JSDoc asserts a false invariant
The block I instructed cites the wrong protection mechanism and claims customers never
reach the board, which is false. It is also the stated justification for OrderCard's
routing buttons having no role check, so a wrong comment here misleads exactly the next
person who touches that decision.

Task 7: fix round 1/5 (3 addressed, 0 open — Important JSDoc false invariant, Minor
silent-drop warn, Minor refetch-failure-reported-as-update-failure; commits 77cb15c..73b3c21)
Re-reviewer independently verified every cited line in MainNavigator.js and
DashboardScreen.js rather than trusting the fix report, and confirmed the console.warn is
reachable ONLY for a truthy, non-closed, unmapped key. Confirmed orderStages.js was
correctly left unedited — adding the warn makes its existing comment literally true.
Confirmed no role check was added to the board or OrderCard.
Task 7: complete (commits b91aa5f..73b3c21, review clean)

## Task 8
Base 73b3c21 → ece6fdc. Implementer DONE_WITH_CONCERNS, one stated deviation.

### Ruling: accept the handleNavigateToDone deviation — the brief was wrong
Brief hardcoded `navigate('EmployeeOrders', {screen:'OrdersInbox'})`. OrdersInbox is
registered in BOTH stacks but under DIFFERENT tabs — owner/manager reach it via `Orders`.
As briefed it was a dead tap for the owner. Implementer changed it to
`isOwnerOrManager ? 'Orders' : 'EmployeeOrders'`. Correct; accepted.
Cost if wrong: nil — it fixes a tap that did nothing.

### Ruling: my one-breakpoint decision was wrong — split it into two named thresholds
Implementer's concern 2 is a real regression I caused. Verified: DashboardScreen:1217-1239
splits the owner/manager page into feedCol(flex:2)/healthCol(flex:1) on the SAME `isWide`
the board uses. Retiring `isDesktop`(1100) in favour of `isWide`(900) therefore moved the
PAGE split from 1100 to 900 as a side effect — at 901px the board gets ~2/3 of 900 ≈ 600px
and four stage columns land at ~140px each, too narrow for a card carrying an order
number, customer, amount, stage badge and a 44px button.
The original problem was two FILES independently hardcoding 1100 with comments begging the
next person to remember the other. That is fixed by one hook, not by one number. These are
two genuinely different questions: "should the board show columns" (900) and "should the
page split into two columns" (1100).
Decision: `useBreakpoint()` returns `{ width, isWide, isDesktop }` — isWide 900 for the
board's internal layout, isDesktop 1100 for the page split. DashboardScreen's three page-
layout sites go back to isDesktop; the board keeps isWide.
Cost if wrong: between 900-1100 the page stays single-column and the board runs full width
(~250px/column) — which is the better outcome anyway. Above 1100 it matches today's
behaviour exactly.
NOTE: the plan document still describes a single 900 breakpoint (spec §5). This ledger
entry is the authority on that point; the plan is not being rewritten retroactively.

## Task 8 review: Spec ✅, quality approved, no Critical
Customer guard VERIFIED CLOSED on both halves. Reviewer re-derived the enumeration rather
than trusting it, and checked a path the report missed — components rendered OUTSIDE the
role chain (OrderQuickModal's refreshDelivery is gated on `visible` && `order?.id`; the
other modals gated on state a customer cannot set). Also confirmed no raw
fetch/axios/XMLHttpRequest exists in the file, which is what actually makes the api.*
enumeration exhaustive. isCustomer is in the useCallback deps, so no stale capture across
a role switch. Both call sites pass exactly seven props with the correct `sales` array
each. orderDisplay.js turned out to be a comment-only edit (3 insertions/2 deletions), all
8 exports intact, all 5 importers resolve.
Task 8: complete (commits 73b3c21..cad61b0, review clean — 2 Important adjudicated below)

### Ruling: accept the onTaskPress removal, but the stated justification was wrong
Implementer claimed "capability moved, not lost — OrderQuickModal is a superset". False for
counter_staff: OrderQuickModal gets `canManage={isOwnerOrManager}` (:1361) and its
Assign/Reassign button is gated on it (QuickModals.js:524), with no self-pick equivalent —
yet production.js:562 explicitly authorises counter_staff to pick a task.
Decision: accept anyway. The capability IS still reachable via "Open Full Details" →
SaleDetailScreen, where canAssignTasks includes counter_staff (:168). That satisfies
CLAUDE.md's "rare/advanced actions can live one level deeper, not deleted", and a counter
staffer picking a PRODUCTION task is not their common-case path — florists own that.
Cost if wrong: counter_staff self-picking a task goes from 2 taps to 4. Recorded here
because the reasoning in the report is wrong even though the outcome is acceptable.

### ★ Ruling: add a per-column cap — the board now renders every open order uncapped
The old board sliced each lane to 1-2 preview cards. StageColumn does `orders.map(...)` in
a plain ScrollView with no cap and no virtualization, fed by a `limit: 500` fetch. This is
Task 7's design and the brief mandated `sales={sales}`, so not a spec violation — but it
lands on a screen in daily use, and it is the SAME failure mode CLAUDE.md already records
for "Orders Needing Attention" (doesn't scale past ~20 orders, no render cap).
Also: my own spec §13 wrongly recorded the capped-dashboard work as "not selected". The
user DID select the scope option whose description named it. That scope item then
evaporated because its main subject (DashboardScreen.advanceOrderStatus) turned out not to
exist. The cap half is still wanted and is now demonstrably needed.
Decision: add it as a new Task 12, run before final verification. Per-column cap with a
"+N more" affordance into Orders Inbox — which already has search, filters and a
virtualized list, and is the right tool for browsing everything.
Cost if wrong: a capped column hides orders behind one tap instead of an endless scroll.
Reversible by raising one constant.

## INTERRUPTION 2026-09-02 ~12:xx IST — session API limit (second occurrence)
Task 9 implementer died with "session limit · resets 12:50pm (Asia/Calcutta)" before
writing anything. Verified at 13:10 IST: `git status --porcelain app/src/components/
QuickModals.js` is clean, HEAD = b397859. No partial state, safe to re-dispatch fresh.
RESUME POINT: Task 9 implementer (base b397859). Tasks 1-8 complete and reviewed clean.
Task 12 (column cap) added to the plan mid-run and its brief generated; runs after Task 10,
before Task 11's final verification.

## Task 9 review: Spec ✅, quality approved, no Critical
Reviewer traced all 6 consumers of `statusActions` and confirmed no consumer reads
`.next` unconditionally or assumes `.action` exists — no silent no-op path, which was the
specific failure mode hunted for. Cancel confirmed byte-identical in audience, styling and
dispatch. Double-fire guard correct (setActionLoading before the first await, cleared in
finally, plus a !visible reset effect). Backend error text reaches staff verbatim.
Over-reach check on the removed `canManage &&`: clean — that gate wrapped only the Quick
Actions block; task Assign/Reassign keeps its own canManage at :540. For florist_staff and
delivery_partner the server returns nextAction: null and Cancel is excluded, so the block
does not render at all — no empty section, no widened capability.

### Ruling: Task 9 fix round queued (NOT dispatched yet — Task 10 implementer is live)
Serializing implementers; will dispatch when Task 10 lands. Three items:
1. IMPORTANT — QuickModals.js:414 renders 'Paid' for payment_status='refunded', which the
   server really writes (sales.js:2700). A false statement about money on a counter
   screen. This is verbatim from MY brief's Step 2 snippet, not an implementer slip.
2. MINOR, folded in because it IS the clutter complaint — :419 shows a BadgePill
   "Ready for Pickup" beside a StageBadge reading "Ready for Pickup". Word-for-word
   duplication on the screen this redesign exists to de-clutter, and its
   `|| order.pickup_status` fallback can print a raw enum.
3. MINOR, folded in because it interacts with the same block — :586 still gates the whole
   Quick Actions block on `!isFinal`, derived from raw `status`. Last raw-status decision
   controlling whether the SERVER's action renders. Not reachable today, but
   order-stage.js:90's `|| pickup_status === 'ready_for_pickup'` disjunct means a future
   path writing `completed` without `picked_up` would show "Confirm Pickup" on the card and
   nothing in the modal. Switch to `statusActions.length > 0`.

Task 9: minor (deferred): :401 subtitle renders "walk in"/"pre order" via a bare
underscore replace. Pre-existing, unrelated to the stage work, not piling onto this round.
Task 9: minor (deferred): with display_stage absent the modal shows no stage badge at all
(StageBadge returns null by design). Unreachable today — the sole consumer is
DashboardScreen and every fetch is GET /sales, which always attaches display_stage.

## Task 10
Base 48b701d → f806bc5 (badges) → 8d741d3 (Complete Order fix). DONE_WITH_CONCERNS.
784-combination harness against the real backend guards: zero 400-bound buttons, zero lost
abilities, zero dead ends. 10 live `ready` orders previously rendered a 400-bound button;
all now route correctly. 48/48 comparable deliveries show identical stage labels across
GET /deliveries and GET /sales.

### Ruling: ACCEPT deviation 1 — gate on the backend guards, not literally on nextAction==null
My brief said hide Complete Order when nextAction is null. The implementer gated on the two
actual backend guards instead, because the literal rule would have deleted the ONLY way to
finish a delivery order that is already delivered but whose sale is still `ready`.
Verified the trace: with status='ready' and delivery_status='delivered', computeOrderStage
falls past the plain-Ready branch (delivered IS in its exclusion list) and past
out_for_delivery, landing on the terminal `delivered` branch with nextAction null — yet
PUT /sales/:id/status WOULD accept the completion, since the delivery is delivered. Hiding
the button would strand the order with no way to close it.
Gating on the endpoint's real preconditions is strictly more correct than gating on a proxy
for them. Accepted.
Cost if wrong: nil — it is the same rule the server enforces.

### Ruling: REVERT deviation 2 — unpaid pickup must stay a one-step inline collect
The implementer routed unpaid pickup to the AddPayment SCREEN, making the shop's most
frequent counter case 2 steps (Collect → AddPayment → back → Confirm Pickup) where it was 1
(inline pay modal). It flagged this and offered the reversal.
Reverting. CLAUDE.md is explicit that the common-case path must be the SHORTEST path, with a
plain counter sale well under 6 taps and 30 seconds — and a customer is standing there.
The routing pattern was designed for the dashboard CARD, which has no room for a modal. On
the detail screen an inline modal already exists and resolves it in place, which is strictly
better. My own Step 4 actually said to WIDEN that modal off `order_type === 'pickup'`, not to
replace it with navigation — so this is restoring my intent, not overriding the implementer.
Keep the `Collect ₹N` label; change only what it opens.
Cost if wrong: the detail screen keeps a modal it already had.

### Ruling: ACCEPT concern 3 — the added "Delivery Failed — Send Again" branch
Not in my brief. The implementer's first pass shipped a real dead end (a `failed` delivery
can never be "marked delivered"), caught it in its own live trace, and added the branch.
That is exactly the no-dead-ends rule this plan enforces. Accepted and welcome.

Task 10: minor (deferred): handleConfirmPickupPayment's updateOrderStatus deliberately not
converged onto advanceOrder — a stale nextAction risk. Reasonable call.

Task 9: fix round 1/5 (3 addressed pending re-review — Important refunded-shows-Paid,
Minor pickup pill duplicating the stage, Minor raw-status gate; commits 48b701d..d6ed206)
Implementer replaced the fall-through ternary with a PAYMENT_LABELS lookup, so an
unrecognized value now renders NO pill rather than falsely claiming "Paid". Dropped the
pickup pill wholesale after tabulating that it duplicated or restated the stage in all
three states. `order.status` is now read in exactly one place in OrderQuickModal — Cancel's
own terminal-state guard.

### ★ Surfaced by Task 9, OUT OF SCOPE, real: unvalidated payment_status write
`PUT /api/sales/:id` writes a caller-supplied `payment_status` straight through with no
whitelist, and the column has no CHECK constraint. So an arbitrary string can be written to
live money data — which is also what made the old fall-through ternary dangerous rather
than merely untidy. Belongs to sub-project 8 (catalog/inventory + consistent enforcement),
not to this UI plan. NOT fixed here. Surface to the user at finish.

Task 9: fix round 1/5 re-review — 3 ADDRESSED, 0 open, no new breakage.
Reviewer independently enumerated every server write to payment_status (sales.js:1525-1527
create, :2053-2055 add-payment, :2700 refund, database.js:303 default) and confirmed
PAYMENT_LABELS covers all four. Judged "render no pill for an unrecognized value" as
correct rather than a gap: the only uncovered case is the unvalidated PUT /api/sales/:id
write, where no label the frontend could invent would be trustworthy — a fabricated label
on a money statement read at the counter is strictly worse than none.
Also verified the dropped pickup pill lost nothing: checked all three former values against
order-stage.js's pickup ladder — ready_for_pickup and picked_up were exact duplicates of the
stage label, and `waiting` has no pickup-specific branch at all (it renders New/Preparing).
Task 9: complete (commits b397859..d6ed206, review clean)

## Task 10 review: Spec ✅, quality NOT approved — 3 Important
Reviewer confirmed all three badge decisions landed as authorised, that the Complete Order
gate mirrors the backend precondition-by-precondition (neither too strict nor too loose),
that the modal's two modes cannot leak (both openers route through openCollectPaymentModal
which always sets mode explicitly), and that split payments + write-off survived the move
inline so nothing AddPayment offered was lost.
Findings entering the fix loop:
 1. SaleDetailScreen:588-604 — payment succeeds, status update throws, message says
    "Could not record the payment. Please try again." Staff take the money TWICE. My own
    fix round regressed this; the older copy was vaguer and therefore safer.
 2. :1509 vs :1575 — for a `ready` sale with an out delivery, an explanatory note saying
    "tap Delivery Status above to follow it" co-renders with a Mark Delivered button
    directly beneath. The two-controls-disagreeing ambiguity this redesign exists to delete.
 3. :1526/:1541 + OrderCard.js:36-40 — Assign Rider / Send Again route to DeliveryDetail,
    which gates those sections on owner/manager/counter_staff. An `employee` or
    `florist_staff` gets a real-looking button and an empty destination. CLAUDE.md records
    4 live `employee` accounts on that role indefinitely, so it is reachable in production.
    The 784-combination harness modelled the SALES endpoint's gate, not the DESTINATION
    screen's — which is why it could not catch this.

### Ruling: re-add viewerRole to OrderCard (reversing my preflight ruling, narrowly)
I removed it on the grounds that `nextAction: null` already encodes the server's role
decision. That holds for ACTIONS, but there is no server-side signal telling the client that
a DESTINATION SCREEN will refuse the viewer. Authorising one prop, threaded
DashboardScreen → OrderKanbanBoard → OrderCard, used only to decide whether a routing button
or a status line is shown.
Cost if wrong: one prop that duplicates nothing the server sends, since the server sends
nothing about destination-screen permissions.

## INTERRUPTION 2026-09-02 ~17:xx IST — session API limit (THIRD occurrence)
Task 10 fix round died before writing. Verified at 18:10: clean tree, HEAD e30df8c.
RESUME POINT: Task 10 fix round 1 (3 Important above). Then Task 12, then the newly
approved assignment-flow tasks 13-15, then Task 11 final verification.

## Task 10 fix round 1 landed (commit 8457bbb) — 3 Important addressed, pending re-review
Implementer extended its harness to 1008 rows (9 delivery states, adding `picked_up` — the
state that hid finding 2) plus a second model of OrderCard.resolveDeadEnd and a
destination-authorization oracle transcribed from deliveries.js:498/:784. Against 27 real
`ready` orders x 5 roles: the OLD gate co-rendered contradictory controls on 2 (owner+manager
on INV-MAIN-20260606-002), the NEW gate on 0, and 0 delivery buttons now reach a role that
DeliveryDetail refuses.

### ★★ MAJOR PRE-EXISTING FINDING: Alert.alert is a no-op on web
Surfaced by the implementer, VERIFIED INDEPENDENTLY by me:
`app/node_modules/react-native-web/dist/exports/Alert/index.js` is literally
`class Alert { static alert() {} }` — an empty function.
368 `Alert.alert` call sites across 66 files. ALL SILENT ON WEB.
The user runs the app in a browser (their reported screenshot was localhost:8081), so every
error, guard message and confirmation this plan relies on has been invisible there. A blocked
action silently does nothing — which IS a dead end, defeating spec §6 and §7 outright.
Every task's "the backend's plain-language message reaches the user" verification was true of
the code path and false of the screen.
PRE-EXISTING, predates this plan entirely.
Decision: add Task 16 — a cross-platform alert helper, applied to the files THIS PLAN
touched. NOT a blind sweep of all 368 sites; the rest is a genuine follow-up sub-project.
Cost if wrong: a helper wrapping one call; trivially revertible.

### Ruling: one more Task 10 fix round for collect_payment's missing role check
The implementer left it because I said "do not add any other role logic" — my instruction was
too narrow. `OrderCard`'s `collect_payment` branch has the same defect as the delivery branch
just fixed: `florist_staff` gets a `Collect ₹N` button and dead-ends in AddPayment. Same bug
class, same file, and the viewerRole prop it needs is now already threaded.
Cost if wrong: one more branch consults a prop that is already there.

Task 10: minor (deferred): `total_paid` is absent from GET /sales/:id (derived at
sales.js:1324), so any client-side stage recompute against a detail payload silently
misbehaves. Caught in the harness, not reachable in the app today.

Task 10: fix round 2 landed (601b0d0). Found a THIRD branch with the defect (`record_cod`),
and established the money list is NOT the delivery list — POST /sales/:id/payments and
settle-now are owner/manager/employee/counter_staff, so `employee` MAY take money. Worse
than a 403 for florist_staff: MainNavigator:630 gives that role no POS tab, so
navigate('POS', ...) resolved to no navigator and did nothing at all — a silent no-op.
Harness oracle is now a kind→destination map over all four routing kinds: 161 route buttons
checked, 0 reach a destination the role is refused.

Task 10: minor (deferred): four client-side role lists now mirror three server authorize()
calls, asserted only in a scratchpad harness that does not live in the repo. This is the
same drift footgun server/utils/order-stage.js documents for ENDPOINT_ROLES, now duplicated
client-side. A single client module mirroring those lists would close it. Triage at final
review.

Task 10: fix rounds 1-2 re-review — 3 ADDRESSED, 0 open, no new breakage.
Reviewer verified Important 2 is now structurally impossible rather than merely fixed for
the reported shape: :1593 and :1671 are complements of the same boolean. Confirmed the new
term cannot suppress the "Delivery Failed — Send Again" button, because `failed` is in
neither set that produces hasNoInputNextAction. Verified BOTH client role lists against the
real authorize() calls and confirmed neither is too narrow — `employee` correctly retained
on the money list, so no ability was removed by the fix. Both lists fail closed on an
undefined/unknown role (Array.includes → false → status line, no throw).
Confirmed the florist_staff POS no-op was real: MainNavigator:629-630 registers POS for only
four roles, and handleResolveAction targets the POS tab explicitly.
Task 10: complete (commits 48b701d..601b0d0, review clean)

Task 10: note (not a defect): the OrderCard half of the role gating is currently a DEFENSIVE
no-op — DashboardScreen renders the board only in the isCounterStaff and owner/manager
branches, and employee/florist_staff take the isEmployee branch and never see it. All three
board-reaching roles are in both lists. The SaleDetailScreen half IS live-relevant, since
FloristStack registers SaleDetail. Keeping the card gating: it costs nothing and the board's
audience could widen.
Task 10: minor (deferred): a `ready` delivery order with a balance due renders the rider note
alongside the generic "Record Payment" button. Not contradictory (COD is legitimate) but two
money-adjacent controls in one view. Pre-existing, gate untouched.
Task 10: LIMITATION (surface at finish, not fixable at this layer): a network timeout AFTER a
successful addPaymentToSale write still lands in the step-1 catch and says "try again".
Inherent without idempotency keys on the payments endpoint — distinct from the logic bug that
was fixed. Real, narrow, and worth knowing.

## Task 12
Base 601b0d0 → 0f52295. Implementer DONE, no concerns.
Review: Spec ✅, quality approved, ZERO Critical/Important.
Reviewer confirmed the header count reads the UNSLICED array (capping what renders never
changes what is counted), verified the off-by-one at both 50 and 51, confirmed the em dash is
a real U+2014 by codepoint, and confirmed onShowAll is wired at BOTH board call sites so
neither dashboard has a dead tap. Bonus check it volunteered: the cap slices the front of an
oldest-first array, so it keeps the most-aged orders visible and pushes the newest into
"see all" — correctly aligned with the board's purpose.
Task 12: complete (commits 601b0d0..0f52295, review clean)

Task 12: minor (deferred): the "these two props intentionally share one handler" rationale
(onNavigateToDone / onShowAll) lives only in the report, not in the code — a future reader
could mistake it for duplication and collapse it. One comment at the destructure would close it.

## Task 13
Base 0f52295 → e2f9bea. COMPLETE with one blocker flagged for Task 15.
All 7 live curl cases passed at Test Loc with REAL employee and counter_staff tokens (no
static-only checks). An already-assigned task provably untouched; omitting the field proved
to write zero task rows via unchanged Postgres xmin. verify-identity-roles 10/10.

### ★ Ruling: fix the pref_manager_override interaction — it silently ignores the assignment
Implementer found, and live-reproduced, that with `pref_manager_override = 1` (currently ON)
the pre-existing override block flips `pending` tasks to `in_progress` BEFORE the new
assignment UPDATE. That UPDATE matches `status = 'pending' AND assigned_to IS NULL`, so it
matches nothing: 200 returned, nobody assigned, on every `pickup` and `delivery` order.
walk_in/pre_order work. This is the exact silent-no-op class this plan exists to remove, and
Task 15 would have shipped a button that appears to work and does nothing on most orders.
It was RIGHT not to fix this unilaterally — every candidate fix edits another feature.
Decision: widen the UPDATE to match `status IN ('pending','in_progress') AND assigned_to IS
NULL`, keep it AFTER the override block, and only promote `pending`→`assigned` via a CASE so
an already-in_progress task is never downgraded.
Rejected: moving our UPDATE before the override block. That would set status='assigned',
which no longer matches the override's `pending` WHERE, so the override would silently stop
flipping those tasks — trading our silent bug for a silent change to someone else's feature.
Cost if wrong: an unassigned in_progress task also gets an owner recorded. That is the
intended outcome anyway.

### Ruling: add the existence/role check the implementer flagged as missing
`/tasks/:id/assign` validates its target; our new field does not, so an arbitrary or
non-staff user id can be written to production_tasks.assigned_to on live data.
Cost if wrong: one extra SELECT per assigning request.

Task 13: fix round 1 landed (a874e32). Override interaction proven fixed on BOTH pickup and
delivery with pref_manager_override=1 — unassigned in_progress tasks gain assigned_to while
STAYING in_progress (no downgrade), pre-assigned task untouched. Non-existent id, customer
and rider all rejected with identical task xmin (zero writes).

### Correction to my own ruling (decision unaffected, reasoning was wrong)
I rejected "move the UPDATE before the override block" on the grounds that it would set
status='assigned', which the override's WHERE would no longer match, silently disabling that
feature. The implementer checked: the override's WHERE is `status IN ('pending','assigned')`,
so it would have kept flipping. My stated reason was factually wrong. The placement still
stands on the OTHER reason given — running after the override is what makes the
no-downgrade CASE meaningful. Recording this because a wrong reason in the ledger is worse
than no reason.

### Ruling: accept the is_active / location gap rather than half-closing it
`/tasks/:id/assign` checks neither location nor is_active, and the implementer matched it —
so a deactivated staffer can still be assigned through either path. Consistent, and
deliberately so: closing it on the new path only would make two sibling routes disagree,
which is harder to reason about than one shared gap. Close both together or neither.
Cost if wrong: an order can be assigned to someone who has left. Visible immediately on the
board (their name shows), and reassignable in one tap.
Task 13: deferred: close is_active/location validation on BOTH /tasks/:id/assign and
PUT /sales/:id/status together — sub-project 8 or a dedicated pass.
Task 13: constraint carried into Task 15's brief: assigned_to is a no-op unless the status
being set is 'preparing'. Brief updated and regenerated.

## Task 13 review: Spec ✅, quality approved
Reviewer enumerated all four paths through the handler (pref on/off × order type) and
confirmed an unassigned task ends up carrying assigned_to in every one. Confirmed the
override writes `picked_by`, never `assigned_to`, so `assigned_to IS NULL` survives it as a
valid ownership guard — which is why the widened match is exactly right and nothing wider.
Verified the permission list matches production.js:516 verbatim, the assignee validation runs
before every write (three rejections, unchanged xmin), the two completion guards are
undisturbed, and no `--` SQL comment was introduced.
FOUND, not claimed by the implementer: before this fix, override-created tasks had
assigned_to = NULL, and /tasks/:id/complete and /start both gate on
`task.assigned_to !== req.user.id` (production.js:601, :687). So NO employee/counter/florist
could ever complete an override-created task — 403 "Not your task". The fix closed a real
dead end, not just a silent no-op.
Task 13: complete (commits 0f52295..a874e32, review clean)

### Ruling: correct Task 15's wording, do NOT widen authorize() for florist_staff
Reviewer flagged that the plan said florists would "advance in one tap", while
PUT /sales/:id/status is authorize('owner','manager','employee','counter_staff').
Verified: ENDPOINT_ROLES.SALE_STATUS (order-stage.js:41) has the same four roles, so
computeOrderStage returns nextAction: null for a florist, the card renders NO button, and
no 403 is reachable. The defect is in my plan's wording, not in the code.
Decision: drop florist_staff from that branch; keep `employee` (which IS in both lists).
Do not widen the route — florists already self-assign in one tap from their own task
dashboard via pickTask/startTask, and they never see this board.
Cost if wrong: florists keep assigning from the screen they already use.
Also corrected in the brief: never send assigned_to as "" (parseInt("") → NaN → 400).

Task 13: minor (deferred): the comment at sales.js:2255 justifies skipping is_active by
saying stricter validation "would reject people the task picker still offers" — that is
factually wrong; GET /auth/staff-roster DOES filter is_active and location-scope
(auth.js:296-297). The DECISION to defer still stands on the consistency argument, but the
stated reason should be corrected so it is not carried forward as fact.
Task 13: minor (deferred): no db.transaction() wrapping the sale write and the assignment
UPDATE, so a failure between them leaves an order started and unassigned. The brief
conditioned this on the handler having one; it does not. db.transaction is available.
Task 13: minor (deferred): post-override, `picked_by` is whoever tapped Start while
assigned_to is the assignee, so the task appears in BOTH people's my-tasks. Mostly
pre-existing override behaviour.

## INTERRUPTION 2026-09-02 ~23:0x IST — session API limit (FOURTH occurrence)
Task 14 died MID-EDIT this time (unlike the previous three, which died before writing).
State at 23:16: HEAD 9040263; `app/src/components/orderBoard/AssignPickerModal.js` created
but untracked; `app/src/screens/DashboardScreen.js` modified, uncommitted. The agent's last
line was "Now render the modal alongside the other modals" — so the handler wiring exists but
the modal is not yet rendered. The tree is therefore in a半-applied state and MUST NOT be
assumed working.
Decision: resume the SAME agent rather than discard and re-dispatch — its context is intact
and the work is half done. Instructed it to re-verify its own partial state first rather than
trusting its memory of what it had written.

## Task 14
Base a874e32 → 5478b96 (+ a fix round in flight). Resumed after the mid-edit kill.

### The resume paid for itself
The render block HAD landed before the kill, but referenced `styles.pickerFallbackBtn` and
`pickerFallbackText` — NEITHER KEY EXISTED. babel-check passes on missing style keys, so this
would have shipped as an unstyled ~20px button and been caught only by a human looking at the
screen. Found because the resume instruction said to re-read disk rather than trust memory.
Generalisable lesson: babel-check does NOT catch missing StyleSheet keys. Every remaining
frontend task should grep `styles.X` references against StyleSheet.create keys.

### My brief was wrong three times about GET /deliveries/partners
Real shape: `data.users` (not `data.partners`), `active_delivery_count` (not `active_count`),
and it is a STRING from pg. The implementer verified against the live endpoint instead of
trusting the brief. A wrong field name would have rendered blank meta text silently.

### Ruling: keep the unscoped fallback, but make it visible
Implementer found location-scoped calls return [] where riders lack a `user_locations` row
(live: locations 2 and 3), and chose to retry unscoped. Keeping that — without it the picker
is empty at such a location, a dead end for the exact task this speeds up.
But it must not be SILENT. Single-location today makes it harmless; CLAUDE.md records the
shop is expanding soon, and then a silent unscoped fallback lets one shop hand an order to
another shop's rider with no indication. Requiring a plain-language line in the picker when
the fallback fires.
Cost if wrong: one extra line of text in a picker that rarely shows it.
Not fixing the underlying user_locations data gap here — that is data, not this task.

Task 14: fix round landed (ac4005a). Style-key audit clean (AssignPickerModal 10/10,
DashboardScreen 92 used / 94 defined, no third missing key). The implementer VALIDATED ITS
OWN CHECKER by deliberately breaking a copy and confirming babel-check still returned OK
exit 0 — the trap is now documented rather than folklore.
Fallback notice made a GENERIC `notice` prop so Task 15's florist picker inherits it, and
gated so it only fires when the wider call actually returned riders — "showing everyone"
above an empty list would be a lie.
active_delivery_count (string from pg) confirmed wrapped in Number() at all three call sites;
nothing sorts or does arithmetic on the raw string.

## Task 14 review: Spec ✅, quality approved, 1 Important (queued, not yet dispatched)
Reviewer wrote its OWN brace-matching style-key extractor and self-tested it (swapped a key
to a bogus name, confirmed its checker caught it while babel-check still returned OK exit 0 —
independently reproducing the trap). Results matched: AssignPickerModal 10/10,
DashboardScreen 94 defined / 92 used, no missing keys, 2 pre-existing dead keys. It then
EXTENDED the same audit to theme tokens (the identical silent-undefined class) — all 13
Colors.* references resolve. That extension is a genuinely good idea and should become
standard for the remaining frontend tasks.
Confirmed OrderCard.js is untouched by this diff, so all four role gates are bit-identical,
and the assign_rider split preserved the `!delivery_id → SaleDetail` fallback on BOTH delivery
kinds. Confirmed the fallback notice cannot appear above an empty list. Confirmed
active_delivery_count is Number()-wrapped at all three consumers and never sorted.

### QUEUED fix (Task 15 is editing DashboardScreen.js right now — serialize)
IMPORTANT — DashboardScreen.js:659-674: the `setRiderPicker` after
`await api.getDeliveryPartners()` is unconditional, with no in-flight/staleness guard.
 (a) CERTAIN: tapping Cancel during the spinner closes the picker, then it springs back open
     when the fetch resolves — the escape hatch is transiently ineffective.
 (b) POSSIBLE: Cancel → tap a different card → first request resolves last → the picker
     renders for order B while still holding order A's deliveryId, so the pick assigns a
     rider to the WRONG delivery. Narrow (needs a cancel plus out-of-order resolution) but
     the failure mode is a delivery to the wrong address.
Fix: a request token (`const token = ++pickerSeq.current` before the await; apply the result
only if it still matches). Same pattern covers handlePickRider.
Also fold in: AssignPickerModal.js imports `View` and never uses it — inherited verbatim from
my brief.

Task 14: fix round 2 landed (0eb945c). Implementer REPRODUCED both races in a throwaway
harness with the guard removed (cancel-during-load reopens; cancel→other-order points at A
while showing B), then confirmed both pass with it. Monotonic riderReqRef bumped on
request-start AND on close, so cancelling genuinely cancels. fetchDashboard still runs when
superseded (the write landed); only picker teardown is conditional.
Task 14: complete (commits a874e32..0eb945c, review clean)

### ★ CARRY INTO TASK 15's FIX ROUND: it inherited the pre-fix race
Task 14's implementer noticed Task 15 (2a58bfd) landed on top of its ORIGINAL shape and
copied it: `preparerPicker` has no token guard (DashboardScreen.js lines ~754, 765, 849, 874,
1699), so it has the same cancel-reopens and wrong-order-repoint exposure. It correctly did
NOT edit another task's code and surfaced it instead.
Additional detail worth carrying: Task 15's `assignTask` loop needs the token re-checked
INSIDE the loop, not just before it — a multi-item sale issues several writes and the picker
can be closed partway through.
Not dispatching yet: Task 15's review is still running; batching this with whatever it finds
into one fix round rather than two.

Task 14: minor (deferred, pre-existing): `api.request` has no timeout, so a request that never
settles leaves its owner unresolved. Not introduced here; noted because the token guard's
"every bump is paired with an owner that settles" property depends on it.

## Task 15 review: Spec ✅, quality NOT approved — 1 Critical, 2 Important (fix round landed)
Reviewer independently confirmed both of the implementer's deviations were correct on merit:
following my Step 4 literally would have skipped a stage AND assigned nobody, and the roster
role-filter is genuinely unwritable (no `role` column selected).
Findings: (C) preparer picker had no stale-response guard while the rider picker beside it
did — inherited because Task 15 was built on Task 14's PRE-fix shape; (I) a partially-assigned
sale read as fully assigned and `change` then silently reassigned a held task away from its
holder — the two modes of one button had opposite semantics, since only 'start' is protected
by the server's WHERE assigned_to IS NULL; (I) QuickModals' Start Preparing assigned nobody,
so the card BUTTON and the card BODY did different things under the same label.

Task 15: fix round 1 landed (645993c). All four races reproduced FAILING under the committed
code and passing after (0/5 → 5/5, including the loop-interrupted case).
NOTE THE RIGOR: the implementer's first harness PASSED while the bug was still present; it
distrusted the pass, made the writes settleable until the harness failed honestly, and only
then fixed. A test that passes for the wrong reason is worse than none.
Live: a one-held/one-free sale now reads "<name> is preparing · 1 still unassigned" and
picking someone wrote ONLY the free task, leaving the holder untouched.

Task 15: FOUND, pre-existing, live: `styles.actionBtn` in QuickModals.js does not exist —
DeliveryQuickModal's Convert buttons render unstyled. Confirmed against HEAD, so not
introduced here. Left unfixed as unrelated to this task. This is the second real instance of
the babel-check-misses-style-keys class; the audit is earning its place.

## INTERRUPTION 2026-09-03 ~00:1x IST — session API limit (FIFTH occurrence)
Both the Task 15 re-reviewer and the Task 17 implementer died before doing any work (both
last lines were "I'll start by reading..."). Verified at 08:25: clean tree, HEAD 645993c.
Nothing partial, nothing to unwind. Both re-dispatched.
RESUME POINT: Task 15 scoped re-review (2a58bfd..645993c), and Task 17 implementer
(base 645993c). Then Task 16, then Task 11 final verification, then whole-branch review.

Task 15: fix round 1 re-review — 4 ADDRESSED, 0 open, no Critical/Important breakage.
Reviewer walked all three race orderings rather than confirming a ref exists, and verified
the in-loop recheck at :968 sits inside the write loop. Confirmed the partial-assignment fix
did not invert the other two cases (all-assigned still genuinely reassigns; none-assigned
still assigns all) AND that the card's filter and the write's filter agree, so the word shown
matches the set written. Confirmed QuickModals' Cancel Order still routes via `next` not
`action`, so it kept its two-tap confirm.
Reviewer also caught an arithmetic sleight: "QuickModals 60/63" conceals that `actionBtn` is
among the 60 "used" but is UNDEFINED — really 59 used-and-defined, 4 unused. The live
unstyled-button bug was hiding inside a passing-looking count.
Task 15: complete (commits ac4005a..645993c, review clean)

Task 15: minor (deferred): the in-loop supersede at DashboardScreen.js:968 is a bare `return`
and does NOT call fetchDashboard() when `wrote` is already true, unlike the superseded-catch
(:981) and error (:993) paths. Dismissing partway through a multi-item assign leaves landed
writes unreflected until the next refresh. Self-healing, but the commit message claims both
superseded paths reconcile — the claim is overstated.

## Task 17
Base 645993c → a3c37b0 (+ fix round in flight). Endpoint returns the three codeless
`employee` accounts (Jeetu, Pankaj, Surya) plus florist Paswan, zero counter_staff — the
assertion the task exists for. DISTINCT PROVED load-bearing (7 rows without / 6 with) rather
than trusted. Deviation accepted: `job_title || role` would have printed a raw `florist_staff`
enum to staff, so the role goes through a plain-language label map.
Data fact, not a bug: `?location_id=4` returns [] because no active prep-staff account has a
user_locations row for Test Loc — the real prep staff sit at Main Shop. Proved the scoped path
works by temporarily creating a row at loc 4 and hard-deleting it after.

Task 17: fix rounds 1-2 landed (a3c37b0 → 29fd85a → 8a15fdd).

### Ruling: restore three staff roles on SaleDetail, do NOT expand to five
My rule ("list exactly what the endpoint accepts") was wrong: the assign endpoint accepts 5
roles (employee, counter_staff, florist_staff, manager, owner), so following it literally put
manager and owner into SaleDetail's picker where staff-roster never showed them. The DEFECT
was people MISSING, not roles absent by design — restoring the original three fixes it
completely. Adding two more is a separate product decision nobody asked for, on a screen that
was not in scope, and every extra name costs something in a picker read at counter speed.
Endpoint still returns all five with `role` (honest about what the server accepts); both call
sites narrow explicitly, with a comment saying why three and not five.
Cost if wrong: the owner cannot assign a task to themselves from this screen. Deliberate,
reversible by one list.

### The ordering fix was proved on real data, by a location I did not anticipate
Widening to five exposed that narrowing had to happen BEFORE the empty check. Locations 2 and
3 turn out to be staffed ONLY by a manager and the owner: the endpoint returns 2 rows, the
filter takes it to 0, and the fallback fires with its notice. Filtering afterwards would have
read 2 rows as non-empty and rendered an EMPTY modal silently. Both screens now have that
ordering proved against a real location rather than a constructed case.
Also fixed en route: SaleDetail's row subtitle rendered `emp.phone`, a field staff-roster
never returned — permanently blank, pre-existing, unnoticed.

Task 17: minor (deferred): three role lists across two files stay in sync by prose only
(STAFF_ROLE_LABELS covers 5 while 3 are offered — intentional, it is a naming map not a
membership list). Same client-side duplication debt already logged for the four role lists
mirroring server authorize() calls. One shared module would close both.

## Process note 2026-09-03 08:53 — overlapping reviewer and implementer on one file
I dispatched Task 16's implementer (editing DashboardScreen.js, DeliveriesScreen.js,
OrderKanbanBoard.js) alongside Task 17's REVIEWER, which was told to "read the code" for
DashboardScreen.js. The reviewer has the committed diff as a file, but if it also reads the
working tree it will see Task 16's uncommitted mid-edit state.
Reviewers are read-only so there is no corruption risk, but the review could report phantom
findings that describe Task 16's in-flight changes rather than the commit under review.
MITIGATION: when Task 17's review lands, cross-check any finding against `git show` of the
commits in range before acting. Do NOT dispatch a fix round for a finding that only exists in
the working tree.
Lesson for the remaining tasks: serialize a reviewer against an implementer when they share a
file, not just implementer-against-implementer. The index.lock reasoning I used earlier was
too narrow.

## Task 17 review: Spec ✅, quality approved
Reviewer verified the core assertion LIVE — the endpoint returns all four codeless `employee`
accounts (Jeetu 4, Pankaj 5, Surya 6, T13R2 Emp 379) plus florist Paswan — and confirmed the
SQL has no employee_code condition. PROVED the DISTINCT claim rather than arguing it: user 1
is attached to locations 1, 2 and 4 yet appears exactly once unscoped.
Transcribed the assign endpoint's role list itself (production.js:585) and confirmed
staff-roster's old set equals ASSIGNABLE_STAFF_ROLES exactly — so SaleDetail restores its
prior list precisely, no dead options, no lost abilities.
Confirmed narrowing-before-empty-check independently on BOTH screens, and replayed it against
live loc 4 (2 rows → narrow to 0 → fallback + notice). Confirmed the request-token guard is
byte-identical across all 21 lines vs 645993c, including the in-loop recheck.
Style/theme audits reported as used-AND-defined: Dashboard 92/94/92, SaleDetail 89/89/89,
AssignPickerModal 10/10/10; every Colors/FontSize/Spacing/BorderRadius token resolves.

### The overlap-mitigation check was worth running — finding is genuine, not a phantom
I flagged that Task 17's reviewer might read Task 16's uncommitted edits. Verified both cited
comments against `git show 8a15fdd` rather than the working tree: both are genuinely stale in
the COMMITTED state. DashboardScreen.js:793 even contradicts itself five lines later.

### QUEUED Task 17 fix round (Task 16 is editing both files right now — serialize)
IMPORTANT (comment-only, no runtime effect, but it is a false contract):
 - api.js:863 says "Prep staff (florist_staff + employee)" — the endpoint returns all five.
 - DashboardScreen.js:793 says "returns florist_staff + employee only", contradicted at :797.
 A third caller reading either would skip narrowing on the assumption the server pre-filters —
 exactly the unmeasured-contract error this task exists to fix.
MINOR, folded in (same class as the double-payment message):
 - SaleDetailScreen.js:781-784 swallows ANY failure into "No staff to assign yet. Ask the
   owner to add someone." A dropped request now tells staff to create accounts that already
   exist. The swallow is pre-existing; the new text asserts a cause the old wording did not.
DEFERRED: the {success, staff} envelope departing from the file's {success, data} convention
(brief-specified, client-matched, correct today); `location_id=abc` → 200 with staff:[] rather
than a 400 (tested, benign — the client fallback then shows everyone with the notice).

## Task 16
Base 8a15fdd → 4dad98c. Implementer COMPLETE.
Confirmed the defect first-hand before fixing: `class Alert { static alert() {} }`.
Converted 49 call sites across the five in-scope files, zero survivors; nothing needed leaving
on Alert.alert (no 3+-button or prompt dialogs existed in scope).
Folded FOUR competing local patterns onto the shared helper, not the three I knew about —
DashboardScreen's showMessage, SaleDetailScreen's `notify`, plus inline ternary and if/else
splits that had grown up separately.
PROVED showConfirm's semantics by EXECUTING the real helper against a mocked react-native
rather than reading it: onConfirm fires only on a positive answer, and the native destructive
path emits [{No,cancel},{Yes,cancel,destructive}] byte-identical to the original.

### My counts were wrong; the implementer's reconcile
I briefed 368 app-wide and 2 in DashboardScreen. Real: 372 and 6 (2 bare + the helper +
comments). 327 lines remain across ~61 files, still silent on web — LARGER than what was
fixed. Reconciles exactly: 372 − 49 + the helper's own 4.
That 327 is the named follow-up this task deliberately did not do. It must reach the user.

Task 16: LIMITATION (surface at finish): window.alert/confirm block the thread and can be
suppressed by the browser. Visible beats invisible, so this is the right fix now, but a real
in-app toast/dialog component is the proper eventual answer.
Task 16: nothing verified visually — no browser available to any agent in this run. Someone
should open the web build. This is the same class of gap Task 16 exists to close for the
earlier tasks, and it applies to Task 16 itself.

## INTERRUPTION 2026-09-03 ~13:1x IST — session API limit (SIXTH occurrence)
Task 17's fix round died mid-edit. Resumed; the agent re-derived state from `git diff` rather
than memory and found all three edits already complete and correct on disk. Explicitly checked
for the nonexistent-style-key hazard that bit an earlier mid-edit resume — did not occur.
Task 17: fix round 2 landed (fd3d208).
It also fixed a THIRD stale claim in the same Dashboard block that the review had not flagged
and that it had written itself ("SaleDetail must offer all of them" — untrue since 8a15fdd).
FOUR places now describe this endpoint's contract, synced by prose only — which is exactly why
two of them had drifted. Reinforces the already-deferred "one shared module for role lists".
Task 17: complete (commits 645993c..fd3d208, pending the combined re-review below).

## Combined review dispatched: Task 16 (4dad98c) + Task 17's fix (fd3d208)
Merged into one surface rather than two — the fix is comment/text-only and touches the same
files Task 16 converted, so a single reviewer can verdict both without a second read of the
same code.

## Task 16 review: Spec ✅, quality approved. Task 17 fix items 1-2 ADDRESSED, item 3 partial.
Reviewer SHIMMED the helper to CJS and EXECUTED it against a mocked react-native rather than
reading it. Confirmed showConfirm fires onConfirm only on a positive answer on both platforms,
the native destructive path emits button config identical to the originals, and the
372 → 327 reconciliation reproduces exactly.
FOUND BY EXECUTION — a real latent trap: showAlert's ack-picker fired ANY non-cancel button
with an onPress, so `[{Cancel,onPress},{Delete,destructive}]` — a very common shape where the
handler sits on the cancel side — ran the CANCEL handler on web. No current caller passes
buttons, but the helper exists so someone converts the remaining 327 sites, where this would
silently perform actions without asking.
Also found: the "no fourth stale comment remains" check FAILED — two more copies survived,
including server/routes/production.js:526-533, the AUTHORITATIVE one that explicitly tells
maintainers the lists "must stay in sync in BOTH directions", so a reader trusts it over the
client comments.

Task 16: fix round 1 landed (807d2e2). Helper re-executed against the reviewer's exact shape,
9/9 assertions pass. showAlert now auto-fires only on exactly one button — the single
unambiguous shape — and warns naming showConfirm otherwise. SIX prose copies of the endpoint
contract found and each verdicted: 2 stale (fixed), 4 accurate (untouched), no seventh; 5
further mentions were different subjects. Implementer verified the five-role claim against
source rather than trusting the review.

Task 16: minor (deferred): "49 call sites" is 49 grep LINES = 44 real calls + 5 comment
mentions; total conversions were 55 (44 + 7 showMessage + 4 notify). Arithmetic exact, noun loose.
Task 16: minor (deferred): showConfirm with an undefined onConfirm throws on web, no-ops on
native; all five callers pass functions.
Task 16: minor (deferred): the fold dropped showMessage's `typeof window !== 'undefined'`
guard; app.json has no static/SSR web output so there is no practical risk.

Task 16: fix round 1 re-review — 2 ADDRESSED, no new breakage.
Reviewer built its OWN harness rather than reusing the implementer's, and ran 15 assertions:
the trap shape no longer fires Cancel (warns naming showConfirm instead), a single-button ack
still fires, the native path receives the same buttons array BY REFERENCE (call[3] === buttons),
and showConfirm still runs onConfirm only on a positive answer with destructive styling intact.
Also proved both comment edits are comment-only via a diff filter it re-ran itself, and
reproduced the six-copy contract count independently across the whole repo — no seventh.
Task 16: complete (commits 8a15fdd..807d2e2, review clean)
Task 17: complete (commits 645993c..fd3d208, review clean)

Task 16: note for the 327-site follow-up (deferred): app/src/screens/LogOrderScreen.js:33
defines its OWN local `function showAlert(title, message, onDismiss)` with a DIFFERENT
signature, not imported from utils/alert.js. A naming collision waiting for whoever converts
the rest — pre-existing, out of scope here.

## ALL 17 TASKS COMPLETE AND REVIEWED CLEAN.
Remaining: Task 11 final verification (running), then the whole-branch review, then
superpowers:finishing-a-development-branch.

## Task 11 FINAL VERIFICATION: FAIL — 58 assertions, 56 passed, 2 failed
Checks 2/3/4/5/7/9/10 all PASS. actionBtn confirmed pre-existing and left. All theme tokens
resolve. Role lists show zero drift. Fixtures cleaned; Main Shop provably untouched.
The verifier caught the dev server serving STALE CODE (2 commits behind, including the Task 17
endpoint) and restarted before testing — the same trap that nearly invalidated Task 1.

### FAILURE 1 — IN RANGE, REAL, being fixed as Task 18
`computeOrderStage` returns `markReady` UNCONDITIONALLY from all three `preparing` branches,
while PUT /sales/:id/status refuses `ready` whenever any production task is incomplete.
Reproduced on untouched pre-existing sale 348 (400, row unchanged). 21 Test Loc orders are in
this state right now. order-stage.js does not exist at de08e17, so the button is in-range.
Same defect family as Task 1's Important 1 — a nextAction not mirroring its endpoint's
PRECONDITION — one rung earlier in the ladder. We fixed ready→completed and missed
preparing→ready. Mitigated only by the message being plain language (and, thanks to Task 16,
now actually visible on web) — but it is still a button the server refuses.

### FAILURE 2 — pre-existing, NOT in this plan's scope, now PROVEN reachable
Unpaid `walk_in` reaches `completed` bypassing the payment guard, because
`pref_walkin_auto_complete` closes orders by direct UPDATE rather than through the guarded
route. Live-reproduced twice (sales 349, 353: completed/pending). This was logged as a
deferred item after Task 1 on the theory it was reachable; it is now demonstrated, not
theorised. Fixing it means changing the auto-complete feature's behaviour — its own decision,
not a UI-plan side effect. SURFACE TO USER.

### THE BIGGEST HOLE, stated plainly: nothing on this branch has ever been SEEN
No agent in this run had a browser. The ≥900px responsive check — the original complaint that
started this work — was NOT performed. No layout, no colour, no rendered dialog is confirmed.
Someone must open localhost:8081 before merging.

## Task 18 (the Task 11 failure) — complete
Commit 3175320. Resumed after the seventh limit kill; all five edits were found complete on
disk and re-verified against a freshly restarted server.
Evidence: sale 348 went `Mark Ready` → nextAction null + a "2 tasks to finish" routing button
(the endpoint still 400s, proving the dead end was real). Differential over 208 sales × 7 roles
= 1456 comparisons produced 160 diffs, ALL `preparing → preparing, Mark Ready → null`, zero on
other ladders, zero on sales with no open tasks. A preparing sale with no open tasks still
offers Mark Ready and the PUT returns 200 with the row read back.
Also fixed en route: a live `(0/02)` string-concat bug — pg returns COUNT as a string. Other
sync-layer COUNTs were NOT swept.
WHY IT STAYED INVISIBLE (worth recording): every path that clears the last task auto-advances
the sale to `ready` itself, so the Mark Ready one-tap is near-dead in practice. The button was
wrong for months without anyone hitting it.

Task 18: minor (deferred): the incomplete-task predicate now lives in FIVE places,
cross-referenced by comment but drift-prone. Same class as the six prose copies of the
assignable-staff contract and the four client role lists mirroring server authorize() calls.
A shared helper is the real fix for all three.
Task 18: minor (deferred): ProductionQueueScreen has a correct third copy of the "N tasks left"
wording — left alone per CLAUDE.md's explicit deferral of that screen.

## FINAL FIX WAVE + RE-REVIEW: complete, MERGE-READY
Commit 22798fd. All 5 items ADDRESSED. Re-reviewer RE-DERIVED the cross-route comparison with
its own script (53/53 rows, 0 mismatches, 0 orphans) and proved it non-vacuous against a real
live row (sale 346, preparing, 3 open tasks, now null from all three routes). Proved teeth AND
no over-correction by calling computeOrderStage() directly: field absent → Mark Ready (the
defect), 3 → null, 0 → still offered. Its style auditor also has teeth — against 22798fd^ it
reports the actionBtn bug, against HEAD 59/59 clean.
Confirmed the commit contains exactly 4 files; the 17 pre-existing tracked modifications remain
unstaged and untouched.

### Adjudicated residual (no second fix wave, per process)
MINOR (documentation): deliveries.js:262-266 and the commit message claim an uncoerced "0"
"would block Mark Ready … the exact inverse of the bug". False — order-stage.js:116 already
coerces, and passing "0" still yields Mark Ready. The Number() is justified (wire type) but its
stated REASON is wrong. Same defect class as the is_active comment fixed in this very wave.
Ruling: park it. It is comment-only, the code is correct, and a second fix wave to correct a
comment's reasoning is not worth the regression risk at this gate. Recorded so it is not
carried forward as fact.

## BRANCH COMPLETE — 18 tasks, 78 commits, de08e17..22798fd
