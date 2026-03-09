# BloomCart POS — Progress Tracker

**Project**: BloomCart POS  
**Last Updated**: 9 March 2026  
**Current Phase**: Phase 6 (Production & Hybrid Stock) In Progress

---

## Status Legend

| Symbol | Meaning |
|--------|---------|
| ✅ | Completed |
| 🔄 | In Progress |
| ⬜ | Not Started |
| 🐛 | Bug Found & Fixed |

---

## Phase 1 — Foundation (Auth, Roles, Locations)

**Status**: ✅ Complete  
**Started**: 7 March 2026  
**Completed**: 7 March 2026

### Backend

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1.1 | Database schema (users, locations, user_locations, settings, notifications, tax_rates) | ✅ | 6 tables, indexes, seed data (17 settings, 5 GST rates) |
| 1.2 | Auth middleware (authenticate, authorize, optionalAuth) | ✅ | JWT-based, checks is_active |
| 1.3 | Error handler middleware | ✅ | errorHandler + notFound (404) |
| 1.4 | Auth routes (register, login, /me, /profile, /password, /setup, /setup-status) | ✅ | Phone-based login, owner first-time setup |
| 1.5 | Users routes (CRUD + role filtering + location assignment + password reset) | ✅ | Pagination, search, role-based access |
| 1.6 | Locations routes (CRUD + assign/unassign staff) | ✅ | Owner-only create/edit, role-scoped list |
| 1.7 | Settings routes (key-value CRUD + tax rates CRUD) | ✅ | Owner-only editing |
| 1.8 | server.js — all routes wired, middleware (helmet, cors, morgan) | ✅ | Health check, graceful shutdown |

### Frontend

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1.9 | API service (all endpoints) | ✅ | Auth, users, locations, settings, tax rates |
| 1.10 | AuthContext (login, register, ownerSetup, logout, session restore) | ✅ | AsyncStorage persistence, active location |
| 1.11 | Theme (colors, spacing, fonts, border radius, role badge colors) | ✅ | Rose pink primary, flower shop branding |
| 1.12 | RootNavigator (loading → auth/main switch) | ✅ | Checks isSetupComplete |
| 1.13 | AuthNavigator (Setup, Login, Register) | ✅ | Conditional initial route |
| 1.14 | MainNavigator (role-based bottom tabs + stacks) | ✅ | Dashboard, Locations, Staff, Profile tabs |
| 1.15 | SetupScreen (first-time owner setup) | ✅ | |
| 1.16 | LoginScreen (phone + password) | ✅ | |
| 1.17 | RegisterScreen (customer self-registration) | ✅ | |
| 1.18 | DashboardScreen (greeting, quick actions, stats) | ✅ | Fetches live location count on focus |
| 1.19 | LocationsScreen (list + FAB) | ✅ | |
| 1.20 | LocationDetailScreen (details + staff list) | ✅ | |
| 1.21 | LocationFormScreen (create/edit with type picker) | ✅ | |
| 1.22 | UsersScreen (staff list, role filter chips) | ✅ | |
| 1.23 | UserFormScreen (create/edit, role selector, location checkboxes) | ✅ | |
| 1.24 | ProfileScreen (view/edit, change password, logout) | ✅ | |
| 1.25 | SettingsScreen (key-value settings editor) | ✅ | |
| 1.26 | Reusable components (Button, Input, LoadingScreen) | ✅ | |

### Bugs Fixed

| # | Bug | Fix |
|---|-----|-----|
| B1.1 | Duplicate BorderRadius export in theme.js | Removed duplicate block |
| B1.2 | SetupScreen sent `businessName`, backend expects `shopName` | Changed to `shopName` |
| B1.3 | Dashboard showed 0 locations (stale auth context) | Fetch live from API on focus |
| B1.4 | Manager can't see assigned location (`locationIds` vs `location_ids`) | Fixed to snake_case `location_ids` |
| B1.5 | Location detail showed 0 staff (staff at `response.data.staff`, not inside location) | Merged staff into location object |
| B1.6 | Staff count mismatch list vs detail (inactive users counted) | Filtered `u.is_active = 1` in count query |
| B1.7 | Assign/unassign staff broken (`userIds` vs `user_ids`) | Fixed to snake_case `user_ids` |
| B1.8 | Edit staff screen doesn't pre-select assigned locations | Fetch user's locations via `getUser(id)` on edit |
| B1.9 | Keyboard doesn't dismiss when tapping outside inputs | Added DismissKeyboard wrapper + `keyboardShouldPersistTaps="handled"` on all 7 form screens |

### Phase 1 Testing

| # | Test | Status | Notes |
|---|------|--------|-------|
| T1.1 | Server health check (`/api/health`) | ✅ | Returns success |
| T1.2 | First-time owner setup | ✅ | Creates owner, returns JWT |
| T1.3 | Owner login | ✅ | Returns token + locations |
| T1.4 | Location CRUD | ✅ | Create, list, detail all working |
| T1.5 | User creation with location assignment | ✅ | Manager assigned to location via `location_ids` |
| T1.6 | Manager login sees assigned locations | ✅ | Returns correct locations |
| T1.7 | Location detail shows correct staff list & count | ✅ | Count matches between list and detail |
| T1.8 | Settings retrieval (17 default settings) | ✅ | All returned |
| T1.9 | Expo app bundles without errors | ✅ | 1042 modules, no syntax errors |
| T1.10 | Full app flow (Setup → Login → Dashboard → Locations → Staff → Profile) | ✅ | Manual test passed |

