# Handoff — staff UX batch (2026-11-01)

Written at the end of a long session so the next one can pick up without re-deriving anything. Read this, then `CLAUDE.md`.

## 1. Where things stand

| PR | Branch | State | What |
|----|--------|-------|------|
| #18 | `feature/slip-qr-open-orders-checkout` | merged | Slip QR page, open order link, checkout drafts, dues with an order, iPhone voice notes (m4a via `ffmpeg-static`), all order photos on the slip page |
| #19 | `fix/observations-dues-batch` | merged | Dues without an order (`CollectDuesSheet`), Customers moved Profile → dashboard, observations batch |
| #20 | `fix/balance-due-spacing` | **open** | Sale Details "Balance Due" text gets `flex: 1` (one line) |
| #21 | `fix/staff-ux-batch-nov` | **open** | Everything in section 2 below (5 commits, app-only, no server/DB change) |

Neither open PR touches the server or database. #20 and #21 don't overlap, so they can merge in any order.

## 2. What PR #21 contains (`fix/staff-ux-batch-nov`)

1. `a74637e`
   - **PIN lock screen** (`LockScreen.js`):
     - keyboard entry on web (digits, Backspace, Escape);
     - the PIN is held in a ref, so fast taps no longer drop digits;
     - a fixed-height error/spinner line, so the keypad never moves;
     - the "Owner / Manager login" and "Not <name>?" links are 48px tall.
   - **Dashboard register card** showed "—" when nobody had opened the register that day. It now reads `isOpen` (`DashboardScreen.js`, two places), so "Closed" and the "Register isn't open" reminder appear.
   - **Quick Checkout** hid the "now too" switch on an empty cart. Superseded by commit 2.
2. `279da84` **One Old dues card.** `CollectDuesToggle.js` was renamed to `app/src/components/OldDuesCard.js`.
   - It replaces the red dues line, the "dues only" button and the "now too" switch on Quick Checkout and Log Order.
   - Its button opens `CollectDuesSheet`.
   - When there is an order (`onAddToOrder` given), the sheet asks **When?**:
     - "Together with this order" (default). Nothing is recorded yet; the amount and method go back to the screen and are taken after the order is created, through the existing `api.addCreditPayment` with `exclude_sale_id`.
     - "Only the dues, now".
   - The card then turns green, with Change and Remove.
   - Dues are dropped when the customer changes or the cart is emptied.
   - The dues method is now always the one picked in the sheet. `duesPaymentMethod`/`orderMethodIfPaidNow` were removed.
   - **User chose this design** (one card plus always a panel) over "dues as a bill line".
3. `f30dac3` **No lifetime total at checkout.**
   - The customer line reads "✓ Registered customer • 19 orders".
   - Search suggestions show "Owes ₹X" instead of the lifetime total.
   - The total stays on the customer profile.
