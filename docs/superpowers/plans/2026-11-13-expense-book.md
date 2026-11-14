# Expense Book Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn expenses into a searchable book with named items, quick suggestions, "Given to", history and period comparisons, and owner tools for items.

**Architecture:**
- **Server:** a new `expense_items` table plus additive columns on `expenses`. A small `server/utils/expense-items.js` resolves names to items. The new routes live in `server/routes/expenses.js`, with read-side maths in `server/utils/expense-book.js`.
- **App:** one shared `AddExpenseSheet`, a role-split `ExpensesScreen`, and three new owner/manager screens. Pure display maths sits in `app/src/utils/expenseBook.js`.

**Tech Stack:** Express, `pg` through `database-async.js` (`getDb`, `withMoneyTx`), express-validator; Expo / React Native / React Navigation.

**Spec:** `docs/superpowers/specs/2026-11-13-expense-book-design.md`. Section numbers below (§) refer to it.

## Global Constraints

- **Schema:**
  - Additive only, in `server/config/database.js` (`CREATE TABLE IF NOT EXISTS`, `ensureColumn`, `CREATE INDEX IF NOT EXISTS`).
  - Read the `db-migration-safety` skill first.
  - Never put an apostrophe in a `--` SQL comment.
- **DB layer:** new code uses the async layer. Cash-moving writes run in `withMoneyTx` and lock the register with `lockOpenRegister`, reusing PR #37's `drawerEffect`, `moveDrawer`, `loadForChange` and `auditExpense` in `server/routes/expenses.js`.
- **Data rules:**
  - `employee_id` keeps its salary meaning and is never used for Given to.
  - `description` is still written as the item name, plus `" — " + note` when there is a note.
  - Salary rows are never sorted into items or recategorised.
- **Roles (§5.8):**
  - Add: owner, manager, employee, counter_staff.
  - History, summary and item history: owner and manager.
  - Item tools and sorting: owner only.
  - Helpers are default-denied, so nothing is added to `HELPER_ROUTES`.
- **Dates:** shop-local via `server/utils/time.js` (`todayStr`). `expense_date` is a DATE.
- **Exact copy:**
  - "Type what this was for, like Petrol."
  - "Type how much was paid."
  - "Pick what kind of expense this is."
  - "Only the owner or a manager can enter an expense for another day."
  - "That person can't be picked here. Tap Given to and pick again."
  - "There is already an item called {name}. Merge them instead."
  - "Open the register to pay cash"
  - "Photo didn't upload — saved without it. Tap the expense to add it again."
  - "{N} older entries have no item — Sort them"
- **App rules:** `showAlert` / `showConfirm` / `appAlert` only, never `Alert.alert`. Every save goes through `useSubmitGuard`. Run the `staff-ux-checklist` and `app-ui-quality` skills on each screen task.
- **Tests:** suites open and close only registers they opened (`scripts/lib/verify-harness.js` `assertOwnRegister`, `refuseIfRegisterOpen`) and delete their own rows. Use the E2E owner login, never the real owner.
- **Commits:** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push without asking.

## Review Focus

1. **Two counters type the same new name at the same moment.** Expected: one item, both expenses on it (`ON CONFLICT (name_key) DO NOTHING`, then select). Tested in Task 1.
2. **A cash expense is back-dated by the owner after its session closed.** Expected: `register_id` and every session total stay unchanged. Tested in Task 2.
3. **A merge target is itself merged later (A→B, then B→C).** Expected: A's and B's entries and names all resolve to C, and `merged_into` never points at a merged item. Tested in Task 6.
4. **Staff ask the list for 30 days, or for another shop.** Expected: clamped to 7 days at their own shops, with `limited_to_days: 7`, no error. Tested in Task 4.
5. **A period with returns and no earlier spend.** Expected: returns subtract, and `change_pct` is null (shown as "new"), never Infinity or NaN. Tested in Task 5 (server) and Task 8 (app).

---

### Task 1: Schema and item resolution