---

## Phase 2 — Inventory & Raw Materials

**Status**: ✅ Complete  
**Started**: 7 March 2026  
**Completed**: 7 March 2026

### Backend

| # | Task | Status | Notes |
|---|------|--------|-------|
| 2.1 | Database tables (material_categories, materials, material_stock, suppliers, supplier_materials, purchase_orders, purchase_order_items, material_transactions, daily_stock_logs, stock_transfers) | ✅ | 10 tables, indexes, seed data (7 default categories) |
| 2.2 | Material categories routes (CRUD with custom types) | ✅ | List, detail w/ material count, create, update, soft-delete |
| 2.3 | Materials routes (CRUD with location stock tracking) | ✅ | Search, category filter, auto-SKU, low-stock endpoint |
| 2.4 | Supplier management routes (CRUD) | ✅ | CRUD + supplier-material linking with default pricing |
| 2.5 | Purchase orders routes (create, receive, list, detail) | ✅ | Auto PO number, partial/full receive, status transitions |
| 2.6 | Stock transactions routes (add, deduct, transfer, wastage) | ✅ | Wastage, usage, adjustment, return types; full history |
| 2.7 | Stock reconciliation routes (opening/closing counts, wastage calc) | ✅ | Daily stock logs upsert, actual vs system comparison |
| 2.8 | Low stock alert logic | ✅ | GET /materials/low-stock endpoint, min_stock_alert field |
| 2.9 | Stock transfer between locations | ✅ | Initiate → receive/cancel, deducts from source on create |

### Frontend

| # | Task | Status | Notes |
|---|------|--------|-------|
| 2.10 | API service — inventory methods | ✅ | ~40 new methods for all Phase 2 endpoints |
| 2.11 | Inventory tab in MainNavigator | ✅ | Leaf icon, nested stack with 16 screens, owner/manager/employee |
| 2.12 | CategoriesScreen (list + CRUD) | ✅ | 3 screens: list, detail (material count), form (create/edit) |
| 2.13 | MaterialsScreen (list with category filter, stock levels) | ✅ | Search bar, category filter chips, stock qty with low-stock color |
| 2.14 | MaterialDetailScreen (stock history, transactions) | ✅ | Stock by location, linked suppliers with prices |
| 2.15 | MaterialFormScreen (create/edit material) | ✅ | Category chip selector, SKU optional, min stock alert |
| 2.16 | SuppliersScreen (list + CRUD) | ✅ | Search, phone tap-to-call, material count badge |
| 2.17 | SupplierFormScreen (create/edit supplier) | ✅ | Name, phone, email, address, GST, notes |
| 2.18 | PurchaseOrdersScreen (list, status filter) | ✅ | Status filter chips (All/Expected/Partial/Received/Cancelled) |
| 2.19 | PurchaseOrderFormScreen (create PO, select supplier + items) | ✅ | Dynamic item list with material selector, qty, price |
| 2.20 | PurchaseOrderDetailScreen (receive items, status badges) | ✅ | Receive all / cancel buttons, expected vs received quantities |
| 2.21 | StockOverviewScreen (inventory home, quick-nav grid) | ✅ | 6 quick-nav buttons + stock levels with location filter |
| 2.22 | StockAdjustScreen (wastage/usage/adjustment/return) | ✅ | Type selector, material/location chip selectors, quantity |
| 2.23 | StockTransfersScreen + StockTransferFormScreen | ✅ | Transfer list with receive/cancel; form with from/to location |

### Phase 2 Testing (Backend API)

| # | Test | Status | Notes |
|---|------|--------|-------|
| T2.1 | Material category CRUD (API) | ✅ | 7 seed categories returned, create/list verified |
| T2.2 | Material CRUD with stock tracking | ✅ | Create material, auto-SKU generated, category enrichment |
| T2.3 | Supplier CRUD + material linking | ✅ | Create supplier, link material with default_price_per_unit |
| T2.4 | Purchase order create → receive flow | ✅ | PO-00001 created, 80/100 partial receive → status partially_received |
| T2.5 | Stock add/deduct/wastage transactions | ✅ | 5 wastage deducted (80→75), transaction recorded |
| T2.6 | Daily stock reconciliation endpoint | ✅ | POST/GET /stock/reconcile endpoints functional |
| T2.7 | Stock transfer between locations | ✅ | Shop→Warehouse 20 stems, receive confirmed (55+20=75 total) |
| T2.8 | Transaction history | ✅ | 4 transactions logged (purchase, wastage, transfer_out, transfer_in) |
| T2.9 | Expo app bundles without errors | ✅ | 1059 modules, no syntax errors |
| T2.10 | Full inventory flow end-to-end in app | ✅ | Manual testing complete |

### Phase 2 Bugs Fixed

