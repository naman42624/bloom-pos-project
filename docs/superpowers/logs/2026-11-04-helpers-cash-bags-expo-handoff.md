# Handoff — helpers, helper cash bags, Expo SDK 58 (2026-11-04)

The session that built this got too long to continue. Everything below is current as of commit `7bef600` on `feature/helper-cash-bags`. Read this whole file before you change anything. Read `CLAUDE.md` next: it has the roadmap entries for every feature named here.

The user has said **there are bugs in the helper flow** and will describe them in the new session. Expect that to be the first job. Section 6 lists every problem already known and not fixed, so you can tell new reports apart from known ones.

---

## 1. Where everything is

| Branch | What | Base | Head | Pushed / PR |
|---|---|---|---|---|
| `main` (origin) | PRs #20, #21, #22 (quick sale), #23 (staff sales), #24 (labels/scanner) merged | — | `dd25402` on origin; **local `main` is behind**, so run `git fetch` and compare with `origin/main` | — |
| `feature/helpers-join-sell` | Plan 3: helper role, join QR, Sell / My sales, approval PIN | `feature/labels-scanner` (now in main) | `fb19efa` | **not pushed, no PR** |
| `feature/helper-cash-bags` | Plan 4: helper cash bags | `feature/helpers-join-sell` @ `fb19efa` | `7bef600` | **not pushed, no PR** |
| `chore/expo-sdk-58` | Expo SDK 54 → 58.0.23 | `origin/main` @ `2a8e39d` | `5a38d48` | **not pushed, no PR**. Lives in worktree `.claude/worktrees/agent-ae7957380276e6ba1` |

The main checkout (`~/Downloads/Projects 2/test Project`) is on `feature/helper-cash-bags`. It has many untracked scratch files (old reports, `check_db*.js`, dumps). They belong to the user, so leave them alone.

**Pending decision for the user (ask them):** push and open three PRs:
1. `feature/helpers-join-sell` → `main`.
2. `feature/helper-cash-bags` → `feature/helpers-join-sell`. Retarget it to `main` after (1) merges.
3. `chore/expo-sdk-58` → `main`. This one is independent.

Use merge commits, not squash. Ask before you push.

**Expo and the helper branches:** the Expo branch does **not** contain the helper or cash-bag work. To get one branch with everything, merge `origin/main` into the helper branches once they are merged, or merge `chore/expo-sdk-58` into a test branch. Then, in `app/`, rerun `npm install expo@58.0.23 && npx expo install --fix` so `package-lock.json` is consistent. Both sides changed `app/package.json` and `app/package-lock.json`.

---

## 2. What was built (and why)

### 2.1 Plan 3: helpers join and sell (`feature/helpers-join-sell`)
- **Plan and ledger:** plan `docs/superpowers/plans/2026-11-02-helpers-join-and-sell.md`. Ledger `.superpowers/sdd/2026-11-02-helpers-join-and-sell/progress.md` holds rulings 1–11 and the parked items. It is git-ignored, so it exists only on this machine.
- **Spec:** `docs/superpowers/specs/2026-11-02-scan-sell-helpers-staff-sales-design.md` §5–§10.
- **The role:** a new `helper` role for temporary staff using their own phones.
  - The owner or a manager adds a helper (name, phone, "Works until") in Staff → Add helper and shows a one-time join QR.
  - The helper scans it, sets a 4-digit PIN, and gets only two tabs: **Sell** and **My sales**.
- **Access rules:**
  - `users.access_until` is the last working day. Access ends at shop-local midnight after it.
  - An expired helper gets 401 `Your access ended on <D Mon>. Ask the owner if you need more days.` everywhere.
  - Helpers never get a password login.
  - Helpers are **denied by default** in `authenticate`. Only the routes in `server/utils/helper-routes.js` `HELPER_ROUTES` work. **A new route a helper needs must be added there as well as to its `authorize()`.**
  - Product answers to helpers drop stock numbers and costs, and say only available or not.
- **Join links:** stored in `helper_join_tokens` as a SHA-256 hash. They last 24 h and work once; a new link cancels the old one.
  - The public `GET/POST /api/auth/join` routes have their own limiter of 20 per minute per IP.
  - Join tokens are removed from logs by `server/utils/redact.js`.
  - Every response that returns a user goes through `server/utils/public-user.js`, so `pin_hash` is never sent.
- **Selling:**
  - `server/utils/helper-sale.js` rebuilds the helper's `POST /api/sales` body:
    - walk-in only;
    - catalog, option and open-price lines only;
    - prices come from the server;
    - cash or UPI, paid in full.
  - `sales.client_ref` (unique per creator) makes retries safe. An unfinished or undone sale answers 409, never "saved".
  - A discount over `discount_helper_threshold` needs a PIN override from counter staff, a manager or the owner linked to the shop (`server/utils/approval-pin.js`). That code reserves each PIN try atomically before running bcrypt. **Never call it inside a transaction that rolls back.**
  - The owner can give managers and themselves an approval PIN that cannot log in at the counter.