**Files:**
- Modify: `server/config/database.js` (after the existing `expenses` ensureColumn block, around the `register_id` patch)
- Create: `server/utils/expense-items.js`
- Create: `server/scripts/verify-expense-book.js` (suite skeleton plus the first checks)

**Interfaces:**
- Produces:
  - `nameKey(name: string) -> string`: trim, lower-case, squeeze internal whitespace to one space, cut to 80 characters.
  - `resolveItem(db, { item_id?, item_name?, category?, userId }) -> Promise<item row>`, as in §5.1. It throws `{ statusCode: 400, message }` with the exact copy. It follows `merged_into` one step and makes a hidden item active again.
  - `rememberOnItem(db, itemId, { amount, given_to_user_id, given_to_name }) -> Promise<void>`: sets `usual_amount`, `last_given_to_*` and `updated_at`.

- [ ] **Step 1: Add the schema (§4.1, §4.2).** Create the `expense_items` table. Add the `expenses` columns `item_id`, `note`, `photo_url`, `given_to_user_id` and `given_to_name`. Add the three indexes. Restart the API and check with `psql "$DATABASE_URL" -c '\d expense_items'` that the table exists with `name_key` unique.
- [ ] **Step 2: Write the failing checks** in `verify-expense-book.js`. Copy the harness shape from `verify-register-expenses.js` (`api()`, `check()`, an owner login read from the `VERIFY_OWNER_PHONE` / `VERIFY_OWNER_PASSWORD` env vars, and cleanup in `finally`). The checks call the util directly through `getDb()`:
  - `nameKey('  Petrol  Pump ') === 'petrol pump'`;
  - `resolveItem` with `item_name: 'VerifyEB Petrol', category: 'transport'` creates the item, and `'verifyeb  petrol'` returns the same `id`;
  - a new name without `category` rejects with 400 "Pick what kind of expense this is.";
  - two parallel `resolveItem` calls for one new name return the same `id` (Review Focus 1);
  - with item B's `merged_into = A`, resolving B's name returns A;
  - a hidden item resolved by name comes back with `is_active = true`.

  Cleanup deletes items whose name starts with `VerifyEB`.
- [ ] **Step 3: Run** `node scripts/verify-expense-book.js`. Expected: FAIL (module not found).
- [ ] **Step 4: Implement `server/utils/expense-items.js`.** Insert with `ON CONFLICT (name_key) DO NOTHING`, then `SELECT`.
- [ ] **Step 5: Run the suite.** Expected: all Task 1 checks pass.
- [ ] **Step 6: Commit** with `feat(expenses): expense_items table and item resolution`.

### Task 2: Add and change with items, note, photo, Given to and back-dating

**Files:**
- Modify: `server/routes/expenses.js`: `POST /` (around line 111) and `PUT /:id` (around line 326)
- Create: the people list route in the same file, `GET /people`, registered **before** `/:id`
- Test: `server/scripts/verify-expense-book.js`

**Interfaces:**
- Consumes: `resolveItem` and `rememberOnItem` from Task 1.
- Produces:
  - `POST /api/expenses` and `PUT /api/expenses/:id` accept `item_id | item_name`, `note`, `photo_url`, `given_to_user_id | given_to_name`, plus `expense_date` (owner and manager only). Responses include `item_id`, `item_name`, `note`, `photo_url`, `given_to_user_id`, `given_to_name` and `given_to_display`.
  - `GET /api/expenses/people?location_id=` returns `[{ id, name, role }]`, as in §5.5.
  - `assertGivenTo(db, userId, locationId)` lives in `server/utils/expense-items.js`. It allows active owner, manager, employee, counter_staff, florist_staff or delivery_partner users linked to the shop (owner anywhere). Otherwise it throws 400 with the exact copy.

