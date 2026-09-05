const express = require('express');
const { body, validationResult } = require('express-validator');
const { getDb } = require('../config/database');
const { getDb: getAsyncDb } = require('../config/database-async');
const { authenticate, authorize } = require('../middleware/auth');
const { todayStr: localToday } = require('../utils/time');
const { hasOpenRegister, REGISTER_CLOSED_MESSAGE } = require('../utils/register-guard');

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
    const { location_id, category, start_date, end_date } = req.query;

    // register_opened_at/register_closed_at let the client show which
    // session an expense belongs to — added because multiple sessions in
    // one day are a real, regular occurrence at this shop, and expenses
    // already stored the right register_id with nothing surfacing it
    // (2026-09-04 cash-register/expense audit). LEFT JOIN: a cash expense
    // recorded with no register open at all (legacy data, or the
    // register_id column not existing yet — see hasExpenseNumberColumn's
    // sibling fallback in POST /) still returns the expense, just with
    // both fields null.
    let sql = `
      SELECT e.*, l.name as location_name, u.name as created_by_name,
             cr.opening_time as register_opened_at, cr.opened_at as register_opened_at_fallback,
             cr.closed_at as register_closed_at
      FROM expenses e
      JOIN locations l ON e.location_id = l.id
      JOIN users u ON e.created_by = u.id
      LEFT JOIN cash_registers cr ON cr.id = e.register_id
      WHERE 1=1
    `;
    const params = [];

    if (location_id) { sql += ' AND e.location_id = ?'; params.push(location_id); }
    if (category) { sql += ' AND e.category = ?'; params.push(category); }
    if (start_date) { sql += ' AND e.expense_date >= ?'; params.push(start_date); }
    if (end_date) { sql += ' AND e.expense_date <= ?'; params.push(end_date); }

    sql += ' ORDER BY e.expense_date DESC, e.created_at DESC';

    const expenses = await db.prepare(sql).all(...params);

    const normalizedExpenses = expenses.map((expense) => {
      const { register_opened_at_fallback, ...rest } = expense;
      return {
        ...rest,
        amount: Number(expense.amount) || 0,
        is_return: !!expense.is_return,
        register_opened_at: expense.register_opened_at || register_opened_at_fallback || null,
      };
    });

    // Calculate totals using numeric amounts so the client always receives numbers.
    const total = normalizedExpenses.reduce((sum, expense) => sum + (expense.is_return ? -expense.amount : expense.amount), 0);

    res.json({ success: true, data: normalizedExpenses, total });
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
    body('category').isIn(['supplies', 'petty_cash', 'maintenance', 'transport', 'food', 'utilities', 'salary', 'other']),
    body('amount').isFloat({ min: 0.01 }),
    body('description').optional().trim(),
    body('payment_method').isIn(['cash', 'card', 'upi']),
    body('expense_date').notEmpty(),
    body('is_return').optional().isBoolean(),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });

      const db = getDb();
      const { location_id, category, amount, description, payment_method, expense_date, is_return } = req.body;

      // Cash expenses/returns move real money in or out of the drawer, same
      // as a sale or refund — hard-block them with no open register instead
      // of silently recording an expense that no session's expected_cash
      // ever accounts for (found live during the sub-project 4 audit,
      // 2026-09-01: this was the one cash-write site register-guard never
      // reached in sub-project 3).
      if (payment_method === 'cash' && !hasOpenRegister(db, location_id)) {
        return res.status(400).json({ success: false, message: REGISTER_CLOSED_MESSAGE });
      }

      // Look up the currently open register FIRST so we can store register_id on the expense.
      // This links the expense permanently to its session — critical for correct session-scoped queries
      // and for reversing against the correct register on deletion.
      const openRegister = payment_method === 'cash'
        ? db.prepare('SELECT id FROM cash_registers WHERE location_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1').get(location_id)
        : null;
      const registerId = openRegister ? openRegister.id : null;

      const expense_number = generateExpenseNumber(db, location_id);

      let result;
      const isReturnInt = is_return ? 1 : 0;
      try {
        if (expense_number) {
          result = db.prepare(
            `INSERT INTO expenses (expense_number, location_id, category, amount, description, payment_method, expense_date, created_by, is_return, register_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(expense_number, location_id, category, amount, description || '', payment_method, expense_date, req.user.id, isReturnInt, registerId);
        } else {
          result = db.prepare(
            `INSERT INTO expenses (location_id, category, amount, description, payment_method, expense_date, created_by, is_return, register_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(location_id, category, amount, description || '', payment_method, expense_date, req.user.id, isReturnInt, registerId);
        }
      } catch (err) {
        const msg = String(err?.message || '').toLowerCase();
        // Fallback if expense_number column doesn't exist (legacy schema)
        if (msg.includes('expense_number')) {
          result = db.prepare(
            `INSERT INTO expenses (location_id, category, amount, description, payment_method, expense_date, created_by, is_return, register_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(location_id, category, amount, description || '', payment_method, expense_date, req.user.id, isReturnInt, registerId);
        // Fallback if register_id column doesn't exist yet (migration pending)
        } else if (msg.includes('register_id')) {
          result = db.prepare(
            `INSERT INTO expenses (location_id, category, amount, description, payment_method, expense_date, created_by, is_return)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(location_id, category, amount, description || '', payment_method, expense_date, req.user.id, isReturnInt);
        } else {
          throw err;
        }
      }

      // Update expected_cash on the open register (already found above)
      if (openRegister) {
        if (is_return) {
          db.prepare('UPDATE cash_registers SET expected_cash = expected_cash + ? WHERE id = ?').run(amount, openRegister.id);
        } else {
          db.prepare('UPDATE cash_registers SET expected_cash = expected_cash - ? WHERE id = ?').run(amount, openRegister.id);
        }
      }

      const expense = db.prepare(`
        SELECT e.*, l.name as location_name, u.name as created_by_name
        FROM expenses e
        JOIN locations l ON e.location_id = l.id
        JOIN users u ON e.created_by = u.id
        WHERE e.id = ?
      `).get(result.lastInsertRowid);

      res.status(201).json({ success: true, data: expense });
    } catch (err) {
      next(err);
    }
  }
);

