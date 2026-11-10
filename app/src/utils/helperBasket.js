// The helper's basket (Sell screen, spec §9). Pure: no React, no storage, so
// plain node can test it (app/scripts/test-helper-basket.js).
//
// A basket is an array of lines, newest first:
//   { key, product_id, option_id, name, unit_price, price_mode, tax_rate, qty }
// tax_rate is the product's tax % (null while it is not known yet).
//
// Money maths: utils/gst.js, the same file the server uses for a helper sale
// (server/utils/helper-sale.js). Prices include GST and the discount comes off
// that price (10% off ₹1000 is ₹900, whatever the GST). Helper sales are never
// rounded to the rupee. The helper pays exactly this total and the server
// refuses a payment a paisa off, so the two must agree.

import { computeBill } from './gst';

const MAX_QTY = 9999;
export const DISCOUNT_TOO_BIG = "The discount can't be more than the price.";

const round2 = (n) => Math.round(n * 100) / 100;

// "1,250.50" / " 500 " / 500 -> number, or null when it is not an amount.
export function parseAmount(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const s = String(raw == null ? '' : raw).replace(/[₹,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Number(s);
}

const lineKey = ({ product_id, option_id, unit_price }) => (
  `${product_id}:${option_id == null ? '' : option_id}:${round2(Number(unit_price) || 0)}`
);

// Adds one piece. The same product + size + price goes onto its existing line.
export function addLine(basket, { product_id, option_id = null, name, unit_price, price_mode = 'fixed', tax_rate = null }) {
  const list = Array.isArray(basket) ? basket : [];
  const line = {
    product_id,
    option_id: option_id == null ? null : option_id,
    name,
    unit_price: round2(Number(unit_price) || 0),
    price_mode: price_mode || 'fixed',
    tax_rate: tax_rate == null || tax_rate === '' ? null : Number(tax_rate),
  };
  const key = lineKey(line);
  const at = list.findIndex((l) => l.key === key);
  if (at >= 0) {
    return list.map((l, i) => (i === at ? { ...l, qty: Math.min(MAX_QTY, l.qty + 1) } : l));
  }
  return [{ key, ...line, qty: 1 }, ...list];
}

// +/- on a line; at 0 the line goes.
export function changeQty(basket, key, delta) {
  const list = Array.isArray(basket) ? basket : [];
  if (!list.some((l) => l.key === key)) return list;
  return list
    .map((l) => (l.key === key ? { ...l, qty: Math.min(MAX_QTY, l.qty + Number(delta || 0)) } : l))
    .filter((l) => l.qty > 0);
}

// Fills in tax % for a product's lines once it has been loaded.
export function setTaxRate(basket, productId, taxRate) {
  const rate = Number(taxRate) || 0;
  return (basket || []).map((l) => (l.product_id === productId && l.tax_rate == null ? { ...l, tax_rate: rate } : l));
}

export const basketCount = (basket) => (basket || []).reduce((s, l) => s + l.qty, 0);
export const taxesKnown = (basket) => (basket || []).every((l) => l.tax_rate != null);

// discount: null | { type: 'fixed' | 'percentage', value }
// -> { subtotal (what the items add up to), discount (₹ off), total (to pay), error }
export function basketTotal(basket, discount) {
  const list = Array.isArray(basket) ? basket : [];
  const bill = computeBill(
    list.map((l) => ({ unitPrice: Number(l.unit_price) || 0, qty: l.qty, taxRate: Number(l.tax_rate) || 0 })),
    discount && Number(discount.value) > 0 ? { type: discount.type, value: Number(discount.value) } : null,
    null,
    { roundOff: false }
  );
  if (bill.error) {
    return { subtotal: bill.itemsGross, discount: 0, total: round2(bill.itemsGross), error: DISCOUNT_TOO_BIG };
  }
  return {
    subtotal: bill.itemsGross,
    discount: bill.discount,
    total: bill.payable,
    error: null,
  };
}

// The POST /api/sales body for a helper sale.
export function toSalePayload(basket, { locationId, payments, discount, override, clientRef }) {
  const items = (basket || []).map((l) => {
    const item = { product_id: l.product_id };
    if (l.option_id != null) item.option_id = l.option_id;
    item.quantity = l.qty;
    if (l.price_mode === 'open' && l.option_id == null) item.unit_price = l.unit_price;
    return item;
  });
  const body = {
    location_id: locationId,
    client_ref: clientRef,
    items,
    payments: (payments || []).map((p) => {
      const out = { method: p.method, amount: round2(Number(p.amount) || 0) };
      const ref = String(p.reference_number || p.reference || '').trim();
      if (p.method === 'upi' && ref) out.reference_number = ref;
      return out;
    }),
  };
  if (discount && Number(discount.value) > 0) {
    body.discount_type = discount.type;
    body.discount_value = Number(discount.value);
  }
  if (override && override.employee_code && override.pin) {
    body.discount_override = { employee_code: String(override.employee_code), pin: String(override.pin) };
  }
  return body;
}

// A repeat of this basket's client_ref came back as an earlier saved sale.
// Compare by product + size (the saved line name) + quantity.
//   same     -> the saved sale is exactly this basket
//   leftover -> basket lines (or extra pieces) the saved sale does not have
export function compareSaved(basket, saleItems) {
  const keyOf = (productId, name) => `${Number(productId)}|${String(name || '').trim()}`;
  const remaining = new Map();
  for (const i of saleItems || []) {
    const k = keyOf(i.product_id, i.product_name);
    remaining.set(k, (remaining.get(k) || 0) + (Number(i.quantity) || 0));
  }
  const leftover = [];
  for (const l of basket || []) {
    const k = keyOf(l.product_id, l.name);
    const have = remaining.get(k) || 0;
    const take = Math.min(l.qty, have);
    if (have) remaining.set(k, have - take);
    if (l.qty - take > 0) leftover.push({ ...l, qty: l.qty - take });
  }
  const savedExtra = [...remaining.values()].some((q) => q > 0);
  return { same: leftover.length === 0 && !savedExtra, leftover };
}

const taxPct = (p) => (p && p.tax_percentage != null && p.tax_percentage !== '' ? Number(p.tax_percentage) || 0 : 0);

// A line whose product changed how it is priced (sizes added, typed price
// switched on, its size removed) cannot be re-priced here: it must be picked
// again so the helper chooses the size or types the price.
export const repickText = (name) => `Scan or pick ${name} again — its price has changed.`;

// Brings basket prices up to date from freshly loaded products.
// productsById[id]: the product, null when it is gone / not for sale,
// undefined when it could not be loaded (the line is left as it was).
// The product's current price_mode decides: fixed -> catalog price, open ->
// the typed price is kept (a line that had no typed price must be picked
// again), sizes -> the size's price. Blocked lines get unavailable: true,
// and repick: true + blocked_text when they only need picking again.
// -> { basket, changes: [{ name, price }], blocked: [key] }
export function refreshPrices(basket, productsById) {
  const changes = [];
  const updated = (basket || []).map((l) => {
    const p = productsById ? productsById[l.product_id] : undefined;
    if (p === undefined) return l;
    const { unavailable, repick, blocked_text: blockedText, ...base } = l;
    if (p === null) return { ...base, unavailable: true };
    const mode = p.price_mode || 'fixed';
    const options = Array.isArray(p.options) ? p.options : [];
    const again = () => ({ ...base, price_mode: mode, unavailable: true, repick: true, blocked_text: repickText(l.name) });
    let price;
    if (l.option_id != null) {
      const opt = options.find((o) => Number(o.id) === Number(l.option_id));
      if (!opt) return again();
      price = Number(opt.price) || 0;
    } else if (options.length > 0) {
      return again();
    } else if (mode === 'open') {
      if (l.price_mode !== 'open') return again();
      price = l.unit_price;
    } else {
      price = Number(p.selling_price) || 0;
    }
    price = round2(price);
    if (price !== l.unit_price && !changes.some((c) => c.name === l.name)) changes.push({ name: l.name, price });
    return { ...base, unit_price: price, price_mode: mode, tax_rate: taxPct(p) };
  });
  // Re-key, and merge lines that now have the same product + size + price
  const merged = [];
  for (const l of updated) {
    const key = l.unavailable ? l.key : lineKey(l);
    const same = !l.unavailable && merged.find((m) => !m.unavailable && m.key === key);
    if (same) same.qty = Math.min(MAX_QTY, same.qty + l.qty);
    else merged.push({ ...l, key });
  }
  return { basket: merged, changes, blocked: merged.filter((l) => l.unavailable).map((l) => l.key) };
}

// "Customer gave ₹1000" on ₹800 -> 200 to give back. Negative = they gave too
// little. null when nothing (or not a number) was typed.
export function changeDue(total, given) {
  const g = parseAmount(given);
  if (g == null) return null;
  return round2(g - Number(total || 0));
}

// Part cash, part UPI: the typed cash, the rest by UPI.
export function splitPayments(total, cashText) {
  const cash = parseAmount(cashText);
  const t = round2(Number(total) || 0);
  if (cash == null || cash <= 0) return { error: 'Type how much the customer pays in cash.', payments: null };
  if (cash >= t) return { error: 'That is the whole amount. Tap Back and choose Cash.', payments: null };
  return { error: null, payments: [{ method: 'cash', amount: round2(cash) }, { method: 'upi', amount: round2(t - cash) }] };
}

// Hidden amount (spec §12): keep the first digit and the digit grouping, the
// rest becomes x. Under ₹100 every digit is x.
export function maskAmount(amount) {
  const whole = Math.max(0, Math.floor(Number(amount) || 0));
  const grouped = whole.toLocaleString('en-IN');
  if (whole < 100) return `₹${String(whole).replace(/\d/g, 'x')}`;
  let first = true;
  return `₹${grouped.replace(/\d/g, (d) => {
    if (first) { first = false; return d; }
    return 'x';
  })}`;
}

// One per basket, kept across retries until the sale is saved, so a retry
// after a dropped answer never makes a second sale (server: sales.client_ref).
export function newClientRef() {
  let rand = '';
  try {
    const bytes = new Uint8Array(12);
    globalThis.crypto.getRandomValues(bytes);
    rand = Array.from(bytes, (x) => x.toString(16).padStart(2, '0')).join('');
  } catch (e) {
    for (let i = 0; i < 24; i += 1) rand += Math.floor(Math.random() * 16).toString(16);
  }
  return `hb_${Date.now().toString(36)}_${rand}`;
}
