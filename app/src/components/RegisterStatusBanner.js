import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '../constants/theme';
import { formatDateLabel, formatTime } from '../utils/datetime';

const FONT_FAMILY =
  typeof navigator !== 'undefined' && navigator.product === 'ReactNative'
    ? undefined
    : 'Inter, Geist, system-ui';

/**
 * One reusable "does this screen need to know about the register right now"
 * banner, so every cash-writing screen shows the same thing instead of each
 * inventing its own (found live during the 2026-09-04 cash-register audit:
 * the Dashboard had this pattern, ExpensesScreen had nothing at all).
 *
 * Renders nothing when the register is open and was opened today — the
 * common case needs no banner. Two states get one:
 *   - closed: red, "tap to open it" — blocks a real action (cash sale,
 *     cash expense, cash refund, whichever screen this sits on).
 *   - stale (open, but opened before today — spans a day boundary): amber,
 *     "tap to close it out" — nothing is blocked, this is a heads-up, not
 *     an error. Never auto-closed: closing requires a physical cash count,
 *     which only a human can do (see useRegisterStatus.js).
 *
 * `closedMessage` lets the caller name what's actually blocked ("before
 * logging a cash expense" vs "before taking a cash payment") — the plain-
 * language principle only holds if the message says what THIS screen needs.
 */
export default function RegisterStatusBanner({ isOpen, isStale, register, onPress, closedMessage = 'Tap here to open it before continuing.' }) {
  if (isOpen && !isStale) return null;

  if (!isOpen) {
    return (
      <TouchableOpacity style={[styles.card, styles.cardClosed]} onPress={onPress} activeOpacity={0.75}>
        <Ionicons name="lock-closed-outline" size={22} color="#DC2626" />
        <View style={{ flex: 1 }}>
          <Text style={[styles.title, { color: '#991B1B' }]}>Register isn't open</Text>
          <Text style={[styles.text, { color: '#991B1B' }]}>{closedMessage}</Text>
        </View>
        <Ionicons name="chevron-forward" size={16} color="#991B1B" />
      </TouchableOpacity>
    );
  }

  // isStale — open, but not opened today.
  const openedAt = register?.opening_time || register?.opened_at;
  const openedLabel = openedAt ? `${formatDateLabel(openedAt)} at ${formatTime(openedAt)}` : 'a previous day';
  return (
    <TouchableOpacity style={[styles.card, styles.cardStale]} onPress={onPress} activeOpacity={0.75}>
      <Ionicons name="time-outline" size={22} color="#92400E" />
      <View style={{ flex: 1 }}>
        <Text style={[styles.title, { color: '#92400E' }]}>Register open since {openedLabel}</Text>
        <Text style={[styles.text, { color: '#92400E' }]}>Nothing's blocked — close it out whenever you get a chance.</Text>
      </View>
      <Ionicons name="chevron-forward" size={16} color="#92400E" />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
  },
  cardClosed: { backgroundColor: '#FEF2F2' },
  cardStale: { backgroundColor: '#FEF3C7' },
  title: { fontSize: 14, fontWeight: '700', fontFamily: FONT_FAMILY },
  text: { fontSize: 12, marginTop: 2, fontFamily: FONT_FAMILY },
});
