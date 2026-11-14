// Pure helpers for Salary advance / Shopping money (spec 3, 4.2, 4.4, 5.2,
// 5.10). No React Native imports, so scripts/test-staff-money.js runs in
// plain node. All money maths is in whole paise.

const toPaise = (n) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 100) : 0;
};
const fromPaise = (p) => p / 100;
const sumPaise = (bills) =>
  (Array.isArray(bills) ? bills : []).reduce((t, b) => t + toPaise(b && typeof b === 'object' ? b.amount : b), 0);
const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

// What the person had (left) minus the bills added so far; negative = overspent.
const leftAfterBillsPaise = (left, bills) => toPaise(left) - sumPaise(bills);

// "Change back" pre-fill: what is left after the bills, never below 0.
export function defaultChange(left, bills) {
  return fromPaise(Math.max(0, leftAfterBillsPaise(left, bills)));
}

// Bills more than they had: how much of their own money they spent (>= 0).
export function overspend(left, bills) {
  return fromPaise(Math.max(0, -leftAfterBillsPaise(left, bills)));
}

// "Still with Ramesh": what is neither billed nor handed back. Never below 0.
export function stillWith(left, bills, change) {
  return fromPaise(Math.max(0, leftAfterBillsPaise(left, bills) - toPaise(change)));
}

const localDay = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());

// The age label on the "Shopping money out" card. Whole calendar days (the
// same count the server's `days` uses); late = strictly more than lateDays
// (server: days > shopping_money_late_days, default 3). The server also sends
// `days` and `late` on each line, so prefer those; this is for a label built
// from created_at alone.
export function heldLabel(createdAt, now = new Date(), lateDays = 3) {
  const from = new Date(createdAt);
  const to = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return { days: 0, text: 'Today', late: false };
  const days = Math.max(0, Math.round((localDay(to) - localDay(from)) / 86400000));
  const text = days === 0 ? 'Today' : days === 1 ? '1 day' : `${days} days`;
  return { days, text, late: days > Number(lateDays) };
}

// Plain copy for a 409 needs_pin answer (spec 5.10). limits is
// { advanceDay, advanceMonth, shoppingDay }; kind is 'advance' (default) or
// 'shopping'. Same wording as the server's message, so the box can show its
// own copy when the thrown error carries none.
export function pinMessage(needsPin, { limits = {}, name, kind = 'advance' } = {}) {
  if (needsPin === 'self') return 'A manager or owner needs to confirm money for yourself.';
  if (needsPin === 'over_month') {
    return `${name || 'This person'} has had ${inr(limits.advanceMonth)} in advances this month — the monthly limit. A manager or owner can confirm with their PIN.`;
  }
  const lim = kind === 'shopping' ? limits.shoppingDay : limits.advanceDay;
  return `That's more than the ${inr(lim)} daily ${kind === 'shopping' ? 'shopping money' : 'advance'} limit. A manager or owner can confirm with their PIN.`;
}

// The needs_pin reason from a thrown api error (409 body), or null.
export function needsPinOf(err) {
  const r = err && err.status === 409 && err.body ? err.body.needs_pin : null;
  return ['over_day', 'over_month', 'self'].includes(r) ? r : null;
}

// ── The add sheet: Salary advance, Shopping money, Own pocket (B7) ──

// "Ramesh Kumar" -> "Ramesh" (the server's copy uses first names too).
export function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || 'This person';
}

