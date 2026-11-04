// Shared public web origin used for QR codes and shareable links.
// Dev fallback is this project's Expo web port (8081).
const DEV_FALLBACK = 'http://localhost:8081';

// Trailing slashes are dropped ("https://shop.com/" would make "//p/CODE"
// links) and a missing scheme gets https:// ("shop.com" would make QR codes
// that are plain text, not links). Both made labels the scanner refused.
const normalizeBaseUrl = (url) => {
  const s = String(url || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
};

const configuredUrl = (env = process.env) => normalizeBaseUrl(env && env.PUBLIC_APP_URL);

const PUBLIC_APP_URL = configuredUrl() || DEV_FALLBACK;

// True when a production server has no PUBLIC_APP_URL: anything printed with a
// link (product labels) would point at localhost and be useless once stuck.
function publicUrlMissingInProduction(env = process.env) {
  return !!env && env.NODE_ENV === 'production' && !configuredUrl(env);
}

// Host part only (e.g. "shop.example.com"), for printing small on labels.
function publicUrlHost(url = PUBLIC_APP_URL) {
  try { return new URL(url).host; } catch { return String(url || ''); }
}

module.exports = { PUBLIC_APP_URL, DEV_FALLBACK, publicUrlMissingInProduction, publicUrlHost, normalizeBaseUrl };
