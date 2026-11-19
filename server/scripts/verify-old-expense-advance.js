#!/usr/bin/env node
/**
 * Live verification of POST /api/expenses/:id/salary-advance (PR 2):
 * the owner turns an old plain expense into a salary advance.
 * Test rows are named VerifyOEA. Cleanup removes only rows this run made.
 *
 * Usage: cd server && node scripts/verify-old-expense-advance.js
 */
require('dotenv').config();
const jwt = require('jsonwebtoken');
const { getDb } = require('../config/database-async');

const API_BASE = process.env.API_BASE_URL || 'http://localhost:3001/api';
const TEST_LOCATION_ID = 4; // Test Loc

const TOO_OLD = 'Only expenses from the last 60 days can be marked as a salary advance.';
const METHOD = 'Only a Cash or UPI expense can be marked as a salary advance.';
const NOT_PLAIN = "This expense is linked to shopping money, a km account or money the shop owes, so it can't be marked as a salary advance.";
const RETURN = "A return can't be marked as a salary advance.";
const ALREADY = 'This is already a salary entry. Pull down to refresh.';
const PERSON = 'Pick the employee this money was given to.';
const ADVANCE_TAKEN = "This advance was already taken from pay, so it can't be changed or removed.";

const checks = [];
const createdUserIds = [];
const createdExpenseIds = [];
const createdRegisterIds = [];
const createdSalaryPaymentIds = [];
const createdMoneyOutIds = [];
const createdOwesIds = [];

function check(name, fn) { checks.push({ name, fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg}: got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`); }
function skip(msg) { const e = new Error(msg); e.skip = true; return e; }

function assertLocalTarget() {
  const isLocal = (u) => { try { const h = new URL(u).hostname; return h === 'localhost' || h === '127.0.0.1'; } catch { return false; } };
  const bad = [];
  if (!isLocal(API_BASE)) bad.push('API_BASE_URL');
  if (!isLocal(process.env.DATABASE_URL || '')) bad.push('DATABASE_URL');
  if (bad.length) { console.error(`Refusing to run: ${bad.join(', ')} not local.`); process.exit(1); }
}

function tokenFor(id) { return jwt.sign({ id }, process.env.JWT_SECRET); }

async function api(method, path, userId, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(userId ? { Authorization: `Bearer ${tokenFor(userId)}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body: json };
}

