import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  RefreshControl, Alert, TextInput, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const STATUS_CONFIG = {
  expected: { color: Colors.info, label: 'Expected' },
  partially_received: { color: Colors.warning, label: 'Partially Received' },
  received: { color: Colors.success, label: 'Received' },
  cancelled: { color: Colors.error, label: 'Cancelled' },
};

const QUALITY_OPTIONS = [
  { value: 'good', label: 'Good', color: Colors.success },
  { value: 'average', label: 'Average', color: Colors.warning },
  { value: 'poor', label: 'Poor', color: Colors.error },
];

const QUALITY_COLORS = {
  good: Colors.success,
  average: Colors.warning,
  poor: Colors.error,
};

export default function PurchaseOrderDetailScreen({ route, navigation }) {
  const { user, locations } = useAuth();
  const { orderId } = route.params;
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Receive mode state
  const [receiveMode, setReceiveMode] = useState(false);
  const [receiveItems, setReceiveItems] = useState([]);
  const [submitting, setSubmitting] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const res = await api.getPurchaseOrder(orderId);
      setOrder(res.data);
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to load order');
    } finally { setLoading(false); setRefreshing(false); }
  }, [orderId]);

  useFocusEffect(useCallback(() => { fetchData(); }, [fetchData]));

  const enterReceiveMode = () => {
    if (!order) return;
    setReceiveItems(
      order.items.map((item) => ({
        item_id: item.id,
        material_name: item.material_name,
        expected_quantity: item.expected_quantity,
        expected_unit: item.expected_unit || item.unit || 'pieces',
        already_received: item.received_quantity || 0,
        received_quantity: String(item.expected_quantity - (item.received_quantity || 0)),
        received_quality: 'good',
      }))
    );
    setReceiveMode(true);
  };

  const updateReceiveItem = (index, field, value) => {
    const updated = [...receiveItems];
    updated[index] = { ...updated[index], [field]: value };
    setReceiveItems(updated);
  };

  const handleSubmitReceive = async () => {
    const invalid = receiveItems.find(
      (i) => !i.received_quantity || parseFloat(i.received_quantity) < 0
    );
    if (invalid) {
      Alert.alert('Invalid', 'Received quantity cannot be negative');
      return;
    }

    // Filter items that have a quantity to receive
    const itemsToReceive = receiveItems
      .filter((i) => parseFloat(i.received_quantity) > 0)
      .map((i) => ({
        item_id: i.item_id,
        received_quantity: parseFloat(i.received_quantity),
        received_quality: i.received_quality,
      }));

    if (itemsToReceive.length === 0) {
      Alert.alert('No Items', 'Enter quantity for at least one item to receive');
      return;
    }

    setSubmitting(true);
    try {
      await api.receivePurchaseOrder(orderId, { items: itemsToReceive });
      setReceiveMode(false);
      fetchData();
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to receive items');
    } finally { setSubmitting(false); }
  };

  const handleCancel = async () => {
    const confirmed = Platform.OS === 'web'
      ? window.confirm('Are you sure you want to cancel this order?')
      : await new Promise((resolve) =>
          Alert.alert('Cancel Order', 'Are you sure you want to cancel this order?', [
            { text: 'No', onPress: () => resolve(false), style: 'cancel' },
            { text: 'Yes, Cancel', onPress: () => resolve(true), style: 'destructive' },
          ])
        );
    if (!confirmed) return;
    try {
      await api.updatePurchaseOrder(orderId, { status: 'cancelled' });
      fetchData();
    } catch (err) {
      Alert.alert('Error', err.message);
    }
  };

  if (!order && !loading) {
    return <View style={styles.container}><Text style={styles.errorText}>Order not found</Text></View>;
  }

  const cfg = order ? STATUS_CONFIG[order.status] : STATUS_CONFIG.expected;
  const canReceive = order && (order.status === 'expected' || order.status === 'partially_received')
    && (user?.role === 'owner' || user?.role === 'manager' || (locations || []).some((l) => l.id === order.location_id));
  const canEdit = order && order.status === 'expected';
  const canCancel = order && (order.status === 'expected' || order.status === 'partially_received');

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchData(); }} colors={[Colors.primary]} />}
    >
      {order && (
        <>
          <View style={styles.header}>
            <Text style={styles.poNumber}>{order.po_number}</Text>
            <View style={[styles.statusBadge, { backgroundColor: cfg.color + '20' }]}>
              <Text style={[styles.statusText, { color: cfg.color }]}>{cfg.label}</Text>
            </View>
            <View style={styles.metaRow}>
              <View style={styles.metaItem}>
                <Ionicons name="business-outline" size={16} color={Colors.textSecondary} />
                <Text style={styles.metaText}>{order.supplier_name}</Text>
              </View>
              <View style={styles.metaItem}>
                <Ionicons name="location-outline" size={16} color={Colors.textSecondary} />
                <Text style={styles.metaText}>{order.location_name}</Text>
              </View>
              {order.expected_date && (
                <View style={styles.metaItem}>
                  <Ionicons name="calendar-outline" size={16} color={Colors.textSecondary} />
                  <Text style={styles.metaText}>{order.expected_date} {order.expected_time || ''}</Text>
                </View>
              )}
            </View>
            {order.total_amount !== undefined && <Text style={styles.total}>₹{order.total_amount}</Text>}
            {order.notes ? <Text style={styles.notes}>{order.notes}</Text> : null}
          </View>

          {/* Action buttons */}
          {!receiveMode && (canReceive || canEdit || canCancel) && (user?.role === 'owner' || user?.role === 'manager' || user?.role === 'employee') && (
            <View style={styles.actionRow}>
              {canEdit && (user?.role === 'owner' || user?.role === 'manager') && (
                <TouchableOpacity
                  style={[styles.actionBtn, { backgroundColor: Colors.info }]}
                  onPress={() => navigation.navigate('PurchaseOrderForm', { order })}
                >
                  <Ionicons name="create-outline" size={16} color={Colors.white} />
                  <Text style={styles.actionText} numberOfLines={1}>Edit</Text>
                </TouchableOpacity>
              )}
              {canReceive && (
                <TouchableOpacity
                  style={[styles.actionBtn, { backgroundColor: Colors.success }]}
                  onPress={enterReceiveMode}
                >
                  <Ionicons name="cube-outline" size={16} color={Colors.white} />
                  <Text style={styles.actionText} numberOfLines={1}>Receive</Text>
                </TouchableOpacity>
              )}
              {canCancel && (user?.role === 'owner' || user?.role === 'manager') && (
                <TouchableOpacity
                  style={[styles.actionBtn, { backgroundColor: Colors.error }]}
                  onPress={handleCancel}
                >
                  <Ionicons name="close" size={16} color={Colors.white} />
                  <Text style={styles.actionText} numberOfLines={1}>Cancel</Text>
                </TouchableOpacity>
              )}
            </View>
          )}

          {/* ── Receive Mode ── */}
          {receiveMode && (
            <View style={styles.receiveSection}>
              <View style={styles.receiveTitleRow}>
                <Text style={styles.sectionTitle}>Receive Items</Text>
                <TouchableOpacity onPress={() => setReceiveMode(false)}>
                  <Text style={styles.cancelLink}>Cancel</Text>
                </TouchableOpacity>
              </View>

              {receiveItems.map((item, index) => {
                const remaining = item.expected_quantity - item.already_received;
                return (
                  <View key={item.item_id} style={styles.receiveCard}>
                    <Text style={styles.receiveItemName}>{item.material_name}</Text>
                    <Text style={styles.receiveItemMeta}>
                      Expected: {item.expected_quantity} {item.expected_unit} · Already received: {item.already_received} · Remaining: {remaining}
                    </Text>

                    {/* Quantity */}
                    <Text style={styles.receiveLabel}>Receiving Quantity</Text>
                    <TextInput
                      style={styles.receiveInput}
                      value={item.received_quantity}
                      onChangeText={(v) => updateReceiveItem(index, 'received_quantity', v)}
                      keyboardType="numeric"
                      placeholder="0"
                      placeholderTextColor={Colors.textLight}
                    />

                    {/* Quality */}
                    <Text style={styles.receiveLabel}>Quality</Text>
                    <View style={styles.qualityRow}>
                      {QUALITY_OPTIONS.map((q) => (
                        <TouchableOpacity
                          key={q.value}
                          style={[
                            styles.qualityChip,
                            item.received_quality === q.value && { backgroundColor: q.color + '20', borderColor: q.color },
                          ]}
                          onPress={() => updateReceiveItem(index, 'received_quality', q.value)}
                        >
                          <View style={[styles.qualityDot, { backgroundColor: item.received_quality === q.value ? q.color : Colors.textLight }]} />
                          <Text style={[styles.qualityText, item.received_quality === q.value && { color: q.color, fontWeight: '600' }]}>
                            {q.label}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </View>
                );
              })}

              <TouchableOpacity
                style={[styles.submitReceiveBtn, submitting && { opacity: 0.6 }]}
                onPress={handleSubmitReceive}
                disabled={submitting}
                activeOpacity={0.7}
              >
                <Ionicons name="checkmark-done" size={20} color={Colors.white} />
                <Text style={styles.submitReceiveText}>{submitting ? 'Submitting...' : 'Confirm Receive'}</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* ── Items List (when NOT in receive mode) ── */}
          {!receiveMode && (
            <>
              <Text style={styles.sectionTitle}>Items ({(order.items || []).length})</Text>
              {(order.items || []).map((item) => (
                <View key={item.id} style={styles.itemCard}>
                  <Text style={styles.itemName}>{item.material_name}</Text>
                  <Text style={styles.itemSku}>SKU: {item.sku} · {item.expected_unit}</Text>
                  <View style={styles.qtyRow}>
                    <View style={styles.qtyCol}>
                      <Text style={styles.qtyLabel}>Expected</Text>
                      <Text style={styles.qtyValue}>{item.expected_quantity} {item.expected_unit}</Text>
                      {item.expected_price_per_unit !== undefined && <Text style={styles.priceText}>@ ₹{item.expected_price_per_unit}</Text>}
                    </View>
                    <View style={styles.qtyCol}>
                      <Text style={styles.qtyLabel}>Received</Text>
                      <Text style={[styles.qtyValue, { color: item.received_quantity > 0 ? Colors.success : Colors.textLight }]}>
                        {item.received_quantity} {item.expected_unit}
                      </Text>
                      {item.actual_price_per_unit !== undefined && item.actual_price_per_unit > 0 && <Text style={styles.priceText}>@ ₹{item.actual_price_per_unit}</Text>}
                    </View>
                    {item.received_quality && (
                      <View style={styles.qtyCol}>
                        <Text style={styles.qtyLabel}>Quality</Text>
                        <Text style={[styles.qtyValue, { color: QUALITY_COLORS[item.received_quality] || Colors.text }]}>
                          {item.received_quality}
                        </Text>
                      </View>
                    )}
                  </View>
                </View>
              ))}
            </>
          )}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.md, paddingBottom: 40 },
  errorText: { textAlign: 'center', marginTop: 40, color: Colors.textSecondary },
  header: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg, padding: Spacing.lg,
    alignItems: 'center', marginBottom: Spacing.md,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 3, elevation: 2,
  },
  poNumber: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text },
  statusBadge: { paddingHorizontal: Spacing.md, paddingVertical: 4, borderRadius: BorderRadius.full, marginTop: Spacing.sm },
  statusText: { fontSize: FontSize.sm, fontWeight: '600', textTransform: 'capitalize' },
  metaRow: { marginTop: Spacing.md, gap: Spacing.sm },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  metaText: { fontSize: FontSize.sm, color: Colors.textSecondary },
  total: { fontSize: FontSize.xxl, fontWeight: '700', color: Colors.primary, marginTop: Spacing.md },
  notes: { fontSize: FontSize.sm, color: Colors.textLight, marginTop: Spacing.sm, fontStyle: 'italic' },
  actionRow: { flexDirection: 'row', gap: Spacing.sm, marginBottom: Spacing.md },
  actionBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: Spacing.sm, paddingHorizontal: Spacing.xs, borderRadius: BorderRadius.md, gap: 4,
  },
  actionText: { color: Colors.white, fontWeight: '600', fontSize: FontSize.xs + 1 },

  /* Receive mode styles */
  receiveSection: { marginBottom: Spacing.md },
  receiveTitleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.sm },
  cancelLink: { color: Colors.error, fontWeight: '600', fontSize: FontSize.sm },
  receiveCard: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md, padding: Spacing.md, marginBottom: Spacing.sm,
    borderWidth: 1, borderColor: Colors.border,
  },
  receiveItemName: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  receiveItemMeta: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2, marginBottom: Spacing.sm },
  receiveLabel: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.textSecondary, marginBottom: 4, marginTop: Spacing.sm },
  receiveInput: {
    backgroundColor: Colors.background, borderWidth: 1, borderColor: Colors.border,
    borderRadius: BorderRadius.md, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    fontSize: FontSize.md, color: Colors.text,
  },
  qualityRow: { flexDirection: 'row', gap: Spacing.sm },
  qualityChip: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: Spacing.sm, borderRadius: BorderRadius.md, gap: 6,
    borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.surface,
  },
  qualityDot: { width: 8, height: 8, borderRadius: 4 },
  qualityText: { fontSize: FontSize.sm, color: Colors.textSecondary },
  submitReceiveBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: Colors.success, paddingVertical: Spacing.md,
    borderRadius: BorderRadius.md, gap: Spacing.sm, marginTop: Spacing.md,
  },
  submitReceiveText: { color: Colors.white, fontWeight: '700', fontSize: FontSize.md },

  /* Items list styles */
  sectionTitle: { fontSize: FontSize.lg, fontWeight: '600', color: Colors.text, marginBottom: Spacing.sm, marginTop: Spacing.sm },
  itemCard: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md, padding: Spacing.md, marginBottom: Spacing.sm,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.03, shadowRadius: 2, elevation: 1,
  },
  itemName: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  itemSku: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },
  qtyRow: { flexDirection: 'row', marginTop: Spacing.sm, gap: Spacing.md },
  qtyCol: { flex: 1 },
  qtyLabel: { fontSize: FontSize.xs, color: Colors.textLight },
  qtyValue: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text, marginTop: 2 },
  priceText: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },
});
