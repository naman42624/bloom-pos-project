# Orders Inbox Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `app/src/screens/OrdersInboxScreen.js` on top of the order-list-foundation toolkit — bounded search/filter/sort, date+register-session grouping, one-tap stage actions, and Call/WhatsApp/tracking-link contact icons — as the first real consumer of that toolkit's shipped interfaces.

**Architecture:** Two new small, independently-testable pieces (a pure day/session grouping utility, and a per-day wrapper component that owns its own `useRegisterSessions` call so React's hooks rules are respected when the number of days on screen varies) sit between the already-shipped foundation hooks/components and the screen itself. The screen is rewritten in three isolated passes — data layer, then grouped rendering, then row content — so each pass has its own clean test/verify cycle rather than one giant untestable rewrite.

**Tech Stack:** React Native (Expo), React Navigation. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-09-orders-inbox-redesign-design.md` (and the foundation spec/plan it builds on: `docs/superpowers/specs/2026-09-05-order-list-screens-redesign-design.md`, `docs/superpowers/plans/2026-09-05-order-list-foundation.md`).

## Global Constraints

- Default sort (`created_at DESC`) must never change unless the user explicitly picks "Urgent first" from `SortControl` — no screen may apply `sort=urgency` automatically.
- Session sub-grouping ("Today · Session 1 (...)") only renders when every order in the currently-loaded page shares one `location_id`. When the page mixes locations (an owner with no location filter), fall back to plain day grouping — no session sub-header, ever, for a mixed page. Never guess a location.
- Minimum 44×44pt tap target on every new interactive element, matching every component the foundation plan already shipped.
- This codebase has no screen-render test harness. Verification is `node scripts/babel-check.js <file>` (run from `app/`) for every touched/created file, `app/scripts/verify-*.js` (plain Node `assert`, no React) for pure logic, and a live manual trace through the running app for the final task — this is the first real render of the foundation toolkit, which the foundation plan's own final review flagged as the one place a bug could still be hiding.
- `route.params?.status` (the Dashboard's "Done" chip landing here pre-filtered) must keep working exactly as today, including re-syncing if the param arrives again while the screen is already mounted.
- The quick-links row (Pickup Orders / Deliveries), the secondary Customers FAB, and the primary Log Order FAB are unchanged — same role gates, same behavior, same styles.
- Derived groupings are computed fresh on every render from the currently-loaded page, never cached/stored across fetches (matches this project's "any derived/summary value must be computed fresh on every read" principle, already followed throughout the foundation work).

---

## Task 1: `extractShopDateKey` — shared shop-timezone date-bucketing key

**Files:**
- Modify: `app/src/utils/datetime.js` (add one new exported function; nothing existing changes)
- Test: `app/scripts/verify-order-grouping.js` (created in Task 2, which also exercises this function — see that task's Step 1)

**Interfaces:**
- Produces: `extractShopDateKey(value, timezone = DEFAULT_TZ)` → a `'YYYY-MM-DD'` string in the given timezone (defaults to shop timezone), or `''` for a falsy/unparseable input. Every later task's day-bucketing depends on this exact signature.

**Context:** `DeliveriesScreen.js` already has this exact logic as a local, unexported function (`extractLocalDate`, `DeliveriesScreen.js:46-55`) — duplicating it a third time (once more here) is exactly the kind of drift this whole foundation effort exists to stop. This task extracts one new shared export to `datetime.js` (which already holds every other shop-timezone helper) without touching `DeliveriesScreen.js` itself — that screen keeps its own local copy for now; deduping it is a natural follow-up for whenever that screen is next touched, not part of this plan's scope.

- [ ] **Step 1: Add the function**

In `app/src/utils/datetime.js`, add after `parseServerDate` (so it can use it):

```js
// Shared "which shop-local calendar day does this timestamp fall on" key —
// used for grouping (not display; use formatShopDateLabel for the
// human-readable "Today"/"Yesterday"/date label). Deliberately returns the
// raw YYYY-MM-DD string, not a Date, so it's a stable, comparable grouping
// key. See DeliveriesScreen.js's own local extractLocalDate for the
// pre-existing (unexported, not deduped by this change) equivalent.
export function extractShopDateKey(value, timezone = DEFAULT_TZ) {
  if (!value) return '';
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const d = parseServerDate(raw);
  if (d && !Number.isNaN(d.getTime())) {
    try {
      return d.toLocaleDateString('en-CA', { timeZone: timezone });
    } catch {
      // fall through to the raw-string fallback below
    }
  }
  return raw.split('T')[0] || '';
}
```

- [ ] **Step 2: Babel-check**

```bash
cd app && node scripts/babel-check.js src/utils/datetime.js
```

- [ ] **Step 3: Commit**

```bash
git add app/src/utils/datetime.js
git commit -m "Add extractShopDateKey shared date-bucketing helper to datetime.js"
```

(This task's own correctness is verified together with Task 2's test script, since `extractShopDateKey` has no real behavior worth testing in isolation from actual order timestamps — Task 2 exercises it directly.)

---

## Task 2: `orderGrouping.js` — pure day/session/location grouping logic

**Files:**
- Create: `app/src/utils/orderGrouping.js`
- Test: `app/scripts/verify-order-grouping.js`

**Interfaces:**
- Consumes: `extractShopDateKey` (Task 1), `matchSessionLabel` from `app/src/utils/registerSessions.js` (already shipped — signature: `matchSessionLabel(sessions, timestampStr) → string|null`), `formatShopDateLabel` from `datetime.js` (already shipped).
- Produces:
  - `getSingleLocationId(orders)` → the shared `location_id` if every order in `orders` has the same one, else `null`.
  - `groupOrdersByDay(orders)` → `[{ dateKey: 'YYYY-MM-DD', dateLabel: string, orders: [...] }]`, ordered by `dateKey` descending (most recent day first — matches the screen's existing most-recent-first convention), each `orders` array preserving the input's relative order within that day.
  - `groupOrdersBySession(dayOrders, sessions)` → `[{ sessionLabel: string|null, orders: [...] }]` — one entry per distinct `matchSessionLabel` result found among `dayOrders`, in the order each label was first encountered (so if session-matched orders and unmatched orders are interleaved by fetch order, the groups still come out in encounter order, not sorted — later tasks render whatever order this returns).

- [ ] **Step 1: Write the failing test**

Create `app/scripts/verify-order-grouping.js`:

```js
const assert = require('assert');
const { getSingleLocationId, groupOrdersByDay, groupOrdersBySession } = require('../src/utils/orderGrouping');
const { extractShopDateKey } = require('../src/utils/datetime');

// extractShopDateKey (Task 1) — exercised directly here since it has no
// other test of its own.
assert.strictEqual(extractShopDateKey('2026-09-05T10:30:00Z', 'Asia/Kolkata'), '2026-09-05', 'Expected a UTC morning timestamp to fall on the same shop-local day');
assert.strictEqual(extractShopDateKey('2026-09-05T20:30:00Z', 'Asia/Kolkata'), '2026-09-06', 'Expected a UTC evening timestamp (+5:30) to roll into the next shop-local day');
assert.strictEqual(extractShopDateKey(null), '', 'Expected null input to return empty string, not throw');
assert.strictEqual(extractShopDateKey(''), '', 'Expected empty string input to return empty string, not throw');
assert.strictEqual(extractShopDateKey('2026-09-05'), '2026-09-05', 'Expected an already-YYYY-MM-DD input to pass through unchanged');

// getSingleLocationId
assert.strictEqual(getSingleLocationId([{ location_id: 4 }, { location_id: 4 }]), 4, 'Expected the shared location_id when every order has the same one');
assert.strictEqual(getSingleLocationId([{ location_id: 4 }, { location_id: 7 }]), null, 'Expected null when orders span more than one location');
assert.strictEqual(getSingleLocationId([]), null, 'Expected null for an empty order list');
assert.strictEqual(getSingleLocationId([{ location_id: 4 }]), 4, 'Expected the single order\'s location_id for a one-order list');

// groupOrdersByDay
const dayOrders = [
  { id: 1, created_at: '2026-09-05T10:00:00Z' }, // shop-local 2026-09-05
  { id: 2, created_at: '2026-09-04T10:00:00Z' }, // shop-local 2026-09-04
  { id: 3, created_at: '2026-09-05T12:00:00Z' }, // shop-local 2026-09-05
];
const byDay = groupOrdersByDay(dayOrders);
assert.strictEqual(byDay.length, 2, `Expected 2 day groups, got ${byDay.length}`);
assert.strictEqual(byDay[0].dateKey, '2026-09-05', 'Expected the most recent day first');
assert.deepStrictEqual(byDay[0].orders.map((o) => o.id), [1, 3], 'Expected both 2026-09-05 orders in the first group, in original relative order');
assert.strictEqual(byDay[1].dateKey, '2026-09-04', 'Expected the older day second');
assert.strictEqual(typeof byDay[0].dateLabel, 'string' && byDay[0].dateLabel.length > 0, 'Expected a non-empty human date label');

// groupOrdersBySession — using two fake sessions on the same day
const sessions = [
  { id: 1, opening_time: '2026-09-05T03:32:00Z', closed_at: '2026-09-05T07:45:00Z' }, // 9:02am-1:15pm IST
  { id: 2, opening_time: '2026-09-05T08:30:00Z', closed_at: null }, // 2:00pm-now IST
];
const sessionOrders = [
  { id: 10, created_at: '2026-09-05T04:00:00Z' }, // falls in session 1
  { id: 11, created_at: '2026-09-05T09:00:00Z' }, // falls in session 2
  { id: 12, created_at: '2026-09-05T04:30:00Z' }, // falls in session 1
  { id: 13, created_at: '2026-09-01T04:00:00Z' }, // no matching session (different day's timestamp, matches nothing here)
];
const bySession = groupOrdersBySession(sessionOrders, sessions);
assert.strictEqual(bySession.length, 3, `Expected 3 session groups (session-1, session-2, unmatched), got ${bySession.length}`);
assert.deepStrictEqual(bySession[0].orders.map((o) => o.id), [10, 12], 'Expected both session-1 orders grouped together, in encounter order');
assert.deepStrictEqual(bySession[1].orders.map((o) => o.id), [11], 'Expected the session-2 order in its own group');
assert.strictEqual(bySession[2].sessionLabel, null, 'Expected the unmatched order to fall into a null-labeled group');
assert.deepStrictEqual(bySession[2].orders.map((o) => o.id), [13]);

// groupOrdersBySession with no sessions at all — every order falls into one null-labeled group
const noSessionResult = groupOrdersBySession(sessionOrders, []);
assert.strictEqual(noSessionResult.length, 1, 'Expected exactly one group when there are no sessions to match against');
assert.strictEqual(noSessionResult[0].sessionLabel, null);
assert.strictEqual(noSessionResult[0].orders.length, 4);

console.log('✅ order-grouping: all checks passed');
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd app && node scripts/verify-order-grouping.js
```

Expected: `Cannot find module '../src/utils/orderGrouping'`.

- [ ] **Step 3: Implement**

Create `app/src/utils/orderGrouping.js`:

```js
// Pure grouping logic for the Orders Inbox redesign — no React, no API
// calls, fully covered by app/scripts/verify-order-grouping.js. See
// docs/superpowers/specs/2026-09-09-orders-inbox-redesign-design.md §2.
const { extractShopDateKey, formatShopDateLabel } = require('./datetime');
const { matchSessionLabel } = require('./registerSessions');

// The shared location_id across every order in the list, or null if the
// list is empty or spans more than one location. Used to decide whether
// session sub-grouping is safe to attempt at all — session-matching only
// makes sense when every order on screen belongs to one location's
// register history (design doc §2: an owner viewing "All Locations" must
// never see a guessed session label).
function getSingleLocationId(orders) {
  if (!orders || orders.length === 0) return null;
  const first = orders[0].location_id;
  for (const o of orders) {
    if (o.location_id !== first) return null;
  }
  return first;
}

// Groups a flat, already-fetched order list by shop-local calendar day,
// most recent day first. Preserves each day's orders in their original
// relative order (the caller's own sort — urgency or recency — is not
// re-derived here).
function groupOrdersByDay(orders) {
  const byKey = new Map();
  for (const order of orders) {
    const key = extractShopDateKey(order.created_at);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(order);
  }
  return Array.from(byKey.entries())
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0)) // descending dateKey string compare
    .map(([dateKey, dayOrders]) => ({
      dateKey,
      dateLabel: formatShopDateLabel(dayOrders[0].created_at),
      orders: dayOrders,
    }));
}

