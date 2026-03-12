/* eslint-disable no-console */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.API_BASE_URL || 'http://localhost:3001';
const OWNER_PHONE = process.env.SMOKE_OWNER_PHONE || '9876453210';
const OWNER_PASSWORD = process.env.SMOKE_OWNER_PASSWORD || 'naman1234';

function tsTag() {
  const now = new Date();
  const pad = (v) => String(v).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
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

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function expectStatus(stepName, result, expectedStatuses) {
  if (!expectedStatuses.includes(result.status)) {
    const msg = result?.payload?.message || JSON.stringify(result?.payload || {});
    throw new Error(`${stepName} failed: expected ${expectedStatuses.join('/')} got ${result.status} :: ${msg}`);
  }
}

function record(steps, name, endpoint, result, assertion) {
  steps.push({
    name,
    endpoint,
    status: result.status,
    success: result.status < 400 && assertion.ok,
    assertion: assertion.text,
    assertionOk: assertion.ok,
    details: assertion.details || result?.payload?.message || '',
  });
}

function writeReport({ startedAt, endedAt, steps, ids, checks }) {
  const reportPath = path.join(__dirname, '..', 'MUTATION_DOMAIN_CHAIN_REPORT.md');
  const total = steps.length;
  const passed = steps.filter((s) => s.success).length;
  const failed = total - passed;

  const lines = [];
  lines.push('# Mutation Domain Suite Report — Procurement → Manufacturing');
  lines.push('');
  lines.push(`- Start: ${startedAt.toISOString()}`);
  lines.push(`- End: ${endedAt.toISOString()}`);
  lines.push(`- Base URL: ${BASE_URL}`);
  lines.push(`- Steps: ${total}`);
  lines.push(`- Passed: ${passed}`);
  lines.push(`- Failed: ${failed}`);
  lines.push('');

  lines.push('## Chain Covered');
  lines.push('- Supplier create + material pricing link');
  lines.push('- Purchase order create → partial receive → full receive');
  lines.push('- Material stock delta validation vs received quantities');
  lines.push('- Product BOM create + pickup sale create (task generation)');
  lines.push('- Production task pick → start → complete');
  lines.push('- Sale status transition validation and post-completion checks');
  lines.push('');

  lines.push('## Created IDs');
  lines.push(`- supplier_id: ${ids.supplierId}`);
  lines.push(`- category_id: ${ids.categoryId}`);
  lines.push(`- material_id: ${ids.materialId}`);
  lines.push(`- purchase_order_id: ${ids.purchaseOrderId}`);
  lines.push(`- product_id: ${ids.productId}`);
  lines.push(`- sale_id: ${ids.saleId}`);
  lines.push(`- production_task_id: ${ids.taskId}`);
  lines.push('');

  lines.push('## Strict Assertions');
  lines.push(`- PO total (expected): ${checks.poExpectedTotal}`);
  lines.push(`- PO total (api create): ${checks.poCreateTotal}`);
  lines.push(`- Material stock before receive: ${checks.stockBefore}`);
  lines.push(`- Material stock after partial receive: ${checks.stockAfterPartial}`);
  lines.push(`- Material stock after full receive: ${checks.stockAfterFull}`);
  lines.push(`- Material stock after production complete: ${checks.stockAfterComplete}`);
  lines.push(`- Received qty total: ${checks.receivedTotal}`);
  lines.push(`- BOM consumption expected: ${checks.expectedBomConsumption}`);
  lines.push(`- Sale status after create/start/complete: ${checks.saleStatusTimeline.join(' -> ')}`);
  lines.push('');

  lines.push('## Step Results');
  lines.push('| # | Step | Endpoint | HTTP | Assertion | Result | Details |');
  lines.push('|---:|---|---|---:|---|---|---|');
  steps.forEach((s, i) => {
    lines.push(`| ${i + 1} | ${s.name} | ${s.endpoint} | ${s.status} | ${String(s.assertion).replace(/\|/g, '\\|')} | ${s.success ? 'PASS' : 'FAIL'} | ${String(s.details || '').replace(/\|/g, '\\|')} |`);
  });

  fs.writeFileSync(reportPath, lines.join('\n'));
  return reportPath;
}

async function main() {
  const startedAt = new Date();
  const tag = tsTag();
  const steps = [];
  const ids = {};

  const checks = {
    poExpectedTotal: 0,
    poCreateTotal: 0,
    stockBefore: 0,
    stockAfterPartial: 0,
    stockAfterFull: 0,
    stockAfterComplete: 0,
    receivedTotal: 0,
    expectedBomConsumption: 0,
    saleStatusTimeline: [],
  };

  // 1) Owner login
  const loginRes = await http('POST', '/api/auth/login', null, {
    phone: OWNER_PHONE,
    password: OWNER_PASSWORD,
  });
  expectStatus('Owner login', loginRes, [200]);
  const token = loginRes?.payload?.data?.token;
  assertCondition(!!token, 'Token missing from login response');
  record(steps, 'Owner login', 'POST /api/auth/login', loginRes, { ok: true, text: 'Owner token acquired' });

  // 2) Resolve location
  const meRes = await http('GET', '/api/auth/me', token);
  expectStatus('Get auth me', meRes, [200]);
  const locationId = meRes?.payload?.data?.locations?.[0]?.id;
  assertCondition(!!locationId, 'No assigned location for owner');
  record(steps, 'Resolve location', 'GET /api/auth/me', meRes, { ok: true, text: `location_id=${locationId}` });

  // 3) Create category and material
  const categoryRes = await http('POST', '/api/categories', token, {
    name: `DomainCat ${tag}`,
    unit: 'pieces',
    has_bundle: 0,
    default_bundle_size: 1,
    is_perishable: 0,
    default_storage: 'shop',
  });
  expectStatus('Create category', categoryRes, [201]);
  ids.categoryId = categoryRes?.payload?.data?.id;
  assertCondition(!!ids.categoryId, 'category_id missing');
  record(steps, 'Create category', 'POST /api/categories', categoryRes, { ok: true, text: 'Category created' });

  const materialRes = await http('POST', '/api/materials', token, {
    category_id: ids.categoryId,
    name: `DomainMat ${tag}`,
    min_stock_alert: 2,
    selling_price: 20,
  });
  expectStatus('Create material', materialRes, [201]);
  ids.materialId = materialRes?.payload?.data?.id;
  assertCondition(!!ids.materialId, 'material_id missing');
  record(steps, 'Create material', 'POST /api/materials', materialRes, { ok: true, text: 'Material created' });

  // 4) Create supplier + link material pricing
  const supplierRes = await http('POST', '/api/suppliers', token, {
    name: `Domain Supplier ${tag}`,
    phone: `9${String(Date.now()).slice(-9)}`,
  });
  expectStatus('Create supplier', supplierRes, [201]);
  ids.supplierId = supplierRes?.payload?.data?.id;
  assertCondition(!!ids.supplierId, 'supplier_id missing');
  record(steps, 'Create supplier', 'POST /api/suppliers', supplierRes, { ok: true, text: 'Supplier created' });

  const linkRes = await http('POST', `/api/suppliers/${ids.supplierId}/materials`, token, {
    material_id: ids.materialId,
    default_price_per_unit: 12,
  });
  expectStatus('Link supplier material', linkRes, [200]);
  record(steps, 'Link supplier material', 'POST /api/suppliers/:id/materials', linkRes, { ok: true, text: 'Material pricing linked' });

  // 5) Stock baseline
  const stockBeforeRes = await http('GET', `/api/stock?location_id=${locationId}&material_id=${ids.materialId}`, token);
  expectStatus('Get stock baseline', stockBeforeRes, [200]);
  checks.stockBefore = toNum(stockBeforeRes?.payload?.data?.[0]?.quantity || 0);
  record(steps, 'Get stock baseline', 'GET /api/stock', stockBeforeRes, { ok: true, text: `baseline=${checks.stockBefore}` });

  // 6) Create purchase order with strict expected total
  const expectedQty = 10;
  const expectedPrice = 12;
  checks.poExpectedTotal = expectedQty * expectedPrice;

  const poRes = await http('POST', '/api/purchase-orders', token, {
    supplier_id: ids.supplierId,
    location_id: locationId,
    notes: 'Domain suite PO',
    items: [
      {
        material_id: ids.materialId,
        expected_quantity: expectedQty,
        expected_price_per_unit: expectedPrice,
      },
    ],
  });
  expectStatus('Create purchase order', poRes, [201]);
  ids.purchaseOrderId = poRes?.payload?.data?.id;
  assertCondition(!!ids.purchaseOrderId, 'purchase_order_id missing');

  checks.poCreateTotal = toNum(poRes?.payload?.data?.total_amount);
  const poTotalOk = checks.poCreateTotal === checks.poExpectedTotal;
  record(steps, 'Create purchase order', 'POST /api/purchase-orders', poRes, {
    ok: poTotalOk,
    text: `PO total matches expected (${checks.poCreateTotal} === ${checks.poExpectedTotal})`,
    details: poTotalOk ? '' : `Mismatch create total=${checks.poCreateTotal}, expected=${checks.poExpectedTotal}`,
  });
  assertCondition(poTotalOk, 'PO total mismatch at create');

  const poGetRes = await http('GET', `/api/purchase-orders/${ids.purchaseOrderId}`, token);
  expectStatus('Get purchase order', poGetRes, [200]);
  const poItemId = poGetRes?.payload?.data?.items?.[0]?.id;
  assertCondition(!!poItemId, 'PO item id missing');
  const poStatusInitial = poGetRes?.payload?.data?.status;
  record(steps, 'Get purchase order', 'GET /api/purchase-orders/:id', poGetRes, {
    ok: poStatusInitial === 'expected',
    text: 'Initial PO status is expected',
    details: `status=${poStatusInitial}`,
  });
  assertCondition(poStatusInitial === 'expected', `Unexpected initial PO status: ${poStatusInitial}`);

  // 7) Partial receive and assert status + stock delta
  const partialQty = 4;
  const receivePartialRes = await http('POST', `/api/purchase-orders/${ids.purchaseOrderId}/receive`, token, {
    items: [{ item_id: poItemId, received_quantity: partialQty, received_quality: 'good', actual_price_per_unit: expectedPrice }],
  });
  expectStatus('Receive PO partial', receivePartialRes, [200]);
  const poStatusAfterPartial = receivePartialRes?.payload?.data?.status;
  const partialStatusOk = poStatusAfterPartial === 'partially_received';
  record(steps, 'Partial receive', 'POST /api/purchase-orders/:id/receive', receivePartialRes, {
    ok: partialStatusOk,
    text: 'PO transitions to partially_received',
    details: `status=${poStatusAfterPartial}`,
  });
  assertCondition(partialStatusOk, `PO status after partial receive is ${poStatusAfterPartial}`);

  const stockAfterPartialRes = await http('GET', `/api/stock?location_id=${locationId}&material_id=${ids.materialId}`, token);
  expectStatus('Get stock after partial', stockAfterPartialRes, [200]);
  checks.stockAfterPartial = toNum(stockAfterPartialRes?.payload?.data?.[0]?.quantity || 0);
  const partialDeltaOk = checks.stockAfterPartial - checks.stockBefore === partialQty;
  record(steps, 'Assert stock delta after partial', 'GET /api/stock', stockAfterPartialRes, {
    ok: partialDeltaOk,
    text: `Stock delta equals partial receive qty (${checks.stockAfterPartial - checks.stockBefore} === ${partialQty})`,
  });
  assertCondition(partialDeltaOk, 'Stock delta mismatch after partial receive');

  // 8) Full receive remaining and assert status + stock delta + total reconciliation
  const remainingQty = expectedQty - partialQty;
  const receiveFullRes = await http('POST', `/api/purchase-orders/${ids.purchaseOrderId}/receive`, token, {
    items: [{ item_id: poItemId, received_quantity: remainingQty, received_quality: 'good', actual_price_per_unit: expectedPrice }],
  });
  expectStatus('Receive PO full', receiveFullRes, [200]);
  const poStatusAfterFull = receiveFullRes?.payload?.data?.status;
  const fullStatusOk = poStatusAfterFull === 'received';
  record(steps, 'Full receive', 'POST /api/purchase-orders/:id/receive', receiveFullRes, {
    ok: fullStatusOk,
    text: 'PO transitions to received',
    details: `status=${poStatusAfterFull}`,
  });
  assertCondition(fullStatusOk, `PO status after full receive is ${poStatusAfterFull}`);

  const poTotalAfterFull = toNum(receiveFullRes?.payload?.data?.total_amount);
  checks.receivedTotal = expectedQty;
  const totalAfterFullOk = poTotalAfterFull === checks.poExpectedTotal;
  record(steps, 'Assert PO total after full receive', 'POST /api/purchase-orders/:id/receive', receiveFullRes, {
    ok: totalAfterFullOk,
    text: `PO total reconciles after receive (${poTotalAfterFull} === ${checks.poExpectedTotal})`,
  });
  assertCondition(totalAfterFullOk, 'PO total mismatch after full receive');

  const stockAfterFullRes = await http('GET', `/api/stock?location_id=${locationId}&material_id=${ids.materialId}`, token);
  expectStatus('Get stock after full', stockAfterFullRes, [200]);
  checks.stockAfterFull = toNum(stockAfterFullRes?.payload?.data?.[0]?.quantity || 0);
  const fullDeltaOk = checks.stockAfterFull - checks.stockBefore === expectedQty;
  record(steps, 'Assert stock delta after full', 'GET /api/stock', stockAfterFullRes, {
    ok: fullDeltaOk,
    text: `Stock delta equals total received qty (${checks.stockAfterFull - checks.stockBefore} === ${expectedQty})`,
  });
  assertCondition(fullDeltaOk, 'Stock delta mismatch after full receive');

  // 9) Create product with BOM using the material
  const bomPerUnit = 2;
  const produceQtyForSale = 2;
  checks.expectedBomConsumption = bomPerUnit * produceQtyForSale;

  const productRes = await http('POST', '/api/products', token, {
    name: `DomainProduct ${tag}`,
    type: 'standard',
    category: 'other',
    selling_price: 150,
    location_id: locationId,
    materials: [
      {
        material_id: ids.materialId,
        quantity: bomPerUnit,
        cost_per_unit: expectedPrice,
      },
    ],
  });
  expectStatus('Create product', productRes, [201]);
  ids.productId = productRes?.payload?.data?.id;
  assertCondition(!!ids.productId, 'product_id missing');
  record(steps, 'Create product with BOM', 'POST /api/products', productRes, {
    ok: true,
    text: 'Product and BOM created',
  });

  // 10) Create pickup sale => should create production task
  const saleRes = await http('POST', '/api/sales', token, {
    location_id: locationId,
    order_type: 'pickup',
    customer_name: `Domain Customer ${tag}`,
    customer_phone: `9${String(Date.now()).slice(-9)}`,
    items: [{ product_id: ids.productId, quantity: produceQtyForSale, unit_price: 150 }],
    payments: [{ method: 'cash', amount: 50 }],
    notes: 'Domain suite sale for production task flow',
  });
  expectStatus('Create pickup sale', saleRes, [201]);
  ids.saleId = saleRes?.payload?.data?.id;
  assertCondition(!!ids.saleId, 'sale_id missing');
  checks.saleStatusTimeline.push(saleRes?.payload?.data?.status || 'unknown');
  const initialSaleStatusOk = (saleRes?.payload?.data?.status === 'pending');
  record(steps, 'Create pickup sale', 'POST /api/sales', saleRes, {
    ok: initialSaleStatusOk,
    text: 'Initial sale status is pending',
    details: `status=${saleRes?.payload?.data?.status}`,
  });
  assertCondition(initialSaleStatusOk, `Unexpected sale initial status ${saleRes?.payload?.data?.status}`);

  const taskListRes = await http('GET', `/api/production/tasks?sale_id=${ids.saleId}`, token);
  expectStatus('Get production task', taskListRes, [200]);
  const task = taskListRes?.payload?.data?.[0];
  assertCondition(!!task?.id, 'production task not created for pickup sale');
  ids.taskId = task.id;
  const taskPendingOk = task.status === 'pending';
  record(steps, 'Assert task created pending', 'GET /api/production/tasks?sale_id=:id', taskListRes, {
    ok: taskPendingOk,
    text: 'Production task exists with pending status',
    details: `task_status=${task.status}`,
  });
  assertCondition(taskPendingOk, `Unexpected initial task status ${task.status}`);

  // 11) Pick -> Start -> Complete task and assert transitions
  const pickRes = await http('PUT', `/api/production/tasks/${ids.taskId}/pick`, token);
  expectStatus('Pick task', pickRes, [200]);
  record(steps, 'Pick task', 'PUT /api/production/tasks/:id/pick', pickRes, {
    ok: pickRes?.payload?.data?.status === 'assigned',
    text: 'Task transitions to assigned',
    details: `status=${pickRes?.payload?.data?.status}`,
  });
  assertCondition(pickRes?.payload?.data?.status === 'assigned', 'Task did not transition to assigned');

  const startRes = await http('PUT', `/api/production/tasks/${ids.taskId}/start`, token);
  expectStatus('Start task', startRes, [200]);
  record(steps, 'Start task', 'PUT /api/production/tasks/:id/start', startRes, {
    ok: true,
    text: 'Task start accepted',
  });

  const saleAfterStartRes = await http('GET', `/api/sales/${ids.saleId}`, token);
  expectStatus('Get sale after start', saleAfterStartRes, [200]);
  const saleStatusAfterStart = saleAfterStartRes?.payload?.data?.status;
  checks.saleStatusTimeline.push(saleStatusAfterStart || 'unknown');
  const preparingOk = saleStatusAfterStart === 'preparing';
  record(steps, 'Assert sale preparing after start', 'GET /api/sales/:id', saleAfterStartRes, {
    ok: preparingOk,
    text: 'Sale transitions to preparing after task start',
    details: `status=${saleStatusAfterStart}`,
  });
  assertCondition(preparingOk, `Sale did not transition to preparing, got ${saleStatusAfterStart}`);

  const completeRes = await http('PUT', `/api/production/tasks/${ids.taskId}/complete`, token);
  expectStatus('Complete task', completeRes, [200]);
  record(steps, 'Complete task', 'PUT /api/production/tasks/:id/complete', completeRes, {
    ok: true,
    text: 'Task completion accepted',
  });

  const taskAfterCompleteRes = await http('GET', `/api/production/tasks?sale_id=${ids.saleId}`, token);
  expectStatus('Get task after complete', taskAfterCompleteRes, [200]);
  const completedTask = taskAfterCompleteRes?.payload?.data?.find((t) => t.id === ids.taskId);
  const completedTaskOk = completedTask?.status === 'completed';
  record(steps, 'Assert task completed', 'GET /api/production/tasks?sale_id=:id', taskAfterCompleteRes, {
    ok: completedTaskOk,
    text: 'Task status is completed',
    details: `status=${completedTask?.status}`,
  });
  assertCondition(completedTaskOk, `Task status not completed: ${completedTask?.status}`);

  const saleAfterCompleteRes = await http('GET', `/api/sales/${ids.saleId}`, token);
  expectStatus('Get sale after complete', saleAfterCompleteRes, [200]);
  const saleStatusAfterComplete = saleAfterCompleteRes?.payload?.data?.status;
  checks.saleStatusTimeline.push(saleStatusAfterComplete || 'unknown');
  const readyOk = saleStatusAfterComplete === 'ready';
  const stockDeductedOk = toNum(saleAfterCompleteRes?.payload?.data?.stock_deducted) === 1;
  record(steps, 'Assert sale ready + stock_deducted', 'GET /api/sales/:id', saleAfterCompleteRes, {
    ok: readyOk && stockDeductedOk,
    text: 'Sale transitions to ready and stock_deducted=1',
    details: `status=${saleStatusAfterComplete}, stock_deducted=${saleAfterCompleteRes?.payload?.data?.stock_deducted}`,
  });
  assertCondition(readyOk && stockDeductedOk, 'Sale status/stock_deducted assertion failed after task completion');

  // 12) Strict material consumption assertion from production completion
  const stockAfterCompleteRes = await http('GET', `/api/stock?location_id=${locationId}&material_id=${ids.materialId}`, token);
  expectStatus('Get stock after complete', stockAfterCompleteRes, [200]);
  checks.stockAfterComplete = toNum(stockAfterCompleteRes?.payload?.data?.[0]?.quantity || 0);
  const consumptionOk = checks.stockAfterFull - checks.stockAfterComplete === checks.expectedBomConsumption;
  record(steps, 'Assert BOM consumption delta', 'GET /api/stock', stockAfterCompleteRes, {
    ok: consumptionOk,
    text: `Material consumption equals BOM * produced qty (${checks.stockAfterFull - checks.stockAfterComplete} === ${checks.expectedBomConsumption})`,
  });
  assertCondition(consumptionOk, 'Material consumption delta mismatch');

  const endedAt = new Date();
  const reportPath = writeReport({ startedAt, endedAt, steps, ids, checks });

  console.log('\n=== Domain Procurement/Production Suite Summary ===');
  console.log(`Steps: ${steps.length}`);
  console.log(`Pass: ${steps.filter((s) => s.success).length}`);
  console.log(`Fail: ${steps.filter((s) => !s.success).length}`);
  console.log(`Report: ${reportPath}`);

  process.exit(0);
}

main().catch((err) => {
  console.error('Domain suite failed:', err.message);
  process.exit(1);
});
