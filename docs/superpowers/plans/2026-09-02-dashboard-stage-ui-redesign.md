# Dashboard Stage UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `display_stage` the single status vocabulary every order screen renders, on a unified Stage board that uses the full width of the viewport and never leaves a card without a way forward.

**Architecture:** `computeOrderStage()` already emits `{key,label,color,nextAction}` per order and the server already attaches it to `GET /sales`. This plan is almost entirely client-side: group the board by `display_stage.key` instead of by order type, render `label`/`color` through one shared `StageBadge` component, and treat `nextAction: null` as "route to the screen that can resolve this" rather than "render nothing". Backend work is limited to two additive response-shape changes and one guard fix.

**Tech Stack:** Expo (React Native) + React Navigation on the frontend; Express + `pg` on the backend. No TypeScript, no NativeWind. Existing `constants/theme.js` tokens only.

**Spec:** `docs/superpowers/specs/2026-09-01-dashboard-stage-ui-redesign-design.md`

## Global Constraints

- **Live production data.** Additive-only. This plan adds **no column, no table, no migration**. If a task seems to need one, stop and escalate — read `.claude/skills/db-migration-safety` first.
- **`display_stage` is never stored.** It is computed fresh per request in `server/utils/order-stage.js`. Never persist it, never cache it across requests.
- **Test Loc is `location_id = 4`.** Never touch Main Shop, `location_id = 1`.
- **There is no automated test runner in this project.** Do not create one. TDD in the pytest/jest sense is unavailable. The established, only verification method is: the babel check (Task 1), `server/scripts/verify-identity-roles.js` (expect 10/10), and live curl + on-screen tracing against the dev server. Each task below states its own concrete verification.
- **Staff UX rules** (`.claude/skills/staff-ux-checklist`): plain language in every user-visible string, no jargon, no hidden gestures, large tap targets, and never a dead end — if an action is blocked, the screen says what to do instead.
- **Roles.** `counter_staff` and `florist_staff` coexist with the legacy `employee` role indefinitely. Any role list must include all three unless there is a stated reason not to.
- **Do not touch** `DashboardScreenV2.js` or the `pref_new_v2_ui` flag. It stays as reference (spec §2, §13).
- **Do not touch** `ProductionQueueScreen.js` (spec §13, deferred).

---

### Task 1: Pre-order completion guard + the babel check script

Ships first and alone. It is a live money-and-data-integrity fix that shares no code with the UI work, and Task 8's UI depends on the corrected behaviour existing.

**Files:**
- Modify: `server/routes/sales.js:2267-2288`
- Create: `app/scripts/babel-check.js`

**Interfaces:**
- Produces: `node scripts/babel-check.js <files...>` run from `app/` — the verification command every later task uses.

- [ ] **Step 1: Read the two guards as they stand**

```bash
sed -n '2266,2290p' server/routes/sales.js
```

Both currently key on `order_type`, so a `pre_order` fulfilled by delivery or pickup bypasses each:

```js
if (status === 'completed' && sale.order_type === 'delivery') { ... }
if (status === 'completed' && sale.order_type === 'pickup') { ... }
```

- [ ] **Step 2: Widen the delivery guard**

Replace the `if` condition on the delivery guard (currently at `:2268`) so it fires for any order that actually has a delivery attached, regardless of `order_type`:

```js
      // ── Enforce delivery completion before marking order 'completed' ──
      // Keyed on "does this sale have a delivery row", NOT on order_type: a
      // pre_order fulfilled by delivery bypassed this guard entirely and could
      // be one-tap completed with a rider still holding the flowers
      // (2026-09-02). order_type === 'delivery' is a subset of that condition,
      // so this is strictly wider than what it replaces.
      if (status === 'completed') {
        const delivery = db.prepare("SELECT status FROM deliveries WHERE sale_id = ? LIMIT 1").get(sale.id);
        if (delivery && !['delivered', 'cancelled'].includes(delivery.status)) {
          return res.status(400).json({
            success: false,
            message: `Cannot complete — this order's delivery is still '${delivery.status}'. Mark the delivery as delivered first.`,
          });
        }
      }
```

Note `'cancelled'` is included alongside `'delivered'`: a cancelled delivery must not block completing the sale, and the previous narrower guard had the same latent issue.

- [ ] **Step 3: Widen the pickup guard**

Replace the pickup guard (currently at `:2279`) so the balance-due check applies to any non-delivery order being completed:

```js
      // ── Enforce payment before marking a non-delivery order 'completed' ──
      // Was `order_type === 'pickup'`, so a pre_order fulfilled by pickup could
      // be completed with money still owed (2026-09-02). Deliveries are excluded
      // because COD is collected by the rider at the door and reconciled through
      // settlements — a delivery legitimately completes with balance outstanding.
      if (status === 'completed' && sale.order_type !== 'delivery') {
        const totalPaid = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE sale_id = ?').get(sale.id).total;
        const balanceDue = sale.grand_total - totalPaid;
        if (balanceDue > 0.01 && !sale.is_credit_sale) {
          return res.status(400).json({
            success: false,
            message: `Cannot complete — ₹${balanceDue.toFixed(2)} is still due. Please collect payment first.`,
          });
        }
      }
```

- [ ] **Step 4: Create the babel check script**

The command recorded in earlier sessions (`npx babel --presets babel-preset-expo`) does **not** work — the preset fails to resolve through `npx` and every file reports a false `SyntaxError`. Verified working form, committed so every later task uses one command:

```js
#!/usr/bin/env node
// app/scripts/babel-check.js
//
// Syntax/transform check for frontend files. This project has no test runner
// and no linter wired up; this is the closest thing to a compile step and is
// the established gate before committing any frontend change.
//
// Run from the `app/` directory:
//   node scripts/babel-check.js src/components/Foo.js src/screens/Bar.js
//
// NOTE: `npx babel --presets babel-preset-expo <file>` does NOT work here —
// the preset does not resolve through npx and every file reports a bogus
// SyntaxError. Go through the Node API, as below.
const babel = require('@babel/core');

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node scripts/babel-check.js <file...>');
  process.exit(2);
}

let failed = 0;
for (const file of files) {
  try {
    babel.transformFileSync(file, {
      presets: [require.resolve('babel-preset-expo')],
      babelrc: false,
      configFile: false,
    });
    console.log('OK   ' + file);
  } catch (err) {
    failed++;
    console.log('FAIL ' + file + ' :: ' + err.message.split('\n')[0]);
  }
}
process.exit(failed ? 1 : 0);
```

- [ ] **Step 5: Verify the script works**

```bash
cd app && node scripts/babel-check.js src/components/OrderKanbanBoard.js src/screens/DashboardScreen.js
```

Expected: two `OK` lines, exit 0.

- [ ] **Step 6: Verify the guards live**

Start the dev server. Against **Test Loc (`location_id 4`) only**, create a `pre_order` with a delivery attached, then attempt to complete it:

```bash
curl -s -X PUT "http://localhost:3001/api/sales/<PRE_ORDER_ID>/status" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"status":"completed"}'
```

Expected: HTTP 400, `message` reading `Cannot complete — this order's delivery is still 'assigned'. Mark the delivery as delivered first.`

Repeat with a `pre_order` fulfilled by pickup carrying an unpaid balance. Expected: HTTP 400 naming the rupee amount due.

Then confirm no regression: a `walk_in` with no delivery and no balance still completes with HTTP 200, and a `delivery` order whose delivery is `delivered` still completes with HTTP 200.

- [ ] **Step 7: Commit**

```bash
git add server/routes/sales.js app/scripts/babel-check.js
git commit -m "Fix: pre_order bypassed both completion guards

Both guards in PUT /sales/:id/status keyed on order_type, so a pre_order
fulfilled by delivery or pickup could be completed with a rider still
holding the order, or with money still owed. Re-key the delivery guard on
'has a delivery row' and the payment guard on 'is not a delivery'.

Also adds app/scripts/babel-check.js — the npx babel form recorded in
earlier sessions does not resolve babel-preset-expo and reports false
syntax errors on every file."
```

