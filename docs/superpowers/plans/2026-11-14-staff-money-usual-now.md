# Staff money, Usual now and calmer add sheet — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Salary advances and shopping money handed out at the counter (with limits, PIN, settling and payroll), a 1-tap "Usual now" line that learns each item's usual gap, and a calmer Notion-style add sheet.

**Architecture:** Server first: one additive table pair (`staff_money_out`, `staff_money_settles`), advances written into the existing `salary_advances` through one shared helper, drawer maths added to `computeRegisterClose` the same way helper floats are, settle bills stored as expenses with `payment_method = 'shopping_money'` so no drawer query ever counts them. Then the app: the add sheet is rebuilt from small row components, with advance/shopping modes, a Money with staff card and settle screen, My money, owner settings and the payroll tick.

**Tech Stack:** Express + `pg` (async layer `server/config/database-async.js`, `withMoneyTx`), schema patches in `server/config/database.js`; Expo / React Native + React Navigation.

**Spec:** `docs/superpowers/specs/2026-11-14-staff-money-usual-now-design.md`

## Global Constraints

- Schema additive only (`ensureColumn`, `CREATE TABLE IF NOT EXISTS`, settings seeded only if missing). Read the `db-migration-safety` skill before Task 1. No apostrophe inside any SQL `--` comment.
- New code uses the async layer (`getAsyncDb`, `withMoneyTx`); don't add new sync `getDb()` use.
- Settings keys and defaults: `advance_daily_limit` = `500`, `shopping_money_daily_limit` = `1000`, `shopping_money_late_days` = `3`.
- Settle bills: `payment_method = 'shopping_money'`, `money_out_id` set. Nothing else writes that method.
- PIN approvers: active `manager` linked to the shop (`user_locations`) or `owner`; approver ≠ recipient; owner as giver never needs a PIN. Checked with `server/utils/approval-pin.js` `checkCodeAndPin` (employee code + PIN), never inside a transaction that rolls back.
- Helpers stay default-denied: do not add any new route to `server/utils/helper-routes.js`.
- Lock order inside money transactions: the money-out row (`FOR UPDATE`) first, then `lockOpenRegister`. Same order everywhere.
- Copy is fixed by spec §4.7; use `showAlert`/`showConfirm`, never `Alert.alert`; double-tap guard `useSubmitGuard` on Give, Settle and Usual now Add.
- Notion look: plain rows, 1 px dividers (`Colors.border`), grey secondary text (`Colors.textSecondary`), one pink primary button per screen, tap targets ≥ 44 px.
- Tests never close or touch a register they did not open; never touch registers 83 or 4383.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **The same hand-out settled twice at once** (two counters tap Settle): the second must get 409 "Already settled — refresh", never a double change-return into the drawer. → Task 3 test `settle twice in parallel: one wins, drawer moves once`.
2. **Change returned into a different register session than the hand-out came from** (handed out yesterday, settled today): close of today's session counts the change in; yesterday's closed session is not touched. → Task 3 test `change returned next day lands in today's session only`.
3. **Limit counts across paths:** an approved in-app request today plus a counter advance must add up against the same daily limit. → Task 2 test `approved request counts toward today's limit`.
4. **Usual now Undo after the register closed in between** (add at 18:59, close at 19:00, Undo at 19:00:05): removal must follow piece 1's remove rules (refuse plainly), not silently move cash. → Task 9 test `undo after close shows the remove-refused message`.
5. **Payroll tick on a hand-out partly settled since calculate:** the converted advance must be the remainder at disburse time, not the stale figure. → Task 4 test `take-from-pay uses the remainder at disburse time`.

---

### Task 1: Schema, settings and the staff-money helper module

**Files:**
- Modify: `server/config/database.js` (new tables, columns, settings)
- Create: `server/utils/staff-money.js`
- Test: `server/scripts/verify-staff-money.js` (new suite; same harness style as `verify-expense-book.js`: login via `VERIFY_OWNER_*`, seed throwaway staff at Test Loc, cleanup by created ids only)

