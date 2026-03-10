const express = require('express');
const { body, validationResult } = require('express-validator');
const { getDb } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const router = express.Router();

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
router.get('/', authenticate, authorize('owner', 'manager', 'delivery_partner', 'employee'), (req, res, next) => {
  try {
    const db = getDb();
    const { location_id, status, delivery_partner_id, date_from, date_to, limit: lim, offset: off } = req.query;

    let sql = `
      SELECT d.*, s.sale_number, s.grand_total, s.payment_status, s.order_type,
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
    if (status) { sql += ' AND d.status = ?'; params.push(status); }
    if (delivery_partner_id && req.user.role !== 'delivery_partner') {
      sql += ' AND d.delivery_partner_id = ?'; params.push(parseInt(delivery_partner_id));
    }
    if (date_from) { sql += ' AND DATE(d.created_at) >= ?'; params.push(date_from); }
    if (date_to) { sql += ' AND DATE(d.created_at) <= ?'; params.push(date_to); }

    // Scope managers to their locations
    if (req.user.role === 'manager' && !location_id) {
      const userLocs = db.prepare('SELECT location_id FROM user_locations WHERE user_id = ?').all(req.user.id).map(r => r.location_id);
      if (userLocs.length > 0) {
        sql += ` AND d.location_id IN (${userLocs.map(() => '?').join(',')})`;
        params.push(...userLocs);
      }
    }

    sql += ' ORDER BY CASE d.status WHEN \'pending\' THEN 1 WHEN \'assigned\' THEN 2 WHEN \'picked_up\' THEN 3 WHEN \'in_transit\' THEN 4 WHEN \'delivered\' THEN 5 WHEN \'failed\' THEN 6 WHEN \'cancelled\' THEN 7 END, d.scheduled_date ASC NULLS LAST, d.created_at DESC';

    const limit = parseInt(lim) || 50;
    const offset = parseInt(off) || 0;
    sql += ' LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const deliveries = db.prepare(sql).all(...params);

    // Get items for each delivery
    const getItems = db.prepare('SELECT product_name, quantity FROM sale_items WHERE sale_id = ?');
    for (const d of deliveries) {
      d.items = getItems.all(d.sale_id);
    }

    res.json({ success: true, data: deliveries });
  } catch (err) { next(err); }
});

// ─── GET /api/deliveries/at-risk ─────────────────────────────
// Orders/deliveries not ready within 30 min of scheduled time
router.get('/at-risk', authenticate, authorize('owner', 'manager', 'employee'), (req, res, next) => {
  try {
    const db = getDb();
    const { location_id } = req.query;

    const now = new Date();
    const today = now.toISOString().slice(0, 10);
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

    const atRisk = db.prepare(sql).all(...params);

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
      const now = new Date().toISOString();
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
router.get('/:id', authenticate, (req, res, next) => {
  try {
    const db = getDb();
    const delivery = db.prepare(`
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
    delivery.items = db.prepare(`
      SELECT si.*, p.sku as product_sku
      FROM sale_items si LEFT JOIN products p ON si.product_id = p.id
      WHERE si.sale_id = ?
    `).all(delivery.sale_id);

    // Payments on this sale
    delivery.payments = db.prepare(`
      SELECT p.*, u.name as received_by_name
      FROM payments p LEFT JOIN users u ON p.received_by = u.id
      WHERE p.sale_id = ?
    `).all(delivery.sale_id);

    // Delivery proof
    delivery.proofs = db.prepare(`
      SELECT dp.*, u.name as created_by_name
      FROM delivery_proofs dp LEFT JOIN users u ON dp.created_by = u.id
      WHERE dp.delivery_id = ?
    `).all(delivery.id);

    // COD collections
    delivery.collections = db.prepare(`
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
  '/:id/assign',
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
          delivery_partner_id = ?, status = 'assigned', assigned_by = ?, assigned_at = CURRENT_TIMESTAMP,
          failure_reason = '', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(delivery_partner_id, req.user.id, delivery.id);

      const updated = db.prepare(`
        SELECT d.*, u.name as partner_name FROM deliveries d
        LEFT JOIN users u ON d.delivery_partner_id = u.id WHERE d.id = ?
      `).get(delivery.id);

      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  }
);

// ─── PUT /api/deliveries/:id/pickup ──────────────────────────
// Delivery partner picks up order from shop
router.put(
  '/:id/pickup',
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
        UPDATE deliveries SET status = 'picked_up', pickup_time = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(delivery.id);

      const updated = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(delivery.id);
      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  }
);

// ─── PUT /api/deliveries/:id/in-transit ──────────────────────
// Delivery partner marks they're on the way
router.put(
  '/:id/in-transit',
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
  '/:id/deliver',
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
            'INSERT INTO delivery_collections (delivery_id, amount, method, reference_number, collected_by) VALUES (?, ?, ?, ?, ?)'
          ).run(delivery.id, cod_collected, cod_method || 'cash', cod_reference || null, req.user.id);
          totalCodCollected += cod_collected;

          // Create payment record on the sale
          db.prepare(
            'INSERT INTO payments (sale_id, method, amount, reference_number, received_by) VALUES (?, ?, ?, ?, ?)'
          ).run(delivery.sale_id, cod_method || 'cash', cod_collected, cod_reference ? `COD-${cod_reference}` : 'COD', req.user.id);

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
            'INSERT INTO delivery_proofs (delivery_id, latitude, longitude, notes, created_by) VALUES (?, ?, ?, ?, ?)'
          ).run(delivery.id, latitude || null, longitude || null, delivery_notes || '', req.user.id);
        }

        // Update delivery
        db.prepare(`
          UPDATE deliveries SET
            status = 'delivered', delivered_time = CURRENT_TIMESTAMP,
            cod_collected = ?, cod_status = ?,
            delivery_notes = COALESCE(?, delivery_notes),
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(totalCodCollected, codStatus, delivery_notes || null, delivery.id);

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
  '/:id/fail',
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

// ─── POST /api/deliveries/:id/proof ──────────────────────────
// Upload delivery proof photo
router.post(
  '/:id/proof',
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
router.get('/settlements/unsettled', authenticate, authorize('owner', 'manager', 'delivery_partner'), (req, res, next) => {
  try {
    const db = getDb();
    const { delivery_partner_id } = req.query;
    
    const partnerId = req.user.role === 'delivery_partner' ? req.user.id : parseInt(delivery_partner_id);
    if (!partnerId) return res.status(400).json({ success: false, message: 'delivery_partner_id required' });

    const unsettled = db.prepare(`
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
    body('location_id').isInt(),
    body('notes').optional().trim(),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });

      const db = getDb();
      const { delivery_partner_id, delivery_ids, location_id, notes } = req.body;

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

        // Create settlement
        const result = db.prepare(
          `INSERT INTO delivery_settlements (delivery_partner_id, location_id, total_amount, total_deliveries, status, notes)
           VALUES (?, ?, ?, ?, 'pending', ?)`
        ).run(delivery_partner_id, location_id, totalAmount, delivery_ids.length, notes || '');

        const settlementId = result.lastInsertRowid;

        // Link deliveries
        const insertItem = db.prepare(
          'INSERT INTO delivery_settlement_items (settlement_id, delivery_id, amount) VALUES (?, ?, ?)'
        );
        for (const did of delivery_ids) {
          const d = db.prepare('SELECT cod_collected FROM deliveries WHERE id = ?').get(did);
          insertItem.run(settlementId, did, d.cod_collected);
          // Mark delivery COD as settled
          db.prepare("UPDATE deliveries SET cod_status = 'settled', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(did);
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
  '/settlements/:id/verify',
  authenticate,
  authorize('owner', 'manager'),
  (req, res, next) => {
    try {
      const db = getDb();
      const settlement = db.prepare('SELECT * FROM delivery_settlements WHERE id = ?').get(req.params.id);
      if (!settlement) return res.status(404).json({ success: false, message: 'Settlement not found' });
      if (settlement.status === 'verified') return res.status(400).json({ success: false, message: 'Already verified' });

      const verifyTx = db.transaction(() => {
        db.prepare(`
          UPDATE delivery_settlements SET status = 'verified', verified_by = ?, verified_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(req.user.id, settlement.id);

        // Add the settled cash to the cash register
        const today = new Date().toISOString().slice(0, 10);
        const register = db.prepare('SELECT id FROM cash_registers WHERE location_id = ? AND date = ?').get(settlement.location_id, today);
        if (register) {
          db.prepare('UPDATE cash_registers SET total_cash_sales = total_cash_sales + ?, expected_cash = opening_balance + total_cash_sales + ? - total_refunds_cash WHERE id = ?')
            .run(settlement.total_amount, settlement.total_amount, register.id);
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
router.get('/settlements', authenticate, authorize('owner', 'manager'), (req, res, next) => {
  try {
    const db = getDb();
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

    const settlements = db.prepare(sql).all(...params);
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

      db.prepare("UPDATE sales SET pickup_status = 'ready_for_pickup', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(sale.id);

      res.json({ success: true, message: 'Order marked as ready for pickup' });
    } catch (err) { next(err); }
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
          const today = new Date().toISOString().slice(0, 10);
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
            db.prepare('UPDATE users SET credit_balance = MAX(0, credit_balance - ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(paidNow, sale.customer_id);
          }
        }

        db.prepare(`
          UPDATE sales SET pickup_status = 'picked_up', picked_up_at = CURRENT_TIMESTAMP,
            status = 'completed', updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(sale.id);
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
router.get('/customer/orders', authenticate, (req, res, next) => {
  try {
    const db = getDb();
    const customerId = req.user.id;

    const orders = db.prepare(`
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
router.get('/customer/dues', authenticate, (req, res, next) => {
  try {
    const db = getDb();
    let customerId = req.user.id;

    // Manager/owner can query for a specific customer
    if ((req.user.role === 'owner' || req.user.role === 'manager' || req.user.role === 'employee') && req.query.customer_id) {
      customerId = parseInt(req.query.customer_id);
    }

    const orders = db.prepare(`
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
