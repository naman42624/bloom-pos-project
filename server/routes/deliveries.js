const express = require('express');
const { body, validationResult } = require('express-validator');
const { getDb } = require('../config/database');
const { getDb: getAsyncDb } = require('../config/database-async');
const { authenticate, authorize } = require('../middleware/auth');
const { createNotification, notifyByRole } = require('./notifications');
const { nowLocal } = require('../utils/time');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const router = express.Router();

function localDateStr(dt) {
  const d = dt || new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// Generate unique settlement number: SETL-DDMMYY-{seq}
function generateSettlementNumber(db, locationId) {
  const db2 = db;
  const today = new Date();
  const dd = String(today.getDate()).padStart(2, '0');
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const yy = String(today.getFullYear()).slice(-2);
  const dateCode = `${dd}${mm}${yy}`;
  
  // Get max sequence number for today
  const maxSeq = db2.prepare(
    `SELECT MAX(CAST(RIGHT(settlement_number, 3) AS INTEGER)) as max_seq
     FROM delivery_settlements
     WHERE location_id = ? AND settlement_date = ?`
  ).get(locationId, localDateStr());
  
  const nextSeq = (maxSeq?.max_seq || 0) + 1;
  return `SETL-${dateCode}-${String(nextSeq).padStart(3, '0')}`;
}

// ─── Photo upload config ────────────────────────────────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = path.join(__dirname, '..', 'uploads', 'delivery-proofs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `proof_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
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
      cb(new Error('Only JPEG/PNG/WebP images allowed'));
    }
  },
});

// ═══════════════════════════════════════════════════════════════
// DELIVERY MANAGEMENT
// ═══════════════════════════════════════════════════════════════

// ─── GET /api/deliveries ─────────────────────────────────────
// List deliveries with filters
router.get('/', authenticate, authorize('owner', 'manager', 'delivery_partner', 'employee'), async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const { location_id, status, delivery_partner_id, date_from, date_to, limit: lim, offset: off } = req.query;

    let sql = `
      SELECT d.*, s.sale_number, s.grand_total, s.payment_status, s.order_type,
             s.special_instructions,
             u.name as partner_name, u.phone as partner_phone,
             l.name as location_name,
             ab.name as assigned_by_name
      FROM deliveries d
      LEFT JOIN sales s ON d.sale_id = s.id
      LEFT JOIN users u ON d.delivery_partner_id = u.id
      LEFT JOIN locations l ON d.location_id = l.id
      LEFT JOIN users ab ON d.assigned_by = ab.id
      WHERE 1=1
    `;
    const params = [];

    // Delivery partners see only their own deliveries
    if (req.user.role === 'delivery_partner') {
      sql += ' AND d.delivery_partner_id = ?';
      params.push(req.user.id);
    }

    if (location_id) { sql += ' AND d.location_id = ?'; params.push(parseInt(location_id)); }
    if (status) {
      if (status === 'active') {
        sql += " AND d.status IN ('pending', 'assigned', 'picked_up', 'in_transit')";
      } else {
        sql += ' AND d.status = ?'; params.push(status);
      }
    }
    if (delivery_partner_id && req.user.role !== 'delivery_partner') {
      sql += ' AND d.delivery_partner_id = ?'; params.push(parseInt(delivery_partner_id));
    }
    if (date_from) { sql += ' AND DATE(d.created_at) >= ?'; params.push(date_from); }
    if (date_to) { sql += ' AND DATE(d.created_at) <= ?'; params.push(date_to); }

    // Scope managers to their locations
    if (req.user.role === 'manager' && !location_id) {
      const userLocs = (await db.prepare('SELECT location_id FROM user_locations WHERE user_id = ?').all(req.user.id)).map(r => r.location_id);
      if (userLocs.length > 0) {
        sql += ` AND d.location_id IN (${userLocs.map(() => '?').join(',')})`;
        params.push(...userLocs);
      }
    }

    sql += ' ORDER BY CASE d.status WHEN \'pending\' THEN 1 WHEN \'assigned\' THEN 2 WHEN \'picked_up\' THEN 3 WHEN \'in_transit\' THEN 4 WHEN \'delivered\' THEN 5 WHEN \'failed\' THEN 6 WHEN \'cancelled\' THEN 7 END, d.scheduled_date ASC NULLS LAST, d.created_at DESC';

    const limit = parseInt(lim) || 200;
    const offset = parseInt(off) || 0;
    sql += ' LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const deliveries = await db.prepare(sql).all(...params);

    // Get items for each delivery (include special instructions and image) in one batched query
    if (deliveries.length > 0) {
      const saleIds = [...new Set(deliveries.map((d) => d.sale_id))];
      const placeholders = saleIds.map(() => '?').join(',');
      const itemRows = await db.prepare(
        `SELECT sale_id, product_name, quantity, special_instructions as item_special_instructions, image_url as item_image_url, custom_materials
         FROM sale_items
         WHERE sale_id IN (${placeholders})`
      ).all(...saleIds);

      const itemsBySaleId = new Map();
      for (const row of itemRows) {
        const current = itemsBySaleId.get(row.sale_id) || [];
        current.push({
          product_name: row.product_name,
          quantity: row.quantity,
          item_special_instructions: row.item_special_instructions,
          item_image_url: row.item_image_url,
          custom_materials: row.custom_materials,
        });
        itemsBySaleId.set(row.sale_id, current);
      }

      for (const delivery of deliveries) {
        delivery.items = itemsBySaleId.get(delivery.sale_id) || [];
      }
    }

    res.json({ success: true, data: deliveries });
  } catch (err) { next(err); }
});

