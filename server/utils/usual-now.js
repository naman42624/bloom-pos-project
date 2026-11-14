// Usual now / Often ranking for the Expense Book quick-pick chips.
// Pure functions: no database, no clock. Times are "shop-local wall clock"
// Dates, meaning a Date whose UTC fields hold the shop's local date and time
// (see toShopLocal). Spec: staff money and Usual now design, section 5.7.

const CHAIN_GAP_MIN = 120;
const MIN_SLOT_COUNT = 3;
const BEFORE_MIN = 60;
const AFTER_MIN = 120;
const GAP_FACTOR = 0.8;
const MAX_USUAL = 3;
const MAX_TOTAL = 8;
const DAY_MS = 86400000;

// Real instant -> Date whose getUTC* fields are the wall clock in timeZone.
function toShopLocal(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date);
  const p = {};
  parts.forEach((x) => { p[x.type] = Number(x.value); });
  return new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second));
}

const minutesOf = (d) => d.getUTCHours() * 60 + d.getUTCMinutes();
const dayNumber = (d) => Math.floor(d.getTime() / DAY_MS);

// Entries within 120 minutes of the previous one chain into one slot.
// Input: minutes since local midnight. Slots with fewer than 3 are dropped.
function findSlots(localMinutes) {
  const sorted = (localMinutes || []).filter((m) => Number.isFinite(m)).sort((a, b) => a - b);
  const slots = [];
  let cur = null;
  for (const m of sorted) {
    if (cur && m - cur.end <= CHAIN_GAP_MIN) { cur.end = m; cur.count += 1; }
    else { cur = { start: m, end: m, count: 1 }; slots.push(cur); }
  }
  return slots.filter((s) => s.count >= MIN_SLOT_COUNT);
}

// Most common amount; a tie goes to the one used most recently.
function commonAmount(entries) {
  const list = (entries || []).filter((e) => e && Number.isFinite(Number(e.amount)));
  if (!list.length) return null;
  const stats = new Map();
  for (const e of list) {
    const k = Number(e.amount);
    const t = e.at instanceof Date ? e.at.getTime() : 0;
    const s = stats.get(k) || { count: 0, last: -Infinity };
    s.count += 1;
    if (t >= s.last) s.last = t;
    stats.set(k, s);
  }
  let best = null;
  for (const [amount, s] of stats) {
    if (!best || s.count > best.count || (s.count === best.count && s.last > best.last)) best = { amount, ...s };
  }
  return best.amount;
}

function median(nums) {
  const a = nums.slice().sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function isUsualNow(entries, nowLocal) {
  const slots = findSlots(entries.map((e) => minutesOf(e.at)));
  if (!slots.length) return false;
  const nowMin = minutesOf(nowLocal);
  const today = dayNumber(nowLocal);
  const todayMins = entries.filter((e) => dayNumber(e.at) === today).map((e) => minutesOf(e.at));

  const slotOk = slots.some((s) => {
    const lo = s.start - BEFORE_MIN;
    const hi = s.end + AFTER_MIN;
    if (nowMin < lo || nowMin > hi) return false;
    return !todayMins.some((m) => m >= lo && m <= hi);
  });
  if (!slotOk) return false;

  const days = [...new Set(entries.map((e) => dayNumber(e.at)))].sort((a, b) => a - b);
  if (days.length < 2) return true;
  const gaps = [];
  for (let i = 1; i < days.length; i += 1) gaps.push(days[i] - days[i - 1]);
  const gap = median(gaps);
  if (gap <= 1) return true;
  return (today - days[days.length - 1]) >= GAP_FACTOR * gap;
}

function rankSuggestions(items, nowLocal) {
  const nowMs = nowLocal.getTime();
  const usual = [];
  const rest = [];
  for (const item of items || []) {
    const entries = item.entries || [];
    const recent = entries.some((e) => nowMs - e.at.getTime() >= 0 && nowMs - e.at.getTime() < CHAIN_GAP_MIN * 60000);
    if (recent) continue; // added in the last 2 hours: in neither list
    if (isUsualNow(entries, nowLocal)) usual.push(item); else rest.push(item);
  }
  const byUse = (a, b) => (b.uses30 || 0) - (a.uses30 || 0);
  usual.sort(byUse);
  const usual_now = usual.slice(0, MAX_USUAL);
  const overflow = usual.slice(MAX_USUAL); // usual but beyond the 3 cap: still eligible for Often
  const pool = rest.concat(overflow);
  const pinned = pool.filter((i) => i.pinned).sort((a, b) => {
    const ao = a.pin_order == null ? Infinity : a.pin_order;
    const bo = b.pin_order == null ? Infinity : b.pin_order;
    return ao - bo || byUse(a, b);
  });
  const unpinned = pool.filter((i) => !i.pinned).sort(byUse);
  const often = pinned.concat(unpinned).slice(0, MAX_TOTAL - usual_now.length);
  return { usual_now, often };
}

module.exports = { findSlots, commonAmount, rankSuggestions, toShopLocal, isUsualNow };
