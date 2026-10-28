// The amount for one sale item. Production computes sale_items.line_total
// itself; older databases store 0 there (database.js gives the column a
// DEFAULT 0 because they never computed it). So when the stored value is 0
// but the item has a price, work it out from quantity × unit price + tax.
export function resolveItemLineTotal(item) {
  const qty = Number(item?.quantity) || 0;
  const unitPrice = Number(item?.unit_price) || 0;
  const base = qty * unitPrice;
  const taxFromField = Number(item?.tax_amount) || 0;
  const taxRate = Number(item?.tax_rate) || 0;
  const computedTax = taxFromField > 0 ? taxFromField : (base * taxRate / 100);
  const computed = base + computedTax;
  const stored = Number(item?.line_total);

  if (!Number.isFinite(stored) || (stored <= 0 && computed > 0)) return computed;
  return stored;
}
