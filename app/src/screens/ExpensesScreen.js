import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, StyleSheet, FlatList, TextInput,
  TouchableOpacity, Alert, ScrollView, Modal, ActivityIndicator,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { getShopTodayStr, formatTime } from '../utils/datetime';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';
import useRegisterStatus from '../hooks/useRegisterStatus';
import RegisterStatusBanner from '../components/RegisterStatusBanner';

const EXPENSE_CATEGORIES = [
  { key: 'supplies', label: 'Supplies', icon: 'cart' },
  { key: 'petty_cash', label: 'Petty Cash', icon: 'cash' },
  { key: 'maintenance', label: 'Maintenance', icon: 'construct' },
  { key: 'transport', label: 'Transport', icon: 'car' },
  { key: 'food', label: 'Food', icon: 'fast-food' },
  { key: 'utilities', label: 'Utilities', icon: 'flash' },
  { key: 'salary', label: 'Salary', icon: 'people' },
  { key: 'other', label: 'Other', icon: 'ellipsis-horizontal' },
];

const PAYMENT_METHODS = [
  { key: 'cash', label: 'Cash', icon: 'cash' },
  { key: 'card', label: 'Card', icon: 'card' },
  { key: 'upi', label: 'UPI', icon: 'phone-portrait' },
];

// Who a "Salary" category expense can be logged against — matches
// ShiftManagementScreen.js's own staff-picker filter exactly (owner
// excluded on purpose, same as there: owner isn't paid a wage through
// either screen).
const PAYROLL_ROLES = ['manager', 'employee', 'counter_staff', 'florist_staff', 'delivery_partner'];

