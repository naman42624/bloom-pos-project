#!/usr/bin/env node
/**
 * Live verification of the attendance/shift/overtime/payroll redesign.
 * Modeled on verify-register-expenses.js's harness. Extend this file the
 * same way — append checks, never remove another check's coverage.
 *
 * Usage (from server/): VERIFY_OWNER_PHONE=... VERIFY_OWNER_PASSWORD=... node scripts/verify-attendance-payroll.js
 */
require('dotenv').config();
const { getDb } = require('../config/database-async');

// Pre-warm the SYNC db layer (server/config/database.js, used internally by
// isLateArrival) before any check runs. Its getDb() spawns a `psql`
// subprocess on first call and was observed to take ~6s to connect —
// blocking this script's single event loop for that whole span. Hit mid-run
// (as it would be the first time a later check calls isLateArrival), that
// block outlasts Node's default 5s HTTP keep-alive timeout and gets an
// in-flight fetch's pooled connection ECONNRESET by the dev server. Paying
// this cost once, up front, before any fetch keep-alive socket even exists,
// avoids the race entirely; every later call is ~15ms.
require('../config/database').getDb();

const API_BASE = process.env.API_BASE_URL || 'http://localhost:3001/api';
const TEST_LOCATION_ID = 4; // "Test Loc"

const checks = [];
const createdUserIds = [];
const createdShiftIds = [];
const createdAttendanceIds = [];
const createdSalaryIds = []; // real salary_payments.id values ONLY — see cleanup()
const createdAdvanceIds = [];
const createdExpenseIds = [];
const createdOutdoorDutyIds = [];

function check(name, fn) { checks.push({ name, fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

function assertLocalTarget() {
  const isLocalUrl = (url) => {
    try { const { hostname } = new URL(url); return hostname === 'localhost' || hostname === '127.0.0.1'; }
    catch { return false; }
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
  if (!phone || !password) throw new Error('VERIFY_OWNER_PHONE and VERIFY_OWNER_PASSWORD must both be set — no default credentials are used.');
  const { status, body } = await api('POST', '/auth/login', null, { phone, password });
  if (status !== 200 || !body?.data?.token) throw new Error(`Owner login failed: ${status} ${JSON.stringify(body)}`);
  return { token: body.data.token, id: body.data.user.id, role: body.data.user.role };
}

// POST /users responds with { data: { user, locations } } — the created
// user is nested under data.user, not data itself (verified against the
// real route in server/routes/users.js, not assumed — an earlier draft of
// this harness got this wrong and would have broken every check below it).
async function createStaffSession(ownerToken, role, name) {
  const phone = `9${Date.now().toString().slice(-9)}`;
  const { status, body } = await api('POST', '/users', ownerToken, {
    name, phone, password: 'verifypass123',
    role, location_ids: [TEST_LOCATION_ID],
  });
  assert(status === 201, `Could not create ${role} test user: ${status} ${JSON.stringify(body)}`);
  const userId = body.data.user.id;
  createdUserIds.push(userId);
  const login = await api('POST', '/auth/login', null, { phone, password: 'verifypass123' });
  assert(login.status === 200, `${role} test user login failed: ${login.status} ${JSON.stringify(login.body)}`);
  return { token: login.body.data.token, id: userId };
}

async function createFloristStaffSession(ownerToken) {
  return createStaffSession(ownerToken, 'florist_staff', 'Verify Florist');
}

// Same shape, different role — the negative-authorization checks below need
// a role that is NOT florist_staff to prove a gate scopes by role rather
// than just "not the owner."
async function createCounterStaffSession(ownerToken) {
  return createStaffSession(ownerToken, 'counter_staff', 'Verify Counter');
}

module.exports = {
  check, checks, api, assert, loginOwner, createFloristStaffSession, createCounterStaffSession,
  TEST_LOCATION_ID, getDb,
  createdUserIds, createdShiftIds, createdAttendanceIds, createdSalaryIds, createdAdvanceIds, createdExpenseIds,
  createdOutdoorDutyIds,
};

// ═══════════════════════════════════════════════════════════════
// florist_staff role-gap fixes
// ═══════════════════════════════════════════════════════════════

check('GET /attendance/today no longer 403s for florist_staff', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const { status } = await api('GET', '/attendance/today', florist.token);
  assert(status === 200, `Expected 200, got ${status}`);
});

check('GET /attendance/salary-advances no longer 403s for florist_staff, and only returns their own', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const { status, body } = await api('GET', '/attendance/salary-advances', florist.token);
  assert(status === 200, `Expected 200, got ${status}`);
  assert(Array.isArray(body.data), 'Expected an array');
  assert(body.data.every((a) => a.user_id === florist.id), 'Expected only the florist\'s own advances');
});

check('GET /attendance/outdoor-duty no longer 403s for florist_staff, and only returns their own', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const { status, body } = await api('GET', '/attendance/outdoor-duty', florist.token);
  assert(status === 200, `Expected 200, got ${status}`);
  assert(body.data.every((r) => r.user_id === florist.id), 'Expected only the florist\'s own requests');
});

check('POST /staff/geofence-event no longer 403s for florist_staff', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const { status } = await api('POST', '/staff/geofence-event', florist.token, {
    location_id: TEST_LOCATION_ID, event_type: 'exit', latitude: 31.31, longitude: 75.57,
  });
  assert(status === 200, `Expected 200, got ${status}`);
});

check('GET /staff/shifts no longer 403s for florist_staff, and only returns their own', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const { status, body } = await api('GET', '/staff/shifts', florist.token);
  assert(status === 200, `Expected 200, got ${status}`);
  assert(body.data.every((s) => s.user_id === florist.id), 'Expected only the florist\'s own shift');
});

check('GET /staff/salaries no longer 403s for florist_staff', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const { status } = await api('GET', '/staff/salaries', florist.token);
  assert(status === 200, `Expected 200, got ${status}`);
});

check('GET /staff/payroll/history no longer 403s for florist_staff', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const { status } = await api('GET', '/staff/payroll/history', florist.token);
  assert(status === 200, `Expected 200, got ${status}`);
});

check('GET /staff/salaries (owner view) includes a florist_staff in salaries or unset', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const { status, body } = await api('GET', '/staff/salaries', owner.token);
  assert(status === 200, `Expected 200, got ${status}`);
  const inSalaries = (body.data.salaries || []).some((s) => s.user_id === florist.id);
  const inUnset = (body.data.unset || []).some((u) => u.id === florist.id);
  assert(inSalaries || inUnset, 'Expected the new florist_staff to appear in either salaries or unset — they were previously invisible to this query entirely');
});

// ═══════════════════════════════════════════════════════════════
// Split-shift late detection (bug #3) — via the corrected shift-work.js
// ═══════════════════════════════════════════════════════════════

check('isLateArrival correctly flags a split-shift employee\'s SECOND-segment clock-in against ITS OWN segment (bug #3)', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const { isLateArrival } = require('../routes/attendance');
  const db = await getDb();

  const shiftResult = await db.prepare(`
    INSERT INTO employee_shifts (user_id, location_id, shift_start, shift_end, shift_segments, is_active, created_by)
    VALUES (?, ?, '09:00', '18:00', ?, 1, ?) RETURNING id
  `).get(florist.id, TEST_LOCATION_ID, JSON.stringify([{ start: '07:00', end: '12:00' }, { start: '18:00', end: '22:00' }]), owner.id);
  createdShiftIds.push(shiftResult.id);

  const today = new Date().toISOString().slice(0, 10);
  // On time for the second segment — must NOT be flagged late against the
  // first segment's 07:00 start (the original bug).
  const onTimeSecondSegment = isLateArrival(`${today}T18:00:00+05:30`, null, florist.id, TEST_LOCATION_ID);
  assert(onTimeSecondSegment === false, `Expected NOT late (exactly on time for segment 2), got late=${onTimeSecondSegment}`);

  // Genuinely 5 min late for the second segment — must correctly flag late
  // against THAT segment (18:00), not read as early against the first.
  const trulyLateSecondSegment = isLateArrival(`${today}T18:05:00+05:30`, null, florist.id, TEST_LOCATION_ID);
  assert(trulyLateSecondSegment === true, `Expected late (5 min after 18:00 segment start), got late=${trulyLateSecondSegment}`);
});

check('isLateArrival does not silently cap lateness at half the gap between segments (the old nearest-start bug)', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const { isLateArrival } = require('../routes/attendance');
  const db = await getDb();

  const shiftResult = await db.prepare(`
    INSERT INTO employee_shifts (user_id, location_id, shift_start, shift_end, shift_segments, is_active, created_by)
    VALUES (?, ?, '09:00', '18:00', ?, 1, ?) RETURNING id
  `).get(florist.id, TEST_LOCATION_ID, JSON.stringify([{ start: '09:00', end: '10:00' }, { start: '11:00', end: '18:00' }, { start: '20:00', end: '22:30' }]), owner.id);
  createdShiftIds.push(shiftResult.id);

  const today = new Date().toISOString().slice(0, 10);
  // 61 minutes late for the 09:00-10:00 segment — the old "nearest start"
  // heuristic would match this to the 11:00 segment instead (only 59 min
  // away vs 61) and read it as "early," hiding real lateness.
  const late = isLateArrival(`${today}T10:01:00+05:30`, null, florist.id, TEST_LOCATION_ID);
  assert(late === true, `Expected late (61 min past the 09:00 segment start), got late=${late}`);
});

check('POST /staff/shifts rejects a midnight-crossing segment with a plain-language message', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const { status, body } = await api('POST', '/staff/shifts', owner.token, {
    user_id: florist.id, location_id: TEST_LOCATION_ID,
    shift_start: '09:00', shift_end: '18:00',
    shift_segments: [{ start: '22:00', end: '02:00' }],
  });
  assert(status === 400, `Expected 400 for a midnight-crossing segment, got ${status}`);
  assert(!/error|exception|undefined/i.test(body.message || ''), `Error message should be plain-language, got: ${body.message}`);
});

