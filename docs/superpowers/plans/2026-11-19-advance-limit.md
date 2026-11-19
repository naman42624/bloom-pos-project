# Per-person advance limit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner sets a monthly advance limit per person on the salary card. When a counter advance would go over it, an approval PIN is needed, and no one but the owner ever sees the limit. This also closes the gap where the over-limit message let counter staff work out a coworker's advances.

**Architecture:**
- One additive column, `employee_salaries.advance_limit`.
- A pure change to `needsPin` in `server/utils/staff-money.js`: the person's limit replaces the shop monthly limit.
- One new owner-only route to set the limit.
- `GET /staff/salaries` no longer returns the limit to non-owners.
- All advance "needs PIN" answers become one generic `over_limit` reason, with copy that names no amount.
- The app gets the field on the owner's salary form and accepts the new reason.

**Tech Stack:** Express + pg via the async layer (`config/database-async.js`), Expo/React Native web.

**Spec:** `docs/superpowers/specs/2026-11-16-staff-pay-account-design.md`. That file lives on branch `feature/staff-pay-account`; read it with `git show feature/staff-pay-account:docs/superpowers/specs/2026-11-16-staff-pay-account-design.md`. The relevant parts:
- §12, PR 3;
- §8, first bullet;
- §13, items 4 and 8;
- §6.1's table row "Salary card": staff see their own card "salary + leaves, not the limit".

## Global Constraints

- Schema is additive only: `ensureColumn('employee_salaries', 'advance_limit', 'NUMERIC(10,2)')`, NULL = no personal limit. Never DROP or RENAME.
- Use the async DB layer for all new or touched route code. No apostrophes inside `--` SQL comments.
- **Limits** (§13.4):
  - The person's `advance_limit`, when set, replaces the shop `advance_monthly_limit` for that person's advances.
  - The shop `advance_daily_limit` still applies to everyone.
  - A person with no limit falls back to the shop monthly limit.
  - The month window is the shop-local calendar month, as `sm.totals` uses today. PR 4 moves it to the pay cycle.
- **Visibility** (§8, §13.8):
  - The advance limit is shown to the owner only. Managers and staff never receive it in any response, their own row included.
  - The counter's needs-PIN copy never shows a limit, salary or total.
- Exact copy, used verbatim on server and app:
  - `OVER_LIMIT_MESSAGE` = `This needs an OK from a manager or the owner. They can confirm with their PIN.`
  - `LIMIT_INPUT_MESSAGE` = `Type the monthly advance limit in rupees, or leave it empty to use the shop limit.`
  - `LIMIT_NO_SALARY_MESSAGE` = `Set a salary for this person first, then their advance limit.`
- Errors shown to staff are plain language. In app code, use only showAlert/showConfirm.
- Shopping money is unchanged: it keeps reason `over_day` and its daily-limit copy, which names the shop amount.
- Tests use throwaway users only, created and removed by the test itself, following `verify-staff-money.js` `makeUser`. Never use real users or reset real PINs. Refuse to run unless DATABASE_URL is local.

## Review Focus

