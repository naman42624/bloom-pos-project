// Quick sale logic. Pure JS, no React Native imports, so it loads in plain node.

export const QUICK_LABELS = ['Fresh Flowers', 'Bouquet', 'Bunch', 'Box', 'Basket', 'Vase', 'Garland', 'Arrangement'];
export const MAX_QUICK_AMOUNT = 100000;
export const DEFAULT_QUICK_LABEL = 'Counter sale';
export const TOPUP_LABEL = 'Unrecorded sales (booked at close)';

const NEED_AMOUNT = 'Type the amount first';
const TOO_BIG = 'That looks too big — check the amount';

// Digits with optional decimals; commas and spaces are ignored. Returns NaN otherwise.
function parseAmount(text) {
  if (typeof text === 'number') return Number.isFinite(text) ? text : NaN;
  const cleaned = String(text == null ? '' : text).replace(/[,\s]/g, '');
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(cleaned)) return NaN;
  return Number(cleaned);
}

export function amountError(text) {
  const n = parseAmount(text);
  if (!Number.isFinite(n) || n <= 0) return NEED_AMOUNT;
  if (n > MAX_QUICK_AMOUNT) return TOO_BIG;
  return '';
}

export function buildQuickSalePayload({ locationId, method, amount, label, productId, entryMode = 'quick' }) {
  const value = Math.round(parseAmount(amount) * 100) / 100;
  // A product tile also sends fulfill_from_stock so the sale reduces stock.
  const item = productId
    ? { product_id: productId, quantity: 1, unit_price: value, fulfill_from_stock: true }
    : { product_name: label || DEFAULT_QUICK_LABEL, quantity: 1, unit_price: value };
  return {
    location_id: locationId,
    order_type: 'walk_in',
    channel: 'walk_in',
    entry_mode: entryMode,
    skip_assignment: true,
    items: [item],
    payments: [{ method, amount: value }],
  };
}

// Returns (key, now) => true when the tap should be accepted.
export function createTapGuard(windowMs = 700) {
  const last = {};
  return (key, now = Date.now()) => {
    if (last[key] !== undefined && now - last[key] < windowMs) return false;
    last[key] = now;
    return true;
  };
}

// Sends entries one at a time in tap order. sendFn(entry) resolves to the
// created sale (with id) or rejects. onChange(localId, { status, saleId, entry }).
export function createSequentialSender(sendFn, onChange) {
  const entries = {};
  const queue = [];
  let running = false;
  let nextId = 1;

  const emit = (id) => { if (onChange) onChange(id, { ...entries[id] }); };

  async function pump() {
    if (running) return;
    running = true;
    while (queue.length) {
      const id = queue.shift();
      const rec = entries[id];
      try {
        const res = await sendFn(rec.entry);
        rec.status = 'saved';
        rec.saleId = res && (res.id != null ? res.id : res.data && res.data.id);
      } catch (e) {
        rec.status = 'failed';
      }
      emit(id);
    }
    running = false;
  }

  return {
    enqueue(entry) {
      const id = nextId++;
      entries[id] = { entry, status: 'saving', saleId: null };
      queue.push(id);
      emit(id);
      pump();
      return id;
    },
    retry(id) {
      const rec = entries[id];
      if (!rec || rec.status !== 'failed') return;
      rec.status = 'saving';
      queue.push(id);
      emit(id);
      pump();
    },
  };
}
