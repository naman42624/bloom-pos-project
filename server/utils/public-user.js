// The only shape a user row may take in an API response: never the password
// hash, PIN hash or PIN lockout state, even when the row came from SELECT *.
const SECRET_USER_FIELDS = ['password', 'pin_hash', 'pin_failed_attempts', 'pin_locked_until'];

function publicUser(row) {
  if (!row) return row;
  const out = { ...row };
  for (const key of SECRET_USER_FIELDS) delete out[key];
  return out;
}

module.exports = { publicUser, SECRET_USER_FIELDS };
