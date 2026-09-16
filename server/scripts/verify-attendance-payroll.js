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
async function createFloristStaffSession(ownerToken) {
  const phone = `9${Date.now().toString().slice(-9)}`;
  const { status, body } = await api('POST', '/users', ownerToken, {
    name: 'Verify Florist', phone, password: 'verifypass123',
    role: 'florist_staff', location_ids: [TEST_LOCATION_ID],
  });
  assert(status === 201, `Could not create florist_staff test user: ${status} ${JSON.stringify(body)}`);
  const userId = body.data.user.id;
  createdUserIds.push(userId);
  const login = await api('POST', '/auth/login', null, { phone, password: 'verifypass123' });
  assert(login.status === 200, `Florist test user login failed: ${login.status} ${JSON.stringify(login.body)}`);
  return { token: login.body.data.token, id: userId };
}

module.exports = {
  check, checks, api, assert, loginOwner, createFloristStaffSession,
  TEST_LOCATION_ID, getDb,
  createdUserIds, createdShiftIds, createdAttendanceIds, createdSalaryIds, createdAdvanceIds, createdExpenseIds,
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

check('POST /staff/payroll/disburse (cash) requires an open register, writes a linked expense, adjusts expected_cash, and caps advances_deducted at net_amount', async () => {
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

  // advances_deducted (5000) exceeds net_amount (3000) — must be capped to
  // 3000, not repay the full 5000 against real money that was never paid.
  const { status, body } = await api('POST', '/staff/payroll/disburse', owner.token, {
    user_id: florist.id, period_start: '2026-02-01', period_end: '2026-02-28',
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

// ═══════════════════════════════════════════════════════════════
// Clock-out recovery sweep — closes attendance sessions left open well
// past their shift (or a flat fallback window with no shift configured),
// with no geofence activity required at all.
// ═══════════════════════════════════════════════════════════════

check('Clock-out sweep closes a session open well past the fallback window (no shift configured)', async () => {
  const owner = await loginOwner();
  const florist = await createFloristStaffSession(owner.token);
  const clockIn = await api('POST', '/attendance/clock-in', florist.token, { location_id: TEST_LOCATION_ID, method: 'manual' });
  const attendanceId = clockIn.body.data.id;
  createdAttendanceIds.push(attendanceId);

  const db = await getDb();
  // Backdate 18 hours — past the 16-hour no-shift fallback window.
  await db.prepare("UPDATE attendance SET clock_in = clock_in - INTERVAL '18 hours' WHERE id = ?").run(attendanceId);

  // The sweep runs on a 60s server-process interval — wait for one tick
  // rather than trying to invoke it directly (it's not exported; this is
  // an integration check of the real running process, matching how this
  // codebase's other cron-dependent behavior gets verified live).
  await new Promise((resolve) => setTimeout(resolve, 65000));

  const updated = await db.prepare('SELECT * FROM attendance WHERE id = ?').get(attendanceId);
  assert(updated.clock_out !== null, 'Expected the sweep to have closed this session');
  assert(updated.clock_out_method === 'auto_shift_end', `Expected clock_out_method 'auto_shift_end', got '${updated.clock_out_method}'`);
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
  console.log(`Cleaned up ${createdUserIds.length} test user(s), ${createdShiftIds.length} shift(s), ${createdAttendanceIds.length} attendance row(s), ${createdSalaryIds.length} salary_payment(s), ${createdAdvanceIds.length} advance(s), ${createdExpenseIds.length} expense(s)`);
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
