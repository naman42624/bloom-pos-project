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
 *
 * `buttons` is handed straight to Alert on native. On web a window.alert has
 * only ONE outcome — the person dismisses it — so a handler is auto-fired only
 * when there is exactly one button and therefore nothing to guess about.
 *
 * A two-button alert is a QUESTION, and this helper cannot answer it: on web
 * nobody was ever offered the choice. Do not pass one here. Guessing is not
 * safe in either direction — the handler sits on the Cancel button about as
 * often as on the action, so guessing runs something nobody agreed to, and not
 * guessing silently drops the action. Use showConfirm for anything with a
 * choice, and leave three-or-more-button dialogs and text prompts on
 * Alert.alert until there is a real in-app dialog component.
 */
export function showAlert(title, message, buttons) {
  if (Platform.OS !== 'web') {
    Alert.alert(title, message, buttons);
    return;
  }
  const text = [title, message].filter(Boolean).join('\n\n');
  window.alert(text);

  // Exactly one button is the only unambiguous shape: it is also the only
  // outcome a one-button native Alert could have produced, so firing it keeps
  // web and native identical. Callers that refresh or navigate after an alert
  // still do so. Anything else runs nothing, and says why.
  const list = Array.isArray(buttons) ? buttons.filter(Boolean) : [];
  if (list.length === 1) {
    const only = list[0];
    if (only.style !== 'cancel' && typeof only.onPress === 'function') only.onPress();
    return;
  }
  if (list.length > 1) {
    console.warn(
      '[showAlert] ' + list.length + ' buttons were passed, so no handler ran on web. '
      + 'A choice belongs in showConfirm(title, message, onConfirm, options).'
    );
  }
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
