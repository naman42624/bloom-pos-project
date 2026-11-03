#!/usr/bin/env node
/**
 * Live verification of the helper role and access window. Local dev only.
 *
 * Usage: VERIFY_OWNER_PHONE=... VERIFY_OWNER_PASSWORD=... node scripts/verify-helpers.js
 */
const h = require('./lib/verify-harness');
const { isAccessExpired } = require('../utils/helper-access');

const { check, api, loginOwner, assert, getDb, TEST_LOCATION_ID } = h;

const createdUserIds = [];
const PASSWORD = 'helper123';

function shopDate(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function shortDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

let phoneSeq = 0;
function testPhone() {
  phoneSeq += 1;
  return '7' + String((Date.now() + phoneSeq) % 1000000000).padStart(9, '0');
}

async function makeHelper(token, accessUntil) {
  const res = await api('POST', '/users', token, {
    name: 'Verify Helper', phone: testPhone(), password: PASSWORD, role: 'helper',
    access_until: accessUntil, location_ids: [TEST_LOCATION_ID],
  });
  if (res.body?.data?.user?.id) createdUserIds.push(res.body.data.user.id);
  return res;
}

async function helperToken(phone) {
  const r = await api('POST', '/auth/login', null, { phone, password: PASSWORD });
  assert(r.status === 200 && r.body?.data?.token, `helper login failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data.token;
}

check('helper can be created with access_until and gets an employee code', async () => {
  const owner = await loginOwner();
  const until = shopDate(3);
  const { status, body } = await makeHelper(owner.token, until);
  assert(status === 201, `Expected 201, got ${status}: ${JSON.stringify(body)}`);
  const u = body.data.user;
  assert(u.role === 'helper', `role: ${u.role}`);
  assert(/^\d+$/.test(u.employee_code || ''), `employee_code: ${u.employee_code}`);
  const db = await getDb();
  const row = await db.prepare("SELECT to_char(access_until, 'YYYY-MM-DD') AS d FROM users WHERE id = ?").get(u.id);
  assert(row.d === until, `access_until stored as ${row.d}`);
});

check('helper without access_until refused', async () => {
  const owner = await loginOwner();
  const { status, body } = await makeHelper(owner.token, undefined);
  assert(status === 400, `Expected 400, got ${status}: ${JSON.stringify(body)}`);
});

check('access ends after the date, not on it', async () => {
  assert(isAccessExpired('2026-11-02', '2026-11-02') === false, 'last day should still work');
  assert(isAccessExpired('2026-11-01', '2026-11-02') === true, 'day after should be expired');
  assert(isAccessExpired(new Date(2026, 10, 2), '2026-11-02') === false, 'Date object, last day');
  assert(isAccessExpired(null, '2026-11-02') === false, 'no date means no limit');

  const owner = await loginOwner();
  // access_until today: still works
  const todayRes = await makeHelper(owner.token, shopDate(0));
  assert(todayRes.status === 201, `create failed: ${JSON.stringify(todayRes.body)}`);
  const tToken = await helperToken(todayRes.body.data.user.phone);
  const ok = await api('GET', '/auth/me', tToken);
  assert(ok.status === 200, `helper on last day should work, got ${ok.status}: ${JSON.stringify(ok.body)}`);

  // access_until yesterday: 401 exact copy
  const yesterday = shopDate(-1);
  const yRes = await makeHelper(owner.token, shopDate(2));
  const yToken = await helperToken(yRes.body.data.user.phone);
  const db = await getDb();
  await db.prepare('UPDATE users SET access_until = ? WHERE id = ?').run(yesterday, yRes.body.data.user.id);
  const r = await api('GET', '/auth/me', yToken);
  const want = `Your access ended on ${shortDate(yesterday)}. Ask the owner if you need more days.`;
  assert(r.status === 401, `Expected 401, got ${r.status}`);
  assert(r.body?.message === want, `Message: "${r.body?.message}" wanted "${want}"`);

  // owner extends via PUT: works again
  const put = await api('PUT', `/users/${yRes.body.data.user.id}`, owner.token, { access_until: shopDate(5) });
  assert(put.status === 200, `PUT access_until failed: ${put.status} ${JSON.stringify(put.body)}`);
  const again = await api('GET', '/auth/me', yToken);
  assert(again.status === 200, `Expected access restored, got ${again.status}`);
});

check('deactivated helper is signed out', async () => {
  const owner = await loginOwner();
  const res = await makeHelper(owner.token, shopDate(2));
  const token = await helperToken(res.body.data.user.phone);
  const off = await api('PUT', `/users/${res.body.data.user.id}`, owner.token, { is_active: 0 });
  assert(off.status === 200, `deactivate failed: ${off.status}`);
  const r = await api('GET', '/auth/me', token);
  assert(r.status === 403, `Expected 403, got ${r.status}`);
  assert(r.body?.message === 'Account has been deactivated. Contact your manager.', `Message: ${r.body?.message}`);
});

check('schema pieces exist (client_ref, join tokens, helper threshold)', async () => {
  const db = await getDb();
  const col = await db.prepare("SELECT 1 AS x FROM information_schema.columns WHERE table_name = 'sales' AND column_name = 'client_ref'").get();
  assert(col, 'sales.client_ref missing');
  const tbl = await db.prepare("SELECT 1 AS x FROM information_schema.tables WHERE table_name = 'helper_join_tokens'").get();
  assert(tbl, 'helper_join_tokens missing');
  const s = await db.prepare("SELECT value FROM settings WHERE key = 'discount_helper_threshold'").get();
  assert(s && s.value !== '', 'discount_helper_threshold not seeded');
});

async function cleanup() {
  const db = await getDb();
  for (const id of createdUserIds) {
    try {
      await db.prepare('DELETE FROM audit_logs WHERE user_id = ?').run(id);
      await db.prepare('DELETE FROM user_locations WHERE user_id = ?').run(id);
      await db.prepare('DELETE FROM users WHERE id = ?').run(id);
    } catch (err) {
      console.error(`   (cleanup warning: user ${id}: ${err.message})`);
    }
  }
  console.log(`Cleaned up ${createdUserIds.length} test user(s)`);
}

h.run({ cleanup });
