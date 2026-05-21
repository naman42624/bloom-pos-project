export const DEFAULT_TZ = 'Asia/Kolkata';

function getDeviceTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}



export function parseServerDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;

  const raw = String(value).trim();
  if (!raw) return null;

  // Handle YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return new Date(`${raw}T00:00:00Z`);
  }

  const normalized = raw.includes(' ') ? raw.replace(' ', 'T') : raw;

  // Enforce UTC standard: if there's no timezone info (Z or +/-), treat it as UTC by appending 'Z'
  const finalStr = (normalized.includes('T') && !/[zZ]$|[+\-]\d{2}:?\d{2}$/.test(normalized)) 
    ? `${normalized}Z` 
    : normalized;

  const parsed = new Date(finalStr);
  if (!Number.isNaN(parsed.getTime())) return parsed;

  const fallback = new Date(raw);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

export function formatDate(value, locale = 'en-IN', options = {}) {
  const d = parseServerDate(value);
  const opts = { day: 'numeric', month: 'short', year: 'numeric', timeZone: DEFAULT_TZ, ...options };
  return d ? d.toLocaleDateString(locale, opts) : '';
}

export function formatTime(value, locale = 'en-IN', options = {}) {
  const d = parseServerDate(value);
  const opts = { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: DEFAULT_TZ, ...options };
  return d ? d.toLocaleTimeString(locale, opts) : '--:--';
}

export function formatDateTime(value, locale = 'en-IN', options = {}) {
  const d = parseServerDate(value);
  const opts = { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true, timeZone: DEFAULT_TZ, ...options };
  return d ? d.toLocaleString(locale, opts) : '';
}

/**
 * Formats a date + time pair for display without shifting the wall-clock time.
 * Intended for shop-scheduled dates where the date and time are stored separately.
 */
export function formatCardDateTime(dateStr, timeStr, timezone = DEFAULT_TZ) {
  try {
    if (dateStr) {
      let localDate = dateStr;
      if (dateStr.includes('T') || dateStr.includes('Z') || dateStr.includes('+')) {
        const d = new Date(dateStr);
        if (!Number.isNaN(d.getTime())) {
          localDate = d.toLocaleDateString('en-CA', { timeZone: timezone || DEFAULT_TZ });
        }
      }

      const parts = String(localDate).split('-').map(Number);
      if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) return dateStr || '';

      const [year, month, day] = parts;
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const datePart = `${day} ${months[month - 1]}`;

      if (!timeStr) return datePart;

      const [hh, mm] = String(timeStr).split(':').map(Number);
      if (Number.isNaN(hh) || Number.isNaN(mm)) return datePart;

      return `${datePart}, ${formatTimeString(timeStr)}`;
    }
  } catch {
    // fall through to return the original input
  }
  return dateStr || '';
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
  
  const tzOpts = { timeZone: DEFAULT_TZ, year: 'numeric', month: '2-digit', day: '2-digit' };
  const dParts = new Intl.DateTimeFormat('en-CA', tzOpts).format(d).split('-');
  const nowParts = new Intl.DateTimeFormat('en-CA', tzOpts).format(now).split('-');
  
  const today = new Date(nowParts[0], nowParts[1] - 1, nowParts[2]);
  const target = new Date(dParts[0], dParts[1] - 1, dParts[2]);
  
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
  
  const tzOpts = { timeZone: DEFAULT_TZ, year: 'numeric', month: '2-digit', day: '2-digit' };
  const dStr = new Intl.DateTimeFormat('en-CA', tzOpts).format(d);
  const nowStr = new Intl.DateTimeFormat('en-CA', tzOpts).format(now);
  
  return dStr === nowStr;
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
 * Minutes from "now" until a scheduled local date+time.
 */
export function minutesUntilShopDateTime(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const scheduled = new Date(`${dateStr}T${timeStr}`);
  if (Number.isNaN(scheduled.getTime())) return null;
  const now = new Date();
  return Math.floor((scheduled.getTime() - now.getTime()) / 60000);
}

/**
 * Minutes elapsed from a server datetime value to "now".
 */
export function minutesSinceServerDate(value) {
  const d = parseServerDate(value);
  if (!d) return null;
  const now = new Date();
  return Math.floor((now.getTime() - d.getTime()) / 60000);
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

