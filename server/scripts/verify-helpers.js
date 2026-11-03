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

// ─── Approval PIN and helper route access (Task 3) ───────────
const { verifyApprovalPin, approverMaxDiscountPct } = require('../utils/approval-pin');
const LOCKED_COPY = 'Too many wrong tries — ask your manager to unlock this in 5 minutes.';

async function makeStaff(ownerToken, role) {
  const phone = testPhone();
  const r = await api('POST', '/users', ownerToken, { name: `Verify ${role}`, phone, password: PASSWORD, role, location_ids: [TEST_LOCATION_ID] });
  assert(r.status === 201, `create ${role}: ${r.status} ${JSON.stringify(r.body)}`);
  createdUserIds.push(r.body.data.user.id);
  return { ...r.body.data.user, phone };
}

// Throwaway owner: created as an employee, then made owner by the real owner.
async function makeThrowawayOwner(ownerToken) {
  const u = await makeStaff(ownerToken, 'employee');
  const r = await api('PUT', `/users/${u.id}/change-role`, ownerToken, { role: 'owner' });
  assert(r.status === 200 && r.body.data.user.role === 'owner', `make owner: ${r.status} ${JSON.stringify(r.body)}`);
  return u;
}

async function overrideOutcome(code, pin) {
  const db = await getDb();
  try {
    const u = await verifyApprovalPin(db, code, pin);
    return { status: 200, user: u };
  } catch (err) {
    if (!err.pinCheck) throw err;
    return { status: err.status, message: err.message };
  }
}

check('manager can be given an approval PIN', async () => {
  const owner = await loginOwner();
  const mgr = await makeStaff(owner.token, 'manager');
  assert(!mgr.employee_code, `manager should start with no code, got ${mgr.employee_code}`);
  const r = await api('PUT', `/users/${mgr.id}/pin`, owner.token, { pin: '2468' });
  assert(r.status === 200 && /^\d+$/.test(r.body?.data?.employee_code || ''), `set pin: ${r.status} ${JSON.stringify(r.body)}`);
  const code = r.body.data.employee_code;
  // Setting it again keeps the same code
  const again = await api('PUT', `/users/${mgr.id}/pin`, owner.token, { pin: '1357' });
  assert(again.status === 200 && again.body.data.employee_code === code, `reset changed code: ${JSON.stringify(again.body)}`);
  const ok = await overrideOutcome(code, '1357');
  assert(ok.status === 200 && ok.user.id === mgr.id && ok.user.role === 'manager', `override: ${JSON.stringify(ok)}`);
  assert(approverMaxDiscountPct('manager', { discount_owner_threshold: '30' }) === 30, 'manager limit');
  assert(approverMaxDiscountPct('counter_staff', {}) === 20, 'counter default limit');
  assert(approverMaxDiscountPct('employee', { discount_manager_threshold: '15' }) === 15, 'employee limit');
  assert(approverMaxDiscountPct('owner', {}) === Infinity, 'owner limit');
  assert(approverMaxDiscountPct('helper', {}) === 0, 'helper is no approver');
  // The owner can also give an owner an approval PIN (throwaway owner here)
  const o2 = await makeThrowawayOwner(owner.token);
  const r2 = await api('PUT', `/users/${o2.id}/pin`, owner.token, { pin: '8642' });
  assert(r2.status === 200 && /^\d+$/.test(r2.body?.data?.employee_code || ''), `owner target: ${r2.status} ${JSON.stringify(r2.body)}`);
  const ok2 = await overrideOutcome(r2.body.data.employee_code, '8642');
  assert(ok2.status === 200 && ok2.user.role === 'owner', `owner override: ${JSON.stringify(ok2)}`);
});

check('manager approval PIN cannot log in at the counter', async () => {
  const owner = await loginOwner();
  const mgr = await makeStaff(owner.token, 'manager');
  const r = await api('PUT', `/users/${mgr.id}/pin`, owner.token, { pin: '2468' });
  const code = r.body.data.employee_code;
  const s = await api('POST', '/auth/staff-login', null, { employee_code: code, pin: '2468' });
  assert(s.status === 401 && s.body?.message === 'Employee code not recognized.' && !s.body?.data, `staff-login: ${s.status} ${JSON.stringify(s.body)}`);
});

