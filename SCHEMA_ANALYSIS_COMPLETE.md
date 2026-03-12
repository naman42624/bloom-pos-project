# Complete SQLite → PostgreSQL Schema Analysis

**Generated:** March 13, 2026  
**Status:** Thorough examination of all tables and column definitions

---

## SECTION 1: COMPLETE TABLE INVENTORY

### All 49 Tables in SQLite Schema

1. **users** - User accounts (owner, manager, employee, delivery_partner, customer)
2. **locations** - Shops and warehouses
3. **user_locations** - User-location assignments (access control)
4. **settings** - Key-value configuration (shop_name, currency, timezone, etc.)
5. **notifications** - In-app notifications (phase 10)
6. **tax_rates** - Tax rate definitions (5%, 12%, 18%, 28%)
7. **material_categories** - Categories for materials (Flowers, Ribbons, Vases, etc.)
8. **materials** - Individual materials/supplies (roses, lilies, etc.)
9. **material_stock** - Inventory per location and material
10. **suppliers** - Supplier master data
11. **supplier_materials** - Default pricing between suppliers and materials
12. **purchase_orders** - PO headers
13. **purchase_order_items** - PO line items with expected/received quantities
14. **material_transactions** - Stock ledger (purchase, usage, wastage, transfers, etc.)
15. **daily_stock_logs** - Daily reconciliation (opening, received, used, closing, wastage)
16. **stock_transfers** - Inter-location stock transfers with status tracking
17. **products** - Finished products (bouquets, arrangements)
18. **product_materials** - Bill of materials (BOM) - links products to materials
19. **product_images** - Product photos
20. **sales** - Sales orders/transactions
21. **sale_items** - Line items in sales
22. **payments** - Payment records per sale (cash, card, upi)
23. **refunds** - Refund requests and processing
24. **cash_registers** - Daily cash register reconciliation
25. **pre_orders** - Pre-order bookings
26. **expenses** - Expense tracking
27. **customer_addresses** - Saved delivery addresses for customers
28. **credit_payments** - Credit balance payments
29. **special_dates** - Customer special dates (birthdays, anniversaries, custom)
30. **product_stock** - Ready-product inventory per location (Phase 6)
31. **production_logs** - Production history for incentive tracking
32. **production_tasks** - Order-driven production tasks
33. **deliveries** - Delivery orders with status tracking
34. **delivery_proofs** - Photo + GPS proof of delivery
35. **delivery_collections** - COD money collected by delivery partner
36. **delivery_settlements** - Settlement of collected COD to shop owner
37. **delivery_settlement_items** - Individual delivery line items in settlement
38. **recurring_orders** - Subscription/recurring orders
39. **attendance** - Employee clock-in/clock-out
40. **outdoor_duty_requests** - Requests for outdoor work
41. **salary_advances** - Salary advance requests
42. **employee_shifts** - Shift definitions (start/end times, days_of_week)
43. **employee_salaries** - Monthly salary records
44. **salary_history** - Salary change history
45. **delivery_locations** - Real-time delivery partner GPS tracking
46. **geofence_events** - Location entry/exit events for auto clock-in
47. **delivery_partner_daily** - Daily summary for delivery partners
48. **salary_payments** - Payroll disbursement records
49. **push_tokens** - Device tokens for push notifications

---

## SECTION 2: EXACT CREATE TABLE STATEMENTS FOR CRITICAL TABLES

### TABLE 1: `users`

```sql
-- SQLite Definition:
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE,
  password TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer' CHECK(role IN ('owner', 'manager', 'employee', 'delivery_partner', 'customer')),
  avatar TEXT DEFAULT NULL,
  bio TEXT DEFAULT '',
  is_active INTEGER DEFAULT 1,
  created_by INTEGER DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

-- Additional columns added via ALTER TABLE (Phase 5):
-- birthday DATE DEFAULT NULL
-- anniversary DATE DEFAULT NULL
-- custom_dates TEXT DEFAULT '[]'
-- total_spent REAL DEFAULT 0
-- credit_balance REAL DEFAULT 0
-- notes TEXT DEFAULT ''
```

