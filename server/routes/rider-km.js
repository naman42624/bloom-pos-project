// Rider km account (spec 2026-11-15-rider-km-account-design.md): bike meter
// readings, gaps, corrections, the Km rate, the account view and settling
// (the maths and writes live in utils/rider-km-data.js). Async DB layer only. Helpers are default-denied by
// authenticate (nothing here is in helper-routes.js).
const express = require('express');
const { getDb, withMoneyTx } = require('../config/database-async');
const { authenticate } = require('../middleware/auth');
const { buildChain, priceStretches } = require('../utils/rider-km');
const {
  loadChainInputs, isRider, fmtLocal, computeSettlement, commitSettlement, SETTLE_MSG,
} = require('../utils/rider-km-data');
const { todayStr } = require('../utils/time');

const router = express.Router();

const GIVER_ROLES = ['owner', 'manager', 'employee', 'counter_staff'];
const isBoss = (role) => role === 'owner' || role === 'manager';
const RIDER_LOCK_NS = 7304;
const BACK_DAYS = 7;

const MSG = {
  location: 'Pick a shop first.',
  rider: 'Pick the rider from the list.',
  kind: 'Pick Arriving, Going home or Type km instead.',
  meter: 'Type the number shown on the bike meter, like 12345.',
  typed: 'Type the km, like 24.',
  meterDown: "The meter can't go down. Check the number, or tap Type km instead.",
  settled: 'That day is already settled. Ask the owner or a manager to add a correction.',
  backDays: "Counter staff can only add or change readings from the last 7 days. Ask the owner or a manager.",
  notYourShop: "You can't work with this rider from here. Switch to your own shop and try again.",
  notFound: 'This reading was not found. Pull down to refresh.',
  notMine: 'Only the person who added this reading can change it. Ask the owner or a manager.',
  future: 'That time has not come yet. Pick a time that has passed.',
  badTime: 'Pick the date and time again.',
  gap: 'This gap is no longer there. Pull down to refresh.',
  answer: 'Pick Type km or No work trip.',
  correctionKm: 'Type the km to add or take off, like 12 or -5.',
  correctionNote: 'Type why, so it is clear later.',
  rate: 'Type a rate above ₹0, like 3.',
  usual: 'Type the usual home ride in km, like 8, or leave it empty.',
  riderOnly: 'This is only for riders.',
  forbidden: "You don't have access to this.",
};

const toPaise = (n) => Math.round((Number(n) || 0) * 100);
const round1 = (n) => Math.round(n * 10) / 10;

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
  if (err.code_name) body.code = err.code_name;
  return res.status(status).json(body);
}
const coded = (status, code, message) => httpError(status, message, { code_name: code });

function parseId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
// A number with at most 1 decimal, or null.
function parseKm(v, { min = 0, max = 100000, allowZero = true } = {}) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const s = String(v).trim();
  if (!/^-?\d{1,7}(\.\d)?$/.test(s)) return null;
  const n = Number(s);
  if (n < min || n > max || (!allowZero && n === 0)) return null;
  return n;
}
const forGivers = (req, res, next) => (GIVER_ROLES.includes(req.user.role)
  ? next()
  : res.status(403).json({ success: false, message: MSG.forbidden }));

async function isLinked(db, userId, locationId) {
  return !!(await db.prepare('SELECT 1 AS ok FROM user_locations WHERE user_id = ? AND location_id = ?').get(userId, locationId));
}
// Owner anywhere; others only when they share a shop with the rider.
async function sharesShop(db, actor, riderId) {
  if (actor.role === 'owner') return true;
  return !!(await db.prepare(`
    SELECT 1 AS ok FROM user_locations a JOIN user_locations b ON a.location_id = b.location_id
    WHERE a.user_id = ? AND b.user_id = ?
  `).get(actor.id, riderId));
}
async function riderRow(db, id) {
  return db.prepare("SELECT id, name, km_usual_home_ride FROM users WHERE id = ? AND role = 'delivery_partner' AND is_active = 1").get(id);
}
async function lockRider(tx, riderId) {
  await tx.prepare('SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock(?, ?)) x').get(RIDER_LOCK_NS, riderId);
}
async function audit(tx, entityId, userId, action, before, after) {
  await tx.prepare(`
    INSERT INTO audit_logs (entity_type, entity_id, user_id, action, previous_state, new_state, created_at)
    VALUES ('rider_km', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(entityId, userId, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null);
}

function minBackDate() {
  const d = new Date(`${todayStr()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - BACK_DAYS);
  return d.toISOString().slice(0, 10);
}

// 'YYYY-MM-DD HH:MM:SS' that is a real calendar date and clock time
// (2026-02-30 or 25:00 is not).
function realLocalTime(local) {
  const m = local.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return false;
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number);
  if (h > 23 || mi > 59 || se > 59) return false;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

// A client time as a shop-local 'YYYY-MM-DD HH:MM:SS'. With no zone it is
// taken as already shop-local; with a zone (Z or an offset) it is converted.
function resolveReadAt(input) {
  if (input === undefined || input === null || input === '') return fmtLocal(new Date());
  const s = String(input).trim();
  let local;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s) && /\d{2}:\d{2}/.test(s)) {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) throw httpError(400, MSG.badTime);
    local = fmtLocal(d);
  } else {
    const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(?::(\d{2}))?)?/);
    if (!m) throw httpError(400, MSG.badTime);
    local = `${m[1]} ${m[2] || '12:00'}:${m[3] || '00'}`;
    if (!realLocalTime(local)) throw httpError(400, MSG.badTime);
  }
  if (local > fmtLocal(new Date(Date.now() + 5 * 60 * 1000))) throw httpError(400, MSG.future);
  return local;
}

