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

### Issue 1 — owner/manager dashboard shows no orders; counter dashboard shows many

**ROOT CAUSE ESTABLISHED (evidence below). Both causes predate this branch — verified against
`de08e17`.**

The two role branches of `fetchDashboard` in `app/src/screens/DashboardScreen.js` fetch
differently:

- **counter_staff** (`:330-350`): four separate `api.getSales({status})` calls —
  `pending`, `confirmed`, `preparing`, `ready` — each `limit: 30`, scoped to
  `location_id: activeLocation?.id`, **with no date filter**.
- **owner/manager** (`:388-406`): one `api.getSales({...filters, limit: 500})` where `filters`
  includes **`filter_date`** derived from `dateScope`, which `useState(new Date())` defaults to
  **today** (`:222`, `:399-402`).

Server-side, `filter_date` means (from `server/routes/sales.js`):
`scheduled_date = <date> OR (scheduled_date IS NULL AND created_at within that day)`.

**Live evidence gathered 2026-09-03:**
```
counter_staff criteria (no date filter), all locations : 93 orders
owner/manager criteria (filter_date = today)           :  7 orders
open orders excluded purely by the date filter         : 54
the 7 matches broke down as: 3 completed, 4 ready — ALL at location_id 4
ALL open orders by location: loc 1 = 26, loc 4 = 67
```

So: an owner or manager whose `activeLocation` is **Main Shop (location 1)** matches **zero**
orders, because nothing was created or scheduled at Main Shop that day — while counter staff at
the same location sees 26. That is exactly the reported symptom.

**Before fixing, decide the product question:** is a *today-scoped* owner/manager board correct
and merely under-communicated (it has a visible date chip at `:1101`), or should the board show
open work regardless of date the way the counter board does? An empty board that is *correctly*
filtered still reads as broken, which is what happened here. Do not just delete the filter —
`dateScope` also feeds `getStaffToday` and the reports widgets.

### Issue 2 — the "Done today · N" count chip never appears

**ROOT CAUSE ESTABLISHED. Two different causes by role.**

- **counter_staff: structural, not data-dependent.** The four fetches above cover only
  `pending`/`confirmed`/`preparing`/`ready`. `completed` is **never fetched**, so the
  `doneCount` that `OrderKanbanBoard` derives from closed stages is always `0`, and the chip —
  gated on `doneCount > 0` — can never render on that dashboard. It is unreachable by
  construction.
- **owner/manager: a symptom of Issue 1.** `doneCount` derives from the same `sales` array; an
  empty array yields `0`.

Fixing Issue 1 fixes the owner/manager half. The counter half needs the fetch to include
completed orders (or the count to come from the `total` the API already returns — see the
deferred urgency-sort note in the execution log, which proposed exactly this).

### Issue 3 — owner/manager board is squeezed by the Team & Finance column

The owner/manager layout splits the page into `feedCol` (flex 2) / `healthCol` (flex 1) at
`DashboardScreen.js:~1217-1239`, gated on `isDesktop` (1100px) from `app/src/hooks/useBreakpoint.js`.
The owner wants the Team/Finance/register/staff elements **moved below the board** rather than
beside it, so the board gets full width.

This is a **design change, not a bug** — it needs the `superpowers:brainstorming` skill and the
`staff-ux-checklist` skill, not a straight edit. Note the breakpoint history in the execution
log: collapsing 1100 → 900 was tried and reverted because it crushed the four Stage columns to
~140px each; `useBreakpoint` deliberately exposes both `isWide` (900, board columns) and
`isDesktop` (1100, page split).

---

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
