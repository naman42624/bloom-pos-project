const express = require('express');
const { body, validationResult } = require('express-validator');
const { getDb } = require('../config/database');
const { getDb: getAsyncDb, withMoneyTx } = require('../config/database-async');
const { authenticate, authorize } = require('../middleware/auth');
const { todayStr: localToday, getTimezone } = require('../utils/time');
const { rankSuggestions, commonAmount, toShopLocal } = require('../utils/usual-now');
const { hasOpenRegister, lockOpenRegister, registerClosedError, REGISTER_CLOSED_MESSAGE } = require('../utils/register-guard');
const {
  nameKey, resolveItem, rememberOnItem, assertGivenTo, isLocalUploadPath, composeDescription, stripNote,
  GIVEN_TO_ROLES, GIVEN_TO_INVALID_MESSAGE,
} = require('../utils/expense-items');

const { previousRange, changePct, round2, lastMonths, SIGNED_AMOUNT, EXPENSE_ROW_SELECT, normalizeExpenseRow } = require('../utils/expense-book');

const router = express.Router();

function hasExpenseNumberColumn(db) {
  try {
    const row = db.prepare(`
      SELECT 1 as exists
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'expenses'
        AND column_name = 'expense_number'
      LIMIT 1
    `).get();
    return !!row;
  } catch (_) {
    return false;
  }
}

function generateExpenseNumber(db, locationId) {
  if (!hasExpenseNumberColumn(db)) return null;
  try {
    const loc = db.prepare('SELECT name FROM locations WHERE id = ?').get(locationId);
    const locCode = loc ? loc.name.replace(/[^A-Za-z]/g, '').substring(0, 4).toUpperCase() : 'EXP';
    const today = localToday().replace(/-/g, '');
    const prefix = `EXP-${locCode}-${today}`;

    const last = db.prepare(
      "SELECT expense_number FROM expenses WHERE expense_number LIKE ? ORDER BY id DESC LIMIT 1"
    ).get(`${prefix}-%`);

    let seq = 1;
    if (last && last.expense_number) {
      const lastNum = parseInt(last.expense_number.split('-').pop(), 10);
      if (!isNaN(lastNum)) seq = lastNum + 1;
    }
    return `${prefix}-${String(seq).padStart(3, '0')}`;
  } catch (_) {
    return null;
  }
}

// ─── GET /api/expenses ───────────────────────────────────────
// Was authenticate-only (any role, including customer, could read expense
// records) — matching the write side's role list here, since anyone who
// can log an expense has an obvious need to see the expense list too
// (sub-project 3 gap, closed 2026-09-01).
router.get('/', authenticate, authorize('owner', 'manager', 'employee', 'counter_staff'), async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const { location_id, category, start_date, end_date, employee_id, item_id, created_by, given_to_user_id } = req.query;
    const q = String(req.query.q || '').trim().slice(0, 80);
    const isBoss = isBossRole(req.user.role);

    // register_opened_at/register_closed_at let the client show which
    // session an expense belongs to (multiple sessions a day are normal).
    // LEFT JOIN: a cash expense with no register still returns, with null.
    let sql = `${EXPENSE_ROW_SELECT}      WHERE 1=1
    `;
    const params = [];

    let effectiveStart = start_date || null;
    let limitedToDays = null;
    if (!isBoss) {
      // Staff see only their own shops (a shop they are not linked to is
      // quietly ignored) and only the last 7 days including today.
      limitedToDays = 7;
      const mine = (await db.prepare('SELECT location_id FROM user_locations WHERE user_id = ?').all(req.user.id)).map((r) => Number(r.location_id));
      const wanted = location_id ? Number(location_id) : null;
      const allowed = wanted && mine.includes(wanted) ? [wanted] : mine;
      if (allowed.length === 0) { sql += ' AND 1=0'; }
      else { sql += ` AND e.location_id IN (${allowed.map(() => '?').join(',')})`; params.push(...allowed); }
      const floor = localToday(new Date(Date.now() - 6 * 86400000));
      if (!effectiveStart || effectiveStart < floor) effectiveStart = floor;
    } else if (location_id) {
      sql += ' AND e.location_id = ?'; params.push(location_id);
    }
    if (category) { sql += ' AND e.category = ?'; params.push(category); }
    if (effectiveStart) { sql += ' AND e.expense_date >= ?'; params.push(effectiveStart); }
    if (end_date) { sql += ' AND e.expense_date <= ?'; params.push(end_date); }
    if (employee_id) { sql += ' AND e.employee_id = ?'; params.push(employee_id); }
    if (item_id) { sql += ' AND e.item_id = ?'; params.push(Number(item_id)); }
    if (created_by) { sql += ' AND e.created_by = ?'; params.push(Number(created_by)); }
    if (given_to_user_id) { sql += ' AND e.given_to_user_id = ?'; params.push(Number(given_to_user_id)); }
    if (!isBoss && (q || employee_id || given_to_user_id)) {
      // A search or filter must not reveal what a hidden salary row says.
      sql += " AND (e.category <> 'salary' OR e.employee_id = ?)"; params.push(req.user.id);
    }
    if (q) {
      const like = `%${q.toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c)}%`;
      sql += " AND (LOWER(COALESCE(e.description, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(ei.name, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(e.note, '')) LIKE ? ESCAPE '\\')";
      params.push(like, like, like);
    }

    const CAP = 500;
    sql += ` ORDER BY e.expense_date DESC, e.created_at DESC`;
    if (isBoss) sql += ` LIMIT ${CAP + 1}`;

    let expenses = await db.prepare(sql).all(...params);
    let truncated = false;
    if (isBoss && expenses.length > CAP) { truncated = true; expenses = expenses.slice(0, CAP); }

    const normalizedExpenses = expenses.map(normalizeExpenseRow).map((r) => (isBoss ? r : hideSalaryNames(r, req.user.id)));

    // Calculate totals using numeric amounts so the client always receives numbers.
    const total = normalizedExpenses.reduce((sum, expense) => sum + (expense.is_return ? -expense.amount : expense.amount), 0);

    const extra = {};
    if (limitedToDays) extra.limited_to_days = limitedToDays;
    if (truncated) extra.truncated = true;
    res.json({ success: true, data: normalizedExpenses, total, ...extra });
  } catch (err) {
    next(err);
  }
});

// ─── Expense book helpers (2026-11-13) ───────────────────────
const NO_ITEM_MESSAGE = 'Type what this was for, like Petrol.';
const NO_AMOUNT_MESSAGE = 'Type how much was paid.';
const NO_CATEGORY_MESSAGE = 'Pick what kind of expense this is.';
const OTHER_DAY_MESSAGE = 'Only the owner or a manager can enter an expense for another day.';
// Cash for an earlier day would come out of today's drawer and leave today's
// close over (2026-11-14 ruling: earlier days are UPI only).
const PAST_DAY_CASH_MESSAGE = "Past days don't change today's drawer. For an earlier day, pick UPI.";
// An old cash expense with no register session (saved before register_id, or
// from a session that is gone) never moves into today's drawer.
const OLD_CASH_MESSAGE = "This cash was paid on a register day that is already closed, so its amount, Cash or UPI and return can't be changed. You can still change what it was for, the note, the photo, who got it and the date.";
const SALARY_ROW_MESSAGE = "Salary entries can't be changed to another kind, and other entries can't be changed to Salary. Remove it and add it again instead.";
const FIELD_FALLBACK_MESSAGE = 'Check the amount, type and date, then save again.';
const BAD_PHOTO_MESSAGE = 'That photo could not be used. Take the photo again.';
const isBossRole = (role) => role === 'owner' || role === 'manager';
// Counter staff never log a Salary expense; they use Salary advance instead.
const SALARY_ADVANCE_MESSAGE = 'Use Salary advance for money given to staff.';
// Other people's salary rows, as counter staff see them: no names at all.
function hideSalaryNames(row, viewerId) {
  if (row.category !== 'salary' || Number(row.employee_id) === Number(viewerId)) return row;
  return {
    ...row,
    description: 'Salary advance',
    note: null,
    item_id: null,
    item_name: null,
    employee_id: null,
    employee_name: null,
    given_to_user_id: null,
    given_to_name: null,
    given_to_display: null,
    photo_url: null,
  };
}

// Plain-language message for the first failed field.
function validationMessage(errors, fallback) {
  const first = errors.array()[0] || {};
  if (first.path === 'amount') return NO_AMOUNT_MESSAGE;
  if (first.path === 'category') return NO_CATEGORY_MESSAGE;
  if (first.path === 'expense_date') return 'Check the date, then save again.';
  if (first.path === 'given_to_user_id') return GIVEN_TO_INVALID_MESSAGE;
  if (first.path === 'photo_url') return BAD_PHOTO_MESSAGE;
  return fallback;
}

const extraFieldRules = [
  body('item_id').optional({ nullable: true }).isInt({ min: 1 }),
  body('item_name').optional({ nullable: true }).isString().isLength({ max: 80 }),
  body('note').optional({ nullable: true }).isString().isLength({ max: 500 }),
  body('photo_url').optional({ nullable: true }).isString(),
  body('given_to_user_id').optional({ nullable: true }).isInt({ min: 1 }),
  body('given_to_name').optional({ nullable: true }).isString(),
];

// "Given to": at most one of user id / free name; the user id wins.
function readGivenTo(b) {
  const userId = b.given_to_user_id ? Number(b.given_to_user_id) : null;
  const name = userId ? null : (String(b.given_to_name || '').trim().replace(/\s+/g, ' ').slice(0, 80) || null);
  return { given_to_user_id: userId, given_to_name: name };
}

// One saved expense with the names the app shows.
async function loadExpenseRow(db, id) {
  const row = await db.prepare(`
    SELECT e.*, l.name as location_name, u.name as created_by_name,
           ei.name as item_name, gu.name as given_to_user_name, pb.name as paid_by_user_name
    FROM expenses e
    JOIN locations l ON e.location_id = l.id
    JOIN users u ON e.created_by = u.id
    LEFT JOIN expense_items ei ON ei.id = e.item_id
    LEFT JOIN users gu ON gu.id = e.given_to_user_id
    LEFT JOIN users pb ON pb.id = e.paid_by_user_id
    WHERE e.id = ?
  `).get(id);
  if (!row) return row;
  const { given_to_user_name, ...rest } = row;
  return {
    ...rest,
    amount: Number(row.amount) || 0,
    item_id: row.item_id == null ? null : Number(row.item_id),
    given_to_user_id: row.given_to_user_id == null ? null : Number(row.given_to_user_id),
    register_id: row.register_id == null ? null : Number(row.register_id),
    paid_by_user_id: row.paid_by_user_id == null ? null : Number(row.paid_by_user_id),
    given_to_display: given_to_user_name || row.given_to_name || null,
  };
}

// ─── Own pocket (spec 4.1, 5.5) ──────────────────────────────
// Paid by Own pocket: payment_method own_pocket, paid_by_user_id = whose
// pocket. Never a register, never counted by a drawer query (they count only
// cash). Each such expense has one shop_owes row (source own_pocket,
// expense_id) that Pay back, Keep or Write off close.
const OWN_POCKET = 'own_pocket';
const SHOPPING_MONEY = 'shopping_money';
const WHOSE_INVALID_MESSAGE = "That person can't be picked here. Tap Whose? and pick again.";
const OWN_POCKET_RETURN_MESSAGE = "Own pocket can't be used for a return. Pick Cash or UPI.";
const OWN_POCKET_SALARY_MESSAGE = 'Pick Cash or UPI for salary.';
const INTO_SHOPPING_MESSAGE = 'Shopping money bills are added from the shopping money line. Pick Cash, UPI or Own pocket.';
const OWES_PAID_BACK_MESSAGE = "The shop already paid back part of this, so it can't be removed. Ask the owner if it needs fixing.";
const OWES_PART_PAID_MESSAGE = "The shop already paid back part of this, so Paid by and Whose? can't be changed. Ask the owner if it needs fixing.";
const ALREADY_SAVED_MESSAGE = 'Already saved — refresh.';
const OWES_CLOSED_MESSAGE = "This Shop owes line is already closed, so its amount, Paid by and Whose? can't be changed. Ask the owner if it needs fixing.";

