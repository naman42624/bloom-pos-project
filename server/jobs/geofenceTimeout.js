/**
 * Geofence Timeout Worker
 *
 * Checks for employees who left the geofence and auto-clocks them out
 * after the configured timeout period, unless they returned or have
 * an active outdoor duty request.
 */

const { geofenceQueue } = require('./queue');

function register() {
  let getDb;
  try {
    ({ getDb } = require('../config/database'));
  } catch (e) {
    console.error('Failed to load database for geofence worker:', e.message);
    return;
  }

  geofenceQueue.process('check', async (_job) => {
    const db = getDb();
    const n = new Date();
    const today = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
    let autoClockOuts = 0;

    // Find unprocessed exit events older than the employee's timeout
    const exitEvents = db.prepare(`
      SELECT ge.*, es.geofence_timeout_minutes,
             a.id as attendance_id, a.clock_in, a.clock_out
      FROM geofence_events ge
      JOIN employee_shifts es ON ge.user_id = es.user_id AND ge.location_id = es.location_id AND es.is_active = 1
      LEFT JOIN attendance a ON a.user_id = ge.user_id AND a.date = ?
      WHERE ge.event_type = 'exit' AND ge.processed = 0
      AND datetime(ge.created_at, '+' || es.geofence_timeout_minutes || ' minutes') <= datetime('now')
      AND a.clock_in IS NOT NULL AND a.clock_out IS NULL
    `).all(today);

    for (const event of exitEvents) {
      // Check if there's a more recent enter event
      const reenter = db.prepare(`
        SELECT id FROM geofence_events
        WHERE user_id = ? AND location_id = ? AND event_type = 'enter'
        AND created_at > ?
        LIMIT 1
      `).get(event.user_id, event.location_id, event.created_at);

      if (reenter) {
        db.prepare('UPDATE geofence_events SET processed = 1, auto_action = ? WHERE id = ?')
          .run('cancelled_returned', event.id);
        continue;
      }

      // Check for active outdoor duty
      const activeOutdoor = db.prepare(`
        SELECT id FROM outdoor_duty_requests
        WHERE user_id = ? AND attendance_id = ? AND status IN ('approved', 'requested')
      `).get(event.user_id, event.attendance_id);

      if (activeOutdoor) continue;

      // Auto clock-out
      const now = new Date().toISOString();
      const clockIn = event.clock_in;
      const totalHours = clockIn
        ? Math.max(0, (new Date(now) - new Date(clockIn)) / (1000 * 60 * 60))
        : 0;
      const roundedHours = Math.round(totalHours * 100) / 100;

      db.prepare(`
        UPDATE attendance SET clock_out = ?, clock_out_method = 'auto_timeout',
        total_hours = ?, effective_hours = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(now, roundedHours, roundedHours, event.attendance_id);

      db.prepare('UPDATE geofence_events SET processed = 1, auto_action = ? WHERE id = ?')
        .run('auto_clock_out', event.id);

      autoClockOuts++;
      console.log(`⏰ Auto clock-out: user ${event.user_id} after ${event.geofence_timeout_minutes}min timeout`);
    }

    return { autoClockOuts, timestamp: new Date().toISOString() };
  });

  geofenceQueue.on('failed', (job, err) => {
    console.error(`❌ Geofence timeout job ${job.id} failed:`, err.message);
  });
}

module.exports = { register };
