// Staff money: limits, running totals, who needs a PIN, approver check.
// Spec 2026-11-14-staff-money-usual-now-design.md sections 5.1, 5.2, 5.10.
// Every function takes the caller's async db handle (pool or money tx).
const { todayStr, shopDayRangeUtc } = require('./time');
const { checkCodeAndPin } = require('./approval-pin');

const toPaise = (n) => Math.round((Number(n) || 0) * 100);
const rupees = (paise) => paise / 100;

const DEFAULT_LIMITS = { advanceDay: 500, advanceMonth: 2000, shoppingDay: 1000, lateDays: 3 };

function err(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  e.statusCode = status;
  Object.assign(e, extra || {});
  return e;
}

async function getLimits(db) {
  const rows = await db.prepare(
    "SELECT key, value FROM settings WHERE key IN ('advance_daily_limit','advance_monthly_limit','shopping_money_daily_limit','shopping_money_late_days')"
  ).all();
  const m = {};
  // An empty or blank value is not 0: Number('') is 0, so keep it missing.
  for (const r of rows) m[r.key] = String(r.value ?? '').trim() === '' ? NaN : Number(r.value);
  // A limit must be a positive number (late days at least 1); anything else
  // falls back to the default rather than making every give need a PIN.
  const pick = (key, dflt, min) => (Number.isFinite(m[key]) && m[key] >= min ? m[key] : dflt);
  return {
    advanceDay: pick('advance_daily_limit', DEFAULT_LIMITS.advanceDay, 0.01),
    advanceMonth: pick('advance_monthly_limit', DEFAULT_LIMITS.advanceMonth, 0.01),
    shoppingDay: pick('shopping_money_daily_limit', DEFAULT_LIMITS.shoppingDay, 0.01),
    lateDays: pick('shopping_money_late_days', DEFAULT_LIMITS.lateDays, 1),
  };
}

// Amount of an open shopping hand-out or advance still to come back, in paise.
function remainingPaise(row) {
  return Math.max(0, toPaise(row.amount) - toPaise(row.settled_amount) - toPaise(row.returned_amount));
}
function remaining(row) { return rupees(remainingPaise(row)); }

// Shop-local day and month figures for one person. Advances count status
// approved or repaid from any source except shopping_money (shopping money
// taken from pay is not new money given that day); shopping counts every
// hand-out not removed.
async function totals(db, { userId }) {
  const today = todayStr();
  const monthStart = `${today.slice(0, 7)}-01`;
  const day = shopDayRangeUtc(today);

  const adv = await db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status IN ('approved','repaid') AND COALESCE(source, '') <> 'shopping_money' AND date = CAST(? AS date) THEN amount ELSE 0 END), 0) AS today,
      COALESCE(SUM(CASE WHEN status IN ('approved','repaid') AND COALESCE(source, '') <> 'shopping_money' AND date >= CAST(? AS date) AND date <= CAST(? AS date) THEN amount ELSE 0 END), 0) AS month,
      COALESCE(SUM(CASE WHEN status = 'approved' THEN amount - COALESCE(repaid_amount, 0) ELSE 0 END), 0) AS unpaid
    FROM salary_advances WHERE user_id = ?
  `).get(today, monthStart, today, userId);

  const shop = await db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status <> 'removed' AND created_at >= CAST(? AS timestamp) AND created_at < CAST(? AS timestamp) THEN amount ELSE 0 END), 0) AS today,
      COALESCE(SUM(CASE WHEN status = 'open' THEN GREATEST(amount - COALESCE(settled_amount, 0) - COALESCE(returned_amount, 0), 0) ELSE 0 END), 0) AS held
    FROM staff_money_out WHERE user_id = ?
  `).get(day.start, day.end, userId);

  const owed = await db.prepare(`
    SELECT COALESCE(SUM(amount - COALESCE(paid_amount, 0)), 0) AS owed
    FROM shop_owes WHERE user_id = ? AND status = 'open'
  `).get(userId);

  return {
    advanceToday: rupees(toPaise(adv.today)),
    advanceMonth: rupees(toPaise(adv.month)),
    shoppingToday: rupees(toPaise(shop.today)),
    advancesUnpaid: rupees(toPaise(adv.unpaid)),
    shoppingHeld: rupees(toPaise(shop.held)),
    owed: rupees(toPaise(owed.owed)),
  };
}

// The person's own monthly advance limit, or null when none is set.
async function personAdvanceLimit(db, userId) {
  const row = await db.prepare('SELECT advance_limit FROM employee_salaries WHERE user_id = ?').get(userId);
  if (!row || row.advance_limit === null || row.advance_limit === undefined) return null;
  const n = Number(row.advance_limit);
  return Number.isFinite(n) ? n : null;
}

