// The bounded search+filters+sort row that replaces the old per-filter-row
// pattern (one permanent row per filter dimension, stacking indefinitely).
// This component NEVER grows past 2 rows regardless of how many filter
// dimensions a screen adds to FilterDrawer's `sections` prop — it doesn't
// even receive `sections`, only a count and an "open the drawer" callback.
// See design doc §3.1a / §3.2.
import React from 'react';
import { View, TextInput, TouchableOpacity, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Spacing, BorderRadius, FontSize } from '../../constants/theme';
import SortControl from './SortControl';

// row2 exists only to hold a view-mode toggle (Route/Date/By Rider, etc.) —
// a screen with no viewModeProps has nothing that needs its own row, so its
// sortProps (if any) rides inline in row1 next to Filters instead. A whole
// extra 44pt-tall row holding one small dropdown, alone, with empty space to
// its left, was real wasted vertical space on a screen that already stacks
// several toolbar rows (live-reported, 2026-09-10) — this isn't decorative
// tightening, it was a measurable density problem. Screens that DO need
// view-mode (Deliveries) keep the original 2-row shape, sort included there
// too, unchanged.
export default function OrderListToolbar({ search, onSearchChange, activeFilterCount = 0, onOpenFilters, sortProps, viewModeProps, placeholder }) {
  return (
    <View>
      <View style={styles.row1}>
        <View style={styles.searchBox}>
          <Ionicons name="search" size={18} color={Colors.textLight} />
          <TextInput
            style={styles.searchInput}
            value={search}
            onChangeText={onSearchChange}
            placeholder={placeholder || 'Search anything…'}
            placeholderTextColor={Colors.textLight}
          />
          {search && search.length > 0 && (
            <TouchableOpacity onPress={() => onSearchChange('')} style={styles.clearBtn}>
              <Ionicons name="close-circle" size={18} color={Colors.textLight} />
            </TouchableOpacity>
          )}
        </View>
        <TouchableOpacity style={styles.filtersBtn} onPress={onOpenFilters}>
          <Ionicons name="options-outline" size={18} color={Colors.primary} />
          <Text style={styles.filtersBtnText}>Filters</Text>
          {activeFilterCount > 0 && (
            <View style={styles.badge}><Text style={styles.badgeText}>{activeFilterCount}</Text></View>
          )}
        </TouchableOpacity>
        {!viewModeProps && sortProps && <SortControl {...sortProps} />}
      </View>

      {viewModeProps && (
        <View style={styles.row2}>
          <View style={styles.viewModeGroup}>
            {viewModeProps.options.map((o) => (
              <TouchableOpacity
                key={o.value}
                style={[styles.viewModeBtn, viewModeProps.value === o.value && styles.viewModeBtnActive]}
                onPress={() => viewModeProps.onChange(o.value)}
              >
                <Text style={[styles.viewModeText, viewModeProps.value === o.value && styles.viewModeTextActive]}>{o.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
          {sortProps && <SortControl {...sortProps} />}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row1: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, paddingHorizontal: Spacing.md, paddingTop: Spacing.sm, paddingBottom: Spacing.xs },
  searchBox: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: Spacing.xs, backgroundColor: Colors.surfaceAlt, borderRadius: BorderRadius.md, paddingHorizontal: Spacing.sm, minHeight: 44 },
  searchInput: { flex: 1, fontSize: FontSize.md, color: Colors.text, paddingVertical: 8 },
  // Explicit minWidth/minHeight (not hitSlop) to hit the app's 44x44pt
  // minimum tap target — matches filtersBtn's minHeight:44 convention
  // below rather than introducing a hitSlop-based pattern.
  clearBtn: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  filtersBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: Colors.surfaceAlt, borderRadius: BorderRadius.md, paddingHorizontal: Spacing.sm, minHeight: 44 },
  filtersBtnText: { fontSize: FontSize.sm, color: Colors.primary, fontWeight: '600' },
  badge: { backgroundColor: Colors.primary, borderRadius: BorderRadius.full, minWidth: 18, height: 18, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  badgeText: { color: Colors.white, fontSize: 11, fontWeight: '700' },
  row2: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: Spacing.md, paddingBottom: Spacing.sm },
  viewModeGroup: { flexDirection: 'row', backgroundColor: Colors.surfaceAlt, borderRadius: BorderRadius.md, padding: 2 },
  viewModeBtn: { paddingVertical: 6, paddingHorizontal: Spacing.sm, borderRadius: BorderRadius.sm, minHeight: 44, justifyContent: 'center' },
  viewModeBtnActive: { backgroundColor: Colors.primary },
  viewModeText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  viewModeTextActive: { color: Colors.white, fontWeight: '600' },
});
