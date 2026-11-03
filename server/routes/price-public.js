// Public (no login) price page data, reached by scanning a product label QR.
// Returns only what a customer may see: name, picture, price, active options
// and a yes/no availability flag. Never cost, stock numbers, suppliers or
// materials. Whitelisted field by field, never a spread of the row.
const express = require('express');
const router = express.Router();
const { getDb: getAsyncDb } = require('../config/database-async');
const { ALPHABET, CODE_LENGTH } = require('../utils/label-code');

// Own in-memory per-IP fixed-window limiter (same shape as routes/track.js,
// deliberately not sharing state with it).
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 30;
const rateLimitBuckets = new Map();

function isRateLimited(ip) {
  if (rateLimitBuckets.size > 10000) rateLimitBuckets.clear();
  const now = Date.now();
  const bucket = rateLimitBuckets.get(ip);
  if (!bucket || now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimitBuckets.set(ip, { count: 1, windowStart: now });
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_LIMIT_MAX;
}

const NOT_FOUND = "We couldn't find this item — please ask at the counter.";
const CODE_RE = new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`);

router.get('/:code', async (req, res, next) => {
  try {
    if (isRateLimited(req.ip)) {
      return res.status(429).json({ success: false, message: 'Too many requests — please try again in a minute.' });
    }
    const code = String(req.params.code || '');
    if (!CODE_RE.test(code)) return res.status(404).json({ success: false, message: NOT_FOUND });

    const db = await getAsyncDb();
    const p = await db.prepare(`
      SELECT id, name, image_url, selling_price, price_mode, price_hint, is_one_off,
             (SELECT COALESCE(SUM(ps.quantity), 0) FROM product_stock ps WHERE ps.product_id = products.id) AS total_stock
      FROM products
      WHERE label_code = ? AND is_active = 1
    `).get(code);
    if (!p) return res.status(404).json({ success: false, message: NOT_FOUND });

    const opts = await db.prepare(`
      SELECT label, price FROM product_options
      WHERE product_id = ? AND is_active = 1
      ORDER BY sort_order, id
    `).all(p.id);
    const shop = await db.prepare("SELECT value FROM settings WHERE key = 'shop_name'").get();

    const isOpen = p.price_mode === 'open';
    res.json({
      success: true,
      data: {
        shop_name: (shop && shop.value) || 'Our shop',
        name: p.name,
        image_url: p.image_url || null,
        price: isOpen ? null : Number(p.selling_price),
        price_mode: isOpen ? 'open' : 'fixed',
        price_hint: p.price_hint || null,
        options: opts.map((o) => ({ label: o.label, price: Number(o.price) })),
        available: !p.is_one_off || Number(p.total_stock) > 0,
      },
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
