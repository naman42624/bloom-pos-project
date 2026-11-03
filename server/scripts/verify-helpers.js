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

const { check, api, loginOwner, ensureClosed, openRegister, assert, getDb, TEST_LOCATION_ID } = h;

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
    ['PUT', '/sales/999999999/cancel', {}],
    ['GET', '/customers', undefined],
    ['POST', '/expenses', { location_id: TEST_LOCATION_ID, amount: 1, category: 'other', description: 'x' }],
    ['GET', '/expenses', undefined],
    ['GET', '/users', undefined],
    ['POST', '/sales/999999999/refund', { amount: 1 }],
  ];
  for (const [m, p, b] of calls) {
    const r = await api(m, p, helper.token, b);
    assert(r.status === 403, `${m} ${p}: expected 403, got ${r.status}`);
  }
  // POST /sales is a helper route, but only under the helper sale rules (Task 4)
  const sale = await api('POST', '/sales', helper.token, { location_id: TEST_LOCATION_ID, client_ref: 'unknown-product-check', order_type: 'walk_in', items: [{ product_id: 999999999, quantity: 1, unit_price: 1 }], payments: [{ method: 'upi', amount: 1 }] });
  assert(sale.status === 409 && sale.body?.message === 'Not for sale right now — ask the counter.', `POST /sales: ${sale.status} ${JSON.stringify(sale.body)}`);
  const undo = await api('POST', '/quick-sale/999999999/undo', helper.token);
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
    ['GET', '/sales/999999999'],
    ['GET', '/sales/today-summary'],
    ['GET', '/customers'],
    ['GET', '/customers/search?q=a'],
    ['DELETE', '/customers/999999999/addresses/999999999'],
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
  // Promoting staff to manager clears the counter PIN too
  const up = await api('PUT', `/users/${cs.id}/change-role`, owner.token, { role: 'manager' });
  assert(up.status === 200, `promote: ${up.status}`);
  const upRow = await db.prepare('SELECT pin_hash FROM users WHERE id = ?').get(cs.id);
  assert(!upRow.pin_hash, 'counter PIN must not carry over into manager');
});


check('parallel PIN guesses cannot get past the lockout', async () => {
  const owner = await loginOwner();
  const cs = await makeStaff(owner.token, 'counter_staff');
  await api('PUT', `/users/${cs.id}/pin`, owner.token, { pin: '4321' });
  const MAX = 5;
  const code = cs.employee_code;
  // Right PIN first in the batch, then MAX + 3 wrong ones, all at once
  const reqs = [api('POST', '/auth/staff-login', null, { employee_code: code, pin: '4321' })];
  for (let i = 0; i < MAX + 3; i++) reqs.push(api('POST', '/auth/staff-login', null, { employee_code: code, pin: '0000' }));
  const out = await Promise.all(reqs);
  const compared = out.filter((r) => r.status === 200 || (r.status === 401 && /tries left/.test(r.body?.message || ''))).length;
  assert(compared <= MAX, `${compared} requests were compared: ${JSON.stringify(out.map((r) => [r.status, r.body?.message]))}`);
  assert(out.every((r) => [200, 401, 423].includes(r.status)), `unexpected status: ${out.map((r) => r.status)}`);
  // Every compared try is counted, so the stored count proves how many PINs were checked
  const burstRow = await (await getDb()).prepare('SELECT pin_failed_attempts FROM users WHERE id = ?').get(cs.id);
  assert(Number(burstRow.pin_failed_attempts) === MAX, `stored tries after burst: ${burstRow.pin_failed_attempts} (want ${MAX})`);
  const after = await api('POST', '/auth/staff-login', null, { employee_code: code, pin: '4321' });
  assert(after.status === 423 && after.body?.message === LOCKED_COPY, `after burst: ${after.status} ${JSON.stringify(after.body)}`);
  // An ended lock starts the count again from 0
  const db = await getDb();
  await db.prepare("UPDATE users SET pin_locked_until = NOW() - INTERVAL '1 minute' WHERE id = ?").run(cs.id);
  const w = await api('POST', '/auth/staff-login', null, { employee_code: code, pin: '0000' });
  assert(w.status === 401 && w.body?.message === 'Wrong PIN — 4 tries left.', `after lock ended: ${w.status} ${JSON.stringify(w.body)}`);
  const ok = await api('POST', '/auth/staff-login', null, { employee_code: code, pin: '4321' });
  assert(ok.status === 200, `right PIN after lock ended: ${ok.status}`);
  const row = await db.prepare('SELECT pin_failed_attempts, pin_locked_until FROM users WHERE id = ?').get(cs.id);
  assert(Number(row.pin_failed_attempts) === 0 && !row.pin_locked_until, `not reset: ${JSON.stringify(row)}`);
});

check('helper sees only open or closed for the register', async () => {
  const owner = await loginOwner();
  const helper = await helperSession(owner.token);
  const r = await api('GET', `/sales/register/status?location_id=${TEST_LOCATION_ID}`, helper.token);
  assert(r.status === 200, `status: ${r.status}`);
  assert(JSON.stringify(Object.keys(r.body).sort()) === JSON.stringify(['data', 'isOpen', 'success']), `top keys: ${Object.keys(r.body)}`);
  assert(JSON.stringify(Object.keys(r.body.data)) === JSON.stringify(['isOpen']), `data keys: ${Object.keys(r.body.data)}`);
  const o = await api('GET', `/sales/register/status?location_id=${TEST_LOCATION_ID}`, owner.token);
  assert(o.body.isOpen === r.body.isOpen && r.body.data.isOpen === r.body.isOpen, `isOpen differs: owner ${o.body.isOpen} helper ${r.body.isOpen}`);
});

