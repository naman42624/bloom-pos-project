// Helper selling rules for POST /api/sales (spec 10.1-10.4, 10.6, 13).
//
// A helper sale is rebuilt here from the request before the normal sale code
// runs: a completed walk-in, sold by the helper, items from the catalog only,
// prices from the catalog (open-price products take the typed price), full
// payment in cash and/or UPI, and a discount within the helper limit or OKed
// by a counter/manager/owner code + PIN. Everything the client sends beyond
// that is dropped.
const { getDb: getSyncDb } = require('../config/database');
const { verifyApprovalPin, approverMaxDiscountPct } = require('./approval-pin');
const { normalizeDateFields } = require('./normalizeDates');

const MSG = {
  CUSTOM_ITEM: 'Helpers can only sell items from the catalog.',
  OFF: 'Not for sale right now — ask the counter.',
  SOLD: 'This one-off item is already sold. Check with the counter.',
  NEEDS_OK: "This discount needs the counter's OK.",
  NEEDS_MANAGER: 'This discount needs a manager or the owner.',
  REGISTER_CLOSED: "The counter hasn't opened the register yet. Ask them to open it, then try again.",
  CASH_OR_UPI: 'Take the full amount in cash or UPI.',
  PAYMENT_MISMATCH: "The payment doesn't match the total. Check the amounts and try again.",
  NO_CLIENT_REF: 'This sale is missing its basket number. Close the app, open it again and try again.',
  PICK_SIZE: (name) => `Pick a size for ${name}.`,
  OPEN_PRICE: (name) => `Type a price for ${name}.`,
  BAD_ITEMS: 'Add at least one item to the basket.',
  BAD_DISCOUNT: "The discount can't be more than the price.",
  WRONG_SHOP: "You can't sell for this shop. Ask the owner.",
};

const CLIENT_REF_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CLIENT_REF_INDEX = 'idx_sales_created_by_client_ref';

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  err.helperSale = true;
  throw err;
}

const toPaise = (n) => Math.round(Number(n) * 100);

