import React, { useState, useCallback, useRef } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, RefreshControl, ActivityIndicator, TextInput, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';
import { formatCardDateTime } from '../utils/datetime';

const STATUS_LABELS = { pending: 'Received', confirmed: 'Confirmed', preparing: 'In Preparation', ready: 'Ready', completed: 'Completed', cancelled: 'Cancelled', draft: 'Draft' };
const STATUS_COLORS = { pending: Colors.warning, confirmed: Colors.info, preparing: Colors.info, ready: Colors.success, completed: Colors.textSecondary, cancelled: Colors.error, draft: Colors.textLight };
const ORDER_TYPE_LABELS = { pickup: 'Pickup', delivery: 'Delivery', walk_in: 'Walk-in', pre_order: 'Advance order' };
const PAYMENT_STATUS_COLORS = { paid: Colors.success, partial: Colors.warning, pending: Colors.error, refunded: Colors.textLight };
const CHANNEL_ICONS = { whatsapp: 'logo-whatsapp', email: 'mail', website: 'globe', walk_in: 'walk', phone: 'call' };
const STATUS_FILTERS = [null, 'pending', 'confirmed', 'preparing', 'ready', 'completed'];
const CHANNEL_FILTERS = [null, 'whatsapp', 'email', 'website', 'walk_in', 'phone'];

function formatItemsSummary(items) {
  if (!items || items.length === 0) return null;
  const first = items[0];
  const firstLabel = `${Number(first.quantity) || 1}x ${first.product_name || 'Item'}`;
  if (items.length === 1) return firstLabel;
  return `${firstLabel} +${items.length - 1} more`;
}

