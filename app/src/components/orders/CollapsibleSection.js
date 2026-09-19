// Generic expand/collapse wrapper for any grouped section (Route/Date/Rider
// on Deliveries, day-grouping on Orders Inbox). Defaults EXPANDED — per the
// staff-UX checklist, collapsing is something staff opt into to declutter,
// never something that hides an order by default.
import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Spacing, FontSize } from '../../constants/theme';

export default function CollapsibleSection({ title, count, defaultExpanded = true, children }) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <View>
      <TouchableOpacity style={styles.header} onPress={() => setExpanded((v) => !v)}>
        <Text style={styles.title}>{title}{typeof count === 'number' ? ` (${count})` : ''}</Text>
        <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={18} color={Colors.textSecondary} />
      </TouchableOpacity>
      {expanded && children}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: Spacing.sm, paddingHorizontal: Spacing.md, minHeight: 44, backgroundColor: Colors.surfaceAlt },
  title: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.textSecondary },
});