- **App:**
  - `app/src/screens/helper/SellScreen.js` and `MySalesScreen.js`.
  - `app/src/components/helper/*`: TakePaymentSheet, OverridePad, PriceCardsSheet, FindByNameSheet, useHelperSession.
  - `app/src/utils/helperBasket.js` mirrors the server's price, tax and discount maths. **If you change sale maths in `POST /sales`, change this file too.**
  - JoinScreen; AddHelperScreen; HelperJoinQRScreen.
  - "Personal device" lock screen (`@petal_personal_device`).
- **Tests:** `server/scripts/verify-helpers.js` 68/68 and `app/scripts/test-helper-basket.js` 31/31.

### 2.2 Plan 4: helper cash bags (`feature/helper-cash-bags`)
- **Plan and ledger:** plan `docs/superpowers/plans/2026-11-02-helper-cash-bags.md`. Ledger `.superpowers/sdd/2026-11-02-helper-cash-bags/progress.md` holds rulings 1–15, parked items and all task, review and fix reports. It is git-ignored and exists only on this machine.
- **Spec:** §11, §12, §2, §4.2.
- **The setting:** owner setting `helper_cash_mode` is `'register'` by default, which changes nothing, or `'bag'`.
- **In bag mode:**
  - A helper's **cash** sale is kept in their own "bag": `payments.held_by` is set to the helper, nothing is written to the register, and it works with the register shut.
  - UPI still goes to the register.
- **Floats and handovers:** the counter gives change floats out of the drawer and takes blind handovers back in. Both are rows in `staff_cash_movements`, of type `float_out` or `handover_in`, with a `register_id`.
- **Bag balance:** floats + held cash on sales that were not undone − settled handovers, per helper and location. This is `server/utils/helper-bags.js` `getBag`. A refunded-then-cancelled bag sale still counts, because the refund came out of the drawer.
- **Routes (`server/routes/helper-cash.js`):**
  - `GET /api/helper-cash/bags`: amounts are masked server-side by `maskAmount`, e.g. `₹5,xxx`. It carries `has_cash`, and with `include_idle=1` a helper list for floats.
  - `POST /api/helper-cash/bags/:id/reveal`: the exact amount, audited as `helper_bag_reveal`. Helpers can reveal only their own bag.
  - `POST /api/helper-cash/float`: bag mode only; needs an open register.
  - `POST /api/helper-cash/handover`: blind. The request carries only `counted_amount` and `is_final`.
    - `preview: true` (a real boolean only) returns expected, difference and remaining without saving, audited as `helper_bag_handover_preview`.
    - A committed handover is audited as `helper_bag_handover`.
    - A second final handover gets 409 `Already collected — refresh`.
  - Switching the mode is refused while any bag is not zero. The message is `Collect the cash from <names> first (<masked total>).`
- **Locks (keep this order):**
  - Float and handover take `lockBag` first (`pg_advisory_xact_lock(7301, staffId)`), then the register row with `FOR UPDATE`.
  - Undo takes the sale row first, then `lockBag`.
  - Never lock a sale or payment row after `lockBag`.
- **Register maths:**
  - Close and the close preview share `computeRegisterClose` in `server/routes/sales.js`:
    - held cash is excluded;
    - handovers add their `counted_amount`;
    - floats subtract their `expected_amount`, by `register_id`;
    - refunds on cancelled bag sales are kept.
  - The running `expected_cash` moves with each float and handover.
  - A locked blind count (`close_count_locked`) **shifts by the same cash and is never cleared**. This keeps the stricter blind count the user chose.
  - Register status and history carry `helper_floats` and `helper_handovers`. The pickup overwrite in `deliveries.js` and the closed-session inferred expenses include them.
- **Undo and Edit Sale:**
  - A helper's undo is refused once a handover for that helper happened after the sale. The message is `This sale's cash was already handed over. Ask the counter to refund it.`
  - Edit Sale refuses only a **real payment change** on a sale with held cash. The message is `This sale's cash is with a helper. Undo it within 2 minutes, or refund it from the counter.` Name-only edits work.
  - Sale Details now leaves out `payments` when the method is unchanged. This applies to every sale, and also stops a name edit from merging a split cash+UPI payment.