| # | Bug | Fix |
|---|-----|-----|
| B2.1 | PO edit screen didn't pre-fill items | Fixed item pre-fill on PurchaseOrderFormScreen |
| B2.2 | PO receive + quality selection broken | Fixed receive flow and quality chip UI |
| B2.3 | Date picker crashes on web/iOS/Android | Platform-specific date handling |
| B2.4 | Unit selector not working on PO form | Fixed unit picker in PurchaseOrderFormScreen |
| B2.5 | Button overflow on smaller screens | Responsive action row layout |
| B2.6 | Supplier-material linking UI missing | Added link/unlink UI on SupplierDetailScreen and MaterialDetailScreen |
| B2.7 | Material stock transaction history not shown | Added transaction history section to MaterialDetailScreen |
| B2.8 | Supplier access control for managers ineffective | Backend field filtering by `supplier_manager_fields` setting + SettingsScreen toggles |
| B2.9 | MaterialDetailScreen syntax error (leftover styles) | Cleaned up orphaned style references |
| B2.10 | Default price not editable / not useful | Made default_price_per_unit optional, only display when > 0 |
| B2.11 | Unlink material/supplier not working on web | `Alert.alert` with buttons doesn't work on web — switched to `Platform.OS === 'web' ? window.confirm() : Alert.alert()` |
| B2.12 | Transfer receive button not working on web | Same `Alert.alert` web issue — applied cross-platform confirm to all 5 affected screens |
| B2.13 | Supplier fields visible to managers even when setting is off | Backend PUT endpoint now restricts which fields non-owners can update; SupplierFormScreen hides disallowed fields |
| B2.14 | Supplier page shows 0 materials for managers | Backend now returns `material_count` separately; frontend uses it instead of filtered materials array length |
| B2.15 | Order amounts visible to managers when pricing hidden | Backend strips `total_amount` and per-unit prices from PO list/detail for non-owners when 'pricing' not in allowed fields; frontend conditionally renders amounts |
| B2.16 | Any employee can receive POs/transfers at any location | Backend checks `user_locations` for employees — must be assigned to receiving location; frontend hides Receive button for unassigned employees |
| B2.17 | Partial receive adds full quantity again on each click | Changed `received_quantity = ?` to `received_quantity = received_quantity + ?`; added cap to prevent over-receiving; skips already-fully-received items |

---

## Phase 3 — Products & QR Codes

**Status**: ✅ Complete  
**Started**: 8 March 2026  
**Completed**: 8 March 2026

### Backend

| # | Task | Status | Notes |
|---|------|--------|-------|
| 3.1 | Database tables (products, product_materials, product_images) | ✅ | 3 tables, indexes, FK constraints, auto-SKU |
| 3.2 | Products routes (CRUD — standard/custom/made-to-order) | ✅ | List with type filter + search, detail with materials + images, auto-SKU (PRD-prefix), soft-delete |
| 3.3 | Product material usage routes (link/update/remove materials) | ✅ | POST/PUT/DELETE /products/:id/materials, unique constraint |
| 3.4 | Cost estimation logic (avg supplier price × qty) | ✅ | Auto-recalculates estimated_cost on material add/update/remove |
| 3.5 | QR code generation (base64 PNG data URL) | ✅ | GET /products/:id/qr, uses `qrcode` npm package, configurable size |
| 3.6 | QR scan lookup route | ✅ | POST /products/scan, validates bloomcart_product type, returns full product with materials |
| 3.7 | QR label — web print support | ✅ | Print via window.open on web; Share API on mobile |
| 3.8 | Product image upload | ✅ | POST/DELETE /products/:id/images, multer, auto-primary promotion, file cleanup on delete |

### Frontend

| # | Task | Status | Notes |
|---|------|--------|-------|
| 3.9 | API service — product methods | ✅ | 10 new methods: products CRUD, materials link/update/remove, image upload/delete, QR generate/scan |
| 3.10 | ProductsScreen (list with search, type filter) | ✅ | Type filter chips (All/Standard/Custom/Made to Order), search bar, cost + price display, FAB |
| 3.11 | ProductDetailScreen (details, materials, cost, QR) | ✅ | Pricing card (cost/price/margin%), materials list with add/remove modal, image gallery |
| 3.12 | ProductFormScreen (create/edit, type + tax rate selectors) | ✅ | Type chips, tax rate chips, SKU auto-gen, KeyboardAvoidingView |
| 3.13 | QRScannerScreen (camera-based scan → product detail) | ✅ | expo-camera barcode scanner, corner markers overlay, web fallback message |
| 3.14 | QRLabelScreen (print/share QR label) | ✅ | Label card preview, Share API, web download + print buttons |
| 3.15 | StockOverview quick links updated | ✅ | Added "Products" and "Scan QR" tiles (8 total quick links) |

### Packages Installed

| Package | Side | Purpose |
|---------|------|---------|
| `qrcode` | Server | QR code generation as base64 PNG |
| `expo-camera` | App | Camera-based QR code scanning |
| `react-native-svg` | App | SVG rendering support |

### Phase 3 Testing

