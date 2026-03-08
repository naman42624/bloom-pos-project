const express = require('express');
const { body, query, validationResult } = require('express-validator');
const { getDb } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

// ─── Helper: Generate sale number ────────────────────────────
function generateSaleNumber(db, locationId) {
  const loc = db.prepare('SELECT name FROM locations WHERE id = ?').get(locationId);
  const locCode = loc ? loc.name.replace(/[^A-Za-z]/g, '').substring(0, 4).toUpperCase() : 'XX';
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const prefix = `INV-${locCode}-${today}`;

  const last = db.prepare(
    "SELECT sale_number FROM sales WHERE sale_number LIKE ? ORDER BY id DESC LIMIT 1"
  ).get(`${prefix}-%`);

  let seq = 1;
  if (last) {
    const lastNum = parseInt(last.sale_number.split('-').pop(), 10);
    if (!isNaN(lastNum)) seq = lastNum + 1;
  }
  return `${prefix}-${String(seq).padStart(3, '0')}`;
}

// ─── Helper: Recalculate sale totals from items ──────────────
function recalcSaleTotals(db, saleId) {
  const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(saleId);
  const subtotal = items.reduce((s, i) => s + (i.unit_price * i.quantity), 0);
  const taxTotal = items.reduce((s, i) => s + i.tax_amount, 0);

  const sale = db.prepare('SELECT discount_type, discount_percentage, discount_amount, delivery_charges FROM sales WHERE id = ?').get(saleId);
  let discountAmount = sale.discount_amount || 0;
  if (sale.discount_type === 'percentage' && sale.discount_percentage > 0) {
    discountAmount = subtotal * sale.discount_percentage / 100;
  }
  const grandTotal = Math.max(0, subtotal - discountAmount) + taxTotal + (sale.delivery_charges || 0);

  db.prepare(
    'UPDATE sales SET subtotal = ?, tax_total = ?, discount_amount = ?, grand_total = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(subtotal, taxTotal, discountAmount, grandTotal, saleId);

  return { subtotal, taxTotal, discountAmount, grandTotal };
}

// ═══════════════════════════════════════════════════════════════
// SALES CRUD
// ═══════════════════════════════════════════════════════════════

// ─── GET /api/sales ──────────────────────────────────────────
router.get('/', authenticate, (req, res, next) => {
  try {
    const db = getDb();
    const { location_id, order_type, payment_status, status, date_from, date_to, search, limit: lim, offset: off } = req.query;

    let sql = `
      SELECT s.*, l.name as location_name, u.name as created_by_name,
             c.name as customer_display_name, c.phone as customer_display_phone
      FROM sales s
      LEFT JOIN locations l ON s.location_id = l.id
      LEFT JOIN users u ON s.created_by = u.id
      LEFT JOIN users c ON s.customer_id = c.id
      WHERE 1=1
    `;
    const params = [];

    if (location_id) { sql += ' AND s.location_id = ?'; params.push(location_id); }
    if (order_type) { sql += ' AND s.order_type = ?'; params.push(order_type); }
    if (payment_status) { sql += ' AND s.payment_status = ?'; params.push(payment_status); }
    if (status) { sql += ' AND s.status = ?'; params.push(status); }
    else { sql += " AND s.status != 'cancelled'"; }
    if (date_from) { sql += ' AND DATE(s.created_at) >= ?'; params.push(date_from); }
    if (date_to) { sql += ' AND DATE(s.created_at) <= ?'; params.push(date_to); }
    if (search) {
      sql += ' AND (s.sale_number LIKE ? OR s.customer_name LIKE ? OR s.customer_phone LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s, s);
    }

    // Scope by location for non-owner roles
    if (req.user.role === 'employee' || req.user.role === 'manager') {
      const userLocs = db.prepare('SELECT location_id FROM user_locations WHERE user_id = ?').all(req.user.id).map(r => r.location_id);
      if (userLocs.length > 0 && !location_id) {
        sql += ` AND s.location_id IN (${userLocs.map(() => '?').join(',')})`;
        params.push(...userLocs);
      }
    }

    sql += ' ORDER BY s.created_at DESC';

    const limit = parseInt(lim) || 50;
    const offset = parseInt(off) || 0;
    sql += ' LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const sales = db.prepare(sql).all(...params);

    // Get total count for pagination
    let countSql = `SELECT COUNT(*) as total FROM sales s WHERE 1=1`;
    const countParams = [];
    if (location_id) { countSql += ' AND s.location_id = ?'; countParams.push(location_id); }
    if (order_type) { countSql += ' AND s.order_type = ?'; countParams.push(order_type); }
    if (payment_status) { countSql += ' AND s.payment_status = ?'; countParams.push(payment_status); }
    if (status) { countSql += ' AND s.status = ?'; countParams.push(status); }
    else { countSql += " AND s.status != 'cancelled'"; }
    const { total } = db.prepare(countSql).get(...countParams);

    res.json({ success: true, data: { sales, total, limit, offset } });
  } catch (err) { next(err); }
});

// ─── GET /api/sales/customer-lookup ──────────────────────────
// Lookup customer by phone from past sales
router.get('/customer-lookup', authenticate, (req, res, next) => {
  try {
    const db = getDb();
    const { phone } = req.query;
    if (!phone || phone.length < 4) return res.json({ success: true, data: null });

    const customer = db.prepare(`
      SELECT customer_name, customer_phone, COUNT(*) as order_count,
             SUM(grand_total) as total_spent, MAX(created_at) as last_order
      FROM sales
      WHERE customer_phone = ? AND status != 'cancelled'
      GROUP BY customer_phone
      ORDER BY last_order DESC
      LIMIT 1
    `).get(phone);

    res.json({ success: true, data: customer || null });
  } catch (err) { next(err); }
});

// ─── GET /api/sales/today-summary ────────────────────────────
router.get('/today-summary', authenticate, (req, res, next) => {
  try {
    const db = getDb();
    const { location_id } = req.query;
    const today = new Date().toISOString().slice(0, 10);

    let locFilter = '';
    const params = [today];
    if (location_id) {
      locFilter = ' AND s.location_id = ?';
      params.push(location_id);
    }

    const summary = db.prepare(`
      SELECT
        COUNT(*) as total_sales,
        COALESCE(SUM(s.grand_total), 0) as total_revenue,
        COALESCE(SUM(s.tax_total), 0) as total_tax,
        COALESCE(SUM(s.discount_amount), 0) as total_discounts,
        COALESCE(SUM(CASE WHEN s.order_type = 'walk_in' THEN 1 ELSE 0 END), 0) as walk_in_count,
        COALESCE(SUM(CASE WHEN s.order_type = 'pickup' THEN 1 ELSE 0 END), 0) as pickup_count,
        COALESCE(SUM(CASE WHEN s.order_type = 'delivery' THEN 1 ELSE 0 END), 0) as delivery_count,
        COALESCE(SUM(CASE WHEN s.order_type = 'pre_order' THEN 1 ELSE 0 END), 0) as pre_order_count
      FROM sales s
      WHERE DATE(s.created_at) = ? AND s.status = 'completed'${locFilter}
    `).get(...params);

    // Payment method breakdown
    const paymentBreakdown = db.prepare(`
      SELECT p.method, COALESCE(SUM(p.amount), 0) as total
      FROM payments p
      JOIN sales s ON p.sale_id = s.id
      WHERE DATE(s.created_at) = ? AND s.status = 'completed'${locFilter}
      GROUP BY p.method
    `).all(...params);

    res.json({ success: true, data: { ...summary, paymentBreakdown } });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
// CASH REGISTER (must be before /:id to avoid routing conflicts)
// ═══════════════════════════════════════════════════════════════

// ─── GET /api/sales/register/status ──────────────────────────
router.get('/register/status', authenticate, (req, res, next) => {
  try {
    const db = getDb();
    const { location_id } = req.query;
    if (!location_id) return res.status(400).json({ success: false, message: 'location_id is required' });

    const today = new Date().toISOString().slice(0, 10);
    const register = db.prepare(`
      SELECT cr.*, u1.name as opened_by_name, u2.name as closed_by_name
      FROM cash_registers cr
      LEFT JOIN users u1 ON cr.opened_by = u1.id
      LEFT JOIN users u2 ON cr.closed_by = u2.id
      WHERE cr.location_id = ? AND cr.date = ?
    `).get(location_id, today);

    res.json({ success: true, data: register || null, isOpen: !!register && !register.closed_at });
  } catch (err) { next(err); }
});

// ─── POST /api/sales/register/open ───────────────────────────
router.post(
  '/register/open',
  authenticate,
  authorize('owner', 'manager', 'employee'),
  [
    body('location_id').isInt(),
    body('opening_balance').isFloat({ min: 0 }),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });

      const db = getDb();
      const { location_id, opening_balance } = req.body;
      const today = new Date().toISOString().slice(0, 10);

      const existing = db.prepare('SELECT id, closed_at, opening_balance FROM cash_registers WHERE location_id = ? AND date = ?').get(location_id, today);
      if (existing && !existing.closed_at) {
        return res.status(409).json({ success: false, message: 'Register is already open for today' });
      }
      if (existing && existing.closed_at) {
        // Reopen: clear closing data, keep the original opening balance
        db.prepare(`
          UPDATE cash_registers SET
            closed_at = NULL, closed_by = NULL, closing_notes = NULL,
            actual_cash = NULL, discrepancy = NULL
          WHERE id = ?
        `).run(existing.id);
      } else {
        db.prepare(
          'INSERT INTO cash_registers (location_id, date, opened_by, opening_balance, expected_cash) VALUES (?, ?, ?, ?, ?)'
        ).run(location_id, today, req.user.id, opening_balance, opening_balance);
      }

      const register = db.prepare(`
        SELECT cr.*, u.name as opened_by_name
        FROM cash_registers cr LEFT JOIN users u ON cr.opened_by = u.id
        WHERE cr.location_id = ? AND cr.date = ?
      `).get(location_id, today);

      res.status(201).json({ success: true, data: register });
    } catch (err) { next(err); }
  }
);

// ─── PUT /api/sales/register/close ───────────────────────────
router.put(
  '/register/close',
  authenticate,
  authorize('owner', 'manager', 'employee'),
  [
    body('location_id').isInt(),
    body('actual_cash').isFloat({ min: 0 }),
    body('closing_notes').optional().trim(),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });

      const db = getDb();
      const { location_id, actual_cash, closing_notes } = req.body;
      const today = new Date().toISOString().slice(0, 10);

      const register = db.prepare('SELECT * FROM cash_registers WHERE location_id = ? AND date = ?').get(location_id, today);
      if (!register) return res.status(404).json({ success: false, message: 'No register open for today' });
      if (register.closed_at) return res.status(400).json({ success: false, message: 'Register already closed' });

      // Recalculate totals from actual payment records
      const paymentTotals = db.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN p.method = 'cash' THEN p.amount ELSE 0 END), 0) as cash_total,
          COALESCE(SUM(CASE WHEN p.method = 'card' THEN p.amount ELSE 0 END), 0) as card_total,
          COALESCE(SUM(CASE WHEN p.method = 'upi' THEN p.amount ELSE 0 END), 0) as upi_total
        FROM payments p
        JOIN sales s ON p.sale_id = s.id
        WHERE s.location_id = ? AND DATE(s.created_at) = ? AND s.status = 'completed'
      `).get(location_id, today);

      const refundTotal = db.prepare(`
        SELECT COALESCE(SUM(r.amount), 0) as total
        FROM refunds r
        JOIN sales s ON r.sale_id = s.id
        WHERE s.location_id = ? AND DATE(r.created_at) = ? AND r.refund_method = 'cash' AND r.status = 'processed'
      `).get(location_id, today).total;

      const expectedCash = register.opening_balance + paymentTotals.cash_total - refundTotal;
      const discrepancy = expectedCash - actual_cash;

      db.prepare(`
        UPDATE cash_registers SET
          total_cash_sales = ?, total_card_sales = ?, total_upi_sales = ?,
          total_refunds_cash = ?, expected_cash = ?,
          actual_cash = ?, discrepancy = ?,
          closed_by = ?, closing_notes = ?, closed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        paymentTotals.cash_total, paymentTotals.card_total, paymentTotals.upi_total,
        refundTotal, expectedCash,
        actual_cash, discrepancy,
        req.user.id, closing_notes || '', register.id
      );

      const updated = db.prepare(`
        SELECT cr.*, u1.name as opened_by_name, u2.name as closed_by_name
        FROM cash_registers cr
        LEFT JOIN users u1 ON cr.opened_by = u1.id
        LEFT JOIN users u2 ON cr.closed_by = u2.id
        WHERE cr.id = ?
      `).get(register.id);

      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  }
);