// ─── GET /api/deliveries/at-risk ─────────────────────────────
// Orders/deliveries not ready within 30 min of scheduled time
router.get('/at-risk', authenticate, authorize('owner', 'manager', 'employee'), async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const { location_id } = req.query;

    const now = new Date();
    const today = localDateStr(now);
    const in30Min = new Date(now.getTime() + 30 * 60 * 1000);
    const threshold = in30Min.toTimeString().slice(0, 5);

    let sql = `
      SELECT d.id as delivery_id, d.sale_id, d.scheduled_date, d.scheduled_time,
             d.status as delivery_status, d.delivery_address, d.customer_name, d.customer_phone,
             s.sale_number, s.status as order_status, s.order_type, s.grand_total,
             'delivery' as type
      FROM deliveries d
      LEFT JOIN sales s ON d.sale_id = s.id
      WHERE d.status IN ('pending', 'assigned')
        AND s.status NOT IN ('ready', 'completed', 'cancelled')
        AND d.scheduled_date IS NOT NULL
        AND (
          d.scheduled_date < ? OR
          (d.scheduled_date = ? AND d.scheduled_time IS NOT NULL AND d.scheduled_time <= ?)
        )
    `;
    const params = [today, today, threshold];

    if (location_id) {
      sql += ' AND d.location_id = ?';
      params.push(parseInt(location_id));
    }

    sql += `
      UNION ALL
      SELECT NULL as delivery_id, s2.id as sale_id, s2.scheduled_date, s2.scheduled_time,
             NULL as delivery_status, NULL as delivery_address, s2.customer_name, s2.customer_phone,
             s2.sale_number, s2.status as order_status, s2.order_type, s2.grand_total,
             'pickup' as type
      FROM sales s2
      WHERE s2.order_type = 'pickup'
        AND s2.pickup_status IN ('waiting')
        AND s2.status NOT IN ('ready', 'completed', 'cancelled')
        AND s2.scheduled_date IS NOT NULL
        AND (
          s2.scheduled_date < ? OR
          (s2.scheduled_date = ? AND s2.scheduled_time IS NOT NULL AND s2.scheduled_time <= ?)
        )
    `;
    params.push(today, today, threshold);

    if (location_id) {
      sql += ' AND s2.location_id = ?';
      params.push(parseInt(location_id));
    }

    sql += ' ORDER BY scheduled_date ASC, scheduled_time ASC';

    const atRisk = await db.prepare(sql).all(...params);

    res.json({ success: true, data: atRisk });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
// BATCH ASSIGN — assign multiple deliveries to one partner
// ═══════════════════════════════════════════════════════════════
router.post(
  '/batch-assign',
  authenticate,
  authorize('owner', 'manager'),
  (req, res, next) => {
    try {
      const db = getDb();
      const { delivery_ids, delivery_partner_id } = req.body;

      if (!Array.isArray(delivery_ids) || delivery_ids.length === 0) {
        return res.status(400).json({ success: false, message: 'delivery_ids array required.' });
      }
      if (!delivery_partner_id) {
        return res.status(400).json({ success: false, message: 'delivery_partner_id required.' });
      }

      const partner = db.prepare("SELECT id, name, role FROM users WHERE id = ? AND role = 'delivery_partner' AND is_active = 1").get(Number(delivery_partner_id));
      if (!partner) {
        return res.status(404).json({ success: false, message: 'Delivery partner not found or inactive.' });
      }

      const batchId = `BATCH-${Date.now()}-${req.user.id}`;
      const now = nowLocal();
      let assigned = 0;
      let skipped = 0;

      const assignStmt = db.prepare(`
        UPDATE deliveries 
        SET delivery_partner_id = ?, status = 'assigned', assigned_by = ?, assigned_at = ?, 
            batch_id = ?, failure_reason = NULL 
        WHERE id = ? AND status IN ('pending', 'assigned', 'failed')
      `);

      const assignAll = db.transaction(() => {
        for (const id of delivery_ids) {
          const result = assignStmt.run(Number(delivery_partner_id), req.user.id, now, batchId, Number(id));
          if (result.changes > 0) assigned++;
          else skipped++;
        }
      });

      assignAll();

      res.json({
        success: true,
        message: `Assigned ${assigned} deliveries to ${partner.name}. ${skipped > 0 ? `${skipped} skipped (invalid status).` : ''}`,
        data: { batch_id: batchId, assigned, skipped, partner_name: partner.name },
      });
    } catch (err) { next(err); }
  }
);

// ─── GET /api/deliveries/:id ─────────────────────────────────
router.get('/:id(\\d+)', authenticate, async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const delivery = await db.prepare(`
      SELECT d.*, s.sale_number, s.grand_total, s.payment_status, s.subtotal, s.tax_total,
             s.discount_amount, s.delivery_charges, s.order_type, s.special_instructions,
             s.customer_notes, s.sender_name, s.sender_phone, s.sender_message,
             u.name as partner_name, u.phone as partner_phone,
             l.name as location_name, l.address as location_address, l.phone as location_phone,
             ab.name as assigned_by_name
      FROM deliveries d
      LEFT JOIN sales s ON d.sale_id = s.id
      LEFT JOIN users u ON d.delivery_partner_id = u.id
      LEFT JOIN locations l ON d.location_id = l.id
      LEFT JOIN users ab ON d.assigned_by = ab.id
      WHERE d.id = ?
    `).get(req.params.id);

    if (!delivery) return res.status(404).json({ success: false, message: 'Delivery not found' });

    // Sale items
    delivery.items = await db.prepare(`
      SELECT si.*, p.sku as product_sku
      FROM sale_items si LEFT JOIN products p ON si.product_id = p.id
      WHERE si.sale_id = ?
    `).all(delivery.sale_id);

    // Payments on this sale
    delivery.payments = await db.prepare(`
      SELECT p.*, u.name as received_by_name
      FROM payments p LEFT JOIN users u ON p.received_by = u.id
      WHERE p.sale_id = ?
    `).all(delivery.sale_id);

    // Delivery proof
    delivery.proofs = await db.prepare(`
      SELECT dp.*, u.name as created_by_name
      FROM delivery_proofs dp LEFT JOIN users u ON dp.created_by = u.id
      WHERE dp.delivery_id = ?
    `).all(delivery.id);

    // COD collections
    delivery.collections = await db.prepare(`
      SELECT dc.*, u.name as collected_by_name
      FROM delivery_collections dc LEFT JOIN users u ON dc.collected_by = u.id
      WHERE dc.delivery_id = ?
    `).all(delivery.id);

    res.json({ success: true, data: delivery });
  } catch (err) { next(err); }
});

