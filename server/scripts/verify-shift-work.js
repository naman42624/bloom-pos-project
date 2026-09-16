require('dotenv').config({ path: `${__dirname}/../.env` });
const assert = require('assert');
const {
  OVERTIME_GRACE_MINUTES,
  timeStrToMinutes,
  timestampToMinutes,
  dayAdjustedMinutes,
  normalizeSegments,
  matchSegmentForTime,
  lateMinutesFor,
  overtimeMinutesFor,
  computeShiftWork,
} = require('../utils/shift-work');

assert.strictEqual(OVERTIME_GRACE_MINUTES, 30);

// ── timeStrToMinutes ──
assert.strictEqual(timeStrToMinutes('07:00'), 420);
assert.strictEqual(timeStrToMinutes('18:30'), 1110);
assert.strictEqual(timeStrToMinutes(null), null);
assert.strictEqual(timeStrToMinutes('not-a-time'), null);

// ── timestampToMinutes: must handle a timezone-NAIVE string correctly ──
// (the sync DB layer's actual shape — nowLocal() stores UTC wall-clock with
// no offset marker). This is the exact case an earlier draft's fixtures
// never covered, hiding a ~5.5h real parsing error.
assert.strictEqual(timestampToMinutes('2026-09-16T12:33:00.000'), 1083, 'A naive UTC-wall-clock string must parse to 18:03 IST (1083 min), not silently shift by the host machine\'s local offset');
// An offset-bearing string must parse the same way.
assert.strictEqual(timestampToMinutes('2026-09-16T18:03:00+05:30'), 1083);

// ── normalizeSegments ──
let segs = normalizeSegments('09:00', '18:00', null);
assert.deepStrictEqual(segs, [{ start: 540, end: 1080 }]);

segs = normalizeSegments('09:00', '18:00', [{ start: '07:00', end: '12:00' }, { start: '18:00', end: '22:00' }]);
assert.deepStrictEqual(segs, [{ start: 420, end: 720 }, { start: 1080, end: 1320 }]);

// Malformed shift_segments falls back to the single window, not a crash.
segs = normalizeSegments('09:00', '18:00', 'not-json');
assert.deepStrictEqual(segs, [{ start: 540, end: 1080 }]);

// Double-encoded JSON (a real shape found in the live dev DB —
// employee_shifts id 4 holds a JSON STRING containing JSON, not an array)
// must still resolve to real segments, not silently fall back and
// reinstate the split-shift bug with no warning.
segs = normalizeSegments('09:00', '18:00', JSON.stringify(JSON.stringify([{ start: '07:00', end: '12:00' }])));
assert.deepStrictEqual(segs, [{ start: 420, end: 720 }]);

// A midnight-crossing segment (end <= start) is rejected, not silently
// producing nonsense minutes — POST /shifts (Task 5) blocks these at
// creation time too; this is the defensive second layer.
segs = normalizeSegments('09:00', '18:00', [{ start: '22:00', end: '02:00' }, { start: '07:00', end: '12:00' }]);
assert.deepStrictEqual(segs, [{ start: 420, end: 720 }]);

// ── matchSegmentForTime: the corrected "latest start at-or-before" rule ──
const splitSegs = [{ start: 420, end: 720 }, { start: 1080, end: 1320 }]; // 07-12, 18-22
assert.deepStrictEqual(matchSegmentForTime(1083, splitSegs), { start: 1080, end: 1320 }, 'A 18:03 arrival must match the 18:00 segment, not the 07:00 one (bug #3)');
assert.deepStrictEqual(matchSegmentForTime(425, splitSegs), { start: 420, end: 720 });
// Arrived before the first segment starts — falls back to the earliest.
assert.deepStrictEqual(matchSegmentForTime(400, splitSegs), { start: 420, end: 720 });
assert.strictEqual(matchSegmentForTime(500, []), null);

