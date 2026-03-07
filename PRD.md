# BloomPOS — Product Requirements Document

**Project**: BloomPOS – Point-of-Sale & Operations Platform for Flower Shops  
**Version**: 1.1  
**Date**: 7 March 2026  
**Stack**: React Native (Expo) + Express.js + SQLite (expandable to PostgreSQL)

### Registration & Onboarding
- **Customers**: Can self-register via the app OR be created by Employees/Managers
- **Employees & Delivery Partners**: Accounts created by Owner or Manager only
- **Managers**: Accounts created by Owner only

### Thermal Printer
- **Model**: SEZNIK Mini Printer
- **Paper**: 58mm thermal paper
- **Resolution**: 304×304 dpi, monochrome
- **Connectivity**: Bluetooth + USB wired
- **Protocol**: ESC/POS compatible
- **Supported Platforms**: Android, iOS, Laptop, Desktop

---

## Table of Contents

1. [Overview](#1-overview)
2. [Roles & Permissions](#2-roles--permissions)
3. [Multi-Location Management](#3-multi-location-management)
4. [Inventory & Raw Materials](#4-inventory--raw-materials)
5. [Products & QR Codes](#5-products--qr-codes)
6. [Sales / POS](#6-sales--pos)
7. [Orders & Order Lifecycle](#7-orders--order-lifecycle)
8. [Customer Management](#8-customer-management)
9. [Delivery Management](#9-delivery-management)
10. [Attendance & Location Tracking](#10-attendance--location-tracking)
11. [Reports & Analytics](#11-reports--analytics)
12. [Notifications](#12-notifications)
13. [Delivery Challan & Receipts](#13-delivery-challan--receipts)
14. [Configuration & Settings](#14-configuration--settings)
15. [Technical Architecture](#15-technical-architecture)
16. [Implementation Phases](#16-implementation-phases)

---

## 1. Overview

BloomPOS is a full-featured Point-of-Sale, inventory, and operations management app built for multi-location flower shops. It handles the complete lifecycle from raw material procurement to final delivery, with role-based access for owners, managers, employees, delivery partners, and customers.

### Core Value Propositions

- **Complete flower shop operations** — raw material tracking, arrangement creation, POS sales, delivery
- **Wastage control** — daily stock reconciliation with opening/closing counts, auto-deduction on usage, wastage trend reporting
- **Multi-location** — manage multiple shops and warehouses with centralized reporting
- **Role-based access** — five distinct roles with granular, configurable permissions
- **Geofenced attendance** — automated clock-in/out, outdoor duty approval, late/early flags
- **Live delivery tracking** — real-time map of delivery partners, photo proof of delivery
- **Customer lifecycle** — order history, credit tracking, special date reminders, recurring orders

---

## 2. Roles & Permissions

### 2.1 Role Definitions

| Role | Description |
|------|-------------|
| **Owner** | Full platform access, all configurations, all locations, all reports |
| **Manager** | Operational access for assigned location(s), team management, approval authority |
| **Employee** | Day-to-day operations — inventory entry, sales processing, arrangement creation |
| **Delivery Partner** | View assigned deliveries, update delivery status, location tracking |
| **Customer** | Browse products, place orders, view order history, manage profile |

### 2.2 Permission Matrix

| Feature Area | Owner | Manager | Employee | Delivery Partner | Customer |
|---|---|---|---|---|---|
| **Dashboard & Reports** | Full (all locations) | Full (assigned locations) | Limited (own stats) | Own metrics | ❌ |
| **Location Management** | Create/Edit/Delete | View assigned | View assigned | View assigned | ❌ |
| **Inventory — Raw Materials** | Full CRUD | Full CRUD | Add/View (edit own) | ❌ | ❌ |
| **Inventory — Products** | Full CRUD | Full CRUD | Add/View | ❌ | View (catalog) |
| **Supplier Management** | Full CRUD | Full CRUD | View | ❌ | ❌ |
| **Process Sales (POS)** | ✅ | ✅ | ✅ | ❌ | ❌ |
| **Apply Discounts** | Unlimited | Up to configured % | Up to configured % | ❌ | ❌ |
| **Approve Discounts ≥20%** | ✅ | ✅ | ❌ (request approval) | ❌ | ❌ |
| **Approve Discounts ≥30%** | ✅ | ❌ (request approval) | ❌ | ❌ | ❌ |
| **Refunds/Returns** | Unlimited | Up to ₹10,000 (configurable) | ❌ (request approval) | ❌ | Request |
| **Customer Management** | Full CRUD | Full CRUD | View/Search | ❌ | Own profile |
| **Employee Management** | Full CRUD | View/Edit assigned | ❌ | ❌ | ❌ |
| **Create Manager Accounts** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Create Employee/DP Accounts** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Attendance** | View all, configure | View team, approve outdoor | View & mark own | View & mark own | ❌ |
| **Delivery Assignment** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Delivery Tracking (Map)** | ✅ | ✅ | ❌ | Own location | Own order |
| **View Deliveries** | All | Assigned location | ❌ | Assigned only | Own orders |
| **Configuration/Settings** | ✅ | Limited | ❌ | ❌ | ❌ |
| **Place Orders (Customer App)** | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Tax Configuration** | ✅ | View | View | ❌ | ❌ |
| **Cash Register** | View all | Manage assigned | View own shift | ❌ | ❌ |

### 2.3 Discount Approval Workflow

- **< 20% discount**: Employee, Manager, and Owner can apply directly
- **≥ 20% and < 30%**: Requires Manager or Owner approval
- **≥ 30%**: Requires Owner approval only
- Thresholds are **configurable by the Owner**
- Pending approvals appear as notifications to the approver
- Sale can be parked/held while awaiting approval

### 2.4 Refund Approval Workflow

- **Manager**: Can approve refunds up to ₹10,000 (configurable by Owner)
- **Owner**: Can approve refunds of any amount
- **Employee**: Must request refund approval from Manager/Owner
- Refund request includes: order reference, reason, amount, photo evidence (optional)

---

## 3. Multi-Location Management

### 3.1 Location Types

| Type | Description | Example |
|------|-------------|---------|
| **Shop** | Retail point with POS, attendance geofence | Main shop, Branch shop |
| **Warehouse** | Storage for non-perishable inventory (vases, wrappings, foam) | Central warehouse |

### 3.2 Location Data Model

```
Location {
  id
  name                    -- "Main Shop", "Warehouse A"
  type                    -- "shop" | "warehouse"
  address                 -- Full street address
  latitude, longitude     -- GPS coordinates (for geofencing)
  geofence_radius         -- Default: 50 meters (configurable by Owner)
  phone
  email
  operating_hours         -- JSON: { mon: { open: "09:00", close: "18:00" }, ... }
  is_active
  created_by              -- Owner ID
  created_at, updated_at
}
```

### 3.3 Rules

- Only **Owners** can create/edit/delete locations
- Employees, Managers, and Delivery Partners are **assigned to one or more locations**
- Inventory is tracked **per location** — stock can be at Shop A, Shop B, or Warehouse
- Sales are recorded against the **shop location** where they occur
- Inter-location **stock transfers** can be initiated by Manager or Owner
- Attendance geofencing applies only to **shop** type locations

---

## 4. Inventory & Raw Materials

### 4.1 Material Categories & Units

The system supports **owner-configurable** material types and unit systems. The following are pre-seeded defaults:

| Category | Default Unit | Bundle/Box Support | Notes |
|----------|-------------|-------------------|-------|
| **Flowers** | Stems | Yes — bundle size configurable per variety (default: 20 stems/bundle, some: 10) | Perishable |
| **Ribbons** | Pieces | No | Non-perishable |
| **Vases** | Pieces | No | Non-perishable, stored in warehouse |
| **Wrapping Paper** | Pieces / Sheets | No | Non-perishable |
| **Floral Foam** | Blocks (pieces) | Yes — box size configurable per variety (default: 24 blocks/box) | Non-perishable |
| **Baskets** | Pieces | No | Non-perishable |
| **Decorative Items** | Pieces | No | Non-perishable |

### 4.2 Custom Material Types

Owners can **add new material categories** from the app with:
- Category name
- Default unit of measurement (stems, pieces, meters, kg, liters, sheets, etc.)
- Whether it supports bundle/box grouping
- Default bundle/box size
- Whether it is perishable or non-perishable
- Default storage location (shop or warehouse)

### 4.3 Material Data Model

```
MaterialCategory {
  id
  name                    -- "Flowers", "Floral Foam", etc.
  unit                    -- "stems", "pieces", "meters", "kg", etc.
  has_bundle              -- Boolean: supports bundle/box grouping
  default_bundle_size     -- e.g., 20 for flowers, 24 for foam
  is_perishable           -- true/false
  default_storage         -- "shop" | "warehouse"
  created_by
  created_at, updated_at
}

MaterialVariety {
  id
  category_id             -- FK → MaterialCategory
  name                    -- "Red Rose", "White Lily", "Green Floral Foam"
  sku                     -- Auto-generated or manual
  bundle_size_override    -- null = use category default, or specific number
  image_url
  min_stock_alert         -- Low-stock threshold (in base units)
  is_active
  created_by
  created_at, updated_at
}

MaterialStock {
  id
  variety_id              -- FK → MaterialVariety
  location_id             -- FK → Location (which shop/warehouse)
  quantity                -- Current stock in base units (stems, pieces)
  last_counted_at         -- Last physical count timestamp
  updated_at
}
```

### 4.4 Supplier Management

```
Supplier {
  id
  name
  phone
  email
  address
  gst_number              -- Optional
  notes
  is_active
  created_at, updated_at
}

SupplierMaterial {
  id
  supplier_id             -- FK → Supplier
  variety_id              -- FK → MaterialVariety
  default_price_per_unit  -- Last known price
}
```

### 4.5 Purchase / Receiving (Inward Stock)

```
PurchaseOrder {
  id
  supplier_id
  location_id             -- Receiving location
  expected_date           -- When delivery is expected
  expected_time           -- Approximate time
  status                  -- "expected" | "partially_received" | "received" | "cancelled"
  notes
  created_by              -- Manager/Owner who created the PO
  created_at, updated_at
}

PurchaseOrderItem {
  id
  purchase_order_id
  variety_id
  expected_quantity        -- How many bundles/units expected
  expected_unit            -- "bundles" | "stems" | "boxes" | "pieces"
  expected_price_per_unit
  received_quantity        -- Actual received (filled on arrival)
  received_quality         -- "good" | "average" | "poor" (optional)
  actual_price_per_unit    -- May differ from expected
  received_by              -- Employee/Manager who verified
  received_at
}
```

### 4.6 Incoming Material Alerts

- When a Purchase Order is created, **notifications are sent** to:
  - All employees at the receiving location
  - All managers of the receiving location
- Alert content: Supplier name, expected items with quantities, expected arrival time
- Alert types: Push notification + in-app notification
- On day of expected delivery: **morning reminder** notification at shop opening time

### 4.7 Daily Stock Reconciliation (Wastage Tracking)

```
DailyStockLog {
  id
  location_id
  variety_id
  date                    -- The business day
  opening_stock           -- Stock at start of day (auto-filled from previous closing or manual entry)
  received_stock          -- Total received from suppliers today (auto-calculated from PurchaseOrders)
  used_in_products        -- Auto-deducted when materials are logged in product creation
  closing_stock           -- Manual count at end of day by employee/manager
  wastage                 -- Calculated: opening + received - used - closing
  wastage_reason          -- Optional note: "wilted", "damaged", "theft", etc.
  counted_by              -- Employee/Manager who did the count
  verified_by             -- Manager who verified (optional)
  created_at
}
```

### 4.8 Wastage Rules & Alerts

- **Daily closing count** is required for all perishable materials (system prompts at configurable time)
- If wastage exceeds a configurable percentage (default: 10%) of opening stock → alert to Manager and Owner
- **Weekly/Monthly wastage trend reports** → visible in Dashboard
- Wastage value is calculated: `wastage_quantity × avg_purchase_price`

### 4.9 Stock Transfer (Between Locations)

```
StockTransfer {
  id
  from_location_id
  to_location_id
  variety_id
  quantity
  unit
  status                  -- "initiated" | "in_transit" | "received" | "cancelled"
  initiated_by
  received_by
  notes
  created_at, updated_at
}
```

---

## 5. Products & QR Codes

### 5.1 Product Types

| Type | Description | Pricing | Example |
|------|-------------|---------|---------|
| **Standard** | Pre-made, fixed-price products always available | Fixed price set by Manager/Owner | "Classic Red Rose Bouquet - ₹500" |
| **Custom / Made-to-Order** | Created per customer request, priced by materials | Dynamic (calculated + adjustable) | "Wedding centerpiece with 50 roses, lilies, foam" |

### 5.2 Product Data Model

```
Product {
  id
  name
  description
  type                    -- "standard" | "custom"
  category                -- "bouquet" | "arrangement" | "basket" | "single_stem" | "gift_combo" | etc.
  base_price              -- For standard products: the selling price; for custom: calculated estimate
  cost_price              -- Auto-calculated from materials (editable)
  tax_rate_id             -- FK → TaxRate
  image_url
  is_active               -- For standard products (can be deactivated)
  location_id             -- Where it was created
  created_by              -- Employee/Manager who made it
  created_at, updated_at
}

ProductMaterial {
  id
  product_id              -- FK → Product
  variety_id              -- FK → MaterialVariety
  quantity                -- How much of this material was used
  unit                    -- "stems", "pieces", etc.
  cost_at_time            -- Price per unit at the time of use (snapshot)
}

-- Each physical item gets a unique instance with a QR code
ProductInstance {
  id
  product_id              -- FK → Product
  qr_code                 -- Unique identifier encoded in the QR
  qr_image_url            -- Generated QR image path
  status                  -- "available" | "reserved" | "sold" | "expired" | "damaged"
  location_id             -- Current location
  created_by
  created_at
  sold_at
  expires_at              -- For perishable arrangements
}
```

### 5.3 Product Creation Flow (Employee)

1. Employee selects "Create Product" 
2. Chooses: Standard template OR Custom
3. **For Standard**: selects from template, system pre-fills materials list
4. **For Custom**: 
   a. Enters name, description
   b. Adds materials used (search/select from inventory)
   c. Enters quantity for each material
   d. System calculates estimated material cost
   e. Employee can enter custom selling price (cost estimate is a **suggestion, not binding**)
5. Takes photo of the finished product (optional but recommended)
6. Saves → system auto-generates unique QR code for this physical item
7. Inventory stock is **auto-deducted** for the materials used
8. QR can be printed as a label/sticker

### 5.4 QR Code Specifications

- **Format**: Unique alphanumeric code (e.g., `BLP-SH01-20260307-0042`)
  - `BLP` = BloomPOS prefix
  - `SH01` = Shop code
  - `20260307` = Date
  - `0042` = Sequential daily number
- **Encoded data**: URL or deep link that opens the product detail page
- **Scanning behavior** (for any user including walk-in customers):
  - Opens product details page showing: name, description, photo, price, materials used
  - Shows **"Add to Cart"** button
  - If product is already sold → shows "This item has been sold"
- **Printable**: Generate a PDF label (configurable size: small sticker, standard label) with:
  - QR code image
  - Product name
  - Price
  - Date made

---

## 6. Sales / POS

### 6.1 Tax Configuration

```
TaxRate {
  id
  name                    -- "GST 5%", "GST 12%", "GST 18%", "No Tax"
  percentage              -- 5.0, 12.0, 18.0, 0.0
  is_default              -- One default rate
  is_active
  effective_from          -- Date from which this rate applies
  created_by
  created_at, updated_at
}
```

- Tax rates are **configurable per product** by Owner
- Tax rates can be **updated over time** (with effective date to preserve historical accuracy)
- Receipts show tax breakdown (base price + tax amount)

### 6.2 Sale / Transaction Data Model

```
Sale {
  id
  sale_number             -- Auto-generated: "INV-SH01-20260307-001"
  location_id             -- Shop where sale happened
  customer_id             -- FK → Customer (nullable for guest)
  customer_name           -- For guest: manually entered name
  customer_phone          -- For guest: manually entered phone
  
  subtotal                -- Sum of line items before tax and discount
  tax_total               -- Total tax amount
  discount_amount         -- Total discount applied
  discount_type           -- "fixed" | "percentage" | null
  discount_percentage     -- If percentage-based
  discount_approved_by    -- FK → User (if approval was needed)
  delivery_charges        -- If delivery order
  grand_total             -- Final amount: subtotal + tax - discount + delivery
  
  payment_status          -- "paid" | "partial" | "pending" | "refunded"
  order_type              -- "walk_in" | "pickup" | "delivery" | "pre_order"
  
  special_instructions    -- Internal notes (NOT visible to customer)
  customer_notes          -- Notes from/for customer (visible on customer receipt)
  
  created_by              -- Employee/Manager who processed the sale
  created_at, updated_at
}

SaleItem {
  id
  sale_id                 -- FK → Sale
  product_instance_id     -- FK → ProductInstance (optional, for QR-tracked items)
  product_id              -- FK → Product
  product_name            -- Snapshot: name at time of sale
  quantity                -- Usually 1 for flower arrangements
  unit_price              -- Price per item at time of sale
  tax_rate                -- Tax percentage applied
  tax_amount              -- Calculated tax for this line
  discount_amount         -- Item-level discount (if any)
  line_total              -- (unit_price × quantity) + tax - discount
}

Payment {
  id
  sale_id                 -- FK → Sale
  method                  -- "cash" | "card" | "upi"
  amount                  -- Amount paid via this method
  reference_number        -- Transaction ID for card/UPI
  received_by             -- Employee who received payment
  created_at
}
```

### 6.3 Split Payment Support

- A sale can have **multiple Payment records** (e.g., ₹500 cash + ₹1,200 UPI)
- System validates: sum of all payments ≥ grand_total before marking as "paid"
- If sum < grand_total → marked as "partial" → remaining becomes customer **credit/dues**

### 6.4 POS Sale Flow

1. **Start Sale**: Employee taps "New Sale"
2. **Add Customer**: Search existing customer (by phone/name) OR add new OR continue as "Guest"
3. **Add Items**: 
   - **Scan QR** → item auto-added to cart with price
   - **Search** → browse products, select, add to cart
   - **Manual entry** → for ad-hoc items not in system
4. **Review Cart**: Shows items, quantities, prices, tax per item
5. **Apply Discount** (if any):
   - Enter fixed amount or percentage
   - If discount ≥ 20% → system requests Manager approval (push notification sent)
   - If discount ≥ 30% → system requests Owner approval
   - Sale can be **parked/held** while awaiting approval
6. **Select Order Type**: Walk-in / Pickup / Delivery
   - **Pickup**: Select preferred pickup time
   - **Delivery**: Select/add delivery address, assign delivery partner (or later), add delivery charges
7. **Add Special Instructions**: Internal notes (employee/manager only, not on customer receipt)
8. **Add Customer Notes**: Notes visible to customer (e.g., "Happy Anniversary!")
9. **Payment**: Select method(s), enter amounts, process
10. **Complete**: Generate receipt, print delivery challan (if delivery), update inventory status

### 6.5 Pre-Orders / Advance Orders

```
PreOrder {
  -- Uses the Sale model with:
  order_type = "pre_order"
  
  scheduled_date          -- When the order should be ready
  scheduled_time          -- Preferred time
  advance_payment         -- Amount paid in advance
  remaining_amount        -- Amount due on delivery/pickup
  reminder_sent           -- Boolean: whether reminder notifications were sent
}
```

- Pre-orders generate **reminders**:
  - **2 days before**: Notification to Manager and Owner
  - **1 day before**: Notification to Manager, Owner, and assigned Employee
  - **Day of**: Morning notification to all relevant staff
- Pre-orders appear in a dedicated **"Upcoming Orders"** section on the dashboard

### 6.6 Recurring Orders

```
RecurringOrder {
  id
  customer_id
  frequency               -- "daily" | "weekly" | "biweekly" | "monthly"
  day_of_week             -- For weekly: 0-6 (Mon-Sun)
  day_of_month            -- For monthly: 1-31
  preferred_time
  delivery_address_id     -- FK → CustomerAddress
  
  -- Template items
  items                   -- JSON array of product_id + quantity
  estimated_total
  special_instructions
  
  is_active
  next_occurrence         -- Auto-calculated next order date
  last_generated_at       -- When system last auto-created an order from this
  created_by
  created_at, updated_at
}
```

- System auto-generates a Sale from the recurring template on/before the scheduled date
- Manager receives notification to confirm/modify each auto-generated order
- Customer receives confirmation notification

### 6.7 Returns & Refunds

```
Refund {
  id
  sale_id                 -- Original sale
  amount
  reason
  photo_evidence          -- Optional image
  status                  -- "requested" | "approved" | "rejected" | "processed"
  requested_by            -- Employee who initiated
  approved_by             -- Manager/Owner who approved
  refund_method           -- "cash" | "card" | "upi" | "store_credit"
  notes
  created_at, updated_at
}
```

**Approval Rules:**
- Refund ≤ ₹10,000 → Manager can approve
- Refund > ₹10,000 → Owner approval required
- ₹10,000 threshold is **configurable by Owner**
- Refunded amount adjusts the daily cash register

### 6.8 Daily Cash Register

```
CashRegister {
  id
  location_id
  date
  opened_by               -- Employee/Manager who opened
  opening_balance         -- Cash in drawer at start
  
  -- Auto-calculated from sales
  total_cash_sales
  total_card_sales
  total_upi_sales
  total_refunds_cash
  
  expected_cash           -- opening + cash_sales - cash_refunds
  actual_cash             -- Manual count at closing
  discrepancy             -- expected - actual
  
  closed_by
  closing_notes           -- Explanation for discrepancy
  opened_at
  closed_at
}
```

- Opening balance is entered at start of shift/day
- Closing requires manual cash count
- Discrepancies are flagged and visible to Owner
- Historical cash register records are maintained for audit

---

## 7. Orders & Order Lifecycle

### 7.1 Order Statuses

```
Placed → In Preparation → Ready → Out for Delivery → Delivered
                                 → Ready for Pickup → Picked Up
```

| Status | Triggered By | Notifications |
|--------|-------------|---------------|
| **Placed** | Sale completed / Customer places order | Customer: confirmation; Staff: new order alert |
| **In Preparation** | Employee starts making the arrangement | Customer: "Your order is being prepared" |
| **Ready** | Employee marks as ready | Customer: "Your order is ready!"; For delivery: notify Manager to assign delivery partner |
| **Out for Delivery** | Delivery partner picks up | Customer: "Your order is on its way" + live tracking |
| **Delivered** | Delivery partner marks with photo proof | Customer: "Delivered!" + photo; Manager/Owner: delivery confirmation |
| **Ready for Pickup** | Same as Ready, for pickup orders | Customer: "Your order is ready for pickup at [location]" |
| **Picked Up** | Employee marks when customer picks up | Customer: "Thank you for picking up your order!" |

### 7.2 Order Assignment

- For **delivery orders**: Manager assigns a Delivery Partner from available pool
- Assignment notification sent to Delivery Partner with order details and delivery address
- If Delivery Partner doesn't acknowledge within configurable time → Manager is alerted

---

## 8. Customer Management

### 8.1 Customer Data Model

```
Customer {
  id
  name
  phone                   -- Primary identifier (unique)
  email                   -- Optional
  password                -- For app login (hashed)
  
  -- Special dates
  birthday
  anniversary
  custom_dates            -- JSON array: [{ label: "Mom's birthday", date: "03-15" }]
  
  -- Financial
  total_spent             -- Lifetime value
  credit_balance          -- Amount owed to shop (pending payments)
  
  notes                   -- Internal notes about the customer
  is_active
  created_at, updated_at
}

CustomerAddress {
  id
  customer_id
  label                   -- "Home", "Office", "Temple", etc.
  address_line_1
  address_line_2
  city
  state
  pincode
  latitude, longitude     -- For delivery routing
  is_default              -- Default delivery address
  created_at, updated_at
}
```

### 8.2 Customer Credit / Dues

- When a sale is partially paid → remaining amount is added to `credit_balance`
- Customer can see their outstanding balance in the app
- When customer makes a payment toward credit:
  ```
  CreditPayment {
    id
    customer_id
    amount
    method                -- "cash" | "card" | "upi"
    received_by           -- Employee/Manager
    notes
    created_at
  }
  ```
- Credit history is visible to Manager, Owner, and the Customer themselves

### 8.3 Special Date Reminders

- System sends reminders for stored special dates:
  - **7 days before**: Notification to Customer — "Upcoming: [Mom's Birthday]. Order flowers?"
  - **3 days before**: Reminder to Customer
  - **1 day before**: Final reminder to Customer
- If the customer placed an order for the same date last year:
  - Notification to Manager — "Repeat opportunity: [Customer Name] ordered [product] last year for [occasion]"
- Manager can view an **upcoming special dates calendar**

### 8.4 Customer App Features

- **Browse catalog** — view standard products with prices
- **Scan QR** — view product details, add to cart
- **Place orders** — select products, delivery/pickup, preferred time, payment
- **Order history** — view all past and current orders with status
- **Order tracking** — live delivery tracking for out-for-delivery orders
- **Credit balance** — view outstanding dues
- **Manage addresses** — add/edit delivery addresses
- **Profile** — update name, phone, special dates

---

## 9. Delivery Management

### 9.1 Delivery Data Model

```
Delivery {
  id
  sale_id                 -- FK → Sale
  delivery_partner_id     -- FK → User (delivery partner)
  
  pickup_location_id      -- FK → Location (shop)
  delivery_address_id     -- FK → CustomerAddress
  delivery_address_text   -- Snapshot of address at time of order
  
  scheduled_date
  scheduled_time
  
  status                  -- "assigned" | "picked_up" | "in_transit" | "delivered" | "failed"
  
  picked_up_at            -- When partner picked up from shop
  delivered_at            -- When marked as delivered
  delivery_photo_url      -- Photo proof of delivery
  delivery_latitude       -- GPS at delivery location
  delivery_longitude
  
  delivery_duration       -- Auto-calculated: delivered_at - picked_up_at
  distance_km             -- Calculated from route
  
  customer_signature      -- Optional: digital signature
  failure_reason          -- If delivery failed
  
  notes                   -- Internal delivery notes
  created_at, updated_at
}
```

### 9.2 Delivery Partner Live Tracking

- Delivery partners share **live location** while on duty (when app is active and they have active deliveries)
- Manager/Owner can see a **live map** showing all active delivery partners
- Map shows: partner name, current delivery info, destination pin
- Location updates every **30 seconds** (configurable)

### 9.3 Delivery Assignment Flow

1. Order is marked "Ready" → Manager receives notification
2. Manager opens delivery queue → sees unassigned deliveries
3. Manager selects delivery partner (can see who's available, who's on delivery)
4. Delivery partner receives push notification with order details
5. Partner marks "Picked Up" → customer notified "Out for Delivery"
6. Partner navigates to customer location
7. Partner marks "Delivered" + uploads photo + location auto-captured
8. System records delivery time and metrics

### 9.4 Delivery Charges

- Delivery charges are **configurable per product** or as a flat rate
- Can be overridden per order by Manager/Owner
- Free delivery can be offered (set charge to ₹0)

### 9.5 Delivery Performance Metrics

- Average delivery time per partner
- Total deliveries per day/week/month
- On-time delivery rate
- Failed delivery rate
- Distance covered

---

## 10. Attendance & Location Tracking

### 10.1 Attendance Data Model

```
Attendance {
  id
  user_id                 -- FK → User (Employee/Delivery Partner)
  location_id             -- FK → Location (shop)
  date
  
  clock_in                -- Timestamp
  clock_in_method         -- "auto_geofence" | "manual"
  clock_in_latitude
  clock_in_longitude
  
  clock_out               -- Timestamp
  clock_out_method        -- "auto_geofence" | "manual" | "auto_timeout"
  clock_out_latitude
  clock_out_longitude
  
  total_hours             -- Calculated: clock_out - clock_in - breaks
  outdoor_hours           -- Approved outdoor duty time
  effective_hours         -- total_hours + outdoor_hours
  
  status                  -- "present" | "absent" | "half_day" | "on_leave"
  late_arrival            -- Boolean: arrived after scheduled time
  early_departure         -- Boolean: left before scheduled time
  
  notes
  created_at, updated_at
}
```

### 10.2 Geofence-Based Auto Attendance

**Clock In:**
- When employee's device enters the shop's geofence (50m radius, configurable) → **auto clock-in**
- System records GPS coordinates and timestamps
- If employee arrives after operating hours start → **flagged as late arrival**

**Clock Out (Auto-timeout Rule):**
- When employee's device exits the geofence → **timer starts** (default: 15 minutes)
- Timer duration is **configurable by Manager per employee**
- If employee returns within the timeout period → no action (brief break)
- If employee remains outside after timeout → **auto clock-out notification** sent
- Employee is marked as "off duty" after timeout
- Manager receives alert: "[Employee Name] has left the shop for more than [X] minutes"

**Early Departure:**
- If clock-out happens before end of scheduled operating hours → flagged as **early departure**

### 10.3 Outdoor Duty

```
OutdoorDuty {
  id
  attendance_id           -- FK → Attendance
  user_id
  approved_by             -- FK → User (Manager)
  
  start_time
  end_time                -- Can be open-ended until employee returns
  duration                -- Auto-calculated
  
  reason                  -- "Bank visit", "Supplier pickup", etc.
  status                  -- "requested" | "approved" | "rejected" | "completed"
  
  created_at
}
```

- Employee requests outdoor duty from the app → Manager receives notification
- Manager can pre-approve or approve on request
- Approved outdoor time is **added to effective working hours**
- During approved outdoor duty, the geofence auto-timeout rule is **paused**

### 10.4 Delivery Partner Location Tracking

- Live location shared when on active delivery
- Route tracking: GPS breadcrumbs every 30 seconds during active delivery
- Idle time tracking between deliveries
- Daily distance covered calculation
- Battery-efficient background location (significant location changes when not on active delivery)

### 10.5 Attendance Reports (Owner Only for Daily Reports)

- **Daily report**: Each employee's in-time, out-time, total hours, late flags, outdoor hours
- **Weekly/Monthly summary**: Total hours per employee, attendance percentage, late count
- **Anomaly alerts**: Employees with ≥ 3 late arrivals in a week → alert to Owner

---

## 11. Reports & Analytics

### 11.1 Must-Have Reports

#### Daily Sales Summary
- Total revenue (today, vs yesterday, vs same day last week)
- Number of transactions
- Average order value
- Payment mode breakdown (cash / card / UPI — amounts and percentages)
- Top selling products of the day
- Sales by employee (who processed how much)

#### Inventory Status
- Current stock levels by material (with low-stock highlighting)
- Low stock alerts (materials below configured minimum)
- Wastage report: daily, weekly, monthly wastage by material
- Wastage value (₹ lost to wastage)
- Cost of goods sold (COGS) for the day
- Materials used vs materials received trend

#### Customer Insights
- Top customers by revenue (lifetime and this month)
- Repeat purchase rate
- New vs returning customers this month
- Customers with outstanding credit/dues
- Upcoming special dates (next 30 days)

#### Employee Performance
- Attendance summary (present days, late count, total hours)
- Sales processed per employee (count and value)
- Products created per employee
- Average orders handled per shift

### 11.2 Nice-to-Have Reports

#### Delivery Metrics
- Average delivery time overall and per delivery partner
- Deliveries per day/partner
- On-time vs delayed deliveries
- Failed delivery rate and reasons

#### Profit Margins
- Product-level margins (selling price vs material cost)
- Category-level profitability
- Daily/monthly profit trends
- Most and least profitable products

---

## 12. Notifications

### 12.1 Notification Types

| Event | Recipients | Channel |
|-------|-----------|---------|
| **New order placed** | Manager, assigned Employee | Push + In-app |
| **Order status change** | Customer | Push + In-app |
| **Discount approval request** | Manager/Owner (based on threshold) | Push + In-app |
| **Refund approval request** | Manager/Owner (based on amount) | Push + In-app |
| **Low stock alert** | Manager, Owner | Push + In-app |
| **Incoming material alert** | Employees & Manager at location | Push + In-app |
| **Purchase order — day-of reminder** | Employees & Manager at location | Push (morning) |
| **Employee left geofence** | Manager | Push |
| **Auto clock-out** | Employee (self), Manager | Push |
| **Pre-order reminder (2d, 1d, day-of)** | Manager, Owner | Push + In-app |
| **Recurring order generated** | Manager | Push + In-app |
| **Special date reminder** | Customer, Manager | Push + In-app |
| **Delivery assigned** | Delivery Partner | Push + In-app |
| **Delivery completed** | Customer, Manager | Push + In-app |
| **Cash register discrepancy** | Owner | Push + In-app |
| **Wastage threshold exceeded** | Manager, Owner | Push + In-app |
| **Customer credit overdue** | Manager | In-app |
| **Delivery partner idle too long** | Manager | Push |
| **Late arrival** | Manager, Owner | In-app |

### 12.2 Notification Data Model

```
Notification {
  id
  user_id                 -- Recipient
  type                    -- Enum of notification types
  title
  body
  data                    -- JSON: { orderId, saleId, etc. } for navigation
  is_read
  created_at
}
```

---

## 13. Delivery Challan & Receipts

### 13.1 Digital Receipt (PDF)

Generated for every completed sale. Contains:

- **Header**: Shop name, address, phone, GST number, logo
- **Receipt number** and date/time
- **Customer details**: Name, phone
- **Items table**: Product name, quantity, unit price, tax, subtotal per item
- **Totals**: Subtotal, tax breakdown (per rate), discounts, delivery charges, grand total
- **Payment details**: Method(s), amounts, reference numbers
- **Footer**: Thank you message, return policy, shop contact

### 13.2 Delivery Challan (Two Copies)

Generated for every delivery order. **Two copies** are printed:

#### Copy 1 — Shop Record Copy
Contains everything below PLUS:
- **Special Instructions** (internal notes from Employee/Manager/Owner — NOT visible to customer)
- **"SHOP COPY"** watermark or label

#### Copy 2 — Customer/Receiver Copy
Contains:
- **Header**: Shop name, address, phone, logo
- **Challan number** and date
- **Sender details**: Name, phone (the customer who placed the order)
- **Receiver details**: Name, delivery address, phone
- **Message**: Gift message / occasion note (if any, from customer notes)
- **Items table**: Product name, quantity (no prices unless configured to show)
- **Delivery partner**: Name, phone
- **"CUSTOMER COPY"** label
- **Signature line**: Space for receiver signature

### 13.3 QR Label (Printable)

For each ProductInstance:
- QR code image (scannable)
- Product name
- Price
- Date created
- Shop name
- Size options: Small sticker (30mm × 20mm), Standard label (50mm × 30mm)

---

## 14. Configuration & Settings

All configurable values, managed by **Owner** (some delegated to Manager):

### 14.1 Business Settings (Owner Only)

| Setting | Default | Description |
|---------|---------|-------------|
| `shop_name` | — | Business name on receipts |
| `shop_logo` | — | Logo image for receipts/challans |
| `gst_number` | — | GST registration number |
| `currency` | ₹ (INR) | Currency symbol |
| `receipt_footer` | "Thank you!" | Custom text on receipts |
| `return_policy_text` | — | Displayed on receipts |

### 14.2 Location Settings (Owner Only)

| Setting | Default | Description |
|---------|---------|-------------|
| `geofence_radius` | 50m | Per location |
| `operating_hours` | — | Per location, per day |
| `address`, `lat/lng` | — | Physical location for geofencing |

### 14.3 Operational Settings

| Setting | Default | Configurable By |
|---------|---------|----------------|
| `discount_manager_threshold` | 20% | Owner |
| `discount_owner_threshold` | 30% | Owner |
| `refund_manager_limit` | ₹10,000 | Owner |
| `geofence_timeout_minutes` | 15 | Manager (per employee) |
| `wastage_alert_percentage` | 10% | Owner |
| `low_stock_alert_threshold` | Per material | Manager/Owner |
| `default_bundle_size` | 20 | Owner |
| `default_foam_box_size` | 24 | Owner |
| `delivery_location_interval` | 30 seconds | Owner |
| `pre_order_reminder_days` | [2, 1, 0] | Owner |
| `special_date_reminder_days` | [7, 3, 1] | Owner |
| `default_tax_rate` | null | Owner |

---

## 15. Technical Architecture

### 15.1 Frontend (React Native / Expo)

```
app/src/
├── components/          -- Reusable UI components
│   ├── Button.js
│   ├── Input.js
│   ├── LoadingScreen.js
│   ├── QRScanner.js
│   ├── QRGenerator.js
│   ├── ProductCard.js
│   ├── OrderCard.js
│   ├── AttendanceCard.js
│   ├── DeliveryMap.js
│   ├── CartItem.js
│   ├── StatsCard.js
│   └── ...
├── constants/
│   └── theme.js
├── context/
│   ├── AuthContext.js    -- Auth state, role-based access
│   └── CartContext.js    -- POS cart state
├── hooks/
│   ├── useLocation.js    -- Geofence & location tracking
│   ├── useNotifications.js
│   └── usePermissions.js
├── navigation/
│   ├── RootNavigator.js
│   ├── AuthNavigator.js
│   ├── OwnerNavigator.js
│   ├── ManagerNavigator.js
│   ├── EmployeeNavigator.js
│   ├── DeliveryNavigator.js
│   └── CustomerNavigator.js
├── screens/
│   ├── auth/
│   │   ├── LoginScreen.js
│   │   └── RegisterScreen.js (Customer self-registration)
│   ├── dashboard/
│   │   └── DashboardScreen.js
│   ├── inventory/
│   │   ├── MaterialsListScreen.js
│   │   ├── AddMaterialScreen.js
│   │   ├── StockCountScreen.js
│   │   ├── PurchaseOrdersScreen.js
│   │   └── WastageReportScreen.js
│   ├── products/
│   │   ├── ProductsListScreen.js
│   │   ├── CreateProductScreen.js
│   │   ├── ProductDetailScreen.js
│   │   └── QRLabelScreen.js
│   ├── pos/
│   │   ├── POSScreen.js
│   │   ├── CartScreen.js
│   │   ├── PaymentScreen.js
│   │   └── ReceiptScreen.js
│   ├── orders/
│   │   ├── OrdersListScreen.js
│   │   ├── OrderDetailScreen.js
│   │   ├── PreOrdersScreen.js
│   │   └── RecurringOrdersScreen.js
│   ├── customers/
│   │   ├── CustomersListScreen.js
│   │   ├── CustomerDetailScreen.js
│   │   └── CustomerOrderHistoryScreen.js
│   ├── delivery/
│   │   ├── DeliveryQueueScreen.js
│   │   ├── DeliveryMapScreen.js
│   │   ├── DeliveryDetailScreen.js
│   │   └── DeliveryProofScreen.js
│   ├── attendance/
│   │   ├── AttendanceScreen.js
│   │   ├── AttendanceReportScreen.js
│   │   └── OutdoorDutyScreen.js
│   ├── suppliers/
│   │   ├── SuppliersListScreen.js
│   │   └── SupplierDetailScreen.js
│   ├── reports/
│   │   ├── SalesReportScreen.js
│   │   ├── InventoryReportScreen.js
│   │   ├── EmployeeReportScreen.js
│   │   └── CustomerReportScreen.js
│   ├── settings/
│   │   ├── SettingsScreen.js
│   │   ├── LocationsScreen.js
│   │   ├── RolesScreen.js
│   │   └── TaxConfigScreen.js
│   └── profile/
│       └── ProfileScreen.js
└── services/
    └── api.js
```

### 15.2 Backend (Express.js)

```
server/
├── server.js
├── config/
│   └── database.js
├── middleware/
│   ├── auth.js           -- JWT verification
│   ├── authorize.js      -- Role-based access control
│   ├── errorHandler.js
│   └── upload.js         -- Image upload handling
├── routes/
│   ├── auth.js
│   ├── users.js
│   ├── locations.js
│   ├── materials.js
│   ├── suppliers.js
│   ├── purchaseOrders.js
│   ├── products.js
│   ├── sales.js
│   ├── orders.js
│   ├── customers.js
│   ├── deliveries.js
│   ├── attendance.js
│   ├── cashRegister.js
│   ├── reports.js
│   ├── notifications.js
│   └── settings.js
├── utils/
│   ├── qrGenerator.js
│   ├── pdfGenerator.js   -- Receipts, challans, labels
│   ├── notifications.js  -- Push notification service
│   └── geofence.js       -- Geofence calculations
└── uploads/
```

### 15.3 Database

- **Development**: SQLite (better-sqlite3) — current setup
- **Production-ready**: Can migrate to PostgreSQL when needed
- All tables include `created_at`, `updated_at` timestamps
- Soft deletes where appropriate (`is_active` flag)
- Proper indexing on foreign keys and frequently queried columns

### 15.4 Image Storage

- Product images, delivery proof photos, receipts → stored on **server filesystem** (in `/uploads/` organized by type and date)
- Can be migrated to **S3/Cloudinary** later for scalability
- Image paths stored as relative URLs in the database

### 15.5 Key Libraries (Additional)

**Frontend:**
- `expo-camera` / `expo-barcode-scanner` — QR scanning
- `react-native-qrcode-svg` — QR generation
- `expo-location` — Geofencing & live tracking (already installed)
- `expo-notifications` — Push notifications
- `expo-print` / `expo-sharing` — PDF receipt generation & printing
- `react-native-maps` — Delivery tracking map

**Backend:**
- `qrcode` — Server-side QR generation
- `pdfkit` or `puppeteer` — PDF generation for receipts/challans
- `node-cron` — Scheduled jobs (reminders, recurring orders)
- `multer` — File uploads (already installed)
- `socket.io` — Real-time delivery tracking (live location)

---

## 16. Implementation Phases

### Phase 1 — Foundation (Auth, Roles, Locations)
- Restructure database schema for new models
- Role-based authentication (Owner, Manager, Employee, Delivery Partner, Customer)
- Role-based navigation (different app experience per role)
- Multi-location management (CRUD for shops/warehouses)
- Settings/configuration system
- Basic user management (Owner creates Manager/Employee/Delivery Partner accounts)

### Phase 2 — Inventory & Raw Materials
- Material categories & varieties (CRUD with custom types)
- Supplier management
- Purchase orders with incoming material alerts
- Stock tracking per location
- Stock receiving flow (verify incoming materials)
- Daily stock reconciliation (opening/closing counts, wastage calculation)
- Low stock alerts
- Stock transfers between locations

### Phase 3 — Products & QR
- Product creation (standard templates + custom/made-to-order)
- Material usage logging in product creation (auto-deduction from inventory)
- Cost estimation (suggestion-based, editable)
- QR code generation per physical product instance
- QR scanning (product details + add to cart)
- QR label printing (PDF generation)
- Product catalog browsing

### Phase 4 — POS & Sales
- Cart & checkout flow
- Tax configuration & per-product tax rates
- Discount system with approval workflow
- Split payment support (cash + card + UPI)
- Order type selection (walk-in, pickup, delivery)
- Pre-orders with advance payment
- Digital receipt generation (PDF)
- Daily cash register (open, close, reconcile)
- Special instructions (internal) & customer notes

### Phase 5 — Customer Management
- Customer database (CRUD with phone-based lookup)
- Multiple delivery addresses per customer
- Customer credit/dues tracking
- Special dates storage & reminder system
- Customer order history
- Guest checkout support
- Customer self-registration & app experience

### Phase 6 — Orders & Delivery
- Order lifecycle & status management
- Delivery assignment by Manager
- Delivery partner app experience (view assignments, navigate, mark delivered)
- Photo proof of delivery with GPS
- Delivery challan generation (two copies — shop + customer)
- Delivery charges configuration
- Recurring orders system
- Order pickup flow with preferred time

### Phase 7 — Attendance & Location
- Geofence-based auto clock-in/out
- Configurable timeout per employee
- Outdoor duty request/approval flow
- Late arrival / early departure flags
- Attendance reports (daily, weekly, monthly)
- Delivery partner live location tracking
- Live delivery map for Manager/Owner

### Phase 8 — Reports & Dashboard
- Daily sales summary dashboard
- Inventory status & wastage reports
- Customer insights
- Employee performance reports
- Delivery metrics (nice-to-have)
- Profit margin analysis (nice-to-have)

### Phase 9 — Notifications & Polish
- Push notification infrastructure
- All notification triggers (see Section 12)
- In-app notification center
- WhatsApp receipt sharing (later phase)
- Thermal printer integration (later phase)
- Offline support (later phase)
- Loyalty/rewards program (later phase)

---

*This document serves as the single source of truth for the BloomPOS project. All implementation decisions should reference this PRD. Updates to requirements should be reflected here first.*
