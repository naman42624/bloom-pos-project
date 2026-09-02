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
 * ── Why this helper takes role flags at all ──
 *
 * A null nextAction already encodes the server's decision about an *action*,
 * and nothing else here duplicates a server authorization decision. But
 * nothing on the wire says a *destination screen* will refuse this viewer, and
 * every 'route' this helper returns sends someone to another screen. Both
 * flags below answer only that one question, and are transcribed from the real
 * route definitions — the two lists are NOT the same, so do not merge them.
 *
 * `canManageDeliveries` — 'assign_rider' / 'reattempt_delivery' land on
 *   DeliveryDetailScreen. PUT /deliveries/:id/assign (deliveries.js:498) and
 *   PUT /deliveries/:id/reattempt (:784) are both
 *   authorize('owner','manager','counter_staff'), and that screen's own gate
 *   (:65) mirrors them — so an `employee` or `florist_staff` tapping "Assign
 *   Rider" landed on a screen with none of those controls.
 *
 * `canTakeMoney` — 'collect_payment' lands on AddPaymentScreen and
 *   'record_cod' on SettlementsScreen. POST /sales/:id/payments
 *   (sales.js:1981) and POST /deliveries/settlements/settle-now
 *   (deliveries.js:1078) are both
 *   authorize('owner','manager','employee','counter_staff') — `employee` IS
 *   allowed here, unlike the delivery list. Worse than a 403 for the one role
 *   excluded: DashboardScreen routes both through
 *   navigation.navigate('POS', ...), and MainNavigator.js:630 registers the
 *   POS tab only for those same four roles, so for `florist_staff` the tap
 *   resolves to no navigator at all and simply does nothing.
 *
 * In every case the person still needs to know what is happening with the
 * order (customers ring up asking), so a refused destination becomes a status
 * line — the same shape the out_for_delivery branch already used. Review
 * findings, 2026-09-02.
 *
 * See docs/superpowers/specs/2026-09-01-dashboard-stage-ui-redesign-design.md §7.
 */
