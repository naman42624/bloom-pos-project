const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const { getDb } = require('../config/database');
const { authenticate } = require('../middleware/auth');

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
        .prepare('SELECT id FROM users WHERE phone = ?')
        .get(phone);

      if (existing) {
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
        data: { user, token },
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
      const db = getDb();

      const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);

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

      const token = generateToken(user);

      const { password: _, ...userWithoutPassword } = user;

      // Get assigned locations
      const locations = db
        .prepare(
          'SELECT l.id, l.name, l.type, l.latitude, l.longitude, l.geofence_radius, ul.is_primary FROM locations l JOIN user_locations ul ON ul.location_id = l.id WHERE ul.user_id = ? AND l.is_active = 1'
        )
        .all(user.id);

      res.json({
        success: true,
        message: 'Login successful',
        data: {
          user: userWithoutPassword,
          token,
          locations,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ─── GET /api/auth/me ────────────────────────────────────────
router.get('/me', authenticate, (req, res, next) => {
  try {
    const db = getDb();
    const user = db
      .prepare('SELECT ' + USER_SELECT_FIELDS + ' FROM users WHERE id = ?')
      .get(req.user.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    const locations = db
      .prepare(
        'SELECT l.id, l.name, l.type, l.address, l.latitude, l.longitude, l.geofence_radius, ul.is_primary FROM locations l JOIN user_locations ul ON ul.location_id = l.id WHERE ul.user_id = ? AND l.is_active = 1'
      )
      .all(user.id);

    res.json({ success: true, data: { user, locations } });
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

      updates.push("updated_at = datetime('now')");
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
        data: { user },
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
        "UPDATE users SET password = ?, updated_at = datetime('now') WHERE id = ?"
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
          "UPDATE settings SET value = ?, updated_by = ?, updated_at = datetime('now') WHERE key = 'shop_name'"
        ).run(shopName, user.id);
      }

      const token = generateToken(user);

      res.status(201).json({
        success: true,
        message: 'Owner account created. Welcome to BloomPOS!',
        data: { user, token },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ─── GET /api/auth/setup-status ──────────────────────────────
router.get('/setup-status', (req, res, next) => {
  try {
    const db = getDb();
    const ownerExists = db
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