function shopDay(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

async function makeUser(db, { role, name, location = TEST_LOCATION_ID, active = 1 }) {
  const phone = 'oea' + Date.now() + Math.floor(Math.random() * 1e6);
  const row = await db.prepare(
    'INSERT INTO users (phone, password, name, role, is_active) VALUES (?, ?, ?, ?, ?) RETURNING id'
  ).get(phone, 'x', name, role, active);
  createdUserIds.push(row.id);
  if (location) await db.prepare('INSERT INTO user_locations (user_id, location_id) VALUES (?, ?)').run(row.id, location);
  return row.id;
}

let cast = null;
async function getCast() {
  if (cast) return cast;
  const db = await getDb();
  cast = {
    owner: await makeUser(db, { role: 'owner', name: 'VerifyOEA Owner', location: null }),
    manager: await makeUser(db, { role: 'manager', name: 'VerifyOEA Manager' }),
    counter: await makeUser(db, { role: 'counter_staff', name: 'VerifyOEA Counter' }),
    helper: await makeUser(db, { role: 'helper', name: 'VerifyOEA Helper' }),
    emp: await makeUser(db, { role: 'employee', name: 'VerifyOEA Emp' }),
    emp2: await makeUser(db, { role: 'florist_staff', name: 'VerifyOEA Emp Two' }),
    customer: await makeUser(db, { role: 'customer', name: 'VerifyOEA Customer', location: null }),
    inactive: await makeUser(db, { role: 'employee', name: 'VerifyOEA Gone', active: 0 }),
  };
  await db.prepare("UPDATE users SET access_until = CAST(? AS date) + 30 WHERE id = ?").run(shopDay(0), cast.helper);
  await db.prepare('INSERT INTO employee_salaries (user_id, monthly_salary, updated_by) VALUES (?, 5000, ?)').run(cast.emp, cast.owner);
  return cast;
}

// A plain expense written straight to the table (made by counter staff).
async function makeExpense({ amount = 500, method = 'upi', daysAgo = 10, registerId = null, isReturn = 0, category = 'supplies', moneyOutId = null, description = 'VerifyOEA flowers' } = {}) {
  const c = await getCast();
  const db = await getDb();
  const row = await db.prepare(`
    INSERT INTO expenses (location_id, category, amount, description, payment_method, expense_date,
      created_by, register_id, is_return, money_out_id, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL) RETURNING id
  `).get(TEST_LOCATION_ID, category, amount, description, method, shopDay(-daysAgo), c.counter, registerId, isReturn, moneyOutId);
  createdExpenseIds.push(row.id);
  return row.id;
}

const expRow = async (id) => (await getDb()).prepare('SELECT * FROM expenses WHERE id = ?').get(id);
const advFor = async (expenseId) => (await getDb()).prepare('SELECT * FROM salary_advances WHERE expense_id = ?').all(expenseId);
const regJson = async (id) => JSON.stringify(await (await getDb()).prepare('SELECT * FROM cash_registers WHERE id = ?').get(id));
const mark = (id, userId, body) => api('POST', `/expenses/${id}/salary-advance`, userId, body);

async function testLocRegister() {
  return (await getDb()).prepare('SELECT id, expected_cash FROM cash_registers WHERE location_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1').get(TEST_LOCATION_ID);
}
async function openOwnRegister() {
  const c = await getCast();
  const open = await testLocRegister();
  if (open) {
    if (createdRegisterIds.includes(open.id)) return open.id;
    throw skip(`Test Loc register #${open.id} is open and is not this run's; skipped.`);
  }
  const op = await api('POST', '/sales/register/open', c.owner, { location_id: TEST_LOCATION_ID, opening_balance: 5000 });
  assert(op.status === 201, `open ${op.status} ${JSON.stringify(op.body)}`);
  createdRegisterIds.push(op.body.data.id);
  return op.body.data.id;
}
async function closeOwnRegister() {
  const c = await getCast();
  const open = await testLocRegister();
  if (!open || !createdRegisterIds.includes(open.id)) return;
  const r = await api('PUT', '/sales/register/close', c.owner, { location_id: TEST_LOCATION_ID, actual_cash: Math.max(0, Number(open.expected_cash) || 0) });
  assert(r.status === 200, `close ${r.status} ${JSON.stringify(r.body)}`);
}

let firstExpenseId = null;
let firstAdvanceId = null;

// 1
check('owner marks a ₹500 UPI expense from 10 days ago for an employee on ₹5,000', async () => {
  const c = await getCast();
  const id = await makeExpense({ amount: 500, method: 'upi', daysAgo: 10 });
  const before = await expRow(id);
  const r = await mark(id, c.owner, { employee_id: c.emp });
  eq(r.status, 200, 'status ' + JSON.stringify(r.body));
  const out = r.body.data;
  assert(out && out.expense && out.advance_id, 'shape ' + JSON.stringify(r.body));
  eq(Number(out.expense.id), id, 'returned expense id');
  assert(out.expense.location_name && 'given_to_display' in out.expense, 'expense row not in GET shape');
  eq(out.expense.given_to_display, 'VerifyOEA Emp', 'given_to_display');
  const e = await expRow(id);
  eq(e.category, 'salary', 'category');
  eq(Number(e.employee_id), c.emp, 'employee_id');
  eq(Number(e.given_to_user_id), c.emp, 'given_to_user_id');
  eq(e.given_to_name, null, 'given_to_name');
  eq(e.item_id, null, 'item_id');
  eq(e.description, 'Salary advance — VerifyOEA Emp (was: VerifyOEA flowers)', 'description');
  assert(e.description.startsWith('Salary advance — '), 'description prefix');
  eq(Number(e.amount), Number(before.amount), 'amount');
  eq(e.payment_method, before.payment_method, 'method');
  eq(String(e.expense_date), String(before.expense_date), 'date');
  eq(e.register_id, before.register_id, 'register_id');
  eq(Number(e.created_by), Number(before.created_by), 'created_by');
  const advs = await advFor(id);
  eq(advs.length, 1, 'advance rows');
  const a = advs[0];
  eq(Number(a.id), Number(out.advance_id), 'advance_id');
  eq(Number(a.user_id), c.emp, 'adv user');
  eq(a.status, 'approved', 'adv status');
  eq(a.source, 'old_expense', 'adv source');
  eq(Number(a.repaid_amount), 0, 'adv repaid');
  eq(Number(a.amount), 500, 'adv amount');
  eq(a.payment_method, 'upi', 'adv method');
  eq(Number(a.location_id), TEST_LOCATION_ID, 'adv location');
  eq(String(a.date).slice(0, 10), shopDay(-10), 'adv date');
  eq(Number(a.given_by), c.counter, 'adv given_by');
  eq(Number(a.approved_by), c.owner, 'adv approved_by');
  eq(a.reason, 'Old expense marked as salary advance', 'adv reason');
  firstExpenseId = id;
  firstAdvanceId = Number(a.id);
});

// 2
check('payroll now cuts it', async () => {
  const c = await getCast();
  const r = await api('POST', '/staff/payroll/calculate', c.owner, { user_id: c.emp, period_start: shopDay(-30), period_end: shopDay(0) });
  eq(r.status, 200, 'calculate ' + JSON.stringify(r.body));
  const d = r.body.data;
  const pending = (d.calculation || {}).pending_advances;
  eq(Number(pending), 500, 'pending_advances');
});

// 3
check('no drawer move', async () => {
  const c = await getCast();
  const reg = await openOwnRegister();
  const id = await makeExpense({ amount: 200, method: 'cash', daysAgo: 0, registerId: reg });
  const before = await regJson(reg);
  const r = await mark(id, c.owner, { employee_id: c.emp2 });
  eq(r.status, 200, 'status ' + JSON.stringify(r.body));
  eq(await regJson(reg), before, 'open register row changed');
  eq((await expRow(id)).register_id, reg, 'expense register_id');
  eq((await advFor(id))[0].payment_method, 'cash', 'adv method');
  await closeOwnRegister();
});

// 4
check('closed register untouched', async () => {
  const c = await getCast();
  const reg = await openOwnRegister();
  const id = await makeExpense({ amount: 150, method: 'cash', daysAgo: 0, registerId: reg });
  await closeOwnRegister();
  const before = await regJson(reg);
  assert(JSON.parse(before).closed_at, 'register not closed');
  const r = await mark(id, c.owner, { employee_id: c.emp2 });
  eq(r.status, 200, 'status ' + JSON.stringify(r.body));
  eq(await regJson(reg), before, 'closed register row changed');
});

// 5
check('preview writes nothing and warns', async () => {
  const c = await getCast();
  const db = await getDb();
  const id = await makeExpense({ amount: 300, method: 'cash', daysAgo: 12 });
  const sp = await db.prepare(`
    INSERT INTO salary_payments (user_id, period_start, period_end, net_amount, status, paid_at, notes)
    VALUES (?, ?, ?, 4200, 'paid', ?, 'VerifyOEA') RETURNING id
  `).get(c.emp2, shopDay(-40), shopDay(-6), shopDay(-5));
  createdSalaryPaymentIds.push(sp.id);
  const before = JSON.stringify(await expRow(id));
  const advCount = async () => Number((await db.prepare('SELECT COUNT(*) AS n FROM salary_advances').get()).n);
  const expCount = async () => Number((await db.prepare('SELECT COUNT(*) AS n FROM expenses').get()).n);
  const a0 = await advCount(); const e0 = await expCount();
  const r = await mark(id, c.owner, { employee_id: c.emp2, preview: true });
  eq(r.status, 200, 'status ' + JSON.stringify(r.body));
  const d = r.body.data;
  eq(Number(d.expense_id), id, 'expense_id');
  eq(Number(d.amount), 300, 'amount');
  eq(d.expense_date, shopDay(-12), 'expense_date');
  eq(Number(d.employee.id), c.emp2, 'employee id');
  eq(d.employee.name, 'VerifyOEA Emp Two', 'employee name');
  assert(Array.isArray(d.salary_paid_after), 'salary_paid_after not a list');
  eq(d.salary_paid_after.length, 1, 'salary_paid_after');
  eq(Number(d.salary_paid_after[0].id), Number(sp.id), 'paid id');
  eq(d.salary_paid_after[0].paid_on, shopDay(-5), 'paid_on');
  eq(Number(d.salary_paid_after[0].net_amount), 4200, 'net_amount');
  eq(JSON.stringify(await expRow(id)), before, 'expense changed by preview');
  eq(await advCount(), a0, 'advance count');
  eq(await expCount(), e0, 'expense count');
  // A payment before the expense date is not listed.
  const r2 = await mark(await makeExpense({ amount: 10, daysAgo: 2 }), c.owner, { employee_id: c.emp2, preview: true });
  eq(r2.status, 200, 'second preview');
  eq(r2.body.data.salary_paid_after.length, 0, 'older payment listed');
});

// 6
check('refusals', async () => {
  const c = await getCast();
  const db = await getDb();
  const refuse = async (label, id, body, status, msg) => {
    const r = await mark(id, c.owner, body);
    eq(r.status, status, label + ' status ' + JSON.stringify(r.body));
    eq(r.body && r.body.message, msg, label + ' copy');
    eq((await advFor(id)).length, 0, label + ' made an advance');
  };
  const e = { employee_id: c.emp2 };
  await refuse('61 days', await makeExpense({ daysAgo: 61 }), e, 400, TOO_OLD);
  const sixty = await makeExpense({ daysAgo: 60 });
  const ok = await mark(sixty, c.owner, e);
  eq(ok.status, 200, '60 days ' + JSON.stringify(ok.body));
  await refuse('own pocket', await makeExpense({ method: 'own_pocket' }), e, 400, METHOD);
  await refuse('card', await makeExpense({ method: 'card' }), e, 400, METHOD);
  await refuse('return', await makeExpense({ isReturn: 1 }), e, 400, RETURN);
  const mo = await db.prepare("INSERT INTO staff_money_out (location_id, user_id, amount, payment_method, status, note) VALUES (?, ?, 100, 'cash', 'open', 'VerifyOEA') RETURNING id")
    .get(TEST_LOCATION_ID, c.emp2);
  createdMoneyOutIds.push(mo.id);
  await refuse('shopping money', await makeExpense({ method: 'cash', moneyOutId: mo.id }), e, 400, NOT_PLAIN);
  const owedExp = await makeExpense({ method: 'upi' });
  const ow = await db.prepare("INSERT INTO shop_owes (location_id, user_id, amount, paid_amount, source, expense_id, status, created_by) VALUES (?, ?, 500, 0, 'own_pocket', ?, 'open', ?) RETURNING id")
    .get(TEST_LOCATION_ID, c.emp2, owedExp, c.owner);
  createdOwesIds.push(ow.id);
  await refuse('shop owes', owedExp, e, 400, NOT_PLAIN);
  const plain = await makeExpense();
  await refuse('customer', plain, { employee_id: c.customer }, 400, PERSON);
  await refuse('owner', plain, { employee_id: c.owner }, 400, PERSON);
  await refuse('inactive', plain, { employee_id: c.inactive }, 400, PERSON);
  await refuse('missing', plain, {}, 400, PERSON);
  await refuse('helper as employee', plain, { employee_id: c.helper }, 400, PERSON);
  await refuse('already salary', await makeExpense({ category: 'salary' }), e, 409, ALREADY);
  const r404 = await mark(999999999, c.owner, e);
  eq(r404.status, 404, 'missing expense');
});

// 7
check('two calls at once make one advance', async () => {
  const c = await getCast();
  const id = await makeExpense({ amount: 250 });
  const [a, b] = await Promise.all([mark(id, c.owner, { employee_id: c.emp2 }), mark(id, c.owner, { employee_id: c.emp2 })]);
  const statuses = [a.status, b.status].sort();
  eq(JSON.stringify(statuses), JSON.stringify([200, 409]), 'statuses ' + JSON.stringify([a.body, b.body]));
  const loser = a.status === 409 ? a : b;
  eq(loser.body.message, ALREADY, '409 copy');
  eq((await advFor(id)).length, 1, 'advance rows');
});

// 8
check('only the owner', async () => {
  const c = await getCast();
  const id = await makeExpense();
  const before = JSON.stringify(await expRow(id));
  for (const who of ['manager', 'counter', 'helper']) {
    const r = await mark(id, c[who], { employee_id: c.emp2 });
    eq(r.status, 403, who);
    const p = await mark(id, c[who], { employee_id: c.emp2, preview: true });
    eq(p.status, 403, who + ' preview');
  }
  eq(JSON.stringify(await expRow(id)), before, 'expense changed');
  eq((await advFor(id)).length, 0, 'advance made');
});

// 9
check('afterwards the existing rules apply', async () => {
  const c = await getCast();
  const db = await getDb();
  assert(firstExpenseId, 'check 1 did not run');
  const put = await api('PUT', `/expenses/${firstExpenseId}`, c.owner, { amount: 400 });
  eq(put.status, 200, 'PUT ' + JSON.stringify(put.body));
  eq(Number((await advFor(firstExpenseId))[0].amount), 400, 'advance amount after PUT');
  const del = await api('DELETE', `/expenses/${firstExpenseId}`, c.owner);
  eq(del.status, 200, 'DELETE ' + JSON.stringify(del.body));
  const adv = await db.prepare('SELECT status FROM salary_advances WHERE id = ?').get(firstAdvanceId);
  eq(adv.status, 'cancelled', 'advance after DELETE');

  const id2 = await makeExpense({ amount: 350 });
  const r = await mark(id2, c.owner, { employee_id: c.emp2 });
  eq(r.status, 200, 'second convert ' + JSON.stringify(r.body));
  await db.prepare('UPDATE salary_advances SET repaid_amount = 100 WHERE id = ?').run(r.body.data.advance_id);
  const del2 = await api('DELETE', `/expenses/${id2}`, c.owner);
  eq(del2.status, 400, 'taken DELETE ' + JSON.stringify(del2.body));
  eq(del2.body.message, ADVANCE_TAKEN, 'taken copy');
});

// 10
check('audited', async () => {
  const c = await getCast();
  const db = await getDb();
  const id = await makeExpense({ amount: 120, description: 'VerifyOEA audit' });
  const r = await mark(id, c.owner, { employee_id: c.emp2 });
  eq(r.status, 200, 'convert ' + JSON.stringify(r.body));
  const ea = await db.prepare("SELECT * FROM audit_logs WHERE entity_type = 'expense' AND entity_id = ? AND action = 'expense_marked_salary_advance'").all(id);
  eq(ea.length, 1, 'expense audit rows');
  eq(Number(ea[0].user_id), c.owner, 'expense audit user');
  const prev = typeof ea[0].previous_state === 'string' ? JSON.parse(ea[0].previous_state) : ea[0].previous_state;
  const next = typeof ea[0].new_state === 'string' ? JSON.parse(ea[0].new_state) : ea[0].new_state;
  eq(prev.category, 'supplies', 'before category');
  eq(next.category, 'salary', 'after category');
  eq(Number(next.employee_id), c.emp2, 'after employee');
  const aa = await db.prepare("SELECT * FROM audit_logs WHERE entity_type = 'salary_advance' AND entity_id = ? AND action = 'salary_advance_given'").all(r.body.data.advance_id);
  eq(aa.length, 1, 'advance audit rows');
  const ns = typeof aa[0].new_state === 'string' ? JSON.parse(aa[0].new_state) : aa[0].new_state;
  eq(ns.source, 'old_expense', 'audit source');
  eq(Number(ns.expense_id), id, 'audit expense_id');
  eq(ns.register_id, null, 'audit register_id');
});

async function cleanup() {
  const db = await getDb();
  const del = async (label, sql, ...p) => { try { await db.prepare(sql).run(...p); } catch (e) { console.error(`cleanup ${label}: ${e.message}`); } };
  try { await closeOwnRegister(); } catch (e) { console.error('cleanup close: ' + e.message); }
  for (const id of createdSalaryPaymentIds) await del('salary payment ' + id, 'DELETE FROM salary_payments WHERE id = ?', id);
  for (const id of createdOwesIds) await del('owes ' + id, 'DELETE FROM shop_owes WHERE id = ?', id);
  for (const id of createdExpenseIds) {
    await del('advance audits', "DELETE FROM audit_logs WHERE entity_type = 'salary_advance' AND entity_id IN (SELECT id FROM salary_advances WHERE expense_id = ?)", id);
    await del('advances', 'DELETE FROM salary_advances WHERE expense_id = ?', id);
    await del('expense audits', "DELETE FROM audit_logs WHERE entity_type = 'expense' AND entity_id = ?", id);
    await del('expense ' + id, 'DELETE FROM expenses WHERE id = ?', id);
  }
  for (const id of createdMoneyOutIds) await del('money out ' + id, 'DELETE FROM staff_money_out WHERE id = ?', id);
  for (const id of createdUserIds) {
    // Advances whose expense was removed by the run (expense_id now NULL).
    await del('advance audits', "DELETE FROM audit_logs WHERE entity_type = 'salary_advance' AND entity_id IN (SELECT id FROM salary_advances WHERE user_id = ?)", id);
    await del('advances', 'DELETE FROM salary_advances WHERE user_id = ?', id);
    await del('salary config', 'DELETE FROM employee_salaries WHERE user_id = ?', id);
  }
  for (const id of createdRegisterIds) {
    await del('register audits', "DELETE FROM audit_logs WHERE entity_type = 'cash_register' AND entity_id = ?", id);
    await del('register ' + id, 'DELETE FROM cash_registers WHERE id = ?', id);
  }
  for (const id of createdUserIds) {
    await del('notifications', 'DELETE FROM notifications WHERE user_id = ?', id);
    await del('links', 'DELETE FROM user_locations WHERE user_id = ?', id);
    await del('user ' + id, 'DELETE FROM users WHERE id = ?', id);
  }
}

async function main() {
  assertLocalTarget();
  let pass = 0, fail = 0, skipped = 0;
  try {
    for (const { name, fn } of checks) {
      try { await fn(); console.log(`PASS ${name}`); pass++; }
      catch (err) {
        if (err.skip) { console.log(`SKIP ${name}\n   ${err.message}`); skipped++; continue; }
        console.log(`FAIL ${name}\n   ${err.message}`); fail++;
      }
    }
  } finally { await cleanup(); }
  console.log(`\n${pass}/${pass + fail} checks passed${skipped ? `, ${skipped} skipped (register in use)` : ''}`);
  process.exit(fail > 0 ? 1 : 0);
}
main();
