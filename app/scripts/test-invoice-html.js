// Plain-node tests for src/utils/invoiceHtml.js. Run: node scripts/test-invoice-html.js
const assert = require('assert');
const path = require('path');
const Module = require('module');
const babel = require('@babel/core');

function loadModule(file) {
  const { code } = babel.transformFileSync(file, { presets: ['babel-preset-expo'], babelrc: false, configFile: false });
  const m = new Module(file, module);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(code, file);
  return m.exports;
}
const inv = loadModule(path.join(__dirname, '../src/utils/invoiceHtml.js'));
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// Shape of GET /api/sales/:id/invoice
const taxView = () => ({
  kind: 'tax_invoice', title: 'TAX INVOICE',
  seller: { name: 'Flower Point', legal_name: 'E2E Flowers Pvt Ltd', address: 'Test Addr', phone: '98140 00000', gstin: '03ABCDE1234F1Z5', pan: 'ABCDE1234F', fssai: '' },
  invoice_number: 'INV4/2627/5807', order_number: 'INV-TEST-065', date: '2026-11-15T17:02:46.902Z',
  place_of_supply: 'Punjab (03)', bill_to: { name: 'Day Test', phone: '9998887777' },
  buyer_gstin: '03XYZ', buyer_legal_name: 'Buyer Co',
  ship_to: { name: 'Day Test', phone: '9998887777', address: '12 Test Lane' },
  lines: [
    { name: 'Rose <b>bunch</b>', qty: 2, rate: 250, amount: 500, hsn: '0603', gst_rate: 5, discount: 10, taxable: 466.67, cgst: 11.67, sgst: 11.66 },
    { name: 'Card', qty: 1, rate: 50, amount: 50, hsn: '', gst_rate: 0, discount: 0, taxable: 50, cgst: 0, sgst: 0 },
  ],
  delivery: { name: 'Delivery', qty: 1, rate: 100, amount: 100, hsn: '9965', gst_rate: 18, discount: 0, taxable: 84.75, cgst: 7.63, sgst: 7.62 },
  totals: { items: 550, discount: 10, discount_label: 'Regular', delivery: 100, round_off: 0.5, tax_added: 0, total: 640.5 },
  words: 'Rupees Six Hundred Forty and Fifty Paise Only',
  tax_by_rate: [{ rate: 0, taxable: 50, cgst: 0, sgst: 0, total: 0 }, { rate: 5, taxable: 466.67, cgst: 11.67, sgst: 11.66, total: 23.33 }],
  tax_totals: { taxable: 601.42, cgst: 19.3, sgst: 19.28, total: 38.58 },
  payments: [{ method: 'cash', amount: 300 }, { method: 'upi', amount: 200 }],
  paid: 500, due: 140.5, cancelled: false, terms: 'No returns on fresh flowers', footer: 'Thank you!',
});
const billView = () => ({ ...taxView(), kind: 'bill', title: 'BILL', delivery: null, tax_by_rate: [], tax_totals: null, buyer_gstin: '', due: 0 });

test('receipt: bigger, bold text so a thermal printer prints it dark', () => {
  const h = inv.buildInvoiceHtml(taxView());
  assert(/body \{[^}]*font-size: 13px/.test(h), 'body 13px');
  assert(/body \{[^}]*font-weight: bold/.test(h), 'body bold');
  assert(/\.row\.big \{[^}]*font-size: 17px/.test(h), 'total 17px');
  assert(/@page \{ size: 80mm auto/.test(h), 'still the 80 mm roll');
});
test('receipt: credit note gets the same darker text', () => {
  const h = inv.buildCreditNoteHtml({ kind: 'credit_note', title: 'CREDIT NOTE', seller: {}, amount: 10, method: 'cash', words: 'Ten' });
  assert(/body \{[^}]*font-size: 13px/.test(h) && /body \{[^}]*font-weight: bold/.test(h));
});
test('A4: page is A4 and carries the bill number, date, order and both addresses', () => {
  const h = inv.buildInvoiceA4Html(taxView());
  assert(/@page \{ size: A4/.test(h), 'A4 page');
  for (const s of ['TAX INVOICE', 'INV4/2627/5807', 'INV-TEST-065', 'Punjab (03)', 'Day Test', '9998887777', '12 Test Lane', '03XYZ', 'Buyer Co', 'GSTIN 03ABCDE1234F1Z5', 'E2E Flowers Pvt Ltd']) {
    assert(h.includes(s), 'missing ' + s);
  }
});
test('A4: one table row per item plus delivery, with HSN, GST %, qty, rate and amount; names escaped', () => {
  const h = inv.buildInvoiceA4Html(taxView());
  assert(h.includes('Rose &lt;b&gt;bunch&lt;/b&gt;') && !h.includes('<b>bunch'), 'escaped');
  assert((h.match(/<tr class="ln">/g) || []).length === 3, 'three item rows');
  for (const s of ['0603', '5%', '250.00', '500.00', '9965', '18%', '466.67', '11.67']) assert(h.includes(s), 'missing ' + s);
});
test('A4: totals, words, GST summary, payments, balance due, terms and footer', () => {
  const h = inv.buildInvoiceA4Html(taxView());
  for (const s of ['640.50', 'Rupees Six Hundred Forty and Fifty Paise Only', 'Discount (Regular)', '-10.00', 'Round off', '+0.50',
    '601.42', '38.58', 'Paid: Cash', 'Paid: UPI', 'Balance due', '140.50', 'No returns on fresh flowers', 'Thank you!', 'Reverse charge: No']) {
    assert(h.includes(s), 'missing ' + s);
  }
});
test('A4: a plain bill has no HSN/GST columns or GST summary, and no balance line when paid', () => {
  const h = inv.buildInvoiceA4Html(billView());
  assert(!h.includes('HSN') && !h.includes('CGST') && !h.includes('Reverse charge'), 'no GST parts');
  assert(!h.includes('Balance due'), 'no balance');
  assert((h.match(/<tr class="ln">/g) || []).length === 2, 'two item rows');
});
test('A4: a cancelled bill says so; a written-off amount is not called a payment', () => {
  const v = { ...taxView(), cancelled: true, payments: [{ method: 'write_off', amount: 140.5 }] };
  const h = inv.buildInvoiceA4Html(v);
  assert(h.includes('CANCELLED'), 'cancelled');
  assert(h.includes('Written off') && !h.includes('Paid: write_off'), 'write off');
});

let failed = 0;
for (const t of tests) {
  try { t.fn(); console.log('  ok   ' + t.name); } catch (err) { failed++; console.log('  FAIL ' + t.name + '\n       ' + err.message); }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
