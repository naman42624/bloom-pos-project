// Owner's list of expense items (spec §6.5). Reached from the Expenses
// screen and Settings.
//
//   Pinned (shown first when adding)     ↑ ↓ ✕   each tap saves at once
//   [ Search items ]
//   All items: name, kind, entries, usual amount   [Pin]  ›  opens the item
//
// Pins save straight away (no Save button): PUT /expenses/items/pins takes
// the whole pinned list in order, so every up/down/unpin/pin sends it whole.
// A failed save puts the list back as it was and says so.
import React, { useState, useCallback, useMemo, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, FlatList, TextInput, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import useSubmitGuard from '../hooks/useSubmitGuard';
import { showAlert } from '../utils/alert';
import { movePin, unpin, addPin, entriesText } from '../utils/expenseBook';
import { Colors, FontSize, Spacing, BorderRadius, TouchTarget } from '../constants/theme';
import Button from '../components/Button';
import { categoryLabel, rupees } from '../components/expenses/AddExpenseSheet';

const SHOWN_IN_SHEET = 8;
const LOAD_FAILED = "Couldn't load the items. Check the internet, then tap Try again.";

function IconBtn({ name, label, onPress, disabled, color }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      style={[styles.iconBtn, disabled && styles.disabled]}
    >
      <Ionicons name={name} size={22} color={color || Colors.text} />
    </TouchableOpacity>
  );
}

