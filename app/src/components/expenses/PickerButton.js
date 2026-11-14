// A plain "Label ▾" button that opens a short list to pick one option from.
// Used at the top of the Expenses screen for the period and the shop, so two
// rows of chips become one line (2026-11-14: the screen felt like too much).
import React, { useState } from 'react';
import { Modal, View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, FontSize, Spacing, BorderRadius } from '../../constants/theme';

export default function PickerButton({ icon, label, title, options, value, onPick, style }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <TouchableOpacity
        style={[styles.button, style]}
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`${title}: ${label}. Change`}
      >
        {!!icon && <Ionicons name={icon} size={18} color={Colors.primary} />}
        <Text style={styles.buttonText} numberOfLines={1}>{label}</Text>
        <Ionicons name="chevron-down" size={18} color={Colors.primary} />
      </TouchableOpacity>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={() => setOpen(false)}>
          <TouchableOpacity activeOpacity={1} style={styles.sheet}>
            <Text style={styles.title}>{title}</Text>
            <ScrollView style={{ maxHeight: 420 }}>
              {options.map((o) => {
                const active = o.key === value;
                return (
                  <TouchableOpacity
                    key={String(o.key)}
                    style={[styles.option, active && styles.optionActive]}
                    onPress={() => { setOpen(false); onPick(o.key); }}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                  >
                    {!!o.icon && <Ionicons name={o.icon} size={20} color={active ? Colors.primary : Colors.textSecondary} />}
                    <Text style={[styles.optionText, active && styles.optionTextActive]}>{o.label}</Text>
                    {active && <Ionicons name="checkmark" size={22} color={Colors.primary} />}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    minHeight: 44, paddingHorizontal: 14, borderRadius: BorderRadius.full || 22,
    borderWidth: 1, borderColor: Colors.primary, backgroundColor: Colors.surface,
  },
  buttonText: { fontSize: FontSize.md, fontWeight: '700', color: Colors.primary, flexShrink: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', padding: Spacing.lg },
  sheet: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg, padding: Spacing.md,
    width: '100%', maxWidth: 420, alignSelf: 'center',
  },
  title: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, marginBottom: Spacing.sm },
  option: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    minHeight: 52, paddingHorizontal: 12, borderRadius: BorderRadius.md,
  },
  optionActive: { backgroundColor: Colors.primaryLight || '#FDE7EF' },
  optionText: { flex: 1, fontSize: FontSize.md, color: Colors.text },
  optionTextActive: { fontWeight: '700', color: Colors.primary },
});