- [ ] **Step 1: Write the failing checks:**
  - **counter_staff** (JWT minted for the E2E counter user, as the existing suites do):
    - POST `{ item_name:'VerifyEB Tea', category:'food', amount:60, payment_method:'upi' }` returns 201 with `item_name` 'VerifyEB Tea' and `description` 'VerifyEB Tea';
    - POST again with `item_name:'verifyeb tea'` reuses the `item_id`;
    - a note gives `description` 'VerifyEB Tea — for Sharma wedding';
  - POST with `given_to_user_id` set to a rider at the test shop saves it, and `item.last_given_to_user_id` equals that rider;
  - a customer's id gets 400 with the exact copy;
  - POST with both `given_to_user_id` and `given_to_name` keeps only the user id;
  - counter_staff POST with `expense_date` = yesterday gets 403 with the exact copy; the owner gets 201;
  - a description-only POST (old client) returns 201 with `item_id` null;
  - `photo_url:'https://evil.example/x.png'` gets 400; `'/uploads/x.png'` is accepted;
  - **Review Focus 2:**
    - the owner opens a test register and adds a ₹100 cash expense, then closes the register;
    - the owner PUTs `expense_date` to 3 days ago;
    - the row keeps the same `register_id`, and that register's `expected_cash` and discrepancy are unchanged;
  - `GET /people` as counter_staff includes the test rider, excludes customers, and returns only `id`, `name` and `role`; as a helper it gets 403.
