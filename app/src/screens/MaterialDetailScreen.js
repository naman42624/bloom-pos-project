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

export default function MaterialDetailScreen({ route, navigation }) {
  const { user } = useAuth();
  const { materialId } = route.params;
  const [material, setMaterial] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const res = await api.getMaterial(materialId);
      setMaterial(res.data);
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to load material');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [materialId]);

  useFocusEffect(useCallback(() => { fetchData(); }, [fetchData]));

  if (!material && !loading) {
    return <View style={styles.container}><Text style={styles.errorText}>Material not found</Text></View>;
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchData(); }} colors={[Colors.primary]} />}
    >
      {material && (
        <>
          <View style={styles.header}>
            <View style={[styles.iconBox, { backgroundColor: Colors.secondary + '15' }]}>
              <Ionicons name="flower" size={32} color={Colors.secondary} />
            </View>
            <Text style={styles.name}>{material.name}</Text>
            <Text style={styles.sku}>SKU: {material.sku}</Text>
            <View style={styles.metaRow}>
              <View style={styles.metaItem}>
                <Text style={styles.metaLabel}>Category</Text>
                <Text style={styles.metaValue}>{material.category_name}</Text>
              </View>
              <View style={styles.metaItem}>
                <Text style={styles.metaLabel}>Unit</Text>
                <Text style={styles.metaValue}>{material.category_unit}</Text>
              </View>
              <View style={styles.metaItem}>
                <Text style={styles.metaLabel}>Min Alert</Text>
                <Text style={styles.metaValue}>{material.min_stock_alert}</Text>
              </View>
            </View>
            {(user?.role === 'owner' || user?.role === 'manager') && (
              <TouchableOpacity
                style={styles.editBtn}
                onPress={() => navigation.navigate('MaterialForm', { material })}
              >
                <Ionicons name="pencil" size={16} color={Colors.primary} />
                <Text style={styles.editText}>Edit Material</Text>
              </TouchableOpacity>
            )}
          </View>

          {/* Stock by location */}
          <Text style={styles.sectionTitle}>Stock by Location</Text>
          {(material.stock || []).length === 0 ? (
            <View style={styles.emptySection}><Text style={styles.emptyText}>No stock recorded</Text></View>
          ) : (
            material.stock.map((s) => (
              <View key={s.id} style={styles.stockCard}>
                <View style={styles.stockInfo}>
                  <Text style={styles.stockLocation}>{s.location_name}</Text>
                  <Text style={styles.stockDate}>
                    {s.last_counted_at ? `Counted: ${new Date(s.last_counted_at).toLocaleDateString()}` : 'Never counted'}
                  </Text>
                </View>
                <Text style={[styles.stockQty, { color: s.quantity < material.min_stock_alert ? Colors.error : Colors.success }]}>
                  {s.quantity} {material.category_unit}
                </Text>
              </View>
            ))
          )}

          {/* Suppliers */}
          <Text style={styles.sectionTitle}>Suppliers</Text>
          {(material.suppliers || []).length === 0 ? (
            <View style={styles.emptySection}><Text style={styles.emptyText}>No suppliers linked</Text></View>
          ) : (
            material.suppliers.map((s) => (
              <View key={s.id} style={styles.supplierCard}>
                <View style={styles.supplierInfo}>
                  <Text style={styles.supplierName}>{s.name}</Text>
                  <Text style={styles.supplierPhone}>{s.phone}</Text>
                </View>
                <Text style={styles.supplierPrice}>₹{s.default_price_per_unit}/{material.category_unit}</Text>
              </View>
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
  sku: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', marginTop: Spacing.md, gap: Spacing.lg },
  metaItem: { alignItems: 'center' },
  metaLabel: { fontSize: FontSize.xs, color: Colors.textLight },
  metaValue: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text, marginTop: 2 },
  editBtn: { flexDirection: 'row', alignItems: 'center', marginTop: Spacing.md, gap: 4 },
  editText: { color: Colors.primary, fontWeight: '600', fontSize: FontSize.sm },
  sectionTitle: { fontSize: FontSize.lg, fontWeight: '600', color: Colors.text, marginBottom: Spacing.sm, marginTop: Spacing.md },
  emptySection: { padding: Spacing.lg, alignItems: 'center' },
  emptyText: { color: Colors.textLight },
  stockCard: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md, padding: Spacing.md,
    marginBottom: Spacing.sm, flexDirection: 'row', alignItems: 'center',
  },
  stockInfo: { flex: 1 },
  stockLocation: { fontSize: FontSize.md, fontWeight: '500', color: Colors.text },
  stockDate: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },
  stockQty: { fontSize: FontSize.lg, fontWeight: '700' },
  supplierCard: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md, padding: Spacing.md,
    marginBottom: Spacing.sm, flexDirection: 'row', alignItems: 'center',
  },
  supplierInfo: { flex: 1 },
  supplierName: { fontSize: FontSize.md, fontWeight: '500', color: Colors.text },
  supplierPhone: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },
  supplierPrice: { fontSize: FontSize.md, fontWeight: '600', color: Colors.primary },
});