**Missing from PostgreSQL Schema:**
- ❌ `avatar` column
- ❌ `bio` column
- ❌ `birthday` column
- ❌ `anniversary` column
- ❌ `custom_dates` column (stored as JSON array in SQLite)
- ❌ `total_spent` column
- ❌ `credit_balance` column
- ❌ `notes` column

**PostgreSQL has but SQLite doesn't:**
- ✅ `custom_dates` JSONB (different structure)
- ✅ `total_spent` DECIMAL(10,2)
- ✅ `credit_balance` DECIMAL(10,2)
- ✅ `notes` TEXT

---

### TABLE 2: `locations`

```sql
-- SQLite Definition:
CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'shop' CHECK(type IN ('shop', 'warehouse')),
  address TEXT,
  city TEXT,
  state TEXT,
  pincode TEXT,
  latitude REAL,
  longitude REAL,
  geofence_radius INTEGER DEFAULT 50,
  phone TEXT,
  email TEXT,
  gst_number TEXT,
  operating_hours TEXT DEFAULT NULL,
  is_active INTEGER DEFAULT 1,
  created_by INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
);
```

**Differences from PostgreSQL:**
- ❌ `gst_number` TEXT - **MISSING in PostgreSQL**
- ❌ `operating_hours` TEXT (JSON string in SQLite) - PostgreSQL has JSONB
- ❌ `geofence_radius` INTEGER (SQLite) vs `geofence_radius_meters` INTEGER (PostgreSQL) - **NAME MISMATCH**
- ❌ PostgreSQL has `custom_dates` JSONB - **NOT IN SQLITE**
- ❌ `created_by` should be `created_by INTEGER REFERENCES users(id) ON DELETE SET NULL` in PostgreSQL, but schema shows `SET NULL` not `CASCADE`
- ✅ `created_by` needs to allow NULL in PostgreSQL (PostgreSQL has `SET NULL`)

---

### TABLE 3: `sales`

```sql
-- SQLite Definition:
CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_number TEXT UNIQUE,
  location_id INTEGER NOT NULL,
  customer_id INTEGER DEFAULT NULL,
  customer_name TEXT DEFAULT NULL,
  customer_phone TEXT DEFAULT NULL,
  subtotal REAL DEFAULT 0,
  tax_total REAL DEFAULT 0,
  discount_amount REAL DEFAULT 0,
  discount_type TEXT DEFAULT NULL CHECK(discount_type IN ('fixed', 'percentage')),
  discount_percentage REAL DEFAULT NULL,
  discount_approved_by INTEGER DEFAULT NULL,
  delivery_charges REAL DEFAULT 0,
  delivery_address TEXT DEFAULT NULL,
  scheduled_date DATE DEFAULT NULL,
  scheduled_time TEXT DEFAULT NULL,
  grand_total REAL DEFAULT 0,
  payment_status TEXT NOT NULL DEFAULT 'pending' CHECK(payment_status IN ('paid', 'partial', 'pending', 'refunded')),
  order_type TEXT NOT NULL DEFAULT 'walk_in' CHECK(order_type IN ('walk_in', 'pickup', 'delivery', 'pre_order')),
  status TEXT NOT NULL DEFAULT 'completed' CHECK(status IN ('draft', 'pending', 'preparing', 'ready', 'completed', 'cancelled')),
  special_instructions TEXT DEFAULT '',
  customer_notes TEXT DEFAULT '',
  stock_deducted INTEGER DEFAULT 0,
  sender_message TEXT DEFAULT '',
  sender_name TEXT DEFAULT '',
  sender_phone TEXT DEFAULT '',
  pickup_status TEXT DEFAULT NULL CHECK(pickup_status IN ('waiting','ready_for_pickup','picked_up')),
  picked_up_at DATETIME DEFAULT NULL,
  source TEXT DEFAULT 'manual',
  created_by INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (discount_approved_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
);
```

