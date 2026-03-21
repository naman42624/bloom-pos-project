export function parseServerDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;

  const raw = String(value).trim();
  if (!raw) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return new Date(`${raw}T00:00:00`);
  }

  const hasTimezone = /[zZ]$|[+\-]\d{2}:?\d{2}$/.test(raw);
  const normalized = raw.includes(' ') ? raw.replace(' ', 'T') : raw;
  const candidate = hasTimezone ? normalized : `${normalized}Z`;

  const parsed = new Date(candidate);
  if (!Number.isNaN(parsed.getTime())) return parsed;

  const fallback = new Date(raw);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

export function formatDate(value, locale = 'en-IN', options = { day: 'numeric', month: 'short', year: 'numeric' }) {
  const d = parseServerDate(value);
  return d ? d.toLocaleDateString(locale, options) : '';
}

export function formatTime(value, locale = 'en-IN', options = { hour: '2-digit', minute: '2-digit' }) {
  const d = parseServerDate(value);
  return d ? d.toLocaleTimeString(locale, options) : '--:--';
}

export function formatDateTime(value, locale = 'en-IN', options = { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) {
  const d = parseServerDate(value);
  return d ? d.toLocaleString(locale, options) : '';
}