// The 3-segment live-data case that broke the OLD nearest-start heuristic:
// 61 minutes late for the first segment must NOT be swallowed by a nearer
// second segment's start.
const threeSegs = [{ start: 540, end: 600 }, { start: 660, end: 1080 }, { start: 1200, end: 1350 }]; // 09-10, 11-18, 20-22:30
assert.deepStrictEqual(matchSegmentForTime(601, threeSegs), { start: 540, end: 600 }, 'A 10:01 arrival is still "for" the 09:00-10:00 segment (61 min late), not silently reattributed to 11:00');

// ── lateMinutesFor / overtimeMinutesFor ──
assert.strictEqual(lateMinutesFor(1083, { start: 1080, end: 1320 }), 3);
assert.strictEqual(lateMinutesFor(1075, { start: 1080, end: 1320 }), 0);
assert.strictEqual(lateMinutesFor(601, { start: 540, end: 600 }), 61);
assert.strictEqual(overtimeMinutesFor(1340, { start: 1080, end: 1320 }), 0); // 20 min over, inside 30-min grace
assert.strictEqual(overtimeMinutesFor(1350, { start: 1080, end: 1320 }), 0); // exactly at the grace boundary
assert.strictEqual(overtimeMinutesFor(1365, { start: 1080, end: 1320 }), 15); // 45 min over - 30 grace
assert.strictEqual(overtimeMinutesFor(1200, { start: 1080, end: 1320 }), 0); // left early, not negative

// ── computeShiftWork: the exact live-data regression the review found ──
// Shift 09:00-13:00 / 15:00-22:30. A session spanning the WHOLE midday
// break (forgot to clock out for lunch) must NOT read as ~9 hours of
// overtime — the corrected end-segment match picks the segment actually
// "in effect" at clock-out (15:00-22:30), and the clock-out (22:30) lands
// exactly at that segment's end, so overtime is 0, not (22:30-13:00-30min).
const lunchGapShift = { shift_start: null, shift_end: null, shift_segments: JSON.stringify([{ start: '09:00', end: '13:00' }, { start: '15:00', end: '22:30' }]) };
const lunchGapSession = [{ id: 1, clock_in: '2026-09-16T09:05:00+05:30', clock_out: '2026-09-16T22:30:00+05:30' }];
const lunchGapResult = computeShiftWork(lunchGapSession, lunchGapShift);
assert.strictEqual(lunchGapResult.totalOvertimeMinutes, 0, `A session that spans a forgotten lunch clock-out but ends exactly on time must show 0 OT, got ${lunchGapResult.totalOvertimeMinutes}`);
assert.strictEqual(lunchGapResult.totalLateMinutes, 5, 'Still correctly 5 min late against the 09:00 segment');

// ── computeShiftWork: split-shift day, two real sessions ──
const splitShift = { shift_start: null, shift_end: null, shift_segments: JSON.stringify([{ start: '07:00', end: '12:00' }, { start: '18:00', end: '22:00' }]) };
const today = '2026-09-16';
const sessions = [
  { id: 1, clock_in: `${today}T07:02:00+05:30`, clock_out: `${today}T12:00:00+05:30` }, // 2 min late, on time out
  { id: 2, clock_in: `${today}T18:03:00+05:30`, clock_out: `${today}T22:45:00+05:30` }, // 3 min late for the RIGHT segment, 15 min real OT (45-30 grace)
];
const result = computeShiftWork(sessions, splitShift);
assert.strictEqual(result.totalLateMinutes, 5, `Expected 2 (session 1) + 3 (session 2, correctly matched to its OWN segment) = 5, got ${result.totalLateMinutes}`);
assert.strictEqual(result.totalOvertimeMinutes, 15, `Expected 15 OT minutes, got ${result.totalOvertimeMinutes}`);
assert.strictEqual(result.sessions[1].lateMinutes, 3, 'Session 2 (6pm arrival) must be checked against the 18:00 segment (3 min late), not silently zeroed — the fix is matching the RIGHT segment, not hiding lateness');

