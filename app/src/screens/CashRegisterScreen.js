import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TextInput,
  TouchableOpacity, Alert, ActivityIndicator, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Colors, FontSize, Spacing, BorderRadius, Shadows, TouchTarget } from '../constants/theme';

const formatTime = (timeStr) => {
  if (!timeStr) return '-';
  const d = new Date(timeStr);
  if (isNaN(d.getTime())) return timeStr;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const formatDate = (dateStr) => {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
};

const HistoryCard = ({ session, isToday }) => {
  const [expanded, setExpanded] = useState(false);

  const opening = Number(session.opening_balance || 0);
  const cashSales = Number(session.total_cash_sales || 0);
  const cashRefunds = Number(session.total_refunds_cash || 0);
  const expected = Number(session.expected_cash || 0);
  const actual = Number(session.actual_cash || 0);
  const discrepancy = Number(session.discrepancy || 0);
  
  // Dynamically derive Net Cash Expenses for closed sessions
  // expected = opening + cashSales - cashRefunds - netExpenses
  // netExpenses = opening + cashSales - cashRefunds - expected
  const inferredExpenses = opening + cashSales - cashRefunds - expected;
  const hasDiscrepancy = Math.abs(discrepancy) >= 1;

  return (
    <View style={styles.histCard}>
      <TouchableOpacity 
        style={styles.histHeaderBtn} 
        onPress={() => setExpanded(!expanded)}
        activeOpacity={0.7}
      >
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: Spacing.sm }}>
            <Text style={styles.histDate}>{isToday ? `Session (Today)` : formatDate(session.date)}</Text>
            <View style={[styles.statusBadge, { backgroundColor: session.closed_at ? Colors.surfaceAlt : Colors.successLight }]}>
              <Text style={[styles.statusBadgeText, { color: session.closed_at ? Colors.textSecondary : Colors.success }]}>
                {session.closed_at ? 'Closed' : 'Active'}
              </Text>
            </View>
          </View>
          <Text style={styles.histMeta}>
            {formatTime(session.opening_time || session.opened_at)} {session.closed_at ? `— ${formatTime(session.closing_time || session.closed_at)}` : '— Now'}
          </Text>
        </View>
        <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={20} color={Colors.textLight} />
      </TouchableOpacity>

      {expanded && (
        <View style={styles.histBody}>
          <View style={styles.histDivider} />
          
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Opening Balance</Text>
            <Text style={styles.detailVal}>₹{opening.toFixed(2)}</Text>
          </View>

          {session.closed_at && (
            <>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Cash Sales</Text>
                <Text style={[styles.detailVal, { color: Colors.success }]}>+₹{cashSales.toFixed(2)}</Text>
              </View>
              {cashRefunds > 0 && (
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Cash Refunds</Text>
                  <Text style={[styles.detailVal, { color: Colors.error }]}>-₹{cashRefunds.toFixed(2)}</Text>
                </View>
              )}
              {inferredExpenses > 0 ? (
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Net Cash Expenses</Text>
                  <Text style={[styles.detailVal, { color: Colors.error }]}>-₹{inferredExpenses.toFixed(2)}</Text>
                </View>
              ) : inferredExpenses < 0 ? (
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Net Cash Returns</Text>
                  <Text style={[styles.detailVal, { color: Colors.success }]}>+₹{Math.abs(inferredExpenses).toFixed(2)}</Text>
                </View>
              ) : null}

              <View style={styles.histDivider} />
              
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Expected Cash</Text>
                <Text style={[styles.detailVal, { fontWeight: '700' }]}>₹{expected.toFixed(2)}</Text>
              </View>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Actual Cash</Text>
                <Text style={[styles.detailVal, { fontWeight: '700' }]}>₹{actual.toFixed(2)}</Text>
              </View>
              <View style={styles.detailRow}>
                <Text style={[styles.detailLabel, { fontWeight: '700', color: hasDiscrepancy ? Colors.error : Colors.text }]}>Discrepancy</Text>
                <Text style={[styles.detailVal, { 
                  fontWeight: '700', 
                  color: hasDiscrepancy ? Colors.error : Colors.success 
                }]}>
                  ₹{discrepancy.toFixed(2)}
                </Text>
              </View>

              {/* Non-cash metrics */}
              <View style={{ marginTop: Spacing.sm, paddingTop: Spacing.sm, borderTopWidth: 1, borderTopColor: Colors.border, borderStyle: 'dashed' }}>
                <View style={styles.detailRow}>
                  <Text style={[styles.detailLabel, { fontSize: FontSize.xs }]}>Card / UPI Sales</Text>
                  <Text style={[styles.detailVal, { fontSize: FontSize.xs, color: Colors.textSecondary }]}>
                    ₹{Number(session.total_card_sales || 0).toFixed(0)} / ₹{Number(session.total_upi_sales || 0).toFixed(0)}
                  </Text>
                </View>
              </View>
            </>
          )}

          <View style={[styles.histDivider, { marginTop: Spacing.sm }]} />
          <View style={styles.footerRow}>
            <View style={styles.userBadge}>
              <Ionicons name="person-circle" size={16} color={Colors.textLight} />
              <Text style={styles.userBadgeText}>Opened: {session.opened_by_name || 'Unknown'}</Text>
            </View>
            {session.closed_at && (
              <View style={styles.userBadge}>
                <Ionicons name="person-circle" size={16} color={Colors.textLight} />
                <Text style={styles.userBadgeText}>Closed: {session.closed_by_name || 'Unknown'}</Text>
              </View>
            )}
          </View>
          {session.closing_notes ? (
            <Text style={styles.notesText}>Notes: {session.closing_notes}</Text>
          ) : null}
        </View>
      )}
    </View>
  );
};

