/**
 * Approve on an order request opens Quick Checkout in "Phone & online" mode,
 * filled in from the request (D44, 2026-11-07; replaces LogOrderScreen's own
 * prefill). This turns the request into plain form values; the screen then
 * loads each catalog product and builds the item lines.
 *
 * Kept free of imports so scripts/test-order-request-prefill.js can load it.
 */

// Only a real clock time goes into scheduled_time (a TIME column in
// production). "6:30", "18:00", "6:30 PM". Anything else ("morning",
// "6:30 or later") goes into the order notes instead.
const CLOCK = /^(\d{1,2}):(\d{2})\s*([AaPp][Mm])?$/;

export function clockTime(text) {
  const m = String(text || '').trim().match(CLOCK);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    const pm = m[3].toLowerCase() === 'pm';
    if (h === 12) h = pm ? 12 : 0;
    else if (pm) h += 12;
  } else if (h > 23) {
    return null;
  }
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/**
 * req: a row from GET /order-requests.
 * Returns { orderType, channel, sourceOrderRequestId, customer, receiver,
 *   address, cardMessage, scheduledDate, scheduledTime, notes, items }
 * items: [{ productId, quantity, name }] for catalog items,
 *        [{ productId: null, quantity, name }] for custom ones (price 0, staff set it).
 */
export function requestToForm(req) {
  const r = req || {};
  const delivery = r.order_type === 'delivery';
  const notes = [];
  const time = r.requested_time ? clockTime(r.requested_time) : null;
  if (r.requested_time && !time) notes.push(`Requested time: ${String(r.requested_time).trim()}`);

  const items = (Array.isArray(r.items_json) ? r.items_json : []).map((it) => {
    const quantity = Math.max(1, parseInt(it && it.quantity, 10) || 1);
    if (!it || it.custom || !it.product_id) {
      return { productId: null, quantity, name: String((it && (it.description || it.name)) || 'Custom item').trim() };
    }
    return { productId: Number(it.product_id), quantity, name: it.name ? String(it.name) : null };
  });

  return {
    orderType: delivery ? 'delivery' : 'pickup',
    // The customer sent it through the shop's order link
    channel: 'website',
    sourceOrderRequestId: r.id || null,
    customer: r.customer_id || r.customer_phone || r.customer_name
      ? { id: r.customer_id || null, name: r.customer_name || '', phone: r.customer_phone || '' }
      : null,
    receiver: delivery && (r.recipient_name || r.recipient_phone)
      ? { name: r.recipient_name || '', phone: r.recipient_phone || '' }
      : null,
    address: delivery ? (r.delivery_address || '') : '',
    cardMessage: r.message ? String(r.message) : '',
    scheduledDate: r.requested_date ? String(r.requested_date).slice(0, 10) : '',
    scheduledTime: time || '',
    notes: notes.join('\n'),
    items,
  };
}