- **App (counter and employee dashboard, bag mode only):**
  - **"Cash with helpers" card** (`app/src/components/helperCash/HelperCashCard.js`): masked rows; tap → reveal for 15 s → **Receive cash** / **Give float**.
  - **Receive cash** (`ReceiveCashSheet.js`):
    1. type the count;
    2. **Next** runs the preview;
    3. "Expected ₹X · Counted ₹Y · Short ₹Z";
    4. **Yes, settle** or **No, part of it**. The part option is hidden when the count is over expected.
    
    The count is read-only after the preview, and **Count again** closes the sheet.
  - **Give float** (`GiveFloatSheet.js`): pre-filled with the last float, or 500.
  - **Close warning** on Cash Register: "₹x is still with <name>. Collect it first?" with **Collect now** / **Close anyway** (audited as `register_closed_with_helper_cash`). The top-up panel adds "Did a helper give you cash? Tap Collect now first."
  - The helper's own masked bag line on My sales.
  - **Owner:** Settings → Helpers cash mode; Staff sales report columns floats, cash collected, handed over, short/over, and times shown. Times shown counts reveals by others, plus previews by others not followed within 10 minutes by a handover of the same count.
  - **Helper:** Take payment no longer tells helpers cash needs the register in bag mode. Helpers get `helper_cash_mode` in their register-status answer.
- **Tests:** `server/scripts/verify-helper-bags.js` 39/39 and `app/scripts/test-helper-cash.js` 10/10.

### 2.3 Expo SDK 58 (`chore/expo-sdk-58`, worktree `.claude/worktrees/agent-ae7957380276e6ba1`)
- **Why:** the user's phone has Expo Go for SDK 58, which refuses SDK 54 projects. Their error was "Project is incompatible with this version of Expo Go… uses SDK 54".
- **Versions:**
  - expo `58.0.23` (pinned exactly, not `~`);
  - react and react-dom 19.3.0;
  - react-native 0.88.1;
  - react-native-web 0.21.4;
  - React Navigation 7 unchanged.
- **Packages added to package.json:** `expo-file-system` (already imported) and `expo-asset` (needed by expo-audio).
- **Fixes:**
  - **Uploads:** from SDK 56, Expo's `fetch` cannot send the `{uri,name,type}` FormData parts every upload in `api.js` uses. The old fetch is turned back on with `EXPO_PUBLIC_USE_RN_FETCH=1` in **committed** `app/.env.development` and `app/.env.production`. If those files are deleted, photo and voice uploads break silently.
  - **CSV export:** the customer ledger export imports from `expo-file-system/legacy`. It was already broken on phones on SDK 54.
  - **app.json:** `newArchEnabled` removed; splash settings moved into the `expo-splash-screen` plugin; 4 default plugin entries added.
  - **Node:** `.nvmrc` changed from 20 to 22. SDK 58 needs Node 22.13 or newer, and so does Vercel if the web build is deployed there.
- **Checks:** expo-doctor 20/20; every app file compiles; app unit tests pass; `expo export --platform web` bundles cleanly.
- **npm audit:** 17 vulnerabilities, 1 critical. **Not investigated.**
- **To run on the phone (the user does this):**
  ```
  cd "/Users/gauravbhatia/Downloads/Projects 2/test Project/.claude/worktrees/agent-ae7957380276e6ba1/app" && npx expo start --clear
  ```
  Stop the SDK 54 dev server in the main folder first, and check `node -v` is 22.13 or newer. The phone app talks to the **live** API `https://api.gifttojalandhar.com/api` (see `app/src/services/api.js` `getBaseUrl`; only web in dev uses `localhost:3001`). Helper and cash-bag features won't work on the phone until the live server has them. To test them on the phone against the local server, set `EXPO_PUBLIC_API_URL=http://<mac LAN IP>:3001/api` for that run.

---

## 3. How to run things locally

- **Postgres:** Homebrew `postgresql@16` on 5432. DB `bloomcart`, user `bloomcart`, password `bloomcart_local_2026`.
  - Shell: `PGPASSWORD=bloomcart_local_2026 psql -h localhost -U bloomcart -d bloomcart`.
  - After a sudden shutdown Postgres may not start because of a stale `postmaster.pid`. That happened on 2026-11-04 and was fixed by moving the file aside and restarting the brew service.
- **API restart:**
  ```
  pkill -f "node server.js"; (cd server && TRACKING_LINK_SECRET=verify-secret nohup node server.js > /tmp/api.log 2>&1 &)
  ```
  Wait for `curl 127.0.0.1:3001/api/health` to return 200. A 000 means the server is down.
- **Suite env (run from `server/`):**
  ```
  export TRACKING_LINK_SECRET=verify-secret VERIFY_OWNER_PHONE=9876453210 VERIFY_OWNER_PASSWORD=naman1234 VERIFY_API_LOG=/tmp/api.log
  ```
