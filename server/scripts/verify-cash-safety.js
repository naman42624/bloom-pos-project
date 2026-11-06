#!/usr/bin/env node
/**
 * Cash and register safety (Phase 1, 2026-11-05). Local dev only.
 * Run against a server started from this checkout, with VERIFY_OWNER_PHONE /
 * VERIFY_OWNER_PASSWORD set. Throwaway data at Test Loc only.
 */
const h = require('./lib/verify-harness');
const { getDb: getSyncDb } = require('../config/database');
const { withMoneyTx } = require('../config/database-async');
const { check, assert, getDb, api, loginOwner, openRegister, TEST_LOCATION_ID } = h;

const createdProductIds = [];
const createdSaleIds = [];
const createdExpenseIds = [];
const createdUserIds = [];
const LOC = TEST_LOCATION_ID;

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function sale(token, { amount, method = 'cash', orderType = 'walk_in', entryMode = null, paid = true, extra = {} }) {
  const res = await api('POST', '/sales', token, {
    location_id: LOC, order_type: orderType, channel: 'walk_in', skip_assignment: true,
    ...(entryMode ? { entry_mode: entryMode } : {}),
    items: [{ product_name: 'Cash safety item', quantity: 1, unit_price: amount }],
    payments: paid ? [{ method, amount }] : [],
    ...extra,
  });
  if (res.body?.data?.id) createdSaleIds.push(res.body.data.id);
  return res;
}

const status = async (token) => (await api('GET', `/sales/register/status?location_id=${LOC}`, token)).body;
const preview = async (token, cash) => (await api('PUT', '/sales/register/close', token, { location_id: LOC, actual_cash: cash, preview: true })).body.data;

let staffN = 0;
async function counterStaff(ownerToken) {
  staffN += 1;
  const phone = '8' + String(Date.now()).slice(-8) + String(staffN % 10);
  const { status: st, body } = await api('POST', '/users', ownerToken, {
    name: `CashSafety staff ${staffN}`, phone, password: 'testpass123', role: 'counter_staff', location_ids: [LOC],
  });
  if (st !== 201 && st !== 200) throw new Error(`staff create ${st} ${JSON.stringify(body)}`);
  const id = body.data.id || body.data.user?.id;
  createdUserIds.push(id);
  const login = await api('POST', '/auth/login', null, { phone, password: 'testpass123' });
  return { token: login.body.data.token, id };
}

check('money tx rows look exactly like the sync layer rows', async () => {
  const sync = getSyncDb();
  const sql = 'SELECT id, opening_balance, expected_cash, opened_at, closed_at, location_id FROM cash_registers ORDER BY id LIMIT 3';
  const a = sync.prepare(sql).all();
  const b = await withMoneyTx((tx) => tx.prepare(sql).all());
  assert(JSON.stringify(a) === JSON.stringify(b), `sync ${JSON.stringify(a[0])} vs tx ${JSON.stringify(b[0])}`);
  const one = await withMoneyTx((tx) => tx.prepare("SELECT COUNT(*) AS c, SUM(1.50) AS s, datetime('now') IS NOT NULL AS ok FROM cash_registers WHERE id = ?").get(a[0].id));
  assert(one.c === 1 && one.s === 1.5 && one.ok === true, JSON.stringify(one));
});

check('money tx: an error rolls back every statement', async () => {
  const name = `CashSafetyRollback ${Date.now()}`;
  let threw = false;
  try {
    await withMoneyTx(async (tx) => {
      const r = await tx.prepare('INSERT INTO products (name, selling_price, is_active) VALUES (?, 1, 1)').run(name);
      assert(Number.isInteger(r.lastInsertRowid) && r.lastInsertRowid > 0, `id ${r.lastInsertRowid}`);
      throw new Error('boom');
    });
  } catch (e) { threw = e.message === 'boom'; }
  assert(threw, 'did not throw');
  const db = await getDb();
  const left = await db.prepare('SELECT id FROM products WHERE name = ?').get(name);
  assert(!left, 'insert was not rolled back');
});