| # | Test | Status | Notes |
|---|------|--------|-------|
| T3.1 | Product CRUD (API) | ✅ | Create with auto-SKU (PRD-REDROSBOU-001), list, detail, soft-delete all verified |
| T3.2 | Bill of materials — add/remove materials | ✅ | Link/unlink materials, estimated_cost recalculated |
| T3.3 | Cost estimation (avg supplier price × qty) | ✅ | Recalculation on material add/update/remove |
| T3.4 | QR code generate → scan → displays product | ✅ | GET /qr returns base64 PNG; POST /scan returns full product |
| T3.5 | QR label share/print (web) | ✅ | Share API + web print/download |
| T3.6 | Product image upload + display | ✅ | Multer upload, auto-primary, delete with file cleanup |
| T3.7 | Server starts without errors | ✅ | All routes loaded, 19 tables created |
| T3.8 | No lint/compile errors in all new files | ✅ | 0 errors across 7 files (5 screens + route + api) |

---

## Phase 4 — POS & Sales

**Status**: ✅ Complete  
**Completed**: 8 March 2026

### Backend

| # | Task | Status | Notes |
|---|------|--------|-------|
| 4.1 | Database tables (sales, sale_items, payments, refunds, cash_registers, pre_orders) | ✅ | 6 tables with indexes, FKs, constraints |
| 4.2 | Sales CRUD routes (create sale with items/payments in transaction) | ✅ | Auto-generates sale_number INV-LOCCODE-DATE-SEQ |
| 4.3 | Tax calculation logic (per-product tax rates via tax_rate_id) | ✅ | Tax computed per item at sale time |
| 4.4 | Discount system (fixed amount or percentage) | ✅ | Applied at checkout, reflected in grand total |
| 4.5 | Split payment processing (cash + card + UPI) | ✅ | Multiple payments per sale, payment_status auto-updated |
| 4.6 | Order type support (walk_in, pickup, delivery, pre_order) | ✅ | Stored in sales.order_type |
| 4.7 | Pre-order with advance payment | ✅ | pre_orders table, scheduled_date/time, advance/remaining |
| 4.8 | Refund routes | ✅ | Full/partial refund with reason, method, cash register update |
| 4.9 | Cash register routes (open, close, reconcile, history) | ✅ | Auto-recalculates expected cash on close |
| 4.10 | Today sales summary route | ✅ | Revenue, tax, discounts, order type counts, payment breakdown |

### Frontend

| # | Task | Status | Notes |
|---|------|--------|-------|
| 4.11 | API service — POS methods (11 methods) | ✅ | getSales, createSale, refundSale, register endpoints, etc. |
| 4.12 | POS tab + Sales tab in MainNavigator | ✅ | POS for owner/manager/employee, Sales for owner/manager |
| 4.13 | POSScreen (product list, search, QR scan, cart bar) | ✅ | Location selector, add-to-cart, qty +/-, running totals |
| 4.14 | CheckoutScreen (order type, customer, discount, payment) | ✅ | Pre-order fields, delivery address, payment ref |
| 4.15 | SaleDetailScreen (receipt view, items, payments, refund) | ✅ | Status badges, cancel/refund actions, balance due |
| 4.16 | SalesScreen (list with filters, today summary bar) | ✅ | Filter by order type, search, pagination |
| 4.17 | CashRegisterScreen (open/close, status, history) | ✅ | Location-aware, discrepancy calculation |
| 4.18 | RefundSaleScreen (amount, reason, method) | ✅ | Confirmation dialog, amount validation |

### Phase 4 Testing

| # | Test | Status | Notes |
|---|------|--------|-------|
| T4.1 | Add products to cart via list and QR scan | ✅ | Manual testing passed |
| T4.2 | Tax calculation correctness (GST rates) | ✅ | Manual testing passed |
| T4.3 | Discount apply (fixed + percentage) | ✅ | Manual testing passed |
| T4.4 | Split payment (cash + card + UPI combo) | ✅ | Manual testing passed |
| T4.5 | Walk-in / pickup / delivery order types | ✅ | Manual testing passed |
| T4.6 | Pre-order with advance payment | ✅ | Manual testing passed |
| T4.7 | Sale detail / receipt view | ✅ | Manual testing passed |
| T4.8 | Cash register open → sales → close → reconcile | ✅ | Manual testing passed |
| T4.9 | Role-based POS access (owner/manager/employee) | ✅ | Manual testing passed |
| T4.10 | Full POS sale end-to-end in app | ✅ | Manual testing passed |

### Post-Phase-4 Enhancements & Fixes

| # | Enhancement | Status | Notes |
|---|-------------|--------|-------|
| 4E.1 | Product stock editing — two-mode (Set Product Qty / Adjust Material) | ✅ | ProductStockScreen updated |
| 4E.2 | Quick-add modal fix (KeyboardAvoidingView + BOM material linking) | ✅ | POSScreen modal rebuilt |
| 4E.3 | Centralized material selling price (column + auto-recalculate product cost) | ✅ | Migration, routes, MaterialFormScreen field, MaterialDetailScreen display |
| 4E.4 | Expense tracking system (DB table, routes, ExpensesScreen) | ✅ | Full CRUD, cash register deduction |
| 4E.5 | Best-sellers pinned at top with Popular badge | ✅ | POSScreen sort by order count |
| 4E.6 | Customer phone auto-fill + returning customer hint | ✅ | CheckoutScreen lookup from sales history |
| 4E.7 | Category filter chips on POS | ✅ | Horizontal scroll filter in products tab |
| 4E.8 | Custom price override in cart | ✅ | Inline editable price field per cart item |
| 4E.9 | Cash change due calculator | ✅ | Real-time display on CheckoutScreen |
| 4E.10 | Cash register reopen after close | ✅ | Server clears closing data on reopen |

