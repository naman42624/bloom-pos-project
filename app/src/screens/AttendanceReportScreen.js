import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  RefreshControl, ActivityIndicator, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { getShopNow, getShopTodayStr } from '../utils/datetime';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

function formatHours(h) {
  if (!h && h !== 0) return '0';
  return h.toFixed(1);
}

function getDateRange(period, timezone) {
  const shopNow = getShopNow(timezone);
  const end = getShopTodayStr(timezone);
  
  let start;
  if (period === 'week') {
    // Go back 6 days from shopNow
    const d = new Date(shopNow);
    d.setDate(d.getDate() - 6);
    // Use Intl to format exactly in that timezone to avoid ISO string UTC shift
    start = new Intl.DateTimeFormat('en-CA', { 
      timeZone: timezone, 
      year: 'numeric', month: '2-digit', day: '2-digit' 
    }).format(d);
  } else if (period === 'month') {
    start = `${shopNow.getFullYear()}-${String(shopNow.getMonth() + 1).padStart(2, '0')}-01`;
  } else {
    start = end;
  }
  return { start, end };
}



const PERIODS = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This Week' },
  { key: 'month', label: 'This Month' },
];

export default function AttendanceReportScreen() {
  const { settings } = useAuth();
  const timezone = settings?.timezone || 'Asia/Kolkata';
  const [loading, setLoading] = useState(true);

  const [refreshing, setRefreshing] = useState(false);
  const [period, setPeriod] = useState('week');
  const [summary, setSummary] = useState([]);
  const [daily, setDaily] = useState([]);
  const [locations, setLocations] = useState([]);
  const [selectedLoc, setSelectedLoc] = useState(null);

  const fetchData = useCallback(async () => {
    try {
      const { start, end } = getDateRange(period, timezone);

      const params = { start_date: start, end_date: end };
      if (selectedLoc) params.location_id = selectedLoc;

      const [reportRes, locsRes] = await Promise.all([
        api.getAttendanceReport(params),
        api.getLocations(),
      ]);
      setSummary(reportRes.data?.summary || []);
      setDaily(reportRes.data?.daily || []);
      setLocations((locsRes.data?.locations || []).filter(l => l.type === 'shop' && l.is_active));
    } catch (e) {
      console.error('Fetch report error:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [period, selectedLoc]);

  useFocusEffect(useCallback(() => { fetchData(); }, [fetchData]));

  if (loading) {
    return <View style={styles.center}><ActivityIndicator size="large" color={Colors.primary} /></View>;
  }

  // Overall stats
  const totalPresent = summary.reduce((s, r) => s + (r.present_days || 0), 0);
  const totalLate = summary.reduce((s, r) => s + (r.late_count || 0), 0);
  const totalHrs = summary.reduce((s, r) => s + (r.effective_hours || 0), 0);
  const avgHrs = summary.length > 0 ? (totalHrs / summary.length).toFixed(1) : 0;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchData(); }} colors={[Colors.primary]} />}
    >
      {/* Period Toggle */}
      <View style={styles.periodRow}>
        {PERIODS.map(p => (
          <TouchableOpacity
            key={p.key}
            style={[styles.periodChip, period === p.key && styles.periodChipActive]}
            onPress={() => setPeriod(p.key)}
          >
            <Text style={[styles.periodText, period === p.key && styles.periodTextActive]}>{p.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Location Filter */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.locRow}>
        <TouchableOpacity
          style={[styles.locChip, !selectedLoc && styles.locChipActive]}
          onPress={() => setSelectedLoc(null)}
        >
          <Text style={[styles.locChipText, !selectedLoc && styles.locChipTextActive]}>All Locations</Text>
        </TouchableOpacity>
        {locations.map(loc => (
          <TouchableOpacity
            key={loc.id}
            style={[styles.locChip, selectedLoc === loc.id && styles.locChipActive]}
            onPress={() => setSelectedLoc(loc.id)}
          >
            <Text style={[styles.locChipText, selectedLoc === loc.id && styles.locChipTextActive]}>{loc.name}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Overview Stats */}
      <View style={styles.statsRow}>
        <View style={styles.statCard}>
          <Text style={styles.statValue}>{summary.length}</Text>
          <Text style={styles.statLabel}>Staff</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={[styles.statValue, { color: Colors.secondary }]}>{totalPresent}</Text>
          <Text style={styles.statLabel}>Present Days</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={[styles.statValue, { color: Colors.danger }]}>{totalLate}</Text>
          <Text style={styles.statLabel}>Late Arrivals</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={[styles.statValue, { color: Colors.primary }]}>{avgHrs}h</Text>
          <Text style={styles.statLabel}>Avg Hrs/Staff</Text>
        </View>
      </View>

      {/* Per-Employee Summary */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Staff Summary</Text>
        {summary.length === 0 ? (
          <Text style={styles.emptyText}>No attendance data for this period.</Text>
        ) : (
          summary.map(emp => (
            <View key={emp.user_id} style={styles.empRow}>
              <View style={styles.empLeft}>
                <Text style={styles.empName}>{emp.user_name}</Text>
                <Text style={styles.empRole}>{(emp.user_role || '').replace('_', ' ')}</Text>
              </View>
              <View style={styles.empStats}>
                <View style={styles.empStat}>
                  <Text style={styles.empStatVal}>{emp.present_days || 0}</Text>
                  <Text style={styles.empStatLbl}>Days</Text>
                </View>
                <View style={styles.empStat}>
                  <Text style={[styles.empStatVal, emp.late_count > 0 && { color: Colors.danger }]}>
                    {emp.late_count || 0}
                  </Text>
                  <Text style={styles.empStatLbl}>Late</Text>
                </View>
                <View style={styles.empStat}>
                  <Text style={styles.empStatVal}>{formatHours(emp.effective_hours || 0)}</Text>
                  <Text style={styles.empStatLbl}>Hours</Text>
                </View>
                <View style={styles.empStat}>
                  <Text style={styles.empStatVal}>{formatHours(emp.avg_hours_per_day || 0)}</Text>
                  <Text style={styles.empStatLbl}>Avg/Day</Text>
                </View>
              </View>
            </View>
          ))
        )}
      </View>

      {/* Daily Breakdown */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Daily Breakdown</Text>
        {daily.length === 0 ? (
          <Text style={styles.emptyText}>No data.</Text>
        ) : (
          daily.map(d => (
            <View key={d.date} style={styles.dailyRow}>
              <View style={styles.dailyLeft}>
                <Text style={styles.dailyDate}>
                  {new Date(d.date + 'T00:00:00').toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}
                </Text>
              </View>
              <View style={styles.dailyStats}>
                <View style={styles.dailyStat}>
                  <Ionicons name="people" size={14} color={Colors.secondary} />
                  <Text style={styles.dailyStatText}>{d.staff_count}</Text>
                </View>
                <View style={styles.dailyStat}>
                  <Ionicons name="alert-circle" size={14} color={Colors.danger} />
                  <Text style={styles.dailyStatText}>{d.late_count}</Text>
                </View>
                <View style={styles.dailyStat}>
                  <Ionicons name="time" size={14} color={Colors.primary} />
                  <Text style={styles.dailyStatText}>{d.avg_hours || 0}h avg</Text>
                </View>
              </View>
            </View>
          ))
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.md, paddingBottom: 40 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  periodRow: { flexDirection: 'row', gap: Spacing.xs, marginBottom: Spacing.sm },
  periodChip: {
    flex: 1, paddingVertical: 10, borderRadius: BorderRadius.md,
    backgroundColor: Colors.surface, alignItems: 'center',
    borderWidth: 1, borderColor: Colors.border,
  },
  periodChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  periodText: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  periodTextActive: { color: '#fff' },

  locRow: { flexDirection: 'row', marginBottom: Spacing.md },
  locChip: {
    paddingHorizontal: 14, paddingVertical: 6, borderRadius: 16,
    backgroundColor: Colors.surface, marginRight: Spacing.xs,
    borderWidth: 1, borderColor: Colors.border,
  },
  locChipActive: { backgroundColor: Colors.primary + '20', borderColor: Colors.primary },
  locChipText: { fontSize: FontSize.xs, color: Colors.text, fontWeight: '500' },
  locChipTextActive: { color: Colors.primary },

  statsRow: { flexDirection: 'row', gap: Spacing.xs, marginBottom: Spacing.md },
  statCard: {
    flex: 1, backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    padding: Spacing.sm, alignItems: 'center',
  },
  statValue: { fontSize: FontSize.xl, fontWeight: '800', color: Colors.text },
  statLabel: { fontSize: 10, color: Colors.textLight, marginTop: 2 },

  section: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg,
    padding: Spacing.md, marginBottom: Spacing.md,
  },
  sectionTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, marginBottom: Spacing.sm },
  emptyText: { fontSize: FontSize.sm, color: Colors.textLight, textAlign: 'center', paddingVertical: Spacing.lg },

  empRow: {
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1, borderColor: Colors.border,
  },
  empLeft: { marginBottom: 6 },
  empName: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  empRole: { fontSize: FontSize.xs, color: Colors.textLight, textTransform: 'capitalize' },
  empStats: { flexDirection: 'row', gap: Spacing.md },
  empStat: { alignItems: 'center' },
  empStatVal: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  empStatLbl: { fontSize: 10, color: Colors.textLight },

  dailyRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: Spacing.sm, borderBottomWidth: 1, borderColor: Colors.border,
  },
  dailyLeft: {},
  dailyDate: { fontSize: FontSize.sm, fontWeight: '500', color: Colors.text },
  dailyStats: { flexDirection: 'row', gap: Spacing.md },
  dailyStat: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  dailyStatText: { fontSize: FontSize.sm, color: Colors.text },
});