4. `d940b0c` **Open the register from checkout.** New `app/src/components/OpenRegisterSheet.js`.
   - A cash sale with the register closed shows "Register is closed" instead of the old "go to Cash Register" confirm.
   - Its contents:
     - "Cash in the drawer now" (pre-filled from today's last close `actual_cash`);
     - **Open register & place order** (Log Order: "& save order"), which calls `api.openRegister` and then re-runs the guarded place/save handler;
     - Quick Checkout only: **Save as draft for later**. `handleSaveDraft` now returns true/false. Log Order has no drafts.
5. `7d0d143` **Collect dues panel opens the register in place.**
   - `OpenRegisterForm` was split out of `OpenRegisterSheet` (no modal), and `CollectDuesSheet` swaps to it when cash is chosen and the register is closed.
   - Its buttons: "Open register & collect ₹X", and "They paid by UPI instead" (goes back with UPI picked).
   - The `onOpenRegister` prop was removed from the sheet and its 3 callers.

### Verified on screen (web, throwaway counter_staff account, all test data removed afterwards)
- **PIN screen:**
  - a wrong PIN typed on the keyboard → "Wrong PIN — 4 tries left", and the keypad didn't move (measured);
  - a burst of 4 taps unlocks.
- **Dashboard:** "Closed" and the reminder show.
- **Dashboard → Customers → Orders tab** lands on the Orders Inbox (item 3, already fixed by #19).
- **Old dues card:**
  - with an empty cart, the panel has no When?;
  - with an item, When? shows → "Add ₹1700 (UPI) to this order" → green card → "Take from customer now ₹1700 (UPI)";
  - Remove works.
- **Cash sale with the register closed** → panel → 500 → order placed (opening 500, expected 510).
- **Customers → Collect ₹1 cash with the register closed** → in-place form pre-filled ₹600 → recorded; the register opened.

### NOT verified on screen
- Placing an order with dues added.
- The Log Order Old dues card, and the Log Order register panel.
- "Save as draft for later".
- The new customer line and "Owes ₹X" suggestions (babel check only).
- The PIN screen on a phone.

## 3. Open questions for the user (raised, not answered)
From the item-7 investigation ("Test Receiver" showed ₹24,600 dues and no orders):
- **Cause:** test leftovers. `verify-order-flows.js` converts a ₹200 receiver-only delivery to credit, which books the dues on the receiver. Its cleanup deletes the sale but never reverses `users.credit_balance`/`total_spent`. Test Receiver is user 475; the logic is in `server/routes/deliveries.js`, `to_credit` branch, around line 1040.
- **Product question:** converting a delivery that has no sender to credit charges the receiver, who is usually the gift recipient. Should it ask staff who pays instead?
- **Inconsistency:** the Customers list's `order_count` (`GET /customers`, `server/routes/customers.js` around line 85) counts only `customer_id`. Checkout's lookup counts `customer_id OR sender_customer_id`. I recommended making the list match.
- **Offer:** make the verify scripts reverse the dues they add.

## 4. Known, deliberately not done
- `DashboardScreenV2` (off by default) is unchanged.
- Log Order has no drafts, so its register panel has no "Save as draft".
- Earlier deferred items are still in `CLAUDE.md` (Known structural debt) and `.superpowers/sdd/2026-10-28-slip-qr-open-orders-checkout/progress.md`.

## 5. Working environment (this machine)
- **Repo:** `/Users/gauravbhatia/Downloads/Projects 2/test Project` ("Projects 2" only). Postgres 16, DB `bloomcart`, user `bloomcart`, host localhost.
- **API on :3001:**
  ```
  cd server && TRACKING_LINK_SECRET=verify-secret nohup node server.js > /tmp/api.log 2>&1 &
  ```
- **Metro on :8081 does not watch files.** Restart before any on-screen check:
  ```
  pkill -f "expo start"; (cd app && CI=1 BROWSER=none nohup npx expo start --web --port 8081 --clear > ../.superpowers/sdd/2026-10-28-slip-qr-open-orders-checkout/metro.log 2>&1 &)
  ```
  Wait about 50 s, then load `http://127.0.0.1:8081/`.
- **Babel check:**
  ```
  cd app && node -e "require('@babel/core').transformFileSync('<file>',{presets:['babel-preset-expo']})"
  ```
- **Server suites:** run from `server/` after:
  ```
  export TRACKING_LINK_SECRET=verify-secret VERIFY_OWNER_PHONE=9876453210 VERIFY_OWNER_PASSWORD=naman1234
  ```
  - `verify-order-flows.js` (64)
  - `verify-register-expenses.js` (13)
  - `verify-order-requests.js` (21)
  - `verify-slip-and-open-requests.js` (34)
  - Wait about 65 s between the last two (shared rate limiter).
- **Throwaway staff account for on-screen tests** (don't reset real users' PINs):
  1. Mint an owner JWT with `jsonwebtoken` and `JWT_SECRET` from `server/.env` (`{id:1}`).
  2. `POST /api/users` with `{role:'counter_staff', location_ids:[1], ...}`, then `PUT /api/users/:id/pin`.
  3. Put the PIN and token in the scratchpad, never in chat.
  4. In the browser, set the localStorage keys `@bloomcart_token`, `@bloomcart_user` (user + locations), `@bloomcart_active_location` and `@bloomcart_device_location`, then reload.
  5. Staff web sessions always start on the PIN lock screen: tap your tile and type the PIN.
  6. Afterwards, delete the account's `user_locations`, `audit_logs`, `notifications` and `users` rows, and any sales, `cash_registers` or `credit_payments` it created. Restore any customer balance you changed.
- Patch `window.alert`/`window.confirm` in the page before triggering dialogs (web dialogs block automation).
- **Commits and PRs:** end commits with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and PR bodies with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Push and open PRs only when the user asks.

## 6. User preferences seen this session
- Wants a short list of options with a recommendation; picks quickly.
- Cares a lot about tap count and first-time-user clarity. Run the `staff-ux-checklist` and count taps.
- Wants on-screen verification and a note of any other issues spotted while testing.
- Prefers adding related follow-ups to the open PR rather than stacking new ones.
