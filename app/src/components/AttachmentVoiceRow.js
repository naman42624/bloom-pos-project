import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import api from '../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';
import { formatDateTime } from '../utils/datetime';

// Extracted from SaleDetailScreen.js so DashboardScreen (florist/employee task
// cards) can play a sale's voice note attachments inline without navigating
// away — same expo-audio pattern, same styling, one source of truth.
export default function AttachmentVoiceRow({ attachment }) {
  const player = useAudioPlayer(api.getMediaUrl(attachment.file_url));
  const status = useAudioPlayerStatus(player);
  const isPlaying = status.playing;

  const togglePlay = () => {
    if (isPlaying) {
      player.pause();
      return;
    }
    if (status.didJustFinish || (status.duration > 0 && status.currentTime >= status.duration)) {
      player.seekTo(0);
    }
    player.play();
  };

  return (
    <View style={styles.attachmentRow}>
      <TouchableOpacity style={styles.voicePlayBtn} onPress={togglePlay}>
        <Ionicons name={isPlaying ? 'pause' : 'play'} size={16} color={Colors.white} />
      </TouchableOpacity>
      <View style={{ flex: 1 }}>
        <Text style={styles.attachmentLabel}>
          Voice note{attachment.duration_seconds ? ` (${attachment.duration_seconds}s)` : ''}
        </Text>
        {attachment.uploaded_by_name ? (
          <Text style={styles.attachmentMeta}>
            {attachment.uploaded_by_name} • {formatDateTime(attachment.created_at)}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  attachmentRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    paddingVertical: Spacing.sm, paddingHorizontal: Spacing.sm, borderRadius: BorderRadius.sm,
    marginBottom: Spacing.xs, backgroundColor: Colors.background,
  },
  voicePlayBtn: {
    width: 32, height: 32, borderRadius: 16, backgroundColor: Colors.primary,
    justifyContent: 'center', alignItems: 'center',
  },
  attachmentLabel: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  attachmentMeta: { fontSize: FontSize.xs, color: Colors.textLight, marginTop: 2 },
});