check('GET /attendance/today includes lateMinutesToday and overtimeMinutesToday', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const { status, body } = await api('GET', '/attendance/today', florist.token);
  assert(status === 200, `Expected 200, got ${status}`);
  assert(typeof body.data.lateMinutesToday === 'number', 'Expected lateMinutesToday to be a number');
  assert(typeof body.data.overtimeMinutesToday === 'number', 'Expected overtimeMinutesToday to be a number');
});

check('GET /attendance/staff-today includes overtime_minutes_today per staff member', async () => {
  const owner = await loginOwner();
  const { status, body } = await api('GET', `/attendance/staff-today?location_id=${TEST_LOCATION_ID}`, owner.token);
  assert(status === 200, `Expected 200, got ${status}`);
  assert(Array.isArray(body.data.present), 'Expected data.present to be an array');
  for (const s of body.data.present) {
    assert(typeof s.overtime_minutes_today === 'number', `Expected overtime_minutes_today on ${s.user_name}`);
    assert(typeof s.late_minutes_today === 'number', `Expected late_minutes_today on ${s.user_name}`);
  }
});

// Fix Round 1 (Task 21 live-trace finding): overtime must show up WHILE
// someone is still clocked in, not only after they clock out — reproduces
// the exact Scenario 1 failure. Uses a fixed 09:00-18:00 shift + clock_in
// backdated exactly 24 hours (always exactly 1 Asia/Kolkata calendar date
// earlier, no DST to worry about), same reasoning as the corresponding
// verify-shift-work.js unit assertion, so this is robust regardless of
// what time of day the suite actually runs.
check('GET /attendance/today and GET /attendance/staff-today show LIVE overtime for a still-clocked-in session past shift-end+grace', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const db = await getDb();

  const shiftResult = await db.prepare(`
    INSERT INTO employee_shifts (user_id, location_id, shift_start, shift_end, is_active, created_by)
    VALUES (?, ?, '09:00', '18:00', 1, ?) RETURNING id
  `).get(florist.id, TEST_LOCATION_ID, owner.id);
  createdShiftIds.push(shiftResult.id);

  const clockIn = await api('POST', '/attendance/clock-in', florist.token, { location_id: TEST_LOCATION_ID, method: 'manual' });
  assert(clockIn.status === 201, `Could not clock in: ${clockIn.status} ${JSON.stringify(clockIn.body)}`);
  const attendanceId = clockIn.body.data.id;
  createdAttendanceIds.push(attendanceId);
  await db.prepare("UPDATE attendance SET clock_in = clock_in - INTERVAL '24 hours' WHERE id = ?").run(attendanceId);

  // Still clocked in (no clock-out anywhere in this check) — this is the
  // live/in-progress case, not the after-the-fact one.
  const today = await api('GET', '/attendance/today', florist.token);
  assert(today.status === 200, `Expected 200, got ${today.status}`);
  assert(today.body.data.overtimeMinutesToday > 0, `Expected overtimeMinutesToday > 0 for a session 24h past a 09:00-18:00 shift while still clocked in, got ${today.body.data.overtimeMinutesToday}`);

  const staffToday = await api('GET', `/attendance/staff-today?location_id=${TEST_LOCATION_ID}`, owner.token);
  assert(staffToday.status === 200, `Expected 200, got ${staffToday.status}`);
  const row = staffToday.body.data.present.find((s) => s.user_id === florist.id);
  assert(row, 'Expected the florist to appear in the present list');
  assert(row.active_session === true, 'Expected active_session true — this check is specifically about a STILL-OPEN session');
  assert(row.overtime_minutes_today > 0, `Expected overtime_minutes_today > 0 on the manager roster row, got ${row.overtime_minutes_today}`);
});

check('GET /attendance/staff-today does not list a multi-location staff member more than once in "absent"', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  // Assign a second location so this user has 2 assignments.
  const db = await getDb();
  const otherLocation = (await db.prepare('SELECT id FROM locations WHERE id != ? AND is_active = 1 LIMIT 1').get(TEST_LOCATION_ID));
  if (otherLocation) {
    await db.prepare('INSERT INTO user_locations (user_id, location_id, is_primary) VALUES (?, ?, 0) ON CONFLICT DO NOTHING').run(florist.id, otherLocation.id);
  }
  const { status, body } = await api('GET', '/attendance/staff-today', owner.token); // no location_id — "All Locations"
  assert(status === 200, `Expected 200, got ${status}`);
  const occurrences = body.data.absent.filter((a) => a.id === florist.id).length;
  assert(occurrences <= 1, `Expected the multi-location florist to appear at most once in absent, got ${occurrences}`);
});

check('POST /staff/payroll/calculate includes total_late_minutes and overtime_minutes, and neither affects net_amount', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  await api('POST', '/staff/salaries', owner.token, { user_id: florist.id, monthly_salary: 15000, salary_type: 'monthly' });
  const period_start = '2026-01-01';
  const period_end = '2026-01-31';
  const { status, body } = await api('POST', '/staff/payroll/calculate', owner.token, { user_id: florist.id, period_start, period_end });
  assert(status === 200, `Expected 200, got ${status}`);
  assert(typeof body.data.attendance_summary.total_late_minutes === 'number', 'Expected total_late_minutes to be a number');
  assert(typeof body.data.attendance_summary.overtime_minutes === 'number', 'Expected overtime_minutes to be a number');
  // Zero attendance over the full period → absentDays=31 → deductions
  // (15000/30 × 31 = 15500) exceed base_pay (15000) → net_amount clamps to
  // 0. This is the real, correct output of today's existing calculation
  // logic (untouched by this task) — asserting it directly rather than a
  // guessed number confirms OT/late are additive-only and don't perturb it.
  const expectedNet = Math.max(0, body.data.calculation.base_pay - body.data.calculation.deductions);
  assert(body.data.calculation.net_amount === expectedNet, `Expected net_amount to equal base_pay - deductions (clamped at 0) = ${expectedNet}, got ${body.data.calculation.net_amount}`);
});

check('POST /staff/payroll/disburse (cash) requires an open register, writes a linked expense, adjusts expected_cash, and caps advances_deducted at what the payment can absorb', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  await api('POST', '/staff/salaries', owner.token, { user_id: florist.id, monthly_salary: 12000, salary_type: 'monthly' });

  const blocked = await api('POST', '/staff/payroll/disburse', owner.token, {
    user_id: florist.id, period_start: '2026-02-01', period_end: '2026-02-28', net_amount: 12000, payment_method: 'cash',
  });
  assert(blocked.status === 400, `Expected 400 with no open register, got ${blocked.status}`);

  const initialStatus = await api('GET', `/sales/register/status?location_id=${TEST_LOCATION_ID}`, owner.token);
  if (initialStatus.body?.isOpen) {
    await api('PUT', '/sales/register/close', owner.token, { location_id: TEST_LOCATION_ID, actual_cash: Number(initialStatus.body.data.expected_cash) || 0 });
  }
  await api('POST', '/sales/register/open', owner.token, { location_id: TEST_LOCATION_ID, opening_balance: 1000 });
  const before = await api('GET', `/sales/register/status?location_id=${TEST_LOCATION_ID}`, owner.token);
  const expectedBefore = Number(before.body.data.expected_cash);

  // advances_deducted (5000) exceeds the whole payable amount (base_salary
  // 3000, no deductions, no bonus) — must be capped to 3000, not repay the
  // full 5000 against real money that was never paid. base_salary is sent
  // explicitly because the cap's basis is the GROSS payable, not net_amount
  // (which arrives with the advance already subtracted); see the route's
  // own comment and the C1 check below.
  const { status, body } = await api('POST', '/staff/payroll/disburse', owner.token, {
    user_id: florist.id, period_start: '2026-02-01', period_end: '2026-02-28',
    base_salary: 3000, deductions: 0, bonus: 0,
    net_amount: 3000, advances_deducted: 5000, payment_method: 'cash',
  });
  assert(status === 201, `Expected 201, got ${status}: ${JSON.stringify(body)}`);
  assert(body.data.advances_deducted === 3000, `Expected advances_deducted capped to 3000, got ${body.data.advances_deducted}`);
  assert(body.data.expense_id != null, 'Expected salary_payments.expense_id to be set');
  createdSalaryIds.push(body.data.id);
  createdExpenseIds.push(body.data.expense_id);

  const db = await getDb();
  const expense = await db.prepare('SELECT * FROM expenses WHERE id = ?').get(body.data.expense_id);
  assert(expense.category === 'salary', `Expected category 'salary', got '${expense.category}'`);
  assert(Number(expense.employee_id) === florist.id, `Expected employee_id ${florist.id}, got ${expense.employee_id}`);

  const after = await api('GET', `/sales/register/status?location_id=${TEST_LOCATION_ID}`, owner.token);
  const expectedAfter = Number(after.body.data.expected_cash);
  assert(Math.abs((expectedBefore - 3000) - expectedAfter) < 0.01, `Expected register to drop by 3000, went from ${expectedBefore} to ${expectedAfter}`);

  // expectedAfter can legitimately be negative here (opening_balance 1000 <
  // net_amount 3000 disbursed) — a real discrepancy to reconcile, not a bug.
  // The close route's own validator rejects a negative actual_cash (can't
  // have negative physical cash in a drawer), so clamp at 0 for this cleanup
  // close — otherwise the call 400s silently and leaves the register open.
  await api('PUT', '/sales/register/close', owner.token, { location_id: TEST_LOCATION_ID, actual_cash: Math.max(0, expectedAfter) });
});

