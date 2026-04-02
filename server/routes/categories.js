const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { getDb } = require('../config/database');
const { getDb: getAsyncDb } = require('../config/database-async');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

// ─── GET /api/categories ─────────────────────────────────────
// List all categories (active only by default, ?all=1 for everything)
router.get('/', authenticate, async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const showAll = req.query.all === '1';
    const where = showAll ? '' : 'WHERE is_active = 1';

    const categories = await db
      .prepare(`SELECT * FROM material_categories ${where} ORDER BY name ASC`)
      .all();

    res.json({ success: true, data: categories });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/categories/:id ─────────────────────────────────
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const category = await db
      .prepare('SELECT * FROM material_categories WHERE id = ?')
      .get(req.params.id);

    if (!category) {
      return res.status(404).json({ success: false, message: 'Category not found' });
    }

    // Count of materials in this category
    const materialCount = await db
      .prepare('SELECT COUNT(*) as count FROM materials WHERE category_id = ? AND is_active = 1')
      .get(req.params.id);

    res.json({ success: true, data: { ...category, material_count: materialCount.count } });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/categories ────────────────────────────────────
router.post(
  '/',
  authenticate,
  authorize('owner', 'manager'),
  [
    body('name').trim().notEmpty().withMessage('Category name is required'),
    body('unit').optional().trim().notEmpty(),
    body('has_bundle').optional().isInt({ min: 0, max: 1 }),
    body('default_bundle_size').optional().isInt({ min: 1 }),
    body('is_perishable').optional().isInt({ min: 0, max: 1 }),
    body('default_storage').optional().isIn(['shop', 'warehouse']),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      }

      const { name, unit, has_bundle, default_bundle_size, is_perishable, default_storage } = req.body;
      const db = getDb();

      // Check duplicate name
      const existing = db.prepare('SELECT id FROM material_categories WHERE LOWER(name) = LOWER(?)').get(name);
      if (existing) {
        return res.status(409).json({ success: false, message: 'A category with this name already exists' });
      }

      const result = db.prepare(
        `INSERT INTO material_categories (name, unit, has_bundle, default_bundle_size, is_perishable, default_storage, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        name,
        unit || 'pieces',
        has_bundle ?? 0,
        default_bundle_size ?? 1,
        is_perishable ?? 0,
        default_storage || 'shop',
        req.user.id
      );

      const category = db.prepare('SELECT * FROM material_categories WHERE id = ?').get(result.lastInsertRowid);
      res.status(201).json({ success: true, data: category });
    } catch (err) {
      next(err);
    }
  }
);

// ─── PUT /api/categories/:id ─────────────────────────────────
router.put(
  '/:id',
  authenticate,
  authorize('owner', 'manager'),
  [
    body('name').optional().trim().notEmpty(),
    body('unit').optional().trim().notEmpty(),
    body('has_bundle').optional().isInt({ min: 0, max: 1 }),
    body('default_bundle_size').optional().isInt({ min: 1 }),
    body('is_perishable').optional().isInt({ min: 0, max: 1 }),
    body('default_storage').optional().isIn(['shop', 'warehouse']),
    body('is_active').optional().isInt({ min: 0, max: 1 }),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      }

      const db = getDb();
      const existing = db.prepare('SELECT * FROM material_categories WHERE id = ?').get(req.params.id);
      if (!existing) {
        return res.status(404).json({ success: false, message: 'Category not found' });
      }

      // Check duplicate name (exclude self)
      if (req.body.name) {
        const dup = db.prepare('SELECT id FROM material_categories WHERE LOWER(name) = LOWER(?) AND id != ?').get(req.body.name, req.params.id);
        if (dup) {
          return res.status(409).json({ success: false, message: 'A category with this name already exists' });
        }
      }

      const fields = ['name', 'unit', 'has_bundle', 'default_bundle_size', 'is_perishable', 'default_storage', 'is_active'];
      const updates = [];
      const values = [];

      for (const field of fields) {
        if (req.body[field] !== undefined) {
          updates.push(`${field} = ?`);
          values.push(req.body[field]);
        }
      }

      if (updates.length === 0) {
        return res.status(400).json({ success: false, message: 'No fields to update' });
      }

      updates.push('updated_at = CURRENT_TIMESTAMP');
      values.push(req.params.id);

      db.prepare(`UPDATE material_categories SET ${updates.join(', ')} WHERE id = ?`).run(...values);

      const category = db.prepare('SELECT * FROM material_categories WHERE id = ?').get(req.params.id);
      res.json({ success: true, data: category });
    } catch (err) {
      next(err);
    }
  }
);

// ─── DELETE /api/categories/:id ──────────────────────────────
router.delete('/:id', authenticate, authorize('owner'), (req, res, next) => {
  try {
    const db = getDb();
    const category = db.prepare('SELECT * FROM material_categories WHERE id = ?').get(req.params.id);
    if (!category) {
      return res.status(404).json({ success: false, message: 'Category not found' });
    }

    // Soft delete: deactivate instead of removing
    db.prepare('UPDATE material_categories SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
    res.json({ success: true, message: 'Category deactivated' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
