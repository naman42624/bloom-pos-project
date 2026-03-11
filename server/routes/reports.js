const express = require('express');
const router = express.Router();
const { getDb } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

function localToday() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;
}

function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// ═══════════════════════════════════════════════════════════════
// 1. SALES SUMMARY
// ═══════════════════════════════════════════════════════════════
router.get('/sales-summary', authenticate, authorize('owner', 'manager'), (req, res, next) => {
  try {
    const db = getDb();
    const { from, to, location_id, group_by } = req.query;
    const today = localToday();
    const dateFrom = from || today;
    const dateTo = to || today;
    const grouping = group_by || 'day'; // day, week, month

    let dateExpr;
    if (grouping === 'month') dateExpr = "strftime('%Y-%m', s.created_at)";
    else if (grouping === 'week') dateExpr = "strftime('%Y-W%W', s.created_at)";
    else dateExpr = "date(s.created_at)";

    let where = "WHERE date(s.created_at) BETWEEN ? AND ? AND s.status != 'cancelled'";
    const params = [dateFrom, dateTo];

    if (location_id) {
      where += ' AND s.location_id = ?';
      params.push(location_id);
    }

    // Overall totals
    const totals = db.prepare(`
      SELECT
        COUNT(*) as total_orders,
        COALESCE(SUM(s.grand_total), 0) as total_revenue,
        COALESCE(SUM(s.subtotal), 0) as total_subtotal,
        COALESCE(SUM(s.tax_total), 0) as total_tax,
        COALESCE(SUM(s.discount_amount), 0) as total_discounts,
        COALESCE(SUM(s.delivery_charges), 0) as total_delivery_charges,
        COALESCE(AVG(s.grand_total), 0) as avg_order_value,
        COUNT(CASE WHEN s.order_type = 'walk_in' THEN 1 END) as walk_in_count,
        COUNT(CASE WHEN s.order_type = 'pickup' THEN 1 END) as pickup_count,
        COUNT(CASE WHEN s.order_type = 'delivery' THEN 1 END) as delivery_count,
        COUNT(CASE WHEN s.payment_status = 'paid' THEN 1 END) as paid_count,
        COUNT(CASE WHEN s.payment_status = 'pending' THEN 1 END) as pending_count,
        COUNT(CASE WHEN s.payment_status = 'partial' THEN 1 END) as partial_count
      FROM sales s ${where}
    `).get(...params);

    // Grouped breakdown
    const breakdown = db.prepare(`
      SELECT
        ${dateExpr} as period,
        COUNT(*) as orders,
        COALESCE(SUM(s.grand_total), 0) as revenue,
        COALESCE(SUM(s.discount_amount), 0) as discounts
      FROM sales s ${where}
      GROUP BY period
      ORDER BY period ASC
    `).all(...params);

    // Payment method breakdown
    const paymentMethods = db.prepare(`
      SELECT
        p.method,
        COUNT(*) as count,
        COALESCE(SUM(p.amount), 0) as total
      FROM payments p
      JOIN sales s ON p.sale_id = s.id
      ${where}
      GROUP BY p.method
      ORDER BY total DESC
    `).all(...params);

    // Top products
    const topProducts = db.prepare(`
      SELECT
        si.product_name,
        SUM(si.quantity) as total_qty,
        SUM(si.line_total) as total_revenue
      FROM sale_items si
      JOIN sales s ON si.sale_id = s.id
      ${where}
      GROUP BY si.product_name
      ORDER BY total_revenue DESC
      LIMIT 10
    `).all(...params);

    // By location
    const byLocation = db.prepare(`
      SELECT
        l.name as location_name,
        COUNT(*) as orders,
        COALESCE(SUM(s.grand_total), 0) as revenue
      FROM sales s
      JOIN locations l ON s.location_id = l.id
      ${where}
      GROUP BY s.location_id
      ORDER BY revenue DESC
    `).all(...params);

    // Refunds
    const refunds = db.prepare(`
      SELECT
        COUNT(*) as refund_count,
        COALESCE(SUM(r.amount), 0) as refund_total
      FROM refunds r
      JOIN sales s ON r.sale_id = s.id
      ${where}
    `).get(...params);

    // Expenses
    const expenses = db.prepare(`
      SELECT
        COALESCE(SUM(e.amount), 0) as total_expenses,
        COUNT(*) as expense_count
      FROM expenses e
      WHERE date(e.created_at) BETWEEN ? AND ?
      ${location_id ? 'AND e.location_id = ?' : ''}
    `).get(...(location_id ? [dateFrom, dateTo, location_id] : [dateFrom, dateTo]));

    res.json({
      success: true,
      data: {
        period: { from: dateFrom, to: dateTo },
        totals: { ...totals, ...refunds, ...expenses, net_revenue: totals.total_revenue - (refunds.refund_total || 0) - (expenses.total_expenses || 0)  },
        breakdown,
        paymentMethods,
        topProducts,
        byLocation,
      },
    });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
// 2. INVENTORY REPORT
// ═══════════════════════════════════════════════════════════════
router.get('/inventory', authenticate, authorize('owner', 'manager'), (req, res, next) => {
  try {
    const db = getDb();
    const { location_id } = req.query;

    // Material stock levels
    let stockWhere = location_id ? 'WHERE ms.location_id = ?' : '';
    const stockParams = location_id ? [location_id] : [];

    const stockLevels = db.prepare(`
      SELECT
        m.id, m.name, m.min_stock_alert,
        COALESCE(SUM(ms.quantity), 0) as total_stock,
        l.name as location_name, ms.quantity as location_stock
      FROM materials m
      LEFT JOIN material_stock ms ON m.id = ms.material_id
      LEFT JOIN locations l ON ms.location_id = l.id
      ${stockWhere}
      GROUP BY m.id, ms.location_id
      ORDER BY m.name
    `).all(...stockParams);

    // Low stock alerts
    const lowStock = db.prepare(`
      SELECT m.id, m.name, m.min_stock_alert,
        COALESCE(SUM(ms.quantity), 0) as total_stock
      FROM materials m
      LEFT JOIN material_stock ms ON m.id = ms.material_id
      ${location_id ? 'AND ms.location_id = ?' : ''}
      Group BY m.id
      HAVING total_stock <= m.min_stock_alert AND m.min_stock_alert > 0
      ORDER BY (total_stock * 1.0 / MAX(m.min_stock_alert, 1)) ASC
    `).all(...(location_id ? [location_id] : []));

    // Product stock
    const productStock = db.prepare(`
      SELECT p.id, p.name,
        COALESCE(SUM(ps.quantity), 0) as total_stock
      FROM products p
      LEFT JOIN product_stock ps ON p.id = ps.product_id
      ${location_id ? 'WHERE ps.location_id = ?' : ''}
      GROUP BY p.id
      ORDER BY p.name
    `).all(...(location_id ? [location_id] : []));

    // Recent transactions (wastage, adjustments, etc.)
    const recentTransactions = db.prepare(`
      SELECT mt.*, m.name as material_name, l.name as location_name, u.name as user_name
      FROM material_transactions mt
      JOIN materials m ON mt.material_id = m.id
      LEFT JOIN locations l ON mt.location_id = l.id
      LEFT JOIN users u ON mt.created_by = u.id
      WHERE mt.type IN ('adjustment', 'wastage')
      ORDER BY mt.created_at DESC
      LIMIT 20
    `).all();

    // Wastage summary (last 30 days)
    const wastageSummary = db.prepare(`
      SELECT m.name as material_name,
        SUM(ABS(mt.quantity)) as wasted_qty,
        COUNT(*) as incidents
      FROM material_transactions mt
      JOIN materials m ON mt.material_id = m.id
      WHERE mt.type = 'wastage' AND date(mt.created_at) >= date('now', '-30 days')
      GROUP BY mt.material_id
      ORDER BY wasted_qty DESC
      LIMIT 10
    `).all();

    res.json({
      success: true,
      data: {
        stockLevels,
        lowStock,
        productStock,
        recentTransactions,
        wastageSummary,
        totalMaterials: new Set(stockLevels.map(s => s.id)).size,
        totalLowStock: lowStock.length,
      },
    });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
// 3. CUSTOMER INSIGHTS
// ═══════════════════════════════════════════════════════════════
router.get('/customer-insights', authenticate, authorize('owner', 'manager'), (req, res, next) => {
  try {
    const db = getDb();
    const { from, to, limit } = req.query;
    const today = localToday();
    const dateFrom = from || (() => { const d = new Date(); d.setDate(d.getDate() - 30); return localDateStr(d); })();
    const dateTo = to || today;
    const topLimit = parseInt(limit) || 10;

    // Top customers by revenue
    const topByRevenue = db.prepare(`
      SELECT
        s.customer_id, s.customer_name, s.customer_phone,
        COUNT(*) as order_count,
        COALESCE(SUM(s.grand_total), 0) as total_spent,
        COALESCE(AVG(s.grand_total), 0) as avg_order,
        MAX(date(s.created_at)) as last_order_date
      FROM sales s
      WHERE date(s.created_at) BETWEEN ? AND ? AND s.status != 'cancelled' AND s.customer_name IS NOT NULL AND s.customer_name != ''
      GROUP BY COALESCE(s.customer_id, s.customer_phone)
      ORDER BY total_spent DESC
      LIMIT ?
    `).all(dateFrom, dateTo, topLimit);

    // Top customers by frequency
    const topByFrequency = db.prepare(`
      SELECT
        s.customer_id, s.customer_name, s.customer_phone,
        COUNT(*) as order_count,
        COALESCE(SUM(s.grand_total), 0) as total_spent,
        MAX(date(s.created_at)) as last_order_date
      FROM sales s
      WHERE date(s.created_at) BETWEEN ? AND ? AND s.status != 'cancelled' AND s.customer_name IS NOT NULL AND s.customer_name != ''
      GROUP BY COALESCE(s.customer_id, s.customer_phone)
      ORDER BY order_count DESC
      LIMIT ?
    `).all(dateFrom, dateTo, topLimit);

    // New vs returning
    const newVsReturning = db.prepare(`
      SELECT
        CASE WHEN prev.cnt > 0 THEN 'returning' ELSE 'new' END as type,
        COUNT(DISTINCT COALESCE(s.customer_id, s.customer_phone)) as customers,
        COALESCE(SUM(s.grand_total), 0) as revenue
      FROM sales s
      LEFT JOIN (
        SELECT COALESCE(customer_id, customer_phone) as ckey, COUNT(*) as cnt
        FROM sales WHERE date(created_at) < ? AND status != 'cancelled'
        GROUP BY ckey
      ) prev ON COALESCE(s.customer_id, s.customer_phone) = prev.ckey
      WHERE date(s.created_at) BETWEEN ? AND ? AND s.status != 'cancelled' AND s.customer_name IS NOT NULL AND s.customer_name != ''
      GROUP BY type
    `).all(dateFrom, dateFrom, dateTo);

    // Credit balances (outstanding)
    const creditBalances = db.prepare(`
      SELECT id, name, phone, credit_balance
      FROM users
      WHERE credit_balance > 0
      ORDER BY credit_balance DESC
      LIMIT 10
    `).all();

    const totalOutstanding = db.prepare(`
      SELECT COALESCE(SUM(credit_balance), 0) as total FROM users WHERE credit_balance > 0
    `).get();

    // Order type preference
    const orderTypes = db.prepare(`
      SELECT order_type, COUNT(*) as count, COALESCE(SUM(grand_total), 0) as revenue
      FROM sales
      WHERE date(created_at) BETWEEN ? AND ? AND status != 'cancelled'
      GROUP BY order_type
    `).all(dateFrom, dateTo);

    res.json({
      success: true,
      data: {
        period: { from: dateFrom, to: dateTo },
        topByRevenue,
        topByFrequency,
        newVsReturning,
        creditBalances,
        totalOutstanding: totalOutstanding.total,
        orderTypes,
      },
    });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
// 4. EMPLOYEE PERFORMANCE
// ═══════════════════════════════════════════════════════════════
router.get('/employee-performance', authenticate, authorize('owner', 'manager'), (req, res, next) => {
  try {
    const db = getDb();
    const { from, to, user_id } = req.query;
    const today = localToday();
    const dateFrom = from || (() => { const d = new Date(); d.setDate(d.getDate() - 30); return localDateStr(d); })();
    const dateTo = to || today;

    let userFilter = '';
    const params = [dateFrom, dateTo];
    if (user_id) {
      userFilter = 'AND u.id = ?';
      params.push(user_id);
    }

    // Sales performance by employee
    const salesPerformance = db.prepare(`
      SELECT
        u.id as user_id, u.name, u.role,
        COUNT(s.id) as total_sales,
        COALESCE(SUM(s.grand_total), 0) as total_revenue,
        COALESCE(AVG(s.grand_total), 0) as avg_sale
      FROM users u
      LEFT JOIN sales s ON s.created_by = u.id AND date(s.created_at) BETWEEN ? AND ? AND s.status != 'cancelled'
      WHERE u.role IN ('owner', 'manager', 'employee') ${userFilter}
      GROUP BY u.id
      ORDER BY total_revenue DESC
    `).all(...params);

    // Production performance
    const productionPerformance = db.prepare(`
      SELECT
        u.id as user_id, u.name,
        COUNT(pl.id) as items_produced,
        COALESCE(SUM(pl.quantity), 0) as total_qty
      FROM users u
      LEFT JOIN production_logs pl ON pl.produced_by = u.id AND date(pl.created_at) BETWEEN ? AND ?
      WHERE u.role IN ('owner', 'manager', 'employee') ${userFilter}
      GROUP BY u.id
      ORDER BY total_qty DESC
    `).all(...params);

    // Attendance summary
    const attendanceSummary = db.prepare(`
      SELECT
        u.id as user_id, u.name,
        COUNT(DISTINCT a.date) as days_present,
        COALESCE(SUM(a.total_hours), 0) as total_hours,
        SUM(CASE WHEN a.late_arrival = 1 THEN 1 ELSE 0 END) as late_days
      FROM users u
      LEFT JOIN attendance a ON a.user_id = u.id AND a.date BETWEEN ? AND ? AND a.clock_in IS NOT NULL
      WHERE u.role IN ('owner', 'manager', 'employee', 'delivery_partner') ${userFilter}
      GROUP BY u.id
      ORDER BY total_hours DESC
    `).all(...params);

    // Delivery performance (for delivery partners)
    const deliveryPerformance = db.prepare(`
      SELECT
        u.id as user_id, u.name,
        COUNT(d.id) as total_deliveries,
        COUNT(CASE WHEN d.status = 'delivered' THEN 1 END) as completed,
        COUNT(CASE WHEN d.status = 'failed' THEN 1 END) as failed,
        COALESCE(AVG(
          CASE WHEN d.delivered_time IS NOT NULL AND d.pickup_time IS NOT NULL
          THEN (julianday(d.delivered_time) - julianday(d.pickup_time)) * 24 * 60
          END
        ), 0) as avg_delivery_minutes
      FROM users u
      LEFT JOIN deliveries d ON d.delivery_partner_id = u.id AND date(d.created_at) BETWEEN ? AND ?
      WHERE u.role = 'delivery_partner' ${userFilter}
      GROUP BY u.id
      ORDER BY total_deliveries DESC
    `).all(...params);

    res.json({
      success: true,
      data: {
        period: { from: dateFrom, to: dateTo },
        salesPerformance,
        productionPerformance,
        attendanceSummary,
        deliveryPerformance,
      },
    });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
// 5. DASHBOARD OVERVIEW (quick KPIs)
// ═══════════════════════════════════════════════════════════════
router.get('/dashboard', authenticate, authorize('owner', 'manager'), (req, res, next) => {
  try {
    const db = getDb();
    const today = localToday();
    const { location_id } = req.query;

    const locFilter = location_id ? 'AND s.location_id = ?' : '';
    const locParams = location_id ? [location_id] : [];

    // Today's sales
    const todaySales = db.prepare(`
      SELECT COUNT(*) as orders, COALESCE(SUM(grand_total), 0) as revenue
      FROM sales s WHERE date(s.created_at) = ? AND s.status != 'cancelled' ${locFilter}
    `).get(today, ...locParams);

    // Yesterday's sales (for comparison)
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth()+1).padStart(2,'0')}-${String(yesterday.getDate()).padStart(2,'0')}`;
    const yesterdaySales = db.prepare(`
      SELECT COUNT(*) as orders, COALESCE(SUM(grand_total), 0) as revenue
      FROM sales s WHERE date(s.created_at) = ? AND s.status != 'cancelled' ${locFilter}
    `).get(yesterdayStr, ...locParams);

    // This week
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    const weekStartStr = `${weekStart.getFullYear()}-${String(weekStart.getMonth()+1).padStart(2,'0')}-${String(weekStart.getDate()).padStart(2,'0')}`;
    const weekSales = db.prepare(`
      SELECT COUNT(*) as orders, COALESCE(SUM(grand_total), 0) as revenue
      FROM sales s WHERE date(s.created_at) BETWEEN ? AND ? AND s.status != 'cancelled' ${locFilter}
    `).get(weekStartStr, today, ...locParams);

    // This month
    const monthStart = `${today.slice(0, 8)}01`;
    const monthSales = db.prepare(`
      SELECT COUNT(*) as orders, COALESCE(SUM(grand_total), 0) as revenue
      FROM sales s WHERE date(s.created_at) BETWEEN ? AND ? AND s.status != 'cancelled' ${locFilter}
    `).get(monthStart, today, ...locParams);

    // Pending orders
    const pendingOrders = db.prepare(`
      SELECT COUNT(*) as count FROM sales s WHERE s.status IN ('pending', 'preparing') ${locFilter}
    `).get(...locParams);

    // Today's expenses
    const todayExpenses = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total FROM expenses
      WHERE date(created_at) = ? ${location_id ? 'AND location_id = ?' : ''}
    `).get(...(location_id ? [today, location_id] : [today]));

    // Staff present today
    const staffPresent = db.prepare(`
      SELECT COUNT(DISTINCT user_id) as count FROM attendance WHERE date = ? AND clock_in IS NOT NULL AND clock_out IS NULL
    `).get(today);

    // Low stock count
    const lowStockCount = db.prepare(`
      SELECT COUNT(*) as count FROM (
        SELECT m.id FROM materials m
        LEFT JOIN material_stock ms ON m.id = ms.material_id
        GROUP BY m.id
        HAVING COALESCE(SUM(ms.quantity), 0) <= m.min_stock_alert AND m.min_stock_alert > 0
      )
    `).get();

    // Hourly sales today (for chart)
    const hourlySales = db.prepare(`
      SELECT
        CAST(strftime('%H', s.created_at) AS INTEGER) as hour,
        COUNT(*) as orders,
        COALESCE(SUM(s.grand_total), 0) as revenue
      FROM sales s
      WHERE date(s.created_at) = ? AND s.status != 'cancelled' ${locFilter}
      GROUP BY hour
      ORDER BY hour
    `).all(today, ...locParams);

    // Last 7 days trend
    const dailyTrend = db.prepare(`
      SELECT
        date(s.created_at) as day,
        COUNT(*) as orders,
        COALESCE(SUM(s.grand_total), 0) as revenue
      FROM sales s
      WHERE date(s.created_at) >= date(?, '-6 days') AND s.status != 'cancelled' ${locFilter}
      GROUP BY day
      ORDER BY day
    `).all(today, ...locParams);

    res.json({
      success: true,
      data: {
        today: { ...todaySales, expenses: todayExpenses.total, net: todaySales.revenue - todayExpenses.total },
        yesterday: yesterdaySales,
        week: weekSales,
        month: monthSales,
        revenueChange: yesterdaySales.revenue > 0 ? ((todaySales.revenue - yesterdaySales.revenue) / yesterdaySales.revenue * 100) : 0,
        pendingOrders: pendingOrders.count,
        staffPresent: staffPresent.count,
        lowStockAlerts: lowStockCount.count,
        hourlySales,
        dailyTrend,
      },
    });
  } catch (err) { next(err); }
});

module.exports = router;
