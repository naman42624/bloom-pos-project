// One expense item (spec §6.4). Owner and manager.
//
//   [ Petrol ]  Transport · All shops
//   ▂ ▃ ▅ ▂ ▆ █   last 6 months, this month highlighted; tap a month to list it
//   [Change item] [Merge into…]            owner only
//   This month · 1–14 Nov   ₹2,400  12 entries
//   [Anyone] [Raju] [Suresh]               Given to filter
//   entry rows, each with Change           owner and manager
//
// Params: { itemId, from?, to?, locationId? } (from the Expenses summary).
//
// One call: the server gives the month strip for the last 6 months whatever
// the dates, and the entry list for the chosen period (from..to).
import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, FlatList, ActivityIndicator, TextInput, Switch,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import useSubmitGuard from '../hooks/useSubmitGuard';
import useRegisterStatus from '../hooks/useRegisterStatus';
import { showAlert, showConfirm } from '../utils/alert';
import { getShopTodayStr } from '../utils/datetime';
import {
  periodRange, rangeLabel, monthLabel, monthRange, entriesText, mergeConfirmText,
} from '../utils/expenseBook';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';
import Button from '../components/Button';
import ExpenseRow from '../components/expenses/ExpenseRow';
import AddExpenseSheet, { EXPENSE_CATEGORIES, categoryLabel, rupees } from '../components/expenses/AddExpenseSheet';

