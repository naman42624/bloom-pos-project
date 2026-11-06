#!/usr/bin/env node
/**
 * GST sales (Phase 2, 2026-11-05). Local dev only, throwaway data at Test Loc.
 * Run against a server started from this checkout, with VERIFY_OWNER_PHONE /
 * VERIFY_OWNER_PASSWORD set.
 */
const h = require('./lib/verify-harness');
const { computeBill } = require('../utils/gst');
const { check, assert, getDb, api, loginOwner, openRegister, TEST_LOCATION_ID } = h;

const LOC = TEST_LOCATION_ID;
const createdSaleIds = [];
const createdProductIds = [];
const createdUserIds = [];
const createdRecurringIds = [];
let counterBefore = null;
let roundOffBefore = null;
let locBefore = null;

const P = (n) => Math.round(Number(n) * 100);

async function setSetting(key, value) {
  const db = await getDb();
  await db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(value, key);
}

async function taxedProduct(price, rateId, hsn) {
  const db = await getDb();
  const r = await db.prepare("INSERT INTO products (name, sku, selling_price, tax_rate_id, hsn_code, is_active) VALUES (?, ?, ?, ?, ?, 1)")
    .run(`GST test ${Date.now()}`, `GSTT-${Date.now()}-${createdProductIds.length}`, price, rateId, hsn);
  createdProductIds.push(r.lastInsertRowid);
  return r.lastInsertRowid;
}

async function newSale(token, body) {
  const res = await api('POST', '/sales', token, { location_id: LOC, order_type: 'walk_in', channel: 'walk_in', skip_assignment: true, ...body });
  if (res.body?.data?.id) createdSaleIds.push(res.body.data.id);
  return res;
}

async function saleRow(id) {
  const db = await getDb();
  const s = await db.prepare('SELECT * FROM sales WHERE id = ?').get(id);
  s.items = await db.prepare('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id').all(id);
  return s;
}

async function rateId(pct) {
  const db = await getDb();
  return (await db.prepare('SELECT id FROM tax_rates WHERE percentage = ? ORDER BY id LIMIT 1').get(pct)).id;
}

async function customer(ownerToken) {
  const db = await getDb();
  const phone = '7' + String(Date.now()).slice(-9);
  const r = await db.prepare("INSERT INTO users (name, phone, password, role, is_active) VALUES (?, ?, 'x', 'customer', 1)").run('GST test buyer', phone);
  createdUserIds.push(r.lastInsertRowid);
  return { id: r.lastInsertRowid, phone };
}

check('setup: remember the invoice counter and round-off setting', async () => {
  const db = await getDb();
  const c = await db.prepare("SELECT last_no, fy FROM invoice_counters WHERE series_key = ? ORDER BY fy DESC LIMIT 1").get(`invoice:loc:${LOC}`);
  counterBefore = c || null;
  roundOffBefore = (await db.prepare("SELECT value FROM settings WHERE key = 'bill_round_off'").get()).value;
});

check('a taxed, discounted sale stores exactly what utils/gst.js works out', async () => {
  const owner = await loginOwner();
  await openRegister(owner.token, LOC, 1000);
  const p5 = await taxedProduct(105, await rateId(5), '0603');
  const p18 = await taxedProduct(236, await rateId(18), '9619');
  const items = [{ product_id: p5, quantity: 2, unit_price: 105 }, { product_id: p18, quantity: 1, unit_price: 236 }];
  const want = computeBill([{ unitPrice: 105, qty: 2, taxRate: 5 }, { unitPrice: 236, qty: 1, taxRate: 18 }], { type: 'percentage', value: 10 }, { amount: 0, taxRate: 18 }, { roundOff: false });
  const r = await newSale(owner.token, { items, discount_type: 'percentage', discount_value: 10, payments: [{ method: 'cash', amount: want.payable }] });
  assert(r.status === 201, `${r.status} ${JSON.stringify(r.body)}`);
  const s = await saleRow(r.body.data.id);
  assert(Number(s.bill_version) === 2, `version ${s.bill_version}`);
  assert(P(s.grand_total) === want.payableP, `grand ${s.grand_total} want ${want.payable}`);
  assert(P(s.discount_amount) === want.discountP && P(s.taxable_total) === want.taxableP && P(s.cgst_total) === want.cgstP && P(s.sgst_total) === want.sgstP, JSON.stringify(s));
  // grand_total = subtotal - discount + tax + delivery + round_off, for reports
  assert(P(s.subtotal) - P(s.discount_amount) + P(s.tax_total) + P(s.delivery_charges) + P(s.round_off) === P(s.grand_total), 'identity');
  assert(s.items[0].hsn_code === '0603' && s.items[1].hsn_code === '9619', 'hsn');
  s.items.forEach((it, i) => {
    assert(P(it.taxable_value) === want.lines[i].taxableP && P(it.discount_amount) === want.lines[i].discountP && P(it.cgst_amount) + P(it.sgst_amount) === P(it.tax_amount), `line ${i} ${JSON.stringify(it)}`);
  });
  assert(s.payment_status === 'paid', s.payment_status);
  assert(/^[A-Z0-9]{1,5}\/\d{4}\/\d{4,}$/.test(s.invoice_number) && s.invoice_number.length <= 16, s.invoice_number);
});

