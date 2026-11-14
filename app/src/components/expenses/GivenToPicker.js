/**
 * GivenToPicker: "Given to: Raju ▸" row for the Add expense sheet.
 *
 * Tapping the row shows big name chips (GET /expenses/people, staff and
 * riders linked to the shop, plus the owner), "Someone else" (type a name)
 * and "Nobody / not sure" (clears it). Optional: nothing here blocks Save.
 *
 * Props: locationId, value, onChange(value)
 *   value: { user_id, name, display_name } | null
 *     user_id set   -> a person from the list
 *     user_id null  -> a typed name (name = display_name)
 */
import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../../constants/theme';

export function givenToLabel(value) {
  if (!value) return '';
  return String(value.display_name || value.name || '').trim();
}

export default function GivenToPicker({ locationId, value, onChange }) {
  const [open, setOpen] = useState(false);
  const [people, setPeople] = useState([]);
  const [state, setState] = useState('idle'); // idle | loading | ready | error
  const [typing, setTyping] = useState(false);
  const [typedName, setTypedName] = useState('');

  const load = () => {
    if (!locationId) return;
    setState('loading');
    api.getExpensePeople(locationId)
      .then((res) => { setPeople(res.data || []); setState('ready'); })
      .catch(() => setState('error'));
  };

  // Loaded once when the sheet opens, so the chips show at once on tap.
  useEffect(() => { load(); }, [locationId]);

  const label = givenToLabel(value);

  const pickPerson = (p) => {
    onChange({ user_id: p.id, name: p.name, display_name: p.name });
    setTyping(false);
    setOpen(false);
  };

  const startTyping = () => {
    setTypedName(value && !value.user_id ? label : '');
    setTyping(true);
  };

  const applyTypedName = () => {
    const n = typedName.trim().replace(/\s+/g, ' ');
    onChange(n ? { user_id: null, name: n, display_name: n } : null);
    setTyping(false);
    setOpen(false);
  };

  const clear = () => {
    onChange(null);
    setTyping(false);
    setOpen(false);
  };

  return (
    <View>
      <TouchableOpacity
        style={styles.row}
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={label ? `Given to ${label}. Tap to change.` : 'Given to nobody. Tap to pick a person.'}
      >
        <Ionicons name="person-outline" size={20} color={Colors.textSecondary} />
        <Text style={styles.rowText} numberOfLines={2}>
          Given to: <Text style={label ? styles.rowValue : styles.rowEmpty}>{label || 'nobody'}</Text>
        </Text>
        <Ionicons name={open ? 'chevron-up' : 'chevron-forward'} size={20} color={Colors.textSecondary} />
      </TouchableOpacity>

      {open && (
        <View style={styles.panel}>
          {state === 'loading' && <ActivityIndicator color={Colors.primary} style={{ marginVertical: Spacing.sm }} />}
          {state === 'error' && (
            <TouchableOpacity onPress={load} style={styles.retry} accessibilityRole="button">
              <Text style={styles.retryText}>Could not load the names. Tap to try again.</Text>
            </TouchableOpacity>
          )}
          <View style={styles.chips}>
            {people.map((p) => {
              const active = value && Number(value.user_id) === Number(p.id);
              return (
                <TouchableOpacity
                  key={p.id}
                  style={[styles.chip, active && styles.chipActive]}
                  onPress={() => pickPerson(p)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: !!active }}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>{p.name}</Text>
                </TouchableOpacity>
              );
            })}
            <TouchableOpacity
              style={[styles.chip, (typing || (value && !value.user_id)) && styles.chipActive]}
              onPress={startTyping}
              accessibilityRole="button"
            >
              <Ionicons name="create-outline" size={18} color={(typing || (value && !value.user_id)) ? Colors.white : Colors.textSecondary} />
              <Text style={[styles.chipText, (typing || (value && !value.user_id)) && styles.chipTextActive]}>Someone else</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.chip, !value && styles.chipActive]} onPress={clear} accessibilityRole="button">
              <Text style={[styles.chipText, !value && styles.chipTextActive]}>Nobody / not sure</Text>
            </TouchableOpacity>
          </View>

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
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    minHeight: 48, paddingHorizontal: Spacing.sm,
    borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.background,
  },
  rowText: { flex: 1, fontSize: FontSize.md, color: Colors.textSecondary },
  rowValue: { color: Colors.text, fontWeight: '700' },
  rowEmpty: { color: Colors.textSecondary },
  panel: { marginTop: Spacing.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.xs,
    minHeight: 48, paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.full, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.surface,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: FontSize.md, color: Colors.text },
  chipTextActive: { color: Colors.white, fontWeight: '700' },
  retry: { minHeight: 44, justifyContent: 'center', marginBottom: Spacing.sm },
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
