// Date helpers for helper accounts (Add helper, the staff list tag, the
// join-code expiry line). access_until is a plain 'YYYY-MM-DD' shop date;
// the helper can work all of that day.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad(n) {
  return String(n).padStart(2, '0');
}

// 'YYYY-MM-DD' + n days, done on the calendar date (no time zone drift).
export function addDaysStr(dateStr, days) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

// 'YYYY-MM-DD' → a local Date at midnight (for the date picker).
export function dateStrToDate(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return new Date(y, m - 1, d);
}

// A picker Date → 'YYYY-MM-DD' from its own calendar fields.
export function dateToDateStr(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// '2026-11-15' → '15 Nov'
export function formatDayMonth(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || ''));
  if (!m) return '';
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}`;
}

// '2026-11-15' → 'Sun 15 Nov'
export function formatWeekdayDayMonth(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || ''));
  if (!m) return '';
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const wd = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
  return `${days[wd]} ${formatDayMonth(dateStr)}`;
}

// Staff list tag: 'Helper · until 15 Nov', or 'Helper · ended 2 Nov' once
// the last day has passed (the last day itself still counts).
export function helperTag(accessUntil, todayStr) {
  const label = formatDayMonth(accessUntil);
  if (!label) return { text: 'Helper', ended: false };
  const ended = String(accessUntil).slice(0, 10) < todayStr;
  return { text: `Helper · ${ended ? 'ended' : 'until'} ${label}`, ended };
}

// A server timestamp → '5 Nov, 3:40 pm' in the shop's time zone.
export function formatShopDateTime(value, timezone) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-IN', {
      timeZone: timezone || 'Asia/Kolkata',
      day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
    }).formatToParts(d);
    const get = (t) => (parts.find((p) => p.type === t) || {}).value || '';
    return `${get('day')} ${get('month')}, ${get('hour')}:${get('minute')} ${get('dayPeriod').toLowerCase()}`;
  } catch (e) {
    return d.toLocaleString();
  }
}