// Whose pocket: active staff, rider or the owner, linked to the shop (owner anywhere).
async function assertWhose(db, userId, locationId) {
  try {
    await assertGivenTo(db, userId, locationId);
  } catch (e) {
    if (e.statusCode === 400) throw httpError(400, WHOSE_INVALID_MESSAGE);
    throw e;
  }
}
// Locked before the expense and the register (money row first).
async function lockLinkedOwes(tx, expenseId) {
  return (await tx.prepare("SELECT * FROM shop_owes WHERE expense_id = ? AND source = 'own_pocket' ORDER BY id LIMIT 1 FOR UPDATE").get(expenseId)) || null;
}
async function auditOwesRow(tx, owesId, userId, action, before, after) {
  await tx.prepare(`
    INSERT INTO audit_logs (entity_type, entity_id, user_id, action, previous_state, new_state, created_at)
    VALUES ('shop_owes', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(owesId, userId, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null);
}
const pickOwesRow = (o) => ({
  user_id: Number(o.user_id), amount: Number(o.amount), paid_amount: Number(o.paid_amount) || 0, status: o.status,
  expense_id: o.expense_id ? Number(o.expense_id) : null, location_id: o.location_id ? Number(o.location_id) : null,
});
async function createOwnPocketOwes(tx, { expenseId, locationId, userId, amount, createdBy }) {
  const ins = await tx.prepare(`
    INSERT INTO shop_owes (location_id, user_id, amount, paid_amount, source, expense_id, status, created_by)
    VALUES (?, ?, ?, 0, 'own_pocket', ?, 'open', ?)
  `).run(locationId, userId, amount, expenseId, createdBy);
  const id = Number(ins.lastInsertRowid);
  await auditOwesRow(tx, id, createdBy, 'own_pocket_expense', null, {
    user_id: Number(userId), amount: Number(amount), paid_amount: 0, status: 'open', expense_id: Number(expenseId), location_id: Number(locationId),
  });
  return id;
}

// After a save: the item remembers the amount and who it was given to.
// Never fails the request; the expense is already saved.
async function rememberAfterSave(itemId, saved) {
  if (!itemId) return;
  try {
    const db = await getAsyncDb();
    await rememberOnItem(db, itemId, saved);
  } catch (err) {
    console.error('expense item remember failed:', err.message);
  }
}

// ─── GET /api/expenses/summary-by-item ───────────────────────
// Owner/manager: spend per category and item for a period, next to the
// same-length period just before it. Rows with no item stay grouped by category.
const BOSS_ONLY = [authenticate, authorize('owner', 'manager')];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function sumByItem(db, from, to, locationId) {
  const params = [from, to];
  let loc = '';
  if (locationId) { loc = ' AND e.location_id = ?'; params.push(locationId); }
  // Rows of a merged item count under the item it was merged into.
  const rows = await db.prepare(`
    SELECT e.category, COALESCE(ei.merged_into, e.item_id) AS item_id,
           SUM(${SIGNED_AMOUNT}) AS amount, COUNT(*) AS n
      FROM expenses e LEFT JOIN expense_items ei ON ei.id = e.item_id
     WHERE e.expense_date >= ? AND e.expense_date <= ?${loc}
     GROUP BY e.category, COALESCE(ei.merged_into, e.item_id)
  `).all(...params);
  return rows.map((r) => ({ category: r.category, item_id: r.item_id == null ? null : Number(r.item_id), amount: Number(r.amount) || 0, count: Number(r.n) || 0 }));
}

router.get('/summary-by-item', ...BOSS_ONLY, async (req, res, next) => {
  try {
    const { from, to } = req.query;
    if (!DATE_RE.test(String(from || '')) || !DATE_RE.test(String(to || '')) || from > to) {
      return res.status(400).json({ success: false, message: 'Pick the dates to look at.' });
    }
    const locationId = req.query.location_id ? Number(req.query.location_id) : null;
    if (locationId !== null && (!Number.isInteger(locationId) || locationId <= 0)) {
      return res.status(400).json({ success: false, message: 'Pick a shop first.' });
    }
    // Optional comparison period (the app sends "same days last month" etc.).
    // Both or neither; when absent, the same number of days just before.
    const { prev_from: pf, prev_to: pt } = req.query;
    let prev;
    if (pf !== undefined || pt !== undefined) {
      if (!DATE_RE.test(String(pf || '')) || !DATE_RE.test(String(pt || '')) || pf > pt) {
        return res.status(400).json({ success: false, message: 'Pick the dates to compare with.' });
      }
      prev = { from: pf, to: pt };
    } else {
      prev = previousRange(from, to);
    }
    const db = await getAsyncDb();
    const [cur, before] = await Promise.all([sumByItem(db, from, to, locationId), sumByItem(db, prev.from, prev.to, locationId)]);

    // One row per category and item over both periods, so an item that
    // stopped being bought still shows (amount 0, previous_amount X).
    const rows = new Map();
    const put = (r, field) => {
      const key = `${r.category}|${r.item_id}`;
      const row = rows.get(key) || { category: r.category, item_id: r.item_id, amount: 0, previous_amount: 0, count: 0 };
      row[field] += r.amount;
      if (field === 'amount') row.count += r.count;
      rows.set(key, row);
    };
    cur.forEach((r) => put(r, 'amount'));
    before.forEach((r) => put(r, 'previous_amount'));

    const ids = [...new Set([...rows.values()].filter((r) => r.item_id != null).map((r) => r.item_id))];
    const names = new Map();
    if (ids.length) {
      const found = await db.prepare(`SELECT id, name FROM expense_items WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
      found.forEach((i) => names.set(Number(i.id), i.name));
    }

    let total = 0;
    let previousTotal = 0;
    const cats = new Map();
    const older = [];
    for (const r of rows.values()) {
      total += r.amount;
      previousTotal += r.previous_amount;
      if (r.item_id == null) {
        older.push({ category: r.category, amount: round2(r.amount), previous_amount: round2(r.previous_amount), change_pct: changePct(r.amount, r.previous_amount), count: r.count });
        continue;
      }
      const c = cats.get(r.category) || { category: r.category, amount: 0, previous_amount: 0, items: [] };
      c.amount += r.amount;
      c.previous_amount += r.previous_amount;
      c.items.push({ item_id: r.item_id, name: names.get(r.item_id) || 'Item', amount: round2(r.amount), previous_amount: round2(r.previous_amount), change_pct: changePct(r.amount, r.previous_amount) });
      cats.set(r.category, c);
    }
    const byAmount = (a, b) => (b.amount - a.amount) || (b.previous_amount - a.previous_amount);
    const categories = [...cats.values()].map((c) => ({
      category: c.category, amount: round2(c.amount), previous_amount: round2(c.previous_amount),
      change_pct: changePct(c.amount, c.previous_amount), items: c.items.sort(byAmount),
    })).sort(byAmount);
    older.sort(byAmount);

    const uParams = [];
    let uLoc = '';
    if (locationId) { uLoc = ' AND location_id = ?'; uParams.push(locationId); }
    const un = await db.prepare(`SELECT COUNT(*) AS c FROM expenses WHERE item_id IS NULL AND category <> 'salary'${uLoc}`).get(...uParams);

    res.json({ success: true, data: { total: round2(total), previous_total: round2(previousTotal), change_pct: changePct(total, previousTotal), categories, older, unsorted_count: Number(un.c) || 0 } });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/expenses/items/:id/history ─────────────────────
// Owner/manager: one item's monthly spend (always the last N shop months,
// empty months as 0) and its entries for from..to, including items that were
// merged into it.
router.get('/items/:id/history', ...BOSS_ONLY, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ success: false, message: 'That item was not found.' });
    const q0 = req.query;
    if ((q0.location_id && !Number.isInteger(Number(q0.location_id))) || (q0.given_to_user_id && !Number.isInteger(Number(q0.given_to_user_id)))) {
      return res.status(400).json({ success: false, message: q0.location_id && !Number.isInteger(Number(q0.location_id)) ? 'Pick a shop first.' : 'Pick who it was given to again.' });
    }
    const db = await getAsyncDb();
    const item = await db.prepare('SELECT id, name, category, is_active, merged_into FROM expense_items WHERE id = ?').get(id);
    if (!item) return res.status(404).json({ success: false, message: 'That item was not found.' });

    const months = Math.min(Math.max(parseInt(req.query.months, 10) || 6, 1), 24);
    const today = localToday();
    const keys = lastMonths(today, months);
    const windowStart = `${keys[0]}-01`;
    const { from, to, location_id, given_to_user_id } = req.query;
    const start = DATE_RE.test(String(from || '')) ? from : windowStart;
    const end = DATE_RE.test(String(to || '')) ? to : today;

    // Month totals always cover the last N months (shop, person filters
    // apply); the entry list follows from..to.
    const whereFor = (a, b) => {
      let w = ' WHERE (e.item_id = ? OR e.item_id IN (SELECT id FROM expense_items WHERE merged_into = ?)) AND e.expense_date >= ? AND e.expense_date <= ?';
      const p = [id, id, a, b];
      if (location_id) { w += ' AND e.location_id = ?'; p.push(Number(location_id)); }
      if (given_to_user_id) { w += ' AND e.given_to_user_id = ?'; p.push(Number(given_to_user_id)); }
      return { w, p };
    };
    const strip = whereFor(windowStart, today);
    const list = whereFor(start, end);

    const monthRows = await db.prepare(`
      SELECT to_char(e.expense_date, 'YYYY-MM') AS month, SUM(${SIGNED_AMOUNT}) AS amount
        FROM expenses e${strip.w}
       GROUP BY 1
    `).all(...strip.p);
    const byMonth = new Map(monthRows.map((r) => [r.month, Number(r.amount) || 0]));
    const entries = (await db.prepare(`${EXPENSE_ROW_SELECT}${list.w} ORDER BY e.expense_date DESC, e.created_at DESC LIMIT 500`).all(...list.p)).map(normalizeExpenseRow);

    // Items merged into this one, so the owner can separate one again.
    const mergedIn = (await db.prepare('SELECT id, name FROM expense_items WHERE merged_into = ? ORDER BY name').all(id))
      .map((r) => ({ id: Number(r.id), name: r.name }));

    res.json({ success: true, data: { item, months: keys.map((m) => ({ month: m, amount: round2(byMonth.get(m) || 0) })), entries, merged_in: mergedIn } });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/expenses/people ────────────────────────────────
// The "Given to" chips: active staff and riders linked to the shop, plus the
// owner. Needs a login (unlike /auth/staff-roster), so rider names stay private.
router.get('/people', authenticate, authorize('owner', 'manager', 'employee', 'counter_staff'), async (req, res, next) => {
  try {
    const locationId = Number(req.query.location_id);
    if (!Number.isInteger(locationId) || locationId <= 0) {
      return res.status(400).json({ success: false, message: 'Pick a shop first.' });
    }
    const db = await getAsyncDb();
    const roles = GIVEN_TO_ROLES.map(() => '?').join(', ');
    const people = await db.prepare(`
      SELECT u.id, u.name, u.role
      FROM users u
      WHERE u.is_active = 1
        AND u.role IN (${roles})
        AND (u.role = 'owner' OR EXISTS (SELECT 1 FROM user_locations ul WHERE ul.user_id = u.id AND ul.location_id = ?))
      ORDER BY u.name ASC
    `).all(...GIVEN_TO_ROLES, locationId);
    res.json({ success: true, data: people.map((p) => ({ id: Number(p.id), name: p.name, role: p.role })) });
  } catch (err) {
    next(err);
  }
});

// Usual now / Often sections for the chips (no search text). One query over
// the shop's last 60 days of cash/UPI expenses with an item. The legacy `data`
// array stays as it was for older app builds.
async function usualNowSections(db, locationId, userId, shapeItem, cols, base) {
  const tz = getTimezone();
  const nowLocal = toShopLocal(new Date(), tz);
  const since = new Date(Date.now() - 61 * 86400000);
  const sinceSql = since.toISOString().replace('T', ' ').slice(0, 19);
  const entryRows = await db.prepare(`
    SELECT item_id, amount, payment_method, created_by, created_at
    FROM expenses
    WHERE location_id = ? AND item_id IS NOT NULL AND payment_method IN ('cash', 'upi')
      AND COALESCE(is_return, 0) = 0 AND category <> 'salary' AND created_at >= ?
    ORDER BY created_at ASC
  `).all(locationId, sinceSql);
  const byItem = new Map();
  for (const r of entryRows) {
    const at = toShopLocal(r.created_at instanceof Date ? r.created_at : new Date(r.created_at), tz);
    const list = byItem.get(Number(r.item_id)) || [];
    list.push({ at, amount: Number(r.amount), method: r.payment_method, created_by: Number(r.created_by) });
    byItem.set(Number(r.item_id), list);
  }
  const thirtyAgo = nowLocal.getTime() - 30 * 86400000;
  const itemIds = [...byItem.keys()];
  const idList = itemIds.length ? itemIds.map(() => '?').join(', ') : 'NULL';
  const candidates = await db.prepare(`
    SELECT ${cols}, i.pinned, i.pin_order ${base}
    AND (i.pinned = TRUE OR i.id IN (${idList}))
  `).all(...itemIds);
  const items = candidates.map((r) => {
    const entries = byItem.get(Number(r.id)) || [];
    return {
      id: Number(r.id), pinned: !!r.pinned, pin_order: r.pin_order == null ? null : Number(r.pin_order),
      uses30: entries.filter((e) => e.at.getTime() >= thirtyAgo).length,
      entries, row: r,
    };
  });
  const { usual_now, often } = rankSuggestions(items, nowLocal);
  const picked = usual_now.concat(often);

  // Clocked in today with no clock-out: the Given to person is shown only if here.
  // A typed name (a vendor, no user_id) never clocks in, so it always counts as here.
  const personIds = [...new Set(picked.map((i) => Number(i.row.last_given_to_user_id)).filter(Boolean))];
  let present = new Set();
  if (personIds.length) {
    const att = await db.prepare(`
      SELECT DISTINCT user_id FROM attendance
      WHERE date = ? AND clock_out IS NULL AND user_id IN (${personIds.map(() => '?').join(', ')})
    `).all(localToday(), ...personIds);
    present = new Set(att.map((a) => Number(a.user_id)));
  }
  const finish = (i) => {
    const shaped = shapeItem(i.row);
    const mine = i.entries.filter((e) => e.created_by === Number(userId)).pop();
    return {
      ...shaped,
      common_amount: commonAmount(i.entries),
      my_last_method: mine ? mine.method : null,
      last_given_to: shaped.last_given_to
        ? { ...shaped.last_given_to, present_today: shaped.last_given_to.user_id ? present.has(shaped.last_given_to.user_id) : true }
        : null,
    };
  };
  return { usual_now: usual_now.map(finish), often: often.map(finish) };
}

