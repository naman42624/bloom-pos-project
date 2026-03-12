# Mutation Domain Suite Report — Procurement → Manufacturing

- Start: 2026-03-12T23:03:24.979Z
- End: 2026-03-12T23:03:27.458Z
- Base URL: http://localhost:3001
- Steps: 24
- Passed: 24
- Failed: 0

## Chain Covered
- Supplier create + material pricing link
- Purchase order create → partial receive → full receive
- Material stock delta validation vs received quantities
- Product BOM create + pickup sale create (task generation)
- Production task pick → start → complete
- Sale status transition validation and post-completion checks

## Created IDs
- supplier_id: 11
- category_id: 21
- material_id: 25
- purchase_order_id: 10
- product_id: 14
- sale_id: 46
- production_task_id: 45

## Strict Assertions
- PO total (expected): 120
- PO total (api create): 120
- Material stock before receive: 0
- Material stock after partial receive: 4
- Material stock after full receive: 10
- Material stock after production complete: 6
- Received qty total: 10
- BOM consumption expected: 4
- Sale status after create/start/complete: pending -> preparing -> ready

## Step Results
| # | Step | Endpoint | HTTP | Assertion | Result | Details |
|---:|---|---|---:|---|---|---|
| 1 | Owner login | POST /api/auth/login | 200 | Owner token acquired | PASS | Login successful |
| 2 | Resolve location | GET /api/auth/me | 200 | location_id=1 | PASS |  |
| 3 | Create category | POST /api/categories | 201 | Category created | PASS |  |
| 4 | Create material | POST /api/materials | 201 | Material created | PASS |  |
| 5 | Create supplier | POST /api/suppliers | 201 | Supplier created | PASS |  |
| 6 | Link supplier material | POST /api/suppliers/:id/materials | 200 | Material pricing linked | PASS | Material linked to supplier |
| 7 | Get stock baseline | GET /api/stock | 200 | baseline=0 | PASS |  |
| 8 | Create purchase order | POST /api/purchase-orders | 201 | PO total matches expected (120 === 120) | PASS |  |
| 9 | Get purchase order | GET /api/purchase-orders/:id | 200 | Initial PO status is expected | PASS | status=expected |
| 10 | Partial receive | POST /api/purchase-orders/:id/receive | 200 | PO transitions to partially_received | PASS | status=partially_received |
| 11 | Assert stock delta after partial | GET /api/stock | 200 | Stock delta equals partial receive qty (4 === 4) | PASS |  |
| 12 | Full receive | POST /api/purchase-orders/:id/receive | 200 | PO transitions to received | PASS | status=received |
| 13 | Assert PO total after full receive | POST /api/purchase-orders/:id/receive | 200 | PO total reconciles after receive (120 === 120) | PASS |  |
| 14 | Assert stock delta after full | GET /api/stock | 200 | Stock delta equals total received qty (10 === 10) | PASS |  |
| 15 | Create product with BOM | POST /api/products | 201 | Product and BOM created | PASS |  |
| 16 | Create pickup sale | POST /api/sales | 201 | Initial sale status is pending | PASS | status=pending |
| 17 | Assert task created pending | GET /api/production/tasks?sale_id=:id | 200 | Production task exists with pending status | PASS | task_status=pending |
| 18 | Pick task | PUT /api/production/tasks/:id/pick | 200 | Task transitions to assigned | PASS | status=assigned |
| 19 | Start task | PUT /api/production/tasks/:id/start | 200 | Task start accepted | PASS | Task started |
| 20 | Assert sale preparing after start | GET /api/sales/:id | 200 | Sale transitions to preparing after task start | PASS | status=preparing |
| 21 | Complete task | PUT /api/production/tasks/:id/complete | 200 | Task completion accepted | PASS | Task completed |
| 22 | Assert task completed | GET /api/production/tasks?sale_id=:id | 200 | Task status is completed | PASS | status=completed |
| 23 | Assert sale ready + stock_deducted | GET /api/sales/:id | 200 | Sale transitions to ready and stock_deducted=1 | PASS | status=ready, stock_deducted=1 |
| 24 | Assert BOM consumption delta | GET /api/stock | 200 | Material consumption equals BOM * produced qty (4 === 4) | PASS |  |