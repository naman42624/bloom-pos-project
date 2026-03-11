-- ============================================================
-- BloomCart POS — PostgreSQL Production Schema
-- ============================================================
-- Migration from SQLite to PostgreSQL
-- Run this against a fresh PostgreSQL database
-- ============================================================

-- ─── Custom Types (ENUMs) ─────────────────────────────────
CREATE TYPE user_role AS ENUM ('owner', 'manager', 'employee', 'delivery_partner', 'customer');
CREATE TYPE location_type AS ENUM ('shop', 'warehouse');
CREATE TYPE storage_type AS ENUM ('shop', 'warehouse');
CREATE TYPE po_status AS ENUM ('expected', 'partially_received', 'received', 'cancelled');
CREATE TYPE received_quality AS ENUM ('good', 'average', 'poor');
CREATE TYPE transaction_type AS ENUM ('purchase', 'usage', 'wastage', 'transfer_in', 'transfer_out', 'adjustment', 'return');
CREATE TYPE transfer_status AS ENUM ('initiated', 'in_transit', 'received', 'cancelled');
CREATE TYPE product_type AS ENUM ('standard', 'custom', 'made_to_order');
CREATE TYPE product_category AS ENUM ('bouquet', 'arrangement', 'basket', 'single_stem', 'gift_combo', 'other');
CREATE TYPE discount_type AS ENUM ('fixed', 'percentage');
CREATE TYPE payment_status AS ENUM ('paid', 'partial', 'pending', 'refunded');
CREATE TYPE order_type AS ENUM ('walk_in', 'pickup', 'delivery', 'pre_order');
CREATE TYPE order_status AS ENUM ('draft', 'pending', 'preparing', 'ready', 'completed', 'cancelled');
CREATE TYPE payment_method AS ENUM ('cash', 'card', 'upi');
CREATE TYPE refund_status AS ENUM ('requested', 'approved', 'rejected', 'processed');
CREATE TYPE refund_method AS ENUM ('cash', 'card', 'upi', 'store_credit');
CREATE TYPE expense_category AS ENUM ('supplies', 'petty_cash', 'maintenance', 'transport', 'food', 'utilities', 'salary', 'other');
CREATE TYPE delivery_status AS ENUM ('pending', 'assigned', 'picked_up', 'in_transit', 'delivered', 'failed', 'cancelled');
CREATE TYPE cod_status AS ENUM ('none', 'pending', 'partial', 'collected', 'settled');
CREATE TYPE clock_method AS ENUM ('auto_geofence', 'manual', 'auto_timeout');
CREATE TYPE attendance_status AS ENUM ('present', 'absent', 'half_day', 'on_leave');
CREATE TYPE duty_status AS ENUM ('requested', 'approved', 'rejected', 'completed');
CREATE TYPE task_status AS ENUM ('pending', 'assigned', 'in_progress', 'completed', 'cancelled');
CREATE TYPE task_priority AS ENUM ('normal', 'urgent');
CREATE TYPE frequency_type AS ENUM ('daily', 'weekly', 'monthly', 'custom');
CREATE TYPE settlement_status AS ENUM ('pending', 'verified');
CREATE TYPE advance_status AS ENUM ('pending', 'approved', 'rejected', 'repaid');
CREATE TYPE salary_type AS ENUM ('monthly', 'daily', 'hourly');
CREATE TYPE salary_payment_status AS ENUM ('pending', 'paid', 'cancelled');
CREATE TYPE salary_payment_method AS ENUM ('cash', 'upi', 'bank_transfer');
CREATE TYPE geofence_event_type AS ENUM ('enter', 'exit');
CREATE TYPE pickup_status AS ENUM ('waiting', 'ready_for_pickup', 'picked_up');
CREATE TYPE cod_collection_method AS ENUM ('cash', 'upi');

-- ─── Users & Auth ─────────────────────────────────────────
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  phone VARCHAR(20) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE,
  password VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  role user_role NOT NULL DEFAULT 'customer',
  avatar TEXT,
  bio TEXT DEFAULT '',
  is_active BOOLEAN DEFAULT TRUE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  birthday DATE,
  anniversary DATE,
  custom_dates JSONB DEFAULT '[]',
  total_spent DECIMAL(12,2) DEFAULT 0,
  credit_balance DECIMAL(12,2) DEFAULT 0,
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_users_phone ON users(phone);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role ON users(role);

