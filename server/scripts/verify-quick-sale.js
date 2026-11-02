#!/usr/bin/env node
/**
 * Live verification of the Quick sale feature (entry_mode on sales and
 * everything built on it). Local dev only.
 *
 * Usage: VERIFY_OWNER_PHONE=... VERIFY_OWNER_PASSWORD=... node scripts/verify-quick-sale.js
 */
const h = require('./lib/verify-harness');
const { REGISTER_CLOSED_MESSAGE } = require('../utils/register-guard');

const { check, api, loginOwner, ensureClosed, openRegister, assert, getDb, TEST_LOCATION_ID } = h;

const INACTIVE_MESSAGE = "This item isn't sold any more — the buttons have been refreshed";

const createdSaleIds = [];
const createdProductIds = [];

async function makeTestProduct(name, price) {
  const db = await getDb();
  const r = await db.prepare('INSERT INTO products (name, selling_price, is_active) VALUES (?, ?, 1)').run(name, price);
  const id = r.lastInsertRowid;
  createdProductIds.push(id);
  return id;
}

// Builds the exact quick-entry shape: a one-item walk-in, fully paid, no
// production assignment.
async function quickSale(token, { amount, method, label, productId, entryMode = 'quick', fromStock = false }) {
  const item = { quantity: 1, unit_price: amount };
  if (productId) item.product_id = productId;
  else item.product_name = label || 'Quick sale';
  if (fromStock) item.fulfill_from_stock = true;
  const res = await api('POST', '/sales', token, {
    location_id: TEST_LOCATION_ID, order_type: 'walk_in', channel: 'walk_in',
    entry_mode: entryMode, skip_assignment: true,
    items: [item],
    payments: [{ method, amount }],
  });
  if (res.body?.data?.id) createdSaleIds.push(res.body.data.id);
  return res;
}

check('quick entry is stored as a completed walk-in with entry_mode quick', async () => {
  const owner = await loginOwner();
  await openRegister(owner.token, TEST_LOCATION_ID, 100);
  const { status, body } = await quickSale(owner.token, { amount: 200, method: 'cash', label: 'Bouquet' });
  assert(status === 201 || status === 200, `Expected 201, got ${status}: ${JSON.stringify(body)}`);
  const db = await getDb();
  const sale = await db.prepare('SELECT entry_mode, order_type, channel, status FROM sales WHERE id = ?').get(body.data.id);
  assert(sale.entry_mode === 'quick', `entry_mode: ${sale.entry_mode}`);
  assert(sale.order_type === 'walk_in' && sale.channel === 'walk_in', `order_type/channel: ${sale.order_type}/${sale.channel}`);
  assert(sale.status === 'completed', `status: ${sale.status}`);
  const items = await db.prepare('SELECT product_name, unit_price FROM sale_items WHERE sale_id = ?').all(body.data.id);
  assert(items.length === 1 && items[0].product_name === 'Bouquet' && Number(items[0].unit_price) === 200, `items: ${JSON.stringify(items)}`);
  const pays = await db.prepare('SELECT method, amount FROM payments WHERE sale_id = ?').all(body.data.id);
  assert(pays.length === 1 && pays[0].method === 'cash' && Number(pays[0].amount) === 200, `payments: ${JSON.stringify(pays)}`);
});

check('unknown entry_mode is stored as NULL', async () => {
  const owner = await loginOwner();
  await openRegister(owner.token, TEST_LOCATION_ID, 100);
  const { status, body } = await quickSale(owner.token, { amount: 50, method: 'cash', entryMode: 'banana' });
  assert(status === 201 || status === 200, `Expected saved, got ${status}: ${JSON.stringify(body)}`);
  const db = await getDb();
  const sale = await db.prepare('SELECT entry_mode FROM sales WHERE id = ?').get(body.data.id);
  assert(sale.entry_mode === null, `Expected NULL, got ${sale.entry_mode}`);
});

check('cash quick entry with closed register is refused', async () => {
  const owner = await loginOwner();
  await ensureClosed(owner.token, TEST_LOCATION_ID);
  const { status, body } = await quickSale(owner.token, { amount: 80, method: 'cash' });
  assert(status === 400, `Expected 400, got ${status}`);
  assert(body.message === REGISTER_CLOSED_MESSAGE, `Unexpected message: ${body.message}`);
});

