import React, { useState, useCallback, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, ScrollView, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { getShopTodayStr } from '../utils/datetime';
import { lastSevenDays } from '../utils/expenseBook';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';
import useRegisterStatus from '../hooks/useRegisterStatus';
import RegisterStatusBanner from '../components/RegisterStatusBanner';
import AddExpenseSheet, { rupees } from '../components/expenses/AddExpenseSheet';
import ExpenseRow from '../components/expenses/ExpenseRow';
import ExpenseSummaryView from '../components/expenses/ExpenseSummaryView';

// Two views (spec §6.2 / §6.3):
//   counter staff / employee: day chips for the last 7 days and that day's
//     entries; Change only on their own entries from today while the
//     register is open (the server checks the same rule).
//   owner / manager: ExpenseSummaryView (period totals by category and item,
//     ▲/▼ vs the period before, "See all entries").
export default function ExpensesScreen() {
  const navigation = useNavigation();
  const route = useRoute();
  const { settings, user, activeLocation } = useAuth();
  const timezone = settings?.timezone?.value || 'Asia/Kolkata';
  const today = getShopTodayStr(timezone);
  const isBoss = user?.role === 'owner' || user?.role === 'manager';
  const isOwner = user?.role === 'owner';

  const [locations, setLocations] = useState([]);
  // Cash Register passes its shop, so an expense lands on the drawer staff
  // were just looking at. This is also the shop new expenses are added to.
  const [selectedLocation, setSelectedLocation] = useState(route.params?.locationId || activeLocation?.id || null);

  // Staff view state.
  const [day, setDay] = useState(today);
  const [expenses, setExpenses] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  // Which shop + day the rows on screen belong to; rows from another day are
  // hidden (not shown under the new day's title) until the new list lands.
  const [loadedKey, setLoadedKey] = useState('');
  const dayKey = `${selectedLocation}|${day}`;
  const fresh = loadedKey === dayKey;
  const reqId = useRef(0);

  // Owner/manager view refreshes when this changes (after a save).
  const [refreshKey, setRefreshKey] = useState(0);

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

  // The sheet disables Cash up front with "Open the register to pay cash"
  // when the register is closed (2026-09-04 audit).
  const registerStatus = useRegisterStatus(selectedLocation);
  // Changing an entry from another shop (All shops list) needs that shop's
  // register, not the selected one's.
  const sheetLocation = sheet?.expense?.location_id || selectedLocation;
  const otherShop = !!sheetLocation && Number(sheetLocation) !== Number(selectedLocation);
  const otherShopStatus = useRegisterStatus(otherShop ? sheetLocation : null);
  const sheetStatus = otherShop ? otherShopStatus : registerStatus;

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
      if (!isBoss && selectedLocation) fetchExpenses();
    }, [isBoss, selectedLocation, day])
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
    const id = ++reqId.current;
    const key = `${selectedLocation}|${day}`;
    try {
      setLoading(true);
      setLoadError(false);
      const res = await api.getExpenses({ location_id: selectedLocation, start_date: day, end_date: day });
      if (id !== reqId.current) return;
      setExpenses((res.data || []).map((expense) => ({
        ...expense,
        amount: Number(expense.amount) || 0,
      })));
      setTotal(Number(res.total || 0));
      setLoadedKey(key);
    } catch {
      if (id === reqId.current) setLoadError(true);
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  };

  // Staff: Change only on their own entry from today, while the register
  // session it belongs to is open (same rule as the server, PR #37).
  // Owner and manager can change any entry.
  const canChange = (item) => {
    if (isBoss) return true;
    if (Number(item.created_by) !== Number(user?.id)) return false;
    if (String(item.expense_date || '').slice(0, 10) !== today) return false;
    if (!registerStatus.isOpen) return false;
    if (item.register_id) return Number(item.register_id) === Number(registerStatus.register?.id);
    // No register on the row (UPI): the server allows it only if it was
    // saved during the open session (expenses.js loadForChange).
    const openedAt = registerStatus.register?.opened_at || registerStatus.register?.opening_time;
    if (!openedAt || !item.created_at) return true;
    return new Date(item.created_at) >= new Date(openedAt);
  };

  const openChange = (item) => setSheet({ expense: item });

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
    if (isBoss) setRefreshKey((k) => k + 1);
    else fetchExpenses();
    registerStatus.refetch();
    if (result?.message) {
      setToast(result.message);
      clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToast(''), 4000);
    }
  };

  const days = lastSevenDays(today);
  const dayInfo = days.find((d) => d.date === day) || days[0];
  const dayTitle = day === today ? "Today's expenses"
    : dayInfo.label === 'Yesterday' ? "Yesterday's expenses" : `Expenses on ${dayInfo.label}`;

  const addButton = (
    <TouchableOpacity
      style={styles.addBtn}
      onPress={() => setSheet({})}
      accessibilityRole="button"
      accessibilityLabel="Add expense"
    >
      <Ionicons name="add-circle" size={24} color={Colors.white} />
      <Text style={styles.addBtnText}>Add expense</Text>
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      {/* Staff: shop chips when linked to more than one shop. Owner/manager
          get "All shops" + shop chips inside the summary view instead. */}
      {!isBoss && locations.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.locRow} contentContainerStyle={styles.chipRow}>
          {locations.map((loc) => (
            <TouchableOpacity
              key={loc.id}
              style={[styles.chip, selectedLocation === loc.id && styles.chipActive]}
              onPress={() => setSelectedLocation(loc.id)}
              accessibilityRole="button"
              accessibilityState={{ selected: selectedLocation === loc.id }}
            >
              <Text style={[styles.chipText, selectedLocation === loc.id && styles.chipTextActive]}>{loc.name}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      <View style={styles.topArea}>
        {addButton}
        {!registerStatus.loading && (registerStatus.isStale || !registerStatus.isOpen) && (
          <RegisterStatusBanner
            isOpen={registerStatus.isOpen}
            isStale={registerStatus.isStale}
            register={registerStatus.register}
            onPress={() => navigation.navigate('CashRegister', { locationId: selectedLocation })}
            closedMessage="Cash expenses need it open — UPI still works either way."
          />
        )}
        {!!toast && (
          <View style={styles.toast} accessibilityLiveRegion="polite">
            <Ionicons name="checkmark-circle" size={20} color={Colors.success} />
            <Text style={styles.toastText}>{toast}</Text>
          </View>
        )}
      </View>

      {isBoss ? (
        <ExpenseSummaryView
          todayStr={today}
          locations={locations}
          defaultLocationId={route.params?.locationId || activeLocation?.id || null}
          isOwner={isOwner}
          refreshKey={refreshKey}
          onChangeExpense={openChange}
          onReturn={handleInitiateReturn}
          onShopPicked={setSelectedLocation}
        />
      ) : (
        <>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.dayRow} contentContainerStyle={styles.chipRow}>
            {days.map((d) => (
              <TouchableOpacity
                key={d.date}
                style={[styles.chip, day === d.date && styles.chipActive]}
                onPress={() => setDay(d.date)}
                accessibilityRole="button"
                accessibilityState={{ selected: day === d.date }}
              >
                <Text style={[styles.chipText, day === d.date && styles.chipTextActive]}>{d.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          <FlatList
            data={loadError || !fresh ? [] : expenses}
            keyExtractor={(item) => String(item.id)}
            renderItem={({ item }) => (
              <ExpenseRow
                expense={item}
                canChange={canChange(item)}
                onChange={openChange}
                onReturn={canChange(item) ? handleInitiateReturn : undefined}
              />
            )}
            contentContainerStyle={styles.list}
            ListHeaderComponent={
              <View style={styles.summaryCard}>
                <Text style={styles.summaryLabel}>{dayTitle}</Text>
                {fresh ? (
                  <Text style={styles.summaryAmount}>{rupees(total)}</Text>
                ) : (
                  <Text style={styles.summaryLoading}>{loadError ? ' ' : 'Loading…'}</Text>
                )}
                {day !== today && (
                  <Text style={styles.summaryHint}>Only today's own entries can be changed.</Text>
                )}
              </View>
            }
            ListEmptyComponent={
              <View style={styles.empty}>
                {loading ? <ActivityIndicator color={Colors.primary} /> : loadError ? (
                  <>
                    <Text style={styles.emptyText}>Couldn't load expenses. Check the internet, then tap Try again.</Text>
                    <TouchableOpacity style={styles.retryBtn} onPress={fetchExpenses} accessibilityRole="button">
                      <Text style={styles.retryText}>Try again</Text>
                    </TouchableOpacity>
                  </>
                ) : (
                  <>
                    <Ionicons name="receipt-outline" size={48} color={Colors.textLight} />
                    <Text style={styles.emptyText}>
                      {day === today ? 'No expenses today. Tap Add expense to record one.' : 'No expenses on this day.'}
                    </Text>
                  </>
                )}
              </View>
            }
          />
        </>
      )}

      <AddExpenseSheet
        visible={!!sheet}
        locationId={sheetLocation}
        registerOpen={sheetStatus.isOpen}
        registerLoading={sheetStatus.loading}
        register={sheetStatus.register}
        expense={sheet?.expense || null}
        initial={sheet?.initial || null}
        onClose={() => setSheet(null)}
        onSaved={handleSaved}
        onRegisterOpened={sheetStatus.refetch}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  locRow: { flexGrow: 0, backgroundColor: Colors.surface, borderBottomWidth: 1, borderBottomColor: Colors.border },
  dayRow: { flexGrow: 0, paddingBottom: Spacing.sm },
  chipRow: { paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs, gap: Spacing.sm, alignItems: 'center' },
  chip: {
    minHeight: 44, justifyContent: 'center', paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.full, backgroundColor: Colors.surface,
    borderWidth: 1, borderColor: Colors.border,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '500' },
  chipTextActive: { color: Colors.white, fontWeight: '700' },

  topArea: { paddingHorizontal: Spacing.md, paddingTop: Spacing.sm, paddingBottom: Spacing.sm, gap: Spacing.sm },
  addBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm,
    minHeight: 52, backgroundColor: Colors.primary, borderRadius: BorderRadius.md,
  },
  addBtnText: { color: Colors.white, fontWeight: '700', fontSize: FontSize.md },
  toast: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    padding: Spacing.sm, borderRadius: BorderRadius.md, backgroundColor: Colors.successLight,
  },
  toastText: { flex: 1, fontSize: FontSize.md, fontWeight: '600', color: Colors.text },

  summaryCard: {
    backgroundColor: Colors.surface, padding: Spacing.md, marginBottom: Spacing.sm,
    borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border,
  },
  summaryLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
  summaryAmount: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text, fontVariant: ['tabular-nums'] },
  summaryLoading: { fontSize: FontSize.xl, color: Colors.textSecondary },
  summaryHint: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: Spacing.xs },

  list: { paddingHorizontal: Spacing.md, paddingBottom: Spacing.xxl },

  empty: { alignItems: 'center', paddingTop: Spacing.xxl, gap: Spacing.sm, paddingHorizontal: Spacing.md },
  emptyText: { color: Colors.textSecondary, fontSize: FontSize.md, textAlign: 'center' },
  retryBtn: {
    minHeight: 44, justifyContent: 'center', paddingHorizontal: Spacing.lg,
    borderRadius: BorderRadius.md, backgroundColor: Colors.primary,
  },
  retryText: { color: Colors.white, fontWeight: '700', fontSize: FontSize.md },
});
