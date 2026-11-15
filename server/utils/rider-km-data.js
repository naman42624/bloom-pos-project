// Rider km account: database loading for the pure chain maths in rider-km.js.
// Readings are always loaded fresh and chained; no totals are stored.
// read_at is a shop-local wall-clock timestamp, read back as a local string
// ('YYYY-MM-DD HH:MM:SS') so date slicing never shifts by a time zone.
const { usualHome, buildChain, priceStretches, netPaise, paidKmOf, localDate } = require('./rider-km');
const { getTimezone, todayStr } = require('./time');
const { lockOpenRegister, moveSessionCash } = require('./register-guard');
const { remainingPaise } = require('./staff-money');
const { resolveItem, composeDescription } = require('./expense-items');

const READ_AT_TEXT = "to_char(read_at, 'YYYY-MM-DD HH24:MI:SS')";

// A Date (an instant) as a shop-local 'YYYY-MM-DD HH:MM:SS'.
function fmtLocal(date) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: getTimezone(), hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date)) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

async function accountStart(db, userId) {
  const row = await db.prepare(`
    SELECT to_char(date_trunc('day', MIN(read_at)), 'YYYY-MM-DD"T"HH24:MI:SS') AS s
    FROM rider_km_readings WHERE user_id = ? AND removed_at IS NULL
  `).get(userId);
  return row && row.s ? row.s : null;
}

async function loadReadings(db, userId) {
  return db.prepare(`
    SELECT id, user_id, location_id, kind, meter, typed_km, ${READ_AT_TEXT} AS read_at, note,
           created_by, settlement_id
    FROM rider_km_readings WHERE user_id = ? AND removed_at IS NULL
    ORDER BY rider_km_readings.read_at ASC, id ASC
  `).all(userId);
}

async function loadChainInputs(db, userId) {
  const readings = await loadReadings(db, userId);
  const answers = await db.prepare(
    'SELECT id, from_reading_id, to_reading_id, answer, work_km, settlement_id FROM rider_km_gap_answers WHERE user_id = ?'
  ).all(userId);
  const corrections = await db.prepare(
    `SELECT id, km, note, for_date, created_by, created_at, settlement_id FROM rider_km_corrections
     WHERE user_id = ? ORDER BY id ASC`
  ).all(userId);
  const rates = await db.prepare('SELECT id, rate, effective_from FROM rider_km_rates ORDER BY effective_from ASC, id ASC').all();
  const u = await db.prepare('SELECT km_usual_home_ride FROM users WHERE id = ?').get(userId);
  const lastSettlement = await db.prepare(`
    SELECT s.id, s.cutoff_reading_id, s.paid_km, s.km_amount, s.net_amount, s.action, s.moved_amount,
           s.moved_method, s.carry_out, s.created_at,
           (SELECT to_char(r.read_at, 'YYYY-MM-DD HH24:MI:SS') FROM rider_km_readings r WHERE r.id = s.cutoff_reading_id) AS cutoff_read_at
    FROM rider_km_settlements s WHERE s.user_id = ? ORDER BY s.id DESC LIMIT 1
  `).get(userId);
  const override = u && u.km_usual_home_ride != null ? Number(u.km_usual_home_ride) : null;
  const usualHomeKm = override != null ? override : usualHome(buildChain(readings, answers, {}).stretches);
  return { readings, answers, corrections, rates, usualHomeKm, usualOverrideKm: override, lastSettlement: lastSettlement || null };
}

async function isRider(db, userId, locationId) {
  const r = await db.prepare(`
    SELECT 1 AS ok FROM users u
    WHERE u.id = ? AND u.role = 'delivery_partner' AND u.is_active = 1
      AND EXISTS (SELECT 1 FROM user_locations ul WHERE ul.user_id = u.id AND ul.location_id = ?)
  `).get(userId, locationId);
  return !!r;
}

