#!/bin/bash
# BloomCart API Test Suite
# Usage: bash test-api.sh

BASE="http://localhost:3001/api"
PASS=0
FAIL=0
TOTAL=0

test_endpoint() {
  local desc="$1"
  local expected_code="$2"
  local method="$3"
  local url="$4"
  local auth="$5"
  local body="$6"

  TOTAL=$((TOTAL+1))

  local args=(-s -w "\n%{http_code}" -X "$method" "$url")
  if [ -n "$auth" ]; then
    args+=(-H "Authorization: Bearer $auth")
  fi
  if [ -n "$body" ]; then
    args+=(-H "Content-Type: application/json" -d "$body")
  fi

  local result
  result=$(curl "${args[@]}")
  local code
  code=$(echo "$result" | tail -1)
  local response
  response=$(echo "$result" | head -1)

  if [ "$code" = "$expected_code" ]; then
    echo "  PASS [$code] $desc"
    PASS=$((PASS+1))
  else
    echo "  FAIL [$code expected $expected_code] $desc"
    echo "       Response: $(echo "$response" | head -c 200)"
    FAIL=$((FAIL+1))
  fi
}

# Get owner token
echo "Setting up tokens..."
OWNER_TOKEN=$(curl -s "$BASE/auth/login" -H "Content-Type: application/json" -d '{"phone":"9876453210","password":"naman1234"}' | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['token'])")
echo "Owner token: ${OWNER_TOKEN:0:20}..."

# Get customer token
CUST_TOKEN=$(curl -s "$BASE/auth/login" -H "Content-Type: application/json" -d '{"phone":"7777744441","password":"customer123"}' | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['token'])")
echo "Customer token: ${CUST_TOKEN:0:20}..."
echo ""

# ═══════════════════════════════════════════════════════════════
echo "═══════════════════════════════════════════════════════"
echo "1. AUTH TESTS"
echo "═══════════════════════════════════════════════════════"

test_endpoint "Login valid"              200 POST "$BASE/auth/login"    "" '{"phone":"9876453210","password":"naman1234"}'
test_endpoint "Login wrong password"     401 POST "$BASE/auth/login"    "" '{"phone":"9876453210","password":"wrong"}'
test_endpoint "Login invalid phone"      400 POST "$BASE/auth/login"    "" '{"phone":"123","password":"test1234"}'
test_endpoint "Login nonexistent phone"  401 POST "$BASE/auth/login"    "" '{"phone":"9999999999","password":"test1234"}'
test_endpoint "Register short password"  400 POST "$BASE/auth/register" "" '{"name":"X","phone":"6666666666","password":"ab"}'
test_endpoint "Get profile with token"   200 GET  "$BASE/auth/profile"  "$OWNER_TOKEN" ""
test_endpoint "Get profile without token" 401 GET "$BASE/auth/profile"  "" ""
test_endpoint "Setup status"             200 GET  "$BASE/auth/setup-status" "" ""
echo ""

# ═══════════════════════════════════════════════════════════════
echo "═══════════════════════════════════════════════════════"
echo "2. LOCATIONS TESTS"
echo "═══════════════════════════════════════════════════════"

test_endpoint "List locations"          200 GET  "$BASE/locations"     "$OWNER_TOKEN" ""
test_endpoint "Get location 1"          200 GET  "$BASE/locations/1"   "$OWNER_TOKEN" ""
test_endpoint "Get nonexistent loc"     404 GET  "$BASE/locations/999" "$OWNER_TOKEN" ""
test_endpoint "Create location"         201 POST "$BASE/locations"     "$OWNER_TOKEN" '{"name":"Test Loc","type":"shop","address":"Test Addr"}'
test_endpoint "List locs as customer"   200 GET  "$BASE/locations"     "$CUST_TOKEN" ""
echo ""

# ═══════════════════════════════════════════════════════════════
echo "═══════════════════════════════════════════════════════"
echo "3. PRODUCTS TESTS"
echo "═══════════════════════════════════════════════════════"

test_endpoint "List products"           200 GET  "$BASE/products"                "$OWNER_TOKEN" ""
test_endpoint "List products (active)"  200 GET  "$BASE/products?is_active=1"    "$OWNER_TOKEN" ""
test_endpoint "List as customer"        200 GET  "$BASE/products?is_active=1"    "$CUST_TOKEN" ""
test_endpoint "Get product 1"           200 GET  "$BASE/products/1"              "$OWNER_TOKEN" ""
test_endpoint "Get nonexistent product" 404 GET  "$BASE/products/999"            "$OWNER_TOKEN" ""
test_endpoint "Create product"          201 POST "$BASE/products"                "$OWNER_TOKEN" '{"name":"TestProd","type":"standard","category":"bouquet","selling_price":100,"location_id":1}'
test_endpoint "Create product no auth"  401 POST "$BASE/products"                "" '{"name":"X","type":"standard","selling_price":100,"location_id":1}'
test_endpoint "Create product as cust"  403 POST "$BASE/products"                "$CUST_TOKEN" '{"name":"X","type":"standard","category":"bouquet","selling_price":100,"location_id":1}'
echo ""

