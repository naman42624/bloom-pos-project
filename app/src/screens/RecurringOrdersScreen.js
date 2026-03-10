import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, Alert,
  Modal, TextInput, ScrollView, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import api from '../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const FREQ_LABELS = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', custom: 'Custom' };
const FREQ_ICONS = { daily: 'today', weekly: 'calendar', monthly: 'calendar-outline', custom: 'options' };

export default function RecurringOrdersScreen({ navigation }) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadOrders = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api.getRecurringOrders();
      setOrders(res.data || []);
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to load recurring orders');
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { loadOrders(); }, [loadOrders]));

  const toggleActive = async (order) => {
    try {
      await api.updateRecurringOrder(order.id, { is_active: !order.is_active });
      loadOrders();
    } catch (err) {
      Alert.alert('Error', err.message);
    }
  };

  const deleteOrder = (order) => {
    Alert.alert('Delete', `Delete recurring order for ${order.customer_name}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          try {
            await api.deleteRecurringOrder(order.id);
            loadOrders();
          } catch (err) { Alert.alert('Error', err.message); }
        },
      },
    ]);
  };

  const renderItem = ({ item }) => {
    const items = item.items || [];
    const totalAmount = items.reduce((s, i) => s + ((i.unit_price || 0) * (i.quantity || 1)), 0);
    const itemNames = items.map(i => i.product_name).join(', ');

    return (
      <TouchableOpacity
        style={[styles.card, !item.is_active && styles.cardInactive]}
        onPress={() => navigation.navigate('RecurringOrderDetail', { orderId: item.id })}
      >
        <View style={styles.cardHeader}>
          <View style={styles.freqBadge}>
            <Ionicons name={FREQ_ICONS[item.frequency] || 'calendar'} size={14} color={Colors.white} />
            <Text style={styles.freqBadgeText}>{FREQ_LABELS[item.frequency] || item.frequency}</Text>
          </View>
          <View style={styles.typeBadge}>
            <Ionicons name={item.order_type === 'delivery' ? 'bicycle' : 'bag-handle'} size={12} color={Colors.primary} />
            <Text style={styles.typeBadgeText}>{item.order_type}</Text>
          </View>
          {!item.is_active && (
            <View style={[styles.freqBadge, { backgroundColor: Colors.textLight }]}>
              <Text style={styles.freqBadgeText}>Paused</Text>
            </View>
          )}
        </View>

        <Text style={styles.customerName}>{item.customer_name || 'Unknown'}</Text>
        <Text style={styles.customerPhone}>{item.customer_phone}</Text>

        <Text style={styles.itemsList} numberOfLines={2}>📦 {itemNames || 'No items'}</Text>
        <Text style={styles.totalAmount}>₹{totalAmount.toFixed(0)} per order</Text>

        <View style={styles.cardFooter}>
          <Text style={styles.nextRun}>Next: {item.next_run_date || '—'}</Text>
          <View style={styles.cardActions}>
            <TouchableOpacity onPress={() => toggleActive(item)} style={styles.actionBtn}>
              <Ionicons name={item.is_active ? 'pause' : 'play'} size={18} color={item.is_active ? Colors.warning : Colors.success} />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => deleteOrder(item)} style={styles.actionBtn}>
              <Ionicons name="trash-outline" size={18} color={Colors.error} />
            </TouchableOpacity>
          </View>
        </View>

        {item.location_name && <Text style={styles.locationHint}>📍 {item.location_name}</Text>}
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Recurring Orders</Text>
        <TouchableOpacity
          style={styles.addBtn}
          onPress={() => navigation.navigate('AddRecurringOrder')}
        >
          <Ionicons name="add" size={22} color={Colors.white} />
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator size="large" color={Colors.primary} style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          data={orders}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <View style={styles.emptyBox}>
              <Ionicons name="repeat-outline" size={48} color={Colors.textLight} />
              <Text style={styles.emptyText}>No recurring orders yet</Text>
              <Text style={styles.emptyHint}>Create one to auto-generate orders on a schedule</Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md,
    backgroundColor: Colors.surface, borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  title: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text },
  addBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: Colors.primary, justifyContent: 'center', alignItems: 'center',
  },
  list: { padding: Spacing.md },
  card: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border, padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  cardInactive: { opacity: 0.6 },
  cardHeader: { flexDirection: 'row', gap: Spacing.sm, marginBottom: Spacing.sm },
  freqBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: Colors.primary, borderRadius: BorderRadius.full,
    paddingHorizontal: Spacing.sm, paddingVertical: 3,
  },
  freqBadgeText: { fontSize: FontSize.xs, color: Colors.white, fontWeight: '700' },
  typeBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: Colors.primary + '12', borderRadius: BorderRadius.full,
    paddingHorizontal: Spacing.sm, paddingVertical: 3,
  },
  typeBadgeText: { fontSize: FontSize.xs, color: Colors.primary, fontWeight: '600', textTransform: 'capitalize' },
  customerName: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  customerPhone: { fontSize: FontSize.sm, color: Colors.textSecondary },
  itemsList: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: Spacing.sm },
  totalAmount: { fontSize: FontSize.md, fontWeight: '700', color: Colors.primary, marginTop: 4 },
  cardFooter: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginTop: Spacing.sm, paddingTop: Spacing.sm, borderTopWidth: 1, borderTopColor: Colors.border,
  },
  nextRun: { fontSize: FontSize.sm, color: Colors.info, fontWeight: '600' },
  cardActions: { flexDirection: 'row', gap: Spacing.sm },
  actionBtn: { padding: 4 },
  locationHint: { fontSize: FontSize.xs, color: Colors.textLight, marginTop: 4 },
  emptyBox: { alignItems: 'center', marginTop: 80 },
  emptyText: { fontSize: FontSize.lg, color: Colors.textSecondary, fontWeight: '600', marginTop: Spacing.md },
  emptyHint: { fontSize: FontSize.sm, color: Colors.textLight, marginTop: 4, textAlign: 'center' },
});
