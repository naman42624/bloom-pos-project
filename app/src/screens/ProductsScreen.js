import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  RefreshControl, Alert, TextInput,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const TYPE_LABELS = {
  standard: 'Standard',
  custom: 'Custom',
  made_to_order: 'Made to Order',
};

const TYPE_FILTERS = [
  { key: null, label: 'All' },
  { key: 'standard', label: 'Standard' },
  { key: 'custom', label: 'Custom' },
  { key: 'made_to_order', label: 'Made to Order' },
];

export default function ProductsScreen({ navigation }) {
  const { user } = useAuth();
  const [products, setProducts] = useState([]);
  const [selectedType, setSelectedType] = useState(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const params = {};
      if (selectedType) params.type = selectedType;
      if (search.trim()) params.search = search.trim();

      const res = await api.getProducts(params);
      setProducts(res.data || []);
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to load products');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [selectedType, search]);

  useFocusEffect(useCallback(() => { fetchData(); }, [fetchData]));

  const renderItem = ({ item }) => (
    <TouchableOpacity
      style={styles.card}
      onPress={() => navigation.navigate('ProductDetail', { productId: item.id })}
      activeOpacity={0.7}
    >
      <View style={styles.cardHeader}>
        <View style={[styles.iconBox, { backgroundColor: Colors.primary + '15' }]}>
          <Ionicons name="gift" size={20} color={Colors.primary} />
        </View>
        <View style={styles.cardInfo}>
          <Text style={styles.cardName}>{item.name}</Text>
          <Text style={styles.cardMeta}>
            {TYPE_LABELS[item.type] || item.type} · SKU: {item.sku}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={20} color={Colors.textLight} />
      </View>
      <View style={styles.priceRow}>
        <View style={styles.priceItem}>
          <Text style={styles.priceLabel}>Cost</Text>
          <Text style={styles.priceValue}>₹{(item.estimated_cost || 0).toFixed(2)}</Text>
        </View>
        <View style={styles.priceItem}>
          <Text style={styles.priceLabel}>Price</Text>
          <Text style={[styles.priceValue, { color: Colors.success }]}>₹{(item.selling_price || 0).toFixed(2)}</Text>
        </View>
        {item.tax_percentage > 0 && (
          <View style={styles.priceItem}>
            <Text style={styles.priceLabel}>Tax</Text>
            <Text style={styles.priceValue}>{item.tax_percentage}%</Text>
          </View>
        )}
      </View>
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      {/* Search bar */}
      <View style={styles.searchContainer}>
        <Ionicons name="search" size={18} color={Colors.textLight} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search products..."
          placeholderTextColor={Colors.textLight}
          value={search}
          onChangeText={setSearch}
          onSubmitEditing={fetchData}
          returnKeyType="search"
        />
        {search ? (
          <TouchableOpacity onPress={() => setSearch('')}>
            <Ionicons name="close-circle" size={18} color={Colors.textLight} />
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Type filter chips */}
      <FlatList
        horizontal
        showsHorizontalScrollIndicator={false}
        data={TYPE_FILTERS}
        keyExtractor={(item) => String(item.key ?? 'all')}
        contentContainerStyle={styles.chipList}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={[styles.chip, selectedType === item.key && styles.chipActive]}
            onPress={() => setSelectedType(item.key)}
          >
            <Text style={[styles.chipText, selectedType === item.key && styles.chipTextActive]}>
              {item.label}
            </Text>
          </TouchableOpacity>
        )}
      />

      <FlatList
        data={products}
        keyExtractor={(item) => String(item.id)}
        renderItem={renderItem}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchData(); }} colors={[Colors.primary]} />
        }
        ListEmptyComponent={
          !loading && (
            <View style={styles.empty}>
              <Ionicons name="gift-outline" size={48} color={Colors.textLight} />
              <Text style={styles.emptyTitle}>No products found</Text>
              <Text style={styles.emptyText}>Create your first product</Text>
            </View>
          )
        }
      />

      {(user?.role === 'owner' || user?.role === 'manager' || user?.role === 'employee') && (
        <TouchableOpacity
          style={styles.fab}
          onPress={() => navigation.navigate('ProductForm')}
          activeOpacity={0.8}
        >
          <Ionicons name="add" size={28} color={Colors.white} />
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  searchContainer: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.surface,
    marginHorizontal: Spacing.md, marginTop: Spacing.md, paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm, borderRadius: BorderRadius.md, gap: Spacing.sm,
    borderWidth: 1, borderColor: Colors.border,
  },
  searchInput: { flex: 1, fontSize: FontSize.md, color: Colors.text },
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
  priceRow: { flexDirection: 'row', marginTop: Spacing.sm, gap: Spacing.lg },
  priceItem: {},
  priceLabel: { fontSize: FontSize.xs, color: Colors.textLight },
  priceValue: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  empty: { alignItems: 'center', paddingTop: 80 },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: '600', color: Colors.textSecondary, marginTop: Spacing.md },
  emptyText: { fontSize: FontSize.sm, color: Colors.textLight, marginTop: Spacing.xs },
  fab: {
    position: 'absolute', bottom: 20, right: 20, width: 56, height: 56, borderRadius: 28,
    backgroundColor: Colors.primary, justifyContent: 'center', alignItems: 'center',
    shadowColor: Colors.primary, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: 6,
  },
});
