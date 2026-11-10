// Helper selling rules for POST /api/sales (spec 10.1-10.4, 10.6, 13).
//
// A helper sale is rebuilt here from the request before the normal sale code
// runs: a completed walk-in, sold by the helper, items from the catalog only,
// prices from the catalog (open-price products take the typed price), full
// payment in cash and/or UPI, and a discount within the helper limit or OKed
// by a counter/manager/owner code + PIN. Everything the client sends beyond
// that is dropped.
const jwt = require('jsonwebtoken');
const { getDb: getSyncDb } = require('../config/database');
const { verifyApprovalPin, approverMaxDiscountPct, APPROVER_ROLES } = require('./approval-pin');
const { normalizeDateFields } = require('./normalizeDates');
const { readCashMode } = require('./helper-bags');

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
  APPROVER_WRONG_SHOP: "That person doesn't work at this shop. Ask someone at the counter here.",
  UNFINISHED: "This sale didn't finish saving. Ask the counter to check it before you take payment again.",
  UNDONE: "This basket's sale was undone. Tap Take payment to sell it again.",
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
const { computeBill } = require('./gst');

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

// A repeat is only answered with the saved sale when that sale was paid in
// full; anything else needs a person to look at it before taking money again.
function isFullyPaid(sale) {
  if (!sale || sale.payment_status !== 'paid') return false;
  const paid = (sale.payments || []).reduce((s, p) => s + toPaise(p.amount), 0);
  return paid === toPaise(sale.grand_total);
}

function isUndone(sale) {
  return !!sale && (sale.status === 'cancelled' || !!sale.undone_at);
}

// Answer for a repeat of a basket that already has a sale. An undone sale is
// never answered as saved: the app gives the basket a new number and sells
// it again. Returns { status, body }.
function duplicateAnswer(saved) {
  if (isUndone(saved)) {
    return { status: 409, body: { success: false, code: 'SALE_UNDONE', message: MSG.UNDONE } };
  }
  if (!isFullyPaid(saved)) return { status: 409, body: { success: false, message: MSG.UNFINISHED } };
  return { status: 200, body: { success: true, duplicate: true, data: saved } };
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

  // One-off stock is compared with the whole basket's quantity of that product
  const qtyByProduct = new Map();
  for (const item of items) {
    const pid = Number(item && item.product_id);
    const q = Number(item && item.quantity);
    if (Number.isInteger(pid) && Number.isFinite(q)) qtyByProduct.set(pid, (qtyByProduct.get(pid) || 0) + q);
  }

  const lines = [];
  const billLines = [];
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
      if (have <= 0 || qtyByProduct.get(product.id) > have) fail(409, MSG.SOLD);
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

    billLines.push({ unitPrice, qty, taxRate });

    lines.push({
      product_id: product.id,
      product_name: name,
      quantity: qty,
      unit_price: unitPrice,
      fulfill_from_stock: true,
    });
  }

  // Discount and total: the same utils/gst.js maths POST /api/sales uses
  let discountType = null;
  let discountValue = null;
  const dv = Number(body.discount_value);
  if (body.discount_type && Number.isFinite(dv) && dv > 0) {
    if (!['percentage', 'fixed'].includes(body.discount_type)) fail(400, MSG.BAD_DISCOUNT);
    discountType = body.discount_type;
    discountValue = dv;
  }
  const bill = computeBill(billLines, discountType ? { type: discountType, value: discountValue } : null, null, { roundOff: false });
  if (bill.error) fail(400, MSG.BAD_DISCOUNT);
  // Same % POST /api/sales stores (a typed % is kept as typed)
  const discountPct = discountType === 'percentage' ? dv : (discountType ? Math.round(bill.discountPct * 100) / 100 : 0);
  const grandTotal = bill.payableP / 100;

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

  // Register mode: cash goes into the open register. Bag mode: the helper
  // keeps the cash (payments.held_by), so no register is needed (spec 10.6).
  const cashMode = await readCashMode(db);
  if (cashMode !== 'bag' && cleanPayments.some((p) => p.method === 'cash')) {
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
    cashMode,
  };
}

