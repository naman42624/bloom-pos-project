// 80 mm thermal roll bill (2026-11-05, layout chosen by the owner: two lines
// per item). Built from GET /api/sales/:id/invoice, which carries the figures
// exactly as saved, so a reprint always matches the sale. Pure: no React.

const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const money = (n) => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
const METHOD = { cash: 'Cash', upi: 'UPI', card: 'Card', bank_transfer: 'Bank', credit: 'Credit' };

function formatWhen(value) {
  const d = value ? new Date(String(value).replace(' ', 'T')) : null;
  if (!d || Number.isNaN(d.getTime())) return esc(value || '');
  const date = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  return `${esc(date)} ${esc(time)}`;
}

const row = (left, right, cls = '') => `<div class="row ${cls}"><span>${left}</span><span>${right}</span></div>`;

function lineBlock(l, isTax) {
  const top = `<div class="item"><span class="nm">${esc(l.name)}</span><span class="q">${esc(l.qty)}</span><span class="r">${money(l.rate)}</span><span class="a">${money(l.amount)}</span></div>`;
  if (!isTax) return top;
  const sub1 = [l.hsn ? `HSN ${esc(l.hsn)}` : '', `GST ${esc(l.gst_rate)}%`, l.discount > 0 ? `Disc -${money(l.discount)}` : ''].filter(Boolean).join('&nbsp;&nbsp;');
  const sub2 = `Taxable ${money(l.taxable)}&nbsp;&nbsp;CGST ${money(l.cgst)}&nbsp;&nbsp;SGST ${money(l.sgst)}`;
  return `${top}<div class="sub">${sub1}</div><div class="sub">${sub2}</div>`;
}