// C1 (final whole-branch review): the NEIGHBOURING case to the check above.
// There, advances_deducted (5000) exceeded the whole salary, so both the
// wrong cap basis (net_amount) and the right one (gross payable) happen to
// produce the same capped figure — it cannot tell them apart. Here the
// advance sits strictly BETWEEN net_amount and base_salary
// (4000 < 6000 < 10000), which is the ordinary case whenever an outstanding
// advance exceeds half a salary: capping at net_amount would record only
// 4000 as repaid while 6000 of real cash was withheld, leaving 2000 still
// 'approved' to be deducted a SECOND time next period.
check('POST /staff/payroll/disburse records the FULL advance repayment when net_amount < advances_deducted < base_salary (C1)', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const db = await getDb();
  await api('POST', '/staff/salaries', owner.token, { user_id: florist.id, monthly_salary: 10000, salary_type: 'monthly' });

  // A real outstanding advance, so the repayment ALLOCATION is exercised
  // too, not just the figure stored on salary_payments. Created through the
  // real route, then moved to 'approved' directly — the approve route needs
  // an open cash register, which is a different check's subject.
  const advReq = await api('POST', '/attendance/salary-advance', florist.token, { amount: 6000, reason: 'C1 cap-basis fixture' });
  assert(advReq.status === 201, `Could not request advance: ${advReq.status} ${JSON.stringify(advReq.body)}`);
  const advanceId = advReq.body.data.id;
  createdAdvanceIds.push(advanceId);
  await db.prepare("UPDATE salary_advances SET status = 'approved', repaid_amount = 0 WHERE id = ?").run(advanceId);

  // Payable 10000 (base 10000, no deductions, no bonus); 6000 withheld
  // against the advance; 4000 actually handed over. Bank transfer so no
  // register setup is involved — the cap arithmetic is the subject here.
  const { status, body } = await api('POST', '/staff/payroll/disburse', owner.token, {
    user_id: florist.id, period_start: '2026-04-01', period_end: '2026-04-30',
    base_salary: 10000, deductions: 0, bonus: 0,
    net_amount: 4000, advances_deducted: 6000, payment_method: 'bank_transfer',
  });
  assert(status === 201, `Expected 201, got ${status}: ${JSON.stringify(body)}`);
  createdSalaryIds.push(body.data.id);
  if (body.data.expense_id) createdExpenseIds.push(body.data.expense_id);

  assert(Number(body.data.advances_deducted) === 6000,
    `Expected the full 6000 withheld to be recorded as repaid, got ${body.data.advances_deducted} (4000 means the cap is still using net_amount, which already has the advance subtracted)`);

  const advance = await db.prepare('SELECT * FROM salary_advances WHERE id = ?').get(advanceId);
  assert(Number(advance.repaid_amount) === 6000, `Expected the advance to be credited the full 6000, got ${advance.repaid_amount}`);
  assert(advance.status === 'repaid', `Expected the fully-repaid advance to move to 'repaid', got '${advance.status}'`);
});

check('POST /staff/payroll/disburse (bank transfer) does not require an open register', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  await api('POST', '/staff/salaries', owner.token, { user_id: florist.id, monthly_salary: 9000, salary_type: 'monthly' });
  const { status, body } = await api('POST', '/staff/payroll/disburse', owner.token, {
    user_id: florist.id, period_start: '2026-03-01', period_end: '2026-03-31', net_amount: 9000, payment_method: 'bank_transfer',
  });
  assert(status === 201, `Expected 201 (no register requirement for a transfer), got ${status}: ${JSON.stringify(body)}`);
  createdSalaryIds.push(body.data.id);
  if (body.data.expense_id) createdExpenseIds.push(body.data.expense_id);
});

check('PUT /attendance/salary-advance/:id/approve requires an open register and writes a linked expense', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const requestRes = await api('POST', '/attendance/salary-advance', florist.token, { amount: 2000, reason: 'Verify harness test' });
  assert(requestRes.status === 201, `Could not request advance: ${requestRes.status}`);
  createdAdvanceIds.push(requestRes.body.data.id);

  const blocked = await api('PUT', `/attendance/salary-advance/${requestRes.body.data.id}/approve`, owner.token);
  assert(blocked.status === 400, `Expected 400 with no open register, got ${blocked.status}`);

  const initialStatus = await api('GET', `/sales/register/status?location_id=${TEST_LOCATION_ID}`, owner.token);
  if (initialStatus.body?.isOpen) {
    await api('PUT', '/sales/register/close', owner.token, { location_id: TEST_LOCATION_ID, actual_cash: Number(initialStatus.body.data.expected_cash) || 0 });
  }
  await api('POST', '/sales/register/open', owner.token, { location_id: TEST_LOCATION_ID, opening_balance: 5000 });
  const before = await api('GET', `/sales/register/status?location_id=${TEST_LOCATION_ID}`, owner.token);
  const expectedBefore = Number(before.body.data.expected_cash);

  const { status, body } = await api('PUT', `/attendance/salary-advance/${requestRes.body.data.id}/approve`, owner.token);
  assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert(body.data.status === 'approved', `Expected status 'approved', got '${body.data.status}'`);

  const db = await getDb();
  const expense = await db.prepare('SELECT * FROM expenses WHERE employee_id = ? AND category = ? ORDER BY id DESC LIMIT 1').get(florist.id, 'salary');
  assert(expense, 'Expected a linked expense row to exist');
  assert(Number(expense.amount) === 2000, `Expected expense amount 2000, got ${expense.amount}`);
  createdExpenseIds.push(expense.id);

  const after = await api('GET', `/sales/register/status?location_id=${TEST_LOCATION_ID}`, owner.token);
  const expectedAfter = Number(after.body.data.expected_cash);
  assert(Math.abs((expectedBefore - 2000) - expectedAfter) < 0.01, `Expected register to drop by 2000, went from ${expectedBefore} to ${expectedAfter}`);

  // opening_balance (5000) comfortably covers the 2000 advance, so
  // expectedAfter stays positive here — unlike Task 9's disburse check,
  // no Math.max(0, ...) clamp is needed for this cleanup close. Kept
  // anyway as cheap insurance against a future edit to the amounts above.
  await api('PUT', '/sales/register/close', owner.token, { location_id: TEST_LOCATION_ID, actual_cash: Math.max(0, expectedAfter) });
});

// ═══════════════════════════════════════════════════════════════
// Geofence auto-clock-in — server-side proximity check + attendance_id
// ═══════════════════════════════════════════════════════════════

check('POST /staff/geofence-event (enter) rejects an out-of-range claim rather than trusting it', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const { status, body } = await api('POST', '/staff/geofence-event', florist.token, {
    location_id: TEST_LOCATION_ID, event_type: 'enter', latitude: 12.9716, longitude: 77.5946, // Bangalore, nowhere near the shop
  });
  assert(status === 200, `Expected 200 (a rejected claim, not an error), got ${status}`);
  // Test Loc currently has NULL lat/long, so the route's coordinate-presence
  // check short-circuits to 'unverified' before the distance comparison
  // (haversineMeters) ever runs — that's a real, different branch from
  // 'out_of_range', not the same outcome by a different name. Distinguish
  // them explicitly rather than accepting either silently, so this check is
  // honest about which branch it actually exercised.
  if (body.action === 'unverified') {
    console.log('   (partial coverage — Test Loc has no coordinates yet, so this only confirms the coordinate-presence guard rejects auto-clock-in; the distance-comparison branch itself remains unexercised until real coordinates are set)');
  } else {
    assert(body.action === 'out_of_range', `Expected action 'out_of_range' once real coordinates exist, got '${body.action}'`);
  }
  assert(body.action !== 'auto_clock_in', `Expected the out-of-range claim to NOT trigger auto clock-in, got action='${body.action}'`);
});

check('POST /staff/geofence-event (enter, in range) auto clocks in, returns attendance_id explicitly, and creates a notification', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const db = await getDb();
  const location = await db.prepare('SELECT latitude, longitude FROM locations WHERE id = ?').get(TEST_LOCATION_ID);
  if (!location?.latitude) {
    console.log('   (skipped — Test Loc has no coordinates yet; this check needs Task 2\'s precision fix plus real coordinates entered)');
    return;
  }
  const { status, body } = await api('POST', '/staff/geofence-event', florist.token, {
    location_id: TEST_LOCATION_ID, event_type: 'enter', latitude: Number(location.latitude), longitude: Number(location.longitude),
  });
  assert(status === 200, `Expected 200, got ${status}`);
  assert(body.action === 'auto_clock_in', `Expected action 'auto_clock_in', got '${body.action}'`);
  assert(typeof body.attendance_id === 'number', 'Expected an explicit attendance_id, distinct from data.id (the geofence_events row)');
  createdAttendanceIds.push(body.attendance_id);

  const { body: today } = await api('GET', '/attendance/today', florist.token);
  assert(today.data.attendance?.id === body.attendance_id, 'Expected the returned attendance_id to match the actual open session');

  const { body: notifs } = await api('GET', '/notifications', florist.token);
  const found = notifs.data.notifications.find((n) => n.type === 'attendance_auto_clockin');
  assert(found, 'Expected a notification of type attendance_auto_clockin');
});

check('POST /attendance/:id/undo-auto-clockin deletes an open auto-geofence session within the window', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const db = await getDb();
  const location = await db.prepare('SELECT latitude, longitude FROM locations WHERE id = ?').get(TEST_LOCATION_ID);
  if (!location?.latitude) { console.log('   (skipped — Test Loc has no coordinates)'); return; }
  const geo = await api('POST', '/staff/geofence-event', florist.token, {
    location_id: TEST_LOCATION_ID, event_type: 'enter', latitude: Number(location.latitude), longitude: Number(location.longitude),
  });
  assert(geo.body.action === 'auto_clock_in', `Setup failed — expected auto_clock_in, got '${geo.body.action}'`);

  const { status, body } = await api('POST', `/attendance/${geo.body.attendance_id}/undo-auto-clockin`, florist.token);
  assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);

  const { body: today } = await api('GET', '/attendance/today', florist.token);
  assert(today.data.attendance === null, 'Expected no active attendance record after undo');
});

