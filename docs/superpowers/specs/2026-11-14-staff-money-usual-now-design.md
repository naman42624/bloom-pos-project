# Staff money, own-pocket spending, "Usual now" and a calmer add sheet — design

Date: 2026-11-14 (revised the same day after an independent product review: `.superpowers/sdd/2026-11-14-staff-money/product-review.md`).
Piece 2 of 3 of the expense work (piece 1: expense book, PR #39; piece 3: rider km account, not started).
Branch: `feature/staff-money`, stacked on `feature/expense-book`. Delivered as **two pull requests** (§9).

## 1. Why

- **A. Salary advances at the counter.** Staff ask for some salary now. Today the counter hands over cash and records an expense (often Kind "Salary"), so payroll never deducts it, and nothing limits it.
- **B. Shopping money.** Someone is given cash to buy supplies and later comes back with bills and change. Nothing tracks "₹500 is with Ramesh" until then.
- **C. Own-pocket spending.** The owner (or a staff member) sometimes pays for shop things from their own pocket. Today it is either not recorded or recorded as if from the drawer.
- **D. Faster daily entry.** The add sheet should be calmer and quicker, and should know that a tea added at 11:00 is not needed again at 11:05.

## 2. Decisions (all from the user, 2026-11-14)

1. A and B both happen.
2. Counter staff give advances **without a PIN up to ₹500 a day and ₹2,000 a month per person** (both owner settings); above either needs a manager/owner PIN.
3. **Counter staff money for themselves always needs a manager/owner PIN** (advances and shopping money alike).
4. **A manager taking money for themselves needs no PIN, but the owner is notified every time.** The owner is also notified whenever a PIN approves an over-limit or self amount.
5. Shopping money: the counter chooses **spent already** (normal expense with Given to) or **bring back bills and change**.
6. Unsettled shopping money: **red after N days** (default 3) for owner and manager, **and** at payroll a **"Take from pay"** tick — for staff with a salary only. **Riders' unsettled shopping money stays open for piece 3** (the km account) and is not offered at payroll.
7. Shopping money follows the advance rules (limit, PIN, self-PIN) with **its own daily limit** (default ₹1,000).
8. Advances use the existing `salary_advances` record; shopping money gets its own table.
9. **One "Add expense" button.** Salary advance and Shopping money are two plain links inside the sheet.
10. Notion-style look: plain rows, thin dividers, grey labels, one pink button per screen — **but the two most-used choices stay one tap**: an inline **Cash | UPI | Own pocket** switch and the **3 most recent people** inline.
11. Suggestions learn each item's usual time; a just-added item drops out until it is usually needed again.
12. A 1-tap **"Usual now"** line on the Expenses screen, with Undo. The payment method is always shown on the line.
13. **Counter staff see salary advances without names** ("Salary advance"), except their own. Owner and manager see names.
14. **Own pocket → "Shop owes"** (user approved): an expense paid from someone's own pocket never touches the drawer and adds to what the shop owes that person; it is paid back later from the drawer or by UPI, or (owner only) kept as the owner's money. Overspent shopping money uses the same mechanism.
15. Owner keeps the summary first on Expenses; managers open on today's list (built in piece 1).

Defaults: Cash or UPI for hand-outs (only cash touches the drawer); part settling allowed; staff see their own advances, holdings and what the shop owes them; the existing request-an-advance flow stays; riders can receive shopping money.

## 3. Names (one name per thing, everywhere)

| Thing | Name on screen |
|---|---|
| Advance against salary | **Salary advance** |
| Cash given to buy things, to be accounted for later | **Shopping money** |
| The card listing who holds shopping money | **Shopping money out** |
| Accounting for shopping money | "**Ramesh is back — what was bought?**" (button: **Done**) |
| Converting unsettled money at payroll | **Take from pay** |
| Paying from one's own pocket | **Own pocket** |
| What the shop owes someone | **Shop owes** (button: **Pay back**) |
| The 1-tap suggestions | **Usual now** |

## 4. What people see

### 4.1 The add sheet

```
  Add expense                                   ✕
  ─────────────────────────────────────────────
  Usual now
    Tea      ₹50   Cash · Tota Ram
    Milk     ₹60   Cash
  Often
    Petrol  ₹200   Cash · Ramesh
    Roses   ₹300   UPI
  ─────────────────────────────────────────────
  What was it for?   [ type here…            ]
  Amount             ₹ [      ]
  Paid by            [ Cash | UPI | Own pocket ]
  Given to           (Tota Ram) (Ramesh) (Asha)   More ›
  ─────────────────────────────────────────────
  Kind               Food (from the item)     ›
  Date               Today                    ›
  Note / bill photo  —                        ›
  ─────────────────────────────────────────────
  ↗ Salary advance      ↗ Shopping money
  ─────────────────────────────────────────────
  [              Save ₹50              ]
```

- **Usual now** first (items usually needed about now), then **Often** (pinned and most-used, minus anything just added), so the list is never empty. Each row shows amount, **method** and person. Tapping a row fills item, amount (the item's most common amount), method, Given to and kind. Common case: Add expense → Tea → Save = **3 taps**.
- **Paid by** is an inline three-way switch. It starts on **the current user's own last method, else Cash**. With the register closed, Cash is disabled with "Open register" inline (piece 1 behaviour).
- **Own pocket** shows one more inline line: "Whose? (Me) (Ramesh) (Asha) More ›" (defaults to Me). Never touches the drawer.
- **Given to**: the 3 most recent people for this shop as inline chips, "More ›" opens the full list with "Someone else (type a name)". A person not clocked in today is never pre-filled.
- **Kind** row: filled from the item. **Salary is no longer offered in this list** — choosing "Salary advance" is the way to give salary money (see §5.2). Existing salary rows still open in Change mode with their locks (piece 1).
- Date row: owner/manager only (piece 1 back-dating rules unchanged).
- Change mode uses the same layout; piece 1 locks (old register-less cash, salary line) show as greyed rows with their explanation.
- Typing "advance" or "shopping" in "What was it for?" surfaces the two links first.
- Picking a person who holds shopping money in Given to shows: "Ramesh has ₹500 shopping money — Ramesh is back? ›".

### 4.2 Salary advance and Shopping money

```
  Salary advance                               ✕
  ─────────────────────────────────────────────
  Who                (Ramesh) (Asha) (Me)   More ›
  Amount             ₹ [ 300 ]
  Paid by            [ Cash | UPI ]
  Note               —                        ›
  Ramesh: ₹1,200 in advances not yet taken from pay
  ─────────────────────────────────────────────
  [         Give advance ₹300          ]
```

- **Who**: the shop's staff and riders (a purpose-built list, §6), recent first; "Me" included.
- The line under Note shows that person's advances not yet taken from pay (advance mode) or shopping money they still hold (shopping mode).
- Taps for a ₹300 advance to someone else under the limits: Add expense → Salary advance → Ramesh → 300 → Give = **5**.
- When a PIN is needed, an inline box appears above the button: "A manager or owner must confirm" — **pick a name** (managers linked to this shop and the owner who have an approval PIN set) → PIN. If nobody has an approval PIN set: "No manager has an approval PIN yet. The owner can set one in Settings → Approval PIN."

### 4.3 "Usual now" on the Expenses screen (1 tap)

On the day list (counter staff, managers) and the owner's summary when the period is Today:

```
  Usual now
    Tea   ₹50   Cash · Tota Ram              [+ Add]
    Milk  ₹60   Cash                         [+ Add]
```

- Up to 3 rows. `+ Add` saves at once with what the line shows. A large bar "Added Tea ₹50 · Cash — **Undo**" stays **15 seconds**. Undo removes through the normal remove route (a refusal shows the server's plain message).
- Tapping the item name (not the button) opens the add sheet pre-filled, to change something first.
- If the line is Cash and the register is closed, the button reads "Open register".

### 4.4 "Shopping money out" card and "Ramesh is back"

On the counter-staff, employee, manager and owner dashboards and at the top of Expenses, **only while someone holds shopping money or the shop owes someone**:

```
  Shopping money out
    Ramesh     ₹500    2 days                   ›
    Tota Ram   ₹200    4 days  (red)            ›
  Shop owes
    Owner      ₹850                    [Pay back]
    Ramesh     ₹120                    [Pay back]
```

Tap a shopping line:

```
  Ramesh is back — what was bought?
  Had ₹500 · given 12 Nov by Priya
  ─────────────────────────────────────────────
  Roses            ₹300                         ✕
  + Add what was bought
  Change back       ₹ [ 200 ]   [ Cash | UPI ]
  ─────────────────────────────────────────────
  Still with Ramesh  ₹0
  [               Done               ]
  Save, rest later
```

- Items use the add sheet's suggestions. Change back is pre-filled with what is left.
- **Overspent** (bills more than he had): "Ramesh spent ₹120 of his own — the shop owes him ₹120. [Pay back now] [Later]". Later adds it to Shop owes.
- **No bills**: allowed; Done with change only.
- **Pay back** (Shop owes): amount (pre-filled, editable for part), Cash | UPI. Cash needs the register open. For the owner's own line, a second choice: "**Keep as my money**" (no pay back; the line closes).

### 4.5 "My money" (staff profile)

On each person's own Profile, next to where they request an advance: advances this month (with "taken from pay" once deducted), shopping money they hold, and what the shop owes them.

### 4.6 Register screen and close

The Cash Register screen's session details gain "**Shopping money given**", "**Change brought back**" and "**Shop owes paid back**" lines (like the helper float lines), and its closed-session expense figure leaves them out. The close screen shows "**₹500 still with Ramesh**" lines for open shopping money from this shop (information only; closing is not blocked).

### 4.7 Owner tools

- Settings → Expenses: "Advance limit per person per day" (₹500), "Advance limit per person per month" (₹2,000), "Shopping money limit per person per day" (₹1,000), "Mark shopping money late after (days)" (3).
- **Shopping money history** (owner/manager, from the card's "See all"): every hand-out with who gave it, who confirmed, bills, change, status, newest first; filter open/closed and by person.
- **Write off** (owner only, on an open shopping line or a Shop owes line): closes it with a reason; for shopping money the remainder becomes an expense "Shopping money written off — <name>" (`payment_method='shopping_money'`, never touches the drawer).
- Deactivating a staff member who holds shopping money or is owed money warns: "Ramesh still has ₹500 shopping money. Settle or write it off first." (warning, not a block).

### 4.8 Look

Expenses list rows, the card and the screens above use the same plain style: thin dividers, grey secondary text, one pink primary button per screen, tap targets ≥ 44 px.

## 5. Rules

### 5.1 Who can do what

| | Counter staff / employee | Manager | Owner | Helper | Florist, rider |
|---|---|---|---|---|---|
| Usual now 1-tap add | yes | yes | yes | no | no |
| Salary advance, Shopping money | yes (limits; PIN for self) | yes (limits; self needs no PIN, owner notified) | yes, no limit | no | no |
| Own pocket expense | yes (own pocket only, or a colleague's with their name) | yes | yes | no | no |
| Ramesh is back (settle), Pay back | yes | yes | yes | no | no |
| Shopping money out card | yes | yes | yes | no | no |
| History, Write off | — | history | both | no | no |
| My money | own | own | — | no | own |
| Limit settings | — | — | yes | — | — |

- PIN approvers: active managers linked to the shop and the owner, with an approval PIN set; the approver is never the recipient. Checked through `server/utils/approval-pin.js` (same lockout as counter login; the box says so: "Wrong tries count toward your PIN lockout.").
- Helpers stay default-denied; no new route goes into `helper-routes.js`.
- **Server refuses salary-kind expenses from counter staff and employees** on `POST`/`PUT /api/expenses` ("Use Salary advance for money given to staff."). Owner/manager keep the old path for edge cases (it still requires an employee).

### 5.2 Limits

- Advance: today's advances to that person (any path, including approved in-app requests) + this ≤ daily limit **and** this calendar month's (shop-local) advances + this ≤ monthly limit. Shopping money: today's hand-outs + this ≤ its daily limit. Advances and shopping money never count against each other.
- Over a limit, or counter staff for self → PIN needed: the server answers 409 `{ needs_pin: 'over_day' | 'over_month' | 'self', message }`; the app shows the PIN box and resends with `approver_id` + `approver_pin`.
- Manager for self → no PIN; owner notified (`notifyByRole` owner: "Asha (manager) took a ₹300 salary advance."). Any PIN-approved amount also notifies the owner.

### 5.3 Salary advance

- One shared server helper writes: the `salary_advances` row (`status='approved'`, `approved_by`, additive `given_by`, `source='counter'`, `payment_method`, `location_id`, `expense_id`), the `salary` expense (`employee_id`, `register_id`), and for cash the register lock + `expected_cash` down. Approving an in-app request uses the same helper.
- **Removing or changing that expense line** (existing routes): removing cancels the advance in the same transaction (`status='cancelled'`, cash back into the open session as today, audited); changing the amount updates the advance to match; changing anything that would break the link (kind, employee) is refused ("Remove it and give the advance again."). Refused if payroll already deducted any of it.
- Payroll already deducts all unpaid approved advances; nothing changes there.

### 5.4 Shopping money

- Table `staff_money_out` (§7). Hand-out in cash: full amount leaves the drawer at once (`register_id` on the row, `expected_cash` down). Not an expense, so the summary shows only money actually spent.
- Settle ("is back"): each bill → expense with `money_out_id`, `payment_method='shopping_money'` (never counted by any drawer query, which all count only `'cash'`), Given to = holder. Change back → a `staff_money_settles` row; cash change into the open register (`expected_cash` up). Two settles at once: the row lock makes the second answer 409 "Already done — refresh".
- Overspent: bills beyond what is left create a `shop_owes` row for the holder for the excess.
- Remove a hand-out (typo): allowed for **the person who gave it, while the same register session is open**, or owner/manager, and only while nothing is settled; cash goes back into that open session. Otherwise refused plainly.
- Removing a settle bill puts its amount back as still with that person; no drawer move.
- Rider holdings: never offered at payroll; piece 3 will settle them. Owner can write off.

### 5.5 Own pocket and Shop owes

- An expense with Paid by **Own pocket** is stored with `payment_method='own_pocket'` and additive `paid_by_user_id` (the pocket's owner); never counted by drawer queries. It creates a `shop_owes` row (`user_id`, `amount`, `source='own_pocket'`, `expense_id`).
- `shop_owes` rows: `open` → `paid` (Pay back, cash from the open register or UPI, in a `withMoneyTx`; part payments allowed via `paid_amount`) or `kept` (owner's own line only: "Keep as my money") or `written_off` (owner).
- Removing an own-pocket expense removes its open `shop_owes` amount; refused once any of it was paid back.

### 5.6 Payroll

- Calculate returns that person's open shopping money (staff with a salary only; riders excluded) as its own figure.
- The payroll screen shows it as a separate line "☐ Take ₹500 unsettled shopping money from pay". The deduction is **worked out on the server at Pay time**; the request carries the amount the screen showed, and if it no longer matches (something was settled in between), Pay is refused: "Shopping money changed since you calculated — tap Calculate again." On success the remainder becomes an approved advance (`source='shopping_money'`) deducted in the same payment, and the hand-out closes as `to_salary`.

### 5.7 Usual now

Per item and shop:

- Learn **time-of-day slots**: cluster the item's entries in the last 60 days by shop-local hour (entries within 2 hours of each other are one slot); a slot with ≥ 3 entries is real. Also learn the usual gap in days (median days between days that have entries).
- An item is **usual now** when the current time is within a real slot's window (slot start − 1 h to slot end + 2 h), today's entries haven't already covered that slot, and today is a usual day (days since last entry ≥ 0.8 × usual gap in days, or the item is daily).
- Otherwise it can still appear under **Often** (pins, then most used in 30 days), except anything added in the last 2 hours.
- Amount shown = the item's most common amount in the last 60 days (ties → most recent). Method = **the current user's own** last method for that item, else Cash. Person = the item's last Given to, unless that person is not clocked in today.
- Typing always searches every item.

### 5.8 Privacy

`GET /api/expenses` (and the day list) for counter staff and employees: salary rows that are not their own come back as "Salary advance", with employee and Given to removed. Owner and manager see names. Shop owes lines are visible to everyone who sees the card, because counter staff do the Pay back.

### 5.9 Audit

Audit entries for: advance given (incl. approver), advance cancelled, shopping money given / settled / removed / written off / taken from pay, own-pocket expense, pay back, keep as my money, write off.

### 5.10 Errors (plain, say what to do)

- Over the day limit: "That's more than the ₹500 daily advance limit. A manager or owner can confirm with their PIN."
- Over the month limit: "That would take Ramesh over the ₹2,000 monthly advance limit. A manager or owner can confirm with their PIN." (Changed after the final review: the first wording stated the limit as if it were the real total, and it showed a colleague's total to counter staff.)
- Self (counter staff): "A manager or owner needs to confirm money for yourself."
- Wrong PIN: "That PIN didn't match. <n> tries left." (existing copy)
- Cash with the register closed: "Open the register to give cash — or pick UPI." with an inline Open Register button.
- Already handled: "Already done — refresh."
- Salary kind from counter staff: "Use Salary advance for money given to staff."
- Double taps on Give, Done, Pay back and Usual now Add are ignored (`useSubmitGuard`).

## 6. Routes (the plan fixes exact shapes)

- `GET /api/staff-money/people?location_id=` — staff and riders linked to the shop, with recent-first order.
- `GET /api/staff-money/approvers?location_id=` — names of managers/owner who can confirm (approval PIN set).
- `POST /api/staff-money/advance`, `POST /api/staff-money/shopping`.
- `GET /api/staff-money/open?location_id=` — the card (shopping money out + shop owes).
- `POST /api/staff-money/:id/settle`, `DELETE /api/staff-money/:id`, `POST /api/staff-money/:id/write-off`.
- `POST /api/staff-money/owes/:id/pay-back`, `POST /api/staff-money/owes/:id/keep`, `POST /api/staff-money/owes/:id/write-off`.
- `GET /api/staff-money/history?location_id=&status=&user_id=`, `GET /api/staff-money/mine`.
- `GET /api/expenses/suggest` — gains `usual_now` / `often` sections, `common_amount`, `my_last_method`.
- `POST`/`PUT /api/expenses` — accept `own_pocket`; refuse salary kind for counter staff; keep advance link on remove/change.
- Payroll calculate/disburse — open shopping money and the Take from pay amount.
- Register status/history/close — the new lines.

## 7. Data (additive only)

- `staff_money_out(id, location_id, user_id, amount, payment_method, register_id, given_by, approved_by, note, status, settled_amount, returned_amount, created_at, closed_at, close_reason)` — status `open | settled | to_salary | removed | written_off`.
- `staff_money_settles(id, money_out_id, bills_amount, returned_amount, returned_method, register_id, settled_by, created_at)`.
- `shop_owes(id, location_id, user_id, amount, paid_amount, source, money_out_id, expense_id, status, created_by, created_at, closed_at, close_reason)` — status `open | paid | kept | written_off`.
- `shop_owes_payments(id, owes_id, amount, method, register_id, paid_by, created_at)`.
- `expenses.money_out_id`, `expenses.paid_by_user_id`; `payment_method` gains `shopping_money` and `own_pocket` (no CHECK constraint exists on that column).
- `salary_advances.given_by`, `source`, `payment_method`, `location_id`, `expense_id`; status gains `cancelled`.
- Settings: `advance_daily_limit` 500, `advance_monthly_limit` 2000, `shopping_money_daily_limit` 1000, `shopping_money_late_days` 3 (seeded only if missing).
- Read the `db-migration-safety` skill first; no apostrophes in SQL `--` comments.

## 8. Testing

- New `server/scripts/verify-staff-money.js`: limits (day, month, approved request counts), PIN (self, over limit, wrong, approver = recipient, manager not linked), manager self → no PIN + owner notification; helper/florist 403; salary kind refused for counter staff; removing an advance's expense cancels it; drawer after hand-out, part settle, full settle, change back, overspend → shop owes, own pocket, pay back; two settles at once; change returned on a later day lands in that day's session; register status = close preview; shopping_money/own_pocket expenses never counted by any drawer query; payroll take-from-pay with a stale amount refused; riders not offered at payroll; privacy of salary names; Usual now slots (tea at 11 and 16 both return), Often never empty, most-common amount, own last method.
- App script tests for the settle/owes maths and the Undo state.
- Every existing suite re-run; on-screen checks on desktop and at 375 px.
- Tests close only registers they opened; never touch registers 83 or 4383.

## 9. Delivery

- **PR A — calmer add sheet and Usual now** (no new money concepts): the sheet layout with inline Cash | UPI and recent people, Usual now / Often ranking, the 1-tap line with Undo, salary kind removed from the Kind list for counter staff (server refusal included), privacy of salary names. Ships the daily win first.
- **PR B — staff money**: advances, shopping money, own pocket and Shop owes, the card, register lines, payroll, history, write-off, My money, settings. Stacked on PR A.
- Deploy: server before the app, for each PR. Leave limits at their defaults until the new app is on every counter device.

## 10. Out of scope

- Rider petrol / km pay and settling riders' shopping money (piece 3).
- Changes to how payroll computes salary beyond Take from pay.
- Verifying UPI payments.
- Multi-shop polish beyond scoping lists to the current shop.
