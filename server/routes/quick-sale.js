const express = require('express');
const { getDb } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { reverseSaleEffects } = require('../utils/sale-reversal');

const router = express.Router();

const NOT_QUICK_MESSAGE = "This sale isn't a quick sale entry";
const CLOSED_SESSION_MESSAGE = "This sale is from a register that's already closed. Use Refund on the sale instead.";

// POST /api/quick-sale/:saleId/undo
// Reverses a quick-sale entry exactly: sale cancelled, register totals
// taken back for payments collected in the open session, stock restored.
router.post(
  '/:saleId(\\d+)/undo',
  authenticate,
  authorize('owner', 'manager', 'employee', 'counter_staff'),
  (req, res, next) => {
    try {
      const db = getDb();
      const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(req.params.saleId);
      if (!sale) return res.status(404).json({ success: false, message: 'Sale not found' });
      if (sale.entry_mode !== 'quick' && sale.entry_mode !== 'close_topup') {
        return res.status(400).json({ success: false, message: NOT_QUICK_MESSAGE });
      }
      if (sale.status === 'cancelled') return res.status(400).json({ success: false, message: 'Already undone' });

      const register = db
        .prepare('SELECT * FROM cash_registers WHERE location_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1')
        .get(sale.location_id);
      const sessionStart = register ? (register.opening_time || register.opened_at) : null;

      const payments = db.prepare('SELECT * FROM payments WHERE sale_id = ?').all(sale.id);
      // Payments taken in the currently open session (same created_at test
      // that register close uses to recompute totals).
      const inSessionIds = new Set();
      if (register) {
        db.prepare('SELECT id FROM payments WHERE sale_id = ? AND created_at >= ?')
          .all(sale.id, sessionStart)
          .forEach((r) => inSessionIds.add(r.id));
      }

      const hasOutOfSessionCash = payments.some((p) => p.method === 'cash' && !inSessionIds.has(p.id));
      if (hasOutOfSessionCash) {
        return res.status(409).json({ success: false, message: CLOSED_SESSION_MESSAGE });
      }

      const paymentTotal = payments.reduce((s, p) => s + Number(p.amount || 0), 0);

      const tx = db.transaction(() => {
        db.prepare("UPDATE sales SET status = 'cancelled', undone_by = ?, undone_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
          .run(req.user.id, sale.id);

        if (register) {
          for (const p of payments) {
            if (!inSessionIds.has(p.id)) continue;
            const amt = Number(p.amount || 0);
            if (p.method === 'cash') {
              db.prepare('UPDATE cash_registers SET total_cash_sales = total_cash_sales - ?, expected_cash = expected_cash - ? WHERE id = ?').run(amt, amt, register.id);
            } else if (p.method === 'upi') {
              db.prepare('UPDATE cash_registers SET total_upi_sales = total_upi_sales - ? WHERE id = ?').run(amt, register.id);
            } else if (p.method === 'card') {
              db.prepare('UPDATE cash_registers SET total_card_sales = total_card_sales - ? WHERE id = ?').run(amt, register.id);
            }
          }
        }

        reverseSaleEffects(db, sale, { paymentTotal, userId: req.user.id });

        db.prepare(`
          INSERT INTO audit_logs (entity_type, entity_id, user_id, action, previous_state, new_state, created_at)
          VALUES ('sale', ?, ?, 'quick_sale_undo', ?, ?, CURRENT_TIMESTAMP)
        `).run(
          sale.id,
          req.user.id,
          JSON.stringify({ status: sale.status, entry_mode: sale.entry_mode, payments }),
          JSON.stringify({ status: 'cancelled' })
        );
      });
      tx();

      const done = db.prepare('SELECT id, undone_at FROM sales WHERE id = ?').get(sale.id);
      res.json({ success: true, data: { id: done.id, undone_at: done.undone_at } });
    } catch (err) { next(err); }
  }
);

module.exports = router;
