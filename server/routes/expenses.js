const express = require('express');
const { body, validationResult } = require('express-validator');
const { getDb } = require('../config/database');
const { getDb: getAsyncDb, withMoneyTx } = require('../config/database-async');
const { authenticate, authorize } = require('../middleware/auth');
const { todayStr: localToday } = require('../utils/time');
const { hasOpenRegister, lockOpenRegister, registerClosedError, REGISTER_CLOSED_MESSAGE } = require('../utils/register-guard');

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
    const { location_id, category, start_date, end_date, employee_id } = req.query;

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
    if (employee_id) { sql += ' AND e.employee_id = ?'; params.push(employee_id); }

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
    body('payment_method').isIn(['cash', 'card', 'upi', 'bank_transfer']),
    body('expense_date').notEmpty(),
    body('is_return').optional().isBoolean(),
    body('employee_id').optional({ nullable: true }).isInt(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });

      const db = getDb();
      const { location_id, category, amount, description, payment_method, expense_date, is_return, employee_id } = req.body;

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

      let result;
      const isReturnInt = is_return ? 1 : 0;
      try {
        if (expense_number) {
          result = await db.prepare(
            `INSERT INTO expenses (expense_number, location_id, category, amount, description, payment_method, expense_date, created_by, is_return, register_id, employee_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(expense_number, location_id, category, amount, description || '', payment_method, expense_date, req.user.id, isReturnInt, registerId, employeeIdValue);
        } else {
          result = await db.prepare(
            `INSERT INTO expenses (location_id, category, amount, description, payment_method, expense_date, created_by, is_return, register_id, employee_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(location_id, category, amount, description || '', payment_method, expense_date, req.user.id, isReturnInt, registerId, employeeIdValue);
        }
      } catch (err) {
        const msg = String(err?.message || '').toLowerCase();
        // Fallback if expense_number column doesn't exist (legacy schema)
        if (msg.includes('expense_number')) {
          result = await db.prepare(
            `INSERT INTO expenses (location_id, category, amount, description, payment_method, expense_date, created_by, is_return, register_id, employee_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(location_id, category, amount, description || '', payment_method, expense_date, req.user.id, isReturnInt, registerId, employeeIdValue);
        // Fallback if register_id column doesn't exist yet (migration pending)
        } else if (msg.includes('register_id')) {
          result = await db.prepare(
            `INSERT INTO expenses (location_id, category, amount, description, payment_method, expense_date, created_by, is_return, employee_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(location_id, category, amount, description || '', payment_method, expense_date, req.user.id, isReturnInt, employeeIdValue);
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

      const expense = db.prepare(`
        SELECT e.*, l.name as location_name, u.name as created_by_name
        FROM expenses e
        JOIN locations l ON e.location_id = l.id
        JOIN users u ON e.created_by = u.id
        WHERE e.id = ?
      `).get(newExpenseId);

      res.status(201).json({ success: true, data: expense });
    } catch (err) {
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
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: 'Check the amount, type and date, then save again.', errors: errors.array() });
      }
      const expenseId = Number(req.params.id);

      const updated = await withMoneyTx(async (tx) => {
        const { expense, openRegister, oldRegisterId } = await loadForChange(tx, expenseId, req.user);
        const has = (k) => Object.prototype.hasOwnProperty.call(req.body, k);
        const nv = {
          category: has('category') ? req.body.category : expense.category,
          amount: has('amount') ? Math.round(Number(req.body.amount) * 100) / 100 : Number(expense.amount),
          description: has('description') ? (req.body.description || '') : (expense.description || ''),
          payment_method: has('payment_method') ? req.body.payment_method : expense.payment_method,
          expense_date: has('expense_date') ? req.body.expense_date : expense.expense_date,
          is_return: has('is_return') ? (req.body.is_return ? 1 : 0) : (expense.is_return ? 1 : 0),
          employee_id: has('employee_id') ? (req.body.employee_id || null) : (expense.employee_id || null),
        };
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
            is_return = ?, employee_id = ?, register_id = ?
          WHERE id = ?
        `).run(nv.category, nv.amount, nv.description, nv.payment_method, nv.expense_date,
          nv.is_return, nv.employee_id, newRegisterId, expenseId);

        const after = { ...expense, ...nv, register_id: newRegisterId };
        await auditExpense(tx, expenseId, req.user.id, 'expense_edit', pickAudit(expense), pickAudit(after));
        return after;
      });

      const db = getDb();
      const expense = db.prepare(`
        SELECT e.*, l.name as location_name, u.name as created_by_name
        FROM expenses e
        JOIN locations l ON e.location_id = l.id
        JOIN users u ON e.created_by = u.id
        WHERE e.id = ?
      `).get(expenseId) || updated;
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
