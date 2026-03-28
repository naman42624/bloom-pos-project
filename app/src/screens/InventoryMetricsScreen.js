import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  RefreshControl, ActivityIndicator, ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

function MetricCard({ title, value, subtitle, icon, color }) {
  return (
    <View style={[styles.metricCard, { borderLeftColor: color }]}>
      <View style={[styles.metricIcon, { backgroundColor: color + '15' }]}>
        <Ionicons name={icon} size={20} color={color} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.metricValue}>{value}</Text>
        <Text style={styles.metricTitle}>{title}</Text>
        {subtitle ? <Text style={styles.metricSub}>{subtitle}</Text> : null}
      </View>
    </View>
  );
}

export default function InventoryMetricsScreen({ navigation }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState('categories'); // categories | materials | locations

  const fetchMetrics = useCallback(async () => {
    try {
      const res = await api.getInventoryMetrics();
      if (res.success) setData(res.data);
    } catch (e) {
      console.log('Metrics error:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchMetrics(); }, [fetchMetrics]);

  const onRefresh = () => { setRefreshing(true); fetchMetrics(); };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={Colors.primary} />
        <Text style={styles.loadingText}>Loading inventory metrics...</Text>
      </View>
    );
  }

  if (!data) {
    return (
      <View style={styles.center}>
        <Ionicons name="alert-circle-outline" size={48} color={Colors.textLight} />
        <Text style={styles.loadingText}>No data available</Text>
      </View>
    );
  }

  const renderCategory = ({ item }) => (
    <View style={styles.listCard}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <View style={{ flex: 1 }}>
          <Text style={styles.listTitle}>{item.category_name}</Text>
          <Text style={styles.listSub}>
            {item.material_count} materials • {item.unit || 'units'}
          </Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={styles.listValue}>₹{item.total_value.toLocaleString()}</Text>
          <Text style={styles.listSub}>Stock: {item.total_stock}</Text>
        </View>
      </View>
      <View style={styles.listMeta}>
        <Text style={styles.listMetaText}>Avg Cost: ₹{item.avg_cost}</Text>
      </View>
    </View>
  );

  const renderMaterial = ({ item }) => (
    <View style={[styles.listCard, item.is_low && { borderLeftWidth: 3, borderLeftColor: Colors.error }]}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <View style={{ flex: 1 }}>
          <Text style={styles.listTitle}>{item.name}</Text>
          <Text style={styles.listSub}>{item.category_name} • {item.sku}</Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={styles.listValue}>₹{item.stock_value.toLocaleString()}</Text>
          <Text style={[styles.listSub, item.is_low && { color: Colors.error, fontWeight: '700' }]}>
            Stock: {item.stock_qty} {item.unit || ''}
            {item.is_low ? ' ⚠️' : ''}
          </Text>
        </View>
      </View>
      <View style={styles.listMeta}>
        <Text style={styles.listMetaText}>Avg Cost: ₹{item.avg_cost}</Text>
        {item.selling_price > 0 && (
          <Text style={styles.listMetaText}>Selling: ₹{item.selling_price}</Text>
        )}
      </View>
    </View>
  );

  const renderLocation = ({ item }) => (
    <View style={styles.listCard}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <View style={{ flex: 1 }}>
          <Text style={styles.listTitle}>{item.name}</Text>
          <Text style={styles.listSub}>{item.material_count} materials stocked</Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={styles.listValue}>{item.total_stock}</Text>
          <Text style={styles.listSub}>total units</Text>
        </View>
      </View>
    </View>
  );

  const TABS = [
    { key: 'categories', label: 'Categories', icon: 'layers' },
    { key: 'materials', label: 'Materials', icon: 'leaf' },
    { key: 'locations', label: 'Locations', icon: 'location' },
  ];

  const getListData = () => {
    if (activeTab === 'categories') return data.categories || [];
    if (activeTab === 'materials') return data.materials || [];
    return data.locations || [];
  };

  const getRenderItem = () => {
    if (activeTab === 'categories') return renderCategory;
    if (activeTab === 'materials') return renderMaterial;
    return renderLocation;
  };

  return (
    <View style={styles.container}>
      {/* Summary Cards */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.metricsRow}
      >
        <MetricCard
          title="Total Materials"
          value={data.total_materials}
          icon="leaf"
          color={Colors.success}
        />
        <MetricCard
          title="Stock Value"
          value={`₹${Math.round(data.total_stock_value).toLocaleString()}`}
          subtitle="Estimated total"
          icon="cash"
          color={Colors.primary}
        />
        <MetricCard
          title="Total Units"
          value={data.total_stock_units.toLocaleString()}
          icon="cube"
          color={Colors.info || '#2196F3'}
        />
        <MetricCard
          title="Low Stock"
          value={data.low_stock_count}
          subtitle="Below threshold"
          icon="warning"
          color={data.low_stock_count > 0 ? Colors.error : Colors.success}
        />
      </ScrollView>

      {/* Tabs */}
      <View style={styles.tabRow}>
        {TABS.map(t => (
          <TouchableOpacity
            key={t.key}
            style={[styles.tabBtn, activeTab === t.key && styles.tabBtnActive]}
            onPress={() => setActiveTab(t.key)}
          >
            <Ionicons name={t.icon} size={16} color={activeTab === t.key ? Colors.white : Colors.textSecondary} />
            <Text style={[styles.tabText, activeTab === t.key && styles.tabTextActive]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* List */}
      <FlatList
        data={getListData()}
        keyExtractor={(item, idx) => `${activeTab}-${item.id || idx}`}
        renderItem={getRenderItem()}
        contentContainerStyle={styles.listContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[Colors.primary]} />}
        ListEmptyComponent={
          <View style={styles.center}>
            <Text style={styles.loadingText}>No data</Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: Spacing.xl },
  loadingText: { color: Colors.textLight, marginTop: Spacing.sm, fontSize: FontSize.md },

  metricsRow: {
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.md, gap: Spacing.sm,
  },
  metricCard: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg,
    padding: Spacing.md, width: 160, borderLeftWidth: 4,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.04, shadowRadius: 6, elevation: 2,
  },
  metricIcon: {
    width: 36, height: 36, borderRadius: 18,
    justifyContent: 'center', alignItems: 'center', marginBottom: Spacing.sm,
  },
  metricValue: { fontSize: FontSize.xl, fontWeight: '800', color: Colors.text },
  metricTitle: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  metricSub: { fontSize: FontSize.xs, color: Colors.textLight, marginTop: 2 },

  tabRow: {
    flexDirection: 'row', paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    gap: Spacing.sm, backgroundColor: Colors.surface,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  tabBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: Spacing.sm, borderRadius: BorderRadius.full,
    backgroundColor: Colors.surfaceAlt || Colors.background,
  },
  tabBtnActive: { backgroundColor: Colors.primary },
  tabText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
  tabTextActive: { color: Colors.white, fontWeight: '700' },

  listContent: { padding: Spacing.md, paddingBottom: 40 },
  listCard: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg,
    padding: Spacing.md, marginBottom: Spacing.sm,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.03, shadowRadius: 4, elevation: 1,
  },
  listTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  listSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  listValue: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.primary },
  listMeta: {
    flexDirection: 'row', gap: Spacing.md, marginTop: Spacing.sm,
    paddingTop: Spacing.sm, borderTopWidth: 1, borderTopColor: Colors.border,
  },
  listMetaText: { fontSize: FontSize.xs, color: Colors.textLight },
});
