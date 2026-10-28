// Indian phone normalization shared by the open order-request link and the
// staff-side customer matching. Strips spaces, dashes, dots, brackets, a
// leading +91 / 91 country code and a leading 0, then requires exactly 10
// digits. "+91 98765 43210", "098765 43210" and "9876543210" all give
// "9876543210". Anything else gives null.
function normalizeIndianPhone(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim().replace(/[\s\-().]/g, '');
  if (s.startsWith('+91')) s = s.slice(3);
  else if (s.startsWith('+')) return null;
  if (!/^\d+$/.test(s)) return null;
  if (s.length === 12 && s.startsWith('91')) s = s.slice(2);
  else if (s.length === 11 && s.startsWith('0')) s = s.slice(1);
  return /^\d{10}$/.test(s) ? s : null;
}

// SQL expression giving the same 10-digit normalization of a stored phone
// column, so lookups match customers saved in any format. Not parameterized:
// pass a trusted column name only. No question marks in it on purpose, since
// database-async binds parameters by scanning for them.
function normalizedPhoneSql(column) {
  const digits = `regexp_replace(${column}, '[^0-9]', '', 'g')`;
  return `(CASE WHEN length(${digits}) = 12 AND ${digits} LIKE '91%' THEN substr(${digits}, 3)
    WHEN length(${digits}) = 11 AND ${digits} LIKE '0%' THEN substr(${digits}, 2)
    ELSE ${digits} END)`;
}

module.exports = { normalizeIndianPhone, normalizedPhoneSql };
