const express = require('express');
const { body, validationResult } = require('express-validator');
const { getDb } = require('../config/database');
const { getDb: getAsyncDb } = require('../config/database-async');
const { authenticate, authorize } = require('../middleware/auth');
const { todayStr: localToday } = require('../utils/time');

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
router.get('/', authenticate, async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const { location_id, category, start_date, end_date } = req.query;

    let sql = `
      SELECT e.*, l.name as location_name, u.name as created_by_name
      FROM expenses e
      JOIN locations l ON e.location_id = l.id
      JOIN users u ON e.created_by = u.id
      WHERE 1=1
    `;
    const params = [];

    if (location_id) { sql += ' AND e.location_id = ?'; params.push(location_id); }
    if (category) { sql += ' AND e.category = ?'; params.push(category); }
    if (start_date) { sql += ' AND e.expense_date >= ?'; params.push(start_date); }
    if (end_date) { sql += ' AND e.expense_date <= ?'; params.push(end_date); }

    sql += ' ORDER BY e.expense_date DESC, e.created_at DESC';

    const expenses = await db.prepare(sql).all(...params);

    // Calculate totals
    const total = expenses.reduce((s, e) => s + e.amount, 0);

    res.json({ success: true, data: expenses, total });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/expenses ──────────────────────────────────────
router.post(
  '/',
  authenticate,
  authorize('owner', 'manager', 'employee'),
  [
    body('location_id').isInt(),
    body('category').isIn(['supplies', 'petty_cash', 'maintenance', 'transport', 'food', 'utilities', 'salary', 'other']),
    body('amount').isFloat({ min: 0.01 }),
    body('description').optional().trim(),
    body('payment_method').isIn(['cash', 'card', 'upi']),
    body('expense_date').notEmpty(),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });

      const db = getDb();
      const { location_id, category, amount, description, payment_method, expense_date } = req.body;

      const expense_number = generateExpenseNumber(db, location_id);

      let result;
      try {
        if (expense_number) {
          result = db.prepare(
            `INSERT INTO expenses (expense_number, location_id, category, amount, description, payment_method, expense_date, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(expense_number, location_id, category, amount, description || '', payment_method, expense_date, req.user.id);
        } else {
          result = db.prepare(
            `INSERT INTO expenses (location_id, category, amount, description, payment_method, expense_date, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).run(location_id, category, amount, description || '', payment_method, expense_date, req.user.id);
        }
      } catch (err) {
        const msg = String(err?.message || '').toLowerCase();
        if (!msg.includes('expense_number')) throw err;
        result = db.prepare(
          `INSERT INTO expenses (location_id, category, amount, description, payment_method, expense_date, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(location_id, category, amount, description || '', payment_method, expense_date, req.user.id);
      }

      // If cash expense, deduct from cash register expected_cash
      if (payment_method === 'cash') {
        const today = localToday();
        const register = db.prepare('SELECT id FROM cash_registers WHERE location_id = ? AND date = ?').get(location_id, today);
        if (register) {
          db.prepare('UPDATE cash_registers SET expected_cash = expected_cash - ? WHERE id = ?').run(amount, register.id);
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

    // Reverse cash register deduction if applicable
    if (expense.payment_method === 'cash') {
      const register = db.prepare('SELECT id FROM cash_registers WHERE location_id = ? AND date = ?').get(expense.location_id, expense.expense_date);
      if (register) {
        db.prepare('UPDATE cash_registers SET expected_cash = expected_cash + ? WHERE id = ?').run(expense.amount, register.id);
      }
    }

    db.prepare('DELETE FROM expenses WHERE id = ?').run(req.params.id);
    res.json({ success: true, message: 'Expense deleted' });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/expenses/summary ───────────────────────────────
router.get('/summary', authenticate, async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const { location_id, start_date, end_date } = req.query;

    let sql = 'SELECT category, SUM(amount) as total, COUNT(*) as count FROM expenses WHERE 1=1';
    const params = [];

    if (location_id) { sql += ' AND location_id = ?'; params.push(location_id); }
    if (start_date) { sql += ' AND expense_date >= ?'; params.push(start_date); }
    if (end_date) { sql += ' AND expense_date <= ?'; params.push(end_date); }

    sql += ' GROUP BY category ORDER BY total DESC';

    const summary = await db.prepare(sql).all(...params);
    const grandTotal = summary.reduce((s, r) => s + r.total, 0);

    res.json({ success: true, data: summary, total: grandTotal });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
