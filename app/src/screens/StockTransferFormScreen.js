import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, KeyboardAvoidingView, Platform,
  ScrollView, Alert, TouchableOpacity,
} from 'react-native';
import api from '../services/api';
import Input from '../components/Input';
import Button from '../components/Button';
import DismissKeyboard from '../components/DismissKeyboard';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

export default function StockTransferFormScreen({ navigation }) {
  const [materials, setMaterials] = useState([]);
  const [locations, setLocations] = useState([]);
  const [materialId, setMaterialId] = useState(null);
  const [fromLocationId, setFromLocationId] = useState(null);
  const [toLocationId, setToLocationId] = useState(null);
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

  const validate = () => {
    const e = {};
    if (!materialId) e.material = 'Select a material';
    if (!fromLocationId) e.from = 'Select source location';
    if (!toLocationId) e.to = 'Select destination location';
    if (fromLocationId && toLocationId && fromLocationId === toLocationId) e.to = 'Must be different from source';
    if (!quantity || parseFloat(quantity) <= 0) e.quantity = 'Enter a valid quantity';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) return;
    setLoading(true);
    try {
      await api.createStockTransfer({
        material_id: materialId,
        from_location_id: fromLocationId,
        to_location_id: toLocationId,
        quantity: parseFloat(quantity),
        notes: notes.trim() || undefined,
      });
      Alert.alert('Success', 'Transfer initiated');
      navigation.goBack();
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to create transfer');
    } finally { setLoading(false); }
  };

  return (
    <DismissKeyboard>
      <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">

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

          <Text style={styles.label}>From Location</Text>
          {errors.from && <Text style={styles.errorText}>{errors.from}</Text>}
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={styles.chipRow}>
              {locations.map((l) => (
                <TouchableOpacity key={l.id} style={[styles.chip, fromLocationId === l.id && styles.chipActive]} onPress={() => setFromLocationId(l.id)}>
                  <Text style={[styles.chipText, fromLocationId === l.id && styles.chipTextActive]}>{l.name}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </ScrollView>

          <Text style={styles.label}>To Location</Text>
          {errors.to && <Text style={styles.errorText}>{errors.to}</Text>}
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={styles.chipRow}>
              {locations.filter((l) => l.id !== fromLocationId).map((l) => (
                <TouchableOpacity key={l.id} style={[styles.chip, toLocationId === l.id && styles.chipActive]} onPress={() => setToLocationId(l.id)}>
                  <Text style={[styles.chipText, toLocationId === l.id && styles.chipTextActive]}>{l.name}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </ScrollView>

          <Input label="Quantity" value={quantity} onChangeText={setQuantity} error={errors.quantity} keyboardType="numeric" placeholder="0" />
          <Input label="Notes (optional)" value={notes} onChangeText={setNotes} placeholder="Transfer notes" multiline />

          <View style={styles.actions}>
            <Button title="Initiate Transfer" onPress={handleSubmit} loading={loading} />
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
