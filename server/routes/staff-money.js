// Staff money (spec 2026-11-14-staff-money-usual-now-design.md): salary
// advance and shopping money at the counter, settling shopping money, the
// Shopping money out card, history and My money. Async DB layer only.
// Helpers are default-denied by authenticate (nothing here is in
// helper-routes.js); florists and riders get 403 from authorize (My money
// excepted: it is theirs).
const express = require('express');
const { getDb, withMoneyTx } = require('../config/database-async');
const { authenticate, authorize } = require('../middleware/auth');
const sm = require('../utils/staff-money');
const { payAdvance, ADVANCE_REGISTER_CLOSED_MESSAGE } = require('../utils/advance-payout');
const { lockOpenRegister } = require('../utils/register-guard');
const { todayStr } = require('../utils/time');
const { resolveItem, composeDescription } = require('../utils/expense-items');
const { notifyByRole } = require('./notifications');

const router = express.Router();

const GIVER_ROLES = ['owner', 'manager', 'employee', 'counter_staff'];
// Who can receive staff money: the shop's staff and riders (never the owner or a helper).
const PEOPLE_ROLES = ['manager', 'employee', 'counter_staff', 'florist_staff', 'delivery_partner'];

const LOCATION_MESSAGE = 'Pick a shop first.';
const AMOUNT_MESSAGE = 'Type an amount above ₹0, like 300.';
const METHOD_MESSAGE = 'Pick Cash or UPI.';
const PERSON_MESSAGE = 'Pick who gets the money from the list.';
const NOT_YOUR_SHOP_MESSAGE = "You can't give money at this shop. Switch to your own shop and try again.";
const PIN_MISSING_MESSAGE = 'Type the PIN, then tap Give again.';
const ALREADY_DONE_MESSAGE = 'Already done — refresh.';
const NOT_FOUND_MESSAGE = 'This shopping money was not found. Pull down to refresh.';
const OTHER_SHOP_MESSAGE = 'This shopping money is from another shop. Switch to that shop and try again.';
const BILL_AMOUNT_MESSAGE = 'Type how much each thing cost, like 300.';
const BILL_ITEM_MESSAGE = 'Type what was bought, like Roses.';
const BILL_KIND_MESSAGE = 'Pick what kind of thing was bought.';
const BILL_SALARY_MESSAGE = "Salary can't be paid from shopping money. Use Salary advance.";
const CHANGE_AMOUNT_MESSAGE = 'Type the change as an amount, like 200, or 0.';
const NOTHING_TO_SAVE_MESSAGE = 'Add what was bought or the change brought back, then tap Done.';
const CHANGE_REGISTER_CLOSED_MESSAGE = 'Open the register to put the change in the drawer — or pick UPI.';
const REMOVE_REGISTER_CLOSED_MESSAGE = 'Open the register to put the cash back in the drawer.';
const REMOVE_SETTLED_MESSAGE = "Part of this is already accounted for, so it can't be removed. Tap the line to settle the rest.";
const REMOVE_NOT_YOURS_MESSAGE = 'Only the person who gave this money can remove it, while the same register is still open. Ask the owner or a manager.';
const WRITE_OFF_REASON_MESSAGE = 'Type why this money is written off.';
// Kinds a shopping bill can be (never salary).
const BILL_CATEGORIES = ['supplies', 'petty_cash', 'maintenance', 'transport', 'food', 'utilities', 'other'];
// Separate per-person advisory lock namespaces: advances and shopping money
// never count against each other, so they do not need to wait on each other.
const ADVANCE_LOCK_NS = 7302;
const SHOPPING_LOCK_NS = 7303;

const toPaise = (n) => Math.round((Number(n) || 0) * 100);
const rupees = (paise) => paise / 100;
const inr = (n) => `₹${Number(n).toLocaleString('en-IN')}`;
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || 'This person';
const isBoss = (role) => role === 'owner' || role === 'manager';

function parseId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}
// A number or numeric string with at most 2 decimals; rupees, or null.
function parseMoney(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const s = String(value).trim();
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(s)) return null;
  const paise = toPaise(Number(s));
  return paise > 0 ? paise / 100 : null;
}
function httpError(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  e.statusCode = status;
  Object.assign(e, extra || {});
  return e;
}
function sendError(res, next, err) {
  const status = err.statusCode || err.status;
  if (!status) return next(err);
  const body = { success: false, message: err.message };
  if (err.needs_pin) body.needs_pin = err.needs_pin;
  return res.status(status).json(body);
}

async function isLinked(db, userId, locationId) {
  const r = await db.prepare('SELECT 1 AS ok FROM user_locations WHERE user_id = ? AND location_id = ?').get(userId, locationId);
  return !!r;
}

