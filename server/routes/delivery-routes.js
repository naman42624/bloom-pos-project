const express = require('express');
const { body, validationResult } = require('express-validator');
const { getDb } = require('../config/database-async');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

// Strips ALL whitespace (not just trim) + lowercases, so "Delhi"/"delhi"/
// "DeLhi"/" delhi "/"de lhi" all collapse to the same normalized_name.
// Also collapses e.g. "New Delhi"/"Newdelhi" — a known trade-off, see spec §8.2.
function normalize(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, '');
}

// GET /api/delivery-routes — list active routes for the picker
router.get('/', authenticate, authorize('owner', 'manager', 'employee', 'counter_staff'), async (req, res, next) => {
  try {
    const db = await getDb();
    const { location_id } = req.query;
    const locFilter = location_id ? 'AND (location_id = ? OR location_id IS NULL)' : '';
    const params = location_id ? [location_id] : [];
    const routes = await db.prepare(
      `SELECT id, name FROM delivery_routes WHERE is_active = true ${locFilter} ORDER BY name ASC`
    ).all(...params);
    res.json({ success: true, data: { routes } });
  } catch (err) { next(err); }
});

// POST /api/delivery-routes — create-or-find, normalized
router.post(
  '/',
  authenticate,
  authorize('owner', 'manager', 'employee', 'counter_staff'),
  [body('name').trim().notEmpty().withMessage('Route name is required')],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });

      const db = await getDb();
      const { name, location_id } = req.body;
      const normalized = normalize(name);

      const existing = await db.prepare('SELECT id, name FROM delivery_routes WHERE normalized_name = ?').get(normalized);
      if (existing) {
        return res.json({ success: true, data: existing, existed: true });
      }

      try {
        const created = await db.prepare(
          'INSERT INTO delivery_routes (name, normalized_name, location_id, created_by) VALUES (?, ?, ?, ?) RETURNING id, name'
        ).get(name.trim(), normalized, location_id || null, req.user.id);
        return res.status(201).json({ success: true, data: created, existed: false });
      } catch (err) {
        // Race: another request created the same normalized name between
        // our lookup and insert — the UNIQUE constraint is the real
        // backstop here, fall back to returning the now-existing row.
        if (String(err.message || '').toLowerCase().includes('unique')) {
          const raceWinner = await db.prepare('SELECT id, name FROM delivery_routes WHERE normalized_name = ?').get(normalized);
          if (raceWinner) return res.json({ success: true, data: raceWinner, existed: true });
        }
        throw err;
      }
    } catch (err) { next(err); }
  }
);

module.exports = router;