async function readSettings(db, keys) {
  const placeholders = keys.map(() => '?').join(', ');
  const rows = await db.prepare(`SELECT key, value FROM settings WHERE key IN (${placeholders})`).all(...keys);
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

function validClientRef(raw) {
  const ref = typeof raw === 'string' ? raw.trim() : '';
  return CLIENT_REF_RE.test(ref) ? ref : null;
}

// Existing sale for (helper, client_ref), or null.
async function findByClientRef(db, userId, clientRef) {
  const row = await db.prepare('SELECT id FROM sales WHERE created_by = ? AND client_ref = ?').get(userId, clientRef);
  return row ? row.id : null;
}

// The same body a fresh create answers with, built with the same (sync)
// layer the create path uses so number and date types match exactly.
function saleResponse(saleId) {
  const db = getSyncDb();
  const sale = db.prepare(`
    SELECT s.*, l.name as location_name, u.name as created_by_name
    FROM sales s
    LEFT JOIN locations l ON s.location_id = l.id
    LEFT JOIN users u ON s.created_by = u.id
    WHERE s.id = ?
  `).get(saleId);
  if (!sale) return null;
  sale.items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id ASC').all(sale.id);
  sale.payments = db.prepare('SELECT * FROM payments WHERE sale_id = ?').all(sale.id);
  normalizeDateFields(sale);
  sale.items = sale.items.map(normalizeDateFields);
  sale.payments = sale.payments.map(normalizeDateFields);
  delete sale.vendor_name;
  return sale;
}

function isClientRefConflict(err) {
  if (!err) return false;
  if (err.code === '23505' && err.constraint === CLIENT_REF_INDEX) return true;
  return String(err.message || '').includes(CLIENT_REF_INDEX);
}

// Builds the helper sale body. Prices, tax and totals use exactly the same
// arithmetic as POST /api/sales, so the discount % and the payment check here
// match what that route then stores. Throws { status, message } on refusal.
async function normalizeHelperSale(db, body, user) {
  const locationId = Number(body.location_id);
  if (!Number.isInteger(locationId) || locationId <= 0) fail(400, 'Location is required');

  const link = await db.prepare('SELECT 1 AS ok FROM user_locations WHERE user_id = ? AND location_id = ?').get(user.id, locationId);
  if (!link) fail(403, MSG.WRONG_SHOP);

  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length === 0) fail(400, MSG.BAD_ITEMS);

  const lines = [];
  let subtotal = 0;
  let taxTotal = 0;
  for (const item of items) {
    if (!item || typeof item !== 'object') fail(400, MSG.BAD_ITEMS);
    const productId = Number(item.product_id);
    if (item.material_id || !Number.isInteger(productId) || productId <= 0) fail(400, MSG.CUSTOM_ITEM);
    const qty = Number(item.quantity);
    if (!Number.isInteger(qty) || qty < 1 || qty > 9999) fail(400, MSG.BAD_ITEMS);

    const product = await db.prepare(
      'SELECT id, name, selling_price, price_mode, is_one_off, is_active, tax_rate_id FROM products WHERE id = ?'
    ).get(productId);
    if (!product || !Number(product.is_active)) fail(409, MSG.OFF);

    if (Number(product.is_one_off) === 1) {
      const st = await db.prepare('SELECT quantity FROM product_stock WHERE product_id = ? AND location_id = ?').get(product.id, locationId);
      const have = st ? Number(st.quantity) : 0;
      if (have <= 0 || qty > have) fail(409, MSG.SOLD);
    }

    const options = await db.prepare(
      'SELECT id, label, price FROM product_options WHERE product_id = ? AND is_active = 1'
    ).all(product.id);

    let name = product.name;
    let unitPrice;
    if (options.length > 0 || (item.option_id != null && item.option_id !== '')) {
      const optionId = Number(item.option_id);
      const option = options.find((o) => Number(o.id) === optionId);
      if (!option) fail(400, MSG.PICK_SIZE(product.name));
      unitPrice = Number(option.price);
      name = `${product.name} (${option.label})`;
    } else if ((product.price_mode || 'fixed') === 'open') {
      const typed = Math.round(Number(item.unit_price) * 100) / 100;
      if (!Number.isFinite(typed) || typed <= 0) fail(400, MSG.OPEN_PRICE(product.name));
      unitPrice = typed;
    } else {
      unitPrice = Number(product.selling_price) || 0;
    }

    let taxRate = 0;
    if (product.tax_rate_id) {
      const tr = await db.prepare('SELECT percentage FROM tax_rates WHERE id = ?').get(product.tax_rate_id);
      if (tr) taxRate = Number(tr.percentage) || 0;
    }

    // Same as POST /api/sales: prices are tax-inclusive by default
    let taxableUnitPrice = Number(unitPrice) || 0;
    let taxAmount = 0;
    if (taxRate > 0) {
      const gross = taxableUnitPrice * qty;
      taxAmount = (gross * taxRate) / (100 + taxRate);
      taxableUnitPrice = taxableUnitPrice - (taxableUnitPrice * taxRate) / (100 + taxRate);
    }
    subtotal += taxableUnitPrice * qty;
    taxTotal += taxAmount;

    lines.push({
      product_id: product.id,
      product_name: name,
      quantity: qty,
      unit_price: unitPrice,
      fulfill_from_stock: true,
    });
  }

  // Discount: an amount (fixed) or a percent, measured against the subtotal
  let discountType = null;
  let discountValue = null;
  let discountAmount = 0;
  let discountPct = 0;
  const dv = Number(body.discount_value);
  if (body.discount_type && Number.isFinite(dv) && dv > 0) {
    if (body.discount_type === 'percentage') {
      if (dv > 100) fail(400, MSG.BAD_DISCOUNT);
      discountType = 'percentage';
      discountValue = dv;
      discountPct = dv;
      discountAmount = subtotal * dv / 100;
    } else if (body.discount_type === 'fixed') {
      if (dv > subtotal) fail(400, MSG.BAD_DISCOUNT);
      discountType = 'fixed';
      discountValue = dv;
      discountAmount = dv;
      discountPct = subtotal > 0 ? (dv / subtotal) * 100 : 0;
    } else {
      fail(400, MSG.BAD_DISCOUNT);
    }
  }

  const grandTotal = Math.round((Math.max(0, subtotal - discountAmount) + taxTotal) * 100) / 100;

  // Full payment now, cash and/or UPI only
  if (body.is_credit_sale) fail(400, MSG.CASH_OR_UPI);
  const payments = Array.isArray(body.payments) ? body.payments : [];
  if (payments.length === 0) fail(400, MSG.CASH_OR_UPI);
  const cleanPayments = [];
  let paidPaise = 0;
  for (const p of payments) {
    if (!p || !['cash', 'upi'].includes(p.method)) fail(400, MSG.CASH_OR_UPI);
    const paise = toPaise(p.amount);
    if (!Number.isFinite(paise) || paise <= 0) fail(400, MSG.PAYMENT_MISMATCH);
    paidPaise += paise;
    const ref = p.method === 'upi' && p.reference_number ? String(p.reference_number).trim().slice(0, 64) : null;
    cleanPayments.push({ method: p.method, amount: paise / 100, ...(ref ? { reference_number: ref } : {}) });
  }
  if (paidPaise !== toPaise(grandTotal)) fail(400, MSG.PAYMENT_MISMATCH);

  // Register mode: cash goes into the open register
  if (cleanPayments.some((p) => p.method === 'cash')) {
    const reg = await db.prepare('SELECT id FROM cash_registers WHERE location_id = ? AND closed_at IS NULL LIMIT 1').get(locationId);
    if (!reg) fail(400, MSG.REGISTER_CLOSED);
  }

  return {
    body: {
      location_id: locationId,
      order_type: 'walk_in',
      channel: 'walk_in',
      skip_assignment: true,
      items: lines,
      payments: cleanPayments,
      ...(discountType ? { discount_type: discountType, discount_value: discountValue } : {}),
    },
    discountPct,
    grandTotal,
  };
}

