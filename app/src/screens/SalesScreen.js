import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, SectionList, TextInput,
  TouchableOpacity, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import api from '../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';
import { parseServerDate, formatDate, formatTime } from '../utils/datetime';

const STATUS_COLORS = { completed: Colors.success, cancelled: Colors.error, draft: Colors.warning, pending: Colors.warning, preparing: Colors.info, ready: Colors.success };
const PAY_COLORS = { paid: Colors.success, partial: Colors.warning, pending: Colors.error, refunded: Colors.textLight };

const FILTERS = [
  { key: '', label: 'All' },
  { key: 'walk_in', label: 'Walk-in' },
  { key: 'pickup', label: 'Pickup' },
  { key: 'delivery', label: 'Delivery' },
  { key: 'pre_order', label: 'Pre-order' },
];

// Helper: Group sales by date (newest first)
function groupSalesByDate(salesList) {
  if (!salesList.length) return [];

  // Sort by created_at (newest first)
  const sorted = [...salesList].sort((a, b) => 
    parseServerDate(b.created_at) - parseServerDate(a.created_at)
  );

  const grouped = {};
  sorted.forEach(sale => {
    const date = formatDate(sale.created_at, 'en-IN', {
      weekday: 'short', 
      year: 'numeric', 
      month: 'short', 
      day: 'numeric' 
    });
    if (!grouped[date]) grouped[date] = [];
    grouped[date].push(sale);
  });

  return Object.entries(grouped).map(([date, items]) => ({
    title: date,
    data: items,
  }));
}