check('helper product view is built from an allowlist, active only', async () => {
  const owner = await loginOwner();
  const helper = await helperSession(owner.token);
  const ALLOWED = new Set(['id', 'name', 'sku', 'description', 'type', 'category', 'category_name', 'selling_price',
    'tax_rate_id', 'tax_name', 'tax_percentage', 'image_url', 'images', 'options', 'label_code', 'price_mode',
    'price_hint', 'is_one_off', 'available']);
  const list = await api('GET', `/products?limit=50&is_active=0&location_id=${TEST_LOCATION_ID}`, helper.token);
  assert(list.status === 200 && list.body.data.length > 0, `list: ${list.status}`);
  const db = await getDb();
  for (const p of list.body.data) {
    const extra = Object.keys(p).filter((k) => !ALLOWED.has(k));
    assert(extra.length === 0, `product ${p.id} extra keys ${extra}`);
    const row = await db.prepare('SELECT is_active FROM products WHERE id = ?').get(p.id);
    assert(Number(row.is_active) === 1, `inactive product ${p.id} shown to helper`);
  }
  const one = await api('GET', `/products/${list.body.data[0].id}`, helper.token);
  const extra = Object.keys(one.body.data).filter((k) => !ALLOWED.has(k));
  assert(one.status === 200 && extra.length === 0, `detail extra keys ${extra}`);
  for (const o of one.body.data.options || []) {
    assert(JSON.stringify(Object.keys(o).sort()) === JSON.stringify(['id', 'label', 'price']), `option keys ${Object.keys(o)}`);
  }
  const off = await db.prepare('SELECT id FROM products WHERE is_active = 0 LIMIT 1').get();
  if (off) {
    const r = await api('GET', `/products/${off.id}`, helper.token);
    assert(r.status === 404, `inactive detail: ${r.status}`);
  }
});

// ─── Helper selling rules in POST /api/sales (Task 4) ────────
const crypto = require('crypto');
const createdProductIds = [];
let helperThresholdBackup; // undefined = not changed
const NEEDS_OK = "This discount needs the counter's OK.";
const NEEDS_MANAGER = 'This discount needs a manager or the owner.';
const REGISTER_COPY = "The counter hasn't opened the register yet. Ask them to open it, then try again.";
const CUSTOM_COPY = 'Helpers can only sell items from the catalog.';
const OFF_COPY = 'Not for sale right now — ask the counter.';
const SOLD_COPY = 'This one-off item is already sold. Check with the counter.';
const CASH_OR_UPI = 'Take the full amount in cash or UPI.';
const MISMATCH = "The payment doesn't match the total. Check the amounts and try again.";

async function makeProduct({ name, price, mode = 'fixed', oneOff = 0, active = 1, stock = null }) {
  const db = await getDb();
  const r = await db.prepare('INSERT INTO products (name, selling_price, is_active, price_mode, is_one_off) VALUES (?, ?, ?, ?, ?)')
    .run(`${name} ${Date.now()}`, price, active, mode, oneOff);
  const id = r.lastInsertRowid;
  createdProductIds.push(id);
  if (stock !== null) {
    await db.prepare('INSERT INTO product_stock (product_id, location_id, quantity) VALUES (?, ?, ?)').run(id, TEST_LOCATION_ID, stock);
  }
  return (await db.prepare('SELECT id, name FROM products WHERE id = ?').get(id));
}

async function addOption(productId, label, price) {
  const db = await getDb();
  const r = await db.prepare('INSERT INTO product_options (product_id, label, price, is_active) VALUES (?, ?, ?, 1)').run(productId, label, price);
  return r.lastInsertRowid;
}

const newRef = () => crypto.randomBytes(12).toString('base64url');

function sell(token, body) {
  return api('POST', '/sales', token, { location_id: TEST_LOCATION_ID, client_ref: newRef(), ...body });
}

// Helper limit is set to 10% for these checks (restored in cleanup), below the counter limit
async function setHelperLimit(pct) {
  const db = await getDb();
  if (helperThresholdBackup === undefined) {
    const row = await db.prepare("SELECT value FROM settings WHERE key = 'discount_helper_threshold'").get();
    helperThresholdBackup = row ? row.value : null;
  }
  await db.prepare("UPDATE settings SET value = ? WHERE key = 'discount_helper_threshold'").run(String(pct));
}

async function counterLimits() {
  const db = await getDb();
  const rows = await db.prepare("SELECT key, value FROM settings WHERE key IN ('discount_manager_threshold', 'discount_owner_threshold')").all();
  const m = Object.fromEntries(rows.map((r) => [r.key, parseFloat(r.value)]));
  return { manager: m.discount_manager_threshold || 20, owner: m.discount_owner_threshold || 30 };
}

let sellCtx = null;
async function sellSetup() {
  if (sellCtx) return sellCtx;
  const owner = await loginOwner();
  const helper = await helperSession(owner.token);
  const fixed = await makeProduct({ name: 'Verify Fixed', price: 1000, stock: 0 });
  sellCtx = { owner, helper, fixed };
  return sellCtx;
}

async function saleRow(id) {
  const db = await getDb();
  return db.prepare('SELECT * FROM sales WHERE id = ?').get(id);
}

check('helper sale needs a valid client_ref', async () => {
  const { helper, fixed } = await sellSetup();
  const base = { items: [{ product_id: fixed.id, quantity: 1, unit_price: 1000 }], payments: [{ method: 'upi', amount: 1000 }] };
  for (const client_ref of [undefined, '', 'has space', 'x'.repeat(65)]) {
    const r = await api('POST', '/sales', helper.token, { location_id: TEST_LOCATION_ID, ...base, client_ref });
    assert(r.status === 400 && /basket number/.test(r.body?.message || ''), `client_ref ${client_ref}: ${r.status} ${JSON.stringify(r.body)}`);
  }
});

check('helper prices come from the catalog', async () => {
  const { helper, fixed } = await sellSetup();
  const cheap = await sell(helper.token, { items: [{ product_id: fixed.id, quantity: 1, unit_price: 1 }], payments: [{ method: 'upi', amount: 1 }] });
  assert(cheap.status === 400 && cheap.body?.message === MISMATCH, `paid 1 for 1000: ${cheap.status} ${JSON.stringify(cheap.body)}`);
  const r = await sell(helper.token, { items: [{ product_id: fixed.id, quantity: 2, unit_price: 1, product_name: 'Cheap' }], payments: [{ method: 'upi', amount: 2000 }] });
  assert(r.status === 201, `sale: ${r.status} ${JSON.stringify(r.body)}`);
  assert(Number(r.body.data.grand_total) === 2000, `grand_total ${r.body.data.grand_total}`);
  const it = r.body.data.items[0];
  assert(Number(it.unit_price) === 1000 && it.product_name === fixed.name, `item: ${JSON.stringify(it)}`);
});