check('manager cannot set the owner\'s PIN', async () => {
  const owner = await loginOwner();
  const mgr = await makeStaff(owner.token, 'manager');
  const login = await api('POST', '/auth/login', null, { phone: mgr.phone, password: PASSWORD });
  assert(login.status === 200, `manager login: ${login.status}`);
  const o2 = await makeThrowawayOwner(owner.token);
  const r = await api('PUT', `/users/${o2.id}/pin`, login.body.data.token, { pin: '1111' });
  assert(r.status === 403, `manager -> owner pin: ${r.status} ${JSON.stringify(r.body)}`);
  const other = await makeStaff(owner.token, 'manager');
  const r2 = await api('PUT', `/users/${other.id}/pin`, login.body.data.token, { pin: '1111' });
  assert(r2.status === 403, `manager -> manager pin: ${r2.status}`);
  const db = await getDb();
  const rows = await db.prepare('SELECT pin_hash, employee_code FROM users WHERE id IN (?, ?)').all(o2.id, other.id);
  assert(rows.every((x) => !x.pin_hash), 'refused PIN must not be stored');
  // Manager can still set a counter staff PIN (unchanged)
  const cs = await makeStaff(owner.token, 'counter_staff');
  const r3 = await api('PUT', `/users/${cs.id}/pin`, login.body.data.token, { pin: '1111' });
  assert(r3.status === 200 && r3.body?.message === 'PIN set successfully', `manager -> counter_staff: ${r3.status} ${JSON.stringify(r3.body)}`);
});

check('override failures lock the approver', async () => {
  const owner = await loginOwner();
  const cs = await makeStaff(owner.token, 'counter_staff');
  await api('PUT', `/users/${cs.id}/pin`, owner.token, { pin: '4321' });
  const code = cs.employee_code;
  // Two wrong tries at login, then wrong tries on overrides share the count
  const l1 = await api('POST', '/auth/staff-login', null, { employee_code: code, pin: '0000' });
  assert(l1.status === 401 && l1.body?.message === 'Wrong PIN — 4 tries left.', `login 1: ${JSON.stringify(l1.body)}`);
  const l2 = await api('POST', '/auth/staff-login', null, { employee_code: code, pin: '0000' });
  assert(l2.status === 401 && l2.body?.message === 'Wrong PIN — 3 tries left.', `login 2: ${JSON.stringify(l2.body)}`);
  const o1 = await overrideOutcome(code, '0000');
  assert(o1.status === 401 && o1.message === "That PIN didn't match. 2 tries left.", `override 1: ${JSON.stringify(o1)}`);
  const o2 = await overrideOutcome(code, '0000');
  assert(o2.status === 401 && o2.message === "That PIN didn't match. 1 tries left.", `override 2: ${JSON.stringify(o2)}`);
  const o3 = await overrideOutcome(code, '0000');
  assert(o3.status === 423 && o3.message === LOCKED_COPY, `override 3: ${JSON.stringify(o3)}`);
  // Locked for both paths, even with the right PIN
  const o4 = await overrideOutcome(code, '4321');
  assert(o4.status === 423 && o4.message === LOCKED_COPY, `override right PIN while locked: ${JSON.stringify(o4)}`);
  const l3 = await api('POST', '/auth/staff-login', null, { employee_code: code, pin: '4321' });
  assert(l3.status === 423 && l3.body?.message === LOCKED_COPY, `login while locked: ${l3.status} ${JSON.stringify(l3.body)}`);
  // Parallel wrong tries cannot slip past the limit
  const cs2 = await makeStaff(owner.token, 'counter_staff');
  await api('PUT', `/users/${cs2.id}/pin`, owner.token, { pin: '4321' });
  const burst = await Promise.all(Array.from({ length: 8 }, () => overrideOutcome(cs2.employee_code, '0000')));
  const db = await getDb();
  const row = await db.prepare('SELECT pin_failed_attempts, pin_locked_until FROM users WHERE id = ?').get(cs2.id);
  const answered401 = burst.filter((b) => b.status === 401).length;
  assert(answered401 <= 4 && Number(row.pin_failed_attempts) >= 5 && row.pin_locked_until, `burst: ${JSON.stringify(row)} ${JSON.stringify(burst.map((b) => b.status))}`);
  // A right PIN resets the count
  const cs3 = await makeStaff(owner.token, 'counter_staff');
  await api('PUT', `/users/${cs3.id}/pin`, owner.token, { pin: '4321' });
  await overrideOutcome(cs3.employee_code, '0000');
  const good = await overrideOutcome(cs3.employee_code, '4321');
  assert(good.status === 200, `right pin: ${JSON.stringify(good)}`);
  const row3 = await db.prepare('SELECT pin_failed_attempts FROM users WHERE id = ?').get(cs3.id);
  assert(Number(row3.pin_failed_attempts) === 0, `count not reset: ${row3.pin_failed_attempts}`);
});

