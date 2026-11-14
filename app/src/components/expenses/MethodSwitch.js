/**
 * MethodSwitch: inline segmented "Cash | UPI | Own pocket" for the add sheet
 * (spec 4.1). With Own pocket chosen, one more inline line asks whose pocket:
 *
 *   Paid by   [ Cash | UPI | Own pocket ]
 *   Whose?    (Me) (Ramesh) (Asha)   More ›
 *
 * Own pocket never touches the drawer, so the sheet never disables it when
 * the register is closed (like UPI).
 *
 * Props:
 *   value               'cash' | 'upi' | 'own_pocket' | 'card' | 'shopping_money'
 *   options             [{ key, label, disabled? }]
 *   onChange(key)
 *   locked?             the whole switch is fixed (old register-less cash row)
 *   whose?              shown while value is 'own_pocket':
 *     { meId, people: [{ id, name }], value: id | null (null = Me),
 *       onChange(id | null), state?: 'loading' | 'ready' | 'error', onRetry? }
 */
import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { whoseChips } from '../../utils/staffMoney';
import OptionList from './OptionList';
import { Colors, FontSize, Spacing, BorderRadius } from '../../constants/theme';

export default function MethodSwitch({ value, options, onChange, locked = false, whose }) {
  return (
    <View>
      <View style={[styles.wrap, locked && styles.locked]} accessibilityRole="radiogroup">
        {options.map((o, i) => {
          const active = value === o.key;
          const off = locked ? !active : !!o.disabled;
          return (
            <TouchableOpacity
              key={o.key}
              style={[styles.seg, i > 0 && styles.segBorder, active && styles.segActive, off && styles.segOff]}
              onPress={() => onChange(o.key)}
              disabled={off || locked}
              accessibilityRole="radio"
              accessibilityState={{ selected: active, disabled: off || locked }}
              accessibilityLabel={`Paid by ${o.label}`}
            >
              <Text style={[styles.text, active && styles.textActive, off && styles.textOff]} numberOfLines={1}>{o.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      {value === 'own_pocket' && !!whose && <WhoseLine {...whose} disabled={locked} />}
    </View>
  );
}

function WhoseLine({ meId, people = [], value = null, onChange, state = 'ready', onRetry, disabled = false }) {
  const [showMore, setShowMore] = useState(false);
  const chosen = value == null ? Number(meId) : Number(value);
  const chips = whoseChips(people, meId, chosen);
  const pick = (id) => onChange(Number(id) === Number(meId) ? null : Number(id));

  return (
    <View style={styles.whose}>
      <Text style={styles.whoseLabel}>Whose?</Text>
      <View style={styles.chips}>
        {chips.map((c) => {
          const active = Number(c.id) === chosen;
          return (
            <TouchableOpacity
              key={c.id}
              style={[styles.chip, active && styles.chipActive]}
              onPress={() => pick(c.id)}
              disabled={disabled}
              accessibilityRole="radio"
              accessibilityState={{ selected: active, disabled }}
              accessibilityLabel={`Own pocket of ${c.me ? 'me' : c.label}`}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]} numberOfLines={1}>{c.label}</Text>
            </TouchableOpacity>
          );
        })}
        {!disabled && (
          <TouchableOpacity
            style={styles.more}
            onPress={() => (state === 'error' && onRetry ? onRetry() : setShowMore(true))}
            accessibilityRole="button"
            accessibilityLabel="More people"
          >
            <Text style={styles.moreText}>More</Text>
            <Ionicons name="chevron-forward" size={18} color={Colors.primary} />
          </TouchableOpacity>
        )}
      </View>
      {state === 'error' && (
        <TouchableOpacity onPress={onRetry} style={styles.retry} accessibilityRole="button">
          <Text style={styles.retryText}>Could not load the names. Tap to try again.</Text>
        </TouchableOpacity>
      )}
      <OptionList
        visible={showMore}
        title="Whose pocket was it?"
        search
        searchPlaceholder="Search a name"
        emptyText="No one by that name."
        options={[{ id: meId, name: 'Me' }].concat(people.filter((p) => Number(p.id) !== Number(meId))).map((p) => ({
          key: `u${p.id}`, label: Number(p.id) === Number(meId) ? 'Me' : p.name, selected: Number(p.id) === chosen, id: p.id,
        }))}
        onPick={(o) => { setShowMore(false); pick(o.id); }}
        onClose={() => setShowMore(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row', borderWidth: 1, borderColor: Colors.border, borderRadius: BorderRadius.md,
    overflow: 'hidden', backgroundColor: Colors.surface,
  },
  locked: { opacity: 0.7 },
  seg: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.xs },
  segBorder: { borderLeftWidth: 1, borderLeftColor: Colors.border },
  segActive: { backgroundColor: Colors.primary },
  segOff: { backgroundColor: Colors.surfaceAlt },
  text: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  textActive: { color: Colors.white, fontWeight: '800' },
  textOff: { color: Colors.textLight },

  whose: { marginTop: Spacing.sm },
  whoseLabel: { fontSize: FontSize.md, color: Colors.textSecondary, marginBottom: Spacing.xs },
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
});