// ─── GET /api/staff-money/people?location_id= ────────────────
// Staff and riders linked to the shop, most recently given money first.
router.get('/people', authenticate, authorize(...GIVER_ROLES), async (req, res, next) => {
  try {
    const locationId = parseId(req.query.location_id);
    if (!locationId) return res.status(400).json({ success: false, message: LOCATION_MESSAGE });
    const db = await getDb();
    const roles = PEOPLE_ROLES.map(() => '?').join(', ');
    // One comparable last-given time per person, worked out in SQL: the later
    // of the last advance at this shop (its expense time, else its day) and
    // the last shopping hand-out here. GREATEST skips NULLs.
    const rows = await db.prepare(`
      SELECT id, name, role, last_at IS NOT NULL AS has_recent FROM (
        SELECT u.id, u.name, u.role,
          GREATEST(
            (SELECT MAX(COALESCE(e.created_at, CAST(sa.date AS timestamp)))
               FROM salary_advances sa LEFT JOIN expenses e ON e.id = sa.expense_id
              WHERE sa.user_id = u.id AND sa.location_id = ? AND sa.status IN ('approved', 'repaid')),
            (SELECT MAX(mo.created_at) FROM staff_money_out mo
              WHERE mo.user_id = u.id AND mo.location_id = ? AND mo.status <> 'removed')
          ) AS last_at
        FROM users u
        WHERE u.is_active = 1 AND u.role IN (${roles})
          AND EXISTS (SELECT 1 FROM user_locations ul WHERE ul.user_id = u.id AND ul.location_id = ?)
      ) p
      ORDER BY last_at DESC NULLS LAST, name ASC, id ASC
    `).all(locationId, locationId, ...PEOPLE_ROLES, locationId);

    let n = 0;
    const data = rows.map((r) => ({
      id: Number(r.id), name: r.name, role: r.role,
      recent_rank: r.has_recent ? ++n : null,
    }));
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// ─── GET /api/staff-money/approvers?location_id= ─────────────
// Who can confirm with a PIN: the owner and managers linked to the shop, each
// with an approval PIN set. Names only.
router.get('/approvers', authenticate, authorize(...GIVER_ROLES), async (req, res, next) => {
  try {
    const locationId = parseId(req.query.location_id);
    if (!locationId) return res.status(400).json({ success: false, message: LOCATION_MESSAGE });
    const db = await getDb();
    const rows = await db.prepare(`
      SELECT u.id, u.name, u.role FROM users u
      WHERE u.is_active = 1 AND u.pin_hash IS NOT NULL AND u.employee_code IS NOT NULL
        AND (u.role = 'owner'
          OR (u.role = 'manager' AND EXISTS (SELECT 1 FROM user_locations ul WHERE ul.user_id = u.id AND ul.location_id = ?)))
      ORDER BY CASE WHEN u.role = 'owner' THEN 1 ELSE 0 END, u.name ASC, u.id ASC
    `).all(locationId);
    res.json({ success: true, data: rows.map((r) => ({ id: Number(r.id), name: r.name, role: r.role })) });
  } catch (err) { next(err); }
});

// ─── Shared give flow (advance and shopping money) ───────────
// Checks the body, the giver's shop, the recipient, the limits and the PIN.
// The PIN try is recorded, so it is checked here, before (never inside) the
// money transaction. Inside the transaction the caller runs lockAndRecheck,
// which takes a per-person advisory lock and checks the limits again, so two
// gives sent at once cannot both pass.
async function prepareGive(req, kind) {
  const b = req.body || {};
  const locationId = parseId(b.location_id);
  if (!locationId) throw httpError(400, LOCATION_MESSAGE);
  const userId = parseId(b.user_id);
  if (!userId) throw httpError(400, PERSON_MESSAGE);
  const amount = parseMoney(b.amount);
  if (amount === null) throw httpError(400, AMOUNT_MESSAGE);
  const method = b.payment_method;
  if (!['cash', 'upi'].includes(method)) throw httpError(400, METHOD_MESSAGE);
  const note = typeof b.note === 'string' ? b.note.trim().slice(0, 500) : null;

  const db = await getDb();
  const giver = { id: Number(req.user.id), role: req.user.role, name: req.user.name };
  if (giver.role !== 'owner' && !(await isLinked(db, giver.id, locationId))) {
    throw httpError(403, NOT_YOUR_SHOP_MESSAGE);
  }
  const roles = PEOPLE_ROLES.map(() => '?').join(', ');
  const recipient = await db.prepare(`
    SELECT u.id, u.name, u.role FROM users u
    WHERE u.id = ? AND u.is_active = 1 AND u.role IN (${roles})
      AND EXISTS (SELECT 1 FROM user_locations ul WHERE ul.user_id = u.id AND ul.location_id = ?)
  `).get(userId, ...PEOPLE_ROLES, locationId);
  if (!recipient) throw httpError(400, PERSON_MESSAGE);

  const limits = await sm.getLimits(db);
  const reasonFor = async (handle) => sm.needsPin({
    giver, recipientId: userId, kind, amount, limits, totals: await sm.totals(handle, { userId }),
  });
  const needsPinError = (reason) => httpError(409, sm.needsPinMessage(reason, { name: firstName(recipient.name), limits, kind }), { needs_pin: reason });

  let approver = null;
  const hasApprover = b.approver_id !== undefined && b.approver_id !== null && b.approver_id !== '';
  if (!hasApprover) {
    const reason = await reasonFor(db);
    if (reason) throw needsPinError(reason);
  } else {
    if (!b.approver_pin) throw httpError(400, PIN_MISSING_MESSAGE);
    const row = await sm.checkApprover(db, { approverId: b.approver_id, pin: String(b.approver_pin), locationId, recipientId: userId });
    approver = { id: Number(row.id), name: row.name || null }; // never keep pin_hash
    if (!approver.name) {
      const n = await db.prepare('SELECT name FROM users WHERE id = ?').get(approver.id);
      approver.name = n ? n.name : 'A manager';
    }
  }

  const lockNs = kind === 'shopping' ? SHOPPING_LOCK_NS : ADVANCE_LOCK_NS;
  async function lockAndRecheck(tx) {
    await tx.prepare('SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock(?, ?)) x').get(lockNs, userId);
    if (!approver) {
      const reason = await reasonFor(tx);
      if (reason) throw needsPinError(reason);
    }
  }
  return { db, locationId, userId, amount, method, note, giver, recipient, approver, lockAndRecheck };
}

// The owner hears about a manager taking money for themself, and about every
// amount a PIN confirmed (spec 5.2). Runs after the commit.
async function tellOwner(g, { what, title, type, data }) {
  const managerSelf = g.giver.role === 'manager' && g.giver.id === g.userId;
  if (!g.approver && !managerSelf) return;
  const body = g.approver
    ? `${g.recipient.name} got ${what(g.amount)} from ${g.giver.name}. ${g.approver.name} confirmed it with their PIN.`
    : `${g.giver.name} (manager) took ${what(g.amount)}.`;
  await notifyByRole({ roles: ['owner'], locationId: g.locationId, title, body, type, data });
}

// Cash in (+) or out (-) of an open register session: the running expected
// cash moves, and so does a locked blind count (same as helper floats).
async function moveSessionCash(tx, registerId, delta) {
  await tx.prepare('UPDATE cash_registers SET expected_cash = expected_cash + ? WHERE id = ? AND closed_at IS NULL').run(delta, registerId);
  await tx.prepare('UPDATE cash_registers SET close_count_locked = close_count_locked + ? WHERE id = ? AND closed_at IS NULL AND close_count_locked IS NOT NULL')
    .run(delta, registerId);
}

async function auditMoneyOut(tx, id, userId, action, before, after) {
  await tx.prepare(`
    INSERT INTO audit_logs (entity_type, entity_id, user_id, action, previous_state, new_state, created_at)
    VALUES ('staff_money_out', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(id, userId, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null);
}
const pickOut = (r) => ({
  user_id: Number(r.user_id), amount: Number(r.amount), payment_method: r.payment_method, status: r.status,
  settled_amount: Number(r.settled_amount) || 0, returned_amount: Number(r.returned_amount) || 0,
  register_id: r.register_id || null, location_id: r.location_id || null,
});

// ─── POST /api/staff-money/advance ───────────────────────────
// { location_id, user_id, amount, payment_method, note?, approver_id?, approver_pin? }
router.post('/advance', authenticate, authorize(...GIVER_ROLES), async (req, res, next) => {
  try {
    const g = await prepareGive(req, 'advance');
    const result = await withMoneyTx(async (tx) => {
      await g.lockAndRecheck(tx);
      return payAdvance(tx, {
        userId: g.userId, amount: g.amount, method: g.method, locationId: g.locationId, note: g.note,
        givenBy: g.giver.id,
        approvedBy: g.approver ? g.approver.id : g.giver.id,
        source: 'counter',
      });
    });
    await tellOwner(g, {
      what: (a) => `a ${inr(a)} salary advance`,
      title: 'Salary advance',
      type: 'staff_money_advance',
      data: { screen: 'Expenses', advanceId: result.advanceId, userId: g.userId },
    });
    const after = await sm.totals(g.db, { userId: g.userId });
    res.status(201).json({
      success: true,
      data: { advance_id: result.advanceId, expense_id: result.expenseId, unpaid_after: after.advancesUnpaid },
    });
  } catch (err) {
    sendError(res, next, err);
  }
});

// ─── POST /api/staff-money/shopping ──────────────────────────
// Same body as /advance. Cash leaves the drawer at once; it is not an
// expense (spec 5.4): bills become expenses when the person is back.
router.post('/shopping', authenticate, authorize(...GIVER_ROLES), async (req, res, next) => {
  try {
    const g = await prepareGive(req, 'shopping');
    const id = await withMoneyTx(async (tx) => {
      await g.lockAndRecheck(tx);
      let registerId = null;
      if (g.method === 'cash') {
        const reg = await lockOpenRegister(tx, g.locationId);
        if (!reg) throw httpError(400, ADVANCE_REGISTER_CLOSED_MESSAGE);
        registerId = reg.id;
      }
      const approvedBy = g.approver ? g.approver.id : g.giver.id;
      const ins = await tx.prepare(`
        INSERT INTO staff_money_out (location_id, user_id, amount, payment_method, register_id, given_by, approved_by,
          note, status, settled_amount, returned_amount)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', 0, 0)
      `).run(g.locationId, g.userId, g.amount, g.method, registerId, g.giver.id, approvedBy, g.note || null);
      const newId = Number(ins.lastInsertRowid);
      if (registerId) await moveSessionCash(tx, registerId, -g.amount);
      await auditMoneyOut(tx, newId, g.giver.id, 'shopping_money_given', null, {
        user_id: g.userId, amount: g.amount, payment_method: g.method, location_id: g.locationId,
        given_by: g.giver.id, approved_by: approvedBy, register_id: registerId,
      });
      return newId;
    });
    await tellOwner(g, {
      what: (a) => `${inr(a)} shopping money`,
      title: 'Shopping money',
      type: 'staff_money_shopping',
      data: { screen: 'Expenses', moneyOutId: id, userId: g.userId },
    });
    const after = await sm.totals(g.db, { userId: g.userId });
    res.status(201).json({ success: true, data: { id, held_after: after.shoppingHeld } });
  } catch (err) {
    sendError(res, next, err);
  }
});

// Reads a shopping line outside the transaction for the early checks
// (exists, the user may act at its shop). Locked again inside.
async function loadLineForUser(db, id, user) {
  const row = await db.prepare(`
    SELECT mo.id, mo.location_id, mo.user_id, mo.status, u.name AS user_name
    FROM staff_money_out mo JOIN users u ON u.id = mo.user_id WHERE mo.id = ?
  `).get(id);
  if (!row) throw httpError(404, NOT_FOUND_MESSAGE);
  if (user.role !== 'owner' && !(await isLinked(db, Number(user.id), row.location_id))) {
    throw httpError(403, OTHER_SHOP_MESSAGE);
  }
  return row;
}

// ─── POST /api/staff-money/:id/settle ────────────────────────
// "Ramesh is back". { bills: [{ item_id?, item_name?, description?, category?, amount }],
//   change_back, change_method, final }
// Bills become expenses paid with shopping money (never the drawer), Given
// to = the holder. Cash change goes into the open register. Bills beyond what
// was left become Shop owes for the holder (source overspend).
router.post('/:id/settle', authenticate, authorize(...GIVER_ROLES), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) throw httpError(404, NOT_FOUND_MESSAGE);
    const b = req.body || {};
    if (b.bills !== undefined && b.bills !== null && !Array.isArray(b.bills)) throw httpError(400, BILL_ITEM_MESSAGE);
    const rawBills = Array.isArray(b.bills) ? b.bills : [];
    if (rawBills.length > 30) throw httpError(400, 'Save up to 30 things at a time, then add the rest.');
    const bills = rawBills.map((x) => {
      const it = x || {};
      const amount = parseMoney(it.amount);
      if (amount === null) throw httpError(400, BILL_AMOUNT_MESSAGE);
      const category = it.category ? String(it.category) : null;
      if (category && !BILL_CATEGORIES.includes(category)) throw httpError(400, category === 'salary' ? BILL_SALARY_MESSAGE : BILL_KIND_MESSAGE);
      const itemId = it.item_id ? parseId(it.item_id) : null;
      const itemName = typeof it.item_name === 'string' ? it.item_name.trim() : '';
      const description = typeof it.description === 'string' ? it.description.trim().slice(0, 500) : '';
      if (!itemId && !itemName && !description) throw httpError(400, BILL_ITEM_MESSAGE);
      return { amount, category, itemId, itemName, description };
    });
    let change = 0;
    if (b.change_back !== undefined && b.change_back !== null && b.change_back !== '' && Number(b.change_back) !== 0) {
      change = parseMoney(b.change_back);
      if (change === null) throw httpError(400, CHANGE_AMOUNT_MESSAGE);
    }
    const changeMethod = change > 0 ? b.change_method : null;
    if (change > 0 && !['cash', 'upi'].includes(changeMethod)) throw httpError(400, METHOD_MESSAGE);
    const final = b.final === true || b.final === 'true';
    if (bills.length === 0 && change === 0) throw httpError(400, NOTHING_TO_SAVE_MESSAGE);

    const db = await getDb();
    const line = await loadLineForUser(db, id, req.user);
    if (line.status !== 'open') throw httpError(409, ALREADY_DONE_MESSAGE);

    // Items are ordinary writes made before the money transaction (same as
    // the expense routes), so a refused settle never half-writes money.
    for (const bill of bills) {
      if (bill.itemId || bill.itemName) {
        bill.item = await resolveItem(db, {
          item_id: bill.itemId, item_name: bill.itemName, category: bill.category || 'supplies', userId: req.user.id,
        });
        if (bill.item.category === 'salary') throw httpError(400, BILL_SALARY_MESSAGE);
      }
    }

    const holderFirst = firstName(line.user_name);
    const outcome = await withMoneyTx(async (tx) => {
      // Lock order: the shopping line first, then (cash change only) the register.
      const mo = await tx.prepare('SELECT * FROM staff_money_out WHERE id = ? FOR UPDATE').get(id);
      if (!mo || mo.status !== 'open') throw httpError(409, ALREADY_DONE_MESSAGE);
      const leftP = sm.remainingPaise(mo);
      const billsP = bills.reduce((t, x) => t + toPaise(x.amount), 0);
      const changeP = toPaise(change);
      const afterBillsP = Math.max(0, leftP - billsP);
      const excessP = Math.max(0, billsP - leftP);
      if (changeP > afterBillsP) {
        throw httpError(400, `${holderFirst} only has ${inr(rupees(afterBillsP))} left — check the change amount.`);
      }
      const stillP = afterBillsP - changeP;
      if (final && stillP > 0) {
        throw httpError(400, `${holderFirst} still has ${inr(rupees(stillP))}. Add what was bought or the change back — or tap Save, rest later.`);
      }

      let registerId = null;
      if (changeP > 0 && changeMethod === 'cash') {
        const reg = await lockOpenRegister(tx, mo.location_id);
        if (!reg) throw httpError(400, CHANGE_REGISTER_CLOSED_MESSAGE);
        registerId = reg.id;
      }

      const day = todayStr();
      const expenseIds = [];
      for (const bill of bills) {
        const base = bill.item ? bill.item.name : bill.description;
        const note = bill.item ? (bill.description || null) : null;
        const e = await tx.prepare(`
          INSERT INTO expenses (location_id, category, amount, description, payment_method, expense_date,
            created_by, given_to_user_id, register_id, money_out_id, item_id, note)
          VALUES (?, ?, ?, ?, 'shopping_money', ?, ?, ?, NULL, ?, ?, ?)
        `).run(
          mo.location_id, bill.item ? bill.item.category : (bill.category || 'supplies'), bill.amount,
          composeDescription(base, note), day, req.user.id, mo.user_id, id, bill.item ? bill.item.id : null, note,
        );
        expenseIds.push(Number(e.lastInsertRowid));
      }

      const status = (final || stillP === 0) ? 'settled' : 'open';
      await tx.prepare(`
        UPDATE staff_money_out SET settled_amount = COALESCE(settled_amount, 0) + ?, returned_amount = COALESCE(returned_amount, 0) + ?,
          status = ?, closed_at = CASE WHEN ? = 'settled' THEN CURRENT_TIMESTAMP ELSE closed_at END
        WHERE id = ?
      `).run(rupees(billsP), rupees(changeP), status, status, id);
      await tx.prepare(`
        INSERT INTO staff_money_settles (money_out_id, bills_amount, returned_amount, returned_method, register_id, settled_by)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, rupees(billsP), rupees(changeP), changeMethod, registerId, req.user.id);
      if (registerId) await moveSessionCash(tx, registerId, rupees(changeP));

      // Overspent: the holder paid the excess from their own pocket.
      let owesId = null;
      if (excessP > 0) {
        const owes = await tx.prepare("SELECT * FROM shop_owes WHERE money_out_id = ? AND source = 'overspend' AND status = 'open' ORDER BY id LIMIT 1 FOR UPDATE").get(id);
        if (owes) {
          await tx.prepare('UPDATE shop_owes SET amount = amount + ? WHERE id = ?').run(rupees(excessP), owes.id);
          owesId = Number(owes.id);
        } else {
          const o = await tx.prepare(`
            INSERT INTO shop_owes (location_id, user_id, amount, paid_amount, source, money_out_id, status, created_by)
            VALUES (?, ?, ?, 0, 'overspend', ?, 'open', ?)
          `).run(mo.location_id, mo.user_id, rupees(excessP), id, req.user.id);
          owesId = Number(o.lastInsertRowid);
        }
      }

      const after = await tx.prepare('SELECT * FROM staff_money_out WHERE id = ?').get(id);
      await auditMoneyOut(tx, id, req.user.id, 'shopping_money_settled', pickOut(mo), {
        ...pickOut(after), bills: expenseIds, bills_amount: rupees(billsP), change_back: rupees(changeP),
        change_method: changeMethod, change_register_id: registerId, final, owes_id: owesId, overspent: rupees(excessP),
      });
      return { remaining: sm.remaining(after), status: after.status, owesId, expenseIds };
    });

    const data = { remaining: outcome.remaining, status: outcome.status, expense_ids: outcome.expenseIds };
    if (outcome.owesId) data.owes_id = outcome.owesId;
    res.json({ success: true, data });
  } catch (err) {
    sendError(res, next, err);
  }
});

