import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Modal,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  Image,
  Linking,
  useWindowDimensions,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { Colors, FontSize, Spacing } from '../constants/theme';
import { minutesSinceServerDate, minutesUntilShopDateTime } from '../utils/datetime';
import { OrderQuickModal, DeliveryQuickModal } from '../components/QuickModals';

const ORDER_TYPES = ['delivery', 'pickup', 'walk_in'];
const ORDER_TYPE_LABELS = {
  delivery: 'Delivery Orders',
  pickup: 'Pickup Orders',
  walk_in: 'Walk-in Orders',
};

const ORDER_STATUS_LABELS = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  preparing: 'Preparing',
  ready: 'Ready',
  completed: 'Completed',
  cancelled: 'Cancelled',
  draft: 'Draft',
};

const TASK_STATUS_LABELS = {
  pending: 'Queued',
  assigned: 'Assigned',
  in_progress: 'In Progress',
  completed: 'Done',
  cancelled: 'Cancelled',
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

const DELIVERY_STATUS_COLORS = {
  pending: '#9CA3AF',
  assigned: '#6366F1',
  picked_up: '#F59E0B',
  in_transit: '#0EA5E9',
  delivered: '#10B981',
  failed: '#E11D48',
  cancelled: '#9CA3AF',
};

const DELIVERY_STATUS_LABELS = {
  pending: 'Pending',
  assigned: 'Assigned',
  picked_up: 'Picked Up',
  in_transit: 'In Transit',
  delivered: 'Delivered',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const PAYMENT_STATUS_COLORS = {
  paid: '#10B981',
  partial: '#F59E0B',
  pending: '#E11D48',
  refunded: '#9CA3AF',
};

const FONT_FAMILY = typeof navigator !== 'undefined' && navigator.product === 'ReactNative'
  ? undefined
  : 'Inter, Geist, system-ui';

function formatMoney(value) {
  return `₹${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

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

      // Format the time part (HH:MM)
      const [hh, mm] = String(timeStr).split(':').map(Number);
      const ampm = hh >= 12 ? 'PM' : 'AM';
      const h12 = hh % 12 || 12;
      return `${datePart}, ${h12}:${String(mm || 0).padStart(2, '0')} ${ampm}`;
    }
  } catch {}
  return dateStr || '';
}

function getTaskChipColor(status) {
  if (status === 'completed') return '#10B981';
  if (status === 'in_progress') return '#0EA5E9';
  if (status === 'assigned') return '#6366F1';
  if (status === 'pending') return '#F59E0B';
  return '#9CA3AF';
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

function RegisterCard({ item, onPress }) {
  const { locationName, isOpen, register } = item;
  const tone = isOpen ? '#10B981' : '#E11D48';
  return (
    <TouchableOpacity
      style={[styles.registerCard, { borderLeftColor: tone, borderLeftWidth: 4 }]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={styles.rowBetween}>
        <View style={{ flex: 1 }}>
          <Text style={styles.registerTitle}>{locationName}</Text>
          <Text style={[styles.registerStatus, { color: tone }]}>
            {isOpen ? '● OPEN' : '● CLOSED'}
          </Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={styles.registerLabel}>Expected</Text>
          <Text style={styles.registerValue}>{formatMoney(register?.expected_cash || 0)}</Text>
        </View>
      </View>
      <View style={[styles.divider, { backgroundColor: tone + '20' }]} />
      <View style={[styles.rowBetween, { marginTop: 8 }]}>
        <View>
          <Text style={styles.registerLabel}>Opening</Text>
          <Text style={styles.registerValue}>{formatMoney(register?.opening_balance || 0)}</Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={styles.registerLabel}>Cash Sales</Text>
          <Text style={styles.registerValue}>{formatMoney(register?.total_cash_sales || 0)}</Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}

function StaffPulseRow({ staff }) {
  const tone = staff.pulse === 'active' ? '#10B981' : staff.pulse === 'busy' ? '#F59E0B' : '#9CA3AF';
  const bgTone = staff.pulse === 'active' ? '#F0FDF4' : staff.pulse === 'busy' ? '#FEF3C7' : '#F3F4F6';
  return (
    <View style={[styles.staffRow, { backgroundColor: bgTone, borderLeftColor: tone, borderLeftWidth: 3 }]}>
      <View style={[styles.staffRing, { borderColor: tone, backgroundColor: tone + '1a' }]}>
        <Ionicons name="person" size={13} color={tone} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.staffName}>{staff.name}</Text>
        <Text style={styles.staffMeta}>{staff.roleLabel}</Text>
        {!!staff.detail && <Text style={styles.staffMetaSub}>{staff.detail}</Text>}
      </View>
      <View style={[styles.pulseBadge, { backgroundColor: tone + '20', borderColor: tone }]}>
        <Text style={[styles.pulseBadgeText, { color: tone }]}>{staff.pulseLabel}</Text>
      </View>
    </View>
  );
}

function TaskDetailModal({ visible, task, onClose, onAdvance, loading }) {
  if (!task) return null;
  
  const color = getTaskChipColor(task.status);
  const isFinal = task.status === 'completed' || task.status === 'cancelled';
  const nextStatus = task.status === 'pending' ? 'Assign' : 
                     task.status === 'assigned' ? 'Start' : 
                     task.status === 'in_progress' ? 'Complete' : null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={onClose}>
        <View style={styles.taskModalCard}>
          <View style={styles.modalHeader}>
            <View style={[styles.statusDot, { backgroundColor: color }]} />
            <Text style={styles.modalTitle}>{task.product_name || task.item_product_name || 'Task'}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={5}>
              <Ionicons name="close" size={20} color="#6B7280" />
            </TouchableOpacity>
          </View>

          <View style={styles.modalContent}>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Current Status</Text>
              <View style={[styles.statusPill, { backgroundColor: color + '20', borderColor: color }]}>
                <Text style={[styles.statusPillText, { color }]}>{TASK_STATUS_LABELS[task.status] || task.status}</Text>
              </View>
            </View>

            {task.custom_materials && (
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Materials</Text>
                <Text style={styles.detailValue}>{task.custom_materials}</Text>
              </View>
            )}

            {task.special_instructions && (
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Instructions</Text>
                <Text style={styles.detailValue}>{task.special_instructions}</Text>
              </View>
            )}

            {task.sale_number && (
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Order #</Text>
                <Text style={styles.detailValue}>{task.sale_number}</Text>
              </View>
            )}
          </View>

          {!isFinal && nextStatus && (
            <TouchableOpacity
              disabled={loading}
              onPress={() => onAdvance(task)}
              style={[styles.advanceButton, { opacity: loading ? 0.6 : 1, backgroundColor: color }]}
            >
              {loading ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <>
                  <Ionicons name="arrow-forward" size={16} color="#fff" />
                  <Text style={styles.advanceButtonText}>{nextStatus} Task</Text>
                </>
              )}
            </TouchableOpacity>
          )}

          {isFinal && (
            <View style={[styles.advanceButton, { backgroundColor: '#E5E7EB' }]}>
              <Ionicons name="checkmark-circle" size={16} color="#6B7280" />
              <Text style={[styles.advanceButtonText, { color: '#6B7280' }]}>Task {task.status === 'completed' ? 'Completed' : 'Cancelled'}</Text>
            </View>
          )}
        </View>
      </TouchableOpacity>
    </Modal>
  );
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

function OrderCard({ order, tasks, hasPendingProduction, pulseOpacity, onTaskClick, taskActionLoading, onOpen, timezone }) {
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

      {/* Scheduled date — delivery/pickup */}
      {order.scheduled_date && (
        <View style={styles.scheduledRow}>
          <Ionicons name="calendar-outline" size={11} color="#6366F1" />
          <Text style={styles.scheduledText}>
            {formatCardDateTime(order.scheduled_date, order.scheduled_time, timezone)}
          </Text>
        </View>
      )}
      {/* Walk-in: show creation time */}
      {!order.scheduled_date && order.order_type === 'walk_in' && order.created_at && (
        <View style={styles.scheduledRow}>
          <Ionicons name="time-outline" size={11} color="#9CA3AF" />
          <Text style={[styles.scheduledText, { color: '#9CA3AF' }]}>
            {formatCardDateTime(order.created_at, null, timezone)}
          </Text>
        </View>
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

export default function DashboardScreen({ navigation }) {
  const { width } = useWindowDimensions();
  const { user, activeLocation, settings } = useAuth();
  const timezone = settings?.timezone || 'Asia/Kolkata';

  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [fabVisible, setFabVisible] = useState(false);
  const [selectedTaskModal, setSelectedTaskModal] = useState(null);
  const [selectedOrderModal, setSelectedOrderModal] = useState(null); // { order, tasks }
  const [selectedDeliveryId, setSelectedDeliveryId] = useState(null);
  const savedOrderForDelivery = useRef(null); // stores order context for back-navigation from delivery modal

  const [locations, setLocations] = useState([]);
  const [locationScope, setLocationScope] = useState(null);
  const [sales, setSales] = useState([]);
  const [taskRows, setTaskRows] = useState([]);
  const [staffPulse, setStaffPulse] = useState([]);
  const [registers, setRegisters] = useState([]);
  const [reportKPIs, setReportKPIs] = useState(null);

  const [taskActionLoading, setTaskActionLoading] = useState({});

  // Role-specific dashboard state
  const [myTasks, setMyTasks] = useState([]); // employee's own tasks
  const [myDeliveries, setMyDeliveries] = useState([]); // delivery partner's own deliveries

  const role = user?.role;
  const isOwner = role === 'owner';
  const isStaff = role === 'owner' || role === 'manager' || role === 'employee';
  const isOwnerOrManager = role === 'owner' || role === 'manager';
  const isEmployee = role === 'employee';
  const isDeliveryPartner = role === 'delivery_partner';
  const isDesktop = width >= 1100;

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

  const fetchDashboard = useCallback(async () => {
    try {
      // ─── Delivery Partner: lightweight fetch ─────────────────
      if (isDeliveryPartner) {
        const [delivRes, unsettledRes] = await Promise.all([
          api.getDeliveries({ status: 'active' }).catch(() => ({ data: [] })),
          api.getUnsettledDeliveries({}).catch(() => ({ data: { deliveries: [], total_unsettled: 0 } })),
        ]);
        setMyDeliveries(delivRes?.data || []);
        const unsettledData = unsettledRes?.data || {};
        setReportKPIs({ unsettledTotal: Number(unsettledData.total_unsettled || 0), unsettledCount: (unsettledData.deliveries || []).length });
        setLoading(false);
        setRefreshing(false);
        return;
      }

      // ─── Employee: task-focused fetch ────────────────────────
      if (isEmployee) {
        const [myTasksRes, allTasksRes] = await Promise.all([
          api.getMyTasks().catch(() => ({ data: [] })),
          api.getProductionTasks({}).catch(() => ({ data: [] })),
        ]);
        setMyTasks(myTasksRes?.data || []);
        setTaskRows(allTasksRes?.data || []);
        setLoading(false);
        setRefreshing(false);
        return;
      }

      // ─── Owner / Manager: full fetch ─────────────────────────
      const locationRes = await api.getLocations();
      const locationList = locationRes?.data?.locations || locationRes?.data || [];
      setLocations(Array.isArray(locationList) ? locationList : []);

      let locationId;
      if (locationScope === 'all' && isOwner) {
        locationId = null;
      } else if (locationScope != null) {
        locationId = locationScope;
      } else {
        locationId = activeLocation?.id || locationList?.[0]?.id || null;
      }
      const filters = locationId ? { location_id: locationId } : {};

      const reqs = [
        api.getSales({ ...filters, limit: 500 }),
        api.getProductionTasks({}),
      ];

      if (isOwnerOrManager) {
        reqs.push(api.getStaffToday(filters));
        reqs.push(api.getReportsDashboard(filters).catch(() => ({ data: null })));
      } else if (isStaff) {
        reqs.push(api.getMyTasks().catch(() => ({ data: [] })));
      }

      const results = await Promise.all(reqs);
      const salesRes = results[0];
      const tasksRes = results[1];

      const salesRows = salesRes?.data?.sales || salesRes?.data || [];
      const tasks = tasksRes?.data || [];

      setSales(Array.isArray(salesRows) ? salesRows.filter((s) => ORDER_TYPES.includes(s.order_type)) : []);
      setTaskRows(Array.isArray(tasks) ? tasks : []);

      if (isOwnerOrManager) {
        const staffRes = results[2];
        const reportsRes = results[3];

        const present = staffRes?.data?.present || [];
        const absent = staffRes?.data?.absent || [];

        const normalizedPresentRaw = present.map((s) => {
          let pulse = 'active';
          let pulseLabel = 'Active';
          const isActiveSession = typeof s.active_session === 'boolean' ? s.active_session : !s.clock_out;
          if (isActiveSession && (Number(s.outdoor_hours || 0) > 0 || s.status === 'half_day')) {
            pulse = 'busy';
            pulseLabel = 'Busy';
          } else if (!isActiveSession) {
            pulse = 'off';
            pulseLabel = 'Off-shift';
          }

          return {
            id: `present-${s.user_id || s.id}`,
            rawUserId: s.user_id || s.id,
            name: s.user_name,
            roleLabel: (s.user_role || '').replace('_', ' '),
            pulse,
            pulseLabel,
            detail: `${Number(s.sessions_count || 1)} session${Number(s.sessions_count || 1) > 1 ? 's' : ''}`,
          };
        });

        // Defensive dedupe by user id in case server/client data changes.
        const presentByUser = new Map();
        for (const p of normalizedPresentRaw) {
          const existing = presentByUser.get(p.rawUserId);
          if (!existing) {
            presentByUser.set(p.rawUserId, p);
            continue;
          }
          if (existing.pulse === 'off' && p.pulse !== 'off') {
            presentByUser.set(p.rawUserId, p);
          }
        }
        const normalizedPresent = Array.from(presentByUser.values());

        const normalizedAbsent = absent.map((s) => ({
          id: `absent-${s.id}`,
          name: s.name,
          roleLabel: (s.role || '').replace('_', ' '),
          pulse: 'off',
          pulseLabel: 'Off-shift',
        }));

        setStaffPulse([...normalizedPresent, ...normalizedAbsent].slice(0, 10));
        setReportKPIs(reportsRes?.data || null);
      } else {
        const myTasksRes = results[2];
        const myRows = myTasksRes?.data || [];
        setStaffPulse([
          {
            id: `self-${user?.id}`,
            name: user?.name || 'You',
            roleLabel: (role || '').replace('_', ' '),
            pulse: myRows.length > 0 ? 'busy' : 'active',
            pulseLabel: myRows.length > 0 ? 'Busy' : 'Active',
          },
        ]);
      }

      if (locationList.length > 0) {
        const registerCalls = await Promise.all(
          locationList.map(async (loc) => {
            try {
              const reg = await api.getRegisterStatus(loc.id);
              return {
                locationId: loc.id,
                locationName: loc.name,
                isOpen: reg?.isOpen === true,
                register: reg?.data || null,
              };
            } catch {
              return {
                locationId: loc.id,
                locationName: loc.name,
                isOpen: false,
                register: null,
              };
            }
          })
        );
        setRegisters(registerCalls);
      } else {
        setRegisters([]);
      }
    } catch (err) {
      Alert.alert('Dashboard', err?.message || 'Failed to load dashboard data.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [activeLocation?.id, isOwner, isOwnerOrManager, isStaff, isEmployee, isDeliveryPartner, locationScope, role, user?.id, user?.name]);

  useEffect(() => {
    if (locationScope != null) return;
    if (activeLocation?.id) {
      setLocationScope(activeLocation.id);
      return;
    }
    if (locations.length > 0) {
      setLocationScope(locations[0].id);
    }
  }, [locationScope, activeLocation?.id, locations]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      fetchDashboard();
    }, [fetchDashboard])
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchDashboard();
  }, [fetchDashboard]);

  const tasksBySaleId = useMemo(() => {
    const map = new Map();
    for (const t of taskRows) {
      const arr = map.get(t.sale_id) || [];
      arr.push(t);
      map.set(t.sale_id, arr);
    }
    return map;
  }, [taskRows]);

  const ordersByTypeAndStatus = useMemo(() => {
    const base = {
      delivery: { pending: [], preparing: [], ready: [], completed: [] },
      pickup: { pending: [], preparing: [], ready: [], completed: [] },
      walk_in: { pending: [], preparing: [], ready: [], completed: [] },
    };

    for (const order of sales) {
      if (!ORDER_TYPES.includes(order.order_type)) continue;
      if (order.status === 'cancelled' || order.status === 'draft') continue;
      
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

  const advanceTaskStatus = useCallback(async (task) => {
    if (!task?.id) return;
    if (task.status === 'completed' || task.status === 'cancelled') return;

    setTaskActionLoading((prev) => ({ ...prev, [task.id]: true }));
    try {
      if (task.status === 'pending') {
        await api.pickTask(task.id);
      } else if (task.status === 'assigned') {
        await api.startTask(task.id);
      } else if (task.status === 'in_progress') {
        await api.completeTask(task.id);
      }
      setSelectedTaskModal(null);
      await fetchDashboard();
    } catch (err) {
      Alert.alert('Task Update', err?.message || 'Unable to update task status.');
    } finally {
      setTaskActionLoading((prev) => ({ ...prev, [task.id]: false }));
    }
  }, [fetchDashboard]);

  const handleNavigateToQueue = useCallback((orderType, status) => {
    navigation.navigate('ProductionQueue', {
      applyId: Date.now(),
      initialViewMode: 'orders',
      initialOrderType: orderType,
      initialStatus: status || '',
      initialLocationId: locationScope === 'all' ? null : (locationScope || activeLocation?.id || null),
      initialShowFilters: true,
    });
  }, [navigation, activeLocation?.id, locationScope]);

  const renderStatusLane = (type, laneKey, laneLabel, orders) => {
    const previewCount = isDesktop ? 2 : 1;
    const previewOrders = orders.slice(0, previewCount);
    const hiddenCount = Math.max(orders.length - previewOrders.length, 0);
    const laneTheme = getLaneTheme(laneKey);
    const overdueCount = orders.filter((o) => getOrderLaneSla(o, timezone) === 'overdue').length;
    const dueSoonCount = orders.filter((o) => getOrderLaneSla(o, timezone) === 'dueSoon').length;
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
        onPress={() => handleNavigateToQueue(type, laneKey)}
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
              const orderTasks = tasksBySaleId.get(order.id) || [];
              const hasPendingProduction = orderTasks.some((t) => ['pending', 'assigned', 'in_progress'].includes(t.status));
              return (
                <OrderCard
                  key={order.id}
                  order={order}
                  tasks={orderTasks}
                  hasPendingProduction={hasPendingProduction}
                  pulseOpacity={pulseOpacity}
                  taskActionLoading={taskActionLoading}
                  onTaskClick={(task) => setSelectedTaskModal(task)}
                  onOpen={() => setSelectedOrderModal({ order, tasks: orderTasks })}
                  timezone={timezone}
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
    const groups = ordersByTypeAndStatus[type] || { pending: [], preparing: [], ready: [], completed: [] };
    const lanes = [
      { key: 'pending', label: 'Pending', rows: groups.pending },
      { key: 'preparing', label: 'Preparing', rows: groups.preparing },
      { key: 'ready', label: 'Ready', rows: groups.ready },
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

  return (
    <View style={styles.root}>
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[Colors.primary]} />}
      >
        <View style={styles.heroCard}>
          <View style={[styles.rowBetween, { marginBottom: 4 }]}>
            <View style={{ flex: 1 }}>
              <Text style={styles.heroEyebrow}>Operations Dashboard</Text>
              <Text style={styles.heroTitle}>Welcome, {(user?.name || 'Team').split(' ')[0]}</Text>
            </View>
            <View style={styles.heroIcon}>
              <Ionicons name="pulse" size={24} color="#fff" />
            </View>
          </View>
          <Text style={styles.heroSub}>
            {isDeliveryPartner ? 'Your active deliveries and earnings at a glance'
              : isEmployee ? 'Your production tasks and work queue'
              : 'Real-time order flow, production pipeline, and operational health metrics'}
          </Text>
        </View>

        {/* Location picker — owner/manager only */}
        {!isEmployee && !isDeliveryPartner && locations.length > 0 && (
          <View style={styles.scopeCard}>
            <Text style={styles.scopeLabel}>Dashboard Location</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.scopeChipsRow}>
              {isOwner && (
                <TouchableOpacity
                  style={[styles.scopeChip, locationScope === 'all' && styles.scopeChipActive]}
                  onPress={() => setLocationScope('all')}
                >
                  <Text style={[styles.scopeChipText, locationScope === 'all' && styles.scopeChipTextActive]}>All Locations</Text>
                </TouchableOpacity>
              )}
              {locations.map((loc) => (
                <TouchableOpacity
                  key={loc.id}
                  style={[styles.scopeChip, locationScope === loc.id && styles.scopeChipActive]}
                  onPress={() => setLocationScope(loc.id)}
                >
                  <Text style={[styles.scopeChipText, locationScope === loc.id && styles.scopeChipTextActive]}>{loc.name}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        )}

        {loading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator color={Colors.primary} size="large" />
            <Text style={styles.loadingText}>Loading dashboard...</Text>
          </View>
        ) : isDeliveryPartner ? (
          /* ═══ DELIVERY PARTNER DASHBOARD ═══ */
          <View style={{ gap: 12 }}>
            {/* Stats row */}
            <View style={styles.roleStatsRow}>
              <View style={[styles.roleStatCard, { borderLeftColor: '#0EA5E9' }]}>
                <Ionicons name="bicycle-outline" size={20} color="#0EA5E9" />
                <Text style={styles.roleStatCount}>{myDeliveries.filter(d => ['assigned','picked_up','in_transit'].includes(d.status)).length}</Text>
                <Text style={styles.roleStatLabel}>Active</Text>
              </View>
              <View style={[styles.roleStatCard, { borderLeftColor: '#F59E0B' }]}>
                <Ionicons name="time-outline" size={20} color="#F59E0B" />
                <Text style={styles.roleStatCount}>{myDeliveries.filter(d => d.status === 'pending').length}</Text>
                <Text style={styles.roleStatLabel}>Pending</Text>
              </View>
              <View style={[styles.roleStatCard, { borderLeftColor: '#10B981' }]}>
                <Ionicons name="wallet-outline" size={20} color="#10B981" />
                <Text style={styles.roleStatCount}>₹{reportKPIs?.unsettledTotal || 0}</Text>
                <Text style={styles.roleStatLabel}>Unsettled COD</Text>
              </View>
            </View>

            {/* Active deliveries */}
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Your Deliveries</Text>
              <TouchableOpacity onPress={() => navigation.navigate('Deliveries')}>
                <Text style={{ color: Colors.primary, fontWeight: '600', fontSize: 13 }}>View All →</Text>
              </TouchableOpacity>
            </View>

            {myDeliveries.length === 0 ? (
              <View style={styles.roleEmptyCard}>
                <Ionicons name="checkmark-circle-outline" size={40} color="#10B981" />
                <Text style={styles.roleEmptyTitle}>All clear!</Text>
                <Text style={styles.roleEmptyText}>No active deliveries right now.</Text>
              </View>
            ) : (
              myDeliveries.map((d) => {
                const statusColor = DELIVERY_STATUS_COLORS[d.status] || '#9CA3AF';
                const statusLabel = DELIVERY_STATUS_LABELS[d.status] || d.status;
                const orderStatus = ORDER_STATUS_LABELS[d.order_status] || (d.order_status ? d.order_status.toUpperCase() : 'Unknown');
                const orderStatusColor = d.order_status === 'ready' || d.order_status === 'completed' ? '#10B981' : '#F59E0B';
                
                let dateStr = 'No Date';
                if (d.scheduled_date) {
                   const dt = new Date(d.scheduled_date);
                   dateStr = dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
                   if (d.scheduled_time) {
                     dateStr += `, ${d.scheduled_time.slice(0, 5)}`;
                   }
                }

                return (
                  <TouchableOpacity
                    key={d.id}
                    style={[styles.roleTaskCard, { borderLeftColor: statusColor }]}
                    onPress={() => navigation.navigate('DeliveryDetail', { deliveryId: d.id })}
                    activeOpacity={0.8}
                  >
                    <View style={styles.roleTaskHeader}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Text style={styles.roleTaskName} numberOfLines={1}>#{d.sale_number}</Text>
                        <Text style={[styles.roleTaskMeta, { color: '#0EA5E9', fontWeight: '700', marginTop: 0 }]}>
                          {dateStr}
                        </Text>
                      </View>
                      <View style={[styles.roleTaskBadge, { backgroundColor: statusColor + '20' }]}>
                        <Text style={[styles.roleTaskBadgeText, { color: statusColor }]}>{statusLabel.toUpperCase()}</Text>
                      </View>
                    </View>

                    <Text style={[styles.roleTaskMeta, { marginBottom: 6 }]} numberOfLines={2}>
                      <Ionicons name="location-outline" size={12} color="#9CA3AF" /> {d.delivery_address || 'No address'}
                    </Text>
                    
                    {d.special_instructions && (
                      <View style={{ backgroundColor: '#FEF3C7', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, marginBottom: 8 }}>
                        <Text style={{ fontSize: 12, fontWeight: '500', color: '#B45309' }}>⚡ {d.special_instructions}</Text>
                      </View>
                    )}

                    {d.items && d.items.length > 0 && (
                      <View style={{ backgroundColor: '#F9FAFB', padding: 8, borderRadius: 6, marginBottom: 8, borderWidth: 1, borderColor: '#F3F4F6' }}>
                        {d.items.map((item, idx) => (
                          <Text key={idx} style={{ fontSize: 12, color: '#4B5563', marginBottom: idx === d.items.length - 1 ? 0 : 2 }}>
                            {Number(item.quantity || 1)}× {item.product_name}
                          </Text>
                        ))}
                      </View>
                    )}

                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                        <Ionicons name="cube-outline" size={14} color={orderStatusColor} />
                        <Text style={[styles.roleTaskMeta, { color: orderStatusColor, fontWeight: '600', marginTop: 0 }]}>
                          Order: {orderStatus}
                        </Text>
                      </View>
                      {d.payment_status === 'paid' ? (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                          <Ionicons name="checkmark-circle" size={14} color="#10B981" />
                          <Text style={[styles.roleTaskMeta, { color: '#10B981', fontWeight: '700', marginTop: 0 }]}>PAID</Text>
                        </View>
                      ) : d.is_credit_sale === 1 ? (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                          <Ionicons name="document-text" size={14} color="#8B5CF6" />
                          <Text style={[styles.roleTaskMeta, { color: '#8B5CF6', fontWeight: '700', marginTop: 0 }]}>CREDIT</Text>
                        </View>
                      ) : (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                          <Ionicons name="warning" size={14} color="#EF4444" />
                          <Text style={[styles.roleTaskMeta, { color: '#EF4444', fontWeight: '700', marginTop: 0 }]}>UNPAID</Text>
                        </View>
                      )}
                    </View>

                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 8, borderTopWidth: 1, borderTopColor: '#F3F4F6' }}>
                      <View>
                        <Text style={[styles.roleTaskMeta, { color: '#111827', fontWeight: '600' }]}>{d.customer_name || 'Customer'}</Text>
                        {d.customer_phone ? (
                          <TouchableOpacity onPress={() => Linking.openURL(`tel:${d.customer_phone}`)} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
                            <Ionicons name="call" size={12} color={Colors.primary} />
                            <Text style={[styles.roleTaskMeta, { color: Colors.primary, marginTop: 0 }]}>{d.customer_phone}</Text>
                          </TouchableOpacity>
                        ) : null}
                      </View>
                      {Number(d.cod_amount) > 0 && (
                        <View style={{ backgroundColor: '#FEF3C7', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, alignItems: 'center' }}>
                          <Text style={{ fontSize: 10, color: '#92400E', fontWeight: '600', textTransform: 'uppercase' }}>To Collect</Text>
                          <Text style={{ fontSize: 13, fontWeight: '800', color: '#B45309' }}>₹{Number(d.cod_amount).toFixed(0)}</Text>
                        </View>
                      )}
                    </View>
                  </TouchableOpacity>
                );
              })
            )}
          </View>
        ) : isEmployee ? (
          /* ═══ EMPLOYEE DASHBOARD ═══ */
          <View style={{ gap: 12 }}>
            {/* Stats row */}
            <View style={styles.roleStatsRow}>
              <View style={[styles.roleStatCard, { borderLeftColor: '#F59E0B' }]}>
                <Ionicons name="hourglass-outline" size={20} color="#F59E0B" />
                <Text style={styles.roleStatCount}>{myTasks.filter(t => t.status === 'assigned').length}</Text>
                <Text style={styles.roleStatLabel}>Assigned</Text>
              </View>
              <View style={[styles.roleStatCard, { borderLeftColor: '#0EA5E9' }]}>
                <Ionicons name="construct-outline" size={20} color="#0EA5E9" />
                <Text style={styles.roleStatCount}>{myTasks.filter(t => t.status === 'in_progress').length}</Text>
                <Text style={styles.roleStatLabel}>In Progress</Text>
              </View>
              <View style={[styles.roleStatCard, { borderLeftColor: '#10B981' }]}>
                <Ionicons name="checkmark-done-outline" size={20} color="#10B981" />
                <Text style={styles.roleStatCount}>{myTasks.filter(t => t.status === 'completed').length}</Text>
                <Text style={styles.roleStatLabel}>Done Today</Text>
              </View>
            </View>

            {/* My assigned tasks */}
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>My Tasks</Text>
              <TouchableOpacity onPress={() => navigation.navigate('ProductionQueue')}>
                <Text style={{ color: Colors.primary, fontWeight: '600', fontSize: 13 }}>Full Queue →</Text>
              </TouchableOpacity>
            </View>

            {myTasks.filter(t => t.status !== 'completed' && t.status !== 'cancelled').length === 0 ? (
              <View style={styles.roleEmptyCard}>
                <Ionicons name="checkmark-circle-outline" size={40} color="#10B981" />
                <Text style={styles.roleEmptyTitle}>All caught up!</Text>
                <Text style={styles.roleEmptyText}>No pending tasks assigned to you.</Text>
              </View>
            ) : (
              myTasks
                .filter(t => t.status !== 'completed' && t.status !== 'cancelled')
                .map((task) => {
                  const tColor = getTaskChipColor(task.status);
                  const tLabel = TASK_STATUS_LABELS[task.status] || task.status;
                  const isTaskLoading = !!taskActionLoading[task.id];
                  
                  const isUrgent = task.priority === 'urgent';
                  const notes = task.item_special_instructions || task.order_special_instructions || task.special_instructions;
                  
                  let deadlineStr = null;
                  if (task.scheduled_date) {
                    const dt = new Date(task.scheduled_date);
                    deadlineStr = dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
                    if (task.scheduled_time) deadlineStr += `, ${task.scheduled_time.slice(0, 5)}`;
                  }

                  const imageUri = task.product_image || task.item_image_url;

                  return (
                    <TouchableOpacity
                      key={task.id}
                      style={[styles.roleTaskCard, { borderLeftColor: isUrgent ? '#EF4444' : tColor }]}
                      onPress={() => setSelectedTaskModal(task)}
                      activeOpacity={0.8}
                    >
                      <View style={{ flexDirection: 'row', gap: 12 }}>
                        {imageUri ? (
                          <Image source={{ uri: api.getMediaUrl(imageUri) }} style={{ width: 60, height: 60, borderRadius: 8, backgroundColor: '#F3F4F6' }} />
                        ) : (
                          <View style={{ width: 60, height: 60, borderRadius: 8, backgroundColor: '#F3F4F6', alignItems: 'center', justifyContent: 'center' }}>
                            <Ionicons name="image-outline" size={24} color="#D1D5DB" />
                          </View>
                        )}
                        
                        <View style={{ flex: 1 }}>
                          <View style={styles.roleTaskHeader}>
                            <Text style={styles.roleTaskName} numberOfLines={2}>
                              {Number(task.quantity || 1)}× {task.product_name || task.item_product_name || 'Task'}
                            </Text>
                            <View style={[styles.roleTaskBadge, { backgroundColor: (isUrgent ? '#EF4444' : tColor) + '20' }]}>
                              <Text style={[styles.roleTaskBadgeText, { color: isUrgent ? '#EF4444' : tColor }]}>
                                {isUrgent ? 'URGENT' : tLabel}
                              </Text>
                            </View>
                          </View>
                          
                          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 }}>
                            {task.sale_number && <Text style={[styles.roleTaskMeta, { color: '#4B5563', fontWeight: '600' }]}>Order #{task.sale_number}</Text>}
                            {deadlineStr && (
                              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                                <Ionicons name="time-outline" size={12} color={isUrgent ? '#EF4444' : '#6B7280'} />
                                <Text style={[styles.roleTaskMeta, { marginTop: 0, color: isUrgent ? '#EF4444' : '#6B7280', fontWeight: isUrgent ? '700' : '500' }]}>
                                  Due: {deadlineStr}
                                </Text>
                              </View>
                            )}
                          </View>
                        </View>
                      </View>

                      {notes && (
                        <View style={{ marginTop: 10, backgroundColor: '#FEF3C7', padding: 8, borderRadius: 6 }}>
                          <Text style={{ color: '#B45309', fontSize: 12, fontWeight: '500' }}>⚡ {notes}</Text>
                        </View>
                      )}

                      <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: 12, borderTopWidth: 1, borderTopColor: '#F3F4F6', paddingTop: 10 }}>
                        {task.status === 'assigned' && (
                          <TouchableOpacity
                            style={[styles.roleActionBtn, { backgroundColor: '#0EA5E9' }]}
                            onPress={() => advanceTaskStatus(task)}
                            disabled={isTaskLoading}
                          >
                            {isTaskLoading ? <ActivityIndicator size="small" color="#fff" /> : (
                              <Text style={styles.roleActionBtnText}>Start Working →</Text>
                            )}
                          </TouchableOpacity>
                        )}
                        {task.status === 'in_progress' && (
                          <TouchableOpacity
                            style={[styles.roleActionBtn, { backgroundColor: '#10B981' }]}
                            onPress={() => advanceTaskStatus(task)}
                            disabled={isTaskLoading}
                          >
                            {isTaskLoading ? <ActivityIndicator size="small" color="#fff" /> : (
                              <Text style={styles.roleActionBtnText}>Complete Task ✓</Text>
                            )}
                          </TouchableOpacity>
                        )}
                      </View>
                    </TouchableOpacity>
                  );
                })
            )}

            {/* Completed today */}
            {myTasks.filter(t => t.status === 'completed').length > 0 && (
              <>
                <View style={styles.sectionHeader}>
                  <Text style={[styles.sectionTitle, { color: '#10B981' }]}>Completed Today</Text>
                </View>
                {myTasks.filter(t => t.status === 'completed').slice(0, 5).map((task) => (
                  <View key={task.id} style={[styles.roleTaskCard, { borderLeftColor: '#10B981', opacity: 0.7 }]}>
                    <View style={styles.roleTaskHeader}>
                      <Text style={[styles.roleTaskName, { textDecorationLine: 'line-through' }]} numberOfLines={1}>
                        {Number(task.quantity || 1)}× {task.product_name || task.item_product_name || 'Task'}
                      </Text>
                      <Ionicons name="checkmark-circle" size={18} color="#10B981" />
                    </View>
                    {task.sale_number && <Text style={styles.roleTaskMeta}>Order #{task.sale_number}</Text>}
                  </View>
                ))}
              </>
            )}
          </View>
        ) : (
          /* ═══ OWNER / MANAGER DASHBOARD ═══ */
          <View style={[styles.layout, isDesktop && styles.layoutDesktop]}>
            <View style={[styles.feedCol, isDesktop && { flex: 2 }]}>
              <View style={styles.sectionHeader}>
                <View>
                  <Text style={styles.sectionTitle}>Order Management</Text>
                  <Text style={styles.sectionSubtitle}>Tap on any status lane to view full queue</Text>
                </View>
              </View>

              <View style={{ gap: 12 }}>
                {ORDER_TYPES.map(renderOrderTypeSection)}
              </View>
            </View>

            <View style={[styles.healthCol, isDesktop && { flex: 1 }]}>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>Team & Finance</Text>
              </View>

              {/* Staff Pulse Widget */}
              <View style={styles.widgetCard}>
                <View style={styles.widgetHeader}>
                  <Text style={styles.widgetTitle}>Staff Pulse</Text>
                  <TouchableOpacity onPress={() => isOwnerOrManager ? navigation.navigate('More', { screen: 'Staff', initial: false }) : null}>
                    <Ionicons name="open" size={14} color="#9CA3AF" />
                  </TouchableOpacity>
                </View>

                {staffPulse.length === 0 ? (
                  <Text style={styles.emptyWidgetText}>No staff data</Text>
                ) : (
                  <View style={{ gap: 6 }}>
                    {staffPulse.map((s) => <StaffPulseRow key={s.id} staff={s} />)}
                  </View>
                )}
              </View>

              {/* Cash Register Widget */}
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>Registers</Text>
              </View>

              <View style={{ gap: 8 }}>
                {registers.length === 0 ? (
                  <View style={styles.widgetCard}>
                    <Text style={styles.emptyWidgetText}>No register data</Text>
                  </View>
                ) : (
                  registers.map((r) => (
                    <RegisterCard
                      key={r.locationId}
                      item={r}
                      onPress={() => navigation.navigate('POS', {
                        screen: 'CashRegister',
                        params: { locationId: r.locationId }
                      })}
                    />
                  ))
                )}
              </View>

              {/* Revenue Snapshot */}
              {reportKPIs && (
                <>
                  <View style={styles.sectionHeader}>
                    <Text style={styles.sectionTitle}>Revenue</Text>
                  </View>
                  <View style={styles.widgetCard}>
                    <View style={styles.revenueStat}>
                      <Text style={styles.revenueLabel}>Today</Text>
                      <Text style={styles.revenueValue}>{formatMoney(reportKPIs?.today?.revenue)}</Text>
                    </View>
                    <View style={[styles.divider, { marginVertical: 10 }]} />
                    <View style={[styles.rowBetween, { marginBottom: 8 }]}>
                      <View style={styles.revenueStat}>
                        <Text style={styles.revenueLabel}>Yesterday</Text>
                        <Text style={styles.revenueValue}>{formatMoney(reportKPIs?.yesterday?.revenue)}</Text>
                      </View>
                      <View style={styles.revenueStat}>
                        <Text style={styles.revenueLabel}>Week</Text>
                        <Text style={styles.revenueValue}>{formatMoney(reportKPIs?.week?.revenue)}</Text>
                      </View>
                    </View>
                  </View>
                </>
              )}
            </View>
          </View>
        )}
      </ScrollView>

      <TouchableOpacity
        style={styles.fab}
        onPress={() => setFabVisible(true)}
        activeOpacity={0.85}
      >
        <Ionicons name="add" size={28} color="#fff" />
      </TouchableOpacity>

      <TaskDetailModal
        visible={selectedTaskModal !== null}
        task={selectedTaskModal}
        onClose={() => setSelectedTaskModal(null)}
        onAdvance={advanceTaskStatus}
        loading={selectedTaskModal && taskActionLoading[selectedTaskModal.id]}
      />

      <OrderQuickModal
        visible={selectedOrderModal !== null}
        order={selectedOrderModal?.order || null}
        tasks={selectedOrderModal?.tasks || []}
        onClose={() => setSelectedOrderModal(null)}
        onRefresh={fetchDashboard}
        navigation={navigation}
        canManage={isOwnerOrManager}
        onOpenDelivery={(deliveryId) => {
          // Save context so user can return to this order modal
          savedOrderForDelivery.current = selectedOrderModal;
          setSelectedOrderModal(null);
          setSelectedDeliveryId(deliveryId);
        }}
      />

      <DeliveryQuickModal
        visible={selectedDeliveryId !== null}
        deliveryId={selectedDeliveryId}
        onClose={() => setSelectedDeliveryId(null)}
        onRefresh={fetchDashboard}
        navigation={navigation}
        canManage={isOwnerOrManager}
        onBackToSale={savedOrderForDelivery.current ? () => {
          setSelectedDeliveryId(null);
          setSelectedOrderModal(savedOrderForDelivery.current);
          savedOrderForDelivery.current = null;
        } : undefined}
      />

      <Modal visible={fabVisible} transparent animationType="fade" onRequestClose={() => setFabVisible(false)}>
        <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setFabVisible(false)}>
          <View style={styles.quickActionsCard}>
            <View style={styles.quickActionsHeader}>
              <Text style={styles.quickActionsTitle}>Quick Actions</Text>
              <TouchableOpacity onPress={() => setFabVisible(false)}>
                <Ionicons name="close" size={20} color={Colors.textSecondary} />
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              style={[styles.quickActionItem, { borderLeftColor: Colors.secondary, borderLeftWidth: 3, backgroundColor: '#F0FDF4' }]}
              onPress={() => {
                setFabVisible(false);
                navigation.navigate('POS', { screen: 'QuickCheckout', params: { locationId: activeLocation?.id } });
              }}
              activeOpacity={0.8}
            >
              <View style={[styles.quickActionIcon, { backgroundColor: Colors.secondary }]}>
                <Ionicons name="flash" size={18} color="#fff" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.quickActionName}>Quick Checkout</Text>
                <Text style={styles.quickActionMeta}>Fast transaction</Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={Colors.textLight} />
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.quickActionItem, { borderLeftColor: '#0EA5E9', borderLeftWidth: 3, backgroundColor: '#F0F9FF' }]}
              onPress={() => {
                setFabVisible(false);
                navigation.navigate('POS', { screen: 'POSHome' });
              }}
              activeOpacity={0.8}
            >
              <View style={[styles.quickActionIcon, { backgroundColor: '#0EA5E9' }]}>
                <Ionicons name="cart" size={18} color="#fff" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.quickActionName}>POS Terminal</Text>
                <Text style={styles.quickActionMeta}>Full checkout</Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={Colors.textLight} />
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.quickActionItem, { borderLeftColor: '#E11D48', borderLeftWidth: 3, backgroundColor: '#FFE4E6' }]}
              onPress={() => {
                setFabVisible(false);
                navigation.navigate('POS', { screen: 'CashRegister' });
              }}
              activeOpacity={0.8}
            >
              <View style={[styles.quickActionIcon, { backgroundColor: '#E11D48' }]}>
                <Ionicons name="wallet" size={18} color="#fff" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.quickActionName}>Cash Register</Text>
                <Text style={styles.quickActionMeta}>Manage balance</Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={Colors.textLight} />
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  container: { flex: 1 },
  content: { padding: 14, paddingBottom: 100 },

  loadingContainer: {
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 60,
    gap: 12,
  },
  loadingText: {
    fontSize: 14,
    color: Colors.textSecondary,
    fontFamily: FONT_FAMILY,
  },

  heroCard: {
    backgroundColor: Colors.primary,
    borderRadius: 16,
    paddingHorizontal: 18,
    paddingVertical: 18,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: Colors.primaryDark,
    shadowColor: Colors.primary,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.22,
    shadowRadius: 16,
    elevation: 8,
  },
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  heroIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: Colors.primaryDark,
    justifyContent: 'center',
    alignItems: 'center',
  },
  heroEyebrow: {
    fontSize: 12,
    color: Colors.primaryLight,
    fontWeight: '600',
    fontFamily: FONT_FAMILY,
    letterSpacing: 0.5,
  },
  heroTitle: {
    fontSize: 24,
    color: '#fff',
    fontWeight: '800',
    marginTop: 4,
    fontFamily: FONT_FAMILY,
  },
  heroSub: {
    fontSize: 13,
    color: Colors.primaryGlow,
    marginTop: 8,
    lineHeight: 18,
    fontFamily: FONT_FAMILY,
  },

  scopeCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: 14,
  },
  scopeLabel: {
    fontSize: 12,
    color: Colors.textSecondary,
    fontWeight: '700',
    marginBottom: 8,
    fontFamily: FONT_FAMILY,
  },
  scopeChipsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  scopeChip: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
    backgroundColor: Colors.surface,
  },
  scopeChipActive: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  scopeChipText: {
    fontSize: 12,
    color: Colors.textSecondary,
    fontWeight: '700',
    fontFamily: FONT_FAMILY,
  },
  scopeChipTextActive: {
    color: '#fff',
  },

  layout: { gap: 16 },
  layoutDesktop: { flexDirection: 'row', alignItems: 'flex-start' },
  feedCol: { gap: 8 },
  healthCol: { gap: 8 },

  sectionHeader: {
    marginBottom: 12,
    paddingHorizontal: 2,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: Colors.text,
    fontFamily: FONT_FAMILY,
  },
  sectionSubtitle: {
    fontSize: 12,
    color: Colors.textLight,
    marginTop: 3,
    fontFamily: FONT_FAMILY,
  },

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

  widgetCard: {
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 6,
    elevation: 1,
  },
  widgetHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  widgetTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: Colors.text,
    fontFamily: FONT_FAMILY,
  },
  emptyWidgetText: {
    fontSize: 12,
    color: Colors.textLight,
    fontStyle: 'italic',
    fontFamily: FONT_FAMILY,
  },

  staffRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingHorizontal: 9,
    paddingVertical: 8,
    borderRadius: 8,
  },
  staffRing: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  staffName: {
    fontSize: 12,
    fontWeight: '700',
    color: Colors.text,
    fontFamily: FONT_FAMILY,
  },
  staffMeta: {
    fontSize: 10,
    color: Colors.textSecondary,
    marginTop: 1,
    fontFamily: FONT_FAMILY,
  },
  staffMetaSub: {
    fontSize: 10,
    color: Colors.secondary,
    marginTop: 2,
    fontFamily: FONT_FAMILY,
    fontWeight: '600',
  },
  pulseBadge: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  pulseBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    fontFamily: FONT_FAMILY,
  },

  registerCard: {
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 6,
    elevation: 1,
  },
  registerTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: Colors.text,
    fontFamily: FONT_FAMILY,
  },
  registerStatus: {
    fontSize: 11,
    fontWeight: '700',
    marginTop: 3,
    fontFamily: FONT_FAMILY,
  },
  registerLabel: {
    fontSize: 10,
    color: Colors.textSecondary,
    fontWeight: '700',
    fontFamily: FONT_FAMILY,
  },
  registerValue: {
    fontSize: 12,
    color: Colors.text,
    fontWeight: '800',
    marginTop: 2,
    fontFamily: FONT_FAMILY,
  },
  divider: {
    height: 1,
    backgroundColor: Colors.border,
    marginVertical: 8,
  },

  revenueStat: {
    alignItems: 'center',
  },
  revenueLabel: {
    fontSize: 11,
    color: Colors.textSecondary,
    fontWeight: '700',
    fontFamily: FONT_FAMILY,
  },
  revenueValue: {
    fontSize: 14,
    color: Colors.secondary,
    fontWeight: '800',
    marginTop: 3,
    fontFamily: FONT_FAMILY,
  },

  fab: {
    position: 'absolute',
    right: 20,
    bottom: 22,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#047857',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#047857',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 8,
  },

  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.5)',
    justifyContent: 'flex-end',
  },
  quickActionsCard: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 28,
    gap: 10,
  },
  quickActionsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  quickActionsTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#111827',
    fontFamily: FONT_FAMILY,
  },
  quickActionItem: {
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  quickActionIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  quickActionName: {
    fontSize: 14,
    fontWeight: '700',
    color: '#111827',
    fontFamily: FONT_FAMILY,
  },
  quickActionMeta: {
    fontSize: 11,
    color: '#6B7280',
    marginTop: 2,
    fontFamily: FONT_FAMILY,
  },

  taskModalCard: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    marginTop: 'auto',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 24,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 14,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#111827',
    flex: 1,
    fontFamily: FONT_FAMILY,
  },
  modalContent: {
    gap: 12,
    marginBottom: 14,
  },
  detailRow: {
    gap: 8,
  },
  detailLabel: {
    fontSize: 11,
    color: '#6B7280',
    fontWeight: '700',
    fontFamily: FONT_FAMILY,
  },
  detailValue: {
    fontSize: 13,
    color: '#111827',
    fontWeight: '600',
    fontFamily: FONT_FAMILY,
    lineHeight: 18,
  },
  statusPill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    alignSelf: 'flex-start',
  },
  statusPillText: {
    fontSize: 12,
    fontWeight: '800',
    fontFamily: FONT_FAMILY,
  },
  advanceButton: {
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  advanceButtonText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 14,
    fontFamily: FONT_FAMILY,
  },

  // ─── Role-based dashboard styles ──────────────────────────
  roleStatsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  roleStatCard: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 12,
    borderLeftWidth: 4,
    alignItems: 'center',
    gap: 4,
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 1,
  },
  roleStatCount: {
    fontSize: 22,
    fontWeight: '800',
    color: '#111827',
    fontFamily: FONT_FAMILY,
  },
  roleStatLabel: {
    fontSize: 11,
    color: '#6B7280',
    fontWeight: '600',
    fontFamily: FONT_FAMILY,
  },
  roleTaskCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    borderLeftWidth: 4,
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 1,
  },
  roleTaskHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  roleTaskName: {
    fontSize: 15,
    fontWeight: '700',
    color: '#111827',
    flex: 1,
    marginRight: 8,
    fontFamily: FONT_FAMILY,
  },
  roleTaskBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  roleTaskBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
    fontFamily: FONT_FAMILY,
  },
  roleTaskMeta: {
    fontSize: 12,
    color: '#6B7280',
    marginTop: 2,
    fontFamily: FONT_FAMILY,
  },
  roleActionBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 80,
  },
  roleActionBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 13,
    fontFamily: FONT_FAMILY,
  },
  roleEmptyCard: {
    backgroundColor: '#F0FDF4',
    borderRadius: 16,
    padding: 32,
    alignItems: 'center',
    gap: 8,
  },
  roleEmptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#065F46',
    fontFamily: FONT_FAMILY,
  },
  roleEmptyText: {
    fontSize: 13,
    color: '#6B7280',
    fontFamily: FONT_FAMILY,
  },
});
