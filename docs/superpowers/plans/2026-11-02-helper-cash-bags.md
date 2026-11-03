# Helper Cash Bags Implementation Plan (scan-and-sell spec, part 4 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An owner setting lets each helper keep their own cash "bag" (with a change float, a blind handover to the counter, shortages recorded), with amounts hidden by default on the counter screen and register close counting it all correctly.

**Architecture:** `payments.held_by` marks helper cash kept in a bag (no register write at sale time); a `staff_cash_movements` table records floats out of and handovers into the register; a bag util computes each helper's balance; register close's recompute excludes held cash and includes movements; the API itself masks amounts and logs every reveal, and handovers are blind server-side (expected amount only returned after the count is submitted).

**Tech Stack:** Express + `pg` (sync layer inside the existing sale/close transactions, async for new read routes), Expo / React Native Web.

**Spec:** `docs/superpowers/specs/2026-11-02-scan-sell-helpers-staff-sales-design.md` §11, §12, §2 (owner decisions), §4.2 (report columns).

**Prerequisites:** all three earlier parts merged (helpers sell, `sold_by`, staff-sales report, quick-sale undo + close preview). Branch `feature/helper-cash-bags`.

## Global Constraints

- Additive schema only; `db-migration-safety` first.
- Setting `helper_cash_mode`: `'register'` (default) | `'bag'`; owner only; switching refused while any bag ≠ 0 with copy `Collect the cash from <names> first (<masked total>).`
- Bag balance = Σ float_out.expected_amount + Σ held cash payments on non-cancelled sales − Σ handover_in.settled_amount, per (staff, location). `settled_amount` = expected_amount when `is_final`, else counted_amount.
- Masking (server-side, `maskAmount(n)`): format in en-IN grouping with `₹`, then: amounts < 100 → every digit `x` (`₹xx`); otherwise keep the first digit and replace every other digit with `x` (`₹5,xxx`, `₹8xx`, `₹1,xx,xxx`). Sale counts are never masked.
- Reveal: exact amount returned only by the reveal endpoint, which writes an `audit_logs` row (`action 'helper_bag_reveal'`, entity `user`, entity_id = helper); the client hides it again after 15 s.
- Handover is blind: the request carries only the counted amount; expected/difference come back in the response.
- Floats and handovers need an open register; closed → client shows the existing `OpenRegisterForm` first.
- Roles for floats, handovers, bag list, reveal: `owner, manager, employee, counter_staff`. Helpers may read and reveal **only their own** bag.
- Close warning copy: `₹<masked> is still with <name>. Collect it first?` buttons **Collect now** / **Close anyway** (close proceeds; an `audit_logs` row `register_closed_with_helper_cash` lists the bags).
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A helper sale in bag mode that is undone (or refunded) after a partial handover: the bag never goes negative from the undo — undo is refused once any handover exists after the sale (Task 2 check `helper undo blocked after handover`); a refund pays from the drawer (existing rule) and does not touch the bag (Task 2 check `refund of a bag sale leaves the bag alone`).
2. Mode switched from bag → register is refused while cash is out; register → bag with no cash out works (Task 3 checks).
3. Register close in a session with a float, two helper sales, a partial and a final handover: discrepancy exactly 0 when the drawer holds opening − float + handovers (Task 2 check `close counts floats and handovers`).
4. A helper whose access ended keeps a non-zero bag listed and collectable (Task 3 check `expired helper bag still listed`).
5. Two counter staff submit a final handover for the same helper at the same moment: only one settles; the second gets "Already collected — refresh" (Task 3 check `double handover`; row lock on the helper's movements in one transaction).

---

### Task 1: Schema, held payments, bag util

**Files:**
- Modify: `server/config/database.js` — `payments.held_by INTEGER REFERENCES users(id) ON DELETE SET NULL`; table `staff_cash_movements (id SERIAL PK, location_id INT NOT NULL REFERENCES locations(id), staff_id INT NOT NULL REFERENCES users(id), type VARCHAR(20) NOT NULL CHECK (type IN ('float_out','handover_in')), expected_amount DECIMAL(10,2) NOT NULL DEFAULT 0, counted_amount DECIMAL(10,2) NOT NULL DEFAULT 0, settled_amount DECIMAL(10,2) NOT NULL DEFAULT 0, difference DECIMAL(10,2) NOT NULL DEFAULT 0, is_final INTEGER NOT NULL DEFAULT 0, register_id INT REFERENCES cash_registers(id) ON DELETE SET NULL, recorded_by INT REFERENCES users(id) ON DELETE SET NULL, note TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)` + index `(staff_id, location_id, created_at)`; settings seed `helper_cash_mode = 'register'`
- Create: `server/utils/helper-bags.js`
- Modify: `server/utils/helper-sale.js` / `server/routes/sales.js` — in bag mode, a helper's cash payment row gets `held_by` = helper, skips the register-open guard and skips the `cash_registers` increments; UPI unchanged
- Create: `server/scripts/verify-helper-bags.js`

**Interfaces:**
- Produces: `getBag(db, staffId, locationId) -> { held, floats, cash_sales, settled, sale_count }`; `listBags(db, locationId) -> [{ staff_id, name, is_active, access_until, held, sale_count }]` (only non-zero `held`, or any helper with sales today); `maskAmount(n) -> string`.

- [ ] **Step 1: Failing checks:** `maskAmount examples` (`5234→₹5,xxx`, `845→₹8xx`, `45→₹xx`, `123456→₹1,xx,xxx`, `0→₹x`); `bag mode cash sale is held and skips the register` (register `expected_cash` unchanged, payment `held_by` = helper, works with register closed); `register mode unchanged` (helper cash still hits the register); `bag mode UPI goes to register totals`; `bag balance formula` (float 500 + sales 700 → held 1200).
- [ ] **Step 2–4:** Run → FAIL; implement; restart API; run this + `verify-helpers.js` + `verify-order-flows.js` → pass.
- [ ] **Step 5: Commit** `feat(bags): held helper cash and bag balances`.

### Task 2: Register close, undo and refund with bags

**Files:**
- Modify: `server/routes/sales.js` — `PUT /register/close` recompute (also its `preview` branch): direct-payment cash excludes `p.held_by IS NOT NULL`; add Σ `counted_amount` of `handover_in` and subtract Σ `expected_amount` of `float_out` whose `register_id` = this register; record the closed-with-helper-cash audit row when any bag ≠ 0
- Modify: `server/routes/quick-sale.js` — undo of a held sale writes nothing to the register; helper undo refused (`This sale's cash was already handed over. Ask the counter to refund it.`) when a `handover_in` for that helper exists after the sale
- Modify: `server/scripts/verify-helper-bags.js`

- [ ] **Step 1: Failing checks:** `close counts floats and handovers` (open 1000, float 300 to helper, helper sells 400 + 200 cash, partial handover counted 250, final handover counted 640 with expected 650 → shortage 10 recorded; close with actual 1000 − 300 + 250 + 640 = 1590 → discrepancy 0); `preview matches close`; `held undo leaves the register alone`; `helper undo blocked after handover`; `refund of a bag sale leaves the bag alone` (cash refund debits the register as today; bag unchanged).
- [ ] **Step 2–4:** Run → FAIL; implement; run this, `verify-register-expenses.js`, `verify-quick-sale.js` → pass.
- [ ] **Step 5: Commit** `feat(bags): register close, undo and refund with helper bags`.

### Task 3: Bag API (list, reveal, float, handover) and mode switch

**Files:**
- Create: `server/routes/helper-cash.js`, mount `app.use('/api/helper-cash', …)` in `server/server.js`
- Modify: `server/routes/settings.js` (`PUT /`: refuse `helper_cash_mode` change while any bag ≠ 0, exact copy)
- Modify: `server/scripts/verify-helper-bags.js`

**Interfaces:**
- `GET /api/helper-cash/bags?location_id=` → `{ success, data: { mode, total_masked, bags: [{ staff_id, name, held_masked, sale_count, access_ended }] } }` (helper caller: only their own).
- `POST /api/helper-cash/bags/:staffId/reveal` `{ location_id }` → `{ success, data: { held, floats, cash_sales, settled, last_float } }` + audit row.
- `POST /api/helper-cash/float` `{ staff_id, location_id, amount }` (amount > 0; staff must be an active helper) → movement row, register `expected_cash -= amount`; open register required (`REGISTER_CLOSED_MESSAGE`).
- `POST /api/helper-cash/handover` `{ staff_id, location_id, counted_amount, is_final }` → in one transaction with `SELECT … FOR UPDATE` on that helper's movements: expected = current bag; final → settled = expected, difference = counted − expected; partial → settled = counted (must be ≤ expected, else `That's more than Raju should have — count again or choose "Yes, settle"`); register `expected_cash += counted`; response `{ expected, counted, difference, remaining }`. Bag already 0 → 409 `Already collected — refresh`.

- [ ] **Step 1: Failing checks:** `bags list is masked`; `reveal returns exact and is audited`; `helper sees only own bag`; `float needs open register`; `handover response reveals expected only after count`; `partial handover keeps the rest`; `double handover` (two parallel finals → one 200, one 409); `mode switch refused with cash out`; `mode switch allowed when bags are empty`; `expired helper bag still listed`.
- [ ] **Step 2–4:** Run → FAIL; implement; run → pass.
- [ ] **Step 5: Commit** `feat(bags): bag list, reveal, float, blind handover, mode switch`.

### Task 4: Counter screens

**Files:**
- Create: `app/src/components/helperCash/HelperCashCard.js`, `ReceiveCashSheet.js`, `GiveFloatSheet.js`
- Modify: `app/src/screens/DashboardScreen.js` (counter/employee view: card shown only in bag mode when the list is non-empty), `app/src/screens/CashRegisterScreen.js` (before closing: if any bag ≠ 0 show the warning panel with **Collect now** → ReceiveCashSheet, **Close anyway**), `app/src/screens/helper/MySalesScreen.js` (own bag line from the bag API), `app/src/services/api.js`
- Read first: `staff-ux-checklist`, `app-ui-quality`.

**Interfaces / behaviour:**
- Card: `Cash with helpers  <total_masked>`, rows `<name>  <held_masked> · <n> sales`, hint "tap a name to see the exact amount or collect". Tap → reveal call → exact amount shown 15 s with **Receive cash** and **Give float**, then masked again.
- ReceiveCashSheet (blind): step 1 "Count <name>'s cash and type the total" → amount → **Next** → step 2 shows `Expected ₹X · Counted ₹Y · Short ₹Z` (or Over / Exactly right) and "Is this all the cash <name> has?" **Yes, settle** / **No, part of it** — the request is sent at step 2's choice with `is_final` accordingly; the expected figure is displayed from the response. Register closed → `OpenRegisterForm` first.
- GiveFloatSheet: amount pre-filled with `last_float` (or 500 when none) → **Give**.
- Tap counts (spec §15): receive = 3 + amount, float = 2 + amount.

- [ ] **Step 1:** Implement; babel-check.
- [ ] **Step 2: On-screen check** (owner sets bag mode; throwaway helper + counter_staff): float 500 → helper sells 2 cash sales on a second browser profile → card masked → reveal 15 s → receive partial → receive final with a ₹10 shortage → close register warning appears only while cash is out → close balances to 0. Switch mode back refused while out, allowed after. Remove all test data; restore `helper_cash_mode`.
- [ ] **Step 3: Commit** `feat(bags): counter card, blind handover, float, close warning`.

### Task 5: Owner settings and report columns

**Files:**
- Modify: `app/src/screens/SettingsScreen.js` (owner: Helpers → cash mode, two options with the spec's one-line explanations; refused copy shown inline)
- Modify: `server/routes/reports.js` `GET /staff-sales` rows gain `floats`, `cash_collected`, `handed_over`, `short_over`, `reveals` (count of reveal audit rows for that helper in the period); `app/src/screens/StaffSalesScreen.js` shows them for helpers
- Modify: `server/scripts/verify-helper-bags.js` / `verify-staff-sales.js`

- [ ] **Step 1: Failing check:** `staff sales report includes bag columns` (values from the Task 2 scenario).
- [ ] **Step 2–4:** Run → FAIL; implement; run → pass; babel-check app files; on-screen check of the setting and the report as owner.
- [ ] **Step 5: Commit** `feat(bags): owner cash-mode setting and report columns`.

### Task 6: Final verification

- [ ] Run every suite touched across the four parts: `verify-helper-bags.js`, `verify-helpers.js`, `verify-staff-sales.js`, `verify-quick-sale.js`, `verify-register-expenses.js`, `verify-order-flows.js`, `verify-identity-roles.js`, `verify-labels-scanner.js` (last); app unit scripts.
- [ ] CLAUDE.md roadmap note, commit `docs: helper cash bags shipped`. Ask before push/PR.