check('an older app sending prices without GST gets the same bill', async () => {
  const owner = await loginOwner();
  const p5 = await taxedProduct(105, await rateId(5), null);
  const r = await newSale(owner.token, { items: [{ product_id: p5, quantity: 1, unit_price: 100, tax_rate: 5, tax_inclusive: false }], payments: [{ method: 'upi', amount: 105 }] });
  assert(r.status === 201, `${r.status} ${JSON.stringify(r.body)}`);
  const s = await saleRow(r.body.data.id);
  assert(P(s.grand_total) === 10500 && P(s.tax_total) === 500 && s.payment_status === 'paid', JSON.stringify({ g: s.grand_total, t: s.tax_total }));
});

check('invoice numbers run in order with no repeats, even for sales at the same moment', async () => {
  const owner = await loginOwner();
  const rs = await Promise.all([1, 2, 3, 4, 5].map((n) => newSale(owner.token, { items: [{ product_name: `GST same time ${n}`, quantity: 1, unit_price: 10, tax_rate: 0 }], payments: [{ method: 'upi', amount: 10 }] })));
  rs.forEach((r) => assert(r.status === 201, `${r.status} ${JSON.stringify(r.body)}`));
  const nums = [];
  for (const r of rs) nums.push((await saleRow(r.body.data.id)).invoice_number);
  const seq = nums.map((n) => Number(n.split('/')[2])).sort((a, b) => a - b);
  assert(new Set(nums).size === 5, `repeats ${nums}`);
  for (let i = 1; i < seq.length; i += 1) assert(seq[i] === seq[i - 1] + 1, `gap ${seq}`);
});

check('a refused sale does not use up an invoice number', async () => {
  const owner = await loginOwner();
  const a = await newSale(owner.token, { items: [{ product_name: 'GST before', quantity: 1, unit_price: 10, tax_rate: 0 }], payments: [{ method: 'upi', amount: 10 }] });
  const bad = await newSale(owner.token, { items: [{ product_name: 'GST refused', quantity: 1, unit_price: 10, tax_rate: 0 }], payments: [{ method: 'upi', amount: 50 }] });
  assert(bad.status === 400 && /more than the bill/.test(bad.body.message), `${bad.status} ${JSON.stringify(bad.body)}`);
  const b = await newSale(owner.token, { items: [{ product_name: 'GST after', quantity: 1, unit_price: 10, tax_rate: 0 }], payments: [{ method: 'upi', amount: 10 }] });
  const na = Number((await saleRow(a.body.data.id)).invoice_number.split('/')[2]);
  const nb = Number((await saleRow(b.body.data.id)).invoice_number.split('/')[2]);
  assert(nb === na + 1, `${na} -> ${nb}`);
});

check('a discount bigger than the items is refused in plain words', async () => {
  const owner = await loginOwner();
  const r = await newSale(owner.token, { items: [{ product_name: 'GST small', quantity: 1, unit_price: 50, tax_rate: 0 }], discount_type: 'fixed', discount_value: 60, payments: [] });
  assert(r.status === 400 && r.body.message === "The discount can't be more than the price.", `${r.status} ${JSON.stringify(r.body)}`);
});

check('buyer GSTIN is checked and saved', async () => {
  const owner = await loginOwner();
  const bad = await newSale(owner.token, { items: [{ product_name: 'GST b2b', quantity: 1, unit_price: 10, tax_rate: 0 }], buyer_gstin: '12345', payments: [] });
  assert(bad.status === 400 && /GSTIN/.test(bad.body.message), `${bad.status}`);
  const ok = await newSale(owner.token, { items: [{ product_name: 'GST b2b', quantity: 1, unit_price: 10, tax_rate: 0 }], buyer_gstin: '07abcde1234f1z5', buyer_legal_name: 'Test Traders', payments: [] });
  assert(ok.status === 201, `${ok.status} ${JSON.stringify(ok.body)}`);
  const s = await saleRow(ok.body.data.id);
  assert(s.buyer_gstin === '07ABCDE1234F1Z5' && s.buyer_legal_name === 'Test Traders', JSON.stringify(s.buyer_gstin));
});

