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

const roll = (token) => api('GET', `/quick-sale/roll?location_id=${TEST_LOCATION_ID}`, token);
const tilesGet = (token) => api('GET', `/quick-sale/tiles?location_id=${TEST_LOCATION_ID}`, token);

check('roll lists this session entries newest first with totals', async () => {
  const owner = await loginOwner();
  await ensureClosed(owner.token, TEST_LOCATION_ID);
  await openRegister(owner.token, TEST_LOCATION_ID, 100);
  await quickSale(owner.token, { amount: 200, method: 'cash', label: 'Roll A' });
  await quickSale(owner.token, { amount: 150, method: 'upi', label: 'Roll B' });
  const c = await quickSale(owner.token, { amount: 50, method: 'cash', label: 'Roll C' });
  assert((await undo(owner.token, c.body.data.id)).status === 200, 'undo should work');
  const r = await roll(owner.token);
  assert(r.status === 200 && r.body.success, `roll: ${r.status} ${JSON.stringify(r.body)}`);
  const d = r.body.data;
  assert(d.register_open === true && d.session_start, `open/start: ${JSON.stringify(d)}`);
  assert(d.entries.length === 3, `entries: ${d.entries.length}`);
  assert(d.entries.map((e) => e.item_name).join() === 'Roll C,Roll B,Roll A', `order: ${d.entries.map((e) => e.item_name)}`);
  assert(d.entries[0].undone === true && d.entries[1].undone === false, 'undone flags');
  assert(d.entries[1].method === 'upi' && d.entries[1].amount === 150 && d.entries[1].entry_mode === 'quick' && d.entries[1].created_by_name, `entry: ${JSON.stringify(d.entries[1])}`);
  assert(d.totals.cash === 200 && d.totals.upi === 150 && d.totals.count === 2, `totals: ${JSON.stringify(d.totals)}`);
});

check('roll ignores entries from before the session', async () => {
  const owner = await loginOwner();
  await openRegister(owner.token, TEST_LOCATION_ID, 100);
  await quickSale(owner.token, { amount: 20, method: 'cash', label: 'Old session' });
  await ensureClosed(owner.token, TEST_LOCATION_ID);
  await openRegister(owner.token, TEST_LOCATION_ID, 100);
  const r = await roll(owner.token);
  assert(r.status === 200 && r.body.data.entries.length === 0, `entries: ${JSON.stringify(r.body.data)}`);
  assert(r.body.data.totals.count === 0 && r.body.data.totals.cash === 0, `totals: ${JSON.stringify(r.body.data.totals)}`);
});

let tilesSettingBackup; // undefined = not captured, null = was absent
async function backupTilesSetting() {
  if (tilesSettingBackup !== undefined) return;
  const db = await getDb();
  tilesSettingBackup = (await db.prepare("SELECT * FROM settings WHERE key = 'quick_sale_tiles'").get()) || null;
}

check('tiles fall back to suggested when the setting is empty', async () => {
  const owner = await loginOwner();
  await backupTilesSetting();
  const db = await getDb();
  await db.prepare("UPDATE settings SET value = '' WHERE key = 'quick_sale_tiles'").run();
  const r = await tilesGet(owner.token);
  assert(r.status === 200 && r.body.success, `tiles: ${r.status} ${JSON.stringify(r.body)}`);
  assert(r.body.data.source === 'suggested' && Array.isArray(r.body.data.tiles) && r.body.data.tiles.length <= 12, `got ${JSON.stringify(r.body.data)}`);
  for (const t of r.body.data.tiles) assert(t.type === 'product' && t.product_id && t.key === `p${t.product_id}`, `tile: ${JSON.stringify(t)}`);
});

