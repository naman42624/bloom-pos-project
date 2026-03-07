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

export default function StockAdjustScreen({ navigation }) {
  const [materials, setMaterials] = useState([]);
  const [locations, setLocations] = useState([]);
  const [materialId, setMaterialId] = useState(null);
  const [locationId, setLocationId] = useState(null);
  const [type, setType] = useState('wastage');
  const [quantity, setQuantity] = useState('');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState({});

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const [matRes, locRes] = await Promise.all([
        api.getMaterials(),
        api.getLocations(),
      ]);
      setMaterials(matRes.data || []);
      setLocations(locRes.data?.locations || locRes.data || []);
    } catch (err) {
      // silently handle
    }
  };

  const TYPES = [
    { key: 'wastage', label: 'Wastage', icon: 'trash', color: Colors.error },
    { key: 'usage', label: 'Usage', icon: 'construct', color: Colors.warning },
    { key: 'adjustment', label: 'Adjust', icon: 'swap-horizontal', color: Colors.info },
    { key: 'return', label: 'Return', icon: 'arrow-undo', color: Colors.success },
  ];

  const validate = () => {
    const e = {};
    if (!materialId) e.material = 'Select a material';
    if (!locationId) e.location = 'Select a location';
    if (!quantity || parseFloat(quantity) <= 0) e.quantity = 'Enter a valid quantity';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) return;
    setLoading(true);
    try {
      await api.adjustStock({
        material_id: materialId,
        location_id: locationId,
        type,
        quantity: parseFloat(quantity),
        notes: notes.trim() || undefined,
      });
      Alert.alert('Success', 'Stock adjusted successfully');
      navigation.goBack();
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to adjust stock');
    } finally { setLoading(false); }
  };

  return (
    <DismissKeyboard>
      <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">

          <Text style={styles.label}>Adjustment Type</Text>
          <View style={styles.typeRow}>
            {TYPES.map((t) => (
              <TouchableOpacity
                key={t.key}
                style={[styles.typeBtn, type === t.key && { backgroundColor: t.color, borderColor: t.color }]}
                onPress={() => setType(t.key)}
              >
                <Ionicons name={t.icon} size={16} color={type === t.key ? Colors.white : t.color} />
                <Text style={[styles.typeText, type === t.key && { color: Colors.white }]}>{t.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.label}>Material</Text>
          {errors.material && <Text style={styles.errorText}>{errors.material}</Text>}
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={styles.chipRow}>
              {materials.map((m) => (
                <TouchableOpacity key={m.id} style={[styles.chip, materialId === m.id && styles.chipActive]} onPress={() => setMaterialId(m.id)}>
                  <Text style={[styles.chipText, materialId === m.id && styles.chipTextActive]}>{m.name}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </ScrollView>

          <Text style={styles.label}>Location</Text>
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

          <Input label="Quantity" value={quantity} onChangeText={setQuantity} error={errors.quantity} keyboardType="numeric" placeholder="0" />
          <Input label="Notes (optional)" value={notes} onChangeText={setNotes} placeholder="Reason for adjustment" multiline />

          <View style={styles.actions}>
            <Button title="Submit Adjustment" onPress={handleSubmit} loading={loading} />
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
  errorText: { fontSize: FontSize.xs, color: Colors.error, marginBottom: Spacing.xs },
  typeRow: { flexDirection: 'row', gap: Spacing.sm },
  typeBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4,
    paddingVertical: Spacing.sm, borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  typeText: { fontSize: FontSize.xs, fontWeight: '500', color: Colors.text },
  chipRow: { flexDirection: 'row', gap: Spacing.sm, paddingBottom: 4 },
  chip: {
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs + 2, borderRadius: BorderRadius.full,
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '500' },
  chipTextActive: { color: Colors.white },
  actions: { marginTop: Spacing.xl },
});
