// Helper cash bags (spec 11-12): the counter's view of the cash each helper
// holds in bag mode, the exact-amount reveal, change floats and the blind
// handover. Async DB layer only.
const express = require('express');
const { withTransaction, getDb } = require('../config/database-async');
const { authenticate, authorize } = require('../middleware/auth');
const { getBag, listBags, maskAmount, readCashMode, lockBag } = require('../utils/helper-bags');
const { isAccessExpired } = require('../utils/helper-access');
const { REGISTER_CLOSED_MESSAGE } = require('../utils/register-guard');
const { HELPER_DENIED_MESSAGE } = require('../utils/helper-routes');

const router = express.Router();

const STAFF_ROLES = ['owner', 'manager', 'employee', 'counter_staff'];

const ALREADY_COLLECTED_MESSAGE = 'Already collected — refresh';
const LOCATION_MESSAGE = 'Pick the shop first, then try again.';
const NO_HELPER_MESSAGE = 'That helper was not found. Refresh and try again.';
const FLOAT_HELPER_MESSAGE = "This helper can't take a float here. Pick a helper who works at this shop and still has access.";
const AMOUNT_MESSAGE = 'Type an amount above ₹0, like 500 or 500.50.';
const COUNTED_MESSAGE = 'Type the amount you counted, like 3150 or 3150.50.';
const PARTIAL_ZERO_MESSAGE = 'Type the amount you counted, or choose "Yes, settle".';
const BAGS_OFF_MESSAGE = 'Helper cash bags are off. The owner can turn them on in Settings.';
const overCountMessage = (name) => `That's more than ${name} should have — count again or choose "Yes, settle"`;

const toPaise = (n) => Math.round((Number(n) || 0) * 100);
const fromPaise = (p) => p / 100;

// Money from the request: a number or numeric string with at most 2 decimals
// (paise). Returns paise, or null when it is not a valid amount.
function parseMoney(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const s = String(value).trim();
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(s)) return null; // DECIMAL(10,2)
  return toPaise(Number(s));
}

function parseId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const isActive = (u) => Number(u.is_active) === 1 || u.is_active === true;

// Last float given to this helper at this location (pre-fills Give float).
async function lastFloat(db, staffId, locationId) {
  const row = await db.prepare(`
    SELECT expected_amount, created_at FROM staff_cash_movements
    WHERE staff_id = ? AND location_id = ? AND type = 'float_out'
    ORDER BY created_at DESC, id DESC LIMIT 1
  `).get(staffId, locationId);
  return row ? { amount: Number(row.expected_amount), created_at: row.created_at } : null;
}

// Open register at this location, row-locked for the rest of the transaction.
// A register closed meanwhile is re-checked by Postgres after the lock wait
// and drops out, so the caller sees "closed" instead of writing into it.
async function lockOpenRegister(tx, locationId) {
  return tx.prepare(
    'SELECT id FROM cash_registers WHERE location_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1 FOR UPDATE'
  ).get(locationId);
}

