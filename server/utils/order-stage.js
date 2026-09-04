// server/utils/order-stage.js
//
// Computes a single, order-type-aware "stage" for display, replacing the
// need for every screen to independently interpret sale.status +
// payment_status + pickup_status + delivery_status. ALWAYS computed fresh
// from the sale object passed in — never store this anywhere. See
// docs/superpowers/specs/2026-09-01-order-lifecycle-delivery-management-design.md §3.

const STAGE_COLORS = {
  new: '#FF9800',
  preparing: '#2196F3',
  ready: '#4CAF50',
  ready_for_pickup: '#4CAF50',
  out_for_delivery: '#00BCD4',
  delivered: '#4CAF50',
  picked_up: '#4CAF50',
  completed: '#9E9E9E',
  cancelled: '#F44336',
};

// ── Who is actually allowed to call each endpoint a nextAction can point at ──
//
// A nextAction is a one-tap button the frontend renders blind. If we hand a
// role an action its endpoint will 403, the staff member taps it and gets a
// dead end — so every nextAction below is gated on the endpoint's REAL
// authorize() list, mirrored here. These lists are copied verbatim from the
// route definitions; if you change an authorize() call there, change it here
// too, or the button reappears for a role that can't use it.
//
//   SALE_STATUS      -> PUT /api/sales/:id/status
//                       server/routes/sales.js  (router.put('/:id/status', ...))
//   PICKUP_PICKED_UP -> PUT /api/deliveries/pickup/:saleId/picked-up
//                       server/routes/deliveries.js
//   DELIVERY_PICKUP  -> PUT /api/deliveries/:id/pickup
//                       server/routes/deliveries.js — NOT the same route as
//                       PICKUP_PICKED_UP above despite the similar name: this
//                       is the delivery PARTNER picking the order up from the
//                       shop (order_type='delivery'), the other is a
//                       CUSTOMER picking up in-store (order_type='pickup').
//   DELIVERY_DELIVER -> PUT /api/deliveries/:id/deliver
//                       server/routes/deliveries.js
//
// Note 'customer' appears in none of them — a customer viewing their own order
// therefore never receives a nextAction, which falls out of these lists rather
// than needing its own special case.
const ENDPOINT_ROLES = {
  SALE_STATUS: ['owner', 'manager', 'employee', 'counter_staff'],
  PICKUP_PICKED_UP: ['owner', 'manager', 'employee', 'counter_staff'],
  DELIVERY_PICKUP: ['delivery_partner', 'owner', 'manager'],
  DELIVERY_DELIVER: ['delivery_partner', 'owner', 'manager'],
};

// Fail closed: an unknown/missing viewer role gets no one-tap action. Callers
// must pass req.user.role explicitly (both call sites in routes/sales.js do).
// `extraRoles` is the pref_counter_marks_pickup/pref_counter_marks_delivered
// mechanism (see getStageFlags below): DELIVERY_PICKUP/DELIVERY_DELIVER's base
// list mirrors the route's authorize() call verbatim and must stay that way,
// so the owner-toggleable widening is layered on here instead of mutating it.
function actionFor(endpointKey, viewerRole, action, extraRoles) {
  if (!viewerRole) return null;
  const allowed = extraRoles && extraRoles.length
    ? [...ENDPOINT_ROLES[endpointKey], ...extraRoles]
    : ENDPOINT_ROLES[endpointKey];
  return allowed.includes(viewerRole) ? action : null;
}

// Reads the two counter_staff delivery-action preferences once per request
// (never per-row — settings are global, not per-sale) and hands back the
// extraRoles arrays actionFor() expects. Async pg.Pool db only — all three
// callers of computeOrderStage() already use getAsyncDb() for everything
// else on these routes.
async function getStageFlags(db) {
  const rows = await db.prepare(
    "SELECT key, value FROM settings WHERE key IN ('pref_counter_marks_pickup', 'pref_counter_marks_delivered')"
  ).all();
  const map = Object.fromEntries((rows || []).map((r) => [r.key, r.value]));
  return {
    counterCanMarkPickedUp: map.pref_counter_marks_pickup === '1' ? ['counter_staff'] : [],
    counterCanMarkDelivered: map.pref_counter_marks_delivered === '1' ? ['counter_staff'] : [],
  };
}

