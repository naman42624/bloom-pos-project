import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  RefreshControl, Alert, Modal, TextInput, ActivityIndicator, Platform, KeyboardAvoidingView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const confirm = (title, msg, onOk) => {
  if (Platform.OS === 'web') { if (window.confirm(`${title}\n${msg}`)) onOk(); }
  else Alert.alert(title, msg, [{ text: 'Cancel', style: 'cancel' }, { text: 'OK', onPress: onOk }]);
};

export default function ShiftManagementScreen() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [shifts, setShifts] = useState([]);
  const [staffList, setStaffList] = useState([]);
  const [locations, setLocations] = useState([]);
  const [modal, setModal] = useState(false);
  const [saving, setSaving] = useState(false);

  // Form state
  const [selectedUser, setSelectedUser] = useState(null);
  const [selectedLocation, setSelectedLocation] = useState(null);
  const [shiftStart, setShiftStart] = useState('09:00');
  const [shiftEnd, setShiftEnd] = useState('18:00');
  const [selectedDays, setSelectedDays] = useState([0, 1, 2, 3, 4, 5]); // Mon-Sat
  const [geofenceTimeout, setGeofenceTimeout] = useState('15');
  const [shiftSegments, setShiftSegments] = useState([]); // [{start:'07:00',end:'12:00'}, ...]
  const [isSplitShift, setIsSplitShift] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [shiftsRes, locsRes, usersRes] = await Promise.all([
        api.getShifts(),
        api.getLocations(),
        api.getUsers ? api.getUsers() : Promise.resolve({ data: { users: [] } }),
      ]);
      setShifts(shiftsRes.data || []);
      setLocations((locsRes.data?.locations || []).filter(l => l.type === 'shop' && l.is_active));
      const staff = (usersRes.data?.users || []).filter(
        u => ['manager', 'employee', 'delivery_partner'].includes(u.role) && u.is_active
      );
      setStaffList(staff);
    } catch (e) {
      console.error('Fetch shifts error:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { fetchData(); }, [fetchData]));

  const openCreateModal = () => {
    setSelectedUser(null);
    setSelectedLocation(null);
    setShiftStart('09:00');
    setShiftEnd('18:00');
    setSelectedDays([0, 1, 2, 3, 4, 5]);
    setGeofenceTimeout('15');
    setShiftSegments([]);
    setIsSplitShift(false);
    setModal(true);
  };

  const openEditModal = (shift) => {
    setSelectedUser({ id: shift.user_id, name: shift.user_name });
    setSelectedLocation({ id: shift.location_id, name: shift.location_name });
    setShiftStart(shift.shift_start || '09:00');
    setShiftEnd(shift.shift_end || '18:00');
    let days;
    try { days = shift.days_of_week ? JSON.parse(shift.days_of_week) : [0, 1, 2, 3, 4, 5]; } catch { days = [0, 1, 2, 3, 4, 5]; }
    if (!Array.isArray(days)) days = [0, 1, 2, 3, 4, 5];
    setSelectedDays(days);
    setGeofenceTimeout(String(shift.geofence_timeout_minutes || 15));
    let segs;
    try { segs = shift.shift_segments ? JSON.parse(shift.shift_segments) : []; } catch { segs = []; }
    if (!Array.isArray(segs)) segs = [];
    setShiftSegments(segs);
    setIsSplitShift(segs.length > 0);
    setModal(true);
  };

  const addSegment = () => {
    setShiftSegments(prev => [...prev, { start: '', end: '' }]);
  };

  const removeSegment = (idx) => {
    setShiftSegments(prev => prev.filter((_, i) => i !== idx));
  };

  const updateSegment = (idx, field, value) => {
    setShiftSegments(prev => prev.map((seg, i) => i === idx ? { ...seg, [field]: value } : seg));
  };

  const handleSave = async () => {
    if (!selectedUser || !selectedLocation) {
      Alert.alert('Error', 'Please select staff member and location.');
      return;
    }
    const timeRe = /^\d{2}:\d{2}$/;
    if (!timeRe.test(shiftStart) || !timeRe.test(shiftEnd)) {
      Alert.alert('Error', 'Times must be in HH:MM format.');
      return;
    }
    if (isSplitShift) {
      if (shiftSegments.length < 2) {
        Alert.alert('Error', 'Split shift requires at least 2 segments.');
        return;
      }
      for (const seg of shiftSegments) {
        if (!timeRe.test(seg.start) || !timeRe.test(seg.end)) {
          Alert.alert('Error', 'All segment times must be in HH:MM format.');
          return;
        }
      }
    }
    setSaving(true);
    try {
      await api.createShift({
        user_id: selectedUser.id,
        location_id: selectedLocation.id,
        shift_start: shiftStart,
        shift_end: shiftEnd,
        days_of_week: selectedDays,
        geofence_timeout_minutes: Number(geofenceTimeout) || 15,
        shift_segments: isSplitShift && shiftSegments.length >= 2 ? JSON.stringify(shiftSegments) : null,
      });
      setModal(false);
      await fetchData();
    } catch (e) {
      Alert.alert('Error', e.message || 'Failed to save shift.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = (shift) => {
    confirm('Delete Shift', `Remove shift for ${shift.user_name}?`, async () => {
      try {
        await api.deleteShift(shift.id);
        await fetchData();
      } catch (e) {
        Alert.alert('Error', e.message || 'Failed to delete.');
      }
    });
  };

  const toggleDay = (idx) => {
    setSelectedDays(prev =>
      prev.includes(idx) ? prev.filter(d => d !== idx) : [...prev, idx].sort()
    );
  };

  if (loading) {
    return <View style={styles.center}><ActivityIndicator size="large" color={Colors.primary} /></View>;
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchData(); }} colors={[Colors.primary]} />}
    >
      <TouchableOpacity style={styles.addBtn} onPress={openCreateModal}>
        <Ionicons name="add-circle" size={22} color="#fff" />
        <Text style={styles.addBtnText}>Set Shift</Text>
      </TouchableOpacity>

      {shifts.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="calendar-outline" size={48} color={Colors.textLight} />
          <Text style={styles.emptyText}>No shifts configured yet</Text>
          <Text style={styles.emptySubtext}>Set shift times for your staff members</Text>
        </View>
      ) : (
        shifts.map(s => {
          let days;
          try { days = s.days_of_week ? JSON.parse(s.days_of_week) : []; } catch { days = []; }
          if (!Array.isArray(days)) days = [];
          return (
            <View key={s.id} style={styles.card}>
              <View style={styles.cardHeader}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardName}>{s.user_name}</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 }}>
                    <View style={[styles.roleBadge, { backgroundColor: s.user_role === 'manager' ? '#9C27B0' : s.user_role === 'delivery_partner' ? '#FF5722' : Colors.primary }]}>
                      <Text style={styles.roleBadgeText}>{s.user_role === 'delivery_partner' ? 'Delivery' : s.user_role}</Text>
                    </View>
                    <Text style={styles.cardLocation}>{s.location_name}</Text>
                  </View>
                </View>
                <View style={styles.cardActions}>
                  <TouchableOpacity onPress={() => openEditModal(s)} style={styles.iconBtn}>
                    <Ionicons name="create-outline" size={22} color={Colors.primary} />
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => handleDelete(s)} style={styles.iconBtn}>
                    <Ionicons name="trash-outline" size={22} color={Colors.error} />
                  </TouchableOpacity>
                </View>
              </View>
              <View style={styles.cardBody}>
                <View style={styles.timeRow}>
                  <Ionicons name="time-outline" size={16} color={Colors.textSecondary} />
                  <Text style={styles.timeText}>{s.shift_start} — {s.shift_end}</Text>
                </View>
                {s.shift_segments && (() => {
                  let segs;
                  try {
                    segs = typeof s.shift_segments === 'string' ? JSON.parse(s.shift_segments) : s.shift_segments;
                  } catch (e) { segs = []; }
                  if (!Array.isArray(segs)) segs = [];
                  return segs.length > 0 ? (
                    <View style={styles.segmentsRow}>
                      <Ionicons name="git-branch-outline" size={14} color={Colors.primary} />
                      <Text style={styles.segmentsText}>
                        Split: {segs.map(sg => `${sg.start}–${sg.end}`).join(' + ')}
                      </Text>
                    </View>
                  ) : null;
                })()}
                <View style={styles.daysRow}>
                  {DAYS.map((d, i) => (
                    <View key={i} style={[styles.dayChip, days.includes(i) && styles.dayChipActive]}>
                      <Text style={[styles.dayChipText, days.includes(i) && styles.dayChipTextActive]}>{d}</Text>
                    </View>
                  ))}
                </View>
                <Text style={styles.timeoutText}>
                  Geofence timeout: {s.geofence_timeout_minutes || 15} min
                </Text>
              </View>
            </View>
          );
        })
      )}

      {/* ─── Create/Edit Modal ──────────────────────────── */}
      <Modal visible={modal} transparent animationType="slide" onRequestClose={() => setModal(false)}>
        <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView style={styles.modalContent} bounces={false} keyboardShouldPersistTaps="handled">
            <Text style={styles.modalTitle}>{selectedUser ? 'Edit Shift' : 'Set Shift'}</Text>

            <Text style={styles.label}>Staff Member</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipScroll}>
              {staffList.map(s => (
                <TouchableOpacity
                  key={s.id}
                  style={[styles.chip, selectedUser?.id === s.id && styles.chipActive]}
                  onPress={() => setSelectedUser(s)}
                >
                  <Text style={[styles.chipText, selectedUser?.id === s.id && styles.chipTextActive]}>
                    {s.name}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            <Text style={styles.label}>Location</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipScroll}>
              {locations.map(l => (
                <TouchableOpacity
                  key={l.id}
                  style={[styles.chip, selectedLocation?.id === l.id && styles.chipActive]}
                  onPress={() => setSelectedLocation(l)}
                >
                  <Text style={[styles.chipText, selectedLocation?.id === l.id && styles.chipTextActive]}>
                    {l.name}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            <View style={styles.timeInputRow}>
              <View style={{ flex: 1, marginRight: Spacing.sm }}>
                <Text style={styles.label}>Shift Start</Text>
                <TextInput
                  style={styles.input}
                  value={shiftStart}
                  onChangeText={setShiftStart}
                  placeholder="09:00"
                  placeholderTextColor={Colors.textLight}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>Shift End</Text>
                <TextInput
                  style={styles.input}
                  value={shiftEnd}
                  onChangeText={setShiftEnd}
                  placeholder="18:00"
                  placeholderTextColor={Colors.textLight}
                />
              </View>
            </View>

            <Text style={styles.label}>Working Days</Text>
            <View style={styles.daysRow}>
              {DAYS.map((d, i) => (
                <TouchableOpacity
                  key={i}
                  style={[styles.dayChip, selectedDays.includes(i) && styles.dayChipActive]}
                  onPress={() => toggleDay(i)}
                >
                  <Text style={[styles.dayChipText, selectedDays.includes(i) && styles.dayChipTextActive]}>{d}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* ── Split Shift Toggle ── */}
            <TouchableOpacity
              style={styles.splitToggle}
              onPress={() => {
                setIsSplitShift(prev => {
                  if (!prev) {
                    setShiftSegments(segs => segs.length >= 2 ? segs : [
                      { start: shiftStart || '09:00', end: '13:00' },
                      { start: '15:00', end: shiftEnd || '18:00' },
                    ]);
                  }
                  return !prev;
                });
              }}
            >
              <Ionicons name={isSplitShift ? 'checkbox' : 'square-outline'} size={22} color={Colors.primary} />
              <Text style={styles.splitToggleText}>Split Shift (multiple segments)</Text>
            </TouchableOpacity>

            {isSplitShift && (
              <View style={styles.segmentsContainer}>
                {shiftSegments.map((seg, idx) => (
                  <View key={idx} style={styles.segmentInputRow}>
                    <Text style={styles.segLabel}>Seg {idx + 1}</Text>
                    <TextInput
                      style={[styles.input, { flex: 1, marginHorizontal: Spacing.xs }]}
                      value={seg.start}
                      onChangeText={v => updateSegment(idx, 'start', v)}
                      placeholder="09:00"
                      placeholderTextColor={Colors.textLight}
                    />
                    <Text style={styles.segDash}>—</Text>
                    <TextInput
                      style={[styles.input, { flex: 1, marginHorizontal: Spacing.xs }]}
                      value={seg.end}
                      onChangeText={v => updateSegment(idx, 'end', v)}
                      placeholder="13:00"
                      placeholderTextColor={Colors.textLight}
                    />
                    {shiftSegments.length > 2 && (
                      <TouchableOpacity onPress={() => removeSegment(idx)} style={{ padding: Spacing.xs }}>
                        <Ionicons name="close-circle" size={22} color={Colors.error} />
                      </TouchableOpacity>
                    )}
                  </View>
                ))}
                <TouchableOpacity style={styles.addSegBtn} onPress={addSegment}>
                  <Ionicons name="add-circle-outline" size={18} color={Colors.primary} />
                  <Text style={styles.addSegText}>Add Segment</Text>
                </TouchableOpacity>
              </View>
            )}

            <Text style={styles.label}>Geofence Timeout (minutes)</Text>
            <TextInput
              style={styles.input}
              value={geofenceTimeout}
              onChangeText={setGeofenceTimeout}
              keyboardType="number-pad"
              placeholder="15"
              placeholderTextColor={Colors.textLight}
            />

            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => setModal(false)}>
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.saveBtn} onPress={handleSave} disabled={saving}>
                <Text style={styles.saveBtnText}>{saving ? 'Saving...' : 'Save'}</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.md },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  addBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: Colors.primary, borderRadius: BorderRadius.md,
    padding: Spacing.md, marginBottom: Spacing.md,
  },
  addBtnText: { color: '#fff', fontSize: FontSize.md, fontWeight: '600', marginLeft: Spacing.sm },
  empty: { alignItems: 'center', paddingVertical: Spacing.xl },
  emptyText: { fontSize: FontSize.md, color: Colors.textSecondary, marginTop: Spacing.md },
  emptySubtext: { fontSize: FontSize.sm, color: Colors.textLight, marginTop: Spacing.xs },
  card: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    marginBottom: Spacing.md, overflow: 'hidden',
    borderWidth: 1, borderColor: Colors.border,
  },
  cardHeader: {
    flexDirection: 'row', alignItems: 'center', padding: Spacing.md,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  cardName: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  cardLocation: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  cardActions: { flexDirection: 'row' },
  iconBtn: { padding: Spacing.sm, marginLeft: Spacing.xs },
  roleBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  roleBadgeText: { fontSize: FontSize.xs, color: '#fff', fontWeight: '600', textTransform: 'capitalize' },
  cardBody: { padding: Spacing.md },
  timeRow: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.sm },
  timeText: { fontSize: FontSize.md, color: Colors.text, marginLeft: Spacing.sm, fontWeight: '500' },
  daysRow: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: Spacing.sm },
  dayChip: {
    paddingHorizontal: Spacing.sm, paddingVertical: Spacing.xs,
    borderRadius: BorderRadius.sm, borderWidth: 1, borderColor: Colors.border,
    marginRight: Spacing.xs, marginBottom: Spacing.xs,
  },
  dayChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  dayChipText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  dayChipTextActive: { color: '#fff', fontWeight: '600' },
  timeoutText: { fontSize: FontSize.sm, color: Colors.textLight },
  segmentsRow: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.sm },
  segmentsText: { fontSize: FontSize.sm, color: Colors.primary, marginLeft: Spacing.xs, fontWeight: '500' },
  splitToggle: { flexDirection: 'row', alignItems: 'center', marginTop: Spacing.md, marginBottom: Spacing.xs },
  splitToggleText: { fontSize: FontSize.sm, color: Colors.text, marginLeft: Spacing.sm, fontWeight: '500' },
  segmentsContainer: { marginBottom: Spacing.sm, padding: Spacing.sm, backgroundColor: Colors.background, borderRadius: BorderRadius.md },
  segmentInputRow: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.xs },
  segLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, width: 36, fontWeight: '600' },
  segDash: { fontSize: FontSize.md, color: Colors.textSecondary },
  addSegBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: Spacing.sm },
  addSegText: { fontSize: FontSize.sm, color: Colors.primary, marginLeft: Spacing.xs, fontWeight: '500' },
  // Modal
  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: Colors.surface, borderTopLeftRadius: BorderRadius.lg, borderTopRightRadius: BorderRadius.lg,
    padding: Spacing.lg, maxHeight: '90%',
  },
  modalTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, marginBottom: Spacing.md },
  label: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.textSecondary, marginBottom: Spacing.xs, marginTop: Spacing.sm },
  chipScroll: { marginBottom: Spacing.xs },
  chip: {
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border,
    marginRight: Spacing.sm,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: FontSize.sm, color: Colors.text },
  chipTextActive: { color: '#fff', fontWeight: '600' },
  timeInputRow: { flexDirection: 'row', marginTop: Spacing.xs },
  input: {
    borderWidth: 1, borderColor: Colors.border, borderRadius: BorderRadius.md,
    padding: Spacing.md, fontSize: FontSize.md, color: Colors.text,
    backgroundColor: Colors.background, minHeight: 48,
  },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: Spacing.lg },
  cancelBtn: {
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.md, marginRight: Spacing.sm,
  },
  cancelBtnText: { color: Colors.textSecondary, fontSize: FontSize.md },
  saveBtn: {
    backgroundColor: Colors.primary, paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.md,
  },
  saveBtnText: { color: '#fff', fontSize: FontSize.md, fontWeight: '600' },
});
