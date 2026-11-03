// Browser QR scanner (Expo web build). Native builds use ProductScanner.native.js.
//
// <ProductScanner onCode={(raw) => void} paused={bool} />
//   - continuous rear camera; reports each decoded QR string through onCode
//   - same-code cooldown (scanCooldown.js), beep + vibrate on every accept
//   - never calls the API; the parent decides what a code means
//   - paused stops every camera track (the light on the phone goes off)
//
// Decoder (spike ruling, docs/superpowers/logs/2026-11-02-scanner-spike.md):
// the browser's own BarcodeDetector when it supports qr_code (Chrome/Edge on
// Android and macOS), otherwise jsQR on canvas frames (iPhone Safari, Firefox).
import React, { useEffect, useRef, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import jsQR from 'jsqr';
import { createScanCooldown, cameraErrorKind, SCANNER_COPY } from './scanCooldown';
import { playAcceptFeedback, unlockAudio } from './scanFeedback';
import ScannerMessage from './ScannerMessage';
import ScannerFrame from './ScannerFrame';
import { Colors } from '../../constants/theme';

const DECODE_INTERVAL_MS = 150;
const MAX_DECODE_WIDTH = 800;
const DETECTOR_ERRORS_BEFORE_FALLBACK = 3;

async function makeNativeDetector() {
  try {
    if (typeof window === 'undefined' || !('BarcodeDetector' in window)) return null;
    const BD = window.BarcodeDetector;
    if (typeof BD.getSupportedFormats === 'function') {
      const formats = await BD.getSupportedFormats();
      if (!Array.isArray(formats) || !formats.includes('qr_code')) return null;
    }
    return new BD({ formats: ['qr_code'] });
  } catch (e) {
    return null;
  }
}

function stopStream(stream) {
  if (!stream) return;
  try { stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* already stopped */ }
}

const ICONS = {
  blocked: 'lock-closed-outline',
  noCamera: 'videocam-off-outline',
  busy: 'videocam-off-outline',
  unsupported: 'videocam-off-outline',
  failed: 'alert-circle-outline',
};

export default function ProductScanner({ onCode, paused = false, children, style }) {
  const videoRef = useRef(null);
  const trackRef = useRef(null);
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;
  const cooldownRef = useRef(null);
  if (!cooldownRef.current) cooldownRef.current = createScanCooldown();

  const [status, setStatus] = useState('starting'); // starting | running | blocked | noCamera | busy | unsupported | failed
  const [attempt, setAttempt] = useState(0);
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const mountedRef = useRef(true);

  // One-time audio unlock on the first tap anywhere (iPhone Safari needs a
  // user gesture before the accept beep can play).
  useEffect(() => {
    mountedRef.current = true;
    if (typeof window === 'undefined') return () => { mountedRef.current = false; };
    const onGesture = () => {
      unlockAudio();
      window.removeEventListener('pointerdown', onGesture, true);
      window.removeEventListener('touchend', onGesture, true);
    };
    window.addEventListener('pointerdown', onGesture, true);
    window.addEventListener('touchend', onGesture, true);
    return () => {
      mountedRef.current = false;
      window.removeEventListener('pointerdown', onGesture, true);
      window.removeEventListener('touchend', onGesture, true);
    };
  }, []);

  useEffect(() => {
    if (paused) return undefined;

    let cancelled = false;
    let stream = null;
    let rafId = null;
    let lastTick = 0;
    let decoding = false;
    let detector = null;
    let detectorErrors = 0;
    let canvas = null;
    let ctx = null;

    setStatus('starting');
    setTorchAvailable(false);
    setTorchOn(false);

    async function decodeFrame(video) {
      if (detector) {
        try {
          const found = await detector.detect(video);
          detectorErrors = 0;
          return found && found[0] && found[0].rawValue ? found[0].rawValue : null;
        } catch (e) {
          detectorErrors += 1;
          if (detectorErrors >= DETECTOR_ERRORS_BEFORE_FALLBACK) detector = null; // fall back to jsQR
          return null;
        }
      }
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return null;
      const scale = Math.min(1, MAX_DECODE_WIDTH / vw);
      const w = Math.round(vw * scale);
      const h = Math.round(vh * scale);
      if (!canvas) {
        canvas = document.createElement('canvas');
        ctx = canvas.getContext('2d', { willReadFrequently: true });
      }
      if (!ctx) return null;
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      ctx.drawImage(video, 0, 0, w, h);
      const img = ctx.getImageData(0, 0, w, h);
      const found = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
      return found && found.data ? found.data : null;
    }

    function tick(ts) {
      if (cancelled) return;
      rafId = requestAnimationFrame(tick);
      if (decoding || ts - lastTick < DECODE_INTERVAL_MS) return;
      const video = videoRef.current;
      if (!video || video.readyState < 2) return; // HAVE_CURRENT_DATA
      lastTick = ts;
      decoding = true;
      decodeFrame(video)
        .then((raw) => {
          if (cancelled || !raw) return;
          if (cooldownRef.current.accept(raw)) {
            playAcceptFeedback();
            if (onCodeRef.current) onCodeRef.current(raw);
          }
        })
        .catch(() => { /* a bad frame is skipped */ })
        .finally(() => { decoding = false; });
    }

    (async () => {
      const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : null;
      if (!md || typeof md.getUserMedia !== 'function') {
        // Also what a phone sees on plain http:// (camera needs https).
        setStatus('unsupported');
        return;
      }
      try {
        stream = await md.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        });
      } catch (err) {
        if (!cancelled) setStatus(cameraErrorKind(err));
        return;
      }
      if (cancelled) { stopStream(stream); return; }

      const video = videoRef.current;
      if (!video) { stopStream(stream); setStatus('failed'); return; }
      video.muted = true;
      video.setAttribute('playsinline', 'true'); // iPhone Safari: no full-screen takeover
      video.srcObject = stream;
      try { await video.play(); } catch (e) { /* muted autoplay normally allowed; frames still arrive */ }

      detector = await makeNativeDetector();
      if (cancelled) return;

      const track = stream.getVideoTracks()[0] || null;
      trackRef.current = track;
      try {
        const caps = track && typeof track.getCapabilities === 'function' ? track.getCapabilities() : null;
        setTorchAvailable(!!(caps && caps.torch));
      } catch (e) {
        setTorchAvailable(false);
      }
      cooldownRef.current.hold();
      setStatus('running');
      rafId = requestAnimationFrame(tick);
    })();

    return () => {
      cancelled = true;
      if (rafId) cancelAnimationFrame(rafId);
      stopStream(stream);
      trackRef.current = null;
      const video = videoRef.current;
      if (video) {
        try { video.pause(); } catch (e) { /* ignore */ }
        video.srcObject = null;
      }
    };
  }, [paused, attempt]);

  const toggleTorch = async () => {
    const track = trackRef.current;
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next }] });
      if (mountedRef.current) setTorchOn(next);
    } catch (e) {
      if (mountedRef.current) setTorchAvailable(false);
    }
  };

  const retry = () => {
    unlockAudio();
    setStatus('starting');
    setAttempt((n) => n + 1);
  };
  const failed = status !== 'starting' && status !== 'running';

  return (
    <View style={[styles.container, style]}>
      {!failed && !paused ? (
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          style={{
            position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
            objectFit: 'cover', backgroundColor: Colors.black,
          }}
        />
      ) : null}

      {status === 'running' && !paused ? (
        <ScannerFrame showTorch={torchAvailable} torchOn={torchOn} onToggleTorch={toggleTorch} />
      ) : null}

      {status === 'starting' && !paused ? <ScannerMessage loading text={SCANNER_COPY.starting} /> : null}

      {failed && !paused ? (
        <ScannerMessage
          icon={ICONS[status] || ICONS.failed}
          text={SCANNER_COPY[status] || SCANNER_COPY.failed}
          onRetry={status === 'unsupported' ? undefined : retry}
        />
      ) : null}

      {status === 'running' || paused ? children : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.black, overflow: 'hidden' },
});
