/* Recomputes a GST (bill_version 2) sale after an edit (2026-11-05).
 * Older sales (bill_version NULL) keep their own maths in the routes; this
 * module only ever touches version 2 sales. Run inside withMoneyTx.
 *
 * planBill  -> works out the new bill, writes nothing (so a caller can refuse)
 * writeBill -> saves it on the sale and its lines
 */
const { computeBill } = require('./gst');
const { readGstSettings } = require('./gst-settings');

const paise = (n) => Math.round((Number(n) || 0) * 100);

// overrides: Map(saleItemId -> { quantity?, shelf_price?, unit_price? })
//   shelf_price includes GST; unit_price (older app) is without GST.
// deliveryCharges: new delivery amount (includes GST), or undefined to keep.
async function planBill(db, saleId, { overrides = new Map(), deliveryCharges } = {}) {
  const sale = await db.prepare(
    'SELECT id, bill_version, entry_mode, client_ref, discount_type, discount_percentage, discount_amount, delivery_charges, delivery_tax_rate FROM sales WHERE id = ?'
  ).get(saleId);
  if (!sale || Number(sale.bill_version) !== 2) return null;
  const items = await db.prepare('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id').all(saleId);
  const cfg = await readGstSettings(db);

  const rows = items.map((it) => {
    const o = overrides.get(Number(it.id)) || {};
    const qty = o.quantity != null ? Number(o.quantity) : Number(it.quantity);
    const rate = Number(it.tax_rate) || 0;
    const oldQty = Number(it.quantity) || 1;
    let shelf = paise(it.gross_amount) / oldQty / 100;
    if (o.shelf_price != null) shelf = Number(o.shelf_price);
    else if (o.unit_price != null) shelf = Math.round(Number(o.unit_price) * (100 + rate)) / 100;
    return { item: it, qty, rate, shelf: Math.round(shelf * 100) / 100 };
  });

  let discount = null;
  if (sale.discount_type === 'percentage' && Number(sale.discount_percentage) > 0) {
    discount = { type: 'percentage', value: Number(sale.discount_percentage) };
  } else if (sale.discount_type && Number(sale.discount_amount) > 0) {
    discount = { type: 'fixed', value: Number(sale.discount_amount) };
  }
  const delivery = deliveryCharges !== undefined ? Number(deliveryCharges) || 0 : Number(sale.delivery_charges) || 0;
  const deliveryRate = sale.delivery_tax_rate != null ? Number(sale.delivery_tax_rate) : cfg.deliveryRate;

  const bill = computeBill(
    rows.map((r) => ({ unitPrice: r.shelf, qty: r.qty, taxRate: r.rate })),
    discount,
    { amount: delivery, taxRate: deliveryRate },
    { roundOff: cfg.roundOff && !sale.entry_mode && !sale.client_ref }
  );
  if (bill.error) {
    const e = new Error(bill.error === "The discount can't be more than the price."
      ? "The discount on this order would be more than the items. Lower the discount first, or keep the items."
      : bill.error);
    e.statusCode = 400;
    throw e;
  }
  return { sale, rows, bill, grandTotal: bill.payableP / 100 };
}

async function writeBill(db, plan) {
  const { sale, rows, bill } = plan;
  for (let i = 0; i < rows.length; i += 1) {
    const l = bill.lines[i];
    await db.prepare(`
      UPDATE sale_items SET quantity = ?, unit_price = ?, tax_amount = ?, gross_amount = ?, discount_amount = ?,
        taxable_value = ?, cgst_amount = ?, sgst_amount = ? WHERE id = ?
    `).run(rows[i].qty, Math.round(l.unitTaxable * 100) / 100, l.taxP / 100, l.grossP / 100, l.discountP / 100,
      l.taxableP / 100, l.cgstP / 100, l.sgstP / 100, rows[i].item.id);
  }
  const itemsTaxableP = bill.lines.reduce((t, l) => t + l.taxableP, 0);
  const itemsTaxP = bill.lines.reduce((t, l) => t + l.taxP, 0);
  await db.prepare(`
    UPDATE sales SET subtotal = ?, tax_total = ?, discount_amount = ?, delivery_charges = ?, delivery_tax = ?,
      delivery_tax_rate = ?, round_off = ?, taxable_total = ?, cgst_total = ?, sgst_total = ?, grand_total = ?,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run((itemsTaxableP + bill.discountP) / 100, itemsTaxP / 100, bill.discountP / 100, bill.delivery.amountP / 100,
    bill.delivery.taxP / 100, bill.delivery.amountP > 0 ? bill.delivery.taxRate : null, bill.roundOffP / 100,
    bill.taxableP / 100, bill.cgstP / 100, bill.sgstP / 100, bill.payableP / 100, sale.id);
  return bill.payableP / 100;
}

module.exports = { planBill, writeBill };
