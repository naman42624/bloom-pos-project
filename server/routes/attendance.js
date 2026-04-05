const express = require('express');
const router = express.Router();
const { getDb } = require('../config/database');
const { getDb: getAsyncDb } = require('../config/database-async');
const { authenticate, authorize } = require('../middleware/auth');
const { todayStr, nowLocal, parseServerDate } = require('../utils/time');

// All attendance routes require auth
router.use(authenticate);


// ─── Helper: Calculate hours between two ISO timestamps ──────
function hoursBetween(start, end) {
  const dStart = parseServerDate(start);
  const dEnd = parseServerDate(end);
  if (!dStart || !dEnd) return 0;
  return Math.max(0, (dEnd - dStart) / (1000 * 60 * 60));
}

// ─── Helper: Check if time is late based on shift OR operating hours ──
function isLateArrival(clockIn, operatingHours, userId, locationId) {
  if (!clockIn) return false;
  try {
    // clockIn is e.g. "2026-04-04T07:52:38+05:30"
    const clockTime = clockIn.split('T')[1].slice(0, 8); // "07:52:38"

    const db = getDb();
    const shift = db.prepare('SELECT shift_start FROM employee_shifts WHERE user_id = ? AND location_id = ? AND is_active = 1').get(userId, locationId);
    if (shift && shift.shift_start) {
      return clockTime > shift.shift_start;
    }

    // Fallback to location operating_hours
    if (!operatingHours) return false;
    const hours = safeParseJSON(operatingHours, {});
    const dayOfWeek = new Date(clockIn).toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
    const dayHours = hours[dayOfWeek];
    if (!dayHours || !dayHours.open) return false;
    return clockTime > dayHours.open;
  } catch {
    return false;
  }
}

