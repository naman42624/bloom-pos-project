const express = require('express');
const { body, validationResult } = require('express-validator');
const { getDb } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

// ─── GET /api/suppliers ──────────────────────────────────────
router.get('/', authenticate, (req, res, next) => {
  try {
    const db = getDb();
    const showAll = req.query.all === '1';
    const where = showAll ? '' : 'WHERE s.is_active = 1';
    const { search } = req.query;

    let sql = `SELECT s.* FROM suppliers s ${where}`;
    const params = [];

    if (search) {
      const searchCondition = showAll ? 'WHERE' : 'AND';
      sql = `SELECT s.* FROM suppliers s ${where} ${searchCondition} (s.name LIKE ? OR s.phone LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`);
    }

    sql += ' ORDER BY s.name ASC';

    const suppliers = db.prepare(sql).all(...params);

    // Attach material count
    const countStmt = db.prepare('SELECT COUNT(*) as count FROM supplier_materials WHERE supplier_id = ?');
    let result = suppliers.map((s) => ({
      ...s,
      material_count: countStmt.get(s.id).count,
    }));

    // Filter fields for non-owner roles
    if (req.user.role !== 'owner') {
      const setting = db.prepare("SELECT value FROM settings WHERE key = 'supplier_manager_fields'").get();
      const allowed = (setting?.value || 'name').split(',').map((f) => f.trim());
      result = result.map((s) => {
        const filtered = { id: s.id, name: s.name, is_active: s.is_active, material_count: s.material_count };
        if (allowed.includes('phone')) filtered.phone = s.phone;
        if (allowed.includes('email')) filtered.email = s.email;
        if (allowed.includes('address')) filtered.address = s.address;
        if (allowed.includes('gst_number')) filtered.gst_number = s.gst_number;
        if (allowed.includes('notes')) filtered.notes = s.notes;
        return filtered;
      });
    }

    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/suppliers/:id ──────────────────────────────────
router.get('/:id', authenticate, (req, res, next) => {
  try {
    const db = getDb();
    const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(req.params.id);
    if (!supplier) {
      return res.status(404).json({ success: false, message: 'Supplier not found' });
    }

    // Get associated materials
    const materials = db.prepare(`
      SELECT sm.*, m.name as material_name, m.sku, mc.name as category_name
      FROM supplier_materials sm
      JOIN materials m ON sm.material_id = m.id
      JOIN material_categories mc ON m.category_id = mc.id
      WHERE sm.supplier_id = ?
    `).all(req.params.id);

    // Recent purchase orders
    const recentOrders = db.prepare(`
      SELECT po.id, po.po_number, po.status, po.total_amount, po.created_at, l.name as location_name
      FROM purchase_orders po
      JOIN locations l ON po.location_id = l.id
      WHERE po.supplier_id = ?
      ORDER BY po.created_at DESC LIMIT 10
    `).all(req.params.id);

    let data = { ...supplier, materials, recent_orders: recentOrders, material_count: materials.length };

    // Filter fields for non-owner roles
    if (req.user.role !== 'owner') {
      const setting = db.prepare("SELECT value FROM settings WHERE key = 'supplier_manager_fields'").get();
      const allowed = (setting?.value || 'name').split(',').map((f) => f.trim());
      const filtered = { id: data.id, name: data.name, is_active: data.is_active, material_count: data.material_count };
      if (allowed.includes('phone')) filtered.phone = data.phone;
      if (allowed.includes('email')) filtered.email = data.email;
      if (allowed.includes('address')) filtered.address = data.address;
      if (allowed.includes('gst_number')) filtered.gst_number = data.gst_number;
      if (allowed.includes('notes')) filtered.notes = data.notes;
      if (allowed.includes('materials')) filtered.materials = data.materials;
      else filtered.materials = [];
      if (allowed.includes('pricing')) {
        filtered.recent_orders = data.recent_orders;
      } else {
        filtered.recent_orders = [];
        if (filtered.materials) {
          filtered.materials = filtered.materials.map(({ default_price_per_unit, ...rest }) => rest);
        }
      }
      data = filtered;
    }

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/suppliers ─────────────────────────────────────
router.post(
  '/',
  authenticate,
  authorize('owner', 'manager'),
  [
    body('name').trim().notEmpty().withMessage('Supplier name is required'),
    body('phone').optional({ nullable: true, checkFalsy: true }).trim(),
    body('email').optional({ nullable: true, checkFalsy: true }).isEmail().normalizeEmail(),
    body('address').optional({ nullable: true, checkFalsy: true }).trim(),
    body('gst_number').optional({ nullable: true, checkFalsy: true }).trim(),
    body('notes').optional({ nullable: true, checkFalsy: true }).trim(),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      }

      const { name, phone, email, address, gst_number, notes } = req.body;
      const db = getDb();

      const result = db.prepare(
        `INSERT INTO suppliers (name, phone, email, address, gst_number, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(name, phone || null, email || null, address || null, gst_number || null, notes || '', req.user.id);

      const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(result.lastInsertRowid);
      res.status(201).json({ success: true, data: supplier });
    } catch (err) {
      next(err);
    }
  }
);

// ─── PUT /api/suppliers/:id ──────────────────────────────────
router.put(
  '/:id',
  authenticate,
  authorize('owner', 'manager'),
  [
    body('name').optional().trim().notEmpty(),
    body('phone').optional({ nullable: true, checkFalsy: true }).trim(),
    body('email').optional({ nullable: true, checkFalsy: true }).isEmail().normalizeEmail(),
    body('address').optional({ nullable: true, checkFalsy: true }).trim(),
    body('gst_number').optional({ nullable: true, checkFalsy: true }).trim(),
    body('notes').optional({ nullable: true, checkFalsy: true }).trim(),
    body('is_active').optional().isInt({ min: 0, max: 1 }),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      }

      const db = getDb();
      const existing = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(req.params.id);
      if (!existing) {
        return res.status(404).json({ success: false, message: 'Supplier not found' });
      }

      let fields = ['name', 'phone', 'email', 'address', 'gst_number', 'notes', 'is_active'];

      // Restrict fields for non-owners based on supplier_manager_fields setting
      if (req.user.role !== 'owner') {
        const setting = db.prepare("SELECT value FROM settings WHERE key = 'supplier_manager_fields'").get();
        const allowed = (setting?.value || 'name').split(',').map((f) => f.trim());
        fields = fields.filter((f) => f === 'name' || allowed.includes(f));
      }

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

      db.prepare(`UPDATE suppliers SET ${updates.join(', ')} WHERE id = ?`).run(...values);

      const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(req.params.id);
      res.json({ success: true, data: supplier });
    } catch (err) {
      next(err);
    }
  }
);

// ─── DELETE /api/suppliers/:id ───────────────────────────────
router.delete('/:id', authenticate, authorize('owner'), (req, res, next) => {
  try {
    const db = getDb();
    const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(req.params.id);
    if (!supplier) {
      return res.status(404).json({ success: false, message: 'Supplier not found' });
    }

    db.prepare('UPDATE suppliers SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
    res.json({ success: true, message: 'Supplier deactivated' });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/suppliers/:id/materials ───────────────────────
// Link materials to supplier with default pricing
router.post(
  '/:id/materials',
  authenticate,
  authorize('owner', 'manager'),
  [
    body('material_id').isInt().withMessage('Material ID is required'),
    body('default_price_per_unit').optional({ nullable: true }).isFloat({ min: 0 }).withMessage('Price must be a positive number'),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      }

      const db = getDb();
      const { material_id, default_price_per_unit = 0 } = req.body;

      // Validate supplier exists
      const supplier = db.prepare('SELECT id FROM suppliers WHERE id = ?').get(req.params.id);
      if (!supplier) {
        return res.status(404).json({ success: false, message: 'Supplier not found' });
      }

      // Validate material exists
      const material = db.prepare('SELECT id FROM materials WHERE id = ?').get(material_id);
      if (!material) {
        return res.status(400).json({ success: false, message: 'Invalid material' });
      }

      // Upsert
      db.prepare(`
        INSERT INTO supplier_materials (supplier_id, material_id, default_price_per_unit)
        VALUES (?, ?, ?)
        ON CONFLICT(supplier_id, material_id) DO UPDATE SET
          default_price_per_unit = excluded.default_price_per_unit,
          updated_at = CURRENT_TIMESTAMP
      `).run(req.params.id, material_id, default_price_per_unit);

      res.json({ success: true, message: 'Material linked to supplier' });
    } catch (err) {
      next(err);
    }
  }
);

// ─── DELETE /api/suppliers/:supplierId/materials/:materialId ─
router.delete('/:supplierId/materials/:materialId', authenticate, authorize('owner', 'manager'), (req, res, next) => {
  try {
    const db = getDb();
    const { supplierId, materialId } = req.params;

    const link = db.prepare('SELECT id FROM supplier_materials WHERE supplier_id = ? AND material_id = ?').get(supplierId, materialId);
    if (!link) {
      return res.status(404).json({ success: false, message: 'Link not found' });
    }

    db.prepare('DELETE FROM supplier_materials WHERE supplier_id = ? AND material_id = ?').run(supplierId, materialId);
    res.json({ success: true, message: 'Material unlinked from supplier' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