check('override from a non-approver role acts like an unknown code', async () => {
  const owner = await loginOwner();
  const unknown = await overrideOutcome('99999999', '1234');
  assert(unknown.status === 401 && unknown.message === 'Employee code not recognized.', `unknown: ${JSON.stringify(unknown)}`);
  const fl = await makeStaff(owner.token, 'florist_staff');
  await api('PUT', `/users/${fl.id}/pin`, owner.token, { pin: '5555' });
  const h = await makeHelper(owner.token, shopDate(2));
  const db = await getDb();
  await db.prepare("UPDATE users SET pin_hash = (SELECT pin_hash FROM users WHERE id = ?) WHERE id = ?").run(fl.id, h.body.data.user.id);
  for (const [who, code] of [['florist', fl.employee_code], ['helper', h.body.data.user.employee_code]]) {
    for (const pin of ['5555', '0000']) {
      const r = await overrideOutcome(code, pin);
      assert(r.status === unknown.status && r.message === unknown.message, `${who} pin ${pin}: ${JSON.stringify(r)}`);
    }
  }
  const rows = await db.prepare('SELECT pin_failed_attempts FROM users WHERE id IN (?, ?)').all(fl.id, h.body.data.user.id);
  assert(rows.every((x) => !Number(x.pin_failed_attempts)), 'non-approver attempts must not be counted');
  // A switched-off approver also reads as unknown
  const cs = await makeStaff(owner.token, 'counter_staff');
  await api('PUT', `/users/${cs.id}/pin`, owner.token, { pin: '5555' });
  await api('PUT', `/users/${cs.id}`, owner.token, { is_active: 0 });
  const off = await overrideOutcome(cs.employee_code, '5555');
  assert(off.status === 401 && off.message === 'Employee code not recognized.', `inactive: ${JSON.stringify(off)}`);
});

async function helperSession(ownerToken) {
  const res = await makeHelper(ownerToken, shopDate(2));
  return { id: res.body.data.user.id, token: await helperToken(res.body.data.user.phone) };
}

check('helper cannot read estimated_cost from product list', async () => {
  const owner = await loginOwner();
  const helper = await helperSession(owner.token);
  const ownerList = await api('GET', '/products?limit=5', owner.token);
  assert(ownerList.status === 200 && ownerList.body.data.length > 0, 'owner list empty');
  assert('estimated_cost' in ownerList.body.data[0], 'owner should still see estimated_cost');
  const list = await api('GET', '/products?limit=5', helper.token);
  assert(list.status === 200 && list.body.data.length > 0, `helper list: ${list.status}`);
  assert(list.body.data.every((p) => !('estimated_cost' in p)), 'helper list carries estimated_cost');
  const one = await api('GET', `/products/${list.body.data[0].id}`, helper.token);
  assert(one.status === 200 && !('estimated_cost' in one.body.data), `helper detail: ${one.status} carries estimated_cost`);
  assert((one.body.data.materials || []).every((m) => !('supplier_avg_cost' in m) && !('cost_per_unit' in m)), 'helper detail carries material cost');
  const scan = await api('POST', '/products/scan', helper.token, { payload: `P${list.body.data[0].id}` });
  assert(scan.status !== 401 && scan.status !== 403, `helper scan blocked: ${scan.status}`);
  const reg = await api('GET', `/sales/register/status?location_id=${TEST_LOCATION_ID}`, helper.token);
  assert(reg.status === 200, `helper register status: ${reg.status}`);
});