- **Server suites** (`node scripts/<name>.js`), with last results on `7bef600`:
  - verify-helper-bags 39/39
  - verify-helpers 68/68
  - verify-identity-roles 11/11
  - verify-staff-sales 12/12
  - verify-quick-sale 28/28
  - verify-order-flows 64/64
  - verify-register-expenses 13/13
  - verify-order-requests 21/21
  - verify-slip-and-open-requests 34/34
  - verify-labels-scanner 24/24
- **Suite timing:** wait **65 s** between `verify-helpers` reruns (the join limiter allows 20 per minute), before `slip`, and before `labels` (run labels last).
- **App tests** (`node app/scripts/<name>.js`), all green:
  - test-helper-cash 10/10
  - test-helper-basket 31/31
  - test-quick-sale 9/9
  - test-scan-add 18/18
  - test-label-sheet 20/20
  - test-scanner-decode 11/11
- **Babel check of an app file:**
  ```
  cd app && node -e "require('@babel/core').transformFileSync('<file>',{presets:['babel-preset-expo']})"
  ```
- **Test data:**
  - Throwaway data goes to location 4, "Test Loc".
  - Register 83 at BOB belongs to the user. Only read it.
  - The suites open their own registers.
  - `helper_cash_mode` must be `register` after any test (it is now).

---

## 4. On-screen tests still to do

Nothing below has been seen by a person yet unless marked otherwise. "Checked by agent" means a desktop-web check as a throwaway counter_staff or helper. The owner screens could not be opened, because logging in as owner in the browser was refused by the tool's safety check.

### 4.1 Helpers (plan 3)
1. **Owner: Staff → Add helper.**
   - Add with name, phone and Works until, then show the join QR and the "Show join code" text.
   - Re-adding the same phone gives the plain message. A manager is told to ask the owner.
2. **Join on a real phone**, through an HTTPS tunnel or production.
   - Scan the QR, set the PIN, land on Sell.
   - An expired or used link shows a plain message.
3. **Sell on a phone:**
   - scan with the phone camera (Android Chrome and iPhone Safari);
   - find by name;
   - price cards;
   - size picker and typed price;
   - Take payment with cash and UPI;
   - the duplicate / retry warning;
   - 375 px width, keyboard behaviour, and the iOS autofocus tap.
4. **Discount over the helper limit:** a counter staff, manager or owner enters a PIN on the helper's phone (OverridePad).
   - A wrong PIN locks out.
   - An approver from another shop is refused.
5. **My sales:** undo within 2 minutes, today's totals, and the day boundary at shop-local midnight.
6. **Access end:** set Works until to yesterday. The helper's phone shows the access-ended message on the next action and locks.
7. **Owner: Approval PIN screen and Helper discount limit setting** (Settings). Never checked on screen.
8. **Personal-device lock screen:** it shows only that helper; an owner or manager login frees it.

### 4.2 Cash bags (plan 4)
Before testing, the owner turns bag mode on in Settings. **Put it back to register mode afterwards.**

1. **Owner: Settings → Helpers cash mode.** Both options with their one-line explanations. Switching back is refused while a bag holds cash, and the refusal text shows inline. Never checked on screen.
2. **Counter dashboard card:** checked by agent on desktop web.
   - "Give change to a helper" when no bags exist.
   - Give float: pre-filled 500; with the register closed it goes to Open Register first.
3. **Helper sells cash with the register shut:** the Take payment sheet must not warn about the register in bag mode. This was fixed after the last on-screen check, so **re-check it**.
4. **Card masking:** `₹5,xxx · 3 sales`. Tap a name to show the exact amount for 15 s, then it hides again, including on leaving the screen and on lock.
5. **Receive cash, partial:**
   - type the count, tap Next;
   - Expected / Counted / Short shows;
   - tap No, part of it; the remainder stays in the bag.
6. **Receive cash, final with a shortage of ₹10:** tap Yes, settle; the bag goes to 0.
7. **Count over expected:** only Yes, settle is offered.
8. **Count again closes the sheet.** Reopening starts fresh, and the count can't be retyped after Next.
9. **Close register while cash is out:**
   - the warning appears;
   - Collect now opens Receive cash, then returns to the close;
   - Close anyway still runs the normal count, preview and top-up flow;
   - the close balances to ₹0.
10. **Blind count lock plus a handover:**
    - Preview the close with extra cash so the count locks.
    - Receive helper cash.
    - The locked number moves up by that cash. Counter staff can close with the new number but not the old one.
11. **Owner: Cash Register live view.** Expected in Drawer equals the server figure, with lines "− Change given to helpers" and "+ Cash from helpers". History cards no longer show floats as expenses. Never checked on screen.
12. **Owner: Reports → Staff sales.** A helper row shows floats, cash collected, handed over, short/over and times shown.
13. **Sale Details on a helper's bag sale:**
    - adding a customer name saves;
    - changing the payment method gives the helper-cash message.
