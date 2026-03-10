# Field Staff Tracking — Recommendations

## Current Capabilities (Already Implemented)

1. **Delivery Partner GPS Tracking** — Background location tracking via `expo-location` + `expo-task-manager`, breadcrumb trail stored in `delivery_locations` table
2. **Live Map View** — Real-time partner positions on a map with moving/idle indicators, speed, battery level
3. **Daily Summaries** — Distance traveled, active/idle minutes, deliveries completed per partner per day
4. **Geofencing** — Clock-in/out only allowed within geofenced locations, configurable timeout
5. **Attendance Tracking** — Clock-in/out with late arrival detection, outdoor duty mode, multi-shift support
6. **Performance Metrics** — Completion rate, average delivery time, on-time percentage per partner

---

## Recommended Enhancements for Field Staff

### 1. Extend GPS Tracking to All Field Roles

**Current limitation:** Only `delivery_partner` role can send GPS breadcrumbs.

**Recommendation:**
- Allow `employee` role to opt in to location tracking when on "outdoor duty" or assigned field tasks
- Create a `field_assignment` table linking staff to field tasks with expected locations
- Track route compliance — did the staff visit the expected locations?

### 2. Attendance Verification with Photo

**Recommendation:**
- Require a selfie photo at clock-in to prevent buddy punching
- Store verification photos in `attendance_records` with a `selfie_path` column
- Optional: Face recognition comparison against stored avatar (requires ML service)

### 3. Task-Based Field Tracking

**Recommendation:**
- Create a `field_tasks` table (assignee, location, expected_arrival, actual_arrival, status)
- Staff marks task as "started" → "arrived" → "completed" with GPS verification
- Manager dashboard shows field task completion in real-time

### 4. Idle Time Alerts

**Recommendation:**
- If a delivery partner has been idle (no movement) for more than X minutes during active delivery hours, send a push notification to the manager
- Configurable threshold per location or per partner
- Requires push notification infrastructure (Expo Push Notifications)

### 5. Route Efficiency Analysis

**Recommendation:**
- Compare actual route (from GPS breadcrumbs) vs optimal route between pickup and delivery points
- Calculate detour percentage: `(actual_distance - optimal_distance) / optimal_distance × 100`
- Flag routes with >30% detour for manager review
- Requires integration with a routing API (Google Directions API or OSRM)

### 6. Shift Adherence Monitoring

**Recommendation:**
- Compare actual clock-in/out times against assigned shift schedule
- Track patterns: consistently late, early departures, skipped shifts
- Generate weekly adherence reports per staff member
- Already have most of the data — just needs a reporting/dashboard view

### 7. Offline Support

**Recommendation:**
- Cache GPS breadcrumbs locally when network is unavailable
- Batch-upload when connectivity is restored
- The current `expo-task-manager` background task should be enhanced to queue failed API calls
- Use AsyncStorage or SQLite on device for local queue

### 8. Privacy & Consent

**Important considerations:**
- Only track location during working hours (shift start to shift end)
- Stop background tracking when clocked out
- Provide clear privacy policy explaining what data is collected
- Allow staff to see their own tracking history
- Comply with local labor laws regarding employee monitoring

### 9. Battery Optimization

**Recommendation:**
- Reduce GPS polling frequency when partner is idle (e.g., every 2 minutes instead of 30 seconds)
- Use significant location change API when possible
- Already showing battery level — add low-battery warnings to manager dashboard
- Consider reducing accuracy requirements when battery is below 20%

### 10. Integration with External Systems

**Future consideration:**
- Export attendance + location data to payroll systems
- Integration with fleet management solutions for delivery vehicles
- SMS/WhatsApp notifications for delivery ETAs to customers based on real-time location

---

## Implementation Priority

| Priority | Feature | Effort | Impact |
|----------|---------|--------|--------|
| 🔴 High | Shift adherence reports | Low | High |
| 🔴 High | Idle time alerts | Medium | High |
| 🟡 Medium | Extend tracking to field employees | Medium | Medium |
| 🟡 Medium | Offline GPS queue | Medium | Medium |
| 🟡 Medium | Attendance selfie verification | Low | Medium |
| 🟢 Low | Route efficiency analysis | High | Medium |
| 🟢 Low | Task-based field tracking | High | High |
| 🟢 Low | Face recognition | Very High | Low |

---

## Technical Notes

- Current background tracking uses `startLocationUpdatesAsync` with `Accuracy.Balanced` — suitable for most use cases
- The `delivery_locations` table already stores `battery_level`, `speed`, `heading`, `is_moving` — good foundation
- Socket.io real-time updates already in place for live map — can be extended for alerts
- The geofencing system (`useGeofence` hook) uses `expo-location` geofencing APIs — works on iOS and Android, not on web