// ─── DELETE /api/expenses/:id ────────────────────────────────
router.delete('/:id', authenticate, authorize('owner', 'manager'), (req, res, next) => {
  try {
    const db = getDb();
    const expense = db.prepare('SELECT * FROM expenses WHERE id = ?').get(req.params.id);
    if (!expense) return res.status(404).json({ success: false, message: 'Expense not found' });

    // Reverse cash register deduction if applicable.
    // IMPORTANT: Use expense.register_id to target the exact session the expense belonged to.
    // This prevents reversals from hitting a different (e.g. today's) open register when the
    // expense was recorded in a previous session.
    if (expense.payment_method === 'cash') {
      // Prefer the stored register_id (session-exact). Fall back to current open register
      // only if the expense pre-dates the register_id column (legacy data).
      const registerId = expense.register_id
        || db.prepare('SELECT id FROM cash_registers WHERE location_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1').get(expense.location_id)?.id;

      if (registerId) {
        // If the target session is already CLOSED, its discrepancy was
        // frozen at close time against the expected_cash that existed
        // then — adjusting expected_cash here without also recomputing
        // discrepancy left a closed session's own historical record
        // internally inconsistent (expected_cash says one thing,
        // discrepancy still reflects the pre-deletion value). actual_cash
        // is a real physical count from that close and must never change;
        // discrepancy is just expected_cash - actual_cash recomputed
        // against the corrected expected_cash. All SET expressions below
        // read the OLD row (standard SQL UPDATE semantics), so referencing
        // expected_cash in the discrepancy CASE still means "before this
        // delta" even though expected_cash is being changed in the same
        // statement. No-op for an open session (discrepancy isn't set yet).
        const delta = expense.is_return ? -Number(expense.amount) : Number(expense.amount);
        db.prepare(`
          UPDATE cash_registers SET
            expected_cash = expected_cash + ?,
            discrepancy = CASE WHEN closed_at IS NOT NULL THEN (expected_cash + ?) - actual_cash ELSE discrepancy END
          WHERE id = ?
        `).run(delta, delta, registerId);
      }
    }

    db.prepare('DELETE FROM expenses WHERE id = ?').run(req.params.id);
    res.json({ success: true, message: 'Expense deleted' });
  } catch (err) {
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
