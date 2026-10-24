# Delivery actions + challan on Sale Details — design

**Date:** 2026-10-24 · **Branch:** `fix/oct-bug-batch` · **Status:** draft, awaiting owner review

## 1. What the owner asked for

> "The delivery options available on the delivery details page should also be visible on the sale details page to save extra clicks, along with option to print delivery challan."

Today, staff who open an order from the dashboard or Orders Inbox land on **Sale Details**. Most delivery actions live only on **Delivery Details**, one tap further in ("View Delivery"). Every assign, dispatch, mark-delivered or failed-delivery action costs an extra screen and a back-navigation.

**Success:** on a delivery order's Sale Details screen, staff can do every delivery action they could do on Delivery Details without leaving the screen. They see the same buttons, the same role rules and the same plain-language errors, and both screens keep working.

## 2. Where things stand today (2026-10-24)

| Action | Delivery Details | Sale Details today |
|---|---|---|
| Print delivery challan | ✅ (own inline generator) | ❌ |
| Assign rider (picker with rider list) | ✅ `canManageDeliveries` | ⚠️ "Assign Rider" button only **navigates** to Delivery Details |
| Pick Up Order (assigned → picked_up) | ✅ rider/owner/manager | ❌ |
| Start Delivery (picked_up → in_transit) | ✅ rider/owner/manager | ❌ |
| Mark Delivered **with COD collection** (amount, cash/UPI + ref, proof photo) | ✅ rider/owner/manager | ⚠️ one-tap "Mark Delivered" only when no input is needed (`hasNoInputNextAction`) |
| Mark Failed (with reason) | ✅ rider/owner/manager | ❌ |
| Reattempt failed delivery | ✅ `canManageDeliveries` | ⚠️ "Delivery Failed — Send Again" only **navigates** |
| Cancel delivery | ✅ `canManageDeliveries` | ❌ (cancel-order guard tells staff to go to Delivery Details) |
| Convert to COD / Convert to Credit | ✅ owner/manager | ❌ |
| Verify Load checklist | ✅ staff or own rider | ❌ |
| View rider live on map | ✅ owner/manager | ❌ |
| Convert to Pickup / Delivery | ✅ | ✅ already (own modal) |
| Fulfill from Stock (per item) | ✅ | ✅ already |

So the real gap is the **delivery lifecycle block**: assign → pick up → start → deliver/fail → reattempt/cancel, plus COD/credit conversion, load check, live map and challan. Convert-order-type and Fulfill-from-Stock are already on both screens and stay out of scope.

Delivery partners have no Sale Details route in their navigation stack. Their path stays Delivery Details only, unchanged.

## 3. Approaches considered

**A. Extract one shared `DeliveryActionsPanel` component, used by both screens (recommended).** Move the lifecycle actions, their modals/forms (assign picker, COD form, fail form, load checklist) and their handlers out of `DeliveryDetailScreen.js` into `app/src/components/delivery/DeliveryActionsPanel.js`. Both screens render it. There is one copy of every rule, so a later fix lands on both screens at once.

**B. Copy the actions into Sale Details.** About 400 lines duplicated into a 2,459-line file. Two copies of the role gates and COD logic would drift, the same "three copies of one rule" debt the order-list review already flagged (finding A13). Rejected.

**C. Show Delivery Details as a modal/bottom sheet from Sale Details.** It still costs the extra tap the owner wants removed, and it stacks a full screen inside a modal. Rejected.

## 4. Design (approach A)

### 4.1 The component

`DeliveryActionsPanel({ deliveryId, navigation, onChanged })`

- **Loads its own data** with `api.getDelivery(deliveryId)`, the same call Delivery Details makes. Sale Details' `sale.delivery` comes from a different query with fewer fields (no item list, no partner details), so reusing the existing endpoint is what keeps the two screens identical. That's one extra request on Sale Details, and only for orders that have a delivery.
- **Owns** the state and handlers currently in `DeliveryDetailScreen.js` lines ~41–300: `doAction`, `openAssignModal`/`handleAssign`, `handleDeliver` (COD and proof photo), `handleFail`, reattempt, cancel, `handleConvertPayment`, the load-checklist toggle, `handleViewLivePartner`, and the challan print.
- **Role gates move unchanged:** `isManager`, `canManageDeliveries`, `isPartner`, `isOwnDelivery`, exactly as defined today. The server stays the real authority.
- **`onChanged()`** is called after any successful action, so the host screen refetches its own data. Sale Details' stage badge, payment status and order status must update too, not just the panel.
- **Every submit is wrapped in `useSubmitGuard`.** Same reason as the 2026-09-10 double-submit fix: Mark Delivered and Assign create real state changes.

### 4.2 Delivery Details after the change

It renders its header and info rows, then `<DeliveryActionsPanel deliveryId={...} onChanged={fetchDelivery} />`. It should look and behave exactly as today. This is a move, not a redesign. Its inline challan generator and private `printHtmlOnWeb` copy are deleted in favour of the shared printer (see §5).

### 4.3 Sale Details after the change

