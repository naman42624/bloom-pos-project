import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';
import { Colors } from '../constants/theme';
import { formatDateTime, minutesSinceServerDate, minutesUntilShopDateTime, formatTimeString } from '../utils/datetime';
import {
  ORDER_TYPES,
  ORDER_STATUS_LABELS,
  TASK_STATUS_LABELS,
  DELIVERY_STATUS_COLORS,
  DELIVERY_STATUS_LABELS,
  FONT_FAMILY,
  formatMoney,
  getTaskChipColor,
} from '../constants/orderDisplay';

// ─────────────────────────────────────────────────────────────────────────
// Extracted verbatim from DashboardScreen.js (Task 9, order-lifecycle plan,
// 2026-09-01) — the owner/manager kanban board of delivery/pickup/walk-in
// orders. Pure extraction, no logic changes. The constants/helpers imported
// above from constants/orderDisplay.js are also used by code that stayed
// behind in DashboardScreen.js (the counter_staff branch, the deliveries
// widget, the my-tasks section, TaskDetailModal) — pulled into that shared
// leaf module (fix-round, 2026-09-01) instead of being duplicated here, so
// there's one source of truth and no import cycle (neither this file nor
// DashboardScreen.js imports the other; both import the leaf module).
// The constants below this comment ARE exclusive to this component (not
// used anywhere in DashboardScreen.js) and stay defined locally.
// ─────────────────────────────────────────────────────────────────────────

const ORDER_TYPE_LABELS = {
  delivery: 'Delivery Orders',
  pickup: 'Pickup Orders',
  walk_in: 'Walk-in Orders',
};

const ORDER_PHASE_LABELS = {
  pending: 'Pending',
  preparing: 'Preparing',
  ready: 'Ready',
};

const PICKUP_STATUS_COLORS = {
  waiting: '#F59E0B',
  ready_for_pickup: '#10B981',
  picked_up: '#6366F1',
};

const PICKUP_STATUS_LABELS = {
  waiting: 'Waiting',
  ready_for_pickup: 'Ready to Collect',
  picked_up: 'Picked Up',
};

const PAYMENT_STATUS_COLORS = {
  paid: '#10B981',
  partial: '#F59E0B',
  pending: '#E11D48',
  refunded: '#9CA3AF',
};

function formatOrderType(value) {
  return ORDER_TYPE_LABELS[value] || value || 'Order';
}

/**
 * Formats a date+time for display on order cards.
 * Handles both plain date strings (YYYY-MM-DD) and ISO datetime strings.
 * Returns e.g. "23 Apr, 3:40 PM" or "23 Apr" if no time.
 */
function formatCardDateTime(dateStr, timeStr, timezone) {
  try {
    // Build a clear local datetime from the date + time parts
    if (dateStr) {
      // If dateStr is a full ISO string, extract the local date using the shop timezone
      let localDate = dateStr;
      if (dateStr.includes('T') || dateStr.includes('Z') || dateStr.includes('+')) {
        const d = new Date(dateStr);
        if (!isNaN(d.getTime())) {
          localDate = d.toLocaleDateString('en-CA', { timeZone: timezone || 'Asia/Kolkata' });
        }
      }
      // Format the date part
      const [year, month, day] = localDate.split('-').map(Number);
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const datePart = `${day} ${months[month - 1]}`;

      if (!timeStr) return datePart;

      return `${datePart}, ${formatTimeString(timeStr)}`;
    }
  } catch {}
  return dateStr || '';
}

function getOrderStatusTone(status) {
  if (status === 'ready' || status === 'completed') return '#10B981';
  if (status === 'preparing') return '#0EA5E9';
  if (status === 'pending' || status === 'confirmed') return '#F59E0B';
  if (status === 'cancelled') return '#E11D48';
  return '#6B7280';
}

function normalizeOrderPhase(status) {
  if (status === 'confirmed') return 'pending';
  if (status === 'completed') return 'ready';
  return status;
}

function getLaneTheme(laneKey) {
  if (laneKey === 'pending') return { border: '#F59E0B66', background: '#FFFBEB', badge: '#B45309' };
  if (laneKey === 'preparing') return { border: '#0EA5E966', background: '#EFF6FF', badge: '#075985' };
  if (laneKey === 'in_transit') return { border: '#6366F166', background: '#EEF2FF', badge: '#4338CA' };
  return { border: '#10B98166', background: '#ECFDF5', badge: '#065F46' };
}

