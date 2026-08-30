---
name: db-migration-safety
description: Use before writing or running any database schema change in this project (new column, new table, altering server/config/database.js, or any SQL migration) — this app runs on live production data that must never be lost or corrupted.
---

# DB Migration Safety (Petal / BloomCart POS)

This project's database is live and in daily use at a real shop counter. There is real customer, order, payment, and attendance history in it. A previous redesign attempt already let the schema drift badly (see `CLAUDE.md`'s "Known structural debt" — `schema.sql` is dead, the real schema is 116 ad-hoc runtime patches in `database.js`). That history is exactly what this skill exists to prevent repeating.

## The rule

**Every schema change is additive-only, unless the user has explicitly approved a specific destructive change in the current conversation.** Additive means: new columns (nullable or with a safe default), new tables, new indexes. It never means, without explicit sign-off: `DROP COLUMN`, `DROP TABLE`, `RENAME`, narrowing a type, adding a `NOT NULL` to an existing populated column without a backfill step, or changing a CHECK constraint in a way that could reject rows that already exist.

## Before writing any migration

1. **Read the actual current schema from the live code**, not from `schema.sql` (it's dead/stale). Check `server/config/database.js`'s `ensureCoreTables()` and `ensureCompatibilityColumns()` for what columns/constraints really exist, and cross-reference with what the route files (`server/routes/*.js`) actually read/write.
2. **Check whether the table already holds live data** you don't have direct visibility into (assume yes for anything user-, order-, payment-, or attendance-related unless proven otherwise). If a change could affect existing rows, say so explicitly to the user before proceeding — don't silently proceed on an assumption.
3. **Plan the change as additive.** If a column needs to change meaning or type, add a new column alongside the old one, migrate/backfill data with a reviewable script, and only remove the old column in a separate, explicitly-approved follow-up step — never in the same change.

## Writing the migration

- Follow the existing pattern in `database.js`: idempotent (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS` equivalents via the project's `ensureColumn()` helper), safe to re-run on every boot.
- Prefer nullable new columns or ones with a sensible `DEFAULT` so existing rows remain valid without a backfill. If a backfill is genuinely required, write it as an explicit, reviewable step (a script or a clearly-commented block) — never assume it can be skipped.
- Do not touch `schema.sql` as if it were authoritative — either leave it alone, or (only if the user asks for schema documentation to be brought back in sync) update it as a documentation exercise separate from the actual runtime migration.
- Do not add to the dual-DB-access-layer problem: prefer `database-async.js`'s async `pg.Pool`-based `getDb()` for new code. Don't introduce new usage of the sync `spawnSync`-based layer in `database.js`.

## Before running against real data

1. **Back up first.** Confirm a recent backup/dump exists (or take one — `pg_dump`) before running any migration against the real database, not just against a local/dev copy.
2. **Test the migration on a copy of production data if at all possible**, not only against an empty or synthetic dev database — drift between "works on empty schema" and "works on 6 months of real rows" is exactly the failure mode this project has already suffered from once.
3. **State clearly to the user, before running**: what tables/columns are touched, whether it's additive or not, and what the rollback looks like if something goes wrong. Never run a schema change against production silently as a side effect of an unrelated task.

## Red flags — stop and ask the user before proceeding

- A migration that would `DROP` or `RENAME` anything.
- A migration whose `ensureColumn`/`ALTER` could fail or behave unexpectedly on rows that already exist (e.g. a new `NOT NULL` column with no default on a populated table).
- Any temptation to "just clean this up while I'm here" on a table unrelated to the current task's actual need — scope creep into schema changes is how the current drift happened in the first place.
