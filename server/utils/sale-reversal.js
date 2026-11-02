/**
 * Reverses the side effects of a sale: customer totals, open production
 * tasks, stock returned per item. Extracted unchanged from PUT /:id/cancel
 * so the quick-sale undo route can share it.
 *
 * Must be called inside the caller's db.transaction. Does NOT change
 * sales.status, deliveries or any cash register - callers own those.
 */
function reverseSaleEffects(db, sale, { paymentTotal, userId }) {
  // Revert customer total_spent/credit_balance. total_spent was bumped
  // by the full grand_total at creation regardless of payment status,
  // so it always reverses by grand_total. credit_balance is different:
  // it was only ever bumped by the UNPAID portion at creation (and
  // reduced as payments came in) — refunds never touch it (see
  // POST /:id/refund). So a sale that was paid in full then refunded
  // has $0 sitting in credit_balance for it; reversing by the full
  // grand_total there would wrongly wipe out real dues from other
  // orders. Reverse by grand_total minus whatever was actually paid.
  const duesCustomerId = (sale.order_type === 'delivery' && sale.sender_customer_id) ? sale.sender_customer_id : sale.customer_id;
  if (duesCustomerId) {
    const unpaidRemaining = Math.max(0, Number(sale.grand_total) - paymentTotal);
    db.prepare('UPDATE users SET total_spent = GREATEST(0, total_spent - ?), credit_balance = GREATEST(0, credit_balance - ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(sale.grand_total, unpaidRemaining, duesCustomerId);
  }

  // Cancel any pending/in-progress production tasks
  db.prepare("UPDATE production_tasks SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE sale_id = ? AND status NOT IN ('completed', 'cancelled')").run(sale.id);

  const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(sale.id);

  for (const item of items) {
    if (item.from_product_stock && item.product_id) {
      // Was fulfilled from product_stock → return to product_stock
      const existing = db.prepare('SELECT id FROM product_stock WHERE product_id = ? AND location_id = ?').get(item.product_id, sale.location_id);
      if (existing) {
        db.prepare('UPDATE product_stock SET quantity = quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(item.quantity, existing.id);
      } else {
        db.prepare('INSERT INTO product_stock (product_id, location_id, quantity) VALUES (?, ?, ?)').run(item.product_id, sale.location_id, item.quantity);
      }
    } else if (item.materials_deducted && item.product_id) {
      // Materials already consumed (production done) → add finished product to product_stock
      // Cannot restore raw materials — they're already used up
      const existing = db.prepare('SELECT id FROM product_stock WHERE product_id = ? AND location_id = ?').get(item.product_id, sale.location_id);
      if (existing) {
        db.prepare('UPDATE product_stock SET quantity = quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(item.quantity, existing.id);
      } else {
        db.prepare('INSERT INTO product_stock (product_id, location_id, quantity) VALUES (?, ?, ?)').run(item.product_id, sale.location_id, item.quantity);
      }
    } else if (item.materials_deducted && item.material_id) {
      // Raw material sale — restore material stock
      db.prepare('UPDATE material_stock SET quantity = quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE material_id = ? AND location_id = ?').run(item.quantity, item.material_id, sale.location_id);
      db.prepare(`INSERT INTO material_transactions (material_id, location_id, type, quantity, reference_type, reference_id, notes, created_by) VALUES (?, ?, 'return', ?, 'sale_cancel', ?, ?, ?)`)
        .run(item.material_id, sale.location_id, item.quantity, sale.id, `Cancel ${sale.sale_number}`, userId);
    }
    // If nothing was deducted yet (pending production), nothing to restore
  }

  db.prepare('UPDATE sales SET stock_deducted = 0 WHERE id = ?').run(sale.id);
}

module.exports = { reverseSaleEffects };