check('POST /attendance/:id/undo-auto-clockin refuses past the 15-minute window', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const db = await getDb();
  const location = await db.prepare('SELECT latitude, longitude FROM locations WHERE id = ?').get(TEST_LOCATION_ID);
  if (!location?.latitude) { console.log('   (skipped — Test Loc has no coordinates)'); return; }
  const geo = await api('POST', '/staff/geofence-event', florist.token, {
    location_id: TEST_LOCATION_ID, event_type: 'enter', latitude: Number(location.latitude), longitude: Number(location.longitude),
  });
  createdAttendanceIds.push(geo.body.attendance_id);
  // Backdate the clock-in 20 minutes, simulating time having passed —
  // same technique verify-register-expenses.js's own backdateToYesterday
  // uses.
  await db.prepare("UPDATE attendance SET clock_in = clock_in - INTERVAL '20 minutes' WHERE id = ?").run(geo.body.attendance_id);

  const { status } = await api('POST', `/attendance/${geo.body.attendance_id}/undo-auto-clockin`, florist.token);
  assert(status === 400, `Expected 400 past the 15-minute window, got ${status}`);

  await api('POST', '/attendance/clock-out', florist.token, { method: 'manual' });
});

check('POST /attendance/:id/undo-auto-clockin refuses a manual clock-in', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const manual = await api('POST', '/attendance/clock-in', florist.token, { location_id: TEST_LOCATION_ID, method: 'manual' });
  createdAttendanceIds.push(manual.body.data.id);

  const { status } = await api('POST', `/attendance/${manual.body.data.id}/undo-auto-clockin`, florist.token);
  assert(status === 400, `Expected 400 for a manual (non-auto) clock-in, got ${status}`);

  await api('POST', '/attendance/clock-out', florist.token, { method: 'manual' });
});

check('POST /attendance/missed-clock-in notifies owner/manager and deduplicates within the same day', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);

  const first = await api('POST', '/attendance/missed-clock-in', florist.token, { location_id: TEST_LOCATION_ID });
  assert(first.status === 200, `Expected 200, got ${first.status}`);
  assert(!first.body.already_sent, 'Expected the first call to actually send');

  const { body: notifs } = await api('GET', '/notifications', owner.token);
  const matching = notifs.data.notifications.filter((n) => n.type === 'attendance_missed_clockin' && n.body.includes('Verify Florist'));
  assert(matching.length === 1, `Expected exactly 1 notification, got ${matching.length}`);

  const second = await api('POST', '/attendance/missed-clock-in', florist.token, { location_id: TEST_LOCATION_ID });
  assert(second.status === 200, `Expected 200, got ${second.status}`);
  assert(second.body.already_sent === true, 'Expected the second same-day call to be deduplicated');

  const { body: notifsAfter } = await api('GET', '/notifications', owner.token);
  const matchingAfter = notifsAfter.data.notifications.filter((n) => n.type === 'attendance_missed_clockin' && n.body.includes('Verify Florist'));
  assert(matchingAfter.length === 1, `Expected still exactly 1 notification after the deduplicated second call, got ${matchingAfter.length}`);
});

check('POST /attendance/missed-clock-in dedup compares the SHOP-LOCAL calendar day, not a raw UTC date cast (Fix Round 2)', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const db = await getDb();
  const { todayStr, parseServerDate } = require('../utils/time');

  const first = await api('POST', '/attendance/missed-clock-in', florist.token, { location_id: TEST_LOCATION_ID });
  assert(first.status === 200, `Expected 200, got ${first.status}`);
  assert(!first.body.already_sent, 'Expected the first call to actually send');

  const notifRow = await db.prepare(
    "SELECT id FROM notifications WHERE type = 'attendance_missed_clockin' AND (data::jsonb->>'userId')::int = ? ORDER BY id DESC LIMIT 1"
  ).get(florist.id);
  assert(notifRow, 'Expected to find the notification the first call just created');

  // Backdate created_at to a naive-UTC string whose LITERAL calendar date
  // is YESTERDAY but whose real shop-local (Asia/Kolkata) calendar date is
  // TODAY — the exact IST 00:00-05:30 window a raw `created_at::date = ?`
  // SQL cast got wrong (this codebase stores created_at as naive UTC wall
  // clock; see shift-work.js's own comments on why parseServerDate exists
  // at all). Built relative to the real today (todayStr()), not a
  // hardcoded date, so this holds regardless of which real day the suite
  // runs on.
  const today = todayStr();
  const yesterday = new Date(new Date(`${today}T00:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10);
  const boundaryCreatedAt = `${yesterday}T20:00:00.000`; // 20:00 UTC = 01:30 IST the NEXT calendar day (= today)
  assert(todayStr(parseServerDate(boundaryCreatedAt)) === today, 'Test setup sanity check: the constructed boundary timestamp must itself resolve to shop-local TODAY');
  await db.prepare('UPDATE notifications SET created_at = ? WHERE id = ?').run(boundaryCreatedAt, notifRow.id);

  const second = await api('POST', '/attendance/missed-clock-in', florist.token, { location_id: TEST_LOCATION_ID });
  assert(second.status === 200, `Expected 200, got ${second.status}`);
  assert(second.body.already_sent === true, `Expected a notification in the IST 00:00-05:30 boundary window to still be recognized as "already sent today" (shop-local), got already_sent=${second.body.already_sent}`);
});

// ═══════════════════════════════════════════════════════════════
// Clock-out recovery sweep — closes attendance sessions left open well
// past their shift (or a flat fallback window with no shift configured),
// with no geofence activity required at all.
// ═══════════════════════════════════════════════════════════════

// Every sweep fixture is created inside the FIRST sweep check below, before
// its single real 65-second cron tick, and the later sweep checks only read
// the results. One tick, one wait, for all of them — the suite runs its
// checks strictly in order, so a fixture created in an earlier check is
// still there (cleanup only runs at the very end).
const sweepFixtures = {};

// Shop-local "yesterday at HH:MM", as the naive-UTC string this codebase
// stores timestamps in. Absolute rather than relative (the existing
// fixtures' `clock_in - INTERVAL 'N hours'` can't express "at a specific
// time of day", which is exactly what the two shift-aware cases below turn
// on), and derived from todayStr() so it holds whenever the suite runs.
function yesterdayAtShopLocal(hhmm) {
  const { todayStr } = require('../utils/time');
  const today = todayStr();
  const yesterday = new Date(new Date(`${today}T00:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10);
  return {
    date: yesterday,
    iso: new Date(`${yesterday}T${hhmm}:00+05:30`).toISOString(),
  };
}

check('Clock-out sweep closes a session open well past the fallback window (no shift configured), but skips one with an active approved outdoor-duty request', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const clockIn = await api('POST', '/attendance/clock-in', florist.token, { location_id: TEST_LOCATION_ID, method: 'manual' });
  const attendanceId = clockIn.body.data.id;
  createdAttendanceIds.push(attendanceId);

  const db = await getDb();
  // Backdate 18 hours — past the 16-hour no-shift fallback window.
  await db.prepare("UPDATE attendance SET clock_in = clock_in - INTERVAL '18 hours' WHERE id = ?").run(attendanceId);

  // Second florist, also backdated the same way, but with an active
  // APPROVED outdoor-duty request — the sweep must skip this one, the
  // same way Part 1 already skips a geofence-exit timeout for it.
  const florist2 = await createFloristStaffSession(owner.token);
  const clockIn2 = await api('POST', '/attendance/clock-in', florist2.token, { location_id: TEST_LOCATION_ID, method: 'manual' });
  const attendanceId2 = clockIn2.body.data.id;
  createdAttendanceIds.push(attendanceId2);
  await db.prepare("UPDATE attendance SET clock_in = clock_in - INTERVAL '18 hours' WHERE id = ?").run(attendanceId2);

  const outdoorRequest = await api('POST', '/attendance/outdoor-duty', florist2.token, {
    reason: 'Verify sweep outdoor-duty guard', location_id: TEST_LOCATION_ID,
  });
  assert(outdoorRequest.status === 201, `Could not create outdoor duty request: ${outdoorRequest.status} ${JSON.stringify(outdoorRequest.body)}`);
  createdOutdoorDutyIds.push(outdoorRequest.body.data.id);
  const approveRequest = await api('PUT', `/attendance/outdoor-duty/${outdoorRequest.body.data.id}/approve`, owner.token);
  assert(approveRequest.status === 200, `Could not approve outdoor duty request: ${approveRequest.status} ${JSON.stringify(approveRequest.body)}`);

  // ── C3 fixture: a clock-in LATER in the day than its own shift ends ──
  // A stale/wrong shift row (09:00-18:00 on someone now working evenings)
  // is entirely plausible — nothing read shift rows at all before this
  // redesign, so none were ever validated against reality. The estimated
  // shift end is anchored to the clock-in's OWN day, so it lands BEFORE the
  // clock-in, and the old code wrote that as the clock_out: a row ending
  // before it started, with total_hours = 0 (real, for hourly staff paid,
  // work silently voided). Asserted in its own check after the tick.
  const florist3 = await createFloristStaffSession(owner.token);
  const shift3 = await db.prepare(`
    INSERT INTO employee_shifts (user_id, location_id, shift_start, shift_end, is_active, created_by)
    VALUES (?, ?, '09:00', '18:00', 1, ?) RETURNING id
  `).get(florist3.id, TEST_LOCATION_ID, owner.id);
  createdShiftIds.push(shift3.id);
  const clockIn3 = await api('POST', '/attendance/clock-in', florist3.token, { location_id: TEST_LOCATION_ID, method: 'manual' });
  assert(clockIn3.status === 201, `Could not clock in C3 fixture: ${clockIn3.status} ${JSON.stringify(clockIn3.body)}`);
  createdAttendanceIds.push(clockIn3.body.data.id);
  // 19:00 shop-local yesterday: an hour past the shift's 18:00 end, and
  // always at least 5 hours ago whatever time the suite runs, so the
  // 4-hour grace measured from the CLOCK-IN has definitely elapsed.
  const lateClockIn = yesterdayAtShopLocal('19:00');
  await db.prepare('UPDATE attendance SET clock_in = ?, date = ? WHERE id = ?')
    .run(lateClockIn.iso, lateClockIn.date, clockIn3.body.data.id);
  sweepFixtures.clockInAfterShiftEndId = clockIn3.body.data.id;

  // ── I1 fixture: a forgotten MID-shift clock-out on a split shift ──
  // Clocks in at the start of the FIRST segment (07:00) and never clocks
  // out. The sweep must estimate against THAT segment's end (12:00 → 5
  // hours), not the day's final segment end (22:00 → 15 hours).
  const florist4 = await createFloristStaffSession(owner.token);
  const shift4 = await db.prepare(`
    INSERT INTO employee_shifts (user_id, location_id, shift_start, shift_end, shift_segments, is_active, created_by)
    VALUES (?, ?, '07:00', '22:00', ?, 1, ?) RETURNING id
  `).get(florist4.id, TEST_LOCATION_ID, JSON.stringify([{ start: '07:00', end: '12:00' }, { start: '18:00', end: '22:00' }]), owner.id);
  createdShiftIds.push(shift4.id);
  const clockIn4 = await api('POST', '/attendance/clock-in', florist4.token, { location_id: TEST_LOCATION_ID, method: 'manual' });
  assert(clockIn4.status === 201, `Could not clock in I1 fixture: ${clockIn4.status} ${JSON.stringify(clockIn4.body)}`);
  createdAttendanceIds.push(clockIn4.body.data.id);
  const splitClockIn = yesterdayAtShopLocal('07:00');
  await db.prepare('UPDATE attendance SET clock_in = ?, date = ? WHERE id = ?')
    .run(splitClockIn.iso, splitClockIn.date, clockIn4.body.data.id);
  sweepFixtures.splitShiftId = clockIn4.body.data.id;
  sweepFixtures.splitShiftClockInIso = splitClockIn.iso;

  // The sweep runs on a 60s server-process interval — wait for one tick
  // rather than trying to invoke it directly (it's not exported; this is
  // an integration check of the real running process, matching how this
  // codebase's other cron-dependent behavior gets verified live). ALL FOUR
  // fixture sessions — this check's two, plus the C3 and I1 ones above —
  // are set up before this single wait, so one real tick proves every sweep
  // behavior the two checks below also assert. Don't add a second wait.
  await new Promise((resolve) => setTimeout(resolve, 65000));

  const updated = await db.prepare('SELECT * FROM attendance WHERE id = ?').get(attendanceId);
  assert(updated.clock_out !== null, 'Expected the sweep to have closed this session');
  assert(updated.clock_out_method === 'auto_shift_end', `Expected clock_out_method 'auto_shift_end', got '${updated.clock_out_method}'`);

  const untouched = await db.prepare('SELECT * FROM attendance WHERE id = ?').get(attendanceId2);
  assert(untouched.clock_out === null, 'Expected the sweep to SKIP a session with an active approved outdoor-duty request, but it was closed');
});