check('owner tiles resolve current price and drop inactive products', async () => {
  const owner = await loginOwner();
  await backupTilesSetting();
  const db = await getDb();
  const active = await makeTestProduct('Test Tile Active', 111);
  const inactive = await makeTestProduct('Test Tile Inactive', 222);
  await db.prepare('UPDATE products SET is_active = 0 WHERE id = ?').run(inactive);
  const value = JSON.stringify([
    { type: 'product', product_id: active }, { type: 'product', product_id: inactive },
    { type: 'label', label: 'Bouquet', price: 300 }, { type: 'label', label: 'Free', price: 0 },
  ]);
  const put = await api('PUT', '/settings', owner.token, { settings: { quick_sale_tiles: value } });
  assert(put.status === 200, `put: ${put.status} ${JSON.stringify(put.body)}`);
  await db.prepare('UPDATE products SET selling_price = 135 WHERE id = ?').run(active);
  const r = await tilesGet(owner.token);
  const d = r.body.data;
  assert(d.source === 'owner' && d.tiles.length === 2, `got ${JSON.stringify(d)}`);
  assert(d.tiles[0].key === `p${active}` && d.tiles[0].label === 'Test Tile Active' && d.tiles[0].price === 135, `tile0: ${JSON.stringify(d.tiles[0])}`);
  assert(d.tiles[1].key === 'l2' && d.tiles[1].type === 'label' && d.tiles[1].product_id === null && d.tiles[1].price === 300, `tile1: ${JSON.stringify(d.tiles[1])}`);
});

check('preview writes nothing but the count lock', async () => {
  const owner = await loginOwner();
  const reg = await openRegister(owner.token, TEST_LOCATION_ID, 100);
  const sale = await quickSale(owner.token, { amount: 200, method: 'cash', label: 'Preview probe' });
  assert(sale.status === 201, `sale ${sale.status}`);
  const db = await getDb();
  const before = await db.prepare('SELECT * FROM cash_registers WHERE id = ?').get(reg.id);
  const { status, body } = await api('PUT', '/sales/register/close', owner.token, { location_id: TEST_LOCATION_ID, actual_cash: 500, preview: true });
  assert(status === 200 && body.data?.preview === true, `preview ${status} ${JSON.stringify(body)}`);
  assert(Number(body.data.expected_cash) === 300 && Number(body.data.discrepancy) === -200 && Number(body.data.actual_cash) === 500, `got ${JSON.stringify(body.data)}`);
  const after = await db.prepare('SELECT * FROM cash_registers WHERE id = ?').get(reg.id);
  assert(after.closed_at === null, 'register closed by preview');
  assert(Number(after.close_count_locked) === 500, `lock ${after.close_count_locked}`);
  const { close_count_locked: _a, ...afterRest } = after;
  const { close_count_locked: _b, ...beforeRest } = before;
  assert(JSON.stringify(afterRest) === JSON.stringify(beforeRest), 'register row changed by preview beyond the count lock');
});

const createdUserIds = [];
let staffCounter = 0;
async function createCounterStaff(ownerToken) {
  staffCounter += 1;
  const phone = '9' + String(Date.now()).slice(-8) + String(staffCounter % 10);
  const { status, body } = await api('POST', '/users', ownerToken, {
    name: `QuickSaleTest staff ${staffCounter}`, phone, password: 'testpass123', role: 'counter_staff', location_ids: [TEST_LOCATION_ID],
  });
  if (status !== 201 && status !== 200) throw new Error(`Could not create test staff: ${status} ${JSON.stringify(body)}`);
  const id = body.data.id || body.data.user?.id;
  createdUserIds.push(id);
  const login = await api('POST', '/auth/login', null, { phone, password: 'testpass123' });
  if (login.status !== 200) throw new Error(`staff login ${login.status}`);
  return { token: login.body.data.token, id };
}

