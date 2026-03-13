const express = require('express');
const bcrypt = require('bcryptjs');
const { body, param, query, validationResult } = require('express-validator');
const { getDb } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

const USER_SELECT_FIELDS =
  'id, phone, email, name, role, avatar, bio, is_active, created_by, created_at, updated_at';

const VALID_ROLES = ['manager', 'employee', 'delivery_partner', 'customer'];

// ─── GET /api/users ──────────────────────────────────────────
// List users (Owner: all, Manager: employees & delivery partners at their locations)
router.get(
  '/',
  authorize('owner', 'manager'),
  [
    query('role').optional().isIn([...VALID_ROLES, 'owner']),
    query('location_id').optional().isInt(),
    query('is_active').optional().isIn(['0', '1']),
    query('search').optional().trim(),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const db = getDb();
      const { role, location_id, is_active, search } = req.query;
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 20;
      const offset = (page - 1) * limit;

      let whereClause = 'WHERE 1=1';
      const params = [];

      // Managers can only see employees, delivery partners
      if (req.user.role === 'manager') {
        whereClause += " AND u.role IN ('employee', 'delivery_partner')";
      }

      // Always exclude customers from staff listing (separate page)
      if (!role || role !== 'customer') {
        whereClause += " AND u.role != 'customer'";
      }

      if (role) {
        whereClause += ' AND u.role = ?';
        params.push(role);
      }

      if (is_active !== undefined) {
        whereClause += ' AND u.is_active = ?';
        params.push(parseInt(is_active));
      }

      if (search) {
        whereClause += ' AND (u.name LIKE ? OR u.phone LIKE ? OR u.email LIKE ?)';
        const term = `%${search}%`;
        params.push(term, term, term);
      }

      let joinClause = '';
      if (location_id) {
        joinClause = 'JOIN user_locations ul ON ul.user_id = u.id';
        whereClause += ' AND ul.location_id = ?';
        params.push(parseInt(location_id));
      }

      const countResult = db
        .prepare(`SELECT COUNT(DISTINCT u.id) as total FROM users u ${joinClause} ${whereClause}`)
        .get(...params);

      const users = db
        .prepare(
          `SELECT DISTINCT u.${USER_SELECT_FIELDS.split(', ').join(', u.')},
             (SELECT l.name FROM user_locations ul2
              JOIN locations l ON l.id = ul2.location_id
              WHERE ul2.user_id = u.id AND l.is_active = 1
              ORDER BY ul2.is_primary DESC, ul2.id ASC LIMIT 1) as primary_location_name
           FROM users u ${joinClause} ${whereClause}
           ORDER BY u.created_at DESC LIMIT ? OFFSET ?`
        )
        .all(...params, limit, offset);

      res.json({
        success: true,
        data: {
          users,
          pagination: {
            page,
            limit,
            total: countResult.total,
            totalPages: Math.ceil(countResult.total / limit),
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ─── GET /api/users/:id ─────────────────────────────────────
router.get(
  '/:id',
  authorize('owner', 'manager'),
  param('id').isInt(),
  (req, res, next) => {
    try {
      const db = getDb();
      const user = db
        .prepare(`SELECT ${USER_SELECT_FIELDS} FROM users WHERE id = ?`)
        .get(req.params.id);

      if (!user) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }

      // Managers cannot view owners or other managers
      if (req.user.role === 'manager' && (user.role === 'owner' || user.role === 'manager')) {
        return res.status(403).json({ success: false, message: 'Access denied' });
      }

      const locations = db
        .prepare(
          `SELECT l.id, l.name, l.type, ul.is_primary
           FROM locations l
           JOIN user_locations ul ON ul.location_id = l.id
           WHERE ul.user_id = ? AND l.is_active = 1`
        )
        .all(user.id);

      res.json({ success: true, data: { user, locations } });
    } catch (error) {
      next(error);
    }
  }
);

// ─── POST /api/users ─────────────────────────────────────────
// Create staff accounts (Owner: any role, Manager: employee & delivery_partner)
router.post(
  '/',
  authorize('owner', 'manager'),
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
    body('role')
      .isIn(VALID_ROLES)
      .withMessage('Role must be manager, employee, delivery_partner, or customer'),
    body('location_ids')
      .optional()
      .isArray()
      .withMessage('location_ids must be an array'),
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

      const { name, phone, email, password, role, location_ids } = req.body;

      // Only Owner can create managers
      if (role === 'manager' && req.user.role !== 'owner') {
        return res.status(403).json({
          success: false,
          message: 'Only the owner can create manager accounts',
        });
      }

      // Managers can only create employees and delivery partners
      if (req.user.role === 'manager' && !['employee', 'delivery_partner', 'customer'].includes(role)) {
        return res.status(403).json({
          success: false,
          message: 'You can only create employee, delivery partner, or customer accounts',
        });
      }

      const db = getDb();

      // Check phone uniqueness
      const existing = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
      if (existing) {
        return res.status(409).json({
          success: false,
          message: 'An account with this phone number already exists',
        });
      }

      if (email) {
        const existingEmail = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
        if (existingEmail) {
          return res.status(409).json({
            success: false,
            message: 'An account with this email already exists',
          });
        }
      }

      const salt = await bcrypt.genSalt(12);
      const hashedPassword = await bcrypt.hash(password, salt);

      const createUser = db.transaction(() => {
        const result = db
          .prepare(
            'INSERT INTO users (name, phone, email, password, role, created_by) VALUES (?, ?, ?, ?, ?, ?)'
          )
          .run(name, phone, email || null, hashedPassword, role, req.user.id);

        const userId = result.lastInsertRowid;

        // Assign to locations if provided
        if (location_ids && location_ids.length > 0) {
          const assignLocation = db.prepare(
            'INSERT OR IGNORE INTO user_locations (user_id, location_id, is_primary) VALUES (?, ?, ?)'
          );
          for (let i = 0; i < location_ids.length; i++) {
            assignLocation.run(userId, location_ids[i], i === 0 ? 1 : 0);
          }
        }

        return userId;
      });

      const userId = createUser();

      const user = db
        .prepare(`SELECT ${USER_SELECT_FIELDS} FROM users WHERE id = ?`)
        .get(userId);

      const locations = db
        .prepare(
          `SELECT l.id, l.name, l.type, ul.is_primary
           FROM locations l
           JOIN user_locations ul ON ul.location_id = l.id
           WHERE ul.user_id = ?`
        )
        .all(userId);

      res.status(201).json({
        success: true,
        message: `${role.replace('_', ' ')} account created successfully`,
        data: { user, locations },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ─── PUT /api/users/:id ─────────────────────────────────────
// Update user (Owner: any, Manager: employees & delivery partners)
router.put(
  '/:id',
  authorize('owner', 'manager'),
  [
    param('id').isInt(),
    body('name').optional().trim().notEmpty(),
    body('email').optional({ nullable: true, checkFalsy: true }).isEmail().normalizeEmail(),
    body('is_active').optional().isIn([0, 1, true, false]),
    body('location_ids').optional().isArray(),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const db = getDb();
      const targetUser = db
        .prepare('SELECT id, role FROM users WHERE id = ?')
        .get(req.params.id);

      if (!targetUser) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }

      // Managers cannot edit owners or other managers
      if (req.user.role === 'manager' && (targetUser.role === 'owner' || targetUser.role === 'manager')) {
        return res.status(403).json({ success: false, message: 'Access denied' });
      }

      const { name, email, is_active, location_ids } = req.body;

      const updateUser = db.transaction(() => {
        const updates = [];
        const values = [];

        if (name !== undefined) {
          updates.push('name = ?');
          values.push(name);
        }
        if (email !== undefined) {
          // Check uniqueness
          if (email) {
            const existing = db
              .prepare('SELECT id FROM users WHERE email = ? AND id != ?')
              .get(email, req.params.id);
            if (existing) {
              throw { status: 409, message: 'This email is already in use' };
            }
          }
          updates.push('email = ?');
          values.push(email || null);
        }
        if (is_active !== undefined) {
          updates.push('is_active = ?');
          values.push(is_active ? 1 : 0);
        }

        if (updates.length > 0) {
          updates.push("updated_at = datetime('now')");
          values.push(parseInt(req.params.id));
          db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);
        }

        // Update location assignments if provided
        if (location_ids !== undefined) {
          db.prepare('DELETE FROM user_locations WHERE user_id = ?').run(parseInt(req.params.id));
          const assignLocation = db.prepare(
            'INSERT INTO user_locations (user_id, location_id, is_primary) VALUES (?, ?, ?)'
          );
          for (let i = 0; i < location_ids.length; i++) {
            assignLocation.run(parseInt(req.params.id), location_ids[i], i === 0 ? 1 : 0);
          }
        }
      });

      try {
        updateUser();
      } catch (err) {
        if (err.status) {
          return res.status(err.status).json({ success: false, message: err.message });
        }
        throw err;
      }

      const user = db
        .prepare(`SELECT ${USER_SELECT_FIELDS} FROM users WHERE id = ?`)
        .get(req.params.id);

      const locations = db
        .prepare(
          `SELECT l.id, l.name, l.type, ul.is_primary
           FROM locations l
           JOIN user_locations ul ON ul.location_id = l.id
           WHERE ul.user_id = ?`
        )
        .all(req.params.id);

      res.json({
        success: true,
        message: 'User updated successfully',
        data: { user, locations },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ─── PUT /api/users/:id/reset-password ──────────────────────
// Owner/Manager can reset a user's password
router.put(
  '/:id/reset-password',
  authorize('owner', 'manager'),
  [
    param('id').isInt(),
    body('newPassword')
      .isLength({ min: 6 })
      .withMessage('Password must be at least 6 characters'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const db = getDb();
      const targetUser = db.prepare('SELECT id, role FROM users WHERE id = ?').get(req.params.id);

      if (!targetUser) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }

      if (req.user.role === 'manager' && (targetUser.role === 'owner' || targetUser.role === 'manager')) {
        return res.status(403).json({ success: false, message: 'Access denied' });
      }

      const salt = await bcrypt.genSalt(12);
      const hashedPassword = await bcrypt.hash(req.body.newPassword, salt);

      db.prepare("UPDATE users SET password = ?, updated_at = datetime('now') WHERE id = ?").run(
        hashedPassword,
        parseInt(req.params.id)
      );

      res.json({ success: true, message: 'Password reset successfully' });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