// Groups one day's orders by which register session (per
// matchSessionLabel) each order's created_at falls into. Orders with no
// matching session (legacy data, or a day with no register activity) land
// in one group with sessionLabel: null. Groups come out in first-encounter
// order, not sorted — callers render whatever order comes back.
function groupOrdersBySession(dayOrders, sessions) {
  const order = [];
  const byLabel = new Map();
  for (const item of dayOrders) {
    const label = matchSessionLabel(sessions, item.created_at);
    if (!byLabel.has(label)) {
      byLabel.set(label, []);
      order.push(label);
    }
    byLabel.get(label).push(item);
  }
  return order.map((sessionLabel) => ({ sessionLabel, orders: byLabel.get(sessionLabel) }));
}

module.exports = { getSingleLocationId, groupOrdersByDay, groupOrdersBySession };
```

- [ ] **Step 4: Run the test again to verify it passes**

```bash
cd app && node scripts/verify-order-grouping.js
```

Expected: `✅ order-grouping: all checks passed`.

- [ ] **Step 5: Babel-check**

```bash
cd app && node scripts/babel-check.js src/utils/orderGrouping.js
```

- [ ] **Step 6: Commit**

```bash
git add app/src/utils/orderGrouping.js app/scripts/verify-order-grouping.js
git commit -m "Add pure day/session/location grouping logic for Orders Inbox"
```

---

## Task 3: `DaySessionSection` — per-day wrapper component

**Files:**
- Create: `app/src/components/orders/DaySessionSection.js`
- Test: babel-check + manual verification deferred to Task 5 (this component's first real render)

**Interfaces:**
- Consumes: `useRegisterSessions` (default export) from `app/src/hooks/useRegisterSessions.js` (signature: `useRegisterSessions(locationId, dateStr) → { sessions, loading }`), `groupOrdersBySession` (Task 2), `DateSessionHeader` (already shipped, props: `{ dateLabel, sessionLabel, totalAmount }`).
- Produces: `<DaySessionSection dateKey dateLabel orders locationId renderOrder />` — a component with no return value consumed by other tasks (it's a leaf UI piece), but its prop shape is load-bearing for Task 5, which renders one per day:
  - `dateKey: string`, `dateLabel: string`, `orders: array` — one day's worth, from `groupOrdersByDay` (Task 2).
  - `locationId: number|null` — from `getSingleLocationId` (Task 2); `null` means "skip session matching, render one plain day header."
  - `renderOrder: (order) => ReactNode` — render-prop for a single row, so this component has no opinion on row content (Task 6 changes row content without touching this file).

**Why this component exists, not inline logic in the screen:** `useRegisterSessions` is a real React hook, and the number of days on screen varies per fetch — hooks cannot be called in a loop or conditionally from the screen's own render body. Giving each day its own component instance means each one calls the hook exactly once, unconditionally, satisfying React's rules while still effectively "looping" one hook call per day from the screen's perspective.

- [ ] **Step 1: Implement**

Create `app/src/components/orders/DaySessionSection.js`:

```jsx
// One calendar day's worth of orders, optionally sub-grouped by register
// session. Exists specifically so each day gets its own useRegisterSessions
// hook call — see this task's own note in the implementation plan for why
// that can't be done from a loop in the parent screen. See design doc §2.
import React from 'react';
import { View } from 'react-native';
import useRegisterSessions from '../../hooks/useRegisterSessions';
import { groupOrdersBySession } from '../../utils/orderGrouping';
import DateSessionHeader from './DateSessionHeader';

