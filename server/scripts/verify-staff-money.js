#!/usr/bin/env node
/**
 * Verification of staff money (PR B). B1: schema, settings, helper module.
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

async function cleanup() {
  const db = await getDb();
  const del = async (label, sql, ...p) => { try { await db.prepare(sql).run(...p); } catch (e) { console.error(`cleanup ${label}: ${e.message}`); } };
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
  let pass = 0, fail = 0;
  try {
    for (const { name, fn } of checks) {
      try { await fn(); console.log(`PASS ${name}`); pass++; }
      catch (err) { console.log(`FAIL ${name}\n   ${err.message}`); fail++; }
    }
  } finally { await cleanup(); }
  console.log(`\n${pass}/${pass + fail} checks passed`);
  process.exit(fail > 0 ? 1 : 0);
}
main();
