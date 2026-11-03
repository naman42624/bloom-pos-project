// Employee code + PIN check shared by counter staff-login and helper discount
// overrides. One set of attempt counters and one lockout per person: a wrong
// PIN on an override counts toward the same lockout as a wrong PIN at login.
const { verifyPin, PIN_MAX_ATTEMPTS, PIN_LOCKOUT_MINUTES } = require('./pin');

const APPROVER_ROLES = ['counter_staff', 'employee', 'manager', 'owner'];

const UNKNOWN_CODE_MESSAGE = 'Employee code not recognized.';
const DEACTIVATED_MESSAGE = 'Your account has been deactivated. Contact your manager.';
const LOCKED_MESSAGE = `Too many wrong tries — ask your manager to unlock this in ${PIN_LOCKOUT_MINUTES} minutes.`;
const overrideWrongPinMessage = (left) => `That PIN didn't match. ${left} tries left.`;

function pinError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.pinCheck = true;
  return err;
}

// Checks a code + PIN for one of `roles`. Resolves with the full user row, or
// throws an Error carrying { status, message, pinCheck: true }:
//   401 unknown code (also a code whose role is not in `roles`)
//   403 deactivated (or 401 unknown when inactiveAsUnknown is set)
//   423 locked, or this wrong try reached the limit
//   401 wrongPinMessage(triesLeft)
async function checkCodeAndPin(db, employeeCode, pin, { roles, wrongPinMessage, inactiveAsUnknown = false }) {
  const code = String(employeeCode || '').trim();
  if (!code) throw pinError(401, UNKNOWN_CODE_MESSAGE);

  const placeholders = roles.map(() => '?').join(', ');
  const user = await db.prepare(
    `SELECT * FROM users WHERE employee_code = ? AND role IN (${placeholders})`
  ).get(code, ...roles);

  if (!user) throw pinError(401, UNKNOWN_CODE_MESSAGE);

  if (!user.is_active) {
    throw inactiveAsUnknown ? pinError(401, UNKNOWN_CODE_MESSAGE) : pinError(403, DEACTIVATED_MESSAGE);
  }

  if (user.pin_locked_until && new Date(user.pin_locked_until) > new Date()) {
    throw pinError(423, LOCKED_MESSAGE);
  }

  const isValidPin = await verifyPin(String(pin || ''), user.pin_hash);

  if (!isValidPin) {
    // Counted in one statement so parallel wrong tries cannot overwrite each
    // other and slip past the limit.
    const lockUntil = new Date(Date.now() + PIN_LOCKOUT_MINUTES * 60000);
    const row = await db.prepare(
      `UPDATE users
          SET pin_failed_attempts = COALESCE(pin_failed_attempts, 0) + 1,
              pin_locked_until = CASE WHEN COALESCE(pin_failed_attempts, 0) + 1 >= ? THEN CAST(? AS timestamp) ELSE NULL END
        WHERE id = ?
        RETURNING pin_failed_attempts`
    ).get(PIN_MAX_ATTEMPTS, lockUntil, user.id);
    const attempts = Number(row && row.pin_failed_attempts) || PIN_MAX_ATTEMPTS;
    if (attempts >= PIN_MAX_ATTEMPTS) throw pinError(423, LOCKED_MESSAGE);
    throw pinError(401, wrongPinMessage(PIN_MAX_ATTEMPTS - attempts));
  }

  await db.prepare(
    'UPDATE users SET pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = ?'
  ).run(user.id);

  return user;
}

// Discount approval on a helper sale: code + PIN of counter staff, a manager
// or the owner. Never issues a session.
async function verifyApprovalPin(db, employeeCode, pin) {
  return checkCodeAndPin(db, employeeCode, pin, {
    roles: APPROVER_ROLES,
    wrongPinMessage: overrideWrongPinMessage,
    inactiveAsUnknown: true,
  });
}

function pct(settings, key, fallback) {
  const raw = settings ? settings[key] : undefined;
  const n = parseFloat(raw === undefined || raw === null || raw === '' ? fallback : raw);
  return Number.isFinite(n) ? n : parseFloat(fallback);
}

// Largest discount % this approver may OK. `settings` is a key -> value map
// (strings as stored in the settings table). Same thresholds and defaults as
// POST /api/sales.
function approverMaxDiscountPct(role, settings) {
  if (role === 'owner') return Infinity;
  if (role === 'manager') return pct(settings, 'discount_owner_threshold', '30');
  if (role === 'counter_staff' || role === 'employee') return pct(settings, 'discount_manager_threshold', '20');
  return 0;
}

module.exports = {
  checkCodeAndPin,
  verifyApprovalPin,
  approverMaxDiscountPct,
  APPROVER_ROLES,
  UNKNOWN_CODE_MESSAGE,
  DEACTIVATED_MESSAGE,
  LOCKED_MESSAGE,
};
