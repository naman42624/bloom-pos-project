# Labels, Public Price Page & Scanner Implementation Plan (scan-and-sell spec, part 2 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every product gets a short label code whose QR opens a public price page for customers and adds the product when scanned in the app; label sheets print in three layouts; sizes, "type the price" items and one-off bouquets are supported; scanning works in the browser.

**Architecture:** Additive product columns + a `product_options` table. A label-code util, a rewritten selling-only scan endpoint, a public rate-limited price route, a public `/p/:code` page routed in `App.js` like `/track/`, one shared `ProductScanner` component, a label-sheet screen printing HTML with server-generated QR images, and a Scan button in Quick Checkout's Full order.

**Tech Stack:** Express + `pg`, `qrcode` (already a server dependency), Expo / React Native Web, a browser QR decoder chosen in Task 5.

**Spec:** `docs/superpowers/specs/2026-11-02-scan-sell-helpers-staff-sales-design.md` §5, §6, §7, §13 (scan messages).

**Prerequisite:** quick-sale plan merged (uses `server/scripts/lib/verify-harness.js`). Independent of part 1. Branch `feature/labels-scanner`.

## Global Constraints

- Additive schema only via `database.js`; `db-migration-safety` first; no apostrophes in SQL comments.
- Label code alphabet exact: `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, length 8, unique, never changes once set.
- QR content exact: `${PUBLIC_APP_URL}/p/<label_code>`; reuse the `PUBLIC_APP_URL` default already defined in `server/utils/slip-token.js` (move it to a shared `server/utils/public-url.js` and import it in both).
- The scanner must still accept the legacy payload `{"type":"bloomcart_product","id":N,...}`.
- No response reachable by a scan or the public page may contain `estimated_cost`, stock quantities, supplier or material data.
- Same-code cooldown 1.5 s; every accepted scan beeps + vibrates (where supported).
- Copy exact (spec §13): unknown QR `This isn't one of our product codes. Try Find by name.`; switched-off `Not for sale right now — ask the counter.`; one-off sold `This one-off item is already sold. Check with the counter.`; camera blocked `Camera is blocked. Tap the 🔒 next to the web address → Camera → Allow, then tap Try again.`; public page not found `We couldn't find this item — please ask at the counter.`
- Public page shows "Available" or "Ask at the counter" only — never a number.
- Price-on-label toggle defaults **off**; when on, prints `price on <D Mon YYYY>`.
- Layouts: `stickers` (A4, 3 × 8), `bucket` (A4, 2 × 3, large text), `price_card` (A4, one card listing the chosen products with name + price + QR each).
- Decimal quantities are out of scope (spec §5.3) — no column type changes.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A product whose code is requested twice at the same time gets one code, not two (Task 1 check `concurrent ensureLabelCode yields one code` — unique index + retry on conflict).
2. Old printed labels (legacy JSON) and new URL labels both resolve to the same product (Task 2 checks).
3. A scan of a URL from another site (`https://example.com/p/ABCDEFGH`) is treated as a bare code lookup only if the path matches `/p/<8 chars from the alphabet>`; anything else → unknown message (Task 2 check `foreign url refused`).
4. Public page hammering: the 31st request in a minute from one IP gets 429 and the page shows the not-found-style friendly text, not a crash (Task 3 check `rate limited`).
5. A sized product scanned in Quick Checkout with the picker dismissed adds nothing (Task 7 on-screen step).

---

### Task 1: Product schema, label codes, labels endpoint

**Files:**
- Modify: `server/config/database.js` — `products.label_code VARCHAR(8)` + unique index, `products.price_mode VARCHAR(10) DEFAULT 'fixed'`, `products.price_hint VARCHAR(120)`, `products.is_one_off INTEGER DEFAULT 0`; table `product_options (id SERIAL PK, product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE, label VARCHAR(60) NOT NULL, price DECIMAL(10,2) NOT NULL, sort_order INT DEFAULT 0, is_active INT DEFAULT 1, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`
- Create: `server/utils/label-code.js`, `server/utils/public-url.js`
- Modify: `server/utils/slip-token.js` (import `PUBLIC_APP_URL` from the new util; behaviour unchanged)
- Modify: `server/routes/products.js` — create/update validators accept `price_mode` (`fixed|open`), `price_hint`, `is_one_off`; new `PUT /:id/options` (owner, manager: replace the option list, max 6, each price > 0); `GET /:id` includes `options`; new `POST /labels`
- Create: `server/scripts/verify-labels-scanner.js`

**Interfaces:**
- Produces: `generateLabelCode() -> string`, `ensureLabelCode(db, productId) -> string` (returns existing or sets a new one; on unique-violation retry up to 5 times), `labelUrl(code) -> string`.
- Produces: `POST /api/products/labels` body `{ product_ids: number[] }` (roles owner, manager, employee, counter_staff, florist_staff; max 200 ids) → `{ success, data: [{ product_id, name, price, price_mode, price_hint, label_code, url, qr_data_url }] }`; `qr_data_url` via `qrcode.toDataURL(url, { width: 300, margin: 1 })`.

