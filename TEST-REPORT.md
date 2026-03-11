# BloomCart — Test Report & Bug Fix Summary

**Date:** 2026-03-11  
**Tester:** Automated API + Manual Code Review  
**Backend Tests:** 70/70 PASSED ✓  
**Frontend Syntax:** 0 errors ✓  

---

## Bug Fixes Applied This Session

### Issue 1 — Push Notification Errors ✓ FIXED
**Problem:** App crashed with "No projectId found" and `removeNotificationSubscription is not a function`.  
**Root Cause:**
1. `Constants.expoConfig.extra.eas.projectId` was missing — no EAS config present.
2. Newer expo-notifications SDK removed `Notifications.removeNotificationSubscription(ref)`; now uses `ref.remove()`.

**Fix:**
- Added `Constants.easConfig?.projectId` as fallback for projectId resolution in `usePushNotifications.js`
- Replaced `Notifications.removeNotificationSubscription(ref)` with `ref.remove()`
- Added `expo-notifications` plugin to `app.json`

**Files Modified:**
- `app/src/hooks/usePushNotifications.js`
- `app/app.json`

---

### Issue 2 — Attendance Clock-in Duplicate 500 Crash ✓ FIXED
**Problem:** Tapping clock-in multiple times (after already clocked-in and out) caused UNIQUE constraint violation (5 repeated 500 errors).  
**Root Cause:** Code only checked for unclosed attendance records. If user had already clocked in AND out on the same day, `INSERT` failed due to `UNIQUE(user_id, date)` constraint.

**Fix:**
- Changed attendance check to look for ANY existing record for today (not just unclosed ones)
- Returns appropriate message: "Already clocked in today" or "Already clocked in and out today"

**Files Modified:**
- `server/routes/attendance.js`

---

### Issue 3 — More Tab Stack Stays on Nested Screen ✓ FIXED
**Problem:** Navigating to Reports/Staff/Locations/Settings from Dashboard, then tapping the More tab, kept the More stack on the nested screen instead of returning to MoreHome.

**Root Cause:** `navigate('More', { screen: 'X' })` calls from DashboardScreen lacked `initial: false`, causing the More tab to permanently set the initial route to the last-navigated screen.

**Fix:**
- Added `initial: false` to all 4 `navigate('More', {...})` calls in DashboardScreen
- Added `tabPress` listener for More tab to reset to MoreHome
- Also added `tabPress` listeners for Orders (→ OrdersHub) and Inventory (→ StockOverview) tabs

**Files Modified:**
- `app/src/screens/DashboardScreen.js`
- `app/src/navigation/MainNavigator.js`

---

### Issue 4 — Timezone/Time Mismatch ✓ FIXED
**Problem:** Server used UTC timestamps (`new Date().toISOString()`) and inline IST conversion functions that were inconsistent across route files.

**Root Cause:** Each route file had its own `localToday()` function that hardcoded timezone. Some used UTC, some used system timezone.

**Fix:**
- Created shared `server/utils/time.js` with `getTimezone()`, `todayStr()`, `nowLocal()`, `nowTimeStr()`, `clearTimezoneCache()`
- Timezone is now configurable via settings (default: 'Asia/Kolkata')
- Updated 8 route files to use the shared time utility
- Cache with 5-minute TTL prevents excessive DB queries

**Files Created:**
- `server/utils/time.js`

**Files Modified:**
- `server/config/database.js` — timezone setting seed + migration
- `server/routes/attendance.js` — uses shared time utility
- `server/routes/sales.js` — uses shared time utility
- `server/routes/stock.js` — uses shared time utility
- `server/routes/expenses.js` — uses shared time utility
- `server/routes/production.js` — uses shared time utility
- `server/routes/reports.js` — uses shared time utility
- `server/routes/delivery-tracking.js` — uses shared time utility
- `server/routes/deliveries.js` — uses shared time utility
- `server/routes/staff-management.js` — uses shared time utility
- `server/routes/settings.js` — cache clearing on timezone change

---

### Issue 5 — Customer Cannot Place Orders ✓ FIXED
**Problem:** Customers created by admin (via POS/manager panel) could not log in or register.

**Root Cause:** Admin-created customers get a random password (`bloom_${Date.now()}`). When these customers try to self-register, the server returns "Phone already exists" (409). They can't login because they don't know the random password.

**Fix:**
- Modified `POST /api/auth/register` to allow "claiming" admin-created customer accounts
- When a customer with `created_by IS NOT NULL` (admin-created) tries to register with same phone, the endpoint now updates their name and password instead of rejecting
- Self-registered customers (created_by = NULL) cannot be claimed (security)
- Non-customer roles (owner, manager, etc.) cannot be claimed (security)

**Security Verification:**
- ✓ Self-registered customer accounts: returns 409 (cannot be claimed)
- ✓ Owner/manager/employee accounts: returns 409 (cannot be claimed)
- ✓ Admin-created customer accounts: returns 200 with new credentials

