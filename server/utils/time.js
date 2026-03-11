const { getDb } = require('../config/database');

let cachedTimezone = null;
let cacheExpiry = 0;

/**
 * Get the shop timezone from settings (cached for 5 minutes).
 * Default: 'Asia/Kolkata'
 */
function getTimezone() {
  const now = Date.now();
  if (cachedTimezone && now < cacheExpiry) return cachedTimezone;
  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM settings WHERE key = 'timezone'").get();
    cachedTimezone = (row && row.value) || 'Asia/Kolkata';
  } catch {
    cachedTimezone = 'Asia/Kolkata';
  }
  cacheExpiry = now + 5 * 60 * 1000;
  return cachedTimezone;
}

/**
 * Get current date string (YYYY-MM-DD) in shop timezone.
 */
function todayStr() {
  const tz = getTimezone();
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return parts; // en-CA gives YYYY-MM-DD format
}

/**
 * Get current datetime string (YYYY-MM-DD HH:mm:ss) in shop timezone.
 */
function nowLocal() {
  const tz = getTimezone();
  const now = new Date();
  const d = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const t = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(now);
  return `${d} ${t}`;
}

/**
 * Get current time string (HH:mm:ss) in shop timezone.
 */
function nowTimeStr() {
  const tz = getTimezone();
  const now = new Date();
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(now);
}

/** Clear the cached timezone (call after settings update). */
function clearTimezoneCache() {
  cachedTimezone = null;
  cacheExpiry = 0;
}

module.exports = { getTimezone, todayStr, nowLocal, nowTimeStr, clearTimezoneCache };
