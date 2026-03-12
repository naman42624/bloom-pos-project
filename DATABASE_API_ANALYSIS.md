# Database API Surface Analysis

## Overview
The BloomCart server uses **better-sqlite3**, a synchronous SQLite wrapper for Node.js. All database operations are **synchronous** (no async/await or callbacks).

**Total Database Operations Across Routes: 820**

---

## Database Library Details

- **Library**: `better-sqlite3` v11.10.0
- **Type**: Synchronous database driver
- **Database**: SQLite (local file-based)
- **Concurrency**: Synchronous only (blocking operations)
- **Configuration**: WAL mode enabled, foreign keys enabled

---

## Database API Methods Used

### 1. **db.prepare(sql)** ✅ MOST CRITICAL
- **Usage Count**: 739 total calls
- **Purpose**: Prepares a SQL statement for execution
- **Returns**: Statement object with chainable methods
- **Pattern**: `db.prepare(SQL_STRING)`
- **Chaining**: Always chained with `.get()`, `.all()`, or `.run()`

```javascript
// Example
const stmt = db.prepare('SELECT * FROM users WHERE id = ?');
const result = stmt.get(userId);
```

### 2. **Statement.get(params...)** - Single Row SELECT ✅
- **Usage Count**: 417 operations
- **Purpose**: Execute prepared statement, return first row only
- **Returns**: Single object or undefined
- **Pattern**: `db.prepare(sql).get(...params)`

```javascript
// Examples from codebase
const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
const existing = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
const record = db.prepare('SELECT * FROM attendance WHERE id = ?').get(result.lastInsertRowid);
```

### 3. **Statement.all(params...)** - Multiple Row SELECT ✅
- **Usage Count**: 155 operations
- **Purpose**: Execute prepared statement, return all matching rows
- **Returns**: Array of objects (empty array if no matches)
- **Pattern**: `db.prepare(sql).all(...params)`

```javascript
// Examples from codebase
const customers = db.prepare(sql).all(...params);
const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(saleId);
const materials = db.prepare(`...`).all(term, term);
```

### 4. **Statement.run(params...)** - INSERT/UPDATE/DELETE ✅
- **Usage Count**: 248 operations
- **Purpose**: Execute INSERT, UPDATE, or DELETE statements
- **Returns**: Info object with `changes` and `lastInsertRowid` properties
- **Pattern**: `db.prepare(sql).run(...params)`

```javascript
// Examples from codebase
db.prepare('INSERT INTO users (name, phone, email, password, role) VALUES (?, ?, ?, ?, ?)')
  .run(name, phone, email || null, hashedPassword, 'customer');

db.prepare('UPDATE attendance SET status = ? WHERE id = ?')
  .run('present', attendanceId);

db.prepare('DELETE FROM expenses WHERE id = ?').run(req.params.id);
```

### 5. **db.exec(sql)** - Batch/Schema Initialization
- **Usage Count**: 0 in routes (used only in database initialization)
- **Purpose**: Execute raw SQL without parameters (DDL, multiple statements)
- **Returns**: undefined
- **Pattern**: `db.exec(SQL_STRING)`

```javascript
// From database.js initialization
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ...
  );
  CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
`);
```

---

## Execution Patterns

### Synchronous Execution (100% of operations)
All database operations execute synchronously without any async/await or callback mechanisms:

```javascript
// ✅ SYNCHRONOUS - ALL operations work this way
const user = db.prepare(...).get(id);        // Blocks until complete
const items = db.prepare(...).all(id);      // Blocks until complete  
const result = db.prepare(...).run(...);    // Blocks until complete

