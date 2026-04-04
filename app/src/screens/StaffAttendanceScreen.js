import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, RefreshControl, ActivityIndicator, TouchableOpacity,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { parseServerDate, formatTime as formatServerTime } from '../utils/datetime';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

function formatTime(iso) {
  if (!iso) return '--:--';
  // Use proper parseServerDate + toLocaleTimeString for timezone-aware parsing
  const d = parseServerDate(iso);
  if (!d) return '--:--';
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function formatHours(h) {
  // Handle NaN, null, undefined explicitly
  if (h === null || h === undefined) return '0h';
  if (Number.isNaN(h)) {
    console.warn('⚠️  formatHours received NaN:', h);
    return 'NaN h'; // Show the problem clearly instead of returning "0h"
  }
  if (h < 0) h = 0; // Negative durations shouldn't happen
  const hrs = Math.floor(h);
  const mins = Math.round((h - hrs) * 60);
  return mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`;
}

function formatShiftWindow(start, end) {
  if (!start || !end) return 'Shift not set';
  return `${start.slice(0, 5)} - ${end.slice(0, 5)}`;
}

function calculateBreakGapHours(logs = []) {
  if (!Array.isArray(logs) || logs.length < 2) return 0;
  let totalMs = 0;
  for (let i = 1; i < logs.length; i += 1) {
    const prevOut = logs[i - 1]?.clock_out ? new Date(logs[i - 1].clock_out).getTime() : null;
    const nextIn = logs[i]?.clock_in ? new Date(logs[i].clock_in).getTime() : null;
    if (!prevOut || !nextIn) continue;
    const gap = nextIn - prevOut;
    if (gap > 0) totalMs += gap;
  }
  return totalMs / (1000 * 60 * 60);
}

function normalizePresentRows(rows = []) {
  const map = new Map();
  for (const row of rows) {
    const key = row.user_id || row.id;
    const existing = map.get(key);
    const rowLogs = Array.isArray(row.logs) && row.logs.length > 0
      ? row.logs
      : [{
          id: row.id,
          location_name: row.location_name,
          clock_in: row.clock_in,
          clock_out: row.clock_out,
          total_hours: Number(row.total_hours || 0),
          outdoor_hours: Number(row.outdoor_hours || 0),
          effective_hours: Number(row.effective_hours || 0),
        }];

    if (!existing) {
      map.set(key, {
        ...row,
        total_hours: Number(row.total_hours || 0),
        outdoor_hours: Number(row.outdoor_hours || 0),
        effective_hours: Number(row.effective_hours || 0),
        sessions_count: Number(row.sessions_count || 1),
        first_clock_in: row.first_clock_in || row.clock_in,
        active_session: typeof row.active_session === 'boolean' ? row.active_session : !row.clock_out,
        logs: rowLogs,
      });
      continue;
    }

    const latestA = new Date(existing.clock_in || existing.first_clock_in || 0).getTime();
    const latestB = new Date(row.clock_in || row.first_clock_in || 0).getTime();
    if (latestB >= latestA) {
      existing.clock_in = row.clock_in;
      existing.clock_out = row.clock_out;
      existing.location_name = row.location_name || existing.location_name;
      existing.shift_start = row.shift_start || existing.shift_start;
      existing.shift_end = row.shift_end || existing.shift_end;
    }

    existing.sessions_count = Number(existing.sessions_count || 1) + Number(row.sessions_count || 1);
    existing.total_hours = Number(existing.total_hours || 0) + Number(row.total_hours || 0);
    existing.outdoor_hours = Number(existing.outdoor_hours || 0) + Number(row.outdoor_hours || 0);
    existing.effective_hours = Number(existing.effective_hours || 0) + Number(row.effective_hours || 0);
    existing.late_arrival = existing.late_arrival || row.late_arrival ? 1 : 0;
    existing.early_departure = existing.early_departure || row.early_departure ? 1 : 0;
    existing.active_session = existing.active_session || !row.clock_out;
    existing.logs = [...(existing.logs || []), ...rowLogs];
    map.set(key, existing);
  }
  return Array.from(map.values()).map((entry) => {
    const dedupedLogs = Array.from(
      new Map((entry.logs || []).map((log) => [log.id || `${log.clock_in}-${log.clock_out}`, log])).values()
    ).sort((a, b) => new Date(a.clock_in || 0).getTime() - new Date(b.clock_in || 0).getTime());

    return {
      ...entry,
      logs: dedupedLogs,
      sessions_count: Math.max(Number(entry.sessions_count || dedupedLogs.length || 1), dedupedLogs.length || 1),
    };
  });
}

export default function StaffAttendanceScreen() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [present, setPresent] = useState([]);
  const [absent, setAbsent] = useState([]);
  const [summary, setSummary] = useState(null);
  const [locations, setLocations] = useState([]);
  const [selectedLoc, setSelectedLoc] = useState(null);
  const [expandedUsers, setExpandedUsers] = useState({});

  const fetchData = useCallback(async () => {
    try {
      const params = selectedLoc ? { location_id: selectedLoc } : {};
      const [staffRes, locsRes] = await Promise.all([
        api.getStaffToday(params),
        api.getLocations(),
      ]);
      const presentRows = normalizePresentRows(staffRes.data?.present || []);
      setPresent(presentRows);
      setAbsent(staffRes.data?.absent || []);
      setSummary(staffRes.data?.summary || null);
      setLocations((locsRes.data?.locations || []).filter(l => l.type === 'shop' && l.is_active));
    } catch (e) {
      console.error('Fetch staff attendance error:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [selectedLoc]);

  useFocusEffect(useCallback(() => { fetchData(); }, [fetchData]));

  const toggleExpanded = useCallback((userKey) => {
    setExpandedUsers((prev) => ({ ...prev, [userKey]: !prev[userKey] }));
  }, []);

  if (loading) {
    return <View style={styles.center}><ActivityIndicator size="large" color={Colors.primary} /></View>;
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchData(); }} colors={[Colors.primary]} />}
    >
      {/* Location Filter */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.locRow}>
        <TouchableOpacity
          style={[styles.locChip, !selectedLoc && styles.locChipActive]}
          onPress={() => setSelectedLoc(null)}
        >
          <Text style={[styles.locChipText, !selectedLoc && styles.locChipTextActive]}>All</Text>
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

      {/* Summary */}
      <View style={styles.summaryRow}>
        <View style={[styles.summaryCard, { backgroundColor: '#E8F5E9' }]}>
          <Ionicons name="checkmark-circle" size={24} color={Colors.secondary} />
          <Text style={styles.summaryCount}>{summary?.present_count ?? present.length}</Text>
          <Text style={styles.summaryLabel}>Present</Text>
        </View>
        <View style={[styles.summaryCard, { backgroundColor: '#E3F2FD' }]}>
          <Ionicons name="pulse" size={24} color={Colors.primary} />
          <Text style={styles.summaryCount}>{summary?.active_count ?? present.filter(p => p.active_session || !p.clock_out).length}</Text>
          <Text style={styles.summaryLabel}>Active Now</Text>
        </View>
        <View style={[styles.summaryCard, { backgroundColor: '#FFEBEE' }]}>
          <Ionicons name="close-circle" size={24} color={Colors.danger} />
          <Text style={styles.summaryCount}>{summary?.absent_count ?? absent.length}</Text>
          <Text style={styles.summaryLabel}>Not Clocked In</Text>
        </View>
        <View style={[styles.summaryCard, { backgroundColor: '#FFF3E0' }]}>
          <Ionicons name="alert-circle" size={24} color={Colors.warning} />
          <Text style={styles.summaryCount}>{summary?.late_count ?? present.filter(p => p.late_arrival).length}</Text>
          <Text style={styles.summaryLabel}>Late</Text>
        </View>
      </View>

      {/* Present Staff */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Present ({present.length})</Text>
        {present.length === 0 ? (
          <Text style={styles.emptyText}>No staff clocked in yet.</Text>
        ) : (
          present.map(s => {
            const isActive = s.active_session || !s.clock_out;
            const userKey = s.user_id || s.id;
            const logs = Array.isArray(s.logs) && s.logs.length > 0
              ? s.logs
              : [{
                  id: s.id,
                  location_name: s.location_name,
                  clock_in: s.clock_in,
                  clock_out: s.clock_out,
                  effective_hours: Number(s.effective_hours || 0),
                  total_hours: Number(s.total_hours || 0),
                }];
            const canExpand = logs.length > 1;
            const isExpanded = !!expandedUsers[userKey];
            const breakGapHours = calculateBreakGapHours(logs);
            return (
            <View key={s.user_id || s.id} style={styles.staffRow}>
              <View style={styles.staffTopRow}>
                <View style={[styles.avatar, { backgroundColor: isActive ? Colors.secondary + '20' : Colors.textLight + '30' }]}>
                  <Ionicons
                    name={s.user_role === 'delivery_partner' ? 'bicycle' : 'person'}
                    size={18}
                    color={isActive ? Colors.secondary : Colors.textLight}
                  />
                </View>
                <View style={styles.staffInfo}>
                  <Text style={styles.staffName}>{s.user_name}</Text>
                  <Text style={styles.staffMeta}>
                    {formatTime(s.clock_in)} — {formatTime(s.clock_out)} • {s.location_name}
                  </Text>
                  <Text style={styles.staffShiftMeta}>
                    {formatShiftWindow(s.shift_start, s.shift_end)} • {Number(s.sessions_count || 1)} session{Number(s.sessions_count || 1) > 1 ? 's' : ''}
                  </Text>
                  {breakGapHours > 0 && (
                    <Text style={styles.staffGapMeta}>Break gap: {formatHours(breakGapHours)}</Text>
                  )}
                </View>
                <View style={styles.staffRight}>
                  <Text style={styles.staffHours}>{formatHours(s.effective_hours || 0)}</Text>
                  <View style={styles.flags}>
                    {s.late_arrival === 1 && <Text style={styles.lateTag}>LATE</Text>}
                    {s.early_departure === 1 && <Text style={styles.earlyTag}>EARLY</Text>}
                    {isActive && <Text style={styles.activeTag}>ACTIVE</Text>}
                  </View>
                </View>
                {canExpand && (
                  <TouchableOpacity style={styles.expandToggle} onPress={() => toggleExpanded(userKey)}>
                    <Ionicons name={isExpanded ? 'chevron-up' : 'chevron-down'} size={18} color={Colors.primary} />
                  </TouchableOpacity>
                )}
              </View>

              {canExpand && isExpanded && (
                <View style={styles.sessionTimeline}>
                  {logs.map((log, idx) => {
                    const sessionActive = !log.clock_out;
                    const prevOut = idx > 0 && logs[idx - 1]?.clock_out ? new Date(logs[idx - 1].clock_out).getTime() : null;
                    const currIn = log?.clock_in ? new Date(log.clock_in).getTime() : null;
                    const gapHours = prevOut && currIn && currIn > prevOut ? (currIn - prevOut) / (1000 * 60 * 60) : 0;
                    return (
                      <View key={log.id || `${userKey}-${idx}`}>
                        {idx > 0 && gapHours > 0 && (
                          <View style={styles.gapRow}>
                            <Ionicons name="pause-circle-outline" size={12} color={Colors.warning} />
                            <Text style={styles.gapRowText}>Gap {formatHours(gapHours)}</Text>
                          </View>
                        )}
                        <View style={styles.sessionRow}>
                          <View style={styles.sessionIndex}>
                            <Text style={styles.sessionIndexText}>{idx + 1}</Text>
                          </View>
                          <View style={{ flex: 1 }}>
                            <Text style={styles.sessionTimeText}>{formatTime(log.clock_in)} - {formatTime(log.clock_out)}</Text>
                            <Text style={styles.sessionMetaText}>{log.location_name || s.location_name} • {formatHours(log.effective_hours || log.total_hours || 0)}</Text>
                          </View>
                          {sessionActive && <Text style={styles.activeTag}>ACTIVE</Text>}
                        </View>
                      </View>
                    );
                  })}
                </View>
              )}
            </View>
          )})
        )}
      </View>

      {/* Absent Staff */}
      {absent.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Not Clocked In ({absent.length})</Text>
          {absent.map(s => (
            <View key={s.id} style={styles.staffRow}>
              <View style={[styles.avatar, { backgroundColor: Colors.danger + '15' }]}>
                <Ionicons name="person-outline" size={18} color={Colors.danger} />
              </View>
              <View style={styles.staffInfo}>
                <Text style={styles.staffName}>{s.name}</Text>
                <Text style={styles.staffMeta}>{s.phone} • {s.role.replace('_', ' ')}</Text>
                <Text style={styles.staffShiftMeta}>{formatShiftWindow(s.shift_start, s.shift_end)}</Text>
              </View>
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.md, paddingBottom: 40 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  locRow: { flexDirection: 'row', marginBottom: Spacing.md },
  locChip: {
    paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20,
    backgroundColor: Colors.surface, marginRight: Spacing.xs, borderWidth: 1, borderColor: Colors.border,
  },
  locChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  locChipText: { fontSize: FontSize.sm, color: Colors.text, fontWeight: '500' },
  locChipTextActive: { color: '#fff' },

  summaryRow: { flexDirection: 'row', gap: Spacing.sm, marginBottom: Spacing.md },
  summaryCard: {
    flex: 1, alignItems: 'center', padding: Spacing.md,
    borderRadius: BorderRadius.md,
  },
  summaryCount: { fontSize: FontSize.xl, fontWeight: '800', color: Colors.text, marginTop: 4 },
  summaryLabel: { fontSize: FontSize.xs, color: Colors.textLight },

  section: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg,
    padding: Spacing.md, marginBottom: Spacing.md,
  },
  sectionTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, marginBottom: Spacing.sm },
  emptyText: { fontSize: FontSize.sm, color: Colors.textLight, textAlign: 'center', paddingVertical: Spacing.md },

  staffRow: {
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1, borderColor: Colors.border,
  },
  staffTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  avatar: {
    width: 36, height: 36, borderRadius: 18,
    justifyContent: 'center', alignItems: 'center',
  },
  staffInfo: { flex: 1, marginLeft: Spacing.sm },
  staffName: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  staffMeta: { fontSize: FontSize.xs, color: Colors.textLight, marginTop: 2 },
  staffShiftMeta: { fontSize: FontSize.xs, color: Colors.primary, marginTop: 2, fontWeight: '600' },
  staffGapMeta: { fontSize: FontSize.xs, color: Colors.warning, marginTop: 2, fontWeight: '700' },
  staffRight: { alignItems: 'flex-end' },
  expandToggle: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.primary + '12',
    marginLeft: 6,
  },
  sessionTimeline: {
    marginTop: 10,
    marginLeft: 44,
    paddingLeft: 10,
    borderLeftWidth: 2,
    borderLeftColor: Colors.primary + '35',
    gap: 8,
  },
  sessionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Colors.surfaceAlt,
    borderRadius: BorderRadius.sm,
    padding: 8,
  },
  sessionIndex: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sessionIndexText: {
    color: Colors.white,
    fontSize: 10,
    fontWeight: '700',
  },
  sessionTimeText: {
    fontSize: FontSize.sm,
    fontWeight: '700',
    color: Colors.text,
  },
  sessionMetaText: {
    fontSize: FontSize.xs,
    color: Colors.textLight,
    marginTop: 1,
  },
  gapRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 4,
    marginLeft: 6,
  },
  gapRowText: {
    fontSize: FontSize.xs,
    color: Colors.warning,
    fontWeight: '700',
  },
  staffHours: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.primary },
  flags: { flexDirection: 'row', gap: 4, marginTop: 2 },

  lateTag: {
    fontSize: 9, fontWeight: '700', color: '#fff', backgroundColor: Colors.danger,
    paddingHorizontal: 5, paddingVertical: 1, borderRadius: 3, overflow: 'hidden',
  },
  earlyTag: {
    fontSize: 9, fontWeight: '700', color: '#fff', backgroundColor: Colors.warning,
    paddingHorizontal: 5, paddingVertical: 1, borderRadius: 3, overflow: 'hidden',
  },
  activeTag: {
    fontSize: 9, fontWeight: '700', color: '#fff', backgroundColor: Colors.secondary,
    paddingHorizontal: 5, paddingVertical: 1, borderRadius: 3, overflow: 'hidden',
  },
});