**Missing from PostgreSQL Schema:**
- ❌ `discount_type` TEXT CHECK(type IN ('fixed', 'percentage')) - **NOT IN POSTGRES**
- ❌ `discount_percentage` REAL - **NOT IN POSTGRES** (only has `discount_percentage`)
- ❌ `discount_approved_by` INTEGER - **NOT IN POSTGRES**
- ❌ `tax_total` REAL (SQLite) vs `tax_total` DECIMAL(10,2) (PostgreSQL) - exists in both
- ❌ `stock_deducted` INTEGER - **NOT IN POSTGRES**
- ❌ `sender_message`, `sender_name`, `sender_phone` - **NOT IN POSTGRES**
- ❌ `source` TEXT DEFAULT 'manual' - **NOT IN POSTGRES**
- ❌ `pickup_status` - **IN BOTH** ✓
- ✅ `items` JSONB - **IN POSTGRES but NOT in SQLite** (items are stored separately in sale_items table)

**Key Issue:**
- PostgreSQL stores items in `items JSONB` column (denormalized)
- SQLite uses normalized `sale_items` table (correct design)

---

### TABLE 4: `deliveries`

```sql
-- SQLite Definition:
CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL,
  delivery_partner_id INTEGER DEFAULT NULL,  -- ⚠️ KEY COLUMN NAME
  location_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','assigned','picked_up','in_transit','delivered','failed','cancelled')),
  delivery_address TEXT NOT NULL,
  customer_name TEXT DEFAULT NULL,
  customer_phone TEXT DEFAULT NULL,
  scheduled_date DATE DEFAULT NULL,
  scheduled_time TEXT DEFAULT NULL,
  cod_amount REAL DEFAULT 0,
  cod_collected REAL DEFAULT 0,
  cod_status TEXT DEFAULT 'none' CHECK(cod_status IN ('none','pending','partial','collected','settled')),
  pickup_time DATETIME DEFAULT NULL,
  delivered_time DATETIME DEFAULT NULL,
  delivery_notes TEXT DEFAULT '',
  failure_reason TEXT DEFAULT '',
  assigned_by INTEGER DEFAULT NULL,
  assigned_at DATETIME DEFAULT NULL,
  batch_id TEXT DEFAULT NULL,  -- Phase 8 addition
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE,
  FOREIGN KEY (delivery_partner_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE,
  FOREIGN KEY (assigned_by) REFERENCES users(id) ON DELETE SET NULL
);
```

**CRITICAL NAMING ISSUE:**
- ⚠️ **SQLite: `delivery_partner_id`** vs PostgreSQL: **`partner_id`** ❌

**Missing from PostgreSQL:**
- ❌ `cod_collected` REAL - **NOT IN POSTGRES** (only has `cod_amount`)
- ❌ `cod_status` (none, pending, partial, collected, settled) - **NOT IN POSTGRES**
- ❌ `pickup_time` DATETIME - PostgreSQL has `picked_up_at`
- ❌ `delivered_time` DATETIME - PostgreSQL has `delivered_at` ✓
- ❌ `assigned_by` INTEGER - **NOT IN POSTGRES**
- ❌ `assigned_at` DATETIME - **IN POSTGRES** ✓
- ❌ `batch_id` TEXT - **NOT IN POSTGRES**
- ❌ `delivery_notes` vs `notes` - naming differs
- ❌ `in_transit_at` TIMESTAMP - **IN POSTGRES but NOT SQLite**
- ❌ `failure_reason` TEXT - **IN BOTH** ✓
- ✅ `partner_name` VARCHAR(255) - **IN POSTGRES but NOT SQLite**

**PostgreSQL has but SQLite doesn't:**
- `in_transit_at` TIMESTAMP
- `partner_name` VARCHAR(255)
- `cod_status` VARCHAR(50) - actually wait, checking again...

---

### TABLE 5: `attendance`