export default function ExpenseItemsScreen({ navigation }) {
  const { user } = useAuth();
  const isOwner = user?.role === 'owner';

  const [items, setItems] = useState([]);
  const [pins, setPins] = useState([]); // ids in order
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [savingPins, setSavingPins] = useState(false);
  const [savedNote, setSavedNote] = useState('');
  const noteTimer = useRef(null);
  const guardSubmit = useSubmitGuard();

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.getExpenseItems({ include_hidden: 1 });
      const list = (res.data || []).filter((r) => !r.merged_into);
      setItems(list);
      setPins(list.filter((r) => r.pinned)
        .sort((a, b) => (a.pin_order ?? 1e9) - (b.pin_order ?? 1e9) || a.name.localeCompare(b.name))
        .map((r) => Number(r.id)));
    } catch {
      setError(LOAD_FAILED);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { if (isOwner) load(); else setLoading(false); }, [isOwner, load]));

  const byId = useMemo(() => new Map(items.map((r) => [Number(r.id), r])), [items]);

  const savePins = guardSubmit(async (next, note) => {
    const before = pins;
    setPins(next);
    setSavingPins(true);
    try {
      await api.setExpenseItemPins(next);
      setItems((list) => list.map((r) => {
        const i = next.indexOf(Number(r.id));
        return { ...r, pinned: i >= 0, pin_order: i >= 0 ? i + 1 : null };
      }));
      setSavedNote(note);
      clearTimeout(noteTimer.current);
      noteTimer.current = setTimeout(() => setSavedNote(''), 3000);
    } catch (err) {
      setPins(before);
      showAlert('Could not save', err?.message || 'The pinned list did not change. Check the internet, then try again.');
    } finally {
      setSavingPins(false);
    }
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase().replace(/\s+/g, ' ');
    return q ? items.filter((r) => r.name.toLowerCase().includes(q)) : items;
  }, [items, search]);

  const openItem = (r) => navigation.navigate('ExpenseItem', { itemId: Number(r.id) });

  if (!isOwner) {
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>Only the owner can change expense items.</Text>
      </View>
    );
  }

  const pinned = pins.map((id) => byId.get(id)).filter(Boolean);

  const header = (
    <View>
      <Text style={styles.section}>Pinned</Text>
      <Text style={styles.intro}>
        Pinned items show first when anyone adds an expense, in this order. The first {SHOWN_IN_SHEET} fit on the Add expense screen.
      </Text>
      {!!savedNote && (
        <View style={styles.savedNote} accessibilityLiveRegion="polite">
          <Ionicons name="checkmark-circle" size={18} color={Colors.success} />
          <Text style={styles.savedText}>{savedNote}</Text>
        </View>
      )}
      {pinned.length === 0 ? (
        <Text style={styles.muted}>Nothing pinned yet. Tap Pin on an item below.</Text>
      ) : pinned.map((r, i) => (
        <View key={r.id} style={styles.pinRow}>
          <Text style={styles.pinNumber}>{i + 1}</Text>
          <View style={styles.flex}>
            <Text style={styles.name}>{r.name}</Text>
            <Text style={styles.meta}>
              {categoryLabel(r.category)}{r.usual_amount != null ? ` · usually ${rupees(r.usual_amount)}` : ''}
              {i >= SHOWN_IN_SHEET ? ' · not shown, move it up' : ''}
            </Text>
          </View>
          <IconBtn name="arrow-up" label={`Move ${r.name} up`} disabled={i === 0 || savingPins} onPress={() => savePins(movePin(pins, i, -1), `${r.name} moved up.`)} />
          <IconBtn name="arrow-down" label={`Move ${r.name} down`} disabled={i === pinned.length - 1 || savingPins} onPress={() => savePins(movePin(pins, i, 1), `${r.name} moved down.`)} />
          <IconBtn name="close-circle-outline" label={`Unpin ${r.name}`} color={Colors.danger} disabled={savingPins} onPress={() => savePins(unpin(pins, r.id), `${r.name} unpinned.`)} />
        </View>
      ))}

      <TouchableOpacity style={styles.sortLink} onPress={() => navigation.navigate('SortExpenses')} accessibilityRole="button">
        <Ionicons name="albums-outline" size={22} color={Colors.primary} />
        <View style={styles.flex}>
          <Text style={styles.sortTitle}>Sort older entries</Text>
          <Text style={styles.meta}>Put entries saved before items into the right item.</Text>
        </View>
        <Ionicons name="chevron-forward" size={20} color={Colors.textSecondary} />
      </TouchableOpacity>

      <Text style={styles.section}>All items</Text>
      <TextInput
        style={styles.search}
        value={search}
        onChangeText={setSearch}
        placeholder="Search items, like Petrol"
        placeholderTextColor={Colors.textLight}
        accessibilityLabel="Search items"
      />
      {!!error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
          <Button title="Try again" onPress={load} size="sm" style={styles.retry} />
        </View>
      )}
    </View>
  );

  return (
    <FlatList
      style={styles.container}
      contentContainerStyle={styles.content}
      data={error ? [] : filtered}
      keyExtractor={(r) => String(r.id)}
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={header}
      renderItem={({ item: r }) => {
        const isPinned = pins.includes(Number(r.id));
        return (
          <View style={styles.itemRow}>
            <TouchableOpacity
              style={styles.itemMain}
              onPress={() => openItem(r)}
              accessibilityRole="button"
              accessibilityLabel={`Open ${r.name}`}
            >
              <View style={styles.flex}>
                <Text style={styles.name}>{r.name}</Text>
                <Text style={styles.meta}>
                  {categoryLabel(r.category)} · {entriesText(r.use_count)}
                  {r.usual_amount != null ? ` · usually ${rupees(r.usual_amount)}` : ''}
                </Text>
                {r.is_active === false && <Text style={styles.hiddenTag}>Hidden: not suggested</Text>}
              </View>
              <Ionicons name="chevron-forward" size={20} color={Colors.textSecondary} />
            </TouchableOpacity>
            {isPinned ? (
              <View style={styles.pinnedTag}>
                <Ionicons name="pin" size={16} color={Colors.primary} />
                <Text style={styles.pinnedTagText}>Pinned</Text>
              </View>
            ) : r.is_active !== false && (
              <TouchableOpacity
                style={[styles.pinBtn, savingPins && styles.disabled]}
                disabled={savingPins}
                onPress={() => savePins(addPin(pins, r.id), `${r.name} pinned.`)}
                accessibilityRole="button"
                accessibilityLabel={`Pin ${r.name}`}
              >
                <Ionicons name="pin-outline" size={18} color={Colors.primary} />
                <Text style={styles.pinBtnText}>Pin</Text>
              </TouchableOpacity>
            )}
          </View>
        );
      }}
      ListEmptyComponent={!error && (
        <View style={styles.empty}>
          {loading ? <ActivityIndicator color={Colors.primary} /> : (
            <Text style={styles.muted}>
              {search.trim() ? 'No item matches that name.' : 'No items yet. They are made when someone adds an expense.'}
            </Text>
          )}
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.md, paddingBottom: Spacing.xxl, width: '100%', maxWidth: 800, alignSelf: 'center' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: Spacing.lg, backgroundColor: Colors.background },
  flex: { flex: 1 },
  muted: { fontSize: FontSize.md, color: Colors.textSecondary, textAlign: 'center' },
  intro: { fontSize: FontSize.md, color: Colors.textSecondary, marginBottom: Spacing.sm },
  section: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, marginTop: Spacing.md, marginBottom: Spacing.xs },
  savedNote: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs, marginBottom: Spacing.sm },
  savedText: { fontSize: FontSize.md, color: Colors.text, fontWeight: '600' },
  pinRow: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    paddingLeft: Spacing.md, paddingRight: Spacing.xs, paddingVertical: Spacing.xs, marginBottom: Spacing.sm,
    borderWidth: 1, borderColor: Colors.border, minHeight: 56, gap: Spacing.xs,
  },
  pinNumber: { width: 24, fontSize: FontSize.md, fontWeight: '700', color: Colors.primary, fontVariant: ['tabular-nums'] },
  name: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  meta: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  iconBtn: { ...TouchTarget, justifyContent: 'center', alignItems: 'center' },
  disabled: { opacity: 0.4 },
  sortLink: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, minHeight: 56, marginTop: Spacing.md,
    padding: Spacing.md, borderRadius: BorderRadius.md, backgroundColor: Colors.surface,
    borderWidth: 1, borderColor: Colors.border,
  },
  sortTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  search: {
    minHeight: 48, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border,
    borderRadius: BorderRadius.md, paddingHorizontal: Spacing.md, fontSize: FontSize.md, color: Colors.text,
    marginBottom: Spacing.sm,
  },
  itemRow: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    marginBottom: Spacing.sm, borderWidth: 1, borderColor: Colors.border, paddingRight: Spacing.sm, gap: Spacing.sm,
  },
  itemMain: { flex: 1, flexDirection: 'row', alignItems: 'center', minHeight: 56, padding: Spacing.md, gap: Spacing.sm },
  hiddenTag: { fontSize: FontSize.sm, color: Colors.warning, fontWeight: '600', marginTop: 2 },
  pinBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44, paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.primary,
  },
  pinBtnText: { color: Colors.primary, fontWeight: '700', fontSize: FontSize.sm },
  pinnedTag: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44, paddingHorizontal: Spacing.sm },
  pinnedTagText: { color: Colors.primary, fontWeight: '600', fontSize: FontSize.sm },
  errorBox: { backgroundColor: Colors.errorLight, borderRadius: BorderRadius.md, padding: Spacing.md, marginBottom: Spacing.md, gap: Spacing.sm },
  errorText: { fontSize: FontSize.md, color: Colors.text },
  retry: { alignSelf: 'flex-start' },
  empty: { alignItems: 'center', paddingVertical: Spacing.xl },
});
