// Viewfinder corners + optional torch button drawn over the live camera.
import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, FontSize, Spacing, BorderRadius } from '../../constants/theme';

export const SCAN_BOX = 240;

export default function ScannerFrame({ showTorch, torchOn, onToggleTorch }) {
  return (
    <View style={styles.fill} pointerEvents="box-none">
      <View style={styles.center} pointerEvents="none">
        <View style={styles.box}>
          <View style={[styles.corner, styles.tl]} />
          <View style={[styles.corner, styles.tr]} />
          <View style={[styles.corner, styles.bl]} />
          <View style={[styles.corner, styles.br]} />
        </View>
      </View>
      {showTorch ? (
        <TouchableOpacity
          style={[styles.torch, torchOn && styles.torchOn]}
          onPress={onToggleTorch}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={torchOn ? 'Turn light off' : 'Turn light on'}
          accessibilityState={{ selected: !!torchOn }}
        >
          <Ionicons name={torchOn ? 'flashlight' : 'flashlight-outline'} size={24} color={torchOn ? Colors.text : Colors.white} />
          <Text style={[styles.torchText, torchOn && styles.torchTextOn]}>{torchOn ? 'Light on' : 'Light'}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { ...StyleSheet.absoluteFillObject },
  center: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  box: { width: SCAN_BOX, height: SCAN_BOX },
  corner: { position: 'absolute', width: 36, height: 36, borderColor: Colors.white, borderWidth: 4 },
  tl: { top: 0, left: 0, borderRightWidth: 0, borderBottomWidth: 0, borderTopLeftRadius: BorderRadius.sm },
  tr: { top: 0, right: 0, borderLeftWidth: 0, borderBottomWidth: 0, borderTopRightRadius: BorderRadius.sm },
  bl: { bottom: 0, left: 0, borderRightWidth: 0, borderTopWidth: 0, borderBottomLeftRadius: BorderRadius.sm },
  br: { bottom: 0, right: 0, borderLeftWidth: 0, borderTopWidth: 0, borderBottomRightRadius: BorderRadius.sm },
  torch: {
    position: 'absolute', top: Spacing.md, right: Spacing.md,
    flexDirection: 'row', alignItems: 'center', gap: Spacing.xs,
    minHeight: 48, paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.xl, backgroundColor: 'rgba(0,0,0,0.55)',
  },
  torchOn: { backgroundColor: Colors.white },
  torchText: { color: Colors.white, fontSize: FontSize.md, fontWeight: '600' },
  torchTextOn: { color: Colors.text },
});
