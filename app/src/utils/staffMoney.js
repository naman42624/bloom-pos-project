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
    return `That would take ${name || 'this person'} over the ${inr(limits.advanceMonth)} monthly advance limit. A manager or owner can confirm with their PIN.`;
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

// ── "Ramesh is back", Shop owes, history (B8, spec 3, 4.4, 4.7, 5.10) ──

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "12 Nov" in the device's local day (the shop's counter device).
export function shortDate(value) {
  if (value == null || value === '') return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

// The card's age label from the server's whole-day count.
export function daysText(days) {
  const n = Math.max(0, Math.round(Number(days) || 0));
  return n === 0 ? 'Today' : n === 1 ? '1 day' : `${n} days`;
}

// "Ramesh is back — what was bought?" (spec 3, verbatim).
export function isBackTitle(name) {
  return `${firstName(name)} is back — what was bought?`;
}

// "Had ₹500 · given 12 Nov by Priya"
export function hadLine(remaining, createdAt, givenByName) {
  const when = shortDate(createdAt);
  const by = givenByName ? ` by ${firstName(givenByName)}` : '';
  return `Had ${inr(remaining)}${when ? ` · given ${when}${by}` : by ? ` · given${by}` : ''}`;
}

// The change box: empty means 0; else rupees with at most 2 decimals; null
// when it is not a number.
export function parseChangeText(text) {
  const t = String(text == null ? '' : text).trim();
  if (t === '') return 0;
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(t)) return null;
  return fromPaise(toPaise(t));
}

// Everything the is-back screen shows and checks, from what the person had
// (left), the bills added and the change box. Same maths as the server's
// settle route (whole paise).
export function isBackSums(left, bills, changeText) {
  const list = Array.isArray(bills) ? bills : [];
  const change = parseChangeText(changeText);
  const afterBills = defaultChange(left, list);
  const over = overspend(left, list);
  let changeError = null;
  if (change === null) changeError = 'format';
  else if (toPaise(change) > toPaise(afterBills)) changeError = 'too_much';
  const still = stillWith(left, list, changeError ? 0 : change);
  const something = list.length > 0 || (change !== null && toPaise(change) > 0);
  return {
    billsTotal: fromPaise(sumPaise(list)),
    afterBills,
    over,
    change: changeError === 'format' ? null : change,
    changeError,
    still,
    canDone: !changeError && something && toPaise(still) === 0,
    canSaveLater: !changeError && something,
  };
}

// The plain message for a Done / Save, rest later tap, or null when it can
// be sent. Same copy as the server (spec 5.10: say what to do).
export function isBackError(name, sums, final) {
  const n = firstName(name);
  if (sums.changeError === 'format') return 'Type the change as an amount, like 200, or 0.';
  if (sums.changeError === 'too_much') return `${n} only has ${inr(sums.afterBills)} left — check the change amount.`;
  if (!sums.canSaveLater) return 'Add what was bought or the change brought back, then tap Done.';
  if (final && toPaise(sums.still) > 0) {
    return `${n} still has ${inr(sums.still)}. Add what was bought or the change back — or tap Save, rest later.`;
  }
  return null;
}

// "Ramesh spent ₹120 extra — the shop owes Ramesh ₹120." (spec 4.4)
export function overspendText(name, over) {
  const n = firstName(name);
  return `${n} spent ${inr(over)} extra — the shop owes ${n} ${inr(over)}.`;
}

// POST /staff-money/:id/settle body. A bill keeps its item id when it was
// picked from the list, else the typed name (the server makes the item).
export function settleBody(bills, sums, method, final) {
  const change = sums.change || 0;
  const body = {
    bills: (Array.isArray(bills) ? bills : []).map((b) => {
      const out = { amount: b.amount };
      if (b.item_id) out.item_id = b.item_id;
      else out.item_name = b.name;
      if (b.category && b.category !== 'salary') out.category = b.category;
      return out;
    }),
    change_back: change,
    final: !!final,
  };
  if (toPaise(change) > 0) body.change_method = method === 'upi' ? 'upi' : 'cash';
  return body;
}

// "+ Add what was bought": the name and the amount, or the first problem.
export function billCheck(name, amountText) {
  if (!String(name || '').trim()) return { error: 'Type what was bought, like Roses.', field: 'name' };
  const amount = parseGiveAmount(amountText);
  if (amount === null) return { error: 'Type how much it cost, like 300.', field: 'amount' };
  return { error: null, amount };
}

// Pay back: the amount typed (pre-filled with what is owed, editable for a
// part payment), checked against what is left.
export function payBackCheck(text, remaining, name) {
  const amount = parseGiveAmount(text);
  if (amount === null) return { error: 'Type an amount above ₹0, like 300.' };
  if (toPaise(amount) > toPaise(remaining)) {
    return { error: `The shop owes ${firstName(name)} only ${inr(remaining)}. Type ${inr(remaining)} or less.` };
  }
  return { error: null, amount };
}

