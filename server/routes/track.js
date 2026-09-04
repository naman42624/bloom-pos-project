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

router.get('/:token', async (req, res, next) => {
  try {
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
        scheduled_date: sale.scheduled_date,
        scheduled_time: sale.scheduled_time,
        location_name: sale.location_name,
      },
    });
  } catch (err) { next(err); }
});

module.exports = router;
