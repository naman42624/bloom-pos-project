import React, { useState, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  RefreshControl, Alert, Platform, Modal, TextInput, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const confirm = (title, msg, onOk) => {
  if (Platform.OS === 'web') { if (window.confirm(`${title}\n${msg}`)) onOk(); }
  else Alert.alert(title, msg, [{ text: 'Cancel', style: 'cancel' }, { text: 'OK', onPress: onOk }]);
};

function formatTime(iso) {
  if (!iso) return '--:--';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatHours(h) {
  if (!h && h !== 0) return '0h 0m';
  const hrs = Math.floor(h);
  const mins = Math.round((h - hrs) * 60);
  return `${hrs}h ${mins}m`;
}

export default function AttendanceScreen({ navigation }) {
  const { user, activeLocation } = useAuth();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [attendance, setAttendance] = useState(null);
  const [activeOutdoor, setActiveOutdoor] = useState(null);
  const [locations, setLocations] = useState([]);
  const [selectedLocation, setSelectedLocation] = useState(null);
  const [outdoorModal, setOutdoorModal] = useState(false);
  const [outdoorReason, setOutdoorReason] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [history, setHistory] = useState([]);
  const [outdoorRequests, setOutdoorRequests] = useState([]);

  const role = user?.role;
  const isOwner = role === 'owner';
  const isStaff = role === 'owner' || role === 'manager' || role === 'employee' || role === 'delivery_partner';
  const isManagerOrOwner = role === 'owner' || role === 'manager';
  const canClockInOut = isStaff && !isOwner; // owner doesn't clock in/out

  const fetchData = useCallback(async () => {
    try {
      const [todayRes, locsRes, histRes, outdoorRes] = await Promise.all([
        api.getTodayAttendance(),
        api.getLocations(),
        api.getAttendanceHistory({ limit: 7 }),
        isManagerOrOwner ? api.getOutdoorDutyRequests({ status: 'requested' }) : Promise.resolve({ data: [] }),
      ]);
      setAttendance(todayRes.data?.attendance || null);
      setActiveOutdoor(todayRes.data?.activeOutdoor || null);
      const locs = (locsRes.data?.locations || []).filter(l => l.type === 'shop' && l.is_active);
      setLocations(locs);
      if (!selectedLocation && locs.length > 0) {
        const primary = activeLocation || locs[0];
        setSelectedLocation(primary);
      }
      setHistory(histRes.data?.attendance || []);
      setOutdoorRequests(outdoorRes.data || []);
    } catch (e) {
      console.error('Fetch attendance error:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [selectedLocation, activeLocation, isManagerOrOwner]);

  useFocusEffect(useCallback(() => { fetchData(); }, [fetchData]));

  const handleClockIn = async () => {
    if (!selectedLocation) {
      Alert.alert('Select Location', 'Please select a location to clock in.');
      return;
    }
    setActionLoading(true);
    try {
      await api.clockIn({ location_id: selectedLocation.id, method: 'manual' });
      await fetchData();
    } catch (e) {
      Alert.alert('Error', e.message || 'Failed to clock in.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleClockOut = async () => {
    confirm('Clock Out', 'Are you sure you want to clock out?', async () => {
      setActionLoading(true);
      try {
        await api.clockOut({ method: 'manual' });
        await fetchData();
      } catch (e) {
        Alert.alert('Error', e.message || 'Failed to clock out.');
      } finally {
        setActionLoading(false);
      }
    });
  };

  const handleOutdoorRequest = async () => {
    if (!outdoorReason.trim()) {
      Alert.alert('Error', 'Please enter a reason.');
      return;
    }
    setActionLoading(true);
    try {
      await api.requestOutdoorDuty({ reason: outdoorReason.trim(), location_id: selectedLocation?.id });
      setOutdoorModal(false);
      setOutdoorReason('');
      await fetchData();
    } catch (e) {
      Alert.alert('Error', e.message || 'Failed to request outdoor duty.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleCompleteOutdoor = async () => {
    if (!activeOutdoor) return;
    setActionLoading(true);
    try {
      await api.completeOutdoorDuty(activeOutdoor.id);
      await fetchData();
    } catch (e) {
      Alert.alert('Error', e.message || 'Failed to complete outdoor duty.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleApproveOutdoor = async (id) => {
    setActionLoading(true);
    try {
      await api.approveOutdoorDuty(id);
      await fetchData();
    } catch (e) {
      Alert.alert('Error', e.message || 'Failed to approve.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleRejectOutdoor = async (id) => {
    setActionLoading(true);
    try {
      await api.rejectOutdoorDuty(id);
      await fetchData();
    } catch (e) {
      Alert.alert('Error', e.message || 'Failed to reject.');
    } finally {
      setActionLoading(false);
    }
  };

  const isClockedIn = attendance && attendance.clock_in && !attendance.clock_out;
  const isClockedOut = attendance && attendance.clock_out;

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={Colors.primary} />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchData(); }} colors={[Colors.primary]} />}
    >
      {/* ─── Today's Status Card ──────────────────────────── */}
      {canClockInOut && (
      <View style={styles.statusCard}>
        <View style={styles.statusHeader}>
          <Ionicons
            name={isClockedIn ? 'checkmark-circle' : isClockedOut ? 'checkmark-done-circle' : 'time-outline'}
            size={40}
            color={isClockedIn ? Colors.secondary : isClockedOut ? Colors.textLight : Colors.warning}
          />
          <View style={styles.statusHeaderText}>
            <Text style={styles.statusTitle}>
              {isClockedIn ? 'On Duty' : isClockedOut ? 'Shift Complete' : 'Not Clocked In'}
            </Text>
            {attendance?.location_name && (
              <Text style={styles.statusSubtitle}>{attendance.location_name}</Text>
            )}
          </View>
        </View>

        {attendance && (
          <View style={styles.timeRow}>
            <View style={styles.timeBlock}>
              <Text style={styles.timeLabel}>Clock In</Text>
              <Text style={[styles.timeValue, { color: Colors.secondary }]}>{formatTime(attendance.clock_in)}</Text>
              {attendance.late_arrival === 1 && <Text style={styles.lateTag}>LATE</Text>}
            </View>
            <View style={styles.timeDivider} />
            <View style={styles.timeBlock}>
              <Text style={styles.timeLabel}>Clock Out</Text>
              <Text style={[styles.timeValue, { color: attendance.clock_out ? Colors.danger : Colors.textLight }]}>
                {formatTime(attendance.clock_out)}
              </Text>
              {attendance.early_departure === 1 && <Text style={styles.earlyTag}>EARLY</Text>}
            </View>
            <View style={styles.timeDivider} />
            <View style={styles.timeBlock}>
              <Text style={styles.timeLabel}>Hours</Text>
              <Text style={styles.timeValue}>{formatHours(attendance.effective_hours || 0)}</Text>
            </View>
          </View>
        )}

        {/* Location Selector — shown when not clocked in */}
        {!isClockedIn && !isClockedOut && locations.length > 0 && (
          <View style={styles.locRow}>
            <Text style={styles.locLabel}>Select Location:</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.locChips}>
              {locations.map(loc => (
                <TouchableOpacity
                  key={loc.id}
                  style={[styles.locChip, selectedLocation?.id === loc.id && styles.locChipActive]}
                  onPress={() => setSelectedLocation(loc)}
                >
                  <Text style={[styles.locChipText, selectedLocation?.id === loc.id && styles.locChipTextActive]}>
                    {loc.name}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        )}

        {/* Clock In / Clock Out Buttons */}
        <View style={styles.actionRow}>
          {!isClockedIn && !isClockedOut && (
            <TouchableOpacity
              style={[styles.clockBtn, { backgroundColor: Colors.secondary }]}
              onPress={handleClockIn}
              disabled={actionLoading}
            >
              <Ionicons name="log-in-outline" size={22} color="#fff" />
              <Text style={styles.clockBtnText}>Clock In</Text>
            </TouchableOpacity>
          )}

          {isClockedIn && (
            <>
              <TouchableOpacity
                style={[styles.clockBtn, { backgroundColor: Colors.danger }]}
                onPress={handleClockOut}
                disabled={actionLoading}
              >
                <Ionicons name="log-out-outline" size={22} color="#fff" />
                <Text style={styles.clockBtnText}>Clock Out</Text>
              </TouchableOpacity>

              {!activeOutdoor && (
                <TouchableOpacity
                  style={[styles.clockBtn, { backgroundColor: Colors.warning, marginLeft: Spacing.sm }]}
                  onPress={() => setOutdoorModal(true)}
                  disabled={actionLoading}
                >
                  <Ionicons name="walk-outline" size={22} color="#fff" />
                  <Text style={styles.clockBtnText}>Outdoor Duty</Text>
                </TouchableOpacity>
              )}

              {activeOutdoor && activeOutdoor.status === 'approved' && (
                <TouchableOpacity
                  style={[styles.clockBtn, { backgroundColor: Colors.info || '#2196F3', marginLeft: Spacing.sm }]}
                  onPress={handleCompleteOutdoor}
                  disabled={actionLoading}
                >
                  <Ionicons name="return-down-back-outline" size={22} color="#fff" />
                  <Text style={styles.clockBtnText}>Return</Text>
                </TouchableOpacity>
              )}
            </>
          )}

          {isClockedOut && (
            <TouchableOpacity
              style={[styles.clockBtn, { backgroundColor: Colors.secondary }]}
              onPress={handleClockIn}
              disabled={actionLoading}
            >
              <Ionicons name="log-in-outline" size={22} color="#fff" />
              <Text style={styles.clockBtnText}>Clock In Again</Text>
            </TouchableOpacity>
          )}
        </View>

        {activeOutdoor && (
          <View style={[styles.outdoorBanner, { backgroundColor: activeOutdoor.status === 'approved' ? '#E8F5E9' : '#FFF3E0' }]}>
            <Ionicons name="walk" size={20} color={activeOutdoor.status === 'approved' ? Colors.secondary : Colors.warning} />
            <View style={{ flex: 1, marginLeft: Spacing.sm }}>
              <Text style={styles.outdoorBannerTitle}>
                Outdoor Duty: {activeOutdoor.status === 'approved' ? 'Active' : 'Pending Approval'}
              </Text>
              <Text style={styles.outdoorBannerReason}>{activeOutdoor.reason}</Text>
            </View>
          </View>
        )}
      </View>
      )}

      {/* ─── Owner Welcome Card ─────────────────────────── */}
      {isOwner && (
        <View style={styles.statusCard}>
          <View style={styles.statusHeader}>
            <Ionicons name="shield-checkmark" size={40} color={Colors.primary} />
            <View style={styles.statusHeaderText}>
              <Text style={styles.statusTitle}>Staff Management</Text>
              <Text style={styles.statusSubtitle}>View attendance, manage shifts & salaries</Text>
            </View>
          </View>
        </View>
      )}

      {/* ─── Manager: Pending Outdoor Requests ──────────── */}
      {isManagerOrOwner && outdoorRequests.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Pending Outdoor Requests</Text>
          {outdoorRequests.map(req => (
            <View key={req.id} style={styles.requestCard}>
              <View style={{ flex: 1 }}>
                <Text style={styles.requestName}>{req.user_name}</Text>
                <Text style={styles.requestReason}>{req.reason}</Text>
                <Text style={styles.requestTime}>{formatTime(req.start_time)} • {req.location_name}</Text>
              </View>
              <View style={styles.requestActions}>
                <TouchableOpacity
                  style={[styles.reqBtn, { backgroundColor: Colors.secondary }]}
                  onPress={() => handleApproveOutdoor(req.id)}
                  disabled={actionLoading}
                >
                  <Ionicons name="checkmark" size={18} color="#fff" />
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.reqBtn, { backgroundColor: Colors.danger, marginLeft: 6 }]}
                  onPress={() => handleRejectOutdoor(req.id)}
                  disabled={actionLoading}
                >
                  <Ionicons name="close" size={18} color="#fff" />
                </TouchableOpacity>
              </View>
            </View>
          ))}
        </View>
      )}

      {/* ─── Quick Links (Manager/Owner) ─────────────────── */}
      {isManagerOrOwner && (
        <View style={styles.quickLinks}>
          <TouchableOpacity style={styles.quickLink} onPress={() => navigation.navigate('StaffAttendance')}>
            <Ionicons name="people" size={20} color={Colors.primary} />
            <Text style={styles.quickLinkText}>Staff Today</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.quickLink} onPress={() => navigation.navigate('AttendanceReport')}>
            <Ionicons name="bar-chart" size={20} color={Colors.primary} />
            <Text style={styles.quickLinkText}>Reports</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.quickLink} onPress={() => navigation.navigate('SalaryAdvances')}>
            <Ionicons name="cash" size={20} color={Colors.primary} />
            <Text style={styles.quickLinkText}>Advances</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.quickLink} onPress={() => navigation.navigate('ShiftManagement')}>
            <Ionicons name="calendar" size={20} color={Colors.primary} />
            <Text style={styles.quickLinkText}>Shifts</Text>
          </TouchableOpacity>
          {isOwner && (
            <TouchableOpacity style={styles.quickLink} onPress={() => navigation.navigate('SalaryManagement')}>
              <Ionicons name="wallet" size={20} color={Colors.primary} />
              <Text style={styles.quickLinkText}>Salaries</Text>
            </TouchableOpacity>
          )}
          {(isOwner || role === 'manager') && (
            <TouchableOpacity style={styles.quickLink} onPress={() => navigation.navigate('LiveDeliveryMap')}>
              <Ionicons name="map" size={20} color={Colors.primary} />
              <Text style={styles.quickLinkText}>Live Map</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {!isManagerOrOwner && (
        <View style={styles.quickLinks}>
          <TouchableOpacity style={styles.quickLink} onPress={() => navigation.navigate('SalaryAdvances')}>
            <Ionicons name="cash" size={20} color={Colors.primary} />
            <Text style={styles.quickLinkText}>My Advances</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ─── Recent History ──────────────────────────────── */}
      {canClockInOut && (
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Recent Attendance</Text>
        {history.length === 0 ? (
          <Text style={styles.emptyText}>No attendance records yet.</Text>
        ) : (
          history.map(h => (
            <View key={h.id} style={styles.historyRow}>
              <View style={styles.historyDate}>
                <Text style={styles.historyDay}>{new Date(h.date).toLocaleDateString([], { weekday: 'short' })}</Text>
                <Text style={styles.historyDateText}>{new Date(h.date).toLocaleDateString([], { day: 'numeric', month: 'short' })}</Text>
              </View>
              <View style={styles.historyInfo}>
                <Text style={styles.historyTime}>
                  {formatTime(h.clock_in)} — {formatTime(h.clock_out)}
                </Text>
                <View style={styles.historyFlags}>
                  {h.late_arrival === 1 && <Text style={styles.lateTag}>LATE</Text>}
                  {h.early_departure === 1 && <Text style={styles.earlyTag}>EARLY</Text>}
                </View>
              </View>
              <Text style={styles.historyHours}>{formatHours(h.effective_hours)}</Text>
            </View>
          ))
        )}
      </View>
      )}

      {/* ─── Outdoor Duty Modal ──────────────────────────── */}
      <Modal visible={outdoorModal} transparent animationType="fade" onRequestClose={() => setOutdoorModal(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Request Outdoor Duty</Text>
            <TextInput
              style={styles.modalInput}
              placeholder="Reason (e.g., Bank visit, Supplier pickup)"
              placeholderTextColor={Colors.textLight}
              value={outdoorReason}
              onChangeText={setOutdoorReason}
              multiline
            />
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.modalCancel} onPress={() => { setOutdoorModal(false); setOutdoorReason(''); }}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalSubmit, !outdoorReason.trim() && { opacity: 0.5 }]}
                onPress={handleOutdoorRequest}
                disabled={!outdoorReason.trim() || actionLoading}
              >
                <Text style={styles.modalSubmitText}>{actionLoading ? 'Sending...' : 'Request'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.md, paddingBottom: 40 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  statusCard: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg,
    padding: Spacing.lg, marginBottom: Spacing.md,
    shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 8, elevation: 3,
  },
  statusHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.md },
  statusHeaderText: { marginLeft: Spacing.md },
  statusTitle: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text },
  statusSubtitle: { fontSize: FontSize.sm, color: Colors.textLight, marginTop: 2 },

  timeRow: { flexDirection: 'row', marginBottom: Spacing.md },
  timeBlock: { flex: 1, alignItems: 'center' },
  timeDivider: { width: 1, backgroundColor: Colors.border, marginHorizontal: Spacing.xs },
  timeLabel: { fontSize: FontSize.xs, color: Colors.textLight, marginBottom: 4 },
  timeValue: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },

  lateTag: {
    fontSize: 10, fontWeight: '700', color: '#fff', backgroundColor: Colors.danger,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, marginTop: 4, overflow: 'hidden',
  },
  earlyTag: {
    fontSize: 10, fontWeight: '700', color: '#fff', backgroundColor: Colors.warning,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, marginTop: 4, overflow: 'hidden',
  },

  locRow: { marginBottom: Spacing.md },
  locLabel: { fontSize: FontSize.sm, color: Colors.textLight, marginBottom: Spacing.xs },
  locChips: { flexDirection: 'row' },
  locChip: {
    paddingHorizontal: 16, paddingVertical: 10, borderRadius: 20,
    backgroundColor: Colors.background, marginRight: Spacing.xs, borderWidth: 1, borderColor: Colors.border,
  },
  locChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  locChipText: { fontSize: FontSize.sm, color: Colors.text, fontWeight: '500' },
  locChipTextActive: { color: '#fff' },

  actionRow: { flexDirection: 'row', marginBottom: Spacing.sm },
  clockBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 14, borderRadius: BorderRadius.md, gap: 8,
  },
  clockBtnText: { color: '#fff', fontSize: FontSize.md, fontWeight: '700' },

  outdoorBanner: {
    flexDirection: 'row', alignItems: 'center', padding: Spacing.sm,
    borderRadius: BorderRadius.md, marginTop: Spacing.xs,
  },
  outdoorBannerTitle: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  outdoorBannerReason: { fontSize: FontSize.xs, color: Colors.textLight },

  section: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg,
    padding: Spacing.md, marginBottom: Spacing.md,
  },
  sectionTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, marginBottom: Spacing.sm },

  requestCard: {
    flexDirection: 'row', alignItems: 'center', padding: Spacing.sm,
    borderBottomWidth: 1, borderColor: Colors.border,
  },
  requestName: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  requestReason: { fontSize: FontSize.sm, color: Colors.textLight },
  requestTime: { fontSize: FontSize.xs, color: Colors.textLight, marginTop: 2 },
  requestActions: { flexDirection: 'row' },
  reqBtn: {
    width: 36, height: 36, borderRadius: 18,
    justifyContent: 'center', alignItems: 'center',
  },

  quickLinks: {
    flexDirection: 'row', gap: Spacing.sm, marginBottom: Spacing.md,
  },
  quickLink: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, backgroundColor: Colors.surface, padding: Spacing.md,
    borderRadius: BorderRadius.md, shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 4, elevation: 1,
  },
  quickLinkText: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },

  historyRow: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: Spacing.sm,
    borderBottomWidth: 1, borderColor: Colors.border,
  },
  historyDate: { width: 50, alignItems: 'center' },
  historyDay: { fontSize: FontSize.xs, color: Colors.textLight, fontWeight: '600' },
  historyDateText: { fontSize: FontSize.xs, color: Colors.text },
  historyInfo: { flex: 1, marginLeft: Spacing.sm },
  historyTime: { fontSize: FontSize.sm, color: Colors.text, fontWeight: '500' },
  historyFlags: { flexDirection: 'row', gap: 4, marginTop: 2 },
  historyHours: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.primary },

  emptyText: { fontSize: FontSize.sm, color: Colors.textLight, textAlign: 'center', paddingVertical: Spacing.lg },

  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center', alignItems: 'center', padding: Spacing.lg,
  },
  modalContent: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg,
    padding: Spacing.lg, width: '100%', maxWidth: 400,
  },
  modalTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, marginBottom: Spacing.md },
  modalInput: {
    borderWidth: 1, borderColor: Colors.border, borderRadius: BorderRadius.md,
    padding: Spacing.sm, fontSize: FontSize.md, color: Colors.text,
    minHeight: 80, textAlignVertical: 'top', marginBottom: Spacing.md,
  },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: Spacing.sm },
  modalCancel: { paddingVertical: 10, paddingHorizontal: 20 },
  modalCancelText: { fontSize: FontSize.md, color: Colors.textLight },
  modalSubmit: {
    backgroundColor: Colors.warning, paddingVertical: 10, paddingHorizontal: 20,
    borderRadius: BorderRadius.md,
  },
  modalSubmitText: { fontSize: FontSize.md, fontWeight: '700', color: '#fff' },
});
