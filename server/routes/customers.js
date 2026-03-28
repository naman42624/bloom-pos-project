const express = require('express');
const router = express.Router();

function localDateStr(dt) {
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
}
const { body, validationResult } = require('express-validator');
const { getDb } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

// ─── GET /api/customers ─────────────────────────────────────
// List all customers (users with role='customer') + any unique phones from sales
router.get('/', authenticate, authorize('owner', 'manager', 'employee', 'delivery_partner'), (req, res, next) => {
  try {
    const db = getDb();
    const { search, limit = 50, offset = 0 } = req.query;

    let sql = `
      SELECT id, name, phone, email, birthday, anniversary, custom_dates,
             total_spent, credit_balance, notes, is_active, created_at,
             1 as is_registered
      FROM users
      WHERE role = 'customer'
    `;
    const params = [];

    if (search) {
      sql += ` AND (name ILIKE ? OR phone ILIKE ? OR email ILIKE ?)`;
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    sql += ` ORDER BY name ASC LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), parseInt(offset));

    let customers = db.prepare(sql).all(...params);

    // If initial results are few and no search, or if we want to fulfill the "any unique phones" requirement:
    // Only add unregistered customers if we are on the first page and search is flexible
    if (customers.length < limit && (!offset || offset === 0)) {
      let unregSql = `
        SELECT NULL as id, MAX(customer_name) as name, customer_phone as phone, NULL as email,
               NULL as birthday, NULL as anniversary, '[]' as custom_dates,
               SUM(grand_total) as total_spent, 0 as credit_balance, '' as notes, 1 as is_active,
               MIN(created_at) as created_at, 0 as is_registered
        FROM sales
        WHERE customer_id IS NULL AND customer_phone IS NOT NULL AND status != 'cancelled'
      `;
      const unregParams = [];
      if (search) {
        unregSql += ` AND (customer_name ILIKE ? OR customer_phone ILIKE ?)`;
        unregParams.push(`%${search}%`, `%${search}%`);
      }
      unregSql += ` GROUP BY customer_phone ORDER BY total_spent DESC LIMIT ?`;
      unregParams.push(limit - customers.length);

      try {
        const unregistered = db.prepare(unregSql).all(...unregParams);
        customers = [...customers, ...unregistered];
      } catch (e) {
        console.error("Error fetching unregistered customers:", e.message);
      }
    }

    // Get total count
    let countSql = `SELECT COUNT(*) as total FROM users WHERE role = 'customer'`;
    const countParams = [];
    if (search) {
      countSql += ` AND (name ILIKE ? OR phone ILIKE ? OR email ILIKE ?)`;
      countParams.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    const { total } = db.prepare(countSql).get(...countParams);

    // Attach order count for each customer
    const orderCountStmt = db.prepare(
      `SELECT COUNT(*) as c FROM sales WHERE (customer_id = ? OR (customer_id IS NULL AND customer_phone = ?)) AND status != 'cancelled'`
    );

    const enriched = customers.map(c => {
      try {
        return {
          ...c,
          custom_dates: typeof c.custom_dates === 'string' ? JSON.parse(c.custom_dates || '[]') : (c.custom_dates || []),
          order_count: orderCountStmt.get(c.id || null, c.phone).c,
        };
      } catch (e) {
        console.error(`Error enriching customer ${c.id || c.phone}:`, e.message);
        return { ...c, custom_dates: [], order_count: 0 };
      }
    });

    res.json({ success: true, data: enriched, total: Math.max(total, enriched.length), limit: parseInt(limit), offset: parseInt(offset) });
  } catch (err) { next(err); }
});

// ─── GET /api/customers/lookup ───────────────────────────────
// Phone-based lookup — checks users table first, then sales history
router.get('/lookup', authenticate, (req, res, next) => {
  try {
    const db = getDb();
    const { phone } = req.query;
    if (!phone || phone.length < 4) return res.json({ success: true, data: null });

    // Check if registered customer exists
    const user = db.prepare(
      `SELECT id, name, phone, email, credit_balance, total_spent FROM users WHERE phone = ? AND role = 'customer'`
    ).get(phone);

    if (user) {
      const orderCount = db.prepare(
        `SELECT COUNT(*) as c FROM sales WHERE customer_id = ? AND status != 'cancelled'`
      ).get(user.id).c;
      const lastOrder = db.prepare(
        `SELECT created_at FROM sales WHERE customer_id = ? AND status != 'cancelled' ORDER BY created_at DESC LIMIT 1`
      ).get(user.id);
      return res.json({
        success: true,
        data: { ...user, order_count: orderCount, last_order: lastOrder?.created_at || null, is_registered: true },
      });
    }

    // Fallback: check sales history for unregistered customers
    const salesCustomer = db.prepare(`
      SELECT MAX(customer_name) as name, customer_phone as phone, COUNT(*) as order_count,
             SUM(grand_total) as total_spent, MAX(created_at) as last_order
      FROM sales
      WHERE customer_phone = ? AND status != 'cancelled'
      GROUP BY customer_phone
    `).get(phone);

    res.json({ success: true, data: salesCustomer ? { ...salesCustomer, is_registered: false } : null });
  } catch (err) { next(err); }
});

// ─── GET /api/customers/search ───────────────────────────────
// Autocomplete search by partial phone or name (for checkout dropdown)
router.get('/search', authenticate, (req, res, next) => {
  try {
    const db = getDb();
    const { q } = req.query;
    if (!q || q.length < 3) return res.json({ success: true, data: [] });

    const term = `%${q}%`;

    // Search registered customers
    const registered = db.prepare(`
      SELECT id, name, phone, credit_balance, total_spent
      FROM users WHERE role = 'customer' AND is_active = 1
        AND (phone ILIKE ? OR name ILIKE ?)
      ORDER BY total_spent DESC LIMIT 10
    `).all(term, term);

    // Search unregistered customers from sales history
    const unregistered = db.prepare(`
      SELECT NULL as id, MAX(customer_name) as name, customer_phone as phone,
             0 as credit_balance, SUM(grand_total) as total_spent
      FROM sales
      WHERE status != 'cancelled' AND customer_phone IS NOT NULL
        AND customer_id IS NULL
        AND (customer_phone ILIKE ? OR customer_name ILIKE ?)
      GROUP BY customer_phone
      ORDER BY total_spent DESC LIMIT 5
    `).all(term, term);

    // Merge, deduplicate by phone
    const seen = new Set();
    const results = [];
    for (const c of [...registered, ...unregistered]) {
      if (c.phone && !seen.has(c.phone)) {
        seen.add(c.phone);
        results.push(c);
      }
    }

    res.json({ success: true, data: results.slice(0, 10) });
  } catch (err) { next(err); }
});

// ─── GET /api/customers/upcoming-dates ───────────────────────
// Special dates coming up in the next N days
router.get('/upcoming-dates', authenticate, authorize('owner', 'manager'), (req, res, next) => {
  try {
    const db = getDb();
    const { days = 30 } = req.query;

    // Get all customers with birthday/anniversary/custom_dates
    const customers = db.prepare(`
      SELECT id, name, phone, birthday, anniversary, custom_dates
      FROM users
      WHERE role = 'customer' AND is_active = 1
        AND (birthday IS NOT NULL OR anniversary IS NOT NULL OR (custom_dates IS NOT NULL AND custom_dates != '[]'))
    `).all();

    const today = new Date();
    const upcoming = [];

    for (const c of customers) {
      // Check birthday
      if (c.birthday) {
        const bd = new Date(c.birthday);
        const thisYear = new Date(today.getFullYear(), bd.getMonth(), bd.getDate());
        if (thisYear < today) thisYear.setFullYear(thisYear.getFullYear() + 1);
        const diff = Math.ceil((thisYear - today) / (1000 * 60 * 60 * 24));
        if (diff <= parseInt(days)) {
          upcoming.push({ customer_id: c.id, customer_name: c.name, phone: c.phone, label: 'Birthday', date: localDateStr(thisYear), days_away: diff });
        }
      }
      // Check anniversary
      if (c.anniversary) {
        const an = new Date(c.anniversary);
        const thisYear = new Date(today.getFullYear(), an.getMonth(), an.getDate());
        if (thisYear < today) thisYear.setFullYear(thisYear.getFullYear() + 1);
        const diff = Math.ceil((thisYear - today) / (1000 * 60 * 60 * 24));
        if (diff <= parseInt(days)) {
          upcoming.push({ customer_id: c.id, customer_name: c.name, phone: c.phone, label: 'Anniversary', date: localDateStr(thisYear), days_away: diff });
        }
      }
      // Check custom dates
      if (c.custom_dates) {
        try {
          const custom = JSON.parse(c.custom_dates);
          for (const cd of custom) {
            if (cd.date) {
              const parts = cd.date.split('-'); // MM-DD format
              const thisYear = new Date(today.getFullYear(), parseInt(parts[0]) - 1, parseInt(parts[1]));
              if (thisYear < today) thisYear.setFullYear(thisYear.getFullYear() + 1);
              const diff = Math.ceil((thisYear - today) / (1000 * 60 * 60 * 24));
              if (diff <= parseInt(days)) {
                upcoming.push({ customer_id: c.id, customer_name: c.name, phone: c.phone, label: cd.label || 'Special Date', date: localDateStr(thisYear), days_away: diff });
              }
            }
          }
        } catch {}
      }
    }

    upcoming.sort((a, b) => a.days_away - b.days_away);
    res.json({ success: true, data: upcoming });
  } catch (err) { next(err); }
});

// ─── GET /api/customers/:id ─────────────────────────────────
router.get('/:id', authenticate, (req, res, next) => {
  try {
    const db = getDb();
    const customer = db.prepare(`
      SELECT id, name, phone, email, birthday, anniversary, custom_dates,
             total_spent, credit_balance, notes, is_active, created_at, updated_at
      FROM users WHERE id = ? AND role = 'customer'
    `).get(req.params.id);

    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

    customer.custom_dates = customer.custom_dates ? JSON.parse(customer.custom_dates) : [];

    // Addresses
    const addresses = db.prepare(
      'SELECT * FROM customer_addresses WHERE customer_id = ? ORDER BY is_default DESC, created_at DESC'
    ).all(req.params.id);

    // Order history (recent 20)
    const orders = db.prepare(`
      SELECT s.id, s.sale_number, s.grand_total, s.order_type, s.status, s.payment_status, s.created_at,
             COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.sale_id = s.id), 0) as total_paid
      FROM sales s
      WHERE s.customer_id = ? AND s.status != 'cancelled'
      ORDER BY s.created_at DESC LIMIT 20
    `).all(req.params.id);

    // Calculate balance due per order
    const ordersWithDues = orders.map(o => ({
      ...o,
      balance_due: Math.max(0, o.grand_total - o.total_paid),
    }));

    // Credit payments
    const creditPayments = db.prepare(`
      SELECT cp.*, u.name as received_by_name
      FROM credit_payments cp
      LEFT JOIN users u ON cp.received_by = u.id
      WHERE cp.customer_id = ?
      ORDER BY cp.created_at DESC LIMIT 20
    `).all(req.params.id);

    // Special dates from separate table
    const specialDates = db.prepare(
      'SELECT * FROM special_dates WHERE customer_id = ? ORDER BY date ASC'
    ).all(req.params.id);

    res.json({
      success: true,
      data: { ...customer, addresses, orders: ordersWithDues, credit_payments: creditPayments, special_dates: specialDates },
    });
  } catch (err) { next(err); }
});

// ─── POST /api/customers ────────────────────────────────────
// Create a customer (from POS/manager side, not self-registration)
router.post(
  '/',
  authenticate,
  authorize('owner', 'manager', 'employee'),
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('phone').trim().matches(/^[6-9]\d{9}$/).withMessage('Valid 10-digit phone required'),
    body('email').optional({ nullable: true, checkFalsy: true }).isEmail(),
    body('birthday').optional({ nullable: true, checkFalsy: true }),
    body('anniversary').optional({ nullable: true, checkFalsy: true }),
    body('notes').optional().trim(),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });

      const db = getDb();
      const { name, phone, email, birthday, anniversary, notes } = req.body;
      const bcrypt = require('bcryptjs');

      // Check phone uniqueness
      const existing = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
      if (existing) return res.status(409).json({ success: false, message: 'A user with this phone number already exists' });

      // Create with a random password (customer can set via app later)
      const salt = bcrypt.genSaltSync(10);
      const hashedPassword = bcrypt.hashSync(`bloom_${Date.now()}`, salt);

      const result = db.prepare(
        `INSERT INTO users (name, phone, email, password, role, birthday, anniversary, notes, created_by)
         VALUES (?, ?, ?, ?, 'customer', ?, ?, ?, ?)`
      ).run(name, phone, email || null, hashedPassword, birthday || null, anniversary || null, notes || '', req.user.id);

      const customer = db.prepare(
        `SELECT id, name, phone, email, birthday, anniversary, total_spent, credit_balance, notes, created_at
         FROM users WHERE id = ?`
      ).get(result.lastInsertRowid);

      res.status(201).json({ success: true, data: customer });
    } catch (err) { next(err); }
  }
);

// ─── PUT /api/customers/:id ─────────────────────────────────
router.put(
  '/:id',
  authenticate,
  authorize('owner', 'manager'),
  [
    body('name').optional().trim().notEmpty(),
    body('phone').optional().trim().matches(/^[6-9]\d{9}$/),
    body('email').optional({ nullable: true, checkFalsy: true }).isEmail(),
    body('birthday').optional({ nullable: true }),
    body('anniversary').optional({ nullable: true }),
    body('notes').optional().trim(),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });

      const db = getDb();
      const existing = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'customer'").get(req.params.id);
      if (!existing) return res.status(404).json({ success: false, message: 'Customer not found' });

      // Phone uniqueness check
      if (req.body.phone && req.body.phone !== existing.phone) {
        const dup = db.prepare('SELECT id FROM users WHERE phone = ? AND id != ?').get(req.body.phone, req.params.id);
        if (dup) return res.status(409).json({ success: false, message: 'Phone number already in use' });
      }

      const fields = ['name', 'phone', 'email', 'birthday', 'anniversary', 'notes'];
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

      db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);

      const customer = db.prepare(
        `SELECT id, name, phone, email, birthday, anniversary, total_spent, credit_balance, notes, created_at, updated_at
         FROM users WHERE id = ?`
      ).get(req.params.id);

      res.json({ success: true, data: customer });
    } catch (err) { next(err); }
  }
);

// ─── GET /api/customers/:id/addresses ────────────────────────
router.get('/:id/addresses', authenticate, (req, res, next) => {
  try {
    const db = getDb();
    const addresses = db.prepare(
      'SELECT * FROM customer_addresses WHERE customer_id = ? ORDER BY is_default DESC, created_at DESC'
    ).all(req.params.id);
    res.json({ success: true, data: addresses });
  } catch (err) { next(err); }
});

// ─── POST /api/customers/:id/addresses ───────────────────────
router.post(
  '/:id/addresses',
  authenticate,
  [
    body('label').trim().notEmpty().withMessage('Label is required'),
    body('address_line_1').trim().notEmpty().withMessage('Address is required'),
    body('address_line_2').optional().trim(),
    body('city').optional().trim(),
    body('state').optional().trim(),
    body('pincode').optional().trim(),
    body('is_default').optional().isInt({ min: 0, max: 1 }),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });

      const db = getDb();
      const customerId = req.params.id;

      // Verify customer exists
      const customer = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'customer'").get(customerId);
      if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

      const { label, address_line_1, address_line_2, city, state, pincode, is_default, latitude, longitude } = req.body;

      // If setting as default, unset others
      if (is_default) {
        db.prepare('UPDATE customer_addresses SET is_default = 0 WHERE customer_id = ?').run(customerId);
      }

      const result = db.prepare(
        `INSERT INTO customer_addresses (customer_id, label, address_line_1, address_line_2, city, state, pincode, latitude, longitude, is_default)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(customerId, label, address_line_1, address_line_2 || '', city || '', state || '', pincode || '', latitude || null, longitude || null, is_default || 0);

      const address = db.prepare('SELECT * FROM customer_addresses WHERE id = ?').get(result.lastInsertRowid);
      res.status(201).json({ success: true, data: address });
    } catch (err) { next(err); }
  }
);

