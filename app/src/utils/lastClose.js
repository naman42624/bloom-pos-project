/**
 * Opening cash is pre-filled from the last counted close at the shop, on any
 * day (A9 / D42, 2026-11-07). Used by the Open Register sheet and the Cash
 * Register screen so both fill in the same number and say the same words.
 *
 * Kept free of imports so scripts/test-last-close.js can load it in plain node.
 */

const SHOP_TZ = 'Asia/Kolkata';

// Server timestamps come without a zone ("2026-11-06 13:56:36.61") and are UTC.
function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  let raw = String(value).trim().replace(' ', 'T');
  if (raw.includes('T') && !/[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw)) raw += 'Z';
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function dayKey(date, timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

const money = (n) => Number(n || 0).toFixed(2).replace(/\.00$/, '');

/**
 * From a GET /register/status answer: { amount, closedAt } or null.
 * An older server without last_close falls back to today's closed sessions.
 */
export function lastCloseFromStatus(status) {
  const lc = status && status.last_close;
  if (lc && lc.actual_cash != null && Number.isFinite(Number(lc.actual_cash))) {
    return { amount: Number(lc.actual_cash), closedAt: lc.closed_at || null };
  }
  const today = ((status && status.todaySessions) || []).find((s) => s.closed_at && s.actual_cash != null);
  return today ? { amount: Number(today.actual_cash), closedAt: today.closed_at } : null;
}

/** The text field's starting value: "2000", "1250.5", or '' when there is none. */
export function lastCloseCashText(last) {
  return last ? money(last.amount) : '';
}

/** "today" / "yesterday" / "on 4 Nov" in the shop's time zone. */
export function closeDayWords(closedAt, now = new Date(), timezone = SHOP_TZ) {
  const d = toDate(closedAt);
  if (!d) return '';
  const key = dayKey(d, timezone);
  if (key === dayKey(now, timezone)) return 'today';
  if (key === dayKey(new Date(now.getTime() - 86400000), timezone)) return 'yesterday';
  return `on ${new Intl.DateTimeFormat('en-IN', { timeZone: timezone, day: 'numeric', month: 'short' }).format(d)}`;
}

/** The line under the field. */
export function lastCloseHint(last, now = new Date(), timezone = SHOP_TZ) {
  if (!last) return '';
  const when = closeDayWords(last.closedAt, now, timezone);
  return `Filled in from the last close${when ? ` ${when}` : ''} (₹${money(last.amount)}). Change it if the drawer has a different amount.`;
}
