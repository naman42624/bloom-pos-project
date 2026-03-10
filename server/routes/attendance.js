const express = require('express');
const router = express.Router();
const { getDb } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

// All attendance routes require auth
router.use(authenticate);

// ─── Helper: Get today's date string ─────────────────────────
function todayStr() {
  return new Date().toISOString().split('T')[0];
}

// ─── Helper: Calculate hours between two ISO timestamps ──────
function hoursBetween(start, end) {
  if (!start || !end) return 0;
  return Math.max(0, (new Date(end) - new Date(start)) / (1000 * 60 * 60));
}

// ─── Helper: Check if time is late based on shift OR operating hours ──
function isLateArrival(clockIn, operatingHours, userId, locationId) {
  if (!clockIn) return false;
  try {
    // First check employee_shifts for this user+location
    const db = getDb();
    const shift = db.prepare('SELECT * FROM employee_shifts WHERE user_id = ? AND location_id = ? AND is_active = 1').get(userId, locationId);
    if (shift) {
      const [shiftH, shiftM] = shift.shift_start.split(':').map(Number);
      const clockDate = new Date(clockIn);
      const shiftDate = new Date(clockDate);
      shiftDate.setHours(shiftH, shiftM, 0, 0);
      return clockDate > shiftDate;
    }
    // Fallback to location operating_hours
    if (!operatingHours) return false;
    const hours = JSON.parse(operatingHours);
    const dayOfWeek = new Date(clockIn).toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
    const dayHours = hours[dayOfWeek];
    if (!dayHours || !dayHours.open) return false;
    const [openH, openM] = dayHours.open.split(':').map(Number);
    const clockDate = new Date(clockIn);
    const openDate = new Date(clockDate);
    openDate.setHours(openH, openM, 0, 0);
    return clockDate > openDate;
  } catch {
    return false;
  }
}

