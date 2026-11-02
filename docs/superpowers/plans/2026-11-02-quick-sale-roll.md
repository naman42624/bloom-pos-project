# Quick Sale ("sales roll") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Quick sale" mode in Quick Checkout where one tap on a tile (or typing an amount + Enter) records a real walk-in sale, with Undo, method change, print, and a "book the extra cash as sales" option at register close.

**Architecture:** Entries are created through the existing `POST /api/sales` with a new `entry_mode` field, so every existing rule applies. A new router `server/routes/quick-sale.js` (mounted at `/api/quick-sale`) holds undo, roll and tiles; cancel's stock/customer reversal is extracted into a shared util used by both cancel and undo. On the app side, `QuickCheckoutScreen` gains a mode switch and renders a new `QuickSalePanel`; pure logic lives in `app/src/utils/quickSale.js`.

**Tech Stack:** Express + `pg` (sync `getDb()` layer for transactional writes, matching the cancel route it shares code with), Expo / React Native Web, AsyncStorage.

**Spec:** `docs/superpowers/specs/2026-11-02-quick-sale-roll-design.md`

**Plan-level deviations from the spec (decided here, update the spec in Task 1):** routes live under `/api/quick-sale/...` instead of `/api/sales/quick-...` (keeps them out of the 3,400-line `sales.js` and away from its `/:id` routes); tiles are edited by the **owner** only, through the existing owner-only `PUT /api/settings`.

## Global Constraints

- Schema changes are additive only, via `ensureColumn` in `server/config/database.js`; read the `db-migration-safety` skill first. Never alter dev by hand.
- No apostrophe inside any SQL comment (the `bindParams()` footgun in CLAUDE.md).
- `entry_mode` allowed values: `'quick'`, `'close_topup'`; anything else stores NULL.
- Quick entries: `order_type 'walk_in'`, `channel 'walk_in'`, `skip_assignment true`, one item, full payment in one method (`cash` or `upi`).
- Amount limits: more than ₹0, at most ₹1,00,000 (100000).
- Max 12 tiles; same-tile repeat taps within 700 ms are ignored; Undo/Redo toast lasts 5 s.
- Settings key: `quick_sale_tiles` (JSON array of `{type:'product',product_id}` | `{type:'label',label,price}`).
- Close top-up item name, exact: `Unrecorded sales (booked at close)`. Offered when counted cash exceeds expected by ₹1 or more.
- Default label for an untagged amount: `Counter sale`. Label chips: Fresh Flowers, Bouquet, Bunch, Box, Basket, Vase, Garland, Arrangement.
- Mode stored on device under AsyncStorage key `@petal_checkout_mode` (`'quick' | 'full'`); missing/unreadable → `'full'`. Any route param that opens a specific order (`draftId`, POS cart items, order-request prefill) forces `'full'`.
- All staff-facing copy is exactly as in spec §10 and §5.7. Web dialogs: use `showAlert`/`showConfirm` from `app/src/utils/alert.js`, never raw `Alert.alert` with buttons.
- Roles for every quick-sale route: `owner, manager, employee, counter_staff`.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Don't push or open a PR unless the user asks.

## Review Focus

1. Several fast taps where one request in the middle fails: the others save in tap order, totals count only saved lines, and retrying the failed line creates exactly one sale (Task 6 test `sequentialSender retries one failed entry once`).
2. Undo on an entry whose method was changed Cash→UPI afterwards: the reversal follows the sale's **current** payment rows, not the original tile method (Task 3 check `undo after method change reverses UPI not cash`).
3. Undo after the register was closed and a new session opened: refused with the plain message, nothing reversed (Task 3 check `undo from a closed session is refused`).
4. A tile whose product was switched off after the screen loaded: the server refuses the entry with "This item isn't sold any more — the buttons have been refreshed" and the panel reloads tiles (Task 2 check `quick entry for inactive product is refused`).
5. Register close preview vs real close: booking the excess as a top-up makes the real close's discrepancy exactly 0, and preview writes nothing (Task 5 check `preview writes nothing` and `top-up then close gives zero discrepancy`).