check('UPI quick entry with closed register succeeds', async () => {
  const owner = await loginOwner();
  await ensureClosed(owner.token, TEST_LOCATION_ID);
  const { status, body } = await quickSale(owner.token, { amount: 90, method: 'upi' });
  assert(status === 201 || status === 200, `Expected success, got ${status}: ${JSON.stringify(body)}`);
});

check('quick entry for inactive product is refused', async () => {
  const owner = await loginOwner();
  const productId = await makeTestProduct('Test Quick Sale Inactive', 120);
  const db = await getDb();
  await db.prepare('UPDATE products SET is_active = 0 WHERE id = ?').run(productId);
  const { status, body } = await quickSale(owner.token, { amount: 120, method: 'upi', productId });
  assert(status === 400, `Expected 400, got ${status}: ${JSON.stringify(body)}`);
  assert(body.message === INACTIVE_MESSAGE, `Unexpected message: ${body.message}`);
});

check('cancel still restores product stock', async () => {
  const owner = await loginOwner();
  const productId = await makeTestProduct('Test Quick Sale Stocked', 75);
  const db = await getDb();
  await db.prepare('INSERT INTO product_stock (product_id, location_id, quantity) VALUES (?, ?, ?)').run(productId, TEST_LOCATION_ID, 10);
  const qty = async () => Number((await db.prepare('SELECT quantity FROM product_stock WHERE product_id = ? AND location_id = ?').get(productId, TEST_LOCATION_ID)).quantity);
  const created = await api('POST', '/sales', owner.token, {
    location_id: TEST_LOCATION_ID, order_type: 'walk_in', channel: 'walk_in',
    items: [{ product_id: productId, quantity: 2, unit_price: 75, fulfill_from_stock: true }],
  });
  assert(created.status === 200 || created.status === 201, `Create failed ${created.status}: ${JSON.stringify(created.body)}`);
  const saleId = created.body.data.id;
  createdSaleIds.push(saleId);
  assert(await qty() === 8, `Stock after sale should be 8, got ${await qty()}`);
  const cancelled = await api('PUT', `/sales/${saleId}/cancel`, owner.token, {});
  assert(cancelled.status === 200, `Cancel failed ${cancelled.status}: ${JSON.stringify(cancelled.body)}`);
  assert(await qty() === 10, `Stock after cancel should be 10, got ${await qty()}`);
  const sale = await db.prepare('SELECT status, stock_deducted FROM sales WHERE id = ?').get(saleId);
  assert(sale.status === 'cancelled' && Number(sale.stock_deducted) === 0, `sale: ${JSON.stringify(sale)}`);
});

const undo = (token, id) => api('POST', `/quick-sale/${id}/undo`, token, {});
const regRow = async (id) => {
  const db = await getDb();
  const r = await db.prepare('SELECT total_cash_sales, expected_cash, total_upi_sales FROM cash_registers WHERE id = ?').get(id);
  return { cash: Number(r.total_cash_sales), expected: Number(r.expected_cash), upi: Number(r.total_upi_sales) };
};

check('undo reverses register cash and excludes the sale at close', async () => {
  const owner = await loginOwner();
  const reg = await openRegister(owner.token, TEST_LOCATION_ID, 100);
  const base = await regRow(reg.id);
  const sale = await quickSale(owner.token, { amount: 300, method: 'cash' });
  const id = sale.body.data.id;
  assert((await regRow(reg.id)).expected === base.expected + 300, 'entry should add 300 to expected');
  const r = await undo(owner.token, id);
  assert(r.status === 200 && r.body.success && r.body.data.id === id && r.body.data.undone_at, `undo: ${r.status} ${JSON.stringify(r.body)}`);
  const after = await regRow(reg.id);
  assert(after.expected === base.expected && after.cash === base.cash, `register: ${JSON.stringify(after)} vs ${JSON.stringify(base)}`);
  const db = await getDb();
  const s = await db.prepare('SELECT status, undone_by, undone_at FROM sales WHERE id = ?').get(id);
  assert(s.status === 'cancelled' && s.undone_by === owner.id && s.undone_at, `sale: ${JSON.stringify(s)}`);
  const audit = await db.prepare("SELECT id FROM audit_logs WHERE entity_type = 'sale' AND entity_id = ? AND action = 'quick_sale_undo'").all(id);
  assert(audit.length === 1, `audit rows: ${audit.length}`);
  const closed = await h.closeRegisterWith(owner.token, TEST_LOCATION_ID, 100);
  assert(Number(closed.discrepancy) === 0, `discrepancy: ${JSON.stringify(closed)}`);
});

