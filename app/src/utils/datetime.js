const DEFAULT_TZ = 'Asia/Kolkata';

const HAS_TZ_RE = /[zZ]$|[+\-]\d{2}:?\d{2}$/;

function shopPartsFromDate(date, timezone = DEFAULT_TZ) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const map = {};
  parts.forEach((p) => {
    if (p.type !== 'literal') map[p.type] = Number(p.value);
  });
  return map;
}

function pseudoUtcMsFromParts(parts) {
  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour || 0),
    Number(parts.minute || 0),
    Number(parts.second || 0)
  );
}

export function parseServerDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;

  const raw = String(value).trim();
  if (!raw) return null;

  // Handle YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return new Date(`${raw}T00:00:00`);
  }

  const normalized = raw.includes(' ') ? raw.replace(' ', 'T') : raw;

  const parsed = new Date(normalized);
  if (!Number.isNaN(parsed.getTime())) return parsed;

  const fallback = new Date(raw);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

export function formatDate(value, locale = 'en-IN', options = { day: 'numeric', month: 'short', year: 'numeric' }) {
  const d = parseServerDate(value);
  return d ? d.toLocaleDateString(locale, options) : '';
}

export function formatTime(value, locale = 'en-IN', options = { hour: '2-digit', minute: '2-digit', hour12: false }) {
  const d = parseServerDate(value);
  return d ? d.toLocaleTimeString(locale, options) : '--:--';
}

export function formatDateTime(value, locale = 'en-IN', options = { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) {
  const d = parseServerDate(value);
  return d ? d.toLocaleString(locale, options) : '';
}

/**
 * Returns a relative time string: "Just now", "3 min ago", "2 hrs ago", "Yesterday", etc.
 */
export function relativeTime(value) {
  const d = parseServerDate(value);
  if (!d) return '';
  const now = new Date();
  const diffMs = now - d;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffSec < 60) return 'Just now';
  if (diffMin < 60) return `${diffMin} min ago`;
  if (diffHr < 24) return `${diffHr} hr${diffHr > 1 ? 's' : ''} ago`;
  if (diffDay === 1) return 'Yesterday';
  if (diffDay < 7) return `${diffDay} days ago`;
  return formatDate(value);
}

/**
 * Returns "Today", "Yesterday", or formatted date
 */
export function formatDateLabel(value) {
  const d = parseServerDate(value);
  if (!d) return '';
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((today - target) / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays === -1) return 'Tomorrow';
  return formatDate(value);
}

/**
 * Check if a date is today
 */
export function isToday(value) {
  const d = parseServerDate(value);
  if (!d) return false;
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

/**
 * Parse a time string like "14:30:00" or "2:30 PM" into display format
 */
export function formatTimeString(timeStr) {
  if (!timeStr) return '';
  // If it's already a full datetime, use formatTime
  if (timeStr.includes('T') || timeStr.includes('-')) return formatTime(timeStr);
  // Parse HH:MM:SS or HH:MM
  const parts = timeStr.split(':');
  if (parts.length < 2) return timeStr;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return timeStr;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

/**
 * Sort comparator for descending date order (newest first)
 */
export function sortByDateDesc(key = 'created_at') {
  return (a, b) => {
    const da = parseServerDate(a[key]);
    const db = parseServerDate(b[key]);
    if (!da && !db) return 0;
    if (!da) return 1;
    if (!db) return -1;
    return db - da;
  };
}

/**
 * Get current date in Shop Timezone as a Date object
 */
export function getShopNow(timezone = DEFAULT_TZ) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    hour12: false
  }).formatToParts(now);

  const map = {};
  parts.forEach(p => map[p.type] = p.value);
  
  // Create a Date object representing the time in that zone
  return new Date(map.year, map.month - 1, map.day, map.hour, map.minute, map.second);
}

/**
 * Minutes from "now" (shop timezone) until a scheduled local date+time.
 * Properly handles timezone-aware comparison using shop timezone.
 */
