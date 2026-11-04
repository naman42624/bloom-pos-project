const express = require('express');
const { body, query, validationResult } = require('express-validator');
const QRCode = require('qrcode');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const { getDb } = require('../config/database');
const { getDb: getAsyncDb, withTransaction } = require('../config/database-async');
const { authenticate, authorize } = require('../middleware/auth');
const { ensureLabelCode, labelUrl, ALPHABET, CODE_LENGTH } = require('../utils/label-code');
const { publicUrlMissingInProduction, publicUrlHost, PUBLIC_APP_URL } = require('../utils/public-url');

const router = express.Router();

// ─── Multer config for product images ────────────────────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = path.join(__dirname, '..', 'uploads', 'products');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    let ext = path.extname(file.originalname);
    if (!ext && file.mimetype) {
      const mimeExt = file.mimetype.split('/')[1];
      if (mimeExt) ext = `.${mimeExt === 'jpeg' ? 'jpg' : mimeExt}`;
    }
    cb(null, `product-${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp/i;
    const extMatch = allowed.test(path.extname(file.originalname));
    const mimeMatch = allowed.test(file.mimetype);
    if (extMatch || mimeMatch) {
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

function resolveTaxRateId(db, taxRateId, taxPercentage, createdBy) {
  if (taxRateId !== undefined && taxRateId !== null && taxRateId !== '') {
    return Number(taxRateId);
  }

  const percentage = Number(taxPercentage);
  if (!Number.isFinite(percentage) || percentage <= 0) {
    return null;
  }

  const existing = db
    .prepare('SELECT id FROM tax_rates WHERE percentage = ? AND is_active = 1 ORDER BY id ASC LIMIT 1')
    .get(percentage);
  if (existing) return existing.id;

  const label = `Custom ${Number.isInteger(percentage) ? percentage : percentage.toFixed(2)}%`;
  const result = db.prepare(
    'INSERT INTO tax_rates (name, percentage, is_default, created_by) VALUES (?, ?, 0, ?)'
  ).run(label, percentage, createdBy);
  return result.lastInsertRowid;
}

// ═══════════════════════════════════════════════════════════════
// PRODUCT CRUD
// ═══════════════════════════════════════════════════════════════

// Helpers never see cost, margin, stock numbers or sales counts (spec 8.2).
// Instead of stock numbers they get a yes/no `available`, decided the way
// scan and the public price page decide it: a one-off item is available only
// while it has stock; anything else is made or sold to order, so available.
const HELPER_PRODUCT_FIELDS = [
  'id', 'name', 'sku', 'description', 'type', 'category', 'category_name', 'selling_price',
  'tax_rate_id', 'tax_name', 'tax_percentage', 'image_url', 'label_code', 'price_mode',
  'price_hint', 'is_one_off',
];
// Builds the helper's copy of a product from an allowlist, so a column added
// to products later is never shown to helpers by accident.
function helperProductView(row, stockQty) {
  if (!row) return row;
  const out = {};
  for (const key of HELPER_PRODUCT_FIELDS) if (key in row) out[key] = row[key];
  if (Array.isArray(row.images)) {
    out.images = row.images.map((img) => ({ id: img.id, image_url: img.image_url, is_primary: img.is_primary, sort_order: img.sort_order }));
  }
  if (Array.isArray(row.options)) {
    out.options = row.options.map((o) => ({ id: o.id, label: o.label, price: o.price }));
  }
  out.available = Number(row.is_one_off) === 1 ? Number(stockQty) > 0 : true;
  return out;
}

// Stock per product for the helper view: at the given location, or across
// all locations when none is given.
async function helperStockByProduct(db, productIds, locationId) {
  const out = new Map();
  if (productIds.length === 0) return out;
  const placeholders = productIds.map(() => '?').join(',');
  const rows = locationId
    ? await db.prepare(
      `SELECT product_id, COALESCE(SUM(quantity), 0) AS qty FROM product_stock
       WHERE location_id = ? AND product_id IN (${placeholders}) GROUP BY product_id`
    ).all(locationId, ...productIds)
    : await db.prepare(
      `SELECT product_id, COALESCE(SUM(quantity), 0) AS qty FROM product_stock
       WHERE product_id IN (${placeholders}) GROUP BY product_id`
    ).all(...productIds);
  for (const r of rows) out.set(Number(r.product_id), Number(r.qty) || 0);
  return out;
}

// ─── GET /api/products ───────────────────────────────────────
router.get('/', authenticate, async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const { type, category, search, is_active, location_id, limit: rawLimit, offset: rawOffset } = req.query;
    const limit = Math.max(1, Math.min(parseInt(rawLimit, 10) || 50, 100));
    const offset = Math.max(0, parseInt(rawOffset, 10) || 0);

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
    // Helpers always get active products only.
    if (is_active !== undefined && req.user.role !== 'helper') { sql += ' AND p.is_active = ?'; params.push(Number(is_active)); }
    else { sql += ' AND p.is_active = 1'; }
    if (search) { 
      const terms = search.toLowerCase().split(/\\s+/).filter(Boolean);
      for (const term of terms) {
        sql += ' AND (LOWER(p.name) LIKE ? OR LOWER(p.sku) LIKE ? OR LOWER(p.description) LIKE ?)';
        const s = `%${term}%`;
        params.push(s, s, s);
      }
    }

    sql += ' ORDER BY sale_count DESC, p.name ASC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const products = await db.prepare(sql).all(...params);

    // Calculate available quantity based on BOM and material stock
    // Also get ready product stock from product_stock table
    const locId = location_id ? Number(location_id) : null;
    if (locId && products.length > 0) {
      const productIds = products.map((product) => product.id);
      const placeholders = productIds.map(() => '?').join(',');

      const readyStockRows = await db.prepare(
        `SELECT product_id, quantity
         FROM product_stock
         WHERE location_id = ? AND product_id IN (${placeholders})`
      ).all(locId, ...productIds);

      const bomRows = await db.prepare(
        `SELECT pm.product_id, pm.material_id, pm.quantity as qty_needed,
                COALESCE(ms.quantity, 0) as stock_qty
         FROM product_materials pm
         LEFT JOIN material_stock ms
           ON ms.material_id = pm.material_id AND ms.location_id = ?
         WHERE pm.product_id IN (${placeholders})
         ORDER BY pm.product_id`
      ).all(locId, ...productIds);

      const readyByProductId = new Map();
      for (const row of readyStockRows) {
        readyByProductId.set(row.product_id, row.quantity || 0);
      }

      const bomByProductId = new Map();
      for (const row of bomRows) {
        const current = bomByProductId.get(row.product_id) || [];
        current.push(row);
        bomByProductId.set(row.product_id, current);
      }

      for (const product of products) {
        product.ready_qty = readyByProductId.get(product.id) || 0;

        const bom = bomByProductId.get(product.id) || [];
        if (bom.length === 0) {
          product.available_qty = null; // no BOM = unlimited
          continue;
        }

        let minAvail = Infinity;
        for (const item of bom) {
          const qtyNeeded = Number(item.qty_needed || 0);
          if (qtyNeeded <= 0) continue;
          const available = Math.floor(Number(item.stock_qty || 0) / qtyNeeded);
          if (available < minAvail) minAvail = available;
        }

        product.available_qty = minAvail === Infinity ? null : minAvail;
      }
    }

    if (req.user.role === 'helper') {
      const stockById = await helperStockByProduct(db, products.map((p) => p.id), locId);
      return res.json({ success: true, data: products.map((p) => helperProductView(p, stockById.get(Number(p.id)) || 0)) });
    }

    res.json({ success: true, data: products });
  } catch (err) { next(err); }
});

// ─── GET /api/products/:id ───────────────────────────────────
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const product = await db.prepare(`
      SELECT p.*, tr.name as tax_name, tr.percentage as tax_percentage,
             l.name as location_name
      FROM products p
      LEFT JOIN tax_rates tr ON p.tax_rate_id = tr.id
      LEFT JOIN locations l ON p.location_id = l.id
      WHERE p.id = ?
    `).get(req.params.id);

    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });
    if (req.user.role === 'helper' && !Number(product.is_active)) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    // Materials (bill of materials)
    product.materials = await db.prepare(`
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
    product.stock = await db.prepare(`
      SELECT ps.*, l.name as location_name
      FROM product_stock ps
      JOIN locations l ON ps.location_id = l.id
      WHERE ps.product_id = ?
    `).all(req.params.id);
    product.total_ready_qty = product.stock.reduce((sum, s) => sum + (Number(s.quantity) || 0), 0);

    // Images
    product.images = await db.prepare(
      'SELECT * FROM product_images WHERE product_id = ? ORDER BY is_primary DESC, sort_order ASC'
    ).all(req.params.id);

    product.options = await db.prepare(
      'SELECT id, label, price, sort_order FROM product_options WHERE product_id = ? AND is_active = 1 ORDER BY sort_order, id'
    ).all(req.params.id);

    if (req.user.role === 'helper') {
      const locId = Number(req.query.location_id) || null;
      const stockById = await helperStockByProduct(db, [product.id], locId);
      return res.json({ success: true, data: helperProductView(product, stockById.get(Number(product.id)) || 0) });
    }

    res.json({ success: true, data: product });
  } catch (err) { next(err); }
});

