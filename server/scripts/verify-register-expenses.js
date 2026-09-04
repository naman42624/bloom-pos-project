#!/usr/bin/env node
/**
 * Live verification of cash register + expense tracking edge cases: a
 * register spanning a calendar-day boundary, multiple sessions in one day,
 * expense attribution across sessions, and cross-location isolation.
 *
 * Modeled on verify-order-flows.js's harness. Extend this file the same
 * way — append checks, never remove another check's coverage.
 *
 * Usage: VERIFY_OWNER_PHONE=... VERIFY_OWNER_PASSWORD=... node server/scripts/verify-register-expenses.js
 */
require('dotenv').config();
const { getDb } = require('../config/database-async');

const API_BASE = process.env.API_BASE_URL || 'http://localhost:3001/api';
const TEST_LOCATION_ID = 4; // "Test Loc"
const OTHER_LOCATION_ID = 1; // "Main Shop" — for cross-location isolation checks

const checks = [];
const createdRegisterIds = [];
const createdExpenseIds = [];
const createdSaleIds = [];

function check(name, fn) {
  checks.push({ name, fn });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertLocalTarget() {
  const isLocalUrl = (url) => {
    try {
      const { hostname } = new URL(url);
      return hostname === 'localhost' || hostname === '127.0.0.1';
    } catch {
      return false;
    }
  };
  const problems = [];
  if (!isLocalUrl(API_BASE)) problems.push(`API_BASE_URL ("${API_BASE}")`);
  const databaseUrl = process.env.DATABASE_URL || '';
  if (!isLocalUrl(databaseUrl)) problems.push(`DATABASE_URL ("${databaseUrl.replace(/:[^:@]*@/, ':***@')}")`);
  if (problems.length > 0) {
    console.error(`❌ Refusing to run: ${problems.join(' and ')} do${problems.length === 1 ? 'es' : ''} not point at localhost/127.0.0.1.`);
    process.exit(1);
  }
}

async function api(method, path, token, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON response */ }
  return { status: res.status, body: json };
}

async function loginOwner() {
  const phone = process.env.VERIFY_OWNER_PHONE;
  const password = process.env.VERIFY_OWNER_PASSWORD;
  if (!phone || !password) throw new Error('VERIFY_OWNER_PHONE and VERIFY_OWNER_PASSWORD must both be set in the environment — no default credentials are used.');
  const { status, body } = await api('POST', '/auth/login', null, { phone, password });
  if (status !== 200 || !body?.data?.token) throw new Error(`Owner login failed: ${status} ${JSON.stringify(body)}`);
  return { token: body.data.token, id: body.data.user.id, role: body.data.user.role };
}

async function ensureClosed(token, locationId) {
  const { body } = await api('GET', `/sales/register/status?location_id=${locationId}`, token);
  if (!body?.isOpen) return;
  await api('PUT', '/sales/register/close', token, { location_id: locationId, actual_cash: Number(body.data.expected_cash) || 0 });
}

async function openRegister(token, locationId, openingBalance) {
  await ensureClosed(token, locationId);
  const { status, body } = await api('POST', '/sales/register/open', token, { location_id: locationId, opening_balance: openingBalance });
  assert(status === 201, `Could not open register: ${status} ${JSON.stringify(body)}`);
  createdRegisterIds.push(body.data.id);
  return body.data;
}

async function closeRegisterWith(token, locationId, actualCash) {
  const { status, body } = await api('PUT', '/sales/register/close', token, { location_id: locationId, actual_cash: actualCash });
  assert(status === 200, `Could not close register: ${status} ${JSON.stringify(body)}`);
  return body.data;
}

module.exports = { check, checks, api, loginOwner, ensureClosed, openRegister, closeRegisterWith, assert, TEST_LOCATION_ID, OTHER_LOCATION_ID, createdRegisterIds, createdExpenseIds, createdSaleIds, getDb, assertLocalTarget };

// ─── Smoke test ───────────────────────────────────────────────
check('harness smoke test: owner login + open/close a register', async () => {
  const owner = await loginOwner();
  const reg = await openRegister(owner.token, TEST_LOCATION_ID, 1000);
  assert(reg.status === 'open', `Expected 'open', got '${reg.status}'`);
  const closed = await closeRegisterWith(owner.token, TEST_LOCATION_ID, 1000);
  assert(closed.status === 'closed', `Expected 'closed', got '${closed.status}'`);
});

