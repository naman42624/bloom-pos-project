const express = require('express');
const router = express.Router();

function localDateStr(dt) {
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
}
const { body, validationResult } = require('express-validator');
const { getDb } = require('../config/database');
const { getDb: getAsyncDb } = require('../config/database-async');
const { authenticate, authorize } = require('../middleware/auth');
const { safeParseJSON } = require('../utils/json');

// ─── GET /api/customers ─────────────────────────────────────
// List all customers (users with role='customer') + any unique phones from sales
router.get('/', authenticate, authorize('owner', 'manager', 'employee', 'delivery_partner'), async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const { search, limit = 50, offset = 0, sort = 'name_asc', has_due } = req.query;

    let baseSql = `
      WITH registered AS (
        SELECT id, name, phone, email, birthday, anniversary, custom_dates::text as custom_dates,
               total_spent, credit_balance, notes, is_active, created_at,
               1 as is_registered
        FROM users
        WHERE role = 'customer'
      ),
      unregistered AS (
        SELECT NULL::integer as id, MAX(customer_name) as name, customer_phone as phone, NULL::varchar as email,
               NULL::date as birthday, NULL::date as anniversary, '[]'::text as custom_dates,
               SUM(grand_total) as total_spent, 0::numeric as credit_balance, '' as notes, 1 as is_active,
               MIN(created_at) as created_at, 0 as is_registered
        FROM sales
        WHERE customer_id IS NULL AND customer_phone IS NOT NULL AND status != 'cancelled'
          AND customer_phone NOT IN (SELECT phone FROM registered WHERE phone IS NOT NULL)
        GROUP BY customer_phone
      ),
      combined AS (
        SELECT * FROM registered
        UNION ALL
        SELECT * FROM unregistered
      )
    `;

    let sql = `${baseSql} SELECT * FROM combined WHERE 1=1`;
    let countSql = `${baseSql} SELECT COUNT(*) as total FROM combined WHERE 1=1`;
    const params = [];

    if (search) {
      const searchClause = ` AND (name ILIKE ? OR phone ILIKE ? OR email ILIKE ?)`;
      sql += searchClause;
      countSql += searchClause;
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    if (has_due === 'true') {
      const dueClause = ` AND credit_balance > 0`;
      sql += dueClause;
      countSql += dueClause;
    }

    let sortCol = 'name';
    let sortDir = 'ASC';
    if (sort === 'name_desc') { sortCol = 'name'; sortDir = 'DESC'; }
    else if (sort === 'spent_desc') { sortCol = 'total_spent'; sortDir = 'DESC'; }
    else if (sort === 'due_desc') { sortCol = 'credit_balance'; sortDir = 'DESC'; }
    else if (sort === 'recent_desc') { sortCol = 'created_at'; sortDir = 'DESC'; }

    sql += ` ORDER BY ${sortCol} ${sortDir} NULLS LAST LIMIT ? OFFSET ?`;
    
    const queryParams = [...params, parseInt(limit), parseInt(offset)];
    
    let customers = await db.prepare(sql).all(...queryParams);
    const { total } = await db.prepare(countSql).get(...params);

    // Attach order count for each customer using batched lookups
    const registeredIds = customers.filter((customer) => customer.is_registered && customer.id).map((customer) => customer.id);
    const unregisteredPhones = customers.filter((customer) => !customer.is_registered && customer.phone).map((customer) => customer.phone);

    const orderCountById = new Map();
    const orderCountByPhone = new Map();

    if (registeredIds.length > 0) {
      const placeholders = registeredIds.map(() => '?').join(',');
      const registeredRows = await db.prepare(
        `SELECT customer_id as key_id, COUNT(*) as c
         FROM sales
         WHERE customer_id IN (${placeholders}) AND status != 'cancelled'
         GROUP BY customer_id`
      ).all(...registeredIds);
      for (const row of registeredRows) {
        orderCountById.set(row.key_id, Number(row.c || 0));
      }
    }

    if (unregisteredPhones.length > 0) {
      const placeholders = unregisteredPhones.map(() => '?').join(',');
      const unregisteredRows = await db.prepare(
        `SELECT phone, SUM(c) as c FROM (
           SELECT customer_phone as phone, COUNT(*) as c
           FROM sales
           WHERE customer_id IS NULL AND customer_phone IN (${placeholders}) AND status != 'cancelled'
           GROUP BY customer_phone
           UNION ALL
           SELECT sender_phone as phone, COUNT(*) as c
           FROM sales
           WHERE sender_customer_id IS NULL AND sender_phone IN (${placeholders}) AND status != 'cancelled'
           GROUP BY sender_phone
         ) x
         GROUP BY phone`
      ).all(...unregisteredPhones, ...unregisteredPhones);
      for (const row of unregisteredRows) {
        orderCountByPhone.set(row.phone, Number(row.c || 0));
      }
    }

    const enriched = customers.map(c => {
      try {
        return {
          ...c,
          custom_dates: safeParseJSON(c.custom_dates, []),
          order_count: c.is_registered ? (orderCountById.get(c.id) || 0) : (orderCountByPhone.get(c.phone) || 0),
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
router.get('/lookup', authenticate, async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const { phone } = req.query;
    if (!phone || phone.length < 4) return res.json({ success: true, data: null });

    // Check if registered customer exists
    const user = await db.prepare(
      `SELECT id, name, phone, email, credit_balance, total_spent FROM users WHERE phone = ? AND role = 'customer'`
    ).get(phone);

    if (user) {
      const orderCount = await db.prepare(
        `SELECT COUNT(*) as c FROM sales WHERE (customer_id = ? OR sender_customer_id = ?) AND status != 'cancelled'`
      ).get(user.id, user.id).c;
      const lastOrder = await db.prepare(
        `SELECT created_at FROM sales WHERE (customer_id = ? OR sender_customer_id = ?) AND status != 'cancelled' ORDER BY created_at DESC LIMIT 1`
      ).get(user.id, user.id);
      return res.json({
        success: true,
        data: { ...user, order_count: orderCount, last_order: lastOrder?.created_at || null, is_registered: true },
      });
    }

    // Fallback: check sales history for unregistered customers
    const salesCustomer = await db.prepare(`
      SELECT MAX(name) as name, phone, COUNT(*) as order_count,
             SUM(grand_total) as total_spent, MAX(created_at) as last_order
      FROM (
        SELECT customer_name as name, customer_phone as phone, grand_total, created_at
        FROM sales
        WHERE customer_id IS NULL AND customer_phone = ? AND status != 'cancelled'
        UNION ALL
        SELECT sender_name as name, sender_phone as phone, grand_total, created_at
        FROM sales
        WHERE sender_customer_id IS NULL AND sender_phone = ? AND status != 'cancelled'
      ) x
      GROUP BY phone
      LIMIT 1
    `).get(phone, phone);

    res.json({ success: true, data: salesCustomer ? { ...salesCustomer, is_registered: false } : null });
  } catch (err) { next(err); }
});

// ─── GET /api/customers/search ───────────────────────────────
// Autocomplete search by partial phone or name (for checkout dropdown)
router.get('/search', authenticate, async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const { q } = req.query;
    if (!q || q.length < 3) return res.json({ success: true, data: [] });

    const term = `%${q}%`;

    // Search registered customers
    const registered = await db.prepare(`
      SELECT id, name, phone, credit_balance, total_spent
      FROM users WHERE role = 'customer' AND is_active = 1
        AND (phone ILIKE ? OR name ILIKE ?)
      ORDER BY total_spent DESC LIMIT 10
    `).all(term, term);

    // Search unregistered customers from sales history
    const unregistered = await db.prepare(`
      SELECT NULL as id, MAX(name) as name, phone,
             0 as credit_balance, SUM(grand_total) as total_spent
      FROM (
        SELECT customer_name as name, customer_phone as phone, grand_total
        FROM sales
        WHERE status != 'cancelled' AND customer_phone IS NOT NULL AND customer_id IS NULL
        UNION ALL
        SELECT sender_name as name, sender_phone as phone, grand_total
        FROM sales
        WHERE status != 'cancelled' AND sender_phone IS NOT NULL AND sender_customer_id IS NULL
      ) s
      WHERE (phone ILIKE ? OR name ILIKE ?)
      GROUP BY phone
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
router.get('/upcoming-dates', authenticate, authorize('owner', 'manager'), async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const { days = 30 } = req.query;

    // Get all customers with birthday/anniversary/custom_dates
    const customers = await db.prepare(`
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
        const custom = safeParseJSON(c.custom_dates, []);
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
      }
    }

    upcoming.sort((a, b) => a.days_away - b.days_away);
    res.json({ success: true, data: upcoming });
  } catch (err) { next(err); }
});

// ─── GET /api/customers/:id ─────────────────────────────────
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const customer = await db.prepare(`
      SELECT id, name, phone, email, birthday, anniversary, custom_dates,
             total_spent, credit_balance, notes, is_active, created_at, updated_at
      FROM users WHERE id = ? AND role = 'customer'
    `).get(req.params.id);

    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

    customer.custom_dates = safeParseJSON(customer.custom_dates, []);

    // Addresses
    const addresses = await db.prepare(
      'SELECT * FROM customer_addresses WHERE customer_id = ? ORDER BY is_default DESC, created_at DESC'
    ).all(req.params.id);

    // Order history (recent 20)
    const orders = await db.prepare(`
      SELECT s.id, s.sale_number, s.grand_total, s.order_type, s.status, s.payment_status, s.created_at,
             s.receiver_name, s.receiver_phone, s.sender_same_as_receiver,
             s.delivery_address, s.sender_name, s.sender_phone,
             COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.sale_id = s.id), 0) as total_paid
      FROM sales s
      WHERE (s.customer_id = ? OR s.sender_customer_id = ?) AND s.status != 'cancelled'
      ORDER BY s.created_at DESC LIMIT 20
    `).all(req.params.id, req.params.id);

    // Calculate balance due per order
    const ordersWithDues = orders.map(o => ({
      ...o,
      balance_due: Math.max(0, o.grand_total - o.total_paid),
    }));

    // Credit payments
    const creditPayments = await db.prepare(`
      SELECT cp.*, cp.payment_method as method, u.name as received_by_name
      FROM credit_payments cp
      LEFT JOIN users u ON cp.recorded_by = u.id
      WHERE cp.customer_id = ?
      ORDER BY cp.created_at DESC LIMIT 20
    `).all(req.params.id);

    // Special dates from separate table
    const specialDates = await db.prepare(
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
router.get('/:id/addresses', authenticate, async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const addresses = await db.prepare(
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
    body('location_id').isInt({ min: 1 }).withMessage('Location ID is required'),
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

      const { amount, method, notes, sale_id, location_id } = req.body;
      const numLocationId = parseInt(location_id, 10);

      if (amount > customer.credit_balance) {
        return res.status(400).json({ success: false, message: `Payment amount (₹${amount}) exceeds outstanding balance (₹${customer.credit_balance})` });
      }

      const creditTx = db.transaction(() => {
        // Record credit payment
        const result = db.prepare(
          'INSERT INTO credit_payments (customer_id, amount, payment_method, recorded_by, notes, sale_id, location_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(customerId, amount, method, req.user.id, notes || '', sale_id || null, numLocationId);

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
            const roundedGrandTotal = Math.round(Number(sale.grand_total || 0) * 100) / 100;
            const roundedTotalPaid = Math.round(Number(totalPaid || 0) * 100) / 100;
            let paymentStatus = 'pending';
            if (roundedTotalPaid >= roundedGrandTotal - 0.01) paymentStatus = 'paid';
            else if (roundedTotalPaid > 0) paymentStatus = 'partial';
            db.prepare('UPDATE sales SET payment_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(paymentStatus, sale_id);
          }
        } else {
          // Auto-allocate general credit payment to the oldest unpaid sales
          let remainingAmount = amount;
          const unpaidSales = db.prepare(`
            SELECT s.id, s.grand_total, COALESCE((SELECT SUM(amount) FROM payments WHERE sale_id = s.id), 0) as total_paid
            FROM sales s
            WHERE (s.customer_id = ? OR s.sender_customer_id = ?) AND s.status != 'cancelled' AND s.payment_status != 'paid'
            ORDER BY s.created_at ASC
          `).all(customerId, customerId);

          for (const s of unpaidSales) {
            if (remainingAmount <= 0.01) break;
            const saleUnpaid = Math.max(0, s.grand_total - s.total_paid);
            if (saleUnpaid > 0) {
              const allocation = Math.min(saleUnpaid, remainingAmount);
              db.prepare('INSERT INTO payments (sale_id, method, amount, reference_number, received_by) VALUES (?, ?, ?, ?, ?)').run(s.id, method, allocation, `Credit-${result.lastInsertRowid}`, req.user.id);
              remainingAmount -= allocation;
              
              const newTotalPaid = s.total_paid + allocation;
              const roundedGrandTotal = Math.round(Number(s.grand_total || 0) * 100) / 100;
              const roundedTotalPaid = Math.round(Number(newTotalPaid || 0) * 100) / 100;
              let paymentStatus = 'pending';
              if (roundedTotalPaid >= roundedGrandTotal - 0.01) paymentStatus = 'paid';
              else if (roundedTotalPaid > 0) paymentStatus = 'partial';
              db.prepare('UPDATE sales SET payment_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(paymentStatus, s.id);
            }
          }
        }

        // Update cash register if payment is cash
        const register = db.prepare('SELECT id FROM cash_registers WHERE location_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1').get(numLocationId);
        if (register) {
          if (method === 'cash') {
            db.prepare('UPDATE cash_registers SET total_cash_sales = total_cash_sales + ?, expected_cash = expected_cash + ? WHERE id = ?').run(amount, amount, register.id);
          } else if (method === 'card') {
            db.prepare('UPDATE cash_registers SET total_card_sales = total_card_sales + ? WHERE id = ?').run(amount, register.id);
          } else if (method === 'upi') {
            db.prepare('UPDATE cash_registers SET total_upi_sales = total_upi_sales + ? WHERE id = ?').run(amount, register.id);
          }
        }

        return result.lastInsertRowid;
      });

      const paymentId = creditTx();

      const payment = db.prepare(`
        SELECT cp.*, cp.payment_method as method, u.name as received_by_name, l.name as location_name
        FROM credit_payments cp
        LEFT JOIN users u ON cp.recorded_by = u.id
        LEFT JOIN locations l ON cp.location_id = l.id
        WHERE cp.id = ?
      `).get(paymentId);

      const updated = db.prepare('SELECT credit_balance FROM users WHERE id = ?').get(customerId);

      res.status(201).json({ success: true, data: payment, new_balance: updated.credit_balance });
    } catch (err) { next(err); }
  }
);

// ─── POST /api/customers/:id/add-due ─────────────────────────
// Add previous/historical dues for a customer
router.post(
  '/:id/add-due',
  authenticate,
  authorize('owner', 'manager'),
  [
    body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be positive'),
    body('date').optional().trim(),
    body('notes').optional().trim(),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });

      const db = getDb();
      const customerId = req.params.id;

      const customer = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'customer'").get(customerId);
      if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

      const { amount, date, notes } = req.body;
      const parsedAmount = parseFloat(amount);
      const negativeAmount = -Math.abs(parsedAmount);

      const dueTx = db.transaction(() => {
        // Insert record into credit_payments to log the addition of dues
        // Using payment_method = 'previous_due'
        let insertQuery = 'INSERT INTO credit_payments (customer_id, amount, payment_method, recorded_by, notes) VALUES (?, ?, ?, ?, ?)';
        const params = [customerId, negativeAmount, 'previous_due', req.user.id, notes || 'Added previous due'];
        
        if (date) {
           insertQuery = 'INSERT INTO credit_payments (customer_id, amount, payment_method, recorded_by, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)';
           params.push(date + (date.length === 10 ? ' 00:00:00' : ''));
        }

        const result = db.prepare(insertQuery).run(...params);

        // Increase customer credit balance
        db.prepare('UPDATE users SET credit_balance = credit_balance + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(parsedAmount, customerId);

        return result.lastInsertRowid;
      });

      const paymentId = dueTx();

      const payment = db.prepare(`
        SELECT cp.*, cp.payment_method as method, u.name as received_by_name, l.name as location_name
        FROM credit_payments cp
        LEFT JOIN users u ON cp.recorded_by = u.id
        LEFT JOIN locations l ON cp.location_id = l.id
        WHERE cp.id = ?
      `).get(paymentId);

      const updated = db.prepare('SELECT credit_balance FROM users WHERE id = ?').get(customerId);

      res.status(201).json({ success: true, data: payment, new_balance: updated.credit_balance });
    } catch (err) { next(err); }
  }
);

