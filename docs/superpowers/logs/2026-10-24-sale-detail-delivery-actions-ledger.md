# SDD ledger — plan: docs/superpowers/plans/2026-10-24-sale-detail-delivery-actions.md

Spec: docs/superpowers/specs/2026-10-24-sale-detail-delivery-actions-design.md
Branch: fix/oct-bug-batch · plan base commit: 26840fb

## Pre-flight conflict scan
| Pair / task | Produces vs consumes | Finding |
|---|---|---|
| T1 → T2 | T1 adds `counter_can_mark_picked_up` / `counter_can_mark_delivered` (bool) on GET /deliveries/:id; T2 rules read the same two names | match |
| T1 → T3 | flags arrive via `api.getDelivery` response, panel passes `delivery` to rules | match |
| T2 → T3 | `getDeliveryActions`, `ACTION_ORDER`, `PRIMARY_ACTIONS`, `isFinalDelivery` | match |
| T3 → T4 | default export forwardRef panel `{deliveryId, navigation, onChanged, compact}`, ref `{refresh}`; T4 passes `onChanged={fetchSale}` (exists ~L305) | match |
| T3 ↔ T4 shared file? | no shared files (T3: panel + DeliveryDetailScreen; T4: SaleDetailScreen) | none |
| T1 self | test asserts flag equals setting; impl uses existing getStageFlags | consistent |
| T2 self | every expected array re-derived against the rules table + ACTION_ORDER | consistent |
| T3 self | panel renders for final statuses (print only) — rules give `print` for delivered/cancelled | consistent |
| T4 self | step-3 grep expects only the "View full delivery" navigate; change 4 removes the cancel-guard navigate | consistent |
| Plan vs spec | plan adds the server flags (spec §4.2 said role-only) — T1 amends spec; `fail` widened to picked_up per server; customer excluded from live_location | consistent with spec intent "mirror the server" |

Scan clean — no rulings needed.

