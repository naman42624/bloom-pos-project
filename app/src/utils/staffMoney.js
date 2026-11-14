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
