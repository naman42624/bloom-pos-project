# Helpers: Role, Joining & Selling Implementation Plan (scan-and-sell spec, part 3 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Temporary helpers get a time-limited `helper` account, join on their own phone from a QR, and sell by scanning — taking cash or UPI themselves, with discounts up to their limit or a PIN override — while the server sets every price. Cash goes straight to the register in this part (bag mode is part 4).

**Architecture:** New role + `users.access_until` checked in the existing auth middleware; one-time hashed join tokens; PIN verification extracted from `staff-login` into a util shared with discount overrides; helper-specific rules enforced inside `POST /api/sales` by role; a helper app shell with two tabs (Sell, My sales) and a personal-device lock screen.

**Tech Stack:** Express + `pg`, bcrypt PIN hashing (`server/utils/pin.js`), `qrcode`, Expo / React Native Web.

**Spec:** `docs/superpowers/specs/2026-11-02-scan-sell-helpers-staff-sales-design.md` §8, §9, §10, §13, §15.

**Prerequisites:** quick-sale plan, staff-sales plan (`sold_by`, `assertValidSeller`, report) and labels/scanner plan (`POST /products/scan`, `ProductScanner`, options, price modes) merged. Branch `feature/helpers`.

## Global Constraints

- Additive schema only; `db-migration-safety` first. The role constraint change uses the existing drop-and-re-add pattern for `users_role_check` in `database.js`, **widening only**: `('owner','manager','employee','counter_staff','florist_staff','delivery_partner','customer','helper')`. Also add `'helper'` to `VALID_ROLES` in `server/routes/users.js`.
- No existing route is widened except the ones listed in Task 3's authorize table.
- Expired-access copy exact: `Your access ended on <D Mon>. Ask the owner if you need more days.` (HTTP 401). Join link copy: `This link has been used or has expired. Ask the owner for a new code.` Discount copy: `This discount needs the counter's OK.`; `That PIN didn't match. <n> tries left.`; `This discount needs a manager or the owner.` Register copy (register mode): `The counter hasn't opened the register yet. Ask them to open it, then try again.` Save failed: `Couldn't save — check the internet and tap Take payment again. Nothing was charged twice.` Custom item refused: `Helpers can only sell items from the catalog.`
- Join tokens: 32 random bytes, base64url, stored as SHA-256 hash, valid 24 h, single use; issuing a new one invalidates the old.
- Default `Works until` = today + 7 days. `discount_helper_threshold` setting seeded (if absent) to the current `discount_manager_threshold` value.
- Helper sale: `order_type 'walk_in'`, `channel 'walk_in'`, `sold_by` = helper, `skip_assignment` true, status completed, full payment in cash and/or upi (sum must equal grand total), no customer credit, no free-text items. Server prices fixed products/options from the catalog and ignores client `unit_price`; `open` products take the client price (> 0).
- Idempotency: `sales.client_ref VARCHAR(64)` with unique index on `(created_by, client_ref)` where `client_ref IS NOT NULL`; a repeat returns the existing sale with 200.
- Helper undo: own sale, ≤ 2 minutes old (part 4 adds "and no handover since").
- Helper app: tabs **Sell** and **My sales** only. Personal-device marker in local storage `@petal_personal_device` = user id.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Decision carried from planning (confirm with the user at Task 3):** managers and the owner have no employee code or PIN today (checked 2026-11-02: owner 0/1, managers 0/2, counter staff 2 of 10 with a PIN). Task 3 lets the owner give managers and themself an **approval PIN** (code auto-assigned). That PIN works only for discount approval — `staff-login` keeps excluding owner/manager, so it never logs anyone in on a counter device.

## Review Focus

1. A helper whose `access_until` is today can still work all day; it ends at local midnight after that date (Task 1 check `access ends after the date, not on it`).
2. Double "Take payment" taps / a retry after a dropped response creates one sale (Task 4 check `client_ref makes retries safe`).
3. Override PIN brute force: wrong PINs on overrides count toward the same lockout as login (Task 3 check `override failures lock the approver`).
4. A helper crafting a request with `unit_price: 1` for a ₹500 product is charged ₹500 (Task 4 check `helper prices come from the catalog`).
5. A helper opening the app after access ended sees the plain message on the lock screen, not a blank app (Task 6 on-screen step).

---

### Task 1: Role, access window, auth middleware