check('helper option price and name', async () => {
  const { helper } = await sellSetup();
  const p = await makeProduct({ name: 'Verify Sized', price: 100 });
  await addOption(p.id, 'Small', 300);
  const large = await addOption(p.id, 'Large', 800);
  const noSize = await sell(helper.token, { items: [{ product_id: p.id, quantity: 1, unit_price: 100 }], payments: [{ method: 'upi', amount: 100 }] });
  assert(noSize.status === 400 && noSize.body?.message === `Pick a size for ${p.name}.`, `no size: ${noSize.status} ${JSON.stringify(noSize.body)}`);
  const r = await sell(helper.token, { items: [{ product_id: p.id, option_id: large, quantity: 1, unit_price: 5 }], payments: [{ method: 'upi', amount: 800 }] });
  assert(r.status === 201, `sale: ${r.status} ${JSON.stringify(r.body)}`);
  const it = r.body.data.items[0];
  assert(Number(it.unit_price) === 800 && it.product_name === `${p.name} (Large)`, `item: ${JSON.stringify(it)}`);
});

check('helper open price uses typed price', async () => {
  const { helper } = await sellSetup();
  const p = await makeProduct({ name: 'Verify Open', price: 0, mode: 'open' });
  const zero = await sell(helper.token, { items: [{ product_id: p.id, quantity: 1, unit_price: 0 }], payments: [{ method: 'upi', amount: 1 }] });
  assert(zero.status === 400 && zero.body?.message === `Type a price for ${p.name}.`, `zero: ${zero.status} ${JSON.stringify(zero.body)}`);
  const r = await sell(helper.token, { items: [{ product_id: p.id, quantity: 2, unit_price: 250.5 }], payments: [{ method: 'upi', amount: 501 }] });
  assert(r.status === 201 && Number(r.body.data.grand_total) === 501, `sale: ${r.status} ${JSON.stringify(r.body)}`);
  assert(Number(r.body.data.items[0].unit_price) === 250.5, `unit ${r.body.data.items[0].unit_price}`);
});

check('helper custom item refused', async () => {
  const { helper } = await sellSetup();
  const r = await sell(helper.token, { items: [{ product_name: 'Rose bunch', quantity: 1, unit_price: 100 }], payments: [{ method: 'upi', amount: 100 }] });
  assert(r.status === 400 && r.body?.message === CUSTOM_COPY, `custom: ${r.status} ${JSON.stringify(r.body)}`);
  const db = await getDb();
  const mat = await db.prepare('SELECT id FROM materials LIMIT 1').get();
  if (mat) {
    const m = await sell(helper.token, { items: [{ material_id: mat.id, quantity: 1, unit_price: 100 }], payments: [{ method: 'upi', amount: 100 }] });
    assert(m.status === 400 && m.body?.message === CUSTOM_COPY, `material: ${m.status} ${JSON.stringify(m.body)}`);
  }
});

check('helper switched-off and sold one-off items refused', async () => {
  const { helper } = await sellSetup();
  const off = await makeProduct({ name: 'Verify Off', price: 100, active: 0 });
  const r1 = await sell(helper.token, { items: [{ product_id: off.id, quantity: 1, unit_price: 100 }], payments: [{ method: 'upi', amount: 100 }] });
  assert(r1.status === 409 && r1.body?.message === OFF_COPY, `off: ${r1.status} ${JSON.stringify(r1.body)}`);
  const sold = await makeProduct({ name: 'Verify OneOff', price: 100, oneOff: 1, stock: 0 });
  const r2 = await sell(helper.token, { items: [{ product_id: sold.id, quantity: 1, unit_price: 100 }], payments: [{ method: 'upi', amount: 100 }] });
  assert(r2.status === 409 && r2.body?.message === SOLD_COPY, `sold: ${r2.status} ${JSON.stringify(r2.body)}`);
  // A one-off still in stock sells once, then is sold
  const one = await makeProduct({ name: 'Verify OneOff2', price: 100, oneOff: 1, stock: 1 });
  const ok = await sell(helper.token, { items: [{ product_id: one.id, quantity: 1, unit_price: 100 }], payments: [{ method: 'upi', amount: 100 }] });
  assert(ok.status === 201 && ok.body.data.status === 'completed', `one-off sale: ${ok.status} ${JSON.stringify(ok.body)}`);
  const again = await sell(helper.token, { items: [{ product_id: one.id, quantity: 1, unit_price: 100 }], payments: [{ method: 'upi', amount: 100 }] });
  assert(again.status === 409 && again.body?.message === SOLD_COPY, `one-off again: ${again.status} ${JSON.stringify(again.body)}`);
});

check('helper credit refused', async () => {
  const { helper, fixed } = await sellSetup();
  const items = [{ product_id: fixed.id, quantity: 1, unit_price: 1000 }];
  const cases = [
    [{ is_credit_sale: true, payments: [{ method: 'upi', amount: 1000 }] }, CASH_OR_UPI],
    [{ payments: [] }, CASH_OR_UPI],
    [{ payments: [{ method: 'card', amount: 1000 }] }, CASH_OR_UPI],
    [{ payments: [{ method: 'upi', amount: 400 }] }, MISMATCH],
    [{ payments: [{ method: 'upi', amount: 1000.01 }] }, MISMATCH],
  ];
  for (const [extra, copy] of cases) {
    const r = await sell(helper.token, { items, ...extra });
    assert(r.status === 400 && r.body?.message === copy, `${JSON.stringify(extra)}: ${r.status} ${JSON.stringify(r.body)}`);
  }
  // Split cash + UPI to the paisa is fine (register open for the cash part)
  const owner = await loginOwner();
  await openRegister(owner.token, TEST_LOCATION_ID, 100);
  const split = await sell(helper.token, { items, payments: [{ method: 'cash', amount: 399.99 }, { method: 'upi', amount: 600.01 }] });
  assert(split.status === 201 && split.body.data.payment_status === 'paid', `split: ${split.status} ${JSON.stringify(split.body)}`);
});

