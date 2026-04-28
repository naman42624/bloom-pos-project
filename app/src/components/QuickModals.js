/**
 * QuickModals.js
 * Reusable bottom-sheet / centered-dialog modals for quick status updates and detail previews.
 *
 * Exports:
 *  - OrderQuickModal   — sale/order overview with status action buttons
 *  - DeliveryQuickModal — delivery status + partner assignment + actions
 *
 * Design:
 *  - Mobile (< 768px): bottom sheet with drag handle, KeyboardAvoidingView
 *  - Tablet/Desktop (≥ 768px): centered dialog, max-width 520px
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  FlatList,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';
import { Colors } from '../constants/theme';

// ─── Shared constants ────────────────────────────────────────────────────────

const FONT_FAMILY =
  typeof navigator !== 'undefined' && navigator.product === 'ReactNative'
    ? undefined
    : 'Inter, Geist, system-ui';

const ORDER_STATUS_COLORS = {
  pending: '#F59E0B',
  confirmed: '#F59E0B',
  preparing: '#0EA5E9',
  ready: '#10B981',
  completed: '#10B981',
  cancelled: '#E11D48',
  draft: '#9CA3AF',
};

const PAYMENT_STATUS_COLORS = {
  paid: '#10B981',
  partial: '#F59E0B',
  pending: '#E11D48',
  refunded: '#9CA3AF',
};

const PICKUP_STATUS_COLORS = {
  waiting: '#F59E0B',
  ready_for_pickup: '#10B981',
  picked_up: '#6366F1',
};

const PICKUP_STATUS_LABELS = {
  waiting: 'Waiting',
  ready_for_pickup: 'Ready for Pickup',
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatMoney(value) {
  return `₹${Number(value || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

function formatDateTime(dateStr, timeStr) {
  try {
    if (!dateStr) return '';
    let localDate = dateStr;
    if (dateStr.includes('T') || dateStr.includes('Z')) {
      const d = new Date(dateStr);
      if (!isNaN(d.getTime())) {
        localDate = d.toLocaleDateString('en-CA');
      }
    }
    const [, month, day] = localDate.split('-').map(Number);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const datePart = `${day} ${months[month - 1]}`;
    if (!timeStr) return datePart;
    const [hh, mm] = String(timeStr).split(':').map(Number);
    const ampm = hh >= 12 ? 'PM' : 'AM';
    return `${datePart}, ${hh % 12 || 12}:${String(mm || 0).padStart(2, '0')} ${ampm}`;
  } catch { return dateStr || ''; }
}

function BadgePill({ label, color, size = 'sm' }) {
  const fontSize = size === 'xs' ? 9 : size === 'sm' ? 11 : 13;
  return (
    <View style={[styles.pill, { backgroundColor: color + '18', borderColor: color + '60' }]}>
      <Text style={[styles.pillText, { color, fontSize }]}>{label}</Text>
    </View>
  );
}

function SectionRow({ label, value, color }) {
  return (
    <View style={styles.sectionRow}>
      <Text style={styles.sectionLabel}>{label}</Text>
      <Text style={[styles.sectionValue, color ? { color } : {}]}>{value}</Text>
    </View>
  );
}

/**
 * Responsive sheet wrapper: bottom sheet on mobile, centered dialog on wider screens.
 * Handles keyboard avoidance automatically.
 */
