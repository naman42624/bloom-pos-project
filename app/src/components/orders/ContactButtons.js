// Call + WhatsApp, usable anywhere a phone number appears on an order.
// See docs/superpowers/specs/2026-09-05-order-list-screens-redesign-design.md
// §4 for the full design rationale (why `contacts` is a list, not a single
// number — a delivery's buyer and receiver can be different people).
import React, { useState } from 'react';
import { View, TouchableOpacity, Text, Modal, StyleSheet, Linking, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Spacing, BorderRadius, FontSize } from '../../constants/theme';
import { normalizePhone, telLink, waLink, buildMessage } from '../../utils/contact';

const MIN_TAP_TARGET = 44; // staff-UX checklist #7 — quick, imprecise taps

export default function ContactButtons({ contacts = [], context = {} }) {
  const [pickerFor, setPickerFor] = useState(null); // 'call' | 'whatsapp' | null

  const usable = contacts.filter((c) => normalizePhone(c.phone));
  if (usable.length === 0) return null;

  const openLink = (url) => {
    Linking.canOpenURL(url).then((supported) => {
      if (supported) Linking.openURL(url);
    }).catch(() => {});
  };

  const act = (kind, contact) => {
    if (kind === 'call') {
      openLink(telLink(contact.phone));
    } else {
      openLink(waLink(contact.phone, buildMessage(context.type, context.params)));
    }
  };

  const handlePress = (kind) => {
    if (usable.length === 1) {
      act(kind, usable[0]);
    } else {
      setPickerFor(kind);
    }
  };

  return (
    <View style={styles.row}>
      <TouchableOpacity style={styles.btn} onPress={() => handlePress('call')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
        <Ionicons name="call" size={18} color={Colors.primary} />
      </TouchableOpacity>
      <TouchableOpacity style={styles.btn} onPress={() => handlePress('whatsapp')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
        <Ionicons name="logo-whatsapp" size={18} color={Colors.secondary} />
      </TouchableOpacity>

      <Modal visible={!!pickerFor} transparent animationType="slide" onRequestClose={() => setPickerFor(null)}>
        <View style={styles.overlay}>
          <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={() => setPickerFor(null)} />
          <View style={styles.sheet}>
            {usable.map((c) => (
              <TouchableOpacity
                key={c.label}
                style={styles.pickerRow}
                onPress={() => { act(pickerFor, c); setPickerFor(null); }}
              >
                <Text style={styles.pickerLabel}>{c.label}</Text>
                <Text style={styles.pickerPhone}>{normalizePhone(c.phone)}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: Spacing.xs },
  btn: {
    width: MIN_TAP_TARGET, height: MIN_TAP_TARGET,
    alignItems: 'center', justifyContent: 'center',
    borderRadius: BorderRadius.full, backgroundColor: Colors.surfaceAlt,
  },
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: { backgroundColor: Colors.surface, borderTopLeftRadius: BorderRadius.lg, borderTopRightRadius: BorderRadius.lg, padding: Spacing.md },
  pickerRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: Spacing.md, borderBottomWidth: 1, borderBottomColor: Colors.border },
  pickerLabel: { fontSize: FontSize.md, color: Colors.text },
  pickerPhone: { fontSize: FontSize.md, color: Colors.textLight },
});