// ─── GET /api/expenses/suggest ───────────────────────────────
// Quick-pick chips (pinned first, then this shop's most used in the last 30
// days) and type-ahead when q is given. Never hidden or merged items.
router.get('/suggest', authenticate, authorize('owner', 'manager', 'employee', 'counter_staff'), async (req, res, next) => {
  try {
    const locationId = Number(req.query.location_id);
    if (!Number.isInteger(locationId) || locationId <= 0) {
      return res.status(400).json({ success: false, message: 'Pick a shop first.' });
    }
    const db = await getAsyncDb();
    const sinceStr = localToday(new Date(Date.now() - 29 * 86400000));
    const cols = `i.id, i.name, i.category, i.usual_amount, i.last_given_to_user_id, i.last_given_to_name, gu.name AS last_user_name`;
    // Counter staff never get a salary item (its amount or person) here.
    const noSalary = isBossRole(req.user.role) ? '' : " AND i.category <> 'salary'";
    const base = `FROM expense_items i LEFT JOIN users gu ON gu.id = i.last_given_to_user_id WHERE i.is_active = TRUE AND i.merged_into IS NULL${noSalary}`;
    const useCount = `(SELECT COUNT(*) FROM expenses e WHERE e.item_id = i.id AND e.location_id = ? AND e.expense_date >= ?)`;
    const q = nameKey(req.query.q);
    let rows;
    if (q) {
      const like = q.replace(/[\\%_]/g, (c) => '\\' + c);
      rows = await db.prepare(`
        SELECT ${cols}, ${useCount} AS uses
        ${base} AND i.name_key LIKE ? ESCAPE '\\'
        ORDER BY (i.name_key LIKE ? ESCAPE '\\') DESC, uses DESC, i.name ASC
        LIMIT 8
      `).all(locationId, sinceStr, `%${like}%`, `${like}%`);
    } else {
      const pinned = await db.prepare(`
        SELECT ${cols} ${base} AND i.pinned = TRUE
        ORDER BY i.pin_order ASC NULLS LAST, i.name ASC LIMIT 8
      `).all();
      rows = pinned;
      if (rows.length < 8) {
        const skip = rows.map(() => '?').join(', ');
        const used = await db.prepare(`
          SELECT ${cols}, ${useCount} AS uses
          ${base} AND i.pinned IS NOT TRUE ${rows.length ? `AND i.id NOT IN (${skip})` : ''}
          AND ${useCount} > 0
          ORDER BY uses DESC, i.name ASC LIMIT ?
        `).all(locationId, sinceStr, ...rows.map((r) => r.id), locationId, sinceStr, 8 - rows.length);
        rows = rows.concat(used);
      }
    }
    const shapeItem = (r) => ({
      id: Number(r.id),
      name: r.name,
      category: r.category,
      usual_amount: r.usual_amount == null ? null : Number(r.usual_amount),
      last_given_to: (r.last_given_to_user_id || r.last_given_to_name)
        ? {
            user_id: r.last_given_to_user_id ? Number(r.last_given_to_user_id) : null,
            name: r.last_given_to_name || null,
            display_name: r.last_given_to_user_id ? (r.last_user_name || r.last_given_to_name) : r.last_given_to_name,
          }
        : null,
    });
    const out = { success: true, data: rows.map(shapeItem) };
    if (!q) Object.assign(out, await usualNowSections(db, locationId, req.user.id, shapeItem, cols, base));
    res.json(out);
  } catch (err) {
    next(err);
  }
});

// ─── Owner item tools: list, change, pin order, merge ────────
// Owner only. Literal paths, so they sit before every '/:id' route.
const OWNER_ONLY = [authenticate, authorize('owner')];
const SALARY_ITEM_MESSAGE = "Salary items can't be moved to another kind. Use Payroll for salary.";
const MERGE_TARGET_MESSAGE = 'Pick a different item to merge into.';
const ITEM_NOT_FOUND_MESSAGE = 'That item was not found. Pull down to refresh.';

const RIDER_PETROL_PICK_MESSAGE = 'Pick the rider from the list so it counts against their km.';
const RIDER_OWN_PETROL_MESSAGE = "A rider's own petrol is covered by their km pay — no need to add it.";
// Rows a rider km settlement wrote or counted (expenses.km_settlement_id).
// Their money stays as settled; the settlement already netted it.
const KM_SETTLED_CHANGE_MESSAGE = 'This is part of a settled km account, so the amount, method, item and person stay as they are. You can still change the note or photo.';
const KM_SETTLED_REMOVE_MESSAGE = "This is part of a settled km account, so it can't be removed.";
// Km account: the method of the settlement's petrol row. Written only by a
// km settlement, never typed in, and never in any drawer sum (not cash).
const KM_ACCOUNT = 'km_account';
async function isRiderUser(db, userId) {
  if (!userId) return false;
  return !!(await db.prepare("SELECT 1 AS ok FROM users WHERE id = ? AND role = 'delivery_partner'").get(userId));
}

const itemOut = (r) => ({
  id: Number(r.id),
  name: r.name,
  category: r.category,
  usual_amount: r.usual_amount == null ? null : Number(r.usual_amount),
  pinned: !!r.pinned,
  pin_order: r.pin_order == null ? null : Number(r.pin_order),
  is_active: r.is_active !== false,
  merged_into: r.merged_into == null ? null : Number(r.merged_into),
  is_rider_petrol: !!r.is_rider_petrol,
  ...(r.use_count !== undefined ? { use_count: Number(r.use_count) || 0 } : {}),
});
const pickItemAudit = (r) => ({
  name: r.name, category: r.category, usual_amount: r.usual_amount == null ? null : Number(r.usual_amount),
  pinned: !!r.pinned, pin_order: r.pin_order == null ? null : Number(r.pin_order),
  is_active: r.is_active !== false, merged_into: r.merged_into == null ? null : Number(r.merged_into),
});

async function auditItem(tx, itemId, userId, action, before, after) {
  await tx.prepare(`
    INSERT INTO audit_logs (entity_type, entity_id, user_id, action, previous_state, new_state, created_at)
    VALUES ('expense_item', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(itemId, userId, action, JSON.stringify(before), after ? JSON.stringify(after) : null);
}

function sendItemError(res, next, err) {
  if (err && err.statusCode) return res.status(err.statusCode).json({ success: false, message: err.message });
  return next(err);
}

// GET /api/expenses/items?q=&include_hidden=
router.get('/items', ...OWNER_ONLY, async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const params = [];
    let where = ' WHERE 1=1';
    const showHidden = ['1', 'true'].includes(String(req.query.include_hidden || '').toLowerCase());
    if (!showHidden) where += ' AND i.is_active = TRUE AND i.merged_into IS NULL';
    const q = nameKey(req.query.q);
    if (q) {
      where += " AND i.name_key LIKE ? ESCAPE '\\'";
      params.push(`%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`);
    }
    const rows = await db.prepare(`
      SELECT i.id, i.name, i.category, i.usual_amount, i.pinned, i.pin_order, i.is_active, i.merged_into, i.is_rider_petrol,
             (SELECT COUNT(*) FROM expenses e WHERE e.item_id = i.id) AS use_count
        FROM expense_items i${where}
       ORDER BY i.pinned DESC NULLS LAST, i.pin_order ASC NULLS LAST, i.name ASC
       LIMIT 500
    `).all(...params);
    res.json({ success: true, data: rows.map(itemOut) });
  } catch (err) {
    next(err);
  }
});

// PUT /api/expenses/items/pins { ids: [...] }: the full pinned list, in order.
// Items left out of the list are unpinned.
router.put('/items/pins', ...OWNER_ONLY, async (req, res, next) => {
  try {
    const raw = req.body && req.body.ids;
    const ids = Array.isArray(raw) ? raw.map(Number) : null;
    if (!ids || ids.length > 50 || ids.some((n) => !Number.isInteger(n) || n <= 0) || new Set(ids).size !== ids.length) {
      return res.status(400).json({ success: false, message: 'Pick the items to pin again.' });
    }
    await withMoneyTx(async (tx) => {
      if (ids.length) {
        const found = await tx.prepare(
          `SELECT id FROM expense_items WHERE id IN (${ids.map(() => '?').join(',')}) AND merged_into IS NULL FOR UPDATE`
        ).all(...ids);
        if (found.length !== ids.length) throw httpError(400, 'One of these items was merged or removed. Pull down to refresh, then pin again.');
      }
      const before = await tx.prepare('SELECT id FROM expense_items WHERE pinned = TRUE ORDER BY pin_order ASC NULLS LAST, id ASC FOR UPDATE').all();
      await tx.prepare('UPDATE expense_items SET pinned = FALSE, pin_order = NULL, updated_at = CURRENT_TIMESTAMP WHERE pinned = TRUE').run();
      for (let i = 0; i < ids.length; i += 1) {
        await tx.prepare('UPDATE expense_items SET pinned = TRUE, pin_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(i + 1, ids[i]);
      }
      // The pin list is shop-wide, not one item, so entity_id is 0.
      await auditItem(tx, 0, req.user.id, 'expense_item_pins', { ids: before.map((r) => Number(r.id)) }, { ids });
    });
    res.json({ success: true, data: { ids } });
  } catch (err) {
    sendItemError(res, next, err);
  }
});

// PUT /api/expenses/items/:id/rider-petrol { on }: which item is the rider petrol advance.
router.put('/items/:id/rider-petrol', ...OWNER_ONLY, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ success: false, message: ITEM_NOT_FOUND_MESSAGE });
    const on = req.body && req.body.on;
    if (typeof on !== 'boolean') return res.status(400).json({ success: false, message: 'Pick On or Off.' });
    const db = await getAsyncDb();
    const item = await db.prepare('SELECT * FROM expense_items WHERE id = ?').get(id);
    if (!item) return res.status(404).json({ success: false, message: ITEM_NOT_FOUND_MESSAGE });
    await db.prepare('UPDATE expense_items SET is_rider_petrol = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(on, id);
    await db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, user_id, action, previous_state, new_state, created_at)
      VALUES ('expense_item', ?, ?, 'item_rider_petrol', ?, ?, CURRENT_TIMESTAMP)
    `).run(id, req.user.id, JSON.stringify({ is_rider_petrol: !!item.is_rider_petrol }), JSON.stringify({ is_rider_petrol: on }));
    const fresh = await db.prepare('SELECT * FROM expense_items WHERE id = ?').get(id);
    res.json({ success: true, data: itemOut(fresh) });
  } catch (err) {
    next(err);
  }
});

