// Which delivery actions a viewer may take. Mirrors server permissions (verified 2026-10-24).
// key             | status                    | allowed
// assign          | pending                   | owner, manager, counter_staff
// pickup          | assigned                  | owner, manager; counter_staff if counter_can_mark_picked_up; delivery_partner if own
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
    pickup: s === 'assigned' && (isOwnerMgr || (isCounter && !!delivery.counter_can_mark_picked_up) || isOwn),
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