// ─── PUT /api/customers/:id/addresses/:addressId ────────────
router.put(
  '/:id/addresses/:addressId',
  authenticate,
  (req, res, next) => {
    try {
      const db = getDb();
      const { id: customerId, addressId } = req.params;
      const existing = db.prepare('SELECT * FROM customer_addresses WHERE id = ? AND customer_id = ?').get(addressId, customerId);
      if (!existing) return res.status(404).json({ success: false, message: 'Address not found' });

      const fields = ['label', 'address_line_1', 'address_line_2', 'city', 'state', 'pincode', 'latitude', 'longitude', 'is_default'];
      const updates = [];
      const values = [];

      for (const field of fields) {
        if (req.body[field] !== undefined) {
          updates.push(`${field} = ?`);
          values.push(req.body[field]);
        }
      }

      if (req.body.is_default) {
        db.prepare('UPDATE customer_addresses SET is_default = 0 WHERE customer_id = ? AND id != ?').run(customerId, addressId);
      }

      if (updates.length > 0) {
        updates.push('updated_at = CURRENT_TIMESTAMP');
        values.push(addressId, customerId);
        db.prepare(`UPDATE customer_addresses SET ${updates.join(', ')} WHERE id = ? AND customer_id = ?`).run(...values);
      }

      const address = db.prepare('SELECT * FROM customer_addresses WHERE id = ?').get(addressId);
      res.json({ success: true, data: address });
    } catch (err) { next(err); }
  }
);