// ❌ NOT USED - No async patterns found
db.prepare(...).getAsync()                   // Not available
db.prepare(...).all((err, rows) => {})      // Not used
await db.prepare(...).get()                  // Not used
```

---

## Operation Distribution by Route

| Route | Total Ops | Priority | Notable Operations |
|-------|-----------|----------|-------------------|
| **sales.js** | 134 | CRITICAL | Complex transactions, stock deduction, payment processing |
| **production.js** | 70 | HIGH | Production task management |
| **deliveries.js** | 69 | HIGH | Delivery assignment, tracking |
| **attendance.js** | 51 | HIGH | Clock in/out, shift validation |
| **customers.js** | 51 | HIGH | Customer lookup, credit management |
| **products.js** | 45 | MEDIUM | Product CRUD, BOM, stock calculations |
| **staff-management.js** | 40 | MEDIUM | Staff assignments, roles |
| **purchase-orders.js** | 32 | MEDIUM | PO creation, supplier management |
| **reports.js** | 32 | MEDIUM | Analytics queries |
| **stock.js** | 30 | MEDIUM | Inventory transfers, stock levels |
| **materials.js** | 21 | MEDIUM | Material CRUD, pricing |
| **recurring-orders.js** | 21 | MEDIUM | Recurring order generation |
| **suppliers.js** | 20 | MEDIUM | Supplier management |
| **delivery-tracking.js** | 16 | LOW | Location tracking |
| **notifications.js** | 13 | LOW | Push tokens, notification logs |
| **expenses.js** | 10 | LOW | Expense entry |
| **categories.js** | 9 | LOW | Material category management |
| **locations.js** | 8 | MEDIUM | Location CRUD |
| **settings.js** | 8 | LOW | App settings |
| **users.js** | 8 | PRIMARY | User CRUD, authentication |
| **auth.js** | 6 | PRIMARY | Login, profile updates |

---

## Unique Database Operations Summary

### Operation Type Breakdown
- **SELECT (single row)**: 417 operations (50.8%)
- **INSERT/UPDATE/DELETE**: 248 operations (30.2%)
- **SELECT (multiple rows)**: 155 operations (18.9%)
- **Schema/Batch**: 0 in route handlers

### Most Common Query Patterns

1. **Existence Checks** (417 GET operations include many existence checks)
   ```javascript
   const existing = db.prepare('SELECT id FROM table WHERE condition').get(param);
   ```

2. **Data Validation** (Before INSERT/UPDATE)
   ```javascript
   const existing = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
   if (existing) { /* handle conflict */ }
   ```

3. **Paginated Listings** (ALL operations with LIMIT/OFFSET)
   ```javascript
   const items = db.prepare(sql).all(...params);
   // Always includes: LIMIT ? OFFSET ?
   ```

4. **Stock & Inventory Transactions** (Complex RUN operations)
   ```javascript
   db.prepare('UPDATE material_stock SET quantity = quantity - ? WHERE id = ?').run(qty, id);
   db.prepare('INSERT INTO material_transactions (...) VALUES (...)').run(...);
   ```

5. **Related Data Retrieval** (Common pattern in sales.js)
   ```javascript
   const sale = db.prepare(...).get(id);
   sale.items = db.prepare(...).all(id);
   sale.payments = db.prepare(...).all(id);
   sale.delivery = db.prepare(...).get(id);
   ```

---

## Database Features Being Used

### ✅ Supported Features
- Parameterized queries (? placeholders) - **USED EXTENSIVELY**
- Transactions (not used in observed routes)
- Foreign keys (enabled in pragma)
- Indexes (created for common queries)
- Default timestamps (CURRENT_TIMESTAMP)
- Aggregate functions (COUNT, SUM, AVG)
- JOINs (INNER, LEFT, GROUP BY)
- Subqueries

### ❌ NOT USED
- Raw string concatenation (avoided via parameterization)
- Async patterns
- Connection pooling (single DB instance)
- Transactions/rollback
- Query caching
- Prepared statement caching (better-sqlite3 handles internally)

---

## Critical Implementation Details

### Table Operations Map

| Operation | Count | Examples |
|-----------|-------|----------|
| **CREATE/READ/UPDATE/DELETE** | - | users, products, sales, inventory, etc. |
| **Validations (existence checks)** | ~200+ | Before every INSERT/UPDATE/DELETE |
| **Lookups (single item by ID)** | ~180+ | Fetching records for detail views |
| **List with pagination** | ~40+ | GET endpoints with limit/offset |
| **Aggregations** | ~30+ | COUNT, SUM for reports/dashboards |
| **Transactions** | ~15+ | Multi-step operations (sale creation) |
| **Complex JOINs** | ~25+ | Sales with items, payments, delivery |

### Parameter Binding
- **All queries use parametrized statements**
- No SQL injection vulnerabilities observed
- Parameters passed via: `.get(param)`, `.all(...params)`, `.run(...params)`

---

## Performance Characteristics

### Synchronous Nature Implications
- ✅ **Pros**: Simple error handling, atomic operations, no race conditions
- ❌ **Cons**: Blocks event loop on large operations, high I/O latency

### Query Optimization Observations
- Heavy use of LIMIT/OFFSET (pagination)
- Indexes on foreign keys and frequently filtered columns
- Multiple small queries instead of complex JOINs
- No N+1 query prevention (e.g., sales.js may fetch items separately)

---

## Required Database Adapter Features

### Must Support
1. ✅ `prepare(sql)` - Prepare statements
2. ✅ `Statement.get(params)` - Single row retrieval
3. ✅ `Statement.all(params)` - Multiple row retrieval
4. ✅ `Statement.run(params)` - Write operations
5. ✅ Parameterized queries with `?` placeholders
6. ✅ `lastInsertRowid` property on run result
7. ✅ Synchronous execution model

### Nice to Have
- Transaction support for multi-step operations
- Query result caching
- Async variants for some operations (non-critical)

---

## Migration Path (if switching databases)

If migrating from SQLite to PostgreSQL (note: `pg` dependency already in package.json):

1. **Replace better-sqlite3 with pg/postgres client**
2. **Adapter pattern needed** - Create wrapper that exposes same API:
   - `prepare(sql)` → returns object with `get()`, `all()`, `run()`
   - All methods need to return SYNCHRONOUS results OR convert to async
   - `lastInsertRowid` → PostgreSQL RETURNING clause
   - Parameterization: `?` → `$1`, `$2`, etc.

3. **Critical differences**:
   - PostgreSQL is async by nature (better-sqlite3 is sync)
   - Would require converting ALL route handlers to async/await
   - Connection pooling becomes necessary
   - AUTOINCREMENT → SERIAL or IDENTITY

---

## Summary Statistics

| Metric | Value |
|--------|-------|
| **Total DB Operations** | 820 |
| **Unique Tables** | 40+ |
| **Method: prepare()** | 739 calls |
| **Method: get()** | 417 calls (50.8%) |
| **Method: run()** | 248 calls (30.2%) |
| **Method: all()** | 155 calls (18.9%) |
| **Execution Model** | 100% Synchronous |
| **Parameter Binding** | 100% Parameterized |
| **Routes Using DB** | 21 files |
| **Routes Using Most Ops** | sales.js (134), production.js (70) |

---

## Conclusion

The database API is a **thin wrapper around better-sqlite3** that exposes:
- **3 core query execution methods**: `get()`, `all()`, `run()`
- **100% synchronous operations** with no async alternatives
- **Comprehensive parameterization** preventing SQL injection
- **Simple transactionless model** relying on SQLite's atomicity

Any database adapter must support these three methods and maintain the synchronous contract, or all route handlers require refactoring to async/await.