- [ ] **Step 2: Run.** Expected: the new checks FAIL.
- [ ] **Step 3: Implement.**
  - In POST and PUT, resolve the item before the money transaction (it's an ordinary write), then insert or update inside the existing `withMoneyTx` path.
  - `category` defaults to the item's category.
  - Keep the salary `employee_id` checks as they are.
  - A date move must not change `register_id` or call `moveDrawer`; only an amount or method change moves the drawer (existing #37 logic).
  - Call `rememberOnItem` after commit.
- [ ] **Step 4: Run** the new suite plus `node scripts/verify-register-expenses.js`. Expected: all pass.
- [ ] **Step 5: Commit** with `feat(expenses): items, note, photo, given to and back-dating on add/change`.

### Task 3: Suggestions

**Files:**
- Modify: `server/routes/expenses.js` (new `GET /suggest`, before `/:id`)
- Test: `server/scripts/verify-expense-book.js`

**Interfaces:**
- Produces: `GET /api/expenses/suggest?location_id=&q=` returns `[{ id, name, category, usual_amount, last_given_to: { user_id, name, display_name } | null }]`, at most 8.

- [ ] **Step 1: Write the failing checks.** Fixture: items P1 and P2 pinned with `pin_order` 2 and 1; item F used 3 times at the test shop in the last 30 days; item G used 5 times only at another shop; item H hidden; item M merged.
  - Empty `q` at the test shop: the first two results are P2 then P1, F comes next, and G, H and M are absent.
  - `q='verifyeb pe'`: prefix matches come before contains matches, and none are hidden or merged.
  - No more than 8 results.
- [ ] **Step 2: Run.** Expected: FAIL (404).
- [ ] **Step 3: Implement** with two queries: pinned, then the top items by `COUNT(*)` from `expenses` where `location_id = ?` and `expense_date >= today − 29`, excluding pinned ones. Search orders by `(name_key LIKE q||'%') DESC`, then 30-day use.
- [ ] **Step 4: Run.** Expected: pass.
- [ ] **Step 5: Commit** with `feat(expenses): quick suggestions and type-ahead`.

### Task 4: List filters and the staff 7-day limit

**Files:**
- Modify: `server/routes/expenses.js` `GET /` (around line 55)
- Test: `server/scripts/verify-expense-book.js`

**Interfaces:**
- Produces: `GET /api/expenses`:
  - filters: `item_id`, `created_by`, `given_to_user_id` and `q`;
  - row fields: `item_name`, `note`, `photo_url`, `given_to_display` and `created_by_name`;
  - response: `limited_to_days: 7` for staff; `truncated: true` past 500 rows for owner and manager.

- [ ] **Step 1: Write the failing checks (Review Focus 4):**
  - counter_staff asks for `start_date` = today − 30: every row has `expense_date >= today − 6`, and `limited_to_days === 7`;
  - counter_staff asks with `location_id` = another shop they aren't linked to: rows only from their own shops, no error;
  - the owner with the same 30-day range gets an older back-dated fixture row;
  - the `item_id` and `given_to_user_id` filters each return only matching rows;
  - `q='sharma'` finds the note row.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** with `LEFT JOIN expense_items` and `users` for the display names. Staff shops come from the same user-location link the register routes use.
- [ ] **Step 4: Run** the new suite and `verify-register-expenses.js`. Expected: pass.
- [ ] **Step 5: Commit** with `feat(expenses): history filters and 7-day staff limit`.

### Task 5: Period summary and item history

**Files:**
- Create: `server/utils/expense-book.js`
- Modify: `server/routes/expenses.js` (new `GET /summary-by-item` and `GET /items/:id/history`, before `/:id`)
- Test: `server/scripts/verify-expense-book.js`

**Interfaces:**
- Produces:
  - `previousRange(from: 'YYYY-MM-DD', to: 'YYYY-MM-DD') -> { from, to }`: the same number of days, ending the day before `from`.
  - `changePct(amount: number, previous: number) -> number | null`: null when `previous` is 0; otherwise rounded to 1 decimal.
  - `signedAmount` SQL: `CASE WHEN is_return THEN -amount ELSE amount END`.
  - `GET /api/expenses/summary-by-item?from=&to=&location_id=` (owner, manager) returns:
    - `{ total, previous_total, change_pct, categories: [{ category, amount, previous_amount, change_pct, items: [{ item_id, name, amount, previous_amount, change_pct }] }], older: [{ category, amount, count }], unsorted_count }`;
    - categories sorted by amount, descending.
  - `GET /api/expenses/items/:id/history?months=6&from=&to=&location_id=&given_to_user_id=` (owner, manager) returns:
    - `{ item, months: [{ month: 'YYYY-MM', amount }], entries: [...list row shape from Task 4] }`;
    - entries include items merged into this item.

- [ ] **Step 1: Write the failing checks:**
  - `previousRange('2026-11-01','2026-11-13')` gives `{ from:'2026-10-19', to:'2026-10-31' }`;
  - `changePct(110,100) === 10`;
  - `changePct(50,0) === null`.
  - Fixtures at the test shop, for item X:
    - ₹300 cash and a ₹50 return (`is_return`) dated this period;
    - ₹200 dated in the previous period;
    - a ₹40 description-only row this period.
  - Summary over the period gives X `amount` 250, `previous_amount` 200, `change_pct` 25, and the ₹40 row appears under `older` (Review Focus 5).
  - An item with only this-period spend has `change_pct` null.
  - The total equals the sum of categories plus the older group.
  - Item history for 6 months has 6 entries in `months` and includes a merged item's row.
  - counter_staff gets 403 on both routes.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** with one grouped query per range, `GROUP BY category, item_id`, merged in JavaScript. Without `location_id`, it covers all shops.
- [ ] **Step 4: Run.** Expected: pass.
- [ ] **Step 5: Commit** with `feat(expenses): period summary vs previous period and item history`.

### Task 6: Owner item tools

**Files:**
- Modify: `server/routes/expenses.js`, adding these routes before `/:id`:
  - `GET /items`;
  - `PUT /items/pins`;
  - `PUT /items/:id`;
  - `POST /items/:id/merge`.
- Test: `server/scripts/verify-expense-book.js`

**Interfaces:**
- Produces the four routes in §5.6. All are `authorize('owner')`. Audit actions: `expense_item_update`, `expense_item_recategorise` and `expense_item_merge`.

- [ ] **Step 1: Write the failing checks:**
  - renaming to an existing name gives 400 "There is already an item called VerifyEB Tea. Merge them instead.";
  - a category change without `move_past` leaves past rows' category unchanged; with `move_past: true` they change, and an audit row exists;
  - salary rows are untouched, and moving to or from `salary` gives 400;
  - `PUT /items/pins { ids:[b,a] }` makes the suggest order b, a;
  - merge A→B moves A's expenses to B, sets A `merged_into = B` and `is_active = false`, and returns `moved` equal to the count;
  - **Review Focus 3:** merge B→C afterwards leaves A's `merged_into` = C and every expense on C; resolving A's name returns C;
  - merging into itself, into a merged item, or into a hidden item each give 400;
  - a manager gets 403 on every one of the four routes.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Merge runs in one transaction (`withMoneyTx` is fine; no register lock is needed). Step 3 of §5.6 is `UPDATE expense_items SET merged_into = :into WHERE merged_into = :source`.
- [ ] **Step 4: Run.** Expected: pass.
- [ ] **Step 5: Commit** with `feat(expenses): owner item tools — rename, pin, recategorise, merge`.

### Task 7: Sort old entries into items

**Files:**
- Modify: `server/routes/expenses.js` (new `GET /unsorted` and `POST /assign-items`, owner only, before `/:id`)
- Test: `server/scripts/verify-expense-book.js`

**Interfaces:**
- Produces:
  - `GET /api/expenses/unsorted?limit=50` returns `[{ ...list row, suggested_item: { id, name } | null }]`. Rows have no item and are not salary, newest first.
  - `POST /api/expenses/assign-items { assignments: [{ expense_id, item_id | item_name, category? }] }` returns `{ assigned, skipped: [expense_id] }`.

- [ ] **Step 1: Write the failing checks:**
  - a description-only row "verifyeb petrol" gets the suggestion VerifyEB Petrol (exact key);
  - "VerifyEB Petrol Nov" gets the prefix suggestion VerifyEB Petrol;
  - salary rows never appear;
  - assigning sets `item_id` while amount, date, category, description and `register_id` stay unchanged;
  - an already-assigned row is reported in `skipped`;
  - an audit row `expense_assign_items` exists;
  - a manager gets 403.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** The suggestion is matched in JavaScript against active items, longest prefix wins.
- [ ] **Step 4: Run the whole server regression**:
  - `verify-expense-book.js`
  - `verify-register-expenses.js`
  - `verify-cash-safety.js`
  - `verify-order-flows.js`
  - `verify-helpers.js`
  - `verify-helper-bags.js`
  - `verify-quick-sale.js`
  - `verify-staff-sales.js`

  Use the env from the scratchpad `run-all.sh` and `TRACKING_LINK_SECRET`. Expected: all green.
- [ ] **Step 5: Commit** with `feat(expenses): sort old entries into items`.

### Task 8: App API and pure display maths

**Files:**
- Modify: `app/src/services/api.js`, next to `createExpense` (around line 826)
- Create: `app/src/utils/expenseBook.js`
- Create: `app/scripts/test-expense-book.js`, following `test-quick-sale.js`'s babel-loader pattern

**Interfaces:**
- Produces:
  - **API methods:**
    - `getExpenseSuggestions(params)`;
    - `getExpensePeople(locationId)`;
    - `getExpenseSummaryByItem(params)`;
    - `getExpenseItemHistory(id, params)`;
    - `getExpenseItems(params)`;
    - `updateExpenseItem(id, data)`;
    - `setExpenseItemPins(ids)`;
    - `mergeExpenseItem(id, intoId)`;
    - `getUnsortedExpenses(params)`;
    - `assignExpenseItems(assignments)`.
  - **Pure helpers in `expenseBook.js`:**
    - `periodRange(key: 'today'|'week'|'month'|'last_month', todayStr: 'YYYY-MM-DD') -> { from, to }`. The week starts on Monday.
    - `changeLabel(pct: number|null) -> { text: '▲ 12%' | '▼ 4%' | 'new' | '—', tone: 'up'|'down'|'new'|'flat' }`. A `pct` of 0 gives '—' / 'flat'.
    - `lastSevenDays(todayStr) -> [{ date, label }]`, labelled 'Today', 'Yesterday', then 'Mon 10 Nov'.
    - `givenToText(row) -> string | null`.

- [ ] **Step 1: Write the failing tests:**
  - `periodRange('month','2026-11-13')` gives `{from:'2026-11-01',to:'2026-11-13'}`;
  - `periodRange('last_month','2026-11-13')` gives `{from:'2026-10-01',to:'2026-10-31'}`;
  - `periodRange('week','2026-11-13')` gives a `from` of '2026-11-10';
  - `changeLabel(null).text === 'new'` (Review Focus 5);
  - `changeLabel(12.4).text === '▲ 12%'`;
  - `changeLabel(-4).tone === 'down'`;
  - `lastSevenDays('2026-11-13')` has length 7 and starts with 'Today', then 'Yesterday';
  - `givenToText({ given_to_display:'Raju' }) === 'given to Raju'`;
  - with no Given to, the result is null.
- [ ] **Step 2: Run** `node scripts/test-expense-book.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the helpers and the API methods (each one a thin `this.request` call).
- [ ] **Step 4: Run.** Expected: all pass.
- [ ] **Step 5: Commit** with `feat(expenses-app): api methods and display helpers`.

### Task 9: AddExpenseSheet and its entry points

**Files:**
- Create: `app/src/components/expenses/AddExpenseSheet.js`
- Create: `app/src/components/expenses/GivenToPicker.js`
- Modify:
  - `app/src/screens/ExpensesScreen.js`: replace the existing add/change modal with the sheet, keeping the PR #37 change-mode behaviour and "Remove this expense";
  - `app/src/screens/QuickCheckoutScreen.js` (around line 109) and `app/src/screens/DashboardScreen.js` (around line 2491): keep navigating to `Expenses` with `{ openAdd: true }`, which opens the sheet.

**Interfaces:**
- Consumes: the Task 8 API methods; the existing `OpenRegisterSheet`, `useSubmitGuard`, `api.uploadGenericImage(formData)` (as used in `SettingsScreen.js` around line 245), and `expo-image-picker`.
- Produces: `<AddExpenseSheet visible locationId registerOpen expense? onClose onSaved />`. With `expense` set, it's in change mode. `<GivenToPicker locationId value onChange />`, where value is `{ user_id, name, display_name } | null`.

- [ ] **Step 1: Build the sheet as in §6.1.**
  - The suggestion chips load on open.
  - Typing debounces at 250 ms against suggest.
  - A suggestion tap fills name, category, `usual_amount` and Given to, then focuses Amount.
  - A new name shows the 8 category chips.
  - With the register closed, Cash is disabled with "Open the register to pay cash", an Open Register button appears, and UPI is chosen.
  - The Date row appears for owner and manager only.
  - A photo upload failure still saves and shows the exact copy.
  - Save goes through `useSubmitGuard`, then shows a toast "Saved ₹{amount} {name}".
  - A salary category keeps the existing employee picker.
- [ ] **Step 2: Wire it into ExpensesScreen**, so that `openAdd` opens it and Change opens it in change mode.
- [ ] **Step 3: Babel check** with `node scripts/babel-check.js src/components/expenses/AddExpenseSheet.js src/components/expenses/GivenToPicker.js src/screens/ExpensesScreen.js`. Expected: clean.
- [ ] **Step 4: Check on screen** (Expo web on port 8082, restarted), as E2E counter staff:
  - Quick Checkout → Add expense → a "Petrol" suggestion → Save is 3 taps;
  - the next Petrol pre-fills Given to;
  - with the register closed, Cash is disabled with the copy.

  Then run the `staff-ux-checklist` skill and fix what it finds.
- [ ] **Step 5: Commit** with `feat(expenses-app): add-expense sheet with suggestions and Given to`.

### Task 10: ExpensesScreen: staff 7 days and owner/manager summary

**Files:**
- Modify: `app/src/screens/ExpensesScreen.js` (split into two views; move the owner view into `app/src/components/expenses/ExpenseSummaryView.js` so the screen file doesn't grow)
- Create: `app/src/components/expenses/ExpenseRow.js` (one row, used by both views and by Task 11)

**Interfaces:**
- Consumes: `periodRange`, `changeLabel`, `lastSevenDays` and `givenToText` (Task 8); `getExpenses`; `getExpenseSummaryByItem`.
- Produces:
  - `<ExpenseRow expense canChange onChange />`;
  - a navigation to `ExpenseItem` with `{ itemId, from, to, locationId }`;
  - a navigation to `SortExpenses`.

- [ ] **Step 1: Build the staff view (§6.2):**
  - day chips from `lastSevenDays`;
  - rows through `ExpenseRow`;
  - Change only where `created_by === me`, the date is today and the register is open.
- [ ] **Step 2: Build the owner/manager view (§6.3):**
  - period chips with a date-range pick;
  - shop chips with "All shops";
  - the header total with `changeLabel`;
  - category blocks with item lines, then the older group;
  - the unsorted banner (owner only, when `unsorted_count > 0`);
  - "See all entries", which shows the Task 4 list with filters.
- [ ] **Step 3: Babel check** the touched files. Expected: clean.
- [ ] **Step 4: Check on screen** as the E2E owner (This month and Last month totals match `summary-by-item`, ▲/▼/new shown) and as counter staff (7 day chips, read-only older rows). Run `app-ui-quality`.
- [ ] **Step 5: Commit** with `feat(expenses-app): 7-day staff list and owner period summary`.

### Task 11: Item, items and sort screens

**Files:**
- Create:
  - `app/src/screens/ExpenseItemScreen.js`;
  - `app/src/screens/ExpenseItemsScreen.js`;
  - `app/src/screens/SortExpensesScreen.js`.
- Modify:
  - `app/src/navigation/MainNavigator.js`: register all three in every stack that has `Expenses` (lines around 401, 421, 449 and 564);
  - `app/src/screens/SettingsScreen.js`: an owner-only "Expense items" row.

**Interfaces:**
- Consumes: the Task 8 API methods; `ExpenseRow` and `AddExpenseSheet` in change mode.

- [ ] **Step 1: Build `ExpenseItemScreen` (§6.4):**
  - the 6-month strip (plain bars, current month highlighted);
  - entries with a Given to filter;
  - owner-only edit (with the "Also move past entries" switch);
  - Merge into…, with a `showConfirm` that names both items and the entry count.
- [ ] **Step 2: Build `ExpenseItemsScreen` (§6.5):**
  - pinned items with up/down/unpin, following `QuickSaleTilesScreen`'s pattern, saved through `setExpenseItemPins`;
  - a searchable list of all items.
- [ ] **Step 3: Build `SortExpensesScreen` (§6.6):**
  - ✓ accepts a suggestion; "Pick item" uses the suggest search;
  - "Save N" calls `assignExpenseItems` and reloads the next 50.
- [ ] **Step 4: Babel check** the touched files, restart Expo, and check on screen as the E2E owner: pin order shows in the add sheet; merge two test items; sort one old entry; a back-dated entry appears in Last month.
- [ ] **Step 5: Commit** with `feat(expenses-app): item history, owner item tools and sorting old entries`.

### Task 12: Final regression and record

**Files:**
- Modify: `CLAUDE.md` (roadmap, under sub-project 3, as a new "Continuation — expense book" bullet that covers what was built, tests, not checked and deploy, in the same style as the existing entries)

- [ ] **Step 1: Run** every server suite listed in Task 7 Step 4, plus `verify-gst.js`, `verify-identity-roles.js`, `verify-order-requests.js`, `verify-slip-and-open-requests.js` and `verify-labels-scanner.js`, and every `app/scripts/test-*.js`. Expected: all green. Record the counts.
- [ ] **Step 2: Write the CLAUDE.md entry.** Include:
  - Not checked: 375 px width, a real phone camera, the native app.
  - Deploy: server before the app.
- [ ] **Step 3: Commit** with `docs: expense book shipped`. Ask the user before pushing or opening a PR.
