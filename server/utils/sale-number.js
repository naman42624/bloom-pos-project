/* Sale numbers, INV-<SHOP>-<YYYYMMDD>-<NNN> (moved from routes/sales.js,
 * 2026-11-05, so recurring orders share it). */
const { todayStr: localToday } = require('./time');

async function generateSaleNumber(db, locationId) {
  // Inside a money transaction, one sale number at a time per shop, so two
  // sales saved at the same moment never get the same number.
  if (db.isMoneyTx) await db.prepare('SELECT pg_advisory_xact_lock(?::int, ?::int) AS locked').get(41001, Number(locationId) || 0);
  const loc = await db.prepare('SELECT name FROM locations WHERE id = ?').get(locationId);
  const locCode = loc ? loc.name.replace(/[^A-Za-z]/g, '').substring(0, 4).toUpperCase() : 'XX';
  const today = localToday().replace(/-/g, '');
  const prefix = `INV-${locCode}-${today}`;

  const last = await db.prepare(
    "SELECT sale_number FROM sales WHERE sale_number LIKE ? ORDER BY id DESC LIMIT 1"
  ).get(`${prefix}-%`);

  let seq = 1;
  if (last) {
    const lastNum = parseInt(last.sale_number.split('-').pop(), 10);
    if (!isNaN(lastNum)) seq = lastNum + 1;
  }
  return `${prefix}-${String(seq).padStart(3, '0')}`;
}

module.exports = { generateSaleNumber };