// ─── DELETE /api/customers/:id/addresses/:addressId ──────────
router.delete('/:id/addresses/:addressId', authenticate, (req, res, next) => {
  try {
    const db = getDb();
    const { id: customerId, addressId } = req.params;
    const existing = db.prepare('SELECT * FROM customer_addresses WHERE id = ? AND customer_id = ?').get(addressId, customerId);
    if (!existing) return res.status(404).json({ success: false, message: 'Address not found' });

    db.prepare('DELETE FROM customer_addresses WHERE id = ?').run(addressId);
    res.json({ success: true, message: 'Address deleted' });
  } catch (err) { next(err); }
});

// ─── POST /api/customers/:id/credits ─────────────────────────
// Record a credit payment from customer
router.post(
  '/:id/credits',
  authenticate,
  authorize('owner', 'manager', 'employee'),
  [
    body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be positive'),
    body('method').isIn(['cash', 'card', 'upi']).withMessage('Invalid payment method'),
    body('sale_id').optional({ nullable: true }).isInt(),
    body('notes').optional().trim(),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });

      const db = getDb();
      const customerId = req.params.id;

      const customer = db.prepare("SELECT id, credit_balance FROM users WHERE id = ? AND role = 'customer'").get(customerId);
      if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

      const { amount, method, notes, sale_id } = req.body;

      if (amount > customer.credit_balance) {
        return res.status(400).json({ success: false, message: `Payment amount (₹${amount}) exceeds outstanding balance (₹${customer.credit_balance})` });
      }

      const creditTx = db.transaction(() => {
        // Record credit payment
        const result = db.prepare(
          'INSERT INTO credit_payments (customer_id, amount, method, received_by, notes, sale_id) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(customerId, amount, method, req.user.id, notes || '', sale_id || null);

        // Reduce customer credit balance
        db.prepare('UPDATE users SET credit_balance = credit_balance - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(amount, customerId);

        // If linked to a sale, also add as a payment on that sale
        if (sale_id) {
          db.prepare(
            'INSERT INTO payments (sale_id, method, amount, reference_number, received_by) VALUES (?, ?, ?, ?, ?)'
          ).run(sale_id, method, amount, `Credit-${result.lastInsertRowid}`, req.user.id);

          // Recalculate sale payment status
          const sale = db.prepare('SELECT grand_total FROM sales WHERE id = ?').get(sale_id);
          if (sale) {
            const totalPaid = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE sale_id = ?').get(sale_id).total;
            let paymentStatus = 'pending';
            if (totalPaid >= sale.grand_total) paymentStatus = 'paid';
            else if (totalPaid > 0) paymentStatus = 'partial';
            db.prepare('UPDATE sales SET payment_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(paymentStatus, sale_id);
          }
        }

        return result.lastInsertRowid;
      });

      const paymentId = creditTx();

      const payment = db.prepare(`
        SELECT cp.*, u.name as received_by_name
        FROM credit_payments cp LEFT JOIN users u ON cp.received_by = u.id
        WHERE cp.id = ?
      `).get(paymentId);

      const updated = db.prepare('SELECT credit_balance FROM users WHERE id = ?').get(customerId);

      res.status(201).json({ success: true, data: payment, new_balance: updated.credit_balance });
    } catch (err) { next(err); }
  }
);

