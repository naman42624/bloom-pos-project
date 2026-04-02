import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  RefreshControl, ActivityIndicator, Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import api from '../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const { width: SCREEN_W } = Dimensions.get('window');
const CHART_W = SCREEN_W - Spacing.md * 4;

const PERIOD_OPTIONS = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This Week' },
  { key: 'month', label: 'This Month' },
  { key: 'quarter', label: '3 Months' },
];

function localDate(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function getDateRange(period) {
  const today = localDate();
  switch (period) {
    case 'today': return { from: today, to: today };
    case 'week': {
      const d = new Date(); d.setDate(d.getDate() - d.getDay());
      return { from: `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`, to: today };
    }
    case 'month': return { from: `${today.slice(0,8)}01`, to: today };
    case 'quarter': return { from: localDate(-90), to: today };
    default: return { from: today, to: today };
  }
}

function fmt(n) {
  const val = Number(n || 0);
  if (val >= 100000) return `₹${(val / 100000).toFixed(1)}L`;
  if (val >= 1000) return `₹${(val / 1000).toFixed(1)}K`;
  return `₹${Math.round(val)}`;
}

function BarChart({ data, labelKey, valueKey, color }) {
  if (!data || data.length === 0) return <Text style={styles.noData}>No data</Text>;
  const max = Math.max(...data.map(d => d[valueKey] || 0), 1);
  return (
    <View style={styles.chart}>
      {data.map((item, i) => {
        const pct = ((item[valueKey] || 0) / max) * 100;
        return (
          <View key={i} style={styles.barRow}>
            <Text style={styles.barLabel} numberOfLines={1}>{item[labelKey]}</Text>
            <View style={styles.barTrack}>
              <View style={[styles.barFill, { width: `${Math.max(pct, 2)}%`, backgroundColor: color }]} />
            </View>
            <Text style={styles.barValue}>{fmt(item[valueKey] || 0)}</Text>
          </View>
        );
      })}
    </View>
  );
}

export default function SalesReportScreen() {
  const [period, setPeriod] = useState('week');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [data, setData] = useState(null);

  const fetchReport = useCallback(async () => {
    try {
      const range = getDateRange(period);
      const groupBy = period === 'today' ? 'day' : period === 'quarter' ? 'month' : 'day';
      const res = await api.getSalesSummary({ ...range, group_by: groupBy });
      setData(res.data);
    } catch (e) {
      console.error('Sales report error:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [period]);

  useFocusEffect(useCallback(() => { setLoading(true); fetchReport(); }, [fetchReport]));

  if (loading) return <View style={styles.center}><ActivityIndicator size="large" color={Colors.primary} /></View>;

  const t = data?.totals || {};

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchReport(); }} colors={[Colors.primary]} />}
    >
      {/* Period selector */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.periodRow} contentContainerStyle={styles.periodContent}>
        {PERIOD_OPTIONS.map(p => (
          <TouchableOpacity
            key={p.key}
            style={[styles.periodChip, period === p.key && styles.periodChipActive]}
            onPress={() => setPeriod(p.key)}
          >
            <Text style={[styles.periodText, period === p.key && styles.periodTextActive]}>{p.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* KPI Cards */}
      <View style={styles.kpiRow}>
        <View style={[styles.kpiCard, { borderLeftColor: Colors.primary }]}>
          <Text style={styles.kpiLabel}>Revenue</Text>
          <Text style={[styles.kpiValue, { color: Colors.primary }]}>{fmt(t.total_revenue || 0)}</Text>
        </View>
        <View style={[styles.kpiCard, { borderLeftColor: '#4CAF50' }]}>
          <Text style={styles.kpiLabel}>Net</Text>
          <Text style={[styles.kpiValue, { color: '#4CAF50' }]}>{fmt(t.net_revenue || 0)}</Text>
        </View>
      </View>
      <View style={styles.kpiRow}>
        <View style={[styles.kpiCard, { borderLeftColor: '#2196F3' }]}>
          <Text style={styles.kpiLabel}>Orders</Text>
          <Text style={[styles.kpiValue, { color: '#2196F3' }]}>{t.total_orders || 0}</Text>
        </View>
        <View style={[styles.kpiCard, { borderLeftColor: '#FF9800' }]}>
          <Text style={styles.kpiLabel}>Avg Order</Text>
          <Text style={[styles.kpiValue, { color: '#FF9800' }]}>{fmt(t.avg_order_value || 0)}</Text>
        </View>
      </View>

      {/* Order breakdown */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Order Types</Text>
        <View style={styles.statRow}>
          <View style={styles.stat}><Text style={styles.statNum}>{t.walk_in_count || 0}</Text><Text style={styles.statLabel}>Walk-in</Text></View>
          <View style={styles.stat}><Text style={styles.statNum}>{t.pickup_count || 0}</Text><Text style={styles.statLabel}>Pickup</Text></View>
          <View style={styles.stat}><Text style={styles.statNum}>{t.delivery_count || 0}</Text><Text style={styles.statLabel}>Delivery</Text></View>
        </View>
      </View>

      {/* Payment status */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Payment Status</Text>
        <View style={styles.statRow}>
          <View style={styles.stat}><Text style={[styles.statNum, { color: '#4CAF50' }]}>{t.paid_count || 0}</Text><Text style={styles.statLabel}>Paid</Text></View>
          <View style={styles.stat}><Text style={[styles.statNum, { color: '#FF9800' }]}>{t.partial_count || 0}</Text><Text style={styles.statLabel}>Partial</Text></View>
          <View style={styles.stat}><Text style={[styles.statNum, { color: Colors.error }]}>{t.pending_count || 0}</Text><Text style={styles.statLabel}>Pending</Text></View>
        </View>
      </View>

      {/* Financials */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Financials</Text>
        <View style={styles.finRow}><Text style={styles.finLabel}>Subtotal</Text><Text style={styles.finValue}>{fmt(t.total_subtotal || 0)}</Text></View>
        <View style={styles.finRow}><Text style={styles.finLabel}>Tax</Text><Text style={styles.finValue}>{fmt(t.total_tax || 0)}</Text></View>
        <View style={styles.finRow}><Text style={styles.finLabel}>Discounts</Text><Text style={[styles.finValue, { color: Colors.error }]}>-{fmt(t.total_discounts || 0)}</Text></View>
        <View style={styles.finRow}><Text style={styles.finLabel}>Delivery Charges</Text><Text style={styles.finValue}>{fmt(t.total_delivery_charges || 0)}</Text></View>
        <View style={styles.finRow}><Text style={styles.finLabel}>Refunds</Text><Text style={[styles.finValue, { color: Colors.error }]}>-{fmt(t.refund_total || 0)}</Text></View>
        <View style={styles.finRow}><Text style={styles.finLabel}>Expenses</Text><Text style={[styles.finValue, { color: Colors.error }]}>-{fmt(t.total_expenses || 0)}</Text></View>
        <View style={[styles.finRow, styles.finTotal]}><Text style={[styles.finLabel, { fontWeight: '700' }]}>Net Revenue</Text><Text style={[styles.finValue, { fontWeight: '700', color: '#4CAF50' }]}>{fmt(t.net_revenue || 0)}</Text></View>
      </View>

      {/* Revenue trend */}
      {data?.breakdown?.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Revenue Trend</Text>
          <BarChart data={data.breakdown} labelKey="period" valueKey="revenue" color={Colors.primary} />
        </View>
      )}

      {/* Payment methods */}
      {data?.paymentMethods?.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Payment Methods</Text>
          <BarChart data={data.paymentMethods} labelKey="method" valueKey="total" color="#2196F3" />
        </View>
      )}

      {/* Top products */}
      {data?.topProducts?.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Top Products</Text>
          <BarChart data={data.topProducts} labelKey="product_name" valueKey="total_revenue" color="#FF9800" />
        </View>
      )}

      {/* By location */}
      {data?.byLocation?.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>By Location</Text>
          <BarChart data={data.byLocation} labelKey="location_name" valueKey="revenue" color="#4CAF50" />
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

  periodRow: { marginBottom: Spacing.md },
  periodContent: { gap: Spacing.sm },
  periodChip: {
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.full, backgroundColor: Colors.surface,
    borderWidth: 1, borderColor: Colors.border,
  },
  periodChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  periodText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '500' },
  periodTextActive: { color: Colors.white },

  kpiRow: { flexDirection: 'row', gap: Spacing.sm, marginBottom: Spacing.sm },
  kpiCard: {
    flex: 1, backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    padding: Spacing.md, borderLeftWidth: 4,
    shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 4, elevation: 1,
  },
  kpiLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '500' },
  kpiValue: { fontSize: FontSize.xl, fontWeight: '700', marginTop: 4 },

  section: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg,
    padding: Spacing.md, marginTop: Spacing.md,
    shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 4, elevation: 1,
  },
  sectionTitle: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text, marginBottom: Spacing.sm },

  statRow: { flexDirection: 'row', justifyContent: 'space-around' },
  stat: { alignItems: 'center' },
  statNum: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text },
  statLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },

  finRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: Colors.border },
  finLabel: { fontSize: FontSize.sm, color: Colors.textSecondary },
  finValue: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  finTotal: { borderBottomWidth: 0, paddingTop: Spacing.sm, borderTopWidth: 2, borderTopColor: Colors.text, marginTop: 4 },

  chart: { marginTop: Spacing.xs },
  barRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  barLabel: { width: 80, fontSize: FontSize.xs, color: Colors.textSecondary, marginRight: 8 },
  barTrack: { flex: 1, height: 18, backgroundColor: Colors.background, borderRadius: 9, overflow: 'hidden' },
  barFill: { height: 18, borderRadius: 9 },
  barValue: { width: 60, fontSize: FontSize.xs, fontWeight: '600', color: Colors.text, textAlign: 'right', marginLeft: 8 },
  noData: { fontSize: FontSize.sm, color: Colors.textLight, textAlign: 'center', paddingVertical: Spacing.md },
});
