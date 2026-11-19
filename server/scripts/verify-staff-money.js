#!/usr/bin/env node
/**
 * Verification of staff money (PR B). B1: schema, settings, helper module.
 * B2: salary advance at the counter (live API on API_BASE_URL).
 * B3: shopping money, settle, remove, write-off and the register lines.
 * B4: own pocket and Shop owes (pay back, keep, write-off).
 * B5: payroll Take from pay (throwaway VerifySM employees only).
 * Test rows are named VerifySM. Cleans up only rows this run created.
 * Usage: source test-env.sh; node server/scripts/verify-staff-money.js
 */
require('dotenv').config();
const { getDb } = require('../config/database-async');
const sm = require('../utils/staff-money');
const { hashPin } = require('../utils/pin');

const TEST_LOCATION_ID = 4; // Test Loc
const OTHER_LOCATION_ID_QUERY = 'SELECT id FROM locations WHERE id <> ? ORDER BY id LIMIT 1';
const checks = [];
const createdUserIds = [];
function check(name, fn) { checks.push({ name, fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const eq = (a, b, what) => assert(a === b, `${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
async function rejects(fn) { try { await fn(); } catch (e) { return e; } return null; }

function assertLocalTarget() {
  if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '')) { console.error('Refusing to run: DATABASE_URL not local.'); process.exit(1); }
}

async function makeUser(db, { role, name, pin, code, location = TEST_LOCATION_ID, active = 1 }) {
  const phone = 'sm' + Date.now() + Math.floor(Math.random() * 1e6);
  const pinHash = pin ? await hashPin(pin) : null;
  const row = await db.prepare(
    'INSERT INTO users (phone, password, name, role, is_active, employee_code, pin_hash) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id'
  ).get(phone, 'x', name, role, active, code || null, pinHash);
  createdUserIds.push(row.id);
  if (location) await db.prepare('INSERT INTO user_locations (user_id, location_id) VALUES (?, ?)').run(row.id, location);
  return row.id;
}

// ── Schema and settings ──
check('new tables exist', async () => {
  const db = await getDb();
  for (const t of ['staff_money_out', 'staff_money_settles', 'shop_owes', 'shop_owes_payments']) {
    const r = await db.prepare('SELECT to_regclass(?) AS r').get('public.' + t);
    assert(r.r, 'missing table ' + t);
  }
});

check('new columns exist', async () => {
  const db = await getDb();
  const want = {
    expenses: ['money_out_id', 'paid_by_user_id'],
    salary_advances: ['given_by', 'source', 'payment_method', 'location_id', 'expense_id'],
  };
  for (const [t, cols] of Object.entries(want)) {
    const rows = await db.prepare('SELECT column_name FROM information_schema.columns WHERE table_name = ?').all(t);
    const have = rows.map((r) => r.column_name);
    for (const c of cols) assert(have.includes(c), `missing ${t}.${c}`);
  }
});

check('indexes exist', async () => {
  const db = await getDb();
  const rows = await db.prepare("SELECT indexname FROM pg_indexes WHERE tablename IN ('staff_money_out','staff_money_settles','shop_owes','shop_owes_payments','expenses')").all();
  const have = rows.map((r) => r.indexname);
  for (const i of ['idx_staff_money_out_loc_status', 'idx_staff_money_out_user_status', 'idx_staff_money_settles_register',
    'idx_staff_money_settles_out', 'idx_shop_owes_user_status', 'idx_shop_owes_payments_register',
    'idx_expenses_money_out', 'idx_expenses_paid_by_user', 'idx_shop_owes_own_pocket_expense']) assert(have.includes(i), 'missing index ' + i);
});

check('salary_advances status check allows cancelled', async () => {
  const db = await getDb();
  const u = await makeUser(db, { role: 'counter_staff', name: 'VerifySM Chk' });
  const r = await db.prepare("INSERT INTO salary_advances (user_id, amount, status) VALUES (?, 1, 'cancelled') RETURNING id").get(u);
  await db.prepare('DELETE FROM salary_advances WHERE id = ?').run(r.id);
});

check('settings seeded with defaults', async () => {
  const db = await getDb();
  const l = await sm.getLimits(db);
  // Owner may have changed them; each must at least be a number.
  for (const k of ['advanceDay', 'advanceMonth', 'shoppingDay', 'lateDays']) assert(Number.isFinite(l[k]), k + ' not numeric');
  const rows = await db.prepare("SELECT key, value FROM settings WHERE key IN ('advance_daily_limit','advance_monthly_limit','shopping_money_daily_limit','shopping_money_late_days')").all();
  eq(rows.length, 4, 'seeded setting rows');
});

// ── remaining ──
check('remaining is whole paise', async () => {
  eq(sm.remaining({ amount: 500, settled_amount: 300, returned_amount: 150 }), 50, 'remaining');
  eq(sm.remaining({ amount: '0.30', settled_amount: '0.10', returned_amount: '0.10' }), 0.1, 'float-safe');
  eq(sm.remaining({ amount: 100, settled_amount: 100, returned_amount: 50 }), 0, 'never negative');
});

// ── needsPin ──
const limits = { advanceDay: 500, advanceMonth: 2000, shoppingDay: 1000, lateDays: 3 };
const zero = { advanceToday: 0, advanceMonth: 0, shoppingToday: 0 };
const np = (o) => sm.needsPin({ limits, totals: zero, kind: 'advance', amount: 100, recipientId: 2, giver: { id: 1, role: 'counter_staff' }, ...o });
check('needsPin: owner none, manager self none, staff self "self"', async () => {
  eq(np({ giver: { id: 1, role: 'owner' }, amount: 99999 }), null, 'owner');
  eq(np({ giver: { id: 1, role: 'owner' }, recipientId: 1 }), null, 'owner self');
  eq(np({ giver: { id: 1, role: 'manager' }, recipientId: 1 }), null, 'manager self');
  eq(np({ recipientId: 1 }), 'self', 'counter staff self');
  eq(np({ giver: { id: 1, role: 'employee' }, recipientId: 1 }), 'self', 'employee self');
  eq(np({ recipientId: 1, amount: 99999 }), 'self', 'self checked before limits');
});
check('needsPin: day and month limits', async () => {
  eq(np({ amount: 500 }), null, 'exactly the day limit is fine');
  eq(np({ amount: 300, totals: { ...zero, advanceToday: 300 } }), 'over_day', '300 after 300');
  eq(np({ amount: 100, totals: { ...zero, advanceToday: 100, advanceMonth: 1950 } }), 'over_month', '100 with month 1950');
  eq(np({ amount: 300, totals: { ...zero, advanceToday: 300, advanceMonth: 1950 } }), 'over_day', 'day wins when both');
  eq(np({ giver: { id: 1, role: 'manager' }, amount: 300, totals: { ...zero, advanceToday: 300 } }), 'over_day', 'manager for someone else still limited');
});
check('needsPin: shopping uses only its day limit', async () => {
  eq(np({ kind: 'shopping', amount: 1000 }), null, 'at limit');
  eq(np({ kind: 'shopping', amount: 1 , totals: { ...zero, shoppingToday: 1000 } }), 'over_day', 'over shopping day');
  eq(np({ kind: 'shopping', amount: 900, totals: { ...zero, advanceToday: 500, advanceMonth: 2000 } }), null, 'advances do not count');
  eq(np({ amount: 400, totals: { ...zero, shoppingToday: 5000 } }), null, 'shopping does not count against advances');
});

// ── totals ──
check('totals count advances and shopping for one person', async () => {
  const db = await getDb();
  const u = await makeUser(db, { role: 'counter_staff', name: 'VerifySM Tot' });
  const adv = (amt, status, repaid = 0) => db.prepare(
    "INSERT INTO salary_advances (user_id, amount, status, repaid_amount, date) VALUES (?, ?, ?, ?, CAST(? AS date))"
  ).run(u, amt, status, repaid, require('../utils/time').todayStr());
  await adv(100, 'approved');
  await adv(50, 'repaid', 50);
  await adv(70, 'pending');
  await adv(30, 'cancelled');
  await db.prepare("INSERT INTO staff_money_out (location_id, user_id, amount, status, settled_amount) VALUES (?, ?, 400, 'open', 100)").run(TEST_LOCATION_ID, u);
  await db.prepare("INSERT INTO staff_money_out (location_id, user_id, amount, status) VALUES (?, ?, 250, 'removed')").run(TEST_LOCATION_ID, u);
  await db.prepare("INSERT INTO shop_owes (location_id, user_id, amount, paid_amount, status) VALUES (?, ?, 80, 30, 'open')").run(TEST_LOCATION_ID, u);
  const t = await sm.totals(db, { userId: u });
  eq(t.advanceToday, 150, 'advanceToday');
  eq(t.advanceMonth, 150, 'advanceMonth');
  eq(t.shoppingToday, 400, 'shoppingToday (removed excluded)');
  eq(t.advancesUnpaid, 100, 'advancesUnpaid');
  eq(t.shoppingHeld, 300, 'shoppingHeld');
  eq(t.owed, 50, 'owed');
});

// ── checkApprover ──
check('checkApprover rules', async () => {
  const db = await getDb();
  const other = await db.prepare(OTHER_LOCATION_ID_QUERY).get(TEST_LOCATION_ID);
  const mgr = await makeUser(db, { role: 'manager', name: 'VerifySM Mgr', pin: '4821', code: 'VSM' + Date.now() % 1e6 });
  const mgrNoPin = await makeUser(db, { role: 'manager', name: 'VerifySM NoPin' });
  const mgrOff = await makeUser(db, { role: 'manager', name: 'VerifySM Off', pin: '4821', code: 'VSO' + Date.now() % 1e6, active: 0 });
  const mgrElsewhere = other ? await makeUser(db, { role: 'manager', name: 'VerifySM Far', pin: '4821', code: 'VSF' + Date.now() % 1e6, location: other.id }) : null;
  const staff = await makeUser(db, { role: 'counter_staff', name: 'VerifySM Staff', pin: '4821', code: 'VSS' + Date.now() % 1e6 });
  const recipient = await makeUser(db, { role: 'counter_staff', name: 'VerifySM Recip' });
  const base = { pin: '4821', locationId: TEST_LOCATION_ID, recipientId: recipient };

  const ok = await sm.checkApprover(db, { ...base, approverId: mgr });
  eq(ok.id, mgr, 'valid manager accepted');
  eq((await rejects(() => sm.checkApprover(db, { ...base, approverId: mgrNoPin }))).status, 403, 'no pin set');
  eq((await rejects(() => sm.checkApprover(db, { ...base, approverId: mgrOff }))).status, 403, 'inactive');
  eq((await rejects(() => sm.checkApprover(db, { ...base, approverId: staff }))).status, 403, 'wrong role');
  eq((await rejects(() => sm.checkApprover(db, { ...base, approverId: 999999999 }))).status, 403, 'unknown id');
  eq((await rejects(() => sm.checkApprover(db, { ...base, approverId: mgr, recipientId: mgr }))).status, 403, 'approver is recipient');
  if (mgrElsewhere) eq((await rejects(() => sm.checkApprover(db, { ...base, approverId: mgrElsewhere }))).status, 403, 'manager of another shop');
  const bad = await rejects(() => sm.checkApprover(db, { ...base, pin: '0000', approverId: mgr }));
  eq(bad.status, 401, 'wrong pin status');
  assert(/That PIN didn't match\. \d+ tries left\./.test(bad.message), 'wrong pin copy: ' + bad.message);
  const good = await sm.checkApprover(db, { ...base, approverId: mgr });
  eq(good.id, mgr, 'right pin clears the count');
});

check('needsPinMessage copy', async () => {
  const m = sm.needsPinMessage('over_day', { limits, kind: 'advance' });
  assert(m.includes('₹500 daily advance limit') && m.includes('PIN'), m);
  const m2 = sm.needsPinMessage('over_month', { name: 'Ramesh', limits });
  assert(m2.startsWith('That would take Ramesh over the ₹2,000 monthly advance limit'), m2);
  eq(sm.needsPinMessage('self', {}), 'A manager or owner needs to confirm money for yourself.', 'self');
});

// ══ B2: salary advance at the counter (spec 5.1-5.3, 5.9, 5.10) ══
const jwt = require('jsonwebtoken');
const { todayStr } = require('../utils/time');
const API_BASE = process.env.API_BASE_URL || 'http://localhost:3001/api';
const createdRegisterIds = [];
const createdAdvanceIds = [];
const createdMoneyOutIds = [];
const tok = (id) => jwt.sign({ id }, process.env.JWT_SECRET);
async function api(method, path, userId, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(userId ? { Authorization: `Bearer ${tok(userId)}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body: json };
}
function skip(msg) { const e = new Error(msg); e.skip = true; return e; }
const CLOSED_COPY = 'Open the register to give cash — or pick UPI.';
const SELF_COPY = 'A manager or owner needs to confirm money for yourself.';
const BREAK_LINK_COPY = 'Remove it and give the advance again.';

// One cast for the whole B2 section, made on first use.
let cast = null;
async function getCast() {
  if (cast) return cast;
  const db = await getDb();
  const other = await db.prepare(OTHER_LOCATION_ID_QUERY).get(TEST_LOCATION_ID);
  const s = String(Date.now() % 1e6);
  cast = {
    owner: await makeUser(db, { role: 'owner', name: 'VerifySM Owner', pin: '5932', code: 'VSMO' + s, location: null }),
    mgr: await makeUser(db, { role: 'manager', name: 'VerifySM Asha', pin: '5932', code: 'VSMA' + s }),
    mgrNoPin: await makeUser(db, { role: 'manager', name: 'VerifySM NoPinMgr' }),
    mgrNoCode: await makeUser(db, { role: 'manager', name: 'VerifySM NoCodeMgr', pin: '5932' }),
    mgrFar: other ? await makeUser(db, { role: 'manager', name: 'VerifySM FarMgr', pin: '5932', code: 'VSMF' + s, location: other.id }) : null,
    counter: await makeUser(db, { role: 'counter_staff', name: 'VerifySM Counter' }),
    r1: await makeUser(db, { role: 'counter_staff', name: 'VerifySM Ramesh' }),
    r2: await makeUser(db, { role: 'florist_staff', name: 'VerifySM Ravi' }),
    r3: await makeUser(db, { role: 'employee', name: 'VerifySM Meena' }),
    r4: await makeUser(db, { role: 'delivery_partner', name: 'VerifySM Raju' }),
    unlinked: await makeUser(db, { role: 'counter_staff', name: 'VerifySM Elsewhere', location: null }),
    florist: await makeUser(db, { role: 'florist_staff', name: 'VerifySM Florist' }),
    helper: await makeUser(db, { role: 'helper', name: 'VerifySM Helper' }),
  };
  await db.prepare('UPDATE users SET access_until = CAST(? AS date) + 30 WHERE id = ?').run(todayStr(), cast.helper);
  cast.limits = await sm.getLimits(db);
  return cast;
}
async function testLocRegister() {
  const db = await getDb();
  return db.prepare('SELECT id, expected_cash FROM cash_registers WHERE location_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1').get(TEST_LOCATION_ID);
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
const drawer = async (id) => Number((await (await getDb()).prepare('SELECT expected_cash FROM cash_registers WHERE id = ?').get(id)).expected_cash);
async function give(giver, body) {
  const r = await api('POST', '/staff-money/advance', giver, { location_id: TEST_LOCATION_ID, payment_method: 'cash', ...body });
  if (r.status === 201 && r.body && r.body.data) createdAdvanceIds.push(r.body.data.advance_id);
  return r;
}
const advRow = async (id) => (await getDb()).prepare('SELECT * FROM salary_advances WHERE id = ?').get(id);
const expRow = async (id) => (await getDb()).prepare('SELECT * FROM expenses WHERE id = ?').get(id);

check('B2: helper and florist get 403 on every staff-money route', async () => {
  const c = await getCast();
  for (const who of [c.helper, c.florist]) {
    for (const [m, p, b] of [
      ['GET', `/staff-money/people?location_id=${TEST_LOCATION_ID}`],
      ['GET', `/staff-money/approvers?location_id=${TEST_LOCATION_ID}`],
      ['POST', '/staff-money/advance', { location_id: TEST_LOCATION_ID, user_id: c.r1, amount: 10, payment_method: 'upi' }],
    ]) {
      const r = await api(m, p, who, b);
      eq(r.status, 403, `${who === c.helper ? 'helper' : 'florist'} ${m} ${p}`);
    }
  }
});

check('B2: people lists linked staff and riders with recent_rank; approvers lists only PIN holders', async () => {
  const c = await getCast();
  const p = await api('GET', `/staff-money/people?location_id=${TEST_LOCATION_ID}`, c.counter);
  eq(p.status, 200, 'people status');
  const ids = p.body.data.map((x) => x.id);
  for (const id of [c.mgr, c.counter, c.r1, c.r2, c.r3, c.r4]) assert(ids.includes(id), 'missing person ' + id);
  for (const id of [c.owner, c.unlinked, c.helper]) assert(!ids.includes(id), 'should not list ' + id);
  const one = p.body.data.find((x) => x.id === c.r1);
  eq(Object.keys(one).sort().join(','), 'id,name,recent_rank,role', 'people fields');
  const a = await api('GET', `/staff-money/approvers?location_id=${TEST_LOCATION_ID}`, c.counter);
  eq(a.status, 200, 'approvers status');
  const aid = a.body.data.map((x) => x.id);
  assert(aid.includes(c.mgr) && aid.includes(c.owner), 'manager and owner with PIN listed');
  for (const id of [c.mgrNoPin, c.mgrNoCode, c.mgrFar, c.counter].filter(Boolean)) assert(!aid.includes(id), 'should not list approver ' + id);
  for (const x of a.body.data) eq(Object.keys(x).sort().join(','), 'id,name,role', 'approver fields');
  eq((await api('GET', '/staff-money/people', c.counter)).status, 400, 'people without a shop');
});

check('B2: cash with the register closed is refused in plain words', async () => {
  const c = await getCast();
  if (await testLocRegister()) throw skip('Test Loc has an open register; skipped.');
  const r = await give(c.counter, { user_id: c.r1, amount: 50 });
  eq(r.status, 400, 'status');
  eq(r.body.message, CLOSED_COPY, 'copy');
});

check('B2: under the limits a cash advance is given; drawer down; salary expense linked', async () => {
  const c = await getCast();
  const reg = await openOwnRegister();
  const before = await drawer(reg);
  const r = await give(c.counter, { user_id: c.r1, amount: 300, note: 'rent' });
  eq(r.status, 201, 'status ' + JSON.stringify(r.body));
  const { advance_id, expense_id } = r.body.data;
  eq('unpaid_after' in r.body.data, false, 'no colleague total for counter staff (spec 5.8)');
  const a = await advRow(advance_id);
  eq(a.status, 'approved', 'status');
  eq(a.source, 'counter', 'source');
  eq(a.given_by, c.counter, 'given_by');
  eq(a.approved_by, c.counter, 'approved_by (no PIN)');
  eq(a.payment_method, 'cash', 'method');
  eq(a.location_id, TEST_LOCATION_ID, 'location');
  eq(a.expense_id, expense_id, 'expense link');
  eq(String(a.date).slice(0, 10), todayStr(), 'shop-local date');
  const e = await expRow(expense_id);
  eq(e.category, 'salary', 'category');
  eq(e.employee_id, c.r1, 'employee');
  eq(e.given_to_user_id, c.r1, 'given to');
  eq(e.register_id, reg, 'register');
  eq(e.payment_method, 'cash', 'expense method');
  eq(e.created_by, c.counter, 'created_by');
  eq(Number(e.amount), 300, 'amount');
  eq(await drawer(reg), before - 300, 'drawer');
  const au = await (await getDb()).prepare("SELECT new_state FROM audit_logs WHERE entity_type = 'salary_advance' AND entity_id = ? AND action = 'salary_advance_given'").get(advance_id);
  assert(au, 'no audit row');
});

check('B2: UPI advance leaves the drawer alone', async () => {
  const c = await getCast();
  const reg = await openOwnRegister();
  const before = await drawer(reg);
  const r = await give(c.counter, { user_id: c.r1, amount: 100, payment_method: 'upi' });
  eq(r.status, 201, 'status ' + JSON.stringify(r.body));
  const e = await expRow(r.body.data.expense_id);
  eq(e.payment_method, 'upi', 'method');
  eq(e.register_id, null, 'no register');
  eq(await drawer(reg), before, 'drawer unchanged');
});

check('B2: over the day limit needs a PIN (409, spec copy); wrong PIN refused; manager PIN passes and owner is told', async () => {
  const c = await getCast();
  await openOwnRegister();
  const left = c.limits.advanceDay - 400; // r1 has 400 today
  const amt = left + 1;
  const r = await give(c.counter, { user_id: c.r1, amount: amt });
  eq(r.status, 409, 'status ' + JSON.stringify(r.body));
  eq(r.body.needs_pin, 'over_day', 'reason');
  eq(r.body.message, `That's more than the ₹${c.limits.advanceDay.toLocaleString('en-IN')} daily advance limit. A manager or owner can confirm with their PIN.`, 'copy');
  const bad = await give(c.counter, { user_id: c.r1, amount: amt, approver_id: c.mgr, approver_pin: '0000' });
  eq(bad.status, 401, 'wrong pin');
  assert(/^That PIN didn't match\. \d+ tries left\.$/.test(bad.body.message), 'wrong pin copy ' + bad.body.message);
  const ok = await give(c.counter, { user_id: c.r1, amount: amt, approver_id: c.mgr, approver_pin: '5932' });
  eq(ok.status, 201, 'with pin ' + JSON.stringify(ok.body));
  const a = await advRow(ok.body.data.advance_id);
  eq(a.approved_by, c.mgr, 'approved_by');
  eq(a.given_by, c.counter, 'given_by');
  const n = await (await getDb()).prepare("SELECT body FROM notifications WHERE user_id = ? AND type = 'staff_money_advance' AND (data::jsonb->>'advanceId')::int = ?").get(c.owner, ok.body.data.advance_id);
  assert(n, 'owner not notified of a PIN-approved advance');
});

check('B2: approver = recipient is 403; a manager of another shop is 403; owner PIN passes', async () => {
  const c = await getCast();
  await openOwnRegister();
  const self = await give(c.counter, { user_id: c.mgr, amount: 10, approver_id: c.mgr, approver_pin: '5932' });
  eq(self.status, 403, 'approver is recipient');
  if (c.mgrFar) {
    const far = await give(c.counter, { user_id: c.r2, amount: c.limits.advanceDay + 1, approver_id: c.mgrFar, approver_pin: '5932' });
    eq(far.status, 403, 'manager not linked');
  }
  const own = await give(c.counter, { user_id: c.r2, amount: c.limits.advanceDay + 1, approver_id: c.owner, approver_pin: '5932' });
  eq(own.status, 201, 'owner pin ' + JSON.stringify(own.body));
  eq((await advRow(own.body.data.advance_id)).approved_by, c.owner, 'approved_by owner');
});

check('B2: over the month limit needs a PIN with the spec copy', async () => {
  const c = await getCast();
  await openOwnRegister();
  const today = todayStr();
  if (today.endsWith('-01')) throw skip('first of the month: no earlier day this month to seed');
  const db = await getDb();
  const seeded = await db.prepare("INSERT INTO salary_advances (user_id, amount, status, date) VALUES (?, ?, 'approved', CAST(? AS date)) RETURNING id")
    .get(c.r3, c.limits.advanceMonth - 1, `${today.slice(0, 7)}-01`);
  createdAdvanceIds.push(seeded.id);
  const r = await give(c.counter, { user_id: c.r3, amount: 2, payment_method: 'upi' });
  eq(r.status, 409, 'status ' + JSON.stringify(r.body));
  eq(r.body.needs_pin, 'over_month', 'reason');
  eq(r.body.message, `That would take VerifySM over the ₹${c.limits.advanceMonth.toLocaleString('en-IN')} monthly advance limit. A manager or owner can confirm with their PIN.`, 'copy');
});

check('B2: counter staff money for themselves needs a PIN', async () => {
  const c = await getCast();
  const r = await give(c.counter, { user_id: c.counter, amount: 10, payment_method: 'upi' });
  eq(r.status, 409, 'status');
  eq(r.body.needs_pin, 'self', 'reason');
  eq(r.body.message, SELF_COPY, 'copy');
});

check('B2: a manager takes an advance for themselves with no PIN; the owner is told', async () => {
  const c = await getCast();
  const r = await give(c.mgr, { user_id: c.mgr, amount: 300, payment_method: 'upi' });
  eq(r.status, 201, 'status ' + JSON.stringify(r.body));
  const n = await (await getDb()).prepare("SELECT body FROM notifications WHERE user_id = ? AND type = 'staff_money_advance' AND (data::jsonb->>'advanceId')::int = ?").get(c.owner, r.body.data.advance_id);
  assert(n, 'owner not notified');
  eq(n.body, 'VerifySM Asha (manager) took a ₹300 salary advance.', 'notification copy');
});

check('B2 RF3: an approved in-app request counts toward limits and writes the same expense shape', async () => {
  const c = await getCast();
  const reg = await openOwnRegister();
  const req = await api('POST', '/attendance/salary-advance', c.r4, { amount: 400, reason: 'VerifySM request' });
  eq(req.status, 201, 'request');
  createdAdvanceIds.push(req.body.data.id);
  const before = await drawer(reg);
  const ap = await api('PUT', `/attendance/salary-advance/${req.body.data.id}/approve`, c.owner);
  eq(ap.status, 200, 'approve ' + JSON.stringify(ap.body));
  const a = await advRow(req.body.data.id);
  eq(a.status, 'approved', 'status');
  assert(a.expense_id, 'expense not linked');
  eq(String(a.date).slice(0, 10), todayStr(), 'shop-local date');
  const e = await expRow(a.expense_id);
  eq(e.category, 'salary', 'category');
  eq(e.employee_id, c.r4, 'employee');
  eq(e.given_to_user_id, c.r4, 'given to');
  eq(e.register_id, reg, 'register');
  eq(e.payment_method, 'cash', 'method');
  eq(e.description, 'Salary advance — VerifySM Raju', 'description');
  eq(await drawer(reg), before - 400, 'drawer');
  const over = await give(c.counter, { user_id: c.r4, amount: c.limits.advanceDay - 400 + 1, payment_method: 'upi' });
  eq(over.status, 409, 'request counted toward the day limit');
  eq(over.body.needs_pin, 'over_day', 'reason');
});

check('B2: removing the advance expense cancels the advance, puts the cash back, audits it', async () => {
  const c = await getCast();
  const reg = await openOwnRegister();
  const g = await give(c.owner, { user_id: c.r2, amount: 120 });
  eq(g.status, 201, 'give ' + JSON.stringify(g.body));
  const mid = await drawer(reg);
  const d = await api('DELETE', `/expenses/${g.body.data.expense_id}`, c.owner);
  eq(d.status, 200, 'delete ' + JSON.stringify(d.body));
  eq((await advRow(g.body.data.advance_id)).status, 'cancelled', 'advance cancelled');
  eq(await drawer(reg), mid + 120, 'drawer back');
  const au = await (await getDb()).prepare("SELECT 1 AS ok FROM audit_logs WHERE entity_type = 'salary_advance' AND entity_id = ? AND action = 'salary_advance_cancelled'").get(g.body.data.advance_id);
  assert(au, 'no cancel audit');
});

check('B2: changing the expense amount moves the advance; changing its employee is refused', async () => {
  const c = await getCast();
  await openOwnRegister();
  const g = await give(c.owner, { user_id: c.r2, amount: 150 });
  eq(g.status, 201, 'give');
  const up = await api('PUT', `/expenses/${g.body.data.expense_id}`, c.owner, { amount: 175 });
  eq(up.status, 200, 'amount ' + JSON.stringify(up.body));
  eq(Number((await advRow(g.body.data.advance_id)).amount), 175, 'advance amount follows');
  const emp = await api('PUT', `/expenses/${g.body.data.expense_id}`, c.owner, { employee_id: c.r3 });
  eq(emp.status, 400, 'employee change');
  eq(emp.body.message, BREAK_LINK_COPY, 'copy');
  eq((await expRow(g.body.data.expense_id)).employee_id, c.r2, 'employee kept');
});

check('B2: once payroll took any of it, the advance expense cannot be removed or re-amounted', async () => {
  const c = await getCast();
  await openOwnRegister();
  const g = await give(c.owner, { user_id: c.r2, amount: 90, payment_method: 'upi' });
  eq(g.status, 201, 'give');
  await (await getDb()).prepare('UPDATE salary_advances SET repaid_amount = 40 WHERE id = ?').run(g.body.data.advance_id);
  const d = await api('DELETE', `/expenses/${g.body.data.expense_id}`, c.owner);
  eq(d.status, 400, 'delete refused');
  assert(await expRow(g.body.data.expense_id), 'expense kept');
  const up = await api('PUT', `/expenses/${g.body.data.expense_id}`, c.owner, { amount: 95 });
  eq(up.status, 400, 'amount refused');
  eq((await advRow(g.body.data.advance_id)).status, 'approved', 'advance untouched');
  await closeOwnRegister();
});

check('B2: people puts the most recently given first', async () => {
  const c = await getCast();
  const p = await api('GET', `/staff-money/people?location_id=${TEST_LOCATION_ID}`, c.counter);
  eq(p.status, 200, 'status');
  const mine = p.body.data.filter((x) => [c.r1, c.r2, c.r4, c.mgr].includes(x.id));
  assert(mine.every((x) => Number.isInteger(x.recent_rank)), 'ranked: ' + JSON.stringify(mine));
  const r2 = p.body.data.find((x) => x.id === c.r2);
  const top = p.body.data[0];
  // r2 got the last advance of this run, unless a real advance landed meanwhile.
  assert(top.recent_rank === 1, 'first row is rank 1');
  assert(r2.recent_rank < p.body.data.find((x) => x.id === c.r1).recent_rank, 'r2 ahead of r1');
  const unranked = p.body.data.find((x) => x.id === c.florist);
  eq(unranked.recent_rank, null, 'never given: no rank');
});

check('B2: people ranks shopping hand-outs and advances by real time, not by text', async () => {
  const c = await getCast();
  const db = await getDb();
  // A hand-out one minute after r2's latest advance expense puts the florist first;
  // a hand-out 40 days ago puts the no-PIN manager below everyone given money since.
  const a = await db.prepare(`INSERT INTO staff_money_out (location_id, user_id, amount, status, created_at)
    SELECT ?, ?, 50, 'open', MAX(created_at) + interval '1 minute' FROM expenses WHERE employee_id = ? RETURNING id`).get(TEST_LOCATION_ID, c.florist, c.r2);
  createdMoneyOutIds.push(a.id);
  const b = await db.prepare(`INSERT INTO staff_money_out (location_id, user_id, amount, status, created_at)
    VALUES (?, ?, 50, 'open', CURRENT_TIMESTAMP - interval '40 days') RETURNING id`).get(TEST_LOCATION_ID, c.mgrNoPin);
  createdMoneyOutIds.push(b.id);
  const p = await api('GET', `/staff-money/people?location_id=${TEST_LOCATION_ID}`, c.counter);
  eq(p.status, 200, 'status');
  const rank = (id) => (p.body.data.find((x) => x.id === id) || {}).recent_rank;
  eq(rank(c.florist), 1, 'latest hand-out ranks first');
  assert(rank(c.florist) < rank(c.r2), 'hand-out a minute later beats a same-day advance');
  for (const id of [c.r1, c.r2, c.r4, c.mgr]) assert(rank(c.mgrNoPin) > rank(id), `old hand-out below advance-only person ${id}`);
  if (rank(c.r3)) assert(rank(c.mgrNoPin) > rank(c.r3), 'old hand-out below this month advance');
  const ranks = p.body.data.map((x) => x.recent_rank).filter((r) => r !== null);
  assert(ranks.every((r, i) => r === i + 1), 'ranked rows come first, in order: ' + JSON.stringify(ranks));
});

// ══ B3: shopping money, settle and the drawer lines (spec 4.4, 4.6, 4.7, 5.4, 5.9, 5.10) ══
const createdItemIds = new Set();
const ALREADY_DONE = 'Already done — refresh.';
const firstName = (n) => String(n).trim().split(/\s+/)[0];
async function hand(giver, body) {
  const r = await api('POST', '/staff-money/shopping', giver, { location_id: TEST_LOCATION_ID, payment_method: 'cash', ...body });
  if (r.status === 201 && r.body && r.body.data) createdMoneyOutIds.push(r.body.data.id);
  return r;
}
async function settle(user, id, body) {
  const r = await api('POST', `/staff-money/${id}/settle`, user, { bills: [], change_back: 0, change_method: 'cash', final: false, ...body });
  return r;
}
const moRow = async (id) => (await getDb()).prepare('SELECT * FROM staff_money_out WHERE id = ?').get(id);
async function billsOf(id) {
  const rows = await (await getDb()).prepare('SELECT * FROM expenses WHERE money_out_id = ? ORDER BY id').all(id);
  for (const r of rows) if (r.item_id) createdItemIds.add(Number(r.item_id));
  return rows;
}
async function regStatus(userId) {
  const c = await getCast();
  const r = await api('GET', `/sales/register/status?location_id=${TEST_LOCATION_ID}`, userId || c.owner);
  assert(r.status === 200, 'status ' + r.status);
  return r.body.data;
}
async function auditOf(id, action) {
  return (await getDb()).prepare("SELECT * FROM audit_logs WHERE entity_type = 'staff_money_out' AND entity_id = ? AND action = ?").get(id, action);
}
const bill = (amount, name = 'VerifySM Roses') => ({ item_name: name, category: 'supplies', amount });

check('B3: helper gets 403 on every new route; florist on every route but My money', async () => {
  const c = await getCast();
  const routes = [
    ['POST', '/staff-money/shopping', { location_id: TEST_LOCATION_ID, user_id: c.r1, amount: 10, payment_method: 'upi' }],
    ['POST', '/staff-money/1/settle', { bills: [], change_back: 1, change_method: 'upi', final: true }],
    ['DELETE', '/staff-money/1'],
    ['POST', '/staff-money/1/write-off', { reason: 'x' }],
    ['GET', `/staff-money/open?location_id=${TEST_LOCATION_ID}`],
    ['GET', `/staff-money/history?location_id=${TEST_LOCATION_ID}`],
  ];
  for (const [m, p, b] of [...routes, ['GET', '/staff-money/mine']]) eq((await api(m, p, c.helper, b)).status, 403, `helper ${m} ${p}`);
  for (const [m, p, b] of routes) eq((await api(m, p, c.florist, b)).status, 403, `florist ${m} ${p}`);
});

check('B3: cash shopping money with the register closed is refused in plain words', async () => {
  const c = await getCast();
  if (await testLocRegister()) throw skip('Test Loc has an open register; skipped.');
  const r = await hand(c.counter, { user_id: c.r1, amount: 50 });
  eq(r.status, 400, 'status');
  eq(r.body.message, CLOSED_COPY, 'copy');
});

let flow = null; // the 500 hand-out walked through hand-out, part settle, Done
check('B3: hand-out 500 cash: drawer -500, no expense, locked count follows, audited', async () => {
  const c = await getCast();
  const reg = await openOwnRegister();
  const db = await getDb();
  await db.prepare('UPDATE cash_registers SET close_count_locked = 1000 WHERE id = ?').run(reg);
  const before = await drawer(reg);
  const r = await hand(c.counter, { user_id: c.r1, amount: 500, note: 'flowers' });
  eq(r.status, 201, 'status ' + JSON.stringify(r.body));
  const id = r.body.data.id;
  const row = await moRow(id);
  eq(row.status, 'open', 'status');
  eq(Number(row.amount), 500, 'amount');
  eq(row.register_id, reg, 'register');
  eq(row.given_by, c.counter, 'given_by');
  eq(row.approved_by, c.counter, 'approved_by');
  eq(row.payment_method, 'cash', 'method');
  eq(await drawer(reg), before - 500, 'drawer');
  eq(Number((await db.prepare('SELECT close_count_locked FROM cash_registers WHERE id = ?').get(reg)).close_count_locked), 500, 'locked count follows');
  await db.prepare('UPDATE cash_registers SET close_count_locked = NULL WHERE id = ?').run(reg);
  eq((await billsOf(id)).length, 0, 'no expense');
  assert(await auditOf(id, 'shopping_money_given'), 'no audit');
  const st = await regStatus();
  eq(st.shopping_out, 500, 'status shopping_out');
  eq(st.expected_cash, st.running_expected_cash, 'status expected = running');
  flow = { id, reg, start: before };
});

check('B3: part settle 300: remaining 200; bills are shopping_money expenses for the holder; drawer unchanged', async () => {
  const c = await getCast();
  if (!flow) throw new Error('needs the hand-out check');
  const before = await drawer(flow.reg);
  const st0 = await regStatus();
  const r = await settle(c.counter, flow.id, { bills: [bill(200), bill(100, 'VerifySM Ribbon')] });
  eq(r.status, 200, 'status ' + JSON.stringify(r.body));
  eq(r.body.data.remaining, 200, 'remaining');
  eq(r.body.data.status, 'open', 'still open');
  const bills = await billsOf(flow.id);
  eq(bills.length, 2, 'two bills');
  for (const b of bills) {
    eq(b.payment_method, 'shopping_money', 'method');
    eq(b.given_to_user_id, c.r1, 'given to holder');
    eq(b.register_id, null, 'no register');
    eq(b.created_by, c.counter, 'created_by');
    eq(b.location_id, TEST_LOCATION_ID, 'location');
  }
  eq(await drawer(flow.reg), before, 'drawer unchanged');
  const st = await regStatus();
  eq(st.expected_cash, st0.expected_cash, 'status expected unchanged by bills');
  assert(await auditOf(flow.id, 'shopping_money_settled'), 'no audit');
});

check('B3: change back above what is left is refused with the spec copy', async () => {
  const c = await getCast();
  const r = await settle(c.counter, flow.id, { change_back: 250, final: true });
  eq(r.status, 400, 'status');
  eq(r.body.message, `${firstName('VerifySM Ramesh')} only has ₹200 left — check the change amount.`, 'copy');
});

check('B3: Done with 200 cash change: drawer +200, settled, net -300', async () => {
  const c = await getCast();
  const before = await drawer(flow.reg);
  const r = await settle(c.counter, flow.id, { change_back: 200, change_method: 'cash', final: true });
  eq(r.status, 200, 'status ' + JSON.stringify(r.body));
  eq(r.body.data.remaining, 0, 'remaining');
  eq(r.body.data.status, 'settled', 'settled');
  eq(await drawer(flow.reg), before + 200, 'drawer +200');
  eq(await drawer(flow.reg), flow.start - 300, 'net -300');
  const s = await (await getDb()).prepare('SELECT * FROM staff_money_settles WHERE money_out_id = ? ORDER BY id').all(flow.id);
  eq(s.length, 2, 'two settle rows');
  eq(s[1].register_id, flow.reg, 'change row register');
  eq(Number(s[1].returned_amount), 200, 'change amount');
  const st = await regStatus();
  eq(st.shopping_in, 200, 'status shopping_in');
  eq(st.expected_cash, st.running_expected_cash, 'status = running');
  const again = await settle(c.counter, flow.id, { change_back: 1, final: true });
  eq(again.status, 409, 'settled line answers 409');
  eq(again.body.message, ALREADY_DONE, 'copy');
});

check('B3: deleting a settle bill puts its amount back as still held; no drawer move', async () => {
  const c = await getCast();
  const before = await drawer(flow.reg);
  const [b1] = await billsOf(flow.id);
  const d = await api('DELETE', `/expenses/${b1.id}`, c.owner);
  eq(d.status, 200, 'delete ' + JSON.stringify(d.body));
  const row = await moRow(flow.id);
  eq(Number(row.settled_amount), 100, 'settled_amount down');
  eq(row.status, 'open', 'reopened');
  eq((await api('GET', `/staff-money/open?location_id=${TEST_LOCATION_ID}`, c.counter)).body.data.shopping.find((x) => x.id === flow.id).remaining, 200, 'remaining back');
  eq(await drawer(flow.reg), before, 'drawer unchanged');
  const up = await api('PUT', `/expenses/${(await billsOf(flow.id))[0].id}`, c.owner, { amount: 150 });
  eq(up.status, 400, 'changing a settle bill amount is refused');
});

check('B3: overspend 620 on 500 makes a Shop owes row for 120; removing a bill shrinks it', async () => {
  const c = await getCast();
  const reg = await openOwnRegister();
  const g = await hand(c.owner, { user_id: c.r2, amount: 500 });
  eq(g.status, 201, 'hand ' + JSON.stringify(g.body));
  const before = await drawer(reg);
  const r = await settle(c.counter, g.body.data.id, { bills: [bill(400), bill(220, 'VerifySM Foam')], final: true });
  eq(r.status, 200, 'settle ' + JSON.stringify(r.body));
  eq(r.body.data.status, 'settled', 'settled');
  eq(r.body.data.remaining, 0, 'remaining');
  assert(r.body.data.owes_id, 'owes_id');
  const db = await getDb();
  const o = await db.prepare('SELECT * FROM shop_owes WHERE id = ?').get(r.body.data.owes_id);
  eq(Number(o.amount), 120, 'owes amount');
  eq(o.source, 'overspend', 'source');
  eq(o.money_out_id, g.body.data.id, 'money_out link');
  eq(o.user_id, c.r2, 'owed to holder');
  eq(o.status, 'open', 'open');
  eq(await drawer(reg), before, 'drawer unchanged');
  const open = await api('GET', `/staff-money/open?location_id=${TEST_LOCATION_ID}`, c.counter);
  assert(open.body.data.owes.some((x) => x.id === o.id), 'owes listed on the card');
  const foam = (await billsOf(g.body.data.id)).find((b) => b.description.startsWith('VerifySM Foam'));
  const d = await api('DELETE', `/expenses/${foam.id}`, c.owner);
  eq(d.status, 200, 'delete ' + JSON.stringify(d.body));
  eq(await db.prepare('SELECT id FROM shop_owes WHERE id = ?').get(o.id), undefined, 'owes gone when no excess is left');
  const row = await moRow(g.body.data.id);
  eq(row.status, 'open', 'reopened');
  eq(sm.remaining(row), 100, '100 still held');
});

check('B3: no bills, change only (UPI hand-out back in cash) is fine', async () => {
  const c = await getCast();
  const reg = await openOwnRegister();
  const g = await hand(c.counter, { user_id: c.r3, amount: 100, payment_method: 'upi' });
  eq(g.status, 201, 'hand');
  eq((await moRow(g.body.data.id)).register_id, null, 'UPI hand-out has no register');
  const before = await drawer(reg);
  const r = await settle(c.counter, g.body.data.id, { change_back: 100, change_method: 'cash', final: true });
  eq(r.status, 200, 'settle ' + JSON.stringify(r.body));
  eq(r.body.data.status, 'settled', 'settled');
  eq(await drawer(reg), before + 100, 'drawer +100');
});

check('B3: Done with money still unaccounted is refused', async () => {
  const c = await getCast();
  await openOwnRegister();
  const g = await hand(c.counter, { user_id: c.r3, amount: 80, payment_method: 'upi' });
  const r = await settle(c.counter, g.body.data.id, { bills: [bill(30)], final: true });
  eq(r.status, 400, 'status ' + JSON.stringify(r.body));
  eq((await moRow(g.body.data.id)).status, 'open', 'still open');
  const empty = await settle(c.counter, g.body.data.id, {});
  eq(empty.status, 400, 'nothing to save');
});

check('B3 RF1: two settles at once: only one Done lands; the drawer moves once', async () => {
  const c = await getCast();
  const reg = await openOwnRegister();
  const g = await hand(c.counter, { user_id: c.r1, amount: 300 });
  eq(g.status, 201, 'hand');
  const before = await drawer(reg);
  const body = { change_back: 300, change_method: 'cash', final: true };
  const both = await Promise.all([settle(c.counter, g.body.data.id, body), settle(c.mgr, g.body.data.id, body)]);
  const codes = both.map((x) => x.status).sort();
  eq(codes.join(','), '200,409', 'one lands, one 409');
  eq(both.find((x) => x.status === 409).body.message, ALREADY_DONE, 'copy');
  eq(await drawer(reg), before + 300, 'drawer once');
  const n = await (await getDb()).prepare('SELECT COUNT(*)::int AS n FROM staff_money_settles WHERE money_out_id = ?').get(g.body.data.id);
  eq(n.n, 1, 'one settle row');
});

check('B3: a shopping_money bill with no register inside the session leaves expected cash alone', async () => {
  const c = await getCast();
  const reg = await openOwnRegister();
  const db = await getDb();
  const st0 = await regStatus();
  const e = await db.prepare(`INSERT INTO expenses (location_id, category, amount, description, payment_method, expense_date, created_by, register_id)
    VALUES (?, 'supplies', 777, 'VerifySM raw bill', 'shopping_money', CAST(? AS date), ?, NULL) RETURNING id`).get(TEST_LOCATION_ID, todayStr(), c.counter);
  const st = await regStatus();
  eq(st.expected_cash, st0.expected_cash, 'status expected unchanged');
  eq(st.total_expenses_cash, st0.total_expenses_cash, 'cash expenses unchanged');
  const pv = await api('PUT', '/sales/register/close', c.owner, { location_id: TEST_LOCATION_ID, actual_cash: st.expected_cash, preview: true });
  eq(pv.status, 200, 'preview');
  eq(pv.body.data.expected_cash, st0.expected_cash, 'preview unchanged');
  await db.prepare('DELETE FROM expenses WHERE id = ?').run(e.id);
  eq(await drawer(reg), st0.running_expected_cash, 'running unchanged');
});

check('B3: close preview = register status figure; preview lists shopping still out', async () => {
  const c = await getCast();
  await openOwnRegister();
  const g = await hand(c.counter, { user_id: c.r3, amount: 60 });
  eq(g.status, 201, 'hand');
  const st = await regStatus();
  eq(st.expected_cash, st.running_expected_cash, 'status = running');
  const pv = await api('PUT', '/sales/register/close', c.owner, { location_id: TEST_LOCATION_ID, actual_cash: st.expected_cash, preview: true });
  eq(pv.status, 200, 'preview');
  eq(pv.body.data.expected_cash, st.expected_cash, 'preview = status');
  const line = (pv.body.data.shopping_still_out || []).find((x) => x.user_name === 'VerifySM Meena');
  assert(line && line.remaining >= 60, 'still out line: ' + JSON.stringify(pv.body.data.shopping_still_out));
  eq(Object.keys(line).sort().join(','), 'remaining,user_name', 'still-out fields');
});

check('B3: owes paid back from this session come off expected cash', async () => {
  const c = await getCast();
  const reg = await openOwnRegister();
  const db = await getDb();
  const st0 = await regStatus();
  const o = await db.prepare("INSERT INTO shop_owes (location_id, user_id, amount, source, status) VALUES (?, ?, 40, 'own_pocket', 'open') RETURNING id").get(TEST_LOCATION_ID, c.r3);
  await db.prepare("INSERT INTO shop_owes_payments (owes_id, amount, method, register_id, paid_by) VALUES (?, 40, 'cash', ?, ?)").run(o.id, reg, c.owner);
  await db.prepare("INSERT INTO shop_owes_payments (owes_id, amount, method, register_id, paid_by) VALUES (?, 5, 'upi', NULL, ?)").run(o.id, c.owner);
  const st = await regStatus();
  eq(st.owes_paid, 40, 'owes_paid');
  eq(st.expected_cash, Math.round((st0.expected_cash - 40) * 100) / 100, 'expected down by cash pay-back only');
  await db.prepare('DELETE FROM shop_owes WHERE id = ?').run(o.id);
});

check('B3: the giver removes their own typo in the same session; cash back, audited', async () => {
  const c = await getCast();
  const reg = await openOwnRegister();
  const before = await drawer(reg);
  const g = await hand(c.counter, { user_id: c.r3, amount: 70 });
  eq(g.status, 201, 'hand');
  const d = await api('DELETE', `/staff-money/${g.body.data.id}`, c.counter);
  eq(d.status, 200, 'remove ' + JSON.stringify(d.body));
  eq((await moRow(g.body.data.id)).status, 'removed', 'removed');
  eq(await drawer(reg), before, 'cash back');
  assert(await auditOf(g.body.data.id, 'shopping_money_removed'), 'no audit');
  const st = await regStatus();
  eq(st.expected_cash, st.running_expected_cash, 'status = running after remove');
});

check('B3: other counter staff cannot remove; owner can; after a part settle nobody can', async () => {
  const c = await getCast();
  await openOwnRegister();
  const g = await hand(c.counter, { user_id: c.r3, amount: 40 });
  eq(g.status, 201, 'hand');
  eq((await api('DELETE', `/staff-money/${g.body.data.id}`, c.r1)).status, 403, 'other counter staff');
  eq((await api('DELETE', `/staff-money/${g.body.data.id}`, c.owner)).status, 200, 'owner');
  const h = await hand(c.counter, { user_id: c.r3, amount: 40 });
  eq((await settle(c.counter, h.body.data.id, { bills: [bill(10)] })).status, 200, 'part settle');
  const d = await api('DELETE', `/staff-money/${h.body.data.id}`, c.owner);
  eq(d.status, 409, 'after a part settle');
  eq((await moRow(h.body.data.id)).status, 'open', 'still open');
});

check('B3: owner writes off the rest; it becomes a shopping_money expense; others cannot', async () => {
  const c = await getCast();
  const reg = await openOwnRegister();
  const g = await hand(c.counter, { user_id: c.r2, amount: 150 });
  await settle(c.counter, g.body.data.id, { bills: [bill(50)] });
  eq((await api('POST', `/staff-money/${g.body.data.id}/write-off`, c.counter, { reason: 'lost' })).status, 403, 'counter staff');
  eq((await api('POST', `/staff-money/${g.body.data.id}/write-off`, c.mgr, { reason: 'lost' })).status, 403, 'manager');
  eq((await api('POST', `/staff-money/${g.body.data.id}/write-off`, c.owner, { reason: ' ' })).status, 400, 'reason needed');
  const before = await drawer(reg);
  const w = await api('POST', `/staff-money/${g.body.data.id}/write-off`, c.owner, { reason: 'Lost the change' });
  eq(w.status, 200, 'write off ' + JSON.stringify(w.body));
  const row = await moRow(g.body.data.id);
  eq(row.status, 'written_off', 'status');
  eq(row.close_reason, 'Lost the change', 'reason');
  const wo = (await billsOf(g.body.data.id)).find((b) => b.description.startsWith('Shopping money written off'));
  assert(wo, 'write-off expense');
  eq(wo.description, 'Shopping money written off — VerifySM Ravi', 'description');
  eq(Number(wo.amount), 100, 'remainder');
  eq(wo.payment_method, 'shopping_money', 'method');
  eq(wo.given_to_user_id, c.r2, 'given to');
  eq(await drawer(reg), before, 'drawer unchanged');
  assert(await auditOf(g.body.data.id, 'shopping_money_written_off'), 'audit');
  eq((await api('POST', `/staff-money/${g.body.data.id}/write-off`, c.owner, { reason: 'again' })).status, 409, 'second write-off');
});

check('B3: the card marks lines late after the set days; history and My money', async () => {
  const c = await getCast();
  const db = await getDb();
  const old = await db.prepare(`INSERT INTO staff_money_out (location_id, user_id, amount, payment_method, given_by, approved_by, status, created_at)
    VALUES (?, ?, 90, 'upi', ?, ?, 'open', CURRENT_TIMESTAMP - make_interval(days => ?)) RETURNING id`).get(TEST_LOCATION_ID, c.r4, c.owner, c.owner, c.limits.lateDays + 1);
  createdMoneyOutIds.push(old.id);
  const fresh = await hand(c.counter, { user_id: c.r4, amount: 20, payment_method: 'upi' });
  const open = await api('GET', `/staff-money/open?location_id=${TEST_LOCATION_ID}`, c.counter);
  eq(open.status, 200, 'open');
  const o = open.body.data.shopping.find((x) => x.id === old.id);
  const f = open.body.data.shopping.find((x) => x.id === fresh.body.data.id);
  eq(o.late, true, 'old line late');
  eq(f.late, false, 'fresh line not late');
  eq(o.user_name, 'VerifySM Raju', 'user_name');
  eq(o.given_by_name, 'VerifySM Owner', 'given_by_name');
  for (const k of ['id', 'user_id', 'user_name', 'remaining', 'created_at', 'given_by_name', 'late']) assert(k in f, 'missing ' + k);
  eq((await api('GET', `/staff-money/open`, c.counter)).status, 400, 'open without a shop');
  const h = await api('GET', `/staff-money/history?location_id=${TEST_LOCATION_ID}&user_id=${c.r1}`, c.mgr);
  eq(h.status, 200, 'history');
  assert(h.body.data.length >= 2 && h.body.data.every((x) => x.user_id === c.r1), 'history filtered by person');
  const withBills = h.body.data.find((x) => x.id === flow.id);
  assert(withBills && withBills.bills.length >= 1, 'history carries bills');
  const ho = await api('GET', `/staff-money/history?location_id=${TEST_LOCATION_ID}&status=open`, c.owner);
  assert(ho.body.data.every((x) => x.status === 'open'), 'status filter');
  eq((await api('GET', `/staff-money/history?location_id=${TEST_LOCATION_ID}`, c.counter)).status, 403, 'counter staff no history');
  const mine = await api('GET', '/staff-money/mine', c.r4);
  eq(mine.status, 200, 'mine ' + JSON.stringify(mine.body));
  assert(mine.body.data.shopping.some((x) => x.id === old.id), 'mine lists own holding');
  eq(mine.body.data.shopping_held, 110, 'held total');
});

check('B3: shopping money follows the limits and PIN rules; owner told of a PIN amount', async () => {
  const c = await getCast();
  await openOwnRegister();
  const over = await hand(c.counter, { user_id: c.r3, amount: c.limits.shoppingDay + 1, payment_method: 'upi' });
  eq(over.status, 409, 'over day');
  eq(over.body.needs_pin, 'over_day', 'reason');
  eq(over.body.message, `That's more than the ₹${c.limits.shoppingDay.toLocaleString('en-IN')} daily shopping money limit. A manager or owner can confirm with their PIN.`, 'copy');
  const self = await hand(c.counter, { user_id: c.counter, amount: 10, payment_method: 'upi' });
  eq(self.status, 409, 'self');
  eq(self.body.message, SELF_COPY, 'self copy');
  const ok = await hand(c.counter, { user_id: c.r3, amount: c.limits.shoppingDay + 1, payment_method: 'upi', approver_id: c.mgr, approver_pin: '5932' });
  eq(ok.status, 201, 'with pin ' + JSON.stringify(ok.body));
  eq((await moRow(ok.body.data.id)).approved_by, c.mgr, 'approved_by');
  const n = await (await getDb()).prepare("SELECT 1 AS ok FROM notifications WHERE user_id = ? AND type = 'staff_money_shopping' AND (data::jsonb->>'moneyOutId')::int = ?").get(c.owner, ok.body.data.id);
  assert(n, 'owner told');
});

check('B3 RF2: change back the next day lands in that day\'s session; the closed session is untouched', async () => {
  const c = await getCast();
  await closeOwnRegister(); // a fresh session holds only this hand-out
  const r1 = await openOwnRegister();
  const g = await hand(c.counter, { user_id: c.r4, amount: 200 });
  eq(g.status, 201, 'hand');
  await closeOwnRegister();
  const db = await getDb();
  // Back-date only this run's register and hand-out by one day.
  await db.prepare(`UPDATE cash_registers SET opened_at = opened_at - interval '1 day', opening_time = opening_time - interval '1 day',
    closed_at = closed_at - interval '1 day', closing_time = closing_time - interval '1 day', date = date - 1 WHERE id = ?`).run(r1);
  await db.prepare("UPDATE staff_money_out SET created_at = created_at - interval '1 day' WHERE id = ?").run(g.body.data.id);
  const closedBefore = await db.prepare('SELECT expected_cash, actual_cash, discrepancy, closed_at FROM cash_registers WHERE id = ?').get(r1);
  const r2 = await openOwnRegister();
  assert(r2 !== r1, 'a new session');
  const before = await drawer(r2);
  const s = await settle(c.counter, g.body.data.id, { change_back: 200, change_method: 'cash', final: true });
  eq(s.status, 200, 'settle ' + JSON.stringify(s.body));
  eq(await drawer(r2), before + 200, 'today\'s session +200');
  const closedAfter = await db.prepare('SELECT expected_cash, actual_cash, discrepancy, closed_at FROM cash_registers WHERE id = ?').get(r1);
  eq(JSON.stringify(closedAfter), JSON.stringify(closedBefore), 'closed session untouched');
  const row = await db.prepare('SELECT register_id FROM staff_money_settles WHERE money_out_id = ?').get(g.body.data.id);
  eq(row.register_id, r2, 'change row in today\'s session');
  const st = await regStatus();
  eq(st.shopping_in, 200, 'status shopping_in');
  eq(st.shopping_out, 0, 'no hand-out in this session');
  eq(st.expected_cash, st.running_expected_cash, 'status = running');
  const hist = await api('GET', `/sales/register/history?location_id=${TEST_LOCATION_ID}&limit=1000`, c.owner);
  const h1 = hist.body.data.find((x) => x.id === r1);
  assert(h1, 'closed session in history');
  eq(h1.shopping_out, 200, 'history shopping_out');
  eq(h1.shopping_in, 0, 'history shopping_in');
  eq(h1.owes_paid, 0, 'history owes_paid');
  await closeOwnRegister();
  const closedStatus = await regStatus();
  eq(closedStatus.id, r2, 'status shows the session just closed');
  eq(closedStatus.shopping_in, 200, 'closed status shopping_in');
  // inferred expenses leave shopping money out
  eq(closedStatus.total_expenses_cash, 0, 'closed session inferred expenses exclude shopping lines');
});

// ── B4: own pocket and Shop owes ──
const OWES_PAID_BACK_COPY = "The shop already paid back part of this, so it can't be removed. Ask the owner if it needs fixing.";
async function ownPocket(user, body) {
  return api('POST', '/expenses', user, {
    location_id: TEST_LOCATION_ID, category: 'supplies', description: 'VerifySM own pocket', payment_method: 'own_pocket', ...body,
  });
}
const createdOwesIds = new Set();
async function owesOf(expenseId) {
  const row = await (await getDb()).prepare('SELECT * FROM shop_owes WHERE expense_id = ?').get(expenseId);
  if (row) createdOwesIds.add(Number(row.id));
  return row;
}
const owesRow = async (id) => (await getDb()).prepare('SELECT * FROM shop_owes WHERE id = ?').get(id);
const payBack = (user, id, body) => api('POST', `/staff-money/owes/${id}/pay-back`, user, body);
const owesAudit = async (id, action) => (await getDb()).prepare("SELECT * FROM audit_logs WHERE entity_type = 'shop_owes' AND entity_id = ? AND action = ?").get(id, action);

check('B4: helper and florist get 403 on the owes routes; helper cannot add own pocket', async () => {
  const c = await getCast();
  for (const who of [c.helper, c.florist]) {
    for (const [m, p, b] of [
      ['POST', '/staff-money/owes/1/pay-back', { amount: 1, method: 'upi' }],
      ['POST', '/staff-money/owes/1/keep', {}],
      ['POST', '/staff-money/owes/1/write-off', { reason: 'x' }],
    ]) eq((await api(m, p, who, b)).status, 403, `${who === c.helper ? 'helper' : 'florist'} ${p}`);
  }
  eq((await ownPocket(c.helper, { amount: 10, paid_by_user_id: c.helper })).status, 403, 'helper own pocket');
});

let b4 = null;
check('B4: own-pocket expense: no drawer change, no register, Shop owes row for that person, audited', async () => {
  const c = await getCast();
  const reg = await openOwnRegister();
  const st0 = await regStatus();
  const before = await drawer(reg);
  const r = await ownPocket(c.counter, { amount: 120 });
  eq(r.status, 201, 'create ' + JSON.stringify(r.body));
  const e = await expRow(r.body.data.id);
  eq(e.payment_method, 'own_pocket', 'method');
  eq(e.paid_by_user_id, c.counter, 'defaults to Me');
  eq(e.register_id, null, 'no register');
  eq(await drawer(reg), before, 'drawer unchanged');
  const o = await owesOf(e.id);
  assert(o, 'owes row');
  eq(o.user_id, c.counter, 'owes person');
  eq(Number(o.amount), 120, 'owes amount');
  eq(o.source, 'own_pocket', 'source');
  eq(o.status, 'open', 'open');
  eq(o.location_id, TEST_LOCATION_ID, 'shop');
  assert(await owesAudit(o.id, 'own_pocket_expense'), 'audit');
  const st = await regStatus();
  eq(st.expected_cash, st0.expected_cash, 'status expected unchanged');
  eq(st.expected_cash, st.running_expected_cash, 'status = running');
  const pv = await api('PUT', '/sales/register/close', c.owner, { location_id: TEST_LOCATION_ID, actual_cash: st.expected_cash, preview: true });
  eq(pv.body.data.expected_cash, st.expected_cash, 'close preview ignores own pocket');
  const open = await api('GET', `/staff-money/open?location_id=${TEST_LOCATION_ID}`, c.counter);
  assert(open.body.data.owes.some((x) => x.id === o.id && x.remaining === 120 && x.source === 'own_pocket'), 'card lists it');
  b4 = { reg, selfExpense: e.id, selfOwes: o.id };
});

check('B4: counter staff mark own pocket for a named colleague; a person from elsewhere is refused', async () => {
  const c = await getCast();
  await openOwnRegister();
  const r = await ownPocket(c.counter, { amount: 75, paid_by_user_id: c.r1 });
  eq(r.status, 201, 'colleague ' + JSON.stringify(r.body));
  const o = await owesOf(r.body.data.id);
  eq(o.user_id, c.r1, 'owes the colleague');
  eq((await expRow(r.body.data.id)).paid_by_user_id, c.r1, 'paid_by');
  const bad = await ownPocket(c.counter, { amount: 75, paid_by_user_id: c.unlinked });
  eq(bad.status, 400, 'unlinked person');
  eq(bad.body.message, "That person can't be picked here. Tap Whose? and pick again.", 'copy');
  const ret = await ownPocket(c.counter, { amount: 75, is_return: true });
  eq(ret.status, 400, 'own pocket return refused');
  const own = await ownPocket(c.owner, { amount: 10, paid_by_user_id: c.owner });
  eq(own.status, 201, 'owner for themself');
  b4.colleagueOwes = o.id;
  b4.ownerExpense = own.body.data.id;
});

check('B4: own_pocket and shopping_money rows are never counted by drawer queries', async () => {
  const c = await getCast();
  const reg = await openOwnRegister();
  const db = await getDb();
  const st0 = await regStatus();
  // Even with register_id set by mistake, a non-cash row stays out of the drawer.
  const e = await db.prepare(`INSERT INTO expenses (location_id, category, amount, description, payment_method, expense_date, created_by, register_id, paid_by_user_id)
    VALUES (?, 'supplies', 33, 'VerifySM stray', 'own_pocket', CAST(? AS date), ?, ?, ?) RETURNING id`).get(TEST_LOCATION_ID, todayStr(), c.counter, reg, c.counter);
  const st = await regStatus();
  eq(st.expected_cash, st0.expected_cash, 'status unchanged');
  eq(st.total_expenses_cash || 0, st0.total_expenses_cash || 0, 'cash expenses unchanged');
  const pv = await api('PUT', '/sales/register/close', c.owner, { location_id: TEST_LOCATION_ID, actual_cash: st.expected_cash, preview: true });
  eq(pv.body.data.expected_cash, st0.expected_cash, 'preview unchanged');
  await db.prepare('DELETE FROM expenses WHERE id = ?').run(e.id);
});

check('B4: pay back 850 cash: drawer -850, locked count follows, status paid, audited; again is 409', async () => {
  const c = await getCast();
  const reg = await openOwnRegister();
  const db = await getDb();
  const ex = await ownPocket(c.owner, { amount: 850, paid_by_user_id: c.owner });
  eq(ex.status, 201, 'own pocket 850');
  const o = await owesOf(ex.body.data.id);
  await db.prepare('UPDATE cash_registers SET close_count_locked = 2000 WHERE id = ?').run(reg);
  const before = await drawer(reg);
  const st0 = await regStatus();
  const p = await payBack(c.counter, o.id, { amount: 850, method: 'cash' });
  eq(p.status, 200, 'pay back ' + JSON.stringify(p.body));
  eq(p.body.data.status, 'paid', 'paid');
  eq(p.body.data.remaining, 0, 'remaining 0');
  eq(await drawer(reg), before - 850, 'drawer -850');
  eq(Number((await db.prepare('SELECT close_count_locked FROM cash_registers WHERE id = ?').get(reg)).close_count_locked), 1150, 'locked count follows');
  await db.prepare('UPDATE cash_registers SET close_count_locked = NULL WHERE id = ?').run(reg);
  const row = await owesRow(o.id);
  eq(row.status, 'paid', 'row paid');
  eq(Number(row.paid_amount), 850, 'paid_amount');
  assert(row.closed_at, 'closed_at');
  const pay = await db.prepare('SELECT * FROM shop_owes_payments WHERE owes_id = ?').all(o.id);
  eq(pay.length, 1, 'one payment');
  eq(pay[0].register_id, reg, 'payment register');
  eq(pay[0].method, 'cash', 'payment method');
  eq(pay[0].paid_by, c.counter, 'paid_by');
  assert(await owesAudit(o.id, 'shop_owes_paid_back'), 'audit');
  const st = await regStatus();
  eq(st.owes_paid, Math.round((Number(st0.owes_paid || 0) + 850) * 100) / 100, 'status owes_paid');
  eq(st.expected_cash, st.running_expected_cash, 'status = running');
  eq(st.expected_cash, Math.round((st0.expected_cash - 850) * 100) / 100, 'status down 850');
  const again = await payBack(c.counter, o.id, { amount: 1, method: 'cash' });
  eq(again.status, 409, 'second pay back');
  eq(again.body.message, ALREADY_DONE, 'copy');
  eq(await drawer(reg), before - 850, 'drawer moved once');
});

check('B4: part pay back by UPI moves no drawer; over the rest is refused; the rest in cash closes it', async () => {
  const c = await getCast();
  const reg = await openOwnRegister();
  const db = await getDb();
  const ex = await ownPocket(c.counter, { amount: 500, paid_by_user_id: c.r3 });
  const o = await owesOf(ex.body.data.id);
  const before = await drawer(reg);
  const p1 = await payBack(c.counter, o.id, { amount: 300, method: 'upi' });
  eq(p1.status, 200, 'part ' + JSON.stringify(p1.body));
  eq(p1.body.data.remaining, 200, 'remaining 200');
  eq(p1.body.data.status, 'open', 'still open');
  eq(await drawer(reg), before, 'UPI moves no drawer');
  const pay = await db.prepare('SELECT * FROM shop_owes_payments WHERE owes_id = ?').get(o.id);
  eq(pay.register_id, null, 'UPI payment has no register');
  const over = await payBack(c.counter, o.id, { amount: 200.01, method: 'cash' });
  eq(over.status, 400, 'over the rest');
  eq(over.body.message, 'The shop owes VerifySM only ₹200. Type ₹200 or less.', 'over copy');
  eq((await payBack(c.counter, o.id, { amount: 0, method: 'cash' })).status, 400, 'zero');
  eq((await payBack(c.counter, o.id, { amount: 10, method: 'card' })).status, 400, 'card');
  const t = await api('GET', '/staff-money/mine', c.r3);
  assert(t.body.data.owes.some((x) => x.id === o.id && x.remaining === 200), 'My money shows what is owed');
  const p2 = await payBack(c.counter, o.id, { amount: 200, method: 'cash' });
  eq(p2.status, 200, 'rest');
  eq(p2.body.data.status, 'paid', 'paid');
  eq(await drawer(reg), before - 200, 'drawer -200');
});

check('B4: cash pay back with the register closed is refused in plain words; UPI still works', async () => {
  const c = await getCast();
  await openOwnRegister();
  const ex = await ownPocket(c.counter, { amount: 40, paid_by_user_id: c.r1 });
  const o = await owesOf(ex.body.data.id);
  await closeOwnRegister();
  if (await testLocRegister()) throw skip('Test Loc has an open register; skipped.');
  const r = await payBack(c.counter, o.id, { amount: 40, method: 'cash' });
  eq(r.status, 400, 'closed');
  eq(r.body.message, CLOSED_COPY, 'copy');
  eq(Number((await owesRow(o.id)).paid_amount), 0, 'nothing paid');
  const u = await payBack(c.counter, o.id, { amount: 40, method: 'upi' });
  eq(u.status, 200, 'UPI with the register shut');
  await openOwnRegister();
});

check('B4: Keep as my money: owner, own line only; staff and manager cannot', async () => {
  const c = await getCast();
  await openOwnRegister();
  const o = await owesOf(b4.ownerExpense);
  eq((await api('POST', `/staff-money/owes/${o.id}/keep`, c.counter)).status, 403, 'counter staff');
  eq((await api('POST', `/staff-money/owes/${o.id}/keep`, c.mgr)).status, 403, 'manager');
  const notOwn = await api('POST', `/staff-money/owes/${b4.colleagueOwes}/keep`, c.owner);
  eq(notOwn.status, 403, 'owner on someone else\'s line');
  eq((await owesRow(b4.colleagueOwes)).status, 'open', 'colleague line still open');
  const k = await api('POST', `/staff-money/owes/${o.id}/keep`, c.owner);
  eq(k.status, 200, 'keep ' + JSON.stringify(k.body));
  const row = await owesRow(o.id);
  eq(row.status, 'kept', 'kept');
  assert(row.closed_at, 'closed_at');
  assert(await owesAudit(o.id, 'shop_owes_kept'), 'audit');
  eq((await api('POST', `/staff-money/owes/${o.id}/keep`, c.owner)).status, 409, 'second keep');
  const open = await api('GET', `/staff-money/open?location_id=${TEST_LOCATION_ID}`, c.counter);
  assert(!open.body.data.owes.some((x) => x.id === o.id), 'kept line leaves the card');
});

check('B4: owner writes off a Shop owes line with a reason; others cannot', async () => {
  const c = await getCast();
  const reg = await openOwnRegister();
  const id = b4.colleagueOwes;
  eq((await api('POST', `/staff-money/owes/${id}/write-off`, c.mgr, { reason: 'x' })).status, 403, 'manager');
  eq((await api('POST', `/staff-money/owes/${id}/write-off`, c.counter, { reason: 'x' })).status, 403, 'counter');
  const nr = await api('POST', `/staff-money/owes/${id}/write-off`, c.owner, { reason: '  ' });
  eq(nr.status, 400, 'reason needed');
  eq(nr.body.message, 'Type why this is written off.', 'reason copy');
  const before = await drawer(reg);
  const w = await api('POST', `/staff-money/owes/${id}/write-off`, c.owner, { reason: 'Ramesh said keep it' });
  eq(w.status, 200, 'write off ' + JSON.stringify(w.body));
  const row = await owesRow(id);
  eq(row.status, 'written_off', 'status');
  eq(row.close_reason, 'Ramesh said keep it', 'reason');
  eq(await drawer(reg), before, 'drawer unchanged');
  assert(await owesAudit(id, 'shop_owes_written_off'), 'audit');
  eq((await api('POST', `/staff-money/owes/${id}/write-off`, c.owner, { reason: 'x' })).status, 409, 'second');
});

check('B4: removing an own-pocket expense before pay back removes the owes; after part pay back it is refused', async () => {
  const c = await getCast();
  await openOwnRegister();
  const a = await ownPocket(c.counter, { amount: 60 });
  const oa = await owesOf(a.body.data.id);
  const d = await api('DELETE', `/expenses/${a.body.data.id}`, c.counter);
  eq(d.status, 200, 'remove ' + JSON.stringify(d.body));
  eq(await owesRow(oa.id), undefined, 'owes gone');
  const b = await ownPocket(c.counter, { amount: 90 });
  const ob = await owesOf(b.body.data.id);
  eq((await payBack(c.counter, ob.id, { amount: 10, method: 'upi' })).status, 200, 'part pay back');
  const d2 = await api('DELETE', `/expenses/${b.body.data.id}`, c.counter);
  eq(d2.status, 400, 'refused');
  eq(d2.body.message, OWES_PAID_BACK_COPY, 'copy');
  assert(await expRow(b.body.data.id), 'expense still there');
  eq(Number((await owesRow(ob.id)).amount), 90, 'owes unchanged');
  b4.partPaid = { expense: b.body.data.id, owes: ob.id };
});

check('B4: changing an own-pocket amount moves its owes; below what was paid back is refused', async () => {
  const c = await getCast();
  await openOwnRegister();
  const { expense, owes } = b4.partPaid;
  const up = await api('PUT', `/expenses/${expense}`, c.counter, { amount: 95, payment_method: 'own_pocket' });
  eq(up.status, 200, 'change ' + JSON.stringify(up.body));
  eq(Number((await owesRow(owes)).amount), 95, 'owes follows');
  const low = await api('PUT', `/expenses/${expense}`, c.counter, { amount: 5 });
  eq(low.status, 400, 'below paid');
  eq(low.body.message, 'The shop already paid back ₹10 of this. Type ₹10 or more.', 'copy');
  const who = await api('PUT', `/expenses/${expense}`, c.counter, { paid_by_user_id: c.r1 });
  eq(who.status, 400, 'person change after a pay back refused');
  const fresh = await ownPocket(c.counter, { amount: 30 });
  const sw = await api('PUT', `/expenses/${fresh.body.data.id}`, c.counter, { paid_by_user_id: c.r1 });
  eq(sw.status, 200, 'person change before a pay back ' + JSON.stringify(sw.body));
  eq((await owesOf(fresh.body.data.id)).user_id, c.r1, 'owes moves to the new person');
  eq((await expRow(fresh.body.data.id)).paid_by_user_id, c.r1, 'paid_by moves');
});

check('B4: switching cash to own pocket gives the drawer back and opens owes; own pocket to UPI drops the owes', async () => {
  const c = await getCast();
  const reg = await openOwnRegister();
  const before = await drawer(reg);
  const e = await api('POST', '/expenses', c.counter, { location_id: TEST_LOCATION_ID, category: 'supplies', description: 'VerifySM switch', amount: 45, payment_method: 'cash' });
  eq(e.status, 201, 'cash expense');
  eq(await drawer(reg), before - 45, 'drawer -45');
  const toOwn = await api('PUT', `/expenses/${e.body.data.id}`, c.counter, { payment_method: 'own_pocket' });
  eq(toOwn.status, 200, 'to own pocket ' + JSON.stringify(toOwn.body));
  eq(await drawer(reg), before, 'drawer back');
  const row = await expRow(e.body.data.id);
  eq(row.register_id, null, 'register cleared');
  eq(row.paid_by_user_id, c.counter, 'paid by Me');
  const o = await owesOf(e.body.data.id);
  eq(o && o.status, 'open', 'owes opened');
  eq(Number(o.amount), 45, 'owes amount');
  const toUpi = await api('PUT', `/expenses/${e.body.data.id}`, c.counter, { payment_method: 'upi' });
  eq(toUpi.status, 200, 'to UPI');
  eq(await owesOf(e.body.data.id), undefined, 'owes dropped');
  eq((await expRow(e.body.data.id)).paid_by_user_id, null, 'paid_by cleared');
  const st = await regStatus();
  eq(st.expected_cash, st.running_expected_cash, 'status = running');
  // A partly paid-back own pocket line cannot leave own pocket.
  const out = await api('PUT', `/expenses/${b4.partPaid.expense}`, c.counter, { payment_method: 'cash' });
  eq(out.status, 400, 'paid-back line cannot switch method');
});

check('B4: two saves at once switching into own pocket open one owes line; the other is told to refresh', async () => {
  const c = await getCast();
  await openOwnRegister();
  const e = await api('POST', '/expenses', c.counter, { location_id: TEST_LOCATION_ID, category: 'supplies', description: 'VerifySM twice', amount: 25, payment_method: 'upi' });
  eq(e.status, 201, 'upi expense');
  const both = await Promise.all([1, 2].map(() => api('PUT', `/expenses/${e.body.data.id}`, c.counter, { payment_method: 'own_pocket' })));
  eq(both.map((r) => r.status).sort().join(','), '200,409', 'statuses ' + JSON.stringify(both.map((r) => r.body)));
  eq(both.find((r) => r.status === 409).body.message, 'Already saved — refresh.', 'copy');
  const rows = await (await getDb()).prepare("SELECT id FROM shop_owes WHERE expense_id = ? AND source = 'own_pocket'").all(e.body.data.id);
  eq(rows.length, 1, 'one owes line');
  await owesOf(e.body.data.id);
});

check('B4: a settle bill keeps shopping_money when sent back unchanged; switching into or out of it is refused', async () => {
  const c = await getCast();
  await openOwnRegister();
  const g = await hand(c.counter, { user_id: c.r4, amount: 50, payment_method: 'upi' });
  eq(g.status, 201, 'hand ' + JSON.stringify(g.body));
  const s = await settle(c.counter, g.body.data.id, { bills: [bill(20)] });
  eq(s.status, 200, 'settle');
  const billId = s.body.data.expense_ids[0];
  const note = await api('PUT', `/expenses/${billId}`, c.counter, { note: 'red ones', payment_method: 'shopping_money' });
  eq(note.status, 200, 'note edit with method unchanged ' + JSON.stringify(note.body));
  const out = await api('PUT', `/expenses/${billId}`, c.counter, { payment_method: 'upi' });
  eq(out.status, 400, 'out of shopping money');
  const e = await api('POST', '/expenses', c.counter, { location_id: TEST_LOCATION_ID, category: 'supplies', description: 'VerifySM upi', amount: 5, payment_method: 'upi' });
  const into = await api('PUT', `/expenses/${e.body.data.id}`, c.counter, { payment_method: 'shopping_money' });
  eq(into.status, 400, 'into shopping money');
  eq(into.body.message, 'Shopping money bills are added from the shopping money line. Pick Cash, UPI or Own pocket.', 'copy');
  eq((await api('POST', '/expenses', c.counter, { location_id: TEST_LOCATION_ID, category: 'supplies', description: 'x', amount: 5, payment_method: 'shopping_money' })).status, 400, 'POST shopping_money refused');
});

// ══ B5: payroll Take from pay (spec 5.6, 5.9, 5.10) ══
// Only throwaway VerifySM people are ever paid here.
const STALE_TAKE = 'Shopping money changed since you calculated — tap Calculate again.';
async function salaried(role, name) {
  const c = await getCast();
  const db = await getDb();
  const u = await makeUser(db, { role, name });
  await db.prepare("INSERT INTO employee_salaries (user_id, monthly_salary, salary_type, updated_by) VALUES (?, 15000, 'monthly', ?)").run(u, c.owner);
  return u;
}
let payPeriodYear = 2001;
function payPeriod() { const y = payPeriodYear++; return { period_start: `${y}-01-01`, period_end: `${y}-01-31` }; }
async function calc(userId, period) {
  const c = await getCast();
  const r = await api('POST', '/staff/payroll/calculate', c.owner, { user_id: userId, ...period });
  eq(r.status, 200, 'calculate ' + JSON.stringify(r.body));
  return r.body.data.calculation;
}
async function pay(userId, period, extra) {
  const c = await getCast();
  return api('POST', '/staff/payroll/disburse', c.owner, {
    user_id: userId, ...period, base_salary: 15000, deductions: 0, bonus: 0, advances_deducted: 0,
    payment_method: 'bank_transfer', ...extra,
  });
}
const linesOf = async (userId) => (await getDb()).prepare('SELECT * FROM staff_money_out WHERE user_id = ? ORDER BY id').all(userId);
const shopAdvOf = async (userId) => (await getDb()).prepare("SELECT * FROM salary_advances WHERE user_id = ? AND source = 'shopping_money' ORDER BY id").all(userId);
const paymentsOf = async (userId) => (await getDb()).prepare('SELECT * FROM salary_payments WHERE user_id = ? ORDER BY id').all(userId);

check('B5: calculate shows the open shopping money total (whole paise, part-settled lines count only what is left)', async () => {
  const c = await getCast();
  const u = await salaried('counter_staff', 'VerifySM PayCalc');
  const a = await hand(c.owner, { user_id: u, amount: 300.5, payment_method: 'upi' });
  const b = await hand(c.owner, { user_id: u, amount: 200, payment_method: 'upi' });
  eq(a.status, 201, 'hand a ' + JSON.stringify(a.body)); eq(b.status, 201, 'hand b');
  eq((await settle(c.owner, b.body.data.id, { bills: [bill(120.25)] })).status, 200, 'part settle');
  const calcd = await calc(u, payPeriod());
  eq(calcd.open_shopping_money_total, 380.25, 'open total');
  eq(calcd.net_amount, Math.max(0, Math.round((calcd.base_pay - calcd.deductions) * 100) / 100), 'net unchanged by the shopping line');
});

check('B5: take from pay makes one shopping_money advance, deducts it in the same payment, closes the lines as to_salary, drawer moves only by the pay', async () => {
  const c = await getCast();
  const reg = await openOwnRegister();
  const u = await salaried('counter_staff', 'VerifySM PayTake');
  const a = await hand(c.owner, { user_id: u, amount: 500, payment_method: 'cash' });
  const b = await hand(c.owner, { user_id: u, amount: 100, payment_method: 'upi' });
  eq((await settle(c.owner, a.body.data.id, { bills: [bill(300)] })).status, 200, 'part settle');
  const period = payPeriod();
  const calcd = await calc(u, period);
  eq(calcd.open_shopping_money_total, 300, 'open total');
  const before = await drawer(reg);
  const r = await pay(u, period, { payment_method: 'cash', net_amount: 14700, take_shopping_money: { expected_total: 300 } });
  eq(r.status, 201, 'disburse ' + JSON.stringify(r.body));
  eq(Number(r.body.data.advances_deducted), 300, 'advances_deducted includes the shopping money');
  eq(await drawer(reg), before - 14700, 'drawer down by the pay only');
  const advs = await shopAdvOf(u);
  eq(advs.length, 1, 'one shopping_money advance');
  const adv = advs[0];
  createdAdvanceIds.push(adv.id);
  eq(Number(adv.amount), 300, 'advance amount');
  eq(adv.status, 'repaid', 'deducted in the same payment');
  eq(Number(adv.repaid_amount), 300, 'repaid amount');
  eq(adv.payment_method, 'shopping_money', 'non-drawer method');
  eq(adv.expense_id, null, 'no expense link');
  eq(String(adv.date).slice(0, 10), todayStr(), 'shop-local date');
  eq(adv.given_by, c.owner, 'given_by');
  for (const line of await linesOf(u)) {
    eq(line.status, 'to_salary', `line ${line.id} status`);
    assert(line.closed_at, `line ${line.id} closed_at`);
    assert(/pay/i.test(line.close_reason || ''), `line ${line.id} close_reason ${line.close_reason}`);
    assert(await auditOf(line.id, 'shopping_money_taken_from_pay'), `audit for line ${line.id}`);
  }
  const salaryExp = await (await getDb()).prepare("SELECT COUNT(*)::int AS n FROM expenses WHERE employee_id = ? AND category = 'salary'").get(u);
  eq(salaryExp.n, 1, 'only the pay expense, none for the shopping advance');
  const t = await sm.totals(await getDb(), { userId: u });
  eq(t.shoppingHeld, 0, 'nothing held'); eq(t.advancesUnpaid, 0, 'nothing unpaid'); eq(t.advanceToday, 0, 'not counted as an advance given today');
  eq((await settle(c.owner, a.body.data.id, { bills: [bill(10)] })).status, 409, 'settle a to_salary line refused');
  eq((await api('DELETE', `/staff-money/${b.body.data.id}`, c.owner)).status, 409, 'remove a to_salary line refused');
  eq((await api('POST', `/staff-money/${b.body.data.id}/write-off`, c.owner, { reason: 'x' })).status, 409, 'write off a to_salary line refused');
  const st = await regStatus();
  eq(st.expected_cash, st.running_expected_cash, 'register status = running');
});

check('stale take-from-pay refused', async () => {
  const c = await getCast();
  const u = await salaried('counter_staff', 'VerifySM PayStale');
  const a = await hand(c.owner, { user_id: u, amount: 400, payment_method: 'upi' });
  eq(a.status, 201, 'hand');
  const period = payPeriod();
  const calcd = await calc(u, period);
  eq(calcd.open_shopping_money_total, 400, 'open total at calculate');
  eq((await settle(c.owner, a.body.data.id, { bills: [bill(150)] })).status, 200, 'part settle in between');
  const r = await pay(u, period, { net_amount: 14600, take_shopping_money: { expected_total: 400 } });
  eq(r.status, 409, 'status');
  eq(r.body.message, STALE_TAKE, 'copy');
  eq((await paymentsOf(u)).length, 0, 'nothing paid');
  eq((await shopAdvOf(u)).length, 0, 'no advance');
  const line = await moRow(a.body.data.id);
  eq(line.status, 'open', 'line still open');
  eq(Number(line.settled_amount), 150, 'line unchanged');
  eq((await (await getDb()).prepare("SELECT COUNT(*)::int AS n FROM expenses WHERE employee_id = ? AND category = 'salary'").get(u)).n, 0, 'no pay expense');
  const again = await calc(u, period);
  eq(again.open_shopping_money_total, 250, 'fresh total');
  const ok = await pay(u, period, { net_amount: 14750, take_shopping_money: { expected_total: 250 } });
  eq(ok.status, 201, 'paid with the fresh total ' + JSON.stringify(ok.body));
  for (const x of await shopAdvOf(u)) createdAdvanceIds.push(x.id);
});

check('B5: rider gets 0 and no option; a take request for a rider is refused', async () => {
  const c = await getCast();
  const u = await salaried('delivery_partner', 'VerifySM PayRider');
  const a = await hand(c.owner, { user_id: u, amount: 250, payment_method: 'upi' });
  eq(a.status, 201, 'hand');
  const period = payPeriod();
  eq((await calc(u, period)).open_shopping_money_total, 0, 'rider total');
  const r = await pay(u, period, { net_amount: 14750, take_shopping_money: { expected_total: 250 } });
  eq(r.status, 409, 'rider take refused');
  eq((await paymentsOf(u)).length, 0, 'nothing paid');
  eq((await moRow(a.body.data.id)).status, 'open', 'rider line still open');
  const plain = await pay(u, period, { net_amount: 15000 });
  eq(plain.status, 201, 'plain pay still works');
  eq((await moRow(a.body.data.id)).status, 'open', 'plain pay leaves the line alone');
});

check('B5: no take_shopping_money leaves open shopping money alone', async () => {
  const c = await getCast();
  const u = await salaried('employee', 'VerifySM PayNoTake');
  const a = await hand(c.owner, { user_id: u, amount: 90, payment_method: 'upi' });
  const period = payPeriod();
  eq((await calc(u, period)).open_shopping_money_total, 90, 'offered');
  const r = await pay(u, period, { net_amount: 15000 });
  eq(r.status, 201, 'paid');
  eq((await moRow(a.body.data.id)).status, 'open', 'line still open');
  eq((await shopAdvOf(u)).length, 0, 'no advance');
  const bad = await pay(u, payPeriod(), { net_amount: 15000, take_shopping_money: { expected_total: 'abc' } });
  eq(bad.status, 400, 'bad expected_total');
  eq(bad.body.message, "The shopping money amount didn't come through right — tap Calculate again.", 'bad copy');
});

check('B5: two Pays at once take the shopping money once', async () => {
  const c = await getCast();
  const u = await salaried('counter_staff', 'VerifySM PayTwice');
  const a = await hand(c.owner, { user_id: u, amount: 120, payment_method: 'upi' });
  eq(a.status, 201, 'hand');
  const p1 = payPeriod(); const p2 = payPeriod();
  const both = await Promise.all([p1, p2].map((p) => pay(u, p, { net_amount: 14880, take_shopping_money: { expected_total: 120 } })));
  eq(both.map((r) => r.status).sort().join(','), '201,409', 'statuses ' + JSON.stringify(both.map((r) => r.body)));
  eq(both.find((r) => r.status === 409).body.message, STALE_TAKE, 'second is told to recalculate');
  const advs = await shopAdvOf(u);
  for (const x of advs) createdAdvanceIds.push(x.id);
  eq(advs.length, 1, 'one advance');
  eq((await paymentsOf(u)).length, 1, 'one payment');
});

check('B5: a take with a pay that was not reduced by it is refused; nothing written', async () => {
  const c = await getCast();
  const u = await salaried('counter_staff', 'VerifySM PayFullNet');
  const a = await hand(c.owner, { user_id: u, amount: 300, payment_method: 'upi' });
  eq(a.status, 201, 'hand');
  const period = payPeriod();
  eq((await calc(u, period)).open_shopping_money_total, 300, 'offered');
  const r = await pay(u, period, { net_amount: 15000, take_shopping_money: { expected_total: 300 } });
  eq(r.status, 409, 'full net refused ' + JSON.stringify(r.body));
  assert(/tap Calculate again/.test(r.body.message), 'copy: ' + r.body.message);
  eq((await moRow(a.body.data.id)).status, 'open', 'line still open');
  eq((await shopAdvOf(u)).length, 0, 'no advance');
  eq((await paymentsOf(u)).length, 0, 'no payment');
  eq((await (await getDb()).prepare("SELECT COUNT(*)::int AS n FROM expenses WHERE employee_id = ? AND category = 'salary'").get(u)).n, 0, 'no pay expense');
  const half = await pay(u, period, { net_amount: 14700.01, take_shopping_money: { expected_total: 300 } });
  eq(half.status, 409, 'one paisa over refused');
  const ok = await pay(u, period, { net_amount: 14700, take_shopping_money: { expected_total: 300 } });
  eq(ok.status, 201, 'reduced net paid');
  for (const x of await shopAdvOf(u)) createdAdvanceIds.push(x.id);
});

// ══ Final review fixes (final-fix-wave-B) ══
let fresh = null;
async function freshPerson() {
  if (fresh) return fresh;
  fresh = await makeUser(await getDb(), { role: 'counter_staff', name: 'VerifySM Fresh' });
  return fresh;
}
const lockedCount = async (id) => {
  const r = await (await getDb()).prepare('SELECT close_count_locked FROM cash_registers WHERE id = ?').get(id);
  return r.close_count_locked == null ? null : Number(r.close_count_locked);
};

check('Fix I1: unpaid_after only for owner, a manager allowed to see that pay, or the person themself', async () => {
  const c = await getCast();
  const u = await freshPerson();
  const byCounter = await give(c.counter, { user_id: u, amount: 10, payment_method: 'upi' });
  eq(byCounter.status, 201, 'counter gives ' + JSON.stringify(byCounter.body));
  eq('unpaid_after' in byCounter.body.data, false, 'counter staff giving to a colleague sees no unpaid_after');
  const byOwner = await give(c.owner, { user_id: u, amount: 10, payment_method: 'upi' });
  eq(byOwner.status, 201, 'owner gives');
  eq(byOwner.body.data.unpaid_after, 20, 'owner sees unpaid_after');
  // Pay visibility (2026-11-19): a manager sees it only for people the owner switched on.
  const hidden = await give(c.mgr, { user_id: u, amount: 10, payment_method: 'upi' });
  eq(hidden.status, 201, 'manager gives');
  eq('unpaid_after' in hidden.body.data, false, 'manager without pay access sees no unpaid_after');
  const db = await getDb();
  await db.prepare('INSERT INTO pay_viewers (manager_id, employee_id, created_by) VALUES (?, ?, ?)').run(c.mgr, u, c.owner);
  try {
    const byMgr = await give(c.mgr, { user_id: u, amount: 10, payment_method: 'upi' });
    eq(byMgr.status, 201, 'manager gives');
    eq(byMgr.body.data.unpaid_after, 40, 'manager allowed to see pay sees unpaid_after');
  } finally {
    await db.prepare('DELETE FROM pay_viewers WHERE manager_id = ? AND employee_id = ?').run(c.mgr, u);
  }
  const self = await give(c.mgr, { user_id: c.mgr, amount: 10, payment_method: 'upi' });
  eq(self.status, 201, 'manager self ' + JSON.stringify(self.body));
  assert(typeof self.body.data.unpaid_after === 'number', 'the person themself sees unpaid_after');
});

check('Fix M1: a cash advance moves a locked blind count; removing its expense moves it back', async () => {
  const c = await getCast();
  const u = await freshPerson();
  const reg = await openOwnRegister();
  const db = await getDb();
  await db.prepare('UPDATE cash_registers SET close_count_locked = 2000 WHERE id = ?').run(reg);
  try {
    const before = await drawer(reg);
    const g = await give(c.owner, { user_id: u, amount: 30 });
    eq(g.status, 201, 'give ' + JSON.stringify(g.body));
    eq(await drawer(reg), before - 30, 'expected cash -30');
    eq(await lockedCount(reg), 1970, 'locked count -30');
    const up = await api('PUT', `/expenses/${g.body.data.expense_id}`, c.owner, { amount: 40 });
    eq(up.status, 200, 'amount change ' + JSON.stringify(up.body));
    eq(await lockedCount(reg), 1960, 'locked count follows an amount change');
    const d = await api('DELETE', `/expenses/${g.body.data.expense_id}`, c.owner);
    eq(d.status, 200, 'remove ' + JSON.stringify(d.body));
    eq(await drawer(reg), before, 'expected cash back');
    eq(await lockedCount(reg), 2000, 'locked count back');
  } finally {
    await db.prepare('UPDATE cash_registers SET close_count_locked = NULL WHERE id = ?').run(reg);
  }
});

check('Fix I2: removing an overspent bill while the overspend is paid back in cash: both finish, no 500', async () => {
  const c = await getCast();
  const u = await freshPerson();
  const reg = await openOwnRegister();
  const db = await getDb();
  for (let round = 0; round < 4; round++) {
    const g = await hand(c.owner, { user_id: u, amount: 500 });
    eq(g.status, 201, 'hand ' + JSON.stringify(g.body));
    const r = await settle(c.counter, g.body.data.id, { bills: [bill(400), bill(220, 'VerifySM Foam'), bill(50, 'VerifySM Tape')], final: true });
    eq(r.status, 200, 'settle ' + JSON.stringify(r.body));
    const owesId = r.body.data.owes_id;
    eq(Number((await owesRow(owesId)).amount), 170, 'owes 170');
    const tape = (await billsOf(g.body.data.id)).find((b) => b.description.startsWith('VerifySM Tape'));
    const before = await drawer(reg);
    const [del, pb] = await Promise.all([
      api('DELETE', `/expenses/${tape.id}`, c.owner),
      payBack(c.counter, owesId, { amount: 50, method: 'cash' }),
    ]);
    eq(del.status, 200, `round ${round} remove ${JSON.stringify(del.body)}`);
    eq(pb.status, 200, `round ${round} pay back ${JSON.stringify(pb.body)}`);
    const o = await owesRow(owesId);
    eq(Number(o.amount), 120, 'owes shrank to 120');
    eq(Number(o.paid_amount), 50, 'paid 50');
    eq(await drawer(reg), before - 50, 'drawer -50 once');
  }
  // Order check: the remove path locks the overspend line before the register,
  // so a remove waiting on a pay-back that holds the owes line never holds the register.
  const g = await hand(c.owner, { user_id: u, amount: 500 });
  const r = await settle(c.counter, g.body.data.id, { bills: [bill(400), bill(220, 'VerifySM Foam'), bill(50, 'VerifySM Tape')], final: true });
  const owesId = r.body.data.owes_id;
  const tape = (await billsOf(g.body.data.id)).find((b) => b.description.startsWith('VerifySM Tape'));
  const { withMoneyTx } = require('../config/database-async');
  let releaseHold;
  const hold = new Promise((res) => { releaseHold = res; });
  let held;
  const holder = withMoneyTx(async (tx) => {
    await tx.prepare('SELECT id FROM shop_owes WHERE id = ? FOR UPDATE').get(owesId);
    held();
    await hold;
  });
  await new Promise((res) => { held = res; });
  const delP = api('DELETE', `/expenses/${tape.id}`, c.owner);
  await new Promise((res) => setTimeout(res, 400));
  // While the remove waits on the owes line, the register must still be free.
  const probe = await withMoneyTx(async (tx) => {
    await tx.prepare("SET LOCAL lock_timeout = '1s'").run();
    return tx.prepare('SELECT id FROM cash_registers WHERE id = ? FOR UPDATE').get(reg);
  }).then(() => 'free', (e) => 'blocked: ' + e.message);
  releaseHold();
  await holder;
  const del = await delP;
  eq(probe, 'free', 'register not held by a remove waiting on the overspend line');
  eq(del.status, 200, 'remove after the hold ' + JSON.stringify(del.body));
});

check('Fix M5: removing a bill names why the overspend line is closed', async () => {
  const c = await getCast();
  const u = await freshPerson();
  await openOwnRegister();
  const g = await hand(c.owner, { user_id: u, amount: 500 });
  const r = await settle(c.counter, g.body.data.id, { bills: [bill(400), bill(220, 'VerifySM Foam')], final: true });
  eq(r.status, 200, 'settle');
  const w = await api('POST', `/staff-money/owes/${r.body.data.owes_id}/write-off`, c.owner, { reason: 'Shop will not pay' });
  eq(w.status, 200, 'write off ' + JSON.stringify(w.body));
  const foam = (await billsOf(g.body.data.id)).find((b) => b.description.startsWith('VerifySM Foam'));
  const d = await api('DELETE', `/expenses/${foam.id}`, c.owner);
  eq(d.status, 400, 'refused');
  eq(d.body.message, "What was overspent was written off, so this can't be removed. Ask the owner if it needs fixing.", 'written-off copy');

  const g2 = await hand(c.owner, { user_id: u, amount: 500 });
  const r2 = await settle(c.counter, g2.body.data.id, { bills: [bill(400), bill(220, 'VerifySM Foam')], final: true });
  eq((await payBack(c.counter, r2.body.data.owes_id, { amount: 120, method: 'upi' })).status, 200, 'paid back in full');
  const foam2 = (await billsOf(g2.body.data.id)).find((b) => b.description.startsWith('VerifySM Foam'));
  const d2 = await api('DELETE', `/expenses/${foam2.id}`, c.owner);
  eq(d2.status, 400, 'refused after pay back');
  eq(d2.body.message, "The shop already paid back what was overspent, so this can't be removed. Ask the owner if it needs fixing.", 'paid copy');
});

check('Fix M4: limits fall back when 0, blank or negative; PUT /settings refuses them', async () => {
  const fake = (rows) => ({ prepare: () => ({ all: async () => rows }) });
  const bad = await sm.getLimits(fake([
    { key: 'advance_daily_limit', value: '0' }, { key: 'advance_monthly_limit', value: '' },
    { key: 'shopping_money_daily_limit', value: '-5' }, { key: 'shopping_money_late_days', value: '0' },
  ]));
  eq(JSON.stringify(bad), JSON.stringify({ advanceDay: 500, advanceMonth: 2000, shoppingDay: 1000, lateDays: 3 }), 'defaults');
  const good = await sm.getLimits(fake([
    { key: 'advance_daily_limit', value: '750' }, { key: 'shopping_money_late_days', value: '1' },
  ]));
  eq(good.advanceDay, 750, 'a set limit is kept');
  eq(good.lateDays, 1, 'late days 1 is kept');
  const c = await getCast();
  for (const [key, value] of [['advance_daily_limit', 0], ['advance_monthly_limit', ''], ['shopping_money_daily_limit', '-1'], ['shopping_money_late_days', '0'], ['advance_daily_limit', '12.5']]) {
    const r = await api('PUT', '/settings', c.owner, { settings: { [key]: value } });
    eq(r.status, 400, `${key}=${JSON.stringify(value)} refused`);
    assert(/type a whole/.test(r.body.message), 'plain copy: ' + r.body.message);
  }
  const cur = await (await getDb()).prepare("SELECT value FROM settings WHERE key = 'advance_daily_limit'").get();
  if (cur && /^\d+$/.test(String(cur.value)) && Number(cur.value) >= 1) {
    eq((await api('PUT', '/settings', c.owner, { settings: { advance_daily_limit: cur.value } })).status, 200, 'a valid value is saved');
  }
});

check('Fix M3: an earlier closed session today carries its staff money lines; inferred expenses stay 0', async () => {
  const c = await getCast();
  const u = await freshPerson();
  const open = await testLocRegister();
  if (open && !createdRegisterIds.includes(open.id)) throw skip(`Test Loc register #${open.id} is open and is not this run's; skipped.`);
  if (open) await closeOwnRegister();
  const reg = await openOwnRegister();
  const g = await hand(c.owner, { user_id: u, amount: 25 });
  eq(g.status, 201, 'hand ' + JSON.stringify(g.body));
  await closeOwnRegister();
  const st = await api('GET', `/sales/register/status?location_id=${TEST_LOCATION_ID}`, c.counter);
  eq(st.status, 200, 'status');
  const s = (st.body.todaySessions || []).find((x) => Number(x.id) === Number(reg));
  assert(s, 'session in todaySessions');
  eq(s.shopping_out, 25, 'shopping_out');
  eq(s.shopping_in, 0, 'shopping_in');
  eq(s.owes_paid, 0, 'owes_paid');
  eq(s.helper_floats, 0, 'helper_floats');
  eq(s.helper_handovers, 0, 'helper_handovers');
  const p = (n) => Math.round((Number(n) || 0) * 100);
  const inferred = (p(s.opening_balance) + p(s.total_cash_sales) - p(s.total_refunds_cash) - p(s.helper_floats) + p(s.helper_handovers)
    - p(s.shopping_out) + p(s.shopping_in) - p(s.owes_paid) - p(s.expected_cash)) / 100;
  eq(inferred, 0, 'Net Cash Expenses (app formula) is 0, not the hand-out');
});

async function cleanup() {
  const db = await getDb();
  const del = async (label, sql, ...p) => { try { await db.prepare(sql).run(...p); } catch (e) { console.error(`cleanup ${label}: ${e.message}`); } };
  for (const id of createdAdvanceIds) {
    await del('advance notes', "DELETE FROM notifications WHERE type = 'staff_money_advance' AND (data::jsonb->>'advanceId')::int = ?", id);
    await del('advance audits', "DELETE FROM audit_logs WHERE entity_type = 'salary_advance' AND entity_id = ?", id);
  }
  for (const id of createdMoneyOutIds) {
    await del('shopping notes', "DELETE FROM notifications WHERE type = 'staff_money_shopping' AND (data::jsonb->>'moneyOutId')::int = ?", id);
    await del('shopping audits', "DELETE FROM audit_logs WHERE entity_type = 'staff_money_out' AND entity_id = ?", id);
    await del('shopping bill audits', "DELETE FROM audit_logs WHERE entity_type = 'expense' AND entity_id IN (SELECT id FROM expenses WHERE money_out_id = ?)", id);
    await del('shopping bills', 'DELETE FROM expenses WHERE money_out_id = ?', id);
    await del('owes of ' + id, 'DELETE FROM shop_owes WHERE money_out_id = ?', id);
    await del('money out ' + id, 'DELETE FROM staff_money_out WHERE id = ?', id);
  }
  try { await closeOwnRegister(); } catch (e) { console.error('cleanup close: ' + e.message); }
  for (const id of createdUserIds) {
    await del('salary payments', 'DELETE FROM salary_payments WHERE user_id = ?', id);
    await del('salary config', 'DELETE FROM employee_salaries WHERE user_id = ?', id);
    await del('advances', 'DELETE FROM salary_advances WHERE user_id = ?', id);
    await del('expense audits', "DELETE FROM audit_logs WHERE entity_type = 'expense' AND entity_id IN (SELECT id FROM expenses WHERE employee_id = ? OR created_by = ?)", id, id);
    await del('expenses', 'DELETE FROM expenses WHERE employee_id = ? OR created_by = ?', id, id);
    await del('notifications', 'DELETE FROM notifications WHERE user_id = ?', id);
  }
  for (const id of createdRegisterIds) {
    await del('register audits', "DELETE FROM audit_logs WHERE entity_type = 'cash_register' AND entity_id = ?", id);
    await del('register ' + id, 'DELETE FROM cash_registers WHERE id = ?', id);
  }
  for (const id of createdItemIds) {
    await del('item ' + id, "DELETE FROM expense_items WHERE id = ? AND name_key LIKE 'verifysm%' AND NOT EXISTS (SELECT 1 FROM expenses WHERE item_id = ?)", id, id);
  }
  for (const id of createdOwesIds) {
    await del('owes audit ' + id, "DELETE FROM audit_logs WHERE entity_type = 'shop_owes' AND entity_id = ?", id);
  }
  for (const id of createdUserIds) {
    await del('owes audits', "DELETE FROM audit_logs WHERE entity_type = 'shop_owes' AND entity_id IN (SELECT id FROM shop_owes WHERE user_id = ?)", id);
    await del('owes', 'DELETE FROM shop_owes WHERE user_id = ?', id);
    await del('money out', 'DELETE FROM staff_money_out WHERE user_id = ?', id);
    await del('advances', 'DELETE FROM salary_advances WHERE user_id = ?', id);
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
