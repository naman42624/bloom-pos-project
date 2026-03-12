# PostgreSQL Runtime Status Report (2026-03-13)

## Executive Summary
PostgreSQL runtime cutover is now complete, SQLite runtime dependencies/files have been removed, and endpoint smoke validation is passing with no unexpected 5xx errors.

## Completed Changes

1. Replaced active DB adapter in `server/config/database.js` with PostgreSQL-backed adapter.
2. Removed SQLite runtime dependency (`better-sqlite3`) from `server/package.json`.
3. Removed SQLite data/artifact files:
  - `server/database.sqlite`
  - `server/database.sqlite-shm`
  - `server/database.sqlite-wal`
  - `server/config/database.sqlite.js.bak`
4. Removed one-time SQLite migration scripts:
  - `server/scripts/smart-migrate.js`
  - `server/scripts/migrate-sqlite-to-pg.js`

## PostgreSQL Credentials (Verified)
- Host: `localhost` (or `127.0.0.1`)
- Port: `5432`
- Database: `bloomcart`
- User: `bloomcart`
- Password: `bloomcart_local_2026`

## Additional Compatibility Fixes Applied

- Fixed deliveries route shadowing by constraining dynamic ID routes to numeric IDs.
- Updated PostgreSQL-incompatible SQL in reports/production/delivery-tracking routes:
  - strict `GROUP BY` compliance
  - SQLite datetime/date syntax replacements
  - SQLite scalar `max(x, y)` replacement with PostgreSQL `GREATEST(x, y)`

## Validation Result

`server/scripts/api-smoke-test.js` final run:
- Total checks: `35`
- Unexpected 5xx errors: `0`
- Acceptable statuses observed: 200/400/404 (validation and not-found cases)