14. **Helper's My sales:** the "Cash with you" line, masked, tap to see it for 15 s.
15. **Two counter staff press "Yes, settle" for the same helper at once:** one succeeds; the other gets "Already collected — refresh" and the card refreshes.

### 4.3 Earlier work, still unchecked by a person
- **Staff sales report** (owner): Reports → Staff sales and the per-person screen.
- **Labels and scanner:**
  - a real printer;
  - a phone camera scanning a printed sticker;
  - the product form's sizes editor;
  - Produce → Print tag;
  - the native app scanner.
- **Quick sale:** 375 px width; Print bill on a quick sale says "PICKUP SLIP" (known).
- **Draft fixes from `d11d015`:** never checked on screen.

### 4.4 Expo SDK 58 (on the user's phone)
- App launch, navigation and the PIN lock screen.
- Camera scanning, voice note record and play, photo upload, print and share, the customer ledger CSV export.
- Location / geofence attendance.
- Push notifications need a development build, not Expo Go.
- After merging, a new EAS / dev build is needed for anything not run in Expo Go.

---

## 5. Decisions waiting on the user
1. **Push and open the three PRs** (section 1).
2. **Helper discount approval:** with the defaults (helper limit = counter limit = 20%), a counter staff PIN can never approve an over-limit helper discount, so every override needs a manager or owner. Options: lower the helper limit, or keep it as is.
3. **Rupee discounts:** they are measured against the pre-tax subtotal. ₹100 off ₹500 at 18% tax counts as 23.6%. This is the same at the counter. Keep it or change it?
4. **Owner approval PIN:** it could be guessed slowly over days (fixed 5 tries per 5 minutes). Options: lockouts that get longer, or an alert to the owner.
5. **Report day boundary:** reports start the day at 05:30 IST (UTC midnight), but My sales uses true shop-local midnight (Ruling 11). Should reports move to shop-local midnight too?
6. **Open questions A/B/C** from `docs/superpowers/logs/2026-11-01-staff-ux-batch-handoff.md` §3 (that file is on the merged `fix/staff-ux-batch-nov` line, so check `origin/main`). **Do not act on them without the user.**
   - A: the receiver is charged on convert-to-credit.
   - B: the Customers list `order_count` doesn't match checkout.
   - C: dues left behind by the verify scripts.
7. **Test register sessions:** whether to clear them, including the "Mutation Runner" register 2988.
8. **Expo npm audit:** whether to look into the 17 vulnerabilities (1 critical).
9. **Owner and manager dashboards:** whether they should also get the "Cash with helpers" card. Today only counter staff and employee dashboards have it (Ruling 10), and owners collect through the close warning.

---

## 6. Known issues not fixed (so new bug reports can be told apart)

### Cash bags
- **Close is not one transaction.** The close computes, then updates (sync DB layer). A float, handover or sale that lands in between is attached to the register but missed in the stored expected cash and difference. Sales already had this race.
- **Lost responses can repeat a float or partial handover.** If the response to a float or partial handover is lost, a second tap books it again. The text says "Check the helper card before trying again" and refreshes the card (Ruling 15). A final handover is safe because a repeat gets 409.
- **Sale vs final handover race.** A helper sale saved at the same instant as a final handover shows up as an overage, and its cash stays in the bag (rare).
- **Mode switch vs helper sale race.** The mode switch is not serialised against a helper sale saved at the same moment (owner-only, tiny window).
- **Location scoping is open.** Staff can list, reveal, float and receive at any `location_id`. This matches the other register routes.
- **Report keys on current role.** A helper later changed to another role loses their past bag figures from the report.
- **Deleting a helper.** `held_by` is `ON DELETE SET NULL`, so hard-deleting a helper user would turn their held cash into drawer cash. Helpers are deactivated, not deleted, so this doesn't happen today.
- **Preview reveals expected.** A preview shows the expected amount to any staff caller. It is audited, and counted in "times shown" when not followed by a matching handover.
- **Close-time listing cost.** `listBags` makes several queries per helper ever linked to the shop. Fine at this size.
- **UPI with no register open.** A helper UPI sale with no open register is not counted in any register session. UPI-only sales already behave this way; bag mode makes it more common.