// ─── PUT /api/deliveries/:id/assign ──────────────────────────
// Manager/owner assigns a delivery partner
router.put(
  '/:id(\\d+)/assign',
  authenticate,
  authorize('owner', 'manager'),
  [body('delivery_partner_id').isInt().withMessage('Delivery partner ID required')],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });

      const db = getDb();
      const delivery = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(req.params.id);
      if (!delivery) return res.status(404).json({ success: false, message: 'Delivery not found' });
      if (!['pending', 'assigned', 'failed'].includes(delivery.status)) {
        return res.status(400).json({ success: false, message: `Cannot assign delivery in ${delivery.status} status` });
      }

      const { delivery_partner_id } = req.body;

      // Verify delivery partner exists and has correct role
      const partner = db.prepare("SELECT id, name FROM users WHERE id = ? AND role = 'delivery_partner' AND is_active = 1").get(delivery_partner_id);
      if (!partner) return res.status(404).json({ success: false, message: 'Delivery partner not found or inactive' });

      db.prepare(`
        UPDATE deliveries SET
          delivery_partner_id = ?, status = 'assigned', assigned_by = ?, assigned_at = ?,
          failure_reason = '', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(delivery_partner_id, req.user.id, nowLocal(), delivery.id);

      const updated = db.prepare(`
        SELECT d.*, u.name as partner_name FROM deliveries d
        LEFT JOIN users u ON d.delivery_partner_id = u.id WHERE d.id = ?
      `).get(delivery.id);

      res.json({ success: true, data: updated });

      // Notify delivery partner about new assignment
      createNotification({
        userIds: delivery_partner_id,
        title: 'New Delivery Assigned',
        body: `You have a new delivery to ${delivery.delivery_address || 'customer'}`,
        type: 'delivery',
        data: { deliveryId: delivery.id, screen: 'DeliveryDetail' },
      });
    } catch (err) { next(err); }
  }
);

// ─── PUT /api/deliveries/:id/pickup ──────────────────────────
// Delivery partner picks up order from shop
router.put(
  '/:id(\\d+)/pickup',
  authenticate,
  authorize('delivery_partner'),
  (req, res, next) => {
    try {
      const db = getDb();
      const delivery = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(req.params.id);
      if (!delivery) return res.status(404).json({ success: false, message: 'Delivery not found' });
      if (delivery.delivery_partner_id !== req.user.id) {
        return res.status(403).json({ success: false, message: 'Not assigned to you' });
      }
      if (delivery.status !== 'assigned') {
        return res.status(400).json({ success: false, message: `Cannot pick up delivery in ${delivery.status} status` });
      }

      // Check sale status — should be 'ready' before pickup
      const sale = db.prepare('SELECT status FROM sales WHERE id = ?').get(delivery.sale_id);
      if (sale && !['ready', 'completed'].includes(sale.status)) {
        return res.status(400).json({ success: false, message: 'Order is not ready for pickup yet' });
      }

      db.prepare(`
        UPDATE deliveries SET status = 'picked_up', pickup_time = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(nowLocal(), delivery.id);

      const updated = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(delivery.id);
      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  }
);