export default function DaySessionSection({ dateKey, dateLabel, orders, locationId, renderOrder }) {
  // Only fetch sessions when we actually have one location to ask about —
  // useRegisterSessions itself already no-ops gracefully on a null/undefined
  // locationId (returns { sessions: [], loading: false }), but skip even
  // that no-op call's effect churn when we already know we won't use it.
  const { sessions } = useRegisterSessions(locationId || null, locationId ? dateKey : null);

  if (!locationId) {
    // Owner viewing "All Locations" (or any mixed-location page) — plain
    // day grouping only, per design doc §2. No session label, ever, for a
    // mixed page.
    return (
      <View>
        <DateSessionHeader dateLabel={dateLabel} sessionLabel={null} />
        {orders.map(renderOrder)}
      </View>
    );
  }

  const sessionGroups = groupOrdersBySession(orders, sessions);
  return (
    <View>
      {sessionGroups.map((group) => (
        <View key={group.sessionLabel || '_none'}>
          <DateSessionHeader dateLabel={dateLabel} sessionLabel={group.sessionLabel} />
          {group.orders.map(renderOrder)}
        </View>
      ))}
    </View>
  );
}
```

- [ ] **Step 2: Babel-check**

```bash
cd app && node scripts/babel-check.js src/components/orders/DaySessionSection.js
```

- [ ] **Step 3: Commit**

```bash
git add app/src/components/orders/DaySessionSection.js
git commit -m "Add DaySessionSection component (per-day register-session grouping)"
```

---

## Task 4: `OrdersInboxScreen.js` — swap the data layer to `useOrderListData`

**Files:**
- Modify: `app/src/screens/OrdersInboxScreen.js`

**Interfaces:**
- Consumes: `useOrderListData` (default export, `app/src/hooks/useOrderListData.js`) — signature confirmed from the shipped file: `useOrderListData(fetchFn, { pageSize }) → { items, loading, refreshing, error, total, hasMore, loadMore, refresh, search, setSearch, filters, setFilter, clearFilters, sort, setSort, activeFilterCount }`.

**Scope of this task only:** replace the screen's local `orders`/`statusFilter`/`channelFilter`/`priorityOnly`/`search`/`fetchOrders`/`searchRef`/`requestIdRef`/`searchTimer` state and logic with the hook — but keep the OLD flat `FlatList` rendering exactly as it is today for now (still calling the existing `renderItem`). This isolates "is the new data layer correct" from "does the new grouped rendering work," which Task 5 changes next. Toolbar/filter-drawer UI is also NOT wired yet — this task only proves the data layer; Task 5 replaces the search box and filter chip rows with `OrderListToolbar`/`FilterDrawer`/`ActiveFilterChips`.

- [ ] **Step 1: Replace the data-layer state and effects**

In `app/src/screens/OrdersInboxScreen.js`, replace lines 38-102 (from `const [orders, setOrders] = useState([]);` through the end of `clearSearch`) with:

```js
  const fetchFn = useCallback((params) => api.getSales(params).then((r) => ({ items: r.data.sales, total: r.data.total })), []);
  const list = useOrderListData(fetchFn, { pageSize: 50 });

  // Seeded from an incoming `status` param (the Dashboard's Done chip lands
  // here with { status: 'completed' }) so the inbox opens pre-filtered
  // instead of the tap just parking on an unfiltered "All" list. Re-syncs
  // if the screen was already mounted and a new status param arrives (e.g.
  // Done chip tapped again from Dashboard while Orders Inbox is still alive
  // in the stack) — setFilter below changes list.filters' identity, which
  // the useFocusEffect-driven refetch inside useOrderListData already
  // re-runs on, so no separate refetch call is needed here.
  useEffect(() => {
    if (route.params?.status !== undefined) list.setFilter('status', route.params.status || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.params?.status]);

  // [list.refresh], not [] — list.refresh's identity changes whenever
  // filters/sort/pageSize change (it depends on the hook's own runFetch),
  // so depending on it here is what makes a re-focus after a filter change
  // actually refetch with the CURRENT filters rather than replaying a
  // stale closure from first mount — the exact class of stale-closure bug
  // the foundation plan's Task 8 had to fix in this same hook.
  useFocusEffect(useCallback(() => { list.refresh(); }, [list.refresh]));
```

Also update the top-level import line to add the new hook:

```js
import useOrderListData from '../hooks/useOrderListData';
```

- [ ] **Step 2: Update the render body to read from `list` instead of the removed state**

The existing `FlatList` (currently referencing `orders`, `loading`, `refreshing`, `fetchOrders`) stays structurally the same for now, just reads from the hook's return value. Replace:

```jsx
      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={Colors.primary} />
      ) : (
        <FlatList
          data={orders}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderItem}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchOrders(); }} colors={[Colors.primary]} />}
          ListEmptyComponent={<Text style={styles.empty}>No orders match these filters.</Text>}
          contentContainerStyle={{ padding: Spacing.md }}
        />
      )}
