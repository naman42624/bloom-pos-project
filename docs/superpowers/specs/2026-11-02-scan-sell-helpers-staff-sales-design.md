# Scan & sell, temporary helpers, and staff sales — design

Date: 2026-11-02 · Status: draft for owner review · Touches: products, sales, register close, roles, auth

## 1. Problem

On festival and crowded days the shop hires temporary sales people to attend customers. They don't know the prices of every product, and today the counter has to ring up every sale. The owner also wants to know how much each person — permanent or temporary — sells (count and amount), as the base for a commission scheme to be added later, and the counter must always know how much cash each helper is holding.

## 2. Decisions taken by the owner (2026-11-02)

| Question | Decision |
|---|---|
| Where helper cash goes | **Owner setting**: either each helper keeps a separate **cash bag** that is handed over to the counter, or helper cash goes **straight into the counter's register**. |
| Helper discount over their limit | **PIN override** — a counter staff member (or manager/owner) types their code + PIN on the helper's phone. |
| Label QR opens a public price page customers can use | **Yes.** |
| Helpers' devices | **Their own phones.** |
| Helper cash amounts on the counter screen | **Hidden by default** (e.g. "₹5,xxx"), shown only when tapped, so nobody can read them at a glance and adjust what they hand over. |
| Helper discount limit | Helpers can give discount up to what counter staff can, configurable by the owner. |
| Staff sales numbers | Count and total per person, **owner only**. Commission maths comes later. |
| Helpers take payment | Yes, without the counter approving each sale. |

Everything must be self-explaining for first-time users: on-screen steps, plain messages, big buttons.

## 3. Pieces and build order

The work splits into four parts that ship in this order, each usable on its own:

1. **Staff sales tracking** (§4) — `sales.sold_by` + owner-only report. Small, useful immediately.
2. **Labels, public price page, scanner** (§5–§7) — any staff member can scan to check a price or add to Quick Checkout.
3. **Helper role, joining on their own phone, helper selling** (§8–§10) — with cash going straight to the register.
4. **Cash bags, handover, hidden amounts** (§11–§12) — the owner's "separate bag" mode.

## 4. Staff sales tracking

### 4.1 Who sold it

- New column `sales.sold_by` (user id). Set on every new sale:
  - helper sale → the helper;
  - any other sale → the logged-in user (today `created_by`), unless a different person is picked.
- Quick Checkout (Full order) and Log Order get one collapsed line near the bottom: **"Sold by: You ▸"**. Tapping it shows big chips of the staff on duty at this location (from `GET /auth/staff-roster`, which already returns the right people), helpers included. It resets to "You" after every order. This is for when a helper attended the customer but the counter rang it up.
- Old sales have no `sold_by`; reports fall back to `created_by` for them (no backfill write to live rows).

### 4.2 Owner-only "Staff sales" report

- Where: owner's More/Reports → **Staff sales**. Endpoint `GET /api/reports/staff-sales` with `authorize('owner')` only — managers do not see it (owner decision).
- Period chips: Today · Yesterday · This week · This month · Pick dates. Location filter (defaults to all).
- One row per person (permanent and temporary, including people whose access has ended):

| Column | Meaning |
|---|---|
| Orders | non-cancelled sales with this `sold_by` (fallback `created_by`) |
| Amount | sum of their grand totals, minus refunds on those sales (refunds shown in their own column too) |
| Discounts | count and ₹ of discounts on their sales, and how many needed a PIN override |
| Undone | quick-sale entries they undid (count, ₹) — from the quick-sale spec |
| Cash bag (helpers, bag mode) | floats given, cash collected, handed over, short / over |

- Tap a row → that person's sales list for the period (existing sale cards; tap → Sale Details).
- Commission rules are explicitly not part of this spec; this report is what they will be calculated from.

## 5. Product labels

### 5.1 One short code per product

- New column `products.label_code` — 8 characters from an unambiguous alphabet (no 0/O/1/I), unique, generated the first time a label is printed or asked for. Never reused, never changes.
- The QR on the label is a **web link**: `${PUBLIC_APP_URL}/p/<label_code>`.
  - Any phone camera opens the public price page (§6).
  - The in-app scanner recognises the same link and adds the product directly.
