#!/usr/bin/env python3
"""BloomCart API Test Suite"""
import json
import urllib.request
import urllib.error
import sys

BASE = "http://localhost:3001/api"
PASS = 0
FAIL = 0
RESULTS = []

def req(method, path, token=None, body=None):
    url = f"{BASE}{path}"
    data = json.dumps(body).encode() if body else None
    headers = {}
    if body:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    r = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        resp = urllib.request.urlopen(r, timeout=10)
        return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read())
        except:
            return e.code, {}
    except Exception as e:
        return 0, {"error": str(e)}

def test(desc, expected, method, path, token=None, body=None):
    global PASS, FAIL
    code, data = req(method, path, token, body)
    ok = code == expected
    status = "PASS" if ok else "FAIL"
    if ok:
        PASS += 1
    else:
        FAIL += 1
    RESULTS.append((status, code, expected, desc))
    mark = "✓" if ok else "✗"
    print(f"  {mark} [{code}] {desc}" + ("" if ok else f" (expected {expected})"))

def section(name):
    print(f"\n{'='*55}")
    print(f"  {name}")
    print(f"{'='*55}")

# ─── Get tokens ──────────────────────────────────────────────
print("Setting up tokens...")
_, d = req("POST", "/auth/login", body={"phone": "9876453210", "password": "naman1234"})
OWNER = d["data"]["token"]
print(f"  Owner token: {OWNER[:30]}...")

_, d = req("POST", "/auth/login", body={"phone": "7777744441", "password": "customer123"})
CUST = d["data"]["token"]
print(f"  Customer token: {CUST[:30]}...")

# ─── 1. AUTH ─────────────────────────────────────────────────
section("1. AUTH")
test("Login valid",               200, "POST", "/auth/login", body={"phone": "9876453210", "password": "naman1234"})
test("Login wrong password",      401, "POST", "/auth/login", body={"phone": "9876453210", "password": "wrong"})
test("Login invalid phone fmt",   400, "POST", "/auth/login", body={"phone": "123", "password": "test1234"})
test("Login nonexistent phone",   401, "POST", "/auth/login", body={"phone": "9999999999", "password": "test1234"})
test("Register short password",   400, "POST", "/auth/register", body={"name": "X", "phone": "6666666666", "password": "ab"})
test("Profile with token",        200, "GET",  "/auth/me", OWNER)
test("Profile without token",     401, "GET",  "/auth/me")
test("Setup status",              200, "GET",  "/auth/setup-status")

# ─── 2. LOCATIONS ────────────────────────────────────────────
section("2. LOCATIONS")
test("List locations",            200, "GET",  "/locations", OWNER)
test("Get location 1",            200, "GET",  "/locations/1", OWNER)
test("Get nonexistent loc",       404, "GET",  "/locations/999", OWNER)
test("List locs as customer",     200, "GET",  "/locations", CUST)

# ─── 3. PRODUCTS ─────────────────────────────────────────────
section("3. PRODUCTS")
test("List products",             200, "GET",  "/products", OWNER)
test("List active products",      200, "GET",  "/products?is_active=1", OWNER)
test("Products as customer",      200, "GET",  "/products?is_active=1", CUST)
test("Get product 1",             200, "GET",  "/products/1", OWNER)
test("Get nonexistent product",   404, "GET",  "/products/999", OWNER)
test("Create product no auth",    401, "POST", "/products", body={"name": "X", "type": "standard", "selling_price": 100, "location_id": 1})
test("Create product as cust",    403, "POST", "/products", CUST, {"name": "X", "type": "standard", "category": "bouquet", "selling_price": 100, "location_id": 1})

# ─── 4. CUSTOMERS ────────────────────────────────────────────
section("4. CUSTOMERS")
test("List customers",            200, "GET",  "/customers", OWNER)
test("List customers as cust",    403, "GET",  "/customers", CUST)
test("Customer search",           200, "GET",  "/customers/search?q=test", OWNER)
test("Customer 13 addresses",     200, "GET",  "/customers/13/addresses", OWNER)
test("Upcoming dates",            200, "GET",  "/customers/upcoming-dates", OWNER)

# ─── 5. SALES/ORDERS ─────────────────────────────────────────
section("5. SALES/ORDERS")
test("List sales",                200, "GET",  "/sales", OWNER)
test("List pending sales",        200, "GET",  "/sales?status=pending", OWNER)
test("Get sale 1",                200, "GET",  "/sales/1", OWNER)
test("Walk-in sale",              201, "POST", "/sales", OWNER, {"location_id": 1, "order_type": "walk_in", "payment_method": "cash", "items": [{"product_id": 1, "quantity": 1, "unit_price": 500}]})
test("Customer order delivery",   201, "POST", "/sales/customer-order", CUST, {"location_id": 1, "order_type": "delivery", "items": [{"product_id": 1, "quantity": 1}], "delivery_address": "Test St"})
test("Cust order no addr",        400, "POST", "/sales/customer-order", CUST, {"location_id": 1, "order_type": "delivery", "items": [{"product_id": 1, "quantity": 1}]})
test("Customer order pickup",     201, "POST", "/sales/customer-order", CUST, {"location_id": 1, "order_type": "pickup", "items": [{"product_id": 1, "quantity": 1}]})
test("Customer lookup",           200, "GET",  "/sales/customer-lookup?phone=7777744441", OWNER)
test("Sales no auth",             401, "GET",  "/sales")

