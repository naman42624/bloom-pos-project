const express = require('express');
const { withTransaction, getDb } = require('../config/database-async');
const { todayStr, shopDayRangeUtc } = require('../utils/time');
const { authenticate, authorize } = require('../middleware/auth');
const { reverseSaleEffects } = require('../utils/sale-reversal');

const router = express.Router();

const REFUNDED_MESSAGE = 'This sale already has a refund. Use Refund on the sale instead.';

const HELPER_NOT_YOURS_MESSAGE = 'Ask the counter to undo this sale.';
const HELPER_TOO_OLD_MESSAGE = "It's been more than 2 minutes. Ask the counter to undo this sale.";
const NOT_QUICK_MESSAGE = "This sale isn't a quick sale entry";
const CLOSED_SESSION_MESSAGE = "This sale is from a register that's already closed. Use Refund on the sale instead.";

// POST /api/quick-sale/:saleId/undo
// Reverses a quick-sale entry exactly: sale cancelled, register totals
// taken back for payments collected in the open session, stock restored.
router.post(
  '/:saleId(\\d+)/undo',
  authenticate,
  authorize('owner', 'manager', 'employee', 'counter_staff', 'helper'),
  async (req, res, next) => {
    try {
      // Every read and write below runs on one pooled client inside a real
      // BEGIN/COMMIT. The sale row is locked first so two taps cannot both
      // reverse the register.
      const outcome = await withTransaction(async (tx) => {
        const sale = await tx.prepare('SELECT * FROM sales WHERE id = ? FOR UPDATE').get(req.params.saleId);
        // A helper gets the same answer for a missing sale as for someone else's
        if (!sale) return req.user.role === 'helper' ? { code: 403, message: HELPER_NOT_YOURS_MESSAGE } : { code: 404, message: 'Sale not found' };
        if (req.user.role === 'helper') {
          // A helper may undo only their own sale, made within the last 2 minutes
          // (database clock, checked here under the row lock).
          // Part 4 hook: also refuse when a handover_in exists for this helper since the sale.
          if (Number(sale.sold_by) !== Number(req.user.id) || Number(sale.created_by) !== Number(req.user.id)) {
            return { code: 403, message: HELPER_NOT_YOURS_MESSAGE };
          }
          if (sale.status === 'cancelled') return { code: 400, message: 'Already undone' };
          const fresh = await tx.prepare("SELECT 1 AS ok FROM sales WHERE id = ? AND created_at > NOW() - INTERVAL '2 minutes'").get(sale.id);
          if (!fresh) return { code: 403, message: HELPER_TOO_OLD_MESSAGE };
        } else if (sale.entry_mode !== 'quick' && sale.entry_mode !== 'close_topup') {
          return { code: 400, message: NOT_QUICK_MESSAGE };
        }
        if (sale.status === 'cancelled') return { code: 400, message: 'Already undone' };

        const refunded = Number((await tx.prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM refunds WHERE sale_id = ?').get(sale.id)).total);
        if (refunded > 0) return { code: 409, message: req.user.role === 'helper' ? HELPER_NOT_YOURS_MESSAGE : REFUNDED_MESSAGE };

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
          return { code: 409, message: req.user.role === 'helper' ? HELPER_NOT_YOURS_MESSAGE : CLOSED_SESSION_MESSAGE };
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
            let upd = null;
            if (p.method === 'cash') {
              upd = await tx.prepare('UPDATE cash_registers SET total_cash_sales = total_cash_sales - ?, expected_cash = expected_cash - ? WHERE id = ? AND closed_at IS NULL').run(amt, amt, register.id);
            } else if (p.method === 'upi') {
              upd = await tx.prepare('UPDATE cash_registers SET total_upi_sales = total_upi_sales - ? WHERE id = ? AND closed_at IS NULL').run(amt, register.id);
            } else if (p.method === 'card') {
              upd = await tx.prepare('UPDATE cash_registers SET total_card_sales = total_card_sales - ? WHERE id = ? AND closed_at IS NULL').run(amt, register.id);
            }
            if (upd && upd.changes === 0) {
              throw Object.assign(new Error('register closed'), { registerClosed: true });
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
    } catch (err) {
      if (err && err.registerClosed) {
        const msg = req.user.role === 'helper' ? HELPER_NOT_YOURS_MESSAGE : 'The register was just closed. Open it again, then undo.';
        return res.status(409).json({ success: false, message: msg });
      }
      next(err);
    }
  }
);

const ROLL_LIMIT = 200;
const TILE_LIMIT = 12;
const QUICK_MODES = "('quick','close_topup')";
const ROLES = ['owner', 'manager', 'employee', 'counter_staff'];

function locationIdFrom(req) {
  const id = parseInt(req.query.location_id, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// GET /api/quick-sale/roll?location_id=
// Today's quick entries for the open register session (or since local
// midnight when no register is open), newest first.
router.get('/roll', authenticate, authorize(...ROLES), async (req, res, next) => {
  try {
    const locationId = locationIdFrom(req);
    if (!locationId) return res.status(400).json({ success: false, message: 'Pick a shop location first' });
    const db = await getDb();

    const register = await db
      .prepare('SELECT * FROM cash_registers WHERE location_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1')
      .get(locationId);
    const sessionStart = register ? (register.opening_time || register.opened_at) : `${todayStr()} 00:00:00`;

    const rows = await db.prepare(`
      SELECT s.id, s.created_at, s.entry_mode, s.status, s.undone_at, u.name AS created_by_name,
             (SELECT COALESCE(si.product_name, 'Item') FROM sale_items si WHERE si.sale_id = s.id ORDER BY si.id LIMIT 1) AS item_name
      FROM sales s
      LEFT JOIN users u ON u.id = s.created_by
      WHERE s.location_id = ? AND s.entry_mode IN ${QUICK_MODES} AND s.created_at >= ?
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT ${ROLL_LIMIT}
    `).all(locationId, sessionStart);

    const payRows = rows.length
      ? await db.prepare(`SELECT sale_id, method, amount FROM payments WHERE sale_id IN (${rows.map(() => '?').join(',')}) ORDER BY id`).all(...rows.map((r) => r.id))
      : [];
    const bySale = new Map();
    for (const p of payRows) {
      if (!bySale.has(p.sale_id)) bySale.set(p.sale_id, []);
      bySale.get(p.sale_id).push(p);
    }

    const entries = rows.map((r) => {
      const pays = bySale.get(r.id) || [];
      const amount = pays.reduce((sum, p) => sum + Number(p.amount || 0), 0);
      const largest = pays.reduce((best, p) => (!best || Number(p.amount) > Number(best.amount) ? p : best), null);
      return {
        id: r.id,
        created_at: r.created_at,
        item_name: r.item_name || 'Item',
        amount,
        method: largest ? largest.method : null,
        undone: r.status === 'cancelled' || r.undone_at != null,
        entry_mode: r.entry_mode,
        created_by_name: r.created_by_name || null,
      };
    });

    // Totals cover every live entry in the session, not just the listed ones,
    // less any processed refunds of those sales.
    const t = await db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN p.method = 'cash' THEN p.amount ELSE 0 END), 0) AS cash,
        COALESCE(SUM(CASE WHEN p.method = 'upi' THEN p.amount ELSE 0 END), 0) AS upi,
        COUNT(DISTINCT s.id) AS count
      FROM sales s
      LEFT JOIN payments p ON p.sale_id = s.id
      WHERE s.location_id = ? AND s.entry_mode IN ${QUICK_MODES} AND s.created_at >= ? AND s.status != 'cancelled'
    `).get(locationId, sessionStart);

    const refundRows = await db.prepare(`
      SELECT COALESCE(r.refund_method, 'cash') AS method, COALESCE(SUM(r.amount), 0) AS total
      FROM refunds r
      JOIN sales s ON s.id = r.sale_id
      WHERE s.location_id = ? AND s.entry_mode IN ${QUICK_MODES} AND s.created_at >= ? AND s.status != 'cancelled'
        AND COALESCE(r.status, 'processed') = 'processed'
      GROUP BY COALESCE(r.refund_method, 'cash')
    `).all(locationId, sessionStart);
    let refundCash = 0;
    let refundUpi = 0;
    for (const r of refundRows) {
      if (r.method === 'upi') refundUpi += Number(r.total);
      else if (r.method === 'cash') refundCash += Number(r.total);
    }

    res.json({
      success: true,
      data: {
        session_start: sessionStart,
        register_open: !!register,
        totals: { cash: Number(t.cash) - refundCash, upi: Number(t.upi) - refundUpi, count: Number(t.count) },
        entries,
      },
    });
  } catch (err) { next(err); }
});

// GET /api/quick-sale/tiles?location_id=
// The owner chosen buttons, or the shop top sellers when none are set.
router.get('/tiles', authenticate, authorize(...ROLES), async (req, res, next) => {
  try {
    const locationId = locationIdFrom(req);
    if (!locationId) return res.status(400).json({ success: false, message: 'Pick a shop location first' });
    const db = await getDb();

    let configured = null;
    const setting = await db.prepare("SELECT value FROM settings WHERE key = 'quick_sale_tiles'").get();
    if (setting && setting.value) {
      try {
        const parsed = JSON.parse(setting.value);
        if (Array.isArray(parsed) && parsed.length > 0) configured = parsed;
      } catch (e) { configured = null; }
    }

    if (configured) {
      const tiles = [];
      for (let i = 0; i < configured.length && tiles.length < TILE_LIMIT; i++) {
        const t = configured[i];
        if (!t || typeof t !== 'object') continue;
        if (t.type === 'product') {
          const pid = Number(t.product_id);
          if (!Number.isInteger(pid) || pid <= 0) continue;
          const p = await db.prepare('SELECT id, name, selling_price FROM products WHERE id = ? AND is_active = 1').get(pid);
          if (!p) continue;
          tiles.push({ key: `p${p.id}`, type: 'product', product_id: p.id, label: p.name, price: Number(p.selling_price) });
        } else if (t.type === 'label') {
          const label = typeof t.label === 'string' ? t.label.trim() : '';
          const price = Number(t.price);
          if (!label || !(price > 0)) continue;
          tiles.push({ key: `l${i}`, type: 'label', product_id: null, label, price });
        }
      }
      return res.json({ success: true, data: { source: 'owner', tiles } });
    }

    const top = await db.prepare(`
      SELECT p.id, p.name, p.selling_price, COUNT(si.id) AS uses
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      JOIN products p ON p.id = si.product_id
      WHERE s.location_id = ? AND s.status != 'cancelled' AND p.is_active = 1
        AND s.created_at >= NOW() - INTERVAL '30 days'
      GROUP BY p.id, p.name, p.selling_price
      ORDER BY uses DESC, p.id
      LIMIT ${TILE_LIMIT}
    `).all(locationId);
    res.json({
      success: true,
      data: {
        source: 'suggested',
        tiles: top.map((p) => ({ key: `p${p.id}`, type: 'product', product_id: p.id, label: p.name, price: Number(p.selling_price) })),
      },
    });
  } catch (err) { next(err); }
});

// GET /api/quick-sale/my-sales?location_id=
// The caller's own sales for today (shop-local day) at one location, newest
// first, undone ones flagged. Never returns cost or anyone else's sales.
router.get('/my-sales', authenticate, authorize(...ROLES, 'helper'), async (req, res, next) => {
  try {
    const locationId = locationIdFrom(req);
    if (!locationId) return res.status(400).json({ success: false, message: 'Pick a shop location first' });
    const db = await getDb();
    if (req.user.role !== 'owner') {
      const link = await db.prepare('SELECT 1 AS ok FROM user_locations WHERE user_id = ? AND location_id = ?').get(req.user.id, locationId);
      if (!link) return res.status(403).json({ success: false, message: "You don't work at this shop." });
    }
    // created_at is stored in UTC: the shop's local day, as a UTC range
    const { start: dayStart, end: dayEnd } = shopDayRangeUtc();
    const isHelper = req.user.role === 'helper';

    const rows = await db.prepare(`
      SELECT s.id, s.sale_number, s.created_at, s.grand_total, s.status, s.undone_at, s.sold_by, s.created_by,
             (s.created_at > NOW() - INTERVAL '2 minutes') AS fresh
      FROM sales s
      WHERE s.location_id = ? AND COALESCE(s.sold_by, s.created_by) = ? AND s.created_at >= ? AND s.created_at < ?
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT ${ROLL_LIMIT}
    `).all(locationId, req.user.id, dayStart, dayEnd);

    const ids = rows.map((r) => r.id);
    const ph = ids.map(() => '?').join(',');
    const payRows = ids.length ? await db.prepare(`SELECT sale_id, method, amount FROM payments WHERE sale_id IN (${ph}) ORDER BY id`).all(...ids) : [];
    const itemRows = ids.length ? await db.prepare(`SELECT sale_id, COALESCE(product_name, 'Item') AS name, quantity FROM sale_items WHERE sale_id IN (${ph}) ORDER BY id`).all(...ids) : [];
    const paysBySale = new Map();
    for (const p of payRows) {
      if (!paysBySale.has(p.sale_id)) paysBySale.set(p.sale_id, []);
      paysBySale.get(p.sale_id).push(p);
    }
    const itemsBySale = new Map();
    for (const i of itemRows) {
      if (!itemsBySale.has(i.sale_id)) itemsBySale.set(i.sale_id, []);
      itemsBySale.get(i.sale_id).push(`${i.name} \u00d7 ${Number(i.quantity)}`);
    }

    // Whole-day figures come from their own uncapped query (the list is capped)
    const agg = await db.prepare(`
      SELECT COUNT(DISTINCT s.id) AS count,
             COALESCE(SUM(CASE WHEN p.method = 'cash' THEN p.amount ELSE 0 END), 0) AS cash,
             COALESCE(SUM(CASE WHEN p.method = 'upi' THEN p.amount ELSE 0 END), 0) AS upi
      FROM sales s
      LEFT JOIN payments p ON p.sale_id = s.id
      WHERE s.location_id = ? AND COALESCE(s.sold_by, s.created_by) = ? AND s.created_at >= ? AND s.created_at < ?
        AND s.undone_at IS NULL AND s.status != 'cancelled'
    `).get(locationId, req.user.id, dayStart, dayEnd);
    const count = Number(agg.count);
    const cash = Number(agg.cash);
    const upi = Number(agg.upi);
    const sales = rows.map((r) => {
      const undone = r.undone_at != null;
      const pays = paysBySale.get(r.id) || [];
      return {
        id: r.id,
        sale_number: r.sale_number,
        created_at: r.created_at,
        grand_total: Number(r.grand_total),
        payment_methods: [...new Set(pays.map((p) => p.method))],
        items: itemsBySale.get(r.id) || [],
        status: r.status,
        undone,
        can_undo: isHelper && !undone && r.status !== 'cancelled' && r.fresh === true && Number(r.sold_by) === req.user.id && Number(r.created_by) === req.user.id,
      };
    });

    res.json({ success: true, data: { sales, count, totals: { cash, upi } } });
  } catch (err) { next(err); }
});

module.exports = router;