- The QR never contains a price, so price changes (festival prices included) never make a printed label wrong.
- The scanner still accepts the **old** label format (`{"type":"bloomcart_product","id":…}`), so labels already stuck on products keep working.

### 5.2 Printing labels

The existing one-product `QRLabelScreen` becomes a label sheet:

- Pick products (search + tick boxes, "All in category"), set how many labels of each.
- Each label: QR, product name, and optionally the price with a small "price on <date>" line. The price toggle is **off by default** because printed prices go stale at festivals.
- Layouts: small stickers (A4, 3 × 8), bucket cards (A4, 2 × 3, large text) and a **price card** layout (see §5.3).
- Printing reuses the existing print helpers (browser print).

### 5.3 Every pricing case

| Case | How it works | New data |
|---|---|---|
| Fixed-price item (vase, teddy, chocolate, greeting card) | Sticker on the item. Scan = add 1. | — |
| Loose flowers per stem | One bucket card. Each scan adds 1. The basket line has big **−** / **+** and a **+10** button. | — |
| Sizes (small / medium / large bouquet) | Scan opens a size picker: three big buttons, each with its price. | `product_options` (product_id, label, price, sort_order, is_active) |
| Sold by weight or length (garland per metre, loose petals per kg) | "Type the price" item: scan shows the usual rate as a hint ("usually ₹120 per metre") and asks for the total price. | `products.price_mode` = `'fixed'` (default) or `'open'`; `products.price_hint` text |
| Made-to-order bouquet | When the florist creates it in the existing "create custom product" screen (Produce), a **Print tag** button prints its one-off tag. | `products.is_one_off` |
| Price points (Bouquet ₹200 / ₹300 / ₹500, Wrapping ₹50, Card ₹20) | Ordinary products in a "Price cards" category, printed together on one laminated **price card** kept at the counter and given to helpers. Also shown as tap buttons on the helper's screen. | — |
| Combo (rose + chocolate box) | Its own product with its own label. | — |
| Festival price | Change the price in the app; labels stay right. | — |
| App shows 0 in stock but the item is in the customer's hand | The sale goes through. The owner sees a "sold with no stock recorded" flag on the stock screen. Never blocks a sale. | — |
| One-off item already sold | "This one-off item is already sold. Check with the counter." The helper can't sell it twice; the counter can still sell it through Full order. | — |
| Item switched off | "Not for sale right now — ask the counter." | — |
| Label damaged or missing | **Find by name** box and a photo grid of products on the scan screen. | — |
| Wrong item scanned | Big **remove** on each basket line, and − to 0 removes it. | — |
| Same label read twice by accident | The same code is ignored for 1.5 s after a read; every accepted scan beeps, vibrates and shows "Rose × 3". | — |
| Customer only asks the price | Scan shows a big price card (photo, name, price, sizes) with **Add to basket**. Nothing is added until that's tapped. | — |
| Price change attempt by a helper | Not possible: helpers cannot type a price except on `open` items, and the server prices every helper line from the catalog (§10.4). | — |
| Customer haggles | Discount, within the helper's limit or with a PIN override (§10.3). | — |
| Returns and exchanges | Counter only, through the existing refund flow. | — |

**Not supported, on purpose:** decimal quantities (e.g. 1.5 m as a quantity). `sale_items.quantity` and `product_stock.quantity` are `INTEGER` columns; changing their type is a restructure of live data that CLAUDE.md constraint 1 forbids without a separate, approved migration plan. "Type the price" items cover these sales without it.

## 6. Public price page — `/p/:code`

