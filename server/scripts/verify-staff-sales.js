#!/usr/bin/env node
/**
 * Live verification of staff sales tracking (sales.sold_by). Local dev only.
 *
 * Usage: VERIFY_OWNER_PHONE=... VERIFY_OWNER_PASSWORD=... node scripts/verify-staff-sales.js
 */
const h = require('./lib/verify-harness');

const { check, api, loginOwner, openRegister, assert, getDb, TEST_LOCATION_ID } = h;

const SELLER_MESSAGE = "That person can't be picked as the seller here. Tap Sold by and pick someone else, or pick Me.";
const createdSaleIds = [];
const createdUserIds = [];
let counter = 0;

async function createUser(ownerToken, role, locationIds) {
  counter += 1;
  const phone = '9' + String(Date.now()).slice(-7) + String(counter).padStart(2, '0');
  const body = { name: `StaffSalesTest ${role} ${counter}`, phone, password: 'testpass123', role };
  if (locationIds) body.location_ids = locationIds;
  const res = await api('POST', '/users', ownerToken, body);
  if (res.status !== 201 && res.status !== 200) throw new Error(`Could not create ${role}: ${res.status} ${JSON.stringify(res.body)}`);
  const id = res.body.data.id || res.body.data.user?.id;
  createdUserIds.push(id);
  return id;
}

function saleBody(extra = {}) {
  return {
    location_id: TEST_LOCATION_ID, order_type: 'walk_in', channel: 'walk_in', skip_assignment: true,
    items: [{ quantity: 1, unit_price: 100, product_name: 'Staff sales test item' }],
    payments: [{ method: 'upi', amount: 100 }],
    ...extra,
  };
}

async function place(token, extra) {
  const res = await api('POST', '/sales', token, saleBody(extra));
  if (res.body?.data?.id) createdSaleIds.push(res.body.data.id);
  return res;
}

async function soldByOf(id) {
  const db = await getDb();
  return (await db.prepare('SELECT sold_by, created_by FROM sales WHERE id = ?').get(id));
}

check('sale without sold_by records the caller', async () => {
  const owner = await loginOwner();
  const res = await place(owner.token);
  assert(res.status === 201 || res.status === 200, `status ${res.status} ${JSON.stringify(res.body)}`);
  const row = await soldByOf(res.body.data.id);
  assert(row.sold_by === owner.id, `sold_by ${row.sold_by}, owner ${owner.id}`);
});

check('sold_by of a counter_staff at the same location is stored', async () => {
  const owner = await loginOwner();
  const staffId = await createUser(owner.token, 'counter_staff', [TEST_LOCATION_ID]);
  const res = await place(owner.token, { sold_by: staffId });
  assert(res.status === 201 || res.status === 200, `status ${res.status} ${JSON.stringify(res.body)}`);
  const row = await soldByOf(res.body.data.id);
  assert(row.sold_by === staffId, `sold_by ${row.sold_by}`);
  assert(row.created_by === owner.id, `created_by ${row.created_by}`);
});

check('invalid sold_by refused with no sale row', async () => {
  const owner = await loginOwner();
  const db = await getDb();
  const customerId = await createUser(owner.token, 'customer');
  const otherLocStaff = await createUser(owner.token, 'counter_staff', [1]);
  for (const bad of [customerId, otherLocStaff, 99999999]) {
    const before = (await db.prepare('SELECT COUNT(*) AS c FROM sales').get()).c;
    const res = await place(owner.token, { sold_by: bad });
    assert(res.status === 400, `sold_by ${bad}: expected 400, got ${res.status}`);
    assert(res.body.message === SELLER_MESSAGE, `message: ${res.body.message}`);
    const after = (await db.prepare('SELECT COUNT(*) AS c FROM sales').get()).c;
    assert(Number(before) === Number(after), `sale row created for ${bad}`);
  }
});

check('quick entries get sold_by too', async () => {
  const owner = await loginOwner();
  await openRegister(owner.token, TEST_LOCATION_ID, 100);
  const res = await place(owner.token, { entry_mode: 'quick', payments: [{ method: 'cash', amount: 100 }] });
  assert(res.status === 201 || res.status === 200, `status ${res.status} ${JSON.stringify(res.body)}`);
  const row = await soldByOf(res.body.data.id);
  assert(row.sold_by === owner.id, `sold_by ${row.sold_by}`);
});