// ─── DELETE /api/staff-money/:id ─────────────────────────────
// Remove a hand-out typed by mistake (spec 5.4): the giver while the same
// register session is open, or the owner/manager; only while nothing is
// settled. Cash goes back into the open session.
router.delete('/:id', authenticate, authorize(...GIVER_ROLES), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) throw httpError(404, NOT_FOUND_MESSAGE);
    const db = await getDb();
    await loadLineForUser(db, id, req.user);
    const boss = isBoss(req.user.role);
    await withMoneyTx(async (tx) => {
      const mo = await tx.prepare('SELECT * FROM staff_money_out WHERE id = ? FOR UPDATE').get(id);
      if (!mo || mo.status !== 'open') throw httpError(409, ALREADY_DONE_MESSAGE);
      const touched = await tx.prepare('SELECT 1 AS ok FROM staff_money_settles WHERE money_out_id = ? LIMIT 1').get(id);
      if (touched || toPaise(mo.settled_amount) > 0 || toPaise(mo.returned_amount) > 0) throw httpError(409, REMOVE_SETTLED_MESSAGE);
      const isCash = mo.payment_method === 'cash';
      const reg = (isCash || !boss) ? await lockOpenRegister(tx, mo.location_id) : null;
      if (!boss) {
        if (Number(mo.given_by) !== Number(req.user.id) || !reg) throw httpError(403, REMOVE_NOT_YOURS_MESSAGE);
        const sameSession = mo.register_id
          ? Number(mo.register_id) === Number(reg.id)
          : !!(await tx.prepare(`
              SELECT 1 AS ok FROM staff_money_out mo, cash_registers cr
              WHERE mo.id = ? AND cr.id = ? AND mo.created_at >= COALESCE(cr.opening_time, cr.opened_at)
            `).get(id, reg.id));
        if (!sameSession) throw httpError(403, REMOVE_NOT_YOURS_MESSAGE);
      }
      let backRegisterId = null;
      if (isCash) {
        if (!reg) throw httpError(400, REMOVE_REGISTER_CLOSED_MESSAGE);
        backRegisterId = reg.id;
        // The cash coming back is a change-back row in the open session, so
        // the hand-out session (maybe closed) keeps its own figures.
        await tx.prepare(`
          INSERT INTO staff_money_settles (money_out_id, bills_amount, returned_amount, returned_method, register_id, settled_by)
          VALUES (?, 0, ?, 'cash', ?, ?)
        `).run(id, Number(mo.amount), reg.id, req.user.id);
        await moveSessionCash(tx, reg.id, Number(mo.amount));
      }
      await tx.prepare(`
        UPDATE staff_money_out SET status = 'removed', returned_amount = ?, closed_at = CURRENT_TIMESTAMP, close_reason = 'removed'
        WHERE id = ?
      `).run(isCash ? Number(mo.amount) : 0, id);
      await auditMoneyOut(tx, id, req.user.id, 'shopping_money_removed', pickOut(mo), {
        ...pickOut(mo), status: 'removed', cash_back_register_id: backRegisterId,
      });
    });
    res.json({ success: true, data: { id, status: 'removed' } });
  } catch (err) {
    sendError(res, next, err);
  }
});

