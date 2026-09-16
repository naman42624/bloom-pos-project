const express = require('express');
const router = express.Router();
const { getDb } = require('../config/database');
const { getDb: getAsyncDb } = require('../config/database-async');
const { authenticate, authorize } = require('../middleware/auth');
const { nowLocal, todayStr } = require('../utils/time');
const { computeShiftWork, normalizeSegments, matchSegmentForTime, lateMinutesFor, timestampToMinutes } = require('../utils/shift-work');
const { hasOpenRegister, REGISTER_CLOSED_MESSAGE } = require('../utils/register-guard');
const { createNotification } = require('./notifications');

router.use(authenticate);

// ═══════════════════════════════════════════════════════════════
// EMPLOYEE SHIFTS / SCHEDULES
// ═══════════════════════════════════════════════════════════════

// Get shift for a specific user (or all shifts)
router.get('/shifts', authorize('owner', 'manager', 'employee', 'counter_staff', 'florist_staff', 'delivery_partner'), async (req, res) => {
  try {
    const db = await getAsyncDb();
    const { user_id, location_id } = req.query;

    // Employees/DP can only see their own shift
    if (['employee', 'counter_staff', 'florist_staff', 'delivery_partner'].includes(req.user.role)) {
      const shifts = await db.prepare(`
        SELECT es.*, u.name as user_name, u.phone as user_phone, u.role as user_role, l.name as location_name
        FROM employee_shifts es
        JOIN users u ON es.user_id = u.id
        JOIN locations l ON es.location_id = l.id
        WHERE es.user_id = ? AND es.is_active = 1
      `).all(req.user.id);
      return res.json({ success: true, data: shifts });
    }

    let where = ['es.is_active = 1'];
    const params = [];

    if (user_id) {
      where.push('es.user_id = ?');
      params.push(Number(user_id));
    }
    if (location_id) {
      where.push('es.location_id = ?');
      params.push(Number(location_id));
    }

    // Managers see only assigned locations
    if (req.user.role === 'manager') {
      const locs = (await db.prepare('SELECT location_id FROM user_locations WHERE user_id = ?').all(req.user.id)).map(l => l.location_id);
      if (locs.length > 0) {
        where.push(`es.location_id IN (${locs.map(() => '?').join(',')})`);
        params.push(...locs);
      }
    }

    const shifts = await db.prepare(`
      SELECT es.*, u.name as user_name, u.phone as user_phone, u.role as user_role, l.name as location_name
      FROM employee_shifts es
      JOIN users u ON es.user_id = u.id
      JOIN locations l ON es.location_id = l.id
      WHERE ${where.join(' AND ')}
      ORDER BY u.name
    `).all(...params);

    res.json({ success: true, data: shifts });
  } catch (error) {
    console.error('Get shifts error:', error);
    res.status(500).json({ success: false, message: 'Failed to get shifts.' });
  }
});