// ─── POST /api/products ──────────────────────────────────────
router.post(
  '/',
  authenticate,
  authorize('owner', 'manager', 'employee', 'counter_staff'),
  [
    body('name').trim().notEmpty().withMessage('Product name is required'),
    body('sku').optional({ nullable: true, checkFalsy: true }).trim(),
    body('description').optional().trim(),
    body('type').optional().isIn(['standard', 'custom', 'made_to_order']),
    body('category').optional({ nullable: true }).isIn(['bouquet', 'arrangement', 'basket', 'single_stem', 'gift_combo', 'other']),
    body('selling_price').optional().isFloat({ min: 0 }),
    body('tax_rate_id').optional({ nullable: true }).isInt(),
    body('tax_percentage').optional({ nullable: true }).isFloat({ min: 0, max: 100 }),
    body('location_id').optional({ nullable: true }).isInt(),
    body('materials').optional().isArray(),
    body('materials.*.material_id').optional().isInt(),
    body('materials.*.quantity').optional().isFloat({ min: 0.01 }),
    body('materials.*.cost_per_unit').optional().isFloat({ min: 0 }),
    body('price_mode').optional().isIn(['fixed', 'open']),
    body('price_hint').optional({ nullable: true }).isString().isLength({ max: 120 }),
    body('is_one_off').optional().isInt({ min: 0, max: 1 }),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });

      const db = getDb();
      const { name, sku, description, type, category, selling_price, tax_rate_id, tax_percentage, location_id, materials } = req.body;

      // Check name uniqueness
      const dupName = db.prepare('SELECT id FROM products WHERE LOWER(name) = LOWER(?) AND is_active = 1').get(name);
      if (dupName) return res.status(409).json({ success: false, message: 'A product with this name already exists' });

      const finalSku = sku || generateSku(db, name);
      const resolvedTaxRateId = resolveTaxRateId(db, tax_rate_id, tax_percentage, req.user.id);

      // Check SKU uniqueness
      if (sku) {
        const dupSku = db.prepare('SELECT id FROM products WHERE sku = ?').get(sku);
        if (dupSku) return res.status(409).json({ success: false, message: 'SKU already exists' });
      }

      const result = db.prepare(
        `INSERT INTO products (name, sku, description, type, category, selling_price, tax_rate_id, location_id, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(name, finalSku, description || '', type || 'standard', category || null, selling_price || 0, resolvedTaxRateId || null, location_id || null, req.user.id);

      const productId = result.lastInsertRowid;

      if (req.body.price_mode !== undefined || req.body.price_hint !== undefined || req.body.is_one_off !== undefined) {
        db.prepare('UPDATE products SET price_mode = COALESCE(?, price_mode), price_hint = ?, is_one_off = COALESCE(?, is_one_off) WHERE id = ?')
          .run(req.body.price_mode ?? null, req.body.price_hint ?? null, req.body.is_one_off ?? null, productId);
      }

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
    body('tax_percentage').optional({ nullable: true }).isFloat({ min: 0, max: 100 }),
    body('location_id').optional({ nullable: true }).isInt(),
    body('is_active').optional().isInt({ min: 0, max: 1 }),
    body('price_mode').optional().isIn(['fixed', 'open']),
    body('price_hint').optional({ nullable: true }).isString().isLength({ max: 120 }),
    body('is_one_off').optional().isInt({ min: 0, max: 1 }),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });

      const db = getDb();
      const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
      if (!existing) return res.status(404).json({ success: false, message: 'Product not found' });

      if (req.body.tax_percentage !== undefined && (req.body.tax_rate_id === undefined || req.body.tax_rate_id === null || req.body.tax_rate_id === '')) {
        req.body.tax_rate_id = resolveTaxRateId(db, null, req.body.tax_percentage, req.user.id);
      }

      if (req.body.sku && req.body.sku !== existing.sku) {
        const dupSku = db.prepare('SELECT id FROM products WHERE sku = ? AND id != ?').get(req.body.sku, req.params.id);
        if (dupSku) return res.status(409).json({ success: false, message: 'SKU already exists' });
      }

      const fields = ['name', 'sku', 'description', 'type', 'category', 'selling_price', 'tax_rate_id', 'location_id', 'image_url', 'is_active', 'price_mode', 'price_hint', 'is_one_off'];
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

// ─── PUT /api/products/:id/options (replace the size/price option list) ───
router.put(
  '/:id/options',
  authenticate,
  authorize('owner', 'manager'),
  [
    body('options').isArray({ max: 6 }).withMessage('At most 6 options'),
    body('options.*.label').isString().trim().notEmpty().isLength({ max: 60 }),
    body('options.*.price').isFloat({ gt: 0 }),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      const db = await getAsyncDb();
      const product = await db.prepare('SELECT id FROM products WHERE id = ?').get(req.params.id);
      if (!product) return res.status(404).json({ success: false, message: 'Product not found' });
      const options = req.body.options;
      await withTransaction(async (tx) => {
        // Row lock: two saves of the same list at once must not interleave
        // their delete + insert and leave a doubled list.
        await tx.prepare('SELECT id FROM products WHERE id = ? FOR UPDATE').get(req.params.id);
        await tx.prepare('DELETE FROM product_options WHERE product_id = ?').run(req.params.id);
        for (let i = 0; i < options.length; i++) {
          await tx.prepare('INSERT INTO product_options (product_id, label, price, sort_order) VALUES (?, ?, ?, ?)')
            .run(req.params.id, String(options[i].label).trim(), options[i].price, i);
        }
      });
      const rows = await db.prepare(
        'SELECT id, label, price, sort_order FROM product_options WHERE product_id = ? AND is_active = 1 ORDER BY sort_order, id'
      ).all(req.params.id);
      res.json({ success: true, data: rows });
    } catch (err) { next(err); }
  }
);

// ─── PUT /api/products/:id/one-off (Produce screen: Print tag) ───
// Staff who make a custom item on the Produce screen mark it one-off so its tag
// reads as sold once it is sold. PUT /:id is owner/manager only (it edits
// prices), so this narrow route sets is_one_off = 1 and nothing else. Staff may
// only do it for custom-made products (sku CUST-...), never a catalog product.
router.put(
  '/:id/one-off',
  authenticate,
  authorize('owner', 'manager', 'employee', 'counter_staff', 'florist_staff'),
  async (req, res, next) => {
    try {
      const db = await getAsyncDb();
      const product = await db.prepare('SELECT id, sku FROM products WHERE id = ?').get(req.params.id);
      if (!product) return res.status(404).json({ success: false, message: 'This item could not be found. Refresh and try again.' });
      const isCustom = String(product.sku || '').startsWith('CUST-');
      if (!isCustom && !['owner', 'manager'].includes(req.user.role)) {
        return res.status(403).json({ success: false, message: 'Only custom-made items can be tagged here. Ask the owner to change a catalog product.' });
      }
      await db.prepare('UPDATE products SET is_one_off = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(product.id);
      res.json({ success: true, data: { id: product.id, is_one_off: 1 } });
    } catch (err) { next(err); }
  }
);

// ─── POST /api/products/labels (label data: code, url, QR image) ───
router.post(
  '/labels',
  authenticate,
  authorize('owner', 'manager', 'employee', 'counter_staff', 'florist_staff'),
  [body('product_ids').isArray({ min: 1, max: 200 }), body('product_ids.*').isInt({ min: 1 })],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      // A production server without PUBLIC_APP_URL would print localhost links
      // that no phone can open once the labels are stuck on.
      if (publicUrlMissingInProduction()) {
        return res.status(409).json({ success: false, message: "Labels can't be printed yet — the shop's web address isn't set up. Ask the owner." });
      }
      const db = await getAsyncDb();
      const ids = [...new Set(req.body.product_ids.map(Number))];
      const host = publicUrlHost(PUBLIC_APP_URL);
      const out = [];
      for (const id of ids) {
        const p = await db.prepare('SELECT id, name, selling_price, price_mode, price_hint FROM products WHERE id = ?').get(id);
        if (!p) continue;
        const code = await ensureLabelCode(db, id);
        const url = labelUrl(code);
        const options = await db.prepare(
          'SELECT label, price FROM product_options WHERE product_id = ? AND is_active = 1 ORDER BY sort_order, id'
        ).all(id);
        out.push({
          product_id: p.id,
          name: p.name,
          price: Number(p.selling_price) || 0,
          price_mode: p.price_mode || 'fixed',
          price_hint: p.price_hint || null,
          label_code: code,
          url,
          url_host: host,
          options: options.map((o) => ({ label: o.label, price: Number(o.price) })),
          qr_data_url: await QRCode.toDataURL(url, { width: 300, margin: 1 }),
        });
      }
      res.json({ success: true, data: out });
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
  authorize('owner', 'manager', 'employee', 'counter_staff'),
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
  authorize('owner', 'manager', 'employee', 'counter_staff'),
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
// Selling-only lookup by scanned payload: legacy JSON, a /p/<code> URL, or a bare code.
// Never returns cost, stock quantities, supplier or material data.
const SCAN_UNKNOWN = 'This isn\'t one of our product codes. Try Find by name.';
const SCAN_OFF = 'Not for sale right now — ask the counter.';
const SCAN_SOLD = 'This one-off item is already sold. Check with the counter.';
const SCAN_CODE_RE = new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`);

