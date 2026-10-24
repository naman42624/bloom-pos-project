# Session log — device move + Oct 2026 bug batch (2026-10-23 → 2026-10-24)

Branch: `fix/oct-bug-batch` (off `main` @ `78913b3`). Read this before resuming.

## 1. Device move (done)
- Working copy: `~/Downloads/Projects 2/test Project`. `~/Downloads/Projects/test Project` is an old **copy only**.
- Both copies had cross-linked worktrees. Each copy's worktree pointer files were rewritten to point only at itself; `git worktree list` is clean in both. Don't run `git worktree repair <paths>` again.
- Postgres 16.15 installed (Homebrew, linked, service on 5432). Postgres 15 is stopped and unlinked: it couldn't read the v16 dump (`unsupported version (1.15)`).
- DB `bloomcart` restored from `bloomcart_20261021.dump` (56 tables, 283 sales at restore).
- `npm ci` run in `app/` and `server/`. `deasync` and `fsevents` install scripts were skipped by npm 11's allowlist; `deasync` loads fine from its prebuilt binary.
- `gh` installed and logged in as `naman42624`. The GitHub MCP connector fails to connect.
- `DEVICE_TRANSFER_HANDOFF.md` §6 was out of date: `feature/order-list-redesign` was already merged (PR #5), and its last commit `e39ec95` is on main as `e606c52`.

## 2. User's bug list and status
| # | Item | Status |
|---|---|---|
| — | PR for `fix/whatsapp-share-mobile-popup-blocked` | Opened **#13**, not merged, not phone-tested |
| 1 | Two missing tests in `verify-order-requests.js` | ✅ `0ad7a7e`: items_json round-trip + cross-customer isolation (mutation-tested). 21/21 |
| 4 | Tomorrow / picked-date orders missing from the owner/manager dashboard | ✅ `c09d5f9`. Root cause: board fetch ignored dateScope since 2026-09-05, board split against real today, Tomorrow chip (2026-09-13) assumed a re-fetch that didn't exist. Verified with a throwaway order via API; banner not yet seen on screen |
| 2 | Print challan from dashboard cards + Orders Inbox; one shared printer; redesign | ✅ `1ac829e`. See §3 |
| 3 | Delivery actions on Sale Details + challan; fix Convert to Pickup on web | ✅ `d575a69..991328f`. Spec `docs/superpowers/specs/2026-10-24-sale-detail-delivery-actions-design.md`, plan `docs/superpowers/plans/2026-10-24-sale-detail-delivery-actions.md`, built with subagent-driven development + per-task and whole-branch reviews. See §6 |

**Deferred by the user until these are done:** Pickup Orders screen redesign (spec exists, no plan), order-list deferred findings A9/A12/A13/A14, CLAUDE.md known gaps (customer-order 500, trust proxy, requested_time regex, prod `scheduled_time` type, useSubmitGuard audit), roadmap 7–10.

## 3. Item 2 details (for anyone touching printing)
- `printOrderSlip(saleId)` in `app/src/utils/printHelpers.js` is the only slip generator. It fetches `GET /sales/:id` plus the new `GET /settings/shop-info`.
- Balance rule matches SaleDetailScreen: paid = sum(payments) (rider COD collection inserts a payment row), balance = grand_total − paid.
- The shop name comes from the setting via `/settings/shop-info`, which returns `shop_name` only and is open to all staff roles plus `delivery_partner`; the fallback is "Flower Point". `GET /settings` stays owner/manager-only. DeliveryDetail's old lookup read the response in the wrong shape and had always fallen back.
- All text is HTML-escaped.
- The shop copy leads with PAID IN FULL / BALANCE DUE (+ total, paid, by method) / CREDIT SALE — DO NOT COLLECT. The customer copy shows only "Amount to pay" or "PREPAID".
- `delivery_challan_copies` setting: in Settings UI, read by nothing.

## 4. Item 3 key findings (also in the spec)
- On web, `Alert.alert` with buttons does nothing. DeliveryDetail's Reattempt, Cancel Delivery and Convert to Pickup are therefore dead at the counter, so a failed delivery can't currently be re-sent or cancelled on web.
- DeliveryDetail gates are narrower than the server. Counter staff are hidden Pick Up and Mark Delivered, which the server allows and which they already do from SaleDetail's one-tap and the dashboard. The user approved mirroring the server.
- Reuse: `AssignPickerModal`, `useSubmitGuard`, `showAlert`/`showConfirm`, `DeliveryChecklist`.

## 5. Testing notes
- Rendering slips without the app: `/private/tmp/.../scratchpad/render-slips.js` transpiled `printHelpers.js` with the app's babel and stubbed RN/expo/api, then headless Chrome screenshots. The scratchpad is session-only; recreate it if needed.
- A one-off JWT for any user: in `server/`, `node -e "require('dotenv').config(); console.log(require('jsonwebtoken').sign({id:ID}, process.env.JWT_SECRET, {expiresIn:'5m'}))"`.

## 6. Item 3: what was built and decided
**Built.** One shared `app/src/components/delivery/DeliveryActionsPanel.js` is mounted on both Delivery Details and Sale Details (no copied logic). Which buttons show comes from the pure `deliveryActionRules.js`, which mirrors each server route's `authorize()`, the delivery-ownership check, the `pref_counter_marks_*` flags, and the sale-must-be-ready check for pickup. Its tests are in `app/scripts/verify-delivery-action-rules.js`.

**Server changes (additive only).** `GET /deliveries/:id` now also returns:
- `counter_can_mark_picked_up` and `counter_can_mark_delivered`
- `sale_status`
- `refunded_total`

**Bugs fixed along the way.**
- **COD amount check.** `PUT /deliveries/:id/deliver` compared COD in float, so after a partial collection it rejected even the exact amount owed (owed 1.14, already collected 0.10, then 1.04 was refused). It now compares in whole paise via `codExceedsRemaining` (`server/utils/settlement-math.js`, tested by `server/scripts/verify-settlement-math.js`).
- **Dead on web.** Reattempt, Cancel Delivery and Convert to Pickup did nothing on web. They now work and were checked on screen as the owner.
- **Converted pickups.** A delivery converted to pickup now shows Confirm Pickup on Sale Details and prints a Pickup Slip.
- **Paid orders.** "Cancel delivery and order" is not offered when the order has money paid. Staff are told to refund it first.
- **Order not ready.** Pick Up is replaced by "Pick-up unlocks once the order is marked ready" until the order is ready.

**Tap counts.**
- Assign a rider from an order: was 3 + Back, now 2.
- Print the challan: was 2 + Back, now 1.
- Mark a prepaid order delivered (counter or owner): still 1 tap, no form. Riders keep the form with the optional proof photo.
- Reattempt, cancel or convert on web: was impossible, now 2 taps.

**Verification.**
- `verify-order-flows` 60/60, `verify-register-expenses` 13/13, `verify-order-requests` 21/21, plus both pure-math scripts.
- An API lifecycle trace covering part-paid COD, the paise case, fail/reattempt/cancel, and another rider getting 403.
- On screen as the owner on web.
- **Not checked on screen:** counter_staff and employee views. Shared-device staff start PIN-locked and no PIN is set at Test Loc.

**Decisions for the user (not changed).**
- `/reattempt` resets the sale to `confirmed`, so the order has to be marked ready again before pickup. This is existing server behaviour.
- Riders can now print the shop copy, which includes the total, paid amount and payment methods.
- **Deploy the server before the app.** A newer app talking to an older server gets no `sale_status`, which hides Pick Up.

**Deferred minors.** The full list is in the SDD ledger. The highest-value ones:
- "View full delivery →" goes nowhere in stacks without a Delivery Details route (customer and florist).
- There is no way to cancel an `assigned` delivery in the app.
- Non-rider staff lose the optional proof photo on prepaid deliveries.
