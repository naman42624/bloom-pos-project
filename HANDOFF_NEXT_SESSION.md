# Handoff — Petal: dashboard order-flow bugs + owner/manager layout

**Repo:** `/Users/gauravbhatia/Downloads/Projects/test Project`
**Branch:** `feature/identity-roles-pin-login` · **HEAD:** `fd60780` · working tree has only
pre-existing unrelated modifications (see "Tree state" below).
**Dev server:** port **3001** (`server/.env` sets `PORT=3001` — NOT 5000). **Expo web:** 8081.

---

## 1. What just finished (context, not work to redo)

An 18-task plan is **complete, reviewed clean, and merge-ready** (78 commits, `de08e17..fd60780`).
It made `display_stage` the single status vocabulary, replaced the per-order-type nested board
with one unified Stage board, added an exceptions-only order card, removed dead-end buttons,
added inline rider/preparer assignment, and made error messages visible on the web build.

**Do not re-do any of it.** Read these before touching the dashboard:

| File | What it is |
| --- | --- |
| `docs/superpowers/logs/2026-09-03-dashboard-stage-ui-redesign-execution-log.md` | **Read this first.** Every task's outcome, all 32 rulings with reasoning and cost-if-wrong, every deferred finding and known limitation. |
| `docs/superpowers/specs/2026-09-01-dashboard-stage-ui-redesign-design.md` | The spec the work argues from |
| `docs/superpowers/plans/2026-09-02-dashboard-stage-ui-redesign.md` | The 18-task plan |
| `CLAUDE.md` | Project rules. Non-negotiable constraints live here |
| `git log --oneline de08e17..HEAD` | The branch |

Key files this work created/changed:
`server/utils/order-stage.js` · `server/routes/sales.js` · `server/routes/deliveries.js` ·
`server/routes/production.js` · `app/src/components/StageBadge.js` ·
`app/src/components/orderBoard/{OrderCard,StageColumn,OrderKanbanBoard,AssignPickerModal}.js` ·
`app/src/constants/{orderStages,orderDisplay}.js` · `app/src/hooks/useBreakpoint.js` ·
`app/src/utils/alert.js` · `app/src/screens/{DashboardScreen,SaleDetailScreen,OrdersInboxScreen,DeliveriesScreen}.js` ·
`app/src/components/QuickModals.js` · `app/scripts/babel-check.js`

---

## 2. THE NEW WORK — three issues the shop owner reported after using it

**All three were investigated to root cause before this handoff. Findings are confirmed live.
The full evidence is in `INVESTIGATION_FINDINGS.md` (repo root) — read it, it saves you the work.**

### Issue 1 — owner/manager dashboard shows no orders; counter dashboard shows many

**CONFIRMED live through the real API at both locations. Cause predates this branch (verified
against `de08e17`).**

The two role branches of `fetchDashboard` in `app/src/screens/DashboardScreen.js` fetch
differently:

- **counter_staff** (`~:330-350`): four `api.getSales({status})` calls — `pending`, `confirmed`,
  `preparing`, `ready` — each `limit: 30`, scoped to `activeLocation?.id`, **no date filter**.
- **owner/manager** (`~:388-406`): one `api.getSales({...filters, limit: 500})` where
  `filters.filter_date` comes from `dateScope`, which defaults to **today** (`:222`, `:399-402`).

Server-side, `filter_date` means:
`scheduled_date = <date> OR (scheduled_date IS NULL AND created_at within that day)`.

**Live result, measured through the API:**

| | Main Shop (loc 1) | Test Loc (loc 4) |
| --- | --- | --- |
| owner/manager request (`filter_date` = today) | **0 rows** | **0 rows** |
| counter_staff requests (no date filter) | 26 rows | 67 rows |

So the owner/manager board renders **zero cards at both locations**, while counter staff sees
26 and 67. That is exactly the reported symptom, and it is fully explained.

*Correction to an earlier note:* an initial DB probe on 2026-09-03 found 7 matches at Test Loc.
That was date-dependent — re-measured through the API, today it is 0 at both. The filter's
effect swings day to day, which is precisely why it reads as "broken" rather than "filtered".

