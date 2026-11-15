// Pure helpers for the rider km account (Km reading form, account view).
const trim1 = (n) => String(Math.round(Number(n) * 10) / 10);

// Arriving and Going home alternate; start on Arriving.
export function suggestKind(lastReading) {
  if (!lastReading) return 'arrive';
  return lastReading.kind === 'arrive' ? 'leave' : 'arrive';
}

// Shown under the meter: the work done since the last Arriving reading.
export function workKmText(lastReading, meter) {
  if (!lastReading || lastReading.kind !== 'arrive') return null;
  if (meter === '' || meter === null || meter === undefined) return null;
  const m = Number(meter);
  const last = Number(lastReading.meter);
  if (!Number.isFinite(m) || !Number.isFinite(last) || m <= last) return null;
  return `→ ${trim1(m - last)} km of work`;
}

export function stretchLabel(stretch) {
  const s = stretch || {};
  const km = trim1(s.km || 0);
  if (s.kind === 'home') return `Home ride ${km} km (not paid)`;
  if (s.kind === 'typed') return `${km} km (typed)`;
  if (s.kind === 'gap') {
    if (!s.answer) return `Gap ${km} km — answer`;
    if (s.answer.answer === 'typed') return `Gap ${km} km · ${trim1(s.answer.work_km || 0)} km work`;
    return `Gap ${km} km · no work`;
  }
  return `${km} km`;
}

const rupees = (paise) => `₹${(Math.abs(Number(paise) || 0) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

// "₹336"; signed adds "−" for a negative amount ("−₹200").
export function moneyText(paise, signed = false) {
  return `${signed && Number(paise) < 0 ? '−' : ''}${rupees(paise)}`;
}

export function netText(name, paise) {
  const p = Number(paise) || 0;
  if (p > 0) return `Shop pays ${name} ${rupees(p)}`;
  if (p < 0) return `${name} owes ${rupees(p)}`;
  return 'Nothing to pay';
}

// "9:12 am" for a "YYYY-MM-DD HH:MM:SS" shop-local string.
export function clockText(readAt) {
  const m = /(\d{1,2}):(\d{2})/.exec(String(readAt || '').split(/[ T]/)[1] || '');
  if (!m) return '';
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h >= 12 ? 'pm' : 'am'}`;
}

const pad2 = (n) => String(n).padStart(2, '0');
const dateOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const dateTimeOf = (d) => `${dateOf(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

// A picked time can never be later than now (the server refuses the future).
export function clampToNow(picked, now = new Date()) {
  return picked.getTime() > now.getTime() ? new Date(now.getTime()) : picked;
}

// The read_at to send, or undefined to let the server stamp now.
// Typed km: today -> undefined; an earlier day -> noon. Meter: the picked
// date and time, held back to now.
export function readAtFor({ typedMode, when, now = new Date() }) {
  if (!when) return undefined;
  if (typedMode) return dateOf(when) === dateOf(now) ? undefined : `${dateOf(when)} 12:00`;
  return dateTimeOf(clampToNow(when, now));
}

// ─── Rider km screen: settle sheet, money card, history ──────
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SHOP_TZ = 'Asia/Kolkata';

// "10 Nov" for a shop-local "YYYY-MM-DD[ HH:MM:SS]".
export function dayLabel(local) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(local || ''));
  if (!m) return '';
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}`;
}

// "12–14 Nov", "12 Nov", or "31 Oct – 2 Nov" for two shop-local times.
export function rangeLabel(fromLocal, toLocal) {
  const a = String(fromLocal || '').slice(0, 10);
  const b = String(toLocal || '').slice(0, 10);
  if (!a || a === b) return dayLabel(b || a);
  if (a.slice(0, 7) === b.slice(0, 7)) return `${Number(a.slice(8, 10))}–${dayLabel(b)}`;
  return `${dayLabel(a)} – ${dayLabel(b)}`;
}

// A server created_at (an instant) as the shop day, "8 Nov".
export function shopDayOf(instant) {
  const d = new Date(instant);
  if (Number.isNaN(d.getTime())) return '';
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone: SHOP_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)) parts[p.type] = p.value;
  return dayLabel(`${parts.year}-${parts.month}-${parts.day}`);
}

