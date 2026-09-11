# Orders Inbox Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `OrdersInboxScreen.js` on the order-list-foundation toolkit (`useOrderListData`, `OrderListToolbar`, `FilterDrawer`, `ActiveFilterChips`, `ContactButtons`, `DateSessionHeader`) with real day/session grouping, a bounded filter UI, safe one-tap next-actions, and working pagination — plus the one backend fix and one small unrelated bug fix this redesign's own correctness depends on.

**Architecture:** A new bulk session-fetch hook (`useSessionsForDates`) and a set of pure grouping functions (`orderGrouping.js`) let the screen pre-compute `SectionList` sections synchronously before render — no per-day component, no hook called in a loop. `useOrderListData` owns fetching/search/filters/sort/pagination; the screen owns only grouping and row rendering. A pre-existing backend count-query bug (`GET /sales`) is fixed first since real pagination depends on it.

**Tech Stack:** Express.js + `pg` (backend fix only); Expo/React Native, React Navigation, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-09-orders-inbox-redesign-design.md` (revised after an Opus review — read §0 first, it explains what changed and why before reading the rest).

## Global Constraints

- Every derived/summary value is computed fresh on read, never stored (CLAUDE.md).
- Minimum 44×44pt tap targets on every touchable (staff-ux-checklist #7).
- User-visible errors are plain language, never a raw technical message (staff-ux-checklist #6) — use `showAlert` from `app/src/utils/alert.js`, never the raw `Alert.alert` (a documented no-op on the web build this shop runs).
- No offline-first / write-queue work (CLAUDE.md constraint 3) — a failed request just shows a retryable error.
- No schema changes in this plan — Task 4 is a query-logic fix only, touching no columns or tables.
- This codebase has no screen-render test harness. Verification per task is: `node app/scripts/babel-check.js <file>` for every touched/created frontend file, a plain-Node `assert` script for every new pure function, and (Task 4) a new backend regression check. Task 11 does a live manual trace through the running app as the final gate — this is not optional polish, it's the only check that exercises the real integration.
- Reuse existing exports rather than re-deriving logic: `resolvePreparerStep`/`resolveDeliverStep` from `app/src/components/orderBoard/OrderCard.js`, `matchSessionLabel` from `app/src/utils/registerSessions.js`, `normalizePhone`/`telLink`/`waLink`/`buildMessage` from `app/src/utils/contact.js`.

---

### Task 1: `extractShopDateKey` in `datetime.js`

**Files:**
- Modify: `app/src/utils/datetime.js`
- Test: `app/scripts/verify-shop-date-key.js` (new)

**Interfaces:**
- Produces: `export function extractShopDateKey(value)` — returns a `YYYY-MM-DD` string key in shop timezone (`Asia/Kolkata`) for any server timestamp, or `null` if `value` doesn't parse. Later tasks (Task 2's `groupOrdersByDay`) group orders by this key.

- [ ] **Step 1: Write the failing test**

Create `app/scripts/verify-shop-date-key.js`:
```js
const assert = require('assert');
const { extractShopDateKey } = require('../src/utils/datetime');

// A UTC timestamp that's late evening in India (UTC+5:30) still falls on
// the same India-local calendar day here — 2026-01-15T23:00:00Z is
// 2026-01-16 04:30 IST, so this is really testing the day AFTER, not a
// same-day edge case. Use one that actually straddles midnight IST:
// 2026-01-15T19:00:00Z = 2026-01-16T00:30 IST -> next day in shop time.
assert.strictEqual(extractShopDateKey('2026-01-15T19:00:00Z'), '2026-01-16');
// A timestamp safely mid-afternoon UTC is also safely mid-evening IST, same day.
assert.strictEqual(extractShopDateKey('2026-01-15T10:00:00Z'), '2026-01-15');
// Plain YYYY-MM-DD input (scheduled_date columns store this) round-trips.
assert.strictEqual(extractShopDateKey('2026-03-01'), '2026-03-01');
assert.strictEqual(extractShopDateKey(null), null);
assert.strictEqual(extractShopDateKey(''), null);
assert.strictEqual(extractShopDateKey('not-a-date'), null);

