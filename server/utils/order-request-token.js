// Persistent, lazily-generated order-request token — see
// docs/superpowers/specs/2026-09-19-customer-order-request-design.md §6.
// Unlike tracking-token.js's signed-but-unstored token (one HMAC per sale,
// verified fresh every time with nothing in the DB), this token has to be
// persistent: it's shared with a customer once and then reused indefinitely
// by that same customer both to submit new requests and to check the
// status of old ones, not minted fresh per request.
const crypto = require('crypto');

if (process.env.NODE_ENV === 'production' && !process.env.PUBLIC_APP_URL) {
  throw new Error('PUBLIC_APP_URL must be set in production — otherwise order-request links point at localhost.');
}
const PUBLIC_APP_URL = process.env.PUBLIC_APP_URL || 'http://localhost:19006';

function generateOrderRequestToken() {
  return crypto.randomBytes(24).toString('hex');
}

function buildOrderRequestUrl(token) {
  return `${PUBLIC_APP_URL}/order-request/${token}`;
}

module.exports = { generateOrderRequestToken, buildOrderRequestUrl };