// Settle sheet day lines: "10 Nov  46 km", "11 Nov  66 km (2 trips)".
export function settleDays(lines) {
  return ((lines && lines.stretches_by_day) || [])
    .filter((d) => Number(d.paid_km) > 0)
    .map((d) => {
      const trips = (d.stretches || []).filter((s) => Number(s.paid_km) > 0).length;
      return { date: d.date, label: dayLabel(d.date), text: `${trim1(d.paid_km)} km${trips > 1 ? ` (${trips} trips)` : ''}` };
    });
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Settle sheet money lines (spec 9 sketch), each { key, label, paise } with
// paise signed as it moves the total. Lines that are 0 are left out.
export function settleMoneyLines(lines, name) {
  const l = lines || {};
  const out = [];
  for (const g of l.by_rate || []) {
    out.push({ key: `rate${g.rate}`, label: `${trim1(g.km)} km × ₹${trim1(g.rate)}`, paise: Number(g.amount_paise) || 0 });
  }
  if (Number(l.petrol_taken_paise)) {
    out.push({ key: 'petrol', label: `Petrol taken (${(l.petrol || []).length})`, paise: -Number(l.petrol_taken_paise) });
  }
  if (Number(l.carried_in_paise)) out.push({ key: 'carry', label: 'Carried from last time', paise: Number(l.carried_in_paise) });
  if (Number(l.supply_held_paise)) out.push({ key: 'supply', label: `Supply money with ${name}`, paise: -Number(l.supply_held_paise) });
  if (Number(l.cod_held_paise)) {
    const n = (l.cod || []).filter((d) => Number(d.cash_paise) > 0 || d.own_upi).length;
    out.push({ key: 'cod', label: `COD with ${name} (${plural(n, 'order', 'orders')})`, paise: -Number(l.cod_held_paise) });
  }
  return out;
}

// COD orders that have a UPI part: each gets a "Paid to {Name}'s own UPI" switch.
export function upiCodOrders(lines) {
  return ((lines && lines.cod) || []).filter((d) => Number(d.upi_paise) > 0);
}

// The buttons by the sign of the net (Task 3 actions table).
export function settleChoices(net, name, { owner = false } = {}) {
  const n = Number(net) || 0;
  if (n > 0) {
    return { primary: { action: 'pay', label: `Pay ${name} ${rupees(n)}` }, carry: `Carry ${rupees(n)} to next time`, take: null, salary: owner ? 'Take from salary' : null };
  }
  if (n < 0) {
    return { primary: { action: 'carry', label: `Carry ${rupees(n)} to next time` }, carry: null, take: 'Take some now', salary: owner ? 'Take from salary' : null };
  }
  return { primary: { action: 'zero', label: 'Settle' }, carry: null, take: null, salary: null };
}

const METHOD_WORDS = { cash: 'Cash', upi: 'UPI' };
const amountWords = (amount) => `₹${String(amount || '0').trim()}`;

export function moveButtonLabel(action, name, amount, method) {
  const m = METHOD_WORDS[method] || '';
  return action === 'pay'
    ? `Pay ${name} ${amountWords(amount)} (${m})`
    : `Take ${amountWords(amount)} from ${name} (${m})`;
}

// null when the typed amount is 0.01 up to |net|; else the plain error.
export function checkMoveAmount(text, net) {
  const max = Math.abs(Number(net) || 0);
  const msg = `Type an amount from ₹0.01 to ${rupees(max)}.`;
  const t = String(text || '').trim();
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(t)) return msg;
  const p = Math.round(Number(t) * 100);
  return p >= 1 && p <= max ? null : msg;
}

// Money card line: "L · 142 km · L owes ₹414" or "· Gaps to answer".
export function riderCardLine(r) {
  const head = `${r.name} · ${trim1(r.unsettled_km || 0)} km`;
  if (Number(r.gaps) > 0 || r.balance_paise === null || r.balance_paise === undefined) return `${head} · Gaps to answer`;
  return `${head} · ${netText(r.name, r.balance_paise)}`;
}

// Riders shown on the money card: those with readings.
export function cardRiders(list) {
  return (list || []).filter((r) => r.has_account === true);
}

// Past settlements on the rider screen (amounts in rupees, from the account view).
export function pastSettlementText(h) {
  const head = `${shopDayOf(h.created_at)} · ${trim1(h.paid_km || 0)} km`;
  const paise = (rs) => Math.round((Number(rs) || 0) * 100);
  const m = METHOD_WORDS[h.moved_method];
  if (h.for_salary || h.action === 'salary') return `${head} · taken at payroll`;
  if (h.action === 'pay') return `${head} · paid ${rupees(paise(h.moved_amount))}${m ? ` (${m})` : ''}`;
  if (h.action === 'take') return `${head} · took ${rupees(paise(h.moved_amount))}${m ? ` (${m})` : ''}`;
  if (h.action === 'carry') return `${head} · carried ${moneyText(paise(h.carry_out), true)}`;
  return `${head} · settled`;
}

// Settlements history line for a km settlement.
export function kmHistoryLine(row) {
  return `Km · ${row.rider_name} · ${trim1(row.paid_km || 0)} km · COD ${rupees(row.cod_held_paise)}`;
}

// Delivery settlements and km settlements in one list, newest first by the
// row's created_at (both are server timestamps of the same kind).
export function mergeSettlementHistory(deliveryRows, kmRows) {
  const t = (x) => { const v = Date.parse(x.created_at); return Number.isNaN(v) ? 0 : v; };
  return [
    ...(deliveryRows || []).map((x) => ({ kind: 'delivery', key: `d${x.id}`, at: t(x), item: x })),
    ...(kmRows || []).map((x) => ({ kind: 'km', key: `km${x.id}`, at: t(x), item: x })),
  ].sort((a, b) => b.at - a.at);
}

// The own-UPI picks still on the sheet: an order settled elsewhere drops out
// of the preview, and a pick left behind would make every commit CHANGED.
export function trimUpiOwn(ids, lines) {
  const onSheet = new Set(upiCodOrders(lines).map((d) => Number(d.delivery_id)));
  return (ids || []).filter((id) => onSheet.has(Number(id)));
}

// Counter staff may add or change readings back to 7 days before the shop
// day (server minBackDate); today is "YYYY-MM-DD".
export function withinBackDays(local, today, days = 7) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(today || ''));
  if (!m) return true;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() - days);
  return String(local || '').slice(0, 10) >= d.toISOString().slice(0, 10);
}

// The server's change/remove rule: owner and manager any unsettled reading;
// others only their own, within the last 7 days.
export function canChangeReading(reading, { role, userId, today }) {
  if (role === 'owner' || role === 'manager') return true;
  if (!reading || reading.created_by == null || Number(reading.created_by) !== Number(userId)) return false;
  return withinBackDays(reading.read_at, today);
}

// Today's shop date, "YYYY-MM-DD".
export function shopToday(now = new Date()) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone: SHOP_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day}`;
}