---

### Task 0: Prerequisite — commit the pending branch work

The current branch `fix/checkout-drafts-add-item` has uncommitted Quick Checkout fixes and the two 2026-11-02 specs. Ask the user to confirm committing them (or moving them to their own PR) before starting; then branch `feature/quick-sale` from that commit. Do not start Task 1 on a dirty tree.

### Task 1: Schema + `entry_mode` accepted on sale creation

**Files:**
- Modify: `server/config/database.js` (patch list, next to other `sales` `ensureColumn`s)
- Modify: `server/routes/sales.js` — `POST /` validators (~line 1576-1625), destructuring (~1642), `INSERT INTO sales` (~1903)
- Create: `server/scripts/lib/verify-harness.js`
- Create: `server/scripts/verify-quick-sale.js`
- Modify: `docs/superpowers/specs/2026-11-02-quick-sale-roll-design.md` (§4 roles line for tiles → owner; §7.2/7.4/7.5 paths → `/api/quick-sale/...`)

**Interfaces:**
- Produces: columns `sales.entry_mode VARCHAR(20)`, `sales.undone_by INTEGER REFERENCES users(id) ON DELETE SET NULL`, `sales.undone_at TIMESTAMP`; index `idx_sales_location_entry_mode_created (location_id, entry_mode, created_at)`.
- Produces: `POST /api/sales` body field `entry_mode`; for `entry_mode` in (`quick`,`close_topup`) every product line must reference an active product, else 400 `This item isn't sold any more — the buttons have been refreshed`.
- Produces (harness): `api(method, path, token, body) -> {status, body}`, `loginOwner() -> {token,id,role}`, `openRegister(token, locationId, opening)`, `closeRegisterWith(token, locationId, actual)`, `ensureClosed(token, locationId)`, `check(name, fn)`, `assert(cond, msg)`, `run({cleanup})`, `assertLocalTarget()`, `TEST_LOCATION_ID = 4`. Copied from `verify-register-expenses.js` (which is left untouched).
- Produces (script helper): `quickSale(token, {amount, method, label?, productId?, entryMode='quick'}) -> {status, body}` building the exact quick-entry shape from Global Constraints; created sale ids go into `createdSaleIds` and are deleted in cleanup (sale_items, payments, production_tasks, audit/notification rows for those sales, then sales).

- [ ] **Step 1: Write failing checks** in `verify-quick-sale.js`:
  - `quick entry is stored as a completed walk-in with entry_mode quick` — open register ₹100, `quickSale(₹200, cash, 'Bouquet')` → 201/200; DB row has `entry_mode='quick'`, `order_type='walk_in'`, `channel='walk_in'`, one `sale_items` row named `Bouquet` at 200, one cash payment of 200.
  - `unknown entry_mode is stored as NULL` — send `entry_mode: 'banana'` → saved, column NULL.
  - `cash quick entry with closed register is refused` — `ensureClosed`; cash → 400 whose message equals `REGISTER_CLOSED_MESSAGE`.
  - `UPI quick entry with closed register succeeds`.
  - `quick entry for inactive product is refused` — set a test product `is_active=0` (restore in cleanup) → 400 with the exact message above.
- [ ] **Step 2: Run** `cd server && node scripts/verify-quick-sale.js` → the five checks FAIL (column missing / field ignored).
- [ ] **Step 3: Implement** the three `ensureColumn`s + index; `body('entry_mode').optional({nullable:true}).isString()`; normalise to `['quick','close_topup'].includes(v) ? v : null`; add `entry_mode` to the `INSERT INTO sales` column list and values; the product lookup in item building (~line 1675) already filters `is_active = 1`; when `entry_mode` is set and that lookup finds nothing, throw the exact inactive message instead of the generic one, before any write.
- [ ] **Step 4: Run** the script → 5/5 PASS. Run `verify-order-flows.js` (64) and `verify-register-expenses.js` (13) with the env from the handoff doc → all pass.
- [ ] **Step 5: Update the spec** (deviations above) and commit: `feat(quick-sale): entry_mode on sales, verify harness`.