// Counter staff limit and helper limit (A2, 2026-11-07: 25 / 20 by default).
// A helper never gets more than counter staff, whatever the setting says.
const DEFAULT_COUNTER_LIMIT = 25;
const DEFAULT_HELPER_LIMIT = 20;
const LIMIT_KEYS = ['discount_helper_threshold', 'discount_manager_threshold', 'discount_owner_threshold'];
function helperLimitFrom(settings) {
  const num = (v, d) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : d);
  const counterLimit = num(settings.discount_manager_threshold, DEFAULT_COUNTER_LIMIT);
  return Math.min(num(settings.discount_helper_threshold, Math.min(DEFAULT_HELPER_LIMIT, counterLimit)), counterLimit);
}
async function helperDiscountLimit(db) {
  return helperLimitFrom(await readSettings(db, LIMIT_KEYS));
}

// A counter/manager/owner code + PIN whose own limit covers pct, at this
// shop (the owner anywhere). Returns the approver's id.
async function approverFor(db, { pct, code, pin, locationId, settings }) {
  // The approver must work at this shop (the owner anywhere). Checked before
  // the PIN so a wrong-shop approver does not use up a try. An unknown or
  // non-approver code falls through to verifyApprovalPin, which answers as usual.
  const placeholders = APPROVER_ROLES.map(() => '?').join(', ');
  const who = await db.prepare(
    `SELECT id, role, is_active FROM users WHERE employee_code = ? AND role IN (${placeholders})`
  ).get(String(code).trim(), ...APPROVER_ROLES);
  if (who && Number(who.is_active) && who.role !== 'owner') {
    const link = await db.prepare('SELECT 1 AS ok FROM user_locations WHERE user_id = ? AND location_id = ?').get(who.id, locationId);
    if (!link) fail(403, MSG.APPROVER_WRONG_SHOP);
  }

  const approver = await verifyApprovalPin(db, String(code), String(pin));
  if (approverMaxDiscountPct(approver.role, settings) + 1e-9 < pct) fail(403, MSG.NEEDS_MANAGER);
  return approver.id;
}

// A1 (2026-11-07): the counter approves the discount before the helper takes
// money. POST /api/sales/helper-discount-ok checks the code + PIN once and
// answers with this short-lived approval, tied to the helper, the shop, the
// basket number and the largest % approved. The sale then sends it instead
// of the PIN.
const APPROVAL_AUDIENCE = 'helper-discount-ok';
const APPROVAL_MINUTES = 15;
function signDiscountApproval({ approverId, helperId, locationId, clientRef, pct }) {
  return jwt.sign(
    { approver_id: approverId, helper_id: helperId, location_id: Number(locationId), client_ref: clientRef, pct },
    process.env.JWT_SECRET,
    { audience: APPROVAL_AUDIENCE, expiresIn: `${APPROVAL_MINUTES}m` }
  );
}
function readDiscountApproval(token) {
  try {
    return jwt.verify(String(token), process.env.JWT_SECRET, { audience: APPROVAL_AUDIENCE });
  } catch (_) {
    return null;
  }
}

