#!/usr/bin/env node
/**
 * Live verification of staff sales tracking (sales.sold_by). Local dev only.
 *
 * Usage: VERIFY_OWNER_PHONE=... VERIFY_OWNER_PASSWORD=... node scripts/verify-staff-sales.js
 */
const h = require('./lib/verify-harness');

const { check, api, loginOwner, openRegister, assert, getDb, TEST_LOCATION_ID } = h;

const SELLER_MESSAGE = "That person can't be picked as the seller.";
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

async function cleanup() {
  const db = await getDb();
  for (const id of createdSaleIds) {
    try {
      await db.prepare('DELETE FROM production_tasks WHERE sale_id = ?').run(id);
      await db.prepare('DELETE FROM deliveries WHERE sale_id = ?').run(id);
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
