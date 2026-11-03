// Same-code cooldown for the product scanner. Pure: no React, no DOM, no native
// modules, so both ProductScanner.js (web) and ProductScanner.native.js share it
// and plain node can test it (app/scripts/test-scanner-decode.js).
//
// The window SLIDES: every sighting of the same code restarts the 1.5 s timer.
// A camera sees a label held in front of it 5-10 times a second, so a fixed
// window measured from the last accept would re-accept the same label every
// 1.5 s while it is held still (4 accepts in 5 s). Sliding means a label held
// in view for any length of time is accepted once; it is accepted again only
// after it has been out of view for 1.5 s. A different code is accepted at once.

export const SCAN_COOLDOWN_MS = 1500;

export function createScanCooldown(ms = SCAN_COOLDOWN_MS, now = () => Date.now()) {
  let lastCode = null;
  let lastSeenAt = -Infinity;
  return {
    // Returns true when this sighting should be reported to the parent.
    accept(code) {
      if (typeof code !== 'string' || code.length === 0) return false;
      const t = now();
      const repeat = code === lastCode && t - lastSeenAt < ms;
      lastCode = code;
      lastSeenAt = t;
      return !repeat;
    },
    // Restart the window for the last code without accepting anything. Called
    // when the camera resumes after a pause, so the label that was just looked
    // up (and is probably still in view) is not reported again in a loop.
    hold() {
      if (lastCode !== null) lastSeenAt = now();
    },
    reset() {
      lastCode = null;
      lastSeenAt = -Infinity;
    },
  };
}

// Plain-language copy shared by both scanner files. The blocked text is exact
// (plan Global Constraints / spec 13) - do not reword it.
export const SCANNER_COPY = {
  blocked: 'Camera is blocked. Tap the \u{1F512} next to the web address → Camera → Allow, then tap Try again.',
  blockedNative: 'Camera is blocked. Allow the camera for this app in your phone Settings, then tap Try again.',
  noCamera: 'No camera found on this device. Go back and search for the item by name.',
  busy: 'The camera is being used by another app or tab. Close it, then tap Try again.',
  unsupported: 'This browser cannot open the camera here. Go back and search for the item by name.',
  failed: 'The camera did not start. Tap Try again.',
  starting: 'Starting the camera…',
  hint: 'Point the camera at the QR code on the label',
};

// Maps a getUserMedia error to a SCANNER_COPY key.
export function cameraErrorKind(err) {
  const name = (err && err.name) || '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') return 'blocked';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') return 'noCamera';
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return 'busy';
  return 'failed';
}
