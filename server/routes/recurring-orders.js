const express = require('express');
const router = express.Router();

function localDateStr(dt) {
  const d = dt || new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
const { body, validationResult } = require('express-validator');
const { getDb } = require('../config/database');
const { getDb: getAsyncDb } = require('../config/database-async');
const { authenticate, authorize } = require('../middleware/auth');
const { nowLocal, nowTimeStr, localToday } = require('../utils/time');
const { safeParseJSON } = require('../utils/json');

// ─── GET /api/recurring-orders ───────────────────────────────
router.get('/', authenticate, authorize('owner', 'manager'), async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const { active_only } = req.query;

    let sql = `
      SELECT ro.*, c.name as customer_name, c.phone as customer_phone,
             l.name as location_name, u.name as created_by_name
      FROM recurring_orders ro
      LEFT JOIN users c ON ro.customer_id = c.id
      LEFT JOIN locations l ON ro.location_id = l.id
      LEFT JOIN users u ON ro.created_by = u.id
    `;
    const params = [];

    if (active_only === '1' || active_only === 'true') {
      sql += ' WHERE ro.is_active = 1';
    }

    sql += ' ORDER BY ro.next_run_date ASC, ro.created_at DESC';

    const orders = await db.prepare(sql).all(...params);
    // Parse items JSON
    for (const o of orders) {
      o.items = safeParseJSON(o.items, []);
      o.custom_days = safeParseJSON(o.custom_days, null);
    }

    res.json({ success: true, data: orders });
  } catch (err) { next(err); }
});

// ─── GET /api/recurring-orders/:id ───────────────────────────
router.get('/:id', authenticate, authorize('owner', 'manager'), async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const order = await db.prepare(`
      SELECT ro.*, c.name as customer_name, c.phone as customer_phone,
             l.name as location_name, u.name as created_by_name
      FROM recurring_orders ro
      LEFT JOIN users c ON ro.customer_id = c.id
      LEFT JOIN locations l ON ro.location_id = l.id
      LEFT JOIN users u ON ro.created_by = u.id
      WHERE ro.id = ?
    `).get(req.params.id);

    if (!order) return res.status(404).json({ success: false, message: 'Recurring order not found' });

    order.items = safeParseJSON(order.items, []);
    order.custom_days = safeParseJSON(order.custom_days, null);

    res.json({ success: true, data: order });
  } catch (err) { next(err); }
});

// ─── POST /api/recurring-orders ──────────────────────────────
router.post(
  '/',
  authenticate,
  authorize('owner', 'manager'),
  [
    body('customer_id').isInt(),
    body('location_id').isInt(),
    body('order_type').isIn(['pickup', 'delivery']),
    body('frequency').isIn(['daily', 'weekly', 'monthly', 'custom']),
    body('items').isArray({ min: 1 }),
    body('next_run_date').notEmpty(),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });

      const db = getDb();
      const {
        customer_id, location_id, order_type, frequency, custom_days,
        delivery_address, scheduled_time, notes, items, next_run_date,
        sender_message, sender_name, sender_phone,
      } = req.body;

      const result = db.prepare(`
        INSERT INTO recurring_orders (customer_id, location_id, order_type, frequency, custom_days,
          delivery_address, scheduled_time, notes, sender_message, sender_name, sender_phone,
          items, next_run_date, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        customer_id, location_id, order_type, frequency,
        custom_days ? JSON.stringify(custom_days) : null,
        delivery_address || null, scheduled_time || null, notes || '',
        sender_message || '', sender_name || '', sender_phone || '',
        JSON.stringify(items), next_run_date, req.user.id
      );

      const order = db.prepare('SELECT * FROM recurring_orders WHERE id = ?').get(result.lastInsertRowid);
      order.items = safeParseJSON(order.items, []);

      res.status(201).json({ success: true, data: order });
    } catch (err) { next(err); }
  }
);

// ─── PUT /api/recurring-orders/:id ───────────────────────────
router.put(
  '/:id',
  authenticate,
  authorize('owner', 'manager'),
  (req, res, next) => {
    try {
      const db = getDb();
      const existing = db.prepare('SELECT * FROM recurring_orders WHERE id = ?').get(req.params.id);
      if (!existing) return res.status(404).json({ success: false, message: 'Not found' });

      const {
        order_type, frequency, custom_days, delivery_address, scheduled_time,
        notes, items, next_run_date, is_active, sender_message, sender_name, sender_phone,
      } = req.body;

      db.prepare(`
        UPDATE recurring_orders SET
          order_type = COALESCE(?, order_type),
          frequency = COALESCE(?, frequency),
          custom_days = COALESCE(?, custom_days),
          delivery_address = COALESCE(?, delivery_address),
          scheduled_time = COALESCE(?, scheduled_time),
          notes = COALESCE(?, notes),
          sender_message = COALESCE(?, sender_message),
          sender_name = COALESCE(?, sender_name),
          sender_phone = COALESCE(?, sender_phone),
          items = COALESCE(?, items),
          next_run_date = COALESCE(?, next_run_date),
          is_active = COALESCE(?, is_active),
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        order_type || null, frequency || null,
        custom_days ? JSON.stringify(custom_days) : null,
        delivery_address !== undefined ? delivery_address : null,
        scheduled_time !== undefined ? scheduled_time : null,
        notes !== undefined ? notes : null,
        sender_message !== undefined ? sender_message : null,
        sender_name !== undefined ? sender_name : null,
        sender_phone !== undefined ? sender_phone : null,
        items ? JSON.stringify(items) : null,
        next_run_date || null,
        is_active !== undefined ? (is_active ? 1 : 0) : null,
        req.params.id
      );

      const updated = db.prepare('SELECT * FROM recurring_orders WHERE id = ?').get(req.params.id);
      updated.items = safeParseJSON(updated.items, []);

      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  }
);

