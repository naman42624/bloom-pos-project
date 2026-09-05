# Identity, Roles & Employee Code/PIN Login — Design Spec

**Status:** Draft for review
**Sub-project:** 2 of 10 (see `CLAUDE.md` roadmap)
**Author:** Claude, in collaboration with the shop owner
**Date:** 2026-08-30

## 1. Problem

Today every non-customer account — owner, manager, the four counter/prep staff, all three delivery riders — logs in the same way: a 10-digit phone number and a password, on `LoginScreen`. That's a reasonable model for the owner and manager, who each carry a personal phone. It's a poor fit for counter/prep staff, who share one device at the counter: typing a phone number and password every time someone's turn changes is slow, easy to fumble, and not how a non-technical first-time user of business software expects to "clock into" a shared terminal.

`role` today is a single flat string covering five real values (`owner`, `manager`, `employee`, `delivery_partner`, `customer` — verified live). `employee` is a single generic bucket: sales/counter work and floral prep work carry identical permissions today, even though they're different jobs with different reasons to touch the app (one handles money, one doesn't).

This sub-project introduces employee-code+PIN login for a shared counter device, and splits the generic `employee` role into `counter_staff` and `florist_staff` with distinct permissions — without disrupting the four real staff accounts currently logging in daily, and without touching owner/manager/rider login at all.

## 2. Goals

1. Counter and prep staff can identify themselves on a shared device in seconds — tap a name tile, enter a 4-digit PIN — with no phone number, no password, no OTP.
2. A shared device automatically protects against actions being misattributed to the wrong staff member: it locks itself after a short idle period and offers an explicit "switch user" action at any time.
3. `counter_staff` and `florist_staff` exist as real, distinct roles with different access — florist/prep staff can no longer reach checkout, payments, the cash register, or expenses, which they have no operational reason to touch.
4. None of the four existing employee accounts is disrupted. They keep working exactly as `employee` does today, unchanged, until the owner explicitly moves each one to a new role at a time of their choosing.
5. Owner and manager login is completely unaffected — phone+password, on their own personal devices, unchanged. Delivery riders are unaffected too — phone+password stays, since each rider carries their own phone and there's no "who is this" ambiguity a shared-device PIN switch would solve.

## 3. Non-goals (deferred)

- Any change to owner/manager login or permissions.
- Any change to delivery rider (`delivery_partner`) login or permissions.
- Forcing migration of the four existing employee accounts — that's an owner-paced, manual action using the existing role-change UI, not a scripted cutover.
- A generic field-level visibility mechanism (e.g. consistently hiding `products.estimated_cost` from non-owners) — that's `CLAUDE.md`'s known-debt item, addressed in sub-project 8.
- Any change to attendance/shift logic beyond the routes florist/prep staff need to clock in and view their own attendance — full attendance/shift redesign is sub-project 6.
- Multi-location staff assignment UI polish — the data model stays multi-location-capable (unchanged from today), no new UI investment here.

## 4. Data model changes (all additive)

All new columns are nullable or carry a safe default, so every existing row remains valid with zero backfill. `users.role` has no CHECK constraint in the live database (verified via `psql \d users`), so adding two new role strings is a pure addition — no migration risk on that front at all.

| Table | Change | Notes |
|---|---|---|
| `users` | `ADD COLUMN employee_code TEXT UNIQUE` | Short numeric code (e.g. 4 digits, auto-assigned sequentially starting at a fixed base like `1001`), shown to the owner/manager in `UserFormScreen`. `NULL` for every existing row and for any role that doesn't use shared-device login (owner, manager, customer, delivery_partner). |
| `users` | `ADD COLUMN pin_hash TEXT` | bcrypt hash of a 4-digit PIN. Plaintext PIN is never stored or logged anywhere, mirroring how `password` is already handled. `NULL` until the owner/manager explicitly sets one for a staff member. |
| `users` | `ADD COLUMN pin_failed_attempts INTEGER DEFAULT 0` | Soft lockout counter, reset to 0 on a successful PIN login. |
| `users` | `ADD COLUMN pin_locked_until TIMESTAMP` | `NULL` normally; set to `now() + 5 minutes` after 5 consecutive failed attempts on one account. Phone+password login is entirely unaffected by this — it's scoped to the PIN path only. |
| `users` | `ADD COLUMN job_title TEXT` | Free display label ("Counter", "Florist", "Delivery") shown on the lock-screen tile and in staff lists. Independent of `role` so tiles read naturally regardless of migration state. |

No changes to any existing column, no renames, no new CHECK constraints on existing data. Written via the project's existing idempotent `ensureColumn()` pattern in `server/config/database.js`, safe to re-run on every boot, per `.claude/skills/db-migration-safety/SKILL.md`.

