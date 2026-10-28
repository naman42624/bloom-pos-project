// Shared load checklist for delivery and pickup orders (spec
// 2026-10-28-slip-qr-open-orders-checkout-design.md §3.3). One implementation
// behind three callers: the in-app delivery checklist
// (PUT /deliveries/:id/checklist/:saleItemId), the in-app pickup checklist
// (/sales/:id/pickup-checks) and the public slip QR page (/api/slip/:token).
//
// Which table: the sale's CURRENT order type decides. A converted order
// follows its new type; rows written under the old type stay as history.
//   delivery  -> delivery_load_checks, keyed by the sale's deliveries row
//   pickup    -> pickup_load_checks, keyed by sale
//   pre_order -> delivery when it has a deliveries row that is not
//                cancelled, otherwise pickup
//   walk_in   -> no checklist (enabled: false)
//
// Rows are created lazily, one per sale_item, the first time the checklist
// is read or written, so an item added later still shows up.

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Returns { kind, enabled, deliveryId, final, finalMessage }.
// `sale` needs id, order_type, status and pickup_status.
// opts.deliveryId pins the target to that deliveries row (the in-app
// delivery checklist route works on one specific delivery).
async function resolveTarget(db, sale, opts = {}) {
  if (opts.deliveryId) {
    const d = await db.prepare('SELECT id, status FROM deliveries WHERE id = ? AND sale_id = ?').get(opts.deliveryId, sale.id);
    if (!d) throw httpError(404, 'Delivery not found');
    return withFinal(sale, { kind: 'delivery', enabled: true, deliveryId: d.id, deliveryStatus: d.status });
  }

  if (sale.order_type === 'walk_in') {
    return { kind: null, enabled: false, deliveryId: null, final: true, finalMessage: 'This order has no load checklist' };
  }

  const d = await db.prepare('SELECT id, status FROM deliveries WHERE sale_id = ? ORDER BY id DESC LIMIT 1').get(sale.id);

  if (sale.order_type === 'delivery') {
    if (!d) return { kind: 'delivery', enabled: false, deliveryId: null, final: true, finalMessage: 'This order has no load checklist' };
    return withFinal(sale, { kind: 'delivery', enabled: true, deliveryId: d.id, deliveryStatus: d.status });
  }

  if (sale.order_type === 'pre_order' && d && d.status !== 'cancelled') {
    return withFinal(sale, { kind: 'delivery', enabled: true, deliveryId: d.id, deliveryStatus: d.status });
  }

  // pickup, or a pre_order fulfilled by pickup
  return withFinal(sale, { kind: 'pickup', enabled: true, deliveryId: null });
}

function withFinal(sale, target) {
  let finalMessage = null;
  if (sale.status === 'cancelled') finalMessage = 'This order was cancelled';
  else if (target.kind === 'delivery' && target.deliveryStatus === 'delivered') finalMessage = 'This order is already delivered';
  else if (target.kind === 'delivery' && target.deliveryStatus === 'cancelled') finalMessage = 'This delivery was cancelled';
  else if (target.kind === 'pickup' && sale.pickup_status === 'picked_up') finalMessage = 'This order has already been picked up';
  return { kind: target.kind, enabled: target.enabled, deliveryId: target.deliveryId, final: !!finalMessage, finalMessage };
}

async function ensureRows(db, sale, target) {
  const items = await db.prepare('SELECT id FROM sale_items WHERE sale_id = ? ORDER BY id ASC').all(sale.id);
  for (const item of items) {
    if (target.kind === 'delivery') {
      await db.prepare(
        'INSERT INTO delivery_load_checks (delivery_id, sale_item_id) VALUES (?, ?) ON CONFLICT (delivery_id, sale_item_id) DO NOTHING'
      ).run(target.deliveryId, item.id);
    } else {
      await db.prepare(
        'INSERT INTO pickup_load_checks (sale_id, sale_item_id) VALUES (?, ?) ON CONFLICT (sale_id, sale_item_id) DO NOTHING'
      ).run(sale.id, item.id);
    }
  }
}

async function readItems(db, sale, target) {
  const rows = target.kind === 'delivery'
    ? await db.prepare(`
        SELECT dlc.sale_item_id, dlc.checked, dlc.checked_at
        FROM delivery_load_checks dlc
        JOIN sale_items si ON si.id = dlc.sale_item_id AND si.sale_id = ?
        WHERE dlc.delivery_id = ?
        ORDER BY si.id ASC
      `).all(sale.id, target.deliveryId)
    : await db.prepare(`
        SELECT plc.sale_item_id, plc.checked, plc.checked_at
        FROM pickup_load_checks plc
        JOIN sale_items si ON si.id = plc.sale_item_id
        WHERE plc.sale_id = ?
        ORDER BY si.id ASC
      `).all(sale.id);
  return rows.map((r) => ({ sale_item_id: r.sale_item_id, checked: r.checked === true, checked_at: r.checked_at || null }));
}

// -> { enabled, kind, items: [{ sale_item_id, checked, checked_at }] }
async function getChecklistForSale(db, sale, opts = {}) {
  const target = await resolveTarget(db, sale, opts);
  if (!target.enabled) return { enabled: false, kind: target.kind, items: [] };
  await ensureRows(db, sale, target);
  return { enabled: true, kind: target.kind, items: await readItems(db, sale, target) };
}

// Ticks or unticks one item. Throws an Error with .status 404 when the item
// is not on this sale, 409 (plain .message) when the checklist is final or
// does not exist for this order. opts: { userId, via, deliveryId, expectKind }.
async function setCheck(db, sale, saleItemId, checked, opts = {}) {
  const item = await db.prepare('SELECT id FROM sale_items WHERE id = ? AND sale_id = ?').get(saleItemId, sale.id);
  if (!item) throw httpError(404, 'That item is not on this order');

  const target = await resolveTarget(db, sale, opts);
  if (opts.expectKind && target.kind !== opts.expectKind) {
    throw httpError(409, opts.expectKind === 'pickup' ? 'This order is not a pickup order any more' : 'This order is not a delivery order any more');
  }
  if (!target.enabled || target.final) throw httpError(409, target.finalMessage || 'This order has no load checklist');

  await ensureRows(db, sale, target);
  const isChecked = checked === true;
  const userId = opts.userId || null;
  const via = opts.via || 'app';
  if (target.kind === 'delivery') {
    await db.prepare(
      `UPDATE delivery_load_checks
       SET checked = ?, checked_by = ?, checked_via = ?, checked_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END
       WHERE delivery_id = ? AND sale_item_id = ?`
    ).run(isChecked, userId, via, isChecked, target.deliveryId, item.id);
  } else {
    await db.prepare(
      `UPDATE pickup_load_checks
       SET checked = ?, checked_by = ?, checked_via = ?, checked_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END
       WHERE sale_id = ? AND sale_item_id = ?`
    ).run(isChecked, userId, via, isChecked, sale.id, item.id);
  }
  return { enabled: true, kind: target.kind, items: await readItems(db, sale, target) };
}

// Loads just the sale fields the helpers above need.
async function loadSaleForChecks(db, saleId) {
  return db.prepare('SELECT id, order_type, status, pickup_status FROM sales WHERE id = ?').get(saleId);
}

module.exports = { getChecklistForSale, setCheck, loadSaleForChecks };
