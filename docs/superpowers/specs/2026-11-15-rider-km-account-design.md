# Rider km account — design

Piece 3 of 3 of the expense work (piece 1: expense book, PR #39; piece 2: staff money, PR #41; both merged).

## 1. Why

Riders (`delivery_partner`) are paid for the km they ride for the shop, **on top of their salary**, at a rate the owner sets (₹3/km today; it changes). Today this is kept on paper: the counter notes the bike meter when the rider arrives and when the rider goes home. Every few days the rider comes to the counter to "settle the reading". The money taken in between is netted off: petrol cash, unspent supply money and COD the rider still holds. Whatever the shop owes is paid. If the rider owes, it is usually not collected; it comes off the next settlement or the salary.

The owner wants this in the app, with the money right in the expense book, **without it feeling like another separate flow**. Counter staff, owner and manager use it. Riders see their own figures.

## 2. Goals, non-goals, anti-goals

**Goals**
- Counter staff record a meter reading in about 4 taps, from the existing Add expense sheet.
- Missed readings never vanish silently: the meter chain shows every gap, and each gap must be explained before settling.
- One settle sheet shows exactly how the rider's money is worked out, and moves only the net cash.
- The expense book shows the true petrol cost: for each settlement, petrol taken plus the settlement's petrol entry equals km × rate. Nothing is counted twice.
- Riders see their unsettled km, balance and past settlements in **My money**.

**Non-goals**
- GPS km. The GPS tracking code exists (`delivery_partner_daily`), but riders have not installed the app, so it is unused. It may later be a hint on a gap; it is not part of this design.
- Working out days worked from deliveries. Not every order is logged in the app.
- Riders entering their own readings.
- Changing how a rider's salary is calculated.

**Anti-goals** (these would be failures even if the feature "worked")
- A rider is underpaid because the counter forgot a reading.
- Petrol counted twice in the expense book.
- The drawer's expected cash moving by money that never crossed the counter.
- Any change to existing expense rows on production.

## 3. Constraints

- Live data. Schema changes are additive only (new tables and columns via `database.js` patches); existing expense, shopping money and COD rows are never rewritten.
- Staff UX checklist: big targets, the likely choice pre-picked, plain words, one primary button.
- Web-safe dialogs only (`showAlert` / `showConfirm`), and the double-tap guard (`useSubmitGuard`) on every write.
- Cash at the counter needs an open register (`register-guard`), with the same "Open Register" path as everywhere else.
- The async DB layer only. No apostrophes in `--` SQL comments.

## 4. Approaches considered

- **A. Readings in the Add expense sheet; settle from the existing money card** — **chosen.** Reuses the sheet, the people picker, the money card, Pay back and payroll's Take from pay, so it reads as part of expenses rather than a new area.
- **B. Readings tied to attendance clock-in/out.** Rejected: attendance is roadmap phase 6 and not reworked yet, and riders may not clock in.
- **C. Riders enter their own readings with a meter photo.** Rejected: riders are first-time users without the app, and the counter would still have to check every reading.

## 5. The reading chain

A rider's readings form **one chain of meter numbers in time order**. Each reading is one of:

- **Arriving** — the meter when the rider starts work.
- **Going home** — the meter when the rider leaves for home.
- **Typed km** — no meter number: "N km of work" on a date, used when the meter is broken or the bike was changed.

Any number of readings per day (in–out–in–out is normal: lunch at home).

**Paid km** = every **Arriving → Going home** stretch (the meter difference). A **Going home → Arriving** stretch is always the rider's own (home rides, lunch at home) and never paid. The user confirmed riders take no reading unless they go home, so everything between an Arriving and the next Going home is work.

**Gaps.** A gap is any stretch the chain cannot explain on its own:
1. **Two Arrivings in a row**: a Going home was missed. The stretch between them is unknown.
2. **Two Going homes in a row**: an Arriving was missed. Same.
3. **A long home stretch**: a Going home → Arriving stretch longer than twice the rider's usual home ride, or longer than 30 km while there is no usual yet. "Usual" is the median of the rider's last 10 home stretches; owner and manager may set it per rider instead.
4. **Meter went down**: refused at entry. The sheet offers "Type km instead".

Each gap is answered with one of:
- **Add the missed readings** (any past date and time inside the gap, from the paper notebook). The chain re-forms.
- **Type work km** — how many km of the stretch were work (0 to the stretch length).
- **No work** — the whole stretch is the rider's own (0 km paid).

Gaps must all be answered before a settlement can include that stretch. A gap never blocks taking new readings, selling or closing the register.

**Account start.** A rider's account starts at the **start of the shop day** (shop-local midnight) of their first reading in the app. This catches petrol or COD handed over that morning, before the first reading was typed. Petrol advances and COD from before the start are left as they are (settled on paper). Shopping money the rider still holds is included whenever it was given, because piece 2 tracks it and nothing settled it on paper.

## 6. Rate

Owner setting **Km rate** (₹ per km, default 3), kept with its history: a change has an effective date. Each paid stretch uses the rate in force on the date of its **Going home** reading (for typed km, the date it was typed for). The settle sheet shows a line per rate if more than one applies.

## 7. Entering a reading (Add expense sheet)

A third link in the Add expense sheet, next to Salary advance and Shopping money: **Km reading**.

```
┌ Km reading ─────────────────────┐
│ Rider:  [ L ] [ Aman ] [ Vishal ] │  riders at this shop, last-used first
│  [ Arriving ]  [■ Going home ]    │  pre-picked: opposite of the last reading
│ Meter now                         │
│ [  12,386           ]             │  number pad
│ Last: Arriving 12,340 · 9:12 am   │
│ → 46 km of work                   │
│ For another day ›   Type km instead › │
│ [            Save              ]  │
└───────────────────────────────────┘
```

- Common case: Add expense → Km reading → (rider pre-picked) → type → Save.
- "For another day": a date and time picker. Counter staff can go back to the rider's last settlement or 7 days, whichever is later. Owner and manager can go back to the last settlement.
- A reading that is below the previous reading in the chain (by time) is refused: "The meter can't go down. Check the number, or tap Type km instead." A work stretch over 300 km asks "Is 13,900 right?" before saving.
- After Save: a toast "Saved · 46 km of work today".
- Readings can be changed or removed until settled (owner, manager, and the counter staff who entered them within 7 days). A settled reading cannot be changed. A mistake found later is fixed with a **Correction** (±km, with a note) that lands in the next settlement (owner/manager only).

**Reminders** (never blocking):
- The register close screen lists riders whose last reading today is an Arriving: "L has no going-home reading — Add now".
- The counter dashboard shows "Readings: L hasn't gone home yet" only during the register close flow, not all day (to avoid noise).

## 8. Petrol taken

A **petrol advance** is an expense whose item is marked **Rider petrol** and that is tied to a rider by the linked person, not a typed name. It counts in any of these ways:
- given to the rider (`given_to_user_id`), paid in shop cash or UPI;
- bought with the rider's shopping money (entered through "L is back — what was bought?");

**Own-pocket petrol is not part of this** (user, 2026-11-15). Petrol a rider buys with their own money is never logged in the app; the km pay is what covers it. To keep it that way, the Add expense sheet refuses a Rider petrol item paid by **Own pocket** of a rider: "A rider's own petrol is covered by their km pay — no need to add it."

Petrol entered with only a typed name (no linked rider) is not matched. Picking a Rider petrol item in the Add expense sheet with a typed-only name shows "Pick the rider from the list so it counts against their km." The item flag is a new owner switch on the item page. It is turned on by default for any existing item whose name is "Petrol" (case- and space-insensitive), and when the owner first opens the Km rate setting they are shown which items count.

**Which settlement a petrol advance belongs to** (the user's rule: any petrol between two settled readings counts):
- It belongs to the first settlement whose last covered Going home reading is at or after the time the expense was saved (`created_at`), and that has not already included it.
- Petrol handed over after that reading, for example the next morning while the day is still open, waits for the next settlement.
- An expense saved late for an older day is never lost. It falls into the next settlement.
- The first settlement starts from the account start (§5).

Each petrol advance is listed by date in the settle sheet.

## 9. Settling

Opened from the rider's line on the existing **Shopping money out** card (renamed on screen for riders as "L · 142 km · L owes ₹414" / "· Shop owes ₹226"). Also opened from the Km reading sheet and the rider's money history. Owner, manager and counter staff can settle.

```
┌ Settle L's km ──────────────────┐
│ 10 Nov  46 km                    │
│ 11 Nov  66 km (2 trips)          │
│ 12–14 Nov ⚠ Gap 314 km — answer › │  must be answered first
│ ─────────────────────────────── │
│ 112 km × ₹3                ₹336  │
│ Petrol taken (2)          −₹200  │
│ Carried from last time     −₹40  │
│ Supply money with L       −₹100  │
│ COD with L (1 order)      −₹500  │
│ ─────────────────────────────── │
│ L owes ₹504                      │
│ [   Carry ₹504 to next time   ]  │
│ Take some now ›                  │
└──────────────────────────────────┘
```

**What a settlement covers:** every answered stretch from the last settlement up to the latest **Going home** reading, plus unanswered-gap-free typed km and corrections. An open day (last reading is an Arriving) is left for next time.

**Lines:**
- **Km money** K = Σ paid km × rate.
- **Petrol taken** — the petrol advances (§8).
- **Carried from last time** — the previous settlement's carried balance (+ if the shop owed, − if the rider owed).
- **Supply money with L** — the rider's open shopping money (piece 2), counted as cash the rider holds. Shopping money where the rider is still to say what was bought must first go through "L is back — what was bought?" (the existing flow, offered inline). The settle sheet counts only the change the rider still holds.
- **COD with L** — only the **cash** part of COD the rider has collected and that no `settle-now` has settled (`delivery_collections.method = 'cash'`). UPI COD normally went straight to the shop's account, so it is not taken off by default. A delivery paid partly each way counts only its cash part. Listed per order.
  - **UPI to the rider's own account:** each UPI COD order on the settle sheet has a switch, **Paid to L's own UPI** (off by default). Turning it on counts that amount as held by the rider, the same as cash. If the rider then pays it to the shop's UPI or hands over cash, it is handled by the normal buttons (**Take some now**, Cash or UPI) or simply netted against km money.
  - The switch is saved on the settlement, so the record shows why the amount was taken off.
  - **Deferred (user, 2026-11-15, rare case):** the delivery's payment still says UPI, so the shop's UPI-received total for that day includes money that went to the rider's own account. Fixing it needs a third COD method ("UPI to rider") in the delivery's COD entry flow; not part of this build.

**W** = K − petrol taken + carried − supply money with L − COD with L.

**Buttons**
- W > 0 (shop owes): **Pay L ₹W**, Cash or UPI (Cash needs an open register). Or **Carry** (the shop keeps owing; shown on the card).
- W < 0 (rider owes): **Carry ₹W to next time** (primary, since this is what the shop usually does). Or **Take some now** — the rider hands over any amount up to W (cash into the drawer or UPI).
- W = 0: **Settle**.

**What one settlement writes** (one transaction):
1. A settlement record with every line, the stretches/readings/advances/corrections/COD/shopping money it covered, and the amount paid or taken and the carry.
2. **Petrol expense** for the true cost. Petrol taken was already in the expense book, so the settlement adds **K − petrol taken** as a Petrol expense given to L, paid by **Km account** (a new payment method that never touches the drawer, like Own pocket). If K < petrol taken, it adds a **money-back** row (`is_return`) for the difference. Either way, for that settlement: petrol advances + settlement row = K.
3. COD covered is marked settled on the delivery (`cod_status` as `settle-now` leaves it, plus the new `deliveries.km_settlement_id`). **No `delivery_settlements` row is written**: register close adds every verified `delivery_settlements` row's cash into expected cash, which would move the drawer by COD that never crossed the counter. The Settlements screen's history lists km settlements as their own lines, so the record stays complete. Setting `cod_status = 'settled'` also removes the order from the Settlements screen's pending COD list (which shows only `collected`/`partial`), so **nothing has to be settled twice**: a COD netted in a km settlement is done everywhere. `settle-now` stays available for riders: if L hands over COD cash on the day, the counter settles it as today, and the km settlement then only picks COD still open. Both paths lock the delivery rows (`FOR UPDATE`) so a COD can't be settled twice. Supply money covered is marked settled (the change the rider holds counts as handed in through the km account, not the drawer).
4. **Drawer:** only cash that physically crosses the counter moves expected cash: money paid to L (out) or taken from L (in). COD and supply money netted against km money do not touch the drawer, and neither does the carry. One register line: "L km settlement +₹X / −₹X".
5. The carry becomes the new balance shown on the card and in the next settlement.

**At payroll** (owner): payroll offers only the rider's **current carried balance**, and the owner chooses whether to apply it:
- If the rider owes, it comes off the pay through the existing **Take from pay** tick, extended to riders for this one figure.
- If the shop owes, it is added to the pay.

Unsettled km, COD or supply money is not taken at payroll directly, because that would bypass the km netting. Instead payroll shows "L has km not settled — Settle km first", which opens the settle sheet. The settle sheet has a third button for the owner, **Take from salary**, which carries the result straight into the next payroll. Riders do have salaries (all three have monthly salary rows) and go through payroll like other staff.

## 10. Rider view (My money)

```
┌ My km money ────────────────────┐
│ Not settled yet: 112 km · ₹336  │
│ Petrol taken ₹200 · COD ₹500     │
│ Owed by you now: ₹404            │
│ Past settlements                 │
│ 8 Nov · 210 km · paid ₹380       │
│ 3 Nov · 95 km · carried −₹40     │
│ Readings ›                       │
└──────────────────────────────────┘
```

Read-only. The rider sees their own readings and gaps, never other riders'.

## 11. Who can do what

| | Counter / employee | Manager | Owner | Rider | Florist, helper, customer |
|---|---|---|---|---|---|
| Add reading (today) | yes | yes | yes | no | no |
| Add reading for another day | back to 7 days / last settlement | to last settlement | to last settlement | no | no |
| Change or remove an unsettled reading | own, within 7 days | yes | yes | no | no |
| Correction on a settled reading | no | yes | yes | no | no |
| Answer a gap, settle | yes | yes | yes | no | no |
| Km rate, Rider petrol flag, usual home ride | no | usual home ride | yes | no | no |
| My km money | — | — | — | own | no |

## 12. Data (additive)

New tables:
- `rider_km_readings` (rider, location, kind arrive/leave/typed, meter, typed_km, read_at, note, created_by, settlement_id, removed_at).
- `rider_km_gap_answers` (rider, from_reading, to_reading, answer add/typed/none, work_km, answered_by).
- `rider_km_corrections`.
- `rider_km_settlements` (all lines, paid/taken amount and method, carry_out, expense_id, register_id, created_by).
- `rider_km_rates` (rate, effective_from, set_by).

New columns:
- `expense_items.is_rider_petrol`;
- `users.km_usual_home_ride`;
- `deliveries.km_settlement_id`;
- the shopping money row's settlement link;
- `expenses.km_settlement_id`.

New payment method `km_account`, excluded from every drawer query, like `own_pocket` and `shopping_money`. Audit rows for every reading change, gap answer, correction and settlement.

## 13. Calls left to the builder

Calls I (Claude) made that the user has not explicitly chosen (several after a reviewer check):
- Account start = start of the shop day of the first reading.
- Only cash COD is netted.
- Shopping-money petrol counts as petrol taken. Own-pocket petrol is not logged at all; a rider's own-pocket Rider petrol entry is refused.
- No `delivery_settlements` row for km-netted COD; `settle-now` stays available.
- Payroll takes only the carried balance, with "Settle km first" for anything unsettled.
- The 30 km / twice-the-usual gap threshold, the 300 km confirm, and median-of-last-10 for "usual".
- The rate is the one on the Going home date.
- Petrol is identified by an item flag, defaulting on for "Petrol".
- The settle-sheet layout.
- Netted COD does not touch the drawer.

Left to the builder:
- Exact route names and file split (follow `staff-money.js` patterns).
- Whether the chain is computed in SQL or JS (it must be computed from rows, never stored as running totals).
- How the money card lists riders alongside shopping money holders.

## 14. Testing

Server script `verify-rider-km.js`, covering:
- chain maths: in–out–in–out, typed km, gaps of each kind and each answer;
- meter going down refused;
- rate change mid-period;
- settlement lines and W in all three signs;
- petrol rows + settlement row = K, including the K < petrol case;
- the drawer moves by paid/taken cash only;
- carry chaining across three settlements;
- COD and supply money marked settled exactly once;
- two settles at once (one wins);
- a settled reading locked, and a correction landing next time;
- account start ignores older petrol/COD;
- roles and 403s, and a rider seeing only their own;
- payroll Take from pay for a rider balance.

App unit tests for the chain and W maths. On-screen checks at 375 px of the reading sheet, a gap answer, a multi-day settle, and the rider's My money.
