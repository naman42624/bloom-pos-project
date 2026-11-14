// Sort older entries into items (spec §6.6). Owner only.
//
// Entries saved before items existed (no item, not salary), 50 at a time.
// Each shows its suggested item: tap "✓ Petrol" to accept it, or "Pick item"
// to search (the same suggestions as Add expense) or make a new item from
// the typed name. Nothing changes until "Save N"; then the next 50 load.
// Only the item is set: amount, date, kind and description stay as they are.
import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, FlatList, TextInput, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import useSubmitGuard from '../hooks/useSubmitGuard';
import { showAlert, showConfirm } from '../utils/alert';
import { entriesText } from '../utils/expenseBook';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';
import Button from '../components/Button';
import { shortDate } from '../components/expenses/ExpenseRow';
import { categoryLabel, rupees } from '../components/expenses/AddExpenseSheet';

const PAGE = 50;
const LOAD_FAILED = "Couldn't load the older entries. Check the internet, then tap Try again.";

export default function SortExpensesScreen({ navigation }) {
  const { user } = useAuth();
  const isOwner = user?.role === 'owner';

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // expense_id → { item_id, name } or { item_name, name }
  const [choices, setChoices] = useState({});
  const [saving, setSaving] = useState(false);
  const [doneNote, setDoneNote] = useState('');
  const guardSubmit = useSubmitGuard();

  // "Pick item" search, one row at a time.
  const [pickingId, setPickingId] = useState(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const seq = useRef(0);

  const count = Object.keys(choices).length;
  const dirty = useRef(false);
  dirty.current = count > 0;

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.getUnsortedExpenses({ limit: PAGE });
      setRows((res.data || []).map((r) => ({ ...r, amount: Number(r.amount) || 0 })));
      setChoices({});
      setPickingId(null);
    } catch {
      setError(LOAD_FAILED);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    if (isOwner && !dirty.current) load();
    else if (!isOwner) setLoading(false);
  }, [isOwner, load]));

  useEffect(() => {
    const unsub = navigation.addListener('beforeRemove', (e) => {
      if (!dirty.current) return;
      e.preventDefault();
      showConfirm(
        'Leave without saving?',
        'The items you picked have not been saved.',
        () => navigation.dispatch(e.data.action),
        { confirmLabel: 'Leave', cancelLabel: 'Stay', destructive: true },
      );
    });
    return unsub;
  }, [navigation]);

  const pickingRow = rows.find((r) => r.id === pickingId) || null;
  useEffect(() => {
    const q = query.trim();
    if (!pickingRow || !q) { setResults([]); setSearching(false); return undefined; }
    setSearching(true);
    const id = ++seq.current;
    const timer = setTimeout(async () => {
      try {
        const res = await api.getExpenseSuggestions({ location_id: pickingRow.location_id, q });
        if (id === seq.current) setResults((res.data || []).filter((s) => s.category !== 'salary'));
      } catch {
        if (id === seq.current) setResults([]);
      } finally {
        if (id === seq.current) setSearching(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [query, pickingId]);

  const choose = (expenseId, choice) => {
    setChoices((c) => ({ ...c, [expenseId]: choice }));
    setPickingId(null);
    setQuery('');
    setDoneNote('');
  };
  const clear = (expenseId) => setChoices((c) => {
    const next = { ...c };
    delete next[expenseId];
    return next;
  });
  const toggleSuggestion = (row) => {
    const c = choices[row.id];
    if (c && c.item_id === row.suggested_item.id) clear(row.id);
    else choose(row.id, { item_id: row.suggested_item.id, name: row.suggested_item.name });
  };
  const openPick = (row) => {
    setPickingId(row.id);
    setQuery('');
    setResults([]);
  };

  const withSuggestion = rows.filter((r) => r.suggested_item);
  const allAccepted = withSuggestion.length > 0
    && withSuggestion.every((r) => choices[r.id] && choices[r.id].item_id === r.suggested_item.id);
  const acceptAll = () => {
    setChoices((c) => {
      const next = { ...c };
      withSuggestion.forEach((r) => { if (!next[r.id]) next[r.id] = { item_id: r.suggested_item.id, name: r.suggested_item.name }; });
      return next;
    });
    setDoneNote('');
  };

  const handleSave = guardSubmit(async () => {
    if (count === 0) return;
    const assignments = Object.keys(choices).map((id) => {
      const c = choices[id];
      return c.item_id ? { expense_id: Number(id), item_id: c.item_id } : { expense_id: Number(id), item_name: c.item_name };
    });
    setSaving(true);
    try {
      const res = await api.assignExpenseItems(assignments);
      const assigned = Number(res.data?.assigned) || 0;
      const skipped = (res.data?.skipped || []).length;
      setChoices({});
      dirty.current = false;
      setDoneNote(`Sorted ${entriesText(assigned)}.${skipped ? ` ${entriesText(skipped)} had already been sorted, so ${skipped === 1 ? 'it was' : 'they were'} left as is.` : ''}`);
      await load();
    } catch (err) {
      showAlert('Could not save', err?.message || 'Nothing was changed. Check the internet, then tap Save again.');
    } finally {
      setSaving(false);
    }
  });

  if (!isOwner) {
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>Only the owner can sort older entries.</Text>
      </View>
    );
  }

  const header = (
    <View>
      <Text style={styles.intro}>
        These were saved before items existed. Pick the item for each one. Only the item changes; the amount, date and kind stay the same.
      </Text>
      {!!doneNote && (
        <View style={styles.doneNote} accessibilityLiveRegion="polite">
          <Ionicons name="checkmark-circle" size={20} color={Colors.success} />
          <Text style={styles.doneText}>{doneNote}</Text>
        </View>
      )}
      {withSuggestion.length > 1 && !allAccepted && (
        <TouchableOpacity style={styles.acceptAll} onPress={acceptAll} accessibilityRole="button">
          <Ionicons name="checkmark-done" size={22} color={Colors.primary} />
          <Text style={styles.acceptAllText}>Use all {withSuggestion.length} suggestions</Text>
        </TouchableOpacity>
      )}
      {!!error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
          <Button title="Try again" onPress={load} size="sm" style={styles.retry} />
        </View>
      )}
    </View>
  );

  const renderRow = ({ item: row }) => {
    const chosen = choices[row.id];
    const sug = row.suggested_item;
    const sugAccepted = !!(chosen && sug && chosen.item_id === sug.id);
    const picking = pickingId === row.id;
    const typed = query.trim().replace(/\s+/g, ' ');
    const exact = results.some((s) => s.name.toLowerCase() === typed.toLowerCase());
    return (
      <View style={[styles.card, chosen && styles.cardChosen]}>
        <View style={styles.rowTop}>
          <View style={styles.flex}>
            <Text style={styles.desc}>{row.description || 'No description'}</Text>
            <Text style={styles.meta}>
              {shortDate(row.expense_date)} · {categoryLabel(row.category)}{row.is_return ? ' · money back' : ''}
            </Text>
          </View>
          <Text style={styles.amount}>{rupees(row.amount)}</Text>
        </View>

        {chosen && !sugAccepted ? (
          <View style={styles.actions}>
            <View style={[styles.choiceBtn, styles.choiceOn]}>
              <Ionicons name="checkmark-circle" size={20} color={Colors.white} />
              <Text style={styles.choiceOnText}>{chosen.item_name ? `New item: ${chosen.name}` : chosen.name}</Text>
            </View>
            <TouchableOpacity style={styles.smallBtn} onPress={() => clear(row.id)} accessibilityRole="button" accessibilityLabel={`Undo the item for ${row.description}`}>
              <Text style={styles.smallBtnText}>Undo</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.actions}>
            {sug && (
              <TouchableOpacity
                style={[styles.choiceBtn, sugAccepted ? styles.choiceOn : styles.choiceOff]}
                onPress={() => toggleSuggestion(row)}
                accessibilityRole="button"
                accessibilityState={{ selected: sugAccepted }}
                accessibilityLabel={sugAccepted ? `${sug.name} picked. Tap to undo` : `Use ${sug.name}`}
              >
                <Ionicons name={sugAccepted ? 'checkmark-circle' : 'checkmark'} size={20} color={sugAccepted ? Colors.white : Colors.primary} />
                <Text style={sugAccepted ? styles.choiceOnText : styles.choiceOffText}>{sug.name}</Text>
              </TouchableOpacity>
            )}
            {!sugAccepted && !picking && (
              <TouchableOpacity style={styles.smallBtn} onPress={() => openPick(row)} accessibilityRole="button" accessibilityLabel={`Pick an item for ${row.description}`}>
                <Ionicons name="search" size={18} color={Colors.textSecondary} />
                <Text style={styles.smallBtnText}>{sug ? 'Pick another' : 'Pick item'}</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {picking && (
          <View style={styles.pickBox}>
            <Text style={styles.label}>Which item is this?</Text>
            <TextInput
              style={styles.input}
              value={query}
              onChangeText={setQuery}
              placeholder="Type a name, like Petrol"
              placeholderTextColor={Colors.textLight}
              autoFocus
              accessibilityLabel="Search items"
            />
            {searching && <ActivityIndicator style={styles.gapTop} color={Colors.primary} />}
            {results.map((s) => (
              <TouchableOpacity key={s.id} style={styles.resultRow} onPress={() => choose(row.id, { item_id: s.id, name: s.name })} accessibilityRole="button">
                <View style={styles.flex}>
                  <Text style={styles.resultName}>{s.name}</Text>
                  <Text style={styles.meta}>{categoryLabel(s.category)}</Text>
                </View>
                <Ionicons name="add-circle-outline" size={24} color={Colors.primary} />
              </TouchableOpacity>
            ))}
            {!!typed && !searching && !exact && (
              <TouchableOpacity style={styles.resultRow} onPress={() => choose(row.id, { item_name: typed, name: typed })} accessibilityRole="button">
                <View style={styles.flex}>
                  <Text style={styles.resultName}>New item: "{typed}"</Text>
                  <Text style={styles.meta}>Kind: {categoryLabel(row.category)}</Text>
                </View>
                <Ionicons name="add-circle-outline" size={24} color={Colors.primary} />
              </TouchableOpacity>
            )}
            <TouchableOpacity style={styles.cancel} onPress={() => setPickingId(null)} accessibilityRole="button">
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <FlatList
        data={error ? [] : rows}
        keyExtractor={(r) => String(r.id)}
        renderItem={renderRow}
        extraData={{ choices, pickingId, query, results, searching }}
        ListHeaderComponent={header}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={!error && (
          <View style={styles.empty}>
            {loading ? <ActivityIndicator color={Colors.primary} /> : (
              <>
                <Ionicons name="checkmark-done-circle-outline" size={48} color={Colors.success} />
                <Text style={styles.muted}>All older entries are sorted. Nothing to do here.</Text>
              </>
            )}
          </View>
        )}
      />
      {rows.length > 0 && (
        <View style={styles.footer}>
          <Button
            title={count > 0 ? `Save ${count}` : 'Pick items above, then Save'}
            onPress={handleSave}
            loading={saving}
            disabled={count === 0}
            size="lg"
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.md, paddingBottom: Spacing.xxl, width: '100%', maxWidth: 800, alignSelf: 'center' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: Spacing.lg, backgroundColor: Colors.background },
  flex: { flex: 1 },
  muted: { fontSize: FontSize.md, color: Colors.textSecondary, textAlign: 'center' },
  intro: { fontSize: FontSize.md, color: Colors.textSecondary, marginBottom: Spacing.md },
  doneNote: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, padding: Spacing.sm, marginBottom: Spacing.md,
    borderRadius: BorderRadius.md, backgroundColor: Colors.successLight,
  },
  doneText: { flex: 1, fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  acceptAll: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm, minHeight: 48,
    borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.primary, backgroundColor: Colors.surface,
    marginBottom: Spacing.md,
  },
  acceptAllText: { fontSize: FontSize.md, fontWeight: '700', color: Colors.primary },
  card: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md, padding: Spacing.md, marginBottom: Spacing.sm,
    borderWidth: 1, borderColor: Colors.border,
  },
  cardChosen: { borderColor: Colors.primary },
  rowTop: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.sm },
  desc: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  meta: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  amount: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, fontVariant: ['tabular-nums'] },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: Spacing.sm, marginTop: Spacing.sm },
  choiceBtn: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.xs, minHeight: 44, paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.full, borderWidth: 1, flexShrink: 1,
  },
  choiceOn: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  choiceOff: { backgroundColor: Colors.surface, borderColor: Colors.primary },
  choiceOnText: { color: Colors.white, fontWeight: '700', fontSize: FontSize.md, flexShrink: 1 },
  choiceOffText: { color: Colors.primary, fontWeight: '700', fontSize: FontSize.md, flexShrink: 1 },
  smallBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44, paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border,
  },
  smallBtnText: { color: Colors.textSecondary, fontWeight: '600', fontSize: FontSize.md },
  pickBox: { marginTop: Spacing.sm, paddingTop: Spacing.sm, borderTopWidth: 1, borderTopColor: Colors.border },
  label: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text, marginBottom: Spacing.xs },
  input: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.sm, borderWidth: 1, borderColor: Colors.border,
    paddingHorizontal: Spacing.md, minHeight: 48, fontSize: FontSize.md, color: Colors.text,
  },
  gapTop: { marginTop: Spacing.sm },
  resultRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, minHeight: 52, marginTop: Spacing.sm,
    padding: Spacing.sm, borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border,
  },
  resultName: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  cancel: { minHeight: 44, justifyContent: 'center', alignItems: 'center', marginTop: Spacing.xs },
  cancelText: { fontSize: FontSize.md, color: Colors.textSecondary, fontWeight: '600' },
  errorBox: { backgroundColor: Colors.errorLight, borderRadius: BorderRadius.md, padding: Spacing.md, marginBottom: Spacing.md, gap: Spacing.sm },
  errorText: { fontSize: FontSize.md, color: Colors.text },
  retry: { alignSelf: 'flex-start' },
  empty: { alignItems: 'center', paddingVertical: Spacing.xl, gap: Spacing.sm },
  footer: {
    padding: Spacing.md, backgroundColor: Colors.surface, borderTopWidth: 1, borderTopColor: Colors.border,
  },
});
