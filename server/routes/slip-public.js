// Public, no-login slip QR scan page API (spec
// 2026-10-28-slip-qr-open-orders-checkout-design.md §3.1-§3.3). Anyone holding
// the shop copy of a delivery/pickup slip can scan its QR, see the items with
// photos and voice notes, and tick the same load checklist staff use in-app.
//
// SECURITY: the response is built field by field from an explicit whitelist.
// Never SELECT * into it or spread a DB row into it. No prices, totals,
// payments, phone numbers, addresses, customer/receiver names or staff names
// may ever appear here. verify-slip-and-open-requests.js walks the JSON for
// a deny-list of keys to guard this.
const express = require('express');
const router = express.Router();
const { getDb: getAsyncDb } = require('../config/database-async');
const { verifySlipToken } = require('../utils/slip-token');
const { getChecklistForSale, setCheck } = require('../utils/load-checks');

// Own in-memory per-IP fixed-window limiter, same shape as track.js and
// deliberately not sharing its state. 60/min because the page polls.
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 60;
const rateLimitBuckets = new Map(); // ip -> { count, windowStart }

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

function notFound(res) {
  return res.status(404).json({ success: false, message: 'Not found' });
}

// Verifies the token and loads the sale, applying the 7-day expiry: the link
// stops working once the sale is completed or cancelled AND its updated_at is
// more than 7 days old. Open orders always work. Returns null when the slip
// should 404 (bad token, missing sale, expired).
async function loadSlipSale(db, token) {
  const saleId = verifySlipToken(token);
  if (saleId === null) return null;
  const sale = await db.prepare(`
    SELECT s.id, s.sale_number, s.order_type, s.status, s.pickup_status,
           s.scheduled_date, s.scheduled_time, s.sender_message,
           (s.status IN ('completed', 'cancelled')
             AND COALESCE(s.updated_at, s.created_at) < LOCALTIMESTAMP - INTERVAL '7 days') AS slip_expired
    FROM sales s
    WHERE s.id = ?
  `).get(saleId);
  if (!sale || sale.slip_expired === true) return null;
  return sale;
}

function voiceNote(row) {
  return { url: row.file_url, duration_seconds: row.duration_seconds == null ? null : Number(row.duration_seconds) };
}

router.use((req, res, next) => {
  if (isRateLimited(req.ip)) {
    return res.status(429).json({ success: false, message: 'Too many requests. Please try again in a minute.' });
  }
  next();
});

router.get('/:token', async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const sale = await loadSlipSale(db, req.params.token);
    if (!sale) return notFound(res);

    const itemRows = await db.prepare(`
      SELECT si.id, si.quantity,
             COALESCE(si.product_name, p.name, m.name, 'Item') AS item_name,
             COALESCE(
               (SELECT pi.image_url FROM product_images pi WHERE pi.product_id = si.product_id ORDER BY pi.sort_order, pi.id LIMIT 1),
               p.image_url
             ) AS item_image_url
      FROM sale_items si
      LEFT JOIN products p ON si.product_id = p.id
      LEFT JOIN materials m ON si.material_id = m.id
      WHERE si.sale_id = ?
      ORDER BY si.id ASC
    `).all(sale.id);

    const voiceRows = await db.prepare(`
      SELECT sale_item_id, file_url, duration_seconds
      FROM sale_attachments
      WHERE sale_id = ? AND type = 'voice_note'
      ORDER BY created_at ASC, id ASC
    `).all(sale.id);

    const itemIds = new Set(itemRows.map((r) => r.id));
    const orderVoiceNotes = [];
    const notesByItem = new Map();
    for (const v of voiceRows) {
      if (v.sale_item_id != null && itemIds.has(v.sale_item_id)) {
        if (!notesByItem.has(v.sale_item_id)) notesByItem.set(v.sale_item_id, []);
        notesByItem.get(v.sale_item_id).push(voiceNote(v));
      } else {
        orderVoiceNotes.push(voiceNote(v));
      }
    }

    const checklist = await getChecklistForSale(db, sale);

    res.json({
      success: true,
      data: {
        order_number: sale.sale_number,
        order_type: sale.order_type,
        display_type: checklist.kind === 'delivery' ? 'Delivery' : 'Pickup',
        scheduled_date: sale.scheduled_date || null,
        scheduled_time: sale.scheduled_time || null,
        card_message: sale.sender_message || null,
        items: itemRows.map((r) => ({
          sale_item_id: r.id,
          name: r.item_name,
          quantity: Number(r.quantity),
          image_url: r.item_image_url || null,
          voice_notes: notesByItem.get(r.id) || [],
        })),
        order_voice_notes: orderVoiceNotes,
        checklist: {
          enabled: checklist.enabled,
          kind: checklist.kind,
          items: checklist.items.map((i) => ({ sale_item_id: i.sale_item_id, checked: i.checked, checked_at: i.checked_at })),
        },
      },
    });
  } catch (err) { next(err); }
});

router.put('/:token/check/:saleItemId(\\d+)', async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const sale = await loadSlipSale(db, req.params.token);
    if (!sale) return notFound(res);
    if (typeof req.body?.checked !== 'boolean') {
      return res.status(400).json({ success: false, message: 'Send checked as true or false' });
    }
    const checklist = await setCheck(db, sale, Number(req.params.saleItemId), req.body.checked, { userId: null, via: 'slip_qr' });
    res.json({
      success: true,
      data: {
        enabled: checklist.enabled,
        kind: checklist.kind,
        items: checklist.items.map((i) => ({ sale_item_id: i.sale_item_id, checked: i.checked, checked_at: i.checked_at })),
      },
    });
  } catch (err) {
    if (err.status === 404 || err.status === 409) {
      return res.status(err.status).json({ success: false, message: err.message });
    }
    next(err);
  }
});

module.exports = router;