// Show the card only while someone holds shopping money or is owed money.
export function cardHasLines(data) {
  const d = data || {};
  return (Array.isArray(d.shopping) && d.shopping.length > 0) || (Array.isArray(d.owes) && d.owes.length > 0);
}

const HISTORY_STATUS = {
  open: 'Still out', settled: 'Settled', to_salary: 'Taken from pay', removed: 'Removed', written_off: 'Written off',
};
export function historyStatus(status) {
  return HISTORY_STATUS[status] || String(status || '');
}

// Change back's method: Cash while the register is open, else UPI (same
// rule as the add sheet's default; only cash needs the drawer).
export function changeMethodDefault(registerOpen) {
  return registerOpen === false ? 'upi' : 'cash';
}

// "Remove (typed by mistake)" is offered only while nothing on the line is
// accounted for (the server also checks who and when, spec 5.4).
export function canOfferRemove(line) {
  if (!line || line.amount == null) return false;
  return toPaise(line.remaining) > 0 && toPaise(line.remaining) === toPaise(line.amount);
}

// The confirm for Remove: plain words on where the money goes.
export function removeConfirmText(line) {
  const n = firstName(line && line.user_name);
  const amt = inr(line && line.amount);
  return line && line.payment_method === 'upi'
    ? `The ${amt} UPI shopping money given to ${n} is removed. Use this only if it was typed by mistake.`
    : `The ${amt} cash goes back into the drawer and ${n} no longer holds it. Use this only if it was typed by mistake.`;
}

export { inr as rupeesText };

// ── Register lines, close note, My money, settings, payroll (B9) ──

const r2p = (p) => fromPaise(Math.round(p));

// The three staff money lines of one register session (spec 4.6), in the
// order the screen shows them; only lines with money. sign -1 = left the
// drawer, +1 = came into it. Names exact (spec 3, 4.6).
export function registerMoneyLines(session) {
  const s = session || {};
  return [
    { key: 'shopping_out', label: 'Shopping money given', amount: fromPaise(toPaise(s.shopping_out)), sign: -1 },
    { key: 'shopping_in', label: 'Change brought back', amount: fromPaise(toPaise(s.shopping_in)), sign: 1 },
    { key: 'owes_paid', label: 'Shop owes paid back', amount: fromPaise(toPaise(s.owes_paid)), sign: -1 },
  ].filter((l) => toPaise(l.amount) > 0);
}

// Net cash expenses of a closed session, worked back from its expected cash.
// Same terms as the server's computeRegisterClose: expected = opening + cash
// sales - cash refunds - expenses - helper floats + helper handovers -
// shopping money given + change brought back - Shop owes paid back.
export function inferredCashExpenses(session) {
  const s = session || {};
  return r2p(
    toPaise(s.opening_balance) + toPaise(s.total_cash_sales) - toPaise(s.total_refunds_cash)
    - toPaise(s.helper_floats) + toPaise(s.helper_handovers)
    - toPaise(s.shopping_out) + toPaise(s.shopping_in) - toPaise(s.owes_paid)
    - toPaise(s.expected_cash)
  );
}

// Expected cash from the lines (only a fallback: the server sends it).
export function expectedFromLines(s0) {
  const s = s0 || {};
  return r2p(
    toPaise(s.opening_balance) + toPaise(s.total_cash_sales) - toPaise(s.total_refunds_cash)
    - toPaise(s.total_expenses_cash)
    - toPaise(s.helper_floats) + toPaise(s.helper_handovers)
    - toPaise(s.shopping_out) + toPaise(s.shopping_in) - toPaise(s.owes_paid)
  );
}

// The server now sends the per-session cash lines on every session today;
// an older server sent them only on the current register, so copy them onto
// the matching session (same values either way).
const SESSION_LINE_KEYS = ['helper_floats', 'helper_handovers', 'shopping_out', 'shopping_in', 'owes_paid'];
export function withSessionLines(sessions, register) {
  const list = Array.isArray(sessions) ? sessions : [];
  if (!register || register.id == null) return list;
  return list.map((s) => {
    if (!s || Number(s.id) !== Number(register.id)) return s;
    const out = { ...s };
    SESSION_LINE_KEYS.forEach((k) => { if (register[k] != null) out[k] = register[k]; });
    return out;
  });
}

// Close preview's shopping_still_out -> "₹500 still with Ramesh" (spec 4.6;
// information only, closing is not blocked).
export function stillOutLines(stillOut) {
  return (Array.isArray(stillOut) ? stillOut : [])
    .filter((r) => r && toPaise(r.remaining) > 0)
    .map((r) => `${inr(r.remaining)} still with ${firstName(r.user_name)}`);
}