console.log('verify-shop-date-key: all assertions passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node app/scripts/verify-shop-date-key.js`
Expected: `TypeError: extractShopDateKey is not a function` (not exported yet).

- [ ] **Step 3: Write minimal implementation**

In `app/src/utils/datetime.js`, add near `getShopTodayStr` (reuses the exact same `en-CA` + `timeZone: DEFAULT_TZ` pattern that function and `formatDateLabel`/`isToday` already use to get a shop-local `YYYY-MM-DD` key — see those for precedent):

```js
/**
 * Shop-timezone YYYY-MM-DD key for grouping orders by calendar day,
 * regardless of device timezone. Returns null for an unparseable value —
 * callers (e.g. groupOrdersByDay) must handle that, not assume a string.
 */
export function extractShopDateKey(value) {
  const d = parseServerDate(value);
  if (!d) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: DEFAULT_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node app/scripts/verify-shop-date-key.js`
Expected: `verify-shop-date-key: all assertions passed`

- [ ] **Step 5: Babel-check and commit**

Run: `node app/scripts/babel-check.js app/src/utils/datetime.js`

```bash
git add app/src/utils/datetime.js app/scripts/verify-shop-date-key.js
git commit -m "Add extractShopDateKey for shop-timezone day grouping"
```

---

### Task 2: `orderGrouping.js` pure functions

**Files:**
- Create: `app/src/utils/orderGrouping.js`
- Test: `app/scripts/verify-order-grouping.js` (new)

**Interfaces:**
- Consumes: `extractShopDateKey` (Task 1), `matchSessionLabel(sessions, timestampStr)` from `app/src/utils/registerSessions.js`, `formatShopDateLabel(value)` from `datetime.js` (already exists).
- Produces:
  - `export function getSingleLocationId(orders)` → the one `location_id` shared by every order in the array, or `null` if the array is empty or spans more than one location.
  - `export function groupOrdersByDay(orders)` → `[{ dateKey, dateLabel, orders }]`, one entry per distinct `extractShopDateKey(order.created_at)`, in the order each key first appears in the input (the input is already `created_at DESC` from the server — this must not re-sort). An order whose `created_at` doesn't parse (`extractShopDateKey` returns `null`) is grouped under `dateKey: null, dateLabel: ''` rather than dropped.
  - `export function groupOrdersBySession(dayOrders, sessions)` → `[{ sessionLabel, orders }]`, splitting `dayOrders` (already narrowed to one day) by `matchSessionLabel(sessions, order.created_at)`, preserving input order within each group and group-first-appearance order overall. `sessionLabel: null` is a valid group (no register was open, or `sessions` is empty) — never drop these orders.
  - `export function sumGrandTotal(orders)` → `number`, the sum of `Number(o.grand_total) || 0` over the array; `0` for an empty array.

- [ ] **Step 1: Write the failing test**

Create `app/scripts/verify-order-grouping.js`:
```js
const assert = require('assert');
const { getSingleLocationId, groupOrdersByDay, groupOrdersBySession, sumGrandTotal } = require('../src/utils/orderGrouping');

// getSingleLocationId
assert.strictEqual(getSingleLocationId([]), null);
assert.strictEqual(getSingleLocationId([{ location_id: 1 }, { location_id: 1 }]), 1);
assert.strictEqual(getSingleLocationId([{ location_id: 1 }, { location_id: 2 }]), null);

// groupOrdersByDay — same day-straddling case as verify-shop-date-key
const orders = [
  { id: 1, created_at: '2026-01-16T10:00:00Z' }, // 2026-01-16 IST
  { id: 2, created_at: '2026-01-16T09:00:00Z' }, // 2026-01-16 IST
  { id: 3, created_at: '2026-01-15T10:00:00Z' }, // 2026-01-15 IST
  { id: 4, created_at: 'garbage' },              // unparseable -> null-key group
];
const days = groupOrdersByDay(orders);
assert.strictEqual(days.length, 3);
assert.strictEqual(days[0].dateKey, '2026-01-16');
assert.deepStrictEqual(days[0].orders.map((o) => o.id), [1, 2]);
assert.strictEqual(days[1].dateKey, '2026-01-15');
assert.deepStrictEqual(days[1].orders.map((o) => o.id), [3]);
assert.strictEqual(days[2].dateKey, null);
assert.deepStrictEqual(days[2].orders.map((o) => o.id), [4]);

// groupOrdersBySession
const sessions = [
  { opening_time: '2026-01-16T03:00:00Z', closed_at: '2026-01-16T08:00:00Z' }, // Session 1
  { opening_time: '2026-01-16T09:30:00Z', closed_at: null },                    // Session 2, still open
];
const dayOrders = [
  { id: 10, created_at: '2026-01-16T05:00:00Z' },  // falls in Session 1
  { id: 11, created_at: '2026-01-16T10:00:00Z' },  // falls in Session 2
  { id: 12, created_at: '2026-01-16T08:30:00Z' },  // gap between sessions -> null label
];
const bySession = groupOrdersBySession(dayOrders, sessions);
assert.strictEqual(bySession.length, 3);
assert.ok(bySession[0].sessionLabel.startsWith('Session 1'));
assert.deepStrictEqual(bySession[0].orders.map((o) => o.id), [10]);
assert.ok(bySession[1].sessionLabel.startsWith('Session 2'));
assert.deepStrictEqual(bySession[1].orders.map((o) => o.id), [11]);
assert.strictEqual(bySession[2].sessionLabel, null);
assert.deepStrictEqual(bySession[2].orders.map((o) => o.id), [12]);

// groupOrdersBySession with no sessions at all -> one null-label group, nothing dropped
const noSessions = groupOrdersBySession(dayOrders, []);
assert.strictEqual(noSessions.length, 1);
assert.strictEqual(noSessions[0].sessionLabel, null);
assert.strictEqual(noSessions[0].orders.length, 3);

// sumGrandTotal
assert.strictEqual(sumGrandTotal([]), 0);
assert.strictEqual(sumGrandTotal([{ grand_total: '100.50' }, { grand_total: 50 }, { grand_total: null }]), 150.5);

console.log('verify-order-grouping: all assertions passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node app/scripts/verify-order-grouping.js`
Expected: `Cannot find module '../src/utils/orderGrouping'`

- [ ] **Step 3: Write minimal implementation**

Create `app/src/utils/orderGrouping.js`:
```js
// Pure grouping logic for the Orders Inbox SectionList — no React/RN/api
// dependency, so it's directly requireable from a plain Node assert script
// (app/scripts/verify-order-grouping.js), matching the established pattern
// in app/src/utils/registerSessions.js and app/src/utils/contact.js.
// See docs/superpowers/specs/2026-09-09-orders-inbox-redesign-design.md §2.
const { extractShopDateKey, formatShopDateLabel } = require('./datetime');
const { matchSessionLabel } = require('./registerSessions');

function getSingleLocationId(orders) {
  if (!orders || orders.length === 0) return null;
  const first = orders[0].location_id;
  for (const o of orders) {
    if (o.location_id !== first) return null;
  }
  return first ?? null;
}

function groupOrdersByDay(orders) {
  const groups = [];
  const byKey = new Map();
  for (const order of orders || []) {
    const dateKey = extractShopDateKey(order.created_at);
    let group = byKey.get(dateKey);
    if (!group) {
      group = { dateKey, dateLabel: dateKey ? formatShopDateLabel(order.created_at) : '', orders: [] };
      byKey.set(dateKey, group);
      groups.push(group);
    }
    group.orders.push(order);
  }
  return groups;
}

function groupOrdersBySession(dayOrders, sessions) {
  const groups = [];
  const byLabel = new Map();
  for (const order of dayOrders || []) {
    const sessionLabel = matchSessionLabel(sessions, order.created_at);
    let group = byLabel.get(sessionLabel);
    if (!group) {
      group = { sessionLabel, orders: [] };
      byLabel.set(sessionLabel, group);
      groups.push(group);
    }
    group.orders.push(order);
  }
  return groups;
}

function sumGrandTotal(orders) {
  return (orders || []).reduce((sum, o) => sum + (Number(o.grand_total) || 0), 0);
}

module.exports = { getSingleLocationId, groupOrdersByDay, groupOrdersBySession, sumGrandTotal };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node app/scripts/verify-order-grouping.js`
Expected: `verify-order-grouping: all assertions passed`

- [ ] **Step 5: Babel-check and commit**

Run: `node app/scripts/babel-check.js app/src/utils/orderGrouping.js`

```bash
git add app/src/utils/orderGrouping.js app/scripts/verify-order-grouping.js
git commit -m "Add pure day/session grouping functions for Orders Inbox"
```

---

### Task 3: `useSessionsForDates` bulk session-fetch hook

**Files:**
- Create: `app/src/hooks/useSessionsForDates.js`

**Interfaces:**
- Consumes: `api.getRegisterSessions({ location_id, date })` (existing, returns `{ data: { sessions: [...] } }`, same call `useRegisterSessions.js` already makes for one day).
- Produces: `export default function useSessionsForDates(locationId, dateKeys)` → `{ sessionsByDate, loading }` where `sessionsByDate` is `{ [dateKey]: sessions[] }` covering every key in `dateKeys`. Task 7 calls this with the day-keys from `groupOrdersByDay`'s output and reads `sessionsByDate[day.dateKey]` for each day.

**Why this can't just call `useRegisterSessions` in a loop:** React's rules of hooks forbid calling a hook conditionally or inside a loop/varying-length list — and the number of distinct days on screen varies every fetch. This hook sidesteps that by calling the plain async function `api.getRegisterSessions` (not a hook) inside `Promise.all` inside a single `useEffect` — one hook call, however many days there are.

**Known, accepted limitation (already named in the spec, don't try to fix it here):** no caching across renders — every dependency change refetches. Deliberately simpler than `useRegisterSessions`'s module-level cache, to avoid inheriting that cache's own "never invalidates after a mid-shift register close/reopen" problem. Given this screen typically has only 1-3 distinct days loaded, refetching is cheap.

- [ ] **Step 1: Write the implementation**

Create `app/src/hooks/useSessionsForDates.js`:
```js
// Bulk multi-day register-session fetch for the Orders Inbox SectionList.
// See docs/superpowers/specs/2026-09-09-orders-inbox-redesign-design.md §2
// for why this is a separate hook from useRegisterSessions rather than that
// hook called in a loop (React's rules of hooks forbid that outright).
import { useState, useEffect } from 'react';
import api from '../services/api';

export default function useSessionsForDates(locationId, dateKeys) {
  const [sessionsByDate, setSessionsByDate] = useState({});
  const [loading, setLoading] = useState(false);
  // Array identity changes every render even with the same contents (a new
  // groupOrdersByDay() call each render) — join to a stable string so the
  // effect only re-runs when the actual set of days changes.
  const keysSignature = (dateKeys || []).join(',');

  useEffect(() => {
    const keys = keysSignature ? keysSignature.split(',') : [];
    if (!locationId || keys.length === 0) {
      setSessionsByDate({});
      return;
    }
    let cancelled = false;
    setLoading(true);
    Promise.all(
      keys.map((dateKey) =>
        api.getRegisterSessions({ location_id: locationId, date: dateKey })
          .then((res) => [dateKey, res.data?.sessions || []])
          .catch(() => [dateKey, []])
      )
    ).then((entries) => {
      if (cancelled) return;
      setSessionsByDate(Object.fromEntries(entries));
      setLoading(false);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId, keysSignature]);

  return { sessionsByDate, loading };
}
```

- [ ] **Step 2: Babel-check**

Run: `node app/scripts/babel-check.js app/src/hooks/useSessionsForDates.js`

- [ ] **Step 3: Commit**

```bash
git add app/src/hooks/useSessionsForDates.js
git commit -m "Add useSessionsForDates bulk session-fetch hook"
```

---

### Task 4: Backend fix — `GET /sales` total count must mirror the real query

**Files:**
- Modify: `server/routes/sales.js:246-317` (approximate; the exact block starts at the "Scope by location for non-owner roles" comment and ends after the existing `const { total } = await db.prepare(countSql).get(...countParams);` line)
- Test: `server/scripts/verify-order-flows.js` (add a check)

**Interfaces:**
- No new function — this changes `GET /sales`'s internal count computation. The route's response shape (`{ sales, total }`) is unchanged, only `total`'s correctness for `search`/`pickup_status`/non-owner-scoped requests.

**The bug, precisely:** the main query (built starting at line 177) applies `search` (line 223), `pickup_status` (line 212), and non-owner location-scoping (lines 247-253) among its filters. The separate `countSql` block built afterward (lines 302-316) re-implements `location_id`/`order_type`/`payment_status`/`status`/`channel`/`priority`/`date_from`/`date_to`/`filter_date` by hand, but omits `search`, `pickup_status`, and the non-owner location-scoping block entirely — so for any request using search, or any pickup_status filter, or made by a non-owner role with no explicit `location_id`, `total` comes back higher than the real number of matching rows. Today's screen never reads `total` (it silently caps at a fixed 100-row limit), so this has never been user-visible — but this plan's Task 9 (Load More) makes `hasMore = items.length < total` load-bearing, and it would be permanently `true` on exactly the flows staff use most (search, and any non-owner role).

**The fix:** snapshot the exact `sql`/`params` state right before `ORDER BY` is appended (they've already had every filter applied by that point, including the ones `countSql` was missing), and count via `SELECT COUNT(*) FROM (${snapshot}) as sub` instead of a hand-duplicated second query — the same pattern already used to fix the identical bug shape in `GET /deliveries` (see the foundation plan, `docs/superpowers/plans/2026-09-05-order-list-foundation.md`, Task 2).

- [ ] **Step 1: Write the failing test**

In `server/scripts/verify-order-flows.js`, add a check that creates (or reuses an existing helper that creates) two sales at Test Loc with `search`-matching content, one of which is `pickup_status = 'ready'`, then asserts `GET /sales?search=<term>&pickup_status=ready` returns a `total` equal to `sales.length` (not the unfiltered-by-those-two-params count). Match this file's existing style — read the top of the file for its request-helper and assertion conventions before writing this block, and append it near the other `GET /sales` checks. Concretely, structure it as:
```js
// Regression for the countSql/search+pickup_status desync bug (fixed
// alongside the Orders Inbox redesign, 2026-09-09): countSql previously
// omitted `search` and `pickup_status` entirely, so `total` came back
// higher than sales.length whenever either was used.
const searchTerm = `CountBugCheck${Date.now()}`;
const created = await createTestSale({ customer_name: searchTerm, pickup_status: 'ready' /* , other required fields per this file's existing createTestSale helper */ });
const res = await request(app).get(`/api/sales?search=${searchTerm}&pickup_status=ready`).set('Authorization', authHeader);
assert.strictEqual(res.body.total, res.body.sales.length, `total (${res.body.total}) must equal actual matching rows (${res.body.sales.length}) when search+pickup_status are both applied`);
```
Adjust helper/request names to match whatever this file already uses elsewhere (it has existing sale-creation and auth helpers — reuse them, don't add a second way to create a test sale).

- [ ] **Step 2: Run test to verify it fails**

Run: `node server/scripts/verify-order-flows.js`
Expected: the new assertion fails (`total` is higher than `sales.length`) while all pre-existing checks in the file still pass.

- [ ] **Step 3: Write the fix**

In `server/routes/sales.js`, right after the non-owner location-scoping block closes (currently ending at line 253, `}`) and before `if (sort === 'urgency') {` (currently line 255), add:
```js
    // Snapshot the fully-filtered query BEFORE ORDER BY/LIMIT/OFFSET are
    // appended below, so the count query is guaranteed to apply the exact
    // same filters as the real one — no second hand-written copy to drift
    // out of sync. Same fix pattern as GET /deliveries (foundation plan).
    const countBaseSql = sql;
    const countBaseParams = [...params];
```

Then replace the entire existing block (the comment `// Get total count for pagination` through the closing `const { total } = await db.prepare(countSql).get(...countParams);` line) with:
```js
    // Get total count for pagination — from the exact filtered query
    // snapshotted above, not a separately hand-written duplicate (see
    // comment at the snapshot site for why that broke `search`/
    // `pickup_status`/non-owner scoping).
    const { total } = await db.prepare(`SELECT COUNT(*) as total FROM (${countBaseSql}) as sub`).get(...countBaseParams);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node server/scripts/verify-order-flows.js`
Expected: all checks pass, including the new one.

- [ ] **Step 5: Commit**

```bash
git add server/routes/sales.js server/scripts/verify-order-flows.js
git commit -m "Fix GET /sales total count to mirror the real filtered query"
```

---

### Task 5: `OrdersInboxScreen.js` — swap data layer to `useOrderListData`

**Files:**
- Modify: `app/src/screens/OrdersInboxScreen.js`

**Interfaces:**
- Consumes: `useOrderListData(fetchFn, { pageSize })` from `app/src/hooks/useOrderListData.js` — returns `{ items, loading, refreshing, error, total, hasMore, loadMore, refresh, search, setSearch, filters, setFilter, clearFilters, sort, setSort, activeFilterCount }` (exact shape, already shipped — see that file).
- Produces: this task only replaces internal state; the screen's exported default and its `navigation`/`route` props are unchanged. Later tasks (6-9) build on the `list` object this task creates.

This task ONLY swaps the data layer — no visible UI change yet (still renders the old flat `FlatList`/old filter rows using the new hook's data). Keeping this separate from Tasks 6-8 means a broken data-layer swap is caught before any UI rework is layered on top of it.

- [ ] **Step 1: Replace state and fetch logic**

In `app/src/screens/OrdersInboxScreen.js`, replace the imports, the `fetchOrders`/`statusFilter`/`channelFilter`/`priorityOnly`/`search`/`searchRef`/`requestIdRef`/`searchTimer` state block, and the `useFocusEffect`/`route.params` effects with:
```js
import useOrderListData from '../hooks/useOrderListData';
// (keep existing imports: api, useAuth, theme, formatCardDateTime, StageBadge, etc. — Task 8 revisits which of these are still needed)

// ... inside the component, replacing all the old useState/useRef/fetchOrders:
const fetchFn = useCallback(
  (params) => api.getSales(params).then((res) => ({ items: res.data?.sales || [], total: res.data?.total || 0 })),
  []
);
const list = useOrderListData(fetchFn, { pageSize: 50 });

// Seeded from an incoming `status` param (the Dashboard's Done chip lands
// here with { status: 'completed' }) — same intent as the original file's
// comment, now driven through setFilter instead of local state.
useEffect(() => {
  if (route.params?.status !== undefined) list.setFilter('status', route.params.status || undefined);
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [route.params?.status]);

// list.refresh() depends on `filters` (and therefore, e.g., the status
// filter above) — so unlike the ORIGINAL file's fetchOrders (which only
// changed identity on an actual filter change), this refetches on every
// filter change too, in addition to every focus. That's a deliberate,
// accepted minor inefficiency (a double-fetch immediately after changing
// a filter while this screen has focus) — the alternative, freezing the
// dependency array to [], would replay a STALE list.refresh closure after
// any filter change, which is worse (silently ignores the new filter on
// next focus). Do not "fix" this by reverting to [].
useFocusEffect(useCallback(() => { list.refresh(); }, [list.refresh]));
```

- [ ] **Step 2: Wire the still-flat `FlatList` to the new data (temporary — Task 7 replaces this with a `SectionList`)**

Change the render's data source and loading/refresh wiring to read from `list` instead of the old local state:
```js
<FlatList
  data={list.items}
  keyExtractor={(item) => String(item.id)}
  renderItem={renderItem}
  refreshControl={<RefreshControl refreshing={list.refreshing} onRefresh={list.refresh} colors={[Colors.primary]} />}
  ListEmptyComponent={<Text style={styles.empty}>No orders match these filters.</Text>}
  contentContainerStyle={{ padding: Spacing.md }}
/>
```
Replace the `{loading ? <ActivityIndicator .../> : (...)}` wrapper's condition with `list.loading` in place of the old `loading` state. Leave the existing search box and filter-chip rows reading/writing `list.search`/`list.setSearch`/`list.filters.status`/`list.setFilter('status', ...)`/`list.filters.channel`/`list.setFilter('channel', ...)`/`list.filters.priority`/`list.setFilter('priority', ...)` in place of the old local state variables for now — Task 6 replaces this whole toolbar/filter block with `OrderListToolbar`+`FilterDrawer`+`ActiveFilterChips`, so a minimal renaming here (not a rewrite) is enough to keep the screen working end-to-end after this task.

- [ ] **Step 3: Babel-check**

Run: `node app/scripts/babel-check.js app/src/screens/OrdersInboxScreen.js`

- [ ] **Step 4: Manual smoke check**

Run the app, open Orders Inbox, confirm: the list loads, typing in search still filters (after the 300ms debounce `useOrderListData` owns internally), tapping a status/channel chip still filters, pull-to-refresh still works, navigating away and back still refetches.

- [ ] **Step 5: Commit**

```bash
git add app/src/screens/OrdersInboxScreen.js
git commit -m "Swap Orders Inbox data layer to useOrderListData"
```

---

### Task 6: `OrdersInboxScreen.js` — toolbar & filters redesign

**Files:**
- Modify: `app/src/screens/OrdersInboxScreen.js`
- Modify: `app/src/components/orders/OrderListToolbar.js` (add a search-clear button — see rationale below)

**Interfaces:**
- Consumes: `OrderListToolbar({ search, onSearchChange, activeFilterCount, onOpenFilters, sortProps, placeholder })`, `FilterDrawer({ visible, onClose, sections, onClearAll })`, `ActiveFilterChips({ filters, labels, onRemove, onClearAll })`, `SortControl` (via `sortProps`, already wired through `OrderListToolbar`) — all existing, unmodified interfaces except the one addition below.
- Produces: no new exports; this task only changes `OrdersInboxScreen.js`'s toolbar UI and adds one small feature to the shared `OrderListToolbar`.

**Why `OrderListToolbar.js` needs one small change here:** the original `OrdersInboxScreen.js` has a visible ✕ button that clears the search box (`clearSearch`, still present today) — `OrderListToolbar`'s search box has no equivalent, so adopting it as-is would silently regress a feature every staff member already has. Since this is shared toolkit code other screens (Deliveries, Pickup Orders) will also adopt, the fix belongs in the shared component, not a per-screen workaround.

- [ ] **Step 1: Add a clear button to `OrderListToolbar`**

In `app/src/components/orders/OrderListToolbar.js`, inside `styles.searchBox`, after the `TextInput`:
```jsx
{search && search.length > 0 && (
  <TouchableOpacity onPress={() => onSearchChange('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
    <Ionicons name="close-circle" size={18} color={Colors.textLight} />
  </TouchableOpacity>
)}
```
(Import already present: `Ionicons` is already imported in this file.)

- [ ] **Step 2: Babel-check the toolbar change**

Run: `node app/scripts/babel-check.js app/src/components/orders/OrderListToolbar.js`

- [ ] **Step 3: Replace `OrdersInboxScreen.js`'s search box + filter rows**

Remove the manual `searchRow` `View`/`TextInput`/clear-button block and the two `ScrollView` filter-chip rows for channel/priority (**keep the Status chip row exactly as it is** — the spec's §3 explicitly keeps Status as an always-visible one-tap row; only Channel/Rush/Order Type move into the drawer). Replace with:
```jsx
<OrderListToolbar
  search={list.search}
  onSearchChange={list.setSearch}
  activeFilterCount={list.activeFilterCount}
  onOpenFilters={() => setFiltersOpen(true)}
  sortProps={{
    value: list.sort,
    onChange: list.setSort,
    options: [{ value: null, label: 'Recent' }, { value: 'urgency', label: 'Urgent first' }],
  }}
  placeholder="Search order #, customer, phone, item…"
/>

<ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}>
  {STATUS_FILTERS.map((s) => (
    <TouchableOpacity key={s || 'all'} style={[styles.filterChip, (list.filters.status ?? null) === s && styles.filterChipSelected]} onPress={() => list.setFilter('status', s || undefined)}>
      <Text style={[styles.filterChipText, (list.filters.status ?? null) === s && styles.filterChipTextSelected]}>{s ? STATUS_LABELS[s] : 'All'}</Text>
    </TouchableOpacity>
  ))}
</ScrollView>

<ActiveFilterChips
  filters={{ channel: list.filters.channel, priority: list.filters.priority, order_type: list.filters.order_type }}
  labels={{
    channel: (v) => `Channel: ${v}`,
    priority: () => '🔥 Rush only',
    order_type: (v) => `Type: ${ORDER_TYPE_LABELS[v] || v}`,
  }}
  onRemove={(key) => list.setFilter(key, undefined)}
  onClearAll={() => { list.setFilter('channel', undefined); list.setFilter('priority', undefined); list.setFilter('order_type', undefined); }}
/>

<FilterDrawer
  visible={filtersOpen}
  onClose={() => setFiltersOpen(false)}
  onClearAll={() => { list.setFilter('channel', undefined); list.setFilter('priority', undefined); list.setFilter('order_type', undefined); setFiltersOpen(false); }}
  sections={[
    {
      key: 'channel', label: 'Channel', value: list.filters.channel ?? null,
      onChange: (v) => list.setFilter('channel', v || undefined),
      options: CHANNEL_FILTERS.map((c) => ({ value: c, label: c || 'Any channel' })),
    },
    {
      key: 'rush', label: 'Rush', value: list.filters.priority ?? null,
      onChange: (v) => list.setFilter('priority', v || undefined),
      options: [{ value: null, label: 'All orders' }, { value: 'rush', label: '🔥 Rush only' }],
    },
    {
      key: 'order_type', label: 'Order type', value: list.filters.order_type ?? null,
      onChange: (v) => list.setFilter('order_type', v || undefined),
      options: [null, 'walk_in', 'pickup', 'delivery', 'pre_order'].map((t) => ({ value: t, label: t ? (ORDER_TYPE_LABELS[t] || t) : 'All types' })),
    },
  ]}
/>
```

Note the `list.filters.status ?? null` / `list.filters.channel ?? null` pattern throughout — `FilterDrawer`'s own `section.value === opt.value` check does a strict comparison, so an unset filter (`undefined`) must be normalized to `null` here before being passed in, or the "All"/unset option would never visually highlight (this was a real bug the review caught in the first draft). Do this normalization at every `value:`/comparison site above, not just some of them.

Add near the top of the component, alongside existing imports: `import OrderListToolbar from '../components/orders/OrderListToolbar'; import FilterDrawer from '../components/orders/FilterDrawer'; import ActiveFilterChips from '../components/orders/ActiveFilterChips';` and one new piece of state: `const [filtersOpen, setFiltersOpen] = useState(false);`. Add `ORDER_TYPE_LABELS` to the constant declarations already at the top of the file if not already present (it already exists in the current file for a different purpose — reuse it, don't declare a second copy).

- [ ] **Step 4: Babel-check**

Run: `node app/scripts/babel-check.js app/src/screens/OrdersInboxScreen.js`

- [ ] **Step 5: Manual smoke check**

Confirm: Status chip row still visible and one-tap; tapping "Filters" opens the drawer with Channel/Rush/Order type sections; selecting a drawer option shows as a chip in `ActiveFilterChips` and is removable there; the search box's ✕ clears search; "Clear all" in both the drawer and the chip row clears channel/rush/order_type but leaves Status alone (matching the spec — Status isn't part of this "clear all").

- [ ] **Step 6: Commit**

```bash
git add app/src/screens/OrdersInboxScreen.js app/src/components/orders/OrderListToolbar.js
git commit -m "Rebuild Orders Inbox toolbar with FilterDrawer, keep Status as one-tap row"
```

---

### Task 7: `OrdersInboxScreen.js` — day/session/urgency `SectionList` grouping

**Files:**
- Modify: `app/src/screens/OrdersInboxScreen.js`

**Interfaces:**
- Consumes: `getSingleLocationId`, `groupOrdersByDay`, `groupOrdersBySession`, `sumGrandTotal` (Task 2), `useSessionsForDates` (Task 3), `DateSessionHeader({ dateLabel, sessionLabel, totalAmount })` (existing).
- Produces: replaces the plain `FlatList` from Task 5 with a real `SectionList`. Task 8 only changes `renderItem`'s content, not this task's section-building logic.

**Grouping rule (spec §2, confirmed with the user):** when `list.sort === 'urgency'`, render one flat section, no headers, in server order. Otherwise, group by day; within a day, sub-group by register session only when `getSingleLocationId(list.items)` finds every loaded order shares one location — never for a mixed "All Locations" view.

- [ ] **Step 1: Replace the `FlatList` with a `SectionList`**

Add the import: `import { SectionList } from 'react-native';` (alongside the existing `FlatList` import — Task 8/later cleanup can remove `FlatList` once nothing else uses it; check before removing).

Add, near the top of the component body (after `list` is created):
```js
const singleLocationId = useMemo(() => getSingleLocationId(list.items), [list.items]);
const dayGroups = useMemo(() => groupOrdersByDay(list.items), [list.items]);
const dateKeysNeedingSessions = useMemo(
  () => (singleLocationId ? dayGroups.map((d) => d.dateKey).filter(Boolean) : []),
  [singleLocationId, dayGroups]
);
const { sessionsByDate } = useSessionsForDates(singleLocationId, dateKeysNeedingSessions);

const sections = useMemo(() => {
  if (list.sort === 'urgency') {
    return [{ key: 'urgent', dateLabel: null, sessionLabel: null, data: list.items }];
  }
  const result = [];
  for (const day of dayGroups) {
    if (singleLocationId && day.dateKey) {
      const sessionGroups = groupOrdersBySession(day.orders, sessionsByDate[day.dateKey] || []);
      for (const sg of sessionGroups) {
        result.push({
          key: `${day.dateKey}:${sg.sessionLabel || '_none'}`,
          dateLabel: day.dateLabel,
          sessionLabel: sg.sessionLabel,
          data: sg.orders,
        });
      }
    } else {
      result.push({ key: day.dateKey || '_unknown', dateLabel: day.dateLabel, sessionLabel: null, data: day.orders });
    }
  }
  return result;
}, [list.items, list.sort, singleLocationId, dayGroups, sessionsByDate]);
```

Add `useMemo` to the React import at the top of the file.

Replace the `<FlatList ... />` block from Task 5 with:
```jsx
<SectionList
  sections={sections}
  keyExtractor={(item) => String(item.id)}
  renderItem={renderItem}
  renderSectionHeader={({ section }) =>
    section.key === 'urgent' ? null : (
      <DateSessionHeader
        dateLabel={section.dateLabel}
        sessionLabel={section.sessionLabel}
        totalAmount={sumGrandTotal(section.data)}
      />
    )
  }
  refreshControl={<RefreshControl refreshing={list.refreshing} onRefresh={list.refresh} colors={[Colors.primary]} />}
  ListEmptyComponent={<Text style={styles.empty}>No orders match these filters.</Text>}
  contentContainerStyle={{ padding: Spacing.md }}
  stickySectionHeadersEnabled={false}
/>
```

Add `import DateSessionHeader from '../components/orders/DateSessionHeader';` and `import useSessionsForDates from '../hooks/useSessionsForDates';` and `import { getSingleLocationId, groupOrdersByDay, groupOrdersBySession, sumGrandTotal } from '../utils/orderGrouping';`.

- [ ] **Step 2: Babel-check**

Run: `node app/scripts/babel-check.js app/src/screens/OrdersInboxScreen.js`

- [ ] **Step 3: Manual smoke check**

With default sort, single location (the normal case at this shop today): confirm day headers appear, and within "Today" a session sub-header appears if the register has been opened/closed more than once today (open/close it twice via Cash Register to force this, or trust a day with only one session shows just the date). Switch sort to "Urgent first": confirm all headers disappear and the list becomes one flat rush-first sequence. If testable (owner account with orders at 2+ locations and no `location_id` filter applied), confirm day headers appear with NO session sub-grouping in that mixed view.

- [ ] **Step 4: Commit**

```bash
git add app/src/screens/OrdersInboxScreen.js
git commit -m "Add day/session/urgency SectionList grouping to Orders Inbox"
```

---

### Task 8: `OrdersInboxScreen.js` — row redesign with safe next-action

**Files:**
- Modify: `app/src/screens/OrdersInboxScreen.js`

**Interfaces:**
- Consumes: `resolvePreparerStep({ order, tasks, viewerRole, viewerId })`, `resolveDeliverStep({ order })` — both already exported from `app/src/components/orderBoard/OrderCard.js` (referenced here for the underlying rule they encode, not called directly — see below); `ContactButtons({ contacts, context })` from `app/src/components/orders/ContactButtons.js`; `showAlert(title, message, buttons)` from `app/src/utils/alert.js`; `api.advanceOrder` (existing, same call `OrderCard.js` makes).
- Produces: the final row content and layout for this plan. No further task changes `renderItem`.

**The safety rule (spec §5), restated exactly:** render the inline next-action button only when firing it needs no extra input. Concretely: `nextAction` renders as a tappable button only when `nextAction.body?.status !== 'preparing'` AND `!nextAction.endpoint?.endsWith('/deliver')`. For those two excluded cases, render NOTHING in the action slot — the row's existing tap-to-`SaleDetail` navigation (already present) is the correct path, since that screen already has the full safe resolution UI (picking a preparer, collecting COD) built and reviewed. Do not attempt to replicate that modal here — this screen has no per-row `tasks` array to resolve `resolvePreparerStep` fully (the list endpoint only returns `open_task_count`), so a full inline resolution isn't possible here even if desired.

- [ ] **Step 1: Rewrite `renderItem`**

Replace the existing `renderItem` function with:
```jsx
const renderItem = ({ item }) => {
  const itemsSummary = formatItemsSummary(item.items);
  const orderTypeLabel = ORDER_TYPE_LABELS[item.order_type] || item.order_type;
  const isUnpaid = item.payment_status && item.payment_status !== 'paid' && item.payment_status !== 'refunded';
  const nextAction = item.display_stage?.nextAction;
  const needsResolution = nextAction && (nextAction.body?.status === 'preparing' || nextAction.endpoint?.endsWith('/deliver'));
  const showActionButton = nextAction && !needsResolution;

  const handleAdvance = async () => {
    try {
      // api.advanceOrder(nextAction) — NOT (id, nextAction). The sale id is
      // already baked into nextAction.endpoint (e.g. `/sales/${id}/status`);
      // passing an extra leading id argument would silently shift it into
      // advanceOrder's `extraBody` parameter instead. Matches every other
      // caller of this same helper (DashboardScreen.js, SaleDetailScreen.js,
      // OrderKanbanBoard.js) — none of them pass an id either.
      await api.advanceOrder(nextAction);
      list.refresh();
    } catch (err) {
      // err?.message, not err?.response?.data?.message — api.js's request()
      // throws a plain Error whose .message is already the server's plain-
      // language text; every other screen's catch (err) block reads it this
      // way (DashboardScreen.js is the clearest precedent).
      showAlert('Could not update this order', err?.message || 'Please try again, or open the order to see what it needs.');
    }
  };

  return (
    <TouchableOpacity style={styles.row} onPress={() => navigation.navigate('SaleDetail', { saleId: item.id })}>
      <View style={styles.rowTop}>
        <Ionicons name={CHANNEL_ICONS[item.channel] || 'ellipse'} size={20} color={Colors.textSecondary} style={styles.channelIcon} />
        <View style={styles.rowMain}>
          <Text style={styles.saleNumber}>{item.sale_number}{item.priority === 'rush' ? '  🔥 Rush' : ''}</Text>
          <Text style={styles.customerName}>{item.customer_display_name || item.customer_name || 'Walk-in'} · {orderTypeLabel}</Text>
          {item.location_name && <Text style={styles.locationName}>{item.location_name}</Text>}
          {itemsSummary && <Text style={styles.itemsSummary} numberOfLines={1}>{itemsSummary}</Text>}
          <Text style={styles.timeText}>{formatTime(item.created_at)}</Text>
          {item.scheduled_date && (
            <Text style={styles.scheduled}>📅 {formatCardDateTime(item.scheduled_date, item.scheduled_time)}</Text>
          )}
        </View>
        <View style={styles.rowSide}>
          <StageBadge stage={item.display_stage} size="sm" />
          <Text style={styles.amount}>{formatAmount(item.grand_total)}</Text>
          {isUnpaid && (
            <Text style={[styles.paymentBadge, { color: PAYMENT_STATUS_COLORS[item.payment_status] || Colors.error }]}>
              {item.payment_status === 'partial' ? 'Partly paid' : 'Unpaid'}
            </Text>
          )}
        </View>
      </View>
      <View style={styles.actionsRow}>
        {showActionButton ? (
          <TouchableOpacity style={styles.actionBtn} onPress={(e) => { e.stopPropagation(); handleAdvance(); }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={styles.actionBtnText}>{nextAction.label || 'Next step'}</Text>
          </TouchableOpacity>
        ) : <View style={{ flex: 1 }} />}
        <ContactButtons
          contacts={[
            { label: 'Customer', phone: item.customer_display_phone || item.customer_phone },
            { label: 'Recipient', phone: item.receiver_display_phone },
          ]}
          context={{
            type: item.display_stage?.key === 'ready_for_pickup' ? 'order_ready_pickup'
              : item.display_stage?.key === 'out_for_delivery' ? 'order_out_for_delivery'
              : 'general_inquiry',
            params: { sale_number: item.sale_number, location_name: item.location_name },
          }}
        />
      </View>
    </TouchableOpacity>
  );
};
```

Add imports: `import { formatTime } from '../utils/datetime';` (alongside the existing `formatCardDateTime` import — combine into one import line from `'../utils/datetime'`), `import { showAlert } from '../utils/alert';`, `import ContactButtons from '../components/orders/ContactButtons';`.

Before finalizing, read `server/utils/order-stage.js` to confirm `display_stage.nextAction`'s real field names (`label`/`endpoint`/`body`) and `display_stage.key`'s real values for the ready-for-pickup/out-for-delivery cases — this plan's names are carried over from earlier investigation of `resolvePreparerStep`/`resolveDeliverStep` and `OrderCard.js`'s own `handlePrimaryPress`/`nextAction` usage; if there's any mismatch, `OrderCard.js`'s existing usage is the ground truth to match, not this plan's prose.

- [ ] **Step 2: Add the error-visibility fix**

Add, directly above the `SectionList` (or the loading spinner, whichever renders first), so a failed background refresh is never silently invisible even when `list.items` already has content:
```jsx
{list.error && (
  <View style={styles.errorBanner}>
    <Text style={styles.errorBannerText}>{list.error}</Text>
  </View>
)}
```

- [ ] **Step 3: Add new styles**

Add to the `StyleSheet.create` call: `rowTop: { flexDirection: 'row', alignItems: 'flex-start' }`, `locationName: { fontSize: FontSize.xs, color: Colors.textLight, marginTop: 2 }`, `timeText: { fontSize: FontSize.xs, color: Colors.textLight, marginTop: 2 }`, `actionsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: Spacing.sm, paddingTop: Spacing.sm, borderTopWidth: 1, borderTopColor: Colors.border }`, `actionBtn: { backgroundColor: Colors.primary, borderRadius: BorderRadius.md, paddingVertical: Spacing.sm, paddingHorizontal: Spacing.md, minHeight: 44, justifyContent: 'center' }`, `actionBtnText: { color: Colors.white, fontWeight: '600', fontSize: FontSize.sm }`, `errorBanner: { backgroundColor: Colors.error + '15', padding: Spacing.sm, marginHorizontal: Spacing.md, borderRadius: BorderRadius.md }`, `errorBannerText: { color: Colors.error, fontSize: FontSize.sm }`. The existing `row` style's `alignItems: 'flex-start'` moves onto the new `rowTop` — change `row` itself to `{ backgroundColor: Colors.surface, borderRadius: BorderRadius.lg, padding: Spacing.md, marginBottom: Spacing.sm }` (drop `flexDirection: 'row'` and `alignItems` from it, since it now wraps `rowTop` + `actionsRow` vertically).

- [ ] **Step 4: Babel-check**

Run: `node app/scripts/babel-check.js app/src/screens/OrdersInboxScreen.js`

- [ ] **Step 5: Manual smoke check — this is the safety-critical check, do not skip**

Find or create a COD delivery order whose `display_stage.nextAction` would be "Mark Delivered" (i.e. `resolveDeliverStep` would return `kind: 'collect_cod'` because `cod_amount > cod_collected`). Confirm the row shows NO inline action button for that order (only Contact buttons) — tapping the row still opens `SaleDetailScreen`, where the real "Mark Delivered" flow correctly prompts for COD collection. Separately, find/create an order whose next action is safe (e.g. "Confirm Pickup" with nothing outstanding) and confirm tapping the inline button actually advances it and refreshes the list. Also verify a `preparing`-stage order with unassigned tasks shows no inline button, matching the same rule.

- [ ] **Step 6: Commit**

```bash
git add app/src/screens/OrdersInboxScreen.js
git commit -m "Redesign Orders Inbox row: location, time, safe next-action, contacts"
```

---

### Task 9: `OrdersInboxScreen.js` — pagination

**Files:**
- Modify: `app/src/screens/OrdersInboxScreen.js`

**Interfaces:**
- Consumes: `list.hasMore`, `list.loadMore`, `list.loading` (existing, from `useOrderListData`).

This task depends on Task 4's backend fix to actually work correctly under search/non-owner-location views — without it, `hasMore` would already be wrong on exactly those flows before this task even runs.

- [ ] **Step 1: Add a `ListFooterComponent`**

Add to the `SectionList` from Task 7:
```jsx
ListFooterComponent={
  list.hasMore ? (
    <TouchableOpacity style={styles.loadMoreBtn} onPress={list.loadMore} disabled={list.loading}>
      {list.loading ? <ActivityIndicator color={Colors.primary} /> : <Text style={styles.loadMoreText}>Load more</Text>}
    </TouchableOpacity>
  ) : null
}
```

Add style: `loadMoreBtn: { alignItems: 'center', paddingVertical: Spacing.md, minHeight: 44, justifyContent: 'center' }`, `loadMoreText: { color: Colors.primary, fontWeight: '600' }`.

- [ ] **Step 2: Babel-check**

Run: `node app/scripts/babel-check.js app/src/screens/OrdersInboxScreen.js`

- [ ] **Step 3: Manual smoke check**

With more than 50 orders at Test Loc (the shop's real data likely already has this — confirm via `list.total` if needed), scroll to the bottom, confirm "Load more" appears, tap it, confirm more rows append without resetting scroll position or duplicating existing rows. Repeat with an active search term that still matches more than 50 rows if possible — this is the exact flow Task 4 fixed.

- [ ] **Step 4: Commit**

```bash
git add app/src/screens/OrdersInboxScreen.js
git commit -m "Add Load more pagination to Orders Inbox"
```

---

### Task 10: Fix the `wa.me` double-country-code-prefix bug (separate, self-contained)

**Files:**
- Modify: `app/src/components/orderBoard/OrderCard.js:473`
- Modify: `app/src/screens/SettlementsScreen.js:306`

**Interfaces:**
- Consumes: `waLink(phone, message)`, `buildMessage(type, params)` from `app/src/utils/contact.js` (already exported, already used correctly by `ContactButtons.js`).

**The bug:** both sites build `` `https://wa.me/91${phone}?text=...` `` directly from whatever is in the phone field, with no normalization. If that field already contains a leading `91` or `+91` (as raw phone data in this app sometimes does), the result is `wa.me/91919876543210` — WhatsApp opens with no valid chat rather than the intended contact. `contact.js`'s `waLink` already does this correctly (it calls `normalizePhone` first, which strips an existing `91` prefix before `waLink` adds exactly one back) — these two sites predate that fix and were never migrated to use it.

- [ ] **Step 1: Fix `OrderCard.js`**

Add the import (alongside this file's existing imports): `import { waLink, buildMessage } from '../../utils/contact';`

Replace line 473:
```js
Linking.openURL(`https://wa.me/91${contactPhone}?text=${encodeURIComponent(`Hi, this is about your order ${order.sale_number}`)}`);
```
with:
```js
Linking.openURL(waLink(contactPhone, buildMessage('general_inquiry', { sale_number: order.sale_number })));
```
(This produces the identical message text as before — `buildMessage('general_inquiry', ...)`'s template in `contact.js` is `` `Hi, this is about your order ${p.sale_number}.` ``, matching the inline string here — only the phone-number handling changes.)

- [ ] **Step 2: Fix `SettlementsScreen.js`**

Add the import: `import { waLink } from '../utils/contact';` (this file builds its own message text with plural/singular handling `buildMessage`'s `rider_handoff` template doesn't currently do byte-for-byte — keep the existing local `msg` construction, only replace the URL-building line, not the message text, to avoid an unrelated wording change).

Replace line 306:
```js
Linking.openURL(`https://wa.me/91${partner.partner_phone}?text=${encodeURIComponent(msg)}`);
```
with:
```js
Linking.openURL(waLink(partner.partner_phone, msg));
```

- [ ] **Step 3: Babel-check both files**

Run: `node app/scripts/babel-check.js app/src/components/orderBoard/OrderCard.js app/src/screens/SettlementsScreen.js`

- [ ] **Step 4: Manual smoke check**

Find a contact/partner whose stored phone number already includes a `91`/`+91` prefix (or temporarily edit one in the dev DB), tap WhatsApp from an `OrderCard` and from a Settlements partner card, confirm the deep link opens the correct chat (`wa.me/91XXXXXXXXXX`, exactly one `91`) rather than a broken double-prefixed number.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/orderBoard/OrderCard.js app/src/screens/SettlementsScreen.js
git commit -m "Fix wa.me double-country-code-prefix bug in OrderCard and Settlements"
```

---

### Task 11: Full regression + live manual trace

**Files:** none (verification only)

- [ ] **Step 1: Run every regression script**

```bash
node server/scripts/verify-order-flows.js
node server/scripts/verify-register-expenses.js
node server/scripts/verify-identity-roles.js
node app/scripts/verify-shop-date-key.js
node app/scripts/verify-order-grouping.js
node app/scripts/babel-check.js app/src/screens/OrdersInboxScreen.js app/src/hooks/useSessionsForDates.js app/src/utils/orderGrouping.js app/src/utils/datetime.js app/src/components/orders/OrderListToolbar.js app/src/components/orderBoard/OrderCard.js app/src/screens/SettlementsScreen.js
```
All must pass clean before continuing.

- [ ] **Step 2: Live trace — counter_staff account**

Log in as a `counter_staff`/`employee` user. Open Orders Inbox. Confirm, in order: (a) day/session headers show correctly for today's orders; (b) tapping "Urgent first" collapses to a flat rush-first list with no headers, and switching back to "Recent" restores grouping; (c) Status chip row still one-tap; (d) Filters drawer opens, Channel/Rush/Order type all filter correctly, chips appear in `ActiveFilterChips` and are individually removable; (e) search filters and its ✕ clears it; (f) a safe next-action order's inline button advances it; (g) a COD-delivery or unassigned-preparer order shows no inline button and opens `SaleDetail` correctly on tap; (h) Call/WhatsApp buttons open the correct contact; (i) scrolling to the bottom with 50+ matching orders shows a working "Load more"; (j) the quick-links row (Pickup Orders/Deliveries) and both FABs are unchanged.

- [ ] **Step 3: Live trace — owner account, "All Locations"**

If more than one location has live data: confirm day headers show with NO session sub-grouping, and that `location_name` is visible on each row (this is the case today's screen couldn't show at all).

- [ ] **Step 4: Confirm no regression in the two touched-but-not-owned files**

Open an `OrderCard` (Dashboard/Kanban) and the Settlements screen; confirm both still render and behave exactly as before Task 10 aside from the WhatsApp link fix itself.

- [ ] **Step 5: Final commit (if Steps 1-4 required any fix-up)**

If any check required a fix, commit it with a message describing exactly what regression check or trace step caught it. If everything passed on the first attempt, there's nothing to commit for this task.
