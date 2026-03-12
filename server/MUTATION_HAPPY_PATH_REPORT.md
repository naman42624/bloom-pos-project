# Mutation Happy-Path Chained Test Report

- Start: 2026-03-12T23:03:19.091Z
- End: 2026-03-12T23:03:22.074Z
- Base URL: http://localhost:3001
- Total steps: 33
- Passed (2xx/3xx): 33
- Failed (4xx/5xx/network): 0

## Business Flow Covered
- Owner authentication and location discovery/creation
- Cash register pre-check, open, and close lifecycle
- Category → material → product chain creation and BOM linking
- Customer creation, update, address lifecycle, special-dates lifecycle
- Expense creation and deletion
- Sale creation (pickup), follow-up payment, cancellation
- Notification token register/read/unregister flow

## Created Entities
- location_id: 1
- category_id: 20
- material_id: 24
- product_id: 13
- customer_id: 26
- address_id: 10
- special_date_id: 7
- expense_id: 8
- sale_id: 45

## Step Results
| # | Step | Request | Status | Result | Notes |
|---:|---|---|---:|---|---|
| 1 | Owner login | POST /api/auth/login | 200 | PASS | Token acquired |
| 2 | Fetch current user | GET /api/auth/me | 200 | PASS |  |
| 3 | Use existing location | GET /api/auth/me (locations[0]) | 200 | PASS | location_id=1 |
| 4 | Register status before run | GET /api/sales/register/status | 200 | PASS |  |
| 5 | Open register | POST /api/sales/register/open | 201 | PASS |  |
| 6 | Create category | POST /api/categories | 201 | PASS |  |
| 7 | Create material | POST /api/materials | 201 | PASS |  |
| 8 | Create product | POST /api/products | 201 | PASS |  |
| 9 | Link product material | POST /api/products/:id/materials | 201 | PASS |  |
| 10 | Update product material | PUT /api/products/:id/materials/:materialId | 200 | PASS |  |
| 11 | Create customer | POST /api/customers | 201 | PASS |  |
| 12 | Update customer | PUT /api/customers/:id | 200 | PASS |  |
| 13 | Add customer address | POST /api/customers/:id/addresses | 201 | PASS |  |
| 14 | Update customer address | PUT /api/customers/:id/addresses/:addressId | 200 | PASS |  |
| 15 | Add special date | POST /api/customers/:id/special-dates | 201 | PASS |  |
| 16 | Create expense | POST /api/expenses | 201 | PASS |  |
| 17 | Create sale | POST /api/sales | 201 | PASS |  |
| 18 | Add sale payment | POST /api/sales/:id/payments | 201 | PASS |  |
| 19 | Cancel sale | PUT /api/sales/:id/cancel | 200 | PASS | Sale cancelled and stock handled |
| 20 | Register push token | POST /api/notifications/register-token | 200 | PASS |  |
| 21 | List notifications | GET /api/notifications | 200 | PASS |  |
| 22 | Mark one notification read | PUT /api/notifications/:id/read | 200 | PASS |  |
| 23 | Mark all notifications read | PUT /api/notifications/read-all | 200 | PASS |  |
| 24 | Unregister push token | DELETE /api/notifications/unregister-token | 200 | PASS |  |
| 25 | Delete expense | DELETE /api/expenses/:id | 200 | PASS | Expense deleted |
| 26 | Delete special date | DELETE /api/customers/:id/special-dates/:dateId | 200 | PASS | Special date removed |
| 27 | Delete customer address | DELETE /api/customers/:id/addresses/:addressId | 200 | PASS | Address deleted |
| 28 | Unlink product material | DELETE /api/products/:id/materials/:materialId | 200 | PASS | Material removed |
| 29 | Deactivate product | DELETE /api/products/:id | 200 | PASS | Product deactivated |
| 30 | Deactivate material | DELETE /api/materials/:id | 200 | PASS | Material deactivated |
| 31 | Deactivate category | DELETE /api/categories/:id | 200 | PASS | Category deactivated |
| 32 | Register status before close | GET /api/sales/register/status | 200 | PASS |  |
| 33 | Close register | PUT /api/sales/register/close | 200 | PASS |  |