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
// Task 2: register close, undo, refund and Edit Sale with bags.
// Floats and handovers are inserted by SQL with this script's register_id
// (Ruling 2: the float/handover routes arrive in Task 3).

const NOT_QUICK_COPY = "This sale isn't a quick sale entry";
const HANDED_OVER_COPY = "This sale's cash was already handed over. Ask the counter to refund it.";
const HELD_EDIT_COPY = "This sale's cash is with a helper. Undo it within 2 minutes, or refund it from the counter.";

async function addMovement(type, staffId, recordedBy, registerId, { expected = 0, counted = 0, settled = 0, difference = 0, isFinal = 0 } = {}) {
  assert(createdRegisterIds.includes(registerId), `register ${registerId} was not opened by this script`);
  const db = await getDb();
  await db.prepare(`INSERT INTO staff_cash_movements
      (location_id, staff_id, type, expected_amount, counted_amount, settled_amount, difference, is_final, register_id, recorded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(TEST_LOCATION_ID, staffId, type, expected, counted, settled, difference, isFinal, registerId, recordedBy);
}

const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

// Preview then close this script's own register with the same count.
async function previewAndClose(ownerToken, registerId, actualCash) {
  const db = await getDb();
  const open = await db.prepare('SELECT id FROM cash_registers WHERE location_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1').get(TEST_LOCATION_ID);
  assert(open && open.id === registerId && createdRegisterIds.includes(registerId), `open register at Test Loc is ${open && open.id}, not this script's ${registerId}; not closing it`);
  const preview = await api('PUT', '/sales/register/close', ownerToken, { location_id: TEST_LOCATION_ID, actual_cash: actualCash, preview: true });
  assert(preview.status === 200 && preview.body?.data?.preview === true, `preview: ${preview.status} ${JSON.stringify(preview.body)}`);
  const close = await api('PUT', '/sales/register/close', ownerToken, { location_id: TEST_LOCATION_ID, actual_cash: actualCash });
  assert(close.status === 200, `close: ${close.status} ${JSON.stringify(close.body)}`);
  assert(close.body.data.id === registerId && close.body.data.closed_at, `closed the wrong register: ${JSON.stringify(close.body.data)}`);
  return { preview: preview.body.data, close: close.body.data };
}

async function bagAudit(registerId) {
  const db = await getDb();
  const row = await db.prepare("SELECT new_state FROM audit_logs WHERE entity_type = 'cash_register' AND entity_id = ? AND action = 'register_closed_with_helper_cash' ORDER BY id DESC LIMIT 1").get(registerId);
  if (!row) return null;
  return typeof row.new_state === 'string' ? JSON.parse(row.new_state) : row.new_state;
}

check('close counts floats and handovers', async () => {
  const owner = await loginOwner();
  const helper = await helperSession(owner.token);
  const db = await getDb();
  try {
    await setCashMode('bag');
    const regId = await openOwnRegister(owner.token, 1000);
    await addMovement('float_out', helper.id, owner.id, regId, { expected: 300 });
    const s1 = await helperSale(helper.token, [{ method: 'cash', amount: 400 }]);
    const s2 = await helperSale(helper.token, [{ method: 'cash', amount: 200 }]);
    assert(s1.status === 201 && s2.status === 201, `sales: ${s1.status} ${s2.status}`);
    let bag = await getBag(db, helper.id, TEST_LOCATION_ID);
    assert(bag.held === 900, `bag before handovers ${JSON.stringify(bag)}`);

    // Partial handover: 250 counted and settled, the rest stays in the bag
    await addMovement('handover_in', helper.id, owner.id, regId, { expected: 900, counted: 250, settled: 250 });
    bag = await getBag(db, helper.id, TEST_LOCATION_ID);
    assert(bag.held === 650, `bag after partial ${JSON.stringify(bag)}`);
    // Final handover: 650 expected, 640 counted, whole 650 settled, short 10
    await addMovement('handover_in', helper.id, owner.id, regId, { expected: 650, counted: 640, settled: 650, difference: -10, isFinal: 1 });
    bag = await getBag(db, helper.id, TEST_LOCATION_ID);
    assert(bag.held === 0, `bag after final ${JSON.stringify(bag)}`);
    const short = await db.prepare("SELECT COALESCE(SUM(difference), 0) AS d FROM staff_cash_movements WHERE staff_id = ? AND type = 'handover_in'").get(helper.id);
    assert(near(short.d, -10), `shortage recorded ${short.d}`);

    // Drawer: opening 1000 - float 300 + handovers 250 + 640 = 1590
    const drawer = 1000 - 300 + 250 + 640;
    const { preview, close } = await previewAndClose(owner.token, regId, drawer);
    assert(near(preview.expected_cash, 1590) && near(preview.discrepancy, 0), `preview ${JSON.stringify(preview)}`);
    assert(near(close.expected_cash, 1590) && near(close.discrepancy, 0), `close expected ${close.expected_cash} discrepancy ${close.discrepancy}`);
    assert(near(close.total_cash_sales, 0), `held cash counted as cash sales: ${close.total_cash_sales}`);
    const audit = await bagAudit(regId);
    assert(!audit || !audit.bags.some((b) => b.staff_id === helper.id), `settled helper listed in close audit: ${JSON.stringify(audit)}`);
  } finally {
    await restoreCashMode();
  }
});

check('preview matches close', async () => {
  const owner = await loginOwner();
  const helper = await helperSession(owner.token);
  try {
    await setCashMode('bag');
    const regId = await openOwnRegister(owner.token, 500);
    // Owner cash sale goes into the drawer as today
    const pid = await productFor(100);
    const own = await api('POST', '/sales', owner.token, {
      location_id: TEST_LOCATION_ID, order_type: 'walk_in', skip_assignment: true,
      items: [{ product_id: pid, quantity: 1, unit_price: 100 }], payments: [{ method: 'cash', amount: 100 }],
    });
    assert(own.status === 201, `owner sale: ${own.status} ${JSON.stringify(own.body)}`);
    trackSale(own.body.data.id);
    await addMovement('float_out', helper.id, owner.id, regId, { expected: 50 });
    const hs = await helperSale(helper.token, [{ method: 'cash', amount: 200 }, { method: 'upi', amount: 40 }]);
    assert(hs.status === 201, `helper sale: ${hs.status}`);
    await addMovement('handover_in', helper.id, owner.id, regId, { expected: 250, counted: 80, settled: 80 });

    // Expected drawer: 500 + 100 - 50 + 80 = 630; counted 620 is 10 short
    const { preview, close } = await previewAndClose(owner.token, regId, 620);
    assert(near(preview.expected_cash, 630) && near(preview.discrepancy, 10), `preview ${JSON.stringify(preview)}`);
    assert(near(close.expected_cash, preview.expected_cash) && near(close.discrepancy, preview.discrepancy), `close ${close.expected_cash}/${close.discrepancy} vs preview ${preview.expected_cash}/${preview.discrepancy}`);
    assert(near(close.total_cash_sales, 100) && near(close.total_upi_sales, 40), `close totals cash ${close.total_cash_sales} upi ${close.total_upi_sales}`);

    // The helper still holds 50 + 200 - 80 = 170: close went ahead and the audit names them
    const audit = await bagAudit(regId);
    const row = audit && audit.bags.find((b) => b.staff_id === helper.id);
    assert(row && near(row.held, 170) && /Verify Bag Helper/.test(row.name), `close audit: ${JSON.stringify(audit)}`);
  } finally {
    await restoreCashMode();
  }
});

check('held undo leaves the register alone', async () => {
  const owner = await loginOwner();
  const helper = await helperSession(owner.token);
  const db = await getDb();
  try {
    await setCashMode('bag');
    const regId = await openOwnRegister(owner.token, 700);
    const s = await helperSale(helper.token, [{ method: 'cash', amount: 150 }, { method: 'upi', amount: 50 }]);
    assert(s.status === 201, `sale: ${s.status} ${JSON.stringify(s.body)}`);
    const saleId = s.body.data.id;
    const bagBefore = await getBag(db, helper.id, TEST_LOCATION_ID);
    assert(bagBefore.held === 150, `bag before ${JSON.stringify(bagBefore)}`);

    // Staff cannot undo a helper sale (not a quick-sale entry): they refund it
    const staffUndo = await api('POST', `/quick-sale/${saleId}/undo`, owner.token);
    assert(staffUndo.status === 400 && staffUndo.body?.message === NOT_QUICK_COPY, `owner undo of helper sale: ${staffUndo.status} ${JSON.stringify(staffUndo.body)}`);

    const regBefore = await registerRow(regId);
    const undo = await api('POST', `/quick-sale/${saleId}/undo`, helper.token);
    assert(undo.status === 200, `helper undo: ${undo.status} ${JSON.stringify(undo.body)}`);
    const regAfter = await registerRow(regId);
    assert(regAfter.expected_cash === regBefore.expected_cash && regAfter.total_cash_sales === regBefore.total_cash_sales, `held undo moved register cash: ${JSON.stringify(regBefore)} -> ${JSON.stringify(regAfter)}`);
    assert(regBefore.total_upi_sales - regAfter.total_upi_sales === 50, `upi part not reversed: ${JSON.stringify(regBefore)} -> ${JSON.stringify(regAfter)}`);
    const bagAfter = await getBag(db, helper.id, TEST_LOCATION_ID);
    assert(bagAfter.held === 0, `bag after undo ${JSON.stringify(bagAfter)}`);

    // With the register closed a held cash sale can still be undone
    await closeOwnRegister(regId);
    const s2 = await helperSale(helper.token, [{ method: 'cash', amount: 90 }]);
    assert(s2.status === 201, `sale (closed): ${s2.status} ${JSON.stringify(s2.body)}`);
    const undo2 = await api('POST', `/quick-sale/${s2.body.data.id}/undo`, helper.token);
    assert(undo2.status === 200, `helper undo (closed): ${undo2.status} ${JSON.stringify(undo2.body)}`);
    const regClosed = await registerRow(regId);
    assert(JSON.stringify(regClosed) === JSON.stringify(regAfter), 'closed register moved');
    assert((await getBag(db, helper.id, TEST_LOCATION_ID)).held === 0, 'bag not back to 0');
  } finally {
    await restoreCashMode();
  }
});

check('helper undo blocked after handover', async () => {
  const owner = await loginOwner();
  const helper = await helperSession(owner.token);
  const db = await getDb();
  try {
    await setCashMode('bag');
    const regId = await openOwnRegister(owner.token, 400);
    const s = await helperSale(helper.token, [{ method: 'cash', amount: 300 }]);
    assert(s.status === 201, `sale: ${s.status}`);
    await addMovement('handover_in', helper.id, owner.id, regId, { expected: 300, counted: 100, settled: 100 });
    const bagBefore = await getBag(db, helper.id, TEST_LOCATION_ID);
    assert(bagBefore.held === 200, `bag ${JSON.stringify(bagBefore)}`);
    const regBefore = await registerRow(regId);

    const undo = await api('POST', `/quick-sale/${s.body.data.id}/undo`, helper.token);
    assert(undo.status === 409 && undo.body?.message === HANDED_OVER_COPY, `undo after handover: ${undo.status} ${JSON.stringify(undo.body)}`);
    const row = await db.prepare('SELECT status, undone_at FROM sales WHERE id = ?').get(s.body.data.id);
    assert(row.status !== 'cancelled' && row.undone_at === null, `sale changed: ${JSON.stringify(row)}`);
    const bagAfter = await getBag(db, helper.id, TEST_LOCATION_ID);
    assert(bagAfter.held === 200, `bag moved: ${JSON.stringify(bagAfter)}`);
    assert(JSON.stringify(await registerRow(regId)) === JSON.stringify(regBefore), 'register moved');

    // A sale made after that handover can still be undone
    const later = await helperSale(helper.token, [{ method: 'cash', amount: 60 }]);
    assert(later.status === 201, `later sale: ${later.status}`);
    const undoLater = await api('POST', `/quick-sale/${later.body.data.id}/undo`, helper.token);
    assert(undoLater.status === 200, `undo of later sale: ${undoLater.status} ${JSON.stringify(undoLater.body)}`);
    assert((await getBag(db, helper.id, TEST_LOCATION_ID)).held === 200, 'bag after later undo');
  } finally {
    await restoreCashMode();
  }
});

check('refund of a bag sale leaves the bag alone', async () => {
  const owner = await loginOwner();
  const helper = await helperSession(owner.token);
  const db = await getDb();
  try {
    await setCashMode('bag');
    const regId = await openOwnRegister(owner.token, 800);
    const s = await helperSale(helper.token, [{ method: 'cash', amount: 250 }]);
    assert(s.status === 201, `sale: ${s.status}`);
    const bagBefore = await getBag(db, helper.id, TEST_LOCATION_ID);
    const regBefore = await registerRow(regId);
    const refund = await api('POST', `/sales/${s.body.data.id}/refund`, owner.token, { amount: 250, reason: 'verify bag refund', refund_method: 'cash' });
    assert(refund.status === 201, `refund: ${refund.status} ${JSON.stringify(refund.body)}`);
    const regAfter = await registerRow(regId);
    assert(regBefore.expected_cash - regAfter.expected_cash === 250, `drawer paid ${regBefore.expected_cash - regAfter.expected_cash}`);
    const bagAfter = await getBag(db, helper.id, TEST_LOCATION_ID);
    assert(JSON.stringify(bagAfter) === JSON.stringify(bagBefore) && bagAfter.held === 250, `bag moved: ${JSON.stringify(bagBefore)} -> ${JSON.stringify(bagAfter)}`);

    // Close: opening 800 - refund 250 = 550; the held 250 is not in the drawer
    const { close } = await previewAndClose(owner.token, regId, 550);
    assert(near(close.expected_cash, 550) && near(close.discrepancy, 0), `close ${close.expected_cash}/${close.discrepancy}`);
  } finally {
    await restoreCashMode();
  }
});

check('refund then cancel of a bag sale still closes to 0', async () => {
  const owner = await loginOwner();
  const helper = await helperSession(owner.token);
  const db = await getDb();
  try {
    await setCashMode('bag');
    const regId = await openOwnRegister(owner.token, 1000);
    const s = await helperSale(helper.token, [{ method: 'cash', amount: 350 }]);
    assert(s.status === 201, `sale: ${s.status}`);
    const refund = await api('POST', `/sales/${s.body.data.id}/refund`, owner.token, { amount: 350, reason: 'verify bag refund cancel', refund_method: 'cash' });
    assert(refund.status === 201, `refund: ${refund.status} ${JSON.stringify(refund.body)}`);
    const cancel = await api('PUT', `/sales/${s.body.data.id}/cancel`, owner.token);
    assert(cancel.status === 200, `cancel: ${cancel.status} ${JSON.stringify(cancel.body)}`);
    assert((await getBag(db, helper.id, TEST_LOCATION_ID)).held === 350, 'bag changed by refund + cancel');

    // Only the refund touched the drawer: 1000 - 350 = 650
    const { preview, close } = await previewAndClose(owner.token, regId, 650);
    assert(near(preview.expected_cash, 650) && near(preview.discrepancy, 0), `preview ${JSON.stringify(preview)}`);
    assert(near(close.expected_cash, 650) && near(close.discrepancy, 0), `close ${close.expected_cash}/${close.discrepancy}`);
    assert(near(close.total_refunds_cash, 350), `refunds ${close.total_refunds_cash}`);
  } finally {
    await restoreCashMode();
  }
});

check('edit sale refuses payment change on held cash', async () => {
  const owner = await loginOwner();
  const helper = await helperSession(owner.token);
  try {
    await setCashMode('bag');
    const regId = await openOwnRegister(owner.token, 300);
    const s = await helperSale(helper.token, [{ method: 'cash', amount: 180 }]);
    assert(s.status === 201, `sale: ${s.status}`);
    const saleId = s.body.data.id;
    const regBefore = await registerRow(regId);
    const edit = await api('PUT', `/sales/${saleId}`, owner.token, { payments: [{ method: 'upi', amount: 180 }], customer_name: 'should not save' });
    assert(edit.status === 409 && edit.body?.message === HELD_EDIT_COPY, `payment edit: ${edit.status} ${JSON.stringify(edit.body)}`);
    const pays = await paymentsOf(saleId);
    assert(pays.length === 1 && pays[0].method === 'cash' && pays[0].held_by === helper.id, `payments changed: ${JSON.stringify(pays)}`);
    const db = await getDb();
    const nameRow = await db.prepare('SELECT customer_name FROM sales WHERE id = ?').get(saleId);
    assert(nameRow.customer_name !== 'should not save', 'other fields saved with a refused payment edit');
    assert(JSON.stringify(await registerRow(regId)) === JSON.stringify(regBefore), 'register moved');

    // Other fields still edit as before
    const rename = await api('PUT', `/sales/${saleId}`, owner.token, { customer_name: 'Verify Bag Buyer' });
    assert(rename.status === 200, `name edit: ${rename.status} ${JSON.stringify(rename.body)}`);
    const after = await db.prepare('SELECT customer_name FROM sales WHERE id = ?').get(saleId);
    assert(after.customer_name === 'Verify Bag Buyer', `name: ${after.customer_name}`);
    const paysAfter = await paymentsOf(saleId);
    assert(paysAfter.length === 1 && paysAfter[0].held_by === helper.id, `held_by lost by a name edit: ${JSON.stringify(paysAfter)}`);
  } finally {
    await restoreCashMode();
  }
});

// ---------------------------------------------------------------------------
// Task 3: bag API (list, reveal, float, blind handover) and the mode switch,
// all through the real routes.

const REGISTER_CLOSED_COPY = "Register isn't open — open it before taking a cash payment.";
const HELPER_DENIED_COPY = "Helpers can't open this. Ask the counter.";
const ALREADY_COLLECTED_COPY = 'Already collected — refresh';
const overCountCopy = (name) => `That's more than ${name} should have — count again or choose "Yes, settle"`;

async function giveFloat(token, staffId, amount) {
  return api('POST', '/helper-cash/float', token, { staff_id: staffId, location_id: TEST_LOCATION_ID, amount });
}
async function handover(token, staffId, counted, isFinal) {
  return api('POST', '/helper-cash/handover', token, { staff_id: staffId, location_id: TEST_LOCATION_ID, counted_amount: counted, is_final: isFinal });
}
async function listAs(token) {
  return api('GET', `/helper-cash/bags?location_id=${TEST_LOCATION_ID}`, token);
}
async function helperName(id) {
  const db = await getDb();
  return (await db.prepare('SELECT name FROM users WHERE id = ?').get(id)).name;
}

check('bags list is masked', async () => {
  const owner = await loginOwner();
  const helper = await helperSession(owner.token);
  try {
    await setCashMode('bag');
    await openOwnRegister(owner.token, 2000);
    const f = await giveFloat(owner.token, helper.id, 500);
    assert(f.status === 201, `float: ${f.status} ${JSON.stringify(f.body)}`);
    const s = await helperSale(helper.token, [{ method: 'cash', amount: 345 }]);
    assert(s.status === 201, `sale: ${s.status}`);
    const r = await listAs(owner.token);
    assert(r.status === 200 && r.body?.data?.mode === 'bag', `list: ${r.status} ${JSON.stringify(r.body)}`);
    const row = r.body.data.bags.find((b) => b.staff_id === helper.id);
    assert(row && row.held_masked === '₹8xx' && row.sale_count === 1 && row.access_ended === false, `row: ${JSON.stringify(row)}`);
    assert(!('held' in row), `exact amount leaked: ${JSON.stringify(row)}`);
    assert(typeof r.body.data.total_masked === 'string' && /^₹[\dx,]+$/.test(r.body.data.total_masked) && !/\d{2}/.test(r.body.data.total_masked.replace(/,/g, '')), `total_masked: ${r.body.data.total_masked}`);
    assert(!JSON.stringify(r.body).includes('845'), 'exact amount somewhere in the list response');
  } finally {
    await restoreCashMode();
  }
});

check('reveal returns exact and is audited', async () => {
  const owner = await loginOwner();
  const helper = await helperSession(owner.token);
  const db = await getDb();
  try {
    await setCashMode('bag');
    await openOwnRegister(owner.token, 2000);
    assert((await giveFloat(owner.token, helper.id, 200)).status === 201, 'float 200');
    assert((await giveFloat(owner.token, helper.id, '500.50')).status === 201, 'float 500.50');
    const s = await helperSale(helper.token, [{ method: 'cash', amount: 345 }]);
    assert(s.status === 201, `sale: ${s.status}`);
    const r = await api('POST', `/helper-cash/bags/${helper.id}/reveal`, owner.token, { location_id: TEST_LOCATION_ID });
    assert(r.status === 200, `reveal: ${r.status} ${JSON.stringify(r.body)}`);
    const d = r.body.data;
    assert(near(d.held, 1045.5) && near(d.floats, 700.5) && near(d.cash_sales, 345) && near(d.settled, 0), `figures: ${JSON.stringify(d)}`);
    assert(d.last_float && near(d.last_float.amount, 500.5), `last_float: ${JSON.stringify(d.last_float)}`);
    const audit = await db.prepare("SELECT user_id FROM audit_logs WHERE action = 'helper_bag_reveal' AND entity_type = 'user' AND entity_id = ? ORDER BY id DESC LIMIT 1").get(helper.id);
    assert(audit && audit.user_id === owner.id, `audit row: ${JSON.stringify(audit)}`);
  } finally {
    await restoreCashMode();
  }
});

check('helper sees only own bag', async () => {
  const owner = await loginOwner();
  const a = await helperSession(owner.token);
  const b = await helperSession(owner.token);
  try {
    await setCashMode('bag');
    await openOwnRegister(owner.token, 2000);
    assert((await giveFloat(owner.token, a.id, 300)).status === 201, 'float a');
    assert((await giveFloat(owner.token, b.id, 400)).status === 201, 'float b');
    const r = await listAs(a.token);
    assert(r.status === 200 && r.body.data.bags.length === 1 && r.body.data.bags[0].staff_id === a.id, `helper list: ${r.status} ${JSON.stringify(r.body)}`);
    assert(r.body.data.bags[0].held_masked === '₹3xx' && r.body.data.total_masked === '₹3xx', `helper masks: ${JSON.stringify(r.body.data)}`);
    const own = await api('POST', `/helper-cash/bags/${a.id}/reveal`, a.token, { location_id: TEST_LOCATION_ID });
    assert(own.status === 200 && near(own.body.data.held, 300), `own reveal: ${own.status} ${JSON.stringify(own.body)}`);
    const other = await api('POST', `/helper-cash/bags/${b.id}/reveal`, a.token, { location_id: TEST_LOCATION_ID });
    assert(other.status === 403 && other.body?.message === HELPER_DENIED_COPY, `other reveal: ${other.status} ${JSON.stringify(other.body)}`);
    const fl = await giveFloat(a.token, a.id, 50);
    assert(fl.status === 403, `helper gave a float: ${fl.status}`);
    const ho = await handover(a.token, a.id, 50, false);
    assert(ho.status === 403, `helper ran a handover: ${ho.status}`);
  } finally {
    await restoreCashMode();
  }
});

check('float picker lists idle helpers, has_cash flags', async () => {
  const owner = await loginOwner();
  const busy = await helperSession(owner.token);
  const idle = await helperSession(owner.token);
  try {
    await setCashMode('bag');
    await openOwnRegister(owner.token, 2000);
    assert((await giveFloat(owner.token, busy.id, 250)).status === 201, 'float busy');
    const plain = await listAs(owner.token);
    assert(plain.status === 200 && !('helpers' in plain.body.data), `helpers sent without include_idle: ${JSON.stringify(plain.body.data)}`);
    assert(plain.body.data.has_cash === true, `total has_cash: ${JSON.stringify(plain.body.data)}`);
    const row = plain.body.data.bags.find((b) => b.staff_id === busy.id);
    assert(row && row.has_cash === true, `row has_cash: ${JSON.stringify(row)}`);
    assert(!plain.body.data.bags.some((b) => b.staff_id === idle.id), 'idle helper in bags');
    const r = await api('GET', `/helper-cash/bags?location_id=${TEST_LOCATION_ID}&include_idle=1`, owner.token);
    const hs = r.body?.data?.helpers || [];
    const hi = hs.find((h) => h.staff_id === idle.id);
    const hb = hs.find((h) => h.staff_id === busy.id);
    assert(hi && hi.last_float === null, `idle helper: ${JSON.stringify(hs)}`);
    assert(hb && near(hb.last_float, 250), `busy helper last_float: ${JSON.stringify(hb)}`);
    const own = await api('GET', `/helper-cash/bags?location_id=${TEST_LOCATION_ID}&include_idle=1`, idle.token);
    assert(own.status === 200 && !('helpers' in own.body.data), `helper got the picker: ${JSON.stringify(own.body)}`);
  } finally {
    await restoreCashMode();
  }
});

async function counterSession(ownerToken) {
  const res = await api('POST', '/users', ownerToken, {
    name: `Verify Bag Counter ${phoneSeq + 1}`, phone: testPhone(), password: crypto.randomBytes(9).toString('base64url'),
    role: 'counter_staff', location_ids: [TEST_LOCATION_ID],
  });
  assert(res.status === 201, `create counter: ${res.status} ${JSON.stringify(res.body)}`);
  const id = res.body.data.user.id;
  createdUserIds.push(id);
  const db = await getDb();
  await db.prepare('UPDATE users SET pin_hash = ?, pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = ?')
    .run(await hashPin(HELPER_PIN), id);
  const login = await api('POST', '/auth/staff-login', null, { employee_code: res.body.data.user.employee_code, pin: HELPER_PIN });
  assert(login.status === 200 && login.body?.data?.token, `counter login: ${login.status} ${JSON.stringify(login.body)}`);
  return { id, token: login.body.data.token };
}

check('count lock follows handover and float', async () => {
  const owner = await loginOwner();
  const helper = await helperSession(owner.token);
  const counter = await counterSession(owner.token);
  const db = await getDb();
  try {
    await setCashMode('bag');
    const regId = await openOwnRegister(owner.token, 2000);
    assert((await giveFloat(owner.token, helper.id, 500)).status === 201, 'float 500');
    const s = await helperSale(helper.token, [{ method: 'cash', amount: 300 }]);
    assert(s.status === 201, `sale: ${s.status}`);
    // drawer expected 1500; counting 1600 offers extra cash and locks the count
    const pv = await api('PUT', '/sales/register/close', counter.token, { location_id: TEST_LOCATION_ID, actual_cash: 1600, preview: true });
    assert(pv.status === 200, `preview: ${pv.status} ${JSON.stringify(pv.body)}`);
    const lockOf = async () => Number((await db.prepare('SELECT close_count_locked FROM cash_registers WHERE id = ?').get(regId)).close_count_locked);
    assert(near(await lockOf(), 1600), `lock not set: ${await lockOf()}`);
    const ho = await api('POST', '/helper-cash/handover', counter.token, { staff_id: helper.id, location_id: TEST_LOCATION_ID, counted_amount: 200, is_final: false });
    assert(ho.status === 200, `handover: ${ho.status} ${JSON.stringify(ho.body)}`);
    assert(near(await lockOf(), 1800), `lock after handover: ${await lockOf()}`);
    const old = await api('PUT', '/sales/register/close', counter.token, { location_id: TEST_LOCATION_ID, actual_cash: 1600, preview: true });
    assert(old.status === 409 && old.body?.code === 'COUNT_LOCKED', `old count: ${old.status} ${JSON.stringify(old.body)}`);
    const fl = await giveFloat(counter.token, helper.id, 100);
    assert(fl.status === 201, `float 100: ${fl.status}`);
    assert(near(await lockOf(), 1700), `lock after float: ${await lockOf()}`);
    const stale = await api('PUT', '/sales/register/close', counter.token, { location_id: TEST_LOCATION_ID, actual_cash: 1800 });
    assert(stale.status === 409 && stale.body?.code === 'COUNT_LOCKED', `stale count: ${stale.status} ${JSON.stringify(stale.body)}`);
    const close = await api('PUT', '/sales/register/close', counter.token, { location_id: TEST_LOCATION_ID, actual_cash: 1700 });
    assert(close.status === 200, `close: ${close.status} ${JSON.stringify(close.body)}`);
    assert(near(close.body.data.discrepancy, -100), `discrepancy: ${close.body.data.discrepancy}`);
  } finally {
    await restoreCashMode();
  }
});

check('float needs open register', async () => {
  const owner = await loginOwner();
  const helper = await helperSession(owner.token);
  const db = await getDb();
  try {
    await setCashMode('bag');
    const regId = await openOwnRegister(owner.token, 1000);
    for (const bad of [0, -5, '1.234', 'abc', null, 123456789]) {
      const r = await giveFloat(owner.token, helper.id, bad);
      assert(r.status === 400, `amount ${bad}: ${r.status} ${JSON.stringify(r.body)}`);
    }
    const tooBig = await handover(owner.token, helper.id, 123456789, true);
    assert(tooBig.status === 400, `handover 123456789: ${tooBig.status} ${JSON.stringify(tooBig.body)}`);
    const notHelper = await giveFloat(owner.token, owner.id, 100);
    assert(notHelper.status === 400, `float to owner: ${notHelper.status} ${JSON.stringify(notHelper.body)}`);

    const before = await registerRow(regId);
    const ok = await giveFloat(owner.token, helper.id, 250);
    assert(ok.status === 201 && ok.body.data.register_id === regId, `float: ${ok.status} ${JSON.stringify(ok.body)}`);
    const after = await registerRow(regId);
    assert(near(before.expected_cash - after.expected_cash, 250) && after.total_cash_sales === before.total_cash_sales, `register: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    const mv = await db.prepare("SELECT register_id, recorded_by, expected_amount FROM staff_cash_movements WHERE staff_id = ? AND type = 'float_out'").get(helper.id);
    assert(mv.register_id === regId && mv.recorded_by === owner.id && near(mv.expected_amount, 250), `movement: ${JSON.stringify(mv)}`);

    await closeOwnRegister(regId);
    const closed = await giveFloat(owner.token, helper.id, 100);
    assert(closed.status === 400 && closed.body?.message === REGISTER_CLOSED_COPY, `closed: ${closed.status} ${JSON.stringify(closed.body)}`);
    const ho = await handover(owner.token, helper.id, 100, false);
    assert(ho.status === 400 && ho.body?.message === REGISTER_CLOSED_COPY, `handover closed: ${ho.status} ${JSON.stringify(ho.body)}`);
    assert(near((await getBag(db, helper.id, TEST_LOCATION_ID)).held, 250), 'bag moved with the register closed');
  } finally {
    await restoreCashMode();
  }
});

check('handover response reveals expected only after count', async () => {
  const owner = await loginOwner();
  const helper = await helperSession(owner.token);
  try {
    await setCashMode('bag');
    const regId = await openOwnRegister(owner.token, 1000);
    const s = await helperSale(helper.token, [{ method: 'cash', amount: 3200 }]);
    assert(s.status === 201, `sale: ${s.status}`);
    const before = await registerRow(regId);
    // Only the count goes in: an "expected" the client might send is ignored
    const r = await api('POST', '/helper-cash/handover', owner.token, { staff_id: helper.id, location_id: TEST_LOCATION_ID, counted_amount: 3150, is_final: true, expected_amount: 3150 });
    assert(r.status === 200, `handover: ${r.status} ${JSON.stringify(r.body)}`);
    const d = r.body.data;
    assert(near(d.expected, 3200) && near(d.counted, 3150) && near(d.difference, -50) && near(d.remaining, 0), `response: ${JSON.stringify(d)}`);
    const after = await registerRow(regId);
    assert(near(after.expected_cash - before.expected_cash, 3150), `register moved by ${after.expected_cash - before.expected_cash}`);
    const db = await getDb();
    const mv = await db.prepare("SELECT expected_amount, counted_amount, settled_amount, difference, is_final, register_id FROM staff_cash_movements WHERE staff_id = ? AND type = 'handover_in'").get(helper.id);
    assert(near(mv.expected_amount, 3200) && near(mv.counted_amount, 3150) && near(mv.settled_amount, 3200) && near(mv.difference, -50) && Number(mv.is_final) === 1 && mv.register_id === regId, `movement: ${JSON.stringify(mv)}`);
  } finally {
    await restoreCashMode();
  }
});

check('partial handover keeps the rest', async () => {
  const owner = await loginOwner();
  const helper = await helperSession(owner.token);
  const db = await getDb();
  try {
    await setCashMode('bag');
    await openOwnRegister(owner.token, 1000);
    assert((await giveFloat(owner.token, helper.id, 500)).status === 201, 'float');
    assert((await helperSale(helper.token, [{ method: 'cash', amount: 345 }])).status === 201, 'sale');
    const name = await helperName(helper.id);

    const over = await handover(owner.token, helper.id, 900, false);
    assert(over.status === 400 && over.body?.message === overCountCopy(name), `over: ${over.status} ${JSON.stringify(over.body)}`);
    const zero = await handover(owner.token, helper.id, 0, false);
    assert(zero.status === 400, `partial 0: ${zero.status}`);

    const part = await handover(owner.token, helper.id, 300, false);
    assert(part.status === 200 && near(part.body.data.expected, 845) && near(part.body.data.remaining, 545) && near(part.body.data.difference, 0), `partial: ${part.status} ${JSON.stringify(part.body)}`);
    assert(near((await getBag(db, helper.id, TEST_LOCATION_ID)).held, 545), 'bag after partial');

    const fin = await handover(owner.token, helper.id, 540, true);
    assert(fin.status === 200 && near(fin.body.data.expected, 545) && near(fin.body.data.difference, -5) && near(fin.body.data.remaining, 0), `final: ${fin.status} ${JSON.stringify(fin.body)}`);
    assert(near((await getBag(db, helper.id, TEST_LOCATION_ID)).held, 0), 'bag after final');
    const again = await handover(owner.token, helper.id, 10, false);
    assert(again.status === 409 && again.body?.message === ALREADY_COLLECTED_COPY, `after final: ${again.status} ${JSON.stringify(again.body)}`);
  } finally {
    await restoreCashMode();
  }
});

check('double handover', async () => {
  const owner = await loginOwner();
  const helper = await helperSession(owner.token);
  const db = await getDb();
  try {
    await setCashMode('bag');
    const regId = await openOwnRegister(owner.token, 1000);
    assert((await helperSale(helper.token, [{ method: 'cash', amount: 700 }])).status === 201, 'sale');
    const before = await registerRow(regId);
    const [x, y] = await Promise.all([handover(owner.token, helper.id, 700, true), handover(owner.token, helper.id, 700, true)]);
    const codes = [x.status, y.status].sort();
    assert(codes[0] === 200 && codes[1] === 409, `statuses ${x.status} ${y.status}: ${JSON.stringify([x.body, y.body])}`);
    const loser = x.status === 409 ? x : y;
    assert(loser.body?.message === ALREADY_COLLECTED_COPY, `loser copy: ${JSON.stringify(loser.body)}`);
    const rows = await db.prepare("SELECT COUNT(*) AS c FROM staff_cash_movements WHERE staff_id = ? AND type = 'handover_in'").get(helper.id);
    assert(Number(rows.c) === 1, `handover rows: ${rows.c}`);
    const after = await registerRow(regId);
    assert(near(after.expected_cash - before.expected_cash, 700), `register moved by ${after.expected_cash - before.expected_cash}`);
    assert(near((await getBag(db, helper.id, TEST_LOCATION_ID)).held, 0), 'bag not 0');
  } finally {
    await restoreCashMode();
  }
});

check('expired helper bag still listed', async () => {
  const owner = await loginOwner();
  const helper = await helperSession(owner.token);
  const db = await getDb();
  try {
    await setCashMode('bag');
    await openOwnRegister(owner.token, 1000);
    assert((await giveFloat(owner.token, helper.id, 150)).status === 201, 'float');
    await db.prepare('UPDATE users SET access_until = ?, is_active = 0 WHERE id = ?').run(shopDate(-1), helper.id);
    const r = await listAs(owner.token);
    const row = r.body?.data?.bags?.find((b) => b.staff_id === helper.id);
    assert(row && row.held_masked === '₹1xx' && row.access_ended === true, `row: ${JSON.stringify(row)}`);
    const fl = await giveFloat(owner.token, helper.id, 50);
    assert(fl.status === 400, `float to expired helper: ${fl.status}`);
    const fin = await handover(owner.token, helper.id, 150, true);
    assert(fin.status === 200 && near(fin.body.data.difference, 0), `collect: ${fin.status} ${JSON.stringify(fin.body)}`);
    const r2 = await listAs(owner.token);
    assert(!r2.body.data.bags.some((b) => b.staff_id === helper.id), 'settled expired helper still listed');
  } finally {
    await restoreCashMode();
  }
});

check('close through float and handover routes', async () => {
  const owner = await loginOwner();
  const helper = await helperSession(owner.token);
  try {
    await setCashMode('bag');
    const regId = await openOwnRegister(owner.token, 1000);
    assert((await giveFloat(owner.token, helper.id, 300)).status === 201, 'float');
    assert((await helperSale(helper.token, [{ method: 'cash', amount: 400 }])).status === 201, 'sale 1');
    assert((await helperSale(helper.token, [{ method: 'cash', amount: 200 }])).status === 201, 'sale 2');
    const p = await handover(owner.token, helper.id, 250, false);
    assert(p.status === 200 && near(p.body.data.remaining, 650), `partial: ${JSON.stringify(p.body)}`);
    const f = await handover(owner.token, helper.id, 640, true);
    assert(f.status === 200 && near(f.body.data.difference, -10), `final: ${JSON.stringify(f.body)}`);
    const running = await registerRow(regId);
    assert(near(running.expected_cash, 1590), `running expected_cash ${running.expected_cash}`);
    const { preview, close } = await previewAndClose(owner.token, regId, 1590);
    assert(near(preview.expected_cash, 1590) && near(preview.discrepancy, 0), `preview ${JSON.stringify(preview)}`);
    assert(near(close.expected_cash, 1590) && near(close.discrepancy, 0), `close ${close.expected_cash}/${close.discrepancy}`);

    // Closing twice: the second close finds no open register
    const again = await api('PUT', '/sales/register/close', owner.token, { location_id: TEST_LOCATION_ID, actual_cash: 1590 });
    assert(again.status === 404, `second close: ${again.status}`);
  } finally {
    await restoreCashMode();
  }
});

check('inferred expenses ignore floats and handovers', async () => {
  const owner = await loginOwner();
  const helper = await helperSession(owner.token);
  try {
    await setCashMode('bag');
    const regId = await openOwnRegister(owner.token, 1000);
    assert((await giveFloat(owner.token, helper.id, 400)).status === 201, 'float');
    assert((await helperSale(helper.token, [{ method: 'cash', amount: 250 }])).status === 201, 'sale');
    assert((await handover(owner.token, helper.id, 500, false)).status === 200, 'handover');
    await previewAndClose(owner.token, regId, 1100);
    const st = await api('GET', `/sales/register/status?location_id=${TEST_LOCATION_ID}`, owner.token);
    assert(st.status === 200 && st.body.data && st.body.data.id === regId && st.body.data.closed_at, `status shows register ${st.body?.data?.id}, wanted closed ${regId}`);
    assert(near(st.body.data.total_expenses_cash, 0), `inferred expenses ${st.body.data.total_expenses_cash}`);
  } finally {
    await restoreCashMode();
  }
});

const BAGS_OFF_COPY = 'Helper cash bags are off. The owner can turn them on in Settings.';

async function auditRows(action, helperId) {
  const db = await getDb();
  const rows = await db.prepare("SELECT user_id, new_state FROM audit_logs WHERE action = ? AND entity_type = 'user' AND entity_id = ? ORDER BY id").all(action, helperId);
  return rows.map((r) => ({ user_id: r.user_id, state: typeof r.new_state === 'string' ? JSON.parse(r.new_state) : r.new_state }));
}

check('handover preview changes nothing', async () => {
  const owner = await loginOwner();
  const helper = await helperSession(owner.token);
  const db = await getDb();
  try {
    await setCashMode('bag');
    const regId = await openOwnRegister(owner.token, 1000);
    assert((await giveFloat(owner.token, helper.id, 500)).status === 201, 'float');
    assert((await helperSale(helper.token, [{ method: 'cash', amount: 345 }])).status === 201, 'sale');
    const bagBefore = await getBag(db, helper.id, TEST_LOCATION_ID);
    const regBefore = await registerRow(regId);
    const mvBefore = await db.prepare('SELECT COUNT(*) AS c FROM staff_cash_movements WHERE staff_id = ?').get(helper.id);

    const p = await api('POST', '/helper-cash/handover', owner.token, { staff_id: helper.id, location_id: TEST_LOCATION_ID, counted_amount: 800, preview: true });
    assert(p.status === 200 && p.body.data.preview === true, `preview: ${p.status} ${JSON.stringify(p.body)}`);
    const d = p.body.data;
    assert(near(d.expected, 845) && near(d.counted, 800) && near(d.difference, -45) && near(d.remaining_if_partial, 45), `figures: ${JSON.stringify(d)}`);
    const over = await api('POST', '/helper-cash/handover', owner.token, { staff_id: helper.id, location_id: TEST_LOCATION_ID, counted_amount: 900, preview: true });
    assert(over.status === 200 && near(over.body.data.difference, 55) && near(over.body.data.remaining_if_partial, 0), `over preview: ${JSON.stringify(over.body)}`);
    for (const odd of [1, '1', 'true', 'yes']) {
      const r = await api('POST', '/helper-cash/handover', owner.token, { staff_id: helper.id, location_id: TEST_LOCATION_ID, counted_amount: 800, preview: odd, is_final: 1 });
      assert(r.status === 400, `preview ${JSON.stringify(odd)} should be refused: ${r.status}`);
    }
    const zero = await api('POST', '/helper-cash/handover', owner.token, { staff_id: helper.id, location_id: TEST_LOCATION_ID, counted_amount: 0, preview: true });
    assert(zero.status === 400, `zero preview: ${zero.status}`);

    assert(JSON.stringify(await getBag(db, helper.id, TEST_LOCATION_ID)) === JSON.stringify(bagBefore), 'bag moved');
    assert(JSON.stringify(await registerRow(regId)) === JSON.stringify(regBefore), 'register moved');
    const mvAfter = await db.prepare('SELECT COUNT(*) AS c FROM staff_cash_movements WHERE staff_id = ?').get(helper.id);
    assert(Number(mvAfter.c) === Number(mvBefore.c), 'movement written');
    const audits = await auditRows('helper_bag_handover_preview', helper.id);
    assert(audits.length === 2 && audits[0].user_id === owner.id && near(audits[0].state.counted, 800) && !('expected' in audits[0].state), `preview audit: ${JSON.stringify(audits)}`);
    assert((await auditRows('helper_bag_reveal', helper.id)).length === 0, 'preview counted as a reveal');

    // Settled: preview answers Already collected
    assert((await handover(owner.token, helper.id, 845, true)).status === 200, 'final');
    const after = await api('POST', '/helper-cash/handover', owner.token, { staff_id: helper.id, location_id: TEST_LOCATION_ID, counted_amount: 10, preview: true });
    assert(after.status === 409 && after.body?.message === ALREADY_COLLECTED_COPY, `preview at 0: ${after.status} ${JSON.stringify(after.body)}`);
  } finally {
    await restoreCashMode();
  }
});

check('every handover is audited', async () => {
  const owner = await loginOwner();
  const helper = await helperSession(owner.token);
  try {
    await setCashMode('bag');
    await openOwnRegister(owner.token, 1000);
    assert((await giveFloat(owner.token, helper.id, 600)).status === 201, 'float');
    assert((await handover(owner.token, helper.id, 200, false)).status === 200, 'partial');
    assert((await handover(owner.token, helper.id, 390, true)).status === 200, 'final');
    const rows = await auditRows('helper_bag_handover', helper.id);
    assert(rows.length === 2, `audit rows: ${JSON.stringify(rows)}`);
    assert(near(rows[0].state.counted, 200) && rows[0].state.is_final === false && rows[0].user_id === owner.id, `partial audit: ${JSON.stringify(rows[0])}`);
    assert(near(rows[1].state.counted, 390) && rows[1].state.is_final === true, `final audit: ${JSON.stringify(rows[1])}`);
  } finally {
    await restoreCashMode();
  }
});

check('float only in bag mode', async () => {
  const owner = await loginOwner();
  const helper = await helperSession(owner.token);
  const db = await getDb();
  try {
    await setCashMode('bag');
    const regId = await openOwnRegister(owner.token, 1000);
    assert((await giveFloat(owner.token, helper.id, 300)).status === 201, 'float in bag mode');
    await setCashMode('register');
    const before = await registerRow(regId);
    const r = await giveFloat(owner.token, helper.id, 100);
    assert(r.status === 409 && r.body?.message === BAGS_OFF_COPY, `float in register mode: ${r.status} ${JSON.stringify(r.body)}`);
    assert(JSON.stringify(await registerRow(regId)) === JSON.stringify(before), 'register moved');
    // Cash still out from bag mode can be collected in register mode
    const h2 = await handover(owner.token, helper.id, 300, true);
    assert(h2.status === 200 && near(h2.body.data.expected, 300), `handover in register mode: ${h2.status} ${JSON.stringify(h2.body)}`);
    assert(near((await getBag(db, helper.id, TEST_LOCATION_ID)).held, 0), 'bag not 0');
  } finally {
    await restoreCashMode();
  }
});

// Task 5: the owner's Staff sales report carries the helper bag figures.
// Same scenario as 'close counts floats and handovers', built through the
// real float and handover routes, plus two reveals and one handover preview
// (a preview is not a reveal).
function shopToday() { return shopDate(0); }

check('staff sales report includes bag columns', async () => {
  const owner = await loginOwner();
  const helper = await helperSession(owner.token);
  try {
    await setCashMode('bag');
    await openOwnRegister(owner.token, 1000);
    assert((await giveFloat(owner.token, helper.id, 300)).status === 201, 'float');
    assert((await helperSale(helper.token, [{ method: 'cash', amount: 400 }])).status === 201, 'sale 1');
    assert((await helperSale(helper.token, [{ method: 'cash', amount: 200 }])).status === 201, 'sale 2');
    const upi = await helperSale(helper.token, [{ method: 'upi', amount: 150 }]);
    assert(upi.status === 201, `upi sale: ${upi.status}`);
    for (let i = 0; i < 2; i += 1) {
      const r = await api('POST', `/helper-cash/bags/${helper.id}/reveal`, owner.token, { location_id: TEST_LOCATION_ID });
      assert(r.status === 200, `reveal ${i}: ${r.status}`);
    }
    const pv = await api('POST', '/helper-cash/handover', owner.token, { staff_id: helper.id, location_id: TEST_LOCATION_ID, counted_amount: 250, preview: true });
    assert(pv.status === 200, `preview: ${pv.status}`);
    assert((await handover(owner.token, helper.id, 250, false)).status === 200, 'partial');
    const f = await handover(owner.token, helper.id, 640, true);
    assert(f.status === 200 && near(f.body.data.difference, -10), `final: ${JSON.stringify(f.body)}`);

    const today = shopToday();
    const rep = await api('GET', `/reports/staff-sales?from=${today}&to=${today}&location_id=${TEST_LOCATION_ID}`, owner.token);
    assert(rep.status === 200, `report: ${rep.status} ${JSON.stringify(rep.body)}`);
    const row = rep.body.data.rows.find((r) => r.user_id === helper.id);
    assert(row && row.role === 'helper', `helper row: ${JSON.stringify(row)}`);
    assert(row.orders === 3, `orders ${row.orders}`);
    assert(near(row.floats, 300), `floats ${row.floats}`);
    assert(near(row.cash_collected, 600), `cash_collected ${row.cash_collected} (UPI must not count)`);
    assert(near(row.handed_over, 890), `handed_over ${row.handed_over}`);
    assert(near(row.short_over, -10), `short_over ${row.short_over}`);
    assert(row.reveals === 2, `reveals ${row.reveals} (previews and handovers are not reveals)`);
    for (const r of rep.body.data.rows) {
      if (r.role === 'helper') continue;
      for (const k of ['floats', 'cash_collected', 'handed_over', 'short_over', 'reveals']) {
        assert(r[k] == null, `non-helper ${r.user_id} (${r.role}) has ${k}=${r[k]}`);
      }
    }

    // All locations: the same figures
    const all = await api('GET', `/reports/staff-sales?from=${today}&to=${today}`, owner.token);
    const allRow = all.body.data.rows.find((r) => r.user_id === helper.id);
    assert(allRow && near(allRow.floats, 300) && near(allRow.handed_over, 890) && allRow.reveals === 2, `all locations: ${JSON.stringify(allRow)}`);

    // Another location and another day: none of it
    const db = await getDb();
    const other = await db.prepare('SELECT id FROM locations WHERE id <> ? ORDER BY id LIMIT 1').get(TEST_LOCATION_ID);
    if (other) {
      const o = await api('GET', `/reports/staff-sales?from=${today}&to=${today}&location_id=${other.id}`, owner.token);
      const oRow = o.body.data.rows.find((r) => r.user_id === helper.id);
      assert(!oRow || (Number(oRow.floats || 0) === 0 && Number(oRow.cash_collected || 0) === 0 && Number(oRow.handed_over || 0) === 0 && Number(oRow.reveals || 0) === 0), `other location: ${JSON.stringify(oRow)}`);
    }
    const y = shopDate(-1);
    const yRep = await api('GET', `/reports/staff-sales?from=${y}&to=${y}`, owner.token);
    assert(!yRep.body.data.rows.some((r) => r.user_id === helper.id), 'helper listed yesterday');

    // An undone sale's held cash is not cash collected
    const s3 = await helperSale(helper.token, [{ method: 'cash', amount: 75 }]);
    assert(s3.status === 201, `sale 3: ${s3.status}`);
    const undo = await api('POST', `/quick-sale/${s3.body.data.id}/undo`, helper.token, {});
    assert(undo.status === 200, `undo: ${undo.status} ${JSON.stringify(undo.body)}`);
    const after = (await api('GET', `/reports/staff-sales?from=${today}&to=${today}`, owner.token)).body.data.rows.find((r) => r.user_id === helper.id);
    assert(near(after.cash_collected, 600), `cash_collected after undo ${after.cash_collected}`);
  } finally {
    await restoreCashMode();
  }
});

// Settles every bag this script left non-zero (by SQL, no register), so the
// mode switch can be tried with all bags empty. Refuses when anyone else
// holds cash: those are not this script's to settle.
async function settleOwnBags() {
  const db = await getDb();
  const locations = await db.prepare('SELECT id FROM locations').all();
  for (const loc of locations) {
    for (const b of await listBags(db, loc.id)) {
      if (Math.round(b.held * 100) === 0) continue;
      assert(createdUserIds.includes(b.staff_id), `${b.name} (not created by this script) holds cash at location ${loc.id}; cannot test the empty-bag switch`);
      await db.prepare("INSERT INTO staff_cash_movements (location_id, staff_id, type, expected_amount, counted_amount, settled_amount, is_final, note) VALUES (?, ?, 'handover_in', ?, ?, ?, 1, 'verify settle')")
        .run(loc.id, b.staff_id, b.held, b.held, b.held);
    }
  }
}

check('mode switch refused with cash out', async () => {
  const owner = await loginOwner();
  const helper = await helperSession(owner.token);
  const db = await getDb();
  try {
    await setCashMode('bag');
    await openOwnRegister(owner.token, 1000);
    assert((await giveFloat(owner.token, helper.id, 5234)).status === 201, 'float');
    const name = await helperName(helper.id);
    const r = await api('PUT', '/settings', owner.token, { settings: { helper_cash_mode: 'register' } });
    assert(r.status === 409 && /^Collect the cash from .+ first \(₹[\dx,]+\)\.$/.test(r.body?.message || '') && r.body.message.includes(name), `switch: ${r.status} ${JSON.stringify(r.body)}`);
    const mode = await db.prepare("SELECT value FROM settings WHERE key = 'helper_cash_mode'").get();
    assert(mode.value === 'bag', `mode changed to ${mode.value}`);
    // Saving the same value is not a switch
    const same = await api('PUT', '/settings', owner.token, { settings: { helper_cash_mode: 'bag' } });
    assert(same.status === 200, `same value: ${same.status} ${JSON.stringify(same.body)}`);
    const bad = await api('PUT', '/settings', owner.token, { settings: { helper_cash_mode: 'pocket' } });
    assert(bad.status === 400, `bad value: ${bad.status}`);

    // Only this helper holds cash: exact copy
    await settleOwnBags();
    await db.prepare("DELETE FROM staff_cash_movements WHERE staff_id = ? AND note = 'verify settle'").run(helper.id);
    const exact = await api('PUT', '/settings', owner.token, { settings: { helper_cash_mode: 'register' } });
    assert(exact.status === 409 && exact.body?.message === `Collect the cash from ${name} first (₹5,xxx).`, `exact copy: ${exact.status} ${JSON.stringify(exact.body)}`);
  } finally {
    await restoreCashMode();
  }
});

check('mode switch allowed when bags are empty', async () => {
  const owner = await loginOwner();
  const db = await getDb();
  try {
    await setCashMode('bag');
    await settleOwnBags();
    const toRegister = await api('PUT', '/settings', owner.token, { settings: { helper_cash_mode: 'register' } });
    assert(toRegister.status === 200, `bag -> register: ${toRegister.status} ${JSON.stringify(toRegister.body)}`);
    assert((await db.prepare("SELECT value FROM settings WHERE key = 'helper_cash_mode'").get()).value === 'register', 'not register');
    const toBag = await api('PUT', '/settings', owner.token, { settings: { helper_cash_mode: 'bag' } });
    assert(toBag.status === 200, `register -> bag: ${toBag.status} ${JSON.stringify(toBag.body)}`);
    assert((await db.prepare("SELECT value FROM settings WHERE key = 'helper_cash_mode'").get()).value === 'bag', 'not bag');
  } finally {
    await restoreCashMode();
  }
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
  for (const id of createdRegisterIds) {
    try {
      await db.prepare("DELETE FROM audit_logs WHERE entity_type = 'cash_register' AND entity_id = ?").run(id);
    } catch (err) {
      console.error(`   (cleanup warning: register audit ${id}: ${err.message})`);
    }
  }
  console.log(`Cleaned up ${saleIds.length} sale(s), ${createdProductIds.length} product(s), ${createdUserIds.length} user(s)`);
}

h.run({ cleanup });