function chainOf(inputs) {
  return buildChain(inputs.readings, inputs.answers, { usualHomeKm: inputs.usualOverrideKm });
}
const cutoffOf = (inputs) => (inputs.lastSettlement && inputs.lastSettlement.cutoff_read_at) || null;
const isUnsettled = (s, cutoff) => !cutoff || String(s.endAt) > cutoff;

function buildView(rider, inputs) {
  const chain = chainOf(inputs);
  const cutoff = cutoffOf(inputs);
  const open = chain.stretches.filter((s) => isUnsettled(s, cutoff));
  const corrections = inputs.corrections.filter((c) => c.settlement_id == null);
  const priced = priceStretches(open, inputs.rates, corrections);
  const gapsOpen = open.filter((s) => s.kind === 'gap' && !s.answer).length;
  const readings = inputs.readings.filter((r) => !cutoff || String(r.read_at) > cutoff);
  const lastReading = inputs.readings.length ? inputs.readings[inputs.readings.length - 1] : null;
  return {
    chain, cutoff, open, priced, gapsOpen, readings, corrections, lastReading,
    data: {
      rider: { id: Number(rider.id), name: rider.name },
      stretches: open.map((s) => ({
        kind: s.kind, from_reading_id: s.fromId, to_reading_id: s.toId, km: s.km, end_at: s.endAt,
        answer: s.answer, reason: s.reason,
      })),
      open_day: chain.openDay,
      gaps_open: gapsOpen,
      usual_home_km: inputs.usualHomeKm,
      unsettled: {
        paid_km: priced.paidKm,
        by_rate: priced.byRate.map((g) => ({ rate: g.rate, km: g.km, amount_paise: g.amountPaise })),
        amount_paise: priced.amountPaise,
      },
      readings: readings.map(outReading),
      corrections: corrections.map((c) => ({ id: Number(c.id), km: Number(c.km), note: c.note, for_date: c.for_date })),
      last_reading: lastReading ? outReading(lastReading) : null,
      last_settlement: inputs.lastSettlement
        ? {
          id: Number(inputs.lastSettlement.id), action: inputs.lastSettlement.action,
          paid_km: inputs.lastSettlement.paid_km == null ? null : Number(inputs.lastSettlement.paid_km),
          net_amount: inputs.lastSettlement.net_amount == null ? null : Number(inputs.lastSettlement.net_amount),
          created_at: inputs.lastSettlement.created_at,
        }
        : null,
    },
  };
}
const outReading = (r) => ({
  id: Number(r.id), kind: r.kind, meter: r.meter == null ? null : Number(r.meter),
  typed_km: r.typed_km == null ? null : Number(r.typed_km), read_at: r.read_at, note: r.note || null,
  location_id: r.location_id == null ? null : Number(r.location_id),
});

async function history(db, userId) {
  const rows = await db.prepare(`
    SELECT id, action, paid_km, km_amount, net_amount, moved_amount, moved_method, carry_out, created_at
    FROM rider_km_settlements WHERE user_id = ? ORDER BY id DESC LIMIT 20
  `).all(userId);
  return rows.map((r) => ({
    id: Number(r.id), action: r.action,
    paid_km: r.paid_km == null ? null : Number(r.paid_km),
    km_amount: r.km_amount == null ? null : Number(r.km_amount),
    net_amount: r.net_amount == null ? null : Number(r.net_amount),
    moved_amount: r.moved_amount == null ? null : Number(r.moved_amount),
    moved_method: r.moved_method, carry_out: r.carry_out == null ? null : Number(r.carry_out),
    created_at: r.created_at,
  }));
}

