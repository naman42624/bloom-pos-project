# Order Model, Channel & Unified Inbox — Design Spec

**Status:** Draft for review
**Sub-project:** 1 of 10 (see `CLAUDE.md` roadmap)
**Author:** Claude, in collaboration with the shop owner
**Date:** 2026-08-22

## 1. Problem

Orders arrive through four channels (WhatsApp, website, email, walk-in/phone), but the app has no concept of channel at all — `sales.order_type` (`walk_in|pickup|delivery|pre_order`) records *fulfillment method*, not *source*. Staff currently manage orders across three disconnected screens (Sales, Pickup Orders, Deliveries) that are really the same underlying `sales` records filtered differently, so an order can sit unattended in a tab nobody happens to be checking. Buyer-vs-recipient fields exist in the schema (`sender_*`/`receiver_*`) but aren't consistently used across every order-creation path. Order status values used at runtime have drifted from the schema's stale CHECK constraint. Edit-after-creation infrastructure exists (`audit_logs` + `PUT /api/sales/:id`) but only covers a narrow field set — not items, prices, or address, which is exactly where real "customer called to change something" scenarios live.

This is a live production app. **Every change below is additive** — no existing column, table, or row is dropped, renamed, or restructured. See `.claude/skills/db-migration-safety/SKILL.md`, which governs how the migration in this spec must be written and rolled out.

## 2. Goals

1. Every order, from every channel, is logged in one place, in seconds, without blocking on incomplete information.
2. Staff have one unified place to see every order regardless of source or fulfillment type — nothing lives in a silo only some roles check.
3. Buyer and recipient are consistently distinct, everywhere an order can be created.
4. Order status is a single, honest, formally-declared lifecycle — not runtime values wider than the schema claims to allow.
5. Meaningful edits after creation (items, price, address — not just notes) are visible history, not silent overwrites.
6. None of the above forces premature payment capture or an open cash register for channels where payment is naturally deferred; cash register accounting stays driven purely by payment method, never by channel or order type.
7. Instructions for an order (especially prep/delivery notes dictated from a phone call) can be captured as fast as talking, not just typed.

## 3. Non-goals (deferred to later sub-projects, see `CLAUDE.md` roadmap)

- Employee-code/PIN login, role split into job functions — sub-project 2.
- Server-side cash-register enforcement, moving the register guard off the client — sub-project 3.
- Redesigning task assignment or the delivery rider flow — sub-project 5.
- Attendance/shift work — sub-project 6.
- Channel-based reporting/analytics — sub-project 8 (this spec only adds the field that makes it possible later).
- Website order API integration — explicitly out of scope; website orders are logged manually, same as WhatsApp/email (per owner decision).

## 4. Data model changes (all additive)

All new columns are nullable or carry a safe default so every existing row remains valid without a backfill. Written using the project's existing `ensureColumn()`-style idempotent pattern in `server/config/database.js` — never as a destructive migration, and never by editing `schema.sql` as if it were live (it isn't — see `CLAUDE.md`).

| Table | Change | Notes |
|---|---|---|
| `sales` | `ADD COLUMN channel TEXT` — CHECK `IN ('whatsapp','email','website','walk_in','phone')` | Source of the order. Independent of `order_type` (fulfillment). Default `'walk_in'` for new rows where unspecified; existing historical rows get `NULL` (treated as "unknown" in UI, not backfilled with a guess). |
| `sales` | `ADD COLUMN priority TEXT DEFAULT 'normal'` — CHECK `IN ('normal','rush')` | |
| `sales` | Formalize the `status` CHECK constraint to `('draft','pending','confirmed','preparing','ready','completed','cancelled')` | Codifies what's already used at runtime (see `ORDER_STATUS_AND_FLOW_ANALYSIS.md`) — not a behavior change, a correctness fix so the schema stops lying about what's allowed. |
| `deliveries` | Formalize `cod_status` CHECK to include `'partial'` | Same kind of fix — already written at runtime, missing from the constraint. |
| `sale_items` | No structural change; `PUT /api/sales/:id` gains the ability to modify item rows (see §9) | |
| *(new table)* `sale_attachments` | `id, sale_id, type ('photo'\|'voice_note'), file_url, duration_seconds NULL, uploaded_by, created_at` | Replaces the earlier single-photo idea (§6) — a small append-only attachments table, following the same convention as the existing `delivery_proofs`/`product_images` tables, so an order can carry more than one reference photo or voice note over time (e.g. the customer calls back later with more instructions) without overwriting anything. |