check('delivery charge carries GST at the delivery rate and is never discounted', async () => {
  const owner = await loginOwner();
  const r = await newSale(owner.token, {
    order_type: 'delivery', delivery_address: 'GST test road', scheduled_date: '2026-12-01',
    items: [{ product_name: 'GST delivery item', quantity: 1, unit_price: 500, tax_rate: 0 }],
    discount_type: 'percentage', discount_value: 10, delivery_charges: 118, payments: [],
  });
  assert(r.status === 201, `${r.status} ${JSON.stringify(r.body)}`);
  const s = await saleRow(r.body.data.id);
  assert(P(s.grand_total) === 56800 && P(s.delivery_tax) === 1800 && Number(s.delivery_tax_rate) === 18 && P(s.discount_amount) === 5000, JSON.stringify({ g: s.grand_total, dt: s.delivery_tax }));
});

check('round-off: on rounds a counter sale, never a quick sale', async () => {
  const owner = await loginOwner();
  await setSetting('bill_round_off', '1');
  const r = await newSale(owner.token, { items: [{ product_name: 'GST round', quantity: 1, unit_price: 45.5, tax_rate: 0 }], payments: [{ method: 'upi', amount: 46 }] });
  assert(r.status === 201, `${r.status} ${JSON.stringify(r.body)}`);
  const s = await saleRow(r.body.data.id);
  assert(P(s.grand_total) === 4600 && P(s.round_off) === 50 && s.payment_status === 'paid', JSON.stringify({ g: s.grand_total, ro: s.round_off }));
  const q = await newSale(owner.token, { entry_mode: 'quick', items: [{ product_name: 'GST quick', quantity: 1, unit_price: 45.5, tax_rate: 0 }], payments: [{ method: 'cash', amount: 45.5 }] });
  assert(q.status === 201, `${q.status} ${JSON.stringify(q.body)}`);
  const qs = await saleRow(q.body.data.id);
  assert(P(qs.grand_total) === 4550 && P(qs.round_off) === 0 && qs.payment_status === 'paid', JSON.stringify({ g: qs.grand_total }));
  await setSetting('bill_round_off', roundOffBefore);
});

check('editing an item on a GST sale redoes the bill and moves the dues', async () => {
  const owner = await loginOwner();
  const c = await customer(owner.token);
  const p5 = await taxedProduct(105, await rateId(5), null);
  const r = await newSale(owner.token, { customer_id: c.id, items: [{ product_id: p5, quantity: 2, unit_price: 105 }], discount_type: 'fixed', discount_value: 10, payments: [{ method: 'upi', amount: 100 }] });
  assert(r.status === 201, `${r.status} ${JSON.stringify(r.body)}`);
  const db = await getDb();
  const dues0 = Number((await db.prepare('SELECT credit_balance FROM users WHERE id = ?').get(c.id)).credit_balance);
  assert(P(dues0) === 10000, `dues ${dues0}`); // 210 - 10 - 100 paid
  const item = (await saleRow(r.body.data.id)).items[0];
  const e = await api('PUT', `/sales/${r.body.data.id}`, owner.token, { items: [{ id: item.id, quantity: 3, shelf_price: 105 }] });
  assert(e.status === 200, `${e.status} ${JSON.stringify(e.body)}`);
  const s = await saleRow(r.body.data.id);
  const want = computeBill([{ unitPrice: 105, qty: 3, taxRate: 5 }], { type: 'fixed', value: 10 }, { amount: 0, taxRate: 18 }, { roundOff: false });
  assert(P(s.grand_total) === want.payableP && P(s.items[0].taxable_value) === want.lines[0].taxableP && Number(s.items[0].quantity) === 3, JSON.stringify({ g: s.grand_total }));
  const dues1 = Number((await db.prepare('SELECT credit_balance FROM users WHERE id = ?').get(c.id)).credit_balance);
  assert(P(dues1) === want.payableP - 10000, `dues after ${dues1}`);
  // Lowering it below what was paid is refused
  const low = await api('PUT', `/sales/${r.body.data.id}`, owner.token, { items: [{ id: item.id, quantity: 1, shelf_price: 50 }] });
  assert(low.status === 409 && /already paid/.test(low.body.message), `${low.status} ${JSON.stringify(low.body)}`);
});

