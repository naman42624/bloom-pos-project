import React from 'react';
import { View, ScrollView, TouchableOpacity, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Spacing, BorderRadius, FontSize } from '../../constants/theme';

export default function ActiveFilterChips({ filters, labels = {}, onRemove, onClearAll }) {
  // This per-entry "is it active" check decides which chips to RENDER —
  // a different job from the aggregate active-filter COUNT a screen shows
  // on OrderListToolbar's Filters button badge. That count's one canonical
  // source is useOrderListData's `activeFilterCount` (app/src/hooks/
  // useOrderListData.js) — consuming screens should read it from there,
  // not re-derive their own count here or elsewhere, so this codebase
  // doesn't grow a second divergent calculation for one conceptual value
  // (see CLAUDE.md's "Known structural debt" for why that pattern is
  // worth avoiding on sight in this app).
  const entries = Object.entries(filters || {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (entries.length === 0) return null;

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.scroll} contentContainerStyle={styles.row}>
      {entries.map(([key, value]) => (
        <TouchableOpacity key={key} style={styles.chip} onPress={() => onRemove(key)}>
          <Text style={styles.chipText}>{labels[key] ? labels[key](value) : `${key}: ${value}`}</Text>
          <Ionicons name="close" size={14} color={Colors.primary} />
        </TouchableOpacity>
      ))}
      <TouchableOpacity style={styles.clearAll} onPress={onClearAll}>
        <Text style={styles.clearAllText}>Clear all</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  // flexGrow/flexShrink: 0 on the ScrollView's own style (not
  // contentContainerStyle) — without it, react-native-web lets a
  // horizontal ScrollView stretch to fill all remaining vertical space in
  // its flex-column parent, which both distorts each pill-shaped chip
  // (borderRadius: full on a much-too-tall box renders as a near-circle)
  // and makes it compete with the list below for space. Matches the
  // already-working pattern in DeliveriesScreen.js's tabsRow/
  // locationTabsRow — native is unaffected either way.
  scroll: { flexGrow: 0, flexShrink: 0 },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs, paddingVertical: Spacing.xs },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: Colors.primaryLight, borderRadius: BorderRadius.full, paddingVertical: 6, paddingHorizontal: Spacing.sm, minHeight: 44, justifyContent: 'center' },
  chipText: { fontSize: FontSize.xs, color: Colors.primaryDark },
  clearAll: { justifyContent: 'center', paddingHorizontal: Spacing.sm, minHeight: 44 },
  clearAllText: { fontSize: FontSize.xs, color: Colors.textLight, textDecorationLine: 'underline' },
});
