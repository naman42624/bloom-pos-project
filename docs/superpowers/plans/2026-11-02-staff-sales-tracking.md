# Staff Sales Tracking Implementation Plan (scan-and-sell spec, part 1 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every sale records who sold it, and the owner (only) sees orders, amount, discounts and undos per person for any period.

**Architecture:** Additive `sales.sold_by`, set server-side on every new sale (default the caller, optional pick from the location's staff). One owner-only report endpoint in `server/routes/reports.js` and one owner-only screen. A small "Sold by" picker on Quick Checkout (Full order) and Log Order.

**Tech Stack:** Express + `pg` (async `getDb()` for the new read-only report; the sale-creation change sits inside the existing sync route), Expo / React Native Web.

**Spec:** `docs/superpowers/specs/2026-11-02-scan-sell-helpers-staff-sales-design.md` §4 (and §2 for the owner-only rule).

**Prerequisite:** the quick-sale plan (`docs/superpowers/plans/2026-11-02-quick-sale-roll.md`) is merged — this plan reads `sales.entry_mode`, `sales.undone_by`/`undone_at` and reuses `server/scripts/lib/verify-harness.js`. Branch `feature/staff-sales` from the merged result.

## Global Constraints

- Additive schema only, via `ensureColumn` in `server/config/database.js`; read `db-migration-safety` first. No apostrophes in SQL comments.
- The report endpoint and screen are **owner only** — `authorize('owner')`; managers get 403 and no menu entry.
- Seller of a sale = `COALESCE(sales.sold_by, sales.created_by)`. Old rows are never backfilled.
- Cancelled sales (`status = 'cancelled'`) never count as orders or amount.
- Picker label exact: `Sold by: You ▸` (collapsed), chips show staff first names; it resets to the caller after every saved order.
- `sold_by` sent by a client must be an active user with role in (`owner`,`manager`,`employee`,`counter_staff`,`florist_staff`,`helper`) linked to the sale's location via `user_locations` (owner always allowed); otherwise 400 `That person can't be picked as the seller.`
- Period chips exact: Today · Yesterday · This week · This month · Pick dates. Dates use the server's existing `localToday()`/`localDateStr()` helpers (local shop time).
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No push/PR without the user.

## Review Focus

1. A sale whose seller left the shop (`is_active = 0`) still counts for them in past periods and the row shows them (Task 2 check `inactive seller still listed for the period`).
2. A refunded sale: amount column shows gross, refunds column the refunded sum, net = gross − refunds; a cancelled sale counts nowhere (Task 2 check `refund and cancel accounting`).
3. Quick-sale undo attribution: "Undone" is credited to the person who pressed Undo (`undone_by`), not the seller (Task 2 check `undo counted against the undoer`).
4. Date boundaries: a sale at 23:50 local time lands on that day, not the next (Task 2 check `local-day boundary`).
5. Client sends `sold_by` of a customer or another location's staff → refused, sale not created (Task 1 check `invalid sold_by refused`).

---

### Task 1: `sales.sold_by` on sale creation

**Files:**
- Modify: `server/config/database.js` (ensureColumn + index `idx_sales_sold_by_created (sold_by, created_at)`)
- Modify: `server/routes/sales.js` — `POST /` validators, the seller check before any write, `INSERT INTO sales`
- Create: `server/scripts/verify-staff-sales.js` (uses `server/scripts/lib/verify-harness.js`)

**Interfaces:**
- Produces: column `sales.sold_by INTEGER REFERENCES users(id) ON DELETE SET NULL`; `POST /api/sales` body `sold_by` (optional int). Stored value = validated `sold_by` or `req.user.id`.
- Produces: `assertValidSeller(db, sellerId, locationId) -> void` in `server/utils/seller.js` (throws an Error with the exact message; used again by the helper plan).

- [ ] **Step 1: Failing checks:** `sale without sold_by records the caller`; `sold_by of a counter_staff at the same location is stored`; `invalid sold_by refused` (a customer id, and a staff user not linked to the location → 400 exact message, no sale row); `quick entries get sold_by too` (a quick-sale entry → `sold_by` = owner id). Test users are created through `POST /api/users` and deleted in cleanup.
- [ ] **Step 2: Run** `cd server && node scripts/verify-staff-sales.js` → FAIL.
- [ ] **Step 3: Implement.** Restart the API (`pkill -f "node server.js"; cd server && TRACKING_LINK_SECRET=verify-secret nohup node server.js > /tmp/api.log 2>&1 &`).
- [ ] **Step 4: Run** the new script, `verify-order-flows.js`, `verify-register-expenses.js`, `verify-quick-sale.js` → all pass.
- [ ] **Step 5: Commit** `feat(staff-sales): record who sold each sale`.

### Task 2: Owner-only report endpoints

**Files:**
- Modify: `server/routes/reports.js`
- Modify: `server/scripts/verify-staff-sales.js`

**Interfaces:**
- Produces: `GET /api/reports/staff-sales?from=YYYY-MM-DD&to=YYYY-MM-DD&location_id=` (`authorize('owner')`; defaults: today..today, all locations) →
  `{ success, data: { from, to, rows: [{ user_id, name, role, is_active, orders, amount, refunds, net, discount_count, discount_total, override_count, undone_count, undone_total }] } }`, sorted by `net` desc, only people with at least one non-zero figure. `override_count` = their sales with `discount_approved_by` not null and ≠ seller. `undone_*` = quick-sale entries with `undone_by` = that user and `undone_at` in the period. `refunds` = processed refunds on their sales (`COALESCE(status,'processed') = 'processed'`).
- Produces: `GET /api/reports/staff-sales/:userId/sales?from&to&location_id` (owner only) → `{ success, data: [sale list rows in the same shape `GET /api/sales` returns for cards] }` (reuse that route's SELECT columns; do not duplicate its enrichment logic — call a shared function if one exists, otherwise return id, sale_number, created_at, grand_total, status, order_type, customer_name and let the screen open Sale Details).

- [ ] **Step 1: Failing checks:** `report is owner only` (manager token → 403); `orders and amount per seller` (two sellers, three sales → exact rows); `refund and cancel accounting`; `inactive seller still listed for the period`; `undo counted against the undoer`; `local-day boundary` (insert a sale with `created_at` = today 23:50 local via SQL, query today → included; query tomorrow → excluded); `per-person sales list`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** with the async layer. **Step 4: Run** → pass.
- [ ] **Step 5: Commit** `feat(staff-sales): owner-only staff sales report`.

### Task 3: "Sold by" picker

**Files:**
- Create: `app/src/components/SoldByPicker.js`
- Modify: `app/src/screens/QuickCheckoutScreen.js` (Full order mode only; near the payment section), `app/src/screens/LogOrderScreen.js` (above Save Order)
- Read first: `staff-ux-checklist`, `app-ui-quality` skills.

**Interfaces:**
- Consumes: `GET /api/auth/staff-roster?location_id=` (existing; check its role filter — if it excludes owner/manager that is fine, the caller is always "You").
- Produces: `<SoldByPicker locationId value onChange />` where `value` is `null` (= You) or a user id. Collapsed row `Sold by: You ▸` / `Sold by: <name> ▸`; expanded = large chips (min height 48) + "Me" chip. Parent sends `sold_by` only when `value` is not null and resets `value` to `null` after a successful save.

- [ ] **Step 1:** Implement; babel-check the three files.
- [ ] **Step 2: On-screen check** (throwaway counter_staff, Test Loc, per the 2026-11-01 handoff procedure): place one order as "You" and one with a picked colleague → DB `sold_by` matches; the picker resets after save; Quick sale mode unaffected. Remove test data.
- [ ] **Step 3: Commit** `feat(staff-sales): sold-by picker at checkout`.

### Task 4: Owner screen

**Files:**
- Create: `app/src/screens/StaffSalesScreen.js`
- Modify: `app/src/navigation/MainNavigator.js` (owner's stack that holds Reports), the owner's Reports/More menu (one row "Staff sales", rendered only when `user.role === 'owner'`)
- Modify: `app/src/services/api.js` (`getStaffSales(params)`, `getStaffSalesFor(userId, params)`)

**Interfaces:**
- Consumes: Task 2 endpoints.
- Behaviour: period chips (exact labels above; "Pick dates" opens the existing `DateTimePickerModal` twice: from, to), location chips (All + each location), one card per row: name, role, ended/inactive tag, Orders, Amount, Refunds, Net, Discounts (`n · ₹x · m needed approval`), Undone (`n · ₹x`). Tap → that person's sales list → tap → Sale Details. Empty state: "No sales in this period."

- [ ] **Step 1:** Implement; babel-check.
- [ ] **Step 2: On-screen check** as owner: Today and This month match the endpoint; a manager login does not see the row. 
- [ ] **Step 3: Commit** `feat(staff-sales): owner staff sales screen`.

### Task 5: Final verification

- [ ] Run `verify-staff-sales.js`, `verify-quick-sale.js`, `verify-order-flows.js` (64), `verify-register-expenses.js` (13), `verify-identity-roles.js`.
- [ ] Add the roadmap note to `CLAUDE.md` (sub-project 1 continuation), commit `docs: staff sales tracking shipped`. Ask before push/PR.