- For any order with `sale.delivery`, a **"Delivery"** section renders the panel in place of today's navigate-only "Assign Rider" and "Delivery Failed — Send Again" buttons.
- **Avoiding two Mark Delivered buttons:** today's one-tap "Mark Delivered" (`hasNoInputNextAction`) is hidden whenever the panel is showing, so the order doesn't get two different Mark Delivered buttons. This is the same single-source-of-truth rule the 2026-09-01 lifecycle redesign enforced for "Complete Order". "Confirm Pickup" for pickup orders is unaffected.
- **"View Delivery" stays** as a small secondary link, for the full delivery record (timeline, proof photo, rider history). Nothing is removed (staff-ux #9).
- **Cancel-order guard:** the existing "Cancel the delivery first → Open delivery" dialog changes to point at the panel's Cancel Delivery on the same screen.

### 4.4 Tap counts (staff-ux #3, counted against today's screens)

| Flow | Today | After |
|---|---|---|
| Assign rider from an order | Sale Details → View Delivery → Assign Partner → pick rider = **3 taps + back** | Sale Details → Assign Partner → pick rider = **2 taps** |
| Mark delivered with COD | Sale Details → View Delivery → Mark Delivered → amount → Confirm = **4 taps + back** | Mark Delivered → amount → Confirm = **3 taps** |
| Reattempt a failed delivery | Send Again (navigates) → Reattempt Delivery = **2 taps + back** | Reattempt Delivery = **1 tap** |
| Print challan from an order | View Delivery → Delivery Challan = **2 taps + back** | Print Challan = **1 tap** |

## 5. Shared challan printer (dependency, also delivers item 2)

All challan/slip printing goes through **one** function in `app/src/utils/printHelpers.js`:

`printOrderSlip(saleId, { shopName })`: fetches `api.getSale(saleId)`, then prints a **Delivery Challan** for delivery orders and a **Pickup Slip** for pickup orders (same two-copy A4 layout used today). Callers pass `settings.shop_name?.value` from `useAuth()`.

The fixes it carries, from comparing the two existing generators:
- **Header:**
  - The address and phone come from the order's own location (`GET /sales/:id` already returns them). The hard-coded "Model Town" address is removed, because it would print the wrong address once a second location opens.
  - The shop name uses the Settings value when the viewer has it, otherwise "Flower Point", which is today's actual setting. `GET /settings` is owner/manager-only, so staff never receive it. Delivery Details' existing lookup also reads the response in the wrong shape and has always fallen back, so every challan printed today shows the fallback name. Making the real setting visible to staff would need a small new read-only endpoint (shop name only); that's left out unless you want it, since the fallback matches the real name today.
- **Amount line:**
  - Delivery orders print the cash on delivery **still to collect** (`delivery.cod_amount − cod_collected`), which is what the Delivery Details challan prints today.
  - Pickup orders print the balance due (`grand_total − sum(payments)`).
  - Credit sales print "CREDIT SALE".
  - The old dashboard version read a `total_paid` field `sales` doesn't have, so it printed the **full total as due** on any partly-paid order.
- **Escaping:** customer-typed text (card message, address, notes) is HTML-escaped before it goes into the print page.

Callers after the change: the Delivery Details panel, Sale Details, the dashboard order popup (`QuickModals.js`), Dashboard V2, and the two new card buttons from item 2. All of them print the same thing.

## 6. Out of scope (named, not silently dropped)

- Changing what any role is allowed to do. Gates move as-is; Convert to COD/Credit stays owner/manager-only, matching the server.
- Redesigning Delivery Details' look.
- The `delivery_challan_copies` setting: it exists in Settings but nothing reads it today. Wiring it up is a separate request.
- `DeliverySlip.js` at the repo root, an old Google Apps Script that isn't part of the app.

## 7. Existing bugs found while scoping (flagged; fixed only where the move touches them)

- **"Convert to Pickup" on Delivery Details does nothing on web:** it uses `Alert.alert` with buttons, which react-native-web doesn't show. Sale Details' own Convert flow already works, so this button isn't moved into the panel and stays on Delivery Details. I'd switch it to the app's `showConfirm` as a one-line follow-up; tell me if you want that bundled.
- **Rider proof-photo upload failure is silently ignored** (`console.warn`, delivery still marked done). This is kept as-is in the move: blocking a delivery on a photo upload would be a behaviour change.

## 8. Testing

- Syntax check of every touched file with `app/scripts/babel-check.js`.
- Live trace on the dev server at Test Loc (location 4) with a throwaway delivery order, once from Sale Details and once from Delivery Details:
  1. Assign rider.
  2. Pick up.
  3. Start delivery.
  4. Mark delivered with partial COD (cash).
  5. Confirm the sale's payment status and the register both update, and the board card moves stage.
  6. On a second order: mark failed → reattempt → cancel.
  7. Print the challan from Sale Details, the dashboard card and Orders Inbox; confirm identical output and the correct amount on a partly-paid order.
- Re-run `verify-order-flows.js` and `verify-register-expenses.js`. Nothing server-side changes, but the deliver/COD path touches register totals.
- Check each role: owner, counter_staff, employee (sees no lifecycle buttons), and delivery_partner (unchanged; can't reach Sale Details).
