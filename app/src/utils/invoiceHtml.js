// 80 mm thermal roll bill (2026-11-05, layout chosen by the owner: two lines
// per item). Text is 13 px and bold (2026-11-15, owner asked for bigger,
// darker print); the GST rate table stays 11 px so its five columns fit.
// buildInvoiceA4Html below is the same bill on a full A4 page. Built from GET /api/sales/:id/invoice, which carries the figures
// exactly as saved, so a reprint always matches the sale. Pure: no React.

const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const money = (n) => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
const METHOD = { cash: 'Cash', upi: 'UPI', card: 'Card', bank_transfer: 'Bank', credit: 'Credit' };
// A write-off is money let go, never a payment: it gets its own line and the
// bill above it stays exactly as issued.
const payLine = (p) => (p.method === 'write_off' ? 'Written off' : `Paid: ${METHOD[p.method] || p.method}`);

function formatWhen(value) {
  const d = value instanceof Date ? value : (value ? new Date(String(value).replace(' ', 'T')) : null);
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
    (v.payments || []).length ? `<div class="gap"></div>${v.payments.map((p) => row(esc(payLine(p)), money(p.amount))).join('')}` : '',
    v.due > 0.009 ? row('BALANCE DUE', money(v.due), 'b') : '',
    v.terms ? `<div class="gap"></div><div class="small">${esc(v.terms)}</div>` : '',
    v.footer ? `<div class="c gap">${esc(v.footer)}</div>` : '',
  ].join('');

  return `<html><head><meta charset="utf-8"><title>${esc(v.invoice_number || 'Bill')}</title><style>
    @page { size: 80mm auto; margin: 0; }
    * { box-sizing: border-box; }
    body { width: 72mm; margin: 0 auto; padding: 3mm 0; font-family: 'Courier New', monospace; font-size: 13px; font-weight: bold; line-height: 1.35; color: #000; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .shop { text-align: center; font-size: 18px; font-weight: bold; }
    .c { text-align: center; } .b { font-weight: bold; } .small { font-size: 11.5px; }
    .title { text-align: center; font-weight: bold; font-size: 15px; margin: 2mm 0 1mm; }
    .row { display: flex; justify-content: space-between; gap: 2mm; }
    .row.big { font-size: 17px; font-weight: bold; }
    .item { display: flex; gap: 1mm; margin-top: 1mm; }
    .item .nm { flex: 1; overflow-wrap: anywhere; } .item .q { width: 8mm; text-align: right; }
    .item .r { width: 16mm; text-align: right; } .item .a { width: 19mm; text-align: right; }
    .item.hd { font-weight: bold; margin-top: 0; }
    .sub { padding-left: 2mm; font-size: 11.5px; }
    .gt { display: flex; font-size: 11px; } .gt span { flex: 1; text-align: right; } .gt span:first-child { flex: 0.6; text-align: left; }
    .gt.hd { font-weight: bold; } .gt.b { font-weight: bold; }
    .dash { border-top: 2px dashed #000; margin: 1.5mm 0; } .dbl { border-top: 2px solid #000; margin: 1.5mm 0; }
    .gap { margin-top: 2mm; }
  </style></head><body>
    ${head}<div class="dash"></div>${meta}<div class="dash"></div>${items}<div class="dash"></div>${totals}${gstTable}${tail}
  </body></html>`;
}

