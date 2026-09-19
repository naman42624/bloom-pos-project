# Customer Order Tracking Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the public, unauthenticated order-tracking page at `/track/:token` and wire a "Share Tracking Link" action into Orders Inbox — completing the tracking-link feature whose backend half already shipped.

**Architecture:** A web-only pathname check in `App.js`, evaluated before `AuthProvider`/`RootNavigator` mount, renders a fully standalone `TrackingScreen` with zero shared state with the authenticated app. `TrackingScreen` calls the already-shipped `GET /api/track/:token` via the existing `api.js` singleton (safe to reuse unauthenticated — it only attaches an `Authorization` header when a token has been set, which never happens on this path) and renders a plain-language step indicator built from a new pure mapping function.

**Tech Stack:** Expo (React Native web), no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-11-customer-tracking-page-design.md`.

## Global Constraints

- Every derived/summary value is computed fresh on read, never stored (CLAUDE.md).
- Minimum 44×44pt tap targets on every touchable (staff-ux-checklist #7) — applies to the new Share Tracking Link button.
- The backend response shape (`sale_number`, `order_type`, `stage_label`, `scheduled_date`, `scheduled_time`, `location_name`) is closed — do not request or expect any other field from `GET /api/track/:token`.
- `TrackingScreen` must import nothing that depends on `AuthContext` or React Navigation — it renders before either exists on this code path. `Colors`/`Spacing`/etc. from `app/src/constants/theme.js` and pure functions from `app/src/utils/datetime.js` are safe (no such dependency); anything importing `useAuth`/`useNavigation` is not.
- A 404/invalid-token response must never be distinguished in the UI from any other "not found" reason — one generic friendly message, matching the backend's own refusal to distinguish failure reasons.
- This codebase has no screen-render test harness. Verification per task is `node app/scripts/babel-check.js <file>`, a plain-Node `assert` script for the new pure function, and a live manual trace as the final task.

---

### Task 1: `getTrackingSteps` pure function

**Files:**
- Create: `app/src/utils/trackingSteps.js`
- Test: `app/scripts/verify-tracking-steps.js`

**Interfaces:**
- Produces: `export function getTrackingSteps(orderType, stageKey)` → `null` (for `stageKey === 'cancelled'`) or `{ current: number, steps: [{ label: string, done: boolean, current: boolean }] }`. Task 2 renders this directly.

**The exact stage keys/labels this must handle** (verbatim from `server/utils/order-stage.js`, the only source of truth — do not invent others): `new` ('New'), `preparing` ('Preparing'), `ready_for_pickup` ('Ready for Pickup'), `picked_up` ('Picked Up'), `ready` ('Ready'), `out_for_delivery` ('Out for Delivery'), `delivered` ('Delivered'), `completed` ('Completed'), `cancelled` ('Cancelled'). Different order types reach different subsets of these — a pickup order's journey is `new → preparing → ready_for_pickup → picked_up`; a delivery order's is `new → preparing → ready → out_for_delivery → delivered` (note delivery genuinely passes through the plain `ready` stage before a rider is assigned — this is a real, potentially long-lived state, not a value to skip); a walk_in or in-shop pre_order's is `new → preparing → ready → completed`. `stage_label` alone (a string) is all the tracking API returns — this function's second parameter is actually the stage *key*, not the label; Task 2 must map the returned `stage_label` string back to its key before calling this (see Task 2's own note — labels are not 1:1 with keys, e.g. `'Ready'` is both the pickup ladder's off-ladder value and the delivery/walk_in ladder's `ready` key, so build the label→key lookup Task 2 needs from this same file's ladder data, not by guessing a separate mapping).

- [ ] **Step 1: Write the failing test**

Create `app/scripts/verify-tracking-steps.js`:
```js
const assert = require('assert');
const { getTrackingSteps } = require('../src/utils/trackingSteps');

// Cancelled — no step bar at all, regardless of order type.
assert.strictEqual(getTrackingSteps('pickup', 'cancelled'), null);
assert.strictEqual(getTrackingSteps('delivery', 'cancelled'), null);