---

## Phase 5 — Customer Management

**Status**: ✅ Complete  
**Started**: 8 March 2026  
**Completed**: 8 March 2026

### Backend

| # | Task | Status | Notes |
|---|------|--------|-------|
| 5.1 | Database tables (customer_addresses, credit_payments, special_dates) | ✅ | + user columns: birthday, anniversary, custom_dates, total_spent, credit_balance, notes |
| 5.2 | Customer routes (CRUD, phone-based lookup, search) | ✅ | server/routes/customers.js ~350 lines |
| 5.3 | Customer address routes (multiple per customer) | ✅ | Add, update, delete with default flag |
| 5.4 | Credit/dues tracking routes | ✅ | Record payments, auto-update balance |
| 5.5 | Special dates storage & upcoming dates API | ✅ | Custom dates + birthday/anniversary from user |
| 5.6 | Customer order history route | ✅ | Returns sales linked by customer_id |
| 5.7 | Sales integration — auto-update total_spent & credit_balance | ✅ | In createSale transaction |

### Frontend

| # | Task | Status | Notes |
|---|------|--------|-------|
| 5.8 | API service — 15 customer methods | ✅ | getCustomers, lookup, CRUD, addresses, credits, special dates |
| 5.9 | CustomersScreen (list, search, stats badges) | ✅ | Avatar, orders/spent/due badges, FAB |
| 5.10 | CustomerDetailScreen (profile, addresses, history, dues, special dates) | ✅ | 3 modals: credit payment, special date, address |
| 5.11 | CustomerFormScreen (create/edit) | ✅ | Name, phone, email, birthday, anniversary, notes |
| 5.12 | Address management (inline in CustomerDetailScreen) | ✅ | Modal with label, address lines, city, pincode |
| 5.13 | Credit/dues management (inline in CustomerDetailScreen) | ✅ | Record payment modal, payment history list |
| 5.14 | Special dates management (inline in CustomerDetailScreen) | ✅ | Add/delete custom dates, birthday & anniversary display |
| 5.15 | Customers tab in MainNavigator (owner/manager) | ✅ | CustomersStack with list, detail, form, sale detail |
| 5.16 | CheckoutScreen customer_id integration | ✅ | Enhanced lookup links registered customers |

### Phase 5 Testing

| # | Test | Status | Notes |
|---|------|--------|-------|
| T5.1 | Customer CRUD + phone-based lookup | ✅ | API verified: create, list, lookup all working |
| T5.2 | Multiple addresses per customer | ⬜ | |
| T5.3 | Credit/dues tracking (add credit, payment, balance) | ⬜ | |
| T5.4 | Special dates (add, delete, upcoming) | ⬜ | |
| T5.5 | Customer order history display | ⬜ | |
| T5.6 | Checkout customer_id flow | ⬜ | |
| T5.7 | Full customer management end-to-end in app | ⬜ | |

---

## Post-Phase 5 — Bug Fixes & Production Queue

**Status**: ✅ Complete  
**Completed**: 8 March 2026

### Bug Fixes

| # | Bug | Status | Fix |
|---|-----|--------|-----|
| BF-1 | QR scan adds all stock to cart | ✅ Investigated | Code correct — `addToCart` always sets quantity:1. No code bug. |
| BF-2 | Cash register not reopenable after close | 🐛 Fixed | CashRegisterScreen.js — condition `(!register \|\| register.closed_at === null)` was false when closed. Simplified to `!isOpen`. |
| BF-3 | Delivery address not showing for orders | 🐛 Fixed | SaleDetailScreen.js — addressed only showed for pre_orders. Added display section for regular delivery orders. |
| BF-4 | Customers appearing on Staff page | 🐛 Fixed | server/routes/users.js — excluded customer role from default query. Removed customer filter chip from UsersScreen. |
| BF-5 | Product stock adjustment flow broken | 🐛 Fixed | ProductStockScreen.js — redesigned adjust modal with reason selector (Correction/Wastage/Return/Usage). Material deductions now use selected reason type. |
| BF-6 | Inventory deduction timing wrong | 🐛 Fixed | See Production Queue feature below. |

### Production Queue Feature (from Bug BF-6)

