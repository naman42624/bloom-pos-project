-- ============================================================
-- BloomCart POS — PostgreSQL Schema
-- ============================================================
-- This is the production database schema for PostgreSQL
-- Converted from SQLite database.js definitions

BEGIN;

-- ─── Users & Auth ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  phone VARCHAR(20) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE,
  password TEXT NOT NULL,
  name VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL DEFAULT 'customer' CHECK(role IN ('owner', 'manager', 'employee', 'delivery_partner', 'customer')),
  avatar TEXT,
  bio TEXT DEFAULT '',
  birthday DATE,
  anniversary DATE,
  custom_dates JSONB DEFAULT '[]'::jsonb,
  total_spent DECIMAL(10,2) DEFAULT 0,
  credit_balance DECIMAL(10,2) DEFAULT 0,
  notes TEXT DEFAULT '',
  is_active INTEGER DEFAULT 1,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- ─── Material Categories ───────────────────────────────────
CREATE TABLE IF NOT EXISTS material_categories (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  unit VARCHAR(50) DEFAULT 'pcs',
  has_bundle INTEGER DEFAULT 0,
  default_bundle_size DECIMAL(10,2) DEFAULT 1,
  is_perishable INTEGER DEFAULT 1,
  default_storage VARCHAR(100) DEFAULT 'room_temp',
  is_active INTEGER DEFAULT 1,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ─── Locations (Shops & Warehouses) ────────────────────────
CREATE TABLE IF NOT EXISTS locations (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  type VARCHAR(50) DEFAULT 'shop' CHECK(type IN ('shop', 'warehouse')),
  address TEXT,
  city VARCHAR(100),
  state VARCHAR(100),
  pincode VARCHAR(10),
  latitude DECIMAL(10,7),
  longitude DECIMAL(10,7),
  geofence_radius INTEGER DEFAULT 500,
  phone VARCHAR(20),
  email VARCHAR(255),
  gst_number VARCHAR(50),
  operating_hours JSONB,
  custom_dates JSONB,
  is_active INTEGER DEFAULT 1,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_locations_active ON locations(is_active);

-- ─── Location Access Control ───────────────────────────────
CREATE TABLE IF NOT EXISTS user_locations (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  is_primary INTEGER DEFAULT 0,
  role VARCHAR(50) DEFAULT 'staff',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, location_id)
);

CREATE INDEX IF NOT EXISTS idx_user_locations_user ON user_locations(user_id);
CREATE INDEX IF NOT EXISTS idx_user_locations_location ON user_locations(location_id);

-- ─── Settings ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  id SERIAL PRIMARY KEY,
  key VARCHAR(255) UNIQUE NOT NULL,
  value TEXT,
  description TEXT,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ─── Categories ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  image_url TEXT,
  sort_order INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ─── Materials (Flowers, Supplies, Packaging) ──────────────
CREATE TABLE IF NOT EXISTS materials (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  category_id INTEGER REFERENCES material_categories(id) ON DELETE SET NULL,
  sku VARCHAR(100) UNIQUE,
  bundle_size_override DECIMAL(10,2),
  image_url TEXT,
  selling_price DECIMAL(10,2) DEFAULT 0,
  min_stock_alert INTEGER DEFAULT 10,
  warning_stock INTEGER DEFAULT 10,
  is_active INTEGER DEFAULT 1,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_materials_category ON materials(category_id);
CREATE INDEX IF NOT EXISTS idx_materials_sku ON materials(sku);

-- ─── Material Stock (Inventory History) ─────────────────────
CREATE TABLE IF NOT EXISTS material_stock (
  id SERIAL PRIMARY KEY,
  material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  quantity DECIMAL(10,2) DEFAULT 0,
  last_counted_at TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(material_id, location_id)
);

CREATE INDEX IF NOT EXISTS idx_material_stock_location ON material_stock(location_id);

-- ─── Suppliers ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS suppliers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(20),
  email VARCHAR(255),
  address TEXT,
  gst_number VARCHAR(50),
  notes TEXT DEFAULT '',
  is_active INTEGER DEFAULT 1,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ─── Purchase Orders ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS purchase_orders (
  id SERIAL PRIMARY KEY,
  po_number VARCHAR(100) UNIQUE NOT NULL,
  supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  expected_date DATE,
  expected_time TIME,
  total_amount DECIMAL(10,2) DEFAULT 0,
  status VARCHAR(50) DEFAULT 'expected',
  received_date DATE,
  notes TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier ON purchase_orders(supplier_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_status ON purchase_orders(status);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id SERIAL PRIMARY KEY,
  purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  expected_quantity DECIMAL(10,2) DEFAULT 0,
  expected_unit VARCHAR(50) DEFAULT 'pieces',
  expected_price_per_unit DECIMAL(10,2) DEFAULT 0,
  received_quantity DECIMAL(10,2) DEFAULT 0,
  received_unit VARCHAR(50),
  actual_price_per_unit DECIMAL(10,2) DEFAULT 0,
  quality VARCHAR(100),
  received_at TIMESTAMP,
  received_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_po_items_order ON purchase_order_items(purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_po_items_material ON purchase_order_items(material_id);

-- ─── Products (Finished Bouquets, Arrangements) ───────────
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  sku VARCHAR(100) UNIQUE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  type VARCHAR(50) DEFAULT 'standard',
  category VARCHAR(100),
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  base_cost DECIMAL(10,2) DEFAULT 0,
  estimated_cost DECIMAL(10,2) DEFAULT 0,
  selling_price DECIMAL(10,2) NOT NULL DEFAULT 0,
  tax_rate_id INTEGER REFERENCES tax_rates(id) ON DELETE SET NULL,
  location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  materials_composition JSONB,
  quantity_in_stock INTEGER DEFAULT 0,
  low_stock_alert INTEGER DEFAULT 5,
  is_active INTEGER DEFAULT 1,
  image_url TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(is_active);

-- ─── Tax Rates ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tax_rates (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  percentage DECIMAL(5,2) DEFAULT 0,
  rate DECIMAL(5,2) NOT NULL,
  is_active INTEGER DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO tax_rates (name, rate, is_active) VALUES ('Standard', 5, 1), ('Premium', 10, 1), ('Zero', 0, 1) ON CONFLICT DO NOTHING;

-- ─── Sales (Orders & Transactions) ─────────────────────────
CREATE TABLE IF NOT EXISTS sales (
  id SERIAL PRIMARY KEY,
  sale_number VARCHAR(100) UNIQUE NOT NULL,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  customer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  customer_name VARCHAR(255),
  customer_phone VARCHAR(20),
  order_type VARCHAR(50) DEFAULT 'walk_in' CHECK(order_type IN ('walk_in', 'delivery', 'pickup', 'pre_order')),
  delivery_address TEXT,
  scheduled_date DATE,
  scheduled_time TIME,
  subtotal DECIMAL(10,2) DEFAULT 0,
  tax_rate DECIMAL(5,2) DEFAULT 0,
  tax_total DECIMAL(10,2) DEFAULT 0,
  discount_percentage DECIMAL(5,2) DEFAULT 0,
  discount_amount DECIMAL(10,2) DEFAULT 0,
  delivery_charges DECIMAL(10,2) DEFAULT 0,
  grand_total DECIMAL(10,2) DEFAULT 0,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  payment_method VARCHAR(50) DEFAULT 'cash',
  payment_status VARCHAR(50) DEFAULT 'pending' CHECK(payment_status IN ('pending', 'paid', 'partial', 'refunded')),
  status VARCHAR(50) DEFAULT 'pending' CHECK(status IN ('pending', 'completed', 'cancelled', 'draft')),
  pickup_status VARCHAR(50) CHECK(pickup_status IN ('waiting', 'ready_for_pickup', 'picked_up')),
  stock_deducted INTEGER DEFAULT 0,
  sender_message TEXT DEFAULT '',
  sender_name TEXT DEFAULT '',
  sender_phone TEXT DEFAULT '',
  special_instructions TEXT,
  customer_notes TEXT,
  picked_up_at TIMESTAMP,
  source VARCHAR(50) DEFAULT 'manual' CHECK(source IN ('manual', 'recurring', 'pre_order')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sales_location ON sales(location_id);
CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(customer_id);
CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_status ON sales(status);
CREATE INDEX IF NOT EXISTS idx_sales_payment_status ON sales(payment_status);
CREATE INDEX IF NOT EXISTS idx_sales_order_type ON sales(order_type);

-- ─── Sale Items ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sale_items (
  id SERIAL PRIMARY KEY,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  material_id INTEGER REFERENCES materials(id) ON DELETE SET NULL,
  product_name VARCHAR(255),
  quantity DECIMAL(10,2) NOT NULL DEFAULT 1,
  unit_price DECIMAL(10,2) NOT NULL DEFAULT 0,
  tax_rate DECIMAL(5,2) DEFAULT 0,
  tax_amount DECIMAL(10,2) DEFAULT 0,
  line_total DECIMAL(12,2) GENERATED ALWAYS AS (quantity * unit_price + tax_amount) STORED,
  materials_deducted INTEGER DEFAULT 0,
  from_product_stock INTEGER DEFAULT 0,
  special_instructions TEXT,
  image_url TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);

-- ─── Payments ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  method VARCHAR(50) DEFAULT 'cash',
  amount DECIMAL(10,2) NOT NULL,
  reference_number VARCHAR(255),
  received_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_payments_sale ON payments(sale_id);
CREATE INDEX IF NOT EXISTS idx_payments_method ON payments(method);
CREATE INDEX IF NOT EXISTS idx_sale_items_product ON sale_items(product_id);

-- ─── Refunds ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS refunds (
  id SERIAL PRIMARY KEY,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  amount DECIMAL(10,2) NOT NULL DEFAULT 0,
  reason TEXT,
  refunded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_refunds_sale ON refunds(sale_id);

-- ─── Deliveries ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deliveries (
  id SERIAL PRIMARY KEY,
  sale_id INTEGER NOT NULL UNIQUE REFERENCES sales(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  customer_name VARCHAR(255),
  customer_phone VARCHAR(20),
  delivery_address TEXT NOT NULL,
  scheduled_date DATE,
  scheduled_time TIME,
  cod_amount DECIMAL(10,2) DEFAULT 0,
  cod_status VARCHAR(50) DEFAULT 'pending' CHECK(cod_status IN ('pending', 'collected', 'failed')),
  status VARCHAR(50) DEFAULT 'pending' CHECK(status IN ('pending', 'assigned', 'picked_up', 'in_transit', 'delivered', 'failed', 'cancelled')),
  partner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  delivery_partner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  partner_name VARCHAR(255),
  assigned_at TIMESTAMP,
  picked_up_at TIMESTAMP,
  in_transit_at TIMESTAMP,
  delivered_at TIMESTAMP,
  delivered_time TIMESTAMP,
  failure_reason TEXT,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_deliveries_location ON deliveries(location_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_partner ON deliveries(partner_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_partner_new ON deliveries(delivery_partner_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_status ON deliveries(status);
CREATE INDEX IF NOT EXISTS idx_deliveries_date ON deliveries(scheduled_date);

-- ─── Production Tasks ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS production_tasks (
  id SERIAL PRIMARY KEY,
  sale_id INTEGER REFERENCES sales(id) ON DELETE CASCADE,
  sale_item_id INTEGER REFERENCES sale_items(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  quantity DECIMAL(10,2) NOT NULL DEFAULT 1,
  priority VARCHAR(50) DEFAULT 'medium' CHECK(priority IN ('low', 'medium', 'high', 'urgent')),
  status VARCHAR(50) DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'completed', 'cancelled')),
  notes TEXT,
  assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
  picked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_production_tasks_location ON production_tasks(location_id);
CREATE INDEX IF NOT EXISTS idx_production_tasks_status ON production_tasks(status);
CREATE INDEX IF NOT EXISTS idx_production_tasks_priority ON production_tasks(priority);

-- ─── Production Logs ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS production_logs (
  id SERIAL PRIMARY KEY,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  quantity DECIMAL(10,2) NOT NULL DEFAULT 0,
  sale_id INTEGER REFERENCES sales(id) ON DELETE SET NULL,
  task_id INTEGER REFERENCES production_tasks(id) ON DELETE SET NULL,
  produced_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_production_logs_created_at ON production_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_production_logs_produced_by ON production_logs(produced_by);

-- ─── Product Stock ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS product_stock (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  quantity DECIMAL(10,2) DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(product_id, location_id)
);

CREATE INDEX IF NOT EXISTS idx_product_stock_location ON product_stock(location_id);

-- ─── Stock Transfers ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_transfers (
  id SERIAL PRIMARY KEY,
  from_location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  to_location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  quantity DECIMAL(10,2) NOT NULL,
  unit VARCHAR(50) DEFAULT 'pcs',
  status VARCHAR(50) DEFAULT 'initiated',
  notes TEXT,
  initiated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  received_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_stock_transfers_from ON stock_transfers(from_location_id);
CREATE INDEX IF NOT EXISTS idx_stock_transfers_to ON stock_transfers(to_location_id);
CREATE INDEX IF NOT EXISTS idx_stock_transfers_status ON stock_transfers(status);

-- ─── Expenses ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expenses (
  id SERIAL PRIMARY KEY,
  expense_number VARCHAR(100) UNIQUE NOT NULL,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  category VARCHAR(100) NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  description TEXT,
  payment_method VARCHAR(50) DEFAULT 'cash',
  vendor_name VARCHAR(255),
  receipt_url TEXT,
  expense_date DATE NOT NULL,
  status VARCHAR(50) DEFAULT 'approved' CHECK(status IN ('pending', 'approved', 'rejected')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_expenses_location ON expenses(location_id);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);

-- ─── Pre-Orders ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pre_orders (
  id SERIAL PRIMARY KEY,
  order_number VARCHAR(100) UNIQUE NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  subtotal DECIMAL(10,2) DEFAULT 0,
  tax_amount DECIMAL(10,2) DEFAULT 0,
  grand_total DECIMAL(10,2) DEFAULT 0,
  delivery_date DATE,
  delivery_address TEXT,
  status VARCHAR(50) DEFAULT 'pending' CHECK(status IN ('pending', 'confirmed', 'completed', 'cancelled')),
  special_instructions TEXT,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pre_orders_customer ON pre_orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_pre_orders_delivery_date ON pre_orders(delivery_date);

-- ─── Recurring Orders ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS recurring_orders (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  order_type VARCHAR(50) DEFAULT 'delivery' CHECK(order_type IN ('pickup', 'delivery')),
  frequency VARCHAR(50) DEFAULT 'daily' CHECK(frequency IN ('daily', 'weekly', 'monthly', 'custom')),
  custom_days JSONB,
  delivery_address TEXT,
  scheduled_time TIME,
  notes TEXT DEFAULT '',
  sender_message TEXT DEFAULT '',
  sender_name TEXT DEFAULT '',
  sender_phone TEXT DEFAULT '',
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  label VARCHAR(100) DEFAULT 'task-manager',
  is_active INTEGER DEFAULT 1,
  last_generated_date DATE,
  next_run_date DATE NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_recurring_active ON recurring_orders(is_active, next_run_date);

-- ─── Employee Shifts & Geofencing ──────────────────────────
CREATE TABLE IF NOT EXISTS employee_shifts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  shift_start TIME NOT NULL,
  shift_end TIME NOT NULL,
  is_active INTEGER DEFAULT 1,
  geofence_timeout_minutes INTEGER DEFAULT 30,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, location_id)
);

CREATE INDEX IF NOT EXISTS idx_employee_shifts_user ON employee_shifts(user_id);
CREATE INDEX IF NOT EXISTS idx_employee_shifts_location ON employee_shifts(location_id);

-- ─── Attendance ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS attendance (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  clock_in TIMESTAMP,
  clock_in_method VARCHAR(50) DEFAULT 'manual' CHECK(clock_in_method IN ('auto_geofence', 'manual')),
  clock_in_latitude DECIMAL(10,7),
  clock_in_longitude DECIMAL(10,7),
  clock_out TIMESTAMP,
  clock_out_method VARCHAR(50) CHECK(clock_out_method IN ('auto_geofence', 'manual', 'auto_timeout')),
  clock_out_latitude DECIMAL(10,7),
  clock_out_longitude DECIMAL(10,7),
  total_hours DECIMAL(10,2) DEFAULT 0,
  outdoor_hours DECIMAL(10,2) DEFAULT 0,
  effective_hours DECIMAL(10,2) DEFAULT 0,
  status VARCHAR(50) DEFAULT 'present' CHECK(status IN ('present', 'absent', 'half_day', 'on_leave')),
  late_arrival INTEGER DEFAULT 0,
  early_departure INTEGER DEFAULT 0,
  notes TEXT DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_attendance_user ON attendance(user_id);
CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(date);
CREATE INDEX IF NOT EXISTS idx_attendance_location ON attendance(location_id);
CREATE INDEX IF NOT EXISTS idx_attendance_user_date ON attendance(user_id, date);

-- ─── Geofence Events ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS geofence_events (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  event_type VARCHAR(50) NOT NULL CHECK(event_type IN ('enter', 'exit')),
  latitude DECIMAL(10,7) NOT NULL,
  longitude DECIMAL(10,7) NOT NULL,
  accuracy DECIMAL(5,1),
  processed INTEGER DEFAULT 0,
  auto_action VARCHAR(50),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, location_id, event_type, created_at)
);

CREATE INDEX IF NOT EXISTS idx_geofence_events_user ON geofence_events(user_id);
CREATE INDEX IF NOT EXISTS idx_geofence_events_processed ON geofence_events(processed);

-- ─── Outdoor Duty Requests ────────────────────────────────
CREATE TABLE IF NOT EXISTS outdoor_duty_requests (
  id SERIAL PRIMARY KEY,
  attendance_id INTEGER REFERENCES attendance(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  start_time TIMESTAMP,
  end_time TIMESTAMP,
  duration DECIMAL(10,2) DEFAULT 0,
  reason TEXT NOT NULL,
  status VARCHAR(50) DEFAULT 'requested' CHECK(status IN ('requested', 'approved', 'rejected', 'completed')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_outdoor_duty_requests_user ON outdoor_duty_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_outdoor_duty_requests_status ON outdoor_duty_requests(status);

-- ─── Employee Salaries ────────────────────────────────────
CREATE TABLE IF NOT EXISTS employee_salaries (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  monthly_salary DECIMAL(10,2) NOT NULL DEFAULT 0,
  salary_type VARCHAR(50) DEFAULT 'monthly',
  notes TEXT,
  effective_from DATE DEFAULT CURRENT_DATE,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS salary_history (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  old_salary DECIMAL(10,2) DEFAULT 0,
  new_salary DECIMAL(10,2) DEFAULT 0,
  salary_type VARCHAR(50) DEFAULT 'monthly',
  reason TEXT,
  changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_salary_history_user ON salary_history(user_id);

CREATE TABLE IF NOT EXISTS salary_payments (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  base_salary DECIMAL(10,2) DEFAULT 0,
  days_worked DECIMAL(10,2) DEFAULT 0,
  days_in_period DECIMAL(10,2) DEFAULT 0,
  hours_worked DECIMAL(10,2) DEFAULT 0,
  late_days INTEGER DEFAULT 0,
  absent_days INTEGER DEFAULT 0,
  leaves_taken INTEGER DEFAULT 0,
  deductions DECIMAL(10,2) DEFAULT 0,
  advances_deducted DECIMAL(10,2) DEFAULT 0,
  bonus DECIMAL(10,2) DEFAULT 0,
  net_amount DECIMAL(10,2) DEFAULT 0,
  payment_method VARCHAR(50) DEFAULT 'cash',
  payment_reference VARCHAR(255),
  status VARCHAR(50) DEFAULT 'paid',
  paid_at TIMESTAMP,
  paid_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_salary_payments_user_period ON salary_payments(user_id, period_start, period_end);

-- ─── Salary & Payments ────────────────────────────────────
CREATE TABLE IF NOT EXISTS salary_advances (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  amount DECIMAL(10,2) NOT NULL,
  reason TEXT,
  status VARCHAR(50) DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'paid', 'rejected')),
  request_date DATE DEFAULT CURRENT_DATE,
  approval_date DATE,
  payment_date DATE,
  approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_salary_advances_user ON salary_advances(user_id);
CREATE INDEX IF NOT EXISTS idx_salary_advances_status ON salary_advances(status);

-- ─── Cash Registers ───────────────────────────────────────
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

CREATE INDEX IF NOT EXISTS idx_cash_registers_location ON cash_registers(location_id);
CREATE INDEX IF NOT EXISTS idx_cash_registers_status ON cash_registers(status);

-- ─── Deliveries Settlement ────────────────────────────────
CREATE TABLE IF NOT EXISTS delivery_settlements (
  id SERIAL PRIMARY KEY,
  settlement_number VARCHAR(100) UNIQUE NOT NULL,
  partner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delivery_partner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
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
  payment_status VARCHAR(50) DEFAULT 'pending' CHECK(payment_status IN ('pending', 'processed', 'failed')),
  payment_method VARCHAR(50),
  payment_date DATE,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_delivery_settlements_partner ON delivery_settlements(partner_id);
CREATE INDEX IF NOT EXISTS idx_delivery_settlements_date ON delivery_settlements(settlement_date);

-- ─── Settlement Items (Detail) ─────────────────────────────
CREATE TABLE IF NOT EXISTS delivery_settlement_items (
  id SERIAL PRIMARY KEY,
  settlement_id INTEGER NOT NULL REFERENCES delivery_settlements(id) ON DELETE CASCADE,
  delivery_id INTEGER NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  sale_id INTEGER REFERENCES sales(id) ON DELETE SET NULL,
  amount DECIMAL(10,2) NOT NULL,
  commission DECIMAL(10,2) DEFAULT 0,
  status VARCHAR(50) DEFAULT 'completed' CHECK(status IN ('scheduled', 'completed', 'failed', 'returned')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_delivery_settlement_items_settlement ON delivery_settlement_items(settlement_id);

-- ─── Credit/Payment Tracking ───────────────────────────────
CREATE TABLE IF NOT EXISTS credit_payments (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sale_id INTEGER REFERENCES sales(id) ON DELETE SET NULL,
  amount DECIMAL(10,2) NOT NULL,
  payment_method VARCHAR(50) NOT NULL DEFAULT 'cash',
  reference_number VARCHAR(100),
  notes TEXT,
  recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_credit_payments_customer ON credit_payments(customer_id);
CREATE INDEX IF NOT EXISTS idx_credit_payments_sale ON credit_payments(sale_id);

-- ─── Push Notifications ────────────────────────────────────
CREATE TABLE IF NOT EXISTS push_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  platform VARCHAR(50) DEFAULT 'expo',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, token)
);

CREATE INDEX IF NOT EXISTS idx_push_tokens_user ON push_tokens(user_id);

-- ─── Notifications ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  type VARCHAR(50) NOT NULL DEFAULT 'general',
  data JSONB DEFAULT '{}'::jsonb,
  is_read INTEGER DEFAULT 0,
  push_sent INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id, is_read);

-- ─── Timestamps & Auto-Update Trigger ──────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger to all tables with updated_at
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_locations_updated_at BEFORE UPDATE ON locations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_settings_updated_at BEFORE UPDATE ON settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_materials_updated_at BEFORE UPDATE ON materials
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_products_updated_at BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_sales_updated_at BEFORE UPDATE ON sales
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_deliveries_updated_at BEFORE UPDATE ON deliveries
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_production_tasks_updated_at BEFORE UPDATE ON production_tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_expenses_updated_at BEFORE UPDATE ON expenses
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_pre_orders_updated_at BEFORE UPDATE ON pre_orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_recurring_orders_updated_at BEFORE UPDATE ON recurring_orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_employee_shifts_updated_at BEFORE UPDATE ON employee_shifts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_attendance_updated_at BEFORE UPDATE ON attendance
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_outdoor_duty_requests_updated_at BEFORE UPDATE ON outdoor_duty_requests
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_salary_advances_updated_at BEFORE UPDATE ON salary_advances
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_cash_registers_updated_at BEFORE UPDATE ON cash_registers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_delivery_settlements_updated_at BEFORE UPDATE ON delivery_settlements
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_credit_payments_updated_at BEFORE UPDATE ON credit_payments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─── Initial Settings Data ────────────────────────────────
INSERT INTO settings (key, value, description) VALUES
  ('timezone', 'Asia/Kolkata', 'Shop timezone for all date/time operations (IANA timezone name)'),
  ('currency', 'INR', 'Currency code for the system'),
  ('tax_enabled', '1', 'Enable/disable tax calculations')
  ON CONFLICT (key) DO NOTHING;

COMMIT;