check('helper discount within limit ok', async () => {
  const { helper, fixed } = await sellSetup();
  await setHelperLimit(10);
  const pct = await sell(helper.token, { items: [{ product_id: fixed.id, quantity: 1 , unit_price: 1000 }], discount_type: 'percentage', discount_value: 10, payments: [{ method: 'upi', amount: 900 }] });
  assert(pct.status === 201 && Number(pct.body.data.grand_total) === 900, `10%: ${pct.status} ${JSON.stringify(pct.body)}`);
  assert(pct.body.data.discount_approved_by === null, `approved_by ${pct.body.data.discount_approved_by}`);
  const amt = await sell(helper.token, { items: [{ product_id: fixed.id, quantity: 1, unit_price: 1000 }], discount_type: 'fixed', discount_value: 50, payments: [{ method: 'upi', amount: 950 }] });
  assert(amt.status === 201 && Number(amt.body.data.grand_total) === 950 && amt.body.data.discount_approved_by === null, `₹50: ${amt.status} ${JSON.stringify(amt.body)}`);
});

check('helper discount over limit needs override', async () => {
  const { helper, fixed } = await sellSetup();
  await setHelperLimit(10);
  const r = await sell(helper.token, { items: [{ product_id: fixed.id, quantity: 1, unit_price: 1000 }], discount_type: 'fixed', discount_value: 150, payments: [{ method: 'upi', amount: 850 }] });
  assert(r.status === 403 && r.body?.message === NEEDS_OK, `15% no override: ${r.status} ${JSON.stringify(r.body)}`);
});

check('override by counter staff above manager threshold refused', async () => {
  const { owner, helper, fixed } = await sellSetup();
  await setHelperLimit(10);
  const { manager } = await counterLimits();
  const cs = await makeStaff(owner.token, 'counter_staff');
  await api('PUT', `/users/${cs.id}/pin`, owner.token, { pin: '2580' });
  const pct = manager + 5;
  const pay = 1000 - pct * 10;
  const r = await sell(helper.token, { items: [{ product_id: fixed.id, quantity: 1, unit_price: 1000 }], discount_type: 'percentage', discount_value: pct, payments: [{ method: 'upi', amount: pay }], discount_override: { employee_code: cs.employee_code, pin: '2580' } });
  assert(r.status === 403 && r.body?.message === NEEDS_MANAGER, `counter OK above its limit: ${r.status} ${JSON.stringify(r.body)}`);
  // Within the counter limit, the same counter staff can OK it
  const within = await sell(helper.token, { items: [{ product_id: fixed.id, quantity: 1, unit_price: 1000 }], discount_type: 'percentage', discount_value: manager, payments: [{ method: 'upi', amount: 1000 - manager * 10 }], discount_override: { employee_code: cs.employee_code, pin: '2580' } });
  assert(within.status === 201 && within.body.data.discount_approved_by === cs.id, `counter OK within limit: ${within.status} ${JSON.stringify(within.body)}`);
});

check('override by manager ok and recorded in discount_approved_by', async () => {
  const { owner, helper, fixed } = await sellSetup();
  await setHelperLimit(10);
  const { manager, owner: ownerLimit } = await counterLimits();
  const mgr = await makeStaff(owner.token, 'manager');
  const pinRes = await api('PUT', `/users/${mgr.id}/pin`, owner.token, { pin: '1470' });
  const code = pinRes.body.data.employee_code;
  const pct = Math.min(manager + 5, ownerLimit);
  const r = await sell(helper.token, { items: [{ product_id: fixed.id, quantity: 1, unit_price: 1000 }], discount_type: 'percentage', discount_value: pct, payments: [{ method: 'upi', amount: 1000 - pct * 10 }], discount_override: { employee_code: code, pin: '1470' } });
  assert(r.status === 201, `manager OK: ${r.status} ${JSON.stringify(r.body)}`);
  const row = await saleRow(r.body.data.id);
  assert(row.discount_approved_by === mgr.id && Number(row.discount_percentage) === pct, `row: approved_by ${row.discount_approved_by} pct ${row.discount_percentage}`);
  // Wrong PIN passes the PIN check copy through
  const w = await sell(helper.token, { items: [{ product_id: fixed.id, quantity: 1, unit_price: 1000 }], discount_type: 'percentage', discount_value: pct, payments: [{ method: 'upi', amount: 1000 - pct * 10 }], discount_override: { employee_code: code, pin: '0000' } });
  assert(w.status === 401 && w.body?.message === "That PIN didn't match. 4 tries left.", `wrong pin: ${w.status} ${JSON.stringify(w.body)}`);
  // Nothing in the response carries PIN data
  assert(!JSON.stringify(r.body).includes('pin_hash'), 'pin_hash in response');
});

