/**
 * Order/task display constants and formatters shared between DashboardScreen.js
 * (the counter_staff branch, the deliveries widget, the my-tasks section,
 * TaskDetailModal) and components/orderBoard/ (the Stage board and its
 * OrderCard — this line used to name components/OrderKanbanBoard.js, deleted
 * in the Stage-board redesign). Pulled out into this leaf module (Task 9 fix-round,
 * order-lifecycle plan, 2026-09-01) so both can import a single source of
 * truth instead of each keeping its own copy — a prior version of this split
 * had them duplicated in both files to sidestep an import cycle (neither
 * screen imported the other directly, but the cycle risk was real once
 * DashboardScreen started importing the component). A shared leaf module
 * that both of *those* import from removes the cycle risk entirely: this
 * file imports nothing from either of them.
 *
 * Values here are verbatim copies of what DashboardScreen.js originally
 * defined — no changes, just relocated.
 */

// 'pre_order' was missing here (inherited from the owner/manager kanban,
// which never had it) — so once the counter_staff dashboard was rebuilt onto
// OrderKanbanBoard, advance orders stopped being shown at all, even though
// the flat card list it replaced did show them and the "Need Attention" count
// still counts them. Added 2026-09-01 (final-review fix): this also surfaces
// pre-orders on the owner/manager kanban for the first time.
export const ORDER_TYPES = ['delivery', 'pickup', 'walk_in', 'pre_order'];

export const ORDER_STATUS_LABELS = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  preparing: 'Preparing',
  ready: 'Ready',
  completed: 'Completed',
  cancelled: 'Cancelled',
  draft: 'Draft',
};

export const TASK_STATUS_LABELS = {
  pending: 'Queued',
  assigned: 'Assigned',
  in_progress: 'In Progress',
  completed: 'Done',
  cancelled: 'Cancelled',
};

export const DELIVERY_STATUS_COLORS = {
  pending: '#9CA3AF',
  assigned: '#6366F1',
  picked_up: '#F59E0B',
  in_transit: '#0EA5E9',
  delivered: '#10B981',
  failed: '#E11D48',
  cancelled: '#9CA3AF',
};

export const DELIVERY_STATUS_LABELS = {
  pending: 'Pending',
  assigned: 'Assigned',
  picked_up: 'Picked Up',
  in_transit: 'In Transit',
  delivered: 'Delivered',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const FONT_FAMILY = typeof navigator !== 'undefined' && navigator.product === 'ReactNative'
  ? undefined
  : 'Inter, Geist, system-ui';

export function formatMoney(value) {
  return `₹${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

export function getTaskChipColor(status) {
  if (status === 'completed') return '#10B981';
  if (status === 'in_progress') return '#0EA5E9';
  if (status === 'assigned') return '#6366F1';
  if (status === 'pending') return '#F59E0B';
  return '#9CA3AF';
}
