import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TextInput, Image,
  TouchableOpacity, Alert, Platform, Modal, ActivityIndicator,
  KeyboardAvoidingView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { useFocusEffect } from '@react-navigation/native';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const ORDER_TYPES = [
  { key: 'walk_in', label: 'Walk-in', icon: 'person', color: '#4CAF50' },
  { key: 'pickup', label: 'Pickup', icon: 'bag-handle', color: '#2196F3' },
  { key: 'delivery', label: 'Delivery', icon: 'bicycle', color: '#FF9800' },
];

export default function QuickCheckoutScreen({ navigation }) {
  const { user } = useAuth();

  // Customer
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerAddress, setCustomerAddress] = useState('');

  // Items
  const [items, setItems] = useState([]);

  // Order type
  const [orderType, setOrderType] = useState('walk_in');

  // Location
  const [locations, setLocations] = useState([]);
  const [selectedLocation, setSelectedLocation] = useState(null);

  // Materials list (for building custom products)
  const [allMaterials, setAllMaterials] = useState([]);

  // Submitting
  const [submitting, setSubmitting] = useState(false);

  // Product search modal
  const [showProductPicker, setShowProductPicker] = useState(false);
  const [products, setProducts] = useState([]);
  const [productSearch, setProductSearch] = useState('');
  const [editingItemIdx, setEditingItemIdx] = useState(null); // which item to add base product to

  useFocusEffect(
    useCallback(() => {
      fetchLocations();
      fetchMaterials();
    }, [])
  );

  const fetchLocations = async () => {
    try {
      const res = await api.getLocations();
      const locs = res.data?.locations || res.data || [];
      setLocations(locs);
      if (locs.length > 0 && !selectedLocation) setSelectedLocation(locs[0].id);
    } catch {}
  };

  const fetchMaterials = async () => {
    try {
      const res = await api.getMaterials({});
      setAllMaterials(res.data || []);
    } catch {}
  };

  const fetchProducts = async (q) => {
    try {
      const params = { search: q || '', is_active: 1 };
      if (selectedLocation) params.location_id = selectedLocation;
      const res = await api.getProducts(params);
      setProducts(res.data || []);
    } catch {}
  };

  // Add a blank custom item
  const addItem = () => {
    setItems([...items, {
      name: '',
      baseProduct: null, // optional: link to existing product
      materials: [],
      price: '',
      quantity: '1',
      special_instructions: '',
      image_url: '',
    }]);
  };

  // Add from existing product
  const addFromProduct = async (product, idx) => {
    try {
      const bomRes = await api.getProductMaterials(product.id);
      const bom = (bomRes.data || []).map(m => ({
        material_id: m.material_id,
        name: m.material_name || m.name,
        qty: String(m.quantity || 1),
      }));
      const updated = [...items];
      updated[idx] = {
        ...updated[idx],
        name: product.name,
        baseProduct: product,
        materials: bom,
        price: String(product.selling_price || 0),
      };
      setItems(updated);
    } catch {
      const updated = [...items];
      updated[idx] = {
        ...updated[idx],
        name: product.name,
        baseProduct: product,
        price: String(product.selling_price || 0),
      };
      setItems(updated);
    }
    setShowProductPicker(false);
  };

  const updateItem = (idx, field, value) => {
    setItems(items.map((it, i) => i === idx ? { ...it, [field]: value } : it));
  };

  const removeItem = (idx) => {
    setItems(items.filter((_, i) => i !== idx));
  };

  // Material management for an item
  const addMaterialToItem = (itemIdx) => {
    const updated = [...items];
    updated[itemIdx].materials = [...updated[itemIdx].materials, { material_id: null, name: '', qty: '1' }];
    setItems(updated);
  };

  const updateItemMaterial = (itemIdx, matIdx, field, value) => {
    const updated = [...items];
    updated[itemIdx].materials = updated[itemIdx].materials.map((m, mi) =>
      mi === matIdx ? { ...m, [field]: value } : m
    );
    setItems(updated);
  };

  const selectMaterialForItem = (itemIdx, matIdx, material) => {
    const updated = [...items];
    updated[itemIdx].materials = updated[itemIdx].materials.map((m, mi) =>
      mi === matIdx ? { ...m, material_id: material.id, name: material.name } : m
    );
    setItems(updated);
  };

  const removeMaterialFromItem = (itemIdx, matIdx) => {
    const updated = [...items];
    updated[itemIdx].materials = updated[itemIdx].materials.filter((_, mi) => mi !== matIdx);
    setItems(updated);
  };

  // Calculate totals
  const getItemTotal = (item) => {
    const price = parseFloat(item.price) || 0;
    const qty = parseInt(item.quantity) || 1;
    return price * qty;
  };

  const grandTotal = items.reduce((sum, it) => sum + getItemTotal(it), 0);

  // Place order
  const handlePlaceOrder = async () => {
    if (items.length === 0) {
      Alert.alert('Required', 'Please add at least one item');
      return;
    }
    for (const item of items) {
      if (!item.name.trim()) {
        Alert.alert('Required', 'All items must have a name');
        return;
      }
      if ((parseFloat(item.price) || 0) <= 0) {
        Alert.alert('Required', 'All items must have a price');
        return;
      }
    }
    if (orderType === 'delivery' && !customerAddress.trim()) {
      Alert.alert('Required', 'Delivery address is required');
      return;
    }

    setSubmitting(true);
    try {
      const processedItems = await Promise.all(items.map(async (item) => {
        let finalImageUrl = item.image_url;
        if (finalImageUrl && !finalImageUrl.startsWith('http') && !finalImageUrl.startsWith('/')) {
           try {
             const res = await api.uploadGenericMedia(finalImageUrl);
             if (res.success && res.url) {
               finalImageUrl = res.url;
             }
           } catch (err) { console.log('Image upload failed', err); }
        }
        return { ...item, image_url: finalImageUrl };
      }));

      // Build cart items
      const cart = processedItems.map(item => ({
        product_id: item.baseProduct?.id || null,
        material_id: null,
        product_name: item.name,
        product_sku: item.baseProduct?.sku || '',
        quantity: parseInt(item.quantity) || 1,
        unit_price: parseFloat(item.price) || 0,
        tax_rate: item.baseProduct?.tax_percentage || 0,
        tax_amount: 0,
        line_total: getItemTotal(item),
        materials: item.materials,
        special_instructions: item.special_instructions || '',
        image_url: item.image_url || '',
      }));

      // Navigate to Checkout with pre-built cart and customer info
      navigation.navigate('Checkout', {
        cart,
        locationId: selectedLocation,
        orderType,
        customerName: customerName.trim(),
        customerPhone: customerPhone.trim(),
        customerAddress: customerAddress.trim(),
      });
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to place order');
    } finally {
      setSubmitting(false);
    }
  };

  const pickImage = async (idx) => {
    let result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      quality: 0.8,
    });
    if (!result.canceled && result.assets && result.assets.length > 0) {
      updateItem(idx, 'image_url', result.assets[0].uri);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">

        {/* ── Section 1: Customer ── */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <View style={styles.sectionIcon}>
              <Ionicons name="person" size={20} color={Colors.primary} />
            </View>
            <Text style={styles.sectionTitle}>Customer Details</Text>
          </View>
          <View style={styles.fieldRow}>
            <View style={styles.fieldHalf}>
              <Text style={styles.label}>Name *</Text>
              <TextInput
                style={styles.input}
                value={customerName}
                onChangeText={setCustomerName}
                placeholder="Customer name"
                placeholderTextColor={Colors.textLight}
              />
            </View>
            <View style={styles.fieldHalf}>
              <Text style={styles.label}>Phone *</Text>
              <TextInput
                style={styles.input}
                value={customerPhone}
                onChangeText={setCustomerPhone}
                placeholder="Phone number"
                placeholderTextColor={Colors.textLight}
                keyboardType="phone-pad"
              />
            </View>
          </View>
          {orderType === 'delivery' && (
            <>
              <Text style={styles.label}>Delivery Address *</Text>
              <TextInput
                style={[styles.input, { minHeight: 60, textAlignVertical: 'top' }]}
                value={customerAddress}
                onChangeText={setCustomerAddress}
                placeholder="Full delivery address"
                placeholderTextColor={Colors.textLight}
                multiline
              />
            </>
          )}
        </View>

        {/* ── Section 2: Order Type ── */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <View style={styles.sectionIcon}>
              <Ionicons name="cart" size={20} color={Colors.primary} />
            </View>
            <Text style={styles.sectionTitle}>Order Type</Text>
          </View>
          <View style={styles.orderTypeRow}>
            {ORDER_TYPES.map(t => (
              <TouchableOpacity
                key={t.key}
                style={[styles.orderTypeBtn, orderType === t.key && { backgroundColor: t.color, borderColor: t.color }]}
                onPress={() => setOrderType(t.key)}
              >
                <Ionicons name={t.icon} size={24} color={orderType === t.key ? '#fff' : t.color} />
                <Text style={[styles.orderTypeBtnText, orderType === t.key && { color: '#fff' }]}>{t.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
          {locations.length > 1 && (
            <View style={{ marginTop: Spacing.sm }}>
              <Text style={styles.label}>Location</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: Spacing.xs }}>
                {locations.map(loc => (
                  <TouchableOpacity
                    key={loc.id}
                    style={[styles.chip, selectedLocation === loc.id && styles.chipActive]}
                    onPress={() => setSelectedLocation(loc.id)}
                  >
                    <Text style={[styles.chipText, selectedLocation === loc.id && styles.chipTextActive]}>{loc.name}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          )}
        </View>

        {/* ── Section 3: Items ── */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <View style={styles.sectionIcon}>
              <Ionicons name="gift" size={20} color={Colors.primary} />
            </View>
            <Text style={styles.sectionTitle}>Items ({items.length})</Text>
            <TouchableOpacity style={styles.addItemBtn} onPress={addItem}>
              <Ionicons name="add-circle" size={20} color={Colors.white} />
              <Text style={styles.addItemBtnText}>Add Item</Text>
            </TouchableOpacity>
          </View>

          {items.length === 0 && (
            <View style={styles.emptyItems}>
              <Ionicons name="gift-outline" size={48} color={Colors.textLight} />
              <Text style={styles.emptyText}>No items yet — tap "Add Item" to start</Text>
            </View>
          )}

          {items.map((item, idx) => (
            <View key={idx} style={styles.itemCard}>
              <View style={styles.itemCardHeader}>
                <Text style={styles.itemNum}>#{idx + 1}</Text>
                <TouchableOpacity onPress={() => removeItem(idx)}>
                  <Ionicons name="trash-outline" size={20} color={Colors.error} />
                </TouchableOpacity>
              </View>

              {/* Product name / select base product */}
              <View style={styles.fieldRow}>
                <View style={{ flex: 2 }}>
                  <Text style={styles.label}>Product Name *</Text>
                  <TextInput
                    style={styles.input}
                    value={item.name}
                    onChangeText={(v) => updateItem(idx, 'name', v)}
                    placeholder="e.g. Custom Bouquet"
                    placeholderTextColor={Colors.textLight}
                  />
                </View>
                <TouchableOpacity
                  style={styles.pickProductBtn}
                  onPress={() => {
                    setEditingItemIdx(idx);
                    setProductSearch('');
                    fetchProducts('');
                    setShowProductPicker(true);
                  }}
                >
                  <Ionicons name="search" size={18} color={Colors.primary} />
                  <Text style={styles.pickProductText}>Pick</Text>
                </TouchableOpacity>
              </View>

              {item.baseProduct && (
                <View style={styles.baseProductTag}>
                  {item.baseProduct.image_url ? (
                    <Image source={{ uri: item.baseProduct.image_url }} style={{ width: 24, height: 24, borderRadius: 4 }} />
                  ) : (
                    <Ionicons name="gift" size={16} color={Colors.primary} />
                  )}
                  <Text style={styles.baseProductTagText}>Based on: {item.baseProduct.name}</Text>
                </View>
              )}

              {/* Price + Quantity */}
              <View style={styles.fieldRow}>
                <View style={styles.fieldHalf}>
                  <Text style={styles.label}>Price (₹) *</Text>
                  <TextInput
                    style={styles.input}
                    value={item.price}
                    onChangeText={(v) => updateItem(idx, 'price', v)}
                    placeholder="0"
                    placeholderTextColor={Colors.textLight}
                    keyboardType="numeric"
                  />
                </View>
                <View style={styles.fieldHalf}>
                  <Text style={styles.label}>Qty</Text>
                  <View style={styles.qtyRow}>
                    <TouchableOpacity
                      style={styles.qtyBtn}
                      onPress={() => updateItem(idx, 'quantity', String(Math.max(1, (parseInt(item.quantity) || 1) - 1)))}
                    >
                      <Ionicons name="remove" size={20} color={Colors.primary} />
                    </TouchableOpacity>
                    <TextInput
                      style={[styles.input, { textAlign: 'center', flex: 1 }]}
                      value={item.quantity}
                      onChangeText={(v) => updateItem(idx, 'quantity', v)}
                      keyboardType="numeric"
                    />
                    <TouchableOpacity
                      style={styles.qtyBtn}
                      onPress={() => updateItem(idx, 'quantity', String((parseInt(item.quantity) || 1) + 1))}
                    >
                      <Ionicons name="add" size={20} color={Colors.primary} />
                    </TouchableOpacity>
                  </View>
                </View>
              </View>

              {/* Materials */}
              <View style={styles.materialsSection}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text style={styles.label}>Materials Used</Text>
                  <TouchableOpacity onPress={() => addMaterialToItem(idx)} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <Ionicons name="add-circle-outline" size={16} color={Colors.primary} />
                    <Text style={{ fontSize: 12, color: Colors.primary, fontWeight: '600' }}>Add</Text>
                  </TouchableOpacity>
                </View>
                {item.materials.map((m, matIdx) => (
                  <View key={matIdx} style={styles.materialRow}>
                    <TouchableOpacity
                      style={[styles.input, { flex: 2, justifyContent: 'center' }]}
                      onPress={() => {
                        const filtered = allMaterials.filter(mat =>
                          !item.materials.some((qm, qi) => qi !== matIdx && qm.material_id === mat.id)
                        );
                        if (filtered.length === 0) { Alert.alert('No materials'); return; }
                        Alert.alert('Select Material', '', filtered.slice(0, 20).map(mat => ({
                          text: mat.name,
                          onPress: () => selectMaterialForItem(idx, matIdx, mat),
                        })).concat([{ text: 'Cancel', style: 'cancel' }]));
                      }}
                    >
                      <Text style={{ color: m.material_id ? Colors.text : Colors.textLight, fontSize: FontSize.sm }}>
                        {m.name || 'Select...'}
                      </Text>
                    </TouchableOpacity>
                    <TextInput
                      style={[styles.input, { flex: 1 }]}
                      value={m.qty}
                      onChangeText={(v) => updateItemMaterial(idx, matIdx, 'qty', v)}
                      placeholder="Qty"
                      placeholderTextColor={Colors.textLight}
                      keyboardType="numeric"
                    />
                    <TouchableOpacity onPress={() => removeMaterialFromItem(idx, matIdx)}>
                      <Ionicons name="close-circle" size={20} color={Colors.error} />
                    </TouchableOpacity>
                  </View>
                ))}
              </View>

              {/* Special Instructions & Image */}
              <View style={styles.fieldRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.label}>Special Instructions (Optional)</Text>
                  <TextInput
                    style={styles.input}
                    value={item.special_instructions}
                    onChangeText={(v) => updateItem(idx, 'special_instructions', v)}
                    placeholder="Notes for production..."
                    placeholderTextColor={Colors.textLight}
                  />
                </View>
                <TouchableOpacity
                  style={[styles.pickProductBtn, { minWidth: 70, marginLeft: 10, justifyContent: 'center', alignSelf: 'flex-end', height: 44, marginBottom: 8 }]}
                  onPress={() => pickImage(idx)}
                >
                  {item.image_url ? (
                    <Image source={{ uri: item.image_url }} style={{ width: 30, height: 30, borderRadius: 4 }} />
                  ) : (
                    <>
                      <Ionicons name="camera-outline" size={20} color={Colors.primary} />
                      <Text style={[styles.pickProductText, { marginLeft: 4 }]}>Photo</Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>

              {/* Item total */}
              <View style={styles.itemTotal}>
                <Text style={styles.itemTotalLabel}>Item Total</Text>
                <Text style={styles.itemTotalValue}>₹{getItemTotal(item).toFixed(0)}</Text>
              </View>
            </View>
          ))}
        </View>

        {/* ── Grand Total + Place Order ── */}
        {items.length > 0 && (
          <View style={styles.section}>
            <View style={styles.grandTotalRow}>
              <Text style={styles.grandTotalLabel}>Grand Total</Text>
              <Text style={styles.grandTotalValue}>₹{grandTotal.toFixed(0)}</Text>
            </View>
            <TouchableOpacity
              style={[styles.placeOrderBtn, submitting && { opacity: 0.6 }]}
              onPress={handlePlaceOrder}
              disabled={submitting}
            >
              {submitting ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <>
                  <Ionicons name="checkmark-circle" size={22} color="#fff" />
                  <Text style={styles.placeOrderText}>Proceed to Checkout</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* ── Product Picker Modal ── */}
      <Modal visible={showProductPicker} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Select Product</Text>
              <TouchableOpacity onPress={() => setShowProductPicker(false)}>
                <Ionicons name="close" size={24} color={Colors.text} />
              </TouchableOpacity>
            </View>
            <View style={styles.searchRow}>
              <Ionicons name="search" size={18} color={Colors.textLight} />
              <TextInput
                style={styles.searchInput}
                value={productSearch}
                onChangeText={(v) => { setProductSearch(v); fetchProducts(v); }}
                placeholder="Search products..."
                placeholderTextColor={Colors.textLight}
                autoFocus
              />
            </View>
            <ScrollView style={{ maxHeight: 400 }}>
              {products.map(p => (
                <TouchableOpacity
                  key={p.id}
                  style={styles.productPickItem}
                  onPress={() => addFromProduct(p, editingItemIdx)}
                >
                  <View style={styles.productPickIcon}>
                    {p.image_url ? (
                      <Image source={{ uri: p.image_url }} style={{ width: 40, height: 40, borderRadius: 8 }} />
                    ) : (
                      <Ionicons name="gift" size={22} color={Colors.primary} />
                    )}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.productPickName}>{p.name}</Text>
                    <Text style={styles.productPickPrice}>₹{(p.selling_price || 0).toFixed(0)}</Text>
                  </View>
                  <Ionicons name="add-circle" size={24} color={Colors.success} />
                </TouchableOpacity>
              ))}
              {products.length === 0 && (
                <Text style={styles.emptyText}>No products found</Text>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.md },

  section: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg,
    padding: Spacing.md, marginBottom: Spacing.md,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 6, elevation: 3,
  },
  sectionHeader: {
    flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.md,
  },
  sectionIcon: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: Colors.primary + '15', justifyContent: 'center', alignItems: 'center',
    marginRight: Spacing.sm,
  },
  sectionTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, flex: 1 },

  label: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.textSecondary, marginBottom: 4, marginTop: Spacing.xs },
  input: {
    backgroundColor: Colors.background, borderWidth: 1, borderColor: Colors.border,
    borderRadius: BorderRadius.md, paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.sm, fontSize: FontSize.md, color: Colors.text,
    minHeight: 44,
  },
  fieldRow: { flexDirection: 'row', gap: Spacing.sm },
  fieldHalf: { flex: 1 },

  orderTypeRow: { flexDirection: 'row', gap: Spacing.sm },
  orderTypeBtn: {
    flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4,
    paddingVertical: Spacing.md, borderRadius: BorderRadius.lg,
    backgroundColor: Colors.background, borderWidth: 2, borderColor: Colors.border,
    minHeight: 64,
  },
  orderTypeBtnText: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.textSecondary },

  chip: {
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, borderRadius: BorderRadius.full,
    backgroundColor: Colors.background, borderWidth: 1, borderColor: Colors.border,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '500' },
  chipTextActive: { color: Colors.white },

  addItemBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: Colors.primary, paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm, borderRadius: BorderRadius.md,
  },
  addItemBtnText: { color: Colors.white, fontWeight: '700', fontSize: FontSize.sm },

  emptyItems: { alignItems: 'center', paddingVertical: Spacing.xl },
  emptyText: { color: Colors.textLight, marginTop: Spacing.sm, fontSize: FontSize.sm, textAlign: 'center', padding: Spacing.md },

  itemCard: {
    backgroundColor: Colors.background, borderRadius: BorderRadius.md,
    padding: Spacing.md, marginBottom: Spacing.sm,
    borderWidth: 1, borderColor: Colors.border,
  },
  itemCardHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: Spacing.sm,
  },
  itemNum: { fontSize: FontSize.md, fontWeight: '700', color: Colors.primary },

  pickProductBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: Colors.primary + '15', paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.md, alignSelf: 'flex-end',
    minHeight: 44, marginTop: 20,
  },
  pickProductText: { fontSize: FontSize.sm, color: Colors.primary, fontWeight: '600' },

  baseProductTag: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: Colors.successLight || '#E8F5E9', paddingHorizontal: Spacing.sm,
    paddingVertical: 6, borderRadius: BorderRadius.sm, marginTop: Spacing.xs, marginBottom: Spacing.xs,
  },
  baseProductTagText: { fontSize: FontSize.xs, color: Colors.success, fontWeight: '600' },

  qtyRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs },
  qtyBtn: {
    width: 44, height: 44, borderRadius: BorderRadius.md,
    backgroundColor: Colors.primary + '15', justifyContent: 'center', alignItems: 'center',
  },

  materialsSection: {
    marginTop: Spacing.sm, paddingTop: Spacing.sm,
    borderTopWidth: 1, borderTopColor: Colors.border,
  },
  materialRow: {
    flexDirection: 'row', gap: Spacing.xs, alignItems: 'center', marginBottom: Spacing.xs,
  },

  itemTotal: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginTop: Spacing.sm, paddingTop: Spacing.sm,
    borderTopWidth: 1, borderTopColor: Colors.border,
  },
  itemTotalLabel: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  itemTotalValue: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.success },

  grandTotalRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: Spacing.md,
  },
  grandTotalLabel: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text },
  grandTotalValue: { fontSize: FontSize.xxl, fontWeight: '700', color: Colors.primary },

  placeOrderBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: Colors.primary, paddingVertical: Spacing.md,
    borderRadius: BorderRadius.lg, minHeight: 56,
  },
  placeOrderText: { color: '#fff', fontWeight: '700', fontSize: FontSize.lg },

  // Modal
  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: Colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: Spacing.lg, maxHeight: '80%',
  },
  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: Spacing.md,
  },
  modalTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  searchRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.background, borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.sm, marginBottom: Spacing.md,
    borderWidth: 1, borderColor: Colors.border,
  },
  searchInput: { flex: 1, fontSize: FontSize.md, color: Colors.text, minHeight: 44 },

  productPickItem: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md,
    paddingVertical: Spacing.sm, borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  productPickIcon: {
    width: 44, height: 44, borderRadius: 10,
    backgroundColor: Colors.primary + '12', justifyContent: 'center', alignItems: 'center',
  },
  productPickName: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  productPickPrice: { fontSize: FontSize.sm, color: Colors.success, fontWeight: '600' },
});
