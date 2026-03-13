import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  RefreshControl, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';
import { Platform } from 'react-native';

export default function CategoryDetailScreen({ route, navigation }) {
  const { user } = useAuth();
  const { categoryId } = route.params;
  const [category, setCategory] = useState(null);
  const [materials, setMaterials] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = useCallback(async () => {
      const confirmDelete = () => {
        const doDelete = async () => {
          try {
            await api.deleteCategory(categoryId);
            navigation.goBack();
          } catch (err) {
            Alert.alert('Error', err.message || 'Failed to delete category');
          }
        };
        if (Platform.OS === 'web') {
          if (window.confirm('Deactivate this category?')) doDelete();
        } else {
          Alert.alert('Confirm', 'Deactivate this category?', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Deactivate', style: 'destructive', onPress: doDelete },
          ]);
        }
      };
    try {
      const [catRes, matRes] = await Promise.all([
        api.getCategory(categoryId),
        api.getMaterials({ category_id: categoryId }),
      ]);
      setCategory(catRes.data);
      setMaterials(matRes.data || []);
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to load category');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [categoryId]);

  useFocusEffect(useCallback(() => { fetchData(); }, [fetchData]));

  if (!category && !loading) {
    return (
      <View style={styles.container}>
        <Text style={styles.errorText}>Category not found</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchData(); }} colors={[Colors.primary]} />}
    >
      {category && (
        <>
          <View style={styles.header}>
            <View style={[styles.iconBox, { backgroundColor: Colors.primary + '15' }]}>
              <Ionicons name="leaf" size={32} color={Colors.primary} />
            </View>
            <Text style={styles.name}>{category.name}</Text>
            <View style={styles.metaRow}>
              <View style={styles.metaItem}>
                <Text style={styles.metaLabel}>Unit</Text>
                <Text style={styles.metaValue}>{category.unit}</Text>
              </View>
              {category.has_bundle ? (
                <View style={styles.metaItem}>
                  <Text style={styles.metaLabel}>Bundle Size</Text>
                  <Text style={styles.metaValue}>{category.default_bundle_size}</Text>
                </View>
              ) : null}
              <View style={styles.metaItem}>
                <Text style={styles.metaLabel}>Storage</Text>
                <Text style={styles.metaValue}>{category.default_storage}</Text>
              </View>
              <View style={styles.metaItem}>
                <Text style={styles.metaLabel}>Materials</Text>
                <Text style={styles.metaValue}>{category.material_count}</Text>
              </View>
            </View>
            {(user?.role === 'owner' || user?.role === 'manager') && (
              <View style={styles.actionRow}>
                <TouchableOpacity
                  style={styles.editBtn}
                  onPress={() => navigation.navigate('CategoryForm', { category })}
                >
                  <Ionicons name="pencil" size={16} color={Colors.primary} />
                  <Text style={styles.editText}>Edit</Text>
                </TouchableOpacity>
                {user?.role === 'owner' && (
                  <TouchableOpacity style={styles.deleteBtn} onPress={confirmDelete}>
                    <Ionicons name="trash-outline" size={16} color={Colors.error} />
                    <Text style={styles.deleteText}>Delete</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}
          </View>

          <Text style={styles.sectionTitle}>Materials ({materials.length})</Text>
          {materials.length === 0 ? (
            <View style={styles.emptySection}>
              <Text style={styles.emptyText}>No materials in this category</Text>
            </View>
          ) : (
            materials.map((m) => (
              <TouchableOpacity
                key={m.id}
                style={styles.materialCard}
                onPress={() => navigation.navigate('MaterialDetail', { materialId: m.id })}
              >
                <View style={styles.matInfo}>
                  <Text style={styles.matName}>{m.name}</Text>
                  <Text style={styles.matSku}>SKU: {m.sku}</Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={Colors.textLight} />
              </TouchableOpacity>
            ))
          )}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.md, paddingBottom: 40 },
  errorText: { textAlign: 'center', marginTop: 40, color: Colors.textSecondary },
  header: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg, padding: Spacing.lg,
    alignItems: 'center', marginBottom: Spacing.lg,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 3, elevation: 2,
  },
  iconBox: { width: 64, height: 64, borderRadius: 32, justifyContent: 'center', alignItems: 'center', marginBottom: Spacing.sm },
  name: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', marginTop: Spacing.md, gap: Spacing.lg },
  metaItem: { alignItems: 'center' },
  metaLabel: { fontSize: FontSize.xs, color: Colors.textLight },
  metaValue: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text, marginTop: 2 },
  editBtn: { flexDirection: 'row', alignItems: 'center', marginTop: Spacing.md, gap: 4 },
  editText: { color: Colors.primary, fontWeight: '600', fontSize: FontSize.sm },
    actionRow: { flexDirection: 'row', alignItems: 'center', marginTop: Spacing.md, gap: Spacing.lg },
    deleteBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    deleteText: { color: Colors.error, fontWeight: '600', fontSize: FontSize.sm },
  sectionTitle: { fontSize: FontSize.lg, fontWeight: '600', color: Colors.text, marginBottom: Spacing.sm, marginTop: Spacing.sm },
  emptySection: { padding: Spacing.lg, alignItems: 'center' },
  emptyText: { color: Colors.textLight },
  materialCard: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md, padding: Spacing.md,
    marginBottom: Spacing.sm, flexDirection: 'row', alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.03, shadowRadius: 2, elevation: 1,
  },
  matInfo: { flex: 1 },
  matName: { fontSize: FontSize.md, fontWeight: '500', color: Colors.text },
  matSku: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },
});
