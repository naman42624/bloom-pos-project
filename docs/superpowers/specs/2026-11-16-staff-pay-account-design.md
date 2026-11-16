# Staff pay account: salary, advances, loans and who sees what — design

Date: 2026-11-16. Status: draft for owner approval.

## 1. Why

On payday the owner needs one answer: **how much do I still owe this
person?** Today the app keeps staff pay in separate, unconnected places — a
salary figure, advances waiting to be cut, Salary expenses, payroll payments —
and nothing adds them up. Real cases that break today:

- ₹500 given against this month's salary was saved as a normal expense (the
  advance button didn't exist yet). Payroll doesn't know about it; the only
  trace is the description.
- An employee had a medical emergency and was given money to be paid back in
  small monthly amounts. Payroll can only cut **all** pending advances at once
  (capped at the pay), so a ₹10,000 emergency wipes a ₹5,000 month.
- Staff can see other people's salary amounts: counter staff see every Salary
  expense amount (name hidden) and the salary total in the expense summary;
  managers see everyone's advances and Salary expenses with names.

The owner wants complete control and a setup that follows how real staff-pay
tools work (running account per employee, loans kept apart, month close,
payslip), so nothing gets forgotten or paid twice.

## 2. Decisions made with the owner (2026-11-16)

- **Approach A:** one pay account per employee, built on the existing tables,
  additive only. (Rejected: B — patching the Payroll screen only, which keeps
  no running balance; C — an outside payroll app, which would not see counter
  advances and would split the books.)
- **Order:** three pieces, each built and tested before the next:
  1. Who sees what (§6); 2. Pay account and payroll (§7); 3. Advances and
  loans (§8). Then the helpers design (helpers get the same account) and
  "Fix this day".
- **Salary card, per employee, set by the owner:** monthly salary, paid leaves
  per month, pay cycle start day, payday, monthly advance limit, start date,
  end date.
- **Day rate = monthly salary ÷ 30.** Half day = half a day's pay.
- **Sundays count as leave:** "2 paid leaves" means 2 paid days off in total
  in the cycle, Sundays included. Every day off beyond that is cut.
- **Unused paid leaves:** at each payroll the owner picks, per employee for
  that month — **Lapse (default)**, Carry over to next month, or Pay as extra
  days at the day rate.
- **Advances:** counter staff and managers keep giving advances exactly as
  today (same buttons, same approval PIN rules). An advance is pay given early
  in this cycle.
- **Advance limit (option 3):** a per-employee monthly limit on the salary
  card. Above it, the counter needs the owner's or a manager's approval PIN.
  Whenever an advance takes someone past what they have earned so far this
  cycle, the owner gets a notification.
- **Loans:** only the owner creates them — directly, or by turning an
  advance into a loan. No interest. Each payroll shows the instalment, which
  the owner can change, skip, or increase. On leaving, the rest of a loan is
  cut from the final pay; anything still left the owner marks collected or
  written off.
- **Managers** see salary, payroll, advances and loans **only for the
  employees the owner switches on for them**, and only **view** (no setting
  salary, no payroll, no loans). Off by default.
- **Counter staff and other staff** never see anyone else's salary, earned,
  balance or loan. They see their own payslip.
- **Counter does not pay salary** (owner, 2026-11-16: no way to verify leaves,
  advances or pending amounts at the counter). The owner pays salary.
- **Old expenses** that were really salary money can be turned into a pay
  record: "This was a salary payment", owner and manager, up to 60 days back.

## 3. Claude's calls (owner may correct)

