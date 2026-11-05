// Shared by Produce → Print tag and the Quick tag screen.
// A tag is a normal product's label: made exactly 1 → the product is marked
// one-off (its tag reads "already sold" once it sells); made more → one
// label per piece and it stays a normal product.
import { buildLabelSheetHtml } from './labelSheetHtml';

export const QUICK_TAG_MAX = 48;

// Returns '' when the quick tag form can be saved, else what to fix.
export const quickTagProblem = ({ name, price, qty }) => {
  if (!String(name || '').trim()) return 'Type what the item is, for example "Red rose bunch".';
  const p = Number(String(price || '').replace(/,/g, ''));
  if (!Number.isFinite(p) || p <= 0) return 'Type the price (more than ₹0).';
  const n = parseInt(qty, 10);
  if (!Number.isInteger(n) || n < 1) return 'Pick how many tags (1 or more).';
  if (n > QUICK_TAG_MAX) return `You can make up to ${QUICK_TAG_MAX} tags at once.`;
  return '';
};

export const parsePrice = (price) => Math.round(Number(String(price || '').replace(/,/g, '')) * 100) / 100;

// deps = { api, printHtml } so this can be tested without a device.
export async function printProductTag(deps, { productId, qty, layout = 'bucket', showPrice = false, date = new Date(), retry = 'Print' }) {
  const { api, printHtml } = deps;
  const single = qty === 1;
  if (single) {
    try {
      await api.markProductOneOff(productId);
    } catch (e) {
      throw new Error(e?.status === 403
        ? (e.message || 'You cannot tag this item. Ask the owner.')
        : `Could not set up the tag. Check the connection and tap "${retry}" to try again.`);
    }
  }
  let rows = [];
  try {
    const res = await api.getLabels([productId]);
    rows = res?.data || [];
  } catch (e) {
    if (e && e.status === 409 && e.message) throw new Error(e.message);
    throw new Error(`Could not make the tag. Check the connection and tap "${retry}" to try again.`);
  }
  if (!rows.length) throw new Error(`This item could not be found. Refresh and tap "${retry}" to try again.`);
  const html = buildLabelSheetHtml({
    layout,
    items: rows.slice(0, 1).map((r) => ({ ...r, count: single ? 1 : qty })),
    showPrice,
    date,
  });
  await printHtml(html, single ? 'Tag' : 'Labels');
}
