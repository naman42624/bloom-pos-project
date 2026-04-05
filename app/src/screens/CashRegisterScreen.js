import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TextInput,
  TouchableOpacity, Alert, ActivityIndicator, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

export default function CashRegisterScreen({ navigation, route }) {
  const { user } = useAuth();
  const initialLocationId = route.params?.locationId;
  const canManage = user?.role === 'owner' || user?.role === 'manager';

  const [locations, setLocations] = useState([]);
  const [selectedLocation, setSelectedLocation] = useState(initialLocationId || null);
  const [register, setRegister] = useState(null);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  // Open form
  const [openingBalance, setOpeningBalance] = useState('');
  // Close form
  const [actualCash, setActualCash] = useState('');
  const [closingNotes, setClosingNotes] = useState('');
  // History
  const [history, setHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const [todaySessions, setTodaySessions] = useState([]);

  const [submitting, setSubmitting] = useState(false);

  useFocusEffect(
    useCallback(() => {
      fetchLocations();
    }, [])
  );

  const fetchLocations = async () => {
    try {
      const res = await api.getLocations();
      const locs = res.data?.locations || res.data || [];
      setLocations(locs);
      if (locs.length > 0) {
        const locId = selectedLocation || locs[0].id;
        setSelectedLocation(locId);
        fetchStatus(locId);
      }
    } catch {} finally { setLoading(false); }
  };

  const fetchStatus = async (locId) => {
    try {
      const res = await api.getRegisterStatus(locId);
      setRegister(res.data);
      setIsOpen(res.isOpen);
      setTodaySessions(res.todaySessions || []);
    } catch {}
  };

  const handleLocationChange = (locId) => {
    setSelectedLocation(locId);
    fetchStatus(locId);
  };

  const handleOpen = async () => {
    const balance = parseFloat(openingBalance);
    if (isNaN(balance) || balance < 0) {
      Alert.alert('Invalid', 'Enter a valid opening balance');
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.openRegister({ location_id: selectedLocation, opening_balance: balance });
      if (res.success) {
        setRegister(res.data);
        setIsOpen(true);
        setOpeningBalance('');
        Alert.alert('Opened', 'Cash register opened successfully');
      } else {
        Alert.alert('Error', res.message);
      }
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to open register');
    } finally { setSubmitting(false); }
  };

  const handleClose = async () => {
    const cash = parseFloat(actualCash);
    if (isNaN(cash) || cash < 0) {
      Alert.alert('Invalid', 'Enter actual cash in drawer');
      return;
    }

    const doClose = async () => {
      setSubmitting(true);
      try {
        const res = await api.closeRegister({
          location_id: selectedLocation,
          actual_cash: cash,
          closing_notes: closingNotes,
        });
        if (res.success) {
          setRegister(res.data);
          setIsOpen(false);
          setActualCash('');
          setClosingNotes('');
          Alert.alert('Closed', 'Register closed. Discrepancy: ₹' + Number(res.data.discrepancy || 0).toFixed(2));
        } else {
          Alert.alert('Error', res.message);
        }
      } catch (err) {
        Alert.alert('Error', err.message || 'Failed to close register');
      } finally { setSubmitting(false); }
    };

    if (Platform.OS === 'web') {
      if (window.confirm(`Close register with ₹${cash} actual cash?`)) doClose();
    } else {
      Alert.alert('Close Register', `Actual cash: ₹${cash}. Proceed?`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Close', onPress: doClose },
      ]);
    }
  };

  const fetchHistory = async () => {
    try {
      const res = await api.getRegisterHistory({ location_id: selectedLocation });
      setHistory(res.data || []);
      setShowHistory(true);
    } catch {}
  };

  if (loading) {
    return <View style={styles.center}><ActivityIndicator color={Colors.primary} size="large" /></View>;
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Location selector */}
      {locations.length > 1 && (
        <View style={styles.locRow}>
          {locations.map((loc) => (
            <TouchableOpacity
              key={loc.id}
              style={[styles.locChip, selectedLocation === loc.id && styles.locChipActive]}
              onPress={() => handleLocationChange(loc.id)}
            >
              <Text style={[styles.locChipText, selectedLocation === loc.id && styles.locChipTextActive]}>{loc.name}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Status card */}
      <View style={[styles.statusCard, { borderColor: isOpen ? Colors.success : Colors.border }]}>
        <View style={styles.statusHeader}>
          <Ionicons name={isOpen ? 'lock-open' : 'lock-closed'} size={24} color={isOpen ? Colors.success : Colors.textLight} />
          <View style={{ marginLeft: Spacing.sm }}>
            <Text style={styles.statusTitle}>{isOpen ? 'Register Open' : 'Register Closed'}</Text>
            <Text style={styles.statusSub}>
              {register ? `${new Date().toLocaleDateString()}` : 'Not opened today'}
            </Text>
          </View>
        </View>

        {register && isOpen && (
          <View style={styles.statusDetails}>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Opening Balance</Text>
              <Text style={styles.detailVal}>₹{Number(register.opening_balance || 0).toFixed(2)}</Text>
            </View>
            {(register.total_expenses_cash || 0) > 0 && (
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Cash Expenses</Text>
                <Text style={[styles.detailVal, { color: Colors.error }]}>-₹{Number(register.total_expenses_cash).toFixed(2)}</Text>
              </View>
            )}
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Opened By</Text>
              <Text style={styles.detailVal}>{register.opened_by_name}</Text>
            </View>
          </View>
        )}

        {register && !isOpen && register.closed_at && (
          <View style={styles.statusDetails}>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Opening</Text>
              <Text style={styles.detailVal}>₹{Number(register.opening_balance || 0).toFixed(2)}</Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Cash Sales</Text>
              <Text style={styles.detailVal}>₹{Number(register.total_cash_sales || 0).toFixed(2)}</Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Card Sales</Text>
              <Text style={styles.detailVal}>₹{Number(register.total_card_sales || 0).toFixed(2)}</Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>UPI Sales</Text>
              <Text style={styles.detailVal}>₹{Number(register.total_upi_sales || 0).toFixed(2)}</Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Refunds (Cash)</Text>
              <Text style={[styles.detailVal, { color: Colors.error }]}>-₹{Number(register.total_refunds_cash || 0).toFixed(2)}</Text>
            </View>
            {(register.total_expenses_cash || 0) > 0 && (
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Expenses (Cash)</Text>
                <Text style={[styles.detailVal, { color: Colors.error }]}>-₹{Number(register.total_expenses_cash).toFixed(2)}</Text>
              </View>
            )}
            <View style={styles.divider} />
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Expected Cash</Text>
              <Text style={[styles.detailVal, { fontWeight: '700' }]}>₹{Number(register.expected_cash || 0).toFixed(2)}</Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Actual Cash</Text>
              <Text style={[styles.detailVal, { fontWeight: '700' }]}>₹{Number(register.actual_cash || 0).toFixed(2)}</Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={[styles.detailLabel, { fontWeight: '700' }]}>Discrepancy</Text>
              <Text style={[styles.detailVal, {
                fontWeight: '700',
                color: Math.abs(register.discrepancy || 0) < 1 ? Colors.success : Colors.error,
              }]}>
                ₹{Number(register.discrepancy || 0).toFixed(2)}
              </Text>
            </View>
          </View>
        )}
      </View>

      {/* Open form */}
      {!isOpen && (
        <View style={styles.formCard}>
          <Text style={styles.formTitle}>Open Register</Text>
          <Text style={styles.formLabel}>Opening Cash Balance</Text>
          <TextInput
            style={styles.input}
            value={openingBalance}
            onChangeText={setOpeningBalance}
            placeholder="₹ 0.00"
            placeholderTextColor={Colors.textLight}
            keyboardType="numeric"
          />
          <TouchableOpacity style={[styles.btn, submitting && { opacity: 0.6 }]} onPress={handleOpen} disabled={submitting}>
            {submitting ? <ActivityIndicator color={Colors.white} /> : (
              <>
                <Ionicons name="lock-open" size={18} color={Colors.white} />
                <Text style={styles.btnText}>Open Register</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      )}

      {/* Close form */}
      {isOpen && (
        <View style={styles.formCard}>
          <Text style={styles.formTitle}>Close Register</Text>
          <Text style={styles.formLabel}>Actual Cash in Drawer</Text>
          <TextInput
            style={styles.input}
            value={actualCash}
            onChangeText={setActualCash}
            placeholder="₹ 0.00"
            placeholderTextColor={Colors.textLight}
            keyboardType="numeric"
          />
          <Text style={styles.formLabel}>Closing Notes (optional)</Text>
          <TextInput
            style={[styles.input, { minHeight: 60 }]}
            value={closingNotes}
            onChangeText={setClosingNotes}
            placeholder="Any notes..."
            placeholderTextColor={Colors.textLight}
            multiline
          />
          <TouchableOpacity style={[styles.btn, { backgroundColor: Colors.error }, submitting && { opacity: 0.6 }]} onPress={handleClose} disabled={submitting}>
            {submitting ? <ActivityIndicator color={Colors.white} /> : (
              <>
                <Ionicons name="lock-closed" size={18} color={Colors.white} />
                <Text style={styles.btnText}>Close Register</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      )}

      {/* Today's Sessions Log */}
      {todaySessions.length > 1 && (
        <View style={styles.historySection}>
          <Text style={styles.formTitle}>Today's Sessions ({todaySessions.length})</Text>
          {todaySessions.map((s, idx) => (
            <View key={s.id} style={styles.histCard}>
              <View style={styles.histHeader}>
                <Text style={styles.histDate}>Session {todaySessions.length - idx}</Text>
                <Text style={[styles.histLoc, { color: s.closed_at ? Colors.textLight : Colors.success, fontWeight: s.closed_at ? '400' : '700' }]}>
                  {s.closed_at ? 'Closed' : 'Open'}
                </Text>
              </View>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Opening</Text>
                <Text style={styles.detailVal}>₹{Number(s.opening_balance || 0).toFixed(2)}</Text>
              </View>
              {s.closed_at && (
                <>
                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>Cash / Card / UPI</Text>
                    <Text style={styles.detailVal}>₹{Number(s.total_cash_sales || 0).toFixed(0)} / ₹{Number(s.total_card_sales || 0).toFixed(0)} / ₹{Number(s.total_upi_sales || 0).toFixed(0)}</Text>
                  </View>
                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>Discrepancy</Text>
                    <Text style={[styles.detailVal, { color: Math.abs(s.discrepancy || 0) < 1 ? Colors.success : Colors.error }]}>
                      ₹{Number(s.discrepancy || 0).toFixed(2)}
                    </Text>
                  </View>
                </>
              )}
              <Text style={styles.histMeta}>
                Opened: {s.opened_by_name}{s.closed_by_name ? ` • Closed: ${s.closed_by_name}` : ''}
              </Text>
            </View>
          ))}
        </View>
      )}

      {/* History toggle */}
      {canManage && (
        <View style={{ gap: Spacing.sm }}>
          <TouchableOpacity style={styles.historyBtn} onPress={() => navigation.navigate('Expenses')}>
            <Ionicons name="wallet" size={18} color={Colors.primary} />
            <Text style={styles.historyBtnText}>Manage Expenses</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.historyBtn} onPress={fetchHistory}>
            <Ionicons name="time" size={18} color={Colors.primary} />
            <Text style={styles.historyBtnText}>View Register History</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* History list */}
      {showHistory && history.length > 0 && (
        <View style={styles.historySection}>
          <Text style={styles.formTitle}>History</Text>
          {history.map((h) => (
            <View key={h.id} style={styles.histCard}>
              <View style={styles.histHeader}>
                <Text style={styles.histDate}>{h.date}</Text>
                <Text style={styles.histLoc}>{h.location_name}</Text>
              </View>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Opening</Text>
                <Text style={styles.detailVal}>₹{Number(h.opening_balance || 0).toFixed(2)}</Text>
              </View>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Cash / Card / UPI</Text>
                <Text style={styles.detailVal}>₹{Number(h.total_cash_sales || 0).toFixed(0)} / ₹{Number(h.total_card_sales || 0).toFixed(0)} / ₹{Number(h.total_upi_sales || 0).toFixed(0)}</Text>
              </View>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Discrepancy</Text>
                <Text style={[styles.detailVal, { color: Math.abs(h.discrepancy || 0) < 1 ? Colors.success : Colors.error }]}>
                  ₹{Number(h.discrepancy || 0).toFixed(2)}
                </Text>
              </View>
              <Text style={styles.histMeta}>Opened: {h.opened_by_name} • Closed: {h.closed_by_name || '-'}</Text>
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
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.background },

  locRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.xs, marginBottom: Spacing.md },
  locChip: {
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs + 2,
    borderRadius: BorderRadius.full, backgroundColor: Colors.surface,
    borderWidth: 1, borderColor: Colors.border,
  },
  locChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  locChipText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  locChipTextActive: { color: Colors.white, fontWeight: '600' },

  statusCard: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    borderWidth: 2, padding: Spacing.md,
  },
  statusHeader: { flexDirection: 'row', alignItems: 'center' },
  statusTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  statusSub: { fontSize: FontSize.xs, color: Colors.textLight, marginTop: 1 },
  statusDetails: { marginTop: Spacing.md },

  detailRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
  detailLabel: { fontSize: FontSize.sm, color: Colors.textSecondary },
  detailVal: { fontSize: FontSize.sm, color: Colors.text, fontWeight: '500' },
  divider: { height: 1, backgroundColor: Colors.border, marginVertical: Spacing.sm },

  formCard: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border, padding: Spacing.md, marginTop: Spacing.md,
  },
  formTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, marginBottom: Spacing.sm },
  formLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: Spacing.sm, marginBottom: Spacing.xs },
  input: {
    backgroundColor: Colors.background, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border,
    paddingHorizontal: Spacing.sm, paddingVertical: Spacing.sm,
    fontSize: FontSize.sm, color: Colors.text,
  },
  btn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.xs,
    backgroundColor: Colors.primary, borderRadius: BorderRadius.md,
    paddingVertical: Spacing.md, marginTop: Spacing.md,
  },
  btnText: { color: Colors.white, fontWeight: '600', fontSize: FontSize.sm },

  historyBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.xs,
    paddingVertical: Spacing.md, marginTop: Spacing.md,
  },
  historyBtnText: { color: Colors.primary, fontWeight: '600', fontSize: FontSize.sm },

  historySection: { marginTop: Spacing.sm },
  histCard: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border, padding: Spacing.md,
    marginBottom: Spacing.sm,
  },
  histHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: Spacing.xs },
  histDate: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.text },
  histLoc: { fontSize: FontSize.xs, color: Colors.textSecondary },
  histMeta: { fontSize: FontSize.xs, color: Colors.textLight, marginTop: Spacing.xs },
});