// An open session (no clock_out yet) contributes zero overtime BY DEFAULT.
const openSession = [{ id: 3, clock_in: `${today}T18:00:00+05:30`, clock_out: null }];
assert.strictEqual(computeShiftWork(openSession, splitShift).totalOvertimeMinutes, 0);

// ── computeShiftWork: includeInProgress opt-in (Fix Round 1, Task 21) ──
// A still-open session must report REAL, live overtime once a caller
// explicitly opts in via includeInProgress — the whole point of a live OT
// indicator (manager roster, employee's own screen) is seeing it WHILE
// someone is still working late, not only after they clock out. clock_in
// is set exactly 24 real hours before "now": in Asia/Kolkata (fixed
// UTC+5:30, no DST), that always lands on exactly the PREVIOUS shop-tz
// calendar date, so against a fixed 09:00-18:00 shift this session is
// always well past shift-end+grace, regardless of what time of day this
// suite actually runs.
const liveShift = { shift_start: '09:00', shift_end: '18:00', shift_segments: null };
const nowForLiveOt = new Date();
const liveClockIn = new Date(nowForLiveOt.getTime() - 24 * 60 * 60 * 1000).toISOString();
const liveOpenSession = [{ id: 6, clock_in: liveClockIn, clock_out: null }];

// Expected value derived from this module's own exported pure primitives
// (not a reimplementation of overtimeMinutesFor's logic) — deterministic
// given "now", not a guess at the algorithm under test.
const expectedNowMinutes = timestampToMinutes(nowForLiveOt.toISOString());
const expectedOutMin = expectedNowMinutes + 1440; // clock_in was exactly 1 calendar day earlier
const expectedLiveOt = overtimeMinutesFor(expectedOutMin, { start: 540, end: 1080 }); // 09:00-18:00 in minutes

const liveOtResult = computeShiftWork(liveOpenSession, liveShift, { includeInProgress: true });
assert.strictEqual(liveOtResult.totalOvertimeMinutes, expectedLiveOt, `Expected ${expectedLiveOt} min OT with includeInProgress:true on a session open 24h past a 09:00-18:00 shift, got ${liveOtResult.totalOvertimeMinutes}`);
assert.ok(liveOtResult.totalOvertimeMinutes > 0, 'includeInProgress:true must report NON-ZERO overtime for a session well past shift-end+grace while still open');

// The SAME fixture, WITHOUT opting in (default, and explicit false), must
// still report zero — proves the default/payroll behavior is completely
// unaffected by this fix.
assert.strictEqual(computeShiftWork(liveOpenSession, liveShift).totalOvertimeMinutes, 0, 'Without includeInProgress, an open session must still report 0 OT (default/payroll behavior unchanged)');
assert.strictEqual(computeShiftWork(liveOpenSession, liveShift, { includeInProgress: false }).totalOvertimeMinutes, 0, 'Explicit includeInProgress:false must also report 0 OT');

// No shift configured — everything zero, not a crash.
const noShiftResult = computeShiftWork(sessions, null);
assert.strictEqual(noShiftResult.totalLateMinutes, 0);
assert.strictEqual(noShiftResult.totalOvertimeMinutes, 0);

// A session genuinely running past midnight (an all-nighter before a big
// order) must not wrap around and look like it ended before it started.
const lateNightShift = { shift_start: null, shift_end: null, shift_segments: JSON.stringify([{ start: '20:00', end: '22:30' }]) };
const lateNightSession = [{ id: 4, clock_in: `${today}T20:05:00+05:30`, clock_out: '2026-09-17T00:30:00+05:30' }];
const lateNightResult = computeShiftWork(lateNightSession, lateNightShift);
assert.strictEqual(lateNightResult.totalOvertimeMinutes, 90, `Expected 90 (worked to 00:30 = 1470 adjusted minutes, minus 1350 segment end, minus 30 grace), got ${lateNightResult.totalOvertimeMinutes}`);

console.log('verify-shift-work: all assertions passed');
