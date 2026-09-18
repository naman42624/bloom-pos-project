# Customer order request flow — design

## 0. Why this exists

Today, a customer who wants to order by phone/WhatsApp has to describe what they want to staff, who then type it into `LogOrderScreen` by hand — the same manual-logging process this app already uses for every WhatsApp/email/walk-in order. That works, but it means staff time spent transcribing rather than reviewing, and it means the customer has no way to just fill in the details themselves when they already know exactly what they want.

This adds a shareable link a staff member sends a registered customer (over WhatsApp, manually — this app has no WhatsApp Business API integration, a decision already made and documented elsewhere in this codebase, not revisited here). The customer fills in recipient details, items, and a delivery/pickup preference themselves, on their own phone, at their own pace. That becomes a **request**, not a live order — a member of staff reviews it, corrects anything that needs correcting, and approves it into a real order through the exact screen they already use for every other order.

## 1. What already exists (verified, not assumed)

- **`POST /api/sales/customer-order`** (the existing in-app customer self-order endpoint) is confirmed broken — 500s on every call (a column/placeholder-count mismatch in its `INSERT`), a known, separately-flagged issue. **This spec does not touch it.** `CustomerShopScreen.js` and the `customer` role are a hard-kept constraint (`CLAUDE.md` #4) and stay exactly as they are — this is a second, independent path to create an order, not a fix or a replacement for the first one.
- **`GET /track/:token`** is the app's only existing public/unauthenticated route — a customer opens a link with no login, the server validates a signed token, and the page shows order status. It has its own self-contained, in-memory per-IP rate limiter (the *only* rate-limited route in the app today). This design reuses that exact shape — same class of route, same need for its own rate limiter, not shared with `/track`'s.
- **No payment gateway exists anywhere in this app.** Every payment collection already in this codebase (COD, UPI, card) is self-reported — a person types in a method and, for UPI, a reference number, with nothing verified against a bank. This design's "I've paid" checkbox follows the identical pattern; it is not a new trust model, and closing that gap for real (as already noted elsewhere in this codebase) needs real payment gateway integration, out of scope here.
- **The order/sale item model already supports both catalog-linked items and free-text custom items** in the same order (confirmed: existing regression coverage exercises "custom item, no `product_id`" as a real, working case). This design's item list reuses that shape rather than inventing a new one.
- **A `wa.me` deep-link pattern already exists** (used on delivery-settlement partner cards) for "staff taps a button, their WhatsApp opens pre-addressed to a specific number" — reused here for sharing the request link, since there's no API to send it automatically.

## 2. Scope

**In scope:**
- A new, additive `order_requests` table and a lazily-generated persistent token per customer.
- A new public, unauthenticated page at `/order-request/:token` where a customer submits (and later checks the status of) a request.
- A new staff-facing "Order Requests" review screen.
- Wiring **Approve** to pre-fill the existing `LogOrderScreen` rather than building a second order-creation form.
- A "Copy order link" / WhatsApp-share action on a customer's profile for staff.

**Explicitly not in scope (named, not silently dropped):**
- Fixing `POST /api/sales/customer-order` or changing `CustomerShopScreen.js`/the `customer` role in any way.
- Any real payment verification — the "I've paid" flag stays self-reported, exactly like every other payment method in this app today.
- Automating the WhatsApp send itself (no WhatsApp Business API — manual copy/share only, per existing project decision).
- Push/SMS notification infrastructure — status is checked by revisiting the same link (see §4), not pushed to the customer.

## 3. Data model (all additive — new table + one new nullable column, nothing existing altered)

### `order_requests` (new table)

| Column | Type | Notes |
|---|---|---|
| `id` | serial PK | |
| `customer_id` | INTEGER REFERENCES users(id) | who the request belongs to |
| `recipient_name` | VARCHAR | who the order is for (buyer ≠ recipient, same principle the rest of this app already uses) |
| `recipient_phone` | VARCHAR | |
| `order_type` | VARCHAR CHECK IN ('delivery','pickup') | |
| `delivery_address` | TEXT, nullable | required client-side when `order_type='delivery'`, null for pickup |
| `message` | TEXT, nullable | card message |
| `requested_date` | DATE | |
| `requested_time` | VARCHAR, nullable | free text ("morning", "6 PM") — this is a *request*, not a committed slot |
| `items_json` | JSONB | array of `{ product_id, name, quantity }` (catalog) and/or `{ custom: true, description, quantity }` (free-text) entries — a JSON blob is enough here because a request is never queried relationally; on approval its contents are re-entered through `LogOrderScreen`'s own normal item-adding UI, which is where the real, relational `sale_items` structure gets created |
| `payment_claimed` | BOOLEAN DEFAULT false | the customer's own "I've paid" checkbox |
| `payment_reference` | VARCHAR, nullable | optional UPI reference the customer typed in |
| `status` | VARCHAR CHECK IN ('pending','approved','declined') DEFAULT 'pending' | |
| `decline_reason` | TEXT, nullable | |
| `created_sale_id` | INTEGER REFERENCES sales(id), nullable | set once approved, links the request to the real order it became |
| `reviewed_by` | INTEGER REFERENCES users(id), nullable | |
| `reviewed_at` | TIMESTAMP, nullable | |
| `created_at` | TIMESTAMP DEFAULT CURRENT_TIMESTAMP | |

### `users.order_request_token` (new nullable column)

A unique, random token generated the first time it's needed (see §6) — not generated for every customer up front. Indexed for the public route's lookup.

### `settings` key `upi_qr_image_url` (new row in the existing `settings` table, same pattern `timezone` already uses)

The shop's UPI QR code image, uploaded **once** by the owner through the app's already-existing generic `POST /api/upload` route (confirmed: a real, working, already-authenticated endpoint — `multer` disk storage, returns a URL) — no new upload infrastructure needed, just a settings screen field to store the resulting URL under this key and an owner-only place to set it (e.g. a new field on the existing Settings screen). The public order-request page reads this URL to display the QR image; if it's unset, the payment block simply doesn't render the QR image (shows the "I've paid" checkbox and reference field alone) rather than breaking the page.

## 4. The customer-facing page — `GET/POST /order-request/:token`

Public, unauthenticated, token-scoped to one customer — same shape as `/track/:token`, with its **own** self-contained per-IP rate limiter (do not share state with the tracking route's limiter; each public route owns its own, matching the existing precedent's own documented reasoning).

**`GET /order-request/:token`** — validates the token, returns: the customer's name (for a "Hi, {name}" greeting), the active product catalog (for browsing), and that customer's own recent `order_requests` (for the status view below). An invalid/unknown token gets the same generic response shape `/track/:token` already uses for an invalid token — no information leak about whether a token almost matched something.

**The page has two states, both served from the same link:**

1. **Submit a request** (the default view, or reachable via a "New request" action if they have prior ones): a form collecting delivery-vs-pickup, recipient name/phone, address (delivery only), message, requested date/time, items (catalog browse + add, plus a free-text "anything else / custom request" field), and the payment block — the shop's UPI QR code image, an "I've paid" checkbox, an optional reference field. At least one item (catalog entry or non-empty custom text) is required to submit, mirroring the "channel tag + at least one item" minimum this app already enforces for every other order-creation path. Submitting calls `POST /order-request/:token` and shows a confirmation ("Your request has been sent — we'll confirm shortly") with an option to submit another.
2. **Check status**: the same page lists the customer's own recent requests (pending / approved / declined, with a plain-language status label — no jargon). This is deliberately how the customer finds out what happened to their request, since this app has no SMS/WhatsApp API to push a notification to someone who may not even have the app installed. No separate notification system is being built for this.

## 5. Staff review — a new "Order Requests" screen, not merged into the real Orders Inbox

A new screen, its own section (not mixed into the existing Orders Inbox list) — these are not real orders yet, and conflating "pending review" with "confirmed and in progress" would be a real staff-ux-checklist #8 violation (showing something that isn't real order data mixed in with what is). Reachable from the Orders hub, badge-counted the same way other "needs attention" lists elsewhere in this app already are.

**Role access**: the same roles who can already log an order today (`owner`, `manager`, `employee`, `counter_staff` — `LogOrderScreen`'s existing authorize list) can review and approve/decline a request — this is an ordinary order-logging task, not a supervisory one, so it doesn't get owner/manager-restricted. `florist_staff`/`delivery_partner` do not get this screen, matching their existing scope elsewhere in the app.

**List view**: customer name, recipient name, requested date, a short item summary, the "paid?" flag, submitted-at.

**Approve** — the load-bearing design decision of this whole spec: tapping Approve does **not** open a second, custom-built review/edit form. It navigates into the existing `LogOrderScreen`, pre-filled with the request's data (recipient, address, message, date, items — catalog items pre-added with their current live price/stock already re-validated by the screen's own normal logic, custom items pre-filled as free-text line items exactly like a manually-typed custom item today). Staff edit it exactly like they'd edit any other order — nothing new to learn — and the screen's own existing "Save Order" action both creates the real order **and** marks the source `order_requests` row `approved`, stamping `created_sale_id`, `reviewed_by`, `reviewed_at`. Every existing check `LogOrderScreen` already runs (stock availability, current pricing, register state for any inline payment) runs automatically, for free, because it's the same screen — a request submitted three days ago against since-changed stock or pricing gets corrected the moment staff open it, with no separate reconciliation logic to build or get wrong.

**Decline** — stays lightweight, no navigation: a status change to `declined` with an optional reason, shown to the customer on their status view (§4.2). A declined request is not revivable — the customer submits a fresh one via the same link if they want to try again.

## 6. Token generation and sharing

`order_request_token` is generated lazily — the first time a staff member wants to share a link with a customer, not for every customer up front. A **"Copy Order Link"** action on the customer's profile (generating the token on first use if it doesn't exist yet) copies the full URL; a second, adjacent action opens `wa.me/<customer's registered phone>?text=<link>` — the same deep-link pattern already used elsewhere in this app for a staff-initiated WhatsApp handoff, not a new mechanism.