// Typed "advance" or "shopping" in "What was it for?" offers the matching
// link first (spec 4.1). Three letters or more; a word of the text may start
// the keyword ("adv", "shop") or contain it ("salary advance"). Counter staff
// (hideSalary) typing "salary" are pointed to Salary advance too.
export function moneyLinksFor(text, { hideSalary = false } = {}) {
  const words = String(text || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (kw) => words.some((w) => w.length >= 3 && (kw.startsWith(w) || w.startsWith(kw)));
  const out = [];
  if (hit('advance') || (hideSalary && hit('salary'))) out.push('advance');
  if (hit('shopping')) out.push('shopping');
  return out;
}

const chip = (p, meId) => ({
  id: Number(p.id), name: p.name, me: Number(p.id) === Number(meId),
  label: Number(p.id) === Number(meId) ? 'Me' : p.name,
});

// Who (Salary advance / Shopping money): the people list comes recent first
// from GET /staff-money/people. Up to `max` others, then Me when the caller
// can receive money (is in the list). A person picked under More shows first.
export function whoChips(people, meId, chosenId, max = 3) {
  const list = Array.isArray(people) ? people.filter(Boolean) : [];
  const others = list.filter((p) => Number(p.id) !== Number(meId));
  let shown = others.slice(0, max);
  const chosen = chosenId != null && others.find((p) => Number(p.id) === Number(chosenId));
  if (chosen && !shown.some((p) => Number(p.id) === Number(chosenId))) {
    shown = [chosen].concat(shown.slice(0, max - 1));
  }
  const out = shown.map((p) => chip(p, meId));
  const me = list.find((p) => Number(p.id) === Number(meId));
  if (me) out.push(chip(me, meId));
  return out;
}

// Whose? (Own pocket): Me first (the default), then others. Me shows even
// before the list loads. A person picked under More shows next to Me.
export function whoseChips(people, meId, chosenId, max = 3) {
  const list = Array.isArray(people) ? people.filter(Boolean) : [];
  const others = list.filter((p) => Number(p.id) !== Number(meId));
  let shown = others.slice(0, max - 1);
  const chosen = chosenId != null && Number(chosenId) !== Number(meId)
    && others.find((p) => Number(p.id) === Number(chosenId));
  if (chosen && !shown.some((p) => Number(p.id) === Number(chosenId))) {
    shown = [chosen].concat(shown.slice(0, max - 2));
  }
  return [{ id: Number(meId), name: 'Me', me: true, label: 'Me' }].concat(shown.map((p) => chip(p, meId)));
}

// Advances not yet taken from pay, from GET /attendance/salary-advances rows
// (same sum as the server's totals().advancesUnpaid: approved only).
export function unpaidAdvances(rows, userId) {
  const p = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && r.status === 'approved' && Number(r.user_id) === Number(userId))
    .reduce((t, r) => t + toPaise(r.amount) - toPaise(r.repaid_amount), 0);
  return fromPaise(Math.max(0, p));
}

// Shopping money a person holds, from GET /staff-money/open's `shopping`
// lines (oldest first): the total and the oldest line's id (for "is back").
export function heldBy(openShopping, userId) {
  const mine = (Array.isArray(openShopping) ? openShopping : [])
    .filter((r) => r && Number(r.user_id) === Number(userId) && toPaise(r.remaining) > 0);
  return {
    amount: fromPaise(mine.reduce((t, r) => t + toPaise(r.remaining), 0)),
    id: mine.length ? Number(mine[0].id) : null,
  };
}

// The grey line under Note (spec 4.2). null when there is nothing to say.
export function moneyLine(kind, name, amount, { me = false } = {}) {
  if (!(toPaise(amount) > 0)) return null;
  const who = me ? 'You' : firstName(name);
  if (kind === 'shopping') return `${who} still ${me ? 'have' : 'has'} ${inr(amount)} shopping money`;
  return `${who}: ${inr(amount)} in advances not yet taken from pay`;
}

// Given to a person who holds shopping money (spec 4.1).
export function isBackHint(name, amount) {
  if (!(toPaise(amount) > 0)) return null;
  const n = firstName(name);
  return `${n} has ${inr(amount)} shopping money — ${n} is back?`;
}

// The amount box: rupees with at most 2 decimals, above 0 (same rule as the
// server's parseMoney), else null.
export function parseGiveAmount(text) {
  const t = String(text == null ? '' : text).trim();
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(t)) return null;
  const p = toPaise(t);
  return p > 0 ? fromPaise(p) : null;
}
