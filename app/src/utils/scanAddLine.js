// Pure helpers for Quick Checkout item lines: the shared "line from a
// product" builder (used by the product picker and by Scan) and the rule for
// where a scanned product goes. No React, no API; tested by
// scripts/test-scan-add.js.

export const blankLine = () => ({
  name: '',
  baseProduct: null, // optional: link to existing product
  tax_rate: null,
  tax_percentage: null,
  baseMaterial: null,
  materials: [],
  price: '',
  quantity: '1',
  special_instructions: '',
  image_url: '',
  fulfill_from_stock: false,
});

// Blank = nothing typed or picked yet: no name, no product, no price, quantity
// still the default.
export const isBlankLine = (line) => !!line
  && !String(line.name || '').trim()
  && !line.baseProduct
  && !String(line.price ?? '').trim()
  && ['', '1'].includes(String(line.quantity ?? '').trim());

// BOM rows from GET /products/:id/materials into the line's materials shape.
export const bomToLineMaterials = (rows) => (Array.isArray(rows) ? rows : []).map((m) => ({
  material_id: m.material_id,
  name: m.material_name || m.name,
  qty: String(m.quantity || 1),
}));

// Ready stock to decide fulfill_from_stock. Product-list rows carry ready_qty
// (already for the chosen location); a full GET /products/:id row carries a
// per-location stock array.
export const readyQtyFor = (product, locationId) => {
  if (!product) return 0;
  if (product.ready_qty != null || product.stock_quantity != null) {
    return Number(product.ready_qty || product.stock_quantity || 0);
  }
  if (Array.isArray(product.stock)) {
    if (locationId) {
      const row = product.stock.find((s) => Number(s.location_id) === Number(locationId));
      return row ? Number(row.quantity || 0) : 0;
    }
    if (product.total_ready_qty != null) return Number(product.total_ready_qty) || 0;
    return product.stock.reduce((sum, s) => sum + (Number(s.quantity) || 0), 0);
  }
  return 0;
};

// The fields a product sets on a line. `materials` is left out when null
// (picker fallback when the BOM could not be loaded keeps what was there).
export const productLineFields = (product, { materials = null, locationId = null } = {}) => {
  const fields = {
    name: product.name,
    baseProduct: product,
    tax_rate: product.tax_percentage ?? null,
    tax_percentage: product.tax_percentage ?? null,
    baseMaterial: null,
    price: String(product.selling_price || 0),
    fulfill_from_stock: readyQtyFor(product, locationId) > 0,
  };
  if (materials) fields.materials = materials;
  return fields;
};

// A whole new line for a scanned product. `option` ({id,label,price}) names
// the line "<product> (<label>)" at the option price; `price` (open-price
// products) overrides the price. option_label / option_id / scan_price_mode
// stay on the line only: the sale payload is built field by field and never
// sends them.
export const buildScannedLine = (product, { option = null, price = null, materials = [], locationId = null } = {}) => {
  const line = { ...blankLine(), ...productLineFields(product, { materials, locationId }) };
  if (option) {
    line.name = `${product.name} (${option.label})`;
    line.price = String(Number(option.price) || 0);
    line.option_label = option.label;
    line.option_id = option.id ?? null;
  } else if (price != null) {
    line.price = String(Number(price) || 0);
  }
  line.scan_price_mode = option ? 'option' : (price != null ? 'open' : 'fixed');
  line.is_one_off = Number(product.is_one_off) === 1 ? 1 : 0;
  return line;
};

const sameScannedThing = (a, b) => {
  if (!a || !b || !a.baseProduct || !b.baseProduct) return false;
  if (Number(a.baseProduct.id) !== Number(b.baseProduct.id)) return false;
  const aOpt = a.option_id ?? null;
  const bOpt = b.option_id ?? null;
  if (aOpt != null || bOpt != null) {
    if (aOpt == null || bOpt == null || Number(aOpt) !== Number(bOpt)) return false;
  } else if ((a.option_label || null) !== (b.option_label || null)) {
    return false;
  }
  // A typed (open) price only stacks onto a line at the same price.
  if (b.scan_price_mode === 'open' && Number(a.price) !== Number(b.price)) return false;
  return true;
};

// Where a scanned line goes.
//   - one-off product already in the order -> nothing changes (there is only one)
//   - newest line is the same product + option -> its quantity goes up by 1
//   - newest line is an empty blank line -> the scanned line replaces it
//   - otherwise -> appended (the cart keeps add order; the screen shows newest first)
// Returns { items, result: 'merged' | 'added' | 'already_in_order', index }.
export const mergeScannedLine = (items, line) => {
  const list = Array.isArray(items) ? items : [];
  if (line.is_one_off === 1) {
    const at = list.findIndex((it) => it.baseProduct && Number(it.baseProduct.id) === Number(line.baseProduct.id));
    if (at !== -1) return { items: list, result: 'already_in_order', index: at };
  }
  const lastIdx = list.length - 1;
  const last = lastIdx >= 0 ? list[lastIdx] : null;
  if (last && sameScannedThing(last, line)) {
    const qty = (parseInt(last.quantity, 10) || 1) + 1;
    const next = list.slice();
    next[lastIdx] = { ...last, quantity: String(qty) };
    return { items: next, result: 'merged', index: lastIdx };
  }
  if (last && isBlankLine(last)) {
    const next = list.slice();
    next[lastIdx] = line;
    return { items: next, result: 'added', index: lastIdx };
  }
  return { items: [...list, line], result: 'added', index: list.length };
};

// Price typed in the "Type the price" prompt -> number, or null when not > 0.
export const parseTypedPrice = (text) => {
  const s = String(text == null ? '' : text).replace(/[₹,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
};

export const formatRupees = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