async function accountFor(db, riderId) {
  const rider = await riderRow(db, riderId);
  if (!rider) return null;
  const inputs = await loadChainInputs(db, riderId);
  const v = buildView(rider, inputs);
  return { ...v.data, history: await history(db, riderId) };
}

// A reading is settled when a settlement holds it or it is at or before the
// last cutoff. Checked in SQL so no time zone shifts the comparison.
async function inSettledRange(tx, riderId, readAtLocal) {
  const row = await tx.prepare(`
    SELECT 1 AS ok FROM rider_km_settlements s
    JOIN rider_km_readings c ON c.id = s.cutoff_reading_id
    WHERE s.user_id = ? AND c.read_at >= CAST(? AS timestamp)
    LIMIT 1
  `).get(riderId, readAtLocal);
  return !!row;
}

// Meter must not go down against the nearest meter readings before/after.
async function meterOrderOk(tx, riderId, meter, readAtLocal, excludeId) {
  const prev = await tx.prepare(`
    SELECT meter FROM rider_km_readings
    WHERE user_id = ? AND removed_at IS NULL AND kind <> 'typed' AND id <> ? AND read_at <= CAST(? AS timestamp)
    ORDER BY read_at DESC, id DESC LIMIT 1
  `).get(riderId, excludeId || 0, readAtLocal);
  if (prev && meter < Number(prev.meter)) return false;
  const next = await tx.prepare(`
    SELECT meter FROM rider_km_readings
    WHERE user_id = ? AND removed_at IS NULL AND kind <> 'typed' AND id <> ? AND read_at > CAST(? AS timestamp)
    ORDER BY read_at ASC, id ASC LIMIT 1
  `).get(riderId, excludeId || 0, readAtLocal);
  if (next && meter > Number(next.meter)) return false;
  return true;
}

// Work stretch over 300 km touching this reading needs a confirm.
function bigWork(inputs, readingId) {
  const chain = chainOf(inputs);
  const s = chain.stretches.find((x) => x.kind === 'work' && (x.toId === readingId || x.fromId === readingId) && x.km > 300);
  return s || null;
}
function todayWorkKm(inputs) {
  const today = todayStr();
  return round1(chainOf(inputs).stretches
    .filter((s) => s.kind === 'work' && String(s.endAt).slice(0, 10) === today)
    .reduce((a, s) => a + s.km, 0));
}
async function readingRow(tx, id) {
  return tx.prepare(`
    SELECT id, user_id, location_id, kind, meter, typed_km, to_char(read_at, 'YYYY-MM-DD HH24:MI:SS') AS read_at,
           note, created_by, settlement_id, removed_at
    FROM rider_km_readings WHERE id = ?
  `).get(id);
}

