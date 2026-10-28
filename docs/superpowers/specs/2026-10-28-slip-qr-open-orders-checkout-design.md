# Slip QR scan page, open order link, checkout fixes — design

Date: 2026-10-28. Branch: `feature/slip-qr-open-orders-checkout` (built on `fix/oct-bug-batch-2`, PR #15).
Approved in chat by the owner on 2026-10-28, including every decision below.

## 1. Goals

1. A QR code on the shop copy of every delivery/pickup slip opens a public page (no login) with the order's items, photos, voice notes and the real load checklist.
2. One general order-request link anyone can use. Name and phone are taken. The person becomes a customer only when staff approve.
3. Saved customer addresses are offered at checkout, and new ones are saved back.
4. Checkout drafts save and restore everything that was entered.
5. Fewer round-trips: collect previous dues during checkout, plus four more fixes found in an audit.

## 2. Constraints

- Express + JWT + pg, Expo React Native. No new stack.
- Schema changes are additive only (new tables and new nullable columns) and are written as `database.js` patches. Never hand-edit the dev DB (see CLAUDE.md "Known structural debt").
- The `staff-ux-checklist` applies to every staff screen touched. Tap counts are in §8.
- Dialogs with buttons use `showAlert`/`showConfirm` (`app/src/utils/alert.js`), never `Alert.alert` with buttons. That pattern is dead on web.
- Public routes have per-IP rate limits, and their errors are generic (a bad token gives a 404 with no detail).

## 3. Item 1: slip QR and scan page

### 3.1 Link
- `server/utils/slip-token.js`: `generateSlipToken(saleId)` = `${saleId}.${hmac('slip:' + saleId)}`, using the same secret as tracking links, with `slip:` prefixed to the message. A tracking token therefore never works as a slip token, and the reverse also holds. Also `verifySlipToken(token) -> saleId | null`, compared in constant time, and `slipUrl(saleId)` = `${PUBLIC_APP_URL}/slip/${token}`.
- **Expiry:** the token stops working 7 days after the sale reaches `completed` or `cancelled`. The age is taken from the sale's `updated_at`. While the order is open the link always works.

### 3.2 Public API (`server/routes/slip-public.js`, mounted at `/api/slip`, no auth)
- **Rate limiter:** its own per-IP limiter, 60 requests/minute (the page polls). It follows the shape of `track.js` and doesn't share state with it.
- **`GET /api/slip/:token`** returns:
  - `order_number`, `order_type`, `display_type` ("Delivery" or "Pickup"), `scheduled_date`, `scheduled_time`, `card_message` (the sender message);
  - `items`: `sale_item_id`, `name`, `quantity`, `image_url` (the product's first image, or null), `voice_notes: [{url, duration_seconds}]`;
  - `order_voice_notes: [{url, duration_seconds}]`;
  - `checklist: { enabled, items: [{sale_item_id, checked, checked_at}] }`.

  **Never returned:** prices, totals, payments, any phone number, addresses, customer or receiver names, or staff names.
- **`PUT /api/slip/:token/check/:saleItemId`** with body `{ checked: boolean }`. It writes the same rows the app uses (§3.3), records `checked_via = 'slip_qr'` and `checked_by = NULL`, and returns the updated checklist.
  - 404 when the item isn't on this sale.
  - 409 with a plain message ("This order is already delivered") when the delivery or pickup is final.

### 3.3 Checklist storage
- **Deliveries:** the existing `delivery_load_checks`, unchanged except for one new nullable column, `checked_via TEXT` (`'app'` or `'slip_qr'`; NULL on old rows means app). Rows are created lazily, exactly as today.
- **Pickups:** a new table `pickup_load_checks` with columns `id`, `sale_id` (FK sales, CASCADE), `sale_item_id` (FK sale_items, CASCADE), `checked BOOLEAN DEFAULT false`, `checked_by INTEGER NULL`, `checked_via TEXT NULL`, `checked_at TIMESTAMP NULL`, and `UNIQUE(sale_id, sale_item_id)`. Rows are created lazily on first view.
- **Which table:** the order's current type decides. A converted order follows its new type, and old rows stay as history.
- **In the app:** authenticated endpoints `GET` and `PUT /sales/:id/pickup-checks[/:saleItemId]`, open to owner, manager, employee and counter_staff. Sale Details shows the same checklist component for pickup orders that are not yet picked up.

### 3.4 Slip
- `GET /sales/:id` gains `slip_url` and `slip_qr_svg` (an SVG string from the server's `qrcode` package). These are additive and only for roles that can print.
- `printOrderSlip` puts the QR on the **shop copy only**, under the items, captioned "Scan to see items, photos & voice notes and tick the load". The customer copy is unchanged.

### 3.5 Public page (`app/src/screens/SlipScreen.js`, web route `/slip/:token`, linked the same way as `TrackingScreen`)
- **Layout:** order number and type at the top. Then each item: photo (or a placeholder), name, ×quantity, play buttons for its voice notes, and a large tick box. The order's voice notes and the card message sit above the items.
- **Ticking:** a tap updates the tick at once and rolls it back with "Couldn't save, try again" on failure. A header shows progress ("3 of 5 packed").
- **Other states:**
  - when the list is already final it is read-only, with a plain line saying why;
  - an expired or invalid link shows "This slip link has expired or is not valid. Ask the shop for a new slip."

## 4. Item 2: general order-request link

- **New columns on `order_requests`** (all nullable): `requester_name`, `requester_phone`, `status_token TEXT UNIQUE`, `source TEXT` (`'customer_link'` or `'general_link'`; NULL on old rows means customer link).
- **Routes (in `order-request-public.js`):**
  - **Same limiter:** both routes share that file's existing per-IP limiter.
  - **`GET /api/order-request/open`** returns the catalog and shop info, the same as the per-customer GET minus the customer data.
  - **`POST /api/order-request/open`** has the per-customer submit body plus `requester_name` (required, 2–80 characters) and `requester_phone` (required, 10 digits after removing spaces, `+91` and a leading 0).
    - It creates the request with `customer_id = NULL`, `source = 'general_link'` and a random `status_token` (24 bytes, hex), and returns `status_url` = `/order-request/status/:status_token`.
    - It never creates or changes a user.
  - **`GET /api/order-request/status/:statusToken`** returns that one request's status and its decline reason.
- **Approving (staff):** for a request with `customer_id` NULL, Approve first calls a new `POST /order-requests/:id/resolve-customer` (same roles as the review screen).
  - It looks up a `role='customer'` user by normalized phone, or creates one with `requester_name`/`requester_phone`, the same way `POST /customers` does today.
  - It sets `customer_id` on the request and returns it.
  - It runs in a transaction and can be repeated safely: a second call returns the same customer.

  Approval then continues into `LogOrderScreen` exactly as today. Decline never calls it, so declined requests never create anyone.
- **Staff side:**
  - the Order Requests screen gets a "Share order link" row (Copy + WhatsApp) with the general URL;
  - review cards show the requester's name and phone, labelled "New customer" when there's no match yet, or "Matches: <name>" when an existing customer has that phone;
  - the match is looked up on the server when the list is fetched.
- **Customer page:** `OrderRequestScreen` handles the `open` mode (name and phone fields at the top) and a status-only mode.
- **Rate limits:** set `app.set('trust proxy', 1)` in `server.js`. The VPS guide says production has exactly one Nginx hop. With this, the limiters on `/track`, `/order-request` and `/slip` count per visitor. Locally nothing changes because there's no proxy. If a CDN such as Cloudflare is ever put in front of Nginx, this number has to go up, or every visitor will again count as one. Add a comment saying so next to the setting.
- **Production hosting:** the Nginx locations for `/slip/` and `/order-request/` have to serve the Expo web build, as with `/track/`. Exact steps go into `VPS_DEPLOYMENT_GUIDE.md` §17. Applying them on the server is the owner's job.

## 5. Item 3: saved addresses at checkout

- **Screens:** Quick Checkout and Log Order, for delivery orders (and pre-orders fulfilled by delivery).
- **Choices shown:** saved addresses appear as tappable chips above the address field, showing the label and the first line. A tap fills the field.
  - **Order:** the receiver's addresses first (when `receiverId` is set), then the customer's. Defaults go first within each group.
  - **Source:** `GET /customers/:id/addresses`, which already exists.
- **Saving new addresses:** after a successful order, if the delivery address text doesn't match a saved address for the receiver (or the customer when there's no receiver), it is saved to that person. The match is case- and space-insensitive. The save goes through the existing `POST /customers/:id/addresses` with label "Saved from order". A failure here never fails the order and is just logged.

## 6. Item 4: checkout drafts

- **Route:** add `routeId` to the draft payload and restore it.
- **Customer data on resume:** resuming a draft with a `customerId` (or `receiverId`) loads that customer's history and addresses again, so dues and address chips show.
- **Voice notes:** saving a draft uploads any recorded order- and item-level voice notes first (existing upload endpoint) and stores their returned URLs as `voiceNoteUrls` in the payload. Resuming shows them as already uploaded. Placing the order attaches them by URL, the same way an approved order request attaches its notes; if no such path exists yet, the plan adds one. Deleting a draft does not delete the files.
- **Verification:** a full on-screen save → resume pass on web, field by field, covering all three order types, split payment, partial payment, sender/receiver, discount, delivery charges and assignment. Anything else found missing is fixed in the same task and listed in the PR.

## 7. Item 5: dues and round-trips

- **Collect dues at checkout (Quick Checkout and Log Order).**
  - Under "Previous Dues Pending: ₹X" there's a switch, "Collect ₹X now too", off by default, plus an amount field (pre-filled with X, between 1 and X).
  - Uses the order's payment method (the first method when split; cash when the order itself takes no payment).
  - After the order saves, it calls the existing `POST /customers/:id/credits`. Cash needs an open register; that's checked before submitting along with the order's own check.
  - If the dues call fails after the order saved, the order stands and the message reads "Order saved. The ₹X dues payment was not recorded — record it from the customer's page." It's never retried silently.
- **a. "New Order" on the customer profile:** opens Quick Checkout with `customerId`, name and phone filled in, and history and addresses loaded.
- **b. Log Order** shows previous dues and the collect switch (above).
- **c. Quick Checkout's "Register closed"** uses `showConfirm` so "Open Register" works on web. Checkout state survives the trip because the screen stays mounted.
- **d. Dialog audit:** go through `CustomerDetailScreen` and `CustomerCreditRecordsScreen`, and change every `Alert.alert` that has buttons to `showConfirm`/`showAlert`. Alerts without buttons can stay.

## 8. Tap counts (first-time user, common case)

| Flow | Today | After |
|---|---|---|
| Collect previous dues while placing an order | ~6 + finding your place again (leave, customer, dues, record, back) | 1 (switch) |
| New order for the customer you're looking at | 4 + re-search (POS tab, checkout, type the name, pick) | 1 |
| Fill a known delivery address | typing the whole address | 1 (chip) |
| Load check from the slip, no app | not possible | scan + 1 tick per item |
| Register closed at checkout on web | dead end | 1 (Open Register) |

## 9. Testing

- **Server:** a new `server/scripts/verify-slip-and-open-requests.js` covering:
  - the slip token round-trip;
  - a tracking token rejected as a slip token, and the reverse;
  - expiry after 7 days, simulated by moving `updated_at` back;
  - no prices, phones, addresses or names anywhere in the public response, checked against a deny-list of keys and values;
  - a tick from the public route visible in the app's checklist, and the reverse, for delivery and for pickup;
  - 409 on a final order;
  - a foreign `saleItemId` gives 404;
  - an open request creates no user;
  - `resolve-customer` matches by phone, creates a new customer, and returns the same customer when called twice;
  - a status token shows only its own request;
  - the rate limiter returns 429.
- **Existing suites** must stay green: order-flows, register-expenses, order-requests, settlement-math, delivery-action-rules.
- **On screen (web):**
  - the shop copy shows the QR and the customer copy doesn't;
  - scanning opens the page, a tick there appears on Sale Details, and vice versa;
  - voice notes play;
  - the general link → approve → a new customer is created; the same phone again → matched;
  - address chips work and a new address gets saved;
  - draft save/resume works;
  - the dues switch works;
  - "New Order" from the profile works.

## 10. Out of scope

- Hosting changes on the VPS: documented, not applied.
- Real payment verification for "I've paid".
- Push or SMS notifications.
- Deleting voice-note files left behind by deleted drafts.
- The broken `POST /sales/customer-order` endpoint (still known structural debt).
