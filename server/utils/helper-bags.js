// Helper cash bags (spec 11-12).
//
// In bag mode a helper keeps the cash they take (payments.held_by = helper)
// instead of it going into the register. Their bag, per (staff, location):
//   floats given (float_out.expected_amount)
// + cash payments held by them on sales that were not undone
//   (a refunded and then cancelled sale still counts: its refund was paid
//   from the drawer, so the cash the helper took is still in their bag)
// - amounts settled by handovers (handover_in.settled_amount)
//
// Every function takes the caller's db (async pool, a withTransaction tx, or
// the sync layer: each query result is awaited, so all three work).
const { shopDayRangeUtc } = require('./time');

const toPaise = (n) => Math.round((Number(n) || 0) * 100);
const fromPaise = (p) => p / 100;

// Shop setting helper_cash_mode: 'bag' or 'register' (anything else = register)
async function readCashMode(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'helper_cash_mode'").get();
  return row && String(row.value).trim() === 'bag' ? 'bag' : 'register';
}

// Sales today (shop-local day) sold by this person at this location,
// not counting cancelled or undone ones.
async function salesTodayCount(db, staffId, locationId) {
  const { start, end } = shopDayRangeUtc();
  const row = await db.prepare(`
    SELECT COUNT(*) AS c FROM sales s
    WHERE s.location_id = ? AND COALESCE(s.sold_by, s.created_by) = ?
      AND s.created_at >= ? AND s.created_at < ?
      AND s.status <> 'cancelled' AND s.undone_at IS NULL
  `).get(locationId, staffId, start, end);
  return Number(row && row.c) || 0;
}

async function getBag(db, staffId, locationId) {
  const mv = await db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'float_out' THEN expected_amount ELSE 0 END), 0) AS floats,
      COALESCE(SUM(CASE WHEN type = 'handover_in' THEN settled_amount ELSE 0 END), 0) AS settled
    FROM staff_cash_movements
    WHERE staff_id = ? AND location_id = ?
  `).get(staffId, locationId);
  const cs = await db.prepare(`
    SELECT COALESCE(SUM(p.amount), 0) AS cash_sales
    FROM payments p
    JOIN sales s ON s.id = p.sale_id
    WHERE p.held_by = ? AND p.method = 'cash' AND s.location_id = ?
      AND s.undone_at IS NULL
  `).get(staffId, locationId);

  const floats = toPaise(mv && mv.floats);
  const settled = toPaise(mv && mv.settled);
  const cashSales = toPaise(cs && cs.cash_sales);
  return {
    held: fromPaise(floats + cashSales - settled),
    floats: fromPaise(floats),
    cash_sales: fromPaise(cashSales),
    settled: fromPaise(settled),
    sale_count: await salesTodayCount(db, staffId, locationId),
  };
}

// Every helper at this location whose bag is not zero, or who sold anything
// today. A helper whose access ended (or who was switched off) stays listed
// while their bag is not zero, so their cash can still be collected.
async function listBags(db, locationId) {
  const { start, end } = shopDayRangeUtc();
  const people = await db.prepare(`
    SELECT u.id, u.name, u.is_active, u.access_until
    FROM users u
    WHERE u.id IN (
      SELECT ul.user_id FROM user_locations ul JOIN users h ON h.id = ul.user_id
        WHERE ul.location_id = ? AND h.role = 'helper'
      UNION
      SELECT m.staff_id FROM staff_cash_movements m WHERE m.location_id = ?
      UNION
      SELECT p.held_by FROM payments p JOIN sales s ON s.id = p.sale_id
        WHERE p.held_by IS NOT NULL AND s.location_id = ?
      UNION
      SELECT COALESCE(s.sold_by, s.created_by) FROM sales s JOIN users h ON h.id = COALESCE(s.sold_by, s.created_by)
        WHERE s.location_id = ? AND h.role = 'helper' AND s.created_at >= ? AND s.created_at < ?
    )
    ORDER BY u.name ASC, u.id ASC
  `).all(locationId, locationId, locationId, locationId, start, end);

  const out = [];
  for (const p of people) {
    const bag = await getBag(db, p.id, locationId);
    if (toPaise(bag.held) === 0 && bag.sale_count === 0) continue;
    out.push({
      staff_id: p.id,
      name: p.name,
      is_active: Number(p.is_active) === 1 || p.is_active === true,
      access_until: p.access_until || null,
      held: bag.held,
      sale_count: bag.sale_count,
    });
  }
  return out;
}

// Hidden amount: en-IN grouping with the rupee sign; under 100 every digit
// is x, otherwise the first digit stays and every other digit is x.
// 5234 -> ₹5,xxx · 845 -> ₹8xx · 45 -> ₹xx · 123456 -> ₹1,xx,xxx · 0 -> ₹x
// Paise are dropped (whole rupees only). A negative amount (more handed
// over than expected) is masked the same way with a leading minus sign.
function maskAmount(n) {
  const num = Number(n) || 0;
  const whole = Math.floor(Math.abs(num));
  const sign = num < 0 && whole > 0 ? '-' : '';
  if (whole < 100) return `${sign}₹${String(whole).replace(/\d/g, 'x')}`;
  let first = true;
  const grouped = whole.toLocaleString('en-IN').replace(/\d/g, (d) => {
    if (first) { first = false; return d; }
    return 'x';
  });
  return `${sign}₹${grouped}`;
}

// Serialises everything that changes one helper's bag (undo of a held sale,
// handover, float) for the rest of the caller's transaction. Takes a
// transaction-scoped advisory lock, so it is released on COMMIT or ROLLBACK.
// Must be called inside withTransaction (async layer).
const BAG_LOCK_NAMESPACE = 7301;
async function lockBag(tx, staffId) {
  await tx.prepare('SELECT pg_advisory_xact_lock(?::int, ?::int) AS locked').get(BAG_LOCK_NAMESPACE, Number(staffId));
}

module.exports = { getBag, listBags, maskAmount, readCashMode, lockBag };