// ─── GET /api/customers/:id/credits ──────────────────────────
router.get('/:id/credits', authenticate, (req, res, next) => {
  try {
    const db = getDb();
    const payments = db.prepare(`
      SELECT cp.*, u.name as received_by_name
      FROM credit_payments cp
      LEFT JOIN users u ON cp.received_by = u.id
      WHERE cp.customer_id = ?
      ORDER BY cp.created_at DESC
    `).all(req.params.id);

    const customer = db.prepare("SELECT credit_balance FROM users WHERE id = ? AND role = 'customer'").get(req.params.id);
    res.json({ success: true, data: payments, credit_balance: customer?.credit_balance || 0 });
  } catch (err) { next(err); }
});

// ─── POST /api/customers/:id/special-dates ───────────────────
router.post(
  '/:id/special-dates',
  authenticate,
  [
    body('label').trim().notEmpty().withMessage('Label is required'),
    body('date').trim().notEmpty().withMessage('Date is required'),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });

      const db = getDb();
      const customerId = req.params.id;
      const customer = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'customer'").get(customerId);
      if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

      const { label, date } = req.body;
      const result = db.prepare('INSERT INTO special_dates (customer_id, label, date) VALUES (?, ?, ?)').run(customerId, label, date);
      const sd = db.prepare('SELECT * FROM special_dates WHERE id = ?').get(result.lastInsertRowid);

      res.status(201).json({ success: true, data: sd });
    } catch (err) { next(err); }
  }
);