check('edit bill: cash to UPI moves the register by exactly that amount and keeps the bill', async () => {
  const owner = await loginOwner();
  const reg = await openRegister(owner.token, LOC, 500);
  const p18 = await taxedProduct(118, await rateId(18), '7013');
  const r = await newSale(owner.token, { items: [{ product_id: p18, quantity: 2, unit_price: 118 }], payments: [{ method: 'cash', amount: 236 }] });
  assert(r.status === 201, `${r.status} ${JSON.stringify(r.body)}`);
  const before = await saleRow(r.body.data.id);
  const exp = async () => Number((await api('GET', `/sales/register/status?location_id=${LOC}`, owner.token)).body.data.expected_cash);
  const e0 = await exp();
  assert(P(e0) === 73600, `expected cash after sale ${e0}`);
  // Split: 100 cash + 136 UPI
  const e = await api('PUT', `/sales/${r.body.data.id}`, owner.token, { payments: [{ method: 'cash', amount: 100 }, { method: 'upi', amount: 136 }] });
  assert(e.status === 200, `${e.status} ${JSON.stringify(e.body)}`);
  assert(P(await exp()) === 60000, 'register moved by 136 only');
  const after = await saleRow(r.body.data.id);
  assert(after.invoice_number === before.invoice_number && P(after.grand_total) === P(before.grand_total) && P(after.taxable_total) === P(before.taxable_total), 'bill unchanged');
  // An over-payment edit is refused and moves nothing
  const over = await api('PUT', `/sales/${r.body.data.id}`, owner.token, { payments: [{ method: 'cash', amount: 300 }] });
  assert(over.status >= 400 && P(await exp()) === 60000, `over ${over.status} ${JSON.stringify(over.body)}`);
  // All UPI
  const u = await api('PUT', `/sales/${r.body.data.id}`, owner.token, { payments: [{ method: 'upi', amount: 236 }] });
  assert(u.status === 200 && P(await exp()) === 50000, `${u.status} back to opening`);
  // Close balances at the opening float exactly
  const pv = await api('PUT', '/sales/register/close', owner.token, { location_id: LOC, actual_cash: 500, preview: true });
  assert(pv.status === 200 && Math.abs(Number(pv.body.data.difference ?? pv.body.data.cash_difference ?? 0)) < 0.005, JSON.stringify(pv.body.data));
  assert(reg.id, 'register');
});

check('edit bill: raising a paid order keeps the invoice number, owes the rest, prints the new figures', async () => {
  const owner = await loginOwner();
  const c = await customer(owner.token);
  const p5 = await taxedProduct(105, await rateId(5), '0603');
  const p18 = await taxedProduct(118, await rateId(18), '7013');
  const r = await newSale(owner.token, { customer_id: c.id, items: [{ product_id: p5, quantity: 1, unit_price: 105 }, { product_id: p18, quantity: 1, unit_price: 118 }], payments: [{ method: 'upi', amount: 223 }] });
  assert(r.status === 201, `${r.status}`);
  const before = await saleRow(r.body.data.id);
  assert(before.payment_status === 'paid', before.payment_status);
  const line = before.items.find((i) => Number(i.product_id) === Number(p18));
  const e = await api('PUT', `/sales/${r.body.data.id}`, owner.token, { items: [{ id: line.id, quantity: 2, shelf_price: 118 }] });
  assert(e.status === 200, `${e.status} ${JSON.stringify(e.body)}`);
  const s = await saleRow(r.body.data.id);
  const want = computeBill([{ unitPrice: 105, qty: 1, taxRate: 5 }, { unitPrice: 118, qty: 2, taxRate: 18 }], null, { amount: 0, taxRate: 18 }, { roundOff: false });
  assert(P(s.grand_total) === want.payableP && s.invoice_number === before.invoice_number, JSON.stringify({ g: s.grand_total, inv: s.invoice_number }));
  assert(s.payment_status === 'partial', s.payment_status);
  // Stored identity still holds
  const ident = P(s.subtotal) - P(s.discount_amount) + P(s.tax_total) + P(s.delivery_charges) + P(s.round_off);
  assert(ident === P(s.grand_total), `identity ${ident} vs ${P(s.grand_total)}`);
  const db = await getDb();
  const dues = Number((await db.prepare('SELECT credit_balance FROM users WHERE id = ?').get(c.id)).credit_balance);
  assert(P(dues) === want.payableP - 22300, `dues ${dues}`);
  const v = (await api('GET', `/sales/${r.body.data.id}/invoice`, owner.token)).body.data;
  const linesSum = v.lines.reduce((t, l) => t + P(l.amount), 0);
  assert(P(v.totals.total) === want.payableP && linesSum === want.itemsGrossP && P(v.due) === want.payableP - 22300, JSON.stringify(v.totals));
  assert(P(v.tax_totals.taxable) + P(v.tax_totals.total) === want.payableP, JSON.stringify(v.tax_totals));
});