check('Clock-out sweep never writes a clock_out EARLIER than the clock_in when the shift row says the shift already ended (C3)', async () => {
  assert(sweepFixtures.clockInAfterShiftEndId, 'Fixture missing — the sweep setup check above must run first');
  const db = await getDb();
  const row = await db.prepare('SELECT * FROM attendance WHERE id = ?').get(sweepFixtures.clockInAfterShiftEndId);
  assert(row.clock_out !== null, 'Expected the sweep to have closed this session (due 4h after the clock-in itself)');
  assert(row.clock_out_method === 'auto_shift_end', `Expected clock_out_method 'auto_shift_end', got '${row.clock_out_method}'`);

  // parseServerDate, not `new Date(...)`: this layer hands timestamps back
  // as Dates already (it passes them straight through), while the sync
  // layer would hand back naive UTC strings — the helper covers both.
  const { parseServerDate } = require('../utils/time');
  const inMs = parseServerDate(row.clock_in).getTime();
  const outMs = parseServerDate(row.clock_out).getTime();
  assert(outMs > inMs,`clock_out (${row.clock_out}) must never precede clock_in (${row.clock_in}) — the estimated shift end was BEFORE the clock-in, so the sweep had to fall back to now`);
  assert(Number(row.total_hours) > 0, `Expected total_hours > 0 for a genuinely worked session, got ${row.total_hours} (0 means a negative span was clamped, silently voiding real worked time)`);
  const spanHours = (outMs - inMs) / 3600000;
  assert(Math.abs(Number(row.total_hours) - spanHours) < 0.02, `Expected total_hours (${row.total_hours}) to match the recorded clock_in→clock_out span (${spanHours.toFixed(2)}h)`);
});

check('Clock-out sweep estimates against the MATCHED shift segment, not the day\'s last one, for a forgotten mid-shift clock-out (I1)', async () => {
  assert(sweepFixtures.splitShiftId, 'Fixture missing — the sweep setup check above must run first');
  const db = await getDb();
  const row = await db.prepare('SELECT * FROM attendance WHERE id = ?').get(sweepFixtures.splitShiftId);
  assert(row.clock_out !== null, 'Expected the sweep to have closed this session');
  assert(row.clock_out_method === 'auto_shift_end', `Expected clock_out_method 'auto_shift_end', got '${row.clock_out_method}'`);

  // Clocked in 07:00, matched segment 07:00-12:00 → 5 hours. Using the
  // day's LAST segment end (22:00) instead would record 15 — a 3x
  // inflation straight into total_hours/effective_hours, which feed hourly
  // pay and every attendance report.
  assert(Math.abs(Number(row.total_hours) - 5) < 0.05,
    `Expected ~5 hours (07:00 clock-in → its OWN segment's 12:00 end), got ${row.total_hours} (≈15 means the sweep used the day's final 22:00 segment end)`);

  const { parseServerDate } = require('../utils/time');
  const expectedOutMs = new Date(sweepFixtures.splitShiftClockInIso).getTime() + 5 * 3600000;
  const actualOutMs = parseServerDate(row.clock_out).getTime();
  assert(Math.abs(actualOutMs - expectedOutMs) < 60000, `Expected clock_out at the matched segment's 12:00 end, got ${row.clock_out}`);
});

// ═══════════════════════════════════════════════════════════════
// Negative authorization — a widened role gate has to stay a GATE (I5)
// ═══════════════════════════════════════════════════════════════

check('POST /staff/payroll/disburse rejects florist_staff (owner-only money route)', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const { status } = await api('POST', '/staff/payroll/disburse', florist.token, {
    user_id: florist.id, period_start: '2026-05-01', period_end: '2026-05-31',
    base_salary: 1000, net_amount: 1000, payment_method: 'bank_transfer',
  });
  assert(status === 403, `Expected 403 for florist_staff, got ${status}`);
});

check('POST /attendance/:id/undo-auto-clockin rejects a staff member undoing SOMEONE ELSE\'s session', async () => {
  const owner = await loginOwner();
  const victim = await createFloristStaffSession(owner.token);
  const intruder = await createFloristStaffSession(owner.token);

  const clockIn = await api('POST', '/attendance/clock-in', victim.token, { location_id: TEST_LOCATION_ID, method: 'manual' });
  assert(clockIn.status === 201, `Could not clock in the target user: ${clockIn.status} ${JSON.stringify(clockIn.body)}`);
  createdAttendanceIds.push(clockIn.body.data.id);

  // The route's ownership check runs before every other validation, so a
  // 403 here is specifically the ownership gate — not the "manual
  // clock-ins can't be undone" 400 that the owner would get.
  const { status } = await api('POST', `/attendance/${clockIn.body.data.id}/undo-auto-clockin`, intruder.token);
  assert(status === 403, `Expected 403 when undoing another user's attendance row, got ${status}`);

  await api('POST', '/attendance/clock-out', victim.token, { method: 'manual' });
});

check('GET /staff/salaries scopes counter_staff to their OWN salary, never the whole payroll', async () => {
  const owner = await loginOwner();
  const counter = await createCounterStaffSession(owner.token);
  const other = await createFloristStaffSession(owner.token);
  await api('POST', '/staff/salaries', owner.token, { user_id: other.id, monthly_salary: 21000, salary_type: 'monthly' });
  await api('POST', '/staff/salaries', owner.token, { user_id: counter.id, monthly_salary: 13000, salary_type: 'monthly' });

  const { status, body } = await api('GET', '/staff/salaries', counter.token);
  assert(status === 200, `Expected 200, got ${status}`);
  assert(body.data.salaries === undefined, 'counter_staff must not receive the owner-shaped { salaries, unset } payroll list');
  assert(body.data.unset === undefined, 'counter_staff must not receive the "users without a salary set" list');
  assert(body.data.salary, 'Expected counter_staff to get their own salary record');
  assert(Number(body.data.salary.user_id) === counter.id, `Expected only their own row (user_id ${counter.id}), got ${body.data.salary.user_id}`);
  assert(Number(body.data.salary.monthly_salary) === 13000, `Expected their own 13000, got ${body.data.salary.monthly_salary}`);
});

check('PUT /attendance/salary-advance/:id/approve rejects a non-owner/non-manager role', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const requestRes = await api('POST', '/attendance/salary-advance', florist.token, { amount: 500, reason: 'Negative-auth fixture' });
  assert(requestRes.status === 201, `Could not request advance: ${requestRes.status}`);
  createdAdvanceIds.push(requestRes.body.data.id);

  const { status } = await api('PUT', `/attendance/salary-advance/${requestRes.body.data.id}/approve`, florist.token);
  assert(status === 403, `Expected 403 — a staff member must not approve their own advance, got ${status}`);
});