## 7. Error handling (staff-ux-checklist)

- **Missing/invalid token**: generic "This link isn't valid" message, no technical detail — matches `/track/:token`'s existing plain-language handling of the same case.
- **Empty cart on submit**: blocked client-side before it ever reaches the server, same minimum-viable-order rule already enforced elsewhere ("at least one item").
- **Self-reported payment is not verification**: the review screen shows the "paid?" flag and reference plainly, but staff are expected to actually check their own UPI/bank app before trusting it — same limitation already accepted and documented for every other self-reported payment in this app, not solved here.
- **Stock/price drift between submission and review**: handled automatically by reusing `LogOrderScreen`'s own live checks (§5) — no separate drift-detection logic needed.
- **A request is submitted for a product that's since been deactivated/deleted**: the pre-fill simply can't add it (same as `LogOrderScreen` already can't add a deactivated product today); staff sees it listed as text in the original request but has to substitute or ask the customer — flagged as a real but minor rough edge, not solved further here.

## 8. Testing / verification approach

Same pattern this whole branch's work has already used: a real regression script (`server/scripts/verify-order-requests.js` or folded into an existing suite, decided at implementation time) exercising the real HTTP routes — token validation (valid, invalid, expired-if-tokens-ever-expire), submission with catalog items, submission with custom items, submission with both, the empty-cart rejection, the rate limiter actually firing past its threshold (matching how `/track/:token`'s own limiter is already tested, if it is — confirm during implementation), approve-creates-a-real-sale-and-links-back, decline-sets-status-and-reason, and the customer's own status view showing the correct state after each transition.

## 9. Rollout / migration safety

Everything in §3 is additive — one new table, one new nullable column on `users`. No existing table, column, or constraint is touched. Follows the same `ensureColumn`/table-creation pattern already established throughout `server/config/database.js`. Per this project's `db-migration-safety` skill, no backfill is needed (both are opt-in-by-use: a `users` row with no token simply hasn't shared a link yet; `order_requests` starts empty).
