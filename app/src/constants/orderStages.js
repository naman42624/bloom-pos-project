/**
 * The board's Stage columns, and the mapping from a server-computed
 * `display_stage.key` (server/utils/order-stage.js) onto one of them.
 *
 * See docs/superpowers/specs/2026-09-01-dashboard-stage-ui-redesign-design.md §3.
 *
 * computeOrderStage() emits nine keys; the board shows four columns. The
 * collapsing is deliberate:
 *   - 'ready' and 'ready_for_pickup' mean the same thing to the person at the
 *     counter (the flowers are done and waiting). The card's type icon already
 *     says which kind of waiting it is.
 *   - 'delivered' / 'picked_up' / 'completed' / 'cancelled' get NO column. A
 *     Done column fills up all day, dominates the board by volume, and is the
 *     one bucket nobody needs to act on. It surfaces as a header count chip
 *     linking to Orders Inbox instead.
 *
 * This file is data, not logic, and imports nothing — both the board and any
 * future consumer can import it without cycle risk.
 */

export const STAGE_COLUMNS = [
  { key: 'new', label: 'New', stageKeys: ['new'] },
  { key: 'preparing', label: 'Preparing', stageKeys: ['preparing'] },
  { key: 'ready', label: 'Ready', stageKeys: ['ready', 'ready_for_pickup'] },
  { key: 'out_for_delivery', label: 'Out for Delivery', stageKeys: ['out_for_delivery'] },
];

// Stage keys that are finished work — counted for the header chip, never given
// a column. Kept as an explicit list rather than "anything not in a column" so
// that adding a new live stage key server-side surfaces as an unmapped order
// (columnKeyForStage returns null and the board logs it) rather than silently
// being treated as done.
export const CLOSED_STAGE_KEYS = ['delivered', 'picked_up', 'completed', 'cancelled'];

const STAGE_KEY_TO_COLUMN = STAGE_COLUMNS.reduce((acc, col) => {
  col.stageKeys.forEach((k) => { acc[k] = col.key; });
  return acc;
}, {});

/**
 * @param {string} stageKey - a display_stage.key value
 * @returns {string|null} the column key it belongs in, or null if it is a
 *   closed stage or an unrecognized key.
 */
export function columnKeyForStage(stageKey) {
  return STAGE_KEY_TO_COLUMN[stageKey] || null;
}

export function isClosedStage(stageKey) {
  return CLOSED_STAGE_KEYS.includes(stageKey);
}

// Type is a filter, not a section (spec §5). 'all' first so it is the default.
export const TYPE_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'delivery', label: 'Delivery' },
  { key: 'pickup', label: 'Pickup' },
  { key: 'walk_in', label: 'Walk-in' },
  { key: 'pre_order', label: 'Pre-order' },
];

// Ionicons names, matching the icon vocabulary DashboardScreenV2 established.
export const TYPE_ICONS = {
  delivery: 'bicycle-outline',
  pickup: 'bag-handle-outline',
  walk_in: 'storefront-outline',
  pre_order: 'calendar-outline',
};
