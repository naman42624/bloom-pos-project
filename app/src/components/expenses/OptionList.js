/**
 * OptionList: a plain list in its own modal, with an optional search box.
 * Used by the add sheet for Kind, Date and Given to › More.
 *
 * Props:
 *   visible, title, onClose()
 *   options   [{ key, label, sublabel?, selected? }]
 *   onPick(option)
 *   search?   show a search box (filters by label)
 *   searchPlaceholder?
 *   emptyText? shown when the search finds nothing
 *   footer?   extra options always shown under the list (not filtered),
 *             same shape as options, e.g. "Someone else (type a name)"
 */
import React, { useEffect, useState } from 'react';
import { Modal, View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { bumpActivity } from '../../hooks/useIdleLock';
import { Colors, FontSize, Spacing, BorderRadius } from '../../constants/theme';

export default function OptionList({
  visible, title, onClose, options = [], onPick, search = false, searchPlaceholder = 'Search', footer = [], emptyText = 'Nothing matches.',
}) {
  const [q, setQ] = useState('');
  useEffect(() => { if (!visible) setQ(''); }, [visible]);
  const needle = q.trim().toLowerCase();
  const shown = needle ? options.filter((o) => String(o.label).toLowerCase().includes(needle)) : options;

  const row = (o) => (
    <TouchableOpacity
      key={o.key}
      style={styles.row}
      onPress={() => onPick(o)}
      accessibilityRole="button"
      accessibilityState={{ selected: !!o.selected }}
    >
      <View style={{ flex: 1 }}>
        <Text style={[styles.label, o.selected && styles.labelActive]}>{o.label}</Text>
        {!!o.sublabel && <Text style={styles.sublabel}>{o.sublabel}</Text>}
      </View>
      {o.selected && <Ionicons name="checkmark" size={22} color={Colors.primary} />}
    </TouchableOpacity>
  );

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.box} onTouchStart={bumpActivity}>
          <View style={styles.header}>
            <Text style={styles.title}>{title}</Text>
            <TouchableOpacity onPress={onClose} style={styles.close} accessibilityRole="button" accessibilityLabel="Close">
              <Ionicons name="close" size={26} color={Colors.textSecondary} />
            </TouchableOpacity>
          </View>
          {search && (
            <TextInput
              style={styles.search}
              value={q}
              onChangeText={setQ}
              placeholder={searchPlaceholder}
              placeholderTextColor={Colors.textLight}
              accessibilityLabel={searchPlaceholder}
            />
          )}
          <ScrollView keyboardShouldPersistTaps="handled" style={styles.list}>
            {shown.map(row)}
            {shown.length === 0 && needle !== '' && <Text style={styles.empty}>{emptyText}</Text>}
            {footer.map(row)}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.4)', padding: Spacing.md },
  box: {
    width: '100%', maxWidth: 480, maxHeight: '85%', backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg, padding: Spacing.md,
  },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.sm },
  title: { flex: 1, fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },
  close: { minWidth: 48, minHeight: 48, alignItems: 'flex-end', justifyContent: 'center' },
  search: {
    minHeight: 48, borderWidth: 1, borderColor: Colors.border, borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md, fontSize: FontSize.md, color: Colors.text, backgroundColor: Colors.background,
    marginBottom: Spacing.sm,
  },
  list: { flexGrow: 0 },
  row: {
    flexDirection: 'row', alignItems: 'center', minHeight: 52, paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.border,
  },
  label: { fontSize: FontSize.md, color: Colors.text },
  labelActive: { fontWeight: '800', color: Colors.primary },
  sublabel: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  empty: { fontSize: FontSize.md, color: Colors.textSecondary, paddingVertical: Spacing.md },
});
