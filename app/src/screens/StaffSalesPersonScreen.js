import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, RefreshControl } from 'react-native';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Colors, Spacing, FontSize, BorderRadius, TouchTarget } from '../constants/theme';
import { money } from '../utils/staffSalesFormat';

export default function StaffSalesPersonScreen({ route, navigation }) {
  const { userId, from, to, locationId } = route.params;
  const { user } = useAuth();
  const reqId = useRef(0);
  const [sales, setSales] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);

  const load = useCallback(async (isRefresh) => {
    const id = ++reqId.current;
    if (isRefresh) setRefreshing(true); else setLoading(true);
    setError(false);
    try {
      const params = { from, to };
      if (locationId) params.location_id = locationId;
      const res = await api.getStaffSalesFor(userId, params);
      if (id !== reqId.current) return;
      setSales(res.data || []);
    } catch (e) {
      if (id === reqId.current) setError(true);
    } finally {
      if (id === reqId.current) { setLoading(false); setRefreshing(false); }
    }
  }, [userId, from, to, locationId]);

  useEffect(() => { load(false); }, [load]);

  const fmt = (v) => {
    const d = new Date(v);
    if (isNaN(d)) return '';
    return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  };

  if (user?.role !== 'owner') return null;
  if (loading) return <ActivityIndicator size="large" color={Colors.primary} style={{ marginTop: Spacing.xl }} />;

  return (
    <FlatList
      style={styles.container}
      contentContainerStyle={styles.content}
      data={error ? [] : sales}
      keyExtractor={(s) => String(s.id)}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} />}
      ListHeaderComponent={<Text style={styles.range}>{from === to ? from : `${from} to ${to}`}</Text>}
      ListEmptyComponent={
        error ? (
          <View style={styles.center}>
            <Text style={styles.message}>Could not load staff sales. Pull down to try again.</Text>
            <TouchableOpacity style={styles.retry} onPress={() => load(false)} accessibilityRole="button">
              <Text style={styles.retryText}>Try again</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <Text style={styles.message}>No sales in this period.</Text>
        )
      }
      renderItem={({ item }) => (
        <TouchableOpacity
          style={styles.row}
          activeOpacity={0.7}
          accessibilityRole="button"
          onPress={() => navigation.navigate('SaleDetail', { saleId: item.id })}
        >
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>{item.customer_name || 'Walk-in'}</Text>
            <Text style={styles.sub}>{item.sale_number} · {fmt(item.created_at)}</Text>
          </View>
          <Text style={styles.amount}>{money(item.grand_total)}</Text>
        </TouchableOpacity>
      )}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.md, width: '100%', maxWidth: 800, alignSelf: 'center' },
  range: { fontSize: FontSize.md, color: Colors.textSecondary, marginBottom: Spacing.md },
  center: { alignItems: 'center' },
  message: { fontSize: FontSize.md, color: Colors.textSecondary, textAlign: 'center', marginTop: Spacing.lg },
  retry: {
    minHeight: TouchTarget.minHeight, paddingHorizontal: Spacing.lg, justifyContent: 'center',
    backgroundColor: Colors.primary, borderRadius: BorderRadius.lg, marginTop: Spacing.md,
  },
  retryText: { color: '#fff', fontSize: FontSize.md, fontWeight: '700' },
  row: {
    flexDirection: 'row', alignItems: 'center', minHeight: TouchTarget.minHeight + 16,
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg, padding: Spacing.md,
    marginBottom: Spacing.sm, borderWidth: 1, borderColor: Colors.border,
  },
  title: { fontSize: FontSize.lg, fontWeight: '600', color: Colors.text },
  sub: { fontSize: FontSize.md, color: Colors.textSecondary, marginTop: 2 },
  amount: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, marginLeft: Spacing.md },
});