# ═══════════════════════════════════════════════════════════════
echo "═══════════════════════════════════════════════════════"
echo "4. CUSTOMERS TESTS"
echo "═══════════════════════════════════════════════════════"

test_endpoint "List customers"          200 GET  "$BASE/customers"     "$OWNER_TOKEN" ""
test_endpoint "List customers as cust"  403 GET  "$BASE/customers"     "$CUST_TOKEN" ""
test_endpoint "Create customer"         201 POST "$BASE/customers"     "$OWNER_TOKEN" '{"name":"API Test Cust","phone":"8888822220"}'
test_endpoint "Customer duplicate"      409 POST "$BASE/customers"     "$OWNER_TOKEN" '{"name":"Dup","phone":"8888822220"}'
test_endpoint "Customer search"         200 GET  "$BASE/customers/search?q=test" "$OWNER_TOKEN" ""
test_endpoint "Customer addresses"      200 GET  "$BASE/customers/13/addresses"   "$OWNER_TOKEN" ""
test_endpoint "Upcoming dates"          200 GET  "$BASE/customers/upcoming-dates" "$OWNER_TOKEN" ""
echo ""

# ═══════════════════════════════════════════════════════════════
echo "═══════════════════════════════════════════════════════"
echo "5. SALES/ORDERS TESTS"
echo "═══════════════════════════════════════════════════════"

test_endpoint "List sales"              200 GET  "$BASE/sales"         "$OWNER_TOKEN" ""
test_endpoint "List sales (pending)"    200 GET  "$BASE/sales?status=pending" "$OWNER_TOKEN" ""
test_endpoint "Get sale 1"              200 GET  "$BASE/sales/1"       "$OWNER_TOKEN" ""
test_endpoint "Walk-in sale"            201 POST "$BASE/sales"         "$OWNER_TOKEN" '{"location_id":1,"order_type":"walk_in","items":[{"product_id":1,"quantity":1}]}'
test_endpoint "Customer order"          201 POST "$BASE/sales/customer-order" "$CUST_TOKEN" '{"location_id":1,"order_type":"delivery","items":[{"product_id":1,"quantity":1}],"delivery_address":"Test St"}'
test_endpoint "Customer order no addr"  400 POST "$BASE/sales/customer-order" "$CUST_TOKEN" '{"location_id":1,"order_type":"delivery","items":[{"product_id":1,"quantity":1}]}'
test_endpoint "Customer order pickup"   201 POST "$BASE/sales/customer-order" "$CUST_TOKEN" '{"location_id":1,"order_type":"pickup","items":[{"product_id":1,"quantity":1}]}'
test_endpoint "Customer lookup"         200 GET  "$BASE/sales/customer-lookup?phone=7777744441" "$OWNER_TOKEN" ""
test_endpoint "Sales no auth"           401 GET  "$BASE/sales"         "" ""
echo ""

# ═══════════════════════════════════════════════════════════════
echo "═══════════════════════════════════════════════════════"
echo "6. DELIVERIES TESTS"
echo "═══════════════════════════════════════════════════════"

test_endpoint "List deliveries"         200 GET  "$BASE/deliveries"    "$OWNER_TOKEN" ""
test_endpoint "List deliveries pending" 200 GET  "$BASE/deliveries?status=pending" "$OWNER_TOKEN" ""
test_endpoint "Get delivery 1"          200 GET  "$BASE/deliveries/1"  "$OWNER_TOKEN" ""
test_endpoint "Customer orders"         200 GET  "$BASE/deliveries/customer/orders" "$CUST_TOKEN" ""
echo ""

# ═══════════════════════════════════════════════════════════════
echo "═══════════════════════════════════════════════════════"
echo "7. ATTENDANCE TESTS"
echo "═══════════════════════════════════════════════════════"

test_endpoint "Get attendance"          200 GET  "$BASE/attendance"    "$OWNER_TOKEN" ""
test_endpoint "Today summary"          200 GET  "$BASE/attendance/today"  "$OWNER_TOKEN" ""
test_endpoint "My attendance"          200 GET  "$BASE/attendance/me"     "$OWNER_TOKEN" ""
echo ""

# ═══════════════════════════════════════════════════════════════
echo "═══════════════════════════════════════════════════════"
echo "8. STOCK/INVENTORY TESTS"
echo "═══════════════════════════════════════════════════════"

test_endpoint "List materials"          200 GET  "$BASE/stock/materials"        "$OWNER_TOKEN" ""
test_endpoint "Material stock overview" 200 GET  "$BASE/stock/overview?location_id=1" "$OWNER_TOKEN" ""
test_endpoint "Product stock"           200 GET  "$BASE/stock/product-stock?location_id=1" "$OWNER_TOKEN" ""
test_endpoint "Stock logs"              200 GET  "$BASE/stock/logs"             "$OWNER_TOKEN" ""
echo ""