check('money tx: a caught statement error leaves the rest usable', async () => {
  const name = `CashSafetySavepoint ${Date.now()}`;
  const id = await withMoneyTx(async (tx) => {
    try { await tx.prepare('INSERT INTO no_such_table_xyz (a) VALUES (1)').run(); } catch (e) { /* ignored on purpose */ }
    const r = await tx.prepare('INSERT INTO products (name, selling_price, is_active) VALUES (?, 1, 1)').run(name);
    const u = await tx.prepare('UPDATE products SET selling_price = 2 WHERE id = ?').run(r.lastInsertRowid);
    assert(u.changes === 1, `changes ${u.changes}`);
    return r.lastInsertRowid;
  });
  createdProductIds.push(id);
  const db = await getDb();
  const row = await db.prepare('SELECT selling_price FROM products WHERE id = ?').get(id);
  assert(row && Number(row.selling_price) === 2, JSON.stringify(row));
});

check('money tx: a locked row makes a second writer wait', async () => {
  const name = `CashSafetyLock ${Date.now()}`;
  const db = await getDb();
  const ins = await db.prepare('INSERT INTO products (name, selling_price, is_active) VALUES (?, 1, 1)').run(name);
  const id = ins.lastInsertRowid;
  createdProductIds.push(id);
  const order = [];
  let release;
  const held = new Promise((r) => { release = r; });
  const first = withMoneyTx(async (tx) => {
    await tx.prepare('SELECT id FROM products WHERE id = ? FOR UPDATE').get(id);
    order.push('first locked');
    await held;
    await tx.prepare('UPDATE products SET selling_price = 10 WHERE id = ?').run(id);
    order.push('first done');
  });
  await new Promise((r) => setTimeout(r, 150));
  const second = withMoneyTx(async (tx) => {
    const row = await tx.prepare('SELECT selling_price FROM products WHERE id = ? FOR UPDATE').get(id);
    order.push(`second saw ${row.selling_price}`);
  });
  await new Promise((r) => setTimeout(r, 300));
  order.push('releasing');
  release();
  await Promise.all([first, second]);
  assert(order.join(' | ') === 'first locked | releasing | first done | second saw 10', order.join(' | '));
});

check('register status shows the same expected cash that close would record', async () => {
  const owner = await loginOwner();
  await openRegister(owner.token, LOC, 500);
  await sale(owner.token, { amount: 120 });
  await sale(owner.token, { amount: 80, method: 'upi' });
  const st = await status(owner.token);
  const pv = await preview(owner.token, 620);
  assert(r2(st.data.expected_cash) === 620 && r2(pv.expected_cash) === 620, `status ${st.data.expected_cash} preview ${pv.expected_cash}`);
  assert(r2(st.data.total_upi_sales) === 80, `upi ${st.data.total_upi_sales}`);
});

check('B15: a past-day cash refund comes out of the drawer once, with no extra expense row', async () => {
  const owner = await loginOwner();
  await openRegister(owner.token, LOC, 300);
  const s1 = await sale(owner.token, { amount: 200 });
  assert(s1.status === 201, `sale ${s1.status}`);
  const db = await getDb();
  // Make it yesterday's sale, paid before this session opened
  await db.prepare("UPDATE sales SET created_at = created_at - INTERVAL '1 day' WHERE id = ?").run(s1.body.data.id);
  await db.prepare("UPDATE payments SET created_at = created_at - INTERVAL '1 day' WHERE sale_id = ?").run(s1.body.data.id);
  await openRegister(owner.token, LOC, 1000);
  const rf = await api('POST', `/sales/${s1.body.data.id}/refund`, owner.token, { amount: 200, reason: 'cash safety test', refund_method: 'cash' });
  assert(rf.status === 201, `refund ${rf.status} ${JSON.stringify(rf.body)}`);
  const exp = await db.prepare("SELECT id FROM expenses WHERE description LIKE 'Refund for past sale %' AND location_id = ? AND created_at > NOW() - INTERVAL '5 minutes'").all(LOC);
  assert(exp.length === 0, `expense rows ${exp.length}`);
  const pv = await preview(owner.token, 800);
  assert(r2(pv.expected_cash) === 800 && r2(pv.discrepancy) === 0, `expected ${pv.expected_cash} disc ${pv.discrepancy}`);
  const st = await status(owner.token);
  assert(r2(st.data.running_expected_cash) === 800, `running ${st.data.running_expected_cash}`);
});