function resolveDeadEnd(order, canManageDeliveries, canTakeMoney) {
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
      // A FAILED delivery can never be "marked delivered" — PUT
      // /deliveries/:id/deliver accepts only picked_up/in_transit. Its real
      // recoveries are Reattempt and Cancel on DeliveryDetail. Checked FIRST
      // because a failed delivery normally still has its partner name
      // attached, so without this it fell into the "<rider> has it" line below
      // and read as in-progress — while SaleDetailScreen, which has had this
      // branch since 8d741d3, said "Delivery Failed — Send Again" about the
      // same order. Added 2026-09-02 to make the two agree; same label.
      if (order.delivery_status === 'failed') {
        if (canManageDeliveries) {
          return { type: 'route', kind: 'reattempt_delivery', label: 'Delivery Failed — Send Again' };
        }
        return { type: 'status', text: 'Delivery failed — counter staff will resend' };
      }
      if (!order.delivery_partner_name) {
        if (canManageDeliveries) {
          return { type: 'route', kind: 'assign_rider', label: 'Assign Rider' };
        }
        return { type: 'status', text: 'Waiting for a rider' };
      }
      return { type: 'status', text: `${order.delivery_partner_name} has it` };
    }
    const due = Number(order.grand_total || 0) - Number(order.total_paid || 0);
    if (due > 0.01 && !order.is_credit_sale) {
      if (canTakeMoney) {
        return { type: 'route', kind: 'collect_payment', label: `Collect ${formatMoney(due)}` };
      }
      // Needs its own line rather than falling through: the fall-through here
      // is `return null`, which renders NOTHING on the card — a blank dead end
      // for the one role that cannot take money, on an order that visibly
      // still owes some. Wording matches SaleDetailScreen's equivalent note,
      // which already had this case right.
      return { type: 'status', text: `${formatMoney(due)} still to collect — counter staff take the payment` };
    }
    return null;
  }

  if (stageKey === 'out_for_delivery') {
    const codOutstanding = Number(order.cod_amount || 0) > Number(order.cod_collected || 0);
    // Deliberately no new copy when the viewer cannot settle: this branch
    // already ends in exactly the right status lines for someone who does not
    // handle cash ("Ravi has it" / "Out with a rider"), so it falls through to
    // them rather than inventing a sentence about money that is not this
    // person's to collect.
    if (codOutstanding && canTakeMoney) {
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

/**
 * Tasks this sale still has that nobody owns.
 *
 * Deliberately the SAME predicate as the server's own assign statement in
 * PUT /sales/:id/status (server/routes/sales.js): `assigned_to IS NULL AND
 * status IN ('pending','in_progress')`. If this drifts wider than that, the
 * card asks "who is making this?" about a sale where the answer would change
 * nothing — a question with no effect is worse than no question. If it drifts
 * narrower, work silently lands on nobody.
 *
 * 'in_progress' is in the list because `pref_manager_override` (on, in the
 * live shop) flips a pickup/delivery order's pending tasks to 'in_progress'
 * before the assign runs — matching 'pending' alone was a real silent no-op
 * found live 2026-09-02.
 */
export function hasUnassignedTasks(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  return list.some(
    (t) => t.assigned_to == null && (t.status === 'pending' || t.status === 'in_progress')
  );
}

/**
 * The whole "does starting this need a preparer, and who decides?" rule, in
 * ONE place, because there are two ways into the same button: the card's
 * primary action and the order modal's (components/QuickModals.js) copy of the
 * same nextAction. Those two silently diverged — the modal advanced with
 * nobody attached — which is exactly the "two one-tap mechanisms coexist"
 * pattern this plan exists to delete. Both now ask this function.
 *
 * Returns:
 *   { kind: 'advance' }               — behave exactly as before, no prompt
 *   { kind: 'self', assignedTo }      — one tap, the viewer takes it themselves
 *   { kind: 'pick' }                  — ask who, via the 'pick_preparer' kind
 */
export function resolvePreparerStep({ order, tasks, viewerRole, viewerId }) {
  // Only Start Preparing may carry assigned_to: PUT /sales/:id/status acts on
  // it exclusively when the status being set is 'preparing'. Everywhere else
  // it is accepted, returns 200, and assigns nobody.
  if (order?.display_stage?.nextAction?.body?.status !== 'preparing') return { kind: 'advance' };
  // Never ask a question whose answer changes nothing.
  if (!hasUnassignedTasks(tasks)) return { kind: 'advance' };
  // The person who is going to do it themselves. Not florist_staff:
  // ENDPOINT_ROLES.SALE_STATUS in server/utils/order-stage.js omits them, so
  // nextAction is null for a florist and this is unreachable for them anyway.
  if (viewerRole === 'employee' && viewerId != null) return { kind: 'self', assignedTo: viewerId };
  // Counter staff, owner, manager: they are not the ones making the bouquet,
  // so self-assigning would put a false name on the work.
  return { kind: 'pick' };
}

/**
 * Who is preparing this order, for the line shown on a `preparing` card.
 *
 * Returns null when there is nothing to say (no live tasks at all — e.g. a
 * sale of only ready-made stock), otherwise `{ text, actionWord }`.
 *
 * ── An unassigned task must never hide behind a name ──
 *
 * Deriving this from the assigned tasks alone was wrong: one task on Jeetu and
 * one on nobody read as plain "Jeetu is preparing", so the free task was
 * invisible — and the word on the button was `change`, which then reassigned
 * Jeetu's own work away from him. The count is therefore part of the sentence
 * whenever it is non-zero, and it also decides the verb:
 *   'assign' — there is free work; picking someone FILLS it and touches nobody
 *              else's task (matching the server's own `WHERE assigned_to IS
 *              NULL` on the 'start' path).
 *   'change' — everything is already held, so picking someone genuinely moves
 *              the work, and `change` is the honest word for that.
 * Taking a task off someone who actively holds it, one by one, stays one level
 * deeper on Sale Detail. What is not acceptable is doing it by accident.
 *
 * `assigned_to` is compared through Number() on both sides on purpose: this
 * codebase has already been bitten by pg handing back a numeric column as a
 * string (active_delivery_count, Task 14), and a `'7' === 7` miss here would
 * quietly show a counter staffer's own name as somebody else's.
 */
function getPreparerLine(tasks, viewerId) {
  const list = Array.isArray(tasks) ? tasks : [];
  const live = list.filter((t) => t.status !== 'completed' && t.status !== 'cancelled');
  if (live.length === 0) return null;

  const holders = new Map();
  let freeCount = 0;
  live.forEach((t) => {
    if (t.assigned_to == null) { freeCount++; return; }
    holders.set(Number(t.assigned_to), t.assigned_to_name || 'Someone');
  });

  if (holders.size === 0) return { text: 'Nobody assigned yet', actionWord: 'assign' };

  let who;
  if (holders.size === 1) {
    const [id] = Array.from(holders.keys());
    who = (viewerId != null && Number(viewerId) === id)
      ? "You're on it"
      : `${holders.get(id)} is preparing`;
  } else {
    who = `${holders.size} people preparing`;
  }

  if (freeCount > 0) {
    return {
      text: `${who} · ${freeCount} still unassigned`,
      actionWord: 'assign',
    };
  }
  return { text: who, actionWord: 'change' };
}

export default function OrderCard({
  order,
  tasks,
  timezone,
  quickActionLoading,
  viewerRole,
  viewerId,
  onOpen,
  onQuickAction,
  onResolve,
}) {
  const sla = getOrderSla(order, timezone);
  const payment = getPaymentWarning(order);
  const taskProgress = getTaskProgress(tasks);
  const nextAction = order.display_stage?.nextAction;
  // The only role logic in this component, and it decides exactly one thing:
  // routing button vs status line, for each of the three screens this card can
  // send someone to. Everything else stays server-decided via
  // display_stage.nextAction. The two lists differ — see resolveDeadEnd's note
  // — and each mirrors a real authorize() call; keep them in step with
  // SaleDetailScreen's canManageDeliveries / canRecordPayment.
  const canManageDeliveries = ['owner', 'manager', 'counter_staff'].includes(viewerRole);
  const canTakeMoney = ['owner', 'manager', 'employee', 'counter_staff'].includes(viewerRole);
  const deadEnd = nextAction ? null : resolveDeadEnd(order, canManageDeliveries, canTakeMoney);
  const contactPhone = order.customer_phone || order.receiver_phone;
  const showSchedule = order.scheduled_date && order.order_type !== 'walk_in';

  // ── Who is making this? (Task 15) ──
  //
  // Whoever taps Start Preparing usually knows who is doing the work, so the
  // action carries it instead of costing a separate trip to another screen.
  // The rule itself lives in resolvePreparerStep so the order modal's copy of
  // this same button cannot drift away from it.
  const preparerStep = resolvePreparerStep({ order, tasks, viewerRole, viewerId });

  // A third role list, and like the other two it mirrors one real authorize():
  // PUT /production/tasks/:id/assign is owner/manager/counter_staff. Handing
  // anyone else a tap that 403s is the dead end this redesign exists to
  // remove, so for them the preparer line renders as plain text — they still
  // need to know who has it. (`employee` and `florist_staff` never reach this
  // board on DashboardScreen anyway; they get the task-focused branch, where
  // they self-assign with pickTask/startTask.)
  const canAssignPreparer = ['owner', 'manager', 'counter_staff'].includes(viewerRole);
  const preparerLine = order.display_stage?.key === 'preparing'
    ? getPreparerLine(tasks, viewerId)
    : null;

  const handlePrimaryPress = (e) => {
    e.stopPropagation();
    // The card stays navigation- and fetch-free: 'pick' signals the parent
    // rather than opening anything itself.
    if (preparerStep.kind === 'self') {
      onQuickAction(order, { assigned_to: preparerStep.assignedTo });
      return;
    }
    if (preparerStep.kind === 'pick') {
      onResolve(order, 'pick_preparer');
      return;
    }
    onQuickAction(order);
  };

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

      {/* Who is making this — only on a card that is actually being prepared.
          Doubles as the correction path: tapping it re-opens the same picker,
          so there is no separate Reassign button and no new clutter. Rendered
          above the primary action because it answers a question about the work
          already in progress, not about the next step. */}
      {preparerLine && (
        canAssignPreparer ? (
          <TouchableOpacity
            style={styles.preparerRow}
            onPress={(e) => { e.stopPropagation(); onResolve(order, 'pick_preparer'); }}
            activeOpacity={0.7}
            hitSlop={8}
          >
            <Ionicons name="person-outline" size={13} color={Colors.textSecondary} />
            {/* Two lines, for the same reason the status line below takes two:
                the "N still unassigned" half sits at the END of the sentence
                and is exactly what a one-line ellipsis eats on a narrow
                column — and it is the half that changes what you should do. */}
            <Text style={styles.preparerText} numberOfLines={2}>{preparerLine.text}</Text>
            <Text style={styles.preparerAction}>· {preparerLine.actionWord}</Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.preparerRow}>
            <Ionicons name="person-outline" size={13} color={Colors.textSecondary} />
            {/* Two lines, for the same reason the status line below takes two:
                the "N still unassigned" half sits at the END of the sentence
                and is exactly what a one-line ellipsis eats on a narrow
                column — and it is the half that changes what you should do. */}
            <Text style={styles.preparerText} numberOfLines={2}>{preparerLine.text}</Text>
          </View>
        )
      )}

      {nextAction && (
        <TouchableOpacity
          style={styles.primaryAction}
          onPress={handlePrimaryPress}
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

      {/* Two lines, not one (2026-09-02). The role-fallback lines added this
          round carry the "what happens next" half at the END of the sentence
          ("Delivery failed — counter staff will resend"), which is exactly the
          half a one-line ellipsis eats on a narrow column — staff-ux-checklist
          #6. The pre-existing short lines ("Ravi has it") still render on one
          line, so nothing else changes. */}
      {deadEnd?.type === 'status' && (
        <Text style={styles.statusLine} numberOfLines={2}>{deadEnd.text}</Text>
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
  // A row, not a bare Text, so the whole line (icon + name + "· change") is
  // one 36px tap target rather than a few pixels of underlined word.
  preparerRow: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 36 },
  preparerText: { fontSize: 13, color: Colors.textSecondary, fontFamily: FONT_FAMILY, flexShrink: 1 },
  preparerAction: { fontSize: 13, fontWeight: '700', color: Colors.primary, fontFamily: FONT_FAMILY },
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