// Returns { id } or { code } or null. Bare codes and URL codes are uppercased first.
function parseScanPayload(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  if (text.startsWith('{')) {
    try {
      const j = JSON.parse(text);
      const id = Number(j && j.id);
      if (j && j.type === 'bloomcart_product' && Number.isInteger(id) && id > 0) return { id };
    } catch { /* fall through */ }
    return null;
  }
  if (/^https?:\/\//i.test(text)) {
    let u;
    try { u = new URL(text); } catch { return null; }
    // /+ also accepts labels printed while PUBLIC_APP_URL ended in a slash (//p/CODE)
    const m = u.pathname.match(/^\/+p\/([^/]+)\/?$/);
    if (!m) return null;
    const code = m[1].toUpperCase();
    return SCAN_CODE_RE.test(code) ? { code } : null;
  }
  const code = text.toUpperCase();
  return SCAN_CODE_RE.test(code) ? { code } : null;
}

router.post('/scan', authenticate, async (req, res, next) => {
  try {
    const { payload } = req.body || {};
    const unknown = (status) => res.status(status).json({ success: false, message: SCAN_UNKNOWN });
    const parsed = parseScanPayload(payload);
    if (!parsed) return unknown(400);

    const db = await getAsyncDb();
    const cols = 'id, name, image_url, selling_price, price_mode, price_hint, is_one_off, is_active';
    const product = parsed.id
      ? await db.prepare(`SELECT ${cols} FROM products WHERE id = ?`).get(parsed.id)
      : await db.prepare(`SELECT ${cols} FROM products WHERE label_code = ?`).get(parsed.code);
    if (!product) return unknown(404);

    // Inventory lookup (purpose 'lookup') by owner/manager may open a
    // switched-off product so it can be found and switched back on. Every
    // other scan (the counter) still refuses it.
    const ownerLookup = req.body.purpose === 'lookup' && ['owner', 'manager'].includes(req.user.role);
    const active = Number(product.is_active) ? 1 : 0;
    if (!active && !ownerLookup) return res.status(409).json({ success: false, message: SCAN_OFF });

    const locationId = Number(req.body.location_id) || null;
    let inStock = false;
    if (locationId) {
      const st = await db.prepare('SELECT quantity FROM product_stock WHERE product_id = ? AND location_id = ?').get(product.id, locationId);
      inStock = !!st && Number(st.quantity) > 0;
    }
    if (Number(product.is_one_off) === 1 && locationId && !inStock) {
      return res.status(409).json({ success: false, message: SCAN_SOLD });
    }

    const options = await db.prepare(
      'SELECT id, label, price FROM product_options WHERE product_id = ? AND is_active = 1 ORDER BY sort_order, id'
    ).all(product.id);

    res.json({
      success: true,
      data: {
        id: product.id,
        name: product.name,
        image_url: product.image_url || null,
        selling_price: Number(product.selling_price) || 0,
        price_mode: product.price_mode || 'fixed',
        price_hint: product.price_hint || null,
        is_one_off: Number(product.is_one_off) === 1 ? 1 : 0,
        is_active: active,
        in_stock: inStock,
        options: options.map((o) => ({ id: o.id, label: o.label, price: Number(o.price) })),
      },
    });
  } catch (err) { next(err); }
});

module.exports = router;
