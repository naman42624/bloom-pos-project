#!/usr/bin/env node
/**
 * Live verification of the customer order-request flow: link generation,
 * public submit/status page, staff review (list/decline), and the
 * approve-via-LogOrderScreen wiring in POST /sales. Run directly against
 * the local dev server + DB.
 *
 * Modeled on verify-order-flows.js's harness — extend this file the same
 * way: append checks, never remove another check's coverage.
 *
 * Usage: VERIFY_OWNER_PHONE=... VERIFY_OWNER_PASSWORD=... node server/scripts/verify-order-requests.js
 */
require('dotenv').config();
const { getDb } = require('../config/database-async');

const API_BASE = process.env.API_BASE_URL || 'http://localhost:3001/api';
const TEST_LOCATION_ID = 4; // "Test Loc" — the project's established scratch location

const checks = [];
const createdUserIds = [];
const createdOrderRequestIds = [];
const createdSaleIds = [];

function check(name, fn) {
  checks.push({ name, fn });
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
    console.error(`❌ Refusing to run: ${problems.join(' and ')} do${problems.length === 1 ? 'es' : ''} not point at localhost/127.0.0.1.`);
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

let staffCounter = 0;
async function createStaff(role, ownerToken) {
  staffCounter += 1;
  const phone = '9' + String(Date.now()).slice(-8) + String(staffCounter % 10);
  const name = `OrderRequestTest ${role} ${staffCounter}`;
  const { status, body } = await api('POST', '/users', ownerToken, {
    name, phone, password: 'testpass123', role, location_ids: [TEST_LOCATION_ID],
  });
  if (status !== 201 && status !== 200) throw new Error(`Could not create test ${role}: ${status} ${JSON.stringify(body)}`);
  const userId = body.data.id || body.data.user?.id;
  createdUserIds.push(userId);
  const loginRes = await api('POST', '/auth/login', null, { phone, password: 'testpass123' });
  if (loginRes.status !== 200) throw new Error(`Could not login as newly created ${role}: ${JSON.stringify(loginRes.body)}`);
  return { token: loginRes.body.data.token, id: userId, role };
}

async function createCustomer(ownerToken) {
  staffCounter += 1;
  const phone = '8' + String(Date.now()).slice(-8) + String(staffCounter % 10);
  const name = `OrderRequestTest customer ${staffCounter}`;
  const { status, body } = await api('POST', '/users', ownerToken, {
    name, phone, password: 'testpass123', role: 'customer',
  });
  if (status !== 201 && status !== 200) throw new Error(`Could not create test customer: ${status} ${JSON.stringify(body)}`);
  const userId = body.data.id || body.data.user?.id;
  createdUserIds.push(userId);
  return { id: userId, name, phone };
}

async function getTestProduct() {
  const db = await getDb();
  const product = await db.prepare(
    "SELECT id, name, selling_price FROM products WHERE is_active = 1 ORDER BY id LIMIT 1"
  ).get();
  if (!product) throw new Error('No active product found in the dev DB — create at least one product before running this script.');
  return product;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

module.exports = {
  check, checks, api, loginOwner, createStaff, createCustomer, getTestProduct, assert,
  TEST_LOCATION_ID, createdUserIds, createdOrderRequestIds, createdSaleIds, getDb, assertLocalTarget,
};

// ─── Task 2: link generation ────────────────────────────────────────────
let sharedCustomer; // set here, reused by later checks in this file
let sharedCustomerToken;

check('owner can generate an order-request link for a customer', async () => {
  const owner = await loginOwner();
  sharedCustomer = await createCustomer(owner.token);
  const { status, body } = await api('POST', `/customers/${sharedCustomer.id}/order-request-link`, owner.token);
  assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert(typeof body.data.token === 'string' && body.data.token.length > 0, 'Expected a non-empty token');
  assert(body.data.url.includes(`/order-request/${body.data.token}`), `Expected url to contain the token, got ${body.data.url}`);
  sharedCustomerToken = body.data.token;
});

check('the same customer\'s link is idempotent — second call returns the same token', async () => {
  const owner = await loginOwner();
  const { status, body } = await api('POST', `/customers/${sharedCustomer.id}/order-request-link`, owner.token);
  assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert(body.data.token === sharedCustomerToken, `Expected the same token on a second call, got a different one`);
});

check('florist_staff cannot generate an order-request link (403)', async () => {
  const owner = await loginOwner();
  const florist = await createStaff('florist_staff', owner.token);
  const { status } = await api('POST', `/customers/${sharedCustomer.id}/order-request-link`, florist.token);
  assert(status === 403, `Expected 403 for florist_staff, got ${status}`);
});

check('counter_staff CAN generate an order-request link', async () => {
  const owner = await loginOwner();
  const counterStaff = await createStaff('counter_staff', owner.token);
  const { status } = await api('POST', `/customers/${sharedCustomer.id}/order-request-link`, counterStaff.token);
  assert(status === 200, `Expected 200 for counter_staff, got ${status}`);
});

// ─── Task 3: public GET/POST /api/order-request/:token ─────────────────
check('GET with an invalid token returns a generic 404', async () => {
  const { status, body } = await api('GET', '/order-request/not-a-real-token', null);
  assert(status === 404, `Expected 404, got ${status}`);
  assert(body.message === 'Not found', `Expected generic "Not found" message, got "${body.message}"`);
});

check('GET with a valid token returns the customer name and product catalog', async () => {
  const { status, body } = await api('GET', `/order-request/${sharedCustomerToken}`, null);
  assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert(body.data.customer_name === sharedCustomer.name, `Expected customer_name "${sharedCustomer.name}", got "${body.data.customer_name}"`);
  assert(Array.isArray(body.data.products), 'Expected products to be an array');
  assert(Array.isArray(body.data.requests), 'Expected requests to be an array');
});

let submittedRequestId;
check('POST with a catalog item creates a pending request', async () => {
  const product = await getTestProduct();
  const { status, body } = await api('POST', `/order-request/${sharedCustomerToken}`, null, {
    recipient_name: 'Test Recipient', recipient_phone: '9876543210',
    order_type: 'pickup', requested_date: '2026-12-25',
    items: [{ product_id: product.id, quantity: 2 }],
  });
  assert(status === 201, `Expected 201, got ${status}: ${JSON.stringify(body)}`);
  assert(body.data.status === 'pending', `Expected status pending, got ${body.data.status}`);
  submittedRequestId = body.data.id;
  createdOrderRequestIds.push(submittedRequestId);
});

check('POST with a custom item creates a pending request', async () => {
  const { status, body } = await api('POST', `/order-request/${sharedCustomerToken}`, null, {
    recipient_name: 'Test Recipient', recipient_phone: '9876543210',
    order_type: 'delivery', delivery_address: '123 Test St', requested_date: '2026-12-25',
    items: [{ custom: true, description: 'A dozen red roses, extra tall', quantity: 1 }],
  });
  assert(status === 201, `Expected 201, got ${status}: ${JSON.stringify(body)}`);
  createdOrderRequestIds.push(body.data.id);
});

check('POST with both a catalog item and a custom item works', async () => {
  const product = await getTestProduct();
  const { status, body } = await api('POST', `/order-request/${sharedCustomerToken}`, null, {
    recipient_name: 'Test Recipient', recipient_phone: '9876543210',
    order_type: 'pickup', requested_date: '2026-12-25',
    items: [{ product_id: product.id, quantity: 1 }, { custom: true, description: 'A ribbon in gold', quantity: 1 }],
  });
  assert(status === 201, `Expected 201, got ${status}: ${JSON.stringify(body)}`);
  createdOrderRequestIds.push(body.data.id);
});

check('POST with an empty items array is rejected', async () => {
  const { status } = await api('POST', `/order-request/${sharedCustomerToken}`, null, {
    recipient_name: 'Test Recipient', recipient_phone: '9876543210',
    order_type: 'pickup', requested_date: '2026-12-25',
    items: [],
  });
  assert(status === 400, `Expected 400 for an empty cart, got ${status}`);
});

check('POST with delivery order_type but no address is rejected', async () => {
  const product = await getTestProduct();
  const { status } = await api('POST', `/order-request/${sharedCustomerToken}`, null, {
    recipient_name: 'Test Recipient', recipient_phone: '9876543210',
    order_type: 'delivery', requested_date: '2026-12-25',
    items: [{ product_id: product.id, quantity: 1 }],
  });
  assert(status === 400, `Expected 400 for delivery with no address, got ${status}`);
});

// Placed last, deliberately: fires 31 rapid requests against the SAME ip,
// which will push every other check above past this rate limiter's window
// if run again within 60s of this one. Nothing later in this file depends
// on hitting /order-request again, so this being last is safe.
check('rate limiter returns 429 after exceeding the per-minute threshold', async () => {
  let last;
  for (let i = 0; i < 31; i += 1) {
    last = await api('GET', `/order-request/${sharedCustomerToken}`, null);
  }
  assert(last.status === 429, `Expected the 31st rapid request to be rate-limited (429), got ${last.status}`);
});

async function cleanup() {
  if (createdUserIds.length === 0 && createdOrderRequestIds.length === 0 && createdSaleIds.length === 0) return;
  const db = await getDb();
  for (const saleId of createdSaleIds) {
    try {
      await db.prepare('DELETE FROM production_tasks WHERE sale_id = ?').run(saleId);
      await db.prepare('DELETE FROM payments WHERE sale_id = ?').run(saleId);
      await db.prepare('DELETE FROM sale_items WHERE sale_id = ?').run(saleId);
      await db.prepare('DELETE FROM sales WHERE id = ?').run(saleId);
    } catch (err) {
      console.error(`   (cleanup warning: sale ${saleId}: ${err.message})`);
    }
  }
  for (const id of createdOrderRequestIds) {
    try {
      await db.prepare('DELETE FROM order_requests WHERE id = ?').run(id);
    } catch (err) {
      console.error(`   (cleanup warning: order_request ${id}: ${err.message})`);
    }
  }
  for (const userId of createdUserIds) {
    try {
      await db.prepare('UPDATE users SET order_request_token = NULL WHERE id = ?').run(userId);
      await db.prepare('DELETE FROM user_locations WHERE user_id = ?').run(userId);
      await db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    } catch (err) {
      console.error(`   (cleanup warning: user ${userId}: ${err.message})`);
    }
  }
  console.log(`Cleaned up ${createdSaleIds.length} sale(s), ${createdOrderRequestIds.length} order_request(s), ${createdUserIds.length} user(s)`);
}

async function main() {
  assertLocalTarget();
  let pass = 0, fail = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      console.log(`✅ ${name}`);
      pass++;
    } catch (err) {
      console.log(`❌ ${name}`);
      console.log(`   ${err.message}`);
      fail++;
    }
  }
  await cleanup();
  console.log(`\n${pass}/${pass + fail} checks passed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