check('helper cannot call counter routes', async () => {
  const owner = await loginOwner();
  const helper = await helperSession(owner.token);
  const calls = [
    ['PUT', '/sales/1/cancel', {}],
    ['GET', '/customers', undefined],
    ['POST', '/expenses', { location_id: TEST_LOCATION_ID, amount: 1, category: 'other', description: 'x' }],
    ['GET', '/expenses', undefined],
    ['GET', '/users', undefined],
    ['POST', '/sales/1/refund', { amount: 1 }],
  ];
  for (const [m, p, b] of calls) {
    const r = await api(m, p, helper.token, b);
    assert(r.status === 403, `${m} ${p}: expected 403, got ${r.status}`);
  }
  const sale = await api('POST', '/sales', helper.token, { location_id: TEST_LOCATION_ID, order_type: 'walk_in', items: [{ product_id: 1, quantity: 1, unit_price: 1 }] });
  assert(sale.status === 403 && sale.body?.message === 'Helpers can only sell from the Sell screen.', `POST /sales: ${sale.status} ${JSON.stringify(sale.body)}`);
  const undo = await api('POST', '/quick-sale/1/undo', helper.token);
  assert(undo.status === 403, `undo: ${undo.status}`);
});

check('helper gets shop-info with upi_qr_image_url', async () => {
  const owner = await loginOwner();
  const helper = await helperSession(owner.token);
  const r = await api('GET', '/settings/shop-info', helper.token);
  assert(r.status === 200 && 'shop_name' in r.body.data && 'upi_qr_image_url' in r.body.data, `shop-info: ${r.status} ${JSON.stringify(r.body)}`);
  const db = await getDb();
  const qr = await db.prepare("SELECT value FROM settings WHERE key = 'upi_qr_image_url'").get();
  assert(r.body.data.upi_qr_image_url === ((qr && qr.value) || null), 'upi_qr_image_url does not match the setting');
});

// ─── Helpers reach only their own routes (Task 3, rulings 6-8) ─
const HELPER_DENIED = "Helpers can't open this. Ask the counter.";

check('helpers are refused outside their own routes', async () => {
  const owner = await loginOwner();
  const helper = await helperSession(owner.token);
  const denied = [
    ['GET', '/sales'],
    ['GET', '/SALES'],
    ['GET', '/sales/1'],
    ['GET', '/sales/today-summary'],
    ['GET', '/customers'],
    ['GET', '/customers/search?q=a'],
    ['DELETE', '/customers/1/addresses/1'],
    ['GET', '/materials'],
    ['GET', '/stock'],
    ['GET', '/suppliers'],
    ['GET', '/notifications'],
    ['GET', '/settings'],
    ['PUT', '/auth/profile'],
  ];
  for (const [m, p] of denied) {
    const r = await api(m, p, helper.token, m === 'GET' ? undefined : {});
    assert(r.status === 403 && r.body?.message === HELPER_DENIED, `${m} ${p}: ${r.status} ${JSON.stringify(r.body)}`);
  }
  // The allowed list still works
  const me = await api('GET', '/auth/me', helper.token);
  assert(me.status === 200, `me: ${me.status}`);
  const list = await api('GET', `/products?limit=3&location_id=${TEST_LOCATION_ID}`, helper.token);
  assert(list.status === 200 && list.body.data.length > 0, `products: ${list.status}`);
  const one = await api('GET', `/products/${list.body.data[0].id}`, helper.token);
  assert(one.status === 200, `product detail: ${one.status}`);
  const scan = await api('POST', '/products/scan', helper.token, { payload: `P${list.body.data[0].id}` });
  assert(scan.status !== 403, `scan: ${scan.status}`);
  const info = await api('GET', '/settings/shop-info', helper.token);
  assert(info.status === 200, `shop-info: ${info.status}`);
  const reg = await api('GET', `/sales/register/status?location_id=${TEST_LOCATION_ID}`, helper.token);
  assert(reg.status === 200, `register status: ${reg.status}`);
  const mine = await api('GET', '/quick-sale/my-sales', helper.token);
  assert(mine.status !== 403, `my-sales must not be refused: ${mine.status}`);
  // Other roles are unaffected
  const ownerSales = await api('GET', '/sales?limit=1', owner.token);
  assert(ownerSales.status === 200, `owner GET /sales: ${ownerSales.status}`);
});

