import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

export function RecorderButton({ isRecording, elapsed, maxSeconds, onPress }) {
  return (
    <View style={styles.container}>
      <TouchableOpacity
        style={[styles.button, isRecording && styles.buttonRecording]}
        onPress={onPress}
        activeOpacity={0.8}
      >
        <Ionicons name={isRecording ? 'stop' : 'mic'} size={22} color={Colors.white} />
        <Text style={styles.buttonText}>
          {isRecording ? `Recording… ${elapsed}s / ${maxSeconds}s` : 'Record voice note'}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginVertical: Spacing.sm },
  button: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: Colors.primary, borderRadius: BorderRadius.lg,
    paddingVertical: 14, paddingHorizontal: Spacing.lg, gap: 8,
  },
  buttonRecording: { backgroundColor: '#D32F2F' },
  buttonText: { color: Colors.white, fontSize: FontSize.md, fontWeight: '600' },
});