// What the counter is told. An advance over the day or month limit is one
// answer, so no limit or amount can be worked out from it. It carries the old
// over_day reason so every app version opens the PIN box; the message (see
// publicMessage) is the generic one.
function isAdvanceOver(reason, kind) {
  return kind === 'advance' && (reason === 'over_day' || reason === 'over_month');
}
function publicReason(reason, kind) {
  return isAdvanceOver(reason, kind) ? 'over_day' : reason;
}
function publicMessage(reason, { limits, kind } = {}) {
  if (isAdvanceOver(reason, kind)) return OVER_LIMIT_MESSAGE;
  return needsPinMessage(reason, { limits, kind });
}

// Pure. giver = { id, role }. Returns null when no PIN is needed, else
// 'self' | 'over_day' | 'over_month'. Self is checked before limits.
function needsPin({ giver, recipientId, kind, amount, totals: t, limits, personLimit }) {
  if (giver.role === 'owner') return null;
  if (Number(giver.id) === Number(recipientId)) return giver.role === 'manager' ? null : 'self';
  const add = toPaise(amount);
  if (kind === 'shopping') {
    return toPaise(t.shoppingToday) + add > toPaise(limits.shoppingDay) ? 'over_day' : null;
  }
  if (toPaise(t.advanceToday) + add > toPaise(limits.advanceDay)) return 'over_day';
  // A personal limit (even 0) replaces the shop monthly limit for this person.
  const monthCap = personLimit === null || personLimit === undefined ? limits.advanceMonth : personLimit;
  if (toPaise(t.advanceMonth) + add > toPaise(monthCap)) return 'over_month';
  return null;
}

const wrongPinMessage = (left) => `That PIN didn't match. ${left} tries left.`;
const OVER_LIMIT_MESSAGE = 'This needs an OK from a manager or the owner. They can confirm with their PIN.';
const CANT_CONFIRM = "That person can't confirm this. Pick a manager or the owner who has an approval PIN.";

// Confirms a manager or owner by PIN. Never call inside a transaction that can
// roll back: the PIN try is recorded and must stay recorded.
async function checkApprover(db, { approverId, pin, locationId, recipientId }) {
  const id = Number(approverId);
  const approver = Number.isInteger(id) && id > 0
    ? await db.prepare('SELECT id, role, is_active, pin_hash, employee_code FROM users WHERE id = ?').get(id)
    : null;
  if (!approver || !Number(approver.is_active) || !['owner', 'manager'].includes(approver.role)
      || !approver.pin_hash || !approver.employee_code) {
    throw err(403, CANT_CONFIRM);
  }
  if (Number(approver.id) === Number(recipientId)) {
    throw err(403, 'A manager or owner needs to confirm money for yourself. Pick someone else to confirm.');
  }
  if (approver.role === 'manager') {
    const link = await db.prepare('SELECT 1 AS ok FROM user_locations WHERE user_id = ? AND location_id = ?').get(approver.id, locationId);
    if (!link) throw err(403, CANT_CONFIRM);
  }
  return checkCodeAndPin(db, approver.employee_code, pin, {
    roles: ['manager', 'owner'],
    wrongPinMessage,
  });
}

// Plain copy for a needs_pin answer (spec 5.10). name is the recipient's first name.
function needsPinMessage(reason, { limits, kind } = {}) {
  const inr = (n) => `₹${Number(n).toLocaleString('en-IN')}`;
  if (reason === 'self') return 'A manager or owner needs to confirm money for yourself.';
  if (reason === 'over_limit') return OVER_LIMIT_MESSAGE;
  return `That's more than the ${inr(limits.shoppingDay)} daily shopping money limit. A manager or owner can confirm with their PIN.`;
}

// Payroll (spec 5.6): the open shopping money payroll may take from pay.
// Only staff with a salary record; riders are never offered it (piece 3
// settles their holdings). forUpdate locks the open lines (inside a money tx).
const PAYROLL_SHOPPING_EXCLUDED_ROLES = ['delivery_partner'];
async function payrollShopping(db, { userId, forUpdate = false }) {
  const user = await db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
  const salary = await db.prepare('SELECT 1 AS ok FROM employee_salaries WHERE user_id = ? LIMIT 1').get(userId);
  if (!user || !salary || PAYROLL_SHOPPING_EXCLUDED_ROLES.includes(user.role)) return { rows: [], totalPaise: 0 };
  const all = await db.prepare(
    `SELECT * FROM staff_money_out WHERE user_id = ? AND status = 'open' ORDER BY id${forUpdate ? ' FOR UPDATE' : ''}`
  ).all(userId);
  const rows = all.filter((r) => remainingPaise(r) > 0);
  return { rows, totalPaise: rows.reduce((t, r) => t + remainingPaise(r), 0) };
}

module.exports = { payrollShopping, getLimits, totals, personAdvanceLimit, publicReason, publicMessage, OVER_LIMIT_MESSAGE, needsPin, needsPinMessage, checkApprover, remaining, remainingPaise, wrongPinMessage };