## Progress
Task 1: dispatched (base 26840fb)
Task 1: implemented d575a69 (59/59); review dispatched
Task 1: minor (deferred): flag check only exercises the currently-stored setting values (both '1' locally); never proves the false branch
Task 1: minor (deferred): flags visible to every role that can GET a delivery (non-sensitive prefs, as briefed)
Task 1: complete (commits 26840fb..d575a69, review clean)
Task 2: dispatched (base d575a69)
Task 2: implemented e80935c; review dispatched
Task 2: minor (deferred): test spot-checks miss null partner userId, owner/own-rider pickup on assigned, cancelled status, live_location with null partner id
Task 2: minor (deferred): unrecognized roles get print + live_location (per table "every role except customer")
Task 2: complete (commits d575a69..e80935c, review clean)
Task 3: dispatched (base e80935c)
Task 3: implemented 1030592 (DONE_WITH_CONCERNS: 618-line panel, live-location moved into panel, fulfill-from-stock now showConfirm, hasLoaded spinner ref); review dispatched
Task 3: Ruling: COD pre-fill uses the exact remaining amount (2-dp, trailing zeros dropped; 0 remaining pre-fills "0"), overriding the plan's `toFixed(0)` — the spec intent is "pre-fill what's owed" and the server rejects cod_collected > remaining, so rounding up (e.g. 499.50 -> 500) blocks a rider at the door — cost if wrong: a cosmetic "499.5" instead of "500" on the form
Task 3: minor (deferred): "Cancel delivery and order" half-success (cancelDelivery ok, cancelSale fails e.g. unrefunded balance) shows "Could not update delivery" and does not call onChanged — pre-existing shape, worse title
Task 3: minor (deferred): Fulfill from Stock onConfirm not guard-wrapped (confirm dialog in front; pre-existing); Convert to Pickup error title "Error"
Task 3: minor (deferred): failReason not cleared after reattempt (pre-existing)
Task 3: minor (deferred): panel 618 lines (~75 styles)
Task 3: fix round 1/5 (0 addressed, 1 open — COD pre-fill still trips server float compare after partial collection, e.g. 1.14 owed, 0.10 collected → remainder 1.0399999…; commits 1030592..57c9d87)
Task 3: Ruling: fix the root cause server-side — `PUT /deliveries/:id/deliver` compares in whole paise (Math.round(x*100)) instead of raw float subtraction; client pre-fill stays round-to-paise — even a rider typing the exact amount owed is rejected today (pre-existing bug, also under the old toFixed(2) pre-fill), so a client-only floor would leave typed amounts broken — cost if wrong: one extra small server change outside the plan's original scope (behavior only loosens the rejection by <1 paisa of float noise)
Task 3: minor (deferred): openDeliverForm leaves a stale codAmount when cod_amount is 0 (field hidden in that case)
Task 3: fix round 2/5 (1 addressed, 0 open; commits 57c9d87..cebdee0)
Task 3: minor (deferred): deliver route `totalCodCollected += cod_collected` raw float add (DECIMAL column rounds on write — nil impact)
Task 3: minor (deferred): codExceedsRemaining has no NaN guard (upstream isFloat validation makes it unreachable)
Task 3: complete (commits e80935c..cebdee0, review clean)
Task 4: dispatched (base cebdee0)
Task 4: implemented f943582 (DONE_WITH_CONCERNS: no-COD Mark Delivered 1→2 taps; card live-location removed; blocked block shown when one-tap hidden; customer dead link pre-existing); review dispatched
Task 4: Ruling: accept prepaid (no COD due) Mark Delivered on Sale Details going 1 tap → 2 (Mark Delivered → Confirm Delivered in the panel) — spec §4.5.3 deliberately hides the one-tap so there is never a second Mark Delivered button; making the panel skip its form when nothing is due would also strip riders (same panel on Delivery Details) of the optional proof photo + notes on prepaid orders; spec §4.6 table missed this row — cost if wrong: one extra tap per prepaid delivery marked from the counter; easy follow-up = skip the form only for non-rider roles
Task 4: Ruling (supersedes the earlier Task 4 tap ruling): restore 1-tap Mark Delivered for prepaid — in the panel, when nothing is left to collect (remaining COD in paise <= 0) and the viewer is NOT the delivery_partner, Mark Delivered submits directly (same deliverDelivery call/payload the form would send with no COD, no photo, no notes); riders keep the form (optional proof photo + notes) — reviewer showed prepaid is the most common completion and spec §4.6 says no flow gets longer, user explicitly asked to save clicks — cost if wrong: counter/owner lose the optional proof photo + notes on prepaid deliveries from that button (no one used them there before: the old one-tap had none)
Task 4: minor (deferred): cancel-guard copy "Mark the delivery as failed first" names an action counter_staff (and anyone on an assigned delivery) can't take — plan-mandated text, not a regression
Task 4: minor (deferred): "View full delivery →" dead in stacks without DeliveryDetail (CustomersStack, FloristStack, CustomerOrderDetail) — pre-existing; one-line routeNames guard would hide it
Task 4: minor (deferred): panel action triggers two delivery GETs (panel refresh + fetchSale→refresh)
Task 4: fix round 1/5 (1 addressed, 0 open; commits f943582..8e8fff7)
Task 4: minor (deferred): non-rider staff lose optional proof photo on prepaid deliveries (both screens, shared panel) — accepted cost of the one-tap ruling
Task 4: complete (commits cebdee0..8e8fff7, review clean)
Task 5: regression green (order-flows 59/59, register-expenses 13/13, order-requests 21/21, settlement-math OK, delivery-action-rules OK); API trace all pass (A part-paid counter deliver, A2 paise 1.14/0.10, B fail/reattempt/fail/cancel-only, B2 cancel delivery+order, C other rider 403); on-screen as owner on web: failed→Reattempt works, Cancel delivery+order works, pending→Assign picker opens (empty-roster notice), Convert to Pickup works on Delivery Details, Print challan buttons present; counter_staff/employee on-screen NOT done (shared-device PIN lock, no PIN set at Test Loc) — handed to user; all throwaway data deleted
Task 5: observation: reattempt resets sale.status to 'confirmed' (pre-existing server), so Pick Up after reattempt shows "Order is not ready for pickup yet" until the order is marked ready again
Task 5: observation: Pick Up button shows on assigned deliveries before the order is ready (rules are status/role only) → plain server message; same as Delivery Details before
Final review: Ready after fixes — C1 converted-pickup no finish button on Sale Details; I1 converted pickup prints delivery challan/COLLECT ON DELIVERY; I2 cancel delivery+order half-succeeds on paid orders; I3 Pick Up offered when order not ready (after reattempt); minors M1-M6 (findings in final-findings.md)
Ruling: fix C1, I1, I2, I3 and minors M1-M6 in one fix wave; I3 via additive `sale_status` on GET /deliveries/:id + rules gate — the pickup readiness gate mirrors the server exactly like the role gates — cost if wrong: one extra response field
Ruling: do NOT change /reattempt resetting the sale to 'confirmed' — product decision, surfaced to the user — cost if wrong: one extra "mark ready" step after every reattempt stays
Ruling: riders printing the full shop copy (total/paid/method) is a deliberate widening, kept and surfaced to the user — cost if wrong: riders see payment breakdown they couldn't see on Delivery Details before
Final fix wave: commits 8e8fff7..991328f (C1,I1,I2,I3,M1-M6; additive sale_status + refunded_total on GET /deliveries/:id; order-flows 60/60); scoped re-review dispatched
Final fix wave: re-review all findings addressed (C1,I1,I2,I3,M1-M6)
Final: parked — owner/manager on an assigned delivery told "Ask the owner or manager to cancel the delivery first" (self-referential; no cancel-from-assigned exists, spec §4.5.4 out of scope) — Ruling: wording stands until cancel-from-assigned is designed
Final: parked — deploy order: app before server makes sale_status undefined → Pick Up replaced by "unlocks" line — Ruling: deploy the server first (noted in session log / PR)
Final: parked — Orders Inbox shares one print guard across rows (cross-row tap during a print is ignored; harmless)
