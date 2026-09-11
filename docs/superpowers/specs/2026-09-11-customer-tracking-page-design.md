# Customer order tracking page — design

**Sub-project:** completes the "customer order tracking link" concept named in the original combined foundation doc (`docs/superpowers/specs/2026-09-05-order-list-screens-redesign-design.md` §5) — that doc shipped the backend half only (signed token, `GET /api/track/:token`, `tracking_url` on every sale row, the `tracking_link` WhatsApp message template) and deliberately deferred the destination page. This doc builds that page and wires the one screen ready for it today.

## 1. What already exists (verified, not assumed)

- `server/utils/tracking-token.js` — HMAC-signed, unstored token (`<saleId>.<sig>`), `verifyTrackingToken()` never distinguishes failure reasons (generic 404 either way, no probing signal), `buildTrackingUrl(saleId)` → `${PUBLIC_APP_URL}/track/<token>`.
- `server/routes/track.js` — `GET /api/track/:token`, fully unauthenticated, already registered. Returns exactly `sale_number`, `order_type`, `stage_label`, `scheduled_date`, `scheduled_time`, `location_name` — deliberately excludes money, address, phone numbers, staff/rider names. This shape is not open for revision here; it was a closed decision in the earlier phase.
- `app/src/utils/contact.js`'s `buildMessage('tracking_link', { sale_number, tracking_url })` → `"Hi, you can track your order {sale_number} here: {tracking_url}"` — already written, never called from anywhere yet.
- `tracking_url` is already present on every row `GET /sales` and `GET /deliveries` return.
- **What does not exist, confirmed by reading the actual navigation entry point:** any route, screen, or bypass mechanism for an unauthenticated visitor. `app/App.js` → `AuthProvider` → `RootNavigator` unconditionally gates on `isAuthenticated`; there is no `linking` config and no public screen anywhere. A customer opening the link today lands on the login screen.

## 2. Scope

Two independent pieces:
1. A new public `TrackingScreen` plus the routing bypass that lets it render for an unauthenticated web visitor at `/track/:token`, without going through login.
2. Wiring a "Share Tracking Link" action into `OrdersInboxScreen.js` (the only order-list screen stable enough to touch safely right now — `DeliveriesScreen.js` is mid-implementation in a concurrent session; `PickupOrdersScreen.js` gets this as part of its own not-yet-started implementation, using the exact same pattern this doc establishes).

## 3. The routing bypass

Web-only (this link is only ever opened in a phone's browser from a WhatsApp message — never inside the staff app itself, which has no comparable native deep-link registered and doesn't need one). `App.js` checks, before rendering `AuthProvider`/`RootNavigator` at all:

```js
const isTrackingLink = Platform.OS === 'web' && typeof window !== 'undefined'
  && /^\/track\/[^/]+$/.test(window.location.pathname);
```

