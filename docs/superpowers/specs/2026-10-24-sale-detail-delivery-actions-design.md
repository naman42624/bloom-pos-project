# Delivery actions on Sale Details — design

**Date:** 2026-10-24 · **Branch:** `fix/oct-bug-batch` · **Status:** owner approved the approach (shared component, no copying), detailed design below awaiting review
**Depends on:** the shared slip printer `printOrderSlip(saleId)` in `app/src/utils/printHelpers.js` (commit `1ac829e`, already built)

## 1. What the owner asked for

> "The delivery options available on the delivery details page should also be visible on the sale details page to save extra clicks, along with option to print delivery challan." Plus: "also fix the pickup bug" ("Convert to Pickup" does nothing on web).

**Success means:**
- On a delivery order's Sale Details screen, staff can do every delivery action they're allowed to do without leaving the screen.
- Delivery Details keeps working.
- Both screens run the same code, so they can't drift apart.
- No action a role can do today disappears from either screen.

## 2. What exists today (verified by reading the code, 2026-10-24)

### 2.1 Delivery Details (`DeliveryDetailScreen.js`, ~870 lines)

| Action | Shown when | Shown to (UI) | Server allows (`server/routes/deliveries.js`) | Works on web? |
|---|---|---|---|---|
| Print challan | always | everyone | n/a | ✅ (now shared printer) |
| Assign Partner | `pending` | owner, manager, counter_staff | owner, manager, counter_staff | ⚠️ errors use `Alert.alert` → **silent on web** |
| Pick Up Order | `assigned` | rider, owner, manager | rider (own), owner, manager, **counter_staff** | ✅ |
| Start Delivery | `picked_up` | rider, owner, manager | rider, owner, manager | ✅ |
| Mark Delivered (COD amount, cash/UPI + ref, proof photo) | `in_transit` | rider, owner, manager | rider, owner, manager, **counter_staff** | ✅ |
| Mark Failed (reason) | `in_transit` | rider, owner, manager | rider, owner, manager | ✅ |
| Reattempt | `failed` | owner, manager, counter_staff | same | ❌ **`Alert.alert` with buttons does nothing on web** |
| Cancel Delivery (3 choices: back / delivery only / delivery + order) | `failed` | owner, manager, counter_staff | same | ❌ **same** |
| Convert to COD / Credit | not final | owner, manager | owner, manager | ✅ (uses `window.confirm`) |
| Convert to Pickup | not final | owner, manager | (sales route) | ❌ **same `Alert.alert` bug, the "pickup bug"** |
| Verify Load checklist | not final | owner, manager, counter_staff, own rider | + employee | ✅ |
| View Live Location | `in_transit` | everyone who sees the row | n/a | ✅ |
| Fulfill from Stock (per item) | not final | owner, manager, counter_staff | — | ✅ |

**Finding:** two of the "on web" ❌ rows mean that today, on the counter's web build, **a failed delivery can't be re-sent or cancelled from anywhere in the app**. The Sale Details button for it only navigates to these broken buttons. This design fixes that as part of the move.

### 2.2 Sale Details (`SaleDetailScreen.js`, ~2,460 lines), delivery-related parts

1. **"Delivery Status" card**: tapping it navigates to Delivery Details. It shows the status, rider and COD amount.
2. **Blocked-order block** (`sale.status === 'ready' && completionBlocked`):
   - "Delivery Failed — Send Again": navigates.
   - "Assign Rider": navigates.
   - Two plain-sentence notes for roles that can't act ("Counter staff will send it out again", "Waiting for a rider").
3. **One-tap "Mark Delivered"** (`hasNoInputNextAction`, via `api.advanceOrder`): shown only when no COD is outstanding. **Counter staff use this today.**
4. **Cancel-order guard**: "A rider is already out… cancel the delivery on the Delivery screen first", then navigates.
5. Convert to Delivery/Pickup and Fulfill from Stock are already on this screen (own modal, works on web). **Out of scope, unchanged.**

### 2.3 Shared pieces that already exist and will be reused
- `AssignPickerModal` (`components/orderBoard/`): the generic "who does this?" list, already used for riders by the dashboard and Orders Inbox.
- `useSubmitGuard`: the double-tap lock from the 2026-09-10 duplicate-order fix.
- `showAlert` / `showConfirm` (`utils/alert.js`): the web-safe dialogs.

