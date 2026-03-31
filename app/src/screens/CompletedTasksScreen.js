import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  ActivityIndicator, TextInput, Platform, useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { formatDateTime } from '../utils/datetime';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const FILTER_TABS = [
  { key: 'completed', label: 'Completed' },
  { key: 'cancelled', label: 'Cancelled' },
  { key: 'all', label: 'All' },
];

export default function CompletedTasksScreen({ navigation }) {
  const { width } = useWindowDimensions();
  const isTablet = width >= 768;
  const { user } = useAuth();
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('completed');
  const [search, setSearch] = useState('');

  const fetchTasks = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getProductionTasks({
        status: filter === 'all' ? 'completed,cancelled' : filter,
        limit: 100,
      });
      setTasks(res.data || []);
    } catch (e) {
      console.error('Fetch completed tasks error:', e);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useFocusEffect(
    useCallback(() => {
      fetchTasks();
    }, [fetchTasks])
  );

  const filtered = tasks.filter(t => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      (t.product_name || '').toLowerCase().includes(q) ||
      (t.sale_number || '').toLowerCase().includes(q) ||
      (t.assigned_to_name || '').toLowerCase().includes(q)
    );
  });

  const renderTask = ({ item }) => {
    const isCompleted = item.status === 'completed';
    const statusColor = isCompleted ? Colors.success : Colors.textLight;
    const statusLabel = isCompleted ? 'Completed' : 'Cancelled';

    return (
      <TouchableOpacity
        style={[styles.card, isTablet && { flexDirection: 'row', alignItems: 'center' }]}
        onPress={() => {
          if (item.sale_id) {
            navigation.navigate('SaleDetail', { saleId: item.sale_id });
          }
        }}
        activeOpacity={0.7}
      >
        <View style={[{ flex: 1 }, isTablet && { flexDirection: 'row', alignItems: 'center', gap: Spacing.lg }]}>
          <View style={{ flex: 1 }}>
            <Text style={styles.productName}>{item.quantity || 1}x {item.product_name}</Text>
            <Text style={styles.saleNumber}>{item.sale_number} • {item.order_type?.replace('_', ' ')}</Text>
          </View>
          
          <View style={[styles.cardDetails, isTablet && { marginTop: 0, flexDirection: 'row', gap: Spacing.lg, flex: 1.5 }]}>
            {item.assigned_to_name && (
              <View style={styles.detailRow}>
                <Ionicons name="person-outline" size={14} color={Colors.textSecondary} />
                <Text style={styles.detailText}>{item.assigned_to_name}</Text>
              </View>
            )}
            {item.completed_at && (
              <View style={[styles.detailRow, isTablet && { minWidth: 140 }]}>
                <Ionicons name="time-outline" size={14} color={Colors.textSecondary} />
                <Text style={styles.detailText}>{formatDateTime(item.completed_at || item.updated_at)}</Text>
              </View>
            )}
            {item.special_instructions && !isTablet && (
              <View style={styles.detailRow}>
                <Ionicons name="document-text-outline" size={14} color={Colors.textSecondary} />
                <Text style={styles.detailText} numberOfLines={1}>{item.special_instructions}</Text>
              </View>
            )}
          </View>
        </View>

        <View style={[styles.statusBadge, { backgroundColor: statusColor + '15' }, isTablet && { marginLeft: Spacing.md }]}>
          <Ionicons
            name={isCompleted ? 'checkmark-circle' : 'close-circle'}
            size={14}
            color={statusColor}
          />
          <Text style={[styles.statusText, { color: statusColor }]}>{statusLabel}</Text>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      {/* Filter Tabs */}
      <View style={styles.tabRow}>
        {FILTER_TABS.map(tab => (
          <TouchableOpacity
            key={tab.key}
            style={[styles.tab, filter === tab.key && styles.tabActive]}
            onPress={() => setFilter(tab.key)}
          >
            <Text style={[styles.tabText, filter === tab.key && styles.tabTextActive]}>
              {tab.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Search */}
      <View style={styles.searchRow}>
        <Ionicons name="search" size={18} color={Colors.textLight} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search product, order, or staff..."
          placeholderTextColor={Colors.textLight}
          value={search}
          onChangeText={setSearch}
        />
        {search.length > 0 && (
          <TouchableOpacity onPress={() => setSearch('')}>
            <Ionicons name="close-circle" size={18} color={Colors.textLight} />
          </TouchableOpacity>
        )}
      </View>

      {/* Summary */}
      <View style={styles.summaryRow}>
        <Text style={styles.summaryText}>
          {filtered.length} task{filtered.length !== 1 ? 's' : ''}
        </Text>
      </View>

      {/* Task list */}
      {loading ? (
        <ActivityIndicator size="large" color={Colors.primary} style={{ marginTop: 40 }} />
      ) : filtered.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="checkmark-done-circle-outline" size={48} color={Colors.textLight} />
          <Text style={styles.emptyText}>
            {filter === 'completed' ? 'No completed tasks yet' : 'No cancelled tasks'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          renderItem={renderTask}
          keyExtractor={item => String(item.id)}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },

  tabRow: {
    flexDirection: 'row', paddingHorizontal: Spacing.md,
    paddingTop: Spacing.sm, gap: Spacing.xs,
  },
  tab: {
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs + 2,
    borderRadius: BorderRadius.full, backgroundColor: Colors.surface,
    borderWidth: 1, borderColor: Colors.border,
  },
  tabActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  tabText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
  tabTextActive: { color: Colors.white },

  searchRow: {
    flexDirection: 'row', alignItems: 'center',
    margin: Spacing.md, paddingHorizontal: Spacing.sm,
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border, gap: Spacing.xs,
  },
  searchInput: {
    flex: 1, paddingVertical: Platform.OS === 'ios' ? Spacing.sm : Spacing.xs,
    fontSize: FontSize.sm, color: Colors.text,
  },

  summaryRow: {
    paddingHorizontal: Spacing.md, marginBottom: Spacing.xs,
  },
  summaryText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },

  listContent: { paddingHorizontal: Spacing.md, paddingBottom: Spacing.xl, gap: Spacing.md },

  card: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border, padding: Spacing.md,
  },
  cardTop: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start',
  },
  productName: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  saleNumber: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  statusBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: Spacing.sm, paddingVertical: 3, borderRadius: BorderRadius.full,
  },
  statusText: { fontSize: FontSize.xs, fontWeight: '700' },
  cardDetails: { marginTop: Spacing.sm, gap: 4 },
  detailRow: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
  },
  detailText: { fontSize: FontSize.sm, color: Colors.textSecondary, flex: 1 },

  empty: { alignItems: 'center', paddingVertical: 60 },
  emptyText: { fontSize: FontSize.md, color: Colors.textLight, marginTop: Spacing.sm },
});
