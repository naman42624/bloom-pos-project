# Final whole-branch review — findings to fix (one fix wave)

Fix ALL of these. Each: file:line from the reviewer, failure, required fix.

## C1 (Critical) — converted pickup has no finish button on Sale Details
`app/src/screens/SaleDetailScreen.js` ~:1053 `showOneTapAction = hasNoInputNextAction && !sale.delivery`. Delivery→Pickup conversion (`PUT /sales/:id/convert-type`) leaves the delivery row with status `cancelled`, so `sale.delivery` is truthy → Confirm Pickup one-tap hidden; Complete Order also hidden (its gate needs `!hasNoInputNextAction`, ~:1664); blocked block not rendered. Fix: hide the one-tap only when an OPEN (non-final) delivery exists and the panel is showing — e.g. `hasNoInputNextAction && !hasOpenDelivery` where open = delivery exists and status not in delivered/cancelled/(failed? — the panel shows for failed; keep one-tap hidden whenever the panel is rendered with lifecycle actions). Simplest correct rule: hide the one-tap iff `sale.order_type === 'delivery' && sale.delivery && sale.delivery.status !== 'cancelled'`, or iff nextAction.label is 'Mark Delivered'. Pick whichever is clearest; Confirm Pickup must show for a converted pickup.

## I1 (Important) — converted pickup prints "Delivery Challan … COLLECT ON DELIVERY"
`app/src/utils/printHelpers.js` ~:204 and ~:239: `isDelivery = !!sale.delivery || order_type==='delivery'`. Fix: `isDelivery = sale.order_type === 'delivery' || (!!sale.delivery && sale.delivery.status !== 'cancelled')`. Also on Sale Details: do not render the Delivery section/panel when `sale.order_type === 'pickup' && sale.delivery?.status === 'cancelled'` (a pickup order should not show "Delivery: CANCELLED" + Print Challan). Check `canPrintOrderSlip` / button labels still read "Pickup Slip" correctly for such an order.

## I2 (Important) — "Cancel delivery and order" half-succeeds on paid orders
`app/src/components/delivery/DeliveryActionsPanel.js` ~:282-294: cancels the delivery, then `cancelSale`, which the server refuses for any sale with unrefunded payments (sales.js ~2314) — the common case. Delivery ends cancelled (unrecoverable in UI), error says "Could not update delivery", `onChanged` not called so the host is stale.
Fix:
- Before offering the combined option, compute net paid for the sale from data the panel already has (GET /deliveries/:id payload includes payments — check its exact shape; subtract refunds if present). If net paid > 0: show only "Cancel delivery only" and "Back", plus one plain line: "This order has ₹X paid. To cancel the whole order, refund it first from the order screen." (in paise-safe integer math, display with ₹ and no float noise).
- Keep a safety net for races: if cancelDelivery succeeds and cancelSale then fails, call `onChanged()` and show `showAlert('Delivery cancelled', 'The order itself was not cancelled: ' + err.message)` — not "Could not update delivery".

## I3 (Important) — "Pick Up Order" offered when the order isn't ready (incl. right after Reattempt)
Server `/pickup` requires sale status ready/completed ("Order is not ready for pickup yet"); `/reattempt` resets the sale to `confirmed`. Rules gate only on delivery status + role.
Fix (additive server change only): add the sale's status to the `GET /deliveries/:id` response as `sale_status` (e.g. `s.status AS sale_status` in its SELECT — check the query joins sales; don't rename/remove any existing field); in `deliveryActionRules.js`, `pickup` additionally requires `['ready','completed'].includes(delivery.sale_status)`. When pickup is withheld ONLY because the order isn't ready, the panel shows one plain line in place of the button: "Pick-up unlocks once the order is marked ready." Add rules-script cases (assigned + sale_status confirmed → no pickup; assigned + ready → pickup). Add a check to `server/scripts/verify-order-flows.js` that GET /deliveries/:id includes `sale_status` matching the sale. Do NOT change /reattempt's behaviour (product decision, flagged to the user).

## Minors to fix in the same wave (cheap)
- M1 `DeliveryActionsPanel.js` ~:395 COD form label uses `codRemaining.toFixed(0)` while the field uses the exact paise prefill → label "₹500 remaining" vs field 499.5. Use the same formatted value in the label.
- M2 `DeliveryActionsPanel.js` ~:543 rider picker meta "N stop(s) today" overclaims (no date filter). Reuse the exact meta phrasing + "no riders at this location → show all riders" fallback that `OrdersInboxScreen.js` / `DeliveriesScreen.js` use (find it; reuse, don't copy logic if a helper exists).
- M3 `DeliveryActionsPanel.js` ~:317 Reattempt confirm text says 'goes back to "assigned"' — jargon. Use: "Send it out again?" / "The same rider can take it out again."
- M4 print buttons in `app/src/components/orderBoard/OrderCard.js` ~:488 and `app/src/screens/OrdersInboxScreen.js` ~:563 have no double-tap guard → wrap with `useSubmitGuard` (or the same guard the panel uses). OrderCard's print icon is 13px — make its tap target ≥ 44 (padding/hitSlop consistent with the neighbouring Call/WhatsApp buttons; don't restyle those).
- M5 `app/src/utils/printHelpers.js` ~:25 `printHtmlOnWeb` puts `title` into `<title>` unescaped → `esc()` it.
- M6 `SaleDetailScreen.js` ~:476 cancel-order guard message "Mark the delivery as failed first" names actions some viewers can't take. Make it plain and status/role aware: if delivery is picked_up/in_transit and viewer is owner/manager → "The rider has it. Mark the delivery as failed below, then cancel the order."; otherwise → "The rider has this order. Ask the owner or manager to cancel the delivery first." (assigned → "Cancel this delivery first is not possible from here yet — ask the owner or manager." is NOT acceptable wording; use the second sentence.)

## Not to fix (rulings; leave alone)
Riders can now print the shop copy (deliberate widening, flagged to user). /reattempt resetting the sale to confirmed (product decision, flagged). Everything under the reviewer's "Declined to judge".
