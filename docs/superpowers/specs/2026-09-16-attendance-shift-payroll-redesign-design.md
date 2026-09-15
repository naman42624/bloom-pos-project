# Attendance, shift, overtime & payroll redesign — design

**Sub-project:** roadmap item 6 (Attendance & shift management), extended per user direction to also cover salary/payroll/advance tracking (roadmap didn't previously list this as its own item — the two are folded into one design here because they share a data model: overtime cannot be computed without shift segments, and payroll cannot be trusted without correct attendance).

## 0. Why this exists

The owner's own words: "the shift and attendance is a mess... not usable in the current state... a lot of small bugs." An investigation (this session, static code read of `server/routes/attendance.js`, `server/routes/staff-management.js`, all five attendance/salary screens, `MainNavigator.js`, and the live dev DB) found the picture is more specific than "nothing works": a substantial, mostly-working payroll subsystem already exists end-to-end (shifts, salaries, payroll calculate/disburse, salary advances, real geofencing), but it has two confirmed live bugs, one role silently locked out of three routes, a data model that cannot represent split shifts correctly despite having a field for them, and an information architecture that buries payroll/advances/shifts equally deep regardless of how often they're actually used. This document redesigns around those specific findings, not a generic rewrite.

## 1. What already exists (verified, not assumed)

- **Attendance** (`attendance.js`): row-per-session model (supports multiple clock-in/outs per day already, mechanically — the `/clock-in` guard only blocks a *second open* session, not a second session per day), `late_arrival`/`early_departure` booleans computed at clock-in/out time via `isLateArrival()`/`isEarlyDeparture()`, GPS coordinates captured on manual clock-in/out, outdoor-duty request flow, salary-advance request flow.
- **Shifts** (`staff-management.js` `/shifts`): per-user-per-location shift row including `shift_segments` (JSON, for split shifts) — **defined and displayed in `ShiftManagementScreen.js`, but never read by any attendance or payroll logic.** This is the central gap this design closes.
- **Payroll** (`staff-management.js` `/salaries`, `/payroll/*`): salary records with type (monthly/daily/hourly), salary-change history, a preview-only `/payroll/calculate`, a transactional `/payroll/disburse` (writes `salary_payments`, auto-deducts outstanding `salary_advances` oldest-first), paginated `/payroll/history`. Fully wired to `SalaryManagementScreen.js`.
- **Salary advances**: request/approve/reject/repay flow, `SalaryAdvancesScreen.js`, already auto-deducted during disbursement.
- **Geofencing**: per-location `geofence_radius`, native background geofencing (`useGeofence.native.js`) + web geolocation watch (`useGeofence.js`), a server cron (`server.js`) that auto clocks someone out after a configurable per-shift timeout following an exit event. Confirmed live in the dev DB: "Main Shop" has real coordinates and a tuned 50m radius; not every location does.
- **Push notifications**: fully built (`push_tokens` table, `createNotification({ userIds, title, body, ... })` in `notifications.js`, already used by `sales.js`/`deliveries.js`/`production.js`). No new infrastructure needed anywhere in this design.
- **Navigation**: all six attendance/salary screens are registered and reachable (not orphaned) — but five of six are one level deep, behind a "Quick Links" row inside `AttendanceScreen`, with no frequency-based prioritization (a screen used once a month is exactly as buried as one used daily).

## 2. Confirmed bugs (fixed regardless of anything else in this doc)

1. **`salary_advances.status` CHECK constraint** doesn't include `'repaid'`, but `staff-management.js` (`/payroll/disburse` auto-deduction) and `attendance.js` (`/attendance/salary-advance/:id/repay`) both write exactly that value. Confirmed in the live dev DB: the constraint is **already absent there** — meaning dev was hand-patched at some point and the fix never became a `database.js` migration, the identical pattern that already caused two real production 500s in this codebase (`refunds.requested_by`/`approved_by`, `users_role_check` — see `CLAUDE.md`'s structural-debt section). If production still has the original constraint, marking an advance repaid or disbursing payroll against someone with an outstanding advance is 500ing there right now.
2. **`florist_staff` excluded from `authorize()`** on three routes despite being a real, active role elsewhere in the app and included on `/clock-in`/`/clock-out` themselves: `GET /attendance/today`, `GET /attendance/salary-advances`, `POST /staff/geofence-event`. Each failure is caught client-side and swallowed (no error shown) — a florist's own status/advances/geofence tracking just silently doesn't work, with no signal to them or anyone else that anything's wrong.
3. **`isLateArrival()`/`isEarlyDeparture()` compare against a single `shift_start`/`shift_end`, always** — regardless of `shift_segments`. A split-shift employee (e.g. 7–12, 6–10) clocking in for their second session gets compared against the *first* segment's start time: 18:00 > 07:00 evaluates to "late," every day, for arriving exactly on time. This is a correctness bug, not a UX gap — it's why the attendance data itself can't be trusted for anyone on a split shift today.

## 3. Scope

