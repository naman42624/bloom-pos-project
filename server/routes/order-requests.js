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
const { getDb: getAsyncDb } = require('../config/database-async');

// ─── GET /api/order-requests ────────────────────────────────────────────
router.get('/', authenticate, authorize('owner', 'manager', 'employee', 'counter_staff'), async (req, res, next) => {
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

    res.json({ success: true, data: { requests, total: Number(totalRow?.count || 0) } });
  } catch (err) { next(err); }
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