// Within the helper limit: no approver. Over it: an approval from
// POST /helper-discount-ok for this helper, shop and basket covering the %,
// or (older app) a counter/manager/owner code + PIN sent with the sale. The
// PIN check reserves its try with its own committed write, so this runs
// before any sale transaction.
async function checkHelperDiscount(db, { pct, override, locationId, helperId, clientRef }) {
  if (!(pct > 0)) return { approvedBy: null };
  const settings = await readSettings(db, LIMIT_KEYS);
  if (pct <= helperLimitFrom(settings) + 1e-9) return { approvedBy: null };

  const o = override && typeof override === 'object' ? override : {};
  if (o.approval_token) {
    const ok = readDiscountApproval(o.approval_token);
    const fits = ok
      && Number(ok.helper_id) === Number(helperId)
      && Number(ok.location_id) === Number(locationId)
      && ok.client_ref === clientRef
      && pct <= Number(ok.pct) + 1e-9;
    if (!fits) fail(403, MSG.NEEDS_OK);
    const still = await db.prepare('SELECT is_active FROM users WHERE id = ?').get(ok.approver_id);
    if (!still || !Number(still.is_active)) fail(403, MSG.NEEDS_OK);
    return { approvedBy: Number(ok.approver_id) };
  }

  if (!o.employee_code || !o.pin) fail(403, MSG.NEEDS_OK);
  const approvedBy = await approverFor(db, { pct, code: o.employee_code, pin: o.pin, locationId, settings });
  return { approvedBy };
}

// POST /api/sales/helper-discount-ok body: { location_id, client_ref,
// discount_pct, employee_code, pin }. Answers { needed: false } when the %
// is within the helper limit, else { needed: true, approval_token, pct,
// expires_in_minutes } or a 403 with the reason (wrong PIN, wrong shop,
// needs a manager).
async function approveHelperDiscount(db, user, body) {
  const b = body || {};
  const clientRef = validClientRef(b.client_ref);
  if (!clientRef) fail(400, MSG.NO_CLIENT_REF);
  const locationId = parseInt(b.location_id, 10);
  if (!Number.isInteger(locationId)) fail(400, MSG.WRONG_SHOP);
  const link = await db.prepare('SELECT 1 AS ok FROM user_locations WHERE user_id = ? AND location_id = ?').get(user.id, locationId);
  if (!link) fail(403, MSG.WRONG_SHOP);
  const pct = Math.round(Number(b.discount_pct) * 100) / 100;
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) fail(400, MSG.BAD_DISCOUNT);

  const settings = await readSettings(db, LIMIT_KEYS);
  if (pct <= helperLimitFrom(settings) + 1e-9) return { needed: false };
  if (!b.employee_code || !b.pin) fail(400, 'Type the code and the 4-digit PIN.');
  const approverId = await approverFor(db, { pct, code: b.employee_code, pin: b.pin, locationId, settings });
  return {
    needed: true,
    pct,
    approval_token: signDiscountApproval({ approverId, helperId: user.id, locationId, clientRef, pct }),
    expires_in_minutes: APPROVAL_MINUTES,
  };
}

// Express middleware, placed before the POST /api/sales validators. Does
// nothing for other roles. For a helper: answers a repeat of a saved basket
// with that sale (200; 409 when it was undone or not fully paid), refuses anything outside the rules, else replaces
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
        const answer = duplicateAnswer(saleResponse(existingId));
        return res.status(answer.status).json(answer.body);
      }

      const normalized = await normalizeHelperSale(db, req.body || {}, req.user);
      const { approvedBy } = await checkHelperDiscount(db, {
        pct: normalized.discountPct,
        override: req.body && req.body.discount_override,
        locationId: normalized.body.location_id,
        helperId: req.user.id,
        clientRef,
      });

      req.body = normalized.body;
      req.helperSale = {
        clientRef,
        approvedBy,
        discountPct: normalized.discountPct,
        grandTotal: normalized.grandTotal,
        // Read once for this request; POST /api/sales uses it for held cash
        cashMode: normalized.cashMode,
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
  const answer = duplicateAnswer(saleResponse(row.id));
  res.status(answer.status).json(answer.body);
  return true;
}

module.exports = {
  helperSaleGate,
  normalizeHelperSale,
  checkHelperDiscount,
  approveHelperDiscount,
  helperDiscountLimit,
  answerClientRefConflict,
  isClientRefConflict,
  HELPER_SALE_MESSAGES: MSG,
};