function getOrderLaneSla(order, timezone) {
  if (!order || ['ready', 'completed', 'cancelled', 'draft'].includes(order.status)) return null;

  if (order.order_type === 'walk_in') {
    const diffMins = minutesSinceServerDate(order.created_at, timezone);
    if (diffMins == null) return null;
    if (diffMins > 20) return 'overdue';
    if (diffMins > 10) return 'dueSoon';
    return null;
  }

  const schedDate = order.scheduled_date || null;
  const schedTime = order.scheduled_time || null;
  if (!schedDate || !schedTime) return null;

  const remainingMins = minutesUntilShopDateTime(schedDate, schedTime, timezone);
  if (remainingMins == null) return null;
  if (remainingMins < 0) return 'overdue';
  if (remainingMins <= 60) return 'dueSoon';
  return null;
}

function TaskPill({ task, onPress, loading }) {
  const color = getTaskChipColor(task.status);
  const isFinal = task.status === 'completed' || task.status === 'cancelled';

  return (
    <TouchableOpacity
      disabled={loading}
      onPress={onPress}
      style={[styles.taskPill, { borderColor: color + '40', backgroundColor: color + '12', opacity: loading ? 0.7 : 1 }]}
      activeOpacity={0.7}
    >
      <View style={[styles.taskPillDot, { backgroundColor: color }]} />
      <Text style={[styles.taskPillText, { color }]} numberOfLines={1}>
        {task.item_product_name || task.product_name || 'Task'}
      </Text>
      <Text style={[styles.taskPillStatus, { color }]}>{TASK_STATUS_LABELS[task.status] || task.status}</Text>
      {!isFinal && <Ionicons name="chevron-forward" size={13} color={color} />}
      {loading && <ActivityIndicator size="small" color={color} style={{ marginLeft: 4 }} />}
    </TouchableOpacity>
  );
}