**Interfaces:**
- Produces:
  - Tables `staff_money_out(id, location_id, user_id, amount NUMERIC(12,2), payment_method TEXT, register_id, given_by, approved_by, note TEXT, status TEXT DEFAULT 'open', settled_amount NUMERIC(12,2) DEFAULT 0, returned_amount NUMERIC(12,2) DEFAULT 0, created_at TIMESTAMP DEFAULT NOW(), closed_at TIMESTAMP)` and `staff_money_settles(id, money_out_id, bills_amount, returned_amount, returned_method, register_id, settled_by, created_at)`, with the indexes in spec §5.
  - Columns `expenses.money_out_id`, `salary_advances.given_by`, `source`, `payment_method`, `location_id`.
  - `staff-money.js` exports:
    - `getLimits(db) -> { advance: number, shopping: number, lateDays: number }`
    - `todayTotal(db, { kind: 'advance'|'shopping', userId }) -> number` (shop-local today; advances count `salary_advances` with status approved/repaid dated today, any source; shopping counts `staff_money_out` not `removed` created today)
    - `needsPin({ giverId, giverRole, recipientId, amount, todaySoFar, limit }) -> null | 'self' | 'over_limit'` (pure)
    - `checkApprover(db, { code, pin, locationId, recipientId }) -> approver user row` (throws 401/403 with spec copy)
    - `remaining(row) -> number` = `amount − settled_amount − returned_amount`, whole paise
    - `isLate(row, lateDays, now) -> boolean`

- [ ] **Step 1: Write failing tests** in `verify-staff-money.js`: `schema: staff_money_out and staff_money_settles exist with the spec columns`; `settings seeded: 500 / 1000 / 3`; `needsPin: self -> 'self'; owner giver -> null; 300 after 300 with limit 500 -> 'over_limit'; 200 after 300 -> null`; `remaining: 500 − 300 − 150 = 50`.
- [ ] **Step 2: Run** `node server/scripts/verify-staff-money.js` — expect FAIL (missing table/module).
- [ ] **Step 3: Implement** the patches and `server/utils/staff-money.js`. `checkApprover` calls `checkCodeAndPin(db, code, pin, { roles: ['manager','owner'], wrongPinMessage: "That PIN didn't match. Try again or ask the manager.", inactiveAsUnknown: true })`, then refuses an approver who is the recipient (403 "Someone else must confirm money for themselves.") and a manager not linked to `locationId` (403 "That manager isn't linked to this shop.").
- [ ] **Step 4: Run** the suite — expect PASS; restart the API so boot patches run, re-run.
- [ ] **Step 5: Commit** `feat(staff-money): schema, settings and limit/PIN helpers`.

### Task 2: Give a salary advance at the counter

**Files:**
- Create: `server/routes/staff-money.js` (mounted at `/api/staff-money` in `server/server.js`)
- Create: `server/utils/advance-payout.js`
- Modify: `server/routes/attendance.js` (approve branch of `PUT /salary-advance/:id/:action` calls the shared helper)
- Test: `server/scripts/verify-staff-money.js`

**Interfaces:**
- Consumes: Task 1 `staff-money.js`.
- Produces:
  - `payAdvance(tx, { userId, amount, method, locationId, givenBy, approvedBy, source, advanceId = null }) -> { advanceId, expenseId }` — inside the caller's `withMoneyTx`: inserts (or, with `advanceId`, approves) the `salary_advances` row, writes the `salary` expense (`employee_id`, `register_id`, description `Salary advance — <name>`), and for cash locks the open register and lowers `expected_cash`. Throws 400 `REGISTER_CLOSED` copy "Open the register to give cash — or pick UPI." when cash and no open register.
  - `POST /api/staff-money/advance` body `{ location_id, user_id, amount, payment_method: 'cash'|'upi', note?, approver_code?, approver_pin? }` → 201 `{ success, data: { advance_id, expense_id, amount, user_name } }`. Roles: owner, manager, employee, counter_staff. 409 with `{ needs_pin: 'self'|'over_limit', message }` when a PIN is needed and missing.

