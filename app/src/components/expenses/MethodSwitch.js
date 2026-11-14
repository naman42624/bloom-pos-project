/**
 * MethodSwitch: inline segmented "Cash | UPI" for the add sheet
 * (Task B7 adds "Own pocket").
 *
 * Props:
 *   value               'cash' | 'upi' | 'card'
 *   options             [{ key, label, disabled? }]
 *   onChange(key)
 *   locked?             the whole switch is fixed (old register-less cash row)
 */
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Colors, FontSize, Spacing, BorderRadius } from '../../constants/theme';

export default function MethodSwitch({ value, options, onChange, locked = false }) {
  return (
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
            <Text style={[styles.text, active && styles.textActive, off && styles.textOff]}>{o.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row', borderWidth: 1, borderColor: Colors.border, borderRadius: BorderRadius.md,
    overflow: 'hidden', backgroundColor: Colors.surface,
  },
  locked: { opacity: 0.7 },
  seg: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.sm },
  segBorder: { borderLeftWidth: 1, borderLeftColor: Colors.border },
  segActive: { backgroundColor: Colors.primary },
  segOff: { backgroundColor: Colors.surfaceAlt },
  text: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  textActive: { color: Colors.white, fontWeight: '800' },
  textOff: { color: Colors.textLight },
});
