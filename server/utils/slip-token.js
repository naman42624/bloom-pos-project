// Signed, unstored token for the public slip QR scan page. Same approach as
// tracking-token.js (no column, nothing to migrate) but a different HMAC
// message ('slip:' + saleId), so a tracking token can never open a slip page
// and vice versa, even though both use the same secret.
//
// Format: "<saleId>.<hmac>" (32 hex chars = 128 bits of signature).
const crypto = require('crypto');
// Importing tracking-token also runs its production guards for the secret and
// PUBLIC_APP_URL.
const { TRACKING_SECRET } = require('./tracking-token');

const PUBLIC_APP_URL = process.env.PUBLIC_APP_URL || 'http://localhost:19006';

function sign(saleId) {
  return crypto.createHmac('sha256', TRACKING_SECRET).update('slip:' + String(saleId)).digest('hex').slice(0, 32);
}

function generateSlipToken(saleId) {
  return `${saleId}.${sign(saleId)}`;
}

// Never throws. Returns the numeric sale ID on a valid token, null otherwise.
function verifySlipToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [idPart, sigPart] = token.split('.');
  if (!/^\d+$/.test(idPart)) return null;
  const expectedBuf = Buffer.from(sign(idPart), 'hex');
  const actualBuf = Buffer.from(sigPart || '', 'hex');
  if (expectedBuf.length !== actualBuf.length) return null;
  if (!crypto.timingSafeEqual(expectedBuf, actualBuf)) return null;
  return parseInt(idPart, 10);
}

function slipUrl(saleId) {
  return `${PUBLIC_APP_URL}/slip/${generateSlipToken(saleId)}`;
}

module.exports = { generateSlipToken, verifySlipToken, slipUrl };
