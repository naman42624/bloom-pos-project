const express = require('express');
const { body, query, validationResult } = require('express-validator');
const QRCode = require('qrcode');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const { getDb } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

// ─── Multer config for product images ────────────────────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = path.join(__dirname, '..', 'uploads', 'products');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `product-${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`);
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

// ─── Helper: Auto-generate SKU ───────────────────────────────
function generateSku(db, name) {
  const prefix = name
    .replace(/[^a-zA-Z0-9 ]/g, '')
    .split(' ')
    .filter(Boolean)
    .slice(0, 3)
    .map((w) => w.substring(0, 3).toUpperCase())
    .join('');
  const base = `PRD-${prefix || 'GEN'}`;

  const existing = db
    .prepare("SELECT sku FROM products WHERE sku LIKE ? ORDER BY sku DESC LIMIT 1")
    .get(`${base}-%`);

  let seq = 1;
  if (existing) {
    const lastNum = parseInt(existing.sku.split('-').pop(), 10);
    if (!isNaN(lastNum)) seq = lastNum + 1;
  }
  return `${base}-${String(seq).padStart(3, '0')}`;
}

// ─── Helper: Recalculate estimated cost ──────────────────────
function recalcEstimatedCost(db, productId) {
  const rows = db.prepare(`
    SELECT pm.quantity, pm.cost_per_unit,
      COALESCE(
        (SELECT AVG(sm.default_price_per_unit) FROM supplier_materials sm WHERE sm.material_id = pm.material_id AND sm.default_price_per_unit > 0),
        0
      ) as supplier_avg_cost
    FROM product_materials pm
    WHERE pm.product_id = ?
  `).all(productId);

  let total = 0;
  for (const r of rows) {
    const unitCost = r.cost_per_unit > 0 ? r.cost_per_unit : r.supplier_avg_cost;
    total += r.quantity * unitCost;
  }

  db.prepare('UPDATE products SET estimated_cost = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(total, productId);
  return total;
}

// ═══════════════════════════════════════════════════════════════
// PRODUCT CRUD
// ═══════════════════════════════════════════════════════════════

// ─── GET /api/products ───────────────────────────────────────
router.get('/', authenticate, (req, res, next) => {
  try {
    const db = getDb();
    const { type, category, search, is_active, location_id } = req.query;

    let sql = `
      SELECT p.*, tr.name as tax_name, tr.percentage as tax_percentage,
             l.name as location_name,
             COALESCE((SELECT SUM(si.quantity) FROM sale_items si JOIN sales s ON si.sale_id = s.id WHERE si.product_id = p.id AND s.status != 'cancelled'), 0) as sale_count
      FROM products p
      LEFT JOIN tax_rates tr ON p.tax_rate_id = tr.id
      LEFT JOIN locations l ON p.location_id = l.id
      WHERE 1=1
    `;
    const params = [];

    if (type) { sql += ' AND p.type = ?'; params.push(type); }
    if (category) { sql += ' AND p.category = ?'; params.push(category); }
    if (is_active !== undefined) { sql += ' AND p.is_active = ?'; params.push(Number(is_active)); }
    else { sql += ' AND p.is_active = 1'; }
    if (search) { sql += ' AND (p.name LIKE ? OR p.sku LIKE ? OR p.description LIKE ?)'; const s = `%${search}%`; params.push(s, s, s); }

    sql += ' ORDER BY sale_count DESC, p.name ASC';

    const products = db.prepare(sql).all(...params);

    // Calculate available quantity based on BOM and material stock
    // Also get ready product stock from product_stock table
    const locId = location_id ? Number(location_id) : null;
    if (locId) {
      const getBOM = db.prepare('SELECT material_id, quantity as qty_needed FROM product_materials WHERE product_id = ?');
      const getStock = db.prepare('SELECT quantity FROM material_stock WHERE material_id = ? AND location_id = ?');
      const getReadyStock = db.prepare('SELECT quantity FROM product_stock WHERE product_id = ? AND location_id = ?');
      for (const product of products) {
        // Ready stock (already made products)
        const readyStock = getReadyStock.get(product.id, locId);
        product.ready_qty = readyStock ? readyStock.quantity : 0;

        // Can-make qty from BOM
        const bom = getBOM.all(product.id);
        if (bom.length === 0) {
          product.available_qty = null; // no BOM = unlimited
        } else {
          let minAvail = Infinity;
          for (const b of bom) {
            const stock = getStock.get(b.material_id, locId);
            const available = stock ? Math.floor(stock.quantity / b.qty_needed) : 0;
            if (available < minAvail) minAvail = available;
          }
          product.available_qty = minAvail === Infinity ? null : minAvail;
        }
      }
    }

    res.json({ success: true, data: products });
  } catch (err) { next(err); }
});

// ─── GET /api/products/:id ───────────────────────────────────
router.get('/:id', authenticate, (req, res, next) => {
  try {
    const db = getDb();
    const product = db.prepare(`
      SELECT p.*, tr.name as tax_name, tr.percentage as tax_percentage,
             l.name as location_name
      FROM products p
      LEFT JOIN tax_rates tr ON p.tax_rate_id = tr.id
      LEFT JOIN locations l ON p.location_id = l.id
      WHERE p.id = ?
    `).get(req.params.id);

    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

    // Materials (bill of materials)
    product.materials = db.prepare(`
      SELECT pm.*, m.name as material_name, m.sku as material_sku,
             mc.name as category_name, mc.unit as unit,
             COALESCE(
               (SELECT AVG(sm.default_price_per_unit) FROM supplier_materials sm WHERE sm.material_id = pm.material_id AND sm.default_price_per_unit > 0),
               0
             ) as supplier_avg_cost
      FROM product_materials pm
      JOIN materials m ON pm.material_id = m.id
      JOIN material_categories mc ON m.category_id = mc.id
      WHERE pm.product_id = ?
      ORDER BY m.name
    `).all(req.params.id);

    // Ready stock per location
    product.stock = db.prepare(`
      SELECT ps.*, l.name as location_name
      FROM product_stock ps
      JOIN locations l ON ps.location_id = l.id
      WHERE ps.product_id = ?
    `).all(req.params.id);
    product.total_ready_qty = product.stock.reduce((sum, s) => sum + s.quantity, 0);

    // Images
    product.images = db.prepare(
      'SELECT * FROM product_images WHERE product_id = ? ORDER BY is_primary DESC, sort_order ASC'
    ).all(req.params.id);

    res.json({ success: true, data: product });
  } catch (err) { next(err); }
});

// ─── POST /api/products ──────────────────────────────────────
router.post(
  '/',
  authenticate,
  authorize('owner', 'manager', 'employee'),
  [
    body('name').trim().notEmpty().withMessage('Product name is required'),
    body('sku').optional({ nullable: true, checkFalsy: true }).trim(),
    body('description').optional().trim(),
    body('type').optional().isIn(['standard', 'custom', 'made_to_order']),
    body('category').optional({ nullable: true }).isIn(['bouquet', 'arrangement', 'basket', 'single_stem', 'gift_combo', 'other']),
    body('selling_price').optional().isFloat({ min: 0 }),
    body('tax_rate_id').optional({ nullable: true }).isInt(),
    body('location_id').optional({ nullable: true }).isInt(),
    body('materials').optional().isArray(),
    body('materials.*.material_id').optional().isInt(),
    body('materials.*.quantity').optional().isFloat({ min: 0.01 }),
    body('materials.*.cost_per_unit').optional().isFloat({ min: 0 }),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });

      const db = getDb();
      const { name, sku, description, type, category, selling_price, tax_rate_id, location_id, materials } = req.body;

      // Check name uniqueness
      const dupName = db.prepare('SELECT id FROM products WHERE LOWER(name) = LOWER(?) AND is_active = 1').get(name);
      if (dupName) return res.status(409).json({ success: false, message: 'A product with this name already exists' });

      const finalSku = sku || generateSku(db, name);

      // Check SKU uniqueness
      if (sku) {
        const dupSku = db.prepare('SELECT id FROM products WHERE sku = ?').get(sku);
        if (dupSku) return res.status(409).json({ success: false, message: 'SKU already exists' });
      }

      const result = db.prepare(
        `INSERT INTO products (name, sku, description, type, category, selling_price, tax_rate_id, location_id, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(name, finalSku, description || '', type || 'standard', category || null, selling_price || 0, tax_rate_id || null, location_id || null, req.user.id);

      const productId = result.lastInsertRowid;

      // Add materials (BOM recipe definition only — no stock deduction)
      if (materials && materials.length > 0) {
        const insertPm = db.prepare(
          'INSERT INTO product_materials (product_id, material_id, quantity, cost_per_unit, notes) VALUES (?, ?, ?, ?, ?)'
        );
        const addMaterials = db.transaction(() => {
          for (const mat of materials) {
            const qty = mat.quantity || 1;
            insertPm.run(productId, mat.material_id, qty, mat.cost_per_unit || 0, mat.notes || '');
          }
        });
        addMaterials();
        recalcEstimatedCost(db, productId);
      }

      const product = db.prepare(`
        SELECT p.*, tr.name as tax_name, tr.percentage as tax_percentage
        FROM products p LEFT JOIN tax_rates tr ON p.tax_rate_id = tr.id
        WHERE p.id = ?
      `).get(productId);

      res.status(201).json({ success: true, data: product });
    } catch (err) { next(err); }
  }
);

// ─── PUT /api/products/:id ───────────────────────────────────
router.put(
  '/:id',
  authenticate,
  authorize('owner', 'manager'),
  [
    body('name').optional().trim().notEmpty(),
    body('sku').optional({ nullable: true, checkFalsy: true }).trim(),
    body('description').optional().trim(),
    body('type').optional().isIn(['standard', 'custom', 'made_to_order']),
    body('category').optional({ nullable: true }).isIn(['bouquet', 'arrangement', 'basket', 'single_stem', 'gift_combo', 'other']),
    body('selling_price').optional().isFloat({ min: 0 }),
    body('tax_rate_id').optional({ nullable: true }).isInt(),
    body('location_id').optional({ nullable: true }).isInt(),
    body('is_active').optional().isInt({ min: 0, max: 1 }),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });

      const db = getDb();
      const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
      if (!existing) return res.status(404).json({ success: false, message: 'Product not found' });

      if (req.body.sku && req.body.sku !== existing.sku) {
        const dupSku = db.prepare('SELECT id FROM products WHERE sku = ? AND id != ?').get(req.body.sku, req.params.id);
        if (dupSku) return res.status(409).json({ success: false, message: 'SKU already exists' });
      }

      const fields = ['name', 'sku', 'description', 'type', 'category', 'selling_price', 'tax_rate_id', 'location_id', 'image_url', 'is_active'];
      const updates = [];
      const values = [];

      for (const field of fields) {
        if (req.body[field] !== undefined) {
          updates.push(`${field} = ?`);
          values.push(req.body[field]);
        }
      }

      if (updates.length === 0) return res.status(400).json({ success: false, message: 'No fields to update' });

      updates.push('updated_at = CURRENT_TIMESTAMP');
      values.push(req.params.id);

      db.prepare(`UPDATE products SET ${updates.join(', ')} WHERE id = ?`).run(...values);

      const product = db.prepare(`
        SELECT p.*, tr.name as tax_name, tr.percentage as tax_percentage
        FROM products p LEFT JOIN tax_rates tr ON p.tax_rate_id = tr.id
        WHERE p.id = ?
      `).get(req.params.id);

      res.json({ success: true, data: product });
    } catch (err) { next(err); }
  }
);

// ─── DELETE /api/products/:id (soft delete) ──────────────────
router.delete('/:id', authenticate, authorize('owner'), (req, res, next) => {
  try {
    const db = getDb();
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

    db.prepare('UPDATE products SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
    res.json({ success: true, message: 'Product deactivated' });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
// PRODUCT MATERIALS (Bill of Materials)
// ═══════════════════════════════════════════════════════════════

// ─── POST /api/products/:id/materials ────────────────────────
router.post(
  '/:id/materials',
  authenticate,
  authorize('owner', 'manager', 'employee'),
  [
    body('material_id').isInt().withMessage('Material ID is required'),
    body('quantity').isFloat({ min: 0.01 }).withMessage('Quantity must be > 0'),
    body('cost_per_unit').optional().isFloat({ min: 0 }),
    body('notes').optional().trim(),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });

      const db = getDb();
      const product = db.prepare('SELECT id FROM products WHERE id = ?').get(req.params.id);
      if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

      const material = db.prepare('SELECT id FROM materials WHERE id = ? AND is_active = 1').get(req.body.material_id);
      if (!material) return res.status(404).json({ success: false, message: 'Material not found' });

      const existing = db.prepare('SELECT id FROM product_materials WHERE product_id = ? AND material_id = ?').get(req.params.id, req.body.material_id);
      if (existing) return res.status(409).json({ success: false, message: 'Material already linked to this product' });

      db.prepare('INSERT INTO product_materials (product_id, material_id, quantity, cost_per_unit, notes) VALUES (?, ?, ?, ?, ?)')
        .run(req.params.id, req.body.material_id, req.body.quantity, req.body.cost_per_unit || 0, req.body.notes || '');

      const estimatedCost = recalcEstimatedCost(db, req.params.id);

      const materials = db.prepare(`
        SELECT pm.*, m.name as material_name, m.sku as material_sku, mc.name as category_name, mc.unit as unit
        FROM product_materials pm
        JOIN materials m ON pm.material_id = m.id
        JOIN material_categories mc ON m.category_id = mc.id
        WHERE pm.product_id = ?
        ORDER BY m.name
      `).all(req.params.id);

      res.status(201).json({ success: true, data: { materials, estimated_cost: estimatedCost } });
    } catch (err) { next(err); }
  }
);

// ─── PUT /api/products/:id/materials/:materialId ─────────────
router.put(
  '/:id/materials/:materialId',
  authenticate,
  authorize('owner', 'manager'),
  [
    body('quantity').isFloat({ min: 0.01 }).withMessage('Quantity must be > 0'),
    body('cost_per_unit').optional().isFloat({ min: 0 }),
    body('notes').optional().trim(),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });

      const db = getDb();
      const link = db.prepare('SELECT id FROM product_materials WHERE product_id = ? AND material_id = ?')
        .get(req.params.id, req.params.materialId);
      if (!link) return res.status(404).json({ success: false, message: 'Material not linked to this product' });

      const updates = ['quantity = ?'];
      const values = [req.body.quantity];
      if (req.body.cost_per_unit !== undefined) { updates.push('cost_per_unit = ?'); values.push(req.body.cost_per_unit); }
      if (req.body.notes !== undefined) { updates.push('notes = ?'); values.push(req.body.notes); }
      values.push(req.params.id, req.params.materialId);

      db.prepare(`UPDATE product_materials SET ${updates.join(', ')} WHERE product_id = ? AND material_id = ?`).run(...values);

      const estimatedCost = recalcEstimatedCost(db, req.params.id);
      res.json({ success: true, data: { estimated_cost: estimatedCost } });
    } catch (err) { next(err); }
  }
);

// ─── DELETE /api/products/:id/materials/:materialId ──────────
router.delete(
  '/:id/materials/:materialId',
  authenticate,
  authorize('owner', 'manager'),
  (req, res, next) => {
    try {
      const db = getDb();
      const link = db.prepare('SELECT id FROM product_materials WHERE product_id = ? AND material_id = ?')
        .get(req.params.id, req.params.materialId);
      if (!link) return res.status(404).json({ success: false, message: 'Material not linked to this product' });

      db.prepare('DELETE FROM product_materials WHERE product_id = ? AND material_id = ?')
        .run(req.params.id, req.params.materialId);

      const estimatedCost = recalcEstimatedCost(db, req.params.id);
      res.json({ success: true, message: 'Material removed', data: { estimated_cost: estimatedCost } });
    } catch (err) { next(err); }
  }
);

// ═══════════════════════════════════════════════════════════════
// PRODUCT IMAGES
// ═══════════════════════════════════════════════════════════════

// ─── POST /api/products/:id/images ───────────────────────────
router.post(
  '/:id/images',
  authenticate,
  authorize('owner', 'manager', 'employee'),
  upload.single('image'),
  (req, res, next) => {
    try {
      const db = getDb();
      const product = db.prepare('SELECT id FROM products WHERE id = ?').get(req.params.id);
      if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

      if (!req.file) return res.status(400).json({ success: false, message: 'No image file provided' });

      const imageUrl = `/uploads/products/${req.file.filename}`;
      const isPrimary = req.body.is_primary === '1' || req.body.is_primary === 'true' ? 1 : 0;

      // If setting as primary, unset existing primary
      if (isPrimary) {
        db.prepare('UPDATE product_images SET is_primary = 0 WHERE product_id = ?').run(req.params.id);
      }

      // Check if this is the first image — make primary automatically
      const imgCount = db.prepare('SELECT COUNT(*) as count FROM product_images WHERE product_id = ?').get(req.params.id);
      const finalPrimary = imgCount.count === 0 ? 1 : isPrimary;

      db.prepare('INSERT INTO product_images (product_id, image_url, is_primary) VALUES (?, ?, ?)')
        .run(req.params.id, imageUrl, finalPrimary);

      // Update product's main image_url if primary
      if (finalPrimary) {
        db.prepare('UPDATE products SET image_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(imageUrl, req.params.id);
      }

      const images = db.prepare('SELECT * FROM product_images WHERE product_id = ? ORDER BY is_primary DESC, sort_order ASC')
        .all(req.params.id);
      res.status(201).json({ success: true, data: images });
    } catch (err) { next(err); }
  }
);

// ─── DELETE /api/products/:id/images/:imageId ────────────────
router.delete(
  '/:id/images/:imageId',
  authenticate,
  authorize('owner', 'manager'),
  (req, res, next) => {
    try {
      const db = getDb();
      const image = db.prepare('SELECT * FROM product_images WHERE id = ? AND product_id = ?')
        .get(req.params.imageId, req.params.id);
      if (!image) return res.status(404).json({ success: false, message: 'Image not found' });

      // Delete file from disk
      const filePath = path.join(__dirname, '..', image.image_url);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

      db.prepare('DELETE FROM product_images WHERE id = ?').run(req.params.imageId);

      // If deleted image was primary, promote next image
      if (image.is_primary) {
        const next = db.prepare('SELECT id, image_url FROM product_images WHERE product_id = ? ORDER BY sort_order ASC LIMIT 1')
          .get(req.params.id);
        if (next) {
          db.prepare('UPDATE product_images SET is_primary = 1 WHERE id = ?').run(next.id);
          db.prepare('UPDATE products SET image_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(next.image_url, req.params.id);
        } else {
          db.prepare('UPDATE products SET image_url = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
        }
      }

      res.json({ success: true, message: 'Image deleted' });
    } catch (err) { next(err); }
  }
);

// ═══════════════════════════════════════════════════════════════
// QR CODE
// ═══════════════════════════════════════════════════════════════

// ─── GET /api/products/:id/qr ────────────────────────────────
// Returns QR code as data URL (base64 PNG)
router.get('/:id/qr', authenticate, async (req, res, next) => {
  try {
    const db = getDb();
    const product = db.prepare('SELECT id, name, sku, selling_price FROM products WHERE id = ?').get(req.params.id);
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

    const qrPayload = JSON.stringify({
      type: 'bloomcart_product',
      id: product.id,
      sku: product.sku,
      name: product.name,
    });

    const size = parseInt(req.query.size, 10) || 300;
    const dataUrl = await QRCode.toDataURL(qrPayload, {
      width: Math.min(size, 1000),
      margin: 2,
      color: { dark: '#000000', light: '#FFFFFF' },
    });

    res.json({
      success: true,
      data: {
        product,
        qr_data_url: dataUrl,
        qr_payload: qrPayload,
      },
    });
  } catch (err) { next(err); }
});

// ─── POST /api/products/scan ─────────────────────────────────
// Look up product by scanned QR payload
router.post('/scan', authenticate, (req, res, next) => {
  try {
    const { payload } = req.body;
    if (!payload) return res.status(400).json({ success: false, message: 'No QR payload provided' });

    let parsed;
    try { parsed = JSON.parse(payload); } catch { return res.status(400).json({ success: false, message: 'Invalid QR code' }); }

    if (parsed.type !== 'bloomcart_product') {
      return res.status(400).json({ success: false, message: 'Not a BloomCart product QR code' });
    }

    const db = getDb();
    const product = db.prepare(`
      SELECT p.*, tr.name as tax_name, tr.percentage as tax_percentage
      FROM products p LEFT JOIN tax_rates tr ON p.tax_rate_id = tr.id
      WHERE p.id = ?
    `).get(parsed.id);

    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

    product.materials = db.prepare(`
      SELECT pm.*, m.name as material_name, mc.unit as unit
      FROM product_materials pm
      JOIN materials m ON pm.material_id = m.id
      JOIN material_categories mc ON m.category_id = mc.id
      WHERE pm.product_id = ?
    `).all(product.id);

    res.json({ success: true, data: product });
  } catch (err) { next(err); }
});

module.exports = router;