check('refund: two taps at once refund once', async () => {
  const owner = await loginOwner();
  await openRegister(owner.token, LOC, 400);
  const s1 = await sale(owner.token, { amount: 150 });
  const body = { amount: 150, reason: 'double tap', refund_method: 'cash' };
  const [a, b] = await Promise.all([
    api('POST', `/sales/${s1.body.data.id}/refund`, owner.token, body),
    api('POST', `/sales/${s1.body.data.id}/refund`, owner.token, body),
  ]);
  const codes = [a.status, b.status].sort();
  assert(codes[0] === 201 && codes[1] === 409, `codes ${codes}`);
  const pv = await preview(owner.token, 400);
  assert(r2(pv.expected_cash) === 400, `expected ${pv.expected_cash}`);
});

check('add payment: more than is due is refused, and two full payments at once take one', async () => {
  const owner = await loginOwner();
  await openRegister(owner.token, LOC, 100);
  const s1 = await sale(owner.token, { amount: 250, paid: false, orderType: 'pickup' });
  assert(s1.status === 201, `sale ${s1.status} ${JSON.stringify(s1.body)}`);
  const over = await api('POST', `/sales/${s1.body.data.id}/payments`, owner.token, { method: 'cash', amount: 300 });
  assert(over.status === 400 && /more than/.test(over.body.message), `over ${over.status} ${JSON.stringify(over.body)}`);
  const pay = { method: 'cash', amount: 250 };
  const res = await Promise.all([1, 2].map(() => api('POST', `/sales/${s1.body.data.id}/payments`, owner.token, pay)));
  const ok = res.filter((x) => x.status === 201).length;
  assert(ok === 1, `succeeded ${ok}: ${res.map((x) => x.status)}`);
  const pv = await preview(owner.token, 350);
  assert(r2(pv.expected_cash) === 350, `expected ${pv.expected_cash}`);
});

