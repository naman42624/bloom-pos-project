# Mutation Testing Summary

## Objective
Validate **all supported mutation endpoints** (`POST`, `PUT`, `DELETE`, `PATCH`) after PostgreSQL migration and adapter changes, with a primary regression guarantee:

- No mutation endpoint should return unexpected `5xx` errors.

## Scope Covered
- Source of truth: all mutation handlers discovered from `server/routes/*.js`.
- Total mutation endpoints discovered and tested: **105**.
- Endpoint families covered:
  - auth, users, locations, settings
  - categories, materials, suppliers, purchase-orders, stock
  - products, sales, expenses, customers
  - production, deliveries, delivery-tracking
  - recurring-orders, attendance, staff-management, notifications

## Test Strategy
1. Enumerate all mutation routes automatically from route files.
2. Build full API paths using server route mounts.
3. Replace route params with safe IDs (`999999`) to avoid destructive changes.
4. Run each endpoint with:
   - owner auth token when required,
   - minimal payload or endpoint-specific override payload.
5. Classify results:
   - **Pass**: any non-5xx response (`2xx/3xx/4xx`) 
   - **Fail**: any `5xx` or network failure.

This approach is designed for **regression safety** and backend stability, not business-data seeding.

## Final Run Result
- Total tested: **105**
- Passed (non-5xx): **105**
- Failed (5xx/network): **0**
- Status histogram: `200: 8, 201: 2, 400: 48, 403: 9, 404: 38`

## Why many 4xx are expected
Many routes intentionally returned validation/auth/not-found responses because tests used safe IDs and minimal payloads. That is expected and confirms:
- authorization guards are active,
- validation is enforced,
- no internal server crashes under invalid input.

## High-Value Mutation Successes Confirmed
Examples of successful mutation behavior in this run:
- `POST /api/auth/login` → `200`
- `POST /api/auth/register` → `201`
- `PUT /api/auth/profile` → `200`
- `POST /api/sales/register/open` → `201`
- `PUT /api/sales/register/close` → `200`
- `POST /api/notifications/register-token` → `200`
- `DELETE /api/notifications/unregister-token` → `200`
- `PUT /api/notifications/read-all` → `200`

Additionally, a direct functional check for sales creation was validated separately:
- `POST /api/sales` → `201` with created `sale_id` and `sale_number`.

## Artifacts Generated
- Detailed endpoint-by-endpoint report:
  - `server/MUTATION_TEST_REPORT.md`
- Mutation regression runner script:
  - `server/scripts/mutation-regression.js`
- NPM command:
  - `npm run test:mutations`

## Happy-Path Chained Mutation Suite (Completed)
A second-stage business-flow suite is now implemented and executed to validate successful chained writes across modules.

- Steps executed: **33**
- Passed: **33**
- Failed: **0**
- Report: `server/MUTATION_HAPPY_PATH_REPORT.md`
- Script: `server/scripts/mutation-happy-path.js`
- NPM command: `npm run test:mutations:happy`

Covered chain includes:
- register lifecycle (`status` → `open` → `close`),
- category → material → product → product-material link,
- customer create/update + address + special-dates lifecycle,
- expense create/delete,
- sale create + additional payment + cancel,
- notification token register/read/unregister flow.

During this happy-path run, PostgreSQL compatibility gaps in notification async post-send logic were identified and fixed.

## Domain Procurement/Production Suite (Completed)
A third-stage strict domain-flow suite is now implemented and executed to validate procurement/manufacturing chains with data assertions.

- Steps executed: **24**
- Passed: **24**
- Failed: **0**
- Report: `server/MUTATION_DOMAIN_CHAIN_REPORT.md`
- Script: `server/scripts/mutation-domain-procurement-production.js`
- NPM command: `npm run test:mutations:domain`

Covered chain includes:
- supplier create + material pricing link,
- purchase order create + partial receive + full receive,
- material stock delta assertions,
- product BOM mapping + pickup sale creation,
- production task pick/start/complete lifecycle,
- sale status/`stock_deducted` transition assertions.

This run surfaced and resolved PostgreSQL compatibility issues in supplier-material linking, PO receive stock updates, and non-negative stock deduction expressions.

## How to Re-run
From `server/`:

```bash
npm run test:mutations
npm run test:mutations:happy
npm run test:mutations:domain
```

Ensure server is running on `http://localhost:3001` and owner credentials are valid in `.env` defaults or via:

- `SMOKE_OWNER_PHONE`
- `SMOKE_OWNER_PASSWORD`
- `API_BASE_URL`