check('staff count is locked once extra cash is offered', async () => {
  const owner = await loginOwner();
  const staff = await createCounterStaff(owner.token);
  const reg = await openRegister(owner.token, TEST_LOCATION_ID, 100);
  const close = (token, cash, preview) => api('PUT', '/sales/register/close', token, { location_id: TEST_LOCATION_ID, actual_cash: cash, ...(preview ? { preview: true } : {}) });
  // A shortage preview offers nothing and locks nothing.
  const short = await close(staff.token, 50, true);
  assert(short.status === 200, `short preview ${short.status}`);
  const db = await getDb();
  assert((await db.prepare('SELECT close_count_locked FROM cash_registers WHERE id = ?').get(reg.id)).close_count_locked === null, 'shortage locked the count');
  // An excess preview locks the count.
  const over = await close(staff.token, 400, true);
  assert(over.status === 200 && Number(over.body.data.discrepancy) === -300, `over preview ${over.status} ${JSON.stringify(over.body)}`);
  // Another number is refused, for preview and for close.
  const retry = await close(staff.token, 120, true);
  assert(retry.status === 409 && retry.body.code === 'COUNT_LOCKED' && Number(retry.body.locked_cash) === 400, `retry ${retry.status} ${JSON.stringify(retry.body)}`);
  assert(/already counted/.test(retry.body.message), `message ${retry.body.message}`);
  const closeOther = await close(staff.token, 100, false);
  assert(closeOther.status === 409, `close other ${closeOther.status}`);
  const stillOpen = await db.prepare('SELECT closed_at FROM cash_registers WHERE id = ?').get(reg.id);
  assert(stillOpen.closed_at === null, 'refused close still closed the register');
  // The same number closes.
  const closed = await close(staff.token, 400, false);
  assert(closed.status === 200 && Number(closed.body.data.discrepancy) === -300, `close same ${closed.status} ${JSON.stringify(closed.body)}`);
});

check('owner may close with a corrected count after the lock', async () => {
  const owner = await loginOwner();
  const reg = await openRegister(owner.token, TEST_LOCATION_ID, 100);
  const over = await api('PUT', '/sales/register/close', owner.token, { location_id: TEST_LOCATION_ID, actual_cash: 1000, preview: true });
  assert(over.status === 200, `preview ${over.status}`);
  const closed = await h.closeRegisterWith(owner.token, TEST_LOCATION_ID, 100);
  assert(Number(closed.discrepancy) === 0, `discrepancy ${closed.discrepancy}`);
  const db = await getDb();
  const row = await db.prepare('SELECT close_count_locked FROM cash_registers WHERE id = ?').get(reg.id);
  assert(Number(row.close_count_locked) === 1000, 'lock value should stay as the record of the first count');
});

check('top-up then close gives zero discrepancy', async () => {
  const owner = await loginOwner();
  await openRegister(owner.token, TEST_LOCATION_ID, 100);
  const top = await quickSale(owner.token, { amount: 200, method: 'cash', label: 'Unrecorded sales (booked at close)', entryMode: 'close_topup' });
  assert(top.status === 201, `top-up ${top.status} ${JSON.stringify(top.body)}`);
  const closed = await h.closeRegisterWith(owner.token, TEST_LOCATION_ID, 300);
  assert(Number(closed.discrepancy) === 0, `discrepancy ${closed.discrepancy}`);
  const db = await getDb();
  const row = await db.prepare('SELECT entry_mode FROM sales WHERE id = ?').get(top.body.data.id);
  assert(row.entry_mode === 'close_topup', `entry_mode ${row.entry_mode}`);
});

check('zero-stock product tile makes no production task', async () => {
  const owner = await loginOwner();
  await openRegister(owner.token, TEST_LOCATION_ID, 100);
  const pid = await makeTestProduct('ZZ quick zero stock', 90);
  const { status, body } = await quickSale(owner.token, { amount: 90, method: 'cash', productId: pid, fromStock: true });
  assert(status === 201, `Expected 201, got ${status}: ${JSON.stringify(body)}`);
  const db = await getDb();
  const sale = await db.prepare('SELECT status FROM sales WHERE id = ?').get(body.data.id);
  assert(sale.status === 'completed', `status: ${sale.status}`);
  const t = await db.prepare('SELECT COUNT(*) AS c FROM production_tasks WHERE sale_id = ?').get(body.data.id);
  assert(Number(t.c) === 0, `Expected 0 production tasks, got ${t.c}`);
  const st = await db.prepare('SELECT quantity FROM product_stock WHERE product_id = ? AND location_id = ?').get(pid, TEST_LOCATION_ID);
  console.log(`   (product_stock after zero-stock quick sale: ${st ? st.quantity : 'no row'})`);
});

