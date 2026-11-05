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

  // Reserve this try BEFORE comparing, in one conditional UPDATE: the row
  // lock makes parallel requests queue, and each re-checks the count, so no
  // more than PIN_MAX_ATTEMPTS compares can ever run per lockout window. The
  // try that reaches the limit sets the lock. A count left over from a lock
  // that has since ended starts again from 0.
  const now = new Date();
  const lockUntil = new Date(now.getTime() + PIN_LOCKOUT_MINUTES * 60000);
  const effective = `(CASE
      WHEN pin_locked_until IS NOT NULL AND pin_locked_until <= CAST(? AS timestamp) THEN 0
      WHEN pin_locked_until IS NULL AND COALESCE(pin_failed_attempts, 0) >= ? THEN 0
      ELSE COALESCE(pin_failed_attempts, 0) END)`;
  const reserved = await db.prepare(
    `UPDATE users
        SET pin_failed_attempts = ${effective} + 1,
            pin_locked_until = CASE WHEN ${effective} + 1 >= ? THEN CAST(? AS timestamp) ELSE NULL END
      WHERE id = ?
        AND (pin_locked_until IS NULL OR pin_locked_until <= CAST(? AS timestamp))
        AND ${effective} < ?
      RETURNING pin_failed_attempts`
  ).get(
    now, PIN_MAX_ATTEMPTS,
    now, PIN_MAX_ATTEMPTS, PIN_MAX_ATTEMPTS, lockUntil,
    user.id,
    now,
    now, PIN_MAX_ATTEMPTS, PIN_MAX_ATTEMPTS
  );
  if (!reserved) throw pinError(423, LOCKED_MESSAGE);
  const attempts = Number(reserved.pin_failed_attempts);

  const isValidPin = await verifyPin(String(pin || ''), user.pin_hash);

  if (!isValidPin) {
    if (attempts >= PIN_MAX_ATTEMPTS) throw pinError(423, LOCKED_MESSAGE);
    throw pinError(401, wrongPinMessage(PIN_MAX_ATTEMPTS - attempts));
  }

  // A right PIN clears the count and any lock only when no other try was
  // reserved after this one. If later tries came in meanwhile, their outcome
  // (including a lock) stands; this request still succeeds, since it was
  // within the budget.
  await db.prepare(
    'UPDATE users SET pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = ? AND pin_failed_attempts = ?'
  ).run(user.id, attempts);

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
