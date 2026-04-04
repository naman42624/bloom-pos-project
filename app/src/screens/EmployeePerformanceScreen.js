import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, RefreshControl, ActivityIndicator, TouchableOpacity,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import api from '../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const PERIOD_OPTIONS = [
  { key: '7', label: '7 Days' },
  { key: '30', label: '30 Days' },
  { key: '90', label: '3 Months' },
];

function localDate(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function fmt(n) {
  const num = Number(n || 0);
  if (num >= 100000) return `₹${(num/100000).toFixed(1)}L`;
  if (num >= 1000) return `₹${(num/1000).toFixed(1)}K`;
  return `₹${Math.round(num)}`;
}

function formatHours(h) {
  const num = Number(h || 0);
  const hrs = Math.floor(num);
  const mins = Math.round((num - hrs) * 60);
  return mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`;
}

function BarIndicator({ value, max, color }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <View style={styles.barTrack}>
      <View style={[styles.barFill, { width: `${Math.max(pct, 2)}%`, backgroundColor: color }]} />
    </View>
  );
}

export default function EmployeePerformanceScreen() {
  const [days, setDays] = useState('30');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('sales'); // sales, production, attendance, delivery

  const fetchReport = useCallback(async () => {
    try {
      const from = localDate(-parseInt(days));
      const to = localDate();
      const res = await api.getEmployeePerformance({ from, to });
      setData(res.data);
    } catch (e) {
      console.error('Employee performance error:', e);
    } finally { setLoading(false); setRefreshing(false); }
  }, [days]);

  useFocusEffect(useCallback(() => { setLoading(true); fetchReport(); }, [fetchReport]));

  if (loading) return <View style={styles.center}><ActivityIndicator size="large" color={Colors.primary} /></View>;

  const TABS = [
    { key: 'sales', label: 'Sales', icon: 'cart' },
    { key: 'production', label: 'Production', icon: 'construct' },
    { key: 'attendance', label: 'Attendance', icon: 'time' },
    ...(data?.deliveryPerformance?.length > 0 ? [{ key: 'delivery', label: 'Delivery', icon: 'bicycle' }] : []),
  ];

  const salesData = (data?.salesPerformance || []).filter(s => s.total_sales > 0);
  const maxSalesRev = Math.max(...salesData.map(s => s.total_revenue || 0), 1);

  const prodData = (data?.productionPerformance || []).filter(p => p.items_produced > 0);
  const maxProdQty = Math.max(...prodData.map(p => p.total_qty || 0), 1);

  const attData = (data?.attendanceSummary || []).filter(a => a.days_present > 0);
  const maxHours = Math.max(...attData.map(a => a.total_hours || 0), 1);

  const delData = data?.deliveryPerformance || [];
  const maxDel = Math.max(...delData.map(d => d.total_deliveries || 0), 1);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchReport(); }} colors={[Colors.primary]} />}
    >
      {/* Period selector */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: Spacing.sm }} contentContainerStyle={{ gap: Spacing.sm }}>
        {PERIOD_OPTIONS.map(p => (
          <TouchableOpacity
            key={p.key}
            style={[styles.chip, days === p.key && styles.chipActive]}
            onPress={() => setDays(p.key)}
          >
            <Text style={[styles.chipText, days === p.key && styles.chipTextActive]}>{p.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Section tabs */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: Spacing.md }} contentContainerStyle={{ gap: Spacing.sm }}>
        {TABS.map(t => (
          <TouchableOpacity
            key={t.key}
            style={[styles.tabChip, tab === t.key && styles.tabChipActive]}
            onPress={() => setTab(t.key)}
          >
            <Ionicons name={t.icon} size={16} color={tab === t.key ? Colors.white : Colors.textSecondary} />
            <Text style={[styles.tabText, tab === t.key && styles.tabTextActive]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Sales Performance */}
      {tab === 'sales' && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Sales Performance</Text>
          {salesData.length === 0 && <Text style={styles.noData}>No sales data for this period</Text>}
          {salesData.map((emp, i) => (
            <View key={`sales-${emp.user_id}`} style={styles.empRow}>
              <View style={styles.empHeader}>
                <View style={[styles.avatar, { backgroundColor: Colors.primary + '20' }]}>
                  <Text style={styles.avatarText}>{emp.name?.[0]?.toUpperCase()}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.empName}>{emp.name}</Text>
                  <Text style={styles.empRole}>{emp.role}</Text>
                </View>
                <Text style={styles.empRevenue}>{fmt(emp.total_revenue)}</Text>
              </View>
              <BarIndicator value={emp.total_revenue} max={maxSalesRev} color={Colors.primary} />
              <View style={styles.empStats}>
                <Text style={styles.empStat}>{emp.total_sales} sales</Text>
                <Text style={styles.empStat}>Avg {fmt(emp.avg_sale)}</Text>
              </View>
            </View>
          ))}
        </View>
      )}

      {/* Production Performance */}
      {tab === 'production' && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Production Output</Text>
          {prodData.length === 0 && <Text style={styles.noData}>No production data for this period</Text>}
          {prodData.map((emp, i) => (
            <View key={`prod-${emp.user_id}`} style={styles.empRow}>
              <View style={styles.empHeader}>
                <View style={[styles.avatar, { backgroundColor: '#9C27B020' }]}>
                  <Text style={[styles.avatarText, { color: '#9C27B0' }]}>{emp.name?.[0]?.toUpperCase()}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.empName}>{emp.name}</Text>
                </View>
                <Text style={styles.empRevenue}>{emp.total_qty} units</Text>
              </View>
              <BarIndicator value={emp.total_qty} max={maxProdQty} color="#9C27B0" />
              <View style={styles.empStats}>
                <Text style={styles.empStat}>{emp.items_produced} batches</Text>
              </View>
            </View>
          ))}
        </View>
      )}

      {/* Attendance */}
      {tab === 'attendance' && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Attendance Summary</Text>
          {attData.length === 0 && <Text style={styles.noData}>No attendance data for this period</Text>}
          {attData.map((emp, i) => (
            <View key={`att-${emp.user_id}`} style={styles.empRow}>
              <View style={styles.empHeader}>
                <View style={[styles.avatar, { backgroundColor: '#FF980020' }]}>
                  <Text style={[styles.avatarText, { color: '#FF9800' }]}>{emp.name?.[0]?.toUpperCase()}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.empName}>{emp.name}</Text>
                  <Text style={styles.empRole}>{emp.days_present} days present</Text>
                </View>
                <Text style={styles.empRevenue}>{formatHours(emp.total_hours)}</Text>
              </View>
              <BarIndicator value={emp.total_hours} max={maxHours} color="#FF9800" />
              {emp.late_days > 0 && (
                <View style={styles.empStats}>
                  <Text style={[styles.empStat, { color: Colors.error }]}>{emp.late_days} late day{emp.late_days !== 1 ? 's' : ''}</Text>
                </View>
              )}
            </View>
          ))}
        </View>
      )}

      {/* Delivery Performance */}
      {tab === 'delivery' && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Delivery Performance</Text>
          {delData.length === 0 && <Text style={styles.noData}>No delivery data</Text>}
          {delData.map((emp, i) => (
            <View key={`del-${emp.user_id}`} style={styles.empRow}>
              <View style={styles.empHeader}>
                <View style={[styles.avatar, { backgroundColor: '#00BCD420' }]}>
                  <Text style={[styles.avatarText, { color: '#00BCD4' }]}>{emp.name?.[0]?.toUpperCase()}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.empName}>{emp.name}</Text>
                </View>
                <Text style={styles.empRevenue}>{emp.total_deliveries}</Text>
              </View>
              <BarIndicator value={emp.total_deliveries} max={maxDel} color="#00BCD4" />
              <View style={styles.empStats}>
                <Text style={[styles.empStat, { color: '#4CAF50' }]}>{emp.completed} done</Text>
                {emp.failed > 0 && <Text style={[styles.empStat, { color: Colors.error }]}>{emp.failed} failed</Text>}
                {emp.avg_delivery_minutes > 0 && <Text style={styles.empStat}>~{Math.round(emp.avg_delivery_minutes)}min avg</Text>}
              </View>
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

  tabChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.md, backgroundColor: Colors.surface,
    borderWidth: 1, borderColor: Colors.border,
  },
  tabChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  tabText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '500' },
  tabTextActive: { color: Colors.white },

  section: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg,
    padding: Spacing.md, marginBottom: Spacing.md,
    shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 4, elevation: 1,
  },
  sectionTitle: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text, marginBottom: Spacing.sm },

  empRow: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: Colors.border },
  empHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  avatar: {
    width: 36, height: 36, borderRadius: 18,
    justifyContent: 'center', alignItems: 'center', marginRight: 10,
  },
  avatarText: { fontSize: FontSize.md, fontWeight: '600', color: Colors.primary },
  empName: { fontSize: FontSize.sm, fontWeight: '500', color: Colors.text },
  empRole: { fontSize: FontSize.xs, color: Colors.textSecondary, textTransform: 'capitalize' },
  empRevenue: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  empStats: { flexDirection: 'row', gap: Spacing.md, marginTop: 6 },
  empStat: { fontSize: FontSize.xs, color: Colors.textSecondary },

  barTrack: { height: 6, backgroundColor: Colors.background, borderRadius: 3, overflow: 'hidden' },
  barFill: { height: 6, borderRadius: 3 },

  noData: { fontSize: FontSize.sm, color: Colors.textLight, textAlign: 'center', paddingVertical: Spacing.lg },
});
