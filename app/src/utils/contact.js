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
  // Rewritten 2026-09-13 (staff-ux request) to name the customer and the
  // order's schedule, not just its number — p.customer_name and
  // p.scheduled_label are both optional and gracefully omitted (a bare
  // walk_in with no name on file, or no scheduled_date at all, still gets
  // a sensible message instead of "Hi undefined" or "scheduled for").
  // p.scheduled_label should already be a formatted string (see
  // formatScheduledLabel in utils/datetime.js) — this template does no
  // date parsing of its own.
  //
  // The URL sits on its own line, not inline in the sentence — the closest
  // thing to "not showing the raw link" WhatsApp text messages actually
  // allow. WhatsApp does NOT support markdown-style [text](url) hyperlinks
  // in plain messages (that's only available via the WhatsApp Business
  // API's interactive message templates, a deliberately-deferred feature —
  // see CLAUDE.md's "WhatsApp needs no API integration" decision) — a
  // wa.me deep link always shows the full URL as visible text, with no way
  // to swap in friendlier display text. Don't re-attempt this without
  // adopting that API first.
  tracking_link: (p) => {
    const greeting = p.customer_name ? `Hi ${p.customer_name},` : 'Hi,';
    const body = p.scheduled_label
      ? `your order ${p.sale_number} is scheduled for ${p.scheduled_label}.`
      : `here's your order ${p.sale_number}.`;
    return `${greeting} ${body}\nTrack it here: ${p.tracking_url}`;
  },
  general_inquiry: (p) => `Hi, this is about your order ${p.sale_number}.`,
};

function buildMessage(type, params = {}) {
  const template = TEMPLATES[type] || TEMPLATES.general_inquiry;
  return template(params);
}

module.exports = { normalizePhone, telLink, waLink, buildMessage };