// viewerRole — the role of the user this stage is being rendered for. Only
// affects nextAction (the one-tap button); key/label/color are role-neutral.
// flags — from getStageFlags() above, default {} so the two existing callers
// that haven't been touched to fetch it yet still work (both delivery
// extraRoles arrays are then simply empty, i.e. no widening — the same
// behavior as before this parameter existed).
function computeOrderStage(sale, viewerRole, flags = {}) {
  if (sale.status === 'cancelled') {
    return { key: 'cancelled', label: 'Cancelled', color: STAGE_COLORS.cancelled, nextAction: null };
  }

  // 'confirmed' is a real first-class status (sales CHECK constraint; written
  // by PUT /deliveries/:id/reattempt; counted as new work by production.js).
  // It is pending-equivalent everywhere else in the app (OrderKanbanBoard
  // buckets confirmed into the same lane as pending), so every ladder below
  // treats it exactly like pending. Keeping this check FIRST in the delivery
  // ladder also means a reattempted delivery (sale 'confirmed' + delivery
  // 'assigned') short-circuits here instead of falling into the
  // out_for_delivery branch and offering "Mark Delivered" for an order that's
  // still sitting in the shop.
  const isNew = sale.status === 'pending' || sale.status === 'confirmed';
  const startPreparing = {
    label: 'Start Preparing',
    endpoint: `/sales/${sale.id}/status`,
    method: 'PUT',
    body: { status: 'preparing' },
  };
  const markReady = {
    label: 'Mark Ready',
    endpoint: `/sales/${sale.id}/status`,
    method: 'PUT',
    body: { status: 'ready' },
  };

  // ── Mirrors PUT /api/sales/:id/status's production-task guard ──
  // server/routes/sales.js, "Enforce production task completion before
  // marking 'ready'". Transcribed, not paraphrased:
  //
  //   SELECT COUNT(*) as cnt FROM production_tasks
  //    WHERE sale_id = ? AND status NOT IN ('completed', 'cancelled')
  //   -> cnt > 0 returns 400 "Cannot mark as ready — N production task(s)
  //      still pending."
  //
  // Without this, all three `preparing` rungs below handed staff a Mark Ready
  // button the endpoint was guaranteed to reject — 22 live orders were in that
  // state when this was found (2026-09-02). Same class of defect, and the same
  // fix, as the 'ready' rung's balanceDue/deliveryPending checks further down:
  // this file's header rule is that a nextAction must clear the endpoint's
  // authorize() list AND its preconditions, not just the former.
  //
  // `open_task_count` is that exact COUNT, attached by all THREE callers of
  // this function — sales.js's list route as a correlated subquery, sales.js's
  // detail route folded out of its own per-status task histogram, and
  // deliveries.js's GET / as the same correlated subquery, all with the
  // identical NOT IN predicate. The third caller already existed when this
  // field was introduced and was missed, so GET /deliveries kept emitting the
  // dead-end Mark Ready this gate removes (fixed 2026-09-03). If you add a
  // fourth caller, give it that field too.
  //
  // Number() is not optional: pg returns COUNT as a STRING ("2"), the same
  // trap active_delivery_count hit in Task 14.
  //
  // A missing field counts as "not blocking", deliberately matching the
  // balanceDue / deliveryPending idiom below rather than this file's
  // fail-closed rule for viewerRole. Fail-closed on absent data would silently
  // delete a working button from a whole surface if a future caller forgot the
  // field, which is harder to notice than the loud 400 this fix removes.
  const openTaskCount = sale.open_task_count != null ? Number(sale.open_task_count) : 0;
  const tasksUnfinished = openTaskCount > 0;
  // Resolved ONCE and reused by all three `preparing` rungs below. The rungs
  // stay written out per ladder like the rest of this file, but the gate has a
  // single home — applying it to two ladders and forgetting the third is
  // precisely how the original bug shipped.
  const markReadyAction = tasksUnfinished ? null : actionFor('SALE_STATUS', viewerRole, markReady);

  if (sale.order_type === 'pickup') {
    if (isNew) {
      return { key: 'new', label: 'New', color: STAGE_COLORS.new, nextAction: actionFor('SALE_STATUS', viewerRole, startPreparing) };
    }
    if (sale.status === 'preparing') {
      return { key: 'preparing', label: 'Preparing', color: STAGE_COLORS.preparing, nextAction: markReadyAction };
    }
    if (sale.status === 'ready' || sale.pickup_status === 'ready_for_pickup') {
      const balanceDue = sale.grand_total != null && sale.total_paid != null ? Number(sale.grand_total) - Number(sale.total_paid) > 0.01 : false;
      return {
        key: 'ready_for_pickup',
        label: 'Ready for Pickup',
        color: STAGE_COLORS.ready_for_pickup,
        nextAction: (balanceDue && !sale.is_credit_sale)
          ? null // needs payment collection — route to the real screen, not a one-tap action
          : actionFor('PICKUP_PICKED_UP', viewerRole, { label: 'Confirm Pickup', endpoint: `/deliveries/pickup/${sale.id}/picked-up`, method: 'PUT', body: {} }),
      };
    }
    if (sale.status === 'completed' || sale.pickup_status === 'picked_up') {
      return { key: 'picked_up', label: 'Picked Up', color: STAGE_COLORS.picked_up, nextAction: null };
    }
  }

  if (sale.order_type === 'delivery') {
    if (isNew) {
      return { key: 'new', label: 'New', color: STAGE_COLORS.new, nextAction: actionFor('SALE_STATUS', viewerRole, startPreparing) };
    }
    if (sale.status === 'preparing') {
      return { key: 'preparing', label: 'Preparing', color: STAGE_COLORS.preparing, nextAction: markReadyAction };
    }
    if (sale.status === 'ready' && !['picked_up', 'in_transit', 'delivered'].includes(sale.delivery_status)) {
      // A rider already assigned (delivery_status === 'assigned') is a real,
      // one-tap-able next step — PUT /deliveries/:id/pickup, the shop handing
      // the order to whoever is taking it out. Previously this whole branch
      // returned nextAction: null unconditionally, on the theory that
      // "assigning a rider needs the picker" — true for the NO-rider-yet case
      // below, but that reasoning doesn't apply once a rider is already
      // attached: nothing here needs a human decision, and the null left
      // counter staff and even owner/manager stuck on a status line
      // ("<rider> has it", see OrderCard's resolveDeadEnd) with no action
      // until the rider or a manager acted from DeliveryDetailScreen (found
      // live, 2026-09-04 — this is also the "delivery-ladder reorder" item
      // CLAUDE.md already flagged as deferred debt).
      if (sale.delivery_status === 'assigned') {
        return {
          key: 'ready',
          label: 'Ready',
          color: STAGE_COLORS.ready,
          nextAction: actionFor(
            'DELIVERY_PICKUP', viewerRole,
            { label: 'Mark Picked Up', endpoint: `/deliveries/${sale.delivery_id}/pickup`, method: 'PUT', body: {} },
            flags.counterCanMarkPickedUp
          ),
        };
      }
      return { key: 'ready', label: 'Ready', color: STAGE_COLORS.ready, nextAction: null }; // no rider yet — assigning needs the picker, no one-tap here
    }
    if (['assigned', 'picked_up', 'in_transit'].includes(sale.delivery_status)) {
      // COD outstanding no longer blanks this to null for everyone — PUT
      // /deliveries/:id/deliver has never hard-required cod_collected to
      // equal cod_amount (it records whatever is passed, or nothing), so the
      // block was a stage-layer decision, not a server safety requirement.
      // The frontend (OrderCard's resolveDeliverStep) now checks cod_amount/
      // cod_collected itself and prompts for the amount inline before firing
      // when it's genuinely outstanding, instead of the button not existing
      // at all — the same "route to a screen vs. ask a quick question inline"
      // upgrade Task 15 already gave Start Preparing.
      return {
        key: 'out_for_delivery',
        label: 'Out for Delivery',
        color: STAGE_COLORS.out_for_delivery,
        nextAction: actionFor(
          'DELIVERY_DELIVER', viewerRole,
          { label: 'Mark Delivered', endpoint: `/deliveries/${sale.delivery_id}/deliver`, method: 'PUT', body: {} },
          flags.counterCanMarkDelivered
        ),
      };
    }
    if (sale.delivery_status === 'delivered' || sale.status === 'completed') {
      return { key: 'delivered', label: 'Delivered', color: STAGE_COLORS.delivered, nextAction: null };
    }
  }

  // walk_in and pre_order share the same simple ladder
  if (isNew) {
    return { key: 'new', label: 'New', color: STAGE_COLORS.new, nextAction: actionFor('SALE_STATUS', viewerRole, startPreparing) };
  }
  if (sale.status === 'preparing') {
    return { key: 'preparing', label: 'Preparing', color: STAGE_COLORS.preparing, nextAction: markReadyAction };
  }
  if (sale.status === 'ready') {
    // ── Mirrors PUT /api/sales/:id/status's two completion guards ──
    // server/routes/sales.js, "Enforce delivery completion before marking
    // order 'completed'" and "Enforce payment before marking a non-delivery
    // order 'completed'". Those guards were re-keyed 2026-09-02 off order_type
    // and onto "has a delivery row" / "is not a delivery", so they now fire on
    // walk_in and pre_order too — which is exactly this ladder. Without these
    // two checks the 'Complete' button below is handed to staff for orders the
    // endpoint is guaranteed to 400: the dead-end this file's header exists to
    // prevent. Same idiom as the pickup ladder's balance check above.
    // If you change a guard there, change this branch too, and vice versa.
    const balanceDue = sale.grand_total != null && sale.total_paid != null ? Number(sale.grand_total) - Number(sale.total_paid) > 0.01 : false;
    // delivery_status is only populated when a deliveries row actually exists
    // (LEFT JOIN on the list route, sale.delivery?.status on the detail route),
    // so a falsy value means "no delivery attached" — nothing to block on.
    const deliveryPending = !!sale.delivery_status && !['delivered', 'cancelled'].includes(sale.delivery_status);
    return {
      key: 'ready',
      label: 'Ready',
      color: STAGE_COLORS.ready,
      nextAction: (deliveryPending || (balanceDue && !sale.is_credit_sale))
        ? null // the endpoint would reject this — send staff to the real screen, not a one-tap dead end
        : actionFor('SALE_STATUS', viewerRole, { label: 'Complete', endpoint: `/sales/${sale.id}/status`, method: 'PUT', body: { status: 'completed' } }),
    };
  }
  return { key: 'completed', label: 'Completed', color: STAGE_COLORS.completed, nextAction: null };
}

module.exports = { computeOrderStage, getStageFlags };