check('edit bill: marking an unpaid order paid clears its dues; a status with no money is refused', async () => {
  const owner = await loginOwner();
  await openRegister(owner.token, LOC, 0);
  const c = await customer(owner.token);
  const p5 = await taxedProduct(105, await rateId(5), '0603');
  const r = await newSale(owner.token, { customer_id: c.id, items: [{ product_id: p5, quantity: 1, unit_price: 105 }], payments: [] });
  assert(r.status === 201, `${r.status}`);
  const db = await getDb();
  const dues = async () => P((await db.prepare('SELECT credit_balance FROM users WHERE id = ?').get(c.id)).credit_balance);
  assert(await dues() === 10500, 'dues after sale');
  // Status alone, no money: refused, nothing changes
  const bad = await api('PUT', `/sales/${r.body.data.id}`, owner.token, { payment_status: 'paid' });
  assert(bad.status === 409 && /Add Payment/.test(bad.body.message), `${bad.status} ${JSON.stringify(bad.body)}`);
  assert((await saleRow(r.body.data.id)).payment_status === 'pending' && await dues() === 10500, 'unchanged');
  // A name change with the same status still saves
  const nm = await api('PUT', `/sales/${r.body.data.id}`, owner.token, { customer_name: 'GST renamed', payment_status: 'pending' });
  assert(nm.status === 200, `${nm.status} ${JSON.stringify(nm.body)}`);
  // What Sale Details sends for "mark paid": the full bill in cash
  const exp = async () => P((await api('GET', `/sales/register/status?location_id=${LOC}`, owner.token)).body.data.expected_cash);
  const e0 = await exp();
  const ok = await api('PUT', `/sales/${r.body.data.id}`, owner.token, { payment_status: 'paid', payments: [{ method: 'cash', amount: 105 }] });
  assert(ok.status === 200, `${ok.status} ${JSON.stringify(ok.body)}`);
  const s = await saleRow(r.body.data.id);
  assert(s.payment_status === 'paid' && await dues() === 0 && (await exp()) - e0 === 10500, JSON.stringify({ st: s.payment_status, d: await dues() }));
  // Bad payment rows are refused
  const neg = await api('PUT', `/sales/${r.body.data.id}`, owner.token, { payments: [{ method: 'cash', amount: -5 }] });
  const odd = await api('PUT', `/sales/${r.body.data.id}`, owner.token, { payments: [{ method: 'cheque', amount: 105 }] });
  assert(neg.status === 400 && odd.status === 400 && (await exp()) - e0 === 10500, `${neg.status} ${odd.status}`);
});

check('edit bill: an older sale (before GST bills) still edits with its old maths', async () => {
  const owner = await loginOwner();
  const r = await newSale(owner.token, { items: [{ product_name: 'GST old edit', quantity: 1, unit_price: 50, tax_rate: 0 }], payments: [] });
  assert(r.status === 201, `${r.status}`);
  const db = await getDb();
  await db.prepare('UPDATE sales SET bill_version = NULL, invoice_number = NULL WHERE id = ?').run(r.body.data.id);
  const item = (await saleRow(r.body.data.id)).items[0];
  const e = await api('PUT', `/sales/${r.body.data.id}`, owner.token, { items: [{ id: item.id, quantity: 3, unit_price: 50 }] });
  assert(e.status === 200, `${e.status} ${JSON.stringify(e.body)}`);
  const s = await saleRow(r.body.data.id);
  assert(s.bill_version == null && !s.invoice_number && P(s.grand_total) === 15000, JSON.stringify({ g: s.grand_total, v: s.bill_version }));
  const v = (await api('GET', `/sales/${r.body.data.id}/invoice`, owner.token)).body.data;
  assert(v.kind === 'bill' && P(v.totals.total) === 15000, v.kind);
});

check('turning a GST pickup into a delivery adds the charge with its GST', async () => {
  const owner = await loginOwner();
  const r = await newSale(owner.token, { order_type: 'pickup', scheduled_date: '2026-12-01', items: [{ product_name: 'GST convert', quantity: 1, unit_price: 300, tax_rate: 0 }], payments: [] });
  assert(r.status === 201, `${r.status} ${JSON.stringify(r.body)}`);
  const c = await api('PUT', `/sales/${r.body.data.id}/convert-type`, owner.token, { new_order_type: 'delivery', delivery_address: 'GST road 2', delivery_charges: 59 });
  assert(c.status === 200, `${c.status} ${JSON.stringify(c.body)}`);
  const s = await saleRow(r.body.data.id);
  assert(P(s.grand_total) === 35900 && P(s.delivery_tax) === 900 && P(s.delivery_charges) === 5900, JSON.stringify({ g: s.grand_total, dt: s.delivery_tax }));
  const db = await getDb();
  const d = await db.prepare('SELECT cod_amount FROM deliveries WHERE sale_id = ?').get(r.body.data.id);
  assert(d && P(d.cod_amount) === 35900, `cod ${d && d.cod_amount}`);
});

