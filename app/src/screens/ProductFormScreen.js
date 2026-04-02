import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TextInput,
  TouchableOpacity, Alert, KeyboardAvoidingView, Platform,
  Modal,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const PRODUCT_TYPES = [
  { key: 'standard', label: 'Standard', icon: 'cube' },
  { key: 'custom', label: 'Custom', icon: 'color-palette' },
  { key: 'made_to_order', label: 'Made to Order', icon: 'construct' },
];

const PRODUCT_CATEGORIES = [
  { key: 'bouquet', label: 'Bouquet' },
  { key: 'arrangement', label: 'Arrangement' },
  { key: 'basket', label: 'Basket' },
  { key: 'single_stem', label: 'Single Stem' },
  { key: 'gift_combo', label: 'Gift Combo' },
  { key: 'other', label: 'Other' },
];

export default function ProductFormScreen({ route, navigation }) {
  const editProduct = route.params?.product;
  const isEdit = !!editProduct;

  const [name, setName] = useState(editProduct?.name || '');
  const [sku, setSku] = useState(editProduct?.sku || '');
  const [description, setDescription] = useState(editProduct?.description || '');
  const [type, setType] = useState(editProduct?.type || 'standard');
  const [category, setCategory] = useState(editProduct?.category || null);
  const [sellingPrice, setSellingPrice] = useState(editProduct?.selling_price?.toString() || '');
  const [taxRateId, setTaxRateId] = useState(editProduct?.tax_rate_id || null);
  const [locationId, setLocationId] = useState(editProduct?.location_id || null);
  const [taxRates, setTaxRates] = useState([]);
  const [locations, setLocations] = useState([]);
  const [saving, setSaving] = useState(false);

  // Materials state (create mode only — edit uses ProductDetailScreen)
  const [selectedMaterials, setSelectedMaterials] = useState([]);
  const [showMaterialPicker, setShowMaterialPicker] = useState(false);
  const [allMaterials, setAllMaterials] = useState([]);
  const [materialSearch, setMaterialSearch] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const [taxRes, matRes, locRes] = await Promise.all([
          api.getTaxRates(),
          api.getMaterials(),
          api.getLocations(),
        ]);
        setTaxRates(taxRes.data?.taxRates || taxRes.data || []);
        setAllMaterials(matRes.data || []);
        setLocations(locRes.data?.locations || locRes.data || []);
      } catch {}
    })();
  }, []);

  const estimatedCost = selectedMaterials.reduce((sum, m) => sum + ((parseFloat(m.quantity) || 0) * (parseFloat(m.cost_per_unit) || 0)), 0);

  const openMaterialPicker = () => {
    setMaterialSearch('');
    setShowMaterialPicker(true);
  };

  const addMaterial = (mat) => {
    if (selectedMaterials.find((m) => m.material_id === mat.id)) return;
    setSelectedMaterials((prev) => [...prev, {
      material_id: mat.id,
      name: mat.name,
      category_name: mat.category_name,
      unit: mat.category_unit,
      quantity: 1,
      cost_per_unit: mat.avg_cost || 0,
    }]);
    setShowMaterialPicker(false);
  };

  const updateMaterialField = (materialId, field, value) => {
    setSelectedMaterials((prev) =>
      prev.map((m) => m.material_id === materialId ? { ...m, [field]: value } : m)
    );
  };

  const removeMaterial = (materialId) => {
    setSelectedMaterials((prev) => prev.filter((m) => m.material_id !== materialId));
  };

  const filteredPickerMaterials = allMaterials.filter((m) => {
    if (selectedMaterials.find((s) => s.material_id === m.id)) return false;
    if (!materialSearch) return true;
    const q = materialSearch.toLowerCase();
    return m.name.toLowerCase().includes(q) || (m.sku && m.sku.toLowerCase().includes(q));
  });

  const handleSave = async () => {
    if (!name.trim()) { Alert.alert('Required', 'Product name is required'); return; }

    setSaving(true);
    try {
      const data = {
        name: name.trim(),
        description: description.trim(),
        type,
        category: category || undefined,
        selling_price: parseFloat(sellingPrice) || 0,
        tax_rate_id: taxRateId,
        location_id: locationId || undefined,
      };
      if (sku.trim()) data.sku = sku.trim();

      if (!isEdit && selectedMaterials.length > 0) {
        data.materials = selectedMaterials.map((m) => ({
          material_id: m.material_id,
          quantity: parseFloat(m.quantity) || 1,
          cost_per_unit: parseFloat(m.cost_per_unit) || 0,
        }));
      }

      if (isEdit) {
        await api.updateProduct(editProduct.id, data);
      } else {
        await api.createProduct(data);
      }
      navigation.goBack();
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to save product');
    } finally {
      setSaving(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        {/* Name */}
        <Text style={styles.label}>Product Name *</Text>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={setName}
          placeholder="e.g. Rose Bouquet Deluxe"
          placeholderTextColor={Colors.textLight}
        />

        {/* SKU */}
        <Text style={styles.label}>SKU {isEdit ? '' : '(auto-generated if empty)'}</Text>
        <TextInput
          style={styles.input}
          value={sku}
          onChangeText={setSku}
          placeholder="e.g. PRD-ROS-001"
          placeholderTextColor={Colors.textLight}
          autoCapitalize="characters"
        />

        {/* Type */}
        <Text style={styles.label}>Type</Text>
        <View style={styles.chipRow}>
          {PRODUCT_TYPES.map((t) => (
            <TouchableOpacity
              key={t.key}
              style={[styles.typeChip, type === t.key && styles.typeChipActive]}
              onPress={() => setType(t.key)}
            >
              <Ionicons name={t.icon} size={16} color={type === t.key ? Colors.white : Colors.textSecondary} />
              <Text style={[styles.typeChipText, type === t.key && styles.typeChipTextActive]}>{t.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Category */}
        <Text style={styles.label}>Category</Text>
        <View style={styles.chipRow}>
          <TouchableOpacity
            style={[styles.taxChip, category === null && styles.taxChipActive]}
            onPress={() => setCategory(null)}
          >
            <Text style={[styles.taxChipText, category === null && styles.taxChipTextActive]}>None</Text>
          </TouchableOpacity>
          {PRODUCT_CATEGORIES.map((c) => (
            <TouchableOpacity
              key={c.key}
              style={[styles.taxChip, category === c.key && styles.taxChipActive]}
              onPress={() => setCategory(c.key)}
            >
              <Text style={[styles.taxChipText, category === c.key && styles.taxChipTextActive]}>{c.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Location */}
        {locations.length > 0 && (
          <>
            <Text style={styles.label}>Location</Text>
            <View style={styles.chipRow}>
              <TouchableOpacity
                style={[styles.taxChip, locationId === null && styles.taxChipActive]}
                onPress={() => setLocationId(null)}
              >
                <Text style={[styles.taxChipText, locationId === null && styles.taxChipTextActive]}>None</Text>
              </TouchableOpacity>
              {locations.map((loc) => (
                <TouchableOpacity
                  key={loc.id}
                  style={[styles.taxChip, locationId === loc.id && styles.taxChipActive]}
                  onPress={() => setLocationId(loc.id)}
                >
                  <Text style={[styles.taxChipText, locationId === loc.id && styles.taxChipTextActive]}>{loc.name}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </>
        )}

        {/* Description */}
        <Text style={styles.label}>Description</Text>
        <TextInput
          style={[styles.input, styles.textArea]}
          value={description}
          onChangeText={setDescription}
          placeholder="Product description..."
          placeholderTextColor={Colors.textLight}
          multiline
          numberOfLines={3}
          textAlignVertical="top"
        />

        {/* Selling Price */}
        <Text style={styles.label}>Selling Price (₹)</Text>
        <TextInput
          style={styles.input}
          value={sellingPrice}
          onChangeText={setSellingPrice}
          placeholder="0.00"
          placeholderTextColor={Colors.textLight}
          keyboardType="decimal-pad"
        />

        {/* Tax Rate */}
        <Text style={styles.label}>Tax Rate</Text>
        <View style={styles.chipRow}>
          <TouchableOpacity
            style={[styles.taxChip, taxRateId === null && styles.taxChipActive]}
            onPress={() => setTaxRateId(null)}
          >
            <Text style={[styles.taxChipText, taxRateId === null && styles.taxChipTextActive]}>None</Text>
          </TouchableOpacity>
          {taxRates.map((tr) => (
            <TouchableOpacity
              key={tr.id}
              style={[styles.taxChip, taxRateId === tr.id && styles.taxChipActive]}
              onPress={() => setTaxRateId(tr.id)}
            >
              <Text style={[styles.taxChipText, taxRateId === tr.id && styles.taxChipTextActive]}>
                {tr.name}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Materials (Bill of Materials) — create mode only */}
        {!isEdit && (
          <>
            <View style={styles.matSectionHeader}>
              <Text style={styles.label}>Materials Used</Text>
              <TouchableOpacity onPress={openMaterialPicker} style={styles.addMatBtn}>
                <Ionicons name="add-circle" size={22} color={Colors.primary} />
                <Text style={styles.addMatBtnText}>Add</Text>
              </TouchableOpacity>
            </View>

            {selectedMaterials.length === 0 ? (
              <Text style={styles.emptyMatText}>No materials added. Tap + to add materials used in this product.</Text>
            ) : (
              <>
                {selectedMaterials.map((mat) => (
                  <View key={mat.material_id} style={styles.matCard}>
                    <View style={styles.matCardHeader}>
                      <View style={styles.matCardInfo}>
                        <Text style={styles.matCardName}>{mat.name}</Text>
                        <Text style={styles.matCardCategory}>{mat.category_name} · {mat.unit}</Text>
                      </View>
                      <TouchableOpacity onPress={() => removeMaterial(mat.material_id)}>
                        <Ionicons name="close-circle" size={22} color={Colors.error} />
                      </TouchableOpacity>
                    </View>
                    <View style={styles.matCardFields}>
                      <View style={styles.matFieldWrap}>
                        <Text style={styles.matFieldLabel}>Qty</Text>
                        <TextInput
                          style={styles.matFieldInput}
                          value={String(mat.quantity)}
                          onChangeText={(v) => updateMaterialField(mat.material_id, 'quantity', v)}
                          keyboardType="decimal-pad"
                          placeholder="1"
                          placeholderTextColor={Colors.textLight}
                        />
                      </View>
                      <View style={styles.matFieldWrap}>
                        <Text style={styles.matFieldLabel}>Cost/Unit (₹)</Text>
                        <TextInput
                          style={styles.matFieldInput}
                          value={String(mat.cost_per_unit)}
                          onChangeText={(v) => updateMaterialField(mat.material_id, 'cost_per_unit', v)}
                          keyboardType="decimal-pad"
                          placeholder="0"
                          placeholderTextColor={Colors.textLight}
                        />
                      </View>
                      <View style={styles.matFieldWrap}>
                        <Text style={styles.matFieldLabel}>Subtotal</Text>
                        <Text style={styles.matSubtotal}>
                          ₹{Number((parseFloat(mat.quantity) || 0) * (parseFloat(mat.cost_per_unit) || 0)).toFixed(2)}
                        </Text>
                      </View>
                    </View>
                  </View>
                ))}
                <View style={styles.costSummary}>
                  <Text style={styles.costSummaryLabel}>Estimated Cost</Text>
                  <Text style={styles.costSummaryValue}>₹{Number(estimatedCost).toFixed(2)}</Text>
                </View>
              </>
            )}
          </>
        )}

        {/* Save button */}
        <TouchableOpacity
          style={[styles.saveBtn, saving && { opacity: 0.6 }]}
          onPress={handleSave}
          disabled={saving}
          activeOpacity={0.8}
        >
          <Ionicons name={isEdit ? 'checkmark' : 'add'} size={20} color={Colors.white} />
          <Text style={styles.saveBtnText}>{saving ? 'Saving...' : isEdit ? 'Update Product' : 'Create Product'}</Text>
        </TouchableOpacity>
      </ScrollView>

      {/* Material Picker Modal */}
      <Modal visible={showMaterialPicker} transparent animationType="slide" onRequestClose={() => setShowMaterialPicker(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Select Material</Text>
              <TouchableOpacity onPress={() => setShowMaterialPicker(false)}>
                <Ionicons name="close" size={24} color={Colors.text} />
              </TouchableOpacity>
            </View>
            <TextInput
              style={styles.modalSearch}
              placeholder="Search materials..."
              placeholderTextColor={Colors.textLight}
              value={materialSearch}
              onChangeText={setMaterialSearch}
            />
            <ScrollView style={styles.modalList} keyboardShouldPersistTaps="handled">
              {filteredPickerMaterials.length === 0 ? (
                <Text style={styles.emptyMatText}>No materials available</Text>
              ) : (
                filteredPickerMaterials.map((m) => (
                  <TouchableOpacity
                    key={m.id}
                    style={styles.modalItem}
                    onPress={() => addMaterial(m)}
                  >
                    <View style={[styles.matIconCircle, { backgroundColor: Colors.secondary + '15' }]}>
                      <Ionicons name="flower" size={16} color={Colors.secondary} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.modalItemText}>{m.name}</Text>
                      <Text style={styles.modalItemSub}>{m.category_name} · {m.sku}</Text>
                    </View>
                  </TouchableOpacity>
                ))
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
  scrollContent: { padding: Spacing.lg, paddingBottom: 60 },

  label: {
    fontSize: FontSize.sm, fontWeight: '600', color: Colors.text,
    marginBottom: Spacing.xs, marginTop: Spacing.md,
  },
  input: {
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border,
    borderRadius: BorderRadius.md, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    fontSize: FontSize.md, color: Colors.text,
  },
  textArea: { minHeight: 80 },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  typeChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, borderRadius: BorderRadius.full,
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border,
  },
  typeChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  typeChipText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '500' },
  typeChipTextActive: { color: Colors.white },

  taxChip: {
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs + 2, borderRadius: BorderRadius.full,
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border,
  },
  taxChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  taxChipText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '500' },
  taxChipTextActive: { color: Colors.white },

  // Materials section
  matSectionHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: Spacing.md,
  },
  addMatBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  addMatBtnText: { fontSize: FontSize.sm, color: Colors.primary, fontWeight: '600' },
  emptyMatText: { fontSize: FontSize.sm, color: Colors.textLight, textAlign: 'center', paddingVertical: Spacing.md },
  matCard: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md, padding: Spacing.md,
    marginTop: Spacing.sm, borderWidth: 1, borderColor: Colors.border,
  },
  matCardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.sm },
  matCardInfo: { flex: 1 },
  matCardName: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  matCardCategory: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 1 },
  matCardFields: { flexDirection: 'row', gap: Spacing.sm },
  matFieldWrap: { flex: 1 },
  matFieldLabel: { fontSize: FontSize.xs, color: Colors.textLight, marginBottom: 3 },
  matFieldInput: {
    borderWidth: 1, borderColor: Colors.border, borderRadius: BorderRadius.sm,
    paddingHorizontal: Spacing.sm, paddingVertical: 6, fontSize: FontSize.sm, color: Colors.text,
    backgroundColor: Colors.background,
  },
  matSubtotal: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.success, paddingTop: 8 },
  costSummary: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: Colors.success + '10', borderRadius: BorderRadius.md,
    padding: Spacing.md, marginTop: Spacing.sm,
  },
  costSummaryLabel: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  costSummaryValue: { fontSize: FontSize.md, fontWeight: '700', color: Colors.success },

  // Modal
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  modalContent: {
    backgroundColor: Colors.surface, borderTopLeftRadius: BorderRadius.xl, borderTopRightRadius: BorderRadius.xl,
    padding: Spacing.lg, maxHeight: '70%',
  },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.md },
  modalTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  modalSearch: {
    borderWidth: 1, borderColor: Colors.border, borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, fontSize: FontSize.md,
    color: Colors.text, marginBottom: Spacing.sm,
  },
  modalList: { maxHeight: 350 },
  modalItem: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.border, gap: Spacing.sm,
  },
  matIconCircle: { width: 32, height: 32, borderRadius: 16, justifyContent: 'center', alignItems: 'center' },
  modalItemText: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  modalItemSub: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 1 },

  saveBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm,
    backgroundColor: Colors.primary, borderRadius: BorderRadius.md, paddingVertical: Spacing.md,
    marginTop: Spacing.xl,
  },
  saveBtnText: { color: Colors.white, fontSize: FontSize.md, fontWeight: '600' },
});