---

### Task 2: Stage column definitions and the breakpoint hook

Two pure leaf modules with no consumers yet. Grouped into one task because neither is independently reviewable in a meaningful way and both are pure data/utility.

**Files:**
- Create: `app/src/constants/orderStages.js`
- Create: `app/src/hooks/useBreakpoint.js`

**Interfaces:**
- Produces: `STAGE_COLUMNS` (array), `columnKeyForStage(stageKey)` → column key or `null`, `TYPE_FILTERS` (array), `TYPE_ICONS` (object) from `constants/orderStages`.
- Produces: `useBreakpoint()` → `{ width, isWide }` from `hooks/useBreakpoint`.

- [ ] **Step 1: Create `app/src/constants/orderStages.js`**

```js
/**
 * The board's Stage columns, and the mapping from a server-computed
 * `display_stage.key` (server/utils/order-stage.js) onto one of them.
 *
 * See docs/superpowers/specs/2026-09-01-dashboard-stage-ui-redesign-design.md §3.
 *
 * computeOrderStage() emits nine keys; the board shows four columns. The
 * collapsing is deliberate:
 *   - 'ready' and 'ready_for_pickup' mean the same thing to the person at the
 *     counter (the flowers are done and waiting). The card's type icon already
 *     says which kind of waiting it is.
 *   - 'delivered' / 'picked_up' / 'completed' / 'cancelled' get NO column. A
 *     Done column fills up all day, dominates the board by volume, and is the
 *     one bucket nobody needs to act on. It surfaces as a header count chip
 *     linking to Orders Inbox instead.
 *
 * This file is data, not logic, and imports nothing — both the board and any
 * future consumer can import it without cycle risk.
 */

export const STAGE_COLUMNS = [
  { key: 'new', label: 'New', stageKeys: ['new'] },
  { key: 'preparing', label: 'Preparing', stageKeys: ['preparing'] },
  { key: 'ready', label: 'Ready', stageKeys: ['ready', 'ready_for_pickup'] },
  { key: 'out_for_delivery', label: 'Out for Delivery', stageKeys: ['out_for_delivery'] },
];

// Stage keys that are finished work — counted for the header chip, never given
// a column. Kept as an explicit list rather than "anything not in a column" so
// that adding a new live stage key server-side surfaces as an unmapped order
// (columnKeyForStage returns null and the board logs it) rather than silently
// being treated as done.
export const CLOSED_STAGE_KEYS = ['delivered', 'picked_up', 'completed', 'cancelled'];

const STAGE_KEY_TO_COLUMN = STAGE_COLUMNS.reduce((acc, col) => {
  col.stageKeys.forEach((k) => { acc[k] = col.key; });
  return acc;
}, {});

/**
 * @param {string} stageKey - a display_stage.key value
 * @returns {string|null} the column key it belongs in, or null if it is a
 *   closed stage or an unrecognized key.
 */
export function columnKeyForStage(stageKey) {
  return STAGE_KEY_TO_COLUMN[stageKey] || null;
}

export function isClosedStage(stageKey) {
  return CLOSED_STAGE_KEYS.includes(stageKey);
}

// Type is a filter, not a section (spec §5). 'all' first so it is the default.
export const TYPE_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'delivery', label: 'Delivery' },
  { key: 'pickup', label: 'Pickup' },
  { key: 'walk_in', label: 'Walk-in' },
  { key: 'pre_order', label: 'Pre-order' },
];

// Ionicons names, matching the icon vocabulary DashboardScreenV2 established.
export const TYPE_ICONS = {
  delivery: 'bicycle-outline',
  pickup: 'bag-handle-outline',
  walk_in: 'storefront-outline',
  pre_order: 'calendar-outline',
};
```

- [ ] **Step 2: Create `app/src/hooks/useBreakpoint.js`**

```js
import { useWindowDimensions } from 'react-native';

/**
 * The app's one layout breakpoint.
 *
 * Replaces two independent `width >= 1100` computations that DashboardScreen.js
 * and OrderKanbanBoard.js each maintained, both carrying a comment asking
 * whoever changed one to remember the other. 900 (not 1100) is the threshold,
 * ported from DashboardScreenV2.js which had the only working responsive
 * treatment in the app.
 *
 * See docs/superpowers/specs/2026-09-01-dashboard-stage-ui-redesign-design.md §5.
 */
export const WIDE_BREAKPOINT = 900;

export default function useBreakpoint() {
  const { width } = useWindowDimensions();
  return { width, isWide: width >= WIDE_BREAKPOINT };
}
```

- [ ] **Step 3: Verify both transform**

```bash
cd app && node scripts/babel-check.js src/constants/orderStages.js src/hooks/useBreakpoint.js
```

Expected: two `OK` lines, exit 0.

- [ ] **Step 4: Sanity-check the mapping in isolation**

```bash
cd app && node -e "
const b=require('@babel/core');
const out=b.transformFileSync('src/constants/orderStages.js',{presets:[require.resolve('babel-preset-expo')],babelrc:false,configFile:false}).code;
const m={exports:{}};new Function('exports','module','require',out)(m.exports,m,require);
const {columnKeyForStage,isClosedStage}=m.exports;
console.log('new ->',columnKeyForStage('new'));
console.log('ready_for_pickup ->',columnKeyForStage('ready_for_pickup'));
console.log('out_for_delivery ->',columnKeyForStage('out_for_delivery'));
console.log('completed ->',columnKeyForStage('completed'),'closed?',isClosedStage('completed'));
console.log('bogus ->',columnKeyForStage('bogus'));
"
```

Expected output:
```
new -> new
ready_for_pickup -> ready
out_for_delivery -> out_for_delivery
completed -> null closed? true
bogus -> null
```

- [ ] **Step 5: Commit**

```bash
git add app/src/constants/orderStages.js app/src/hooks/useBreakpoint.js
git commit -m "Add Stage column definitions and the shared 900px breakpoint hook"
```

---

### Task 3: StageBadge

The component that makes "single source of truth" structurally true rather than aspirational — four screens render this, none render `display_stage` fields directly.

**Files:**
- Create: `app/src/components/StageBadge.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `<StageBadge stage={order.display_stage} size="sm|md" />`. Renders `null` when `stage` is missing.

- [ ] **Step 1: Create the component**

```js
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { FONT_FAMILY } from '../constants/orderDisplay';

/**
 * Renders a sale's server-computed stage — display_stage.label and .color from
 * server/utils/order-stage.js.
 *
 * This is a component rather than a copied <View> on purpose: it is rendered by
 * the order card, OrderQuickModal, SaleDetailScreen, OrdersInboxScreen and
 * DeliveriesScreen, and the single-source-of-truth property the stage model
 * exists to provide only holds if there is exactly one place that decides how a
 * stage looks.
 *
 * Never derive a stage here from status/payment_status/pickup_status/
 * delivery_status. If `stage` is missing, render nothing and let the caller's
 * layout collapse — a wrong stage is worse than no stage.
 *
 * See docs/superpowers/specs/2026-09-01-dashboard-stage-ui-redesign-design.md §4.
 */
export default function StageBadge({ stage, size = 'md' }) {
  if (!stage || !stage.label) return null;
  const color = stage.color || '#9CA3AF';
  const small = size === 'sm';
  return (
    <View
      style={[
        styles.badge,
        small && styles.badgeSmall,
        { backgroundColor: color + '18', borderColor: color },
      ]}
    >
      <Text style={[styles.text, small && styles.textSmall, { color }]} numberOfLines={1}>
        {stage.label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    alignSelf: 'flex-start',
  },
  badgeSmall: {
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
  },
  text: {
    fontSize: 13,
    fontWeight: '700',
    fontFamily: FONT_FAMILY,
  },
  textSmall: {
    fontSize: 11,
  },
});
```

Note the text is `stage.label` verbatim ("Out for Delivery"), not uppercased. The retired badge used `.toUpperCase()`; sentence case is more legible at a glance and matches the plain-language rule.

- [ ] **Step 2: Verify it transforms**

```bash
cd app && node scripts/babel-check.js src/components/StageBadge.js
```

Expected: `OK`, exit 0.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/StageBadge.js
git commit -m "Add StageBadge — the one place a display_stage is rendered"
```

