/**
 * Expense book helpers: period maths and the shared list-row SQL.
 * All dates are plain YYYY-MM-DD strings (shop-local); no time zone is
 * applied here, so day arithmetic is done in UTC on the date parts only.
 */

const DAY_MS = 86400000;

function parseDay(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function fmtDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Same number of days, ending the day before `from`. */
function previousRange(from, to) {
  const days = Math.round((parseDay(to) - parseDay(from)) / DAY_MS) + 1;
  const prevTo = parseDay(from) - DAY_MS;
  return { from: fmtDay(prevTo - (days - 1) * DAY_MS), to: fmtDay(prevTo) };
}

/** Percent change to 1 decimal; null when there is no previous amount. */
function changePct(amount, previous) {
  if (!previous) return null;
  return Math.round(((amount - previous) / previous) * 1000) / 10;
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Month keys (YYYY-MM) for the `count` months ending at the month of `today`. */
function lastMonths(today, count) {
  let y = Number(today.slice(0, 4));
  let m = Number(today.slice(5, 7));
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.unshift(`${y}-${String(m).padStart(2, '0')}`);
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  return out;
}

// Returns are money back, so they subtract.
const SIGNED_AMOUNT = 'CASE WHEN e.is_return <> 0 THEN -e.amount ELSE e.amount END';

// Shared by the list route and item history, so both return the same row shape.
const EXPENSE_ROW_SELECT = `
      SELECT e.*, l.name as location_name, u.name as created_by_name,
             ei.name as item_name, gu.name as given_to_user_name,
             cr.opening_time as register_opened_at, cr.opened_at as register_opened_at_fallback,
             cr.closed_at as register_closed_at
      FROM expenses e
      JOIN locations l ON e.location_id = l.id
      JOIN users u ON e.created_by = u.id
      LEFT JOIN expense_items ei ON ei.id = e.item_id
      LEFT JOIN users gu ON gu.id = e.given_to_user_id
      LEFT JOIN cash_registers cr ON cr.id = e.register_id
`;

function normalizeExpenseRow(expense) {
  const { register_opened_at_fallback, given_to_user_name, ...rest } = expense;
  return {
    ...rest,
    amount: Number(expense.amount) || 0,
    is_return: !!expense.is_return,
    register_opened_at: expense.register_opened_at || register_opened_at_fallback || null,
    given_to_display: given_to_user_name || expense.given_to_name || null,
  };
}

module.exports = { previousRange, changePct, round2, lastMonths, SIGNED_AMOUNT, EXPENSE_ROW_SELECT, normalizeExpenseRow };
