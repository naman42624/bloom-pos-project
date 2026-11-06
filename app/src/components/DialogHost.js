/**
 * DialogHost: the app's own pop-up on web (2026-11-06, A5/D36).
 *
 * The browser's window.alert / window.confirm froze the page and could only
 * offer OK (or OK / Cancel), so every pop-up with a real choice
 * ("Cash / UPI / Cancel") did nothing on web. utils/alert.js now hands web
 * pop-ups to this host instead: any number of buttons, big tap targets,
 * plain text. Native (iPhone / Android) keeps the system Alert.
 *
 * Mounted once at the root (App.js), above every page. Pop-ups that arrive
 * while one is showing wait their turn.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Modal, View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { subscribeDialogs } from '../utils/alert';
import { bumpActivity } from '../hooks/useIdleLock';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const SHIELD_MS = 350;

export default function DialogHost() {
  const [queue, setQueue] = useState([]);

  useEffect(() => subscribeDialogs((dialog) => setQueue((q) => [...q, dialog])), []);

  const current = queue[0] || null;
  // The dialog whose button was already tapped: a fast second tap, before the
  // dialog leaves the screen, must not run its action again.
  const answered = useRef(null);

  // For a moment after a button is tapped, an invisible cover stays over the
  // screen, so the second half of a double tap cannot press whatever sat
  // under the dialog (found on screen: it opened the photo picker).
  const [shield, setShield] = useState(false);
  const shieldTimer = useRef(null);
  useEffect(() => () => clearTimeout(shieldTimer.current), []);

  const close = (button) => {
    if (!current || answered.current === current) return;
    answered.current = current;
    setQueue((q) => q.slice(1));
    setShield(true);
    clearTimeout(shieldTimer.current);
    shieldTimer.current = setTimeout(() => setShield(false), SHIELD_MS);
    // Run the handler after the dialog is gone, as the system Alert does
    if (button && typeof button.onPress === 'function') setTimeout(() => button.onPress(), 0);
  };

  if (!current) {
    if (!shield) return null;
    return (
      <Modal visible transparent animationType="none" onRequestClose={() => {}}>
        <View style={styles.shield} />
      </Modal>
    );
  }

  const buttons = current.buttons;
  const cancelButton = buttons.find((b) => b.style === 'cancel');
  // Back / tapping outside: only when there is a cancel button (or a single
  // OK), never silently choosing an action.
  const dismiss = () => {
    if (cancelButton) close(cancelButton);
    else if (buttons.length === 1) close(buttons[0]);
  };
  // Primary action first and largest; Cancel last, as a quiet button that
  // stays on screen even when a long list of choices has to scroll
  const actions = buttons.filter((b) => b.style !== 'cancel');
  const cancels = buttons.filter((b) => b.style === 'cancel');

  const renderButton = (b, i) => {
    const isCancel = b.style === 'cancel';
    const isDanger = b.style === 'destructive';
    // A long list of equal choices (e.g. pick a material) has no main action
    const isPrimary = !isCancel && i === 0 && actions.length <= 3;
    return (
      <TouchableOpacity
        key={`${isCancel ? 'c' : 'a'}${i}-${b.text}`}
        onPress={() => close(b)}
        accessibilityRole="button"
        accessibilityLabel={b.text}
        activeOpacity={0.8}
        style={[
          styles.button,
          isPrimary && !isDanger && styles.primary,
          isDanger && styles.danger,
          !isPrimary && !isDanger && !isCancel && styles.secondary,
          isCancel && styles.cancel,
        ]}
      >
        <Text style={[
          styles.buttonText,
          (isPrimary || isDanger) && styles.buttonTextOnColor,
          isCancel && styles.cancelText,
        ]}>{b.text}</Text>
      </TouchableOpacity>
    );
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={dismiss}>
      <View style={styles.backdrop}>
        <View
          style={styles.card}
          onTouchStart={bumpActivity}
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
        >
          <ScrollView style={styles.scroll} contentContainerStyle={{ paddingBottom: Spacing.xs }}>
            {current.title ? <Text style={styles.title}>{current.title}</Text> : null}
            {current.message ? <Text style={styles.message}>{current.message}</Text> : null}
            <View style={styles.buttons}>{actions.map(renderButton)}</View>
          </ScrollView>
          {cancels.length > 0 && (
            <View style={[styles.buttons, styles.cancelRow]}>{cancels.map(renderButton)}</View>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  shield: { flex: 1, backgroundColor: 'transparent' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', alignItems: 'center', padding: Spacing.md },
  card: { width: '100%', maxWidth: 440, maxHeight: '90%', backgroundColor: Colors.surface, borderRadius: BorderRadius.lg, padding: Spacing.lg },
  scroll: { flexGrow: 0, flexShrink: 1 },
  cancelRow: { marginTop: Spacing.sm },
  title: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, marginBottom: Spacing.sm },
  message: { fontSize: FontSize.md, color: Colors.text, lineHeight: 24 },
  buttons: { marginTop: Spacing.md, gap: Spacing.sm },
  button: { minHeight: 52, borderRadius: BorderRadius.md, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.md },
  primary: { backgroundColor: Colors.primary },
  danger: { backgroundColor: Colors.error },
  secondary: { backgroundColor: Colors.surface, borderWidth: 2, borderColor: Colors.primary },
  cancel: { backgroundColor: 'transparent' },
  buttonText: { fontSize: FontSize.md, fontWeight: '700', color: Colors.primary },
  buttonTextOnColor: { color: Colors.white },
  cancelText: { color: Colors.textSecondary, fontWeight: '600' },
});