// PUT /api/expenses/items/:id: name, category (+ move_past), usual_amount,
// pinned, pin_order, is_active.
router.put('/items/:id', ...OWNER_ONLY, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ success: false, message: ITEM_NOT_FOUND_MESSAGE });
    const b = req.body || {};
    const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
    const changes = {};
    if (has('name')) {
      const display = String(b.name == null ? '' : b.name).trim().replace(/\s+/g, ' ');
      if (!display) return res.status(400).json({ success: false, message: 'Type what this was for, like Petrol.' });
      if (display.length > 80) return res.status(400).json({ success: false, message: 'Make the name shorter (80 letters at most).' });
      changes.name = display;
    }
    if (has('category')) {
      if (!EXPENSE_CATEGORIES.includes(b.category)) return res.status(400).json({ success: false, message: NO_CATEGORY_MESSAGE });
      changes.category = b.category;
    }
    if (has('usual_amount')) {
      const n = b.usual_amount === null || b.usual_amount === '' ? null : Number(b.usual_amount);
      if (n !== null && (!Number.isFinite(n) || n < 0 || n > 10000000)) return res.status(400).json({ success: false, message: NO_AMOUNT_MESSAGE });
      changes.usual_amount = n === null ? null : round2(n);
    }
    for (const k of ['pinned', 'is_active']) {
      if (has(k)) {
        if (typeof b[k] !== 'boolean') return res.status(400).json({ success: false, message: 'Something on this item could not be saved. Try again.' });
        changes[k] = b[k];
      }
    }
    if (has('pin_order')) {
      const n = b.pin_order === null ? null : Number(b.pin_order);
      if (n !== null && !Number.isInteger(n)) return res.status(400).json({ success: false, message: 'Something on this item could not be saved. Try again.' });
      changes.pin_order = n;
    }
    const movePast = b.move_past === true;

    const result = await withMoneyTx(async (tx) => {
      const item = await tx.prepare('SELECT * FROM expense_items WHERE id = ? FOR UPDATE').get(id);
      if (!item) throw httpError(404, ITEM_NOT_FOUND_MESSAGE);
      if (item.merged_into) throw httpError(400, 'This item was merged into another one. Change that item instead.');
      if (changes.name !== undefined) {
        const key = nameKey(changes.name);
        const other = await tx.prepare('SELECT id, name FROM expense_items WHERE name_key = ? AND id <> ?').get(key, id);
        if (other) throw httpError(400, `There is already an item called ${other.name}. Merge them instead.`);
        changes.name_key = key;
      }
      const categoryChanges = changes.category !== undefined && changes.category !== item.category;
      if (categoryChanges && (item.category === 'salary' || changes.category === 'salary')) throw httpError(400, SALARY_ITEM_MESSAGE);
      if (!categoryChanges) delete changes.category;

      const cols = Object.keys(changes);
      if (cols.length) {
        await tx.prepare(
          `UPDATE expense_items SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
        ).run(...cols.map((c) => changes[c]), id);
      }
      const after = await tx.prepare('SELECT * FROM expense_items WHERE id = ?').get(id);
      if (cols.length) await auditItem(tx, id, req.user.id, 'expense_item_update', pickItemAudit(item), pickItemAudit(after));

      // Past rows follow the new category only when asked. Salary rows never move.
      let recategorised = 0;
      if (categoryChanges && movePast) {
        const moved = await tx.prepare(
          "UPDATE expenses SET category = ? WHERE item_id = ? AND category <> 'salary' AND category <> ?"
        ).run(after.category, id, after.category);
        recategorised = moved.changes;
        await auditItem(tx, id, req.user.id, 'expense_item_recategorise',
          { category: item.category }, { category: after.category, recategorised });
      }
      return { item: after, recategorised };
    });
    res.json({ success: true, data: { ...itemOut(result.item), recategorised: result.recategorised } });
  } catch (err) {
    if (err && err.code === '23505') {
      return res.status(400).json({ success: false, message: 'There is already an item with that name. Merge them instead.' });
    }
    sendItemError(res, next, err);
  }
});

// POST /api/expenses/items/:id/merge { into_id }: one transaction.
// Moves item_id only; category and description on the rows stay as they are.
router.post('/items/:id/merge', ...OWNER_ONLY, async (req, res, next) => {
  try {
    const sourceId = Number(req.params.id);
    const intoId = Number(req.body && req.body.into_id);
    if (!Number.isInteger(sourceId) || sourceId <= 0) return res.status(404).json({ success: false, message: ITEM_NOT_FOUND_MESSAGE });
    if (!Number.isInteger(intoId) || intoId <= 0 || intoId === sourceId) {
      return res.status(400).json({ success: false, message: MERGE_TARGET_MESSAGE });
    }
    const out = await withMoneyTx(async (tx) => {
      // Lock both items in id order so two merges cannot deadlock.
      const locked = await tx.prepare('SELECT * FROM expense_items WHERE id IN (?, ?) ORDER BY id FOR UPDATE').all(sourceId, intoId);
      const source = locked.find((r) => Number(r.id) === sourceId);
      const target = locked.find((r) => Number(r.id) === intoId);
      if (!source) throw httpError(404, ITEM_NOT_FOUND_MESSAGE);
      if (source.merged_into) throw httpError(400, 'This item was already merged. Pull down to refresh.');
      if (!target || target.merged_into || target.is_active === false) throw httpError(400, MERGE_TARGET_MESSAGE);
      // Salary stays apart: rows merged across would change kind for future entries.
      if ((source.category === 'salary') !== (target.category === 'salary')) throw httpError(400, SALARY_ITEM_MESSAGE);

      // The exact rows and items that move are kept in the audit, so the merge
      // can be undone later (POST /items/:id/unmerge). Rows a rider km
      // settlement counted keep their item (same lock as PUT /:id); they still
      // count under the target through merged_into.
      const movedIds = (await tx.prepare('SELECT id FROM expenses WHERE item_id = ? AND km_settlement_id IS NULL ORDER BY id FOR UPDATE').all(sourceId)).map((r) => Number(r.id));
      const moved = (await tx.prepare('UPDATE expenses SET item_id = ? WHERE item_id = ? AND km_settlement_id IS NULL').run(intoId, sourceId)).changes;
      // Items already merged into the source now point at the target (never chained).
      const repointedIds = (await tx.prepare('SELECT id FROM expense_items WHERE merged_into = ? ORDER BY id FOR UPDATE').all(sourceId)).map((r) => Number(r.id));
      const repointed = (await tx.prepare('UPDATE expense_items SET merged_into = ?, updated_at = CURRENT_TIMESTAMP WHERE merged_into = ?').run(intoId, sourceId)).changes;
      await tx.prepare(
        'UPDATE expense_items SET merged_into = ?, is_active = FALSE, pinned = FALSE, pin_order = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
      ).run(intoId, sourceId);
      await auditItem(tx, sourceId, req.user.id, 'expense_item_merge',
        pickItemAudit(source), { merged_into: intoId, into_name: target.name, moved, repointed, moved_ids: movedIds, repointed_ids: repointedIds });
      return { moved, repointed, into: target };
    });
    res.json({ success: true, data: { moved: out.moved, repointed: out.repointed, into_id: intoId, into_name: out.into.name } });
  } catch (err) {
    sendItemError(res, next, err);
  }
});

// POST /api/expenses/items/:id/unmerge — "Separate again": undo the last merge
// of this item. The rows that merge moved go back (only those still on the
// target), items it re-pointed point here again, and the item comes back as
// it was (pinned at the end of the pin list if it was pinned). A merge saved
// before the moved rows were recorded brings the item back but moves no rows.
router.post('/items/:id/unmerge', ...OWNER_ONLY, async (req, res, next) => {
  try {
    const sourceId = Number(req.params.id);
    if (!Number.isInteger(sourceId) || sourceId <= 0) return res.status(404).json({ success: false, message: ITEM_NOT_FOUND_MESSAGE });
    const out = await withMoneyTx(async (tx) => {
      const first = await tx.prepare('SELECT id, merged_into FROM expense_items WHERE id = ?').get(sourceId);
      if (!first) throw httpError(404, ITEM_NOT_FOUND_MESSAGE);
      if (!first.merged_into) throw httpError(409, 'This item is already separate. Pull down to refresh.');
      const intoId = Number(first.merged_into);
      // Same lock order as merge: both items in id order.
      const locked = await tx.prepare('SELECT * FROM expense_items WHERE id IN (?, ?) ORDER BY id FOR UPDATE').all(sourceId, intoId);
      const source = locked.find((r) => Number(r.id) === sourceId);
      const target = locked.find((r) => Number(r.id) === intoId);
      if (!source || Number(source.merged_into) !== intoId) throw httpError(409, 'This item changed just now. Pull down to refresh, then try again.');
      if (target && target.merged_into) {
        const next = await tx.prepare('SELECT name FROM expense_items WHERE id = ?').get(target.merged_into);
        throw httpError(409, `"${target.name}" was merged into "${next ? next.name : 'another item'}" since. Separate "${target.name}" first, then this one.`);
      }
      const log = await tx.prepare(`
        SELECT previous_state, new_state FROM audit_logs
         WHERE entity_type = 'expense_item' AND entity_id = ? AND action = 'expense_item_merge'
         ORDER BY id DESC LIMIT 1
      `).get(sourceId);
      const after = log && log.new_state ? (typeof log.new_state === 'string' ? JSON.parse(log.new_state) : log.new_state) : {};
      const before = log && log.previous_state ? (typeof log.previous_state === 'string' ? JSON.parse(log.previous_state) : log.previous_state) : {};
      const fromThisMerge = Number(after.merged_into) === intoId;
      // The item's own merge went into another item that was merged on later
      // (which re-pointed this one): that later merge holds the rows.
      if (log && !fromThisMerge && after.merged_into) {
        const mid = after.into_name || 'the item it was merged into';
        throw httpError(409, `"${source.name}" moved with "${mid}" when "${mid}" was merged into "${target ? target.name : 'another item'}". Separate "${mid}" first, then this one.`);
      }
      const movedIds = fromThisMerge && Array.isArray(after.moved_ids) ? after.moved_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : null;
      const repointedIds = fromThisMerge && Array.isArray(after.repointed_ids) ? after.repointed_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];

      let movedBack = 0;
      if (movedIds && movedIds.length) {
        movedBack = (await tx.prepare(
          `UPDATE expenses SET item_id = ? WHERE item_id = ? AND km_settlement_id IS NULL AND id IN (${movedIds.map(() => '?').join(',')})`
        ).run(sourceId, intoId, ...movedIds)).changes;
      }
      let repointedBack = 0;
      if (repointedIds.length) {
        repointedBack = (await tx.prepare(
          `UPDATE expense_items SET merged_into = ?, updated_at = CURRENT_TIMESTAMP WHERE merged_into = ? AND id IN (${repointedIds.map(() => '?').join(',')})`
        ).run(sourceId, intoId, ...repointedIds)).changes;
      }
      const wasPinned = fromThisMerge && before.pinned === true;
      const pinOrder = wasPinned
        ? Number((await tx.prepare('SELECT COALESCE(MAX(pin_order), 0) AS m FROM expense_items WHERE pinned = TRUE').get()).m) + 1
        : null;
      const active = fromThisMerge ? before.is_active !== false : true;
      await tx.prepare(
        'UPDATE expense_items SET merged_into = NULL, is_active = ?, pinned = ?, pin_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
      ).run(active, wasPinned, pinOrder, sourceId);
      const skipped = movedIds ? movedIds.length - movedBack : 0;
      await auditItem(tx, sourceId, req.user.id, 'expense_item_unmerge',
        { merged_into: intoId, into_name: target ? target.name : null },
        { moved_back: movedBack, moved_back_ids: movedIds || [], skipped, repointed_back: repointedBack, older_merge: !movedIds });
      return { movedBack, skipped, olderMerge: !movedIds, name: source.name, intoName: target ? target.name : null };
    });
    res.json({ success: true, data: {
      id: sourceId, name: out.name, into_name: out.intoName,
      moved_back: out.movedBack, skipped: out.skipped, older_merge: out.olderMerge,
    } });
  } catch (err) {
    sendItemError(res, next, err);
  }
});

// ─── Sort old entries into items (owner only) ────────────────
// Suggestion: the exact name key of the description, else the item whose key is
// the longest prefix of it (ending on a word boundary, so tea never matches teak).
function suggestItem(items, description) {
  const key = nameKey(description);
  if (!key) return null;
  let best = null;
  for (const it of items) {
    const k = it.name_key;
    if (!k) continue;
    if (k === key) return { id: Number(it.id), name: it.name };
    if (key.startsWith(k) && key[k.length] === ' ' && (!best || k.length > best.k.length)) best = { k, id: Number(it.id), name: it.name };
  }
  return best ? { id: best.id, name: best.name } : null;
}

// GET /api/expenses/unsorted?limit=50&after_id=N: rows with no item (not salary),
// newest first. after_id is the last row of the previous page: the next page
// starts right after it in this order (keyset, so rows sorted in between never
// make a page skip or repeat a row). Also returns total (rows left to sort)
// and next_after_id (null on the last page).
const UNSORTED_WHERE = "e.item_id IS NULL AND e.category <> 'salary'";
const UNSORTED_KEY = "(e.expense_date, COALESCE(e.created_at, TIMESTAMP 'epoch'), e.id)";
router.get('/unsorted', ...OWNER_ONLY, async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const asked = parseInt(req.query.limit, 10);
    const limit = Math.min(asked > 0 ? asked : 50, 200);
    const afterRaw = req.query.after_id;
    const afterId = afterRaw === undefined || afterRaw === '' ? null : Number(afterRaw);
    if (afterId !== null && (!Number.isInteger(afterId) || afterId <= 0)) {
      return res.status(400).json({ success: false, message: 'Pull down to refresh the list.' });
    }
    const params = [];
    let where = ` WHERE ${UNSORTED_WHERE}`;
    if (afterId) {
      where += ` AND ${UNSORTED_KEY} < (SELECT a.expense_date, COALESCE(a.created_at, TIMESTAMP 'epoch'), a.id FROM expenses a WHERE a.id = ?)`;
      params.push(afterId);
    }
    // One extra row tells whether another page follows.
    const rows = await db.prepare(
      `${EXPENSE_ROW_SELECT}${where}
      ORDER BY e.expense_date DESC, COALESCE(e.created_at, TIMESTAMP 'epoch') DESC, e.id DESC LIMIT ${limit + 1}`
    ).all(...params);
    const more = rows.length > limit;
    const page = more ? rows.slice(0, limit) : rows;
    const total = Number((await db.prepare(`SELECT COUNT(*) AS c FROM expenses e WHERE ${UNSORTED_WHERE}`).get()).c) || 0;
    const items = await db.prepare('SELECT id, name, name_key FROM expense_items WHERE is_active = TRUE AND merged_into IS NULL AND category <> \'salary\'').all();
    const data = page.map(normalizeExpenseRow).map((r) => ({ ...r, suggested_item: suggestItem(items, r.description) }));
    res.json({ success: true, data, total, next_after_id: more && page.length ? Number(page[page.length - 1].id) : null });
  } catch (err) {
    next(err);
  }
});

// GET /api/expenses/sorted-earlier?limit=&after=<log_id>:<expense_id>
// Entries put into an item by Sort older entries, newest sort first, read from
// the expense_assign_items audit rows. Only entries still in the item they were
// sorted into are listed (Take out = POST /assign-items/undo). Paged by a
// keyset on (audit row id, expense id); returns total and next_after.
const SORTED_EARLIER_CTE = `
  WITH s AS (
    SELECT DISTINCT ON (x.expense_id) x.expense_id, x.item_id, al.id AS log_id, al.created_at AS sorted_at
    FROM audit_logs al
    CROSS JOIN LATERAL jsonb_to_recordset(
      CASE WHEN jsonb_typeof(al.new_state -> 'assignments') = 'array' THEN al.new_state -> 'assignments' ELSE '[]'::jsonb END
    ) AS x(expense_id int, item_id int)
    WHERE al.entity_type = 'expense_item' AND al.action = 'expense_assign_items'
    ORDER BY x.expense_id, al.id DESC
  ), cur AS (
    SELECT s.* FROM s JOIN expenses e ON e.id = s.expense_id AND e.item_id = s.item_id
  )`;
router.get('/sorted-earlier', ...OWNER_ONLY, async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const asked = parseInt(req.query.limit, 10);
    const limit = Math.min(asked > 0 ? asked : 50, 200);
    let after = null;
    if (req.query.after !== undefined && req.query.after !== '') {
      const m = /^(\d+):(\d+)$/.exec(String(req.query.after));
      if (!m) return res.status(400).json({ success: false, message: 'Pull down to refresh the list.' });
      after = [Number(m[1]), Number(m[2])];
    }
    const keys = await db.prepare(
      `${SORTED_EARLIER_CTE}
      SELECT expense_id, item_id, log_id, sorted_at FROM cur
      ${after ? 'WHERE (log_id, expense_id) < (?, ?)' : ''}
      ORDER BY log_id DESC, expense_id DESC LIMIT ${limit + 1}`
    ).all(...(after || []));
    const more = keys.length > limit;
    const page = more ? keys.slice(0, limit) : keys;
    const total = Number((await db.prepare(`${SORTED_EARLIER_CTE} SELECT COUNT(*) AS c FROM cur`).get()).c) || 0;
    let data = [];
    if (page.length) {
      const rows = await db.prepare(`${EXPENSE_ROW_SELECT} WHERE e.id IN (${page.map(() => '?').join(', ')})`)
        .all(...page.map((k) => k.expense_id));
      const byId = new Map(rows.map((r) => [Number(r.id), normalizeExpenseRow(r)]));
      data = page.filter((k) => byId.has(Number(k.expense_id))).map((k) => ({
        ...byId.get(Number(k.expense_id)),
        sorted_item_id: Number(k.item_id),
        sorted_at: k.sorted_at,
      }));
    }
    const last = page[page.length - 1];
    res.json({ success: true, data, total, next_after: more && last ? `${last.log_id}:${last.expense_id}` : null });
  } catch (err) {
    next(err);
  }
});

// POST /api/expenses/assign-items { assignments: [{ expense_id, item_id | item_name, category? }] }
// One transaction; sets item_id only. Salary rows, rows that already have an
// item and rows a rider km settlement counted are skipped. One audit row per call (entity_id 0).
router.post('/assign-items', ...OWNER_ONLY, async (req, res, next) => {
  try {
    const list = req.body && req.body.assignments;
    if (!Array.isArray(list) || list.length === 0 || list.length > 200) {
      return res.status(400).json({ success: false, message: 'Pick at least one entry to sort.' });
    }
    const seen = new Set();
    for (const a of list) {
      const id = Number(a && a.expense_id);
      if (!Number.isInteger(id) || id <= 0 || seen.has(id)) return res.status(400).json({ success: false, message: 'Pick the entries to sort again.' });
      seen.add(id);
      if (a.category != null && a.category !== '') {
        if (!EXPENSE_CATEGORIES.includes(a.category)) return res.status(400).json({ success: false, message: NO_CATEGORY_MESSAGE });
        if (a.category === 'salary') return res.status(400).json({ success: false, message: SALARY_ITEM_MESSAGE });
      }
    }
    const out = await withMoneyTx(async (tx) => {
      const skipped = [];
      const done = [];
      for (const a of list) {
        const id = Number(a.expense_id);
        const row = await tx.prepare('SELECT id, category, item_id, km_settlement_id FROM expenses WHERE id = ? FOR UPDATE').get(id);
        // Rows a rider km settlement counted keep their item (same lock as PUT /:id).
        if (!row || row.item_id || row.category === 'salary' || row.km_settlement_id != null) { skipped.push(id); continue; }
        const item = await resolveItem(tx, {
          item_id: a.item_id ? Number(a.item_id) : null, item_name: a.item_name,
          category: a.category || row.category, userId: req.user.id,
        });
        if (item.category === 'salary') throw httpError(400, SALARY_ITEM_MESSAGE);
        await tx.prepare('UPDATE expenses SET item_id = ? WHERE id = ? AND item_id IS NULL').run(item.id, id);
        done.push({ expense_id: id, item_id: Number(item.id) });
      }
      if (done.length) await auditItem(tx, 0, req.user.id, 'expense_assign_items', { expense_ids: done.map((d) => d.expense_id), item_id: null }, { assignments: done });
      // `done` lets the app offer Undo (POST /assign-items/undo).
      return { assigned: done.length, skipped, done };
    });
    res.json({ success: true, data: out });
  } catch (err) {
    sendItemError(res, next, err);
  }
});

// POST /api/expenses/assign-items/undo { assignments: [{ expense_id, item_id }] }
// Takes these rows out of their item again, only where the row is still on
// that same item (a row changed since is left alone and counted as skipped).
router.post('/assign-items/undo', ...OWNER_ONLY, async (req, res, next) => {
  try {
    const list = req.body && req.body.assignments;
    if (!Array.isArray(list) || list.length === 0 || list.length > 200) {
      return res.status(400).json({ success: false, message: 'Nothing to undo. Pull down to refresh.' });
    }
    const pairs = [];
    const seen = new Set();
    for (const a of list) {
      const expenseId = Number(a && a.expense_id);
      const itemId = Number(a && a.item_id);
      if (!Number.isInteger(expenseId) || expenseId <= 0 || !Number.isInteger(itemId) || itemId <= 0 || seen.has(expenseId)) {
        return res.status(400).json({ success: false, message: 'Nothing to undo. Pull down to refresh.' });
      }
      seen.add(expenseId);
      pairs.push({ expense_id: expenseId, item_id: itemId });
    }
    const out = await withMoneyTx(async (tx) => {
      const undone = [];
      const skipped = [];
      for (const p of pairs) {
        const n = (await tx.prepare('UPDATE expenses SET item_id = NULL WHERE id = ? AND item_id = ? AND km_settlement_id IS NULL').run(p.expense_id, p.item_id)).changes;
        if (n) undone.push(p); else skipped.push(p.expense_id);
      }
      if (undone.length) await auditItem(tx, 0, req.user.id, 'expense_assign_items_undo', { assignments: undone }, { expense_ids: undone.map((d) => d.expense_id), item_id: null });
      return { undone: undone.length, skipped };
    });
    res.json({ success: true, data: out });
  } catch (err) {
    sendItemError(res, next, err);
  }
});

// ─── POST /api/expenses ──────────────────────────────────────
router.post(
  '/',
  authenticate,
  authorize('owner', 'manager', 'employee', 'counter_staff'),
  [
    body('location_id').isInt(),
    // Optional when an item is given: the item's category is used.
    body('category').optional({ nullable: true }).isIn(['supplies', 'petty_cash', 'maintenance', 'transport', 'food', 'utilities', 'salary', 'other']),
    body('amount').isFloat({ min: 0.01, max: 10000000 }),
    body('description').optional({ nullable: true }).trim(),
    body('payment_method').isIn(['cash', 'card', 'upi', 'bank_transfer', OWN_POCKET]),
    body('expense_date').optional({ nullable: true }).matches(/^\d{4}-\d{2}-\d{2}$/),
    body('is_return').optional().isBoolean(),
    body('employee_id').optional({ nullable: true }).isInt(),
    body('paid_by_user_id').optional({ nullable: true }).isInt({ min: 1 }),
    ...extraFieldRules,
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: validationMessage(errors, FIELD_FALLBACK_MESSAGE), errors: errors.array() });

      const db = getDb();
      const { location_id, amount, description, payment_method, is_return, employee_id } = req.body;
      const expense_date = req.body.expense_date || localToday();
      const note = String(req.body.note || '').trim() || null;
      const photo_url = req.body.photo_url || null;
      const givenTo = readGivenTo(req.body);
      const has = (k) => Object.prototype.hasOwnProperty.call(req.body, k);
      const wantsItem = !!req.body.item_id || has('item_name');

      // Checks that need no item come first, so a refused save never
      // creates an item.
      const isToday = expense_date === localToday();
      if (!isBossRole(req.user.role) && !isToday) {
        return res.status(403).json({ success: false, message: OTHER_DAY_MESSAGE });
      }
      if (payment_method === 'cash' && !isToday) {
        return res.status(400).json({ success: false, message: PAST_DAY_CASH_MESSAGE });
      }
      if (!req.body.item_id && has('item_name') && !nameKey(req.body.item_name)) {
        return res.status(400).json({ success: false, message: NO_ITEM_MESSAGE });
      }
      if (!wantsItem && !req.body.category) {
        return res.status(400).json({ success: false, message: NO_CATEGORY_MESSAGE });
      }
      if (photo_url && !isLocalUploadPath(photo_url)) {
        return res.status(400).json({ success: false, message: BAD_PHOTO_MESSAGE });
      }
      const adb = await getAsyncDb();
      // Own pocket: never a return; whose pocket defaults to Me (spec 4.1).
      const ownPocket = payment_method === OWN_POCKET;
      const paidBy = ownPocket ? Number(req.body.paid_by_user_id || req.user.id) : null;
      if (ownPocket) {
        if (is_return) return res.status(400).json({ success: false, message: OWN_POCKET_RETURN_MESSAGE });
        if (req.body.category === 'salary') return res.status(400).json({ success: false, message: OWN_POCKET_SALARY_MESSAGE });
        await assertWhose(adb, paidBy, location_id);
      }
      // A salary row's Given to is its employee (checked by the payroll
      // rules below), who need not be linked to this shop.
      const salaryGivenTo = req.body.category === 'salary' && Number(givenTo.given_to_user_id) === Number(employee_id);
      if (givenTo.given_to_user_id && !salaryGivenTo) await assertGivenTo(adb, givenTo.given_to_user_id, location_id);

      // Category: as sent, else the item's. A new name without a category is
      // refused by resolveItem. With a category sent, salary checks run
      // before the item is resolved; otherwise the existing item decides it.
      let item = null;
      if (wantsItem && !req.body.category) {
        item = await resolveItem(adb, { item_id: req.body.item_id, item_name: req.body.item_name, category: null, userId: req.user.id });
      }
      const category = req.body.category || item.category;
      if (!isBossRole(req.user.role) && category === 'salary') {
        return res.status(400).json({ success: false, message: SALARY_ADVANCE_MESSAGE });
      }
      if (ownPocket && category === 'salary') {
        return res.status(400).json({ success: false, message: OWN_POCKET_SALARY_MESSAGE });
      }

      // A "Salary" category expense logged through this general route has no
      // structural connection to the payroll system otherwise — no employee,
      // no overlap check against a real salary_payments disbursement. Both
      // gaps are closed here, and both must run BEFORE any register-guard/
      // write logic below (validate before you touch money — same ordering
      // this handler already uses for its own validation errors above).
      if (category === 'salary' && !employee_id) {
        return res.status(400).json({ success: false, message: 'Select which employee this salary payment is for.' });
      }

      if (category === 'salary' && employee_id) {
        // Same overlap-safety principle as POST /staff/payroll/disburse's
        // duplicate-payment guard (server/routes/staff-management.js) —
        // adapted to a single date instead of a period range, since a raw
        // expense has no period concept of its own. A precise (not fuzzy)
        // block: only refuses when this employee already has a real,
        // non-cancelled structured payroll payment whose period covers this
        // expense's date, so a genuinely separate salary-related expense
        // (e.g. a bonus, an off-cycle advance) on an uncovered date is not
        // blocked.
        const coveringPayment = db.prepare(
          'SELECT id, period_start, period_end FROM salary_payments WHERE user_id = ? AND status != ? AND period_start <= ? AND period_end >= ?'
        ).get(employee_id, 'cancelled', expense_date, expense_date);
        if (coveringPayment) {
          return res.status(400).json({
            success: false,
            message: `This employee was already paid via Salaries & Payroll for ${coveringPayment.period_start} to ${coveringPayment.period_end} — that period covers this date. Check Payroll History, or use a different date if this is a separate payment.`,
          });
        }
      }

      // Cash expenses/returns move real money in or out of the drawer, same
      // as a sale or refund — hard-block them with no open register instead
      // of silently recording an expense that no session's expected_cash
      // ever accounts for (found live during the sub-project 4 audit,
      // 2026-09-01: this was the one cash-write site register-guard never
      // reached in sub-project 3).
      if (payment_method === 'cash' && !hasOpenRegister(db, location_id)) {
        return res.status(400).json({ success: false, message: REGISTER_CLOSED_MESSAGE });
      }

      // The item is an ordinary write, made before the money transaction.
      // Only when one was sent: a description-only save (older app, or a
      // salary row) stays without an item.
      if (wantsItem && !item) {
        item = await resolveItem(adb, { item_id: req.body.item_id, item_name: req.body.item_name, category, userId: req.user.id });
      }
      if (item && item.is_rider_petrol && givenTo.given_to_name && !givenTo.given_to_user_id) {
        return res.status(400).json({ success: false, message: RIDER_PETROL_PICK_MESSAGE });
      }
      // A rider's own petrol is paid through km money, never owed back.
      if (item && item.is_rider_petrol && ownPocket && (await isRiderUser(adb, paidBy))) {
        return res.status(400).json({ success: false, message: RIDER_OWN_PETROL_MESSAGE });
      }
      const itemId = item ? item.id : null;
      const finalDescription = composeDescription(item ? item.name : (description || ''), note);

      // Look up the currently open register FIRST so we can store register_id on the expense.
      // This links the expense permanently to its session — critical for correct session-scoped queries
      // and for reversing against the correct register on deletion.
      const expense_number = generateExpenseNumber(db, location_id);

      // One transaction with the open register locked: the expense and the
      // drawer change are saved together, and a close can't land between.
      const newExpenseId = await withMoneyTx(async (db) => {
      const openRegister = payment_method === 'cash' ? await lockOpenRegister(db, location_id) : null;
      if (payment_method === 'cash' && !openRegister) throw registerClosedError();
      const registerId = openRegister ? openRegister.id : null;

      // Only ever stored for the salary category (the category this whole
      // feature is about) — null for everything else, unchanged from today.
      const employeeIdValue = category === 'salary' ? employee_id : null;

      const isReturnInt = is_return ? 1 : 0;
      const cols = {
        expense_number, location_id, category, amount, description: finalDescription, payment_method, expense_date,
        created_by: req.user.id, is_return: isReturnInt, register_id: registerId, employee_id: employeeIdValue,
        item_id: itemId, note, photo_url,
        given_to_user_id: givenTo.given_to_user_id, given_to_name: givenTo.given_to_name,
        paid_by_user_id: paidBy,
      };
      if (!expense_number) delete cols.expense_number;
      const insert = (c) => {
        const keys = Object.keys(c);
        return db.prepare(`INSERT INTO expenses (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => c[k]));
      };
      let result;
      try {
        result = await insert(cols);
      } catch (err) {
        const msg = String(err?.message || '').toLowerCase();
        // Fallbacks for legacy schemas missing expense_number / register_id.
        if (msg.includes('expense_number')) {
          delete cols.expense_number;
          result = await insert(cols);
        } else if (msg.includes('register_id')) {
          delete cols.register_id;
          result = await insert(cols);
        } else {
          throw err;
        }
      }

      // Update expected_cash on the open register (locked above)
      if (openRegister) {
        if (is_return) {
          await db.prepare('UPDATE cash_registers SET expected_cash = expected_cash + ? WHERE id = ?').run(amount, openRegister.id);
        } else {
          await db.prepare('UPDATE cash_registers SET expected_cash = expected_cash - ? WHERE id = ?').run(amount, openRegister.id);
        }
      }
      // Own pocket: the shop now owes that person this amount (spec 5.5).
      if (ownPocket) {
        await createOwnPocketOwes(db, {
          expenseId: result.lastInsertRowid, locationId: location_id, userId: paidBy,
          amount: Math.round(Number(amount) * 100) / 100, createdBy: req.user.id,
        });
      }
      return result.lastInsertRowid;
      });

      // A return or an earlier day's entry is not the usual amount or person,
      // and a salary entry never feeds an item's usual amount or person.
      if (!is_return && isToday && category !== 'salary') {
        await rememberAfterSave(itemId, { amount: Math.round(Number(amount) * 100) / 100, ...givenTo });
      }

      const expense = await loadExpenseRow(adb, newExpenseId);
      res.status(201).json({ success: true, data: expense });
    } catch (err) {
      if (err.statusCode) return res.status(err.statusCode).json({ success: false, message: err.message });
      next(err);
    }
  }
);

