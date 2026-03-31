const express = require('express');
const { body, query, validationResult } = require('express-validator');
const { getDb } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { notifyByRole, createNotification } = require('./notifications');
const { todayStr: localToday, nowLocal, nowTimeStr } = require('../utils/time');
const { safeParseJSON } = require('../utils/json');

const router = express.Router();

// ─── Auto-migration: expand schema CHECK constraints ─────────
try {
  const db = getDb();
  // Add 'preparing' and 'ready' to sales.status
  try { db.prepare("ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_status_check").run(); } catch {}
  try { db.prepare("ALTER TABLE sales ADD CONSTRAINT sales_status_check CHECK(status IN ('pending','confirmed','preparing','ready','completed','cancelled','draft'))").run(); } catch {}
  // Add 'assigned' to production_tasks.status
  try { db.prepare("ALTER TABLE production_tasks DROP CONSTRAINT IF EXISTS production_tasks_status_check").run(); } catch {}
  try { db.prepare("ALTER TABLE production_tasks ADD CONSTRAINT production_tasks_status_check CHECK(status IN ('pending','assigned','in_progress','completed','cancelled'))").run(); } catch {}
} catch (e) { console.log('Sales migration note:', e.message); }


// ─── Helper: Generate sale number ────────────────────────────
function generateSaleNumber(db, locationId) {
  const loc = db.prepare('SELECT name FROM locations WHERE id = ?').get(locationId);
  const locCode = loc ? loc.name.replace(/[^A-Za-z]/g, '').substring(0, 4).toUpperCase() : 'XX';
  const today = localToday().replace(/-/g, '');
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
    const { location_id, order_type, payment_status, status, pickup_status, date_from, date_to, search, limit: lim, offset: off } = req.query;

    let sql = `
      SELECT s.*, l.name as location_name, u.name as created_by_name,
             c.name as customer_display_name, c.phone as customer_display_phone,
             COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.sale_id = s.id), 0) as total_paid
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
    if (pickup_status) { sql += ' AND s.pickup_status = ?'; params.push(pickup_status); }
    if (status) { sql += ' AND s.status = ?'; params.push(status); }
    else { sql += " AND s.status != 'cancelled'"; }
    if (date_from) { sql += ' AND s.created_at >= (?::date)'; params.push(date_from); }
    if (date_to) { sql += " AND s.created_at < (?::date + INTERVAL '1 day')"; params.push(date_to); }
    if (search) {
      const s = `%${search}%`;
      sql += ` AND (
        s.sale_number ILIKE ?
        OR s.customer_name ILIKE ?
        OR s.customer_phone ILIKE ?
        OR EXISTS (SELECT 1 FROM sale_items si2 WHERE si2.sale_id = s.id AND si2.product_name ILIKE ?)
        OR EXISTS (SELECT 1 FROM deliveries d2 WHERE d2.sale_id = s.id AND d2.delivery_address ILIKE ?)
        OR EXISTS (SELECT 1 FROM deliveries d3 JOIN users dp ON d3.delivery_partner_id = dp.id WHERE d3.sale_id = s.id AND dp.name ILIKE ?)
        OR EXISTS (
          SELECT 1 FROM sale_items si3
          JOIN products pr ON si3.product_id = pr.id
          JOIN product_materials pm ON pm.product_id = pr.id
          JOIN materials m ON pm.material_id = m.id
          WHERE si3.sale_id = s.id AND m.name ILIKE ?
        )
        OR EXISTS (SELECT 1 FROM sale_items si4 WHERE si4.sale_id = s.id AND si4.custom_materials::text ILIKE ?)
      )`;
      params.push(s, s, s, s, s, s, s, s);
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

    const limit = parseInt(lim) || 200;
    const offset = parseInt(off) || 0;
    sql += ' LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const sales = db.prepare(sql).all(...params);

    // Enrich each sale with items
    const getItems = db.prepare('SELECT product_name, quantity, special_instructions as item_special_instructions, image_url as item_image_url, custom_materials FROM sale_items WHERE sale_id = ?');
    for (const sale of sales) {
      sale.items = getItems.all(sale.id);
    }

    // Get total count for pagination
    let countSql = `SELECT COUNT(*) as total FROM sales s WHERE 1=1`;
    const countParams = [];
    if (location_id) { countSql += ' AND s.location_id = ?'; countParams.push(location_id); }
    if (order_type) { countSql += ' AND s.order_type = ?'; countParams.push(order_type); }
    if (payment_status) { countSql += ' AND s.payment_status = ?'; countParams.push(payment_status); }
    if (status) { countSql += ' AND s.status = ?'; countParams.push(status); }
    else { countSql += " AND s.status != 'cancelled'"; }
    if (date_from) { countSql += ' AND s.created_at >= (?::date)'; countParams.push(date_from); }
    if (date_to) { countSql += " AND s.created_at < (?::date + INTERVAL '1 day')"; countParams.push(date_to); }
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
    const today = localToday();

    let locFilter = '';
    const params = [today, today];
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
      WHERE s.created_at >= (?::date)
        AND s.created_at < (?::date + INTERVAL '1 day')
        AND s.status != 'cancelled'${locFilter}
    `).get(...params);

    // Payment method breakdown
    const paymentBreakdown = db.prepare(`
      SELECT p.method, COALESCE(SUM(p.amount), 0) as total
      FROM payments p
      JOIN sales s ON p.sale_id = s.id
      WHERE s.created_at >= (?::date)
        AND s.created_at < (?::date + INTERVAL '1 day')
        AND s.status != 'cancelled'${locFilter}
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

    const today = localToday();

    // First check if there is ANY unclosed register for this location (could be from yesterday)
    let register = db.prepare(`
      SELECT cr.*, u1.name as opened_by_name, u2.name as closed_by_name
      FROM cash_registers cr
      LEFT JOIN users u1 ON cr.opened_by = u1.id
      LEFT JOIN users u2 ON cr.closed_by = u2.id
      WHERE cr.location_id = ? AND cr.closed_at IS NULL
      ORDER BY cr.id DESC LIMIT 1
    `).get(location_id);

    // If no open register exists, get today's most recent closed session (if any)
    if (!register) {
      register = db.prepare(`
        SELECT cr.*, u1.name as opened_by_name, u2.name as closed_by_name
        FROM cash_registers cr
        LEFT JOIN users u1 ON cr.opened_by = u1.id
        LEFT JOIN users u2 ON cr.closed_by = u2.id
        WHERE cr.location_id = ? AND cr.date = ?
        ORDER BY cr.id DESC LIMIT 1
      `).get(location_id, today);
    }

    // Add today's cash expenses to the response (or the open register's date expenses)
    if (register) {
      const expenseTotal = db.prepare(`
        SELECT COALESCE(SUM(amount), 0) as total
        FROM expenses
        WHERE location_id = ? AND expense_date = ? AND payment_method = 'cash'
      `).get(location_id, today).total;
      register.total_expenses_cash = expenseTotal;
    }

    // Get all sessions for today (for the log view)
    const todaySessions = db.prepare(`
      SELECT cr.*, u1.name as opened_by_name, u2.name as closed_by_name
      FROM cash_registers cr
      LEFT JOIN users u1 ON cr.opened_by = u1.id
      LEFT JOIN users u2 ON cr.closed_by = u2.id
      WHERE cr.location_id = ? AND cr.date = ?
      ORDER BY cr.id DESC
    `).all(location_id, today);

    res.json({
      success: true,
      data: register || null,
      isOpen: !!register && !register.closed_at,
      todaySessions,
    });
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
      const today = localToday();

      // Check if there's already an open (unclosed) register for this location
      const openRegister = db.prepare('SELECT id FROM cash_registers WHERE location_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1').get(location_id);
      if (openRegister) {
        return res.status(409).json({ success: false, message: 'Register is already open. Please close it first.' });
      }

      // Always create a new register session (allows multiple per day)
      db.prepare(
        `INSERT INTO cash_registers (
          location_id, date, opened_by,
          opening_balance, opening_amount,
          expected_cash, opened_at, opening_time, status
        ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'open')`
      ).run(location_id, today, req.user.id, opening_balance, opening_balance, opening_balance);

      const register = db.prepare(`
        SELECT cr.*, u.name as opened_by_name
        FROM cash_registers cr LEFT JOIN users u ON cr.opened_by = u.id
        WHERE cr.location_id = ? AND cr.closed_at IS NULL
        ORDER BY cr.id DESC LIMIT 1
      `).get(location_id);

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
      const today = localToday();

      // Find the most recent unclosed register for this location
      const register = db.prepare('SELECT * FROM cash_registers WHERE location_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1').get(location_id);
      if (!register) return res.status(404).json({ success: false, message: 'No open register found for this location' });

      // Recalculate totals from actual payment records during this session
      const sessionStart = register.opened_at;
      const paymentTotals = db.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN p.method = 'cash' THEN p.amount ELSE 0 END), 0) as cash_total,
          COALESCE(SUM(CASE WHEN p.method = 'card' THEN p.amount ELSE 0 END), 0) as card_total,
          COALESCE(SUM(CASE WHEN p.method = 'upi' THEN p.amount ELSE 0 END), 0) as upi_total
        FROM payments p
        JOIN sales s ON p.sale_id = s.id
        WHERE s.location_id = ? AND p.created_at >= ? AND s.status != 'cancelled'
      `).get(location_id, sessionStart);

      let refundTotal = 0;
      try {
        refundTotal = db.prepare(`
          SELECT COALESCE(SUM(r.amount), 0) as total
          FROM refunds r
          JOIN sales s ON r.sale_id = s.id
          WHERE s.location_id = ? AND r.created_at >= ? AND r.refund_method = 'cash' AND COALESCE(r.status, 'processed') = 'processed' AND s.status != 'cancelled'
        `).get(location_id, sessionStart).total;
      } catch (err) {
        const msg = String(err?.message || '').toLowerCase();
        if (!msg.includes('refund_method')) throw err;
        refundTotal = db.prepare(`
          SELECT COALESCE(SUM(r.amount), 0) as total
          FROM refunds r
          JOIN sales s ON r.sale_id = s.id
          WHERE s.location_id = ? AND r.created_at >= ?
        `).get(location_id, sessionStart).total;
      }

      // Cash expenses during this session
      const expenseTotal = db.prepare(`
        SELECT COALESCE(SUM(amount), 0) as total
        FROM expenses
        WHERE location_id = ? AND created_at >= ? AND payment_method = 'cash'
      `).get(location_id, sessionStart).total;

      const expectedCash = register.opening_balance + paymentTotals.cash_total - refundTotal - expenseTotal;
      const discrepancy = expectedCash - actual_cash;

      db.prepare(`
        UPDATE cash_registers SET
          total_cash_sales = ?, total_card_sales = ?, total_upi_sales = ?,
          total_refunds_cash = ?, expected_cash = ?,
          actual_cash = ?, discrepancy = ?,
          closing_balance = ?, closing_amount = ?,
          closed_by = ?, closing_notes = ?,
          closed_at = CURRENT_TIMESTAMP, closing_time = CURRENT_TIMESTAMP,
          status = 'closed'
        WHERE id = ?
      `).run(
        paymentTotals.cash_total, paymentTotals.card_total, paymentTotals.upi_total,
        refundTotal, expectedCash,
        actual_cash, discrepancy,
        actual_cash, actual_cash,
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

// ─── GET /api/sales/production-queue ─────────────────────────
// Returns orders that need to be prepared (pending/preparing/ready)
router.get(
  '/production-queue',
  authenticate,
  authorize('owner', 'manager', 'employee'),
  (req, res, next) => {
    try {
      const db = getDb();
      const { location_id, status } = req.query;

      let sql = `SELECT s.*, l.name as location_name, u.name as created_by_name
                 FROM sales s
                 LEFT JOIN locations l ON s.location_id = l.id
                 LEFT JOIN users u ON s.created_by = u.id
                 WHERE s.status IN ('pending', 'preparing', 'ready')`;
      const params = [];

      if (location_id) {
        sql += ' AND s.location_id = ?';
        params.push(parseInt(location_id));
      }
      if (status) {
        sql += ' AND s.status = ?';
        params.push(status);
      }

      // Scope managers to their assigned locations
      if (req.user.role === 'manager' && !location_id) {
        const userLocs = db.prepare('SELECT location_id FROM user_locations WHERE user_id = ?').all(req.user.id).map(r => r.location_id);
        if (userLocs.length > 0) {
          sql += ` AND s.location_id IN (${userLocs.map(() => '?').join(',')})`;
          params.push(...userLocs);
        }
      }

      sql += ' ORDER BY CASE s.status WHEN \'pending\' THEN 1 WHEN \'preparing\' THEN 2 WHEN \'ready\' THEN 3 END, s.scheduled_date ASC NULLS LAST, s.created_at ASC';

      const orders = db.prepare(sql).all(...params);

      // Enrich each order with items, task status counts, and delivery info
      const getItems = db.prepare('SELECT product_name, quantity, special_instructions as item_special_instructions, image_url as item_image_url, custom_materials FROM sale_items WHERE sale_id = ?');
      const getTaskCounts = db.prepare(`
        SELECT 
          COUNT(*) FILTER (WHERE status = 'pending') as pending_tasks,
          COUNT(*) FILTER (WHERE status = 'assigned') as assigned_tasks,
          COUNT(*) FILTER (WHERE status = 'in_progress') as in_progress_tasks,
          COUNT(*) FILTER (WHERE status = 'completed') as completed_tasks,
          COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled_tasks,
          COUNT(*) as total_tasks
        FROM production_tasks WHERE sale_id = ?
      `);
      const getDelivery = db.prepare(`
        SELECT d.id, d.status, u.name as partner_name 
        FROM deliveries d
        LEFT JOIN users u ON d.delivery_partner_id = u.id
        WHERE d.sale_id = ? LIMIT 1
      `);


      for (const order of orders) {
        order.items = getItems.all(order.id);
        // Parse custom_materials from JSON string
        for (const item of order.items) {
          item.custom_materials = safeParseJSON(item.custom_materials, null);
        }
        // Add task status summary
        const taskCounts = getTaskCounts.get(order.id);
        order.task_summary = taskCounts || { pending_tasks: 0, assigned_tasks: 0, in_progress_tasks: 0, completed_tasks: 0, cancelled_tasks: 0, total_tasks: 0 };
        order.all_tasks_done = taskCounts ? (taskCounts.pending_tasks + taskCounts.assigned_tasks + taskCounts.in_progress_tasks) === 0 : true;
        // Add delivery info  
        if (order.order_type === 'delivery') {
          order.delivery = getDelivery.get(order.id) || null;
        }
      }

      res.json({ success: true, data: orders });
    } catch (err) { next(err); }
  }
);

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
      SELECT si.*, p.sku as product_sku, p.image_url as product_image,
             COALESCE(si.product_name, p.name, m.name, 'Item') as display_name
      FROM sale_items si
      LEFT JOIN products p ON si.product_id = p.id
      LEFT JOIN materials m ON si.material_id = m.id
      WHERE si.sale_id = ?
      ORDER BY si.id ASC
    `).all(req.params.id);

    // Attach material composition (BOM) and production task for each item
    const getBOM = db.prepare(`
      SELECT pm.material_id, pm.quantity as qty_per_unit,
             mat.name as material_name, mat.sku as material_sku,
             mat.image_url as material_image,
             mc.name as category_name, mc.unit
      FROM product_materials pm
      JOIN materials mat ON pm.material_id = mat.id
      LEFT JOIN material_categories mc ON mat.category_id = mc.id
      WHERE pm.product_id = ?
      ORDER BY mat.name
    `);
    const getTask = db.prepare(`
      SELECT pt.id, pt.status, pt.quantity, pt.priority, pt.assigned_to, pt.picked_by,
             pt.completed_at, pt.notes,
             a.name as assigned_to_name, pk.name as picked_by_name
      FROM production_tasks pt
      LEFT JOIN users a ON pt.assigned_to = a.id
      LEFT JOIN users pk ON pt.picked_by = pk.id
      WHERE pt.sale_item_id = ? AND pt.status != 'cancelled'
      ORDER BY pt.id DESC LIMIT 1
    `);

    for (const item of sale.items) {
      // Parse custom_materials if stored as JSON string
      item.custom_materials = safeParseJSON(item.custom_materials, null);
      // Fetch material composition (BOM) for standard products
      item.materials = item.product_id ? getBOM.all(item.product_id) : [];
      // Fetch production task for ALL items (including ad-hoc)
      item.production_task = getTask.get(item.id) || null;
    }

    // Production task summary for the entire sale
    sale.production_summary = {
      total_tasks: 0,
      pending: 0,
      assigned: 0,
      in_progress: 0,
      completed: 0,
      cancelled: 0,
    };
    const taskCounts = db.prepare(`
      SELECT status, COUNT(*) as cnt FROM production_tasks WHERE sale_id = ? GROUP BY status
    `).all(req.params.id);
    for (const tc of taskCounts) {
      sale.production_summary.total_tasks += tc.cnt;
      if (sale.production_summary[tc.status] !== undefined) {
        sale.production_summary[tc.status] = tc.cnt;
      }
    }
    sale.production_summary.all_done = sale.production_summary.pending === 0 &&
      sale.production_summary.assigned === 0 &&
      sale.production_summary.in_progress === 0;

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

    // Delivery info if applicable
    sale.delivery = db.prepare(`
      SELECT d.*, u.name as partner_name, u.phone as partner_phone
      FROM deliveries d LEFT JOIN users u ON d.delivery_partner_id = u.id
      WHERE d.sale_id = ?
    `).get(req.params.id);

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
    body('sender_name').optional({ nullable: true }).trim(),
    body('sender_phone').optional({ nullable: true }).trim(),
    body('sender_message').optional({ nullable: true }).trim(),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });

      const db = getDb();
      const {
        location_id, order_type, items, payments,
        customer_id: customer_id_from_body, customer_name, customer_phone,
        discount_type, discount_value,
        delivery_charges, delivery_address, notes, special_instructions, customer_notes,
        scheduled_date, scheduled_time, advance_amount,
        sender_name, sender_phone, sender_message,
      } = req.body;
      // Mutable alias — may be set by auto-create logic below
      let customer_id = customer_id_from_body || null;

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
          } else if (item.product_id) {
            // Product sale
            const product = db.prepare('SELECT id, name, tax_rate_id, selling_price FROM products WHERE id = ? AND is_active = 1').get(item.product_id);
            if (!product) throw new Error(`Product ID ${item.product_id} not found or inactive`);
            unitPrice = item.unit_price != null ? item.unit_price : product.selling_price;
            taxRate = 0;
            if (product.tax_rate_id) {
              const tr = db.prepare('SELECT percentage FROM tax_rates WHERE id = ?').get(product.tax_rate_id);
              if (tr) taxRate = tr.percentage;
            }
            name = item.product_name || product.name;
            productId = product.id;
          } else {
            // Custom ad-hoc item
            name = item.product_name || 'Custom Item';
            unitPrice = Number(item.unit_price) || 0;
            taxRate = item.tax_rate || 0;
            productId = null;
            materialId = null;
          }

          const qty = item.quantity || 1;
          const taxAmount = (unitPrice * qty * taxRate) / 100;
          const lineTotal = (unitPrice * qty) + taxAmount;
          subtotal += unitPrice * qty;
          taxTotal += taxAmount;

          return { product_id: productId, material_id: materialId, product_name: name, quantity: qty, unit_price: unitPrice, tax_rate: taxRate, tax_amount: taxAmount, line_total: lineTotal, special_instructions: item.special_instructions || null, image_url: item.image_url || null, custom_materials: item.custom_materials || null, fulfill_from_stock: item.fulfill_from_stock };
        });

        // Discount — with threshold enforcement
        let discountAmount = 0;
        let discountPercentage = null;
        let discountApprovedBy = null;
        if (discount_type && discount_value > 0) {
          if (discount_type === 'percentage') {
            discountPercentage = discount_value;
            discountAmount = subtotal * discount_value / 100;
          } else {
            discountAmount = discount_value;
            discountPercentage = subtotal > 0 ? (discount_value / subtotal) * 100 : 0;
          }

          // Enforce discount thresholds
          const mgrThreshold = parseFloat(
            (db.prepare("SELECT value FROM settings WHERE key = 'discount_manager_threshold'").get() || {}).value || '20'
          );
          const ownerThreshold = parseFloat(
            (db.prepare("SELECT value FROM settings WHERE key = 'discount_owner_threshold'").get() || {}).value || '30'
          );
          const effectivePct = discountPercentage || 0;

          if (effectivePct > ownerThreshold) {
            // Only owner can approve
            if (req.user.role !== 'owner') {
              throw new Error(`Discount of ${effectivePct.toFixed(1)}% exceeds owner threshold (${ownerThreshold}%). Only an owner can apply this discount.`);
            }
            discountApprovedBy = req.user.id;
          } else if (effectivePct > mgrThreshold) {
            // Manager or owner can approve
            if (req.user.role !== 'owner' && req.user.role !== 'manager') {
              throw new Error(`Discount of ${effectivePct.toFixed(1)}% exceeds manager threshold (${mgrThreshold}%). A manager or owner must apply this discount.`);
            }
            discountApprovedBy = req.user.id;
          }
        }

        const grandTotal = Math.max(0, subtotal - discountAmount) + taxTotal + (delivery_charges || 0);

        // Determine payment status
        const totalPaid = (payments || []).reduce((s, p) => s + (p.amount || 0), 0);
        let paymentStatus = 'pending';
        if (totalPaid >= grandTotal) paymentStatus = 'paid';
        else if (totalPaid > 0) paymentStatus = 'partial';

        const saleNumber = generateSaleNumber(db, location_id);

        // ─── Customer auto-creation ──────────────────────
        // If phone is provided but no customer_id, find or create in USERS table (role='customer')
        if (customer_phone && !customer_id) {
          const existingCustomer = db.prepare(
            "SELECT id FROM users WHERE phone = ? AND role = 'customer'"
          ).get(customer_phone.trim());

          if (existingCustomer) {
            customer_id = existingCustomer.id;
          } else {
            // Also check if any user (non-customer) has this phone — don't duplicate
            const anyUser = db.prepare("SELECT id FROM users WHERE phone = ?").get(customer_phone.trim());
            if (anyUser) {
              customer_id = anyUser.id; // reuse existing user
            } else {
              const bcrypt = require('bcryptjs');
              const salt = bcrypt.genSaltSync(10);
              const hashedPassword = bcrypt.hashSync(`bloom_${Date.now()}`, salt);
              const newCust = db.prepare(
                "INSERT INTO users (name, phone, password, role, created_at, updated_at) VALUES (?, ?, ?, 'customer', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
              ).run(customer_name || 'Guest', customer_phone.trim(), hashedPassword);
              customer_id = newCust.lastInsertRowid;
            }
          }
        }

        // Save delivery address to customer_addresses if delivery
        if (customer_id && delivery_address && (order_type === 'delivery' || order_type === 'pre_order')) {
          const addrClean = delivery_address.trim();
          let existingAddr = null;
          try {
            existingAddr = db.prepare(
              "SELECT id FROM customer_addresses WHERE customer_id = ? AND address_line_1 = ?"
            ).get(customer_id, addrClean);
          } catch (_) {
            try {
              existingAddr = db.prepare(
                "SELECT id FROM customer_addresses WHERE customer_id = ? AND address = ?"
              ).get(customer_id, addrClean);
            } catch (__) {}
          }

          if (!existingAddr) {
            try {
              db.prepare(
                "INSERT INTO customer_addresses (customer_id, label, address_line_1, created_at, updated_at) VALUES (?, 'Delivery', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
              ).run(customer_id, addrClean);
            } catch (e) {
              // fallback: try 'address' column for legacy schema
              try {
                db.prepare(
                  "INSERT INTO customer_addresses (customer_id, label, address, created_at, updated_at) VALUES (?, 'Delivery', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
                ).run(customer_id, addrClean);
              } catch (_) { /* ignore if column doesn't exist */ }
            }
          }
        }

        // ─── Hybrid Stock Logic ──────────────────────────
        // Walk-in: auto-deduct from product_stock if available → completed / preparing
        // Non-walk-in (delivery/pickup/pre_order): LAZY deduction — always create
        //   production tasks. Staff can later "fulfill from stock" manually.
        let initialStatus;
        let stockDeducted = 0;
        let needsProduction = false;

        if (order_type === 'walk_in') {
          const getReadyStockCheck = db.prepare('SELECT quantity FROM product_stock WHERE product_id = ? AND location_id = ?');
          let allSubmittableFromStock = true;

          for (const item of processedItems) {
            // Cannot satisfy from ready-made stock if customized
            if (item.special_instructions) {
              allSubmittableFromStock = false;
              break;
            }
            let customMats = item.custom_materials;
            if (typeof customMats === 'string') {
              try { customMats = JSON.parse(customMats); } catch { customMats = null; }
            }
            if (customMats && Array.isArray(customMats) && customMats.length > 0) {
              allSubmittableFromStock = false;
              break;
            }

            // Only try fulfilling from stock if user specifically requested it
            const requested = item.fulfill_from_stock === true || item.fulfill_from_stock === 'true';
            if (!requested) {
              allSubmittableFromStock = false;
              break;
            }

            if (item.product_id) {
              const ready = getReadyStockCheck.get(item.product_id, location_id);
              if (!ready || ready.quantity < item.quantity) {
                allSubmittableFromStock = false;
                break;
              }
            } else {
              // Ad-hoc item with no product ID always needs some "production" or ad-hoc handling
              allSubmittableFromStock = false;
              break;
            }
          }

          if (allSubmittableFromStock) {
            initialStatus = 'completed';
            stockDeducted = 1;
            needsProduction = false;
          } else {
            initialStatus = 'preparing';
            needsProduction = true;
          }
        } else {
          // delivery / pickup / pre_order — always pending, production tasks created.
          // Fulfill-from-stock for these types is handled manually after sale creation.
          initialStatus = 'pending';
          needsProduction = true;
        }

        // Insert sale
        const saleResult = db.prepare(`
          INSERT INTO sales (sale_number, location_id, customer_id, customer_name, customer_phone,
            subtotal, tax_total, discount_amount, discount_type, discount_percentage, discount_approved_by,
            delivery_charges, delivery_address, scheduled_date, scheduled_time,
            grand_total, payment_status, order_type, status, stock_deducted,
            special_instructions, customer_notes, sender_name, sender_phone, sender_message, created_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          saleNumber, location_id, customer_id || null, customer_name || null, customer_phone || null,
          subtotal, taxTotal, discountAmount, discount_type || null, discountPercentage, discountApprovedBy,
          delivery_charges || 0, delivery_address || null,
          scheduled_date || (order_type === 'walk_in' ? localToday() : null),
          scheduled_time || (order_type === 'walk_in' ? nowTimeStr() : null),
          grandTotal, paymentStatus, order_type, initialStatus, stockDeducted,
          notes || special_instructions || '', customer_notes || '',
          sender_name || '', sender_phone || '', sender_message || '', req.user.id,
          nowLocal()
        );
        const saleId = saleResult.lastInsertRowid;

        // Insert items — omit line_total (GENERATED ALWAYS on production; DEFAULT 0 on legacy)
        const insertItem = db.prepare(
          'INSERT INTO sale_items (sale_id, product_id, material_id, product_name, quantity, unit_price, tax_rate, tax_amount, materials_deducted, from_product_stock, special_instructions, image_url, custom_materials) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );
        const saleItemIds = [];
        for (const item of processedItems) {
          const res = insertItem.run(
              saleId,
              item.product_id,
              item.material_id,
              item.product_name,
              item.quantity,
              item.unit_price,
              item.tax_rate,
              item.tax_amount,
              0,
              0,
              item.special_instructions || null,
              item.image_url || null,
              item.custom_materials ? JSON.stringify(item.custom_materials) : null
          );
          saleItemIds.push({ ...item, sale_item_id: res.lastInsertRowid });
        }

        // ─── Stock deduction & production task creation ───
        const deductProductStock = db.prepare('UPDATE product_stock SET quantity = GREATEST(0, quantity - ?), updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND location_id = ?');
        const deductMaterialStock = db.prepare('UPDATE material_stock SET quantity = GREATEST(0, quantity - ?), updated_at = CURRENT_TIMESTAMP WHERE material_id = ? AND location_id = ?');
        const logMaterialTx = db.prepare(`INSERT INTO material_transactions (material_id, location_id, type, quantity, reference_type, reference_id, notes, created_by) VALUES (?, ?, 'usage', ?, 'sale', ?, ?, ?)`);
        const getBOM = db.prepare('SELECT material_id, quantity FROM product_materials WHERE product_id = ?');
        const getReadyStock = db.prepare('SELECT quantity FROM product_stock WHERE product_id = ? AND location_id = ?');
        const insertTask = db.prepare(
          `INSERT INTO production_tasks (sale_id, sale_item_id, product_id, location_id, quantity, priority, notes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        );

        if (stockDeducted && !needsProduction) {
          // Walk-in, all products in stock: deduct from product_stock
          for (const item of saleItemIds) {
            if (item.material_id) {
              deductMaterialStock.run(item.quantity, item.material_id, location_id);
              logMaterialTx.run(item.material_id, location_id, item.quantity, saleId, `Sale ${saleNumber}`, req.user.id);
              db.prepare('UPDATE sale_items SET materials_deducted = 1 WHERE id = ?').run(item.sale_item_id);
            } else if (item.product_id) {
              deductProductStock.run(item.quantity, item.product_id, location_id);
              db.prepare('UPDATE sale_items SET from_product_stock = 1, materials_deducted = 1 WHERE id = ?').run(item.sale_item_id);
            }
          }
        } else if (needsProduction) {
          // Create production tasks — for walk-in, use partial ready stock; for others, always full production
          for (const item of saleItemIds) {
            if (item.material_id) {
              deductMaterialStock.run(item.quantity, item.material_id, location_id);
              logMaterialTx.run(item.material_id, location_id, item.quantity, saleId, `Sale ${saleNumber}`, req.user.id);
              db.prepare('UPDATE sale_items SET materials_deducted = 1 WHERE id = ?').run(item.sale_item_id);
            } else if (item.product_id) {
              let toMake = item.quantity;

              // At checkout time, fulfillment is strictly for walk-ins that requested it
              const shouldFulfill = order_type === 'walk_in' && (item.fulfill_from_stock === true || item.fulfill_from_stock === 'true');

              if (shouldFulfill) {
                const ready = getReadyStock.get(item.product_id, location_id);
                const readyQty = ready ? ready.quantity : 0;
                if (readyQty > 0) {
                  const fromStock = Math.min(readyQty, item.quantity);
                  toMake = item.quantity - fromStock;
                  deductProductStock.run(fromStock, item.product_id, location_id);
                  if (fromStock > 0) {
                    db.prepare('UPDATE sale_items SET from_product_stock = 1, materials_deducted = 1 WHERE id = ?').run(item.sale_item_id);
                  }
                }
              }

              if (toMake > 0) {
                const priority = order_type === 'walk_in' ? 'urgent' : 'medium';
                insertTask.run(saleId, item.sale_item_id, item.product_id, location_id, toMake, priority, '', nowLocal());
              }
            } else {
              // Ad-hoc item (no product_id) — still create a production task
              const priority = order_type === 'walk_in' ? 'urgent' : 'medium';
              insertTask.run(saleId, item.sale_item_id, item.product_id || null, location_id, item.quantity, priority, item.special_instructions || '', nowLocal());
            }
          }
        }

        // Final status check: Auto-promote to 'completed' (for walk-in) or 'ready' (for others)
        // if everything was fulfilled from stock (i.e. zero production tasks created)
        if (needsProduction) {
          const taskCount = db.prepare("SELECT COUNT(*) as cnt FROM production_tasks WHERE sale_id = ? AND status NOT IN ('completed', 'cancelled')").get(saleId).cnt;
          const unfulfilledItems = db.prepare("SELECT COUNT(*) as cnt FROM sale_items WHERE sale_id = ? AND product_id IS NOT NULL AND from_product_stock = 0").get(saleId).cnt;

          if (taskCount === 0 && unfulfilledItems === 0) {
            const finalStatus = order_type === 'walk_in' ? 'completed' : 'ready';
            db.prepare("UPDATE sales SET status = ?, stock_deducted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(finalStatus, saleId);
            if (order_type === 'pickup') {
              db.prepare("UPDATE sales SET pickup_status = 'ready_for_pickup' WHERE id = ?").run(saleId);
            }
          }
        }

        // Insert payments
        if (payments && payments.length > 0) {
          const insertPayment = db.prepare(
            'INSERT INTO payments (sale_id, method, amount, reference_number, received_by, created_at) VALUES (?, ?, ?, ?, ?, ?)'
          );
          for (const pmt of payments) {
            insertPayment.run(saleId, pmt.method, pmt.amount, pmt.reference_number || null, req.user.id, nowLocal());
          }

          // Update cash register for today
          const register = db.prepare('SELECT id FROM cash_registers WHERE location_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1').get(location_id);
          if (register) {
            for (const pmt of payments) {
              if (pmt.method === 'cash') {
                db.prepare('UPDATE cash_registers SET total_cash_sales = total_cash_sales + ?, expected_cash = expected_cash + ? WHERE id = ?').run(pmt.amount, pmt.amount, register.id);
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

        // Auto-create delivery record for delivery orders
        const needsDeliveryRecord = order_type === 'delivery' || (order_type === 'pre_order' && delivery_address);
        if (needsDeliveryRecord && delivery_address) {
          const codAmount = Math.max(0, grandTotal - totalPaid);
          db.prepare(`
            INSERT INTO deliveries (sale_id, location_id, delivery_address, customer_name, customer_phone,
              scheduled_date, scheduled_time, cod_amount, cod_status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(saleId, location_id, delivery_address, customer_name || null, customer_phone || null,
            scheduled_date || null, scheduled_time || null, codAmount, codAmount > 0 ? 'pending' : 'collected', nowLocal());
        }

        // Auto-save delivery address to customer's saved addresses
        if (customer_id && delivery_address) {
          const addrClean = delivery_address.trim();
          let existingAddr = null;
          try {
            existingAddr = db.prepare(
              "SELECT id FROM customer_addresses WHERE customer_id = ? AND address_line_1 = ?"
            ).get(customer_id, addrClean);
          } catch (_) {
            try {
              existingAddr = db.prepare(
                "SELECT id FROM customer_addresses WHERE customer_id = ? AND address = ?"
              ).get(customer_id, addrClean);
            } catch (__) {}
          }

          if (!existingAddr) {
            const addrCount = db.prepare(
              "SELECT COUNT(*) as cnt FROM customer_addresses WHERE customer_id = ?"
            ).get(customer_id).cnt;
            try {
              db.prepare(
                "INSERT INTO customer_addresses (customer_id, label, address_line_1, is_default) VALUES (?, ?, ?, ?)"
              ).run(customer_id, 'Delivery', addrClean, addrCount === 0 ? 1 : 0);
            } catch (e) {
              try {
                db.prepare(
                  "INSERT INTO customer_addresses (customer_id, label, address, is_default) VALUES (?, ?, ?, ?)"
                ).run(customer_id, 'Delivery', addrClean, addrCount === 0 ? 1 : 0);
              } catch (__) {}
            }
          }
        }

        // Auto-set pickup_status for pickup orders (always waiting — lazy stock)
        if (order_type === 'pickup') {
          db.prepare("UPDATE sales SET pickup_status = 'waiting' WHERE id = ?").run(saleId);
        }

        // Update customer total_spent and credit_balance
        if (customer_id) {
          db.prepare('UPDATE users SET total_spent = total_spent + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(grandTotal, customer_id);
          // If not fully paid, add remaining to credit balance
          const unpaid = grandTotal - totalPaid;
          if (unpaid > 0) {
            db.prepare('UPDATE users SET credit_balance = credit_balance + ? WHERE id = ?').run(unpaid, customer_id);
          }
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

      // Fire notifications (non-blocking)
      if (sale.order_type !== 'walk_in') {
        notifyByRole({
          roles: ['owner', 'manager'],
          locationId: sale.location_id,
          title: 'New Order',
          body: `${sale.sale_number} — ${(sale.order_type || '').replace('_', ' ')} • ₹${(sale.grand_total || 0).toFixed(0)}${sale.customer_name ? ' from ' + sale.customer_name : ''}`,
          type: 'new_order',
          data: { saleId: sale.id, screen: 'SaleDetail' },
        });
      }
      if (sale.customer_id) {
        createNotification({
          userIds: sale.customer_id,
          title: 'Order Placed',
          body: `Your order ${sale.sale_number} has been placed successfully! Total: ₹${(sale.grand_total || 0).toFixed(0)}`,
          type: 'order_status',
          data: { saleId: sale.id, screen: 'CustomerOrderDetail' },
        });
      }
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

      db.prepare('INSERT INTO payments (sale_id, method, amount, reference_number, received_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(sale.id, method, amount, reference_number || null, req.user.id, nowLocal());

      // Recalculate payment status
      const totalPaid = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE sale_id = ?').get(sale.id).total;
      let paymentStatus = 'pending';
      if (totalPaid >= sale.grand_total) paymentStatus = 'paid';
      else if (totalPaid > 0) paymentStatus = 'partial';

      db.prepare('UPDATE sales SET payment_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(paymentStatus, sale.id);

      // Decrement customer credit balance
      if (sale.customer_id) {
        db.prepare('UPDATE users SET credit_balance = GREATEST(0, credit_balance - ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(amount, sale.customer_id);
      }

      // Update cash register
      const register = db.prepare('SELECT id FROM cash_registers WHERE location_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1').get(sale.location_id);
      if (register) {
        if (method === 'cash') {
          db.prepare('UPDATE cash_registers SET total_cash_sales = total_cash_sales + ?, expected_cash = expected_cash + ? WHERE id = ?').run(amount, amount, register.id);
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

      const cancelTx = db.transaction(() => {
        db.prepare("UPDATE sales SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);

        // Update cash register (decrement totals) if there's an open session
        const register = db.prepare('SELECT id FROM cash_registers WHERE location_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1').get(sale.location_id);
        if (register) {
          const payments = db.prepare('SELECT method, amount FROM payments WHERE sale_id = ?').all(sale.id);
          for (const pmt of payments) {
            if (pmt.method === 'cash') {
              db.prepare('UPDATE cash_registers SET total_cash_sales = total_cash_sales - ?, expected_cash = expected_cash - ? WHERE id = ?').run(pmt.amount, pmt.amount, register.id);
            } else if (pmt.method === 'card') {
              db.prepare('UPDATE cash_registers SET total_card_sales = total_card_sales - ? WHERE id = ?').run(pmt.amount, register.id);
            } else if (pmt.method === 'upi') {
              db.prepare('UPDATE cash_registers SET total_upi_sales = total_upi_sales - ? WHERE id = ?').run(pmt.amount, register.id);
            }
          }
        }

        // Cancel any pending/in-progress production tasks
        db.prepare("UPDATE production_tasks SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE sale_id = ? AND status NOT IN ('completed', 'cancelled')").run(req.params.id);

        const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(req.params.id);

        for (const item of items) {
          if (item.from_product_stock && item.product_id) {
            // Was fulfilled from product_stock → return to product_stock
            const existing = db.prepare('SELECT id FROM product_stock WHERE product_id = ? AND location_id = ?').get(item.product_id, sale.location_id);
            if (existing) {
              db.prepare('UPDATE product_stock SET quantity = quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(item.quantity, existing.id);
            } else {
              db.prepare('INSERT INTO product_stock (product_id, location_id, quantity) VALUES (?, ?, ?)').run(item.product_id, sale.location_id, item.quantity);
            }
          } else if (item.materials_deducted && item.product_id) {
            // Materials already consumed (production done) → add finished product to product_stock
            // Cannot restore raw materials — they're already used up
            const existing = db.prepare('SELECT id FROM product_stock WHERE product_id = ? AND location_id = ?').get(item.product_id, sale.location_id);
            if (existing) {
              db.prepare('UPDATE product_stock SET quantity = quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(item.quantity, existing.id);
            } else {
              db.prepare('INSERT INTO product_stock (product_id, location_id, quantity) VALUES (?, ?, ?)').run(item.product_id, sale.location_id, item.quantity);
            }
          } else if (item.materials_deducted && item.material_id) {
            // Raw material sale — restore material stock
            db.prepare('UPDATE material_stock SET quantity = quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE material_id = ? AND location_id = ?').run(item.quantity, item.material_id, sale.location_id);
            db.prepare(`INSERT INTO material_transactions (material_id, location_id, type, quantity, reference_type, reference_id, notes, created_by) VALUES (?, ?, 'return', ?, 'sale_cancel', ?, ?, ?)`)
              .run(item.material_id, sale.location_id, item.quantity, sale.id, `Cancel ${sale.sale_number}`, req.user.id);
          }
          // If nothing was deducted yet (pending production), nothing to restore
        }

        db.prepare('UPDATE sales SET stock_deducted = 0 WHERE id = ?').run(req.params.id);
      });
      cancelTx();

      res.json({ success: true, message: 'Sale cancelled and stock handled' });
    } catch (err) { next(err); }
  }
);

// ─── PUT /api/sales/:id/status ───────────────────────────────
// Order lifecycle: pending → preparing → ready → completed
// 'ready' is only allowed when ALL production tasks for this sale are completed/cancelled.
// 'completed' is only allowed when status is 'ready'.
router.put(
  '/:id/status',
  authenticate,
  authorize('owner', 'manager', 'employee'),
  [
    body('status').isIn(['pending', 'preparing', 'ready', 'completed']).withMessage('Invalid status'),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });

      const db = getDb();
      const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(req.params.id);
      if (!sale) return res.status(404).json({ success: false, message: 'Sale not found' });
      if (sale.status === 'cancelled') return res.status(400).json({ success: false, message: 'Cannot update cancelled order' });

      const { status } = req.body;
      const validTransitions = {
        pending: ['preparing', 'cancelled'],
        preparing: ['ready', 'cancelled'],
        ready: ['completed', 'cancelled'],
        completed: [],
      };

      const allowed = validTransitions[sale.status] || [];
      if (!allowed.includes(status)) {
        return res.status(400).json({ success: false, message: `Cannot transition from ${sale.status} to ${status}` });
      }

      // ── Enforce production task completion before marking 'ready' ──
      if (status === 'ready') {
        const pendingTasks = db.prepare(
          "SELECT COUNT(*) as cnt FROM production_tasks WHERE sale_id = ? AND status NOT IN ('completed', 'cancelled')"
        ).get(sale.id);
        if (pendingTasks.cnt > 0) {
          return res.status(400).json({
            success: false,
            message: `Cannot mark as ready — ${pendingTasks.cnt} production task(s) still pending. Complete all tasks first.`,
          });
        }
      }

      // ── Enforce delivery completion before marking order 'completed' ──
      if (status === 'completed' && sale.order_type === 'delivery') {
        const delivery = db.prepare("SELECT status FROM deliveries WHERE sale_id = ? LIMIT 1").get(sale.id);
        if (delivery && delivery.status !== 'delivered') {
          return res.status(400).json({
            success: false,
            message: `Cannot complete — delivery is still '${delivery.status}'. Mark the delivery as 'delivered' first.`,
          });
        }
      }

      // ── Enforce pickup payment before marking order 'completed' ──
      if (status === 'completed' && sale.order_type === 'pickup') {
        const totalPaid = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE sale_id = ?').get(sale.id).total;
        const balanceDue = sale.grand_total - totalPaid;
        if (balanceDue > 0.01) {
          return res.status(400).json({
            success: false,
            message: `Cannot complete pickup — balance due: ₹${balanceDue.toFixed(2)}. Please collect payment first.`,
          });
        }
      }

      db.prepare('UPDATE sales SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, sale.id);

      // If marking ready, also update stock_deducted flag
      if (status === 'ready') {
        db.prepare('UPDATE sales SET stock_deducted = 1 WHERE id = ?').run(sale.id);
        // Update pickup_status for pickup orders
        if (sale.order_type === 'pickup') {
          db.prepare("UPDATE sales SET pickup_status = 'ready_for_pickup' WHERE id = ?").run(sale.id);
        }
      }

      // If marking completed for pickup orders, update pickup_status
      if (status === 'completed' && sale.order_type === 'pickup') {
        db.prepare("UPDATE sales SET pickup_status = 'picked_up' WHERE id = ?").run(sale.id);
      }

      // Auto-cancel any remaining production tasks when order is completed
      if (status === 'completed') {
        db.prepare("UPDATE production_tasks SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE sale_id = ? AND status NOT IN ('completed', 'cancelled')").run(sale.id);
      }

      const updated = db.prepare('SELECT * FROM sales WHERE id = ?').get(sale.id);
      res.json({ success: true, data: updated });

      // Notify customer on status change
      if (sale.customer_id && (status === 'ready' || status === 'completed')) {
        const statusLabel = status === 'ready' ? 'Ready' : 'Completed';
        createNotification({
          userIds: sale.customer_id,
          title: `Order ${statusLabel}`,
          body: `Your order ${sale.sale_number} is now ${statusLabel.toLowerCase()}${status === 'ready' && sale.order_type === 'pickup' ? '. You can pick it up now!' : '.'}`,
          type: 'order_status',
          data: { saleId: sale.id, screen: 'CustomerOrderDetail' },
        });
      }
    } catch (err) { next(err); }
  }
);

// ─── POST /api/sales/:id/fulfill-from-stock ──────────────────
// Manually fulfill a sale item from product_stock (lazy deduction).
// Deducts ready stock, marks item as from_product_stock, cancels/reduces production task.
// If ALL items are fulfilled → sale status becomes 'ready'.
router.post(
  '/:id/fulfill-from-stock',
  authenticate,
  authorize('owner', 'manager', 'employee'),
  [
    body('sale_item_id').isInt({ min: 1 }).withMessage('sale_item_id is required'),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });

      const db = getDb();
      const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(req.params.id);
      if (!sale) return res.status(404).json({ success: false, message: 'Sale not found' });
      if (sale.status === 'cancelled' || sale.status === 'completed') {
        return res.status(400).json({ success: false, message: `Cannot fulfill items for ${sale.status} orders` });
      }

      const { sale_item_id } = req.body;
      const item = db.prepare('SELECT * FROM sale_items WHERE id = ? AND sale_id = ?').get(sale_item_id, sale.id);
      if (!item) return res.status(404).json({ success: false, message: 'Sale item not found' });
      if (!item.product_id) return res.status(400).json({ success: false, message: 'Only product items can be fulfilled from stock' });
      if (item.from_product_stock) return res.status(400).json({ success: false, message: 'Item already fulfilled from stock' });

      // Check available stock
      const stock = db.prepare('SELECT quantity FROM product_stock WHERE product_id = ? AND location_id = ?').get(item.product_id, sale.location_id);
      const available = stock ? stock.quantity : 0;
      if (available < item.quantity) {
        return res.status(400).json({
          success: false,
          message: `Insufficient stock. Available: ${available}, Required: ${item.quantity}`,
        });
      }

      const fulfillTx = db.transaction(() => {
        // Deduct from product_stock
        db.prepare('UPDATE product_stock SET quantity = quantity - ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND location_id = ?')
          .run(item.quantity, item.product_id, sale.location_id);

        // Mark item as fulfilled from stock
        db.prepare('UPDATE sale_items SET from_product_stock = 1, materials_deducted = 1 WHERE id = ?').run(item.id);

        // Cancel/complete the production task for this item
        const task = db.prepare("SELECT id FROM production_tasks WHERE sale_item_id = ? AND status NOT IN ('completed', 'cancelled')").get(item.id);
        if (task) {
          db.prepare("UPDATE production_tasks SET status = 'cancelled', notes = 'Fulfilled from stock', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(task.id);
        }

        // Check if ALL product items are now fulfilled
        const unfulfilled = db.prepare(
          "SELECT COUNT(*) as cnt FROM sale_items WHERE sale_id = ? AND product_id IS NOT NULL AND from_product_stock = 0"
        ).get(sale.id);

        // Also check if there are remaining pending production tasks
        const pendingTasks = db.prepare(
          "SELECT COUNT(*) as cnt FROM production_tasks WHERE sale_id = ? AND status NOT IN ('completed', 'cancelled')"
        ).get(sale.id);

        if (unfulfilled.cnt === 0 && pendingTasks.cnt === 0) {
          // All items fulfilled → mark as ready
          db.prepare("UPDATE sales SET status = 'ready', stock_deducted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(sale.id);
          if (sale.order_type === 'pickup') {
            db.prepare("UPDATE sales SET pickup_status = 'ready_for_pickup' WHERE id = ?").run(sale.id);
          }
        }
      });
      fulfillTx();

      const updated = db.prepare('SELECT * FROM sales WHERE id = ?').get(sale.id);
      updated.items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(sale.id);
      res.json({ success: true, message: 'Item fulfilled from stock', data: updated });
    } catch (err) { next(err); }
  }
);

// ─── PUT /api/sales/:id/convert-type ─────────────────────────
// Convert between pickup ↔ delivery. Optionally add delivery charges & address.
router.put(
  '/:id/convert-type',
  authenticate,
  authorize('owner', 'manager'),
  [
    body('new_order_type').isIn(['pickup', 'delivery']).withMessage('Must be pickup or delivery'),
    body('delivery_address').optional({ nullable: true }).trim(),
    body('delivery_charges').optional().isFloat({ min: 0 }),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });

      const db = getDb();
      const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(req.params.id);
      if (!sale) return res.status(404).json({ success: false, message: 'Sale not found' });
      if (sale.status === 'cancelled') return res.status(400).json({ success: false, message: 'Cannot convert cancelled order' });
      if (sale.order_type !== 'pickup' && sale.order_type !== 'delivery') {
        return res.status(400).json({ success: false, message: 'Can only convert between pickup and delivery' });
      }
      if (sale.order_type === req.body.new_order_type) {
        return res.status(400).json({ success: false, message: `Order is already ${sale.order_type}` });
      }

      const { new_order_type, delivery_address, delivery_charges } = req.body;

      if (new_order_type === 'delivery' && !delivery_address && !sale.delivery_address) {
        return res.status(400).json({ success: false, message: 'Delivery address is required when converting to delivery' });
      }

      const convertTx = db.transaction(() => {
        const addr = delivery_address || sale.delivery_address || '';
        const charges = delivery_charges != null ? delivery_charges : 0;

        // Update order type
        const newGrandTotal = sale.grand_total - (sale.delivery_charges || 0) + charges;
        db.prepare(`
          UPDATE sales SET order_type = ?, delivery_address = ?, delivery_charges = ?,
          grand_total = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `).run(new_order_type, new_order_type === 'delivery' ? addr : sale.delivery_address, charges, newGrandTotal, sale.id);

        if (new_order_type === 'delivery') {
          // Pickup → Delivery: clear pickup_status, create delivery record
          db.prepare("UPDATE sales SET pickup_status = NULL, picked_up_at = NULL WHERE id = ?").run(sale.id);

          // Check if delivery record already exists
          const existingDelivery = db.prepare('SELECT id FROM deliveries WHERE sale_id = ?').get(sale.id);
          if (!existingDelivery) {
            const totalPaid = db.prepare('SELECT COALESCE(SUM(amount),0) as total FROM payments WHERE sale_id = ?').get(sale.id).total;
            const codAmount = Math.max(0, newGrandTotal - totalPaid);
            db.prepare(`
              INSERT INTO deliveries (sale_id, location_id, delivery_address, customer_name, customer_phone,
                scheduled_date, scheduled_time, cod_amount, cod_status, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(sale.id, sale.location_id, addr,
              sale.customer_name || null, sale.customer_phone || null,
              sale.scheduled_date || null, sale.scheduled_time || null,
              codAmount, codAmount > 0 ? 'pending' : 'collected', nowLocal());
          } else {
            // Update existing delivery record
            db.prepare('UPDATE deliveries SET delivery_address = ?, updated_at = CURRENT_TIMESTAMP WHERE sale_id = ?')
              .run(addr, sale.id);
          }
        } else {
          // Delivery → Pickup: set pickup_status, cancel pending delivery
          let pickupStatus = 'waiting';
          if (sale.status === 'ready') pickupStatus = 'ready_for_pickup';
          else if (sale.status === 'completed') pickupStatus = 'picked_up';
          db.prepare("UPDATE sales SET pickup_status = ? WHERE id = ?").run(pickupStatus, sale.id);

          // Cancel any pending/assigned delivery
          const delivery = db.prepare("SELECT id, status FROM deliveries WHERE sale_id = ?").get(sale.id);
          if (delivery && !['delivered', 'cancelled'].includes(delivery.status)) {
            db.prepare("UPDATE deliveries SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(delivery.id);
          }
        }
      });
      convertTx();

      // Return updated sale with delivery/items
      const updated = db.prepare(`
        SELECT s.*, l.name as location_name FROM sales s
        LEFT JOIN locations l ON s.location_id = l.id WHERE s.id = ?
      `).get(sale.id);
      updated.items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(sale.id);
      const delivery = db.prepare('SELECT * FROM deliveries WHERE sale_id = ?').get(sale.id);
      if (delivery) updated.delivery = delivery;
      res.json({ success: true, message: `Order converted to ${new_order_type}`, data: updated });
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

      // Enforce refund limit for managers
      if (req.user.role === 'manager') {
        const refundLimit = parseFloat(
          (db.prepare("SELECT value FROM settings WHERE key = 'refund_manager_limit'").get() || {}).value || '10000'
        );
        if (amount > refundLimit) {
          return res.status(403).json({
            success: false,
            message: `Refund of ₹${amount} exceeds manager limit (₹${refundLimit}). Only an owner can approve this refund.`,
          });
        }
      }

      db.prepare(
        `INSERT INTO refunds (sale_id, amount, reason, status, requested_by, approved_by, refund_method)
         VALUES (?, ?, ?, 'processed', ?, ?, ?)`
      ).run(req.params.id, amount, reason, req.user.id, req.user.id, refund_method);

      db.prepare("UPDATE sales SET payment_status = 'refunded', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);

      // Update cash register if cash refund
      if (refund_method === 'cash') {
        const register = db.prepare('SELECT id FROM cash_registers WHERE location_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1').get(sale.location_id);
        if (register) {
          db.prepare('UPDATE cash_registers SET total_refunds_cash = total_refunds_cash + ?, expected_cash = expected_cash - ? WHERE id = ?').run(amount, amount, register.id);
        }
      }

      const refund = db.prepare('SELECT * FROM refunds WHERE sale_id = ?').get(req.params.id);
      res.status(201).json({ success: true, data: refund });
    } catch (err) { next(err); }
  }
);

// ─── POST /api/sales/customer-order ──────────────────────────
// Customer places an order from the customer app (delivery or pickup only)
router.post(
  '/customer-order',
  authenticate,
  [
    body('location_id').isInt().withMessage('Location is required'),
    body('order_type').isIn(['pickup', 'delivery']).withMessage('Order type must be pickup or delivery'),
    body('items').isArray({ min: 1 }).withMessage('At least one item is required'),
    body('items.*.product_id').isInt(),
    body('items.*.quantity').isInt({ min: 1 }),
    body('delivery_address').optional({ nullable: true }).trim(),
    body('scheduled_date').optional({ nullable: true }).trim(),
    body('scheduled_time').optional({ nullable: true }).trim(),
    body('notes').optional({ nullable: true }).trim(),
    body('sender_name').optional({ nullable: true }).trim(),
    body('sender_phone').optional({ nullable: true }).trim(),
    body('sender_message').optional({ nullable: true }).trim(),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });

      const db = getDb();
      const {
        location_id, order_type, items, delivery_address,
        scheduled_date, scheduled_time, notes,
        sender_name, sender_phone, sender_message,
      } = req.body;

      if (order_type === 'delivery' && !delivery_address) {
        return res.status(400).json({ success: false, message: 'Delivery address is required for delivery orders' });
      }

      const createOrder = db.transaction(() => {
        let subtotal = 0;
        let taxTotal = 0;
        const processedItems = items.map((item) => {
          const product = db.prepare('SELECT id, name, selling_price, tax_rate_id FROM products WHERE id = ? AND is_active = 1').get(item.product_id);
          if (!product) throw new Error(`Product not found or inactive`);

          const unitPrice = product.selling_price;
          let taxRate = 0;
          if (product.tax_rate_id) {
            const tr = db.prepare('SELECT percentage FROM tax_rates WHERE id = ?').get(product.tax_rate_id);
            if (tr) taxRate = tr.percentage;
          }
          const qty = item.quantity;
          const taxAmount = (unitPrice * qty * taxRate) / 100;
          const lineTotal = (unitPrice * qty) + taxAmount;
          subtotal += unitPrice * qty;
          taxTotal += taxAmount;
          return { product_id: product.id, product_name: product.name, quantity: qty, unit_price: unitPrice, tax_rate: taxRate, tax_amount: taxAmount, line_total: lineTotal };
        });

        const grandTotal = subtotal + taxTotal;
        const saleNumber = generateSaleNumber(db, location_id);

        const saleResult = db.prepare(`
          INSERT INTO sales (sale_number, location_id, customer_id, customer_name, customer_phone,
            subtotal, tax_total, discount_amount, delivery_charges,
            delivery_address, scheduled_date, scheduled_time,
            grand_total, payment_status, order_type, status, stock_deducted,
            special_instructions, customer_notes, sender_name, sender_phone, sender_message, created_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, 'pending', ?, 'pending', 0, '', ?, ?, ?, ?, ?, ?)
        `).run(
          saleNumber, location_id, req.user.id, req.user.name, req.user.phone,
          subtotal, taxTotal,
          delivery_address || null, scheduled_date || null, scheduled_time || null,
          grandTotal, order_type,
          notes || '',
          sender_name || '', sender_phone || '', sender_message || '', req.user.id
        );
        const saleId = saleResult.lastInsertRowid;

        const insertItem = db.prepare(
          'INSERT INTO sale_items (sale_id, product_id, material_id, product_name, quantity, unit_price, tax_rate, tax_amount, materials_deducted, from_product_stock, special_instructions, image_url) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 0, 0, ?, ?)'
        );
        const insertTask = db.prepare(
          `INSERT INTO production_tasks (sale_id, sale_item_id, product_id, location_id, quantity, priority, notes, created_at) VALUES (?, ?, ?, ?, ?, 'medium', '', ?)`
        );

        for (const item of processedItems) {
          const res = insertItem.run(saleId, item.product_id, item.product_name, item.quantity, item.unit_price, item.tax_rate, item.tax_amount, item.special_instructions || null, item.image_url || null);
          // Create production task for all items
          insertTask.run(saleId, res.lastInsertRowid, item.product_id || null, location_id, item.quantity, nowLocal());
        }

        // Auto-create delivery record
        if (order_type === 'delivery' && delivery_address) {
          db.prepare(`
            INSERT INTO deliveries (sale_id, location_id, delivery_address, customer_name, customer_phone,
              scheduled_date, scheduled_time, cod_amount, cod_status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
          `).run(saleId, location_id, delivery_address, req.user.name, req.user.phone,
            scheduled_date || null, scheduled_time || null, grand_total, nowLocal());
        }

        // Update customer credit balance
        db.prepare('UPDATE users SET credit_balance = credit_balance + ?, total_spent = total_spent + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(grandTotal, grandTotal, req.user.id);

        return { id: saleId, sale_number: saleNumber, grand_total: grandTotal };
      });

      const result = createOrder();
      res.status(201).json({ success: true, data: result });
    } catch (err) { next(err); }
  }
);

// ─── POST /api/sales/custom-item ─────────────────────────────
// Create a customized product variant during sale (add/remove materials, custom charges).
// Returns the product_id and adjusted price for the POS to add to the cart.
router.post(
  '/custom-item',
  authenticate,
  authorize('owner', 'manager', 'employee'),
  [
    body('base_product_id').optional({ nullable: true }).isInt(),
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('base_price').isFloat({ min: 0 }).withMessage('Base price is required'),
    body('custom_charge').optional().isFloat(),
    body('location_id').isInt().withMessage('Location is required'),
    body('materials').optional().isArray(),
    body('materials.*.material_id').optional().isInt(),
    body('materials.*.quantity').optional().isFloat({ min: 0.01 }),
    body('add_materials').optional().isArray(),
    body('add_materials.*.material_id').optional().isInt(),
    body('add_materials.*.quantity').optional().isFloat({ min: 0.01 }),
    body('remove_material_ids').optional().isArray(),
    body('notes').optional().trim(),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });

      const db = getDb();
      const {
        base_product_id, name, base_price, custom_charge,
        location_id, materials, add_materials, remove_material_ids, notes,
      } = req.body;

      const loc = db.prepare('SELECT id FROM locations WHERE id = ?').get(location_id);
      if (!loc) return res.status(404).json({ success: false, message: 'Location not found' });

      const createCustom = db.transaction(() => {
        // 1. Create custom product variant
        const sku = 'CUST-' + Date.now().toString(36).toUpperCase();
        const finalPrice = (base_price || 0) + (custom_charge || 0);

        const prodResult = db.prepare(
          `INSERT INTO products (name, sku, category, type, selling_price, is_active, created_by)
           VALUES (?, ?, 'other', 'custom', ?, 0, ?)`
        ).run(name, sku, finalPrice, req.user.id);
        const productId = prodResult.lastInsertRowid;

        // 2. Build BOM from base product + modifications
        let finalMaterials = [];

        if (base_product_id) {
          // Start with base product's BOM
          const baseBOM = db.prepare(
            'SELECT material_id, quantity FROM product_materials WHERE product_id = ?'
          ).all(base_product_id);
          finalMaterials = baseBOM.map(b => ({ material_id: b.material_id, quantity: b.quantity }));

          // Remove specified materials
          if (remove_material_ids && remove_material_ids.length > 0) {
            finalMaterials = finalMaterials.filter(m => !remove_material_ids.includes(m.material_id));
          }

          // Add new materials
          if (add_materials && add_materials.length > 0) {
            for (const am of add_materials) {
              const existing = finalMaterials.find(m => m.material_id === am.material_id);
              if (existing) {
                existing.quantity += am.quantity;
              } else {
                finalMaterials.push({ material_id: am.material_id, quantity: am.quantity });
              }
            }
          }
        } else if (materials && materials.length > 0) {
          // Fully custom — use provided materials directly
          finalMaterials = materials;
        }

        // 3. Insert BOM for custom product
        const insertBom = db.prepare(
          'INSERT INTO product_materials (product_id, material_id, quantity) VALUES (?, ?, ?)'
        );
        for (const m of finalMaterials) {
          if (m.material_id && m.quantity > 0) {
            insertBom.run(productId, m.material_id, m.quantity);
          }
        }

        return {
          product_id: productId,
          sku,
          name,
          selling_price: finalPrice,
          base_price,
          custom_charge: custom_charge || 0,
          materials: finalMaterials,
          type: 'custom',
        };
      });

      const result = createCustom();
      res.status(201).json({ success: true, data: result });
    } catch (err) { next(err); }
  }
);

// ─── DELETE /api/sales/:id — Delete a sale (owner only) ───────
router.delete('/:id', authenticate, authorize('owner'), (req, res, next) => {
  try {
    const db = getDb();
    const sale = db.prepare('SELECT id FROM sales WHERE id = ?').get(req.params.id);
    if (!sale) return res.status(404).json({ success: false, message: 'Sale not found' });

    // Cascade delete
    db.prepare('DELETE FROM production_tasks WHERE sale_id = ?').run(sale.id);
    db.prepare('DELETE FROM deliveries WHERE sale_id = ?').run(sale.id);
    db.prepare('DELETE FROM payments WHERE sale_id = ?').run(sale.id);
    db.prepare('DELETE FROM sale_items WHERE sale_id = ?').run(sale.id);
    db.prepare('DELETE FROM sales WHERE id = ?').run(sale.id);

    res.json({ success: true, message: 'Sale deleted' });
  } catch (err) { next(err); }
});

// ─── POST /api/sales/admin/reset — Reset all transactional data (owner only) ───
router.post('/admin/reset', authenticate, authorize('owner'), (req, res, next) => {
  try {
    const { confirm } = req.body;
    if (!confirm) return res.status(400).json({ success: false, message: 'Confirmation required' });

    const db = getDb();
    // Delete in dependency order
    const tables = [
      'delivery_settlement_items', 'delivery_settlements', 'delivery_collections',
      'delivery_locations', 'delivery_partner_daily', 'delivery_proofs',
      'production_tasks', 'production_logs', 'product_stock',
      'payments', 'sale_items', 'deliveries', 'sales',
      'cash_registers', 'attendance', 'outdoor_duty_requests', 'geofence_events',
      'credit_payments', 'expenses', 'salary_payments', 'salary_advances',
      'stock_transfers', 'notifications', 'customers', 'customer_addresses',
    ];

    for (const table of tables) {
      try { db.prepare(`DELETE FROM ${table} WHERE 1=1`).run(); } catch (e) {
        console.log(`Reset: skip ${table}:`, e.message);
      }
    }

    res.json({ success: true, message: 'All transactional data reset.' });
  } catch (err) { next(err); }
});

module.exports = router;