// Pickup ladder: 4 steps.
let r = getTrackingSteps('pickup', 'new');
assert.strictEqual(r.steps.length, 4);
assert.strictEqual(r.current, 0);
assert.deepStrictEqual(r.steps.map((s) => s.label), ['Order Received', 'Preparing', 'Ready for Pickup', 'Picked Up']);
assert.strictEqual(r.steps[0].current, true);
assert.strictEqual(r.steps[0].done, false);

r = getTrackingSteps('pickup', 'ready_for_pickup');
assert.strictEqual(r.current, 2);
assert.deepStrictEqual(r.steps.map((s) => s.done), [true, true, false, false]);
assert.strictEqual(r.steps[2].current, true);

r = getTrackingSteps('pickup', 'picked_up');
assert.strictEqual(r.current, 3);
assert.deepStrictEqual(r.steps.map((s) => s.done), [true, true, true, false]);
assert.strictEqual(r.steps[3].current, true);

// Delivery ladder: 5 steps, including the real intermediate 'ready' stage
// (order ready, no rider assigned yet) as its own distinct step.
r = getTrackingSteps('delivery', 'ready');
assert.strictEqual(r.steps.length, 5);
assert.deepStrictEqual(r.steps.map((s) => s.label), ['Order Received', 'Preparing', 'Ready', 'Out for Delivery', 'Delivered']);
assert.strictEqual(r.current, 2);

r = getTrackingSteps('delivery', 'out_for_delivery');
assert.strictEqual(r.current, 3);

r = getTrackingSteps('delivery', 'delivered');
assert.strictEqual(r.current, 4);
assert.deepStrictEqual(r.steps.map((s) => s.done), [true, true, true, true, false]);
assert.strictEqual(r.steps[4].current, true);

// walk_in / pre_order fulfilled in-shop: 4-step fallback ladder.
r = getTrackingSteps('walk_in', 'preparing');
assert.strictEqual(r.steps.length, 4);
assert.deepStrictEqual(r.steps.map((s) => s.label), ['Order Received', 'Preparing', 'Ready', 'Completed']);
assert.strictEqual(r.current, 1);

// 'completed' can be reached from any order type once fully done, even
// though it is not itself a rung in the pickup/delivery ladders above — it
// must clamp to "everything done", not fall through to index 0 (which
// would wrongly show a finished order as freshly received).
r = getTrackingSteps('pickup', 'completed');
assert.strictEqual(r.current, 3);
assert.deepStrictEqual(r.steps.map((s) => s.done), [true, true, true, false]);
assert.strictEqual(r.steps[3].current, true);

r = getTrackingSteps('delivery', 'completed');
assert.strictEqual(r.current, 4);