// ─── GET /api/sales/register/history ─────────────────────────
router.get('/register/history', authenticate, authorize('owner', 'manager'), (req, res, next) => {
  try {
    const db = getDb();
    const { location_id, limit: lim } = req.query;

    let sql = `
      SELECT cr.*, l.name as location_name, u1.name as opened_by_name, u2.name as closed_by_name
      FROM cash_registers cr
      LEFT JOIN locations l ON cr.location_id = l.id
      LEFT JOIN users u1 ON cr.opened_by = u1.id
      LEFT JOIN users u2 ON cr.closed_by = u2.id
      WHERE 1=1
    `;
    const params = [];
    if (location_id) { sql += ' AND cr.location_id = ?'; params.push(location_id); }
    sql += ' ORDER BY cr.date DESC';
    const limit = parseInt(lim) || 30;
    sql += ' LIMIT ?';
    params.push(limit);

    const registers = db.prepare(sql).all(...params);
    res.json({ success: true, data: registers });
  } catch (err) { next(err); }
});

// ─── GET /api/sales/:id ──────────────────────────────────────
router.get('/:id', authenticate, (req, res, next) => {
  try {
    const db = getDb();
    const sale = db.prepare(`
      SELECT s.*, l.name as location_name, l.address as location_address,
             l.phone as location_phone,
             u.name as created_by_name,
             c.name as customer_display_name, c.phone as customer_display_phone
      FROM sales s
      LEFT JOIN locations l ON s.location_id = l.id
      LEFT JOIN users u ON s.created_by = u.id
      LEFT JOIN users c ON s.customer_id = c.id
      WHERE s.id = ?
    `).get(req.params.id);

    if (!sale) return res.status(404).json({ success: false, message: 'Sale not found' });

    sale.items = db.prepare(`
      SELECT si.*, p.sku as product_sku, p.image_url as product_image
      FROM sale_items si
      LEFT JOIN products p ON si.product_id = p.id
      WHERE si.sale_id = ?
      ORDER BY si.id ASC
    `).all(req.params.id);

    sale.payments = db.prepare(`
      SELECT p.*, u.name as received_by_name
      FROM payments p
      LEFT JOIN users u ON p.received_by = u.id
      WHERE p.sale_id = ?
      ORDER BY p.created_at ASC
    `).all(req.params.id);

    // Pre-order details if applicable
    if (sale.order_type === 'pre_order') {
      sale.pre_order = db.prepare('SELECT * FROM pre_orders WHERE sale_id = ?').get(req.params.id);
    }

    // Refund if any
    sale.refund = db.prepare('SELECT * FROM refunds WHERE sale_id = ?').get(req.params.id);

    res.json({ success: true, data: sale });
  } catch (err) { next(err); }
});

