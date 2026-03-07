import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, KeyboardAvoidingView, Platform,
  ScrollView, Alert, TouchableOpacity, Modal, TextInput,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';
import Input from '../components/Input';
import Button from '../components/Button';
import DismissKeyboard from '../components/DismissKeyboard';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

// Only import DateTimePicker on native platforms
let DateTimePicker = null;
if (Platform.OS !== 'web') {
  DateTimePicker = require('@react-native-community/datetimepicker').default;
}

export default function PurchaseOrderFormScreen({ route, navigation }) {
  const existingOrder = route.params?.order;
  const isEditing = !!existingOrder;

  const [suppliers, setSuppliers] = useState([]);
  const [locations, setLocations] = useState([]);
  const [materials, setMaterials] = useState([]);

  const [supplierId, setSupplierId] = useState(existingOrder?.supplier_id || null);
  const [locationId, setLocationId] = useState(existingOrder?.location_id || null);
  const [expectedDate, setExpectedDate] = useState(
    existingOrder?.expected_date ? new Date(existingOrder.expected_date) : null
  );
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [tempDate, setTempDate] = useState(new Date());
  const [notes, setNotes] = useState(existingOrder?.notes || '');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState({});
  const webDateRef = useRef(null);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const [supRes, locRes, matRes] = await Promise.all([
        api.getSuppliers(),
        api.getLocations(),
        api.getMaterials(),
      ]);
      setSuppliers(supRes.data || []);
      setLocations(locRes.data?.locations || locRes.data || []);
      setMaterials(matRes.data || []);

      // Pre-fill items when editing
      if (isEditing && existingOrder.items) {
        setItems(
          existingOrder.items.map((i) => ({
            material_id: i.material_id,
            expected_quantity: String(i.expected_quantity),
            expected_price_per_unit: String(i.expected_price_per_unit || ''),
            unit: i.expected_unit || 'pieces',
          }))
        );
      }
    } catch (err) {
      Alert.alert('Error', 'Failed to load form data');
    }
  };

  // Helper: get bundle info for a material
  const getMaterialInfo = (materialId) => {
    const mat = materials.find((m) => m.id === materialId);
    if (!mat) return null;
    return {
      name: mat.name,
      baseUnit: mat.category_unit || 'pieces',
      hasBundle: !!mat.has_bundle,
      bundleSize: mat.bundle_size_override || mat.default_bundle_size || 1,
    };
  };

  const addItem = () => {
    setItems([...items, { material_id: null, expected_quantity: '', expected_price_per_unit: '', unit: '' }]);
  };

  const removeItem = (index) => {
    setItems(items.filter((_, i) => i !== index));
  };

  const updateItem = (index, field, value) => {
    const updated = [...items];
    if (field === 'material_id') {
      // When material changes, reset unit to the material's base unit
      const mat = materials.find((m) => m.id === value);
      updated[index] = { ...updated[index], material_id: value, unit: mat?.category_unit || 'pieces' };
    } else {
      updated[index] = { ...updated[index], [field]: value };
    }
    setItems(updated);
  };

  const validate = () => {
    const e = {};
    if (!supplierId) e.supplier = 'Select a supplier';
    if (!locationId) e.location = 'Select a location';
    if (items.length === 0) e.items = 'Add at least one item';
    items.forEach((item, i) => {
      if (!item.material_id) e[`item_${i}_material`] = 'Select a material';
      if (!item.expected_quantity || parseFloat(item.expected_quantity) <= 0) {
        e[`item_${i}_qty`] = 'Enter quantity';
      }
    });
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) return;
    setLoading(true);
    try {
      const payload = {
        supplier_id: supplierId,
        location_id: locationId,
        expected_date: expectedDate ? expectedDate.toISOString().split('T')[0] : undefined,
        notes: notes.trim() || undefined,
        items: items.map((i) => ({
          material_id: i.material_id,
          expected_quantity: parseFloat(i.expected_quantity),
          expected_price_per_unit: parseFloat(i.expected_price_per_unit) || 0,
          expected_unit: i.unit || undefined,
        })),
      };

      if (isEditing) {
        await api.updatePurchaseOrder(existingOrder.id, payload);
      } else {
        await api.createPurchaseOrder(payload);
      }
      navigation.goBack();
    } catch (err) {
      Alert.alert('Error', err.message || `Failed to ${isEditing ? 'update' : 'create'} order`);
    } finally { setLoading(false); }
  };

  // ─── Date Picker Helpers ───
  const openDatePicker = () => {
    if (Platform.OS === 'web') {
      // On web, trigger the hidden HTML date input
      webDateRef.current?.click?.();
      webDateRef.current?.showPicker?.();
      return;
    }
    setTempDate(expectedDate || new Date());
    setShowDatePicker(true);
  };

  const onDateChangeAndroid = (event, selectedDate) => {
    setShowDatePicker(false);
    if (event.type === 'set' && selectedDate) {
      setExpectedDate(selectedDate);
    }
  };

  const handleWebDateChange = (e) => {
    const val = e.target.value;
    if (val) {
      const parts = val.split('-');
      setExpectedDate(new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2])));
    }
  };

  const formatDate = (date) => {
    if (!date) return '';
    return date.toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' });
  };

  const formatDateForInput = (date) => {
    if (!date) return '';
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  };

  return (
    <DismissKeyboard>
      <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">

          {/* Supplier */}
          <Text style={styles.label}>Supplier</Text>
          {errors.supplier && <Text style={styles.errorText}>{errors.supplier}</Text>}
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={styles.chipRow}>
              {suppliers.map((s) => (
                <TouchableOpacity key={s.id} style={[styles.chip, supplierId === s.id && styles.chipActive]} onPress={() => setSupplierId(s.id)}>
                  <Text style={[styles.chipText, supplierId === s.id && styles.chipTextActive]}>{s.name}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </ScrollView>

          {/* Location */}
          <Text style={styles.label}>Delivery Location</Text>
          {errors.location && <Text style={styles.errorText}>{errors.location}</Text>}
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={styles.chipRow}>
              {locations.map((l) => (
                <TouchableOpacity key={l.id} style={[styles.chip, locationId === l.id && styles.chipActive]} onPress={() => setLocationId(l.id)}>
                  <Text style={[styles.chipText, locationId === l.id && styles.chipTextActive]}>{l.name}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </ScrollView>

          {/* Date Picker */}
          <Text style={styles.label}>Expected Date (optional)</Text>
          <TouchableOpacity style={styles.dateBtn} onPress={openDatePicker} activeOpacity={0.7}>
            <Ionicons name="calendar-outline" size={18} color={expectedDate ? Colors.primary : Colors.textLight} />
            <Text style={[styles.dateBtnText, !expectedDate && { color: Colors.textLight }]}>
              {expectedDate ? formatDate(expectedDate) : 'Select expected date'}
            </Text>
            {expectedDate && (
              <TouchableOpacity onPress={() => setExpectedDate(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close-circle" size={18} color={Colors.textLight} />
              </TouchableOpacity>
            )}
          </TouchableOpacity>

          {/* Hidden web date input */}
          {Platform.OS === 'web' && (
            <input
              ref={webDateRef}
              type="date"
              value={formatDateForInput(expectedDate)}
              onChange={handleWebDateChange}
              min={formatDateForInput(new Date())}
              style={{ position: 'absolute', opacity: 0, width: 0, height: 0, pointerEvents: 'none' }}
            />
          )}

          {/* Android date picker (native dialog) */}
          {showDatePicker && Platform.OS === 'android' && DateTimePicker && (
            <DateTimePicker
              value={tempDate}
              mode="date"
              display="default"
              minimumDate={new Date()}
              onChange={onDateChangeAndroid}
            />
          )}

          <Input label="Notes (optional)" value={notes} onChangeText={setNotes} placeholder="Any notes" multiline />

          {/* Items */}
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Items</Text>
            <TouchableOpacity onPress={addItem} style={styles.addItemBtn}>
              <Ionicons name="add-circle" size={20} color={Colors.primary} />
              <Text style={styles.addItemText}>Add Item</Text>
            </TouchableOpacity>
          </View>
          {errors.items && <Text style={styles.errorText}>{errors.items}</Text>}

          {items.map((item, index) => {
            const matInfo = getMaterialInfo(item.material_id);
            return (
              <View key={index} style={styles.itemCard}>
                <View style={styles.itemHeader}>
                  <Text style={styles.itemNum}>Item #{index + 1}</Text>
                  <TouchableOpacity onPress={() => removeItem(index)}>
                    <Ionicons name="trash-outline" size={18} color={Colors.error} />
                  </TouchableOpacity>
                </View>

                <Text style={styles.miniLabel}>Material</Text>
                {errors[`item_${index}_material`] && <Text style={styles.errorText}>{errors[`item_${index}_material`]}</Text>}
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <View style={styles.chipRow}>
                    {materials.map((m) => (
                      <TouchableOpacity
                        key={m.id}
                        style={[styles.chipSmall, item.material_id === m.id && styles.chipActive]}
                        onPress={() => updateItem(index, 'material_id', m.id)}
                      >
                        <Text style={[styles.chipTextSmall, item.material_id === m.id && styles.chipTextActive]}>
                          {m.name}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </ScrollView>

                {/* Unit selector — shows only if material supports bundles */}
                {matInfo && matInfo.hasBundle && (
                  <>
                    <Text style={styles.miniLabel}>Order as</Text>
                    <View style={styles.unitRow}>
                      <TouchableOpacity
                        style={[styles.unitChip, item.unit === matInfo.baseUnit && styles.unitChipActive]}
                        onPress={() => updateItem(index, 'unit', matInfo.baseUnit)}
                      >
                        <Text style={[styles.unitChipText, item.unit === matInfo.baseUnit && styles.chipTextActive]}>
                          {matInfo.baseUnit}
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.unitChip, item.unit === 'bundles' && styles.unitChipActive]}
                        onPress={() => updateItem(index, 'unit', 'bundles')}
                      >
                        <Text style={[styles.unitChipText, item.unit === 'bundles' && styles.chipTextActive]}>
                          bundles ({matInfo.bundleSize} {matInfo.baseUnit})
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </>
                )}

                <View style={styles.row}>
                  <View style={styles.halfInput}>
                    <Input
                      label={`Qty${matInfo ? ` (${item.unit || matInfo.baseUnit})` : ''}`}
                      value={item.expected_quantity}
                      onChangeText={(v) => updateItem(index, 'expected_quantity', v)}
                      keyboardType="numeric"
                      error={errors[`item_${index}_qty`]}
                      placeholder="0"
                    />
                  </View>
                  <View style={styles.halfInput}>
                    <Input
                      label={`Price/${item.unit === 'bundles' ? 'bundle' : 'unit'} (₹)`}
                      value={item.expected_price_per_unit}
                      onChangeText={(v) => updateItem(index, 'expected_price_per_unit', v)}
                      keyboardType="numeric"
                      placeholder="0"
                    />
                  </View>
                </View>

                {/* Show total in base units if ordering in bundles */}
                {matInfo && item.unit === 'bundles' && item.expected_quantity && (
                  <Text style={styles.bundleNote}>
                    = {parseFloat(item.expected_quantity || 0) * matInfo.bundleSize} {matInfo.baseUnit} total
                  </Text>
                )}
              </View>
            );
          })}

          <View style={styles.actions}>
            <Button title={isEditing ? 'Update Order' : 'Create Order'} onPress={handleSubmit} loading={loading} />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* iOS Date Picker Modal */}
      {Platform.OS === 'ios' && DateTimePicker && (
        <Modal visible={showDatePicker} transparent animationType="slide">
          <View style={styles.modalOverlay}>
            <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setShowDatePicker(false)} />
            <View style={styles.modalContent}>
              <View style={styles.modalHeader}>
                <TouchableOpacity onPress={() => setShowDatePicker(false)}>
                  <Text style={styles.modalCancel}>Cancel</Text>
                </TouchableOpacity>
                <Text style={styles.modalTitle}>Expected Date</Text>
                <TouchableOpacity onPress={() => { setExpectedDate(tempDate); setShowDatePicker(false); }}>
                  <Text style={styles.modalDone}>Done</Text>
                </TouchableOpacity>
              </View>
              <DateTimePicker
                value={tempDate}
                mode="date"
                display="spinner"
                minimumDate={new Date()}
                onChange={(event, date) => { if (date) setTempDate(date); }}
                style={{ height: 200 }}
              />
            </View>
          </View>
        </Modal>
      )}
    </DismissKeyboard>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.md, paddingBottom: 40 },
  label: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text, marginBottom: Spacing.xs, marginTop: Spacing.md },
  miniLabel: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.textSecondary, marginBottom: 4, marginTop: Spacing.sm },
  errorText: { fontSize: FontSize.xs, color: Colors.error, marginBottom: Spacing.xs },
  dateBtn: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border,
    borderRadius: BorderRadius.md, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm + 2,
  },
  dateBtnText: { flex: 1, fontSize: FontSize.md, color: Colors.text },
  chipRow: { flexDirection: 'row', gap: Spacing.sm, paddingBottom: 4 },
  chip: {
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs + 2, borderRadius: BorderRadius.full,
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '500' },
  chipTextActive: { color: Colors.white },
  chipSmall: {
    paddingHorizontal: Spacing.sm + 2, paddingVertical: 4, borderRadius: BorderRadius.full,
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border,
  },
  chipTextSmall: { fontSize: FontSize.xs, color: Colors.textSecondary },
  unitRow: { flexDirection: 'row', gap: Spacing.sm },
  unitChip: {
    flex: 1, paddingVertical: Spacing.xs + 2, borderRadius: BorderRadius.md,
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border,
    alignItems: 'center',
  },
  unitChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  unitChipText: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '500' },
  bundleNote: { fontSize: FontSize.xs, color: Colors.info, fontWeight: '500', marginTop: 4, marginLeft: 2 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: Spacing.lg },
  sectionTitle: { fontSize: FontSize.lg, fontWeight: '600', color: Colors.text },
  addItemBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  addItemText: { color: Colors.primary, fontWeight: '600', fontSize: FontSize.sm },
  itemCard: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md, padding: Spacing.md,
    marginTop: Spacing.sm, borderWidth: 1, borderColor: Colors.border,
  },
  itemHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.xs },
  itemNum: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.textSecondary },
  row: { flexDirection: 'row', gap: Spacing.md },
  halfInput: { flex: 1 },
  actions: { marginTop: Spacing.xl },
  /* iOS date picker modal */
  modalOverlay: {
    flex: 1, justifyContent: 'flex-end',
  },
  modalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  modalContent: {
    backgroundColor: Colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingBottom: 30,
  },
  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.md,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  modalCancel: { fontSize: FontSize.md, color: Colors.error },
  modalTitle: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  modalDone: { fontSize: FontSize.md, fontWeight: '600', color: Colors.primary },
});