console.log('verify-tracking-steps: all assertions passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node app/scripts/verify-tracking-steps.js`
Expected: `Cannot find module '../src/utils/trackingSteps'`

- [ ] **Step 3: Write minimal implementation**

Create `app/src/utils/trackingSteps.js`:
```js
// Pure stage->visual-step mapping for the public customer tracking page
// (TrackingScreen.js). No React/RN/api dependency — directly requireable
// from a plain Node assert script, matching this codebase's established
// pattern for pure logic (see app/src/utils/orderGrouping.js,
// app/src/utils/registerSessions.js). Stage keys/labels are copied
// verbatim from server/utils/order-stage.js — that file is the one
// source of truth; if its labels/keys ever change, this must change too.
// See docs/superpowers/specs/2026-09-11-customer-tracking-page-design.md §4.
const LADDERS = {
  pickup: [
    { key: 'new', label: 'Order Received' },
    { key: 'preparing', label: 'Preparing' },
    { key: 'ready_for_pickup', label: 'Ready for Pickup' },
    { key: 'picked_up', label: 'Picked Up' },
  ],
  delivery: [
    { key: 'new', label: 'Order Received' },
    { key: 'preparing', label: 'Preparing' },
    { key: 'ready', label: 'Ready' },
    { key: 'out_for_delivery', label: 'Out for Delivery' },
    { key: 'delivered', label: 'Delivered' },
  ],
};
// walk_in and pre_order (fulfilled in-shop, i.e. not order_type 'delivery')
// share the simplest ladder — neither has a pickup/delivery-specific
// intermediate stage.
const DEFAULT_LADDER = [
  { key: 'new', label: 'Order Received' },
  { key: 'preparing', label: 'Preparing' },
  { key: 'ready', label: 'Ready' },
  { key: 'completed', label: 'Completed' },
];

function getTrackingSteps(orderType, stageKey) {
  if (stageKey === 'cancelled') return null;
  const ladder = LADDERS[orderType] || DEFAULT_LADDER;
  let current = ladder.findIndex((s) => s.key === stageKey);
  // 'completed' is reachable from any order type once fully done, but is
  // only actually a rung in DEFAULT_LADDER — for pickup/delivery, clamp to
  // the ladder's own last step (its label already means "fully done" for
  // that order type: Picked Up / Delivered) rather than falling through to
  // index 0, which would wrongly show a finished order as freshly received.
  if (current === -1 && stageKey === 'completed') current = ladder.length - 1;
  if (current === -1) current = 0; // any other unrecognized key: safest default
  return {
    current,
    steps: ladder.map((s, i) => ({ label: s.label, done: i < current, current: i === current })),
  };
}

module.exports = { getTrackingSteps };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node app/scripts/verify-tracking-steps.js`
Expected: `verify-tracking-steps: all assertions passed`

- [ ] **Step 5: Babel-check and commit**

Run: `node app/scripts/babel-check.js app/src/utils/trackingSteps.js`

```bash
git add app/src/utils/trackingSteps.js app/scripts/verify-tracking-steps.js
git commit -m "Add getTrackingSteps pure function for the customer tracking page"
```

---

### Task 2: `api.getTrackingInfo` + `TrackingScreen`

**Files:**
- Modify: `app/src/services/api.js` (add one method)
- Create: `app/src/screens/TrackingScreen.js`

**Interfaces:**
- Consumes: `getTrackingSteps(orderType, stageKey)` (Task 1). `api` singleton default export (existing).
- Produces: `api.getTrackingInfo(token)` — `GET /track/${token}`, returns the raw `{ success, data }` or `{ success: false, message }` shape `request()` already produces for any endpoint. `export default function TrackingScreen({ token })` — Task 3 renders this directly, no other props.

- [ ] **Step 1: Add the API method**

In `app/src/services/api.js`, find the `// ─── Customer Orders & Dues ───────────────────────────────` section (or any existing section boundary) and add nearby:
```js
  // ─── Public order tracking (no auth) ──────────────────────
  getTrackingInfo(token) {
    return this.request(`/track/${token}`);
  }
```

- [ ] **Step 2: Write `TrackingScreen.js`**

Create `app/src/screens/TrackingScreen.js`:
```js
// The app's only screen a visitor can reach with no login and no session —
// see App.js for the routing bypass that renders this directly, before
// AuthProvider/RootNavigator ever mount. Because of that, this file must
// import NOTHING that depends on AuthContext or React Navigation. Colors/
// Spacing (theme.js) and the plain date-formatting helpers (datetime.js)
// have no such dependency and are safe.
import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, ScrollView } from 'react-native';
import api from '../services/api';
import { getTrackingSteps } from '../utils/trackingSteps';
// formatShopDateLabel for the date ("Today"/"Tomorrow"/formatted date) +
// formatTimeString for the time — NOT formatTime on a concatenated
// `${date}T${time}` string. scheduled_date/scheduled_time are shop-local
// wall-clock values, not UTC; formatTime's underlying parseServerDate
// treats an unmarked 'T'-containing string as UTC and appends 'Z', which
// would then get shop-timezone-converted a SECOND time, double-shifting
// the displayed hour. formatTimeString parses "HH:MM:SS" as plain digits
// with no Date object involved at all — no timezone conversion, no bug
// surface. (Caught in this plan's own self-review, 2026-09-11 — do not
// "simplify" this back to formatTime on a joined string.)
import { formatShopDateLabel, formatTimeString } from '../utils/datetime';
import { Colors, Spacing, FontSize, BorderRadius } from '../constants/theme';

export default function TrackingScreen({ token }) {
  const [state, setState] = useState({ loading: true, data: null, notFound: false });

  useEffect(() => {
    let cancelled = false;
    api.getTrackingInfo(token)
      .then((res) => { if (!cancelled) setState({ loading: false, data: res.data, notFound: false }); })
      .catch(() => { if (!cancelled) setState({ loading: false, data: null, notFound: true }); });
    return () => { cancelled = true; };
  }, [token]);

  if (state.loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={Colors.primary} />
      </View>
    );
  }

  if (state.notFound || !state.data) {
    return (
      <View style={styles.center}>
        <Text style={styles.notFoundTitle}>We couldn't find this order</Text>
        <Text style={styles.notFoundText}>The link may be out of date — please contact the shop.</Text>
      </View>
    );
  }

  const { sale_number, order_type, stage_label, scheduled_date, scheduled_time, location_name } = state.data;
  // The tracking API returns a LABEL (e.g. "Ready for Pickup"), but
  // getTrackingSteps needs the underlying stage KEY. Labels aren't 1:1 with
  // keys across order types (e.g. "Ready" is a real key for both delivery
  // and the walk_in/pre_order default ladder), so build the reverse lookup
  // from the same label text this screen actually received rather than
  // re-deriving stage logic here — a tiny local map covers every label
  // server/utils/order-stage.js can produce (see Task 1's own comment for
  // the authoritative list).
  const LABEL_TO_KEY = {
    'New': 'new', 'Preparing': 'preparing', 'Ready for Pickup': 'ready_for_pickup',
    'Picked Up': 'picked_up', 'Ready': 'ready', 'Out for Delivery': 'out_for_delivery',
    'Delivered': 'delivered', 'Completed': 'completed', 'Cancelled': 'cancelled',
  };
  const stageKey = LABEL_TO_KEY[stage_label] || 'new';
  const tracking = getTrackingSteps(order_type, stageKey);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.card}>
        <Text style={styles.saleNumber}>{sale_number}</Text>
        {location_name && <Text style={styles.location}>{location_name}</Text>}

        {tracking ? (
          <View style={styles.stepsRow}>
            {tracking.steps.map((step, i) => (
              <React.Fragment key={step.label}>
                <View style={styles.stepItem}>
                  <View style={[
                    styles.stepDot,
                    step.done && styles.stepDotDone,
                    step.current && styles.stepDotCurrent,
                  ]} />
                  <Text style={[styles.stepLabel, step.current && styles.stepLabelCurrent]}>{step.label}</Text>
                </View>
                {i < tracking.steps.length - 1 && <View style={[styles.stepLine, step.done && styles.stepLineDone]} />}
              </React.Fragment>
            ))}
          </View>
        ) : (
          <View style={styles.cancelledBox}>
            <Text style={styles.cancelledText}>This order was cancelled.</Text>
          </View>
        )}

        {scheduled_date && (
          <Text style={styles.scheduled}>
            {order_type === 'delivery' ? 'Scheduled delivery: ' : 'Scheduled: '}
            {formatShopDateLabel(scheduled_date)}
            {scheduled_time ? `, ${formatTimeString(scheduled_time)}` : ''}
          </Text>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.lg, backgroundColor: Colors.background },
  container: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.lg, backgroundColor: Colors.background, minHeight: '100%' },
  card: { backgroundColor: Colors.surface, borderRadius: BorderRadius.lg, padding: Spacing.lg, width: '100%', maxWidth: 420 },
  saleNumber: { fontSize: FontSize.xl, fontWeight: '800', color: Colors.text, textAlign: 'center' },
  location: { fontSize: FontSize.sm, color: Colors.textLight, textAlign: 'center', marginTop: 4, marginBottom: Spacing.lg },
  notFoundTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, textAlign: 'center' },
  notFoundText: { fontSize: FontSize.md, color: Colors.textSecondary, textAlign: 'center', marginTop: Spacing.sm },
  stepsRow: { flexDirection: 'row', alignItems: 'flex-start', marginTop: Spacing.lg, flexWrap: 'wrap' },
  stepItem: { alignItems: 'center', width: 72 },
  stepDot: { width: 16, height: 16, borderRadius: 8, backgroundColor: Colors.border },
  stepDotDone: { backgroundColor: Colors.success },
  stepDotCurrent: { backgroundColor: Colors.primary, width: 20, height: 20, borderRadius: 10 },
  stepLabel: { fontSize: FontSize.xs, color: Colors.textLight, textAlign: 'center', marginTop: 6 },
  stepLabelCurrent: { color: Colors.primary, fontWeight: '700' },
  stepLine: { flex: 1, height: 2, backgroundColor: Colors.border, marginTop: 8, minWidth: 12 },
  stepLineDone: { backgroundColor: Colors.success },
  cancelledBox: { backgroundColor: Colors.errorLight, borderRadius: BorderRadius.md, padding: Spacing.md, marginTop: Spacing.lg },
  cancelledText: { color: Colors.error, fontWeight: '600', textAlign: 'center' },
  scheduled: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', marginTop: Spacing.lg },
});
```

- [ ] **Step 3: Babel-check**

Run: `node app/scripts/babel-check.js app/src/services/api.js app/src/screens/TrackingScreen.js`

- [ ] **Step 4: Commit**

```bash
git add app/src/services/api.js app/src/screens/TrackingScreen.js
git commit -m "Add TrackingScreen and api.getTrackingInfo"
```

---

### Task 3: `App.js` routing bypass

**Files:**
- Modify: `app/App.js`

**Interfaces:**
- Consumes: `TrackingScreen` (Task 2).

- [ ] **Step 1: Add the pathname check**

Current `app/App.js`:
```js
import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider } from './src/context/AuthContext';
import RootNavigator from './src/navigation/RootNavigator';

export default function App() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <RootNavigator />
        <StatusBar style="auto" />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
```

Replace with:
```js
import React from 'react';
import { Platform } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider } from './src/context/AuthContext';
import RootNavigator from './src/navigation/RootNavigator';
import TrackingScreen from './src/screens/TrackingScreen';

// Web-only: a customer opens this link from a WhatsApp message in their
// phone's browser, never inside the staff app itself (which has no
// comparable native deep link registered and doesn't need one). Checked
// BEFORE AuthProvider/RootNavigator ever mount — see
// docs/superpowers/specs/2026-09-11-customer-tracking-page-design.md §3 for
// why this is a full bypass rather than a route threaded through React
// Navigation's own linking config: this guarantees zero shared state with
// the authenticated app, not just "the login screen doesn't show."
function getTrackingToken() {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  const match = /^\/track\/([^/]+)$/.exec(window.location.pathname);
  return match ? match[1] : null;
}

export default function App() {
  const trackingToken = getTrackingToken();
  if (trackingToken) {
    return <TrackingScreen token={trackingToken} />;
  }

  return (
    <SafeAreaProvider>
      <AuthProvider>
        <RootNavigator />
        <StatusBar style="auto" />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
```

- [ ] **Step 2: Babel-check**

Run: `node app/scripts/babel-check.js app/App.js`

- [ ] **Step 3: Manual smoke check — do this on a real running web build, not just babel-check**

Start the app's web build. In a normal browser tab (already logged in), navigate to `http://localhost:<port>/track/1.deadbeefdeadbeefdeadbeefdeadbeef` (a made-up, invalid token) — confirm the tracking page's "We couldn't find this order" state renders, NOT the app's own login/dashboard. Then get a REAL token: log in as owner/staff, open any sale's detail (or query `GET /sales/:id` directly) to read its real `tracking_url`, and open that exact URL — confirm it renders the real order's sale number and step bar correctly. Critically, do this in a **private/incognito window with no existing session** at least once, to confirm a genuine first-time visitor never sees a login prompt.

- [ ] **Step 4: Commit**

```bash
git add app/App.js
git commit -m "Add web routing bypass for the public tracking page"
```

---

### Task 4: Share Tracking Link in Orders Inbox

**Files:**
- Modify: `app/src/screens/OrdersInboxScreen.js`

**Interfaces:**
- Consumes: `waLink(phone, message)`, `buildMessage(type, params)` from `app/src/utils/contact.js` (existing — `buildMessage('tracking_link', { sale_number, tracking_url })` is already a defined template, unused until now).

- [ ] **Step 1: Add the import**

In `app/src/screens/OrdersInboxScreen.js`, find the existing `import ContactButtons from '../components/orders/ContactButtons';` line and add directly after it:
```js
import { waLink, buildMessage } from '../utils/contact';
```

- [ ] **Step 2: Add the button next to `ContactButtons`**

Find the `actionsRow`'s `<ContactButtons ... />` in `renderItem` (the block reading `context={{ type: item.display_stage?.key === 'ready_for_pickup' ? ... }}`). Add a sibling button immediately after `ContactButtons`'s closing `/>`:
```jsx
{item.tracking_url && (item.customer_display_phone || item.customer_phone) && (
  <TouchableOpacity
    style={styles.shareLinkBtn}
    onPress={(e) => {
      e.stopPropagation();
      const phone = item.customer_display_phone || item.customer_phone;
      Linking.openURL(waLink(phone, buildMessage('tracking_link', { sale_number: item.sale_number, tracking_url: item.tracking_url })));
    }}
    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
  >
    <Ionicons name="link-outline" size={18} color={Colors.primary} />
  </TouchableOpacity>
)}
```
`Linking` needs importing from `react-native` if not already present in this file's top import line — check the existing `import { View, Text, StyleSheet, SectionList, TouchableOpacity, RefreshControl, ActivityIndicator, ScrollView } from 'react-native';` line and add `Linking` to it if missing. `Ionicons` is already imported.

- [ ] **Step 3: Add the style**

Add to the `StyleSheet.create` call, alongside the other small icon-button styles (near `pickerFallbackBtn`/`deadEndBtn`):
```js
shareLinkBtn: { width: 44, height: 44, borderRadius: BorderRadius.full, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.surfaceAlt },
```

- [ ] **Step 4: Babel-check**

Run: `node app/scripts/babel-check.js app/src/screens/OrdersInboxScreen.js`

- [ ] **Step 5: Manual smoke check**

Open Orders Inbox, confirm a small link icon appears next to Call/WhatsApp on any row with a usable customer phone, and confirm it's absent on a row with no usable phone (matching `ContactButtons`' own empty-render rule — never a dead button). Tap it, confirm WhatsApp opens with the correct number and a message containing the order number and a real, working tracking URL (paste that URL into a private browser tab to confirm it resolves to the correct order).

