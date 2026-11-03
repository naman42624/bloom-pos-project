# Scanner spike — 2026-11-02 (written 2026-11-03)

Task 5 of `docs/superpowers/plans/2026-11-02-labels-price-page-scanner.md`. The spike's choice was made by the controller (ruling 4), not by testing on phones. This log records the decision, the facts behind it, and what is still untested.

## Decision

- **Web (the shop's main build):** `app/src/components/scan/ProductScanner.js`.
  - Uses the browser's own `BarcodeDetector({ formats: ['qr_code'] })` when `'BarcodeDetector' in window` and `getSupportedFormats()` lists `qr_code`.
  - Otherwise it decodes canvas frames from the `getUserMedia` video with **jsQR 1.4.0**, pinned exactly in `app/package.json`. The frame is scaled to at most 800 px wide, and `inversionAttempts: 'dontInvert'` keeps it fast.
  - If `BarcodeDetector.detect()` fails 3 frames in a row, the scanner switches to jsQR for the rest of that camera session.
  - Decoding runs on `requestAnimationFrame` but at most once every 150 ms, and never two frames at the same time.
  - It asks for the rear camera (`facingMode: { ideal: 'environment' }`, 1280×720 ideal).
  - Every track is stopped on unmount and whenever `paused` is true, so the phone's camera light goes off.
  - The torch button appears only when `track.getCapabilities?.().torch` is true. It uses `applyConstraints({ advanced: [{ torch }] })`.
- **Native app:** `ProductScanner.native.js` wraps expo-camera's `CameraView` (`barcodeScannerSettings={{ barcodeTypes: ['qr'] }}`, `useCameraPermissions`). It has the same props. `paused` unmounts the camera.
- **Shared:** `scanCooldown.js` (pure) holds the 1.5 s same-code cooldown and all the camera copy. `scanFeedback.js` (web) plays a short beep (Web Audio, 1200 Hz, ~120 ms) and calls `navigator.vibrate(60)`. `scanFeedback.native.js` vibrates for 60 ms.
- **expo-camera on web was not chosen.** `QRScannerScreen` used to show "not available on web", and the plan only needs a QR decoder, so the browser API plus jsQR is the smaller, better-known path.

## Cooldown behaviour (a deliberate reading of "1.5 s same-code cooldown")

The window **slides**: each sighting of the same code restarts the 1.5 s timer. With a fixed window counted from the last accept, a label held still for 5 s would be accepted 4 times (at 0, 1.5, 3 and 4.5 s). The plan's Step 3 check says one accept for that case, which only the sliding window gives.

- A different code is accepted immediately.
- The same label is accepted again only after it has been out of view for 1.5 s.
- When the camera resumes after a pause (the parent pauses while it looks a code up), `hold()` restarts the window. This stops a label that is still in view after a "not one of our codes" answer from looping and beeping every couple of seconds. The person moves the label away and back to try again.

## Browser support facts

| Browser | `BarcodeDetector` with `qr_code` | Path used |
|---|---|---|
| Chrome / Edge on Android | Yes | BarcodeDetector |
| Chrome / Edge on macOS | Yes | BarcodeDetector |
| Chrome on Windows / Linux | Usually no (the API exists on some builds but lists no formats) | jsQR |
| Safari on iPhone / iPad (every iOS browser is WebKit) | No | jsQR |
| Firefox (desktop and Android) | No | jsQR |

- **The camera needs a secure origin.** On plain `http://` (except `localhost`), `navigator.mediaDevices` is undefined. The scanner then shows "This browser cannot open the camera here. Go back and search for the item by name." That is why the phone test needs an HTTPS tunnel.
- iPhone Safari has no `navigator.vibrate`. There the accept is signalled by the beep only. Safari keeps an AudioContext suspended until it is resumed inside a tap, so the scanner unlocks audio on the first `pointerdown`/`touchend` anywhere on the page, and again on Try again (`unlockAudio()` in `scanFeedback.js`).
- Torch support through `getCapabilities().torch` is Chrome-on-Android only in practice. Safari and desktop webcams do not report it, so they show no torch button.

## Camera states and copy

| State | Copy | Button |
|---|---|---|
| Permission denied (`NotAllowedError` / `SecurityError`) | `Camera is blocked. Tap the 🔒 next to the web address → Camera → Allow, then tap Try again.` (exact, spec §13) | Try again (re-requests the camera) |
| No camera (`NotFoundError` / `OverconstrainedError`) | `No camera found on this device. Go back and search for the item by name.` | Try again |
| Camera in use (`NotReadableError`) | `The camera is being used by another app or tab. Close it, then tap Try again.` | Try again |
| Any other start failure | `The camera did not start. Tap Try again.` | Try again |
| No `getUserMedia` / not https | `This browser cannot open the camera here. Go back and search for the item by name.` | none |
| Native: permission refused | `Camera is blocked. Allow the camera for this app in your phone Settings, then tap Try again.` | Try again (re-asks; opens phone Settings when the system will not ask again) |

## Evidence produced here

`app/scripts/test-scanner-decode.js` — 11/11 pass.

- It builds the QR for `http://localhost:19006/p/ABCDEFGH` with the server's `qrcode` package, paints the module matrix into RGBA, and checks that jsQR decodes it exactly.
- It does the same for a legacy `{"type":"bloomcart_product","id":42,...}` payload.
- It checks that a blank frame decodes to nothing.
- It checks the jsqr pin.
- It tests the cooldown: the same code inside 1.5 s is rejected, a different code is accepted, the same code after 1.5 s is accepted, a 5 s hold gives 1 accept, `hold()` works after a pause, and empty codes are ignored.
- It checks the error mapping and the exact blocked copy.

Every touched file passes a `babel-preset-expo` transform.

## Not yet tested on a phone

**Needs the user with Android Chrome and iPhone Safari, over a temporary HTTPS tunnel to the dev web server and API, and a printed label from Task 1.** Close the tunnel afterwards and use throwaway accounts only, because the tunnel reaches the dev database.

Nothing in this log has been run against a real camera, on desktop or on a phone. Still to check:

1. Android Chrome (BarcodeDetector path): scan a new URL label and a legacy JSON label, and check each beeps and buzzes once.
2. iPhone Safari (jsQR path): scan the same two labels. There is no buzz on iPhone; check the beep is heard after the first tap on the page.
3. Hold one label in view for 5 s and check it is accepted once.
4. Deny the camera, check the exact blocked copy appears, allow it from the 🔒 menu, then tap Try again and check the camera starts.
5. Android Chrome: check the Light button appears and switches the torch.
6. Small stickers (A4 3 × 8) at a normal hand distance: if jsQR misses them on iPhone, raise `MAX_DECODE_WIDTH` in `ProductScanner.js`.
7. iPhone audio: open the scanner, tap the screen once, scan a label and check the beep is heard. Also check whether a scan with no tap at all is silent, which is expected; the team needs to know staff must touch the screen once.
8. Native app build (expo-camera path): not tested at all in this pass.
