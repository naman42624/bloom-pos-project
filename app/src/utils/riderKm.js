// Pure helpers for the rider km account (Km reading form, account view).
const trim1 = (n) => String(Math.round(Number(n) * 10) / 10);

// Arriving and Going home alternate; start on Arriving.
export function suggestKind(lastReading) {
  if (!lastReading) return 'arrive';
  return lastReading.kind === 'arrive' ? 'leave' : 'arrive';
}

// Shown under the meter: the work done since the last Arriving reading.
export function workKmText(lastReading, meter) {
  if (!lastReading || lastReading.kind !== 'arrive') return null;
  if (meter === '' || meter === null || meter === undefined) return null;
  const m = Number(meter);
  const last = Number(lastReading.meter);
  if (!Number.isFinite(m) || !Number.isFinite(last) || m <= last) return null;
  return `→ ${trim1(m - last)} km of work`;
}

export function stretchLabel(stretch) {
  const s = stretch || {};
  const km = trim1(s.km || 0);
  if (s.kind === 'home') return `Home ride ${km} km (not paid)`;
  if (s.kind === 'gap') return s.answer ? `Gap ${km} km` : `Gap ${km} km — answer`;
  return `${km} km`;
}

const rupees = (paise) => `₹${(Math.abs(Number(paise) || 0) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

export function netText(name, paise) {
  const p = Number(paise) || 0;
  if (p > 0) return `Shop pays ${name} ${rupees(p)}`;
  if (p < 0) return `${name} owes ${rupees(p)}`;
  return 'Nothing to pay';
}

// "9:12 am" for a "YYYY-MM-DD HH:MM:SS" shop-local string.
export function clockText(readAt) {
  const m = /(\d{1,2}):(\d{2})/.exec(String(readAt || '').split(/[ T]/)[1] || '');
  if (!m) return '';
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h >= 12 ? 'pm' : 'am'}`;
}