| # | Task | Status | Notes |
|---|------|--------|-------|
| PQ-1 | DB migration: `stock_deducted` column on sales | ✅ | Tracks whether materials have been deducted |
| PQ-2 | Order lifecycle: pending → preparing → ready → completed | ✅ | Walk-in = immediate complete + deduct. Others = pending, no deduction. |
| PQ-3 | Stock deducted at 'preparing' stage (not at sale creation) | ✅ | Materials consumed when staff starts preparing |
| PQ-4 | Cancel route restores stock if deducted | ✅ | Reverses BOM deductions, logs 'return' transactions |
| PQ-5 | PUT /sales/:id/status — lifecycle transitions | ✅ | Validates allowed transitions, deducts stock at preparing |
| PQ-6 | GET /sales/production-queue — pending/preparing/ready orders | ✅ | Sorted by status priority, enriched with items |
| PQ-7 | API methods: `updateOrderStatus`, `getProductionQueue` | ✅ | Added to api.js |
| PQ-8 | ProductionQueueScreen.js — staff-facing order queue | ✅ | Location filter, status tabs, order cards, action buttons |
| PQ-9 | SaleDetailScreen — status transition buttons | ✅ | Start Preparing / Mark Ready / Complete Order buttons per status |
| PQ-10 | SalesScreen + POSScreen — Queue access buttons | ✅ | Header "Queue" button on both screens |
| PQ-11 | Status colors for new statuses (pending/preparing/ready) | ✅ | Added to SaleDetailScreen + SalesScreen STATUS_COLORS |

---

## Phase 6 — Production & Hybrid Stock System

**Status**: ✅ Complete  
**Completed**: 9 March 2026

### Overview

Redesigned the product/stock system from pure BOM-based calculation to a **hybrid model**:
- Products now have real inventory (`product_stock` table) tracking ready-made items per location
- Materials still tracked separately — BOM is a recipe, not auto-consumed on product creation
- Employee production tracking (who made what, when, how many) for incentive purposes
- Production task system with manager assignment and employee self-pick
- POS restructured: order type selected first (walk-in/pickup/delivery/pre-order)

### Database Changes

| # | Task | Status | Notes |
|---|------|--------|-------|
| 6.1 | `product_stock` table (product_id, location_id, quantity) | ✅ | Real finished product inventory per location |
| 6.2 | `production_logs` table (who produced what, when) | ✅ | Employee production tracking for incentives |
| 6.3 | `production_tasks` table (per-item tasks from orders) | ✅ | Status: pending/assigned/in_progress/completed/cancelled |
| 6.4 | `sale_items` columns: materials_deducted, from_product_stock | ✅ | Per-item tracking of what was deducted |
| 6.5 | Fixed product creation material deduction bug | 🐛 | BOM is now recipe-only, no stock consumed on product creation |

### Backend Routes

