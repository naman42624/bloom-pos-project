/**
 * KmCloseReminder: on Cash Register's Close Session box, before the count,
 * the riders still out today (rider km account spec §7 Reminders):
 *
 *   ⓘ Lakshman has no going-home reading — Add now
 *
 * "Add now" opens the Km reading form with the rider and Going home already
 * picked: type the meter → Save reading. It is only a reminder: it never
 * blocks or delays the close, and if the rider list can't load nothing shows.
 *
 * Props: locationId.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, Modal, KeyboardAvoidingView, Platform, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import api from '../../services/api';
import { bumpActivity } from '../../hooks/useIdleLock';
import { goingHomeReminders } from '../../utils/riderKm';
import KmReadingForm from './KmReadingForm';
import { Colors, FontSize, Spacing, BorderRadius } from '../../constants/theme';

export default function KmCloseReminder({ locationId }) {
  const [list, setList] = useState([]);
  const [adding, setAdding] = useState(null); // { id, name }
  const [closeAsk, setCloseAsk] = useState(0);
  const [note, setNote] = useState('');
  const req = useRef(0);

  const load = useCallback(async () => {
    const n = ++req.current;
    if (!locationId) { setList([]); return; }
    try {
      const res = await api.getKmRiders(locationId);
      if (n === req.current) setList(goingHomeReminders(res.data));
    } catch {
      // Only a reminder: a failed load shows nothing.
      if (n === req.current) setList([]);
    }
  }, [locationId]);
  useEffect(() => { setNote(''); load(); }, [load]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  if (list.length === 0 && !note) return null;
  return (
    <View style={styles.box}>
      {!!note && (
        <View style={styles.note} accessibilityLiveRegion="polite">
          <Ionicons name="checkmark-circle" size={20} color={Colors.success} />
          <Text style={styles.noteText}>{note}</Text>
        </View>
      )}
      {list.map((r) => (
        <TouchableOpacity
          key={r.id}
          style={styles.row}
          onPress={() => setAdding({ id: r.id, name: r.name })}
          accessibilityRole="button"
          accessibilityLabel={r.text}
        >
          <Ionicons name="speedometer-outline" size={22} color={Colors.warning} />
          <Text style={styles.text}>
            {`${r.first} has no going-home reading — `}
            <Text style={styles.link}>Add now</Text>
          </Text>
        </TouchableOpacity>
      ))}
      <Modal visible={!!adding} transparent animationType="slide" onRequestClose={() => setCloseAsk((x) => x + 1)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.overlay}>
          <View onTouchStart={bumpActivity} style={styles.sheet}>
            {!!adding && (
              <KmReadingForm
                locationId={locationId}
                presetRider={adding}
                presetKind="leave"
                closeRequest={closeAsk}
                onClose={() => setAdding(null)}
                onDone={(r) => { setAdding(null); setNote((r && r.message) || 'Saved'); load(); }}
              />
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { marginBottom: Spacing.md, gap: Spacing.xs },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, minHeight: 52, paddingHorizontal: Spacing.sm,
    borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.warning, backgroundColor: Colors.warningLight,
  },
  text: { flex: 1, fontSize: FontSize.md, color: Colors.text },
  link: { fontWeight: '700', color: Colors.primary },
  note: {
    flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.xs, padding: Spacing.sm,
    borderRadius: BorderRadius.md, backgroundColor: Colors.successLight,
  },
  noteText: { flex: 1, fontSize: FontSize.md, color: Colors.text },
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    backgroundColor: Colors.surface, borderTopLeftRadius: BorderRadius.lg, borderTopRightRadius: BorderRadius.lg,
    padding: Spacing.lg, paddingBottom: Spacing.xl, width: '100%', maxWidth: 560, alignSelf: 'center', maxHeight: '92%',
  },
});
