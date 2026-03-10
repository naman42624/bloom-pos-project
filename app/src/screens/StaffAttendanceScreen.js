import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, RefreshControl, ActivityIndicator, TouchableOpacity,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

function formatTime(iso) {
  if (!iso) return '--:--';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatHours(h) {
  if (!h && h !== 0) return '0h';
  const hrs = Math.floor(h);
  const mins = Math.round((h - hrs) * 60);
  return mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`;
}

export default function StaffAttendanceScreen() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [present, setPresent] = useState([]);
  const [absent, setAbsent] = useState([]);
  const [locations, setLocations] = useState([]);
  const [selectedLoc, setSelectedLoc] = useState(null);

  const fetchData = useCallback(async () => {
    try {
      const params = selectedLoc ? { location_id: selectedLoc } : {};
      const [staffRes, locsRes] = await Promise.all([
        api.getStaffToday(params),
        api.getLocations(),
      ]);
      setPresent(staffRes.data?.present || []);
      setAbsent(staffRes.data?.absent || []);
      setLocations((locsRes.data?.locations || []).filter(l => l.type === 'shop' && l.is_active));
    } catch (e) {
      console.error('Fetch staff attendance error:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [selectedLoc]);

  useFocusEffect(useCallback(() => { fetchData(); }, [fetchData]));

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
          <Text style={styles.summaryCount}>{present.length}</Text>
          <Text style={styles.summaryLabel}>Present</Text>
        </View>
        <View style={[styles.summaryCard, { backgroundColor: '#FFEBEE' }]}>
          <Ionicons name="close-circle" size={24} color={Colors.danger} />
          <Text style={styles.summaryCount}>{absent.length}</Text>
          <Text style={styles.summaryLabel}>Not Clocked In</Text>
        </View>
        <View style={[styles.summaryCard, { backgroundColor: '#FFF3E0' }]}>
          <Ionicons name="alert-circle" size={24} color={Colors.warning} />
          <Text style={styles.summaryCount}>{present.filter(p => p.late_arrival).length}</Text>
          <Text style={styles.summaryLabel}>Late</Text>
        </View>
      </View>

      {/* Present Staff */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Present ({present.length})</Text>
        {present.length === 0 ? (
          <Text style={styles.emptyText}>No staff clocked in yet.</Text>
        ) : (
          present.map(s => (
            <View key={s.id} style={styles.staffRow}>
              <View style={[styles.avatar, { backgroundColor: s.clock_out ? Colors.textLight + '30' : Colors.secondary + '20' }]}>
                <Ionicons
                  name={s.user_role === 'delivery_partner' ? 'bicycle' : 'person'}
                  size={18}
                  color={s.clock_out ? Colors.textLight : Colors.secondary}
                />
              </View>
              <View style={styles.staffInfo}>
                <Text style={styles.staffName}>{s.user_name}</Text>
                <Text style={styles.staffMeta}>
                  {formatTime(s.clock_in)} — {formatTime(s.clock_out)} • {s.location_name}
                </Text>
              </View>
              <View style={styles.staffRight}>
                <Text style={styles.staffHours}>{formatHours(s.effective_hours || 0)}</Text>
                <View style={styles.flags}>
                  {s.late_arrival === 1 && <Text style={styles.lateTag}>LATE</Text>}
                  {s.early_departure === 1 && <Text style={styles.earlyTag}>EARLY</Text>}
                  {!s.clock_out && <Text style={styles.activeTag}>ACTIVE</Text>}
                </View>
              </View>
            </View>
          ))
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
    flexDirection: 'row', alignItems: 'center', paddingVertical: Spacing.sm,
    borderBottomWidth: 1, borderColor: Colors.border,
  },
  avatar: {
    width: 36, height: 36, borderRadius: 18,
    justifyContent: 'center', alignItems: 'center',
  },
  staffInfo: { flex: 1, marginLeft: Spacing.sm },
  staffName: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  staffMeta: { fontSize: FontSize.xs, color: Colors.textLight, marginTop: 2 },
  staffRight: { alignItems: 'flex-end' },
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