// ═══════════════════════════════════════════════════════════════
// Auto-closed sessions stay visible to the manager (I6)
// ═══════════════════════════════════════════════════════════════

check('GET /attendance/staff-today surfaces an auto-closed session from YESTERDAY in needs_confirmation', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const db = await getDb();

  const clockIn = await api('POST', '/attendance/clock-in', florist.token, { location_id: TEST_LOCATION_ID, method: 'manual' });
  assert(clockIn.status === 201, `Could not clock in: ${clockIn.status} ${JSON.stringify(clockIn.body)}`);
  const attendanceId = clockIn.body.data.id;
  createdAttendanceIds.push(attendanceId);
  await api('POST', '/attendance/clock-out', florist.token, { method: 'manual' });

  // An evening shift swept closed after midnight: the close happened ~14
  // hours ago, but the row's own `date` is YESTERDAY, so the roster query
  // (hard-scoped to a.date = today, correctly, for what it is) can never
  // show it.
  const { date: yesterday } = yesterdayAtShopLocal('22:00');
  await db.prepare(`
    UPDATE attendance
    SET date = ?, clock_in = NOW() - INTERVAL '20 hours', clock_out = NOW() - INTERVAL '14 hours',
        clock_out_method = 'auto_shift_end'
    WHERE id = ?
  `).run(yesterday, attendanceId);

  const { status, body } = await api('GET', `/attendance/staff-today?location_id=${TEST_LOCATION_ID}`, owner.token);
  assert(status === 200, `Expected 200, got ${status}`);
  assert(Array.isArray(body.data.needs_confirmation), 'Expected data.needs_confirmation to be an array');

  const found = body.data.needs_confirmation.find((r) => r.id === attendanceId);
  assert(found, `Expected the yesterday-dated auto-closed session (id ${attendanceId}) to appear in needs_confirmation`);
  assert(found.clock_out_method === 'auto_shift_end', `Expected clock_out_method 'auto_shift_end', got '${found.clock_out_method}'`);
  assert(found.user_name, 'Expected a staff name on the row — a bare id is not something a manager can act on');
  assert(body.data.summary.needs_confirmation_count >= 1, `Expected summary.needs_confirmation_count >= 1, got ${body.data.summary.needs_confirmation_count}`);
  assert(body.data.summary.needs_confirmation_count === body.data.needs_confirmation.length, 'Expected the summary count to match the list length');

  // The discriminating half: it is genuinely NOT on today's roster, so the
  // separate query is what surfaced it — not an incidental date overlap.
  assert(!body.data.present.some((s) => s.user_id === florist.id),
    'Fixture is not proving anything — the row still shows in today\'s roster, so its date was not moved to yesterday');
});

// ═══════════════════════════════════════════════════════════════
// counter_staff gets the same attendance-roster capability manager
// already has: staff-today read + mark-attendance-for-others on
// clock-in/clock-out (deliberately NOT touched: outdoor-duty
// approve/reject, shifts management, salaries/payroll).
// ═══════════════════════════════════════════════════════════════

check('GET /attendance/staff-today no longer 403s for counter_staff', async () => {
  const owner = await loginOwner();
  const counter = await createCounterStaffSession(owner.token);
  const { status } = await api('GET', `/attendance/staff-today?location_id=${TEST_LOCATION_ID}`, counter.token);
  assert(status === 200, `Expected 200, got ${status}`);
});

check('POST /attendance/clock-in with a user_id body param, called by counter_staff, clocks in the TARGET user (not the caller)', async () => {
  const owner = await loginOwner();
  const counter = await createCounterStaffSession(owner.token);
  const target = await createFloristStaffSession(owner.token);

  const { status, body } = await api('POST', '/attendance/clock-in', counter.token, {
    location_id: TEST_LOCATION_ID, user_id: target.id, method: 'manual',
  });
  assert(status === 201, `Expected 201, got ${status} ${JSON.stringify(body)}`);
  createdAttendanceIds.push(body.data.id);
  assert(Number(body.data.user_id) === target.id, `Expected the created attendance row's user_id to be the TARGET (${target.id}), not the counter_staff caller (${counter.id}) — got ${body.data.user_id}`);

  // Clean up the open session so it doesn't leak into a later check's roster.
  await api('POST', '/attendance/clock-out', counter.token, { user_id: target.id, method: 'manual' });
});

check('POST /attendance/clock-out with a user_id body param, called by counter_staff, clocks out the TARGET user (not the caller)', async () => {
  const owner = await loginOwner();
  const counter = await createCounterStaffSession(owner.token);
  const target = await createFloristStaffSession(owner.token);

  const clockIn = await api('POST', '/attendance/clock-in', counter.token, {
    location_id: TEST_LOCATION_ID, user_id: target.id, method: 'manual',
  });
  assert(clockIn.status === 201, `Could not clock in target via counter_staff: ${clockIn.status} ${JSON.stringify(clockIn.body)}`);
  createdAttendanceIds.push(clockIn.body.data.id);

  const { status, body } = await api('POST', '/attendance/clock-out', counter.token, {
    user_id: target.id, method: 'manual',
  });
  assert(status === 200, `Expected 200, got ${status} ${JSON.stringify(body)}`);
  assert(Number(body.data.user_id) === target.id, `Expected the clocked-out attendance row's user_id to be the TARGET (${target.id}), not the counter_staff caller (${counter.id}) — got ${body.data.user_id}`);
  assert(body.data.clock_out !== null, 'Expected clock_out to be set on the target\'s record');
});

// ═══════════════════════════════════════════════════════════════
// staff-today's logs[] now carries clock_out_method + PER-SESSION
// late_minutes/overtime_minutes (previously computed by
// computeShiftWork and then thrown away — only the aggregate survived).
// ═══════════════════════════════════════════════════════════════

check('GET /attendance/staff-today logs[] carries clock_out_method, late_minutes, and overtime_minutes PER SESSION, not the aggregate repeated', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const db = await getDb();

  // A split shift: 09:00-12:00 and 18:00-22:00.
  const shiftResult = await db.prepare(`
    INSERT INTO employee_shifts (user_id, location_id, shift_start, shift_end, shift_segments, is_active, created_by)
    VALUES (?, ?, '09:00', '22:00', ?, 1, ?) RETURNING id
  `).get(florist.id, TEST_LOCATION_ID, JSON.stringify([{ start: '09:00', end: '12:00' }, { start: '18:00', end: '22:00' }]), owner.id);
  createdShiftIds.push(shiftResult.id);

  // Session 1: will be backdated to exactly on-time for segment 1.
  const clockIn1 = await api('POST', '/attendance/clock-in', florist.token, { location_id: TEST_LOCATION_ID, method: 'manual' });
  assert(clockIn1.status === 201, `Could not clock in session 1: ${clockIn1.status} ${JSON.stringify(clockIn1.body)}`);
  const id1 = clockIn1.body.data.id;
  createdAttendanceIds.push(id1);
  const clockOut1 = await api('POST', '/attendance/clock-out', florist.token, { method: 'manual' });
  assert(clockOut1.status === 200, `Could not clock out session 1: ${clockOut1.status} ${JSON.stringify(clockOut1.body)}`);

  // Session 2: will be backdated to genuinely late (5 min) for segment 2.
  const clockIn2 = await api('POST', '/attendance/clock-in', florist.token, { location_id: TEST_LOCATION_ID, method: 'manual' });
  assert(clockIn2.status === 201, `Could not clock in session 2: ${clockIn2.status} ${JSON.stringify(clockIn2.body)}`);
  const id2 = clockIn2.body.data.id;
  createdAttendanceIds.push(id2);
  const clockOut2 = await api('POST', '/attendance/clock-out', florist.token, { method: 'manual' });
  assert(clockOut2.status === 200, `Could not clock out session 2: ${clockOut2.status} ${JSON.stringify(clockOut2.body)}`);

  // Backdate both sessions to specific shop-local clock times TODAY (so they
  // still land in staff-today's `a.date = today` filter) — session 1 exactly
  // on segment 1's start, session 2 five minutes into segment 2.
  const { todayStr } = require('../utils/time');
  const today = todayStr();
  const toUtcIso = (hhmm) => new Date(`${today}T${hhmm}:00+05:30`).toISOString();
  await db.prepare('UPDATE attendance SET clock_in = ?, clock_out = ? WHERE id = ?')
    .run(toUtcIso('09:00'), toUtcIso('12:00'), id1);
  await db.prepare('UPDATE attendance SET clock_in = ?, clock_out = ? WHERE id = ?')
    .run(toUtcIso('18:05'), toUtcIso('22:00'), id2);

  const { status, body } = await api('GET', `/attendance/staff-today?location_id=${TEST_LOCATION_ID}`, owner.token);
  assert(status === 200, `Expected 200, got ${status}`);
  const row = body.data.present.find((s) => s.user_id === florist.id);
  assert(row, 'Expected the florist to appear in the present list');
  assert(Array.isArray(row.logs), 'Expected a logs array');
  assert(row.logs.length === 2, `Expected 2 sessions in logs, got ${row.logs.length}`);

  for (const log of row.logs) {
    assert('clock_out_method' in log, 'Expected clock_out_method on each log entry');
    assert(typeof log.late_minutes === 'number', 'Expected late_minutes to be a number on each log entry');
    assert(typeof log.overtime_minutes === 'number', 'Expected overtime_minutes to be a number on each log entry');
  }

  const log1 = row.logs.find((l) => l.id === id1);
  const log2 = row.logs.find((l) => l.id === id2);
  assert(log1, 'Expected session 1 in logs');
  assert(log2, 'Expected session 2 in logs');
  assert(log1.clock_out_method === 'manual', `Expected session 1's clock_out_method to be 'manual', got '${log1.clock_out_method}'`);
  assert(log2.clock_out_method === 'manual', `Expected session 2's clock_out_method to be 'manual', got '${log2.clock_out_method}'`);
  assert(log1.late_minutes === 0, `Expected session 1 (exactly on time) late_minutes to be 0, got ${log1.late_minutes}`);
  assert(log2.late_minutes > 0, `Expected session 2 (5 min late) late_minutes > 0, got ${log2.late_minutes} — proves this is PER-SESSION, not the aggregate repeated on every row`);
  assert(log2.late_minutes === 5, `Expected session 2 late_minutes to be exactly 5, got ${log2.late_minutes}`);
});

