// server/utils/shift-work.js
//
// Pure computation of late-arrival minutes and overtime minutes, aware of
// split shifts (employee_shifts.shift_segments). ALWAYS computed fresh from
// raw clock_in/clock_out timestamps + the shift definition passed in — never
// stored. Mirrors server/utils/order-stage.js's "computed fresh, never
// stored" precedent.
//
// See docs/superpowers/specs/2026-09-16-attendance-shift-payroll-redesign-design.md §6.

const { parseServerDate, getTimezone, nowLocal } = require('./time');

const OVERTIME_GRACE_MINUTES = 30;

// 'HH:MM' (or 'HH:MM:SS') -> minutes since midnight. null for anything that
// doesn't match, so callers can treat bad/missing shift data as "no data"
// rather than crashing.
function timeStrToMinutes(hhmm) {
  if (!hhmm || typeof hhmm !== 'string') return null;
  const m = /^(\d{2}):(\d{2})/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (Number.isNaN(h) || Number.isNaN(min)) return null;
  return h * 60 + min;
}

// Timestamp -> minutes since local midnight, in the shop's configured
// timezone. Uses parseServerDate (not a bare `new Date(ts)`) because
// timestamps read through this codebase's SYNC getDb() layer come back as
// timezone-naive strings representing UTC wall-clock time (nowLocal()'s own
// storage convention) — `new Date()` on a naive string parses it as the
// HOST PROCESS's local time instead, which is wrong by whatever offset
// separates the server's machine timezone from the shop's. This was a real
// bug in an earlier draft of this file, worth ~5.5h of error on every
// figure that used it; parseServerDate is the same helper every other
// timestamp-handling call site in this codebase already relies on for
// exactly this reason.
function timestampToMinutes(ts) {
  const d = parseServerDate(ts);
  if (!d || Number.isNaN(d.getTime())) return null;
  const tz = getTimezone();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const h = Number(parts.find((p) => p.type === 'hour')?.value);
  const min = Number(parts.find((p) => p.type === 'minute')?.value);
  if (Number.isNaN(h) || Number.isNaN(min)) return null;
  return h * 60 + min;
}

// Adds a full day (1440 minutes) per shop-timezone CALENDAR DATE elapsed
// between two timestamps, so a session genuinely running past midnight (an
// all-nighter before a big order — this domain has festival seasons where
// that's real) doesn't wrap its clock-out time around and look like it
// ended before it started. Compares calendar dates, not raw elapsed
// milliseconds / 86400000 — a session that runs from 23:50 to 00:10 has
// crossed one calendar boundary in 20 real minutes, which a
// floor(elapsedMs / dayMs) calculation would miss entirely.
function dayAdjustedMinutes(baseIso, targetIso, targetMinutes) {
  if (targetMinutes == null) return null;
  const base = parseServerDate(baseIso);
  const target = parseServerDate(targetIso);
  if (!base || !target) return targetMinutes;
  const tz = getTimezone();
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const baseDateStr = fmt.format(base);
  const targetDateStr = fmt.format(target);
  if (baseDateStr === targetDateStr) return targetMinutes;
  const daysElapsed = Math.round((new Date(`${targetDateStr}T00:00:00Z`).getTime() - new Date(`${baseDateStr}T00:00:00Z`).getTime()) / 86400000);
  return targetMinutes + Math.max(0, daysElapsed) * 1440;
}

// Normalizes a shift into a list of {start, end} minute-ranges (minutes
// since midnight). A single shift_start/shift_end pair becomes a
// one-segment list, so every caller has exactly one code path regardless of
// split shifts. Handles a real shape found in this project's own live data
// — a shift_segments value that's JSON-encoded TWICE (a string containing a
// JSON string containing the array) — by parsing up to twice before giving
// up, rather than silently falling back to the single window with no
// warning (which would reinstate the split-shift bug this file exists to
// fix). Segments where end <= start (crossing midnight) are dropped —
// POST /shifts (Task 5) blocks these at creation time; this is the
// defensive second layer for shift data that predates that validation.
function normalizeSegments(shiftStart, shiftEnd, shiftSegments) {
  let segments = null;
  if (shiftSegments) {
    let parsed = shiftSegments;
    for (let i = 0; i < 2 && typeof parsed === 'string'; i++) {
      try { parsed = JSON.parse(parsed); } catch (_) { parsed = null; break; }
    }
    if (Array.isArray(parsed) && parsed.length > 0) segments = parsed;
  }
  if (!segments) {
    segments = [{ start: shiftStart, end: shiftEnd }];
  }
  return segments
    .map((seg) => ({ start: timeStrToMinutes(seg.start), end: timeStrToMinutes(seg.end) }))
    .filter((seg) => seg.start != null && seg.end != null && seg.end > seg.start);
}

// The corrected segment-matching rule (see this task's header for why the
// original "nearest start" heuristic was wrong): among segments whose START
// is at-or-before the given time, pick the one with the LATEST start — the
// segment actually "in effect" at that moment. If none qualify (the time is
// before every segment starts), fall back to the earliest segment, so an
// early arrival reads as early rather than "late for the wrong segment."
function matchSegmentForTime(minutes, segments) {
  if (!segments.length || minutes == null) return null;
  const eligible = segments.filter((s) => s.start <= minutes);
  if (eligible.length > 0) {
    return eligible.reduce((latest, s) => (s.start > latest.start ? s : latest));
  }
  return segments.reduce((earliest, s) => (s.start < earliest.start ? s : earliest));
}

