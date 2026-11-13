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

// Same number of days, ending the day before `from` (matches the server's
// previousRange in server/utils/expense-book.js, which the % compares to).
export function previousRange(from, to) {
  const days = Math.round((toUtc(to) - toUtc(from)) / DAY) + 1;
  const prevTo = toUtc(from).getTime() - DAY;
  return { from: toStr(new Date(prevTo - (days - 1) * DAY)), to: toStr(new Date(prevTo)) };
}

// "13 Nov", "9–13 Nov", "28 Oct – 3 Nov", "28 Dec 2025 – 3 Jan 2026".
export function rangeLabel(from, to) {
  const a = toUtc(from);
  const b = toUtc(to || from);
  const day = (d) => d.getUTCDate();
  const mon = (d) => MONTHS[d.getUTCMonth()];
  if (from === (to || from)) return `${day(a)} ${mon(a)}`;
  if (a.getUTCFullYear() !== b.getUTCFullYear()) {
    return `${day(a)} ${mon(a)} ${a.getUTCFullYear()} – ${day(b)} ${mon(b)} ${b.getUTCFullYear()}`;
  }
  if (a.getUTCMonth() === b.getUTCMonth()) return `${day(a)}–${day(b)} ${mon(b)}`;
  return `${day(a)} ${mon(a)} – ${day(b)} ${mon(b)}`;
}

// The period a chip is compared with (owner-approved, 2026-11-13):
//   month       1..D this month  → 1..D last month (D clamped to its last day)
//   last_month  whole month      → the whole month before it
//   week        Mon..today       → last Mon..same weekday
//   today                        → yesterday
//   anything else (Pick dates)   → the same number of days just before
export function comparisonRange(key, from, to) {
  const f = toUtc(from);
  const t = toUtc(to);
  if (key === 'month') {
    const y = f.getUTCFullYear();
    const m = f.getUTCMonth();
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return {
      from: toStr(new Date(Date.UTC(y, m - 1, 1))),
      to: toStr(new Date(Date.UTC(y, m - 1, Math.min(t.getUTCDate(), lastDay)))),
    };
  }
  if (key === 'last_month') {
    const y = f.getUTCFullYear();
    const m = f.getUTCMonth();
    return { from: toStr(new Date(Date.UTC(y, m - 1, 1))), to: toStr(new Date(Date.UTC(y, m, 0))) };
  }
  if (key === 'week') {
    return { from: toStr(new Date(f.getTime() - 7 * DAY)), to: toStr(new Date(t.getTime() - 7 * DAY)) };
  }
  if (key === 'today') {
    const y = toStr(new Date(f.getTime() - DAY));
    return { from: y, to: y };
  }
  return previousRange(from, to);
}