// ═══════════════════════════════════════════════════════════════
// Half-day detection & confirmation (E1) — findPartialDays wired into
// POST /staff/payroll/calculate. Detection alone (no confirmed_half_day_
// dates) must never move pay; only an explicitly confirmed date — and
// only one findPartialDays itself actually detected — may.
// ═══════════════════════════════════════════════════════════════

const HALFDAY_PERIOD_START = '2026-06-01';
const HALFDAY_PERIOD_END = '2026-06-30';
const HALFDAY_TEST_DATE = '2026-06-15'; // within the period, only segment 1 attended
const HALFDAY_UNRELATED_DATE = '2026-06-20'; // within the period, but zero attendance — never a real partial day
const halfDayFixture = {};

// Shop-local 'YYYY-MM-DD' + 'HH:MM' -> the naive-UTC-ish ISO string this
// codebase's attendance rows are actually stored as. Same conversion the
// existing toUtcIso()/yesterdayAtShopLocal() helpers above use for "today"
// and "yesterday" respectively, generalized to an arbitrary calendar date
// so a fixed test date (independent of whenever this suite happens to run)
// can be used for a payroll-period fixture.
function shopLocalToUtcIso(dateStr, hhmm) {
  return new Date(`${dateStr}T${hhmm}:00+05:30`).toISOString();
}

check('POST /staff/payroll/calculate detects a genuine 1-of-2-segments partial day and does NOT move pay when unconfirmed (E1 detection)', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const db = await getDb();

  // Real 2-segment split shift: 07:00-12:00 / 18:00-22:00.
  const shiftResult = await db.prepare(`
    INSERT INTO employee_shifts (user_id, location_id, shift_start, shift_end, shift_segments, is_active, created_by)
    VALUES (?, ?, '07:00', '22:00', ?, 1, ?) RETURNING id
  `).get(florist.id, TEST_LOCATION_ID, JSON.stringify([{ start: '07:00', end: '12:00' }, { start: '18:00', end: '22:00' }]), owner.id);
  createdShiftIds.push(shiftResult.id);

  await api('POST', '/staff/salaries', owner.token, { user_id: florist.id, monthly_salary: 1000, salary_type: 'daily' });

  // A real clock-in/out pair via the actual routes, then backdated (both
  // timestamps AND the date column) to land inside segment 1's window on a
  // fixed date within the test period. Segment 2 is never touched that day.
  const clockIn = await api('POST', '/attendance/clock-in', florist.token, { location_id: TEST_LOCATION_ID, method: 'manual' });
  assert(clockIn.status === 201, `Could not clock in: ${clockIn.status} ${JSON.stringify(clockIn.body)}`);
  const attendanceId = clockIn.body.data.id;
  createdAttendanceIds.push(attendanceId);
  const clockOut = await api('POST', '/attendance/clock-out', florist.token, { method: 'manual' });
  assert(clockOut.status === 200, `Could not clock out: ${clockOut.status} ${JSON.stringify(clockOut.body)}`);
  await db.prepare('UPDATE attendance SET clock_in = ?, clock_out = ?, date = ? WHERE id = ?').run(
    shopLocalToUtcIso(HALFDAY_TEST_DATE, '08:00'), shopLocalToUtcIso(HALFDAY_TEST_DATE, '11:00'), HALFDAY_TEST_DATE, attendanceId
  );

  const { status, body } = await api('POST', '/staff/payroll/calculate', owner.token, {
    user_id: florist.id, period_start: HALFDAY_PERIOD_START, period_end: HALFDAY_PERIOD_END,
  });
  assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);

  const partial = body.data.partial_days.find((p) => p.date === HALFDAY_TEST_DATE);
  assert(partial, `Expected ${HALFDAY_TEST_DATE} in partial_days, got ${JSON.stringify(body.data.partial_days)}`);
  assert(partial.attended_segments === 1, `Expected attended_segments 1, got ${partial.attended_segments}`);
  assert(partial.total_segments === 2, `Expected total_segments 2, got ${partial.total_segments}`);

  // Detection alone (no confirmed_half_day_dates sent) must leave pay
  // completely unchanged from what it would be with zero half-day logic:
  // daily rate 1000 × (daysWorked 1 - 0) = 1000.
  assert(body.data.attendance_summary.half_days === 0, `Expected half_days 0 (unconfirmed), got ${body.data.attendance_summary.half_days}`);
  assert(body.data.calculation.base_pay === 1000, `Expected unconfirmed base_pay 1000 (unaffected by detection alone), got ${body.data.calculation.base_pay}`);
  assert(body.data.calculation.net_amount === 1000, `Expected unconfirmed net_amount 1000, got ${body.data.calculation.net_amount}`);

  halfDayFixture.floristId = florist.id;
  halfDayFixture.unconfirmedDailyBasePay = body.data.calculation.base_pay;
});

check('POST /staff/payroll/calculate reduces base_pay by exactly half a day\'s rate once the partial day is confirmed (daily salary type), and a DUPLICATED valid date is not double-counted (E1 confirmation + dedup)', async () => {
  assert(halfDayFixture.floristId, 'Fixture missing — the detection check above must run first');
  const owner = await loginOwner();

  // The same valid date sent TWICE in the request — must be deduped before
  // counting, not double-deducted. If dedup were missing, half_days would
  // read 2 and base_pay would drop by a full day's rate (1000) instead of
  // half (500).
  const { status, body } = await api('POST', '/staff/payroll/calculate', owner.token, {
    user_id: halfDayFixture.floristId, period_start: HALFDAY_PERIOD_START, period_end: HALFDAY_PERIOD_END,
    confirmed_half_day_dates: [HALFDAY_TEST_DATE, HALFDAY_TEST_DATE],
  });
  assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert(body.data.attendance_summary.half_days === 1, `Expected half_days 1 (deduped, not 2), got ${body.data.attendance_summary.half_days}`);

  const expectedBasePay = halfDayFixture.unconfirmedDailyBasePay - 500; // half of the 1000 daily rate, counted ONCE
  assert(body.data.calculation.base_pay === expectedBasePay,
    `Expected base_pay reduced by exactly 500 (half the daily rate, deduped) from ${halfDayFixture.unconfirmedDailyBasePay} to ${expectedBasePay}, got ${body.data.calculation.base_pay}`);
});

check('POST /staff/payroll/calculate adds exactly (monthly_salary/30)*0.5 to deductions once the partial day is confirmed (monthly salary type) (E1 confirmation)', async () => {
  assert(halfDayFixture.floristId, 'Fixture missing — the detection check above must run first');
  const owner = await loginOwner();
  // Switch the same fixture user to monthly — POST /staff/salaries upserts
  // by user_id, so the split-shift/attendance fixture itself is untouched.
  await api('POST', '/staff/salaries', owner.token, { user_id: halfDayFixture.floristId, monthly_salary: 15000, salary_type: 'monthly' });

  const unconfirmed = await api('POST', '/staff/payroll/calculate', owner.token, {
    user_id: halfDayFixture.floristId, period_start: HALFDAY_PERIOD_START, period_end: HALFDAY_PERIOD_END,
  });
  assert(unconfirmed.status === 200, `Expected 200, got ${unconfirmed.status}: ${JSON.stringify(unconfirmed.body)}`);
  assert(unconfirmed.body.data.attendance_summary.half_days === 0, `Expected half_days 0 (unconfirmed), got ${unconfirmed.body.data.attendance_summary.half_days}`);

  const confirmed = await api('POST', '/staff/payroll/calculate', owner.token, {
    user_id: halfDayFixture.floristId, period_start: HALFDAY_PERIOD_START, period_end: HALFDAY_PERIOD_END,
    confirmed_half_day_dates: [HALFDAY_TEST_DATE],
  });
  assert(confirmed.status === 200, `Expected 200, got ${confirmed.status}: ${JSON.stringify(confirmed.body)}`);
  assert(confirmed.body.data.attendance_summary.half_days === 1, `Expected half_days 1 (confirmed), got ${confirmed.body.data.attendance_summary.half_days}`);

  const expectedDelta = (15000 / 30) * 0.5; // 250
  const actualDelta = confirmed.body.data.calculation.deductions - unconfirmed.body.data.calculation.deductions;
  assert(Math.abs(actualDelta - expectedDelta) < 0.01,
    `Expected deductions to increase by exactly ${expectedDelta} (monthly_salary/30 × 0.5), from ${unconfirmed.body.data.calculation.deductions} to ${unconfirmed.body.data.calculation.deductions + expectedDelta}, got a delta of ${actualDelta} (confirmed=${confirmed.body.data.calculation.deductions})`);

  halfDayFixture.monthlyUnconfirmedDeductions = unconfirmed.body.data.calculation.deductions;
});