check('a recurring order makes one GST sale with an invoice number, even if run twice', async () => {
  const db = await getDb();
  const owner = await loginOwner();
  const c = await customer(owner.token);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const items = JSON.stringify([{ product_name: 'GST recurring roses', quantity: 2, unit_price: 105, tax_rate: 5 }]);
  const ro = await db.prepare("INSERT INTO recurring_orders (customer_id, location_id, order_type, frequency, items, is_active, next_run_date, created_by) VALUES (?, ?, 'pickup', 'weekly', ?, 1, ?, ?)")
    .run(c.id, LOC, items, today, owner.id);
  createdRecurringIds.push(ro.lastInsertRowid);
  // Start the sync layer (and its boot-time schema patches) before any
  // transaction, as the server does at boot; otherwise its first use inside
  // the processor transaction would wait on that same transaction
  require('../config/database').getDb();
  require('../utils/time').todayStr();
  const { processRecurringOrders } = require('../routes/recurring-orders');
  await Promise.all([processRecurringOrders(), processRecurringOrders()]);
  await processRecurringOrders();
  const sales = await db.prepare("SELECT id FROM sales WHERE customer_id = ? AND source = 'recurring'").all(c.id);
  sales.forEach((r) => createdSaleIds.push(r.id));
  assert(sales.length === 1, `sales ${sales.length}`);
  const s = await saleRow(sales[0].id);
  assert(Number(s.bill_version) === 2 && P(s.grand_total) === 21000 && P(s.tax_total) === 1000 && s.invoice_number, JSON.stringify({ g: s.grand_total, t: s.tax_total, inv: s.invoice_number }));
  const next = await db.prepare('SELECT next_run_date FROM recurring_orders WHERE id = ?').get(ro.lastInsertRowid);
  assert(String(next.next_run_date) > today, `next ${next.next_run_date}`);
  const dues = await db.prepare('SELECT credit_balance FROM users WHERE id = ?').get(c.id);
  assert(P(dues.credit_balance) === 21000, `dues ${dues.credit_balance}`);
});

check('the printed bill matches the saved sale: tax invoice with a GSTIN, plain bill without', async () => {
  const db = await getDb();
  const owner = await loginOwner();
  const loc = await db.prepare('SELECT gst_number, state, state_code FROM locations WHERE id = ?').get(LOC);
  locBefore = loc;
  try {
    await db.prepare("UPDATE locations SET gst_number = '07ABCDE1234F1Z5', state = 'Delhi' WHERE id = ?").run(LOC);
    const p5 = await taxedProduct(525, await rateId(5), '0603');
    const p18 = await taxedProduct(236, await rateId(18), '7013');
    const r = await newSale(owner.token, {
      order_type: 'delivery', delivery_address: '4 Park St', scheduled_date: '2026-12-01', receiver_name: 'Anil', receiver_phone: '9000000001',
      items: [{ product_id: p5, quantity: 2, unit_price: 525 }, { product_id: p18, quantity: 1, unit_price: 236 }],
      discount_type: 'percentage', discount_value: 10, delivery_charges: 118, payments: [],
    });
    assert(r.status === 201, `${r.status} ${JSON.stringify(r.body)}`);
    const inv = await api('GET', `/sales/${r.body.data.id}/invoice`, owner.token);
    assert(inv.status === 200, `${inv.status}`);
    const v = inv.body.data;
    const s = await saleRow(r.body.data.id);
    assert(v.kind === 'tax_invoice' && v.title === 'TAX INVOICE' && v.invoice_number === s.invoice_number, JSON.stringify({ k: v.kind, n: v.invoice_number }));
    assert(v.seller.gstin === '07ABCDE1234F1Z5' && v.seller.state_code === '07' && /Delhi \(07\)/.test(v.place_of_supply), JSON.stringify(v.seller));
    assert(P(v.totals.total) === P(s.grand_total) && P(v.totals.items) === 128600, JSON.stringify(v.totals));
    assert(P(v.totals.items) - P(v.totals.discount) + P(v.totals.delivery) + P(v.totals.round_off) === P(v.totals.total), 'totals add up');
    assert(P(v.tax_totals.taxable) === P(s.taxable_total) && P(v.tax_totals.cgst) === P(s.cgst_total) && P(v.tax_totals.sgst) === P(s.sgst_total), JSON.stringify(v.tax_totals));
    assert(P(v.tax_totals.taxable) + P(v.tax_totals.total) === P(s.grand_total) - P(s.round_off), 'taxable + GST = total before round off');
    assert(v.lines[0].hsn === '0603' && v.delivery && v.delivery.hsn === '9968' && v.ship_to && v.ship_to.address === '4 Park St', 'lines');
    assert(/^Rupees /.test(v.words) && v.prices_include_gst === true, v.words);
    assert(!JSON.stringify(v).includes('estimated_cost') && !JSON.stringify(v).includes('vendor'), 'no cost data');
    await db.prepare("UPDATE locations SET gst_number = '' WHERE id = ?").run(LOC);
    const plain = (await api('GET', `/sales/${r.body.data.id}/invoice`, owner.token)).body.data;
    assert(plain.kind === 'bill' && plain.title === 'BILL' && P(plain.totals.total) === P(s.grand_total), JSON.stringify({ k: plain.kind }));
  } finally {
    await db.prepare('UPDATE locations SET gst_number = ?, state = ?, state_code = ? WHERE id = ?').run(loc.gst_number, loc.state, loc.state_code, LOC);
  }
});

