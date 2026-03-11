const express = require('express');
const router = express.Router();
const { getDb } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);

// ═══════════════════════════════════════════════════════════════
// EMPLOYEE SHIFTS / SCHEDULES
// ═══════════════════════════════════════════════════════════════

// Get shift for a specific user (or all shifts)
router.get('/shifts', authorize('owner', 'manager', 'employee', 'delivery_partner'), (req, res) => {
  try {
    const db = getDb();
    const { user_id, location_id } = req.query;

    // Employees/DP can only see their own shift
    if (req.user.role === 'employee' || req.user.role === 'delivery_partner') {
      const shifts = db.prepare(`
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
      const locs = db.prepare('SELECT location_id FROM user_locations WHERE user_id = ?').all(req.user.id).map(l => l.location_id);
      if (locs.length > 0) {
        where.push(`es.location_id IN (${locs.map(() => '?').join(',')})`);
        params.push(...locs);
      }
    }

    const shifts = db.prepare(`
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
router.get('/salaries', authorize('owner', 'manager', 'employee', 'delivery_partner'), (req, res) => {
  try {
    const db = getDb();

    if (req.user.role === 'owner') {
      // Owner sees all staff salaries
      const salaries = db.prepare(`
        SELECT es.*, u.name as user_name, u.phone as user_phone, u.role as user_role,
               up.name as updater_name
        FROM employee_salaries es
        JOIN users u ON es.user_id = u.id
        LEFT JOIN users up ON es.updated_by = up.id
        WHERE u.role IN ('manager', 'employee', 'delivery_partner') AND u.is_active = 1
        ORDER BY u.name
      `).all();

      // Also get users without salary records
      const usersWithout = db.prepare(`
        SELECT u.id, u.name, u.phone, u.role
        FROM users u
        WHERE u.role IN ('manager', 'employee', 'delivery_partner') AND u.is_active = 1
        AND u.id NOT IN (SELECT user_id FROM employee_salaries)
        ORDER BY u.name
      `).all();

      return res.json({ success: true, data: { salaries, unset: usersWithout } });
    }

    // Staff sees only their own
    const salary = db.prepare(`
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
router.get('/salaries/:userId/history', authorize('owner'), (req, res) => {
  try {
    const db = getDb();
    const history = db.prepare(`
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

// Record geofence enter/exit event
router.post('/geofence-event', authorize('manager', 'employee', 'delivery_partner'), (req, res) => {
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

    // If enter event → auto clock-in
    if (event_type === 'enter') {
      const n = new Date();
      const today = `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;
      const existing = db.prepare('SELECT * FROM attendance WHERE user_id = ? AND date = ?').get(req.user.id, today);

      if (!existing || (existing.clock_out && !existing.clock_in)) {
        // Auto clock-in
        const now = new Date().toISOString();
        const shift = db.prepare('SELECT * FROM employee_shifts WHERE user_id = ? AND location_id = ? AND is_active = 1').get(req.user.id, location_id);
        let late = 0;
        if (shift) {
          const [shiftH, shiftM] = shift.shift_start.split(':').map(Number);
          const clockDate = new Date(now);
          const shiftDate = new Date(clockDate);
          shiftDate.setHours(shiftH, shiftM, 0, 0);
          late = clockDate > shiftDate ? 1 : 0;
        }

        if (!existing) {
          db.prepare(`
            INSERT INTO attendance (user_id, location_id, date, clock_in, clock_in_method, clock_in_latitude, clock_in_longitude, late_arrival, status)
            VALUES (?, ?, ?, ?, 'auto_geofence', ?, ?, ?, 'present')
          `).run(req.user.id, location_id, today, now, latitude || null, longitude || null, late);
        } else {
          db.prepare(`
            UPDATE attendance SET clock_in = ?, clock_in_method = 'auto_geofence', clock_in_latitude = ?, clock_in_longitude = ?,
            clock_out = NULL, clock_out_method = NULL, late_arrival = ?, status = 'present', updated_at = CURRENT_TIMESTAMP WHERE id = ?
          `).run(now, latitude || null, longitude || null, late, existing.id);
        }

        db.prepare('UPDATE geofence_events SET processed = 1, auto_action = ? WHERE id = ?').run('clock_in', event.id);
        return res.json({ success: true, data: event, action: 'auto_clock_in' });
      }
    }

    // If exit event → mark for potential auto clock-out (handled by server cron)
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

    const daysWorked = attendance.filter(a => a.status === 'present' || a.status === 'half_day').length;
    const halfDays = attendance.filter(a => a.status === 'half_day').length;
    const lateDays = attendance.filter(a => a.late_arrival === 1).length;
    const totalHours = attendance.reduce((sum, a) => sum + (a.effective_hours || 0), 0);
    const absentDays = daysInPeriod - daysWorked;
    const leaveDays = attendance.filter(a => a.status === 'on_leave').length;

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
      deductions, advances_deducted, bonus, net_amount,
      payment_method, payment_reference, notes,
    } = req.body;

    if (!user_id || !period_start || !period_end || net_amount === undefined) {
      return res.status(400).json({ success: false, message: 'Missing required fields.' });
    }

    // Check for duplicate payment for same period
    const existing = db.prepare(
      'SELECT id FROM salary_payments WHERE user_id = ? AND period_start = ? AND period_end = ? AND status != ?'
    ).get(user_id, period_start, period_end, 'cancelled');
    if (existing) {
      return res.status(400).json({ success: false, message: 'Payment already exists for this period.' });
    }

    const disburseTx = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO salary_payments (
          user_id, period_start, period_end, base_salary, days_worked, days_in_period,
          hours_worked, late_days, absent_days, leaves_taken, deductions,
          advances_deducted, bonus, net_amount, payment_method, payment_reference,
          status, paid_at, paid_by, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', CURRENT_TIMESTAMP, ?, ?)
      `).run(
        user_id, period_start, period_end,
        base_salary || 0, days_worked || 0, days_in_period || 0,
        hours_worked || 0, late_days || 0, absent_days || 0, leaves_taken || 0,
        deductions || 0, advances_deducted || 0, bonus || 0, net_amount,
        payment_method || 'cash', payment_reference || '',
        req.user.id, notes || ''
      );

      // Deduct advances if specified
      if (advances_deducted && advances_deducted > 0) {
        let remaining = advances_deducted;
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

      return result.lastInsertRowid;
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
router.get('/payroll/history', authorize('owner', 'manager', 'employee', 'delivery_partner'), (req, res) => {
  try {
    const db = getDb();
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

    const total = db.prepare(`SELECT COUNT(*) as count FROM salary_payments sp ${whereClause}`).get(...params).count;

    const payments = db.prepare(`
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