### Task 2: Shared sale-reversal util (pure extraction from cancel)

**Files:**
- Create: `server/utils/sale-reversal.js`
- Modify: `server/routes/sales.js` — `PUT /:id/cancel` transaction body (~lines 2400-2440)

**Interfaces:**
- Produces: `reverseSaleEffects(db, sale, { paymentTotal, userId }) -> void` — must be called inside the caller's `db.transaction`. Does exactly what the cancel transaction does today after setting status: customer `total_spent`/`credit_balance` revert (same formula), cancel open production tasks, restore product/material stock per item (same three branches), set `stock_deducted = 0`. It does **not** change `sales.status` or any register.

- [ ] **Step 1: Add a regression check** to `verify-quick-sale.js`: `cancel still restores product stock` — make a ₹0-paid pickup sale of a stocked test product via `POST /sales` (no payment), cancel it, assert `product_stock.quantity` back to its starting value and `sales.stock_deducted = 0`. Run → PASS before the change (records today's behaviour).
- [ ] **Step 2: Move** the loop and customer revert into `reverseSaleEffects`; cancel calls it with `paymentTotal` it already computed and `req.user.id`.
- [ ] **Step 3: Run** `verify-quick-sale.js`, `verify-order-flows.js`, `verify-register-expenses.js` → all pass, counts unchanged.
- [ ] **Step 4: Commit** `refactor: extract sale reversal from cancel for reuse`.

### Task 3: Undo route

**Files:**
- Create: `server/routes/quick-sale.js`
- Modify: `server/server.js` (mount `app.use('/api/quick-sale', quickSaleRoutes)` after `/api/sales`)

**Interfaces:**
- Consumes: `reverseSaleEffects` (Task 2), `hasOpenRegister`/register lookup pattern from `utils/register-guard.js`.
- Produces: `POST /api/quick-sale/:saleId/undo` → `200 {success:true, data:{id, undone_at}}`. Errors (exact copy): 404 `Sale not found`; 400 `This sale isn't a quick sale entry` when `entry_mode` not in (`quick`,`close_topup`); 400 `Already undone` when cancelled; 409 `This sale is from a register that's already closed. Use Refund on the sale instead.` when the sale has any **cash** payment and either no register is open or that payment was created before the open register's `opening_time`. UPI/card-only entries from an earlier session may be undone; their register totals are only reversed for payments created at or after the open register's `opening_time`.
- Behaviour, one sync transaction: `status='cancelled'`, `undone_by`, `undone_at=NOW()`; for each current payment row: cash → `total_cash_sales -= amt, expected_cash -= amt`; upi → `total_upi_sales -= amt`; card → `total_card_sales -= amt` (on the open register for that location, only if one is open); `reverseSaleEffects(db, sale, {paymentTotal, userId})`; insert `audit_logs` row (action `quick_sale_undo`, entity `sale`).

- [ ] **Step 1: Failing checks:**
  - `undo reverses register cash and excludes the sale at close` — open ₹100, cash entry ₹300, undo → register `expected_cash` back to 100; close with actual 100 → discrepancy 0.
  - `undo after method change reverses UPI not cash` — cash ₹250, `PUT /sales/:id` method→upi, undo → `total_upi_sales` and `expected_cash` back to their pre-entry values.
  - `undo twice is refused` → second call 400 `Already undone`.
  - `undo of a normal sale is refused` → 400 copy above.
  - `undo from a closed session is refused` — cash entry, close, reopen, undo → 409 copy; sale still not cancelled.
  - `UPI entry from a closed session can be undone without touching the new register` — UPI ₹120, close, reopen, undo → 200; new register's `total_upi_sales` unchanged.
  - `undo restores product stock` — quick entry for stocked test product → stock −1; undo → restored.
- [ ] **Step 2: Run** → FAIL (404 route).
- [ ] **Step 3: Implement** the router + mount.
- [ ] **Step 4: Run** → all checks pass; re-run the two other suites.
- [ ] **Step 5: Commit** `feat(quick-sale): undo route`.

### Task 4: Roll and tiles endpoints

**Files:**
- Modify: `server/routes/quick-sale.js`

**Interfaces:**
- Produces: `GET /api/quick-sale/roll?location_id=` → `{ success, data: { session_start, register_open, totals: {cash, upi, count}, entries: [{ id, created_at, item_name, amount, method, undone, entry_mode, created_by_name }] } }`. `session_start` = open register's `opening_time || opened_at`, else local midnight. Entries: this location, `entry_mode IN ('quick','close_topup')`, `created_at >= session_start`, newest first, max 200. `method` = method of the sale's largest payment row (current rows). `totals` exclude undone entries; cash/upi summed from current payment rows.
- Produces: `GET /api/quick-sale/tiles?location_id=` → `{ success, data: { source: 'owner'|'suggested', tiles: [{ key, type, product_id|null, label, price }] } }`. Owner source: parse setting `quick_sale_tiles`; product tiles resolved to current `name`/`selling_price`, inactive or missing products dropped; label tiles passed through (price > 0 only); max 12. Suggested source (setting missing/empty/invalid JSON): top 12 active products by count of `sale_items` at this location in the last 30 days, non-cancelled sales. `key` = `p<product_id>` or `l<index>`.

- [ ] **Step 1: Failing checks:**
  - `roll lists this session's entries newest first with totals` — open, cash ₹200, upi ₹150, cash ₹50, undo the ₹50 → 3 entries newest first, the ₹50 `undone:true`, totals `{cash:200, upi:150, count:2}`.
  - `roll ignores entries from before the session` — close, reopen → roll empty.
  - `tiles fall back to suggested when the setting is empty`.
  - `owner tiles resolve current price and drop inactive products` — set `quick_sale_tiles` via `PUT /settings` to one active product, one inactive product, one label tile → 2 tiles; product tile price equals current `selling_price`; restore the setting in cleanup.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → pass.
- [ ] **Step 5: Commit** `feat(quick-sale): roll and tiles endpoints`.

### Task 5: Register close preview

**Files:**
- Modify: `server/routes/sales.js` — `PUT /register/close` (~721-860)

**Interfaces:**
- Produces: body `preview: true` → after computing `expectedCash`/`discrepancy`, return `200 {success:true, data:{ preview:true, expected_cash, actual_cash, discrepancy }}` with **no writes**. Without `preview`, behaviour unchanged. (`discrepancy = expected − actual`, so excess cash is negative.)

- [ ] **Step 1: Failing checks:**
  - `preview writes nothing` — open ₹100, cash entry ₹200, preview with actual 500 → `expected_cash 300`, `discrepancy -200`; register still open, `closed_at` null, row unchanged.
  - `top-up then close gives zero discrepancy` — `quickSale(₹200, cash, 'Unrecorded sales (booked at close)', entryMode 'close_topup')` then real close with 500 → discrepancy 0; the top-up sale has `entry_mode='close_topup'`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (early return placed after the expected-cash computation, before the first UPDATE). **Step 4: Run** all three suites → pass.
- [ ] **Step 5: Commit** `feat(register): close preview for top-up offer`.

### Task 6: App logic module + API client

**Files:**
- Create: `app/src/utils/quickSale.js`
- Create: `app/scripts/test-quick-sale.js` (loads the module through `@babel/core` `transformFileSync` with `babel-preset-expo`, compiles it with `module._compile`, runs plain `assert` tests; exits 1 on failure)
- Modify: `app/src/services/api.js` (methods next to `createSale`)

**Interfaces:**
- Produces in `quickSale.js`:
  - `QUICK_LABELS` (the 8 chips), `MAX_QUICK_AMOUNT = 100000`, `DEFAULT_QUICK_LABEL = 'Counter sale'`, `TOPUP_LABEL = 'Unrecorded sales (booked at close)'`.
  - `amountError(text) -> '' | 'Type the amount first' | 'That looks too big — check the amount'`.
  - `buildQuickSalePayload({ locationId, method, amount, label, productId, entryMode = 'quick' }) -> object` for `POST /api/sales` (shape per Global Constraints; product line includes `product_id`, quantity 1, `unit_price` = amount; label line has `product_name` = label || default).
  - `createTapGuard(windowMs = 700) -> (key, now) => boolean` (true = accept).
  - `createSequentialSender(sendFn, onChange) -> { enqueue(entry) -> localId, retry(localId) }` — sends one at a time in enqueue order; each entry's state `'saving' | 'saved' | 'failed'` with `saleId` when saved; `retry` re-sends only a `failed` entry.
- Produces in `api.js`: `undoQuickSale(saleId)`, `getQuickRoll(locationId)`, `getQuickTiles(locationId)`, `previewRegisterClose({location_id, actual_cash})` (calls close with `preview:true`).

- [ ] **Step 1: Write tests** in `test-quick-sale.js`: `amountError('')`, `('0')`, `('100001')`, `('350')`; payload for label, for product, for topup (`entry_mode:'close_topup'`, name = `TOPUP_LABEL`); tap guard: same key at t=0 and t=500 → second false, at t=800 → true, different key at t=100 → true; `sequentialSender keeps tap order` (fake send with varying delays → resolved order equals enqueue order); `sequentialSender retries one failed entry once` (2nd of 3 fails → states saved/failed/saved; `retry` → saved, `sendFn` called exactly 4 times).
- [ ] **Step 2: Run** `cd app && node scripts/test-quick-sale.js` → FAIL (module missing).
- [ ] **Step 3: Implement** module + API methods.
- [ ] **Step 4: Run** → all pass; babel-check `api.js`.
- [ ] **Step 5: Commit** `feat(quick-sale): app logic and api client`.

### Task 7: Quick sale panel + mode switch

**Files:**
- Create: `app/src/components/quickSale/QuickSalePanel.js` (method toggle, first-use card, tiles grid, amount + chips + Add, register-closed state)
- Create: `app/src/components/quickSale/QuickSaleRoll.js` (totals line, rows with state, Undo/Redo toast, row action sheet)
- Modify: `app/src/screens/QuickCheckoutScreen.js` (mode state + switch above the existing `ScrollView` ~line 1488)
- Read first: `staff-ux-checklist` and `app-ui-quality` skills.

**Interfaces:**
- Consumes: Task 6 module and API methods; `OpenRegisterForm` from `app/src/components/OpenRegisterSheet.js`; `printOrderSlip`; `api.getRegisterStatus`, `api.updateSale` (method change), navigation to `SaleDetail` (Add details).
- Produces: `<QuickSalePanel locationId navigation />` — self-contained; `<QuickSaleRoll locationId entries pending onUndo onRedo onRetry onChangeMethod onPrint onAddDetails />`.
- Behaviour pinned by the spec: §5.1 colours (Cash = `Colors.success`, UPI = blue from theme; selected button filled, pad area tinted), method remembered in AsyncStorage `@petal_quick_method`; §5.2 tiles ≥ 64 px tall, 3 columns on phones, 4 at ≥ 600 px width, tile refresh on screen focus and every 60 s, refresh when the server returns the inactive-item message; §5.3 amount box auto-focused, Enter submits, Add button label `+ Add ₹<amount>`, chip applies to the next entry only; §5.4 optimistic rows via `createSequentialSender`; §5.5 Undo with 5 s Redo toast (Redo = new entry with the same payload), row tap opens a sheet with Change to UPI/Cash, Print bill, Add details, Undo; §5.6 Cash + register closed → `OpenRegisterForm` replaces tiles and amount, with the exact spec line; UPI stays usable; §5.7 first-use card stored as seen under `@petal_quick_help_seen`, "ⓘ How this works" reopens it. Mode switch reads/writes `@petal_checkout_mode`; route params listed in Global Constraints force `'full'`. The panel never scrolls as a whole; only the roll list scrolls.

- [ ] **Step 1:** Implement both components and the switch. Babel-check all three files.
- [ ] **Step 2: On-screen check** (web, throwaway counter_staff per the 2026-11-01 handoff §5; restart Metro first): 10 rapid tile taps → 10 rows saved in order, totals right; double tap one tile → 1 sale; stop the API, tap a tile → red "Not saved — tap to try again", start API, tap row → saved once; Cash with register closed → open form → entries resume; UPI with register closed works; Undo → toast → Redo; Change to UPI moves the row colour and totals; Print opens the slip; Add details opens Sale Details; Full order still places a normal order; reload keeps the chosen mode. Count taps against spec §3 and write the counts in the commit message body. Delete all test data and the account afterwards.
- [ ] **Step 3: Commit** `feat(quick-sale): quick sale mode in Quick Checkout`.

### Task 8: Owner tiles editor

**Files:**
- Create: `app/src/screens/QuickSaleTilesScreen.js`
- Modify: `app/src/navigation/MainNavigator.js` (register in the stack that holds `Settings`)
- Modify: `app/src/screens/SettingsScreen.js` (owner-only row "Quick sale buttons" → the new screen)

**Interfaces:**
- Consumes: `api.getQuickTiles`, `api.getSettings`, `api.updateSettings({ quick_sale_tiles: JSON.stringify(list) })`, product search via the existing products API.
- Behaviour: list of current tiles (resolved names/prices), add product (search), add label + price, remove, move up/down, max 12 (Add disabled with "12 buttons is the most that fit"), Save. Shows "Showing suggested buttons — add your own to replace them" when `source:'suggested'`.

- [ ] **Step 1:** Implement; babel-check.
- [ ] **Step 2: On-screen check** as owner on a throwaway setting value: add 2 product tiles + 1 label tile, reorder, save → Quick sale panel shows them in that order; restore the original `quick_sale_tiles` value afterwards.
- [ ] **Step 3: Commit** `feat(quick-sale): owner editor for quick sale buttons`.

### Task 9: Close top-up on the Cash Register screen

**Files:**
- Modify: `app/src/screens/CashRegisterScreen.js` — `handleClose` (~line 251-290)

**Interfaces:**
- Consumes: `api.previewRegisterClose`, `buildQuickSalePayload({…, entryMode:'close_topup', label: TOPUP_LABEL, method:'cash'})`, `api.createSale`, `api.closeRegister`, `showAlert`.
- Behaviour: on Close, call preview. If `-discrepancy >= 1`, show an in-screen panel (not a native dialog): `₹<excess> more than recorded. Book it as unrecorded sales?` with **Book ₹<excess> as sales** (create top-up sale, then close) and **No, close as it is** (close). Otherwise keep today's confirm-then-close path. The messages this flow shows after closing (result with discrepancy, errors) switch from `Alert.alert` to `showAlert` so they appear on web.

- [ ] **Step 1:** Implement; babel-check.
- [ ] **Step 2: On-screen check** (throwaway counter_staff, Test Loc): open ₹100, one quick cash ₹200, close with 500 → panel shows ₹200 → Book → closed, result message visible on web, top-up sale present with `entry_mode='close_topup'`; second session: close with a shortage → no panel, shortage reported. Clean up.
- [ ] **Step 3: Commit** `feat(register): book extra cash as sales at close`.

### Task 10: Final verification and docs

- [ ] **Step 1:** Run all server suites with the handoff env: `verify-quick-sale.js`, `verify-order-flows.js` (64), `verify-register-expenses.js` (13), `verify-order-requests.js` (21), wait 65 s, `verify-slip-and-open-requests.js` (34). Run `node app/scripts/test-quick-sale.js`. Record counts.
- [ ] **Step 2:** One end-to-end on-screen pass of the spec §11 counted flows (tile 1 tap, amount + 1, undo 1, method 2, print 2, mode switch 1).
- [ ] **Step 3:** Add a roadmap entry under sub-project 1 in `CLAUDE.md` (what shipped, test counts, the two plan deviations, deploy note: server before app).
- [ ] **Step 4:** Commit `docs: quick sale shipped`. Ask the user before pushing or opening a PR.
