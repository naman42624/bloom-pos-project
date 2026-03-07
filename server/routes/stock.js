const express = require('express');
const { body, validationResult } = require('express-validator');
const { getDb } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

// ─── GET /api/stock?location_id=&material_id= ───────────────
// Get stock levels
router.get('/', authenticate, (req, res, next) => {
  try {
    const db = getDb();
    const { location_id, material_id, category_id } = req.query;

    let sql = `
      SELECT ms.*, m.name as material_name, m.sku, m.min_stock_alert,
             mc.name as category_name, mc.unit, l.name as location_name
      FROM material_stock ms
      JOIN materials m ON ms.material_id = m.id
      JOIN material_categories mc ON m.category_id = mc.id
      JOIN locations l ON ms.location_id = l.id
      WHERE m.is_active = 1
    `;
    const params = [];

    if (location_id) {
      sql += ' AND ms.location_id = ?';
      params.push(location_id);
    }
    if (material_id) {
      sql += ' AND ms.material_id = ?';
      params.push(material_id);
    }
    if (category_id) {
      sql += ' AND m.category_id = ?';
      params.push(category_id);
    }

    sql += ' ORDER BY mc.name ASC, m.name ASC';

    const stock = db.prepare(sql).all(...params);
    res.json({ success: true, data: stock });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/stock/adjust ──────────────────────────────────
// Manual stock adjustment (wastage, corrections)
router.post(
  '/adjust',
  authenticate,
  authorize('owner', 'manager', 'employee'),
  [
    body('material_id').isInt().withMessage('Material ID is required'),
    body('location_id').isInt().withMessage('Location ID is required'),
    body('type').isIn(['wastage', 'adjustment', 'usage', 'return']).withMessage('Invalid adjustment type'),
    body('quantity').isFloat().withMessage('Quantity is required'),
    body('notes').optional({ nullable: true, checkFalsy: true }).trim(),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      }

      const { material_id, location_id, type, quantity, notes } = req.body;
      const db = getDb();

      const adjust = db.transaction(() => {
        // Get current stock
        const currentStock = db.prepare(
          'SELECT * FROM material_stock WHERE material_id = ? AND location_id = ?'
        ).get(material_id, location_id);

        // For wastage/usage, quantity should be negative
        let stockChange = quantity;
        if ((type === 'wastage' || type === 'usage') && quantity > 0) {
          stockChange = -quantity;
        }

        if (currentStock) {
          const newQty = currentStock.quantity + stockChange;
          if (newQty < 0) {
            throw new Error('Insufficient stock for this operation');
          }
          db.prepare(
            'UPDATE material_stock SET quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
          ).run(newQty, currentStock.id);
        } else {
          if (stockChange < 0) {
            throw new Error('No stock exists to reduce');
          }
          db.prepare(
            'INSERT INTO material_stock (material_id, location_id, quantity) VALUES (?, ?, ?)'
          ).run(material_id, location_id, stockChange);
        }

        // Record transaction
        db.prepare(
          `INSERT INTO material_transactions (material_id, location_id, type, quantity, notes, created_by)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(material_id, location_id, type, Math.abs(quantity), notes || '', req.user.id);
      });

      try {
        adjust();
      } catch (txErr) {
        return res.status(400).json({ success: false, message: txErr.message });
      }

      // Return updated stock
      const updated = db.prepare(`
        SELECT ms.*, m.name as material_name, l.name as location_name
        FROM material_stock ms
        JOIN materials m ON ms.material_id = m.id
        JOIN locations l ON ms.location_id = l.id
        WHERE ms.material_id = ? AND ms.location_id = ?
      `).get(material_id, location_id);

      res.json({ success: true, data: updated });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/stock/transactions ─────────────────────────────
// Stock transaction history
router.get('/transactions', authenticate, (req, res, next) => {
  try {
    const db = getDb();
    const { material_id, location_id, type, from_date, to_date, limit } = req.query;

    let sql = `
      SELECT mt.*, m.name as material_name, m.sku,
             l.name as location_name, u.name as created_by_name
      FROM material_transactions mt
      JOIN materials m ON mt.material_id = m.id
      JOIN locations l ON mt.location_id = l.id
      LEFT JOIN users u ON mt.created_by = u.id
      WHERE 1=1
    `;
    const params = [];

    if (material_id) {
      sql += ' AND mt.material_id = ?';
      params.push(material_id);
    }
    if (location_id) {
      sql += ' AND mt.location_id = ?';
      params.push(location_id);
    }
    if (type) {
      sql += ' AND mt.type = ?';
      params.push(type);
    }
    if (from_date) {
      sql += ' AND mt.created_at >= ?';
      params.push(from_date);
    }
    if (to_date) {
      sql += ' AND mt.created_at <= ?';
      params.push(to_date + ' 23:59:59');
    }

    sql += ' ORDER BY mt.created_at DESC';

    const maxLimit = Math.min(parseInt(limit) || 50, 200);
    sql += ` LIMIT ${maxLimit}`;

    const transactions = db.prepare(sql).all(...params);
    res.json({ success: true, data: transactions });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/stock/reconcile ───────────────────────────────
// Daily stock reconciliation
router.post(
  '/reconcile',
  authenticate,
  authorize('owner', 'manager', 'employee'),
  [
    body('location_id').isInt().withMessage('Location ID is required'),
    body('entries').isArray({ min: 1 }).withMessage('At least one entry is required'),
    body('entries.*.material_id').isInt(),
    body('entries.*.closing_stock').isFloat({ min: 0 }),
    body('entries.*.wastage').optional().isFloat({ min: 0 }),
    body('entries.*.wastage_reason').optional({ nullable: true, checkFalsy: true }).trim(),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      }

      const { location_id, entries } = req.body;
      const db = getDb();
      const today = new Date().toISOString().split('T')[0];

      const reconcile = db.transaction(() => {
        for (const entry of entries) {
          // Get current stock as opening
          const currentStock = db.prepare(
            'SELECT quantity FROM material_stock WHERE material_id = ? AND location_id = ?'
          ).get(entry.material_id, location_id);
          const openingStock = currentStock ? currentStock.quantity : 0;

          // Sum of purchases today
          const purchased = db.prepare(`
            SELECT COALESCE(SUM(quantity), 0) as total
            FROM material_transactions
            WHERE material_id = ? AND location_id = ? AND type = 'purchase'
            AND DATE(created_at) = ?
          `).get(entry.material_id, location_id, today);

          const usedInProducts = openingStock + purchased.total - entry.closing_stock - (entry.wastage || 0);

          // Upsert daily log
          db.prepare(`
            INSERT INTO daily_stock_logs (location_id, material_id, date, opening_stock, received_stock, used_in_products, closing_stock, wastage, wastage_reason, counted_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(location_id, material_id, date) DO UPDATE SET
              closing_stock = excluded.closing_stock,
              wastage = excluded.wastage,
              wastage_reason = excluded.wastage_reason,
              used_in_products = excluded.used_in_products,
              counted_by = excluded.counted_by
          `).run(
            location_id,
            entry.material_id,
            today,
            openingStock,
            purchased.total,
            Math.max(usedInProducts, 0),
            entry.closing_stock,
            entry.wastage || 0,
            entry.wastage_reason || '',
            req.user.id
          );

          // Update actual stock to match closing count
          db.prepare(`
            INSERT INTO material_stock (material_id, location_id, quantity, last_counted_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(material_id, location_id) DO UPDATE SET
              quantity = excluded.quantity,
              last_counted_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
          `).run(entry.material_id, location_id, entry.closing_stock);

          // Record wastage transaction if any
          if (entry.wastage > 0) {
            db.prepare(
              `INSERT INTO material_transactions (material_id, location_id, type, quantity, notes, created_by)
               VALUES (?, ?, 'wastage', ?, ?, ?)`
            ).run(entry.material_id, location_id, entry.wastage, entry.wastage_reason || 'End of day wastage', req.user.id);
          }
        }
      });

      reconcile();
      res.json({ success: true, message: 'Stock reconciliation saved' });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/stock/reconcile?location_id=&date= ────────────
router.get('/reconcile', authenticate, (req, res, next) => {
  try {
    const db = getDb();
    const { location_id, date } = req.query;
    const targetDate = date || new Date().toISOString().split('T')[0];

    if (!location_id) {
      return res.status(400).json({ success: false, message: 'location_id is required' });
    }

    const logs = db.prepare(`
      SELECT dsl.*, m.name as material_name, m.sku, mc.name as category_name,
             u1.name as counted_by_name, u2.name as verified_by_name
      FROM daily_stock_logs dsl
      JOIN materials m ON dsl.material_id = m.id
      JOIN material_categories mc ON m.category_id = mc.id
      LEFT JOIN users u1 ON dsl.counted_by = u1.id
      LEFT JOIN users u2 ON dsl.verified_by = u2.id
      WHERE dsl.location_id = ? AND dsl.date = ?
      ORDER BY mc.name ASC, m.name ASC
    `).all(location_id, targetDate);

    res.json({ success: true, data: logs });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/stock/transfer ────────────────────────────────
// Initiate stock transfer between locations
router.post(
  '/transfer',
  authenticate,
  authorize('owner', 'manager'),
  [
    body('from_location_id').isInt().withMessage('Source location is required'),
    body('to_location_id').isInt().withMessage('Destination location is required'),
    body('material_id').isInt().withMessage('Material is required'),
    body('quantity').isFloat({ gt: 0 }).withMessage('Quantity must be > 0'),
    body('notes').optional({ nullable: true, checkFalsy: true }).trim(),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      }

      const { from_location_id, to_location_id, material_id, quantity, notes } = req.body;
      const db = getDb();

      if (from_location_id === to_location_id) {
        return res.status(400).json({ success: false, message: 'Source and destination cannot be the same' });
      }

      // Check available stock
      const stock = db.prepare(
        'SELECT quantity FROM material_stock WHERE material_id = ? AND location_id = ?'
      ).get(material_id, from_location_id);

      if (!stock || stock.quantity < quantity) {
        return res.status(400).json({ success: false, message: 'Insufficient stock at source location' });
      }

      // Get unit
      const mat = db.prepare(`
        SELECT mc.unit FROM materials m JOIN material_categories mc ON m.category_id = mc.id WHERE m.id = ?
      `).get(material_id);

      const result = db.prepare(
        `INSERT INTO stock_transfers (from_location_id, to_location_id, material_id, quantity, unit, initiated_by, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(from_location_id, to_location_id, material_id, quantity, mat ? mat.unit : 'pieces', req.user.id, notes || '');

      // Deduct from source immediately
      db.prepare('UPDATE material_stock SET quantity = quantity - ?, updated_at = CURRENT_TIMESTAMP WHERE material_id = ? AND location_id = ?')
        .run(quantity, material_id, from_location_id);

      db.prepare(
        `INSERT INTO material_transactions (material_id, location_id, type, quantity, unit, reference_type, reference_id, notes, created_by)
         VALUES (?, ?, 'transfer_out', ?, ?, 'stock_transfer', ?, ?, ?)`
      ).run(material_id, from_location_id, quantity, mat ? mat.unit : 'pieces', result.lastInsertRowid, `Transfer to location ${to_location_id}`, req.user.id);

      const transfer = db.prepare(`
        SELECT st.*, fl.name as from_location_name, tl.name as to_location_name,
               m.name as material_name, u.name as initiated_by_name
        FROM stock_transfers st
        JOIN locations fl ON st.from_location_id = fl.id
        JOIN locations tl ON st.to_location_id = tl.id
        JOIN materials m ON st.material_id = m.id
        JOIN users u ON st.initiated_by = u.id
        WHERE st.id = ?
      `).get(result.lastInsertRowid);

      res.status(201).json({ success: true, data: transfer });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/stock/transfers ────────────────────────────────
router.get('/transfers', authenticate, (req, res, next) => {
  try {
    const db = getDb();
    const { location_id, status } = req.query;

    let sql = `
      SELECT st.*, fl.name as from_location_name, tl.name as to_location_name,
             m.name as material_name, u.name as initiated_by_name,
             ru.name as received_by_name
      FROM stock_transfers st
      JOIN locations fl ON st.from_location_id = fl.id
      JOIN locations tl ON st.to_location_id = tl.id
      JOIN materials m ON st.material_id = m.id
      JOIN users u ON st.initiated_by = u.id
      LEFT JOIN users ru ON st.received_by = ru.id
      WHERE 1=1
    `;
    const params = [];

    if (location_id) {
      sql += ' AND (st.from_location_id = ? OR st.to_location_id = ?)';
      params.push(location_id, location_id);
    }
    if (status) {
      sql += ' AND st.status = ?';
      params.push(status);
    }

    sql += ' ORDER BY st.created_at DESC';

    const transfers = db.prepare(sql).all(...params);
    res.json({ success: true, data: transfers });
  } catch (err) {
    next(err);
  }
});

// ─── PUT /api/stock/transfers/:id/receive ────────────────────
// Receive a stock transfer at destination
router.put(
  '/transfers/:id/receive',
  authenticate,
  authorize('owner', 'manager', 'employee'),
  (req, res, next) => {
    try {
      const db = getDb();
      const transfer = db.prepare('SELECT * FROM stock_transfers WHERE id = ?').get(req.params.id);
      if (!transfer) {
        return res.status(404).json({ success: false, message: 'Transfer not found' });
      }

      if (transfer.status !== 'initiated' && transfer.status !== 'in_transit') {
        return res.status(400).json({ success: false, message: `Cannot receive a ${transfer.status} transfer` });
      }

      // Employees can only receive at their assigned locations
      if (req.user.role === 'employee') {
        const assigned = db.prepare(
          'SELECT id FROM user_locations WHERE user_id = ? AND location_id = ?'
        ).get(req.user.id, transfer.to_location_id);
        if (!assigned) {
          return res.status(403).json({ success: false, message: 'You are not assigned to the receiving location' });
        }
      }

      const receiveTransfer = db.transaction(() => {
        // Update transfer status
        db.prepare(
          'UPDATE stock_transfers SET status = ?, received_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
        ).run('received', req.user.id, req.params.id);

        // Add stock to destination
        db.prepare(`
          INSERT INTO material_stock (material_id, location_id, quantity)
          VALUES (?, ?, ?)
          ON CONFLICT(material_id, location_id) DO UPDATE SET
            quantity = quantity + excluded.quantity,
            updated_at = CURRENT_TIMESTAMP
        `).run(transfer.material_id, transfer.to_location_id, transfer.quantity);

        // Record transaction
        db.prepare(
          `INSERT INTO material_transactions (material_id, location_id, type, quantity, unit, reference_type, reference_id, notes, created_by)
           VALUES (?, ?, 'transfer_in', ?, ?, 'stock_transfer', ?, ?, ?)`
        ).run(
          transfer.material_id,
          transfer.to_location_id,
          transfer.quantity,
          transfer.unit,
          transfer.id,
          `Transfer from location ${transfer.from_location_id}`,
          req.user.id
        );
      });

      receiveTransfer();

      const updated = db.prepare(`
        SELECT st.*, fl.name as from_location_name, tl.name as to_location_name,
               m.name as material_name
        FROM stock_transfers st
        JOIN locations fl ON st.from_location_id = fl.id
        JOIN locations tl ON st.to_location_id = tl.id
        JOIN materials m ON st.material_id = m.id
        WHERE st.id = ?
      `).get(req.params.id);

      res.json({ success: true, data: updated });
    } catch (err) {
      next(err);
    }
  }
);

// ─── PUT /api/stock/transfers/:id/cancel ─────────────────────
router.put(
  '/transfers/:id/cancel',
  authenticate,
  authorize('owner', 'manager'),
  (req, res, next) => {
    try {
      const db = getDb();
      const transfer = db.prepare('SELECT * FROM stock_transfers WHERE id = ?').get(req.params.id);
      if (!transfer) {
        return res.status(404).json({ success: false, message: 'Transfer not found' });
      }

      if (transfer.status === 'received' || transfer.status === 'cancelled') {
        return res.status(400).json({ success: false, message: `Cannot cancel a ${transfer.status} transfer` });
      }

      const cancelTransfer = db.transaction(() => {
        // Return stock to source
        db.prepare(
          'UPDATE material_stock SET quantity = quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE material_id = ? AND location_id = ?'
        ).run(transfer.quantity, transfer.material_id, transfer.from_location_id);

        db.prepare(
          'UPDATE stock_transfers SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
        ).run('cancelled', req.params.id);

        // Record return transaction
        db.prepare(
          `INSERT INTO material_transactions (material_id, location_id, type, quantity, unit, reference_type, reference_id, notes, created_by)
           VALUES (?, ?, 'return', ?, ?, 'stock_transfer', ?, ?, ?)`
        ).run(
          transfer.material_id,
          transfer.from_location_id,
          transfer.quantity,
          transfer.unit,
          transfer.id,
          'Transfer cancelled, stock returned',
          req.user.id
        );
      });

      cancelTransfer();
      res.json({ success: true, message: 'Transfer cancelled, stock returned to source' });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