---

### Task 4: Backend — rider name on GET /sales, display_stage on GET /deliveries

Two additive response-shape changes. No schema change.

**Files:**
- Modify: `server/routes/sales.js` (the `GET /` SELECT, around `:200-205`)
- Modify: `server/routes/deliveries.js:141-160`

**Interfaces:**
- Produces: `delivery_partner_name` on every `GET /sales` row (null when unassigned) — Task 5 renders it.
- Produces: `display_stage` on every `GET /deliveries` row — Task 10 renders it.

- [ ] **Step 1: Add the rider's name to GET /sales**

Task 5's card needs to show `Ravi has it · out 40 min` for the counter_staff out-for-delivery case. `GET /sales` already returns `delivery_id`, `delivery_status`, `cod_amount`, `cod_collected` and `total_paid`, but not the partner's name. Locate the SELECT (it begins `SELECT s.*, l.name as location_name, u.name as created_by_name,`) and add the joined column plus its join:

```sql
             d.status as delivery_status, d.id as delivery_id, d.cod_amount, d.cod_collected,
             dp.name as delivery_partner_name
```

and alongside the existing `deliveries d` join:

```sql
      LEFT JOIN users dp ON d.delivery_partner_id = dp.id
```

Confirm the existing join alias for `deliveries` is `d` before editing; match whatever is there.

- [ ] **Step 2: Attach display_stage to GET /deliveries**

`server/routes/deliveries.js` does not import `computeOrderStage` at all. Add at the top of the file, next to the other requires:

```js
const { computeOrderStage } = require('../utils/order-stage');
```

Then add `s.pickup_status` to the SELECT in the `GET /` handler (`:147`), which currently selects `s.sale_number, s.grand_total, s.payment_status, s.order_type, s.status as order_status, s.special_instructions, s.is_credit_sale`:

```sql
      SELECT d.*, s.sale_number, s.grand_total, s.payment_status, s.order_type,
             s.status as order_status, s.pickup_status, s.special_instructions, s.is_credit_sale,
```

- [ ] **Step 3: Map the row before computing the stage**

**This is the step to get right.** The delivery row's field names collide with what `computeOrderStage()` expects — `row.status` is the *delivery's* status while the sale's is aliased to `order_status`. Passing the row straight in would feed the wrong field and produce a plausible-looking but wrong stage on every row.

After the rows are fetched and before they are returned, map each one:

```js
    // computeOrderStage() expects a SALE-shaped object. A delivery row is not
    // one: its `status` is the delivery's status, the sale's is aliased to
    // `order_status`, `id` is the delivery id and the sale id is `sale_id`.
    // Passing the row through directly silently yields a wrong stage on every
    // row, so map explicitly. Same adapter pattern as sales.js:1323.
    const withStage = (rows || []).map((row) => ({
      ...row,
      display_stage: computeOrderStage({
        id: row.sale_id,
        status: row.order_status,
        order_type: row.order_type,
        pickup_status: row.pickup_status,
        delivery_status: row.status,
        delivery_id: row.id,
        grand_total: row.grand_total,
        total_paid: null,
        is_credit_sale: row.is_credit_sale,
        cod_amount: row.cod_amount,
        cod_collected: row.cod_collected,
      }, req.user.role),
    }));
```

`total_paid` is passed as `null` deliberately: this route does not sum `payments`, and `computeOrderStage()`'s balance check is written as `sale.grand_total != null && sale.total_paid != null ? ... : false`, so a null makes the pickup balance branch evaluate to "no balance due" rather than guessing. That branch is unreachable from a delivery row anyway — every row here has a delivery attached, so the pickup ladder never runs.

Return `withStage` where the handler currently returns its rows.

- [ ] **Step 4: Verify both routes live**

```bash
curl -s "http://localhost:3001/api/sales?location_id=4&limit=3" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool | grep -E 'delivery_partner_name|"label"|"key"'
```

Expected: `delivery_partner_name` present on every row (null when unassigned), and each row still carrying its `display_stage`.

```bash
curl -s "http://localhost:3001/api/deliveries?location_id=4&limit=3" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool | grep -E '"display_stage"|"label"|"delivery_status"'
```

Expected: every row now has `display_stage`. **Verify the stage is actually correct**, not merely present: pick a delivery whose sale is `ready` and whose delivery is `assigned`, and confirm the label reads `Out for Delivery` — if it reads `Ready` or `New`, the Step 3 mapping is wrong.

- [ ] **Step 5: Confirm no permission regression**

```bash
node server/scripts/verify-identity-roles.js
```

Expected: 10/10 passing, unchanged.

- [ ] **Step 6: Commit**

```bash
git add server/routes/sales.js server/routes/deliveries.js
git commit -m "Add delivery_partner_name to GET /sales, display_stage to GET /deliveries

Both additive response-shape changes, no schema change. The deliveries
route needs an adapter rather than a direct computeOrderStage() call —
its row's \`status\` is the delivery's, not the sale's."
```

---

### Task 5: OrderCard — exceptions only, never a dead end

**Files:**
- Create: `app/src/components/orderBoard/OrderCard.js`

**Interfaces:**
- Consumes: `StageBadge` (Task 3), `TYPE_ICONS` (Task 2), `delivery_partner_name` (Task 4), `formatCardDateTime` (pre-existing, `utils/datetime.js`).
- Produces: `<OrderCard order tasks timezone quickActionLoading onOpen onQuickAction onResolve />`, where `onResolve(order, kind)` is called with `kind` being one of `'collect_payment' | 'assign_rider' | 'record_cod'`. The card never calls `navigation` itself — the parent owns routing, matching how `onOrderPress` already works on this board.
- There is deliberately **no** `viewerRole` prop. The role gate is already baked into `nextAction` being null server-side (`ENDPOINT_ROLES` in `order-stage.js`), so re-checking the role here would be a second source of truth for one decision.

- [ ] **Step 1: Write the resolver that turns a null nextAction into a route**

Create the file with this at the top (below imports). This is spec §7:

```js
/**
 * What to offer when the server says there is no safe one-tap action.
 *
 * `display_stage.nextAction === null` means "advancing needs a human decision"
 * — not "nothing can be done". Rendering nothing leaves the staff member at a
 * wall, which is the same failure class as a technical error message and fails
 * staff-ux-checklist items #2 and #6. So every null resolves to either a
 * routing button or an explicit status line.
 *
 * Returns one of:
 *   { type: 'route', kind, label }  — render a secondary button
 *   { type: 'status', text }        — render a plain status line, no button
 *   null                            — genuinely nothing to show (terminal stage)
 *
 * See docs/superpowers/specs/2026-09-01-dashboard-stage-ui-redesign-design.md §7.
 */
function resolveDeadEnd(order) {
  const stageKey = order.display_stage?.key;

  // 'ready' and 'ready_for_pickup' share one branch, and it keys on the DATA
  // (is there an open delivery? is money owed?) rather than on order_type.
  // Keying this on order_type was the original bug in this plan and the exact
  // bug Task 1 fixed in the backend guards: a pre_order fulfilled by delivery
  // is not order_type 'delivery', and gating on that would drop it straight
  // through into a card with no action at all.
  if (stageKey === 'ready' || stageKey === 'ready_for_pickup') {
    const hasOpenDelivery = order.delivery_id != null
      && !['delivered', 'cancelled'].includes(order.delivery_status);
    if (hasOpenDelivery) {
      if (!order.delivery_partner_name) {
        return { type: 'route', kind: 'assign_rider', label: 'Assign Rider' };
      }
      return { type: 'status', text: `${order.delivery_partner_name} has it` };
    }
    const due = Number(order.grand_total || 0) - Number(order.total_paid || 0);
    if (due > 0.01 && !order.is_credit_sale) {
      return { type: 'route', kind: 'collect_payment', label: `Collect ${formatMoney(due)}` };
    }
    return null;
  }

  if (stageKey === 'out_for_delivery') {
    const codOutstanding = Number(order.cod_amount || 0) > Number(order.cod_collected || 0);
    if (codOutstanding) {
      return { type: 'route', kind: 'record_cod', label: 'Record COD' };
    }
    // Marking a delivery delivered is not counter staff's action —
    // ENDPOINT_ROLES.DELIVERY_DELIVER in server/utils/order-stage.js omits
    // counter_staff deliberately, so offering a button would hand them a 403.
    // They still need to know who has it (customers ring up asking), so this
    // renders as status, not as a control. staff-ux-checklist #8.
    if (order.delivery_partner_name) {
      return { type: 'status', text: `${order.delivery_partner_name} has it` };
    }
    return { type: 'status', text: 'Out with a rider' };
  }

  return null;
}
```

