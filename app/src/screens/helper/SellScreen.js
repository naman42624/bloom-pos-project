// Placeholder for the helper's Sell tab. Task 7 replaces this with the real
// scan / find-by-name / take-payment screen (spec §9.1, §9.2).
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Colors, FontSize, Spacing } from '../../constants/theme';

export default function SellScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Sell</Text>
      <Text style={styles.body}>Selling from this phone is almost ready.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background, padding: Spacing.lg, justifyContent: 'center', alignItems: 'center' },
  title: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text, marginBottom: Spacing.sm },
  body: { fontSize: FontSize.md, color: Colors.textSecondary, textAlign: 'center' },
});
