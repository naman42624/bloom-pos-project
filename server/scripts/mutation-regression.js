/* eslint-disable no-console */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.API_BASE_URL || 'http://localhost:3001';
const OWNER_PHONE = process.env.SMOKE_OWNER_PHONE || '9876453210';
const OWNER_PASSWORD = process.env.SMOKE_OWNER_PASSWORD || 'naman1234';

const routeBaseByFile = {
  'auth.js': '/api/auth',
  'users.js': '/api/users',
  'locations.js': '/api/locations',
  'settings.js': '/api/settings',
  'categories.js': '/api/categories',
  'materials.js': '/api/materials',
  'suppliers.js': '/api/suppliers',
  'purchase-orders.js': '/api/purchase-orders',
  'stock.js': '/api/stock',
  'products.js': '/api/products',
  'sales.js': '/api/sales',
  'expenses.js': '/api/expenses',
  'customers.js': '/api/customers',
  'production.js': '/api/production',
  'deliveries.js': '/api/deliveries',
  'recurring-orders.js': '/api/recurring-orders',
  'attendance.js': '/api/attendance',
  'staff-management.js': '/api/staff',
  'delivery-tracking.js': '/api/delivery-tracking',
  'notifications.js': '/api/notifications',
};

const bodyOverrides = {
  'POST /api/auth/login': { phone: OWNER_PHONE, password: OWNER_PASSWORD },
  'POST /api/auth/register': {
    name: `Mutation Test ${Date.now()}`,
    phone: `9${String(Date.now()).slice(-9)}`,
    password: 'test1234',
  },
  'PUT /api/auth/profile': { name: 'Mutation Runner' },
  'POST /api/notifications/register-token': { token: `ExponentPushToken[mut-${Date.now()}]`, platform: 'expo' },
  'DELETE /api/notifications/unregister-token': { token: `ExponentPushToken[mut-${Date.now()}]` },
  'POST /api/sales': {
    location_id: 1,
    order_type: 'walk_in',
    items: [{ product_id: 1, quantity: 1, unit_price: 100 }],
    payments: [{ method: 'cash', amount: 100 }],
  },
  'POST /api/sales/register/open': { location_id: 1, opening_balance: 1000 },
  'PUT /api/sales/register/close': { location_id: 1, actual_cash: 1000, closing_notes: 'mutation test close' },
  'POST /api/expenses': {
    location_id: 1,
    category: 'other',
    amount: 10,
    description: 'Mutation test expense',
    payment_method: 'cash',
    expense_date: new Date().toISOString().slice(0, 10),
  },
  'POST /api/customers': { name: 'Mutation Customer', phone: `8${String(Date.now()).slice(-9)}` },
  'POST /api/customers/1/addresses': {
    label: 'Home', address_line_1: 'Test Address', city: 'Test City', state: 'TS', pincode: '123456',
  },
  'POST /api/customers/1/special-dates': { label: 'Birthday', date: '2000-01-01' },
  'POST /api/materials/transfer': { material_id: 1, from_location_id: 1, to_location_id: 2, quantity: 1 },
  'POST /api/stock': { material_id: 1, location_id: 1, quantity: 1, type: 'adjustment', notes: 'mutation test' },
  'POST /api/stock/reconcile': { location_id: 1, items: [{ material_id: 1, counted_quantity: 1 }] },
  'POST /api/stock/transfers': { material_id: 1, from_location_id: 1, to_location_id: 2, quantity: 1 },
  'POST /api/delivery-tracking/location': { latitude: 28.6139, longitude: 77.2090, accuracy: 10 },
};

