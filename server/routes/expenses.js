const express = require('express');
const { body, validationResult } = require('express-validator');
const { getDb } = require('../config/database');
const { getDb: getAsyncDb, withMoneyTx } = require('../config/database-async');
const { authenticate, authorize } = require('../middleware/auth');
const { todayStr: localToday } = require('../utils/time');
const { hasOpenRegister, lockOpenRegister, registerClosedError, REGISTER_CLOSED_MESSAGE } = require('../utils/register-guard');
const {
  nameKey, resolveItem, rememberOnItem, assertGivenTo, isLocalUploadPath, composeDescription,
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

    const normalizedExpenses = expenses.map(normalizeExpenseRow);

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
const BAD_PHOTO_MESSAGE = 'That photo could not be used. Take the photo again.';
const isBossRole = (role) => role === 'owner' || role === 'manager';

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
           ei.name as item_name, gu.name as given_to_user_name
    FROM expenses e
    JOIN locations l ON e.location_id = l.id
    JOIN users u ON e.created_by = u.id
    LEFT JOIN expense_items ei ON ei.id = e.item_id
    LEFT JOIN users gu ON gu.id = e.given_to_user_id
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
    given_to_display: given_to_user_name || row.given_to_name || null,
  };
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
    const db = await getAsyncDb();
    const prev = previousRange(from, to);
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
// Owner/manager: one item's monthly spend (last N months, empty months as 0)
// and its entries, including items that were merged into it.
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

    let where = ' WHERE (e.item_id = ? OR e.item_id IN (SELECT id FROM expense_items WHERE merged_into = ?)) AND e.expense_date >= ? AND e.expense_date <= ?';
    const params = [id, id, start, end];
    if (location_id) { where += ' AND e.location_id = ?'; params.push(Number(location_id)); }
    if (given_to_user_id) { where += ' AND e.given_to_user_id = ?'; params.push(Number(given_to_user_id)); }

    const monthRows = await db.prepare(`
      SELECT to_char(e.expense_date, 'YYYY-MM') AS month, SUM(${SIGNED_AMOUNT}) AS amount
        FROM expenses e${where}
       GROUP BY 1
    `).all(...params);
    const byMonth = new Map(monthRows.map((r) => [r.month, Number(r.amount) || 0]));
    const entries = (await db.prepare(`${EXPENSE_ROW_SELECT}${where} ORDER BY e.expense_date DESC, e.created_at DESC LIMIT 500`).all(...params)).map(normalizeExpenseRow);

    res.json({ success: true, data: { item, months: keys.map((m) => ({ month: m, amount: round2(byMonth.get(m) || 0) })), entries } });
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
    const base = `FROM expense_items i LEFT JOIN users gu ON gu.id = i.last_given_to_user_id WHERE i.is_active = TRUE AND i.merged_into IS NULL`;
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
    res.json({
      success: true,
      data: rows.map((r) => ({
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
      })),
    });
  } catch (err) {
    next(err);
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
    body('payment_method').isIn(['cash', 'card', 'upi', 'bank_transfer']),
    body('expense_date').optional({ nullable: true }).matches(/^\d{4}-\d{2}-\d{2}$/),
    body('is_return').optional().isBoolean(),
    body('employee_id').optional({ nullable: true }).isInt(),
    ...extraFieldRules,
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: validationMessage(errors, 'Validation failed'), errors: errors.array() });

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
      if (!isBossRole(req.user.role) && expense_date !== localToday()) {
        return res.status(403).json({ success: false, message: OTHER_DAY_MESSAGE });
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
      if (givenTo.given_to_user_id) await assertGivenTo(adb, givenTo.given_to_user_id, location_id);

      // Category: as sent, else the item's. A new name without a category is
      // refused by resolveItem. With a category sent, salary checks run
      // before the item is resolved; otherwise the existing item decides it.
      let item = null;
      if (wantsItem && !req.body.category) {
        item = await resolveItem(adb, { item_id: req.body.item_id, item_name: req.body.item_name, category: null, userId: req.user.id });
      }
      const category = req.body.category || item.category;

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
      return result.lastInsertRowid;
      });

      await rememberAfterSave(itemId, { amount: Math.round(Number(amount) * 100) / 100, ...givenTo });

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
async function moveDrawer(tx, registerId, delta) {
  if (!registerId || Math.abs(delta) < 0.005) return;
  await tx.prepare(`
    UPDATE cash_registers SET
      expected_cash = expected_cash + ?,
      discrepancy = CASE WHEN closed_at IS NOT NULL THEN (expected_cash + ?) - actual_cash ELSE discrepancy END
    WHERE id = ?
  `).run(delta, delta, registerId);
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
  // The session this expense's cash belongs to. Old rows saved before
  // register_id existed fall back to the open register, as delete always did.
  let oldRegisterId = null;
  if (expense.payment_method === 'cash') {
    if (expense.register_id) {
      const r = await tx.prepare('SELECT id FROM cash_registers WHERE id = ? FOR UPDATE').get(expense.register_id);
      oldRegisterId = r ? r.id : null;
    } else if (openRegister) {
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
});

// ─── PUT /api/expenses/:id ───────────────────────────────────
router.put(
  '/:id',
  authenticate,
  authorize('owner', 'manager', 'employee', 'counter_staff'),
  [
    body('category').optional().isIn(EXPENSE_CATEGORIES),
    body('amount').optional().isFloat({ min: 0.01, max: 10000000 }),
    body('description').optional({ nullable: true }).trim(),
    body('payment_method').optional().isIn(EXPENSE_METHODS),
    body('expense_date').optional().matches(/^\d{4}-\d{2}-\d{2}$/),
    body('is_return').optional().isBoolean(),
    body('employee_id').optional({ nullable: true }).isInt(),
    ...extraFieldRules,
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: validationMessage(errors, 'Check the amount, type and date, then save again.'), errors: errors.array() });
      }
      const expenseId = Number(req.params.id);
      const has = (k) => Object.prototype.hasOwnProperty.call(req.body, k);
      const isBoss = isBossRole(req.user.role);
      const adb = await getAsyncDb();

      // Checks before the item is resolved, so a refused change never
      // creates an item. The transaction below checks again under locks.
      const current = await adb.prepare('SELECT id, location_id, created_by, expense_date, item_id, note, description FROM expenses WHERE id = ?').get(expenseId);
      if (!current) return res.status(404).json({ success: false, message: 'This expense was not found. It may have been removed already — pull down to refresh.' });
      if (!isBoss && Number(current.created_by) !== Number(req.user.id)) {
        return res.status(403).json({ success: false, message: NOT_YOURS_MESSAGE });
      }
      if (!isBoss && has('expense_date') && req.body.expense_date !== current.expense_date) {
        return res.status(403).json({ success: false, message: OTHER_DAY_MESSAGE });
      }
      const wantsItem = !!req.body.item_id || has('item_name');
      if (!req.body.item_id && has('item_name') && !nameKey(req.body.item_name)) {
        return res.status(400).json({ success: false, message: NO_ITEM_MESSAGE });
      }
      if (has('photo_url') && req.body.photo_url && !isLocalUploadPath(req.body.photo_url)) {
        return res.status(400).json({ success: false, message: BAD_PHOTO_MESSAGE });
      }
      const touchesGivenTo = has('given_to_user_id') || has('given_to_name');
      const givenTo = touchesGivenTo ? readGivenTo(req.body) : null;
      if (givenTo && givenTo.given_to_user_id) await assertGivenTo(adb, givenTo.given_to_user_id, current.location_id);

      // The item is an ordinary write, made before the money transaction.
      let item = null;
      if (wantsItem) {
        item = await resolveItem(adb, { item_id: req.body.item_id, item_name: req.body.item_name, category: req.body.category || null, userId: req.user.id });
      } else if (current.item_id && has('note')) {
        item = await adb.prepare('SELECT * FROM expense_items WHERE id = ?').get(current.item_id);
      }

      const updated = await withMoneyTx(async (tx) => {
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
        };
        // description stays "item name — note" whenever an item or the note changes.
        if (wantsItem || has('note')) {
          let base;
          if (item) base = item.name;
          else if (has('description')) base = req.body.description || '';
          else {
            const oldSuffix = expense.note ? ` — ${expense.note}` : '';
            const d = expense.description || '';
            base = oldSuffix && d.endsWith(oldSuffix) ? d.slice(0, -oldSuffix.length) : d;
          }
          nv.description = composeDescription(base, nv.note);
        }
        if (nv.category !== 'salary') nv.employee_id = null;
        if (nv.category === 'salary' && !nv.employee_id) throw httpError(400, 'Select which employee this salary payment is for.');
        if (nv.category === 'salary') {
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
        const oldEffect = oldRegisterId ? drawerEffect(expense) : 0;
        const newEffect = drawerEffect(nv);
        let newRegisterId = null;
        if (nv.payment_method === 'cash') {
          newRegisterId = (expense.payment_method === 'cash' && oldRegisterId) ? oldRegisterId : (openRegister ? openRegister.id : null);
          if (!newRegisterId) throw registerClosedError();
        }
        if (oldRegisterId && oldRegisterId === newRegisterId) {
          await moveDrawer(tx, oldRegisterId, newEffect - oldEffect);
        } else {
          await moveDrawer(tx, oldRegisterId, -oldEffect);
          await moveDrawer(tx, newRegisterId, newEffect);
        }

        await tx.prepare(`
          UPDATE expenses SET category = ?, amount = ?, description = ?, payment_method = ?, expense_date = ?,
            is_return = ?, employee_id = ?, register_id = ?,
            item_id = ?, note = ?, photo_url = ?, given_to_user_id = ?, given_to_name = ?
          WHERE id = ?
        `).run(nv.category, nv.amount, nv.description, nv.payment_method, nv.expense_date,
          nv.is_return, nv.employee_id, newRegisterId,
          nv.item_id, nv.note, nv.photo_url, nv.given_to_user_id, nv.given_to_name, expenseId);

        const after = { ...expense, ...nv, register_id: newRegisterId };
        await auditExpense(tx, expenseId, req.user.id, 'expense_edit', pickAudit(expense), pickAudit(after));
        return after;
      });

      // The item remembers this save only when it is the latest entry for
      // the item, so fixing an old row never overwrites newer usual values.
      if (updated.item_id && (wantsItem || has('amount') || touchesGivenTo)) {
        const latest = await adb.prepare('SELECT id FROM expenses WHERE item_id = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(updated.item_id);
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
      const { expense, oldRegisterId } = await loadForChange(tx, expenseId, req.user);
      // Put the cash back on the session it came out of.
      await moveDrawer(tx, oldRegisterId, -drawerEffect(expense));
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