- [ ] **Step 1: Write failing tests:** `advance under the limit: 201, salary_advances approved source=counter, salary expense with register_id, drawer down by 300`; `UPI advance: no register change`; `over the limit without PIN: 409 needs_pin=over_limit with the spec copy`; `self without PIN: 409 needs_pin=self`; `self with own PIN refused 403`; `manager PIN not linked to shop refused 403`; `owner PIN allows over-limit; approved_by = owner`; `approved request counts toward today's limit` (Review Focus 3); `helper and florist get 403`; `cash with register closed: 400 with the spec copy` (use a location whose register the test controls); `approving an in-app request still works and writes the same expense shape` (regression for the shared helper).
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** `advance-payout.js`, the route (PIN check outside the transaction, then `withMoneyTx` → `payAdvance`), and switch the attendance approve branch to `payAdvance` with `advanceId`.
- [ ] **Step 4: Run** the suite plus `verify-attendance-payroll.js`, `verify-register-expenses.js`, `verify-cash-safety.js` — expect PASS.
- [ ] **Step 5: Commit** `feat(staff-money): give a salary advance at the counter`.

### Task 3: Shopping money: hand out, settle, remove, list, and the drawer maths

**Files:**
- Modify: `server/routes/staff-money.js`
- Modify: `server/utils/register-close.js` (`computeRegisterClose` adds `shoppingOut`, `shoppingIn`)
- Modify: `server/routes/sales.js` (register status running figures ~L637-680, history ~L953-971, closed-session inferred expenses), `server/routes/deliveries.js` (pickup overwrite: include the same two terms beside `helper_floats`)
- Test: `server/scripts/verify-staff-money.js`

**Interfaces:**
- Consumes: Task 1 helpers; Task 2 PIN/limit flow (same body fields, 409 `needs_pin`).
- Produces:
  - `POST /api/staff-money/shopping` body as the advance route → 201 `{ data: { id, amount, user_name } }`.
  - `POST /api/staff-money/:id/settle` body `{ bills: [{ item_id?, item_name?, description?, category?, amount }], returned_amount, returned_method: 'cash'|'upi', final: boolean }` → `{ data: { remaining, status } }`. Bills reuse piece 1's `resolveItem`; each becomes an expense (`payment_method='shopping_money'`, `money_out_id`, `given_to_user_id` = holder, `location_id` of the hand-out, `expense_date` today). Refuse `bills + returned > remaining` with "<Name> only has ₹<left> left — check the change amount." `final: true` with remaining 0 → `status='settled'`.
  - `DELETE /api/staff-money/:id` (owner/manager): only while `settled_amount = 0 AND returned_amount = 0` and, for cash, its register still open; sets `status='removed'`. Otherwise 409 plain copy.
  - `GET /api/staff-money/open?location_id=` → `[{ id, user_id, user_name, amount, remaining, created_at, given_by_name, late }]`, oldest first.
  - `GET /api/staff-money/mine` → `{ advances_this_month: [...], holding: [...] }` (any authenticated role except helper/customer).
  - `computeRegisterClose` return gains `shoppingOutTotal`, `shoppingInTotal`; `expectedCash` subtracts out, adds in. Register status/history carry `shopping_out`, `shopping_in`.
  - Removing a settle bill expense (existing `DELETE /api/expenses/:id`) with `money_out_id`: adds its amount back to the hand-out's remaining (`settled_amount −= amount`, `status='open'`), no drawer move.

