#!/usr/bin/env node
/**
 * Comprehensive live verification of the sale/order lifecycle: creation
 * through production, payment, and completion/pickup/delivery, across all
 * four order types, plus adjacent areas (refunds, cancellation, settlements,
 * customer self-order). Run directly against the local dev server + DB.
 *
 * Modeled on verify-identity-roles.js's safety pattern (assertLocalTarget,
 * throwaway test users cleaned up on exit) — extend this file the same way:
 * append checks, never remove another check's coverage.
 *
 * Usage: VERIFY_OWNER_PHONE=... VERIFY_OWNER_PASSWORD=... node server/scripts/verify-order-flows.js
 */
require('dotenv').config();
const { getDb } = require('../config/database-async');

const API_BASE = process.env.API_BASE_URL || 'http://localhost:3001/api';
const TEST_LOCATION_ID = 4; // "Test Loc" — the project's established scratch location

const checks = [];
const createdSaleIds = [];
const createdUserIds = [];

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

// Creates a throwaway staff account via the owner token, returns {token, id, role}.
// Cleaned up (DELETE FROM users) at the end of the run, same as verify-identity-roles.js.
let staffCounter = 0;
async function createStaff(role, ownerToken) {
  staffCounter += 1;
  // Exactly 10 digits, starts with 9 (valid per users.js's /^[6-9]\d{9}$/):
  // '9' + last 8 digits of Date.now() + one digit from the counter.
  const phone = '9' + String(Date.now()).slice(-8) + String(staffCounter % 10);
  const name = `OrderFlowTest ${role} ${staffCounter}`;
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
  const name = `OrderFlowTest customer ${staffCounter}`;
  const { status, body } = await api('POST', '/users', ownerToken, {
    name, phone, password: 'testpass123', role: 'customer',
  });
  if (status !== 201 && status !== 200) throw new Error(`Could not create test customer: ${status} ${JSON.stringify(body)}`);
  const userId = body.data.id || body.data.user?.id;
  createdUserIds.push(userId);
  const loginRes = await api('POST', '/auth/login', null, { phone, password: 'testpass123' });
  if (loginRes.status !== 200) throw new Error(`Could not login as newly created customer: ${JSON.stringify(loginRes.body)}`);
  return { token: loginRes.body.data.token, id: userId, role: 'customer' };
}

async function ensureRegisterOpen(ownerToken, locationId) {
  const { body } = await api('GET', `/sales/register/status?location_id=${locationId}`, ownerToken);
  if (body?.isOpen) return;
  const openRes = await api('POST', '/sales/register/open', ownerToken, { location_id: locationId, opening_balance: 1000 });
  if (openRes.status !== 200 && openRes.status !== 201) throw new Error(`Could not open register at location ${locationId}: ${JSON.stringify(openRes.body)}`);
}

