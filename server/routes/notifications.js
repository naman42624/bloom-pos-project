const express = require('express');
const { getDb } = require('../config/database');
const { getDb: getAsyncDb } = require('../config/database-async');
const { authenticate } = require('../middleware/auth');
const { nowLocal } = require('../utils/time');

const router = express.Router();

// ─── Expo Push Notification Sender ───────────────────────────
async function sendExpoPush(tokens, title, body, data = {}) {
  if (!tokens || tokens.length === 0) return;

  const messages = tokens
    .filter((t) => t && t.startsWith('ExponentPushToken'))
    .map((token) => ({
      to: token,
      sound: 'default',
      title,
      body,
      data,
    }));

  if (messages.length === 0) return;

  try {
    const resp = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messages),
    });
    const result = await resp.json();
    return result;
  } catch (err) {
    console.error('Push notification error:', err.message);
  }
}

// ─── Notification Helper (used by other routes) ─────────────
/**
 * Create in-app notification and optionally send push.
 * @param {Object} opts
 * @param {number|number[]} opts.userIds - target users
 * @param {string} opts.title
 * @param {string} opts.body
 * @param {string} opts.type - e.g. 'order_status', 'low_stock', 'production', 'attendance', 'delivery'
 * @param {Object} opts.data - extra data (e.g. { saleId, screen })
 * @param {boolean} opts.sendPush - whether to also send push (default: true)
 */
async function createNotification({ userIds, title, body, type = 'general', data = {}, sendPush = true }) {
  try {
    const db = getDb();
    const ids = Array.isArray(userIds) ? userIds : [userIds];
    const dataStr = JSON.stringify(data);

    const insert = db.prepare(
      'INSERT INTO notifications (user_id, title, body, type, data, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    );

    const pushTokens = [];
    for (const uid of ids) {
      insert.run(uid, title, body, type, dataStr, nowLocal());
      if (sendPush) {
        const tokens = db.prepare('SELECT token FROM push_tokens WHERE user_id = ?').all(uid);
        pushTokens.push(...tokens.map((t) => t.token));
      }
    }

    if (sendPush && pushTokens.length > 0) {
      // Fire and forget — don't await in hot path
      sendExpoPush(pushTokens, title, body, data).then((result) => {
        if (result?.data) {
          // Push delivery receipt acknowledged; no DB write required.
        }
      });
    }
  } catch (err) {
    console.error('createNotification error:', err.message);
  }
}

// ─── Notify role-based users ─────────────────────────────────
/**
 * Send notification to all users with given role(s) at a specific location.
 * @param {Object} opts
 * @param {string|string[]} opts.roles - role(s) to notify
 * @param {number} [opts.locationId] - optional location filter
 * @param {string} opts.title
 * @param {string} opts.body
 * @param {string} opts.type
 * @param {Object} opts.data
 */
async function notifyByRole({ roles, locationId, title, body, type = 'general', data = {} }) {
  try {
    const db = getDb();
    const roleList = Array.isArray(roles) ? roles : [roles];

    let users;
    if (locationId) {
      users = db.prepare(
        `SELECT DISTINCT u.id FROM users u
         LEFT JOIN user_locations ul ON u.id = ul.user_id
         WHERE u.role IN (${roleList.map(() => '?').join(',')})
         AND u.is_active = 1
         AND (u.role = 'owner' OR ul.location_id = ?)`
      ).all(...roleList, locationId);
    } else {
      users = db.prepare(
        `SELECT id FROM users WHERE role IN (${roleList.map(() => '?').join(',')}) AND is_active = 1`
      ).all(...roleList);
    }

    if (users.length > 0) {
      await createNotification({
        userIds: users.map((u) => u.id),
        title,
        body,
        type,
        data,
      });
    }
  } catch (err) {
    console.error('notifyByRole error:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════

// ─── POST /api/notifications/register-token ──────────────────
router.post('/register-token', authenticate, (req, res) => {
  try {
    const db = getDb();
    const { token, platform } = req.body;
    if (!token) return res.status(400).json({ success: false, message: 'Token required' });

    db.prepare(
      'INSERT INTO push_tokens (user_id, token, platform) VALUES (?, ?, ?) ON CONFLICT (user_id, token) DO NOTHING'
    ).run(req.user.id, token, platform || 'expo');

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── DELETE /api/notifications/unregister-token ──────────────
router.delete('/unregister-token', authenticate, (req, res) => {
  try {
    const db = getDb();
    const { token } = req.body;
    if (token) {
      db.prepare('DELETE FROM push_tokens WHERE user_id = ? AND token = ?').run(req.user.id, token);
    } else {
      db.prepare('DELETE FROM push_tokens WHERE user_id = ?').run(req.user.id);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/notifications ─────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const db = await getAsyncDb();
    const { limit = 50, offset = 0, unread_only } = req.query;

    let sql = 'SELECT * FROM notifications WHERE user_id = ?';
    const params = [req.user.id];

    if (unread_only === '1' || unread_only === 'true') {
      sql += ' AND is_read = 0';
    }

    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const notifications = await db.prepare(sql).all(...params);
    const { count } = await db.prepare(
      'SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0'
    ).get(req.user.id);

    res.json({ success: true, data: { notifications, unread_count: count } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/notifications/unread-count ─────────────────────
router.get('/unread-count', authenticate, (req, res) => {
  try {
    // Use sync db for this simple count query (much faster than async overhead)
    const db = getDb();
    const result = db.prepare(
      'SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0'
    ).get(req.user.id);
    res.json({ success: true, data: { count: result?.count || 0 } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PUT /api/notifications/:id/read ─────────────────────────
router.put('/:id/read', authenticate, (req, res) => {
  try {
    const db = getDb();
    db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(
      req.params.id,
      req.user.id
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PUT /api/notifications/read-all ─────────────────────────
router.put('/read-all', authenticate, (req, res) => {
  try {
    const db = getDb();
    db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0').run(
      req.user.id
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
module.exports.createNotification = createNotification;
module.exports.notifyByRole = notifyByRole;
module.exports.sendExpoPush = sendExpoPush;