```sql
-- SQLite Definition:
CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  location_id INTEGER NOT NULL,
  date DATE NOT NULL,
  clock_in DATETIME DEFAULT NULL,
  clock_in_method TEXT DEFAULT 'manual' CHECK(clock_in_method IN ('auto_geofence', 'manual')),
  clock_in_latitude REAL DEFAULT NULL,
  clock_in_longitude REAL DEFAULT NULL,
  clock_out DATETIME DEFAULT NULL,
  clock_out_method TEXT DEFAULT NULL CHECK(clock_out_method IN ('auto_geofence', 'manual', 'auto_timeout')),
  clock_out_latitude REAL DEFAULT NULL,
  clock_out_longitude REAL DEFAULT NULL,
  total_hours REAL DEFAULT 0,
  outdoor_hours REAL DEFAULT 0,
  effective_hours REAL DEFAULT 0,
  status TEXT DEFAULT 'present' CHECK(status IN ('present', 'absent', 'half_day', 'on_leave')),
  late_arrival INTEGER DEFAULT 0,
  early_departure INTEGER DEFAULT 0,
  notes TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE,
  UNIQUE(user_id, date)
);
```

**Matches PostgreSQL:** ✅ Good alignment

**Difference:**
- SQLite: `clock_in_latitude` REAL / `clock_in_longitude` REAL
- PostgreSQL: `clock_in_latitude` DECIMAL(10,7) / `clock_in_longitude` DECIMAL(10,7) - better precision

---

### TABLE 6: `delivery_settlements`

```sql
-- SQLite Definition:
CREATE TABLE IF NOT EXISTS delivery_settlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_partner_id INTEGER NOT NULL,  -- ⚠️ COLUMN NAME
  location_id INTEGER NOT NULL,
  total_amount REAL NOT NULL,
  total_deliveries INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','verified')),
  verified_by INTEGER DEFAULT NULL,
  verified_at DATETIME DEFAULT NULL,
  notes TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (delivery_partner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE,
  FOREIGN KEY (verified_by) REFERENCES users(id) ON DELETE SET NULL
);
```

**CRITICAL DIFFERENCES:**

**SQLite design (simple):**
- Simple per-settlement record
- Status: 'pending' or 'verified'
- Only tracks total_amount and total_deliveries count
- Limited financial tracking

