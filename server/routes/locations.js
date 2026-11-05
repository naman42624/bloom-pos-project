const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { getDb } = require('../config/database');
const { getDb: getAsyncDb } = require('../config/database-async');
const { authenticate, authorize } = require('../middleware/auth');
const { safeParseJSON } = require('../utils/json');

const router = express.Router();
const { GSTIN_RE } = require('../utils/gst-settings');
const { cleanPrefix } = require('../utils/invoice-number');

// GSTIN, state code, FSSAI and invoice prefix for a shop's bills. Cleans the
// values in place; returns a plain message when one is wrong.
function normalizeShopBillFields(db, b, shopId) {
  if (b.gst_number !== undefined) {
    const g = String(b.gst_number || '').trim().toUpperCase();
    if (g && !GSTIN_RE.test(g)) return "That GSTIN doesn't look right. It has 15 letters and numbers, like 07ABCDE1234F1Z5.";
    b.gst_number = g || null;
    if (g && (b.state_code === undefined || b.state_code === '')) b.state_code = g.slice(0, 2);
  }
  if (b.state_code !== undefined) {
    const c = String(b.state_code || '').trim();
    if (c && !/^\d{2}$/.test(c)) return 'The state code is 2 numbers, like 07 for Delhi.';
    b.state_code = c || null;
  }
  if (b.fssai_number !== undefined) {
    const f = String(b.fssai_number || '').replace(/\s/g, '');
    if (f && !/^\d{14}$/.test(f)) return 'The FSSAI number is 14 numbers. Check it or leave it empty.';
    b.fssai_number = f || null;
  }
  if (b.invoice_prefix !== undefined) {
    const raw = String(b.invoice_prefix || '').trim();
    const pre = cleanPrefix(raw);
    if (raw && pre !== raw.toUpperCase()) return 'The bill number start can use only letters and numbers, up to 5, like FP1.';
    if (pre) {
      const clash = db.prepare('SELECT name FROM locations WHERE UPPER(invoice_prefix) = ? AND id <> ?').get(pre, shopId || 0);
      if (clash) return `${clash.name} already uses ${pre}. Pick a different start so bill numbers never repeat.`;
    }
    b.invoice_prefix = pre || null;
  }
  return null;
}
router.use(authenticate);

// ─── GET /api/locations ──────────────────────────────────────
// Owner: all locations; Manager/Employee: assigned locations
router.get('/', async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    let locations;

    if (req.user.role === 'owner' || req.user.role === 'customer') {
      locations = await db
        .prepare('SELECT * FROM locations WHERE is_active = 1 ORDER BY type, name')
        .all();
    } else {
      locations = await db
        .prepare(
          `SELECT l.* FROM locations l
           JOIN user_locations ul ON ul.location_id = l.id
           WHERE ul.user_id = ? AND l.is_active = 1
           ORDER BY ul.is_primary DESC, l.name`
        )
        .all(req.user.id);
    }

    // Add staff count for each location (only active users) using one grouped query
    const locationIds = locations.map((loc) => loc.id);
    let staffCountByLocationId = new Map();
    if (locationIds.length > 0) {
      const placeholders = locationIds.map(() => '?').join(',');
      const staffRows = await db.prepare(
        `SELECT ul.location_id, COUNT(*) as count
         FROM user_locations ul
         JOIN users u ON u.id = ul.user_id
         WHERE ul.location_id IN (${placeholders}) AND u.is_active = 1
         GROUP BY ul.location_id`
      ).all(...locationIds);

      staffCountByLocationId = new Map(staffRows.map((row) => [row.location_id, Number(row.count || 0)]));
    }

    locations = locations.map((loc) => ({
      ...loc,
      operating_hours: safeParseJSON(loc.operating_hours, null),
      staff_count: staffCountByLocationId.get(loc.id) || 0,
    }));

    res.json({ success: true, data: { locations } });
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/locations/:id ──────────────────────────────────
router.get('/:id', param('id').isInt(), async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const db = await getAsyncDb();
    const location = await db
      .prepare('SELECT * FROM locations WHERE id = ?')
      .get(req.params.id);

    if (!location) {
      return res.status(404).json({ success: false, message: 'Location not found' });
    }

    // Non-owners must be assigned to this location
    if (req.user.role !== 'owner') {
      const assignment = await db
        .prepare('SELECT id FROM user_locations WHERE user_id = ? AND location_id = ?')
        .get(req.user.id, req.params.id);
      if (!assignment) {
        return res.status(403).json({ success: false, message: 'Access denied' });
      }
    }

    // Get assigned staff
    const staff = await db
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
          operating_hours: safeParseJSON(location.operating_hours, null),
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
      const billErr = normalizeShopBillFields(db, req.body, 0);
      if (billErr) return res.status(400).json({ success: false, message: billErr });

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
          req.body.gst_number || null,
          operating_hours ? JSON.stringify(operating_hours) : null,
          req.user.id
        );
      db.prepare('UPDATE locations SET state_code = ?, fssai_number = ?, invoice_prefix = ? WHERE id = ?')
        .run(req.body.state_code || null, req.body.fssai_number || null, req.body.invoice_prefix || null, result.lastInsertRowid);

      const location = db
        .prepare('SELECT * FROM locations WHERE id = ?')
        .get(result.lastInsertRowid);

      // Auto-assign owner to this location
      db.prepare(
        'INSERT INTO user_locations (user_id, location_id, is_primary) VALUES (?, ?, 0) ON CONFLICT (user_id, location_id) DO NOTHING'
      ).run(req.user.id, location.id);

      res.status(201).json({
        success: true,
        message: `${type === 'shop' ? 'Shop' : 'Warehouse'} created successfully`,
        data: {
          location: {
            ...location,
            operating_hours: safeParseJSON(location.operating_hours, null),
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
        'state_code', 'fssai_number', 'invoice_prefix',
      ];
      const billErr = normalizeShopBillFields(db, req.body, Number(req.params.id));
      if (billErr) return res.status(400).json({ success: false, message: billErr });

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

      updates.push("updated_at = CURRENT_TIMESTAMP");
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
            operating_hours: safeParseJSON(location.operating_hours, null),
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
        'INSERT INTO user_locations (user_id, location_id) VALUES (?, ?) ON CONFLICT (user_id, location_id) DO NOTHING'
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
