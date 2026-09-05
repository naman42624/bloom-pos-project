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

module.exports = { hasOpenRegister, REGISTER_CLOSED_MESSAGE };