// Create/update shift for an employee
router.post('/shifts', authorize('owner', 'manager'), (req, res) => {
  try {
    const db = getDb();
    const { user_id, location_id, shift_start, shift_end, days_of_week, geofence_timeout_minutes, shift_segments } = req.body;

    if (Array.isArray(shift_segments)) {
      for (const seg of shift_segments) {
        if (seg?.start && seg?.end && seg.end <= seg.start) {
          return res.status(400).json({ success: false, message: `A shift segment can't end before it starts (${seg.start}–${seg.end}). Split an overnight shift into two segments on separate days instead.` });
        }
      }
    }

    if (!user_id || !location_id) {
      return res.status(400).json({ success: false, message: 'user_id and location_id are required.' });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(user_id);
    if (!user || user.role === 'owner' || user.role === 'customer') {
      return res.status(400).json({ success: false, message: 'Invalid staff member.' });
    }

    // Validate shift_segments if provided
    const segmentsJson = shift_segments
      ? (typeof shift_segments === 'string' ? shift_segments : JSON.stringify(shift_segments))
      : null;

    // Check existing shift for this user+location
    const existing = db.prepare('SELECT id FROM employee_shifts WHERE user_id = ? AND location_id = ? AND is_active = 1').get(user_id, location_id);

    if (existing) {
      // Update
      db.prepare(`
        UPDATE employee_shifts 
        SET shift_start = ?, shift_end = ?, days_of_week = ?, geofence_timeout_minutes = ?, shift_segments = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        shift_start || '09:00',
        shift_end || '18:00',
        JSON.stringify(days_of_week || [0,1,2,3,4,5]),
        geofence_timeout_minutes || 15,
        segmentsJson,
        existing.id
      );
      const updated = db.prepare(`
        SELECT es.*, u.name as user_name, l.name as location_name
        FROM employee_shifts es JOIN users u ON es.user_id = u.id JOIN locations l ON es.location_id = l.id
        WHERE es.id = ?
      `).get(existing.id);
      return res.json({ success: true, data: updated, message: 'Shift updated.' });
    }

    // Create
    const result = db.prepare(`
      INSERT INTO employee_shifts (user_id, location_id, shift_start, shift_end, days_of_week, geofence_timeout_minutes, shift_segments, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      user_id, location_id,
      shift_start || '09:00',
      shift_end || '18:00',
      JSON.stringify(days_of_week || [0,1,2,3,4,5]),
      geofence_timeout_minutes || 15,
      segmentsJson,
      req.user.id
    );

    const shift = db.prepare(`
      SELECT es.*, u.name as user_name, l.name as location_name
      FROM employee_shifts es JOIN users u ON es.user_id = u.id JOIN locations l ON es.location_id = l.id
      WHERE es.id = ?
    `).get(result.lastInsertRowid);

    res.status(201).json({ success: true, data: shift });
  } catch (error) {
    console.error('Create shift error:', error);
    res.status(500).json({ success: false, message: 'Failed to create shift.' });
  }
});

// Delete shift
router.delete('/shifts/:id', authorize('owner', 'manager'), (req, res) => {
  try {
    const db = getDb();
    db.prepare('UPDATE employee_shifts SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
    res.json({ success: true, message: 'Shift removed.' });
  } catch (error) {
    console.error('Delete shift error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete shift.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// EMPLOYEE SALARIES (Owner only for viewing all, staff sees own)
// ═══════════════════════════════════════════════════════════════

// Get salaries — owner sees all, staff sees own
router.get('/salaries', authorize('owner', 'manager', 'employee', 'counter_staff', 'florist_staff', 'delivery_partner'), async (req, res) => {
  try {
    const db = await getAsyncDb();

    if (req.user.role === 'owner') {
      // Owner sees all staff salaries
      const salaries = await db.prepare(`
        SELECT es.*, u.name as user_name, u.phone as user_phone, u.role as user_role,
               up.name as updater_name
        FROM employee_salaries es
        JOIN users u ON es.user_id = u.id
        LEFT JOIN users up ON es.updated_by = up.id
        WHERE u.role IN ('manager', 'employee', 'counter_staff', 'florist_staff', 'delivery_partner') AND u.is_active = 1
        ORDER BY u.name
      `).all();

      // Also get users without salary records
      const usersWithout = await db.prepare(`
        SELECT u.id, u.name, u.phone, u.role
        FROM users u
        WHERE u.role IN ('manager', 'employee', 'counter_staff', 'florist_staff', 'delivery_partner') AND u.is_active = 1
        AND u.id NOT IN (SELECT user_id FROM employee_salaries)
        ORDER BY u.name
      `).all();

      return res.json({ success: true, data: { salaries, unset: usersWithout } });
    }

    // Staff sees only their own
    const salary = await db.prepare(`
      SELECT es.*, u.name as user_name
      FROM employee_salaries es
      JOIN users u ON es.user_id = u.id
      WHERE es.user_id = ?
    `).get(req.user.id);

    res.json({ success: true, data: { salary: salary || null } });
  } catch (error) {
    console.error('Get salaries error:', error);
    res.status(500).json({ success: false, message: 'Failed to get salaries.' });
  }
});

// Set/update salary — Owner only
router.post('/salaries', authorize('owner'), (req, res) => {
  try {
    const db = getDb();
    const { user_id, monthly_salary, salary_type, notes } = req.body;

    if (!user_id || monthly_salary === undefined || monthly_salary < 0) {
      return res.status(400).json({ success: false, message: 'user_id and valid monthly_salary are required.' });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(user_id);
    if (!user || user.role === 'owner' || user.role === 'customer') {
      return res.status(400).json({ success: false, message: 'Invalid staff member.' });
    }

    const existing = db.prepare('SELECT * FROM employee_salaries WHERE user_id = ?').get(user_id);

    if (existing) {
      // Record history
      db.prepare(`
        INSERT INTO salary_history (user_id, old_salary, new_salary, salary_type, reason, changed_by)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(user_id, existing.monthly_salary, monthly_salary, salary_type || 'monthly', notes || '', req.user.id);

      // Update
      db.prepare(`
        UPDATE employee_salaries 
        SET monthly_salary = ?, salary_type = ?, notes = ?, effective_from = DATE('now'), updated_by = ?, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ?
      `).run(monthly_salary, salary_type || 'monthly', notes || '', req.user.id, user_id);
    } else {
      // Create
      db.prepare(`
        INSERT INTO employee_salaries (user_id, monthly_salary, salary_type, notes, updated_by)
        VALUES (?, ?, ?, ?, ?)
      `).run(user_id, monthly_salary, salary_type || 'monthly', notes || '', req.user.id);

      // Record in history
      db.prepare(`
        INSERT INTO salary_history (user_id, old_salary, new_salary, salary_type, reason, changed_by)
        VALUES (?, 0, ?, ?, ?, ?)
      `).run(user_id, monthly_salary, salary_type || 'monthly', 'Initial salary set', req.user.id);
    }

    const salary = db.prepare(`
      SELECT es.*, u.name as user_name, u.role as user_role
      FROM employee_salaries es JOIN users u ON es.user_id = u.id
      WHERE es.user_id = ?
    `).get(user_id);

    res.json({ success: true, data: salary });
  } catch (error) {
    console.error('Set salary error:', error);
    res.status(500).json({ success: false, message: 'Failed to set salary.' });
  }
});

// Get salary history for a user — Owner only
router.get('/salaries/:userId/history', authorize('owner'), async (req, res) => {
  try {
    const db = await getAsyncDb();
    const history = await db.prepare(`
      SELECT sh.*, u.name as user_name, c.name as changed_by_name
      FROM salary_history sh
      JOIN users u ON sh.user_id = u.id
      JOIN users c ON sh.changed_by = c.id
      WHERE sh.user_id = ?
      ORDER BY sh.created_at DESC
    `).all(req.params.userId);

    res.json({ success: true, data: history });
  } catch (error) {
    console.error('Get salary history error:', error);
    res.status(500).json({ success: false, message: 'Failed to get salary history.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GEOFENCE EVENTS (from client-side geofence monitoring)
// ═══════════════════════════════════════════════════════════════

// Haversine distance in meters — a local copy rather than importing
// delivery-tracking.js's own (kilometers, a different unit, and not
// exported) — matches geofence_radius's stored unit (meters) directly.
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Record geofence enter/exit event
router.post('/geofence-event', authorize('manager', 'employee', 'counter_staff', 'florist_staff', 'delivery_partner'), (req, res) => {
  try {
    const db = getDb();
    const { location_id, event_type, latitude, longitude } = req.body;

    if (!location_id || !event_type || !['enter', 'exit'].includes(event_type)) {
      return res.status(400).json({ success: false, message: 'location_id and valid event_type (enter/exit) required.' });
    }

    const result = db.prepare(`
      INSERT INTO geofence_events (user_id, location_id, event_type, latitude, longitude)
      VALUES (?, ?, ?, ?, ?)
    `).run(req.user.id, location_id, event_type, latitude || null, longitude || null);

    const event = db.prepare('SELECT * FROM geofence_events WHERE id = ?').get(result.lastInsertRowid);

    if (event_type === 'enter') {
      // Proximity check — refuse to auto clock in if we can't verify this
      // claim server-side, rather than trusting the client's coordinates.
      const location = db.prepare('SELECT latitude, longitude, geofence_radius FROM locations WHERE id = ?').get(location_id);
      if (!location || location.latitude == null || location.longitude == null || latitude == null || longitude == null) {
        return res.json({ success: true, data: event, action: 'unverified', message: 'Could not verify your location — use Clock In instead.' });
      }
      const distance = haversineMeters(Number(location.latitude), Number(location.longitude), Number(latitude), Number(longitude));
      if (distance > (location.geofence_radius || 500)) {
        return res.json({ success: true, data: event, action: 'out_of_range', message: 'You do not appear to be at this location.' });
      }

      const today = todayStr();
      const openSession = db.prepare('SELECT id FROM attendance WHERE user_id = ? AND date = ? AND clock_out IS NULL').get(req.user.id, today);

      if (!openSession) {
        const now = nowLocal();
        const shift = db.prepare('SELECT shift_start, shift_end, shift_segments FROM employee_shifts WHERE user_id = ? AND location_id = ? AND is_active = 1').get(req.user.id, location_id);
        let late = 0;
        if (shift && (shift.shift_start || shift.shift_segments)) {
          const segments = normalizeSegments(shift.shift_start, shift.shift_end, shift.shift_segments);
          const clockInMinutes = timestampToMinutes(now);
          const segment = matchSegmentForTime(clockInMinutes, segments);
          late = lateMinutesFor(clockInMinutes, segment) > 0 ? 1 : 0;
        }

        const insertResult = db.prepare(`
          INSERT INTO attendance (user_id, location_id, date, clock_in, clock_in_method, clock_in_latitude, clock_in_longitude, late_arrival, status)
          VALUES (?, ?, ?, ?, 'auto_geofence', ?, ?, ?, 'present')
        `).run(req.user.id, location_id, today, now, latitude || null, longitude || null, late);
        const attendanceId = insertResult.lastInsertRowid;

        db.prepare('UPDATE geofence_events SET processed = 1, auto_action = ? WHERE id = ?').run('clock_in', event.id);

        const locationRow = db.prepare('SELECT name FROM locations WHERE id = ?').get(location_id);
        const friendlyTime = new Intl.DateTimeFormat('en-IN', {
          timeZone: require('../utils/time').getTimezone(), hour: 'numeric', minute: '2-digit', hour12: true,
        }).format(new Date(now));
        createNotification({
          userIds: req.user.id,
          title: 'Clocked in automatically',
          body: `${locationRow ? locationRow.name : 'Shop'}, ${friendlyTime} — not working? Tap to undo.`,
          type: 'attendance_auto_clockin',
          data: { screen: 'Attendance', attendanceId, action: 'undo_auto_clockin' },
        }).catch(() => {});

        // attendance_id is returned EXPLICITLY — `data` above is the
        // geofence_events row, not the attendance row, and their id ranges
        // can collide (confirmed on the live dev DB: geofence_events was
        // empty, so its sequence starts at 1, squarely inside real
        // attendance's id range). Any caller needing the attendance row
        // must use this field, never `data.id`.
        return res.json({ success: true, data: event, attendance_id: attendanceId, action: 'auto_clock_in' });
      }
    }

    if (event_type === 'exit') {
      db.prepare('UPDATE geofence_events SET processed = 0 WHERE id = ?').run(event.id);
      return res.json({ success: true, data: event, action: 'exit_recorded' });
    }

    res.json({ success: true, data: event });
  } catch (error) {
    console.error('Geofence event error:', error);
    res.status(500).json({ success: false, message: 'Failed to record geofence event.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// PAYROLL — Calculate & Disburse Salary
// ═══════════════════════════════════════════════════════════════

// Calculate salary for a pay period (preview — does not save)
router.post('/payroll/calculate', authorize('owner'), (req, res) => {
  try {
    const db = getDb();
    const { user_id, period_start, period_end } = req.body;

    if (!user_id || !period_start || !period_end) {
      return res.status(400).json({ success: false, message: 'user_id, period_start and period_end are required.' });
    }

    const salary = db.prepare('SELECT * FROM employee_salaries WHERE user_id = ?').get(user_id);
    if (!salary) {
      return res.status(404).json({ success: false, message: 'No salary record found for this user.' });
    }

    const user = db.prepare('SELECT id, name, role, phone FROM users WHERE id = ?').get(user_id);

    // Count days in period
    const start = new Date(period_start + 'T00:00:00');
    const end = new Date(period_end + 'T00:00:00');
    const daysInPeriod = Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1;

    // Get attendance records for this period
    const attendance = db.prepare(`
      SELECT * FROM attendance
      WHERE user_id = ? AND date >= ? AND date <= ?
      ORDER BY date
    `).all(user_id, period_start, period_end);

    const uniqueByDate = new Map();
    for (const row of attendance) {
      const existing = uniqueByDate.get(row.date);
      if (!existing || (row.clock_in && row.clock_in > (existing.clock_in || ''))) {
        uniqueByDate.set(row.date, row);
      }
    }
    const uniqueAttendance = Array.from(uniqueByDate.values());
    const daysWorked = uniqueAttendance.filter(a => a.status === 'present' || a.status === 'half_day').length;
    const halfDays = uniqueAttendance.filter(a => a.status === 'half_day').length;
    const lateDays = uniqueAttendance.filter(a => a.late_arrival === 1).length;
    const totalHours = attendance.reduce((sum, a) => sum + (a.effective_hours || 0), 0);
    const shift = db.prepare(
      'SELECT shift_start, shift_end, shift_segments FROM employee_shifts WHERE user_id = ? AND is_active = 1 ORDER BY updated_at DESC, id DESC LIMIT 1'
    ).get(user_id);
    // includeInProgress explicitly OMITTED (defaults to false) — this is a
    // money-computation path. An in-progress OT figure changes on every
    // recomputation, which is fine for a live display but wrong to bake
    // into a disbursement amount; only a session's real, final clock_out
    // should ever count toward payroll.
    const shiftWork = computeShiftWork(attendance, shift || null, { includeInProgress: false });
    const leaveDays = uniqueAttendance.filter(a => a.status === 'on_leave').length;
    const absentDays = Math.max(0, daysInPeriod - daysWorked - leaveDays);

    // Calculate base pay
    let basePay = 0;
    if (salary.salary_type === 'monthly') {
      basePay = salary.monthly_salary;
    } else if (salary.salary_type === 'daily') {
      basePay = salary.monthly_salary * (daysWorked - (halfDays * 0.5));
    } else if (salary.salary_type === 'hourly') {
      basePay = salary.monthly_salary * totalHours;
    }

    // Calculate deductions for absences (monthly salary)
    let deductions = 0;
    if (salary.salary_type === 'monthly' && absentDays > leaveDays) {
      const perDayRate = salary.monthly_salary / 30;
      deductions = perDayRate * (absentDays - leaveDays);
    }

    // Get pending advances to deduct
    const advances = db.prepare(`
      SELECT * FROM salary_advances
      WHERE user_id = ? AND status = 'approved' AND repaid_amount < amount
    `).all(user_id);
    const pendingAdvances = advances.reduce((sum, a) => sum + (a.amount - a.repaid_amount), 0);

    const netAmount = Math.max(0, basePay - deductions);

    res.json({
      success: true,
      data: {
        user,
        salary_config: salary,
        period: { start: period_start, end: period_end, days: daysInPeriod },
        attendance_summary: {
          days_worked: daysWorked,
          half_days: halfDays,
          absent_days: absentDays,
          late_days: lateDays,
          leave_days: leaveDays,
          total_hours: Math.round(totalHours * 100) / 100,
          total_late_minutes: shiftWork.totalLateMinutes,
          overtime_minutes: shiftWork.totalOvertimeMinutes,
        },
        calculation: {
          base_pay: Math.round(basePay * 100) / 100,
          deductions: Math.round(deductions * 100) / 100,
          pending_advances: Math.round(pendingAdvances * 100) / 100,
          net_amount: Math.round(netAmount * 100) / 100,
        },
      },
    });
  } catch (error) {
    console.error('Calculate payroll error:', error);
    res.status(500).json({ success: false, message: 'Failed to calculate payroll.' });
  }
});

// Disburse salary (create payment record)
router.post('/payroll/disburse', authorize('owner'), (req, res) => {
  try {
    const db = getDb();
    const {
      user_id, period_start, period_end,
      base_salary, days_worked, days_in_period, hours_worked,
      late_days, absent_days, leaves_taken,
      deductions, bonus, net_amount,
      payment_method, payment_reference, notes,
    } = req.body;
    // advances_deducted is read separately below, after being capped —
    // never trust the client-computed value directly for a write that
    // marks real money as repaid.
    let advancesDeducted = Number(req.body.advances_deducted) || 0;

    if (!user_id || !period_start || !period_end || net_amount === undefined) {
      return res.status(400).json({ success: false, message: 'Missing required fields.' });
    }

    const existing = db.prepare(
      'SELECT id FROM salary_payments WHERE user_id = ? AND period_start = ? AND period_end = ? AND status != ?'
    ).get(user_id, period_start, period_end, 'cancelled');
    if (existing) {
      return res.status(400).json({ success: false, message: `Salary for this period was already recorded (payment #${existing.id}) — check Payroll History rather than disbursing again.` });
    }

    // Cap the advance deduction at what this payment can actually absorb —
    // SalaryManagementScreen already clamps net_amount to Math.max(0, ...)
    // but was still sending the FULL advances_deducted regardless, which
    // would mark an advance fully repaid even when only part of it was
    // really covered by this payment.
    advancesDeducted = Math.min(advancesDeducted, Number(net_amount) || 0);

    const method = payment_method || 'cash';

    // The disbursement also writes a linked expenses row (below) so it
    // shows up in financial reports and register reconciliation. That
    // write needs a real location only when cash is physically involved —
    // payroll itself has no location dimension (employee_salaries is
    // user-scoped), and requiring one for a bank/UPI transfer where no
    // physical drawer is touched would block a disbursement for no reason
    // tied to what's actually happening.
    let locationId = null;
    if (method === 'cash') {
      const employeeLocation = db.prepare(
        'SELECT location_id FROM user_locations WHERE user_id = ? ORDER BY is_primary DESC, id ASC LIMIT 1'
      ).get(user_id);
      locationId = employeeLocation ? employeeLocation.location_id : null;
      if (!locationId) {
        return res.status(400).json({ success: false, message: "This employee isn't assigned to a location yet — assign one before disbursing salary in cash." });
      }
      // Cash disbursements move real money out of the drawer, same as any
      // other cash expense — hard-blocked with no open register instead of
      // silently recording a payment no session's expected_cash accounts
      // for. Worded for what's actually happening here (paying OUT), not
      // the generic "taking a payment" wording other cash routes reuse.
      if (!hasOpenRegister(db, locationId)) {
        return res.status(400).json({ success: false, message: `The cash drawer isn't open at this employee's location — open the register first, or choose UPI/Bank if you're paying this by transfer.` });
      }
    } else {
      // Still attribute the expense to SOME location for reporting, even
      // without a register concern — best-effort, non-blocking.
      const employeeLocation = db.prepare(
        'SELECT location_id FROM user_locations WHERE user_id = ? ORDER BY is_primary DESC, id ASC LIMIT 1'
      ).get(user_id);
      locationId = employeeLocation ? employeeLocation.location_id : null;
    }

    const openRegister = (method === 'cash' && locationId)
      ? db.prepare('SELECT id FROM cash_registers WHERE location_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1').get(locationId)
      : null;

    const disburseTx = db.transaction(() => {
      let expenseId = null;
      // Write the expense FIRST (see this task's header note on why —
      // db.transaction() here does not provide real atomicity). Only when
      // a location is actually known — a disbursement can still proceed
      // with no expense-report linkage rather than blocking entirely on an
      // employee with no location assignment at all when paying by
      // transfer.
      if (locationId) {
        const payeeUser = db.prepare('SELECT name FROM users WHERE id = ?').get(user_id);
        const expenseResult = db.prepare(`
          INSERT INTO expenses (location_id, category, amount, description, payment_method, expense_date, created_by, employee_id, register_id)
          VALUES (?, 'salary', ?, ?, ?, ?, ?, ?, ?)
        `).run(
          locationId, net_amount,
          `Salary payment — ${payeeUser ? payeeUser.name : 'employee'} (${period_start} to ${period_end})`,
          method, todayStr(), req.user.id, user_id,
          openRegister ? openRegister.id : null
        );
        expenseId = expenseResult.lastInsertRowid;

        if (method === 'cash' && openRegister && Number(net_amount) > 0) {
          db.prepare('UPDATE cash_registers SET expected_cash = expected_cash - ? WHERE id = ?').run(net_amount, openRegister.id);
        }
      }

      const paymentResult = db.prepare(`
        INSERT INTO salary_payments (
          user_id, period_start, period_end, base_salary, days_worked, days_in_period,
          hours_worked, late_days, absent_days, leaves_taken, deductions,
          advances_deducted, bonus, net_amount, payment_method, payment_reference,
          status, paid_at, paid_by, notes, expense_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', CURRENT_TIMESTAMP, ?, ?, ?)
      `).run(
        user_id, period_start, period_end,
        base_salary || 0, days_worked || 0, days_in_period || 0,
        hours_worked || 0, late_days || 0, absent_days || 0, leaves_taken || 0,
        deductions || 0, advancesDeducted, bonus || 0, net_amount,
        method, payment_reference || '',
        req.user.id, notes || '', expenseId
      );
      const paymentId = paymentResult.lastInsertRowid;

      if (advancesDeducted > 0) {
        let remaining = advancesDeducted;
        const advances = db.prepare(
          'SELECT * FROM salary_advances WHERE user_id = ? AND status = ? AND repaid_amount < amount ORDER BY date'
        ).all(user_id, 'approved');
        for (const adv of advances) {
          if (remaining <= 0) break;
          const owed = adv.amount - adv.repaid_amount;
          const toDeduct = Math.min(owed, remaining);
          db.prepare('UPDATE salary_advances SET repaid_amount = repaid_amount + ?, status = CASE WHEN repaid_amount + ? >= amount THEN ? ELSE status END WHERE id = ?')
            .run(toDeduct, toDeduct, 'repaid', adv.id);
          remaining -= toDeduct;
        }
      }

      return paymentId;
    });

    const paymentId = disburseTx();
    const payment = db.prepare(`
      SELECT sp.*, u.name as user_name, u.role as user_role, p.name as paid_by_name
      FROM salary_payments sp
      JOIN users u ON sp.user_id = u.id
      LEFT JOIN users p ON sp.paid_by = p.id
      WHERE sp.id = ?
    `).get(paymentId);

    res.status(201).json({ success: true, data: payment });
  } catch (error) {
    console.error('Disburse salary error:', error);
    res.status(500).json({ success: false, message: 'Failed to disburse salary.' });
  }
});

// Get payment history
router.get('/payroll/history', authorize('owner', 'manager', 'employee', 'counter_staff', 'florist_staff', 'delivery_partner'), async (req, res) => {
  try {
    const db = await getAsyncDb();
    const { user_id, page = 1, limit = 20 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    let where = [];
    const params = [];

    if (req.user.role !== 'owner') {
      where.push('sp.user_id = ?');
      params.push(req.user.id);
    } else if (user_id) {
      where.push('sp.user_id = ?');
      params.push(Number(user_id));
    }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const total = (await db.prepare(`SELECT COUNT(*) as count FROM salary_payments sp ${whereClause}`).get(...params)).count;

    const payments = await db.prepare(`
      SELECT sp.*, u.name as user_name, u.role as user_role, p.name as paid_by_name
      FROM salary_payments sp
      JOIN users u ON sp.user_id = u.id
      LEFT JOIN users p ON sp.paid_by = p.id
      ${whereClause}
      ORDER BY sp.paid_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, Number(limit), offset);

    res.json({ success: true, data: { payments, total, page: Number(page), pages: Math.ceil(total / Number(limit)) } });
  } catch (error) {
    console.error('Get payroll history error:', error);
    res.status(500).json({ success: false, message: 'Failed to get payroll history.' });
  }
});

module.exports = router;