// Within the helper limit: no approver. Over it: a counter/manager/owner
// code + PIN whose own limit covers the discount. The PIN check reserves its
// try with its own committed write, so this runs before any sale transaction.
async function checkHelperDiscount(db, { pct, override }) {
  if (!(pct > 0)) return { approvedBy: null };
  const settings = await readSettings(db, ['discount_helper_threshold', 'discount_manager_threshold', 'discount_owner_threshold']);
  const rawLimit = settings.discount_helper_threshold ?? settings.discount_manager_threshold ?? '20';
  const limit = Number.isFinite(parseFloat(rawLimit)) ? parseFloat(rawLimit) : 20;
  if (pct <= limit + 1e-9) return { approvedBy: null };

  const code = override && typeof override === 'object' ? override.employee_code : null;
  const pin = override && typeof override === 'object' ? override.pin : null;
  if (!code || !pin) fail(403, MSG.NEEDS_OK);

  const approver = await verifyApprovalPin(db, String(code), String(pin));
  if (approverMaxDiscountPct(approver.role, settings) + 1e-9 < pct) fail(403, MSG.NEEDS_MANAGER);
  return { approvedBy: approver.id };
}

// Express middleware, placed before the POST /api/sales validators. Does
// nothing for other roles. For a helper: answers a repeat of a saved basket
// with that sale (200), refuses anything outside the rules, else replaces
// req.body with the clean helper sale and sets req.helperSale.
function helperSaleGate(getAsyncDb) {
  return async (req, res, next) => {
    if (!req.user || req.user.role !== 'helper') return next();
    try {
      const clientRef = validClientRef(req.body && req.body.client_ref);
      if (!clientRef) return res.status(400).json({ success: false, message: MSG.NO_CLIENT_REF });

      const db = await getAsyncDb();
      const existingId = await findByClientRef(db, req.user.id, clientRef);
      if (existingId) {
        return res.status(200).json({ success: true, duplicate: true, data: saleResponse(existingId) });
      }

      const normalized = await normalizeHelperSale(db, req.body || {}, req.user);
      const { approvedBy } = await checkHelperDiscount(db, {
        pct: normalized.discountPct,
        override: req.body && req.body.discount_override,
      });

      req.body = normalized.body;
      req.helperSale = {
        clientRef,
        approvedBy,
        discountPct: normalized.discountPct,
        grandTotal: normalized.grandTotal,
      };
      return next();
    } catch (err) {
      if (err.helperSale || err.pinCheck) {
        return res.status(err.status).json({ success: false, message: err.message });
      }
      return next(err);
    }
  };
}

// For the create path: if the INSERT lost a race on (helper, client_ref),
// answer with the sale that won. Returns true when it answered.
function answerClientRefConflict(req, res, err) {
  if (!req.helperSale || !isClientRefConflict(err)) return false;
  const db = getSyncDb();
  const row = db.prepare('SELECT id FROM sales WHERE created_by = ? AND client_ref = ?').get(req.user.id, req.helperSale.clientRef);
  if (!row) return false;
  console.log(`Helper sale: two first tries of one basket; answered with sale ${row.id}`);
  res.status(200).json({ success: true, duplicate: true, data: saleResponse(row.id) });
  return true;
}

module.exports = {
  helperSaleGate,
  normalizeHelperSale,
  checkHelperDiscount,
  answerClientRefConflict,
  isClientRefConflict,
  HELPER_SALE_MESSAGES: MSG,
};