// ─── GET /api/rider-km/riders?location_id= ───────────────────
router.get('/riders', authenticate, forGivers, async (req, res, next) => {
  try {
    const locationId = parseId(req.query.location_id);
    if (!locationId) return res.status(400).json({ success: false, message: MSG.location });
    const db = await getDb();
    if (req.user.role !== 'owner' && !(await isLinked(db, req.user.id, locationId))) {
      return res.status(403).json({ success: false, message: MSG.notYourShop });
    }
    const riders = await db.prepare(`
      SELECT u.id, u.name FROM users u
      WHERE u.role = 'delivery_partner' AND u.is_active = 1
        AND EXISTS (SELECT 1 FROM user_locations ul WHERE ul.user_id = u.id AND ul.location_id = ?)
      ORDER BY u.name ASC, u.id ASC
    `).all(locationId);
    const data = [];
    for (const r of riders) {
      const v = buildView(r, await loadChainInputs(db, r.id));
      // The settle sheet's figure now; unknown while a gap is unanswered.
      const s = await computeSettlement(db, r.id);
      data.push({
        id: Number(r.id), name: r.name, unsettled_km: v.priced.paidKm, open_day: v.chain.openDay,
        gaps: v.gapsOpen, balance_paise: s.gapsOpen ? null : s.netPaise,
      });
    }
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// ─── POST /api/rider-km/readings ─────────────────────────────
router.post('/readings', authenticate, forGivers, async (req, res, next) => {
  try {
    const b = req.body || {};
    const riderId = parseId(b.user_id);
    const locationId = parseId(b.location_id);
    if (!riderId) return res.status(400).json({ success: false, message: MSG.rider });
    if (!locationId) return res.status(400).json({ success: false, message: MSG.location });
    if (!['arrive', 'leave', 'typed'].includes(b.kind)) return res.status(400).json({ success: false, message: MSG.kind });
    let meter = null;
    let typedKm = null;
    if (b.kind === 'typed') {
      typedKm = parseKm(b.typed_km, { min: 0, max: 2000, allowZero: false });
      if (typedKm === null) return res.status(400).json({ success: false, message: MSG.typed });
    } else {
      meter = parseKm(b.meter, { min: 0, max: 9999999 });
      if (meter === null) return res.status(400).json({ success: false, message: MSG.meter });
    }
    const db = await getDb();
    if (!(await isRider(db, riderId, locationId))) return res.status(400).json({ success: false, message: MSG.rider });
    if (req.user.role !== 'owner' && !(await isLinked(db, req.user.id, locationId))) {
      return res.status(403).json({ success: false, message: MSG.notYourShop });
    }
    const readAt = resolveReadAt(b.read_at);
    const note = b.note ? String(b.note).slice(0, 200) : null;

    const out = await withMoneyTx(async (tx) => {
      await lockRider(tx, riderId);
      if (await inSettledRange(tx, riderId, readAt)) throw coded(409, 'SETTLED_RANGE', MSG.settled);
      if (!isBoss(req.user.role) && readAt.slice(0, 10) < minBackDate()) throw httpError(403, MSG.backDays);

      const dup = await tx.prepare(`
        SELECT id FROM rider_km_readings
        WHERE user_id = ? AND removed_at IS NULL AND kind = ?
          AND ${b.kind === 'typed' ? 'typed_km' : 'meter'} = ?
          AND ABS(EXTRACT(EPOCH FROM (read_at - CAST(? AS timestamp)))) <= 120
        ORDER BY id ASC LIMIT 1
      `).get(riderId, b.kind, b.kind === 'typed' ? typedKm : meter, readAt);
      if (dup) {
        const existing = await readingRow(tx, dup.id);
        return { reading: outReading(existing), today_work_km: todayWorkKm(await loadChainInputs(tx, riderId)), duplicate: true };
      }

      if (meter !== null && !(await meterOrderOk(tx, riderId, meter, readAt, 0))) throw coded(409, 'METER_DOWN', MSG.meterDown);

      const ins = { id: Number((await tx.prepare(`
        INSERT INTO rider_km_readings (user_id, location_id, kind, meter, typed_km, read_at, note, created_by)
        VALUES (?, ?, ?, ?, ?, CAST(? AS timestamp), ?, ?)
      `).run(riderId, locationId, b.kind, meter, typedKm, readAt, note, req.user.id)).lastInsertRowid) };
      const inputs = await loadChainInputs(tx, riderId);
      const big = bigWork(inputs, ins.id);
      if (big && !b.confirm_big) {
        throw coded(409, 'CONFIRM_BIG', `Is ${meter} right? That is ${big.km} km of work.`);
      }
      const row = await readingRow(tx, ins.id);
      await audit(tx, ins.id, req.user.id, 'km_reading_add', null, { user_id: riderId, kind: b.kind, meter, typed_km: typedKm, read_at: readAt });
      return { reading: outReading(row), today_work_km: todayWorkKm(inputs), duplicate: false };
    });
    res.status(out.duplicate ? 200 : 201).json({ success: true, data: { reading: out.reading, today_work_km: out.today_work_km } });
  } catch (err) { sendError(res, next, err); }
});

// Shared checks for changing or removing a reading.
async function guardChange(tx, req, reading) {
  if (!reading || reading.removed_at) throw httpError(404, MSG.notFound);
  if (!(await sharesShop(tx, req.user, reading.user_id))) throw httpError(403, MSG.notYourShop);
  if (reading.settlement_id != null || (await inSettledRange(tx, reading.user_id, reading.read_at))) {
    throw coded(409, 'SETTLED', MSG.settled);
  }
  if (!isBoss(req.user.role)) {
    if (Number(reading.created_by) !== Number(req.user.id)) throw httpError(403, MSG.notMine);
    if (String(reading.read_at).slice(0, 10) < minBackDate()) throw httpError(403, MSG.backDays);
  }
}

// ─── PUT /api/rider-km/readings/:id ──────────────────────────
router.put('/readings/:id', authenticate, forGivers, async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ success: false, message: MSG.notFound });
    const b = req.body || {};
    const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
    if (has('kind') && !['arrive', 'leave', 'typed'].includes(b.kind)) return res.status(400).json({ success: false, message: MSG.kind });
    const newReadAt = has('read_at') ? resolveReadAt(b.read_at) : null;

    const out = await withMoneyTx(async (tx) => {
      const first = await readingRow(tx, id);
      if (!first) throw httpError(404, MSG.notFound);
      await lockRider(tx, first.user_id);
      const reading = await readingRow(tx, id);
      await guardChange(tx, req, reading);
      const kind = has('kind') ? b.kind : reading.kind;
      let meter = reading.meter == null ? null : Number(reading.meter);
      let typedKm = reading.typed_km == null ? null : Number(reading.typed_km);
      if (has('meter')) {
        meter = parseKm(b.meter, { min: 0, max: 9999999 });
        if (meter === null) throw httpError(400, MSG.meter);
      }
      if (has('typed_km')) {
        typedKm = parseKm(b.typed_km, { min: 0, max: 2000, allowZero: false });
        if (typedKm === null) throw httpError(400, MSG.typed);
      }
      if (kind === 'typed') { meter = null; if (typedKm === null) throw httpError(400, MSG.typed); }
      else { typedKm = null; if (meter === null) throw httpError(400, MSG.meter); }
      const readAt = newReadAt || reading.read_at;
      if (newReadAt) {
        if (await inSettledRange(tx, reading.user_id, newReadAt)) throw coded(409, 'SETTLED_RANGE', MSG.settled);
        if (!isBoss(req.user.role) && newReadAt.slice(0, 10) < minBackDate()) throw httpError(403, MSG.backDays);
      }
      if (meter !== null && !(await meterOrderOk(tx, reading.user_id, meter, readAt, id))) throw coded(409, 'METER_DOWN', MSG.meterDown);

      await tx.prepare(`
        UPDATE rider_km_readings SET kind = ?, meter = ?, typed_km = ?, read_at = CAST(? AS timestamp) WHERE id = ?
      `).run(kind, meter, typedKm, readAt, id);
      const inputs = await loadChainInputs(tx, reading.user_id);
      const big = bigWork(inputs, id);
      if (big && !b.confirm_big) throw coded(409, 'CONFIRM_BIG', `Is ${meter} right? That is ${big.km} km of work.`);
      await audit(tx, id, req.user.id, 'km_reading_change',
        { kind: reading.kind, meter: reading.meter == null ? null : Number(reading.meter), typed_km: reading.typed_km == null ? null : Number(reading.typed_km), read_at: reading.read_at },
        { kind, meter, typed_km: typedKm, read_at: readAt });
      return { reading: outReading(await readingRow(tx, id)), today_work_km: todayWorkKm(inputs) };
    });
    res.json({ success: true, data: out });
  } catch (err) { sendError(res, next, err); }
});

