import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TextInput,
  TouchableOpacity, Alert, ScrollView, ActivityIndicator, Modal,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

export default function ProduceScreen({ navigation }) {
  const { user } = useAuth();
  const [products, setProducts] = useState([]);
  const [locations, setLocations] = useState([]);
  const [selectedLocation, setSelectedLocation] = useState(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  // Production form
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [quantity, setQuantity] = useState('1');
  const [producing, setProducing] = useState(false);
  const [notes, setNotes] = useState('');

  // Recent production logs
  const [recentLogs, setRecentLogs] = useState([]);

  // Custom make modal
  const [showCustom, setShowCustom] = useState(false);
  const [customName, setCustomName] = useState('');
  const [customPrice, setCustomPrice] = useState('');
  const [customCategory, setCustomCategory] = useState('bouquet');
  const [customQty, setCustomQty] = useState('1');
  const [customNotes, setCustomNotes] = useState('');
  const [customMaterials, setCustomMaterials] = useState([]);
  const [allMaterialsList, setAllMaterialsList] = useState([]);
  const [customSubmitting, setCustomSubmitting] = useState(false);

  useFocusEffect(
    useCallback(() => {
      fetchLocations();
      fetchRecentLogs();
    }, [])
  );

  useEffect(() => {
    if (selectedLocation) {
      fetchProducts();
    }
  }, [selectedLocation]);

  const fetchLocations = async () => {
    try {
      const res = await api.getLocations();
      const locs = res.data?.locations || res.data || [];
      setLocations(locs);
      if (locs.length > 0 && !selectedLocation) setSelectedLocation(locs[0].id);
    } catch {}
  };

  const fetchProducts = async () => {
    setLoading(true);
    try {
      const params = { is_active: 1, location_id: selectedLocation };
      if (search) params.search = search;
      const res = await api.getProducts(params);
      setProducts(res.data || []);
    } catch {} finally { setLoading(false); }
  };

  const fetchRecentLogs = async () => {
    try {
      const res = await api.getProductionLogs({ user_id: user.id, limit: 10 });
      setRecentLogs(res.data || []);
    } catch {}
  };

  const handleProduce = async () => {
    if (!selectedProduct) return;
    const qty = parseInt(quantity) || 0;
    if (qty <= 0) { Alert.alert('Invalid', 'Enter a valid quantity'); return; }

    setProducing(true);
    try {
      const res = await api.produceProduct({
        product_id: selectedProduct.id,
        location_id: selectedLocation,
        quantity: qty,
        notes,
      });

      if (res.success) {
        Alert.alert(
          'Produced!',
          `${qty}x ${selectedProduct.name} added to display stock.\nReady qty: ${res.data.ready_qty}`
        );
        setSelectedProduct(null);
        setQuantity('1');
        setNotes('');
        fetchProducts();
        fetchRecentLogs();
      }
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to produce');
    } finally {
      setProducing(false);
    }
  };

  const selectProduct = (product) => {
    setSelectedProduct(product);
    setQuantity('1');
    setNotes('');
  };

  const openCustomMake = async () => {
    setShowCustom(true);
    setCustomName('');
    setCustomPrice('');
    setCustomCategory('bouquet');
    setCustomQty('1');
    setCustomNotes('');
    setCustomMaterials([]);
    try {
      const res = await api.getMaterials({ location_id: selectedLocation });
      setAllMaterialsList(res.data || []);
    } catch {}
  };

  const addCustomMaterial = () => {
    setCustomMaterials([...customMaterials, { material_id: null, name: '', quantity: '1' }]);
  };

  const updateCustomMaterial = (idx, field, value) => {
    setCustomMaterials(customMaterials.map((m, i) => i === idx ? { ...m, [field]: value } : m));
  };

  const selectCustomMaterial = (idx, material) => {
    setCustomMaterials(customMaterials.map((m, i) => i === idx ? { ...m, material_id: material.id, name: material.name } : m));
  };

  const removeCustomMaterial = (idx) => {
    setCustomMaterials(customMaterials.filter((_, i) => i !== idx));
  };

  const handleCustomProduce = async () => {
    if (!customName.trim()) { Alert.alert('Required', 'Enter product name'); return; }
    const price = parseFloat(customPrice) || 0;
    if (price <= 0) { Alert.alert('Required', 'Enter a valid selling price'); return; }
    const qty = parseInt(customQty) || 0;
    if (qty <= 0) { Alert.alert('Required', 'Enter quantity'); return; }

    setCustomSubmitting(true);
    try {
      const materials = customMaterials
        .filter(m => m.material_id && (parseFloat(m.quantity) || 0) > 0)
        .map(m => ({ material_id: m.material_id, quantity: parseFloat(m.quantity) }));

      const res = await api.customProduceProduct({
        name: customName.trim(),
        location_id: selectedLocation,
        quantity: qty,
        selling_price: price,
        category: customCategory,
        materials,
        notes: customNotes || undefined,
      });

      if (res.success) {
        Alert.alert('Created!', `${qty}x ${customName.trim()} produced and added to display stock.`);
        setShowCustom(false);
        fetchProducts();
        fetchRecentLogs();
      }
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to create custom product');
    } finally {
      setCustomSubmitting(false);
    }
  };

  const maxProducible = selectedProduct?.available_qty ?? 0;

  const renderProduct = ({ item }) => {
    const readyQty = item.ready_qty || 0;
    const canMake = item.available_qty;
    const isSelected = selectedProduct?.id === item.id;

    return (
      <TouchableOpacity
        style={[styles.productCard, isSelected && styles.productCardSelected]}
        onPress={() => selectProduct(item)}
        activeOpacity={0.7}
      >
        <View style={[styles.productIcon, isSelected && { backgroundColor: Colors.primary + '25' }]}>
          <Ionicons name="gift" size={26} color={isSelected ? Colors.primary : Colors.textLight} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.productName} numberOfLines={1}>{item.name}</Text>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
            {readyQty > 0 && (
              <View style={styles.readyBadge}>
                <Text style={styles.readyBadgeText}>{readyQty} ready</Text>
              </View>
            )}
            {canMake !== null && canMake !== undefined && (
              <Text style={styles.canMakeText}>Can make: {canMake}</Text>
            )}
          </View>
        </View>
        {isSelected && (
          <View style={styles.selectedIndicator}>
            <Ionicons name="checkmark-circle" size={24} color={Colors.primary} />
          </View>
        )}
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
        <Ionicons name="search" size={18} color={Colors.textLight} />
        <TextInput
          style={styles.searchInput}
          value={search}
          onChangeText={(t) => { setSearch(t); }}
          onSubmitEditing={() => fetchProducts()}
          placeholder="Search products to produce..."
          placeholderTextColor={Colors.textLight}
          returnKeyType="search"
        />
        <TouchableOpacity style={styles.customMakeBtn} onPress={openCustomMake}>
          <Ionicons name="add-circle" size={16} color={Colors.white} />
          <Text style={styles.customMakeBtnText}>Custom</Text>
        </TouchableOpacity>
      </View>

      {/* Product list (top half) */}
      <FlatList
        data={products}
        keyExtractor={(item) => String(item.id)}
        renderItem={renderProduct}
        contentContainerStyle={{ padding: Spacing.md, paddingBottom: selectedProduct ? 4 : Spacing.xl }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="hammer-outline" size={48} color={Colors.textLight} />
            <Text style={styles.emptyText}>{loading ? 'Loading...' : 'No products with recipes'}</Text>
          </View>
        }
        style={{ flex: selectedProduct ? 0.55 : 1 }}
      />

      {/* Production panel (bottom) */}
      {selectedProduct && (
        <View style={styles.producePanel}>
          <View style={styles.producePanelHeader}>
            <View style={{ flex: 1 }}>
              <Text style={styles.producePanelTitle}>{selectedProduct.name}</Text>
              <Text style={styles.producePanelSub}>
                Ready: {selectedProduct.ready_qty || 0}  |  Can make: {maxProducible}
              </Text>
            </View>
            <TouchableOpacity onPress={() => setSelectedProduct(null)} style={{ padding: 4 }}>
              <Ionicons name="close-circle" size={28} color={Colors.textLight} />
            </TouchableOpacity>
          </View>

          <View style={styles.produceForm}>
            <View style={styles.qtyRow}>
              <Text style={styles.fieldLabel}>How many to make?</Text>
              <View style={styles.qtyControls}>
                <TouchableOpacity
                  style={styles.qtyBtn}
                  onPress={() => setQuantity(String(Math.max(1, (parseInt(quantity) || 1) - 1)))}
                >
                  <Ionicons name="remove" size={22} color={Colors.primary} />
                </TouchableOpacity>
                <TextInput
                  style={styles.qtyInput}
                  value={quantity}
                  onChangeText={setQuantity}
                  keyboardType="numeric"
                  selectTextOnFocus
                />
                <TouchableOpacity
                  style={styles.qtyBtn}
                  onPress={() => setQuantity(String((parseInt(quantity) || 0) + 1))}
                >
                  <Ionicons name="add" size={22} color={Colors.primary} />
                </TouchableOpacity>
              </View>
            </View>

            {(parseInt(quantity) || 0) > maxProducible && maxProducible > 0 && (
              <Text style={styles.warningText}>
                Not enough materials! Max: {maxProducible}
              </Text>
            )}

            <TouchableOpacity
              style={[styles.produceBtn, producing && { opacity: 0.6 }]}
              onPress={handleProduce}
              disabled={producing}
            >
              {producing ? (
                <ActivityIndicator color={Colors.white} />
              ) : (
                <>
                  <Ionicons name="hammer" size={22} color={Colors.white} />
                  <Text style={styles.produceBtnText}>Make {quantity}x {selectedProduct.name}</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Recent production (shown when no product selected) */}
      {!selectedProduct && recentLogs.length > 0 && (
        <View style={styles.recentPanel}>
          <Text style={styles.recentTitle}>Your Recent Production</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: Spacing.sm }}>
            {recentLogs.slice(0, 6).map((log) => (
              <View key={log.id} style={styles.recentCard}>
                <Text style={styles.recentProduct} numberOfLines={1}>{log.product_name}</Text>
                <Text style={styles.recentQty}>{log.quantity}x</Text>
                <Text style={styles.recentTime}>{new Date(log.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text>
              </View>
            ))}
          </ScrollView>
        </View>
      )}

      {/* Custom Make Modal */}
      <Modal visible={showCustom} transparent animationType="slide">
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.modalOverlay}>
            <View style={styles.modalCard}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Custom Make</Text>
                <TouchableOpacity onPress={() => setShowCustom(false)}>
                  <Ionicons name="close" size={24} color={Colors.text} />
                </TouchableOpacity>
              </View>
              <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
                <Text style={styles.fieldLabel}>Product Name *</Text>
                <TextInput
                  style={styles.modalInput}
                  value={customName}
                  onChangeText={setCustomName}
                  placeholder="e.g. Custom Rose Bouquet"
                  placeholderTextColor={Colors.textLight}
                  autoFocus
                />

                <View style={{ flexDirection: 'row', gap: Spacing.sm }}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.fieldLabel}>Selling Price (₹) *</Text>
                    <TextInput
                      style={styles.modalInput}
                      value={customPrice}
                      onChangeText={setCustomPrice}
                      placeholder="0"
                      placeholderTextColor={Colors.textLight}
                      keyboardType="numeric"
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.fieldLabel}>Quantity *</Text>
                    <TextInput
                      style={styles.modalInput}
                      value={customQty}
                      onChangeText={setCustomQty}
                      placeholder="1"
                      placeholderTextColor={Colors.textLight}
                      keyboardType="numeric"
                    />
                  </View>
                </View>

                <Text style={styles.fieldLabel}>Category</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: Spacing.xs, paddingBottom: Spacing.sm }}>
                  {['bouquet', 'arrangement', 'basket', 'single_stem', 'gift_combo', 'other'].map((cat) => (
                    <TouchableOpacity
                      key={cat}
                      style={[styles.catChip, customCategory === cat && styles.catChipActive]}
                      onPress={() => setCustomCategory(cat)}
                    >
                      <Text style={[styles.catChipText, customCategory === cat && styles.catChipTextActive]}>
                        {cat.replace(/_/g, ' ')}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>

                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: Spacing.xs }}>
                  <Text style={styles.fieldLabel}>Materials Used (optional)</Text>
                  <TouchableOpacity onPress={addCustomMaterial} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <Ionicons name="add-circle" size={18} color={Colors.primary} />
                    <Text style={{ fontSize: FontSize.xs, color: Colors.primary, fontWeight: '600' }}>Add</Text>
                  </TouchableOpacity>
                </View>
                {customMaterials.map((m, idx) => (
                  <View key={idx} style={{ flexDirection: 'row', gap: Spacing.xs, alignItems: 'center', marginBottom: Spacing.xs }}>
                    <View style={{ flex: 2 }}>
                      <TouchableOpacity
                        style={[styles.modalInput, { justifyContent: 'center', paddingVertical: Spacing.xs + 4 }]}
                        onPress={() => {
                          const filtered = allMaterialsList.filter(
                            (mat) => !customMaterials.some((qm, qi) => qi !== idx && qm.material_id === mat.id)
                          );
                          if (filtered.length === 0) { Alert.alert('No materials', 'No materials available'); return; }
                          Alert.alert('Select Material', '', filtered.map((mat) => ({
                            text: `${mat.name}${mat.stock_quantity != null ? ` (${mat.stock_quantity})` : ''}`,
                            onPress: () => selectCustomMaterial(idx, mat),
                          })).concat([{ text: 'Cancel', style: 'cancel' }]));
                        }}
                      >
                        <Text style={{ color: m.material_id ? Colors.text : Colors.textLight, fontSize: FontSize.sm }}>
                          {m.name || 'Select material...'}
                        </Text>
                      </TouchableOpacity>
                    </View>
                    <TextInput
                      style={[styles.modalInput, { flex: 1 }]}
                      value={m.quantity}
                      onChangeText={(v) => updateCustomMaterial(idx, 'quantity', v)}
                      placeholder="Qty"
                      placeholderTextColor={Colors.textLight}
                      keyboardType="numeric"
                    />
                    <TouchableOpacity onPress={() => removeCustomMaterial(idx)}>
                      <Ionicons name="close-circle" size={22} color={Colors.error} />
                    </TouchableOpacity>
                  </View>
                ))}

                <TextInput
                  style={[styles.modalInput, { marginTop: Spacing.sm }]}
                  value={customNotes}
                  onChangeText={setCustomNotes}
                  placeholder="Notes (optional)"
                  placeholderTextColor={Colors.textLight}
                />

                <TouchableOpacity
                  style={[styles.customSubmitBtn, customSubmitting && { opacity: 0.6 }]}
                  onPress={handleCustomProduce}
                  disabled={customSubmitting}
                >
                  {customSubmitting ? (
                    <ActivityIndicator color={Colors.white} />
                  ) : (
                    <>
                      <Ionicons name="hammer" size={18} color={Colors.white} />
                      <Text style={styles.customSubmitText}>Create & Produce</Text>
                    </>
                  )}
                </TouchableOpacity>
              </ScrollView>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  locRow: { maxHeight: 48, backgroundColor: Colors.surface, borderBottomWidth: 1, borderBottomColor: Colors.border },
  locChip: {
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.full, backgroundColor: Colors.background,
    borderWidth: 1, borderColor: Colors.border,
  },
  locChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  locChipText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '500' },
  locChipTextActive: { color: Colors.white, fontWeight: '700' },

  searchRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: Colors.surface, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  searchInput: { flex: 1, fontSize: FontSize.md, color: Colors.text },
  customMakeBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: Colors.success, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.full,
  },
  customMakeBtnText: { fontSize: FontSize.sm, color: Colors.white, fontWeight: '700' },

  productCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md, padding: Spacing.md,
    marginBottom: Spacing.sm, borderWidth: 1, borderColor: Colors.border,
    minHeight: 64,
  },
  productCardSelected: { borderColor: Colors.primary, borderWidth: 2, backgroundColor: Colors.primary + '08' },
  productIcon: {
    width: 48, height: 48, borderRadius: BorderRadius.md, backgroundColor: Colors.background,
    justifyContent: 'center', alignItems: 'center', marginRight: Spacing.md,
  },
  productName: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  selectedIndicator: { marginLeft: Spacing.sm },
  readyBadge: {
    backgroundColor: Colors.success + '20', paddingHorizontal: 8, paddingVertical: 2, borderRadius: BorderRadius.sm,
  },
  readyBadgeText: { fontSize: 11, fontWeight: '700', color: Colors.success },
  canMakeText: { fontSize: 11, color: Colors.textLight },

  empty: { alignItems: 'center', paddingTop: 60 },
  emptyText: { color: Colors.textLight, marginTop: Spacing.sm, fontSize: FontSize.md },

  producePanel: {
    backgroundColor: Colors.surface, borderTopWidth: 2, borderTopColor: Colors.success,
    paddingHorizontal: Spacing.md, paddingTop: Spacing.md, paddingBottom: Spacing.md,
  },
  producePanelHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start',
    marginBottom: Spacing.md,
  },
  producePanelTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  producePanelSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 4 },

  produceForm: {},
  fieldLabel: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text, marginBottom: 4 },
  qtyRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.md },
  qtyControls: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  qtyBtn: {
    width: 44, height: 44, borderRadius: BorderRadius.md,
    backgroundColor: Colors.background, borderWidth: 1.5, borderColor: Colors.border,
    justifyContent: 'center', alignItems: 'center',
  },
  qtyInput: {
    width: 64, height: 44, textAlign: 'center', fontSize: FontSize.xl, fontWeight: '700',
    color: Colors.text, borderWidth: 1, borderColor: Colors.border, borderRadius: BorderRadius.md,
    backgroundColor: Colors.background,
  },
  warningText: { fontSize: FontSize.sm, color: Colors.error, marginBottom: Spacing.sm, fontWeight: '600' },
  produceBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: Colors.success, paddingVertical: Spacing.md, borderRadius: BorderRadius.md,
  },
  produceBtnText: { color: Colors.white, fontWeight: '700', fontSize: FontSize.md },

  recentPanel: {
    backgroundColor: Colors.surface, borderTopWidth: 1, borderTopColor: Colors.border,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
  },
  recentTitle: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.text, marginBottom: Spacing.xs },
  recentCard: {
    backgroundColor: Colors.background, borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderWidth: 1, borderColor: Colors.border, minWidth: 100,
    alignItems: 'center',
  },
  recentProduct: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  recentQty: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.success, marginTop: 2 },
  recentTime: { fontSize: 10, color: Colors.textLight, marginTop: 2 },

  // Custom make modal
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  modalCard: {
    backgroundColor: Colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: Spacing.lg, maxHeight: '85%',
  },
  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: Spacing.md,
  },
  modalTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  modalInput: {
    backgroundColor: Colors.background, borderWidth: 1, borderColor: Colors.border,
    borderRadius: BorderRadius.md, paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.sm, fontSize: FontSize.md, color: Colors.text,
  },
  catChip: {
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.full, backgroundColor: Colors.background,
    borderWidth: 1, borderColor: Colors.border,
  },
  catChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  catChipText: { fontSize: FontSize.sm, color: Colors.textSecondary, textTransform: 'capitalize' },
  catChipTextActive: { color: Colors.white, fontWeight: '700' },
  customSubmitBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: Colors.success, paddingVertical: Spacing.md,
    borderRadius: BorderRadius.md, marginTop: Spacing.md, marginBottom: Spacing.sm,
  },
  customSubmitText: { color: Colors.white, fontWeight: '700', fontSize: FontSize.md },
});