check('undo after method change reverses UPI not cash', async () => {
  const owner = await loginOwner();
  const reg = await openRegister(owner.token, TEST_LOCATION_ID, 100);
  const base = await regRow(reg.id);
  const sale = await quickSale(owner.token, { amount: 250, method: 'cash' });
  const id = sale.body.data.id;
  const put = await api('PUT', `/sales/${id}`, owner.token, { payments: [{ method: 'upi', amount: 250 }] });
  assert(put.status === 200, `method change: ${put.status} ${JSON.stringify(put.body)}`);
  const r = await undo(owner.token, id);
  assert(r.status === 200, `undo: ${r.status} ${JSON.stringify(r.body)}`);
  const after = await regRow(reg.id);
  assert(after.upi === base.upi && after.expected === base.expected && after.cash === base.cash, `register: ${JSON.stringify(after)} vs ${JSON.stringify(base)}`);
});

check('undo twice is refused', async () => {
  const owner = await loginOwner();
  await openRegister(owner.token, TEST_LOCATION_ID, 100);
  const sale = await quickSale(owner.token, { amount: 60, method: 'cash' });
  const id = sale.body.data.id;
  assert((await undo(owner.token, id)).status === 200, 'first undo should work');
  const r = await undo(owner.token, id);
  assert(r.status === 400 && r.body.message === 'Already undone', `second: ${r.status} ${JSON.stringify(r.body)}`);
});

check('undo of a normal sale is refused', async () => {
  const owner = await loginOwner();
  await openRegister(owner.token, TEST_LOCATION_ID, 100);
  const res = await api('POST', '/sales', owner.token, {
    location_id: TEST_LOCATION_ID, order_type: 'walk_in', channel: 'walk_in', skip_assignment: true,
    items: [{ product_name: 'Normal', quantity: 1, unit_price: 40 }], payments: [{ method: 'cash', amount: 40 }],
  });
  createdSaleIds.push(res.body.data.id);
  const r = await undo(owner.token, res.body.data.id);
  assert(r.status === 400 && r.body.message === "This sale isn't a quick sale entry", `got ${r.status} ${JSON.stringify(r.body)}`);
  const none = await undo(owner.token, 99999999);
  assert(none.status === 404 && none.body.message === 'Sale not found', `404: ${none.status}`);
});

check('undo from a closed session is refused', async () => {
  const owner = await loginOwner();
  await openRegister(owner.token, TEST_LOCATION_ID, 100);
  const sale = await quickSale(owner.token, { amount: 140, method: 'cash' });
  const id = sale.body.data.id;
  await ensureClosed(owner.token, TEST_LOCATION_ID);
  await openRegister(owner.token, TEST_LOCATION_ID, 100);
  const r = await undo(owner.token, id);
  assert(r.status === 409 && r.body.message === "This sale is from a register that's already closed. Use Refund on the sale instead.", `got ${r.status} ${JSON.stringify(r.body)}`);
  const db = await getDb();
  const s = await db.prepare('SELECT status FROM sales WHERE id = ?').get(id);
  assert(s.status !== 'cancelled', 'sale must not be cancelled');
});

check('UPI entry from a closed session can be undone without touching the new register', async () => {
  const owner = await loginOwner();
  await openRegister(owner.token, TEST_LOCATION_ID, 100);
  const sale = await quickSale(owner.token, { amount: 120, method: 'upi' });
  const id = sale.body.data.id;
  await ensureClosed(owner.token, TEST_LOCATION_ID);
  const reg = await openRegister(owner.token, TEST_LOCATION_ID, 100);
  const base = await regRow(reg.id);
  const r = await undo(owner.token, id);
  assert(r.status === 200, `undo: ${r.status} ${JSON.stringify(r.body)}`);
  const after = await regRow(reg.id);
  assert(after.upi === base.upi && after.expected === base.expected, `register changed: ${JSON.stringify(after)} vs ${JSON.stringify(base)}`);
});

