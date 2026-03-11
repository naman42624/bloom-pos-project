import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, RefreshControl, ActivityIndicator, TouchableOpacity,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import api from '../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

function Badge({ label, value, color }) {
  return (
    <View style={[styles.badge, { borderLeftColor: color }]}>
      <Text style={styles.badgeLabel}>{label}</Text>
      <Text style={[styles.badgeValue, { color }]}>{value}</Text>
    </View>
  );
}

export default function InventoryReportScreen() {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('overview'); // overview, lowStock, wastage, products

  const fetchReport = useCallback(async () => {
    try {
      const res = await api.getInventoryReport();
      setData(res.data);
    } catch (e) {
      console.error('Inventory report error:', e);
    } finally { setLoading(false); setRefreshing(false); }
  }, []);

  useFocusEffect(useCallback(() => { fetchReport(); }, [fetchReport]));

  if (loading) return <View style={styles.center}><ActivityIndicator size="large" color={Colors.primary} /></View>;

  const TABS = [
    { key: 'overview', label: 'Overview' },
    { key: 'lowStock', label: `Low Stock (${data?.totalLowStock || 0})` },
    { key: 'wastage', label: 'Wastage' },
    { key: 'products', label: 'Products' },
  ];

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchReport(); }} colors={[Colors.primary]} />}
    >
      {/* Tab selector */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: Spacing.md }} contentContainerStyle={{ gap: Spacing.sm }}>
        {TABS.map(t => (
          <TouchableOpacity
            key={t.key}
            style={[styles.chip, tab === t.key && styles.chipActive]}
            onPress={() => setTab(t.key)}
          >
            <Text style={[styles.chipText, tab === t.key && styles.chipTextActive]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* KPI */}
      <View style={styles.kpiRow}>
        <Badge label="Materials" value={data?.totalMaterials || 0} color="#2196F3" />
        <Badge label="Low Stock" value={data?.totalLowStock || 0} color={Colors.error} />
      </View>

      {tab === 'overview' && data?.stockLevels && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Material Stock Levels</Text>
          {data.stockLevels.map((s, i) => (
            <View key={`${s.id}-${s.location_name}-${i}`} style={styles.stockRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.stockName}>{s.name}</Text>
                <Text style={styles.stockLoc}>{s.location_name || 'All'}</Text>
              </View>
              <Text style={[
                styles.stockQty,
                s.total_stock <= (s.reorder_level || 0) && s.reorder_level > 0 && { color: Colors.error },
              ]}>
                {s.location_stock != null ? s.location_stock : s.total_stock} {s.unit}
              </Text>
            </View>
          ))}
        </View>
      )}

      {tab === 'lowStock' && data?.lowStock && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Low Stock Alerts</Text>
          {data.lowStock.length === 0 && <Text style={styles.noData}>All materials are well-stocked</Text>}
          {data.lowStock.map((s, i) => {
            const pct = s.reorder_level > 0 ? Math.min((s.total_stock / s.reorder_level) * 100, 100) : 100;
            return (
              <View key={`low-${s.id}`} style={styles.lowRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.stockName}>{s.name}</Text>
                  <View style={styles.barTrack}>
                    <View style={[styles.barFill, { width: `${Math.max(pct, 2)}%`, backgroundColor: pct < 30 ? Colors.error : pct < 70 ? '#FF9800' : '#4CAF50' }]} />
                  </View>
                </View>
                <View style={{ alignItems: 'flex-end', marginLeft: 12 }}>
                  <Text style={[styles.stockQty, { color: Colors.error }]}>{s.total_stock} {s.unit}</Text>
                  <Text style={styles.stockLoc}>Min: {s.reorder_level}</Text>
                </View>
              </View>
            );
          })}
        </View>
      )}

      {tab === 'wastage' && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Wastage (Last 30 Days)</Text>
          {(!data?.wastageSummary || data.wastageSummary.length === 0) && <Text style={styles.noData}>No wastage recorded</Text>}
          {data?.wastageSummary?.map((w, i) => (
            <View key={`waste-${i}`} style={styles.stockRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.stockName}>{w.material_name}</Text>
                <Text style={styles.stockLoc}>{w.incidents} incident{w.incidents !== 1 ? 's' : ''}</Text>
              </View>
              <Text style={[styles.stockQty, { color: Colors.error }]}>-{w.wasted_qty} {w.unit}</Text>
            </View>
          ))}
        </View>
      )}

      {tab === 'products' && data?.productStock && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Product Stock</Text>
          {data.productStock.map((p, i) => (
            <View key={`prod-${p.id}`} style={styles.stockRow}>
              <Text style={[styles.stockName, { flex: 1 }]}>{p.name}</Text>
              <Text style={styles.stockQty}>{p.total_stock}</Text>
            </View>
          ))}
        </View>
      )}

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.md },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  chip: {
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.full, backgroundColor: Colors.surface,
    borderWidth: 1, borderColor: Colors.border,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '500' },
  chipTextActive: { color: Colors.white },

  kpiRow: { flexDirection: 'row', gap: Spacing.sm, marginBottom: Spacing.md },
  badge: {
    flex: 1, backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    padding: Spacing.md, borderLeftWidth: 4,
    shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 4, elevation: 1,
  },
  badgeLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '500' },
  badgeValue: { fontSize: FontSize.xl, fontWeight: '700', marginTop: 4 },

  section: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg,
    padding: Spacing.md, marginBottom: Spacing.md,
    shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 4, elevation: 1,
  },
  sectionTitle: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text, marginBottom: Spacing.sm },

  stockRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  stockName: { fontSize: FontSize.sm, fontWeight: '500', color: Colors.text },
  stockLoc: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },
  stockQty: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },

  lowRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  barTrack: { height: 6, backgroundColor: Colors.background, borderRadius: 3, overflow: 'hidden', marginTop: 6 },
  barFill: { height: 6, borderRadius: 3 },

  noData: { fontSize: FontSize.sm, color: Colors.textLight, textAlign: 'center', paddingVertical: Spacing.lg },
});
