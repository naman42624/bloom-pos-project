# Rider km account Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Riders' meter readings, gaps, km pay and settlement (net of petrol, supply money, cash COD and the last carry) in the app, with the petrol cost right in the expense book and only real cash moving the drawer.

**Architecture:**
- A pure chain module (`server/utils/rider-km.js`) turns a rider's readings, gap answers and rates into work/home/gap stretches and money. It is never stored as running totals.
- A new route file (`server/routes/rider-km.js`, mounted at `/api/rider-km`) handles readings, gaps, corrections, rate, preview/commit settlement, and the rider's own view.
- Settlement is one money transaction that marks petrol, COD and shopping money lines as covered. It writes one petrol expense row (`km_account`) and moves the drawer only by cash paid or taken.
- The app adds a Km reading form inside the Add expense sheet, a settle screen, rider lines on the Shopping money out card, the rider's My money block, and owner settings.

**Tech Stack:** Express + `pg` via `database-async.js` (`getDb`, `withMoneyTx`), additive patches in `server/config/database.js`; Expo/React Native (React Navigation stacks in `app/src/navigation/MainNavigator.js`).

**Spec:** `docs/superpowers/specs/2026-11-15-rider-km-account-design.md`

## Global Constraints

- Schema is additive only (new tables/columns via `database.js` patches; `ensureColumn`). Existing expense, shopping money, owes and COD rows are never rewritten except to set the new link columns and the statuses the existing flows already use.
- No apostrophes inside `--` SQL comments (`bindParams` footgun). Use the async layer only.
- Every money write runs in `withMoneyTx`. Lock order: rider advisory lock (`pg_advisory_xact_lock(7304, riderId)`) first, then the open register row (`lockOpenRegister`), then delivery / `staff_money_out` rows `FOR UPDATE`. Never take the rider lock after a register lock.
- All amounts are compared and summed in whole paise (`toPaise`).
- App dialogs: `showAlert` / `showConfirm` only, never `Alert.alert`. Every write button is wrapped with `useSubmitGuard`.
- Copy is plain and says what to do next. Use these exact strings:
  - `"The meter can't go down. Check the number, or tap Type km instead."`
  - `"Is {meter} right? That is {km} km of work."`
  - `"Pick the rider from the list so it counts against their km."`
  - `"A rider's own petrol is covered by their km pay — no need to add it."`
  - `"Answer the gaps first, then settle."`
  - `"Something changed — check the figures again."`
  - `"Open the register to pay cash — or pick UPI."`
  - `"Open the register to take cash — or pick UPI."`
  - `"L has no going-home reading — Add now"` (with the rider's first name)
  - `"{Name} has km not settled — Settle km first"`
- Names on screen:
  - **Km reading**, **Arriving**, **Going home**, **Type km instead**, **For another day**;
  - **Settle km**, **Pay {Name} ₹X**, **Carry ₹X to next time**, **Take some now**, **Take from salary**;
  - **Paid to {Name}'s own UPI**, **Rider petrol**, **Km rate**, **Usual home ride**, **My km money**.
- Thresholds:
  - a gap is a home stretch over 2× usual, or over 30 km when there is no usual;
  - the usual is the median of the last 10 home stretches;
  - a work stretch over 300 km asks to confirm;
  - counter staff can go back to 7 days or the last settlement (whichever is later);
  - Km rate default ₹3.
- Roles: readings, gap answers and settling are allowed for `owner`, `manager`, `employee`, `counter_staff`; corrections for owner/manager; Km rate and the Rider petrol flag for owner; Usual home ride for owner/manager; the rider (`delivery_partner`) reads only their own data. Every other role gets 403.
- Deploy the server before the app.

## Review Focus

1. **A backdated reading dropped inside an already-settled range** must be refused ("That day is already settled. Ask the owner or a manager to add a correction."), never re-open old money. → Task 2 test.
2. **Two counters saving the same reading** (same rider, kind and meter within 2 minutes) must keep one row, not two. → Task 2 test.
3. **A settlement while the register is closed** must refuse cash pay/take with the Open Register copy, but still allow UPI and Carry. → Task 3 test.
4. **A rate changed with a past effective date** must only change unsettled stretches; a settled amount never moves. → Task 3 test.
5. **A COD settled with `settle-now` and a km settlement at the same moment** must settle that COD once. The loser either excludes it or gets the "Something changed" 409. → Task 3 test.

---

## File Structure

| File | Responsibility |
|---|---|
| `server/config/database.js` (modify) | New tables and columns (Task 1). |
| `server/utils/rider-km.js` (create) | Pure chain + money maths. No DB. |
| `server/utils/rider-km-data.js` (create) | DB readers: readings, answers, rates, account start, the open items for a settlement (petrol, COD, shopping money, carry). |
| `server/routes/rider-km.js` (create) | All `/api/rider-km` routes. |
| `server/server.js` (modify) | Mount the route. |
| `server/utils/register-close.js` (modify) | Km cash in/out per register session. |
| `server/routes/staff-management.js`, `server/utils/staff-money.js` (modify) | Payroll: rider carried balance, Settle km first. |
| `server/routes/expenses.js` (modify) | `is_rider_petrol` on items; typed-name refusal for Rider petrol items. |
| `server/scripts/test-rider-km-chain.js` (create) | Plain-node tests of the pure module. |
| `server/scripts/verify-rider-km.js` (create) | Live API suite (same harness style as `verify-staff-money.js`). |
| `app/src/services/api.js` (modify) | Client methods. |
| `app/src/utils/riderKm.js` (create) | Pure display helpers (stretch labels, money line text). |
| `app/src/components/expenses/KmReadingForm.js` (create) | The Km reading form inside the Add expense sheet. |
| `app/src/components/expenses/AddExpenseSheet.js` (modify) | Third link "Km reading". |
| `app/src/screens/RiderKmScreen.js` (create) | Chain, gap answers, corrections and the settle sheet for one rider. |
| `app/src/components/expenses/ShoppingMoneyCard.js` (modify) | Rider lines → RiderKm. |
| `app/src/screens/ProfileScreen.js` (modify) | Rider's My km money. |
| `app/src/screens/SettingsScreen.js`, `ExpenseItemScreen.js`, `CashRegisterScreen.js`, `SalaryManagementScreen.js` (modify) | Km rate; Rider petrol switch; close reminder; payroll line. |
| `app/src/navigation/MainNavigator.js` (modify) | Register `RiderKm` in every stack that has `Expenses`. |
| `CLAUDE.md` (modify) | Roadmap entry. |

---

### Task 1: Schema and the pure chain module

**Files:**
- Modify: `server/config/database.js` (after the staff money block, near the `staff_money_out` / `shop_owes` tables)
- Create: `server/utils/rider-km.js`
- Test: `server/scripts/test-rider-km-chain.js`

**Interfaces:**
- Produces, tables:
  - `rider_km_readings(id, user_id, location_id, kind VARCHAR(10) CHECK (kind IN ('arrive','leave','typed')), meter DECIMAL(10,1) NULL, typed_km DECIMAL(10,1) NULL, read_at TIMESTAMP NOT NULL, note TEXT, created_by, created_at, settlement_id INTEGER NULL, removed_at TIMESTAMP NULL, removed_by)`
  - `rider_km_gap_answers(id, user_id, from_reading_id, to_reading_id, answer VARCHAR(10) CHECK (answer IN ('typed','none')), work_km DECIMAL(10,1), answered_by, created_at, settlement_id NULL)` — unique on `(from_reading_id, to_reading_id)`. The "add missed readings" answer is just new readings; no row.
  - `rider_km_corrections(id, user_id, km DECIMAL(10,1) NOT NULL, note TEXT NOT NULL, for_date DATE, created_by, created_at, settlement_id NULL)`
  - `rider_km_rates(id, rate DECIMAL(10,2) NOT NULL, effective_from DATE NOT NULL, set_by, created_at)`, seeded once with `(3, '2000-01-01')` if empty.
  - `rider_km_settlements(id, user_id, location_id, cutoff_reading_id, paid_km DECIMAL(10,1), km_amount, petrol_book, petrol_taken, carried_in, supply_held, cod_held, net_amount, action VARCHAR(10) CHECK (action IN ('pay','carry','take','salary','zero')), moved_amount, moved_method VARCHAR(10), register_id NULL, carry_out, expense_id NULL, upi_own_delivery_ids TEXT, lines_json JSONB, created_by, created_at, salary_payment_id NULL)` — all money `DECIMAL(10,2)`.
- Produces, columns:
  - `expense_items.is_rider_petrol BOOLEAN DEFAULT FALSE`, with a one-time backfill to TRUE where `LOWER(REGEXP_REPLACE(name,'\s+','','g')) = 'petrol'`, guarded by a settings key `rider_petrol_backfilled`;
  - `users.km_usual_home_ride DECIMAL(10,1)`;
  - `deliveries.km_settlement_id`;
  - `expenses.km_settlement_id`;
  - `staff_money_out.km_settlement_id`.
- Produces, indexes: `rider_km_readings(user_id, read_at)`, `rider_km_settlements(user_id, id)`, `rider_km_settlements(register_id)`.
- Produces `server/utils/rider-km.js`:
  - `buildChain(readings, answers, { usualHomeKm }) -> { stretches, openDay, usualHomeKm }`. `readings` are sorted by `read_at`, `id`, with removed ones excluded. Each stretch is `{ kind: 'work'|'home'|'gap'|'typed', fromId, toId, km, endAt, answer|null, reason: 'missed_leave'|'missed_arrive'|'long_home'|null }`. `openDay` is true when the last reading is `arrive`.
  - `usualHome(stretches) -> number|null`: the median km of the last 10 `home` stretches, or null when there are none.
  - `rateOn(rates, dateStr) -> number`: the latest `effective_from <= dateStr`.
  - `priceStretches(stretches, rates, corrections) -> { paidKm, amountPaise, byRate: [{ rate, km, amountPaise }] }`. Work, typed, and answered gap stretches (`work_km`) are paid. The rate applies on the shop-local date of `endAt`; for corrections it is `for_date`, or the created day.
  - `netPaise({ kmPaise, petrolTakenPaise, carriedInPaise, supplyHeldPaise, codHeldPaise }) -> number` = km − petrol taken + carried − supply − COD.

- [ ] **Step 1: Write failing tests in `test-rider-km-chain.js`** (`node:assert`, the same runner shape as `app/scripts/test-expense-book.js`):
  - `in-out-in-out`: readings arrive 12340, leave 12386, arrive 12398, leave 12430, arrive 12436, leave 12470 → work km [46, 32, 34], home km [12, 6], paid 112.
  - `missed leave`: arrive 12340 then arrive 12700 → one gap, reason `missed_leave`, km 360.
  - `missed arrive`: leave 12386 then leave 12500 → gap `missed_arrive`.
  - `long home`: home stretches of 10, 12, 11 (so usual 11), then a home stretch of 314 → gap `long_home`. With no usual, a home stretch of 31 is a gap and 30 is not.
  - `answered gap`: the same gap with answer `{answer:'typed', work_km: 200}` → paid includes 200; with answer `none` → 0.
  - `typed km`: a typed reading of 40 is paid 40 and breaks the chain (the next meter reading is not compared to anything before it).
  - `rate change`: two work stretches ending 9 Nov and 11 Nov, rates `[{3,'2000-01-01'},{4,'2026-11-10'}]` → byRate `[{3,…},{4,…}]`, and amountPaise is the exact sum.
  - `corrections`: +10 km on 11 Nov at rate 4 → +4000 paise.
  - `net`: `netPaise({kmPaise:33600, petrolTakenPaise:20000, carriedInPaise:-4000, supplyHeldPaise:10000, codHeldPaise:50000})` → −50400.
  - `openDay` is true when the last reading is `arrive`.

- [ ] **Step 2: Run** `node server/scripts/test-rider-km-chain.js`. Expected: fails (module missing).
- [ ] **Step 3: Implement** `server/utils/rider-km.js` (pure, no requires except `../utils/time` for the shop-local date). Add the schema in `database.js`, following the staff money block's `runPsql` / `ensureColumn` style.
- [ ] **Step 4: Run** the test file (all pass), then restart the dev server and confirm boot: `psql bloomcart -Atc "select count(*) from rider_km_rates"` gives 1.
- [ ] **Step 5: Commit** `feat(rider-km): tables and chain maths`.

### Task 2: Readings, gaps, corrections, rate and the account view

**Files:**
- Create: `server/utils/rider-km-data.js`, `server/routes/rider-km.js`, `server/scripts/verify-rider-km.js`
- Modify: `server/server.js` (`app.use('/api/rider-km', riderKmRoutes)` next to staff-money), `server/routes/expenses.js` (item flag)

**Interfaces:**
- Consumes: Task 1 tables and `buildChain` / `usualHome` / `priceStretches`.
- Produces, `rider-km-data.js`:
  - `accountStart(db, userId) -> string|null`: the shop-local start of the day of the first non-removed reading, as an ISO timestamp.
  - `loadChainInputs(db, userId) -> { readings, answers, corrections, rates, usualHomeKm, lastSettlement }`. `usualHomeKm` is `users.km_usual_home_ride` if set, else `usualHome(...)`.
  - `isRider(db, userId, locationId) -> boolean`: active `delivery_partner` linked to the location.
- Produces, routes (all `authenticate`):
  - `GET /api/rider-km/riders?location_id=` — GIVER roles. Riders at the shop: `{ id, name, unsettled_km, open_day, gaps, balance_paise }`. Balance is the preview net (Task 3 fills this; until then it is `null`).
  - `GET /api/rider-km/:userId` — GIVER roles, or the rider themself. `{ rider, stretches, open_day, gaps_open, unsettled: { paid_km, by_rate, amount_paise }, last_reading, last_settlement, history: [settlements newest first, 20] }`.
  - `POST /api/rider-km/readings` `{ user_id, location_id, kind, meter?, typed_km?, read_at?, note?, confirm_big? }`:
    - 400 for a non-rider or a bad kind or number;
    - 409 `METER_DOWN` with the exact copy;
    - 409 `CONFIRM_BIG` when the resulting work stretch is over 300 km and `confirm_big` is not set;
    - 409 `SETTLED_RANGE` ("That day is already settled. Ask the owner or a manager to add a correction.") when `read_at` is at or before the last settlement's cutoff reading time;
    - 403 for counter staff more than 7 days back;
    - a duplicate (same rider, kind and meter within 2 minutes) returns the existing row, 200.
    - Response: `{ reading, today_work_km }`.
  - `PUT /api/rider-km/readings/:id` `{ meter?, typed_km?, read_at?, kind? }` and `DELETE /api/rider-km/readings/:id` (sets `removed_at`). Owner/manager can change any unsettled reading; counter staff only their own within 7 days; a settled reading → 409 `SETTLED`.
  - `POST /api/rider-km/gaps` `{ user_id, from_reading_id, to_reading_id, answer, work_km? }`: `work_km` must be 0 to the stretch km. Upsert on the pair while unsettled.
  - `POST /api/rider-km/corrections` `{ user_id, km, note, for_date? }` — owner/manager.
  - `GET /api/rider-km/rate` — any authenticated role except customer/helper: `{ rate, effective_from, history }`. `PUT /api/rider-km/rate` `{ rate, effective_from? }` — owner; `effective_from` defaults to today.
  - `PUT /api/rider-km/:userId/usual-home` `{ km|null }` — owner/manager.
  - `GET /api/rider-km/mine` — `delivery_partner` only; the same shape as `GET /:userId` for the caller.
- Produces, expenses:
  - `PUT /api/expenses/items/:id/rider-petrol` `{ on }` — owner;
  - items responses include `is_rider_petrol`;
  - `POST /api/expenses` and `PUT /api/expenses/:id` refuse a Rider petrol item with `given_to_name` and no `given_to_user_id`, with the exact copy (400).
- Audit rows (`audit_logs`, `entity_type 'rider_km'`): `km_reading_add` / `km_reading_change` / `km_reading_remove` / `km_gap_answer` / `km_correction` / `km_rate_set` / `km_usual_home_set`.

- [ ] **Step 1: Write `verify-rider-km.js` checks** (copy the harness from `verify-staff-money.js`: `assertLocalTarget`, `tokenFor`, `check`, cleanup of everything it creates; the test rider is a new `delivery_partner` user linked to Test Loc):
  - `a reading chain answers work and home km`: post the six in-out readings from Task 1 (with `read_at` set) → GET shows paid 112, `open_day` false.
  - `meter down is refused with the copy`.
  - `a 301 km work stretch needs confirm_big` (409, then 200 with it).
  - `a duplicate reading within 2 minutes returns the same row` (Review Focus 2).
  - `counter staff cannot add a reading 8 days back`; `manager can`.
  - `a gap is listed and answered`: arrive, arrive → `gaps_open` 1 → answer typed 200 → paid includes 200, `gaps_open` 0. `work_km` above the stretch → 400.
  - `rider petrol item flag`: owner sets it; counter staff 403; saving that item with a typed name only → 400 with the copy.
  - `roles`: florist / helper / customer → 403 on every route; the rider can GET `/mine` and their own `/:userId`, gets 403 for another rider's, and 403 on POST readings.
  - `rate`: owner sets 4 from today; manager 403.
- [ ] **Step 2: Run** `TRACKING_LINK_SECRET=verify-secret node scripts/verify-rider-km.js` against the restarted dev server. Expected: fails (404s).
- [ ] **Step 3: Implement** the data module, the routes and the expense item flag. Readings are always loaded fresh and chained with `buildChain`; nothing is cached or stored as totals.
- [ ] **Step 4: Run** the suite until it passes; also run `verify-expense-book.js` (still 69/69).
- [ ] **Step 5: Commit** `feat(rider-km): readings, gaps, corrections and rate`.

### Task 3: Settlement (preview and commit), drawer and COD

**Files:**
- Modify: `server/routes/rider-km.js`, `server/utils/rider-km-data.js`, `server/utils/register-close.js`, `server/routes/expenses.js`, `server/routes/deliveries.js`, `server/scripts/verify-rider-km.js`

**Interfaces:**
- Consumes: Task 2 loaders; `lockOpenRegister`, `moveSessionCash` (`server/utils/register-guard.js`); `remainingPaise` (`server/utils/staff-money.js`).
- Produces `collectOpenItems(db, userId, cutoffAt, { forUpdate }) -> { petrolRows, petrolBookPaise, petrolTakenPaise, codRows, shoppingRows, supplyHeldPaise, carriedInPaise }`. The item rules:
  - **Petrol** (spec §8): a non-removed expense with an `is_rider_petrol` item, `km_settlement_id IS NULL`, and `created_at` from the account start to `cutoffAt`. It counts if any of these hold:
    - `given_to_user_id = rider` and method cash/upi;
    - method `shopping_money` and its `staff_money_out.user_id = rider`.
  - **`petrolBookPaise`**: the sum of all those rows (returns negative).
  - **`petrolTakenPaise`** = `petrolBookPaise` (every counted row is shop money the rider received for petrol).
  - **COD**: deliveries with `delivery_partner_id = rider`, `cod_status IN ('collected','partial')`, `km_settlement_id IS NULL`, and delivered at or after the account start. The cash part is from `delivery_collections` `method='cash'`; the UPI part is listed separately for the **Paid to own UPI** switch.
  - **Shopping money**: `staff_money_out.user_id = rider`, `status='open'`, `remainingPaise > 0` (any date).
  - **Carry**: the last settlement's `carry_out`.
- Produces `POST /api/rider-km/:userId/settle` — GIVER roles. Request: `{ location_id, preview: true }` or `{ location_id, expected_net_paise, action, amount?, method?, upi_own_delivery_ids?: [] }`.
  - The cutoff is the latest `leave` or `typed` reading that is not settled.
  - 409 `GAPS_OPEN` ("Answer the gaps first, then settle.") if any gap up to the cutoff is unanswered.
  - 409 `NOTHING` ("Nothing to settle yet.") if there is no cutoff and no corrections or carry change.
  - The preview returns `{ lines: { stretches_by_day, by_rate, paid_km, km_paise, petrol: [...], petrol_taken_paise, carried_in_paise, shopping: [...], supply_held_paise, cod: [{delivery_id, sale_number, cash_paise, upi_paise}], cod_held_paise }, net_paise, cutoff_reading_id }`.
  - On commit, the net is recomputed under locks with the chosen `upi_own_delivery_ids` added to COD held. If it differs from `expected_net_paise`, the answer is 409 `CHANGED` with the exact copy.
  - Actions:

    | `action` | Allowed when | `amount` | Method / register |
    |---|---|---|---|
    | `pay` | net > 0 | 1..net | `cash` needs an open register (`moveSessionCash(-amount)`), else 409 with the pay copy; `upi` touches no register |
    | `take` | net < 0 | 1..−net | `cash` → `moveSessionCash(+amount)`, else 409 with the take copy; `upi` touches no register |
    | `carry` | net ≠ 0 | — | none |
    | `zero` | net = 0 | — | none |
    | `salary` | owner only | — | — |

    `carry_out` = net − paid (pay), net + taken (take), or net (carry/salary).
  - Commit writes, in one `withMoneyTx` in the global lock order:
    - the settlement row (`lines_json` = the preview lines);
    - the readings, answers and corrections up to the cutoff get `settlement_id`;
    - the petrol rows get `km_settlement_id`;
    - the COD rows get `km_settlement_id` and `cod_status='settled'`, with **no `delivery_settlements` row**;
    - each covered shopping money line gets a `staff_money_settles` row (`returned_amount` = remaining, `returned_method='km'`, `register_id` NULL) and `status='settled'`, `closed_at`, `km_settlement_id`;
    - one expense row: the item is the first `is_rider_petrol` item (created as "Petrol", kind transport, if none exists), category transport, `payment_method='km_account'`, `given_to_user_id = rider`, `km_settlement_id`, location, today. Its amount is `|km_paise − petrolBookPaise|`, and it is `is_return=1` when km < book. It is skipped when equal.
    - an audit row `km_settle`.
  - `km_account` must be accepted by the expenses validators wherever they list methods. It is excluded from every drawer query (it is never `'cash'`, so `register-close.js`'s expense sum already skips it — assert it).
  - `GET /riders` now fills `balance_paise` (the preview net; `null` if gaps are open).
- Produces in `register-close.js`: `staffMoneyDrawerLines` also returns `kmPaidOut` and `kmTakenIn` (sums of `rider_km_settlements.moved_amount` where `register_id = ?` and `moved_method='cash'`, split by action). `computeRegisterClose` subtracts the paid and adds the taken. The values are returned as `kmPaidTotal` / `kmTakenTotal`.

- [ ] **Step 1: Write failing checks** in `verify-rider-km.js`:
  - `three signs of net`: build K = 336 (112 km × 3); petrol cash 200 given to the rider (Rider petrol item, cash, open test register); shopping money 300 with change 100 still held (bills 200 Roses); COD cash 500 delivered → preview net = 336 − 200 − 100 − 500 = −464.
  - `carry`: commit carry → `carry_out` −464; the COD is now `cod_status='settled'`; the Settlements pending list (`GET /api/deliveries/settlements/pending` or the route the Settlements screen uses) no longer has it; the shopping line is settled; register expected cash unchanged.
  - `petrol book equals K`: the sum of the settlement's petrol rows plus its expense row = 336 (signed).
  - `K below petrol`: 10 km (30) with 200 petrol → the expense row is a 170 money-back.
  - `own-pocket Rider petrol for a rider is refused`: `POST /api/expenses` with a Rider petrol item, `payment_method='own_pocket'`, `paid_by_user_id` = the rider → 400 with the copy.
  - `pay cash moves the drawer once`: net +200, pay cash 200 → `expected_cash` −200, and the register close preview matches expected cash. Pay UPI → no drawer change.
  - `take cash with the register closed refused, UPI allowed` (Review Focus 3).
  - `carry chains across three settlements` (−464 → next shows carried −464 → pay or take leaves 0).
  - `UPI own switch`: a UPI COD of 300 is not held by default; with its id in `upi_own_delivery_ids` the net drops by 300.
  - `stale expected_net refused` with `CHANGED`.
  - `gaps block settle` with `GAPS_OPEN`.
  - `petrol window`: petrol saved after the cutoff reading waits for the next settlement; petrol saved before the account start is ignored.
  - `rate back-dated after a settlement changes only unsettled km` (Review Focus 4).
  - `settle-now and km settle race on one COD`: run both concurrently (`Promise.all`); the COD ends settled exactly once (either `delivery_settlements` has it and the km settlement excluded it or got `CHANGED`, or `km_settlement_id` is set and settle-now skipped it). Settle-now must take `FOR UPDATE` on the delivery rows and skip `km_settlement_id IS NOT NULL` — change `deliveries.js` settle-now's selection to add `AND d.km_settlement_id IS NULL` (Review Focus 5).
  - `two settles at once`: one wins, the other gets `CHANGED`.
  - `counter staff can settle; florist 403; salary action owner only`.
- [ ] **Step 2: Run** the suite. Expected: the new checks fail.
- [ ] **Step 3: Implement**:
  - `collectOpenItems`, the settle route and the register-close lines;
  - the `km_account` method;
  - the settle-now exclusion;
  - the own-pocket refusal in `server/routes/expenses.js` (create and change), with the exact copy.
- [ ] **Step 4: Run** `verify-rider-km.js`, `verify-staff-money.js`, `verify-register-expenses.js`, `verify-cash-safety.js`, `verify-order-flows.js` and `verify-expense-book.js`. All must pass.
- [ ] **Step 5: Commit** `feat(rider-km): settle km with petrol, supply money, COD and carry`.

### Task 4: Payroll and the rider's own view (server)

**Files:**
- Modify: `server/routes/staff-management.js` (the payroll calculate route around line 510 and the pay route around line 719), `server/utils/staff-money.js`, `server/routes/staff-money.js` (`/mine`), `server/scripts/verify-rider-km.js`

**Interfaces:**
- Consumes: Task 3 settle internals. Factor the commit body into `commitSettlement(tx, { userId, locationId, actor, action, amount, method, upiOwnIds, expectedNetPaise, salaryPaymentId })` in `rider-km-data.js` so payroll can call it.
- Produces:
  - Payroll calculate, for `delivery_partner`, returns `km: { carried_paise, unsettled: boolean, settle_first_message }`. `carried_paise` is the last settlement's `carry_out`. `unsettled` is true when any unsettled stretch, petrol, cash COD or open shopping money exists; the message is `"{Name} has km not settled — Settle km first"`. `PAYROLL_SHOPPING_EXCLUDED_ROLES` stays as is; riders still never get the shopping money tick.
  - Payroll pay takes `apply_km_carry: true` (owner). Under locks it re-reads the carry, then:
    - stores the payment;
    - writes a settlement with `action='salary'`, `carry_out=0`, `moved_amount = |carry|`, `salary_payment_id`;
    - adjusts `net_amount` by the carry (rider owes → minus; shop owes → plus);
    - returns 409 `CHANGED` if the carry changed since calculate (`expected_km_carry_paise`).
  - The settle route's `action:'salary'` (owner) commits the settlement as carry (`carry_out` = net), flagged `for_salary=true` in `lines_json`. Payroll then shows that carry.
  - `GET /api/staff-money/mine` for a rider adds `km: { unsettled_km, unsettled_paise, petrol_taken_paise, cod_held_paise, balance_paise, last: [3 settlements] }`. `/api/rider-km/mine` stays the full view.
- [ ] **Step 1: Write failing checks**:
  - `payroll shows a rider carry and Settle km first`;
  - `applying the carry takes it off pay and zeroes the balance`;
  - `a stale carry at pay is refused`;
  - `rider /mine has the km block`;
  - `a non-rider payroll is unchanged` (compare the response keys with the pre-change shape for a counter staff user).
- [ ] **Step 2: Run** them and confirm they fail. **Step 3: Implement.** **Step 4: Run** `verify-rider-km.js` and `verify-staff-money.js` (75/75 still).
- [ ] **Step 5: Commit** `feat(rider-km): payroll carry and the rider's own figures`.

### Task 5: App — Km reading form and API client

**Files:**
- Modify: `app/src/services/api.js`, `app/src/components/expenses/AddExpenseSheet.js`
- Create: `app/src/components/expenses/KmReadingForm.js`, `app/src/utils/riderKm.js`, `app/scripts/test-rider-km.js`

**Interfaces:**
- Consumes: Task 2 routes.
- Produces in `api.js`: `getKmRiders(locationId)`, `getRiderKm(userId)`, `getMyRiderKm()`, `addKmReading(body)`, `changeKmReading(id, body)`, `removeKmReading(id)`, `answerKmGap(body)`, `addKmCorrection(body)`, `getKmRate()`, `setKmRate(body)`, `setKmUsualHome(userId, km)`, `settleKm(userId, body)`, `setRiderPetrol(itemId, on)`.
- Produces in `riderKm.js` (pure):
  - `suggestKind(lastReading) -> 'arrive'|'leave'`: the opposite of the last, and `arrive` when there is none or the last was typed.
  - `workKmText(lastReading, meter) -> string|null` (`"→ 46 km of work"` only when the last is `arrive` and the meter is above it).
  - `stretchLabel(stretch) -> string`, e.g. `"Gap 314 km — answer"`, `"Home ride 12 km (not paid)"`, `"46 km"`.
  - `netText(name, paise) -> string` (`"Shop pays L ₹226"` / `"L owes ₹414"` / `"Nothing to pay"`).
- Form behaviour:
  - "Km reading" is a third link under Salary advance / Shopping money, shown to GIVER roles. It opens `KmReadingForm` in place, the same way `MoneyToStaffForm` opens.
  - Riders are chips from `getKmRiders` with the last used first (`@petal_last_km_rider` in AsyncStorage, try/catch).
  - Arriving / Going home is a two-button switch pre-set by `suggestKind`.
  - The meter has a numeric keyboard. Under it: "Last: Arriving 12,340 · 9:12 am" and the `workKmText`.
  - "For another day ›" opens a date + time picker (the same picker component Expenses uses for dates).
  - "Type km instead ›" swaps the meter for "Km of work" + date.
  - Save calls `addKmReading`. On `CONFIRM_BIG` it asks with `showConfirm` and the exact copy, then resends with `confirm_big`. On other errors it shows the message with `showAlert`. On success it shows the toast "Saved · {n} km of work today" (or "Saved · Arriving") and closes the sheet.
- [ ] **Step 1: Write `test-rider-km.js`** for `suggestKind`, `workKmText`, `stretchLabel` and `netText` (the exact strings above).
- [ ] **Step 2: Run** it and confirm it fails. **Step 3: Implement** the utils, the API methods and the form. **Step 4: Run** the test, babel-transform the changed files, and run `npx expo export --platform web` into the scratchpad.
- [ ] **Step 5: Commit** `feat(rider-km): Km reading in the Add expense sheet`.

### Task 6: App — RiderKm screen (chain, gaps, settle) and the money card

**Files:**
- Create: `app/src/screens/RiderKmScreen.js`
- Modify: `app/src/components/expenses/ShoppingMoneyCard.js`, `app/src/navigation/MainNavigator.js`, `app/src/screens/SettlementsScreen.js`, `server/routes/rider-km.js`, `server/scripts/verify-rider-km.js`

**Interfaces:**
- Consumes: Task 5 API methods and helpers; Task 3 preview/commit shapes.
- Screen `RiderKm` (params `{ userId, name }`), registered in every stack that registers `Expenses`. Top to bottom:
  - **Readings by day**: newest first, each stretch shown with `stretchLabel`. Tapping an unsettled reading opens edit/remove (role rules as in Task 2). Owner/manager get "Add correction".
  - **Gaps**: in orange, each with **Add the missed readings** (opens `KmReadingForm` in "For another day" mode inside a modal, with `bumpActivity` on the modal content), **Type work km**, and **No work**.
  - **Settle km** (the one pink button) opens the settle section from the preview:
    - lines exactly as spec §9's sketch;
    - each UPI COD with a **Paid to {Name}'s own UPI** switch, which re-previews;
    - buttons by sign as in the Task 3 actions table, with Cash | UPI using the existing `MethodSwitch`;
    - **Take from salary** for the owner;
    - a register-closed 409 shows the copy with an "Open Register" button (the existing pattern from Collect dues);
    - `CHANGED` re-previews with an alert.
  - **Past settlements**.
- Settlements history (spec §9.3): add server `GET /api/rider-km/settlements?location_id=&limit=50` (GIVER roles; newest first: rider name, date, km, COD settled, net, action, moved amount/method). `SettlementsScreen.js` history section lists these as "Km · {Name} · {km} km · COD ₹X" lines among the delivery settlements (merged by date). Add a check to `verify-rider-km.js`: a km settlement appears in this list with its COD total.
- `ShoppingMoneyCard`: below the shopping money holders, a "Riders" sub-list from `getKmRiders` showing `"{Name} · {unsettled_km} km · {netText}"` (or "· Gaps to answer"). Tapping opens `RiderKm`. It is hidden when there are no riders with readings.
- [ ] **Step 1:** Add `netText` / `stretchLabel` cases for the settle lines to `test-rider-km.js` if new strings are needed; run it.
- [ ] **Step 2: Implement** the screen, the card lines and the navigation.
- [ ] **Step 3: On-screen check** at 375 px (scratchpad iframe trick, test owner 7777 and E2E Counter, Test Loc, UPI or a test-opened register only):
  - readings in-out-in-out;
  - a gap answered with typed km;
  - a multi-day settle with petrol, supply money and COD;
  - carry, then pay UPI on the next settle;
  - the card line updates.

  Delete all test rows afterwards.
- [ ] **Step 4:** Babel + web export.
- [ ] **Step 5: Commit** `feat(rider-km): rider km screen and settle sheet`.

### Task 7: App — rider view, settings, close reminder, payroll; docs

**Files:**
- Modify: `app/src/screens/ProfileScreen.js`, `SettingsScreen.js`, `ExpenseItemScreen.js`, `CashRegisterScreen.js`, `SalaryManagementScreen.js`, `CLAUDE.md`, `docs/superpowers/specs/2026-11-15-rider-km-account-design.md`

**Interfaces:**
- Consumes: Task 4 `/mine` km block and payroll `km`; Task 2 rate/flag/usual routes.
- Produces:
  - **Profile → My money (rider):** a "My km money" block (spec §10 sketch). "Readings ›" opens `RiderKm` read-only for the caller (it uses `getMyRiderKm`, with no buttons).
  - **Settings (owner):** a "Km rate" row: ₹ value + "From" date, saved with `setKmRate`. On first open it lists the items that count as Rider petrol.
  - **Expense item page (owner):** a "Rider petrol" switch.
  - **RiderKm (owner/manager):** "Usual home ride" km editing.
  - **Cash Register close:** before the count, a non-blocking list `"{First} has no going-home reading — Add now"` for riders whose `open_day` is true (from `getKmRiders`). "Add now" opens the Km reading form with Going home pre-picked. The close never waits on it.
  - **Payroll (rider):**
    - a "Km balance" line with an owner tick "Apply to this pay" (`apply_km_carry`, `expected_km_carry_paise`);
    - when `unsettled`, the settle-first message as a button to `RiderKm`.
  - **CLAUDE.md:** a roadmap continuation entry under sub-project 1's expense continuations, matching the existing style:
    - what it is;
    - routes;
    - the lock order;
    - `km_account`;
    - no `delivery_settlements` row;
    - settle-now excludes km-settled COD;
    - test counts;
    - not checked;
    - deploy order.
- [ ] **Step 1: Implement**, then babel + web export.
- [ ] **Step 2: On-screen check** at 375 px:
  - the rider's My money (a test `delivery_partner` login via the scratchpad login helper);
  - the owner's Km rate and Rider petrol switch;
  - the close reminder (test-opened register at Test Loc, never 83/4383/7235);
  - the payroll Km balance line for a test rider with a salary row.
- [ ] **Step 3: Run** every server suite plus the app tests (`$SP/run-all.sh` and `app/scripts/test-*.js`); all must be green (GST at its known 19/21).
- [ ] **Step 4: Commit** `feat(rider-km): rider view, settings, close reminder, payroll`.