check('POST /staff/payroll/calculate silently ignores a confirmed_half_day_dates entry that is NOT a real detected partial day (E1 validation)', async () => {
  assert(halfDayFixture.floristId, 'Fixture missing — the detection check above must run first');
  const owner = await loginOwner();

  const { status, body } = await api('POST', '/staff/payroll/calculate', owner.token, {
    user_id: halfDayFixture.floristId, period_start: HALFDAY_PERIOD_START, period_end: HALFDAY_PERIOD_END,
    confirmed_half_day_dates: [HALFDAY_UNRELATED_DATE],
  });
  assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert(body.data.attendance_summary.half_days === 0,
    `Expected an unrelated/non-partial date to be silently ignored (half_days 0), got ${body.data.attendance_summary.half_days}`);
  assert(typeof halfDayFixture.monthlyUnconfirmedDeductions === 'number', 'Fixture missing — the monthly confirmation check above must run first');
  assert(Math.abs(body.data.calculation.deductions - halfDayFixture.monthlyUnconfirmedDeductions) < 0.01,
    `Expected deductions unchanged from the unconfirmed baseline (${halfDayFixture.monthlyUnconfirmedDeductions}), got ${body.data.calculation.deductions} — a non-partial date should never affect pay`);
});

check('POST /staff/payroll/calculate always returns partial_days: [] for a single-segment (non-split) shift, regardless of attendance (E1 no-regression)', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const db = await getDb();

  const shiftResult = await db.prepare(`
    INSERT INTO employee_shifts (user_id, location_id, shift_start, shift_end, is_active, created_by)
    VALUES (?, ?, '09:00', '18:00', 1, ?) RETURNING id
  `).get(florist.id, TEST_LOCATION_ID, owner.id);
  createdShiftIds.push(shiftResult.id);
  await api('POST', '/staff/salaries', owner.token, { user_id: florist.id, monthly_salary: 12000, salary_type: 'monthly' });

  const clockIn = await api('POST', '/attendance/clock-in', florist.token, { location_id: TEST_LOCATION_ID, method: 'manual' });
  assert(clockIn.status === 201, `Could not clock in: ${clockIn.status} ${JSON.stringify(clockIn.body)}`);
  createdAttendanceIds.push(clockIn.body.data.id);
  const clockOut = await api('POST', '/attendance/clock-out', florist.token, { method: 'manual' });
  assert(clockOut.status === 200, `Could not clock out: ${clockOut.status} ${JSON.stringify(clockOut.body)}`);

  const { todayStr } = require('../utils/time');
  const today = todayStr();
  const { status, body } = await api('POST', '/staff/payroll/calculate', owner.token, {
    user_id: florist.id, period_start: today, period_end: today,
  });
  assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert(Array.isArray(body.data.partial_days), 'Expected partial_days to be an array');
  assert(body.data.partial_days.length === 0, `Expected partial_days: [] for a single-segment shift, got ${JSON.stringify(body.data.partial_days)}`);
});

// The single most dangerous regression case for this feature: a genuinely
// FULL split-shift day (both segments actually attended) must never be
// misread as a partial day — that would silently dock real pay on a day
// nothing was actually missed. Guards findPartialDays' "size < segments
// .length" boundary against a future refactor getting it wrong.
check('POST /staff/payroll/calculate never lists a genuinely FULL split-shift day (both segments attended) in partial_days (E1 full-day guard)', async () => {
  const FULL_DAY_TEST_DATE = '2026-06-10'; // within the E1 test period, distinct from HALFDAY_TEST_DATE/HALFDAY_UNRELATED_DATE
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const db = await getDb();

  const shiftResult = await db.prepare(`
    INSERT INTO employee_shifts (user_id, location_id, shift_start, shift_end, shift_segments, is_active, created_by)
    VALUES (?, ?, '07:00', '22:00', ?, 1, ?) RETURNING id
  `).get(florist.id, TEST_LOCATION_ID, JSON.stringify([{ start: '07:00', end: '12:00' }, { start: '18:00', end: '22:00' }]), owner.id);
  createdShiftIds.push(shiftResult.id);
  await api('POST', '/staff/salaries', owner.token, { user_id: florist.id, monthly_salary: 1500, salary_type: 'daily' });

  // Two REAL clock-in/clock-out pairs via the actual routes — one per
  // segment — both later backdated onto the SAME calendar date.
  const clockIn1 = await api('POST', '/attendance/clock-in', florist.token, { location_id: TEST_LOCATION_ID, method: 'manual' });
  assert(clockIn1.status === 201, `Could not clock in (segment 1): ${clockIn1.status} ${JSON.stringify(clockIn1.body)}`);
  const id1 = clockIn1.body.data.id;
  createdAttendanceIds.push(id1);
  const clockOut1 = await api('POST', '/attendance/clock-out', florist.token, { method: 'manual' });
  assert(clockOut1.status === 200, `Could not clock out (segment 1): ${clockOut1.status} ${JSON.stringify(clockOut1.body)}`);

  const clockIn2 = await api('POST', '/attendance/clock-in', florist.token, { location_id: TEST_LOCATION_ID, method: 'manual' });
  assert(clockIn2.status === 201, `Could not clock in (segment 2): ${clockIn2.status} ${JSON.stringify(clockIn2.body)}`);
  const id2 = clockIn2.body.data.id;
  createdAttendanceIds.push(id2);
  const clockOut2 = await api('POST', '/attendance/clock-out', florist.token, { method: 'manual' });
  assert(clockOut2.status === 200, `Could not clock out (segment 2): ${clockOut2.status} ${JSON.stringify(clockOut2.body)}`);

  await db.prepare('UPDATE attendance SET clock_in = ?, clock_out = ?, date = ? WHERE id = ?').run(
    shopLocalToUtcIso(FULL_DAY_TEST_DATE, '07:00'), shopLocalToUtcIso(FULL_DAY_TEST_DATE, '12:00'), FULL_DAY_TEST_DATE, id1
  );
  await db.prepare('UPDATE attendance SET clock_in = ?, clock_out = ?, date = ? WHERE id = ?').run(
    shopLocalToUtcIso(FULL_DAY_TEST_DATE, '18:00'), shopLocalToUtcIso(FULL_DAY_TEST_DATE, '22:00'), FULL_DAY_TEST_DATE, id2
  );

  const { status, body } = await api('POST', '/staff/payroll/calculate', owner.token, {
    user_id: florist.id, period_start: HALFDAY_PERIOD_START, period_end: HALFDAY_PERIOD_END,
  });
  assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);

  const found = body.data.partial_days.find((p) => p.date === FULL_DAY_TEST_DATE);
  assert(!found, `Expected ${FULL_DAY_TEST_DATE} (both segments attended) to NOT appear in partial_days, got ${JSON.stringify(found)}`);
  assert(body.data.attendance_summary.half_days === 0, `Expected half_days 0 (nothing confirmed and nothing genuinely partial), got ${body.data.attendance_summary.half_days}`);
});

async function cleanup() {
  const db = await getDb();
  for (const id of createdExpenseIds) {
    try { await db.prepare('DELETE FROM expenses WHERE id = ?').run(id); } catch (err) { console.error(`   (cleanup warning: expense ${id}: ${err.message})`); }
  }
  // createdSalaryIds holds real salary_payments.id values only — employee_salaries
  // has no independently-tracked id here and is cleaned up below, by user_id.
  for (const id of createdSalaryIds) {
    try { await db.prepare('DELETE FROM salary_payments WHERE id = ?').run(id); } catch (err) { console.error(`   (cleanup warning: salary_payment ${id}: ${err.message})`); }
  }
  for (const id of createdAdvanceIds) {
    try { await db.prepare('DELETE FROM salary_advances WHERE id = ?').run(id); } catch (err) { console.error(`   (cleanup warning: advance ${id}: ${err.message})`); }
  }
  // Delete outdoor_duty_requests before attendance — attendance_id may be a
  // foreign key without cascade, so the referencing row must go first.
  for (const id of createdOutdoorDutyIds) {
    try { await db.prepare('DELETE FROM outdoor_duty_requests WHERE id = ?').run(id); } catch (err) { console.error(`   (cleanup warning: outdoor_duty_request ${id}: ${err.message})`); }
  }
  for (const id of createdAttendanceIds) {
    try { await db.prepare('DELETE FROM attendance WHERE id = ?').run(id); } catch (err) { console.error(`   (cleanup warning: attendance ${id}: ${err.message})`); }
  }
  for (const id of createdShiftIds) {
    try { await db.prepare('DELETE FROM employee_shifts WHERE id = ?').run(id); } catch (err) { console.error(`   (cleanup warning: shift ${id}: ${err.message})`); }
  }
  for (const id of createdUserIds) {
    try { await db.prepare('DELETE FROM employee_salaries WHERE user_id = ?').run(id); } catch (_) {}
    try { await db.prepare('DELETE FROM salary_history WHERE user_id = ?').run(id); } catch (_) {}
    try { await db.prepare('DELETE FROM user_locations WHERE user_id = ?').run(id); } catch (_) {}
    try { await db.prepare('DELETE FROM geofence_events WHERE user_id = ?').run(id); } catch (_) {}
    try { await db.prepare('DELETE FROM notifications WHERE user_id = ?').run(id); } catch (_) {}
    try { await db.prepare('DELETE FROM users WHERE id = ?').run(id); } catch (err) { console.error(`   (cleanup warning: user ${id}: ${err.message})`); }
  }
  // Clean up owner's attendance_missed_clockin notifications created by the test check
  try { await db.prepare("DELETE FROM notifications WHERE type = 'attendance_missed_clockin' AND body LIKE '%Verify Florist%'").run(); } catch (_) {}
  console.log(`Cleaned up ${createdUserIds.length} test user(s), ${createdShiftIds.length} shift(s), ${createdAttendanceIds.length} attendance row(s), ${createdSalaryIds.length} salary_payment(s), ${createdAdvanceIds.length} advance(s), ${createdExpenseIds.length} expense(s), ${createdOutdoorDutyIds.length} outdoor_duty_request(s)`);
}

async function main() {
  assertLocalTarget();
  let pass = 0, fail = 0;
  for (const { name, fn } of checks) {
    try { await fn(); console.log(`✅ ${name}`); pass++; }
    catch (err) { console.log(`❌ ${name}`); console.log(`   ${err.message}`); fail++; }
  }
  await cleanup();
  console.log(`\n${pass}/${pass + fail} checks passed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
