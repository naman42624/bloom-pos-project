# Slip QR, Open Order Link & Checkout Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the five approved items: slip QR scan page with the shared load checklist (deliveries and pickups), a general order-request link that registers the customer only on approval, saved-address chips at checkout, complete checkout drafts, and collecting dues during checkout plus the audited round-trip fixes.

**Architecture:** New public, unauthenticated routes (`/api/slip`, `/api/order-request/open|status`) follow the existing `track.js` / `order-request-public.js` pattern: HMAC or random tokens, a per-file per-IP limiter, and generic 404s. The public web pages bypass React Navigation in `App.js`, the same way `TrackingScreen` does. All schema changes are additive `database.js` patches. Staff-screen changes reuse the existing components, `showConfirm`/`showAlert`, and `useSubmitGuard`.

**Tech Stack:** Express + pg (`database-async.js` for new code), Expo React Native (web), `qrcode` (already a server dependency).

**Spec:** `docs/superpowers/specs/2026-10-28-slip-qr-open-orders-checkout-design.md`. Section numbers like §3.2 below refer to it.

## Global Constraints

- Schema changes are additive only (new tables or nullable columns), written in `server/config/database.js` with `ensureColumn` or `CREATE TABLE IF NOT EXISTS`. Never hand-edit the dev DB. Read the `db-migration-safety` skill before Task 1.
- New server code uses `database-async.js` `getDb()`. Never put an apostrophe inside a `--` SQL comment.
- Public responses never include prices, totals, payments, phone numbers, addresses, customer/receiver names or staff names (§3.2).
- Public errors: a bad or expired token gives 404 `{ success:false, message:'Not found' }`, and the limiter gives 429.
- Staff dialogs with buttons use `showConfirm`/`showAlert` from `app/src/utils/alert.js`, never `Alert.alert` with buttons.
- Create/submit buttons wrap their `onPress` with `useSubmitGuard`.
- Staff-facing copy is plain language and says what to do next. Run the `staff-ux-checklist` skill on every staff screen touched.
- After any `app/` edit, `node app/scripts/babel-check.js <files>` passes.
- Verify scripts run against a server started with `TRACKING_LINK_SECRET=verify-secret`, with env `TRACKING_LINK_SECRET=verify-secret VERIFY_OWNER_PHONE=9876453210 VERIFY_OWNER_PASSWORD=naman1234`. Throwaway data goes at location 4 (Test Loc) and is cleaned up by the script.
- Existing suites stay green: `server/scripts/verify-order-flows.js`, `verify-register-expenses.js`, `verify-order-requests.js`, `verify-settlement-math.js`, `app/scripts/verify-delivery-action-rules.js`.

## Review Focus

1. **A converted order** (delivery → pickup) opened from an old slip: the checklist must follow the current type (§3.3) and must not 500 when a pickup has no delivery row. Test in Task 2.
2. **The public slip response leaking a sensitive field** through `SELECT *` or a spread. Task 2's test checks every key against a deny-list, recursively.
3. **The same phone in different formats** (`+91 98765 43210`, `098765 43210`, `9876543210`) must resolve to one customer, and calling resolve twice must not create two. Test in Task 4.
4. **Collecting dues when the order saves but the dues call fails**: the order must stand and staff must see the exact §7 message. Test in Task 8 with a forced failure (for example, the register closed between the check and the call).
5. **Resuming a draft whose voice-note files were deleted from disk**: the order must still place, with the missing notes skipped and named in one plain message. Test in Task 7.

---

### Task 1: Schema, slip token, trust proxy

**Files:**
- Modify: `server/config/database.js` (append patches next to the existing `delivery_load_checks` / `order_requests` patches)
- Create: `server/utils/slip-token.js`
- Modify: `server/server.js` (after `const app = express()`)
- Test: `server/scripts/verify-slip-and-open-requests.js` (create; later tasks append checks)