**Rollout:** back up the database before deploying; the migration itself needs no backfill step since every new column is nullable/defaulted and no existing row's meaning changes.

## 5. Role model

`role` gains two new valid values: `counter_staff`, `florist_staff`. `employee` remains a fully valid, fully functional role indefinitely — it is not deprecated or scheduled for removal by this spec. The four live employee accounts stay on `employee`, working exactly as they do today, until the owner reassigns each one individually via the existing role-change flow in `UserFormScreen.js` (already built, already used for changing roles today — no new migration UI needed).

**Access model:**

| | `employee` (today, unchanged) | `counter_staff` (new) | `florist_staff` (new) |
|---|---|---|---|
| Sales, checkout, payments | ✅ | ✅ (identical to `employee`) | ❌ |
| Cash register, settlements | ✅ | ✅ | ❌ |
| Expenses | ✅ | ✅ | ❌ |
| Orders inbox, order detail (read) | ✅ | ✅ | ✅ |
| Production/prep tasks | ✅ | ✅ | ✅ |
| Stock/materials usage | ✅ | ✅ | ✅ |
| Own attendance clock in/out + own history | ✅ | ✅ | ✅ |
| Salary advance requests, outdoor-duty logging | ✅ | ✅ | ❌ (not in the approved florist scope — see below) |
| Standalone customer directory / delivery assignment (`customers.js`, `deliveries.js`) | ✅ | ✅ | ❌ |

`counter_staff` is a pure superset-preserving alias of `employee`'s current access — every backend `authorize(..., 'employee')` call site gets `'counter_staff'` added alongside it (mechanical, additive, ~45 call sites across `attendance.js`, `customers.js`, `deliveries.js`, `expenses.js`, `production.js`, `products.js`, `purchase-orders.js`, `sale-attachments.js`, `sales.js`, `settings.js`, `staff-management.js`, `stock.js`, `upload.js`). Nothing is removed from any existing call site.

`florist_staff` gets a new, narrower `authorize(..., 'florist_staff')` added only to: production/task routes, stock/materials routes, order-read routes on `sales.js` (so prep staff can see what they're making — this already surfaces any delivery/customer info embedded in an order's detail, e.g. the delivery address, without needing standalone access to `customers.js`'s directory search or `deliveries.js`'s assignment/list routes), and exactly two attendance routes: clock-in and clock-out plus viewing their own attendance history. It is explicitly NOT added to any route under `sales.js` that writes a payment, `expenses.js`, any cash-register/settlement route, `customers.js`, `deliveries.js`, or the salary-advance/outdoor-duty routes in `attendance.js` — none of those were part of the approved florist scope (view orders/production, mark prep tasks complete, log stock/materials, clock in/out), so this spec keeps them out rather than assuming they should be included.

Employee-code+PIN login (§6) is available to `employee`, `counter_staff`, and `florist_staff` — not to `owner`, `manager`, or `delivery_partner`, matching §2 goal 5.

## 6. Employee code + PIN login

### Backend

