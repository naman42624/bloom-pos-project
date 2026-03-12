# SQLite to PostgreSQL Migration Guide

This guide walks through setting up PostgreSQL locally and migrating from SQLite.

## Step 1: Install PostgreSQL on macOS

```bash
# Install PostgreSQL using Homebrew
brew install postgresql@16

# Start PostgreSQL service
brew services start postgresql@16

# Verify installation
psql --version
```

## Step 2: Create Database and User

```bash
# Connect to PostgreSQL as default user
psql postgres

# Inside psql console, run:
CREATE USER bloomcart WITH PASSWORD 'bloomcart_local_2026';
CREATE DATABASE bloomcart OWNER bloomcart;
GRANT ALL PRIVILEGES ON DATABASE bloomcart TO bloomcart;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO bloomcart;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO bloomcart;

# Exit psql
\q
```

## Step 3: Load PostgreSQL Schema

```bash
# Connection details:
# Host: localhost
# Port: 5432
# Database: bloomcart
# User: bloomcart
# Password: bloomcart_local_2026

cd /path/to/project/server

# Load the PostgreSQL schema
psql postgresql://bloomcart:bloomcart_local_2026@localhost:5432/bloomcart \
  -f config/schema.sql
```

## Step 4: Update Environment Variables

Create a `.env` file in the `server/` directory:

```bash
NODE_ENV=development
PORT=3001

# PostgreSQL (replaces SQLite)
DATABASE_URL=postgresql://bloomcart:bloomcart_local_2026@localhost:5432/bloomcart

# Redis (optional for caching/Bull jobs)
REDIS_URL=redis://localhost:6379/0

# Auth
JWT_SECRET=your-local-dev-secret-change-this
JWT_EXPIRES_IN=7d

# CORS
ALLOWED_ORIGINS=*

# File storage (optional for now)
S3_BUCKET=your-bucket
S3_REGION=ap-south-1
S3_ACCESS_KEY=your-key
S3_SECRET_KEY=your-secret
S3_ENDPOINT=https://your-region.digitaloceanspaces.com
```

## Step 5: Migrate Data from SQLite to PostgreSQL

```bash
cd /path/to/project/server

# Run the migration script
node scripts/migrate-sqlite-to-pg.js
```

The script will:
- Export all data from SQLite
- Transform types (INTEGER→BOOLEAN, TEXT→JSONB, etc.)
- Import into PostgreSQL
- Reset sequences to match SQLite IDs

## Step 6: Verify Migration

```bash
# Check table counts in PostgreSQL
psql postgresql://bloomcart:bloomcart_local_2026@localhost:5432/bloomcart

# Inside psql:
SELECT schemaname, tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema');

# Count records in key tables
SELECT COUNT(*) FROM users;
SELECT COUNT(*) FROM sales;
SELECT COUNT(*) FROM deliveries;
SELECT COUNT(*) FROM attendance;

# Exit
\q
```

## Step 7: Update Application Code

Your app is already configured to use the DATABASE_URL. Just ensure:

1. No hardcoded SQLite paths in code
2. All queries use parameterized statements (`$1`, `$2`, etc.)
3. Install pg package: `npm install pg`

## Step 8: Start the Server with PostgreSQL

```bash
cd /path/to/project/server

# Install dependencies if needed
npm install

# Start server
npm run dev

# Server should log:
# ✅ PostgreSQL database connected
```

## Troubleshooting

**PostgreSQL not starting?**
```bash
brew services restart postgresql@16
ps aux | grep postgres
```

**Connection refused?**
```bash
# Check if PostgreSQL is listening
lsof -i :5432

# Start PostgreSQL if not running
brew services start postgresql@16
```

**Schema loading errors?**
```bash
# Try loading with verbose output
psql postgresql://bloomcart:bloomcart_local_2026@localhost:5432/bloomcart \
  -f config/schema.sql \
  --echo-errors
```

**Foreign key violations during migration?**
- The migration script handles this by disabling/re-enabling constraints
- Check the migration logs for specific tables

**Sequence mismatch after migration?**
- The script runs `SETVAL` to reset all sequences to match SQLite IDs
- If IDs don't match, verify `schema.sql` has correct SERIAL columns

## Rolling Back to SQLite

If needed to revert:

```bash
# Your original SQLite database is preserved as server/database.sqlite
# Just remove the DATABASE_URL env var or point it back to SQLite

# In database.js, the code detects DATABASE_URL and uses either:
# - PostgreSQL if DATABASE_URL is set
# - SQLite if DATABASE_URL is not set
```

## Performance Differences

PostgreSQL vs SQLite (after migration):

| Aspect | SQLite | PostgreSQL |
|--------|--------|------------|
| Connection pool | Single | Multiple (default: 20) |
| Concurrent writes | Limited | Much better |
| Full text search | Builtin | Native support |
| JSON querying | GETVAL | Native JSONB |
| Max DB size | Limited | Unlimited |

## Next Steps

1. ✅ Test all CRUD operations with PostgreSQL
2. ✅ Run the full test suite against PostgreSQL
3. ✅ Monitor performance
4. ✅ Deploy to DigitalOcean Managed PostgreSQL (production)

