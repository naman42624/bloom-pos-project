// The full-screen message shown instead of the camera picture when the camera
// cannot be used (blocked, missing, busy) or is still starting. Shared by the
// web and native scanners.
import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, FontSize, Spacing, BorderRadius } from '../../constants/theme';

export default function ScannerMessage({ icon = 'camera-outline', text, onRetry, loading = false }) {
  return (
    <View style={styles.wrap}>
      {loading
        ? <ActivityIndicator size="large" color={Colors.white} />
        : <Ionicons name={icon} size={56} color={Colors.white} />}
      <Text style={styles.text} accessibilityLiveRegion="polite">{text}</Text>
      {onRetry ? (
        <TouchableOpacity
          style={styles.btn}
          onPress={onRetry}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Try again"
        >
          <Ionicons name="refresh" size={22} color={Colors.white} />
          <Text style={styles.btnText}>Try again</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: Colors.text,
    alignItems: 'center', justifyContent: 'center',
    padding: Spacing.lg,
  },
  text: {
    color: Colors.white, fontSize: FontSize.lg, fontWeight: '600',
    textAlign: 'center', marginTop: Spacing.md, maxWidth: 420, lineHeight: 28,
  },
  btn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm,
    backgroundColor: Colors.primary, borderRadius: BorderRadius.md,
    minHeight: 56, minWidth: 200, paddingHorizontal: Spacing.xl, marginTop: Spacing.lg,
  },
  btnText: { color: Colors.white, fontSize: FontSize.lg, fontWeight: '700' },
});