// ─── GET /api/customers/:id/credits ──────────────────────────
router.get('/:id/credits', authenticate, async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const { limit = 50, offset = 0, search, startDate, endDate, method, type, sort = 'date_desc', includeAllOrders = 'false' } = req.query;
    const includeAll = includeAllOrders === 'true';

    const customerId = req.params.id;

    // The sales filter ensures that if we don't include all orders, we only include credit orders.
    const saleFilter = !includeAll 
      ? `AND (s.is_credit_sale = 1 OR s.payment_status != 'paid')` 
      : ``;

    let baseSql = `
      WITH combined_ledger AS (
        -- 1. Manual Credit Payments & Generic Payments
        SELECT 
          cp.id as id,
          cp.customer_id,
          cp.sale_id,
          cp.amount,
          cp.payment_method as method,
          NULL as reference_number,
          cp.notes,
          cp.recorded_by,
          cp.created_at,
          (
            SELECT string_agg('Applied ₹' || p.amount || ' to Order #' || s.sale_number, ', ') 
            FROM payments p JOIN sales s ON p.sale_id = s.id 
            WHERE p.reference_number = 'Credit-' || cp.id
          ) as allocation_details,
          NULL as remaining_due,
          NULL as sale_number,
          'credit_payment' as source_table,
          u.name as received_by_name,
          l.name as location_name
        FROM credit_payments cp
        LEFT JOIN users u ON cp.recorded_by = u.id
        LEFT JOIN locations l ON cp.location_id = l.id
        WHERE cp.customer_id = ?
        
        UNION ALL
        
        -- 2. Sales Invoices (Debts)
        SELECT 
          s.id as id,
          ? as customer_id,
          s.id as sale_id,
          -(s.grand_total) as amount,
          'order_debt' as method,
          s.sale_number as reference_number,
          'Order Placed' as notes,
          s.created_by as recorded_by,
          s.created_at,
          NULL as allocation_details,
          -(s.grand_total - (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE sale_id = s.id)) as remaining_due,
          s.sale_number as sale_number,
          'sales' as source_table,
          u.name as received_by_name,
          l.name as location_name
        FROM sales s
        LEFT JOIN users u ON s.created_by = u.id
        LEFT JOIN locations l ON s.location_id = l.id
        WHERE (s.customer_id = ? OR s.sender_customer_id = ?) AND s.status != 'cancelled'
          ${saleFilter}

        UNION ALL
        
        -- 3. Payments for Sales
        SELECT 
          p.id as id,
          ? as customer_id,
          p.sale_id,
          p.amount,
          p.method,
          p.reference_number,
          'Order Payment' as notes,
          p.received_by as recorded_by,
          p.created_at,
          NULL as allocation_details,
          NULL as remaining_due,
          s.sale_number as sale_number,
          'payments' as source_table,
          u.name as received_by_name,
          l.name as location_name
        FROM payments p
        JOIN sales s ON p.sale_id = s.id
        LEFT JOIN users u ON p.received_by = u.id
        LEFT JOIN locations l ON s.location_id = l.id
        WHERE (s.customer_id = ? OR s.sender_customer_id = ?) AND s.status != 'cancelled'
          AND (p.reference_number IS NULL OR p.reference_number NOT LIKE 'Credit-%')
          ${saleFilter}
      )
      SELECT * FROM combined_ledger
    `;

    // 7 question marks in baseSql
    let baseParams = [customerId, customerId, customerId, customerId, customerId, customerId, customerId];

    let whereFilters = [];
    if (search) {
      whereFilters.push(`(notes ILIKE ? OR received_by_name ILIKE ?)`);
      baseParams.push(`%${search}%`, `%${search}%`);
    }
    if (startDate) {
      whereFilters.push(`DATE(created_at) >= ?`);
      baseParams.push(startDate);
    }
    if (endDate) {
      whereFilters.push(`DATE(created_at) <= ?`);
      baseParams.push(endDate);
    }
    
    if (method && method !== 'all') {
      if (method === 'previous_due') whereFilters.push(`method = 'previous_due'`);
      else {
        whereFilters.push(`method = ?`);
        baseParams.push(method);
      }
    }

    if (type === 'payment') whereFilters.push(`amount > 0`);
    else if (type === 'due') whereFilters.push(`amount < 0 AND (remaining_due IS NULL OR ROUND(remaining_due::numeric, 2) != 0)`);

    const whereClause = whereFilters.length > 0 ? `WHERE ${whereFilters.join(' AND ')}` : '';

    let sortClause = 'ORDER BY created_at DESC';
    if (sort === 'date_asc') sortClause = 'ORDER BY created_at ASC';
    else if (sort === 'amount_desc') sortClause = 'ORDER BY ABS(amount) DESC';

    const countSql = `SELECT COUNT(*) as total FROM (${baseSql}) as t ${whereClause}`;
    const dataSql = `${baseSql} ${whereClause} ${sortClause} LIMIT ? OFFSET ?`;

    const dataParams = [...baseParams, parseInt(limit), parseInt(offset)];

    console.log("SQL:", countSql);
    console.log("PARAMS:", baseParams);

    const { total } = await db.prepare(countSql).get(...baseParams);
    const payments = await db.prepare(dataSql).all(...dataParams);

    const customer = await db.prepare("SELECT credit_balance FROM users WHERE id = ? AND role = 'customer'").get(customerId);
    res.json({ success: true, data: payments, total, credit_balance: customer?.credit_balance || 0, limit: parseInt(limit), offset: parseInt(offset) });
  } catch (err) { next(err); }
});

