// Staff review routes for customer order requests. See
// server/routes/order-request-public.js for the public submission side,
// and server/routes/sales.js's POST / (search "source_order_request_id")
// for how Approve actually works: it is NOT a route in this file — it's
// LogOrderScreen's own existing Save Order action, pre-filled with a
// request's data. See the design doc §5 for why.
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authenticate, authorize } = require('../middleware/auth');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getDb: getAsyncDb, withTransaction } = require('../config/database-async');
const { normalizeIndianPhone, normalizedPhoneSql } = require('../utils/phone');
const { buildOrderRequestUrl } = require('../utils/order-request-token');

const REVIEW_ROLES = ['owner', 'manager', 'employee', 'counter_staff'];
const NORM_USER_PHONE = normalizedPhoneSql('u.phone');

// ─── GET /api/order-requests ────────────────────────────────────────────
// Public address of the general (open) link, so the app shows the same web
// origin the per-customer links use, on web and native alike.
router.get('/open-link', authenticate, authorize(...REVIEW_ROLES), (req, res) => {
  res.json({ success: true, data: { url: buildOrderRequestUrl('open') } });
});

router.get('/', authenticate, authorize(...REVIEW_ROLES), async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const status = ['pending', 'approved', 'declined'].includes(req.query.status) ? req.query.status : 'pending';
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 50, 100));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

    const requests = await db.prepare(`
      SELECT r.*, u.name as customer_name, u.phone as customer_phone
      FROM order_requests r
      LEFT JOIN users u ON r.customer_id = u.id
      WHERE r.status = ?
      ORDER BY r.created_at DESC
      LIMIT ? OFFSET ?
    `).all(status, limit, offset);

    const totalRow = await db.prepare('SELECT COUNT(*) as count FROM order_requests WHERE status = ?').get(status);

    // Open-link requests with no customer yet: look up an existing customer
    // by normalized phone so the card can say "Matches: <name>" or
    // "New customer". Only for rows still unresolved.
    const unresolvedPhones = [...new Set(requests
      .filter((r) => r.customer_id === null && r.requester_phone)
      .map((r) => normalizeIndianPhone(r.requester_phone))
      .filter(Boolean))];
    const matchByPhone = new Map();
    if (unresolvedPhones.length > 0) {
      const rows = await db.prepare(`
        SELECT u.id, u.name, ${NORM_USER_PHONE} AS norm_phone
        FROM users u
        WHERE u.role = 'customer' AND ${NORM_USER_PHONE} IN (${unresolvedPhones.map(() => '?').join(', ')})
        ORDER BY u.id ASC
      `).all(...unresolvedPhones);
      rows.forEach((u) => { if (!matchByPhone.has(u.norm_phone)) matchByPhone.set(u.norm_phone, { id: u.id, name: u.name }); });
    }
    for (const r of requests) {
      r.matched_customer = r.customer_id === null && r.requester_phone
        ? (matchByPhone.get(normalizeIndianPhone(r.requester_phone)) || null)
        : null;
    }

    res.json({ success: true, data: { requests, total: Number(totalRow?.count || 0) } });
  } catch (err) { next(err); }
});

// ─── POST /api/order-requests/:id/resolve-customer ──────────────────────
// Called by Approve for an open-link request (customer_id NULL) before
// LogOrderScreen opens. Finds the role='customer' user with the same
// normalized phone, or creates one the same way POST /api/customers does,
// and links it to the request. The only place an open-link requester ever
// becomes a user. Idempotent: a repeat call returns the same customer with
// created:false. Decline never calls this.
router.post('/:id/resolve-customer', authenticate, authorize(...REVIEW_ROLES), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(404).json({ success: false, message: 'Request not found' });

    const result = await withTransaction(async (tx) => {
      // Row lock: two staff tapping Approve on the same request serialize here.
      const request = await tx.prepare(
        'SELECT id, status, customer_id, requester_name, requester_phone FROM order_requests WHERE id = ? FOR UPDATE'
      ).get(id);
      if (!request) return { http: 404, message: 'Request not found' };
      if (request.customer_id) return { customer_id: request.customer_id, created: false };
      if (request.status !== 'pending') return { http: 400, message: 'This request has already been reviewed.' };

      const phone = normalizeIndianPhone(request.requester_phone);
      const name = (request.requester_name || '').trim();
      if (!phone || !name) {
        return { http: 400, message: 'This request has no name or phone number. Add the customer from the Customers screen instead.' };
      }

      // Different requests with the same phone serialize on this lock, so
      // two approvals at once cannot create the same customer twice.
      await tx.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`order-request-customer:${phone}`);

      const existing = await tx.prepare(`
        SELECT u.id FROM users u
        WHERE u.role = 'customer' AND ${NORM_USER_PHONE} = ?
        ORDER BY (u.phone = ?) DESC, u.id ASC
        LIMIT 1
        FOR UPDATE
      `).get(phone, phone);

      let customerId;
      let created = false;
      if (existing) {
        customerId = existing.id;
      } else {
        const other = await tx.prepare(
          `SELECT u.id FROM users u WHERE ${NORM_USER_PHONE} = ? LIMIT 1`
        ).get(phone);
        if (other) {
          return { http: 409, message: 'This phone number belongs to a staff account, so it cannot be saved as a customer. Ask the customer for another number.' };
        }
        // Same columns and defaults as POST /api/customers: a random
        // password the customer never uses, notes '', created_by the staff member.
        const hashedPassword = bcrypt.hashSync(`bloom_${crypto.randomBytes(16).toString('hex')}`, bcrypt.genSaltSync(10));
        const ins = await tx.prepare(
          `INSERT INTO users (name, phone, email, password, role, birthday, anniversary, notes, created_by)
           VALUES (?, ?, NULL, ?, 'customer', NULL, NULL, '', ?)`
        ).run(name, phone, hashedPassword, req.user.id);
        customerId = ins.lastInsertRowid;
        created = true;
      }

      await tx.prepare('UPDATE order_requests SET customer_id = ? WHERE id = ?').run(customerId, id);
      return { customer_id: customerId, created };
    });

    if (result.http) return res.status(result.http).json({ success: false, message: result.message });
    res.json({ success: true, data: result });
  } catch (err) {
    if (err && err.code === '23505') {
      return res.status(409).json({ success: false, message: 'This phone number is already saved on another account. Ask the customer for another number.' });
    }
    next(err);
  }
});

// ─── PUT /api/order-requests/:id/decline ────────────────────────────────
router.put(
  '/:id/decline',
  authenticate,
  authorize('owner', 'manager', 'employee', 'counter_staff'),
  [body('reason').optional({ nullable: true }).trim()],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });

      const db = await getAsyncDb();
      const existing = await db.prepare('SELECT id, status FROM order_requests WHERE id = ?').get(req.params.id);
      if (!existing) return res.status(404).json({ success: false, message: 'Request not found' });
      if (existing.status !== 'pending') {
        return res.status(400).json({ success: false, message: 'This request has already been reviewed.' });
      }

      await db.prepare(`
        UPDATE order_requests
        SET status = 'declined', decline_reason = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(req.body.reason || null, req.user.id, req.params.id);

      res.json({ success: true });
    } catch (err) { next(err); }
  }
);

module.exports = router;
