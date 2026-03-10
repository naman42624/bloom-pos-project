const express = require('express');
const router = express.Router();
const { getDb } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);

// ─── Helper: Haversine distance in km ────────────────────────
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Helper: Today string ───────────────────────────────────
function todayStr() {
  return new Date().toISOString().split('T')[0];
}

// ═══════════════════════════════════════════════════════════════
// RECORD LOCATION (delivery partner sends GPS breadcrumb)
// ═══════════════════════════════════════════════════════════════
router.post('/location', authorize('delivery_partner'), (req, res) => {
  try {
    const db = getDb();
    const { latitude, longitude, accuracy, speed, heading, battery_level, delivery_id } = req.body;

    if (!latitude || !longitude) {
      return res.status(400).json({ success: false, message: 'latitude and longitude required.' });
    }

    const isMoving = (speed && speed > 0.5) ? 1 : 0;
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO delivery_locations (user_id, delivery_id, latitude, longitude, accuracy, speed, heading, battery_level, is_moving, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.user.id, delivery_id || null, latitude, longitude, accuracy || null, speed || null, heading || null, battery_level || null, isMoving, now);

    // Update daily summary
    const today = todayStr();
    let daily = db.prepare('SELECT * FROM delivery_partner_daily WHERE user_id = ? AND date = ?').get(req.user.id, today);

    if (!daily) {
      db.prepare('INSERT INTO delivery_partner_daily (user_id, date) VALUES (?, ?)').run(req.user.id, today);
      daily = db.prepare('SELECT * FROM delivery_partner_daily WHERE user_id = ? AND date = ?').get(req.user.id, today);
    }

    // Calculate distance from last known position
    const lastPos = db.prepare(`
      SELECT latitude, longitude FROM delivery_locations
      WHERE user_id = ? AND id != (SELECT MAX(id) FROM delivery_locations WHERE user_id = ?)
      ORDER BY id DESC LIMIT 1
    `).get(req.user.id, req.user.id);

    if (lastPos) {
      const dist = haversineKm(lastPos.latitude, lastPos.longitude, latitude, longitude);
      if (dist < 50) { // Ignore GPS jumps > 50km
        db.prepare('UPDATE delivery_partner_daily SET total_distance_km = total_distance_km + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(Math.round(dist * 1000) / 1000, daily.id);
      }
    }

    // Update idle/active time
    if (delivery_id) {
      db.prepare('UPDATE delivery_partner_daily SET total_active_minutes = total_active_minutes + 0.5, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(daily.id);
    } else {
      db.prepare('UPDATE delivery_partner_daily SET total_idle_minutes = total_idle_minutes + 0.5, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(daily.id);
    }

    res.json({ success: true, message: 'Location recorded.' });
  } catch (error) {
    console.error('Record location error:', error);
    res.status(500).json({ success: false, message: 'Failed to record location.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET ACTIVE DELIVERY PARTNERS (for live map — manager/owner)
// ═══════════════════════════════════════════════════════════════
router.get('/active-partners', authorize('owner', 'manager'), (req, res) => {
  try {
    const db = getDb();

    // Get ALL active delivery partners
    const allPartners = db.prepare(`
      SELECT u.id as user_id, u.name as user_name, u.phone, u.avatar
      FROM users u
      WHERE u.role = 'delivery_partner' AND u.is_active = 1
      ORDER BY u.name
    `).all();

    // Get latest position for each partner who has reported in last 30 min
    const recentLocations = db.prepare(`
      SELECT 
        dl.user_id, dl.latitude, dl.longitude, dl.speed, dl.heading, dl.battery_level,
        dl.is_moving, dl.recorded_at, dl.delivery_id
      FROM delivery_locations dl
      INNER JOIN (
        SELECT user_id, MAX(id) as max_id
        FROM delivery_locations
        WHERE recorded_at >= datetime('now', '-30 minutes')
        GROUP BY user_id
      ) latest ON dl.id = latest.max_id
    `).all();

    const locationMap = {};
    for (const loc of recentLocations) {
      locationMap[loc.user_id] = loc;
    }

    // Merge: all partners + their latest location if available
    const partners = allPartners.map(p => {
      const loc = locationMap[p.user_id];
      return {
        ...p,
        latitude: loc?.latitude || null,
        longitude: loc?.longitude || null,
        speed: loc?.speed || null,
        heading: loc?.heading || null,
        battery_level: loc?.battery_level || null,
        is_moving: loc?.is_moving || 0,
        recorded_at: loc?.recorded_at || null,
        delivery_id: loc?.delivery_id || null,
      };
    });

    res.json({ success: true, data: { partners } });
  } catch (error) {
    console.error('Get active partners error:', error);
    res.status(500).json({ success: false, message: 'Failed to get active partners.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET DELIVERY ROUTE (GPS breadcrumbs for a specific delivery)
// ═══════════════════════════════════════════════════════════════
router.get('/route/:deliveryId', authorize('owner', 'manager'), (req, res) => {
  try {
    const db = getDb();
    const points = db.prepare(`
      SELECT latitude, longitude, speed, heading, is_moving, recorded_at
      FROM delivery_locations
      WHERE delivery_id = ?
      ORDER BY recorded_at ASC
    `).all(req.params.deliveryId);

    // Calculate total distance
    let totalDistance = 0;
    for (let i = 1; i < points.length; i++) {
      totalDistance += haversineKm(points[i - 1].latitude, points[i - 1].longitude, points[i].latitude, points[i].longitude);
    }

    res.json({
      success: true,
      data: {
        points,
        total_distance_km: Math.round(totalDistance * 100) / 100,
        total_points: points.length,
      },
    });
  } catch (error) {
    console.error('Get route error:', error);
    res.status(500).json({ success: false, message: 'Failed to get route.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET DELIVERY PARTNER DAILY SUMMARY
// ═══════════════════════════════════════════════════════════════
router.get('/daily-summary', authorize('owner', 'manager', 'delivery_partner'), (req, res) => {
  try {
    const db = getDb();
    const { user_id, date, start_date, end_date } = req.query;

    let where = ['1=1'];
    const params = [];

    if (req.user.role === 'delivery_partner') {
      where.push('dpd.user_id = ?');
      params.push(req.user.id);
    } else if (user_id) {
      where.push('dpd.user_id = ?');
      params.push(Number(user_id));
    }

    if (date) {
      where.push('dpd.date = ?');
      params.push(date);
    } else {
      if (start_date) { where.push('dpd.date >= ?'); params.push(start_date); }
      if (end_date) { where.push('dpd.date <= ?'); params.push(end_date); }
    }

    const summaries = db.prepare(`
      SELECT dpd.*, u.name as user_name, u.phone as user_phone
      FROM delivery_partner_daily dpd
      JOIN users u ON dpd.user_id = u.id
      WHERE ${where.join(' AND ')}
      ORDER BY dpd.date DESC, u.name
    `).all(...params);

    res.json({ success: true, data: summaries });
  } catch (error) {
    console.error('Get daily summary error:', error);
    res.status(500).json({ success: false, message: 'Failed to get daily summary.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET LATEST POSITION (for a specific partner)
// ═══════════════════════════════════════════════════════════════
router.get('/latest/:userId', authorize('owner', 'manager'), (req, res) => {
  try {
    const db = getDb();
    const loc = db.prepare(`
      SELECT dl.*, d.delivery_address, d.customer_name, d.status as delivery_status
      FROM delivery_locations dl
      LEFT JOIN deliveries d ON dl.delivery_id = d.id
      WHERE dl.user_id = ?
      ORDER BY dl.recorded_at DESC LIMIT 1
    `).get(req.params.userId);

    res.json({ success: true, data: loc || null });
  } catch (error) {
    console.error('Get latest position error:', error);
    res.status(500).json({ success: false, message: 'Failed to get position.' });
  }
});

module.exports = router;