// ═══════════════════════════════════════════════════════════════
// Day-boundary: a register opened "yesterday" still open today
// ═══════════════════════════════════════════════════════════════

// Backdates a just-opened register's opened_at/opening_time/date to
// yesterday, simulating one that's been open overnight — without needing to
// actually wait for midnight.
async function backdateToYesterday(registerId) {
  const db = await getDb();
  await db.prepare(`
    UPDATE cash_registers SET
      opened_at = opened_at - INTERVAL '1 day',
      opening_time = opening_time - INTERVAL '1 day',
      date = date - INTERVAL '1 day'
    WHERE id = ?
  `).run(registerId);
}

check('GET /register/status reports isOpen=true for a register opened yesterday and never closed', async () => {
  const owner = await loginOwner();
  const reg = await openRegister(owner.token, TEST_LOCATION_ID, 1000);
  await backdateToYesterday(reg.id);
  const { body } = await api('GET', `/sales/register/status?location_id=${TEST_LOCATION_ID}`, owner.token);
  assert(body.isOpen === true, `Expected isOpen=true for a still-open register regardless of when it opened, got ${body.isOpen}`);
  assert(body.data.id === reg.id, `Expected the SAME register to be returned, got id ${body.data.id} instead of ${reg.id}`);
});

check('POST /register/open correctly refuses a second open while yesterday\'s session is still open (no false "already closed" confusion)', async () => {
  const owner = await loginOwner();
  const reg = await openRegister(owner.token, TEST_LOCATION_ID, 1000);
  await backdateToYesterday(reg.id);
  const res = await api('POST', '/sales/register/open', owner.token, { location_id: TEST_LOCATION_ID, opening_balance: 500 });
  assert(res.status === 409, `Expected 409 (already open), got ${res.status}: ${JSON.stringify(res.body)}`);
});

check('FINDING: todaySessions omits a register that opened yesterday and is still open (informational list only, not the open/closed determination)', async () => {
  const owner = await loginOwner();
  const reg = await openRegister(owner.token, TEST_LOCATION_ID, 1000);
  await backdateToYesterday(reg.id);
  const { body } = await api('GET', `/sales/register/status?location_id=${TEST_LOCATION_ID}`, owner.token);
  const inTodaySessions = (body.todaySessions || []).some((s) => s.id === reg.id);
  assert(inTodaySessions === false, `(finding context) Expected the yesterday-dated register to be ABSENT from todaySessions (its 'date' column is yesterday's) — got present=${inTodaySessions}. This is a secondary informational list; isOpen itself is correct (see the check above).`);
});

