// Web feedback for an accepted scan: a short beep (Web Audio) + a 60 ms buzz.
// Both are best-effort - iPhone Safari has no navigator.vibrate, and some
// browsers keep audio muted until the page has been tapped once.

let audioCtx = null;

function getAudioContext() {
  if (audioCtx) return audioCtx;
  const Ctx = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  if (!Ctx) return null;
  try { audioCtx = new Ctx(); } catch (e) { audioCtx = null; }
  return audioCtx;
}

// iPhone Safari keeps an AudioContext suspended until it is resumed inside a
// user gesture, and iPhone has no navigator.vibrate - without this, iPhone
// scans give no feedback at all. Call from a tap (pointerdown/touchend, the
// Try again button). Safe to call any number of times.
export function unlockAudio() {
  try {
    const ctx = getAudioContext();
    if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
  } catch (e) { /* audio not available */ }
}

export function playAcceptFeedback() {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate(60);
  } catch (e) { /* not supported */ }
  try {
    if (!getAudioContext()) return;
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 1200;
    const t = audioCtx.currentTime;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.13);
  } catch (e) { /* audio not available */ }
}
