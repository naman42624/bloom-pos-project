/* eslint-disable no-console */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.API_BASE_URL || 'http://localhost:3001';
const OWNER_PHONE = process.env.SMOKE_OWNER_PHONE || '9876453210';
const OWNER_PASSWORD = process.env.SMOKE_OWNER_PASSWORD || 'naman1234';

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function tsTag() {
  const now = new Date();
  const pad = (v) => String(v).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

async function http(method, endpoint, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  return { status: res.status, payload };
}

function expectStatus(stepName, result, expectedStatuses) {
  if (!expectedStatuses.includes(result.status)) {
    const message = result?.payload?.message || JSON.stringify(result.payload || {});
    throw new Error(`${stepName} failed: expected ${expectedStatuses.join('/')} got ${result.status} :: ${message}`);
  }
}

function markStep(steps, name, request, result, note) {
  steps.push({
    name,
    request,
    status: result.status,
    success: result.status < 400,
    note: note || result?.payload?.message || '',
  });
}

function writeReport({ steps, startedAt, endedAt, context }) {
  const reportPath = path.join(__dirname, '..', 'MUTATION_HAPPY_PATH_REPORT.md');
  const passed = steps.filter((s) => s.success).length;
  const failed = steps.length - passed;

  const lines = [];
  lines.push('# Mutation Happy-Path Chained Test Report');
  lines.push('');
  lines.push(`- Start: ${startedAt.toISOString()}`);
  lines.push(`- End: ${endedAt.toISOString()}`);
  lines.push(`- Base URL: ${BASE_URL}`);
  lines.push(`- Total steps: ${steps.length}`);
  lines.push(`- Passed (2xx/3xx): ${passed}`);
  lines.push(`- Failed (4xx/5xx/network): ${failed}`);
  lines.push('');

  lines.push('## Business Flow Covered');
  lines.push('- Owner authentication and location discovery/creation');
  lines.push('- Cash register pre-check, open, and close lifecycle');
  lines.push('- Category → material → product chain creation and BOM linking');
  lines.push('- Customer creation, update, address lifecycle, special-dates lifecycle');
  lines.push('- Expense creation and deletion');
  lines.push('- Sale creation (pickup), follow-up payment, cancellation');
  lines.push('- Notification token register/read/unregister flow');
  lines.push('');

  lines.push('## Created Entities');
  lines.push(`- location_id: ${context.locationId || 'N/A'}`);
  lines.push(`- category_id: ${context.categoryId || 'N/A'}`);
  lines.push(`- material_id: ${context.materialId || 'N/A'}`);
  lines.push(`- product_id: ${context.productId || 'N/A'}`);
  lines.push(`- customer_id: ${context.customerId || 'N/A'}`);
  lines.push(`- address_id: ${context.addressId || 'N/A'}`);
  lines.push(`- special_date_id: ${context.specialDateId || 'N/A'}`);
  lines.push(`- expense_id: ${context.expenseId || 'N/A'}`);
  lines.push(`- sale_id: ${context.saleId || 'N/A'}`);
  lines.push('');

  lines.push('## Step Results');
  lines.push('| # | Step | Request | Status | Result | Notes |');
  lines.push('|---:|---|---|---:|---|---|');
  steps.forEach((step, index) => {
    lines.push(`| ${index + 1} | ${step.name} | ${step.request} | ${step.status} | ${step.success ? 'PASS' : 'FAIL'} | ${String(step.note || '').replace(/\|/g, '\\|')} |`);
  });

  fs.writeFileSync(reportPath, lines.join('\n'));
  return reportPath;
}

async function main() {
  const startedAt = new Date();
  const steps = [];
  const context = {};
  const runTag = tsTag();

  // 1) Login owner
  const loginRes = await http('POST', '/api/auth/login', null, {
    phone: OWNER_PHONE,
    password: OWNER_PASSWORD,
  });
  expectStatus('Owner login', loginRes, [200]);
  markStep(steps, 'Owner login', 'POST /api/auth/login', loginRes, 'Token acquired');

  const token = loginRes.payload?.data?.token;
  const ownerId = loginRes.payload?.data?.user?.id;
  if (!token || !ownerId) {
    throw new Error('Owner login response missing token/user id');
  }

  // 2) Resolve location (use assigned location or create one)
  const meRes = await http('GET', '/api/auth/me', token);
  expectStatus('Fetch current user', meRes, [200]);
  markStep(steps, 'Fetch current user', 'GET /api/auth/me', meRes);

  const locations = meRes.payload?.data?.locations || [];
  let locationId = locations[0]?.id;
  let createdLocation = false;

  if (!locationId) {
    const locationRes = await http('POST', '/api/locations', token, {
      name: `HappyPath Shop ${runTag}`,
      type: 'shop',
      city: 'Test City',
      state: 'TS',
      geofence_radius: 50,
    });
    expectStatus('Create location', locationRes, [201]);
    markStep(steps, 'Create location', 'POST /api/locations', locationRes);
    locationId = locationRes.payload?.data?.location?.id;
    createdLocation = true;
  } else {
    markStep(
      steps,
      'Use existing location',
      'GET /api/auth/me (locations[0])',
      { status: 200, payload: { message: 'Using first assigned location' } },
      `location_id=${locationId}`
    );
  }

  if (!locationId) throw new Error('No location available for happy-path run');
  context.locationId = locationId;

  // 3) Ensure no open register, then open one for this run
  const regStatusBefore = await http('GET', `/api/sales/register/status?location_id=${locationId}`, token);
  expectStatus('Register status before run', regStatusBefore, [200]);
  markStep(steps, 'Register status before run', 'GET /api/sales/register/status', regStatusBefore);

  if (regStatusBefore.payload?.isOpen && regStatusBefore.payload?.data?.id) {
    const preCloseRes = await http('PUT', '/api/sales/register/close', token, {
      location_id: locationId,
      actual_cash: Number(regStatusBefore.payload?.data?.expected_cash || 0),
      closing_notes: `Pre-close by happy-path ${runTag}`,
    });
    expectStatus('Pre-close existing register', preCloseRes, [200]);
    markStep(steps, 'Pre-close existing register', 'PUT /api/sales/register/close', preCloseRes);
  }

  const openRegRes = await http('POST', '/api/sales/register/open', token, {
    location_id: locationId,
    opening_balance: 1000,
  });
  expectStatus('Open register', openRegRes, [201]);
  markStep(steps, 'Open register', 'POST /api/sales/register/open', openRegRes);

  // 4) Category -> Material -> Product chain
  const categoryRes = await http('POST', '/api/categories', token, {
    name: `HP Category ${runTag}`,
    unit: 'pieces',
    has_bundle: 0,
    default_bundle_size: 1,
    is_perishable: 0,
    default_storage: 'shop',
  });
  expectStatus('Create category', categoryRes, [201]);
  markStep(steps, 'Create category', 'POST /api/categories', categoryRes);
  context.categoryId = categoryRes.payload?.data?.id;

  const materialRes = await http('POST', '/api/materials', token, {
    category_id: context.categoryId,
    name: `HP Material ${runTag}`,
    min_stock_alert: 5,
    selling_price: 35,
  });
  expectStatus('Create material', materialRes, [201]);
  markStep(steps, 'Create material', 'POST /api/materials', materialRes);
  context.materialId = materialRes.payload?.data?.id;

  const productRes = await http('POST', '/api/products', token, {
    name: `HP Product ${runTag}`,
    type: 'standard',
    category: 'other',
    selling_price: 220,
    location_id: locationId,
  });
  expectStatus('Create product', productRes, [201]);
  markStep(steps, 'Create product', 'POST /api/products', productRes);
  context.productId = productRes.payload?.data?.id;

  const productMaterialLinkRes = await http('POST', `/api/products/${context.productId}/materials`, token, {
    material_id: context.materialId,
    quantity: 2,
    cost_per_unit: 20,
    notes: 'Happy-path material link',
  });
  expectStatus('Link product material', productMaterialLinkRes, [201]);
  markStep(steps, 'Link product material', 'POST /api/products/:id/materials', productMaterialLinkRes);

  const productMaterialUpdateRes = await http('PUT', `/api/products/${context.productId}/materials/${context.materialId}`, token, {
    quantity: 3,
    cost_per_unit: 22,
    notes: 'Updated by happy-path',
  });
  expectStatus('Update product material', productMaterialUpdateRes, [200]);
  markStep(steps, 'Update product material', 'PUT /api/products/:id/materials/:materialId', productMaterialUpdateRes);

  // 5) Customer flow: create/update/address/special-date
  const customerPhone = `9${String(Date.now()).slice(-9)}`;
  const customerRes = await http('POST', '/api/customers', token, {
    name: `HP Customer ${runTag}`,
    phone: customerPhone,
    notes: 'Created by happy-path suite',
  });
  expectStatus('Create customer', customerRes, [201]);
  markStep(steps, 'Create customer', 'POST /api/customers', customerRes);
  context.customerId = customerRes.payload?.data?.id;

  const customerUpdateRes = await http('PUT', `/api/customers/${context.customerId}`, token, {
    notes: 'Updated by happy-path suite',
  });
  expectStatus('Update customer', customerUpdateRes, [200]);
  markStep(steps, 'Update customer', 'PUT /api/customers/:id', customerUpdateRes);

  const addressRes = await http('POST', `/api/customers/${context.customerId}/addresses`, token, {
    label: 'Home',
    address_line_1: '123 Happy Street',
    city: 'Test City',
    state: 'TS',
    pincode: '123456',
    is_default: 1,
  });
  expectStatus('Add customer address', addressRes, [201]);
  markStep(steps, 'Add customer address', 'POST /api/customers/:id/addresses', addressRes);
  context.addressId = addressRes.payload?.data?.id;

  const addressUpdateRes = await http('PUT', `/api/customers/${context.customerId}/addresses/${context.addressId}`, token, {
    label: 'Primary Home',
    city: 'Updated City',
  });
  expectStatus('Update customer address', addressUpdateRes, [200]);
  markStep(steps, 'Update customer address', 'PUT /api/customers/:id/addresses/:addressId', addressUpdateRes);

  const specialDateRes = await http('POST', `/api/customers/${context.customerId}/special-dates`, token, {
    label: 'Anniversary',
    date: '2001-02-03',
  });
  expectStatus('Add special date', specialDateRes, [201]);
  markStep(steps, 'Add special date', 'POST /api/customers/:id/special-dates', specialDateRes);
  context.specialDateId = specialDateRes.payload?.data?.id;

  // 6) Expense create
  const expenseRes = await http('POST', '/api/expenses', token, {
    location_id: locationId,
    category: 'other',
    amount: 50,
    description: `HP expense ${runTag}`,
    payment_method: 'cash',
    expense_date: todayStr(),
  });
  expectStatus('Create expense', expenseRes, [201]);
  markStep(steps, 'Create expense', 'POST /api/expenses', expenseRes);
  context.expenseId = expenseRes.payload?.data?.id;

  // 7) Sale create -> payment -> cancel
  const saleRes = await http('POST', '/api/sales', token, {
    location_id: locationId,
    order_type: 'pickup',
    customer_id: context.customerId,
    customer_name: `HP Customer ${runTag}`,
    customer_phone: customerPhone,
    items: [
      {
        product_id: context.productId,
        quantity: 1,
        unit_price: 220,
      },
    ],
    payments: [
      {
        method: 'cash',
        amount: 100,
      },
    ],
    notes: 'Happy-path chained test sale',
  });
  expectStatus('Create sale', saleRes, [201]);
  markStep(steps, 'Create sale', 'POST /api/sales', saleRes);
  context.saleId = saleRes.payload?.data?.id;

  const extraPaymentRes = await http('POST', `/api/sales/${context.saleId}/payments`, token, {
    method: 'cash',
    amount: 120,
    reference_number: `HP-${runTag}`,
  });
  expectStatus('Add sale payment', extraPaymentRes, [201]);
  markStep(steps, 'Add sale payment', 'POST /api/sales/:id/payments', extraPaymentRes);

  const cancelSaleRes = await http('PUT', `/api/sales/${context.saleId}/cancel`, token);
  expectStatus('Cancel sale', cancelSaleRes, [200]);
  markStep(steps, 'Cancel sale', 'PUT /api/sales/:id/cancel', cancelSaleRes);

  // 8) Notifications flow
  const pushToken = `ExponentPushToken[happy-${runTag}]`;
  const registerTokenRes = await http('POST', '/api/notifications/register-token', token, {
    token: pushToken,
    platform: 'expo',
  });
  expectStatus('Register push token', registerTokenRes, [200]);
  markStep(steps, 'Register push token', 'POST /api/notifications/register-token', registerTokenRes);

  const listNotificationsRes = await http('GET', '/api/notifications?limit=20', token);
  expectStatus('List notifications', listNotificationsRes, [200]);
  markStep(steps, 'List notifications', 'GET /api/notifications', listNotificationsRes);

  const firstNotificationId = listNotificationsRes.payload?.data?.notifications?.[0]?.id;
  if (firstNotificationId) {
    const markReadRes = await http('PUT', `/api/notifications/${firstNotificationId}/read`, token);
    expectStatus('Mark one notification read', markReadRes, [200]);
    markStep(steps, 'Mark one notification read', 'PUT /api/notifications/:id/read', markReadRes);
  }

  const readAllRes = await http('PUT', '/api/notifications/read-all', token);
  expectStatus('Mark all notifications read', readAllRes, [200]);
  markStep(steps, 'Mark all notifications read', 'PUT /api/notifications/read-all', readAllRes);

  const unregisterTokenRes = await http('DELETE', '/api/notifications/unregister-token', token, {
    token: pushToken,
  });
  expectStatus('Unregister push token', unregisterTokenRes, [200]);
  markStep(steps, 'Unregister push token', 'DELETE /api/notifications/unregister-token', unregisterTokenRes);

  // 9) Cleanup chain
  const deleteExpenseRes = await http('DELETE', `/api/expenses/${context.expenseId}`, token);
  expectStatus('Delete expense', deleteExpenseRes, [200]);
  markStep(steps, 'Delete expense', 'DELETE /api/expenses/:id', deleteExpenseRes);

  const deleteSpecialDateRes = await http('DELETE', `/api/customers/${context.customerId}/special-dates/${context.specialDateId}`, token);
  expectStatus('Delete special date', deleteSpecialDateRes, [200]);
  markStep(steps, 'Delete special date', 'DELETE /api/customers/:id/special-dates/:dateId', deleteSpecialDateRes);

  const deleteAddressRes = await http('DELETE', `/api/customers/${context.customerId}/addresses/${context.addressId}`, token);
  expectStatus('Delete customer address', deleteAddressRes, [200]);
  markStep(steps, 'Delete customer address', 'DELETE /api/customers/:id/addresses/:addressId', deleteAddressRes);

  const unlinkMaterialRes = await http('DELETE', `/api/products/${context.productId}/materials/${context.materialId}`, token);
  expectStatus('Unlink product material', unlinkMaterialRes, [200]);
  markStep(steps, 'Unlink product material', 'DELETE /api/products/:id/materials/:materialId', unlinkMaterialRes);

  const deleteProductRes = await http('DELETE', `/api/products/${context.productId}`, token);
  expectStatus('Deactivate product', deleteProductRes, [200]);
  markStep(steps, 'Deactivate product', 'DELETE /api/products/:id', deleteProductRes);

  const deleteMaterialRes = await http('DELETE', `/api/materials/${context.materialId}`, token);
  expectStatus('Deactivate material', deleteMaterialRes, [200]);
  markStep(steps, 'Deactivate material', 'DELETE /api/materials/:id', deleteMaterialRes);

  const deleteCategoryRes = await http('DELETE', `/api/categories/${context.categoryId}`, token);
  expectStatus('Deactivate category', deleteCategoryRes, [200]);
  markStep(steps, 'Deactivate category', 'DELETE /api/categories/:id', deleteCategoryRes);

  const regStatusBeforeClose = await http('GET', `/api/sales/register/status?location_id=${locationId}`, token);
  expectStatus('Register status before close', regStatusBeforeClose, [200]);
  markStep(steps, 'Register status before close', 'GET /api/sales/register/status', regStatusBeforeClose);

  const closeRegRes = await http('PUT', '/api/sales/register/close', token, {
    location_id: locationId,
    actual_cash: Number(regStatusBeforeClose.payload?.data?.expected_cash || 0),
    closing_notes: `Closed by happy-path ${runTag}`,
  });
  expectStatus('Close register', closeRegRes, [200]);
  markStep(steps, 'Close register', 'PUT /api/sales/register/close', closeRegRes);

  if (createdLocation) {
    const deactivateLocationRes = await http('PUT', `/api/locations/${locationId}`, token, { is_active: 0 });
    expectStatus('Deactivate created location', deactivateLocationRes, [200]);
    markStep(steps, 'Deactivate created location', 'PUT /api/locations/:id', deactivateLocationRes);
  }

  const endedAt = new Date();
  const reportPath = writeReport({ steps, startedAt, endedAt, context });

  console.log('\n=== Happy-Path Mutation Summary ===');
  console.log(`Steps: ${steps.length}`);
  console.log(`Pass: ${steps.filter((s) => s.success).length}`);
  console.log(`Fail: ${steps.filter((s) => !s.success).length}`);
  console.log(`Report: ${reportPath}`);

  process.exit(0);
}

main().catch((error) => {
  console.error('Happy-path mutation run failed:', error.message);
  process.exit(1);
});
