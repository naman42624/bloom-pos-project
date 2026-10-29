# Final fix wave report

Suites (env-notes env, API restarted): verify-order-flows 62/62 (61 + new I2 check), verify-register-expenses 13/13, verify-order-requests 21/21, verify-slip-and-open-requests 31/31 (was 26-ish; +2 I3 checks, +"/." from-url case, +resolve identity assertion). Babel-check OK on all 5 touched app files; node -c OK on touched server files. Scripts self-clean their rows (cleanup lines printed).

- I1 QuickCheckoutScreen.js: prefillCustomer effect moved below handleNewSale; if the form has data it awaits handleNewSale() (same auto-save-draft + resetForm path; now returns true/false, false when a voice note could not be saved, in which case the customer is not applied and the existing alert shows), then selectCustomer. Skips the reset only when the same customer is already selected and there are no items. Empty form: applies directly.
- I2 server/routes/customers.js POST /:id/credits: optional exclude_sale_id (isInt), auto-allocate query adds `AND s.id <> ?`. QuickCheckoutScreen and LogOrderScreen pass the new sale id. Regression check in verify-order-flows.js: add-due 250 + new unpaid 500 pickup + credits with exclude_sale_id -> new order has no payment, payment_status unchanged, balance -250. Passes.
- I3 server/routes/order-request-public.js: length caps (names 100, phone 20, address/message 500, time 50, payment_reference 100, item description/name 200), real calendar date, items 1..50, qty 1..999, items rebuilt from {product_id, name, quantity, custom, description}. Both routes now return the first validator message (per-customer route no longer says "Validation failed"). Checks added: overlong phone/time/reference, 2026-02-30, 51 items, qty 1000, landline number -> 400 plain; unknown item key not stored.
- I4 QuickCheckoutScreen.js: pending order-level voice note now has a trash button (44x44 min) removing it from pendingAttachments.
- M1 sale-attachments.js from-url: regex now `attachment-\d+-\d+(.ext)?`, plus fs.statSync().isFile(). Check: "/uploads/sale-attachments/." -> 400.
- M2 open submit requires /^[6-9]\d{9}$/ after normalizeIndianPhone (server) and equivalent client check; message "Please enter a 10-digit mobile number." (existing 9-digit check updated to the new message).
- M3 order-requests.js: list match ORDER BY (stored phone already normalized) DESC, id ASC, mirroring resolve; resolve-customer returns {customer_id, name, phone, created}; OrderRequestsScreen prefills from that response. Check asserts name/phone in response.
- M4 OrderRequestScreen (load and submit) and SlipScreen (load and tick toast): 429 shows "Too many tries — please wait a minute and try again."
- M5 OrderRequestsScreen: any 4xx from resolve-customer shows the server message.

Not covered by scripts (on-screen): I1, I4, M3 prefill, M4, M5, M2 client message.
