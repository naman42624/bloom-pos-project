# Phase 1: cash and register safety (2026-11-05)

Branch `fix/cash-register-safety` off `main` (after PRs #26–#29). Approved by the user on 2026-11-05 ("1 yes").

## Why
- `config/database.js` `db.transaction(fn)` is a no-op: every statement in a sale, payment, refund, cancel, pickup, COD settlement or dues payment runs on its own psql process. A failure half way leaves half a record; two requests can interleave; nothing is locked.
- The async layer's `db.transaction()` is also not real (its queries use other pool connections). Only `withTransaction` is real.
- Expected cash is written by 17 running updates and recomputed from scratch at close (close wins). The Cash Register screen shows the running number, so the two can disagree.

## Approach
1. `server/utils/money-tx.js`: `withMoneyTx(fn)` — one pooled client, BEGIN/COMMIT/ROLLBACK, and `tx.prepare(sql).get/all/run` returning rows in **exactly the sync layer's shape** (rows read through `json_agg`, so numbers are numbers and timestamps are strings, `datetime('now')` and `INSERT OR IGNORE` rewritten the same way). Converting a route is then mechanical: `await`, and `db` → `tx`.
2. Lock order, everywhere: sale row(s) → helper bag (`lockBag`) → open register row (`SELECT … FOR UPDATE`). Every cash-affecting write locks the open register before it reads or writes cash. Close locks the register, computes, updates, commits.
3. `computeRegisterClose` becomes async and is the only expected-cash calculation: close, close preview and register status all use it. Running columns keep being written for old readers.
4. Routes moved onto `withMoneyTx`: `POST /sales`, `POST /:id/payments`, `PUT /:id/cancel`, `POST /:id/refund`, `PUT /:id` (Edit Sale), `PUT /:id/status`, `POST /:id/fulfill-from-stock`, `PUT /:id/convert-type`, `POST /:id/resolve-balance`, register open/close; deliveries `/deliver`, `/settlements/settle-now`, `/pickup/:id/picked-up`, `/:id/cancel`, `/:id/convert-payment`; customers credits (add, add-due, edit, delete); expenses create/edit/delete; salary advance and salary payout cash.

## Bug fixes in the same pass
- B15: a past-day cash refund is one `refunds` row; no extra cash expense. Old "Refund for past sale …" expense rows that duplicate a refund row are left out of close maths.
- B16: pickup cash adds to `expected_cash` like every other route.
- B14: Edit Sale writes `customer_notes` (the `order_notes` field maps to it).
- B20: Cash↔UPI on a coworker's quick sale is allowed for staff at that shop while the sale's register session is open; audited.
- B22: delivery shows rider-collected and counter-paid separately.
- C27: close is one transaction (above).
- C28: float and handover take an optional `request_id`; additive `staff_cash_movements.request_id` with a unique index; a repeat returns the first result.
- C29: a helper cash sale takes `lockBag` inside the sale transaction.
- C30: close summary shows UPI taken while the register was shut (between the previous close and this open).

## Checks
- New `server/scripts/verify-cash-safety.js`: rollback on a mid-sale failure leaves nothing; a sale and a close at the same moment never lose cash; register status equals close preview; each bug above.
- `server/scripts/reconcile-registers.js`: read-only; recomputes every session and lists mismatches (run locally and on live).
- Every existing suite stays green.

## Done (2026-11-05)
- `withMoneyTx` lives in `config/database-async.js` (not a separate file); statements run one at a time with a savepoint each.
- Converted to real transactions with locks (sale/delivery rows, then helper bag, then register, then customer row): POST /sales, add payment, cancel, refund, Edit Sale, convert-type, resolve-balance, register open/close/status; deliveries deliver, settle-now, pickup picked-up, cancel, convert-payment; customer credits, add-due, edit and delete credit; expense create/delete; salary advance approve, salary payout; quick-sale undo now locks the register after the bags.
- `computeRegisterClose` moved to `utils/register-close.js` (async, optional `until`); status, preview and close all use it. Status keeps the old running figure as `running_expected_cash`.
- Fixed in the same pass: B14, B15, B16, B20, B22, C27, C28 (`staff_cash_movements.request_id` + partial unique index, app sends an id per tap), C29, C30 (`shut_time_payments` on status/preview, shown on Cash Register).
- Found and fixed along the way: overpaying an order (add payment, pickup) is refused; two taps on refund, payment, dues collect, register open, advance approve or payout no longer double up; write-offs take dues off the sender on delivery orders; convert-type now moves dues, total spent and COD with the new total (refuses if the order would be overpaid); convert-payment to credit crashed on a missing `password_hash` column; Edit Sale refuses a method change on a payment counted at an earlier close; dues payment edit/delete moves the register and is refused once the payment was applied to orders or counted at a close; sale numbers and settlement numbers are taken one at a time per shop.
- Not converted (no money): stock, production, settings, purchase orders, users, recurring orders, the broken customer-order route.
- Checks: `verify-cash-safety.js` 15/15, `verify-helper-bags.js` 40/40 (C28 check added), every other suite green. `scripts/reconcile-registers.js` is read-only; on the dev copy it lists old Test Loc and Main Shop sessions whose test orders were deleted, which says nothing about live data.