// ─── POST /api/sales ─────────────────────────────────────────
// Creates a completed sale with items and payments in one transaction
router.post(
  '/',
  authenticate,
  authorize('owner', 'manager', 'employee'),
  [
    body('location_id').isInt().withMessage('Location is required'),
    body('order_type').isIn(['walk_in', 'pickup', 'delivery', 'pre_order']),
    body('items').isArray({ min: 1 }).withMessage('At least one item is required'),
    body('items.*.product_id').optional({ nullable: true }).isInt(),
    body('items.*.material_id').optional({ nullable: true }).isInt(),
    body('items.*.quantity').isInt({ min: 1 }),
    body('items.*.unit_price').isFloat({ min: 0 }),
    body('payments').optional().isArray(),
    body('payments.*.method').optional().isIn(['cash', 'card', 'upi']),
    body('payments.*.amount').optional().isFloat({ min: 0.01 }),
    body('customer_id').optional({ nullable: true }).isInt(),
    body('customer_name').optional({ nullable: true }).trim(),
    body('customer_phone').optional({ nullable: true }).trim(),
    body('discount_type').optional({ nullable: true }).isIn(['fixed', 'percentage']),
    body('discount_value').optional({ nullable: true }).isFloat({ min: 0 }),
    body('delivery_charges').optional().isFloat({ min: 0 }),
    body('delivery_address').optional({ nullable: true }).trim(),
    body('notes').optional({ nullable: true }).trim(),
    body('special_instructions').optional().trim(),
    body('customer_notes').optional().trim(),
    // Pre-order fields
    body('scheduled_date').optional({ nullable: true }).trim(),
    body('scheduled_time').optional({ nullable: true }).trim(),
    body('advance_amount').optional().isFloat({ min: 0 }),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });

      const db = getDb();
      const {
        location_id, order_type, items, payments,
        customer_id, customer_name, customer_phone,
        discount_type, discount_value,
        delivery_charges, delivery_address, notes, special_instructions, customer_notes,
        scheduled_date, scheduled_time, advance_amount,
      } = req.body;

      const createSale = db.transaction(() => {
        // Calculate line items — supports both products and raw materials
        let subtotal = 0;
        let taxTotal = 0;
        const processedItems = items.map((item) => {
          let name, unitPrice, taxRate = 0, productId = null, materialId = null;

          if (item.material_id) {
            // Raw material sale
            const material = db.prepare('SELECT id, name FROM materials WHERE id = ? AND is_active = 1').get(item.material_id);
            if (!material) throw new Error(`Material ID ${item.material_id} not found or inactive`);
            name = item.product_name || material.name;
            unitPrice = item.unit_price;
            taxRate = item.tax_rate || 0;
            materialId = material.id;
          } else {
            // Product sale
            const product = db.prepare('SELECT id, name, tax_rate_id, selling_price FROM products WHERE id = ? AND is_active = 1').get(item.product_id);
            if (!product) throw new Error(`Product ID ${item.product_id} not found or inactive`);
            unitPrice = item.unit_price != null ? item.unit_price : product.selling_price;
            taxRate = 0;
            if (product.tax_rate_id) {
              const tr = db.prepare('SELECT percentage FROM tax_rates WHERE id = ?').get(product.tax_rate_id);
              if (tr) taxRate = tr.percentage;
            }
            name = product.name;
            productId = product.id;
          }

          const qty = item.quantity || 1;
          const taxAmount = (unitPrice * qty * taxRate) / 100;
          const lineTotal = (unitPrice * qty) + taxAmount;
          subtotal += unitPrice * qty;
          taxTotal += taxAmount;

          return { product_id: productId, material_id: materialId, product_name: name, quantity: qty, unit_price: unitPrice, tax_rate: taxRate, tax_amount: taxAmount, line_total: lineTotal };
        });

        // Discount
        let discountAmount = 0;
        let discountPercentage = null;
        if (discount_type && discount_value > 0) {
          if (discount_type === 'percentage') {
            discountPercentage = discount_value;
            discountAmount = subtotal * discount_value / 100;
          } else {
            discountAmount = discount_value;
            discountPercentage = subtotal > 0 ? (discount_value / subtotal) * 100 : 0;
          }
        }

        const grandTotal = Math.max(0, subtotal - discountAmount) + taxTotal + (delivery_charges || 0);

        // Determine payment status
        const totalPaid = (payments || []).reduce((s, p) => s + (p.amount || 0), 0);
        let paymentStatus = 'pending';
        if (totalPaid >= grandTotal) paymentStatus = 'paid';
        else if (totalPaid > 0) paymentStatus = 'partial';

        const saleNumber = generateSaleNumber(db, location_id);

        // Insert sale
        const saleResult = db.prepare(`
          INSERT INTO sales (sale_number, location_id, customer_id, customer_name, customer_phone,
            subtotal, tax_total, discount_amount, discount_type, discount_percentage,
            delivery_charges, delivery_address, scheduled_date, scheduled_time,
            grand_total, payment_status, order_type, status,
            special_instructions, customer_notes, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)
        `).run(
          saleNumber, location_id, customer_id || null, customer_name || null, customer_phone || null,
          subtotal, taxTotal, discountAmount, discount_type || null, discountPercentage,
          delivery_charges || 0, delivery_address || null, scheduled_date || null, scheduled_time || null,
          grandTotal, paymentStatus, order_type,
          notes || special_instructions || '', customer_notes || '', req.user.id
        );
        const saleId = saleResult.lastInsertRowid;

        // Insert items
        const insertItem = db.prepare(
          'INSERT INTO sale_items (sale_id, product_id, material_id, product_name, quantity, unit_price, tax_rate, tax_amount, line_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );
        for (const item of processedItems) {
          insertItem.run(saleId, item.product_id, item.material_id, item.product_name, item.quantity, item.unit_price, item.tax_rate, item.tax_amount, item.line_total);
        }

        // Deduct materials from stock
        const getBOM = db.prepare('SELECT material_id, quantity FROM product_materials WHERE product_id = ?');
        const deductStock = db.prepare('UPDATE material_stock SET quantity = MAX(0, quantity - ?), updated_at = CURRENT_TIMESTAMP WHERE material_id = ? AND location_id = ?');
        const logTransaction = db.prepare(`INSERT INTO material_transactions (material_id, location_id, type, quantity, reference_type, reference_id, notes, created_by) VALUES (?, ?, 'usage', ?, 'sale', ?, ?, ?)`);
        for (const item of processedItems) {
          if (item.material_id) {
            // Direct material sale — deduct the material itself
            deductStock.run(item.quantity, item.material_id, location_id);
            logTransaction.run(item.material_id, location_id, item.quantity, saleId, `Sale ${saleNumber}`, req.user.id);
          } else if (item.product_id) {
            // Product sale — deduct via BOM
            const bomItems = getBOM.all(item.product_id);
            for (const bom of bomItems) {
              const usedQty = bom.quantity * item.quantity;
              deductStock.run(usedQty, bom.material_id, location_id);
              logTransaction.run(bom.material_id, location_id, usedQty, saleId, `Sale ${saleNumber}`, req.user.id);
            }
          }
        }

        // Insert payments
        if (payments && payments.length > 0) {
          const insertPayment = db.prepare(
            'INSERT INTO payments (sale_id, method, amount, reference_number, received_by) VALUES (?, ?, ?, ?, ?)'
          );
          for (const pmt of payments) {
            insertPayment.run(saleId, pmt.method, pmt.amount, pmt.reference_number || null, req.user.id);
          }

          // Update cash register for today
          const today = new Date().toISOString().slice(0, 10);
          const register = db.prepare('SELECT id FROM cash_registers WHERE location_id = ? AND date = ?').get(location_id, today);
          if (register) {
            for (const pmt of payments) {
              if (pmt.method === 'cash') {
                db.prepare('UPDATE cash_registers SET total_cash_sales = total_cash_sales + ?, expected_cash = opening_balance + total_cash_sales + ? - total_refunds_cash WHERE id = ?').run(pmt.amount, pmt.amount, register.id);
              } else if (pmt.method === 'card') {
                db.prepare('UPDATE cash_registers SET total_card_sales = total_card_sales + ? WHERE id = ?').run(pmt.amount, register.id);
              } else if (pmt.method === 'upi') {
                db.prepare('UPDATE cash_registers SET total_upi_sales = total_upi_sales + ? WHERE id = ?').run(pmt.amount, register.id);
              }
            }
          }
        }

        // Pre-order record
        if (order_type === 'pre_order' && scheduled_date) {
          const advPmt = advance_amount || totalPaid;
          const remaining = grandTotal - advPmt;
          db.prepare(
            'INSERT INTO pre_orders (sale_id, scheduled_date, scheduled_time, advance_payment, remaining_amount) VALUES (?, ?, ?, ?, ?)'
          ).run(saleId, scheduled_date, scheduled_time || null, advPmt, Math.max(0, remaining));
        }

        // Return created sale
        return db.prepare(`
          SELECT s.*, l.name as location_name, u.name as created_by_name
          FROM sales s
          LEFT JOIN locations l ON s.location_id = l.id
          LEFT JOIN users u ON s.created_by = u.id
          WHERE s.id = ?
        `).get(saleId);
      });

      const sale = createSale();
      // Attach items & payments for response
      sale.items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(sale.id);
      sale.payments = db.prepare('SELECT * FROM payments WHERE sale_id = ?').all(sale.id);
      if (sale.order_type === 'pre_order') {
        sale.pre_order = db.prepare('SELECT * FROM pre_orders WHERE sale_id = ?').get(sale.id);
      }

      res.status(201).json({ success: true, data: sale });
    } catch (err) { next(err); }
  }
);