export default function CashRegisterScreen({ navigation, route }) {
  const { user } = useAuth();
  const initialLocationId = route.params?.locationId;
  const canManage = user?.role === 'owner' || user?.role === 'manager';
  const isOwner = user?.role === 'owner';

  const [locations, setLocations] = useState([]);
  const [selectedLocation, setSelectedLocation] = useState(initialLocationId || null);
  const [register, setRegister] = useState(null);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  const [openingBalance, setOpeningBalance] = useState('');
  const [actualCash, setActualCash] = useState('');
  const [closingNotes, setClosingNotes] = useState('');
  
  const [history, setHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const [todaySessions, setTodaySessions] = useState([]);

  const [submitting, setSubmitting] = useState(false);
  const [pendingCodTotal, setPendingCodTotal] = useState(0);
  const [pendingCodDeliveries, setPendingCodDeliveries] = useState(0);

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
      setPendingCodTotal(res.pendingCodTotal || 0);
      setPendingCodDeliveries(res.pendingCodDeliveries || 0);
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
        fetchStatus(selectedLocation);
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
          fetchStatus(selectedLocation);
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
      if (showHistory) {
        setShowHistory(false);
        return;
      }
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

      {/* Pending COD Alert Banner */}
      {canManage && pendingCodTotal > 0 && (
        <TouchableOpacity
          style={styles.codBanner}
          onPress={() => navigation.navigate('Settlements', { locationId: selectedLocation })}
          activeOpacity={0.85}
        >
          <View style={styles.codBannerLeft}>
            <Ionicons name="alert-circle" size={20} color="#92400E" />
            <View>
              <Text style={styles.codBannerTitle}>Unsettled COD Cash</Text>
              <Text style={styles.codBannerSub}>
                ₹{Number(pendingCodTotal).toLocaleString('en-IN', { maximumFractionDigits: 0 })} from {pendingCodDeliveries} deliver{pendingCodDeliveries !== 1 ? 'ies' : 'y'} — not in register yet
              </Text>
            </View>
          </View>
          <View style={styles.codBannerAction}>
            <Text style={styles.codBannerActionText}>Settle</Text>
            <Ionicons name="chevron-forward" size={14} color="#92400E" />
          </View>
        </TouchableOpacity>
      )}

      {/* Main Status Hero */}
      <View style={[
        styles.heroCard, 
        isOpen ? styles.heroCardOpen : styles.heroCardClosed
      ]}>
        <View style={styles.heroHeader}>
          <View style={[styles.heroIconWrap, isOpen ? { backgroundColor: Colors.successLight } : { backgroundColor: Colors.surfaceAlt }]}>
            <Ionicons name={isOpen ? 'lock-open' : 'lock-closed'} size={28} color={isOpen ? Colors.success : Colors.textSecondary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.heroTitle}>{isOpen ? 'Register is Open' : 'Register is Closed'}</Text>
            <Text style={styles.heroSub}>
              {register ? (
                isOpen ? `Opened today at ${formatTime(register.opening_time || register.opened_at)}` 
                       : `Last closed at ${formatTime(register.closing_time || register.closed_at)}`
              ) : 'No recent sessions'}
            </Text>
          </View>
        </View>

        {register && isOpen && (
          <View style={styles.heroBody}>
            {isOwner ? (
              <View style={styles.liveCalculation}>
                <Text style={styles.liveCalcTitle}>Live Expected Cash</Text>
                
                <View style={styles.calcRow}>
                  <Text style={styles.calcLabel}>Opening Balance</Text>
                  <Text style={styles.calcVal}>₹{Number(register.opening_balance || 0).toFixed(2)}</Text>
                </View>
                
                <View style={styles.calcRow}>
                  <Text style={styles.calcLabel}>+ Cash Sales</Text>
                  <Text style={[styles.calcVal, { color: Colors.success }]}>₹{Number(register.total_cash_sales || 0).toFixed(2)}</Text>
                </View>

                {Number(register.total_refunds_cash || 0) > 0 && (
                  <View style={styles.calcRow}>
                    <Text style={styles.calcLabel}>- Cash Refunds</Text>
                    <Text style={[styles.calcVal, { color: Colors.error }]}>₹{Number(register.total_refunds_cash).toFixed(2)}</Text>
                  </View>
                )}

                {Number(register.total_expenses_cash || 0) > 0 ? (
                  <View style={styles.calcRow}>
                    <Text style={styles.calcLabel}>- Net Cash Expenses</Text>
                    <Text style={[styles.calcVal, { color: Colors.error }]}>₹{Number(register.total_expenses_cash).toFixed(2)}</Text>
                  </View>
                ) : Number(register.total_expenses_cash || 0) < 0 ? (
                  <View style={styles.calcRow}>
                    <Text style={styles.calcLabel}>+ Net Cash Returns</Text>
                    <Text style={[styles.calcVal, { color: Colors.success }]}>₹{Math.abs(Number(register.total_expenses_cash)).toFixed(2)}</Text>
                  </View>
                ) : null}

                <View style={styles.calcDivider} />
                <View style={styles.calcRow}>
                  <Text style={styles.calcTotalLabel}>Expected in Drawer</Text>
                  <Text style={styles.calcTotalVal}>
                    ₹{(
                      Number(register.opening_balance || 0) + 
                      Number(register.total_cash_sales || 0) - 
                      Number(register.total_refunds_cash || 0) - 
                      Number(register.total_expenses_cash || 0)
                    ).toFixed(2)}
                  </Text>
                </View>
              </View>
            ) : (
              <View style={{ gap: Spacing.sm }}>
                <View style={styles.calcRow}>
                  <Text style={styles.calcLabel}>Opening Balance</Text>
                  <Text style={styles.calcVal}>₹{Number(register.opening_balance || 0).toFixed(2)}</Text>
                </View>
                <View style={styles.calcRow}>
                  <Text style={styles.calcLabel}>Opened By</Text>
                  <Text style={styles.calcVal}>{register.opened_by_name || 'Unknown'}</Text>
                </View>
              </View>
            )}
          </View>
        )}
      </View>

      {/* Forms */}
      {!isOpen && (
        <View style={styles.formSection}>
          <Text style={styles.sectionTitle}>Start New Session</Text>
          <View style={styles.formCard}>
            <Text style={styles.formLabel}>Opening Cash Balance</Text>
            <View style={styles.inputWrap}>
              <Text style={styles.inputSymbol}>₹</Text>
              <TextInput
                style={styles.inputLarge}
                value={openingBalance}
                onChangeText={setOpeningBalance}
                placeholder="0.00"
                placeholderTextColor={Colors.textLight}
                keyboardType="numeric"
              />
            </View>
            <TouchableOpacity style={[styles.btnOpen, submitting && { opacity: 0.6 }]} onPress={handleOpen} disabled={submitting}>
              {submitting ? <ActivityIndicator color={Colors.white} /> : (
                <Text style={styles.btnOpenText}>Open Register</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      )}

      {isOpen && (
        <View style={styles.formSection}>
          <Text style={styles.sectionTitle}>Close Session</Text>
          <View style={styles.formCard}>
            <Text style={styles.formLabel}>Actual Cash in Drawer</Text>
            <View style={styles.inputWrap}>
              <Text style={styles.inputSymbol}>₹</Text>
              <TextInput
                style={styles.inputLarge}
                value={actualCash}
                onChangeText={setActualCash}
                placeholder="0.00"
                placeholderTextColor={Colors.textLight}
                keyboardType="numeric"
              />
            </View>
            
            <Text style={[styles.formLabel, { marginTop: Spacing.md }]}>Closing Notes (optional)</Text>
            <TextInput
              style={styles.inputArea}
              value={closingNotes}
              onChangeText={setClosingNotes}
              placeholder="Any discrepancies or notes..."
              placeholderTextColor={Colors.textLight}
              multiline
            />
            
            <TouchableOpacity style={[styles.btnClose, submitting && { opacity: 0.6 }]} onPress={handleClose} disabled={submitting}>
              {submitting ? <ActivityIndicator color={Colors.white} /> : (
                <Text style={styles.btnCloseText}>Close Register</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Actions */}
      {canManage && (
        <View style={styles.actionRow}>
          <TouchableOpacity style={styles.actionBtn} onPress={() => navigation.navigate('Expenses')}>
            <View style={[styles.actionIconWrap, { backgroundColor: Colors.infoLight }]}>
              <Ionicons name="wallet" size={20} color={Colors.info} />
            </View>
            <Text style={styles.actionBtnText}>Expenses</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.actionBtn} onPress={fetchHistory}>
            <View style={[styles.actionIconWrap, { backgroundColor: Colors.primaryLight }]}>
              <Ionicons name="list" size={20} color={Colors.primary} />
            </View>
            <Text style={styles.actionBtnText}>{showHistory ? 'Hide History' : 'View History'}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* History Sections */}
      {todaySessions.length > 0 && !showHistory && (
        <View style={styles.listSection}>
          <Text style={styles.sectionTitle}>Today's Sessions</Text>
          {todaySessions.map((s, idx) => (
            <HistoryCard key={`today-${s.id}`} session={s} isToday={true} />
          ))}
        </View>
      )}

      {showHistory && history.length > 0 && (
        <View style={styles.listSection}>
          <Text style={styles.sectionTitle}>Register History</Text>
          {history.map((h) => (
            <HistoryCard key={`hist-${h.id}`} session={h} isToday={false} />
          ))}
        </View>
      )}

      <View style={{ height: 60 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.md, maxWidth: 800, alignSelf: 'center', width: '100%' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.background },

  locRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm, marginBottom: Spacing.lg },
  locChip: {
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.full, backgroundColor: Colors.surface,
    borderWidth: 1, borderColor: Colors.border,
  },
  locChipActive: { backgroundColor: Colors.text, borderColor: Colors.text },
  locChipText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '500' },
  locChipTextActive: { color: Colors.white },

  codBanner: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: '#FEF3C7', borderRadius: BorderRadius.lg,
    borderWidth: 1, borderColor: '#FDE68A',
    padding: Spacing.md, marginBottom: Spacing.md,
  },
  codBannerLeft: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },
  codBannerTitle: { fontSize: FontSize.sm, fontWeight: '700', color: '#92400E' },
  codBannerSub: { fontSize: FontSize.xs, color: '#92400E', marginTop: 2, opacity: 0.8 },
  codBannerAction: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: '#FDE68A', paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: BorderRadius.sm,
  },
  codBannerActionText: { fontSize: FontSize.xs, fontWeight: '700', color: '#92400E' },


  heroCard: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.xl,
    padding: Spacing.lg,
    ...Shadows.md,
    marginBottom: Spacing.lg,
    borderWidth: 1,
  },
  heroCardOpen: { borderColor: Colors.successLight },
  heroCardClosed: { borderColor: Colors.border },
  
  heroHeader: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  heroIconWrap: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  heroTitle: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },
  heroSub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  
  heroBody: { marginTop: Spacing.lg, paddingTop: Spacing.lg, borderTopWidth: 1, borderTopColor: Colors.border },
  
  liveCalculation: { backgroundColor: Colors.surfaceAlt, borderRadius: BorderRadius.md, padding: Spacing.md },
  liveCalcTitle: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.textSecondary, marginBottom: Spacing.sm },
  calcRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  calcLabel: { fontSize: FontSize.sm, color: Colors.text },
  calcVal: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  calcDivider: { height: 1, backgroundColor: Colors.border, marginVertical: Spacing.sm },
  calcTotalLabel: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  calcTotalVal: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },

  formSection: { marginBottom: Spacing.lg },
  sectionTitle: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text, marginBottom: Spacing.sm },
  formCard: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.xl,
    padding: Spacing.lg, ...Shadows.sm, borderWidth: 1, borderColor: Colors.border
  },
  formLabel: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.textSecondary, marginBottom: Spacing.xs },
  
  inputWrap: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: Colors.surfaceAlt, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border,
    paddingHorizontal: Spacing.md,
  },
  inputSymbol: { fontSize: FontSize.xl, fontWeight: '500', color: Colors.textSecondary, marginRight: Spacing.sm },
  inputLarge: {
    flex: 1, fontSize: FontSize.xl, fontWeight: '700', color: Colors.text,
    paddingVertical: Spacing.md, minHeight: TouchTarget.minHeight,
  },
  inputArea: {
    backgroundColor: Colors.surfaceAlt, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border,
    padding: Spacing.md, fontSize: FontSize.md, color: Colors.text,
    minHeight: 80, textAlignVertical: 'top',
  },

  btnOpen: { backgroundColor: Colors.text, borderRadius: BorderRadius.md, padding: Spacing.md, alignItems: 'center', marginTop: Spacing.lg },
  btnOpenText: { color: Colors.white, fontSize: FontSize.md, fontWeight: '700' },
  btnClose: { backgroundColor: Colors.error, borderRadius: BorderRadius.md, padding: Spacing.md, alignItems: 'center', marginTop: Spacing.lg },
  btnCloseText: { color: Colors.white, fontSize: FontSize.md, fontWeight: '700' },

  actionRow: { flexDirection: 'row', gap: Spacing.md, marginBottom: Spacing.xl },
  actionBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm,
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg, padding: Spacing.md,
    borderWidth: 1, borderColor: Colors.border, ...Shadows.sm
  },
  actionIconWrap: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  actionBtnText: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },

  listSection: { gap: Spacing.sm },
  histCard: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg,
    borderWidth: 1, borderColor: Colors.border, ...Shadows.sm,
    overflow: 'hidden',
  },
  histHeaderBtn: { flexDirection: 'row', alignItems: 'center', padding: Spacing.md, backgroundColor: Colors.surface },
  histDate: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: BorderRadius.full },
  statusBadgeText: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase' },
  histMeta: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 4 },
  
  histBody: { padding: Spacing.md, paddingTop: 0, backgroundColor: Colors.surfaceAlt },
  histDivider: { height: 1, backgroundColor: Colors.border, marginVertical: Spacing.sm },
  detailRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  detailLabel: { fontSize: FontSize.sm, color: Colors.textSecondary },
  detailVal: { fontSize: FontSize.sm, fontWeight: '500', color: Colors.text },
  
  footerRow: { flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: Spacing.sm },
  userBadge: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  userBadgeText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  notesText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontStyle: 'italic', marginTop: Spacing.sm },
});