// ─── POST /api/staff-money/:id/write-off ─────────────────────
// Owner only. { reason } The rest becomes an expense "Shopping money written
// off — <name>" paid with shopping money (never the drawer).
router.post('/:id/write-off', authenticate, authorize('owner'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) throw httpError(404, NOT_FOUND_MESSAGE);
    const reason = typeof (req.body || {}).reason === 'string' ? req.body.reason.trim().slice(0, 500) : '';
    if (!reason) throw httpError(400, WRITE_OFF_REASON_MESSAGE);
    const db = await getDb();
    const line = await loadLineForUser(db, id, req.user);
    const out = await withMoneyTx(async (tx) => {
      const mo = await tx.prepare('SELECT * FROM staff_money_out WHERE id = ? FOR UPDATE').get(id);
      if (!mo || mo.status !== 'open') throw httpError(409, ALREADY_DONE_MESSAGE);
      const leftP = sm.remainingPaise(mo);
      let expenseId = null;
      if (leftP > 0) {
        const e = await tx.prepare(`
          INSERT INTO expenses (location_id, category, amount, description, payment_method, expense_date,
            created_by, given_to_user_id, register_id, money_out_id, note)
          VALUES (?, 'other', ?, ?, 'shopping_money', ?, ?, ?, NULL, ?, ?)
        `).run(mo.location_id, rupees(leftP), `Shopping money written off — ${line.user_name}`, todayStr(), req.user.id, mo.user_id, id, reason);
        expenseId = Number(e.lastInsertRowid);
      }
      await tx.prepare(`
        UPDATE staff_money_out SET settled_amount = COALESCE(settled_amount, 0) + ?, status = 'written_off',
          closed_at = CURRENT_TIMESTAMP, close_reason = ?
        WHERE id = ?
      `).run(rupees(leftP), reason, id);
      await auditMoneyOut(tx, id, req.user.id, 'shopping_money_written_off', pickOut(mo), {
        ...pickOut(mo), status: 'written_off', written_off: rupees(leftP), reason, expense_id: expenseId,
      });
      return { expenseId };
    });
    res.json({ success: true, data: { id, status: 'written_off', remaining: 0, expense_id: out.expenseId } });
  } catch (err) {
    sendError(res, next, err);
  }
});