export function minutesUntilShopDateTime(dateStr, timeStr, timezone = DEFAULT_TZ) {
  if (!dateStr || !timeStr) return null;

  const dm = String(dateStr).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const tm = String(timeStr).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!dm || !tm) return null;

  // Build scheduled datetime in pseudo-UTC (treating shop-local as UTC)
  const scheduledMs = Date.UTC(
    Number(dm[1]),
    Number(dm[2]) - 1,
    Number(dm[3]),
    Number(tm[1]),
    Number(tm[2]),
    Number(tm[3] || 0)
  );

  // Get current time in shop timezone as pseudo-UTC
  const now = new Date();
  const shopParts = shopPartsFromDate(now, timezone);
  if (!shopParts || !shopParts.year || Number.isNaN(shopParts.year)) {
    // Fallback if Intl fails: use device time (acceptable if device is in shop tz)
    return Math.floor((scheduledMs - now.getTime()) / 60000);
  }
  
  const nowMs = pseudoUtcMsFromParts(shopParts);
  const diffMs = scheduledMs - nowMs;
  
  return Math.floor(diffMs / 60000);
}

/**
 * Minutes elapsed from a server datetime value to "now" (in shop timezone).
 * Treats server values as shop-local and compares in shop timezone.
 */
export function minutesSinceServerDate(value, timezone = DEFAULT_TZ) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  let targetMs = null;

  // If it's a plain YYYY-MM-DD or YYYY-MM-DD HH:MM:SS without timezone, treat as shop-local
  if (!HAS_TZ_RE.test(raw)) {
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) {
      // Parse as shop-local time in pseudo-UTC
      targetMs = Date.UTC(
        Number(m[1]),
        Number(m[2]) - 1,
        Number(m[3]),
        Number(m[4] || 0),
        Number(m[5] || 0),
        Number(m[6] || 0)
      );
    }
  }

  if (targetMs == null) {
    // Fallback: try to parse as ISO string
    const parsed = parseServerDate(raw);
    if (!parsed) return null;
    targetMs = parsed.getTime();
  }

  // Get current time in shop timezone as pseudo-UTC
  const now = new Date();
  const shopParts = shopPartsFromDate(now, timezone);
  if (!shopParts || !shopParts.year || Number.isNaN(shopParts.year)) {
    // Fallback if Intl fails: use device time
    return Math.floor((now.getTime() - targetMs) / 60000);
  }
  
  const nowMs = pseudoUtcMsFromParts(shopParts);
  const diffMs = nowMs - targetMs;
  return Math.floor(diffMs / 60000);
}

/**
 * Get current date string (YYYY-MM-DD) in Shop Timezone
 */
export function getShopTodayStr(timezone = DEFAULT_TZ) {
  return new Intl.DateTimeFormat('en-CA', { 
    timeZone: timezone, 
    year: 'numeric', month: '2-digit', day: '2-digit' 
  }).format(new Date());
}

/**
 * Get tomorrow's date string (YYYY-MM-DD) in Shop Timezone
 */
export function getShopTomorrowStr(timezone = DEFAULT_TZ) {
  const tomorrow = new Date(Date.now() + 86400000);
  return new Intl.DateTimeFormat('en-CA', { 
    timeZone: timezone, 
    year: 'numeric', month: '2-digit', day: '2-digit' 
  }).format(tomorrow);
}


/**
 * Format date for display considering Shop Timezone
 */
export function formatShopDateLabel(value, timezone = DEFAULT_TZ) {
  const d = parseServerDate(value);
  if (!d) return '';
  
  const shopNow = getShopNow(timezone);
  const today = new Date(shopNow.getFullYear(), shopNow.getMonth(), shopNow.getDate());
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  
  const diffDays = Math.round((today - target) / (1000 * 60 * 60 * 24));
  
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays === -1) return 'Tomorrow';
  
  return formatDate(value);
}