// ── My money (spec 4.5, 5.8): GET /staff-money/mine, own figures only ──
export function myMoneySummary(data) {
  const d = data || {};
  const all = (Array.isArray(d.advances) ? d.advances : []).filter(Boolean);
  // Money given this month: approved or repaid advances. A request still
  // waiting is listed but not counted; shopping money taken from pay is not
  // new money given, so it is listed under its own words.
  const counted = all.filter((a) => a.status !== 'pending' && a.source !== 'shopping_money');
  const monthPaise = counted.reduce((t, a) => t + toPaise(a.amount), 0);
  return {
    advancesMonth: fromPaise(monthPaise),
    advanceRows: all.map((a) => {
      let note = null;
      if (a.status === 'pending') note = 'asked, waiting for OK';
      else if (a.source === 'shopping_money') note = 'shopping money taken from pay';
      else if (a.taken_from_pay) note = 'taken from pay';
      return { id: a.id, text: `${inr(a.amount)} · ${shortDate(a.date)}`, note };
    }),
    advancesUnpaid: fromPaise(toPaise(d.advances_unpaid)),
    shoppingHeld: fromPaise(toPaise(d.shopping_held)),
    owed: fromPaise(toPaise(d.owed)),
  };
}

// ── Owner settings: Settings -> Expenses (spec 4.7, 5.2) ──
export const LIMIT_SETTINGS = [
  { key: 'advance_daily_limit', label: 'Advance limit per person per day', unit: 'rupees', fallback: '500' },
  { key: 'advance_monthly_limit', label: 'Advance limit per person per month', unit: 'rupees', fallback: '2000' },
  { key: 'shopping_money_daily_limit', label: 'Shopping money limit per person per day', unit: 'rupees', fallback: '1000' },
  { key: 'shopping_money_late_days', label: 'Mark shopping money late after (days)', unit: 'days', fallback: '3' },
];

// A whole number of rupees above 0 (limits), or a whole number of days, 1 or
// more (late after). Plain message, or null when it is fine.
export function limitSettingProblem(key, value) {
  const def = LIMIT_SETTINGS.find((s) => s.key === key);
  if (!def) return null;
  const v = String(value == null ? '' : value).trim();
  const ok = /^\d{1,7}$/.test(v) && Number(v) >= 1;
  if (ok) return null;
  return def.unit === 'days'
    ? `${def.label}: type a whole number of days, 1 or more, like 3.`
    : `${def.label}: type a whole amount in rupees, above 0, like ${def.fallback}.`;
}

// ── Payroll: Take from pay (spec 5.6) ──

// "Take ₹500 unsettled shopping money from pay"
export function takeFromPayLabel(total) {
  return `Take ${inr(total)} unsettled shopping money from pay`;
}

// The money part of POST /staff/payroll/disburse. advances_deducted stays
// the pending advances only (the server adds the shopping total itself);
// net_amount has the shopping total already taken off. Unticked (or a 0
// total) = exactly today's body, no take_shopping_money.
export function buildDisburseBody(calc, { take = false, bonus = 0 } = {}) {
  const c = calc || {};
  const pending = toPaise(c.pending_advances);
  const shopping = toPaise(c.open_shopping_money_total);
  const taking = !!take && shopping > 0;
  const net = Math.max(0, toPaise(c.net_amount) + toPaise(bonus) - pending - (taking ? shopping : 0));
  const body = { advances_deducted: fromPaise(pending), net_amount: fromPaise(net) };
  if (taking) body.take_shopping_money = { expected_total: fromPaise(shopping) };
  return body;
}

// The two "tap Calculate again" refusals from disburse (409). Returns the
// server's message, or null for any other error.
const CALC_AGAIN = [
  'Shopping money changed since you calculated — tap Calculate again.',
  "The pay amount doesn't take off the shopping money — tap Calculate again.",
  "The shopping money amount didn't come through right — tap Calculate again.",
];
export function calculateAgainMessage(err) {
  if (!err) return null;
  const msg = String(err.raw_message || err.message || '');
  if ((err.status === 409 || err.status === 400) && CALC_AGAIN.includes(msg)) return msg;
  return null;
}

// ── Deactivate warning (spec 4.7): from GET /staff-money/open of each shop ──
// "Ramesh still has ₹500 shopping money. Settle or write it off first."
export function deactivateWarning(name, userId, openResults) {
  const all = (Array.isArray(openResults) ? openResults : []).filter(Boolean);
  const mine = (rows) => rows.filter((r) => r && Number(r.user_id) === Number(userId));
  const held = all.reduce((t, d) => t + mine(Array.isArray(d.shopping) ? d.shopping : []).reduce((s, r) => s + toPaise(r.remaining), 0), 0);
  const owed = all.reduce((t, d) => t + mine(Array.isArray(d.owes) ? d.owes : []).reduce((s, r) => s + toPaise(r.remaining), 0), 0);
  const n = firstName(name);
  const lines = [];
  if (held > 0) lines.push(`${n} still has ${inr(fromPaise(held))} shopping money. Settle or write it off first.`);
  if (owed > 0) lines.push(`The shop still owes ${n} ${inr(fromPaise(owed))}. Pay it back first.`);
  return lines.length ? lines.join('\n') : null;
}