// ─── DELETE /api/customers/:id/special-dates/:dateId ─────────
router.delete('/:id/special-dates/:dateId', authenticate, (req, res, next) => {
  try {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM special_dates WHERE id = ? AND customer_id = ?').get(req.params.dateId, req.params.id);
    if (!existing) return res.status(404).json({ success: false, message: 'Special date not found' });

    db.prepare('DELETE FROM special_dates WHERE id = ?').run(req.params.dateId);
    res.json({ success: true, message: 'Special date removed' });
  } catch (err) { next(err); }
});

// ─── GET /api/customers/:id/orders ───────────────────────────
router.get('/:id/orders', authenticate, (req, res, next) => {
  try {
    const db = getDb();
    const { limit = 30, offset = 0 } = req.query;

    const orders = db.prepare(`
      SELECT s.id, s.sale_number, s.grand_total, s.order_type, s.status,
             s.discount_amount, s.payment_status, s.created_at,
             l.name as location_name
      FROM sales s
      LEFT JOIN locations l ON s.location_id = l.id
      WHERE s.customer_id = ? AND s.status != 'cancelled'
      ORDER BY s.created_at DESC
      LIMIT ? OFFSET ?
    `).all(req.params.id, parseInt(limit), parseInt(offset));

    const { total } = db.prepare(
      "SELECT COUNT(*) as total FROM sales WHERE customer_id = ? AND status != 'cancelled'"
    ).get(req.params.id);

    res.json({ success: true, data: orders, total });
  } catch (err) { next(err); }
});

module.exports = router;
