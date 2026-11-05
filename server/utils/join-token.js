// One-time join links for helpers (spec 8.3). The raw token only ever lives
// in the link; the database keeps its SHA-256 hash. Valid 24 hours, single use,
// and issuing a new one cancels any older unused ones for that user.
const crypto = require('crypto');
const { PUBLIC_APP_URL } = require('./public-url');

const JOIN_TOKEN_BYTES = 32;
const JOIN_LINK_COPY = 'This link has been used or has expired. Ask the owner for a new code.';

function hashJoinToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// base64url of 32 bytes is 43 characters. Anything else cannot be a real
// token, so callers can refuse it without touching the database.
function looksLikeJoinToken(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
}

function joinUrl(token) {
  return `${PUBLIC_APP_URL}/join/${token}`;
}

// db: an async db or a withTransaction tx. Older unused tokens are marked
// used (not deleted) so the table keeps a record of every link issued.
async function createJoinToken(db, userId, createdBy) {
  const token = crypto.randomBytes(JOIN_TOKEN_BYTES).toString('base64url');
  await db.prepare(
    'UPDATE helper_join_tokens SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL'
  ).run(userId);
  const row = await db.prepare(`
    INSERT INTO helper_join_tokens (user_id, token_hash, expires_at, created_by)
    VALUES (?, ?, NOW() + INTERVAL '24 hours', ?)
    RETURNING id, expires_at
  `).get(userId, hashJoinToken(token), createdBy || null);
  return { token, expires_at: row.expires_at };
}

// Live (unused, unexpired) token row plus its user, without consuming it.
async function findLiveJoinToken(db, token) {
  if (!looksLikeJoinToken(token)) return null;
  return db.prepare(`
    SELECT t.id AS token_id, u.*
    FROM helper_join_tokens t
    JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = ? AND t.used_at IS NULL AND t.expires_at > NOW()
  `).get(hashJoinToken(token)) || null;
}

// Atomic single use: of two simultaneous calls only one gets the user id.
async function consumeJoinToken(db, token) {
  if (!looksLikeJoinToken(token)) return null;
  const row = await db.prepare(`
    UPDATE helper_join_tokens SET used_at = NOW()
    WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW()
    RETURNING user_id
  `).get(hashJoinToken(token));
  return row ? row.user_id : null;
}

module.exports = {
  createJoinToken,
  consumeJoinToken,
  findLiveJoinToken,
  hashJoinToken,
  looksLikeJoinToken,
  joinUrl,
  JOIN_LINK_COPY,
};