- **A paid month is locked.** A mistake found later is never fixed by
  reopening it: the owner adds a correction line to the next cycle ("+₹166.67,
  missed day 12 Nov") with a reason.
- **Reminders are in-app notifications** to the owner (existing
  `notifyByRole`), the day before payday and on payday. No SMS / WhatsApp.
- A manager allowed to view someone also receives that person's
  "ran ahead" advance notification; nobody else does.
- Salary paid by Cash needs an open register (as today); UPI/Bank do not.

## 4. Goals

1. One number per employee per cycle — **Due** — that is right every time,
   whatever mix of advances, old expenses, loans, leaves and corrections led
   to it.
2. Every rupee given to staff for pay is in exactly one account line, and also
   in the expense book as Salary, and (if cash) in the drawer — never twice,
   never missing.
3. Nobody sees another person's pay unless the owner allowed it.

## 5. Non-goals and anti-goals

**Non-goals:** PF/ESI/TDS or statutory payroll; overtime pay; hourly/daily pay
types for new setups (existing `salary_type` rows keep working as today);
interest on loans; SMS/WhatsApp reminders; counter-side salary payout.

**Anti-goals (failure even if it works):**
- Any old figure changing: past `salary_payments`, advances, expenses and
  register figures must read exactly as before.
- A paid month changing after it was paid.
- A salary amount reachable by a role that should not see it — through any
  route, list, search, summary, notification, audit view or error message.
- Staff at the counter needing more taps to give an advance than today, when
  under the limit.

## 6. Piece 1 — who sees what

### 6.1 Rules

| Data | Owner | Manager | Counter / employee / florist / rider / helper |
|---|---|---|---|
| Salary card (salary, leaves, limit, cycle) | see + set | view, allowed people only | own only (salary + leaves, not the limit) |
| Pay account, payroll, payslips | all | view, allowed people only | own payslip only |
| Advances and loans | all | view, allowed people only; give advances as today | give advances as today; see own only |
| Salary expense rows (list, search, detail) | all | allowed people + own; others as "Staff pay", no name, no note, no photo | own; others as "Staff pay" with amount only (needed to count the drawer), no name |
| Expense summary / reports salary total | yes | only allowed people's share | never (salary category left out) |
| Notifications about pay | yes | allowed people only | own only |
| Audit logs of pay records | yes | allowed people only | no |

"Allowed people" = rows in a new `pay_viewers` (manager_id, employee_id)
table, set by the owner on each manager's profile ("Can see pay of" with one
switch per employee). A manager always sees their own pay.

### 6.2 Server

- One helper, `server/utils/pay-access.js`:
  `canSeePay(viewer, employeeId)` and `payVisibleIds(viewer)` (owner: all;
  manager: own + `pay_viewers`; others: own). Every route below uses it — no
  route keeps its own role check for pay data.
- Routes to change (found 2026-11-16; the plan re-greps for `salary`,
  `employee_salaries`, `salary_payments`, `salary_advances`, `category =
  'salary'` and adds any it finds):
  - `routes/staff-management.js`: `GET /salaries` (manager branch),
    `GET /payroll/history`;
  - `routes/attendance.js`: `GET /salary-advances` (managers currently see
    all), `PUT /salary-advance/:id/repay` and `/:action` (managers on anyone);
  - `routes/expenses.js`: list/search (`hideSalaryNames` today covers only
    non-boss roles; extend to managers for not-allowed people), `GET /summary`
    and every summary/period/compare query that groups by category, item
    search (line ~541 already hides salary items from non-boss);
  - `routes/staff-money.js`: `/history`, `/open`, `/people` and the
    `unpaid_after` figure;
  - `routes/sales.js` `GET /:id/audit-logs` and any audit read that can show a
    pay record;
  - notifications that carry a pay amount.
- **Access test** `server/scripts/verify-pay-access.js`: for every route in a
  list kept in the test file itself, call it as owner, allowed manager,
  not-allowed manager, counter staff, florist, rider and helper, and assert
  no response body contains the test employee's salary figure or a salary
  row of someone the caller may not see. A new pay route must be added to the
  list (comment at the top of `pay-access.js` says so).

### 6.3 App

- Manager profile (owner view): "Can see pay of" switches.
- Screens that showed salary data to managers show only allowed people; an
  employee not allowed is simply not listed (no locked rows that hint).
- Expense rows for hidden salary: title "Staff pay", amount kept, no name.

## 7. Piece 2 — pay account and payroll