export default function ExpensesScreen() {
  const navigation = useNavigation();
  const route = useRoute();
  const { settings, user } = useAuth();
  const timezone = settings?.timezone?.value || 'Asia/Kolkata';
  const [expenses, setExpenses] = useState([]);

  const [total, setTotal] = useState(0);
  const [locations, setLocations] = useState([]);
  const [selectedLocation, setSelectedLocation] = useState(null);
  const [loading, setLoading] = useState(true);

  // Add modal
  const [showAdd, setShowAdd] = useState(false);

  // Dashboard's "Add Expense" quick action (2026-09-13, staff-ux fix — the
  // path had crept to 3 taps: open Cash Register, tap Expenses, tap Add
  // Expense) navigates straight here with openAdd:true so the form is ready
  // to fill in immediately instead of landing on the list first. Runs once
  // on mount, not via useFocusEffect — this screen unmounts on back
  // navigation like any other stack screen, so a plain mount-time check
  // can't re-fire from a stale param on refocus.
  useEffect(() => {
    if (route.params?.openAdd) setShowAdd(true);
  }, []);
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('petty_cash');
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [isReturn, setIsReturn] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Salary-category money-safety fix (2026-09-19): POST /expenses now
  // requires employee_id whenever category === 'salary' (server/routes/
  // expenses.js) — this screen had no picker at all, so selecting Salary
  // was a guaranteed 400 with no way to supply the now-required field.
  const [staffList, setStaffList] = useState([]);
  const [staffListLoaded, setStaffListLoaded] = useState(false);
  const [salaryEmployee, setSalaryEmployee] = useState(null);
  // Soft, informational-only context (not a blocking check — the backend's
  // precise period-overlap block already handles the hard case server-side).
  const [recentPayrollPayment, setRecentPayrollPayment] = useState(null);
  const [recentSalaryExpense, setRecentSalaryExpense] = useState(null);

  // Was the one confirmed gap in the register-awareness pattern: this
  // screen let someone fill in a whole cash expense and only found out at
  // submit that there was nowhere for it to go (server's plain-language
  // REGISTER_CLOSED_MESSAGE, but reactive — staff-ux-checklist wants it
  // caught before that). Same hook/banner the Dashboard's cash-sale flow
  // already had; this was the screen that never got it (2026-09-04 audit).
  const registerStatus = useRegisterStatus(selectedLocation);

  // useRegisterStatus refetches on locationId change, not on focus — without
  // this, opening the register via the banner below and coming back here
  // would still show "closed" until something else happened to remount it.
  useFocusEffect(
    useCallback(() => {
      registerStatus.refetch();
    }, [registerStatus.refetch])
  );

  // Cash defaults to selected (see paymentMethod's initial state) — if the
  // register turns out closed, move off it automatically rather than
  // leaving a disabled option sitting selected. Only fires when it would
  // actually change something, so it never fights a deliberate choice of
  // card/UPI.
  useEffect(() => {
    if (!registerStatus.loading && !registerStatus.isOpen && paymentMethod === 'cash') {
      setPaymentMethod('card');
    }
  }, [registerStatus.loading, registerStatus.isOpen, paymentMethod]);

  useFocusEffect(
    useCallback(() => {
      fetchLocations();
    }, [])
  );

  useFocusEffect(
    useCallback(() => {
      if (selectedLocation) fetchExpenses();
    }, [selectedLocation])
  );

  // Lazily fetch the staff picker's options the first time "Salary" is
  // selected — not on every mount, since most expenses aren't salary.
  //
  // Role-aware on purpose, not a single mirrored call: GET /users
  // (api.getUsers) is owner/manager-only (server/routes/users.js,
  // authorize('owner','manager')). This screen is also reachable by
  // employee/counter_staff (POS tab), for whom that call 403s —
  // ShiftManagementScreen.js's identical unfiltered api.getUsers() call is
  // the brief's suggested reference, but that screen is ALSO reachable by
  // those same two roles via the Attendance tab and silently ends up with
  // three empty lists for them today (Promise.all rejects, caught, nothing
  // set) — a real, pre-existing, unfixed gap elsewhere in this codebase,
  // not something to newly replicate on a money-adjacent flow here.
  //
  // owner/manager: api.getUsers() (matches ShiftManagementScreen.js exactly).
  // employee/counter_staff: GET /production/assignable-staff — the same
  // endpoint SaleDetailScreen's assign-task picker uses for this exact
  // "non-owner/manager needs a staff list" need, and unlike GET
  // /auth/staff-roster it has no employee_code filter (staff-roster would
  // silently drop this shop's employee-role accounts — confirmed bug,
  // see SaleDetailScreen.js's Task 17 comment). assignable-staff is itself
  // owner/manager/counter_staff-only, so 'employee' still 403s on it —
  // falls back to staff-roster rather than leaving the picker empty (a
  // dead end with no explanation, which staff-ux-checklist #6 rules out).
  useEffect(() => {
    if (category !== 'salary' || staffList.length > 0) return;
    const isOwnerOrManager = user?.role === 'owner' || user?.role === 'manager';

    const load = async () => {
      if (isOwnerOrManager) {
        const res = await api.getUsers();
        return (res.data?.users || []).filter((u) => PAYROLL_ROLES.includes(u.role) && u.is_active);
      }
      try {
        const res = await api.getAssignableStaff(selectedLocation);
        return (res.staff || []).filter((u) => PAYROLL_ROLES.includes(u.role));
      } catch {
        const res = await api.getStaffRoster(selectedLocation);
        return res.data?.staff || [];
      }
    };

    load()
      .then(setStaffList)
      .catch(() => setStaffList([]))
      .finally(() => setStaffListLoaded(true));
  }, [category]);

  // Soft, informational context once an employee is picked — NOT a
  // blocking check (the backend's precise period-overlap rule already
  // hard-blocks the exact case server-side; a raw expense has no period
  // concept to check precisely, so this is awareness, not a rule).
  useEffect(() => {
    if (!salaryEmployee) {
      setRecentPayrollPayment(null);
      setRecentSalaryExpense(null);
      return;
    }
    let cancelled = false;
    // GET /staff/payroll/history ignores a passed user_id for anyone but
    // 'owner' — it force-filters to the CALLER's own records instead
    // (server/routes/staff-management.js, 'Get payment history': `if
    // (req.user.role !== 'owner') { where.push('sp.user_id = ?');
    // params.push(req.user.id); }`). Calling it as manager/employee/
    // counter_staff to look up a DIFFERENT person would silently show the
    // CALLER's own payroll history mislabeled as salaryEmployee's — worse
    // than showing nothing. Only trust it when the caller is owner (real
    // org-wide read) or is looking up themselves (the forced self-filter
    // happens to already be correct in that case).
    const canReadTheirPayroll = user?.role === 'owner' || salaryEmployee.id === user?.id;
    Promise.all([
      canReadTheirPayroll
        ? api.getPayrollHistory({ user_id: salaryEmployee.id, limit: 3 }).catch(() => ({ data: { payments: [] } }))
        : Promise.resolve({ data: { payments: [] } }),
      api.getExpenses({ category: 'salary', employee_id: salaryEmployee.id }).catch(() => ({ data: [] })),
    ]).then(([payrollRes, expensesRes]) => {
      if (cancelled) return;
      const payments = (payrollRes.data?.payments || []).filter((p) => p.status !== 'cancelled');
      payments.sort((a, b) => String(b.period_end || '').localeCompare(String(a.period_end || '')));
      setRecentPayrollPayment(payments[0] || null);

      // GET /expenses (res.data is the array directly, not res.data.expenses
      // — confirmed against server/routes/expenses.js and this screen's own
      // fetchExpenses above) already scopes to this employee_id server-side.
      const salaryExpenses = (expensesRes.data || [])
        .slice()
        .sort((a, b) => String(b.expense_date || '').localeCompare(String(a.expense_date || '')));
      setRecentSalaryExpense(salaryExpenses[0] || null);
    });
    return () => { cancelled = true; };
  }, [salaryEmployee]);

  const fetchLocations = async () => {
    try {
      const res = await api.getLocations();
      const locs = res.data?.locations || res.data || [];
      setLocations(locs);
      if (locs.length > 0 && !selectedLocation) setSelectedLocation(locs[0].id);
    } catch {}
  };

  const fetchExpenses = async () => {
    try {
      setLoading(true);
      const today = getShopTodayStr(timezone);
      const res = await api.getExpenses({ location_id: selectedLocation, start_date: today, end_date: today });

      setExpenses((res.data || []).map((expense) => ({
        ...expense,
        amount: Number(expense.amount) || 0,
      })));
      setTotal(Number(res.total || 0));
    } catch {} finally {
      setLoading(false);
    }
  };

  const handleAdd = async () => {
    const amt = parseFloat(amount) || 0;
    if (amt <= 0) { Alert.alert('Invalid', 'Enter a valid amount'); return; }
    if (!description.trim()) { Alert.alert('Required', 'Enter a description'); return; }
    if (category === 'salary' && !salaryEmployee) {
      Alert.alert('Required', 'Select which employee this salary payment is for.');
      return;
    }

    setSubmitting(true);
    try {
      const today = getShopTodayStr(timezone);
      await api.createExpense({

        location_id: selectedLocation,
        category,
        amount: amt,
        description: description.trim(),
        payment_method: paymentMethod,
        expense_date: today,
        is_return: isReturn,
        employee_id: category === 'salary' ? salaryEmployee.id : undefined,
      });
      setShowAdd(false);
      setAmount(''); setDescription(''); setCategory('petty_cash'); setPaymentMethod('cash'); setIsReturn(false);
      setSalaryEmployee(null);
      fetchExpenses();
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to add expense');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = (expense) => {
    Alert.alert('Delete Expense', `Delete ₹${Number(expense.amount || 0).toFixed(0)} — ${expense.description}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          try {
            await api.deleteExpense(expense.id);
            fetchExpenses();
          } catch (err) {
            Alert.alert('Error', err.message || 'Failed to delete');
          }
        },
      },
    ]);
  };

  const handleInitiateReturn = (expense) => {
    setIsReturn(true);
    setCategory(expense.category);
    setDescription(`Return: ${expense.description}`);
    setPaymentMethod('cash');
    setAmount(String(expense.amount || ''));
    setShowAdd(true);
  };

  const getCatIcon = (cat) => {
    const found = EXPENSE_CATEGORIES.find((c) => c.key === cat);
    return found ? found.icon : 'ellipsis-horizontal';
  };

  const getCatLabel = (cat) => {
    const found = EXPENSE_CATEGORIES.find((c) => c.key === cat);
    return found ? found.label : cat;
  };

  const renderExpense = ({ item }) => (
    <View style={[styles.card, item.is_return && styles.cardReturn]}>
      <View style={[styles.cardIcon, item.is_return && styles.cardIconReturn]}>
        <Ionicons name={item.is_return ? 'arrow-undo' : getCatIcon(item.category)} size={22} color={item.is_return ? Colors.success : Colors.primary} />
      </View>
      <View style={styles.cardCenter}>
        <Text style={styles.cardDesc} numberOfLines={1}>{item.description}</Text>
        <Text style={styles.cardMeta}>
          {item.is_return ? 'RETURN • ' : ''}{getCatLabel(item.category)} • {item.payment_method.toUpperCase()} • {item.created_by_name}
        </Text>
        {/* Which register session this belongs to — only meaningful for a
            cash expense (register_id is always null otherwise), and only
            worth a line when there's a session to name at all. Multiple
            sessions a day are a regular occurrence at this shop, so this is
            always shown for cash rather than only when 2+ sessions exist —
            simpler rule, and never wrong even on a single-session day
            (2026-09-04 audit). */}
        {item.payment_method === 'cash' && item.register_opened_at && (
          <Text style={styles.cardSession}>Session opened {formatTime(item.register_opened_at)}</Text>
        )}
      </View>
      <View style={styles.cardRight}>
        <Text style={[styles.cardAmount, item.is_return && styles.cardAmountReturn]}>
          {item.is_return ? '+' : '-'}₹{Number(item.amount || 0).toFixed(0)}
        </Text>
        <View style={styles.actionRow}>
          {!item.is_return && item.payment_method === 'cash' && (
            <TouchableOpacity onPress={() => handleInitiateReturn(item)} style={styles.iconBtn}>
              <Ionicons name="arrow-undo-outline" size={16} color={Colors.textSecondary} />
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={() => handleDelete(item)} style={styles.iconBtn}>
            <Ionicons name="trash-outline" size={16} color={Colors.error} />
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );

  return (
    <View style={styles.container}>
      {/* Location selector */}
      {locations.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.locRow} contentContainerStyle={{ paddingHorizontal: Spacing.md, gap: Spacing.xs }}>
          {locations.map((loc) => (
            <TouchableOpacity
              key={loc.id}
              style={[styles.locChip, selectedLocation === loc.id && styles.locChipActive]}
              onPress={() => setSelectedLocation(loc.id)}
            >
              <Text style={[styles.locChipText, selectedLocation === loc.id && styles.locChipTextActive]}>{loc.name}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {!registerStatus.loading && (registerStatus.isStale || !registerStatus.isOpen) && (
        <View style={{ paddingHorizontal: Spacing.md, paddingTop: Spacing.sm }}>
          <RegisterStatusBanner
            isOpen={registerStatus.isOpen}
            isStale={registerStatus.isStale}
            register={registerStatus.register}
            onPress={() => navigation.navigate('CashRegister', { locationId: selectedLocation })}
            closedMessage="Cash expenses need it open — Card/UPI still work either way."
          />
        </View>
      )}

      {/* Today's total */}
      <View style={styles.summaryCard}>
        <Ionicons name="wallet" size={24} color={Colors.primary} />
        <View style={{ flex: 1, marginLeft: Spacing.sm }}>
          <Text style={styles.summaryLabel}>Today's Expenses</Text>
          <Text style={styles.summaryAmount}>₹{total.toFixed(0)}</Text>
        </View>
        <TouchableOpacity style={styles.addBtn} onPress={() => setShowAdd(true)}>
          <Ionicons name="add" size={22} color={Colors.white} />
          <Text style={styles.addBtnText}>Add</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={expenses}
        keyExtractor={(item) => String(item.id)}
        renderItem={renderExpense}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="receipt-outline" size={48} color={Colors.textLight} />
            <Text style={styles.emptyText}>{loading ? 'Loading...' : 'No expenses today'}</Text>
          </View>
        }
      />

      {/* Add Expense Modal */}
      <Modal visible={showAdd} transparent animationType="slide">
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.modalOverlay}>
            <View style={styles.modalCard}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Add Expense</Text>
                <TouchableOpacity onPress={() => setShowAdd(false)}>
                  <Ionicons name="close" size={24} color={Colors.text} />
                </TouchableOpacity>
              </View>

              <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
                <View style={styles.typeToggle}>
                  <TouchableOpacity
                    style={[styles.typeBtn, !isReturn && styles.typeBtnActiveOut]}
                    onPress={() => setIsReturn(false)}
                  >
                    <Text style={[styles.typeBtnText, !isReturn && styles.typeBtnTextActive]}>Expense Out</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.typeBtn, isReturn && styles.typeBtnActiveIn]}
                    onPress={() => setIsReturn(true)}
                  >
                    <Text style={[styles.typeBtnText, isReturn && styles.typeBtnTextActive]}>Return In</Text>
                  </TouchableOpacity>
                </View>

                <Text style={styles.fieldLabel}>Amount (₹) *</Text>
                <TextInput
                  style={styles.input}
                  value={amount}
                  onChangeText={setAmount}
                  placeholder="0"
                  placeholderTextColor={Colors.textLight}
                  keyboardType="numeric"
                  autoFocus
                />

                <Text style={styles.fieldLabel}>Description *</Text>
                <TextInput
                  style={styles.input}
                  value={description}
                  onChangeText={setDescription}
                  placeholder="What was this expense for?"
                  placeholderTextColor={Colors.textLight}
                />

                <Text style={styles.fieldLabel}>Category</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: Spacing.xs, paddingBottom: Spacing.xs }}>
                  {EXPENSE_CATEGORIES.map((cat) => (
                    <TouchableOpacity
                      key={cat.key}
                      style={[styles.chip, category === cat.key && styles.chipActive]}
                      onPress={() => setCategory(cat.key)}
                    >
                      <Ionicons name={cat.icon} size={14} color={category === cat.key ? Colors.white : Colors.textSecondary} />
                      <Text style={[styles.chipText, category === cat.key && styles.chipTextActive]}>{cat.label}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>

                {category === 'salary' && (
                  <View style={{ marginTop: Spacing.sm }}>
                    <Text style={styles.fieldLabel}>Which employee is this for?</Text>
                    <View style={styles.chipRow}>
                      {staffList.map((u) => (
                        <TouchableOpacity
                          key={u.id}
                          style={[styles.chip, salaryEmployee?.id === u.id && styles.chipActive]}
                          onPress={() => setSalaryEmployee(u)}
                        >
                          <Text style={[styles.chipText, salaryEmployee?.id === u.id && styles.chipTextActive]}>{u.name}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                    {staffListLoaded && staffList.length === 0 && (
                      <Text style={styles.fieldHint}>No staff found here — log this from Salary Management instead, or check Staff under More.</Text>
                    )}
                    {(recentPayrollPayment || recentSalaryExpense) && (
                      <View style={styles.salaryContextNote}>
                        <Ionicons name="information-circle-outline" size={16} color={Colors.textLight} />
                        <Text style={styles.salaryContextNoteText}>
                          {recentPayrollPayment && `Last paid via Payroll: ${recentPayrollPayment.period_start} to ${recentPayrollPayment.period_end}. `}
                          {recentSalaryExpense && `Last salary expense logged: ₹${Number(recentSalaryExpense.amount || 0).toFixed(0)} on ${recentSalaryExpense.expense_date}.`}
                        </Text>
                      </View>
                    )}
                  </View>
                )}

                <Text style={styles.fieldLabel}>Payment Method</Text>
                <View style={styles.chipRow}>
                  {PAYMENT_METHODS.map((m) => {
                    // Prevent, not just react to, the one confirmed gap this
                    // screen had: Cash disabled outright when there's no
                    // open register to log it against, instead of letting
                    // the whole form fill in and fail at submit
                    // (2026-09-04 audit).
                    const disabled = m.key === 'cash' && !registerStatus.loading && !registerStatus.isOpen;
                    const active = paymentMethod === m.key;
                    return (
                      <TouchableOpacity
                        key={m.key}
                        style={[styles.chip, active && styles.chipActive, disabled && styles.chipDisabled]}
                        onPress={() => setPaymentMethod(m.key)}
                        disabled={disabled}
                      >
                        <Ionicons name={m.icon} size={14} color={active ? Colors.white : disabled ? Colors.textLight : Colors.textSecondary} />
                        <Text style={[styles.chipText, active && styles.chipTextActive, disabled && { color: Colors.textLight }]}>{m.label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                {!registerStatus.loading && !registerStatus.isOpen && (
                  <Text style={styles.fieldHint}>Open the register to log a cash expense.</Text>
                )}
                {paymentMethod === 'cash' && registerStatus.isOpen && (
                  <Text style={styles.fieldHint}>
                    Adding to the session opened {formatTime(registerStatus.register?.opening_time || registerStatus.register?.opened_at)}.
                  </Text>
                )}

                <TouchableOpacity
                  style={[styles.submitBtn, submitting && { opacity: 0.6 }]}
                  onPress={handleAdd}
                  disabled={submitting}
                >
                  {submitting ? (
                    <ActivityIndicator color={Colors.white} />
                  ) : (
                    <>
                      <Ionicons name={isReturn ? "arrow-undo" : "add-circle"} size={18} color={Colors.white} />
                      <Text style={styles.submitBtnText}>{isReturn ? "Save Return" : "Add Expense"}</Text>
                    </>
                  )}
                </TouchableOpacity>
              </ScrollView>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  locRow: { maxHeight: 44, backgroundColor: Colors.surface, borderBottomWidth: 1, borderBottomColor: Colors.border },
  locChip: {
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs + 2,
    borderRadius: BorderRadius.full, backgroundColor: Colors.background,
    borderWidth: 1, borderColor: Colors.border,
  },
  locChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  locChipText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  locChipTextActive: { color: Colors.white, fontWeight: '600' },

  summaryCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: Colors.surface, margin: Spacing.md, padding: Spacing.md,
    borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border,
  },
  summaryLabel: { fontSize: FontSize.xs, color: Colors.textSecondary },
  summaryAmount: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.primary },
  addBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: Colors.primary, paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs + 2, borderRadius: BorderRadius.md,
  },
  addBtnText: { color: Colors.white, fontWeight: '600', fontSize: FontSize.sm },

  list: { paddingHorizontal: Spacing.md, paddingBottom: 40 },

  card: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    padding: Spacing.md, marginBottom: Spacing.sm,
    borderWidth: 1, borderColor: Colors.border,
  },
  cardIcon: {
    width: 40, height: 40, borderRadius: BorderRadius.md,
    backgroundColor: Colors.primary + '12', justifyContent: 'center', alignItems: 'center',
    marginRight: Spacing.sm,
  },
  cardCenter: { flex: 1 },
  cardDesc: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  cardMeta: { fontSize: FontSize.xs, color: Colors.textLight, marginTop: 2 },
  cardSession: { fontSize: FontSize.xs, color: Colors.textLight, marginTop: 1, fontStyle: 'italic' },
  cardRight: { alignItems: 'flex-end', gap: Spacing.xs },
  cardAmount: { fontSize: FontSize.md, fontWeight: '700', color: Colors.error },
  cardAmountReturn: { color: Colors.success },
  cardReturn: { borderColor: Colors.success + '40', backgroundColor: Colors.success + '08' },
  cardIconReturn: { backgroundColor: Colors.success + '12' },
  actionRow: { flexDirection: 'row', gap: Spacing.md, marginTop: 4 },
  iconBtn: { padding: 4 },

  empty: { alignItems: 'center', paddingTop: 80 },
  emptyText: { color: Colors.textLight, marginTop: Spacing.sm, fontSize: FontSize.sm },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  modalCard: {
    backgroundColor: Colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: Spacing.lg, maxHeight: '85%',
  },
  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: Spacing.md,
  },
  modalTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },

  typeToggle: {
    flexDirection: 'row', backgroundColor: Colors.background, borderRadius: BorderRadius.md,
    padding: 2, marginBottom: Spacing.sm,
  },
  typeBtn: { flex: 1, paddingVertical: Spacing.sm, alignItems: 'center', borderRadius: BorderRadius.sm },
  typeBtnActiveOut: { backgroundColor: Colors.error },
  typeBtnActiveIn: { backgroundColor: Colors.success },
  typeBtnText: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.textSecondary },
  typeBtnTextActive: { color: Colors.white },

  fieldLabel: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.text, marginTop: Spacing.md, marginBottom: Spacing.xs },
  input: {
    backgroundColor: Colors.background, borderWidth: 1, borderColor: Colors.border,
    borderRadius: BorderRadius.md, paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.sm, fontSize: FontSize.sm, color: Colors.text,
  },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.xs },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs + 2,
    borderRadius: BorderRadius.full, backgroundColor: Colors.background,
    borderWidth: 1, borderColor: Colors.border,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipDisabled: { backgroundColor: Colors.surfaceAlt, borderColor: Colors.border, opacity: 0.6 },
  chipText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  chipTextActive: { color: Colors.white, fontWeight: '600' },
  fieldHint: { fontSize: FontSize.xs, color: Colors.textLight, marginTop: Spacing.xs, fontStyle: 'italic' },

  // Quiet, informational-only note (NOT a blocking warning like
  // SalaryManagementScreen.js's red overlapWarning) — muted colors, no
  // accent border, since this case is surfaced for awareness only and
  // never disables Save.
  salaryContextNote: {
    flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.xs,
    backgroundColor: Colors.background, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border,
    padding: Spacing.sm, marginTop: Spacing.sm,
  },
  salaryContextNoteText: { flex: 1, fontSize: FontSize.xs, color: Colors.textLight },

  submitBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: Colors.primary, paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.md, marginTop: Spacing.lg, marginBottom: Spacing.md,
  },
  submitBtnText: { color: Colors.white, fontWeight: '600', fontSize: FontSize.sm },
});
