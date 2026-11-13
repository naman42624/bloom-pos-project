import React, { useState, useCallback, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { getShopTodayStr, formatTime } from '../utils/datetime';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';
import useRegisterStatus from '../hooks/useRegisterStatus';
import RegisterStatusBanner from '../components/RegisterStatusBanner';
import AddExpenseSheet, { EXPENSE_CATEGORIES } from '../components/expenses/AddExpenseSheet';

export default function ExpensesScreen() {
  const navigation = useNavigation();
  const route = useRoute();
  const { settings, user, activeLocation } = useAuth();
  const timezone = settings?.timezone?.value || 'Asia/Kolkata';
  const [expenses, setExpenses] = useState([]);

  const [total, setTotal] = useState(0);
  const [locations, setLocations] = useState([]);
  // Cash Register passes its shop, so an expense lands on the drawer staff
  // were just looking at.
  const [selectedLocation, setSelectedLocation] = useState(route.params?.locationId || activeLocation?.id || null);
  const [loading, setLoading] = useState(true);

  // The Add / Change expense sheet (components/expenses/AddExpenseSheet.js).
  // sheet = null (closed) | { expense } (change) | { initial } (add, maybe pre-filled)
  const [sheet, setSheet] = useState(null);
  // Brief "Saved ₹200 Petrol" line after a save; there is no app-wide toast.
  const [toast, setToast] = useState('');
  const toastTimer = useRef(null);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  // Quick Checkout's header button and the dashboard's "Add Expense" action
  // navigate here with { openAdd: true } so the sheet is ready at once. The
  // param is cleared after use, so going back and forth never reopens it.
  useEffect(() => {
    if (route.params?.openAdd) {
      setSheet({});
      navigation.setParams({ openAdd: undefined });
    }
  }, [route.params?.openAdd]);

  // Was the one confirmed gap in the register-awareness pattern: this
  // screen let someone fill in a whole cash expense and only found out at
  // submit that there was nowhere for it to go. The sheet now disables Cash
  // up front with "Open the register to pay cash" (2026-09-04 audit).
  const registerStatus = useRegisterStatus(selectedLocation);

  // useRegisterStatus refetches on locationId change, not on focus — without
  // this, opening the register via the banner below and coming back here
  // would still show "closed" until something else happened to remount it.
  useFocusEffect(
    useCallback(() => {
      registerStatus.refetch();
    }, [registerStatus.refetch])
  );

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

  const fetchLocations = async () => {
    try {
      const res = await api.getLocations();
      const locs = res.data?.locations || res.data || [];
      setLocations(locs);
      // Else this device's shop (as Quick Checkout does), else the first shop.
      const preferred = activeLocation && locs.find((l) => Number(l.id) === Number(activeLocation.id));
      if (locs.length > 0) setSelectedLocation((cur) => cur || (preferred ? preferred.id : locs[0].id));
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

  const isBoss = user?.role === 'owner' || user?.role === 'manager';

  // Who may change an expense (the server checks the same rule): owner and
  // manager any; staff only their own, while its register session is open.
  const canChange = (item) => {
    if (isBoss) return true;
    if (Number(item.created_by) !== Number(user?.id)) return false;
    if (!registerStatus.isOpen) return false;
    return !item.register_id || Number(item.register_id) === Number(registerStatus.register?.id);
  };

  const openEdit = (item) => setSheet({ expense: item });

  const handleInitiateReturn = (expense) => setSheet({
    initial: {
      is_return: true,
      item_id: expense.item_id || null,
      item_name: expense.item_name || null,
      description: expense.item_name ? null : expense.description,
      category: expense.category,
      amount: expense.amount,
      payment_method: 'cash',
    },
  });

  const handleSaved = (result) => {
    setSheet(null);
    fetchExpenses();
    registerStatus.refetch();
    if (result?.message) {
      setToast(result.message);
      clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToast(''), 4000);
    }
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
            <TouchableOpacity
              onPress={() => handleInitiateReturn(item)}
              style={styles.iconBtn}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              accessibilityRole="button"
              accessibilityLabel={`Record money coming back for ${item.description}`}
            >
              <Ionicons name="arrow-undo-outline" size={16} color={Colors.textSecondary} />
            </TouchableOpacity>
          )}
          {canChange(item) && (
            <TouchableOpacity
              onPress={() => openEdit(item)}
              style={styles.changeBtn}
              accessibilityRole="button"
              accessibilityLabel={`Change expense ${item.description}`}
            >
              <Ionicons name="create-outline" size={16} color={Colors.primary} />
              <Text style={styles.changeBtnText}>Change</Text>
            </TouchableOpacity>
          )}
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

      {!!toast && (
        <View style={styles.toast} accessibilityLiveRegion="polite">
          <Ionicons name="checkmark-circle" size={20} color={Colors.success} />
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      )}

      {/* Today's total */}
      <View style={styles.summaryCard}>
        <Ionicons name="wallet" size={24} color={Colors.primary} />
        <View style={{ flex: 1, marginLeft: Spacing.sm }}>
          <Text style={styles.summaryLabel}>Today's Expenses</Text>
          <Text style={styles.summaryAmount}>₹{total.toFixed(0)}</Text>
        </View>
        <TouchableOpacity
          style={styles.addBtn}
          onPress={() => setSheet({})}
          accessibilityRole="button"
          accessibilityLabel="Add expense"
        >
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

      <AddExpenseSheet
        visible={!!sheet}
        locationId={selectedLocation}
        registerOpen={registerStatus.isOpen}
        registerLoading={registerStatus.loading}
        register={registerStatus.register}
        expense={sheet?.expense || null}
        initial={sheet?.initial || null}
        onClose={() => setSheet(null)}
        onSaved={handleSaved}
        onRegisterOpened={registerStatus.refetch}
      />
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
  toast: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    marginHorizontal: Spacing.md, marginTop: Spacing.sm, padding: Spacing.sm,
    borderRadius: BorderRadius.md, backgroundColor: Colors.successLight,
  },
  toastText: { flex: 1, fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
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
  changeBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44, paddingHorizontal: Spacing.sm,
    borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.primary,
  },
  changeBtnText: { color: Colors.primary, fontWeight: '700', fontSize: FontSize.sm },
  closeBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  removeBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    minHeight: 48, marginTop: Spacing.sm, marginBottom: Spacing.sm,
  },
  removeBtnText: { color: Colors.error, fontWeight: '600', fontSize: FontSize.md },

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