export function buildInvoiceHtml(v) {
  const isTax = v.kind === 'tax_invoice';
  const s = v.seller || {};
  const head = [
    `<div class="shop">${esc(s.name)}</div>`,
    s.legal_name ? `<div class="c">${esc(s.legal_name)}</div>` : '',
    s.address ? `<div class="c">${esc(s.address)}</div>` : '',
    s.phone ? `<div class="c">Ph ${esc(s.phone)}</div>` : '',
    s.gstin ? `<div class="c b">GSTIN ${esc(s.gstin)}</div>` : '',
    (s.fssai || s.pan) ? `<div class="c">${[s.fssai ? `FSSAI ${esc(s.fssai)}` : '', s.pan ? `PAN ${esc(s.pan)}` : ''].filter(Boolean).join('&nbsp;&nbsp;')}</div>` : '',
  ].join('');

  const meta = [
    `<div class="title">${esc(v.title)}${v.cancelled ? ' (CANCELLED)' : ''}</div>`,
    v.invoice_number ? row('Bill No', esc(v.invoice_number)) : '',
    row('Date', formatWhen(v.date)),
    v.order_number ? row('Order', esc(v.order_number)) : '',
    v.place_of_supply ? row('Place of supply', esc(v.place_of_supply)) : '',
    v.bill_to ? `<div>Bill to: ${esc(v.bill_to.name)}${v.bill_to.phone ? `&nbsp;&nbsp;${esc(v.bill_to.phone)}` : ''}</div>` : '',
    v.buyer_gstin ? `<div>Buyer GSTIN: ${esc(v.buyer_gstin)}${v.buyer_legal_name ? ` ${esc(v.buyer_legal_name)}` : ''}</div>` : '',
    v.ship_to ? `<div>Ship to: ${esc([v.ship_to.name, v.ship_to.phone, v.ship_to.address].filter(Boolean).join(', '))}</div>` : '',
  ].join('');

  const items = [
    '<div class="item hd"><span class="nm">Item</span><span class="q">Qty</span><span class="r">Rate</span><span class="a">Amount</span></div>',
    '<div class="dash"></div>',
    ...(v.lines || []).map((l) => lineBlock(l, isTax)),
    v.delivery && isTax ? lineBlock(v.delivery, true) : '',
  ].join('');

  const t = v.totals || {};
  const totals = [
    row('Items', money(t.items)),
    t.tax_added > 0 ? row('Tax', money(t.tax_added)) : '',
    t.discount > 0 ? row(`Discount${t.discount_label ? ` (${esc(t.discount_label)})` : ''}`, `-${money(t.discount)}`) : '',
    t.delivery > 0 ? row('Delivery', money(t.delivery)) : '',
    t.round_off ? row('Round off', `${t.round_off > 0 ? '+' : '-'}${money(Math.abs(t.round_off))}`) : '',
    '<div class="dbl"></div>',
    row('TOTAL', `Rs ${money(t.total)}`, 'big'),
    '<div class="dbl"></div>',
    v.words ? `<div>${esc(v.words)}</div>` : '',
  ].join('');

  let gstTable = '';
  if (isTax && (v.tax_by_rate || []).length) {
    const cell = (a, b, c, d, e, cls = '') => `<div class="gt ${cls}"><span>${a}</span><span>${b}</span><span>${c}</span><span>${d}</span><span>${e}</span></div>`;
    const tt = v.tax_totals || {};
    gstTable = [
      '<div class="gap"></div>',
      cell('GST', 'Taxable', 'CGST', 'SGST', 'Total', 'hd'),
      ...v.tax_by_rate.map((r) => cell(`${esc(r.rate)}%`, money(r.taxable), money(r.cgst), money(r.sgst), money(r.total))),
      '<div class="dash"></div>',
      cell('', money(tt.taxable), money(tt.cgst), money(tt.sgst), money(tt.total), 'b'),
    ].join('');
  }

  const tail = [
    isTax ? '<div class="small">Prices include GST. Reverse charge: No</div>' : '',
    (v.payments || []).length ? `<div class="gap"></div>${v.payments.map((p) => row(`Paid: ${esc(METHOD[p.method] || p.method)}`, money(p.amount))).join('')}` : '',
    v.due > 0.009 ? row('BALANCE DUE', money(v.due), 'b') : '',
    v.terms ? `<div class="gap"></div><div class="small">${esc(v.terms)}</div>` : '',
    v.footer ? `<div class="c gap">${esc(v.footer)}</div>` : '',
  ].join('');

  return `<html><head><meta charset="utf-8"><title>${esc(v.invoice_number || 'Bill')}</title><style>
    @page { size: 80mm auto; margin: 0; }
    * { box-sizing: border-box; }
    body { width: 72mm; margin: 0 auto; padding: 3mm 0; font-family: 'Courier New', monospace; font-size: 11px; line-height: 1.35; color: #000; }
    .shop { text-align: center; font-size: 15px; font-weight: bold; }
    .c { text-align: center; } .b { font-weight: bold; } .small { font-size: 10px; }
    .title { text-align: center; font-weight: bold; font-size: 13px; margin: 2mm 0 1mm; }
    .row { display: flex; justify-content: space-between; gap: 2mm; }
    .row.big { font-size: 14px; font-weight: bold; }
    .item { display: flex; gap: 1mm; margin-top: 1mm; }
    .item .nm { flex: 1; overflow-wrap: anywhere; } .item .q { width: 7mm; text-align: right; }
    .item .r { width: 15mm; text-align: right; } .item .a { width: 17mm; text-align: right; }
    .item.hd { font-weight: bold; margin-top: 0; }
    .sub { padding-left: 2mm; font-size: 10px; }
    .gt { display: flex; } .gt span { flex: 1; text-align: right; } .gt span:first-child { flex: 0.6; text-align: left; }
    .gt.hd { font-weight: bold; } .gt.b { font-weight: bold; }
    .dash { border-top: 1px dashed #000; margin: 1.5mm 0; } .dbl { border-top: 2px solid #000; margin: 1.5mm 0; }
    .gap { margin-top: 2mm; }
  </style></head><body>
    ${head}<div class="dash"></div>${meta}<div class="dash"></div>${items}<div class="dash"></div>${totals}${gstTable}${tail}
  </body></html>`;
}

