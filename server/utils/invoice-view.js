/* Everything a printed bill shows, built from stored figures (2026-11-05).
 * GST sales (bill_version 2) at a shop with a GSTIN print as a TAX INVOICE
 * with the per-line split saved when the sale was made; everything else
 * prints as a plain BILL with the figures it already has. Nothing here is
 * recalculated, so a reprint always matches the saved sale.
 *
 * Owner bill settings: bill_legal_name, bill_pan, bill_terms, receipt_footer,
 * gst_delivery_sac, bill_show_fields (JSON, every key defaults to true):
 *   customer_phone, order_number, ship_to, payments, words, gst_table
 */
const { amountInWords, shareOut, splitInclusive, toPaise } = require('./gst');

const SHOW_KEYS = ['customer_phone', 'order_number', 'ship_to', 'payments', 'words', 'gst_table'];
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function readBillSettings(db) {
  const keys = ['shop_name', 'bill_legal_name', 'bill_pan', 'bill_terms', 'receipt_footer', 'gst_delivery_sac', 'bill_show_fields'];
  const rows = await db.prepare(`SELECT key, value FROM settings WHERE key IN (${keys.map(() => '?').join(', ')})`).all(...keys);
  const m = {};
  for (const r of rows) m[r.key] = r.value;
  let show = {};
  try { show = JSON.parse(m.bill_show_fields || '{}') || {}; } catch (e) { show = {}; }
  const showFields = {};
  for (const k of SHOW_KEYS) showFields[k] = show[k] !== false;
  return {
    shopName: m.shop_name || 'Flower Point',
    legalName: m.bill_legal_name || '',
    pan: m.bill_pan || '',
    terms: m.bill_terms || '',
    footer: m.receipt_footer || '',
    deliverySac: m.gst_delivery_sac || '9968',
    show: showFields,
  };
}

async function buildInvoiceView(db, saleId) {
  const sale = await db.prepare(`
    SELECT s.*, l.name AS loc_name, l.address AS loc_address, l.city AS loc_city, l.state AS loc_state,
           l.pincode AS loc_pincode, l.phone AS loc_phone, l.gst_number AS loc_gstin, l.state_code AS loc_state_code,
           l.fssai_number AS loc_fssai
    FROM sales s LEFT JOIN locations l ON l.id = s.location_id WHERE s.id = ?
  `).get(saleId);
  if (!sale) return null;
  const items = await db.prepare('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id').all(saleId);
  const payments = await db.prepare('SELECT method, amount, reference_number FROM payments WHERE sale_id = ? ORDER BY id').all(saleId);
  const cfg = await readBillSettings(db);

  const gstin = String(sale.loc_gstin || '').trim().toUpperCase();
  const isGst = Number(sale.bill_version) === 2;
  const kind = isGst && gstin ? 'tax_invoice' : 'bill';
  const stateCode = sale.loc_state_code || (/^\d{2}/.test(gstin) ? gstin.slice(0, 2) : '');

  const lines = items.map((it) => {
    const qty = Number(it.quantity) || 0;
    const amount = isGst && it.gross_amount != null ? r2(it.gross_amount) : r2((Number(it.unit_price) || 0) * qty + (Number(it.tax_amount) || 0));
    return {
      name: it.product_name || 'Item',
      qty,
      rate: qty > 0 ? r2(amount / qty) : 0,
      amount,
      hsn: it.hsn_code || '',
      gst_rate: Number(it.tax_rate) || 0,
      discount: r2(it.discount_amount),
      taxable: isGst ? r2(it.taxable_value) : null,
      cgst: isGst ? r2(it.cgst_amount) : null,
      sgst: isGst ? r2(it.sgst_amount) : null,
    };
  });

  const deliveryAmt = r2(sale.delivery_charges);
  let deliveryLine = null;
  if (deliveryAmt > 0) {
    const dTax = r2(sale.delivery_tax);
    const dCgst = Math.round(dTax * 100 / 2) / 100;
    deliveryLine = {
      name: 'Delivery',
      qty: 1,
      rate: deliveryAmt,
      amount: deliveryAmt,
      hsn: cfg.deliverySac,
      gst_rate: isGst ? Number(sale.delivery_tax_rate) || 0 : 0,
      discount: 0,
      taxable: isGst ? r2(deliveryAmt - dTax) : null,
      cgst: isGst ? dCgst : null,
      sgst: isGst ? r2(dTax - dCgst) : null,
    };
  }

  // Rate-wise GST summary from the saved lines (and delivery)
  let taxByRate = [];
  if (isGst) {
    const by = {};
    for (const l of [...lines, ...(deliveryLine ? [deliveryLine] : [])]) {
      const k = String(l.gst_rate);
      if (!by[k]) by[k] = { rate: l.gst_rate, taxable: 0, cgst: 0, sgst: 0 };
      by[k].taxable = r2(by[k].taxable + l.taxable);
      by[k].cgst = r2(by[k].cgst + l.cgst);
      by[k].sgst = r2(by[k].sgst + l.sgst);
    }
    taxByRate = Object.values(by).sort((a, b) => a.rate - b.rate).map((r) => ({ ...r, total: r2(r.cgst + r.sgst) }));
  }
  const sumOf = (k) => r2(taxByRate.reduce((t, r) => t + r[k], 0));

  const itemsTotal = r2(lines.reduce((t, l) => t + l.amount, 0));
  const paid = r2(payments.reduce((t, p) => t + (Number(p.amount) || 0), 0));
  const total = r2(sale.grand_total);
  const isDelivery = sale.order_type === 'delivery' || (sale.order_type === 'pre_order' && sale.delivery_address);
  const billToName = (isDelivery && sale.sender_name) || sale.customer_name || '';
  const billToPhone = (isDelivery && sale.sender_phone) || sale.customer_phone || '';

  return {
    kind,
    title: kind === 'tax_invoice' ? 'TAX INVOICE' : 'BILL',
    seller: {
      name: cfg.shopName,
      legal_name: cfg.legalName,
      branch: sale.loc_name || '',
      address: [sale.loc_address, sale.loc_city, sale.loc_pincode].filter(Boolean).join(', '),
      phone: sale.loc_phone || '',
      gstin,
      fssai: sale.loc_fssai || '',
      pan: cfg.pan,
      state: sale.loc_state || '',
      state_code: stateCode,
    },
    invoice_number: sale.invoice_number || '',
    order_number: cfg.show.order_number ? sale.sale_number : '',
    date: sale.created_at,
    place_of_supply: kind === 'tax_invoice' ? [sale.loc_state, stateCode ? `(${stateCode})` : ''].filter(Boolean).join(' ') : '',
    bill_to: billToName || billToPhone ? { name: billToName, phone: cfg.show.customer_phone ? billToPhone : '' } : null,
    buyer_gstin: sale.buyer_gstin || '',
    buyer_legal_name: sale.buyer_legal_name || '',
    ship_to: cfg.show.ship_to && isDelivery && sale.delivery_address
      ? { name: sale.receiver_name || '', phone: cfg.show.customer_phone ? (sale.receiver_phone || '') : '', address: sale.delivery_address }
      : null,
    lines,
    delivery: deliveryLine,
    totals: {
      items: itemsTotal,
      discount: r2(sale.discount_amount),
      discount_label: sale.discount_type === 'percentage' && Number(sale.discount_percentage) > 0 ? `${Number(sale.discount_percentage)}%` : '',
      delivery: deliveryAmt,
      round_off: r2(sale.round_off),
      // Older bills: GST was added on top, so show it as its own line
      tax_added: isGst ? 0 : r2(sale.tax_total),
      total,
    },
    words: cfg.show.words ? amountInWords(total) : '',
    tax_by_rate: cfg.show.gst_table ? taxByRate : [],
    tax_totals: isGst ? { taxable: sumOf('taxable'), cgst: sumOf('cgst'), sgst: sumOf('sgst'), total: sumOf('total') } : null,
    prices_include_gst: isGst,
    payments: cfg.show.payments ? payments.map((p) => ({ method: p.method, amount: r2(p.amount) })) : [],
    paid,
    due: r2(Math.max(0, total - paid)),
    cancelled: sale.status === 'cancelled',
    terms: cfg.terms,
    footer: cfg.footer,
  };
}