### 7.1 Salary card (owner)

Additive columns on `employee_salaries`:
`paid_leaves_per_month` (INT, default 0), `cycle_start_day` (INT 1–28,
default 1), `payday` (INT 1–28, default = cycle start day), `advance_limit`
(NUMERIC, NULL = no limit), `pay_start_date` (DATE), `pay_end_date` (DATE,
NULL). Default for existing rows: leaves 0, cycle day 1 — so today's
behaviour is unchanged until the owner edits a card. (Days 29–31 are not
offered, so every month has the day.)

A salary change keeps using `salary_history`; a change mid-cycle applies from
the next cycle (shown on the card: "₹6,000 from 1 Dec").

### 7.2 The account

For employee E and cycle C (cycle start day to the day before the next
start), computed fresh, never stored, by one function
`server/utils/pay-account.js` `computeCycle(db, userId, cycleStart)`:

- **Days in cycle** clipped to `pay_start_date` / `pay_end_date` (days outside
  are "Not working here", not absent and not paid — same rule as the helpers
  design).
- **Day rate** = salary ÷ 30.
- **Days off** = cycle days (inside the stay) with no attendance as present or
  half day, counting Sundays; `on_leave` days count as days off.
- **Paid leave available** = `paid_leaves_per_month` + leaves carried in from
  the previous cycle.
- **Days cut** = max(0, days off − paid leave available) + 0.5 × half days.
- **Earned** = day rate × (days in stay) − day rate × days cut; for a full
  cycle with no cuts this equals the monthly salary exactly (30-day rule:
  a full cycle is always paid as the monthly salary whatever its length; the
  ÷30 rate is for cuts and partial stays).
- **Unused leave** = paid leave available − days off (if > 0), handled by the
  owner's choice at payroll: lapse / carry / pay (+ day rate each).
- **Given this cycle** = every pay line in the cycle: advances (not turned
  into loans), salary paid in parts, old expenses marked as salary payments.
- **Loan instalment** = this cycle's instalment(s) (§8).
- **Corrections** = lines added from earlier locked cycles.
- **Carried** = the previous cycle's closing balance (negative if overpaid).
- **Due** = earned + bonus − fine + corrections + carried + unused-leave pay
  − given − loan instalment.

### 7.3 Pay lines and the books

New table `pay_lines` (the account): `id`, `user_id`, `cycle_start`, `kind`
(`salary`, `advance`, `old_expense`, `bonus`, `fine`, `correction`,
`loan_cut`, `carry`), `amount`, `method`, `expense_id`, `salary_advance_id`,
`salary_payment_id`, `loan_id`, `reason`, `created_by`, `created_at`.

- Every money-out line (salary, advance) still writes the **Salary expense**
  exactly as today (and the drawer if cash) — the existing `payAdvance` /
  payroll disburse paths stay the single writers; `pay_lines` is written in
  the same transaction and links to them.
- **Reading old data in:** existing `salary_advances` and `salary_payments`
  show in the account through their ids (a backfill script, reviewable,
  creates `pay_lines` rows pointing at them; it changes no existing row and
  can be re-run safely).
- **"This was a salary payment"** on a normal expense (owner/manager, ≤60
  days, cash/UPI/bank, not already linked): pick the employee → the expense
  becomes category Salary with `employee_id`, and a `pay_lines` `old_expense`
  line is added to the cycle containing the expense date. No drawer move.
  Audited. (This is the one place a non-salary row may become salary; the
  existing `SALARY_ROW_MESSAGE` rule stays for every other edit.)

### 7.4 Payroll screen (owner)

Per employee for the cycle: earned breakdown (days, leaves, cuts, half
days), unused-leave choice (Lapse / Carry / Pay), bonus, fine (each with a
reason), corrections, carried, given this cycle (each line with date and who
gave it), loan instalment (editable, §8), **Due**. Pay → records the salary
line (one or more payments allowed — "Pay ₹2,000 now, rest later" keeps the
cycle open with the rest still due). **Lock month** → no more lines in that
cycle; the closing balance carries to the next. Paying the full due offers
Lock in the same step.