// ─── DELETE /api/rider-km/readings/:id ───────────────────────
router.delete('/readings/:id', authenticate, forGivers, async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ success: false, message: MSG.notFound });
    await withMoneyTx(async (tx) => {
      const first = await readingRow(tx, id);
      if (!first) throw httpError(404, MSG.notFound);
      await lockRider(tx, first.user_id);
      const reading = await readingRow(tx, id);
      await guardChange(tx, req, reading);
      await tx.prepare('UPDATE rider_km_readings SET removed_at = CURRENT_TIMESTAMP, removed_by = ? WHERE id = ?').run(req.user.id, id);
      await audit(tx, id, req.user.id, 'km_reading_remove',
        { kind: reading.kind, meter: reading.meter == null ? null : Number(reading.meter), typed_km: reading.typed_km == null ? null : Number(reading.typed_km), read_at: reading.read_at }, null);
    });
    res.json({ success: true });
  } catch (err) { sendError(res, next, err); }
});

// ─── POST /api/rider-km/gaps ─────────────────────────────────
router.post('/gaps', authenticate, forGivers, async (req, res, next) => {
  try {
    const b = req.body || {};
    const riderId = parseId(b.user_id);
    const fromId = parseId(b.from_reading_id);
    const toId = parseId(b.to_reading_id);
    if (!riderId || !fromId || !toId) return res.status(400).json({ success: false, message: MSG.gap });
    if (!['typed', 'none'].includes(b.answer)) return res.status(400).json({ success: false, message: MSG.answer });
    const db = await getDb();
    if (!(await riderRow(db, riderId))) return res.status(400).json({ success: false, message: MSG.rider });
    if (!(await sharesShop(db, req.user, riderId))) return res.status(403).json({ success: false, message: MSG.notYourShop });

    const out = await withMoneyTx(async (tx) => {
      await lockRider(tx, riderId);
      const inputs = await loadChainInputs(tx, riderId);
      const cutoff = cutoffOf(inputs);
      const gap = chainOf(inputs).stretches.find((s) => s.kind === 'gap' && s.fromId === fromId && s.toId === toId && isUnsettled(s, cutoff));
      if (!gap) throw httpError(400, MSG.gap);
      let workKm = null;
      if (b.answer === 'typed') {
        workKm = parseKm(b.work_km, { min: 0, max: gap.km });
        if (workKm === null) throw httpError(400, `Type a number from 0 to ${gap.km}.`);
      }
      const before = await tx.prepare('SELECT id, answer, work_km, settlement_id FROM rider_km_gap_answers WHERE from_reading_id = ? AND to_reading_id = ?').get(fromId, toId);
      if (before && before.settlement_id != null) throw coded(409, 'SETTLED', MSG.settled);
      const row = { id: (await tx.prepare(`
        INSERT INTO rider_km_gap_answers (user_id, from_reading_id, to_reading_id, answer, work_km, answered_by)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (from_reading_id, to_reading_id) DO UPDATE
          SET answer = EXCLUDED.answer, work_km = EXCLUDED.work_km, answered_by = EXCLUDED.answered_by
        RETURNING id
      `).run(riderId, fromId, toId, b.answer, workKm, req.user.id)).lastInsertRowid };
      await audit(tx, row.id, req.user.id, 'km_gap_answer',
        before ? { answer: before.answer, work_km: before.work_km == null ? null : Number(before.work_km) } : null,
        { user_id: riderId, from_reading_id: fromId, to_reading_id: toId, answer: b.answer, work_km: workKm });
      return { id: Number(row.id), answer: b.answer, work_km: workKm };
    });
    res.json({ success: true, data: out });
  } catch (err) { sendError(res, next, err); }
});