# ═══════════════════════════════════════════════════════════════
echo "═══════════════════════════════════════════════════════"
echo "9. PRODUCTION TESTS"
echo "═══════════════════════════════════════════════════════"

test_endpoint "List prod tasks"         200 GET  "$BASE/production/tasks"       "$OWNER_TOKEN" ""
test_endpoint "List prod tasks pending" 200 GET  "$BASE/production/tasks?status=pending" "$OWNER_TOKEN" ""
test_endpoint "Production summary"      200 GET  "$BASE/production/summary"     "$OWNER_TOKEN" ""
echo ""

# ═══════════════════════════════════════════════════════════════
echo "═══════════════════════════════════════════════════════"
echo "10. EXPENSES TESTS"
echo "═══════════════════════════════════════════════════════"

test_endpoint "List expenses"           200 GET  "$BASE/expenses"               "$OWNER_TOKEN" ""
test_endpoint "Expense categories"      200 GET  "$BASE/expenses/categories"    "$OWNER_TOKEN" ""
test_endpoint "Create expense"          201 POST "$BASE/expenses"               "$OWNER_TOKEN" '{"category":"supplies","amount":500,"description":"Test expense","location_id":1}'
test_endpoint "Create expense no auth"  401 POST "$BASE/expenses"               "" '{"category":"supplies","amount":500}'
echo ""

# ═══════════════════════════════════════════════════════════════
echo "═══════════════════════════════════════════════════════"
echo "11. REPORTS TESTS"
echo "═══════════════════════════════════════════════════════"

test_endpoint "Dashboard stats"         200 GET  "$BASE/reports/dashboard"      "$OWNER_TOKEN" ""
test_endpoint "Sales report"            200 GET  "$BASE/reports/sales"          "$OWNER_TOKEN" ""
test_endpoint "Revenue report"          200 GET  "$BASE/reports/revenue"        "$OWNER_TOKEN" ""
test_endpoint "Product performance"     200 GET  "$BASE/reports/products"       "$OWNER_TOKEN" ""
test_endpoint "Delivery report"         200 GET  "$BASE/reports/deliveries"     "$OWNER_TOKEN" ""
test_endpoint "Staff report"            200 GET  "$BASE/reports/staff"          "$OWNER_TOKEN" ""
test_endpoint "Reports as customer"     403 GET  "$BASE/reports/dashboard"      "$CUST_TOKEN" ""
echo ""

# ═══════════════════════════════════════════════════════════════
echo "═══════════════════════════════════════════════════════"
echo "12. SETTINGS & NOTIFICATIONS TESTS"
echo "═══════════════════════════════════════════════════════"

test_endpoint "Get settings"            200 GET  "$BASE/settings"               "$OWNER_TOKEN" ""
test_endpoint "Get notifications"       200 GET  "$BASE/notifications"          "$OWNER_TOKEN" ""
test_endpoint "Unread count"            200 GET  "$BASE/notifications/unread-count" "$OWNER_TOKEN" ""
test_endpoint "Settings as customer"    403 GET  "$BASE/settings"               "$CUST_TOKEN" ""
echo ""

# ═══════════════════════════════════════════════════════════════
echo "═══════════════════════════════════════════════════════"
echo "13. USERS/STAFF TESTS"
echo "═══════════════════════════════════════════════════════"

test_endpoint "List users"              200 GET  "$BASE/users"                  "$OWNER_TOKEN" ""
test_endpoint "Get user 1"              200 GET  "$BASE/users/1"                "$OWNER_TOKEN" ""
test_endpoint "List users as customer"  403 GET  "$BASE/users"                  "$CUST_TOKEN" ""
echo ""

# ═══════════════════════════════════════════════════════════════
echo "═══════════════════════════════════════════════════════"
echo "14. STAFF MANAGEMENT TESTS"
echo "═══════════════════════════════════════════════════════"

test_endpoint "Staff overview"          200 GET  "$BASE/staff-management/overview" "$OWNER_TOKEN" ""
test_endpoint "Staff as customer"       403 GET  "$BASE/staff-management/overview" "$CUST_TOKEN" ""
echo ""

# ═══════════════════════════════════════════════════════════════
echo "═══════════════════════════════════════════════════════"
echo "15. DELIVERY TRACKING TESTS"
echo "═══════════════════════════════════════════════════════"

test_endpoint "Live tracking"           200 GET  "$BASE/delivery-tracking/live" "$OWNER_TOKEN" ""
test_endpoint "Tracking as customer"    403 GET  "$BASE/delivery-tracking/live" "$CUST_TOKEN" ""
echo ""

# ═══════════════════════════════════════════════════════════════
echo ""
echo "═══════════════════════════════════════════════════════"
echo "RESULTS: $PASS PASSED / $FAIL FAILED / $TOTAL TOTAL"
echo "═══════════════════════════════════════════════════════"