```

with:

```jsx
      {list.loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={Colors.primary} />
      ) : (
        <FlatList
          data={list.items}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderItem}
          refreshControl={<RefreshControl refreshing={list.refreshing} onRefresh={list.refresh} colors={[Colors.primary]} />}
          ListEmptyComponent={<Text style={styles.empty}>{list.error || 'No orders match these filters.'}</Text>}
          contentContainerStyle={{ padding: Spacing.md }}
        />
      )}
```

Leave the existing search box and the two filter-chip `ScrollView`s in the JSX exactly as they are for this task — they still reference the now-removed `search`/`statusFilter`/`channelFilter`/`priorityOnly`/`handleSearchChange`/`clearSearch`, so **temporarily** wire them to the hook's equivalents so the file still compiles and works, ahead of Task 5 replacing this whole block with the toolkit components:

- `value={search}` → `value={list.search}`
- `onChangeText={handleSearchChange}` → `onChangeText={list.setSearch}`
- the clear-search `TouchableOpacity`'s `onPress={clearSearch}` → `onPress={() => list.setSearch('')}`
- `statusFilter === s` / `onPress={() => setStatusFilter(s)}` → `list.filters.status === s` / `onPress={() => list.setFilter('status', s || undefined)}`
- `channelFilter === c` / `onPress={() => setChannelFilter(c)}` → `list.filters.channel === c` / `onPress={() => list.setFilter('channel', c || undefined)}`
- `priorityOnly` / `onPress={() => setPriorityOnly((v) => !v)}` → `list.filters.priority === 'rush'` / `onPress={() => list.setFilter('priority', list.filters.priority === 'rush' ? undefined : 'rush')}`

- [ ] **Step 3: Babel-check**

```bash
cd app && node scripts/babel-check.js src/screens/OrdersInboxScreen.js
```

- [ ] **Step 4: Manual verification**

In the running app: open Orders Inbox, confirm the list loads (same orders as before), confirm a status filter chip still filters correctly, confirm search still works, confirm the Dashboard's "Done" chip still lands here pre-filtered to completed orders, confirm pull-to-refresh still works.

- [ ] **Step 5: Commit**

```bash
git add app/src/screens/OrdersInboxScreen.js
git commit -m "OrdersInboxScreen: swap local data-fetching state for useOrderListData"
```

---

## Task 5: `OrdersInboxScreen.js` — day/session grouping + toolbar/filter-drawer UI

**Files:**
- Modify: `app/src/screens/OrdersInboxScreen.js`

**Interfaces:**
- Consumes: `groupOrdersByDay`, `getSingleLocationId` (Task 2), `DaySessionSection` (Task 3), `OrderListToolbar`, `FilterDrawer`, `ActiveFilterChips`, `SortControl` (all already shipped — see the foundation plan for their exact prop shapes, already used identically here).

**Scope of this task:** replace the flat `FlatList` with day-grouped rendering, and replace the raw search box + two filter-chip rows with the toolkit's toolbar/drawer. Row content itself (the `renderItem` function's internals) is untouched here — Task 6 changes that.

- [ ] **Step 1: Add the new imports**

```js
import OrderListToolbar from '../components/orders/OrderListToolbar';
import FilterDrawer from '../components/orders/FilterDrawer';
import ActiveFilterChips from '../components/orders/ActiveFilterChips';
import DaySessionSection from '../components/orders/DaySessionSection';
import { groupOrdersByDay, getSingleLocationId } from '../utils/orderGrouping';
```

Remove the now-unused `ScrollView` and `TextInput` imports from the top-level `react-native` import line if nothing else in the file still uses them (check before removing — `ScrollView`/`TextInput` may still be referenced elsewhere in this file; if not, drop them from the import list).

- [ ] **Step 2: Add filter-drawer state and the day grouping**

Add near the top of the component body (after the `list` hook call from Task 4):

```js
  const [filtersOpen, setFiltersOpen] = useState(false);
  const dayGroups = groupOrdersByDay(list.items);
  const singleLocationId = getSingleLocationId(list.items);
