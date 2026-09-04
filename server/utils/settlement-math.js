// Shared "how much of this settled COD was actually cash" calculation.
// Extracted 2026-09-04 — this used to live only in deliveries.js and only
// get called from settle-now's own real-time register credit. The register
// close route (server/routes/sales.js, PUT /sales/register/close)
// recomputes cash_total from scratch every close as an anti-drift safety
// net, and had its OWN separate query for "cash from COD settlements" that
// summed delivery_settlements.total_amount unconditionally — treating a
// 100%-UPI settlement as though it were all cash. Close then OVERWRITES the
// register's running total_cash_sales/total_upi_sales with that miscounted
// figure, silently discarding the correct real-time totals settle-now had
// already written. Found live: a ₹500 UPI COD settlement showed correctly
// as "no change to cash register" in the moment, then produced a ₹500
// discrepancy the next time the register was closed. Single source of
// truth now — both call sites must use this, not their own copy.

// Split a set of deliveries' COD collections by the method actually used to
// collect them (cash vs upi). `deliveries.cod_collected` (and a settlement's
// total_amount) is a method-agnostic running total — the real per-collection
// method lives on `delivery_collections`. Settlement register-crediting must
// only add the cash portion to the cash drawer (expected_cash/total_cash_sales);
// a UPI collection never touched cash.
//
// `expectedTotal` is the amount the caller believes was collected across these
// deliveries (sum of cod_collected, or a settlement's total_amount). There's no
// DB constraint tying delivery_collections rows to that total, and no CHECK on
// `method` beyond what this app's own validator writes — so if a row is ever
// missing (data-integrity drift, e.g. a manual DB fix) or carries a method this
// app doesn't recognize, the unaccounted amount is folded into cash rather than
// silently dropped from the register. This matches the pre-existing assume-cash
// default and is logged so the drift stays visible instead of silent.
function sumCollectionsByMethod(db, deliveryIds, expectedTotal) {
  const totals = { cash: 0, upi: 0 };
  let recognizedTotal = 0;
  if (deliveryIds && deliveryIds.length > 0) {
    const placeholders = deliveryIds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT method, COALESCE(SUM(amount), 0) as total FROM delivery_collections WHERE delivery_id IN (${placeholders}) GROUP BY method`
    ).all(...deliveryIds);
    for (const row of rows) {
      const amount = Number(row.total) || 0;
      if (row.method === 'upi') totals.upi += amount;
      else totals.cash += amount; // 'cash' and any unrecognized/legacy method both fold into cash
      recognizedTotal += amount;
    }
  }
  const unaccounted = (Number(expectedTotal) || 0) - recognizedTotal;
  if (unaccounted > 0.01) {
    console.warn(
      `[settlements] delivery_collections under-account for ${unaccounted.toFixed(2)} across delivery ids [${(deliveryIds || []).join(',')}] — crediting the gap to cash so no settled money is dropped from the register.`
    );
    totals.cash += unaccounted;
  }
  return totals;
}

module.exports = { sumCollectionsByMethod };