check('helper product list has available and no stock numbers', async () => {
  const owner = await loginOwner();
  const helper = await helperSession(owner.token);
  const QTY_KEYS = ['ready_qty', 'available_qty', 'total_ready_qty', 'quantity', 'stock', 'sale_count', 'materials'];
  const db = await getDb();
  for (const path of [`/products?limit=50&location_id=${TEST_LOCATION_ID}`, '/products?limit=50']) {
    const r = await api('GET', path, helper.token);
    assert(r.status === 200 && r.body.data.length > 0, `${path}: ${r.status}`);
    for (const p of r.body.data) {
      const leaked = QTY_KEYS.filter((k) => k in p);
      assert(leaked.length === 0, `${path} product ${p.id} carries ${leaked}`);
      assert(typeof p.available === 'boolean', `${path} product ${p.id} available=${p.available}`);
      const st = path.includes('location_id')
        ? await db.prepare('SELECT COALESCE(SUM(quantity), 0) AS q FROM product_stock WHERE product_id = ? AND location_id = ?').get(p.id, TEST_LOCATION_ID)
        : await db.prepare('SELECT COALESCE(SUM(quantity), 0) AS q FROM product_stock WHERE product_id = ?').get(p.id);
      const want = Number(p.is_one_off) === 1 ? Number(st.q) > 0 : true;
      assert(p.available === want, `${path} product ${p.id} available=${p.available} want ${want}`);
    }
  }
  const ownerList = await api('GET', `/products?limit=1&location_id=${TEST_LOCATION_ID}`, owner.token);
  assert('ready_qty' in ownerList.body.data[0], 'owner should still see ready_qty');
  const first = (await api('GET', '/products?limit=1', helper.token)).body.data[0];
  const one = await api('GET', `/products/${first.id}?location_id=${TEST_LOCATION_ID}`, helper.token);
  const leaked = QTY_KEYS.filter((k) => k in one.body.data);
  assert(one.status === 200 && leaked.length === 0 && typeof one.body.data.available === 'boolean', `detail: ${one.status} leaked ${leaked}`);
});

check('changing a manager role clears their approval PIN', async () => {
  const owner = await loginOwner();
  const mgr = await makeStaff(owner.token, 'manager');
  const set = await api('PUT', `/users/${mgr.id}/pin`, owner.token, { pin: '2468' });
  const code = set.body.data.employee_code;
  const db = await getDb();
  await db.prepare('UPDATE users SET pin_failed_attempts = 2 WHERE id = ?').run(mgr.id);
  const r = await api('PUT', `/users/${mgr.id}/change-role`, owner.token, { role: 'counter_staff' });
  assert(r.status === 200, `change-role: ${r.status} ${JSON.stringify(r.body)}`);
  const row = await db.prepare('SELECT pin_hash, pin_failed_attempts, pin_locked_until, employee_code FROM users WHERE id = ?').get(mgr.id);
  assert(!row.pin_hash && Number(row.pin_failed_attempts) === 0 && !row.pin_locked_until, `pin not cleared: ${JSON.stringify(row)}`);
  const s = await api('POST', '/auth/staff-login', null, { employee_code: code, pin: '2468' });
  assert(s.status !== 200 && !s.body?.data?.token, `old approval PIN logged in: ${s.status}`);
  // A staff PIN is untouched by a staff-to-staff change
  const cs = await makeStaff(owner.token, 'counter_staff');
  await api('PUT', `/users/${cs.id}/pin`, owner.token, { pin: '1357' });
  await api('PUT', `/users/${cs.id}/change-role`, owner.token, { role: 'florist_staff' });
  const csRow = await db.prepare('SELECT pin_hash FROM users WHERE id = ?').get(cs.id);
  assert(csRow.pin_hash, 'staff PIN should be kept on a staff role change');
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