// ─── GET /api/helper-cash/bags?location_id= ─────────────────
// Masked amounts only. A helper gets only their own row.
router.get(
  '/bags',
  authenticate,
  authorize(...STAFF_ROLES, 'helper'),
  async (req, res, next) => {
    try {
      const locationId = parseId(req.query.location_id);
      if (!locationId) return res.status(400).json({ success: false, message: LOCATION_MESSAGE });
      const db = await getDb();
      const mode = await readCashMode(db);

      let bags;
      if (req.user.role === 'helper') {
        const bag = await getBag(db, req.user.id, locationId);
        bags = [{
          staff_id: req.user.id,
          name: req.user.name,
          held: bag.held,
          sale_count: bag.sale_count,
          access_ended: false, // they are signed in, so their access is still on
        }];
      } else {
        bags = (await listBags(db, locationId)).map((b) => ({
          staff_id: b.staff_id,
          name: b.name,
          held: b.held,
          sale_count: b.sale_count,
          access_ended: !b.is_active || isAccessExpired(b.access_until),
        }));
      }

      const totalPaise = bags.reduce((s, b) => s + toPaise(b.held), 0);
      const data = {
        mode,
        total_masked: maskAmount(fromPaise(totalPaise)),
        // Whether any cash is out at all (the masked text cannot say: ₹0.50 masks like ₹0)
        has_cash: totalPaise !== 0,
        bags: bags.map((b) => ({
          staff_id: b.staff_id,
          name: b.name,
          held_masked: maskAmount(b.held),
          has_cash: toPaise(b.held) !== 0,
          sale_count: b.sale_count,
          access_ended: b.access_ended,
        })),
      };

      // include_idle=1 (counter only): every helper who can take a float here,
      // including ones with an empty bag, for the Give float picker.
      if (req.user.role !== 'helper' && String(req.query.include_idle || '') === '1') {
        const people = await db.prepare(`
          SELECT u.id, u.name, u.access_until FROM users u
          JOIN user_locations ul ON ul.user_id = u.id AND ul.location_id = ?
          WHERE u.role = 'helper' AND u.is_active = 1
          ORDER BY u.name ASC, u.id ASC
        `).all(locationId);
        const helpers = [];
        for (const p of people) {
          if (isAccessExpired(p.access_until)) continue;
          const last = await lastFloat(db, p.id, locationId);
          helpers.push({ staff_id: p.id, name: p.name, last_float: last ? last.amount : null });
        }
        data.helpers = helpers;
      }

      res.json({ success: true, data });
    } catch (err) { next(err); }
  }
);

// ─── POST /api/helper-cash/bags/:staffId/reveal ─────────────
// Exact figures, and an audit row for every look.
router.post(
  '/bags/:staffId(\\d+)/reveal',
  authenticate,
  authorize(...STAFF_ROLES, 'helper'),
  async (req, res, next) => {
    try {
      const staffId = parseId(req.params.staffId);
      if (req.user.role === 'helper' && staffId !== Number(req.user.id)) {
        return res.status(403).json({ success: false, message: HELPER_DENIED_MESSAGE });
      }
      const locationId = parseId(req.body && req.body.location_id);
      if (!locationId) return res.status(400).json({ success: false, message: LOCATION_MESSAGE });

      const db = await getDb();
      const person = await db.prepare('SELECT id FROM users WHERE id = ?').get(staffId);
      if (!person) return res.status(404).json({ success: false, message: NO_HELPER_MESSAGE });

      const bag = await getBag(db, staffId, locationId);
      const last = await lastFloat(db, staffId, locationId);
      await db.prepare(`
        INSERT INTO audit_logs (entity_type, entity_id, user_id, action, previous_state, new_state, created_at)
        VALUES ('user', ?, ?, 'helper_bag_reveal', ?, ?, CURRENT_TIMESTAMP)
      `).run(
        staffId,
        req.user.id,
        JSON.stringify({ location_id: locationId }),
        JSON.stringify({ held: bag.held })
      );

      res.json({
        success: true,
        data: {
          held: bag.held,
          floats: bag.floats,
          cash_sales: bag.cash_sales,
          settled: bag.settled,
          last_float: last,
        },
      });
    } catch (err) { next(err); }
  }
);

