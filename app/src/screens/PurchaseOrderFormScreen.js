import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, KeyboardAvoidingView, Platform,
  ScrollView, Alert, TouchableOpacity,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';
import Input from '../components/Input';
import Button from '../components/Button';
import DismissKeyboard from '../components/DismissKeyboard';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

export default function PurchaseOrderFormScreen({ navigation }) {
  const [suppliers, setSuppliers] = useState([]);
  const [locations, setLocations] = useState([]);
  const [materials, setMaterials] = useState([]);

  const [supplierId, setSupplierId] = useState(null);
  const [locationId, setLocationId] = useState(null);
  const [expectedDate, setExpectedDate] = useState('');
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState({});

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
    } catch (err) {
      Alert.alert('Error', 'Failed to load form data');
    }
  };

  const addItem = () => {
    setItems([...items, { material_id: null, expected_quantity: '', expected_price_per_unit: '' }]);
  };

  const removeItem = (index) => {
    setItems(items.filter((_, i) => i !== index));
  };

  const updateItem = (index, field, value) => {
    const updated = [...items];
    updated[index] = { ...updated[index], [field]: value };
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
      await api.createPurchaseOrder({
        supplier_id: supplierId,
        location_id: locationId,
        expected_date: expectedDate || undefined,
        notes: notes.trim() || undefined,
        items: items.map((i) => ({
          material_id: i.material_id,
          expected_quantity: parseFloat(i.expected_quantity),
          expected_price_per_unit: parseFloat(i.expected_price_per_unit) || 0,
        })),
      });
      navigation.goBack();
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to create order');
    } finally { setLoading(false); }
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

          <Input label="Expected Date (optional)" value={expectedDate} onChangeText={setExpectedDate} placeholder="YYYY-MM-DD" />
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

          {items.map((item, index) => (
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

              <View style={styles.row}>
                <View style={styles.halfInput}>
                  <Input
                    label="Quantity"
                    value={item.expected_quantity}
                    onChangeText={(v) => updateItem(index, 'expected_quantity', v)}
                    keyboardType="numeric"
                    error={errors[`item_${index}_qty`]}
                    placeholder="0"
                  />
                </View>
                <View style={styles.halfInput}>
                  <Input
                    label="Price/Unit (₹)"
                    value={item.expected_price_per_unit}
                    onChangeText={(v) => updateItem(index, 'expected_price_per_unit', v)}
                    keyboardType="numeric"
                    placeholder="0"
                  />
                </View>
              </View>
            </View>
          ))}

          <View style={styles.actions}>
            <Button title="Create Purchase Order" onPress={handleSubmit} loading={loading} />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </DismissKeyboard>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.md, paddingBottom: 40 },
  label: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text, marginBottom: Spacing.xs, marginTop: Spacing.md },
  miniLabel: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.textSecondary, marginBottom: 4, marginTop: Spacing.sm },
  errorText: { fontSize: FontSize.xs, color: Colors.error, marginBottom: Spacing.xs },
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
});