// ─── Changing or removing an expense (2026-11-10) ────────────
// Counter staff and employees may fix an expense THEY added, only while the
// register session it belongs to is still open. Owner and manager may change
// any expense, any time: a closed session gets its difference recalculated
// (actual_cash is a real count and never changes). Every change is audited.

const EXPENSE_CATEGORIES = ['supplies', 'petty_cash', 'maintenance', 'transport', 'food', 'utilities', 'salary', 'other'];
const EXPENSE_METHODS = ['cash', 'card', 'upi', 'bank_transfer'];
const NOT_YOURS_MESSAGE = 'You can only change expenses you added. Ask the owner or manager to change this one.';
const DAY_CLOSED_MESSAGE = 'This expense is from a register day that is already closed. Ask the owner or manager to change it.';

function httpError(status, message) {
  const e = new Error(message);
  e.statusCode = status;
  return e;
}

// What an expense did to the drawer: cash out (or back in for a return).
function drawerEffect(exp) {
  if (exp.payment_method !== 'cash') return 0;
  const amt = Number(exp.amount) || 0;
  return exp.is_return ? amt : -amt;
}

// expected_cash moves by delta; a closed session also gets its difference
// recalculated against the new expected cash (same rule as before for delete).
// shiftLock: also move a locked blind count on an open session. Used for an
// advance-linked expense, so removing or changing it mirrors payAdvance.
async function moveDrawer(tx, registerId, delta, { shiftLock = false } = {}) {
  if (!registerId || Math.abs(delta) < 0.005) return;
  await tx.prepare(`
    UPDATE cash_registers SET
      expected_cash = expected_cash + ?,
      discrepancy = CASE WHEN closed_at IS NOT NULL THEN (expected_cash + ?) - actual_cash ELSE discrepancy END
    WHERE id = ?
  `).run(delta, delta, registerId);
  if (shiftLock) {
    await tx.prepare('UPDATE cash_registers SET close_count_locked = close_count_locked + ? WHERE id = ? AND closed_at IS NULL AND close_count_locked IS NOT NULL')
      .run(delta, registerId);
  }
}