- `POST /api/auth/staff-login` — body `{employee_code, pin}`. Looks up the user by `employee_code`, rejects if role isn't one of `employee`/`counter_staff`/`florist_staff`, checks `pin_locked_until`, compares PIN against `pin_hash` via bcrypt. On success: resets `pin_failed_attempts`, issues a JWT identical in shape to today's (`{id, role}`, same `generateToken()`), returns the same response envelope `/login` returns today (`{user, token, locations}`). On failure: increments `pin_failed_attempts`, sets `pin_locked_until` once the 5th consecutive failure is reached, returns a plain-language error ("Wrong PIN — N tries left" / "Too many wrong tries — ask your manager to unlock this in 5 minutes"), never a generic 401.
- `GET /api/auth/staff-roster?location_id=` — unauthenticated by design (it's the screen shown *before* anyone is logged in). Returns only `[{id, name, avatar, employee_code, job_title}]` for active (`is_active=1`) staff with role in `employee`/`counter_staff`/`florist_staff`, scoped to one location. No PIN, phone, email, or any other field. This is the one deliberate exception to "everything requires auth" in the app — explicitly approved by the owner as acceptable given it's equivalent to a staff roster that could already hang on a physical wall at the shop.
- `PUT /api/users/:id/pin` — owner/manager only, sets or resets a staff member's PIN (hashes and stores it, clears any lockout). Used the first time a staff member is migrated to a code+PIN-capable role, and whenever a PIN needs resetting (forgotten PIN — no self-service recovery flow, matching the "ask your manager" pattern already used for account deactivation).
- `users.js` staff-CRUD extended: `POST /api/users` auto-generates `employee_code` when creating a `counter_staff`/`florist_staff` account; `role` validator accepts the two new values.

Because `staff-login` issues the exact same JWT shape `/login` does, `authenticate` middleware and every existing `authorize()` call needs zero changes to understand a PIN-authenticated session — it's indistinguishable from a phone+password session once issued.

### Frontend

- `AuthContext` gains a `locked` boolean (`true` on cold start until first unlock) and a `staffLogin(code, pin)` action mirroring today's `login()` — same `AsyncStorage` writes, same dispatch shape, so the rest of the app (which only ever reads `user`/`token`/`isAuthenticated`) needs no changes.
- A root-level activity tracker updates a last-activity timestamp on any touch/navigation event; a short interval (checked, not polled aggressively) flips `locked = true` after ~2–3 minutes of inactivity. A "Switch User" button, visible in the header for any `employee`/`counter_staff`/`florist_staff` session, flips it immediately. Backgrounding briefly (e.g. answering a call) does not lock — only sustained idle time or an explicit action does.
- New `LockScreen.js`: fetches `staff-roster` for the device's configured location, renders name/avatar tiles (large tap targets, per the staff-UX-checklist) plus a small "Owner/Manager login" text link that drops to the existing `LoginScreen` unchanged. Tapping a tile shows a large numeric PIN pad with the tapped name shown for confirmation; on success, calls `staffLogin()`, which behaves exactly like today's `login()` for every screen downstream.
- `UserFormScreen.js`'s existing role-selection grid gets two new entries (`Counter Staff`, `Florist/Prep Staff`), following the exact icon/color pattern already used for the other four roles. When a role in the PIN-capable set is selected, the form shows the (read-only, auto-generated) employee code and a "Set/Reset PIN" action — owner/manager only, matching who can already change roles today.
- `MainNavigator.js`: `counter_staff` reuses every tab/stack `employee` gets today, unchanged. `florist_staff` gets its own scoped stack (Orders-read, Production, own Attendance) — modeled directly on the `EmployeeOrdersStack` pattern already built in sub-project 1 — with no POS/Checkout/Expenses/Settlements tabs.

## 7. Security notes

- PINs are 4 digits (10,000 combinations) — the soft lockout (5 attempts / 5-minute cooldown) exists specifically because that space is small enough to matter, even though the stakes are low for a small shop's shared device.
- The unauthenticated roster endpoint is a deliberate, scoped exception (§6) — it leaks a staff name/photo directory, nothing else. If this ever needs tightening (e.g. multiple retail locations with public-facing tablets), a device-pairing step can be added later without breaking this design.
- `florist_staff`'s exclusion from payments/cash-register/expenses is enforced server-side via `authorize()`, not just hidden client-side navigation — a florist-role token hitting a checkout endpoint directly gets a 403, the same guarantee every other role boundary in this app already has.
- **Risk correction (added after the final whole-branch review flagged the original framing as understated):** `employee_code`, returned unauthenticated by `staff-roster`, is not purely display data the way a name/photo directory is — combined with a 4-digit PIN, it's effectively half of a login credential. The per-account lockout (5 attempts / 5-minute cooldown) is what actually bounds the risk (≈60 guesses/hour against a 10,000-value PIN space), not the roster's obscurity. Accepted as low-risk for a single-location shop; reconsider if a second, more publicly-accessible location ever gets its own shared device.

## 8. Testing/verification

Same process as sub-project 1: implementers write focused tests for new logic (PIN hashing/lockout, `staff-login`/`staff-roster` endpoints, the new `authorize()` boundaries); each task's reviewer independently re-verifies claims against the diff and, for the money/permission-sensitive pieces (the `florist_staff` boundary, PIN lockout), live-tests against the real dev DB rather than trusting mocks. A final whole-branch review happens before handoff.

No agent can interactively exercise the actual idle-timer/touch-based lock trigger, or the full tap-name → enter-PIN flow on a real device — flagged for the owner's own device testing, same pattern as sub-project 1's voice notes and `LogOrderScreen`.

## 9. Rollout

1. Ship the schema additions and backend routes/permission changes — no visible change to any existing user yet (`employee` role and phone+password login for everyone continue working exactly as today).
2. Ship the frontend (lock screen, role picker additions, florist stack) — the shared counter device can now be configured to boot into the lock screen; owner/manager logins remain unaffected on their own devices.
3. Owner reassigns each of the 4 existing employee accounts to `counter_staff` or `florist_staff` at their own pace, setting an employee code + PIN for each as they go. Until an account is reassigned and given a PIN, it simply keeps logging in with phone+password as `employee` — no forced cutover, no window where anyone is locked out.