check('a sale and a close at the same moment: the sale is either counted or refused, never lost', async () => {
  const owner = await loginOwner();
  for (let i = 0; i < 4; i++) {
    const reg = await openRegister(owner.token, LOC, 50);
    const [s1, cl] = await Promise.all([
      sale(owner.token, { amount: 70 }),
      api('PUT', '/sales/register/close', owner.token, { location_id: LOC, actual_cash: 50 }),
    ]);
    assert(cl.status === 200, `close ${cl.status}`);
    const db = await getDb();
    const closed = await db.prepare('SELECT expected_cash, total_cash_sales FROM cash_registers WHERE id = ?').get(reg.id);
    if (s1.status === 201) {
      assert(r2(closed.total_cash_sales) === 70 && r2(closed.expected_cash) === 120, `sale saved but close missed it: ${JSON.stringify(closed)}`);
    } else {
      assert(s1.status === 400 && /Register isn't open/.test(s1.body.message), `sale ${s1.status} ${JSON.stringify(s1.body)}`);
      assert(r2(closed.expected_cash) === 50, `close ${JSON.stringify(closed)}`);
    }
  }
});

check('B16: cash taken at pickup adds to expected cash and keeps the expenses', async () => {
  const owner = await loginOwner();
  await openRegister(owner.token, LOC, 1000);
  const ex = await api('POST', '/expenses', owner.token, { location_id: LOC, category: 'supplies', amount: 100, payment_method: 'cash', expense_date: new Date().toISOString().slice(0, 10), description: 'cash safety' });
  assert(ex.status === 201, `expense ${ex.status} ${JSON.stringify(ex.body)}`);
  createdExpenseIds.push(ex.body.data.id);
  const s1 = await sale(owner.token, { amount: 250, paid: false, orderType: 'pickup' });
  const db = await getDb();
  await db.prepare("UPDATE sales SET status = 'ready', stock_deducted = 1 WHERE id = ?").run(s1.body.data.id);
  const pu = await api('PUT', `/deliveries/pickup/${s1.body.data.id}/picked-up`, owner.token, { payment_method: 'cash', payment_amount: 250 });
  assert(pu.status === 200, `pickup ${pu.status} ${JSON.stringify(pu.body)}`);
  const st = await status(owner.token);
  assert(r2(st.data.running_expected_cash) === 1150 && r2(st.data.expected_cash) === 1150, `running ${st.data.running_expected_cash} live ${st.data.expected_cash}`);
});

check('B14: Edit Sale saves notes (order_notes maps to customer_notes)', async () => {
  const owner = await loginOwner();
  await openRegister(owner.token, LOC, 0);
  const s1 = await sale(owner.token, { amount: 40, method: 'upi' });
  const ed = await api('PUT', `/sales/${s1.body.data.id}`, owner.token, { order_notes: 'Ring the bell' });
  assert(ed.status === 200, `edit ${ed.status} ${JSON.stringify(ed.body)}`);
  const db = await getDb();
  const row = await db.prepare('SELECT customer_notes FROM sales WHERE id = ?').get(s1.body.data.id);
  assert(row.customer_notes === 'Ring the bell', JSON.stringify(row));
});

check('B20: counter staff can switch Cash/UPI on a coworker quick sale, not other fields', async () => {
  const owner = await loginOwner();
  const staff = await counterStaff(owner.token);
  await openRegister(owner.token, LOC, 200);
  const s1 = await sale(owner.token, { amount: 90, entryMode: 'quick' });
  const sw = await api('PUT', `/sales/${s1.body.data.id}`, staff.token, { payments: [{ method: 'upi', amount: 90 }] });
  assert(sw.status === 200, `switch ${sw.status} ${JSON.stringify(sw.body)}`);
  const pv = await preview(owner.token, 200);
  assert(r2(pv.expected_cash) === 200, `expected ${pv.expected_cash}`);
  const other = await api('PUT', `/sales/${s1.body.data.id}`, staff.token, { customer_name: 'X' });
  assert(other.status === 403, `other field ${other.status}`);
});

check('Edit Sale: a payment counted at an earlier close is not changed', async () => {
  const owner = await loginOwner();
  await openRegister(owner.token, LOC, 0);
  const s1 = await sale(owner.token, { amount: 60 });
  await openRegister(owner.token, LOC, 60); // closes the first session
  const sw = await api('PUT', `/sales/${s1.body.data.id}`, owner.token, { payments: [{ method: 'upi', amount: 60 }] });
  // Same-day check runs first: a closed latest register of the day refuses, or the new session refuses
  assert(sw.status === 409 || sw.status === 400, `switch ${sw.status} ${JSON.stringify(sw.body)}`);
  const db = await getDb();
  const pays = await db.prepare('SELECT method FROM payments WHERE sale_id = ?').all(s1.body.data.id);
  assert(pays.length === 1 && pays[0].method === 'cash', JSON.stringify(pays));
});

check('dues: two collects of the full dues at once take it once', async () => {
  const owner = await loginOwner();
  await openRegister(owner.token, LOC, 0);
  const phone = '7' + String(Date.now()).slice(-9);
  const s1 = await sale(owner.token, { amount: 300, paid: false, orderType: 'pickup', extra: { customer_name: 'CashSafety Customer', customer_phone: phone } });
  assert(s1.status === 201, `sale ${s1.status} ${JSON.stringify(s1.body)}`);
  const db = await getDb();
  const cust = await db.prepare('SELECT id, credit_balance FROM users WHERE phone = ?').get(phone);
  assert(cust && r2(cust.credit_balance) === 300, `customer ${JSON.stringify(cust)}`);
  createdUserIds.push(cust.id);
  const body = { location_id: LOC, payments: [{ method: 'cash', amount: 300 }] };
  const res = await Promise.all([1, 2].map(() => api('POST', `/customers/${cust.id}/credits`, owner.token, body)));
  const ok = res.filter((x) => x.status === 201).length;
  assert(ok === 1, `succeeded ${ok}: ${res.map((x) => `${x.status} ${x.body?.message}`)}`);
  const pv = await preview(owner.token, 300);
  assert(r2(pv.expected_cash) === 300, `expected ${pv.expected_cash}`);
});

check('register open: two taps open one register', async () => {
  const owner = await loginOwner();
  await openRegister(owner.token, LOC, 10);
  await api('PUT', '/sales/register/close', owner.token, { location_id: LOC, actual_cash: 10 });
  const res = await Promise.all([1, 2].map(() => api('POST', '/sales/register/open', owner.token, { location_id: LOC, opening_balance: 10 })));
  for (const r of res) if (r.body?.data?.id) h.createdRegisterIds.push(r.body.data.id);
  const codes = res.map((r) => r.status).sort();
  assert(codes[0] === 201 && codes[1] === 409, `codes ${codes}`);
});

// ── Checkout fixes (2026-11-06) ─────────────────────────────────────────
// A manager with an approval PIN at Test Loc, and one at another shop only.
const TEST_PIN = String(1000 + Math.floor(Math.random() * 8999));
async function managerWithPin(ownerToken, locationIds) {
  staffN += 1;
  const phone = '7' + String(Date.now()).slice(-8) + String(staffN % 10);
  const { body } = await api('POST', '/users', ownerToken, {
    name: `CashSafety manager ${staffN}`, phone, password: 'testpass123', role: 'manager', location_ids: locationIds,
  });
  const id = body.data.id || body.data.user?.id;
  createdUserIds.push(id);
  const { hashPin } = require('../utils/pin');
  const db = await getDb();
  const code = String(90000 + Math.floor(Math.random() * 9999));
  await db.prepare('UPDATE users SET employee_code = ?, pin_hash = ? WHERE id = ?').run(code, await hashPin(TEST_PIN), id);
  return { id, code };
}
const discounted = (token, pct, override) => sale(token, {
  amount: 100, method: 'upi', paid: false,
  extra: { discount_type: 'percentage', discount_value: pct, ...(override ? { discount_override: override } : {}) },
});

check('discount over the counter limit: 403 with a code, not 500', async () => {
  const owner = await loginOwner();
  const staff = await counterStaff(owner.token);
  const r = await discounted(staff.token, 25);
  assert(r.status === 403 && r.body.code === 'DISCOUNT_NEEDS_OK', `${r.status} ${JSON.stringify(r.body)}`);
  assert(/Ask a manager or the owner/.test(r.body.message), r.body.message);
});

check('discount: a manager PIN OKs up to the owner limit, wrong PIN / other shop / too big refused', async () => {
  const owner = await loginOwner();
  const staff = await counterStaff(owner.token);
  const mgr = await managerWithPin(owner.token, [LOC]);
  const other = await managerWithPin(owner.token, [1]);
  const wrong = await discounted(staff.token, 25, { employee_code: mgr.code, pin: TEST_PIN === '1111' ? '2222' : '1111' });
  assert(wrong.status === 401 && wrong.body.code === 'DISCOUNT_PIN', `wrong pin ${wrong.status} ${JSON.stringify(wrong.body)}`);
  const otherShop = await discounted(staff.token, 25, { employee_code: other.code, pin: TEST_PIN });
  assert(otherShop.status === 403 && otherShop.body.code === 'DISCOUNT_APPROVER', `other shop ${otherShop.status} ${JSON.stringify(otherShop.body)}`);
  const ok = await discounted(staff.token, 25, { employee_code: mgr.code, pin: TEST_PIN });
  assert(ok.status === 201, `ok ${ok.status} ${JSON.stringify(ok.body)}`);
  const db = await getDb();
  const row = await db.prepare('SELECT discount_approved_by, discount_percentage FROM sales WHERE id = ?').get(ok.body.data.id);
  assert(Number(row.discount_approved_by) === mgr.id && Number(row.discount_percentage) === 25, JSON.stringify(row));
  const tooBig = await discounted(staff.token, 35, { employee_code: mgr.code, pin: TEST_PIN });
  assert(tooBig.status === 403 && tooBig.body.code === 'DISCOUNT_NEEDS_OWNER', `too big ${tooBig.status} ${JSON.stringify(tooBig.body)}`);
});

check('write-off: staff at most Rs 10, nobody more than is due', async () => {
  const owner = await loginOwner();
  const staff = await counterStaff(owner.token);
  const s1 = await sale(staff.token, { amount: 100, method: 'upi', paid: false });
  const id = s1.body.data.id;
  const big = await api('POST', `/sales/${id}/payments`, staff.token, { payments: [{ method: 'upi', amount: 80 }], write_off_amount: 20 });
  assert(big.status === 403, `staff 20 ${big.status} ${JSON.stringify(big.body)}`);
  const over = await api('POST', `/sales/${id}/payments`, owner.token, { payments: [], write_off_amount: 150 });
  assert(over.status === 400, `owner over due ${over.status} ${JSON.stringify(over.body)}`);
  const small = await api('POST', `/sales/${id}/payments`, staff.token, { payments: [{ method: 'upi', amount: 95 }], write_off_amount: 5 });
  assert(small.status === 200 || small.status === 201, `staff 5 ${small.status} ${JSON.stringify(small.body)}`);
  const db = await getDb();
  const row = await db.prepare('SELECT payment_status FROM sales WHERE id = ?').get(id);
  assert(row.payment_status === 'paid', JSON.stringify(row));
});

check('refund lowers total spent once; cancelling after it takes off only the rest', async () => {
  const owner = await loginOwner();
  const phone = '6' + String(Date.now()).slice(-9);
  const mk = (amount) => sale(owner.token, { amount, method: 'upi', extra: { customer_name: 'CashSafety buyer', customer_phone: phone } });
  const a = await mk(100);
  const b = await mk(50);
  const db = await getDb();
  const custId = (await db.prepare('SELECT customer_id FROM sales WHERE id = ?').get(b.body.data.id)).customer_id;
  assert(custId, 'no customer on the sale');
  createdUserIds.push(Number(custId));
  const spent = async () => r2((await db.prepare('SELECT total_spent FROM users WHERE id = ?').get(custId)).total_spent);
  assert(await spent() === 150, `start ${await spent()}`);
  const ref = await api('POST', `/sales/${b.body.data.id}/refund`, owner.token, { amount: 50, reason: 'check', refund_method: 'upi' });
  assert(ref.status === 200 || ref.status === 201, `refund ${ref.status} ${JSON.stringify(ref.body)}`);
  assert(await spent() === 100, `after refund ${await spent()}`);
  const cancel = await api('PUT', `/sales/${b.body.data.id}/cancel`, owner.token, { reason: 'check' });
  assert(cancel.status === 200, `cancel ${cancel.status} ${JSON.stringify(cancel.body)}`);
  assert(await spent() === 100, `after cancel ${await spent()} (refund taken off twice)`);
  assert(a.status === 201, 'first sale');
});

check('dashboard net = revenue - refunds - expenses (same as Sales Report)', async () => {
  const owner = await loginOwner();
  const r = await api('GET', `/reports/dashboard?location_id=${LOC}`, owner.token);
  const t = r.body.data.today;
  assert(t.refunds !== undefined, JSON.stringify(t));
  assert(r2(t.net) === r2(Number(t.revenue) - Number(t.refunds) - Number(t.written_off) - Number(t.expenses)), JSON.stringify(t));
});

check('an undone quick sale shows as "Cancelled (undone)"', async () => {
  const { computeOrderStage } = require('../utils/order-stage');
  const st = computeOrderStage({ status: 'cancelled', undone_at: new Date().toISOString(), order_type: 'walk_in' }, 'owner');
  assert(st.label === 'Cancelled (undone)', st.label);
  const plain = computeOrderStage({ status: 'cancelled', order_type: 'walk_in' }, 'owner');
  assert(plain.label === 'Cancelled', plain.label);
});

check('write-off never changes the bill: own line, order settled, GST as issued', async () => {
  const owner = await loginOwner();
  const staff = await counterStaff(owner.token);
  const db = await getDb();
  const mk = async () => {
    const r = await sale(staff.token, { amount: 118, method: 'upi', paid: false, extra: { items: [{ product_name: 'GST write-off item', quantity: 1, unit_price: 118, tax_rate: 18 }] } });
    assert(r.status === 201, `sale ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.data.id;
  };
  const billOf = async (id) => db.prepare('SELECT invoice_number, grand_total, tax_total, discount_amount, taxable_total, cgst_total, sgst_total, round_off, payment_status FROM sales WHERE id = ?').get(id);
  const same = (a, b) => ['invoice_number', 'grand_total', 'tax_total', 'discount_amount', 'taxable_total', 'cgst_total', 'sgst_total', 'round_off'].every((k) => String(a[k]) === String(b[k]));

  const id = await mk();
  const before = await billOf(id);
  const pay = await api('POST', `/sales/${id}/payments`, staff.token, { payments: [{ method: 'upi', amount: 113 }], write_off_amount: 5 });
  assert(pay.status === 200 || pay.status === 201, `pay ${pay.status} ${JSON.stringify(pay.body)}`);
  const after = await billOf(id);
  assert(same(before, after), `bill changed: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  assert(after.payment_status === 'paid' && r2(after.grand_total) === 118, JSON.stringify(after));
  const lines = await db.prepare('SELECT method, amount FROM payments WHERE sale_id = ? ORDER BY id').all(id);
  assert(lines.length === 2 && lines[1].method === 'write_off' && r2(lines[1].amount) === 5, JSON.stringify(lines));

  const ref = await api('POST', `/sales/${id}/refund`, owner.token, { amount: 118, reason: 'check', refund_method: 'upi' });
  assert(ref.status === 400 && /113/.test(ref.body.message), `refund ceiling ${ref.status} ${JSON.stringify(ref.body)}`);
  const ref2 = await api('POST', `/sales/${id}/refund`, owner.token, { amount: 113, reason: 'check', refund_method: 'upi' });
  assert(ref2.status === 200 || ref2.status === 201, `refund 113 ${ref2.status} ${JSON.stringify(ref2.body)}`);
  const cancel = await api('PUT', `/sales/${id}/cancel`, owner.token, { reason: 'check' });
  assert(cancel.status === 200, `cancel after refunding the money ${cancel.status} ${JSON.stringify(cancel.body)}`);

  const id3 = await mk();
  await api('POST', `/sales/${id3}/payments`, staff.token, { payments: [{ method: 'upi', amount: 113 }], write_off_amount: 5 });
  const sneak = await api('PUT', `/sales/${id3}`, staff.token, { payments: [{ method: 'write_off', amount: 118 }] });
  assert(sneak.status === 400, `write_off via edit ${sneak.status} ${JSON.stringify(sneak.body)}`);
  const sw = await api('PUT', `/sales/${id3}`, staff.token, { payments: [{ method: 'card', amount: 113 }] });
  assert(sw.status === 200, `method change ${sw.status} ${JSON.stringify(sw.body)}`);
  const l3 = await db.prepare('SELECT method, amount FROM payments WHERE sale_id = ? ORDER BY method').all(id3);
  assert(l3.length === 2 && l3.some((p) => p.method === 'card' && r2(p.amount) === 113) && l3.some((p) => p.method === 'write_off' && r2(p.amount) === 5), JSON.stringify(l3));
  assert((await billOf(id3)).payment_status === 'paid', 'still paid after edit');

  const id2 = await mk();
  const b0 = await billOf(id2);
  await api('POST', `/sales/${id2}/payments`, owner.token, { payments: [{ method: 'upi', amount: 100 }] });
  const res = await api('POST', `/sales/${id2}/resolve-balance`, owner.token, { action: 'write_off' });
  assert(res.status === 200, `resolve ${res.status} ${JSON.stringify(res.body)}`);
  const b = await billOf(id2);
  assert(same(b0, b) && b.payment_status === 'paid', `${JSON.stringify(b0)} -> ${JSON.stringify(b)}`);
});

check('report: write-offs are their own line and come off net', async () => {
  const owner = await loginOwner();
  const r = await api('GET', `/reports/sales-summary?location_id=${LOC}`, owner.token);
  assert(r.status === 200, `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  const t = r.body.data.totals;
  assert(t.written_off !== undefined, JSON.stringify(t));
  assert(!r.body.data.paymentMethods.some((m) => m.method === 'write_off'), 'write_off listed as a payment method');
  assert(r2(t.net_revenue) === r2(Number(t.total_revenue) - Number(t.refund_total || 0) - Number(t.written_off) - Number(t.total_expenses || 0)), JSON.stringify(t));
  const d = (await api('GET', `/reports/dashboard?location_id=${LOC}`, owner.token)).body.data.today;
  assert(r2(d.net) === r2(Number(d.revenue) - Number(d.refunds) - Number(d.written_off) - Number(d.expenses)), JSON.stringify(d));
});

async function cleanup() {
  const db = await getDb();
  // Close any register this run left open (only ones it opened are deleted below)
  try {
    const st = await status((await loginOwner()).token);
    if (st && st.isOpen && h.createdRegisterIds.includes(st.data.id)) {
      await api('PUT', '/sales/register/close', (await loginOwner()).token, { location_id: LOC, actual_cash: Number(st.data.expected_cash) || 0 });
    }
  } catch (e) { console.error(`   (cleanup warning: close: ${e.message})`); }
  for (const id of createdSaleIds) {
    try {
      await db.prepare('DELETE FROM production_tasks WHERE sale_id = ?').run(id);
      await db.prepare('DELETE FROM deliveries WHERE sale_id = ?').run(id);
      await db.prepare('DELETE FROM refunds WHERE sale_id = ?').run(id);
      await db.prepare("DELETE FROM payments WHERE sale_id = ? OR reference_number LIKE 'Credit-%' AND sale_id = ?").run(id, id);
      await db.prepare('DELETE FROM sale_items WHERE sale_id = ?').run(id);
      await db.prepare("DELETE FROM audit_logs WHERE entity_type = 'sale' AND entity_id = ?").run(id);
      await db.prepare('DELETE FROM sales WHERE id = ?').run(id);
    } catch (e) { console.error(`   (cleanup warning: sale ${id}: ${e.message})`); }
  }
  for (const id of createdExpenseIds) {
    try { await db.prepare('DELETE FROM expenses WHERE id = ?').run(id); } catch (e) { console.error(`   (cleanup warning: expense ${id}: ${e.message})`); }
  }
  for (const id of createdUserIds) {
    try {
      await db.prepare('DELETE FROM credit_payments WHERE customer_id = ?').run(id);
      await db.prepare('DELETE FROM customer_addresses WHERE customer_id = ?').run(id);
      await db.prepare('DELETE FROM audit_logs WHERE user_id = ?').run(id);
      await db.prepare('DELETE FROM user_locations WHERE user_id = ?').run(id);
      await db.prepare('DELETE FROM users WHERE id = ?').run(id);
    } catch (e) { console.error(`   (cleanup warning: user ${id}: ${e.message})`); }
  }
  // Audit rows on the registers this run opened (close previews)
  for (const id of h.createdRegisterIds) {
    try { await db.prepare("DELETE FROM audit_logs WHERE entity_type = 'cash_register' AND entity_id = ?").run(id); } catch (e) { /* ignore */ }
  }
  console.log(`Cleaned up ${createdSaleIds.length} sale(s), ${createdExpenseIds.length} expense(s), ${createdUserIds.length} user(s)`);
  for (const id of createdProductIds) {
    try { await db.prepare('DELETE FROM products WHERE id = ?').run(id); } catch (e) { console.error(`   (cleanup warning: product ${id}: ${e.message})`); }
  }
  console.log(`Cleaned up ${createdProductIds.length} test product(s)`);
}

h.run({ cleanup });