// Locks the expense and the shop's open register, then checks who may touch it.
async function loadForChange(tx, expenseId, user) {
  const expense = await tx.prepare('SELECT * FROM expenses WHERE id = ? FOR UPDATE').get(expenseId);
  if (!expense) throw httpError(404, 'This expense was not found. It may have been removed already — pull down to refresh.');
  const openRegister = await lockOpenRegister(tx, expense.location_id);
  const isBoss = user.role === 'owner' || user.role === 'manager';
  if (!isBoss) {
    if (Number(expense.created_by) !== Number(user.id)) throw httpError(403, NOT_YOURS_MESSAGE);
    const inOpenSession = !!openRegister && (expense.register_id
      ? Number(expense.register_id) === Number(openRegister.id)
      : new Date(expense.created_at) >= new Date(openRegister.opened_at));
    if (!inOpenSession) throw httpError(403, DAY_CLOSED_MESSAGE);
  }
  // The session this expense's cash belongs to. An old row saved before
  // register_id existed belongs to the open register only when it was made
  // after that register opened (the same test as the staff check above).
  // Otherwise it has no session: it never moves into today's drawer.
  let oldRegisterId = null;
  if (expense.payment_method === 'cash') {
    if (expense.register_id) {
      const r = await tx.prepare('SELECT id FROM cash_registers WHERE id = ? FOR UPDATE').get(expense.register_id);
      oldRegisterId = r ? r.id : null;
    } else if (openRegister && new Date(expense.created_at) >= new Date(openRegister.opened_at)) {
      oldRegisterId = openRegister.id;
    }
  }
  return { expense, openRegister, oldRegisterId };
}