// ─── Helper: Check early departure based on shift OR operating hours ──
function isEarlyDeparture(clockOut, operatingHours, userId, locationId) {
  if (!clockOut) return false;
  try {
    // First check employee_shifts
    const db = getDb();
    const shift = db.prepare('SELECT * FROM employee_shifts WHERE user_id = ? AND location_id = ? AND is_active = 1').get(userId, locationId);
    if (shift) {
      const [endH, endM] = shift.shift_end.split(':').map(Number);
      const clockDate = new Date(clockOut);
      const endDate = new Date(clockDate);
      endDate.setHours(endH, endM, 0, 0);
      return clockDate < endDate;
    }
    // Fallback to location operating_hours
    if (!operatingHours) return false;
    const hours = JSON.parse(operatingHours);
    const dayOfWeek = new Date(clockOut).toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
    const dayHours = hours[dayOfWeek];
    if (!dayHours || !dayHours.close) return false;
    const [closeH, closeM] = dayHours.close.split(':').map(Number);
    const clockDate = new Date(clockOut);
    const closeDate = new Date(clockDate);
    closeDate.setHours(closeH, closeM, 0, 0);
    return clockDate < closeDate;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// CLOCK IN
// ═══════════════════════════════════════════════════════════════
router.post('/clock-in', authorize('manager', 'employee', 'delivery_partner'), (req, res) => {
  try {
    const db = getDb();
    const userId = req.user.id;
    const { location_id, latitude, longitude, method } = req.body;

    if (!location_id) {
      return res.status(400).json({ success: false, message: 'Location is required.' });
    }

    const location = db.prepare('SELECT * FROM locations WHERE id = ? AND is_active = 1').get(location_id);
    if (!location) {
      return res.status(404).json({ success: false, message: 'Location not found.' });
    }

    // Check if user is assigned to this location (except owners)
    if (req.user.role !== 'owner') {
      const assignment = db.prepare('SELECT id FROM user_locations WHERE user_id = ? AND location_id = ?').get(userId, location_id);
      if (!assignment) {
        return res.status(403).json({ success: false, message: 'You are not assigned to this location.' });
      }
    }

    const today = todayStr();
    const existing = db.prepare('SELECT * FROM attendance WHERE user_id = ? AND date = ?').get(userId, today);

    if (existing && existing.clock_in && !existing.clock_out) {
      return res.status(400).json({ success: false, message: 'Already clocked in.' });
    }

    const now = new Date().toISOString();
    const clockMethod = method || 'manual';
    const late = isLateArrival(now, location.operating_hours, userId, location_id) ? 1 : 0;

    if (existing && existing.clock_out) {
      // Re-clocking in after clock out (second shift same day)
      db.prepare(`
        UPDATE attendance
        SET clock_in = ?, clock_in_method = ?, clock_in_latitude = ?, clock_in_longitude = ?,
            clock_out = NULL, clock_out_method = NULL, clock_out_latitude = NULL, clock_out_longitude = NULL,
            late_arrival = ?, status = 'present', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(now, clockMethod, latitude || null, longitude || null, late, existing.id);

      const updated = db.prepare('SELECT * FROM attendance WHERE id = ?').get(existing.id);
      return res.json({ success: true, data: updated });
    }

    // New attendance record
    const result = db.prepare(`
      INSERT INTO attendance (user_id, location_id, date, clock_in, clock_in_method, clock_in_latitude, clock_in_longitude, late_arrival, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'present')
    `).run(userId, location_id, today, now, clockMethod, latitude || null, longitude || null, late);

    const record = db.prepare('SELECT * FROM attendance WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ success: true, data: record });
  } catch (error) {
    console.error('Clock in error:', error);
    res.status(500).json({ success: false, message: 'Failed to clock in.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// CLOCK OUT
// ═══════════════════════════════════════════════════════════════
router.post('/clock-out', authorize('manager', 'employee', 'delivery_partner'), (req, res) => {
  try {
    const db = getDb();
    const userId = req.user.id;
    const { latitude, longitude, method } = req.body;

    const today = todayStr();
    const record = db.prepare('SELECT a.*, l.operating_hours FROM attendance a JOIN locations l ON a.location_id = l.id WHERE a.user_id = ? AND a.date = ?').get(userId, today);

    if (!record) {
      return res.status(400).json({ success: false, message: 'No clock-in record found for today.' });
    }

    if (record.clock_out) {
      return res.status(400).json({ success: false, message: 'Already clocked out.' });
    }

    const now = new Date().toISOString();
    const clockMethod = method || 'manual';
    const total = hoursBetween(record.clock_in, now);
    const early = isEarlyDeparture(now, record.operating_hours, userId, record.location_id) ? 1 : 0;

    // Calculate outdoor hours for today
    const outdoorHrs = db.prepare(`
      SELECT COALESCE(SUM(duration), 0) as total
      FROM outdoor_duty_requests
      WHERE user_id = ? AND attendance_id = ? AND status = 'completed'
    `).get(userId, record.id);

    const outdoor = outdoorHrs.total || 0;
    const effective = total + outdoor;

    db.prepare(`
      UPDATE attendance
      SET clock_out = ?, clock_out_method = ?, clock_out_latitude = ?, clock_out_longitude = ?,
          total_hours = ?, outdoor_hours = ?, effective_hours = ?, early_departure = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(now, clockMethod, latitude || null, longitude || null,
      Math.round(total * 100) / 100, Math.round(outdoor * 100) / 100,
      Math.round(effective * 100) / 100, early, record.id);

    const updated = db.prepare('SELECT * FROM attendance WHERE id = ?').get(record.id);
    res.json({ success: true, data: updated });
  } catch (error) {
    console.error('Clock out error:', error);
    res.status(500).json({ success: false, message: 'Failed to clock out.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET TODAY'S ATTENDANCE STATUS (for the logged-in user)
// ═══════════════════════════════════════════════════════════════
router.get('/today', authorize('owner', 'manager', 'employee', 'delivery_partner'), (req, res) => {
  try {
    const db = getDb();
    const today = todayStr();
    const record = db.prepare(`
      SELECT a.*, l.name as location_name
      FROM attendance a
      JOIN locations l ON a.location_id = l.id
      WHERE a.user_id = ? AND a.date = ?
    `).get(req.user.id, today);

    // Also get active outdoor duty
    let activeOutdoor = null;
    if (record) {
      activeOutdoor = db.prepare(`
        SELECT * FROM outdoor_duty_requests
        WHERE user_id = ? AND attendance_id = ? AND status IN ('approved', 'requested')
        ORDER BY created_at DESC LIMIT 1
      `).get(req.user.id, record.id);
    }

    res.json({ success: true, data: { attendance: record || null, activeOutdoor } });
  } catch (error) {
    console.error('Get today attendance error:', error);
    res.status(500).json({ success: false, message: 'Failed to get attendance status.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET ATTENDANCE HISTORY (own or filtered)
// ═══════════════════════════════════════════════════════════════
router.get('/', authorize('owner', 'manager', 'employee', 'delivery_partner'), (req, res) => {
  try {
    const db = getDb();
    const { user_id, location_id, start_date, end_date, page = 1, limit = 30 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    let where = ['1=1'];
    const params = [];

    // Role-based scoping
    if (req.user.role === 'employee' || req.user.role === 'delivery_partner') {
      where.push('a.user_id = ?');
      params.push(req.user.id);
    } else if (user_id) {
      where.push('a.user_id = ?');
      params.push(Number(user_id));
    }

    if (location_id) {
      where.push('a.location_id = ?');
      params.push(Number(location_id));
    } else if (req.user.role === 'manager') {
      // Scope to manager's assigned locations
      const locs = db.prepare('SELECT location_id FROM user_locations WHERE user_id = ?').all(req.user.id).map(l => l.location_id);
      if (locs.length > 0) {
        where.push(`a.location_id IN (${locs.map(() => '?').join(',')})`);
        params.push(...locs);
      }
    }

    if (start_date) {
      where.push('a.date >= ?');
      params.push(start_date);
    }
    if (end_date) {
      where.push('a.date <= ?');
      params.push(end_date);
    }

    const whereClause = where.join(' AND ');

    const total = db.prepare(`SELECT COUNT(*) as count FROM attendance a WHERE ${whereClause}`).get(...params).count;

    const records = db.prepare(`
      SELECT a.*, u.name as user_name, u.phone as user_phone, u.role as user_role, l.name as location_name
      FROM attendance a
      JOIN users u ON a.user_id = u.id
      JOIN locations l ON a.location_id = l.id
      WHERE ${whereClause}
      ORDER BY a.date DESC, a.clock_in DESC
      LIMIT ? OFFSET ?
    `).all(...params, Number(limit), offset);

    res.json({
      success: true,
      data: {
        attendance: records,
        total,
        page: Number(page),
        pages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (error) {
    console.error('Get attendance error:', error);
    res.status(500).json({ success: false, message: 'Failed to get attendance records.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// ATTENDANCE REPORT (summary by date range)
// ═══════════════════════════════════════════════════════════════
router.get('/report', authorize('owner', 'manager'), (req, res) => {
  try {
    const db = getDb();
    const { start_date, end_date, location_id, user_id } = req.query;

    if (!start_date || !end_date) {
      return res.status(400).json({ success: false, message: 'start_date and end_date are required.' });
    }

    let where = ['a.date >= ? AND a.date <= ?'];
    const params = [start_date, end_date];

    if (location_id) {
      where.push('a.location_id = ?');
      params.push(Number(location_id));
    } else if (req.user.role === 'manager') {
      const locs = db.prepare('SELECT location_id FROM user_locations WHERE user_id = ?').all(req.user.id).map(l => l.location_id);
      if (locs.length > 0) {
        where.push(`a.location_id IN (${locs.map(() => '?').join(',')})`);
        params.push(...locs);
      }
    }

    if (user_id) {
      where.push('a.user_id = ?');
      params.push(Number(user_id));
    }

    const whereClause = where.join(' AND ');

    // Per-employee summary
    const summary = db.prepare(`
      SELECT
        a.user_id,
        u.name as user_name,
        u.role as user_role,
        COUNT(DISTINCT a.date) as total_days,
        SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END) as present_days,
        SUM(CASE WHEN a.status = 'absent' THEN 1 ELSE 0 END) as absent_days,
        SUM(CASE WHEN a.status = 'half_day' THEN 1 ELSE 0 END) as half_days,
        SUM(CASE WHEN a.status = 'on_leave' THEN 1 ELSE 0 END) as leave_days,
        SUM(CASE WHEN a.late_arrival = 1 THEN 1 ELSE 0 END) as late_count,
        SUM(CASE WHEN a.early_departure = 1 THEN 1 ELSE 0 END) as early_count,
        ROUND(SUM(a.total_hours), 2) as total_hours,
        ROUND(SUM(a.outdoor_hours), 2) as outdoor_hours,
        ROUND(SUM(a.effective_hours), 2) as effective_hours,
        ROUND(AVG(a.effective_hours), 2) as avg_hours_per_day
      FROM attendance a
      JOIN users u ON a.user_id = u.id
      WHERE ${whereClause}
      GROUP BY a.user_id
      ORDER BY u.name
    `).all(...params);

    // Daily breakdown
    const daily = db.prepare(`
      SELECT
        a.date,
        COUNT(DISTINCT a.user_id) as staff_count,
        SUM(CASE WHEN a.late_arrival = 1 THEN 1 ELSE 0 END) as late_count,
        ROUND(AVG(a.effective_hours), 2) as avg_hours
      FROM attendance a
      WHERE ${whereClause}
      GROUP BY a.date
      ORDER BY a.date DESC
    `).all(...params);

    res.json({ success: true, data: { summary, daily } });
  } catch (error) {
    console.error('Attendance report error:', error);
    res.status(500).json({ success: false, message: 'Failed to generate report.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// OUTDOOR DUTY REQUEST
// ═══════════════════════════════════════════════════════════════
router.post('/outdoor-duty', authorize('owner', 'manager', 'employee', 'delivery_partner'), (req, res) => {
  try {
    const db = getDb();
    const userId = req.user.id;
    const { reason, location_id } = req.body;

    if (!reason || !reason.trim()) {
      return res.status(400).json({ success: false, message: 'Reason is required.' });
    }

    const today = todayStr();
    const attendance = db.prepare('SELECT id FROM attendance WHERE user_id = ? AND date = ?').get(userId, today);

    if (!attendance) {
      return res.status(400).json({ success: false, message: 'You must clock in first.' });
    }

    // Check for already active outdoor duty
    const active = db.prepare(`
      SELECT id FROM outdoor_duty_requests
      WHERE user_id = ? AND attendance_id = ? AND status IN ('requested', 'approved')
    `).get(userId, attendance.id);

    if (active) {
      return res.status(400).json({ success: false, message: 'You already have an active outdoor duty request.' });
    }

    const locId = location_id || db.prepare('SELECT location_id FROM attendance WHERE id = ?').get(attendance.id).location_id;
    const now = new Date().toISOString();

    const result = db.prepare(`
      INSERT INTO outdoor_duty_requests (attendance_id, user_id, location_id, reason, start_time, status)
      VALUES (?, ?, ?, ?, ?, 'requested')
    `).run(attendance.id, userId, locId, reason.trim(), now);

    const request = db.prepare(`
      SELECT odr.*, u.name as user_name
      FROM outdoor_duty_requests odr
      JOIN users u ON odr.user_id = u.id
      WHERE odr.id = ?
    `).get(result.lastInsertRowid);

    res.status(201).json({ success: true, data: request });
  } catch (error) {
    console.error('Outdoor duty request error:', error);
    res.status(500).json({ success: false, message: 'Failed to create outdoor duty request.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// APPROVE / REJECT OUTDOOR DUTY
// ═══════════════════════════════════════════════════════════════
router.put('/outdoor-duty/:id/approve', authorize('owner', 'manager'), (req, res) => {
  try {
    const db = getDb();
    const request = db.prepare('SELECT * FROM outdoor_duty_requests WHERE id = ?').get(req.params.id);

    if (!request) {
      return res.status(404).json({ success: false, message: 'Request not found.' });
    }

    if (request.status !== 'requested') {
      return res.status(400).json({ success: false, message: `Cannot approve a ${request.status} request.` });
    }

    db.prepare(`
      UPDATE outdoor_duty_requests
      SET status = 'approved', approved_by = ?, start_time = COALESCE(start_time, CURRENT_TIMESTAMP)
      WHERE id = ?
    `).run(req.user.id, request.id);

    const updated = db.prepare('SELECT * FROM outdoor_duty_requests WHERE id = ?').get(request.id);
    res.json({ success: true, data: updated });
  } catch (error) {
    console.error('Approve outdoor duty error:', error);
    res.status(500).json({ success: false, message: 'Failed to approve request.' });
  }
});

router.put('/outdoor-duty/:id/reject', authorize('owner', 'manager'), (req, res) => {
  try {
    const db = getDb();
    const request = db.prepare('SELECT * FROM outdoor_duty_requests WHERE id = ?').get(req.params.id);

    if (!request) {
      return res.status(404).json({ success: false, message: 'Request not found.' });
    }

    if (request.status !== 'requested') {
      return res.status(400).json({ success: false, message: `Cannot reject a ${request.status} request.` });
    }

    db.prepare("UPDATE outdoor_duty_requests SET status = 'rejected', approved_by = ? WHERE id = ?").run(req.user.id, request.id);

    const updated = db.prepare('SELECT * FROM outdoor_duty_requests WHERE id = ?').get(request.id);
    res.json({ success: true, data: updated });
  } catch (error) {
    console.error('Reject outdoor duty error:', error);
    res.status(500).json({ success: false, message: 'Failed to reject request.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// COMPLETE OUTDOOR DUTY (employee returns)
// ═══════════════════════════════════════════════════════════════
router.put('/outdoor-duty/:id/complete', authorize('owner', 'manager', 'employee', 'delivery_partner'), (req, res) => {
  try {
    const db = getDb();
    const request = db.prepare('SELECT * FROM outdoor_duty_requests WHERE id = ?').get(req.params.id);

    if (!request) {
      return res.status(404).json({ success: false, message: 'Request not found.' });
    }

    if (request.status !== 'approved' && request.status !== 'requested') {
      return res.status(400).json({ success: false, message: `Cannot complete a ${request.status} request.` });
    }

    // Only the requesting user or a manager/owner can complete
    if (request.user_id !== req.user.id && req.user.role !== 'owner' && req.user.role !== 'manager') {
      return res.status(403).json({ success: false, message: 'Not authorized.' });
    }

    const now = new Date().toISOString();
    const duration = hoursBetween(request.start_time, now);

    db.prepare(`
      UPDATE outdoor_duty_requests
      SET status = 'completed', end_time = ?, duration = ?
      WHERE id = ?
    `).run(now, Math.round(duration * 100) / 100, request.id);

    // Update attendance outdoor_hours
    if (request.attendance_id) {
      const totalOutdoor = db.prepare(`
        SELECT COALESCE(SUM(duration), 0) as total
        FROM outdoor_duty_requests
        WHERE attendance_id = ? AND status = 'completed'
      `).get(request.attendance_id);

      const att = db.prepare('SELECT * FROM attendance WHERE id = ?').get(request.attendance_id);
      if (att) {
        const outdoor = totalOutdoor.total || 0;
        const effective = att.total_hours + outdoor;
        db.prepare('UPDATE attendance SET outdoor_hours = ?, effective_hours = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(Math.round(outdoor * 100) / 100, Math.round(effective * 100) / 100, att.id);
      }
    }

    const updated = db.prepare('SELECT * FROM outdoor_duty_requests WHERE id = ?').get(request.id);
    res.json({ success: true, data: updated });
  } catch (error) {
    console.error('Complete outdoor duty error:', error);
    res.status(500).json({ success: false, message: 'Failed to complete outdoor duty.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// LIST OUTDOOR DUTY REQUESTS (for managers)
// ═══════════════════════════════════════════════════════════════
router.get('/outdoor-duty', authorize('owner', 'manager', 'employee', 'delivery_partner'), (req, res) => {
  try {
    const db = getDb();
    const { status, location_id, date } = req.query;

    let where = ['1=1'];
    const params = [];

    // Role-based scoping
    if (req.user.role === 'employee' || req.user.role === 'delivery_partner') {
      where.push('odr.user_id = ?');
      params.push(req.user.id);
    } else if (req.user.role === 'manager') {
      const locs = db.prepare('SELECT location_id FROM user_locations WHERE user_id = ?').all(req.user.id).map(l => l.location_id);
      if (locs.length > 0) {
        where.push(`odr.location_id IN (${locs.map(() => '?').join(',')})`);
        params.push(...locs);
      }
    }

    if (status) {
      where.push('odr.status = ?');
      params.push(status);
    }
    if (location_id) {
      where.push('odr.location_id = ?');
      params.push(Number(location_id));
    }
    if (date) {
      where.push('DATE(odr.created_at) = ?');
      params.push(date);
    }

    const requests = db.prepare(`
      SELECT odr.*, u.name as user_name, u.phone as user_phone, l.name as location_name,
             a.name as approver_name
      FROM outdoor_duty_requests odr
      JOIN users u ON odr.user_id = u.id
      JOIN locations l ON odr.location_id = l.id
      LEFT JOIN users a ON odr.approved_by = a.id
      WHERE ${where.join(' AND ')}
      ORDER BY odr.created_at DESC
    `).all(...params);

    res.json({ success: true, data: requests });
  } catch (error) {
    console.error('List outdoor duty error:', error);
    res.status(500).json({ success: false, message: 'Failed to list requests.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// SALARY ADVANCES
// ═══════════════════════════════════════════════════════════════

// Request advance
router.post('/salary-advance', authorize('owner', 'manager', 'employee', 'delivery_partner'), (req, res) => {
  try {
    const db = getDb();
    const { amount, reason } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Valid amount is required.' });
    }

    const result = db.prepare(`
      INSERT INTO salary_advances (user_id, amount, reason, date)
      VALUES (?, ?, ?, ?)
    `).run(req.user.id, amount, reason || '', todayStr());

    const advance = db.prepare(`
      SELECT sa.*, u.name as user_name
      FROM salary_advances sa
      JOIN users u ON sa.user_id = u.id
      WHERE sa.id = ?
    `).get(result.lastInsertRowid);

    res.status(201).json({ success: true, data: advance });
  } catch (error) {
    console.error('Salary advance request error:', error);
    res.status(500).json({ success: false, message: 'Failed to request advance.' });
  }
});

// List advances
router.get('/salary-advances', authorize('owner', 'manager', 'employee', 'delivery_partner'), (req, res) => {
  try {
    const db = getDb();
    const { user_id, status } = req.query;

    let where = ['1=1'];
    const params = [];

    if (req.user.role === 'employee' || req.user.role === 'delivery_partner') {
      where.push('sa.user_id = ?');
      params.push(req.user.id);
    } else if (user_id) {
      where.push('sa.user_id = ?');
      params.push(Number(user_id));
    }

    if (status) {
      where.push('sa.status = ?');
      params.push(status);
    }

    const advances = db.prepare(`
      SELECT sa.*, u.name as user_name, u.phone as user_phone,
             a.name as approver_name
      FROM salary_advances sa
      JOIN users u ON sa.user_id = u.id
      LEFT JOIN users a ON sa.approved_by = a.id
      WHERE ${where.join(' AND ')}
      ORDER BY sa.created_at DESC
    `).all(...params);

    res.json({ success: true, data: advances });
  } catch (error) {
    console.error('List salary advances error:', error);
    res.status(500).json({ success: false, message: 'Failed to list advances.' });
  }
});

// Mark advance repaid (must be before /:action route)
router.put('/salary-advance/:id/repay', authorize('owner', 'manager'), (req, res) => {
  try {
    const db = getDb();
    const { amount } = req.body;
    const advance = db.prepare('SELECT * FROM salary_advances WHERE id = ?').get(req.params.id);

    if (!advance) {
      return res.status(404).json({ success: false, message: 'Advance not found.' });
    }

    if (advance.status !== 'approved') {
      return res.status(400).json({ success: false, message: 'Only approved advances can be repaid.' });
    }

    const repayAmount = amount || advance.amount;
    const newRepaid = advance.repaid_amount + repayAmount;
    const newStatus = newRepaid >= advance.amount ? 'repaid' : 'approved';

    db.prepare('UPDATE salary_advances SET repaid_amount = ?, status = ? WHERE id = ?')
      .run(Math.min(newRepaid, advance.amount), newStatus, advance.id);

    const updated = db.prepare('SELECT * FROM salary_advances WHERE id = ?').get(advance.id);
    res.json({ success: true, data: updated });
  } catch (error) {
    console.error('Repay advance error:', error);
    res.status(500).json({ success: false, message: 'Failed to record repayment.' });
  }
});

// Approve/reject advance
router.put('/salary-advance/:id/:action', authorize('owner', 'manager'), (req, res) => {
  try {
    const db = getDb();
    const { id, action } = req.params;

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ success: false, message: 'Invalid action.' });
    }

    const advance = db.prepare('SELECT * FROM salary_advances WHERE id = ?').get(id);
    if (!advance) {
      return res.status(404).json({ success: false, message: 'Advance not found.' });
    }

    if (advance.status !== 'pending') {
      return res.status(400).json({ success: false, message: `Cannot ${action} a ${advance.status} advance.` });
    }

    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    db.prepare('UPDATE salary_advances SET status = ?, approved_by = ? WHERE id = ?')
      .run(newStatus, req.user.id, id);

    const updated = db.prepare(`
      SELECT sa.*, u.name as user_name, a.name as approver_name
      FROM salary_advances sa
      JOIN users u ON sa.user_id = u.id
      LEFT JOIN users a ON sa.approved_by = a.id
      WHERE sa.id = ?
    `).get(id);

    res.json({ success: true, data: updated });
  } catch (error) {
    console.error('Approve/reject advance error:', error);
    res.status(500).json({ success: false, message: `Failed to ${req.params.action} advance.` });
  }
});

// ═══════════════════════════════════════════════════════════════
// STAFF DUTY SUMMARY (today's attendance for all staff)
// ═══════════════════════════════════════════════════════════════
router.get('/staff-today', authorize('owner', 'manager'), (req, res) => {
  try {
    const db = getDb();
    const today = todayStr();
    const { location_id } = req.query;

    let locFilter = '';
    const params = [today];

    if (location_id) {
      locFilter = 'AND a.location_id = ?';
      params.push(Number(location_id));
    } else if (req.user.role === 'manager') {
      const locs = db.prepare('SELECT location_id FROM user_locations WHERE user_id = ?').all(req.user.id).map(l => l.location_id);
      if (locs.length > 0) {
        locFilter = `AND a.location_id IN (${locs.map(() => '?').join(',')})`;
        params.push(...locs);
      }
    }

    const staff = db.prepare(`
      SELECT a.*, u.name as user_name, u.phone as user_phone, u.role as user_role, l.name as location_name
      FROM attendance a
      JOIN users u ON a.user_id = u.id
      JOIN locations l ON a.location_id = l.id
      WHERE a.date = ? ${locFilter}
      ORDER BY a.clock_in ASC
    `).all(...params);

    // Also get staff who haven't clocked in
    let notClockedFilter = '';
    const notParams = [];

    if (location_id) {
      notClockedFilter = 'AND ul.location_id = ?';
      notParams.push(Number(location_id));
    } else if (req.user.role === 'manager') {
      const locs = db.prepare('SELECT location_id FROM user_locations WHERE user_id = ?').all(req.user.id).map(l => l.location_id);
      if (locs.length > 0) {
        notClockedFilter = `AND ul.location_id IN (${locs.map(() => '?').join(',')})`;
        notParams.push(...locs);
      }
    }

    const notClocked = db.prepare(`
      SELECT DISTINCT u.id, u.name, u.phone, u.role
      FROM users u
      JOIN user_locations ul ON u.id = ul.user_id
      WHERE u.role IN ('employee', 'delivery_partner', 'manager') AND u.is_active = 1
      ${notClockedFilter}
      AND u.id NOT IN (SELECT user_id FROM attendance WHERE date = ?)
    `).all(...notParams, today);

    res.json({ success: true, data: { present: staff, absent: notClocked } });
  } catch (error) {
    console.error('Staff today error:', error);
    res.status(500).json({ success: false, message: 'Failed to get staff status.' });
  }
});

module.exports = router;
