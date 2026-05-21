import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  TextInput, RefreshControl, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import api from '../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const LIMIT = 20;

export default function CustomersScreen({ navigation }) {
  const [customers, setCustomers] = useState([]);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('name_asc');
  const [hasDue, setHasDue] = useState(false);
  const [showFilters, setShowFilters] = useState(false);

  // ─── UI state (only for rendering) ───────────────────────────────────────
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  // ─── Pagination state lives entirely in refs ──────────────────────────────
  // Refs are synchronous — no stale closure bugs, no async batch delays.
  const pageRef = useRef(1);
  const hasMoreRef = useRef(false);
  const isFetchingRef = useRef(false);

  // Keep the latest filter values in refs so loadMore can read them without
  // capturing a stale closure.
  const searchRef = useRef('');
  const sortRef = useRef('name_asc');
  const hasDueRef = useRef(false);

  // ─── Core fetch ───────────────────────────────────────────────────────────
  const fetchCustomers = useCallback(async (opts = {}) => {
    const {
      page = 1,
      reset = false,
      q = searchRef.current,
      s = sortRef.current,
      d = hasDueRef.current,
    } = opts;

    // Atomic lock: set synchronously before any await
    isFetchingRef.current = true;

    try {
      const params = { limit: LIMIT, offset: (page - 1) * LIMIT, sort: s };
      if (q) params.search = q;
      if (d) params.has_due = 'true';

      const res = await api.getCustomers(params);
      const list = res.data || [];

      const more = list.length >= LIMIT;
      hasMoreRef.current = more;
      pageRef.current = page;

      setCustomers(prev => reset ? list : [...prev, ...list]);
      setHasMore(more);
    } catch (err) {
      console.error('[CustomersScreen] fetchCustomers error:', err);
    } finally {
      isFetchingRef.current = false;
      setLoading(false);
      setRefreshing(false);
      setLoadingMore(false);
    }
  }, []);

  // ─── Load next page ───────────────────────────────────────────────────────
  const loadMore = useCallback(() => {
    // All checks against refs — always current, never stale
    if (!hasMoreRef.current || isFetchingRef.current) return;

    setLoadingMore(true);
    fetchCustomers({ page: pageRef.current + 1, reset: false });
  }, [fetchCustomers]);

  // ─── Initial load & re-load on focus ─────────────────────────────────────
  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      fetchCustomers({ page: 1, reset: true });
    }, [fetchCustomers, search, sort, hasDue])
  );

  // ─── Search ───────────────────────────────────────────────────────────────
  const handleSearch = useCallback((text) => {
    setSearch(text);
    searchRef.current = text;
    setLoading(true);
    fetchCustomers({ page: 1, reset: true, q: text });
  }, [fetchCustomers]);

  // ─── Sort ─────────────────────────────────────────────────────────────────
  const handleSortChange = useCallback((newSort) => {
    setSort(newSort);
    sortRef.current = newSort;
    setLoading(true);
    fetchCustomers({ page: 1, reset: true, s: newSort });
  }, [fetchCustomers]);

  // ─── Filter ───────────────────────────────────────────────────────────────
  const handleFilterChange = useCallback((newHasDue) => {
    setHasDue(newHasDue);
    hasDueRef.current = newHasDue;
    setLoading(true);
    fetchCustomers({ page: 1, reset: true, d: newHasDue });
  }, [fetchCustomers]);

  // ─── Render ───────────────────────────────────────────────────────────────
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
          {item.order_count > 0 ? (
            <View style={styles.badge}>
              <Ionicons name="cart" size={11} color={Colors.primary} />
              <Text style={styles.badgeText}>{item.order_count} orders</Text>
            </View>
          ) : null}
          {item.total_spent > 0 ? (
            <View style={styles.badge}>
              <Ionicons name="cash" size={11} color={Colors.success} />
              <Text style={styles.badgeText}>₹{Number(item.total_spent).toFixed(0)}</Text>
            </View>
          ) : null}
          {item.credit_balance > 0 ? (
            <View style={[styles.badge, { backgroundColor: Colors.error + '15' }]}>
              <Ionicons name="alert-circle" size={11} color={Colors.error} />
              <Text style={[styles.badgeText, { color: Colors.error }]}>Due ₹{Number(item.credit_balance).toFixed(0)}</Text>
            </View>
          ) : null}
        </View>
      </View>
      <Ionicons name="chevron-forward" size={18} color={Colors.textLight} />
    </TouchableOpacity>
  );

  // Footer: shows a spinner while fetching more, or a "Load More" button when
  // there are more items but we are not currently fetching.
  const ListFooter = () => {
    if (loading) return null;
    if (loadingMore) {
      return (
        <View style={styles.footer}>
          <ActivityIndicator color={Colors.primary} />
        </View>
      );
    }
    if (hasMore) {
      return (
        <TouchableOpacity style={styles.loadMoreBtn} onPress={loadMore} activeOpacity={0.7}>
          <Ionicons name="chevron-down" size={16} color={Colors.primary} />
          <Text style={styles.loadMoreText}>Load More</Text>
        </TouchableOpacity>
      );
    }
    if (customers.length > 0) {
      return (
        <View style={styles.footer}>
          <Text style={styles.endText}>All customers loaded</Text>
        </View>
      );
    }
    return null;
  };

  return (
    <View style={styles.container}>
      {/* Search & Filter Header */}
      <View style={styles.headerContainer}>
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
            {search.length > 0 ? (
              <TouchableOpacity onPress={() => handleSearch('')}>
                <Ionicons name="close-circle" size={18} color={Colors.textLight} />
              </TouchableOpacity>
            ) : null}
          </View>
          <TouchableOpacity
            style={[styles.filterToggle, showFilters && styles.filterToggleActive, hasDue && !showFilters && styles.filterToggleActiveDue]}
            onPress={() => setShowFilters(!showFilters)}
          >
            <Ionicons name="options-outline" size={20} color={(showFilters || hasDue) ? Colors.primary : Colors.textLight} />
          </TouchableOpacity>
        </View>

        {showFilters ? (
          <View style={styles.filtersPanel}>
            <Text style={styles.filterSectionTitle}>Sort By</Text>
            <View style={styles.chipsRow}>
              {[
                { label: 'Name (A-Z)', value: 'name_asc' },
                { label: 'Highest Spend', value: 'spent_desc' },
                { label: 'Highest Due', value: 'due_desc' },
                { label: 'Recent', value: 'recent_desc' },
              ].map(opt => (
                <TouchableOpacity
                  key={opt.value}
                  style={[styles.chip, sort === opt.value && styles.chipActive]}
                  onPress={() => handleSortChange(opt.value)}
                >
                  <Text style={[styles.chipText, sort === opt.value && styles.chipTextActive]}>{opt.label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={[styles.filterSectionTitle, { marginTop: Spacing.sm }]}>Filters</Text>
            <View style={styles.chipsRow}>
              <TouchableOpacity
                style={[styles.chip, hasDue && styles.chipActive]}
                onPress={() => handleFilterChange(!hasDue)}
              >
                <Ionicons name={hasDue ? "checkmark-circle" : "ellipse-outline"} size={14} color={hasDue ? Colors.white : Colors.textLight} style={{ marginRight: 4 }} />
                <Text style={[styles.chipText, hasDue && styles.chipTextActive]}>Has Due Balance</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : null}
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      ) : (
        <FlatList
          data={customers}
          keyExtractor={(item, index) => `cust_${item.id || item.phone || index}`}
          renderItem={renderCustomer}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                fetchCustomers({ page: 1, reset: true });
              }}
              colors={[Colors.primary]}
            />
          }
          onEndReached={loadMore}
          onEndReachedThreshold={0.5}
          ListFooterComponent={<ListFooter />}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="people-outline" size={48} color={Colors.textLight} />
              <Text style={styles.emptyText}>No customers found</Text>
            </View>
          }
        />
      )}

      {/* FAB */}
      <TouchableOpacity style={styles.fab} onPress={() => navigation.navigate('CustomerForm')}>
        <Ionicons name="person-add" size={24} color={Colors.white} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  headerContainer: {
    backgroundColor: Colors.surface, borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  searchRow: {
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
  },
  searchWrap: {
    flex: 1, flexDirection: 'row', alignItems: 'center',
    backgroundColor: Colors.background, borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.sm, height: 40,
    borderWidth: 1, borderColor: Colors.border,
  },
  searchInput: { flex: 1, fontSize: FontSize.sm, color: Colors.text },
  filterToggle: {
    width: 40, height: 40, borderRadius: BorderRadius.md,
    backgroundColor: Colors.background, borderWidth: 1, borderColor: Colors.border,
    justifyContent: 'center', alignItems: 'center',
  },
  filterToggleActive: { borderColor: Colors.primary, backgroundColor: Colors.primary + '10' },
  filterToggleActiveDue: { borderColor: Colors.primary },
  filtersPanel: {
    paddingHorizontal: Spacing.md, paddingBottom: Spacing.md,
    borderTopWidth: 1, borderTopColor: Colors.border, paddingTop: Spacing.sm,
  },
  filterSectionTitle: {
    fontSize: FontSize.xs, color: Colors.textLight, fontWeight: '600',
    marginBottom: Spacing.xs, textTransform: 'uppercase',
  },
  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  chip: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.sm, paddingVertical: 6,
    borderRadius: BorderRadius.full, borderWidth: 1, borderColor: Colors.border,
    backgroundColor: Colors.background,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: FontSize.sm, color: Colors.textSecondary },
  chipTextActive: { color: Colors.white, fontWeight: '500' },
  listContent: { padding: Spacing.md, paddingBottom: 100 },
  card: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg,
    padding: Spacing.md, gap: Spacing.md,
    marginBottom: Spacing.sm,
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
  footer: { alignItems: 'center', paddingVertical: Spacing.md },
  endText: { fontSize: FontSize.xs, color: Colors.textLight },
  loadMoreBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: Spacing.xs, paddingVertical: Spacing.md,
    marginTop: Spacing.xs,
    borderWidth: 1, borderColor: Colors.primary + '40',
    borderRadius: BorderRadius.md, backgroundColor: Colors.primary + '08',
  },
  loadMoreText: { fontSize: FontSize.sm, color: Colors.primary, fontWeight: '600' },
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
