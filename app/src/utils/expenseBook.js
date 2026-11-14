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

// '2026-11' → 'Nov'; adds the year when it is not the year of `todayStr`
// ('Dec 2025'), so a strip that crosses a new year stays clear.
export function monthLabel(key, todayStr) {
  const [y, m] = String(key).split('-').map(Number);
  if (!y || !m) return '';
  const thisYear = todayStr ? Number(String(todayStr).slice(0, 4)) : y;
  return y === thisYear ? MONTHS[m - 1] : `${MONTHS[m - 1]} ${y}`;
}

// The whole of month '2026-10' as a range, ending today for the current month.
export function monthRange(key, todayStr) {
  const [y, m] = String(key).split('-').map(Number);
  const from = toStr(new Date(Date.UTC(y, m - 1, 1)));
  let to = toStr(new Date(Date.UTC(y, m, 0)));
  if (todayStr && to > todayStr) to = todayStr;
  return { from, to };
}

// Pinned list helpers for the owner's Expense items screen. Each returns a
// new array of ids, which is sent whole to PUT /expenses/items/pins.
export function movePin(ids, index, dir) {
  const j = index + dir;
  if (index < 0 || index >= ids.length || j < 0 || j >= ids.length) return ids.slice();
  const next = ids.slice();
  [next[index], next[j]] = [next[j], next[index]];
  return next;
}
export function unpin(ids, id) {
  return ids.filter((x) => Number(x) !== Number(id));
}
export function addPin(ids, id) {
  return ids.some((x) => Number(x) === Number(id)) ? ids.slice() : ids.concat(Number(id));
}

// "1 entry" / "12 entries".
export function entriesText(n) {
  const c = Number(n) || 0;
  return `${c} ${c === 1 ? 'entry' : 'entries'}`;
}

// The merge confirm (owner): names both items and how many entries move.
export function mergeConfirmText(fromName, intoName, count) {
  return `Move ${entriesText(count)} from "${fromName}" into "${intoName}"? "${fromName}" will be hidden.`;
}