check('close correctly sums a session spanning two calendar dates — nothing lost or double-counted at the boundary', async () => {
  const owner = await loginOwner();
  const reg = await openRegister(owner.token, TEST_LOCATION_ID, 1000);
  await backdateToYesterday(reg.id);
  // Baseline: what the close math already sees BEFORE this test's own
  // transactions, from whatever real activity happened at this location
  // since the (backdated) session start — Test Loc has plenty of history
  // from earlier testing today, so asserting an absolute total would be
  // wrong. What matters is that adding one known sale + one known expense
  // moves the totals by EXACTLY that much — proving the boundary-spanning
  // window neither drops nor double-counts them.
  const db = await getDb();
  // Re-fetch after backdating — `reg` (the API response) still holds the
  // PRE-backdate opening_time; using it here would compute a baseline
  // window starting at "now" instead of "yesterday", missing the exact
  // stray history the real close call (which re-reads the row fresh) picks
  // up. This was the test's own bug on the first attempt at this check.
  const regRow = await db.prepare('SELECT opening_time, opened_at FROM cash_registers WHERE id = ?').get(reg.id);
  const sessionStart = regRow.opening_time || regRow.opened_at;
  // Mirrors the server's own three-part cash total exactly (PUT
  // /sales/register/close) — direct payments + credit payments + COD
  // settlements — so this baseline is apples-to-apples with what close
  // will report, regardless of how much unrelated history already exists
  // at this heavily-reused test location.
  const directCash = Number((await db.prepare(`
    SELECT COALESCE(SUM(p.amount), 0) as total FROM payments p JOIN sales s ON p.sale_id = s.id
    WHERE s.location_id = ? AND p.method = 'cash' AND p.created_at >= ? AND s.status != 'cancelled'
      AND (p.reference_number IS NULL OR (p.reference_number NOT LIKE 'Credit-%' AND p.reference_number != 'COD' AND p.reference_number NOT LIKE 'COD-%'))
  `).get(TEST_LOCATION_ID, sessionStart)).total);
  const creditCash = Number((await db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM credit_payments
    WHERE location_id = ? AND payment_method = 'cash' AND created_at >= ? AND payment_method != 'write_off'
  `).get(TEST_LOCATION_ID, sessionStart)).total);
  const codCash = Number((await db.prepare(`
    SELECT COALESCE(SUM(total_amount), 0) as total FROM delivery_settlements
    WHERE location_id = ? AND verified_at >= ? AND status = 'verified'
  `).get(TEST_LOCATION_ID, sessionStart)).total);
  const baselineCash = directCash + creditCash + codCash;
  const baselineRefunds = Number((await db.prepare(`
    SELECT COALESCE(SUM(r.amount), 0) as total FROM refunds r JOIN sales s ON r.sale_id = s.id
    WHERE s.location_id = ? AND r.created_at >= ? AND r.refund_method = 'cash' AND COALESCE(r.status, 'processed') = 'processed' AND s.status != 'cancelled'
  `).get(TEST_LOCATION_ID, sessionStart)).total);
  const baselineExpenses = Number((await db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN is_return = 1 THEN -amount ELSE amount END), 0) as total FROM expenses
    WHERE payment_method = 'cash' AND (register_id = ? OR (register_id IS NULL AND location_id = ? AND created_at >= ?))
  `).get(reg.id, TEST_LOCATION_ID, sessionStart)).total);

  // "Yesterday's" cash sale + expense (both real transactions, just against
  // a backdated session — the close math is timestamp-scoped from
  // session.opening_time, not calendar-date-scoped, so both must count).
  await api('POST', '/sales', owner.token, {
    location_id: TEST_LOCATION_ID, order_type: 'walk_in', channel: 'walk_in',
    items: [{ quantity: 1, unit_price: 400, product_name: 'Test Overnight Sale' }],
    payments: [{ method: 'cash', amount: 400 }],
  });
  const expRes = await api('POST', '/expenses', owner.token, {
    location_id: TEST_LOCATION_ID, category: 'supplies', amount: 150, payment_method: 'cash',
    expense_date: new Date().toISOString().slice(0, 10), description: 'Test overnight expense',
  });
  assert(expRes.status === 201, `Expense creation failed: ${JSON.stringify(expRes.body)}`);
  createdExpenseIds.push(expRes.body.data.id);

  // actual_cash is irrelevant to what's being tested here (it's staff's own
  // physical count) — pass expected math back so discrepancy comes out 0
  // regardless of what the pre-existing baseline was.
  const expectedCashGuess = 1000 + (baselineCash + 400) - baselineRefunds - (baselineExpenses + 150);
  const closed = await closeRegisterWith(owner.token, TEST_LOCATION_ID, expectedCashGuess);
  assert(Number(closed.total_cash_sales) === baselineCash + 400, `Expected total_cash_sales to increase by exactly 400 over the ${baselineCash} baseline, got ${closed.total_cash_sales}`);
  assert(Number(closed.expected_cash) === expectedCashGuess, `Expected expected_cash ${expectedCashGuess}, got ${closed.expected_cash}`);
  assert(Number(closed.discrepancy) === 0, `Expected discrepancy 0 (actual matched expected), got ${closed.discrepancy}`);
});

// ═══════════════════════════════════════════════════════════════
// Multiple sessions in one calendar day — isolation
// ═══════════════════════════════════════════════════════════════