// ---------- Task 2: owner-only report ----------
function localDay(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const TODAY = localDay(0);
const phones = {};

async function loginAs(userId) {
  const db = await getDb();
  const u = await db.prepare('SELECT phone FROM users WHERE id = ?').get(userId);
  const res = await api('POST', '/auth/login', null, { phone: u.phone, password: 'testpass123' });
  assert(res.status === 200, `login ${res.status}`);
  return res.body.data.token;
}

const report = (token, q) => api('GET', `/reports/staff-sales?location_id=${TEST_LOCATION_ID}${q || ''}`, token);
const rowOf = (res, id) => res.body.data.rows.find((r) => r.user_id === id);
let fixture = null;

// Builds sellers A (3 counted sales, 1 refund, 1 discount override, 1 cancelled), B (1 sale + close top-up),
// C (23:50 sale, then deactivated), plus an undone quick sale sold by A but undone by the owner.
async function build() {
  if (fixture) return fixture;
  const owner = await loginOwner();
  const db = await getDb();
  await openRegister(owner.token, TEST_LOCATION_ID, 100);
  const A = await createUser(owner.token, 'counter_staff', [TEST_LOCATION_ID]);
  const B = await createUser(owner.token, 'counter_staff', [TEST_LOCATION_ID]);
  const C = await createUser(owner.token, 'counter_staff', [TEST_LOCATION_ID]);
  const item = (price) => [{ quantity: 1, unit_price: price, product_name: 'Staff sales test item' }];
  const mk = async (who, price, extra = {}) => {
    const r = await place(owner.token, { sold_by: who, items: item(price), payments: [{ method: 'upi', amount: price }], ...extra });
    assert(r.status === 201 || r.status === 200, `sale: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.data.id;
  };
  const f = { owner, A, B, C };
  f.a1 = await mk(A, 100);
  f.a2 = await mk(A, 250);
  f.a3 = await mk(A, 100, { discount_type: 'fixed', discount_value: 10, payments: [{ method: 'upi', amount: 90 }] });
  f.a4 = await mk(A, 300);
  await db.prepare('UPDATE sales SET discount_approved_by = ? WHERE id = ?').run(owner.id, f.a3);
  await db.prepare("UPDATE sales SET status = 'cancelled' WHERE id = ?").run(f.a4);
  await db.prepare("INSERT INTO refunds (sale_id, amount, reason, status, requested_by, approved_by, refund_method) VALUES (?, 40, 'test', 'processed', ?, ?, 'upi')").run(f.a2, owner.id, owner.id);
  await db.prepare("INSERT INTO refunds (sale_id, amount, reason, status, requested_by, approved_by, refund_method) VALUES (?, 999, 'test', 'rejected', ?, ?, 'upi')").run(f.a2, owner.id, owner.id);
  f.b1 = await mk(B, 100);
  f.b2 = await mk(B, 60);
  await db.prepare("UPDATE sales SET entry_mode = 'close_topup', created_by = ? WHERE id = ?").run(B, f.b2);
  f.c1 = await mk(C, 75);
  // created_at is stored in UTC: stamp 23:50 on the shop's clock, not 23:50 UTC
  // (05:20 the next morning in India).
  await db.prepare("UPDATE sales SET created_at = (?::timestamp AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'UTC' WHERE id = ?").run(`${TODAY} 23:50:00`, f.c1);
  await db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(C);
  f.q = await mk(A, 20, { entry_mode: 'quick', payments: [{ method: 'cash', amount: 20 }] });
  const u = await api('POST', `/quick-sale/${f.q}/undo`, owner.token, {});
  assert(u.status === 200, `undo ${u.status} ${JSON.stringify(u.body)}`);
  fixture = f;
  return f;
}

async function grand(id) {
  const db = await getDb();
  return Number((await db.prepare('SELECT grand_total FROM sales WHERE id = ?').get(id)).grand_total);
}

check('report is owner only', async () => {
  const owner = await loginOwner();
  const mgr = await createUser(owner.token, 'manager', [TEST_LOCATION_ID]);
  const token = await loginAs(mgr);
  const r = await report(token);
  assert(r.status === 403, `manager got ${r.status}`);
  const r2 = await api('GET', `/reports/staff-sales/${owner.id}/sales`, token);
  assert(r2.status === 403, `manager list got ${r2.status}`);
  const r3 = await report(owner.token);
  assert(r3.status === 200 && Array.isArray(r3.body.data.rows), `owner got ${r3.status}`);
});

check('orders and amount per seller', async () => {
  const f = await build();
  const r = await report(f.owner.token);
  const a = rowOf(r, f.A), b = rowOf(r, f.B);
  const aAmount = 100 + 250 + await grand(f.a3);
  assert(a && a.orders === 3, `A orders ${a && a.orders}`);
  assert(Math.abs(a.amount - aAmount) < 0.01, `A amount ${a.amount} vs ${aAmount}`);
  assert(b && b.orders === 1 && Math.abs(b.amount - 100) < 0.01 && Math.abs(b.net - 100) < 0.01, `B ${JSON.stringify(b)}`);
  assert(b.topup_count === 1 && Math.abs(b.topup_total - 60) < 0.01, `B top-up ${b.topup_count}/${b.topup_total}`);
  assert(a.discount_count === 1 && Math.abs(a.discount_total - 10) < 0.01, `A discount ${a.discount_count}/${a.discount_total}`);
  assert(a.override_count === 1 && b.override_count === 0, `override ${a.override_count}/${b.override_count}`);
  // Cash bag figures belong to helper rows only (verify-helper-bags.js checks their values)
  for (const row of r.body.data.rows.filter((x) => x.role !== 'helper')) {
    for (const k of ['floats', 'cash_collected', 'handed_over', 'short_over', 'reveals']) {
      assert(row[k] == null, `non-helper ${row.user_id} has ${k}=${row[k]}`);
    }
  }
  const idx = (id) => r.body.data.rows.findIndex((x) => x.user_id === id);
  assert(idx(f.A) < idx(f.B), 'rows not sorted by net desc');
});

check('refund and cancel accounting', async () => {
  const f = await build();
  const a = rowOf(await report(f.owner.token), f.A);
  assert(Math.abs(a.refunds - 40) < 0.01, `refunds ${a.refunds} (rejected refund must not count)`);
  assert(Math.abs(a.net - (a.amount - 40)) < 0.01, `net ${a.net}`);
  assert(a.amount < 100 + 250 + 300 + 100, 'cancelled sale counted');
});

check('inactive seller still listed for the period', async () => {
  const f = await build();
  const c = rowOf(await report(f.owner.token), f.C);
  assert(c && c.orders === 1 && Math.abs(c.amount - 75) < 0.01, `C ${JSON.stringify(c)}`);
  assert(!c.is_active, `is_active ${c.is_active}`);
});

check('undo counted against the undoer', async () => {
  const f = await build();
  const r = await report(f.owner.token);
  const a = rowOf(r, f.A), o = rowOf(r, f.owner.id);
  assert((a.undone_count || 0) === 0, `seller A undone ${a.undone_count}`);
  assert(o && o.undone_count >= 1 && o.undone_total >= 20, `owner ${JSON.stringify(o)}`);
  assert(a.orders === 3, 'undone sale must not count as an order');
});

check('close top-ups counted for the closer', async () => {
  const f = await build();
  const b = rowOf(await report(f.owner.token), f.B);
  assert(b.topup_count === 1 && Math.abs(b.topup_total - 60) < 0.01, `B top-up ${b.topup_count}/${b.topup_total}`);
});

check('local-day boundary', async () => {
  const f = await build();
  const inc = rowOf(await report(f.owner.token, `&from=${TODAY}&to=${TODAY}`), f.C);
  assert(inc && inc.orders === 1, 'sale at 23:50 missing from its own day');
  const tm = localDay(1);
  const exc = rowOf(await report(f.owner.token, `&from=${tm}&to=${tm}`), f.C);
  assert(!exc, 'sale at 23:50 leaked into tomorrow');
  const y = localDay(-1);
  const exc2 = rowOf(await report(f.owner.token, `&from=${y}&to=${y}`), f.C);
  assert(!exc2, 'sale at 23:50 leaked into yesterday');
});

check('per-person sales list', async () => {
  const f = await build();
  const r = await api('GET', `/reports/staff-sales/${f.A}/sales?location_id=${TEST_LOCATION_ID}`, f.owner.token);
  assert(r.status === 200 && Array.isArray(r.body.data), `status ${r.status}`);
  const ids = r.body.data.map((x) => x.id).sort((x, y) => x - y);
  assert(JSON.stringify(ids) === JSON.stringify([f.a1, f.a2, f.a3].sort((x, y) => x - y)), `ids ${ids}`);
  const bl = await api('GET', `/reports/staff-sales/${f.B}/sales?location_id=${TEST_LOCATION_ID}`, f.owner.token);
  const bids = bl.body.data.map((x) => x.id);
  assert(bids.includes(f.b1) && !bids.includes(f.b2), `B list ${bids}`);
  const row = r.body.data[0];
  for (const k of ['sale_number', 'created_at', 'grand_total', 'status', 'order_type', 'customer_name']) assert(k in row, `missing ${k}`);
});

async function cleanup() {
  const db = await getDb();
  for (const id of createdSaleIds) {
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
  for (const id of createdUserIds) {
    try {
      await db.prepare('DELETE FROM audit_logs WHERE user_id = ?').run(id);
      await db.prepare('DELETE FROM user_locations WHERE user_id = ?').run(id);
      await db.prepare('DELETE FROM users WHERE id = ?').run(id);
    } catch (err) {
      console.error(`   (cleanup warning: user ${id}: ${err.message})`);
    }
  }
  console.log(`Cleaned up ${createdSaleIds.length} test sale(s) and ${createdUserIds.length} test user(s)`);
}

h.run({ cleanup });