**In scope:** shop-bound staff attendance (owner, manager, employee, counter_staff, florist_staff), shift definition including split shifts, overtime *tracking* (not auto-pay), salary/payroll/advances, and the information architecture around all of it.

**Explicitly out of scope** (per direct confirmation this session):
- **Delivery riders.** They have a separate live GPS delivery-tracking system already and a fundamentally different work pattern (mobile all day, not shop-bound). They keep using clock-in/out exactly as today; nothing here changes for that role.
- **Overtime auto-pay.** This design computes and surfaces OT; it never factors OT into `net_amount` automatically. Revisit as a separate, explicitly-scoped follow-up once tracking has been live long enough to trust the numbers.
- **Geofence radius/timeout tuning** (operational data, not a code question) and **any change to which locations have coordinates set** (confirmed only some do in dev; production coordinate coverage needs checking separately, outside this document).
- Anything about `ShiftManagementScreen.js`'s own editing UI beyond what's needed to make split shifts actually take effect downstream — the segment-entry UI itself already works and isn't being redesigned, just finally connected to something that reads it.

## 4. Data model changes (all additive; see `db-migration-safety` review below)

| Table | Change | Why |
|---|---|---|
| `expenses` | new nullable `employee_id` (FK → `users.id`) | Lets a salary-category expense — auto-written or manually entered — link to a real employee, closing the "advances and salary aren't connected to reporting" gap. |
| `salary_payments` | new nullable `expense_id` (FK → `expenses.id`) | Traceability in both directions between a payroll disbursement and its expense/register-reconciliation record. |
| `salary_advances.status` CHECK constraint | widened to include `'repaid'` | Fixes bug #1 above. Widening-only — cannot reject any row the old constraint accepted. |

