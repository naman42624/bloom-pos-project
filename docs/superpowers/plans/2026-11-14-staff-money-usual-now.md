# Calmer add sheet, Usual now, and staff money — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PR A: a faster, calmer add sheet with a time-aware "Usual now" and 1-tap add. PR B: salary advances and shopping money at the counter (limits, PIN, settling, payroll), own-pocket spending with "Shop owes", and the register/close lines that keep the drawer explainable.

**Architecture:** Server first in each PR, then the app. Advances stay in `salary_advances` through one shared helper; shopping money, its settles, and what the shop owes get their own additive tables; every non-drawer expense uses a `payment_method` other than `'cash'` (`shopping_money`, `own_pocket`) so no drawer query can count it; drawer movements (hand-out, change back, pay back) join `computeRegisterClose` the way helper floats do.

**Tech Stack:** Express + `pg` (async layer, `withMoneyTx`), schema patches in `server/config/database.js`; Expo / React Native + React Navigation.

**Spec:** `docs/superpowers/specs/2026-11-14-staff-money-usual-now-design.md` (revised after the product review in `.superpowers/sdd/2026-11-14-staff-money/product-review.md`).

## Global Constraints

- Schema additive only; read the `db-migration-safety` skill before any schema task. No apostrophe inside a SQL `--` comment.
- New server code uses `getAsyncDb` / `withMoneyTx`; no new sync `getDb()` use.
- Names on screen exactly as spec §3: Salary advance · Shopping money · Shopping money out · "<Name> is back — what did he buy?" / Done · Take from pay · Own pocket · Shop owes / Pay back · Usual now · Often.
- Settings and defaults: `advance_daily_limit` 500, `advance_monthly_limit` 2000, `shopping_money_daily_limit` 1000, `shopping_money_late_days` 3.
- Non-drawer methods: `shopping_money` (settle bills, shopping write-offs) and `own_pocket` (own-pocket expenses). Only the routes named in this plan write them.
- PIN: approver chosen by id from `GET /api/staff-money/approvers`; verified with `approval-pin.js` `checkCodeAndPin` using that user's `employee_code`, roles `['manager','owner']`, manager must be linked to the shop, approver ≠ recipient; never inside a transaction that can roll back.
- Lock order in money transactions: the money row (`staff_money_out` / `shop_owes` / `salary_advances`) `FOR UPDATE` first, then `lockOpenRegister`.
- Helpers stay default-denied; nothing new in `server/utils/helper-routes.js`.
- Copy from spec §5.10; `showAlert`/`showConfirm` only; `useSubmitGuard` on Give, Done, Pay back, Usual now Add.
- Look: plain rows, 1 px `Colors.border` dividers, `Colors.textSecondary` secondary text, one pink primary button per screen, targets ≥ 44 px.
- Tests close only registers they opened; never touch registers 83 or 4383; cleanup by created ids only.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Two counters settle the same shopping money at once** → only one Done lands, drawer moves once. (Task B3 test `two settles at once`.)
2. **Change brought back on a later day** → counted in that day's open session; the closed session of the hand-out is untouched. (Task B3 test `change back next day`.)
3. **An approved in-app advance request today plus a counter advance** → both count toward the same day and month limits. (Task B2 test `request counts toward limits`.)
4. **Usual now Undo after the register closed in between** → plain refusal from the server, nothing moves. (Task A4 test `undo after close`.)
5. **Payroll paid after part of the ticked shopping money was settled** → Pay refused with "tap Calculate again", never an underpayment. (Task B5 test `stale take-from-pay refused`.)

---

## PR A — calmer add sheet and Usual now

### Task A1: Usual now / Often ranking on the server

**Files:**
- Create: `server/utils/usual-now.js`
- Modify: `server/routes/expenses.js` (`GET /suggest` without `q`)
- Test: `server/scripts/verify-usual-now.js` (new; pure checks + one route check)

