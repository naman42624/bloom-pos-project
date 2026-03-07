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

export default function MaterialFormScreen({ route, navigation }) {
  const existing = route.params?.material;
  const isEditing = !!existing;

  const [categories, setCategories] = useState([]);
  const [categoryId, setCategoryId] = useState(null);
  const [name, setName] = useState('');
  const [sku, setSku] = useState('');
  const [bundleSizeOverride, setBundleSizeOverride] = useState('');
  const [minStockAlert, setMinStockAlert] = useState('10');
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState({});

  useEffect(() => {
    fetchCategories();
    if (existing) {
      setCategoryId(existing.category_id);
      setName(existing.name || '');
      setSku(existing.sku || '');
      setBundleSizeOverride(existing.bundle_size_override ? String(existing.bundle_size_override) : '');
      setMinStockAlert(String(existing.min_stock_alert ?? 10));
    }
  }, [existing]);

  const fetchCategories = async () => {
    try {
      const res = await api.getCategories();
      setCategories(res.data || []);
      if (!existing && res.data?.length) setCategoryId(res.data[0].id);
    } catch (err) {
      // silently handle
    }
  };

  const validate = () => {
    const e = {};
    if (!name.trim()) e.name = 'Material name is required';
    if (!categoryId) e.category = 'Category is required';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) return;
    setLoading(true);
    try {
      const data = {
        category_id: categoryId,
        name: name.trim(),
        sku: sku.trim() || undefined,
        bundle_size_override: bundleSizeOverride ? parseInt(bundleSizeOverride) : undefined,
        min_stock_alert: parseInt(minStockAlert) || 10,
      };
      if (isEditing) {
        await api.updateMaterial(existing.id, data);
      } else {
        await api.createMaterial(data);
      }
      navigation.goBack();
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to save material');
    } finally {
      setLoading(false);
    }
  };

  return (
    <DismissKeyboard>
      <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
          <Text style={styles.label}>Category</Text>
          {errors.category && <Text style={styles.errorText}>{errors.category}</Text>}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipScroll}>
            <View style={styles.chipRow}>
              {categories.map((cat) => (
                <TouchableOpacity
                  key={cat.id}
                  style={[styles.chip, categoryId === cat.id && styles.chipActive]}
                  onPress={() => setCategoryId(cat.id)}
                >
                  <Text style={[styles.chipText, categoryId === cat.id && styles.chipTextActive]}>{cat.name}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </ScrollView>

          <Input label="Material Name" value={name} onChangeText={setName} error={errors.name} placeholder="e.g. Red Rose" />
          <Input label="SKU (optional)" value={sku} onChangeText={setSku} placeholder="Auto-generated if blank" />
          <Input label="Bundle Size Override (optional)" value={bundleSizeOverride} onChangeText={setBundleSizeOverride} keyboardType="number-pad" placeholder="Override category default" />
          <Input label="Min Stock Alert" value={minStockAlert} onChangeText={setMinStockAlert} keyboardType="number-pad" placeholder="10" />

          <View style={styles.actions}>
            <Button title={isEditing ? 'Update Material' : 'Create Material'} onPress={handleSubmit} loading={loading} />
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
  chipScroll: { maxHeight: 44 },
  chipRow: { flexDirection: 'row', gap: Spacing.sm },
  chip: {
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs + 2, borderRadius: BorderRadius.full,
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '500' },
  chipTextActive: { color: Colors.white },
  actions: { marginTop: Spacing.xl },
});
