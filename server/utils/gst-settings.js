/* GST settings the bill maths needs (2026-11-05). Read inside the caller's
 * transaction so a sale and its bill use one consistent set. */
const GSTIN_RE = /^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]Z[0-9A-Z]$/;

function cleanHsn(raw) {
  const v = String(raw == null ? '' : raw).replace(/\s/g, '');
  return /^[0-9]{4,8}$/.test(v) ? v : null;
}

async function readGstSettings(db) {
  const rows = await db.prepare(
    "SELECT key, value FROM settings WHERE key IN ('gst_delivery_rate', 'gst_default_hsn', 'gst_default_rate', 'bill_round_off')"
  ).all();
  const m = {};
  for (const r of rows) m[r.key] = r.value;
  const num = (v, d) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    deliveryRate: num(m.gst_delivery_rate, 18),
    defaultRate: num(m.gst_default_rate, 0),
    defaultHsn: cleanHsn(m.gst_default_hsn),
    roundOff: m.bill_round_off !== '0',
  };
}

module.exports = { readGstSettings, cleanHsn, GSTIN_RE };