- [ ] **Step 6: Commit**

```bash
git add app/src/screens/OrdersInboxScreen.js
git commit -m "Add Share Tracking Link to Orders Inbox"
```

---

### Task 5: Full regression + live manual trace

**Files:** none (verification only)

- [ ] **Step 1: Run every regression script**

```bash
node app/scripts/verify-tracking-steps.js
node app/scripts/babel-check.js app/App.js app/src/screens/TrackingScreen.js app/src/services/api.js app/src/screens/OrdersInboxScreen.js app/src/utils/trackingSteps.js
node server/scripts/verify-tracking-token.js
```
All must pass clean before continuing. (`verify-tracking-token.js` already exists and is unrelated to this plan's own changes, but re-run it as a sanity check since this plan is the first consumer of that token system's actual output.)

- [ ] **Step 2: Live trace — the full loop, one real order**

As a counter_staff/owner user, find or create a real order in each of these states and, for each, tap Share Tracking Link on Orders Inbox and open the resulting link in a private/incognito browser tab (no session): (a) a `new`/pending pickup order — confirm "Order Received" is the current step; (b) a `preparing` order; (c) a `ready_for_pickup` or `ready`/`out_for_delivery` order; (d) a fully `completed`/`delivered`/`picked_up` order — confirm the LAST step shows as both done and current, not a blank/broken state; (e) a `cancelled` order — confirm the cancelled message shows, not a broken step bar. Confirm every one of these renders correctly with **no login prompt at any point**, and confirm an intentionally-mangled URL (change one character of a real token) shows the generic not-found message.

- [ ] **Step 3: Final commit (if Step 1-2 required any fix-up)**

If any check required a fix, commit it with a message describing exactly what regression check or trace step caught it. If everything passed on the first attempt, there's nothing to commit for this task.