### Helpers (plan 3 parked)
- **Override lockout.** Failed overrides share the counter-login lockout, so a helper can keep a counter person locked out (accepted by design).
- **Approver codes.** They can be enumerated, and the lockout is a fixed 5 tries per 5 minutes (see decision 4).
- **Socket.io auth** checks only the JWT, not `is_active` or expiry. No impact today.
- **Expiry timing.** `access_until` is not re-checked inside the join transaction (a millisecond gap).
- **Join links** are not location-scoped.
- **Customer phone** is not stored on helper sales; it is kept only on the phone for the WhatsApp share (Ruling 10).
- **Same-helper check** on join compares names. The "no longer set up" line lasts until the next reload.
- **Show join code** always cancels the previous code (the text says so). The edit form has two save buttons. Update Staff is not double-tap guarded.
- **Helper product detail** ignores location (one shop today).
- **Production tasks.** A helper sale with no ready stock writes a completed production task (the existing walk-in path).

### Found during this work, pre-existing, not fixed
- **`PUT /api/sales/:id` (Edit Sale)** writes `sales.order_notes`, a column that **does not exist** (the real one is `customer_notes`). Any Edit Sale that sends `order_notes` fails with a database error.
- **Past-day cash refunds are subtracted twice at close.** They are written as a `refunds` row **and** as a cash `expenses` row with no `register_id`, so register close subtracts them twice while the running `expected_cash` subtracts them once. This happens in any mode. Ruling 7 adds one bag case: a past-day held sale refunded and then cancelled.
- **Pickup payment** in `deliveries.js` overwrites `expected_cash` without expenses (old behaviour; floats and handovers are now included).
- **Quick sale Print bill** prints "PICKUP SLIP".
- **Changing the method of a coworker's quick sale** fails with the Edit Sale ownership message.
- **Customer self-order endpoint.** `POST /api/sales/customer-order` is still broken (see CLAUDE.md).

### Expo SDK 58
- **Upload setting.** Uploads depend on the committed `.env.development` / `.env.production` (`EXPO_PUBLIC_USE_RN_FETCH=1`).
- **Exact version pin.** `expo` is pinned to `58.0.23` exactly. Expo usually uses `~`.
- **Deprecated calls kept.** `shouldShowAlert` in the notification setup and React Native `SafeAreaView` in ImageModal still work and were left alone.
- **npm audit:** 17 vulnerabilities, 1 critical.

---

## 7. Improvements and tap cuts from the 2026-11-02 discussion

On 2026-11-02 the user raised four problems:
1. **Rush hour:** customers pay and leave before a sale can be recorded.
2. **Temporary staff:** festival helpers don't know prices.
3. **Add Item:** the new item appears at the bottom of Quick Checkout.
4. **Too many taps** everywhere, plus a request for a full audit of anything inconvenient.

The answers for (1) and (2) became the specs and the four built parts. The audit and the general tap-cutting rules were **mostly never built**. Status below was checked against the code on 2026-11-04. "Open" means not done.

