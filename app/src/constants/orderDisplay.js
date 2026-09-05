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

// Plain-language names for the roles that can hold a production task, used as
// the subtitle in every "who does this?" staff picker when the account has no
// job_title set — which, on live data, is all of them.
//
// It exists because GET /production/assignable-staff returns `role` as a raw
// database token, and nobody at the counter should ever be shown
// `florist_staff`. Shared rather than declared per-screen so the dashboard
// picker and SaleDetailScreen's task-assign modal cannot end up calling the
// same person two different things.
//
// Wording matches UserFormScreen's own ROLE_LABELS, with one intentional
// difference: `employee` is "Staff", not "Employee (legacy)". The "(legacy)"
// qualifier is meaningful to an owner administering accounts and is pure
// confusion to someone picking who makes a bouquet.
export const STAFF_ROLE_LABELS = {
  owner: 'Owner',
  manager: 'Manager',
  counter_staff: 'Counter Staff',
  florist_staff: 'Florist/Prep Staff',
  employee: 'Staff',
};

// The subset of the above that the dashboard's "who is making this?" picker
// shows — the narrowest of the three tiers tabulated under
// ASSIGNABLE_STAFF_ROLES below; read them together rather than in isolation.
//
// GET /production/assignable-staff returns everyone the assign endpoint
// accepts (counter staff, managers and the owner included) and deliberately
// does NOT pre-filter: two screens call it wanting different subsets, so it
// returns `role` on every row and each narrows for itself. This one narrows to
// the people who actually make the bouquets, so a picker read at counter speed
// is not padded with names that are never the answer. Counter staff CAN hold a
// task — SaleDetailScreen offers them — they just are not the ones making it.
export const PREP_ROLES = ['employee', 'florist_staff'];

// The roles SaleDetailScreen's task-assign modal offers. Three tiers exist and
// they are deliberately different sizes, so read them together:
//
//   server accepts        owner, manager, employee, counter_staff, florist_staff
//   offered on SaleDetail        employee, counter_staff, florist_staff   <- this
//   offered on Dashboard         employee, florist_staff                  <- PREP_ROLES
//
// This tier is exactly the three roles GET /auth/staff-roster returned before
// Task 17 — the set this screen has always offered — with the `employee_code`
// filter that was silently dropping the real prep staff removed, and nothing
// else changed. Manager and owner ARE assignable server-side, and are left out
// on purpose: making the owner assignable is a product decision nobody has
// asked for, and every name that is not the answer costs something in a list
// read at counter speed. Widening this is a deliberate change, not a cleanup.
export const ASSIGNABLE_STAFF_ROLES = ['employee', 'counter_staff', 'florist_staff'];

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
