# CLAUDE.md — Petal (flower shop operations app)

This file loads automatically every session. It exists so decisions made once don't have to be re-argued or re-discovered from scratch. If you (Claude) get corrected on the same thing twice, add a line here rather than relying on conversation memory.

## What this is

An internal operations app for a flower shop: multi-employee, multi-channel orders (WhatsApp, website, email, walk-in), in-house delivery. **It is live and in daily use at the counter** — this is not a greenfield project. Currently mid-redesign: fixing order flow, staff/employee identity, cash register, settlements, and attendance, which are inconsistent/broken in practice despite being previously marked "complete" (`PROGRESS.md` tracked 241/270 tasks across 10 phases before this redesign started).

## Stack — do not change without explicit user approval

- **Backend**: Express.js + JWT auth + PostgreSQL via `pg` (`server/`).
- **Frontend**: Expo (React Native) + React Navigation (not Expo Router). Targets iOS, Android, web from one codebase.
- Two reference docs were consulted for ideas: `/Users/gauravbhatia/Downloads/files/petal-prd.md` and `build-plan.md`. Their **concepts** are being adapted (unified order inbox, channel tag, buyer≠recipient, cost/margin separation, PIN quick-switch). Their **stack** (Supabase, Row-Level Security, Expo Router, TypeScript, NativeWind, offline-first sync) is explicitly NOT being adopted — this project stays on Express/JWT/pg. Don't suggest migrating to Supabase/RLS.

## Non-negotiable constraints

1. **Live production data — never lose it.** Every schema change is additive-only: new columns, new tables. Never `DROP`/`RENAME`/restructure a table or column already holding live data without an explicit, separately-approved migration plan with a backup taken first. Read the `db-migration-safety` skill before writing any migration touching `server/config/database.js` or any SQL migration file.
2. **Users are non-technical, first-time users of any business software.** Counter staff, florists, and riders have never used an app like this before. Every staff-facing flow must be obvious with zero training. Read the `staff-ux-checklist` skill before finalizing any staff-facing screen or flow design.
3. **No offline-first requirement.** Shop connectivity is reliable — don't build a local-write-queue/background-sync system; a simple retry/error message on a dropped request is sufficient.
4. **Customer self-ordering stays in scope.** Do not remove `CustomerShopScreen.js` or the `customer` role — the user explicitly chose to keep this, diverging from the reference PRD's staff-only stance.
5. **Approach is repair-in-place, not a rewrite.** Reuse working modules (inventory, products/QR, POS cart fundamentals) rather than rebuilding them. See the project memory file for the full decision log if more history is needed.

## Target role model (migrating to this from today's single generic "employee" role)

Owner · Manager · Sales/Counter Staff · Florist/Prep Staff · Delivery Rider · Customer.

- Manager: team-wide sales visibility; cost/margin data hidden by default (owner can toggle it on).
- Staff login: **employee code + PIN** on a shared counter device, fast identity switch, no OTP dependency. Owner/Manager keep phone + password on their own personal devices. (Today: no employee_code/PIN concept exists at all — everyone logs in with phone+password.)

## Locations

Single location today, expanding soon. Keep the data model multi-location-capable (it already is) but don't over-invest in multi-location UI polish yet.

## Order channels (real today, not aspirational)

WhatsApp, Website, Email, Walk-in/Phone. None need API integration — website orders are logged manually by staff exactly like WhatsApp/email. All four need a `channel` tag distinct from fulfillment type (`order_type`), which doesn't exist yet.

## UX design principles — every staff-facing screen, no exceptions

- Assume the person has never used a business app before in their life. No jargon, no hidden gestures, no multi-level menus for anything done daily.
- Big tap targets, large legible text, one clearly primary action per screen.
- The common-case path must be the *shortest* path. A plain counter sale target: well under 6 taps, well under 30 seconds.
- **Never cut functionality for the sake of simplicity.** Rare/advanced actions can live one level deeper (not deleted) — simple ≠ stripped-down.
- Prefer showing over asking: sensible defaults, pre-filled fields, remembered last choices (e.g. last channel used) over blank forms demanding input.
- Errors say what to do next in plain language ("Register isn't open — tap here to open it") never a technical message.
- See the `staff-ux-checklist` skill for the concrete pre-ship checklist to run any new/changed staff screen through.

## Roadmap — sub-projects, in priority order

Order-side work is first because the app is live at the counter and that's today's acute pain. Each sub-project gets its own brainstorm → design doc (`docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`) → implementation plan → build cycle. Update the status marker here as phases complete.

