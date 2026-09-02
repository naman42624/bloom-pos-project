import React from 'react';
import { ActivityIndicator, Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '../../constants/theme';
import { FONT_FAMILY, formatMoney } from '../../constants/orderDisplay';
import { TYPE_ICONS } from '../../constants/orderStages';
import { formatCardDateTime, minutesSinceServerDate, minutesUntilShopDateTime } from '../../utils/datetime';
import StageBadge from '../StageBadge';

/**
 * What to offer when the server says there is no safe one-tap action.
 *
 * `display_stage.nextAction === null` means "advancing needs a human decision"
 * — not "nothing can be done". Rendering nothing leaves the staff member at a
 * wall, which is the same failure class as a technical error message and fails
 * staff-ux-checklist items #2 and #6. So every null resolves to either a
 * routing button or an explicit status line.
 *
 * Returns one of:
 *   { type: 'route', kind, label }  — render a secondary button
 *   { type: 'status', text }        — render a plain status line, no button
 *   null                            — genuinely nothing to show (terminal stage)
 *
 * See docs/superpowers/specs/2026-09-01-dashboard-stage-ui-redesign-design.md §7.
 */
function resolveDeadEnd(order) {
  const stageKey = order.display_stage?.key;

  // 'ready' and 'ready_for_pickup' share one branch, and it keys on the DATA
  // (is there an open delivery? is money owed?) rather than on order_type.
  // Keying this on order_type was the original bug in this plan and the exact
  // bug Task 1 fixed in the backend guards: a pre_order fulfilled by delivery
  // is not order_type 'delivery', and gating on that would drop it straight
  // through into a card with no action at all.
  if (stageKey === 'ready' || stageKey === 'ready_for_pickup') {
    const hasOpenDelivery = order.delivery_id != null
      && !['delivered', 'cancelled'].includes(order.delivery_status);
    if (hasOpenDelivery) {
      if (!order.delivery_partner_name) {
        return { type: 'route', kind: 'assign_rider', label: 'Assign Rider' };
      }
      return { type: 'status', text: `${order.delivery_partner_name} has it` };
    }
    const due = Number(order.grand_total || 0) - Number(order.total_paid || 0);
    if (due > 0.01 && !order.is_credit_sale) {
      return { type: 'route', kind: 'collect_payment', label: `Collect ${formatMoney(due)}` };
    }
    return null;
  }

  if (stageKey === 'out_for_delivery') {
    const codOutstanding = Number(order.cod_amount || 0) > Number(order.cod_collected || 0);
    if (codOutstanding) {
      return { type: 'route', kind: 'record_cod', label: 'Record COD' };
    }
    // Marking a delivery delivered is not counter staff's action —
    // ENDPOINT_ROLES.DELIVERY_DELIVER in server/utils/order-stage.js omits
    // counter_staff deliberately, so offering a button would hand them a 403.
    // They still need to know who has it (customers ring up asking), so this
    // renders as status, not as a control. staff-ux-checklist #8.
    if (order.delivery_partner_name) {
      return { type: 'status', text: `${order.delivery_partner_name} has it` };
    }
    return { type: 'status', text: 'Out with a rider' };
  }

  return null;
}

/**
 * Reuses the SLA thresholds the previous board already used (walk-in: 20 min
 * overdue / 10 min due-soon from creation; everything else: against the
 * scheduled slot). Previously computed only as a lane-level count; now shown
 * per card, which is where it actually helps someone decide what to do next.
 */
function getOrderSla(order, timezone) {
  if (!order || ['ready', 'completed', 'cancelled', 'draft'].includes(order.status)) return null;
  if (order.order_type === 'walk_in') {
    const mins = minutesSinceServerDate(order.created_at, timezone);
    if (mins == null) return null;
    if (mins > 20) return { level: 'late', text: `${mins} min waiting` };
    if (mins > 10) return { level: 'soon', text: `${mins} min waiting` };
    return null;
  }
  if (!order.scheduled_date || !order.scheduled_time) return null;
  const remaining = minutesUntilShopDateTime(order.scheduled_date, order.scheduled_time, timezone);
  if (remaining == null) return null;
  if (remaining < 0) return { level: 'late', text: `${Math.abs(remaining)} min late` };
  if (remaining <= 60) return { level: 'soon', text: `Due in ${remaining} min` };
  return null;
}

/** Plain language, no PAY: prefix. Null when there is nothing worth saying. */
function getPaymentWarning(order) {
  if (order.is_credit_sale === 1) return { level: 'soon', text: 'Credit' };
  if (order.payment_status === 'pending') return { level: 'late', text: 'Unpaid' };
  if (order.payment_status === 'partial') return { level: 'soon', text: 'Part paid' };
  return null;
}

/** Only when tasks exist AND are not all done. */
function getTaskProgress(tasks) {
  const list = tasks || [];
  if (list.length === 0) return null;
  const done = list.filter((t) => t.status === 'completed' || t.status === 'cancelled').length;
  if (done === list.length) return null;
  return `${done} of ${list.length} tasks`;
}

export default function OrderCard({
  order,
  tasks,
  timezone,
  quickActionLoading,
  onOpen,
  onQuickAction,
  onResolve,
}) {
  const sla = getOrderSla(order, timezone);
  const payment = getPaymentWarning(order);
  const taskProgress = getTaskProgress(tasks);
  const nextAction = order.display_stage?.nextAction;
  const deadEnd = nextAction ? null : resolveDeadEnd(order);
  const contactPhone = order.customer_phone || order.receiver_phone;
  const showSchedule = order.scheduled_date && order.order_type !== 'walk_in';

  return (
    <TouchableOpacity style={styles.card} onPress={onOpen} activeOpacity={0.85}>
      <View style={styles.headerRow}>
        <Ionicons
          name={TYPE_ICONS[order.order_type] || 'receipt-outline'}
          size={16}
          color={Colors.textSecondary}
        />
        <Text style={styles.orderNumber} numberOfLines={1}>#{order.sale_number}</Text>
        <View style={{ flex: 1 }} />
        <StageBadge stage={order.display_stage} size="sm" />
      </View>

      <View style={styles.customerRow}>
        <Text style={styles.customer} numberOfLines={1}>{order.customer_name || 'Guest'}</Text>
        {contactPhone && (
          <>
            <TouchableOpacity
              style={[styles.contactBtn, { backgroundColor: Colors.info + '15' }]}
              onPress={(e) => { e.stopPropagation(); Linking.openURL(`tel:${contactPhone}`); }}
              hitSlop={12}
            >
              <Ionicons name="call-outline" size={13} color={Colors.info} />
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.contactBtn, { backgroundColor: Colors.success + '15' }]}
              onPress={(e) => {
                e.stopPropagation();
                Linking.openURL(`https://wa.me/91${contactPhone}?text=${encodeURIComponent(`Hi, this is about your order ${order.sale_number}`)}`);
              }}
              hitSlop={12}
            >
              <Ionicons name="logo-whatsapp" size={13} color={Colors.success} />
            </TouchableOpacity>
          </>
        )}
      </View>

      <Text style={styles.amount}>{formatMoney(order.grand_total)}</Text>

      {(sla || payment) && (
        <View style={styles.warningRow}>
          {sla && (
            <View style={[styles.warnPill, sla.level === 'late' ? styles.warnPillLate : styles.warnPillSoon]}>
              <Ionicons
                name="alert-circle-outline"
                size={12}
                color={sla.level === 'late' ? Colors.error : Colors.warning}
              />
              <Text style={[styles.warnText, { color: sla.level === 'late' ? Colors.error : Colors.warning }]}>
                {sla.text}
              </Text>
            </View>
          )}
          {payment && (
            <View style={[styles.warnPill, payment.level === 'late' ? styles.warnPillLate : styles.warnPillSoon]}>
              <Ionicons
                name="cash-outline"
                size={12}
                color={payment.level === 'late' ? Colors.error : Colors.warning}
              />
              <Text style={[styles.warnText, { color: payment.level === 'late' ? Colors.error : Colors.warning }]}>
                {payment.text}
              </Text>
            </View>
          )}
        </View>
      )}

      {(showSchedule || taskProgress) && (
        <Text style={styles.metaLine} numberOfLines={1}>
          {[
            showSchedule ? formatCardDateTime(order.scheduled_date, order.scheduled_time, timezone) : null,
            taskProgress,
          ].filter(Boolean).join('  ·  ')}
        </Text>
      )}

      {nextAction && (
        <TouchableOpacity
          style={styles.primaryAction}
          onPress={(e) => { e.stopPropagation(); onQuickAction(order); }}
          disabled={!!quickActionLoading}
          activeOpacity={0.75}
        >
          {quickActionLoading ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <>
              <Text style={styles.primaryActionText}>{nextAction.label}</Text>
              <Ionicons name="arrow-forward" size={15} color="#FFFFFF" />
            </>
          )}
        </TouchableOpacity>
      )}

      {deadEnd?.type === 'route' && (
        <TouchableOpacity
          style={styles.secondaryAction}
          onPress={(e) => { e.stopPropagation(); onResolve(order, deadEnd.kind); }}
          activeOpacity={0.75}
        >
          <Text style={styles.secondaryActionText}>{deadEnd.label}</Text>
          <Ionicons name="arrow-forward" size={14} color={Colors.primary} />
        </TouchableOpacity>
      )}

      {deadEnd?.type === 'status' && (
        <Text style={styles.statusLine} numberOfLines={1}>{deadEnd.text}</Text>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    padding: 12,
    gap: 6,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  orderNumber: { fontSize: 14, fontWeight: '800', color: Colors.text, fontFamily: FONT_FAMILY },
  customerRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  customer: { fontSize: 14, color: Colors.textSecondary, flexShrink: 1, fontFamily: FONT_FAMILY },
  contactBtn: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  amount: { fontSize: 17, fontWeight: '800', color: Colors.text, fontFamily: FONT_FAMILY },
  warningRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  warnPill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
  warnPillLate: { backgroundColor: Colors.error + '15' },
  warnPillSoon: { backgroundColor: Colors.warning + '15' },
  warnText: { fontSize: 12, fontWeight: '700', fontFamily: FONT_FAMILY },
  metaLine: { fontSize: 12, color: Colors.textLight, fontFamily: FONT_FAMILY },
  primaryAction: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    minHeight: 44, borderRadius: 10, backgroundColor: Colors.primary, marginTop: 2,
  },
  primaryActionText: { fontSize: 15, fontWeight: '700', color: '#FFFFFF', fontFamily: FONT_FAMILY },
  secondaryAction: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    minHeight: 44, borderRadius: 10, borderWidth: 1.5, borderColor: Colors.primary,
    backgroundColor: Colors.primary + '10', marginTop: 2,
  },
  secondaryActionText: { fontSize: 15, fontWeight: '700', color: Colors.primary, fontFamily: FONT_FAMILY },
  statusLine: { fontSize: 13, color: Colors.textSecondary, fontStyle: 'italic', fontFamily: FONT_FAMILY, marginTop: 2 },
});
