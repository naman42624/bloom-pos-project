import { Alert, Platform } from 'react-native';

/**
 * Pop-ups for the whole app (rewritten 2026-11-06, A5/D36).
 *
 * react-native-web's Alert.alert is a no-op, so every Alert.alert was silent
 * in a browser, which is where the shop runs the app. The first fix used
 * window.alert / window.confirm: visible, but they freeze the page and can
 * only say OK (or OK / Cancel), so any pop-up with a real choice did nothing.
 *
 * Now, on web, every pop-up is the app's own dialog (components/DialogHost.js,
 * mounted in App.js) with all of its buttons. Native keeps the system Alert.
 *
 *   appAlert(title, message, buttons?, options?)   same arguments as Alert.alert
 *   showAlert(title, message, buttons?)             the same, kept for callers
 *   showConfirm(title, message, onConfirm, { confirmLabel, cancelLabel, destructive })
 *
 * Like the system Alert, these return at once; a button's onPress runs when
 * it is tapped. Code that has to wait for the answer goes in onPress.
 */

let listener = null;
const pending = [];

// DialogHost registers here. Pop-ups raised before it mounts are kept and
// shown as soon as it does.
export function subscribeDialogs(fn) {
  listener = fn;
  while (pending.length) fn(pending.shift());
  return () => { if (listener === fn) listener = null; };
}

function normalizeButtons(buttons) {
  const list = Array.isArray(buttons) ? buttons.filter(Boolean) : [];
  if (list.length === 0) return [{ text: 'OK' }];
  return list.map((b) => ({ ...b, text: b.text || 'OK' }));
}

export function appAlert(title, message, buttons, options) {
  if (Platform.OS !== 'web') {
    Alert.alert(title, message, buttons, options);
    return;
  }
  const dialog = { title: title || '', message: message || '', buttons: normalizeButtons(buttons) };
  if (listener) listener(dialog);
  else if (typeof window !== 'undefined' && typeof document !== 'undefined') pending.push(dialog);
}

export function showAlert(title, message, buttons) {
  appAlert(title, message, buttons);
}

export function showConfirm(title, message, onConfirm, options) {
  const confirmLabel = (options && options.confirmLabel) || 'OK';
  const cancelLabel = (options && options.cancelLabel) || 'Cancel';
  const destructive = !!(options && options.destructive);
  appAlert(title, message, [
    { text: cancelLabel, style: 'cancel', onPress: options && options.onCancel },
    { text: confirmLabel, style: destructive ? 'destructive' : 'default', onPress: onConfirm },
  ]);
}