```

- [ ] **Step 3: Replace the search box + two filter-chip rows with the toolkit**

Replace this whole block (the `<View style={styles.searchRow}>...</View>` and the two `<ScrollView horizontal ...>` blocks that follow it):

```jsx
      <OrderListToolbar
        search={list.search}
        onSearchChange={list.setSearch}
        placeholder="Search order #, customer, phone, item…"
        activeFilterCount={list.activeFilterCount}
        onOpenFilters={() => setFiltersOpen(true)}
        sortProps={{
          value: list.sort,
          onChange: list.setSort,
          options: [{ value: null, label: 'Recent' }, { value: 'urgency', label: 'Urgent first' }],
        }}
      />
      <ActiveFilterChips
        filters={list.filters}
        labels={{
          status: (v) => `Status: ${STATUS_LABELS[v] || v}`,
          channel: (v) => `Channel: ${v}`,
          priority: () => '🔥 Rush only',
        }}
        onRemove={(key) => list.setFilter(key, undefined)}
        onClearAll={list.clearFilters}
      />
      <FilterDrawer
        visible={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        onClearAll={list.clearFilters}
        sections={[
          {
            key: 'status',
            label: 'Status',
            value: list.filters.status,
            onChange: (v) => list.setFilter('status', v || undefined),
            options: STATUS_FILTERS.map((s) => ({ value: s, label: s ? STATUS_LABELS[s] : 'All' })),
          },
          {
            key: 'channel',
            label: 'Channel',
            value: list.filters.channel,
            onChange: (v) => list.setFilter('channel', v || undefined),
            options: CHANNEL_FILTERS.map((c) => ({ value: c, label: c || 'Any channel' })),
          },
          {
            key: 'priority',
            label: 'Rush',
            value: list.filters.priority,
            onChange: (v) => list.setFilter('priority', v || undefined),
            options: [{ value: undefined, label: 'All' }, { value: 'rush', label: '🔥 Rush only' }],
          },
        ]}
      />
```

Note `FilterDrawer`'s `sections[].options` use `value: undefined` for the "no filter" choice in each section (matching `list.filters`' own convention of an absent/undefined key meaning "off") — `FilterDrawer`'s own chip-active check (`section.value === opt.value`) already handles `undefined === undefined` correctly for the "All" chip showing selected when nothing is set.

- [ ] **Step 4: Replace the flat `FlatList` with day-grouped rendering**

Replace the `FlatList` block from Task 4, Step 2 with:

```jsx
      {list.loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={Colors.primary} />
      ) : dayGroups.length === 0 ? (
        <Text style={styles.empty}>{list.error || 'No orders match these filters.'}</Text>
      ) : (
        <FlatList
          data={dayGroups}
          keyExtractor={(day) => day.dateKey}
          renderItem={({ item: day }) => (
            <DaySessionSection
              dateKey={day.dateKey}
              dateLabel={day.dateLabel}
              orders={day.orders}
              locationId={singleLocationId}
              renderOrder={(order) => renderItem({ item: order })}
            />
          )}
          refreshControl={<RefreshControl refreshing={list.refreshing} onRefresh={list.refresh} colors={[Colors.primary]} />}
          contentContainerStyle={{ padding: Spacing.md }}
        />
      )}
