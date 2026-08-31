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

function computeOrderStage(sale) {
  if (sale.status === 'cancelled') {
    return { key: 'cancelled', label: 'Cancelled', color: STAGE_COLORS.cancelled, nextAction: null };
  }

  if (sale.order_type === 'pickup') {
    if (sale.status === 'pending') {
      return { key: 'new', label: 'New', color: STAGE_COLORS.new, nextAction: { label: 'Start Preparing', endpoint: `/sales/${sale.id}/status`, method: 'PUT', body: { status: 'preparing' } } };
    }
    if (sale.status === 'preparing') {
      return { key: 'preparing', label: 'Preparing', color: STAGE_COLORS.preparing, nextAction: { label: 'Mark Ready', endpoint: `/sales/${sale.id}/status`, method: 'PUT', body: { status: 'ready' } } };
    }
    if (sale.status === 'ready' || sale.pickup_status === 'ready_for_pickup') {
      const balanceDue = sale.grand_total != null && sale.total_paid != null ? Number(sale.grand_total) - Number(sale.total_paid) > 0.01 : false;
      return {
        key: 'ready_for_pickup',
        label: 'Ready for Pickup',
        color: STAGE_COLORS.ready_for_pickup,
        nextAction: (balanceDue && !sale.is_credit_sale)
          ? null // needs payment collection — route to the real screen, not a one-tap action
          : { label: 'Confirm Pickup', endpoint: `/deliveries/pickup/${sale.id}/picked-up`, method: 'PUT', body: {} },
      };
    }
    if (sale.status === 'completed' || sale.pickup_status === 'picked_up') {
      return { key: 'picked_up', label: 'Picked Up', color: STAGE_COLORS.picked_up, nextAction: null };
    }
  }

  if (sale.order_type === 'delivery') {
    if (sale.status === 'pending') {
      return { key: 'new', label: 'New', color: STAGE_COLORS.new, nextAction: { label: 'Start Preparing', endpoint: `/sales/${sale.id}/status`, method: 'PUT', body: { status: 'preparing' } } };
    }
    if (sale.status === 'preparing') {
      return { key: 'preparing', label: 'Preparing', color: STAGE_COLORS.preparing, nextAction: { label: 'Mark Ready', endpoint: `/sales/${sale.id}/status`, method: 'PUT', body: { status: 'ready' } } };
    }
    if (sale.status === 'ready' && !['picked_up', 'in_transit', 'delivered'].includes(sale.delivery_status)) {
      return { key: 'ready', label: 'Ready', color: STAGE_COLORS.ready, nextAction: null }; // assigning a rider needs the picker — no one-tap here
    }
    if (['assigned', 'picked_up', 'in_transit'].includes(sale.delivery_status)) {
      const codOutstanding = Number(sale.cod_amount || 0) > Number(sale.cod_collected || 0);
      return {
        key: 'out_for_delivery',
        label: 'Out for Delivery',
        color: STAGE_COLORS.out_for_delivery,
        nextAction: codOutstanding ? null : { label: 'Mark Delivered', endpoint: `/deliveries/${sale.delivery_id}/deliver`, method: 'PUT', body: {} },
      };
    }
    if (sale.delivery_status === 'delivered' || sale.status === 'completed') {
      return { key: 'delivered', label: 'Delivered', color: STAGE_COLORS.delivered, nextAction: null };
    }
  }

  // walk_in and pre_order share the same simple ladder
  if (sale.status === 'pending') {
    return { key: 'new', label: 'New', color: STAGE_COLORS.new, nextAction: { label: 'Start Preparing', endpoint: `/sales/${sale.id}/status`, method: 'PUT', body: { status: 'preparing' } } };
  }
  if (sale.status === 'preparing') {
    return { key: 'preparing', label: 'Preparing', color: STAGE_COLORS.preparing, nextAction: { label: 'Mark Ready', endpoint: `/sales/${sale.id}/status`, method: 'PUT', body: { status: 'ready' } } };
  }
  if (sale.status === 'ready') {
    return { key: 'ready', label: 'Ready', color: STAGE_COLORS.ready, nextAction: { label: 'Complete', endpoint: `/sales/${sale.id}/status`, method: 'PUT', body: { status: 'completed' } } };
  }
  return { key: 'completed', label: 'Completed', color: STAGE_COLORS.completed, nextAction: null };
}

module.exports = { computeOrderStage };