// ─── POST /api/helper-cash/float ────────────────────────────
// Change float out of the open register into a helper's bag.
router.post(
  '/float',
  authenticate,
  authorize(...STAFF_ROLES),
  async (req, res, next) => {
    try {
      const body = req.body || {};
      const staffId = parseId(body.staff_id);
      const locationId = parseId(body.location_id);
      if (!locationId) return res.status(400).json({ success: false, message: LOCATION_MESSAGE });
      if (!staffId) return res.status(400).json({ success: false, message: NO_HELPER_MESSAGE });
      const amountP = parseMoney(body.amount);
      if (amountP === null || amountP <= 0) return res.status(400).json({ success: false, message: AMOUNT_MESSAGE });

      const db = await getDb();
      // A float only makes sense when helpers keep their own cash
      if ((await readCashMode(db)) !== 'bag') return res.status(409).json({ success: false, message: BAGS_OFF_MESSAGE });
      const helper = await db.prepare(`
        SELECT u.id, u.name, u.role, u.is_active, u.access_until,
          EXISTS (SELECT 1 FROM user_locations ul WHERE ul.user_id = u.id AND ul.location_id = ?) AS at_location
        FROM users u WHERE u.id = ?
      `).get(locationId, staffId);
      if (!helper) return res.status(404).json({ success: false, message: NO_HELPER_MESSAGE });
      if (helper.role !== 'helper' || !isActive(helper) || isAccessExpired(helper.access_until) || !helper.at_location) {
        return res.status(400).json({ success: false, message: FLOAT_HELPER_MESSAGE });
      }

      const outcome = await withTransaction(async (tx) => {
        // Bag lock first, then the register row: same order as a handover
        await lockBag(tx, staffId);
        const register = await lockOpenRegister(tx, locationId);
        if (!register) return { code: 400, message: REGISTER_CLOSED_MESSAGE };

        const amount = fromPaise(amountP);
        const ins = await tx.prepare(`
          INSERT INTO staff_cash_movements
            (location_id, staff_id, type, expected_amount, counted_amount, settled_amount, difference, is_final, register_id, recorded_by, created_at)
          VALUES (?, ?, 'float_out', ?, 0, 0, 0, 0, ?, ?, clock_timestamp())
        `).run(locationId, staffId, amount, register.id, req.user.id);
        await tx.prepare('UPDATE cash_registers SET expected_cash = expected_cash - ? WHERE id = ? AND closed_at IS NULL')
          .run(amount, register.id);
        const bag = await getBag(tx, staffId, locationId);
        return { movement_id: ins.lastInsertRowid, register_id: register.id, amount, held: bag.held };
      });

      if (outcome.code) return res.status(outcome.code).json({ success: false, message: outcome.message });
      res.status(201).json({
        success: true,
        message: `Gave ₹${outcome.amount.toLocaleString('en-IN')} to ${helper.name}.`,
        data: {
          movement_id: outcome.movement_id,
          register_id: outcome.register_id,
          staff_id: staffId,
          amount: outcome.amount,
          held_masked: maskAmount(outcome.held),
        },
      });
    } catch (err) { next(err); }
  }
);