// Full-page A4 bill: the same figures as the roll bill, laid out as a table
// for printing on paper or saving as a PDF to send to a customer.
export function buildInvoiceA4Html(v) {
  const isTax = v.kind === 'tax_invoice';
  const s = v.seller || {};
  const t = v.totals || {};
  const ids = [
    s.gstin ? `GSTIN ${esc(s.gstin)}` : '',
    s.pan ? `PAN ${esc(s.pan)}` : '',
    s.fssai ? `FSSAI ${esc(s.fssai)}` : '',
  ].filter(Boolean).join('&nbsp;&nbsp;·&nbsp;&nbsp;');
  const seller = [
    `<div class="shop">${esc(s.name)}</div>`,
    s.legal_name ? `<div>${esc(s.legal_name)}</div>` : '',
    s.address ? `<div>${esc(s.address)}</div>` : '',
    s.phone ? `<div>Phone ${esc(s.phone)}</div>` : '',
    ids ? `<div class="b">${ids}</div>` : '',
  ].join('');
  const kv = (k, val) => (val ? `<tr><td class="k">${k}</td><td>${val}</td></tr>` : '');
  const meta = `<table class="meta">${[
    kv('Bill No', esc(v.invoice_number)),
    kv('Date', formatWhen(v.date)),
    kv('Order', esc(v.order_number)),
    kv('Place of supply', esc(v.place_of_supply)),
  ].join('')}</table>`;
  const party = (label, lines) => (lines.filter(Boolean).length
    ? `<div class="party"><div class="lbl">${label}</div>${lines.filter(Boolean).map((x) => `<div>${x}</div>`).join('')}</div>` : '');
  const parties = [
    v.bill_to ? party('Bill to', [
      `<span class="b">${esc(v.bill_to.name)}</span>`,
      v.bill_to.phone ? esc(v.bill_to.phone) : '',
      v.buyer_gstin ? `GSTIN ${esc(v.buyer_gstin)}${v.buyer_legal_name ? ` · ${esc(v.buyer_legal_name)}` : ''}` : '',
    ]) : '',
    v.ship_to ? party('Ship to', [
      `<span class="b">${esc(v.ship_to.name)}</span>`,
      v.ship_to.phone ? esc(v.ship_to.phone) : '',
      v.ship_to.address ? esc(v.ship_to.address) : '',
    ]) : '',
  ].join('');

  const head = isTax
    ? '<tr><th class="n">#</th><th>Item</th><th>HSN</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Disc</th><th class="r">GST</th><th class="r">Taxable</th><th class="r">CGST</th><th class="r">SGST</th><th class="r">Amount</th></tr>'
    : '<tr><th class="n">#</th><th>Item</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Amount</th></tr>';
  const lines = [...(v.lines || []), ...(v.delivery && isTax ? [v.delivery] : [])];
  const body = lines.map((l, i) => (isTax
    ? `<tr class="ln"><td class="n">${i + 1}</td><td>${esc(l.name)}</td><td>${esc(l.hsn || '')}</td><td class="r">${esc(l.qty)}</td><td class="r">${money(l.rate)}</td><td class="r">${l.discount > 0 ? money(l.discount) : ''}</td><td class="r">${esc(l.gst_rate)}%</td><td class="r">${money(l.taxable)}</td><td class="r">${money(l.cgst)}</td><td class="r">${money(l.sgst)}</td><td class="r">${money(l.amount)}</td></tr>`
    : `<tr class="ln"><td class="n">${i + 1}</td><td>${esc(l.name)}</td><td class="r">${esc(l.qty)}</td><td class="r">${money(l.rate)}</td><td class="r">${money(l.amount)}</td></tr>`)).join('');

  const tr = (k, val, cls = '') => `<tr class="${cls}"><td>${k}</td><td class="r">${val}</td></tr>`;
  const totals = `<table class="tot">${[
    tr('Items', money(t.items)),
    t.tax_added > 0 ? tr('Tax', money(t.tax_added)) : '',
    t.discount > 0 ? tr(`Discount${t.discount_label ? ` (${esc(t.discount_label)})` : ''}`, `-${money(t.discount)}`) : '',
    t.delivery > 0 ? tr('Delivery', money(t.delivery)) : '',
    t.round_off ? tr('Round off', `${t.round_off > 0 ? '+' : '-'}${money(Math.abs(t.round_off))}`) : '',
    tr('Total', `₹ ${money(t.total)}`, 'grand'),
    ...(v.payments || []).map((p) => tr(esc(payLine(p)), money(p.amount))),
    v.due > 0.009 ? tr('Balance due', `₹ ${money(v.due)}`, 'due') : '',
  ].join('')}</table>`;

  let gst = '';
  if (isTax && (v.tax_by_rate || []).length) {
    const tt = v.tax_totals || {};
    gst = `<table class="grid gst"><tr><th>GST rate</th><th class="r">Taxable</th><th class="r">CGST</th><th class="r">SGST</th><th class="r">Total GST</th></tr>${
      v.tax_by_rate.map((r) => `<tr><td>${esc(r.rate)}%</td><td class="r">${money(r.taxable)}</td><td class="r">${money(r.cgst)}</td><td class="r">${money(r.sgst)}</td><td class="r">${money(r.total)}</td></tr>`).join('')
    }<tr class="b"><td>Total</td><td class="r">${money(tt.taxable)}</td><td class="r">${money(tt.cgst)}</td><td class="r">${money(tt.sgst)}</td><td class="r">${money(tt.total)}</td></tr></table>`;
  }

  return `<html><head><meta charset="utf-8"><title>${esc(v.invoice_number || 'Bill')}</title><style>
    @page { size: A4 portrait; margin: 14mm; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Arial, Helvetica, sans-serif; font-size: 13px; line-height: 1.4; color: #000; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .b { font-weight: bold; } .r { text-align: right; } .n { width: 8mm; }
    .top { display: flex; justify-content: space-between; gap: 10mm; border-bottom: 2px solid #000; padding-bottom: 4mm; }
    .shop { font-size: 24px; font-weight: bold; }
    .title { font-size: 22px; font-weight: bold; text-align: right; letter-spacing: 1px; }
    .cancel { color: #B71C1C; font-size: 16px; font-weight: bold; text-align: right; }
    table { border-collapse: collapse; }
    .meta td { padding: 1px 0 1px 4mm; } .meta td.k { color: #333; text-align: right; }
    .parties { display: flex; gap: 8mm; margin: 5mm 0; }
    .party { flex: 1; border: 1px solid #000; border-radius: 2mm; padding: 3mm; }
    .lbl { font-size: 11px; font-weight: bold; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 1mm; }
    .grid { width: 100%; }
    .grid th { background: #EEE; border: 1px solid #000; padding: 2mm; text-align: left; font-size: 12px; }
    .grid td { border: 1px solid #000; padding: 2mm; vertical-align: top; }
    .grid th.r, .grid td.r { text-align: right; }
    .bottom { display: flex; justify-content: space-between; gap: 8mm; margin-top: 5mm; }
    .left { flex: 1; } .tot { width: 75mm; } .tot td { padding: 1.2mm 0; }
    .tot tr.grand td { font-size: 17px; font-weight: bold; border-top: 2px solid #000; border-bottom: 2px solid #000; padding: 2mm 0; }
    .tot tr.due td { font-weight: bold; font-size: 15px; }
    .gst { margin-top: 4mm; } .small { font-size: 11px; } .words { font-weight: bold; margin-bottom: 3mm; }
    .foot { margin-top: 10mm; display: flex; justify-content: space-between; align-items: flex-end; }
    .sign { text-align: center; border-top: 1px solid #000; padding-top: 1mm; width: 60mm; }
  </style></head><body>
    <div class="top"><div>${seller}</div><div><div class="title">${esc(v.title)}</div>${v.cancelled ? '<div class="cancel">CANCELLED</div>' : ''}${meta}</div></div>
    ${parties ? `<div class="parties">${parties}</div>` : '<div style="height:5mm"></div>'}
    <table class="grid items">${head}${body}</table>
    <div class="bottom">
      <div class="left">
        ${v.words ? `<div class="words">${esc(v.words)}</div>` : ''}
        ${isTax ? '<div class="small">Prices include GST. Reverse charge: No</div>' : ''}
        ${gst}
        ${v.terms ? `<div class="small" style="margin-top:4mm"><span class="b">Terms:</span> ${esc(v.terms)}</div>` : ''}
      </div>
      ${totals}
    </div>
    <div class="foot"><div>${v.footer ? esc(v.footer) : ''}</div><div class="sign">For ${esc(s.legal_name || s.name)}</div></div>
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
    body { width: 72mm; margin: 0 auto; padding: 3mm 0; font-family: 'Courier New', monospace; font-size: 13px; font-weight: bold; line-height: 1.35; color: #000; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .shop { text-align: center; font-size: 18px; font-weight: bold; }
    .c { text-align: center; } .b { font-weight: bold; } .small { font-size: 11.5px; }
    .title { text-align: center; font-weight: bold; font-size: 15px; margin: 2mm 0 1mm; }
    .row { display: flex; justify-content: space-between; gap: 2mm; } .row.big { font-size: 17px; font-weight: bold; }
    .gt { display: flex; font-size: 11px; } .gt span { flex: 1; text-align: right; } .gt span:first-child { flex: 0.6; text-align: left; }
    .gt.hd, .gt.b { font-weight: bold; }
    .dash { border-top: 2px dashed #000; margin: 1.5mm 0; } .dbl { border-top: 2px solid #000; margin: 1.5mm 0; }
    .gap { margin-top: 2mm; }
  </style></head><body>
    ${head}<div class="dash"></div>${meta}<div class="dbl"></div>
    ${row(`Refunded (${esc(METHOD[v.method] || (v.method === 'store_credit' ? 'Store credit' : v.method))})`, `Rs ${money(v.amount)}`, 'big')}
    <div class="dbl"></div><div>${esc(v.words)}</div>${gst}
    ${isTax ? '<div class="small gap">GST shown is the part of the refund that was GST on the original bill.</div>' : ''}
    ${v.footer ? `<div class="c gap">${esc(v.footer)}</div>` : ''}
  </body></html>`;
}