```

`renderItem` is called as `renderItem({ item: order })` here to match its existing signature (`const renderItem = ({ item }) => {...}`, unchanged by this task) — `DaySessionSection`'s `renderOrder` prop is a plain function taking the order directly, so this is a one-line adapter, not a signature change to `renderItem` itself.

- [ ] **Step 5: Babel-check**

```bash
cd app && node scripts/babel-check.js src/screens/OrdersInboxScreen.js
```

- [ ] **Step 6: Manual verification**

In the running app: confirm orders now render grouped under day headers (and, if today's register has more than one session, under separate session sub-headers); confirm the Filters button opens the drawer, each section's chips reflect and change the right filter; confirm `ActiveFilterChips` shows a removable chip per active filter and "Clear all" works; confirm Sort defaults to "Recent" (today's behavior unchanged) and switching to "Urgent first" actually reorders the list; confirm a legacy/no-session order (if any exist in the dev data) renders under a plain day header with no session portion, not a broken one.

- [ ] **Step 7: Commit**

```bash
git add app/src/screens/OrdersInboxScreen.js
git commit -m "OrdersInboxScreen: day/session grouping and bounded filter toolbar"
```

---

## Task 6: `OrdersInboxScreen.js` — row content: location, time, next action, contact icons

**Files:**
- Modify: `app/src/screens/OrdersInboxScreen.js`

**Interfaces:**
- Consumes: `api.advanceOrder(nextAction)` (already shipped, `app/src/services/api.js`), `ContactButtons` (already shipped — props `{ contacts: [{label, phone}], context: {type, params} }`), `waLink`/`buildMessage` from `app/src/utils/contact.js` (already shipped, both plain exported functions).

**Scope of this task:** only the `renderItem` function's internals and its row styles change. Nothing from Tasks 4-5 is touched.

- [ ] **Step 1: Add the new imports**

```js
import ContactButtons from '../components/orders/ContactButtons';
import { waLink, buildMessage } from '../utils/contact';
import { Linking } from 'react-native'; // add to the existing react-native import line if not already there
```

- [ ] **Step 2: Add the stage-key-to-message-template mapping and the next-action handler**

Add near the top of the file, alongside the other constant maps (`STATUS_LABELS` etc.):

```js
// Only two of contact.js's message templates are specific to a stage; every
// other stage correctly falls back to buildMessage's own 'general_inquiry'
// default (no entry needed here for those). See design doc §4.
const STAGE_TO_MESSAGE_TYPE = { ready_for_pickup: 'order_ready_pickup', out_for_delivery: 'order_out_for_delivery' };
```

Add inside the component body, near `renderItem`:

```js
  const [advancingId, setAdvancingId] = useState(null);
  const handleAdvance = async (order) => {
    if (!order.display_stage?.nextAction) return;
    setAdvancingId(order.id);
    try {
      await api.advanceOrder(order.display_stage.nextAction);
      list.refresh();
    } catch (err) {
      Alert.alert('Order Update', err.message || 'Unable to update this order.');
    } finally {
      setAdvancingId(null);
    }
  };

  const handleShareTrackingLink = (order) => {
    const phone = order.customer_display_phone || order.customer_phone || order.receiver_display_phone;
    if (!phone || !order.tracking_url) return;
    const url = waLink(phone, buildMessage('tracking_link', { sale_number: order.sale_number, tracking_url: order.tracking_url }));
    Linking.canOpenURL(url).then((supported) => { if (supported) Linking.openURL(url); }).catch(() => {});
  };
