// Which delivery actions a viewer may take. Mirrors server permissions (verified 2026-10-24).
// key             | status                    | allowed
// assign          | pending                   | owner, manager, counter_staff
// pickup          | assigned + sale ready     | owner, manager; counter_staff if counter_can_mark_picked_up; delivery_partner if own
//                 |   (sale_status ready or completed: /pickup refuses "Order is not ready for pickup yet" otherwise)
// start           | picked_up                 | owner, manager; delivery_partner if own
// deliver         | picked_up / in_transit    | owner, manager; counter_staff if counter_can_mark_delivered; delivery_partner if own
// fail            | picked_up / in_transit    | owner, manager; delivery_partner if own
// reattempt       | failed                    | owner, manager, counter_staff
// cancel          | failed                    | owner, manager, counter_staff
// verify_load     | not final                 | owner, manager, employee, counter_staff; delivery_partner if own
// live_location   | in_transit + partner set  | every role except customer
// convert_payment | not final                 | owner, manager
// print           | any                       | every role except customer

export const ACTION_ORDER = ['assign', 'pickup', 'start', 'deliver', 'reattempt', 'fail', 'cancel', 'verify_load', 'live_location', 'convert_payment', 'print'];
export const PRIMARY_ACTIONS = new Set(['assign', 'pickup', 'start', 'deliver', 'reattempt']);

// PUT /deliveries/:id/pickup only accepts a sale in one of these statuses.
// GET /deliveries/:id sends the sale's status as `sale_status`.
export const SALE_READY_FOR_PICKUP = ['ready', 'completed'];

export function isFinalDelivery(status) {
  return status === 'delivered' || status === 'failed' || status === 'cancelled';
}

export function getDeliveryActions({ delivery, role, userId }) {
  if (!delivery || !role || role === 'customer') return [];
  const s = delivery.status;
  const isOwnerMgr = role === 'owner' || role === 'manager';
  const isCounter = role === 'counter_staff';
  const hasPartner = delivery.delivery_partner_id != null && delivery.delivery_partner_id !== '';
  const isOwn = role === 'delivery_partner' && hasPartner && userId != null &&
    Number(delivery.delivery_partner_id) === Number(userId);
  const inFlight = s === 'picked_up' || s === 'in_transit';
  const final = isFinalDelivery(s);

  const allowed = {
    assign: s === 'pending' && (isOwnerMgr || isCounter),
    pickup: s === 'assigned' && SALE_READY_FOR_PICKUP.includes(delivery.sale_status) &&
      (isOwnerMgr || (isCounter && !!delivery.counter_can_mark_picked_up) || isOwn),
    start: s === 'picked_up' && (isOwnerMgr || isOwn),
    deliver: inFlight && (isOwnerMgr || (isCounter && !!delivery.counter_can_mark_delivered) || isOwn),
    fail: inFlight && (isOwnerMgr || isOwn),
    reattempt: s === 'failed' && (isOwnerMgr || isCounter),
    cancel: s === 'failed' && (isOwnerMgr || isCounter),
    verify_load: !final && (isOwnerMgr || role === 'employee' || isCounter || isOwn),
    live_location: s === 'in_transit' && hasPartner,
    convert_payment: !final && isOwnerMgr,
    print: true,
  };
  return ACTION_ORDER.filter((k) => allowed[k]);
}

// Pre-fill for the Mark Delivered COD amount: the EXACT remaining amount,
// rounded to paise, no trailing zeros ("500", "499.5"). Never rounded up to
// whole rupees: the server rejects collecting more than what is remaining.
// "0" (not empty) when nothing remains, so Confirm works without typing.
export function formatCodPrefill(codAmount, codCollected) {
  const remaining = Math.max(Number(codAmount || 0) - Number(codCollected || 0), 0);
  return String(Number(remaining.toFixed(2)));
}

// Whether Mark Delivered must open the Confirm Delivery form (COD amount,
// proof photo) or can be submitted in one tap. One tap only when nothing is
// left to collect AND the viewer is not the rider: riders always get the form
// (proof photo is their step), and anyone collecting COD must confirm the
// amount. "Nothing left" is compared in whole paise, as the server does
// (codExceedsRemaining) — never a raw float subtraction.
export function deliverNeedsForm({ delivery, role }) {
  if (role === 'delivery_partner') return true;
  const owedPaise = Math.round(Number(delivery?.cod_amount || 0) * 100);
  const collectedPaise = Math.round(Number(delivery?.cod_collected || 0) * 100);
  return owedPaise - collectedPaise > 0;
}

// True when this viewer WOULD get "Pick Up Order" but the order is not marked
// ready yet (e.g. right after Reattempt, which sends the sale back to
// confirmed). The panel then says so in one line instead of a dead button.
export function pickupWaitingForReady({ delivery, role, userId }) {
  if (!delivery || SALE_READY_FOR_PICKUP.includes(delivery.sale_status)) return false;
  return getDeliveryActions({ delivery: { ...delivery, sale_status: 'ready' }, role, userId }).includes('pickup');
}

const toPaise = (n) => Math.round(Number(n || 0) * 100);

// Money still held on this sale: payments minus refunds, in whole paise (the
// same sums PUT /sales/:id/cancel compares). `payments` and `refunded_total`
// both come from GET /deliveries/:id.
export function netPaidPaise(delivery) {
  const paid = (Array.isArray(delivery?.payments) ? delivery.payments : [])
    .reduce((sum, p) => sum + toPaise(p.amount), 0);
  return paid - toPaise(delivery?.refunded_total);
}

// Whether "Cancel delivery and order" can work: PUT /sales/:id/cancel refuses
// a sale whose unrefunded balance is over 0.01 rupees (i.e. over 1 paisa).
export function canCancelWholeOrder(delivery) {
  return netPaidPaise(delivery) <= 1;
}

// "₹499.5", "₹1,200" — from whole paise, no float noise.
export function formatRupeesFromPaise(paise) {
  const rupees = Math.round(Number(paise || 0)) / 100;
  return `₹${rupees.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}