function formatAmount(value) {
  const n = Number(value) || 0;
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

export default function OrdersInboxScreen({ navigation }) {
  const { user } = useAuth();
  // Owner/manager already have full Customers access via the More tab —
  // this shortcut is only for employee/counter_staff, who don't have a
  // 'Customers' route registered in their stack's owner/manager sibling
  // (OrdersStack), so it must not render there.
  const showCustomersShortcut = user?.role === 'employee' || user?.role === 'counter_staff';
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [statusFilter, setStatusFilter] = useState(null);
  const [channelFilter, setChannelFilter] = useState(null);
  const [priorityOnly, setPriorityOnly] = useState(false);
  const [search, setSearch] = useState('');
  const requestIdRef = useRef(0);
  const searchTimer = useRef(null);
  // fetchOrders reads the search term from this ref, not the `search` state,
  // so its identity (and therefore the useFocusEffect below) doesn't change on
  // every keystroke — only on an actual filter change or a debounced search
  // fetch. `search` state still drives the TextInput's displayed value.
  const searchRef = useRef('');

  const fetchOrders = useCallback(async (searchOverride) => {
    const requestId = ++requestIdRef.current;
    try {
      const params = { limit: 100 };
      if (statusFilter) params.status = statusFilter;
      if (channelFilter) params.channel = channelFilter;
      if (priorityOnly) params.priority = 'rush';
      const activeSearch = searchOverride !== undefined ? searchOverride : searchRef.current;
      if (activeSearch.trim()) params.search = activeSearch.trim();
      const res = await api.getSales(params);
      if (requestId !== requestIdRef.current) return; // a newer request superseded this one
      setOrders(res.data?.sales || []);
    } catch {
      if (requestId !== requestIdRef.current) return;
      setOrders([]);
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [statusFilter, channelFilter, priorityOnly]);

  useFocusEffect(useCallback(() => { setLoading(true); fetchOrders(); }, [fetchOrders]));

  const handleSearchChange = (text) => {
    setSearch(text);
    searchRef.current = text;
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => fetchOrders(text), 300);
  };

  const clearSearch = () => {
    setSearch('');
    searchRef.current = '';
    if (searchTimer.current) clearTimeout(searchTimer.current);
    fetchOrders('');
  };

  const renderItem = ({ item }) => {
    const itemsSummary = formatItemsSummary(item.items);
    const orderTypeLabel = ORDER_TYPE_LABELS[item.order_type] || item.order_type;
    const isUnpaid = item.payment_status && item.payment_status !== 'paid' && item.payment_status !== 'refunded';
    const statusColor = STATUS_COLORS[item.status] || Colors.textSecondary;

    return (
      <TouchableOpacity style={styles.row} onPress={() => navigation.navigate('SaleDetail', { saleId: item.id })}>
        <Ionicons name={CHANNEL_ICONS[item.channel] || 'ellipse'} size={20} color={Colors.textSecondary} style={styles.channelIcon} />
        <View style={styles.rowMain}>
          <Text style={styles.saleNumber}>{item.sale_number}{item.priority === 'rush' ? '  🔥 Rush' : ''}</Text>
          <Text style={styles.customerName}>{item.customer_display_name || item.customer_name || 'Walk-in'} · {orderTypeLabel}</Text>
          {itemsSummary && <Text style={styles.itemsSummary} numberOfLines={1}>{itemsSummary}</Text>}
          {item.scheduled_date && (
            <Text style={styles.scheduled}>📅 {formatCardDateTime(item.scheduled_date, item.scheduled_time)}</Text>
          )}
        </View>
        <View style={styles.rowSide}>
          <Text style={[styles.statusBadge, { color: statusColor }]}>{STATUS_LABELS[item.status] || item.status}</Text>
          <Text style={styles.amount}>{formatAmount(item.grand_total)}</Text>
          {isUnpaid && (
            <Text style={[styles.paymentBadge, { color: PAYMENT_STATUS_COLORS[item.payment_status] || Colors.error }]}>
              {item.payment_status === 'partial' ? 'Partly paid' : 'Unpaid'}
            </Text>
          )}
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      {/* PickupOrdersScreen (the only screen with the "mark picked up /
          collect payment" action) was never registered in this stack at
          all — counter_staff had zero path to it, even after the backend
          gained permission to confirm pickup payment. Owner/manager reach
          it via their own OrdersHub, so this link is scoped to the roles
          that only have this stack (2026-09-01, sub-project 4 audit).
          DeliveriesList added the same day for the same reason, sub-
          project 5 — the list/at-risk monitoring view, not just a single
          delivery's own detail (already reachable via SaleDetail). */}
      {showCustomersShortcut && (
        <View style={styles.quickLinksRow}>
          <TouchableOpacity style={styles.pickupLink} onPress={() => navigation.navigate('PickupOrders')}>
            <Ionicons name="bag-handle-outline" size={16} color={Colors.primary} />
            <Text style={styles.pickupLinkText}>Pickup Orders →</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.pickupLink} onPress={() => navigation.navigate('DeliveriesList')}>
            <Ionicons name="bicycle-outline" size={16} color={Colors.primary} />
            <Text style={styles.pickupLinkText}>Deliveries →</Text>
          </TouchableOpacity>
        </View>
      )}
      <View style={styles.searchRow}>
        <Ionicons name="search" size={18} color={Colors.textLight} />
        <TextInput
          style={styles.searchInput}
          value={search}
          onChangeText={handleSearchChange}
          placeholder="Search order #, customer, phone, item…"
          placeholderTextColor={Colors.textLight}
        />
        {search.length > 0 && (
          <TouchableOpacity onPress={clearSearch}>
            <Ionicons name="close-circle" size={18} color={Colors.textLight} />
          </TouchableOpacity>
        )}
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}>
        {STATUS_FILTERS.map((s) => (
          <TouchableOpacity key={s || 'all'} style={[styles.filterChip, statusFilter === s && styles.filterChipSelected]} onPress={() => setStatusFilter(s)}>
            <Text style={[styles.filterChipText, statusFilter === s && styles.filterChipTextSelected]}>{s ? STATUS_LABELS[s] : 'All'}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}>
        {CHANNEL_FILTERS.map((c) => (
          <TouchableOpacity key={c || 'all'} style={[styles.filterChip, channelFilter === c && styles.filterChipSelected]} onPress={() => setChannelFilter(c)}>
            <Text style={[styles.filterChipText, channelFilter === c && styles.filterChipTextSelected]}>{c || 'Any channel'}</Text>
          </TouchableOpacity>
        ))}
        <TouchableOpacity style={[styles.filterChip, priorityOnly && styles.filterChipSelected]} onPress={() => setPriorityOnly((v) => !v)}>
          <Text style={[styles.filterChipText, priorityOnly && styles.filterChipTextSelected]}>🔥 Rush only</Text>
        </TouchableOpacity>
      </ScrollView>

      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={Colors.primary} />
      ) : (
        <FlatList
          data={orders}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderItem}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchOrders(); }} colors={[Colors.primary]} />}
          ListEmptyComponent={<Text style={styles.empty}>No orders match these filters.</Text>}
          contentContainerStyle={{ padding: Spacing.md }}
        />
      )}

      {/* Secondary action — smaller than the primary Log Order FAB, so it
          doesn't compete for attention on a screen with one clear main task.
          Lets counter staff check a customer's outstanding balance without
          an active checkout (e.g. a phone call asking about dues). Owner/
          manager already have this via the More tab, so it's hidden there —
          this screen is also reachable by their OrdersStack, which has no
          'Customers' route registered. */}
      {showCustomersShortcut && (
        <TouchableOpacity style={styles.fabSecondary} onPress={() => navigation.navigate('Customers')}>
          <Ionicons name="people" size={22} color={Colors.primary} />
        </TouchableOpacity>
      )}

      <TouchableOpacity style={styles.fab} onPress={() => navigation.navigate('LogOrder')}>
        <Ionicons name="add" size={28} color={Colors.white} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  quickLinksRow: {
    flexDirection: 'row', justifyContent: 'flex-end', gap: Spacing.md,
    paddingHorizontal: Spacing.md, paddingTop: Spacing.sm,
  },
  pickupLink: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
  },
  pickupLinkText: { color: Colors.primary, fontWeight: '600', fontSize: FontSize.sm },
  searchRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.sm, marginHorizontal: Spacing.md, marginTop: Spacing.sm,
    borderWidth: 1, borderColor: Colors.border,
  },
  searchInput: { flex: 1, fontSize: FontSize.md, color: Colors.text, minHeight: 44 },
  filterRow: { flexDirection: 'row', gap: 6, paddingHorizontal: Spacing.md, paddingTop: Spacing.sm },
  filterChip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: BorderRadius.lg, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, minHeight: 36 },
  filterChipSelected: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  filterChipText: { fontSize: FontSize.sm, color: Colors.text, fontWeight: '600' },
  filterChipTextSelected: { color: Colors.white },
  row: { flexDirection: 'row', alignItems: 'flex-start', backgroundColor: Colors.surface, borderRadius: BorderRadius.lg, padding: Spacing.md, marginBottom: Spacing.sm },
  channelIcon: { marginRight: Spacing.sm, marginTop: 2 },
  rowMain: { flex: 1 },
  saleNumber: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  customerName: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  itemsSummary: { fontSize: FontSize.sm, color: Colors.text, marginTop: 4 },
  scheduled: { fontSize: FontSize.xs, color: Colors.info, fontWeight: '600', marginTop: 4 },
  rowSide: { alignItems: 'flex-end', marginLeft: Spacing.sm },
  statusBadge: { fontSize: FontSize.sm, fontWeight: '700' },
  amount: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.text, marginTop: 4 },
  paymentBadge: { fontSize: FontSize.xs, fontWeight: '700', marginTop: 4 },
  empty: { textAlign: 'center', color: Colors.textLight, marginTop: 40 },
  fab: { position: 'absolute', right: Spacing.lg, bottom: Spacing.lg, width: 56, height: 56, borderRadius: 28, backgroundColor: Colors.primary, justifyContent: 'center', alignItems: 'center', elevation: 4, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 4 },
  fabSecondary: { position: 'absolute', right: Spacing.lg, bottom: Spacing.lg + 68, width: 44, height: 44, borderRadius: 22, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, justifyContent: 'center', alignItems: 'center', elevation: 3, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.15, shadowRadius: 3 },
});