function OrderCard({ order, tasks, hasPendingProduction, pulseOpacity, onTaskClick, taskActionLoading, onOpen, timezone, onQuickAction, quickActionLoading }) {
  const phaseStatus = normalizeOrderPhase(order.status);
  const statusTone = getOrderStatusTone(phaseStatus);
  const stats = {
    pending: tasks.filter((t) => t.status === 'pending').length,
    assigned: tasks.filter((t) => t.status === 'assigned').length,
    inProgress: tasks.filter((t) => t.status === 'in_progress').length,
    done: tasks.filter((t) => t.status === 'completed').length,
  };
  const totalTasks = tasks.length;

  // Delivery / pickup sub-status
  const pickupColor = order.pickup_status ? (PICKUP_STATUS_COLORS[order.pickup_status] || '#9CA3AF') : null;
  const pickupLabel = order.pickup_status ? (PICKUP_STATUS_LABELS[order.pickup_status] || order.pickup_status) : null;
  const delivStatus = order.delivery_status; // available if API includes it
  const delivColor = delivStatus ? (DELIVERY_STATUS_COLORS[delivStatus] || '#9CA3AF') : null;
  const delivLabel = delivStatus ? (DELIVERY_STATUS_LABELS[delivStatus] || delivStatus) : null;

  // Payment status
  const isCredit = order.is_credit_sale === 1;
  const payColor = isCredit ? '#8B5CF6' : (PAYMENT_STATUS_COLORS[order.payment_status] || '#9CA3AF');

  return (
    <TouchableOpacity
      style={[styles.orderCard, {
        borderColor: hasPendingProduction ? statusTone : '#E5E7EB',
        borderLeftColor: statusTone,
        borderLeftWidth: 3,
      }]}
      onPress={onOpen}
      activeOpacity={0.85}
    >
      {hasPendingProduction && (
        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFillObject,
            styles.pulseBorderOverlay,
            { opacity: pulseOpacity, borderColor: statusTone },
          ]}
        />
      )}

      <View style={styles.orderHeader}>
        <View style={{ flex: 1 }}>
          <Text style={styles.orderNumber}>#{order.sale_number}</Text>
          <Text style={styles.orderMeta}>{order.customer_name || 'Guest'}</Text>
          <Text style={styles.orderAmount}>{formatMoney(order.grand_total)}</Text>
        </View>
        <View style={{ alignItems: 'flex-end', gap: 4 }}>
          <View style={[styles.statusBadge, { backgroundColor: statusTone + '15', borderColor: statusTone }]}>
            <Text style={[styles.statusBadgeText, { color: statusTone }]}>
              {ORDER_PHASE_LABELS[phaseStatus] || ORDER_STATUS_LABELS[order.status] || order.status}
            </Text>
          </View>
          {/* Payment status badge */}
          {(isCredit || (order.payment_status && order.payment_status !== 'paid')) && (
            <View style={[styles.statusBadge, { backgroundColor: payColor + '15', borderColor: payColor }]}>
              <Text style={[styles.statusBadgeText, { color: payColor }]}>
                {isCredit ? 'CREDIT' :
                 order.payment_status === 'pending' ? 'PAY: UNPAID' :
                 order.payment_status === 'partial' ? 'PAY: PARTIAL' :
                 ('PAY: ' + (order.payment_status || '').toUpperCase())}
              </Text>
            </View>
          )}
        </View>
      </View>

      {/* Delivery sub-status */}
      {order.order_type === 'delivery' && delivLabel && (
        <View style={[styles.subStatusRow, { backgroundColor: delivColor + '10' }]}>
          <View style={[styles.subStatusDot, { backgroundColor: delivColor }]} />
          <Text style={[styles.subStatusText, { color: delivColor }]}>{delivLabel}</Text>
        </View>
      )}

      {/* Pickup sub-status */}
      {order.order_type === 'pickup' && pickupLabel && (
        <View style={[styles.subStatusRow, { backgroundColor: pickupColor + '10' }]}>
          <View style={[styles.subStatusDot, { backgroundColor: pickupColor }]} />
          <Text style={[styles.subStatusText, { color: pickupColor }]}>{pickupLabel}</Text>
        </View>
      )}

      {/* Created time — keep consistent across screens */}
      {order.created_at && (
        <View style={styles.scheduledRow}>
          <Ionicons name="time-outline" size={11} color="#9CA3AF" />
          <Text style={[styles.scheduledText, { color: '#9CA3AF' }]}>\
            Placed: {formatDateTime(order.created_at)}
          </Text>
        </View>
      )}

      {/* Scheduled date — delivery/pickup */}
      {order.scheduled_date && (
        <View style={styles.scheduledRow}>
          <Ionicons name="calendar-outline" size={11} color="#6366F1" />
          <Text style={styles.scheduledText}>
            Scheduled: {formatCardDateTime(order.scheduled_date, order.scheduled_time, timezone)}
          </Text>
        </View>
      )}

      {/* Inline one-tap stage-advance action (Task 10, order-lifecycle plan,
          2026-09-01) — only rendered when the server has already decided the
          next step is safe as a blind one-tap (server/utils/order-stage.js
          returns null whenever advancing needs a human decision, e.g. a
          payment collection or rider pick). */}
      {order.display_stage?.nextAction && (
        <TouchableOpacity
          style={[styles.laneQuickAction, quickActionLoading && styles.laneQuickActionDisabled]}
          onPress={(e) => { e.stopPropagation(); onQuickAction(order); }}
          disabled={!!quickActionLoading}
          activeOpacity={0.75}
        >
          {quickActionLoading ? (
            <ActivityIndicator size="small" color={Colors.primary} />
          ) : (
            <>
              <Ionicons name="arrow-forward-circle-outline" size={14} color={Colors.primary} />
              <Text style={styles.laneQuickActionText}>{order.display_stage.nextAction.label}</Text>
            </>
          )}
        </TouchableOpacity>
      )}

      {totalTasks > 0 ? (
        <>
          <View style={styles.pipelineRow}>
            <View style={[styles.pipelineStep, { opacity: stats.pending > 0 ? 1 : 0.4 }]}>
              <Text style={styles.pipelineStepLabel}>Q</Text>
              <Text style={styles.pipelineStepCount}>{stats.pending}</Text>
            </View>
            <View style={styles.pipelineConnector} />
            <View style={[styles.pipelineStep, { opacity: stats.assigned > 0 ? 1 : 0.4 }]}>
              <Text style={styles.pipelineStepLabel}>A</Text>
              <Text style={styles.pipelineStepCount}>{stats.assigned}</Text>
            </View>
            <View style={styles.pipelineConnector} />
            <View style={[styles.pipelineStep, { opacity: stats.inProgress > 0 ? 1 : 0.4 }]}>
              <Text style={styles.pipelineStepLabel}>IP</Text>
              <Text style={styles.pipelineStepCount}>{stats.inProgress}</Text>
            </View>
            <View style={styles.pipelineConnector} />
            <View style={[styles.pipelineStep, { opacity: stats.done > 0 ? 1 : 0.4 }]}>
              <Text style={styles.pipelineStepLabel}>D</Text>
              <Text style={styles.pipelineStepCount}>{stats.done}</Text>
            </View>
          </View>

          <View style={{ gap: 5 }}>
            {tasks.slice(0, 2).map((task) => (
              <TaskPill
                key={task.id}
                task={task}
                onPress={() => onTaskClick(task)}
                loading={!!taskActionLoading[task.id]}
              />
            ))}
            {tasks.length > 2 && (
              <Text style={styles.moreTasksLabel}>+{tasks.length - 2} more</Text>
            )}
          </View>
        </>
      ) : (
        <View style={styles.noTasksRow}>
          <Ionicons name="checkmark-done-outline" size={13} color={Colors.textLight} />
          <Text style={styles.noTasksLabel}>No production tasks</Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

/**
 * Owner/manager order kanban: delivery/pickup/walk-in orders grouped into
 * status lanes (pending/preparing/ready[/in_transit for delivery]).
 *
 * Pure presentational — takes the already-fetched `sales` array and
 * callbacks, does no data-fetching of its own. `tasksBySaleId` and
 * `taskActionLoading` are also passed in (rather than fetched here) because
 * production-task data is fetched and owned by the parent dashboard
 * alongside sales, and `taskActionLoading` is shared UI state also used by
 * TaskDetailModal (not part of this component) back in the parent.
 *
 * Extracted verbatim from DashboardScreen.js (Task 9, 2026-09-01) — no
 * rendering/logic changes, only: (1) direct `navigation`/`setSelectedOrderModal`
 * references replaced with the `onOrderPress`/`onNavigateToQueue` props,
 * (2) the task-pill click handler is now the `onTaskPress` prop instead of
 * a direct `setSelectedTaskModal` call, (3) `isDesktop` and the card
 * pulse-border animation (previously owned by DashboardScreen purely for
 * this board's benefit) are now computed/owned locally here instead of
 * being passed down, since nothing outside this board used them.
 */
export default function OrderKanbanBoard({
  sales,
  onOrderPress,
  onNavigateToQueue,
  tasksBySaleId,
  taskActionLoading,
  onTaskPress,
  timezone,
  onRefresh,
}) {
  const { width } = useWindowDimensions();
  // Same 1100px breakpoint DashboardScreen.js computes independently for its
  // own general layout — kept as two separate computations deliberately
  // (different purposes: layout there vs this board's preview-cap here), but
  // if this number ever changes, check that file too.
  const isDesktop = width >= 1100;
  const effectiveTimezone = timezone || 'Asia/Kolkata';

  const pulseAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1, duration: 1200, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 0, duration: 1200, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulseAnim]);

  const pulseOpacity = pulseAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.1, 0.6],
  });

  // Loading state for the inline quick-action button lives locally (it's a
  // pure UI concern of this board, unlike tasksBySaleId/taskActionLoading
  // which the parent dashboard owns because it's shared with TaskDetailModal
  // outside this component). Keyed by order id, same shape as the sibling
  // taskActionLoading prop.
  const [quickActionLoading, setQuickActionLoading] = useState({});

  const handleQuickAction = useCallback(async (order) => {
    const nextAction = order?.display_stage?.nextAction;
    if (!nextAction) return;
    setQuickActionLoading((prev) => ({ ...prev, [order.id]: true }));
    try {
      await api.advanceOrder(nextAction);
      if (onRefresh) await onRefresh();
    } catch (err) {
      // Matches DashboardScreen's advanceOrderStatus/advanceTaskStatus
      // convention — the backend's guard messages are already plain
      // language, pass them straight through.
      Alert.alert('Order Update', err?.message || 'Unable to update this order.');
    } finally {
      setQuickActionLoading((prev) => ({ ...prev, [order.id]: false }));
    }
  }, [onRefresh]);

  const ordersByTypeAndStatus = useMemo(() => {
    const base = {
      delivery: { pending: [], preparing: [], ready: [], in_transit: [], completed: [] },
      pickup: { pending: [], preparing: [], ready: [], completed: [] },
      walk_in: { pending: [], preparing: [], ready: [], completed: [] },
    };

    for (const order of sales) {
      if (!ORDER_TYPES.includes(order.order_type)) continue;
      if (order.status === 'cancelled' || order.status === 'draft') continue;

      // For delivery orders: route dispatched ones to in_transit bucket
      if (order.order_type === 'delivery') {
        // delivery_status may be a flat field or nested under order.delivery.status
        const delStatus = order.delivery_status ?? order.delivery?.status;
        const isDispatched = ['picked_up', 'in_transit'].includes(delStatus);
        if (isDispatched) {
          base.delivery.in_transit.push(order);
          continue;
        }
      }

      // Do not show completed orders for walkin, pickup, and delivery order types
      if (order.status === 'completed' && ['walk_in', 'pickup', 'delivery'].includes(order.order_type)) continue;

      const normalizedPhase = normalizeOrderPhase(order.status);
      const bucket = normalizedPhase === 'ready'
        ? 'ready'
        : normalizedPhase === 'preparing'
          ? 'preparing'
          : 'pending';

      base[order.order_type][bucket].push(order);
    }

    return base;
  }, [sales]);

  const renderStatusLane = (type, laneKey, laneLabel, orders) => {
    const previewCount = isDesktop ? 2 : 1;
    const previewOrders = orders.slice(0, previewCount);
    const hiddenCount = Math.max(orders.length - previewOrders.length, 0);
    const laneTheme = getLaneTheme(laneKey);
    const overdueCount = orders.filter((o) => getOrderLaneSla(o, effectiveTimezone) === 'overdue').length;
    const dueSoonCount = orders.filter((o) => getOrderLaneSla(o, effectiveTimezone) === 'dueSoon').length;
    const lifecycleHint = laneKey === 'pending' ? 'incl. confirmed' : laneKey === 'ready' ? 'incl. completed' : null;

    // Delivery sub-status summary for delivery lane
    let deliverySubHint = null;
    if (type === 'delivery' && orders.length > 0) {
      const assignedCount = orders.filter((o) => o.delivery_status === 'assigned').length;
      const inTransitCount = orders.filter((o) => o.delivery_status === 'in_transit').length;
      const failedCount = orders.filter((o) => o.delivery_status === 'failed').length;
      const parts = [];
      if (assignedCount > 0) parts.push(`${assignedCount} assigned`);
      if (inTransitCount > 0) parts.push(`${inTransitCount} in transit`);
      if (failedCount > 0) parts.push(`${failedCount} failed`);
      if (parts.length > 0) deliverySubHint = parts.join(' · ');
    }
    // Pickup sub-status summary
    let pickupSubHint = null;
    if (type === 'pickup' && orders.length > 0) {
      const readyCount = orders.filter((o) => o.pickup_status === 'ready_for_pickup').length;
      const waitingCount = orders.filter((o) => o.pickup_status === 'waiting').length;
      const parts = [];
      if (readyCount > 0) parts.push(`${readyCount} ready to collect`);
      if (waitingCount > 0) parts.push(`${waitingCount} waiting`);
      if (parts.length > 0) pickupSubHint = parts.join(' · ');
    }

    return (
      <TouchableOpacity
        key={`${type}-${laneKey}`}
        style={[styles.statusLaneContainer, { borderColor: laneTheme.border, backgroundColor: laneTheme.background }]}
        onPress={() => onNavigateToQueue(type, laneKey)}
        activeOpacity={0.82}
      >
        <View style={styles.laneTitleRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.laneTitle}>{laneLabel}</Text>
            <View style={styles.laneMetaRow}>
              <Text style={[styles.laneCount, { color: laneTheme.badge }]}>{orders.length} order{orders.length !== 1 ? 's' : ''}</Text>
              {!!lifecycleHint && <Text style={styles.laneHint}>• {lifecycleHint}</Text>}
            </View>
            {!!(deliverySubHint || pickupSubHint) && (
              <Text style={styles.laneSubHint}>{deliverySubHint || pickupSubHint}</Text>
            )}
          </View>
          <Ionicons name="chevron-forward" size={16} color={laneTheme.badge} />
        </View>

        {(overdueCount > 0 || dueSoonCount > 0) && (
          <View style={styles.laneBadgesRow}>
            {overdueCount > 0 && (
              <View style={styles.laneSlaDangerBadge}>
                <Ionicons name="alert-circle" size={11} color="#DC2626" />
                <Text style={styles.laneSlaDangerText}>{overdueCount} overdue</Text>
              </View>
            )}
            {dueSoonCount > 0 && (
              <View style={styles.laneSlaWarnBadge}>
                <Ionicons name="time" size={11} color="#B45309" />
                <Text style={styles.laneSlaWarnText}>{dueSoonCount} due soon</Text>
              </View>
            )}
          </View>
        )}

        {orders.length === 0 ? (
          <Text style={styles.laneEmpty}>No orders</Text>
        ) : (
          <View style={{ gap: 6 }}>
            {previewOrders.map((order) => {
              const orderTasks = (tasksBySaleId && tasksBySaleId.get(order.id)) || [];
              const hasPendingProduction = orderTasks.some((t) => ['pending', 'assigned', 'in_progress'].includes(t.status));
              return (
                <OrderCard
                  key={order.id}
                  order={order}
                  tasks={orderTasks}
                  hasPendingProduction={hasPendingProduction}
                  pulseOpacity={pulseOpacity}
                  taskActionLoading={taskActionLoading}
                  onTaskClick={(task) => onTaskPress(task)}
                  onOpen={() => onOrderPress(order)}
                  timezone={effectiveTimezone}
                  onQuickAction={handleQuickAction}
                  quickActionLoading={!!quickActionLoading[order.id]}
                />
              );
            })}
            {hiddenCount > 0 && (
              <View style={styles.viewMoreRow}>
                <Ionicons name="arrow-forward" size={14} color="#047857" />
                <Text style={styles.viewMoreText}>View {hiddenCount} more</Text>
              </View>
            )}
          </View>
        )}
      </TouchableOpacity>
    );
  };

  const renderOrderTypeSection = (type) => {
    const groups = ordersByTypeAndStatus[type] || { pending: [], preparing: [], ready: [], in_transit: [], completed: [] };

    // Build lanes — delivery gets 4 lanes including In Transit
    const lanes = type === 'delivery'
      ? [
          { key: 'pending',    label: 'Pending',            rows: groups.pending },
          { key: 'preparing',  label: 'Preparing',          rows: groups.preparing },
          { key: 'ready',      label: 'Ready to Dispatch',  rows: groups.ready },
          { key: 'in_transit', label: 'In Transit',         rows: groups.in_transit || [] },
        ]
      : [
          { key: 'pending',   label: 'Pending',   rows: groups.pending },
          { key: 'preparing', label: 'Preparing', rows: groups.preparing },
          { key: 'ready',     label: 'Ready',     rows: groups.ready },
        ];

    const totalOrders = lanes.reduce((sum, lane) => sum + lane.rows.length, 0);

    const typeTheme = type === 'delivery'
      ? { bg: '#F8FAFC', border: '#BFDBFE', icon: '#2563EB' }
      : type === 'pickup'
        ? { bg: '#F0FDF4', border: '#BBF7D0', icon: '#047857' }
        : { bg: '#FFF7ED', border: '#FED7AA', icon: '#C2410C' };

    return (
      <View key={type} style={[styles.typeCard, { backgroundColor: typeTheme.bg, borderColor: typeTheme.border }]}>
        <View style={styles.typeCardHeader}>
          <View>
            <Text style={styles.typeCardTitle}>{formatOrderType(type)}</Text>
            <Text style={styles.typeCardSubtitle}>{totalOrders} active order{totalOrders !== 1 ? 's' : ''}</Text>
          </View>
          <Ionicons name={type === 'delivery' ? 'bicycle' : type === 'pickup' ? 'bag-handle' : 'storefront'} size={22} color={typeTheme.icon} />
        </View>

        <View style={{ gap: 8 }}>
          {lanes.map((lane) => renderStatusLane(type, lane.key, lane.label, lane.rows))}
        </View>
      </View>
    );
  };

  return <>{ORDER_TYPES.map(renderOrderTypeSection)}</>;
}

