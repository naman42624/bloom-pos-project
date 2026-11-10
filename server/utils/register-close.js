// Register close maths, shared by register status, close preview, close and
// the read-only reconcile script (scripts/reconcile-registers.js). Moved out
// of routes/sales.js unchanged (2026-11-05), plus an optional `until` bound
// for recomputing a past session. Works on the sync db, the async pool and a
// money transaction (every query is awaited).
const { sumCollectionsByMethod } = require('./settlement-math');

// Card/UPI taken while this shop's register was shut (after the previous
// session closed and before this one opened). No session counts it, so it is
// shown on its own beside this session. Cash can't be taken while shut.
async function computeShutTimePayments(db, register, location_id) {
  const sessionStart = register.opening_time || register.opened_at;
  const prev = await db.prepare(
    'SELECT closed_at FROM cash_registers WHERE location_id = ? AND id < ? AND closed_at IS NOT NULL ORDER BY id DESC LIMIT 1'
  ).get(location_id, register.id);
  if (!prev) return { since: null, upi: 0, card: 0 };
  const from = prev.closed_at;
  const direct = await db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN p.method = 'upi' THEN p.amount ELSE 0 END), 0) as upi,
      COALESCE(SUM(CASE WHEN p.method = 'card' THEN p.amount ELSE 0 END), 0) as card
    FROM payments p JOIN sales s ON s.id = p.sale_id
    WHERE s.location_id = ? AND (s.status != 'cancelled' OR EXISTS (SELECT 1 FROM refunds kr WHERE kr.sale_id = s.id AND COALESCE(kr.status, 'processed') = 'processed')) AND p.created_at < ?
      AND (? IS NULL OR p.created_at >= ?)
      AND (p.reference_number IS NULL OR (p.reference_number NOT LIKE 'Credit-%' AND p.reference_number != 'COD' AND p.reference_number NOT LIKE 'COD-%'))
  `).get(location_id, sessionStart, from, from);
  const dues = await db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN payment_method = 'upi' THEN amount ELSE 0 END), 0) as upi,
      COALESCE(SUM(CASE WHEN payment_method = 'card' THEN amount ELSE 0 END), 0) as card
    FROM credit_payments
    WHERE location_id = ? AND created_at < ? AND (? IS NULL OR created_at >= ?)
  `).get(location_id, sessionStart, from, from);
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  return { since: from, upi: r2(Number(direct.upi) + Number(dues.upi)), card: r2(Number(direct.card) + Number(dues.card)) };
}

