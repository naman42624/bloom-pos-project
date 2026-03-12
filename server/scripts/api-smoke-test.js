/* eslint-disable no-console */
require('dotenv').config();

const BASE_URL = process.env.API_BASE_URL || 'http://localhost:3001';
const OWNER_PHONE = process.env.SMOKE_OWNER_PHONE || '9876453210';
const OWNER_PASSWORD = process.env.SMOKE_OWNER_PASSWORD || 'naman1234';

async function request(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  return { status: res.status, data };
}

function isAcceptableStatus(status) {
  return [200, 201, 400, 401, 403, 404, 409, 422].includes(status);
}

async function main() {
  const results = [];

  const check = async (label, method, path, options = {}) => {
    try {
      const res = await request(method, path, options);
      const ok = isAcceptableStatus(res.status);
      results.push({ label, method, path, status: res.status, ok });
    } catch (error) {
      results.push({ label, method, path, status: 'ERR', ok: false, error: error.message });
    }
  };

  await check('Health', 'GET', '/api/health');
  await check('Setup status', 'GET', '/api/auth/setup-status');

  const loginRes = await request('POST', '/api/auth/login', {
    body: { phone: OWNER_PHONE, password: OWNER_PASSWORD },
  });

  results.push({
    label: 'Login owner user',
    method: 'POST',
    path: '/api/auth/login',
    status: loginRes.status,
    ok: isAcceptableStatus(loginRes.status),
  });

  const token = loginRes?.data?.data?.token;
  if (!token) {
    throw new Error('Could not login owner user to continue API tests');
  }

  const tests = [
    ['Auth me', 'GET', '/api/auth/me'],
    ['Auth update profile validation', 'PUT', '/api/auth/profile', { body: {} }],
    ['Users list', 'GET', '/api/users'],
    ['Locations list', 'GET', '/api/locations'],
    ['Settings list', 'GET', '/api/settings'],
    ['Categories list', 'GET', '/api/categories'],
    ['Materials list', 'GET', '/api/materials'],
    ['Suppliers list', 'GET', '/api/suppliers'],
    ['Purchase orders list', 'GET', '/api/purchase-orders'],
    ['Stock list', 'GET', '/api/stock'],
    ['Stock transactions', 'GET', '/api/stock/transactions'],
    ['Products list', 'GET', '/api/products'],
    ['Sales list', 'GET', '/api/sales'],
    ['Sales today summary', 'GET', '/api/sales/today-summary'],
    ['Expenses list', 'GET', '/api/expenses'],
    ['Customers list', 'GET', '/api/customers'],
    ['Production tasks', 'GET', '/api/production/tasks'],
    ['Production stats', 'GET', '/api/production/stats'],
    ['Deliveries list', 'GET', '/api/deliveries'],
    ['Delivery unsettled', 'GET', '/api/deliveries/settlements/unsettled'],
    ['Delivery settlements', 'GET', '/api/deliveries/settlements'],
    ['Recurring orders list', 'GET', '/api/recurring-orders'],
    ['Attendance today', 'GET', '/api/attendance/today'],
    ['Attendance report', 'GET', '/api/attendance/report'],
    ['Staff shifts', 'GET', '/api/staff/shifts'],
    ['Staff salaries', 'GET', '/api/staff/salaries'],
    ['Delivery tracking active partners', 'GET', '/api/delivery-tracking/active-partners'],
    ['Reports sales summary', 'GET', '/api/reports/sales-summary'],
    ['Reports inventory', 'GET', '/api/reports/inventory'],
    ['Notifications list', 'GET', '/api/notifications'],
    ['Notifications unread count', 'GET', '/api/notifications/unread-count'],
    ['Invalid auth endpoint', 'GET', '/api/auth/does-not-exist'],
  ];

  for (const [label, method, path, options = {}] of tests) {
    await check(label, method, path, { token, ...options });
  }

  const failures = results.filter((r) => !r.ok);
  const byStatus = results.reduce((acc, r) => {
    const key = String(r.status);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  console.log('\n=== API Smoke Test Summary ===');
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Total checks: ${results.length}`);
  console.log(`Pass (acceptable status): ${results.length - failures.length}`);
  console.log(`Fail (unexpected/5xx/error): ${failures.length}`);
  console.log('Status histogram:', byStatus);

  if (failures.length) {
    console.log('\n--- Failures ---');
    for (const f of failures) {
      console.log(`${f.method} ${f.path} => ${f.status} :: ${f.error || 'Unexpected status'}`);
    }
  }

  console.log('\n--- Detailed Results ---');
  for (const r of results) {
    console.log(`${r.ok ? '✅' : '❌'} [${r.status}] ${r.method} ${r.path} :: ${r.label}`);
  }

  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error('Smoke test failed:', error.message);
  process.exit(1);
});
