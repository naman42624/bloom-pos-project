import React, { useState } from 'react';
import {
  View, Text, StyleSheet, Modal, TouchableOpacity, Platform, TextInput,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

/**
 * A unified date/time picker that works well on all platforms.
 *
 * On iOS:  Shows native DateTimePicker inline in a modal sheet with Done/Cancel.
 * On Android / Web: Shows a friendly manual-entry UI with quick-select buttons.
 *
 * Props:
 *   visible (bool)       - whether the modal is showing
 *   mode ('date'|'time') - date or time selection
 *   value (Date|null)    - current selected date/time value
 *   minimumDate (Date)   - optional minimum date
 *   onConfirm (Date => void) - called with selected Date
 *   onCancel (() => void)    - called when dismissed
 *   title (string)       - optional title shown at top
 */

let NativePicker = null;
try {
  NativePicker = require('@react-native-community/datetimepicker').default;
} catch {}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function pad(n) { return String(n).padStart(2, '0'); }

export default function DateTimePickerModal({
  visible, mode = 'date', value, minimumDate, onConfirm, onCancel, title,
}) {
  const initial = value || new Date();
  const [tempDate, setTempDate] = useState(initial);
  // Manual entry state
  const [manDay, setManDay] = useState(String(initial.getDate()));
  const [manMonth, setManMonth] = useState(initial.getMonth());
  const [manYear, setManYear] = useState(String(initial.getFullYear()));
  const [manHour, setManHour] = useState(initial.getHours());
  const [manMinute, setManMinute] = useState(initial.getMinutes());

  // Reset state when modal opens
  React.useEffect(() => {
    if (visible) {
      const d = value || new Date();
      setTempDate(d);
      setManDay(String(d.getDate()));
      setManMonth(d.getMonth());
      setManYear(String(d.getFullYear()));
      setManHour(d.getHours());
      setManMinute(d.getMinutes());
    }
  }, [visible, value]);

  const handleConfirm = () => {
    if (Platform.OS === 'ios' && NativePicker) {
      onConfirm(tempDate);
    } else {
      if (mode === 'date') {
        const d = new Date(parseInt(manYear), manMonth, parseInt(manDay) || 1);
        if (isNaN(d.getTime())) { onCancel(); return; }
        onConfirm(d);
      } else {
        const d = new Date();
        d.setHours(manHour, manMinute, 0, 0);
        onConfirm(d);
      }
    }
  };

  // Quick date helpers
  const today = new Date();
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  const dayAfter = new Date(); dayAfter.setDate(dayAfter.getDate() + 2);
  const nextWeek = new Date(); nextWeek.setDate(nextWeek.getDate() + 7);

  const quickDates = [
    { label: 'Today', date: today },
    { label: 'Tomorrow', date: tomorrow },
    { label: `${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dayAfter.getDay()]}`, date: dayAfter },
    { label: 'Next Week', date: nextWeek },
  ].filter(q => !minimumDate || q.date >= new Date(minimumDate.getFullYear(), minimumDate.getMonth(), minimumDate.getDate()));

  // Quick time slots
  const quickTimes = [
    { label: '9:00 AM', h: 9, m: 0 },
    { label: '10:00 AM', h: 10, m: 0 },
    { label: '11:00 AM', h: 11, m: 0 },
    { label: '12:00 PM', h: 12, m: 0 },
    { label: '1:00 PM', h: 13, m: 0 },
    { label: '2:00 PM', h: 14, m: 0 },
    { label: '3:00 PM', h: 15, m: 0 },
    { label: '4:00 PM', h: 16, m: 0 },
    { label: '5:00 PM', h: 17, m: 0 },
    { label: '6:00 PM', h: 18, m: 0 },
    { label: '7:00 PM', h: 19, m: 0 },
    { label: '8:00 PM', h: 20, m: 0 },
  ];

  const formatTime12 = (h, m) => {
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${h12}:${pad(m)} ${ampm}`;
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <View style={styles.overlay}>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onCancel} />
        <View style={styles.sheet}>
          {/* Header */}
          <View style={styles.header}>
            <TouchableOpacity onPress={onCancel}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <Text style={styles.title}>{title || (mode === 'date' ? 'Select Date' : 'Select Time')}</Text>
            <TouchableOpacity onPress={handleConfirm}>
              <Text style={styles.doneText}>Done</Text>
            </TouchableOpacity>
          </View>

          {/* iOS: native inline picker */}
          {Platform.OS === 'ios' && NativePicker && (
            <NativePicker
              value={tempDate}
              mode={mode}
              display="spinner"
              minimumDate={minimumDate}
              onChange={(_, selected) => { if (selected) setTempDate(selected); }}
              style={{ height: 200 }}
            />
          )}

          {/* Android / Web: friendly manual UI */}
          {(Platform.OS !== 'ios' || !NativePicker) && mode === 'date' && (
            <View style={styles.manualBody}>
              {/* Quick select buttons */}
              <Text style={styles.subLabel}>Quick Select</Text>
              <View style={styles.quickRow}>
                {quickDates.map(q => {
                  const isSelected = parseInt(manDay) === q.date.getDate() && manMonth === q.date.getMonth() && parseInt(manYear) === q.date.getFullYear();
                  return (
                    <TouchableOpacity
                      key={q.label}
                      style={[styles.quickBtn, isSelected && styles.quickBtnActive]}
                      onPress={() => {
                        setManDay(String(q.date.getDate()));
                        setManMonth(q.date.getMonth());
                        setManYear(String(q.date.getFullYear()));
                      }}
                    >
                      <Text style={[styles.quickBtnText, isSelected && styles.quickBtnTextActive]}>{q.label}</Text>
                      <Text style={[styles.quickBtnSub, isSelected && styles.quickBtnTextActive]}>
                        {q.date.getDate()} {MONTHS[q.date.getMonth()]}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {/* Manual entry */}
              <Text style={[styles.subLabel, { marginTop: Spacing.md }]}>Or enter manually</Text>
              <View style={styles.manualRow}>
                <View style={styles.manualField}>
                  <Text style={styles.manualLabel}>Day</Text>
                  <TextInput
                    style={styles.manualInput}
                    value={manDay}
                    onChangeText={setManDay}
                    keyboardType="number-pad"
                    maxLength={2}
                    selectTextOnFocus
                  />
                </View>
                <View style={[styles.manualField, { flex: 2 }]}>
                  <Text style={styles.manualLabel}>Month</Text>
                  <View style={styles.monthRow}>
                    <TouchableOpacity
                      style={styles.monthArrow}
                      onPress={() => setManMonth(m => m > 0 ? m - 1 : 11)}
                    >
                      <Ionicons name="chevron-back" size={18} color={Colors.text} />
                    </TouchableOpacity>
                    <Text style={styles.monthText}>{MONTHS[manMonth]}</Text>
                    <TouchableOpacity
                      style={styles.monthArrow}
                      onPress={() => setManMonth(m => m < 11 ? m + 1 : 0)}
                    >
                      <Ionicons name="chevron-forward" size={18} color={Colors.text} />
                    </TouchableOpacity>
                  </View>
                </View>
                <View style={styles.manualField}>
                  <Text style={styles.manualLabel}>Year</Text>
                  <TextInput
                    style={styles.manualInput}
                    value={manYear}
                    onChangeText={setManYear}
                    keyboardType="number-pad"
                    maxLength={4}
                    selectTextOnFocus
                  />
                </View>
              </View>

              {/* Preview */}
              <View style={styles.preview}>
                <Ionicons name="calendar" size={18} color={Colors.primary} />
                <Text style={styles.previewText}>
                  {parseInt(manDay) || '?'} {MONTHS[manMonth]} {manYear}
                </Text>
              </View>
            </View>
          )}

          {(Platform.OS !== 'ios' || !NativePicker) && mode === 'time' && (
            <View style={styles.manualBody}>
              {/* Quick time slots */}
              <Text style={styles.subLabel}>Quick Select</Text>
              <View style={styles.timeGrid}>
                {quickTimes.map(q => {
                  const isSelected = manHour === q.h && manMinute === q.m;
                  return (
                    <TouchableOpacity
                      key={q.label}
                      style={[styles.timeSlot, isSelected && styles.timeSlotActive]}
                      onPress={() => { setManHour(q.h); setManMinute(q.m); }}
                    >
                      <Text style={[styles.timeSlotText, isSelected && styles.timeSlotTextActive]}>{q.label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {/* Custom time */}
              <Text style={[styles.subLabel, { marginTop: Spacing.md }]}>Or set custom time</Text>
              <View style={styles.timeCustomRow}>
                <TouchableOpacity style={styles.timeArrow} onPress={() => setManHour(h => h > 0 ? h - 1 : 23)}>
                  <Ionicons name="chevron-back" size={20} color={Colors.text} />
                </TouchableOpacity>
                <Text style={styles.timeDisplay}>{pad(manHour)}</Text>
                <TouchableOpacity style={styles.timeArrow} onPress={() => setManHour(h => h < 23 ? h + 1 : 0)}>
                  <Ionicons name="chevron-forward" size={20} color={Colors.text} />
                </TouchableOpacity>
                <Text style={styles.timeSep}>:</Text>
                <TouchableOpacity style={styles.timeArrow} onPress={() => setManMinute(m => m >= 15 ? m - 15 : 45)}>
                  <Ionicons name="chevron-back" size={20} color={Colors.text} />
                </TouchableOpacity>
                <Text style={styles.timeDisplay}>{pad(manMinute)}</Text>
                <TouchableOpacity style={styles.timeArrow} onPress={() => setManMinute(m => m <= 44 ? m + 15 : 0)}>
                  <Ionicons name="chevron-forward" size={20} color={Colors.text} />
                </TouchableOpacity>
              </View>
              <View style={styles.preview}>
                <Ionicons name="time" size={18} color={Colors.primary} />
                <Text style={styles.previewText}>{formatTime12(manHour, manMinute)}</Text>
              </View>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    backgroundColor: Colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingBottom: Platform.OS === 'ios' ? 34 : 20,
    maxHeight: '80%',
  },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  cancelText: { fontSize: FontSize.md, color: Colors.textSecondary, fontWeight: '500' },
  doneText: { fontSize: FontSize.md, color: Colors.primary, fontWeight: '700' },
  title: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },

  manualBody: { padding: Spacing.lg },
  subLabel: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.textSecondary, marginBottom: Spacing.sm, textTransform: 'uppercase', letterSpacing: 0.5 },

  quickRow: { flexDirection: 'row', gap: Spacing.sm },
  quickBtn: {
    flex: 1, alignItems: 'center', paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.md, backgroundColor: Colors.background,
    borderWidth: 1.5, borderColor: Colors.border,
  },
  quickBtnActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  quickBtnText: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  quickBtnSub: { fontSize: FontSize.xs, color: Colors.textLight, marginTop: 2 },
  quickBtnTextActive: { color: Colors.white },

  manualRow: { flexDirection: 'row', gap: Spacing.sm },
  manualField: { flex: 1 },
  manualLabel: { fontSize: FontSize.xs, color: Colors.textLight, marginBottom: 4 },
  manualInput: {
    backgroundColor: Colors.background, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border, padding: Spacing.sm,
    fontSize: FontSize.lg, fontWeight: '600', color: Colors.text, textAlign: 'center',
  },
  monthRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.background, borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border, paddingVertical: Spacing.sm },
  monthText: { fontSize: FontSize.lg, fontWeight: '600', color: Colors.text, minWidth: 44, textAlign: 'center' },
  monthArrow: { padding: 4 },

  preview: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm,
    marginTop: Spacing.md, paddingVertical: Spacing.md,
    backgroundColor: Colors.primary + '10', borderRadius: BorderRadius.md,
  },
  previewText: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.primary },

  timeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  timeSlot: {
    paddingHorizontal: 14, paddingVertical: 10,
    borderRadius: BorderRadius.md, backgroundColor: Colors.background,
    borderWidth: 1.5, borderColor: Colors.border,
  },
  timeSlotActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  timeSlotText: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  timeSlotTextActive: { color: Colors.white },

  timeCustomRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4,
    paddingVertical: Spacing.sm,
  },
  timeArrow: { padding: 8, backgroundColor: Colors.background, borderRadius: BorderRadius.md },
  timeDisplay: { fontSize: 28, fontWeight: '800', color: Colors.text, minWidth: 48, textAlign: 'center' },
  timeSep: { fontSize: 28, fontWeight: '800', color: Colors.textLight, marginHorizontal: 4 },
});