### 7.1 What came out of it and was built
| Idea | Status |
|---|---|
| Add Item shows the new blank item at the top, focused (`d11d015`) | Done, in main. **Not checked on screen** |
| Drafts keep their old dues; the draft message points to the chip (`d11d015`) | Done, in main. **Not checked on screen** |
| Quick sale "sales roll": 1 tap per item button, Other amount = type + Enter, Undo instead of a confirm, stays on one screen | Done (PR #22) |
| Register close safety net: extra cash → "Book ₹X as sales"; a shortage is never booked; stricter blind count lock | Done (PR #22) |
| Who sold it (`sold_by`), "Sold by" picker, owner-only Staff sales report | Done (PR #23) |
| Label QR as a short web link; public price page; web scanner; scan to add; sizes and typed prices; one-off tags; label sheets; scan lookup no longer returns cost | Done (PR #24) |
| Helper role, join QR on their own phone, scans + 3 taps per sale, server sets prices, PIN override for big discounts | Done (`feature/helpers-join-sell`, not pushed) |
| Cash bags behind an owner switch, masked amounts revealed on tap and logged, blind handover, shortages recorded | Done (`feature/helper-cash-bags`, not pushed) |

### 7.2 Built differently from the design (check with the user)
- **Expiry with cash still held.** The design said "a helper's account can't expire while they still hold cash". What was built: access ends on schedule, and the expired helper's bag stays listed and collectable at the counter.
- **Weight or length items** (garland per metre) are "type the price" items. True decimal quantities need a column type change on live data, which needs its own migration plan.
- **Commission:** only totals and counts are shown, as asked. Commission comes later.
- **Approval from the counter by remote:** not built. The PIN is typed on the helper's phone.
- **Not built yet:** an optional festival price list switch, an optional USB scanner at the counter (it types like a keyboard, so it may just work in any text box), and a stock-mismatch flag when an item shows out of stock but is in hand (check spec §6).

### 7.3 Usability audit: still open
High impact first. File references are from 2026-11-04.

| # | Problem | Where | Status |
|---|---|---|---|
| 1 | After every sale, **Done goes to the old "Point of Sale" screen** (`POSHome`), not Quick Checkout. Costs an extra tap and looks like a different screen | `SaleDetailScreen.js:136`, `QuickCheckoutScreen.js:1571` | Open |
| 2 | **Buttons that silently do nothing on web**, because `Alert.alert` is used instead of `showAlert`/`showConfirm`. Calls still left: AttendanceScreen 11, CustomerDetailScreen 15, QuickCheckoutScreen 10, ProductionQueueScreen 9, ExpensesScreen 6, ProduceScreen 5, CashRegisterScreen 4, AddPaymentScreen 4, LogOrderScreen 3, plus ProfileScreen, RecurringOrders, SaleDrafts, CategoryDetail, SalaryAdvances, StaffAttendance, POSScreen, SupplierDetail, MaterialDetail, ProductDetail, StockTransfers, PurchaseOrderDetail, ShiftManagement | `grep -rn "Alert.alert" app/src/screens` | Open. **Highest value fix** |
| 3 | Walk-in sales label **Phone \*** and **Name \*** as required, but they aren't, so staff type them anyway | `QuickCheckoutScreen.js:1875, 1899` | Open |
| 4 | Full order layout: items sit below customer, notes and a large pink "Record voice note" button that looks like the main action. Confirm is at the very bottom with no pinned total or button, so every sale means scrolling | Quick Checkout, Full order mode | Open. Quick sale avoids this for plain walk-ins |
| 5 | The florist queue asks "Are you sure?" before every Pick, Start and Complete: 3 extra taps per task. These dialogs also use `Alert.alert` with buttons, so they may not work on web at all | `ProductionQueueScreen.js:612, 639, 666` | Open |
| 6 | Jargon: "Auto-Complete Out-of-Stock Items (Skip Assignment)", "COD", "Partial", "Split Payment", CASH/CARD/UPI in capitals | `QuickCheckoutScreen.js:2681` and others | Open |
| 7 | Each custom item shows tax %, tax amount and materials, which counter sales almost never need. Move them under "More" | Quick Checkout item block | Open (check) |
| 8 | The "Done" button after a sale is small (13 px text, little padding) | `SaleDetailScreen.js:141` | Open |
| 9 | The opening-cash box is empty when the register wasn't closed today. Pre-fill it from the last close on any day | Cash Register / open-register form | Open (check) |
| 10 | The "✓ Registered customer" line has a pink/red background, so it reads like a warning | Quick Checkout | Check |
| 11 | Log Order doesn't show the customer / order-count line that Quick Checkout shows | `LogOrderScreen.js` | Check |
| 12 | Raw server error text reaches staff in about 15 screens. Errors should say what to do next | Many screens | Open |

### 7.4 Tap cuts proposed vs where they stand
| Task | Before | Proposed | Now |
|---|---|---|---|
| Walk-in sale, catalog item | 6+ taps and scrolling | 1–2 | **1 tap** with a Quick sale button |
| Walk-in sale, any amount | ~7 | 2 | **type + Enter** in Quick sale (no item name) |
| Walk-in sale, typed item name in Full order | ~7 plus scrolling, then 2 screens | 2: open with a blank item ready, Confirm pinned, stay on Quick Checkout with a "Saved · Print" banner instead of going to Sale Details | **Open** (audit items 1, 3, 4, 8) |
| Rush sale | 7+ | 1 | **Done** (Quick sale) |
| Helper sale | n/a | scans + 2–3 | **Done** (scans + 3) |
| Receive helper cash / give float | n/a | 3 + amount / 2 + amount | **Done** |
| Florist task | 6 | 3: replace the confirms with a few seconds of "Undo" | **Open** (audit item 5) |

**General rules agreed for every staff screen** (apply them when fixing the above):
- "Undo" instead of "Are you sure?";
- keep the main button pinned on screen;
- remember the last choice (channel, payment method, location, mode);
- after finishing, return staff to where they started;
- big targets;
- plain words;
- errors that say what to do next.

**Suggested order** (the 2026-11-02 recommendation, still valid):
1. Done → Quick Checkout, plus a bigger Done button (items 1, 8).
2. Replace the remaining `Alert.alert` calls in staff screens, starting with Cash Register, Add Payment, Expenses, Production Queue, Attendance and Customer Detail (item 2).
3. Walk-in Phone/Name labels not marked required (item 3).
4. Full order tap cuts: pinned total and Confirm, items first, the voice note button made secondary, stay on Quick Checkout after saving (item 4).
5. Florist queue Undo instead of confirms (item 5).
6. Jargon, raw errors, opening-cash pre-fill, the badge colour, the Log Order customer line (items 6–12).

Each item touches a staff screen, so run `staff-ux-checklist` (count the taps) and `app-ui-quality` first. Item 4 is big enough to want a short design in chat before building.

## 8. Next steps, in order
1. **Hear the user's helper-flow bugs.** Reproduce each one against the local server, using the `superpowers:systematic-debugging` skill, and fix it on `feature/helper-cash-bags`, or on `feature/helpers-join-sell` if the bug is helper-only and you want it in that PR.
   - Run the relevant suites after each fix.
   - If you fix on `feature/helpers-join-sell`, merge it into `feature/helper-cash-bags` afterwards.
2. **Ask about pushing and the PRs** (section 1).
3. **Walk the on-screen list** (section 4) with the user. Owner screens need the user's own login.
4. **Expo branch:** once the user confirms the app runs on the phone, open its PR. Then bring SDK 58 into the helper branches (section 1 note).
5. **Deploy order:**
   - Deploy the server before the app.
   - `PUBLIC_APP_URL` must be set.
   - The Nginx SPA fallback is needed for `/join/`, `/p/`, `/slip/`, `/order-request/` and `/track/`.
   - Set `access_log off` for `/join/` and `/api/auth/join/` (`VPS_DEPLOYMENT_GUIDE.md` §17).
   - Keep `helper_cash_mode` on `register` until every counter device has the new app.
6. **Answer section 5's decisions** as the user gives them.
7. **Usability and tap cuts** in section 7.3–7.4, in the suggested order. Ask the user which first.
8. **Roadmap after this** (CLAUDE.md): attendance and shifts (6), customer CRM (7), catalog / cost-margin (8), UI pass (9), technical debt (10).

---

## 9. Rules the user has set (keep following them)
- **Schema:** additive only, through `server/config/database.js`. Read the `db-migration-safety` skill first.
- **SQL comments:** never put an apostrophe in a `--` SQL comment (`database-async.js` `bindParams` footgun).
- **Dialogs:** use `showAlert` / `showConfirm`. `Alert.alert` with buttons does nothing on web.
- **Staff screens:** read `staff-ux-checklist` and `app-ui-quality` first, and count taps.
- **Cash:** the user wants the **stricter** approach for cash (blind count lock, never cleared).
- **Test data:**
  - Throwaway PINs and tokens stay in the scratchpad, never in chat.
  - Don't reset real users' PINs.
  - Remove all test data after checks.
  - Never touch a register a test did not open.
- **Owner browser login:** don't log in as owner in the browser. Reading or materialising the owner JWT for that was refused by the tool's safety check, so owner screens need the user. API calls from a script using `VERIFY_OWNER_*` are fine.
- **Servers and tunnels:** don't start local http servers or tunnels yourself (also refused). The user starts Expo.
- **Git:**
  - Ask before push, PR, merge, or changing repo settings.
  - Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - PR bodies end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- **Old project copy:** never work in `~/Downloads/Projects/test Project`, which is an old copy.
- **Writing for the user:** plain language, short, no jargon. Staff-facing copy is for people who have never used business software.

---

## 10. Prompt for the new session

Copy everything inside the block into the new session:

```
We're continuing work on Petal, the flower shop operations app in "/Users/gauravbhatia/Downloads/Projects 2/test Project". The last session ran out of context.

Before doing anything, read these two files in full:
1. docs/superpowers/logs/2026-11-04-helpers-cash-bags-expo-handoff.md — the handoff: branch state, what was built (helpers, helper cash bags, Expo SDK 58 upgrade), how to run the server and tests, the on-screen tests still to do, known issues not yet fixed, decisions waiting on me, and my rules.
2. CLAUDE.md — the project rules and roadmap (it loads automatically, but re-read the "helpers: join and sell" and "helper cash bags" entries).

Current state: feature/helper-cash-bags (head 7bef600) sits on feature/helpers-join-sell (fb19efa). Neither is pushed. chore/expo-sdk-58 is in worktree .claude/worktrees/agent-ae7957380276e6ba1 and is not pushed either. PRs #22-24 are merged to main.

What I want first: there are bugs in the helper flow that I'll describe next. For each one, reproduce it against the local server, find the root cause (systematic debugging), fix it on the right branch, add a regression check to the verify suite, and run the related suites. Before calling something a new bug, check the handoff's section 6 to see whether it's already a known issue, and section 7 for the usability and tap-cutting work we agreed on but haven't built yet.

Don't push, open PRs or merge without asking me. Keep helper_cash_mode on 'register' after any test, and clean up all test data.

After the helper bugs, the next job is the usability audit and tap cuts in section 7.3-7.4 (Done going to the old POS screen, buttons silent on web, Full order needing scrolling, florist confirms, and so on). Ask me which to start with.

Confirm you've read the handoff by giving me a 5-line summary of where things stand, then wait for my bug list.
```
