import { Alert, Platform } from 'react-native';

/**
 * Cross-platform replacement for Alert.alert.
 *
 * react-native-web ships `class Alert { static alert() {} }` — a literal no-op.
 * Every Alert.alert in this app is therefore silent in a browser, which is where
 * the shop actually runs it. Staff tapping a blocked action saw nothing at all:
 * no error, no reason, no next step. See
 * docs/superpowers/specs/2026-09-01-dashboard-stage-ui-redesign-design.md §6.
 *
 * Native keeps the real Alert. Web falls back to the browser's own dialogs,
 * which are ugly but visible — and visible beats elegant for a message telling
 * someone why the till would not accept something.
 */
export function showAlert(title, message, buttons) {
  if (Platform.OS !== 'web') {
    Alert.alert(title, message, buttons);
    return;
  }
  const text = [title, message].filter(Boolean).join('\n\n');
  window.alert(text);
  // Honour a single acknowledge-style handler so callers that refresh or
  // navigate after an alert still do so on web.
  const ack = (buttons || []).find((b) => b && b.style !== 'cancel' && typeof b.onPress === 'function');
  if (ack) ack.onPress();
}

/**
 * Destructive/confirming variant. Native uses a two-button Alert; web uses
 * window.confirm. `onConfirm` runs only on a positive answer.
 */
export function showConfirm(title, message, onConfirm, options) {
  const confirmLabel = (options && options.confirmLabel) || 'OK';
  const cancelLabel = (options && options.cancelLabel) || 'Cancel';
  const destructive = !!(options && options.destructive);

  if (Platform.OS !== 'web') {
    Alert.alert(title, message, [
      { text: cancelLabel, style: 'cancel' },
      { text: confirmLabel, style: destructive ? 'destructive' : 'default', onPress: onConfirm },
    ]);
    return;
  }
  if (window.confirm([title, message].filter(Boolean).join('\n\n'))) onConfirm();
}