check('two sessions same day: session 2\'s close does NOT include session 1\'s expense (no backward leakage)', async () => {
  const owner = await loginOwner();
  await openRegister(owner.token, TEST_LOCATION_ID, 1000);
  const exp1 = await api('POST', '/expenses', owner.token, {
    location_id: TEST_LOCATION_ID, category: 'supplies', amount: 100, payment_method: 'cash',
    expense_date: new Date().toISOString().slice(0, 10), description: 'Test session-1 expense',
  });
  createdExpenseIds.push(exp1.body.data.id);
  await closeRegisterWith(owner.token, TEST_LOCATION_ID, 900); // 1000 - 100

  const reg2 = await openRegister(owner.token, TEST_LOCATION_ID, 500);
  const exp2 = await api('POST', '/expenses', owner.token, {
    location_id: TEST_LOCATION_ID, category: 'supplies', amount: 50, payment_method: 'cash',
    expense_date: new Date().toISOString().slice(0, 10), description: 'Test session-2 expense',
  });
  createdExpenseIds.push(exp2.body.data.id);
  assert(exp2.body.data.register_id === reg2.id, `Expected the new expense to be tagged with session 2's register (${reg2.id}), got ${exp2.body.data.register_id}`);

  const closed2 = await closeRegisterWith(owner.token, TEST_LOCATION_ID, 450); // 500 - 50
  assert(Number(closed2.expected_cash) === 450, `Expected session 2's expected_cash to reflect ONLY its own expense (500-50=450), got ${closed2.expected_cash} — a value of 350 (500-100-50) would mean session 1's expense leaked in`);
  assert(Number(closed2.discrepancy) === 0, `Expected discrepancy 0, got ${closed2.discrepancy}`);
});

check('FIXED: deleting a cash expense from an already-CLOSED session adjusts THAT session\'s expected_cash (not the currently-open one) AND recomputes its discrepancy — actual_cash stays frozen (a real physical count)', async () => {
  const owner = await loginOwner();
  await openRegister(owner.token, TEST_LOCATION_ID, 1000);
  const exp1 = await api('POST', '/expenses', owner.token, {
    location_id: TEST_LOCATION_ID, category: 'supplies', amount: 200, payment_method: 'cash',
    expense_date: new Date().toISOString().slice(0, 10), description: 'Test delete-after-close expense',
  });
  const expenseId = exp1.body.data.id;
  const session1RegisterId = exp1.body.data.register_id;
  const closed1 = await closeRegisterWith(owner.token, TEST_LOCATION_ID, 800); // 1000 - 200
  assert(Number(closed1.expected_cash) === 800, `Expected 800, got ${closed1.expected_cash}`);
  assert(Number(closed1.discrepancy) === 0, `Expected discrepancy 0 at close, got ${closed1.discrepancy}`);

  // A new session opens (today's normal counter workflow) BEFORE anyone
  // notices the mistaken expense from the last session.
  const reg2 = await openRegister(owner.token, TEST_LOCATION_ID, 300);

  // Now delete the OLD expense (owner catches the mistake after the fact).
  const delRes = await api('DELETE', `/expenses/${expenseId}`, owner.token);
  assert(delRes.status === 200, `Delete failed: ${JSON.stringify(delRes.body)}`);

  const db = await getDb();
  const session1After = await db.prepare('SELECT expected_cash, discrepancy, actual_cash FROM cash_registers WHERE id = ?').get(session1RegisterId);
  const session2After = await db.prepare('SELECT expected_cash FROM cash_registers WHERE id = ?').get(reg2.id);

  // The fix: reversal correctly targets session 1 (session-exact register_id), not session 2.
  assert(Number(session2After.expected_cash) === 300, `Expected session 2 (currently open, unrelated) to be UNTOUCHED at 300, got ${session2After.expected_cash} — reversal hit the wrong register`);
  assert(Number(session1After.expected_cash) === 1000, `Expected session 1's expected_cash to be reversed back to 1000 (200 expense un-recorded), got ${session1After.expected_cash}`);
  // The fix: session 1 was closed with discrepancy=0 against
  // expected_cash=800/actual_cash=800. expected_cash moved to 1000 (the
  // deletion above); discrepancy must move WITH it (1000-800=200) rather
  // than staying frozen at the old, now-wrong value of 0. actual_cash is a
  // real physical count from that close and must never change.
  assert(Number(session1After.actual_cash) === 800, `Expected actual_cash to stay frozen at 800 (a real physical count), got ${session1After.actual_cash}`);
  assert(Number(session1After.discrepancy) === 200, `Expected discrepancy to recompute to 200 (1000 expected - 800 actual), got ${session1After.discrepancy}`);

  await closeRegisterWith(owner.token, TEST_LOCATION_ID, 300); // clean up session 2
});

