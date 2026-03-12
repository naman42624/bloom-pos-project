const express = require('express');
const { body, validationResult } = require('express-validator');
const { getDb } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

// ─── GET /api/purchase-orders ────────────────────────────────
router.get('/', authenticate, (req, res, next) => {
  try {
    const db = getDb();
    const { status, supplier_id, location_id, from_date, to_date } = req.query;

    let sql = `
      SELECT po.*, s.name as supplier_name, l.name as location_name,
             u.name as created_by_name
      FROM purchase_orders po
      JOIN suppliers s ON po.supplier_id = s.id
      JOIN locations l ON po.location_id = l.id
      JOIN users u ON po.created_by = u.id
    `;
    const conditions = [];
    const params = [];

    if (status) {
      conditions.push('po.status = ?');
      params.push(status);
    }
    if (supplier_id) {
      conditions.push('po.supplier_id = ?');
      params.push(supplier_id);
    }
    if (location_id) {
      conditions.push('po.location_id = ?');
      params.push(location_id);
    }
    if (from_date) {
      conditions.push('po.expected_date >= ?');
      params.push(from_date);
    }
    if (to_date) {
      conditions.push('po.expected_date <= ?');
      params.push(to_date);
    }

    if (conditions.length) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY po.created_at DESC';

    const orders = db.prepare(sql).all(...params);

    // Attach item counts
    const countStmt = db.prepare('SELECT COUNT(*) as count FROM purchase_order_items WHERE purchase_order_id = ?');
    let result = orders.map((o) => ({
      ...o,
      item_count: countStmt.get(o.id).count,
    }));

    // Hide pricing for non-owners when 'pricing' is not allowed
    if (req.user.role !== 'owner') {
      const setting = db.prepare("SELECT value FROM settings WHERE key = 'supplier_manager_fields'").get();
      const allowed = (setting?.value || 'name').split(',').map((f) => f.trim());
      if (!allowed.includes('pricing')) {
        result = result.map(({ total_amount, ...rest }) => rest);
      }
    }

    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/purchase-orders/:id ────────────────────────────
router.get('/:id', authenticate, (req, res, next) => {
  try {
    const db = getDb();
    const order = db.prepare(`
      SELECT po.*, s.name as supplier_name, s.phone as supplier_phone,
             l.name as location_name, u.name as created_by_name
      FROM purchase_orders po
      JOIN suppliers s ON po.supplier_id = s.id
      JOIN locations l ON po.location_id = l.id
      JOIN users u ON po.created_by = u.id
      WHERE po.id = ?
    `).get(req.params.id);

    if (!order) {
      return res.status(404).json({ success: false, message: 'Purchase order not found' });
    }

    // Get items
    let items = db.prepare(`
      SELECT poi.*, m.name as material_name, m.sku,
             mc.name as category_name, mc.unit as unit,
             mc.has_bundle, mc.default_bundle_size,
             ru.name as received_by_name
      FROM purchase_order_items poi
      JOIN materials m ON poi.material_id = m.id
      JOIN material_categories mc ON m.category_id = mc.id
      LEFT JOIN users ru ON poi.received_by = ru.id
      WHERE poi.purchase_order_id = ?
    `).all(req.params.id);

    let orderData = { ...order, items };

    // Hide pricing for non-owners when 'pricing' is not allowed
    if (req.user.role !== 'owner') {
      const setting = db.prepare("SELECT value FROM settings WHERE key = 'supplier_manager_fields'").get();
      const allowed = (setting?.value || 'name').split(',').map((f) => f.trim());
      if (!allowed.includes('pricing')) {
        const { total_amount, ...orderRest } = orderData;
        orderData = {
          ...orderRest,
          items: items.map(({ expected_price_per_unit, actual_price_per_unit, ...rest }) => rest),
        };
      }
    }

    res.json({ success: true, data: orderData });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/purchase-orders ───────────────────────────────
router.post(
  '/',
  authenticate,
  authorize('owner', 'manager'),
  [
    body('supplier_id').isInt().withMessage('Supplier is required'),
    body('location_id').isInt().withMessage('Location is required'),
    body('expected_date').optional({ nullable: true, checkFalsy: true }).isDate(),
    body('expected_time').optional({ nullable: true, checkFalsy: true }).trim(),
    body('notes').optional({ nullable: true, checkFalsy: true }).trim(),
    body('items').isArray({ min: 1 }).withMessage('At least one item is required'),
    body('items.*.material_id').isInt().withMessage('Material ID is required'),
    body('items.*.expected_quantity').isFloat({ gt: 0 }).withMessage('Quantity must be > 0'),
    body('items.*.expected_price_per_unit').optional().isFloat({ min: 0 }),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      }

      const { supplier_id, location_id, expected_date, expected_time, notes, items } = req.body;
      const db = getDb();

      // Validate supplier
      const supplier = db.prepare('SELECT id FROM suppliers WHERE id = ? AND is_active = 1').get(supplier_id);
      if (!supplier) {
        return res.status(400).json({ success: false, message: 'Invalid or inactive supplier' });
      }

      // Validate location
      const location = db.prepare('SELECT id FROM locations WHERE id = ? AND is_active = 1').get(location_id);
      if (!location) {
        return res.status(400).json({ success: false, message: 'Invalid or inactive location' });
      }

      // Generate PO number
      const poCount = db.prepare('SELECT COUNT(*) as count FROM purchase_orders').get();
      const po_number = `PO-${String(poCount.count + 1).padStart(5, '0')}`;

      // Calculate total
      let totalAmount = 0;
      for (const item of items) {
        totalAmount += (item.expected_quantity || 0) * (item.expected_price_per_unit || 0);
      }

      const createOrder = db.transaction(() => {
        const result = db.prepare(
          `INSERT INTO purchase_orders (po_number, supplier_id, location_id, expected_date, expected_time, notes, total_amount, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(po_number, supplier_id, location_id, expected_date || null, expected_time || null, notes || '', totalAmount, req.user.id);

        const orderId = result.lastInsertRowid;

        // Insert items
        const insertItem = db.prepare(
          `INSERT INTO purchase_order_items (purchase_order_id, material_id, expected_quantity, expected_unit, expected_price_per_unit)
           VALUES (?, ?, ?, ?, ?)`
        );

        const getMaterial = db.prepare(`
          SELECT mc.unit, mc.has_bundle, mc.default_bundle_size FROM materials m JOIN material_categories mc ON m.category_id = mc.id WHERE m.id = ?
        `);

        for (const item of items) {
          const mat = getMaterial.get(item.material_id);
          const baseUnit = mat ? mat.unit : 'pieces';
          // Use client-provided unit if valid, otherwise default to base unit
          const unit = (item.expected_unit === 'bundles' && mat && mat.has_bundle) ? 'bundles' : baseUnit;
          insertItem.run(orderId, item.material_id, item.expected_quantity, unit, item.expected_price_per_unit || 0);
        }

        return orderId;
      });

      const orderId = createOrder();

      // Return full order
      const order = db.prepare(`
        SELECT po.*, s.name as supplier_name, l.name as location_name
        FROM purchase_orders po
        JOIN suppliers s ON po.supplier_id = s.id
        JOIN locations l ON po.location_id = l.id
        WHERE po.id = ?
      `).get(orderId);

      const orderItems = db.prepare(`
        SELECT poi.*, m.name as material_name, m.sku
        FROM purchase_order_items poi
        JOIN materials m ON poi.material_id = m.id
        WHERE poi.purchase_order_id = ?
      `).all(orderId);

      res.status(201).json({ success: true, data: { ...order, items: orderItems } });
    } catch (err) {
      next(err);
    }
  }
);

// ─── PUT /api/purchase-orders/:id ────────────────────────────
// Update order metadata and optionally items (only when status is 'expected')
router.put(
  '/:id',
  authenticate,
  authorize('owner', 'manager'),
  [
    body('supplier_id').optional().isInt(),
    body('location_id').optional().isInt(),
    body('expected_date').optional({ nullable: true }).isDate(),
    body('expected_time').optional({ nullable: true, checkFalsy: true }).trim(),
    body('notes').optional({ nullable: true, checkFalsy: true }).trim(),
    body('status').optional().isIn(['expected', 'cancelled']),
    body('items').optional().isArray({ min: 1 }),
    body('items.*.material_id').optional().isInt(),
    body('items.*.expected_quantity').optional().isFloat({ gt: 0 }),
    body('items.*.expected_price_per_unit').optional().isFloat({ min: 0 }),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      }

      const db = getDb();
      const existing = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
      if (!existing) {
        return res.status(404).json({ success: false, message: 'Purchase order not found' });
      }

      if (existing.status === 'received' || existing.status === 'cancelled') {
        return res.status(400).json({ success: false, message: `Cannot update a ${existing.status} order` });
      }

      // Items can only be replaced when order hasn't been partially received
      if (req.body.items && existing.status !== 'expected') {
        return res.status(400).json({ success: false, message: 'Cannot modify items of a partially received order' });
      }

      const updateOrder = db.transaction(() => {
        const metaFields = ['supplier_id', 'location_id', 'expected_date', 'expected_time', 'notes', 'status'];
        const updates = [];
        const values = [];

        for (const field of metaFields) {
          if (req.body[field] !== undefined) {
            updates.push(`${field} = ?`);
            values.push(req.body[field]);
          }
        }

        // Replace items if provided
        if (req.body.items && req.body.items.length > 0) {
          db.prepare('DELETE FROM purchase_order_items WHERE purchase_order_id = ?').run(req.params.id);

          const insertItem = db.prepare(
            `INSERT INTO purchase_order_items (purchase_order_id, material_id, expected_quantity, expected_unit, expected_price_per_unit)
             VALUES (?, ?, ?, ?, ?)`
          );
          const getMaterial = db.prepare(
            `SELECT mc.unit, mc.has_bundle, mc.default_bundle_size FROM materials m JOIN material_categories mc ON m.category_id = mc.id WHERE m.id = ?`
          );

          let totalAmount = 0;
          for (const item of req.body.items) {
            const mat = getMaterial.get(item.material_id);
            const baseUnit = mat ? mat.unit : 'pieces';
            const unit = (item.expected_unit === 'bundles' && mat && mat.has_bundle) ? 'bundles' : baseUnit;
            insertItem.run(req.params.id, item.material_id, item.expected_quantity, unit, item.expected_price_per_unit || 0);
            totalAmount += (item.expected_quantity || 0) * (item.expected_price_per_unit || 0);
          }
          updates.push('total_amount = ?');
          values.push(totalAmount);
        }

        if (updates.length === 0) {
          return;
        }

        updates.push('updated_at = CURRENT_TIMESTAMP');
        values.push(req.params.id);
        db.prepare(`UPDATE purchase_orders SET ${updates.join(', ')} WHERE id = ?`).run(...values);
      });

      updateOrder();

      // Return updated order with joins
      const order = db.prepare(`
        SELECT po.*, s.name as supplier_name, l.name as location_name
        FROM purchase_orders po
        JOIN suppliers s ON po.supplier_id = s.id
        JOIN locations l ON po.location_id = l.id
        WHERE po.id = ?
      `).get(req.params.id);

      const orderItems = db.prepare(`
        SELECT poi.*, m.name as material_name, m.sku
        FROM purchase_order_items poi
        JOIN materials m ON poi.material_id = m.id
        WHERE poi.purchase_order_id = ?
      `).all(req.params.id);

      res.json({ success: true, data: { ...order, items: orderItems } });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /api/purchase-orders/:id/receive ───────────────────
// Receive items for a purchase order (partial or full)
router.post(
  '/:id/receive',
  authenticate,
  authorize('owner', 'manager', 'employee'),
  [
    body('items').isArray({ min: 1 }).withMessage('At least one item is required'),
    body('items.*.item_id').isInt().withMessage('Item ID is required'),
    body('items.*.received_quantity').isFloat({ min: 0 }).withMessage('Quantity must be >= 0'),
    body('items.*.received_quality').optional().isIn(['good', 'average', 'poor']),
    body('items.*.actual_price_per_unit').optional().isFloat({ min: 0 }),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      }

      const db = getDb();
      const order = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
      if (!order) {
        return res.status(404).json({ success: false, message: 'Purchase order not found' });
      }

      if (order.status === 'received' || order.status === 'cancelled') {
        return res.status(400).json({ success: false, message: `Cannot receive items for a ${order.status} order` });
      }

      // Employees can only receive at their assigned locations
      if (req.user.role === 'employee') {
        const assigned = db.prepare(
          'SELECT id FROM user_locations WHERE user_id = ? AND location_id = ?'
        ).get(req.user.id, order.location_id);
        if (!assigned) {
          return res.status(403).json({ success: false, message: 'You are not assigned to this location' });
        }
      }

      const receiveItems = db.transaction(() => {
        const updateItem = db.prepare(`
          UPDATE purchase_order_items
          SET received_quantity = received_quantity + ?, received_quality = ?, actual_price_per_unit = ?,
              received_by = ?, received_at = CURRENT_TIMESTAMP
          WHERE id = ? AND purchase_order_id = ?
        `);

        const getStockRow = db.prepare(
          'SELECT id FROM material_stock WHERE material_id = ? AND location_id = ? LIMIT 1'
        );
        const addStock = db.prepare(`
          UPDATE material_stock
          SET quantity = quantity + ?,
              last_counted_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `);
        const insertStock = db.prepare(`
          INSERT INTO material_stock (material_id, location_id, quantity, last_counted_at)
          VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        `);

        const insertTransaction = db.prepare(`
          INSERT INTO material_transactions (material_id, location_id, type, quantity, unit, reference_type, reference_id, notes, created_by)
          VALUES (?, ?, 'purchase', ?, ?, 'purchase_order', ?, ?, ?)
        `);

        const getBundleSize = db.prepare(`
          SELECT mc.default_bundle_size FROM materials m JOIN material_categories mc ON m.category_id = mc.id WHERE m.id = ?
        `);

        for (const item of req.body.items) {
          const poItem = db.prepare('SELECT * FROM purchase_order_items WHERE id = ? AND purchase_order_id = ?').get(item.item_id, req.params.id);
          if (!poItem) continue;

          // Skip items already fully received
          if (poItem.received_quantity >= poItem.expected_quantity) continue;

          // Cap the receive quantity to not exceed expected
          const maxReceivable = poItem.expected_quantity - poItem.received_quantity;
          const actualReceiveQty = Math.min(item.received_quantity, maxReceivable);
          if (actualReceiveQty <= 0) continue;

          updateItem.run(
            actualReceiveQty,
            item.received_quality || 'good',
            item.actual_price_per_unit ?? poItem.expected_price_per_unit,
            req.user.id,
            item.item_id,
            req.params.id
          );

          // Update stock — convert bundles to base units
          if (actualReceiveQty > 0) {
            let stockQty = actualReceiveQty;
            if (poItem.expected_unit === 'bundles') {
              const matInfo = getBundleSize.get(poItem.material_id);
              stockQty = actualReceiveQty * (matInfo ? matInfo.default_bundle_size : 1);
            }
            const stockRow = getStockRow.get(poItem.material_id, order.location_id);
            if (stockRow) {
              addStock.run(stockQty, stockRow.id);
            } else {
              insertStock.run(poItem.material_id, order.location_id, stockQty);
            }
            insertTransaction.run(
              poItem.material_id,
              order.location_id,
              actualReceiveQty,
              poItem.expected_unit,
              order.id,
              `Received from PO ${order.po_number}`,
              req.user.id
            );
          }
        }

        // Determine new order status
        const allItems = db.prepare('SELECT * FROM purchase_order_items WHERE purchase_order_id = ?').all(req.params.id);
        const allReceived = allItems.every((i) => i.received_quantity >= i.expected_quantity);
        const someReceived = allItems.some((i) => i.received_quantity > 0);

        let newStatus = order.status;
        if (allReceived) {
          newStatus = 'received';
        } else if (someReceived) {
          newStatus = 'partially_received';
        }

        // Recalculate total based on actual prices
        let totalAmount = 0;
        for (const i of allItems) {
          const price = i.actual_price_per_unit > 0 ? i.actual_price_per_unit : i.expected_price_per_unit;
          const qty = i.received_quantity > 0 ? i.received_quantity : i.expected_quantity;
          totalAmount += price * qty;
        }

        db.prepare('UPDATE purchase_orders SET status = ?, total_amount = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newStatus, totalAmount, req.params.id);
      });

      receiveItems();

      // Return updated order
      const updatedOrder = db.prepare(`
        SELECT po.*, s.name as supplier_name, l.name as location_name
        FROM purchase_orders po
        JOIN suppliers s ON po.supplier_id = s.id
        JOIN locations l ON po.location_id = l.id
        WHERE po.id = ?
      `).get(req.params.id);

      const updatedItems = db.prepare(`
        SELECT poi.*, m.name as material_name, m.sku
        FROM purchase_order_items poi
        JOIN materials m ON poi.material_id = m.id
        WHERE poi.purchase_order_id = ?
      `).all(req.params.id);

      res.json({ success: true, data: { ...updatedOrder, items: updatedItems } });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
