#!/usr/bin/env node
/**
 * Verification of staff money (PR B). B1: schema, settings, helper module.
 * B2: salary advance at the counter (live API on API_BASE_URL).
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
    'idx_expenses_money_out', 'idx_expenses_paid_by_user']) assert(have.includes(i), 'missing index ' + i);
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
  assert(m2.startsWith('Ramesh has had ₹2,000 in advances this month'), m2);
  eq(sm.needsPinMessage('self', {}), 'A manager or owner needs to confirm money for yourself.', 'self');
});

// ══ B2: salary advance at the counter (spec 5.1-5.3, 5.9, 5.10) ══
const jwt = require('jsonwebtoken');
const { todayStr } = require('../utils/time');
const API_BASE = process.env.API_BASE_URL || 'http://localhost:3001/api';
const createdRegisterIds = [];
const createdAdvanceIds = [];
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
  for (const id of [c.mgrNoPin, c.mgrFar, c.counter].filter(Boolean)) assert(!aid.includes(id), 'should not list approver ' + id);
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
  const { advance_id, expense_id, unpaid_after } = r.body.data;
  eq(unpaid_after, 300, 'unpaid_after');
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
  eq(r.body.message, `VerifySM has had ₹${c.limits.advanceMonth.toLocaleString('en-IN')} in advances this month — the monthly limit. A manager or owner can confirm with their PIN.`, 'copy');
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

async function cleanup() {
  const db = await getDb();
  const del = async (label, sql, ...p) => { try { await db.prepare(sql).run(...p); } catch (e) { console.error(`cleanup ${label}: ${e.message}`); } };
  for (const id of createdAdvanceIds) {
    await del('advance notes', "DELETE FROM notifications WHERE type = 'staff_money_advance' AND (data::jsonb->>'advanceId')::int = ?", id);
    await del('advance audits', "DELETE FROM audit_logs WHERE entity_type = 'salary_advance' AND entity_id = ?", id);
  }
  try { await closeOwnRegister(); } catch (e) { console.error('cleanup close: ' + e.message); }
  for (const id of createdUserIds) {
    await del('advances', 'DELETE FROM salary_advances WHERE user_id = ?', id);
    await del('expense audits', "DELETE FROM audit_logs WHERE entity_type = 'expense' AND entity_id IN (SELECT id FROM expenses WHERE employee_id = ? OR created_by = ?)", id, id);
    await del('expenses', 'DELETE FROM expenses WHERE employee_id = ? OR created_by = ?', id, id);
    await del('notifications', 'DELETE FROM notifications WHERE user_id = ?', id);
  }
  for (const id of createdRegisterIds) {
    await del('register audits', "DELETE FROM audit_logs WHERE entity_type = 'cash_register' AND entity_id = ?", id);
    await del('register ' + id, 'DELETE FROM cash_registers WHERE id = ?', id);
  }
  for (const id of createdUserIds) {
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
