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

// How an expense was paid, as the list shows it (spec 3, 4.8):
// "Cash", "UPI", "Own pocket · Owner", "Shopping money · Ramesh".
const METHOD_NAMES = { cash: 'Cash', upi: 'UPI', card: 'Card', bank_transfer: 'Bank', own_pocket: 'Own pocket', shopping_money: 'Shopping money' };
export function methodLabel(row) {
  const r = row || {};
  const key = String(r.payment_method || '').toLowerCase();
  if (!key) return '';
  const base = METHOD_NAMES[key] || key.toUpperCase();
  const who = key === 'own_pocket' ? r.paid_by_user_name : key === 'shopping_money' ? r.given_to_display : null;
  return who && String(who).trim() ? `${base} · ${String(who).trim()}` : base;
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

// ── Usual now (add sheet) ──
const METHOD_TEXT = { cash: 'Cash', upi: 'UPI' };
const personOnly = (p) => ({ user_id: p.user_id == null ? null : Number(p.user_id), name: p.name == null ? null : p.name, display_name: p.display_name });
const personKey = (p) => (p.user_id ? `u${Number(p.user_id)}` : `n${String(p.display_name || p.name || '').trim().replace(/\s+/g, ' ').toLowerCase()}`);
const positive = (n) => (n != null && Number(n) > 0 ? Number(n) : null);

// What tapping a suggestion fills (spec §5.7): the most common amount, the
// current user's own last method (else Cash), and the last Given to only when
// that person is clocked in today (a typed name, a vendor, always counts as
// here: the server sends present_today true for it). `me` is { userId }; the
// server already sends only the caller's own method, so no other person's
// method is ever used.
// method is null when the row has no my_last_method field at all (a
// type-ahead row from /suggest?q=): the method is unknown, so the caller keeps
// whatever is chosen now. A Usual now / Often row always has the field (null
// when you never paid for it), which means Cash.
// eslint-disable-next-line no-unused-vars
export function pickDefaults(item, me) {
  const it = item || {};
  const known = Object.prototype.hasOwnProperty.call(it, 'my_last_method');
  const method = !known ? null
    : (it.my_last_method === 'cash' || it.my_last_method === 'upi' ? it.my_last_method : 'cash');
  const p = it.last_given_to;
  return {
    amount: positive(it.common_amount) ?? positive(it.usual_amount),
    method,
    givenTo: p && p.present_today === true ? personOnly(p) : null,
  };
}

// Paid by after a pick: the row's known method, else the current choice.
export function methodAfterPick(current, item) {
  return pickDefaults(item).method || current;
}

// "Cash · Tota Ram": the grey line under a suggestion, exactly what a tap fills.
export function suggestionLine(item) {
  const d = pickDefaults(item);
  const who = d.givenTo ? String(d.givenTo.display_name || d.givenTo.name || '').trim() : '';
  return [METHOD_TEXT[d.method], who].filter(Boolean).join(' · ');
}

// Usual now rows, then Often rows without the ones already shown. An older
// server sends only `data`, shown as Often. Salary items are left out for
// counter staff (they use Salary advance).
export function suggestionSections(res, { hideSalary } = {}) {
  const r = res || {};
  const keep = (rows) => (Array.isArray(rows) ? rows : []).filter((x) => x && !(hideSalary && x.category === 'salary'));
  const hasSections = Array.isArray(r.usual_now) || Array.isArray(r.often);
  const usualNow = hasSections ? keep(r.usual_now) : [];
  const seen = new Set(usualNow.map((x) => Number(x.id)));
  const often = keep(hasSections ? r.often : r.data).filter((x) => !seen.has(Number(x.id)) && seen.add(Number(x.id)));
  return { usualNow, often };
}

// The 3 Given to chips: people last given money on the suggested items (in
// list order), then the shop's people list. The chosen person always shows.
export function recentPeopleChips(items, people, value, max = 3) {
  const out = [];
  const seen = new Set();
  const add = (p) => {
    if (!p || !String(p.display_name || p.name || '').trim()) return;
    const k = personKey(p);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(personOnly(p));
  };
  (Array.isArray(items) ? items : []).forEach((it) => it && add(it.last_given_to));
  (Array.isArray(people) ? people : []).forEach((u) => u && add({ user_id: u.id, name: u.name, display_name: u.name }));
  const chips = out.slice(0, max);
  if (value && String(value.display_name || value.name || '').trim() && !chips.some((c) => personKey(c) === personKey(value))) {
    return [personOnly(value)].concat(chips.slice(0, max - 1));
  }
  return chips;
}

// When a row was saved, for its secondary line. Same day as the expense date:
// "10:42 am". Another day: "saved 13 Nov, 6:05 pm". Shop time (IST) like
// utils/datetime.js; a timestamp with no zone suffix is UTC, as there.
// (Not imported from datetime.js so the plain-node test scripts can load this.)
export function savedTimeLabel(createdAt, expenseDate) {
  if (!createdAt) return '';
  let raw = String(createdAt).trim().replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw) && !/[zZ]$|[+\-]\d{2}:?\d{2}$/.test(raw)) raw += 'Z';
  const d = createdAt instanceof Date ? createdAt : new Date(raw);
  if (Number.isNaN(d.getTime())) return '';
  const tz = 'Asia/Kolkata';
  const time = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz }).toLowerCase();
  const day = d.toLocaleDateString('en-CA', { timeZone: tz });
  const want = String(expenseDate || '').slice(0, 10);
  if (!want || day === want) return time;
  const dm = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: tz });
  return `saved ${dm}, ${time}`;
}