**Files:**
- Modify: `server/config/database.js` (role constraint widening; `users.access_until DATE`; `sales.client_ref` + partial unique index; table `helper_join_tokens (id SERIAL PK, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash VARCHAR(64) NOT NULL UNIQUE, expires_at TIMESTAMP NOT NULL, used_at TIMESTAMP, created_by INT REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`; settings seed for `discount_helper_threshold`)
- Modify: `server/middleware/auth.js` (both user SELECTs include `access_until`; helper past date → 401 exact copy)
- Modify: `server/routes/users.js` (`VALID_ROLES`; create requires `access_until` for helpers and auto-assigns an `employee_code` like counter staff; `PUT /:id` can change `access_until`)
- Create: `server/scripts/verify-helpers.js`

**Interfaces:**
- Produces: `isAccessExpired(accessUntil, today = localToday()) -> boolean` in `server/utils/helper-access.js` (true only when `accessUntil < today`).

- [ ] **Step 1: Failing checks:** `helper can be created with access_until and gets an employee code`; `helper without access_until refused`; `access ends after the date, not on it` (unit-call `isAccessExpired('2026-11-02','2026-11-02') === false`, `('2026-11-01','2026-11-02') === true`; and a helper with yesterday's date → 401 exact copy on `GET /auth/me`); `deactivated helper is signed out` (403 existing copy).
- [ ] **Step 2–4:** Run → FAIL; implement; restart API; run this + `verify-identity-roles.js` → pass.
- [ ] **Step 5: Commit** `feat(helpers): helper role and access window`.

### Task 2: Join flow (server)

**Files:**
- Create: `server/utils/join-token.js`
- Modify: `server/routes/users.js` (`POST /:id/join-link`, owner/manager, helper targets only)
- Modify: `server/routes/auth.js` (`GET /join/:token`, `POST /join` — public, own per-IP limiter 20/min; `staff-login` role list adds `'helper'`)
- Modify: `server/scripts/verify-helpers.js`

**Interfaces:**
- Produces: `createJoinToken(db, userId, createdBy) -> { token, expires_at }` (invalidates older unused tokens), `consumeJoinToken(db, token) -> userId | null`.
- Produces: `POST /api/users/:id/join-link` → `{ success, data: { url: "<PUBLIC_APP_URL>/join/<token>", expires_at, qr_data_url } }`; `GET /api/auth/join/:token` → `{ success, data: { name } }` or 410 join copy; `POST /api/auth/join` body `{ token, pin }` (4 digits) → sets `pin_hash`, consumes token → `{ success, data: { token: <jwt>, user, locations } }` (same shape as `/auth/login`); 410 join copy when used/expired/unknown.

- [ ] **Step 1: Failing checks:** `join link is single use`; `new link cancels the old`; `expired link refused` (set `expires_at` in the past via SQL); `join sets pin and returns a session`; `helper can staff-login with code and pin`; `join link for a non-helper refused`.
- [ ] **Step 2–4:** Run → FAIL; implement; run → pass.
- [ ] **Step 5: Commit** `feat(helpers): one-time join links`.

### Task 3: Approval PIN util and route access

**Files:**
- Create: `server/utils/approval-pin.js`
- Modify: `server/routes/auth.js` (`staff-login` uses the util — behaviour and copy unchanged)
- Modify: `server/routes/users.js` (`PUT /:id/pin`: also owner/manager targets, auto-assigning an `employee_code` when missing)
- Modify: the `authorize()` lists in this table only, adding `'helper'`:

| Route | Why |
|---|---|
| `POST /api/sales` | selling (rules in Task 4) |
| `POST /api/products/scan` | scanning |
| `GET /api/products` (strip `estimated_cost` for helpers) | Find by name / photo grid |
| `GET /api/settings/shop-info` (add `upi_qr_image_url` to its response if not present) | UPI QR on the payment screen |
| `POST /api/quick-sale/:saleId/undo` (rules in Task 5) | own undo |
| `GET /api/sales/register/status` | "register open?" hint |

**Interfaces:**
- Produces: `verifyApprovalPin(db, employeeCode, pin) -> Promise<user>`; throws `{ status: 401, message: "That PIN didn't match. <n> tries left." }` / lockout message exactly as `staff-login` words it; uses and updates `pin_failed_attempts`/`pin_locked_until` the same way. Allowed approver roles: `counter_staff, employee, manager, owner`.
- Produces: `approverMaxDiscountPct(role, settings) -> number` (counter_staff/employee → `discount_manager_threshold`; manager → `discount_owner_threshold`; owner → Infinity).

- [ ] **Step 0: Confirm with the user** the approval-PIN decision above (one question; record the answer in the ledger).
- [ ] **Step 1: Failing checks:** `staff-login unchanged` (existing identity-roles suite); `manager can be given an approval PIN`; `manager approval PIN cannot log in at the counter` (staff-login → 401); `override failures lock the approver`; `helper cannot read estimated_cost from product list`; `helper cannot call counter routes` (e.g. `PUT /sales/:id/cancel`, `GET /customers`, `POST /expenses` → 403).
- [ ] **Step 2–4:** Run → FAIL; implement; run this + `verify-identity-roles.js` → pass.
- [ ] **Step 5: Commit** `feat(helpers): approval PIN and helper route access`.

### Task 4: Helper sale rules in `POST /api/sales`

**Files:**
- Create: `server/utils/helper-sale.js`
- Modify: `server/routes/sales.js` (`POST /`: when `req.user.role === 'helper'`, call the util before item building; accept `client_ref`, `discount_override: { employee_code, pin }`, items with `option_id`)
- Modify: `server/scripts/verify-helpers.js`

**Interfaces:**
- Produces: `normalizeHelperSale(db, body, user) -> body'` — forces the fixed fields, refuses custom items (exact copy), resolves each line's price (`option_id` → `product_options.price` and name `<product> (<label>)`; fixed → `selling_price`; open → client price > 0), refuses inactive (`Not for sale right now — ask the counter.`) and sold one-off products, refuses credit/partial/card, refuses payment sum ≠ grand total.
- Produces: `checkHelperDiscount(db, { pct, override }) -> { approvedBy: userId|null }` using `discount_helper_threshold`, `verifyApprovalPin`, `approverMaxDiscountPct`.
- `client_ref` lookup happens first: an existing `(created_by, client_ref)` returns that sale (200) without writing.

- [ ] **Step 1: Failing checks:** `helper prices come from the catalog`; `helper option price and name`; `helper open price uses typed price`; `helper custom item refused`; `helper credit refused`; `helper discount within limit ok`; `helper discount over limit needs override` (exact copy); `override by counter staff above manager threshold refused`; `override by manager ok and recorded in discount_approved_by`; `client_ref makes retries safe`; `cash with closed register refused with helper copy`; `sold_by is the helper`.
- [ ] **Step 2–4:** Run → FAIL; implement; run this, `verify-order-flows.js`, `verify-quick-sale.js`, `verify-staff-sales.js` → pass.
- [ ] **Step 5: Commit** `feat(helpers): server-enforced helper selling rules`.

### Task 5: Helper undo and "my sales"

**Files:**
- Modify: `server/routes/quick-sale.js` (undo accepts a helper's own sale ≤ 2 min old; other helper calls → 403)
- Create: `GET /api/quick-sale/my-sales` in the same router (helper and staff roles: today's non-cancelled + undone sales where `sold_by` = caller at the caller's location, newest first, with `count` and per-method totals)
- Modify: `server/scripts/verify-helpers.js`

- [ ] **Step 1: Failing checks:** `helper can undo own sale within 2 minutes`; `helper cannot undo after 2 minutes` (age the row via SQL); `helper cannot undo someone else's sale`; `my-sales lists only the caller's sales today`.
- [ ] **Step 2–4:** Run → FAIL; implement; run → pass.
- [ ] **Step 5: Commit** `feat(helpers): helper undo and my sales`.

### Task 6: Helper app shell, join page, personal lock screen

**Files:**
- Create: `app/src/screens/JoinScreen.js` (public, routed in `app/App.js` on `^\/join\/([A-Za-z0-9_-]+)$`)
- Modify: `app/App.js`, `app/src/context/AuthContext.js` (`completeJoin(session)` storing token/user/location exactly like `login`, plus `@petal_personal_device`), `app/src/screens/LockScreen.js` (personal device → only that user's PIN pad; shared device roster excludes `role === 'helper'`; expired-access 401 copy shown on the lock screen), `app/src/navigation/MainNavigator.js` (role `helper`: tabs Sell, My sales only)
- Modify: `VPS_DEPLOYMENT_GUIDE.md` §17 (`/join/` SPA fallback)

**Interfaces:**
- Behaviour: Join page greets `Hi <name> 👋`, "Set a 4-digit PIN you'll remember", two PIN entries, mismatch → "The two PINs don't match — try again", success lands on Sell. Used/expired → join copy, no form.

- [ ] **Step 1:** Implement; babel-check.
- [ ] **Step 2: On-screen check** (owner creates a throwaway helper via API; open the join URL in a fresh browser profile): PIN set → Sell tab; reload → personal lock screen shows only that helper; reuse the link → join copy; set `access_until` to yesterday → lock screen shows the access-ended copy. Remove the helper afterwards.
- [ ] **Step 3: Commit** `feat(helpers): join page, helper tabs, personal lock screen`.

### Task 7: Sell screen and Take payment

**Files:**
- Create: `app/src/screens/helper/SellScreen.js`, `app/src/screens/helper/MySalesScreen.js`, `app/src/components/helper/TakePaymentSheet.js`, `app/src/components/helper/OverridePad.js`, `app/src/components/helper/PriceCardsSheet.js`
- Create: `app/src/utils/helperBasket.js` + `app/scripts/test-helper-basket.js` (babel loader as in `test-quick-sale.js`)
- Read first: `staff-ux-checklist`, `app-ui-quality`.

**Interfaces:**
- Consumes: `ProductScanner`, `ScanAddModal` pieces (size picker, open price prompt), `POST /products/scan`, `GET /products` (Find by name + photo grid), price-card products = active products in category named `Price cards`, `GET /settings/shop-info` (`upi_qr_image_url`), `POST /sales` (helper shape, `client_ref`), `printOrderSlip`, `GET /quick-sale/my-sales`, undo.
- Produces (`helperBasket.js`): `addLine(basket, { product_id, option_id, name, unit_price, price_mode }) -> basket` (merges same product+option+price), `changeQty(basket, key, delta) -> basket` (0 removes), `basketTotal(basket, discount) -> { subtotal, discount, total }`, `toSalePayload(basket, { locationId, payments, discount, override, clientRef }) -> object`, `changeDue(total, given) -> number`.
- Behaviour pinned by spec §9: first-use card (`@petal_helper_help_seen`), basket persisted in `@petal_helper_basket`, Clear basket with Undo toast, **Take payment ₹X** bar, Discount (₹ or %; over limit → "This discount needs the counter's OK" → **Ask counter to approve** → OverridePad), Cash with optional "Customer gave ₹" → "Give back ₹Y", UPI full-screen QR + "Customer has paid" (no QR uploaded → spec copy), Part cash/part UPI, optional customer phone for the WhatsApp bill, success ✓ with Share/Print and **Next customer** (auto after 4 s), `client_ref` = new random id per basket, kept across retries until success. My sales: today's list, count, own cash total masked (first digit kept, rest `x`, under ₹100 all `x`) and revealed on tap for 15 s, Undo on sales ≤ 2 min old.

- [ ] **Step 1: Unit tests** for `helperBasket.js` (merge, qty to 0 removes, total with ₹ and % discount, payload shape with option_id and client_ref, change due) → FAIL → implement → PASS.
- [ ] **Step 2:** Implement the screens; babel-check.
- [ ] **Step 3: On-screen check** (throwaway helper on a phone over HTTPS per the scanner spike's setup, plus desktop web): scan 3 items incl. a size and an open-price item → cash with change → success → next customer; UPI path; discount within limit; over limit → counter staff override (throwaway counter_staff code + PIN); wrong PIN copy; kill the network on Take payment → retry → one sale; undo within 2 min. Count taps (spec §15: sell cash = 3). Remove all test data.
- [ ] **Step 4: Commit** `feat(helpers): sell screen and take payment`.

### Task 8: Owner/manager helper management + settings

**Files:**
- Create: `app/src/screens/AddHelperScreen.js` (name, phone, Works until date — default today + 7, location), `app/src/screens/HelperJoinQRScreen.js` (QR from `qr_data_url`, Share on WhatsApp with the URL, the 3 spoken steps, "Make a new code")
- Modify: staff/users list (an **Add helper** button for owner/manager; helpers tagged "Helper · until 15 Nov"), `app/src/screens/UserFormScreen.js` (Works until for helpers; **Approval PIN** for manager/owner targets, owner only), `app/src/screens/SettingsScreen.js` (Helper discount limit %, owner only)

- [ ] **Step 1:** Implement; babel-check.
- [ ] **Step 2: On-screen check** as owner: add helper → QR → join from a second browser profile; extend Works until; set a manager approval PIN and use it in an override; change the helper discount limit and see it enforced. Remove test data.
- [ ] **Step 3: Commit** `feat(helpers): add helper, join QR, approval PIN, discount limit`.

### Task 9: Final verification

- [ ] Run `verify-helpers.js`, `verify-staff-sales.js`, `verify-quick-sale.js`, `verify-labels-scanner.js` (last), `verify-order-flows.js`, `verify-identity-roles.js`, `verify-register-expenses.js`; app unit scripts.
- [ ] CLAUDE.md roadmap + "Known structural debt" note (new role, `/join/` deploy step), commit `docs: helpers shipped`. Ask before push/PR.
