/**
 * Shared harness for live verify scripts. Copied from
 * verify-register-expenses.js (which is left untouched).
 * Local dev only: assertLocalTarget() refuses non-localhost targets.
 */
require('dotenv').config();
const { getDb } = require('../../config/database-async');

const API_BASE = process.env.API_BASE_URL || 'http://localhost:3001/api';
const TEST_LOCATION_ID = 4; // "Test Loc"

const checks = [];
const createdRegisterIds = [];

function check(name, fn) {
  checks.push({ name, fn });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertLocalTarget() {
  const isLocalUrl = (url) => {
    try {
      const { hostname } = new URL(url);
      return hostname === 'localhost' || hostname === '127.0.0.1';
    } catch {
      return false;
    }
  };
  const problems = [];
  if (!isLocalUrl(API_BASE)) problems.push(`API_BASE_URL ("${API_BASE}")`);
  const databaseUrl = process.env.DATABASE_URL || '';
  if (!isLocalUrl(databaseUrl)) problems.push(`DATABASE_URL ("${databaseUrl.replace(/:[^:@]*@/, ':***@')}")`);
  if (problems.length > 0) {
    console.error(`Refusing to run: ${problems.join(' and ')} do${problems.length === 1 ? 'es' : ''} not point at localhost/127.0.0.1.`);
    process.exit(1);
  }
}

async function api(method, path, token, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON response */ }
  return { status: res.status, body: json };
}

async function loginOwner() {
  const phone = process.env.VERIFY_OWNER_PHONE;
  const password = process.env.VERIFY_OWNER_PASSWORD;
  if (!phone || !password) throw new Error('VERIFY_OWNER_PHONE and VERIFY_OWNER_PASSWORD must both be set in the environment - no default credentials are used.');
  const { status, body } = await api('POST', '/auth/login', null, { phone, password });
  if (status !== 200 || !body?.data?.token) throw new Error(`Owner login failed: ${status} ${JSON.stringify(body)}`);
  return { token: body.data.token, id: body.data.user.id, role: body.data.user.role };
}

// A6 (2026-11-10): tests only ever close or use a register they opened. A
// register someone else opened at the test shop stops the run with this
// message instead of being closed (or sold into) by the test.
function foreignRegisterMessage(reg) {
  const who = reg && reg.opened_by_name ? ` by ${reg.opened_by_name}` : '';
  const when = reg && reg.opened_at
    ? ` at ${new Date(reg.opened_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}`
    : '';
  return `Test Loc already has register #${reg && reg.id} open (opened${who}${when}). `
    + 'These tests only close registers they opened themselves. Close it in the app (Cash Register), then run the tests again.';
}

// Status body of GET /sales/register/status. Throws when a register is open
// that is not in ownIds; returns true when one of ownIds is open.
function assertOwnRegister(statusBody, ownIds) {
  if (!statusBody || !statusBody.isOpen) return false;
  const reg = statusBody.data || {};
  if (!(ownIds || []).includes(reg.id)) {
    const err = new Error(foreignRegisterMessage(reg));
    err.foreignRegister = true;
    throw err;
  }
  return true;
}

async function ensureClosed(token, locationId, ownIds = createdRegisterIds) {
  const { body } = await api('GET', `/sales/register/status?location_id=${locationId}`, token);
  if (!assertOwnRegister(body, ownIds)) return;
  await api('PUT', '/sales/register/close', token, { location_id: locationId, actual_cash: Number(body.data.expected_cash) || 0 });
}

async function openRegister(token, locationId, openingBalance) {
  await ensureClosed(token, locationId);
  const { status, body } = await api('POST', '/sales/register/open', token, { location_id: locationId, opening_balance: openingBalance });
  assert(status === 201, `Could not open register: ${status} ${JSON.stringify(body)}`);
  createdRegisterIds.push(body.data.id);
  return body.data;
}

async function closeRegisterWith(token, locationId, actualCash) {
  const { status, body } = await api('PUT', '/sales/register/close', token, { location_id: locationId, actual_cash: actualCash });
  assert(status === 200, `Could not close register: ${status} ${JSON.stringify(body)}`);
  return body.data;
}

// Runs every registered check, then the caller's cleanup, then exits.
async function refuseIfRegisterOpen(locationId = TEST_LOCATION_ID) {
  const owner = await loginOwner();
  const { body } = await api('GET', `/sales/register/status?location_id=${locationId}`, owner.token);
  if (body && body.isOpen) {
    console.log(foreignRegisterMessage(body.data));
    process.exit(1);
  }
}

async function run({ cleanup } = {}) {
  assertLocalTarget();
  await refuseIfRegisterOpen();
  let pass = 0, fail = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      console.log(`PASS ${name}`);
      pass++;
    } catch (err) {
      console.log(`FAIL ${name}`);
      console.log(`   ${err.message}`);
      fail++;
      if (err.foreignRegister) { console.log('\nStopped: nothing else was run.'); break; }
    }
  }
  if (cleanup) {
    try { await cleanup(); } catch (err) { console.error(`   (cleanup warning: ${err.message})`); }
  }
  if (createdRegisterIds.length) {
    const db = await getDb();
    for (const id of createdRegisterIds) {
      try { await db.prepare('DELETE FROM cash_registers WHERE id = ?').run(id); } catch (err) {
        console.error(`   (cleanup warning: register ${id}: ${err.message})`);
      }
    }
  }
  console.log(`\n${pass}/${pass + fail} checks passed`);
  process.exit(fail > 0 ? 1 : 0);
}

module.exports = { check, checks, api, loginOwner, ensureClosed, assertOwnRegister, foreignRegisterMessage, refuseIfRegisterOpen, openRegister, closeRegisterWith, assert, assertLocalTarget, run, getDb, TEST_LOCATION_ID, createdRegisterIds };
