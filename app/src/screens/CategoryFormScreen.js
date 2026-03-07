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

const STORAGE_OPTIONS = ['shop', 'warehouse'];

export default function CategoryFormScreen({ route, navigation }) {
  const existing = route.params?.category;
  const isEditing = !!existing;

  const [name, setName] = useState('');
  const [unit, setUnit] = useState('pieces');
  const [hasBundle, setHasBundle] = useState(false);
  const [bundleSize, setBundleSize] = useState('20');
  const [isPerishable, setIsPerishable] = useState(false);
  const [defaultStorage, setDefaultStorage] = useState('shop');
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (existing) {
      setName(existing.name || '');
      setUnit(existing.unit || 'pieces');
      setHasBundle(!!existing.has_bundle);
      setBundleSize(String(existing.default_bundle_size || 20));
      setIsPerishable(!!existing.is_perishable);
      setDefaultStorage(existing.default_storage || 'shop');
    }
  }, [existing]);

  const validate = () => {
    const e = {};
    if (!name.trim()) e.name = 'Category name is required';
    if (!unit.trim()) e.unit = 'Unit is required';
    if (hasBundle && (!bundleSize || parseInt(bundleSize) < 1)) e.bundleSize = 'Bundle size must be ≥ 1';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) return;
    setLoading(true);
    try {
      const data = {
        name: name.trim(),
        unit: unit.trim(),
        has_bundle: hasBundle ? 1 : 0,
        default_bundle_size: hasBundle ? parseInt(bundleSize) : 1,
        is_perishable: isPerishable ? 1 : 0,
        default_storage: defaultStorage,
      };
      if (isEditing) {
        await api.updateCategory(existing.id, data);
      } else {
        await api.createCategory(data);
      }
      navigation.goBack();
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to save category');
    } finally {
      setLoading(false);
    }
  };

  return (
    <DismissKeyboard>
      <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
          <Input label="Category Name" value={name} onChangeText={setName} error={errors.name} placeholder="e.g. Flowers" />
          <Input label="Unit" value={unit} onChangeText={setUnit} error={errors.unit} placeholder="e.g. stems, pieces, blocks" />

          <Text style={styles.label}>Default Storage</Text>
          <View style={styles.toggleRow}>
            {STORAGE_OPTIONS.map((opt) => (
              <TouchableOpacity
                key={opt}
                style={[styles.toggleBtn, defaultStorage === opt && styles.toggleActive]}
                onPress={() => setDefaultStorage(opt)}
              >
                <Ionicons name={opt === 'shop' ? 'storefront' : 'cube'} size={16} color={defaultStorage === opt ? Colors.white : Colors.text} />
                <Text style={[styles.toggleText, defaultStorage === opt && styles.toggleTextActive]}>
                  {opt.charAt(0).toUpperCase() + opt.slice(1)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <TouchableOpacity style={styles.checkRow} onPress={() => setIsPerishable(!isPerishable)}>
            <Ionicons name={isPerishable ? 'checkbox' : 'square-outline'} size={22} color={Colors.primary} />
            <Text style={styles.checkLabel}>Perishable item</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.checkRow} onPress={() => setHasBundle(!hasBundle)}>
            <Ionicons name={hasBundle ? 'checkbox' : 'square-outline'} size={22} color={Colors.primary} />
            <Text style={styles.checkLabel}>Sold/bought in bundles</Text>
          </TouchableOpacity>

          {hasBundle && (
            <Input
              label="Default Bundle Size"
              value={bundleSize}
              onChangeText={setBundleSize}
              error={errors.bundleSize}
              keyboardType="number-pad"
              placeholder="e.g. 20"
            />
          )}

          <View style={styles.actions}>
            <Button title={isEditing ? 'Update Category' : 'Create Category'} onPress={handleSubmit} loading={loading} />
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
  toggleRow: { flexDirection: 'row', gap: Spacing.sm },
  toggleBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: Spacing.sm, borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  toggleActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  toggleText: { fontSize: FontSize.sm, color: Colors.text, fontWeight: '500' },
  toggleTextActive: { color: Colors.white },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginTop: Spacing.md, paddingVertical: Spacing.xs },
  checkLabel: { fontSize: FontSize.md, color: Colors.text },
  actions: { marginTop: Spacing.xl },
});
