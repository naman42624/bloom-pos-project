# Quick sale ("sales roll") — design

Date: 2026-11-02 · Status: draft for owner review · Sub-project: 1 (order side) continuation

## 1. Problem

When the shop is crowded, customers hand over money, take change and leave. Recording each sale in Quick Checkout means: type a name (or tap a suggestion chip), type a price, pick a payment method, scroll to Confirm, land on Sale Details, tap Done, land on the old Point of Sale screen, tap back into Quick Checkout. About 7 taps, scrolling and three screens per sale. By the time one is recorded, two or three more customers have paid. Sales go unrecorded and the drawer stops matching the register.

A shorter form would still have the same three costs: tapping into fields, scrolling to Confirm, and leaving the screen. This design removes all three.

## 2. What the owner decided (2026-11-02)

- A tile records the sale on **one tap** (no second confirm). Mistakes are fixed with Undo.
- Every entry is a **real sale the moment it is recorded**, never a note to convert later — if nobody ever reviews the entries, money, register and reports are still right.
- Simple and self-explaining for first-time users, with short on-screen instructions.

## 3. Success criteria

| Action | Today | Target |
|---|---|---|
| Sell a common item (a tile) | ~7 taps, scroll, 3 screens | **1 tap**, no scroll, same screen |
| Sell any other amount | same | **type amount + Enter (or one "Add" tap)** |
| Fix a mistaken entry | cancel + refund flow | **1 tap (Undo)** |
| Fix a wrong payment method | Edit Sale | **2 taps** (line → "Change to UPI") |
| Print a bill for an entry | — | **2 taps** (line → Print) |

No field on the quick screen is required except the amount. The screen never scrolls on a phone in portrait; only the roll list below the pad scrolls.

## 4. Where it lives

Quick Checkout gets a two-way switch at the very top: **Quick sale | Full order**.

- The choice is remembered on the device (local storage; per-viewer convenience, falls back to Full order if storage is unavailable).
- **Full order** is today's Quick Checkout, unchanged — pickup, delivery, pre-order, customer details, credit, split, drafts. Nothing is removed.
- Roles: owner, manager, employee, counter_staff (the same roles that see the POS tab today). Tile editing (Settings) is owner-only.
- Helpers (see the scan-and-sell spec) do not get this screen; their screen has its own tap-to-add price cards.

## 5. The screen

```
┌──────────────────────────────────────────────┐
│  [ Quick sale ● | Full order ]     ⓘ How this works │
│                                              │
│  [   CASH   ]  [   UPI   ]   ← big, colour-coded,   │
│                               last used stays on    │
│  ┌──────────┬──────────┬──────────┐          │
│  │Rose bunch│ Bouquet  │Loose rose│  ← tiles │
│  │  ₹200    │  ₹500    │   ₹30    │  (≤12)   │
│  ├──────────┼──────────┼──────────┤          │
│  │   ...    │   ...    │   ...    │          │
│  └──────────┴──────────┴──────────┘          │
│  Other amount:  ₹ [ 350     ] [ + Add ₹350 ]  │
│  (Bouquet) (Bunch) (Loose flowers) (Box) …   ← optional label │
│ ─── This session ──────────────────────────── │
│  Cash ₹8,450 · UPI ₹3,200 · 31 sales         │
│  ✓ ₹500  Bouquet      Cash  2:41   [Undo]    │
│  ✓ ₹350  —            UPI   2:40   [Undo]    │
│  ⟳ ₹200  Rose bunch   Cash  saving…          │
│  ✕ ₹30   Loose rose   Cash  Not saved — tap to try again │
└──────────────────────────────────────────────┘
```

### 5.1 Payment method

- Two large buttons, **Cash** (green) and **UPI** (blue). The selected one fills with its colour and the whole pad area takes a light tint of it, so the current method is obvious from across the counter.
- The last used method stays selected (remembered on the device). Rationale: in a rush, consecutive customers tend to pay the same way; switching is one tap.
- Each roll line shows its method in the same colour, so a mis-tagged entry is easy to spot and fix (§5.5).
- Card and split payments are not on this screen — use Full order. (Split = record two entries, one cash, one UPI.)

### 5.2 Tiles

- Up to 12 tiles in a 3- or 4-column grid, each at least 64 px tall, label + price in large text.
- **Source:** the owner sets them in Settings → "Quick sale buttons" (add, remove, reorder; each tile is either *a product* or *a label + price*). If the owner has set none, the screen shows the 12 products sold most often at this location in the last 30 days, with a small "Suggested — the owner can change these in Settings" note.
- **A product tile** sells that product at its **current** catalog price (the tile stores the product, not a price), so price changes and festival prices are picked up automatically, and stock is reduced as for any sale.
- **A label tile** ("Rose bunch ₹200") sells a one-line custom item at the tile's price.
- A product that is switched off (`is_active = 0`) disappears from the tiles.
- **One tap records the sale** with the selected method. The tile flashes and the new line appears at the top of the roll immediately.
- **Accidental double tap:** a second tap on the *same* tile within 700 ms is ignored (shown as a brief shake). Two different tiles tapped quickly are two sales — that is the point of the screen.

