const { todayStr } = require('./time');

// Normalises a DATE value (text from psql, or a JS Date from pg) to YYYY-MM-DD.
function normaliseDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const p = (n) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(value.getDate())}`;
  }
  const m = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// The shop local date (Asia/Kolkata unless the timezone setting says otherwise).
function localToday() {
  return todayStr();
}

// True only when the last day of access is before today. On the last day itself
// access still works, and ends at local midnight after it.
function isAccessExpired(accessUntil, today = localToday()) {
  const until = normaliseDate(accessUntil);
  const now = normaliseDate(today);
  if (!until || !now) return false;
  return until < now;
}

// "15 Nov" - day and short month, no year.
function formatAccessDate(accessUntil) {
  const iso = normaliseDate(accessUntil);
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function expiredMessage(accessUntil) {
  return `Your access ended on ${formatAccessDate(accessUntil)}. Ask the owner if you need more days.`;
}

module.exports = { isAccessExpired, normaliseDate, localToday, formatAccessDate, expiredMessage };