// ─── POST /api/rider-km/corrections (owner or manager) ───────
router.post('/corrections', authenticate, async (req, res, next) => {
  try {
    if (!isBoss(req.user.role)) return res.status(403).json({ success: false, message: MSG.forbidden });
    const b = req.body || {};
    const riderId = parseId(b.user_id);
    if (!riderId) return res.status(400).json({ success: false, message: MSG.rider });
    const km = parseKm(b.km, { min: -2000, max: 2000, allowZero: false });
    if (km === null) return res.status(400).json({ success: false, message: MSG.correctionKm });
    const note = String(b.note || '').trim().slice(0, 300);
    if (!note) return res.status(400).json({ success: false, message: MSG.correctionNote });
    let forDate = todayStr();
    if (b.for_date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.for_date))) return res.status(400).json({ success: false, message: MSG.badTime });
      forDate = String(b.for_date);
      if (forDate > todayStr()) return res.status(400).json({ success: false, message: MSG.future });
    }
    const db = await getDb();
    if (!(await riderRow(db, riderId))) return res.status(400).json({ success: false, message: MSG.rider });
    if (!(await sharesShop(db, req.user, riderId))) return res.status(403).json({ success: false, message: MSG.notYourShop });
    const out = await withMoneyTx(async (tx) => {
      await lockRider(tx, riderId);
      const row = { id: (await tx.prepare(`
        INSERT INTO rider_km_corrections (user_id, km, note, for_date, created_by)
        VALUES (?, ?, ?, CAST(? AS date), ?)
      `).run(riderId, km, note, forDate, req.user.id)).lastInsertRowid };
      await audit(tx, row.id, req.user.id, 'km_correction', null, { user_id: riderId, km, note, for_date: forDate });
      return { id: Number(row.id), km, note, for_date: forDate };
    });
    res.status(201).json({ success: true, data: out });
  } catch (err) { sendError(res, next, err); }
});