check('undo restores product stock', async () => {
  const owner = await loginOwner();
  await openRegister(owner.token, TEST_LOCATION_ID, 100);
  const productId = await makeTestProduct('Test Quick Sale Undo Stock', 90);
  const db = await getDb();
  await db.prepare('INSERT INTO product_stock (product_id, location_id, quantity) VALUES (?, ?, ?)').run(productId, TEST_LOCATION_ID, 5);
  const qty = async () => Number((await db.prepare('SELECT quantity FROM product_stock WHERE product_id = ? AND location_id = ?').get(productId, TEST_LOCATION_ID)).quantity);
  const sale = await quickSale(owner.token, { amount: 90, method: 'cash', productId, fromStock: true });
  assert(sale.status === 200 || sale.status === 201, `sale: ${sale.status} ${JSON.stringify(sale.body)}`);
  assert(await qty() === 4, `stock after sale: ${await qty()}`);
  const r = await undo(owner.token, sale.body.data.id);
  assert(r.status === 200, `undo: ${r.status} ${JSON.stringify(r.body)}`);
  assert(await qty() === 5, `stock after undo: ${await qty()}`);
});

check('undo of a refunded sale is refused', async () => {
  const owner = await loginOwner();
  const reg = await openRegister(owner.token, TEST_LOCATION_ID, 100);
  const sale = await quickSale(owner.token, { amount: 200, method: 'cash' });
  const id = sale.body.data.id;
  const refund = await api('POST', `/sales/${id}/refund`, owner.token, { amount: 50, reason: 'verify', refund_method: 'cash' });
  assert(refund.status === 200 || refund.status === 201, `refund: ${refund.status} ${JSON.stringify(refund.body)}`);
  const before = await regRow(reg.id);
  const r = await undo(owner.token, id);
  assert(r.status === 409 && r.body.message === 'This sale already has a refund. Use Refund on the sale instead.', `got ${r.status} ${JSON.stringify(r.body)}`);
  const after = await regRow(reg.id);
  assert(JSON.stringify(after) === JSON.stringify(before), `register changed: ${JSON.stringify(after)} vs ${JSON.stringify(before)}`);
  const db = await getDb();
  const s = await db.prepare('SELECT status FROM sales WHERE id = ?').get(id);
  assert(s.status !== 'cancelled', 'sale must not be cancelled');
});

check('cash entry with no register open is refused', async () => {
  const owner = await loginOwner();
  await openRegister(owner.token, TEST_LOCATION_ID, 100);
  const sale = await quickSale(owner.token, { amount: 70, method: 'cash' });
  const id = sale.body.data.id;
  await ensureClosed(owner.token, TEST_LOCATION_ID);
  const r = await undo(owner.token, id);
  assert(r.status === 409 && r.body.message === "This sale is from a register that's already closed. Use Refund on the sale instead.", `got ${r.status} ${JSON.stringify(r.body)}`);
  const db = await getDb();
  const s = await db.prepare('SELECT status FROM sales WHERE id = ?').get(id);
  assert(s.status !== 'cancelled', 'sale must not be cancelled');
});

async function cleanup() {
  const db = await getDb();
  for (const id of createdSaleIds) {
    try {
      await db.prepare('DELETE FROM production_tasks WHERE sale_id = ?').run(id);
      await db.prepare('DELETE FROM deliveries WHERE sale_id = ?').run(id);
      await db.prepare('DELETE FROM refunds WHERE sale_id = ?').run(id);
      await db.prepare("DELETE FROM material_transactions WHERE reference_type = 'sale_cancel' AND reference_id = ?").run(id);
      await db.prepare('DELETE FROM payments WHERE sale_id = ?').run(id);
      await db.prepare('DELETE FROM sale_items WHERE sale_id = ?').run(id);
      await db.prepare("DELETE FROM audit_logs WHERE entity_type = 'sale' AND entity_id = ?").run(id);
      await db.prepare('DELETE FROM sales WHERE id = ?').run(id);
    } catch (err) {
      console.error(`   (cleanup warning: sale ${id}: ${err.message})`);
    }
  }
  for (const id of createdProductIds) {
    try {
      await db.prepare('DELETE FROM product_stock WHERE product_id = ?').run(id);
      await db.prepare('DELETE FROM products WHERE id = ?').run(id);
    } catch (err) {
      console.error(`   (cleanup warning: product ${id}: ${err.message})`);
    }
  }
  console.log(`Cleaned up ${createdSaleIds.length} test sale(s) and ${createdProductIds.length} test product(s)`);
}

h.run({ cleanup });
