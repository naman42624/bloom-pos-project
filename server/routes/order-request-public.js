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
const crypto = require('crypto');
const { getDb: getAsyncDb } = require('../config/database-async');
const { normalizeIndianPhone } = require('../utils/phone');

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

// ─── Shared request-body rules (per-customer and open link) ─────────────
const TOO_LONG = 'One of the answers is too long. Please shorten it and try again.';
const isRealDate = (v) => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
const submitValidators = [
  body('recipient_name').trim().notEmpty().withMessage('Recipient name is required')
    .isLength({ max: 100 }).withMessage(TOO_LONG),
  body('recipient_phone').trim().notEmpty().withMessage('Recipient phone is required')
    .isLength({ max: 20 }).withMessage('Please enter one phone number (up to 20 characters).'),
  body('order_type').isIn(['delivery', 'pickup']).withMessage('Please choose delivery or pickup'),
  body('delivery_address').optional({ nullable: true }).trim().isLength({ max: 500 }).withMessage(TOO_LONG),
  body('message').optional({ nullable: true }).trim().isLength({ max: 500 }).withMessage(TOO_LONG),
  body('requested_date').notEmpty().withMessage('Requested date is required')
    .bail().custom(isRealDate).withMessage('Please pick a real date.'),
  body('requested_time').optional({ nullable: true }).trim().isLength({ max: 50 }).withMessage(TOO_LONG),
  body('items').isArray({ min: 1, max: 50 }).withMessage('Please add between 1 and 50 items.'),
  body('items.*.quantity').isInt({ min: 1, max: 999 }).withMessage('Each quantity must be between 1 and 999.'),
  body('items.*.product_id').optional({ nullable: true }).isInt().withMessage('Please check the items and try again'),
  body('items.*.custom').optional().isBoolean().withMessage('Please check the items and try again'),
  body('items.*.description').optional({ nullable: true }).trim().isLength({ max: 200 }).withMessage(TOO_LONG),
  body('items.*.name').optional({ nullable: true }).isString().isLength({ max: 200 }).withMessage(TOO_LONG),
  body('payment_claimed').optional().isBoolean().toBoolean(),
  body('payment_reference').optional({ nullable: true }).trim().isLength({ max: 100 }).withMessage(TOO_LONG),
];

function firstMessage(errors) {
  const list = errors.array();
  const m = list[0].msg;
  return m === 'Invalid value' ? 'Please check the form and try again' : m;
}

// Validates the order part of a submit body. Returns { error } with a plain
// message, or { fields } ready to insert.
function readOrderFields(reqBody) {
  const {
    recipient_name, recipient_phone, order_type, delivery_address, message,
    requested_date, requested_time, items, payment_claimed, payment_reference,
  } = reqBody;

  if (order_type === 'delivery' && !(delivery_address || '').trim()) {
    return { error: 'Delivery address is required' };
  }

  // Every item needs either a real catalog product reference or a
  // non-empty custom description — a bare {quantity: 2} with neither is
  // silently useless downstream (LogOrderScreen's prefill has nothing
  // to show for it). Product existence/active-state is deliberately
  // NOT re-validated here — see spec §7: drift is handled entirely at
  // approve time by LogOrderScreen's own live checks, not here.
  // Each stored item is rebuilt from a fixed field set, never the client
  // object, so unknown keys are never persisted.
  const validItems = items.filter((item) => {
    if (item.custom) return typeof item.description === 'string' && item.description.trim().length > 0;
    return Number.isInteger(item.product_id);
  }).map((item) => {
    const out = { quantity: Number(item.quantity) };
    if (item.custom) {
      out.custom = true;
      out.description = item.description.trim();
    } else {
      out.product_id = item.product_id;
    }
    if (typeof item.name === 'string' && item.name.trim()) out.name = item.name.trim();
    return out;
  });
  if (validItems.length === 0) return { error: 'At least one item is required' };

  return {
    fields: [
      recipient_name.trim(), recipient_phone.trim(), order_type,
      order_type === 'delivery' ? (delivery_address || '').trim() : null,
      message ? message.trim() : null, requested_date, requested_time || null,
      validItems, !!payment_claimed, payment_reference ? payment_reference.trim() : null,
    ],
  };
}

async function loadCatalogAndShop(db) {
  const products = await db.prepare(
    'SELECT id, name, description, category, selling_price FROM products WHERE is_active = 1 ORDER BY name ASC LIMIT 200'
  ).all();
  const qrSetting = await db.prepare("SELECT value FROM settings WHERE key = 'upi_qr_image_url'").get();
  return { products, upi_qr_image_url: (qrSetting && qrSetting.value) || null };
}

// The open link and status routes below MUST stay declared before
// /:token, or "open" and "status" would be read as a customer token.

// ─── GET /api/order-request/open ────────────────────────────────────────
// Catalog and shop info for the general (open) link. No customer data.
router.get('/open', async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    res.json({ success: true, data: await loadCatalogAndShop(db) });
  } catch (err) { next(err); }
});