check('cash expense blocked when no register is open; non-cash expense allowed regardless, with no register_id', async () => {
  const owner = await loginOwner();
  await ensureClosed(owner.token, TEST_LOCATION_ID);
  const cashRes = await api('POST', '/expenses', owner.token, {
    location_id: TEST_LOCATION_ID, category: 'supplies', amount: 75, payment_method: 'cash',
    expense_date: new Date().toISOString().slice(0, 10), description: 'Test cash-no-register',
  });
  assert(cashRes.status === 400, `Expected 400 (register closed), got ${cashRes.status}: ${JSON.stringify(cashRes.body)}`);

  const upiRes = await api('POST', '/expenses', owner.token, {
    location_id: TEST_LOCATION_ID, category: 'supplies', amount: 75, payment_method: 'upi',
    expense_date: new Date().toISOString().slice(0, 10), description: 'Test upi-no-register',
  });
  assert(upiRes.status === 201, `Expected 201 (non-cash unaffected by register state), got ${upiRes.status}: ${JSON.stringify(upiRes.body)}`);
  createdExpenseIds.push(upiRes.body.data.id);
  assert(upiRes.body.data.register_id === null, `Expected register_id NULL for a non-cash expense, got ${upiRes.body.data.register_id}`);
});

check('GET /expenses reports which session a cash expense belongs to (register_opened_at) — session visibility for the multi-session-a-day case', async () => {
  const owner = await loginOwner();
  const reg = await openRegister(owner.token, TEST_LOCATION_ID, 1000);
  const expRes = await api('POST', '/expenses', owner.token, {
    location_id: TEST_LOCATION_ID, category: 'supplies', amount: 40, payment_method: 'cash',
    expense_date: new Date().toISOString().slice(0, 10), description: 'Test session-visibility expense',
  });
  createdExpenseIds.push(expRes.body.data.id);
  const today = new Date().toISOString().slice(0, 10);
  const listRes = await api('GET', `/expenses?location_id=${TEST_LOCATION_ID}&start_date=${today}&end_date=${today}`, owner.token);
  const row = (listRes.body.data || []).find((e) => e.id === expRes.body.data.id);
  assert(row, 'Expected the new expense to appear in the list');
  assert(!!row.register_opened_at, `Expected register_opened_at to be populated, got ${row.register_opened_at}`);
  await closeRegisterWith(owner.token, TEST_LOCATION_ID, 960); // 1000 - 40
});

check('cross-location isolation: a cash expense at one location does not affect another location\'s register', async () => {
  const owner = await loginOwner();
  await openRegister(owner.token, TEST_LOCATION_ID, 1000);
  const { body: mainBefore } = await api('GET', `/sales/register/status?location_id=${OTHER_LOCATION_ID}`, owner.token);
  const mainWasOpen = !!mainBefore?.isOpen;
  const mainExpectedBefore = mainWasOpen ? Number(mainBefore.data.expected_cash) : null;

  const expRes = await api('POST', '/expenses', owner.token, {
    location_id: TEST_LOCATION_ID, category: 'supplies', amount: 60, payment_method: 'cash',
    expense_date: new Date().toISOString().slice(0, 10), description: 'Test cross-location isolation',
  });
  assert(expRes.status === 201, `Expense creation failed: ${JSON.stringify(expRes.body)}`);
  createdExpenseIds.push(expRes.body.data.id);

  if (mainWasOpen) {
    const { body: mainAfter } = await api('GET', `/sales/register/status?location_id=${OTHER_LOCATION_ID}`, owner.token);
    assert(Number(mainAfter.data.expected_cash) === mainExpectedBefore, `Expected Main Shop's register to be untouched by a Test Loc expense, went from ${mainExpectedBefore} to ${mainAfter.data.expected_cash}`);
  }
  await closeRegisterWith(owner.token, TEST_LOCATION_ID, 940); // 1000 - 60
});

