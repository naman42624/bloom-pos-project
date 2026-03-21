const express = require('express');
const { body, validationResult } = require('express-validator');
const { getDb } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { clearTimezoneCache } = require('../utils/time');

const router = express.Router();
router.use(authenticate);

// ─── GET /api/settings ──────────────────────────────────────
// Owner and Manager can view all settings
router.get('/', authorize('owner', 'manager'), (req, res, next) => {
  try {
    const db = getDb();
    const settings = db.prepare('SELECT * FROM settings ORDER BY key').all();

    // Convert to key-value object for easier consumption
    const settingsMap = {};
    for (const s of settings) {
      settingsMap[s.key] = {
        value: s.value,
        description: s.description,
        updated_at: s.updated_at,
      };
    }

    res.json({ success: true, data: { settings: settingsMap } });
  } catch (error) {
    next(error);
  }
});

// ─── PUT /api/settings ──────────────────────────────────────
// Only Owner can update settings
router.put(
  '/',
  authorize('owner'),
  [
    body('settings')
      .isObject()
      .withMessage('Settings must be an object of key-value pairs'),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const db = getDb();
      const { settings } = req.body;

      const update = db.prepare(
        "UPDATE settings SET value = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?"
      );

      const tx = db.transaction(() => {
        for (const [key, value] of Object.entries(settings)) {
          const existing = db.prepare('SELECT id FROM settings WHERE key = ?').get(key);
          if (existing) {
            update.run(String(value), req.user.id, key);
          }
        }
      });
      tx();

      // Clear timezone cache if timezone was updated
      if ('timezone' in settings) {
        clearTimezoneCache();
      }

      // Return updated settings
      const allSettings = db.prepare('SELECT * FROM settings ORDER BY key').all();
      const settingsMap = {};
      for (const s of allSettings) {
        settingsMap[s.key] = {
          value: s.value,
          description: s.description,
          updated_at: s.updated_at,
        };
      }

      res.json({
        success: true,
        message: 'Settings updated successfully',
        data: { settings: settingsMap },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ─── Tax Rates ──────────────────────────────────────────────

// GET /api/settings/tax-rates
router.get('/tax-rates', authorize('owner', 'manager', 'employee'), (req, res, next) => {
  try {
    const db = getDb();
    const taxRates = db
      .prepare('SELECT * FROM tax_rates WHERE is_active = 1 ORDER BY percentage')
      .all();

    res.json({ success: true, data: { taxRates } });
  } catch (error) {
    next(error);
  }
});

// POST /api/settings/tax-rates
router.post(
  '/tax-rates',
  authorize('owner'),
  [
    body('name').trim().notEmpty().withMessage('Tax name is required'),
    body('percentage')
      .isFloat({ min: 0, max: 100 })
      .withMessage('Percentage must be between 0 and 100'),
    body('is_default').optional().isBoolean(),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { name, percentage, is_default } = req.body;
      const db = getDb();

      const tx = db.transaction(() => {
        // If marking as default, unset existing default
        if (is_default) {
          db.prepare('UPDATE tax_rates SET is_default = 0').run();
        }

        db.prepare(
          'INSERT INTO tax_rates (name, percentage, is_default, created_by) VALUES (?, ?, ?, ?)'
        ).run(name, percentage, is_default ? 1 : 0, req.user.id);
      });
      tx();

      const taxRates = db
        .prepare('SELECT * FROM tax_rates WHERE is_active = 1 ORDER BY percentage')
        .all();

      res.status(201).json({
        success: true,
        message: 'Tax rate created',
        data: { taxRates },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /api/settings/tax-rates/:id
router.put(
  '/tax-rates/:id',
  authorize('owner'),
  [
    body('name').optional().trim().notEmpty(),
    body('percentage').optional().isFloat({ min: 0, max: 100 }),
    body('is_default').optional().isBoolean(),
    body('is_active').optional().isBoolean(),
  ],
  (req, res, next) => {
    try {
      const db = getDb();
      const existing = db
        .prepare('SELECT id FROM tax_rates WHERE id = ?')
        .get(req.params.id);

      if (!existing) {
        return res.status(404).json({ success: false, message: 'Tax rate not found' });
      }

      const { name, percentage, is_default, is_active } = req.body;

      const tx = db.transaction(() => {
        if (is_default) {
          db.prepare('UPDATE tax_rates SET is_default = 0').run();
        }

        const updates = [];
        const values = [];

        if (name !== undefined) { updates.push('name = ?'); values.push(name); }
        if (percentage !== undefined) { updates.push('percentage = ?'); values.push(percentage); }
        if (is_default !== undefined) { updates.push('is_default = ?'); values.push(is_default ? 1 : 0); }
        if (is_active !== undefined) { updates.push('is_active = ?'); values.push(is_active ? 1 : 0); }

        if (updates.length > 0) {
          updates.push("updated_at = CURRENT_TIMESTAMP");
          values.push(parseInt(req.params.id));
          db.prepare(`UPDATE tax_rates SET ${updates.join(', ')} WHERE id = ?`).run(...values);
        }
      });
      tx();

      const taxRates = db
        .prepare('SELECT * FROM tax_rates WHERE is_active = 1 ORDER BY percentage')
        .all();

      res.json({
        success: true,
        message: 'Tax rate updated',
        data: { taxRates },
      });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