check('override wrong PIN 5 times locks the approver', async () => {
  const { owner, helper, fixed } = await sellSetup();
  await setHelperLimit(10);
  const cs = await makeStaff(owner.token, 'counter_staff');
  await api('PUT', `/users/${cs.id}/pin`, owner.token, { pin: '3690' });
  const db = await getDb();
  const before = Number((await db.prepare('SELECT COUNT(*) AS c FROM sales WHERE created_by = ?').get(helper.id)).c);
  const body = { items: [{ product_id: fixed.id, quantity: 1, unit_price: 1000 }], discount_type: 'percentage', discount_value: 15, payments: [{ method: 'upi', amount: 850 }] };
  for (let i = 1; i <= 4; i++) {
    const r = await sell(helper.token, { ...body, discount_override: { employee_code: cs.employee_code, pin: '0000' } });
    assert(r.status === 401 && r.body?.message === `That PIN didn't match. ${5 - i} tries left.`, `try ${i}: ${r.status} ${JSON.stringify(r.body)}`);
  }
  const fifth = await sell(helper.token, { ...body, discount_override: { employee_code: cs.employee_code, pin: '0000' } });
  assert(fifth.status === 423 && fifth.body?.message === LOCKED_COPY, `try 5: ${fifth.status} ${JSON.stringify(fifth.body)}`);
  const right = await sell(helper.token, { ...body, discount_override: { employee_code: cs.employee_code, pin: '3690' } });
  assert(right.status === 423, `right PIN while locked: ${right.status} ${JSON.stringify(right.body)}`);
  const login = await api('POST', '/auth/staff-login', null, { employee_code: cs.employee_code, pin: '3690' });
  assert(login.status === 423, `staff-login after override lock: ${login.status} ${JSON.stringify(login.body)}`);
  const after = Number((await db.prepare('SELECT COUNT(*) AS c FROM sales WHERE created_by = ?').get(helper.id)).c);
  assert(after === before, `refused overrides created ${after - before} sale(s)`);
  // A malformed basket never reaches the PIN check (no try is burned)
  const cs2 = await makeStaff(owner.token, 'counter_staff');
  await api('PUT', `/users/${cs2.id}/pin`, owner.token, { pin: '3690' });
  const bad = await sell(helper.token, { ...body, payments: [{ method: 'upi', amount: 1 }], discount_override: { employee_code: cs2.employee_code, pin: '0000' } });
  assert(bad.status === 400 && bad.body?.message === MISMATCH, `bad basket: ${bad.status} ${JSON.stringify(bad.body)}`);
  const row = await db.prepare('SELECT pin_failed_attempts FROM users WHERE id = ?').get(cs2.id);
  assert(!Number(row.pin_failed_attempts), `try burned on a bad basket: ${row.pin_failed_attempts}`);
});

check('client_ref makes retries safe', async () => {
  const { helper, fixed } = await sellSetup();
  const ref = newRef();
  const body = { location_id: TEST_LOCATION_ID, client_ref: ref, items: [{ product_id: fixed.id, quantity: 1, unit_price: 1000 }], payments: [{ method: 'upi', amount: 1000 }] };
  const first = await api('POST', '/sales', helper.token, body);
  assert(first.status === 201 && !first.body.duplicate, `first: ${first.status} ${JSON.stringify(first.body)}`);
  const second = await api('POST', '/sales', helper.token, body);
  assert(second.status === 200 && second.body.duplicate === true && second.body.data.id === first.body.data.id, `retry: ${second.status} ${JSON.stringify(second.body)}`);
  const keys = (o) => JSON.stringify(Object.keys(o).sort());
  assert(keys(second.body.data) === keys(first.body.data), `shape differs: ${keys(second.body.data)} vs ${keys(first.body.data)}`);
  assert(second.body.data.items.length === 1 && second.body.data.payments.length === 1, 'retry items/payments');
  // A retry with a changed basket still answers with the saved sale, writing nothing
  const third = await api('POST', '/sales', helper.token, { ...body, payments: [{ method: 'upi', amount: 5 }] });
  assert(third.status === 200 && third.body.data.id === first.body.data.id, `changed retry: ${third.status}`);
  const db = await getDb();
  const n = await db.prepare('SELECT COUNT(*) AS c FROM sales WHERE created_by = ? AND client_ref = ?').get(helper.id, ref);
  assert(Number(n.c) === 1, `sales with ref: ${n.c}`);
  const pays = await db.prepare('SELECT COUNT(*) AS c FROM payments WHERE sale_id = ?').get(first.body.data.id);
  assert(Number(pays.c) === 1, `payments: ${pays.c}`);
});

check('concurrent same client_ref creates one sale', async () => {
  const { helper, fixed } = await sellSetup();
  const ref = newRef();
  const body = { location_id: TEST_LOCATION_ID, client_ref: ref, items: [{ product_id: fixed.id, quantity: 1, unit_price: 1000 }], payments: [{ method: 'upi', amount: 1000 }] };
  const out = await Promise.all(Array.from({ length: 5 }, () => api('POST', '/sales', helper.token, body)));
  assert(out.every((r) => r.status === 200 || r.status === 201), `statuses: ${out.map((r) => `${r.status} ${r.body?.message || ''}`)}`);
  const ids = new Set(out.map((r) => r.body.data.id));
  assert(ids.size === 1 && out.filter((r) => r.status === 201).length === 1, `ids ${[...ids]} statuses ${out.map((r) => r.status)}`);
  const db = await getDb();
  const n = await db.prepare('SELECT COUNT(*) AS c FROM sales WHERE created_by = ? AND client_ref = ?').get(helper.id, ref);
  assert(Number(n.c) === 1, `sales with ref: ${n.c}`);
});

