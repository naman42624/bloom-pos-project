import React from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '../../constants/theme';
import { FONT_FAMILY } from '../../constants/orderDisplay';
import { COLUMN_CARD_CAP } from '../../constants/orderStages';

/**
 * One Stage column (wide) or one collapsible Stage section (narrow).
 *
 * Deliberately one component rather than two: the wide and narrow treatments
 * differ only in the wrapper's flex/scroll behaviour, and keeping them in one
 * file is what stops them drifting apart the way the two dashboards did.
 *
 * Narrow is a plain vertical stack — no horizontal scroll, no swipe. CLAUDE.md
 * forbids hidden gestures, and the people using this have never used business
 * software before.
 *
 * See docs/superpowers/specs/2026-09-01-dashboard-stage-ui-redesign-design.md §5.
 */
export default function StageColumn({ column, orders, isWide, collapsed, onToggleCollapse, renderCard, onShowAll }) {
  const count = orders.length;

  const header = (
    <View style={styles.header}>
      {!isWide && (
        <Ionicons
          name={collapsed ? 'chevron-forward' : 'chevron-down'}
          size={16}
          color={Colors.textSecondary}
        />
      )}
      <Text style={styles.headerLabel}>{column.label}</Text>
      <View style={styles.countPill}>
        <Text style={styles.countText}>{count}</Text>
      </View>
    </View>
  );

  const visible = orders.slice(0, COLUMN_CARD_CAP);
  const hiddenCount = orders.length - visible.length;

  const body = count === 0 ? (
    <Text style={styles.emptyText}>Nothing here</Text>
  ) : (
    <View style={styles.cardStack}>
      {visible.map(renderCard)}
      {hiddenCount > 0 && (
        <TouchableOpacity style={styles.showAllRow} onPress={onShowAll} activeOpacity={0.75}>
          <Text style={styles.showAllText}>{hiddenCount} more — see all</Text>
          <Ionicons name="arrow-forward" size={14} color={Colors.primary} />
        </TouchableOpacity>
      )}
    </View>
  );

  if (isWide) {
    return (
      <View style={styles.wideColumn}>
        {header}
        <ScrollView style={styles.wideScroll} contentContainerStyle={styles.wideScrollContent}>
          {body}
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={styles.narrowSection}>
      <TouchableOpacity onPress={onToggleCollapse} activeOpacity={0.7} style={styles.narrowHeaderTap}>
        {header}
      </TouchableOpacity>
      {!collapsed && <View style={styles.narrowBody}>{body}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  wideColumn: {
    flex: 1,
    minWidth: 0,
    backgroundColor: Colors.surfaceAlt || '#F9FAFB',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    overflow: 'hidden',
  },
  wideScroll: { flexGrow: 0 },
  wideScrollContent: { padding: 10, paddingTop: 0 },
  narrowSection: { marginBottom: 14 },
  narrowHeaderTap: { minHeight: 44, justifyContent: 'center' },
  narrowBody: { paddingTop: 4 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, paddingVertical: 10 },
  headerLabel: { fontSize: 14, fontWeight: '800', color: Colors.text, fontFamily: FONT_FAMILY },
  countPill: {
    minWidth: 24, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 11,
    backgroundColor: '#E5E7EB', alignItems: 'center',
  },
  countText: { fontSize: 12, fontWeight: '800', color: Colors.textSecondary, fontFamily: FONT_FAMILY },
  cardStack: { gap: 10 },
  emptyText: {
    fontSize: 13, color: Colors.textLight, fontFamily: FONT_FAMILY,
    paddingHorizontal: 10, paddingBottom: 10,
  },
  showAllRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    minHeight: 44, borderRadius: 10, borderWidth: 1, borderStyle: 'dashed',
    borderColor: Colors.primary, backgroundColor: Colors.primary + '08',
  },
  showAllText: { fontSize: 14, fontWeight: '700', color: Colors.primary, fontFamily: FONT_FAMILY },
});
