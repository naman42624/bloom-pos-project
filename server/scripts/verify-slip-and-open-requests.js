#!/usr/bin/env node
/**
 * Live verification for the slip QR scan page, open order-request link and
 * checkout fixes (spec 2026-10-28-slip-qr-open-orders-checkout-design.md).
 * Same harness shape as verify-order-flows.js: append checks, never remove.
 *
 * Usage: TRACKING_LINK_SECRET=... VERIFY_OWNER_PHONE=... VERIFY_OWNER_PASSWORD=... node scripts/verify-slip-and-open-requests.js
 */
require('dotenv').config();
const { getDb } = require('../config/database-async');
const { generateSlipToken, verifySlipToken } = require('../utils/slip-token');
const { generateTrackingToken, verifyTrackingToken } = require('../utils/tracking-token');

const API_BASE = process.env.API_BASE_URL || 'http://localhost:3001/api';
const TEST_LOCATION_ID = 4; // "Test Loc" — the project's established scratch location

const checks = [];
const createdSaleIds = [];

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
  if (!phone || !password) throw new Error('VERIFY_OWNER_PHONE and VERIFY_OWNER_PASSWORD must both be set in the environment — no default credentials are used.');
  const { status, body } = await api('POST', '/auth/login', null, { phone, password });
  if (status !== 200 || !body?.data?.token) throw new Error(`Owner login failed: ${status} ${JSON.stringify(body)}`);
  return { token: body.data.token, id: body.data.user.id, role: body.data.user.role };
}

async function cleanup() {
  if (createdSaleIds.length === 0) return;
  const db = await getDb();
  for (const saleId of createdSaleIds) {
    try {
      await db.prepare('DELETE FROM pickup_load_checks WHERE sale_id = ?').run(saleId);
      await db.prepare('DELETE FROM sales WHERE id = ?').run(saleId);
    } catch (err) {
      console.log(`   cleanup of sale ${saleId} failed: ${err.message}`);
    }
  }
}

async function columnOrTableExists(table, column) {
  const db = await getDb();
  const row = column
    ? await db.prepare('SELECT 1 AS ok FROM information_schema.columns WHERE table_name = ? AND column_name = ?').get(table, column)
    : await db.prepare('SELECT 1 AS ok FROM information_schema.tables WHERE table_name = ?').get(table);
  return !!row;
}

check('slip token round-trips to the sale id', async () => {
  const t = generateSlipToken(42);
  assert(verifySlipToken(t) === 42, `Expected 42, got ${verifySlipToken(t)}`);
});

check('tampered slip token and a tracking token are rejected', async () => {
  const t = generateSlipToken(42);
  const [id, sig] = t.split('.');
  const flipped = sig.slice(0, -1) + (sig.slice(-1) === '0' ? '1' : '0');
  assert(verifySlipToken(`${id}.${flipped}`) === null, 'Tampered signature should be null');
  assert(verifySlipToken(`43.${sig}`) === null, 'Swapped id should be null');
  assert(verifySlipToken(generateTrackingToken(42)) === null, 'Tracking token must not verify as a slip token');
  assert(verifySlipToken('garbage') === null && verifySlipToken(undefined) === null, 'Garbage should be null');
});

check('a slip token is not accepted as a tracking token', async () => {
  assert(verifyTrackingToken(generateSlipToken(42)) === null, 'Slip token must not verify as a tracking token');
});

check('pickup_load_checks table, checked_via and status_token columns exist', async () => {
  assert(await columnOrTableExists('pickup_load_checks'), 'pickup_load_checks missing');
  assert(await columnOrTableExists('delivery_load_checks', 'checked_via'), 'delivery_load_checks.checked_via missing');
  assert(await columnOrTableExists('order_requests', 'status_token'), 'order_requests.status_token missing');
  for (const c of ['requester_name', 'requester_phone', 'source']) {
    assert(await columnOrTableExists('order_requests', c), `order_requests.${c} missing`);
  }
});

async function main() {
  assertLocalTarget();
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
    }
  }
  await cleanup();
  console.log(`\n${pass}/${pass + fail} checks passed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