## 3. Approach (approved)

**Extract one shared component, used by both screens. No copying.**

## 4. Design

### 4.1 Files

| File | New/changed | Purpose |
|---|---|---|
| `app/src/components/delivery/deliveryActionRules.js` | **new**, pure JS, no React | `getDeliveryActions({ delivery, role, userId })` → the list of actions this person can take on this delivery right now. The single place role and status rules live. |
| `app/src/components/delivery/DeliveryActionsPanel.js` | **new** | Renders the actions, owns their forms, modals and API calls. |
| `app/scripts/verify-delivery-action-rules.js` | **new** | Node assert script (same pattern as `verify-contact-utils.js`): every role × every status. |
| `app/src/screens/DeliveryDetailScreen.js` | changed | Keeps header, info rows, timeline, items, payment and proofs. Its action sections and their state/handlers are replaced by `<DeliveryActionsPanel>`. "Convert to Pickup" fixed. |
| `app/src/screens/SaleDetailScreen.js` | changed | Renders the panel for orders with a delivery and removes the navigate-only buttons (details in §4.5). |

### 4.2 The rules (`deliveryActionRules.js`): mirror the server exactly

Each action is shown only when the delivery's status allows it **and** the server's `authorize()` for that route allows the role. The UI never offers a button that would 403.

| Action key | Status | Roles (= server `authorize`) | Extra condition |
|---|---|---|---|
| `print` | any | everyone who can open the screen | — |
| `assign` | `pending` | owner, manager, counter_staff | — |
| `pickup` | `assigned` | owner, manager, counter_staff, delivery_partner | rider only if it's their delivery |
| `start` | `picked_up` | owner, manager, delivery_partner | rider only if theirs |
| `deliver` | `in_transit` (+ `picked_up`, which the server accepts) | owner, manager, counter_staff, delivery_partner | rider only if theirs |
| `fail` | `in_transit` | owner, manager, delivery_partner | rider only if theirs |
| `reattempt` | `failed` | owner, manager, counter_staff | — |
| `cancel` | `failed` | owner, manager, counter_staff | — |
| `convert_payment` | not final | owner, manager | label: "Convert to COD" if credit sale, else "Convert to Credit" |
| `verify_load` | not final | owner, manager, employee, counter_staff, own rider | — |
| `live_location` | `in_transit` with a rider | same as today: anyone viewing the delivery | only where the host navigator has a `LiveDeliveryMap` route (checked at build time; hidden otherwise rather than a dead tap) |

**Two visible changes, both "the button now matches what the server already permits":**
1. Counter staff get **Pick Up Order** and **Mark Delivered** (with COD) on Delivery Details. Today they can already mark delivered via Sale Details' one-tap and the dashboard card, and they physically take the cash handoff (CLAUDE.md sub-project 4).
2. `employee` gets **Verify Load**; the server already allows them.

If you'd rather keep the current narrower gates, the rules file is the one place to change. Note though that Sale Details would then **lose** its existing Mark Delivered for counter staff (§4.5).

Before writing the rules, the builder must re-read each route's `authorize()` (and the rider-ownership checks inside `/pickup`, `/in-transit`, `/deliver`, `/fail`) and correct this table if the code disagrees. **The server is the source of truth, not this doc.**

### 4.3 The panel (`DeliveryActionsPanel.js`)

**Props:**
- `deliveryId`: required.
- `navigation`: for the live map.
- `onChanged()`: called after every successful action, so the host screen refetches its own data.
- `compact` (bool): Sale Details hides the panel's own "Delivery" heading where the screen already has one.

**Data:**
- Loads `api.getDelivery(deliveryId)` itself, the same call Delivery Details makes. `GET /deliveries/:id` is open to every authenticated role, so Sale Details can call it for any role that reaches it.
- Re-loads after every action.
- Exposes `refresh()` via `ref` so the host's pull-to-refresh refreshes the panel too.