1. **A personal limit set higher than the shop monthly limit.** An advance above the shop limit but within the person's limit goes through without a PIN, while the daily limit still applies (§13.4: the owner's explicit choice wins). Test: Task 1 "higher personal limit".
2. **A personal limit of 0.** Every advance to that person needs a PIN. Test: Task 1 "limit 0".
3. **A manager reading their own salary row** (`GET /staff/salaries`) gets no `advance_limit` key. Test: Task 2.
4. **Two advances sent at once near the limit.** The recheck inside the transaction uses the same personal limit, so both cannot pass. Covered by reusing `lockAndRecheck`; Task 1 asserts that the recheck path reads the personal limit (unit on `reasonFor`'s inputs via the route).
5. **The over-limit answer carries no amount.** Over the day limit and over the month limit give identical bodies: same `needs_pin`, same message. Test: Task 1 "day and month identical".

---

### Task 1: Server — personal limit in the PIN check, generic over-limit answer

**Files:**
- Modify: `server/config/database.js` (add the `ensureColumn` next to the other `employee_salaries`/`salary_advances` patches)
- Modify: `server/utils/staff-money.js`
- Modify: `server/routes/staff-money.js` (`prepareGive`)
- Modify: `server/scripts/verify-staff-money.js` (advance reason/copy assertions now expect `over_limit` and the generic message; shopping assertions unchanged)
- Create: `server/scripts/verify-advance-limit.js`

**Interfaces:**
- Produces:
  - `sm.personAdvanceLimit(db, userId) -> Promise<number|null>`: reads `employee_salaries.advance_limit` and returns null when there is no row or the value is NULL.
  - `sm.needsPin({ giver, recipientId, kind, amount, totals, limits, personLimit })`: the existing signature plus an optional `personLimit` (number|null). For `kind === 'advance'`, the monthly cap is `personLimit ?? limits.advanceMonth`. It still returns `'self' | 'over_day' | 'over_month' | null` (the internal detail stays).
  - `sm.publicReason(reason, kind) -> string`: returns `'over_limit'` for kind advance when the reason is `over_day` or `over_month`; otherwise the reason unchanged.
  - `sm.needsPinMessage('over_limit')` returns `OVER_LIMIT_MESSAGE`.
  - `sm.OVER_LIMIT_MESSAGE` is exported.

- [ ] **Step 1: Write failing unit checks** in `verify-advance-limit.js`, pure part:
  - `needsPin` with `limits.advanceMonth 2000`, `personLimit 5000`, `advanceMonth total 1900`, amount 400, day total 0, `advanceDay 500` → `null` (higher personal limit).
  - Same with `personLimit 1000` → `'over_month'`.
  - `personLimit 0`, amount 1 → `'over_month'` (limit 0).
  - `personLimit null` falls back to 2000.
  - Shopping ignores `personLimit`.
  - `publicReason('over_day','advance')` gives `'over_limit'`; `publicReason('over_day','shopping')` gives `'over_day'`; `publicReason('self','advance')` gives `'self'`.
  - `needsPinMessage('over_limit')` equals OVER_LIMIT_MESSAGE.
- [ ] **Step 2: Write failing live checks.** Live API on API_BASE_URL with throwaway users at Test Loc 4: an owner, a manager with PIN, counter staff, and a recipient with an `employee_salaries` row. Read the shop limits with `sm.getLimits` and the recipient's month total with `sm.totals`. Then:
  - Set the personal limit by SQL to `monthTotal + 300`. A UPI advance of 200 from counter returns 201. A further 200 returns 409 with body `needs_pin === 'over_limit'`, message === OVER_LIMIT_MESSAGE, and the message contains no digit.
  - The same request with the manager's approver_id/PIN returns 201.
  - **Day and month identical:** a give over the daily limit only, and one over the month limit only, return identical `{ needs_pin, message }`.
  - **Higher personal limit:** with the limit set to shop monthly + 1000 and a fresh recipient, gives that add up past the shop monthly limit go through without a PIN. Keep each give at or under the daily limit; the daily limit is per day, so split the gives across the days already counted, or set `advance_daily_limit` high for the run and restore it after.
  - **Limit 0:** a give of 1 returns 409 `over_limit`.
  - **NULL limit:** a give over the shop monthly limit returns 409 `over_limit`.
  - Clean up only what the run created.
- [ ] **Step 3: Run it, and confirm the new checks fail.** `node server/scripts/verify-advance-limit.js` (after `source test-env.sh`).
- [ ] **Step 4: Implement.**
  - Add the column patch.
  - Add `personAdvanceLimit`, `publicReason`, the `personLimit` param, the message and the export.
  - In `prepareGive`, `reasonFor` fetches the person limit (kind advance only) through the same handle it is given, so the in-transaction recheck reads it under the lock.
  - `needsPinError` sends `needs_pin: sm.publicReason(reason, kind)` and the message for that public reason.
- [ ] **Step 5: Update `verify-staff-money.js`.** Its advance needs-PIN assertions (route reasons and `needsPinMessage` copy for advances) now expect `over_limit` and OVER_LIMIT_MESSAGE. Unit `needsPin` assertions keep `over_day`/`over_month`.
- [ ] **Step 6: Run** `verify-advance-limit.js`, `verify-staff-money.js`, `verify-expense-book.js` and `verify-register-expenses.js`. All must pass.
- [ ] **Step 7: Commit** `feat(staff-money): per-person advance limit; over-limit answer names no amount`.

### Task 2: Server — owner sets the limit; nobody else sees it

**Files:**
- Modify: `server/routes/staff-management.js`
- Modify: `server/scripts/verify-advance-limit.js` (add checks)

**Interfaces:**
- Consumes: the column from Task 1.
- Produces: `PUT /api/staff/salaries/:userId/advance-limit`, `authorize('owner')`, async.
  - Body: `{ advance_limit: number | null }`. `null`, `''` or a missing value clears the limit.
  - Returns `{ success, data: { user_id, advance_limit } }`, where `advance_limit` is a number or null.
  - Validation: a number ≥ 0 and ≤ 10000000 with at most 2 decimals. Anything else gives 400 LIMIT_INPUT_MESSAGE.
  - No `employee_salaries` row for that user gives 400 LIMIT_NO_SALARY_MESSAGE.
  - Writes `audit_logs` with entity_type `employee_salary`, entity_id = user id, action `advance_limit_set`, and previous/new `{ advance_limit }`.
  - Updates `updated_by`/`updated_at` only. No `salary_history` row, since the salary did not change.

- [ ] **Step 1: Write failing checks:**
  - The owner sets 3000 and gets back 3000; the DB holds 3000; an audit row exists.
  - The owner clears it with null and the DB holds NULL.
  - Values `-1`, `'abc'` and `1.234` each return 400 with LIMIT_INPUT_MESSAGE.
  - A user with no salary row returns 400 with LIMIT_NO_SALARY_MESSAGE.
  - Manager and counter get 403.
  - `GET /api/staff/salaries` as the recipient (their own row) has no `advance_limit` key, even when one is set.
  - The owner's GET rows include `advance_limit`.
- [ ] **Step 2: Run, and confirm they fail.**
- [ ] **Step 3: Implement the route, and strip the key from every non-owner response.** Strip `advance_limit` from every non-owner `GET /staff/salaries` response, and from any other route in `staff-management.js` that returns `employee_salaries` columns to a non-owner. Grep `es.\*` and `FROM employee_salaries`; payroll routes that are already owner-only can stay as they are.
- [ ] **Step 4: Run** `verify-advance-limit.js` and `verify-staff-money.js`; both must pass.
- [ ] **Step 5: Commit** `feat(staff): owner sets a per-person advance limit; hidden from everyone else`.

### Task 3: App — limit on the owner's salary form; counter accepts `over_limit`

**Files:**
- Modify: `app/src/utils/staffMoney.js`
- Modify: `app/src/services/api.js`
- Modify: `app/src/screens/SalaryManagementScreen.js`
- Modify: `app/scripts/test-staff-money.js`
- Modify: `CLAUDE.md` (one bullet under the staff pay work, or under sub-project 4 if none exists on `main`)

**Interfaces:**
- Consumes: the route from Task 2 and the `over_limit` reason from Task 1.
- Produces:
  - `needsPinOf(err)` also accepts `'over_limit'`.
  - `pinMessage('over_limit')` returns OVER_LIMIT_MESSAGE.
  - `parseLimitInput(text) -> { ok: true, value: number|null } | { ok: false }`: empty or whitespace gives `{ok:true,value:null}`; a number ≥ 0 with at most 2 decimals gives its value; anything else gives `{ok:false}`.
  - `api.setAdvanceLimit(userId, advanceLimit)` → `PUT /staff/salaries/:userId/advance-limit`.

- [ ] **Step 1: Write failing tests** in `test-staff-money.js`:
  - `needsPinOf({status:409, body:{needs_pin:'over_limit'}})` returns `'over_limit'`.
  - `pinMessage('over_limit')` equals OVER_LIMIT_MESSAGE.
  - `parseLimitInput` cases: `''`→null; `'  '`→null; `'2000'`→2000; `'0'`→0; `'1.5'`→1.5; `'-5'`, `'abc'` and `'1.234'` give not ok.
- [ ] **Step 2: Run** `node app/scripts/test-staff-money.js` and confirm it fails.
- [ ] **Step 3: Implement the helpers and the api method.**
- [ ] **Step 4: Add the field to the salary form.** In SalaryManagementScreen's owner salary modal, add a "Monthly advance limit" field:
  - numeric keyboard, placeholder `Shop limit`;
  - helper line `Leave empty to use the shop limit. Above this, an advance needs a manager or owner PIN.`;
  - pre-filled from `existing.advance_limit`.
  
  On Save:
  - Validate with `parseLimitInput`. If it fails, show showAlert with LIMIT_INPUT_MESSAGE and save nothing.
  - Then save the salary as today.
  - Then, only if the parsed value differs from the pre-filled one, call `api.setAdvanceLimit`. If that call fails, show showAlert with title `Salary saved` and the server message, and the modal stays open.
  
  The owner's staff card shows a line `Advance limit ₹X a month` when the limit is set, and nothing when it isn't.
- [ ] **Step 5: Run** the app tests, then babel-transform every touched app file (`node -e "require('@babel/core').transformFileSync(f,{presets:['babel-preset-expo']})"`).
- [ ] **Step 6: Commit** `feat(app): advance limit on the salary card; counter handles over_limit`.

**Tap count:**
- The owner sets a limit in 3 taps plus typing: tap the person, type, Save.
- A counter advance under the limit is unchanged.
- Over the limit, it is unchanged too: the same PIN box as today, with new copy.