-- ─── Locations ─────────────────────────────────────────────
CREATE TABLE locations (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  type location_type NOT NULL DEFAULT 'shop',
  address TEXT,
  city VARCHAR(100),
  state VARCHAR(100),
  pincode VARCHAR(10),
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  geofence_radius INTEGER DEFAULT 50,
  phone VARCHAR(20),
  email VARCHAR(255),
  gst_number VARCHAR(20),
  operating_hours JSONB,
  is_active BOOLEAN DEFAULT TRUE,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── User-Location Assignments ────────────────────────────
CREATE TABLE user_locations (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  is_primary BOOLEAN DEFAULT FALSE,
  assigned_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, location_id)
);

CREATE INDEX idx_user_locations_user ON user_locations(user_id);
CREATE INDEX idx_user_locations_location ON user_locations(location_id);

-- ─── Settings ──────────────────────────────────────────────
CREATE TABLE settings (
  id SERIAL PRIMARY KEY,
  key VARCHAR(100) UNIQUE NOT NULL,
  value TEXT NOT NULL,
  description TEXT DEFAULT '',
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Notifications ─────────────────────────────────────────
CREATE TABLE notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  type VARCHAR(50) NOT NULL DEFAULT 'general',
  data JSONB DEFAULT '{}',
  is_read BOOLEAN DEFAULT FALSE,
  push_sent BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_notifications_user ON notifications(user_id);
CREATE INDEX idx_notifications_unread ON notifications(user_id, is_read) WHERE is_read = FALSE;

-- ─── Push Tokens ───────────────────────────────────────────
CREATE TABLE push_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  platform VARCHAR(20) DEFAULT 'expo',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, token)
);

CREATE INDEX idx_push_tokens_user ON push_tokens(user_id);