check('a refund on a GST bill gets a credit note that reverses GST in the bill proportions', async () => {
  const db = await getDb();
  const owner = await loginOwner();
  const loc = await db.prepare('SELECT gst_number, state, state_code FROM locations WHERE id = ?').get(LOC);
  try {
    await db.prepare("UPDATE locations SET gst_number = '07ABCDE1234F1Z5', state = 'Delhi' WHERE id = ?").run(LOC);
    const p5 = await taxedProduct(105, await rateId(5), '0603');
    const p18 = await taxedProduct(118, await rateId(18), '7013');
    const r = await newSale(owner.token, { items: [{ product_id: p5, quantity: 1, unit_price: 105 }, { product_id: p18, quantity: 1, unit_price: 118 }], payments: [{ method: 'upi', amount: 223 }] });
    assert(r.status === 201, `${r.status} ${JSON.stringify(r.body)}`);
    const rf = await api('POST', `/sales/${r.body.data.id}/refund`, owner.token, { amount: 111.5, reason: 'GST test refund', refund_method: 'upi' });
    assert(rf.status === 201 && /^[A-Z0-9]+\/\d{4}\/\d{4,}$/.test(rf.body.data.credit_note_number || ''), `${rf.status} ${JSON.stringify(rf.body)}`);
    const cn = (await api('GET', `/sales/${r.body.data.id}/credit-note`, owner.token)).body.data;
    assert(cn.kind === 'credit_note' && cn.credit_note_number === rf.body.data.credit_note_number && cn.against_invoice, JSON.stringify({ k: cn.kind }));
    const tt = cn.tax_totals;
    assert(P(tt.taxable) + P(tt.total) === 11150 && P(tt.cgst) + P(tt.sgst) === P(tt.total), JSON.stringify(tt));
    // Half the bill refunded: each rate gets half (105 -> 52.50 at 5%, 118 -> 59 at 18%)
    const r5 = cn.tax_by_rate.find((x) => x.rate === 5);
    const r18 = cn.tax_by_rate.find((x) => x.rate === 18);
    assert(P(r5.taxable) === 5000 && P(r18.taxable) === 5000 && P(r5.total) === 250 && P(r18.total) === 900, JSON.stringify(cn.tax_by_rate));
    // No credit note number on a sale without an invoice number (older bill)
    const old = await newSale(owner.token, { items: [{ product_name: 'GST old style', quantity: 1, unit_price: 20, tax_rate: 0 }], payments: [{ method: 'upi', amount: 20 }] });
    await db.prepare('UPDATE sales SET invoice_number = NULL, bill_version = NULL WHERE id = ?').run(old.body.data.id);
    const rf2 = await api('POST', `/sales/${old.body.data.id}/refund`, owner.token, { amount: 20, reason: 'GST test refund', refund_method: 'upi' });
    assert(rf2.status === 201 && !rf2.body.data.credit_note_number, JSON.stringify(rf2.body));
    const rr = (await api('GET', `/sales/${old.body.data.id}/credit-note`, owner.token)).body.data;
    assert(rr.kind === 'refund_receipt', rr.kind);
  } finally {
    await db.prepare('UPDATE locations SET gst_number = ?, state = ?, state_code = ? WHERE id = ?').run(loc.gst_number, loc.state, loc.state_code, LOC);
    await db.prepare("DELETE FROM invoice_counters WHERE series_key = ?").run(`credit_note:loc:${LOC}`);
  }
});

check('a changed HSN at the counter is saved on the line; product HSN is checked and saved', async () => {
  const owner = await loginOwner();
  const p5 = await taxedProduct(105, await rateId(5), '0603');
  const r = await newSale(owner.token, { items: [{ product_id: p5, quantity: 1, unit_price: 105, hsn_code: '0604' }, { product_name: 'GST custom hsn', quantity: 1, unit_price: 10, tax_rate: 0, hsn_code: '9999' }], payments: [] });
  assert(r.status === 201, `${r.status}`);
  const s = await saleRow(r.body.data.id);
  assert(s.items[0].hsn_code === '0604' && s.items[1].hsn_code === '9999', JSON.stringify(s.items.map((i) => i.hsn_code)));
  const bad = await api('PUT', `/products/${p5}`, owner.token, { hsn_code: '12' });
  assert(bad.status === 400 && /HSN/.test(bad.body.message), `${bad.status} ${JSON.stringify(bad.body)}`);
  const ok = await api('PUT', `/products/${p5}`, owner.token, { hsn_code: '0603 10' });
  assert(ok.status === 200, `${ok.status} ${JSON.stringify(ok.body)}`);
  const db = await getDb();
  assert((await db.prepare('SELECT hsn_code FROM products WHERE id = ?').get(p5)).hsn_code === '060310', 'saved');
});