1. **Order model, channel & unified inbox** — done, merged to `main` (PRs #1 and #2)
2. **Identity, roles & employee code/PIN login** — done, PR raised from `feature/identity-roles-pin-login` (#3, not yet merged)
3. **POS/checkout integrity** ← current — move register-open enforcement server-side at every cash-payment-write site (sale creation, pickup completion, settlement creation/verification, sale-edit payments, refunds, add-payment), not just sale creation. Card/UPI payments never need this check — only `method='cash'` writes affect `expected_cash`. See `docs/superpowers/specs/2026-08-22-order-channel-model-design.md` §8 for the verified list of existing call sites. **Also fold in:** `GET /api/expenses` and `GET /api/purchase-orders` have no `authorize()` guard at all today — only `authenticate` — so `role='customer'` (and any other authenticated role) can currently read expense and purchase-order data. Found and confirmed live during sub-project 2's final review; predates that sub-project, unrelated to it, correctly left untouched there as out-of-scope for a different sub-project's files. (`GET /api/sales` has the same lack of a role guard, but that one was previously reasoned about and deliberately accepted — order detail isn't sensitive the same way; expenses/purchase-order cost data is. This is a real gap, not an accepted tradeoff.)
4. Cash register & settlement reconciliation
5. Task assignment & delivery workflow
6. Attendance & shift management
7. Customer CRM (careful — live data, see constraint 1)
8. Catalog/inventory + reporting, consistent cost/margin enforcement
9. UI/UX design pass (frontend-design skill, once flows are correct)
10. Technical debt cleanup (schema drift, dual DB access layers, repo clutter) — opportunistic, not blocking

## Known structural debt — don't be surprised by this, and don't "fix" it accidentally as a side effect of other work

- `server/config/schema.sql` is **dead** — never loaded at runtime, don't trust it as ground truth. The real live schema is assembled by `server/config/database.js`'s `ensureCoreTables()` plus **116 idempotent `ensureColumn()` patch calls** run on every server boot, which have silently added/renamed columns and dropped CHECK constraints over time.
- **Two DB access layers coexist**, sometimes in the same route file: `database.js`'s `getDb()` shells out to the `psql` binary via `spawnSync` **per query** (sync, subprocess per call — a likely real performance cost); `database-async.js`'s `getDb()` is a proper async `pg.Pool`. Prefer the async layer for any new/touched code; don't expand use of the sync one.
- A `customers` table exists in `database.js` but is **dead/unused** — `server/routes/customers.js` reads/writes `users` (role='customer') exclusively. Don't assume the `customers` table holds real data, and don't touch it without checking first — leave it alone unless a specific task calls for cleaning it up.
- Cash-register-open enforcement exists only client-side in `QuickCheckoutScreen.js` (a "register guard" before checkout) — not server-side, and not covering every sale-creation path (e.g. the customer self-order endpoint, the recurring-order processor).
- Two parallel dashboards coexist: `DashboardScreen.js` and `DashboardScreenV2.js`, toggled by a settings flag. Old one (V1) not yet removed.
- `products.estimated_cost` is currently **not** role-filtered — visible to every authenticated role today, unlike `materials.avg_purchase_cost` which is correctly owner-only. This directly contradicts the "no sensitive data to employees" requirement and needs fixing (sub-project 8; sub-project 2 concluded without touching this).
- The 4 live `employee` accounts stay on `employee` until the owner manually promotes each to `counter_staff`/`florist_staff` via the existing role-change UI (`UserFormScreen.js`, no forced migration) — expect `employee` to coexist with the two new roles indefinitely, not a transitional state to "clean up."
- `useIdleLock`'s touch-based activity signal (added during sub-project 2's final review to fix a lock-mid-task bug) only reaches React Native `Modal` content on `QuickCheckoutScreen.js` — the same gap exists in principle across ~27 other screens that use `Modal` (checked via `grep -rl "<Modal" app/src/screens/*.js`). `bumpActivity` is exported from `app/src/hooks/useIdleLock.js` and ready to wire into any of them (`onTouchStart={bumpActivity}` on the modal's outer content view) — opportunistic follow-up, not blocking.

## Reference material

- `/Users/gauravbhatia/Downloads/files/petal-prd.md`, `build-plan.md` — conceptual reference only; wrong stack, don't follow literally.
- `PROGRESS.md` — history of what was built before this redesign.
- `ORDER_STATUS_AND_FLOW_ANALYSIS.md`, `docs/STATUS_LIFECYCLE_ALIGNMENT_2026-04-04.md`, `docs/ATTENDANCE_SHIFT_FLOW_ANALYSIS_2026-04-04.md` — prior gap-analysis docs, still relevant.
