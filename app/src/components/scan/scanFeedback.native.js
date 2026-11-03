// Native feedback for an accepted scan: a 60 ms vibration. There is no bundled
// beep sound asset in the app, so native buzzes only (see the scanner spike log).
import { Vibration } from 'react-native';

export function playAcceptFeedback() {
  try { Vibration.vibrate(60); } catch (e) { /* not supported */ }
}