### 5.3 Other amount

- One amount box with the number keypad, focused when the screen opens (on web, typing digits anywhere on the screen goes into it).
- **Enter** or the **+ Add ₹350** button records it. The button shows the amount so the person sees what they are about to record.
- Optional label chips (the same suggestions Quick Checkout already uses: Fresh Flowers, Bouquet, Bunch, Box, Basket, Vase, Garland, Arrangement). A chip tapped before Add names that one entry, then clears. No chip = the item is named "Counter sale".
- Amount must be more than ₹0 and at most ₹1,00,000 (guards against a stray extra zero; message: "That looks too big — check the amount"). Anything bigger goes through Full order.

### 5.4 Saving, speed and failures

- The line appears instantly as "saving…", then turns to ✓ when the server confirms. Entries are sent one after another in tap order.
- If a request fails, the line turns red: **"Not saved — tap to try again"**. Nothing is queued in the background (no offline mode — CLAUDE.md constraint 3). The counts at the top of the roll only include saved entries.
- The person can keep tapping while earlier entries are saving.

### 5.5 Roll lines: undo, change method, print, add details

- The roll shows this location's quick entries for the **current register session** (or today, if no register is open), newest first, with running Cash / UPI / count totals for those entries.
- **Undo** (on every saved line): one tap, no "are you sure". The line shows "Undone · Redo" for 5 seconds (Redo records it again), then greys out with a strike-through. Rules in §7.2.
- **Tap a line** → a small sheet with large buttons:
  - **Change to UPI** / **Change to Cash**
  - **Print bill** (the existing `printOrderSlip`)
  - **Add details** — opens Sale Details for that sale, where items, customer and note can be edited through the existing Edit Sale flow (for when the customer wants a proper bill with a name, or stock needs the real product).
  - **Undo**

### 5.6 Register closed

- A cash entry needs an open register (existing `register-guard` rule). When the register is closed and Cash is selected, the tiles and amount box are replaced by the existing in-place `OpenRegisterForm` ("Cash in the drawer now" → **Open register**), with the line "The register is closed. Count the drawer and open it to start taking cash." Once opened, the pad comes back. Nothing typed is lost.
- UPI entries do not need an open register (unchanged server rule), so UPI stays usable.

### 5.7 First-time instructions

- The first time a person opens Quick sale on a device, a card sits above the pad:
  1. "Pick **Cash** or **UPI**."
  2. "Tap a button, or type the amount and press **Add**. The sale is saved right away."
  3. "Made a mistake? Tap **Undo** on that line."
  [Got it]
- "ⓘ How this works" at the top brings the card back at any time.

## 6. Safety net at register close

During a real rush some sales still won't be recorded. When closing the register (existing Cash Register screen), after the counted cash is entered:

- If counted cash is **more** than expected by ₹1 or more, the close screen shows:
  **"₹1,400 more than recorded. Book it as unrecorded sales?"** [Book ₹1,400 as sales] [No, close as it is]
- **Book** records one quick sale, cash, item "Unrecorded sales (booked at close)", `entry_mode = 'close_topup'`, then closes the register — so the extra cash is now a sale and the discrepancy for it is zero.
- A shortage is never booked away; it closes as a shortage, as today.
- The owner's reports list close top-ups separately (count and total per person who closed), so a habit of under-recording is visible.
- UPI is not covered (it would need reconciling against the UPI app — out of scope).

## 7. Server

### 7.1 Creating a quick entry

Reuse `POST /api/sales` (no new create route), so every existing rule — register guard, discount thresholds, stock, totals, audit — applies unchanged. The client sends a normal walk-in sale with one item and a full payment, plus `entry_mode: 'quick'`:

- `order_type: 'walk_in'`, `channel: 'walk_in'`, `skip_assignment: true`.
- Product tile: `product_id` + quantity 1 + `unit_price` = the current catalog price returned by the tiles endpoint (§7.5). Note: `POST /sales` currently trusts a client-sent `unit_price` on a product line (`server/routes/sales.js` ~line 1676, the price-manipulation gap already listed in CLAUDE.md). This spec does not widen that gap and does not fix it for counter roles; the scan-and-sell spec closes it for the new `helper` role.
- Label tile / other amount: one custom item with that name and price.
- `payments: [{ method, amount }]` for the full total.

`entry_mode` is validated against `['quick', 'close_topup']` and stored; anything else stores NULL (a normal sale).

### 7.2 Undo — `POST /api/quick-sale/:id/undo`

Roles: owner, manager, employee, counter_staff. Rules, checked in one transaction:

