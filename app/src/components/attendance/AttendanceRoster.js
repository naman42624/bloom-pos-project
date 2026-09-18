// app/src/components/attendance/AttendanceRoster.js
//
// The "Today" tab's live roster — a superset of StaffAttendanceScreen's own
// features (location filter, summary tiles, per-session expansion), not a
// smaller replacement, PLUS the OT/late chips and the one-tap manual
// clock-in/out promoted directly onto each row (previously three taps deep
// inside StaffAttendanceScreen: More → Attendance → Staff Today → row).
// See spec §7.
import React, { useState, useCallback, useRef } from 'react';
import { View, Text, StyleSheet, SectionList, TouchableOpacity, ActivityIndicator, Alert, Platform, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '../../context/AuthContext';
import api from '../../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../../constants/theme';
import { formatTime as formatServerTime, formatDateLabel } from '../../utils/datetime';

function formatTime(iso) {
  if (!iso) return '--:--';
  return formatServerTime(iso, 'en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}

// "Yesterday, 10:30 PM" — auto-closed sessions are often from a previous
// calendar day (an evening shift gets swept closed after midnight), so the
// day has to be on screen, not just the time.
function formatWhen(iso) {
  if (!iso) return '';
  const day = formatDateLabel(iso);
  return day ? `${day}, ${formatTime(iso)}` : formatTime(iso);
}

function formatExtra(minutes) {
  if (!minutes || minutes <= 0) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `+${h}h ${m}m` : `+${m}m`;
}

// The employee's configured shift window(s), e.g. "09:00–17:00" or, for a
// split shift, "09:00–13:00, 17:00–21:00". `shift_segments` is occasionally
// JSON-encoded TWICE in this project's own live data (a string containing a
// JSON string containing the array) — mirrors the backend's own
// normalizeSegments (server/utils/shift-work.js) defensive parse-up-to-twice
// pattern, kept lightweight here rather than importing that module.
function formatShift(item) {
  let segments = null;
  if (item.shift_segments) {
    let parsed = item.shift_segments;
    for (let i = 0; i < 2 && typeof parsed === 'string'; i++) {
      try { parsed = JSON.parse(parsed); } catch (_) { parsed = null; break; }
    }
    if (Array.isArray(parsed) && parsed.length > 0) segments = parsed;
  }
  const short = (t) => (t ? t.slice(0, 5) : ''); // 'HH:MM:SS' -> 'HH:MM'
  if (segments) {
    return segments.map((s) => `${short(s.start)}–${short(s.end)}`).join(', ');
  }
  if (item.shift_start && item.shift_end) {
    return `${short(item.shift_start)}–${short(item.shift_end)}`;
  }
  return null; // no shift configured — render nothing, don't show a confusing blank/zero
}

// outdoor_hours is a decimal number of hours (e.g. 1.5) — reuse formatExtra's
// exact "+1h 30m" style so this conceptually-similar figure (time away from
// the shift, vs. time beyond it) doesn't invent its own format.
function formatOutdoor(hours) {
  if (!hours || hours <= 0) return null;
  return formatExtra(Math.round(hours * 60));
}

const confirmClockOut = (name, onOk) => {
  const msg = `Clock out ${name}?`;
  if (Platform.OS === 'web') { if (window.confirm(msg)) onOk(); }
  else Alert.alert('Clock Out', msg, [{ text: 'Cancel', style: 'cancel' }, { text: 'OK', onPress: onOk }]);
};

export default function AttendanceRoster() {
  const { user, activeLocation } = useAuth();
  const isOwner = user?.role === 'owner';
  // Per-row (per-action-key) double-tap guard — NOT useSubmitGuard, whose
  // single shared lock (fine for a single-button screen) would otherwise
  // make clocking in/out one staff member silently block every other row's
  // action for the duration of that request+refetch. Same synchronous
  // checked-and-set-before-the-handler-runs principle, just keyed per row.
  const inFlightRef = useRef({});
  const guardRow = (key, fn) => async (...args) => {
    if (inFlightRef.current[key]) return;
    inFlightRef.current[key] = true;
    try {
      await fn(...args);
    } finally {
      inFlightRef.current[key] = false;
    }
  };

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [present, setPresent] = useState([]);
  const [absent, setAbsent] = useState([]);
  const [needsConfirmation, setNeedsConfirmation] = useState([]);
  const [summary, setSummary] = useState(null);
  const [locations, setLocations] = useState([]);
  // Owner defaults to "All Locations" (null); manager defaults to their
  // own assigned location — same pattern OrdersInboxScreen's location
  // filter already established.
  const [selectedLoc, setSelectedLoc] = useState(isOwner ? null : (activeLocation?.id || null));
  const [expandedUsers, setExpandedUsers] = useState({});
  const [actionLoadingKey, setActionLoadingKey] = useState(null);

  const fetchData = useCallback(async () => {
    try {
      const params = selectedLoc ? { location_id: selectedLoc } : {};
      const [staffRes, locsRes] = await Promise.all([api.getStaffToday(params), api.getLocations()]);
      setPresent(staffRes.data?.present || []);
      setAbsent(staffRes.data?.absent || []);
      setNeedsConfirmation(staffRes.data?.needs_confirmation || []);
      setSummary(staffRes.data?.summary || null);
      setLocations((locsRes.data?.locations || locsRes.data || []).filter((l) => (l.type === 'shop' || l.type == null) && l.is_active !== 0));
    } catch (e) {
      console.error('Fetch staff-today error:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [selectedLoc]);

  useFocusEffect(useCallback(() => { fetchData(); }, [fetchData]));

  const toggleExpanded = useCallback((userId) => {
    setExpandedUsers((prev) => ({ ...prev, [userId]: !prev[userId] }));
  }, []);

  const doClockIn = async (staffId, locId) => {
    setActionLoadingKey(`in-${staffId}`);
    try {
      await api.clockIn({ user_id: staffId, location_id: locId, method: 'manual' });
    } catch (e) {
      Alert.alert('Error', e.message || 'Failed to clock in staff.');
    } finally {
      // Refetch regardless of success/failure — a failed request that
      // actually succeeded server-side (lost response, not lost request)
      // would otherwise leave a stale "Not clocked in" row inviting a
      // duplicate tap.
      await fetchData();
      setActionLoadingKey(null);
    }
  };

  const doClockOut = (staffId, staffName) => {
    confirmClockOut(staffName, async () => {
      setActionLoadingKey(`out-${staffId}`);
      try {
        await api.clockOut({ user_id: staffId, method: 'manual' });
      } catch (e) {
        Alert.alert('Error', e.message || 'Failed to clock out staff.');
      } finally {
        await fetchData();
        setActionLoadingKey(null);
      }
    });
  };

  if (loading) {
    return <View style={styles.center}><ActivityIndicator size="large" color={Colors.primary} /></View>;
  }

  const sections = [
    { key: 'present', title: `Present (${present.length})`, data: present },
    { key: 'absent', title: `Not Clocked In (${absent.length})`, data: absent },
  ];

  return (
    <SectionList
      sections={sections}
      keyExtractor={(item, index) => `${item.user_id || item.id}-${index}`}
      contentContainerStyle={styles.list}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchData(); }} colors={[Colors.primary]} />}
      ListHeaderComponent={
        <>
          {/* Location filter — restored; an earlier draft dropped this
              entirely and locked the owner to "All" with no way to narrow it. */}
          <View style={styles.locRow}>
            <TouchableOpacity style={[styles.locChip, !selectedLoc && styles.locChipActive]} onPress={() => setSelectedLoc(null)}>
              <Text style={[styles.locChipText, !selectedLoc && styles.locChipTextActive]}>All</Text>
            </TouchableOpacity>
            {locations.map((loc) => (
              <TouchableOpacity key={loc.id} style={[styles.locChip, selectedLoc === loc.id && styles.locChipActive]} onPress={() => setSelectedLoc(loc.id)}>
                <Text style={[styles.locChipText, selectedLoc === loc.id && styles.locChipTextActive]}>{loc.name}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Summary tiles — restored from StaffAttendanceScreen, using the
              same summary object GET /attendance/staff-today already returns. */}
          <View style={styles.summaryRow}>
            <View style={[styles.summaryCard, { backgroundColor: '#E8F5E9' }]}>
              <Ionicons name="checkmark-circle" size={22} color={Colors.secondary} />
              <Text style={styles.summaryCount}>{summary?.present_count ?? present.length}</Text>
              <Text style={styles.summaryLabel}>Present</Text>
            </View>
            <View style={[styles.summaryCard, { backgroundColor: '#E3F2FD' }]}>
              <Ionicons name="pulse" size={22} color={Colors.primary} />
              <Text style={styles.summaryCount}>{summary?.active_count ?? 0}</Text>
              <Text style={styles.summaryLabel}>Active Now</Text>
            </View>
            <View style={[styles.summaryCard, { backgroundColor: '#FFEBEE' }]}>
              <Ionicons name="close-circle" size={22} color={Colors.danger} />
              <Text style={styles.summaryCount}>{summary?.absent_count ?? absent.length}</Text>
              <Text style={styles.summaryLabel}>Not Clocked In</Text>
            </View>
            <View style={[styles.summaryCard, { backgroundColor: '#FFF3E0' }]}>
              <Ionicons name="alert-circle" size={22} color={Colors.warning} />
              <Text style={styles.summaryCount}>{summary?.late_count ?? 0}</Text>
              <Text style={styles.summaryLabel}>Late</Text>
            </View>
          </View>

          {/* Auto-closed sessions from roughly the last day. An evening
              shift gets swept closed after midnight, so its row belongs to
              YESTERDAY and never shows up on the list below — this is the
              only place a manager would otherwise see it at all. Its
              finishing time is the system's best guess, not something
              anyone actually recorded, so it's worth a glance before
              payroll. Deliberately NOT tappable: there's no confirm/edit
              flow behind it yet, and an affordance that promises an action
              it can't perform is worse than a plain notice. */}
          {(summary?.needs_confirmation_count > 0) && (
            <View style={styles.autoClosedBanner}>
              <Ionicons name="time-outline" size={18} color={Colors.warning} />
              <View style={styles.autoClosedTextWrap}>
                <Text style={styles.autoClosedTitle}>
                  {summary.needs_confirmation_count === 1
                    ? '1 shift was closed automatically'
                    : `${summary.needs_confirmation_count} shifts were closed automatically`}
                </Text>
                <Text style={styles.autoClosedBody}>
                  Nobody clocked these out, so the app guessed the finishing time. Worth checking the hours before payroll.
                </Text>
                {needsConfirmation.slice(0, 3).map((row) => (
                  <Text key={row.id} style={styles.autoClosedItem}>
                    • {row.user_name} — finished {formatWhen(row.clock_out)}
                  </Text>
                ))}
                {needsConfirmation.length > 3 && (
                  <Text style={styles.autoClosedItem}>• and {needsConfirmation.length - 3} more</Text>
                )}
              </View>
            </View>
          )}
        </>
      }
      renderSectionHeader={({ section }) => <Text style={styles.sectionTitle}>{section.title}</Text>}
      renderItem={({ item, section }) => {
        if (section.key === 'absent') {
          const busy = actionLoadingKey === `in-${item.id}`;
          return (
            <View style={styles.row}>
              <View style={styles.rowInfo}>
                <Text style={styles.name}>{item.name}</Text>
                <Text style={[styles.metaText, styles.notIn]}>Not clocked in</Text>
              </View>
              {busy ? (
                <ActivityIndicator size="small" color={Colors.primary} />
              ) : (
                <TouchableOpacity style={styles.actionBtnIn} onPress={guardRow(`in-${item.id}`, () => doClockIn(item.id, item.location_id || selectedLoc))}>
                  <Ionicons name="log-in-outline" size={16} color="#fff" />
                  <Text style={styles.actionBtnText}>Clock In</Text>
                </TouchableOpacity>
              )}
            </View>
          );
        }

        // Present section — gate "Clock Out" strictly on active_session,
        // the exact fix for the earlier draft's staff-ux-checklist #6
        // violation (offering it to someone already gone for the day).
        const isActive = !!item.active_session;
        const busy = actionLoadingKey === `out-${item.user_id}`;
        const busyIn = actionLoadingKey === `in-${item.user_id}`;
        const otLabel = formatExtra(item.overtime_minutes_today);
        const canExpand = (item.sessions_count || 1) > 1;
        const isExpanded = !!expandedUsers[item.user_id];

        return (
          <View>
            <TouchableOpacity
              style={styles.row}
              onPress={canExpand ? () => toggleExpanded(item.user_id) : undefined}
              activeOpacity={canExpand ? 0.6 : 1}
            >
              <View style={styles.rowInfo}>
                <Text style={styles.name}>{item.user_name}</Text>
                <View style={styles.metaRow}>
                  <Text style={styles.metaText}>
                    {isActive ? `In since ${formatTime(item.clock_in)}` : 'Shift complete'}
                  </Text>
                  {otLabel && <Text style={styles.otChip}>{otLabel}</Text>}
                  {item.late_minutes_today > 0 && <Text style={styles.lateChip}>{item.late_minutes_today}m late</Text>}
                  {(item.clock_out_method === 'auto_shift_end' || item.clock_out_method === 'auto_timeout') && <Text style={styles.autoClosedChip}>Auto-closed</Text>}
                  {item.outdoor_hours > 0 && <Text style={styles.outdoorChip}>{formatOutdoor(item.outdoor_hours)} outdoor</Text>}
                  {canExpand && <Ionicons name={isExpanded ? 'chevron-up' : 'chevron-down'} size={14} color={Colors.textLight} />}
                </View>
                {formatShift(item) && (
                  <Text style={styles.shiftText}>Shift: {formatShift(item)}</Text>
                )}
              </View>
              {busy || busyIn ? (
                <ActivityIndicator size="small" color={Colors.primary} />
              ) : isActive ? (
                <TouchableOpacity style={styles.actionBtnOut} onPress={guardRow(`out-${item.user_id}`, () => doClockOut(item.user_id, item.user_name))}>
                  <Ionicons name="log-out-outline" size={16} color="#fff" />
                  <Text style={styles.actionBtnText}>Clock Out</Text>
                </TouchableOpacity>
              ) : (
                // Shift complete — a second shift segment is a real, common
                // case (split shifts), so re-offer Clock In rather than a
                // dead end. No confirmation: clocking in isn't destructive,
                // matches the absent-section's own unconfirmed button.
                <TouchableOpacity style={styles.actionBtnIn} onPress={guardRow(`in-${item.user_id}`, () => doClockIn(item.user_id, item.location_id || selectedLoc))}>
                  <Ionicons name="log-in-outline" size={16} color="#fff" />
                  <Text style={styles.actionBtnText}>Clock In</Text>
                </TouchableOpacity>
              )}
            </TouchableOpacity>
            {canExpand && isExpanded && (item.logs || []).map((log, idx) => {
              const sessionOtLabel = formatExtra(log.overtime_minutes);
              return (
                <View key={log.id || idx} style={styles.sessionRow}>
                  <Text style={styles.sessionText}>{formatTime(log.clock_in)} → {log.clock_out ? formatTime(log.clock_out) : 'Active'}</Text>
                  <View style={styles.sessionMetaRow}>
                    {log.location_name && <Text style={styles.sessionLocation}>{log.location_name}</Text>}
                    {log.late_minutes > 0 && <Text style={styles.sessionLateChip}>{log.late_minutes}m late</Text>}
                    {sessionOtLabel && <Text style={styles.sessionOtChip}>{sessionOtLabel}</Text>}
                    {(log.clock_out_method === 'auto_shift_end' || log.clock_out_method === 'auto_timeout') && (
                      <Text style={styles.sessionAutoChip}>Auto-closed</Text>
                    )}
                    {log.outdoor_hours > 0 && <Text style={styles.sessionOutdoorChip}>{formatOutdoor(log.outdoor_hours)} outdoor</Text>}
                  </View>
                </View>
              );
            })}
          </View>
        );
      }}
      ListEmptyComponent={<Text style={styles.emptyText}>No staff assigned to this location.</Text>}
    />
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: Spacing.xl },
  list: { padding: Spacing.md },
  emptyText: { fontSize: FontSize.sm, color: Colors.textLight, textAlign: 'center', paddingVertical: Spacing.lg },

  locRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.xs, marginBottom: Spacing.sm },
  locChip: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16,
    backgroundColor: Colors.background, borderWidth: 1, borderColor: Colors.border,
  },
  locChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  locChipText: { fontSize: FontSize.sm, color: Colors.text, fontWeight: '500' },
  locChipTextActive: { color: '#fff' },

  summaryRow: { flexDirection: 'row', gap: Spacing.xs, marginBottom: Spacing.md },
  summaryCard: { flex: 1, borderRadius: BorderRadius.md, padding: Spacing.sm, alignItems: 'center' },
  summaryCount: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text, marginTop: 2 },
  summaryLabel: { fontSize: 10, color: Colors.textLight, textAlign: 'center' },

  autoClosedBanner: {
    flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.sm,
    backgroundColor: '#FFF3E0', borderRadius: BorderRadius.md,
    borderLeftWidth: 3, borderLeftColor: Colors.warning,
    padding: Spacing.md, marginBottom: Spacing.md,
  },
  autoClosedTextWrap: { flex: 1 },
  autoClosedTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  autoClosedBody: { fontSize: FontSize.sm, color: Colors.text, marginTop: 2 },
  autoClosedItem: { fontSize: FontSize.sm, color: Colors.textLight, marginTop: 4 },

  sectionTitle: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.textLight, marginTop: Spacing.md, marginBottom: Spacing.xs },

  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    padding: Spacing.md, marginBottom: Spacing.xs,
    shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 4, elevation: 1,
    minHeight: 44,
  },
  rowInfo: { flex: 1, marginRight: Spacing.sm },
  name: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2, flexWrap: 'wrap' },
  metaText: { fontSize: FontSize.sm, color: Colors.textLight },
  notIn: { color: Colors.warning },
  otChip: {
    fontSize: 10, fontWeight: '700', color: '#fff', backgroundColor: Colors.warning,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, overflow: 'hidden',
  },
  lateChip: {
    fontSize: 10, fontWeight: '700', color: '#fff', backgroundColor: Colors.danger,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, overflow: 'hidden',
  },
  autoClosedChip: {
    fontSize: 10, fontWeight: '600', color: Colors.textLight, backgroundColor: Colors.background,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, borderWidth: 1, borderColor: Colors.border, overflow: 'hidden',
  },
  outdoorChip: {
    fontSize: 10, fontWeight: '700', color: '#fff', backgroundColor: Colors.info,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, overflow: 'hidden',
  },
  shiftText: { fontSize: 11, color: Colors.textLight, marginTop: 2 },
  actionBtnIn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: Colors.secondary, paddingVertical: 8, paddingHorizontal: 12, borderRadius: BorderRadius.md,
    minHeight: 36,
  },
  actionBtnOut: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: Colors.danger, paddingVertical: 8, paddingHorizontal: 12, borderRadius: BorderRadius.md,
    minHeight: 36,
  },
  actionBtnText: { color: '#fff', fontSize: FontSize.sm, fontWeight: '700' },

  sessionRow: { paddingLeft: Spacing.lg, paddingVertical: 4 },
  sessionText: { fontSize: FontSize.xs, color: Colors.text },
  sessionLocation: { fontSize: 10, color: Colors.textLight },
  sessionMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2, flexWrap: 'wrap' },
  sessionLateChip: {
    fontSize: 9, fontWeight: '700', color: '#fff', backgroundColor: Colors.danger,
    paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4, overflow: 'hidden',
  },
  sessionOtChip: {
    fontSize: 9, fontWeight: '700', color: '#fff', backgroundColor: Colors.warning,
    paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4, overflow: 'hidden',
  },
  sessionAutoChip: {
    fontSize: 9, fontWeight: '600', color: Colors.textLight, backgroundColor: Colors.background,
    paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4, borderWidth: 1, borderColor: Colors.border, overflow: 'hidden',
  },
  sessionOutdoorChip: {
    fontSize: 9, fontWeight: '700', color: '#fff', backgroundColor: Colors.info,
    paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4, overflow: 'hidden',
  },
});