// ─── Km rate ─────────────────────────────────────────────────
router.get('/rate', authenticate, forGivers, async (req, res, next) => {
  try {
    const db = await getDb();
    const rows = await db.prepare('SELECT id, rate, effective_from FROM rider_km_rates ORDER BY effective_from DESC, id DESC').all();
    const today = todayStr();
    const current = rows.find((r) => String(r.effective_from).slice(0, 10) <= today) || rows[rows.length - 1] || null;
    res.json({
      success: true,
      data: {
        rate: current ? Number(current.rate) : 0,
        effective_from: current ? String(current.effective_from).slice(0, 10) : null,
        history: rows.map((r) => ({ id: Number(r.id), rate: Number(r.rate), effective_from: String(r.effective_from).slice(0, 10) })),
      },
    });
  } catch (err) { next(err); }
});

router.put('/rate', authenticate, async (req, res, next) => {
  try {
    if (req.user.role !== 'owner') return res.status(403).json({ success: false, message: MSG.forbidden });
    const b = req.body || {};
    const s = String(b.rate === undefined || b.rate === null ? '' : b.rate).trim();
    if (!/^\d{1,4}(\.\d{1,2})?$/.test(s) || toPaise(s) <= 0) return res.status(400).json({ success: false, message: MSG.rate });
    const rate = toPaise(s) / 100;
    let eff = todayStr();
    if (b.effective_from) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.effective_from))) return res.status(400).json({ success: false, message: MSG.badTime });
      eff = String(b.effective_from);
    }
    const out = await withMoneyTx(async (tx) => {
      // Two rates on one date would tie; the newest wins by replacing.
      const same = await tx.prepare('SELECT id, rate FROM rider_km_rates WHERE effective_from = CAST(? AS date) ORDER BY id DESC').get(eff);
      let id;
      if (same) {
        await tx.prepare('UPDATE rider_km_rates SET rate = ?, set_by = ? WHERE id = ?').run(rate, req.user.id, same.id);
        id = Number(same.id);
      } else {
        id = Number((await tx.prepare('INSERT INTO rider_km_rates (rate, effective_from, set_by) VALUES (?, CAST(? AS date), ?)').run(rate, eff, req.user.id)).lastInsertRowid);
      }
      await audit(tx, id, req.user.id, 'km_rate_set', same ? { rate: Number(same.rate), effective_from: eff } : null, { rate, effective_from: eff });
      return { id, rate, effective_from: eff };
    });
    res.json({ success: true, data: out });
  } catch (err) { sendError(res, next, err); }
});

