# "This was a salary advance" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner can turn an old normal expense (cash or UPI, up to 60 days back) into a salary advance for one employee, so today's Payroll cuts it like any other advance.

**Architecture:** One new owner-only route, `POST /api/expenses/:id/salary-advance`, with a `preview` mode. In one money transaction it re-labels the expense as that employee's Salary expense (the same shape `payAdvance` writes) and inserts one approved `salary_advances` row linked to it. No register or drawer row is touched. Everything that happens to the expense afterwards (edit amount, remove) already follows the existing advance-link rules in `expenses.js`. The app gets one button on the expense edit sheet and a small "Whose advance?" sheet.

**Tech Stack:** Express + PostgreSQL (async layer `config/database-async.js`, `withMoneyTx`), Expo / React Native.

**Spec:** `docs/superpowers/specs/2026-11-16-staff-pay-account-design.md` — §12 row 2, §13 item 5, §9 tap count, §7.3 bullet "This was a salary payment" (replaced by §12's advance form).

## Global Constraints

- Branch `feature/old-expense-advance` off `main`; does not depend on PR 1 (pay visibility, PR #49) (spec §12).
- **Owner only** for now: spec §12 says a new pay route is owner-only until PR 1 is merged. When PR 1 merges, a follow-up opens it to managers with `canSeePay`.
- Only expenses dated within the last 60 days, counted in shop-local days (`todayStr()`): `expense_date >= today − 60`.
- Only `payment_method` `cash` or `upi` (the advance methods, `ADVANCE_METHODS` in `server/utils/advance-payout.js`).
- The advance row is exactly: `status = 'approved'`, `source = 'old_expense'`, `expense_id` = the expense, `repaid_amount = 0`, `amount` = expense amount, `payment_method` = expense method, `location_id` = expense location, `date` = expense date, `given_by` = expense `created_by`, `approved_by` = the owner, `reason` = `'Old expense marked as salary advance'` (spec §13 item 5: never `pending`).
- **No drawer move:** no write to `cash_registers` and no `moveSessionCash`/`moveDrawer` call. The cash already left the drawer when the expense was first saved.
- The expense becomes the shape `payAdvance` writes: `category = 'salary'`, `employee_id` = `given_to_user_id` = the employee, `given_to_name = NULL`, `item_id = NULL`, `description = 'Salary advance — <name> (was: <old description>)'`. `amount`, `payment_method`, `expense_date`, `register_id`, `note`, `photo_url` and `created_by` are unchanged.
- Employee: an active user whose role is one of `manager`, `employee`, `counter_staff`, `florist_staff`, `delivery_partner` (today's Payroll roles).
- Schema: none needed (all columns exist on `main`). If one turns out to be missing, it must be additive and written per the `db-migration-safety` skill.
- Copy is plain language and says what to do next (CLAUDE.md UX principles). Use `showAlert`/`showConfirm` only, never `Alert.alert`. Use the async DB layer only. No apostrophes in `--` SQL comments.
- Tap count (spec §9): Expenses → row → "This was a salary advance" → pick employee → Save = 4 taps.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Exact copy (use verbatim)

| Key | Text |
|---|---|
| `OLD_ADV_TOO_OLD_MESSAGE` | `Only expenses from the last 60 days can be marked as a salary advance.` |
| `OLD_ADV_METHOD_MESSAGE` | `Only a Cash or UPI expense can be marked as a salary advance.` |
| `OLD_ADV_NOT_PLAIN_MESSAGE` | `This expense is linked to shopping money, a km account or money the shop owes, so it can't be marked as a salary advance.` |
| `OLD_ADV_RETURN_MESSAGE` | `A return can't be marked as a salary advance.` |
| `OLD_ADV_ALREADY_MESSAGE` | `This is already a salary entry. Pull down to refresh.` |
| `OLD_ADV_PERSON_MESSAGE` | `Pick the employee this money was given to.` |
| Button on the edit sheet | `This was a salary advance` |
| Sheet title | `Whose advance?` |
| Sheet line | `₹<amount> on <D Mon> becomes a salary advance. It will be taken off their next salary.` |
| Warning (preview `salary_paid_after` non-empty) | `<Name> was already paid salary on <D Mon>. If you already took this off that pay, don't mark it.` |
| Success alert | `Marked as salary advance` / `₹<amount> will be taken off <Name>'s next salary.` |

## Review Focus

1. **The money was already cut by hand.** The owner paid salary after the expense and already took it off. Marking it now would cut it twice. Expected: the preview returns `salary_paid_after` and the sheet shows the warning before Save. (Task 2 test + Task 3 screen.)
2. **Double tap or two devices.** Expected: exactly one advance. The second call gets 409 `OLD_ADV_ALREADY_MESSAGE`. (Task 2 test.)
3. **Removing or editing the expense afterwards.** Expected: removing it cancels the advance; changing its amount changes the advance; once payroll took any of it, both are refused. These are the existing rules, and the test proves they reach the new rows. (Task 2 test.)
4. **A closed-register cash expense.** Expected: it converts, and the closed register's figures are byte-identical before and after. (Task 2 test.)
5. **The edit sheet for a converted row.** Expected: it shows as Salary for that person with no "This was a salary advance" button, and the other kinds can't be chosen. (Task 3 on-screen check.)

---

### Task 1: verify-expense-book creates its own helper

**Files:**
- Modify: `server/scripts/verify-expense-book.js` (line 118 `HELPER_ID = 6783`, uses at ~304 and ~416)

**Interfaces:**
- Produces: nothing for later tasks.

- [ ] **Step 1:** Replace the fixed `HELPER_ID = 6783` with a helper the script creates at start: `role 'helper'`, name `VerifyEB Helper`, `access_until` = shop-local today + 30 days, linked to `TEST_LOCATION_ID` the way `server/scripts/verify-helpers.js` creates one (follow its insert or route; an employee code if the schema requires one). Delete it, and anything it owns, in the script's existing cleanup/finally. Never touch user 6783.
- [ ] **Step 2:** Run against a running API (port 3001, start per env notes): `cd server && node scripts/verify-expense-book.js`. Expected: `69/69 checks passed` (it was 67/69 because 6783's access ended 2026-11-18).
- [ ] **Step 3:** Run it a second time. Expected: 69/69 again, and no `VerifyEB Helper` user left in the DB.
- [ ] **Step 4: Commit** `test(expenses): verify-expense-book makes its own helper instead of a dev user`

### Task 2: the route

**Files:**
- Modify: `server/routes/expenses.js` (new route, placed before `router.put('/:id'` so `/:id/salary-advance` is matched first; reuse `withMoneyTx`, `lockLinkedAdvance`, `auditExpense`, `pickAudit`, `auditAdvance`, `pickAdvance`)
- Create: `server/scripts/verify-old-expense-advance.js` (same harness style as `verify-expense-book.js`: `check()`, `api()`, `tokenFor()`, its own `VerifyOEA` users at Test Loc, cleanup in `finally`)

**Interfaces:**
- Produces: `POST /api/expenses/:id/salary-advance`, `authenticate, authorize('owner')`.
  - Body `{ employee_id: number, preview?: boolean }`.
  - `preview: true` writes nothing and answers `200 { success, data: { expense_id, amount, expense_date, employee: { id, name }, salary_paid_after: [{ id, paid_on: 'YYYY-MM-DD', net_amount }] } }`. `salary_paid_after` lists that employee's `salary_payments` paid on or after the expense date, newest first.
  - Commit answers `200 { success, data: { expense: <row as GET /expenses returns it>, advance_id } }`.
  - Errors: 400 (the copy keys above), 403 for non-owners, 404 for a missing expense, 409 `OLD_ADV_ALREADY_MESSAGE`.
- Lock order inside `withMoneyTx`: `lockLinkedAdvance(tx, id)` (money row first, as everywhere in this file), then the expense `FOR UPDATE`. Every check runs again under the lock. An existing linked advance or `category = 'salary'` → 409.
- Not plain (→ `OLD_ADV_NOT_PLAIN_MESSAGE`): `money_out_id`, `km_settlement_id`, a linked `shop_owes` row, or `payment_method` other than cash/upi (own pocket / km account fall here only if the method check has not already refused them — the method check runs first).
- Audits: `expense_marked_salary_advance` on the expense (before/after `pickAudit`), and `salary_advance_given` on the advance (`new_state` includes `source: 'old_expense'`, `expense_id`, `register_id: null`).

- [ ] **Step 1: Write the failing checks** in `verify-old-expense-advance.js`, in this order:
  1. `owner marks a ₹500 UPI expense from 10 days ago for an employee on ₹5,000` → 200. The expense row is `category 'salary'`, `employee_id`/`given_to_user_id` = E, `item_id` NULL, description starts `Salary advance — `, amount/method/date/register_id unchanged. One `salary_advances` row matches every field in Global Constraints.
  2. `payroll now cuts it`: `GET /api/staff/payroll/calculate` (find the exact path and params in `staff-management.js`) for E as owner → `pending_advances` = 500.
  3. `no drawer move`: a cash expense at a register the test opened at Test Loc → convert → that register's `expected_cash` and every other column unchanged. Close the register in cleanup.
  4. `closed register untouched`: a cash expense whose register the test opened and closed → convert → 200, and the closed register row is byte-identical (compare `SELECT *` JSON).
  5. `preview writes nothing and warns`: seed one `salary_payments` row for E dated after the expense → preview → `salary_paid_after.length === 1`; the expense and `salary_advances` counts are unchanged.
  6. `refusals`, each with the exact copy: 61 days old → `OLD_ADV_TOO_OLD_MESSAGE` (and exactly 60 days → 200); own pocket → `OLD_ADV_METHOD_MESSAGE`; `is_return` → `OLD_ADV_RETURN_MESSAGE`; a shopping-money bill (`money_out_id` set) → `OLD_ADV_NOT_PLAIN_MESSAGE`; a customer / owner / inactive user / missing `employee_id` → `OLD_ADV_PERSON_MESSAGE`; an already-salary expense → 409 `OLD_ADV_ALREADY_MESSAGE`.
  7. `two calls at once make one advance`: `Promise.all` of two commits → exactly one 200, one 409, and one `salary_advances` row.
  8. `only the owner`: manager, counter staff and helper → 403, and nothing changed.
  9. `afterwards the existing rules apply`: PUT amount 400 → the advance amount becomes 400; DELETE → the advance becomes `cancelled`. On a second converted expense, set `repaid_amount` 100 on its advance → DELETE gets 400 with the existing `ADVANCE_TAKEN_MESSAGE`.
  10. `audited`: both audit rows exist with the actions named above.
- [ ] **Step 2: Run** `cd server && node scripts/verify-old-expense-advance.js` (API restarted). Expected: FAIL (404 on the route).
- [ ] **Step 3: Implement** the route as specified in Interfaces and Global Constraints.
- [ ] **Step 4: Run** it again → all pass. Then run `verify-expense-book.js` (69/69), `verify-staff-money.js` and `verify-register-expenses.js` (owner credentials per env notes). Expected: all green.
- [ ] **Step 5: Commit** `feat(expenses): owner marks an old expense as a salary advance`

### Task 3: the app

**Files:**
- Modify: `app/src/services/api.js` (`markExpenseSalaryAdvance(id, { employee_id, preview })`)
- Modify: `app/src/components/expenses/AddExpenseSheet.js` (the button in editing mode)
- Create: `app/src/components/expenses/OldExpenseAdvanceSheet.js` ("Whose advance?")
- Modify: `CLAUDE.md` (one sub-bullet under roadmap item 1's continuations)

**Interfaces:**
- Consumes: Task 2's route and response shapes.

- [ ] **Step 1:** In `AddExpenseSheet`, when editing as the owner, show the secondary button `This was a salary advance` only if the row is not salary, the method is cash or upi, it is not a return, it has no `money_out_id`/`km_settlement_id`, and its date is within 60 shop-local days. The server stays the guard; this only hides a button that would be refused.
- [ ] **Step 2:** `OldExpenseAdvanceSheet` shows:
  - the sheet line;
  - the employee list: active staff in the Payroll roles, one tap each (≥48 px rows), loaded from an existing staff list endpoint the owner can read (say which);
  - after a person is picked, a preview call: the warning line if `salary_paid_after` is non-empty;
  - a primary `Save`, wrapped in `useSubmitGuard`.

  On success: the success alert, close both sheets, refresh the list. Errors use `showAlert` with the server message.
- [ ] **Step 3:** Babel-check both files. Add an app test if the eligibility check is a pure function (put it in `app/src/utils/` with a `app/scripts/test-*.js` like the existing ones).
- [ ] **Step 4:** CLAUDE.md sub-bullet: "Old expense → salary advance (2026-11-19, `feature/old-expense-advance`): owner-only `POST /api/expenses/:id/salary-advance` turns a cash/UPI expense ≤60 days old into an approved `source='old_expense'` advance linked to it; no drawer move; later edits follow the advance-link rules. Open it to managers with `canSeePay` once pay visibility (PR #49) is merged."
- [ ] **Step 5: Commit** `feat(expenses): "This was a salary advance" on the expense sheet`
- [ ] **Step 6 (controller):** on-screen check at 375 px as the test owner: the 4-tap path, the warning, and Review Focus 5.
