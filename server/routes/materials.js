const express = require('express');
const { body, query, validationResult } = require('express-validator');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

// ─── Multer config for material images ──────────────────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = path.join(__dirname, '..', 'uploads', 'materials');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `material-${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp/;
    if (allowed.test(path.extname(file.originalname).toLowerCase()) && allowed.test(file.mimetype.split('/')[1])) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, and WebP images are allowed'));
    }
  },
});

// ─── GET /api/materials ──────────────────────────────────────
// List materials with optional filters: ?category_id=&location_id=&search=&all=1
router.get('/', authenticate, (req, res, next) => {
  try {
    const db = getDb();
    const { category_id, location_id, search, all } = req.query;

    let sql = `
      SELECT m.*, mc.name as category_name, mc.unit as category_unit, mc.has_bundle, mc.default_bundle_size,
             COALESCE(
               (SELECT AVG(sm.default_price_per_unit) FROM supplier_materials sm WHERE sm.material_id = m.id AND sm.default_price_per_unit > 0),
               0
             ) as avg_cost
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

    let materials;
    try {
      materials = db.prepare(sql).all(...params);
    } catch (queryErr) {
      const msg = String(queryErr?.message || '').toLowerCase();
      if (!msg.includes('supplier_materials')) throw queryErr;

      const fallbackSql = sql
        .replace(/,\s*COALESCE\([\s\S]*?\)\s*as avg_cost\s*/i, ', 0 as avg_cost ');
      materials = db.prepare(fallbackSql).all(...params);
    }

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

// ─── GET /api/materials/metrics ──────────────────────────────
// Inventory metrics: avg cost per material, total value, category breakdown
router.get('/metrics', authenticate, authorize('owner', 'manager'), (req, res, next) => {
  try {
    const db = getDb();
    const { location_id } = req.query;

    // Total active materials
    const totalMaterials = db.prepare('SELECT COUNT(*) as count FROM materials WHERE is_active = 1').get().count;

    // Per-material detail with stock and avg cost
    let materialsSql = `
      SELECT m.id, m.name, m.sku, m.selling_price, m.min_stock_alert,
             mc.name as category_name, mc.unit as category_unit, mc.id as category_id,
             COALESCE(m.selling_price, 0) as unit_cost
      FROM materials m
      JOIN material_categories mc ON m.category_id = mc.id
      WHERE m.is_active = 1
      ORDER BY mc.name, m.name
    `;
    const materials = db.prepare(materialsSql).all();

    // Get stock for each material
    const stockSql = location_id
      ? 'SELECT COALESCE(SUM(quantity), 0) as total_qty FROM material_stock WHERE material_id = ? AND location_id = ?'
      : 'SELECT COALESCE(SUM(quantity), 0) as total_qty FROM material_stock WHERE material_id = ?';

    const getAvgCost = db.prepare(`
      SELECT COALESCE(AVG(default_price_per_unit), 0) as avg_cost
      FROM supplier_materials WHERE material_id = ? AND default_price_per_unit > 0
    `);

    let totalStockValue = 0;
    let totalStockUnits = 0;
    const categoryMap = {};

    const enriched = materials.map(m => {
      const stockRow = location_id
        ? db.prepare(stockSql).get(m.id, location_id)
        : db.prepare(stockSql).get(m.id);
      const stockQty = stockRow?.total_qty || 0;

      let avgCost = 0;
      try { avgCost = getAvgCost.get(m.id)?.avg_cost || 0; } catch (_) {}
      const effectiveCost = m.selling_price > 0 ? m.selling_price : avgCost;
      const stockValue = stockQty * effectiveCost;

      totalStockValue += stockValue;
      totalStockUnits += stockQty;

      // Category aggregation
      const catKey = m.category_id;
      if (!categoryMap[catKey]) {
        categoryMap[catKey] = {
          category_id: catKey,
          category_name: m.category_name,
          unit: m.category_unit,
          material_count: 0,
          total_stock: 0,
          total_value: 0,
          avg_cost: 0,
          costs: [],
        };
      }
      categoryMap[catKey].material_count++;
      categoryMap[catKey].total_stock += stockQty;
      categoryMap[catKey].total_value += stockValue;
      if (effectiveCost > 0) categoryMap[catKey].costs.push(effectiveCost);

      return {
        id: m.id,
        name: m.name,
        sku: m.sku,
        category_name: m.category_name,
        unit: m.category_unit,
        stock_qty: stockQty,
        avg_cost: Math.round(avgCost * 100) / 100,
        selling_price: m.selling_price || 0,
        stock_value: Math.round(stockValue * 100) / 100,
        is_low: m.min_stock_alert > 0 && stockQty < m.min_stock_alert,
      };
    });

    // Finalize category averages
    const categories = Object.values(categoryMap).map(c => {
      c.avg_cost = c.costs.length > 0
        ? Math.round((c.costs.reduce((s, v) => s + v, 0) / c.costs.length) * 100) / 100
        : 0;
      delete c.costs;
      c.total_value = Math.round(c.total_value * 100) / 100;
      return c;
    });

    // Low stock count
    const lowStockCount = enriched.filter(m => m.is_low).length;

    // Location-wise totals
    let locationTotals = [];
    try {
      locationTotals = db.prepare(`
        SELECT l.id, l.name, COALESCE(SUM(ms.quantity), 0) as total_stock,
               COUNT(DISTINCT ms.material_id) as material_count
        FROM locations l
        LEFT JOIN material_stock ms ON l.id = ms.location_id
        GROUP BY l.id, l.name
        ORDER BY l.name
      `).all();
    } catch (_) {}

    res.json({
      success: true,
      data: {
        total_materials: totalMaterials,
        total_stock_units: totalStockUnits,
        total_stock_value: Math.round(totalStockValue * 100) / 100,
        low_stock_count: lowStockCount,
        categories,
        locations: locationTotals,
        materials: enriched,
      },
    });
  } catch (err) { next(err); }
});

// ─── GET /api/materials/:id ──────────────────────────────────
router.get('/:id', authenticate, (req, res, next) => {
  try {
    const db = getDb();
    const id = parseInt(req.params.id);
    if (isNaN(id)) return next(); // Fall through to other routes or 404

    const material = db.prepare(`
      SELECT m.*, mc.name as category_name, mc.unit as category_unit, mc.has_bundle, mc.default_bundle_size
      FROM materials m
      JOIN material_categories mc ON m.category_id = mc.id
      WHERE m.id = ?
    `).get(id);

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

      const { category_id, name, sku, bundle_size_override, min_stock_alert, image_url, selling_price } = req.body;
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
        `INSERT INTO materials (category_id, name, sku, bundle_size_override, min_stock_alert, image_url, selling_price, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(category_id, name, finalSku, bundle_size_override || null, min_stock_alert ?? 10, image_url || null, selling_price || 0, req.user.id);

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

      const fields = ['category_id', 'name', 'sku', 'bundle_size_override', 'image_url', 'min_stock_alert', 'is_active', 'selling_price'];
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

      // If selling_price changed, recalculate estimated_cost for all products using this material
      if (req.body.selling_price !== undefined) {
        const affectedProducts = db.prepare(
          'SELECT DISTINCT product_id FROM product_materials WHERE material_id = ?'
        ).all(req.params.id);
        for (const { product_id } of affectedProducts) {
          // Recalculate: sum(pm.quantity * material.selling_price) for all BOM materials
          const bomRows = db.prepare(`
            SELECT pm.quantity, COALESCE(m.selling_price, 0) as selling_price,
              COALESCE(
                (SELECT AVG(sm.default_price_per_unit) FROM supplier_materials sm WHERE sm.material_id = pm.material_id AND sm.default_price_per_unit > 0),
                0
              ) as avg_cost
            FROM product_materials pm
            JOIN materials m ON pm.material_id = m.id
            WHERE pm.product_id = ?
          `).all(product_id);
          let total = 0;
          for (const r of bomRows) {
            const unitCost = r.selling_price > 0 ? r.selling_price : (r.avg_cost || 0);
            total += r.quantity * unitCost;
          }
          db.prepare('UPDATE products SET estimated_cost = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(total, product_id);
        }
      }

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

// ─── POST /api/materials/:id/image ───────────────────────────
// Upload an image for a material
router.post(
  '/:id/image',
  authenticate,
  authorize('owner', 'manager'),
  upload.single('image'),
  (req, res, next) => {
    try {
      const db = getDb();
      const material = db.prepare('SELECT * FROM materials WHERE id = ?').get(req.params.id);
      if (!material) return res.status(404).json({ success: false, message: 'Material not found' });

      if (!req.file) return res.status(400).json({ success: false, message: 'No image file provided' });

      // Delete old image file if exists
      if (material.image_url) {
        const oldPath = path.join(__dirname, '..', material.image_url);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }

      const imageUrl = `/uploads/materials/${req.file.filename}`;
      db.prepare('UPDATE materials SET image_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(imageUrl, req.params.id);

      res.json({ success: true, data: { image_url: imageUrl } });
    } catch (err) { next(err); }
  }
);

module.exports = router;
