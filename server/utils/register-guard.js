// Shared "is a cash register open at this location" check, used at every
// site that writes real cash to cash_registers.expected_cash. The register
// query itself (SELECT ... WHERE location_id = ? AND closed_at IS NULL)
// was already duplicated verbatim across sales.js and deliveries.js before
// this — this just gives the enforcement one place to live.
//
// Enforcement is hard and unconditional: card/UPI-only writes never call
// this at all (see each call site), and a cash write with no open register
// is rejected outright, not silently skipped. See CLAUDE.md sub-project 3.
//
// Takes the caller's own `db` (this project's sync getDb() layer at every
// current call site) so it composes with whichever DB access the route
// already uses — plain `db.prepare(...).get(...)`, no async needed here.
function hasOpenRegister(db, locationId) {
  const register = db
    .prepare('SELECT id FROM cash_registers WHERE location_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1')
    .get(locationId);
  return !!register;
}

const REGISTER_CLOSED_MESSAGE = "Register isn't open — open it before taking a cash payment.";

// Inside a money transaction (withMoneyTx): lock the shop's open register row
// until the transaction ends, so a close and a cash write can never overlap.
// Lock order everywhere: sale row(s), then a helper bag, then the register.
// Returns the register row, or null when none is open.
async function lockOpenRegister(tx, locationId) {
  const row = await tx.prepare(
    'SELECT * FROM cash_registers WHERE location_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1 FOR UPDATE'
  ).get(locationId);
  return row || null;
}

// Cash in (+) or out (-) of an open register session: the running expected
// cash moves, and so does a locked blind count (close_count_locked), the same
// way helper floats and handovers move it. Inside a money transaction, after
// the register row is locked. A closed session is never touched.
async function moveSessionCash(tx, registerId, delta) {
  await tx.prepare('UPDATE cash_registers SET expected_cash = expected_cash + ? WHERE id = ? AND closed_at IS NULL').run(delta, registerId);
  await tx.prepare('UPDATE cash_registers SET close_count_locked = close_count_locked + ? WHERE id = ? AND closed_at IS NULL AND close_count_locked IS NOT NULL')
    .run(delta, registerId);
}

function registerClosedError() {
  const e = new Error(REGISTER_CLOSED_MESSAGE);
  e.statusCode = 400;
  return e;
}

module.exports = { hasOpenRegister, lockOpenRegister, moveSessionCash, registerClosedError, REGISTER_CLOSED_MESSAGE };
