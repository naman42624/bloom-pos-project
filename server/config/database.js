const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'database.sqlite');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initializeDatabase();
  }
  return db;
}

function initializeDatabase() {
  // ─── Users & Auth ──────────────────────────────────────────
  db.exec(`
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

    CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
  `);

  // ─── Locations (Shops & Warehouses) ────────────────────────
  db.exec(`
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
  `);

  // ─── User-Location Assignments ─────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      location_id INTEGER NOT NULL,
      is_primary INTEGER DEFAULT 0,
      assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE,
      UNIQUE(user_id, location_id)
    );

    CREATE INDEX IF NOT EXISTS idx_user_locations_user ON user_locations(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_locations_location ON user_locations(location_id);
  `);

  // ─── App Settings (Key-Value, Owner-configurable) ──────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE NOT NULL,
      value TEXT NOT NULL,
      description TEXT DEFAULT '',
      updated_by INTEGER,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
    );
  `);

  // Seed default settings if table is empty
  const settingsCount = db.prepare('SELECT COUNT(*) as count FROM settings').get();
  if (settingsCount.count === 0) {
    const seedSettings = db.prepare(
      'INSERT OR IGNORE INTO settings (key, value, description) VALUES (?, ?, ?)'
    );
    const defaults = [
      ['shop_name', 'BloomPOS', 'Business name displayed on receipts'],
      ['currency', '₹', 'Currency symbol'],
      ['gst_number', '', 'GST registration number'],
      ['receipt_footer', 'Thank you for your purchase!', 'Custom text on receipts'],
      ['return_policy_text', '', 'Return policy displayed on receipts'],
      ['discount_manager_threshold', '20', 'Discount % requiring Manager approval'],
      ['discount_owner_threshold', '30', 'Discount % requiring Owner approval'],
      ['refund_manager_limit', '10000', 'Max refund amount (₹) a Manager can approve'],
      ['default_geofence_radius', '50', 'Default geofence radius in meters'],
      ['default_geofence_timeout', '15', 'Default geofence timeout in minutes'],
      ['wastage_alert_percentage', '10', 'Wastage % threshold for alerts'],
      ['default_bundle_size', '20', 'Default flower bundle size (stems)'],
      ['default_foam_box_size', '24', 'Default floral foam blocks per box'],
      ['delivery_location_interval', '30', 'Delivery partner location update interval (seconds)'],
      ['pre_order_reminder_days', '2,1,0', 'Days before pre-order to send reminders'],
      ['special_date_reminder_days', '7,3,1', 'Days before special date to send reminders'],
      ['default_tax_rate_id', '', 'Default tax rate ID for new products'],
      ['supplier_manager_fields', 'name,phone,materials', 'Comma-separated supplier fields visible to managers (name,phone,email,address,gst_number,notes,materials,pricing)'],
    ];
    const seedTx = db.transaction(() => {
      for (const [key, value, description] of defaults) {
        seedSettings.run(key, value, description);
      }
    });
    seedTx();
  }

  // ─── Notifications ────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT DEFAULT '',
      data TEXT DEFAULT '{}',
      is_read INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(user_id, is_read);
  `);

  // ─── Tax Rates ─────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS tax_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      percentage REAL NOT NULL,
      is_default INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      effective_from DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    );
  `);

  // Seed default tax rates if table is empty
  const taxCount = db.prepare('SELECT COUNT(*) as count FROM tax_rates').get();
  if (taxCount.count === 0) {
    const seedTax = db.prepare(
      'INSERT INTO tax_rates (name, percentage, is_default) VALUES (?, ?, ?)'
    );
    const taxDefaults = [
      ['No Tax', 0, 0],
      ['GST 5%', 5, 0],
      ['GST 12%', 12, 1],
      ['GST 18%', 18, 0],
      ['GST 28%', 28, 0],
    ];
    const taxTx = db.transaction(() => {
      for (const [name, pct, def] of taxDefaults) {
        seedTax.run(name, pct, def);
      }
    });
    taxTx();
  }

  // ─── Phase 2: Material Categories ──────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS material_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      unit TEXT NOT NULL DEFAULT 'pieces',
      has_bundle INTEGER DEFAULT 0,
      default_bundle_size INTEGER DEFAULT 1,
      is_perishable INTEGER DEFAULT 0,
      default_storage TEXT DEFAULT 'shop' CHECK(default_storage IN ('shop', 'warehouse')),
      is_active INTEGER DEFAULT 1,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    );
  `);

  // Seed default material categories if empty
  const catCount = db.prepare('SELECT COUNT(*) as count FROM material_categories').get();
  if (catCount.count === 0) {
    const seedCat = db.prepare(
      'INSERT INTO material_categories (name, unit, has_bundle, default_bundle_size, is_perishable, default_storage) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const catDefaults = [
      ['Flowers', 'stems', 1, 20, 1, 'shop'],
      ['Ribbons', 'pieces', 0, 1, 0, 'shop'],
      ['Vases', 'pieces', 0, 1, 0, 'warehouse'],
      ['Wrapping Paper', 'sheets', 0, 1, 0, 'shop'],
      ['Floral Foam', 'blocks', 1, 24, 0, 'warehouse'],
      ['Baskets', 'pieces', 0, 1, 0, 'warehouse'],
      ['Decorative Items', 'pieces', 0, 1, 0, 'shop'],
    ];
    const catTx = db.transaction(() => {
      for (const [name, unit, hasBundle, bundleSize, perishable, storage] of catDefaults) {
        seedCat.run(name, unit, hasBundle, bundleSize, perishable, storage);
      }
    });
    catTx();
  }

  // ─── Phase 2: Material Varieties ───────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS materials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      sku TEXT UNIQUE,
      bundle_size_override INTEGER DEFAULT NULL,
      image_url TEXT DEFAULT NULL,
      min_stock_alert INTEGER DEFAULT 10,
      is_active INTEGER DEFAULT 1,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (category_id) REFERENCES material_categories(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_materials_category ON materials(category_id);
    CREATE INDEX IF NOT EXISTS idx_materials_sku ON materials(sku);
  `);

  // Migrate: add selling_price column if missing
  const matCols = db.prepare("PRAGMA table_info(materials)").all().map(c => c.name);
  if (!matCols.includes('selling_price')) {
    db.exec("ALTER TABLE materials ADD COLUMN selling_price REAL DEFAULT 0");
  }

  // ─── Phase 2: Material Stock (per location) ────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS material_stock (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      material_id INTEGER NOT NULL,
      location_id INTEGER NOT NULL,
      quantity REAL DEFAULT 0,
      last_counted_at DATETIME DEFAULT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (material_id) REFERENCES materials(id) ON DELETE CASCADE,
      FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE,
      UNIQUE(material_id, location_id)
    );

    CREATE INDEX IF NOT EXISTS idx_material_stock_material ON material_stock(material_id);
    CREATE INDEX IF NOT EXISTS idx_material_stock_location ON material_stock(location_id);
  `);

  // ─── Phase 2: Suppliers ────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      address TEXT,
      gst_number TEXT,
      notes TEXT DEFAULT '',
      is_active INTEGER DEFAULT 1,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    );
  `);

  // ─── Phase 2: Supplier-Material link (default prices) ──────
  db.exec(`
    CREATE TABLE IF NOT EXISTS supplier_materials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_id INTEGER NOT NULL,
      material_id INTEGER NOT NULL,
      default_price_per_unit REAL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE,
      FOREIGN KEY (material_id) REFERENCES materials(id) ON DELETE CASCADE,
      UNIQUE(supplier_id, material_id)
    );
  `);

  // ─── Phase 2: Purchase Orders ──────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS purchase_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      po_number TEXT UNIQUE,
      supplier_id INTEGER NOT NULL,
      location_id INTEGER NOT NULL,
      expected_date DATE,
      expected_time TEXT,
      status TEXT DEFAULT 'expected' CHECK(status IN ('expected', 'partially_received', 'received', 'cancelled')),
      notes TEXT DEFAULT '',
      total_amount REAL DEFAULT 0,
      created_by INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE,
      FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_po_supplier ON purchase_orders(supplier_id);
    CREATE INDEX IF NOT EXISTS idx_po_location ON purchase_orders(location_id);
    CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_orders(status);
  `);

  // ─── Phase 2: Purchase Order Items ─────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS purchase_order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_order_id INTEGER NOT NULL,
      material_id INTEGER NOT NULL,
      expected_quantity REAL NOT NULL,
      expected_unit TEXT DEFAULT 'pieces',
      expected_price_per_unit REAL DEFAULT 0,
      received_quantity REAL DEFAULT 0,
      received_quality TEXT DEFAULT NULL CHECK(received_quality IS NULL OR received_quality IN ('good', 'average', 'poor')),
      actual_price_per_unit REAL DEFAULT 0,
      received_by INTEGER DEFAULT NULL,
      received_at DATETIME DEFAULT NULL,
      FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id) ON DELETE CASCADE,
      FOREIGN KEY (material_id) REFERENCES materials(id) ON DELETE CASCADE,
      FOREIGN KEY (received_by) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_poi_po ON purchase_order_items(purchase_order_id);
  `);

  // ─── Phase 2: Material Transactions (stock ledger) ─────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS material_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      material_id INTEGER NOT NULL,
      location_id INTEGER NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('purchase', 'usage', 'wastage', 'transfer_in', 'transfer_out', 'adjustment', 'return')),
      quantity REAL NOT NULL,
      unit TEXT DEFAULT 'pieces',
      reference_type TEXT DEFAULT NULL,
      reference_id INTEGER DEFAULT NULL,
      notes TEXT DEFAULT '',
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (material_id) REFERENCES materials(id) ON DELETE CASCADE,
      FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_mt_material ON material_transactions(material_id);
    CREATE INDEX IF NOT EXISTS idx_mt_location ON material_transactions(location_id);
    CREATE INDEX IF NOT EXISTS idx_mt_type ON material_transactions(type);
    CREATE INDEX IF NOT EXISTS idx_mt_created ON material_transactions(created_at);
  `);

  // ─── Phase 2: Daily Stock Reconciliation ───────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_stock_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id INTEGER NOT NULL,
      material_id INTEGER NOT NULL,
      date DATE NOT NULL,
      opening_stock REAL DEFAULT 0,
      received_stock REAL DEFAULT 0,
      used_in_products REAL DEFAULT 0,
      closing_stock REAL DEFAULT 0,
      wastage REAL DEFAULT 0,
      wastage_reason TEXT DEFAULT '',
      counted_by INTEGER,
      verified_by INTEGER DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE,
      FOREIGN KEY (material_id) REFERENCES materials(id) ON DELETE CASCADE,
      FOREIGN KEY (counted_by) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (verified_by) REFERENCES users(id) ON DELETE SET NULL,
      UNIQUE(location_id, material_id, date)
    );

    CREATE INDEX IF NOT EXISTS idx_dsl_location_date ON daily_stock_logs(location_id, date);
  `);

  // ─── Phase 2: Stock Transfers ──────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS stock_transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_location_id INTEGER NOT NULL,
      to_location_id INTEGER NOT NULL,
      material_id INTEGER NOT NULL,
      quantity REAL NOT NULL,
      unit TEXT DEFAULT 'pieces',
      status TEXT DEFAULT 'initiated' CHECK(status IN ('initiated', 'in_transit', 'received', 'cancelled')),
      initiated_by INTEGER NOT NULL,
      received_by INTEGER DEFAULT NULL,
      notes TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (from_location_id) REFERENCES locations(id) ON DELETE CASCADE,
      FOREIGN KEY (to_location_id) REFERENCES locations(id) ON DELETE CASCADE,
      FOREIGN KEY (material_id) REFERENCES materials(id) ON DELETE CASCADE,
      FOREIGN KEY (initiated_by) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (received_by) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_st_from ON stock_transfers(from_location_id);
    CREATE INDEX IF NOT EXISTS idx_st_to ON stock_transfers(to_location_id);
    CREATE INDEX IF NOT EXISTS idx_st_status ON stock_transfers(status);
  `);

  // ─── Phase 3: Products ─────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sku TEXT UNIQUE,
      description TEXT DEFAULT '',
      type TEXT DEFAULT 'standard' CHECK(type IN ('standard', 'custom', 'made_to_order')),
      category TEXT DEFAULT NULL CHECK(category IN ('bouquet', 'arrangement', 'basket', 'single_stem', 'gift_combo', 'other')),
      selling_price REAL DEFAULT 0,
      estimated_cost REAL DEFAULT 0,
      tax_rate_id INTEGER DEFAULT NULL,
      location_id INTEGER DEFAULT NULL,
      image_url TEXT DEFAULT NULL,
      is_active INTEGER DEFAULT 1,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (tax_rate_id) REFERENCES tax_rates(id) ON DELETE SET NULL,
      FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE SET NULL,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
    CREATE INDEX IF NOT EXISTS idx_products_type ON products(type);
    CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
    CREATE INDEX IF NOT EXISTS idx_products_active ON products(is_active);
  `);

  // ─── Phase 3: Product Materials (Bill of Materials) ────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_materials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      material_id INTEGER NOT NULL,
      quantity REAL NOT NULL DEFAULT 1,
      cost_per_unit REAL DEFAULT 0,
      notes TEXT DEFAULT '',
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
      FOREIGN KEY (material_id) REFERENCES materials(id) ON DELETE CASCADE,
      UNIQUE(product_id, material_id)
    );

    CREATE INDEX IF NOT EXISTS idx_pm_product ON product_materials(product_id);
    CREATE INDEX IF NOT EXISTS idx_pm_material ON product_materials(material_id);
  `);

  // ─── Phase 3: Product Images ───────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      image_url TEXT NOT NULL,
      is_primary INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_pi_product ON product_images(product_id);
  `);

  // ─── Phase 4: Sales ─────────────────────────────────────────
  db.exec(`
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
      status TEXT NOT NULL DEFAULT 'completed' CHECK(status IN ('draft', 'completed', 'cancelled')),
      special_instructions TEXT DEFAULT '',
      customer_notes TEXT DEFAULT '',
      created_by INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE,
      FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (discount_approved_by) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sales_number ON sales(sale_number);
    CREATE INDEX IF NOT EXISTS idx_sales_location ON sales(location_id);
    CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(customer_id);
    CREATE INDEX IF NOT EXISTS idx_sales_status ON sales(payment_status);
    CREATE INDEX IF NOT EXISTS idx_sales_order_type ON sales(order_type);
    CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);
  `);

  // Add missing columns for existing databases
  const salesCols = db.prepare("PRAGMA table_info(sales)").all().map(c => c.name);
  if (!salesCols.includes('delivery_address')) {
    db.exec("ALTER TABLE sales ADD COLUMN delivery_address TEXT DEFAULT NULL");
  }
  if (!salesCols.includes('scheduled_date')) {
    db.exec("ALTER TABLE sales ADD COLUMN scheduled_date DATE DEFAULT NULL");
  }
  if (!salesCols.includes('scheduled_time')) {
    db.exec("ALTER TABLE sales ADD COLUMN scheduled_time TEXT DEFAULT NULL");
  }

  // Migrate sale_items: add material_id if missing
  const saleItemCols = db.prepare("PRAGMA table_info(sale_items)").all().map(c => c.name);
  if (!saleItemCols.includes('material_id')) {
    db.exec("ALTER TABLE sale_items ADD COLUMN material_id INTEGER DEFAULT NULL REFERENCES materials(id) ON DELETE CASCADE");
  }

  // ─── Phase 4: Sale Items ────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS sale_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_id INTEGER NOT NULL,
      product_id INTEGER DEFAULT NULL,
      material_id INTEGER DEFAULT NULL,
      product_name TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      unit_price REAL NOT NULL,
      tax_rate REAL NOT NULL DEFAULT 0,
      tax_amount REAL NOT NULL DEFAULT 0,
      discount_amount REAL DEFAULT 0,
      line_total REAL NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
      FOREIGN KEY (material_id) REFERENCES materials(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
    CREATE INDEX IF NOT EXISTS idx_sale_items_product ON sale_items(product_id);
  `);

  // ─── Phase 4: Payments ──────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_id INTEGER NOT NULL,
      method TEXT NOT NULL CHECK(method IN ('cash', 'card', 'upi')),
      amount REAL NOT NULL,
      reference_number TEXT DEFAULT NULL,
      received_by INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE,
      FOREIGN KEY (received_by) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_payments_sale ON payments(sale_id);
    CREATE INDEX IF NOT EXISTS idx_payments_method ON payments(method);
  `);

  // ─── Phase 4: Refunds ──────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS refunds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'requested' CHECK(status IN ('requested', 'approved', 'rejected', 'processed')),
      requested_by INTEGER NOT NULL,
      approved_by INTEGER DEFAULT NULL,
      refund_method TEXT NOT NULL CHECK(refund_method IN ('cash', 'card', 'upi', 'store_credit')),
      notes TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE,
      FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_refunds_sale ON refunds(sale_id);
    CREATE INDEX IF NOT EXISTS idx_refunds_status ON refunds(status);
  `);

  // ─── Phase 4: Cash Registers ────────────────────────────────
  db.exec(`
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
      FOREIGN KEY (closed_by) REFERENCES users(id) ON DELETE SET NULL,
      UNIQUE(location_id, date)
    );

    CREATE INDEX IF NOT EXISTS idx_cr_location_date ON cash_registers(location_id, date);
  `);

  // ─── Phase 4: Pre-Orders ───────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS pre_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_id INTEGER NOT NULL UNIQUE,
      scheduled_date DATE NOT NULL,
      scheduled_time TEXT DEFAULT NULL,
      advance_payment REAL NOT NULL DEFAULT 0,
      remaining_amount REAL NOT NULL DEFAULT 0,
      reminder_sent INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_pre_orders_scheduled ON pre_orders(scheduled_date);
  `);

  // ─── Expenses ───────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id INTEGER NOT NULL,
      category TEXT NOT NULL DEFAULT 'other' CHECK(category IN ('supplies', 'petty_cash', 'maintenance', 'transport', 'food', 'utilities', 'salary', 'other')),
      amount REAL NOT NULL,
      description TEXT DEFAULT '',
      payment_method TEXT NOT NULL DEFAULT 'cash' CHECK(payment_method IN ('cash', 'card', 'upi')),
      expense_date DATE NOT NULL,
      created_by INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_expenses_location ON expenses(location_id);
    CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);
    CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category);
  `);
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { getDb, closeDb };