**No changes to `attendance`, `employee_shifts`, or any other table.** Earlier drafting of this design considered a new `scheduled_segment_index` column and a stored `late_minutes` value; both turned out unnecessary once late-minutes and OT-minutes were designed as read-time derivations (§6) from data already stored (`clock_in`/`clock_out` timestamps, `shift_segments`) — matching how `computeOrderStage()` already works in this codebase (computed fresh, never stored, so it can't go stale if a shift definition changes later). Leaner migration, same outcome.

**Migration mechanics:** three `ensureColumn`/constraint-patch calls in `database.js`, idempotent, following the exact existing pattern (compare to the `purchase_orders_status_check` drop-and-recreate already in that file). Per `db-migration-safety`: before this runs against production, take a backup and confirm against a copy of real data, not just the empty/synthetic dev DB — this is an implementation-phase step, tracked in the plan, not done as part of this design.

**Layering note:** the new `expenses` insert inside `POST /payroll/disburse` must execute inside the *same* transaction as the existing `salary_payments` insert (both commit or neither does) — so it deliberately stays on the sync `getDb()` layer that route already uses, rather than following this project's general "prefer `database-async.js` for new code" guidance. Splitting the two inserts across the sync and async layers would use two separate DB connections and break atomicity. Any other genuinely new, non-transactional code in this design (the geofence notification trigger, the read-time OT/late-minutes helper — which is pure JS, no DB access of its own) isn't subject to this constraint.

## 5. Employee-facing changes

The clock-in/out control itself — button, screen, position — **does not move**. Per `staff-ux-checklist`, this is the highest-frequency action in the whole domain (up to twice a day, every day, for someone who's never used business software before); the redesign's IA changes (§7) are entirely on the manager/owner side. What changes underneath:

- **Split-shift correctness** (fixes bug #3): `isLateArrival()`/`isEarlyDeparture()` resolve the *nearest* segment when `shift_segments` is set, falling back to today's single-window behavior when it isn't — someone without a split shift sees zero change in behavior.
- **Geofence auto-clock-in stays fully automatic** (per direct confirmation — no added tap, no daily overhead), but stops being silent: `createNotification()` fires immediately after, e.g. *"Clocked in automatically at Main Shop, 9:03 AM"*, with a one-tap **Undo** for the rare mis-fire (walked past the shop, arrived early off-duty). Exit-timeout auto-clock-out is unchanged — still fully automatic, no notification needed since there's no ambiguity to resolve on that side (per the user's own framing: "not to replace the tap" was specifically about arrival, not departure).
- **A real recovery path for a missed clock-in**: today, forgetting to clock in just leaves someone wrong for the day with no self-service fix. New: a plain-language shortcut ("Didn't get a chance to clock in? Let your manager know") that sends one manager-facing notification rather than requiring the employee to track someone down in person.
- **Visibility into their own record, today**: a plain-language line on their own Attendance screen — *"You're 20 minutes into overtime"* / *"Clocked in 8 minutes late today"* — using the same read-time computation as §6. This directly answers the audit finding that the current flow is entirely a pull (nothing surfaces proactively) and closes the "no feedback loop" gap. Not sensitive data in the `CLAUDE.md` cost/margin sense — it's an employee's own work record.

## 6. Overtime & late-time computation

A pure function (mirrors the shape of `server/utils/order-stage.js`'s `computeOrderStage()`), taking a day's attendance sessions and an employee's `shift_segments` (or single `shift_start`/`shift_end` as fallback), returning:

- Worked time per matched segment.
- **Late minutes**: `clock_in − matched segment start`, when positive — not just the existing boolean, the actual delta.
- **Overtime minutes**: time worked past a segment's end, **minus a 30-minute grace period**, floored at zero. Applies uniformly to every segment boundary in the day (not only the last one) — a split-shift employee who runs 20 minutes over their midday segment end isn't flagged any differently than someone who runs over at closing; both are inside the 30-minute grace, so neither counts.

Computed fresh wherever displayed — never stored. Three consumers:

1. **Employee's own Attendance screen** (§5) — today's running total.
2. **Manager's live roster** (§7) — an OT chip appears on a row once someone crosses their grace period for the day.
3. **`POST /payroll/calculate` response** — `attendance_summary` gains `total_late_minutes` (cumulative across the period, not just `late_days`' existing count) and a new `overtime_minutes` field, both purely informational. `calculation.net_amount` is **not** affected — track-only, as confirmed. The owner sees the numbers and decides any bonus manually at disbursement, same as today's existing (already-built) bonus field.

## 7. Manager/owner: redesigned "Attendance & Payroll" hub

Replaces `AttendanceScreen`'s Quick Links pattern **for owner/manager only** — the employee/counter_staff/florist_staff/delivery_partner `AttendanceStack` experience is untouched (their own clock-in + "My Advances," as today). Two tabs on one screen:

- **Today**: live roster, one row per staff member, each showing exactly one primary contextual action (not a stack of icons, per `staff-ux-checklist` #2) — "Clock In" for someone who hasn't, nothing extra for someone already in. Status per row is simply **in / not clocked in**, plus an OT chip once applicable (§6) — since auto-clock-in stays fully automatic (§5), "arrived" and "clocked in" are the same moment in the normal case, so there's no separate third state to show for it. Manual clock-in/out for someone else — already built, previously three taps deep inside `StaffAttendanceScreen` — is promoted to this one tap directly on the row. A pending-advance-requests count badge. Defaults to the manager's own assigned location (owner defaults to "All," matching the existing pattern already established in `OrdersInboxScreen.js`'s location filter).
- **Manage**: Shifts, Salaries (owner-only — the existing gate is preserved exactly, not widened), Payroll, Advances, Reports — same five existing screens, reached directly instead of nested inside Quick Links. **No existing capability is removed**, only regrouped (`staff-ux-checklist` #9).
- **Dashboard banner**: a small new line for managers/owner — *"3 staff not clocked in"* — one tap into Today. Answers the "employees forget, and managers need an easy way to fix it" ask directly at the point managers already look first each morning, rather than requiring them to remember Attendance exists.

**Geofence pings as a secondary, not a headline, signal**: `geofence_events` already logs every enter/exit (unchanged by this design). Tapping into an individual's row can show their last geofence ping time as supporting detail — useful for the genuine edge cases (a mis-fired auto-clock-in that was undone, or a location with no GPS coordinates configured, where there's no geofence signal at all and manual clock-in is the only path) — but it's not promoted to a primary roster status, since for anyone with working geofencing the normal case has no gap between "arrived" and "clocked in" to cross-check.

## 8. Error handling

Per `staff-ux-checklist` #6, every new error surface is plain language, not technical:
- Undo on a mis-fired auto-clock-in: a single tap, immediate, no confirmation dialog needed (low-stakes, reversible).
- Missed-clock-in report failing to send: "Couldn't send that — try again," never a raw error.
- The three `florist_staff` `authorize()` fixes remove existing silent-failure states entirely (previously: blank/missing data, no message at all) — after the fix there's nothing new to word, those calls simply succeed.

## 9. Testing / verification approach

- `node app/scripts/babel-check.js` on every touched/created frontend file (existing project convention).
- A standalone unit-style check for the new `computeShiftWork`-equivalent function (late-minutes, OT-minutes-with-grace, segment-matching) against hand-built fixture cases: on-time single shift, split shift both segments on time, split shift second-segment "false late" (the exact bug #3 case), OT within grace (no flag), OT past grace (flagged, minus the 30 min).
- Extends the existing `verify-register-expenses.js`-style regression script (or a new sibling, matching that pattern) to confirm `payroll/disburse` correctly writes a linked `expenses` row and that it appears in `GET /api/expenses/summary`.
- Live manual trace, matching this project's standing verification convention: one full day simulated for a split-shift employee (both segments, one deliberately-late second-segment arrival, confirm it does *not* flag late post-fix), one manager using the new roster's one-tap clock-in for a "forgot" case, one full payroll-calculate → disburse cycle confirming the expense/report linkage and the new late/OT fields.

## 10. Rollout / migration safety

Per `db-migration-safety`: before any of §4's changes run against the production database — take a backup, confirm the `salary_advances` constraint's actual current state in production specifically (not inferred from dev, which is already known to differ), and test the constraint-widen plus the two new columns against a copy of real production data rather than only the empty/synthetic dev DB. These are implementation-plan steps, tracked there, not performed as part of this design document.
