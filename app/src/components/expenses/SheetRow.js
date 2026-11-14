/**
 * SheetRow: one plain row in the add sheet.
 *
 *   Kind               Food            ›
 *
 * Grey label on the left, value on the right, a chevron when it can be
 * tapped. `disabled` greys it out and shows `hint` under it (the reason).
 *
 * Props: label, value, placeholder?, onPress?, disabled?, hint?, error?,
 *        accessibilityLabel?
 */
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, FontSize, Spacing } from '../../constants/theme';

export default function SheetRow({ label, value, placeholder = '—', onPress, disabled = false, hint, error, accessibilityLabel }) {
  const shown = value != null && String(value).trim() !== '' ? String(value) : placeholder;
  const tappable = !!onPress && !disabled;
  return (
    <View>
      <TouchableOpacity
        style={styles.row}
        onPress={onPress}
        disabled={!tappable}
        accessibilityRole="button"
        accessibilityState={{ disabled: !tappable }}
        accessibilityLabel={accessibilityLabel || `${label}: ${shown}`}
      >
        <Text style={styles.label}>{label}</Text>
        <Text
          style={[styles.value, shown === placeholder && styles.placeholder, disabled && styles.disabledText, !!error && styles.errorText]}
          numberOfLines={2}
        >
          {shown}
        </Text>
        {tappable && <Ionicons name="chevron-forward" size={20} color={Colors.textLight} />}
        {disabled && <Ionicons name="lock-closed-outline" size={16} color={Colors.textLight} />}
      </TouchableOpacity>
      {!!hint && <Text style={styles.hint}>{hint}</Text>}
      {!!error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, minHeight: 52,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.border,
  },
  label: { fontSize: FontSize.md, color: Colors.textSecondary, minWidth: 110 },
  value: { flex: 1, textAlign: 'right', fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  placeholder: { color: Colors.textLight, fontWeight: '400' },
  disabledText: { color: Colors.textLight },
  errorText: { color: Colors.error },
  hint: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: Spacing.xs, marginBottom: Spacing.xs },
  error: { fontSize: FontSize.md, color: Colors.error, marginTop: Spacing.xs },
});