// ─── POST /api/sales/:id/payments ────────────────────────────
// Add additional payment to an existing sale (e.g. remaining balance)
router.post(
  '/:id/payments',
  authenticate,
  authorize('owner', 'manager', 'employee'),
  [
    body('method').isIn(['cash', 'card', 'upi']),
    body('amount').isFloat({ min: 0.01 }),
    body('reference_number').optional({ nullable: true }).trim(),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });

      const db = getDb();
      const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(req.params.id);
      if (!sale) return res.status(404).json({ success: false, message: 'Sale not found' });

      const { method, amount, reference_number } = req.body;

      db.prepare('INSERT INTO payments (sale_id, method, amount, reference_number, received_by) VALUES (?, ?, ?, ?, ?)')
        .run(sale.id, method, amount, reference_number || null, req.user.id);

      // Recalculate payment status
      const totalPaid = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE sale_id = ?').get(sale.id).total;
      let paymentStatus = 'pending';
      if (totalPaid >= sale.grand_total) paymentStatus = 'paid';
      else if (totalPaid > 0) paymentStatus = 'partial';

      db.prepare('UPDATE sales SET payment_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(paymentStatus, sale.id);

      // Update cash register
      const today = new Date().toISOString().slice(0, 10);
      const register = db.prepare('SELECT id FROM cash_registers WHERE location_id = ? AND date = ?').get(sale.location_id, today);
      if (register) {
        if (method === 'cash') {
          db.prepare('UPDATE cash_registers SET total_cash_sales = total_cash_sales + ?, expected_cash = opening_balance + total_cash_sales + ? - total_refunds_cash WHERE id = ?').run(amount, amount, register.id);
        } else if (method === 'card') {
          db.prepare('UPDATE cash_registers SET total_card_sales = total_card_sales + ? WHERE id = ?').run(amount, register.id);
        } else if (method === 'upi') {
          db.prepare('UPDATE cash_registers SET total_upi_sales = total_upi_sales + ? WHERE id = ?').run(amount, register.id);
        }
      }

      const payments = db.prepare('SELECT * FROM payments WHERE sale_id = ?').all(sale.id);
      res.status(201).json({ success: true, data: { payments, payment_status: paymentStatus, total_paid: totalPaid } });
    } catch (err) { next(err); }
  }
);

