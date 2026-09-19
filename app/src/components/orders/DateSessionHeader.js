import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Colors, Spacing, FontSize } from '../../constants/theme';

// Pure presentational — must degrade gracefully when sessionLabel is null
// (legacy data predating this feature, or a location/date with no register
// activity at all): only the date renders in that case, never a broken or
// blank session portion.
export default function DateSessionHeader({ dateLabel, sessionLabel, totalAmount }) {
  return (
    <View style={styles.container}>
      <Text style={styles.dateText}>
        {dateLabel}
        {sessionLabel ? ` · ${sessionLabel}` : ''}
        {typeof totalAmount === 'number' ? ` · ₹${totalAmount.toFixed(0)}` : ''}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingVertical: Spacing.sm, paddingHorizontal: Spacing.md, backgroundColor: Colors.background },
  dateText: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.textSecondary },
});