- [ ] **Step 2: Write the exception helpers**

These decide what is *abnormal* and therefore worth showing. Everything normal stays hidden — spec §6.

```js
/**
 * Reuses the SLA thresholds the previous board already used (walk-in: 20 min
 * overdue / 10 min due-soon from creation; everything else: against the
 * scheduled slot). Previously computed only as a lane-level count; now shown
 * per card, which is where it actually helps someone decide what to do next.
 */
function getOrderSla(order, timezone) {
  if (!order || ['ready', 'completed', 'cancelled', 'draft'].includes(order.status)) return null;
  if (order.order_type === 'walk_in') {
    const mins = minutesSinceServerDate(order.created_at, timezone);
    if (mins == null) return null;
    if (mins > 20) return { level: 'late', text: `${mins} min waiting` };
    if (mins > 10) return { level: 'soon', text: `${mins} min waiting` };
    return null;
  }
  if (!order.scheduled_date || !order.scheduled_time) return null;
  const remaining = minutesUntilShopDateTime(order.scheduled_date, order.scheduled_time, timezone);
  if (remaining == null) return null;
  if (remaining < 0) return { level: 'late', text: `${Math.abs(remaining)} min late` };
  if (remaining <= 60) return { level: 'soon', text: `Due in ${remaining} min` };
  return null;
}

/** Plain language, no PAY: prefix. Null when there is nothing worth saying. */
function getPaymentWarning(order) {
  if (order.is_credit_sale === 1) return { level: 'soon', text: 'Credit' };
  if (order.payment_status === 'pending') return { level: 'late', text: 'Unpaid' };
  if (order.payment_status === 'partial') return { level: 'soon', text: 'Part paid' };
  return null;
}

/** Only when tasks exist AND are not all done. */
function getTaskProgress(tasks) {
  const list = tasks || [];
  if (list.length === 0) return null;
  const done = list.filter((t) => t.status === 'completed' || t.status === 'cancelled').length;
  if (done === list.length) return null;
  return `${done} of ${list.length} tasks`;
}
```

- [ ] **Step 3: Write the card body**

Always: type icon, order number, customer, amount, `<StageBadge/>`, action row. Conditional rows only when their helper returns non-null. Retired vs the old card: the raw status badge, both sub-status rows, the `Placed:` line, and the Q/A/IP/D pipeline dots. Contact buttons are retained — they were added deliberately in the previous plan and removing them would be a functionality loss (staff-ux-checklist #9).

```js
export default function OrderCard({
  order,
  tasks,
  timezone,
  quickActionLoading,
  onOpen,
  onQuickAction,
  onResolve,
}) {
  const sla = getOrderSla(order, timezone);
  const payment = getPaymentWarning(order);
  const taskProgress = getTaskProgress(tasks);
  const nextAction = order.display_stage?.nextAction;
  const deadEnd = nextAction ? null : resolveDeadEnd(order);
  const contactPhone = order.customer_phone || order.receiver_phone;
  const showSchedule = order.scheduled_date && order.order_type !== 'walk_in';

  return (
    <TouchableOpacity style={styles.card} onPress={onOpen} activeOpacity={0.85}>
      <View style={styles.headerRow}>
        <Ionicons
          name={TYPE_ICONS[order.order_type] || 'receipt-outline'}
          size={16}
          color={Colors.textSecondary}
        />
        <Text style={styles.orderNumber} numberOfLines={1}>#{order.sale_number}</Text>
        <View style={{ flex: 1 }} />
        <StageBadge stage={order.display_stage} size="sm" />
      </View>

      <View style={styles.customerRow}>
        <Text style={styles.customer} numberOfLines={1}>{order.customer_name || 'Guest'}</Text>
        {contactPhone && (
          <>
            <TouchableOpacity
              style={[styles.contactBtn, { backgroundColor: Colors.info + '15' }]}
              onPress={(e) => { e.stopPropagation(); Linking.openURL(`tel:${contactPhone}`); }}
              hitSlop={12}
            >
              <Ionicons name="call-outline" size={13} color={Colors.info} />
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.contactBtn, { backgroundColor: Colors.success + '15' }]}
              onPress={(e) => {
                e.stopPropagation();
                Linking.openURL(`https://wa.me/91${contactPhone}?text=${encodeURIComponent(`Hi, this is about your order ${order.sale_number}`)}`);
              }}
              hitSlop={12}
            >
              <Ionicons name="logo-whatsapp" size={13} color={Colors.success} />
            </TouchableOpacity>
          </>
        )}
      </View>

      <Text style={styles.amount}>{formatMoney(order.grand_total)}</Text>

      {(sla || payment) && (
        <View style={styles.warningRow}>
          {sla && (
            <View style={[styles.warnPill, sla.level === 'late' ? styles.warnPillLate : styles.warnPillSoon]}>
              <Ionicons
                name="alert-circle-outline"
                size={12}
                color={sla.level === 'late' ? Colors.error : Colors.warning}
              />
              <Text style={[styles.warnText, { color: sla.level === 'late' ? Colors.error : Colors.warning }]}>
                {sla.text}
              </Text>
            </View>
          )}
          {payment && (
            <View style={[styles.warnPill, payment.level === 'late' ? styles.warnPillLate : styles.warnPillSoon]}>
              <Ionicons
                name="cash-outline"
                size={12}
                color={payment.level === 'late' ? Colors.error : Colors.warning}
              />
              <Text style={[styles.warnText, { color: payment.level === 'late' ? Colors.error : Colors.warning }]}>
                {payment.text}
              </Text>
            </View>
          )}
        </View>
      )}

      {(showSchedule || taskProgress) && (
        <Text style={styles.metaLine} numberOfLines={1}>
          {[
            showSchedule ? formatCardDateTime(order.scheduled_date, order.scheduled_time, timezone) : null,
            taskProgress,
          ].filter(Boolean).join('  ·  ')}
        </Text>
      )}

      {nextAction && (
        <TouchableOpacity
          style={styles.primaryAction}
          onPress={(e) => { e.stopPropagation(); onQuickAction(order); }}
          disabled={!!quickActionLoading}
          activeOpacity={0.75}
        >
          {quickActionLoading ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <>
              <Text style={styles.primaryActionText}>{nextAction.label}</Text>
              <Ionicons name="arrow-forward" size={15} color="#FFFFFF" />
            </>
          )}
        </TouchableOpacity>
      )}

      {deadEnd?.type === 'route' && (
        <TouchableOpacity
          style={styles.secondaryAction}
          onPress={(e) => { e.stopPropagation(); onResolve(order, deadEnd.kind); }}
          activeOpacity={0.75}
        >
          <Text style={styles.secondaryActionText}>{deadEnd.label}</Text>
          <Ionicons name="arrow-forward" size={14} color={Colors.primary} />
        </TouchableOpacity>
      )}

      {deadEnd?.type === 'status' && (
        <Text style={styles.statusLine} numberOfLines={1}>{deadEnd.text}</Text>
      )}
    </TouchableOpacity>
  );
}
```

Imports needed at the top of the file:

```js
import React from 'react';
import { ActivityIndicator, Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '../../constants/theme';
import { FONT_FAMILY, formatMoney } from '../../constants/orderDisplay';
import { TYPE_ICONS } from '../../constants/orderStages';
import { formatCardDateTime, minutesSinceServerDate, minutesUntilShopDateTime } from '../../utils/datetime';
import StageBadge from '../StageBadge';
```

**On `formatCardDateTime`:** it is already an exported function at `app/src/utils/datetime.js:61`, already imported from there by `printHelpers.js`, `SaleDetailScreen.js` and `OrdersInboxScreen.js`. The copy at `components/OrderKanbanBoard.js:85` is a redundant shadowing duplicate (functionally identical, minus the NaN guards the shared one has). Import the shared one, as the import block above does. Do **not** move or copy anything, and do **not** touch `constants/orderDisplay.js` in this task — the duplicate dies with the old board file in Task 8.

- [ ] **Step 4: Write the styles**

Tap targets are sized per staff-ux-checklist #7 — the primary action is a filled 44px-tall button, not the bordered 28px one the old card used.

```js
const styles = StyleSheet.create({
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    padding: 12,
    gap: 6,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  orderNumber: { fontSize: 14, fontWeight: '800', color: Colors.text, fontFamily: FONT_FAMILY },
  customerRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  customer: { fontSize: 14, color: Colors.textSecondary, flexShrink: 1, fontFamily: FONT_FAMILY },
  contactBtn: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  amount: { fontSize: 17, fontWeight: '800', color: Colors.text, fontFamily: FONT_FAMILY },
  warningRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  warnPill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
  warnPillLate: { backgroundColor: Colors.error + '15' },
  warnPillSoon: { backgroundColor: Colors.warning + '15' },
  warnText: { fontSize: 12, fontWeight: '700', fontFamily: FONT_FAMILY },
  metaLine: { fontSize: 12, color: Colors.textLight, fontFamily: FONT_FAMILY },
  primaryAction: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    minHeight: 44, borderRadius: 10, backgroundColor: Colors.primary, marginTop: 2,
  },
  primaryActionText: { fontSize: 15, fontWeight: '700', color: '#FFFFFF', fontFamily: FONT_FAMILY },
  secondaryAction: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    minHeight: 44, borderRadius: 10, borderWidth: 1.5, borderColor: Colors.primary,
    backgroundColor: Colors.primary + '10', marginTop: 2,
  },
  secondaryActionText: { fontSize: 15, fontWeight: '700', color: Colors.primary, fontFamily: FONT_FAMILY },
  statusLine: { fontSize: 13, color: Colors.textSecondary, fontStyle: 'italic', fontFamily: FONT_FAMILY, marginTop: 2 },
});
```

- [ ] **Step 5: Verify it transforms**

```bash
cd app && node scripts/babel-check.js src/components/orderBoard/OrderCard.js
```

Expected: `OK`, exit 0.

- [ ] **Step 6: Commit**

```bash
git add app/src/components/orderBoard/OrderCard.js
git commit -m "Add exceptions-only OrderCard that routes instead of dead-ending

