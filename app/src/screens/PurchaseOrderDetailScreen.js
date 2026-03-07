import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  RefreshControl, Alert,
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

const QUALITY_COLORS = {
  good: Colors.success,
  average: Colors.warning,
  poor: Colors.error,
};

export default function PurchaseOrderDetailScreen({ route, navigation }) {
  const { user } = useAuth();
  const { orderId } = route.params;
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [receiving, setReceiving] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const res = await api.getPurchaseOrder(orderId);
      setOrder(res.data);
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to load order');
    } finally { setLoading(false); setRefreshing(false); }
  }, [orderId]);

  useFocusEffect(useCallback(() => { fetchData(); }, [fetchData]));

  const handleReceiveAll = () => {
    if (!order) return;
    Alert.alert(
      'Receive All Items',
      'Mark all items as received with expected quantities and good quality?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Receive All',
          onPress: async () => {
            setReceiving(true);
            try {
              const items = order.items.map((i) => ({
                item_id: i.id,
                received_quantity: i.expected_quantity,
                received_quality: 'good',
                actual_price_per_unit: i.expected_price_per_unit,
              }));
              await api.receivePurchaseOrder(orderId, { items });
              fetchData();
            } catch (err) {
              Alert.alert('Error', err.message || 'Failed to receive items');
            } finally { setReceiving(false); }
          },
        },
      ]
    );
  };

  const handleCancel = () => {
    Alert.alert('Cancel Order', 'Are you sure you want to cancel this order?', [
      { text: 'No', style: 'cancel' },
      {
        text: 'Yes, Cancel',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.updatePurchaseOrder(orderId, { status: 'cancelled' });
            fetchData();
          } catch (err) {
            Alert.alert('Error', err.message);
          }
        },
      },
    ]);
  };

  if (!order && !loading) {
    return <View style={styles.container}><Text style={styles.errorText}>Order not found</Text></View>;
  }

  const cfg = order ? STATUS_CONFIG[order.status] : STATUS_CONFIG.expected;
  const canReceive = order && (order.status === 'expected' || order.status === 'partially_received');
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
            <Text style={styles.total}>₹{order.total_amount}</Text>
            {order.notes ? <Text style={styles.notes}>{order.notes}</Text> : null}
          </View>

          {/* Action buttons */}
          {(canReceive || canCancel) && (user?.role === 'owner' || user?.role === 'manager' || user?.role === 'employee') && (
            <View style={styles.actionRow}>
              {canReceive && (
                <TouchableOpacity
                  style={[styles.actionBtn, { backgroundColor: Colors.success }]}
                  onPress={handleReceiveAll}
                  disabled={receiving}
                >
                  <Ionicons name="checkmark-done" size={18} color={Colors.white} />
                  <Text style={styles.actionText}>{receiving ? 'Receiving...' : 'Receive All'}</Text>
                </TouchableOpacity>
              )}
              {canCancel && (user?.role === 'owner' || user?.role === 'manager') && (
                <TouchableOpacity
                  style={[styles.actionBtn, { backgroundColor: Colors.error }]}
                  onPress={handleCancel}
                >
                  <Ionicons name="close" size={18} color={Colors.white} />
                  <Text style={styles.actionText}>Cancel</Text>
                </TouchableOpacity>
              )}
            </View>
          )}

          {/* Items */}
          <Text style={styles.sectionTitle}>Items ({(order.items || []).length})</Text>
          {(order.items || []).map((item) => (
            <View key={item.id} style={styles.itemCard}>
              <Text style={styles.itemName}>{item.material_name}</Text>
              <Text style={styles.itemSku}>SKU: {item.sku} · {item.category_name}</Text>
              <View style={styles.qtyRow}>
                <View style={styles.qtyCol}>
                  <Text style={styles.qtyLabel}>Expected</Text>
                  <Text style={styles.qtyValue}>{item.expected_quantity} {item.unit || item.expected_unit}</Text>
                  <Text style={styles.priceText}>@ ₹{item.expected_price_per_unit}</Text>
                </View>
                <View style={styles.qtyCol}>
                  <Text style={styles.qtyLabel}>Received</Text>
                  <Text style={[styles.qtyValue, { color: item.received_quantity > 0 ? Colors.success : Colors.textLight }]}>
                    {item.received_quantity} {item.unit || item.expected_unit}
                  </Text>
                  {item.actual_price_per_unit > 0 && <Text style={styles.priceText}>@ ₹{item.actual_price_per_unit}</Text>}
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
              {item.received_by_name && (
                <Text style={styles.receivedBy}>Received by: {item.received_by_name}</Text>
              )}
            </View>
          ))}
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
  actionRow: { flexDirection: 'row', gap: Spacing.md, marginBottom: Spacing.md },
  actionBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: Spacing.sm + 2, borderRadius: BorderRadius.md, gap: 6,
  },
  actionText: { color: Colors.white, fontWeight: '600', fontSize: FontSize.sm },
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
  receivedBy: { fontSize: FontSize.xs, color: Colors.textLight, marginTop: Spacing.sm },
});
