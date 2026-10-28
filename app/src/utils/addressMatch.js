// Normalises an address for comparison: lower-case, commas and runs of
// whitespace collapsed to single spaces, trimmed.
const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[,\s]+/g, ' ').trim();

export function sameAddress(a, b) {
  const x = norm(a);
  return x !== '' && x === norm(b);
}

// Text to put in the delivery address field for a saved address row.
export function addressText(row) {
  if (!row) return '';
  if (row.address && String(row.address).trim()) return String(row.address).trim();
  return [row.address_line_1, row.address_line_2, row.city, row.pincode]
    .map((p) => (p || '').toString().trim()).filter(Boolean).join(', ');
}
