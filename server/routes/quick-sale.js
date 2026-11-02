const express = require('express');
const { withTransaction } = require('../config/database-async');
const { authenticate, authorize } = require('../middleware/auth');
const { reverseSaleEffects } = require('../utils/sale-reversal');

const router = express.Router();

const REFUNDED_MESSAGE = 'This sale already has a refund. Use Refund on the sale instead.';

const NOT_QUICK_MESSAGE = "This sale isn't a quick sale entry";
const CLOSED_SESSION_MESSAGE = "This sale is from a register that's already closed. Use Refund on the sale instead.";

// POST /api/quick-sale/:saleId/undo
// Reverses a quick-sale entry exactly: sale cancelled, register totals
// taken back for payments collected in the open session, stock restored.
router.post(
  '/:saleId(\\d+)/undo',
  authenticate,
  authorize('owner', 'manager', 'employee', 'counter_staff'),
  async (req, res, next) => {
    try {
      // Every read and write below runs on one pooled client inside a real
      // BEGIN/COMMIT. The sale row is locked first so two taps cannot both
      // reverse the register.
      const outcome = await withTransaction(async (tx) => {
        const sale = await tx.prepare('SELECT * FROM sales WHERE id = ? FOR UPDATE').get(req.params.saleId);
        if (!sale) return { code: 404, message: 'Sale not found' };
        if (sale.entry_mode !== 'quick' && sale.entry_mode !== 'close_topup') return { code: 400, message: NOT_QUICK_MESSAGE };
        if (sale.status === 'cancelled') return { code: 400, message: 'Already undone' };

        const refunded = Number((await tx.prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM refunds WHERE sale_id = ?').get(sale.id)).total);
        if (refunded > 0) return { code: 409, message: REFUNDED_MESSAGE };

        const register = await tx
          .prepare('SELECT * FROM cash_registers WHERE location_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1')
          .get(sale.location_id);
        const sessionStart = register ? (register.opening_time || register.opened_at) : null;

        const payments = await tx.prepare('SELECT * FROM payments WHERE sale_id = ?').all(sale.id);
        // Payments taken in the open session (same created_at test that
        // register close uses to recompute totals).
        const inSessionIds = new Set();
        if (register) {
          const rows = await tx.prepare('SELECT id FROM payments WHERE sale_id = ? AND created_at >= ?').all(sale.id, sessionStart);
          rows.forEach((r) => inSessionIds.add(r.id));
        }
        if (payments.some((p) => p.method === 'cash' && !inSessionIds.has(p.id))) {
          return { code: 409, message: CLOSED_SESSION_MESSAGE };
        }

        const paymentTotal = payments.reduce((sum, p) => sum + Number(p.amount || 0), 0);

        const flip = await tx
          .prepare("UPDATE sales SET status = 'cancelled', undone_by = ?, undone_at = NOW(), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status != 'cancelled'")
          .run(req.user.id, sale.id);
        if (flip.changes === 0) return { code: 400, message: 'Already undone' };

        if (register) {
          for (const p of payments) {
            if (!inSessionIds.has(p.id)) continue;
            const amt = Number(p.amount || 0);
            if (p.method === 'cash') {
              await tx.prepare('UPDATE cash_registers SET total_cash_sales = total_cash_sales - ?, expected_cash = expected_cash - ? WHERE id = ?').run(amt, amt, register.id);
            } else if (p.method === 'upi') {
              await tx.prepare('UPDATE cash_registers SET total_upi_sales = total_upi_sales - ? WHERE id = ?').run(amt, register.id);
            } else if (p.method === 'card') {
              await tx.prepare('UPDATE cash_registers SET total_card_sales = total_card_sales - ? WHERE id = ?').run(amt, register.id);
            }
          }
        }

        await reverseSaleEffects(tx, sale, { paymentTotal, userId: req.user.id });

        await tx.prepare(`
          INSERT INTO audit_logs (entity_type, entity_id, user_id, action, previous_state, new_state, created_at)
          VALUES ('sale', ?, ?, 'quick_sale_undo', ?, ?, CURRENT_TIMESTAMP)
        `).run(
          sale.id,
          req.user.id,
          JSON.stringify({ status: sale.status, entry_mode: sale.entry_mode, payments }),
          JSON.stringify({ status: 'cancelled' })
        );

        const done = await tx.prepare('SELECT id, undone_at FROM sales WHERE id = ?').get(sale.id);
        return { data: { id: done.id, undone_at: done.undone_at } };
      });

      if (outcome.code) return res.status(outcome.code).json({ success: false, message: outcome.message });
      res.json({ success: true, data: outcome.data });
    } catch (err) { next(err); }
  }
);

module.exports = router;