function lateMinutesFor(minutes, segment) {
  if (minutes == null || !segment) return 0;
  return Math.max(0, minutes - segment.start);
}

function overtimeMinutesFor(minutes, segment) {
  if (minutes == null || !segment) return 0;
  return Math.max(0, minutes - segment.end - OVERTIME_GRACE_MINUTES);
}

// Main entry point. `sessions` is any list of attendance rows needing at
// minimum { id, clock_in, clock_out } — a single day's rows, or a whole
// payroll period's. `shift` is { shift_start, shift_end, shift_segments } as
// stored on employee_shifts, or null/undefined (every session then
// contributes zero late/OT, matching "no shift configured" being a no-op).
// `options.includeInProgress` (default false) opts a still-open session
// (clock_out IS NULL) into having its overtime measured against "now"
// instead of unconditionally reporting zero — see the in-loop comment below
// for which callers should and shouldn't pass this.
function computeShiftWork(sessions, shift, options = {}) {
  const { includeInProgress = false } = options;
  const segments = shift ? normalizeSegments(shift.shift_start, shift.shift_end, shift.shift_segments) : [];

  let totalLateMinutes = 0;
  let totalOvertimeMinutes = 0;
  const perSession = [];

  for (const session of sessions || []) {
    const clockInMin = timestampToMinutes(session.clock_in);
    const startSegment = matchSegmentForTime(clockInMin, segments);
    const lateMinutes = lateMinutesFor(clockInMin, startSegment);

    let overtimeMinutes = 0;
    let endSegment = null;
    // A still-open session has no clock_out to measure against yet. Live
    // display call sites (today's own screen, the manager roster) opt in
    // via includeInProgress so the OT figure is visible WHILE someone is
    // still working late, not only after they clock out. Money-computing
    // call sites (payroll calculate) must NOT opt in — an in-progress
    // figure changes on every recomputation, fine for a live display, wrong
    // to bake into a disbursement amount. Defaults to false so every
    // existing caller and every verify-shift-work.js fixture is unaffected
    // unless it explicitly opts in.
    const referenceOut = session.clock_out || (includeInProgress ? nowLocal() : null);
    if (referenceOut) {
      const rawOutMin = timestampToMinutes(referenceOut);
      const outMin = dayAdjustedMinutes(session.clock_in, referenceOut, rawOutMin);
      endSegment = matchSegmentForTime(outMin, segments);
      overtimeMinutes = overtimeMinutesFor(outMin, endSegment);
    }

    totalLateMinutes += lateMinutes;
    totalOvertimeMinutes += overtimeMinutes;
    perSession.push({ attendanceId: session.id, lateMinutes, overtimeMinutes, startSegment, endSegment });
  }

  return { totalLateMinutes, totalOvertimeMinutes, sessions: perSession };
}

// Finds calendar dates where SOME but not ALL of a shift's configured
// segments were attended — a genuine partial/half day, distinct from a
// full absence (zero segments attended that day — already counted
// elsewhere as an absent day) and a normal full day (every segment
// attended). Computed fresh from raw attendance rows + the shift
// definition, same "never stored" principle as computeShiftWork itself.
// Only meaningful for a multi-segment (split) shift — a single-segment
// shift has no partial state to detect (present or absent, already
// correctly counted). `sessions` needs at minimum { date, clock_in } per
// row (the real attendance.date column, not derived from clock_in — this
// matches how every other date-scoped query in this codebase already
// treats `date` as the source of truth for which calendar day a session
// belongs to).
function findPartialDays(sessions, shift) {
  const segments = shift ? normalizeSegments(shift.shift_start, shift.shift_end, shift.shift_segments) : [];
  if (segments.length < 2) return [];

  const byDate = new Map(); // date string -> Set of matched segment indices
  for (const session of sessions || []) {
    if (!session.clock_in || !session.date) continue;
    const clockInMin = timestampToMinutes(session.clock_in);
    const seg = matchSegmentForTime(clockInMin, segments);
    if (!seg) continue;
    const segIdx = segments.indexOf(seg);
    if (!byDate.has(session.date)) byDate.set(session.date, new Set());
    byDate.get(session.date).add(segIdx);
  }

  const partialDays = [];
  for (const [date, matchedIdxs] of byDate.entries()) {
    if (matchedIdxs.size > 0 && matchedIdxs.size < segments.length) {
      partialDays.push({
        date,
        attended_segments: matchedIdxs.size,
        total_segments: segments.length,
      });
    }
  }
  return partialDays.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

module.exports = {
  OVERTIME_GRACE_MINUTES,
  timeStrToMinutes,
  timestampToMinutes,
  dayAdjustedMinutes,
  normalizeSegments,
  matchSegmentForTime,
  lateMinutesFor,
  overtimeMinutesFor,
  computeShiftWork,
  findPartialDays,
};