When true, render `<TrackingScreen token={window.location.pathname.split('/track/')[1]} />` directly and return — no `AuthProvider`, no `RootNavigator`, no navigation container at all. This is deliberately the most isolated possible implementation: zero shared state with the authenticated app, zero risk of a session/context bug leaking staff-only behavior onto a public page, and it matches how this app already reasons about `Platform.OS === 'web'`-gated code elsewhere (`RootNavigator.js`'s own wheel/scroll handling).

**Why not React Navigation's own `linking` prop:** the existing structure has two conditionally-rendered `NavigationContainer`s already (unauthenticated vs. main), gated on `isAuthenticated` from `AuthContext`. Threading a third, fully-public path through that same context/provider tree risks the exact kind of subtle auth-state leakage this needs to avoid entirely. A route that never mounts `AuthProvider` in the first place is a stronger, simpler guarantee than a route that mounts it and is merely never shown a login prompt.

## 4. `TrackingScreen`

- New file, `app/src/screens/TrackingScreen.js` — a plain React component, no navigation prop, no `useAuth()`. Takes `token` as a prop.
- Fetches via the existing `api.js` singleton (confirmed safe to reuse standalone: `this.token` defaults `null`, the `Authorization` header is only ever attached `if (this.token)` — reusing it here needs no `AuthProvider` and sends no credential). New method `api.getTrackingInfo(token)` → `GET /track/${token}` (not `/api/track/...` — `API_BASE_URL` already includes `/api`).
- Three states:
  - **Loading**: a simple centered spinner, no branding chrome needed for a sub-second wait.
  - **Not found** (404, covers both "malformed token" and "wrong signature" — the backend already collapses both into one generic response, and the page must not try to distinguish them either): a plain, friendly message — "We couldn't find this order. The link may be out of date — please contact the shop." No technical detail, no order/token echoed back.
  - **Found**: sale number, a friendly rendering of `stage_label` (see below), scheduled date/time if present (formatted, shop timezone — reuse `formatShopDateLabel`/`formatTime` from `app/src/utils/datetime.js`, which have zero `AuthContext`/navigation dependency and are safe to import standalone), and `location_name`.
- **Status presentation**: a simple horizontal step indicator (Received → Preparing → Ready/Out for Delivery → Delivered/Picked Up), highlighting wherever `stage_label` currently falls, rather than just printing the raw label — a completely new visitor reading this on a phone screen with zero context needs the CURRENT step to be visually obvious against the whole journey, not just a word. `stage_label`'s possible values are enumerable from `computeOrderStage()`'s own label set (`server/utils/order-stage.js`) — the implementation plan maps each to one of 4 visual steps; a `cancelled` order gets its own distinct (non-stepped) treatment, not force-fit into the journey.
- No shop branding/logo asset exists to reuse today — the page's own primary color can borrow `Colors.primary` (`app/src/constants/theme.js`, importable standalone, no context dependency) for visual consistency with the rest of the app without needing new assets.
- Mobile-first layout (this is read on a phone browser, full stop) — no responsive breakpoint complexity needed, design for one column, comfortably large text.

## 5. Share Tracking Link in Orders Inbox

- A small standalone icon button, placed in the row's `actionsRow` next to `ContactButtons` — **not** folded into `ContactButtons` itself, since that component is already shared by Dashboard/`OrderCard.js` and `SettlementsScreen.js`, and this action is conceptually distinct (share a link, not contact a person) and was always scoped as "a separate icon" in the original (cut) design.
- `onPress`: `Linking.openURL(waLink(item.customer_display_phone || item.customer_phone, buildMessage('tracking_link', { sale_number: item.sale_number, tracking_url: item.tracking_url })))` — reuses `waLink`/`buildMessage` from `contact.js` exactly as `ContactButtons` already does, no new WhatsApp-link logic.
- Only rendered when `item.tracking_url` and a usable customer phone both exist (mirrors `ContactButtons`' own "nothing to show" empty-render rule — never a dead button).
- 44×44pt tap target, matching every other icon action on this screen.

## 6. Explicitly out of scope

Adding this to `DeliveriesScreen.js` (concurrent session, deliberately untouched) or `PickupOrdersScreen.js` (not yet implemented — gets it as part of that screen's own plan, reusing `TrackingScreen`/the button pattern this doc establishes, not re-designed). A shop logo/branding asset. Live order-tracking push updates (the page is a static snapshot on load, matching what the backend endpoint already provides — no polling, no websocket, consistent with the "no offline-first / no over-engineering" spirit of this app's constraints).

## 7. Testing / verification approach

`node app/scripts/babel-check.js` on every touched/created file. A plain-Node script isn't meaningful for `TrackingScreen` itself (no pure logic to unit-test beyond the stage→step mapping, which does get one). Live manual trace as the final task: open a real `tracking_url` in an actual browser tab with no session/cookies (private/incognito window, to genuinely simulate a customer with no login), confirm it renders without ever touching the login screen; confirm an invalid token shows the friendly not-found state; confirm the Share Tracking Link button in Orders Inbox produces a working WhatsApp deep link with the right message and a working destination URL.