**Behaviour carried over unchanged:** the Mark Delivered form (COD amount, cash/UPI, UPI reference, proof photo via camera or gallery, proof-upload failure doesn't block delivery), the Mark Failed reason form, Convert to COD/Credit with confirm, the load checklist (existing `DeliveryChecklist` component), and the live-location jump.

**Fixed while moving** (all inside code being moved anyway):
1. **Web-dead dialogs:** Reattempt uses `showConfirm`. Every error and success message uses `showAlert`, so failures stop being silent on web.
2. **Cancel Delivery** has three outcomes, so it becomes an inline choice in the panel, the same pattern as the Mark Failed form. Tapping "Cancel Delivery" shows two buttons, **"Cancel delivery only"** and **"Cancel delivery and order"**, plus "Back". Each still runs exactly the API calls it runs today.
3. **COD amount pre-filled** with the remaining amount when the Mark Delivered form opens (staff-ux #4; `CollectCodModal` already does this). Typing still allows a partial amount.
4. **Assign Partner uses `AssignPickerModal`**, with each rider's "N stops today" as the line under their name. That's the same picker the dashboard and Orders Inbox use, so the screen-private modal goes away. Its "no riders" text says what to do: "No riders at this location. Ask the owner to add one."
5. **Every submitting action** (assign, pickup, start, deliver, fail, reattempt, cancel, convert) goes through `useSubmitGuard`.

**Order of buttons** (staff-ux #2, one obvious next action): the status's main forward action is a full-width coloured button at the top (Assign / Pick Up / Start / Mark Delivered / Reattempt). Secondary actions (Print Challan, Verify Load, Live Location, Mark Failed, Cancel Delivery, Convert payment) come below as smaller outlined buttons.

**Final states** (`delivered`, `cancelled`): only Print Challan shows. For `failed`: Reattempt (primary), Cancel Delivery and Print.

### 4.4 Delivery Details after the change

- Top sections are unchanged: progress, order info, timeline, items with Fulfill from Stock, payment/COD, proofs.
- The "Actions" and "Failed Delivery Actions" sections and the assign modal are replaced by one `<DeliveryActionsPanel deliveryId={deliveryId} onChanged={fetchDelivery} />`.
- About 400 lines of state, handlers and JSX leave the screen; the unused styles go with them.
- **Pickup bug fix:**
  - The owner/manager header row keeps "Sale Details" and "Convert to Pickup".
  - "Convert to Pickup" switches from `Alert.alert` (dead on web) to `showConfirm`, with `showAlert` for the result. Same API call as today.
  - "Delivery Challan" is removed from that row, because the panel's Print button now does the same thing and two identical print buttons on one screen is clutter.
- **Riders see the same buttons as today**, in the new primary/secondary layout. Their path is otherwise unchanged.

### 4.5 Sale Details after the change

1. **The "Delivery Status" card becomes a "Delivery" section.**
   - It keeps the status badge, rider and COD lines, and gains a small **"View full delivery →"** link that keeps today's navigation for the timeline, proof photos and full record. Nothing is removed (staff-ux #9).
   - Below that is `<DeliveryActionsPanel deliveryId={sale.delivery.id} onChanged={fetchSale} compact />`.
   - Shown for any order with `sale.delivery`, including pre_orders going out by delivery.
2. **Removed, because the panel now does them in place:**
   - The "Delivery Failed — Send Again" button and the "Assign Rider" button in the blocked-order block.
   - For roles that **can't** act, the two plain-sentence notes **stay**. The panel shows them nothing actionable, so the sentence is still what tells them who will.
   - The "{rider} has this order… tap Delivery Status above" note changes to "…it finishes once the delivery is marked delivered", since the actions are now right there.
3. **The one-tap "Mark Delivered" is hidden whenever the panel is showing**, so the order never has two different Mark Delivered buttons. It stays for **Confirm Pickup** (pickup orders, no panel). Counter staff keep Mark Delivered through the panel (§4.2).
4. **Cancel-order guard:** the message changes to "A rider is already out with this order. Cancel the delivery first (Cancel Delivery, above), then cancel the order." It no longer navigates away.
   - The panel only offers Cancel Delivery on a **failed** delivery, so for assigned, picked-up or in-transit deliveries there's still no in-app cancel. That's today's server behaviour (`PUT /deliveries/:id/cancel` exists, but the UI has only ever offered it after a failure).
   - So the message for those states keeps pointing to marking the delivery failed first, and the panel offers Mark Failed to the roles allowed to use it.
5. **Pull-to-refresh** on Sale Details also refreshes the panel.

### 4.6 Tap counts (staff-ux #3, counted on today's screens vs. after)

| Flow (counter staff unless noted) | Today | After |
|---|---|---|
| Assign a rider from an order | Sale Details → Assign Rider (navigates) → Assign Partner → pick rider = **3 taps + Back** | Assign Partner → pick rider = **2 taps** |
| Mark delivered, COD outstanding | Sale Details → Delivery Status → (counter staff: no button on that screen today; owner: Mark Delivered → type amount → Confirm) = owner **4 taps + typing + Back** | Mark Delivered → Confirm (amount pre-filled) = **2 taps** |
| Re-send a failed delivery (web) | **impossible** (dead button) | Reattempt → OK = **2 taps** |
| Cancel a failed delivery (web) | **impossible** | Cancel Delivery → choice = **2 taps** |
| Print challan from an order | View Delivery → Delivery Challan = **2 taps + Back** | Print Challan = **1 tap** |
| Convert to Pickup on Delivery Details (web, owner) | **impossible** | Convert to Pickup → OK = **2 taps** |

No flow gets longer.

## 5. Error handling

- Server error messages are already plain language, so they're shown as-is via `showAlert`, matching `OrderKanbanBoard`'s rule.
- **If the panel's own load fails:** an inline "Couldn't load delivery actions — tap to retry" row. It never blanks the rest of Sale Details.
- **Stale state:** if the delivery moved since load (e.g. a rider marked it delivered), the server returns its plain-language rejection. The panel shows it and reloads, so the buttons correct themselves.
- The register-open guard on COD cash collection is already enforced server-side (sub-project 3), so its message reaches the user through the same path.

## 6. Out of scope (named, not dropped)

- Any change to what the **server** permits.
- Cancelling a delivery that's assigned/picked up/in transit (never offered in the UI; would need a product decision).
- Redesigning Delivery Details' information sections.
- The `delivery_challan_copies` setting (exists in Settings, read by nothing).
- `CollectCodModal` (dashboard/Orders Inbox) stays as it is. It and the panel's Mark Delivered form remain two COD forms; merging them is a follow-up, not needed for this request.
- Other screens with the same `Alert.alert` web bug (e.g. Fulfill from Stock's native path is fine, but other screens weren't audited). Only the moved code and Convert to Pickup are fixed.

## 7. Testing

1. **Rules script** `app/scripts/verify-delivery-action-rules.js`: 6 roles × 6 statuses × own/other rider. It asserts the exact action list for each combination, including that counter staff get `deliver` and never `start`/`fail`, a rider never gets actions on someone else's delivery, and `employee` and `florist_staff` get no lifecycle actions.
2. **Server cross-check** (done once while building, recorded in the plan): for each action, confirm the role list in the rules file equals the route's `authorize()`.
3. **Syntax check** of every touched file with `app/scripts/babel-check.js`.
4. **Live trace on the dev server, Test Loc (location 4), throwaway orders, cleaned up after:**
   - **A (Sale Details, counter staff):** create a delivery order with a part payment → assign rider → pick up → (as owner) start → (as counter staff) Mark Delivered with the pre-filled COD → check the payment row, `payment_status`, register `expected_cash` and the order's stage all update and Sale Details refreshes without navigating.
   - **B (Delivery Details, rider):** same lifecycle from the rider's own account, confirming the rider sees exactly what they see today.
   - **C (web):** fail a delivery → Reattempt → fail again → Cancel delivery only; on a second order, Cancel delivery and order. Then Convert to Pickup on a third.
   - **D:** an employee and a florist account open the same Sale Details and see no lifecycle buttons, only the explanatory sentence and Print.
5. **Regression:** `verify-order-flows.js` and `verify-register-expenses.js`. No server code changes, but the deliver/COD path drives register totals.
6. **Look at it:** run the Expo web build and screenshot Sale Details and Delivery Details for one delivery in each status.
