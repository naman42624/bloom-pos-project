import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  RefreshControl, Alert, TextInput, Image, Modal, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';
import ImageModal from '../components/ImageModal';


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

const QUICK_ADJUST_TYPES = [
  { key: 'correction', label: 'Correction', icon: 'build' },
  { key: 'wastage', label: 'Wastage', icon: 'trash' },
  { key: 'damage', label: 'Damage', icon: 'close-circle' },
  { key: 'count', label: 'Count', icon: 'calculator' },
];

export default function ProductsScreen({ navigation }) {
  const { user } = useAuth();
  const canManageStock = user?.role === 'owner' || user?.role === 'manager';
  const [products, setProducts] = useState([]);
  const [selectedType, setSelectedType] = useState(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [viewedImage, setViewedImage] = useState(null);
  const [locations, setLocations] = useState([]);

  const [adjustProduct, setAdjustProduct] = useState(null);
  const [adjustQty, setAdjustQty] = useState('');
  const [adjustReasonType, setAdjustReasonType] = useState('correction');
  const [adjustLocationId, setAdjustLocationId] = useState(null);
  const [adjustNotes, setAdjustNotes] = useState('');
  const [adjusting, setAdjusting] = useState(false);
  const [currentReadyStock, setCurrentReadyStock] = useState(null);

  useEffect(() => {
    if (!canManageStock) return;
    (async () => {
      try {
        const res = await api.getLocations();
        setLocations(res.data?.locations || res.data || []);
      } catch {
        setLocations([]);
      }
    })();
  }, [canManageStock]);

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

  const openQuickAdjust = (product) => {
    const defaultLocationId = product.location_id || locations[0]?.id || null;
    setAdjustProduct(product);
    setAdjustQty('');
    setAdjustReasonType('correction');
    setAdjustNotes('');
    setAdjustLocationId(defaultLocationId);
    setCurrentReadyStock(product.ready_qty ?? null);
  };

  useEffect(() => {
    if (!adjustProduct || !adjustLocationId) return;
    (async () => {
      try {
        const res = await api.getProductStock({ location_id: adjustLocationId });
        const stockRow = (res.data || []).find((row) => row.product_id === adjustProduct.id);
        setCurrentReadyStock(stockRow?.quantity ?? 0);
      } catch {
        setCurrentReadyStock(null);
      }
    })();
  }, [adjustProduct, adjustLocationId]);

  const applyQuickAdjust = async () => {
    const qty = parseFloat(adjustQty) || 0;
    if (!adjustProduct) return;
    if (!adjustLocationId) {
      Alert.alert('Location Required', 'Select a location for this stock adjustment.');
      return;
    }
    if (qty <= 0) {
      Alert.alert('Invalid Quantity', 'Enter a quantity greater than 0.');
      return;
    }

    const isDeduction = adjustReasonType === 'wastage' || adjustReasonType === 'damage';

    setAdjusting(true);
    try {
      await api.adjustProductStock({
        product_id: adjustProduct.id,
        location_id: adjustLocationId,
        adjustment: isDeduction ? -qty : qty,
        reason: adjustNotes.trim() || `${adjustReasonType}: ${qty} ${adjustProduct.name}`,
      });
      setAdjustProduct(null);
      fetchData();
    } catch (err) {
      Alert.alert('Adjustment Failed', err.message || 'Could not update product stock.');
    } finally {
      setAdjusting(false);
    }
  };

  const renderItem = ({ item }) => (
    <TouchableOpacity
      style={styles.card}
      onPress={() => navigation.navigate('ProductDetail', { productId: item.id })}
      activeOpacity={0.7}
    >
      <View style={styles.cardHeader}>
        <TouchableOpacity 
          style={[styles.iconBox, { backgroundColor: Colors.primary + '15' }]}
          onPress={(e) => { e.stopPropagation(); if (item.image_url) setViewedImage(api.getMediaUrl(item.image_url)); }}
        >
          {item.image_url ? (
            <Image source={{ uri: api.getMediaUrl(item.image_url) }} style={{ width: 40, height: 40, borderRadius: BorderRadius.md }} />
          ) : (
            <Ionicons name="gift" size={20} color={Colors.primary} />
          )}
        </TouchableOpacity>
        <View style={styles.cardInfo}>
          <Text style={styles.cardName}>{item.name}</Text>
          <Text style={styles.cardMeta}>
            {TYPE_LABELS[item.type] || item.type} · SKU: {item.sku}
          </Text>
        </View>
        {canManageStock && (
          <TouchableOpacity
            style={styles.quickAdjustBtn}
            onPress={(e) => {
              e.stopPropagation();
              openQuickAdjust(item);
            }}
          >
            <Ionicons name="swap-vertical" size={15} color={Colors.primary} />
            <Text style={styles.quickAdjustBtnText}>Adjust</Text>
          </TouchableOpacity>
        )}
        <Ionicons name="chevron-forward" size={20} color={Colors.textLight} />
      </View>
      <View style={styles.priceRow}>
        <View style={styles.priceItem}>
          <Text style={styles.priceLabel}>Cost</Text>
          <Text style={styles.priceValue}>₹{Number(item.estimated_cost || 0).toFixed(2)}</Text>
        </View>
        <View style={styles.priceItem}>
          <Text style={styles.priceLabel}>Price</Text>
          <Text style={[styles.priceValue, { color: Colors.success }]}>₹{Number(item.selling_price || 0).toFixed(2)}</Text>
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

      <ImageModal 
        visible={!!viewedImage} 
        imageUrl={viewedImage} 
        onClose={() => setViewedImage(null)} 
      />

      <Modal visible={!!adjustProduct} transparent animationType="slide" onRequestClose={() => setAdjustProduct(null)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Quick Adjust: {adjustProduct?.name}</Text>
              <TouchableOpacity onPress={() => setAdjustProduct(null)}>
                <Ionicons name="close" size={22} color={Colors.text} />
              </TouchableOpacity>
            </View>

            <Text style={styles.modalLabel}>Location</Text>
            <View style={styles.modalChipRow}>
              {locations.map((loc) => (
                <TouchableOpacity
                  key={loc.id}
                  style={[styles.modalChip, adjustLocationId === loc.id && styles.modalChipActive]}
                  onPress={() => setAdjustLocationId(loc.id)}
                >
                  <Text style={[styles.modalChipText, adjustLocationId === loc.id && styles.modalChipTextActive]}>
                    {loc.name}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.modalLabel}>Reason</Text>
            <Text style={styles.currentStockText}>
              Current ready stock: {currentReadyStock ?? '--'}
            </Text>
            <View style={styles.modalChipRow}>
              {QUICK_ADJUST_TYPES.map((t) => (
                <TouchableOpacity
                  key={t.key}
                  style={[styles.modalChip, adjustReasonType === t.key && styles.modalChipActive]}
                  onPress={() => setAdjustReasonType(t.key)}
                >
                  <Ionicons name={t.icon} size={13} color={adjustReasonType === t.key ? Colors.white : Colors.textSecondary} />
                  <Text style={[styles.modalChipText, adjustReasonType === t.key && styles.modalChipTextActive]}>{t.label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.modalLabel}>Quantity</Text>
            <TextInput
              style={styles.modalInput}
              value={adjustQty}
              onChangeText={setAdjustQty}
              placeholder="e.g. 5"
              placeholderTextColor={Colors.textLight}
              keyboardType="decimal-pad"
            />

            <TextInput
              style={[styles.modalInput, { marginTop: Spacing.sm }]}
              value={adjustNotes}
              onChangeText={setAdjustNotes}
              placeholder="Notes (optional)"
              placeholderTextColor={Colors.textLight}
            />

            <TouchableOpacity style={styles.modalSubmitBtn} onPress={applyQuickAdjust} disabled={adjusting}>
              {adjusting ? <ActivityIndicator color={Colors.white} /> : <Text style={styles.modalSubmitText}>Apply</Text>}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
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
  quickAdjustBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: Colors.primary + '55',
    borderRadius: BorderRadius.full,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 5,
    marginRight: Spacing.sm,
    backgroundColor: Colors.primary + '10',
  },
  quickAdjustBtnText: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.primary },
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

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  modalCard: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: BorderRadius.xl,
    borderTopRightRadius: BorderRadius.xl,
    padding: Spacing.lg,
    maxHeight: '80%',
  },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  modalTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  modalLabel: { fontSize: FontSize.sm, color: Colors.text, fontWeight: '600', marginTop: Spacing.md, marginBottom: Spacing.xs },
  currentStockText: { fontSize: FontSize.xs, color: Colors.textSecondary, marginBottom: Spacing.xs },
  modalChipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.xs },
  modalChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: BorderRadius.full,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs + 1,
    backgroundColor: Colors.background,
  },
  modalChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  modalChipText: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '600' },
  modalChipTextActive: { color: Colors.white },
  modalInput: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    fontSize: FontSize.md,
    color: Colors.text,
    backgroundColor: Colors.background,
  },
  modalSubmitBtn: {
    marginTop: Spacing.lg,
    backgroundColor: Colors.primary,
    borderRadius: BorderRadius.md,
    alignItems: 'center',
    paddingVertical: Spacing.md,
  },
  modalSubmitText: { fontSize: FontSize.md, color: Colors.white, fontWeight: '700' },
});
