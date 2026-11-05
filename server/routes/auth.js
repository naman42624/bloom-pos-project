const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const { getDb } = require('../config/database');
const { getDb: getAsyncDb } = require('../config/database-async');
const { authenticate } = require('../middleware/auth');
const { refuseIfExpired, HELPER_NO_PASSWORD_COPY } = require('../utils/helper-access');
const { publicUser } = require('../utils/public-user');

const router = express.Router();

const USER_SELECT_FIELDS =
  'id, phone, email, name, role, avatar, bio, is_active, created_at, updated_at';

/**
 * Generate JWT token
 */
function generateToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

// ─── POST /api/auth/register ─────────────────────────────────
// Customer self-registration
router.post(
  '/register',
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('phone')
      .trim()
      .notEmpty()
      .withMessage('Phone number is required')
      .matches(/^[6-9]\d{9}$/)
      .withMessage('Enter a valid 10-digit Indian mobile number'),
    body('email')
      .optional({ nullable: true, checkFalsy: true })
      .isEmail()
      .normalizeEmail()
      .withMessage('Enter a valid email'),
    body('password')
      .isLength({ min: 6 })
      .withMessage('Password must be at least 6 characters'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Validation failed',
          errors: errors.array(),
        });
      }

      const { name, phone, email, password } = req.body;
      const db = getDb();

      // Check if phone already exists
      const existing = db
        .prepare('SELECT id, role, created_by FROM users WHERE phone = ?')
        .get(phone);

      if (existing) {
        // Allow customers created by admin (created_by IS NOT NULL) to claim their account
        if (existing.role === 'customer' && existing.created_by != null) {
          const salt = await bcrypt.genSalt(12);
          const hashedPassword = await bcrypt.hash(password, salt);
          db.prepare(
            'UPDATE users SET name = ?, password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
          ).run(name, hashedPassword, existing.id);

          const user = db
            .prepare('SELECT ' + USER_SELECT_FIELDS + ' FROM users WHERE id = ?')
            .get(existing.id);
          const token = generateToken(user);
          return res.status(200).json({
            success: true,
            message: 'Account claimed successfully',
            data: { user: publicUser(user), token },
          });
        }

        return res.status(409).json({
          success: false,
          message: 'An account with this phone number already exists',
        });
      }

      // Check email uniqueness if provided
      if (email) {
        const existingEmail = db
          .prepare('SELECT id FROM users WHERE email = ?')
          .get(email);
        if (existingEmail) {
          return res.status(409).json({
            success: false,
            message: 'An account with this email already exists',
          });
        }
      }

      const salt = await bcrypt.genSalt(12);
      const hashedPassword = await bcrypt.hash(password, salt);

      const result = db
        .prepare(
          'INSERT INTO users (name, phone, email, password, role) VALUES (?, ?, ?, ?, ?)'
        )
        .run(name, phone, email || null, hashedPassword, 'customer');

      const user = db
        .prepare('SELECT ' + USER_SELECT_FIELDS + ' FROM users WHERE id = ?')
        .get(result.lastInsertRowid);

      const token = generateToken(user);

      res.status(201).json({
        success: true,
        message: 'Account created successfully',
        data: { user: publicUser(user), token },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ─── POST /api/auth/login ────────────────────────────────────
router.post(
  '/login',
  [
    body('phone')
      .trim()
      .notEmpty()
      .withMessage('Phone number is required')
      .matches(/^[6-9]\d{9}$/)
      .withMessage('Enter a valid 10-digit mobile number'),
    body('password').notEmpty().withMessage('Password is required'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Validation failed',
          errors: errors.array(),
        });
      }

      const { phone, password } = req.body;
      const db = await getAsyncDb();

      const user = await db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);

      if (!user) {
        return res.status(401).json({
          success: false,
          message: 'Invalid phone number or password',
        });
      }

      if (!user.is_active) {
        return res.status(403).json({
          success: false,
          message: 'Your account has been deactivated. Contact your manager.',
        });
      }

      const isValidPassword = await bcrypt.compare(password, user.password);

      if (!isValidPassword) {
        return res.status(401).json({
          success: false,
          message: 'Invalid phone number or password',
        });
      }

      if (user.role === 'helper') {
        return res.status(401).json({ success: false, message: HELPER_NO_PASSWORD_COPY });
      }

      const expiredMsg = refuseIfExpired(user);
      if (expiredMsg) {
        return res.status(401).json({ success: false, message: expiredMsg });
      }

      const token = generateToken(user);


      // Get assigned locations
      const locations = await db
        .prepare(
          'SELECT l.id, l.name, l.type, l.latitude, l.longitude, l.geofence_radius, ul.is_primary FROM locations l JOIN user_locations ul ON ul.location_id = l.id WHERE ul.user_id = ? AND l.is_active = 1'
        )
        .all(user.id);

      res.json({
        success: true,
        message: 'Login successful',
        data: {
          user: publicUser(user),
          token,
          locations,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ─── POST /api/auth/staff-login ──────────────────────────────
// Employee code + PIN login for the shared counter device.
const { hashPin } = require('../utils/pin');
const { checkCodeAndPin } = require('../utils/approval-pin');
// Owner and manager are left out on purpose: their approval PIN approves
// helper discounts only and never signs anyone in on a counter device.
const STAFF_LOGIN_ROLES = ['employee', 'counter_staff', 'florist_staff', 'helper'];

router.post(
  '/staff-login',
  [
    body('employee_code').trim().notEmpty().withMessage('Employee code is required'),
    body('pin').trim().isLength({ min: 4, max: 4 }).withMessage('Enter your 4-digit PIN'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      }

      const { employee_code, pin } = req.body;
      const db = await getAsyncDb();

      let user;
      try {
        user = await checkCodeAndPin(db, employee_code, pin, {
          roles: STAFF_LOGIN_ROLES,
          wrongPinMessage: (left) => `Wrong PIN — ${left} tries left.`,
        });
      } catch (err) {
        if (err.pinCheck) return res.status(err.status).json({ success: false, message: err.message });
        throw err;
      }

      const expiredMsg = refuseIfExpired(user);
      if (expiredMsg) {
        return res.status(401).json({ success: false, message: expiredMsg });
      }

      const token = generateToken(user);

      const locations = await db.prepare(
        'SELECT l.id, l.name, l.type, l.latitude, l.longitude, l.geofence_radius, ul.is_primary FROM locations l JOIN user_locations ul ON ul.location_id = l.id WHERE ul.user_id = ? AND l.is_active = 1'
      ).all(user.id);

      res.json({
        success: true,
        message: 'Login successful',
        data: { user: publicUser(user), token, locations },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ─── Helper join links (public) ──────────────────────────────
// A helper opens a one-time link on their own phone, sets a 4-digit PIN and
// gets a session. Public and unauthenticated, so it has its own per-IP
// fixed-window limiter (same shape as routes/track.js, separate state).
const {
  consumeJoinToken,
  findLiveJoinToken,
  JOIN_LINK_COPY,
} = require('../utils/join-token');
const { withTransaction } = require('../config/database-async');

const JOIN_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const JOIN_RATE_LIMIT_MAX = 20;
const joinRateLimitBuckets = new Map(); // ip -> { count, windowStart }

function isJoinRateLimited(ip) {
  if (joinRateLimitBuckets.size > 10000) joinRateLimitBuckets.clear();
  const now = Date.now();
  const bucket = joinRateLimitBuckets.get(ip);
  if (!bucket || now - bucket.windowStart >= JOIN_RATE_LIMIT_WINDOW_MS) {
    joinRateLimitBuckets.set(ip, { count: 1, windowStart: now });
    return false;
  }
  bucket.count += 1;
  return bucket.count > JOIN_RATE_LIMIT_MAX;
}

function joinRateLimit(req, res, next) {
  if (isJoinRateLimited(req.ip)) {
    return res.status(429).json({ success: false, message: 'Too many requests — please try again in a minute.' });
  }
  next();
}

// Returns { status, message } when this live token row must not be used,
// or null when it can. Unknown, used, expired, non-helper and switched-off
// accounts all get the same join copy; only an ended access window says so.
function joinRefusal(row) {
  if (!row || row.role !== 'helper' || !row.is_active) {
    return { status: 410, message: JOIN_LINK_COPY };
  }
  const expiredMsg = refuseIfExpired(row);
  if (expiredMsg) return { status: 401, message: expiredMsg };
  return null;
}

// ─── GET /api/auth/join/:token ───────────────────────────────
router.get('/join/:token', joinRateLimit, async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const row = await findLiveJoinToken(db, req.params.token);
    const refusal = joinRefusal(row);
    if (refusal) return res.status(refusal.status).json({ success: false, message: refusal.message });
    res.json({ success: true, data: { name: row.name } });
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/auth/join ─────────────────────────────────────
router.post('/join', joinRateLimit, async (req, res, next) => {
  try {
    const { token, pin } = req.body || {};
    if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) {
      return res.status(400).json({ success: false, message: 'Enter a 4-digit PIN' });
    }

    const db = await getAsyncDb();
    const row = await findLiveJoinToken(db, token);
    const refusal = joinRefusal(row);
    if (refusal) return res.status(refusal.status).json({ success: false, message: refusal.message });

    const pinHash = await hashPin(pin);
    // Consume and set the PIN together: two simultaneous submits cannot both
    // succeed, and a failed PIN write leaves the link unused.
    const userId = await withTransaction(async (tx) => {
      const id = await consumeJoinToken(tx, token);
      if (!id) return null;
      const updated = await tx.prepare(`
        UPDATE users
        SET pin_hash = ?, pin_failed_attempts = 0, pin_locked_until = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND role = 'helper' AND is_active = 1
      `).run(pinHash, id);
      if (updated.changes !== 1) throw Object.assign(new Error('join target changed'), { joinRefused: true });
      return id;
    }).catch((err) => {
      if (err.joinRefused) return null;
      throw err;
    });
    if (!userId) return res.status(410).json({ success: false, message: JOIN_LINK_COPY });

    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    const sessionToken = generateToken(user);
    const locations = await db.prepare(
      'SELECT l.id, l.name, l.type, l.latitude, l.longitude, l.geofence_radius, ul.is_primary FROM locations l JOIN user_locations ul ON ul.location_id = l.id WHERE ul.user_id = ? AND l.is_active = 1'
    ).all(user.id);

    res.json({
      success: true,
      message: 'Login successful',
      data: { user: publicUser(user), token: sessionToken, locations },
    });
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/auth/staff-roster ──────────────────────────────
// Unauthenticated by design — shown on the lock screen before anyone
// is logged in. Returns only non-sensitive display fields, scoped to
// one location. See design spec §6/§7 for the accepted tradeoff.
router.get('/staff-roster', async (req, res, next) => {
  try {
    const { location_id } = req.query;
    if (!location_id) {
      return res.status(400).json({ success: false, message: 'location_id is required' });
    }
    const db = await getAsyncDb();
    const staff = await db.prepare(`
      SELECT u.id, u.name, u.avatar, u.employee_code, u.job_title
      FROM users u
      JOIN user_locations ul ON ul.user_id = u.id
      WHERE ul.location_id = ?
        AND u.role IN ('employee', 'counter_staff', 'florist_staff')
        AND u.is_active = 1
        AND u.employee_code IS NOT NULL
      ORDER BY u.name ASC
    `).all(location_id);

    res.json({ success: true, data: { staff } });
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/auth/me ────────────────────────────────────────
router.get('/me', authenticate, async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const user = await db
      .prepare('SELECT ' + USER_SELECT_FIELDS + ' FROM users WHERE id = ?')
      .get(req.user.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    const locations = await db
      .prepare(
        'SELECT l.id, l.name, l.type, l.address, l.latitude, l.longitude, l.geofence_radius, ul.is_primary FROM locations l JOIN user_locations ul ON ul.location_id = l.id WHERE ul.user_id = ? AND l.is_active = 1'
      )
      .all(user.id);

    res.json({ success: true, data: { user: publicUser(user), locations } });
  } catch (error) {
    next(error);
  }
});

// ─── PUT /api/auth/profile ───────────────────────────────────
router.put(
  '/profile',
  authenticate,
  [
    body('name').optional().trim().notEmpty().withMessage('Name cannot be empty'),
    body('email')
      .optional({ nullable: true, checkFalsy: true })
      .isEmail()
      .normalizeEmail()
      .withMessage('Enter a valid email'),
    body('bio').optional().isString(),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Validation failed',
          errors: errors.array(),
        });
      }

      const { name, email, bio } = req.body;
      const db = getDb();

      if (email) {
        const existing = db
          .prepare('SELECT id FROM users WHERE email = ? AND id != ?')
          .get(email, req.user.id);
        if (existing) {
          return res.status(409).json({
            success: false,
            message: 'This email is already in use',
          });
        }
      }

      const updates = [];
      const values = [];

      if (name !== undefined) {
        updates.push('name = ?');
        values.push(name);
      }
      if (email !== undefined) {
        updates.push('email = ?');
        values.push(email || null);
      }
      if (bio !== undefined) {
        updates.push('bio = ?');
        values.push(bio);
      }

      if (updates.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'No fields to update',
        });
      }

      updates.push("updated_at = CURRENT_TIMESTAMP");
      values.push(req.user.id);

      db.prepare('UPDATE users SET ' + updates.join(', ') + ' WHERE id = ?').run(
        ...values
      );

      const user = db
        .prepare('SELECT ' + USER_SELECT_FIELDS + ' FROM users WHERE id = ?')
        .get(req.user.id);

      res.json({
        success: true,
        message: 'Profile updated successfully',
        data: { user: publicUser(user) },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ─── PUT /api/auth/password ──────────────────────────────────
router.put(
  '/password',
  authenticate,
  [
    body('currentPassword').notEmpty().withMessage('Current password is required'),
    body('newPassword')
      .isLength({ min: 6 })
      .withMessage('New password must be at least 6 characters'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Validation failed',
          errors: errors.array(),
        });
      }

      const { currentPassword, newPassword } = req.body;
      const db = getDb();

      const user = db.prepare('SELECT password FROM users WHERE id = ?').get(req.user.id);

      const isValid = await bcrypt.compare(currentPassword, user.password);
      if (!isValid) {
        return res.status(401).json({
          success: false,
          message: 'Current password is incorrect',
        });
      }

      const salt = await bcrypt.genSalt(12);
      const hashedPassword = await bcrypt.hash(newPassword, salt);

      db.prepare(
        "UPDATE users SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).run(hashedPassword, req.user.id);

      res.json({
        success: true,
        message: 'Password changed successfully',
      });
    } catch (error) {
      next(error);
    }
  }
);

// ─── POST /api/auth/setup ────────────────────────────────────
// First-time owner account creation (only works if no owner exists)
router.post(
  '/setup',
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('phone')
      .trim()
      .notEmpty()
      .withMessage('Phone number is required')
      .matches(/^[6-9]\d{9}$/)
      .withMessage('Enter a valid 10-digit mobile number'),
    body('email')
      .optional({ nullable: true, checkFalsy: true })
      .isEmail()
      .normalizeEmail(),
    body('password')
      .isLength({ min: 6 })
      .withMessage('Password must be at least 6 characters'),
    body('shopName').optional().trim(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Validation failed',
          errors: errors.array(),
        });
      }

      const db = getDb();

      // Check if an owner already exists
      const ownerExists = db
        .prepare("SELECT id FROM users WHERE role = 'owner' LIMIT 1")
        .get();

      if (ownerExists) {
        return res.status(403).json({
          success: false,
          message: 'Setup has already been completed. Please login.',
        });
      }

      const { name, phone, email, password, shopName } = req.body;

      const existing = db
        .prepare('SELECT id FROM users WHERE phone = ?')
        .get(phone);
      if (existing) {
        return res.status(409).json({
          success: false,
          message: 'An account with this phone number already exists',
        });
      }

      const salt = await bcrypt.genSalt(12);
      const hashedPassword = await bcrypt.hash(password, salt);

      const result = db
        .prepare(
          'INSERT INTO users (name, phone, email, password, role) VALUES (?, ?, ?, ?, ?)'
        )
        .run(name, phone, email || null, hashedPassword, 'owner');

      const user = db
        .prepare('SELECT ' + USER_SELECT_FIELDS + ' FROM users WHERE id = ?')
        .get(result.lastInsertRowid);

      if (shopName) {
        db.prepare(
          "UPDATE settings SET value = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE key = 'shop_name'"
        ).run(shopName, user.id);
      }

      const token = generateToken(user);

      res.status(201).json({
        success: true,
        message: 'Owner account created. Welcome to Flower point!',
        data: { user: publicUser(user), token },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ─── GET /api/auth/setup-status ──────────────────────────────
router.get('/setup-status', async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const ownerExists = await db
      .prepare("SELECT id FROM users WHERE role = 'owner' LIMIT 1")
      .get();

    res.json({
      success: true,
      data: { isSetupComplete: !!ownerExists },
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
