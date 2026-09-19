// A small, separate control from FilterDrawer — deliberately so sorting is
// never confused with filtering. Defaults to whatever `value` the caller
// passes; callers must default that to null/undefined (server's existing
// order) themselves — this component never picks a non-default option on
// its own. See design doc §3.2: no screen's default sort may change as a
// side effect of adding this control.
import React, { useState } from 'react';
import { View, TouchableOpacity, Text, Modal, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Spacing, BorderRadius, FontSize } from '../../constants/theme';

export default function SortControl({ value, onChange, options }) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value) || options[0];

  return (
    <View>
      <TouchableOpacity style={styles.trigger} onPress={() => setOpen(true)}>
        <Text style={styles.triggerText}>Sort: {current.label}</Text>
        <Ionicons name="chevron-down" size={14} color={Colors.textSecondary} />
      </TouchableOpacity>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={() => setOpen(false)}>
          <View style={styles.menu}>
            {options.map((o) => (
              <TouchableOpacity key={String(o.value)} style={styles.item} onPress={() => { onChange(o.value); setOpen(false); }}>
                <Text style={[styles.itemText, o.value === value && styles.itemTextActive]}>{o.label}</Text>
                {o.value === value && <Ionicons name="checkmark" size={16} color={Colors.primary} />}
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  trigger: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: Spacing.sm, paddingHorizontal: Spacing.md, backgroundColor: Colors.surfaceAlt, borderRadius: BorderRadius.md, minHeight: 44 },
  triggerText: { fontSize: FontSize.sm, color: Colors.textSecondary },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.2)', justifyContent: 'flex-start', alignItems: 'flex-end', paddingTop: 100, paddingRight: Spacing.md },
  menu: { backgroundColor: Colors.surface, borderRadius: BorderRadius.md, paddingVertical: Spacing.xs, minWidth: 160, elevation: 4 },
  item: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: Spacing.sm, paddingHorizontal: Spacing.md, minHeight: 44 },
  itemText: { fontSize: FontSize.md, color: Colors.text },
  itemTextActive: { color: Colors.primary, fontWeight: '600' },
});
