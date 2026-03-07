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
  initiated: { color: Colors.info, icon: 'arrow-forward-circle-outline' },
  in_transit: { color: Colors.warning, icon: 'bus-outline' },
  received: { color: Colors.success, icon: 'checkmark-done-circle' },
  cancelled: { color: Colors.error, icon: 'close-circle-outline' },
};

export default function StockTransfersScreen({ navigation }) {
  const { user } = useAuth();
  const [transfers, setTransfers] = useState([]);
  const [statusFilter, setStatusFilter] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchTransfers = useCallback(async () => {
    try {
      const params = {};
      if (statusFilter) params.status = statusFilter;
      const res = await api.getStockTransfers(params);
      setTransfers(res.data || []);
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to load transfers');
    } finally { setLoading(false); setRefreshing(false); }
  }, [statusFilter]);

  useFocusEffect(useCallback(() => { fetchTransfers(); }, [fetchTransfers]));

  const handleReceive = (transfer) => {
    Alert.alert('Receive Transfer', `Receive ${transfer.quantity} ${transfer.unit} of ${transfer.material_name}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Receive',
        onPress: async () => {
          try {
            await api.receiveStockTransfer(transfer.id);
            fetchTransfers();
          } catch (err) { Alert.alert('Error', err.message); }
        },
      },
    ]);
  };

  const handleCancel = (transfer) => {
    Alert.alert('Cancel Transfer', 'Are you sure? Stock will be returned to source.', [
      { text: 'No', style: 'cancel' },
      {
        text: 'Yes, Cancel',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.cancelStockTransfer(transfer.id);
            fetchTransfers();
          } catch (err) { Alert.alert('Error', err.message); }
        },
      },
    ]);
  };

  const statusFilters = [
    { key: null, label: 'All' },
    { key: 'initiated', label: 'Initiated' },
    { key: 'in_transit', label: 'In Transit' },
    { key: 'received', label: 'Received' },
    { key: 'cancelled', label: 'Cancelled' },
  ];

  const renderItem = ({ item }) => {
    const cfg = STATUS_CONFIG[item.status] || STATUS_CONFIG.initiated;
    const canReceive = item.status === 'initiated' || item.status === 'in_transit';
    const canCancel = item.status === 'initiated' || item.status === 'in_transit';

    return (
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={[styles.iconBox, { backgroundColor: cfg.color + '15' }]}>
            <Ionicons name={cfg.icon} size={20} color={cfg.color} />
          </View>
          <View style={styles.cardInfo}>
            <Text style={styles.materialName}>{item.material_name}</Text>
            <Text style={styles.route}>{item.from_location_name} → {item.to_location_name}</Text>
          </View>
          <View style={styles.qtyBox}>
            <Text style={styles.qtyText}>{item.quantity}</Text>
            <Text style={styles.unitText}>{item.unit}</Text>
          </View>
        </View>

        <View style={styles.cardFooter}>
          <View style={[styles.statusBadge, { backgroundColor: cfg.color + '20' }]}>
            <Text style={[styles.statusText, { color: cfg.color }]}>{item.status.replace(/_/g, ' ')}</Text>
          </View>
          <Text style={styles.dateText}>By: {item.initiated_by_name}</Text>
          <Text style={styles.dateText}>{new Date(item.created_at).toLocaleDateString()}</Text>
        </View>

        {(canReceive || canCancel) && (
          <View style={styles.actionRow}>
            {canReceive && (
              <TouchableOpacity style={[styles.actionBtn, { backgroundColor: Colors.success }]} onPress={() => handleReceive(item)}>
                <Ionicons name="checkmark" size={16} color={Colors.white} />
                <Text style={styles.actionText}>Receive</Text>
              </TouchableOpacity>
            )}
            {canCancel && (user?.role === 'owner' || user?.role === 'manager') && (
              <TouchableOpacity style={[styles.actionBtn, { backgroundColor: Colors.error }]} onPress={() => handleCancel(item)}>
                <Ionicons name="close" size={16} color={Colors.white} />
                <Text style={styles.actionText}>Cancel</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <FlatList
        horizontal showsHorizontalScrollIndicator={false}
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
        data={transfers}
        keyExtractor={(item) => String(item.id)}
        renderItem={renderItem}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchTransfers(); }} colors={[Colors.primary]} />
        }
        ListEmptyComponent={
          !loading && (
            <View style={styles.empty}>
              <Ionicons name="swap-horizontal-outline" size={48} color={Colors.textLight} />
              <Text style={styles.emptyTitle}>No transfers</Text>
              <Text style={styles.emptyText}>Transfer stock between locations</Text>
            </View>
          )
        }
      />

      {(user?.role === 'owner' || user?.role === 'manager') && (
        <TouchableOpacity style={styles.fab} onPress={() => navigation.navigate('StockTransferForm')} activeOpacity={0.8}>
          <Ionicons name="swap-horizontal" size={24} color={Colors.white} />
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
  materialName: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  route: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },
  qtyBox: { alignItems: 'center' },
  qtyText: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  unitText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  cardFooter: { flexDirection: 'row', alignItems: 'center', marginTop: Spacing.sm, gap: Spacing.md },
  statusBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: BorderRadius.sm },
  statusText: { fontSize: FontSize.xs, fontWeight: '500', textTransform: 'capitalize' },
  dateText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  actionRow: { flexDirection: 'row', marginTop: Spacing.sm, gap: Spacing.sm },
  actionBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: Spacing.xs + 2, borderRadius: BorderRadius.md, gap: 4,
  },
  actionText: { color: Colors.white, fontWeight: '600', fontSize: FontSize.xs },
  empty: { alignItems: 'center', paddingTop: 80 },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: '600', color: Colors.textSecondary, marginTop: Spacing.md },
  emptyText: { fontSize: FontSize.sm, color: Colors.textLight, marginTop: Spacing.xs },
  fab: {
    position: 'absolute', bottom: 20, right: 20, width: 56, height: 56, borderRadius: 28,
    backgroundColor: Colors.primary, justifyContent: 'center', alignItems: 'center',
    shadowColor: Colors.primary, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: 6,
  },
});