- [ ] **Step 1: Failing checks:** `ensureLabelCode is stable`; `codes use only the alphabet`; `concurrent ensureLabelCode yields one code` (two parallel `POST /labels` for the same fresh product → same code); `labels endpoint returns url and qr`; `options replace and validate` (7 options → 400; price 0 → 400); `price_mode open saved`. Test products created and deleted by the script.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**, restart API. **Step 4: Run** this script + `verify-slip-and-open-requests.js` (slip URL unchanged) → pass.
- [ ] **Step 5: Commit** `feat(labels): product label codes, options, labels endpoint`.

### Task 2: Selling-only scan endpoint

**Files:**
- Modify: `server/routes/products.js` — `POST /scan`
- Modify: `server/scripts/verify-labels-scanner.js`

**Interfaces:**
- Produces: `POST /api/products/scan` body `{ payload: string, location_id?: number }` → `{ success, data: { id, name, image_url, selling_price, price_mode, price_hint, is_one_off, is_active, in_stock, options: [{ id, label, price }] } }`. Accepts: legacy JSON, a URL whose path is `/p/<code>`, or a bare 8-char code. Errors (exact copy): 400 unknown; 404 unknown (no such product/code); 409 `Not for sale right now — ask the counter.` (inactive); 409 one-off message when `is_one_off = 1` and stock at `location_id` ≤ 0. `in_stock` = product_stock quantity > 0 at `location_id` (false if no location given).

- [ ] **Step 1: Failing checks:** `legacy json payload resolves`; `url payload resolves`; `bare code resolves`; `foreign url refused`; `no estimated_cost in scan response` (assert the key is absent); `inactive product message`; `one-off sold message`.
- [ ] **Step 2–4:** Run → FAIL; implement; run → pass.
- [ ] **Step 5: Commit** `feat(scan): selling-only scan lookup for labels`.

### Task 3: Public price route

**Files:**
- Create: `server/routes/price-public.js` (copy the per-IP fixed-window limiter shape from `server/routes/track.js`: 30 requests / 60 s / IP, own state)
- Modify: `server/server.js` (`app.use('/api/price', pricePublicRoutes)`, next to `/api/track`)
- Modify: `server/scripts/verify-labels-scanner.js`

**Interfaces:**
- Produces: `GET /api/price/:code` (no auth) → `{ success, data: { shop_name, name, image_url, price, price_mode, price_hint, options: [{label, price}], available: boolean } }`; `available` = active and (not one-off or stock > 0). Unknown or inactive → 404 `{ success:false, message: <public not-found copy> }`. 429 → `{ success:false, message: 'Too many requests — please try again in a minute.' }`.

- [ ] **Step 1: Failing checks:** `public price works without auth`; `public price hides cost and stock` (no `estimated_cost`, no quantity keys); `unknown code 404 copy`; `rate limited` (31 calls → last is 429).
- [ ] **Step 2–4:** Run → FAIL; implement; run → pass. (Run this script last in any sequence — it consumes the IP budget; wait 65 s before re-running.)
- [ ] **Step 5: Commit** `feat(price): public price page api`.

### Task 4: Public `/p/:code` page

**Files:**
- Create: `app/src/screens/PricePageScreen.js`
- Modify: `app/App.js` (path match `^\/p\/([A-Z0-9]{8})$` alongside the `/track/` match)
- Modify: `app/src/services/api.js` (`getPublicPrice(code)`, unauthenticated like the track call)
- Modify: `VPS_DEPLOYMENT_GUIDE.md` §17 (add `/p/` to the SPA-fallback list)

**Interfaces:**
- Behaviour: centred card ≤ 480 px: shop name, photo, name, price in large type (or option rows; or `price_hint` with "Price depends on size — ask at the counter" for `open`), "Available" (green) / "Ask at the counter" (grey); not-found and 429 copy from Task 3. No login, no navigation chrome.

- [ ] **Step 1:** Implement; babel-check.
- [ ] **Step 2: On-screen check:** open `http://127.0.0.1:8081/p/<a real test code>` in a fresh browser profile (no login) → card renders; bad code → not-found copy.
- [ ] **Step 3: Commit** `feat(price): public price page`.

### Task 5: Browser scanner component (spike first)

**Files:**
- Create: `app/src/components/scan/ProductScanner.js` (+ `ProductScanner.native.js` wrapping `expo-camera` `CameraView` if the web choice cannot run on native)
- Create: `docs/superpowers/logs/2026-11-02-scanner-spike.md`
- Modify: `app/src/screens/QRScannerScreen.js` (use the new component; remove the "not available on web" branch; keep its ProductDetail behaviour)
- Possibly modify: `app/package.json` (only if the spike picks a decoder library; pin an exact version at least two weeks old)