13 card elements down to 5 plus up to 4 conditional. Every state where
display_stage.nextAction is null now offers either a routing button or an
explicit status line, rather than rendering nothing."
```

---

### Task 6: StageColumn

**Files:**
- Create: `app/src/components/orderBoard/StageColumn.js`

**Interfaces:**
- Consumes: `OrderCard` (Task 5), `useBreakpoint` (Task 2).
- Produces: `<StageColumn column orders isWide collapsed onToggleCollapse renderCard />`. The same component is a flex column when `isWide`, a collapsible section otherwise — one component, two layouts, so the two can never drift apart.

- [ ] **Step 1: Create the component**

```js
import React from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '../../constants/theme';
import { FONT_FAMILY } from '../../constants/orderDisplay';

/**
 * One Stage column (wide) or one collapsible Stage section (narrow).
 *
 * Deliberately one component rather than two: the wide and narrow treatments
 * differ only in the wrapper's flex/scroll behaviour, and keeping them in one
 * file is what stops them drifting apart the way the two dashboards did.
 *
 * Narrow is a plain vertical stack — no horizontal scroll, no swipe. CLAUDE.md
 * forbids hidden gestures, and the people using this have never used business
 * software before.
 *
 * See docs/superpowers/specs/2026-09-01-dashboard-stage-ui-redesign-design.md §5.
 */
