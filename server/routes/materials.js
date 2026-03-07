const express = require('express');
const { body, query, validationResult } = require('express-validator');
const { getDb } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

// ─── GET /api/materials ──────────────────────────────────────
// List materials with optional filters: ?category_id=&location_id=&search=&all=1
router.get('/', authenticate, (req, res, next) => {
  try {
    const db = getDb();
    const { category_id, location_id, search, all } = req.query;

    let sql = `
      SELECT m.*, mc.name as category_name, mc.unit as category_unit, mc.has_bundle, mc.default_bundle_size
      FROM materials m
      JOIN material_categories mc ON m.category_id = mc.id
    `;
    const conditions = [];
    const params = [];

    if (all !== '1') {
      conditions.push('m.is_active = 1');
    }
    if (category_id) {
      conditions.push('m.category_id = ?');
      params.push(category_id);
    }
    if (search) {
      conditions.push('(m.name LIKE ? OR m.sku LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }

    if (conditions.length) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY mc.name ASC, m.name ASC';

    let materials = db.prepare(sql).all(...params);

    // If location_id is specified, attach stock info
    if (location_id) {
      const stockStmt = db.prepare(
        'SELECT quantity, last_counted_at FROM material_stock WHERE material_id = ? AND location_id = ?'
      );
      materials = materials.map((m) => {
        const stock = stockStmt.get(m.id, location_id);
        return { ...m, stock_quantity: stock ? stock.quantity : 0, last_counted_at: stock ? stock.last_counted_at : null };
      });
    }

    res.json({ success: true, data: materials });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/materials/:id ──────────────────────────────────
router.get('/:id', authenticate, (req, res, next) => {
  try {
    const db = getDb();
    const material = db.prepare(`
      SELECT m.*, mc.name as category_name, mc.unit as category_unit, mc.has_bundle, mc.default_bundle_size
      FROM materials m
      JOIN material_categories mc ON m.category_id = mc.id
      WHERE m.id = ?
    `).get(req.params.id);

    if (!material) {
      return res.status(404).json({ success: false, message: 'Material not found' });
    }

    // Stock across all locations
    const stock = db.prepare(`
      SELECT ms.*, l.name as location_name
      FROM material_stock ms
      JOIN locations l ON ms.location_id = l.id
      WHERE ms.material_id = ?
    `).all(req.params.id);

    // Suppliers for this material
    const suppliers = db.prepare(`
      SELECT s.id, s.name, s.phone, sm.default_price_per_unit
      FROM supplier_materials sm
      JOIN suppliers s ON sm.supplier_id = s.id
      WHERE sm.material_id = ? AND s.is_active = 1
    `).all(req.params.id);

    res.json({ success: true, data: { ...material, stock, suppliers } });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/materials ─────────────────────────────────────
router.post(
  '/',
  authenticate,
  authorize('owner', 'manager'),
  [
    body('category_id').isInt().withMessage('Category is required'),
    body('name').trim().notEmpty().withMessage('Material name is required'),
    body('sku').optional({ nullable: true, checkFalsy: true }).trim(),
    body('bundle_size_override').optional({ nullable: true }).isInt({ min: 1 }),
    body('min_stock_alert').optional().isInt({ min: 0 }),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      }

      const { category_id, name, sku, bundle_size_override, min_stock_alert, image_url } = req.body;
      const db = getDb();

      // Validate category exists
      const cat = db.prepare('SELECT id FROM material_categories WHERE id = ?').get(category_id);
      if (!cat) {
        return res.status(400).json({ success: false, message: 'Invalid category' });
      }

      // Check SKU uniqueness if provided
      if (sku) {
        const dupSku = db.prepare('SELECT id FROM materials WHERE sku = ?').get(sku);
        if (dupSku) {
          return res.status(409).json({ success: false, message: 'SKU already exists' });
        }
      }

      // Auto-generate SKU if not provided
      const finalSku = sku || `MAT-${Date.now()}`;

      const result = db.prepare(
        `INSERT INTO materials (category_id, name, sku, bundle_size_override, min_stock_alert, image_url, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(category_id, name, finalSku, bundle_size_override || null, min_stock_alert ?? 10, image_url || null, req.user.id);

      const material = db.prepare(`
        SELECT m.*, mc.name as category_name, mc.unit as category_unit
        FROM materials m
        JOIN material_categories mc ON m.category_id = mc.id
        WHERE m.id = ?
      `).get(result.lastInsertRowid);

      res.status(201).json({ success: true, data: material });
    } catch (err) {
      next(err);
    }
  }
);

// ─── PUT /api/materials/:id ──────────────────────────────────
router.put(
  '/:id',
  authenticate,
  authorize('owner', 'manager'),
  [
    body('category_id').optional().isInt(),
    body('name').optional().trim().notEmpty(),
    body('sku').optional({ nullable: true, checkFalsy: true }).trim(),
    body('bundle_size_override').optional({ nullable: true }).isInt({ min: 1 }),
    body('min_stock_alert').optional().isInt({ min: 0 }),
    body('is_active').optional().isInt({ min: 0, max: 1 }),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      }

      const db = getDb();
      const existing = db.prepare('SELECT * FROM materials WHERE id = ?').get(req.params.id);
      if (!existing) {
        return res.status(404).json({ success: false, message: 'Material not found' });
      }

      // Check SKU uniqueness if updating
      if (req.body.sku && req.body.sku !== existing.sku) {
        const dupSku = db.prepare('SELECT id FROM materials WHERE sku = ? AND id != ?').get(req.body.sku, req.params.id);
        if (dupSku) {
          return res.status(409).json({ success: false, message: 'SKU already exists' });
        }
      }

      const fields = ['category_id', 'name', 'sku', 'bundle_size_override', 'image_url', 'min_stock_alert', 'is_active'];
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

      db.prepare(`UPDATE materials SET ${updates.join(', ')} WHERE id = ?`).run(...values);

      const material = db.prepare(`
        SELECT m.*, mc.name as category_name, mc.unit as category_unit
        FROM materials m
        JOIN material_categories mc ON m.category_id = mc.id
        WHERE m.id = ?
      `).get(req.params.id);

      res.json({ success: true, data: material });
    } catch (err) {
      next(err);
    }
  }
);

// ─── DELETE /api/materials/:id ───────────────────────────────
router.delete('/:id', authenticate, authorize('owner'), (req, res, next) => {
  try {
    const db = getDb();
    const material = db.prepare('SELECT * FROM materials WHERE id = ?').get(req.params.id);
    if (!material) {
      return res.status(404).json({ success: false, message: 'Material not found' });
    }

    db.prepare('UPDATE materials SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
    res.json({ success: true, message: 'Material deactivated' });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/materials/low-stock ────────────────────────────
// Returns materials that are below min_stock_alert at any location
router.get('/low-stock', authenticate, (req, res, next) => {
  try {
    const db = getDb();
    const { location_id } = req.query;

    let sql = `
      SELECT m.id, m.name, m.sku, m.min_stock_alert, mc.name as category_name,
             ms.quantity, ms.location_id, l.name as location_name
      FROM materials m
      JOIN material_categories mc ON m.category_id = mc.id
      JOIN material_stock ms ON m.id = ms.material_id
      JOIN locations l ON ms.location_id = l.id
      WHERE m.is_active = 1 AND ms.quantity < m.min_stock_alert
    `;
    const params = [];

    if (location_id) {
      sql += ' AND ms.location_id = ?';
      params.push(location_id);
    }

    sql += ' ORDER BY (ms.quantity - m.min_stock_alert) ASC';

    const lowStock = db.prepare(sql).all(...params);
    res.json({ success: true, data: lowStock });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
