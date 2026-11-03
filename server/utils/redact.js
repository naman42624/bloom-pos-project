// Keeps one-time secrets out of request logs. A helper join link carries its
// raw token in the path (/join/<token> and /api/auth/join/<token>), and
// anyone who reads a log line could otherwise use an unspent link.
function redactSecrets(url) {
  if (typeof url !== 'string') return url;
  return url.replace(/\/join\/[^/?#]+/g, '/join/[redacted]');
}

module.exports = { redactSecrets };
