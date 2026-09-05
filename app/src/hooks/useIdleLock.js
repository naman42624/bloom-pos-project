import { useEffect } from 'react';
import { AppState } from 'react-native';

// 3 minutes was tight enough to fire mid-order (typing a delivery address
// or item notes doesn't re-trigger a touch on the outer view the way a tap
// does, so a slow typist could go quiet for the whole window without ever
// looking "idle" to a human). 5 minutes gives more real breathing room
// while the mount-preservation fix in RootNavigator.js means even a false
// trigger now costs a PIN re-entry, not the order itself (2026-09-01).
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// Module-level (not per-hook-instance) so any screen can report activity
// without needing the hook's own `bump` return value threaded through
// props/context — this is what lets touches INSIDE a React Native `Modal`
// count as activity. RN `Modal`s mount into their own native root view, so
// a touch handler on the main tree (e.g. RootNavigator's wrapping View)
// never sees touches that happen inside one — a modal-heavy screen like
// QuickCheckoutScreen (draft/product/material picker modals) could sit idle
// for the full timeout while someone is actively picking items, and get
// locked out from under them. Importing `bumpActivity` directly into any
// screen with its own Modal and calling it via that Modal's own
// `onTouchStart` closes that gap without threading bump through context.
let lastActivity = Date.now();

export function bumpActivity() {
  lastActivity = Date.now();
}

/**
 * Locks the app after a period of inactivity. Call `bump()` (or the
 * standalone `bumpActivity` export, from inside a Modal) on any
 * user-initiated navigation/touch to reset the timer. Does NOT lock
 * on brief backgrounding (e.g. answering a call) — only on sustained
 * foreground idle time or returning from the background after the
 * timeout has already elapsed.
 */
export default function useIdleLock(enabled, onIdle) {
  useEffect(() => {
    if (!enabled) return;

    const interval = setInterval(() => {
      if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
        onIdle();
      }
    }, 15000);

    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active' && Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
        onIdle();
      } else if (nextState === 'active') {
        bumpActivity();
      }
    });

    return () => {
      clearInterval(interval);
      sub.remove();
    };
  }, [enabled]);

  return { bump: bumpActivity };
}
