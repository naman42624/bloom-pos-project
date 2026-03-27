import React, { useState, useCallback, useEffect, useRef } from 'react';
import { View, Text, SectionList, TouchableOpacity, StyleSheet, Alert, Platform, ActivityIndicator, Modal, TextInput, KeyboardAvoidingView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';
import { formatDateTime } from '../utils/datetime';

const PICKUP_TABS = [
  { key: 'waiting', label: 'Preparing', icon: 'hourglass-outline' },
  { key: 'ready_for_pickup', label: 'Ready', icon: 'checkmark-circle-outline' },
  { key: 'picked_up', label: 'Picked Up', icon: 'bag-check-outline' },
];

const PAYMENT_METHODS = [
  { key: 'cash', label: 'Cash', icon: 'cash' },
  { key: 'card', label: 'Card', icon: 'card' },
  { key: 'upi', label: 'UPI', icon: 'phone-portrait' },
];

export default function PickupOrdersScreen({ navigation }) {
  const { user, activeLocation } = useAuth();
  const [tab, setTab] = useState('waiting');
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(null);
  const [now, setNow] = useState(new Date());
  const tickRef = useRef(null);

  // Payment collection modal for pickup
  const [paymentModalVisible, setPaymentModalVisible] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [pickupPayMethod, setPickupPayMethod] = useState('cash');
  const [pickupPayAmount, setPickupPayAmount] = useState('');
  const [pickupPayRef, setPickupPayRef] = useState('');

  const isManagerOrOwner = user?.role === 'owner' || user?.role === 'manager';

  // Tick every 60s to update countdowns
  useEffect(() => {
    tickRef.current = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(tickRef.current);
  }, []);

  const fetchOrders = useCallback(async () => {
    try {
      setLoading(true);
      const params = { order_type: 'pickup', pickup_status: tab, limit: 200 };
      // Only filter by location for non-owner roles
      if (activeLocation && user?.role !== 'owner') params.location_id = activeLocation.id;
      const res = await api.getSales(params);
      setOrders(res.data?.sales || []);
    } catch (err) {
      console.error('Fetch pickup orders error:', err);
    } finally {
      setLoading(false);
    }
  }, [tab, activeLocation]);

  useFocusEffect(useCallback(() => { fetchOrders(); }, [fetchOrders]));

  const handleMarkReady = async (saleId) => {
    try {
      setActionLoading(saleId);
      await api.markPickupReady(saleId);
      fetchOrders();
    } catch (err) {
      const msg = err.message || 'Failed to update';
      Platform.OS === 'web' ? window.alert(msg) : Alert.alert('Error', msg);
    } finally {
      setActionLoading(null);
    }
  };

  const handleMarkPickedUp = async (order) => {
    // If not fully paid, show payment collection modal (manager/owner only)
    if (order.payment_status !== 'paid') {
      if (!isManagerOrOwner) {
        Alert.alert('Permission', 'Only manager/owner can confirm pickup with pending payment.');
        return;
      }
      setSelectedOrder(order);
      const totalPaid = order.total_paid || 0;
      const balance = Math.max(0, (order.grand_total || 0) - totalPaid);
      setPickupPayAmount(balance > 0 ? balance.toFixed(0) : '');
      setPickupPayMethod('cash');
      setPickupPayRef('');
      setPaymentModalVisible(true);
      return;
    }
    // Fully paid — just mark picked up
    try {
      setActionLoading(order.id);
      await api.markPickedUp(order.id);
      fetchOrders();
    } catch (err) {
      const msg = err.message || 'Failed to update';
      Platform.OS === 'web' ? window.alert(msg) : Alert.alert('Error', msg);
    } finally {
      setActionLoading(null);
    }
  };

  const handleConfirmPickupPayment = async () => {
    if (!selectedOrder) return;
    try {
      setActionLoading(selectedOrder.id);
      await api.markPickedUp(selectedOrder.id, {
        payment_method: pickupPayMethod,
        payment_amount: parseFloat(pickupPayAmount) || 0,
        payment_reference: pickupPayRef || null,
      });
      setPaymentModalVisible(false);
      setSelectedOrder(null);
      fetchOrders();
    } catch (err) {
      const msg = err.message || 'Failed to confirm pickup';
      Platform.OS === 'web' ? window.alert(msg) : Alert.alert('Error', msg);
    } finally {
      setActionLoading(null);
    }
  };

  const getTimeInfo = (item) => {
    // For picked up orders, show pickup time instead of countdown
    if (tab === 'picked_up' && item.picked_up_at) {
      return {
        label: 'Picked up ' + formatDateTime(item.picked_up_at, 'en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true }),
        countdown: null,
        isOverdue: false,
        isDone: true,
      };
    }

    if (!item.scheduled_date) return { label: null, countdown: null, isOverdue: false };
    const dateStr = (item.scheduled_date || '').split('T')[0];
    const timeStr = item.scheduled_time || '00:00';
    const target = new Date(`${dateStr}T${timeStr}:00`);
    const diffMs = target - now;
    const diffMin = Math.round(diffMs / 60000);

    const today = now.toISOString().slice(0, 10);
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().slice(0, 10);

    let dateLabel = '';
    if (dateStr === today) dateLabel = 'Today';
    else if (dateStr === tomorrowStr) dateLabel = 'Tomorrow';
    else {
      const d = new Date(dateStr + 'T00:00:00');
      dateLabel = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
    }

    const formattedTime = target.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
    const label = `${dateLabel}, ${formattedTime}`;

    let countdown = null;
    let isOverdue = false;
    if (diffMin < 0) {
      isOverdue = true;
      const overMin = Math.abs(diffMin);
      countdown = overMin >= 60 ? `${Math.floor(overMin / 60)}h ${overMin % 60}m overdue` : `${overMin}m overdue`;
    } else if (diffMin < 1440) {
      countdown = diffMin >= 60 ? `in ${Math.floor(diffMin / 60)}h ${diffMin % 60}m` : `in ${diffMin}m`;
    }
    return { label, countdown, isOverdue };
  };

  // Sort orders by scheduled date+time (earliest first, no-date last)
  const sortedOrders = [...orders].sort((a, b) => {
    const dtA = a.scheduled_date ? `${a.scheduled_date} ${a.scheduled_time || '00:00'}` : 'zzzz';
    const dtB = b.scheduled_date ? `${b.scheduled_date} ${b.scheduled_time || '00:00'}` : 'zzzz';
    return dtA.localeCompare(dtB);
  });

  // Group by date for section headers
  const getDateLabel = (dateStr) => {
    if (!dateStr) return 'Unscheduled';
    const today = now.toISOString().slice(0, 10);
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().slice(0, 10);
    if (dateStr === today) return 'Today';
    if (dateStr === tomorrowStr) return 'Tomorrow';
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  };

  const sections = [];
  const grouped = {};
  for (const item of sortedOrders) {
    const key = item.scheduled_date || '_unscheduled';
    if (!grouped[key]) {
      grouped[key] = { title: getDateLabel(item.scheduled_date), data: [] };
      sections.push(grouped[key]);
    }
    grouped[key].data.push(item);
  }

  const renderOrder = ({ item }) => {
    const isLoadingThis = actionLoading === item.id;
    const timeInfo = getTimeInfo(item);
    return (
      <TouchableOpacity
        style={styles.card}
        onPress={() => navigation.navigate('SaleDetail', { saleId: item.id })}
      >
        {/* Time header — prominent */}
        {timeInfo.label && (
          <View style={[styles.timeHeader, timeInfo.isOverdue && styles.timeHeaderOverdue, timeInfo.isDone && styles.timeHeaderDone]}>
            <View style={styles.timeRow}>
              <Ionicons name={timeInfo.isDone ? 'checkmark-circle' : 'time-outline'} size={18} color={timeInfo.isDone ? Colors.success : timeInfo.isOverdue ? '#D32F2F' : Colors.primary} />
              <Text style={[styles.timeText, timeInfo.isOverdue && styles.timeTextOverdue, timeInfo.isDone && { color: Colors.success }]}>{timeInfo.label}</Text>
            </View>
            {timeInfo.countdown && (
              <Text style={[styles.countdownText, timeInfo.isOverdue ? styles.countdownOverdue : styles.countdownNormal]}>
                {timeInfo.countdown}
              </Text>
            )}
          </View>
        )}

        <View style={styles.cardHeader}>
          <View>
            <Text style={styles.orderNum}>{item.sale_number}</Text>
            <Text style={styles.cardSub}>{item.customer_name || 'Walk-in'}</Text>
          </View>
          <Text style={styles.amount}>₹{(item.grand_total || 0).toFixed(0)}</Text>
        </View>

        <View style={[styles.row, { marginTop: 4 }]}>
          <View style={[styles.payBadge, { backgroundColor: item.payment_status === 'paid' ? '#E8F5E9' : '#FFF3E0' }]}>
            <Text style={{ fontSize: FontSize.xs, fontWeight: '600', color: item.payment_status === 'paid' ? '#2E7D32' : '#E65100' }}>
              {item.payment_status === 'paid' ? 'PAID' : item.payment_status === 'partial' ? 'PARTIAL' : 'UNPAID'}
            </Text>
          </View>
        </View>

        {(item.special_instructions || item.notes) && (
          <Text style={{ fontSize: FontSize.xs, color: '#D32F2F', marginTop: 8, fontWeight: '600' }}>
            Order Note: {item.special_instructions || item.notes}
          </Text>
        )}
        
        {(item.items && item.items.length > 0) && (
          <View style={{ marginTop: 8, backgroundColor: Colors.background, padding: 8, borderRadius: 6 }}>
            {item.items.map((it, idx) => (
              <View key={idx} style={{ marginBottom: idx === item.items.length - 1 ? 0 : 4 }}>
                <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary }}>{it.quantity}x {it.product_name}</Text>
                {it.item_special_instructions ? (
                  <Text style={{ fontSize: FontSize.xs, color: '#F57C00', marginLeft: 8, fontWeight: '500' }}>* {it.item_special_instructions}</Text>
                ) : null}
              </View>
            ))}
          </View>
        )}

        {/* Actions */}
        <View style={styles.cardActions}>
          {tab === 'waiting' && (
            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: Colors.success }]}
              onPress={() => handleMarkReady(item.id)}
              disabled={isLoadingThis}
            >
              {isLoadingThis ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <>
                  <Ionicons name="checkmark-circle" size={18} color="#fff" />
                  <Text style={styles.actionText}>Mark Ready</Text>
                </>
              )}
            </TouchableOpacity>
          )}
          {tab === 'ready_for_pickup' && (
            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: item.payment_status !== 'paid' ? Colors.warning : Colors.primary }]}
              onPress={() => handleMarkPickedUp(item)}
              disabled={isLoadingThis}
            >
              {isLoadingThis ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <>
                  <Ionicons name={item.payment_status !== 'paid' ? 'cash' : 'bag-check'} size={18} color="#fff" />
                  <Text style={styles.actionText}>
                    {item.payment_status !== 'paid' ? 'Collect & Complete' : 'Customer Picked Up'}
                  </Text>
                </>
              )}
            </TouchableOpacity>
          )}
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      {/* Tabs */}
      <View style={styles.tabRow}>
        {PICKUP_TABS.map(t => (
          <TouchableOpacity
            key={t.key}
            style={[styles.tab, tab === t.key && styles.tabActive]}
            onPress={() => setTab(t.key)}
          >
            <Ionicons name={t.icon} size={18} color={tab === t.key ? '#fff' : Colors.textLight} />
            <Text style={[styles.tabText, tab === t.key && styles.tabTextActive]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <SectionList
        sections={sections}
        renderItem={renderOrder}
        renderSectionHeader={({ section: { title } }) => (
          <View style={styles.sectionHeader}>
            <Ionicons name="calendar-outline" size={16} color={Colors.primary} />
            <Text style={styles.sectionHeaderText}>{title}</Text>
          </View>
        )}
        keyExtractor={item => String(item.id)}
        contentContainerStyle={{ padding: Spacing.md, paddingBottom: 100 }}
        refreshing={loading}
        onRefresh={fetchOrders}
        stickySectionHeadersEnabled={false}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="bag-outline" size={48} color={Colors.textLight} />
            <Text style={styles.emptyText}>No {tab.replace(/_/g, ' ')} orders</Text>
          </View>
        }
      />

      {/* Payment Collection Modal */}
      <Modal visible={paymentModalVisible} transparent animationType="slide">
        <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Collect Payment</Text>
              <TouchableOpacity onPress={() => setPaymentModalVisible(false)}>
                <Ionicons name="close" size={24} color={Colors.text} />
              </TouchableOpacity>
            </View>
            {selectedOrder && (
              <>
                <Text style={styles.modalSubtitle}>
                  {selectedOrder.sale_number} — {selectedOrder.customer_name || 'Customer'}
                </Text>
                <View style={styles.balanceBox}>
                  <Text style={styles.balanceLabel}>Balance Due</Text>
                  <Text style={styles.balanceAmount}>
                    ₹{Math.max(0, (selectedOrder.grand_total || 0) - (selectedOrder.total_paid || 0)).toFixed(0)}
                  </Text>
                </View>

                <Text style={styles.fieldLabel}>Payment Method</Text>
                <View style={styles.chipRow}>
                  {PAYMENT_METHODS.map(m => (
                    <TouchableOpacity
                      key={m.key}
                      style={[styles.methodChip, pickupPayMethod === m.key && styles.methodChipActive]}
                      onPress={() => setPickupPayMethod(m.key)}
                    >
                      <Ionicons name={m.icon} size={16} color={pickupPayMethod === m.key ? '#fff' : Colors.textSecondary} />
                      <Text style={[styles.methodChipText, pickupPayMethod === m.key && styles.methodChipTextActive]}>{m.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <Text style={styles.fieldLabel}>Amount</Text>
                <TextInput
                  style={styles.modalInput}
                  value={pickupPayAmount}
                  onChangeText={setPickupPayAmount}
                  placeholder="₹ Amount"
                  placeholderTextColor={Colors.textLight}
                  keyboardType="numeric"
                />

                {pickupPayMethod !== 'cash' && (
                  <>
                    <Text style={styles.fieldLabel}>Reference</Text>
                    <TextInput
                      style={styles.modalInput}
                      value={pickupPayRef}
                      onChangeText={setPickupPayRef}
                      placeholder="Transaction ID / Reference"
                      placeholderTextColor={Colors.textLight}
                    />
                  </>
                )}

                <TouchableOpacity
                  style={[styles.confirmBtn, actionLoading && { opacity: 0.6 }]}
                  onPress={handleConfirmPickupPayment}
                  disabled={!!actionLoading}
                >
                  {actionLoading ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <>
                      <Ionicons name="checkmark-circle" size={20} color="#fff" />
                      <Text style={styles.confirmBtnText}>Confirm Payment & Complete</Text>
                    </>
                  )}
                </TouchableOpacity>
              </>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  tabRow: { flexDirection: 'row', padding: Spacing.md, paddingBottom: 0, gap: 8 },
  tab: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, borderRadius: BorderRadius.md, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border },
  tabActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  tabText: { fontSize: FontSize.sm, color: Colors.textLight, fontWeight: '600' },
  tabTextActive: { color: '#fff' },
  card: { backgroundColor: Colors.surface, borderRadius: BorderRadius.lg, padding: Spacing.md, marginBottom: Spacing.md, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 4, elevation: 2 },
  timeHeader: { backgroundColor: Colors.primary + '10', borderRadius: BorderRadius.sm, padding: Spacing.sm, marginBottom: Spacing.sm, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  timeHeaderOverdue: { backgroundColor: '#FFEBEE' },
  timeHeaderDone: { backgroundColor: '#E8F5E9' },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  timeText: { fontSize: FontSize.md, fontWeight: '700', color: Colors.primary },
  timeTextOverdue: { color: '#D32F2F' },
  countdownText: { fontSize: FontSize.sm, fontWeight: '700' },
  countdownNormal: { color: Colors.primary },
  countdownOverdue: { color: '#D32F2F' },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 },
  orderNum: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  amount: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  cardSub: { fontSize: FontSize.sm, color: Colors.textLight, marginTop: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  payBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  cardActions: { marginTop: 10, borderTopWidth: 1, borderTopColor: Colors.border, paddingTop: 10 },
  actionBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, borderRadius: BorderRadius.md },
  actionText: { color: '#fff', fontWeight: '700', fontSize: FontSize.sm },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 10, paddingHorizontal: 4, marginTop: 8 },
  sectionHeaderText: { fontSize: FontSize.md, fontWeight: '700', color: Colors.primary },
  empty: { alignItems: 'center', marginTop: 60 },
  emptyText: { fontSize: FontSize.md, color: Colors.textLight, marginTop: 8 },

  // Payment modal
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: Colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: Spacing.lg, maxHeight: '80%' },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  modalTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  modalSubtitle: { fontSize: FontSize.sm, color: Colors.textLight, marginBottom: Spacing.md },
  balanceBox: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#FFF3E0', borderRadius: BorderRadius.md, padding: Spacing.md, marginBottom: Spacing.md },
  balanceLabel: { fontSize: FontSize.md, fontWeight: '600', color: '#E65100' },
  balanceAmount: { fontSize: FontSize.xl, fontWeight: '800', color: '#E65100' },
  fieldLabel: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.textSecondary, marginTop: Spacing.md, marginBottom: Spacing.sm },
  chipRow: { flexDirection: 'row', gap: Spacing.sm },
  methodChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, borderRadius: BorderRadius.full, backgroundColor: Colors.background, borderWidth: 1.5, borderColor: Colors.border },
  methodChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  methodChipText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '500' },
  methodChipTextActive: { color: '#fff', fontWeight: '700' },
  modalInput: { backgroundColor: Colors.background, borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border, paddingHorizontal: Spacing.md, paddingVertical: Spacing.md, fontSize: FontSize.md, color: Colors.text },
  confirmBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm, backgroundColor: Colors.success, borderRadius: BorderRadius.md, paddingVertical: Spacing.lg, marginTop: Spacing.lg },
  confirmBtnText: { color: '#fff', fontSize: FontSize.md, fontWeight: '700' },
});