**Interfaces:**
- Produces: `generateSlipToken(saleId) -> string`, `verifySlipToken(token) -> number|null`, `slipUrl(saleId) -> string`, all exported from `server/utils/slip-token.js`.
- Produces tables and columns: `delivery_load_checks.checked_via TEXT`; table `pickup_load_checks(id SERIAL PK, sale_id INT NOT NULL REFERENCES sales(id) ON DELETE CASCADE, sale_item_id INT NOT NULL REFERENCES sale_items(id) ON DELETE CASCADE, checked BOOLEAN DEFAULT false, checked_by INT NULL, checked_via TEXT NULL, checked_at TIMESTAMP NULL, UNIQUE(sale_id, sale_item_id))`; and `order_requests.requester_name VARCHAR(80)`, `.requester_phone VARCHAR(20)`, `.status_token TEXT` (plus a unique index), `.source TEXT`.

- [ ] **Step 1: Write the failing test.** Create the verify script with the same harness as `verify-order-flows.js` (`check()`, `api()`, `loginOwner()`, cleanup of `createdSaleIds`), plus these checks:
  - `generateSlipToken(42)` round-trips through `verifySlipToken` to `42`.
  - A tampered token gives `null`, and so does `generateTrackingToken(42)` from `server/utils/tracking-token.js`.
  - `verifyTrackingToken(generateSlipToken(42))` gives `null`. Use the tracking util's real export names.
  - In `information_schema`, `pickup_load_checks` exists, and so do `delivery_load_checks.checked_via` and `order_requests.status_token`.
- [ ] **Step 2: Run it and confirm it fails** (module not found or the table is missing).
- [ ] **Step 3: Implement.**
  - **`slip-token.js`:** reuse the tracking secret (import it, or read the env the same way with the same production guard). HMAC message is `'slip:' + saleId`, 32 hex characters, compared with `crypto.timingSafeEqual`. `slipUrl` uses the same `PUBLIC_APP_URL` resolution as `tracking-token.js:72`.
  - **`server.js`:** `app.set('trust proxy', 1);` with the comment: "One Nginx hop in production (VPS_DEPLOYMENT_GUIDE.md §9). If a CDN such as Cloudflare is put in front, raise this or every visitor counts as one for the public rate limiters."
  - **`database.js`:** the patches listed in Interfaces.
- [ ] **Step 4: Restart the server and run the script.** Expected: all checks pass. Run the existing suites too; expected unchanged.
- [ ] **Step 5: Commit:** `feat: slip token, pickup load checks table, order request requester columns, trust proxy`.

### Task 2: Slip public API, pickup-check API, slip fields on GET /sales/:id

**Files:**
- Create: `server/routes/slip-public.js`; mount `app.use('/api/slip', slipPublicRoutes)` in `server.js` next to `/api/track`
- Create: `server/utils/load-checks.js` (shared helpers)
- Modify: `server/routes/sales.js` (`GET /:id` adds `slip_url`/`slip_qr_svg`; new pickup-check routes), `server/routes/deliveries.js` (load-check toggle writes `checked_via='app'`)
- Test: append to `verify-slip-and-open-requests.js`

**Interfaces:**
- Consumes: Task 1 token util and tables.
- Produces, in `load-checks.js`:
  - `getChecklistForSale(db, sale) -> { enabled, kind: 'delivery'|'pickup'|null, items:[{sale_item_id, checked, checked_at}] }`. It creates rows lazily, and the sale's current `order_type` decides the table (pre_order uses its fulfilment type; walk_in gives `enabled:false`).
  - `setCheck(db, sale, saleItemId, checked, { userId, via }) -> checklist`. It throws a tagged error `{ status:404 }` when the item isn't on the sale, and `{ status:409, message }` when final. Final means delivery `delivered`/`cancelled`, or for a pickup `pickup_status='picked_up'`, or the sale is `cancelled`.
