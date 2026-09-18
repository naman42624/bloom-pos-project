// app/src/screens/TeamAttendanceScreen.js
//
// counter_staff's entry point into the SAME roster component owner/manager
// use (AttendanceRoster is fully self-contained, role-agnostic in its own
// rendering — the role boundary lives at the route-registration/backend
// layer, not in this file). Deliberately NOT the tabbed AttendanceHub (its
// Manage tab links target routes that only exist inside MoreStack, which
// counter_staff has no access to at all) — just the roster, reached from
// counter_staff's own Attendance tab stack instead.
import React from 'react';
import AttendanceRoster from '../components/attendance/AttendanceRoster';

export default function TeamAttendanceScreen() {
  return <AttendanceRoster />;
}
