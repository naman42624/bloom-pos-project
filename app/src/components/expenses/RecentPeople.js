/**
 * RecentPeople: the "Given to" line of the add sheet.
 *
 *   Given to   (Tota Ram) (Ramesh) (Asha)   More ›
 *
 * Three chips: the people last given money on the suggested items, then the
 * shop's people (GET /expenses/people: staff and riders linked to the shop,
 * plus the owner). Tap the chosen chip again to clear it (nobody). "More ›"
 * opens the full list with search: the shop's people, then names typed
 * before at this shop, then "Someone else (type a name)".
 * Optional: nothing here blocks Save.
 *
 * Props: locationId, value, onChange(value), items (suggestion items)
 *   value: { user_id, name, display_name } | null
 *     user_id set   -> a person from the list
 *     user_id null  -> a typed name (name = display_name)
 */
import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../../services/api';
import { recentPeopleChips, givenToFromTyped } from '../../utils/expenseBook';
import OptionList from './OptionList';
import { Colors, FontSize, Spacing, BorderRadius } from '../../constants/theme';

export function givenToLabel(value) {
  if (!value) return '';
  return String(value.display_name || value.name || '').trim();
}

const samePerson = (a, b) => !!a && !!b && (a.user_id
  ? Number(a.user_id) === Number(b.user_id)
  : !b.user_id && givenToLabel(a).toLowerCase() === givenToLabel(b).toLowerCase());

export default function RecentPeople({ locationId, value, onChange, items = [] }) {
  const [people, setPeople] = useState([]);
  const [typedNames, setTypedNames] = useState([]); // names typed before at this shop
  const [state, setState] = useState('idle'); // idle | loading | ready | error
  const [showMore, setShowMore] = useState(false);
  const [typing, setTyping] = useState(false);
  const [typedName, setTypedName] = useState('');

  const load = () => {
    if (!locationId) return;
    setState('loading');
    api.getExpensePeople(locationId)
      .then((res) => { setPeople(res.data || []); setTypedNames(res.typed_names || []); setState('ready'); })
      .catch(() => setState('error'));
  };
  useEffect(() => { load(); }, [locationId]);

  const chips = recentPeopleChips(items, people, value);

  const tapChip = (c) => {
    setTyping(false);
    onChange(samePerson(value, c) ? null : c);
  };

  const startTyping = () => {
    setTypedName(value && !value.user_id ? givenToLabel(value) : '');
    setTyping(true);
  };
  const applyTypedName = () => {
    // Same name in any case: the staff member, or the name typed before.
    onChange(givenToFromTyped(typedName, people, typedNames));
    setTyping(false);
  };

  const options = people.map((p) => ({
    key: `u${p.id}`, label: p.name, selected: !!value && Number(value.user_id) === Number(p.id), person: p,
  })).concat(typedNames.map((t) => {
    const named = { user_id: null, name: t.name, display_name: t.name };
    return { key: `n${t.name.toLowerCase()}`, label: t.name, selected: samePerson(value, named), named };
  }));
  const footer = [
    { key: 'type', label: 'Someone else (type a name)', selected: !!value && !value.user_id && !options.some((o) => o.selected) },
    { key: 'none', label: 'Nobody / not sure', selected: !value },
  ];
  const pick = (o) => {
    setShowMore(false);
    if (o.key === 'type') { startTyping(); return; }
    setTyping(false);
    if (o.key === 'none') { onChange(null); return; }
    if (o.named) { onChange(o.named); return; }
    onChange({ user_id: o.person.id, name: o.person.name, display_name: o.person.name });
  };

  return (
    <View>
      <View style={styles.chips}>
        {chips.map((c) => {
          const active = samePerson(value, c);
          const label = givenToLabel(c);
          return (
            <TouchableOpacity
              key={c.user_id ? `u${c.user_id}` : `n${label}`}
              style={[styles.chip, active && styles.chipActive]}
              onPress={() => tapChip(c)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={active ? `Given to ${label}. Tap again for nobody.` : `Given to ${label}`}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]} numberOfLines={1}>{label}</Text>
            </TouchableOpacity>
          );
        })}
        <TouchableOpacity
          style={styles.more}
          onPress={() => (state === 'error' ? load() : setShowMore(true))}
          accessibilityRole="button"
          accessibilityLabel="More people"
        >
          <Text style={styles.moreText}>More</Text>
          <Ionicons name="chevron-forward" size={18} color={Colors.primary} />
        </TouchableOpacity>
      </View>
      {state === 'error' && (
        <TouchableOpacity onPress={load} style={styles.retry} accessibilityRole="button">
          <Text style={styles.retryText}>Could not load the names. Tap to try again.</Text>
        </TouchableOpacity>
      )}

      {typing && (
        <View style={styles.typeRow}>
          <TextInput
            style={styles.input}
            value={typedName}
            onChangeText={setTypedName}
            placeholder="Their name"
            placeholderTextColor={Colors.textLight}
            autoFocus
            maxLength={80}
            onSubmitEditing={applyTypedName}
            returnKeyType="done"
            accessibilityLabel="Name of the person it was given to"
          />
          <TouchableOpacity style={styles.useBtn} onPress={applyTypedName} accessibilityRole="button">
            <Text style={styles.useBtnText}>Use name</Text>
          </TouchableOpacity>
        </View>
      )}

      <OptionList
        visible={showMore}
        title="Who got the money?"
        search
        searchPlaceholder="Search a name"
        emptyText="No one by that name."
        options={options}
        footer={footer}
        onPick={pick}
        onClose={() => setShowMore(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: Spacing.sm },
  chip: {
    minHeight: 44, maxWidth: 160, paddingHorizontal: Spacing.md, justifyContent: 'center',
    borderRadius: BorderRadius.full, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.surface,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: FontSize.md, color: Colors.text },
  chipTextActive: { color: Colors.white, fontWeight: '700' },
  more: { flexDirection: 'row', alignItems: 'center', minHeight: 44, paddingHorizontal: Spacing.sm },
  moreText: { fontSize: FontSize.md, fontWeight: '700', color: Colors.primary },
  retry: { minHeight: 44, justifyContent: 'center' },
  retryText: { fontSize: FontSize.md, color: Colors.error },
  typeRow: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.sm, alignItems: 'center' },
  input: {
    flex: 1, minHeight: 48, borderWidth: 1, borderColor: Colors.border, borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md, fontSize: FontSize.md, color: Colors.text, backgroundColor: Colors.surface,
  },
  useBtn: {
    minHeight: 48, paddingHorizontal: Spacing.md, borderRadius: BorderRadius.md,
    backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center',
  },
  useBtnText: { color: Colors.white, fontWeight: '700', fontSize: FontSize.md },
});