const styles = StyleSheet.create({
  typeCard: {
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07,
    shadowRadius: 8,
    elevation: 3,
  },
  typeCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 9,
  },
  typeCardTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: Colors.text,
    fontFamily: FONT_FAMILY,
  },
  typeCardSubtitle: {
    fontSize: 12,
    color: Colors.textSecondary,
    marginTop: 3,
    fontFamily: FONT_FAMILY,
  },

  statusLaneContainer: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 6,
  },
  laneTitleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  laneTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#374151',
    fontFamily: FONT_FAMILY,
  },
  laneCount: {
    fontSize: 11,
    fontWeight: '800',
    fontFamily: FONT_FAMILY,
  },
  laneMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 2,
  },
  laneHint: {
    fontSize: 10,
    color: '#64748B',
    fontFamily: FONT_FAMILY,
    fontWeight: '600',
  },
  laneBadgesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  laneSlaDangerBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: '#FEE2E2',
    borderWidth: 1,
    borderColor: '#FCA5A5',
  },
  laneSlaDangerText: {
    color: '#B91C1C',
    fontSize: 10,
    fontWeight: '700',
    fontFamily: FONT_FAMILY,
  },
  laneSlaWarnBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: '#FEF3C7',
    borderWidth: 1,
    borderColor: '#FCD34D',
  },
  laneSlaWarnText: {
    color: '#92400E',
    fontSize: 10,
    fontWeight: '700',
    fontFamily: FONT_FAMILY,
  },
  laneEmpty: {
    fontSize: 12,
    color: Colors.textLight,
    fontStyle: 'italic',
    fontFamily: FONT_FAMILY,
  },

  orderCard: {
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 9,
    paddingVertical: 7,
    backgroundColor: '#fff',
    position: 'relative',
    overflow: 'hidden',
  },
  pulseBorderOverlay: {
    borderRadius: 10,
    borderWidth: 2,
  },

  orderHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 8,
    marginBottom: 6,
  },
  orderNumber: {
    fontSize: 13,
    color: Colors.text,
    fontWeight: '800',
    fontFamily: FONT_FAMILY,
  },
  orderMeta: {
    fontSize: 11,
    color: Colors.textSecondary,
    marginTop: 2,
    fontFamily: FONT_FAMILY,
  },
  orderAmount: {
    fontSize: 12,
    color: Colors.secondary,
    fontWeight: '700',
    marginTop: 2,
    fontFamily: FONT_FAMILY,
  },

  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
  },
  statusBadgeText: {
    fontSize: 10,
    fontWeight: '800',
    fontFamily: FONT_FAMILY,
  },

  pipelineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginVertical: 5,
  },
  pipelineStep: {
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 6,
    width: 32,
    height: 32,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#F9FAFB',
  },
  pipelineStepLabel: {
    fontSize: 9,
    color: Colors.textSecondary,
    fontWeight: '700',
    fontFamily: FONT_FAMILY,
  },
  pipelineStepCount: {
    fontSize: 10,
    color: Colors.text,
    fontWeight: '800',
    fontFamily: FONT_FAMILY,
  },
  pipelineConnector: {
    flex: 1,
    height: 1,
    backgroundColor: '#D1D5DB',
  },

  taskPill: {
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  taskPillDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  taskPillText: {
    fontSize: 11,
    fontWeight: '700',
    flex: 1,
    fontFamily: FONT_FAMILY,
  },
  taskPillStatus: {
    fontSize: 9,
    fontWeight: '800',
    fontFamily: FONT_FAMILY,
  },
  moreTasksLabel: {
    fontSize: 11,
    color: Colors.textLight,
    fontFamily: FONT_FAMILY,
    fontStyle: 'italic',
  },
  noTasksRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 4,
  },
  noTasksLabel: {
    fontSize: 11,
    color: Colors.textLight,
    fontStyle: 'italic',
    fontFamily: FONT_FAMILY,
  },
  subStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
    alignSelf: 'flex-start',
    marginBottom: 4,
  },
  subStatusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  subStatusText: {
    fontSize: 10,
    fontWeight: '700',
    fontFamily: FONT_FAMILY,
  },
  scheduledRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 4,
  },
  scheduledText: {
    fontSize: 10,
    color: '#6366F1',
    fontWeight: '600',
    fontFamily: FONT_FAMILY,
  },
  laneQuickAction: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: 8,
    backgroundColor: Colors.primary + '15',
    marginBottom: 6,
  },
  laneQuickActionDisabled: {
    opacity: 0.6,
  },
  laneQuickActionText: {
    fontSize: 12,
    fontWeight: '700',
    color: Colors.primary,
    fontFamily: FONT_FAMILY,
  },
  laneSubHint: {
    fontSize: 10,
    color: '#64748B',
    fontFamily: FONT_FAMILY,
    fontWeight: '600',
    marginTop: 1,
  },

  viewMoreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
  },
  viewMoreText: {
    fontSize: 11,
    color: Colors.secondary,
    fontWeight: '700',
    fontFamily: FONT_FAMILY,
  },
});