```

Add `Alert` and `useState` (if not already imported) to the top-level imports — `useState` is already imported; add `Alert` to the `react-native` import line.

- [ ] **Step 3: Rewrite `renderItem`'s row content**

Replace the existing `renderItem` function's body with:

```jsx
  const renderItem = ({ item }) => {
    const itemsSummary = formatItemsSummary(item.items);
    const orderTypeLabel = ORDER_TYPE_LABELS[item.order_type] || item.order_type;
    const isUnpaid = item.payment_status && item.payment_status !== 'paid' && item.payment_status !== 'refunded';
    const nextAction = item.display_stage?.nextAction;
    const contacts = [
      { label: 'Customer', phone: item.customer_display_phone || item.customer_phone },
      { label: 'Recipient', phone: item.receiver_display_phone },
    ].filter((c) => c.phone);
    const canShareTracking = !!(item.tracking_url && contacts.length > 0);

    return (
      <TouchableOpacity style={styles.row} onPress={() => navigation.navigate('SaleDetail', { saleId: item.id })}>
        <Ionicons name={CHANNEL_ICONS[item.channel] || 'ellipse'} size={20} color={Colors.textSecondary} style={styles.channelIcon} />
        <View style={styles.rowMain}>
          <Text style={styles.saleNumber}>{item.sale_number}{item.priority === 'rush' ? '  🔥 Rush' : ''}</Text>
          <Text style={styles.customerName}>{item.customer_display_name || item.customer_name || 'Walk-in'} · {orderTypeLabel}</Text>
          {item.location_name && <Text style={styles.locationName}>{item.location_name}</Text>}
          {itemsSummary && <Text style={styles.itemsSummary} numberOfLines={1}>{itemsSummary}</Text>}
          {item.scheduled_date ? (
            <Text style={styles.scheduled}>📅 {formatCardDateTime(item.scheduled_date, item.scheduled_time)}</Text>
          ) : (
            <Text style={styles.scheduled}>{formatCardDateTime(item.created_at)}</Text>
          )}
          <View style={styles.rowActions}>
            {nextAction && (
              <TouchableOpacity
                style={styles.nextActionBtn}
                disabled={advancingId === item.id}
                onPress={(e) => { e.stopPropagation(); handleAdvance(item); }}
              >
                <Text style={styles.nextActionText}>{advancingId === item.id ? 'Updating…' : nextAction.label}</Text>
              </TouchableOpacity>
            )}
            {contacts.length > 0 && (
              <ContactButtons
                contacts={contacts}
                context={{ type: STAGE_TO_MESSAGE_TYPE[item.display_stage?.key] || 'general_inquiry', params: { sale_number: item.sale_number, location_name: item.location_name } }}
              />
            )}
            {canShareTracking && (
              <TouchableOpacity style={styles.shareBtn} onPress={(e) => { e.stopPropagation(); handleShareTrackingLink(item); }}>
                <Ionicons name="link-outline" size={18} color={Colors.textSecondary} />
              </TouchableOpacity>
            )}
          </View>
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
      </TouchableOpacity>
    );
  };
```

Note the `onPress={(e) => { e.stopPropagation(); ... }}` on the new inline buttons — required because the whole row is itself a `TouchableOpacity` navigating to `SaleDetail`; without stopping propagation, tapping the next-action button or a contact icon would also fire the row's own navigation.

- [ ] **Step 4: Add the new styles**

Add to the `StyleSheet.create` call:

```js
  locationName: { fontSize: FontSize.xs, color: Colors.textLight, marginTop: 2 },
  rowActions: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginTop: Spacing.sm },
  nextActionBtn: { backgroundColor: Colors.primary, borderRadius: BorderRadius.md, paddingHorizontal: Spacing.md, minHeight: 44, justifyContent: 'center', flexShrink: 1 },
  nextActionText: { color: Colors.white, fontWeight: '700', fontSize: FontSize.sm },
  shareBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: BorderRadius.full, backgroundColor: Colors.surfaceAlt },