// ─── PUT /api/sales/:id/cancel ───────────────────────────────
router.put(
  '/:id/cancel',
  authenticate,
  authorize('owner', 'manager'),
  (req, res, next) => {
    try {
      const db = getDb();
      const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(req.params.id);
      if (!sale) return res.status(404).json({ success: false, message: 'Sale not found' });
      if (sale.status === 'cancelled') return res.status(400).json({ success: false, message: 'Sale already cancelled' });

      db.prepare("UPDATE sales SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);

      res.json({ success: true, message: 'Sale cancelled' });
    } catch (err) { next(err); }
  }
);

// ═══════════════════════════════════════════════════════════════
// REFUNDS
// ═══════════════════════════════════════════════════════════════

// ─── POST /api/sales/:id/refund ──────────────────────────────
router.post(
  '/:id/refund',
  authenticate,
  authorize('owner', 'manager'),
  [
    body('amount').isFloat({ min: 0.01 }),
    body('reason').trim().notEmpty().withMessage('Reason is required'),
    body('refund_method').isIn(['cash', 'card', 'upi', 'store_credit']),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });

      const db = getDb();
      const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(req.params.id);
      if (!sale) return res.status(404).json({ success: false, message: 'Sale not found' });

      const existing = db.prepare('SELECT id FROM refunds WHERE sale_id = ?').get(req.params.id);
      if (existing) return res.status(409).json({ success: false, message: 'Refund already exists for this sale' });

      const { amount, reason, refund_method } = req.body;
      if (amount > sale.grand_total) return res.status(400).json({ success: false, message: 'Refund amount cannot exceed sale total' });

      db.prepare(
        `INSERT INTO refunds (sale_id, amount, reason, status, requested_by, approved_by, refund_method)
         VALUES (?, ?, ?, 'processed', ?, ?, ?)`
      ).run(req.params.id, amount, reason, req.user.id, req.user.id, refund_method);

      db.prepare("UPDATE sales SET payment_status = 'refunded', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);

      // Update cash register if cash refund
      if (refund_method === 'cash') {
        const today = new Date().toISOString().slice(0, 10);
        const register = db.prepare('SELECT id FROM cash_registers WHERE location_id = ? AND date = ?').get(sale.location_id, today);
        if (register) {
          db.prepare('UPDATE cash_registers SET total_refunds_cash = total_refunds_cash + ?, expected_cash = opening_balance + total_cash_sales - total_refunds_cash - ? WHERE id = ?').run(amount, amount, register.id);
        }
      }

      const refund = db.prepare('SELECT * FROM refunds WHERE sale_id = ?').get(req.params.id);
      res.status(201).json({ success: true, data: refund });
    } catch (err) { next(err); }
  }
);

module.exports = router;
