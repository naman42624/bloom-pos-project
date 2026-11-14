# Expense book: design

Date: 2026-11-13. Status: approved in chat, awaiting written-spec review.
Branch: `feature/expense-book` (from `main` after PR #37).

## 1. Why

What the owner said (2026-11-13):

- Expenses can't be edited.
- Expenses aren't meaningful, because only today's list is visible. Once the day passes, earlier expenses can't be seen.
- There's no way to compare spending on the same thing across periods (this month vs a month ago), or to see the spend per item over a chosen period.
- Expenses can't be tied to salary, salary advances or other staff payments.
- Riders are paid by km driven each day (km × ₹3). Petrol cash a rider takes is subtracted, and this account is kept separate from salary.
- The add-expense flow isn't intuitive. Suggestions should make it faster, with fewer taps.

The work is split into three pieces, each with its own spec, plan and build:

1. **Expense book (this spec):** history, items, comparisons, quick entry, "Given to".
2. **Staff money links:** expenses as salary, advance or other payment for a staff member, tied into the existing advances and payroll without double counting.
3. **Rider km account:** daily km × rate, minus petrol cash taken (read from piece 1's "Given to" entries), minus payouts, giving a running balance per rider, kept separate from salary.

This spec covers piece 1 only.

**Success:**

- A common expense is added in 3 taps: Add expense → suggestion → Save.
- The owner can answer "How much did petrol cost in October vs September?" in a few taps.
- Every expense can say who was handed the cash.
- Past entries can be found and corrected.

## 2. What exists today

- `expenses` table columns:
  - `category`: 8 fixed values (supplies, petty_cash, maintenance, transport, food, utilities, salary, other);
  - `amount`, `description`, `payment_method`, `expense_date`, `is_return`, `created_by`;
  - `employee_id`: salary only; cleared for every other category;
  - `register_id`.
- Routes in `server/routes/expenses.js`:
  - `GET /`;
  - `POST /`;
  - `PUT /:id` and `DELETE /:id`. These came in PR #37. Staff may change only their own entries, and only while their session is open; owner and manager may change any. The drawer moves only by the difference.
  - `GET /summary`.
- `ExpensesScreen.js` shows today only.
- Payroll (`staff-management.js`) and advance approval (`attendance.js`) already insert expense rows with `category='salary'` and `employee_id`.
- Local data: 24 expenses in six months.

## 3. Decisions made in chat

| # | Question | Decision |
|---|---|---|
| D1 | How items work | Learned from typing. The owner can merge near-duplicates. |
| D2 | Quick suggestions | Owner's pinned items first, then this shop's most used in the last 30 days. Shown alongside type-ahead. |
| D3 | Owner/manager history | Period summary by category and item, each with "vs the period before". |
| D4 | Counter staff | Add screen, plus a **read-only list of the last 7 days** at their shop. Change/Remove only their own entries for today, while the register is open. |
| D5 | Manager access | Full history and comparison **on by default**. |
| D6 | Extra fields | Optional bill photo, optional note, date other than today (owner and manager only). No quantity for now. |
| D7 | Storing items | New `expense_items` table (approach A). |
| D8 | Categories | The 8 stay fixed. |
| D9 | Who got the cash | Optional "Given to" on every expense: a staff member, a delivery partner, or a free name. Remembered per item. |

## 4. Data (additive only)

Follow the `db-migration-safety` skill. All changes go in `server/config/database.js` as `CREATE TABLE IF NOT EXISTS` / `ensureColumn` / `CREATE INDEX IF NOT EXISTS`. No apostrophes in `--` SQL comments.

### 4.1 New table `expense_items`

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `name` | VARCHAR(80) NOT NULL | As shown, e.g. "Petrol". |
| `name_key` | VARCHAR(80) NOT NULL UNIQUE | `lower(trim(name))` with internal whitespace squeezed to one space. |
| `category` | VARCHAR(50) NOT NULL | One of the 8. |
| `usual_amount` | DECIMAL(10,2) | Last amount saved, or owner-set. |
| `pinned` | BOOLEAN DEFAULT FALSE | |
| `pin_order` | INTEGER | Lower comes first. |
| `last_given_to_user_id` | INTEGER REFERENCES users(id) ON DELETE SET NULL | Pre-fills "Given to". |
| `last_given_to_name` | VARCHAR(80) | Pre-fills a free name. |
| `merged_into` | INTEGER REFERENCES expense_items(id) ON DELETE SET NULL | Set when merged. Never chained (see 5.6). |
| `is_active` | BOOLEAN DEFAULT TRUE | Hidden items are not suggested. |
| `created_by` | INTEGER REFERENCES users(id) ON DELETE SET NULL | |
| `created_at`, `updated_at` | TIMESTAMP DEFAULT CURRENT_TIMESTAMP | |

The list is shared by all shops; "frequent" suggestions are counted per shop.

### 4.2 New columns on `expenses`

| Column | Type | Notes |
|---|---|---|
| `item_id` | INTEGER REFERENCES expense_items(id) ON DELETE SET NULL | NULL on old rows. |
| `note` | TEXT | Optional. |
| `photo_url` | TEXT | Optional. A path from `POST /api/upload`. |
| `given_to_user_id` | INTEGER REFERENCES users(id) ON DELETE SET NULL | Optional. |
| `given_to_name` | VARCHAR(80) | Optional free name, for someone outside the staff list. |

Indexes:

- `idx_expenses_item_date ON expenses(item_id, expense_date)`;
- `idx_expenses_location_date ON expenses(location_id, expense_date)`, if not already present;
- `idx_expenses_given_to ON expenses(given_to_user_id)`.

Rules:

- `description` keeps being written as the item name, plus `" — " + note` when there is a note. Existing reports, the payroll link and older app versions read it unchanged.
- `employee_id` keeps its current meaning (the salary link) and is **not** reused for "Given to".
- At most one of `given_to_user_id` / `given_to_name` is set.

### 4.3 Nothing else changes

- No new settings. Pins live on items.
- Old rows are not rewritten except by the owner's explicit "Sort into items" confirmation (5.7).

## 5. Server

New code uses the async DB layer (`database-async.js`). Every write that moves cash uses the existing money-transaction helper from PR #30 with the register row locked, and keeps PR #37's behaviour: the drawer moves only by the difference, and a closed session's discrepancy is worked out again. Every write is audited.

### 5.1 Item resolution: `server/utils/expense-items.js`

- `nameKey(name)`: normalises a name as in 4.1.
- `resolveItem(db, { item_id, item_name, category, userId })` returns the live item:
  1. With `item_id`, it loads that item and follows `merged_into` one step.
  2. Otherwise it looks up by `name_key` and follows `merged_into`. If there's no match, it creates the item with `category` (required for a new name, else 400 "Pick what kind of expense this is.").
  3. A hidden (`is_active = false`) item is still accepted when named, and is made active again.
- After a save, `usual_amount`, `last_given_to_*` and `updated_at` on the item are updated.

### 5.2 `POST /api/expenses` (extended)

- New body fields: `item_id` | `item_name`, `note`, `photo_url`, `given_to_user_id` | `given_to_name`.
- `expense_date` other than today: owner and manager only. Others get 403 "Only the owner or a manager can enter an expense for another day."
- `category` defaults to the item's category. A salary entry still needs `employee_id`, with the existing checks.
- Old clients sending only `description` keep working; the row is saved with no item.
- Validation:
  - `given_to_user_id` must be active staff or a delivery partner linked to the shop, or the owner. Otherwise 400 "That person can't be picked here. Tap Given to and pick again."
  - `photo_url` must be a local `/uploads/` path.

### 5.3 `PUT /api/expenses/:id` and `DELETE /api/expenses/:id` (extended)

- PR #37's permission rules are unchanged.
- `PUT` also accepts item, note, photo and Given to.
- Owner and manager may change `expense_date`. The cash stays with the register session that paid it (`register_id` unchanged); only the date moves.

### 5.4 `GET /api/expenses/suggest?location_id=&q=`

- Roles: owner, manager, employee, counter_staff.
- With an empty `q`: pinned items by `pin_order`, then this shop's most used active items in the last 30 days (not already pinned), up to 8 in total.
- With `q`: active, unmerged items whose `name_key` contains `q`. Prefix matches come first, then by use in the last 30 days at this shop. Up to 8.
- Each result has `id`, `name`, `category`, `usual_amount` and `last_given_to: { user_id, name, display_name }`.

### 5.5 Lists and history

- **`GET /api/expenses`** (extended): adds the filters `item_id`, `created_by`, `given_to_user_id` and `q` (description or item name). Each row also carries `item_name`, `note`, `photo_url`, a display name for Given to, and the name of the person who added it.
  - Employee and counter_staff: forced to their own shop(s) and `expense_date >= today − 6` (shop-local). Wider ranges are silently clamped. The response carries `limited_to_days: 7`.
  - Owner and manager: any range. A list call is capped at 500 rows and returns `truncated: true` when more exist.
- **`GET /api/expenses/summary-by-item?from=&to=&location_id=`** (owner, manager):
  - Returns the total, then categories, each with its items.
  - Each line has `amount`, `previous_amount` and `change_pct`. The previous period is the same number of days immediately before `from`. `change_pct` is null when `previous_amount` is 0, and the app shows "new".
  - Returns (`is_return`) count as negative.
  - Rows with no item go under an `older` group, keyed by category.
  - `location_id` may be omitted for all shops.
- **`GET /api/expenses/items/:id/history?months=6&from=&to=&location_id=&given_to_user_id=`** (owner, manager): month totals for the last N months (shop-local months), plus the item's entries between `from` and `to`. An item that other items were merged into includes their entries.
- **`GET /api/expenses/people?location_id=`** (owner, manager, employee, counter_staff): the "Given to" chips. Returns active staff (owner, manager, employee, counter_staff, florist_staff) and delivery partners linked to the shop, with id, name and role only.
  - **Design note:** this replaces the chat proposal of widening `/auth/staff-roster`. That route is unauthenticated because the lock screen calls it before login, so adding riders there would publish their names. The new route needs a login.

### 5.6 Owner item tools (owner only)

- `GET /api/expenses/items?q=&include_hidden=`
- `PUT /api/expenses/items/:id`:
  - change `name` (400 if the new `name_key` already exists: "There is already an item called X. Merge them instead.");
  - change `category` with `move_past: boolean`. When true, it updates `expenses.category` for that item's past rows, audited `expense_item_recategorise`. Salary rows are never moved: neither into nor out of `salary`;
  - set `usual_amount`, `pinned`, `pin_order`, `is_active`.
- `PUT /api/expenses/items/pins` with `{ ids: [...] }`: sets the pin order in one step.
- `POST /api/expenses/items/:id/merge` with `{ into_id }`, as one transaction:
  1. refuse merging into itself, an already-merged item, or a hidden item;
  2. move `expenses.item_id` from the source to the target;
  3. point any items already merged into the source at the target, so `merged_into` never chains;
  4. set the source's `merged_into` and `is_active = false`;
  5. audit `expense_item_merge` with the moved count.

  It does not change `category` or `description` on moved rows.

### 5.7 Sort old entries into items (owner only)

- `GET /api/expenses/unsorted?limit=50`: rows with `item_id IS NULL` and `category <> 'salary'`, each with a suggested item. The suggestion is an exact `name_key` match on the description, else the item whose `name_key` is a prefix of the description's `name_key`, else none.
- `POST /api/expenses/assign-items` with `{ assignments: [{ expense_id, item_id | item_name }] }`: sets `item_id` only (not amount, date, category or description), in one transaction, audited `expense_assign_items`. Rows that already have an item are skipped and reported.

### 5.8 Roles summary

| Action | owner | manager | employee / counter_staff | florist, rider, helper, customer |
|---|---|---|---|---|
| Add | ✓ | ✓ | ✓ (today only) | — |
| Last 7 days list | ✓ | ✓ | ✓ (own shop) | — |
| Change/Remove | any | any | own, today, register open | — |
| History, summary, item history | ✓ | ✓ | — | — |
| Items: pin, rename, merge, sort old | ✓ | — | — | — |

Helpers stay default-denied. No expense route goes in `HELPER_ROUTES`.

### 5.9 Errors (plain language)

- No item name: "Type what this was for, like Petrol."
- No amount: "Type how much was paid."
- Cash with the register closed: the existing register-guard message plus the Open Register action, as at checkout.
- Staff changing an older entry: PR #37's DAY_CLOSED_MESSAGE.

## 6. App

Run `staff-ux-checklist` and `app-ui-quality` on every screen below. Use `showAlert` / `showConfirm`; never `Alert.alert`. Wrap every create/save in `useSubmitGuard`.

### 6.1 `AddExpenseSheet` (new shared component)

Opened from the Quick Checkout header (replacing the current Add expense modal), Cash Register, the Expenses screen and the dashboard.

```
┌ Add expense ───────────────────────────┐
│ [Petrol ₹200] [Tea ₹60] [Roses–Ramesh  │  suggestion chips (5.4, empty q)
│  ₹1,500] [Auto ₹50] [Electricity] …    │
│ What was it for?  [ pe|            ]   │  type-ahead list under the box
│ Amount  [ ₹ 200 ]   (Cash) ( UPI )     │
│ Given to: Raju ▸                       │  remembered per item; optional
│ + Note   📷 Bill photo                 │  optional
│ Date: Today ▸                          │  owner/manager only
│ [            Save ₹200            ]    │
│ Money coming back? Record a return     │
└────────────────────────────────────────┘
```

- Tapping a suggestion fills the name, category, usual amount and Given to, and puts focus on Amount.
- A new name shows the 8 category chips once.
- Cash is chosen when the register is open. When it's closed, Cash is disabled with "Open the register to pay cash" and an Open Register button (the existing `OpenRegisterSheet`), and UPI is chosen.
- "Given to" opens big chips from `GET /expenses/people`, plus "Someone else" (free name) and "Nobody / not sure" (clears it).
- Bill photo uses the existing image pick/capture and `POST /api/upload`. If the upload fails, Save still works and shows "Photo didn't upload — saved without it. Tap the expense to add it again."
- After Save: a toast "Saved ₹200 Petrol", the sheet closes, and the list refreshes.
- Salary category keeps its existing employee picker. Pieces 2 and 3 will reshape it.

### 6.2 `ExpensesScreen` (counter staff, employee)

- Day chips: Today, Yesterday, then dates for the 5 days before. Today is selected.
- Each row shows the item (or description), amount, Cash/UPI, Given to, added by, and 📷 when there is a photo.
- **Change** appears only on the person's own entries for today. Tapping it opens the sheet in change mode with "Remove this expense" inside, as in PR #37.
- The Add expense button sits at the top.

### 6.3 `ExpensesScreen` (owner, manager)

- Period chips: Today · This week · This month (default) · Last month · Pick dates. Shop chips include "All shops" and default to the device's shop.
- Header: the total and ▲/▼ % vs the period before.
- Categories in large type, each with its item lines (amount, ▲/▼ or "new"). The "Older entries" group comes last.
- Banner when unsorted entries exist (owner only): "N older entries have no item — Sort them".
- "See all entries" opens the filtered list (date, category, item, added by, Given to, Cash/UPI) with the total at the top.

### 6.4 `ExpenseItemScreen` (new; owner, manager)

- A strip of the last 6 months' totals, with the current month highlighted.
- Entries in the chosen period, filterable by Given to, each with **Change**.
- Owner only: edit item (name, category with "Also move past entries", usual amount, pin, hide) and **Merge into…** (search, then a confirm naming both items and the number of entries).

### 6.5 `ExpenseItemsScreen` (new; owner)

Reached from the Expenses screen and Settings.

- Pinned items with up/down and unpin buttons, using the same pattern as `QuickSaleTilesScreen`.
- All items with search, each opening `ExpenseItemScreen`.

### 6.6 `SortExpensesScreen` (new; owner)

- Old entries, 50 at a time, each with its suggested item (✓ to accept) or "Pick item".
- "Save N" confirms. Nothing changes until then.

### 6.7 Navigation

- Register the new screens in the stacks that already hold `ExpensesScreen`.
- Settings gets an "Expense items" row for the owner.

## 7. Edge cases

- **Same name with different case or spaces:** one item, via `name_key`.
- **Typos:** stay separate until merged. A merged name typed later resolves to the item it was merged into.
- **Hidden item:** not suggested; its history still counts. Typing its exact name brings it back.
- **Date move on a cash expense:** `register_id` is unchanged, so session totals don't move.
- **Amount change on cash:** the drawer moves by the difference (PR #37 logic). A closed session's discrepancy is worked out again.
- **Item category change:** future entries only, unless "Also move past entries" is ticked.
- **Salary rows:** keep all existing rules; never offered for sorting or recategorising.
- **Returns:** negative in totals and comparisons.
- **No earlier data:** "new" instead of a percentage.
- **Shop-local dates:** day, week and month boundaries use Asia/Kolkata via the existing `utils/time.js` helpers. `expense_date` is a DATE, so it's compared directly.
- **Two people adding the same new name at once:** the unique `name_key` makes one insert fail. Retry by looking it up again (`ON CONFLICT (name_key) DO NOTHING`, then select).
- **Given to someone who later leaves:** the name stays on old rows. They drop out of the chips once inactive.

## 8. Testing

**New server suite, `server/scripts/verify-expense-book.js`:**

- item create and match by `name_key`; merge resolution on later saves;
- suggestion order: pins, then per-shop frequent, then type-ahead ranking; hidden and merged items excluded;
- summary totals and `previous_amount` / `change_pct` against hand-worked fixtures, including returns, the older group and "all shops";
- item history month totals, and that merged entries are included;
- the merge transaction: moved count, no chaining, refusals;
- the 7-day staff clamp, the owner/manager-only routes, owner-only item tools, and 403s for helper, rider and customer;
- Given to: validation, saved, filtered, remembered on the item;
- PUT date move keeps `register_id`; PUT amount moves the drawer by the difference;
- "Sort into items" sets only `item_id` and skips already-sorted rows;
- an old client posting `description` only still works.

Tests open and close only their own registers and clean up their own rows.

**Existing suites:** re-run all of them, especially `verify-register-expenses.js`, `verify-cash-safety.js` and `verify-helpers.js`.

**App script `app/scripts/test-expense-book.js`:** suggestion merging and order, the "vs before" display (▲/▼/new), and the period date ranges.

**On screen (desktop web):**

- As counter staff: Petrol in 3 taps; Given to remembered; Cash disabled with the register closed; the 7-day list; changing their own entry.
- As the E2E owner: summary, item screen, merge, pins, sort old entries, a back-dated entry.

**Not checked (to list in the PR):** 375 px width, a real phone camera, the native app.

## 9. Out of scope (pieces 2 and 3)

- Salary, advance and other staff payments as expense types tied into payroll and advances (piece 2).
- Rider km pay, petrol deduction and the rider balance (piece 3). Piece 1 only records Given to.
- Quantity and unit per expense; owner-editable categories; budgets and alerts; export.

## 10. Deploy

- Server before the app. The schema additions run on boot.
- Old app versions keep working (description-only adds; today's list).
