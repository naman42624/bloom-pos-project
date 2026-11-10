// Pure helpers for the counter's helper cash screens (bag mode, spec §11-§12).
// No React, no network: tested by scripts/test-helper-cash.js.

export const REVEAL_MS = 15000;
export const DEFAULT_FLOAT = 500;

export const rupees = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

// Typed money -> number rounded to paise, or null when it is not an amount
// the server takes (at most 8 whole digits, at most 2 decimals, not negative).
export function parseMoney(text) {
  const s = String(text == null ? '' : text).trim();
  if (!/^\d{1,8}(\.\d{0,2})?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

// Only digits and one dot, at most 2 decimals, while typing.
export function cleanMoneyInput(text) {
  let s = String(text || '').replace(/[^0-9.]/g, '');
  const dot = s.indexOf('.');
  if (dot >= 0) s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, '').slice(0, 2);
  return s;
}

// Step 2 of Receive cash: the figures after the count.
// difference = counted - expected (short is negative).
export function handoverResult(expected, counted) {
  const e = Math.round(Number(expected || 0) * 100);
  const c = Math.round(Number(counted || 0) * 100);
  const d = c - e;
  let kind = 'exact';
  let label = 'Exactly right';
  if (d < 0) { kind = 'short'; label = `Short ${rupees(-d / 100)}`; }
  if (d > 0) { kind = 'over'; label = `Over ${rupees(d / 100)}`; }
  return {
    kind,
    label,
    line: `Expected ${rupees(e / 100)} · Counted ${rupees(c / 100)} · ${label}`,
    canPartial: c > 0 && c < e, // A3: an exact count has nothing left to keep for later
    remainingIfPartial: Math.max(0, e - c) / 100,
  };
}

// Float amount to start with: the last float given to this helper, else 500.
export function floatDefault(lastFloat) {
  const n = lastFloat && typeof lastFloat === 'object' ? Number(lastFloat.amount) : Number(lastFloat);
  return Number.isFinite(n) && n > 0 ? String(Math.round(n * 100) / 100) : String(DEFAULT_FLOAT);
}

// Close warning text (plan Global Constraints, exact copy):
//   "₹<masked> is still with <name>. Collect it first?"
export function closeWarningLines(bags) {
  return (bags || [])
    .filter((b) => b && b.has_cash)
    .map((b) => ({ staff_id: b.staff_id, name: b.name, text: `${b.held_masked} is still with ${b.name}. Collect it first?` }));
}

// After a committed handover: what the counter sees (server figures).
export function handoverDoneText(r) {
  if (!r) return '';
  const name = r.name || 'the helper';
  const took = `Took ${rupees(r.counted)} from ${name}.`;
  if (!r.is_final) {
    const rest = Number(r.remaining) || 0;
    return rest > 0 ? `${took} ${rupees(rest)} stays with ${name}.` : took;
  }
  const d = Math.round((Number(r.difference) || 0) * 100) / 100;
  if (d < 0) return `${took} Expected ${rupees(r.expected)} · Short ${rupees(-d)}, recorded against ${name}.`;
  if (d > 0) return `${took} Expected ${rupees(r.expected)} · Over ${rupees(d)}, recorded.`;
  return `${took} Exactly right. ${name}'s cash is settled.`;
}
