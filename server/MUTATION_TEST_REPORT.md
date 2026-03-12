# Mutation Regression Test Report

- Start: 2026-03-12T23:03:12.818Z
- End: 2026-03-12T23:03:16.645Z
- Base URL: http://localhost:3001
- Total mutation endpoints tested: 105
- Passed (non-5xx): 105
- Failed (5xx/network): 0
- Status histogram: {"200":8,"201":2,"400":48,"403":9,"404":38}

## Coverage Strategy
- Enumerated all router mutation handlers (`POST`, `PUT`, `DELETE`, `PATCH`) from `server/routes/*.js`.
- Replaced path params with safe non-destructive IDs to avoid deleting live records.
- Ran each endpoint with auth (except public auth endpoints) and minimal payload or endpoint-specific payload override.
- Treated all 2xx/3xx/4xx as pass for regression safety; only 5xx/network counted as failures.

## Failures
- None. No mutation endpoint returned 5xx/network failure in this run.

## Endpoint Results
| Method | Endpoint | Tested Path | Status | File | Notes |
|---|---|---|---:|---|---|
| POST | /api/attendance/clock-in | /api/attendance/clock-in | 403 | attendance.js | You do not have permission to perform this action. |
| POST | /api/attendance/clock-out | /api/attendance/clock-out | 403 | attendance.js | You do not have permission to perform this action. |
| POST | /api/attendance/outdoor-duty | /api/attendance/outdoor-duty | 400 | attendance.js | Reason is required. |
| POST | /api/attendance/salary-advance | /api/attendance/salary-advance | 400 | attendance.js | Valid amount is required. |
| PUT | /api/attendance/outdoor-duty/:id/approve | /api/attendance/outdoor-duty/999999/approve | 404 | attendance.js | Request not found. |
| PUT | /api/attendance/outdoor-duty/:id/complete | /api/attendance/outdoor-duty/999999/complete | 404 | attendance.js | Request not found. |
| PUT | /api/attendance/outdoor-duty/:id/reject | /api/attendance/outdoor-duty/999999/reject | 404 | attendance.js | Request not found. |
| PUT | /api/attendance/salary-advance/:id/:action | /api/attendance/salary-advance/999999/approve | 404 | attendance.js | Advance not found. |
| PUT | /api/attendance/salary-advance/:id/repay | /api/attendance/salary-advance/999999/repay | 404 | attendance.js | Advance not found. |
| POST | /api/auth/login | /api/auth/login | 200 | auth.js | Login successful |
| POST | /api/auth/register | /api/auth/register | 201 | auth.js | Account created successfully |
| POST | /api/auth/setup | /api/auth/setup | 400 | auth.js | Validation failed |
| PUT | /api/auth/password | /api/auth/password | 400 | auth.js | Validation failed |
| PUT | /api/auth/profile | /api/auth/profile | 200 | auth.js | Profile updated successfully |
| DELETE | /api/categories/:id | /api/categories/999999 | 404 | categories.js | Category not found |
| POST | /api/categories/ | /api/categories/ | 400 | categories.js | Validation failed |
| PUT | /api/categories/:id | /api/categories/999999 | 404 | categories.js | Category not found |
| DELETE | /api/customers/:id/addresses/:addressId | /api/customers/999999/addresses/999999 | 404 | customers.js | Address not found |
| DELETE | /api/customers/:id/special-dates/:dateId | /api/customers/999999/special-dates/999999 | 404 | customers.js | Special date not found |
| POST | /api/customers/ | /api/customers/ | 400 | customers.js | Validation failed |
| POST | /api/customers/:id/addresses | /api/customers/999999/addresses | 400 | customers.js | Validation failed |
| POST | /api/customers/:id/credits | /api/customers/999999/credits | 400 | customers.js | Validation failed |
| POST | /api/customers/:id/special-dates | /api/customers/999999/special-dates | 400 | customers.js | Validation failed |
| PUT | /api/customers/:id | /api/customers/999999 | 404 | customers.js | Customer not found |
| PUT | /api/customers/:id/addresses/:addressId | /api/customers/999999/addresses/999999 | 404 | customers.js | Address not found |
| POST | /api/deliveries/:id(\\d+)/proof | /api/deliveries/999999/proof | 403 | deliveries.js | You do not have permission to perform this action. |
| POST | /api/deliveries/batch-assign | /api/deliveries/batch-assign | 400 | deliveries.js | delivery_ids array required. |
| POST | /api/deliveries/settlements | /api/deliveries/settlements | 400 | deliveries.js | Validation failed |
| PUT | /api/deliveries/:id(\\d+)/assign | /api/deliveries/999999/assign | 400 | deliveries.js | Validation failed |
| PUT | /api/deliveries/:id(\\d+)/deliver | /api/deliveries/999999/deliver | 403 | deliveries.js | You do not have permission to perform this action. |
| PUT | /api/deliveries/:id(\\d+)/fail | /api/deliveries/999999/fail | 403 | deliveries.js | You do not have permission to perform this action. |
| PUT | /api/deliveries/:id(\\d+)/in-transit | /api/deliveries/999999/in-transit | 403 | deliveries.js | You do not have permission to perform this action. |
| PUT | /api/deliveries/:id(\\d+)/pickup | /api/deliveries/999999/pickup | 403 | deliveries.js | You do not have permission to perform this action. |
| PUT | /api/deliveries/pickup/:saleId/picked-up | /api/deliveries/pickup/999999/picked-up | 404 | deliveries.js | Pickup order not found |
| PUT | /api/deliveries/pickup/:saleId/ready | /api/deliveries/pickup/999999/ready | 404 | deliveries.js | Pickup order not found |
| PUT | /api/deliveries/settlements/:id(\\d+)/verify | /api/deliveries/settlements/999999/verify | 404 | deliveries.js | Settlement not found |
| POST | /api/delivery-tracking/location | /api/delivery-tracking/location | 403 | delivery-tracking.js | You do not have permission to perform this action. |
| DELETE | /api/expenses/:id | /api/expenses/999999 | 404 | expenses.js | Expense not found |
| POST | /api/expenses/ | /api/expenses/ | 400 | expenses.js | Validation failed |
| POST | /api/locations/ | /api/locations/ | 400 | locations.js | Validation failed |
| POST | /api/locations/:id/assign | /api/locations/999999/assign | 400 | locations.js |  |
| POST | /api/locations/:id/unassign | /api/locations/999999/unassign | 400 | locations.js |  |
| PUT | /api/locations/:id | /api/locations/999999 | 404 | locations.js | Location not found |
| DELETE | /api/materials/:id | /api/materials/999999 | 404 | materials.js | Material not found |
| POST | /api/materials/ | /api/materials/ | 400 | materials.js | Validation failed |
| POST | /api/materials/:id/image | /api/materials/999999/image | 404 | materials.js | Material not found |
| PUT | /api/materials/:id | /api/materials/999999 | 404 | materials.js | Material not found |
| DELETE | /api/notifications/unregister-token | /api/notifications/unregister-token | 200 | notifications.js |  |
| POST | /api/notifications/register-token | /api/notifications/register-token | 200 | notifications.js |  |
| PUT | /api/notifications/:id/read | /api/notifications/999999/read | 200 | notifications.js |  |
| PUT | /api/notifications/read-all | /api/notifications/read-all | 200 | notifications.js |  |
| POST | /api/production/produce | /api/production/produce | 400 | production.js | Validation failed |
| POST | /api/production/produce/custom | /api/production/produce/custom | 400 | production.js | Validation failed |
| POST | /api/production/product-stock/adjust | /api/production/product-stock/adjust | 400 | production.js | Validation failed |
| PUT | /api/production/tasks/:id/assign | /api/production/tasks/999999/assign | 400 | production.js | Validation failed |
| PUT | /api/production/tasks/:id/complete | /api/production/tasks/999999/complete | 404 | production.js | Task not found |
| PUT | /api/production/tasks/:id/pick | /api/production/tasks/999999/pick | 404 | production.js | Task not found |
| PUT | /api/production/tasks/:id/start | /api/production/tasks/999999/start | 404 | production.js | Task not found |
| DELETE | /api/products/:id | /api/products/999999 | 404 | products.js | Product not found |
| DELETE | /api/products/:id/images/:imageId | /api/products/999999/images/999999 | 404 | products.js | Image not found |
| DELETE | /api/products/:id/materials/:materialId | /api/products/999999/materials/999999 | 404 | products.js | Material not linked to this product |
| POST | /api/products/ | /api/products/ | 400 | products.js | Validation failed |
| POST | /api/products/:id/images | /api/products/999999/images | 404 | products.js | Product not found |
| POST | /api/products/:id/materials | /api/products/999999/materials | 400 | products.js | Validation failed |
| POST | /api/products/scan | /api/products/scan | 400 | products.js | No QR payload provided |
| PUT | /api/products/:id | /api/products/999999 | 404 | products.js | Product not found |
| PUT | /api/products/:id/materials/:materialId | /api/products/999999/materials/999999 | 400 | products.js | Validation failed |
| POST | /api/purchase-orders/ | /api/purchase-orders/ | 400 | purchase-orders.js | Validation failed |
| POST | /api/purchase-orders/:id/receive | /api/purchase-orders/999999/receive | 400 | purchase-orders.js | Validation failed |
| PUT | /api/purchase-orders/:id | /api/purchase-orders/999999 | 404 | purchase-orders.js | Purchase order not found |
| DELETE | /api/recurring-orders/:id | /api/recurring-orders/999999 | 404 | recurring-orders.js | Not found |
| POST | /api/recurring-orders/ | /api/recurring-orders/ | 400 | recurring-orders.js | Validation failed |
| PUT | /api/recurring-orders/:id | /api/recurring-orders/999999 | 404 | recurring-orders.js | Not found |
| POST | /api/sales/ | /api/sales/ | 400 | sales.js | Validation failed |
| POST | /api/sales/:id/fulfill-from-stock | /api/sales/999999/fulfill-from-stock | 400 | sales.js | Validation failed |
| POST | /api/sales/:id/payments | /api/sales/999999/payments | 400 | sales.js | Validation failed |
| POST | /api/sales/:id/refund | /api/sales/999999/refund | 400 | sales.js | Validation failed |
| POST | /api/sales/customer-order | /api/sales/customer-order | 400 | sales.js | Validation failed |
| POST | /api/sales/register/open | /api/sales/register/open | 201 | sales.js |  |
| PUT | /api/sales/:id/cancel | /api/sales/999999/cancel | 404 | sales.js | Sale not found |
| PUT | /api/sales/:id/convert-type | /api/sales/999999/convert-type | 400 | sales.js | Validation failed |
| PUT | /api/sales/:id/status | /api/sales/999999/status | 400 | sales.js | Validation failed |
| PUT | /api/sales/register/close | /api/sales/register/close | 200 | sales.js |  |
| POST | /api/settings/tax-rates | /api/settings/tax-rates | 400 | settings.js |  |
| PUT | /api/settings/ | /api/settings/ | 400 | settings.js |  |
| PUT | /api/settings/tax-rates/:id | /api/settings/tax-rates/999999 | 404 | settings.js | Tax rate not found |
| DELETE | /api/staff/shifts/:id | /api/staff/shifts/999999 | 200 | staff-management.js | Shift removed. |
| POST | /api/staff/geofence-event | /api/staff/geofence-event | 403 | staff-management.js | You do not have permission to perform this action. |
| POST | /api/staff/payroll/calculate | /api/staff/payroll/calculate | 400 | staff-management.js | user_id, period_start and period_end are required. |
| POST | /api/staff/payroll/disburse | /api/staff/payroll/disburse | 400 | staff-management.js | Missing required fields. |
| POST | /api/staff/salaries | /api/staff/salaries | 400 | staff-management.js | user_id and valid monthly_salary are required. |
| POST | /api/staff/shifts | /api/staff/shifts | 400 | staff-management.js | user_id and location_id are required. |
| POST | /api/stock/adjust | /api/stock/adjust | 400 | stock.js | Validation failed |
| POST | /api/stock/reconcile | /api/stock/reconcile | 400 | stock.js | Validation failed |
| POST | /api/stock/transfer | /api/stock/transfer | 400 | stock.js | Validation failed |
| PUT | /api/stock/transfers/:id/cancel | /api/stock/transfers/999999/cancel | 404 | stock.js | Transfer not found |
| PUT | /api/stock/transfers/:id/receive | /api/stock/transfers/999999/receive | 404 | stock.js | Transfer not found |
| DELETE | /api/suppliers/:id | /api/suppliers/999999 | 404 | suppliers.js | Supplier not found |
| DELETE | /api/suppliers/:supplierId/materials/:materialId | /api/suppliers/999999/materials/999999 | 404 | suppliers.js | Link not found |
| POST | /api/suppliers/ | /api/suppliers/ | 400 | suppliers.js | Validation failed |
| POST | /api/suppliers/:id/materials | /api/suppliers/999999/materials | 400 | suppliers.js | Validation failed |
| PUT | /api/suppliers/:id | /api/suppliers/999999 | 404 | suppliers.js | Supplier not found |
| POST | /api/users/ | /api/users/ | 400 | users.js | Validation failed |
| PUT | /api/users/:id | /api/users/999999 | 404 | users.js | User not found |
| PUT | /api/users/:id/reset-password | /api/users/999999/reset-password | 400 | users.js |  |