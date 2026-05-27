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
 * Clear the timezone cache (for testing or manual reset).
 */
function clearTimezoneCache() {
  cachedTimezone = null;
  cacheExpiry = 0;
}

/**
 * Get current date string (YYYY-MM-DD) in shop timezone.
 */
function todayStr(dateObj) {
  const tz = getTimezone();
  const now = (dateObj instanceof Date && !Number.isNaN(dateObj.getTime())) ? dateObj : new Date();
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return parts; // en-CA gives YYYY-MM-DD format
}

function nowUtc() {
  return new Date().toISOString();
}

function nowLocal() {
  return nowUtc();
}

/**
 * Get current time string (HH:mm:ss) in shop timezone.
 */
function nowTimeStr() {
  const tz = getTimezone();
  const now = new Date();
  const t = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(now);
  return t;
}

/**
 * Parse a server datetime string.
 * Enforces UTC for strings without an offset.
 */
function parseServerDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const str = String(value).trim();
  if (!str) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return new Date(`${str}T00:00:00Z`);
  }

  const normalized = str.includes(' ') ? str.replace(' ', 'T') : str;
  const finalStr = (normalized.includes('T') && !/[zZ]$|[+\-]\d{2}:?\d{2}$/.test(normalized)) 
    ? `${normalized}Z` 
    : normalized;

  const d = new Date(finalStr);
  return Number.isNaN(d.getTime()) ? null : d;
}

module.exports = { getTimezone, todayStr, nowUtc, nowLocal, nowTimeStr, clearTimezoneCache, parseServerDate };