### 7.5 Payday reminders

A daily job (existing `setInterval` pattern in `server.js`, once per shop-local
morning, idempotent per employee per cycle) notifies the owner — and allowed
managers — "Ramesh's pay is due tomorrow" / "today: ₹4,500". Due shown only
to those allowed.

### 7.6 Payslip

Every employee sees their own: earned breakdown, given, loan left, due/paid,
per cycle. Read-only.

## 8. Piece 3 — advances and loans

- **Advance limit:** `POST /staff-money/advance` checks this cycle's advances
  + the new one against `advance_limit`; above it, an approval PIN from the
  owner or a manager is required (reuse `utils/approval-pin.js`). The counter
  screen shows only "Needs owner or manager OK" — never the limit or salary.
- **Ran ahead:** after an advance, if given this cycle > earned so far (earned
  to date by the §7.2 rule), notify the owner (and allowed managers) with the
  amount ahead. The giver sees nothing about it.
- **Loans:** new table `staff_loans`: `id`, `user_id`, `amount`,
  `instalment`, `start_cycle`, `status` (`open`, `repaid`, `written_off`),
  `from_advance_id`, `created_by`, `created_at`, `closed_at`, `close_reason`.
  Owner creates one from the account ("Give a loan": amount, method, monthly
  amount, first payday) — money-out like an advance (Salary expense + drawer)
  — or turns an advance into a loan (the advance's `pay_lines` line moves to
  the loan; no money moves).
- At payroll each open loan shows "Instalment ₹1,000 · ₹9,000 left after
  this" — editable (0 = skip, up to the balance). The cut is a `loan_cut` line.
- **Leaving:** the final cycle offers "Cut the rest of the loan from final
  pay" (default on, capped at due); anything still left → "Collected" (cash in,
  register if cash) or "Written off" (owner), recorded and audited.

## 9. Tap counts