function SheetWrapper({ visible, onClose, children }) {
  const { width } = useWindowDimensions();
  const isWide = width >= 520;

  return (
    <Modal
      visible={visible}
      transparent
      animationType={isWide ? 'fade' : 'slide'}
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 24}
      >
        <TouchableOpacity
          style={[styles.backdrop, isWide && styles.backdropCentered]}
          activeOpacity={1}
          onPress={onClose}
        >
          <TouchableOpacity
            activeOpacity={1}
            style={[
              styles.sheet,
              isWide
                ? styles.sheetWide
                : styles.sheetMobile,
            ]}
          >
            {!isWide && <View style={styles.dragHandle} />}
            {children}
          </TouchableOpacity>
        </TouchableOpacity>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ─── OrderQuickModal ─────────────────────────────────────────────────────────

/**
 * @param {object} props
 * @param {boolean} props.visible
 * @param {object|null} props.order — sale row from dashboard
 * @param {Array} props.tasks — tasks for this order
 * @param {Function} props.onClose
 * @param {Function} props.onRefresh — called after a status change
 * @param {Function} [props.onOpenDelivery] — called with deliveryId to open DeliveryQuickModal
 * @param {object} props.navigation
 * @param {boolean} props.canManage
 */
export function OrderQuickModal({
  visible,
  order,
  tasks,
  onClose,
  onRefresh,
  onOpenDelivery,
  navigation,
  canManage,
}) {
  const [actionLoading, setActionLoading] = useState(false);
  const [deliveryLoading, setDeliveryLoading] = useState(false);
  const [deliveryInfo, setDeliveryInfo] = useState(null);

  // Local tasks state — mirrors props but updates after actions for immediate UI feedback
  const [localTasks, setLocalTasks] = useState(tasks || []);

  // Per-task action state
  const [taskLoading, setTaskLoading] = useState({}); // { [taskId]: true }
  const [showEmployeePicker, setShowEmployeePicker] = useState(null); // taskId being assigned
  const [employees, setEmployees] = useState([]);
  const [employeesLoading, setEmployeesLoading] = useState(false);

  // Sync localTasks when tasks prop changes (e.g. on reopen)
  useEffect(() => {
    setLocalTasks(tasks || []);
  }, [tasks]);

  // Helper: re-fetch tasks for this sale and update local state
  const refreshLocalTasks = useCallback(async () => {
    if (!order?.id) return;
    try {
      const res = await api.getProductionTasks({ sale_id: order.id });
      const fresh = res?.data || [];
      setLocalTasks(fresh);
    } catch {}
  }, [order?.id]);

  // Reset all local state whenever the modal opens for a new order
  useEffect(() => {
    if (!visible) {
      setDeliveryInfo(null);
      setDeliveryLoading(false);
      setActionLoading(false);
      setTaskLoading({});
      setShowEmployeePicker(null);
      return;
    }
    if (order?.order_type === 'delivery' && order?.id) {
      setDeliveryLoading(true);
      api.getSale(order.id)
        .then((res) => setDeliveryInfo(res?.data?.delivery || null))
        .catch(() => setDeliveryInfo(null))
        .finally(() => setDeliveryLoading(false));
    }
  }, [visible, order?.id, order?.order_type]);

  const doStatusChange = useCallback(async (nextStatus) => {
    if (!order?.id) return;
    setActionLoading(true);
    try {
      await api.updateOrderStatus(order.id, nextStatus);
      onRefresh?.();
      onClose();
    } catch (err) {
      const msg = err?.message || 'Failed to update status';
      Platform.OS === 'web' ? window.alert(msg) : Alert.alert('Error', msg);
    } finally {
      setActionLoading(false);
    }
  }, [order?.id, onRefresh, onClose]);

  const confirmAction = useCallback((label, nextStatus, msg) => {
    const message = msg || `${label} this order?`;
    if (Platform.OS === 'web') {
      if (window.confirm(message)) doStatusChange(nextStatus);
    } else {
      Alert.alert(label, message, [
        { text: 'Cancel', style: 'cancel' },
        { text: label, onPress: () => doStatusChange(nextStatus) },
      ]);
    }
  }, [doStatusChange]);

  // Task actions
  const openEmployeePicker = useCallback(async (taskId) => {
    setShowEmployeePicker(taskId);
    setEmployeesLoading(true);
    try {
      const res = await api.getUsers();
      const all = res?.data?.users || res?.data || [];
      setEmployees(Array.isArray(all) ? all.filter((u) => ['owner','manager','employee'].includes(u.role)) : []);
    } catch { setEmployees([]); }
    finally { setEmployeesLoading(false); }
  }, []);

  const handleTaskAssign = useCallback(async (taskId, employeeId) => {
    setTaskLoading((p) => ({ ...p, [taskId]: true }));
    try {
      await api.assignTask(taskId, { assigned_to: employeeId });
      setShowEmployeePicker(null);
      await refreshLocalTasks();
      onRefresh?.();
    } catch (err) {
      const msg = err?.message || 'Failed to assign';
      Platform.OS === 'web' ? window.alert(msg) : Alert.alert('Error', msg);
    } finally {
      setTaskLoading((p) => ({ ...p, [taskId]: false }));
    }
  }, [onRefresh, refreshLocalTasks]);

  const handleTaskStart = useCallback(async (taskId) => {
    setTaskLoading((p) => ({ ...p, [taskId]: true }));
    try {
      await api.startTask(taskId);
      await refreshLocalTasks();
      onRefresh?.();
    } catch (err) {
      const msg = err?.message || 'Failed to start';
      Platform.OS === 'web' ? window.alert(msg) : Alert.alert('Error', msg);
    } finally {
      setTaskLoading((p) => ({ ...p, [taskId]: false }));
    }
  }, [onRefresh, refreshLocalTasks]);

  const handleTaskComplete = useCallback(async (taskId) => {
    const doComplete = async () => {
      setTaskLoading((p) => ({ ...p, [taskId]: true }));
      try {
        await api.completeTask(taskId);
        await refreshLocalTasks();
        onRefresh?.();
      } catch (err) {
        const msg = err?.message || 'Failed to complete';
        Platform.OS === 'web' ? window.alert(msg) : Alert.alert('Error', msg);
      } finally {
        setTaskLoading((p) => ({ ...p, [taskId]: false }));
      }
    };

    if (Platform.OS === 'web') {
      if (window.confirm('Mark this task as done? Materials will be deducted.')) {
        doComplete();
      }
    } else {
      Alert.alert('Complete Task', 'Mark this task as done? Materials will be deducted.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Complete', onPress: doComplete },
      ]);
    }
  }, [onRefresh, refreshLocalTasks]);

  if (!order) return null;

  const orderStatus = order.status || 'pending';
  const orderType = order.order_type || 'walk_in';
  const orderColor = ORDER_STATUS_COLORS[orderStatus] || '#9CA3AF';
  const isCredit = order.is_credit_sale === 1;
  const payColor = isCredit ? '#8B5CF6' : (PAYMENT_STATUS_COLORS[order.payment_status] || '#9CA3AF');

  const taskTotal = localTasks?.length || 0;
  const taskDone = localTasks?.filter((t) => t.status === 'completed').length || 0;
  const taskActive = localTasks?.filter((t) => ['pending', 'assigned', 'in_progress'].includes(t.status)).length || 0;
  const isFinal = ['completed', 'cancelled'].includes(orderStatus);

  const delivColor = deliveryInfo ? (DELIVERY_STATUS_COLORS[deliveryInfo.status] || '#9CA3AF') : null;

  // Contextual status actions
  const statusActions = [];
  if (!isFinal) {
    if (orderStatus === 'pending' || orderStatus === 'confirmed') {
      statusActions.push({ label: 'Mark Preparing', next: 'preparing', color: '#0EA5E9', icon: 'construct-outline' });
    }
    if (orderStatus === 'preparing') {
      statusActions.push({ label: 'Mark Ready', next: 'ready', color: '#10B981', icon: 'checkmark-circle-outline' });
    }
    if (orderStatus === 'ready' && orderType !== 'delivery') {
      statusActions.push({ label: 'Complete Order', next: 'completed', color: '#6366F1', icon: 'bag-check-outline' });
    }
    if (canManage) {
      statusActions.push({ label: 'Cancel Order', next: 'cancelled', color: '#E11D48', icon: 'close-circle-outline' });
    }
  }

  return (
    <SheetWrapper visible={visible} onClose={onClose}>
      {/* Header */}
      <View style={styles.sheetHeader}>
        <View style={{ flex: 1 }}>
          <Text style={styles.sheetTitle}>#{order.sale_number}</Text>
          <Text style={styles.sheetSubtitle}>
            {order.customer_name || 'Guest'} • {orderType.replace(/_/g, ' ')}
          </Text>
        </View>
        <TouchableOpacity onPress={onClose} hitSlop={10} style={styles.closeBtn}>
          <Ionicons name="close" size={20} color="#6B7280" />
        </TouchableOpacity>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} style={styles.sheetBody} keyboardShouldPersistTaps="handled">
        {/* Status badges */}
        <View style={styles.badgesRow}>
          <BadgePill label={(orderStatus).replace(/_/g, ' ').toUpperCase()} color={orderColor} />
          <BadgePill
            label={isCredit ? 'CREDIT' : order.payment_status === 'pending' ? 'PAY: UNPAID' : order.payment_status === 'partial' ? 'PAY: PARTIAL' : (order.payment_status || 'pending').toUpperCase()}
            color={payColor}
          />
          {orderType === 'pickup' && order.pickup_status && (
            <BadgePill
              label={PICKUP_STATUS_LABELS[order.pickup_status] || order.pickup_status}
              color={PICKUP_STATUS_COLORS[order.pickup_status] || '#9CA3AF'}
            />
          )}
        </View>

        {/* Key details */}
        <View style={styles.detailsCard}>
          <SectionRow label="Total" value={formatMoney(order.grand_total)} color={Colors.secondary || '#6366F1'} />
          {order.scheduled_date && (
            <SectionRow
              label="Scheduled"
              value={formatDateTime(order.scheduled_date, order.scheduled_time)}
              color="#6366F1"
            />
          )}
          {order.delivery_address && (
            <SectionRow label="Address" value={order.delivery_address} />
          )}
          {order.notes && (
            <SectionRow label="Notes" value={order.notes} />
          )}
        </View>

        {/* Delivery status block */}
        {orderType === 'delivery' && (
          <View style={[styles.subCard, { borderLeftColor: delivColor || '#9CA3AF' }]}>
            <View style={styles.subCardHeader}>
              <Ionicons name="bicycle-outline" size={16} color={delivColor || '#9CA3AF'} />
              <Text style={[styles.subCardTitle, { color: delivColor || '#9CA3AF' }]}>Delivery Status</Text>
              {deliveryLoading && <ActivityIndicator size="small" color="#9CA3AF" style={{ marginLeft: 8 }} />}
            </View>
            {deliveryInfo ? (
              <>
                <BadgePill
                  label={DELIVERY_STATUS_LABELS[deliveryInfo.status] || deliveryInfo.status}
                  color={delivColor || '#9CA3AF'}
                />
                {deliveryInfo.partner_name && (
                  <Text style={styles.subCardMeta}>Partner: {deliveryInfo.partner_name}</Text>
                )}
                {deliveryInfo.cod_amount > 0 && (
                  <Text style={styles.subCardMeta}>
                    COD: {formatMoney(deliveryInfo.cod_amount)} ({(deliveryInfo.cod_status || 'pending').replace(/_/g, ' ')})
                  </Text>
                )}
                {canManage && (
                  <TouchableOpacity
                    style={[styles.subCardLinkBtn, { marginTop: 8 }]}
                    onPress={() => {
                      // Close this modal first, then tell the parent to open DeliveryQuickModal
                      onClose();
                      onOpenDelivery?.(deliveryInfo.id);
                    }}
                  >
                    <Ionicons name="pencil-outline" size={13} color={Colors.primary} />
                    <Text style={styles.subCardLinkText}>Manage Delivery →</Text>
                  </TouchableOpacity>
                )}
              </>
            ) : !deliveryLoading ? (
              <Text style={styles.subCardMeta}>No delivery record found</Text>
            ) : null}
          </View>
        )}

        {/* Production task list */}
        {taskTotal > 0 && (
          <View style={styles.taskBlock}>
            {/* Header + progress bar */}
            <View style={styles.taskBlockHeader}>
              <Ionicons name="hammer-outline" size={13} color="#374151" />
              <Text style={styles.taskBlockTitle}>
                Production Tasks ({taskDone}/{taskTotal} done{taskActive > 0 ? ` · ${taskActive} active` : ''})
              </Text>
            </View>
            <View style={[styles.taskBar, { marginBottom: 10 }]}>
              <View style={[styles.taskBarFill, { width: taskTotal > 0 ? `${Math.round((taskDone / taskTotal) * 100)}%` : '0%' }]} />
            </View>

            {/* Employee picker (shown when assigning a specific task) */}
            {showEmployeePicker && (
              <View style={styles.inlineForm}>
                <Text style={styles.formTitle}>Assign to Employee</Text>
                {employeesLoading ? (
                  <ActivityIndicator color={Colors.primary} style={{ marginVertical: 10 }} />
                ) : employees.length === 0 ? (
                  <Text style={styles.emptyText}>No employees found</Text>
                ) : (
                  <FlatList
                    data={employees}
                    keyExtractor={(e) => String(e.id)}
                    style={{ maxHeight: 200 }}
                    renderItem={({ item: emp }) => (
                      <TouchableOpacity
                        style={styles.partnerItem}
                        onPress={() => handleTaskAssign(showEmployeePicker, emp.id)}
                        disabled={!!taskLoading[showEmployeePicker]}
                      >
                        <View style={styles.partnerAvatar}>
                          <Ionicons name="person" size={16} color={Colors.primary} />
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.partnerName}>{emp.name}</Text>
                          <Text style={styles.partnerPhone}>{emp.role}</Text>
                        </View>
                        {taskLoading[showEmployeePicker] ? (
                          <ActivityIndicator size="small" color={Colors.primary} />
                        ) : (
                          <Ionicons name="chevron-forward" size={16} color="#9CA3AF" />
                        )}
                      </TouchableOpacity>
                    )}
                  />
                )}
                <TouchableOpacity style={styles.cancelSmallBtn} onPress={() => setShowEmployeePicker(null)}>
                  <Ionicons name="close" size={14} color="#6B7280" />
                  <Text style={styles.cancelSmallText}>Cancel</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* Task rows */}
            {(localTasks || []).map((task) => {
              const tColor = {
                pending: '#F59E0B', assigned: '#6366F1',
                in_progress: '#0EA5E9', completed: '#10B981', cancelled: '#9CA3AF',
              }[task.status] || '#9CA3AF';
              const tLabel = {
                pending: 'Queued', assigned: 'Assigned',
                in_progress: 'In Progress', completed: 'Done', cancelled: 'Cancelled',
              }[task.status] || task.status;
              const isLoading = !!taskLoading[task.id];
              const isDone = task.status === 'completed' || task.status === 'cancelled';

              return (
                <View key={task.id} style={[styles.taskRow, { borderLeftColor: tColor }]}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.taskRowName} numberOfLines={1}>
                      {Number(task.quantity || 1)}× {task.product_name || task.item_product_name || 'Item'}
                    </Text>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 }}>
                      <View style={[styles.taskStatusDot, { backgroundColor: tColor }]} />
                      <Text style={[styles.taskStatusLabel, { color: tColor }]}>{tLabel}</Text>
                      {task.assigned_to_name ? (
                        <Text style={styles.taskAssignee}>· {task.assigned_to_name}</Text>
                      ) : null}
                    </View>
                  </View>

                  {!isDone && !showEmployeePicker && (
                    <View style={{ gap: 4 }}>
                      {canManage && (task.status === 'pending' || task.status === 'assigned') && (
                        <TouchableOpacity
                          style={[styles.taskActionBtn, { backgroundColor: '#6366F1' }]}
                          onPress={() => openEmployeePicker(task.id)}
                          disabled={isLoading}
                        >
                          {isLoading ? <ActivityIndicator size="small" color="#fff" /> : (
                            <Text style={styles.taskActionBtnText}>
                              {task.assigned_to ? 'Reassign' : 'Assign'}
                            </Text>
                          )}
                        </TouchableOpacity>
                      )}
                      {task.status === 'assigned' && (
                        <TouchableOpacity
                          style={[styles.taskActionBtn, { backgroundColor: '#0EA5E9' }]}
                          onPress={() => handleTaskStart(task.id)}
                          disabled={isLoading}
                        >
                          {isLoading ? <ActivityIndicator size="small" color="#fff" /> : (
                            <Text style={styles.taskActionBtnText}>Start</Text>
                          )}
                        </TouchableOpacity>
                      )}
                      {task.status === 'in_progress' && (
                        <TouchableOpacity
                          style={[styles.taskActionBtn, { backgroundColor: '#10B981' }]}
                          onPress={() => handleTaskComplete(task.id)}
                          disabled={isLoading}
                        >
                          {isLoading ? <ActivityIndicator size="small" color="#fff" /> : (
                            <Text style={styles.taskActionBtnText}>Done</Text>
                          )}
                        </TouchableOpacity>
                      )}
                    </View>
                  )}
                </View>
              );
            })}
          </View>
        )}

        {/* Quick status actions */}
        {!isFinal && statusActions.length > 0 && canManage && (
          <View style={styles.actionsBlock}>
            <Text style={styles.actionsTitle}>Quick Actions</Text>
            <View style={{ gap: 8 }}>
              {statusActions.map((action) => (
                <TouchableOpacity
                  key={action.next}
                  style={[styles.actionBtnFull, { backgroundColor: action.color, opacity: actionLoading ? 0.6 : 1 }]}
                  disabled={actionLoading}
                  onPress={() => confirmAction(action.label, action.next)}
                >
                  {actionLoading ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <>
                      <Ionicons name={action.icon} size={16} color="#fff" />
                      <Text style={styles.actionBtnText}>{action.label}</Text>
                    </>
                  )}
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}
      </ScrollView>

      {/* Sticky footer — Open Full Details */}
      <View style={styles.sheetFooter}>
        <TouchableOpacity
          style={styles.fullDetailsBtn}
          onPress={() => {
            onClose();
            // Small delay to let sheet close before navigating
            setTimeout(() => navigation.navigate('SaleDetail', { saleId: order.id }), 200);
          }}
        >
          <Ionicons name="document-text-outline" size={17} color={Colors.primary} />
          <Text style={styles.fullDetailsBtnText}>Open Full Sale Details</Text>
          <Ionicons name="chevron-forward" size={15} color={Colors.primary} />
        </TouchableOpacity>
      </View>
    </SheetWrapper>
  );
}

// ─── DeliveryQuickModal ──────────────────────────────────────────────────────

/**
 * @param {object} props
 * @param {boolean} props.visible
 * @param {number|string} props.deliveryId
 * @param {Function} props.onClose
 * @param {Function} props.onRefresh — called after an action
 * @param {object} props.navigation
 * @param {boolean} props.canManage
 * @param {boolean} [props.isPartner]
 */
export function DeliveryQuickModal({
  visible,
  deliveryId,
  onClose,
  onRefresh,
  onBackToSale,
  navigation,
  canManage,
  isPartner = false,
}) {
  const [delivery, setDelivery] = useState(null);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  // Partner assignment
  const [showAssign, setShowAssign] = useState(false);
  const [partners, setPartners] = useState([]);
  const [partnersLoading, setPartnersLoading] = useState(false);

  // COD / fail forms
  const [showCodForm, setShowCodForm] = useState(false);
  const [showFailForm, setShowFailForm] = useState(false);
  const [codAmount, setCodAmount] = useState('');
  const [codMethod, setCodMethod] = useState('cash');
  const [failReason, setFailReason] = useState('');

  const fetchDelivery = useCallback(async () => {
    if (!deliveryId) return;
    setLoading(true);
    try {
      const res = await api.getDelivery(deliveryId);
      const d = res?.data;
      setDelivery(d || null);
      if (d?.cod_amount) {
        const remaining = Math.max(Number(d.cod_amount) - Number(d.cod_collected || 0), 0);
        setCodAmount(String(Math.round(remaining)));
      }
    } catch {
      setDelivery(null);
    } finally {
      setLoading(false);
    }
  }, [deliveryId]);

  useEffect(() => {
    if (visible && deliveryId) {
      setShowAssign(false);
      setShowCodForm(false);
      setShowFailForm(false);
      setFailReason('');
      fetchDelivery();
    } else if (!visible) {
      // Reset on close
      setDelivery(null);
      setShowAssign(false);
      setShowCodForm(false);
      setShowFailForm(false);
    }
  }, [visible, deliveryId, fetchDelivery]);

  const doAction = useCallback(async (action, data = {}) => {
    setActionLoading(true);
    try {
      if (action === 'pickup') await api.pickupDelivery(deliveryId);
      else if (action === 'in_transit') await api.markInTransit(deliveryId);
      else if (action === 'deliver') await api.deliverOrder(deliveryId, data);
      else if (action === 'fail') await api.failDelivery(deliveryId, data);
      else if (action === 'reattempt') await api.reattemptDelivery(deliveryId);
      await fetchDelivery();
      onRefresh?.();
      setShowCodForm(false);
      setShowFailForm(false);
    } catch (err) {
      const msg = err?.message || 'Action failed';
      Platform.OS === 'web' ? window.alert(msg) : Alert.alert('Error', msg);
    } finally {
      setActionLoading(false);
    }
  }, [deliveryId, fetchDelivery, onRefresh]);

  const openAssign = async () => {
    setPartnersLoading(true);
    setShowAssign(true);
    try {
      const res = await api.getUsers({ role: 'delivery_partner', limit: 100 });
      const users = res?.data?.users || res?.data || [];
      setPartners(Array.isArray(users) ? users.filter((u) => u.is_active) : []);
    } catch {
      setPartners([]);
    } finally {
      setPartnersLoading(false);
    }
  };

  const handleAssign = async (partnerId) => {
    setActionLoading(true);
    try {
      await api.assignDelivery(deliveryId, { delivery_partner_id: partnerId });
      setShowAssign(false);
      await fetchDelivery();
      onRefresh?.();
    } catch (err) {
      Alert.alert('Error', err?.message || 'Failed to assign partner');
    } finally {
      setActionLoading(false);
    }
  };

  const handleDeliver = () => {
    const data = {};
    if (delivery?.cod_amount > 0) {
      const amt = parseFloat(codAmount);
      if (isNaN(amt) || amt < 0) {
        const msg = 'Enter a valid COD amount';
        Platform.OS === 'web' ? window.alert(msg) : Alert.alert('Error', msg);
        return;
      }
      data.cod_collected = amt;
      data.cod_method = codMethod;
    }
    doAction('deliver', data);
  };

  const handleFail = () => {
    if (!failReason.trim()) {
      const msg = 'Please enter a reason for failure';
      Platform.OS === 'web' ? window.alert(msg) : Alert.alert('Error', msg);
      return;
    }
    doAction('fail', { failure_reason: failReason.trim() });
  };

  const delivStatus = delivery?.status;
  const delivColor = DELIVERY_STATUS_COLORS[delivStatus] || '#9CA3AF';
  const isFinal = ['delivered', 'failed', 'cancelled'].includes(delivStatus);
  const codRemaining = delivery ? Math.max(Number(delivery.cod_amount || 0) - Number(delivery.cod_collected || 0), 0) : 0;
  const isCredit = delivery?.is_credit_sale === 1;

  const handleConvertPayment = async (action) => {
    if (!delivery) return;
    const msg = action === 'to_cod' 
      ? 'Convert this credit order to Cash on Delivery?'
      : 'Convert this COD order to a Credit Sale? (Requires customer details)';
      
    const confirmConversion = async () => {
      setActionLoading(true);
      try {
        await api.convertDeliveryPayment(delivery.id, { action });
        await fetchDelivery();
        if (onRefresh) onRefresh();
      } catch (err) {
        const errorMsg = err.response?.data?.message || err.message || 'Failed to convert payment';
        Platform.OS === 'web' ? window.alert(errorMsg) : Alert.alert('Error', errorMsg);
      } finally {
        setActionLoading(false);
      }
    };

    if (Platform.OS === 'web') {
      if (window.confirm(msg)) confirmConversion();
    } else {
      Alert.alert('Confirm Conversion', msg, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Convert', style: 'default', onPress: confirmConversion }
      ]);
    }
  };

  return (
    <SheetWrapper visible={visible} onClose={onClose}>
      {/* Header */}
      <View style={styles.sheetHeader}>
        {/* Back to sale button */}
        {onBackToSale && (
          <TouchableOpacity
            onPress={() => { onClose(); onBackToSale(); }}
            hitSlop={8}
            style={styles.backBtn}
          >
            <Ionicons name="arrow-back" size={18} color={Colors.primary} />
          </TouchableOpacity>
        )}
        <View style={{ flex: 1 }}>
          <Text style={styles.sheetTitle}>
            Delivery {delivery?.sale_number ? `#${delivery.sale_number}` : ''}
          </Text>
          <Text style={styles.sheetSubtitle}>
            {delivery?.customer_name || delivery?.receiver_name || 'Customer'} • Quick View
          </Text>
        </View>
        <TouchableOpacity onPress={onClose} hitSlop={10} style={styles.closeBtn}>
          <Ionicons name="close" size={20} color="#6B7280" />
        </TouchableOpacity>
      </View>

      {/* Body */}
      {loading ? (
        <View style={styles.loadingBox}>
          <ActivityIndicator color={Colors.primary} />
        </View>
      ) : !delivery ? (
        <Text style={styles.emptyText}>Delivery not found</Text>
      ) : showAssign ? (
        /* ── Partner list ─────────────────────────────────────────── */
        <View style={{ flex: 1, minHeight: 200 }}>
          <Text style={styles.formTitle}>Select Delivery Partner</Text>
          {partnersLoading ? (
            <ActivityIndicator color={Colors.primary} style={{ marginTop: 16 }} />
          ) : partners.length === 0 ? (
            <Text style={styles.emptyText}>No delivery partners found</Text>
          ) : (
            <FlatList
              data={partners}
              keyExtractor={(item) => String(item.id)}
              style={{ maxHeight: 300 }}
              renderItem={({ item: p }) => (
                <TouchableOpacity
                  style={styles.partnerItem}
                  onPress={() => handleAssign(p.id)}
                  disabled={actionLoading}
                >
                  <View style={styles.partnerAvatar}>
                    <Ionicons name="person" size={18} color={Colors.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.partnerName}>{p.name}</Text>
                    {p.phone && <Text style={styles.partnerPhone}>{p.phone}</Text>}
                  </View>
                  {actionLoading ? (
                    <ActivityIndicator size="small" color={Colors.primary} />
                  ) : (
                    <Ionicons name="chevron-forward" size={18} color="#9CA3AF" />
                  )}
                </TouchableOpacity>
              )}
            />
          )}
          <TouchableOpacity style={styles.cancelSmallBtn} onPress={() => setShowAssign(false)}>
            <Ionicons name="arrow-back" size={15} color="#6B7280" />
            <Text style={styles.cancelSmallText}>Back</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView showsVerticalScrollIndicator={false} style={styles.sheetBody} keyboardShouldPersistTaps="handled">
          {/* Status badges */}
          <View style={styles.badgesRow}>
            <BadgePill
              label={DELIVERY_STATUS_LABELS[delivStatus] || delivStatus}
              color={delivColor}
            />
            {delivery.cod_amount > 0 && (
              <BadgePill
                label={`COD: ${formatMoney(delivery.cod_amount)}`}
                color={codRemaining > 0 ? '#E11D48' : '#10B981'}
              />
            )}
            {isCredit && (
              <BadgePill label="Credit" color="#8B5CF6" />
            )}
            {!isCredit && Number(delivery.cod_amount) === 0 && (
              <BadgePill label="Prepaid" color="#10B981" />
            )}
          </View>

          {/* Key info */}
          <View style={styles.detailsCard}>
            {delivery.delivery_address ? (
              <SectionRow label="Address" value={delivery.delivery_address} />
            ) : null}
            {delivery.partner_name ? (
              <SectionRow
                label="Partner"
                value={`${delivery.partner_name}${delivery.partner_phone ? ' • ' + delivery.partner_phone : ''}`}
              />
            ) : null}
            {delivery.scheduled_date ? (
              <SectionRow
                label="Scheduled"
                value={formatDateTime(delivery.scheduled_date, delivery.scheduled_time)}
                color="#6366F1"
              />
            ) : null}
            {delivery.cod_amount > 0 && codRemaining > 0 && (
              <SectionRow label="COD Remaining" value={formatMoney(codRemaining)} color="#E11D48" />
            )}
            {delivery.failure_reason ? (
              <SectionRow label="Failure Reason" value={delivery.failure_reason} color="#E11D48" />
            ) : null}
          </View>

          {canManage && !isFinal && (
            <View style={{ flexDirection: 'row', gap: 8, marginHorizontal: 20, marginBottom: 16 }}>
              {isCredit ? (
                <TouchableOpacity 
                  style={[styles.actionBtn, { flex: 1, backgroundColor: '#E5E7EB', borderColor: '#D1D5DB', borderWidth: 1 }]} 
                  onPress={() => handleConvertPayment('to_cod')}
                  disabled={actionLoading}
                >
                  <Ionicons name="cash-outline" size={16} color="#374151" />
                  <Text style={[styles.actionBtnText, { color: '#374151' }]}>Convert to COD</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity 
                  style={[styles.actionBtn, { flex: 1, backgroundColor: '#E5E7EB', borderColor: '#D1D5DB', borderWidth: 1 }]} 
                  onPress={() => handleConvertPayment('to_credit')}
                  disabled={actionLoading}
                >
                  <Ionicons name="document-text-outline" size={16} color="#374151" />
                  <Text style={[styles.actionBtnText, { color: '#374151' }]}>Convert to Credit</Text>
                </TouchableOpacity>
              )}
            </View>
          )}

          {/* Inline COD delivery form */}
          {showCodForm && (
            <View style={styles.inlineForm}>
              <Text style={styles.formTitle}>Confirm Delivery</Text>
              {delivery.cod_amount > 0 && (
                <>
                  <Text style={styles.formLabel}>
                    COD to collect (₹{Math.round(codRemaining)} remaining)
                  </Text>
                  <TextInput
                    style={styles.formInput}
                    value={codAmount}
                    onChangeText={setCodAmount}
                    keyboardType="decimal-pad"
                    placeholder="Amount collected"
                    placeholderTextColor="#9CA3AF"
                  />
                  <View style={styles.methodRow}>
                    {['cash', 'upi'].map((m) => (
                      <TouchableOpacity
                        key={m}
                        style={[styles.methodBtn, codMethod === m && styles.methodBtnActive]}
                        onPress={() => setCodMethod(m)}
                      >
                        <Text style={[styles.methodText, codMethod === m && { color: '#fff' }]}>
                          {m.toUpperCase()}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </>
              )}
              <View style={styles.formActions}>
                <TouchableOpacity style={[styles.formBtn, { backgroundColor: '#E5E7EB' }]} onPress={() => setShowCodForm(false)}>
                  <Text style={[styles.formBtnText, { color: '#374151' }]}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.formBtn, { backgroundColor: '#10B981', flex: 1 }]}
                  onPress={handleDeliver}
                  disabled={actionLoading}
                >
                  {actionLoading ? <ActivityIndicator color="#fff" /> : <Text style={styles.formBtnText}>Confirm Delivered</Text>}
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* Inline fail form */}
          {showFailForm && (
            <View style={styles.inlineForm}>
              <Text style={styles.formTitle}>Mark as Failed</Text>
              <Text style={styles.formLabel}>Reason for failure *</Text>
              <TextInput
                style={[styles.formInput, { height: 80, textAlignVertical: 'top' }]}
                value={failReason}
                onChangeText={setFailReason}
                placeholder="e.g. Customer unavailable, wrong address..."
                placeholderTextColor="#9CA3AF"
                multiline
              />
              <View style={styles.formActions}>
                <TouchableOpacity style={[styles.formBtn, { backgroundColor: '#E5E7EB' }]} onPress={() => setShowFailForm(false)}>
                  <Text style={[styles.formBtnText, { color: '#374151' }]}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.formBtn, { backgroundColor: '#E11D48', flex: 1 }]}
                  onPress={handleFail}
                  disabled={actionLoading}
                >
                  {actionLoading ? <ActivityIndicator color="#fff" /> : <Text style={styles.formBtnText}>Confirm Failed</Text>}
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* Action buttons */}
          {!isFinal && !showCodForm && !showFailForm && (
            <View style={styles.actionsBlock}>
              <Text style={styles.actionsTitle}>Actions</Text>
              <View style={{ gap: 8 }}>
                {canManage && delivStatus === 'pending' && (
                  <TouchableOpacity
                    style={[styles.actionBtnFull, { backgroundColor: '#6366F1' }]}
                    onPress={openAssign}
                    disabled={actionLoading}
                  >
                    <Ionicons name="person-add-outline" size={16} color="#fff" />
                    <Text style={styles.actionBtnText}>Assign Partner</Text>
                  </TouchableOpacity>
                )}
                {canManage && (delivStatus === 'assigned' || delivStatus === 'failed') && (
                  <TouchableOpacity
                    style={[styles.actionBtnFull, { backgroundColor: '#6366F1' }]}
                    onPress={openAssign}
                    disabled={actionLoading}
                  >
                    <Ionicons name="swap-horizontal-outline" size={16} color="#fff" />
                    <Text style={styles.actionBtnText}>Reassign Partner</Text>
                  </TouchableOpacity>
                )}
                {isPartner && delivStatus === 'assigned' && (
                  <TouchableOpacity
                    style={[styles.actionBtnFull, { backgroundColor: '#9C27B0' }]}
                    onPress={() => doAction('pickup')}
                    disabled={actionLoading}
                  >
                    {actionLoading ? <ActivityIndicator color="#fff" /> : <Ionicons name="cube-outline" size={16} color="#fff" />}
                    <Text style={styles.actionBtnText}>Pick Up Order</Text>
                  </TouchableOpacity>
                )}
                {isPartner && delivStatus === 'picked_up' && (
                  <TouchableOpacity
                    style={[styles.actionBtnFull, { backgroundColor: '#0EA5E9' }]}
                    onPress={() => doAction('in_transit')}
                    disabled={actionLoading}
                  >
                    {actionLoading ? <ActivityIndicator color="#fff" /> : <Ionicons name="bicycle-outline" size={16} color="#fff" />}
                    <Text style={styles.actionBtnText}>Start Delivery</Text>
                  </TouchableOpacity>
                )}
                {isPartner && delivStatus === 'in_transit' && (
                  <>
                    <TouchableOpacity
                      style={[styles.actionBtnFull, { backgroundColor: '#10B981' }]}
                      onPress={() => setShowCodForm(true)}
                      disabled={actionLoading}
                    >
                      <Ionicons name="checkmark-circle-outline" size={16} color="#fff" />
                      <Text style={styles.actionBtnText}>Mark Delivered</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.actionBtnFull, { backgroundColor: '#E11D48' }]}
                      onPress={() => setShowFailForm(true)}
                      disabled={actionLoading}
                    >
                      <Ionicons name="close-circle-outline" size={16} color="#fff" />
                      <Text style={styles.actionBtnText}>Mark Failed</Text>
                    </TouchableOpacity>
                  </>
                )}
                {canManage && delivStatus === 'failed' && (
                  <TouchableOpacity
                    style={[styles.actionBtnFull, { backgroundColor: '#0EA5E9' }]}
                    onPress={() => {
                      Alert.alert('Reattempt', 'Reset to assigned for another attempt?', [
                        { text: 'Cancel', style: 'cancel' },
                        { text: 'Reattempt', onPress: () => doAction('reattempt') },
                      ]);
                    }}
                    disabled={actionLoading}
                  >
                    {actionLoading ? <ActivityIndicator color="#fff" /> : <Ionicons name="refresh-circle-outline" size={16} color="#fff" />}
                    <Text style={styles.actionBtnText}>Reattempt Delivery</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
          )}
        </ScrollView>
      )}

      {/* Sticky footer — Full Details */}
      <View style={styles.sheetFooter}>
        <TouchableOpacity
          style={styles.fullDetailsBtn}
          onPress={() => {
            onClose();
            setTimeout(() => navigation.navigate('DeliveryDetail', { deliveryId: delivery?.id || deliveryId }), 200);
          }}
        >
          <Ionicons name="car-outline" size={17} color={Colors.primary} />
          <Text style={styles.fullDetailsBtnText}>Open Full Delivery Details</Text>
          <Ionicons name="chevron-forward" size={15} color={Colors.primary} />
        </TouchableOpacity>
      </View>
    </SheetWrapper>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // Modal layout
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.55)',
    justifyContent: 'flex-end',
  },
  backdropCentered: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  sheet: {
    backgroundColor: '#fff',
    paddingBottom: Platform.OS === 'ios' ? 24 : 16,
  },
  sheetMobile: {
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: 16,
    paddingTop: 10,
    maxHeight: '92%',
    width: '100%',
  },
  sheetWide: {
    borderRadius: 18,
    paddingHorizontal: 24,
    paddingTop: 20,
    width: '100%',
    maxWidth: 520,
    maxHeight: '88%',
    // Subtle shadow for dialog feel
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 24,
    elevation: 12,
  },
  dragHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#D1D5DB',
    alignSelf: 'center',
    marginBottom: 14,
  },

  // Header
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 14,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
    gap: 10,
  },
  sheetTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#111827',
    fontFamily: FONT_FAMILY,
  },
  sheetSubtitle: {
    fontSize: 13,
    color: '#6B7280',
    marginTop: 3,
    fontFamily: FONT_FAMILY,
    textTransform: 'capitalize',
  },
  closeBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#F3F4F6',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },

  // Body
  sheetBody: {
    flexGrow: 0,
    maxHeight: 440,
  },

  // Footer
  sheetFooter: {
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
    paddingTop: 12,
    marginTop: 8,
  },

  // Badges
  badgesRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 12,
  },
  pill: {
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
  },
  pillText: {
    fontWeight: '800',
    fontFamily: FONT_FAMILY,
    letterSpacing: 0.3,
  },

  // Details card
  detailsCard: {
    backgroundColor: '#F9FAFB',
    borderRadius: 12,
    padding: 12,
    gap: 8,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  sectionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 8,
  },
  sectionLabel: {
    fontSize: 11,
    color: '#9CA3AF',
    fontWeight: '700',
    fontFamily: FONT_FAMILY,
    flexShrink: 0,
    minWidth: 60,
  },
  sectionValue: {
    fontSize: 12,
    color: '#374151',
    fontWeight: '600',
    fontFamily: FONT_FAMILY,
    textAlign: 'right',
    flex: 1,
  },

  // Sub card (delivery section)
  subCard: {
    borderLeftWidth: 3,
    backgroundColor: '#F9FAFB',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 12,
    gap: 6,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  subCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  subCardTitle: {
    fontSize: 12,
    fontWeight: '800',
    fontFamily: FONT_FAMILY,
  },
  subCardMeta: {
    fontSize: 12,
    color: '#6B7280',
    fontFamily: FONT_FAMILY,
    marginTop: 2,
  },
  subCardLinkBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  subCardLinkText: {
    fontSize: 12,
    color: Colors.primary,
    fontWeight: '700',
    fontFamily: FONT_FAMILY,
  },

  // Task progress
  taskBlock: {
    marginBottom: 12,
    gap: 6,
  },
  taskBlockHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  taskBlockTitle: {
    fontSize: 12,
    color: '#374151',
    fontWeight: '700',
    fontFamily: FONT_FAMILY,
  },
  taskBar: {
    height: 6,
    backgroundColor: '#E5E7EB',
    borderRadius: 3,
    overflow: 'hidden',
  },
  taskBarFill: {
    height: '100%',
    backgroundColor: '#10B981',
    borderRadius: 3,
  },

  // Individual task rows
  taskRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderLeftWidth: 3,
    borderRadius: 8,
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    marginBottom: 6,
  },
  taskRowName: {
    fontSize: 13,
    fontWeight: '700',
    color: '#111827',
    fontFamily: FONT_FAMILY,
  },
  taskStatusDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  taskStatusLabel: {
    fontSize: 11,
    fontWeight: '700',
    fontFamily: FONT_FAMILY,
  },
  taskAssignee: {
    fontSize: 11,
    color: '#6B7280',
    fontFamily: FONT_FAMILY,
  },
  taskActionBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 60,
  },
  taskActionBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 11,
    fontFamily: FONT_FAMILY,
  },

  // Back button in delivery modal header
  backBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: Colors.primary + '15',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 4,
  },

  // Actions
  actionsBlock: {
    marginBottom: 12,
    gap: 8,
  },
  actionsTitle: {
    fontSize: 11,
    color: '#9CA3AF',
    fontWeight: '700',
    fontFamily: FONT_FAMILY,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  actionBtnFull: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,
  },
  actionBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 13,
    fontFamily: FONT_FAMILY,
  },

  // Full details footer button
  fullDetailsBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 13,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: Colors.primary,
    backgroundColor: Colors.primary + '0a',
  },
  fullDetailsBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: Colors.primary,
    fontFamily: FONT_FAMILY,
    flex: 1,
    textAlign: 'center',
  },

  // Loading / empty
  loadingBox: {
    paddingVertical: 40,
    alignItems: 'center',
  },
  emptyText: {
    textAlign: 'center',
    color: '#9CA3AF',
    fontSize: 13,
    paddingVertical: 24,
    fontFamily: FONT_FAMILY,
  },

  // Partner list
  partnerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
    gap: 10,
  },
  partnerAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Colors.primary + '15',
    alignItems: 'center',
    justifyContent: 'center',
  },
  partnerName: {
    fontSize: 14,
    fontWeight: '700',
    color: '#111827',
    fontFamily: FONT_FAMILY,
  },
  partnerPhone: {
    fontSize: 12,
    color: '#6B7280',
    marginTop: 2,
    fontFamily: FONT_FAMILY,
  },

  // Forms
  inlineForm: {
    backgroundColor: '#F9FAFB',
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    gap: 8,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  formTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: '#111827',
    fontFamily: FONT_FAMILY,
    marginBottom: 4,
  },
  formLabel: {
    fontSize: 11,
    color: '#6B7280',
    fontWeight: '600',
    fontFamily: FONT_FAMILY,
  },
  formInput: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: FONT_FAMILY,
    color: '#111827',
  },
  methodRow: {
    flexDirection: 'row',
    gap: 8,
  },
  methodBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    backgroundColor: '#fff',
  },
  methodBtnActive: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  methodText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#374151',
    fontFamily: FONT_FAMILY,
  },
  formActions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
  },
  formBtn: {
    paddingVertical: 11,
    paddingHorizontal: 16,
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  formBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 13,
    fontFamily: FONT_FAMILY,
  },
  cancelSmallBtn: {
    marginTop: 12,
    paddingVertical: 10,
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
  },
  cancelSmallText: {
    fontSize: 13,
    color: '#6B7280',
    fontWeight: '600',
    fontFamily: FONT_FAMILY,
  },
});