export default function StageColumn({ column, orders, isWide, collapsed, onToggleCollapse, renderCard }) {
  const count = orders.length;

  const header = (
    <View style={styles.header}>
      {!isWide && (
        <Ionicons
          name={collapsed ? 'chevron-forward' : 'chevron-down'}
          size={16}
          color={Colors.textSecondary}
        />
      )}
      <Text style={styles.headerLabel}>{column.label}</Text>
      <View style={styles.countPill}>
        <Text style={styles.countText}>{count}</Text>
      </View>
    </View>
  );

  const body = count === 0 ? (
    <Text style={styles.emptyText}>Nothing here</Text>
  ) : (
    <View style={styles.cardStack}>{orders.map(renderCard)}</View>
  );

  if (isWide) {
    return (
      <View style={styles.wideColumn}>
        {header}
        <ScrollView style={styles.wideScroll} contentContainerStyle={styles.wideScrollContent}>
          {body}
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={styles.narrowSection}>
      <TouchableOpacity onPress={onToggleCollapse} activeOpacity={0.7} style={styles.narrowHeaderTap}>
        {header}
      </TouchableOpacity>
      {!collapsed && <View style={styles.narrowBody}>{body}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  wideColumn: {
    flex: 1,
    minWidth: 0,
    backgroundColor: Colors.surfaceAlt || '#F9FAFB',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    overflow: 'hidden',
  },
  wideScroll: { flexGrow: 0 },
  wideScrollContent: { padding: 10, paddingTop: 0 },
  narrowSection: { marginBottom: 14 },
  narrowHeaderTap: { minHeight: 44, justifyContent: 'center' },
  narrowBody: { paddingTop: 4 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, paddingVertical: 10 },
  headerLabel: { fontSize: 14, fontWeight: '800', color: Colors.text, fontFamily: FONT_FAMILY },
  countPill: {
    minWidth: 24, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 11,
    backgroundColor: '#E5E7EB', alignItems: 'center',
  },
  countText: { fontSize: 12, fontWeight: '800', color: Colors.textSecondary, fontFamily: FONT_FAMILY },
  cardStack: { gap: 10 },
  emptyText: {
    fontSize: 13, color: Colors.textLight, fontFamily: FONT_FAMILY,
    paddingHorizontal: 10, paddingBottom: 10,
  },
});
```

- [ ] **Step 2: Verify it transforms**

```bash
cd app && node scripts/babel-check.js src/components/orderBoard/StageColumn.js
```

Expected: `OK`, exit 0.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/orderBoard/StageColumn.js
git commit -m "Add StageColumn — flex column on wide, collapsible section on narrow"
```

---

### Task 7: Rebuild OrderKanbanBoard onto Stage grouping

**Files:**
- Create: `app/src/components/orderBoard/OrderKanbanBoard.js`
- Delete: `app/src/components/OrderKanbanBoard.js` (after Task 8 repoints its importer)

**Interfaces:**
- Consumes: `StageColumn` (Task 6), `OrderCard` (Task 5), `orderStages` (Task 2), `useBreakpoint` (Task 2).
- Produces: `<OrderKanbanBoard sales onOrderPress onResolveAction onNavigateToDone tasksBySaleId timezone onRefresh />`. Note `onNavigateToQueue`, `taskActionLoading` and `onTaskPress` are **dropped** — the new card has no task pills, so the props that fed them have no consumer.

- [ ] **Step 1: Create the file with grouping and filter state**

```js
import React, { useCallback, useMemo, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import api from '../../services/api';
import { Colors } from '../../constants/theme';
import { FONT_FAMILY } from '../../constants/orderDisplay';
import { STAGE_COLUMNS, TYPE_FILTERS, columnKeyForStage, isClosedStage } from '../../constants/orderStages';
import useBreakpoint from '../../hooks/useBreakpoint';
import StageColumn from './StageColumn';
import OrderCard from './OrderCard';

/**
 * The unified Stage board.
 *
 * Replaces components/OrderKanbanBoard.js, which grouped by order type first
 * and nested status lanes inside each type — four stacked mini-boards. That
 * nesting was the structural source of the "cluttered" feel, and it rendered
 * as one narrow mobile column at any viewport width because the old file
 * computed a desktop breakpoint and used it only to change how many cards
 * previewed, never the layout.
 *
 * Here: one board, columns are the Stage (from display_stage.key), and order
 * type is a filter chip plus a per-card icon.
 *
 * See docs/superpowers/specs/2026-09-01-dashboard-stage-ui-redesign-design.md §3, §5.
 */
export default function OrderKanbanBoard({
  sales,
  onOrderPress,
  onResolveAction,
  onNavigateToDone,
  tasksBySaleId,
  timezone,
  onRefresh,
}) {
  const { isWide } = useBreakpoint();
  const [typeFilter, setTypeFilter] = useState('all');
  const [collapsed, setCollapsed] = useState({});
  const [quickActionLoading, setQuickActionLoading] = useState({});
  const effectiveTimezone = timezone || 'Asia/Kolkata';

  const handleQuickAction = useCallback(async (order) => {
    const nextAction = order?.display_stage?.nextAction;
    if (!nextAction) return;
    setQuickActionLoading((prev) => ({ ...prev, [order.id]: true }));
    try {
      await api.advanceOrder(nextAction);
      if (onRefresh) await onRefresh();
    } catch (err) {
      // The backend's guard messages are already plain language
      // (server/routes/sales.js) — pass them straight through rather than
      // wrapping them in something more technical.
      Alert.alert('Order Update', err?.message || 'Unable to update this order.');
    } finally {
      setQuickActionLoading((prev) => ({ ...prev, [order.id]: false }));
    }
  }, [onRefresh]);

  const { columns, doneCount } = useMemo(() => {
    const buckets = STAGE_COLUMNS.reduce((acc, c) => { acc[c.key] = []; return acc; }, {});
    let done = 0;
    const list = (sales || []).filter(
      (s) => typeFilter === 'all' || s.order_type === typeFilter
    );
    list.forEach((sale) => {
      const stageKey = sale.display_stage?.key;
      if (!stageKey) return;
      if (isClosedStage(stageKey)) { done++; return; }
      const columnKey = columnKeyForStage(stageKey);
      if (columnKey) buckets[columnKey].push(sale);
    });
    // Oldest first within a column, so nothing quietly ages out at the bottom.
    // Deliberately NOT sorted by urgency: the SLA calculation lives in
    // OrderCard and sorting by it here would mean either duplicating that
    // logic or hoisting it, for a reordering that the per-card warning pills
    // already make visible. Revisit only if columns get long enough that
    // scanning them stops working.
    Object.keys(buckets).forEach((k) => {
      buckets[k].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    });
    return { columns: buckets, doneCount: done };
  }, [sales, typeFilter]);
```

- [ ] **Step 2: Add the render**

```js
  const renderCard = useCallback((order) => (
    <OrderCard
      key={order.id}
      order={order}
      tasks={tasksBySaleId?.get?.(order.id)}
      timezone={effectiveTimezone}
      quickActionLoading={!!quickActionLoading[order.id]}
      onOpen={() => onOrderPress(order)}
      onQuickAction={handleQuickAction}
      onResolve={onResolveAction}
    />
  ), [tasksBySaleId, effectiveTimezone, quickActionLoading, onOrderPress, handleQuickAction, onResolveAction]);

  return (
    <View>
      <View style={styles.toolbar}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
          {TYPE_FILTERS.map((f) => {
            const active = typeFilter === f.key;
            return (
              <TouchableOpacity
                key={f.key}
                style={[styles.chip, active && styles.chipActive]}
                onPress={() => setTypeFilter(f.key)}
                activeOpacity={0.75}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>{f.label}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
        {doneCount > 0 && (
          <TouchableOpacity style={styles.doneChip} onPress={onNavigateToDone} activeOpacity={0.75}>
            <Text style={styles.doneChipText}>Done today · {doneCount}</Text>
          </TouchableOpacity>
        )}
      </View>

      <View style={isWide ? styles.boardWide : styles.boardNarrow}>
        {STAGE_COLUMNS.map((column) => (
          <StageColumn
            key={column.key}
            column={column}
            orders={columns[column.key]}
            isWide={isWide}
            collapsed={!!collapsed[column.key]}
            onToggleCollapse={() => setCollapsed((p) => ({ ...p, [column.key]: !p[column.key] }))}
            renderCard={renderCard}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  chipRow: { gap: 6, paddingRight: 8 },
  chip: {
    paddingHorizontal: 14, minHeight: 36, justifyContent: 'center',
    borderRadius: 18, borderWidth: 1, borderColor: '#E5E7EB', backgroundColor: '#FFFFFF',
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: 13, fontWeight: '700', color: Colors.textSecondary, fontFamily: FONT_FAMILY },
  chipTextActive: { color: '#FFFFFF' },
  doneChip: {
    paddingHorizontal: 12, minHeight: 36, justifyContent: 'center',
    borderRadius: 18, backgroundColor: '#F3F4F6',
  },
  doneChipText: { fontSize: 12, fontWeight: '700', color: Colors.textSecondary, fontFamily: FONT_FAMILY },
  boardWide: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  boardNarrow: { flexDirection: 'column' },
});
```

- [ ] **Step 3: Verify it transforms**

```bash
cd app && node scripts/babel-check.js src/components/orderBoard/OrderKanbanBoard.js
```

Expected: `OK`, exit 0.

- [ ] **Step 4: Commit**

```bash
git add app/src/components/orderBoard/OrderKanbanBoard.js
git commit -m "Add unified Stage board — columns are the stage, type is a filter"
```

---

### Task 8: Wire the board into DashboardScreen

**Files:**
- Modify: `app/src/screens/DashboardScreen.js` — the import at `:24`, the two `<OrderKanbanBoard>` call sites (`:895`, `:1155`), and the local `isDesktop` computation at `:217`
- Delete: `app/src/components/OrderKanbanBoard.js`

**Interfaces:**
- Consumes: the new board (Task 7).
- Produces: `handleResolveAction(order, kind)` — owns all cross-stack navigation, so the board stays navigation-agnostic.

- [ ] **Step 1: Repoint the import**

```js
import OrderKanbanBoard from '../components/orderBoard/OrderKanbanBoard';
```

- [ ] **Step 2: Add the resolve handler**

Place it next to `handleNavigateToQueue` (around `:558`). The route names and cross-stack shapes below are copied from calls already in this file (`:728`, `:856`) — `DeliveryDetail` is registered directly in this stack, while `AddPayment` and `Settlements` live in the `POS` stack.

```js
  // Routing for a card whose display_stage.nextAction is null — the card
  // decides WHAT to offer (components/orderBoard/OrderCard.js resolveDeadEnd),
  // this decides WHERE it goes, because only the screen knows the navigator
  // layout. Spec §7.
  const handleResolveAction = useCallback((order, kind) => {
    if (kind === 'collect_payment') {
      const due = Number(order.grand_total || 0) - Number(order.total_paid || 0);
      navigation.navigate('POS', { screen: 'AddPayment', params: { saleId: order.id, due } });
      return;
    }
    if (kind === 'assign_rider') {
      if (order.delivery_id) {
        navigation.navigate('DeliveryDetail', { deliveryId: order.delivery_id });
      } else {
        // A delivery order with no delivery row is a data problem, not a
        // dead end — send them to the order where they can see why.
        navigation.navigate('SaleDetail', { saleId: order.id });
      }
      return;
    }
    if (kind === 'record_cod') {
      navigation.navigate('POS', { screen: 'Settlements' });
    }
  }, [navigation]);

  const handleNavigateToDone = useCallback(() => {
    navigation.navigate('EmployeeOrders', { screen: 'OrdersInbox' });
  }, [navigation]);
```

- [ ] **Step 3: Update the counter_staff call site (`:895`)**

It currently passes `onNavigateToQueue`, `taskActionLoading` and `onTaskPress`. The new board takes none of those. Keep its `sales` prop exactly as it is — `counterOrdersSplit.dueToday`, not the full fetch. That today/future split is deliberate: a delivery scheduled days out should not clutter what needs attention now.

```jsx
                <OrderKanbanBoard
                  sales={counterOrdersSplit.dueToday}
                  onOrderPress={(order) => setSelectedOrderModal({ order, tasks: tasksBySaleId.get(order.id) })}
                  onResolveAction={handleResolveAction}
                  onNavigateToDone={handleNavigateToDone}
                  tasksBySaleId={tasksBySaleId}
                  timezone={timezone}
                  onRefresh={fetchDashboard}
                />
```

- [ ] **Step 4: Update the owner/manager call site (`:1155`)**

Same replacement, but this one passes `sales={sales}`:

```jsx
                <OrderKanbanBoard
                  sales={sales}
                  onOrderPress={(order) => setSelectedOrderModal({ order, tasks: tasksBySaleId.get(order.id) })}
                  onResolveAction={handleResolveAction}
                  onNavigateToDone={handleNavigateToDone}
                  tasksBySaleId={tasksBySaleId}
                  timezone={timezone}
                  onRefresh={fetchDashboard}
                />
```

- [ ] **Step 5: Fix the now-false subtitle above it**

`:1150` reads `Tap on any status lane to view full queue`. That instruction stops being true the moment `onNavigateToQueue` is gone — lanes are Stage columns now and tapping one does nothing. Leaving it would be telling a first-time user to do something that does not work (staff-ux-checklist #6). Replace with a description of what the board is:

```jsx
                  <Text style={styles.sectionSubtitle}>Tap an order to see details, or use its button to move it forward</Text>
```

Then confirm nothing else still refers to the removed prop:

```bash
grep -n "onNavigateToQueue\|handleNavigateToQueue" app/src/screens/DashboardScreen.js
```

If `handleNavigateToQueue` has no remaining callers, delete it. If it still has other callers in this file, leave it alone.

- [ ] **Step 6: Replace the duplicated breakpoint**

`:217` computes `isDesktop = width >= 1100` with a comment pointing at the board's copy. It is **still used** at `:1167` (`styles.healthCol, isDesktop && { flex: 1 }`) and possibly elsewhere, so this is a replacement, not a deletion:

```js
import useBreakpoint from '../hooks/useBreakpoint';
// ...
const { isWide } = useBreakpoint();
```

Replace every `isDesktop` usage with `isWide` and delete the old computation plus its now-obsolete comment. Note this moves that layout from a 1100px to a 900px threshold — intended, it is the single breakpoint from spec §5. Enumerate the usages first so none are missed:

```bash
grep -n "isDesktop" app/src/screens/DashboardScreen.js
```

- [ ] **Step 7: Delete the old board**

```bash
git rm app/src/components/OrderKanbanBoard.js
grep -rn "components/OrderKanbanBoard" app/src/ || echo "no stale importers"
```

Expected: `no stale importers`.

- [ ] **Step 8: Verify transform**

```bash
cd app && node scripts/babel-check.js src/screens/DashboardScreen.js
```

Expected: `OK`, exit 0.

- [ ] **Step 9: Verify live on both viewports**

With the dev server running, log in as **counter_staff** at Test Loc and open the dashboard in a browser at `localhost:8081`:

- At a window wider than 900px: four Stage columns side by side, filling the width. This is the fix for the reported "one narrow card in an ocean of white space".
- Narrow the window below 900px: the same four become stacked collapsible sections. No horizontal scrolling of the page itself.
- Confirm each card shows a Stage badge reading one of New / Preparing / Ready / Out for Delivery — **not** a raw orange "Pending" badge, and no Q/A/IP/D dots.
- Tap a type filter chip; confirm the board filters and the counts update.

Repeat as **owner** to confirm the second call site.

- [ ] **Step 10: Commit**

```bash
git add -A app/src/screens/DashboardScreen.js app/src/components
git commit -m "Wire the unified Stage board into both dashboard call sites

Deletes components/OrderKanbanBoard.js. DashboardScreen owns dead-end
routing via handleResolveAction so the board stays navigation-agnostic."
```

---

### Task 9: Converge OrderQuickModal onto display_stage

This is the modal that opens when a card is tapped. Leaving it on raw status would mean the card speaks the new vocabulary and the modal one tap behind it speaks the old — the exact mismatch this work exists to remove, one level deeper.

**Files:**
- Modify: `app/src/components/QuickModals.js` — `OrderQuickModal` at `:194`, its `statusActions` at `:170-179`, its badges at `:201-209`, its dispatch at `:262`

**Interfaces:**
- Consumes: `StageBadge` (Task 3), `api.advanceOrder` (existing, `services/api.js:613`).

- [ ] **Step 1: Replace the raw status badge**

At `:201`, the modal renders `<BadgePill label={(orderStatus).replace(/_/g, ' ').toUpperCase()} color={orderColor} />`. Replace with:

```jsx
          <StageBadge stage={order.display_stage} />
```

Import it: `import StageBadge from './StageBadge';`

- [ ] **Step 2: Replace the payment badge wording**

At `:203`, the label reads `PAY: UNPAID` / `PAY: PARTIAL`. Match the card's plain language from Task 5 — `Unpaid`, `Part paid`, `Credit`:

```jsx
            label={isCredit ? 'Credit' : order.payment_status === 'pending' ? 'Unpaid' : order.payment_status === 'partial' ? 'Part paid' : 'Paid'}
```

- [ ] **Step 3: Replace the hand-built status actions**

`:170-179` builds `statusActions` from raw `status` — `Mark Preparing` / `Mark Ready` / `Complete Order` / `Cancel Order`. Replace the four status-derived pushes with the server's single decision, keeping Cancel (it is a genuine separate capability, not a stage advance, and removing it would lose functionality — staff-ux-checklist #9):

```js
  // One action, decided server-side (server/utils/order-stage.js), instead of
  // four derived from raw status here. Cancel is kept: it is not a stage
  // advance and has no nextAction equivalent.
  const statusActions = [];
  const nextAction = order?.display_stage?.nextAction;
  if (nextAction) {
    statusActions.push({ label: nextAction.label, action: nextAction, color: '#10B981', icon: 'arrow-forward-circle-outline' });
  }
  if (canManage && !['completed', 'cancelled'].includes(order?.status)) {
    statusActions.push({ label: 'Cancel Order', next: 'cancelled', color: '#E11D48', icon: 'close-circle-outline' });
  }
```

- [ ] **Step 4: Update the dispatcher**

At `:262` the handler calls `api.updateOrderStatus(order.id, nextStatus)`. It must now handle both shapes — a `nextAction` object and the legacy `next` string that Cancel still uses:

```js
      if (chosen.action) {
        await api.advanceOrder(chosen.action);
      } else {
        await api.updateOrderStatus(order.id, chosen.next);
      }
```

Adjust the surrounding `confirmAction` signature (`:80`) to carry the whole action object rather than just a status string. Keep its existing confirmation prompt — a destructive Cancel should still ask.

- [ ] **Step 5: Verify transform**

```bash
cd app && node scripts/babel-check.js src/components/QuickModals.js
```

Expected: `OK`, exit 0.

- [ ] **Step 6: Verify live**

As counter_staff at Test Loc, tap an order card on the dashboard. Confirm the modal's badge matches the card's Stage badge exactly, that there is one green forward action whose label matches the card's button, and that Cancel Order still works and still prompts for confirmation.

- [ ] **Step 7: Commit**

```bash
git add app/src/components/QuickModals.js
git commit -m "Converge OrderQuickModal onto display_stage

The modal a card opens showed raw status and four status-derived buttons
while the card showed the computed Stage. One action from nextAction now,
plus Cancel which is not a stage advance."
```

---

### Task 10: StageBadge on SaleDetail, Orders Inbox and Deliveries

**Files:**
- Modify: `app/src/screens/SaleDetailScreen.js` (its status display; `:479` and `:552` `api.updateOrderStatus` calls)
- Modify: `app/src/screens/OrdersInboxScreen.js` (list row status display)
- Modify: `app/src/screens/DeliveriesScreen.js` (row status display)

**Interfaces:**
- Consumes: `StageBadge` (Task 3), `display_stage` on `GET /deliveries` (Task 4).

- [ ] **Step 1: Locate each screen's current status rendering**

```bash
grep -n "ORDER_STATUS_LABELS\|STATUS_LABEL\|status.*toUpperCase\|BadgePill" app/src/screens/SaleDetailScreen.js app/src/screens/OrdersInboxScreen.js app/src/screens/DeliveriesScreen.js
```

Record what each renders before changing it — these screens were not read during planning beyond confirming they exist, so match each one's local badge idiom rather than assuming.

- [ ] **Step 2: Replace with StageBadge on each**

In each screen, `import StageBadge from '../components/StageBadge';` and replace the locally-derived order-status badge with:

```jsx
<StageBadge stage={order.display_stage} />
```

using each screen's own variable name for the order/sale/delivery row.

Leave alone: delivery sub-status badges on `DeliveriesScreen` that describe the *delivery's* own lifecycle for dispatch (assigned / picked up / in transit) where that is the screen's actual subject rather than a duplicate of the order stage. Replace only the badge that restates the order's status. If a given badge is ambiguous, leave it and note it — over-replacing here loses dispatch information riders and counter staff rely on.

- [ ] **Step 3: Converge SaleDetailScreen's status calls**

`:479` and `:552` call `api.updateOrderStatus` with a hand-derived next status. Where the screen already has `sale.display_stage.nextAction` available (it does — `:833` reads it), route through `api.advanceOrder(nextAction)` instead, exactly as `:511` already does. Do not remove the explicit Complete Order button's guard behaviour — `:825-833` already hides it when the inline action covers the same case.

- [ ] **Step 4: Verify transforms**

```bash
cd app && node scripts/babel-check.js src/screens/SaleDetailScreen.js src/screens/OrdersInboxScreen.js src/screens/DeliveriesScreen.js
```

Expected: three `OK` lines, exit 0.

- [ ] **Step 5: Verify live**

For one delivery order at Test Loc, open it on the dashboard card, in Orders Inbox, on SaleDetail, and on DeliveriesScreen. **All four must show the same Stage label.** A disagreement means one screen is still deriving locally — find it and fix it before committing.

- [ ] **Step 6: Commit**

```bash
git add app/src/screens/SaleDetailScreen.js app/src/screens/OrdersInboxScreen.js app/src/screens/DeliveriesScreen.js
git commit -m "Render StageBadge on SaleDetail, Orders Inbox and Deliveries

Makes display_stage the status vocabulary on every screen that shows one,
rather than a dashboard-only concept."
```

---

### Task 11: Full-branch verification

No new code. This is the gate before the work is called done.

**Files:** none modified.

- [ ] **Step 1: Babel check every touched frontend file**

```bash
cd app && node scripts/babel-check.js \
  src/constants/orderStages.js \
  src/hooks/useBreakpoint.js \
  src/components/StageBadge.js \
  src/components/orderBoard/OrderCard.js \
  src/components/orderBoard/StageColumn.js \
  src/components/orderBoard/OrderKanbanBoard.js \
  src/components/QuickModals.js \
  src/screens/DashboardScreen.js \
  src/screens/SaleDetailScreen.js \
  src/screens/OrdersInboxScreen.js \
  src/screens/DeliveriesScreen.js
```

Expected: 11 `OK` lines, exit 0.

- [ ] **Step 2: Role verification**

```bash
node server/scripts/verify-identity-roles.js
```

Expected: 10/10, unchanged from before this branch.

- [ ] **Step 3: Confirm no stale references**

```bash
grep -rn "components/OrderKanbanBoard'" app/src/ || echo "clean"
grep -rn "advanceOrderStatus" app/src/ || echo "clean"
grep -rn "ORDER_PHASE_LABELS" app/src/ || echo "clean"
```

Expected: `clean` three times. The middle one also removes the stale comment at the old board's `:454`, which referenced a function deleted in the previous plan.

- [ ] **Step 4: Confirm DashboardScreenV2 is untouched**

```bash
git diff --stat main -- app/src/screens/DashboardScreenV2.js app/src/navigation/MainNavigator.js
```

Expected: no changes to `DashboardScreenV2.js`. Spec §2 keeps it and its `pref_new_v2_ui` flag as reference.

- [ ] **Step 5: Live trace, all four order types**

At **Test Loc (`location_id 4`) only**, as counter_staff, walk one order of each type through its full ladder, confirming at each step that the Stage badge and the button label agree and that the button works:

- `walk_in`: New → Preparing → Ready → Complete
- `pre_order`: New → Preparing → Ready → Complete
- `pickup`: New → Preparing → Ready for Pickup → Confirm Pickup
- `delivery`: New → Preparing → Ready → (assign) → Out for Delivery → delivered

- [ ] **Step 6: Live trace, all four dead-end states**

Reach each deliberately and confirm the card offers the routing action, not nothing:

| State to construct | Expect on card | Tapping it opens |
| --- | --- | --- |
| Pickup, mark ready, leave balance unpaid | `Collect ₹N` | AddPayment for that sale |
| Delivery, mark ready, assign no rider | `Assign Rider` | DeliveryDetail |
| Delivery out with COD not yet collected | `Record COD` | Settlements |
| Delivery out, COD settled, as counter_staff | `<rider> has it`, no button | order detail on card tap |

- [ ] **Step 7: Re-verify the Task 1 guards end to end**

Confirm from the UI (not only curl) that a `pre_order` with an undispatched delivery cannot be completed, and that the message shown is the plain-language one, not a raw error.

- [ ] **Step 8: Responsive check**

In a desktop browser at `localhost:8081`, resize across the 900px boundary and confirm the board switches between four columns and stacked sections with no clipped content and no horizontal page scroll at any width.

- [ ] **Step 9: Commit any fixes found, then report**

Report to the user: what passed, what failed and was fixed, and anything found but deliberately left. Do not report completion with an unexplained failure.

---

## Notes for whoever executes this

- **Task 1 ships alone and first.** It is the live-data fix and Task 8's UI assumes the corrected behaviour.
- **Tasks 2, 3, 4 are independent of each other** and can be done in any order once Task 1 lands.
- **Tasks 5 → 6 → 7 → 8 are a chain** — each consumes the previous.
- **Tasks 9 and 10 are independent** of each other, both need Task 3.
- If any task reveals that a spec assumption is wrong (as planning revealed the spec's original "three mechanisms" claim was), **stop and report rather than improvising** — the spec gets corrected, then the plan.