// ─── DELETE /api/recurring-orders/:id ────────────────────────
router.delete(
  '/:id',
  authenticate,
  authorize('owner', 'manager'),
  (req, res, next) => {
    try {
      const db = getDb();
      const existing = db.prepare('SELECT id FROM recurring_orders WHERE id = ?').get(req.params.id);
      if (!existing) return res.status(404).json({ success: false, message: 'Not found' });

      db.prepare('DELETE FROM recurring_orders WHERE id = ?').run(req.params.id);
      res.json({ success: true, message: 'Recurring order deleted' });
    } catch (err) { next(err); }
  }
);

// ═══════════════════════════════════════════════════════════════
// Recurring Order Processor — called by setInterval in server.js
// ═══════════════════════════════════════════════════════════════
function processRecurringOrders() {
  try {
    const db = getDb();
    // Generate orders 1 day before the scheduled pickup/delivery date
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = localDateStr(tomorrow);
    const today = localDateStr();

    const dueOrders = db.prepare(
      "SELECT * FROM recurring_orders WHERE is_active = 1 AND next_run_date <= ?"
    ).all(tomorrowStr);

    if (dueOrders.length === 0) return;

    // Helper to generate sale number (same logic as sales.js)
    function generateSaleNumber(locationId) {
      const loc = db.prepare('SELECT name FROM locations WHERE id = ?').get(locationId);
      const locCode = loc ? loc.name.replace(/[^A-Za-z]/g, '').substring(0, 4).toUpperCase() : 'XX';
      const dateStr = localDateStr().replace(/-/g, '');
      const prefix = `INV-${locCode}-${dateStr}`;
      const last = db.prepare("SELECT sale_number FROM sales WHERE sale_number LIKE ? ORDER BY id DESC LIMIT 1").get(`${prefix}-%`);
      let seq = 1;
      if (last) {
        const lastNum = parseInt(last.sale_number.split('-').pop(), 10);
        if (!isNaN(lastNum)) seq = lastNum + 1;
      }
      return `${prefix}-${String(seq).padStart(3, '0')}`;
    }

    const createSaleForRecurring = db.transaction((ro) => {
      const items = safeParseJSON(ro.items, []);
      if (items.length === 0) return null;

      const customer = db.prepare('SELECT id, name, phone FROM users WHERE id = ?').get(ro.customer_id);
      if (!customer) return null;

      let subtotal = 0;
      let taxTotal = 0;
      const processedItems = items.map((item) => {
        const qty = item.quantity || 1;
        const unitPrice = item.unit_price || 0;
        const taxRate = item.tax_rate || 0;
        const taxAmount = (unitPrice * qty * taxRate) / 100;
        subtotal += unitPrice * qty;
        taxTotal += taxAmount;
        return {
          product_id: item.product_id || null,
          material_id: item.material_id || null,
          product_name: item.product_name,
          quantity: qty,
          unit_price: unitPrice,
          tax_rate: taxRate,
          tax_amount: taxAmount,
          line_total: (unitPrice * qty) + taxAmount,
        };
      });

      const grandTotal = subtotal + taxTotal;
      const saleNumber = generateSaleNumber(ro.location_id);

      // Use the recurring order's next_run_date as the scheduled date
      // (the actual pickup/delivery date, not the generation date)
      const scheduledDate = ro.next_run_date;

      const saleResult = db.prepare(`
        INSERT INTO sales (sale_number, location_id, customer_id, customer_name, customer_phone,
          subtotal, tax_total, discount_amount, delivery_charges, delivery_address,
          scheduled_date, scheduled_time, grand_total, payment_status, order_type, status,
          special_instructions, customer_notes, sender_message, sender_name, sender_phone, created_by, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, 'pending', ?, 'pending', ?, ?, ?, ?, ?, ?, 'recurring', ?)
      `).run(
        saleNumber, ro.location_id, customer.id, customer.name, customer.phone,
        subtotal, taxTotal, ro.delivery_address || null,
        scheduledDate, ro.scheduled_time || null, grandTotal, ro.order_type,
        ro.notes || '', '', ro.sender_message || '', ro.sender_name || '', ro.sender_phone || '',
        ro.created_by, nowLocal()
      );
      const saleId = saleResult.lastInsertRowid;

      // Insert items
      const insertItem = db.prepare(
        'INSERT INTO sale_items (sale_id, product_id, material_id, product_name, quantity, unit_price, tax_rate, tax_amount, line_total, materials_deducted, from_product_stock) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)'
      );
      for (const item of processedItems) {
        insertItem.run(saleId, item.product_id, item.material_id, item.product_name, item.quantity, item.unit_price, item.tax_rate, item.tax_amount, item.line_total);
      }

      // Create production tasks
      const insertTask = db.prepare(
        "INSERT INTO production_tasks (sale_id, sale_item_id, product_id, location_id, quantity, priority, notes, created_at) VALUES (?, ?, ?, ?, ?, 'normal', '', ?)"
      );
      const saleItems = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(saleId);
      for (const si of saleItems) {
        if (si.product_id) {
          insertTask.run(saleId, si.id, si.product_id, ro.location_id, si.quantity, nowLocal());
        }
      }

      // Create delivery record if delivery order
      if (ro.order_type === 'delivery' && ro.delivery_address) {
        db.prepare(`
          INSERT INTO deliveries (sale_id, location_id, delivery_address, customer_name, customer_phone,
            scheduled_date, scheduled_time, cod_amount, cod_status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
        `).run(saleId, ro.location_id, ro.delivery_address, customer.name, customer.phone,
          scheduledDate, ro.scheduled_time || null, grandTotal, nowLocal());
      }

      // Set pickup status if pickup
      if (ro.order_type === 'pickup') {
        db.prepare("UPDATE sales SET pickup_status = 'waiting' WHERE id = ?").run(saleId);
      }

      // Update credit balance
      db.prepare('UPDATE users SET credit_balance = credit_balance + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(grandTotal, customer.id);

      return saleId;
    });

    for (const ro of dueOrders) {
      const saleId = createSaleForRecurring(ro);
      if (saleId) {
        // Calculate next run date from the current next_run_date
        const nextDate = calculateNextRunDate(ro.frequency, ro.custom_days, ro.next_run_date);
        db.prepare(
          'UPDATE recurring_orders SET last_generated_date = ?, next_run_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
        ).run(today, nextDate, ro.id);
        console.log(`📦 Recurring order #${ro.id} → Sale #${saleId} generated (scheduled for ${ro.next_run_date})`);
      }
    }
  } catch (err) {
    console.error('❌ Recurring order processing error:', err.message);
  }
}

function calculateNextRunDate(frequency, customDaysJson, fromDate) {
  const date = new Date(fromDate + 'T00:00:00');

  switch (frequency) {
    case 'daily':
      date.setDate(date.getDate() + 1);
      break;
    case 'weekly':
      date.setDate(date.getDate() + 7);
      break;
    case 'monthly':
      date.setMonth(date.getMonth() + 1);
      break;
    case 'custom': {
      // custom_days is an array of ISO date strings or day-of-week numbers (0-6)
      const customDays = safeParseJSON(customDaysJson, []);
      if (customDays.length === 0) {
        date.setDate(date.getDate() + 1);
        break;
      }
      // If array of date strings (YYYY-MM-DD)
      if (typeof customDays[0] === 'string' && customDays[0].includes('-')) {
        const futureDates = customDays.filter(d => d > fromDate).sort();
        if (futureDates.length > 0) {
          return futureDates[0];
        }
        // No more future dates — deactivate by returning far future
        return '2099-12-31';
      }
      // Array of day-of-week numbers (0=Sun, 1=Mon, ..., 6=Sat)
      for (let i = 1; i <= 7; i++) {
        const check = new Date(date);
        check.setDate(check.getDate() + i);
        if (customDays.includes(check.getDay())) {
          return localDateStr(check);
        }
      }
      date.setDate(date.getDate() + 1);
      break;
    }
    default:
      date.setDate(date.getDate() + 1);
  }

  return localDateStr(date);
}

module.exports = router;
module.exports.processRecurringOrders = processRecurringOrders;