function discoverMutationEndpoints() {
  const routesDir = path.join(__dirname, '..', 'routes');
  const files = fs.readdirSync(routesDir).filter((f) => f.endsWith('.js'));
  const endpoints = [];

  for (const file of files) {
    const base = routeBaseByFile[file];
    if (!base) continue;

    const content = fs.readFileSync(path.join(routesDir, file), 'utf8');
    const regex = /router\.(post|put|delete|patch)\(\s*(?:\n\s*)?['"`]([^'"`]+)['"`]/gim;
    let match;

    while ((match = regex.exec(content)) !== null) {
      const method = match[1].toUpperCase();
      const routePath = match[2];
      endpoints.push({ method, file, routePath, fullPath: `${base}${routePath}` });
    }
  }

  // Unique by method + fullPath
  const uniq = new Map();
  for (const endpoint of endpoints) {
    uniq.set(`${endpoint.method} ${endpoint.fullPath}`, endpoint);
  }

  return Array.from(uniq.values()).sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    if (a.method !== b.method) return a.method.localeCompare(b.method);
    return a.fullPath.localeCompare(b.fullPath);
  });
}

function safePath(fullPath) {
  return fullPath.replace(/:([A-Za-z_][A-Za-z0-9_]*)(\([^/]+\))?/g, (_m, name) => {
    if (name.toLowerCase() === 'action') return 'approve';
    return '999999';
  });
}

function shouldSendAuth(fullPath) {
  return !fullPath.startsWith('/api/auth/login')
    && !fullPath.startsWith('/api/auth/register')
    && !fullPath.startsWith('/api/auth/setup')
    && !fullPath.startsWith('/api/auth/setup-status');
}

async function loginOwner() {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: OWNER_PHONE, password: OWNER_PASSWORD }),
  });
  const json = await res.json();
  if (!res.ok || !json?.data?.token) {
    throw new Error(`Owner login failed: ${res.status} ${json?.message || ''}`);
  }
  return json.data.token;
}

async function runCase(endpoint, token) {
  const key = `${endpoint.method} ${endpoint.fullPath}`;
  const targetPath = safePath(endpoint.fullPath);

  const headers = { 'Content-Type': 'application/json' };
  if (shouldSendAuth(endpoint.fullPath)) headers.Authorization = `Bearer ${token}`;

  const body = bodyOverrides[key] || ((endpoint.method === 'POST' || endpoint.method === 'PUT' || endpoint.method === 'PATCH') ? {} : undefined);

  const init = {
    method: endpoint.method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };

  try {
    const res = await fetch(`${BASE_URL}${targetPath}`, init);
    let payload = null;
    try { payload = await res.json(); } catch { payload = null; }

    return {
      ...endpoint,
      targetPath,
      status: res.status,
      ok: res.status < 500,
      message: payload?.message || null,
    };
  } catch (error) {
    return {
      ...endpoint,
      targetPath,
      status: 'ERR',
      ok: false,
      message: error.message,
    };
  }
}

function writeReport(results, startedAt, endedAt) {
  const reportPath = path.join(__dirname, '..', 'MUTATION_TEST_REPORT.md');
  const total = results.length;
  const passed = results.filter((r) => r.ok).length;
  const failed = total - passed;

  const byStatus = {};
  for (const r of results) {
    const key = String(r.status);
    byStatus[key] = (byStatus[key] || 0) + 1;
  }

  const failures = results.filter((r) => !r.ok);

  const lines = [];
  lines.push('# Mutation Regression Test Report');
  lines.push('');
  lines.push(`- Start: ${startedAt.toISOString()}`);
  lines.push(`- End: ${endedAt.toISOString()}`);
  lines.push(`- Base URL: ${BASE_URL}`);
  lines.push(`- Total mutation endpoints tested: ${total}`);
  lines.push(`- Passed (non-5xx): ${passed}`);
  lines.push(`- Failed (5xx/network): ${failed}`);
  lines.push(`- Status histogram: ${JSON.stringify(byStatus)}`);
  lines.push('');

  lines.push('## Coverage Strategy');
  lines.push('- Enumerated all router mutation handlers (`POST`, `PUT`, `DELETE`, `PATCH`) from `server/routes/*.js`.');
  lines.push('- Replaced path params with safe non-destructive IDs to avoid deleting live records.');
  lines.push('- Ran each endpoint with auth (except public auth endpoints) and minimal payload or endpoint-specific payload override.');
  lines.push('- Treated all 2xx/3xx/4xx as pass for regression safety; only 5xx/network counted as failures.');
  lines.push('');

  if (failures.length > 0) {
    lines.push('## Failures');
    for (const f of failures) {
      lines.push(`- ${f.method} ${f.targetPath} [${f.status}] (${f.file}) :: ${f.message || ''}`);
    }
    lines.push('');
  } else {
    lines.push('## Failures');
    lines.push('- None. No mutation endpoint returned 5xx/network failure in this run.');
    lines.push('');
  }

  lines.push('## Endpoint Results');
  lines.push('| Method | Endpoint | Tested Path | Status | File | Notes |');
  lines.push('|---|---|---|---:|---|---|');
  for (const r of results) {
    lines.push(`| ${r.method} | ${r.fullPath} | ${r.targetPath} | ${r.status} | ${r.file} | ${String(r.message || '').replace(/\|/g, '\\|')} |`);
  }

  fs.writeFileSync(reportPath, lines.join('\n'));
  return reportPath;
}

async function main() {
  const startedAt = new Date();
  const token = await loginOwner();
  const endpoints = discoverMutationEndpoints();

  const results = [];
  for (const endpoint of endpoints) {
    // eslint-disable-next-line no-await-in-loop
    const res = await runCase(endpoint, token);
    results.push(res);
  }

  const endedAt = new Date();
  const reportPath = writeReport(results, startedAt, endedAt);

  const failed = results.filter((r) => !r.ok);

  console.log('\n=== Mutation Regression Summary ===');
  console.log(`Total: ${results.length}`);
  console.log(`Pass (non-5xx): ${results.length - failed.length}`);
  console.log(`Fail (5xx/network): ${failed.length}`);
  console.log(`Report: ${reportPath}`);

  if (failed.length) {
    console.log('\n--- Failures ---');
    for (const f of failed) {
      console.log(`${f.method} ${f.targetPath} => ${f.status} (${f.file}) :: ${f.message || ''}`);
    }
  }

  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error('Mutation regression run failed:', error.message);
  process.exit(1);
});