```

- [ ] **Step 5: Babel-check**

```bash
cd app && node scripts/babel-check.js src/screens/OrdersInboxScreen.js
```

- [ ] **Step 6: Manual verification**

In the running app: confirm `location_name` renders on each row; confirm a row whose stage has a `nextAction` shows the button, tapping it advances the order and refreshes the list (and shows "Updating…" briefly, not a frozen button); confirm a row with no `nextAction` shows no button and no empty gap; confirm tapping Call/WhatsApp on a row where customer and recipient share one number acts immediately (no picker); confirm tapping on a row where they differ shows the two-line picker; confirm the Share Tracking Link icon only appears when `tracking_url` and at least one phone number exist, and tapping it opens WhatsApp pre-filled with the tracking link; confirm tapping any of these three inline controls does NOT also navigate to `SaleDetail`.

- [ ] **Step 7: Commit**

```bash
git add app/src/screens/OrdersInboxScreen.js
git commit -m "OrdersInboxScreen: add location, next-action, and Call/WhatsApp/tracking-link row actions"
```

---

## Task 7: Pagination, full regression, and final live trace

**Files:**
- Modify: `app/src/screens/OrdersInboxScreen.js`

- [ ] **Step 1: Add the Load More footer**

Add a footer to the `FlatList` from Task 5 (the day-grouped one):

```jsx
          ListFooterComponent={list.hasMore ? (
            <TouchableOpacity style={styles.loadMoreBtn} disabled={list.loading} onPress={list.loadMore}>
              <Text style={styles.loadMoreText}>{list.loading ? 'Loading…' : 'Load more'}</Text>
            </TouchableOpacity>
          ) : null}
```

Add the style:

```js
  loadMoreBtn: { alignItems: 'center', paddingVertical: Spacing.md, minHeight: 44, justifyContent: 'center' },
  loadMoreText: { color: Colors.primary, fontWeight: '600', fontSize: FontSize.sm },
```

- [ ] **Step 2: Babel-check**

```bash
cd app && node scripts/babel-check.js src/screens/OrdersInboxScreen.js
```

- [ ] **Step 3: Manual verification of pagination**

In the running app, with a filter/search active that returns more than 50 results (or temporarily note the total order count at Test Loc is well over 50, per the foundation plan's own regression runs): confirm "Load more" appears, tapping it appends the next page without duplicating or dropping rows, and it disappears once every order has loaded.

- [ ] **Step 4: Full regression pass**

Run the complete pure-function and syntax verification for everything this plan touched or depends on:

```bash
cd app
node scripts/verify-order-grouping.js
node scripts/verify-contact-utils.js
node scripts/verify-register-sessions.js
node scripts/babel-check.js src/utils/datetime.js src/utils/orderGrouping.js src/components/orders/DaySessionSection.js src/screens/OrdersInboxScreen.js
```

Expected: all pure-function scripts print their `✅` line, all babel-checks show `OK`.

- [ ] **Step 5: Final live trace through the whole redesigned screen**

Per the design doc §7, walk through each of these in the actual running app in one session, in order, confirming each works before moving to the next:
1. Open Orders Inbox — orders load, grouped by day (and by session where a single location and multiple sessions apply).
2. Search for a known order by phone number — result narrows correctly, debounced (no flicker per keystroke).
3. Open Filters, apply a Status filter — list narrows, `ActiveFilterChips` shows a removable "Status: X" chip, Filters button badge shows "1".
4. Remove that chip via its ✕ — list returns to unfiltered, badge disappears. (This is the exact scenario the foundation plan's final review found broken before its fix — confirm it's genuinely fixed here in a real render, not just in the hook's own isolated test.)
5. Switch Sort to "Urgent first" — a rush order (if one exists in the dev data; create one via `LogOrder` with rush priority if not) moves to the top regardless of recency. Switch back to "Recent" — order returns to plain recency.
6. Scroll to trigger "Load more" — confirm per Step 3 above.
7. Tap a row's `nextAction` button (find an order with one, e.g. a `preparing` walk_in) — order advances, list refreshes, the button's label/visibility updates to match the new stage.
8. Tap Call and WhatsApp on a row — confirm behavior per Task 6 Step 6's manual verification.
9. Tap Share Tracking Link on a row that has one — confirm WhatsApp opens pre-filled.
10. Confirm the quick-links row (Pickup Orders / Deliveries) and secondary Customers FAB still render exactly as before for an `employee`/`counter_staff` login, and do NOT render for an `owner`/`manager` login.
11. Navigate here from the Dashboard's "Done today" chip — confirm it still opens pre-filtered to completed orders.

- [ ] **Step 6: Commit**

```bash
git add app/src/screens/OrdersInboxScreen.js
git commit -m "OrdersInboxScreen: add Load More pagination footer"
```
