require('dotenv').config();
const { getDb } = require('./config/database-async');

// One-time backfill for deliveries orphaned by a bug in PUT /sales/:id/cancel
// (server/routes/sales.js): cancelling a sale never touched its deliveries
// row when that delivery was merely 'pending' or 'failed' (the "active
// delivery" guard only ever blocked/warned for assigned/picked_up/in_transit).
// That left the deliveries row stuck in 'pending'/'failed' forever, decoupled
// from the fact its sale is now cancelled — still showing up in
// DeliveriesScreen, and still assignable to a real rider via
// DeliveryDetailScreen's "Assign Partner" button.
//
// The route itself is now fixed to cascade this on every future cancel; this
// script is only for deliveries that were already orphaned before that fix
// existed. Safe to run more than once — the WHERE clause only ever matches
// rows still sitting in 'pending'/'failed', so a second run naturally finds
// (and touches) nothing.

async function runFix() {
  console.log('--- Starting Orphaned Cancelled-Sale Deliveries Backfill ---');
  try {
    const db = await getDb();

    const orphaned = await db.prepare(`
      SELECT d.id AS delivery_id, d.sale_id, s.sale_number, d.status AS delivery_status
      FROM deliveries d
      JOIN sales s ON d.sale_id = s.id
      WHERE d.status IN ('pending', 'failed') AND s.status = 'cancelled'
      ORDER BY d.id ASC
    `).all();

    console.log(`Found ${orphaned.length} orphaned deliveries row(s) (delivery status pending/failed, sale already cancelled):`);
    for (const row of orphaned) {
      console.log(`  delivery id=${row.delivery_id}  sale id=${row.sale_id}  sale_number=${row.sale_number || '(none)'}  current delivery status='${row.delivery_status}'`);
    }

    if (orphaned.length === 0) {
      console.log('Nothing to fix.');
      console.log('--- Done ---');
      return;
    }

    let fixedCount = 0;
    for (const row of orphaned) {
      await db.prepare(`
        UPDATE deliveries SET status = 'cancelled', failure_reason = 'Order cancelled', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(row.delivery_id);
      fixedCount += 1;
    }

    console.log(`Fixed ${fixedCount} delivery row(s) — set status='cancelled', failure_reason='Order cancelled'.`);
    console.log('--- Done ---');
  } catch (err) {
    console.error('Error during backfill:', err);
  } finally {
    process.exit(0);
  }
}

runFix();