// ─── PUT /api/deliveries/:id/in-transit ──────────────────────
// Delivery partner marks they're on the way
router.put(
  '/:id(\\d+)/in-transit',
  authenticate,
  authorize('delivery_partner'),
  (req, res, next) => {
    try {
      const db = getDb();
      const delivery = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(req.params.id);
      if (!delivery) return res.status(404).json({ success: false, message: 'Delivery not found' });
      if (delivery.delivery_partner_id !== req.user.id) {
        return res.status(403).json({ success: false, message: 'Not assigned to you' });
      }
      if (delivery.status !== 'picked_up') {
        return res.status(400).json({ success: false, message: `Cannot mark in-transit from ${delivery.status} status` });
      }

      db.prepare("UPDATE deliveries SET status = 'in_transit', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(delivery.id);

      const updated = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(delivery.id);
      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  }
);

// ─── PUT /api/deliveries/:id/deliver ─────────────────────────
// Mark as delivered — optionally with proof + COD collection
router.put(
  '/:id(\\d+)/deliver',
  authenticate,
  authorize('delivery_partner'),
  [
    body('delivery_notes').optional().trim(),
    body('cod_collected').optional().isFloat({ min: 0 }),
    body('cod_method').optional().isIn(['cash', 'upi']),
    body('cod_reference').optional().trim(),
    body('latitude').optional().isFloat(),
    body('longitude').optional().isFloat(),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });

      const db = getDb();
      const delivery = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(req.params.id);
      if (!delivery) return res.status(404).json({ success: false, message: 'Delivery not found' });
      if (delivery.delivery_partner_id !== req.user.id) {
        return res.status(403).json({ success: false, message: 'Not assigned to you' });
      }
      if (!['picked_up', 'in_transit'].includes(delivery.status)) {
        return res.status(400).json({ success: false, message: `Cannot deliver from ${delivery.status} status` });
      }

      const { delivery_notes, cod_collected, cod_method, cod_reference, latitude, longitude } = req.body;

      const deliverTx = db.transaction(() => {
        // Record COD collection if any
        let totalCodCollected = delivery.cod_collected;
        if (cod_collected && cod_collected > 0) {
          if (cod_collected > delivery.cod_amount - delivery.cod_collected) {
            throw new Error('COD collection exceeds remaining amount');
          }
          db.prepare(
            'INSERT INTO delivery_collections (delivery_id, amount, method, reference_number, collected_by, created_at) VALUES (?, ?, ?, ?, ?, ?)'
          ).run(delivery.id, cod_collected, cod_method || 'cash', cod_reference || null, req.user.id, nowLocal());
          totalCodCollected += cod_collected;

          // Create payment record on the sale
          db.prepare(
            'INSERT INTO payments (sale_id, method, amount, reference_number, received_by, created_at) VALUES (?, ?, ?, ?, ?, ?)'
          ).run(delivery.sale_id, cod_method || 'cash', cod_collected, cod_reference ? `COD-${cod_reference}` : 'COD', req.user.id, nowLocal());

          // Recalculate payment status on the sale
          const sale = db.prepare('SELECT grand_total FROM sales WHERE id = ?').get(delivery.sale_id);
          const totalPaid = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE sale_id = ?').get(delivery.sale_id).total;
          let paymentStatus = 'pending';
          if (totalPaid >= sale.grand_total) paymentStatus = 'paid';
          else if (totalPaid > 0) paymentStatus = 'partial';
          db.prepare('UPDATE sales SET payment_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(paymentStatus, delivery.sale_id);
        }

        // Determine COD status
        let codStatus = delivery.cod_status;
        if (delivery.cod_amount > 0) {
          if (totalCodCollected >= delivery.cod_amount) codStatus = 'collected';
          else if (totalCodCollected > 0) codStatus = 'partial';
          else codStatus = 'pending';
        }

        // Record delivery proof
        if (latitude || longitude) {
          db.prepare(
            'INSERT INTO delivery_proofs (delivery_id, latitude, longitude, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)'
          ).run(delivery.id, latitude || null, longitude || null, delivery_notes || '', req.user.id, nowLocal());
        }

        // Update delivery
        db.prepare(`
          UPDATE deliveries SET
            status = 'delivered', delivered_time = ?,
            cod_collected = ?, cod_status = ?,
            delivery_notes = COALESCE(?, delivery_notes),
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(nowLocal(), totalCodCollected, codStatus, delivery_notes || null, delivery.id);

        // Mark sale as completed
        db.prepare("UPDATE sales SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(delivery.sale_id);
      });

      deliverTx();

      const updated = db.prepare(`
        SELECT d.*, s.sale_number, s.payment_status
        FROM deliveries d LEFT JOIN sales s ON d.sale_id = s.id
        WHERE d.id = ?
      `).get(delivery.id);

      res.json({ success: true, data: updated });

      // Notify customer about delivery completion
      const sale = db.prepare('SELECT customer_id, sale_number FROM sales WHERE id = ?').get(delivery.sale_id);
      if (sale?.customer_id) {
        createNotification({
          userIds: sale.customer_id,
          title: 'Order Delivered',
          body: `Your order ${sale.sale_number} has been delivered successfully!`,
          type: 'order_status',
          data: { saleId: delivery.sale_id, screen: 'CustomerOrderDetail' },
        });
      }
    } catch (err) {
      if (err.message.includes('COD collection exceeds')) {
        return res.status(400).json({ success: false, message: err.message });
      }
      next(err);
    }
  }
);

// ─── PUT /api/deliveries/:id/fail ────────────────────────────
// Delivery failed (customer not home, refused, wrong address, etc.)
router.put(
  '/:id(\\d+)/fail',
  authenticate,
  authorize('delivery_partner'),
  [body('failure_reason').trim().notEmpty().withMessage('Reason required')],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });

      const db = getDb();
      const delivery = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(req.params.id);
      if (!delivery) return res.status(404).json({ success: false, message: 'Delivery not found' });
      if (delivery.delivery_partner_id !== req.user.id) {
        return res.status(403).json({ success: false, message: 'Not assigned to you' });
      }
      if (!['picked_up', 'in_transit'].includes(delivery.status)) {
        return res.status(400).json({ success: false, message: `Cannot fail delivery from ${delivery.status} status` });
      }

      db.prepare(`
        UPDATE deliveries SET status = 'failed', failure_reason = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(req.body.failure_reason, delivery.id);

      // Set sale back to ready so it can be re-assigned
      db.prepare("UPDATE sales SET status = 'ready', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(delivery.sale_id);

      const updated = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(delivery.id);
      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  }
);

// ─── PUT /api/deliveries/:id/reattempt ───────────────────────
// Reset a failed delivery back to 'assigned' for another attempt
router.put('/:id(\\d+)/reattempt', authenticate, authorize('owner', 'manager'), (req, res, next) => {
  try {
    const db = getDb();
    const delivery = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(req.params.id);
    if (!delivery) return res.status(404).json({ success: false, message: 'Delivery not found' });
    if (delivery.status !== 'failed') {
      return res.status(400).json({ success: false, message: 'Only failed deliveries can be reattempted' });
    }

    db.prepare(`
      UPDATE deliveries
      SET status = 'assigned', failure_reason = NULL, pickup_time = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(delivery.id);

    // Set sale back to 'confirmed' so it's queued again
    db.prepare("UPDATE sales SET status = 'confirmed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(delivery.sale_id);

    const updated = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(delivery.id);
    res.json({ success: true, data: updated, message: 'Delivery reset for reattempt' });
  } catch (err) { next(err); }
});

// ─── PUT /api/deliveries/:id/cancel ──────────────────────────
// Cancel a delivery (manager/owner). Adds prepared items to product_stock.
router.put('/:id(\\d+)/cancel', authenticate, authorize('owner', 'manager'), (req, res, next) => {
  try {
    const db = getDb();
    const delivery = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(req.params.id);
    if (!delivery) return res.status(404).json({ success: false, message: 'Delivery not found' });
    if (['delivered', 'cancelled'].includes(delivery.status)) {
      return res.status(400).json({ success: false, message: `Cannot cancel a ${delivery.status} delivery` });
    }

    const cancelTx = db.transaction(() => {
      db.prepare(`
        UPDATE deliveries SET status = 'cancelled', failure_reason = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(req.body.reason || 'Cancelled by manager', delivery.id);

      // Add prepared products back to stock (for walk-in resale)
      const completedTasks = db.prepare(`
        SELECT pt.*, si.product_id, si.quantity
        FROM production_tasks pt
        JOIN sale_items si ON pt.sale_item_id = si.id
        WHERE pt.sale_id = ? AND pt.status = 'completed' AND si.product_id IS NOT NULL
      `).all(delivery.sale_id);

      for (const task of completedTasks) {
        if (task.product_id && task.quantity) {
          const existing = db.prepare('SELECT id FROM product_stock WHERE product_id = ? AND location_id = ?')
            .get(task.product_id, delivery.location_id || 1);
          if (existing) {
            db.prepare('UPDATE product_stock SET quantity = quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
              .run(task.quantity, existing.id);
          } else {
            try {
              db.prepare('INSERT INTO product_stock (product_id, location_id, quantity) VALUES (?, ?, ?)')
                .run(task.product_id, delivery.location_id || 1, task.quantity);
            } catch (e) { /* product_stock may not exist */ }
          }
        }
      }
    });

    cancelTx();
    const updated = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(delivery.id);
    res.json({ success: true, data: updated, message: 'Delivery cancelled' });
  } catch (err) { next(err); }
});

// ─── POST /api/deliveries/:id/proof ──────────────────────────
// Upload delivery proof photo
router.post(
  '/:id(\\d+)/proof',
  authenticate,
  authorize('delivery_partner'),
  upload.single('photo'),
  (req, res, next) => {
    try {
      const db = getDb();
      const delivery = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(req.params.id);
      if (!delivery) return res.status(404).json({ success: false, message: 'Delivery not found' });
      if (delivery.delivery_partner_id !== req.user.id) {
        return res.status(403).json({ success: false, message: 'Not assigned to you' });
      }

      const photoUrl = req.file ? `/uploads/delivery-proofs/${req.file.filename}` : null;
      const { latitude, longitude, notes } = req.body;

      const result = db.prepare(
        'INSERT INTO delivery_proofs (delivery_id, photo_url, latitude, longitude, notes, created_by) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(delivery.id, photoUrl, latitude || null, longitude || null, notes || '', req.user.id);

      const proof = db.prepare('SELECT * FROM delivery_proofs WHERE id = ?').get(result.lastInsertRowid);
      res.status(201).json({ success: true, data: proof });
    } catch (err) { next(err); }
  }
);

// ═══════════════════════════════════════════════════════════════
// COD SETTLEMENT
// ═══════════════════════════════════════════════════════════════

// ─── GET /api/deliveries/settlements/unsettled ───────────────
// Get deliveries with COD that haven't been settled yet (for a partner)
router.get('/settlements/unsettled', authenticate, authorize('owner', 'manager', 'delivery_partner'), async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const { delivery_partner_id } = req.query;
    
    const partnerId = req.user.role === 'delivery_partner' ? req.user.id : parseInt(delivery_partner_id);
    if (!partnerId) return res.status(400).json({ success: false, message: 'delivery_partner_id required' });

    const unsettled = await db.prepare(`
      SELECT d.id, d.sale_id, d.cod_amount, d.cod_collected, d.cod_status, d.delivered_time,
             s.sale_number, d.customer_name, d.customer_phone
      FROM deliveries d
      LEFT JOIN sales s ON d.sale_id = s.id
      WHERE d.delivery_partner_id = ? AND d.status = 'delivered'
        AND d.cod_collected > 0 AND d.cod_status IN ('collected', 'partial')
        AND d.id NOT IN (SELECT delivery_id FROM delivery_settlement_items)
      ORDER BY d.delivered_time ASC
    `).all(partnerId);

    const totalUnsettled = unsettled.reduce((s, d) => s + d.cod_collected, 0);

    res.json({ success: true, data: { deliveries: unsettled, total_unsettled: totalUnsettled } });
  } catch (err) { next(err); }
});

// ─── POST /api/deliveries/settlements ────────────────────────
// Create a settlement — partner hands over collected COD money
router.post(
  '/settlements',
  authenticate,
  authorize('owner', 'manager'),
  [
    body('delivery_partner_id').isInt(),
    body('delivery_ids').isArray({ min: 1 }).withMessage('At least one delivery required'),
    body('location_id').optional({ nullable: true }).isInt(),
    body('notes').optional().trim(),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });

      const db = getDb();
      const { delivery_partner_id, delivery_ids, notes } = req.body;
      // Derive location_id from first delivery if not explicitly provided
      let location_id = req.body.location_id;
      if (!location_id && delivery_ids && delivery_ids.length > 0) {
        const firstDel = db.prepare('SELECT location_id FROM deliveries WHERE id = ?').get(delivery_ids[0]);
        location_id = firstDel ? firstDel.location_id : null;
      }

      const settleTx = db.transaction(() => {
        let totalAmount = 0;

        // Verify all deliveries belong to this partner and are unsettled
        for (const did of delivery_ids) {
          const d = db.prepare(
            "SELECT * FROM deliveries WHERE id = ? AND delivery_partner_id = ? AND status = 'delivered' AND cod_collected > 0"
          ).get(did, delivery_partner_id);
          if (!d) throw new Error(`Delivery #${did} not found or not eligible for settlement`);

          // Check not already settled
          const already = db.prepare('SELECT id FROM delivery_settlement_items WHERE delivery_id = ?').get(did);
          if (already) throw new Error(`Delivery #${did} is already settled`);

          totalAmount += d.cod_collected;
        }

        // Generate settlement number and calculate commission/net
        const settlementNumber = generateSettlementNumber(db, location_id);
        const commissionPercentage = 5.0; // 5% standard commission
        const commissionAmount = totalAmount * (commissionPercentage / 100);
        const netAmount = totalAmount - commissionAmount;
        const today = localDateStr();

        // Create settlement with new fields — include partner_id (NOT NULL in schema)
        const result = db.prepare(
          `INSERT INTO delivery_settlements 
           (partner_id, delivery_partner_id, location_id, total_amount, total_deliveries, status, notes, 
            settlement_number, settlement_date, period_start, period_end, 
            commission_percentage, commission_amount, net_amount)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          delivery_partner_id, delivery_partner_id, location_id, totalAmount, delivery_ids.length, notes || '',
          settlementNumber, today, today, today,
          commissionPercentage, commissionAmount, netAmount
        );

        const settlementId = result.lastInsertRowid;

        // Link deliveries
        const insertItem = db.prepare(
          'INSERT INTO delivery_settlement_items (settlement_id, delivery_id, amount) VALUES (?, ?, ?)'
        );
        for (const did of delivery_ids) {
          const d = db.prepare('SELECT cod_collected FROM deliveries WHERE id = ?').get(did);
          insertItem.run(settlementId, did, d.cod_collected);
          // Mark delivery COD as settled
          db.prepare("UPDATE deliveries SET cod_status = 'collected', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(did);
        }

        return settlementId;
      });

      const settlementId = settleTx();
      const settlement = db.prepare(`
        SELECT ds.*, u.name as partner_name
        FROM delivery_settlements ds LEFT JOIN users u ON ds.delivery_partner_id = u.id
        WHERE ds.id = ?
      `).get(settlementId);

      res.status(201).json({ success: true, data: settlement });
    } catch (err) {
      if (err.message.includes('not found') || err.message.includes('already settled')) {
        return res.status(400).json({ success: false, message: err.message });
      }
      next(err);
    }
  }
);

// ─── PUT /api/deliveries/settlements/:id/verify ──────────────
// Manager/owner verifies the settlement (confirms money received)
router.put(
  '/settlements/:id(\\d+)/verify',
  authenticate,
  authorize('owner', 'manager'),
  (req, res, next) => {
    try {
      const db = getDb();
      const settlement = db.prepare('SELECT * FROM delivery_settlements WHERE id = ?').get(req.params.id);
      if (!settlement) return res.status(404).json({ success: false, message: 'Settlement not found' });
      if (settlement.status === 'verified') return res.status(400).json({ success: false, message: 'Already verified' });

      const verifyTx = db.transaction(() => {
        // Count successful and failed deliveries in this settlement
        const deliveryStats = db.prepare(`
          SELECT 
            COUNT(*) as total,
            SUM(CASE WHEN d.status = 'delivered' THEN 1 ELSE 0 END) as successful,
            SUM(CASE WHEN d.status IN ('cancelled', 'failed', 'returned') THEN 1 ELSE 0 END) as failed
          FROM delivery_settlement_items dsi
          JOIN deliveries d ON dsi.delivery_id = d.id
          WHERE dsi.settlement_id = ?
        `).get(settlement.id);

        db.prepare(`
          UPDATE delivery_settlements 
          SET status = 'verified', 
              verified_by = ?, 
              verified_at = CURRENT_TIMESTAMP,
              successful_deliveries = ?,
              failed_deliveries = ?
          WHERE id = ?
        `).run(
          req.user.id, 
          deliveryStats?.successful || 0,
          deliveryStats?.failed || 0,
          settlement.id
        );

        // Add the settled cash to the cash register
        const today = localDateStr();
        const register = db.prepare('SELECT id FROM cash_registers WHERE location_id = ? AND date = ?').get(settlement.location_id, today);
        if (register) {
          db.prepare('UPDATE cash_registers SET total_cash_sales = total_cash_sales + ?, expected_cash = opening_balance + total_cash_sales + ? - total_refunds_cash WHERE id = ?')
            .run(settlement.net_amount, settlement.net_amount, register.id);
        }
      });

      verifyTx();

      const updated = db.prepare(`
        SELECT ds.*, u.name as partner_name, v.name as verified_by_name
        FROM delivery_settlements ds
        LEFT JOIN users u ON ds.delivery_partner_id = u.id
        LEFT JOIN users v ON ds.verified_by = v.id
        WHERE ds.id = ?
      `).get(settlement.id);

      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  }
);

// ─── GET /api/deliveries/settlements ─────────────────────────
// List settlements
router.get('/settlements', authenticate, authorize('owner', 'manager'), async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const { delivery_partner_id, status, limit: lim } = req.query;

    let sql = `
      SELECT ds.*, u.name as partner_name, v.name as verified_by_name
      FROM delivery_settlements ds
      LEFT JOIN users u ON ds.delivery_partner_id = u.id
      LEFT JOIN users v ON ds.verified_by = v.id
      WHERE 1=1
    `;
    const params = [];

    if (delivery_partner_id) { sql += ' AND ds.delivery_partner_id = ?'; params.push(parseInt(delivery_partner_id)); }
    if (status) { sql += ' AND ds.status = ?'; params.push(status); }

    sql += ' ORDER BY ds.created_at DESC LIMIT ?';
    params.push(parseInt(lim) || 50);

    const settlements = await db.prepare(sql).all(...params);
    res.json({ success: true, data: settlements });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
// PICKUP ORDERS
// ═══════════════════════════════════════════════════════════════

// ─── PUT /api/deliveries/pickup/:saleId/ready ────────────────
// Mark a pickup order as ready for customer pickup
router.put(
  '/pickup/:saleId/ready',
  authenticate,
  authorize('owner', 'manager', 'employee'),
  (req, res, next) => {
    try {
      const db = getDb();
      const sale = db.prepare("SELECT * FROM sales WHERE id = ? AND order_type = 'pickup'").get(req.params.saleId);
      if (!sale) return res.status(404).json({ success: false, message: 'Pickup order not found' });

      const markReadyTx = db.transaction(() => {
        const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(sale.id);
        const getMaterialStock = db.prepare('SELECT quantity FROM material_stock WHERE material_id = ? AND location_id = ?');
        const deductMaterialStock = db.prepare('UPDATE material_stock SET quantity = quantity - ?, updated_at = CURRENT_TIMESTAMP WHERE material_id = ? AND location_id = ?');
        const getProductStock = db.prepare('SELECT quantity FROM product_stock WHERE product_id = ? AND location_id = ?');
        const deductProductStock = db.prepare('UPDATE product_stock SET quantity = quantity - ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND location_id = ?');
        const getBom = db.prepare('SELECT material_id, quantity FROM product_materials WHERE product_id = ?');
        const markDeducted = db.prepare('UPDATE sale_items SET materials_deducted = 1 WHERE id = ?');
        const markFromStock = db.prepare('UPDATE sale_items SET from_product_stock = 1, materials_deducted = 1 WHERE id = ?');
        const logMaterialTx = db.prepare(`
          INSERT INTO material_transactions
          (material_id, location_id, type, quantity, reference_type, reference_id, notes, created_by)
          VALUES (?, ?, 'usage', ?, 'sale', ?, ?, ?)
        `);

        for (const item of items) {
          if (item.materials_deducted) continue;

          if (item.material_id) {
            const stock = getMaterialStock.get(item.material_id, sale.location_id);
            const available = stock ? Number(stock.quantity || 0) : 0;
            const required = Number(item.quantity || 0);
            if (available < required) {
              throw new Error(`Insufficient material stock for ${item.product_name || 'item'}. Available ${available}, required ${required}`);
            }
            deductMaterialStock.run(required, item.material_id, sale.location_id);
            logMaterialTx.run(item.material_id, sale.location_id, required, sale.id, `Pickup ready ${sale.sale_number}`, req.user.id);
            markDeducted.run(item.id);
            continue;
          }

          if (item.product_id) {
            const required = Number(item.quantity || 0);
            const readyStock = getProductStock.get(item.product_id, sale.location_id);
            const availableProduct = readyStock ? Number(readyStock.quantity || 0) : 0;

            if (availableProduct >= required) {
              deductProductStock.run(required, item.product_id, sale.location_id);
              markFromStock.run(item.id);
              continue;
            }

            const bom = getBom.all(item.product_id);
            if (!bom.length) {
              throw new Error(`Insufficient product stock for ${item.product_name || 'item'} and no BOM configured`);
            }

            for (const bomItem of bom) {
              const reqQty = Number(bomItem.quantity || 0) * required;
              const mStock = getMaterialStock.get(bomItem.material_id, sale.location_id);
              const mAvailable = mStock ? Number(mStock.quantity || 0) : 0;
              if (mAvailable < reqQty) {
                throw new Error(`Insufficient BOM stock for ${item.product_name || 'item'}. Required ${reqQty}, available ${mAvailable}`);
              }
            }

            for (const bomItem of bom) {
              const reqQty = Number(bomItem.quantity || 0) * required;
              deductMaterialStock.run(reqQty, bomItem.material_id, sale.location_id);
              logMaterialTx.run(bomItem.material_id, sale.location_id, reqQty, sale.id, `Pickup ready ${sale.sale_number}`, req.user.id);
            }
            markDeducted.run(item.id);
          }
        }

        db.prepare(`
          UPDATE sales
          SET pickup_status = 'ready_for_pickup', status = 'ready', stock_deducted = 1, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(sale.id);
      });

      markReadyTx();

      res.json({ success: true, message: 'Order marked as ready for pickup' });
    } catch (err) {
      const msg = String(err?.message || '');
      if (msg.toLowerCase().includes('insufficient')) {
        return res.status(400).json({ success: false, message: msg });
      }
      next(err);
    }
  }
);

// ─── PUT /api/deliveries/pickup/:saleId/picked-up ────────────
// Customer has picked up the order
router.put(
  '/pickup/:saleId/picked-up',
  authenticate,
  authorize('owner', 'manager', 'employee'),
  (req, res, next) => {
    try {
      const db = getDb();
      const sale = db.prepare("SELECT * FROM sales WHERE id = ? AND order_type = 'pickup'").get(req.params.saleId);
      if (!sale) return res.status(404).json({ success: false, message: 'Pickup order not found' });

      // Validate: sale must be ready before pickup
      if (sale.status !== 'ready' && sale.status !== 'completed') {
        // Check if all production tasks are done
        const incompleteTasks = db.prepare(
          "SELECT COUNT(*) as cnt FROM production_tasks WHERE sale_id = ? AND status != 'completed'"
        ).get(sale.id);
        if (incompleteTasks.cnt > 0) {
          return res.status(400).json({
            success: false,
            message: `Cannot complete pickup: ${incompleteTasks.cnt} production task(s) still pending. Complete production first.`,
          });
        }
      }

      // Validate: stock must be deducted
      if (!sale.stock_deducted) {
        return res.status(400).json({
          success: false,
          message: 'Cannot complete pickup: inventory has not been deducted. Please fulfill stock from production queue first.',
        });
      }

      const { payment_method, payment_amount, payment_reference } = req.body || {};

      const pickupTx = db.transaction(() => {
        // If there's a balance due, require payment (manager/owner only can confirm)
        const totalPaid = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE sale_id = ?').get(sale.id).total;
        const balanceDue = sale.grand_total - totalPaid;

        if (balanceDue > 0.01) {
          // Only manager/owner can confirm pickup with payment
          if (req.user.role !== 'owner' && req.user.role !== 'manager') {
            throw new Error('Only manager/owner can confirm pickup payment');
          }
          const paidNow = parseFloat(payment_amount) || 0;
          if (paidNow <= 0) {
            throw new Error(`Balance due: ₹${balanceDue.toFixed(2)}. Please collect payment before marking as picked up.`);
          }
          // Record the payment
          db.prepare(
            'INSERT INTO payments (sale_id, method, amount, reference_number, received_by) VALUES (?, ?, ?, ?, ?)'
          ).run(sale.id, payment_method || 'cash', paidNow, payment_reference ? `PICKUP-${payment_reference}` : 'PICKUP', req.user.id);

          // Update cash register
          const today = localDateStr();
          const register = db.prepare('SELECT id FROM cash_registers WHERE location_id = ? AND date = ?').get(sale.location_id, today);
          if (register) {
            if ((payment_method || 'cash') === 'cash') {
              db.prepare('UPDATE cash_registers SET total_cash_sales = total_cash_sales + ?, expected_cash = opening_balance + total_cash_sales + ? - total_refunds_cash WHERE id = ?').run(paidNow, paidNow, register.id);
            } else if (payment_method === 'card') {
              db.prepare('UPDATE cash_registers SET total_card_sales = total_card_sales + ? WHERE id = ?').run(paidNow, register.id);
            } else if (payment_method === 'upi') {
              db.prepare('UPDATE cash_registers SET total_upi_sales = total_upi_sales + ? WHERE id = ?').run(paidNow, register.id);
            }
          }

          // Recalculate payment status
          const newTotalPaid = totalPaid + paidNow;
          let paymentStatus = 'pending';
          if (newTotalPaid >= sale.grand_total) paymentStatus = 'paid';
          else if (newTotalPaid > 0) paymentStatus = 'partial';
          db.prepare('UPDATE sales SET payment_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(paymentStatus, sale.id);

          // Update customer credit if applicable
          if (sale.customer_id && paidNow > 0) {
            db.prepare('UPDATE users SET credit_balance = GREATEST(0, credit_balance - ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(paidNow, sale.customer_id);
          }
        }

        db.prepare(`
          UPDATE sales SET pickup_status = 'picked_up', picked_up_at = ?,
            status = 'completed', updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(nowLocal(), sale.id);
      });

      pickupTx();

      res.json({ success: true, message: 'Order picked up by customer' });
    } catch (err) {
      if (err.message.includes('Balance due') || err.message.includes('Only manager')) {
        return res.status(400).json({ success: false, message: err.message });
      }
      next(err);
    }
  }
);

// ═══════════════════════════════════════════════════════════════
// CUSTOMER ORDER VIEWS
// ═══════════════════════════════════════════════════════════════

// ─── GET /api/deliveries/customer/orders ─────────────────────
// Customer views their own orders with payment status & dues
router.get('/customer/orders', authenticate, async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const customerId = req.user.id;

    const orders = await db.prepare(`
      SELECT s.id, s.sale_number, s.order_type, s.status, s.grand_total,
             s.payment_status, s.delivery_address, s.scheduled_date, s.scheduled_time,
             s.pickup_status, s.created_at,
             l.name as location_name,
             COALESCE(SUM(p.amount), 0) as total_paid
      FROM sales s
      LEFT JOIN locations l ON s.location_id = l.id
      LEFT JOIN payments p ON p.sale_id = s.id
      WHERE s.customer_id = ? AND s.status != 'cancelled'
      GROUP BY s.id
      ORDER BY s.created_at DESC
    `).all(customerId);

    // Calculate balance due per order
    const result = orders.map(o => ({
      ...o,
      balance_due: Math.max(0, o.grand_total - o.total_paid),
    }));

    res.json({ success: true, data: result });
  } catch (err) { next(err); }
});

// ─── GET /api/deliveries/customer/dues ───────────────────────
// Customer or manager views outstanding dues per order for a customer
router.get('/customer/dues', authenticate, async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    let customerId = req.user.id;

    // Manager/owner can query for a specific customer
    if ((req.user.role === 'owner' || req.user.role === 'manager' || req.user.role === 'employee') && req.query.customer_id) {
      customerId = parseInt(req.query.customer_id);
    }

    const orders = await db.prepare(`
      SELECT s.id, s.sale_number, s.order_type, s.status, s.grand_total,
             s.payment_status, s.created_at,
             COALESCE(SUM(p.amount), 0) as total_paid
      FROM sales s
      LEFT JOIN payments p ON p.sale_id = s.id
      WHERE s.customer_id = ? AND s.payment_status IN ('pending', 'partial') AND s.status != 'cancelled'
      GROUP BY s.id
      ORDER BY s.created_at ASC
    `).all(customerId);

    const result = orders.map(o => ({
      ...o,
      balance_due: Math.max(0, o.grand_total - o.total_paid),
    }));

    const totalDue = result.reduce((s, o) => s + o.balance_due, 0);

    res.json({ success: true, data: { orders: result, total_due: totalDue } });
  } catch (err) { next(err); }
});

module.exports = router;
