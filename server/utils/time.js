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
function todayStr() {
  const tz = getTimezone();
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return parts; // en-CA gives YYYY-MM-DD format
}

/**
 * Get current datetime string (ISO 8601 with offset) in shop timezone.
 * Returns e.g. "2026-04-04T07:52:38+05:30"
 */
function nowLocal() {
  const tz = getTimezone();
  const now = new Date();
  
  // Format to a string that includes parts and then manually calculate offset
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    hour12: false
  });
  const parts = formatter.formatToParts(now);
  const map = {};
  parts.forEach(p => map[p.type] = p.value);
  
  // Construct YYYY-MM-DDTHH:mm:ss
  const isoBase = `${map.year}-${String(map.month).padStart(2, '0')}-${String(map.day).padStart(2, '0')}T${String(map.hour).padStart(2, '0')}:${String(map.minute).padStart(2, '0')}:${String(map.second).padStart(2, '0')}`;
  
  // Calculate offset correctly:
  // localAsUTC treats the local components as if they were UTC
  // The difference between this and the actual UTC moment gives us the offset
  const localAsUTC = new Date(`${isoBase}Z`);
  const offsetMs = localAsUTC - now;
  const offsetMins = Math.round(offsetMs / 60000);
  const absDiff = Math.abs(offsetMins);
  const sign = offsetMins >= 0 ? '+' : '-';
  const h = String(Math.floor(absDiff / 60)).padStart(2, '0');
  const m = String(absDiff % 60).padStart(2, '0');
  
  return `${isoBase}${sign}${h}:${m}`;
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
 * Parse a server datetime string (legacy local or new ISO with offset).
 * Assumes +05:30 for legacy IST strings if no offset is present.
 */
function parseServerDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const str = String(value).trim();
  const normalized = str.includes(' ') ? str.replace(' ', 'T') : str;
  const hasOffset = /[zZ]$|[+\-]\d{2}:?\d{2}$/.test(normalized);
  const candidate = (!hasOffset && normalized.includes('T')) ? `${normalized}+05:30` : normalized;
  const d = new Date(candidate);
  return Number.isNaN(d.getTime()) ? null : d;
}

module.exports = { getTimezone, todayStr, nowLocal, nowTimeStr, clearTimezoneCache, parseServerDate };
