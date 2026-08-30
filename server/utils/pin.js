const bcrypt = require('bcryptjs');

const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCKOUT_MINUTES = 5;

async function hashPin(pin) {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(pin, salt);
}

async function verifyPin(pin, hash) {
  if (!hash) return false;
  return bcrypt.compare(pin, hash);
}

module.exports = { hashPin, verifyPin, PIN_MAX_ATTEMPTS, PIN_LOCKOUT_MINUTES };
