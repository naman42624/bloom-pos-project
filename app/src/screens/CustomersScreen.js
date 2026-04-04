import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  TextInput, RefreshControl, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import api from '../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

export default function CustomersScreen({ navigation }) {
  const [customers, setCustomers] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const fetchCustomers = useCallback(async (q, nextPage = 1, reset = false) => {
    try {
      const limit = 20;
      const params = { limit, offset: (nextPage - 1) * limit };
      if (q) params.search = q;
      const res = await api.getCustomers(params);
      const list = res.data || [];
      setCustomers((prev) => (reset ? list : [...prev, ...list]));
      setHasMore(list.length >= limit);
      setPage(nextPage);
    } catch {} finally {
      setLoading(false);
      setRefreshing(false);
      setLoadingMore(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { fetchCustomers(search, 1, true); }, [fetchCustomers, search]));

  const handleSearch = (text) => {
    setSearch(text);
    setLoading(true);
    fetchCustomers(text, 1, true);
  };

  const loadMore = () => {
    if (!hasMore || loadingMore || loading) return;
    setLoadingMore(true);
    fetchCustomers(search, page + 1, false);
  };

  const renderCustomer = ({ item }) => (
    <TouchableOpacity
      style={styles.card}
      onPress={() => navigation.navigate('CustomerDetail', { customerId: item.id })}
      activeOpacity={0.7}
    >
      <View style={styles.avatar}>
        <Text style={styles.avatarText}>{(item.name || '?')[0].toUpperCase()}</Text>
      </View>
      <View style={styles.info}>
        <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
        <Text style={styles.phone}>{item.phone}</Text>
        <View style={styles.statsRow}>
          {item.order_count > 0 && (
            <View style={styles.badge}>
              <Ionicons name="cart" size={11} color={Colors.primary} />
              <Text style={styles.badgeText}>{item.order_count} orders</Text>
            </View>
          )}
          {item.total_spent > 0 && (
            <View style={styles.badge}>
              <Ionicons name="cash" size={11} color={Colors.success} />
              <Text style={styles.badgeText}>₹{Number(item.total_spent).toFixed(0)}</Text>
            </View>
          )}
          {item.credit_balance > 0 && (
            <View style={[styles.badge, { backgroundColor: Colors.error + '15' }]}>
              <Ionicons name="alert-circle" size={11} color={Colors.error} />
              <Text style={[styles.badgeText, { color: Colors.error }]}>Due ₹{Number(item.credit_balance).toFixed(0)}</Text>
            </View>
          )}
        </View>
      </View>
      <Ionicons name="chevron-forward" size={18} color={Colors.textLight} />
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      {/* Search */}
      <View style={styles.searchRow}>
        <View style={styles.searchWrap}>
          <Ionicons name="search" size={18} color={Colors.textLight} style={{ marginRight: 6 }} />
          <TextInput
            style={styles.searchInput}
            value={search}
            onChangeText={handleSearch}
            placeholder="Search by name or phone..."
            placeholderTextColor={Colors.textLight}
          />
          {search.length > 0 && (
            <TouchableOpacity onPress={() => handleSearch('')}>
              <Ionicons name="close-circle" size={18} color={Colors.textLight} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      <FlatList
        data={customers}
        keyExtractor={(item) => `cust_${item.id}`}
        renderItem={renderCustomer}
        contentContainerStyle={styles.listContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchCustomers(search, 1, true); }} colors={[Colors.primary]} />}
        onEndReached={loadMore}
        onEndReachedThreshold={0.4}
        ListFooterComponent={loadingMore ? <ActivityIndicator style={{ paddingVertical: Spacing.md }} color={Colors.primary} /> : null}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="people-outline" size={48} color={Colors.textLight} />
            <Text style={styles.emptyText}>{loading ? 'Loading...' : 'No customers found'}</Text>
          </View>
        }
      />

      {/* FAB */}
      <TouchableOpacity style={styles.fab} onPress={() => navigation.navigate('CustomerForm')}>
        <Ionicons name="person-add" size={24} color={Colors.white} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  searchRow: {
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    backgroundColor: Colors.surface, borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  searchWrap: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: Colors.background, borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.sm, height: 40,
    borderWidth: 1, borderColor: Colors.border,
  },
  searchInput: { flex: 1, fontSize: FontSize.sm, color: Colors.text },
  listContent: { padding: Spacing.md, paddingBottom: 100, gap: Spacing.sm },
  card: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg,
    padding: Spacing.md, gap: Spacing.md,
    borderWidth: 1, borderColor: Colors.border,
  },
  avatar: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: Colors.primary + '15', justifyContent: 'center', alignItems: 'center',
  },
  avatarText: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.primary },
  info: { flex: 1 },
  name: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  phone: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  statsRow: { flexDirection: 'row', gap: Spacing.xs, marginTop: 4, flexWrap: 'wrap' },
  badge: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    paddingHorizontal: 6, paddingVertical: 2,
    backgroundColor: Colors.primary + '10', borderRadius: BorderRadius.full,
  },
  badgeText: { fontSize: FontSize.xs - 1, color: Colors.primary, fontWeight: '500' },
  empty: { alignItems: 'center', marginTop: 80, gap: Spacing.sm },
  emptyText: { fontSize: FontSize.md, color: Colors.textLight },
  fab: {
    position: 'absolute', bottom: 20, right: 20,
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: Colors.primary, justifyContent: 'center', alignItems: 'center',
    elevation: 5, shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25, shadowRadius: 4,
  },
});