- Produces, routes:
  - `GET /api/slip/:token` and `PUT /api/slip/:token/check/:saleItemId` with the exact shapes in §3.2 (60/min limiter, own state).
  - `GET /api/sales/:id/pickup-checks` and `PUT /api/sales/:id/pickup-checks/:saleItemId`, open to owner, manager, employee and counter_staff.
  - `GET /api/sales/:id` gains `slip_url` and `slip_qr_svg`, for every role except customer, which gets neither. Riders keep them because they print the shop copy, and they're the main people who scan it.

- [ ] **Step 1: Write the failing tests.** Each check below is its own `check()`:
  - a delivery sale's public GET returns its items with `checklist.kind==='delivery'`;
  - a recursive key walk of the public JSON finds none of `price, unit_price, total, grand_total, amount, phone, address, customer_name, receiver_name, partner_name, created_by_name`, and the serialized body doesn't contain the receiver phone `9998887777` anywhere;
  - a public PUT tick shows in the app's `GET /deliveries/:id/load-checks` (use the real existing route name), and an app tick shows on the public GET;
  - the same round-trip for a pickup sale through `/sales/:id/pickup-checks`;
  - a delivery converted to pickup (`api.convertOrderType` route) returns `kind==='pickup'` and 200;
  - a `saleItemId` from another sale gives 404, and a delivered sale gives 409;
  - after `UPDATE sales SET status='completed', updated_at=NOW()-INTERVAL '8 days'` the public GET gives 404, and at 6 days it gives 200;
  - the owner's `GET /sales/:id` has an `slip_url` ending with the token and an `slip_qr_svg` starting with `<svg`;
  - 61 rapid public GETs give at least one 429. Run this check last, from its own token.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
  - **Item image:** `(SELECT pi.image_url FROM product_images pi WHERE pi.product_id = si.product_id ORDER BY pi.sort_order, pi.id LIMIT 1)`, falling back to `products.image_url`. Check the column names in `information_schema` first.
  - **Voice notes:** from `sale_attachments WHERE type='voice_note'`, split by `sale_item_id`.
  - **Card message:** `sales.sender_message`. Confirm the column name.
  - **QR:** `require('qrcode').toString(url, { type:'svg', margin:1 })`.
  - **App toggle:** the existing in-app delivery toggle must call `setCheck` so both paths share one implementation.
- [ ] **Step 4: Run the new script and all existing suites.** Expected: all pass.
- [ ] **Step 5: Commit:** `feat: public slip page API and shared delivery/pickup load checklist`.

### Task 3: Slip page, QR on shop copy, pickup checklist in Sale Details

**Files:**
- Create: `app/src/screens/SlipScreen.js`
- Modify: `app/App.js` (`getSlipToken()`, matched by `/^\/slip\/([^/]+)$/`, before the tracking check)
- Modify: `app/src/utils/printHelpers.js` (QR on the shop copy only)
- Modify: `app/src/components/DeliveryChecklist.js` (accept `{ deliveryId }` or `{ saleId, kind:'pickup' }`)
- Modify: `app/src/screens/SaleDetailScreen.js` (pickup checklist card)
- Modify: `app/src/services/api.js` (`getPickupChecks(saleId)`, `togglePickupCheck(saleId, saleItemId, checked)`)

**Interfaces:**
- Consumes: Task 2 routes and fields. `SlipScreen` uses plain `fetch` against the same API base `TrackingScreen` uses, never `api.js` with auth.

- [ ] **Step 1: Build `SlipScreen`** to §3.5:
  - an optimistic tick that rolls back with "Couldn't save, try again";
  - an "N of M packed" header;
  - an HTML `<audio controls>` player on web, the same way `AttachmentVoiceRow.js` plays on web (reuse it if it works without auth);
  - tap targets of at least 48px;
  - the expired-link copy exactly as in §3.5.