// ─── POST /api/order-request/open ───────────────────────────────────────
// Anyone with the link can submit. The request is stored with
// customer_id NULL; NO users row is created or changed here. Staff turn
// the requester into a customer only when they approve (see
// POST /api/order-requests/:id/resolve-customer).
router.post(
  '/open',
  [
    body('requester_name').trim()
      .notEmpty().withMessage('Please enter your name')
      .isLength({ min: 2, max: 80 }).withMessage('Please enter your name (2 to 80 letters)'),
    body('requester_phone').custom((v) => /^[6-9]\d{9}$/.test(normalizeIndianPhone(v) || ''))
      .withMessage('Please enter a 10-digit mobile number.'),
    ...submitValidators,
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: firstMessage(errors), errors: errors.array() });
      }

      const parsed = readOrderFields(req.body);
      if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });

      const statusToken = crypto.randomBytes(24).toString('hex');
      const db = await getAsyncDb();
      await db.prepare(`
        INSERT INTO order_requests (
          customer_id, recipient_name, recipient_phone, order_type, delivery_address,
          message, requested_date, requested_time, items_json, payment_claimed, payment_reference,
          requester_name, requester_phone, status_token, source
        ) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'general_link')
      `).run(
        ...parsed.fields,
        req.body.requester_name.trim(), normalizeIndianPhone(req.body.requester_phone), statusToken
      );

      res.status(201).json({ success: true, data: { status_url: `/order-request/status/${statusToken}` } });
    } catch (err) { next(err); }
  }
);

// ─── GET /api/order-request/status/:statusToken ─────────────────────────
// Status of exactly one open-link request. Returns nothing about the
// requester, the recipient or any other request.
router.get('/status/:statusToken', async (req, res, next) => {
  try {
    const token = String(req.params.statusToken || '');
    if (!/^[0-9a-f]{48}$/.test(token)) return res.status(404).json({ success: false, message: 'Not found' });
    const db = await getAsyncDb();
    const row = await db.prepare(
      'SELECT status, decline_reason, created_at, items_json FROM order_requests WHERE status_token = ?'
    ).get(token);
    if (!row) return res.status(404).json({ success: false, message: 'Not found' });

    const items = Array.isArray(row.items_json) ? row.items_json : [];
    const productIds = items.filter((i) => !i.custom && Number.isInteger(i.product_id)).map((i) => i.product_id);
    const names = new Map();
    if (productIds.length > 0) {
      const rows = await db.prepare(
        `SELECT id, name FROM products WHERE id IN (${productIds.map(() => '?').join(', ')})`
      ).all(...productIds);
      rows.forEach((p) => names.set(p.id, p.name));
    }
    const items_summary = items.map((i) => ({
      name: i.custom ? i.description : (names.get(i.product_id) || i.name || 'Item'),
      quantity: Number(i.quantity) || 1,
    }));

    res.json({
      success: true,
      data: {
        status: row.status,
        decline_reason: row.status === 'declined' ? (row.decline_reason || null) : null,
        created_at: row.created_at,
        items_summary,
      },
    });
  } catch (err) { next(err); }
});

// ─── GET /api/order-request/:token ──────────────────────────────────────
router.get('/:token', async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const customer = await db.prepare(
      "SELECT id, name FROM users WHERE order_request_token = ? AND role = 'customer'"
    ).get(req.params.token);
    if (!customer) return res.status(404).json({ success: false, message: 'Not found' });

    const shop = await loadCatalogAndShop(db);

    const requests = await db.prepare(`
      SELECT id, order_type, recipient_name, requested_date, requested_time,
             status, decline_reason, items_json, created_at
      FROM order_requests
      WHERE customer_id = ?
      ORDER BY created_at DESC
      LIMIT 10
    `).all(customer.id);

    res.json({
      success: true,
      data: {
        customer_name: customer.name,
        products: shop.products,
        upi_qr_image_url: shop.upi_qr_image_url,
        requests,
      },
    });
  } catch (err) { next(err); }
});

// ─── POST /api/order-request/:token ─────────────────────────────────────
router.post(
  '/:token',
  submitValidators,
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: firstMessage(errors), errors: errors.array() });

      const db = await getAsyncDb();
      const customer = await db.prepare(
        "SELECT id FROM users WHERE order_request_token = ? AND role = 'customer'"
      ).get(req.params.token);
      if (!customer) return res.status(404).json({ success: false, message: 'Not found' });

      const parsed = readOrderFields(req.body);
      if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });

      const insertResult = await db.prepare(`
        INSERT INTO order_requests (
          customer_id, recipient_name, recipient_phone, order_type, delivery_address,
          message, requested_date, requested_time, items_json, payment_claimed, payment_reference
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(customer.id, ...parsed.fields);

      res.status(201).json({ success: true, data: { id: insertResult.lastInsertRowid, status: 'pending' } });
    } catch (err) { next(err); }
  }
);

module.exports = router;