const LOAD_FAILED = "Couldn't load this item. Check the internet, then tap Try again.";
const signed = (r) => (r.is_return ? -Number(r.amount || 0) : Number(r.amount || 0));
const shortRupees = (n) => {
  const v = Math.round(Number(n) || 0);
  if (Math.abs(v) >= 100000) return `₹${(v / 100000).toFixed(1).replace(/\.0$/, '')}L`;
  if (Math.abs(v) >= 1000) return `₹${(v / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `₹${v}`;
};

function Chip({ label, active, onPress }) {
  return (
    <TouchableOpacity
      style={[styles.chip, active && styles.chipActive]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: !!active }}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

export default function ExpenseItemScreen({ navigation, route }) {
  const { user, settings, activeLocation } = useAuth();
  const isOwner = user?.role === 'owner';
  const timezone = settings?.timezone?.value || 'Asia/Kolkata';
  const today = getShopTodayStr(timezone);
  const itemId = Number(route.params?.itemId);
  const locationId = route.params?.locationId || null;

  // ── Period ── The period the summary was showing comes first, as "From summary".
  const passed = route.params?.from && route.params?.to ? { from: route.params.from, to: route.params.to } : null;
  const [period, setPeriod] = useState(passed ? 'passed' : 'month');
  const [pickedMonth, setPickedMonth] = useState(null); // 'YYYY-MM' after a bar tap

  // ── Data ──
  const [item, setItem] = useState(null);
  const [details, setDetails] = useState(null); // owner: usual_amount, pinned, use_count …
  const [months, setMonths] = useState([]);
  const [entries, setEntries] = useState([]);
  const [loadedKey, setLoadedKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [shopName, setShopName] = useState('');
  const reqId = useRef(0);

  const sixFrom = months.length ? `${months[0].month}-01` : periodRange('month', today).from;
  const range = period === 'passed' && passed ? passed
    : period === 'last_month' ? periodRange('last_month', today)
      : period === 'six' ? { from: sixFrom, to: today }
        : period === 'picked' && pickedMonth ? monthRange(pickedMonth, today)
          : periodRange('month', today);
  const { from, to } = range;
  const viewKey = `${itemId}|${from}|${to}|${locationId || 'all'}`;
  const fresh = loadedKey === viewKey;

  const [givenTo, setGivenTo] = useState(null);

  // ── Owner tools ──
  const [tool, setTool] = useState(null); // null | 'edit' | 'merge'
  const [form, setForm] = useState(null);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [mergeQuery, setMergeQuery] = useState('');
  const [mergeResults, setMergeResults] = useState([]);
  const [mergeSearching, setMergeSearching] = useState(false);
  const [merging, setMerging] = useState(false);
  const mergeSeq = useRef(0);
  const guardSubmit = useSubmitGuard();

  // An open Change item form is unsaved work: ask before leaving.
  const editOpen = useRef(false);
  editOpen.current = tool === 'edit';
  useEffect(() => {
    const unsub = navigation.addListener('beforeRemove', (e) => {
      if (!editOpen.current) return;
      e.preventDefault();
      showConfirm(
        'Leave without saving?',
        'Your changes to this item have not been saved.',
        () => navigation.dispatch(e.data.action),
        { confirmLabel: 'Leave', cancelLabel: 'Stay', destructive: true },
      );
    });
    return unsub;
  }, [navigation]);

  // ── Change an entry ──
  const [sheet, setSheet] = useState(null);
  const [toast, setToast] = useState('');
  const toastTimer = useRef(null);
  useEffect(() => () => clearTimeout(toastTimer.current), []);
  const showToast = (msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 4000);
  };
  const registerStatus = useRegisterStatus(sheet?.expense?.location_id || locationId || activeLocation?.id || null);

  const load = useCallback(async () => {
    if (!Number.isInteger(itemId) || itemId <= 0) { setError('That item was not found. Go back and pick it again.'); setLoading(false); return; }
    const id = ++reqId.current;
    setLoading(true);
    setError('');
    try {
      const params = { months: 6, from, to };
      if (locationId) params.location_id = locationId;
      const res = await api.getExpenseItemHistory(itemId, params);
      if (id !== reqId.current) return;
      const data = res.data || {};
      setItem(data.item || null);
      setMonths(data.months || []);
      setEntries((data.entries || []).map((r) => ({ ...r, amount: Number(r.amount) || 0 })));
      setLoadedKey(viewKey);
      // Owner: usual amount, pin, hidden and the entry count come from the item list.
      if (isOwner && data.item?.name) {
        try {
          const res = await api.getExpenseItems({ q: data.item.name, include_hidden: 1 });
          if (id === reqId.current) setDetails((res.data || []).find((r) => Number(r.id) === itemId) || null);
        } catch {
          if (id === reqId.current) setDetails(null);
        }
      }
    } catch (err) {
      if (id === reqId.current) setError(err?.status === 404 ? (err.message || LOAD_FAILED) : LOAD_FAILED);
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [viewKey, isOwner]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  useEffect(() => {
    if (!locationId) { setShopName('All shops'); return; }
    let live = true;
    api.getLocations().then((res) => {
      const locs = res.data?.locations || res.data || [];
      const l = locs.find((x) => Number(x.id) === Number(locationId));
      if (live) setShopName(l ? l.name : '');
    }).catch(() => {});
    return () => { live = false; };
  }, [locationId]);

  useEffect(() => {
    if (item?.name) navigation.setOptions({ title: item.name });
  }, [item?.name]);

  // ── Given to filter (on the loaded entries) ──
  const givenNames = useMemo(() => {
    const seen = new Map();
    entries.forEach((r) => { const v = r.given_to_display; if (v) seen.set(v, (seen.get(v) || 0) + 1); });
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
  }, [entries]);
  const shown = useMemo(
    () => (givenTo ? entries.filter((r) => r.given_to_display === givenTo) : entries),
    [entries, givenTo],
  );
  const shownTotal = shown.reduce((s, r) => s + signed(r), 0);

  const pickMonth = (key) => {
    setPickedMonth(key);
    setPeriod('picked');
  };

  // ── Edit item (owner) ──
  const openEdit = () => {
    if (!details) return;
    setForm({
      name: details.name,
      category: details.category,
      movePast: false,
      usual: details.usual_amount == null ? '' : String(details.usual_amount),
      pinned: !!details.pinned,
      active: details.is_active !== false,
    });
    setFormError('');
    setTool('edit');
  };

  const handleSave = guardSubmit(async () => {
    if (!form || !details) return;
    const name = form.name.trim().replace(/\s+/g, ' ');
    if (!name) { setFormError('Type what this was for, like Petrol.'); return; }
    const typed = form.usual.trim().replace(/,/g, '');
    let usual = null;
    if (typed) {
      if (!/^\d+(\.\d{1,2})?$/.test(typed)) { setFormError('Type the usual amount as a number, like 200 or 199.50.'); return; }
      usual = Math.round(Number(typed) * 100) / 100;
    }
    const body = {};
    if (name !== details.name) body.name = name;
    if (form.category !== details.category) { body.category = form.category; body.move_past = !!form.movePast; }
    if (usual !== (details.usual_amount == null ? null : Number(details.usual_amount))) body.usual_amount = usual;
    if (form.pinned !== !!details.pinned) { body.pinned = form.pinned; if (!form.pinned) body.pin_order = null; }
    if (form.active !== (details.is_active !== false)) body.is_active = form.active;
    if (Object.keys(body).length === 0) { setTool(null); return; }
    setFormError('');
    setSaving(true);
    try {
      const res = await api.updateExpenseItem(itemId, body);
      const moved = Number(res.data?.recategorised) || 0;
      setTool(null);
      showToast(moved > 0
        ? `Saved. ${entriesText(moved)} moved to ${categoryLabel(form.category)}.`
        : 'Saved.');
      load();
    } catch (err) {
      showAlert('Could not save', err?.message || 'The item was not saved. Check the internet, then tap Save again.');
    } finally {
      setSaving(false);
    }
  });

  // ── Merge (owner) ──
  useEffect(() => {
    if (tool !== 'merge') return undefined;
    const q = mergeQuery.trim();
    if (!q) { setMergeResults([]); setMergeSearching(false); return undefined; }
    setMergeSearching(true);
    const seq = ++mergeSeq.current;
    const timer = setTimeout(async () => {
      try {
        const res = await api.getExpenseItems({ q });
        if (seq !== mergeSeq.current) return;
        const isSalary = item?.category === 'salary';
        setMergeResults((res.data || []).filter((r) => Number(r.id) !== itemId
          && (r.category === 'salary') === isSalary).slice(0, 10));
      } catch {
        if (seq === mergeSeq.current) setMergeResults([]);
      } finally {
        if (seq === mergeSeq.current) setMergeSearching(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [mergeQuery, tool, itemId, item?.category]);

  const doMerge = guardSubmit(async (target) => {
    setMerging(true);
    try {
      const res = await api.mergeExpenseItem(itemId, target.id);
      const moved = Number(res.data?.moved) || 0;
      const intoName = res.data?.into_name || target.name;
      showAlert('Merged', `${entriesText(moved)} moved into "${intoName}". "${item?.name}" is now hidden.`);
      navigation.replace('ExpenseItem', { itemId: Number(target.id), from: route.params?.from, to: route.params?.to, locationId });
    } catch (err) {
      showAlert('Could not merge', err?.message || 'Nothing was moved. Check the internet, then try again.');
    } finally {
      setMerging(false);
    }
  });

  const askMerge = (target) => {
    showConfirm(
      'Merge items?',
      mergeConfirmText(item?.name || '', target.name, details?.use_count || 0),
      () => doMerge(target),
      { confirmLabel: 'Merge', destructive: true },
    );
  };

  // ── Change / return an entry ──
  const handleReturn = (expense) => setSheet({
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
    registerStatus.refetch();
    if (result?.message) showToast(result.message);
    load();
  };

  // ── Pieces ──
  const merged = !!item?.merged_into;
  const hidden = item && item.is_active === false && !merged;
  const maxMonth = Math.max(1, ...months.map((m) => Math.abs(Number(m.amount) || 0)));
  const thisMonthKey = today.slice(0, 7);
  const selectedMonth = period === 'picked' ? pickedMonth : null;

  const strip = (
    <View style={styles.card}>
      <Text style={styles.cardLabel}>Last 6 months</Text>
      <View style={styles.strip}>
        {months.map((m) => {
          const amt = Number(m.amount) || 0;
          const h = Math.max(4, Math.round((Math.abs(amt) / maxMonth) * 88));
          const isNow = m.month === thisMonthKey;
          const isSel = m.month === selectedMonth;
          const label = monthLabel(m.month, today);
          return (
            <TouchableOpacity
              key={m.month}
              style={[styles.barCol, isSel && styles.barColSelected]}
              onPress={() => pickMonth(m.month)}
              accessibilityRole="button"
              accessibilityState={{ selected: isSel }}
              accessibilityLabel={`${label}${isNow ? ' (this month)' : ''}: ${rupees(amt)}. Show its entries`}
            >
              <Text style={[styles.barAmount, isNow && styles.barAmountNow]}>{shortRupees(amt)}</Text>
              <View style={styles.barTrack}>
                <View style={[styles.bar, { height: h }, isNow ? styles.barNow : null, amt === 0 && styles.barEmpty]} />
              </View>
              <Text style={[styles.barLabel, isNow && styles.barLabelNow]}>{label}</Text>
              {isNow && <Text style={styles.nowTag}>Now</Text>}
            </TouchableOpacity>
          );
        })}
      </View>
      <Text style={styles.hint}>Tap a month to see its entries.</Text>
    </View>
  );

  const kindChoices = EXPENSE_CATEGORIES.filter((c) => c.key !== 'salary');
  const editForm = tool === 'edit' && form && (
    <View style={styles.card}>
      <Text style={styles.toolTitle}>Change item</Text>

      <Text style={styles.label}>Name</Text>
      <TextInput
        style={styles.input}
        value={form.name}
        onChangeText={(v) => { setForm({ ...form, name: v }); setFormError(''); }}
        maxLength={80}
        placeholder="For example: Petrol"
        placeholderTextColor={Colors.textLight}
        accessibilityLabel="Item name"
      />

      <Text style={styles.label}>Kind</Text>
      {details?.category === 'salary' ? (
        <Text style={styles.hint}>Salary items stay Salary. Use Payroll for salary.</Text>
      ) : (
        <View style={styles.wrapRow}>
          {kindChoices.map((c) => (
            <Chip key={c.key} label={c.label} active={form.category === c.key} onPress={() => setForm({ ...form, category: c.key })} />
          ))}
        </View>
      )}
      {form.category !== details?.category && (
        <View style={styles.switchRow}>
          <View style={styles.flex}>
            <Text style={styles.switchLabel}>Also move past entries</Text>
            <Text style={styles.hint}>
              {form.movePast
                ? `The ${entriesText(details?.use_count || 0)} already saved will show as ${categoryLabel(form.category)} too.`
                : `Off: only new entries will be ${categoryLabel(form.category)}. Past entries stay ${categoryLabel(details?.category)}.`}
            </Text>
          </View>
          <Switch
            value={!!form.movePast}
            onValueChange={(v) => setForm({ ...form, movePast: v })}
            trackColor={{ false: Colors.border, true: Colors.primaryLight }}
            thumbColor={form.movePast ? Colors.primary : Colors.surface}
            accessibilityLabel="Also move past entries"
          />
        </View>
      )}

      <Text style={styles.label}>Usual amount (₹)</Text>
      <TextInput
        style={styles.input}
        value={form.usual}
        onChangeText={(v) => { setForm({ ...form, usual: v }); setFormError(''); }}
        keyboardType="decimal-pad"
        placeholder="Leave empty for none"
        placeholderTextColor={Colors.textLight}
        accessibilityLabel="Usual amount in rupees"
      />
      <Text style={styles.hint}>Filled in when staff pick this item. It also updates by itself after each save.</Text>

      <View style={styles.switchRow}>
        <View style={styles.flex}>
          <Text style={styles.switchLabel}>Pinned</Text>
          <Text style={styles.hint}>Pinned items show first when adding an expense.</Text>
        </View>
        <Switch
          value={form.pinned}
          onValueChange={(v) => setForm({ ...form, pinned: v })}
          trackColor={{ false: Colors.border, true: Colors.primaryLight }}
          thumbColor={form.pinned ? Colors.primary : Colors.surface}
          accessibilityLabel="Pinned"
        />
      </View>

      <View style={styles.switchRow}>
        <View style={styles.flex}>
          <Text style={styles.switchLabel}>Show in suggestions</Text>
          <Text style={styles.hint}>Off hides it when adding. Its past entries still count, and typing its name brings it back.</Text>
        </View>
        <Switch
          value={form.active}
          onValueChange={(v) => setForm({ ...form, active: v })}
          trackColor={{ false: Colors.border, true: Colors.primaryLight }}
          thumbColor={form.active ? Colors.primary : Colors.surface}
          accessibilityLabel="Show in suggestions"
        />
      </View>

      {!!formError && <Text style={styles.error}>{formError}</Text>}
      <Button title="Save" onPress={handleSave} loading={saving} style={styles.gapTop} />
      <TouchableOpacity style={styles.cancel} onPress={() => setTool(null)} disabled={saving} accessibilityRole="button">
        <Text style={styles.cancelText}>Cancel</Text>
      </TouchableOpacity>
    </View>
  );

  const mergeBox = tool === 'merge' && (
    <View style={styles.card}>
      <Text style={styles.toolTitle}>Merge "{item?.name}" into…</Text>
      <Text style={styles.hint}>
        Use this when the same thing was saved under two names, like "pertrol" and "Petrol".
        All {entriesText(details?.use_count || 0)} of "{item?.name}" move to the item you pick.
      </Text>
      <Text style={styles.label}>Which item should they move to?</Text>
      <TextInput
        style={styles.input}
        value={mergeQuery}
        onChangeText={setMergeQuery}
        placeholder="Type a name, like Petrol"
        placeholderTextColor={Colors.textLight}
        autoFocus
        accessibilityLabel="Search the item to merge into"
      />
      {mergeSearching && <ActivityIndicator style={styles.gapTop} color={Colors.primary} />}
      {mergeResults.map((r) => (
        <TouchableOpacity
          key={r.id}
          style={styles.resultRow}
          onPress={() => askMerge(r)}
          disabled={merging}
          accessibilityRole="button"
          accessibilityLabel={`Merge into ${r.name}`}
        >
          <View style={styles.flex}>
            <Text style={styles.resultName}>{r.name}</Text>
            <Text style={styles.hint}>{categoryLabel(r.category)} · {entriesText(r.use_count)}</Text>
          </View>
          <Ionicons name="git-merge-outline" size={22} color={Colors.primary} />
        </TouchableOpacity>
      ))}
      {!mergeSearching && !!mergeQuery.trim() && mergeResults.length === 0 && (
        <Text style={[styles.hint, styles.gapTop]}>No other item matches that name.</Text>
      )}
      <TouchableOpacity style={styles.cancel} onPress={() => { setTool(null); setMergeQuery(''); }} disabled={merging} accessibilityRole="button">
        <Text style={styles.cancelText}>Cancel</Text>
      </TouchableOpacity>
    </View>
  );

  const header = (
    <View>
      <View style={styles.card}>
        <Text style={styles.itemName}>{item?.name || ' '}</Text>
        <Text style={styles.itemMeta}>
          {item ? categoryLabel(item.category) : ''}{shopName ? ` · ${shopName}` : ''}
        </Text>
        {merged && (
          <View style={styles.notice}>
            <Ionicons name="information-circle-outline" size={20} color={Colors.info} />
            <Text style={styles.noticeText}>This item was merged into another one. New entries go there.</Text>
            <TouchableOpacity
              style={styles.noticeBtn}
              onPress={() => navigation.push('ExpenseItem', { itemId: Number(item.merged_into), from, to, locationId })}
              accessibilityRole="button"
            >
              <Text style={styles.noticeBtnText}>Open it</Text>
            </TouchableOpacity>
          </View>
        )}
        {hidden && (
          <View style={styles.notice}>
            <Ionicons name="eye-off-outline" size={20} color={Colors.textSecondary} />
            <Text style={styles.noticeText}>Hidden: not suggested when adding. Its past entries still count.</Text>
          </View>
        )}
      </View>

      {!!toast && (
        <View style={styles.toast} accessibilityLiveRegion="polite">
          <Ionicons name="checkmark-circle" size={20} color={Colors.success} />
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      )}

      {months.length > 0 && strip}

      {isOwner && !merged && details && !tool && (
        <View style={styles.toolRow}>
          <TouchableOpacity style={styles.toolBtn} onPress={openEdit} accessibilityRole="button">
            <Ionicons name="create-outline" size={20} color={Colors.primary} />
            <Text style={styles.toolBtnText}>Change item</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.toolBtn} onPress={() => { setMergeQuery(''); setTool('merge'); }} accessibilityRole="button">
            <Ionicons name="git-merge-outline" size={20} color={Colors.primary} />
            <Text style={styles.toolBtnText}>Merge into…</Text>
          </TouchableOpacity>
        </View>
      )}
      {editForm}
      {mergeBox}

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
        {passed && <Chip label={`From summary (${rangeLabel(passed.from, passed.to)})`} active={period === 'passed'} onPress={() => setPeriod('passed')} />}
        <Chip label="This month" active={period === 'month'} onPress={() => setPeriod('month')} />
        <Chip label="Last month" active={period === 'last_month'} onPress={() => setPeriod('last_month')} />
        <Chip label="Last 6 months" active={period === 'six'} onPress={() => setPeriod('six')} />
        {period === 'picked' && pickedMonth && <Chip label={monthLabel(pickedMonth, today)} active onPress={() => {}} />}
      </ScrollView>

      <View style={styles.totalCard}>
        <Text style={styles.cardLabel}>{rangeLabel(from, to)}{givenTo ? ` · given to ${givenTo}` : ''}</Text>
        {fresh ? (
          <>
            <Text style={styles.total}>{rupees(shownTotal)}</Text>
            <Text style={styles.hint}>{entriesText(shown.length)}{entries.length >= 500 ? ' (the first 500 — pick a shorter period to see all)' : ''}</Text>
          </>
        ) : (
          <Text style={styles.loadingText}>{error ? ' ' : 'Loading…'}</Text>
        )}
      </View>

      {givenNames.length > 0 && fresh && (
        <>
          <Text style={styles.filterLabel}>Given to</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
            <Chip label="Anyone" active={!givenTo} onPress={() => setGivenTo(null)} />
            {givenNames.map((n) => <Chip key={n} label={n} active={givenTo === n} onPress={() => setGivenTo(n)} />)}
          </ScrollView>
        </>
      )}

      {!!error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={load} accessibilityRole="button">
            <Text style={styles.retryText}>Try again</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );

  return (
    <View style={styles.container}>
      <FlatList
        data={error || !fresh ? [] : shown}
        keyExtractor={(r) => String(r.id)}
        renderItem={({ item: row }) => (
          <ExpenseRow expense={row} canChange onChange={(e) => setSheet({ expense: e })} onReturn={handleReturn} showDate />
        )}
        ListHeaderComponent={header}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={!error && (
          <View style={styles.empty}>
            {loading || !fresh ? <ActivityIndicator color={Colors.primary} /> : (
              <Text style={styles.hintCenter}>
                {givenTo ? 'Nothing given to this person in this period. Tap "Anyone" to see all.' : 'No entries for this item in this period. Pick another month above.'}
              </Text>
            )}
          </View>
        )}
      />

      <AddExpenseSheet
        visible={!!sheet}
        locationId={sheet?.expense?.location_id || locationId || activeLocation?.id || null}
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
  content: { padding: Spacing.md, paddingBottom: Spacing.xxl, width: '100%', maxWidth: 800, alignSelf: 'center' },
  flex: { flex: 1 },
  card: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md, padding: Spacing.md,
    borderWidth: 1, borderColor: Colors.border, marginBottom: Spacing.md,
  },
  cardLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
  itemName: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text },
  itemMeta: { fontSize: FontSize.md, color: Colors.textSecondary, marginTop: 2 },
  notice: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginTop: Spacing.sm,
    padding: Spacing.sm, borderRadius: BorderRadius.md, backgroundColor: Colors.background, flexWrap: 'wrap',
  },
  noticeText: { flex: 1, fontSize: FontSize.md, color: Colors.text, minWidth: 180 },
  noticeBtn: { minHeight: 44, justifyContent: 'center', paddingHorizontal: Spacing.md, borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.primary },
  noticeBtnText: { color: Colors.primary, fontWeight: '700', fontSize: FontSize.md },
  toast: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginBottom: Spacing.md,
    padding: Spacing.sm, borderRadius: BorderRadius.md, backgroundColor: Colors.successLight,
  },
  toastText: { flex: 1, fontSize: FontSize.md, fontWeight: '600', color: Colors.text },

  strip: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', marginTop: Spacing.sm, gap: Spacing.xs },
  barCol: {
    flex: 1, alignItems: 'center', paddingVertical: Spacing.xs, borderRadius: BorderRadius.md,
    borderWidth: 2, borderColor: 'transparent', minHeight: 48,
  },
  barColSelected: { borderColor: Colors.primary },
  barAmount: { fontSize: FontSize.xs, color: Colors.textSecondary, fontVariant: ['tabular-nums'] },
  barAmountNow: { color: Colors.text, fontWeight: '700' },
  barTrack: { height: 88, justifyContent: 'flex-end', marginVertical: 2 },
  bar: { width: 24, borderRadius: BorderRadius.sm, backgroundColor: Colors.primaryLight },
  barNow: { backgroundColor: Colors.primary },
  barEmpty: { backgroundColor: Colors.border },
  barLabel: { fontSize: FontSize.sm, color: Colors.textSecondary },
  barLabelNow: { color: Colors.text, fontWeight: '700' },
  nowTag: { fontSize: FontSize.xs, color: Colors.primary, fontWeight: '700' },

  toolRow: { flexDirection: 'row', gap: Spacing.sm, marginBottom: Spacing.md, flexWrap: 'wrap' },
  toolBtn: {
    flexGrow: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.xs,
    minHeight: 48, paddingHorizontal: Spacing.md, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.primary, backgroundColor: Colors.surface,
  },
  toolBtnText: { color: Colors.primary, fontWeight: '700', fontSize: FontSize.md },
  toolTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, marginBottom: Spacing.xs },
  label: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text, marginTop: Spacing.md, marginBottom: Spacing.xs },
  input: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.sm, borderWidth: 1, borderColor: Colors.border,
    paddingHorizontal: Spacing.md, minHeight: 48, fontSize: FontSize.md, color: Colors.text,
  },
  wrapRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, marginTop: Spacing.md, minHeight: 48 },
  switchLabel: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  hint: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  hintCenter: { fontSize: FontSize.md, color: Colors.textSecondary, textAlign: 'center' },
  error: { fontSize: FontSize.md, color: Colors.danger, marginTop: Spacing.sm },
  gapTop: { marginTop: Spacing.md },
  cancel: { minHeight: 48, justifyContent: 'center', alignItems: 'center', marginTop: Spacing.xs },
  cancelText: { fontSize: FontSize.md, color: Colors.textSecondary, fontWeight: '600' },
  resultRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, minHeight: 56, marginTop: Spacing.sm,
    padding: Spacing.sm, borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border,
  },
  resultName: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },

  chipRow: { gap: Spacing.sm, alignItems: 'center', paddingBottom: Spacing.sm },
  chip: {
    minHeight: 44, justifyContent: 'center', paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.full, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '500' },
  chipTextActive: { color: Colors.white, fontWeight: '700' },
  filterLabel: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.textSecondary, marginBottom: Spacing.xs },

  totalCard: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md, padding: Spacing.md,
    borderWidth: 1, borderColor: Colors.border, marginBottom: Spacing.md,
  },
  total: { fontSize: FontSize.xxl, fontWeight: '700', color: Colors.text, fontVariant: ['tabular-nums'], marginTop: Spacing.xs },
  loadingText: { fontSize: FontSize.xl, color: Colors.textSecondary, marginTop: Spacing.xs },

  errorBox: { backgroundColor: Colors.errorLight, borderRadius: BorderRadius.md, padding: Spacing.md, marginBottom: Spacing.md, gap: Spacing.sm },
  errorText: { fontSize: FontSize.md, color: Colors.text },
  retryBtn: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', paddingHorizontal: Spacing.md, borderRadius: BorderRadius.md, backgroundColor: Colors.primary },
  retryText: { color: Colors.white, fontWeight: '700', fontSize: FontSize.md },
  empty: { alignItems: 'center', paddingVertical: Spacing.xl },
});