async function auditExpense(tx, expenseId, userId, action, before, after) {
  await tx.prepare(`
    INSERT INTO audit_logs (entity_type, entity_id, user_id, action, previous_state, new_state, created_at)
    VALUES ('expense', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(expenseId, userId, action, JSON.stringify(before), after ? JSON.stringify(after) : null);
}

const pickAudit = (e) => ({
  amount: Number(e.amount), category: e.category, description: e.description, payment_method: e.payment_method,
  expense_date: e.expense_date, is_return: e.is_return ? 1 : 0, employee_id: e.employee_id || null,
  register_id: e.register_id || null, created_by: e.created_by,
  item_id: e.item_id || null, note: e.note || null, photo_url: e.photo_url || null,
  given_to_user_id: e.given_to_user_id || null, given_to_name: e.given_to_name || null,
  paid_by_user_id: e.paid_by_user_id || null,
});

// A salary expense written by payAdvance is linked from its advance
// (salary_advances.expense_id). Spec 5.3: removing it cancels the advance,
// changing its amount moves the advance, anything that would break the link
// is refused, and nothing changes once payroll took any of it.
const ADVANCE_LINK_MESSAGE = 'Remove it and give the advance again.';
const ADVANCE_TAKEN_MESSAGE = "This advance was already taken from pay, so it can't be changed or removed.";
const centsOf = (n) => Math.round((Number(n) || 0) * 100);
const advanceTaken = (adv) => adv.status === 'repaid' || centsOf(adv.repaid_amount) > 0;
// Locked before the expense and the register (money row first).
async function lockLinkedAdvance(tx, expenseId) {
  return (await tx.prepare('SELECT * FROM salary_advances WHERE expense_id = ? FOR UPDATE').get(expenseId)) || null;
}
async function auditAdvance(tx, advanceId, userId, action, before, after) {
  await tx.prepare(`
    INSERT INTO audit_logs (entity_type, entity_id, user_id, action, previous_state, new_state, created_at)
    VALUES ('salary_advance', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(advanceId, userId, action, JSON.stringify(before), after ? JSON.stringify(after) : null);
}
const pickAdvance = (a) => ({
  user_id: a.user_id, amount: Number(a.amount), status: a.status, payment_method: a.payment_method || null,
  date: a.date ? String(a.date).slice(0, 10) : null, expense_id: a.expense_id || null, source: a.source || null,
});

// A bill (or write-off) paid with shopping money is linked to its hand-out
// (expenses.money_out_id). Spec 5.4: removing it puts its amount back as
// still with that person, with no drawer move. Its amount, how it was paid,
// return and who got it can't be changed here (that would break the link).
const MONEY_OUT_LINK_MESSAGE = 'This was bought with shopping money. Remove it and add it again on the shopping money line.';
const MONEY_OUT_CLOSED_MESSAGE = "This shopping money was already closed, so this can't be removed.";
const MONEY_OUT_OWES_PAID_MESSAGE = "The shop already paid back part of what was overspent, so this can't be removed. Ask the owner if it needs fixing.";
const MONEY_OUT_OWES_ALL_PAID_MESSAGE = "The shop already paid back what was overspent, so this can't be removed. Ask the owner if it needs fixing.";
const MONEY_OUT_OWES_KEPT_MESSAGE = "What was overspent was kept as the owner's own money, so this can't be removed. Ask the owner if it needs fixing.";
const MONEY_OUT_OWES_WRITTEN_OFF_MESSAGE = "What was overspent was written off, so this can't be removed. Ask the owner if it needs fixing.";
function overspendClosedMessage(owes) {
  if (owes.status === 'kept') return MONEY_OUT_OWES_KEPT_MESSAGE;
  if (owes.status === 'written_off') return MONEY_OUT_OWES_WRITTEN_OFF_MESSAGE;
  if (owes.status === 'paid') return MONEY_OUT_OWES_ALL_PAID_MESSAGE;
  return MONEY_OUT_OWES_PAID_MESSAGE;
}
// Locked before the expense and the register (money row first).
async function lockLinkedMoneyOut(tx, expenseId) {
  return (await tx.prepare(`
    SELECT mo.* FROM staff_money_out mo
    WHERE mo.id = (SELECT e.money_out_id FROM expenses e WHERE e.id = ?)
    FOR UPDATE
  `).get(expenseId)) || null;
}
// The hand-out's overspend Shop owes line. Locked right after the hand-out
// and before the expense and the register, the same order Pay back uses
// (money rows first, then the register), so the two never deadlock.
async function lockOverspendOwes(tx, mo) {
  if (!mo) return null;
  return (await tx.prepare("SELECT * FROM shop_owes WHERE money_out_id = ? AND source = 'overspend' ORDER BY id DESC LIMIT 1 FOR UPDATE").get(mo.id)) || null;
}
// Takes one removed bill off its hand-out: settled_amount down, an overspend
// Shop owes shrinks first, and the line opens again if money is left.
// owes is the overspend line from lockOverspendOwes (already locked).
async function unsettleBill(tx, mo, owes, expense, userId) {
  if (!['open', 'settled', 'written_off'].includes(mo.status)) throw httpError(400, MONEY_OUT_CLOSED_MESSAGE);
  const amtP = centsOf(expense.amount);
  const totalP = centsOf(mo.amount);
  const settledP = centsOf(mo.settled_amount);
  const returnedP = centsOf(mo.returned_amount);
  const newSettledP = Math.max(0, settledP - amtP);
  const excessBefore = Math.max(0, settledP + returnedP - totalP);
  const excessAfter = Math.max(0, newSettledP + returnedP - totalP);
  const shrinkP = excessBefore - excessAfter;
  let owesChange = null;
  if (shrinkP > 0) {
    if (owes) {
      if (owes.status !== 'open') throw httpError(400, overspendClosedMessage(owes));
      const newOwesP = centsOf(owes.amount) - shrinkP;
      if (centsOf(owes.paid_amount) > Math.max(0, newOwesP)) throw httpError(400, MONEY_OUT_OWES_PAID_MESSAGE);
      if (newOwesP <= 0) {
        await tx.prepare('DELETE FROM shop_owes WHERE id = ?').run(owes.id);
      } else {
        await tx.prepare('UPDATE shop_owes SET amount = ? WHERE id = ?').run(newOwesP / 100, owes.id);
      }
      owesChange = { owes_id: Number(owes.id), amount_before: Number(owes.amount), amount_after: Math.max(0, newOwesP) / 100 };
    }
  }
  const remainingP = Math.max(0, totalP - newSettledP - returnedP);
  const status = remainingP > 0 ? 'open' : mo.status;
  await tx.prepare(`
    UPDATE staff_money_out SET settled_amount = ?, status = ?,
      closed_at = CASE WHEN ? = 'open' THEN NULL ELSE closed_at END,
      close_reason = CASE WHEN ? = 'open' THEN NULL ELSE close_reason END
    WHERE id = ?
  `).run(newSettledP / 100, status, status, status, mo.id);
  await tx.prepare(`
    INSERT INTO audit_logs (entity_type, entity_id, user_id, action, previous_state, new_state, created_at)
    VALUES ('staff_money_out', ?, ?, 'shopping_money_bill_removed', ?, ?, CURRENT_TIMESTAMP)
  `).run(mo.id, userId,
    JSON.stringify({ status: mo.status, settled_amount: settledP / 100 }),
    JSON.stringify({ status, settled_amount: newSettledP / 100, expense_id: Number(expense.id), amount: amtP / 100, owes: owesChange }));
}

// ─── PUT /api/expenses/:id ───────────────────────────────────
router.put(
  '/:id',
  authenticate,
  authorize('owner', 'manager', 'employee', 'counter_staff'),
  [
    body('category').optional().isIn(EXPENSE_CATEGORIES),
    body('amount').optional().isFloat({ min: 0.01, max: 10000000 }),
    body('description').optional({ nullable: true }).trim(),
    // shopping_money and km_account are accepted only when unchanged (checked below).
    body('payment_method').optional().isIn([...EXPENSE_METHODS, OWN_POCKET, SHOPPING_MONEY, KM_ACCOUNT]),
    body('expense_date').optional().matches(/^\d{4}-\d{2}-\d{2}$/),
    body('is_return').optional().isBoolean(),
    body('employee_id').optional({ nullable: true }).isInt(),
    body('paid_by_user_id').optional({ nullable: true }).isInt({ min: 1 }),
    ...extraFieldRules,
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: validationMessage(errors, FIELD_FALLBACK_MESSAGE), errors: errors.array() });
      }
      const expenseId = Number(req.params.id);
      const has = (k) => Object.prototype.hasOwnProperty.call(req.body, k);
      const isBoss = isBossRole(req.user.role);
      const adb = await getAsyncDb();

      // Checks before the item is resolved, so a refused change never
      // creates an item. The transaction below checks again under locks.
      const current = await adb.prepare('SELECT id, location_id, created_by, expense_date, item_id, note, description, category, employee_id, payment_method, paid_by_user_id, given_to_user_id, given_to_name FROM expenses WHERE id = ?').get(expenseId);
      if (!current) return res.status(404).json({ success: false, message: 'This expense was not found. It may have been removed already — pull down to refresh.' });
      if (!isBoss && Number(current.created_by) !== Number(req.user.id)) {
        return res.status(403).json({ success: false, message: NOT_YOURS_MESSAGE });
      }
      if (!isBoss && has('expense_date') && req.body.expense_date !== current.expense_date) {
        return res.status(403).json({ success: false, message: OTHER_DAY_MESSAGE });
      }
      if (!isBoss && (current.category === 'salary' || req.body.category === 'salary')) {
        return res.status(400).json({ success: false, message: SALARY_ADVANCE_MESSAGE });
      }
      const wantsItem = !!req.body.item_id || has('item_name');
      if (!req.body.item_id && has('item_name') && !nameKey(req.body.item_name)) {
        return res.status(400).json({ success: false, message: NO_ITEM_MESSAGE });
      }
      // Salary rows stay salary (payroll links them by employee); other rows
      // never become salary here (spec 7). Checked again under the lock.
      const crossesSalary = (cat) => (cat === 'salary') !== (current.category === 'salary');
      if (has('category') && req.body.category && crossesSalary(req.body.category)) {
        return res.status(400).json({ success: false, message: SALARY_ROW_MESSAGE });
      }
      if (has('photo_url') && req.body.photo_url && !isLocalUploadPath(req.body.photo_url)) {
        return res.status(400).json({ success: false, message: BAD_PHOTO_MESSAGE });
      }
      // Shopping money is only ever set on the shopping money line; a bill
      // keeps it (sending it back unchanged is fine). Checked again under the lock.
      if (has('payment_method') && req.body.payment_method === SHOPPING_MONEY && current.payment_method !== SHOPPING_MONEY) {
        return res.status(400).json({ success: false, message: INTO_SHOPPING_MESSAGE });
      }
      if (has('payment_method') && req.body.payment_method === KM_ACCOUNT && current.payment_method !== KM_ACCOUNT) {
        return res.status(400).json({ success: false, message: KM_SETTLED_CHANGE_MESSAGE });
      }
      // Whose pocket, checked before the lock when a new person is sent.
      const staysOwnPocket = (has('payment_method') ? req.body.payment_method : current.payment_method) === OWN_POCKET;
      if (staysOwnPocket && has('paid_by_user_id') && req.body.paid_by_user_id
          && Number(req.body.paid_by_user_id) !== Number(current.paid_by_user_id || 0)) {
        await assertWhose(adb, req.body.paid_by_user_id, current.location_id);
      }
      const touchesGivenTo = has('given_to_user_id') || has('given_to_name');
      const givenTo = touchesGivenTo ? readGivenTo(req.body) : null;
      const salaryEmployeeId = has('employee_id') ? req.body.employee_id : current.employee_id;
      const salaryGivenTo = current.category === 'salary' && givenTo && Number(givenTo.given_to_user_id) === Number(salaryEmployeeId);
      if (givenTo && givenTo.given_to_user_id && !salaryGivenTo) await assertGivenTo(adb, givenTo.given_to_user_id, current.location_id);

      // The item is an ordinary write, made before the money transaction.
      let item = null;
      if (wantsItem) {
        // An existing item is checked before a new name is made, so a refused
        // change never creates an item.
        if (!req.body.item_id) {
          const known = await adb.prepare('SELECT category FROM expense_items WHERE name_key = ?').get(nameKey(req.body.item_name));
          if (known && crossesSalary(known.category)) return res.status(400).json({ success: false, message: SALARY_ROW_MESSAGE });
        }
        item = await resolveItem(adb, { item_id: req.body.item_id, item_name: req.body.item_name, category: req.body.category || null, userId: req.user.id });
        if (crossesSalary(item.category)) return res.status(400).json({ success: false, message: SALARY_ROW_MESSAGE });
      } else if (current.item_id && (has('note') || has('description'))) {
        item = await adb.prepare('SELECT * FROM expense_items WHERE id = ?').get(current.item_id);
      }

      // Rider petrol needs the rider picked from the list, not a typed name.
      if (wantsItem || touchesGivenTo) {
        const petrolItem = item || (current.item_id ? await adb.prepare('SELECT is_rider_petrol FROM expense_items WHERE id = ?').get(current.item_id) : null);
        const effName = touchesGivenTo ? givenTo.given_to_name : current.given_to_name;
        const effUser = touchesGivenTo ? givenTo.given_to_user_id : current.given_to_user_id;
        if (petrolItem && petrolItem.is_rider_petrol && effName && !effUser) {
          return res.status(400).json({ success: false, message: RIDER_PETROL_PICK_MESSAGE });
        }
      }
      // A rider's own petrol is paid through km money (same rule as adding).
      // Checked only when the method, the person or the item changes, so a
      // note or photo can still be added to an older row.
      const changesWhoOrWhat = (has('payment_method') && req.body.payment_method !== current.payment_method)
        || (has('paid_by_user_id') && Number(req.body.paid_by_user_id || 0) !== Number(current.paid_by_user_id || 0))
        || (wantsItem && item && Number(item.id) !== Number(current.item_id || 0));
      if (staysOwnPocket && changesWhoOrWhat) {
        const petrolItem = item || (current.item_id ? await adb.prepare('SELECT is_rider_petrol FROM expense_items WHERE id = ?').get(current.item_id) : null);
        const sentBy = has('paid_by_user_id') && req.body.paid_by_user_id ? Number(req.body.paid_by_user_id) : null;
        const whose = sentBy || (current.payment_method === OWN_POCKET && current.paid_by_user_id ? Number(current.paid_by_user_id) : Number(req.user.id));
        if (petrolItem && petrolItem.is_rider_petrol && (await isRiderUser(adb, whose))) {
          return res.status(400).json({ success: false, message: RIDER_OWN_PETROL_MESSAGE });
        }
      }

      const updated = await withMoneyTx(async (tx) => {
        const advance = await lockLinkedAdvance(tx, expenseId);
        const moneyOut = await lockLinkedMoneyOut(tx, expenseId);
        const owes = await lockLinkedOwes(tx, expenseId);
        const { expense, openRegister, oldRegisterId } = await loadForChange(tx, expenseId, req.user);
        const nv = {
          category: has('category') ? req.body.category : (wantsItem ? item.category : expense.category),
          amount: has('amount') ? Math.round(Number(req.body.amount) * 100) / 100 : Number(expense.amount),
          description: has('description') ? (req.body.description || '') : (expense.description || ''),
          payment_method: has('payment_method') ? req.body.payment_method : expense.payment_method,
          expense_date: has('expense_date') ? req.body.expense_date : expense.expense_date,
          is_return: has('is_return') ? (req.body.is_return ? 1 : 0) : (expense.is_return ? 1 : 0),
          employee_id: has('employee_id') ? (req.body.employee_id || null) : (expense.employee_id || null),
          item_id: wantsItem ? item.id : (expense.item_id || null),
          note: has('note') ? (String(req.body.note || '').trim() || null) : (expense.note || null),
          photo_url: has('photo_url') ? (req.body.photo_url || null) : (expense.photo_url || null),
          given_to_user_id: givenTo ? givenTo.given_to_user_id : (expense.given_to_user_id || null),
          given_to_name: givenTo ? givenTo.given_to_name : (expense.given_to_name || null),
          paid_by_user_id: null,
        };
        if (nv.payment_method === OWN_POCKET) {
          const sent = has('paid_by_user_id') && req.body.paid_by_user_id ? Number(req.body.paid_by_user_id) : null;
          nv.paid_by_user_id = sent || (expense.payment_method === OWN_POCKET && expense.paid_by_user_id ? Number(expense.paid_by_user_id) : Number(req.user.id));
        }
        // description is always rebuilt as "item name — note" (or the old
        // text without its note, for a row with no item); never appended to.
        if (wantsItem || has('note') || has('description')) {
          let base;
          if (item) base = item.name;
          else if (has('description')) base = stripNote(req.body.description || '', expense.note);
          else base = stripNote(expense.description || '', expense.note);
          nv.description = composeDescription(base, nv.note);
        }
        const wasSalary = expense.category === 'salary';
        if ((nv.category === 'salary') !== wasSalary || (wantsItem && (item.category === 'salary') !== wasSalary)) {
          throw httpError(400, SALARY_ROW_MESSAGE);
        }
        if (nv.category !== 'salary') nv.employee_id = null;
        if (nv.category === 'salary' && !nv.employee_id) throw httpError(400, 'Select which employee this salary payment is for.');
        if (advance) {
          const breaksLink = nv.category !== 'salary'
            || Number(nv.employee_id) !== Number(advance.user_id)
            || Number(nv.given_to_user_id) !== Number(advance.user_id)
            || nv.is_return
            || !['cash', 'upi'].includes(nv.payment_method);
          if (breaksLink) throw httpError(400, ADVANCE_LINK_MESSAGE);
          const moneyMoved = centsOf(nv.amount) !== centsOf(expense.amount) || nv.payment_method !== expense.payment_method;
          if (moneyMoved && advanceTaken(advance)) throw httpError(400, ADVANCE_TAKEN_MESSAGE);
        }
        if ((nv.payment_method === SHOPPING_MONEY) !== (expense.payment_method === SHOPPING_MONEY)) {
          throw httpError(400, expense.payment_method === SHOPPING_MONEY ? MONEY_OUT_LINK_MESSAGE : INTO_SHOPPING_MESSAGE);
        }
        if (expense.km_settlement_id != null || expense.payment_method === KM_ACCOUNT || nv.payment_method === KM_ACCOUNT) {
          const kmMoved = centsOf(nv.amount) !== centsOf(expense.amount)
            || nv.payment_method !== expense.payment_method
            || nv.is_return !== (expense.is_return ? 1 : 0)
            || Number(nv.given_to_user_id || 0) !== Number(expense.given_to_user_id || 0)
            || Number(nv.item_id || 0) !== Number(expense.item_id || 0);
          if (kmMoved) throw httpError(400, KM_SETTLED_CHANGE_MESSAGE);
        }
        if (nv.payment_method === OWN_POCKET) {
          if (nv.is_return) throw httpError(400, OWN_POCKET_RETURN_MESSAGE);
          if (nv.category === 'salary') throw httpError(400, OWN_POCKET_SALARY_MESSAGE);
          // Me as the default pocket is checked here; a person sent was checked above.
          if (Number(nv.paid_by_user_id) !== Number(expense.paid_by_user_id || 0)) {
            await assertWhose(tx, nv.paid_by_user_id, expense.location_id);
          }
        }
        if (moneyOut) {
          const breaksLink = centsOf(nv.amount) !== centsOf(expense.amount)
            || nv.payment_method !== expense.payment_method
            || nv.is_return !== (expense.is_return ? 1 : 0)
            || Number(nv.given_to_user_id || 0) !== Number(expense.given_to_user_id || 0);
          if (breaksLink) throw httpError(400, MONEY_OUT_LINK_MESSAGE);
        }
        // The payroll overlap check runs only when the date or the employee
        // changes; otherwise it would find the row's own payment.
        const salaryMoved = nv.expense_date !== expense.expense_date || Number(nv.employee_id) !== Number(expense.employee_id);
        if (nv.category === 'salary' && salaryMoved) {
          const covering = await tx.prepare(
            'SELECT period_start, period_end FROM salary_payments WHERE user_id = ? AND status != ? AND period_start <= ? AND period_end >= ?'
          ).get(nv.employee_id, 'cancelled', nv.expense_date, nv.expense_date);
          if (covering) {
            throw httpError(400, `This employee was already paid via Salaries & Payroll for ${covering.period_start} to ${covering.period_end} — that period covers this date. Check Payroll History, or use a different date if this is a separate payment.`);
          }
        }

        // Drawer: take the old effect off its session, put the new one on.
        // Only amount, method or return change the effect; a date move
        // leaves register_id and the drawer as they are.
        const wasCash = expense.payment_method === 'cash';
        let newRegisterId = null;
        if (wasCash && !oldRegisterId) {
          // Old cash with no session: only changes that move no cash.
          const sameCash = nv.payment_method === 'cash' && Math.abs(drawerEffect(nv) - drawerEffect(expense)) < 0.005;
          if (!sameCash) throw httpError(400, OLD_CASH_MESSAGE);
          newRegisterId = expense.register_id || null;
        } else {
          const oldEffect = oldRegisterId ? drawerEffect(expense) : 0;
          const newEffect = drawerEffect(nv);
          if (nv.payment_method === 'cash') {
            if (wasCash && oldRegisterId) {
              newRegisterId = oldRegisterId;
            } else {
              // Newly cash: it comes out of today's open drawer, so only for today.
              if (nv.expense_date !== localToday()) throw httpError(400, PAST_DAY_CASH_MESSAGE);
              newRegisterId = openRegister ? openRegister.id : null;
              if (!newRegisterId) throw registerClosedError();
            }
          }
          const lockOpt = { shiftLock: !!advance };
          if (oldRegisterId && oldRegisterId === newRegisterId) {
            await moveDrawer(tx, oldRegisterId, newEffect - oldEffect, lockOpt);
          } else {
            await moveDrawer(tx, oldRegisterId, -oldEffect, lockOpt);
            await moveDrawer(tx, newRegisterId, newEffect, lockOpt);
          }
        }

        // Own pocket: the owes line follows the expense (spec 5.5). Once any
        // of it was paid back, its person and Paid by stay, and the amount can
        // not go below what was paid back; a closed line changes no more.
        const isOwn = nv.payment_method === OWN_POCKET;
        if (owes) {
          const paidP = centsOf(owes.paid_amount);
          const moved = !isOwn || centsOf(nv.amount) !== centsOf(owes.amount) || Number(nv.paid_by_user_id) !== Number(owes.user_id);
          if (moved) {
            if (owes.status !== 'open') throw httpError(400, OWES_CLOSED_MESSAGE);
            if (paidP > 0 && (!isOwn || Number(nv.paid_by_user_id) !== Number(owes.user_id))) throw httpError(400, OWES_PART_PAID_MESSAGE);
            if (paidP > centsOf(nv.amount)) {
              const paid = `₹${(paidP / 100).toLocaleString('en-IN')}`;
              throw httpError(400, `The shop already paid back ${paid} of this. Type ${paid} or more.`);
            }
            if (!isOwn) {
              await tx.prepare('DELETE FROM shop_owes WHERE id = ?').run(owes.id);
              await auditOwesRow(tx, owes.id, req.user.id, 'own_pocket_removed', pickOwesRow(owes), null);
            } else {
              const status = paidP >= centsOf(nv.amount) ? 'paid' : 'open';
              await tx.prepare(`
                UPDATE shop_owes SET amount = ?, user_id = ?, status = ?,
                  closed_at = CASE WHEN ? = 'paid' THEN CURRENT_TIMESTAMP ELSE closed_at END
                WHERE id = ?
              `).run(nv.amount, nv.paid_by_user_id, status, status, owes.id);
              await auditOwesRow(tx, owes.id, req.user.id, 'own_pocket_changed', pickOwesRow(owes),
                pickOwesRow({ ...owes, amount: nv.amount, user_id: nv.paid_by_user_id, status }));
            }
          }
        } else if (isOwn) {
          // Newly own pocket. If the locked row is already own pocket, another
          // save switched it while this one waited (a double tap): its owes
          // line was not visible when the owes lock ran, so stop here rather
          // than open a second line. Never re-read the owes row after the
          // expense lock: pay back locks owes before the register.
          if (expense.payment_method === OWN_POCKET) throw httpError(409, ALREADY_SAVED_MESSAGE);
          await createOwnPocketOwes(tx, {
            expenseId, locationId: expense.location_id, userId: nv.paid_by_user_id, amount: nv.amount, createdBy: req.user.id,
          });
        }

        await tx.prepare(`
          UPDATE expenses SET category = ?, amount = ?, description = ?, payment_method = ?, expense_date = ?,
            is_return = ?, employee_id = ?, register_id = ?,
            item_id = ?, note = ?, photo_url = ?, given_to_user_id = ?, given_to_name = ?, paid_by_user_id = ?
          WHERE id = ?
        `).run(nv.category, nv.amount, nv.description, nv.payment_method, nv.expense_date,
          nv.is_return, nv.employee_id, newRegisterId,
          nv.item_id, nv.note, nv.photo_url, nv.given_to_user_id, nv.given_to_name, nv.paid_by_user_id, expenseId);

        const after = { ...expense, ...nv, register_id: newRegisterId };
        await auditExpense(tx, expenseId, req.user.id, 'expense_edit', pickAudit(expense), pickAudit(after));
        if (advance) {
          // The advance follows its expense: amount, Cash or UPI, and day.
          await tx.prepare('UPDATE salary_advances SET amount = ?, payment_method = ?, date = CAST(? AS date) WHERE id = ?')
            .run(nv.amount, nv.payment_method, nv.expense_date, advance.id);
          const advAfter = { ...advance, amount: nv.amount, payment_method: nv.payment_method, date: nv.expense_date };
          if (JSON.stringify(pickAdvance(advance)) !== JSON.stringify(pickAdvance(advAfter))) {
            await auditAdvance(tx, advance.id, req.user.id, 'salary_advance_changed', pickAdvance(advance), pickAdvance(advAfter));
          }
        }
        return after;
      });

      // The item remembers this save only when it is the latest entry for
      // the item, so fixing an old row never overwrites newer usual values.
      if (updated.item_id && updated.category !== 'salary' && (wantsItem || has('amount') || touchesGivenTo)) {
        const latest = await adb.prepare("SELECT id FROM expenses WHERE item_id = ? AND category <> 'salary' ORDER BY created_at DESC, id DESC LIMIT 1").get(updated.item_id);
        if (latest && Number(latest.id) === expenseId) {
          await rememberAfterSave(updated.item_id, {
            amount: updated.amount, given_to_user_id: updated.given_to_user_id, given_to_name: updated.given_to_name,
          });
        }
      }

      const expense = (await loadExpenseRow(adb, expenseId)) || updated;
      res.json({ success: true, data: expense });
    } catch (err) {
      if (err.statusCode) return res.status(err.statusCode).json({ success: false, message: err.message });
      next(err);
    }
  }
);

