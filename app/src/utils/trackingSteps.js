// Pure stage->visual-step mapping for the public customer tracking page
// (TrackingScreen.js). No React/RN/api dependency — directly requireable
// from a plain Node assert script, matching this codebase's established
// pattern for pure logic (see app/src/utils/orderGrouping.js,
// app/src/utils/registerSessions.js). Stage keys/labels are copied
// verbatim from server/utils/order-stage.js — that file is the one
// source of truth; if its labels/keys ever change, this must change too.
// See docs/superpowers/specs/2026-09-11-customer-tracking-page-design.md §4.
const LADDERS = {
  pickup: [
    { key: 'new', label: 'Order Received' },
    { key: 'preparing', label: 'Preparing' },
    { key: 'ready_for_pickup', label: 'Ready for Pickup' },
    { key: 'picked_up', label: 'Picked Up' },
  ],
  delivery: [
    { key: 'new', label: 'Order Received' },
    { key: 'preparing', label: 'Preparing' },
    { key: 'ready', label: 'Ready' },
    { key: 'out_for_delivery', label: 'Out for Delivery' },
    { key: 'delivered', label: 'Delivered' },
  ],
};
// walk_in and pre_order (fulfilled in-shop, i.e. not order_type 'delivery')
// share the simplest ladder — neither has a pickup/delivery-specific
// intermediate stage.
const DEFAULT_LADDER = [
  { key: 'new', label: 'Order Received' },
  { key: 'preparing', label: 'Preparing' },
  { key: 'ready', label: 'Ready' },
  { key: 'completed', label: 'Completed' },
];

function getTrackingSteps(orderType, stageKey) {
  if (stageKey === 'cancelled') return null;
  const ladder = LADDERS[orderType] || DEFAULT_LADDER;
  let current = ladder.findIndex((s) => s.key === stageKey);
  // 'completed' is reachable from any order type once fully done, but is
  // only actually a rung in DEFAULT_LADDER — for pickup/delivery, clamp to
  // the ladder's own last step (its label already means "fully done" for
  // that order type: Picked Up / Delivered) rather than falling through to
  // index 0, which would wrongly show a finished order as freshly received.
  if (current === -1 && stageKey === 'completed') current = ladder.length - 1;
  if (current === -1) current = 0; // any other unrecognized key: safest default
  return {
    current,
    steps: ladder.map((s, i) => ({ label: s.label, done: i < current, current: i === current })),
  };
}

module.exports = { getTrackingSteps };