// ─── Helper: Check early departure based on shift OR operating hours ──
function isEarlyDeparture(clockOut, operatingHours, userId, locationId) {
  if (!clockOut) return false;
  try {
    const clockTime = clockOut.split('T')[1].slice(0, 8); // "HH:mm:ss"

    const db = getDb();
    const shift = db.prepare('SELECT shift_end FROM employee_shifts WHERE user_id = ? AND location_id = ? AND is_active = 1').get(userId, locationId);
    if (shift && shift.shift_end) {
      return clockTime < shift.shift_end;
    }

    if (!operatingHours) return false;
    const hours = safeParseJSON(operatingHours, {});
    const dayOfWeek = new Date(clockOut).toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
    const dayHours = hours[dayOfWeek];
    if (!dayHours || !dayHours.close) return false;
    return clockTime < dayHours.close;
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
    // Legacy fallback: if user has no assignments at all, allow clock-in.
    if (req.user.role !== 'owner') {
      const assignmentCount = db.prepare('SELECT COUNT(*) as count FROM user_locations WHERE user_id = ?').get(userId).count;
      const assignment = db.prepare('SELECT id FROM user_locations WHERE user_id = ? AND location_id = ?').get(userId, location_id);
      if (assignmentCount > 0 && !assignment) {
        return res.status(403).json({ success: false, message: 'You are not assigned to this location.' });
      }
    }

    const today = todayStr();

    // Check if there's an unclosed record today (still clocked in)
    const unclosed = db.prepare('SELECT * FROM attendance WHERE user_id = ? AND date = ? AND clock_out IS NULL ORDER BY id DESC LIMIT 1').get(userId, today);
    if (unclosed) {
      return res.status(400).json({ success: false, message: 'Already clocked in. Please clock out first.' });
    }

    const now = nowLocal();
    const clockMethod = method || 'manual';
    const late = isLateArrival(now, location.operating_hours, userId, location_id) ? 1 : 0;

    // Always create a new attendance record (each clock-in/out is a separate log)
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
    // Find the most recent unclosed record for today
    const record = db.prepare(`
      SELECT a.*, l.operating_hours FROM attendance a
      JOIN locations l ON a.location_id = l.id
      WHERE a.user_id = ? AND a.date = ? AND a.clock_out IS NULL
      ORDER BY a.id DESC LIMIT 1
    `).get(userId, today);

    if (!record) {
      return res.status(400).json({ success: false, message: 'No active clock-in found. Please clock in first.' });
    }

    const now = nowLocal();
    const clockMethod = method || 'manual';
    const shiftHours = hoursBetween(record.clock_in, now);
    const early = isEarlyDeparture(now, record.operating_hours, userId, record.location_id) ? 1 : 0;

    // Calculate outdoor hours for this specific attendance record
    const outdoorHrs = db.prepare(`
      SELECT COALESCE(SUM(duration), 0) as total
      FROM outdoor_duty_requests
      WHERE user_id = ? AND attendance_id = ? AND status = 'completed'
    `).get(userId, record.id);

    const outdoor = outdoorHrs.total || 0;
    const effective = shiftHours + outdoor;

    db.prepare(`
      UPDATE attendance
      SET clock_out = ?, clock_out_method = ?, clock_out_latitude = ?, clock_out_longitude = ?,
          total_hours = ?, outdoor_hours = ?, effective_hours = ?, early_departure = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(now, clockMethod, latitude || null, longitude || null,
      Math.round(shiftHours * 100) / 100, Math.round(outdoor * 100) / 100,
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
router.get('/today', authorize('owner', 'manager', 'employee', 'delivery_partner'), async (req, res) => {
  try {
    const db = await getAsyncDb();
    const today = todayStr();

    // Get ALL attendance records for today (supports split shifts)
    const records = await db.prepare(`
      SELECT a.*, l.name as location_name
      FROM attendance a
      JOIN locations l ON a.location_id = l.id
      WHERE a.user_id = ? AND a.date = ?
      ORDER BY a.id ASC
    `).all(req.user.id, today);

    // The latest record is the "current" one for status display
    const current = records.length > 0 ? records[records.length - 1] : null;

    // Also get active outdoor duty from the current unclosed record
    let activeOutdoor = null;
    if (current && !current.clock_out) {
      activeOutdoor = await db.prepare(`
        SELECT * FROM outdoor_duty_requests
        WHERE user_id = ? AND attendance_id = ? AND status IN ('approved', 'requested')
        ORDER BY created_at DESC LIMIT 1
      `).get(req.user.id, current.id);
    }

    // Calculate total hours across all records today
    let totalHoursToday = 0;
    let totalOutdoorToday = 0;
    for (const r of records) {
      totalHoursToday += Number(r.total_hours) || 0;
      totalOutdoorToday += Number(r.outdoor_hours) || 0;
    }

    res.json({
      success: true,
      data: {
        attendance: current,
        logs: records,
        totalHoursToday: Math.round(totalHoursToday * 100) / 100,
        totalOutdoorToday: Math.round(totalOutdoorToday * 100) / 100,
        totalEffectiveToday: Math.round((totalHoursToday + totalOutdoorToday) * 100) / 100,
        activeOutdoor,
      },
    });
  } catch (error) {
    console.error('Get today attendance error:', error);
    res.status(500).json({ success: false, message: 'Failed to get attendance status.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET ATTENDANCE HISTORY (own or filtered)
// ═══════════════════════════════════════════════════════════════
router.get('/', authorize('owner', 'manager', 'employee', 'delivery_partner'), async (req, res) => {
  try {
    const db = await getAsyncDb();
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
      const locs = (await db.prepare('SELECT location_id FROM user_locations WHERE user_id = ?').all(req.user.id)).map(l => l.location_id);
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

    const total = (await db.prepare(`SELECT COUNT(*) as count FROM attendance a WHERE ${whereClause}`).get(...params)).count;

    const records = await db.prepare(`
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
router.get('/report', authorize('owner', 'manager'), async (req, res) => {
  try {
    const db = await getAsyncDb();
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
      const locs = (await db.prepare('SELECT location_id FROM user_locations WHERE user_id = ?').all(req.user.id)).map(l => l.location_id);
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
    const summary = await db.prepare(`
      SELECT
        a.user_id,
        u.name as user_name,
        u.role as user_role,
        COUNT(DISTINCT a.date) as total_days,
        COUNT(DISTINCT CASE WHEN a.status = 'present' THEN a.date END) as present_days,
        COUNT(DISTINCT CASE WHEN a.status = 'absent' THEN a.date END) as absent_days,
        COUNT(DISTINCT CASE WHEN a.status = 'half_day' THEN a.date END) as half_days,
        COUNT(DISTINCT CASE WHEN a.status = 'on_leave' THEN a.date END) as leave_days,
        COUNT(DISTINCT CASE WHEN a.late_arrival = 1 THEN a.date END) as late_count,
        COUNT(DISTINCT CASE WHEN a.early_departure = 1 THEN a.date END) as early_count,
        ROUND(SUM(a.total_hours), 2) as total_hours,
        ROUND(SUM(a.outdoor_hours), 2) as outdoor_hours,
        ROUND(SUM(a.effective_hours), 2) as effective_hours,
        ROUND(AVG(a.effective_hours), 2) as avg_hours_per_day
      FROM attendance a
      JOIN users u ON a.user_id = u.id
      WHERE ${whereClause}
      GROUP BY a.user_id, u.name, u.role
      ORDER BY u.name
    `).all(...params);

    // Daily breakdown
    const daily = await db.prepare(`
      SELECT
        a.date,
        COUNT(DISTINCT a.user_id) as staff_count,
        COUNT(DISTINCT CASE WHEN a.late_arrival = 1 THEN a.user_id END) as late_count,
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
    // Find the most recent unclosed attendance record for today
    const attendance = db.prepare('SELECT id FROM attendance WHERE user_id = ? AND date = ? AND clock_out IS NULL ORDER BY id DESC LIMIT 1').get(userId, today);

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
    const now = nowLocal();

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
      SET status = 'approved', approved_by = ?, start_time = COALESCE(start_time, ?)
      WHERE id = ?
    `).run(req.user.id, nowLocal(), request.id);

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

    const now = nowLocal();
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
        const effective = Number(att.total_hours || 0) + outdoor;
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
router.get('/outdoor-duty', authorize('owner', 'manager', 'employee', 'delivery_partner'), async (req, res) => {
  try {
    const db = await getAsyncDb();
    const { status, location_id, date } = req.query;

    let where = ['1=1'];
    const params = [];

    // Role-based scoping
    if (req.user.role === 'employee' || req.user.role === 'delivery_partner') {
      where.push('odr.user_id = ?');
      params.push(req.user.id);
    } else if (req.user.role === 'manager') {
      const locs = (await db.prepare('SELECT location_id FROM user_locations WHERE user_id = ?').all(req.user.id)).map(l => l.location_id);
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

    const requests = await db.prepare(`
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
router.get('/salary-advances', authorize('owner', 'manager', 'employee', 'delivery_partner'), async (req, res) => {
  try {
    const db = await getAsyncDb();
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

    const advances = await db.prepare(`
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
router.get('/staff-today', authorize('owner', 'manager'), async (req, res) => {
  try {
    const db = await getAsyncDb();
    const today = todayStr();
    const { location_id } = req.query;

    let locFilter = '';
    const params = [today];

    if (location_id) {
      locFilter = 'AND a.location_id = ?';
      params.push(Number(location_id));
    } else if (req.user.role === 'manager') {
      const locs = (await db.prepare('SELECT location_id FROM user_locations WHERE user_id = ?').all(req.user.id)).map(l => l.location_id);
      if (locs.length > 0) {
        locFilter = `AND a.location_id IN (${locs.map(() => '?').join(',')})`;
        params.push(...locs);
      }
    }

    // ─── OPTIMIZED: Fetch all active shifts in ONE query instead of subqueries ───
    const allShifts = new Map();
    const shiftsData = await db.prepare(`
      SELECT DISTINCT ON (user_id, location_id) user_id, location_id, shift_start, shift_end, days_of_week
      FROM employee_shifts
      WHERE is_active = 1
      ORDER BY user_id, location_id, updated_at DESC, id DESC
    `).all();
    for (const shift of shiftsData) {
      allShifts.set(`${shift.user_id}-${shift.location_id}`, shift);
    }

    const logs = await db.prepare(`
      SELECT
        a.*,
        u.name as user_name,
        u.phone as user_phone,
        u.role as user_role,
        l.name as location_name,
        es.shift_start,
        es.shift_end,
        es.days_of_week
      FROM attendance a
      JOIN users u ON a.user_id = u.id
      JOIN locations l ON a.location_id = l.id
      LEFT JOIN employee_shifts es ON es.user_id = a.user_id AND es.location_id = a.location_id AND es.is_active = 1
      WHERE a.date = ? ${locFilter}
      ORDER BY a.clock_in ASC, a.id ASC
    `).all(...params);

    // Merge in default shifts where not found
    for (const log of logs) {
      if (!log.shift_start && !log.shift_end) {
        const defaultShift = allShifts.get(`${log.user_id}-${log.location_id}`);
        if (defaultShift) {
          log.shift_start = defaultShift.shift_start;
          log.shift_end = defaultShift.shift_end;
          log.days_of_week = defaultShift.days_of_week;
        }
      }
    }

    // Aggregate split sessions so each staff appears exactly once.
    const byUser = new Map();
    for (const row of logs) {
      const key = row.user_id;
      const existing = byUser.get(key);

      if (!existing) {
        byUser.set(key, {
          id: row.id,
          user_id: row.user_id,
          user_name: row.user_name,
          user_phone: row.user_phone,
          user_role: row.user_role,
          location_id: row.location_id,
          location_name: row.location_name,
          date: row.date,
          first_clock_in: row.clock_in,
          latest_clock_in: row.clock_in,
          latest_clock_out: row.clock_out,
          clock_in: row.clock_in,
          clock_out: row.clock_out,
          total_hours: Number(row.total_hours || 0),
          outdoor_hours: Number(row.outdoor_hours || 0),
          effective_hours: Number(row.effective_hours || 0),
          late_arrival: row.late_arrival === 1 ? 1 : 0,
          early_departure: row.early_departure === 1 ? 1 : 0,
          sessions_count: 1,
          active_session: !row.clock_out,
          shift_start: row.shift_start || null,
          shift_end: row.shift_end || null,
          days_of_week: row.days_of_week || null,
          logs: [
            {
              id: row.id,
              location_id: row.location_id,
              location_name: row.location_name,
              clock_in: row.clock_in,
              clock_out: row.clock_out,
              total_hours: Number(row.total_hours || 0),
              outdoor_hours: Number(row.outdoor_hours || 0),
              effective_hours: Number(row.effective_hours || 0),
            },
          ],
        });
        continue;
      }

      existing.sessions_count += 1;
      existing.total_hours += Number(row.total_hours || 0);
      existing.outdoor_hours += Number(row.outdoor_hours || 0);
      existing.effective_hours += Number(row.effective_hours || 0);
      existing.late_arrival = existing.late_arrival || row.late_arrival === 1 ? 1 : 0;
      existing.early_departure = existing.early_departure || row.early_departure === 1 ? 1 : 0;
      if (row.clock_in < existing.first_clock_in) existing.first_clock_in = row.clock_in;
      if (row.clock_in >= existing.latest_clock_in) {
        existing.latest_clock_in = row.clock_in;
        existing.latest_clock_out = row.clock_out;
        existing.clock_in = row.clock_in;
        existing.clock_out = row.clock_out;
        existing.location_id = row.location_id;
        existing.location_name = row.location_name;
        if (row.shift_start || row.shift_end) {
          existing.shift_start = row.shift_start || null;
          existing.shift_end = row.shift_end || null;
          existing.days_of_week = row.days_of_week || null;
        }
      }
      if (!row.clock_out) {
        existing.active_session = true;
        existing.clock_in = row.clock_in;
        existing.clock_out = null;
        existing.location_id = row.location_id;
        existing.location_name = row.location_name;
      }

      existing.logs.push({
        id: row.id,
        location_id: row.location_id,
        location_name: row.location_name,
        clock_in: row.clock_in,
        clock_out: row.clock_out,
        total_hours: Number(row.total_hours || 0),
        outdoor_hours: Number(row.outdoor_hours || 0),
        effective_hours: Number(row.effective_hours || 0),
      });
    }

    const staff = Array.from(byUser.values()).map((s) => ({
      ...s,
      total_hours: Math.round(s.total_hours * 100) / 100,
      outdoor_hours: Math.round(s.outdoor_hours * 100) / 100,
      effective_hours: Math.round(s.effective_hours * 100) / 100,
    }));

    // Also get staff who haven't clocked in
    let notClockedFilter = '';
    const notParams = [];

    if (location_id) {
      notClockedFilter = 'AND ul.location_id = ?';
      notParams.push(Number(location_id));
    } else if (req.user.role === 'manager') {
      const locs = (await db.prepare('SELECT location_id FROM user_locations WHERE user_id = ?').all(req.user.id)).map(l => l.location_id);
      if (locs.length > 0) {
        notClockedFilter = `AND ul.location_id IN (${locs.map(() => '?').join(',')})`;
        notParams.push(...locs);
      }
    }

    const notClocked = await db.prepare(`
      SELECT DISTINCT
        u.id,
        u.name,
        u.phone,
        u.role,
        COALESCE(
          es.shift_start,
          (SELECT es2.shift_start FROM employee_shifts es2 WHERE es2.user_id = u.id AND es2.is_active = 1 ORDER BY es2.updated_at DESC, es2.id DESC LIMIT 1)
        ) as shift_start,
        COALESCE(
          es.shift_end,
          (SELECT es2.shift_end FROM employee_shifts es2 WHERE es2.user_id = u.id AND es2.is_active = 1 ORDER BY es2.updated_at DESC, es2.id DESC LIMIT 1)
        ) as shift_end,
        COALESCE(
          es.days_of_week,
          (SELECT es2.days_of_week FROM employee_shifts es2 WHERE es2.user_id = u.id AND es2.is_active = 1 ORDER BY es2.updated_at DESC, es2.id DESC LIMIT 1)
        ) as days_of_week
      FROM users u
      JOIN user_locations ul ON u.id = ul.user_id
      LEFT JOIN employee_shifts es ON es.user_id = u.id AND es.location_id = ul.location_id AND es.is_active = 1
      WHERE u.role IN ('employee', 'delivery_partner', 'manager') AND u.is_active = 1
      ${notClockedFilter}
      AND u.id NOT IN (SELECT user_id FROM attendance WHERE date = ?)
    `).all(...notParams, today);

    const active = staff.filter((s) => s.active_session);
    const completed = staff.filter((s) => !s.active_session);
    const late = staff.filter((s) => s.late_arrival === 1);

    res.json({
      success: true,
      data: {
        present: staff,
        active,
        completed,
        absent: notClocked,
        summary: {
          present_count: staff.length,
          active_count: active.length,
          completed_count: completed.length,
          absent_count: notClocked.length,
          late_count: late.length,
        },
      },
    });
  } catch (error) {
    console.error('Staff today error:', error);
    res.status(500).json({ success: false, message: 'Failed to get staff status.' });
  }
});

module.exports = router;