- [ ] **Step 1: Write failing tests:** `hand-out 500 cash: drawer down 500, no expense row`; `part settle 300 bills + 0 change: remaining 200, status open, bill expenses have payment_method shopping_money`; `full settle with 200 cash change: drawer up 200, status settled, net drawer −300`; `change more than remaining: 400 with the spec copy`; `settle twice in parallel: one wins, drawer moves once` (RF1); `change returned next day lands in today's session only` (RF2: insert the hand-out with a back-dated `created_at` and a closed register id, settle into the test's open register); `close preview equals opening + sales − expenses − out + in`; `register status running expected_cash matches close preview`; `shopping_money expenses never counted in any drawer query` (a settle bill with `register_id IS NULL` and `created_at` inside the session leaves `expected_cash` unchanged); `remove unsettled hand-out with register open: drawer back up`; `remove after a part settle: 409`; `deleting a settle bill reopens that amount, drawer unchanged`; `open list marks late after 3 days`; `mine shows own holding only`; `helper 403 on every new route`.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement.** Settle takes `SELECT … FROM staff_money_out WHERE id=? FOR UPDATE` first, re-checks remaining, then `lockOpenRegister` only when returning cash. `shoppingOut` = `SUM(amount)` of `staff_money_out` with `register_id = R AND payment_method='cash' AND status <> 'removed'`; `shoppingIn` = `SUM(returned_amount)` of `staff_money_settles` with `register_id = R AND returned_method='cash'`. Running `expected_cash` moves with each hand-out, change-return and removal, as helper floats do; a locked blind count (`close_count_locked`) shifts by the same cash.
- [ ] **Step 4: Run** this suite plus every register suite: `verify-register-expenses`, `verify-cash-safety`, `verify-helper-bags`, `verify-quick-sale`, `verify-order-flows`, `verify-expense-book` — expect PASS.
- [ ] **Step 5: Commit** `feat(staff-money): shopping money hand-out, settle and drawer maths`.

### Task 4: Payroll — open shopping money and "Take from pay"

**Files:**
- Modify: `server/routes/staff-management.js` (`POST /payroll/calculate`, `POST /payroll/disburse`)
- Test: `server/scripts/verify-staff-money.js`

**Interfaces:**
- Consumes: Task 1 `remaining`; Task 2 `payAdvance` is **not** used (no cash moves); insert the advance row directly with `source='shopping_money'`, `status='approved'`, `payment_method=NULL`.
- Produces: calculate response `calculation.open_shopping_money: [{ id, amount_left, created_at }]`, `calculation.open_shopping_total`; disburse accepts `take_shopping_money_ids: number[]`.

- [ ] **Step 1: Write failing tests:** `calculate lists open shopping money for that person`; `disburse with take ids: hand-out to_salary, advance created for the remainder, deducted in the same payment`; `take-from-pay uses the remainder at disburse time` (RF5: part-settle between calculate and disburse); `take id of another person refused 400`.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** inside disburse's existing transaction, before the advance-deduction loop: lock each named hand-out, skip ones no longer open, create the advance for `remaining(row)`, set `status='to_salary'`, `closed_at=NOW()`.
- [ ] **Step 4: Run** this suite and `verify-attendance-payroll.js` — expect PASS.
- [ ] **Step 5: Commit** `feat(staff-money): open shopping money at payroll with Take from pay`.

### Task 5: Usual now ranking

**Files:**
- Create: `server/utils/usual-now.js`
- Modify: `server/routes/expenses.js` (`GET /suggest` without `q` returns `usual_now` ranking; response items gain `last_payment_method`, `usual_now: boolean`)
- Test: `server/scripts/verify-staff-money.js` (pure-function checks) and `verify-expense-book.js` (route shape still passes)

**Interfaces:**
- Produces: `rankUsualNow(items, nowMs) -> items[]` (pure). Each input item: `{ id, pinned, pin_order, uses30, times: number[] }` (epoch ms of this shop's entries, last 60 days, ascending). Rules from spec §4.6: with ≥ 3 entries, `gap = median(consecutive diffs)`; usual now when `now − last ≥ 0.8 × gap`; order by `(now − last) / gap` desc, then `uses30` desc; items with `now − last < 0.8 × gap` are dropped. With < 3 entries: pinned (by `pin_order`) then `uses30`, dropping anything whose last entry is < 2 h ago. Returns at most 8.

- [ ] **Step 1: Write failing tests:** `tea every ~5h, last 5 min ago: not in list`; `tea last 4.5h ago: first`; `petrol every 3 days, last 1 day ago: dropped`; `two entries only: falls back to pins/uses, but dropped when added 1h ago`; `route: suggest without q returns usual_now items with last_payment_method`.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** the pure function and feed it from one query per request (`SELECT item_id, created_at, payment_method FROM expenses WHERE location_id=? AND created_at >= NOW() - INTERVAL '60 days' AND item_id IS NOT NULL AND payment_method IN ('cash','upi') ORDER BY created_at`).
- [ ] **Step 4: Run** both suites — expect PASS.
- [ ] **Step 5: Commit** `feat(expenses): Usual now ranking learns each item's usual gap`.

### Task 6: App API methods and pure helpers

**Files:**
- Modify: `app/src/services/api.js`
- Create: `app/src/utils/staffMoney.js`
- Test: `app/scripts/test-staff-money.js`

**Interfaces:**
- Produces: `api.giveAdvance(body)`, `api.giveShoppingMoney(body)`, `api.settleShoppingMoney(id, body)`, `api.removeShoppingMoney(id)`, `api.getOpenShoppingMoney(locationId)`, `api.getMyMoney()`; `staffMoney.js`: `leftAfter(remaining, billsTotal, returned) -> number`, `defaultChange(remaining, billsTotal) -> number` (never below 0), `heldLabel(row, now) -> '2 days' | 'today' | '1 day'`, `pinPrompt(needs_pin, limit, kind) -> string` (spec §4.7 copy).

- [ ] **Step 1: Write failing tests** for each pure function with the spec's numbers (500 − 300 → change 200; over-limit copy contains "₹500 daily advance limit").
- [ ] **Step 2: Run** `node app/scripts/test-staff-money.js` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(staff-money-app): api methods and helpers`.

### Task 7: Notion-style add sheet

**Files:**
- Create: `app/src/components/expenses/SheetRow.js` (label left grey, value right, chevron; `onPress`; `disabled` + `hint`)
- Create: `app/src/components/expenses/OptionList.js` (plain modal list with optional search; reuse in Given to, Kind, Paid by)
- Modify: `app/src/components/expenses/AddExpenseSheet.js` (layout per spec §3.1; keep every piece-1 rule: item resolve, register-closed Cash handling, back-dating UPI-only, old-cash locks, salary line, unsaved check, `useSubmitGuard`)
- Modify: `app/src/components/expenses/GivenToPicker.js` (becomes a row + `OptionList`, "Someone else (type a name)")
- Modify: `app/src/components/expenses/ExpenseRow.js` (spec §3.7 plain style: thin divider, grey second line; shows "Shopping money · <name>" for `payment_method='shopping_money'`)
- Test: `app/scripts/test-expense-book.js` (existing 14 stay green); on-screen check

**Interfaces:**
- Consumes: Task 5 `usual_now`, `last_payment_method` on suggest items.
- Produces: `AddExpenseSheet` prop additions `mode: 'expense'|'advance'|'shopping'` (default `'expense'`; Task 8 fills the other two) and `onSettleInstead(holderRow)`.

- [ ] **Step 1: Restructure** the sheet into: Usual now list (≤ 5 rows, tap fills item/amount/given-to/kind and Cash/UPI from `last_payment_method`) → What was it for / Amount → rows Paid by, Given to, Kind, Date (owner/manager), Note / bill photo → two plain links → "Save ₹X".
- [ ] **Step 2: Run** `node app/scripts/test-expense-book.js` and babel-check the touched files — expect PASS.
- [ ] **Step 3: On-screen** (desktop + 375 px, as counter staff and manager): Tea in 3 taps; Change on an old register-less cash row still shows its lock; register-closed Cash shows Open Register inline.
- [ ] **Step 4: Commit** `feat(expenses-app): Notion-style add sheet with Usual now suggestions`.

### Task 8: Salary advance and Cash for shopping modes

**Files:**
- Create: `app/src/components/expenses/MoneyToStaffForm.js` (Who row, Amount, Paid by, Note, PIN box, "Give advance ₹X" / "Give ₹X for shopping")
- Modify: `app/src/components/expenses/AddExpenseSheet.js` (two links + typed "advance"/"shopping" surface them; Given to on a holder shows "<Name> has ₹X shopping money — Settle it instead ›")
- Test: `app/scripts/test-staff-money.js` (pure parts); on-screen check

**Interfaces:**
- Consumes: Task 6 api + `pinPrompt`; Task 2/3 409 `needs_pin`.

- [ ] **Step 1: Implement** the form; on 409 `needs_pin` show the PIN box with `pinPrompt` copy and resend with `approver_code`/`approver_pin`; Who list from `GET /auth/staff-roster?location_id=` plus riders (`GET /deliveries/partners`), "Me" included.
- [ ] **Step 2: Run** app tests + babel-check — expect PASS.
- [ ] **Step 3: On-screen:** ₹300 advance to someone else in 5 taps; ₹600 shows the PIN box; self advance asks PIN; UPI with register closed works; Cash with register closed shows Open Register.
- [ ] **Step 4: Commit** `feat(staff-money-app): salary advance and cash for shopping in the add sheet`.

### Task 9: "Usual now" 1-tap line on Expenses

**Files:**
- Create: `app/src/components/expenses/UsualNowLine.js`
- Modify: `app/src/screens/ExpensesScreen.js` (day list for staff/managers; owner summary when period is Today)
- Test: `app/scripts/test-staff-money.js`; on-screen

**Interfaces:**
- Consumes: Task 5 suggest; existing `api.createExpense`, `api.deleteExpense`.

- [ ] **Step 1: Write failing test** `undo after close shows the remove-refused message` (RF4) as a pure check of the toast state machine in `UsualNowLine` (extract `undoState` reducer).
- [ ] **Step 2: Implement:** up to 3 rows, `+ Add` saves at once, toast "Added Tea ₹50 — Undo" for 10 s, Undo calls delete and shows the server's message on refusal; "Open register" instead of Add when that row would be cash and the register is closed.
- [ ] **Step 3: Run** tests + babel-check; on-screen add + undo, and add twice fast (one entry).
- [ ] **Step 4: Commit** `feat(expenses-app): Usual now 1-tap line with Undo`.

### Task 10: Money with staff card and Settle screen

**Files:**
- Create: `app/src/components/expenses/MoneyWithStaffCard.js`
- Create: `app/src/screens/SettleShoppingMoneyScreen.js` (registered in every stack that has `Expenses`)
- Modify: `app/src/screens/DashboardScreen.js` (counter/employee and owner/manager branches), `app/src/screens/ExpensesScreen.js` (top), `app/src/navigation/MainNavigator.js`
- Test: `app/scripts/test-staff-money.js`; on-screen

**Interfaces:**
- Consumes: Task 6 api + `defaultChange`, `leftAfter`, `heldLabel`; piece 1 item suggestions for bills.

- [ ] **Step 1: Implement** the card (hidden when empty; red line when `late`) and the settle screen (spec §3.4 layout; "Settle" sends `final: true`, "Save, rest later" sends `final: false`; 409 shows "Already settled — refresh").
- [ ] **Step 2: Run** tests + babel-check.
- [ ] **Step 3: On-screen:** hand out ₹500, settle ₹300 bills + ₹200 change, card disappears; part settle keeps the line.
- [ ] **Step 4: Commit** `feat(staff-money-app): Money with staff card and settle screen`.

### Task 11: My money, owner settings, payroll tick

**Files:**
- Modify: `app/src/screens/ProfileScreen.js` (My money section)
- Modify: `app/src/screens/SettingsScreen.js` (owner-only rows for the three settings, saved through the existing settings API)
- Modify: `app/src/screens/SalaryManagementScreen.js` ("₹X shopping money not settled ☐ Take from pay" in the payroll breakdown; sends `take_shopping_money_ids`; net shown updates)
- Test: on-screen; `verify-staff-money.js` already covers the server

- [ ] **Step 1: Implement** the three screens' additions.
- [ ] **Step 2: Babel-check**; on-screen as counter staff (My money), owner (settings, payroll tick with a test employee only).
- [ ] **Step 3: Commit** `feat(staff-money-app): My money, limit settings and payroll tick`.

### Task 12: Full regression, docs

**Files:**
- Modify: `CLAUDE.md` (roadmap entry under sub-project 4, like the expense book's)

- [ ] **Step 1: Run** every `server/scripts/verify-*.js` (with `VERIFY_OWNER_*`, `TRACKING_LINK_SECRET`; `verify-order-channel.js` needs `API_BASE_URL` without `/api` and `SMOKE_OWNER_*`) and every `app/scripts/test-*.js`. Expected: all green except `verify-gst-sales` while `bill_round_off` is on (known, unrelated).
- [ ] **Step 2: Write** the CLAUDE.md entry: what it is, data, routes, money rulings (shopping_money method, lock order, payroll tick), tests, not checked, deploy (server first; leave limits at defaults until every counter device has the app).
- [ ] **Step 3: Commit** `docs: staff money shipped`.
