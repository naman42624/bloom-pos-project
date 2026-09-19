import { useCallback, useRef } from 'react';

/**
 * Wraps an async submit/save handler so a fast double-tap can't run it
 * twice — the root cause of "Create Order"/"Place Order" creating duplicate
 * sales, found live 2026-09-10 in LogOrderScreen and QuickCheckoutScreen.
 *
 * A `useState` flag (`if (saving) return; setSaving(true); ...`) looks like
 * a re-entrancy guard but isn't a synchronous one: setState doesn't take
 * effect until React re-renders, so a second tap landing before that
 * re-render commits still runs against the same stale closure and reads
 * the old (false) value — both taps pass the check. Both screens above had
 * an even wider version of the same gap: their register-status check ran
 * on an awaited network call *before* the saving flag was ever set, so a
 * second tap during that round-trip sailed through even without any race
 * timing luck.
 *
 * A ref is mutated synchronously and shared across renders/closures, so
 * checking-and-setting it as the very first thing that happens — before
 * the wrapped handler's body runs at all, including any pre-flight
 * `await` inside it — closes both gaps. This only wraps the entry point;
 * it doesn't touch a screen's own `saving`/`submitting` state, which stays
 * exactly as-is for spinner/disabled UI.
 *
 * Usage: const guardSubmit = useSubmitGuard();
 *        <TouchableOpacity onPress={guardSubmit(handleSave)}>
 *
 * A second tap while one call is in flight is a silent no-op — the button
 * already shows a spinner/disabled state from the screen's own logic, so
 * nothing further needs saying (per staff-ux-checklist: don't add friction
 * a first-time user has to interpret when the UI already shows "working").
 */
export default function useSubmitGuard() {
  const inFlight = useRef(false);

  return useCallback((handler) => async (...args) => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      return await handler(...args);
    } finally {
      inFlight.current = false;
    }
  }, []);
}
