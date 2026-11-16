# Pay visibility (PR 1: who sees what) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nobody sees another person's salary, payroll or advances unless the owner allowed it: managers only for employees the owner switches on for them (view only), all other staff only their own.

**Architecture:** One helper (`server/utils/pay-access.js`) answers "whose pay may this person see"; every route that reads pay data uses it. A new additive table `pay_viewers` holds the owner's per-manager choices. One live-API test (`verify-pay-access.js`) calls every pay route as every role.

**Tech Stack:** Express, PostgreSQL via `config/database-async.js`, Expo / React Native.

**Spec:** `docs/superpowers/specs/2026-11-16-staff-pay-account-design.md` — §6, §12 row 1, §13 item 8.

**Branch:** `feature/pay-visibility`, off `origin/main`. Its own PR; depends on no other pay PR.

## Global Constraints

- Schema changes are additive only (`CREATE TABLE IF NOT EXISTS`, in `server/config/database.js`); read the `db-migration-safety` skill first.
- New and touched server code uses the async DB layer (`config/database-async.js`). No apostrophes inside `--` SQL comments.
- App dialogs use `showAlert` / `showConfirm` only, never `Alert.alert`.
- Error copy is plain language and says what to do next.
- Test data is named `VerifyPA`; the test refuses to run unless `DATABASE_URL` is local, and deletes only rows it created.
- Never run `verify-gst-sales.js`. Never print tokens.
- Owner: sees and sets everything (unchanged).
- Manager: sees pay of **own + employees in `pay_viewers` for them**; view only. Off by default (no rows = sees only own).
- Counter / employee / florist / rider / helper: own pay only. Other people's Salary expense rows show as title **"Staff pay"**, amount kept, no name / note / photo / item. Salary total left out of their summaries.
- §13.8: a manager may still approve an over-limit advance or a pending request for staff linked to their shop, seeing only the amount; `unpaid_after` is returned only to callers who may see that person's pay.

## Review Focus

1. A manager searching Expenses by a hidden person's name finds nothing (search must not reveal hidden salary rows) — Task 3 test.
2. Old Salary expenses with `employee_id` NULL are hidden from managers and counted out of a manager's salary total — Task 3 test.
3. A manager who is also the employee: always sees own salary, payroll, advances — Task 2 test.
4. An owner switching a manager's list off takes effect on the next request (no caching) — Task 1 test.
5. A not-allowed manager giving an advance gets no `unpaid_after` and the app shows no "unpaid" line rather than "₹0" — Task 4 test.

---

### Task 1: `pay_viewers`, the access helper, owner routes

**Files:**
- Modify: `server/config/database.js` (add table next to the other staff tables in `ensureCoreTables`)
- Create: `server/utils/pay-access.js`
- Modify: `server/routes/staff-management.js` (two routes)
- Create: `server/scripts/verify-pay-access.js`

**Interfaces:**
- Produces: table `pay_viewers (id SERIAL PK, manager_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, employee_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_by INT REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE(manager_id, employee_id))`.
- Produces: `async payVisibleIds(db, viewer) -> 'all' | number[]` (owner → `'all'`; manager → `[own id, ...pay_viewers.employee_id]`; anyone else → `[own id]`). `async canSeePay(db, viewer, employeeId) -> boolean`. `salarySqlFilter(visible, alias = 'e') -> { sql: string, params: number[] }` — `''` for `'all'`, else ` AND (${alias}.category <> 'salary' OR ${alias}.employee_id IN (?,...))`. Top-of-file comment: "Every route that returns salary, payroll or advance data must use this file, and must be added to the route list in scripts/verify-pay-access.js."
- Produces: `GET /api/staff/pay-viewers/:managerId` → `{ data: { employee_ids: number[] } }`; `PUT /api/staff/pay-viewers/:managerId` body `{ employee_ids: number[] }` replaces the set (one transaction, audited `pay_viewers_set` in `audit_logs`). Both `authorize('owner')`; 400 "Pick a manager." if the user is not an active manager; ids must be active staff (roles manager, employee, counter_staff, florist_staff, delivery_partner, helper), else 400 "One of those people can't be picked. Refresh and try again."