- Counter gives an advance under the limit: unchanged from today.
- Over the limit: + PIN entry (same as today's approval flow).
- Owner pays a normal month: Payroll → employee → check → Pay → Lock = 4 taps.
- Old expense to salary: Expenses → row → "This was a salary payment" →
  pick employee → Save = 4 taps.

## 10. Tests the builder must add

- `verify-pay-access.js` (§6.2), every role × every pay route.
- `computeCycle`: full month no leave = salary; 2 paid leaves with 4 days off
  (2 Sundays) → 2 days cut; half day = 0.5 day; joiner on the 10th of a cycle;
  leaver mid-cycle; carry-over leave; pay unused leave; Sunday counted.
- Your two real cases end to end: ₹5,000 salary, old ₹500 expense turned into
  a salary payment → Due ₹4,500; ₹10,000 emergency advance turned into a loan
  at ₹1,000/month → that cycle's due unaffected by the 10,000, next payroll
  cut 1,000, balance 9,000.
- Overpaid cycle carries a negative balance into the next.
- Locked cycle refuses any new line; correction lands in the next cycle.
- Old `salary_payments` / `salary_advances` / expense / register figures are
  byte-identical before and after the backfill.
- Advance over the limit refused without a PIN, accepted with one; "ran
  ahead" notification goes to owner + allowed manager only.

## 11. Left to the builder

- Screen layouts (follow `staff-ux-checklist` and `app-ui-quality`).
- Exact backfill script shape (must be idempotent and change no existing row).
- Which existing Payroll screen parts are reused vs rebuilt.

## 12. Shipping: five separate PRs (owner, 2026-11-16)

Each PR is its own branch off `main`, works on its own, and can be merged as
soon as it is done — the owner is never waiting for the whole thing. PRs 1–3
do not depend on each other; 4 and 5 build on what is merged before them.

| PR | What | Works with today's app because |
|---|---|---|
| 1 | **Who sees what** (§6): `pay-access.js`, every route fixed, `verify-pay-access.js`, manager "Can see pay of" switches | changes only who may read existing data |
| 2 | **"This was a salary advance"** on an old normal expense (owner/manager, ≤60 days): expense becomes Salary for that employee and a pending `salary_advances` row is linked to it, no drawer move | today's Payroll already cuts pending advances, so the ₹500 case is fixed the day this merges |
| 3 | **Advance limit + approval PIN** (§8 first bullet): `advance_limit` on the salary card, checked on `POST /staff-money/advance` | uses the existing advance and PIN paths only |
| 4 | **Pay account and payroll** (§7) + the "ran ahead" notification (§8): salary-card settings, `computeCycle`, `pay_lines` + backfill (it picks up PR 2's advances like any other), Payroll screen, lock, corrections, reminders, payslip | reads everything earlier PRs wrote |
| 5 | **Loans** (§8): `staff_loans`, turn an advance into a loan, instalments at payroll, leaving settlement | needs PR 4's payroll |

PR 2 replaces §7.3's "old_expense" kind: an old expense becomes a normal
pending advance, so it is cut at payroll by today's code and later shows in
the account like every advance. Every PR carries its own tests from §10 and,
for any new pay route, its entry in the PR 1 access test (if PR 1 is merged;
otherwise the new route is owner-only until it is).

## 13. Settled after the builder check (Claude's calls unless marked)

1. **Go-live per employee.** An employee joins the pay account when the owner
   saves their new salary card and picks "Start from" (a cycle start, default
   the current cycle). Old months are never worked out again. The opening
   balance = the unpaid part of every approved advance (`amount −
   repaid_amount`) given before that cycle, entered as one `carry` line with
   the advance ids listed. From then on `POST /payroll/disburse` refuses that
   employee (409 "Ramesh is on the new pay account. Pay from Payroll →
   Ramesh."). Employees not moved yet, and daily/hourly `salary_type`, keep the
   old route unchanged.
2. **Attendance is confirmed, not trusted blindly.** The Payroll screen lists
   every day off and every possible half day in the cycle (from attendance
   and the existing `findPartialDays`), and the owner can mark each one
   Present / Half day / Leave / Absent before paying. The owner's marks are
   saved for that cycle (`pay_day_marks`, additive) and are what the
   calculation uses. No dependency on "Fix this day".
3. **Shopping money taken from pay and rider km carry** become `pay_lines`
   kinds `shopping_take` and `km_carry` and are in Due, exactly as today's
   Payroll applies them. Goal 2 is refined: every line where **money leaves the
   drawer or bank** (salary, advance, loan) is also a Salary expense; these two
   are transfers already booked elsewhere (shopping bills, km settlement) and
   write no new expense, as today.
4. **Limits:** the per-person `advance_limit` replaces the shop-wide monthly
   advance limit for that person (per pay cycle); the shop daily limit stays
   for everyone; a person with no card limit falls back to the shop monthly
   limit. Never looser than today.
5. **PR 2's advance row** is `status = 'approved'`, `source = 'old_expense'`,
   `expense_id` linked, `repaid_amount = 0`, no drawer move (never `pending`,
   which would pay it again on approval). Later edits of the expense follow
   the existing advance-linked rules until the cycle is locked (item 6).
6. **After a cycle is locked**, editing or removing an expense linked to a
   pay line in it, or turning an advance from it into a loan, is refused
   ("This month's pay is closed. Add a correction on next month's pay
   instead.").
7. **Full stay:** earned = monthly salary − day rate × days cut (any cycle
   length). **Partial stay:** earned = day rate × days in stay − day rate ×
   days cut.
8. **Visibility of approvals:** a manager may enter their PIN for an over-limit
   advance to anyone at their shop (as today), but sees only the amount being
   given. `unpaid_after` is returned only to callers who may see that
   person's pay. The advance limit is shown only to the owner — managers do
   not see it, their own included.
9. **Cash salary** comes from the register of the shop picked on the Pay
   sheet (default: the employee's primary shop); each part payment records its
   own register. The period-overlap check is replaced by the cycle rule for
   employees on the new account.
