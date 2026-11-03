#!/usr/bin/env node
/**
 * Live verification of the helper role and access window. Local dev only.
 *
 * Usage: VERIFY_OWNER_PHONE=... VERIFY_OWNER_PASSWORD=... node scripts/verify-helpers.js
 */
const h = require('./lib/verify-harness');
const { isAccessExpired } = require('../utils/helper-access');
const { redactSecrets } = require('../utils/redact');
const fs = require('fs');

const { check, api, loginOwner, assert, getDb, TEST_LOCATION_ID } = h;

const createdUserIds = [];
const PASSWORD = 'helper123';

function shopDate(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortDate(iso) {
  const [, m, d] = iso.split('-');
  return `${parseInt(d, 10)} ${MONTH_NAMES[parseInt(m, 10) - 1]}`;
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

check('expired helper cannot log in', async () => {
  const owner = await loginOwner();
  const res = await makeHelper(owner.token, shopDate(2));
  const yesterday = shopDate(-1);
  const db = await getDb();
  await db.prepare('UPDATE users SET access_until = ? WHERE id = ?').run(yesterday, res.body.data.user.id);
  const r = await api('POST', '/auth/login', null, { phone: res.body.data.user.phone, password: PASSWORD });
  assert(r.status === 401, `Expected 401, got ${r.status}`);
  assert(r.body?.message === `Your access ended on ${shortDate(yesterday)}. Ask the owner if you need more days.`, `Message: ${r.body?.message}`);
  assert(!r.body?.data?.token, 'no token should be issued');
});

check('cannot change someone into a helper', async () => {
  const owner = await loginOwner();
  const res = await makeHelper(owner.token, shopDate(2));
  const emp = await api('POST', '/users', owner.token, { name: 'Verify Emp', phone: testPhone(), password: PASSWORD, role: 'employee', location_ids: [TEST_LOCATION_ID] });
  createdUserIds.push(emp.body.data.user.id);
  const r = await api('PUT', `/users/${emp.body.data.user.id}/change-role`, owner.token, { role: 'helper' });
  assert(r.status === 400 && r.body?.message === 'Use Add helper to give someone helper access.', `${r.status} ${JSON.stringify(r.body)}`);
});

check('Works until must be a real date and not in the past', async () => {
  const owner = await loginOwner();
  const bad = await makeHelper(owner.token, '2026-02-31');
  assert(bad.status === 400 && JSON.stringify(bad.body).includes('Pick a real date for Works until.'), `bad date: ${bad.status} ${JSON.stringify(bad.body)}`);
  const past = await makeHelper(owner.token, shopDate(-1));
  assert(past.status === 400 && past.body?.message === "Works until can't be in the past.", `past: ${past.status} ${JSON.stringify(past.body)}`);
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

// ─── Join links (Task 2) ─────────────────────────────────────
// Public calls are limited to 20/min per IP; this file makes 15 of them, so
// wait a minute between back-to-back runs.
const JOIN_COPY = 'This link has been used or has expired. Ask the owner for a new code.';
const UNKNOWN_TOKEN = 'A'.repeat(43);

async function makeJoinLink(ownerToken, userId) {
  const r = await api('POST', `/users/${userId}/join-link`, ownerToken);
  assert(r.status === 200 && r.body?.data?.url, `join-link failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data;
}
const issuedJoinTokens = [];
const tokenOf = (url) => { const t = url.split('/join/')[1]; issuedJoinTokens.push(t); return t; };
const SECRET_KEYS = ['password', 'pin_hash', 'pin_failed_attempts', 'pin_locked_until'];
const leakedKeys = (u) => SECRET_KEYS.filter((k) => u && k in u);

check('join tokens are redacted from logged paths', async () => {
  const t = 'Abc_-123'.repeat(5) + 'xyz';
  assert(redactSecrets(`/api/auth/join/${t}`) === '/api/auth/join/[redacted]', redactSecrets(`/api/auth/join/${t}`));
  assert(redactSecrets(`/join/${t}?x=1`) === '/join/[redacted]?x=1', 'query kept, token gone');
  assert(redactSecrets('/api/users/5/join-link') === '/api/users/5/join-link', 'join-link path untouched');
  assert(redactSecrets('/api/sales/12') === '/api/sales/12', 'other paths untouched');
});

check('auth responses never carry password or PIN fields', async () => {
  const phone = process.env.VERIFY_OWNER_PHONE;
  const r = await api('POST', '/auth/login', null, { phone, password: process.env.VERIFY_OWNER_PASSWORD });
  assert(r.status === 200, `login: ${r.status}`);
  assert(leakedKeys(r.body.data.user).length === 0, `login leaks ${leakedKeys(r.body.data.user)}`);
  const me = await api('GET', '/auth/me', r.body.data.token);
  assert(me.status === 200 && leakedKeys(me.body.data.user).length === 0, `me leaks ${leakedKeys(me.body?.data?.user)}`);
  const list = await api('GET', '/users?limit=100', r.body.data.token);
  assert(list.status === 200 && list.body.data.users.every((u) => leakedKeys(u).length === 0), 'GET /users leaks secrets');
});

check('join link for a non-helper refused', async () => {
  const owner = await loginOwner();
  const emp = await api('POST', '/users', owner.token, { name: 'Verify Emp', phone: testPhone(), password: PASSWORD, role: 'employee', location_ids: [TEST_LOCATION_ID] });
  createdUserIds.push(emp.body.data.user.id);
  const r = await api('POST', `/users/${emp.body.data.user.id}/join-link`, owner.token);
  assert(r.status === 400 && r.body?.message === 'Join links are only for helpers.', `${r.status} ${JSON.stringify(r.body)}`);
  const ownerSelf = await api('POST', `/users/${owner.id}/join-link`, owner.token);
  assert(ownerSelf.status === 400, `owner target: ${ownerSelf.status}`);
  // A switched-off helper gets no link either
  const res = await makeHelper(owner.token, shopDate(2));
  await api('PUT', `/users/${res.body.data.user.id}`, owner.token, { is_active: 0 });
  const off = await api('POST', `/users/${res.body.data.user.id}/join-link`, owner.token);
  assert(off.status === 400, `inactive helper: ${off.status}`);
});

check('join copy for an unknown token', async () => {
  const g = await api('GET', `/auth/join/${UNKNOWN_TOKEN}`, null);
  assert(g.status === 410 && g.body?.message === JOIN_COPY, `GET: ${g.status} ${JSON.stringify(g.body)}`);
  const p = await api('POST', '/auth/join', null, { token: UNKNOWN_TOKEN, pin: '12a4' });
  assert(p.status === 400 && p.body?.message === 'Enter a 4-digit PIN', `bad pin: ${p.status} ${JSON.stringify(p.body)}`);
});

check('join sets pin and returns a session', async () => {
  const owner = await loginOwner();
  const res = await makeHelper(owner.token, shopDate(2));
  const helper = res.body.data.user;
  const link = await makeJoinLink(owner.token, helper.id);
  assert(/\/join\/[A-Za-z0-9_-]{43}$/.test(link.url), `url: ${link.url}`);
  assert(String(link.qr_data_url || '').startsWith('data:image/png;base64,'), 'qr_data_url missing');
  assert(link.expires_at, 'expires_at missing');
  const token = tokenOf(link.url);
  const db = await getDb();
  const stored = await db.prepare(
    "SELECT token_hash, EXTRACT(EPOCH FROM (expires_at - NOW())) AS secs FROM helper_join_tokens WHERE user_id = ? AND used_at IS NULL"
  ).get(helper.id);
  assert(stored && stored.token_hash !== token && /^[0-9a-f]{64}$/.test(stored.token_hash), 'token must be stored hashed');
  assert(Number(stored.secs) > 23.9 * 3600 && Number(stored.secs) <= 24 * 3600, `expiry not ~24h: ${stored.secs}`);

  const g = await api('GET', `/auth/join/${token}`, null);
  assert(g.status === 200 && g.body?.data?.name === helper.name, `GET: ${g.status} ${JSON.stringify(g.body)}`);
  const p = await api('POST', '/auth/join', null, { token, pin: '4821' });
  assert(p.status === 200 && p.body?.data?.token, `POST: ${p.status} ${JSON.stringify(p.body)}`);
  const u = p.body.data.user;
  assert(u.id === helper.id && u.role === 'helper', `user: ${JSON.stringify(u)}`);
  assert(leakedKeys(u).length === 0, `secrets leaked in join user: ${leakedKeys(u)}`);
  assert(Array.isArray(p.body.data.locations) && p.body.data.locations.some((l) => l.id === TEST_LOCATION_ID), 'locations missing');
  const me = await api('GET', '/auth/me', p.body.data.token);
  assert(me.status === 200 && me.body?.data?.user?.id === helper.id, `session: ${me.status}`);
  const row = await db.prepare('SELECT pin_hash FROM users WHERE id = ?').get(helper.id);
  assert(row.pin_hash, 'pin_hash not set');
});

check('join link is single use', async () => {
  const owner = await loginOwner();
  const res = await makeHelper(owner.token, shopDate(2));
  const token = tokenOf((await makeJoinLink(owner.token, res.body.data.user.id)).url);
  // Two simultaneous submits: exactly one wins
  const [a, b] = await Promise.all([
    api('POST', '/auth/join', null, { token, pin: '1111' }),
    api('POST', '/auth/join', null, { token, pin: '2222' }),
  ]);
  const statuses = [a.status, b.status].sort();
  assert(statuses[0] === 200 && statuses[1] === 410, `simultaneous: ${a.status} ${b.status}`);
  const loser = a.status === 410 ? a : b;
  assert(loser.body?.message === JOIN_COPY, `loser copy: ${loser.body?.message}`);
  const again = await api('POST', '/auth/join', null, { token, pin: '3333' });
  assert(again.status === 410 && again.body?.message === JOIN_COPY, `reuse: ${again.status} ${JSON.stringify(again.body)}`);
  const g = await api('GET', `/auth/join/${token}`, null);
  assert(g.status === 410 && g.body?.message === JOIN_COPY, `GET after use: ${g.status}`);
});

check('new link cancels the old', async () => {
  const owner = await loginOwner();
  const res = await makeHelper(owner.token, shopDate(2));
  const oldToken = tokenOf((await makeJoinLink(owner.token, res.body.data.user.id)).url);
  const newToken = tokenOf((await makeJoinLink(owner.token, res.body.data.user.id)).url);
  assert(oldToken !== newToken, 'tokens should differ');
  const o = await api('POST', '/auth/join', null, { token: oldToken, pin: '5678' });
  assert(o.status === 410 && o.body?.message === JOIN_COPY, `old: ${o.status} ${JSON.stringify(o.body)}`);
  const n = await api('POST', '/auth/join', null, { token: newToken, pin: '5678' });
  assert(n.status === 200, `new: ${n.status} ${JSON.stringify(n.body)}`);
});

check('expired link refused', async () => {
  const owner = await loginOwner();
  const res = await makeHelper(owner.token, shopDate(2));
  const token = tokenOf((await makeJoinLink(owner.token, res.body.data.user.id)).url);
  const db = await getDb();
  await db.prepare("UPDATE helper_join_tokens SET expires_at = NOW() - INTERVAL '1 minute' WHERE user_id = ?").run(res.body.data.user.id);
  const g = await api('GET', `/auth/join/${token}`, null);
  assert(g.status === 410 && g.body?.message === JOIN_COPY, `GET: ${g.status} ${JSON.stringify(g.body)}`);
  const p = await api('POST', '/auth/join', null, { token, pin: '5678' });
  assert(p.status === 410 && p.body?.message === JOIN_COPY, `POST: ${p.status} ${JSON.stringify(p.body)}`);
});

check('helper can staff-login with code and pin', async () => {
  const owner = await loginOwner();
  const res = await makeHelper(owner.token, shopDate(2));
  const helper = res.body.data.user;
  const token = tokenOf((await makeJoinLink(owner.token, helper.id)).url);
  const j = await api('POST', '/auth/join', null, { token, pin: '9035' });
  assert(j.status === 200, `join: ${j.status} ${JSON.stringify(j.body)}`);
  const s = await api('POST', '/auth/staff-login', null, { employee_code: helper.employee_code, pin: '9035' });
  assert(s.status === 200 && s.body?.data?.user?.id === helper.id && s.body?.data?.token, `staff-login: ${s.status} ${JSON.stringify(s.body)}`);
  assert(leakedKeys(s.body.data.user).length === 0, `staff-login leaks ${leakedKeys(s.body.data.user)}`);
  // Once access has ended, staff-login refuses with the plain copy
  const yesterday = shopDate(-1);
  const db = await getDb();
  await db.prepare('UPDATE users SET access_until = ? WHERE id = ?').run(yesterday, helper.id);
  const e = await api('POST', '/auth/staff-login', null, { employee_code: helper.employee_code, pin: '9035' });
  assert(e.status === 401 && e.body?.message === `Your access ended on ${shortDate(yesterday)}. Ask the owner if you need more days.`, `expired staff-login: ${e.status} ${JSON.stringify(e.body)}`);
  assert(!e.body?.data?.token, 'no token for expired helper');
});

check('expired helper cannot join', async () => {
  const owner = await loginOwner();
  const res = await makeHelper(owner.token, shopDate(2));
  const helperId = res.body.data.user.id;
  const token = tokenOf((await makeJoinLink(owner.token, helperId)).url);
  const yesterday = shopDate(-1);
  const want = `Your access ended on ${shortDate(yesterday)}. Ask the owner if you need more days.`;
  const db = await getDb();
  await db.prepare('UPDATE users SET access_until = ? WHERE id = ?').run(yesterday, helperId);
  const g = await api('GET', `/auth/join/${token}`, null);
  assert(g.status === 401 && g.body?.message === want && !g.body?.data, `GET: ${g.status} ${JSON.stringify(g.body)}`);
  const p = await api('POST', '/auth/join', null, { token, pin: '5678' });
  assert(p.status === 401 && p.body?.message === want && !p.body?.data, `POST: ${p.status} ${JSON.stringify(p.body)}`);
  const row = await db.prepare('SELECT used_at FROM helper_join_tokens WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(helperId);
  assert(row && row.used_at === null, 'token must not be consumed for an expired helper');
  const u = await db.prepare('SELECT pin_hash FROM users WHERE id = ?').get(helperId);
  assert(!u.pin_hash, 'pin must not be set for an expired helper');
});

// Needs the server log path (VERIFY_API_LOG, e.g. /tmp/api.log); skipped without it.
check('join tokens never reach the server log', async () => {
  const logPath = process.env.VERIFY_API_LOG;
  if (!logPath || !fs.existsSync(logPath)) { console.log('   (skipped: set VERIFY_API_LOG to the server log path)'); return; }
  assert(issuedJoinTokens.length > 0, 'no join tokens were issued in this run');
  const log = fs.readFileSync(logPath, 'utf8');
  const leaked = issuedJoinTokens.filter((t) => log.includes(t));
  assert(leaked.length === 0, `${leaked.length} join token(s) found in ${logPath}`);
  assert(log.includes('/api/auth/join/[redacted]'), 'expected redacted join lines in the log');
});

async function cleanup() {
  const db = await getDb();
  for (const id of createdUserIds) {
    try {
      await db.prepare('DELETE FROM audit_logs WHERE user_id = ?').run(id);
      await db.prepare('DELETE FROM helper_join_tokens WHERE user_id = ? OR created_by = ?').run(id, id);
      await db.prepare('DELETE FROM user_locations WHERE user_id = ?').run(id);
      await db.prepare('DELETE FROM users WHERE id = ?').run(id);
    } catch (err) {
      console.error(`   (cleanup warning: user ${id}: ${err.message})`);
    }
  }
  console.log(`Cleaned up ${createdUserIds.length} test user(s)`);
}

h.run({ cleanup });
