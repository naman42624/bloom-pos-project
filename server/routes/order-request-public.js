// Public, unauthenticated order-request page — a customer opens a link a
// staff member shared (see server/routes/customers.js's
// POST /:id/order-request-link) and submits their own order request, which
// staff later review and approve into a real order via LogOrderScreen (see
// server/routes/order-requests.js for the staff-side routes, and
// server/routes/sales.js's POST / for the approve wiring — search
// "source_order_request_id").
//
// Same shape as server/routes/track.js (the app's other public route): its
// own self-contained per-IP rate limiter, deliberately NOT sharing state
// with track.js's — see CLAUDE.md's "Known structural debt" note on this
// being one of only two rate-limited routes in the app.
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { getDb: getAsyncDb } = require('../config/database-async');

// ─── Rate limiting (own, self-contained — see file header) ─────────────
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
const rateLimitBuckets = new Map();

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const now = Date.now();
  if (rateLimitBuckets.size > 10000) rateLimitBuckets.clear();
  const bucket = rateLimitBuckets.get(ip);
  if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitBuckets.set(ip, { windowStart: now, count: 1 });
    return next();
  }
  bucket.count += 1;
  if (bucket.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ success: false, message: 'Too many requests. Please try again in a minute.' });
  }
  next();
}

router.use(rateLimit);

// ─── GET /api/order-request/:token ──────────────────────────────────────
router.get('/:token', async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const customer = await db.prepare(
      "SELECT id, name FROM users WHERE order_request_token = ? AND role = 'customer'"
    ).get(req.params.token);
    if (!customer) return res.status(404).json({ success: false, message: 'Not found' });

    const products = await db.prepare(
      'SELECT id, name, description, category, selling_price FROM products WHERE is_active = 1 ORDER BY name ASC LIMIT 200'
    ).all();

    const requests = await db.prepare(`
      SELECT id, order_type, recipient_name, requested_date, requested_time,
             status, decline_reason, items_json, created_at
      FROM order_requests
      WHERE customer_id = ?
      ORDER BY created_at DESC
      LIMIT 10
    `).all(customer.id);

    const qrSetting = await db.prepare("SELECT value FROM settings WHERE key = 'upi_qr_image_url'").get();

    res.json({
      success: true,
      data: {
        customer_name: customer.name,
        products,
        upi_qr_image_url: (qrSetting && qrSetting.value) || null,
        requests,
      },
    });
  } catch (err) { next(err); }
});

// ─── POST /api/order-request/:token ─────────────────────────────────────
router.post(
  '/:token',
  [
    body('recipient_name').trim().notEmpty().withMessage('Recipient name is required'),
    body('recipient_phone').trim().notEmpty().withMessage('Recipient phone is required'),
    body('order_type').isIn(['delivery', 'pickup']),
    body('delivery_address').optional({ nullable: true }).trim(),
    body('message').optional({ nullable: true }).trim(),
    body('requested_date').notEmpty().withMessage('Requested date is required'),
    body('requested_time').optional({ nullable: true }).trim(),
    body('items').isArray({ min: 1 }).withMessage('At least one item is required'),
    body('items.*.quantity').isInt({ min: 1 }),
    body('items.*.product_id').optional({ nullable: true }).isInt(),
    body('items.*.custom').optional().isBoolean(),
    body('items.*.description').optional({ nullable: true }).trim(),
    body('payment_claimed').optional().isBoolean().toBoolean(),
    body('payment_reference').optional({ nullable: true }).trim(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });

      const db = await getAsyncDb();
      const customer = await db.prepare(
        "SELECT id FROM users WHERE order_request_token = ? AND role = 'customer'"
      ).get(req.params.token);
      if (!customer) return res.status(404).json({ success: false, message: 'Not found' });

      const {
        recipient_name, recipient_phone, order_type, delivery_address, message,
        requested_date, requested_time, items, payment_claimed, payment_reference,
      } = req.body;

      if (order_type === 'delivery' && !(delivery_address || '').trim()) {
        return res.status(400).json({ success: false, message: 'Delivery address is required' });
      }

      // Every item needs either a real catalog product reference or a
      // non-empty custom description — a bare {quantity: 2} with neither is
      // silently useless downstream (LogOrderScreen's prefill has nothing
      // to show for it). Product existence/active-state is deliberately
      // NOT re-validated here — see spec §7: drift is handled entirely at
      // approve time by LogOrderScreen's own live checks, not here.
      const validItems = items.filter((item) => {
        if (item.custom) return typeof item.description === 'string' && item.description.trim().length > 0;
        return Number.isInteger(item.product_id);
      });
      if (validItems.length === 0) {
        return res.status(400).json({ success: false, message: 'At least one item is required' });
      }

      const insertResult = await db.prepare(`
        INSERT INTO order_requests (
          customer_id, recipient_name, recipient_phone, order_type, delivery_address,
          message, requested_date, requested_time, items_json, payment_claimed, payment_reference
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        customer.id, recipient_name.trim(), recipient_phone.trim(), order_type,
        order_type === 'delivery' ? (delivery_address || '').trim() : null,
        message ? message.trim() : null, requested_date, requested_time || null,
        validItems, !!payment_claimed, payment_reference ? payment_reference.trim() : null
      );

      res.status(201).json({ success: true, data: { id: insertResult.lastInsertRowid, status: 'pending' } });
    } catch (err) { next(err); }
  }
);

module.exports = router;
