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
  { key: '365', label: 'Year' },
];

function localDate(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function fmt(n) {
  if (Number(n) >= 100000) return `₹${(Number(n)/100000).toFixed(1)}L`;
  if (Number(n) >= 1000) return `₹${(Number(n)/1000).toFixed(1)}K`;
  return `₹${Math.round(n)}`;
}

export default function CustomerInsightsScreen() {
  const [days, setDays] = useState('30');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [data, setData] = useState(null);

  const fetchReport = useCallback(async () => {
    try {
      const from = localDate(-parseInt(days));
      const to = localDate();
      const res = await api.getCustomerInsights({ from, to });
      setData(res.data);
    } catch (e) {
      console.error('Customer insights error:', e);
    } finally { setLoading(false); setRefreshing(false); }
  }, [days]);

  useFocusEffect(useCallback(() => { setLoading(true); fetchReport(); }, [fetchReport]));

  if (loading) return <View style={styles.center}><ActivityIndicator size="large" color={Colors.primary} /></View>;

  const newCust = data?.newVsReturning?.find(r => r.type === 'new');
  const retCust = data?.newVsReturning?.find(r => r.type === 'returning');

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchReport(); }} colors={[Colors.primary]} />}
    >
      {/* Period selector */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: Spacing.md }} contentContainerStyle={{ gap: Spacing.sm }}>
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

      {/* New vs Returning */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>New vs Returning</Text>
        <View style={styles.splitRow}>
          <View style={[styles.splitCard, { borderLeftColor: '#4CAF50' }]}>
            <Text style={styles.splitLabel}>New</Text>
            <Text style={[styles.splitValue, { color: '#4CAF50' }]}>{newCust?.customers || 0}</Text>
            <Text style={styles.splitSub}>{fmt(newCust?.revenue || 0)}</Text>
          </View>
          <View style={[styles.splitCard, { borderLeftColor: '#2196F3' }]}>
            <Text style={styles.splitLabel}>Returning</Text>
            <Text style={[styles.splitValue, { color: '#2196F3' }]}>{retCust?.customers || 0}</Text>
            <Text style={styles.splitSub}>{fmt(retCust?.revenue || 0)}</Text>
          </View>
        </View>
      </View>

      {/* Order type mix */}
      {data?.orderTypes?.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Order Type Mix</Text>
          <View style={styles.splitRow}>
            {data.orderTypes.map(ot => (
              <View key={ot.order_type} style={[styles.splitCard, { borderLeftColor: Colors.primary }]}>
                <Text style={styles.splitLabel}>{ot.order_type.replace('_', ' ')}</Text>
                <Text style={styles.splitValue}>{ot.count}</Text>
                <Text style={styles.splitSub}>{fmt(ot.revenue)}</Text>
              </View>
            ))}
          </View>
        </View>
      )}

      {/* Top by revenue */}
      {data?.topByRevenue?.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Top Customers (by Revenue)</Text>
          {data.topByRevenue.map((c, i) => (
            <View key={`rev-${i}`} style={styles.custRow}>
              <View style={styles.rank}><Text style={styles.rankText}>#{i+1}</Text></View>
              <View style={{ flex: 1 }}>
                <Text style={styles.custName}>{c.customer_name}</Text>
                <Text style={styles.custSub}>{c.customer_phone} • {c.order_count} orders</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={styles.custAmount}>{fmt(c.total_spent)}</Text>
                <Text style={styles.custSub}>Avg {fmt(c.avg_order)}</Text>
              </View>
            </View>
          ))}
        </View>
      )}

      {/* Top by frequency */}
      {data?.topByFrequency?.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Most Frequent Customers</Text>
          {data.topByFrequency.map((c, i) => (
            <View key={`freq-${i}`} style={styles.custRow}>
              <View style={styles.rank}><Text style={styles.rankText}>#{i+1}</Text></View>
              <View style={{ flex: 1 }}>
                <Text style={styles.custName}>{c.customer_name}</Text>
                <Text style={styles.custSub}>{c.customer_phone}</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={styles.custAmount}>{c.order_count} orders</Text>
                <Text style={styles.custSub}>{fmt(c.total_spent)}</Text>
              </View>
            </View>
          ))}
        </View>
      )}

      {/* Credit balances */}
      {data?.creditBalances?.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Outstanding Credit</Text>
          <View style={[styles.totalBanner, { backgroundColor: Colors.error + '10' }]}>
            <Text style={{ fontSize: FontSize.sm, color: Colors.error, fontWeight: '500' }}>Total Outstanding</Text>
            <Text style={{ fontSize: FontSize.xl, color: Colors.error, fontWeight: '700' }}>{fmt(data.totalOutstanding || 0)}</Text>
          </View>
          {data.creditBalances.map((c, i) => (
            <View key={`credit-${i}`} style={styles.custRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.custName}>{c.name}</Text>
                <Text style={styles.custSub}>{c.phone}</Text>
              </View>
              <Text style={[styles.custAmount, { color: Colors.error }]}>{fmt(c.credit_balance)}</Text>
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

  section: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg,
    padding: Spacing.md, marginBottom: Spacing.md,
    shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 4, elevation: 1,
  },
  sectionTitle: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text, marginBottom: Spacing.sm },

  splitRow: { flexDirection: 'row', gap: Spacing.sm, flexWrap: 'wrap' },
  splitCard: {
    flex: 1, minWidth: '40%', backgroundColor: Colors.background, borderRadius: BorderRadius.md,
    padding: Spacing.md, borderLeftWidth: 4,
  },
  splitLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '500', textTransform: 'capitalize' },
  splitValue: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text, marginTop: 4 },
  splitSub: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },

  custRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  rank: {
    width: 28, height: 28, borderRadius: 14, backgroundColor: Colors.primary + '15',
    justifyContent: 'center', alignItems: 'center', marginRight: 10,
  },
  rankText: { fontSize: FontSize.xs, fontWeight: '700', color: Colors.primary },
  custName: { fontSize: FontSize.sm, fontWeight: '500', color: Colors.text },
  custSub: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },
  custAmount: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.text },

  totalBanner: {
    borderRadius: BorderRadius.md, padding: Spacing.md,
    alignItems: 'center', marginBottom: Spacing.sm,
  },
});
