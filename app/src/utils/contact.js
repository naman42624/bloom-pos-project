// Shared Call/WhatsApp helpers — normalizes phone numbers once, in one
// place, instead of each screen re-deriving its own tel:/wa.me link.
// Fixes a real bug found in this codebase: OrderCard.js and
// SettlementsScreen.js each hardcoded a "91" country prefix directly onto
// whatever was in the phone field, so a number already stored with a
// leading +91/91 produced wa.me/9191... See
// docs/superpowers/specs/2026-09-05-order-list-screens-redesign-design.md §4.

// Strips everything but digits, then removes a leading country code (91)
// if present, always returning a bare 10-digit number (or '' if the input
// doesn't look like a phone number at all).
function normalizePhone(raw) {
  if (!raw) return '';
  const digitsOnly = String(raw).replace(/\D/g, '');
  if (digitsOnly.length === 12 && digitsOnly.startsWith('91')) return digitsOnly.slice(2);
  if (digitsOnly.length === 10) return digitsOnly;
  return digitsOnly.length >= 10 ? digitsOnly.slice(-10) : '';
}

function telLink(phone) {
  return `tel:${normalizePhone(phone)}`;
}

function waLink(phone, message) {
  const num = normalizePhone(phone);
  const encoded = encodeURIComponent(message || '');
  return `https://wa.me/91${num}?text=${encoded}`;
}

// Message template table — see the design doc §4 for the full catalog and
// why each one is worded the way it is. `general_inquiry` is the fallback
// for both an unrecognized type and no context at all, matching the one
// generic message every Call/WhatsApp touchpoint used before this file
// existed.
const TEMPLATES = {
  order_ready_pickup: (p) => `Hi, your order ${p.sale_number} is ready for pickup at ${p.location_name}.`,
  order_out_for_delivery: (p) => `Hi, your order ${p.sale_number} is out for delivery.`,
  rider_handoff: (p) => `Hi ${p.name}, please hand over ₹${p.total} from ${p.count} deliveries when you're at the shop.`,
  tracking_link: (p) => `Hi, you can track your order ${p.sale_number} here: ${p.tracking_url}`,
  general_inquiry: (p) => `Hi, this is about your order ${p.sale_number}.`,
};

function buildMessage(type, params = {}) {
  const template = TEMPLATES[type] || TEMPLATES.general_inquiry;
  return template(params);
}

module.exports = { normalizePhone, telLink, waLink, buildMessage };