**Interfaces:**
- Produces: `<ProductScanner onCode={(raw) => void} paused={bool} />` — continuous camera, reports each decoded string, applies the 1.5 s same-code cooldown internally, beeps (Web Audio short tone) + `navigator.vibrate(60)` on accept, torch toggle when `MediaStreamTrack.getCapabilities().torch` exists, permission-denied state with the exact copy and a "Try again" button. It does not call the API — the parent does.

- [ ] **Step 1: Spike** (≤ 1 hour): try `BarcodeDetector` (with a JS fallback decoder such as `jsQR` for browsers without it) versus `expo-camera`'s web barcode support. Test on Android Chrome and iPhone Safari against a printed sticker from Task 1 (phones need HTTPS: the user chose (2026-11-03) a temporary HTTPS tunnel to the dev web server and API. Expose only for the test session, close it afterwards, and use throwaway accounts only — the tunnel URL reaches the dev database). Write the evidence and decision to the spike log.
- [ ] **Step 2:** Implement the component per the decision; babel-check.
- [ ] **Step 3: On-screen check:** desktop webcam + a phone: scan legacy and new labels; hold one label in view for 5 s → one accept; deny permission → copy + Try again works.
- [ ] **Step 4: Commit** `feat(scan): browser QR scanner component`.

### Task 6: Label sheet screen

**Files:**
- Create: `app/src/screens/LabelSheetScreen.js`, `app/src/utils/labelSheetHtml.js`
- Modify: `app/src/navigation/MainNavigator.js` (register; keep the `QRLabel` route name pointing at the new screen so existing navigations still work), product list/detail entry points that open `QRLabel`
- Modify: `app/src/services/api.js` (`getLabels(productIds)`)

**Interfaces:**
- Consumes: `POST /api/products/labels`; `printHtml` from `app/src/utils/printHelpers.js`.
- Produces: `buildLabelSheetHtml({ layout, items: [{ name, price, qr_data_url, count }], showPrice, date }) -> string` (pure; A4 CSS with `@page { size: A4; margin: 8mm }`).
- Behaviour: search + tick products, "All in category", count stepper per product (1–48), layout chips (Stickers / Bucket cards / Price card), "Show price" switch (off), Print.

- [ ] **Step 1:** Write a babel-loaded unit test `app/scripts/test-label-sheet.js` (same loader approach as `app/scripts/test-quick-sale.js`): 30 stickers → 2 pages (24 per page); price hidden by default; price shown with the date line when on; bucket layout 6 per page.
- [ ] **Step 2:** Run → FAIL; implement; run → pass; babel-check the screen.
- [ ] **Step 3: On-screen check:** print preview of each layout (browser print dialog → cancel). 
- [ ] **Step 4: Commit** `feat(labels): printable label sheets`.

### Task 7: Scan in Quick Checkout, product form fields, one-off tags

**Files:**
- Create: `app/src/components/scan/ScanAddModal.js` (scanner + size picker + "type the price" prompt + Find by name)
- Modify: `app/src/screens/QuickCheckoutScreen.js` (Full order: **Scan** button beside Add Item → modal; each accepted product adds an item through the existing `addFromProduct`-style path, incrementing quantity when the same product+option is already the newest item)
- Modify: `app/src/screens/ProductFormScreen.js` (Price type: Fixed / Type the price; price hint; sizes editor → `PUT /:id/options`; "One-off item" switch)
- Modify: `app/src/screens/ProduceScreen.js` (after creating a custom product: **Print tag** → set `is_one_off` and print one bucket-layout label)

**Interfaces:**
- Consumes: `POST /api/products/scan`, Task 5 component, Task 6 HTML builder.
- Behaviour: sized product → three-or-more big buttons with prices, dismiss adds nothing; `open` product → amount prompt showing the hint, must be > 0; option lines named `<product> (<option label>)`.

- [ ] **Step 1:** Implement; babel-check all files.
- [ ] **Step 2: On-screen check** (throwaway counter_staff): scan a fixed product twice → qty 2; sized product → pick Medium → line "Bouquet (Medium)" at the option price; dismiss picker → nothing added; open-price product → typed price; place the order; Produce → Print tag → scanning the tag after selling it shows the one-off copy. Remove test data.
- [ ] **Step 3: Commit** `feat(scan): scan to add in Quick Checkout; sizes, open price, one-off tags`.

### Task 8: Final verification

- [ ] Run `verify-labels-scanner.js` (last, rate limit), `verify-quick-sale.js`, `verify-order-flows.js`, `verify-slip-and-open-requests.js` (wait 65 s between public-route scripts), `node app/scripts/test-label-sheet.js`.
- [ ] CLAUDE.md roadmap note (incl. the Nginx `/p/` fallback deploy step), commit `docs: labels and scanner shipped`. Ask before push/PR.