check('FIXED: a delivery order with a cash advance + UPI-collected COD closes with zero discrepancy (close no longer double-counts the UPI settlement as cash)', async () => {
  const owner = await loginOwner();
  await openRegister(owner.token, TEST_LOCATION_ID, 1000);

  // grand_total 1000, 500 cash advance at creation, 500 remaining as COD —
  // the exact scenario reported live: order for ₹1000, ₹500 paid now
  // (cash), ₹500 kept as COD, then collected via UPI on delivery.
  const { body: saleBody } = await api('POST', '/sales', owner.token, {
    location_id: TEST_LOCATION_ID, order_type: 'delivery', channel: 'phone',
    delivery_address: 'Test Discrepancy Regression St', receiver_name: 'Test', receiver_phone: '9998887777',
    items: [{ quantity: 1, unit_price: 1000, product_name: 'Test Discrepancy Regression Item' }],
    payments: [{ method: 'cash', amount: 500 }],
  });
  const saleId = saleBody.data.id;
  createdSaleIds.push(saleId);
  assert(saleBody.data.payment_status === 'partial', `Expected 'partial', got '${saleBody.data.payment_status}'`);

  await api('PUT', `/sales/${saleId}/status`, owner.token, { status: 'preparing' });
  const tasksRes = await api('GET', `/production/tasks?sale_id=${saleId}`, owner.token);
  const task = tasksRes.body.data.find((t) => t.sale_id === saleId);
  await api('PUT', `/production/tasks/${task.id}/complete`, owner.token);
  const saleAfter = await api('GET', `/sales/${saleId}`, owner.token);
  const deliveryId = saleAfter.body.data.delivery.id;
  assert(Number(saleAfter.body.data.delivery.cod_amount) === 500, `Expected cod_amount 500, got ${saleAfter.body.data.delivery.cod_amount}`);

  await api('PUT', `/deliveries/${deliveryId}/assign`, owner.token, { delivery_partner_id: 9 });
  await api('PUT', `/deliveries/${deliveryId}/pickup`, owner.token, {});

  const { body: regBeforeDeliver } = await api('GET', `/sales/register/status?location_id=${TEST_LOCATION_ID}`, owner.token);
  const expectedAfterAdvance = Number(regBeforeDeliver.data.expected_cash);

  await api('PUT', `/deliveries/${deliveryId}/deliver`, owner.token, { cod_collected: 500, cod_method: 'upi' });
  const settleRes = await api('POST', '/deliveries/settlements/settle-now', owner.token, { delivery_partner_id: 9, delivery_ids: [deliveryId] });
  assert(settleRes.body.data.by_method?.cash === 0 && settleRes.body.data.by_method?.upi === 500, `Expected by_method {cash:0,upi:500}, got ${JSON.stringify(settleRes.body.data.by_method)}`);

  const { body: regAfterSettle } = await api('GET', `/sales/register/status?location_id=${TEST_LOCATION_ID}`, owner.token);
  assert(Number(regAfterSettle.data.expected_cash) === expectedAfterAdvance, `Expected expected_cash unchanged by the UPI settlement (still ${expectedAfterAdvance}), got ${regAfterSettle.data.expected_cash}`);

  // The actual bug: physically count exactly what's really in the drawer
  // (the 500 cash advance, nothing from the UPI COD) and close.
  const closed = await closeRegisterWith(owner.token, TEST_LOCATION_ID, expectedAfterAdvance);
  assert(Number(closed.discrepancy) === 0, `Expected discrepancy 0, got ${closed.discrepancy} — the close route double-counted the UPI settlement as cash if this is nonzero`);
  assert(Number(closed.total_cash_sales) === 500, `Expected total_cash_sales 500 (only the real cash advance), got ${closed.total_cash_sales}`);
  assert(Number(closed.total_upi_sales) >= 500, `Expected total_upi_sales to include the 500 UPI COD settlement, got ${closed.total_upi_sales}`);
});

