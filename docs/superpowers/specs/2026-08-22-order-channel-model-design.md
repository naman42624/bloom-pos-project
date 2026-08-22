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
6. None of the above forces premature payment capture or an open cash register for channels where payment is naturally deferred.

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
5. **Reference photo** (optional) — reuses the existing multer image-upload pattern already used for product images; attached to the order for the florist to see.
6. **Priority** — normal/rush chip.

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

**Principle: the register-open requirement is a property of recording a cash payment, not of logging an order or selecting a channel.**

- **Walk-in**: order logging and payment happen in the same moment at the counter — unchanged, still guarded by `QuickCheckoutScreen`'s existing register check.
- **WhatsApp / email / phone / website**: order logging routinely precedes payment by hours or days. The quick-log form must never force an open register to *save the order* — only the act of recording an actual payment (at log time if "already paid," later via `AddPayment`, or via delivery COD collection settling later) triggers the check. This sub-project only ensures the order model and form don't force premature payment capture; sub-project 3 implements the actual server-side enforcement at every payment-write path (`method='cash'` inserts in sale creation, add-payment, refund, and COD collection — not narrowly "sale creation").
- Delivery COD continues to flow through the existing settlement mechanism (`delivery_settlements`/`delivery_settlement_items`) untouched by this sub-project — a rider's collected cash never hits a shop register directly, only after manager verification.

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
- Quick-log form: verify save succeeds with only channel + one item, with every other field empty.
- Unified inbox: verify an order created via each of the four channels appears correctly filtered, and that a delivery order created via the quick-log form still flows correctly into the existing `DeliveryDetailScreen`/rider assignment path unchanged.
- Buyer≠recipient: verify a delivery order with a different buyer and recipient displays both correctly throughout (order detail, challan, rider view).
- Payment deferral: verify a WhatsApp order can be logged with no payment and no open register, and that recording a cash payment against it later correctly hits the register-open check (client-side, as today — server-side enforcement is sub-project 3, not required to pass here).
- Edit history: verify an item/price change on the same-day-editable window produces a visible before/after entry.

## 12. Open assumptions (flag if wrong)

- Historical rows with `channel = NULL` are treated as "unknown" in filters/reports, not backfilled with a guessed value.
- **Rollout approach — recommendation, not yet locked in**: given this app is live at the counter, build the unified inbox as new and keep `SalesScreen`/`PickupOrdersScreen`/`DeliveriesScreen` reachable in parallel through the implementation phase, then remove them only after the new inbox has been confirmed working in real use — not a same-day cutover on a live system. This will be re-confirmed as part of the implementation plan.
