const assert = require('assert');
// matchSessionLabel lives in src/utils/registerSessions.js (a pure,
// dependency-free CommonJS module) rather than being required directly out
// of src/hooks/useRegisterSessions.js — that hook file imports
// ../services/api, which imports react-native and reads the RN-only
// __DEV__ global at module scope, so it cannot be loaded under plain Node.
// useRegisterSessions.js re-exports matchSessionLabel from this same
// module, so this test exercises the exact function real consumers get.
const { matchSessionLabel } = require('../src/utils/registerSessions');

// Build a UTC-instant ISO string representing `h:m` in the SHOP's own
// timezone (Asia/Kolkata, UTC+5:30, no DST) on 2026-09-04 — deliberately
// NOT device-local wall-clock components (`new Date(2026,8,4,h,m,0)`).
// This function used to build from local components on the theory that
// "construction and formatting both happen in local time, so they always
// round-trip together" — true only while formatTime displayed in
// *device*-local time. Finding 6 (final whole-branch review,
// 2026-09-09) fixed formatTime to force Asia/Kolkata display regardless of
// device timezone (matching every other time display in this app, see
// CLAUDE.md) — which means the OLD local-component construction no longer
// round-trips: it silently produced different (wrong) expected labels
// depending on the machine's own timezone (confirmed live: this test
// failed under TZ=America/New_York with the local-component version,
// producing "6:32pm" instead of "9:02am" for the same nominal h:m).
// Building the instant directly from the known, fixed UTC offset makes
// this test's assertions genuinely timezone-independent, which is what
// the original comment intended but the local-component implementation
// didn't actually achieve once formatTime became timezone-forcing.
const SHOP_UTC_OFFSET_MINUTES = 5 * 60 + 30; // Asia/Kolkata is UTC+5:30, no DST
function t(h, m) {
  const utcMinutesFromMidnight = h * 60 + m - SHOP_UTC_OFFSET_MINUTES;
  return new Date(Date.UTC(2026, 8, 4, 0, utcMinutesFromMidnight, 0)).toISOString();
}

const sessionA = { id: 1, opening_time: t(9, 2), closed_at: t(13, 15) }; // closed session
const sessionB = { id: 2, opening_time: t(14, 0), closed_at: null }; // still-open session ("now")
const sessions = [sessionA, sessionB];

// 1. Timestamp inside a closed session
assert.strictEqual(
  matchSessionLabel(sessions, t(11, 0)),
  'Session 1 (9:02am–1:15pm)',
  'Expected a timestamp inside the closed first session to match it, labeled with its close time'
);

// 2. Timestamp inside a still-open session -> open-ended, labeled "now"
assert.strictEqual(
  matchSessionLabel(sessions, t(15, 30)),
  'Session 2 (2:00pm–now)',
  'Expected a timestamp inside the still-open session to match it, labeled open-ended with "now"'
);

// 3. Timestamp with no matching session at all -> null, never throws
assert.strictEqual(
  matchSessionLabel(sessions, t(7, 0)),
  null,
  'Expected a timestamp before any session opened that day to return null, not throw'
);
assert.strictEqual(
  matchSessionLabel(sessions, t(13, 45)),
  null,
  'Expected a timestamp in the gap between one session closing and the next opening to return null'
);
assert.strictEqual(matchSessionLabel([], t(11, 0)), null, 'Expected an empty sessions array to return null, not throw');
assert.strictEqual(matchSessionLabel(sessions, null), null, 'Expected a missing timestamp to return null, not throw');
assert.strictEqual(matchSessionLabel(null, t(11, 0)), null, 'Expected a missing sessions list to return null, not throw');
assert.strictEqual(
  matchSessionLabel([{ id: 9, closed_at: null }], t(11, 0)),
  null,
  'Expected a session row with no opening_time/opened_at at all (Invalid Date -> NaN comparisons) to simply never match, not throw'
);

// 4. Boundary conditions — deliberate half-open interval [start, end):
// a timestamp exactly at a session's opening instant belongs to that
// session (inclusive start); a timestamp exactly at closed_at does NOT
// belong to the closing session (exclusive end) — it falls into the gap
// unless another session's window starts at that exact instant. This
// mirrors the register-guard invariant that a sale can only be created
// while a register is open, so a real order timestamp should never
// legitimately land exactly on a closed_at boundary — see the comment
// above matchSessionLabel in useRegisterSessions.js for the full reasoning.
// Both sides are tested here so a future edit can't silently flip the
// convention without a test failing.
assert.strictEqual(
  matchSessionLabel(sessions, t(9, 2)),
  'Session 1 (9:02am–1:15pm)',
  "Expected a timestamp exactly at a session's opening instant to be included in that session (inclusive start)"
);
assert.strictEqual(
  matchSessionLabel(sessions, t(13, 15)),
  null,
  'Expected a timestamp exactly at closed_at to NOT be included in the closing session (exclusive end) — falls into the gap since the next session has not opened yet at that instant'
);
assert.strictEqual(
  matchSessionLabel(sessions, t(14, 0)),
  'Session 2 (2:00pm–now)',
  "Expected a timestamp exactly at the next session's opening instant to belong to that new session (inclusive start)"
);

// 5. Single-session day -> label omits the number ("Session", not "Session 1")
const singleClosedSession = [{ id: 5, opened_at: t(10, 0), closed_at: t(12, 0) }];
assert.strictEqual(
  matchSessionLabel(singleClosedSession, t(11, 0)),
  'Session (10:00am–12:00pm)',
  'Expected the only session of the day to be labeled plain "Session", not "Session 1"'
);
const singleOpenSession = [{ id: 6, opened_at: t(9, 0), closed_at: null }];
assert.strictEqual(
  matchSessionLabel(singleOpenSession, t(9, 30)),
  'Session (9:00am–now)',
  'Expected the only session of the day, still open, to combine both singular-label and "now" end-label rules'
);

// 6. Field-name fallback: opening_time takes priority over opened_at when
// both are present (matches `s.opening_time || s.opened_at`), and opened_at
// alone is used when opening_time is absent (already exercised by every
// case above, all of which only set opened_at).
const bothFieldsSet = [{ id: 7, opening_time: t(8, 0), opened_at: t(8, 30), closed_at: t(9, 0) }];
assert.strictEqual(
  matchSessionLabel(bothFieldsSet, t(8, 15)),
  'Session (8:00am–9:00am)',
  'Expected opening_time to take priority over opened_at when both are present on the same row'
);

console.log('✅ register-sessions: all checks passed');