- [ ] **Step 1: Write the failing checks** in `verify-pay-access.js` (same shape as `verify-staff-money.js`: `check(name, fn)`, `api(method, path, userId, body)` with `jwt.sign({ id })`, `makeUser`, cleanup): table exists; `payVisibleIds` for owner = `'all'`, for a VerifyPA manager with no rows = `[managerId]`, after `PUT .../pay-viewers/:m {employee_ids:[e1]}` = `[m, e1]`, after `PUT ... {employee_ids:[]}` = `[m]` (Review Focus 4); PUT as a manager → 403; PUT with a customer id → 400.
- [ ] **Step 2:** Run `source $SP/test-env.sh >/dev/null; node server/scripts/verify-pay-access.js` against a server started with this branch → the new checks FAIL.
- [ ] **Step 3:** Implement table, helper, routes.
- [ ] **Step 4:** Restart the API, re-run → PASS.
- [ ] **Step 5:** Commit `feat(pay): pay_viewers and the pay access helper`.

### Task 2: Salary, payroll history and advance routes

**Files:**
- Modify: `server/routes/staff-management.js` — `GET /salaries`, `GET /payroll/history`
- Modify: `server/routes/attendance.js` — `GET /salary-advances`, `PUT /salary-advance/:id/repay`, `PUT /salary-advance/:id/:action`
- Test: `server/scripts/verify-pay-access.js`

**Interfaces:**
- Consumes: `payVisibleIds`, `canSeePay` (Task 1).
- `GET /salaries` for a manager: `{ salary: own | null, salaries: [rows for allowed people, same columns as the owner list] }`. Others unchanged (`{ salary }`).
- `GET /payroll/history`: manager may pass `user_id` only if `canSeePay`, else 403 "You can't see this person's pay. Ask the owner."; no `user_id` → own.
- `GET /salary-advances` for a manager: rows where `user_id` is visible, **plus** `status = 'pending'` rows of staff linked (`user_locations`) to a shop the manager is linked to (§13.8). Other staff roles unchanged (own).
- `repay`: manager only if `canSeePay` (else 403, same copy). `approve`/`reject`: manager only for staff linked to one of their shops (else 403 "This person isn't at your shop.").

- [ ] **Step 1: Failing checks:** VerifyPA owner O, managers MA (allowed E1) and MB (none), employees E1, E2 at Test Loc with salaries ₹7,311 / ₹8,423 (distinct figures to grep for) and one approved advance each. Assert: MA's `/salaries` contains 7311 and not 8423; MB's contains neither; counter's contains neither; MA `/payroll/history?user_id=E2` → 403; MA `/salary-advances` lists E1's advance, not E2's approved one, but does list E2's **pending** request; MB `repay` E1's advance → 403; a manager reading own salary/advances works (Review Focus 3).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS; also `verify-staff-money.js` and `verify-expense-book.js` stay green.
- [ ] **Step 5:** Commit `feat(pay): managers see salary and advances only for allowed staff`.

### Task 3: Expenses — list, search, summaries, edits

**Files:**
- Modify: `server/routes/expenses.js` — `GET /`, `GET /summary`, `sumByItem` / `GET /summary-by-item`, `GET /items/:id/history`, `POST /`, `PUT /:id`, `DELETE /:id`, `hideSalaryNames`
- Test: `server/scripts/verify-pay-access.js`

**Interfaces:**
- Consumes: `payVisibleIds`, `salarySqlFilter`, `canSeePay`.
- `hideSalaryNames(row, visible)` hides when `visible !== 'all'` and the row is salary and `employee_id` not in `visible` (NULL counts as not visible — Review Focus 2); hidden rows get `description: 'Staff pay'` (was `'Salary advance'`), other fields nulled as today. Applied to managers too.
- Search / `employee_id` / `given_to_user_id` filters: the existing non-boss guard uses `salarySqlFilter` for every non-owner (Review Focus 1).
- `GET /summary`: owner unchanged; manager adds `salarySqlFilter`; other roles add `AND category <> 'salary'`.
- `sumByItem` and `/items/:id/history` take the viewer and add `salarySqlFilter` for managers.
- `PUT` / `DELETE` of a salary row a manager can't see → 404 with the existing not-found copy. `POST` a Salary expense by a manager for someone they can't see → 403 "You can't pay this person's salary. Ask the owner."