// The one expected-cash calculation: close, close preview and register status
// all use it. Async; pass the money transaction when called while locked.
async function computeRegisterClose(db, register, location_id, { until = null } = {}) {
  // `until`: only for recomputing a past session (reconcile script) - the
  // session's own closed_at. Live callers leave it null.
  const endSql = (col) => (until ? ` AND ${col} < '${String(until).replace(/'/g, "''")}'` : '');
  // Recalculate totals from actual payment records during this session
  const sessionStart = register.opening_time || register.opened_at;
  // 1. Get totals from direct sale payments (excluding auto-allocated credit payments).
  // Cash held by a helper (payments.held_by, bag mode) never entered the
  // drawer, so it is left out here; it arrives through handovers below.
  const directPaymentTotals = await db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN p.method = 'cash' AND p.held_by IS NULL THEN p.amount ELSE 0 END), 0) as cash_total,
      COALESCE(SUM(CASE WHEN p.method = 'card' THEN p.amount ELSE 0 END), 0) as card_total,
      COALESCE(SUM(CASE WHEN p.method = 'upi' THEN p.amount ELSE 0 END), 0) as upi_total
    FROM payments p
    JOIN sales s ON p.sale_id = s.id
    WHERE s.location_id = ? AND p.created_at >= ?${endSql('p.created_at')}
      AND (s.status != 'cancelled' OR EXISTS (SELECT 1 FROM refunds kr WHERE kr.sale_id = s.id AND COALESCE(kr.status, 'processed') = 'processed'))
      AND (p.reference_number IS NULL OR (p.reference_number NOT LIKE 'Credit-%' AND p.reference_number != 'COD' AND p.reference_number NOT LIKE 'COD-%'))
  `).get(location_id, sessionStart);

  // 2. Get totals from credit payments collected at this location
  const creditPaymentTotals = await db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN payment_method = 'cash' THEN amount ELSE 0 END), 0) as cash_total,
      COALESCE(SUM(CASE WHEN payment_method = 'card' THEN amount ELSE 0 END), 0) as card_total,
      COALESCE(SUM(CASE WHEN payment_method = 'upi' THEN amount ELSE 0 END), 0) as upi_total
    FROM credit_payments
    WHERE location_id = ? AND created_at >= ?${endSql('created_at')} AND payment_method != 'write_off'
  `).get(location_id, sessionStart);

  // 3. Get totals from verified delivery COD settlements at this location.
  // delivery_settlements.total_amount is method-agnostic (a settlement can
  // batch several deliveries, cash and UPI mixed) — the real per-collection
  // method lives on delivery_collections, same fact settle-now's own
  // register credit (POST /deliveries/settlements/settle-now) already
  // respects via sumCollectionsByMethod. This recompute used to sum
  // total_amount straight into cash_total, treating 100%-UPI COD as cash;
  // close then OVERWRITES the register's running total_cash_sales/
  // total_upi_sales with that miscounted figure, silently discarding the
  // correct totals settle-now had already written in real time. Found
  // live, 2026-09-04: a ₹500 UPI COD settlement correctly reported "no
  // change to cash register" the moment it happened, then produced a
  // ₹500 discrepancy the next time the register was closed.
  const settledDeliveryRows = await db.prepare(`
    SELECT dsi.delivery_id
    FROM delivery_settlement_items dsi
    JOIN delivery_settlements ds ON ds.id = dsi.settlement_id
    WHERE ds.location_id = ? AND ds.verified_at >= ?${endSql('ds.verified_at')} AND ds.status = 'verified'
  `).all(location_id, sessionStart);
  const settledDeliveryIds = settledDeliveryRows.map((r) => r.delivery_id);
  const codSettlementExpectedTotal = (await db.prepare(`
    SELECT COALESCE(SUM(ds.total_amount), 0) as total
    FROM delivery_settlements ds
    WHERE ds.location_id = ? AND ds.verified_at >= ?${endSql('ds.verified_at')} AND ds.status = 'verified'
  `).get(location_id, sessionStart)).total;
  const codByMethod = await sumCollectionsByMethod(db, settledDeliveryIds, codSettlementExpectedTotal);

  const paymentTotals = {
    cash_total: directPaymentTotals.cash_total + creditPaymentTotals.cash_total + codByMethod.cash,
    card_total: directPaymentTotals.card_total + creditPaymentTotals.card_total,
    upi_total: directPaymentTotals.upi_total + creditPaymentTotals.upi_total + codByMethod.upi,
  };

  // Every processed cash refund counts: it is cash that left the drawer.
  // A cancelled sale's payments are left out above only when it has no
  // refund (an undone quick sale or an old-style cancel, whose cash was taken
  // off the register at the time). A sale refunded and then cancelled keeps
  // its payments and its refunds, because both really moved money. Leaving
  // out both used to assume the refund matched the payments method by
  // method: paid Rs 55 cash + Rs 100 UPI, refunded Rs 155 by UPI, cancelled,
  // and close then expected Rs 55 less than the drawer held (found
  // 2026-11-06). Cash held by a helper is still left out of payments
  // (held_by) while its refund counts, as before.
  let refundTotal = 0;
  try {
    refundTotal = (await db.prepare(`
      SELECT COALESCE(SUM(r.amount), 0) as total
      FROM refunds r
      JOIN sales s ON r.sale_id = s.id
      WHERE s.location_id = ? AND r.created_at >= ?${endSql('r.created_at')} AND r.refund_method = 'cash' AND COALESCE(r.status, 'processed') = 'processed'
    `).get(location_id, sessionStart)).total;
  } catch (err) {
    const msg = String(err?.message || '').toLowerCase();
    if (!msg.includes('refund_method')) throw err;
    refundTotal = (await db.prepare(`
      SELECT COALESCE(SUM(r.amount), 0) as total
      FROM refunds r
      JOIN sales s ON r.sale_id = s.id
      WHERE s.location_id = ? AND r.created_at >= ?${endSql('r.created_at')}
    `).get(location_id, sessionStart)).total;
  }

  // Cash expenses during this session (net of returns).
  // Use register_id for session-exact scoping; timestamp fallback for legacy expenses.
  const expenseTotal = (await db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN is_return = 1 THEN -amount ELSE amount END), 0) as total
    FROM expenses e
    WHERE payment_method = 'cash'
      AND (
        register_id = ?
        OR (register_id IS NULL AND location_id = ? AND created_at >= ?${endSql('created_at')})
      )
      AND NOT (
        e.register_id IS NULL AND e.description LIKE 'Refund for past sale %'
        AND EXISTS (
          SELECT 1 FROM refunds r JOIN sales rs ON rs.id = r.sale_id
          WHERE r.refund_method = 'cash' AND e.description = 'Refund for past sale ' || rs.sale_number
        )
      )
  `).get(register.id, location_id, sessionStart)).total;

  // Helper cash bags (spec 11.4): floats given out of this register session
  // left the drawer; handovers received into it came in (the counted amount,
  // which is the cash actually put in the drawer).
  const helperCash = await db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'handover_in' THEN counted_amount ELSE 0 END), 0) as handovers,
      COALESCE(SUM(CASE WHEN type = 'float_out' THEN expected_amount ELSE 0 END), 0) as floats
    FROM staff_cash_movements
    WHERE register_id = ?
  `).get(register.id);
  const handoverTotal = Number(helperCash.handovers) || 0;
  const floatTotal = Number(helperCash.floats) || 0;

  // Whole paise, so float and handover sums never leave a stray fraction
  const expectedCash = Math.round((Number(register.opening_balance) + Number(paymentTotals.cash_total) - Number(refundTotal) - Number(expenseTotal) - floatTotal + handoverTotal) * 100) / 100;
  return { paymentTotals, refundTotal, expenseTotal, floatTotal, handoverTotal, expectedCash };
}


module.exports = { computeRegisterClose, computeShutTimePayments };
