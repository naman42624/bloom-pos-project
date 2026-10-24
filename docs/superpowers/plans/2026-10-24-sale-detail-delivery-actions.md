# Delivery Actions on Sale Details — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One shared `DeliveryActionsPanel` that gives Sale Details every delivery action Delivery Details has. Its buttons follow the server's real permissions, and it fixes the three dialogs that do nothing on web.

**Architecture:**
- A pure rules module decides which actions a viewer gets for a delivery.
- A React panel renders them and owns all the forms, modals and API calls (moved out of `DeliveryDetailScreen.js`).
- Both screens render the panel.
- The server change is one additive read: `GET /deliveries/:id` also returns the two counter-staff permission flags.

**Tech Stack:** Expo / React Native (+ web), React Navigation, Express + `pg`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-24-sale-detail-delivery-actions-design.md` (approved 2026-10-24). Read it first. This plan only adds the decisions below.

**Decisions made after the spec, while verifying the server (2026-10-24):**
1. **Counter staff's Pick Up and Mark Delivered aren't role-only.** The routes (`server/routes/deliveries.js` `/pickup` ~L701, `/deliver` ~L773) also require the settings `pref_counter_marks_pickup` / `pref_counter_marks_delivered` to be `'1'`. Staff can't read `GET /settings`, so `GET /deliveries/:id` will attach `counter_can_mark_picked_up` and `counter_can_mark_delivered` (booleans, from the existing `getStageFlags(db)` in `server/utils/order-stage.js`). Task 1.
2. **"View Live Location" only shows where the host navigator has a `LiveDeliveryMap` route.** `FloristStack`, `CustomersStack` and `DeliveryPartnerStack` don't have one. The panel checks `navigation.getState()?.routeNames?.includes('LiveDeliveryMap')`.
3. **Server status rules:**
   - `deliver` and `fail` accept `picked_up` and `in_transit`.
   - `pickup` needs `assigned`.
   - `start` (in-transit) needs `picked_up`.
   - `reattempt` needs `failed`.
   - `assign`: the UI offers it on `pending` only (same as today).
   - `cancel`: the UI offers it on `failed` only (spec §6).

## Global Constraints

- **Additive-only server change.** No schema change, no change to any `authorize()` or permission check. (CLAUDE.md constraint 1; `db-migration-safety` doesn't apply, since there's no schema.)
- **Web-safe dialogs only** in code you write or move: `showAlert` / `showConfirm` from `app/src/utils/alert.js`. Never `Alert.alert` with buttons, and never `window.alert`/`window.confirm` directly.
- **Every submitting tap** goes through `useSubmitGuard()` (`app/src/hooks/useSubmitGuard.js`, default export; usage `onPress={guard(handler)}`).
- **Server error messages are already plain language.** Show `err.message` as-is.
- **Staff-facing copy** follows CLAUDE.md UX principles: plain words, say what to do next.
- **No action that a role can do today may disappear** from either screen (staff-ux #9).
- Follow the surrounding code's style: comment density, inline `StyleSheet` objects, `Colors` from `constants/theme`.
- Use the `app-ui-quality` and `staff-ux-checklist` skills (`.claude/skills/`) for any UI you write.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Counter staff on Sale Details for an `in_transit` delivery with COD outstanding** must still be able to mark it delivered. The old one-tap is hidden when the panel shows, so the panel's `deliver` must appear for them. (Task 2 rules test plus the Task 5 trace.)
2. **A rider opening someone else's delivery** gets no lifecycle buttons, only Print. (Task 2.)
3. **On web, Reattempt, both Cancel choices and Convert to Pickup actually run their API call.** They must not depend on `Alert.alert` buttons. (Tasks 3 and 5.)
4. **The panel failing to load** (network, or a deleted delivery) must not blank Sale Details. It shows its own retry row. (Task 3.)
5. **After any panel action, Sale Details' own data refreshes** (stage badge, payment status, "Collect" buttons) without navigating. `onChanged` → `fetchSale`. (Tasks 4 and 5.)

---

### Task 1: Expose the counter-staff flags on `GET /deliveries/:id`

**Files:**
- Modify: `server/routes/deliveries.js`, the `router.get('/:id(\\d+)', …)` handler (~L494–548)
- Test: `server/scripts/verify-order-flows.js` (append one check, same harness style as its existing checks)
- Modify: the spec's §4.2 table. Add a line under it saying counter staff's `pickup`/`deliver` also require the matching flag.

**Interfaces:**
- Produces: the `GET /api/deliveries/:id` response `data` gains `counter_can_mark_picked_up: boolean` and `counter_can_mark_delivered: boolean`.

- [ ] **Step 1: Write the failing check** `'GET /deliveries/:id exposes counter-staff permission flags'`. Find any delivery id (`SELECT id FROM deliveries ORDER BY id DESC LIMIT 1`), read both settings rows, GET the delivery as owner, and assert:
  - `typeof data.counter_can_mark_picked_up === 'boolean'`
  - `data.counter_can_mark_picked_up === (pref_counter_marks_pickup === '1')`
  - the same two assertions for the delivered flag.
- [ ] **Step 2: Run it and see it fail.** Start the server (`cd server && node server.js`) and run `VERIFY_OWNER_PHONE=9876453210 VERIFY_OWNER_PASSWORD=naman1234 node scripts/verify-order-flows.js`. Expect the new check ❌. Export the same `TRACKING_LINK_SECRET` to both the server and the script, or the known tracking check flakes (CLAUDE.md).
- [ ] **Step 3: Implement.** In the handler, `const flags = await getStageFlags(db);` (already imported at the top of the file), then set:
  - `delivery.counter_can_mark_picked_up = flags.counterCanMarkPickedUp.length > 0`
  - `delivery.counter_can_mark_delivered = flags.counterCanMarkDelivered.length > 0`

  Do this before `res.json`.
- [ ] **Step 4: Run it and see it pass.** Expect the full suite green: 59/59, or the previous count + 1.
- [ ] **Step 5: Commit** with the message `feat: expose counter-staff pickup/deliver flags on GET /deliveries/:id`.

---

### Task 2: Pure rules module `getDeliveryActions`

**Files:**
- Create: `app/src/components/delivery/deliveryActionRules.js`. Plain ES module with **no React / react-native imports**, so Node can `require` it.
- Test: `app/scripts/verify-delivery-action-rules.js` (pattern: `app/scripts/verify-contact-utils.js`, plain `assert`)

**Interfaces:**
- Produces:
  - `getDeliveryActions({ delivery, role, userId }) → string[]`: action keys in display order (subset of `ACTION_ORDER`).
  - `ACTION_ORDER = ['assign','pickup','start','deliver','reattempt','fail','cancel','verify_load','live_location','convert_payment','print']`.
  - `PRIMARY_ACTIONS = new Set(['assign','pickup','start','deliver','reattempt'])`.
  - `isFinalDelivery(status) → boolean`: true for `delivered`, `failed`, `cancelled`.
- `delivery` fields read: `status`, `delivery_partner_id`, `counter_can_mark_picked_up`, `counter_can_mark_delivered`. Compare ids with `Number()`.

**Rules** (copy exactly; they mirror the server as verified 2026-10-24):

| key | status | allowed |
|---|---|---|
| assign | `pending` | owner, manager, counter_staff |
| pickup | `assigned` | owner, manager; counter_staff if `counter_can_mark_picked_up`; delivery_partner if own |
| start | `picked_up` | owner, manager; delivery_partner if own |
| deliver | `picked_up` or `in_transit` | owner, manager; counter_staff if `counter_can_mark_delivered`; delivery_partner if own |
| fail | `picked_up` or `in_transit` | owner, manager; delivery_partner if own |
| reattempt | `failed` | owner, manager, counter_staff |
| cancel | `failed` | owner, manager, counter_staff |
| verify_load | not final | owner, manager, employee, counter_staff; delivery_partner if own |
| live_location | `in_transit` and `delivery_partner_id` set | every role except customer (the panel also checks the route exists) |
| convert_payment | not final | owner, manager |
| print | any | every role except customer |

`customer`, or a missing `delivery`, gets `[]`.

- [ ] **Step 1: Write the failing test script.** A helper `d(status, extra)` builds a delivery with `delivery_partner_id: 8`, both flags `true`, plus overrides. Assertions use `assert.deepStrictEqual` on the full array:
  - counter_staff, `in_transit`: `['deliver','verify_load','live_location','print']`
  - counter_staff, `in_transit`, `counter_can_mark_delivered:false`: `['verify_load','live_location','print']`
  - counter_staff, `assigned`, `counter_can_mark_picked_up:false`: `['verify_load','print']`
  - owner, `pending`: `['assign','verify_load','convert_payment','print']`
  - owner, `in_transit`: `['deliver','fail','verify_load','live_location','convert_payment','print']`
  - delivery_partner userId 8 (own), `picked_up`: `['start','deliver','fail','verify_load','print']`
  - delivery_partner userId 9 (not own), `picked_up`: `['print']`
  - delivery_partner userId `'8'` (string) on own: same as the own case (Number compare)
  - employee, `in_transit`: `['verify_load','live_location','print']`
  - florist_staff, `in_transit`: `['live_location','print']`
  - counter_staff, `failed`: `['reattempt','cancel','print']`
  - manager, `delivered`: `['print']`
  - customer, any status: `[]`; `delivery: null`: `[]`
  - `isFinalDelivery('failed') === true`, `isFinalDelivery('in_transit') === false`
  - every key returned in every case is in `ACTION_ORDER`, and the order is preserved
- [ ] **Step 2: Run it and see it fail.** `cd app && node scripts/verify-delivery-action-rules.js`. Expect: cannot find module.
- [ ] **Step 3: Implement** the three exports in `deliveryActionRules.js`, with the table above as a comment header.
- [ ] **Step 4: Run it and see it pass:** `node scripts/verify-delivery-action-rules.js` prints its OK line and exits 0. Also run `node scripts/babel-check.js src/components/delivery/deliveryActionRules.js` → `OK`.
- [ ] **Step 5: Commit** with the message `feat: delivery action rules mirroring server permissions`.

---

### Task 3: `DeliveryActionsPanel` + move Delivery Details onto it (+ Convert to Pickup fix)

**Files:**
- Create: `app/src/components/delivery/DeliveryActionsPanel.js`
- Modify: `app/src/screens/DeliveryDetailScreen.js`

**Interfaces:**
- Consumes: Task 2 (`getDeliveryActions`, `PRIMARY_ACTIONS`, `isFinalDelivery`); Task 1 flags (arrive on the `api.getDelivery` response); `printOrderSlip(saleId)` from `app/src/utils/printHelpers.js`; `AssignPickerModal` (`components/orderBoard/AssignPickerModal.js`, props `visible, title, notice, people, loading, onPick, onClose, footer`; `people` items are `{ id, name, meta }`); `DeliveryChecklist` (`components/DeliveryChecklist.js`, prop `deliveryId`); `useSubmitGuard`; `showAlert`/`showConfirm`; `useAuth()` for `user.role` and `user.id`.
- Produces: `export default forwardRef(DeliveryActionsPanel)` with props `{ deliveryId: number, navigation, onChanged?: () => void, compact?: boolean }`. The ref exposes `{ refresh(): Promise<void> }`.

**What moves into the panel from `DeliveryDetailScreen.js`** (read the screen first; today's line refs are approximate):
- **State:** `actionLoading`, `codAmount`, `codMethod`, `codRef`, `failReason`, `showCodForm`, `showFailForm`, `proofPhoto`, `assignModalVisible`, `partners`, `assignLoading`, `checklistVisible`.
- **Handlers:** `takeProofPhoto`, `pickProofPhoto`, `doAction`, `openAssignModal`, `handleAssign`, `handleViewLivePartner`, `handleConvertPayment`, `handleDeliver`, `handleFail`.
- **JSX:**
  - the "Verify Load" button (from the Items header);
  - the whole "Actions" section (~L539–686) and "Failed Delivery Actions" section (~L689–741);
  - the Assign modal (~L745–779), replaced by `AssignPickerModal`;
  - the checklist modal (~L780–800).
- Their styles.

**Panel behaviour:**
- **Loads** `api.getDelivery(deliveryId)` on mount and on `refresh()`. After every successful action: `await refresh()`, then `onChanged?.()`.
- **Failed action:** `showAlert('Could not update delivery', err.message || 'Please try again.')`, then `await refresh()`. If the delivery moved on in the meantime, the buttons correct themselves (spec §5).
- **Load failure:** one inline row, "Couldn't load delivery actions — tap to retry". It renders nothing else and never throws.
- **Actions** = `getDeliveryActions({ delivery, role: user.role, userId: user.id })`. Drop `live_location` if `!navigation?.getState?.()?.routeNames?.includes('LiveDeliveryMap')`.
- **Layout:**
  - The **first key in `PRIMARY_ACTIONS`** renders as a full-width coloured button. Keep today's colours: assign `#2196F3`, pickup `#9C27B0`, start `#00BCD4`, deliver `#4CAF50`, reattempt `#2196F3`.
  - Any further primary keys (e.g. a rider on `picked_up` gets both start and deliver) render as full-width buttons below it, in order.
  - Remaining keys render as smaller outlined buttons in a wrapping row. Labels: Print Challan / Verify Load / View Live Location / Mark Failed / Cancel Delivery / Convert to COD or Convert to Credit (credit sale → "Convert to COD").
  - Minimum tap height 44.