**Interfaces:**
- Produces:
  - `findSlots(localMinutes: number[]) -> [{ start, end, count }]` (minutes since local midnight; entries within 120 min chain into one slot; keep slots with count ≥ 3).
  - `rankSuggestions(items, nowLocal) -> { usual_now: Item[], often: Item[] }`. Input item `{ id, pinned, pin_order, uses30, entries: [{ at: Date (shop-local), amount, method, created_by }], last_given_to }`. Rules spec §5.7: usual now when now ∈ [slot.start − 60, slot.end + 120] for a real slot, no entry today inside that slot window, and day-gap rule met (median days between entry days; usual day when days since last entry ≥ 0.8 × gap or gap ≤ 1). Often = pinned (by `pin_order`) then `uses30`, excluding usual-now items and anything with an entry in the last 120 min. `usual_now` ≤ 3, total ≤ 8.
  - `commonAmount(entries) -> number` (mode; tie → most recent).
  - Route response: `{ usual_now: [...], often: [...] }` alongside the existing `data` (kept for older app builds); each item gains `common_amount`, `my_last_method` (`'cash'|'upi'|null`, the caller's own last entry for that item), `last_given_to` with `present_today: boolean` (open attendance today).

- [ ] **Step 1: Write failing tests:** `tea at ~11:00 and ~16:00 daily: at 11:05 after an 11:00 entry → not usual; at 15:30 → usual`; `tea with no entry yet today at 10:30 → usual`; `petrol every 3 days, last yesterday → not usual, still in often`; `item added 30 min ago → in neither list`; `often never empty when items exist`; `commonAmount [50,50,60] → 50; [50,60] → most recent`; `route: my_last_method is the caller's, not another user's`.
- [ ] **Step 2: Run** `node server/scripts/verify-usual-now.js` — expect FAIL.
- [ ] **Step 3: Implement** with one query per request over the shop's last 60 days of `cash`/`upi` expenses with an item, converted to shop-local time (`localToday` helpers already in `expenses.js`).
- [ ] **Step 4: Run** this suite and `verify-expense-book.js` — expect PASS.
- [ ] **Step 5: Commit** `feat(expenses): Usual now learns time-of-day slots`.

### Task A2: Salary kind and privacy on the server

**Files:**
- Modify: `server/routes/expenses.js` (`POST /`, `PUT /:id`, `GET /`)
- Test: `server/scripts/verify-expense-book.js` (add checks)

**Interfaces:**
- Produces: `POST`/`PUT` with `category: 'salary'` from `employee` / `counter_staff` → 400 "Use Salary advance for money given to staff."; `GET /` for those roles maps every salary row whose `employee_id` ≠ caller to `{ description: 'Salary advance', employee_id: null, employee_name: null, given_to_*: null }`.

- [ ] **Step 1: Write failing tests:** `counter staff salary add refused with the copy`; `manager salary add still works`; `counter staff list shows another person's advance as "Salary advance" with no name`; `counter staff sees own advance with name`.
- [ ] **Step 2: Run** — expect FAIL. **Step 3: Implement.** **Step 4: Run** `verify-expense-book.js`, `verify-register-expenses.js`, `verify-attendance-payroll.js` — expect PASS.
- [ ] **Step 5: Commit** `feat(expenses): counter staff use Salary advance; salary names private`.

### Task A3: The add sheet

**Files:**
- Create: `app/src/components/expenses/SheetRow.js` (label left grey, value right, chevron, `disabled` + `hint`)
- Create: `app/src/components/expenses/OptionList.js` (plain modal list with optional search)
- Create: `app/src/components/expenses/MethodSwitch.js` (inline segmented `Cash | UPI` now; Task B7 adds `Own pocket`)
- Create: `app/src/components/expenses/RecentPeople.js` (3 inline chips + "More ›" → `OptionList` with "Someone else (type a name)")
- Modify: `app/src/components/expenses/AddExpenseSheet.js` (layout spec §4.1; keep every piece-1 rule: item resolve, register-closed Cash, back-dating UPI-only, old-cash locks, salary line, unsaved check, `useSubmitGuard`), `GivenToPicker.js` (replaced by `RecentPeople`; delete if unused), `ExpenseRow.js` (§4.8 plain style; labels for `shopping_money` / `own_pocket` arrive in B7)
- Test: `app/scripts/test-expense-book.js` stays green; new pure tests in `app/scripts/test-usual-now.js` for `pickDefaults(item, me)` in `app/src/utils/expenseBook.js`

**Interfaces:**
- Consumes: A1 response.
- Produces: `pickDefaults(item, { userId }) -> { amount, method, givenTo }` (amount = `common_amount`; method = `my_last_method || 'cash'`; givenTo = `last_given_to` only if `present_today`). `AddExpenseSheet` gains prop `mode: 'expense'|'advance'|'shopping'` (default `'expense'`) and `prefill` (used by A4).

- [ ] **Step 1: Write failing tests** for `pickDefaults` (absent person not pre-filled; own method beats another user's; no method → cash).
- [ ] **Step 2: Implement** the components and the sheet; Kind list hides Salary for `employee`/`counter_staff`.
- [ ] **Step 3: Run** app tests + babel-check touched files — expect PASS.
- [ ] **Step 4: On-screen** (desktop + 375 px; counter staff and manager): Tea in 3 taps; method shown on each suggestion; Cash disabled with Open register when closed; Change on an old register-less cash row still locked; salary not in Kind for counter staff.
- [ ] **Step 5: Commit** `feat(expenses-app): calmer add sheet with Usual now and inline Cash/UPI`.

### Task A4: Usual now 1-tap line

**Files:**
- Create: `app/src/components/expenses/UsualNowLine.js` (with an exported pure `undoReducer`)
- Modify: `app/src/screens/ExpensesScreen.js` (day list; owner summary when the period is Today)
- Test: `app/scripts/test-usual-now.js`

**Interfaces:**
- Consumes: A1 `usual_now`, A3 `pickDefaults`, existing `api.createExpense` / `api.deleteExpense`.

- [ ] **Step 1: Write failing tests** for `undoReducer`: `add → showing 15 s`; `undo success → gone`; `undo after close` (server refusal) `→ shows the server message, row stays`; `second add tap while saving ignored`.
- [ ] **Step 2: Implement:** ≤ 3 rows, method + person shown, `+ Add` saves, large bar "Added Tea ₹50 · Cash — Undo" for 15 s; name tap opens the sheet with `prefill`; Cash line + closed register → "Open register".
- [ ] **Step 3: Run** tests + babel-check; on-screen add, undo, fast double tap (one entry).
- [ ] **Step 4: Commit** `feat(expenses-app): Usual now 1-tap line with Undo`.

### Task A5: PR A regression and notes

- [ ] **Step 1: Run** every `server/scripts/verify-*.js` and `app/scripts/test-*.js` (env as in CLAUDE.md; `verify-gst-sales` fails only while `bill_round_off` is on).
- [ ] **Step 2: Write** the CLAUDE.md entry for PR A (under sub-project 4, after the expense book).
- [ ] **Step 3: Commit** `docs: calmer add sheet and Usual now shipped`. Stop: the controller asks the user before pushing / opening PR A.

---

## PR B — staff money

### Task B1: Schema, settings, helper module

**Files:**
- Modify: `server/config/database.js` (spec §7 tables, columns, settings, indexes: `staff_money_out (location_id,status)`, `(user_id,status)`; `staff_money_settles (register_id)`, `(money_out_id)`; `shop_owes (user_id,status)`; `shop_owes_payments (register_id)`)
- Create: `server/utils/staff-money.js`
- Test: `server/scripts/verify-staff-money.js` (new; harness like `verify-expense-book.js`)

**Interfaces:**
- Produces:
  - `getLimits(db) -> { advanceDay, advanceMonth, shoppingDay, lateDays }`
  - `totals(db, { userId }) -> { advanceToday, advanceMonth, shoppingToday, advancesUnpaid, shoppingHeld, owed }` (shop-local day/month; advances count status `approved`/`repaid`, any source)
  - `needsPin({ giver, recipientId, kind, amount, totals, limits }) -> null | 'self' | 'over_day' | 'over_month'` (pure; owner → null; manager self → null; counter staff/employee self → `'self'`)
  - `checkApprover(db, { approverId, pin, locationId, recipientId }) -> user` (throws spec copy)
  - `remaining(row) -> number` (whole paise)

- [ ] **Step 1: Write failing tests:** tables/columns/settings exist with defaults; `needsPin` table of cases (owner none; manager self none; staff self 'self'; 300 after 300 with day 500 → 'over_day'; 100 with month total 1950 of 2000 → 'over_month'); `remaining` 500 − 300 − 150 = 50.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** after an API restart — PASS.
- [ ] **Step 5: Commit** `feat(staff-money): schema, settings and limit/PIN helpers`.

### Task B2: Salary advance at the counter

**Files:**
- Create: `server/routes/staff-money.js` (mounted `/api/staff-money` in `server/server.js`), `server/utils/advance-payout.js`
- Modify: `server/routes/attendance.js` (approve branch uses the helper), `server/routes/expenses.js` (`DELETE /:id`, `PUT /:id` on a row linked from `salary_advances.expense_id`)
- Test: `server/scripts/verify-staff-money.js`

**Interfaces:**
- Consumes: B1.
- Produces:
  - `payAdvance(tx, { userId, amount, method, locationId, givenBy, approvedBy, source, advanceId? }) -> { advanceId, expenseId }` (inside the caller's `withMoneyTx`; cash: `lockOpenRegister`, `expected_cash` down; 400 "Open the register to give cash — or pick UPI.").
  - `GET /people?location_id=` → `[{ id, name, role, recent_rank }]` (active staff and riders linked to the shop; owner/manager/employee/counter_staff can call).
  - `GET /approvers?location_id=` → `[{ id, name, role }]` with `pin_hash` set (owner + linked managers).
  - `POST /advance` `{ location_id, user_id, amount, payment_method, note?, approver_id?, approver_pin? }` → 201 `{ data: { advance_id, expense_id, unpaid_after } }`; 409 `{ needs_pin, message }`.
  - Owner notification (`notifyByRole({ roles: ['owner'], ... })`) on manager-self and on any PIN-approved amount.

- [ ] **Step 1: Write failing tests:** under limits → advance approved `source='counter'`, salary expense with `register_id`, drawer −300; UPI → no drawer change; `over_day`, `over_month` and `self` → 409 with spec copy; approver = recipient 403; manager not linked 403; owner PIN passes and is `approved_by`; manager self → 201 and an owner notification row; `request counts toward limits` (RF3); helper/florist 403; removing the advance's expense → advance `cancelled`, drawer back, audit row; changing its amount → advance amount follows; changing its employee → refused; removing after payroll deducted it → refused; approving an in-app request still writes the same expense shape.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** this suite + `verify-attendance-payroll`, `verify-register-expenses`, `verify-cash-safety`, `verify-expense-book` — PASS.
- [ ] **Step 5: Commit** `feat(staff-money): salary advance at the counter`.

### Task B3: Shopping money and the drawer lines

**Files:**
- Modify: `server/routes/staff-money.js`
- Modify: `server/utils/register-close.js` (`computeRegisterClose` returns `shoppingOutTotal`, `shoppingInTotal`, `owesPaidTotal`; `expectedCash` − out + in − owesPaid), `server/routes/sales.js` (register status running figures, history rows, closed-session inferred expenses), `server/routes/deliveries.js` (pickup overwrite)
- Test: `server/scripts/verify-staff-money.js`

**Interfaces:**
- Consumes: B1, B2 PIN/limit flow.
- Produces:
  - `POST /shopping` (same body as `/advance`) → 201 `{ data: { id } }`.
  - `POST /:id/settle` `{ bills: [{ item_id?, item_name?, description?, category?, amount }], change_back, change_method, final }` → `{ data: { remaining, status, owes_id? } }`. Bills → expenses (`shopping_money`, `money_out_id`, Given to = holder). Bills beyond what is left → `shop_owes` row for the excess (`source='overspend'`, `money_out_id`). `change_back` > what is left after bills → 400 "<Name> only has ₹<x> left — check the change amount."
  - `DELETE /:id` (giver in the same open session, or owner/manager; nothing settled) → `removed`, cash back.
  - `POST /:id/write-off` (owner) `{ reason }` → remainder as a `shopping_money` expense "Shopping money written off — <name>", status `written_off`.
  - `GET /open?location_id=` → `{ shopping: [{ id, user_id, user_name, remaining, created_at, given_by_name, late }], owes: [...] }`; `GET /history?...`; `GET /mine`.
  - Register status/history fields `shopping_out`, `shopping_in`, `owes_paid`; close preview carries `shopping_still_out: [{ user_name, remaining }]` for the shop.
  - `DELETE /api/expenses/:id` on a settle bill → amount back as still held (`settled_amount −= amount`, status `open`), no drawer move.

- [ ] **Step 1: Write failing tests:** hand-out 500 cash → drawer −500, no expense; part settle 300 → remaining 200, bills are `shopping_money`; Done with 200 cash change → drawer +200, settled, net −300; overspend 620 on 500 → owes 120; no bills, change only → OK; change too high → 400 copy; `two settles at once` (RF1); `change back next day` (RF2: back-date the hand-out and its register, settle into the test's open register); close preview = status running figure; a `shopping_money` bill with NULL `register_id` inside the session leaves `expected_cash` unchanged; giver removes own typo in the same session; other counter staff cannot; remove after part settle → 409; deleting a settle bill reopens that amount; write-off; late after 3 days; helper 403 on every new route; audit rows present.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** (settle: `staff_money_out` row `FOR UPDATE`, re-check, then `lockOpenRegister` only for cash change). **Step 4: Run** this suite + all register suites (`verify-register-expenses`, `verify-cash-safety`, `verify-helper-bags`, `verify-quick-sale`, `verify-order-flows`, `verify-expense-book`) — PASS.
- [ ] **Step 5: Commit** `feat(staff-money): shopping money, settle and drawer lines`.

### Task B4: Own pocket and Shop owes

**Files:**
- Modify: `server/routes/expenses.js` (`POST /` and `PUT /:id` accept `payment_method: 'own_pocket'` + `paid_by_user_id`; never `register_id`; creates/updates the `shop_owes` row; `DELETE` removes its open amount, refused once part was paid back), `server/routes/staff-money.js` (owes routes)
- Test: `server/scripts/verify-staff-money.js`

**Interfaces:**
- Produces: `POST /owes/:id/pay-back` `{ amount, method }` (cash needs the open register; `shop_owes_payments` row with `register_id`; `expected_cash` down), `POST /owes/:id/keep` (owner, own line only → `kept`), `POST /owes/:id/write-off` (owner).

- [ ] **Step 1: Write failing tests:** own-pocket expense → no drawer change, owes row for that person; counter staff can mark own pocket for self or a named colleague; pay back 850 cash → drawer −850, status paid; part pay back; owner keep → kept; staff cannot keep; remove own-pocket expense before pay back → owes gone; after part pay back → refused; `own_pocket` rows never counted by drawer queries.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** this suite + `verify-expense-book` + register suites — PASS.
- [ ] **Step 5: Commit** `feat(staff-money): own pocket and Shop owes`.

### Task B5: Payroll — Take from pay

**Files:**
- Modify: `server/routes/staff-management.js` (`POST /payroll/calculate`, `POST /payroll/disburse`)
- Test: `server/scripts/verify-staff-money.js`

**Interfaces:**
- Produces: calculate → `calculation.open_shopping_money_total` (0 for riders/no salary); disburse accepts `take_shopping_money: { expected_total }`; mismatch with the current total → 409 "Shopping money changed since you calculated — tap Calculate again."; success → advance `source='shopping_money'` for the remainder, hand-outs `to_salary`, deducted in the same payment.

- [ ] **Step 1: Write failing tests:** calculate shows the open total; take-from-pay deducts and closes; `stale take-from-pay refused` (RF5); rider gets 0 and no option.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** inside disburse's transaction before the advance-deduction loop (lock hand-outs `FOR UPDATE`). **Step 4: Run** + `verify-attendance-payroll` — PASS.
- [ ] **Step 5: Commit** `feat(staff-money): Take from pay at payroll`.

### Task B6: App API and pure helpers

**Files:**
- Modify: `app/src/services/api.js`
- Create: `app/src/utils/staffMoney.js`
- Test: `app/scripts/test-staff-money.js`

**Interfaces:**
- Produces: api methods for every B2–B4 route; `staffMoney.js`: `defaultChange(left, bills)` (≥ 0), `overspend(left, bills)` (≥ 0), `stillWith(left, bills, change)`, `heldLabel(createdAt, now)`, `pinMessage(needs_pin, { limits, name })` (spec §5.10 copy).

- [ ] **Step 1: Write failing tests** with spec numbers (500/300 → change 200; 500/620 → overspend 120; month copy names the person). **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS. **Step 5: Commit** `feat(staff-money-app): api and helpers`.

### Task B7: Salary advance, Shopping money and Own pocket in the sheet

**Files:**
- Create: `app/src/components/expenses/MoneyToStaffForm.js`, `app/src/components/expenses/ApproverPin.js` (pick a name from `/approvers` → PIN; empty-list help copy; lockout note)
- Modify: `AddExpenseSheet.js` (two links; typed "advance"/"shopping"; "<Name> is back? ›" hint), `MethodSwitch.js` (`Own pocket` + "Whose?" chips), `ExpenseRow.js` (labels "Shopping money · Ramesh", "Own pocket · Owner")
- Test: app tests + on-screen

- [ ] **Step 1: Implement** (Who from `/people`; unpaid/held line under Note; 409 `needs_pin` → `ApproverPin`, resend).
- [ ] **Step 2: Run** app tests + babel-check.
- [ ] **Step 3: On-screen:** ₹300 advance in 5 taps; ₹600 asks PIN (pick name); counter staff self asks PIN; own-pocket expense shows in Shop owes; UPI works with register closed.
- [ ] **Step 4: Commit** `feat(staff-money-app): advance, shopping money and own pocket in the add sheet`.

### Task B8: Shopping money out card, "is back", Pay back, history

**Files:**
- Create: `app/src/components/expenses/ShoppingMoneyCard.js`, `app/src/screens/ShoppingMoneyBackScreen.js`, `app/src/screens/ShoppingMoneyHistoryScreen.js`
- Modify: `app/src/screens/DashboardScreen.js` (counter/employee and owner/manager branches), `app/src/screens/ExpensesScreen.js` (top), `app/src/navigation/MainNavigator.js` (every stack with `Expenses`)
- Test: app tests + on-screen

- [ ] **Step 1: Implement** spec §4.4 and §4.7 (history, owner write-off with reason, Keep as my money on the owner's own line).
- [ ] **Step 2: Run** app tests + babel-check.
- [ ] **Step 3: On-screen:** 500 out → back with 300 bills + 200 change → card clears; overspend → Shop owes 120 → Pay back cash; part settle keeps the line; red after the late days (seeded old row).
- [ ] **Step 4: Commit** `feat(staff-money-app): shopping money card, is-back screen, pay back and history`.

### Task B9: Register lines, close note, My money, settings, payroll tick, deactivate warning

**Files:**
- Modify: `app/src/screens/CashRegisterScreen.js` (session lines "Shopping money given", "Change brought back", "Shop owes paid back"; closed-session expense formula subtracts them as it does helper floats; close screen "₹X still with <name>")
- Modify: `app/src/screens/ProfileScreen.js` (My money), `app/src/screens/SettingsScreen.js` (four owner settings), `app/src/screens/SalaryManagementScreen.js` (separate Take from pay line; sends `expected_total`; handles the 409), `app/src/screens/UserFormScreen.js` (deactivate warning from `GET /staff-money/open`)
- Test: on-screen; server suites already cover the maths

- [ ] **Step 1: Implement.** **Step 2: Babel-check.**
- [ ] **Step 3: On-screen:** register session lines match the Expenses list; close shows "still with"; My money as counter staff; settings and payroll tick as owner (test employee only); deactivate warning.
- [ ] **Step 4: Commit** `feat(staff-money-app): register lines, My money, settings and payroll tick`.

### Task B10: PR B regression and notes

- [ ] **Step 1: Run** every server and app suite.
- [ ] **Step 2: Write** the CLAUDE.md entry for PR B (rulings: non-drawer methods, lock order, payroll stale check, privacy, riders left for piece 3).
- [ ] **Step 3: Commit** `docs: staff money shipped`. Stop: the controller asks the user before pushing / opening PR B.