// ─── Settling (spec section 9) ───────────────────────────────
// Money is summed in whole paise. Readings carry a shop-local wall clock;
// expenses.created_at and deliveries.delivered_time are UTC wall clocks
// (the async pool runs in UTC), so a shop-local bound is turned into UTC
// in SQL before it is compared: (local AT TIME ZONE shop) AT TIME ZONE UTC.
const RIDER_LOCK_NS = 7304;
const toPaise = (n) => Math.round((Number(n) || 0) * 100);
const rupees = (paise) => Math.round(paise) / 100;
const LOCAL_AS_UTC = "((CAST(? AS timestamp) AT TIME ZONE ?) AT TIME ZONE 'UTC')";

const SETTLE_MSG = {
  gaps: 'Answer the gaps first, then settle.',
  nothing: 'Nothing to settle yet.',
  changed: 'Something changed — check the figures again.',
  payClosed: 'Open the register to pay cash — or pick UPI.',
  takeClosed: 'Open the register to take cash — or pick UPI.',
  action: 'That choice does not match these figures. Check the figures again.',
  amount: (max) => `Type an amount from ₹0.01 to ₹${rupees(max).toLocaleString('en-IN')}.`,
  method: 'Pick Cash or UPI.',
};

function coded(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.statusCode = status;
  e.code_name = code;
  return e;
}

async function lockRider(tx, riderId) {
  await tx.prepare('SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock(?, ?)) x').get(RIDER_LOCK_NS, riderId);
}