| # | Task | Status | Notes |
|---|------|--------|-------|
| 6.6 | POST /production/produce — make products for display | ✅ | Validates BOM, checks material stock, deducts materials, adds to product_stock |
| 6.7 | GET /production/product-stock — ready inventory | ✅ | Finished product counts per location |
| 6.8 | POST /production/product-stock/adjust — manual correction | ✅ | Wastage, correction, damage, count adjustments |
| 6.9 | GET /production/tasks — task queue with filters | ✅ | Full joins, priority sorting, location scoping |
| 6.10 | GET /production/my-tasks — employee's own tasks | ✅ | Assigned + in_progress tasks |
| 6.11 | PUT /production/tasks/:id/assign — manager assigns | ✅ | With reassignment support |
| 6.12 | PUT /production/tasks/:id/pick — employee self-picks | ✅ | Sets both assigned_to and picked_by |
| 6.13 | PUT /production/tasks/:id/start — begin working | ✅ | Updates sale status to 'preparing' |
| 6.14 | PUT /production/tasks/:id/complete — finish task | ✅ | Deducts materials via BOM, logs production, checks all tasks done → sale 'ready' |
| 6.15 | GET /production/stats — production statistics | ✅ | Per-employee totals, per-product breakdown |
| 6.16 | GET /production/material-alerts — shortage warnings | ✅ | Compares pending order needs vs current stock |
| 6.17 | GET /production/logs — production history | ✅ | Filterable by date, employee, product |
| 6.18 | Rewrite createSale with hybrid logic | ✅ | Walk-in: deduct from product_stock if available, else create urgent tasks |
| 6.19 | Update cancel route — product_stock handling | ✅ | Cancel after prep → add to product_stock (can't restore materials) |
| 6.20 | Update product routes — ready_qty in responses | ✅ | GET /products returns ready_qty from product_stock |

### Frontend Screens

| # | Task | Status | Notes |
|---|------|--------|-------|
| 6.21 | POSScreen — order type selector | ✅ | Walk-in/Pickup/Delivery/Pre-order selected first |
| 6.22 | POSScreen — ready_qty badges on products | ✅ | Green "X ready" badge, "Can make X" text |
| 6.23 | POSScreen — Make & Queue header buttons | ✅ | Navigate to ProduceScreen and ProductionQueueScreen |
| 6.24 | ProduceScreen — make products for display | ✅ | Location selector, product list, qty controls, material check |
| 6.25 | ProductionQueueScreen — Tasks view (enhanced) | ✅ | Task cards with urgency, assignment, pick/start/complete actions |
| 6.26 | ProductionQueueScreen — Orders view (legacy) | ✅ | Retained order-level queue alongside task view |
| 6.27 | ProductionQueueScreen — Assign modal | ✅ | Manager picks employee from staff list, reassignment support |
| 6.28 | DashboardScreen — Your Tasks section | ✅ | Shows pending/assigned/in_progress tasks for logged-in staff |
| 6.29 | DashboardScreen — Your Production stats | ✅ | Items made + unique products count |
| 6.30 | ProductStockScreen — ready_qty display | ✅ | Shows ready count + can-make count per product |
| 6.31 | ProductStockScreen — product stock adjustment | ✅ | Uses adjustProductStock API for direct product inventory changes |
| 6.32 | CheckoutScreen — receives orderType | ✅ | From POSScreen route params |
| 6.33 | Navigator — ProduceScreen in POS + Sales stacks | ✅ | Accessible from POS and Sales tabs |
| 6.34 | API service — 12 new production methods | ✅ | produce, tasks, assign, pick, start, complete, stats, alerts, logs |

### Key Design Decisions

- **Walk-in + all products in stock** → sale completed immediately, product_stock deducted
- **Walk-in + out of stock** → sale allowed, urgent production tasks created
- **Pickup/Delivery/Pre-order** → production tasks created, materials deducted when task completed
- **Cancel after preparation** → finished products added to product_stock (materials can't be restored)
- **Both self-pick AND manager assignment** → with reassignment support
- **Production stats per employee** → total produced, unique products (for incentives)

---

## Phase 7 — Orders & Delivery

**Status**: ⬜ Not Started

### Backend

| # | Task | Status | Notes |
|---|------|--------|-------|
| 7.1 | Database tables (deliveries, delivery_proofs, recurring_orders) | ⬜ | |
| 7.2 | Order lifecycle routes (status transitions) | ⬜ | |
| 7.3 | Delivery assignment routes | ⬜ | |
| 7.4 | Delivery status update routes (with GPS + photo proof) | ⬜ | |
| 7.5 | Delivery challan generation (shop + customer copies) | ⬜ | |
| 7.6 | Delivery charges configuration | ⬜ | |
| 7.7 | Recurring orders system | ⬜ | |
| 7.8 | Order pickup flow (preferred time) | ⬜ | |

### Frontend

| # | Task | Status | Notes |
|---|------|--------|-------|
| 7.9 | API service — order & delivery methods | ⬜ | |
| 7.10 | OrdersScreen (list with status tabs) | ⬜ | |
| 7.11 | OrderDetailScreen (items, status, delivery info) | ⬜ | |
| 7.12 | DeliveryAssignScreen (assign delivery partner) | ⬜ | |
| 7.13 | DeliveryPartnerScreen (assigned deliveries, navigation, mark delivered) | ⬜ | |
| 7.14 | DeliveryProofScreen (photo capture + GPS) | ⬜ | |
| 7.15 | DeliveryChallanScreen (view + print) | ⬜ | |
| 7.16 | RecurringOrderScreen (setup + manage) | ⬜ | |
| 7.17 | Customer order tracking screens | ⬜ | |

### Phase 7 Testing

| # | Test | Status | Notes |
|---|------|--------|-------|
| T7.1 | Order status transitions (full lifecycle) | ⬜ | |
| T7.2 | Delivery assignment by manager | ⬜ | |
| T7.3 | Delivery partner marks delivered with photo + GPS | ⬜ | |
| T7.4 | Delivery challan PDF generation | ⬜ | |
| T7.5 | Recurring order auto-creation | ⬜ | |
| T7.6 | Pickup order with preferred time | ⬜ | |
| T6.7 | Customer order tracking view | ⬜ | |
| T6.8 | Full order → delivery end-to-end in app | ⬜ | |

---

## Phase 7 — Attendance & Location Tracking

**Status**: ⬜ Not Started

### Backend

| # | Task | Status | Notes |
|---|------|--------|-------|
| 7.1 | Database tables (attendance, outdoor_duty_requests) | ⬜ | |
| 7.2 | Geofence-based clock-in/out routes | ⬜ | |
| 7.3 | Outdoor duty request/approval routes | ⬜ | |
| 7.4 | Late/early flag calculation logic | ⬜ | |
| 7.5 | Attendance report routes (daily, weekly, monthly) | ⬜ | |
| 7.6 | Delivery partner live location tracking routes | ⬜ | |

### Frontend

| # | Task | Status | Notes |
|---|------|--------|-------|
| 7.7 | API service — attendance methods | ⬜ | |
| 7.8 | AttendanceScreen (clock-in/out, status) | ⬜ | |
| 7.9 | OutdoorDutyRequestScreen (request + approval) | ⬜ | |
| 7.10 | AttendanceReportScreen (daily/weekly/monthly view) | ⬜ | |
| 7.11 | LiveDeliveryMapScreen (manager/owner — all partners) | ⬜ | |
| 7.12 | Geofence config per location (settings) | ⬜ | |

### Phase 7 Testing

| # | Test | Status | Notes |
|---|------|--------|-------|
| T7.1 | Geofence clock-in inside radius | ⬜ | |
| T7.2 | Geofence block outside radius | ⬜ | |
| T7.3 | Outdoor duty request → approval flow | ⬜ | |
| T7.4 | Late/early flags calculated correctly | ⬜ | |
| T7.5 | Attendance reports accuracy | ⬜ | |
| T7.6 | Delivery partner live location on map | ⬜ | |
| T7.7 | Full attendance flow end-to-end in app | ⬜ | |

---

## Phase 8 — Reports & Dashboard

**Status**: ⬜ Not Started

### Backend

| # | Task | Status | Notes |
|---|------|--------|-------|
| 8.1 | Daily sales summary routes (by location, date range) | ⬜ | |
| 8.2 | Inventory status & wastage report routes | ⬜ | |
| 8.3 | Customer insights routes (top customers, order frequency) | ⬜ | |
| 8.4 | Employee performance report routes | ⬜ | |
| 8.5 | Delivery metrics routes | ⬜ | Nice-to-have |
| 8.6 | Profit margin analysis routes | ⬜ | Nice-to-have |

### Frontend

| # | Task | Status | Notes |
|---|------|--------|-------|
| 8.7 | API service — report methods | ⬜ | |
| 8.8 | Enhanced DashboardScreen (live sales stats, charts) | ⬜ | |
| 8.9 | SalesReportScreen (date range, location filter, export) | ⬜ | |
| 8.10 | InventoryReportScreen (stock levels, wastage trends) | ⬜ | |
| 8.11 | CustomerInsightsScreen (top customers, frequency) | ⬜ | |
| 8.12 | EmployeePerformanceScreen | ⬜ | |
| 8.13 | Chart components (bar, line, pie) | ⬜ | |

### Phase 8 Testing

| # | Test | Status | Notes |
|---|------|--------|-------|
| T8.1 | Sales summary accuracy vs actual orders | ⬜ | |
| T8.2 | Inventory report matches stock records | ⬜ | |
| T8.3 | Customer insights data correctness | ⬜ | |
| T8.4 | Date range filtering on all reports | ⬜ | |
| T8.5 | Location-scoped reports (manager view) | ⬜ | |
| T8.6 | Full reports dashboard end-to-end in app | ⬜ | |

---

## Phase 9 — Notifications & Polish

**Status**: ⬜ Not Started

### Backend

| # | Task | Status | Notes |
|---|------|--------|-------|
| 9.1 | Push notification infrastructure (Expo push) | ⬜ | |
| 9.2 | Notification trigger system (order status, low stock, attendance, etc.) | ⬜ | |
| 9.3 | In-app notification routes (list, mark read) | ⬜ | |

### Frontend

| # | Task | Status | Notes |
|---|------|--------|-------|
| 9.4 | Push notification registration + handling | ⬜ | |
| 9.5 | NotificationCenterScreen (list, mark read, navigate) | ⬜ | |
| 9.6 | Notification badge on tab bar | ⬜ | |

### Future / Nice-to-Have

| # | Task | Status | Notes |
|---|------|--------|-------|
| 9.7 | WhatsApp receipt sharing | ⬜ | Later phase |
| 9.8 | Thermal printer integration (SEZNIK 58mm, ESC/POS, Bluetooth) | ⬜ | Later phase |
| 9.9 | Offline support (local-first with sync) | ⬜ | Later phase |
| 9.10 | Loyalty/rewards program | ⬜ | Later phase |

### Phase 9 Testing

| # | Test | Status | Notes |
|---|------|--------|-------|
| T9.1 | Push notification delivery (all trigger types) | ⬜ | |
| T9.2 | In-app notification list + mark read | ⬜ | |
| T9.3 | Notification badge updates in real-time | ⬜ | |
| T9.4 | Full notification flow end-to-end in app | ⬜ | |

---

## Overall Progress

| Phase | Description | Status | Tasks | Completed | Bugs Fixed |
|-------|-------------|--------|-------|-----------|------------|
| 1 | Foundation (Auth, Roles, Locations) | ✅ Complete | 26 | 26 | 8 |
| 2 | Inventory & Raw Materials | ✅ Complete | 23 | 23 | 0 |
| 3 | Products & QR Codes | ✅ Complete | 15 | 15 | 0 |
| 4 | POS & Sales | ✅ Complete | 19 | 19 | 0 |
| 5 | Customer Management | ✅ Complete | 15 | 15 | 0 |
| 6 | Production & Hybrid Stock | ✅ Complete | 34 | 34 | 1 |
| 7 | Orders & Delivery | ⬜ Not Started | 17 | 0 | 0 |
| 8 | Attendance & Location Tracking | ⬜ Not Started | 12 | 0 | 0 |
| 9 | Reports & Dashboard | ⬜ Not Started | 13 | 0 | 0 |
| 10 | Notifications & Polish | ⬜ Not Started | 10 | 0 | 0 |
| **Total** | | | **184** | **132** | **9** |

---

## Technical Notes

- **Server**: Express.js on port 3001, SQLite (better-sqlite3), JWT auth
- **App**: React Native Expo ~54.0.0, React 19.1.0
- **LAN IP**: 192.168.29.160
- **App Name**: BloomCart POS (com.bloomcart.pos)
- **Theme**: Rose pink (#E91E63) primary, green (#4CAF50) secondary
- **Auth**: Phone-based (Indian 10-digit mobile, regex: `/^[6-9]\d{9}$/`)
- **Roles**: owner, manager, employee, delivery_partner, customer