// Credit note for the sale's refund. The refunded amount is shared over the
// original bill's GST rates by value (the same way the bill was split), and
// each share is split into taxable value, CGST and SGST.
async function buildCreditNoteView(db, saleId) {
  const refund = await db.prepare('SELECT * FROM refunds WHERE sale_id = ? ORDER BY id LIMIT 1').get(saleId);
  if (!refund) return null;
  const bill = await buildInvoiceView(db, saleId);
  if (!bill) return null;
  const refundP = toPaise(refund.amount);
  const isTax = bill.kind === 'tax_invoice' && !!refund.credit_note_number;
  let taxByRate = [];
  if (isTax) {
    const rates = bill.tax_by_rate.length ? bill.tax_by_rate : [];
    const parts = shareOut(refundP, rates.map((r) => toPaise(r.taxable) + toPaise(r.cgst) + toPaise(r.sgst)));
    taxByRate = rates.map((r, i) => {
      const sp = splitInclusive(parts[i], r.rate);
      return { rate: r.rate, taxable: sp.taxableP / 100, cgst: sp.cgstP / 100, sgst: sp.sgstP / 100, total: sp.taxP / 100 };
    });
  }
  const sum = (k) => Math.round(taxByRate.reduce((t, r) => t + toPaise(r[k]), 0)) / 100;
  return {
    kind: isTax ? 'credit_note' : 'refund_receipt',
    title: isTax ? 'CREDIT NOTE' : 'REFUND RECEIPT',
    seller: bill.seller,
    credit_note_number: refund.credit_note_number || '',
    date: refund.created_at,
    against_invoice: bill.invoice_number,
    against_order: bill.order_number,
    against_date: bill.date,
    place_of_supply: bill.place_of_supply,
    bill_to: bill.bill_to,
    buyer_gstin: bill.buyer_gstin,
    buyer_legal_name: bill.buyer_legal_name,
    reason: refund.reason || '',
    method: refund.refund_method,
    amount: refundP / 100,
    words: amountInWords(refundP / 100),
    tax_by_rate: taxByRate,
    tax_totals: isTax ? { taxable: sum('taxable'), cgst: sum('cgst'), sgst: sum('sgst'), total: sum('total') } : null,
    footer: bill.footer,
  };
}

module.exports = { buildInvoiceView, buildCreditNoteView, readBillSettings, SHOW_KEYS };