// Credit note (GST bill refund) or refund receipt (plain bill), same roll.
export function buildCreditNoteHtml(v) {
  const isTax = v.kind === 'credit_note';
  const s = v.seller || {};
  const head = [
    `<div class="shop">${esc(s.name)}</div>`,
    s.legal_name ? `<div class="c">${esc(s.legal_name)}</div>` : '',
    s.address ? `<div class="c">${esc(s.address)}</div>` : '',
    s.gstin ? `<div class="c b">GSTIN ${esc(s.gstin)}</div>` : '',
  ].join('');
  const meta = [
    `<div class="title">${esc(v.title)}</div>`,
    v.credit_note_number ? row('Credit note No', esc(v.credit_note_number)) : '',
    row('Date', formatWhen(v.date)),
    v.against_invoice ? row('Against bill', esc(v.against_invoice)) : '',
    v.against_order ? row('Order', esc(v.against_order)) : '',
    v.against_date ? row('Bill date', formatWhen(v.against_date)) : '',
    v.place_of_supply ? row('Place of supply', esc(v.place_of_supply)) : '',
    v.bill_to ? `<div>Customer: ${esc(v.bill_to.name)}${v.bill_to.phone ? `&nbsp;&nbsp;${esc(v.bill_to.phone)}` : ''}</div>` : '',
    v.buyer_gstin ? `<div>Buyer GSTIN: ${esc(v.buyer_gstin)}${v.buyer_legal_name ? ` ${esc(v.buyer_legal_name)}` : ''}</div>` : '',
    v.reason ? `<div>Reason: ${esc(v.reason)}</div>` : '',
  ].join('');
  let gst = '';
  if (isTax && (v.tax_by_rate || []).length) {
    const cell = (a, b, c, d, e, cls = '') => `<div class="gt ${cls}"><span>${a}</span><span>${b}</span><span>${c}</span><span>${d}</span><span>${e}</span></div>`;
    const tt = v.tax_totals || {};
    gst = [
      '<div class="gap"></div>',
      cell('GST', 'Taxable', 'CGST', 'SGST', 'Total', 'hd'),
      ...v.tax_by_rate.map((r) => cell(`${esc(r.rate)}%`, money(r.taxable), money(r.cgst), money(r.sgst), money(r.total))),
      '<div class="dash"></div>',
      cell('', money(tt.taxable), money(tt.cgst), money(tt.sgst), money(tt.total), 'b'),
    ].join('');
  }
  return `<html><head><meta charset="utf-8"><title>${esc(v.credit_note_number || 'Refund')}</title><style>
    @page { size: 80mm auto; margin: 0; }
    * { box-sizing: border-box; }
    body { width: 72mm; margin: 0 auto; padding: 3mm 0; font-family: 'Courier New', monospace; font-size: 11px; line-height: 1.35; color: #000; }
    .shop { text-align: center; font-size: 15px; font-weight: bold; }
    .c { text-align: center; } .b { font-weight: bold; } .small { font-size: 10px; }
    .title { text-align: center; font-weight: bold; font-size: 13px; margin: 2mm 0 1mm; }
    .row { display: flex; justify-content: space-between; gap: 2mm; } .row.big { font-size: 14px; font-weight: bold; }
    .gt { display: flex; } .gt span { flex: 1; text-align: right; } .gt span:first-child { flex: 0.6; text-align: left; }
    .gt.hd, .gt.b { font-weight: bold; }
    .dash { border-top: 1px dashed #000; margin: 1.5mm 0; } .dbl { border-top: 2px solid #000; margin: 1.5mm 0; }
    .gap { margin-top: 2mm; }
  </style></head><body>
    ${head}<div class="dash"></div>${meta}<div class="dbl"></div>
    ${row(`Refunded (${esc(METHOD[v.method] || (v.method === 'store_credit' ? 'Store credit' : v.method))})`, `Rs ${money(v.amount)}`, 'big')}
    <div class="dbl"></div><div>${esc(v.words)}</div>${gst}
    ${isTax ? '<div class="small gap">GST shown is the part of the refund that was GST on the original bill.</div>' : ''}
    ${v.footer ? `<div class="c gap">${esc(v.footer)}</div>` : ''}
  </body></html>`;
}