check('preview with a non-boolean is refused', async () => {
  const owner = await loginOwner();
  const reg = await openRegister(owner.token, TEST_LOCATION_ID, 100);
  const db = await getDb();
  const before = await db.prepare('SELECT * FROM cash_registers WHERE id = ?').get(reg.id);
  const { status } = await api('PUT', '/sales/register/close', owner.token, { location_id: TEST_LOCATION_ID, actual_cash: 100, preview: 1 });
  assert(status === 400, `expected 400, got ${status}`);
  const after = await db.prepare('SELECT * FROM cash_registers WHERE id = ?').get(reg.id);
  assert(after.closed_at === null && JSON.stringify(after) === JSON.stringify(before), 'register changed');
});

check('Edit Sale refuses an undone quick sale', async () => {
  const owner = await loginOwner();
  await openRegister(owner.token, TEST_LOCATION_ID, 100);
  const sale = await quickSale(owner.token, { amount: 40, method: 'cash' });
  const id = sale.body.data.id;
  const u = await undo(owner.token, id);
  assert(u.status === 200, `undo: ${u.status}`);
  const put = await api('PUT', `/sales/${id}`, owner.token, { payments: [{ method: 'upi', amount: 40 }] });
  assert(put.status === 400 && /undone or cancelled/.test(put.body?.message || ''), `put: ${put.status} ${JSON.stringify(put.body)}`);
});

check('preview leaves one audit row and reports pending_cod', async () => {
  const owner = await loginOwner();
  const reg = await openRegister(owner.token, TEST_LOCATION_ID, 100);
  const db = await getDb();
  const count = async () => Number((await db.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'register_close_preview' AND entity_id = ?").get(reg.id)).c);
  const before = await count();
  const { status, body } = await api('PUT', '/sales/register/close', owner.token, { location_id: TEST_LOCATION_ID, actual_cash: 500, preview: true });
  assert(status === 200 && body.data?.preview === true, `preview ${status} ${JSON.stringify(body)}`);
  assert(typeof body.data.pending_cod === 'number', `pending_cod: ${JSON.stringify(body.data)}`);
  assert((await count()) === before + 1, 'expected exactly one new register_close_preview audit row');
  await db.prepare("DELETE FROM audit_logs WHERE action = 'register_close_preview' AND entity_id = ?").run(reg.id);
});

check('undo after the register is closed is refused (409)', async () => {
  const owner = await loginOwner();
  await openRegister(owner.token, TEST_LOCATION_ID, 100);
  const sale = await quickSale(owner.token, { amount: 70, method: 'cash' });
  const id = sale.body.data.id;
  await h.closeRegisterWith(owner.token, TEST_LOCATION_ID, 170);
  const r = await undo(owner.token, id);
  assert(r.status === 409, `expected 409, got ${r.status} ${JSON.stringify(r.body)}`);
  const db = await getDb();
  const s = await db.prepare('SELECT status FROM sales WHERE id = ?').get(id);
  assert(s.status !== 'cancelled', 'sale must stay live');
});

async function restoreTilesSetting() {
  if (tilesSettingBackup === undefined) return;
  const db = await getDb();
  await db.prepare("UPDATE settings SET value = '' WHERE key = 'quick_sale_tiles'").run();
}

async function cleanup() {
  await restoreTilesSetting();
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
  for (const id of createdUserIds) {
    try {
      await db.prepare('DELETE FROM audit_logs WHERE user_id = ?').run(id);
      await db.prepare('DELETE FROM user_locations WHERE user_id = ?').run(id);
      await db.prepare('DELETE FROM users WHERE id = ?').run(id);
    } catch (err) {
      console.error(`   (cleanup warning: user ${id}: ${err.message})`);
    }
  }
  console.log(`Cleaned up ${createdSaleIds.length} test sale(s), ${createdProductIds.length} test product(s) and ${createdUserIds.length} test user(s)`);
}

h.run({ cleanup });