check('bill settings and shop GST fields refuse wrong values in plain words', async () => {
  const owner = await loginOwner();
  const bad = [
    [{ gst_delivery_rate: '55' }, /GST percent/],
    [{ invoice_prefix: 'TOO-LONG' }, /letters and numbers/],
    [{ bill_pan: 'XYZ' }, /PAN/],
    [{ invoice_series_mode: 'weird' }, /series/],
  ];
  for (const [settings, re] of bad) {
    const r = await api('PUT', '/settings', owner.token, { settings });
    assert(r.status === 400 && re.test(r.body.message), `${JSON.stringify(settings)} -> ${r.status} ${JSON.stringify(r.body)}`);
  }
  const g = await api('PUT', `/locations/${LOC}`, owner.token, { gst_number: '12345' });
  assert(g.status === 400 && /GSTIN/.test(g.body.message), `${g.status} ${JSON.stringify(g.body)}`);
  const f = await api('PUT', `/locations/${LOC}`, owner.token, { fssai_number: '123' });
  assert(f.status === 400 && /FSSAI/.test(f.body.message), `${f.status}`);
});

check('bill settings are readable by counter staff and hold no amounts', async () => {
  const owner = await loginOwner();
  const r = await api('GET', '/settings/bill', owner.token);
  assert(r.status === 200 && typeof r.body.data.round_off === 'boolean' && typeof r.body.data.delivery_rate === 'number', JSON.stringify(r.body));
});

async function cleanup() {
  const db = await getDb();
  await setSetting('bill_round_off', roundOffBefore == null ? '0' : roundOffBefore);
  try {
    const owner = await loginOwner();
    const st = (await api('GET', `/sales/register/status?location_id=${LOC}`, owner.token)).body;
    if (st && st.isOpen && h.createdRegisterIds.includes(st.data.id)) {
      await api('PUT', '/sales/register/close', owner.token, { location_id: LOC, actual_cash: Number(st.data.expected_cash) || 0 });
    }
  } catch (e) { console.error(`   (cleanup warning: close: ${e.message})`); }
  for (const id of createdSaleIds) {
    try {
      await db.prepare('DELETE FROM production_tasks WHERE sale_id = ?').run(id);
      await db.prepare('DELETE FROM deliveries WHERE sale_id = ?').run(id);
      await db.prepare('DELETE FROM refunds WHERE sale_id = ?').run(id);
      await db.prepare('DELETE FROM payments WHERE sale_id = ?').run(id);
      await db.prepare('DELETE FROM sale_items WHERE sale_id = ?').run(id);
      await db.prepare("DELETE FROM audit_logs WHERE entity_type = 'sale' AND entity_id = ?").run(id);
      await db.prepare('DELETE FROM sales WHERE id = ?').run(id);
    } catch (e) { console.error(`   (cleanup warning: sale ${id}: ${e.message})`); }
  }
  for (const id of createdRecurringIds) {
    try { await db.prepare('DELETE FROM recurring_orders WHERE id = ?').run(id); } catch (e) { console.error(`   (cleanup warning: recurring ${id}: ${e.message})`); }
  }
  for (const id of createdUserIds) {
    try {
      await db.prepare('DELETE FROM customer_addresses WHERE customer_id = ?').run(id);
      await db.prepare('DELETE FROM users WHERE id = ?').run(id);
    } catch (e) { console.error(`   (cleanup warning: user ${id}: ${e.message})`); }
  }
  for (const id of createdProductIds) {
    try {
      await db.prepare('DELETE FROM product_stock WHERE product_id = ?').run(id);
      await db.prepare('DELETE FROM products WHERE id = ?').run(id);
    } catch (e) { console.error(`   (cleanup warning: product ${id}: ${e.message})`); }
  }
  for (const id of h.createdRegisterIds) {
    try { await db.prepare("DELETE FROM audit_logs WHERE entity_type = 'cash_register' AND entity_id = ?").run(id); } catch (e) { /* ignore */ }
  }
  // Give Test Loc its invoice numbers back (dev only: no other sale ran meanwhile)
  if (counterBefore) {
    await db.prepare('UPDATE invoice_counters SET last_no = ? WHERE series_key = ? AND fy = ?').run(counterBefore.last_no, `invoice:loc:${LOC}`, counterBefore.fy);
  } else {
    await db.prepare('DELETE FROM invoice_counters WHERE series_key = ?').run(`invoice:loc:${LOC}`);
  }
  console.log(`Cleaned up ${createdSaleIds.length} sale(s), ${createdProductIds.length} product(s), ${createdUserIds.length} customer(s)`);
}

h.run({ cleanup });