- Unauthenticated page for customers: shop name, product photo, name, current price (and size prices), and "Available" or "Ask at the counter" (never a stock number). No cost, no internal fields.
- API: `GET /api/price/:code` returning only those fields. Its own small in-memory per-IP rate limiter, the same shape as `/api/track/*` (public routes deliberately don't share limiter state — CLAUDE.md "Known structural debt").
- Unknown or switched-off code: "We couldn't find this item — please ask at the counter."
- Production: `/p/` needs the same Nginx SPA fallback as `/track/`, `/slip/` and `/order-request/` (`VPS_DEPLOYMENT_GUIDE.md` §17), and `PUBLIC_APP_URL` must be the public web origin.

## 7. Scanner

- One shared scanner component used by the helper Sell screen, Quick Checkout (Full order, a **Scan** button beside Add Item) and the stock screens.
- **Works in the browser** (the shop runs the web app; helpers use their own phones' browsers). The current `QRScannerScreen` says "not available on web" — that is replaced. The first implementation task is a short spike to choose between the browser's built-in `BarcodeDetector` with a JavaScript QR decoder as fallback, or `expo-camera`'s web support, on both an Android Chrome phone and an iPhone Safari. The decision and evidence go in the plan.
- Camera access needs HTTPS (already the case for the public site; local dev uses localhost).
- Continuous mode: the camera stays on; each accepted scan adds or increments. Torch button when the phone supports it.
- If camera permission is refused: a picture-guided message, "Camera is blocked. Tap the 🔒 next to the web address → Camera → Allow, then tap Try again", plus **Find by name** so selling never stops.
- `POST /api/products/scan` is changed to return only selling fields (id, name, photo, price, options, price mode/hint, one-off and active flags, stock-available yes/no). **Today it returns `p.*`, including `estimated_cost`** — the cost leak already listed in CLAUDE.md; this closes it for scanning.

## 8. Helper role and accounts

### 8.1 Role

- New role `helper`. Added to `users_role_check` with the existing drop-and-re-add pattern in `database.js` (widening only — every existing role stays allowed). Read the `db-migration-safety` skill first.
- New column `users.access_until DATE`. The auth middleware already reloads the user on every request; it additionally refuses a `helper` whose `access_until` has passed: "Your access ended on 15 Nov. Ask the owner if you need more days." Switching a helper off (`is_active = 0`) signs them out immediately, as for any user.

### 8.2 What a helper can and cannot do

| Can | Cannot |
|---|---|
| Scan, check prices, find by name | See cost, margin, stock numbers, reports |
| Sell catalog items, price cards, "type the price" items | Type a price for a fixed-price item; add free-text items |
| Take Cash or UPI | Give credit, take dues, use COD/delivery/pre-order |
| Discount up to their limit; above it with a PIN override | Refund, cancel or edit any sale (except undo own sale, §10.5) |
| See their own sales today and their own bag | See other people's sales or bags, customers list, expenses, register |

Every server route a helper calls gets `helper` explicitly in its `authorize()`; no existing route is widened beyond what is listed here.

### 8.3 Creating a helper and joining on their own phone

Owner or manager: Staff → **Add helper**:

1. Name, phone, **Works until** (date picker, default: 7 days from today), location (defaults to the current one).
2. **Create** → a screen with a large **Join QR** and **Share on WhatsApp** (sends the join link).
3. Steps shown under the QR: "1. Ask Raju to open his phone camera. 2. Point it at this code. 3. He sets a 4-digit PIN. Done."

Helper, on their phone:

1. Opens the link → "Hi Raju 👋 Set a 4-digit PIN you'll remember" → types it twice.
2. The phone is now set up: logged in as Raju, location set, and marked as a **personal device**, so the lock screen shows only Raju's PIN pad (not the shop roster).
3. A 3-step welcome card on the Sell screen (§9.1).

Join links: one use, valid 24 hours, stored hashed (`helper_join_tokens`: user_id, token_hash, expires_at, used_at). Making a new QR cancels the old one. A used or expired link says "This link has been used or has expired. Ask the owner for a new code."

Lost phone or helper leaves early: owner switches the helper off (one tap, existing user screen); that signs them out at once.

Ending: after `access_until` the helper can't log in, but their sales stay in reports and any cash still in their bag stays on the counter's list until handed over (§11.4).

## 9. Helper screens

The helper's app has two tabs only: **Sell** and **My sales**.

### 9.1 Sell

```
┌─────────────────────────────────────────────┐
│  [ camera view — scanning ]        [🔦]      │
│  "Point at the QR on the product"           │
│  Find by name 🔍   ·   Price cards ▸         │
├─────────────────────────────────────────────┤
│  Rose (stem)      × 10   ₹300   [−][+][+10] │
│  Bouquet (Medium)  × 1   ₹450   [−][+]      │
│  Wrapping          × 1    ₹50   [−][+]      │
├─────────────────────────────────────────────┤
│  3 items · ₹800        [ Take payment ₹800 ] │
└─────────────────────────────────────────────┘
```

- First-use card: "1. Scan the QR on each product. 2. Tap **Take payment**. 3. Take Cash or show the UPI code. That's it." [Got it] — re-openable from "ⓘ Help".
- **Price cards ▸** opens big tap buttons for the price-card products (Bouquet ₹200/₹300/₹500, Wrapping, Card).
- The basket is kept if the screen locks or the page reloads (stored on the device as a convenience; lost only if storage is unavailable). **Clear basket** sits small at the bottom with an Undo toast.

### 9.2 Take payment

```
  Total ₹800
  Discount ▸           (shows "−₹50 · Total ₹750" once given)
  [      CASH      ]   [      UPI      ]
  Part cash, part UPI ▸
  Customer phone (optional, for a WhatsApp bill) ▸
```

- **Cash** → "Take ₹800 from the customer" with optional **Customer gave ₹**___ → shows "Give back ₹200". **Done**.
- **UPI** → shows the shop's UPI QR full screen (the existing `upi_qr_image_url` setting) with the amount in large text; optional reference; **Customer has paid**. If no UPI QR is uploaded: "Ask the customer to pay to the shop's UPI at the counter."
- Success: big ✓ "₹800 collected · Cash", **Share bill on WhatsApp** / **Print**, and **Next customer** (also automatic after 4 seconds). The scanner reopens with an empty basket.

Taps for a normal sale: scans, then **Take payment** → **Cash** → **Done** = **3 taps**, plus scans. With "Next customer" automatic, nothing more.

### 9.3 My sales

Today's sales of this helper: time, items, amount, method. Count shown; their own cash total is hidden like the counter's (§12) and shown on tap. In bag mode, a line: "Cash to hand over: ₹3,xxx (tap to see)".

## 10. Helper selling rules (server)

### 10.1 Sale shape

A helper sale is `POST /api/sales` with role `helper`, enforced server-side regardless of what the client sends: `order_type 'walk_in'`, `channel 'walk_in'`, `sold_by = helper`, `skip_assignment true`, status completed, full payment in Cash and/or UPI (no credit, no partial). Items are only catalog products (with an option for sized products) or `open`-price products.

### 10.2 Discount limit

- New setting `discount_helper_threshold` (%), shown in Settings next to the existing two. Default = the current `discount_manager_threshold` value (20%), i.e. "the same as counter staff", which the owner can lower.
- Within the limit: allowed, recorded as today.
- Over it: needs a PIN override (§10.3). The existing manager (20%) and owner (30%) thresholds still apply to whoever approves.

### 10.3 PIN override

- On the helper's phone: "This discount needs the counter's OK" → **Ask counter to approve** → a pad for **employee code + PIN** (the same code + PIN staff already use on the counter device).
- The server checks the code + PIN with the existing PIN rules (attempt limits and lockout from `utils/pin.js`), checks that person's role may give this discount (counter staff up to the manager threshold, manager up to the owner threshold, owner any), and records them in `sales.discount_approved_by`. The PIN is sent only with that sale request and never stored on the phone.
- Wrong PIN: "That PIN didn't match. X tries left." Role too low: "This discount needs a manager or the owner."
- The owner's Staff sales report counts overrides per helper and per approver.

### 10.4 Prices are set by the server

For helper sales the server ignores any `unit_price` sent for a fixed-price product or option and uses the catalog price; `open`-price lines take the typed price (must be more than ₹0). This closes, for helpers, the `unit_price` trust gap noted in CLAUDE.md. (Closing it for counter roles is a separate decision, not part of this spec.)

### 10.5 Helper undo

A helper can undo their **own** sale for 2 minutes after it was made, and only if no handover (`handover_in`) has been recorded for them since that sale. The quick-sale spec's `POST /api/sales/:id/undo-quick` is extended to accept this case (a sale with `sold_by` = the calling helper, within those limits) in addition to `entry_mode = 'quick'` entries. Effect: cancel + restore stock + audit; in register mode the register totals are reversed; in bag mode nothing in the register moves, and the bag shrinks automatically because cancelled sales are excluded from it. After the 2 minutes, the counter refunds as usual. Undo counts appear in the owner's report.

### 10.6 Register rules by mode

- **Straight to register** mode: a helper's cash sale needs the register open, like any cash sale. Message: "The counter hasn't opened the register yet. Ask them to open it, then try again." UPI works without it.
- **Cash bag** mode: helper sales never need the register (the cash is in their bag).

## 11. Cash bag mode

### 11.1 Setting

`helper_cash_mode` = `'register'` (default) or `'bag'`. Owner only, in Settings → Helpers, with a one-line explanation under each choice:

- "**Straight to the register** — helpers' cash counts as drawer cash right away. Use when helpers hand you every payment."
- "**Separate bag per helper** — each helper keeps their cash and hands it over later. You always see who holds how much."

Switching is blocked while any helper still holds cash: "Collect the cash from Raju and Priya first (₹5,xxx)."

### 11.2 Records

- `payments.held_by INTEGER REFERENCES users(id)` — set to the helper on a cash payment taken in bag mode. Such payments do **not** change `cash_registers` totals at sale time.
- New table `staff_cash_movements`: id, location_id, staff_id, type (`'float_out'` | `'handover_in'`), expected_amount, counted_amount, difference, is_final (bool), register_id, recorded_by, note, created_at.
- A helper's bag (what they should be holding) = floats given + cash payments held by them on non-cancelled sales − expected amounts already settled by handovers.

### 11.3 Float, handover, shortage

- **Give change float** (counter): pick helper → amount (pre-filled with the last float, e.g. ₹500) → **Give**. 2 taps + amount. Takes it out of the open register (`expected_cash` down), records `float_out`.
- **Receive cash** (counter), **blind**:
  1. Tap the helper on the "Cash with helpers" card.
  2. "Count Raju's cash and type the total" → amount → **Next**. (The expected amount is **not** shown yet, so the count isn't influenced.)
  3. Then the screen shows: "Expected ₹3,200 · Counted ₹3,150 · **Short ₹50**" and asks **"Is this all the cash Raju has?"** → **Yes, settle** (the whole expected amount is settled; any difference is recorded against Raju) or **No, part of it** (only the counted amount is settled, the rest stays in his bag — for mid-day handovers that reduce risk).
  4. The counted amount goes into the open register (`expected_cash` up, the same way settle-now credits rider COD).

  Taps: card row → amount → Next → Yes = **3 taps + amount**.
- Floats and handovers need an open register; if it's closed, the existing in-place `OpenRegisterForm` appears first.
- Who can give floats and receive cash: owner, manager, employee, counter_staff.

### 11.4 Register close

- The close recompute in `PUT /register/close` changes in two ways:
  - cash payments with `held_by` set are **excluded** from cash sales;
  - handovers' counted amounts are **added** and floats **subtracted** for movements in that register session.
- Before closing, if any helper still holds cash: "₹1,8xx is still with Priya. Collect it first?" → **Collect now** (opens the handover) or **Close anyway** (the bag stays open and carries over to the next session; recorded in the audit log).
- A refund on a helper's sale is paid from the drawer as any cash refund is today (refund method is independent of how the sale was paid — existing, confirmed rule).
- A helper whose access has ended keeps their bag listed on the counter until it reaches ₹0.

## 12. Hidden amounts

The counter dashboard shows a card (bag mode only, when any helper holds cash):

```
Cash with helpers  ₹5,xxx
  Raju   ₹3,xxx · 14 sales
  Priya  ₹1,xxx · 9 sales
           (tap a name to see the exact amount or collect)
```

- Masking: keep the first digit and the digit grouping, replace the rest with x (₹5,xxx · ₹8xx · ₹xx). Sale counts stay visible, as in the owner's example.
- Tapping a name shows the exact amount for 15 seconds together with **Receive cash** and **Give float**, then masks again.
- Every reveal is written to the audit log (who looked at whose bag, when), and the owner's report shows the reveal count, so curiosity is visible.
- The handover itself is blind (§11.3), so a revealed amount can't steer the count either.
- Helpers see only their own bag, masked the same way.
- The owner's Staff sales report shows exact figures without masking.

## 13. Plain-language messages

| Situation | Message |
|---|---|
| Access ended | "Your access ended on 15 Nov. Ask the owner if you need more days." |
| Join link used/expired | "This link has been used or has expired. Ask the owner for a new code." |
| Camera blocked | "Camera is blocked. Tap the 🔒 next to the web address → Camera → Allow, then tap Try again." |
| Unknown QR | "This isn't one of our product codes. Try Find by name." |
| Switched-off product | "Not for sale right now — ask the counter." |
| One-off already sold | "This one-off item is already sold. Check with the counter." |
| Discount over limit | "This discount needs the counter's OK." |
| Register closed (register mode) | "The counter hasn't opened the register yet. Ask them to open it, then try again." |
| Save failed | "Couldn't save — check the internet and tap Take payment again. Nothing was charged twice." (submit guard + server idempotency key per basket) |
| Mode switch with cash out | "Collect the cash from Raju and Priya first (₹5,xxx)." |

A helper sale carries a client-generated idempotency key (one per basket), stored on the sale, so a retry after a dropped response cannot create a second sale (`sales.client_ref`, unique per creator).

## 14. Data changes (all additive; `db-migration-safety` first; all through `database.js`, never by hand)

- `sales.sold_by`, `sales.client_ref` (+ unique index on `(created_by, client_ref)` where not null).
- `products.label_code` (unique), `products.price_mode` default `'fixed'`, `products.price_hint`, `products.is_one_off` default false.
- New table `product_options`.
- `users.access_until`; role `helper` added to `users_role_check` (drop + re-add, widening only).
- New table `helper_join_tokens`.
- `payments.held_by`.
- New table `staff_cash_movements`.
- Settings: `discount_helper_threshold`, `helper_cash_mode`.

## 15. Staff UX checklist (counted)

| Flow | Taps |
|---|---|
| Helper: price check | 0 (scan) |
| Helper: sell, cash | scans + Take payment + Cash + Done = **3** |
| Helper: sell, UPI | scans + Take payment + UPI + Customer has paid = **3** |
| Helper: discount within limit | +2 (Discount, amount chip) |
| Counter: receive cash | **3** + amount |
| Counter: give float | **2** + amount |
| Counter: mark "Sold by" a helper | **2** (line + chip), only when needed |
| Owner: create helper | form + Create, then the helper scans |

Defaults do the work: location, last float, method, "Sold by: You". Errors say what to do next. Nothing is removed from any existing role.

## 16. Testing

- `server/scripts/verify-helpers.js`: helper can't call counter/owner routes; helper sale is repriced from catalog; free-text item refused; credit refused; discount within limit OK; over limit without override refused; override with wrong PIN refused and counts toward lockout; override by counter_staff above manager threshold refused; `access_until` passed → 401 with the message; join token single-use and expiry; bag mode: held payment doesn't move register totals, float and handover move them, blind handover settle vs partial, close recompute excludes held cash and includes movements; mode switch blocked with cash out; helper undo within 2 minutes and not after handover; idempotency key prevents a duplicate sale; staff-sales report is owner-only and its totals match; public price page returns no cost and is rate-limited; scan endpoint no longer returns `estimated_cost`.
- Re-run `verify-order-flows.js`, `verify-register-expenses.js`, `verify-identity-roles.js` (role constraint), `verify-quick-sale.js`.
- On screen: throwaway owner-created helper joined from a real phone (Android Chrome and iPhone Safari), scan of old and new labels, sizes, open price, price cards, discount + override, cash and UPI, bag float → sales → blind handover → close; masked card reveal; label sheet printing.

## 17. Out of scope

- Commission calculation and payouts (later; built on §4).
- Approving an over-limit discount remotely from the counter.
- Checking UPI payments against the bank or a payment gateway.
- Offline selling.
- A native app build for helpers (they use the web app).
- Decimal quantities (§5.3).
- Closing the `unit_price` trust gap for counter roles.
