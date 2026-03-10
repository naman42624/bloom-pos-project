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

const SALARY_TYPES = [
  { label: 'Monthly', value: 'monthly' },
  { label: 'Daily', value: 'daily' },
  { label: 'Hourly', value: 'hourly' },
];

function formatCurrency(val) {
  if (!val && val !== 0) return '—';
  return '₹' + Number(val).toLocaleString('en-IN');
}

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
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [paymentRef, setPaymentRef] = useState('');
  const [bonusAmount, setBonusAmount] = useState('');
  const [payrollHistory, setPayrollHistory] = useState([]);
  const [payrollHistoryLoading, setPayrollHistoryLoading] = useState(false);

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
    setPayrollModal(true);
  };

  const handleCalculatePayroll = async () => {
    if (!periodStart || !periodEnd) {
      Alert.alert('Error', 'Please enter period dates.');
      return;
    }
    setPayrollCalculating(true);
    try {
      const res = await api.calculatePayroll({
        user_id: payrollUser.user_id || payrollUser.id,
        period_start: periodStart,
        period_end: periodEnd,
      });
      setPayrollCalc(res.data);
    } catch (e) {
      Alert.alert('Error', e.message || 'Failed to calculate.');
    } finally {
      setPayrollCalculating(false);
    }
  };

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
                        Paid on {new Date(p.paid_at).toLocaleDateString()} via {p.payment_method} • by {p.paid_by_name}
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
                        by {h.changed_by_name} • {new Date(h.created_at).toLocaleDateString()}
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
                <TextInput style={styles.input} value={periodStart} onChangeText={setPeriodStart} placeholder="YYYY-MM-DD" placeholderTextColor={Colors.textLight} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>Period End</Text>
                <TextInput style={styles.input} value={periodEnd} onChangeText={setPeriodEnd} placeholder="YYYY-MM-DD" placeholderTextColor={Colors.textLight} />
              </View>
            </View>

            <TouchableOpacity
              style={[styles.saveBtn, { marginTop: Spacing.md, alignSelf: 'stretch', alignItems: 'center' }]}
              onPress={handleCalculatePayroll}
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

                <Text style={[styles.sectionTitle, { marginTop: Spacing.md, marginBottom: Spacing.sm }]}>Salary Breakdown</Text>
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
                  disabled={saving}
                >
                  <Text style={styles.saveBtnText}>{saving ? 'Processing...' : 'Disburse Salary'}</Text>
                </TouchableOpacity>
              </View>
            )}
            <View style={{ height: 40 }} />
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
});