// ─── GET /api/rider-km/mine (the rider) ──────────────────────
router.get('/mine', authenticate, async (req, res, next) => {
  try {
    if (req.user.role !== 'delivery_partner') return res.status(403).json({ success: false, message: MSG.riderOnly });
    const db = await getDb();
    const data = await accountFor(db, req.user.id);
    if (!data) return res.status(404).json({ success: false, message: MSG.rider });
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// ─── PUT /api/rider-km/:userId/usual-home ────────────────────
router.put('/:userId/usual-home', authenticate, async (req, res, next) => {
  try {
    if (!isBoss(req.user.role)) return res.status(403).json({ success: false, message: MSG.forbidden });
    const riderId = parseId(req.params.userId);
    if (!riderId) return res.status(404).json({ success: false, message: MSG.rider });
    const b = req.body || {};
    let km = null;
    if (b.km !== null && b.km !== undefined && b.km !== '') {
      km = parseKm(b.km, { min: 0, max: 200, allowZero: false });
      if (km === null) return res.status(400).json({ success: false, message: MSG.usual });
    }
    const db = await getDb();
    const rider = await riderRow(db, riderId);
    if (!rider) return res.status(404).json({ success: false, message: MSG.rider });
    if (!(await sharesShop(db, req.user, riderId))) return res.status(403).json({ success: false, message: MSG.notYourShop });
    await withMoneyTx(async (tx) => {
      await tx.prepare('UPDATE users SET km_usual_home_ride = ? WHERE id = ?').run(km, riderId);
      await audit(tx, riderId, req.user.id, 'km_usual_home_set',
        { km: rider.km_usual_home_ride == null ? null : Number(rider.km_usual_home_ride) }, { km });
    });
    res.json({ success: true, data: { km } });
  } catch (err) { sendError(res, next, err); }
});

// ─── POST /api/rider-km/:userId/settle ───────────────────────
// { location_id, preview: true, upi_own_delivery_ids? } shows the settle sheet.
// { location_id, expected_net_paise, last_settlement_id?, action, amount?,
//   method?, upi_own_delivery_ids? } settles. amount is in rupees.
const SETTLE_ACTIONS = ['pay', 'take', 'carry', 'zero', 'salary'];
router.post('/:userId/settle', authenticate, forGivers, async (req, res, next) => {
  try {
    const riderId = parseId(req.params.userId);
    if (!riderId) return res.status(404).json({ success: false, message: MSG.rider });
    const b = req.body || {};
    const locationId = parseId(b.location_id);
    if (!locationId) return res.status(400).json({ success: false, message: MSG.location });
    let upiOwn = [];
    if (b.upi_own_delivery_ids !== undefined && b.upi_own_delivery_ids !== null) {
      if (!Array.isArray(b.upi_own_delivery_ids) || b.upi_own_delivery_ids.length > 200
          || b.upi_own_delivery_ids.some((x) => !parseId(x))) {
        return res.status(400).json({ success: false, message: 'Pick the orders again.' });
      }
      upiOwn = [...new Set(b.upi_own_delivery_ids.map(Number))];
    }
    const db = await getDb();
    if (!(await isRider(db, riderId, locationId))) return res.status(400).json({ success: false, message: MSG.rider });
    if (req.user.role !== 'owner' && !(await isLinked(db, req.user.id, locationId))) {
      return res.status(403).json({ success: false, message: MSG.notYourShop });
    }

    if (b.preview === true || b.preview === 'true') {
      const s = await computeSettlement(db, riderId, { upiOwnIds: upiOwn });
      if (s.gapsOpen) throw coded(409, 'GAPS_OPEN', SETTLE_MSG.gaps);
      if (!s.anything) throw coded(409, 'NOTHING', SETTLE_MSG.nothing);
      return res.json({
        success: true,
        data: {
          lines: s.lines, net_paise: s.netPaise, cutoff_reading_id: s.cutoff ? Number(s.cutoff.id) : null,
          last_settlement_id: s.lastSettlementId,
        },
      });
    }

    if (!SETTLE_ACTIONS.includes(b.action)) return res.status(400).json({ success: false, message: 'Pick Pay, Take, Carry or Settle.' });
    if (b.action === 'salary' && req.user.role !== 'owner') return res.status(403).json({ success: false, message: MSG.forbidden });
    const expected = Number(b.expected_net_paise);
    if (b.expected_net_paise === null || b.expected_net_paise === '' || !Number.isInteger(expected)) {
      throw coded(409, 'CHANGED', SETTLE_MSG.changed);
    }
    let amount = null;
    if (b.action === 'pay' || b.action === 'take') {
      const a = String(b.amount === undefined || b.amount === null ? '' : b.amount).trim();
      if (!/^\d{1,7}(\.\d{1,2})?$/.test(a)) return res.status(400).json({ success: false, message: 'Type the amount, like 200.' });
      amount = Number(a);
    }
    const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
    let lastId;
    if (has('last_settlement_id')) {
      lastId = b.last_settlement_id === null ? null : parseId(b.last_settlement_id);
      if (b.last_settlement_id !== null && !lastId) throw coded(409, 'CHANGED', SETTLE_MSG.changed);
    }
    const out = await withMoneyTx((tx) => commitSettlement(tx, {
      userId: riderId, locationId, actor: { id: req.user.id, role: req.user.role }, action: b.action, amount,
      method: b.method || null, upiOwnIds: upiOwn, expectedNetPaise: expected, expectedLastSettlementId: lastId,
    }));
    res.status(201).json({ success: true, data: out });
  } catch (err) {
    // A lock wait that Postgres broke (deadlock) means another save moved the
    // same money: ask for a fresh look rather than a server error.
    if (err && (err.code === '40P01' || err.code === '40001')) return sendError(res, next, coded(409, 'CHANGED', SETTLE_MSG.changed));
    sendError(res, next, err);
  }
});

// ─── GET /api/rider-km/:userId ───────────────────────────────
router.get('/:userId', authenticate, async (req, res, next) => {
  try {
    const riderId = parseId(req.params.userId);
    if (!riderId) return res.status(404).json({ success: false, message: MSG.rider });
    const self = req.user.role === 'delivery_partner' && Number(req.user.id) === riderId;
    if (!self && !GIVER_ROLES.includes(req.user.role)) return res.status(403).json({ success: false, message: MSG.forbidden });
    const db = await getDb();
    if (!self && !(await sharesShop(db, req.user, riderId))) return res.status(403).json({ success: false, message: MSG.notYourShop });
    const data = await accountFor(db, riderId);
    if (!data) return res.status(404).json({ success: false, message: MSG.rider });
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

module.exports = router;
