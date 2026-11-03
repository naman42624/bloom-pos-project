// Placeholder for the helper's My sales tab. Task 7 replaces this with the
// real list of their own sales today (spec §9.3).
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Colors, FontSize, Spacing } from '../../constants/theme';

export default function MySalesScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>My sales</Text>
      <Text style={styles.body}>Your sales today will show here.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background, padding: Spacing.lg, justifyContent: 'center', alignItems: 'center' },
  title: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text, marginBottom: Spacing.sm },
  body: { fontSize: FontSize.md, color: Colors.textSecondary, textAlign: 'center' },
});