**Also worth knowing:** the counter fetch's `limit: 30` per status did not truncate today, but
the margin is thin — 21/30 and 19/30 at Test Loc. A busier day silently drops orders.

**Before fixing, decide the product question.** Is a *today-scoped* owner/manager board correct
and merely under-communicated (there is a visible date chip at `:1101`), or should it show open
work regardless of date the way the counter board does? An empty board that is *correctly*
filtered still reads as broken. **Do not just delete the filter** — `dateScope` also feeds
`getStaffToday` and the reports widgets.

### Issue 2 — the "Done today · N" count chip never appears

**CONFIRMED both structurally and empirically.**

- **counter_staff: unreachable by construction.** The four fetches cover only
  `pending`/`confirmed`/`preparing`/`ready`. `completed` is never requested, so the `doneCount`
  that `OrderKanbanBoard` derives from closed stages is always `0`, and the chip — gated on
  `doneCount > 0` — can never render.
- **owner/manager: a symptom of Issue 1** (empty `sales` → `0`).

The investigation added a stronger empirical proof: **zero live sales anywhere** have a closed
`display_stage` while still carrying a status the dashboard fetches — because the two relevant
endpoints flip `status = 'completed'` in the same DB transaction as the closing field. So there
is no data state in which the current fetch could populate that count.

Fixing Issue 1 fixes the owner/manager half. The counter half needs the fetch to include
completed orders, or the count to come from the `total` the API already returns (the deferred
urgency-sort note in the execution log proposed exactly this).

### Issue 3 — owner/manager board is squeezed by the Team & Finance column

**Facts gathered; deliberately not designed.**

- The two-column split is `DashboardScreen.js:1646-1747` — `feedCol` (flex 2) / `healthCol`
  (flex 1), gated on `isDesktop` (1100) from `app/src/hooks/useBreakpoint.js`.
- `healthCol` contains: **Staff Pulse** (all roles), **Registers** and **Revenue** (owner-only).
- **Therefore a *manager* sees a single small widget occupying a third of the width.** That is
  the strongest argument for the owner's request, and it came out of the investigation rather
  than the report.
- Both columns share one `ScrollView`. **No structural blocker** to moving the widgets below.
  The real cost is restyling `widgetCard` and the Revenue block for full width rather than a
  1/3 column.

This is a **design change, not a bug** — use `superpowers:brainstorming` and the
`staff-ux-checklist` skill.

**History so you do not re-tread it:** `useBreakpoint` deliberately exposes **two** thresholds —
`isWide` (900, board columns) and `isDesktop` (1100, page split). Collapsing them to one was
tried during the prior work and **reverted**: at 901px the board got ~2/3 width and the four
Stage columns landed at ~140px each.

### Other findings from the order-flow testing (none blocking)

1. **Low** — a dashboard card can read "`<rider>` has it" for a delivery merely *assigned*, not
   yet collected from the shop. Misleading text; same root cause as the already-documented
   "assigned shows as plain Ready" ladder-ordering gap.
2. **Cosmetic data drift** — 2 live Test Loc pickup orders have `status = ready` with a stale
   `pickup_status = waiting`. `display_stage` compensates correctly; no functional impact.
3. **Worth knowing** — 0 of 39 live `preparing` orders DB-wide currently have zero open tasks,
   so the `Mark Ready` guard added at the end of the prior work has only ever been exercised
   *negatively* (correctly blocking), never *positively* (correctly allowing) on live data.
4. **Ruled out** — a hypothesised dead end (assigned delivery + no COD → dead "Mark Delivered")
   was chased through live API calls and is **not** a new defect; it is the known ladder-ordering
   gap.

**Clean result:** `GET /sales` and `GET /deliveries` agreed on `display_stage` for **25/25**
compared sales at Test Loc.

## 3. Method

Use `superpowers:systematic-debugging` for Issues 1–2 (Phase 1 is already done and recorded
above — carry it forward rather than repeating it) and `superpowers:brainstorming` for Issue 3.
The prior work used `superpowers:subagent-driven-development`; that is optional here given the
smaller scope, but the review-after-every-change discipline is what caught the serious bugs.

---

## 4. Traps that will cost you time

