import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TextInput,
  TouchableOpacity, Alert, ScrollView, Modal, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import api from '../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const ADJUST_TYPES = [
  { key: 'adjustment', label: 'Correction', icon: 'build' },
  { key: 'wastage', label: 'Wastage', icon: 'trash' },
  { key: 'return', label: 'Return', icon: 'arrow-undo' },
  { key: 'usage', label: 'Usage', icon: 'arrow-down' },
];

const PRODUCT_ADJUST_TYPES = [
  { key: 'correction', label: 'Correction', icon: 'build' },
  { key: 'wastage', label: 'Wastage', icon: 'trash' },
  { key: 'damage', label: 'Damage', icon: 'close-circle' },
  { key: 'count', label: 'Count', icon: 'calculator' },
];

export default function ProductStockScreen({ navigation }) {
  const [products, setProducts] = useState([]);
  const [locations, setLocations] = useState([]);
  const [selectedLocation, setSelectedLocation] = useState(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  // Adjust modal
  const [adjustProduct, setAdjustProduct] = useState(null);
  const [adjustBom, setAdjustBom] = useState([]);
  const [adjustMode, setAdjustMode] = useState('product'); // 'product' or 'material'
  const [adjustType, setAdjustType] = useState('adjustment');
  const [adjustQty, setAdjustQty] = useState('');
  const [adjustNotes, setAdjustNotes] = useState('');
  const [adjustMaterialId, setAdjustMaterialId] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useFocusEffect(
    useCallback(() => {
      fetchLocations();
    }, [])
  );

  useFocusEffect(
    useCallback(() => {
      if (selectedLocation) fetchProducts();
    }, [selectedLocation])
  );

  const fetchLocations = async () => {
    try {
      const res = await api.getLocations();
      const locs = res.data?.locations || res.data || [];
      setLocations(locs);
      if (locs.length > 0 && !selectedLocation) setSelectedLocation(locs[0].id);
    } catch {}
  };

  const fetchProducts = async (q) => {
    try {
      setLoading(true);
      const params = { is_active: 1 };
      if (selectedLocation) params.location_id = selectedLocation;
      if (q) params.search = q;
      const res = await api.getProducts(params);
      setProducts(res.data || []);
    } catch {} finally {
      setLoading(false);
    }
  };

  const handleSearch = (text) => {
    setSearch(text);
    fetchProducts(text);
  };

  const openAdjust = async (product) => {
    setAdjustProduct(product);
    setAdjustMode('product');
    setAdjustType('correction');
    setAdjustQty('');
    setAdjustNotes('');
    setAdjustMaterialId(null);
    try {
      const res = await api.getProduct(product.id);
      const bom = res.data?.materials || [];
      // Get stock for each BOM material at this location
      const bomWithStock = await Promise.all(bom.map(async (m) => {
        try {
          const stockRes = await api.getStock({ material_id: m.material_id || m.id, location_id: selectedLocation });
          const stockItem = (stockRes.data || [])[0];
          return { ...m, stock_qty: stockItem?.quantity ?? 0 };
        } catch {
          return { ...m, stock_qty: 0 };
        }
      }));
      setAdjustBom(bomWithStock);
      if (bomWithStock.length > 0) setAdjustMaterialId(bomWithStock[0].material_id || bomWithStock[0].id);
    } catch {
      setAdjustBom([]);
    }
  };

  const handleAdjust = async () => {
    const qty = parseFloat(adjustQty) || 0;
    if (qty <= 0) { Alert.alert('Invalid', 'Enter a valid quantity'); return; }

    if (adjustMode === 'product') {
      // Adjust product_stock directly (finished product inventory)
      setSubmitting(true);
      try {
        const isDeduction = adjustType === 'wastage' || adjustType === 'damage';
        await api.adjustProductStock({
          product_id: adjustProduct.id,
          location_id: selectedLocation,
          adjustment: isDeduction ? -qty : qty,
          reason: adjustNotes || `${adjustType}: ${qty} ${adjustProduct?.name}`,
        });
        Alert.alert('Done', `Product stock ${isDeduction ? 'decreased' : 'increased'} by ${qty}`);
        setAdjustProduct(null);
        fetchProducts(search);
      } catch (err) {
        Alert.alert('Error', err.message || 'Failed to adjust');
      } finally {
        setSubmitting(false);
      }
    } else {
      // Adjust individual material
      if (!adjustMaterialId) { Alert.alert('Select', 'Select a material to adjust'); return; }
      setSubmitting(true);
      try {
        await api.adjustStock({
          material_id: adjustMaterialId,
          location_id: selectedLocation,
          type: adjustType,
          quantity: qty,
          notes: adjustNotes || `Product stock adjust: ${adjustProduct?.name}`,
        });
        Alert.alert('Done', 'Stock adjusted');
        setAdjustProduct(null);
        fetchProducts(search);
      } catch (err) {
        Alert.alert('Error', err.message || 'Failed to adjust');
      } finally {
        setSubmitting(false);
      }
    }
  };

  const renderProduct = ({ item }) => {
    const ready = item.ready_qty ?? 0;
    const avail = item.available_qty;
    const hasStock = avail !== null && avail !== undefined;
    const outOfStock = ready <= 0 && hasStock && avail <= 0;
    const lowStock = ready > 0 && ready <= 3;

    return (
      <TouchableOpacity style={styles.card} onPress={() => openAdjust(item)} activeOpacity={0.7}>
        <View style={styles.cardLeft}>
          <Ionicons name="gift" size={24} color={Colors.primary} />
        </View>
        <View style={styles.cardCenter}>
          <Text style={styles.cardName} numberOfLines={1}>{item.name}</Text>
          <Text style={styles.cardSku}>{item.sku} • {item.category || 'other'}</Text>
          {hasStock && (
            <Text style={styles.canMakeLabel}>Can make: {avail}</Text>
          )}
        </View>
        <View style={styles.cardRight}>
          <View style={[
            styles.stockBadge,
            outOfStock && styles.stockBadgeOut,
            lowStock && styles.stockBadgeLow,
            !outOfStock && !lowStock && styles.stockBadgeOk,
          ]}>
            <Text style={[
              styles.stockBadgeText,
              outOfStock && { color: Colors.error },
              lowStock && { color: '#FF9800' },
              !outOfStock && !lowStock && { color: Colors.success },
            ]}>
              {ready}
            </Text>
            <Text style={styles.stockBadgeLabel}>ready</Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={Colors.textLight} />
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      {/* Location selector */}
      {locations.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.locRow} contentContainerStyle={{ paddingHorizontal: Spacing.md, gap: Spacing.xs }}>
          {locations.map((loc) => (
            <TouchableOpacity
              key={loc.id}
              style={[styles.locChip, selectedLocation === loc.id && styles.locChipActive]}
              onPress={() => setSelectedLocation(loc.id)}
            >
              <Text style={[styles.locChipText, selectedLocation === loc.id && styles.locChipTextActive]}>{loc.name}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {/* Search */}
      <View style={styles.searchRow}>
        <View style={styles.searchWrap}>
          <Ionicons name="search" size={18} color={Colors.textLight} style={{ marginRight: 6 }} />
          <TextInput
            style={styles.searchInput}
            value={search}
            onChangeText={handleSearch}
            placeholder="Search products..."
            placeholderTextColor={Colors.textLight}
          />
        </View>
      </View>

      <FlatList
        data={products}
        keyExtractor={(item) => String(item.id)}
        renderItem={renderProduct}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="cube-outline" size={48} color={Colors.textLight} />
            <Text style={styles.emptyText}>{loading ? 'Loading...' : 'No products found'}</Text>
          </View>
        }
      />

      {/* Adjust Modal */}
      <Modal visible={!!adjustProduct} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Adjust Stock — {adjustProduct?.name}</Text>
              <TouchableOpacity onPress={() => setAdjustProduct(null)}>
                <Ionicons name="close" size={24} color={Colors.text} />
              </TouchableOpacity>
            </View>

            {adjustBom.length === 0 && adjustMode !== 'product' ? (
              <Text style={styles.noBomText}>
                This product has no Bill of Materials. Add materials to the product to enable material-level stock tracking.
              </Text>
            ) : (
              <ScrollView style={{ maxHeight: 400 }}>
                {/* Mode toggle */}
                <View style={styles.chipRow}>
                  <TouchableOpacity
                    style={[styles.chip, adjustMode === 'product' && styles.chipActive]}
                    onPress={() => setAdjustMode('product')}
                  >
                    <Ionicons name="cube" size={14} color={adjustMode === 'product' ? Colors.white : Colors.textSecondary} />
                    <Text style={[styles.chipText, adjustMode === 'product' && styles.chipTextActive]}>Product Stock</Text>
                  </TouchableOpacity>
                  {adjustBom.length > 0 && (
                    <TouchableOpacity
                      style={[styles.chip, adjustMode === 'material' && styles.chipActive]}
                      onPress={() => setAdjustMode('material')}
                    >
                      <Ionicons name="leaf" size={14} color={adjustMode === 'material' ? Colors.white : Colors.textSecondary} />
                      <Text style={[styles.chipText, adjustMode === 'material' && styles.chipTextActive]}>Materials</Text>
                    </TouchableOpacity>
                  )}
                </View>

                {adjustMode === 'product' ? (
                  <>
                    <Text style={styles.fieldLabel}>
                      Ready stock: {adjustProduct?.ready_qty ?? 0} • Can make: {adjustProduct?.available_qty ?? 'N/A'}
                    </Text>

                    <Text style={styles.fieldLabel}>Reason</Text>
                    <View style={styles.chipRow}>
                      {PRODUCT_ADJUST_TYPES.map((t) => (
                        <TouchableOpacity
                          key={t.key}
                          style={[styles.chip, adjustType === t.key && styles.chipActive]}
                          onPress={() => setAdjustType(t.key)}
                        >
                          <Ionicons name={t.icon} size={14} color={adjustType === t.key ? Colors.white : Colors.textSecondary} />
                          <Text style={[styles.chipText, adjustType === t.key && styles.chipTextActive]}>{t.label}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>

                    <Text style={styles.fieldLabel}>
                      {adjustType === 'wastage' || adjustType === 'damage'
                        ? 'How many to remove from ready stock?'
                        : 'How many to add/set in ready stock?'}
                    </Text>
                    <TextInput
                      style={styles.input}
                      value={adjustQty}
                      onChangeText={setAdjustQty}
                      placeholder="e.g. 5"
                      placeholderTextColor={Colors.textLight}
                      keyboardType="numeric"
                    />
                    <Text style={[styles.bomStock, { marginTop: Spacing.xs }]}>
                      {adjustType === 'wastage' || adjustType === 'damage'
                        ? 'Ready product stock will be reduced'
                        : 'Ready product stock will be adjusted'}
                    </Text>
                    {adjustBom.map((m) => (
                      <View key={m.material_id || m.id} style={styles.bomRow}>
                        <Text style={styles.bomName}>{m.material_name || m.name}</Text>
                        <Text style={styles.bomStock}>
                          BOM: {m.quantity}/unit • Stock: {m.stock_qty}
                        </Text>
                      </View>
                    ))}
                  </>
                ) : (
                  <>
                    <Text style={styles.fieldLabel}>Select Material</Text>
                    {adjustBom.map((m) => (
                      <TouchableOpacity
                        key={m.material_id || m.id}
                        style={[styles.bomRow, adjustMaterialId === (m.material_id || m.id) && styles.bomRowActive]}
                        onPress={() => setAdjustMaterialId(m.material_id || m.id)}
                      >
                        <Text style={styles.bomName}>{m.material_name || m.name}</Text>
                        <Text style={styles.bomStock}>
                          BOM: {m.quantity} • Stock: {m.stock_qty}
                        </Text>
                      </TouchableOpacity>
                    ))}

                    <Text style={styles.fieldLabel}>Adjustment Type</Text>
                    <View style={styles.chipRow}>
                      {ADJUST_TYPES.map((t) => (
                        <TouchableOpacity
                          key={t.key}
                          style={[styles.chip, adjustType === t.key && styles.chipActive]}
                          onPress={() => setAdjustType(t.key)}
                        >
                          <Ionicons name={t.icon} size={14} color={adjustType === t.key ? Colors.white : Colors.textSecondary} />
                          <Text style={[styles.chipText, adjustType === t.key && styles.chipTextActive]}>{t.label}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>

                    <Text style={styles.fieldLabel}>Quantity</Text>
                    <TextInput
                      style={styles.input}
                      value={adjustQty}
                      onChangeText={setAdjustQty}
                      placeholder="Enter quantity"
                      placeholderTextColor={Colors.textLight}
                      keyboardType="numeric"
                    />
                  </>
                )}

                <Text style={styles.fieldLabel}>Notes (optional)</Text>
                <TextInput
                  style={[styles.input, { minHeight: 60 }]}
                  value={adjustNotes}
                  onChangeText={setAdjustNotes}
                  placeholder="Reason for adjustment"
                  placeholderTextColor={Colors.textLight}
                  multiline
                />

                <TouchableOpacity
                  style={[styles.adjustBtn, submitting && { opacity: 0.6 }]}
                  onPress={handleAdjust}
                  disabled={submitting}
                >
                  {submitting ? (
                    <ActivityIndicator color={Colors.white} />
                  ) : (
                    <Text style={styles.adjustBtnText}>Apply Adjustment</Text>
                  )}
                </TouchableOpacity>
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  locRow: { maxHeight: 44, backgroundColor: Colors.surface, borderBottomWidth: 1, borderBottomColor: Colors.border },
  locChip: {
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs + 2,
    borderRadius: BorderRadius.full, backgroundColor: Colors.background,
    borderWidth: 1, borderColor: Colors.border,
  },
  locChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  locChipText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  locChipTextActive: { color: Colors.white, fontWeight: '600' },

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

  list: { padding: Spacing.md, paddingBottom: 40 },

  card: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    padding: Spacing.md, marginBottom: Spacing.sm,
    borderWidth: 1, borderColor: Colors.border,
  },
  cardLeft: {
    width: 44, height: 44, borderRadius: BorderRadius.md,
    backgroundColor: Colors.primary + '12', justifyContent: 'center', alignItems: 'center',
    marginRight: Spacing.sm,
  },
  cardCenter: { flex: 1 },
  cardName: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  cardSku: { fontSize: FontSize.xs, color: Colors.textLight, marginTop: 2 },
  canMakeLabel: { fontSize: FontSize.xs - 1, color: Colors.textSecondary, marginTop: 1 },
  cardRight: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs },

  stockBadge: {
    paddingHorizontal: Spacing.sm, paddingVertical: 2,
    borderRadius: BorderRadius.sm, minWidth: 36, alignItems: 'center',
  },
  stockBadgeOk: { backgroundColor: Colors.success + '18' },
  stockBadgeLow: { backgroundColor: '#FFF3E0' },
  stockBadgeOut: { backgroundColor: Colors.error + '18' },
  stockBadgeText: { fontSize: FontSize.xs, fontWeight: '700' },
  stockBadgeLabel: { fontSize: 8, color: Colors.textSecondary, marginTop: -1 },
  noStockText: { fontSize: FontSize.xs, color: Colors.textLight },

  empty: { alignItems: 'center', paddingTop: 80 },
  emptyText: { color: Colors.textLight, marginTop: Spacing.sm, fontSize: FontSize.sm },

  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: Colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: Spacing.lg, maxHeight: '80%',
  },
  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: Spacing.md,
  },
  modalTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, flex: 1 },

  noBomText: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', paddingVertical: Spacing.lg },

  fieldLabel: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.text, marginTop: Spacing.md, marginBottom: Spacing.xs },

  bomRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    padding: Spacing.sm, borderRadius: BorderRadius.sm,
    borderWidth: 1, borderColor: Colors.border,
    marginBottom: Spacing.xs, backgroundColor: Colors.background,
  },
  bomRowActive: { borderColor: Colors.primary, backgroundColor: Colors.primary + '08' },
  bomName: { fontSize: FontSize.sm, fontWeight: '500', color: Colors.text },
  bomStock: { fontSize: FontSize.xs, color: Colors.textSecondary },

  chipRow: { flexDirection: 'row', gap: Spacing.xs, flexWrap: 'wrap' },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs + 2,
    borderRadius: BorderRadius.full, backgroundColor: Colors.background,
    borderWidth: 1, borderColor: Colors.border,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  chipTextActive: { color: Colors.white, fontWeight: '600' },

  input: {
    backgroundColor: Colors.background, borderWidth: 1, borderColor: Colors.border,
    borderRadius: BorderRadius.md, paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.xs + 2, fontSize: FontSize.sm, color: Colors.text,
  },

  adjustBtn: {
    backgroundColor: Colors.primary, paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.md, alignItems: 'center', marginTop: Spacing.lg,
    marginBottom: Spacing.md,
  },
  adjustBtnText: { color: Colors.white, fontWeight: '600', fontSize: FontSize.sm },
});