- **The `deliver` form** is today's form, plus: on open, `codAmount` is pre-filled with `max(cod_amount − cod_collected, 0).toFixed(0)` when > 0.
- **`fail`:** today's reason form.
- **`reattempt`:** `showConfirm('Send it out again?', 'The order goes back to "assigned" so a rider can take it again.', run, { confirmLabel: 'Send again' })`.
- **`cancel`:** tapping shows an inline box with three buttons: **"Cancel delivery only"** → `api.cancelDelivery(id, { reason: 'Cancelled after failed delivery' })`; **"Cancel delivery and order"** (red) → that call, then `api.cancelSale(delivery.sale_id)`; **"Back"**. Same calls as today.
- **`assign`:** `api.getDeliveryPartners(delivery.location_id)` → `AssignPickerModal`, with `people = partners.map(p => ({ id: p.id, name: p.name, meta: `${p.active_delivery_count || 0} stop(s) today` }))`. Empty list notice: "No riders at this location. Ask the owner to add one."
- **`convert_payment`:** today's handler, with its two `Platform` branches replaced by one `showConfirm`.
- **`print`:** `printOrderSlip(delivery.sale_id)`.
- **`compact`:** when true, omit the panel's own "Delivery actions" heading.

**Delivery Details after the move:**
- Keep everything else on the screen.
- Render `<DeliveryActionsPanel deliveryId={deliveryId} navigation={navigation} onChanged={fetchDelivery} />` where the Actions section was. Render it for final statuses too: Print is still offered, matching today's Print.
- In the owner/manager header row, **remove** the "Delivery Challan" button (the panel's Print replaces it). Keep "Sale Details" and "Convert to Pickup".
- **Fix `handleConvertToPickup`:** `showConfirm('Convert to Pickup', 'Convert this delivery order to a pickup order? The delivery will be cancelled.', doConvert, { confirmLabel: 'Convert' })`, with `showAlert` for the Done and Error messages. Same API call.
- Delete the now-unused state, handlers, imports (`ImagePicker`, `FlatList` if unused) and styles.

- [ ] **Step 1:** Re-read `DeliveryDetailScreen.js` fully and list every symbol that moves. Confirm with grep that nothing left in the screen references a moved symbol afterwards.
- [ ] **Step 2:** Create the panel as specified. Keep the moved handlers' API calls and payloads byte-identical, except for the fixes listed above.
- [ ] **Step 3:** Switch `DeliveryDetailScreen.js` to the panel, remove the moved code, and fix Convert to Pickup.
- [ ] **Step 4: Verify.**
  - `cd app && node scripts/babel-check.js src/components/delivery/DeliveryActionsPanel.js src/screens/DeliveryDetailScreen.js` → both `OK`.
  - `grep -n "Alert.alert" src/components/delivery/DeliveryActionsPanel.js` → nothing.
  - In `DeliveryDetailScreen.js`, no remaining `Alert.alert(` call with a buttons array (single-message ones may stay).
  - `node scripts/verify-delivery-action-rules.js` still passes.
- [ ] **Step 5: Commit** with the message `feat: shared DeliveryActionsPanel on Delivery Details; fix web-dead Reattempt/Cancel/Convert to Pickup`.

---

### Task 4: Sale Details renders the panel

**Files:**
- Modify: `app/src/screens/SaleDetailScreen.js`

**Interfaces:**
- Consumes: Task 3's `DeliveryActionsPanel` (props and ref). `fetchSale` already exists (~L305).

**Changes** (spec §4.5; line refs approximate, read the file first):
1. **"Delivery Status" card (~L1182):**
   - It's no longer one big tap target. Keep the title "Delivery", status badge, rider and COD lines.
   - Add a small text link, **"View full delivery →"**, that does today's `navigate('DeliveryDetail', { deliveryId })`.
   - Below that, render `<DeliveryActionsPanel ref={deliveryPanelRef} deliveryId={sale.delivery.id} navigation={navigation} onChanged={fetchSale} compact />`. `deliveryPanelRef = useRef(null)`.
2. **Blocked-order block (~L1680–1730):**
   - Remove the `canManageDeliveries` branches that render the navigating "Delivery Failed — Send Again" and "Assign Rider" buttons. For those roles, render nothing: the panel above now offers the action.
   - **Keep** the plain-sentence notes for roles that can't act.
   - Change the rider note to `{partner} has this order. It finishes on its own once the delivery is marked delivered.`
3. **One-tap Mark Delivered (~L1748):** render it only if `hasNoInputNextAction && !sale.delivery`. Confirm Pickup (no delivery row) is unaffected.
4. **Cancel-order guard (~L470):** message `'A rider is already out with this order. Mark the delivery as failed first (in the Delivery section above), then cancel the order.'`, as a plain `showAlert`. No navigation.
5. **Pull-to-refresh / focus refetch:** wherever the screen refetches the sale, also call `deliveryPanelRef.current?.refresh()`.
6. Remove `canManageDeliveries` if it becomes unused.

- [ ] **Step 1:** Re-read the four regions above in the current file and confirm the line refs.
- [ ] **Step 2:** Apply the changes.
- [ ] **Step 3: Verify.** `node scripts/babel-check.js src/screens/SaleDetailScreen.js` → `OK`. `grep -n "navigate('DeliveryDetail'" src/screens/SaleDetailScreen.js` → only the "View full delivery" link remains.
- [ ] **Step 4: Commit** with the message `feat: delivery actions + challan on Sale Details via the shared panel`.

---

### Task 5: End-to-end verification (controller runs this; not delegated)

No new code unless a bug is found. If one is found, go back to the owning task's files and commit a fix.

- [ ] **Step 1: Regression.**
  - `verify-order-flows.js`, `verify-register-expenses.js`, `verify-order-requests.js`: all green, with the same `TRACKING_LINK_SECRET` exported to server and script.
  - `node app/scripts/verify-delivery-action-rules.js`.
- [ ] **Step 2: API-level lifecycle trace** at Test Loc (location 4), with throwaway orders cleaned up after. Use JWTs minted for counter_staff id 148, delivery_partner id 8 and the owner (memory: project-location-and-machine-setup).
  - **A:** a delivery order with a part payment → assign → pickup (as counter_staff) → in-transit (as owner) → deliver as counter_staff with `cod_collected` = remaining. Check the payment row, `payment_status = 'paid'`, register `expected_cash` delta, and that the sale `display_stage` moved on.
  - **B:** fail → reattempt → fail → cancel (delivery only), then on a second order cancel delivery + order.
  - **C:** confirm a rider gets 403 on someone else's delivery for `pickup`. This proves the rules' "own" check matches the server.
- [ ] **Step 3: On-screen check.** Run the Expo web build (`cd app && npx expo start --web`, API at localhost:3001). For one delivery each in `pending`, `in_transit` and `failed`, open Sale Details and Delivery Details as owner, counter_staff and employee. Confirm the button sets match the Task 2 table, and that Reattempt, both Cancel choices and Convert to Pickup actually run on web. If browser automation isn't available, say so plainly and hand this step to the user with exact steps.
- [ ] **Step 4:** Update the session log (`docs/superpowers/logs/2026-10-24-oct-bug-batch-session-log.md`) and the CLAUDE.md roadmap note. Commit.
