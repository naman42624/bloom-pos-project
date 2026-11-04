#!/usr/bin/env node
/**
 * Live verification of helper cash bags (plan 2026-11-02-helper-cash-bags).
 * Local dev only.
 *
 * Usage: VERIFY_OWNER_PHONE=... VERIFY_OWNER_PASSWORD=... node scripts/verify-helper-bags.js
 *
 * Registers: only registers this script opens itself are ever changed. If a
 * register someone else opened is already open at Test Loc, the register
 * checks refuse to run rather than close it.
 */
const crypto = require('crypto');
const h = require('./lib/verify-harness');
const { hashPin } = require('../utils/pin');
const { getBag, listBags, maskAmount } = require('../utils/helper-bags');

const { check, api, loginOwner, assert, getDb, TEST_LOCATION_ID, createdRegisterIds } = h;

const createdUserIds = [];
const createdProductIds = [];
let cashModeBackup; // undefined = never read
const REGISTER_COPY = "The counter hasn't opened the register yet. Ask them to open it, then try again.";

function shopDate(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

let phoneSeq = 0;
function testPhone() {
  phoneSeq += 1;
  return '7' + String((Date.now() + phoneSeq) % 1000000000).padStart(9, '0');
}

const HELPER_PIN = '5739';
async function helperSession(ownerToken) {
  const res = await api('POST', '/users', ownerToken, {
    name: `Verify Bag Helper ${phoneSeq + 1}`, phone: testPhone(), role: 'helper',
    access_until: shopDate(2), location_ids: [TEST_LOCATION_ID],
  });
  assert(res.status === 201, `create helper: ${res.status} ${JSON.stringify(res.body)}`);
  const id = res.body.data.user.id;
  createdUserIds.push(id);
  const db = await getDb();
  await db.prepare('UPDATE users SET pin_hash = ?, pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = ?')
    .run(await hashPin(HELPER_PIN), id);
  const login = await api('POST', '/auth/staff-login', null, { employee_code: res.body.data.user.employee_code, pin: HELPER_PIN });
  assert(login.status === 200 && login.body?.data?.token, `helper login: ${login.status} ${JSON.stringify(login.body)}`);
  return { id, token: login.body.data.token };
}

async function makeProduct(price) {
  const db = await getDb();
  const r = await db.prepare('INSERT INTO products (name, selling_price, is_active, price_mode, is_one_off) VALUES (?, ?, 1, ?, 0)')
    .run(`Verify Bag P${price} ${Date.now()}`, price, 'fixed');
  createdProductIds.push(r.lastInsertRowid);
  await db.prepare('INSERT INTO product_stock (product_id, location_id, quantity) VALUES (?, ?, 0)').run(r.lastInsertRowid, TEST_LOCATION_ID);
  return r.lastInsertRowid;
}

const products = new Map();
async function productFor(price) {
  if (!products.has(price)) products.set(price, await makeProduct(price));
  return products.get(price);
}

// payments: [{ method, amount }]; the product price is their total
async function helperSale(token, payments) {
  const total = payments.reduce((s, p) => s + p.amount, 0);
  const pid = await productFor(total);
  return api('POST', '/sales', token, {
    location_id: TEST_LOCATION_ID,
    client_ref: crypto.randomBytes(12).toString('base64url'),
    items: [{ product_id: pid, quantity: 1, unit_price: total }],
    payments,
  });
}

async function setCashMode(mode) {
  const db = await getDb();
  if (cashModeBackup === undefined) {
    const row = await db.prepare("SELECT value FROM settings WHERE key = 'helper_cash_mode'").get();
    assert(row, 'settings row helper_cash_mode missing (schema seed did not run)');
    cashModeBackup = row.value;
  }
  await db.prepare("UPDATE settings SET value = ? WHERE key = 'helper_cash_mode'").run(mode);
}

// Puts back the value read before this run changed it (nothing to do when
// the run never changed it)
async function restoreCashMode() {
  if (cashModeBackup === undefined) return;
  const db = await getDb();
  await db.prepare("UPDATE settings SET value = ? WHERE key = 'helper_cash_mode'").run(cashModeBackup);
}

// Opens a register at Test Loc for this script. Refuses (never closes) when
// someone else already has one open there.
async function openOwnRegister(ownerToken, openingBalance) {
  const db = await getDb();
  const open = await db.prepare('SELECT id FROM cash_registers WHERE location_id = ? AND closed_at IS NULL').all(TEST_LOCATION_ID);
  const foreign = open.filter((r) => !createdRegisterIds.includes(r.id));
  assert(foreign.length === 0, `Test Loc already has an open register not opened by this script (id ${foreign.map((r) => r.id).join(', ')}); not touching it`);
  for (const r of open) await closeOwnRegister(r.id);
  const { status, body } = await api('POST', '/sales/register/open', ownerToken, { location_id: TEST_LOCATION_ID, opening_balance: openingBalance });
  assert(status === 201, `Could not open register: ${status} ${JSON.stringify(body)}`);
  createdRegisterIds.push(body.data.id);
  return body.data.id;
}

// Marks this script's own register closed (no close recompute, no audit rows)
async function closeOwnRegister(id) {
  assert(createdRegisterIds.includes(id), `register ${id} was not opened by this script`);
  const db = await getDb();
  await db.prepare('UPDATE cash_registers SET closed_at = NOW() WHERE id = ? AND closed_at IS NULL').run(id);
}

async function registerRow(id) {
  const db = await getDb();
  const r = await db.prepare('SELECT expected_cash, total_cash_sales, total_upi_sales, total_card_sales FROM cash_registers WHERE id = ?').get(id);
  return { expected_cash: Number(r.expected_cash), total_cash_sales: Number(r.total_cash_sales), total_upi_sales: Number(r.total_upi_sales), total_card_sales: Number(r.total_card_sales) };
}

async function paymentsOf(saleId) {
  const db = await getDb();
  return db.prepare('SELECT method, amount, held_by FROM payments WHERE sale_id = ? ORDER BY id').all(saleId);
}

// ---------------------------------------------------------------------------

check('schema: payments.held_by, staff_cash_movements, helper_cash_mode seed', async () => {
  const db = await getDb();
  const col = await db.prepare("SELECT 1 AS x FROM information_schema.columns WHERE table_name = 'payments' AND column_name = 'held_by'").get();
  assert(col, 'payments.held_by missing');
  const cols = await db.prepare("SELECT column_name FROM information_schema.columns WHERE table_name = 'staff_cash_movements'").all();
  const names = cols.map((c) => c.column_name).sort().join(',');
  const want = ['id', 'location_id', 'staff_id', 'type', 'expected_amount', 'counted_amount', 'settled_amount', 'difference', 'is_final', 'register_id', 'recorded_by', 'note', 'created_at'].sort().join(',');
  assert(names === want, `staff_cash_movements columns: ${names}`);
  const idx = await db.prepare("SELECT 1 AS x FROM pg_indexes WHERE tablename = 'staff_cash_movements' AND indexdef LIKE '%(staff_id, location_id, created_at)%'").get();
  assert(idx, 'index (staff_id, location_id, created_at) missing');
  const seed = await db.prepare("SELECT value FROM settings WHERE key = 'helper_cash_mode'").get();
  assert(seed, 'helper_cash_mode setting missing');
});

check('maskAmount examples', async () => {
  const cases = [[5234, '₹5,xxx'], [845, '₹8xx'], [45, '₹xx'], [123456, '₹1,xx,xxx'], [0, '₹x'], [100, '₹1xx'], [99.99, '₹xx'], [1200.5, '₹1,xxx']];
  for (const [n, want] of cases) {
    const got = maskAmount(n);
    assert(got === want, `maskAmount(${n}) = ${got}, wanted ${want}`);
  }
});

let regCtx = null;
async function regSetup() {
  if (regCtx) return regCtx;
  const owner = await loginOwner();
  const helper = await helperSession(owner.token);
  regCtx = { owner, helper, registerId: null };
  return regCtx;
}

check('register mode unchanged', async () => {
  const ctx = await regSetup();
  await setCashMode('register');
  ctx.registerId = await openOwnRegister(ctx.owner.token, 1000);
  const before = await registerRow(ctx.registerId);
  const r = await helperSale(ctx.helper.token, [{ method: 'cash', amount: 300 }]);
  assert(r.status === 201, `sale: ${r.status} ${JSON.stringify(r.body)}`);
  const after = await registerRow(ctx.registerId);
  assert(after.expected_cash - before.expected_cash === 300, `expected_cash moved by ${after.expected_cash - before.expected_cash}`);
  assert(after.total_cash_sales - before.total_cash_sales === 300, `total_cash_sales moved by ${after.total_cash_sales - before.total_cash_sales}`);
  const pays = await paymentsOf(r.body.data.id);
  assert(pays.length === 1 && pays[0].held_by === null, `payment held_by should be null: ${JSON.stringify(pays)}`);
});

check('bag mode cash sale is held and skips the register', async () => {
  const ctx = await regSetup();
  try {
    await setCashMode('bag');
    // Register open: nothing in it moves
    if (!ctx.registerId) ctx.registerId = await openOwnRegister(ctx.owner.token, 1000);
    const before = await registerRow(ctx.registerId);
    const r = await helperSale(ctx.helper.token, [{ method: 'cash', amount: 450 }]);
    assert(r.status === 201, `sale: ${r.status} ${JSON.stringify(r.body)}`);
    const after = await registerRow(ctx.registerId);
    assert(JSON.stringify(after) === JSON.stringify(before), `register moved: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    const pays = await paymentsOf(r.body.data.id);
    assert(pays.length === 1 && pays[0].method === 'cash' && pays[0].held_by === ctx.helper.id, `held_by: ${JSON.stringify(pays)}`);

    // Register closed: the sale still works and is held
    await closeOwnRegister(ctx.registerId);
    const closed = await helperSale(ctx.helper.token, [{ method: 'cash', amount: 250 }]);
    assert(closed.status === 201, `sale with register closed: ${closed.status} ${JSON.stringify(closed.body)}`);
    const pays2 = await paymentsOf(closed.body.data.id);
    assert(pays2.length === 1 && pays2[0].held_by === ctx.helper.id, `held_by (closed): ${JSON.stringify(pays2)}`);
    const stillClosed = await registerRow(ctx.registerId);
    assert(JSON.stringify(stillClosed) === JSON.stringify(before), 'closed register moved');

    // Back in register mode the closed register refuses helper cash again
    await setCashMode('register');
    const refused = await helperSale(ctx.helper.token, [{ method: 'cash', amount: 250 }]);
    assert(refused.status === 400 && refused.body?.message === REGISTER_COPY, `register mode, closed: ${refused.status} ${JSON.stringify(refused.body)}`);
  } finally {
    await restoreCashMode();
  }
});

check('bag mode staff cash sale still goes to the register', async () => {
  const ctx = await regSetup();
  try {
    await setCashMode('bag');
    ctx.registerId = await openOwnRegister(ctx.owner.token, 500);
    const before = await registerRow(ctx.registerId);
    const pid = await productFor(120);
    const r = await api('POST', '/sales', ctx.owner.token, {
      location_id: TEST_LOCATION_ID, order_type: 'walk_in', skip_assignment: true,
      items: [{ product_id: pid, quantity: 1, unit_price: 120 }], payments: [{ method: 'cash', amount: 120 }],
    });
    assert(r.status === 201, `owner sale: ${r.status} ${JSON.stringify(r.body)}`);
    trackSale(r.body.data.id);
    const after = await registerRow(ctx.registerId);
    assert(after.expected_cash - before.expected_cash === 120, `owner cash not in register: ${JSON.stringify(after)}`);
    const pays = await paymentsOf(r.body.data.id);
    assert(pays[0].held_by === null, `owner payment held: ${JSON.stringify(pays)}`);
  } finally {
    await restoreCashMode();
  }
});

check('bag mode UPI goes to register totals', async () => {
  const ctx = await regSetup();
  try {
    await setCashMode('bag');
    if (!ctx.registerId || (await (await getDb()).prepare('SELECT closed_at FROM cash_registers WHERE id = ?').get(ctx.registerId)).closed_at) {
      ctx.registerId = await openOwnRegister(ctx.owner.token, 500);
    }
    const before = await registerRow(ctx.registerId);
    const upi = await helperSale(ctx.helper.token, [{ method: 'upi', amount: 200 }]);
    assert(upi.status === 201, `upi sale: ${upi.status} ${JSON.stringify(upi.body)}`);
    const mid = await registerRow(ctx.registerId);
    assert(mid.total_upi_sales - before.total_upi_sales === 200, `upi total moved by ${mid.total_upi_sales - before.total_upi_sales}`);
    assert(mid.expected_cash === before.expected_cash && mid.total_cash_sales === before.total_cash_sales, 'upi sale moved cash');
    const p1 = await paymentsOf(upi.body.data.id);
    assert(p1[0].held_by === null, `upi payment held: ${JSON.stringify(p1)}`);

    // Mixed: cash part held, UPI part in the register
    const mixed = await helperSale(ctx.helper.token, [{ method: 'cash', amount: 70 }, { method: 'upi', amount: 30 }]);
    assert(mixed.status === 201, `mixed sale: ${mixed.status} ${JSON.stringify(mixed.body)}`);
    const after = await registerRow(ctx.registerId);
    assert(after.total_upi_sales - mid.total_upi_sales === 30, `mixed upi moved by ${after.total_upi_sales - mid.total_upi_sales}`);
    assert(after.expected_cash === mid.expected_cash && after.total_cash_sales === mid.total_cash_sales, `mixed cash reached the register: ${JSON.stringify(mid)} -> ${JSON.stringify(after)}`);
    const p2 = await paymentsOf(mixed.body.data.id);
    const cash = p2.find((p) => p.method === 'cash');
    const u = p2.find((p) => p.method === 'upi');
    assert(cash.held_by === ctx.helper.id && u.held_by === null, `mixed held_by: ${JSON.stringify(p2)}`);
  } finally {
    await restoreCashMode();
  }
});

check('bag balance formula', async () => {
  const owner = await loginOwner();
  const helper = await helperSession(owner.token);
  const db = await getDb();
  try {
    await setCashMode('bag');
    await db.prepare("INSERT INTO staff_cash_movements (location_id, staff_id, type, expected_amount, recorded_by) VALUES (?, ?, 'float_out', 500, ?)")
      .run(TEST_LOCATION_ID, helper.id, owner.id);
    const a = await helperSale(helper.token, [{ method: 'cash', amount: 400 }]);
    const b = await helperSale(helper.token, [{ method: 'cash', amount: 300 }]);
    assert(a.status === 201 && b.status === 201, `sales: ${a.status} ${b.status}`);

    let bag = await getBag(db, helper.id, TEST_LOCATION_ID);
    assert(bag.held === 1200, `held ${bag.held}, wanted 1200 (${JSON.stringify(bag)})`);
    assert(bag.floats === 500 && bag.cash_sales === 700 && bag.settled === 0, `parts: ${JSON.stringify(bag)}`);
    assert(bag.sale_count === 2, `sale_count ${bag.sale_count}`);

    // A UPI sale adds a sale but no cash
    const u = await helperSale(helper.token, [{ method: 'upi', amount: 90 }]);
    assert(u.status === 201, `upi: ${u.status}`);
    bag = await getBag(db, helper.id, TEST_LOCATION_ID);
    assert(bag.held === 1200 && bag.sale_count === 3, `after upi: ${JSON.stringify(bag)}`);

    // A handover settles part of it
    await db.prepare("INSERT INTO staff_cash_movements (location_id, staff_id, type, expected_amount, counted_amount, settled_amount, recorded_by) VALUES (?, ?, 'handover_in', 1200, 250, 250, ?)")
      .run(TEST_LOCATION_ID, helper.id, owner.id);
    bag = await getBag(db, helper.id, TEST_LOCATION_ID);
    assert(bag.held === 950 && bag.cash_sales === 700 && bag.settled === 250 && bag.sale_count === 3, `after handover: ${JSON.stringify(bag)}`);

    // An undone sale drops out. Set by SQL: the real undo route still
    // reverses register cash for a held sale until Task 2 changes it.
    await db.prepare("UPDATE sales SET status = 'cancelled', undone_at = NOW() WHERE id = ?").run(b.body.data.id);
    bag = await getBag(db, helper.id, TEST_LOCATION_ID);
    assert(bag.held === 650 && bag.cash_sales === 400 && bag.settled === 250 && bag.sale_count === 2, `after handover + undo: ${JSON.stringify(bag)}`);

    // Another location: nothing there
    const other = await getBag(db, helper.id, TEST_LOCATION_ID === 1 ? 2 : 1);
    assert(other.held === 0 && other.sale_count === 0, `other location: ${JSON.stringify(other)}`);

    // listBags shows the helper with is_active and access_until
    const list = await listBags(db, TEST_LOCATION_ID);
    const row = list.find((x) => x.staff_id === helper.id);
    assert(row && row.held === 650 && row.sale_count === 2, `listBags row: ${JSON.stringify(row)}`);
    assert(row.is_active === true && row.access_until === shopDate(2) && /Verify Bag Helper/.test(row.name), `listBags fields: ${JSON.stringify(row)}`);
    assert(maskAmount(row.held) === '₹6xx', `masked ${maskAmount(row.held)}`);
  } finally {
    await restoreCashMode();
  }
});

check('refunded and cancelled bag sale keeps its cash in the bag', async () => {
  const owner = await loginOwner();
  const helper = await helperSession(owner.token);
  const db = await getDb();
  try {
    await setCashMode('bag');
    const regId = await openOwnRegister(owner.token, 1000);
    const sale = await helperSale(helper.token, [{ method: 'cash', amount: 350 }]);
    assert(sale.status === 201, `sale: ${sale.status} ${JSON.stringify(sale.body)}`);
    const saleId = sale.body.data.id;
    const before = await getBag(db, helper.id, TEST_LOCATION_ID);
    assert(before.held === 350, `bag before refund: ${JSON.stringify(before)}`);
    const regBefore = await registerRow(regId);

    // Real path: cash refund from the drawer, then cancel
    const refund = await api('POST', `/sales/${saleId}/refund`, owner.token, { amount: 350, reason: 'verify bag refund', refund_method: 'cash' });
    assert(refund.status === 200 || refund.status === 201, `refund: ${refund.status} ${JSON.stringify(refund.body)}`);
    const cancel = await api('PUT', `/sales/${saleId}/cancel`, owner.token);
    assert(cancel.status === 200, `cancel: ${cancel.status} ${JSON.stringify(cancel.body)}`);
    const row = await db.prepare('SELECT status, undone_at FROM sales WHERE id = ?').get(saleId);
    assert(row.status === 'cancelled' && row.undone_at === null, `sale row: ${JSON.stringify(row)}`);

    // The refund was paid from the drawer; the helper still holds the 350
    const regAfter = await registerRow(regId);
    assert(regBefore.expected_cash - regAfter.expected_cash === 350, `drawer paid ${regBefore.expected_cash - regAfter.expected_cash}, wanted 350`);
    const after = await getBag(db, helper.id, TEST_LOCATION_ID);
    assert(after.held === 350 && after.cash_sales === 350, `bag after refund + cancel: ${JSON.stringify(after)}`);
  } finally {
    await restoreCashMode();
  }
});

check('listBags leaves out helpers with nothing held and no sales today', async () => {
  const owner = await loginOwner();
  const idle = await helperSession(owner.token);
  const settledOut = await helperSession(owner.token);
  const db = await getDb();
  // Float given and fully handed back yesterday: bag 0, no sales today
  await db.prepare("INSERT INTO staff_cash_movements (location_id, staff_id, type, expected_amount, recorded_by, created_at) VALUES (?, ?, 'float_out', 300, ?, NOW() - INTERVAL '1 day')")
    .run(TEST_LOCATION_ID, settledOut.id, owner.id);
  await db.prepare("INSERT INTO staff_cash_movements (location_id, staff_id, type, expected_amount, counted_amount, settled_amount, is_final, recorded_by, created_at) VALUES (?, ?, 'handover_in', 300, 300, 300, 1, ?, NOW() - INTERVAL '1 day')")
    .run(TEST_LOCATION_ID, settledOut.id, owner.id);
  const list = await listBags(db, TEST_LOCATION_ID);
  assert(!list.some((x) => x.staff_id === idle.id), 'idle helper listed');
  assert(!list.some((x) => x.staff_id === settledOut.id), 'settled helper listed');

  // An expired, switched-off helper with cash out stays listed
  await db.prepare("INSERT INTO staff_cash_movements (location_id, staff_id, type, expected_amount, recorded_by) VALUES (?, ?, 'float_out', 150, ?)")
    .run(TEST_LOCATION_ID, idle.id, owner.id);
  await db.prepare('UPDATE users SET access_until = ?, is_active = 0 WHERE id = ?').run(shopDate(-1), idle.id);
  const list2 = await listBags(db, TEST_LOCATION_ID);
  const row = list2.find((x) => x.staff_id === idle.id);
  assert(row && row.held === 150 && row.sale_count === 0 && row.is_active === false && row.access_until === shopDate(-1), `expired helper row: ${JSON.stringify(row)}`);
});

// ---------------------------------------------------------------------------

const extraSaleIds = [];
function trackSale(id) { extraSaleIds.push(id); }

async function cleanup() {
  const db = await getDb();
  try {
    await restoreCashMode();
  } catch (err) {
    console.error(`   (cleanup warning: helper_cash_mode: ${err.message})`);
  }
  let saleIds = [...extraSaleIds];
  if (createdUserIds.length) {
    const ph = createdUserIds.map(() => '?').join(', ');
    const rows = await db.prepare(`SELECT id FROM sales WHERE created_by IN (${ph})`).all(...createdUserIds);
    saleIds = saleIds.concat(rows.map((r) => r.id));
  }
  for (const id of saleIds) {
    try {
      await db.prepare('DELETE FROM production_tasks WHERE sale_id = ?').run(id);
      await db.prepare('DELETE FROM deliveries WHERE sale_id = ?').run(id);
      await db.prepare('DELETE FROM refunds WHERE sale_id = ?').run(id);
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
      await db.prepare('DELETE FROM product_options WHERE product_id = ?').run(id);
      await db.prepare('DELETE FROM product_stock WHERE product_id = ?').run(id);
      await db.prepare('DELETE FROM products WHERE id = ?').run(id);
    } catch (err) {
      console.error(`   (cleanup warning: product ${id}: ${err.message})`);
    }
  }
  for (const id of createdUserIds) {
    try {
      await db.prepare('DELETE FROM staff_cash_movements WHERE staff_id = ? OR recorded_by = ?').run(id, id);
      await db.prepare('DELETE FROM audit_logs WHERE user_id = ?').run(id);
      await db.prepare("DELETE FROM audit_logs WHERE entity_type = 'user' AND entity_id = ?").run(id);
      await db.prepare('DELETE FROM helper_join_tokens WHERE user_id = ? OR created_by = ?').run(id, id);
      await db.prepare('DELETE FROM user_locations WHERE user_id = ?').run(id);
      await db.prepare('DELETE FROM users WHERE id = ?').run(id);
    } catch (err) {
      console.error(`   (cleanup warning: user ${id}: ${err.message})`);
    }
  }
  console.log(`Cleaned up ${saleIds.length} sale(s), ${createdProductIds.length} product(s), ${createdUserIds.length} user(s)`);
}

h.run({ cleanup });