No changes to `users`, `customers`-adjacent tables, `credit_payments`, or anything holding customer financial history — those are explicitly untouched by this sub-project.

**Rollout**: back up the database before applying; apply via the existing boot-time idempotent pattern so it's safe to re-run; verify against a copy of production data first per the migration-safety skill, not just an empty dev schema.

## 5. Unified Orders inbox

One screen (`OrdersScreen`, owner/manager/counter staff) replaces the current three-way split across Sales, Pickup Orders, and Deliveries screens for *viewing and finding* orders. It is a single feed over `sales`, filterable by:
- Status (using friendly labels — see §7)
- Channel
- Priority (rush surfaced first when filtered/sorted by urgency)
- Order type / fulfillment method
- Assignee (once task assignment exists in sub-project 5 — filter is present now but scoped to "unassigned" vs "any" until then)

Settlements (`SettlementsScreen`) stays separate — it's COD money reconciliation between the shop and a delivery partner, a different concept from order status, and merging it in would violate "don't lose functionality" by burying a distinct workflow inside an unrelated filter.

Tapping an order opens the same order-detail view regardless of how it was filtered to (no more separate `SaleDetailScreen` vs a pickup-specific vs delivery-specific detail screen) — one detail view with sections that show/hide based on `order_type` and role (delivery section only for delivery orders). Pricing/cost visibility follows whatever role-based filtering exists today — which is inconsistent (materials cost is hidden from non-owners, product cost currently is not, per `CLAUDE.md`'s known-debt list). This sub-project does not fix that inconsistency; it just doesn't make it worse. A consistent, generic field-visibility mechanism is sub-project 2's job.

The existing role-based navigation stays as-is for this sub-project (owner/manager see the inbox; POS/counter flow for creating walk-in sales is untouched structurally). Role-specific home-screen redesign (florist "My Tasks," rider "My Deliveries") is sub-project 5's job, not this one — but the unified inbox is what those role-specific views will eventually query in a filtered way, so building it now is the right foundation.

## 6. Quick-log form

New fast-entry form for WhatsApp/email/phone/website orders (`LogOrderScreen`), reachable from the unified inbox:

1. **Channel** — chip selector, remembers last used per staff member.
2. **Customer (buyer)** — search by phone (existing `customer-lookup` endpoint) or quick-add (name + phone only, rest optional).
3. **Items** — same picker used by POS, plus a free-text "custom item" option with manual price (already exists in POS, reused here).
4. **Fulfilment** — pickup or delivery toggle.
   - If delivery: **recipient name & phone**, separate from the buyer (wires the existing but under-used `receiver_customer_id`/`receiver_name`/`receiver_phone`/`receiver_address_label` fields consistently — this is largely plumbing existing schema, not new fields), address, scheduled date/time, delivery instructions, gift/sender message.
5. **Reference photo** (optional) — reuses the existing multer image-upload pattern already used for product images; stored in `sale_attachments`, visible to the florist.
6. **Voice note** (optional, new) — record a short spoken instruction instead of typing (e.g. "the customer said no lilies, she's allergic," dictated straight from the WhatsApp call instead of retyped). Recorded via `expo-av`/`expo-audio` on mobile, the browser's `MediaRecorder` on web; uploaded the same way as the reference photo, stored in the same `sale_attachments` table with `type='voice_note'`. Capped at 60 seconds — this is meant to be a quick instruction, not a recording booth, per the staff-UX-checklist's "quick and simple" bar. Not limited to quick-log time — also addable later from the order-detail view, since instructions legitimately arrive after the order already exists (a follow-up call, a change of plan). Playable inline in the order detail wherever the order's other instructions are shown (florist/rider view included — this is fulfillment instruction, not sensitive data, so no new permission gating needed).
7. **Priority** — normal/rush chip.

**Save requires only channel + at least one item or note.** Every other field — customer detail, address, schedule, photo — can be filled in later without blocking the initial save, because in practice the WhatsApp conversation is often still ongoing. This directly implements the staff-UX-checklist principle of "nothing asked that isn't required to proceed."

**Payment is not part of this form's required path.** `payment_status` defaults to `pending`/unpaid unless staff explicitly records a payment as part of this save — see §8 for why, and note that recording a cash payment here (or anywhere) is where the register-open check applies, not order logging itself.

The existing POS/QuickCheckout flow is **not** replaced by this form — it stays the dedicated fast path for in-person walk-in sales, and defaults `channel = 'walk_in'` silently without adding a channel-selection tap to that flow (per the staff-UX-checklist: don't add friction to the highest-volume, most time-pressured path for the sake of a field only relevant to the other three channels).

## 7. Status lifecycle

Runtime values stay as they are today — renaming live data is exactly what the migration-safety skill prohibits, and there's no functional reason to change the underlying values, only to formally declare them (§4) and label them well:

| Stored value | Staff-facing label |
|---|---|
| `draft` | Draft |
| `pending` | Received |
| `confirmed` | Confirmed |
| `preparing` | In Preparation |
| `ready` | Ready |
| `completed` | Completed / Delivered / Picked Up (worded by `order_type`) |
| `cancelled` | Cancelled |

`pickup_status` (`waiting → ready_for_pickup → picked_up`) and `deliveries.status` (`pending → assigned → picked_up → in_transit → delivered/failed/cancelled`) are unchanged — they're the correct place for fulfillment-specific sub-states and stay outside `sales.status`, which represents the order's overall lifecycle.

## 8. Channel × cash register / payment interaction

**Universal principle, already substantially implemented in the codebase — this sub-project documents and preserves it, doesn't invent it: the cash register (specifically `expected_cash`, the physical-drawer figure) is affected only by a payment write where `method = 'cash'`, wherever and whenever that write happens. Channel, order_type, and which screen/action recorded it are all irrelevant to that rule.** Card/UPI payments update `total_card_sales`/`total_upi_sales` on the session for reporting, but never `expected_cash`.

Verified against the actual code, this is already correctly wired in three places:
- **Sale creation** (`POST /api/sales`) — accepts an optional `payments[]` array; cash entries update the register, others don't.
- **Pickup completion** (`PUT /api/deliveries/pickup/:saleId/picked-up`) — if a balance is due, requires manager/owner confirmation, accepts a payment method, records it, and updates the register only if cash. This is exactly the "collect balance at pickup" flow — **already built**, not new work.
- **Delivery COD** — collected by the rider, never touches the shop register directly; it flows into `delivery_settlements`, and only the settlement's creation/verification (`POST /api/deliveries/settlements`) adds the verified cash to the register. This is deliberate: the money isn't physically in the till until a manager has it.

So there are exactly two cases at order-logging time, matching what you described, and neither is a forced two-step process:
1. **Already paid** (in practice, almost always online/UPI for a non-walk-in order, since the customer isn't physically at the counter) — staff optionally attaches a payment to the quick-log form at save time via the same `payments[]` mechanism POS already uses. If it happens to be cash, register rules apply exactly as they do for a walk-in; if not, no register interaction at all.
2. **Payment pending** — order saves with `payment_status = pending`/`partial`, no register interaction, no requirement to immediately do anything else. The balance then gets collected whenever it naturally occurs: online at any time before fulfillment (via the existing `AddPayment` screen, a manual escape hatch — not the *required* path), at pickup completion (already built, see above), or via delivery COD → settlement (already built). None of these are extra steps bolted onto the flow — they're the existing fulfillment-completion actions, now just correctly understood as also being the natural payment-collection moments.

**The one real, narrow gap** (confirmed in the actual code, not assumed): none of the three cash-write paths above hard-block when no register is open — they check `if (register)` and silently skip updating totals if none exists, rather than rejecting the write or warning anyone. So a cash payment can still be recorded with no register open and its total quietly never lands anywhere. This sub-project doesn't fix that — it's sub-project 3's job — but sub-project 3's scope is now precisely: add a hard register-open check at every one of these cash-write sites (sale creation, pickup completion, settlement creation/verification, the sale-edit payment path in `PUT /api/sales/:id`, refunds, and `AddPayment`), not just "the sale-creation endpoint" as originally scoped.

## 9. Edit history

Extend the existing `audit_logs` + `PUT /api/sales/:id` mechanism (already correctly structured: full before/after JSON snapshot, `entity_type='sale'`, viewable via the existing owner/manager-only `GET /:id/audit-logs`) to also accept and log item changes, unit price changes, and delivery-address changes — currently only `customer_name`, `customer_phone`, `payment_status`, `payments`, and `order_notes` are editable. Existing constraints on the edit route (same-day only, blocked once that day's register is closed, employees can only edit their own sales) are unchanged; extending the field set doesn't relax who can edit or when.

The order-detail view (§5) surfaces this history inline for roles that can already see it (owner/manager, per existing route authorization) — no new permission model introduced here; sub-project 2 is where field-level visibility gets a general mechanism.

## 10. What does NOT change in this sub-project

- Login, roles, and permission checks — identical to today.
- POS/QuickCheckout's internal cart/payment flow — untouched beyond defaulting `channel='walk_in'`.
- Production task assignment, delivery rider flow, attendance — untouched.
- The dual sync/async DB-access-layer situation — new code in this sub-project uses the async layer (`database-async.js`) per `CLAUDE.md`, but no existing sync-layer code is migrated as part of this work.

## 11. Testing / verification plan

- Migration: apply against a copy of production data (not just an empty dev DB) and confirm every existing `sales`/`deliveries` row still reads correctly with the new columns present and the reformalized CHECK constraints not rejecting any existing row.
- Voice note: record on mobile and on web, confirm playback on both, confirm the 60-second cap is enforced client-side (stop recording automatically, don't just reject on upload), confirm a second voice note on the same order doesn't remove the first.
- Payment/register: confirm a cash payment recorded at order creation, at pickup completion, and at settlement verification each correctly update `expected_cash`; confirm a card/UPI payment at each of those three sites does not; confirm the existing `if (register)` silent-skip behavior is left as-is here (fixing it is explicitly sub-project 3, not this one) but is now precisely documented at all three sites for that later work.
- Quick-log form: verify save succeeds with only channel + one item, with every other field empty.
- Unified inbox: verify an order created via each of the four channels appears correctly filtered, and that a delivery order created via the quick-log form still flows correctly into the existing `DeliveryDetailScreen`/rider assignment path unchanged.
- Buyer≠recipient: verify a delivery order with a different buyer and recipient displays both correctly throughout (order detail, challan, rider view).
- Payment deferral: verify a WhatsApp order can be logged with no payment and no open register, and that recording a cash payment against it later correctly hits the register-open check (client-side, as today — server-side enforcement is sub-project 3, not required to pass here).
- Edit history: verify an item/price change on the same-day-editable window produces a visible before/after entry.

## 12. Open assumptions (flag if wrong)

- Historical rows with `channel = NULL` are treated as "unknown" in filters/reports, not backfilled with a guessed value.
- **Rollout approach — confirmed: parallel run.** Build the unified inbox as new and keep `SalesScreen`/`PickupOrdersScreen`/`DeliveriesScreen` reachable alongside it. Old screens are only removed once the new inbox has been confirmed working in real counter use — no same-day cutover on a live system.
