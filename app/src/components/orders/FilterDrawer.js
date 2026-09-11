// The slide-up panel holding every filter dimension as a scrollable list —
// see design doc §3.1a for why this replaced permanently-stacked chip rows.
// Adding a new filter dimension in the future means adding one entry to a
// screen's `sections` array, never a new row on the main screen.
import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, Modal, StyleSheet } from 'react-native';
import { Colors, Spacing, BorderRadius, FontSize } from '../../constants/theme';

export default function FilterDrawer({ visible, onClose, sections, onClearAll }) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>Filters</Text>
            <TouchableOpacity onPress={onClose}><Text style={styles.doneText}>Done</Text></TouchableOpacity>
          </View>
          <ScrollView style={styles.body}>
            {sections.map((section) => (
              <View key={section.key} style={styles.section}>
                <Text style={styles.sectionLabel}>{section.label}</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipScroll} contentContainerStyle={styles.chipRow}>
                  {section.options.map((opt) => (
                    <TouchableOpacity
                      key={String(opt.value)}
                      style={[styles.chip, section.value === opt.value && styles.chipActive]}
                      onPress={() => section.onChange(opt.value)}
                    >
                      <Text style={[styles.chipText, section.value === opt.value && styles.chipTextActive]}>{opt.label}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
            ))}
          </ScrollView>
          <TouchableOpacity style={styles.clearAllBtn} onPress={onClearAll}>
            <Text style={styles.clearAllText}>Clear all filters</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: { backgroundColor: Colors.surface, borderTopLeftRadius: BorderRadius.lg, borderTopRightRadius: BorderRadius.lg, maxHeight: '75%', paddingBottom: Spacing.lg },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: Spacing.md, borderBottomWidth: 1, borderBottomColor: Colors.border },
  title: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  doneText: { fontSize: FontSize.md, color: Colors.primary, fontWeight: '600', minHeight: 44, justifyContent: 'center' },
  body: { paddingHorizontal: Spacing.md },
  section: { marginTop: Spacing.md },
  sectionLabel: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.textSecondary, marginBottom: Spacing.xs },
  // flexGrow/flexShrink: 0 on the ScrollView's own style — see
  // ActiveFilterChips.js's `scroll` style for the full explanation (same
  // react-native-web horizontal-ScrollView-stretch bug).
  chipScroll: { flexGrow: 0, flexShrink: 0 },
  chipRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs },
  chip: { paddingVertical: Spacing.sm, paddingHorizontal: Spacing.md, borderRadius: BorderRadius.full, backgroundColor: Colors.surfaceAlt, minHeight: 44, justifyContent: 'center' },
  chipActive: { backgroundColor: Colors.primary },
  chipText: { fontSize: FontSize.sm, color: Colors.text },
  chipTextActive: { color: Colors.white, fontWeight: '600' },
  clearAllBtn: { marginTop: Spacing.md, marginHorizontal: Spacing.md, alignItems: 'center', paddingVertical: Spacing.sm, minHeight: 44, justifyContent: 'center' },
  clearAllText: { color: Colors.textLight, textDecorationLine: 'underline', fontSize: FontSize.sm },
});