// ─── PUT /api/customers/:id/credits/:creditId ─────────────────
router.put(
  '/:id/credits/:creditId',
  authenticate,
  authorize('owner'),
  [
    body('amount').optional().isFloat().withMessage('Invalid amount'),
    body('method').optional().isIn(['cash', 'card', 'upi', 'previous_due']).withMessage('Invalid method'),
    body('notes').optional().trim(),
    body('date').optional().trim()
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });

      const db = getDb();
      const { id: customerId, creditId } = req.params;
      const { amount, method, notes, date } = req.body;

      const record = db.prepare('SELECT * FROM credit_payments WHERE id = ? AND customer_id = ?').get(creditId, customerId);
      if (!record) return res.status(404).json({ success: false, message: 'Credit record not found' });

      if (record.sale_id && (amount !== undefined && Number(amount) !== Number(record.amount) || method !== undefined && method !== record.payment_method)) {
        return res.status(400).json({ success: false, message: 'Cannot edit amount or method for payments linked to a sale. Edit the sale instead.' });
      }

      const editTx = db.transaction(() => {
        let updates = [];
        let params = [];
        
        let amountDelta = 0;
        let newAmount = record.amount;

        if (amount !== undefined && Number(amount) !== Number(record.amount)) {
          newAmount = Number(amount);
          amountDelta = Number(record.amount) - newAmount;
          updates.push('amount = ?');
          params.push(newAmount);
        }

        if (method !== undefined) {
          updates.push('payment_method = ?');
          params.push(method);
        }
        if (notes !== undefined) {
          updates.push('notes = ?');
          params.push(notes);
        }
        if (date !== undefined) {
          updates.push('created_at = ?');
          params.push(date + (date.length === 10 ? ' 00:00:00' : ''));
        }

        if (updates.length > 0) {
          params.push(creditId);
          db.prepare(`UPDATE credit_payments SET ${updates.join(', ')} WHERE id = ?`).run(...params);

          if (amountDelta !== 0) {
            db.prepare('UPDATE users SET credit_balance = credit_balance + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(amountDelta, customerId);
          }
        }
      });

      editTx();

      const updatedRecord = db.prepare(`
        SELECT cp.*, cp.payment_method as method, u.name as received_by_name, l.name as location_name
        FROM credit_payments cp
        LEFT JOIN users u ON cp.recorded_by = u.id
        LEFT JOIN locations l ON cp.location_id = l.id
        WHERE cp.id = ?
      `).get(creditId);

      const customer = db.prepare('SELECT credit_balance FROM users WHERE id = ?').get(customerId);
      res.json({ success: true, data: updatedRecord, new_balance: customer.credit_balance });
    } catch (err) { next(err); }
  }
);

