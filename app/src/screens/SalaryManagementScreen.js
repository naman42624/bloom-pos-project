import React, { useState, useCallback, useMemo } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  RefreshControl, Alert, Modal, TextInput, ActivityIndicator, Platform, KeyboardAvoidingView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';
import { formatDate } from '../utils/datetime';
import DateTimePickerModal from '../components/DateTimePickerModal';

const SALARY_TYPES = [
  { label: 'Monthly', value: 'monthly' },
  { label: 'Daily', value: 'daily' },
  { label: 'Hourly', value: 'hourly' },
];

function formatCurrency(val) {
  if (!val && val !== 0) return '—';
  return '₹' + Number(val).toLocaleString('en-IN');
}

// 'YYYY-MM-DD' -> Date (local midnight). Returns null for empty/invalid input
// so the picker opens on "now" instead of a bogus date — no equivalent helper
// existed elsewhere in app/src/utils to reuse (ShiftManagementScreen's
// hhmmToDate/dateToHHMM are 'HH:MM'-only, not applicable here).
const ymdToDate = (ymd) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd || '');
  if (!m) return null;
  const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
  return isNaN(d.getTime()) ? null : d;
};

// Date -> 'YYYY-MM-DD' (zero-padded). Matches the string shape periodStart/
// periodEnd's state, handleCalculatePayroll, handleDisburse, and the backend
// all expect unchanged.
const dateToYMD = (date) => {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

export default function SalaryManagementScreen() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [salaries, setSalaries] = useState([]);
  const [unsetStaff, setUnsetStaff] = useState([]);
  const [modal, setModal] = useState(false);
  const [historyModal, setHistoryModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState([]);
  const [historyUser, setHistoryUser] = useState(null);

  // Form state
  const [editUser, setEditUser] = useState(null);
  const [amount, setAmount] = useState('');
  const [salaryType, setSalaryType] = useState('monthly');
  const [notes, setNotes] = useState('');

  // Payroll state
  const [viewTab, setViewTab] = useState('salaries'); // 'salaries' | 'payroll'
  const [payrollModal, setPayrollModal] = useState(false);
  const [payrollCalc, setPayrollCalc] = useState(null);
  const [payrollCalculating, setPayrollCalculating] = useState(false);
  const [payrollUser, setPayrollUser] = useState(null);
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  // Which period field the shared DateTimePickerModal is currently editing, and the
  // Date it should open showing. pickerValue is set ONCE (in openPeriodPicker) rather
  // than recomputed inline on every render — see ShiftManagementScreen.js's identical
  // pattern/comment: DateTimePickerModal resets its local spinner state whenever the
  // `value` prop's object identity changes, so a fresh Date() on every render would
  // silently discard an in-progress selection on an unrelated parent re-render.
  const [periodPickerTarget, setPeriodPickerTarget] = useState(null); // null | 'periodStart' | 'periodEnd'
  const [periodPickerValue, setPeriodPickerValue] = useState(new Date());
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [paymentRef, setPaymentRef] = useState('');
  const [bonusAmount, setBonusAmount] = useState('');
  const [payrollHistory, setPayrollHistory] = useState([]);
  const [payrollHistoryLoading, setPayrollHistoryLoading] = useState(false);
  const [confirmedHalfDays, setConfirmedHalfDays] = useState([]); // array of 'YYYY-MM-DD' date strings
  // This employee's own payment history (not the global payrollHistory list above),
  // fetched fresh each time the payroll modal opens — used to warn/block on a
  // period that overlaps a payment already made, mirroring the same overlap rule
  // POST /staff/payroll/disburse enforces server-side, but surfaced BEFORE the
  // manager taps Disburse rather than only as an error after (staff-ux-checklist #6).
  const [employeePayments, setEmployeePayments] = useState([]);

  const fetchData = useCallback(async () => {
    try {
      const res = await api.getSalaries();
      setSalaries(res.data?.salaries || []);
      setUnsetStaff(res.data?.unset || []);
    } catch (e) {
      console.error('Fetch salaries error:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { fetchData(); }, [fetchData]));

  const openSetModal = (staffMember, existing = null) => {
    setEditUser(staffMember);
    setAmount(existing ? String(existing.monthly_salary) : '');
    setSalaryType(existing?.salary_type || 'monthly');
    setNotes('');
    setModal(true);
  };

  const handleSave = async () => {
    if (!editUser || !amount || Number(amount) <= 0) {
      Alert.alert('Error', 'Please enter a valid salary amount.');
      return;
    }
    setSaving(true);
    try {
      await api.setSalary({
        user_id: editUser.id || editUser.user_id,
        monthly_salary: Number(amount),
        salary_type: salaryType,
        notes: notes.trim() || undefined,
      });
      setModal(false);
      await fetchData();
    } catch (e) {
      Alert.alert('Error', e.message || 'Failed to save salary.');
    } finally {
      setSaving(false);
    }
  };

  const viewHistory = async (sal) => {
    setHistoryUser(sal);
    try {
      const res = await api.getSalaryHistory(sal.user_id);
      setHistory(res.data || []);
      setHistoryModal(true);
    } catch (e) {
      Alert.alert('Error', e.message || 'Failed to load history.');
    }
  };

  // ─── Payroll functions ──────────────────────────────────
  const getDefaultPeriod = () => {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth(); // 0-indexed
    const start = `${y}-${String(m + 1).padStart(2, '0')}-01`;
    const lastDay = new Date(y, m + 1, 0).getDate();
    const end = `${y}-${String(m + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    return { start, end };
  };

  const openPayrollModal = (sal) => {
    setPayrollUser(sal);
    const { start, end } = getDefaultPeriod();
    setPeriodStart(start);
    setPeriodEnd(end);
    setPayrollCalc(null);
    setPaymentMethod('cash');
    setPaymentRef('');
    setBonusAmount('');
    setConfirmedHalfDays([]);
    // Reset before the fetch resolves so a previously-opened employee's payments
    // can't briefly leak into this modal's overlap check for the newly-selected one.
    setEmployeePayments([]);
    api.getPayrollHistory({ user_id: sal.user_id, limit: 100 })
      .then((res) => setEmployeePayments(res.data?.payments || []))
      .catch(() => setEmployeePayments([]));
    setPayrollModal(true);
  };

  const handleCalculatePayroll = async (datesOverride) => {
    if (!periodStart || !periodEnd) {
      Alert.alert('Error', 'Please enter period dates.');
      return;
    }
    const confirmedDates = datesOverride !== undefined ? datesOverride : confirmedHalfDays;
    setPayrollCalculating(true);
    try {
      const res = await api.calculatePayroll({
        user_id: payrollUser.user_id || payrollUser.id,
        period_start: periodStart,
        period_end: periodEnd,
        confirmed_half_day_dates: confirmedDates,
      });
      setPayrollCalc(res.data);
    } catch (e) {
      Alert.alert('Error', e.message || 'Failed to calculate.');
    } finally {
      setPayrollCalculating(false);
    }
  };

  // Toggle a partial-day date's confirmed-as-half-day state and immediately
  // re-run the calculation with the new list (reads current state directly —
  // this runs once per tap, so there's no staleness — rather than via the
  // async setConfirmedHalfDays updater, which would require the recalculate
  // call to live inside the updater function as a side effect).
  const toggleHalfDay = (date) => {
    const next = confirmedHalfDays.includes(date)
      ? confirmedHalfDays.filter((d) => d !== date)
      : [...confirmedHalfDays, date];
    setConfirmedHalfDays(next);
    handleCalculatePayroll(next);
  };

  // Opens the shared picker for a given period field, computing its starting Date
  // ONCE (from the field's current 'YYYY-MM-DD' string, or "now" if empty/unset) so
  // it opens pre-set to the existing date — see the periodPickerValue state comment
  // above for why this must be a one-time computation rather than recomputed on render.
  const openPeriodPicker = (target, currentYMD) => {
    setPeriodPickerValue(ymdToDate(currentYMD) || new Date());
    setPeriodPickerTarget(target);
  };

  const handlePeriodPickerConfirm = (date) => {
    const ymd = dateToYMD(date);
    if (periodPickerTarget === 'periodStart') setPeriodStart(ymd);
    else if (periodPickerTarget === 'periodEnd') setPeriodEnd(ymd);
    setPeriodPickerTarget(null);
  };

  // Mirrors POST /staff/payroll/disburse's own overlap query exactly (server/routes/
  // staff-management.js, 'SELECT id, period_start, period_end FROM salary_payments
  // WHERE user_id = ? AND status != ? AND period_start <= ? AND period_end >= ?' with
  // params (user_id, 'cancelled', period_end, period_start)): same exclusion
  // (status !== 'cancelled'), same two comparisons, same direction. Recomputes
  // whenever the selected period or the fetched history changes.
  const overlappingPayment = useMemo(() => {
    if (!periodStart || !periodEnd) return null;
    return employeePayments.find((p) => p.status !== 'cancelled' && p.period_start <= periodEnd && p.period_end >= periodStart) || null;
  }, [periodStart, periodEnd, employeePayments]);

  // Quiet reference note (only shown when there's no overlap warning to show instead) —
  // the most recent non-cancelled payment by period_end, so the manager has a natural
  // anchor point before picking dates at all.
  const mostRecentPayment = useMemo(() => {
    return employeePayments
      .filter((p) => p.status !== 'cancelled')
      .reduce((latest, p) => (!latest || p.period_end > latest.period_end ? p : latest), null);
  }, [employeePayments]);

  const handleDisburse = async () => {
    if (!payrollCalc) return;
    const bonus = Number(bonusAmount) || 0;
    const advDeduct = payrollCalc.calculation.pending_advances;
    const finalNet = payrollCalc.calculation.net_amount + bonus - advDeduct;

    const doDisburse = async () => {
      setSaving(true);
      try {
        await api.disburseSalary({
          user_id: payrollUser.user_id || payrollUser.id,
          period_start: periodStart,
          period_end: periodEnd,
          base_salary: payrollCalc.calculation.base_pay,
          days_worked: payrollCalc.attendance_summary.days_worked,
          days_in_period: payrollCalc.period.days,
          hours_worked: payrollCalc.attendance_summary.total_hours,
          late_days: payrollCalc.attendance_summary.late_days,
          absent_days: payrollCalc.attendance_summary.absent_days,
          leaves_taken: payrollCalc.attendance_summary.leave_days,
          deductions: payrollCalc.calculation.deductions,
          advances_deducted: advDeduct,
          bonus,
          net_amount: Math.max(0, finalNet),
          payment_method: paymentMethod,
          payment_reference: paymentRef,
        });
        setPayrollModal(false);
        Alert.alert('Success', `Salary of ${formatCurrency(Math.max(0, finalNet))} disbursed.`);
        fetchPayrollHistory();
      } catch (e) {
        Alert.alert('Error', e.message || 'Failed to disburse.');
      } finally {
        setSaving(false);
      }
    };

    if (Platform.OS === 'web') {
      if (window.confirm(`Disburse ${formatCurrency(Math.max(0, finalNet))} to ${payrollCalc.user.name}?`)) doDisburse();
    } else {
      Alert.alert('Confirm Payment', `Disburse ${formatCurrency(Math.max(0, finalNet))} to ${payrollCalc.user.name}?`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Pay', onPress: doDisburse },
      ]);
    }
  };

  const fetchPayrollHistory = async () => {
    setPayrollHistoryLoading(true);
    try {
      const res = await api.getPayrollHistory();
      setPayrollHistory(res.data?.payments || []);
    } catch (e) {
      console.error('Fetch payroll error:', e);
    } finally {
      setPayrollHistoryLoading(false);
    }
  };

  const roleBadge = (role) => {
    const colors = { manager: Colors.roleManager, employee: Colors.roleEmployee, delivery_partner: Colors.roleDelivery };
    const labels = { manager: 'Manager', employee: 'Employee', delivery_partner: 'Delivery' };
    return (
      <View style={[styles.badge, { backgroundColor: colors[role] || Colors.textLight }]}>
        <Text style={styles.badgeText}>{labels[role] || role}</Text>
      </View>
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
      {/* Tab Toggle */}
      {user?.role === 'owner' && (
        <View style={styles.tabRow}>
          <TouchableOpacity
            style={[styles.tabBtn, viewTab === 'salaries' && styles.tabBtnActive]}
            onPress={() => setViewTab('salaries')}
          >
            <Ionicons name="wallet-outline" size={18} color={viewTab === 'salaries' ? '#fff' : Colors.textSecondary} />
            <Text style={[styles.tabBtnText, viewTab === 'salaries' && styles.tabBtnTextActive]}>Salaries</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.tabBtn, viewTab === 'payroll' && styles.tabBtnActive]}
            onPress={() => { setViewTab('payroll'); if (payrollHistory.length === 0) fetchPayrollHistory(); }}
          >
            <Ionicons name="cash-outline" size={18} color={viewTab === 'payroll' ? '#fff' : Colors.textSecondary} />
            <Text style={[styles.tabBtnText, viewTab === 'payroll' && styles.tabBtnTextActive]}>Payroll</Text>
          </TouchableOpacity>
        </View>
      )}

      {viewTab === 'salaries' && (<>
      {/* Staff without salaries */}
      {unsetStaff.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Salary Not Set</Text>
          {unsetStaff.map(s => (
            <TouchableOpacity
              key={s.id}
              style={styles.unsetCard}
              onPress={() => openSetModal(s)}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.cardName}>{s.name}</Text>
                <View style={styles.metaRow}>
                  {roleBadge(s.role)}
                  <Text style={styles.metaText}>{s.phone}</Text>
                </View>
              </View>
              <View style={styles.setBtn}>
                <Ionicons name="add-circle" size={24} color={Colors.primary} />
                <Text style={styles.setBtnText}>Set</Text>
              </View>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Staff with salaries */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>
          Staff Salaries {salaries.length > 0 ? `(${salaries.length})` : ''}
        </Text>
        {salaries.length === 0 && unsetStaff.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="wallet-outline" size={48} color={Colors.textLight} />
            <Text style={styles.emptyText}>No staff members yet</Text>
          </View>
        ) : (
          salaries.map(s => (
            <View key={s.id} style={styles.card}>
              <View style={styles.cardHeader}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardName}>{s.user_name}</Text>
                  <View style={styles.metaRow}>
                    {roleBadge(s.user_role)}
                  </View>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={styles.salaryAmount}>{formatCurrency(s.monthly_salary)}</Text>
                  <Text style={styles.salaryType}>
                    {s.salary_type === 'monthly' ? '/month' : s.salary_type === 'daily' ? '/day' : '/hour'}
                  </Text>
                </View>
              </View>
              <View style={styles.cardFooter}>
                <TouchableOpacity style={styles.linkBtn} onPress={() => openSetModal(s, s)}>
                  <Ionicons name="create-outline" size={16} color={Colors.primary} />
                  <Text style={styles.linkBtnText}>Update</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.linkBtn} onPress={() => viewHistory(s)}>
                  <Ionicons name="time-outline" size={16} color={Colors.info} />
                  <Text style={[styles.linkBtnText, { color: Colors.info }]}>History</Text>
                </TouchableOpacity>
              </View>
            </View>
          ))
        )}
      </View>
      </>)}

      {/* ─── Payroll Tab ─────────────────────────────────── */}
      {viewTab === 'payroll' && (
        <View>
          {/* Pay Salary buttons for each staff */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Pay Salary</Text>
            {salaries.length === 0 ? (
              <Text style={{ color: Colors.textLight, textAlign: 'center', paddingVertical: Spacing.lg }}>
                Set salaries first to use payroll.
              </Text>
            ) : (
              salaries.map(s => (
                <TouchableOpacity key={s.id} style={styles.card} onPress={() => openPayrollModal(s)}>
                  <View style={styles.cardHeader}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.cardName}>{s.user_name}</Text>
                      <View style={styles.metaRow}>
                        {roleBadge(s.user_role)}
                        <Text style={styles.metaText}>{formatCurrency(s.monthly_salary)}/{s.salary_type === 'monthly' ? 'mo' : s.salary_type === 'daily' ? 'day' : 'hr'}</Text>
                      </View>
                      {s.pending_advance_amount > 0 && (
                        <View style={styles.advanceBadge}>
                          <Ionicons name="alert-circle-outline" size={12} color={Colors.warning} />
                          <Text style={styles.advanceBadgeText}>{formatCurrency(s.pending_advance_amount)} advance pending</Text>
                        </View>
                      )}
                    </View>
                    <View style={[styles.payBtn]}>
                      <Ionicons name="cash" size={20} color={Colors.success} />
                      <Text style={{ color: Colors.success, fontSize: FontSize.sm, fontWeight: '600' }}>Pay</Text>
                    </View>
                  </View>
                </TouchableOpacity>
              ))
            )}
          </View>

          {/* Payment History */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Payment History</Text>
            {payrollHistoryLoading ? (
              <ActivityIndicator color={Colors.primary} style={{ paddingVertical: Spacing.lg }} />
            ) : payrollHistory.length === 0 ? (
              <Text style={{ color: Colors.textLight, textAlign: 'center', paddingVertical: Spacing.lg }}>
                No payments yet.
              </Text>
            ) : (
              payrollHistory.map(p => (
                <View key={p.id} style={styles.card}>
                  <View style={styles.cardHeader}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.cardName}>{p.user_name}</Text>
                      <Text style={styles.metaText}>
                        {p.period_start} to {p.period_end}
                      </Text>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text style={styles.salaryAmount}>{formatCurrency(p.net_amount)}</Text>
                      <Text style={[styles.salaryType, { color: p.status === 'paid' ? Colors.success : Colors.warning }]}>
                        {p.status === 'paid' ? 'Paid' : 'Pending'}
                      </Text>
                    </View>
                  </View>
                  <View style={{ paddingHorizontal: Spacing.md, paddingBottom: Spacing.sm }}>
                    <Text style={{ fontSize: FontSize.xs, color: Colors.textLight }}>
                      {p.days_worked} days worked • {p.late_days} late • {p.absent_days} absent
                      {p.advances_deducted > 0 ? ` • Adv: -${formatCurrency(p.advances_deducted)}` : ''}
                      {p.bonus > 0 ? ` • Bonus: +${formatCurrency(p.bonus)}` : ''}
                    </Text>
                    {p.paid_at && (
                      <Text style={{ fontSize: FontSize.xs, color: Colors.textLight, marginTop: 2 }}>
                        Paid on {formatDate(p.paid_at)} via {p.payment_method} • by {p.paid_by_name}
                      </Text>
                    )}
                  </View>
                </View>
              ))
            )}
          </View>
        </View>
      )}

      {/* ─── Set/Update Salary Modal ─────────────────────── */}
      <Modal visible={modal} transparent animationType="slide" onRequestClose={() => setModal(false)}>
        <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>
              {editUser ? `Set Salary — ${editUser.name || editUser.user_name}` : 'Set Salary'}
            </Text>

            <Text style={styles.label}>Salary Amount (₹)</Text>
            <TextInput
              style={styles.input}
              value={amount}
              onChangeText={setAmount}
              keyboardType="numeric"
              placeholder="e.g. 15000"
              placeholderTextColor={Colors.textLight}
            />

            <Text style={styles.label}>Type</Text>
            <View style={styles.typeRow}>
              {SALARY_TYPES.map(t => (
                <TouchableOpacity
                  key={t.value}
                  style={[styles.typeChip, salaryType === t.value && styles.typeChipActive]}
                  onPress={() => setSalaryType(t.value)}
                >
                  <Text style={[styles.typeChipText, salaryType === t.value && styles.typeChipTextActive]}>
                    {t.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.label}>Reason / Notes</Text>
            <TextInput
              style={[styles.input, { height: 60 }]}
              value={notes}
              onChangeText={setNotes}
              placeholder="Optional — reason for change"
              placeholderTextColor={Colors.textLight}
              multiline
            />

            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => setModal(false)}>
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.saveBtn} onPress={handleSave} disabled={saving}>
                <Text style={styles.saveBtnText}>{saving ? 'Saving...' : 'Save'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ─── Salary History Modal ────────────────────────── */}
      <Modal visible={historyModal} transparent animationType="slide" onRequestClose={() => setHistoryModal(false)}>
        <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>
              Salary History — {historyUser?.user_name}
            </Text>
            {history.length === 0 ? (
              <Text style={styles.emptyText}>No salary changes recorded.</Text>
            ) : (
              <ScrollView style={{ maxHeight: 300 }}>
                {history.map(h => (
                  <View key={h.id} style={styles.historyRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.historyChange}>
                        {formatCurrency(h.old_salary)} → {formatCurrency(h.new_salary)}
                      </Text>
                      {h.reason ? <Text style={styles.historyReason}>{h.reason}</Text> : null}
                      <Text style={styles.historyMeta}>
                        by {h.changed_by_name} • {formatDate(h.created_at)}
                      </Text>
                    </View>
                  </View>
                ))}
              </ScrollView>
            )}
            <TouchableOpacity
              style={[styles.saveBtn, { alignSelf: 'flex-end', marginTop: Spacing.md }]}
              onPress={() => setHistoryModal(false)}
            >
              <Text style={styles.saveBtnText}>Close</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ─── Payroll Calculation Modal ───────────────────── */}
      <Modal visible={payrollModal} transparent animationType="slide" onRequestClose={() => setPayrollModal(false)}>
        <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView style={styles.modalContent} bounces={false} keyboardShouldPersistTaps="handled">
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.md }}>
              <Text style={styles.modalTitle}>Pay Salary — {payrollUser?.user_name || payrollUser?.name}</Text>
              <TouchableOpacity onPress={() => setPayrollModal(false)}>
                <Ionicons name="close" size={24} color={Colors.text} />
              </TouchableOpacity>
            </View>

            {/* Period input */}
            <View style={styles.timeInputRow}>
              <View style={{ flex: 1, marginRight: Spacing.sm }}>
                <Text style={styles.label}>Period Start</Text>
                <TouchableOpacity
                  style={[styles.input, styles.datePickerBtn]}
                  onPress={() => openPeriodPicker('periodStart', periodStart)}
                >
                  <Ionicons name="calendar-outline" size={18} color={periodStart ? Colors.primary : Colors.textLight} />
                  <Text style={periodStart ? styles.inputValueText : styles.inputPlaceholderText}>
                    {periodStart || 'YYYY-MM-DD'}
                  </Text>
                </TouchableOpacity>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>Period End</Text>
                <TouchableOpacity
                  style={[styles.input, styles.datePickerBtn]}
                  onPress={() => openPeriodPicker('periodEnd', periodEnd)}
                >
                  <Ionicons name="calendar-outline" size={18} color={periodEnd ? Colors.primary : Colors.textLight} />
                  <Text style={periodEnd ? styles.inputValueText : styles.inputPlaceholderText}>
                    {periodEnd || 'YYYY-MM-DD'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>

            {overlappingPayment ? (
              <View style={styles.overlapWarning}>
                <Ionicons name="warning-outline" size={18} color={Colors.error} />
                <Text style={styles.overlapWarningText}>
                  This period overlaps a payment already made: {formatCurrency(overlappingPayment.net_amount)} for {overlappingPayment.period_start} to {overlappingPayment.period_end}. Adjust the dates to avoid double-paying.
                </Text>
              </View>
            ) : mostRecentPayment ? (
              <Text style={styles.lastPaidNote}>Last paid through: {mostRecentPayment.period_end}</Text>
            ) : null}

            <TouchableOpacity
              style={[styles.saveBtn, { marginTop: Spacing.md, alignSelf: 'stretch', alignItems: 'center' }]}
              onPress={() => handleCalculatePayroll()}
              disabled={payrollCalculating}
            >
              <Text style={styles.saveBtnText}>{payrollCalculating ? 'Calculating...' : 'Calculate'}</Text>
            </TouchableOpacity>

            {/* Calculation results */}
            {payrollCalc && (
              <View style={{ marginTop: Spacing.lg }}>
                <Text style={[styles.sectionTitle, { marginBottom: Spacing.sm }]}>Attendance Summary</Text>
                <View style={styles.summaryGrid}>
                  <View style={styles.summaryItem}>
                    <Text style={styles.summaryValue}>{payrollCalc.attendance_summary.days_worked}</Text>
                    <Text style={styles.summaryLabel}>Days Worked</Text>
                  </View>
                  <View style={styles.summaryItem}>
                    <Text style={styles.summaryValue}>{payrollCalc.attendance_summary.absent_days}</Text>
                    <Text style={styles.summaryLabel}>Absent</Text>
                  </View>
                  <View style={styles.summaryItem}>
                    <Text style={styles.summaryValue}>{payrollCalc.attendance_summary.late_days}</Text>
                    <Text style={styles.summaryLabel}>Late</Text>
                  </View>
                  <View style={styles.summaryItem}>
                    <Text style={styles.summaryValue}>{payrollCalc.attendance_summary.leave_days}</Text>
                    <Text style={styles.summaryLabel}>Leaves</Text>
                  </View>
                  <View style={styles.summaryItem}>
                    <Text style={styles.summaryValue}>{payrollCalc.attendance_summary.total_hours}h</Text>
                    <Text style={styles.summaryLabel}>Hours</Text>
                  </View>
                  <View style={styles.summaryItem}>
                    <Text style={styles.summaryValue}>{payrollCalc.period.days}</Text>
                    <Text style={styles.summaryLabel}>Period Days</Text>
                  </View>
                </View>

                {payrollCalc.partial_days && payrollCalc.partial_days.length > 0 && (
                  <View style={{ marginTop: Spacing.md }}>
                    <Text style={styles.sectionTitle}>Partial Days Found</Text>
                    <Text style={{ fontSize: FontSize.sm, color: Colors.textLight, marginBottom: Spacing.sm }}>
                      This employee has a split shift. On these dates they attended only some of their scheduled shifts — check the box for any that should count as a half day.
                    </Text>
                    {payrollCalc.partial_days.map((pd) => {
                      const isConfirmed = confirmedHalfDays.includes(pd.date);
                      return (
                        <TouchableOpacity
                          key={pd.date}
                          style={[styles.partialDayRow, payrollCalculating && { opacity: 0.5 }]}
                          onPress={() => toggleHalfDay(pd.date)}
                          disabled={payrollCalculating}
                        >
                          <Ionicons name={isConfirmed ? 'checkbox' : 'square-outline'} size={22} color={Colors.primary} />
                          <View style={{ flex: 1, marginLeft: Spacing.sm }}>
                            <Text style={styles.partialDayDate}>{pd.date}</Text>
                            <Text style={styles.partialDaySub}>Attended {pd.attended_segments} of {pd.total_segments} shifts that day</Text>
                          </View>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                )}

                <Text style={[styles.sectionTitle, { marginTop: Spacing.md, marginBottom: Spacing.sm }]}>Salary Breakdown</Text>
                {payrollCalculating && (
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.sm }}>
                    <ActivityIndicator size="small" color={Colors.primary} />
                    <Text style={{ fontSize: FontSize.sm, color: Colors.textLight, marginLeft: Spacing.xs }}>
                      Updating…
                    </Text>
                  </View>
                )}
                <View style={styles.breakdownRow}>
                  <Text style={styles.breakdownLabel}>Base Pay</Text>
                  <Text style={styles.breakdownValue}>{formatCurrency(payrollCalc.calculation.base_pay)}</Text>
                </View>
                {payrollCalc.calculation.deductions > 0 && (
                  <View style={styles.breakdownRow}>
                    <Text style={[styles.breakdownLabel, { color: Colors.error }]}>Deductions (absence)</Text>
                    <Text style={[styles.breakdownValue, { color: Colors.error }]}>−{formatCurrency(payrollCalc.calculation.deductions)}</Text>
                  </View>
                )}
                {payrollCalc.calculation.pending_advances > 0 && (
                  <View style={styles.breakdownRow}>
                    <Text style={[styles.breakdownLabel, { color: Colors.warning }]}>Advance Deduction</Text>
                    <Text style={[styles.breakdownValue, { color: Colors.warning }]}>−{formatCurrency(payrollCalc.calculation.pending_advances)}</Text>
                  </View>
                )}

                {/* Bonus */}
                <Text style={styles.label}>Bonus (optional)</Text>
                <TextInput
                  style={styles.input}
                  value={bonusAmount}
                  onChangeText={setBonusAmount}
                  keyboardType="numeric"
                  placeholder="0"
                  placeholderTextColor={Colors.textLight}
                />

                {/* Payment method */}
                <Text style={styles.label}>Payment Method</Text>
                <View style={styles.typeRow}>
                  {[{ label: 'Cash', value: 'cash' }, { label: 'UPI', value: 'upi' }, { label: 'Bank', value: 'bank_transfer' }].map(t => (
                    <TouchableOpacity key={t.value} style={[styles.typeChip, paymentMethod === t.value && styles.typeChipActive]} onPress={() => setPaymentMethod(t.value)}>
                      <Text style={[styles.typeChipText, paymentMethod === t.value && styles.typeChipTextActive]}>{t.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                {paymentMethod !== 'cash' && (
                  <>
                    <Text style={styles.label}>Reference / Transaction ID</Text>
                    <TextInput style={styles.input} value={paymentRef} onChangeText={setPaymentRef} placeholder="UPI Ref / Bank Ref" placeholderTextColor={Colors.textLight} />
                  </>
                )}

                {/* Net amount */}
                <View style={[styles.breakdownRow, { marginTop: Spacing.md, paddingTop: Spacing.md, borderTopWidth: 2, borderTopColor: Colors.primary }]}>
                  <Text style={[styles.breakdownLabel, { fontSize: FontSize.lg, fontWeight: '700' }]}>Net Payable</Text>
                  <Text style={[styles.breakdownValue, { fontSize: FontSize.lg, fontWeight: '700', color: Colors.success }]}>
                    {formatCurrency(Math.max(0, payrollCalc.calculation.net_amount + (Number(bonusAmount) || 0) - payrollCalc.calculation.pending_advances))}
                  </Text>
                </View>

                <TouchableOpacity
                  style={[styles.saveBtn, { marginTop: Spacing.lg, alignSelf: 'stretch', alignItems: 'center', backgroundColor: Colors.success }]}
                  onPress={handleDisburse}
                  disabled={payrollCalculating || saving || !!overlappingPayment}
                >
                  <Text style={styles.saveBtnText}>
                    {saving ? 'Processing...' : payrollCalculating ? 'Updating...' : overlappingPayment ? 'Adjust dates to disburse' : 'Disburse Salary'}
                  </Text>
                </TouchableOpacity>
              </View>
            )}
            <View style={{ height: 40 }} />
          </ScrollView>
        </KeyboardAvoidingView>

        <DateTimePickerModal
          visible={!!periodPickerTarget}
          mode="date"
          value={periodPickerValue}
          onConfirm={handlePeriodPickerConfirm}
          onCancel={() => setPeriodPickerTarget(null)}
        />
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.md },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  tabRow: {
    flexDirection: 'row', marginBottom: Spacing.md, gap: Spacing.xs,
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    padding: 4, borderWidth: 1, borderColor: Colors.border,
  },
  tabBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, paddingVertical: Spacing.sm, borderRadius: BorderRadius.md,
  },
  tabBtnActive: { backgroundColor: Colors.primary },
  tabBtnText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '500' },
  tabBtnTextActive: { color: '#fff', fontWeight: '700' },
  section: { marginBottom: Spacing.lg },
  sectionTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, marginBottom: Spacing.sm },
  empty: { alignItems: 'center', paddingVertical: Spacing.xl },
  emptyText: { fontSize: FontSize.md, color: Colors.textSecondary, marginTop: Spacing.md },
  card: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    marginBottom: Spacing.sm, borderWidth: 1, borderColor: Colors.border, overflow: 'hidden',
  },
  unsetCard: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    padding: Spacing.md, marginBottom: Spacing.sm,
    flexDirection: 'row', alignItems: 'center',
    borderWidth: 1, borderColor: Colors.warningLight, borderStyle: 'dashed',
  },
  cardHeader: {
    flexDirection: 'row', alignItems: 'center', padding: Spacing.md,
  },
  cardName: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  metaRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  metaText: { fontSize: FontSize.sm, color: Colors.textSecondary, marginLeft: Spacing.sm },
  badge: {
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
  },
  badgeText: { fontSize: FontSize.xs, color: '#fff', fontWeight: '600' },
  salaryAmount: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.secondary },
  salaryType: { fontSize: FontSize.xs, color: Colors.textLight },
  cardFooter: {
    flexDirection: 'row', borderTopWidth: 1, borderTopColor: Colors.border,
    padding: Spacing.sm, paddingHorizontal: Spacing.md,
  },
  linkBtn: { flexDirection: 'row', alignItems: 'center', marginRight: Spacing.lg },
  linkBtnText: { fontSize: FontSize.sm, color: Colors.primary, marginLeft: 4 },
  setBtn: { alignItems: 'center' },
  setBtnText: { fontSize: FontSize.xs, color: Colors.primary, marginTop: 2 },
  advanceBadge: {
    flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start',
    backgroundColor: Colors.warningLight, borderRadius: BorderRadius.sm,
    paddingHorizontal: 6, paddingVertical: 2, marginTop: 4, gap: 3,
  },
  advanceBadgeText: { fontSize: FontSize.xs, color: Colors.warning, fontWeight: '600' },
  // Modal
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalContent: {
    backgroundColor: Colors.surface, borderTopLeftRadius: BorderRadius.lg, borderTopRightRadius: BorderRadius.lg,
    padding: Spacing.lg, maxHeight: '80%',
  },
  modalTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, marginBottom: Spacing.md },
  label: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.textSecondary, marginBottom: Spacing.xs, marginTop: Spacing.sm },
  input: {
    borderWidth: 1, borderColor: Colors.border, borderRadius: BorderRadius.md,
    padding: Spacing.sm, fontSize: FontSize.md, color: Colors.text,
    backgroundColor: Colors.background,
  },
  inputValueText: { fontSize: FontSize.md, color: Colors.text },
  inputPlaceholderText: { fontSize: FontSize.md, color: Colors.textLight },
  // Row layout (icon + text) for the tap-to-pick period-date fields — layered on top
  // of styles.input's unchanged box, matching ShiftManagementScreen.js's identical
  // timePickerBtn pattern for its time fields.
  datePickerBtn: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs },
  typeRow: { flexDirection: 'row' },
  typeChip: {
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border,
    marginRight: Spacing.sm,
  },
  typeChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  typeChipText: { fontSize: FontSize.sm, color: Colors.text },
  typeChipTextActive: { color: '#fff', fontWeight: '600' },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: Spacing.lg },
  cancelBtn: { paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm, borderRadius: BorderRadius.md, marginRight: Spacing.sm },
  cancelBtnText: { color: Colors.textSecondary, fontSize: FontSize.md },
  saveBtn: {
    backgroundColor: Colors.primary, paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.md,
  },
  saveBtnText: { color: '#fff', fontSize: FontSize.md, fontWeight: '600' },
  // History
  historyRow: {
    paddingVertical: Spacing.sm, borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  historyChange: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  historyReason: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  historyMeta: { fontSize: FontSize.xs, color: Colors.textLight, marginTop: 4 },
  // Payroll
  payBtn: { alignItems: 'center', gap: 2, paddingHorizontal: Spacing.sm },
  timeInputRow: { flexDirection: 'row', marginTop: Spacing.xs },
  summaryGrid: {
    flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm,
  },
  summaryItem: {
    width: '30%', backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    padding: Spacing.sm, alignItems: 'center', borderWidth: 1, borderColor: Colors.border,
  },
  summaryValue: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  summaryLabel: { fontSize: FontSize.xs, color: Colors.textLight, marginTop: 2, textAlign: 'center' },
  breakdownRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: Spacing.xs,
  },
  breakdownLabel: { fontSize: FontSize.md, color: Colors.text },
  breakdownValue: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  partialDayRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: Spacing.sm, paddingHorizontal: Spacing.xs,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  partialDayDate: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  partialDaySub: { fontSize: FontSize.xs, color: Colors.textLight, marginTop: 2 },
  // Blocking warning shown when the selected period overlaps a payment already made —
  // same visual weight as AttendanceRoster.js's autoClosedBanner (light tint,
  // left accent border), but in error red rather than warning amber since this one
  // actually blocks the primary action rather than just flagging something to review.
  overlapWarning: {
    flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.sm,
    backgroundColor: Colors.errorLight, borderRadius: BorderRadius.md,
    borderLeftWidth: 3, borderLeftColor: Colors.error,
    padding: Spacing.md, marginTop: Spacing.md,
  },
  overlapWarningText: { flex: 1, fontSize: FontSize.sm, color: Colors.text },
  // Quiet, non-alarming reference note — only shown when overlapWarning isn't,
  // so it never competes visually with the blocking warning above.
  lastPaidNote: { fontSize: FontSize.xs, color: Colors.textLight, marginTop: Spacing.sm },
});