# ─── 6. DELIVERIES ───────────────────────────────────────────
section("6. DELIVERIES")
test("List deliveries",           200, "GET",  "/deliveries", OWNER)
test("List pending deliveries",   200, "GET",  "/deliveries?status=pending", OWNER)
test("Get delivery 1",            200, "GET",  "/deliveries/1", OWNER)
test("Customer orders list",      200, "GET",  "/deliveries/customer/orders", CUST)

# ─── 7. ATTENDANCE ───────────────────────────────────────────
section("7. ATTENDANCE")
test("List attendance",           200, "GET",  "/attendance", OWNER)
test("Today summary",             200, "GET",  "/attendance/today", OWNER)
test("Attendance report",          200, "GET",  "/attendance/report?start_date=2026-03-01&end_date=2026-03-11", OWNER)

# ─── 8. STOCK/INVENTORY ──────────────────────────────────────
section("8. STOCK/INVENTORY")
test("Stock list",                200, "GET",  "/stock", OWNER)
test("Stock transactions",        200, "GET",  "/stock/transactions", OWNER)
test("Materials list",            200, "GET",  "/materials", OWNER)
test("Product stock",             200, "GET",  "/production/product-stock", OWNER)

# ─── 9. PRODUCTION ───────────────────────────────────────────
section("9. PRODUCTION")
test("List prod tasks",           200, "GET",  "/production/tasks", OWNER)
test("Pending prod tasks",        200, "GET",  "/production/tasks?status=pending", OWNER)
test("My prod tasks",             200, "GET",  "/production/my-tasks", OWNER)

# ─── 10. EXPENSES ────────────────────────────────────────────
section("10. EXPENSES")
test("List expenses",             200, "GET",  "/expenses", OWNER)
test("Expense summary",           200, "GET",  "/expenses/summary",       OWNER)
test("Create expense",            201, "POST", "/expenses", OWNER, {"category": "supplies", "amount": 500, "description": "Test expense", "location_id": 1, "payment_method": "cash", "expense_date": "2026-03-11"})
test("Create expense no auth",    401, "POST", "/expenses", body={"category": "supplies", "amount": 500})

# ─── 11. REPORTS ──────────────────────────────────────────────
section("11. REPORTS")
test("Dashboard stats",           200, "GET",  "/reports/dashboard", OWNER)
test("Sales summary report",      200, "GET",  "/reports/sales-summary", OWNER)
test("Inventory report",          200, "GET",  "/reports/inventory", OWNER)
test("Customer insights",         200, "GET",  "/reports/customer-insights", OWNER)
test("Employee performance",      200, "GET",  "/reports/employee-performance", OWNER)
test("Reports as customer",       403, "GET",  "/reports/dashboard", CUST)

# ─── 12. SETTINGS & NOTIFICATIONS ────────────────────────────
section("12. SETTINGS & NOTIFICATIONS")
test("Get settings",              200, "GET",  "/settings", OWNER)
test("Get notifications",         200, "GET",  "/notifications", OWNER)
test("Unread count",              200, "GET",  "/notifications/unread-count", OWNER)
test("Settings as customer",      403, "GET",  "/settings", CUST)

# ─── 13. USERS/STAFF ─────────────────────────────────────────
section("13. USERS/STAFF")
test("List users",                200, "GET",  "/users", OWNER)
test("Get user 1",                200, "GET",  "/users/1", OWNER)
test("List users as customer",    403, "GET",  "/users", CUST)

# ─── 14. STAFF MANAGEMENT ────────────────────────────────────
section("14. STAFF MANAGEMENT")
test("Staff shifts",              200, "GET",  "/staff/shifts",            OWNER)
test("Staff salaries",            200, "GET",  "/staff/salaries",          OWNER)
test("Staff shifts as customer",  403, "GET",  "/staff/shifts",            CUST)

# ─── 15. DELIVERY TRACKING ───────────────────────────────────
section("15. DELIVERY TRACKING")
test("Active partners",           200, "GET",  "/delivery-tracking/active-partners", OWNER)
test("Daily tracking summary",    200, "GET",  "/delivery-tracking/daily-summary", OWNER)
test("Tracking as customer",      403, "GET",  "/delivery-tracking/active-partners", CUST)

# ─── Summary ─────────────────────────────────────────────────
print(f"\n{'='*55}")
total = PASS + FAIL
print(f"  RESULTS: {PASS} PASSED / {FAIL} FAILED / {total} TOTAL")

if FAIL > 0:
    print(f"\n  Failed tests:")
    for status, code, expected, desc in RESULTS:
        if status == "FAIL":
            print(f"    ✗ [{code} expected {expected}] {desc}")

print(f"{'='*55}")
sys.exit(1 if FAIL > 0 else 0)
