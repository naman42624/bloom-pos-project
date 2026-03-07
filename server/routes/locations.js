const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { getDb } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// ─── GET /api/locations ──────────────────────────────────────
// Owner: all locations; Manager/Employee: assigned locations
router.get('/', (req, res, next) => {
  try {
    const db = getDb();
    let locations;

    if (req.user.role === 'owner') {
      locations = db
        .prepare('SELECT * FROM locations ORDER BY type, name')
        .all();
    } else {
      locations = db
        .prepare(
          `SELECT l.* FROM locations l
           JOIN user_locations ul ON ul.location_id = l.id
           WHERE ul.user_id = ? AND l.is_active = 1
           ORDER BY ul.is_primary DESC, l.name`
        )
        .all(req.user.id);
    }

    // Add staff count for each location (only active users)
    const staffCount = db.prepare(
      `SELECT COUNT(*) as count FROM user_locations ul
       JOIN users u ON u.id = ul.user_id
       WHERE ul.location_id = ? AND u.is_active = 1`
    );
    locations = locations.map((loc) => ({
      ...loc,
      operating_hours: loc.operating_hours ? JSON.parse(loc.operating_hours) : null,
      staff_count: staffCount.get(loc.id).count,
    }));

    res.json({ success: true, data: { locations } });
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/locations/:id ──────────────────────────────────
router.get('/:id', param('id').isInt(), (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const db = getDb();
    const location = db
      .prepare('SELECT * FROM locations WHERE id = ?')
      .get(req.params.id);

    if (!location) {
      return res.status(404).json({ success: false, message: 'Location not found' });
    }

    // Non-owners must be assigned to this location
    if (req.user.role !== 'owner') {
      const assignment = db
        .prepare('SELECT id FROM user_locations WHERE user_id = ? AND location_id = ?')
        .get(req.user.id, req.params.id);
      if (!assignment) {
        return res.status(403).json({ success: false, message: 'Access denied' });
      }
    }

    // Get assigned staff
    const staff = db
      .prepare(
        `SELECT u.id, u.name, u.phone, u.role, ul.is_primary
         FROM users u
         JOIN user_locations ul ON ul.user_id = u.id
         WHERE ul.location_id = ? AND u.is_active = 1
         ORDER BY u.role, u.name`
      )
      .all(req.params.id);

    res.json({
      success: true,
      data: {
        location: {
          ...location,
          operating_hours: location.operating_hours
            ? JSON.parse(location.operating_hours)
            : null,
        },
        staff,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/locations ─────────────────────────────────────
// Only Owner can create locations
router.post(
  '/',
  authorize('owner'),
  [
    body('name').trim().notEmpty().withMessage('Location name is required'),
    body('type')
      .isIn(['shop', 'warehouse'])
      .withMessage('Type must be shop or warehouse'),
    body('address').optional().trim(),
    body('city').optional().trim(),
    body('state').optional().trim(),
    body('pincode').optional().trim(),
    body('latitude').optional({ nullable: true }).isFloat({ min: -90, max: 90 }),
    body('longitude').optional({ nullable: true }).isFloat({ min: -180, max: 180 }),
    body('geofence_radius').optional().isInt({ min: 10, max: 500 }),
    body('phone').optional().trim(),
    body('email').optional({ nullable: true, checkFalsy: true }).isEmail(),
    body('gst_number').optional().trim(),
    body('operating_hours').optional(),
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

      const {
        name,
        type,
        address,
        city,
        state,
        pincode,
        latitude,
        longitude,
        geofence_radius,
        phone,
        email,
        gst_number,
        operating_hours,
      } = req.body;

      const db = getDb();

      const result = db
        .prepare(
          `INSERT INTO locations (name, type, address, city, state, pincode, latitude, longitude, geofence_radius, phone, email, gst_number, operating_hours, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          name,
          type,
          address || null,
          city || null,
          state || null,
          pincode || null,
          latitude || null,
          longitude || null,
          geofence_radius || 50,
          phone || null,
          email || null,
          gst_number || null,
          operating_hours ? JSON.stringify(operating_hours) : null,
          req.user.id
        );

      const location = db
        .prepare('SELECT * FROM locations WHERE id = ?')
        .get(result.lastInsertRowid);

      // Auto-assign owner to this location
      db.prepare(
        'INSERT OR IGNORE INTO user_locations (user_id, location_id, is_primary) VALUES (?, ?, 0)'
      ).run(req.user.id, location.id);

      res.status(201).json({
        success: true,
        message: `${type === 'shop' ? 'Shop' : 'Warehouse'} created successfully`,
        data: {
          location: {
            ...location,
            operating_hours: location.operating_hours
              ? JSON.parse(location.operating_hours)
              : null,
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ─── PUT /api/locations/:id ──────────────────────────────────
router.put(
  '/:id',
  authorize('owner'),
  [
    param('id').isInt(),
    body('name').optional().trim().notEmpty(),
    body('address').optional().trim(),
    body('city').optional().trim(),
    body('state').optional().trim(),
    body('pincode').optional().trim(),
    body('latitude').optional({ nullable: true }).isFloat({ min: -90, max: 90 }),
    body('longitude').optional({ nullable: true }).isFloat({ min: -180, max: 180 }),
    body('geofence_radius').optional().isInt({ min: 10, max: 500 }),
    body('phone').optional().trim(),
    body('email').optional({ nullable: true, checkFalsy: true }).isEmail(),
    body('gst_number').optional().trim(),
    body('operating_hours').optional(),
    body('is_active').optional().isIn([0, 1, true, false]),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const db = getDb();
      const existing = db.prepare('SELECT id FROM locations WHERE id = ?').get(req.params.id);
      if (!existing) {
        return res.status(404).json({ success: false, message: 'Location not found' });
      }

      const fields = [
        'name', 'address', 'city', 'state', 'pincode',
        'latitude', 'longitude', 'geofence_radius',
        'phone', 'email', 'gst_number', 'is_active',
      ];

      const updates = [];
      const values = [];

      for (const field of fields) {
        if (req.body[field] !== undefined) {
          updates.push(`${field} = ?`);
          if (field === 'is_active') {
            values.push(req.body[field] ? 1 : 0);
          } else {
            values.push(req.body[field]);
          }
        }
      }

      if (req.body.operating_hours !== undefined) {
        updates.push('operating_hours = ?');
        values.push(
          req.body.operating_hours ? JSON.stringify(req.body.operating_hours) : null
        );
      }

      if (updates.length === 0) {
        return res.status(400).json({ success: false, message: 'No fields to update' });
      }

      updates.push("updated_at = datetime('now')");
      values.push(parseInt(req.params.id));

      db.prepare(`UPDATE locations SET ${updates.join(', ')} WHERE id = ?`).run(
        ...values
      );

      const location = db.prepare('SELECT * FROM locations WHERE id = ?').get(req.params.id);

      res.json({
        success: true,
        message: 'Location updated successfully',
        data: {
          location: {
            ...location,
            operating_hours: location.operating_hours
              ? JSON.parse(location.operating_hours)
              : null,
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ─── POST /api/locations/:id/assign ──────────────────────────
// Assign users to a location
router.post(
  '/:id/assign',
  authorize('owner', 'manager'),
  [
    param('id').isInt(),
    body('user_ids').isArray({ min: 1 }).withMessage('user_ids array is required'),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const db = getDb();
      const location = db.prepare('SELECT id FROM locations WHERE id = ?').get(req.params.id);
      if (!location) {
        return res.status(404).json({ success: false, message: 'Location not found' });
      }

      const assign = db.prepare(
        'INSERT OR IGNORE INTO user_locations (user_id, location_id) VALUES (?, ?)'
      );

      const tx = db.transaction(() => {
        for (const userId of req.body.user_ids) {
          assign.run(userId, parseInt(req.params.id));
        }
      });
      tx();

      res.json({
        success: true,
        message: 'Users assigned to location successfully',
      });
    } catch (error) {
      next(error);
    }
  }
);

// ─── POST /api/locations/:id/unassign ────────────────────────
router.post(
  '/:id/unassign',
  authorize('owner', 'manager'),
  [
    param('id').isInt(),
    body('user_ids').isArray({ min: 1 }).withMessage('user_ids array is required'),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const db = getDb();

      const unassign = db.prepare(
        'DELETE FROM user_locations WHERE user_id = ? AND location_id = ?'
      );

      const tx = db.transaction(() => {
        for (const userId of req.body.user_ids) {
          unassign.run(userId, parseInt(req.params.id));
        }
      });
      tx();

      res.json({
        success: true,
        message: 'Users unassigned from location successfully',
      });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
