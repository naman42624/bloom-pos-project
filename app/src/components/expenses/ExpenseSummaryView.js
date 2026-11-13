// Owner / manager view of the Expenses screen (spec §6.3).
//
// Period chips (Today · This week · This month · Last month · Pick dates) and
// shop chips ("All shops" + each shop) at the top. Below, either:
//   - the summary: the period total with ▲/▼ vs the same number of days just
//     before, each category with its item lines, then "Older entries" (rows
//     saved before items existed); or
//   - "See all entries": the plain list (GET /expenses) with filters.
//
// Owner only: the "N older entries have no item — Sort them" banner. Item
// lines open ExpenseItem for both owner and manager; the item tools inside
// that screen are owner-only (Task 11).
import React, { useState, useCallback, useMemo, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, FlatList, ActivityIndicator, TextInput,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import api from '../../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../../constants/theme';
import { periodRange, changeLabel, comparisonRange, rangeLabel } from '../../utils/expenseBook';
import DateTimePickerModal from '../DateTimePickerModal';
import ExpenseRow from './ExpenseRow';
import { EXPENSE_CATEGORIES, categoryLabel, rupees } from './AddExpenseSheet';

const PERIODS = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This week' },
  { key: 'month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
];
const ALL = 'all';
const TRUNCATED_MESSAGE = 'Showing the first 500 entries — pick fewer days to see all';
const LOAD_FAILED = "Couldn't load expenses. Check the internet, then tap Try again.";

const pad2 = (n) => String(n).padStart(2, '0');
const toDate = (str) => { const [y, m, d] = str.split('-').map(Number); return new Date(y, m - 1, d); };
const fromDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const signed = (r) => (r.is_return ? -Number(r.amount || 0) : Number(r.amount || 0));

const TONE_COLOR = {
  up: Colors.error, down: Colors.success, new: Colors.info, flat: Colors.textSecondary,
};

function Change({ pct, big = false }) {
  const c = changeLabel(pct);
  return (
    <Text style={[big ? styles.changeBig : styles.change, { color: TONE_COLOR[c.tone] }]}>{c.text}</Text>
  );
}

// The change, plus "was ₹X" whenever there was spending before, so the
// owner sees both numbers (a stopped item reads "₹0 ▼ 100% was ₹600").
function ChangeCol({ pct, previous }) {
  return (
    <View style={styles.itemChange}>
      <Change pct={pct} />
      {Number(previous) > 0 && <Text style={styles.was}>was {rupees(previous)}</Text>}
    </View>
  );
}

function Chip({ label, active, onPress, icon }) {
  return (
    <TouchableOpacity
      style={[styles.chip, active && styles.chipActive]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: !!active }}
    >
      {icon && <Ionicons name={icon} size={16} color={active ? Colors.white : Colors.textSecondary} />}
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

export default function ExpenseSummaryView({
  todayStr, locations = [], defaultLocationId, isOwner, refreshKey = 0,
  onChangeExpense, onReturn, onShopPicked,
}) {
  const navigation = useNavigation();

  // ── Period ──
  const [period, setPeriod] = useState('month');
  const [custom, setCustom] = useState(null); // { from, to } once picked
  const [picking, setPicking] = useState(null); // null | 'from' | 'to'
  const [pickFrom, setPickFrom] = useState(null);
  const range = period === 'custom' && custom ? custom : periodRange(period, todayStr);
  const { from, to } = range;

  // ── Shop ── (null/'all' = every shop)
  const [shop, setShop] = useState(defaultLocationId || ALL);
  const locationParam = shop === ALL ? null : shop;

  // ── Mode ──
  const [mode, setMode] = useState('summary'); // 'summary' | 'list'

  const [summary, setSummary] = useState(null);
  // Which request the data on screen belongs to. When the period, shop or
  // kind changes, the old numbers are hidden (not shown under the new label)
  // until the new answer lands. A refresh of the same view keeps them.
  const [loadedKey, setLoadedKey] = useState('');
  const [rows, setRows] = useState([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const reqId = useRef(0);

  // List filters. Kind (category) goes to the server; Cash/UPI, Added by,
  // Given to and search filter the loaded rows (at most 500).
  const [category, setCategory] = useState(null);
  const [method, setMethod] = useState(null);
  const [addedBy, setAddedBy] = useState(null);
  const [givenTo, setGivenTo] = useState(null);
  const [search, setSearch] = useState('');

  // Compared with: same days last month, last week, yesterday, the month
  // before, or (picked dates) the same number of days just before.
  const prev = comparisonRange(period === 'custom' ? 'custom' : period, from, to);
  const viewKey = [mode, from, to, prev.from, prev.to, locationParam || ALL, mode === 'list' ? (category || '') : ''].join('|');
  const fresh = loadedKey === viewKey;

  const load = useCallback(async () => {
    const id = ++reqId.current;
    setLoading(true);
    setError('');
    try {
      if (mode === 'summary') {
        const res = await api.getExpenseSummaryByItem({
          from, to, prev_from: prev.from, prev_to: prev.to, location_id: locationParam,
        });
        if (id !== reqId.current) return;
        setSummary(res.data || null);
        setLoadedKey(viewKey);
      } else {
        const params = { start_date: from, end_date: to };
        if (locationParam) params.location_id = locationParam;
        if (category) params.category = category;
        const res = await api.getExpenses(params);
        if (id !== reqId.current) return;
        setRows((res.data || []).map((r) => ({ ...r, amount: Number(r.amount) || 0 })));
        setTruncated(!!res.truncated);
        setLoadedKey(viewKey);
      }
    } catch {
      if (id === reqId.current) setError(LOAD_FAILED);
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [viewKey]);

  useFocusEffect(useCallback(() => { load(); }, [load, refreshKey]));

  const pickShop = (id) => {
    setShop(id);
    if (id !== ALL && onShopPicked) onShopPicked(id);
  };

  const onPickedDate = (d) => {
    let str = fromDate(d);
    if (str > todayStr) str = todayStr; // no future days
    if (picking === 'from') {
      setPickFrom(str);
      setPicking('to');
      return;
    }
    const a = pickFrom || str;
    setCustom(a <= str ? { from: a, to: str } : { from: str, to: a });
    setPeriod('custom');
    setPicking(null);
  };

  // ── List filtering ──
  const distinct = (key) => {
    const seen = new Map();
    rows.forEach((r) => { const v = r[key]; if (v) seen.set(v, (seen.get(v) || 0) + 1); });
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
  };
  const addedByNames = useMemo(() => distinct('created_by_name'), [rows]);
  const givenToNames = useMemo(() => distinct('given_to_display'), [rows]);
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (method && String(r.payment_method).toLowerCase() !== method) return false;
      if (addedBy && r.created_by_name !== addedBy) return false;
      if (givenTo && r.given_to_display !== givenTo) return false;
      if (q && ![r.item_name, r.description, r.note].some((t) => String(t || '').toLowerCase().includes(q))) return false;
      return true;
    });
  }, [rows, method, addedBy, givenTo, search]);
  const shownTotal = shown.reduce((s, r) => s + signed(r), 0);

  const periodLabel = period === 'custom'
    ? rangeLabel(from, to)
    : (PERIODS.find((p) => p.key === period) || {}).label;

  const openItem = (itemId) => navigation.navigate('ExpenseItem', { itemId, from, to, locationId: locationParam });

  // ── Pieces ──
  const topBar = (
    <View style={styles.topBar}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
        {PERIODS.map((p) => (
          <Chip key={p.key} label={p.label} active={period === p.key} onPress={() => setPeriod(p.key)} />
        ))}
        <Chip
          icon="calendar-outline"
          label={period === 'custom' && custom ? rangeLabel(custom.from, custom.to) : 'Pick dates'}
          active={period === 'custom'}
          onPress={() => { setPickFrom(null); setPicking('from'); }}
        />
      </ScrollView>
      {locations.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
          <Chip icon="storefront-outline" label="All shops" active={shop === ALL} onPress={() => pickShop(ALL)} />
          {locations.map((l) => (
            <Chip key={l.id} label={l.name} active={Number(shop) === Number(l.id)} onPress={() => pickShop(l.id)} />
          ))}
        </ScrollView>
      )}
    </View>
  );

  const errorBox = !!error && (
    <View style={styles.errorBox}>
      <Text style={styles.errorText}>{error}</Text>
      <TouchableOpacity style={styles.retryBtn} onPress={load} accessibilityRole="button">
        <Text style={styles.retryText}>Try again</Text>
      </TouchableOpacity>
    </View>
  );

  // Memoised: the picker resets its typed fields whenever `value` changes.
  const pickerSeed = picking === 'to' ? (pickFrom || from) : from;
  const pickerValue = useMemo(() => toDate(pickerSeed), [pickerSeed]);

  const picker = (
    <DateTimePickerModal
      visible={!!picking}
      mode="date"
      value={pickerValue}
      title={picking === 'to' ? 'Last day' : 'First day'}
      maximumDate={toDate(todayStr)}
      onConfirm={onPickedDate}
      onCancel={() => setPicking(null)}
    />
  );

  if (mode === 'list') {
    const header = (
      <View>
        <TouchableOpacity style={styles.backRow} onPress={() => setMode('summary')} accessibilityRole="button">
          <Ionicons name="arrow-back" size={20} color={Colors.primary} />
          <Text style={styles.backText}>Back to summary</Text>
        </TouchableOpacity>

        <View style={styles.headerCard}>
          <Text style={styles.headerLabel}>{periodLabel} · {rangeLabel(from, to)}</Text>
          {!fresh ? (
            <Text style={styles.headerLoading}>Loading…</Text>
          ) : truncated ? (
            <Text style={styles.truncated}>{TRUNCATED_MESSAGE}</Text>
          ) : (
            <Text style={styles.headerTotal}>{rupees(shownTotal)}</Text>
          )}
          {fresh && (
            <Text style={styles.headerSub}>
              {shown.length} {shown.length === 1 ? 'entry' : 'entries'}
              {truncated ? ` shown, ${rupees(shownTotal)}` : ''}
            </Text>
          )}
        </View>

        <TextInput
          style={styles.search}
          value={search}
          onChangeText={setSearch}
          placeholder="Search item or note"
          placeholderTextColor={Colors.textLight}
          accessibilityLabel="Search item or note"
        />

        <Text style={styles.filterLabel}>Kind</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}>
          <Chip label="All" active={!category} onPress={() => setCategory(null)} />
          {EXPENSE_CATEGORIES.map((c) => (
            <Chip key={c.key} label={c.label} active={category === c.key} onPress={() => setCategory(c.key)} />
          ))}
        </ScrollView>

        <Text style={styles.filterLabel}>Paid by</Text>
        <View style={[styles.filterRow, styles.wrap]}>
          <Chip label="All" active={!method} onPress={() => setMethod(null)} />
          <Chip label="Cash" active={method === 'cash'} onPress={() => setMethod('cash')} />
          <Chip label="UPI" active={method === 'upi'} onPress={() => setMethod('upi')} />
        </View>

        {addedByNames.length > 1 && (
          <>
            <Text style={styles.filterLabel}>Added by</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}>
              <Chip label="Anyone" active={!addedBy} onPress={() => setAddedBy(null)} />
              {addedByNames.map((n) => <Chip key={n} label={n} active={addedBy === n} onPress={() => setAddedBy(n)} />)}
            </ScrollView>
          </>
        )}

        {givenToNames.length > 0 && (
          <>
            <Text style={styles.filterLabel}>Given to</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}>
              <Chip label="Anyone" active={!givenTo} onPress={() => setGivenTo(null)} />
              {givenToNames.map((n) => <Chip key={n} label={n} active={givenTo === n} onPress={() => setGivenTo(n)} />)}
            </ScrollView>
          </>
        )}
        {errorBox}
      </View>
    );

    return (
      <View style={styles.flex}>
        {topBar}
        <FlatList
          data={error || !fresh ? [] : shown}
          keyExtractor={(r) => String(r.id)}
          renderItem={({ item }) => (
            <ExpenseRow expense={item} canChange onChange={onChangeExpense} onReturn={onReturn} showDate />
          )}
          ListHeaderComponent={header}
          contentContainerStyle={styles.content}
          ListEmptyComponent={!error && (
            <View style={styles.empty}>
              {loading ? <ActivityIndicator color={Colors.primary} /> : (
                <Text style={styles.emptyText}>No entries match. Tap "All" on a filter to see more.</Text>
              )}
            </View>
          )}
        />
        {picker}
      </View>
    );
  }

  // ── Summary ──
  const s = fresh ? summary : null;
  const hasAny = s && ((s.categories || []).length > 0 || (s.older || []).length > 0);

  return (
    <View style={styles.flex}>
      {topBar}
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerCard}>
          <View style={styles.headerTop}>
            <Text style={styles.headerLabel}>{periodLabel} · {rangeLabel(from, to)}</Text>
            {loading && <ActivityIndicator size="small" color={Colors.primary} />}
          </View>
          {s ? (
            <Text style={styles.headerTotal}>{rupees(s.total)}</Text>
          ) : (
            <Text style={styles.headerLoading}>{error ? ' ' : 'Loading…'}</Text>
          )}
          {s && (
            <View style={styles.headerCompare}>
              <Change pct={s.change_pct} big />
              <Text style={styles.headerSub}>
                {' '}vs {rangeLabel(prev.from, prev.to)} ({rupees(s.previous_total)})
              </Text>
            </View>
          )}
        </View>

        {isOwner && s && s.unsorted_count > 0 && (
          <TouchableOpacity
            style={styles.banner}
            onPress={() => navigation.navigate('SortExpenses')}
            accessibilityRole="button"
          >
            <Ionicons name="albums-outline" size={22} color={Colors.warning} />
            <Text style={styles.bannerText}>
              {s.unsorted_count} older {s.unsorted_count === 1 ? 'entry has' : 'entries have'} no item — <Text style={styles.bannerLink}>Sort them</Text>
            </Text>
            <Ionicons name="chevron-forward" size={20} color={Colors.textSecondary} />
          </TouchableOpacity>
        )}

        {errorBox}

        {s && !hasAny && !error && (
          <View style={styles.empty}>
            <Ionicons name="receipt-outline" size={44} color={Colors.textLight} />
            <Text style={styles.emptyText}>No expenses in this period.</Text>
          </View>
        )}

        {s && (s.categories || []).map((c) => (
          <View key={c.category} style={styles.catBlock}>
            <View style={styles.catHead}>
              <Text style={styles.catName}>{categoryLabel(c.category)}</Text>
              <View style={styles.catRight}>
                <Text style={styles.catAmount}>{rupees(c.amount)}</Text>
                <Change pct={c.change_pct} />
                {Number(c.previous_amount) > 0 && <Text style={styles.was}>was {rupees(c.previous_amount)}</Text>}
              </View>
            </View>
            {(c.items || []).map((it) => (
              <TouchableOpacity
                key={it.item_id}
                style={styles.itemLine}
                onPress={() => openItem(it.item_id)}
                accessibilityRole="button"
                accessibilityLabel={`${it.name}, ${rupees(it.amount)}, ${changeLabel(it.change_pct).text}. Open`}
              >
                <Text style={styles.itemName}>{it.name}</Text>
                <Text style={styles.itemAmount}>{rupees(it.amount)}</Text>
                <ChangeCol pct={it.change_pct} previous={it.previous_amount} />
                <Ionicons name="chevron-forward" size={18} color={Colors.textLight} />
              </TouchableOpacity>
            ))}
          </View>
        ))}

        {s && (s.older || []).length > 0 && (
          <View style={styles.catBlock}>
            <View style={styles.catHead}>
              <Text style={styles.catName}>Older entries</Text>
            </View>
            <Text style={styles.olderHint}>Saved before items, so grouped by kind only.</Text>
            {s.older.map((o) => (
              <View key={o.category} style={styles.itemLine}>
                <Text style={styles.itemName}>
                  {categoryLabel(o.category)}
                  <Text style={styles.olderCount}>  {o.count} {o.count === 1 ? 'entry' : 'entries'}</Text>
                </Text>
                <Text style={styles.itemAmount}>{rupees(o.amount)}</Text>
                <ChangeCol pct={o.change_pct} previous={o.previous_amount} />
              </View>
            ))}
          </View>
        )}

        <TouchableOpacity style={styles.seeAll} onPress={() => setMode('list')} accessibilityRole="button">
          <Ionicons name="list" size={20} color={Colors.primary} />
          <Text style={styles.seeAllText}>See all entries</Text>
        </TouchableOpacity>

        {isOwner && (
          <TouchableOpacity
            style={styles.itemsLink}
            onPress={() => navigation.navigate('ExpenseItems')}
            accessibilityRole="button"
          >
            <Ionicons name="pricetags-outline" size={22} color={Colors.primary} />
            <View style={styles.flex}>
              <Text style={styles.itemsLinkTitle}>Expense items</Text>
              <Text style={styles.headerSub}>Pin, rename or merge items</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={Colors.textSecondary} />
          </TouchableOpacity>
        )}
      </ScrollView>
      {picker}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  topBar: {
    backgroundColor: Colors.surface, borderBottomWidth: 1, borderBottomColor: Colors.border,
    paddingVertical: Spacing.xs, gap: Spacing.xs,
  },
  chipRow: { paddingHorizontal: Spacing.md, gap: Spacing.sm, alignItems: 'center' },
  filterRow: { gap: Spacing.sm, alignItems: 'center' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44,
    paddingHorizontal: Spacing.md, borderRadius: BorderRadius.full,
    backgroundColor: Colors.background, borderWidth: 1, borderColor: Colors.border,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '500' },
  chipTextActive: { color: Colors.white, fontWeight: '700' },

  content: { padding: Spacing.md, paddingBottom: Spacing.xxl },

  headerCard: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md, padding: Spacing.md,
    borderWidth: 1, borderColor: Colors.border, marginBottom: Spacing.md,
  },
  headerTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  headerLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
  headerTotal: { fontSize: FontSize.xxl, fontWeight: '700', color: Colors.text, marginTop: Spacing.xs, fontVariant: ['tabular-nums'] },
  headerCompare: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', marginTop: Spacing.xs },
  headerLoading: { fontSize: FontSize.xl, color: Colors.textSecondary, marginTop: Spacing.xs },
  was: { fontSize: FontSize.xs, color: Colors.textSecondary, fontVariant: ['tabular-nums'] },
  headerSub: { fontSize: FontSize.sm, color: Colors.textSecondary },
  truncated: { fontSize: FontSize.md, color: Colors.warning, fontWeight: '600', marginTop: Spacing.xs },
  change: { fontSize: FontSize.sm, fontWeight: '700' },
  changeBig: { fontSize: FontSize.md, fontWeight: '700' },

  banner: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, minHeight: 48,
    backgroundColor: Colors.warningLight, borderRadius: BorderRadius.md,
    padding: Spacing.md, marginBottom: Spacing.md,
  },
  bannerText: { flex: 1, fontSize: FontSize.md, color: Colors.text },
  bannerLink: { color: Colors.primaryDark, fontWeight: '700' },

  catBlock: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md, padding: Spacing.md,
    borderWidth: 1, borderColor: Colors.border, marginBottom: Spacing.md,
  },
  catHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.xs },
  catName: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, flex: 1 },
  catRight: { alignItems: 'flex-end' },
  catAmount: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, fontVariant: ['tabular-nums'] },
  itemLine: {
    flexDirection: 'row', alignItems: 'center', minHeight: 48, gap: Spacing.sm,
    borderTopWidth: 1, borderTopColor: Colors.border,
  },
  itemName: { flex: 1, fontSize: FontSize.md, color: Colors.text },
  itemAmount: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text, fontVariant: ['tabular-nums'] },
  itemChange: { minWidth: 80, alignItems: 'flex-end' },
  olderHint: { fontSize: FontSize.sm, color: Colors.textSecondary, marginBottom: Spacing.xs },
  olderCount: { fontSize: FontSize.sm, color: Colors.textSecondary },

  seeAll: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm,
    minHeight: 48, borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.primary,
    backgroundColor: Colors.surface,
  },
  seeAllText: { fontSize: FontSize.md, fontWeight: '700', color: Colors.primary },
  itemsLink: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, minHeight: 56, marginTop: Spacing.md,
    padding: Spacing.md, borderRadius: BorderRadius.md, backgroundColor: Colors.surface,
    borderWidth: 1, borderColor: Colors.border,
  },
  itemsLinkTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },

  backRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs, minHeight: 44, marginBottom: Spacing.sm },
  backText: { fontSize: FontSize.md, color: Colors.primary, fontWeight: '600' },
  search: {
    minHeight: 48, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border,
    borderRadius: BorderRadius.md, paddingHorizontal: Spacing.md, fontSize: FontSize.md, color: Colors.text,
  },
  filterLabel: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.textSecondary, marginTop: Spacing.md, marginBottom: Spacing.xs, paddingHorizontal: 0 },

  errorBox: {
    backgroundColor: Colors.errorLight, borderRadius: BorderRadius.md, padding: Spacing.md,
    marginVertical: Spacing.md, gap: Spacing.sm,
  },
  errorText: { fontSize: FontSize.md, color: Colors.text },
  retryBtn: {
    alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.md, backgroundColor: Colors.primary,
  },
  retryText: { color: Colors.white, fontWeight: '700', fontSize: FontSize.md },

  empty: { alignItems: 'center', paddingVertical: Spacing.xl, gap: Spacing.sm },
  emptyText: { fontSize: FontSize.md, color: Colors.textSecondary, textAlign: 'center' },
});
