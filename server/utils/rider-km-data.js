// Rider km account: database loading for the pure chain maths in rider-km.js.
// Readings are always loaded fresh and chained; no totals are stored.
// read_at is a shop-local wall-clock timestamp, read back as a local string
// ('YYYY-MM-DD HH:MM:SS') so date slicing never shifts by a time zone.
const { usualHome, buildChain } = require('./rider-km');
const { getTimezone } = require('./time');

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

module.exports = { accountStart, loadReadings, loadChainInputs, isRider, fmtLocal };