// ─── DELETE /api/customers/:id/credits/:creditId ──────────────
router.delete('/:id/credits/:creditId', authenticate, authorize('owner'), (req, res, next) => {
  try {
    const db = getDb();
    const { id: customerId, creditId } = req.params;

    const record = db.prepare('SELECT * FROM credit_payments WHERE id = ? AND customer_id = ?').get(creditId, customerId);
    if (!record) return res.status(404).json({ success: false, message: 'Credit record not found' });

    if (record.sale_id) {
      return res.status(400).json({ success: false, message: 'Cannot delete payments linked to a sale directly. Modify the sale instead.' });
    }

    const deleteTx = db.transaction(() => {
      db.prepare('UPDATE users SET credit_balance = credit_balance + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(record.amount, customerId);
      db.prepare('DELETE FROM credit_payments WHERE id = ?').run(creditId);
    });

    deleteTx();

    const customer = db.prepare('SELECT credit_balance FROM users WHERE id = ?').get(customerId);
    res.json({ success: true, message: 'Record deleted successfully', new_balance: customer.credit_balance });
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
router.get('/:id/orders', authenticate, async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const { limit = 30, offset = 0 } = req.query;

    const orders = await db.prepare(`
      SELECT s.id, s.sale_number, s.grand_total, s.order_type, s.status,
             s.discount_amount, s.payment_status, s.created_at,
             l.name as location_name
      FROM sales s
      LEFT JOIN locations l ON s.location_id = l.id
      WHERE (s.customer_id = ? OR s.sender_customer_id = ?) AND s.status != 'cancelled'
      ORDER BY s.created_at DESC
      LIMIT ? OFFSET ?
    `).all(req.params.id, req.params.id, parseInt(limit), parseInt(offset));

    const { total } = await db.prepare(
      "SELECT COUNT(*) as total FROM sales WHERE (customer_id = ? OR sender_customer_id = ?) AND status != 'cancelled'"
    ).get(req.params.id, req.params.id);

    res.json({ success: true, data: orders, total });
  } catch (err) { next(err); }
});

module.exports = router;