- [ ] **Step 2: QR on the shop copy only.** In `printOrderSlip`, include `sale.slip_qr_svg` only inside the shop-copy section, captioned "Scan to see items, photos & voice notes and tick the load". Render the slips headless (see session log §5) and confirm the customer copy has no `<svg`.
- [ ] **Step 3: Pickup checklist in Sale Details.** Show `DeliveryChecklist` with `kind:'pickup'` on pickup orders (and pre-orders fulfilled by pickup) that are not yet picked up, for owner, manager, employee and counter_staff.
- [ ] **Step 4: babel-check the touched files.** Then on web at `127.0.0.1:8081/slip/<token>` (token from the owner's `GET /sales/:id`):
  - ticking there shows on Sale Details, and the reverse;
  - a voice note plays;
  - an invalid token shows the expired copy.
- [ ] **Step 5: Commit:** `feat: slip scan page, QR on shop copy, pickup load checklist`.

### Task 4: General order-request link (server)

**Files:**
- Modify: `server/routes/order-request-public.js`. `GET /open`, `POST /open` and `GET /status/:statusToken` are declared **before** `/:token`.
- Modify: `server/routes/order-requests.js` (`POST /:id/resolve-customer`; the list adds `requester_name`, `requester_phone`, `source`, `matched_customer:{id,name}|null`)
- Create: `server/utils/phone.js` (`normalizeIndianPhone(raw) -> string|null`: strip spaces, dashes, `+91` and a leading `0`; return 10 digits or null). Reuse it if an equivalent already exists. Check `customers.js` first.
- Test: append to `verify-slip-and-open-requests.js`

**Interfaces:**
- Produces `POST /api/order-request/open` (body as the per-customer submit plus `requester_name`, `requester_phone`) → `201 { success, data:{ status_url } }`, and `GET /api/order-request/status/:statusToken` → `{ status, decline_reason, created_at, items_summary }`.
- Produces `POST /api/order-requests/:id/resolve-customer` → `{ customer_id, created:boolean }`, with the same roles as `GET /order-requests`.

- [ ] **Step 1: Write the failing tests:**
  - an open submit creates exactly one `order_requests` row with `customer_id NULL` and `source='general_link'`, and the `users` count is unchanged;
  - the status URL shows `pending`; another request's status token never returns this request; a random token gives 404;
  - resolve for a new phone creates one `role='customer'` user (`created:true`), and resolving again returns the same id (`created:false`);
  - a second open request from `+91 98765 4xxxx` (same digits, different format) resolves to that same customer;
  - declining an unresolved request leaves `users` unchanged;
  - a missing name or a 9-digit phone gives 400 with a plain message.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
  - `status_token = crypto.randomBytes(24).toString('hex')`.
  - Resolve runs in one transaction: `SELECT ... WHERE role='customer' AND phone = ? FOR UPDATE`, otherwise insert, with the same columns `POST /customers` sets. Then `UPDATE order_requests SET customer_id`.
- [ ] **Step 4: Run the new script plus `verify-order-requests.js` and the other suites.** Expected: all pass.
- [ ] **Step 5: Commit:** `feat: general order-request link with register-on-approve`.

### Task 5: General order-request link (app)

**Files:**
- Modify: `app/App.js`. Match `/order-request/open` and `/order-request/status/<t>` before the per-customer regex.
- Modify: `app/src/screens/OrderRequestScreen.js` (props `{ token }`, `{ mode:'open' }` or `{ statusToken }`)
- Modify: the staff Order Requests screen (find it by the `getOrderRequests` call): a share row; card labels "New customer" / "Matches: <name>"; Approve calls `resolve-customer` first when `customer_id` is null, then continues into `LogOrderScreen` exactly as today.
- Modify: `app/src/services/api.js` (`resolveOrderRequestCustomer(id)`)

- [ ] **Step 1: Open mode in `OrderRequestScreen`.** Name and phone fields at the top, required with plain inline errors. On success it shows the status link, with "Save this link to check your order", and offers to open it.
- [ ] **Step 2: Status-only mode** renders the same status block the per-customer page already uses.
- [ ] **Step 3: Staff screen.**
  - **Share row:** "Share order link" with Copy and WhatsApp, the same mechanism as `CustomerDetailScreen`'s Copy Order Link (web-safe share util).
  - **Approve:** goes through `useSubmitGuard`. If resolve fails, use `showAlert` with "Couldn't set up this customer — try again".
- [ ] **Step 4: babel-check, then on web:**
  - open link → submit → staff card shows "New customer" → Approve → the order form is pre-filled with the new customer → Save;
  - the status page shows Confirmed;
  - submitting again with the same phone shows "Matches: <name>".
- [ ] **Step 5: Commit:** `feat: open order link page and staff approve-with-registration`.

### Task 6: Saved-address chips and save-back

**Files:**
- Create: `app/src/components/SavedAddressChips.js` with props `{ customerId, receiverId, onPick(addressText) }`. It fetches `api.getCustomerAddresses` for each id, receiver group first and defaults first within each group. It renders nothing when there are no addresses, and chips are at least 44px tall.
- Create: `app/src/utils/addressMatch.js` (`sameAddress(a, b) -> boolean`: lower-case, collapse whitespace and commas, trim)
- Modify: `app/src/screens/QuickCheckoutScreen.js`, `app/src/screens/LogOrderScreen.js` (chips above the delivery address field when delivery is needed; save-back after a successful create)

- [ ] **Step 1:** Write `addressMatch.js` with a tiny assertion script at `app/scripts/verify-address-match.js`:
  - `sameAddress('12, Check Rd ', '12 check rd')` → true;
  - `sameAddress('12 Check Rd', '13 Check Rd')` → false.

  Run it and see it fail, then implement it and see it pass.
- [ ] **Step 2: Build `SavedAddressChips` and wire it into both screens.** Picking a chip fills the field the screen already uses for the delivery address.
- [ ] **Step 3: Save-back.** After the order is created, the target is `receiverId || customerId`. If its addresses contain no `sameAddress` match, `POST /customers/:id/addresses` with `{ label:'Saved from order', address: text, address_line_1: text }`. Check the route's required fields first. Wrap it in try/catch and only `console.warn` on failure.
- [ ] **Step 4: babel-check, then on web:** a known customer shows chips, a tap fills the field, and a new address appears on the profile after the order.
- [ ] **Step 5: Commit:** `feat: saved address chips at checkout and save new addresses back`.

### Task 7: Complete checkout drafts

**Files:**
- Modify: `app/src/screens/QuickCheckoutScreen.js` (`buildDraftPayload`, `applyDraftPayload`, draft save, place order)
- Modify: `server/routes/sale-attachments.js`. Add `POST /api/sales/attachments/draft-upload` (same multer config and roles as the existing upload; stores into `uploads/sale-attachments`; returns `{ url, duration_seconds }`) and `POST /api/sales/:saleId/attachments/from-url` (body `{ type:'voice_note', file_url, duration_seconds, sale_item_id? }`; `file_url` must match `^/uploads/sale-attachments/[A-Za-z0-9._-]+$` and exist on disk, otherwise 400).
- Modify: `app/src/services/api.js` (`uploadDraftVoiceNote`, `attachFromUrl`)
- Test: append server checks to `verify-slip-and-open-requests.js` (the from-url route rejects `../` and unknown files, and accepts a just-uploaded file)

- [ ] **Step 1: Write the failing server tests**, then implement the two routes and confirm they pass.
- [ ] **Step 2: App changes.**
  - **Payload:** add `routeId` to the payload, its dependency list and apply.
  - **Customer data on resume:** when `customerId`/`receiverId` are set, call the same history-loading function the phone lookup uses (lines ~200–260), so dues and address chips appear.
  - **Voice notes on save:** upload any pending voice notes first (order and per item), store `voiceNoteUrls: [{url,duration_seconds}]` and per item `uploadedVoiceNotes`, and stop stripping them.
  - **Voice notes on resume:** show uploaded notes as attached (playable, removable).
  - **On place order:** call `attachFromUrl` for each. If any fail because the file is missing, the order still stands, and one `showAlert` reads "Order saved. N voice note(s) from the draft were missing and were not attached."
- [ ] **Step 3: On-screen pass on web, field by field.** For delivery, pickup and pre-order: fill every field (sender/receiver, route, discount, delivery charges, split and partial payments, assignment, an order voice note and an item voice note) → save draft → reset → resume. Write down every field that didn't come back. Fix each one in this task and list them in the commit body.
- [ ] **Step 4: babel-check, then run all suites.**
- [ ] **Step 5: Commit:** `fix: checkout drafts keep route, voice notes and reload customer dues` (body lists every field fixed).

### Task 8: Collect dues at checkout + round-trip fixes

**Files:**
- Create: `app/src/components/CollectDuesToggle.js` with props `{ dueAmount, value:{enabled, amount}, onChange }`. A switch labelled "Collect ₹X now too" and an amount field, pre-filled with X and validated between 1 and X, with an inline plain error.
- Modify: `QuickCheckoutScreen.js`, `LogOrderScreen.js`. Render it under the dues line (Log Order also gets the dues line itself, from the same history lookup). In the pre-submit register check, treat `enabled && method==='cash'` as needing the register. After the order is created, call `api.addCustomerCredit(customerId, {...})` (the existing `POST /customers/:id/credits`; match its body fields), using the §7 method rule. On failure, `showAlert` the exact §7 message.
- Modify: `QuickCheckoutScreen.js` "Register Closed" → `showConfirm('Register Closed', msg, () => navigation.navigate('CashRegister'), { confirmLabel:'Open Register' })`.
- Modify: `CustomerDetailScreen.js`. A "New Order" primary button near the top navigates to `('POS', { screen:'QuickCheckout', params:{ prefillCustomer:{ id, name, phone } } })`. Check the exact screen and param names in `MainNavigator.js`. `QuickCheckoutScreen` reads `route.params.prefillCustomer` once and loads history.
- Modify: `CustomerDetailScreen.js`, `CustomerCreditRecordsScreen.js`. Every `Alert.alert` that has a buttons array becomes `showConfirm`/`showAlert`.

- [ ] **Step 1: Dues toggle.** Build it, wire it into both screens, and on web place one order with dues collected in cash and one in UPI. The customer's `credit_balance` drops by each amount and the register's expected cash rises only for the cash one.
- [ ] **Step 2: Forced failure (Review Focus 4).** Turn the toggle on with cash, close the register via the API after the pre-check passes (or point a test at a closed register), then confirm the order exists and the exact message shows.
- [ ] **Step 3: "New Order" from the profile:** 1 tap to checkout with the customer filled in and dues showing.
- [ ] **Step 4: Register-closed and dialog audit.** Confirm on web that "Open Register" appears and navigates. Run `grep -n "Alert.alert(" ` on the two customer screens: every remaining one has no buttons array.
- [ ] **Step 5: babel-check and all suites, then commit:** `feat: collect dues during checkout, New Order from profile, web-safe dialogs`.

### Task 9: Docs and final verification

**Files:**
- Modify: `VPS_DEPLOYMENT_GUIDE.md` §17. Nginx `location` blocks so `/slip/` and `/order-request/` (including `/order-request/open` and `/status/`) serve the Expo web build with SPA fallback, the same as the `/track/` sketch. Plus: `PUBLIC_APP_URL` must be the public web origin, and deploy order is server first.
- Modify: `CLAUDE.md` (a roadmap continuation note under item 1 or 5; update the "Known structural debt" entries for trust proxy, now fixed, and the rate-limited routes list, now including `/slip`)
- Modify: `docs/superpowers/logs/2026-10-24-oct-bug-batch-session-log.md` (§8 for this batch, with tap counts from spec §8)

- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Full regression.** All five existing suites plus `verify-slip-and-open-requests.js` and `verify-address-match.js`; record the counts.
- [ ] **Step 3: Commit:** `docs: slip page, open order link, checkout fixes`.