check('cash with closed register refused with helper copy', async () => {
  const { owner, helper, fixed } = await sellSetup();
  await ensureClosed(owner.token, TEST_LOCATION_ID);
  const items = [{ product_id: fixed.id, quantity: 1, unit_price: 1000 }];
  const cash = await sell(helper.token, { items, payments: [{ method: 'cash', amount: 1000 }] });
  assert(cash.status === 400 && cash.body?.message === REGISTER_COPY, `cash: ${cash.status} ${JSON.stringify(cash.body)}`);
  const upi = await sell(helper.token, { items, payments: [{ method: 'upi', amount: 1000 }] });
  assert(upi.status === 201, `upi without register: ${upi.status} ${JSON.stringify(upi.body)}`);
  // With the register open, cash lands in it
  const reg = await openRegister(owner.token, TEST_LOCATION_ID, 100);
  const db = await getDb();
  const before = await db.prepare('SELECT expected_cash, total_cash_sales FROM cash_registers WHERE id = ?').get(reg.id);
  const ok = await sell(helper.token, { items, payments: [{ method: 'cash', amount: 1000 }] });
  assert(ok.status === 201, `cash with register: ${ok.status} ${JSON.stringify(ok.body)}`);
  const after = await db.prepare('SELECT expected_cash, total_cash_sales FROM cash_registers WHERE id = ?').get(reg.id);
  assert(Number(after.expected_cash) - Number(before.expected_cash) === 1000 && Number(after.total_cash_sales) - Number(before.total_cash_sales) === 1000, `register: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
});

check('sold_by is the helper', async () => {
  const { owner, helper, fixed } = await sellSetup();
  const r = await sell(helper.token, {
    order_type: 'delivery', channel: 'whatsapp', sold_by: owner.id, skip_assignment: false, entry_mode: 'quick',
    delivery_address: 'Somewhere', delivery_charges: 100, customer_id: owner.id,
    items: [{ product_id: fixed.id, quantity: 1, unit_price: 1000, special_instructions: 'x' }],
    payments: [{ method: 'upi', amount: 1000 }],
  });
  assert(r.status === 201, `sale: ${r.status} ${JSON.stringify(r.body)}`);
  const row = await saleRow(r.body.data.id);
  assert(row.sold_by === helper.id && row.created_by === helper.id, `sold_by ${row.sold_by} created_by ${row.created_by}`);
  assert(row.order_type === 'walk_in' && row.channel === 'walk_in' && row.status === 'completed' && row.payment_status === 'paid', `shape: ${row.order_type}/${row.channel}/${row.status}/${row.payment_status}`);
  assert(row.entry_mode === null && row.customer_id === null && Number(row.delivery_charges) === 0, `extras kept: ${row.entry_mode} ${row.customer_id} ${row.delivery_charges}`);
  const db = await getDb();
  const del = await db.prepare('SELECT COUNT(*) AS c FROM deliveries WHERE sale_id = ?').get(row.id);
  const open = await db.prepare("SELECT COUNT(*) AS c FROM production_tasks WHERE sale_id = ? AND status <> 'completed'").get(row.id);
  assert(Number(del.c) === 0 && Number(open.c) === 0, `deliveries ${del.c} open tasks ${open.c}`);
});

// ─── Fix round 1 ─────────────────────────────────────────────
const APPROVER_WRONG_SHOP = "That person doesn't work at this shop. Ask someone at the counter here.";
const UNFINISHED = "This sale didn't finish saving. Ask the counter to check it before you take payment again.";

async function makeStaffAt(ownerToken, role, locationId) {
  const phone = testPhone();
  const r = await api('POST', '/users', ownerToken, { name: `Verify ${role}`, phone, password: PASSWORD, role, location_ids: [locationId] });
  assert(r.status === 201, `create ${role}: ${r.status} ${JSON.stringify(r.body)}`);
  createdUserIds.push(r.body.data.user.id);
  return r.body.data.user;
}

check('override approver must work at this shop', async () => {
  const { owner, helper, fixed } = await sellSetup();
  await setHelperLimit(10);
  const db = await getDb();
  const other = await db.prepare('SELECT id FROM locations WHERE id <> ? ORDER BY id LIMIT 1').get(TEST_LOCATION_ID);
  assert(other, 'need a second location');
  const cs = await makeStaffAt(owner.token, 'counter_staff', other.id);
  await api('PUT', `/users/${cs.id}/pin`, owner.token, { pin: '2468' });
  const body = { items: [{ product_id: fixed.id, quantity: 1, unit_price: 1000 }], discount_type: 'percentage', discount_value: 15, payments: [{ method: 'upi', amount: 850 }] };
  for (const pin of ['2468', '0000']) {
    const r = await sell(helper.token, { ...body, discount_override: { employee_code: cs.employee_code, pin } });
    assert(r.status === 403 && r.body?.message === APPROVER_WRONG_SHOP, `other shop pin ${pin}: ${r.status} ${JSON.stringify(r.body)}`);
  }
  const row = await db.prepare('SELECT pin_failed_attempts FROM users WHERE id = ?').get(cs.id);
  assert(!Number(row.pin_failed_attempts), `wrong-shop approver lost a try: ${row.pin_failed_attempts}`);
  // An owner can approve from anywhere (throwaway owner linked to the other shop only)
  const emp = await makeStaffAt(owner.token, 'employee', other.id);
  const made = await api('PUT', `/users/${emp.id}/change-role`, owner.token, { role: 'owner' });
  assert(made.status === 200, `make owner: ${made.status}`);
  const pinRes = await api('PUT', `/users/${emp.id}/pin`, owner.token, { pin: '8642' });
  const ok = await sell(helper.token, { ...body, discount_override: { employee_code: pinRes.body.data.employee_code, pin: '8642' } });
  assert(ok.status === 201 && ok.body.data.discount_approved_by === emp.id, `owner from another shop: ${ok.status} ${JSON.stringify(ok.body)}`);
  // An unknown code still gets the usual answer
  const unknown = await sell(helper.token, { ...body, discount_override: { employee_code: '99999999', pin: '1234' } });
  assert(unknown.status === 401 && unknown.body?.message === 'Employee code not recognized.', `unknown: ${unknown.status} ${JSON.stringify(unknown.body)}`);
});

check('one-off lines are summed against stock', async () => {
  const { helper } = await sellSetup();
  const one = await makeProduct({ name: 'Verify OneOff3', price: 100, oneOff: 1, stock: 1 });
  const line = { product_id: one.id, quantity: 1, unit_price: 100 };
  const r = await sell(helper.token, { items: [line, line], payments: [{ method: 'upi', amount: 200 }] });
  assert(r.status === 409 && r.body?.message === SOLD_COPY, `two lines: ${r.status} ${JSON.stringify(r.body)}`);
});

check('helper limit is never above the counter limit', async () => {
  const { helper, fixed } = await sellSetup();
  const { manager } = await counterLimits();
  await setHelperLimit(manager + 20);
  const pct = manager + 1;
  const r = await sell(helper.token, { items: [{ product_id: fixed.id, quantity: 1, unit_price: 1000 }], discount_type: 'percentage', discount_value: pct, payments: [{ method: 'upi', amount: 1000 - pct * 10 }] });
  assert(r.status === 403 && r.body?.message === NEEDS_OK, `above counter limit: ${r.status} ${JSON.stringify(r.body)}`);
  await setHelperLimit(10);
});

check('a repeat of an unfinished sale is not answered as saved', async () => {
  const { helper, fixed } = await sellSetup();
  const db = await getDb();
  const ref = newRef();
  const body = { location_id: TEST_LOCATION_ID, client_ref: ref, items: [{ product_id: fixed.id, quantity: 1, unit_price: 1000 }], payments: [{ method: 'upi', amount: 1000 }] };
  const first = await api('POST', '/sales', helper.token, body);
  assert(first.status === 201, `first: ${first.status}`);
  // Saved row with no payments (as if the save stopped half way)
  await db.prepare('DELETE FROM payments WHERE sale_id = ?').run(first.body.data.id);
  const r1 = await api('POST', '/sales', helper.token, body);
  assert(r1.status === 409 && r1.body?.message === UNFINISHED, `paid status, no payments: ${r1.status} ${JSON.stringify(r1.body)}`);
  await db.prepare("UPDATE sales SET payment_status = 'pending' WHERE id = ?").run(first.body.data.id);
  const r2 = await api('POST', '/sales', helper.token, body);
  assert(r2.status === 409 && r2.body?.message === UNFINISHED, `pending: ${r2.status} ${JSON.stringify(r2.body)}`);
  const n = await db.prepare('SELECT COUNT(*) AS c FROM sales WHERE created_by = ? AND client_ref = ?').get(helper.id, ref);
  assert(Number(n.c) === 1, `sales with ref: ${n.c}`);
});

// ─── Helper undo and my sales (Task 5) ───────────────────────
const NOT_YOURS = 'Ask the counter to undo this sale.';
const TOO_OLD = "It's been more than 2 minutes. Ask the counter to undo this sale.";
const undoSale = (token, id) => api('POST', `/quick-sale/${id}/undo`, token, {});
const mySales = (token) => api('GET', `/quick-sale/my-sales?location_id=${TEST_LOCATION_ID}`, token);

async function helperSaleOf(token, method, amount = 1000) {
  const prod = amount === 1000 ? (await sellSetup()).fixed : await makeProduct({ name: `Verify P${amount}`, price: amount, stock: 0 });
  const r = await sell(token, { items: [{ product_id: prod.id, quantity: 1, unit_price: amount }], payments: [{ method, amount }] });
  assert(r.status === 201, `helper sale: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data.id;
}

check('helper can undo own sale within 2 minutes', async () => {
  const { owner, helper } = await sellSetup();
  const reg = await openRegister(owner.token, TEST_LOCATION_ID, 100);
  const db = await getDb();
  const regRow = () => db.prepare('SELECT expected_cash, total_cash_sales, total_upi_sales FROM cash_registers WHERE id = ?').get(reg.id);
  const before = await regRow();
  const cashId = await helperSaleOf(helper.token, 'cash');
  const upiId = await helperSaleOf(helper.token, 'upi', 500);
  const mid = await regRow();
  assert(Number(mid.expected_cash) - Number(before.expected_cash) === 1000, 'cash sale reached the register');
  const a = await undoSale(helper.token, cashId);
  assert(a.status === 200, `undo cash: ${a.status} ${JSON.stringify(a.body)}`);
  const b = await undoSale(helper.token, upiId);
  assert(b.status === 200, `undo upi: ${b.status} ${JSON.stringify(b.body)}`);
  const after = await regRow();
  assert(Number(after.expected_cash) === Number(before.expected_cash) && Number(after.total_cash_sales) === Number(before.total_cash_sales) && Number(after.total_upi_sales) === Number(before.total_upi_sales), `register not restored: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  assert((await saleRow(cashId)).status === 'cancelled', 'sale cancelled');
  const again = await undoSale(helper.token, cashId);
  assert(again.status === 400, `second undo: ${again.status}`);
});

check('helper cannot undo after 2 minutes', async () => {
  const { helper } = await sellSetup();
  const id = await helperSaleOf(helper.token, 'upi');
  const db = await getDb();
  await db.prepare("UPDATE sales SET created_at = NOW() - INTERVAL '3 minutes' WHERE id = ?").run(id);
  const r = await undoSale(helper.token, id);
  assert(r.status === 403 && r.body?.message === TOO_OLD, `${r.status} ${JSON.stringify(r.body)}`);
  assert((await saleRow(id)).status !== 'cancelled', 'sale must stay');
});

check('helper cannot undo someone else\'s sale', async () => {
  const { owner, helper } = await sellSetup();
  const other = await helperSession(owner.token);
  const id = await helperSaleOf(other.token, 'upi');
  const r = await undoSale(helper.token, id);
  assert(r.status === 403 && r.body?.message === NOT_YOURS, `${r.status} ${JSON.stringify(r.body)}`);
  assert((await saleRow(id)).status !== 'cancelled', 'sale must stay');
  const staffSale = await api('POST', '/sales', owner.token, { location_id: TEST_LOCATION_ID, order_type: 'walk_in', items: [{ product_id: (await sellSetup()).fixed.id, quantity: 1, unit_price: 1000 }], payments: [{ method: 'upi', amount: 1000 }] });
  if (staffSale.status === 201) {
    const r2 = await undoSale(helper.token, staffSale.body.data.id);
    assert(r2.status === 403 && r2.body?.message === NOT_YOURS, `counter sale: ${r2.status} ${JSON.stringify(r2.body)}`);
  }
});

check('my-sales lists only the caller\'s sales today', async () => {
  const { owner } = await sellSetup();
  const me = await helperSession(owner.token);
  const other = await helperSession(owner.token);
  const mine = await helperSaleOf(me.token, 'upi', 700);
  const theirs = await helperSaleOf(other.token, 'upi', 300);
  const r = await mySales(me.token);
  assert(r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);
  const ids = r.body.data.sales.map((x) => x.id);
  assert(ids.length === 1 && ids[0] === mine && !ids.includes(theirs), `ids ${ids}`);
  const row = r.body.data.sales[0];
  assert(row.can_undo === true && row.undone === false && row.grand_total === 700 && row.items.length === 1 && /\u00d7 1$/.test(row.items[0]), JSON.stringify(row));
  assert(!JSON.stringify(r.body).match(/cost/i), 'no cost fields');
  const noLoc = await api('GET', '/quick-sale/my-sales', me.token);
  assert(noLoc.status === 400, `no location: ${noLoc.status}`);
});

check('my-sales totals exclude undone sales', async () => {
  const { owner } = await sellSetup();
  await openRegister(owner.token, TEST_LOCATION_ID, 100);
  const me = await helperSession(owner.token);
  const c = await helperSaleOf(me.token, 'cash', 400);
  const u = await helperSaleOf(me.token, 'upi', 600);
  const gone = await helperSaleOf(me.token, 'cash', 250);
  assert((await undoSale(me.token, gone)).status === 200, 'undo');
  const r = await mySales(me.token);
  const d = r.body.data;
  assert(d.count === 2 && d.totals.cash === 400 && d.totals.upi === 600, JSON.stringify(d.totals) + ' count ' + d.count);
  const goneRow = d.sales.find((x) => x.id === gone);
  assert(goneRow && goneRow.undone === true && goneRow.can_undo === false && d.sales.length === 3, 'undone row flagged');
  assert(d.sales[0].id === gone, 'newest first');
  assert(c && u, 'sales made');
});

check('non-helper undo unchanged (counter staff quick sale undo still works)', async () => {
  const { owner } = await sellSetup();
  await openRegister(owner.token, TEST_LOCATION_ID, 100);
  const staff = await makeStaffAt(owner.token, 'counter_staff', TEST_LOCATION_ID);
  const token = await helperToken(staff.phone);
  const s = await api('POST', '/sales', token, { location_id: TEST_LOCATION_ID, order_type: 'walk_in', entry_mode: 'quick', items: [{ product_id: (await sellSetup()).fixed.id, quantity: 1, unit_price: 100 }], payments: [{ method: 'upi', amount: 100 }] });
  assert(s.status === 201, `staff quick sale: ${s.status} ${JSON.stringify(s.body)}`);
  const u = await undoSale(token, s.body.data.id);
  assert(u.status === 200, `undo: ${u.status} ${JSON.stringify(u.body)}`);
  // a normal (non quick) sale is still not undoable through this route
  const full = await api('POST', '/sales', token, { location_id: TEST_LOCATION_ID, order_type: 'walk_in', items: [{ product_id: (await sellSetup()).fixed.id, quantity: 1, unit_price: 100 }], payments: [{ method: 'upi', amount: 100 }] });
  if (full.status === 201) {
    const n = await undoSale(token, full.body.data.id);
    assert(n.status === 400, `non-quick: ${n.status}`);
  }
});

check('undoing a mixed cash and upi helper sale reverses both', async () => {
  const { owner, helper, fixed } = await sellSetup();
  const reg = await openRegister(owner.token, TEST_LOCATION_ID, 100);
  const db = await getDb();
  const regRow = () => db.prepare('SELECT expected_cash, total_cash_sales, total_upi_sales FROM cash_registers WHERE id = ?').get(reg.id);
  const before = await regRow();
  const r = await sell(helper.token, { items: [{ product_id: fixed.id, quantity: 1, unit_price: 1000 }], payments: [{ method: 'cash', amount: 400 }, { method: 'upi', amount: 600 }] });
  assert(r.status === 201, `mixed sale: ${r.status} ${JSON.stringify(r.body)}`);
  const mid = await regRow();
  assert(Number(mid.total_cash_sales) - Number(before.total_cash_sales) === 400 && Number(mid.total_upi_sales) - Number(before.total_upi_sales) === 600, 'both reached the register');
  const u = await undoSale(helper.token, r.body.data.id);
  assert(u.status === 200, `undo: ${u.status} ${JSON.stringify(u.body)}`);
  const after = await regRow();
  assert(Number(after.expected_cash) === Number(before.expected_cash) && Number(after.total_cash_sales) === Number(before.total_cash_sales) && Number(after.total_upi_sales) === Number(before.total_upi_sales), `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
});

check('helper undo copy hides refund and register wording', async () => {
  const { owner, helper } = await sellSetup();
  await openRegister(owner.token, TEST_LOCATION_ID, 100);
  const id = await helperSaleOf(helper.token, 'upi', 800);
  const db = await getDb();
  await db.prepare("INSERT INTO refunds (sale_id, amount, reason, refund_method, status, requested_by, approved_by) VALUES (?, 1, 'verify', 'upi', 'processed', ?, ?)").run(id, owner.id, owner.id);
  const r = await undoSale(helper.token, id);
  await db.prepare('DELETE FROM refunds WHERE sale_id = ?').run(id);
  assert(r.status === 409 && r.body?.message === NOT_YOURS, `${r.status} ${JSON.stringify(r.body)}`);
});

async function cleanupHelperSales() {
  const db = await getDb();
  if (helperThresholdBackup !== undefined) {
    await db.prepare("UPDATE settings SET value = ? WHERE key = 'discount_helper_threshold'").run(helperThresholdBackup);
  }
  let saleCount = 0;
  if (createdUserIds.length) {
    const ph = createdUserIds.map(() => '?').join(', ');
    const sales = await db.prepare(`SELECT id FROM sales WHERE created_by IN (${ph})`).all(...createdUserIds);
    for (const { id } of sales) {
      try {
        await db.prepare('DELETE FROM production_tasks WHERE sale_id = ?').run(id);
        await db.prepare('DELETE FROM deliveries WHERE sale_id = ?').run(id);
        await db.prepare('DELETE FROM payments WHERE sale_id = ?').run(id);
        await db.prepare('DELETE FROM sale_items WHERE sale_id = ?').run(id);
        await db.prepare("DELETE FROM audit_logs WHERE entity_type = 'sale' AND entity_id = ?").run(id);
        await db.prepare('DELETE FROM sales WHERE id = ?').run(id);
        saleCount += 1;
      } catch (err) {
        console.error(`   (cleanup warning: sale ${id}: ${err.message})`);
      }
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
  console.log(`Cleaned up ${saleCount} helper sale(s) and ${createdProductIds.length} test product(s)`);
}

async function cleanup() {
  await cleanupHelperSales();
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
