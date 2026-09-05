import React from 'react';
import { View, ScrollView, TouchableOpacity, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Spacing, BorderRadius, FontSize } from '../../constants/theme';

export default function ActiveFilterChips({ filters, labels = {}, onRemove, onClearAll }) {
  const entries = Object.entries(filters || {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (entries.length === 0) return null;

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
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
  row: { flexDirection: 'row', gap: Spacing.xs, paddingVertical: Spacing.xs },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: Colors.primaryLight, borderRadius: BorderRadius.full, paddingVertical: 6, paddingHorizontal: Spacing.sm },
  chipText: { fontSize: FontSize.xs, color: Colors.primaryDark },
  clearAll: { justifyContent: 'center', paddingHorizontal: Spacing.sm },
  clearAllText: { fontSize: FontSize.xs, color: Colors.textLight, textDecorationLine: 'underline' },
});