// ─── Shop owes: pay back, keep, write off (spec 4.4, 4.7, 5.5) ──
const OWES_NOT_FOUND_MESSAGE = 'This Shop owes line was not found. Pull down to refresh.';
const OWES_OTHER_SHOP_MESSAGE = 'This Shop owes line is from another shop. Switch to that shop and try again.';
const OWES_KEEP_NOT_YOURS_MESSAGE = 'Only the person the shop owes can keep it as their money. Tap Pay back instead.';
const OWES_WRITE_OFF_REASON_MESSAGE = 'Type why this is written off.';

async function loadOwesForUser(db, id, user) {
  const row = await db.prepare(`
    SELECT so.id, so.location_id, so.user_id, so.status, u.name AS user_name
    FROM shop_owes so JOIN users u ON u.id = so.user_id WHERE so.id = ?
  `).get(id);
  if (!row) throw httpError(404, OWES_NOT_FOUND_MESSAGE);
  if (user.role !== 'owner' && (!row.location_id || !(await isLinked(db, Number(user.id), row.location_id)))) {
    throw httpError(403, OWES_OTHER_SHOP_MESSAGE);
  }
  return row;
}
const owesLeftPaise = (o) => Math.max(0, toPaise(o.amount) - toPaise(o.paid_amount));
const pickOwes = (o) => ({
  user_id: Number(o.user_id), amount: Number(o.amount), paid_amount: Number(o.paid_amount) || 0, status: o.status,
  source: o.source || null, expense_id: o.expense_id || null, money_out_id: o.money_out_id || null, location_id: o.location_id || null,
});
async function auditOwes(tx, id, userId, action, before, after) {
  await tx.prepare(`
    INSERT INTO audit_logs (entity_type, entity_id, user_id, action, previous_state, new_state, created_at)
    VALUES ('shop_owes', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(id, userId, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null);
}

// ─── POST /api/staff-money/owes/:id/pay-back ─────────────────
// { amount, method: 'cash' | 'upi' } Part payments allowed. Cash comes out of
// the shop's open register (expected cash and a locked count move with it).
router.post('/owes/:id/pay-back', authenticate, authorize(...GIVER_ROLES), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) throw httpError(404, OWES_NOT_FOUND_MESSAGE);
    const b = req.body || {};
    const amount = parseMoney(b.amount);
    if (amount === null) throw httpError(400, AMOUNT_MESSAGE);
    const method = b.method;
    if (!['cash', 'upi'].includes(method)) throw httpError(400, METHOD_MESSAGE);
    const db = await getDb();
    const line = await loadOwesForUser(db, id, req.user);
    if (line.status !== 'open') throw httpError(409, ALREADY_DONE_MESSAGE);

    const out = await withMoneyTx(async (tx) => {
      // Lock order: the owes line first, then (cash only) the register.
      const o = await tx.prepare('SELECT * FROM shop_owes WHERE id = ? FOR UPDATE').get(id);
      if (!o || o.status !== 'open') throw httpError(409, ALREADY_DONE_MESSAGE);
      const leftP = owesLeftPaise(o);
      const payP = toPaise(amount);
      if (leftP <= 0) throw httpError(409, ALREADY_DONE_MESSAGE);
      if (payP > leftP) {
        const left = inr(rupees(leftP));
        throw httpError(400, `The shop owes ${firstName(line.user_name)} only ${left}. Type ${left} or less.`);
      }
      let registerId = null;
      if (method === 'cash') {
        const reg = o.location_id ? await lockOpenRegister(tx, o.location_id) : null;
        if (!reg) throw httpError(400, ADVANCE_REGISTER_CLOSED_MESSAGE);
        registerId = reg.id;
      }
      await tx.prepare(`
        INSERT INTO shop_owes_payments (owes_id, amount, method, register_id, paid_by) VALUES (?, ?, ?, ?, ?)
      `).run(id, rupees(payP), method, registerId, req.user.id);
      const paidP = toPaise(o.paid_amount) + payP;
      const status = paidP >= toPaise(o.amount) ? 'paid' : 'open';
      await tx.prepare(`
        UPDATE shop_owes SET paid_amount = ?, status = ?,
          closed_at = CASE WHEN ? = 'paid' THEN CURRENT_TIMESTAMP ELSE closed_at END
        WHERE id = ?
      `).run(rupees(paidP), status, status, id);
      if (registerId) await moveSessionCash(tx, registerId, -rupees(payP));
      const after = { ...o, paid_amount: rupees(paidP), status };
      await auditOwes(tx, id, req.user.id, 'shop_owes_paid_back', pickOwes(o), {
        ...pickOwes(after), paid_now: rupees(payP), method, register_id: registerId,
      });
      return { status, remaining: rupees(Math.max(0, toPaise(o.amount) - paidP)) };
    });
    res.json({ success: true, data: { id, status: out.status, remaining: out.remaining } });
  } catch (err) {
    sendError(res, next, err);
  }
});

// ─── POST /api/staff-money/owes/:id/keep ─────────────────────
// "Keep as my money": the owner, on a line the shop owes the owner. Closes it.
router.post('/owes/:id/keep', authenticate, authorize('owner'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) throw httpError(404, OWES_NOT_FOUND_MESSAGE);
    const db = await getDb();
    const line = await loadOwesForUser(db, id, req.user);
    if (Number(line.user_id) !== Number(req.user.id)) throw httpError(403, OWES_KEEP_NOT_YOURS_MESSAGE);
    await withMoneyTx(async (tx) => {
      const o = await tx.prepare('SELECT * FROM shop_owes WHERE id = ? FOR UPDATE').get(id);
      if (!o || o.status !== 'open') throw httpError(409, ALREADY_DONE_MESSAGE);
      await tx.prepare("UPDATE shop_owes SET status = 'kept', closed_at = CURRENT_TIMESTAMP, close_reason = 'kept' WHERE id = ?").run(id);
      await auditOwes(tx, id, req.user.id, 'shop_owes_kept', pickOwes(o), {
        ...pickOwes(o), status: 'kept', kept_amount: rupees(owesLeftPaise(o)),
      });
    });
    res.json({ success: true, data: { id, status: 'kept', remaining: 0 } });
  } catch (err) {
    sendError(res, next, err);
  }
});

// ─── POST /api/staff-money/owes/:id/write-off ────────────────
// Owner only. { reason } The shop will not pay the rest back. No drawer move.
router.post('/owes/:id/write-off', authenticate, authorize('owner'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) throw httpError(404, OWES_NOT_FOUND_MESSAGE);
    const reason = typeof (req.body || {}).reason === 'string' ? req.body.reason.trim().slice(0, 500) : '';
    if (!reason) throw httpError(400, OWES_WRITE_OFF_REASON_MESSAGE);
    const db = await getDb();
    await loadOwesForUser(db, id, req.user);
    await withMoneyTx(async (tx) => {
      const o = await tx.prepare('SELECT * FROM shop_owes WHERE id = ? FOR UPDATE').get(id);
      if (!o || o.status !== 'open') throw httpError(409, ALREADY_DONE_MESSAGE);
      await tx.prepare("UPDATE shop_owes SET status = 'written_off', closed_at = CURRENT_TIMESTAMP, close_reason = ? WHERE id = ?").run(reason, id);
      await auditOwes(tx, id, req.user.id, 'shop_owes_written_off', pickOwes(o), {
        ...pickOwes(o), status: 'written_off', written_off: rupees(owesLeftPaise(o)), reason,
      });
    });
    res.json({ success: true, data: { id, status: 'written_off', remaining: 0 } });
  } catch (err) {
    sendError(res, next, err);
  }
});

// Whole shop-local days from a timestamp to today.
function daysSince(createdAt) {
  const d = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (Number.isNaN(d.getTime())) return 0;
  const from = Date.parse(`${todayStr(d)}T00:00:00Z`);
  const to = Date.parse(`${todayStr()}T00:00:00Z`);
  return Math.max(0, Math.round((to - from) / 86400000));
}
const money = (n) => rupees(toPaise(n));

async function openOwes(db, { locationId = null, userId = null }) {
  const where = [];
  const params = [];
  if (locationId) { where.push('so.location_id = ?'); params.push(locationId); }
  if (userId) { where.push('so.user_id = ?'); params.push(userId); }
  const rows = await db.prepare(`
    SELECT so.id, so.user_id, u.name AS user_name, so.amount, so.paid_amount, so.source, so.money_out_id,
      so.expense_id, so.location_id, so.created_at
    FROM shop_owes so JOIN users u ON u.id = so.user_id
    WHERE so.status = 'open'${where.length ? ' AND ' + where.join(' AND ') : ''}
    ORDER BY so.created_at ASC, so.id ASC
  `).all(...params);
  return rows.map((r) => ({
    id: Number(r.id), user_id: Number(r.user_id), user_name: r.user_name,
    amount: money(r.amount), paid_amount: money(r.paid_amount),
    remaining: rupees(Math.max(0, toPaise(r.amount) - toPaise(r.paid_amount))),
    source: r.source, money_out_id: r.money_out_id ? Number(r.money_out_id) : null,
    expense_id: r.expense_id ? Number(r.expense_id) : null, location_id: r.location_id ? Number(r.location_id) : null,
    created_at: r.created_at,
  })).filter((r) => r.remaining > 0);
}

async function openShopping(db, { locationId = null, userId = null, lateDays }) {
  const where = [];
  const params = [];
  if (locationId) { where.push('mo.location_id = ?'); params.push(locationId); }
  if (userId) { where.push('mo.user_id = ?'); params.push(userId); }
  const rows = await db.prepare(`
    SELECT mo.id, mo.user_id, u.name AS user_name, mo.amount, mo.settled_amount, mo.returned_amount,
      mo.payment_method, mo.location_id, mo.created_at, gb.name AS given_by_name
    FROM staff_money_out mo
    JOIN users u ON u.id = mo.user_id
    LEFT JOIN users gb ON gb.id = mo.given_by
    WHERE mo.status = 'open'${where.length ? ' AND ' + where.join(' AND ') : ''}
    ORDER BY mo.created_at ASC, mo.id ASC
  `).all(...params);
  return rows.map((r) => {
    const days = daysSince(r.created_at);
    return {
      id: Number(r.id), user_id: Number(r.user_id), user_name: r.user_name,
      amount: money(r.amount), remaining: sm.remaining(r), payment_method: r.payment_method,
      location_id: r.location_id ? Number(r.location_id) : null,
      created_at: r.created_at, given_by_name: r.given_by_name || null,
      days, late: days > Number(lateDays),
    };
  }).filter((r) => r.remaining > 0);
}

// ─── GET /api/staff-money/open?location_id= ──────────────────
// The "Shopping money out" card: who holds shopping money, and whom the shop owes.
router.get('/open', authenticate, authorize(...GIVER_ROLES), async (req, res, next) => {
  try {
    const locationId = parseId(req.query.location_id);
    if (!locationId) throw httpError(400, LOCATION_MESSAGE);
    const db = await getDb();
    const limits = await sm.getLimits(db);
    const [shopping, owes] = await Promise.all([
      openShopping(db, { locationId, lateDays: limits.lateDays }),
      openOwes(db, { locationId }),
    ]);
    res.json({ success: true, data: { shopping, owes, late_days: limits.lateDays } });
  } catch (err) {
    sendError(res, next, err);
  }
});

// ─── GET /api/staff-money/history?location_id=&status=&user_id= ──
// Every hand-out, newest first, with its bills and settles (owner/manager).
const HISTORY_STATUSES = ['open', 'settled', 'to_salary', 'removed', 'written_off'];
router.get('/history', authenticate, authorize('owner', 'manager'), async (req, res, next) => {
  try {
    const locationId = parseId(req.query.location_id);
    if (!locationId) throw httpError(400, LOCATION_MESSAGE);
    const where = ['mo.location_id = ?'];
    const params = [locationId];
    const status = req.query.status ? String(req.query.status) : '';
    if (status === 'closed') where.push("mo.status <> 'open'");
    else if (status) {
      if (!HISTORY_STATUSES.includes(status)) throw httpError(400, 'Pick Open or Closed.');
      where.push('mo.status = ?'); params.push(status);
    }
    if (req.query.user_id) {
      const userId = parseId(req.query.user_id);
      if (!userId) throw httpError(400, PERSON_MESSAGE);
      where.push('mo.user_id = ?'); params.push(userId);
    }
    const db = await getDb();
    const rows = await db.prepare(`
      SELECT mo.*, u.name AS user_name, gb.name AS given_by_name, ab.name AS approved_by_name
      FROM staff_money_out mo
      JOIN users u ON u.id = mo.user_id
      LEFT JOIN users gb ON gb.id = mo.given_by
      LEFT JOIN users ab ON ab.id = mo.approved_by
      WHERE ${where.join(' AND ')}
      ORDER BY mo.created_at DESC, mo.id DESC
      LIMIT 200
    `).all(...params);
    const ids = rows.map((r) => Number(r.id));
    let bills = [];
    let settles = [];
    if (ids.length) {
      const ph = ids.map(() => '?').join(', ');
      bills = await db.prepare(`
        SELECT id, money_out_id, amount, description, category, item_id, expense_date, created_by, created_at
        FROM expenses WHERE money_out_id IN (${ph}) ORDER BY id
      `).all(...ids);
      settles = await db.prepare(`
        SELECT s.id, s.money_out_id, s.bills_amount, s.returned_amount, s.returned_method, s.register_id,
          s.settled_by, sb.name AS settled_by_name, s.created_at
        FROM staff_money_settles s LEFT JOIN users sb ON sb.id = s.settled_by
        WHERE s.money_out_id IN (${ph}) ORDER BY s.id
      `).all(...ids);
    }
    const data = rows.map((r) => ({
      id: Number(r.id), user_id: Number(r.user_id), user_name: r.user_name,
      amount: money(r.amount), payment_method: r.payment_method, status: r.status,
      settled_amount: money(r.settled_amount), returned_amount: money(r.returned_amount),
      remaining: r.status === 'open' ? sm.remaining(r) : 0,
      given_by: r.given_by ? Number(r.given_by) : null, given_by_name: r.given_by_name || null,
      approved_by: r.approved_by ? Number(r.approved_by) : null, approved_by_name: r.approved_by_name || null,
      note: r.note || null, created_at: r.created_at, closed_at: r.closed_at || null, close_reason: r.close_reason || null,
      bills: bills.filter((x) => Number(x.money_out_id) === Number(r.id)).map((x) => ({
        id: Number(x.id), amount: money(x.amount), description: x.description, category: x.category,
        item_id: x.item_id ? Number(x.item_id) : null, expense_date: x.expense_date, created_at: x.created_at,
      })),
      settles: settles.filter((x) => Number(x.money_out_id) === Number(r.id)).map((x) => ({
        id: Number(x.id), bills_amount: money(x.bills_amount), returned_amount: money(x.returned_amount),
        returned_method: x.returned_method || null, settled_by_name: x.settled_by_name || null, created_at: x.created_at,
      })),
    }));
    res.json({ success: true, data });
  } catch (err) {
    sendError(res, next, err);
  }
});

// ─── GET /api/staff-money/mine ───────────────────────────────
// My money: my advances this month, shopping money I hold, what the shop owes me.
router.get('/mine', authenticate, authorize(...PEOPLE_ROLES), async (req, res, next) => {
  try {
    const userId = Number(req.user.id);
    const db = await getDb();
    const today = todayStr();
    const limits = await sm.getLimits(db);
    const advances = await db.prepare(`
      SELECT id, amount, date, status, COALESCE(repaid_amount, 0) AS repaid_amount, source
      FROM salary_advances
      WHERE user_id = ? AND status IN ('pending', 'approved', 'repaid')
        AND date >= CAST(? AS date) AND date <= CAST(? AS date)
      ORDER BY date DESC, id DESC
    `).all(userId, `${today.slice(0, 7)}-01`, today);
    const [shopping, owes, t] = await Promise.all([
      openShopping(db, { userId, lateDays: limits.lateDays }),
      openOwes(db, { userId }),
      sm.totals(db, { userId }),
    ]);
    res.json({
      success: true,
      data: {
        advances: advances.map((a) => ({
          id: Number(a.id), amount: money(a.amount), date: a.date, status: a.status, source: a.source || null,
          repaid_amount: money(a.repaid_amount),
          taken_from_pay: a.status === 'repaid' || toPaise(a.repaid_amount) > 0,
        })),
        shopping, owes,
        advances_unpaid: t.advancesUnpaid, shopping_held: t.shoppingHeld, owed: t.owed,
      },
    });
  } catch (err) {
    sendError(res, next, err);
  }
});

module.exports = router;