**PostgreSQL design (comprehensive):**
```sql
CREATE TABLE IF NOT EXISTS delivery_settlements (
  id SERIAL PRIMARY KEY,
  settlement_number VARCHAR(100) UNIQUE NOT NULL,
  partner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  settlement_date DATE NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  total_deliveries INTEGER DEFAULT 0,
  successful_deliveries INTEGER DEFAULT 0,
  failed_deliveries INTEGER DEFAULT 0,
  total_amount DECIMAL(10,2) DEFAULT 0,
  commission_percentage DECIMAL(5,2) DEFAULT 5,
  commission_amount DECIMAL(10,2) DEFAULT 0,
  incentives DECIMAL(10,2) DEFAULT 0,
  deductions DECIMAL(10,2) DEFAULT 0,
  net_amount DECIMAL(10,2),
  payment_status VARCHAR(50) DEFAULT 'pending',
  payment_method VARCHAR(50),
  payment_date DATE,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Missing columns in SQLite:**
- ❌ `settlement_number` VARCHAR(100) UNIQUE
- ❌ `settlement_date` DATE
- ❌ `period_start` DATE
- ❌ `period_end` DATE
- ❌ `successful_deliveries` INTEGER
- ❌ `failed_deliveries` INTEGER
- ❌ `commission_percentage` DECIMAL(5,2)
- ❌ `commission_amount` DECIMAL(10,2)
- ❌ `incentives` DECIMAL(10,2)
- ❌ `deductions` DECIMAL(10,2)
- ❌ `net_amount` DECIMAL(10,2)
- ❌ `payment_status` VARCHAR(50) - SQLite only has "pending/verified"
- ❌ `payment_method` VARCHAR(50)
- ❌ `payment_date` DATE
- ❌ `partner_id` vs `delivery_partner_id` naming

**Column Naming Issue:**
- ⚠️ **SQLite: `delivery_partner_id`** vs PostgreSQL: **`partner_id`** ❌

---

## SECTION 3: TABLES MISSING FROM POSTGRESQL SCHEMA

These 20 tables exist in SQLite but NOT in PostgreSQL:

1. ❌ **material_categories** - Master table for material categories
2. ❌ **material_transactions** - Full stock ledger (purchase, usage, wastage, transfers, adjustments, returns)
3. ❌ **daily_stock_logs** - Daily stock reconciliation per material per location
4. ❌ **stock_transfers** - Inter-location material transfers with status
5. ❌ **supplier_materials** - Supplier-to-material pricing relationships
6. ❌ **purchase_order_items** - Individual line items in purchase orders
7. ❌ **product_materials** - Bill of materials (products → materials composition)
8. ❌ **product_images** - Product photo gallery
9. ❌ **product_stock** - Ready-product inventory per location (Phase 6)
10. ❌ **production_logs** - Production history with incentive tracking
11. ❌ **payments** - Individual payment records (cash, card, upi) per sale
12. ❌ **refunds** - Refund request tracking with approval workflow
13. ❌ **delivery_proofs** - Photo + GPS proof of delivery
14. ❌ **delivery_collections** - COD money collection details
15. ❌ **customer_addresses** - Saved delivery addresses for customers
16. ❌ **credit_payments** - Credit balance payment tracking
17. ❌ **special_dates** - Customer special dates (birthdays, anniversaries, custom)
18. ❌ **salary_history** - Salary change audit trail
19. ❌ **delivery_locations** - Real-time GPS tracking for delivery partners
20. ❌ **delivery_partner_daily** - Daily summary stats for delivery partners (deliveries, distance, active time, etc.)
21. ❌ **salary_payments** - Payroll disbursement records with detailed deductions/bonuses
22. ❌ **employee_salaries** - Employee salary master (monthly/daily/hourly rates)

---

## SECTION 4: CRITICAL COLUMN NAMING MISMATCHES

### 🔴 HIGH PRIORITY - These Will Break FK References

1. **`deliveries.delivery_partner_id`** (SQLite) vs **`deliveries.partner_id`** (PostgreSQL)
   - ⚠️ This breaks foreign key to users table
   - Needs migration: RENAME COLUMN

2. **`locations.geofence_radius`** (SQLite, INTEGER) vs **`locations.geofence_radius_meters`** (PostgreSQL)
   - Different name AND measurement (meters vs generic)
   - Needs column rename and unit clarification

3. **`delivery_settlements.delivery_partner_id`** (SQLite) vs **`delivery_settlements.partner_id`** (PostgreSQL)
   - Same issue as deliveries table
   - Consistency problem across codebase

4. **`deliveries.pickup_time`** (SQLite) vs **`deliveries.picked_up_at`** (PostgreSQL)
   - Different column names for same concept

5. **`deliveries.delivered_time`** (SQLite) vs **`deliveries.delivered_at`** (PostgreSQL)
   - Naming inconsistency (time vs at)

### 🟡 MEDIUM PRIORITY - Missing Columns

1. **sales table:**
   - ❌ `discount_type` (fixed vs percentage) - Critical for discount logic
   - ❌ `discount_percentage` - Separate column for percentage-based discounts
   - ❌ `discount_approved_by` - Audit trail for discounts
   - ❌ `stock_deducted` - Flag to track if inventory was deducted
   - ❌ `sender_message`, `sender_name`, `sender_phone` - Gift sender info
   - ❌ `source` (manual, recurring, pre_order) - Order origin tracking

2. **deliveries table:**
   - ❌ `cod_collected` REAL - Actual COD amount collected
   - ❌ `cod_status` (none, pending, partial, collected, settled) - COD state machine
   - ❌ `assigned_by` - Who assigned this delivery
   - ❌ `batch_id` - For delivery batching/optimization
   - Missing PostgreSQL: `in_transit_at`, `partner_name`

3. **delivery_settlements table:**
   - ❌ `settlement_number` - Unique document reference
   - ❌ `settlement_date` - When settlement was created
   - ❌ `period_start`, `period_end` - Settlement period
   - ❌ `successful_deliveries`, `failed_deliveries` - Delivery breakdown
   - ❌ `commission_percentage`, `commission_amount` - Commission calculation
   - ❌ `incentives`, `deductions` - Financial adjustments
   - ❌ `net_amount` - Final payable amount
   - ❌ `payment_status` (pending, processed, failed) - Different from SQLite's pending/verified
   - ❌ `payment_method`, `payment_date` - Payment tracking

4. **locations table:**
   - ❌ `gst_number` - Missing GST field
   - ❌ `operating_hours` as JSON string

5. **users table:**
   - ❌ `avatar` TEXT
   - ❌ `bio` TEXT
   - ❌ `birthday`, `anniversary`, `custom_dates`
   - ❌ `total_spent`, `credit_balance`, `notes`

6. **cash_registers table:**
   - Need to verify column definitions in detail

---

## SECTION 5: CASH_REGISTERS TABLE - DETAILED ANALYSIS

**SQLite Version:**
```sql
CREATE TABLE IF NOT EXISTS cash_registers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL,
  date DATE NOT NULL,
  opened_by INTEGER NOT NULL,
  opening_balance REAL NOT NULL DEFAULT 0,
  total_cash_sales REAL DEFAULT 0,
  total_card_sales REAL DEFAULT 0,
  total_upi_sales REAL DEFAULT 0,
  total_refunds_cash REAL DEFAULT 0,
  expected_cash REAL DEFAULT 0,
  actual_cash REAL DEFAULT NULL,
  discrepancy REAL DEFAULT NULL,
  closed_by INTEGER DEFAULT NULL,
  closing_notes TEXT DEFAULT '',
  opened_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  closed_at DATETIME DEFAULT NULL,
  FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE,
  FOREIGN KEY (opened_by) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (closed_by) REFERENCES users(id) ON DELETE SET NULL
);
```

**PostgreSQL Version:**
```sql
CREATE TABLE IF NOT EXISTS cash_registers (
  id SERIAL PRIMARY KEY,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  opened_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opening_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
  opening_time TIMESTAMP NOT NULL,
  closing_amount DECIMAL(10,2),
  closing_time TIMESTAMP,
  cash_in DECIMAL(10,2) DEFAULT 0,
  cash_out DECIMAL(10,2) DEFAULT 0,
  expected_closing DECIMAL(12,2),
  actual_closing DECIMAL(12,2),
  shortage DECIMAL(12,2),
  notes TEXT,
  status VARCHAR(50) DEFAULT 'open' CHECK(status IN ('open', 'closed')),
  closed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**MAJOR DIFFERENCES:**

| SQLite | PostgreSQL | Issue |
|--------|-----------|-------|
| `date` DATE | None | PostgreSQL missing date column (has opened_at TIMESTAMP instead) |
| `opening_balance` | `opening_amount` | Different names ❌ |
| `total_cash_sales` | `cash_in` | Different meaning? cash_in might include deposits |
| `total_card_sales` | (missing) | Not tracked in PostgreSQL ❌ |
| `total_upi_sales` | (missing) | Not tracked in PostgreSQL ❌ |
| `total_refunds_cash` | (missing) | Not tracked in PostgreSQL ❌ |
| `expected_cash` | `expected_closing` | Different names ❌ |
| `actual_cash` | `actual_closing` | Different names ❌ |
| `discrepancy` | `shortage` | Similar but negative meaning |
| `opened_at` | `opening_time` | Different names ❌ |
| `closed_at` | `closing_time` | Different names ❌ |
| `closing_notes` | `notes` | Different names ❌ |
| None | `status` VARCHAR(50) | PostgreSQL has explicit status (open/closed) |
| None | `cash_out` | Cash withdrawals (not in SQLite) |

---

## SECTION 6: DATA TYPE MISMATCHES

### Real vs Decimal

- **SQLite uses REAL** for all decimal amounts (currency, percentages, quantities)
- **PostgreSQL uses DECIMAL(10,2)** for currency, DECIMAL(5,2) for percentages
- Impact: Floating-point precision issues when migrating

### String vs TEXT

- **SQLite**: TEXT for all text fields
- **PostgreSQL**: VARCHAR(n) for named fields, TEXT for unlimited
- Examples:
  - `name` → VARCHAR(255)
  - `phone` → VARCHAR(20)
  - `email` → VARCHAR(255)
  - `role` → VARCHAR(50)

### Date/Time

- **SQLite**: DATETIME DEFAULT CURRENT_TIMESTAMP → TEXT representation
- **PostgreSQL**: TIMESTAMP DEFAULT CURRENT_TIMESTAMP → proper timestamp
- Important: DATE columns exist in PostgreSQL but might be TEXT in some SQLite uses

---

## SECTION 7: COLUMN ADDITIONS NEEDED IN POSTGRESQL

### For locations table:
```sql
ALTER TABLE locations ADD COLUMN gst_number TEXT;
ALTER TABLE locations ADD COLUMN operating_hours JSONB;
```

### For users table:
```sql
ALTER TABLE users ADD COLUMN avatar TEXT;
ALTER TABLE users ADD COLUMN bio TEXT;
ALTER TABLE users ADD COLUMN birthday DATE;
ALTER TABLE users ADD COLUMN anniversary DATE;
ALTER TABLE users ADD COLUMN notes TEXT;
-- custom_dates already in PostgreSQL as JSONB
-- total_spent already in PostgreSQL
-- credit_balance already in PostgreSQL
```

### For sales table:
```sql
ALTER TABLE sales ADD COLUMN discount_type VARCHAR(50) CHECK(discount_type IN ('fixed', 'percentage'));
ALTER TABLE sales ADD COLUMN discount_percentage DECIMAL(5,2);
ALTER TABLE sales ADD COLUMN discount_approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE sales ADD COLUMN stock_deducted INTEGER DEFAULT 0;
ALTER TABLE sales ADD COLUMN sender_message TEXT DEFAULT '';
ALTER TABLE sales ADD COLUMN sender_name TEXT DEFAULT '';
ALTER TABLE sales ADD COLUMN sender_phone TEXT DEFAULT '';
ALTER TABLE sales ADD COLUMN source VARCHAR(50) DEFAULT 'manual';
```

### For deliveries table - CRITICAL RENAMES:
```sql
ALTER TABLE deliveries RENAME COLUMN partner_id TO delivery_partner_id;
-- Handle the trigger/dependency issues properly
```

### For delivery_settlements table - CRITICAL RENAMES:
```sql
ALTER TABLE delivery_settlements RENAME COLUMN partner_id TO delivery_partner_id;
-- Add many new columns...
ALTER TABLE delivery_settlements ADD COLUMN settlement_number VARCHAR(100) UNIQUE NOT NULL;
ALTER TABLE delivery_settlements ADD COLUMN settlement_date DATE NOT NULL DEFAULT CURRENT_DATE;
ALTER TABLE delivery_settlements ADD COLUMN period_start DATE NOT NULL;
ALTER TABLE delivery_settlements ADD COLUMN period_end DATE NOT NULL;
ALTER TABLE delivery_settlements ADD COLUMN successful_deliveries INTEGER DEFAULT 0;
ALTER TABLE delivery_settlements ADD COLUMN failed_deliveries INTEGER DEFAULT 0;
ALTER TABLE delivery_settlements ADD COLUMN commission_percentage DECIMAL(5,2) DEFAULT 5;
ALTER TABLE delivery_settlements ADD COLUMN commission_amount DECIMAL(10,2) DEFAULT 0;
ALTER TABLE delivery_settlements ADD COLUMN incentives DECIMAL(10,2) DEFAULT 0;
ALTER TABLE delivery_settlements ADD COLUMN deductions DECIMAL(10,2) DEFAULT 0;
ALTER TABLE delivery_settlements ADD COLUMN net_amount DECIMAL(10,2);
ALTER TABLE delivery_settlements ALTER COLUMN status TYPE VARCHAR(50) USING status::varchar;
-- Reset status CHECK constraint properly
ALTER TABLE delivery_settlements ADD COLUMN payment_method VARCHAR(50);
ALTER TABLE delivery_settlements ADD COLUMN payment_date DATE;
```

---

## SECTION 8: TABLES TO CREATE IN POSTGRESQL

All 20+ missing tables need to be created. Priority order:

**CRITICAL (Revenue & Operations):**
1. `product_materials` (BOM - Bill of Materials)
2. `material_transactions` (Stock ledger)
3. `payments` (Payment tracking per sale)
4. `refunds` (Refund management)
5. `product_stock` (Ready-product inventory)
6. `production_outputs` or `production_logs`

**IMPORTANT (Inventory):**
7. `material_categories`
8. `daily_stock_logs` (Reconciliation)
9. `stock_transfers` (Inter-location transfers)

**Delivery & Settlements:**
10. `delivery_proofs` (Photo + GPS)
11. `delivery_collections` (COD tracking detail)
12. `delivery_locations` (GPS trail)

**Customer Management:**
13. `customer_addresses` (Saved addresses)
14. `credit_payments` (Credit tracking)
15. `special_dates` (Birthdays, anniversaries)

**Employee & Payroll:**
16. `employee_salaries` (Salary master)
17. `salary_history` (Audit trail)
18. `salary_payments` (Payroll disbursement)
19. `delivery_partner_daily` (Stats)

---

## SECTION 9: QUICK REFERENCE - COLUMN MAPPINGS

| Concept | SQLite Column | PostgreSQL Column | Status |
|---------|---------------|-------------------|--------|
| Discount Type | `discount_type` | ❌ MISSING | Create |
| Discount % | `discount_percentage` | `discount_percentage` | Exists but needs verification |
| Delivery Partner ID | `delivery_partner_id` | `partner_id` | ❌ MISMATCH - Rename |
| Settlement Partner | `delivery_partner_id` | `partner_id` | ❌ MISMATCH - Rename |
| Geofence Radius | `geofence_radius` (int) | `geofence_radius_meters` (int) | ⚠️ Different names |
| COD Collected | `cod_collected` | ❌ MISSING | Create |
| COD Status | `cod_status` | ❌ MISSING | Create |
| Stock Deducted | `stock_deducted` | ❌ MISSING | Create |
| Opening Amount | `opening_balance` | `opening_amount` | ⚠️ Different names |
| Opening Time | `opened_at` | `opening_time` | ⚠️ Different names |
| Closing Time | `closed_at` | `closing_time` | ⚠️ Different names |

---

## SUMMARY: ACTION ITEMS

### 🔴 CRITICAL (Will Break Migration)
1. **Rename** `deliveries.partner_id` → `deliveries.delivery_partner_id`
2. **Rename** `delivery_settlements.partner_id` → `delivery_settlements.delivery_partner_id`
3. **Create** all 20 missing tables in PostgreSQL
4. **Fix** cash_registers column naming mismatches
5. **Verify** delivery_settlements financial fields

### 🟡 HIGH PRIORITY (Data Integrity)
6. Add missing columns to `sales`, `users`, `locations`
7. Implement `discount_type` and discount approval workflow
8. Create `material_transactions` ledger system
9. Set up `product_stock` inventory tracking

### 🟢 MEDIUM PRIORITY (Feature Completeness)
10. Add delivery proofs and GPS tracking tables
11. Implement customer address management
12. Create full payroll system tables

---

**Last Updated:** March 13, 2026  
**Schema Version:** Phase 8+ (SQLite) vs Incomplete Conversion (PostgreSQL)
