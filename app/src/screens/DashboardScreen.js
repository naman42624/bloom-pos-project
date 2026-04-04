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
  useWindowDimensions,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { Colors, FontSize, Spacing } from '../constants/theme';
import { minutesSinceServerDate, minutesUntilShopDateTime } from '../utils/datetime';

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

const FONT_FAMILY = typeof navigator !== 'undefined' && navigator.product === 'ReactNative'
  ? undefined
  : 'Inter, Geist, system-ui';

function formatMoney(value) {
  return `₹${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function formatOrderType(value) {
  return ORDER_TYPE_LABELS[value] || value || 'Order';
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

function RegisterCard({ item }) {
  const { locationName, isOpen, register } = item;
  const tone = isOpen ? '#10B981' : '#E11D48';
  return (
    <View style={[styles.registerCard, { borderLeftColor: tone, borderLeftWidth: 4 }]}>
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
    </View>
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

function OrderCard({ order, tasks, hasPendingProduction, pulseOpacity, onTaskClick, taskActionLoading, onOpen }) {
  const phaseStatus = normalizeOrderPhase(order.status);
  const statusTone = getOrderStatusTone(phaseStatus);
  const stats = {
    pending: tasks.filter((t) => t.status === 'pending').length,
    assigned: tasks.filter((t) => t.status === 'assigned').length,
    inProgress: tasks.filter((t) => t.status === 'in_progress').length,
    done: tasks.filter((t) => t.status === 'completed').length,
  };
  const totalTasks = tasks.length;

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
        <View style={[styles.statusBadge, { backgroundColor: statusTone + '15', borderColor: statusTone }]}>
          <Text style={[styles.statusBadgeText, { color: statusTone }]}>{ORDER_PHASE_LABELS[phaseStatus] || ORDER_STATUS_LABELS[order.status] || order.status}</Text>
        </View>
      </View>

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
        <Text style={styles.noTasksLabel}>No tasks assigned</Text>
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

  const [locations, setLocations] = useState([]);
  const [locationScope, setLocationScope] = useState(null);
  const [sales, setSales] = useState([]);
  const [taskRows, setTaskRows] = useState([]);
  const [staffPulse, setStaffPulse] = useState([]);
  const [registers, setRegisters] = useState([]);
  const [reportKPIs, setReportKPIs] = useState(null);

  const [taskActionLoading, setTaskActionLoading] = useState({});

  const role = user?.role;
  const isOwner = role === 'owner';
  const isStaff = role === 'owner' || role === 'manager' || role === 'employee';
  const isOwnerOrManager = role === 'owner' || role === 'manager';
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
  }, [activeLocation?.id, isOwner, isOwnerOrManager, isStaff, locationScope, role, user?.id, user?.name]);

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
                  onOpen={() => navigation.navigate('SaleDetail', { saleId: order.id })}
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
          <Text style={styles.heroSub}>Real-time order flow, production pipeline, and operational health metrics</Text>
        </View>

        {locations.length > 0 && (
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
        ) : (
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
                  registers.map((r) => <RegisterCard key={r.locationId} item={r} />)
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
  noTasksLabel: {
    fontSize: 11,
    color: Colors.textLight,
    fontStyle: 'italic',
    fontFamily: FONT_FAMILY,
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
});
