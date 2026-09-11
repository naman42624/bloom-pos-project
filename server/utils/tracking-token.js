// Signed, unstored order-tracking token. See CLAUDE.md's non-negotiable #1
// (never lose live data via schema changes) — this deliberately needs NO
// new column: the token is a cryptographic signature of the sale ID,
// verified fresh on every request, nothing to store or migrate.
//
// Format: "<saleId>.<hmac>" — the sale ID is plainly visible (an attacker
// can trivially guess it, IDs are sequential), but the HMAC signature can
// only be produced by someone holding TRACKING_LINK_SECRET, so a guessed ID
// with a made-up signature always fails verification. 128 bits of signature
// (32 hex chars) makes brute-forcing the signature for a guessed ID
// computationally infeasible.
//
// Requires TRACKING_LINK_SECRET in the environment (see server/.env and the
// fallback note next to its use in server.js, mirroring how JWT_SECRET's
// fallback is documented there).
const crypto = require('crypto');

const SECRET = process.env.TRACKING_LINK_SECRET || 'bloomcart-tracking-secret-2026';

if (process.env.NODE_ENV === 'production' && !process.env.TRACKING_LINK_SECRET) {
  throw new Error('TRACKING_LINK_SECRET must be set in production — the public order-tracking endpoint is otherwise forgeable by anyone who has read this repo.');
}

function sign(saleId) {
  return crypto.createHmac('sha256', SECRET).update(String(saleId)).digest('hex').slice(0, 32);
}

function generateTrackingToken(saleId) {
  return `${saleId}.${sign(saleId)}`;
}

// Never throws. Returns the numeric sale ID on a valid token, null on
// anything else (malformed, wrong signature, non-numeric ID) — callers
// must treat every null the same way (generic 404), never distinguishing
// "malformed" from "wrong signature" in the response, which would leak
// information to someone probing the endpoint.
function verifyTrackingToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [idPart, sigPart] = token.split('.');
  if (!/^\d+$/.test(idPart)) return null;
  const expectedSig = sign(idPart);
  const expectedBuf = Buffer.from(expectedSig, 'hex');
  const actualBuf = Buffer.from(sigPart || '', 'hex');
  if (expectedBuf.length !== actualBuf.length) return null;
  if (!crypto.timingSafeEqual(expectedBuf, actualBuf)) return null;
  return parseInt(idPart, 10);
}

// Flagged in PR review (2026-09-09): this used to fall back silently to
// localhost in production too, not just in dev — meaning a mis-set or
// forgotten NODE_ENV/PUBLIC_APP_URL wouldn't error, it would just quietly
// hand every customer a tracking link that only resolves on the machine
// that generated it. Mirrors the TRACKING_LINK_SECRET fail-fast right
// above: production must set this explicitly, dev/test keep the
// localhost fallback since there's no real customer on the other end.
if (process.env.NODE_ENV === 'production' && !process.env.PUBLIC_APP_URL) {
  throw new Error('PUBLIC_APP_URL must be set in production — otherwise customer-facing tracking links point at localhost.');
}
const PUBLIC_APP_URL = process.env.PUBLIC_APP_URL || 'http://localhost:19006';

function buildTrackingUrl(saleId) {
  return `${PUBLIC_APP_URL}/track/${generateTrackingToken(saleId)}`;
}

module.exports = { generateTrackingToken, verifyTrackingToken, buildTrackingUrl };
