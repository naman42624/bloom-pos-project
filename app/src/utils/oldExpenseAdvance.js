// Pure helpers for "This was a salary advance" (old expense -> salary
// advance, PR 2). No React Native imports, so
// scripts/test-old-expense-advance.js runs in plain node.
//
// The server (POST /api/expenses/:id/salary-advance) is the real guard; this
// only hides a button the server would refuse.

export const OLD_ADVANCE_MAX_DAYS = 60;
const ADVANCE_METHODS = ['cash', 'upi'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// 'YYYY-MM-DD' (or a longer string starting with it) -> whole days since
// 1970-01-01, or null. Calendar days only: no clock, no timezone.
function dayNumber(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  if (!m) return null;
  return Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000);
}

// Whole calendar days from `from` to `to` (both 'YYYY-MM-DD'); null if either is bad.
export function daysBetween(from, to) {
  const a = dayNumber(from);
  const b = dayNumber(to);
  return a == null || b == null ? null : b - a;
}

// todayStr is the shop-local day (getShopTodayStr), as the server's todayStr.
export function canMarkSalaryAdvance(row, todayStr) {
  if (!row) return false;
  if (row.category === 'salary') return false;
  if (!ADVANCE_METHODS.includes(row.payment_method)) return false;
  if (row.is_return === true || Number(row.is_return) === 1) return false;
  if (row.money_out_id != null || row.km_settlement_id != null) return false;
  const age = daysBetween(row.expense_date, todayStr);
  return age != null && age >= 0 && age <= OLD_ADVANCE_MAX_DAYS;
}

// "12 Nov" from 'YYYY-MM-DD'.
export function dayMonth(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : '';
}

const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

// Exact copy (constraints.md).
export function sheetLine(amount, expenseDate) {
  return `${inr(amount)} on ${dayMonth(expenseDate)} becomes a salary advance. It will be taken off their next salary.`;
}

export function paidAfterWarning(name, salaryPaidAfter) {
  const list = Array.isArray(salaryPaidAfter) ? salaryPaidAfter : [];
  if (list.length === 0) return null;
  // The server sends newest first.
  return `${name} was already paid salary on ${dayMonth(list[0].paid_on)}. If you already took this off that pay, don't mark it.`;
}

export function successAlert(amount, name) {
  return { title: 'Marked as salary advance', message: `${inr(amount)} will be taken off ${name}'s next salary.` };
}

// Active staff in the Payroll roles, sorted by name.
const PAYROLL_ROLES = ['manager', 'employee', 'counter_staff', 'florist_staff', 'delivery_partner'];
export function payrollPeople(users) {
  return (Array.isArray(users) ? users : [])
    .filter((u) => u && PAYROLL_ROLES.includes(u.role) && (u.is_active === true || Number(u.is_active) === 1))
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'en', { sensitivity: 'base' }));
}
