// Staff money (spec 2026-11-14-staff-money-usual-now-design.md): salary
// advance at the counter. Async DB layer only. Helpers are default-denied by
// authenticate (nothing here is in helper-routes.js); florists and riders get
// 403 from authorize.
const express = require('express');
const { getDb, withMoneyTx } = require('../config/database-async');
const { authenticate, authorize } = require('../middleware/auth');
const sm = require('../utils/staff-money');
const { payAdvance } = require('../utils/advance-payout');
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

const toPaise = (n) => Math.round((Number(n) || 0) * 100);
const inr = (n) => `₹${Number(n).toLocaleString('en-IN')}`;

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
    const rows = await db.prepare(`
      SELECT u.id, u.name, u.role,
        (SELECT MAX(sa.id) FROM salary_advances sa
          WHERE sa.user_id = u.id AND sa.location_id = ? AND sa.status IN ('approved', 'repaid')) AS last_advance_id,
        (SELECT MAX(sa.date) FROM salary_advances sa
          WHERE sa.user_id = u.id AND sa.location_id = ? AND sa.status IN ('approved', 'repaid')) AS last_advance_day,
        (SELECT MAX(mo.created_at) FROM staff_money_out mo
          WHERE mo.user_id = u.id AND mo.location_id = ? AND mo.status <> 'removed') AS last_out_at
      FROM users u
      JOIN user_locations ul ON ul.user_id = u.id AND ul.location_id = ?
      WHERE u.is_active = 1 AND u.role IN (${roles})
      ORDER BY u.name ASC, u.id ASC
    `).all(locationId, locationId, locationId, locationId, ...PEOPLE_ROLES);

    // Recency key: the later of the last advance day and the last hand-out;
    // advances on the same day keep their order by id.
    const keyOf = (r) => {
      const adv = r.last_advance_day ? `${String(r.last_advance_day).slice(0, 10)}|a${String(r.last_advance_id).padStart(12, '0')}` : '';
      const out = r.last_out_at ? `${String(r.last_out_at).slice(0, 10)}|o${String(r.last_out_at).slice(11)}` : '';
      return adv > out ? adv : out;
    };
    const seen = new Set();
    const people = [];
    for (const r of rows) {
      if (seen.has(Number(r.id))) continue;
      seen.add(Number(r.id));
      people.push({ id: Number(r.id), name: r.name, role: r.role, key: keyOf(r) });
    }
    const ranked = people.filter((p) => p.key).sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
    const rank = new Map(ranked.map((p, i) => [p.id, i + 1]));
    const data = people
      .map((p) => ({ id: p.id, name: p.name, role: p.role, recent_rank: rank.get(p.id) || null }))
      .sort((a, b) => {
        if (a.recent_rank && b.recent_rank) return a.recent_rank - b.recent_rank;
        if (a.recent_rank) return -1;
        if (b.recent_rank) return 1;
        return 0; // both unranked: keep name order
      });
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

// ─── POST /api/staff-money/advance ───────────────────────────
// { location_id, user_id, amount, payment_method, note?, approver_id?, approver_pin? }
router.post('/advance', authenticate, authorize(...GIVER_ROLES), async (req, res, next) => {
  try {
    const b = req.body || {};
    const locationId = parseId(b.location_id);
    if (!locationId) return res.status(400).json({ success: false, message: LOCATION_MESSAGE });
    const userId = parseId(b.user_id);
    if (!userId) return res.status(400).json({ success: false, message: PERSON_MESSAGE });
    const amount = parseMoney(b.amount);
    if (amount === null) return res.status(400).json({ success: false, message: AMOUNT_MESSAGE });
    const method = b.payment_method;
    if (!['cash', 'upi'].includes(method)) return res.status(400).json({ success: false, message: METHOD_MESSAGE });
    const note = typeof b.note === 'string' ? b.note.trim().slice(0, 500) : null;

    const db = await getDb();
    const giver = { id: Number(req.user.id), role: req.user.role, name: req.user.name };
    if (giver.role !== 'owner' && !(await isLinked(db, giver.id, locationId))) {
      return res.status(403).json({ success: false, message: NOT_YOUR_SHOP_MESSAGE });
    }
    const roles = PEOPLE_ROLES.map(() => '?').join(', ');
    const recipient = await db.prepare(`
      SELECT u.id, u.name, u.role FROM users u
      WHERE u.id = ? AND u.is_active = 1 AND u.role IN (${roles})
        AND EXISTS (SELECT 1 FROM user_locations ul WHERE ul.user_id = u.id AND ul.location_id = ?)
    `).get(userId, ...PEOPLE_ROLES, locationId);
    if (!recipient) return res.status(400).json({ success: false, message: PERSON_MESSAGE });

    const limits = await sm.getLimits(db);
    const reasonFor = async (handle) => sm.needsPin({
      giver, recipientId: userId, kind: 'advance', amount, limits, totals: await sm.totals(handle, { userId }),
    });
    const needsPinError = (reason) => httpError(409, sm.needsPinMessage(reason, { name: String(recipient.name || '').trim().split(/\s+/)[0], limits, kind: 'advance' }), { needs_pin: reason });

    // The PIN try is recorded, so it is checked before (never inside) the
    // money transaction.
    let approver = null;
    const hasApprover = b.approver_id !== undefined && b.approver_id !== null && b.approver_id !== '';
    if (!hasApprover) {
      const reason = await reasonFor(db);
      if (reason) throw needsPinError(reason);
    } else {
      if (!b.approver_pin) return res.status(400).json({ success: false, message: PIN_MISSING_MESSAGE });
      const row = await sm.checkApprover(db, { approverId: b.approver_id, pin: String(b.approver_pin), locationId, recipientId: userId });
      approver = { id: Number(row.id), name: row.name || null }; // never keep pin_hash
      if (!approver.name) {
        const n = await db.prepare('SELECT name FROM users WHERE id = ?').get(approver.id);
        approver.name = n ? n.name : 'A manager';
      }
    }

    const result = await withMoneyTx(async (tx) => {
      // Per-person lock so two advances to one person cannot both pass the limits.
      await tx.prepare('SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock(?, ?)) x').get(7302, userId);
      if (!approver) {
        const reason = await reasonFor(tx);
        if (reason) throw needsPinError(reason);
      }
      return payAdvance(tx, {
        userId, amount, method, locationId, note,
        givenBy: giver.id,
        approvedBy: approver ? approver.id : giver.id,
        source: 'counter',
      });
    });

    // The owner hears about a manager taking money for themself, and about
    // every amount a PIN confirmed.
    const managerSelf = giver.role === 'manager' && giver.id === userId;
    if (approver || managerSelf) {
      const body = approver
        ? `${recipient.name} got a ${inr(amount)} salary advance from ${giver.name}. ${approver.name} confirmed it with their PIN.`
        : `${giver.name} (manager) took a ${inr(amount)} salary advance.`;
      await notifyByRole({
        roles: ['owner'],
        locationId,
        title: 'Salary advance',
        body,
        type: 'staff_money_advance',
        data: { screen: 'Expenses', advanceId: result.advanceId, userId },
      });
    }

    const after = await sm.totals(db, { userId });
    res.status(201).json({
      success: true,
      data: { advance_id: result.advanceId, expense_id: result.expenseId, unpaid_after: after.advancesUnpaid },
    });
  } catch (err) {
    sendError(res, next, err);
  }
});

module.exports = router;