// What the rider holds or took that a settlement up to cutoffAt (a shop-local
// reading time, or null) can net against the km money. forUpdate (inside a
// money transaction, after the rider lock) first locks the rows in the global
// order: deliveries, then shopping money lines, then petrol expenses; the
// register comes after, in the caller. The rows are read again after the
// locks, so a COD settled a moment ago by settle-now drops out here.
async function collectOpenItems(db, userId, cutoffAt, { forUpdate = false } = {}) {
  const empty = {
    petrolRows: [], petrolBookPaise: 0, petrolTakenPaise: 0, codRows: [], shoppingRows: [], supplyHeldPaise: 0, carriedInPaise: 0,
  };
  const last = await db.prepare('SELECT carry_out FROM rider_km_settlements WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(userId);
  empty.carriedInPaise = last ? toPaise(last.carry_out) : 0;
  const start = await accountStart(db, userId);
  if (!start) return empty;
  const tz = getTimezone();

  const codWhere = `d.delivery_partner_id = ? AND d.status = 'delivered' AND d.cod_collected > 0
    AND d.cod_status IN ('collected', 'partial') AND d.km_settlement_id IS NULL
    AND d.id NOT IN (SELECT delivery_id FROM delivery_settlement_items)
    AND d.delivered_time >= ${LOCAL_AS_UTC}`;
  const codArgs = [userId, start, tz];
  const petrolWhere = `e.km_settlement_id IS NULL
    AND ((e.given_to_user_id = ? AND e.payment_method IN ('cash', 'upi'))
      OR (e.payment_method = 'shopping_money' AND mo.user_id = ?))
    AND e.created_at >= ${LOCAL_AS_UTC} AND e.created_at <= ${LOCAL_AS_UTC}`;
  const petrolArgs = [userId, userId, start, tz, cutoffAt, tz];
  const petrolFrom = `FROM expenses e
    JOIN expense_items i ON i.id = e.item_id AND i.is_rider_petrol = TRUE
    LEFT JOIN staff_money_out mo ON mo.id = e.money_out_id`;

  // Only rows held by these locks are read back: a row that turns up after
  // them waits for the next settlement.
  let held = null;
  if (forUpdate) {
    const ids = (rows) => new Set(rows.map((x) => Number(x.id)));
    held = {
      cod: ids(await db.prepare(`SELECT d.id FROM deliveries d WHERE ${codWhere} ORDER BY d.id FOR UPDATE OF d`).all(...codArgs)),
      shopping: ids(await db.prepare("SELECT id FROM staff_money_out WHERE user_id = ? AND status = 'open' ORDER BY id FOR UPDATE").all(userId)),
      petrol: cutoffAt ? ids(await db.prepare(`SELECT e.id ${petrolFrom} WHERE ${petrolWhere} ORDER BY e.id FOR UPDATE OF e`).all(...petrolArgs)) : new Set(),
    };
  }
  const isHeld = (kind, id) => !held || held[kind].has(Number(id));

  const petrolRows = cutoffAt ? (await db.prepare(`
    SELECT e.id, e.amount, e.is_return, e.payment_method, e.description, e.money_out_id,
      to_char((e.created_at AT TIME ZONE 'UTC') AT TIME ZONE ?, 'YYYY-MM-DD HH24:MI:SS') AS saved_at
    ${petrolFrom} WHERE ${petrolWhere} ORDER BY e.created_at ASC, e.id ASC
  `).all(tz, ...petrolArgs)).filter((e) => isHeld('petrol', e.id)).map((e) => ({
    id: Number(e.id),
    amount_paise: e.is_return ? -toPaise(e.amount) : toPaise(e.amount),
    method: e.payment_method,
    description: e.description || null,
    money_out_id: e.money_out_id == null ? null : Number(e.money_out_id),
    saved_at: e.saved_at,
  })) : [];
  const petrolBookPaise = petrolRows.reduce((t, e) => t + e.amount_paise, 0);

  const codRows = (await db.prepare(`
    SELECT d.id, d.cod_collected, s.sale_number,
      COALESCE((SELECT SUM(dc.amount) FROM delivery_collections dc WHERE dc.delivery_id = d.id AND dc.method = 'upi'), 0) AS upi
    FROM deliveries d LEFT JOIN sales s ON s.id = d.sale_id
    WHERE ${codWhere} ORDER BY d.id
  `).all(...codArgs)).filter((d) => isHeld('cod', d.id)).map((d) => {
    const total = toPaise(d.cod_collected);
    const upi = Math.min(total, toPaise(d.upi));
    // Same rule as sumCollectionsByMethod: anything not UPI is cash.
    return { delivery_id: Number(d.id), sale_number: d.sale_number || null, cash_paise: total - upi, upi_paise: upi };
  });

  const shoppingRows = (await db.prepare(`
    SELECT id, location_id, amount, settled_amount, returned_amount, note,
      to_char((created_at AT TIME ZONE 'UTC') AT TIME ZONE ?, 'YYYY-MM-DD HH24:MI:SS') AS given_at
    FROM staff_money_out WHERE user_id = ? AND status = 'open' ORDER BY id
  `).all(tz, userId)).filter((m) => isHeld('shopping', m.id)).map((m) => ({
    id: Number(m.id), amount_paise: toPaise(m.amount), remaining_paise: remainingPaise(m), note: m.note || null, given_at: m.given_at,
  })).filter((m) => m.remaining_paise > 0);
  const supplyHeldPaise = shoppingRows.reduce((t, m) => t + m.remaining_paise, 0);

  return {
    petrolRows, petrolBookPaise, petrolTakenPaise: petrolBookPaise, codRows, shoppingRows, supplyHeldPaise,
    carriedInPaise: empty.carriedInPaise,
  };
}

// The whole settle sheet for one rider, computed fresh from rows.
// upiOwnIds: UPI COD orders the counter says went to the rider's own UPI.
async function computeSettlement(db, userId, { forUpdate = false, upiOwnIds = [] } = {}) {
  const inputs = await loadChainInputs(db, userId);
  const lastCut = (inputs.lastSettlement && inputs.lastSettlement.cutoff_read_at) || null;
  const readings = inputs.readings;
  const isOpen = (r) => r.settlement_id == null && (!lastCut || String(r.read_at) > lastCut);
  let cutIdx = -1;
  readings.forEach((r, i) => { if (isOpen(r) && (r.kind === 'leave' || r.kind === 'typed')) cutIdx = i; });
  const cutoff = cutIdx >= 0 ? readings[cutIdx] : null;
  const idx = new Map(readings.map((r, i) => [Number(r.id), i]));
  const coveredReadings = cutoff ? readings.filter((r, i) => i <= cutIdx && isOpen(r)) : [];
  const coveredIds = new Set(coveredReadings.map((r) => Number(r.id)));

  const chain = buildChain(readings, inputs.answers, { usualHomeKm: inputs.usualOverrideKm });
  const stretches = cutoff
    ? chain.stretches.filter((s) => (!lastCut || String(s.endAt) > lastCut) && idx.get(Number(s.toId)) <= cutIdx)
    : [];
  const gapsOpen = stretches.filter((s) => s.kind === 'gap' && !s.answer).length;
  const answerIds = inputs.answers
    .filter((a) => a.settlement_id == null && coveredIds.has(Number(a.to_reading_id)))
    .map((a) => Number(a.id));
  const corrections = inputs.corrections.filter((c) => c.settlement_id == null);
  const priced = priceStretches(stretches, inputs.rates, corrections);

  const items = await collectOpenItems(db, userId, cutoff ? cutoff.read_at : null, { forUpdate });
  const chosen = new Set((upiOwnIds || []).map(Number));
  const upiOwnUnknown = [...chosen].some((id) => !items.codRows.some((d) => d.delivery_id === id && d.upi_paise > 0));
  const cod = items.codRows.map((d) => ({ ...d, own_upi: chosen.has(d.delivery_id) && d.upi_paise > 0 }));
  const codCovered = cod.filter((d) => d.cash_paise > 0 || d.own_upi);
  const codHeldPaise = cod.reduce((t, d) => t + d.cash_paise + (d.own_upi ? d.upi_paise : 0), 0);

  const net = netPaise({
    kmPaise: priced.amountPaise,
    petrolTakenPaise: items.petrolTakenPaise,
    carriedInPaise: items.carriedInPaise,
    supplyHeldPaise: items.supplyHeldPaise,
    codHeldPaise,
  });

  const days = new Map();
  for (const st of stretches) {
    const date = localDate(st.endAt);
    const d = days.get(date) || { date, paid_km: 0, stretches: [] };
    const paid = paidKmOf(st);
    d.paid_km = Math.round((d.paid_km + paid) * 10) / 10;
    d.stretches.push({
      kind: st.kind, km: st.km, paid_km: paid, from_reading_id: Number(st.fromId), to_reading_id: Number(st.toId),
      end_at: st.endAt, answer: st.answer, reason: st.reason,
    });
    days.set(date, d);
  }

  const lines = {
    stretches_by_day: [...days.values()],
    by_rate: priced.byRate.map((g) => ({ rate: g.rate, km: g.km, amount_paise: g.amountPaise })),
    corrections: corrections.map((c) => ({ id: Number(c.id), km: Number(c.km), note: c.note, for_date: c.for_date })),
    paid_km: priced.paidKm,
    km_paise: priced.amountPaise,
    petrol: items.petrolRows,
    petrol_taken_paise: items.petrolTakenPaise,
    carried_in_paise: items.carriedInPaise,
    shopping: items.shoppingRows,
    supply_held_paise: items.supplyHeldPaise,
    cod,
    cod_held_paise: codHeldPaise,
  };
  const covers = !!cutoff || corrections.length > 0 || items.petrolRows.length > 0
    || codCovered.length > 0 || items.shoppingRows.length > 0;
  return {
    lines,
    netPaise: net,
    gapsOpen,
    cutoff,
    lastSettlementId: inputs.lastSettlement ? Number(inputs.lastSettlement.id) : null,
    coveredReadingIds: [...coveredIds],
    answerIds,
    corrections,
    priced,
    items,
    codCovered,
    upiOwnChosen: cod.filter((d) => d.own_upi).map((d) => d.delivery_id),
    upiOwnUnknown,
    covers,
    // Something to show on a settle sheet at all (a carried balance alone is).
    anything: covers || cod.length > 0 || items.carriedInPaise !== 0,
  };
}

// The rider petrol item for the settlement row: the first flagged one, else
// the item named Petrol (made if missing).
async function petrolItemFor(tx, actorId) {
  const flagged = await tx.prepare('SELECT * FROM expense_items WHERE is_rider_petrol = TRUE ORDER BY id LIMIT 1').get();
  if (flagged) return flagged;
  return resolveItem(tx, { item_name: 'Petrol', category: 'transport', userId: actorId });
}

async function auditRow(tx, entityType, entityId, userId, action, before, after) {
  await tx.prepare(`
    INSERT INTO audit_logs (entity_type, entity_id, user_id, action, previous_state, new_state, created_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(entityType, entityId, userId, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null);
}

// One settlement, inside a money transaction (withMoneyTx). Takes the rider
// lock first, then the rows, then (cash only) the register. Throws a coded
// 409 when the figures moved since the preview (expectedNetPaise, and
// expectedLastSettlementId when the caller sends it).
// action: pay | take | carry | zero | salary. amount in rupees (pay/take).
async function commitSettlement(tx, {
  userId, locationId, actor, action, amount = null, method = null, upiOwnIds = [], expectedNetPaise,
  salaryPaymentId = null, expectedLastSettlementId,
}) {
  await lockRider(tx, userId);
  const s = await computeSettlement(tx, userId, { forUpdate: true, upiOwnIds });
  if (s.gapsOpen) throw coded(409, 'GAPS_OPEN', SETTLE_MSG.gaps);
  if (expectedLastSettlementId !== undefined
      && (expectedLastSettlementId == null ? null : Number(expectedLastSettlementId)) !== s.lastSettlementId) {
    throw coded(409, 'CHANGED', SETTLE_MSG.changed);
  }
  if (s.upiOwnUnknown || s.netPaise !== Number(expectedNetPaise)) throw coded(409, 'CHANGED', SETTLE_MSG.changed);
  if (!s.anything) throw coded(409, 'NOTHING', SETTLE_MSG.nothing);
  const net = s.netPaise;

  const fits = (action === 'pay' && net > 0) || (action === 'take' && net < 0)
    || (action === 'carry' && net !== 0) || (action === 'zero' && net === 0) || action === 'salary';
  if (!fits) throw coded(400, 'ACTION', SETTLE_MSG.action);
  // Carrying or closing nothing new would only write an empty row.
  if (!s.covers && (action === 'carry' || action === 'zero')) throw coded(409, 'NOTHING', SETTLE_MSG.nothing);

  let movedPaise = 0;
  let registerId = null;
  if (action === 'pay' || action === 'take') {
    const max = Math.abs(net);
    movedPaise = toPaise(amount);
    if (!(movedPaise >= 1 && movedPaise <= max)) throw coded(400, 'AMOUNT', SETTLE_MSG.amount(max));
    if (!['cash', 'upi'].includes(method)) throw coded(400, 'METHOD', SETTLE_MSG.method);
    if (method === 'cash') {
      const reg = await lockOpenRegister(tx, locationId);
      if (!reg) throw coded(409, 'REGISTER_CLOSED', action === 'pay' ? SETTLE_MSG.payClosed : SETTLE_MSG.takeClosed);
      registerId = Number(reg.id);
    }
  }
  const carryOut = action === 'pay' ? net - movedPaise : action === 'take' ? net + movedPaise : net;
  const codHeldPaise = s.lines.cod_held_paise;

  const ins = await tx.prepare(`
    INSERT INTO rider_km_settlements (user_id, location_id, cutoff_reading_id, paid_km, km_amount, petrol_book, petrol_taken,
      carried_in, supply_held, cod_held, net_amount, action, moved_amount, moved_method, register_id, carry_out,
      upi_own_delivery_ids, lines_json, created_by, salary_payment_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS jsonb), ?, ?)
  `).run(
    userId, locationId, s.cutoff ? Number(s.cutoff.id) : null, s.priced.paidKm, rupees(s.priced.amountPaise),
    rupees(s.items.petrolBookPaise), rupees(s.items.petrolTakenPaise), rupees(s.items.carriedInPaise),
    rupees(s.items.supplyHeldPaise), rupees(codHeldPaise), rupees(net), action,
    movedPaise ? rupees(movedPaise) : null, movedPaise ? method : null, registerId, rupees(carryOut),
    JSON.stringify(s.upiOwnChosen), JSON.stringify(s.lines), actor.id, salaryPaymentId,
  );
  const sid = Number(ins.lastInsertRowid);

  const inList = (ids) => ids.map(() => '?').join(', ');
  if (s.coveredReadingIds.length) {
    await tx.prepare(`UPDATE rider_km_readings SET settlement_id = ? WHERE id IN (${inList(s.coveredReadingIds)}) AND settlement_id IS NULL`)
      .run(sid, ...s.coveredReadingIds);
  }
  if (s.answerIds.length) {
    await tx.prepare(`UPDATE rider_km_gap_answers SET settlement_id = ? WHERE id IN (${inList(s.answerIds)}) AND settlement_id IS NULL`)
      .run(sid, ...s.answerIds);
  }
  const corrIds = s.corrections.map((c) => Number(c.id));
  if (corrIds.length) {
    await tx.prepare(`UPDATE rider_km_corrections SET settlement_id = ? WHERE id IN (${inList(corrIds)}) AND settlement_id IS NULL`)
      .run(sid, ...corrIds);
  }
  const petrolIds = s.items.petrolRows.map((e) => e.id);
  if (petrolIds.length) {
    await tx.prepare(`UPDATE expenses SET km_settlement_id = ? WHERE id IN (${inList(petrolIds)}) AND km_settlement_id IS NULL`)
      .run(sid, ...petrolIds);
  }
  // COD netted here is done everywhere: no delivery_settlements row (it would
  // move the drawer at close), and cod_status settled drops it from the
  // Settlements screen.
  for (const d of s.codCovered) {
    await tx.prepare("UPDATE deliveries SET cod_status = 'settled', km_settlement_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(sid, d.delivery_id);
  }
  // The change the rider still holds is handed in through the km account.
  for (const m of s.items.shoppingRows) {
    await tx.prepare(`
      UPDATE staff_money_out SET returned_amount = COALESCE(returned_amount, 0) + ?, status = 'settled',
        closed_at = CURRENT_TIMESTAMP, km_settlement_id = ?
      WHERE id = ?
    `).run(rupees(m.remaining_paise), sid, m.id);
    await tx.prepare(`
      INSERT INTO staff_money_settles (money_out_id, bills_amount, returned_amount, returned_method, register_id, settled_by)
      VALUES (?, 0, ?, 'km', NULL, ?)
    `).run(m.id, rupees(m.remaining_paise), actor.id);
    await auditRow(tx, 'staff_money_out', m.id, actor.id, 'shopping_money_km_settled', { status: 'open' },
      { status: 'settled', km_settlement_id: sid, returned_amount: rupees(m.remaining_paise), returned_method: 'km' });
  }

  // Petrol book: petrol rows + this row = K for the settlement.
  let expenseId = null;
  const diff = s.priced.amountPaise - s.items.petrolBookPaise;
  if (diff !== 0) {
    const item = await petrolItemFor(tx, actor.id);
    const e = await tx.prepare(`
      INSERT INTO expenses (location_id, category, amount, description, payment_method, expense_date, created_by,
        is_return, register_id, item_id, note, given_to_user_id, km_settlement_id)
      VALUES (?, 'transport', ?, ?, 'km_account', ?, ?, ?, NULL, ?, ?, ?, ?)
    `).run(locationId, rupees(Math.abs(diff)), composeDescription(item.name, 'Km settlement'), todayStr(), actor.id,
      diff < 0 ? 1 : 0, Number(item.id), 'Km settlement', userId, sid);
    expenseId = Number(e.lastInsertRowid);
    await tx.prepare('UPDATE rider_km_settlements SET expense_id = ? WHERE id = ?').run(expenseId, sid);
  }

  if (registerId) await moveSessionCash(tx, registerId, action === 'pay' ? -rupees(movedPaise) : rupees(movedPaise));

  const out = {
    settlement_id: sid, action, net_paise: net, moved_paise: movedPaise, moved_method: movedPaise ? method : null,
    register_id: registerId, carry_out_paise: carryOut, expense_id: expenseId,
  };
  await auditRow(tx, 'rider_km', sid, actor.id, 'km_settle', null, {
    ...out, user_id: userId, location_id: locationId, cutoff_reading_id: s.cutoff ? Number(s.cutoff.id) : null,
    readings: s.coveredReadingIds, petrol: petrolIds, cod: s.codCovered.map((d) => d.delivery_id),
    shopping: s.items.shoppingRows.map((m) => m.id), upi_own: s.upiOwnChosen,
  });
  return out;
}

module.exports = {
  accountStart, loadReadings, loadChainInputs, isRider, fmtLocal,
  collectOpenItems, computeSettlement, commitSettlement, lockRider, SETTLE_MSG,
};
