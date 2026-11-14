# Staff money, "Usual now" and a calmer add sheet — design

Date: 2026-11-14 · Piece 2 of 3 of the expense work (piece 1: expense book, PR #39; piece 3: rider km account, not started).
Branch: `feature/staff-money`, stacked on `feature/expense-book`.

## 1. Why

Two things happen at the counter that the app does not handle today:

- **A. Salary advances at the counter.** A staff member asks for some of their salary now. Today the only path is: the staff member requests in the app, an owner/manager approves on another screen. In practice the counter just hands over cash and records an expense, so payroll never knows.
- **B. Cash for shop work.** Someone is given cash to buy supplies. Sometimes it is already spent (an expense with "Given to" covers this since piece 1). Sometimes they come back later with bills and change, and nothing tracks "₹500 is with Ramesh" until then.

The user also asked for a calmer, Notion-style add sheet with fewer taps, and for suggestions that know an item was just added (a tea added at 11 should not be the top suggestion at 11:05).

## 2. Decisions (all from the user, 2026-11-14)

1. Both A and B happen.
2. Counter staff may give an advance **up to an owner-set daily limit per person** without asking; above it needs a manager/owner PIN.
3. **Money for yourself always needs a manager/owner PIN**, however small.
4. Cash for shop work: the counter chooses each time — **spent already** (a normal expense with Given to) or **bring back bills and change** (settled later).
5. Unsettled shopping money: shows **red after N days** (owner setting, default 3) to the owner and manager, **and** at payroll the owner sees it with a **"Take from pay" tick box**.
6. Shopping money follows **the same rules as advances** (limit, PIN, self-PIN), with **its own separate limit**.
7. Approach 1: advances use the existing `salary_advances` record; one new table for shopping hand-outs.
8. **One "Add expense" button.** Salary advance and Cash for shopping are two plain links inside the add sheet, not separate buttons.
9. Notion-style look: plain rows, thin dividers, grey labels, one pink button per screen; no blocks of coloured pills.
10. Suggestions learn each item's usual gap; a just-added item drops out until it is usually due again.
11. A 1-tap **"Usual now"** line on the Expenses screen, with a 10-second Undo. Named "Usual now" (not "Due now", which sounds like a bill).
12. Owner keeps the summary first on Expenses; managers open on today's list (already built in piece 1, PR #39).

Defaults (stated, not objected to): Cash or UPI for both kinds (only cash touches the drawer); part settling allowed; staff see their own advances and holdings; the existing request-an-advance flow stays; riders can receive shopping money, but rider petrol/km pay is piece 3.

## 3. What people see

### 3.1 The add sheet (Notion-style)

```
  Add expense                                   ✕
  ─────────────────────────────────────────────
  Usual now
    Tea              ₹50     Tota Ram
    Milk             ₹60
    Petrol          ₹200     Ramesh
  ─────────────────────────────────────────────
  What was it for?   [ type here…            ]
  Amount             ₹ [      ]
  ─────────────────────────────────────────────
  Paid by            Cash                     ›
  Given to           —                        ›
  Kind               Food (from the item)     ›
  Date               Today                    ›
  Note / bill photo  —                        ›
  ─────────────────────────────────────────────
  ↗ Salary advance      ↗ Cash for shopping
  ─────────────────────────────────────────────
  [              Save ₹50              ]
```

- **Usual now** (top): 3–5 plain rows, amount and person in grey. Tapping one fills item, amount, Given to and kind; Cash/UPI starts on the last one used. Common case: Add expense → Tea · ₹50 → Save = **3 taps**.
- **Detail rows** (label left in grey, value right, chevron). Tapping a row opens one simple list or input:
  - Paid by → Cash / UPI (register-closed handling unchanged: Cash disabled with "Open register" inline).
  - Given to → one searchable list of staff/riders + "Someone else (type a name)". Replaces the block of person buttons.
  - Kind → the 8 kinds as a plain list; filled from the item, so usually untouched.
  - Date → owner/manager only (back-dating rules from piece 1 unchanged: earlier days are UPI only).
  - Note / bill photo → both in one row's sub-screen.
- Change-expense mode uses the same layout; the piece-1 locks (old register-less cash, salary line) keep working and show as greyed rows with the same explanation text.
- **Salary advance** and **Cash for shopping**: two plain links at the bottom; typing "advance" or "shopping" in "What was it for?" also surfaces them first.
- One button, labelled with the amount ("Save ₹50", "Give advance ₹300", "Give ₹500 for shopping").

### 3.2 Advance mode and shopping mode

Tapping either link turns the sheet into:

```
  Salary advance                               ✕
  ─────────────────────────────────────────────
  Who                Ramesh                   ›
  Amount             ₹ [ 300 ]
  Paid by            Cash                     ›
  Note               —                        ›
  ─────────────────────────────────────────────
  [         Give advance ₹300          ]
```

- **Who** is required and comes first (staff and riders linked to this shop; "Me" is listed too).
- Item, kind, date and bill photo rows are hidden (they don't apply).
- Taps for a ₹300 advance to someone else under the limit: Add expense → Salary advance → Ramesh → 300 → Give = **5**.
- When a PIN is needed (over the limit, or for yourself), an inline box appears above the button: "A manager or owner must confirm — Employee code [ ] PIN [ ]". Same code + PIN pair as the helper discount override.

### 3.3 "Usual now" on the Expenses screen (1 tap)

On the day list (counter staff, managers) and on the owner's "Today" view, above the list:

```
  Usual now
    Tea   ₹50   Tota Ram                 [+ Add]
    Milk  ₹60                            [+ Add]
```

- Up to 3 rows. `+ Add` saves at once with the remembered amount, person, kind and the last Cash/UPI used, then shows "Added Tea ₹50 — Undo" for 10 seconds. Undo removes it through the normal remove route.
- If the register is closed and that item would be cash, the button reads "Open register" instead.
- Rows are hidden for roles that cannot add expenses.

### 3.4 "Money with staff" card

On the counter-staff, employee, manager and owner dashboards, and at the top of Expenses, **only while someone holds shopping money**:

```
  Money with staff
    Ramesh     ₹500    2 days                   ›
    Tota Ram   ₹200    4 days  (red)            ›
```

Tap a line → **Settle**:

```
  Settle — Ramesh had ₹500 (given 12 Nov by Priya)
  ─────────────────────────────────────────────
  Bills
    Roses            ₹300                       ✕
    + Add a bill
  Change returned    ₹ [ 200 ]   Cash ›
  ─────────────────────────────────────────────
  Left with Ramesh   ₹0
  [              Settle              ]
  Save, rest later
```

- Bills use the same item suggestions as the add sheet.
- Change is pre-filled with what is left after the bills.
- "Save, rest later" keeps the remainder open.
- Picking a person who holds shopping money in "Given to" on a normal expense shows one line: "Ramesh has ₹500 shopping money — Settle it instead ›".

### 3.5 "My money" (staff profile)

A plain section on each staff member's own Profile, next to where they request an advance today: advances this month (with "taken from pay" once payroll deducts them) and any shopping money they hold.

### 3.6 Owner settings

Settings → Expenses: "Advance limit per person per day" (default ₹500), "Shopping money limit per person per day" (default ₹1,000), "Mark shopping money late after (days)" (default 3).

### 3.7 Look elsewhere

The Expenses list rows, the Money with staff card and the settle screen use the same plain style: thin dividers, grey secondary text, one pink primary button per screen.

## 4. Rules

### 4.1 Who can do what

| | Counter staff / employee | Manager | Owner | Helper | Florist, rider |
|---|---|---|---|---|---|
| Usual now 1-tap add | yes | yes | yes | no | no |
| Salary advance, Cash for shopping | yes (limits, PIN) | yes (limits; PIN for self) | yes, no limit | no | no |
| Settle shopping money | yes | yes | yes | no | no |
| Money with staff card | yes | yes | yes | no | no |
| My money | own | own | — | no | own |
| Limit settings | — | — | yes | — | — |

- PIN approvers: an active manager linked to the shop, or the owner. A manager giving to themselves needs another manager's or the owner's PIN; the approver can never be the recipient. The owner never needs a PIN.
- Helpers stay default-denied (`server/utils/helper-routes.js`); none of the new routes are added there.

### 4.2 Limits

- Advance check: sum of today's (shop-local) advances to that person from any path (counter, approved requests) + this amount ≤ `advance_daily_limit`. Same for shopping hand-outs against `shopping_money_daily_limit`. The two never count against each other.
- Over the limit or self → PIN required; the request carries `approver_code` + `approver_pin`; checked with `server/utils/approval-pin.js` (shared reservation/lockout), restricted to manager/owner, outside any transaction that can roll back.

### 4.3 Salary advance

- Saved as a `salary_advances` row: `status = 'approved'`, `approved_by` = PIN approver or the giver, plus additive `given_by`, `source = 'counter'`, `payment_method`, `location_id`.
- Writes the same `salary` expense (with `employee_id`, `register_id`) that approving a request writes today. Both paths call one shared helper so they cannot drift.
- Cash: register guard + `expected_cash` down, in one transaction with the row lock. UPI: no drawer change.
- Payroll already deducts all unpaid advances (`pending_advances`), so nothing changes there for advances.

### 4.4 Cash for shopping

- New additive table `staff_money_out`: `id, location_id, user_id` (holder), `amount, payment_method, register_id, given_by, approved_by, note, status` (`open` | `settled` | `to_salary` | `removed`), `settled_amount, returned_amount, created_at, closed_at`.
- Hand-out (cash): the full amount leaves the drawer at once (`expected_cash` down; the row carries `register_id`). It is **not** an expense, so the expense summary shows only money actually spent.
- Settle: each bill becomes a normal expense with additive `expenses.money_out_id` pointing at the hand-out and `payment_method = 'shopping_money'` (shown as "Shopping money · Ramesh"). Every drawer query already counts only `payment_method = 'cash'`, so these rows can never touch the drawer, including the `created_at` fallback for register-less rows (planning ruling 2026-11-14: safer than adding an exclusion to each query). Change returned is a row in additive `staff_money_settles` (`money_out_id, bills_amount, returned_amount, returned_method, register_id, settled_by, created_at`); returned cash goes back into the drawer (`expected_cash` up) on the open register.
- Register close: `computeRegisterClose` adds "shopping money out" (cash hand-outs by `register_id`, not `removed`) and "change returned" (cash `staff_money_settles.returned_amount` by `register_id`), the same way helper floats and handovers are handled; register status, history, the closed-session inferred expenses and the pickup overwrite in `deliveries.js` include them too. A test pins the net effect: drawer down by exactly what was spent.
- Part settle leaves `amount − settled − returned` open. "Late" = open and older than the setting, counted from the hand-out date.
- Removing a settled bill puts its amount back as open with that person; it never moves drawer cash.
- A hand-out can be removed by owner/manager only while nothing is settled; cash goes back into the drawer if the register it came from is still open, otherwise refused with plain copy.
- UPI hand-outs: no drawer change at hand-out; change returned can be Cash (into the drawer) or UPI.

### 4.5 Payroll

- `POST /payroll/calculate` also returns that person's open shopping money.
- The payroll screen shows "₹500 shopping money not settled ☐ Take from pay". Ticking it, on disburse, converts the open remainder into an approved advance (`source = 'shopping_money'`) in the same transaction, marks the hand-out `to_salary`, and the existing advance deduction takes it off.

### 4.6 Usual now ranking

Per item and shop, from that shop's own expenses:

- With 3 or more past entries: learn the usual gap (median gap between consecutive entries, last 60 days) and the usual time of day. An item is "usual now" when time since its last entry ≥ 80% of its usual gap; ranked by how overdue it is, then by count.
- An item added within its usual gap is left out (tea added at 11:00 with a ~5-hour gap returns around 15:00).
- With fewer than 3 entries: fall back to piece 1's ranking (owner pins first, then the most used in 30 days), still leaving out anything added in the last 2 hours.
- Pinned items stay in the add sheet's list but follow the same "just added" rule.
- Typing always searches every item, so nothing is hidden for good.
- Computed on the server (`GET /api/expenses/suggest` gains `usual_now` ranking); shop-local time.

### 4.7 Errors (plain, say what to do)

- Over the limit: "That's more than the ₹500 daily advance limit. A manager or owner can type their PIN to allow it."
- Self: "A manager or owner needs to confirm money for yourself. Ask them to type their PIN."
- Wrong PIN: "That PIN didn't match. Try again or ask the manager." (existing lockout applies)
- Cash with the register closed: "Open the register to give cash — or pick UPI." with an inline Open Register button.
- Change more than what's left: "Ramesh only has ₹120 left — check the change amount."
- Double taps on Usual now, Give and Settle: ignored (`useSubmitGuard`); server writes are safe to retry where a client ref exists.

## 5. Data (additive only)

- New table `staff_money_out` (above), indexes on `(location_id, status)` and `(user_id, status)`.
- New table `staff_money_settles` (one row per settle; above), index on `(register_id)` and `(money_out_id)`.
- `expenses.money_out_id` (nullable, FK); `payment_method` gains the value `shopping_money` (written only by the settle route).
- `salary_advances.given_by`, `source`, `payment_method`, `location_id` (nullable; old rows stay NULL = "requested in app").
- Settings `advance_daily_limit` (500), `shopping_money_daily_limit` (1000), `shopping_money_late_days` (3), seeded only if missing.
- All via `ensureColumn` / guarded `CREATE TABLE IF NOT EXISTS` in `server/config/database.js` (read the `db-migration-safety` skill first). No apostrophes in SQL `--` comments.

## 6. Routes (sketch; the plan fixes names)

- `POST /api/staff-money/advance` — give an advance (limit, PIN, register).
- `POST /api/staff-money/shopping` — hand out shopping money.
- `GET /api/staff-money/open?location_id=` — the Money with staff card.
- `POST /api/staff-money/:id/settle` — bills + change; partial allowed.
- `DELETE /api/staff-money/:id` — remove an unsettled hand-out (owner/manager).
- `GET /api/staff-money/mine` — My money.
- `GET /api/expenses/suggest` — gains the usual-now ranking.
- Payroll calculate/disburse — gain open shopping money and the "Take from pay" flag.

## 7. Testing

- New `server/scripts/verify-staff-money.js`: limits and PIN (incl. self, wrong PIN, approver = recipient refused); helper and florist get 403; drawer after hand-out, part settle, full settle, change returned; register close preview and close include both movements and exclude settle-bill expenses; removing a settled bill; payroll tick converts open money into an advance and deducts it; usual-now ranking (just-added tea hidden, comes back after its gap; under 3 entries falls back).
- App script tests for the ranking display and the settle maths.
- Every existing suite re-run; on-screen checks on desktop and at 375 px for the add sheet, advance and shopping modes, Usual now with Undo, Money with staff and settle, My money, owner settings.
- A test closes only registers it opened itself; never touch real registers (83, 4383).

## 8. Out of scope

- Rider petrol / km pay (piece 3).
- Any change to how payroll computes salary beyond the shopping-money tick.
- Real payment verification for UPI hand-outs.
- Multi-shop polish beyond scoping lists to the current shop.

## 9. Deploy

Server before the app. Leave the limits at their defaults until the new app is on every counter device.
