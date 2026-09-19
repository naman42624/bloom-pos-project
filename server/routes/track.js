// The app's first unauthenticated route. Given a valid signed token
// (server/utils/tracking-token.js), returns only enough for a customer to
// know where their order stands — no login, no app install required.
// See docs/superpowers/specs/2026-09-05-order-list-screens-redesign-design.md §5
// for exactly what is and is not returned, and why.
const express = require('express');
const router = express.Router();
const { getDb: getAsyncDb } = require('../config/database-async');
const { verifyTrackingToken } = require('../utils/tracking-token');
const { computeOrderStage } = require('../utils/order-stage');

// Minimal in-memory per-IP rate limiter, scoped to this one router — not a
// new dependency, since the app has no rate limiting anywhere else either
// (see CLAUDE.md's "Known structural debt" bullet on this route: "the
// server currently has no rate limiter at all"). Flagged in PR review: sale
// IDs are sequential and guessable (tracking-token.js's own doc comment
// already says so — the HMAC signature is what actually protects a guess,
// not the ID's obscurity), so this endpoint is a natural target for an
// ID-probing sweep even though each individual forged token still fails
// verification. Fixed-window, per-process — this app runs a single PM2
// process per VPS_DEPLOYMENT_GUIDE.md, so "per-process" is "per-deployment"
// in practice, not a gap introduced by this being in-memory.
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 30; // generous for a customer re-opening/refreshing their own link a few times
const rateLimitBuckets = new Map(); // ip -> { count, windowStart }

function isRateLimited(ip) {
  // Crude unbounded-growth guard: a real attacker rotating IPs to dodge
  // the limiter would also inflate this map, so cap it rather than let it
  // grow forever. Clearing it outright on overflow is safe — worst case
  // is a few extra requests through right at the reset, never a false
  // block — and simpler than a proper LRU for a low-traffic shop app.
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

router.get('/:token', async (req, res, next) => {
  try {
    if (isRateLimited(req.ip)) {
      return res.status(429).json({ success: false, message: 'Too many requests. Please try again in a minute.' });
    }
    const saleId = verifyTrackingToken(req.params.token);
    if (saleId === null) return res.status(404).json({ success: false, message: 'Not found' });

    const db = await getAsyncDb();
    const sale = await db.prepare(`
      SELECT s.*, l.name as location_name,
             d.status as delivery_status, d.cod_amount, d.cod_collected,
             (SELECT COUNT(*) FROM production_tasks pt WHERE pt.sale_id = s.id AND pt.status NOT IN ('completed', 'cancelled')) as open_task_count
      FROM sales s
      LEFT JOIN locations l ON s.location_id = l.id
      LEFT JOIN deliveries d ON d.sale_id = s.id
      WHERE s.id = ?
    `).get(saleId);
    if (!sale) return res.status(404).json({ success: false, message: 'Not found' });

    const stage = computeOrderStage(sale, 'customer', {});

    // Only customer-facing, non-sensitive fields — never grand_total,
    // payment_status, address, phone numbers, staff/rider names, or
    // cost/margin data. See the spec section referenced above.
    res.json({
      success: true,
      data: {
        sale_number: sale.sale_number,
        order_type: sale.order_type,
        stage_label: stage.label,
        // Added 2026-09-11 (whole-branch review finding B5): the frontend
        // originally had to reverse-map stage_label back to a stage key via
        // its own hand-maintained LABEL_TO_KEY table — fragile
        // string-coupling across a process boundary that would silently
        // break (fall back to 'new') the moment a label's wording changed
        // in order-stage.js without the frontend map being updated in
        // lockstep. computeOrderStage() already computes the key; sending
        // it directly removes the duplicate mapping entirely.
        stage_key: stage.key,
        scheduled_date: sale.scheduled_date,
        scheduled_time: sale.scheduled_time,
        location_name: sale.location_name,
      },
    });
  } catch (err) { next(err); }
});

module.exports = router;