// ─── DELETE /api/expenses/:id ────────────────────────────────
router.delete('/:id', authenticate, authorize('owner', 'manager', 'employee', 'counter_staff'), async (req, res, next) => {
  try {
    const expenseId = Number(req.params.id);
    await withMoneyTx(async (tx) => {
      const advance = await lockLinkedAdvance(tx, expenseId);
      const moneyOut = await lockLinkedMoneyOut(tx, expenseId);
      const overspend = await lockOverspendOwes(tx, moneyOut);
      const owes = await lockLinkedOwes(tx, expenseId);
      const { expense, oldRegisterId } = await loadForChange(tx, expenseId, req.user);
      if (expense.km_settlement_id != null || expense.payment_method === KM_ACCOUNT) throw httpError(400, KM_SETTLED_REMOVE_MESSAGE);
      if (advance && advanceTaken(advance)) throw httpError(400, ADVANCE_TAKEN_MESSAGE);
      // Own pocket: what the shop owes for it goes too, unless any was paid back.
      if (owes) {
        if (centsOf(owes.paid_amount) > 0) throw httpError(400, OWES_PAID_BACK_MESSAGE);
        await tx.prepare('DELETE FROM shop_owes WHERE id = ?').run(owes.id);
        await auditOwesRow(tx, owes.id, req.user.id, 'own_pocket_removed', pickOwesRow(owes), null);
      }
      // A shopping money bill: its amount is still with that person again.
      if (moneyOut) await unsettleBill(tx, moneyOut, overspend, expense, req.user.id);
      // Put the cash back on the session it came out of.
      await moveDrawer(tx, oldRegisterId, -drawerEffect(expense), { shiftLock: !!advance });
      if (advance && advance.status === 'approved') {
        // Removing the advance expense cancels the advance (spec 5.3).
        await tx.prepare("UPDATE salary_advances SET status = 'cancelled' WHERE id = ?").run(advance.id);
        await auditAdvance(tx, advance.id, req.user.id, 'salary_advance_cancelled', pickAdvance(advance), { ...pickAdvance(advance), status: 'cancelled' });
      }
      await tx.prepare('DELETE FROM expenses WHERE id = ?').run(expenseId);
      await auditExpense(tx, expenseId, req.user.id, 'expense_delete', pickAudit(expense), null);
    });
    res.json({ success: true, message: 'Expense removed' });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, message: err.message });
    next(err);
  }
});

// ─── GET /api/expenses/summary ───────────────────────────────
// Same gap as GET / above — was authenticate-only.
router.get('/summary', authenticate, authorize('owner', 'manager', 'employee', 'counter_staff'), async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const { location_id, start_date, end_date } = req.query;

    let sql = 'SELECT category, SUM(CASE WHEN is_return = 1 THEN -amount ELSE amount END) as total, COUNT(*) as count FROM expenses WHERE 1=1';
    const params = [];

    if (location_id) { sql += ' AND location_id = ?'; params.push(location_id); }
    if (start_date) { sql += ' AND expense_date >= ?'; params.push(start_date); }
    if (end_date) { sql += ' AND expense_date <= ?'; params.push(end_date); }

    sql += ' GROUP BY category ORDER BY total DESC';

    const summary = await db.prepare(sql).all(...params);
    const normalizedSummary = summary.map((row) => ({
      ...row,
      total: Number(row.total) || 0,
      count: Number(row.count) || 0,
    }));
    const grandTotal = normalizedSummary.reduce((sum, row) => sum + row.total, 0);

    res.json({ success: true, data: normalizedSummary, total: grandTotal });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