check('multi-delivery batched settlement: TWO deliveries collected via DIFFERENT methods, settled together in one settle-now call, split correctly on close', async () => {
  const owner = await loginOwner();
  await openRegister(owner.token, TEST_LOCATION_ID, 0);

  async function createAndDeliver(codAmount, codMethod) {
    const { body: saleBody } = await api('POST', '/sales', owner.token, {
      location_id: TEST_LOCATION_ID, order_type: 'delivery', channel: 'phone',
      delivery_address: 'Test Multi-Settlement St', receiver_name: 'Test', receiver_phone: '9998887777',
      items: [{ quantity: 1, unit_price: codAmount, product_name: 'Test Multi-Settlement Item' }],
    });
    const saleId = saleBody.data.id;
    createdSaleIds.push(saleId);
    await api('PUT', `/sales/${saleId}/status`, owner.token, { status: 'preparing' });
    const tasksRes = await api('GET', `/production/tasks?sale_id=${saleId}`, owner.token);
    const task = tasksRes.body.data.find((t) => t.sale_id === saleId);
    await api('PUT', `/production/tasks/${task.id}/complete`, owner.token);
    const saleAfter = await api('GET', `/sales/${saleId}`, owner.token);
    const deliveryId = saleAfter.body.data.delivery.id;
    await api('PUT', `/deliveries/${deliveryId}/assign`, owner.token, { delivery_partner_id: 9 });
    await api('PUT', `/deliveries/${deliveryId}/pickup`, owner.token, {});
    await api('PUT', `/deliveries/${deliveryId}/deliver`, owner.token, { cod_collected: codAmount, cod_method: codMethod });
    return deliveryId;
  }

  // Delivery A collected in cash (300), Delivery B collected in UPI (400) —
  // both handed to the shop and settled TOGETHER in one batch, the shape
  // sumCollectionsByMethod must aggregate correctly across multiple
  // deliveries at once, not just the single-delivery case already covered
  // above.
  const deliveryA = await createAndDeliver(300, 'cash');
  const deliveryB = await createAndDeliver(400, 'upi');

  const settleRes = await api('POST', '/deliveries/settlements/settle-now', owner.token, { delivery_partner_id: 9, delivery_ids: [deliveryA, deliveryB] });
  assert(settleRes.status === 201, `Settle failed: ${JSON.stringify(settleRes.body)}`);
  assert(settleRes.body.data.by_method?.cash === 300 && settleRes.body.data.by_method?.upi === 400, `Expected by_method {cash:300,upi:400}, got ${JSON.stringify(settleRes.body.data.by_method)}`);

  const closed = await closeRegisterWith(owner.token, TEST_LOCATION_ID, 300);
  assert(Number(closed.discrepancy) === 0, `Expected discrepancy 0 (300 cash physically counted matches the 300 cash-method settlement), got ${closed.discrepancy}`);
  assert(Number(closed.total_cash_sales) === 300, `Expected total_cash_sales 300 (only delivery A's cash), got ${closed.total_cash_sales}`);
  assert(Number(closed.total_upi_sales) === 400, `Expected total_upi_sales 400 (only delivery B's upi), got ${closed.total_upi_sales}`);
});

// ─── Run ──────────────────────────────────────────────────────
async function cleanup() {
  if (createdExpenseIds.length === 0 && createdRegisterIds.length === 0 && createdSaleIds.length === 0) return;
  const db = await getDb();
  for (const saleId of createdSaleIds) {
    try {
      await db.prepare('DELETE FROM delivery_settlement_items WHERE delivery_id IN (SELECT id FROM deliveries WHERE sale_id = ?)').run(saleId);
      await db.prepare('DELETE FROM delivery_collections WHERE delivery_id IN (SELECT id FROM deliveries WHERE sale_id = ?)').run(saleId);
      await db.prepare('DELETE FROM deliveries WHERE sale_id = ?').run(saleId);
      await db.prepare('DELETE FROM production_tasks WHERE sale_id = ?').run(saleId);
      await db.prepare('DELETE FROM payments WHERE sale_id = ?').run(saleId);
      await db.prepare('DELETE FROM sale_items WHERE sale_id = ?').run(saleId);
      await db.prepare('DELETE FROM sales WHERE id = ?').run(saleId);
    } catch (err) {
      console.error(`   (cleanup warning: sale ${saleId}: ${err.message})`);
    }
  }
  try {
    await db.prepare('DELETE FROM delivery_settlements WHERE id NOT IN (SELECT DISTINCT settlement_id FROM delivery_settlement_items)').run();
  } catch (err) {
    console.error(`   (cleanup warning: orphaned settlements: ${err.message})`);
  }
  for (const expenseId of createdExpenseIds) {
    try { await db.prepare('DELETE FROM expenses WHERE id = ?').run(expenseId); } catch (err) {
      console.error(`   (cleanup warning: expense ${expenseId}: ${err.message})`);
    }
  }
  for (const registerId of createdRegisterIds) {
    try { await db.prepare('DELETE FROM cash_registers WHERE id = ?').run(registerId); } catch (err) {
      console.error(`   (cleanup warning: register ${registerId}: ${err.message})`);
    }
  }
  console.log(`Cleaned up ${createdSaleIds.length} test sale(s), ${createdExpenseIds.length} test expense(s), and ${createdRegisterIds.length} test register session(s)`);
}

async function main() {
  assertLocalTarget();
  let pass = 0, fail = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      console.log(`✅ ${name}`);
      pass++;
    } catch (err) {
      console.log(`❌ ${name}`);
      console.log(`   ${err.message}`);
      fail++;
    }
  }
  await cleanup();
  console.log(`\n${pass}/${pass + fail} checks passed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