- **`babel-check` does NOT catch missing `StyleSheet` keys or unresolved `Colors.*` /
  `FontSize.*` / `Spacing.*` / `BorderRadius.*` tokens.** They transform cleanly and render
  unstyled. Two real instances were found this way; one is still live (`styles.actionBtn`,
  `QuickModals.js:899,908`, DeliveryQuickModal's Convert buttons). Always audit
  `styles.X` / token references against their definitions, and report **used-and-defined**, not
  merely "used" — that arithmetic already hid one real bug.
- **A 200 is not evidence.** Two bugs in the prior run returned success while doing nothing.
  Read rows back.
- **Verify API response shapes against the route.** Briefs were wrong about field names three
  separate times (`data.users` not `data.partners`; `active_delivery_count` not `active_count`,
  and it arrives as a **string** from pg).
- **`react-native-web`'s `Alert` is `class Alert { static alert() {} }`** — a no-op. Use
  `showAlert`/`showConfirm` from `app/src/utils/alert.js`. **327 `Alert.alert` calls across ~61
  files are still silent on web** — the largest open gap on the branch.
- **No test runner exists and none may be created.** Verification is
  `cd app && node scripts/babel-check.js <files>`, live curl, and reading rows back.
- **Serialize agents that share a file** — implementer-vs-implementer *and* reviewer-vs-implementer.
  A reviewer reading a mid-edit working tree reports phantom findings.
- **Test Loc is `location_id = 4`. Main Shop is `location_id = 1` — never write to it.**
- Restart the dev server if it serves stale code; it bit twice in the prior run
  (`node server.js`, not nodemon).

**Live data facts:** all four active `employee` accounts have **no** `employee_code`;
locations 2 and 3 are staffed only by a manager and the owner; the real prep staff sit at Main
Shop; `pref_manager_override` and `pref_walkin_auto_complete` are both **on**.

---

## 5. Tree state — needs a decision before merge

`git status` shows ~17 tracked modifications that **predate this session entirely** (`PRD.md`,
`README.md`, `PROGRESS.md`, `server/package.json`, `server/package-lock.json`, several
`server/*.js` scratch files) plus a large set of untracked `server/test_*.js` scratch files.
None were touched by this work. They need a decision (commit / stash / ignore) before merge.

---

## 6. Open items from the prior work — do not let these disappear

- **327 `Alert.alert` calls still silent on the web build** (~61 files).
- **`PUT /api/sales/:id` writes a caller-supplied `payment_status` with no whitelist**, against a
  column with no CHECK constraint. Arbitrary strings can reach live money data. Sub-project 8.
- **`pref_walkin_auto_complete` bypasses the payment guard** via direct UPDATE — an unpaid
  walk-in can reach `completed`. Proven live (sales 349, 353). Pre-existing; fixing it changes
  that feature's behaviour, so it is the owner's call.
- **A network timeout after a successful payment write** still reads as failure to the user.
  Needs idempotency keys; not fixable at the client layer.
- **`pref_manager_override` is on**, which makes the client's `Mark Ready` gate stricter than the
  server for pickup/delivery orders (the override bulk-completes tasks before the guard runs).
  Nothing is stranded. Owner's call.
- **Three duplication clusters synced by comment only** — the incomplete-task predicate (3 files),
  the assignable-staff contract (6 prose copies), client role lists mirroring server
  `authorize()` (4 places). All verified in sync today, but two drifted *during* one branch.
- **Deliberate follow-up:** reorder the delivery ladder so terminal `completed` precedes
  `out_for_delivery`, and give assigned-but-not-collected its own sub-state. Two lines, but feeds
  three routes and the whole dashboard — needs its own verification pass.
- **`styles.actionBtn`** renders DeliveryQuickModal's Convert buttons unstyled today.
  `actionBtnFull` exists two lines away.

---

## 7. The biggest gap: nothing has ever been seen rendered

No agent in the prior run had a browser. Every layout, colour, spacing and dialog claim on this
branch is code-reasoned only — including the ≥900px responsive board behaviour, which was the
complaint that started the work, and including the new web alert dialogs. Issues 1–3 above are
the first real user feedback from actually looking at it.

**Open `localhost:8081` early.** Check as counter_staff, as owner, and as manager, at roughly
880 / 1000 / 1300px.
