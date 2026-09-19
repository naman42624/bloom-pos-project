// Pure register-session matching logic, split out from
// app/src/hooks/useRegisterSessions.js (which re-exports matchSessionLabel
// from here) specifically so it has zero React/react-native/api
// dependencies and can be required directly by a plain Node script
// (app/scripts/verify-register-sessions.js) — this codebase has no
// component/hook-testing framework, and the hook file itself can't be
// required under plain Node (it imports ../services/api, which imports
// react-native and reads the RN-only __DEV__ global at module scope).
// Written in CommonJS (module.exports), matching app/src/utils/contact.js's
// established convention for this exact situation — Babel's commonjs
// interop lets the hook file still `import { matchSessionLabel } from
// './registerSessions'` normally.

// Wraps datetime.js's shared formatTime, which forces display in shop time
// (Asia/Kolkata) regardless of device timezone — every other time display
// in this app deliberately does this (see CLAUDE.md), and this file's own
// local formatTime previously didn't, so session labels would show
// device-local time next to order rows showing shop time. The options
// override below reproduces the "9:02am" styling (no leading zero, no
// space, lowercase am/pm) matchSessionLabel's session labels need, while
// still going through parseServerDate + the forced shop timeZone.
const { formatTime: sharedFormatTime } = require('./datetime');

function formatTime(isoString) {
  return sharedFormatTime(isoString, 'en-IN', { hour: 'numeric', minute: '2-digit', hour12: true })
    .replace(' ', '')
    .toLowerCase();
}

// Given the sessions already fetched for a (location, date) pair, find
// which one a specific order timestamp falls into.
//
// Boundary convention (deliberate, see verify-register-sessions.js): each
// session's window is treated as half-open [start, end) — a timestamp
// exactly at a session's opening instant belongs to that session (the sale
// happened at/after open), but a timestamp exactly at closed_at does NOT
// (the register was already shut at that instant; it belongs to whatever
// opens next, or to no session at all if nothing has reopened yet that
// day). This mirrors the register-guard invariant that a sale can only ever
// be created while a register is open, so a real order's created_at should
// never legitimately land exactly on a closed_at boundary in practice.
//
// This also depends on two invariants the backend/register-guard already
// hold, not re-checked here: (1) GET /sales/register/sessions returns rows
// `ORDER BY cr.id ASC`, i.e. chronological creation order, so `idx + 1`
// below is a correct "Session 1", "Session 2", ... chronological numbering;
// (2) POST /sales/register/open refuses to open a second register while one
// is already open for that location (409), so sessions for one
// location+date never overlap and at most the last one in the array can be
// still-open (no closed_at) — findIndex never has to arbitrate between two
// candidate sessions.
function matchSessionLabel(sessions, timestampStr) {
  if (!sessions || sessions.length === 0 || !timestampStr) return null;
  const t = new Date(timestampStr).getTime();
  const idx = sessions.findIndex((s) => {
    const start = new Date(s.opening_time || s.opened_at).getTime();
    const end = s.closed_at ? new Date(s.closed_at).getTime() : Infinity;
    return t >= start && t < end;
  });
  if (idx === -1) return null;
  const s = sessions[idx];
  const label = sessions.length > 1 ? `Session ${idx + 1}` : 'Session';
  const startLabel = formatTime(s.opening_time || s.opened_at);
  const endLabel = s.closed_at ? formatTime(s.closed_at) : 'now';
  return `${label} (${startLabel}–${endLabel})`;
}

module.exports = { matchSessionLabel, formatTime };
