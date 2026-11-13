// Pure display helpers for the Expense Book. No React Native imports.
// Dates are 'YYYY-MM-DD' strings; arithmetic is done in UTC so the device
// time zone never shifts a day.
const DAY = 86400000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function toUtc(str) {
  const [y, m, d] = String(str).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function toStr(date) {
  return date.toISOString().slice(0, 10);
}

export function periodRange(key, todayStr) {
  const t = toUtc(todayStr);
  if (key === 'week') {
    const back = (t.getUTCDay() + 6) % 7; // Monday = 0
    return { from: toStr(new Date(t.getTime() - back * DAY)), to: todayStr };
  }
  if (key === 'month') {
    return { from: toStr(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1))), to: todayStr };
  }
  if (key === 'last_month') {
    const first = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 1));
    const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 0));
    return { from: toStr(first), to: toStr(last) };
  }
  return { from: todayStr, to: todayStr };
}

export function changeLabel(pct) {
  if (pct === null || pct === undefined || Number.isNaN(Number(pct))) return { text: 'new', tone: 'new' };
  const n = Math.round(Number(pct));
  if (n === 0) return { text: '—', tone: 'flat' };
  if (n > 0) return { text: `▲ ${n}%`, tone: 'up' };
  return { text: `▼ ${Math.abs(n)}%`, tone: 'down' };
}

export function lastSevenDays(todayStr) {
  const t = toUtc(todayStr);
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(t.getTime() - i * DAY);
    const label = i === 0 ? 'Today' : i === 1 ? 'Yesterday'
      : `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
    out.push({ date: toStr(d), label });
  }
  return out;
}

export function givenToText(row) {
  const name = row && row.given_to_display;
  return name && String(name).trim() ? `given to ${String(name).trim()}` : null;
}
