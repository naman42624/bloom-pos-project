// Shared helpers for the owner Staff sales screens.
export const money = (n) => '₹' + (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

const pad = (n) => String(n).padStart(2, '0');
// Local-day string built from local date parts (never toISOString, which is UTC).
export const dayStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// "This week" = Monday through today.
export function periodRange(key, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (key === 'yesterday') {
    const y = new Date(today); y.setDate(y.getDate() - 1);
    return { from: dayStr(y), to: dayStr(y) };
  }
  if (key === 'week') {
    const m = new Date(today); m.setDate(m.getDate() - ((m.getDay() + 6) % 7));
    return { from: dayStr(m), to: dayStr(today) };
  }
  if (key === 'month') {
    return { from: dayStr(new Date(today.getFullYear(), today.getMonth(), 1)), to: dayStr(today) };
  }
  return { from: dayStr(today), to: dayStr(today) };
}
