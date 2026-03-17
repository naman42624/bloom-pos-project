import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  RefreshControl, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const STATUS_CONFIG = {
  pending: { color: Colors.warning, icon: 'time-outline' },
  expected: { color: Colors.info, icon: 'time-outline' },
  partial: { color: Colors.warning, icon: 'checkmark-circle-outline' },
  partially_received: { color: Colors.warning, icon: 'checkmark-circle-outline' },
  received: { color: Colors.success, icon: 'checkmark-done-circle' },
  cancelled: { color: Colors.error, icon: 'close-circle-outline' },
};

export default function PurchaseOrdersScreen({ navigation }) {
  const { user } = useAuth();
  const [orders, setOrders] = useState([]);
  const [statusFilter, setStatusFilter] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchOrders = useCallback(async () => {
    try {
      const params = {};
      if (statusFilter) params.status = statusFilter;
      const res = await api.getPurchaseOrders(params);
      setOrders(res.data || []);
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to load orders');
    } finally { setLoading(false); setRefreshing(false); }
  }, [statusFilter]);

  useFocusEffect(useCallback(() => { fetchOrders(); }, [fetchOrders]));

  const statusFilters = [
    { key: null, label: 'All' },
    { key: 'pending', label: 'Pending' },
    { key: 'expected', label: 'Expected' },
    { key: 'partial', label: 'Partial' },
    { key: 'partially_received', label: 'Partial' },
    { key: 'received', label: 'Received' },
    { key: 'cancelled', label: 'Cancelled' },
  ];

  const renderItem = ({ item }) => {
    const cfg = STATUS_CONFIG[item.status] || STATUS_CONFIG.expected;
    return (
      <TouchableOpacity
        style={styles.card}
        onPress={() => navigation.navigate('PurchaseOrderDetail', { orderId: item.id })}
        activeOpacity={0.7}
      >
        <View style={styles.cardHeader}>
          <View style={[styles.iconBox, { backgroundColor: cfg.color + '15' }]}>
            <Ionicons name={cfg.icon} size={20} color={cfg.color} />
          </View>
          <View style={styles.cardInfo}>
            <Text style={styles.cardName}>{item.po_number}</Text>
            <Text style={styles.cardMeta}>{item.supplier_name} · {item.location_name}</Text>
          </View>
          <View style={styles.cardRight}>
            {item.total_amount !== undefined && <Text style={styles.amount}>₹{item.total_amount}</Text>}
            <View style={[styles.statusBadge, { backgroundColor: cfg.color + '20' }]}>
              <Text style={[styles.statusText, { color: cfg.color }]}>
                {item.status.replace(/_/g, ' ')}
              </Text>
            </View>
          </View>
        </View>
        <View style={styles.cardFooter}>
          <Text style={styles.footerText}>{item.item_count} items</Text>
          {item.expected_date && (
            <Text style={styles.footerText}>Due: {item.expected_date}</Text>
          )}
          <Text style={styles.footerText}>{new Date(item.created_at).toLocaleDateString()}</Text>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      <FlatList
        horizontal
        showsHorizontalScrollIndicator={false}
        data={statusFilters}
        keyExtractor={(item) => String(item.key ?? 'all')}
        contentContainerStyle={styles.chipList}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={[styles.chip, statusFilter === item.key && styles.chipActive]}
            onPress={() => setStatusFilter(item.key)}
          >
            <Text style={[styles.chipText, statusFilter === item.key && styles.chipTextActive]}>{item.label}</Text>
          </TouchableOpacity>
        )}
      />

      <FlatList
        data={orders}
        keyExtractor={(item) => String(item.id)}
        renderItem={renderItem}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchOrders(); }} colors={[Colors.primary]} />
        }
        ListEmptyComponent={
          !loading && (
            <View style={styles.empty}>
              <Ionicons name="document-text-outline" size={48} color={Colors.textLight} />
              <Text style={styles.emptyTitle}>No purchase orders</Text>
              <Text style={styles.emptyText}>Create your first order</Text>
            </View>
          )
        }
      />

      {(user?.role === 'owner' || user?.role === 'manager') && (
        <TouchableOpacity style={styles.fab} onPress={() => navigation.navigate('PurchaseOrderForm')} activeOpacity={0.8}>
          <Ionicons name="add" size={28} color={Colors.white} />
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  chipList: { paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, gap: Spacing.sm },
  chip: {
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs + 2, borderRadius: BorderRadius.full,
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '500' },
  chipTextActive: { color: Colors.white },
  listContent: { padding: Spacing.md, paddingBottom: 100 },
  card: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg,
    padding: Spacing.md, marginBottom: Spacing.md,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 3, elevation: 2,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center' },
  iconBox: { width: 40, height: 40, borderRadius: BorderRadius.md, justifyContent: 'center', alignItems: 'center', marginRight: Spacing.md },
  cardInfo: { flex: 1 },
  cardName: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  cardMeta: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },
  cardRight: { alignItems: 'flex-end' },
  amount: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  statusBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: BorderRadius.sm, marginTop: 4 },
  statusText: { fontSize: FontSize.xs, fontWeight: '500', textTransform: 'capitalize' },
  cardFooter: { flexDirection: 'row', marginTop: Spacing.sm, gap: Spacing.md },
  footerText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  empty: { alignItems: 'center', paddingTop: 80 },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: '600', color: Colors.textSecondary, marginTop: Spacing.md },
  emptyText: { fontSize: FontSize.sm, color: Colors.textLight, marginTop: Spacing.xs },
  fab: {
    position: 'absolute', bottom: 20, right: 20, width: 56, height: 56, borderRadius: 28,
    backgroundColor: Colors.primary, justifyContent: 'center', alignItems: 'center',
    shadowColor: Colors.primary, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: 6,
  },
});