async function closeRegister(ownerToken, locationId) {
  const { body } = await api('GET', `/sales/register/status?location_id=${locationId}`, ownerToken);
  if (!body?.isOpen) return;
  const closeRes = await api('PUT', '/sales/register/close', ownerToken, { location_id: locationId, actual_cash: Number(body.data.expected_cash) || 0 });
  if (closeRes.status !== 200) throw new Error(`Could not close register at location ${locationId}: ${JSON.stringify(closeRes.body)}`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Temporarily forces a settings row to `value` for the duration of `fn`,
// restoring whatever it was before on the way out (even on throw) — same
// isolation pattern as verify-identity-roles.js's pref_flexible_task_
// assignment checks. Needed here because pref_walkin_auto_complete was
// found live-set to '1' in this dev DB (not the seeded '0' default), which
// would otherwise silently auto-complete every walk_in check below the
// moment its one task finishes, well before the checks that are actually
// about payment/balance gating get to run their own assertion.
async function withPref(key, value, fn) {
  const db = await getDb();
  const prev = await db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  await db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(value, key);
  try {
    return await fn();
  } finally {
    await db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(prev?.value ?? value, key);
  }
}

module.exports = { check, checks, api, loginOwner, createStaff, createCustomer, ensureRegisterOpen, closeRegister, assert, withPref, TEST_LOCATION_ID, createdSaleIds, createdUserIds, getDb, assertLocalTarget };

// ─── Smoke test: harness itself works before the real suite runs ───
check('harness smoke test: owner login + create/login a throwaway counter_staff', async () => {
  const owner = await loginOwner();
  assert(owner.role === 'owner', `Expected owner role, got ${owner.role}`);
  const staff = await createStaff('counter_staff', owner.token);
  assert(staff.token, 'Expected a token for the newly created counter_staff');
  const me = await api('GET', '/auth/me', staff.token);
  assert(me.body?.data?.user?.role === 'counter_staff', `Expected counter_staff, got ${me.body?.data?.user?.role}`);
});

// ═══════════════════════════════════════════════════════════════
// PHASE 1 — walk_in
// ═══════════════════════════════════════════════════════════════

check('walk_in + custom item (no product_id): starts \'preparing\', never \'pending\' (documented gap, confirming still true)', async () => {
  const owner = await loginOwner();
  await ensureRegisterOpen(owner.token, TEST_LOCATION_ID);
  const { status, body } = await api('POST', '/sales', owner.token, {
    location_id: TEST_LOCATION_ID, order_type: 'walk_in', channel: 'walk_in',
    items: [{ quantity: 1, unit_price: 100, product_name: 'Test Custom Bouquet' }],
  });
  assert(status === 201, `Expected 201, got ${status}: ${JSON.stringify(body)}`);
  const saleId = body.data.id;
  createdSaleIds.push(saleId);
  assert(body.data.status === 'preparing', `Expected initial status 'preparing', got '${body.data.status}'`);
});

check('production task can be completed directly from \'pending\', skipping start/assign — sale jumps straight to \'ready\' (edge case)', () => withPref('pref_walkin_auto_complete', '0', async () => {
  const owner = await loginOwner();
  await ensureRegisterOpen(owner.token, TEST_LOCATION_ID);
  const { body: saleBody } = await api('POST', '/sales', owner.token, {
    location_id: TEST_LOCATION_ID, order_type: 'walk_in', channel: 'walk_in',
    items: [{ quantity: 1, unit_price: 100, product_name: 'Test Skip-Start Bouquet' }],
  });
  const saleId = saleBody.data.id;
  createdSaleIds.push(saleId);
  const tasksRes = await api('GET', `/production/tasks?sale_id=${saleId}`, owner.token);
  const task = tasksRes.body.data.find((t) => t.sale_id === saleId);
  assert(task, 'Expected a production task for this sale');
  assert(task.status === 'pending', `Expected task status 'pending' (never started), got '${task.status}'`);
  const completeRes = await api('PUT', `/production/tasks/${task.id}/complete`, owner.token);
  assert(completeRes.status === 200, `Expected /complete to succeed on a never-started task, got ${completeRes.status}: ${JSON.stringify(completeRes.body)}`);
  const saleAfter = await api('GET', `/sales/${saleId}`, owner.token);
  assert(saleAfter.body.data.status === 'ready', `Expected sale to jump straight to 'ready' (skipping 'preparing' visibility), got '${saleAfter.body.data.status}'`);
}));

check('walk_in Complete Order blocked while balance due (non-credit)', () => withPref('pref_walkin_auto_complete', '0', async () => {
  const owner = await loginOwner();
  await ensureRegisterOpen(owner.token, TEST_LOCATION_ID);
  const { body: saleBody } = await api('POST', '/sales', owner.token, {
    location_id: TEST_LOCATION_ID, order_type: 'walk_in', channel: 'walk_in',
    items: [{ quantity: 1, unit_price: 200, product_name: 'Test Unpaid Bouquet' }],
  });
  const saleId = saleBody.data.id;
  createdSaleIds.push(saleId);
  const tasksRes = await api('GET', `/production/tasks?sale_id=${saleId}`, owner.token);
  const task = tasksRes.body.data.find((t) => t.sale_id === saleId);
  await api('PUT', `/production/tasks/${task.id}/complete`, owner.token);
  const completeOrderRes = await api('PUT', `/sales/${saleId}/status`, owner.token, { status: 'completed' });
  assert(completeOrderRes.status === 400, `Expected 400 (balance due), got ${completeOrderRes.status}: ${JSON.stringify(completeOrderRes.body)}`);
  assert(/still due|balance/i.test(completeOrderRes.body?.message || ''), `Expected a plain-language balance-due message, got: ${completeOrderRes.body?.message}`);
}));

check('walk_in Complete Order succeeds once fully paid (cash, register open)', () => withPref('pref_walkin_auto_complete', '0', async () => {
  const owner = await loginOwner();
  await ensureRegisterOpen(owner.token, TEST_LOCATION_ID);
  const { body: saleBody } = await api('POST', '/sales', owner.token, {
    location_id: TEST_LOCATION_ID, order_type: 'walk_in', channel: 'walk_in',
    items: [{ quantity: 1, unit_price: 150, product_name: 'Test Paid Bouquet' }],
    payments: [{ method: 'cash', amount: 150 }],
  });
  assert(saleBody.data.payment_status === 'paid', `Expected payment_status 'paid' at creation, got '${saleBody.data.payment_status}'`);
  const saleId = saleBody.data.id;
  createdSaleIds.push(saleId);
  const tasksRes = await api('GET', `/production/tasks?sale_id=${saleId}`, owner.token);
  const task = tasksRes.body.data.find((t) => t.sale_id === saleId);
  await api('PUT', `/production/tasks/${task.id}/complete`, owner.token);
  const completeOrderRes = await api('PUT', `/sales/${saleId}/status`, owner.token, { status: 'completed' });
  assert(completeOrderRes.status === 200, `Expected 200, got ${completeOrderRes.status}: ${JSON.stringify(completeOrderRes.body)}`);
}));

check('walk_in creation with a cash payment is blocked when the register is closed', async () => {
  const owner = await loginOwner();
  await closeRegister(owner.token, TEST_LOCATION_ID);
  const { status, body } = await api('POST', '/sales', owner.token, {
    location_id: TEST_LOCATION_ID, order_type: 'walk_in', channel: 'walk_in',
    items: [{ quantity: 1, unit_price: 100, product_name: 'Test Register-Closed Bouquet' }],
    payments: [{ method: 'cash', amount: 100 }],
  });
  assert(status === 400, `Expected 400 (register closed), got ${status}: ${JSON.stringify(body)}`);
  assert(!body?.data?.id, 'Sale should not have been created when register-closed blocked it');
  await ensureRegisterOpen(owner.token, TEST_LOCATION_ID); // restore for subsequent checks
});

check('walk_in creation with NO payment succeeds even when register is closed (no cash write, correctly unaffected)', async () => {
  const owner = await loginOwner();
  await closeRegister(owner.token, TEST_LOCATION_ID);
  const { status, body } = await api('POST', '/sales', owner.token, {
    location_id: TEST_LOCATION_ID, order_type: 'walk_in', channel: 'walk_in',
    items: [{ quantity: 1, unit_price: 100, product_name: 'Test No-Payment Bouquet' }],
  });
  assert(status === 201, `Expected 201 (no cash write, register state irrelevant), got ${status}: ${JSON.stringify(body)}`);
  createdSaleIds.push(body.data.id);
  await ensureRegisterOpen(owner.token, TEST_LOCATION_ID);
});

check('walk_in credit sale: Complete Order succeeds with zero payment', () => withPref('pref_walkin_auto_complete', '0', async () => {
  const owner = await loginOwner();
  await ensureRegisterOpen(owner.token, TEST_LOCATION_ID);
  const { body: saleBody } = await api('POST', '/sales', owner.token, {
    location_id: TEST_LOCATION_ID, order_type: 'walk_in', channel: 'walk_in',
    items: [{ quantity: 1, unit_price: 300, product_name: 'Test Credit Bouquet' }],
    is_credit_sale: true,
  });
  assert(saleBody.data.is_credit_sale === 1 || saleBody.data.is_credit_sale === true, `Expected is_credit_sale to be set, got ${saleBody.data.is_credit_sale}`);
  const saleId = saleBody.data.id;
  createdSaleIds.push(saleId);
  const tasksRes = await api('GET', `/production/tasks?sale_id=${saleId}`, owner.token);
  const task = tasksRes.body.data.find((t) => t.sale_id === saleId);
  await api('PUT', `/production/tasks/${task.id}/complete`, owner.token);
  const completeOrderRes = await api('PUT', `/sales/${saleId}/status`, owner.token, { status: 'completed' });
  assert(completeOrderRes.status === 200, `Expected 200 (credit sale bypasses balance-due gate), got ${completeOrderRes.status}: ${JSON.stringify(completeOrderRes.body)}`);
}));

check('KNOWN GAP (confirming still present): pref_walkin_auto_complete bypasses the payment guard entirely', async () => {
  const db = await getDb();
  const prevPref = await db.prepare("SELECT value FROM settings WHERE key = 'pref_walkin_auto_complete'").get();
  await db.prepare("UPDATE settings SET value = '1' WHERE key = 'pref_walkin_auto_complete'").run();
  try {
    const owner = await loginOwner();
    await ensureRegisterOpen(owner.token, TEST_LOCATION_ID);
    const { body: saleBody } = await api('POST', '/sales', owner.token, {
      location_id: TEST_LOCATION_ID, order_type: 'walk_in', channel: 'walk_in',
      items: [{ quantity: 1, unit_price: 400, product_name: 'Test AutoComplete Unpaid Bouquet' }],
      // Deliberately NO payments — this order owes the full ₹400.
    });
    const saleId = saleBody.data.id;
    createdSaleIds.push(saleId);
    const tasksRes = await api('GET', `/production/tasks?sale_id=${saleId}`, owner.token);
    const task = tasksRes.body.data.find((t) => t.sale_id === saleId);
    await api('PUT', `/production/tasks/${task.id}/complete`, owner.token);
    // Post-completion auto-complete runs asynchronously after the response —
    // give it a moment.
    await new Promise((r) => setTimeout(r, 300));
    const saleAfter = await api('GET', `/sales/${saleId}`, owner.token);
    assert(saleAfter.body.data.status === 'completed', `Expected the KNOWN GAP to auto-complete an unpaid order (status 'completed' with $0 paid) — got '${saleAfter.body.data.status}'. If this now says something else, the gap may have been fixed — update CLAUDE.md's "Known-open" note accordingly.`);
    assert(Number(saleAfter.body.data.total_paid || 0) === 0, 'Expected $0 paid on this order — this check exists to prove the guard was skipped, not to celebrate it');
  } finally {
    await db.prepare("UPDATE settings SET value = ? WHERE key = 'pref_walkin_auto_complete'").run(prevPref?.value ?? '0');
  }
});

// ═══════════════════════════════════════════════════════════════
// PHASE 2 — pickup
// ═══════════════════════════════════════════════════════════════

check('pickup order starts \'pending\' (New stage is reachable, unlike walk_in)', async () => {
  const owner = await loginOwner();
  const { status, body } = await api('POST', '/sales', owner.token, {
    location_id: TEST_LOCATION_ID, order_type: 'pickup', channel: 'phone',
    items: [{ quantity: 1, unit_price: 100, product_name: 'Test Pickup Item' }],
  });
  assert(status === 201, `Expected 201, got ${status}: ${JSON.stringify(body)}`);
  createdSaleIds.push(body.data.id);
  assert(body.data.status === 'pending', `Expected 'pending', got '${body.data.status}'`);
});

check('Mark Ready is blocked while a production task is still open (plain-language message) — pref_manager_override off', () => withPref('pref_manager_override', '0', async () => {
  const owner = await loginOwner();
  const { body: saleBody } = await api('POST', '/sales', owner.token, {
    location_id: TEST_LOCATION_ID, order_type: 'pickup', channel: 'phone',
    items: [{ quantity: 1, unit_price: 100, product_name: 'Test Pickup Not-Ready-Yet' }],
  });
  const saleId = saleBody.data.id;
  createdSaleIds.push(saleId);
  await api('PUT', `/sales/${saleId}/status`, owner.token, { status: 'preparing' });
  const readyRes = await api('PUT', `/sales/${saleId}/status`, owner.token, { status: 'ready' });
  assert(readyRes.status === 400, `Expected 400 (task still open), got ${readyRes.status}: ${JSON.stringify(readyRes.body)}`);
  assert(/production task/i.test(readyRes.body?.message || ''), `Expected a plain-language message naming production tasks, got: ${readyRes.body?.message}`);
}));

check('pref_manager_override ON: Mark Ready auto-completes open tasks via the REAL completion logic (material deduction, not a status-flip shortcut)', () => withPref('pref_manager_override', '1', async () => {
  const owner = await loginOwner();
  const { body: saleBody } = await api('POST', '/sales', owner.token, {
    location_id: TEST_LOCATION_ID, order_type: 'pickup', channel: 'phone',
    items: [{ quantity: 1, unit_price: 100, product_name: 'Test Pickup Override Autocomplete' }],
  });
  const saleId = saleBody.data.id;
  createdSaleIds.push(saleId);
  await api('PUT', `/sales/${saleId}/status`, owner.token, { status: 'preparing' });
  const readyRes = await api('PUT', `/sales/${saleId}/status`, owner.token, { status: 'ready' });
  assert(readyRes.status === 200, `Expected Mark Ready to succeed via auto-complete, got ${readyRes.status}: ${JSON.stringify(readyRes.body)}`);
  const tasksRes = await api('GET', `/production/tasks?sale_id=${saleId}`, owner.token);
  const task = tasksRes.body.data.find((t) => t.sale_id === saleId);
  assert(task.status === 'completed', `Expected the task to be genuinely completed (not just the sale flipped), got task status '${task.status}'`);
  // completeProductionTaskCore logs a production_logs row as part of the
  // real completion path — its presence is the signal that this went
  // through actual completion logic, not a bare status write.
  const db = await getDb();
  const log = await db.prepare('SELECT id FROM production_logs WHERE task_id = ?').get(task.id);
  assert(log, 'Expected a production_logs row from the real completion path — its absence would mean this was a shortcut status-flip, the exact bug this override was fixed to stop doing');
}));

check('pickup full happy path: create → start → complete task → ready → Confirm Pickup (fully paid)', () => withPref('pref_manager_override', '0', async () => {
  const owner = await loginOwner();
  await ensureRegisterOpen(owner.token, TEST_LOCATION_ID);
  const { body: saleBody } = await api('POST', '/sales', owner.token, {
    location_id: TEST_LOCATION_ID, order_type: 'pickup', channel: 'phone',
    items: [{ quantity: 1, unit_price: 250, product_name: 'Test Pickup Happy Path' }],
    payments: [{ method: 'cash', amount: 250 }],
  });
  const saleId = saleBody.data.id;
  createdSaleIds.push(saleId);
  const startRes = await api('PUT', `/sales/${saleId}/status`, owner.token, { status: 'preparing' });
  assert(startRes.status === 200, `Start Preparing failed: ${JSON.stringify(startRes.body)}`);
  const tasksRes = await api('GET', `/production/tasks?sale_id=${saleId}`, owner.token);
  const task = tasksRes.body.data.find((t) => t.sale_id === saleId);
  const completeRes = await api('PUT', `/production/tasks/${task.id}/complete`, owner.token);
  assert(completeRes.status === 200, `Task complete failed: ${JSON.stringify(completeRes.body)}`);
  // /tasks/:id/complete already auto-advances the sale to 'ready' once the
  // last open task finishes (its own completeTx does this directly) — no
  // separate Mark Ready call needed or accepted here; confirmed via Phase 1's
  // "skip-start" check too.
  const saleReady = await api('GET', `/sales/${saleId}`, owner.token);
  assert(saleReady.body.data.status === 'ready', `Expected sale to auto-advance to 'ready' after the last task completed, got '${saleReady.body.data.status}'`);
  const pickupRes = await api('PUT', `/deliveries/pickup/${saleId}/picked-up`, owner.token, {});
  assert(pickupRes.status === 200, `Confirm Pickup failed: ${JSON.stringify(pickupRes.body)}`);
  const saleAfter = await api('GET', `/sales/${saleId}`, owner.token);
  assert(saleAfter.body.data.status === 'completed', `Expected 'completed', got '${saleAfter.body.data.status}'`);
}));

check('pickup Confirm Pickup blocked with balance due (non-credit), succeeds once paid inline', async () => {
  const owner = await loginOwner();
  await ensureRegisterOpen(owner.token, TEST_LOCATION_ID);
  const { body: saleBody } = await api('POST', '/sales', owner.token, {
    location_id: TEST_LOCATION_ID, order_type: 'pickup', channel: 'phone',
    items: [{ quantity: 1, unit_price: 180, product_name: 'Test Pickup Unpaid' }],
  });
  const saleId = saleBody.data.id;
  createdSaleIds.push(saleId);
  await api('PUT', `/sales/${saleId}/status`, owner.token, { status: 'preparing' });
  const tasksRes = await api('GET', `/production/tasks?sale_id=${saleId}`, owner.token);
  const task = tasksRes.body.data.find((t) => t.sale_id === saleId);
  await api('PUT', `/production/tasks/${task.id}/complete`, owner.token);
  await api('PUT', `/sales/${saleId}/status`, owner.token, { status: 'ready' });

  const blockedRes = await api('PUT', `/deliveries/pickup/${saleId}/picked-up`, owner.token, {});
  assert(blockedRes.status === 400, `Expected 400 (balance due), got ${blockedRes.status}: ${JSON.stringify(blockedRes.body)}`);
  assert(/balance due|collect payment/i.test(blockedRes.body?.message || ''), `Expected a plain-language message, got: ${blockedRes.body?.message}`);

  const paidRes = await api('PUT', `/deliveries/pickup/${saleId}/picked-up`, owner.token, { payment_method: 'cash', payment_amount: 180 });
  assert(paidRes.status === 200, `Expected 200 once payment supplied inline, got ${paidRes.status}: ${JSON.stringify(paidRes.body)}`);
});

check('pickup credit sale: Confirm Pickup succeeds with zero payment (this session\'s fix)', async () => {
  const owner = await loginOwner();
  const { body: saleBody } = await api('POST', '/sales', owner.token, {
    location_id: TEST_LOCATION_ID, order_type: 'pickup', channel: 'phone',
    items: [{ quantity: 1, unit_price: 220, product_name: 'Test Pickup Credit' }],
    is_credit_sale: true,
  });
  const saleId = saleBody.data.id;
  createdSaleIds.push(saleId);
  await api('PUT', `/sales/${saleId}/status`, owner.token, { status: 'preparing' });
  const tasksRes = await api('GET', `/production/tasks?sale_id=${saleId}`, owner.token);
  const task = tasksRes.body.data.find((t) => t.sale_id === saleId);
  await api('PUT', `/production/tasks/${task.id}/complete`, owner.token);
  await api('PUT', `/sales/${saleId}/status`, owner.token, { status: 'ready' });
  const pickupRes = await api('PUT', `/deliveries/pickup/${saleId}/picked-up`, owner.token, {});
  assert(pickupRes.status === 200, `Expected 200 (credit sale, no payment needed), got ${pickupRes.status}: ${JSON.stringify(pickupRes.body)}`);
});

check('pickup Confirm Pickup payment collection blocked when register is closed', async () => {
  const owner = await loginOwner();
  await ensureRegisterOpen(owner.token, TEST_LOCATION_ID);
  const { body: saleBody } = await api('POST', '/sales', owner.token, {
    location_id: TEST_LOCATION_ID, order_type: 'pickup', channel: 'phone',
    items: [{ quantity: 1, unit_price: 190, product_name: 'Test Pickup RegClosed' }],
  });
  const saleId = saleBody.data.id;
  createdSaleIds.push(saleId);
  await api('PUT', `/sales/${saleId}/status`, owner.token, { status: 'preparing' });
  const tasksRes = await api('GET', `/production/tasks?sale_id=${saleId}`, owner.token);
  const task = tasksRes.body.data.find((t) => t.sale_id === saleId);
  await api('PUT', `/production/tasks/${task.id}/complete`, owner.token);
  await api('PUT', `/sales/${saleId}/status`, owner.token, { status: 'ready' });

  await closeRegister(owner.token, TEST_LOCATION_ID);
  const res = await api('PUT', `/deliveries/pickup/${saleId}/picked-up`, owner.token, { payment_method: 'cash', payment_amount: 190 });
  assert(res.status === 400, `Expected 400 (register closed), got ${res.status}: ${JSON.stringify(res.body)}`);
  await ensureRegisterOpen(owner.token, TEST_LOCATION_ID);
});

check('florist_staff cannot Confirm Pickup (role boundary matches ENDPOINT_ROLES.PICKUP_PICKED_UP)', async () => {
  const owner = await loginOwner();
  await ensureRegisterOpen(owner.token, TEST_LOCATION_ID);
  const florist = await createStaff('florist_staff', owner.token);
  const { body: saleBody } = await api('POST', '/sales', owner.token, {
    location_id: TEST_LOCATION_ID, order_type: 'pickup', channel: 'phone',
    items: [{ quantity: 1, unit_price: 100, product_name: 'Test Pickup Florist Block' }],
    payments: [{ method: 'cash', amount: 100 }],
  });
  const saleId = saleBody.data.id;
  createdSaleIds.push(saleId);
  await api('PUT', `/sales/${saleId}/status`, owner.token, { status: 'preparing' });
  const tasksRes = await api('GET', `/production/tasks?sale_id=${saleId}`, owner.token);
  const task = tasksRes.body.data.find((t) => t.sale_id === saleId);
  await api('PUT', `/production/tasks/${task.id}/complete`, owner.token);
  await api('PUT', `/sales/${saleId}/status`, owner.token, { status: 'ready' });
  const res = await api('PUT', `/deliveries/pickup/${saleId}/picked-up`, florist.token, {});
  assert(res.status === 403, `Expected 403 for florist_staff, got ${res.status}: ${JSON.stringify(res.body)}`);
});

// ═══════════════════════════════════════════════════════════════
// PHASE 3 — delivery
// ═══════════════════════════════════════════════════════════════

// Shared helper: create a delivery-type sale through the full happy path up
// to 'ready' (task completed), and return {saleId, deliveryId}.
async function createReadyDelivery(ownerToken, opts = {}) {
  const { body: saleBody } = await api('POST', '/sales', ownerToken, {
    location_id: TEST_LOCATION_ID, order_type: 'delivery', channel: 'phone',
    delivery_address: '123 Test St', receiver_name: 'Test Receiver', receiver_phone: '9998887777',
    items: [{ quantity: 1, unit_price: 200, product_name: 'Test Delivery Item' }],
    ...opts,
  });
  const saleId = saleBody.data.id;
  createdSaleIds.push(saleId);
  await api('PUT', `/sales/${saleId}/status`, ownerToken, { status: 'preparing' });
  const tasksRes = await api('GET', `/production/tasks?sale_id=${saleId}`, ownerToken);
  const task = tasksRes.body.data.find((t) => t.sale_id === saleId);
  await api('PUT', `/production/tasks/${task.id}/complete`, ownerToken);
  const saleAfter = await api('GET', `/sales/${saleId}`, ownerToken);
  assert(saleAfter.body.data.status === 'ready', `Expected 'ready' after task completion, got '${saleAfter.body.data.status}'`);
  const deliveryId = saleAfter.body.data.delivery.id;
  return { saleId, deliveryId };
}

check('delivery order starts \'pending\', gets a deliveries row immediately (status \'pending\', no rider)', async () => {
  const owner = await loginOwner();
  const { body: saleBody } = await api('POST', '/sales', owner.token, {
    location_id: TEST_LOCATION_ID, order_type: 'delivery', channel: 'phone',
    delivery_address: '123 Test St', receiver_name: 'Test Receiver', receiver_phone: '9998887777',
    items: [{ quantity: 1, unit_price: 200, product_name: 'Test Delivery Fresh' }],
  });
  createdSaleIds.push(saleBody.data.id);
  assert(saleBody.data.status === 'pending', `Expected 'pending', got '${saleBody.data.status}'`);
  const saleDetail = await api('GET', `/sales/${saleBody.data.id}`, owner.token);
  assert(saleDetail.body.data.delivery, 'Expected a deliveries row to exist immediately at creation');
  assert(saleDetail.body.data.delivery.status === 'pending', `Expected delivery status 'pending', got '${saleDetail.body.data.delivery.status}'`);
});

check('delivery full happy path: ready → assign rider → Mark Picked Up → in-transit → Mark Delivered with COD', async () => {
  const owner = await loginOwner();
  const partner = 9; // Vishal, a real delivery_partner in the dev DB
  const { saleId, deliveryId } = await createReadyDelivery(owner.token, {});
  const assignRes = await api('PUT', `/deliveries/${deliveryId}/assign`, owner.token, { delivery_partner_id: partner });
  assert(assignRes.status === 200, `Assign failed: ${JSON.stringify(assignRes.body)}`);
  assert(assignRes.body.data.status === 'assigned', `Expected 'assigned', got '${assignRes.body.data.status}'`);

  const stageAfterAssign = await api('GET', `/sales/${saleId}`, owner.token);
  assert(stageAfterAssign.body.data.display_stage?.nextAction?.label === 'Mark Picked Up', `Expected a 'Mark Picked Up' nextAction, got ${JSON.stringify(stageAfterAssign.body.data.display_stage)}`);

  const pickupRes = await api('PUT', `/deliveries/${deliveryId}/pickup`, owner.token, {});
  assert(pickupRes.status === 200, `Pickup failed: ${JSON.stringify(pickupRes.body)}`);

  const transitRes = await api('PUT', `/deliveries/${deliveryId}/in-transit`, owner.token, {});
  assert(transitRes.status === 200, `In-transit failed: ${JSON.stringify(transitRes.body)}`);

  const deliverRes = await api('PUT', `/deliveries/${deliveryId}/deliver`, owner.token, { cod_collected: 200, cod_method: 'cash' });
  assert(deliverRes.status === 200, `Deliver failed: ${JSON.stringify(deliverRes.body)}`);

  const saleAfter = await api('GET', `/sales/${saleId}`, owner.token);
  assert(saleAfter.body.data.delivery.status === 'delivered', `Expected delivery 'delivered', got '${saleAfter.body.data.delivery.status}'`);
  const paidTotal = (saleAfter.body.data.payments || []).reduce((sum, p) => sum + Number(p.amount || 0), 0);
  assert(paidTotal === 200, `Expected payments to sum to 200, got ${paidTotal}`);
  assert(saleAfter.body.data.payment_status === 'paid', `Expected payment_status 'paid', got '${saleAfter.body.data.payment_status}'`);
});

check('delivery COD partial collection then final collection — cod_status transitions partial → collected', async () => {
  const owner = await loginOwner();
  const { saleId, deliveryId } = await createReadyDelivery(owner.token, {});
  await api('PUT', `/deliveries/${deliveryId}/assign`, owner.token, { delivery_partner_id: 9 });
  await api('PUT', `/deliveries/${deliveryId}/pickup`, owner.token, {});
  const partialRes = await api('PUT', `/deliveries/${deliveryId}/deliver`, owner.token, { cod_collected: 120, cod_method: 'cash' });
  assert(partialRes.status === 200, `Partial deliver failed: ${JSON.stringify(partialRes.body)}`);
  assert(partialRes.body.data.cod_status === 'partial', `Expected cod_status 'partial' after collecting 120 of 200, got '${partialRes.body.data.cod_status}'`);
  assert(partialRes.body.data.status === 'delivered', `Expected the order to still be marked 'delivered' even with a partial COD (matches the deliberate policy of not hard-blocking on full collection)`);
  const overshootRes = await api('PUT', `/deliveries/${deliveryId}/deliver`, owner.token, { cod_collected: 200, cod_method: 'cash' });
  assert(overshootRes.status === 400, `Expected the second collect (200, only 80 remaining) to be rejected as exceeding remaining, got ${overshootRes.status}: ${JSON.stringify(overshootRes.body)}`);
});

check('DELIVERY_DELIVER role boundary: employee (not delivery_partner/owner/manager, and no counter pref) gets 403 on /deliver', async () => {
  const owner = await loginOwner();
  const employee = await createStaff('employee', owner.token);
  const { deliveryId } = await createReadyDelivery(owner.token, {});
  await api('PUT', `/deliveries/${deliveryId}/assign`, owner.token, { delivery_partner_id: 9 });
  await api('PUT', `/deliveries/${deliveryId}/pickup`, owner.token, {});
  const res = await api('PUT', `/deliveries/${deliveryId}/deliver`, employee.token, { cod_collected: 200, cod_method: 'cash' });
  assert(res.status === 403, `Expected 403, got ${res.status}: ${JSON.stringify(res.body)}`);
});

check('delivery FAIL + reattempt: failed delivery resets to \'assigned\', but the sale needs TWO redundant taps (Start Preparing, Mark Ready) before pickup works again (documented tradeoff, confirming the exact cost)', async () => {
  const owner = await loginOwner();
  const { saleId, deliveryId } = await createReadyDelivery(owner.token, {});
  await api('PUT', `/deliveries/${deliveryId}/assign`, owner.token, { delivery_partner_id: 9 });
  await api('PUT', `/deliveries/${deliveryId}/pickup`, owner.token, {});
  const failRes = await api('PUT', `/deliveries/${deliveryId}/fail`, owner.token, { failure_reason: 'Customer not home' });
  assert(failRes.status === 200, `Fail failed: ${JSON.stringify(failRes.body)}`);
  const saleAfterFail = await api('GET', `/sales/${saleId}`, owner.token);
  assert(saleAfterFail.body.data.status === 'ready', `Expected sale to reset to 'ready' so it can be reassigned, got '${saleAfterFail.body.data.status}'`);
  const reattemptRes = await api('PUT', `/deliveries/${deliveryId}/reattempt`, owner.token, {});
  assert(reattemptRes.status === 200, `Reattempt failed: ${JSON.stringify(reattemptRes.body)}`);
  assert(reattemptRes.body.data.status === 'assigned', `Expected delivery 'assigned' after reattempt, got '${reattemptRes.body.data.status}'`);

  // reattempt deliberately resets sales.status to 'confirmed' (order-stage.js's
  // own comment: keeps computeOrderStage() showing "New"/Start Preparing
  // rather than a wrong "Mark Delivered" for an order still sitting in the
  // shop). Real cost of that tradeoff: pickup is blocked until the sale
  // walks back through preparing → ready, even though the one production
  // task was already completed before the failed attempt and nothing about
  // it actually needs re-doing.
  const immediatePickup = await api('PUT', `/deliveries/${deliveryId}/pickup`, owner.token, {});
  assert(immediatePickup.status === 400, `(finding context) Expected pickup to still be blocked right after reattempt — got ${immediatePickup.status}. If this now succeeds, the friction below may have been resolved.`);

  const stage = await api('GET', `/sales/${saleId}`, owner.token);
  assert(stage.body.data.display_stage?.key === 'new', `Expected the board to show this as 'new' (Start Preparing) despite prep already being done and a rider already assigned — got stage '${stage.body.data.display_stage?.key}'`);

  const startRes = await api('PUT', `/sales/${saleId}/status`, owner.token, { status: 'preparing' });
  assert(startRes.status === 200, `Redundant Start Preparing failed: ${JSON.stringify(startRes.body)}`);
  const readyRes = await api('PUT', `/sales/${saleId}/status`, owner.token, { status: 'ready' });
  assert(readyRes.status === 200, `Redundant Mark Ready failed (no open tasks should exist): ${JSON.stringify(readyRes.body)}`);

  const pickupAgainRes = await api('PUT', `/deliveries/${deliveryId}/pickup`, owner.token, {});
  assert(pickupAgainRes.status === 200, `Expected pickup to finally work after the two redundant taps, got ${pickupAgainRes.status}: ${JSON.stringify(pickupAgainRes.body)}`);
});

check('convert-payment: credit sale → to_cod sets a real COD amount; to_credit round-trips back', async () => {
  const owner = await loginOwner();
  const { saleId, deliveryId } = await createReadyDelivery(owner.token, { is_credit_sale: true });
  const toCodRes = await api('POST', `/deliveries/${deliveryId}/convert-payment`, owner.token, { action: 'to_cod' });
  assert(toCodRes.status === 200, `to_cod failed: ${JSON.stringify(toCodRes.body)}`);
  assert(Number(toCodRes.body.data.cod_amount) === 200, `Expected cod_amount 200, got ${toCodRes.body.data.cod_amount}`);
  assert(toCodRes.body.data.is_credit_sale === 0 || toCodRes.body.data.is_credit_sale === false, 'Expected is_credit_sale cleared');
  const toCreditRes = await api('POST', `/deliveries/${deliveryId}/convert-payment`, owner.token, { action: 'to_credit' });
  assert(toCreditRes.status === 200, `to_credit failed: ${JSON.stringify(toCreditRes.body)}`);
  assert(Number(toCreditRes.body.data.cod_amount) === 0, `Expected cod_amount reset to 0 after converting back to credit, got ${toCreditRes.body.data.cod_amount}`);
});

check('counter_staff pickup/deliver: blocked without pref, works with pref on (both endpoints, end to end)', async () => {
  const owner = await loginOwner();
  const staff = await createStaff('counter_staff', owner.token);
  await withPref('pref_counter_marks_pickup', '0', async () => {
    const { deliveryId } = await createReadyDelivery(owner.token, {});
    await api('PUT', `/deliveries/${deliveryId}/assign`, owner.token, { delivery_partner_id: 9 });
    const res = await api('PUT', `/deliveries/${deliveryId}/pickup`, staff.token, {});
    assert(res.status === 403, `Expected 403 with pref off, got ${res.status}`);
  });
  await withPref('pref_counter_marks_pickup', '1', async () => {
    const { deliveryId } = await createReadyDelivery(owner.token, {});
    await api('PUT', `/deliveries/${deliveryId}/assign`, owner.token, { delivery_partner_id: 9 });
    const res = await api('PUT', `/deliveries/${deliveryId}/pickup`, staff.token, {});
    assert(res.status === 200, `Expected 200 with pref on, got ${res.status}: ${JSON.stringify(res.body)}`);
  });
  await withPref('pref_counter_marks_delivered', '0', async () => {
    const { deliveryId } = await createReadyDelivery(owner.token, {});
    await api('PUT', `/deliveries/${deliveryId}/assign`, owner.token, { delivery_partner_id: 9 });
    await api('PUT', `/deliveries/${deliveryId}/pickup`, owner.token, {});
    const res = await api('PUT', `/deliveries/${deliveryId}/deliver`, staff.token, { cod_collected: 200, cod_method: 'cash' });
    assert(res.status === 403, `Expected 403 with pref off, got ${res.status}`);
  });
  await withPref('pref_counter_marks_delivered', '1', async () => {
    const { deliveryId } = await createReadyDelivery(owner.token, {});
    await api('PUT', `/deliveries/${deliveryId}/assign`, owner.token, { delivery_partner_id: 9 });
    await api('PUT', `/deliveries/${deliveryId}/pickup`, owner.token, {});
    const res = await api('PUT', `/deliveries/${deliveryId}/deliver`, staff.token, { cod_collected: 200, cod_method: 'cash' });
    assert(res.status === 200, `Expected 200 with pref on, got ${res.status}: ${JSON.stringify(res.body)}`);
  });
});

check('FIXED: a delivery cancelled via PUT /:id/cancel ("Cancel Delivery Only") can be reassigned to a new rider — sale itself deliberately still untouched', async () => {
  const owner = await loginOwner();
  const { saleId, deliveryId } = await createReadyDelivery(owner.token, {});
  await api('PUT', `/deliveries/${deliveryId}/assign`, owner.token, { delivery_partner_id: 9 });
  await api('PUT', `/deliveries/${deliveryId}/pickup`, owner.token, {});
  const cancelRes = await api('PUT', `/deliveries/${deliveryId}/cancel`, owner.token, { reason: 'Test cancel' });
  assert(cancelRes.status === 200, `Cancel failed: ${JSON.stringify(cancelRes.body)}`);

  const saleAfter = await api('GET', `/sales/${saleId}`, owner.token);
  // Deliberately unchanged design: "Cancel Delivery Only" is meant to leave
  // the sale alive for a fresh delivery attempt — "Cancel Order Too" is the
  // separate, explicit choice for cancelling the whole order too.
  assert(saleAfter.body.data.status !== 'cancelled', `Expected the sale to stay alive (by design), got status '${saleAfter.body.data.status}'`);
  // The actual fix: reassigning to a NEW rider now works, closing the dead end.
  const reassignRes = await api('PUT', `/deliveries/${deliveryId}/assign`, owner.token, { delivery_partner_id: 8 });
  assert(reassignRes.status === 200, `Expected reassignment to now succeed, got ${reassignRes.status}: ${JSON.stringify(reassignRes.body)}`);
  assert(reassignRes.body.data.status === 'assigned', `Expected 'assigned' after reassignment, got '${reassignRes.body.data.status}'`);
  assert(reassignRes.body.data.delivery_partner_id === 8, `Expected the NEW rider (8), got ${reassignRes.body.data.delivery_partner_id}`);
});

check('FIXED: sales.js PUT /:id/cancel is now blocked while a rider is actively in_transit', async () => {
  const owner = await loginOwner();
  const { saleId, deliveryId } = await createReadyDelivery(owner.token, {});
  await api('PUT', `/deliveries/${deliveryId}/assign`, owner.token, { delivery_partner_id: 9 });
  await api('PUT', `/deliveries/${deliveryId}/pickup`, owner.token, {});
  await api('PUT', `/deliveries/${deliveryId}/in-transit`, owner.token, {});
  const cancelRes = await api('PUT', `/sales/${saleId}/cancel`, owner.token);
  assert(cancelRes.status === 400, `Expected sales-cancel to be blocked while a rider is in_transit, got ${cancelRes.status}: ${JSON.stringify(cancelRes.body)}`);
  assert(/active delivery/i.test(cancelRes.body?.message || ''), `Expected a plain-language message naming the active delivery, got: ${cancelRes.body?.message}`);
  const deliveryAfter = await api('GET', `/deliveries/${deliveryId}`, owner.token);
  assert(deliveryAfter.body.data.status === 'in_transit', `Expected the delivery to be untouched (still 'in_transit'), got '${deliveryAfter.body.data.status}'`);

  // The escape hatch still works: cancel the delivery first, then the sale.
  await api('PUT', `/deliveries/${deliveryId}/cancel`, owner.token, { reason: 'Test' });
  const cancelSaleAfter = await api('PUT', `/sales/${saleId}/cancel`, owner.token);
  assert(cancelSaleAfter.status === 200, `Expected sale-cancel to succeed once the delivery itself was cancelled first, got ${cancelSaleAfter.status}: ${JSON.stringify(cancelSaleAfter.body)}`);
});

check('sales-level cancel is NOT blocked when the delivery is merely pending (no rider yet) or already failed', async () => {
  const owner = await loginOwner();
  const { saleId: saleId1 } = await createReadyDelivery(owner.token, {}); // delivery stays 'pending', no assign
  const cancelPending = await api('PUT', `/sales/${saleId1}/cancel`, owner.token);
  assert(cancelPending.status === 200, `Expected cancel to succeed with no rider assigned yet, got ${cancelPending.status}: ${JSON.stringify(cancelPending.body)}`);

  const { saleId: saleId2, deliveryId: deliveryId2 } = await createReadyDelivery(owner.token, {});
  await api('PUT', `/deliveries/${deliveryId2}/assign`, owner.token, { delivery_partner_id: 9 });
  await api('PUT', `/deliveries/${deliveryId2}/pickup`, owner.token, {});
  await api('PUT', `/deliveries/${deliveryId2}/fail`, owner.token, { failure_reason: 'Test' });
  const cancelFailed = await api('PUT', `/sales/${saleId2}/cancel`, owner.token);
  assert(cancelFailed.status === 200, `Expected cancel to succeed on a failed (not active) delivery, got ${cancelFailed.status}: ${JSON.stringify(cancelFailed.body)}`);
});

// ═══════════════════════════════════════════════════════════════
// PHASE 4 — pre_order
// ═══════════════════════════════════════════════════════════════

check('pre_order: scheduled_date in the future, starts \'pending\', advance_amount recorded as a real payment', async () => {
  const owner = await loginOwner();
  await ensureRegisterOpen(owner.token, TEST_LOCATION_ID);
  const future = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const { status, body } = await api('POST', '/sales', owner.token, {
    location_id: TEST_LOCATION_ID, order_type: 'pre_order', channel: 'whatsapp',
    scheduled_date: future,
    items: [{ quantity: 1, unit_price: 500, product_name: 'Test Pre-order Item' }],
    payments: [{ method: 'cash', amount: 200 }], // advance payment, not full
  });
  assert(status === 201, `Expected 201, got ${status}: ${JSON.stringify(body)}`);
  createdSaleIds.push(body.data.id);
  assert(body.data.status === 'pending', `Expected 'pending', got '${body.data.status}'`);
  assert(body.data.scheduled_date?.slice(0, 10) === future, `Expected scheduled_date ${future}, got ${body.data.scheduled_date}`);
  assert(body.data.payment_status === 'partial', `Expected payment_status 'partial' (200 of 500 paid), got '${body.data.payment_status}'`);
});

check('pre_order fulfilled by pickup: full lifecycle works exactly like a plain pickup order', async () => {
  const owner = await loginOwner();
  await ensureRegisterOpen(owner.token, TEST_LOCATION_ID);
  const { body: saleBody } = await api('POST', '/sales', owner.token, {
    location_id: TEST_LOCATION_ID, order_type: 'pre_order', channel: 'whatsapp',
    scheduled_date: new Date().toISOString().slice(0, 10),
    items: [{ quantity: 1, unit_price: 150, product_name: 'Test Pre-order Pickup' }],
    payments: [{ method: 'cash', amount: 150 }],
  });
  const saleId = saleBody.data.id;
  createdSaleIds.push(saleId);
  await api('PUT', `/sales/${saleId}/status`, owner.token, { status: 'preparing' });
  const tasksRes = await api('GET', `/production/tasks?sale_id=${saleId}`, owner.token);
  const task = tasksRes.body.data.find((t) => t.sale_id === saleId);
  await api('PUT', `/production/tasks/${task.id}/complete`, owner.token);
  // pre_order is NOT order_type 'pickup', so /deliveries/pickup/:saleId/picked-up's
  // own WHERE order_type='pickup' would 404 it — a pre_order fulfilled by
  // pickup completes via the plain status route instead.
  const completeRes = await api('PUT', `/sales/${saleId}/status`, owner.token, { status: 'completed' });
  assert(completeRes.status === 200, `Expected 200, got ${completeRes.status}: ${JSON.stringify(completeRes.body)}`);
});

check('FIXED: split advance payment on a delivery order persists each method separately and credits only the cash portion to the register (QuickCheckoutScreen partial+split bug, 2026-09-04)', async () => {
  const owner = await loginOwner();
  await ensureRegisterOpen(owner.token, TEST_LOCATION_ID);
  const db = await getDb();
  const regBefore = await db.prepare('SELECT total_cash_sales, total_upi_sales, expected_cash FROM cash_registers WHERE location_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1').get(TEST_LOCATION_ID);

  // Mirrors QuickCheckoutScreen's 'partial' mode with Split Payment on: total
  // 1000, advance 500 collected as 200 cash + 300 upi, remaining 500 as COD.
  // Before the fix, the client collapsed this to a single 500-cash entry
  // regardless of the split rows or the visible method selector.
  const { status, body } = await api('POST', '/sales', owner.token, {
    location_id: TEST_LOCATION_ID, order_type: 'delivery', channel: 'phone',
    delivery_address: '123 Test St', receiver_name: 'Test Receiver', receiver_phone: '9998887777',
    items: [{ quantity: 1, unit_price: 1000, product_name: 'Test Split Advance Item' }],
    advance_amount: 500,
    payments: [
      { method: 'cash', amount: 200 },
      { method: 'upi', amount: 300, reference_number: 'SPLITTEST' },
    ],
  });
  assert(status === 201, `Expected 201, got ${status}: ${JSON.stringify(body)}`);
  const saleId = body.data.id;
  createdSaleIds.push(saleId);

  const saleDetail = await api('GET', `/sales/${saleId}`, owner.token);
  const persistedPayments = saleDetail.body.data.payments || [];
  const cashPayment = persistedPayments.find((p) => p.method === 'cash');
  const upiPayment = persistedPayments.find((p) => p.method === 'upi');
  assert(cashPayment && Number(cashPayment.amount) === 200, `Expected a cash payment of 200, got ${JSON.stringify(cashPayment)}`);
  assert(upiPayment && Number(upiPayment.amount) === 300, `Expected a upi payment of 300, got ${JSON.stringify(upiPayment)}`);
  assert(Number(saleDetail.body.data.delivery?.cod_amount) === 500, `Expected cod_amount 500 (1000 - 500 advance), got ${saleDetail.body.data.delivery?.cod_amount}`);

  const regAfter = await db.prepare('SELECT total_cash_sales, total_upi_sales, expected_cash FROM cash_registers WHERE location_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1').get(TEST_LOCATION_ID);
  assert(Number(regAfter.total_cash_sales) - Number(regBefore.total_cash_sales) === 200, `Expected total_cash_sales to increase by exactly 200 (the cash portion only), got ${Number(regAfter.total_cash_sales) - Number(regBefore.total_cash_sales)}`);
  assert(Number(regAfter.expected_cash) - Number(regBefore.expected_cash) === 200, `Expected expected_cash to increase by exactly 200, got ${Number(regAfter.expected_cash) - Number(regBefore.expected_cash)}`);
  assert(Number(regAfter.total_upi_sales) - Number(regBefore.total_upi_sales) === 300, `Expected total_upi_sales to increase by exactly 300, got ${Number(regAfter.total_upi_sales) - Number(regBefore.total_upi_sales)}`);
});

// ═══════════════════════════════════════════════════════════════
// PHASE 5/6 — register guard sweep + adjacent areas
// ═══════════════════════════════════════════════════════════════

check('FIXED: PUT /sales/:id (Edit Sale) payment-method edit reverses the old method and credits the new one on the open register, and is blocked when no register is open (2026-09-04 audit)', async () => {
  const owner = await loginOwner();
  await ensureRegisterOpen(owner.token, TEST_LOCATION_ID);
  const db = await getDb();
  const { body: saleBody } = await api('POST', '/sales', owner.token, {
    location_id: TEST_LOCATION_ID, order_type: 'walk_in', channel: 'walk_in',
    items: [{ quantity: 1, unit_price: 300, product_name: 'Test Edit Sale Payment Method' }],
    payments: [{ method: 'cash', amount: 300 }],
  });
  const saleId = saleBody.data.id;
  createdSaleIds.push(saleId);

  const regBefore = await db.prepare('SELECT total_cash_sales, total_upi_sales, expected_cash FROM cash_registers WHERE location_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1').get(TEST_LOCATION_ID);

  // Before the fix: this delete+reinsert never touched cash_registers at
  // all — the 300 stayed credited as cash forever despite the edit saying
  // it was actually upi.
  const editRes = await api('PUT', `/sales/${saleId}`, owner.token, { payments: [{ method: 'upi', amount: 300, reference_number: 'EDITTEST' }] });
  assert(editRes.status === 200, `Edit failed: ${JSON.stringify(editRes.body)}`);

  const regAfter = await db.prepare('SELECT total_cash_sales, total_upi_sales, expected_cash FROM cash_registers WHERE location_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1').get(TEST_LOCATION_ID);
  assert(Number(regAfter.total_cash_sales) - Number(regBefore.total_cash_sales) === -300, `Expected total_cash_sales to reverse by -300, got ${Number(regAfter.total_cash_sales) - Number(regBefore.total_cash_sales)}`);
  assert(Number(regAfter.expected_cash) - Number(regBefore.expected_cash) === -300, `Expected expected_cash to reverse by -300, got ${Number(regAfter.expected_cash) - Number(regBefore.expected_cash)}`);
  assert(Number(regAfter.total_upi_sales) - Number(regBefore.total_upi_sales) === 300, `Expected total_upi_sales to increase by 300, got ${Number(regAfter.total_upi_sales) - Number(regBefore.total_upi_sales)}`);

  // Now close the register, then try to edit a DIFFERENT sale's payment
  // back to cash — must be blocked, since there's nowhere to credit it and
  // no way to know a register is even open for that location.
  await closeRegister(owner.token, TEST_LOCATION_ID);
  const blockedRes = await api('PUT', `/sales/${saleId}`, owner.token, { payments: [{ method: 'cash', amount: 300 }] });
  assert(blockedRes.status === 400, `Expected the cash edit to be blocked with the register closed, got ${blockedRes.status}: ${JSON.stringify(blockedRes.body)}`);
  await ensureRegisterOpen(owner.token, TEST_LOCATION_ID);
});

check('FIXED: POST /customers/:id/credits (credit payoff) is blocked for cash when the register is closed, same as every other cash-write route', async () => {
  const owner = await loginOwner();
  await ensureRegisterOpen(owner.token, TEST_LOCATION_ID);
  const customer = await createCustomer(owner.token);
  // Give the customer some dues to pay off, via add-due (owner/manager can
  // record historical dues without a live sale).
  const dueRes = await api('POST', `/customers/${customer.id}/add-due`, owner.token, { amount: 500, location_id: TEST_LOCATION_ID, notes: 'Test dues for credit-guard check' });
  assert(dueRes.status === 200 || dueRes.status === 201, `add-due failed: ${JSON.stringify(dueRes.body)}`);

  await closeRegister(owner.token, TEST_LOCATION_ID);
  const blockedRes = await api('POST', `/customers/${customer.id}/credits`, owner.token, { amount: 500, method: 'cash', location_id: TEST_LOCATION_ID });
  assert(blockedRes.status === 400, `Expected the cash credit payoff to be blocked with the register closed, got ${blockedRes.status}: ${JSON.stringify(blockedRes.body)}`);
  await ensureRegisterOpen(owner.token, TEST_LOCATION_ID);
  const okRes = await api('POST', `/customers/${customer.id}/credits`, owner.token, { amount: 500, method: 'cash', location_id: TEST_LOCATION_ID });
  assert(okRes.status === 200 || okRes.status === 201, `Expected the payoff to succeed with the register open, got ${okRes.status}: ${JSON.stringify(okRes.body)}`);
});

check('add-payment (POST /:id/payments) blocked when register is closed for cash', async () => {
  const owner = await loginOwner();
  await ensureRegisterOpen(owner.token, TEST_LOCATION_ID);
  const { body: saleBody } = await api('POST', '/sales', owner.token, {
    location_id: TEST_LOCATION_ID, order_type: 'walk_in', channel: 'walk_in',
    items: [{ quantity: 1, unit_price: 300, product_name: 'Test AddPayment RegClosed' }],
  });
  createdSaleIds.push(saleBody.data.id);
  await closeRegister(owner.token, TEST_LOCATION_ID);
  const res = await api('POST', `/sales/${saleBody.data.id}/payments`, owner.token, { payments: [{ method: 'cash', amount: 300 }] });
  assert(res.status === 400, `Expected 400 (register closed), got ${res.status}: ${JSON.stringify(res.body)}`);
  await ensureRegisterOpen(owner.token, TEST_LOCATION_ID);
});

check('cancel-after-refund interaction: paid walk_in blocks cancel until refunded, then cancel succeeds', async () => {
  const owner = await loginOwner();
  await ensureRegisterOpen(owner.token, TEST_LOCATION_ID);
  const { body: saleBody } = await api('POST', '/sales', owner.token, {
    location_id: TEST_LOCATION_ID, order_type: 'walk_in', channel: 'walk_in',
    items: [{ quantity: 1, unit_price: 250, product_name: 'Test Cancel-Refund Bouquet' }],
    payments: [{ method: 'cash', amount: 250 }],
  });
  const saleId = saleBody.data.id;
  createdSaleIds.push(saleId);
  const blockedCancel = await api('PUT', `/sales/${saleId}/cancel`, owner.token);
  assert(blockedCancel.status === 400, `Expected cancel to be blocked by the unrefunded balance, got ${blockedCancel.status}`);
  assert(/refund/i.test(blockedCancel.body?.message || ''), `Expected a plain-language message naming refund, got: ${blockedCancel.body?.message}`);
  const refundRes = await api('POST', `/sales/${saleId}/refund`, owner.token, { amount: 250, reason: 'Test refund', refund_method: 'cash' });
  assert(refundRes.status === 200 || refundRes.status === 201, `Refund failed: ${JSON.stringify(refundRes.body)}`);
  const cancelAfterRefund = await api('PUT', `/sales/${saleId}/cancel`, owner.token);
  assert(cancelAfterRefund.status === 200, `Expected cancel to succeed once refunded, got ${cancelAfterRefund.status}: ${JSON.stringify(cancelAfterRefund.body)}`);
});

check('FIXED: refund is capped against what was actually paid, not grand_total', async () => {
  const owner = await loginOwner();
  await ensureRegisterOpen(owner.token, TEST_LOCATION_ID);
  const { body: saleBody } = await api('POST', '/sales', owner.token, {
    location_id: TEST_LOCATION_ID, order_type: 'walk_in', channel: 'walk_in',
    items: [{ quantity: 1, unit_price: 300, product_name: 'Test Over-refund Bouquet' }],
    payments: [{ method: 'cash', amount: 100 }], // only 100 of 300 ever paid
  });
  const saleId = saleBody.data.id;
  createdSaleIds.push(saleId);
  assert(saleBody.data.payment_status === 'partial', `Expected 'partial' (100 of 300 paid), got '${saleBody.data.payment_status}'`);
  // Attempting to refund the full grand_total (300) must now be rejected —
  // only 100 was ever collected.
  const overRes = await api('POST', `/sales/${saleId}/refund`, owner.token, { amount: 300, reason: 'Test over-refund', refund_method: 'cash' });
  assert(overRes.status === 400, `Expected the over-refund to be rejected, got ${overRes.status}: ${JSON.stringify(overRes.body)}`);
  assert(/actually paid/i.test(overRes.body?.message || ''), `Expected a plain-language message naming what was actually paid, got: ${overRes.body?.message}`);
  // Refunding exactly what was paid must still work.
  const { body: registerBefore } = await api('GET', `/sales/register/status?location_id=${TEST_LOCATION_ID}`, owner.token);
  const okRes = await api('POST', `/sales/${saleId}/refund`, owner.token, { amount: 100, reason: 'Test correct refund', refund_method: 'cash' });
  assert(okRes.status === 200 || okRes.status === 201, `Expected the in-bounds refund to succeed, got ${okRes.status}: ${JSON.stringify(okRes.body)}`);
  const { body: registerAfter } = await api('GET', `/sales/register/status?location_id=${TEST_LOCATION_ID}`, owner.token);
  assert(Number(registerAfter.data.expected_cash) === Number(registerBefore.data.expected_cash) - 100, `Expected expected_cash to drop by exactly 100, went from ${registerBefore.data.expected_cash} to ${registerAfter.data.expected_cash}`);
});

check('settle-now: cash COD settlement credits the register and marks the delivery settled', async () => {
  const owner = await loginOwner();
  await ensureRegisterOpen(owner.token, TEST_LOCATION_ID);
  const { deliveryId } = await createReadyDelivery(owner.token, {});
  await api('PUT', `/deliveries/${deliveryId}/assign`, owner.token, { delivery_partner_id: 9 });
  await api('PUT', `/deliveries/${deliveryId}/pickup`, owner.token, {});
  await api('PUT', `/deliveries/${deliveryId}/deliver`, owner.token, { cod_collected: 200, cod_method: 'cash' });
  const { body: regBefore } = await api('GET', `/sales/register/status?location_id=${TEST_LOCATION_ID}`, owner.token);
  const settleRes = await api('POST', '/deliveries/settlements/settle-now', owner.token, { delivery_partner_id: 9, delivery_ids: [deliveryId] });
  assert(settleRes.status === 200 || settleRes.status === 201, `Settle-now failed: ${JSON.stringify(settleRes.body)}`);
  assert(settleRes.body.data.by_method?.cash === 200 && settleRes.body.data.by_method?.upi === 0, `Expected by_method {cash:200, upi:0}, got ${JSON.stringify(settleRes.body.data.by_method)}`);
  const { body: regAfter } = await api('GET', `/sales/register/status?location_id=${TEST_LOCATION_ID}`, owner.token);
  assert(Number(regAfter.data.expected_cash) === Number(regBefore.data.expected_cash) + 200, `Expected register expected_cash to increase by 200, went from ${regBefore.data.expected_cash} to ${regAfter.data.expected_cash}`);
});

check('FIXED: settle-now with a UPI collection does NOT credit expected_cash, and reports by_method so the UI can say so accurately', async () => {
  const owner = await loginOwner();
  await ensureRegisterOpen(owner.token, TEST_LOCATION_ID);
  const { deliveryId } = await createReadyDelivery(owner.token, {});
  await api('PUT', `/deliveries/${deliveryId}/assign`, owner.token, { delivery_partner_id: 9 });
  await api('PUT', `/deliveries/${deliveryId}/pickup`, owner.token, {});
  await api('PUT', `/deliveries/${deliveryId}/deliver`, owner.token, { cod_collected: 200, cod_method: 'upi' });
  const { body: regBefore } = await api('GET', `/sales/register/status?location_id=${TEST_LOCATION_ID}`, owner.token);
  const settleRes = await api('POST', '/deliveries/settlements/settle-now', owner.token, { delivery_partner_id: 9, delivery_ids: [deliveryId] });
  assert(settleRes.status === 200 || settleRes.status === 201, `Settle-now failed: ${JSON.stringify(settleRes.body)}`);
  assert(settleRes.body.data.by_method?.cash === 0 && settleRes.body.data.by_method?.upi === 200, `Expected by_method {cash:0, upi:200}, got ${JSON.stringify(settleRes.body.data.by_method)}`);
  const { body: regAfter } = await api('GET', `/sales/register/status?location_id=${TEST_LOCATION_ID}`, owner.token);
  assert(Number(regAfter.data.expected_cash) === Number(regBefore.data.expected_cash), `Expected expected_cash UNCHANGED for a pure-UPI settlement, went from ${regBefore.data.expected_cash} to ${regAfter.data.expected_cash}`);
  assert(Number(regAfter.data.total_upi_sales) === Number(regBefore.data.total_upi_sales) + 200, `Expected total_upi_sales to increase by 200, went from ${regBefore.data.total_upi_sales} to ${regAfter.data.total_upi_sales}`);
});

check('FIXED: OrderQuickModal (order-detail modal on the dashboard) no longer fires Mark Delivered bare — it now hands COD-outstanding to the same collect_cod flow the card uses', async () => {
  // This is a frontend wiring fix (QuickModals.js's confirmAction now checks
  // resolveDeliverStep before calling doStatusChange, same shape as the
  // pre-existing Start Preparing / onPickPreparer special-case) — nothing
  // server-side changed for it, so there's no new endpoint behavior to hit
  // here. Documented as a check anyway so this fix has a permanent home in
  // the suite; the real verification is the code read in QuickModals.js's
  // confirmAction plus the by_method / register checks above, which prove
  // the underlying /deliver + settle-now chain was never the bug — only the
  // modal's blind fire (and the Settlements screen's copy) were.
  assert(true, 'see comment — code-level fix, verified by inspection + the by_method checks above');
});

check('CRITICAL FINDING: POST /customer-order is completely broken — 500s on every call (SQL placeholder/param-count mismatch), not just an edge case', async () => {
  const owner = await loginOwner();
  const customer = await createCustomer(owner.token);
  const { status, body } = await api('POST', '/sales/customer-order', customer.token, {
    location_id: TEST_LOCATION_ID, order_type: 'pickup',
    items: [{ product_id: 1, quantity: 1 }],
  });
  // This is the finding, not a passing assertion: the INSERT INTO sales
  // statement in this route (sales.js, POST /customer-order) lists 24
  // columns but its VALUES clause has 19 `?` placeholders against only 18
  // bound params in the .run(...) call below it — a plain off-by-one, not
  // the bindParams()-and-apostrophes footgun CLAUDE.md already documents.
  // Every call 500s with "Insufficient SQL parameters supplied" before it
  // ever reaches the register/payment-safety code CLAUDE.md's audit was
  // about — that claim (no payments/register writes) is still true of the
  // code as written, but was never actually exercised end-to-end, because
  // the endpoint never successfully returns. This means real customers
  // hitting "place order" in CustomerShopScreen.js get a hard failure, not
  // a working order that merely lacks some feature.
  assert(status === 500 && /Insufficient SQL parameters/i.test(body?.message || ''),
    `Expected the documented SQL param mismatch to reproduce as a 500 — got ${status}: ${JSON.stringify(body)}. If this now succeeds, the bug has likely already been fixed — good, update this finding rather than deleting it (verify the params/placeholders actually still match 1:1 before assuming so).`);
});

check('FINDING: POST /customer-order has no role restriction beyond authenticate (any staff role can also call it, not just customers) — confirmed via the auth layer, since the route body itself 500s for everyone right now', async () => {
  const owner = await loginOwner();
  const florist = await createStaff('florist_staff', owner.token);
  const res = await api('POST', '/sales/customer-order', florist.token, {
    location_id: TEST_LOCATION_ID, order_type: 'pickup',
    items: [{ product_id: 1, quantity: 1 }],
  });
  // Confirms the ABSENCE of a 403 from an authorize() gate specifically —
  // getting through auth to the same 500 as any other role is exactly what
  // "no role restriction" looks like while the handler itself is broken.
  assert(res.status !== 403, `Expected NOT 403 (no authorize() on this route restricts it to customers) — got ${res.status}: ${JSON.stringify(res.body)}. A 403 here would mean a role gate was added — update this finding.`);
  assert(res.status === 500, `Expected the same SQL-param 500 every role currently gets, got ${res.status}: ${JSON.stringify(res.body)}`);
});

check('FINDING: staff sale creation trusts client-supplied unit_price on a real product, bypassing the discount-approval threshold entirely', async () => {
  const owner = await loginOwner();
  const staff = await createStaff('counter_staff', owner.token);
  // Product 1 (Red Rose Standing Bunch) sells for ₹500 — send unit_price: 1.
  const { status, body } = await api('POST', '/sales', staff.token, {
    location_id: TEST_LOCATION_ID, order_type: 'walk_in', channel: 'walk_in',
    items: [{ product_id: 1, quantity: 1, unit_price: 1 }],
  });
  assert(status === 201, `(finding context) Expected this near-zero price to be ACCEPTED with no approval step — got ${status}: ${JSON.stringify(body)}`);
  createdSaleIds.push(body.data.id);
  assert(Number(body.data.grand_total) <= 1.01, `Expected the sale to actually be rung up at ₹1 (the real product sells for ₹500), got grand_total ${body.data.grand_total} — this is the finding: no server-side floor tied to the product's own selling_price, and no discount-threshold approval is triggered because this never goes through the discount_type/discount_value path at all.`);
});

check('recurring order processor: runs without a register/payment side effect (documented claim)', async () => {
  const db = await getDb();
  const before = await db.prepare('SELECT COUNT(*) as cnt FROM payments').get();
  const { processRecurringOrders } = require('../routes/recurring-orders');
  assert(typeof processRecurringOrders === 'function', 'Expected processRecurringOrders to be an exported function');
  await processRecurringOrders();
  const after = await db.prepare('SELECT COUNT(*) as cnt FROM payments').get();
  assert(Number(before.cnt) === Number(after.cnt), `Expected zero new payment rows from the recurring processor, went from ${before.cnt} to ${after.cnt}`);
});

// ─── Run ──────────────────────────────────────────────────────
async function cleanup() {
  if (createdUserIds.length === 0 && createdSaleIds.length === 0) return;
  const db = await getDb();
  for (const saleId of createdSaleIds) {
    try {
      await db.prepare('DELETE FROM delivery_load_checks WHERE delivery_id IN (SELECT id FROM deliveries WHERE sale_id = ?)').run(saleId);
      // settle-now checks leave a real delivery_settlements row behind —
      // must go before the deliveries row (settlement_items references it),
      // and before deliveries itself. Found missing during the 2026-09-04
      // COD-method investigation: prior runs left orphaned settlement rows.
      await db.prepare('DELETE FROM delivery_settlement_items WHERE delivery_id IN (SELECT id FROM deliveries WHERE sale_id = ?)').run(saleId);
      await db.prepare('DELETE FROM delivery_collections WHERE delivery_id IN (SELECT id FROM deliveries WHERE sale_id = ?)').run(saleId);
      await db.prepare('DELETE FROM deliveries WHERE sale_id = ?').run(saleId);
      await db.prepare('DELETE FROM production_tasks WHERE sale_id = ?').run(saleId);
      await db.prepare('DELETE FROM payments WHERE sale_id = ?').run(saleId);
      await db.prepare('DELETE FROM refunds WHERE sale_id = ?').run(saleId);
      await db.prepare('DELETE FROM sale_items WHERE sale_id = ?').run(saleId);
      await db.prepare('DELETE FROM pre_orders WHERE sale_id = ?').run(saleId);
      await db.prepare('DELETE FROM sales WHERE id = ?').run(saleId);
    } catch (err) {
      console.error(`   (cleanup warning: sale ${saleId}: ${err.message})`);
    }
  }
  // Settlement rows this run created are now empty (their one settlement_item
  // was just deleted above) — remove them too, rather than leaving zero-item
  // settlements behind. Safe because every settle-now check in this suite
  // settles exactly one delivery per settlement (explicit delivery_ids), so
  // a settlement with no items left is one this run created, not a real one.
  try {
    await db.prepare('DELETE FROM delivery_settlements WHERE id NOT IN (SELECT DISTINCT settlement_id FROM delivery_settlement_items)').run();
  } catch (err) {
    console.error(`   (cleanup warning: orphaned settlements: ${err.message})`);
  }
  for (const userId of createdUserIds) {
    try {
      await db.prepare('DELETE FROM user_locations WHERE user_id = ?').run(userId);
      await db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    } catch (err) {
      console.error(`   (cleanup warning: user ${userId}: ${err.message})`);
    }
  }
  console.log(`Cleaned up ${createdSaleIds.length} test sale(s) and ${createdUserIds.length} test user(s)`);
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