- [ ] **Step 1: Failing checks:** VerifyPA salary expenses for E1 (₹7,311), E2 (₹8,423) and one with `employee_id` NULL (₹6,197). MA list: E1 row named, E2 and NULL rows titled "Staff pay" with no name; MA search `q=<E2 name>` returns no salary row; MA `/summary` salary total = 7311; MB salary total absent or 0; counter `/summary` has no `salary` category; counter list shows E2 row as "Staff pay" with amount 8423 and no name; MA `PUT` E2 row → 404; MA `POST` salary for E2 → 403, for E1 → 201 (then cleaned up); MA `/summary-by-item` salary amount = 7311.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS; `verify-expense-book.js`, `verify-staff-money.js`, `verify-rider-km.js` green.
- [ ] **Step 5:** Commit `feat(pay): salary rows and totals hidden from those who may not see them`.

### Task 4: Advance figures at the counter, the app, and the full role sweep

**Files:**
- Modify: `server/routes/staff-money.js` — `unpaid_after` only when `canSeePay(giver, recipient)`
- Modify: `server/routes/staff-management.js` — `GET /api/staff/pay-access` → `{ data: { all: boolean, ids: number[] } }` (any staff role; their own visibility)
- Modify: `app/src/services/api.js` — `getPayAccess()`, `getPayViewers(managerId)`, `setPayViewers(managerId, employeeIds)`
- Modify: `app/src/components/expenses/MoneyToStaffForm.js` — the "unpaid" line for another person only when `getPayAccess()` says visible (Review Focus 5)
- Modify: `app/src/components/expenses/AddExpenseSheet.js:~1030` — `canRead` uses `getPayAccess()`
- Modify: `app/src/screens/UserFormScreen.js` — owner editing a manager: section "Can see pay of" with one switch per active staff member at the manager's shops, saved with `setPayViewers`; plain help line "Off: they can't see this person's salary, payroll or advances."
- Modify: `app/src/screens/AttendanceHubScreen.js:41` and `app/src/screens/SalaryManagementScreen.js` — a manager with at least one allowed person (`getPayAccess().ids.length > 1`) sees "Salaries & Payroll" **read-only**: the salary list and each person's payment history from `GET /salaries` / `GET /payroll/history`; no Set salary, Calculate or Pay buttons (those routes stay owner-only on the server).
- Test: `server/scripts/verify-pay-access.js`

- [ ] **Step 1: Failing checks:** MB gives E2 an advance via `POST /staff-money/advance` → response has no `unpaid_after`; MA gives E1 one → has it. Then the **role sweep**: a `ROUTES` array in the test (every pay-reading route from Tasks 1–3 plus `/staff-money/mine`, `/staff-money/people`, `/expenses/people`, `/expenses/suggest`, `/staff/pay-access`) called as owner, MA, MB, counter, florist, rider, helper; assert no response body of MB / counter / florist / rider / helper contains `8423` or `7311` unless it is that caller's own salary, and MA's bodies never contain `8423`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement server, then app. Babel-check every touched app file (`node -e "require('@babel/core').transformFileSync(f,{presets:['babel-preset-expo'],babelrc:false,configFile:false})"` from `app/`).
- [ ] **Step 4:** Run → PASS; run `$SP/run-all-nogst.sh` (all suites except GST) → green.
- [ ] **Step 5:** On screen at 375 px (owner login): manager profile → switch E1 on → saved after reload; as that manager, Salaries & Payroll / Advances / Expenses show E1 and not E2; as counter, Expenses shows other salary rows as "Staff pay".
- [ ] **Step 6:** Commit `feat(pay): owner picks whose pay each manager sees`; add a CLAUDE.md roadmap note ("pay visibility: every pay route uses utils/pay-access.js and must be in verify-pay-access.js").