**Files Modified:**
- `server/routes/auth.js`

---

### Issue 6 — Delivery Partner Assignment Redirects to List ✓ FIXED
**Problem:** "Assign Partner" button on DeliveryDetailScreen called `navigation.goBack()` instead of showing a partner selection interface.

**Root Cause:** The button was implemented as a placeholder that just navigated back to the DeliveriesScreen, hoping users would use the assign modal there.

**Fix:**
- Added partner assignment modal directly to DeliveryDetailScreen
- Added state: `assignModalVisible`, `partners[]`, `assignLoading`
- Added `openAssignModal()` — fetches active delivery partners via `api.getUsers({ role: 'delivery_partner' })`
- Added `handleAssign(partnerId)` — calls `api.assignDelivery(deliveryId, { delivery_partner_id: partnerId })`
- Added bottom-sheet style Modal with partner list (name + phone + chevron)
- Replaced `navigation.goBack()` with `openAssignModal`

**Files Modified:**
- `app/src/screens/DeliveryDetailScreen.js`

---

### Additional Fix — CheckoutScreen Syntax Error ✓ FIXED
**Problem:** Stray `)}` in CheckoutScreen.js at line 430 caused JSX parsing error.  
**Fix:** Removed the extra `)}` that didn't close any block.

**Files Modified:**
- `app/src/screens/CheckoutScreen.js`

---

## Backend API Test Results

**Test Script:** `server/test-api.py`  
**Total Tests:** 70  
**Passed:** 70  
**Failed:** 0

### Test Coverage by Module

| Module | Tests | Status |
|--------|-------|--------|
| Auth (login/register/profile/setup) | 8 | ✓ All Pass |
| Locations (CRUD + role access) | 4 | ✓ All Pass |
| Products (CRUD + permissions) | 7 | ✓ All Pass |
| Customers (CRUD + search + addresses) | 5 | ✓ All Pass |
| Sales/Orders (list/create/walk-in/customer-order) | 9 | ✓ All Pass |
| Deliveries (list/detail/customer-orders) | 4 | ✓ All Pass |
| Attendance (list/today/report) | 3 | ✓ All Pass |
| Stock/Inventory (stock/transactions/materials/product-stock) | 4 | ✓ All Pass |
| Production (tasks/pending/my-tasks) | 3 | ✓ All Pass |
| Expenses (list/summary/create) | 4 | ✓ All Pass |
| Reports (dashboard/sales/inventory/customer/employee) | 6 | ✓ All Pass |
| Settings & Notifications (settings/notifications/unread) | 4 | ✓ All Pass |
| Users/Staff (list/detail/permissions) | 3 | ✓ All Pass |
| Staff Management (shifts/salaries/permissions) | 3 | ✓ All Pass |
| Delivery Tracking (active/summary/permissions) | 3 | ✓ All Pass |

### Security Tests Verified
- Unauthenticated access → 401 Unauthorized ✓
- Customer role restrictions → 403 Forbidden on admin endpoints ✓
- Input validation → 400 Bad Request for invalid data ✓
- Non-existent resources → 404 Not Found ✓

---

## Frontend Validation

### Syntax Check
All frontend screens and components pass syntax validation (0 errors across workspace).

### Files Checked
- All screens in `app/src/screens/`
- All components in `app/src/components/`
- Navigation in `app/src/navigation/`
- Services in `app/src/services/`
- Context in `app/src/context/`
- Hooks in `app/src/hooks/`

### Server-Side Syntax
All server files pass `node -c` syntax validation:
- All route files in `server/routes/`
- Config files in `server/config/`
- Middleware in `server/middleware/`
- Utilities in `server/utils/`
- `server/server.js`

---

## Test Accounts

| Role | Phone | Password | Notes |
|------|-------|----------|-------|
| Owner | 9876453210 | naman1234 | Primary admin |
| Customer (claimed) | 7777744441 | customer123 | Admin-created, then claimed via register |
| Customer (claimed) | 7777755551 | fancy123 | Admin-created, then claimed via register |
| Customer (self-reg) | 8888811111 | test1234 | Self-registered |

---

## Summary

All 7 issues from this session have been resolved:

1. ✓ Push notification errors (projectId + removeNotificationSubscription)
2. ✓ Attendance clock-in UNIQUE constraint crash
3. ✓ More tab navigation sticky behavior
4. ✓ Timezone/time mismatch across server
5. ✓ Customer cannot place orders (admin-created accounts now claimable)
6. ✓ Delivery partner assignment redirects to list (now shows modal on detail page)
7. ✓ Thorough testing — 70/70 backend tests passing, 0 frontend syntax errors

**Additional Fix:** CheckoutScreen.js stray `)}` syntax error resolved.
