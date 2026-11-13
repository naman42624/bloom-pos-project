#!/usr/bin/env node
/**
 * Live verification of the Expense Book (items, suggestions, history).
 * Append checks with check(name, fn); register anything you create in the
 * cleanup registry (createdItemIds / createdExpenseIds / createdRegisterIds).
 * Test rows are named with the VerifyEB prefix.
 *
 * Usage: source test-env.sh; node server/scripts/verify-expense-book.js
 */
require('dotenv').config();
const jwt = require('jsonwebtoken');
const { getDb } = require('../config/database-async');

const API_BASE = process.env.API_BASE_URL || 'http://localhost:3001/api';
const TEST_LOCATION_ID = 4; // Test Loc

const checks = [];
const createdItemIds = [];
const createdExpenseIds = [];
const createdRegisterIds = [];

function check(name, fn) { checks.push({ name, fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

function assertLocalTarget() {
  const isLocal = (u) => { try { const h = new URL(u).hostname; return h === 'localhost' || h === '127.0.0.1'; } catch { return false; } };
  const bad = [];
  if (!isLocal(API_BASE)) bad.push('API_BASE_URL');
  if (!isLocal(process.env.DATABASE_URL || '')) bad.push('DATABASE_URL');
  if (bad.length) { console.error(`Refusing to run: ${bad.join(', ')} not local.`); process.exit(1); }
}

// Token for a test user without needing a password.
function tokenFor(id) { return jwt.sign({ id }, process.env.JWT_SECRET); }

async function api(method, path, token, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body: json };
}

async function rejects(fn) { try { await fn(); } catch (e) { return e; } return null; }
async function track(item) { if (item && !createdItemIds.includes(item.id)) createdItemIds.push(item.id); return item; }

// ── Task 1: schema and item resolution ──
const { nameKey, resolveItem, rememberOnItem } = require('../utils/expense-items');

check('nameKey trims, lower-cases and squeezes spaces', async () => {
  assert(nameKey('  Petrol  Pump ') === 'petrol pump', 'got ' + nameKey('  Petrol  Pump '));
  assert(nameKey('x'.repeat(100)).length === 80, 'not cut to 80');
});

check('resolveItem creates, then finds the same item by a differently spelled name', async () => {
  const db = await getDb();
  const a = await track(await resolveItem(db, { item_name: 'VerifyEB Petrol', category: 'transport', userId: 7777 }));
  assert(a && a.id && a.category === 'transport', 'not created');
  const b = await track(await resolveItem(db, { item_name: 'verifyeb  petrol', userId: 7777 }));
  assert(b.id === a.id, `different ids ${a.id} vs ${b.id}`);
});

check('a new name without a category is refused in plain words', async () => {
  const e = await rejects(async () => resolveItem(await getDb(), { item_name: 'VerifyEB NoCat', userId: 7777 }));
  assert(e && e.statusCode === 400, 'no 400');
  assert(e.message === 'Pick what kind of expense this is.', 'copy: ' + e.message);
});

check('two parallel resolves of one new name give one item', async () => {
  const db = await getDb();
  const [x, y] = await Promise.all([
    resolveItem(db, { item_name: 'VerifyEB Parallel', category: 'other', userId: 7777 }),
    resolveItem(db, { item_name: 'VerifyEB Parallel', category: 'other', userId: 7777 }),
  ]);
  await track(x);
  assert(x.id === y.id, `ids ${x.id} vs ${y.id}`);
  const n = await db.prepare("SELECT COUNT(*) AS c FROM expense_items WHERE name_key = 'verifyeb parallel'").get();
  assert(Number(n.c) === 1, 'rows: ' + n.c);
});

check('a merged item resolves to its target', async () => {
  const db = await getDb();
  const a = await track(await resolveItem(db, { item_name: 'VerifyEB MergeA', category: 'other', userId: 7777 }));
  const b = await track(await resolveItem(db, { item_name: 'VerifyEB MergeB', category: 'other', userId: 7777 }));
  await db.prepare('UPDATE expense_items SET merged_into = ? WHERE id = ?').run(a.id, b.id);
  const r = await resolveItem(db, { item_name: 'VerifyEB MergeB', userId: 7777 });
  assert(r.id === a.id, `got ${r.id}, wanted ${a.id}`);
  const byId = await resolveItem(db, { item_id: b.id, userId: 7777 });
  assert(byId.id === a.id, 'item_id did not follow merged_into');
});

check('a hidden item resolved by name becomes active again', async () => {
  const db = await getDb();
  const a = await track(await resolveItem(db, { item_name: 'VerifyEB Hidden', category: 'other', userId: 7777 }));
  await db.prepare('UPDATE expense_items SET is_active = FALSE WHERE id = ?').run(a.id);
  const r = await resolveItem(db, { item_name: 'VerifyEB Hidden', userId: 7777 });
  assert(r.id === a.id && r.is_active === true, 'not reactivated');
});

check('rememberOnItem stores usual amount and last given-to', async () => {
  const db = await getDb();
  const a = await track(await resolveItem(db, { item_name: 'VerifyEB Remember', category: 'other', userId: 7777 }));
  await rememberOnItem(db, a.id, { amount: 123.5, given_to_user_id: null, given_to_name: 'VerifyEB Bob' });
  const r = await db.prepare('SELECT usual_amount, last_given_to_name FROM expense_items WHERE id = ?').get(a.id);
  assert(Number(r.usual_amount) === 123.5 && r.last_given_to_name === 'VerifyEB Bob', JSON.stringify(r));
});

async function cleanup() {
  const db = await getDb();
  for (const id of createdExpenseIds) {
    try { await db.prepare('DELETE FROM expenses WHERE id = ?').run(id); } catch (e) { console.error('cleanup expense', id, e.message); }
  }
  for (const id of createdRegisterIds) {
    try { await db.prepare('DELETE FROM cash_registers WHERE id = ?').run(id); } catch (e) { console.error('cleanup register', id, e.message); }
  }
  try {
    await db.prepare("UPDATE expenses SET item_id = NULL WHERE item_id IN (SELECT id FROM expense_items WHERE name LIKE 'VerifyEB%')").run();
    await db.prepare("UPDATE expense_items SET merged_into = NULL WHERE name LIKE 'VerifyEB%'").run();
    await db.prepare("DELETE FROM expense_items WHERE name LIKE 'VerifyEB%'").run();
  } catch (e) { console.error('cleanup items:', e.message); }
}

async function main() {
  assertLocalTarget();
  let pass = 0, fail = 0;
  try {
    for (const { name, fn } of checks) {
      try { await fn(); console.log(`PASS ${name}`); pass++; }
      catch (err) { console.log(`FAIL ${name}\n   ${err.message}`); fail++; }
    }
  } finally {
    await cleanup();
  }
  console.log(`\n${pass}/${pass + fail} checks passed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