-- ─── Tax Rates ─────────────────────────────────────────────
CREATE TABLE tax_rates (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  percentage DECIMAL(5,2) NOT NULL,
  is_default BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,
  effective_from TIMESTAMPTZ DEFAULT NOW(),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Material Categories ──────────────────────────────────
CREATE TABLE material_categories (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  unit VARCHAR(50) NOT NULL DEFAULT 'pieces',
  has_bundle BOOLEAN DEFAULT FALSE,
  default_bundle_size INTEGER DEFAULT 1,
  is_perishable BOOLEAN DEFAULT FALSE,
  default_storage storage_type DEFAULT 'shop',
  is_active BOOLEAN DEFAULT TRUE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Materials ─────────────────────────────────────────────
CREATE TABLE materials (
  id SERIAL PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES material_categories(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  sku VARCHAR(50) UNIQUE,
  bundle_size_override INTEGER,
  image_url TEXT,
  min_stock_alert INTEGER DEFAULT 10,
  selling_price DECIMAL(10,2) DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_materials_category ON materials(category_id);
CREATE INDEX idx_materials_sku ON materials(sku);

-- ─── Material Stock ────────────────────────────────────────
CREATE TABLE material_stock (
  id SERIAL PRIMARY KEY,
  material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  quantity DECIMAL(10,2) DEFAULT 0,
  last_counted_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(material_id, location_id)
);

CREATE INDEX idx_material_stock_material ON material_stock(material_id);
CREATE INDEX idx_material_stock_location ON material_stock(location_id);

-- ─── Suppliers ─────────────────────────────────────────────
CREATE TABLE suppliers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(20),
  email VARCHAR(255),
  address TEXT,
  gst_number VARCHAR(20),
  notes TEXT DEFAULT '',
  is_active BOOLEAN DEFAULT TRUE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Supplier Materials ────────────────────────────────────
CREATE TABLE supplier_materials (
  id SERIAL PRIMARY KEY,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  default_price_per_unit DECIMAL(10,2) DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(supplier_id, material_id)
);

-- ─── Purchase Orders ──────────────────────────────────────
CREATE TABLE purchase_orders (
  id SERIAL PRIMARY KEY,
  po_number VARCHAR(50) UNIQUE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  expected_date DATE,
  expected_time VARCHAR(10),
  status po_status DEFAULT 'expected',
  notes TEXT DEFAULT '',
  total_amount DECIMAL(12,2) DEFAULT 0,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_po_supplier ON purchase_orders(supplier_id);
CREATE INDEX idx_po_location ON purchase_orders(location_id);
CREATE INDEX idx_po_status ON purchase_orders(status);

-- ─── Purchase Order Items ─────────────────────────────────
CREATE TABLE purchase_order_items (
  id SERIAL PRIMARY KEY,
  purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  expected_quantity DECIMAL(10,2) NOT NULL,
  expected_unit VARCHAR(50) DEFAULT 'pieces',
  expected_price_per_unit DECIMAL(10,2) DEFAULT 0,
  received_quantity DECIMAL(10,2) DEFAULT 0,
  received_quality received_quality,
  actual_price_per_unit DECIMAL(10,2) DEFAULT 0,
  received_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  received_at TIMESTAMPTZ
);

CREATE INDEX idx_poi_po ON purchase_order_items(purchase_order_id);

-- ─── Material Transactions (Ledger) ───────────────────────
CREATE TABLE material_transactions (
  id SERIAL PRIMARY KEY,
  material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  type transaction_type NOT NULL,
  quantity DECIMAL(10,2) NOT NULL,
  unit VARCHAR(50) DEFAULT 'pieces',
  reference_type VARCHAR(50),
  reference_id INTEGER,
  notes TEXT DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_mt_material ON material_transactions(material_id);
CREATE INDEX idx_mt_location ON material_transactions(location_id);
CREATE INDEX idx_mt_type ON material_transactions(type);
CREATE INDEX idx_mt_created ON material_transactions(created_at);

-- ─── Daily Stock Logs ──────────────────────────────────────
CREATE TABLE daily_stock_logs (
  id SERIAL PRIMARY KEY,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  opening_stock DECIMAL(10,2) DEFAULT 0,
  received_stock DECIMAL(10,2) DEFAULT 0,
  used_in_products DECIMAL(10,2) DEFAULT 0,
  closing_stock DECIMAL(10,2) DEFAULT 0,
  wastage DECIMAL(10,2) DEFAULT 0,
  wastage_reason TEXT DEFAULT '',
  counted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  verified_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(location_id, material_id, date)
);

CREATE INDEX idx_dsl_location_date ON daily_stock_logs(location_id, date);

-- ─── Stock Transfers ───────────────────────────────────────
CREATE TABLE stock_transfers (
  id SERIAL PRIMARY KEY,
  from_location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  to_location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  quantity DECIMAL(10,2) NOT NULL,
  unit VARCHAR(50) DEFAULT 'pieces',
  status transfer_status DEFAULT 'initiated',
  initiated_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  received_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_st_from ON stock_transfers(from_location_id);
CREATE INDEX idx_st_to ON stock_transfers(to_location_id);
CREATE INDEX idx_st_status ON stock_transfers(status);

-- ─── Products ──────────────────────────────────────────────
CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  sku VARCHAR(50) UNIQUE,
  description TEXT DEFAULT '',
  type product_type DEFAULT 'standard',
  category product_category,
  selling_price DECIMAL(10,2) DEFAULT 0,
  estimated_cost DECIMAL(10,2) DEFAULT 0,
  tax_rate_id INTEGER REFERENCES tax_rates(id) ON DELETE SET NULL,
  location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  image_url TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_products_sku ON products(sku);
CREATE INDEX idx_products_type ON products(type);
CREATE INDEX idx_products_category ON products(category);
CREATE INDEX idx_products_active ON products(is_active) WHERE is_active = TRUE;

-- ─── Product Materials (BOM) ──────────────────────────────
CREATE TABLE product_materials (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  quantity DECIMAL(10,2) NOT NULL DEFAULT 1,
  cost_per_unit DECIMAL(10,2) DEFAULT 0,
  notes TEXT DEFAULT '',
  UNIQUE(product_id, material_id)
);

CREATE INDEX idx_pm_product ON product_materials(product_id);
CREATE INDEX idx_pm_material ON product_materials(material_id);

-- ─── Product Images ────────────────────────────────────────
CREATE TABLE product_images (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  is_primary BOOLEAN DEFAULT FALSE,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_pi_product ON product_images(product_id);

-- ─── Product Stock ─────────────────────────────────────────
CREATE TABLE product_stock (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL DEFAULT 0,
  min_stock_alert INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(product_id, location_id)
);

CREATE INDEX idx_product_stock_product ON product_stock(product_id);
CREATE INDEX idx_product_stock_location ON product_stock(location_id);

-- ─── Sales ──────────────────────────────────────────────────
CREATE TABLE sales (
  id SERIAL PRIMARY KEY,
  sale_number VARCHAR(50) UNIQUE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  customer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  customer_name VARCHAR(255),
  customer_phone VARCHAR(20),
  subtotal DECIMAL(12,2) DEFAULT 0,
  tax_total DECIMAL(12,2) DEFAULT 0,
  discount_amount DECIMAL(12,2) DEFAULT 0,
  discount_type discount_type,
  discount_percentage DECIMAL(5,2),
  discount_approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  delivery_charges DECIMAL(10,2) DEFAULT 0,
  delivery_address TEXT,
  scheduled_date DATE,
  scheduled_time VARCHAR(10),
  grand_total DECIMAL(12,2) DEFAULT 0,
  payment_status payment_status NOT NULL DEFAULT 'pending',
  order_type order_type NOT NULL DEFAULT 'walk_in',
  status order_status NOT NULL DEFAULT 'completed',
  special_instructions TEXT DEFAULT '',
  customer_notes TEXT DEFAULT '',
  stock_deducted BOOLEAN DEFAULT FALSE,
  pickup_status pickup_status,
  picked_up_at TIMESTAMPTZ,
  sender_message TEXT DEFAULT '',
  sender_name VARCHAR(255) DEFAULT '',
  sender_phone VARCHAR(20) DEFAULT '',
  source VARCHAR(50) DEFAULT 'manual',
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_sales_number ON sales(sale_number);
CREATE INDEX idx_sales_location ON sales(location_id);
CREATE INDEX idx_sales_customer ON sales(customer_id);
CREATE INDEX idx_sales_payment_status ON sales(payment_status);
CREATE INDEX idx_sales_order_type ON sales(order_type);
CREATE INDEX idx_sales_status ON sales(status);
CREATE INDEX idx_sales_created ON sales(created_at);
CREATE INDEX idx_sales_location_created ON sales(location_id, created_at);

-- ─── Sale Items ─────────────────────────────────────────────
CREATE TABLE sale_items (
  id SERIAL PRIMARY KEY,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  material_id INTEGER REFERENCES materials(id) ON DELETE CASCADE,
  product_name VARCHAR(255) NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price DECIMAL(10,2) NOT NULL,
  tax_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
  tax_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
  discount_amount DECIMAL(10,2) DEFAULT 0,
  line_total DECIMAL(12,2) NOT NULL,
  materials_deducted BOOLEAN DEFAULT FALSE,
  from_product_stock BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX idx_sale_items_product ON sale_items(product_id);

-- ─── Payments ───────────────────────────────────────────────
CREATE TABLE payments (
  id SERIAL PRIMARY KEY,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  method payment_method NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  reference_number VARCHAR(100),
  received_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_payments_sale ON payments(sale_id);
CREATE INDEX idx_payments_method ON payments(method);

-- ─── Refunds ────────────────────────────────────────────────
CREATE TABLE refunds (
  id SERIAL PRIMARY KEY,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  amount DECIMAL(12,2) NOT NULL,
  reason TEXT NOT NULL,
  status refund_status NOT NULL DEFAULT 'requested',
  requested_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  refund_method refund_method NOT NULL,
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_refunds_sale ON refunds(sale_id);
CREATE INDEX idx_refunds_status ON refunds(status);

-- ─── Cash Registers ────────────────────────────────────────
CREATE TABLE cash_registers (
  id SERIAL PRIMARY KEY,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  opened_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opening_balance DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_cash_sales DECIMAL(12,2) DEFAULT 0,
  total_card_sales DECIMAL(12,2) DEFAULT 0,
  total_upi_sales DECIMAL(12,2) DEFAULT 0,
  total_refunds_cash DECIMAL(12,2) DEFAULT 0,
  expected_cash DECIMAL(12,2) DEFAULT 0,
  actual_cash DECIMAL(12,2),
  discrepancy DECIMAL(12,2),
  closed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  closing_notes TEXT DEFAULT '',
  opened_at TIMESTAMPTZ DEFAULT NOW(),
  closed_at TIMESTAMPTZ
);

CREATE INDEX idx_cr_location_date ON cash_registers(location_id, date);

-- ─── Pre-Orders ─────────────────────────────────────────────
CREATE TABLE pre_orders (
  id SERIAL PRIMARY KEY,
  sale_id INTEGER NOT NULL UNIQUE REFERENCES sales(id) ON DELETE CASCADE,
  scheduled_date DATE NOT NULL,
  scheduled_time VARCHAR(10),
  advance_payment DECIMAL(12,2) NOT NULL DEFAULT 0,
  remaining_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  reminder_sent INTEGER DEFAULT 0,
  status VARCHAR(20) DEFAULT 'pending',
  delivery_address TEXT,
  special_instructions TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_pre_orders_scheduled ON pre_orders(scheduled_date);

-- ─── Expenses ───────────────────────────────────────────────
CREATE TABLE expenses (
  id SERIAL PRIMARY KEY,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  category expense_category NOT NULL DEFAULT 'other',
  amount DECIMAL(12,2) NOT NULL,
  description TEXT DEFAULT '',
  payment_method payment_method NOT NULL DEFAULT 'cash',
  expense_date DATE NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_expenses_location ON expenses(location_id);
CREATE INDEX idx_expenses_date ON expenses(expense_date);
CREATE INDEX idx_expenses_category ON expenses(category);

-- ─── Customer Addresses ─────────────────────────────────────
CREATE TABLE customer_addresses (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label VARCHAR(50) NOT NULL DEFAULT 'Home',
  address_line_1 TEXT NOT NULL,
  address_line_2 TEXT DEFAULT '',
  city VARCHAR(100) DEFAULT '',
  state VARCHAR(100) DEFAULT '',
  pincode VARCHAR(10) DEFAULT '',
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  is_default BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_customer_addresses_customer ON customer_addresses(customer_id);

-- ─── Credit Payments ────────────────────────────────────────
CREATE TABLE credit_payments (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sale_id INTEGER REFERENCES sales(id) ON DELETE SET NULL,
  amount DECIMAL(12,2) NOT NULL,
  method payment_method NOT NULL DEFAULT 'cash',
  received_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_credit_payments_customer ON credit_payments(customer_id);

-- ─── Special Dates ──────────────────────────────────────────
CREATE TABLE special_dates (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label VARCHAR(100) NOT NULL,
  date VARCHAR(10) NOT NULL,
  reminder_sent INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_special_dates_customer ON special_dates(customer_id);
CREATE INDEX idx_special_dates_date ON special_dates(date);

-- ─── Production Logs ────────────────────────────────────────
CREATE TABLE production_logs (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL DEFAULT 1,
  sale_id INTEGER REFERENCES sales(id) ON DELETE SET NULL,
  task_id INTEGER,
  produced_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_production_logs_product ON production_logs(product_id);
CREATE INDEX idx_production_logs_producer ON production_logs(produced_by);
CREATE INDEX idx_production_logs_date ON production_logs(created_at);

-- ─── Production Tasks ───────────────────────────────────────
CREATE TABLE production_tasks (
  id SERIAL PRIMARY KEY,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  sale_item_id INTEGER REFERENCES sale_items(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL DEFAULT 1,
  status task_status NOT NULL DEFAULT 'pending',
  assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
  picked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  priority task_priority NOT NULL DEFAULT 'normal',
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX idx_production_tasks_sale ON production_tasks(sale_id);
CREATE INDEX idx_production_tasks_status ON production_tasks(status);
CREATE INDEX idx_production_tasks_assigned ON production_tasks(assigned_to);
CREATE INDEX idx_production_tasks_location ON production_tasks(location_id);

-- ─── Deliveries ─────────────────────────────────────────────
CREATE TABLE deliveries (
  id SERIAL PRIMARY KEY,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  delivery_partner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  status delivery_status NOT NULL DEFAULT 'pending',
  delivery_address TEXT NOT NULL,
  customer_name VARCHAR(255),
  customer_phone VARCHAR(20),
  scheduled_date DATE,
  scheduled_time VARCHAR(10),
  cod_amount DECIMAL(12,2) DEFAULT 0,
  cod_collected DECIMAL(12,2) DEFAULT 0,
  cod_status cod_status DEFAULT 'none',
  pickup_time TIMESTAMPTZ,
  delivered_time TIMESTAMPTZ,
  delivery_notes TEXT DEFAULT '',
  failure_reason TEXT DEFAULT '',
  batch_id VARCHAR(50),
  assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_deliveries_sale ON deliveries(sale_id);
CREATE INDEX idx_deliveries_partner ON deliveries(delivery_partner_id);
CREATE INDEX idx_deliveries_status ON deliveries(status);
CREATE INDEX idx_deliveries_location ON deliveries(location_id);
CREATE INDEX idx_deliveries_batch ON deliveries(batch_id);

-- ─── Delivery Proofs ────────────────────────────────────────
CREATE TABLE delivery_proofs (
  id SERIAL PRIMARY KEY,
  delivery_id INTEGER NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  photo_url TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  notes TEXT DEFAULT '',
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_delivery_proofs_delivery ON delivery_proofs(delivery_id);

-- ─── Delivery Collections (COD) ─────────────────────────────
CREATE TABLE delivery_collections (
  id SERIAL PRIMARY KEY,
  delivery_id INTEGER NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  amount DECIMAL(12,2) NOT NULL,
  method cod_collection_method NOT NULL DEFAULT 'cash',
  reference_number VARCHAR(100),
  collected_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_delivery_collections_delivery ON delivery_collections(delivery_id);

-- ─── Delivery Settlements ───────────────────────────────────
CREATE TABLE delivery_settlements (
  id SERIAL PRIMARY KEY,
  delivery_partner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  total_amount DECIMAL(12,2) NOT NULL,
  total_deliveries INTEGER NOT NULL DEFAULT 0,
  status settlement_status NOT NULL DEFAULT 'pending',
  verified_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  verified_at TIMESTAMPTZ,
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_delivery_settlements_partner ON delivery_settlements(delivery_partner_id);
CREATE INDEX idx_delivery_settlements_status ON delivery_settlements(status);

-- ─── Delivery Settlement Items ──────────────────────────────
CREATE TABLE delivery_settlement_items (
  id SERIAL PRIMARY KEY,
  settlement_id INTEGER NOT NULL REFERENCES delivery_settlements(id) ON DELETE CASCADE,
  delivery_id INTEGER NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  amount DECIMAL(12,2) NOT NULL
);

CREATE INDEX idx_dsi_settlement ON delivery_settlement_items(settlement_id);

-- ─── Attendance ─────────────────────────────────────────────
CREATE TABLE attendance (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  clock_in TIMESTAMPTZ,
  clock_in_method clock_method DEFAULT 'manual',
  clock_in_latitude DOUBLE PRECISION,
  clock_in_longitude DOUBLE PRECISION,
  clock_out TIMESTAMPTZ,
  clock_out_method clock_method,
  clock_out_latitude DOUBLE PRECISION,
  clock_out_longitude DOUBLE PRECISION,
  total_hours DECIMAL(5,2) DEFAULT 0,
  outdoor_hours DECIMAL(5,2) DEFAULT 0,
  effective_hours DECIMAL(5,2) DEFAULT 0,
  status attendance_status DEFAULT 'present',
  late_arrival BOOLEAN DEFAULT FALSE,
  early_departure BOOLEAN DEFAULT FALSE,
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- No UNIQUE on (user_id, date) — multiple clock-in/out per day allowed
CREATE INDEX idx_attendance_user ON attendance(user_id);
CREATE INDEX idx_attendance_date ON attendance(date);
CREATE INDEX idx_attendance_location ON attendance(location_id);
CREATE INDEX idx_attendance_user_date ON attendance(user_id, date);

-- ─── Employee Shifts ────────────────────────────────────────
CREATE TABLE employee_shifts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  shift_start VARCHAR(5) NOT NULL DEFAULT '09:00',
  shift_end VARCHAR(5) NOT NULL DEFAULT '18:00',
  days_of_week JSONB NOT NULL DEFAULT '["monday","tuesday","wednesday","thursday","friday","saturday"]',
  shift_segments JSONB,
  geofence_timeout_minutes INTEGER DEFAULT 15,
  is_active BOOLEAN DEFAULT TRUE,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_employee_shifts_user ON employee_shifts(user_id);
CREATE INDEX idx_employee_shifts_location ON employee_shifts(location_id);

-- ─── Outdoor Duty Requests ──────────────────────────────────
CREATE TABLE outdoor_duty_requests (
  id SERIAL PRIMARY KEY,
  attendance_id INTEGER REFERENCES attendance(id) ON DELETE SET NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  start_time TIMESTAMPTZ,
  end_time TIMESTAMPTZ,
  duration DECIMAL(5,2) DEFAULT 0,
  reason TEXT NOT NULL,
  status duty_status DEFAULT 'requested',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_outdoor_duty_user ON outdoor_duty_requests(user_id);
CREATE INDEX idx_outdoor_duty_status ON outdoor_duty_requests(status);

-- ─── Geofence Events ────────────────────────────────────────
CREATE TABLE geofence_events (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  event_type geofence_event_type NOT NULL,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  processed BOOLEAN DEFAULT FALSE,
  auto_action VARCHAR(50),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_geofence_events_user ON geofence_events(user_id);
CREATE INDEX idx_geofence_events_processed ON geofence_events(processed) WHERE processed = FALSE;

-- ─── Salary Advances ────────────────────────────────────────
CREATE TABLE salary_advances (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount DECIMAL(12,2) NOT NULL,
  reason TEXT DEFAULT '',
  approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status advance_status DEFAULT 'pending',
  repaid_amount DECIMAL(12,2) DEFAULT 0,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_salary_advances_user ON salary_advances(user_id);

-- ─── Employee Salaries ──────────────────────────────────────
CREATE TABLE employee_salaries (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  monthly_salary DECIMAL(12,2) NOT NULL DEFAULT 0,
  salary_type salary_type NOT NULL DEFAULT 'monthly',
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  notes TEXT DEFAULT '',
  updated_by INTEGER NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_employee_salaries_user ON employee_salaries(user_id);

-- ─── Salary History ─────────────────────────────────────────
CREATE TABLE salary_history (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  old_salary DECIMAL(12,2) DEFAULT 0,
  new_salary DECIMAL(12,2) NOT NULL,
  salary_type salary_type NOT NULL DEFAULT 'monthly',
  reason TEXT DEFAULT '',
  changed_by INTEGER NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_salary_history_user ON salary_history(user_id);

-- ─── Salary Payments ────────────────────────────────────────
CREATE TABLE salary_payments (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  base_salary DECIMAL(12,2) NOT NULL DEFAULT 0,
  days_worked DECIMAL(5,2) DEFAULT 0,
  days_in_period INTEGER DEFAULT 0,
  hours_worked DECIMAL(7,2) DEFAULT 0,
  late_days INTEGER DEFAULT 0,
  absent_days INTEGER DEFAULT 0,
  leaves_taken INTEGER DEFAULT 0,
  deductions DECIMAL(12,2) DEFAULT 0,
  advances_deducted DECIMAL(12,2) DEFAULT 0,
  bonus DECIMAL(12,2) DEFAULT 0,
  net_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  payment_method salary_payment_method DEFAULT 'cash',
  payment_reference TEXT DEFAULT '',
  status salary_payment_status DEFAULT 'pending',
  paid_at TIMESTAMPTZ,
  paid_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_salary_payments_user ON salary_payments(user_id);
CREATE INDEX idx_salary_payments_period ON salary_payments(period_start, period_end);

-- ─── Delivery Locations (GPS Tracking) ──────────────────────
CREATE TABLE delivery_locations (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delivery_id INTEGER REFERENCES deliveries(id) ON DELETE SET NULL,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  accuracy DOUBLE PRECISION,
  speed DOUBLE PRECISION,
  heading DOUBLE PRECISION,
  battery_level DOUBLE PRECISION,
  is_moving BOOLEAN DEFAULT FALSE,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_delivery_locations_user ON delivery_locations(user_id);
CREATE INDEX idx_delivery_locations_delivery ON delivery_locations(delivery_id);
CREATE INDEX idx_delivery_locations_recorded ON delivery_locations(recorded_at);

-- ─── Delivery Partner Daily Summary ─────────────────────────
CREATE TABLE delivery_partner_daily (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  total_deliveries INTEGER DEFAULT 0,
  total_distance_km DECIMAL(8,2) DEFAULT 0,
  total_active_minutes DECIMAL(8,2) DEFAULT 0,
  total_idle_minutes DECIMAL(8,2) DEFAULT 0,
  first_delivery_at TIMESTAMPTZ,
  last_delivery_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, date)
);

CREATE INDEX idx_delivery_partner_daily_user ON delivery_partner_daily(user_id);

-- ─── Recurring Orders ───────────────────────────────────────
CREATE TABLE recurring_orders (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  order_type order_type NOT NULL DEFAULT 'delivery',
  frequency frequency_type NOT NULL DEFAULT 'daily',
  custom_days JSONB,
  delivery_address TEXT,
  scheduled_time VARCHAR(10),
  notes TEXT DEFAULT '',
  sender_message TEXT DEFAULT '',
  sender_name VARCHAR(255) DEFAULT '',
  sender_phone VARCHAR(20) DEFAULT '',
  items JSONB NOT NULL DEFAULT '[]',
  is_active BOOLEAN DEFAULT TRUE,
  last_generated_date DATE,
  next_run_date DATE NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_recurring_active ON recurring_orders(is_active, next_run_date);

-- ─── Updated_at Trigger Function ─────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply to tables with updated_at
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'users', 'locations', 'material_categories', 'materials', 'material_stock',
    'suppliers', 'supplier_materials', 'purchase_orders', 'stock_transfers',
    'products', 'sales', 'sale_items', 'refunds', 'pre_orders', 'expenses',
    'customer_addresses', 'production_tasks', 'deliveries', 'attendance',
    'employee_shifts', 'employee_salaries', 'delivery_partner_daily',
    'recurring_orders'
  ]
  LOOP
    EXECUTE format('
      CREATE TRIGGER set_updated_at_%I
      BEFORE UPDATE ON %I
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()',
      tbl, tbl);
  END LOOP;
END $$;

-- ─── Seed Default Settings ─────────────────────────────────
INSERT INTO settings (key, value, description) VALUES
  ('shop_name', 'BloomPOS', 'Business name displayed on receipts'),
  ('currency', '₹', 'Currency symbol'),
  ('gst_number', '', 'GST registration number'),
  ('receipt_footer', 'Thank you for your purchase!', 'Custom text on receipts'),
  ('return_policy_text', '', 'Return policy displayed on receipts'),
  ('discount_manager_threshold', '20', 'Discount % requiring Manager approval'),
  ('discount_owner_threshold', '30', 'Discount % requiring Owner approval'),
  ('refund_manager_limit', '10000', 'Max refund amount (₹) a Manager can approve'),
  ('default_geofence_radius', '50', 'Default geofence radius in meters'),
  ('default_geofence_timeout', '15', 'Default geofence timeout in minutes'),
  ('wastage_alert_percentage', '10', 'Wastage % threshold for alerts'),
  ('default_bundle_size', '20', 'Default flower bundle size (stems)'),
  ('default_foam_box_size', '24', 'Default floral foam blocks per box'),
  ('delivery_location_interval', '30', 'Delivery partner location update interval (seconds)'),
  ('pre_order_reminder_days', '2,1,0', 'Days before pre-order to send reminders'),
  ('special_date_reminder_days', '7,3,1', 'Days before special date to send reminders'),
  ('default_tax_rate_id', '', 'Default tax rate ID for new products'),
  ('timezone', 'Asia/Kolkata', 'Shop timezone for all date/time operations (IANA timezone name)')
ON CONFLICT (key) DO NOTHING;

-- ─── Seed Default Tax Rates ─────────────────────────────────
INSERT INTO tax_rates (name, percentage, is_default) VALUES
  ('No Tax', 0, FALSE),
  ('GST 5%', 5, FALSE),
  ('GST 12%', 12, TRUE),
  ('GST 18%', 18, FALSE),
  ('GST 28%', 28, FALSE)
ON CONFLICT DO NOTHING;

-- ─── Seed Default Material Categories ────────────────────────
INSERT INTO material_categories (name, unit, has_bundle, default_bundle_size, is_perishable, default_storage)
VALUES
  ('Flowers', 'stems', TRUE, 20, TRUE, 'shop'),
  ('Ribbons', 'pieces', FALSE, 1, FALSE, 'shop'),
  ('Vases', 'pieces', FALSE, 1, FALSE, 'warehouse'),
  ('Wrapping Paper', 'sheets', FALSE, 1, FALSE, 'shop'),
  ('Floral Foam', 'blocks', TRUE, 24, FALSE, 'warehouse'),
  ('Baskets', 'pieces', FALSE, 1, FALSE, 'warehouse'),
  ('Decorative Items', 'pieces', FALSE, 1, FALSE, 'shop')
ON CONFLICT DO NOTHING;