export default function SalesScreen({ navigation }) {
  const [sales, setSales] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [summary, setSummary] = useState(null);

  React.useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: Spacing.md, marginRight: Spacing.md }}>
          <TouchableOpacity
            style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
            onPress={() => navigation.navigate('ProductionQueue')}
          >
            <Ionicons name="list" size={20} color={Colors.primary} />
            <Text style={{ fontSize: FontSize.xs, color: Colors.primary, fontWeight: '600' }}>Queue</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
            onPress={() => navigation.navigate('CashRegister')}
          >
            <Ionicons name="calculator" size={20} color={Colors.primary} />
            <Text style={{ fontSize: FontSize.xs, color: Colors.primary, fontWeight: '600' }}>Register</Text>
          </TouchableOpacity>
        </View>
      ),
    });
  }, [navigation]);

  useFocusEffect(
    useCallback(() => {
      fetchSales(1, true);
      fetchSummary();
    }, [filter])
  );

  const fetchSales = async (pg = 1, reset = false) => {
    try {
      const limit = 20;
      const params = { limit, offset: (pg - 1) * limit };
      if (search) params.search = search;
      if (filter) params.order_type = filter;
      const res = await api.getSales(params);
      const list = res.data?.sales || res.data || [];
      if (reset) {
        setSales(list);
      } else {
        setSales((prev) => [...prev, ...list]);
      }
      setHasMore(list.length >= limit);
      setPage(pg);
    } catch {} finally { setLoading(false); }
  };

  const fetchSummary = async () => {
    try {
      const res = await api.getTodaySummary();
      setSummary(res.data);
    } catch {}
  };

  const handleSearch = (text) => {
    setSearch(text);
    setLoading(true);
    fetchSales(1, true);
  };

  const loadMore = () => {
    if (hasMore && !loading) fetchSales(page + 1);
  };

  const renderSale = ({ item }) => {
    const statusColor = STATUS_COLORS[item.status] || Colors.textLight;
    const payColor = PAY_COLORS[item.payment_status] || Colors.textLight;
    return (
      <TouchableOpacity style={styles.card} onPress={() => navigation.navigate('SaleDetail', { saleId: item.id })} activeOpacity={0.7}>
        <View style={styles.cardHeader}>
          <Text style={styles.saleNo}>{item.sale_number}</Text>
          {item.source === 'recurring' && (
            <View style={[styles.badge, { backgroundColor: '#9C27B0' + '20', marginRight: 4 }]}>
              <Text style={[styles.badgeText, { color: '#9C27B0' }]}>RECURRING</Text>
            </View>
          )}
          <View style={[styles.badge, { backgroundColor: statusColor + '20' }]}>
            <Text style={[styles.badgeText, { color: statusColor }]}>{item.status?.toUpperCase()}</Text>
          </View>
        </View>
        <View style={styles.cardBody}>
          <View style={{ flex: 1 }}>
            <Text style={styles.cardMeta}>
              {(item.order_type || '').replace('_', ' ')} • {item.location_name || 'N/A'}
            </Text>
            {item.customer_name && <Text style={styles.cardCustomer}>{item.customer_name}</Text>}
            <Text style={styles.cardDate}>{formatTime(item.created_at, 'en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })}</Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={styles.cardTotal}>₹{(item.grand_total || 0).toFixed(0)}</Text>
            <View style={[styles.badge, { backgroundColor: payColor + '20', marginTop: 4 }]}>
              <Text style={[styles.badgeText, { color: payColor }]}>{(item.payment_status || '').toUpperCase()}</Text>
            </View>
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
      </TouchableOpacity>
    );
  };

  const renderSectionHeader = ({ section: { title } }) => (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
    </View>
  );

  return (
    <View style={styles.container}>
      {/* Today summary */}
      {summary && (
        <View style={styles.summaryBar}>
          <View style={styles.summaryItem}>
            <Text style={styles.summaryVal}>{summary.total_sales}</Text>
            <Text style={styles.summaryLabel}>Sales</Text>
          </View>
          <View style={styles.summaryItem}>
            <Text style={styles.summaryVal}>₹{(summary.total_revenue || 0).toFixed(0)}</Text>
            <Text style={styles.summaryLabel}>Revenue</Text>
          </View>
          <View style={styles.summaryItem}>
            <Text style={styles.summaryVal}>₹{(summary.total_tax || 0).toFixed(0)}</Text>
            <Text style={styles.summaryLabel}>Tax</Text>
          </View>
        </View>
      )}

      {/* Search */}
      <View style={styles.searchRow}>
        <View style={styles.searchWrap}>
          <Ionicons name="search" size={16} color={Colors.textLight} style={{ marginRight: 6 }} />
          <TextInput
            style={styles.searchInput}
            value={search}
            onChangeText={handleSearch}
            placeholder="Search invoice, customer..."
            placeholderTextColor={Colors.textLight}
          />
        </View>
      </View>

      {/* Filter chips */}
      <View style={styles.filterRow}>
        {FILTERS.map((f) => (
          <TouchableOpacity
            key={f.key}
            style={[styles.filterChip, filter === f.key && styles.filterChipActive]}
            onPress={() => setFilter(f.key)}
          >
            <Text style={[styles.filterChipText, filter === f.key && styles.filterChipTextActive]}>{f.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* List */}
      <SectionList
        sections={groupSalesByDate(sales)}
        keyExtractor={(item) => String(item.id)}
        renderItem={({ item }) => renderSale({ item })}
        renderSectionHeader={renderSectionHeader}
        contentContainerStyle={styles.listContent}
        onEndReached={loadMore}
        onEndReachedThreshold={0.3}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="receipt-outline" size={48} color={Colors.textLight} />
            <Text style={styles.emptyText}>{loading ? 'Loading...' : 'No sales found'}</Text>
          </View>
        }
        ListFooterComponent={loading && sales.length > 0 ? <ActivityIndicator style={{ margin: Spacing.md }} color={Colors.primary} /> : null}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },

  summaryBar: {
    flexDirection: 'row', backgroundColor: Colors.primary,
    paddingVertical: Spacing.md, paddingHorizontal: Spacing.md,
  },
  summaryItem: { flex: 1, alignItems: 'center' },
  summaryVal: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.white },
  summaryLabel: { fontSize: FontSize.xs, color: Colors.white + 'CC', marginTop: 2 },

  searchRow: { paddingHorizontal: Spacing.md, paddingTop: Spacing.sm },
  searchWrap: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.sm, height: 38,
    borderWidth: 1, borderColor: Colors.border,
  },
  searchInput: { flex: 1, fontSize: FontSize.sm, color: Colors.text },

  filterRow: {
    flexDirection: 'row', paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, gap: Spacing.xs,
  },
  filterChip: {
    paddingHorizontal: Spacing.sm, paddingVertical: 4,
    borderRadius: BorderRadius.full, borderWidth: 1, borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  filterChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  filterChipText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  filterChipTextActive: { color: Colors.white, fontWeight: '600' },

  listContent: { padding: Spacing.md, paddingBottom: 80 },
  card: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border, padding: Spacing.md,
    marginBottom: Spacing.sm,
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.xs },
  saleNo: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.text },
  badge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: BorderRadius.full },
  badgeText: { fontSize: 10, fontWeight: '700' },
  cardBody: { flexDirection: 'row', justifyContent: 'space-between' },
  cardMeta: { fontSize: FontSize.xs, color: Colors.textSecondary, textTransform: 'capitalize' },
  cardCustomer: { fontSize: FontSize.xs, color: Colors.text, marginTop: 2 },
  cardDate: { fontSize: FontSize.xs, color: Colors.textLight, marginTop: 2 },
  cardTotal: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },

  sectionHeader: {
    backgroundColor: Colors.primary + '15',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    marginTop: Spacing.md,
    marginBottom: Spacing.sm,
    borderLeftWidth: 3,
    borderLeftColor: Colors.primary,
  },
  sectionTitle: {
    fontSize: FontSize.sm,
    fontWeight: '700',
    color: Colors.primary,
  },

  empty: { alignItems: 'center', paddingTop: 80 },
  emptyText: { color: Colors.textLight, marginTop: Spacing.sm, fontSize: FontSize.sm },
});
