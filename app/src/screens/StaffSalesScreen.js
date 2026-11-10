import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, RefreshControl } from 'react-native';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import DateTimePickerModal from '../components/DateTimePickerModal';
import { Colors, Spacing, FontSize, BorderRadius, TouchTarget } from '../constants/theme';
import { money, dayStr, periodRange } from '../utils/staffSalesFormat';

const PERIODS = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'week', label: 'This week' },
  { key: 'month', label: 'This month' },
  { key: 'custom', label: 'Pick dates' },
];

const ROLE_LABEL = {
  owner: 'Owner', manager: 'Manager', employee: 'Staff', counter_staff: 'Counter staff',
  florist_staff: 'Florist', helper: 'Helper',
};

function Line({ label, value, bold }) {
  return (
    <View style={styles.line}>
      <Text style={styles.lineLabel}>{label}</Text>
      <Text style={[styles.lineValue, bold && styles.lineBold]}>{value}</Text>
    </View>
  );
}

// Handover difference: below 0 = short, above 0 = over
function shortOver(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  if (v < 0) return `Short ${money(-v)}`;
  if (v > 0) return `Over ${money(v)}`;
  return money(0);
}

export default function StaffSalesScreen({ navigation }) {
  const { user } = useAuth();
  const reqId = useRef(0);
  const [pickerValue, setPickerValue] = useState(() => new Date());
  const [period, setPeriod] = useState('today');
  const [custom, setCustom] = useState(null); // { from, to }
  const [picking, setPicking] = useState(null); // null | 'from' | 'to'
  const [pendingFrom, setPendingFrom] = useState(null);
  const [locations, setLocations] = useState([]);
  const [locationId, setLocationId] = useState(null);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);

  const range = useMemo(
    () => (period === 'custom' && custom ? custom : periodRange(period === 'custom' ? 'today' : period)),
    [period, custom]
  );

  useEffect(() => {
    api.getLocations().then(r => setLocations((r.data?.locations || []).filter(l => l.type === 'shop' && l.is_active))).catch(() => {});
  }, []);

  const load = useCallback(async (isRefresh) => {
    const id = ++reqId.current;
    if (isRefresh) setRefreshing(true); else setLoading(true);
    setError(false);
    try {
      const params = { from: range.from, to: range.to };
      if (locationId) params.location_id = locationId;
      const res = await api.getStaffSales(params);
      if (id !== reqId.current) return;
      setRows(res.data?.rows || []);
    } catch (e) {
      if (id === reqId.current) setError(true);
    } finally {
      if (id === reqId.current) { setLoading(false); setRefreshing(false); }
    }
  }, [range, locationId]);

  useEffect(() => { load(false); }, [load]);

  const onPeriod = (key) => {
    if (key === 'custom') { setPendingFrom(null); setPicking('from'); return; }
    setPeriod(key);
  };

  const onPicked = (d) => {
    if (picking === 'from') { setPendingFrom(d); setPicking('to'); return; }
    let a = pendingFrom, b = d;
    if (a && b < a) [a, b] = [b, a];
    setPicking(null);
    setCustom({ from: dayStr(a || b), to: dayStr(b) });
    setPeriod('custom');
  };

  const chip = (label, active, onPress, key) => (
    <TouchableOpacity
      key={key || label}
      style={[styles.chip, active && styles.chipActive]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );

  if (user?.role !== 'owner') return null;

  const rangeLabel = range.from === range.to ? range.from : `${range.from} to ${range.to}`;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} />}
    >
      <View style={styles.column}>
        <View style={styles.chipRow}>
          {PERIODS.map(p => chip(p.label, period === p.key, () => onPeriod(p.key), p.key))}
        </View>
        {locations.length > 1 && (
          <View style={styles.chipRow}>
            {chip('All locations', !locationId, () => setLocationId(null), 'all')}
            {locations.map(l => chip(l.name, locationId === l.id, () => setLocationId(l.id), `l${l.id}`))}
          </View>
        )}
        <Text style={styles.rangeText}>{rangeLabel}</Text>

        {loading ? (
          <ActivityIndicator size="large" color={Colors.primary} style={{ marginTop: Spacing.xl }} />
        ) : error ? (
          <View style={styles.center}>
            <Text style={styles.message}>Could not load staff sales. Pull down to try again.</Text>
            <TouchableOpacity style={styles.retry} onPress={() => load(false)} accessibilityRole="button">
              <Text style={styles.retryText}>Try again</Text>
            </TouchableOpacity>
          </View>
        ) : rows.length === 0 ? (
          <Text style={styles.message}>No sales in this period.</Text>
        ) : (
          rows.map(r => (
            <TouchableOpacity
              key={r.user_id}
              style={styles.card}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={`${r.name}, see sales`}
              onPress={() => navigation.navigate('StaffSalesPerson', {
                userId: r.user_id, name: r.name, from: range.from, to: range.to, locationId,
              })}
            >
              <View style={styles.cardHead}>
                <Text style={styles.name}>{r.name}</Text>
                <Text style={styles.role}>{ROLE_LABEL[r.role] || r.role}</Text>
                {(r.is_active === false || r.is_active === 0) && <Text style={styles.tag}>No longer on the team</Text>}
              </View>
              <Line label="Orders" value={String(r.orders ?? 0)} />
              <Line label="Amount" value={money(r.amount ?? 0)} />
              <Line label="Refunds" value={money(r.refunds ?? 0)} />
              <Line label="Net" value={money(r.net ?? 0)} bold />
              <Line
                label="Discounts"
                value={`${r.discount_count ?? 0} · ${money(r.discount_total ?? 0)} · ${r.override_count ?? 0} needed approval`}
              />
              <Line label="Undone" value={`${r.undone_count ?? 0} · ${money(r.undone_total ?? 0)}`} />
              <Line label="Booked at close" value={`${r.topup_count ?? 0} · ${money(r.topup_total ?? 0)}`} />
              {(r.has_bag || r.role === 'helper') && r.floats != null && (
                <View style={styles.bagBlock}>
                  <Text style={styles.bagTitle}>Cash bag</Text>
                  <Line label="Change float given" value={money(r.floats ?? 0)} />
                  <Line label="Cash taken from customers" value={money(r.cash_collected ?? 0)} />
                  <Line label="Handed over" value={money(r.handed_over ?? 0)} />
                  <Line label="Short / over" value={shortOver(r.short_over)} bold={Number(r.short_over) !== 0} />
                  <Line label="Times the amount was shown" value={String(r.reveals ?? 0)} />
                </View>
              )}
              <Text style={styles.more}>See their sales ›</Text>
            </TouchableOpacity>
          ))
        )}
      </View>

      <DateTimePickerModal
        visible={!!picking}
        mode="date"
        value={picking === 'to' ? (pendingFrom || pickerValue) : pickerValue}
        title={picking === 'to' ? 'To which day?' : 'From which day?'}
        onCancel={() => setPicking(null)}
        onConfirm={onPicked}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.md, paddingBottom: Spacing.xl },
  column: { width: '100%', maxWidth: 800, alignSelf: 'center' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: Spacing.sm },
  chip: {
    minHeight: TouchTarget.minHeight, paddingHorizontal: Spacing.md, justifyContent: 'center',
    borderRadius: BorderRadius.lg, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border,
    marginRight: Spacing.sm, marginBottom: Spacing.sm,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: FontSize.md, color: Colors.text, fontWeight: '600' },
  chipTextActive: { color: '#fff' },
  rangeText: { fontSize: FontSize.md, color: Colors.textSecondary, marginBottom: Spacing.md },
  center: { alignItems: 'center' },
  message: { fontSize: FontSize.md, color: Colors.textSecondary, textAlign: 'center', marginTop: Spacing.lg },
  retry: {
    minHeight: TouchTarget.minHeight, paddingHorizontal: Spacing.lg, justifyContent: 'center',
    backgroundColor: Colors.primary, borderRadius: BorderRadius.lg, marginTop: Spacing.md,
  },
  retryText: { color: '#fff', fontSize: FontSize.md, fontWeight: '700' },
  card: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg, padding: Spacing.md,
    marginBottom: Spacing.sm, borderWidth: 1, borderColor: Colors.border,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', marginBottom: Spacing.sm },
  name: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, marginRight: Spacing.sm },
  role: { fontSize: FontSize.md, color: Colors.textSecondary, marginRight: Spacing.sm },
  tag: {
    fontSize: FontSize.sm, color: Colors.textSecondary, borderWidth: 1, borderColor: Colors.border,
    borderRadius: BorderRadius.md, paddingHorizontal: Spacing.sm, paddingVertical: 2,
  },
  line: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  lineLabel: { fontSize: FontSize.md, color: Colors.textSecondary, marginRight: Spacing.md },
  lineValue: { fontSize: FontSize.md, color: Colors.text, flexShrink: 1, textAlign: 'right' },
  lineBold: { fontWeight: '700', fontSize: FontSize.lg },
  bagBlock: { marginTop: Spacing.sm, paddingTop: Spacing.sm, borderTopWidth: 1, borderTopColor: Colors.border },
  bagTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, marginBottom: 2 },
  more: { fontSize: FontSize.md, color: Colors.primary, fontWeight: '600', marginTop: Spacing.sm },
});
