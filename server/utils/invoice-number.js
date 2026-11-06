/* Invoice and credit note numbers (2026-11-05).
 *
 * One running series per financial year (April to March, shop-local date),
 * either per shop or for all shops (setting invoice_series_mode). A number is
 * taken inside the caller's money transaction: the counter row stays locked
 * until commit, and a rolled-back sale gives its number back, so the series
 * has no gaps and no repeats. Format: PREFIX/2627/0001 (16 characters at most,
 * as GST rules require).
 */
const { todayStr } = require('./time');

const MAX_LEN = 16;

function financialYear(dateObj) {
  const day = todayStr(dateObj || new Date()); // YYYY-MM-DD, shop-local
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  const start = m >= 4 ? y : y - 1;
  return { fy: `${start}-${String((start + 1) % 100).padStart(2, '0')}`, short: `${String(start % 100).padStart(2, '0')}${String((start + 1) % 100).padStart(2, '0')}` };
}

function cleanPrefix(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
}

async function setting(db, key, fallback) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row && row.value != null && row.value !== '' ? row.value : fallback;
}

// kind: 'invoice' | 'credit_note'
async function nextNumber(db, locationId, kind, when) {
  const mode = await setting(db, 'invoice_series_mode', 'shop');
  const { fy, short } = financialYear(when);
  let prefix;
  if (kind === 'credit_note') {
    prefix = cleanPrefix(await setting(db, 'credit_note_prefix', 'CN')) || 'CN';
  } else {
    prefix = cleanPrefix(await setting(db, 'invoice_prefix', 'INV')) || 'INV';
  }
  let seriesKey = `${kind}:all`;
  if (mode !== 'all') {
    const loc = await db.prepare('SELECT invoice_prefix FROM locations WHERE id = ?').get(locationId);
    const own = kind === 'invoice' ? cleanPrefix(loc && loc.invoice_prefix) : '';
    // Shops need different prefixes or two shops would print the same number
    prefix = own || cleanPrefix(`${prefix}${locationId}`);
    seriesKey = `${kind}:loc:${locationId}`;
  }
  if (!db.isMoneyTx) throw new Error('nextNumber must run inside withMoneyTx');
  await db.prepare(`
    INSERT INTO invoice_counters (series_key, fy, last_no) VALUES (?, ?, 1)
    ON CONFLICT (series_key, fy) DO UPDATE SET last_no = invoice_counters.last_no + 1
    RETURNING 1 AS ok
  `).run(seriesKey, fy);
  // Same transaction, row still locked by the write above
  const row = await db.prepare('SELECT last_no FROM invoice_counters WHERE series_key = ? AND fy = ?').get(seriesKey, fy);
  const number = `${prefix}/${short}/${String(row.last_no).padStart(4, '0')}`;
  if (number.length > MAX_LEN) {
    const e = new Error('The invoice prefix is too long. Ask the owner to shorten it in Settings → Bill.');
    e.statusCode = 400;
    throw e;
  }
  return { number, fy };
}

module.exports = { nextNumber, financialYear, cleanPrefix };