// ─── POST /api/helper-cash/handover ─────────────────────────
// Blind handover: the request carries only what was counted. What the helper
// should have had comes back only in the response.
router.post(
  '/handover',
  authenticate,
  authorize(...STAFF_ROLES),
  async (req, res, next) => {
    try {
      const body = req.body || {};
      const staffId = parseId(body.staff_id);
      const locationId = parseId(body.location_id);
      if (!locationId) return res.status(400).json({ success: false, message: LOCATION_MESSAGE });
      if (!staffId) return res.status(400).json({ success: false, message: NO_HELPER_MESSAGE });
      const countedP = parseMoney(body.counted_amount);
      if (countedP === null) return res.status(400).json({ success: false, message: COUNTED_MESSAGE });
      const isFinal = body.is_final === true || body.is_final === 'true' || body.is_final === 1;
      // Only a real true or false is accepted, so a preview can never commit by mistake
      if (body.preview !== undefined && body.preview !== true && body.preview !== false) {
        return res.status(400).json({ success: false, message: 'Something went wrong. Close this and try again.' });
      }
      const isPreview = body.preview === true;
      if (isPreview && countedP <= 0) return res.status(400).json({ success: false, message: COUNTED_MESSAGE });

      const db = await getDb();
      // An inactive or expired helper is still collectable (spec 11.4)
      const helper = await db.prepare('SELECT id, name FROM users WHERE id = ?').get(staffId);
      if (!helper) return res.status(404).json({ success: false, message: NO_HELPER_MESSAGE });

      const outcome = await withTransaction(async (tx) => {
        // Serialise every change to this bag, then read it on this same
        // transaction: a second handover waits here and then sees the first.
        await lockBag(tx, staffId);
        const bag = await getBag(tx, staffId, locationId);
        const expectedP = toPaise(bag.held);
        if (expectedP <= 0) return { code: 409, message: ALREADY_COLLECTED_MESSAGE };

        // Preview: what the counter sheet shows after the count, before the
        // settle choice. Writes nothing but its own audit row (the counted
        // amount only, so the expected amount never sits in the log).
        if (isPreview) {
          const open = await tx.prepare('SELECT id FROM cash_registers WHERE location_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1').get(locationId);
          if (!open) return { code: 400, message: REGISTER_CLOSED_MESSAGE };
          await tx.prepare(`
            INSERT INTO audit_logs (entity_type, entity_id, user_id, action, previous_state, new_state, created_at)
            VALUES ('user', ?, ?, 'helper_bag_handover_preview', ?, ?, CURRENT_TIMESTAMP)
          `).run(staffId, req.user.id, JSON.stringify({ location_id: locationId }), JSON.stringify({ counted: fromPaise(countedP) }));
          return {
            preview: true,
            expected: fromPaise(expectedP),
            counted: fromPaise(countedP),
            difference: fromPaise(countedP - expectedP),
            remaining_if_partial: fromPaise(Math.max(0, expectedP - countedP)),
          };
        }

        let settledP;
        let differenceP = 0;
        if (isFinal) {
          settledP = expectedP;
          differenceP = countedP - expectedP; // short is negative
        } else {
          if (countedP <= 0) return { code: 400, message: PARTIAL_ZERO_MESSAGE };
          if (countedP > expectedP) return { code: 400, message: overCountMessage(helper.name) };
          settledP = countedP;
        }

        const register = await lockOpenRegister(tx, locationId);
        if (!register) return { code: 400, message: REGISTER_CLOSED_MESSAGE };

        const ins = await tx.prepare(`
          INSERT INTO staff_cash_movements
            (location_id, staff_id, type, expected_amount, counted_amount, settled_amount, difference, is_final, register_id, recorded_by, created_at)
          VALUES (?, ?, 'handover_in', ?, ?, ?, ?, ?, ?, ?, clock_timestamp())
        `).run(locationId, staffId, fromPaise(expectedP), fromPaise(countedP), fromPaise(settledP), fromPaise(differenceP), isFinal ? 1 : 0, register.id, req.user.id);
        if (countedP > 0) {
          await tx.prepare('UPDATE cash_registers SET expected_cash = expected_cash + ? WHERE id = ? AND closed_at IS NULL')
            .run(fromPaise(countedP), register.id);
        }
        await tx.prepare(`
          INSERT INTO audit_logs (entity_type, entity_id, user_id, action, previous_state, new_state, created_at)
          VALUES ('user', ?, ?, 'helper_bag_handover', ?, ?, CURRENT_TIMESTAMP)
        `).run(staffId, req.user.id, JSON.stringify({ location_id: locationId, register_id: register.id }),
          JSON.stringify({ movement_id: ins.lastInsertRowid, counted: fromPaise(countedP), is_final: isFinal }));
        return {
          movement_id: ins.lastInsertRowid,
          register_id: register.id,
          expected: fromPaise(expectedP),
          counted: fromPaise(countedP),
          difference: fromPaise(differenceP),
          remaining: fromPaise(expectedP - settledP),
        };
      });

      if (outcome.code) return res.status(outcome.code).json({ success: false, message: outcome.message });
      if (outcome.preview) {
        return res.status(200).json({ success: true, data: { preview: true, staff_id: staffId, expected: outcome.expected, counted: outcome.counted, difference: outcome.difference, remaining_if_partial: outcome.remaining_if_partial } });
      }
      res.status(200).json({
        success: true,
        data: {
          movement_id: outcome.movement_id,
          register_id: outcome.register_id,
          staff_id: staffId,
          is_final: isFinal,
          expected: outcome.expected,
          counted: outcome.counted,
          difference: outcome.difference,
          remaining: outcome.remaining,
        },
      });
    } catch (err) { next(err); }
  }
);

module.exports = router;