- The sale has `entry_mode = 'quick'` and is not already cancelled.
- If it has cash payments, the register it was paid into must still be the open one (an entry from an already-closed session can only be reversed with the normal refund flow — message: "This sale is from a register that's already closed. Use Refund on the sale instead.").
- employee/counter_staff can undo their own entries and anyone's within the current session; owner/manager any.

Effect: set `status = 'cancelled'`, `undone_by`, `undone_at`; reverse the running register totals the payment added (cash → `total_cash_sales`/`expected_cash`, UPI → `total_upi_sales`); put product stock back, the same way `PUT /:id/cancel` restores stock; write an audit log. The register close recompute already ignores cancelled sales (`s.status != 'cancelled'`), so close stays correct.

The existing `PUT /:id/cancel` is not used, because it deliberately blocks cancelling a sale with an unrefunded balance; undo-quick is the narrow, session-bound exception to that rule.

**Redo** simply records the same entry again (a new sale) — no un-cancel.

### 7.3 Change method — reuse Edit Sale

The line's "Change to UPI/Cash" calls the existing `PUT /api/sales/:id` payment-method edit, which already moves only the per-method difference in the open register and blocks cash edits with no open register (fixed 2026-09-04). No new route.

### 7.4 Roll data — `GET /api/quick-sale/roll?location_id=`

Returns this location's `entry_mode IN ('quick','close_topup')` sales since the open register's `opening_time` (or since local midnight when none is open): id, time, item name, amount, method, status, undone flag, created_by name — plus totals. Same roles as above.

### 7.5 Tiles — settings

New setting key `quick_sale_tiles` (JSON array, max 12): `{ type: 'product', product_id }` or `{ type: 'label', label, price }`. Only the owner edits tiles in Settings. `GET /api/quick-sale/tiles?location_id=` returns resolved tiles (product name + current price; inactive products dropped) or, when the setting is empty, the top-12 suggestion.

## 8. Data changes (all additive — read `db-migration-safety` before writing)

- `sales.entry_mode VARCHAR(20)` — NULL for normal sales.
- `sales.undone_by INTEGER REFERENCES users(id) ON DELETE SET NULL`, `sales.undone_at TIMESTAMP`.
- Index on `(location_id, entry_mode, created_at)` for the roll.
- Settings row `quick_sale_tiles` (no schema change).

All via `ensureColumn` in `server/config/database.js`, never by hand on dev.

## 9. Reports

- Sales reports treat quick entries as normal walk-in sales.
- Owner sees, per staff member: number and amount of quick entries, **undone** entries (count and ₹), and close top-ups. Frequent undos after cash was taken is the classic way to skim, so this is shown, not hidden. (This list lives in the owner-only Staff sales report defined in the scan-and-sell spec; until that ships, undo counts are visible in the audit log.)

## 10. Plain-language messages

| Situation | Message |
|---|---|
| Register closed, Cash selected | "The register is closed. Count the drawer and open it to start taking cash." + form |
| Amount empty / ₹0 | "Type the amount first" (shown under the box, no popup) |
| Amount over ₹1,00,000 | "That looks too big — check the amount" |
| Save failed | Line: "Not saved — tap to try again" |
| Undo on a closed session | "This sale is from a register that's already closed. Use Refund on the sale instead." |
| Tile product switched off since screen loaded | "This item isn't sold any more — the buttons have been refreshed" |

## 11. Staff UX checklist (counted)

- Tile sale: **1 tap**. Other amount: digits + **1 tap** (or Enter). Undo: **1 tap**. Change method: **2 taps**. Print: **2 taps**. Switching modes: **1 tap**, remembered.
- One primary action per moment: the tiles/Add are the only large action buttons; Undo and the line sheet are secondary.
- Nothing required except the amount. No blank form — tiles and last method are pre-filled.
- Every error says what to do next (§10).
- Nothing removed: Full order is unchanged and one tap away.

## 12. Testing

- New `server/scripts/verify-quick-sale.js`: quick entry creates a completed walk-in sale with `entry_mode='quick'`; cash entry with closed register is refused with the plain message; UPI entry with closed register succeeds; undo reverses register totals and stock and is excluded from close; undo from a closed session is refused; undo twice is refused; method change moves only the delta; close top-up books the excess and leaves zero discrepancy for it; quick-roll returns only this session's entries; inactive product tiles are dropped.
- Re-run `verify-order-flows.js`, `verify-register-expenses.js` (shared `POST /sales` and register close).
- On screen, with a throwaway counter_staff account: 10 rapid tile taps → 10 sales, totals right; double tap on one tile → 1 sale; failure line retry (stop the API briefly); register closed → open in place; undo/redo; change method; print; close top-up.

## 13. Out of scope

- Card payments and split on the quick screen (Full order).
- Customer names, credit, dues on the quick screen (Full order / Add details).
- Verifying UPI against the bank or UPI app.
- Offline recording.
- Converting a whole session's quick entries into itemised sales in bulk.
