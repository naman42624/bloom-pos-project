const express = require('express');
const router = express.Router();
const { getDb } = require('../config/database');
const { getDb: getAsyncDb } = require('../config/database-async');
const { authenticate, authorize } = require('../middleware/auth');
const { todayStr: localToday } = require('../utils/time');

function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// ═══════════════════════════════════════════════════════════════
// 1. SALES SUMMARY
// ═══════════════════════════════════════════════════════════════
router.get('/sales-summary', authenticate, authorize('owner', 'manager'), async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const { from, to, location_id, group_by } = req.query;
    const today = localToday();
    const dateFrom = from || today;
    const dateTo = to || today;
    const grouping = group_by || 'day'; // day, week, month

    let dateExpr;
    if (grouping === 'month') dateExpr = "to_char(s.created_at, 'YYYY-MM')";
    else if (grouping === 'week') dateExpr = "to_char(date_trunc('week', s.created_at), 'IYYY-\"W\"IW')";
    else dateExpr = "date(s.created_at)";

    let where = "WHERE date(s.created_at) BETWEEN ? AND ? AND s.status != 'cancelled'";
    const params = [dateFrom, dateTo];

    if (location_id) {
      where += ' AND s.location_id = ?';
      params.push(location_id);
    }

    // Overall totals
    const totals = await db.prepare(`
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
    const breakdown = await db.prepare(`
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
    const paymentMethods = await db.prepare(`
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
    const topProducts = await db.prepare(`
      SELECT
        si.product_name,
        SUM(si.quantity) as total_qty,
        -- line_total is 0 on older databases that never computed it, so fall back to quantity x price + tax
        SUM(CASE WHEN COALESCE(si.line_total, 0) > 0 THEN si.line_total
                 ELSE si.quantity * si.unit_price + COALESCE(si.tax_amount, 0) END) as total_revenue
      FROM sale_items si
      JOIN sales s ON si.sale_id = s.id
      ${where}
      GROUP BY si.product_name
      ORDER BY total_revenue DESC
      LIMIT 10
    `).all(...params);

    // By location
    const byLocation = await db.prepare(`
      SELECT
        l.name as location_name,
        COUNT(*) as orders,
        COALESCE(SUM(s.grand_total), 0) as revenue
      FROM sales s
      JOIN locations l ON s.location_id = l.id
      ${where}
      GROUP BY s.location_id, l.name
      ORDER BY revenue DESC
    `).all(...params);

    // Refunds
    const refunds = await db.prepare(`
      SELECT
        COUNT(*) as refund_count,
        COALESCE(SUM(r.amount), 0) as refund_total
      FROM refunds r
      JOIN sales s ON r.sale_id = s.id
      ${where}
    `).get(...params);

    // Expenses
    const expenses = await db.prepare(`
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
router.get('/inventory', authenticate, authorize('owner', 'manager'), async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const { location_id } = req.query;

    // Material stock levels
    let stockWhere = location_id ? 'WHERE ms.location_id = ?' : '';
    const stockParams = location_id ? [location_id] : [];

    const stockLevels = await db.prepare(`
      SELECT
        m.id, m.name, m.min_stock_alert,
        COALESCE(SUM(ms.quantity), 0) as total_stock,
        l.name as location_name, ms.quantity as location_stock
      FROM materials m
      LEFT JOIN material_stock ms ON m.id = ms.material_id
      LEFT JOIN locations l ON ms.location_id = l.id
      ${stockWhere}
      GROUP BY m.id, m.name, m.min_stock_alert, ms.location_id, l.name, ms.quantity
      ORDER BY m.name
    `).all(...stockParams);

    // Low stock alerts
    const lowStock = await db.prepare(`
      SELECT m.id, m.name, m.min_stock_alert,
        COALESCE(SUM(ms.quantity), 0) as total_stock
      FROM materials m
      LEFT JOIN material_stock ms ON m.id = ms.material_id
      ${location_id ? 'WHERE ms.location_id = ?' : ''}
      Group BY m.id
      HAVING COALESCE(SUM(ms.quantity), 0) <= m.min_stock_alert AND m.min_stock_alert > 0
      ORDER BY (COALESCE(SUM(ms.quantity), 0) * 1.0 / GREATEST(m.min_stock_alert, 1)) ASC
    `).all(...(location_id ? [location_id] : []));

    // Product stock
    const productStock = await db.prepare(`
      SELECT p.id, p.name,
        COALESCE(SUM(ps.quantity), 0) as total_stock
      FROM products p
      LEFT JOIN product_stock ps ON p.id = ps.product_id
      ${location_id ? 'WHERE ps.location_id = ?' : ''}
      GROUP BY p.id
      ORDER BY p.name
    `).all(...(location_id ? [location_id] : []));

    // Recent transactions (wastage, adjustments, etc.)
    const recentTransactions = await db.prepare(`
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
    const wastageSummary = await db.prepare(`
      SELECT m.name as material_name,
        SUM(ABS(mt.quantity)) as wasted_qty,
        COUNT(*) as incidents
      FROM material_transactions mt
      JOIN materials m ON mt.material_id = m.id
      WHERE mt.type = 'wastage' AND date(mt.created_at) >= (CURRENT_DATE - INTERVAL '30 days')
      GROUP BY mt.material_id, m.name
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
router.get('/customer-insights', authenticate, authorize('owner', 'manager'), async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const { from, to, limit } = req.query;
    const today = localToday();
    const dateFrom = from || (() => { const d = new Date(); d.setDate(d.getDate() - 30); return localDateStr(d); })();
    const dateTo = to || today;
    const topLimit = parseInt(limit) || 10;

    // Top customers by revenue
    const topByRevenue = await db.prepare(`
      SELECT
        s.customer_id, s.customer_name, s.customer_phone,
        COUNT(*) as order_count,
        COALESCE(SUM(s.grand_total), 0) as total_spent,
        COALESCE(AVG(s.grand_total), 0) as avg_order,
        MAX(date(s.created_at)) as last_order_date
      FROM sales s
      WHERE date(s.created_at) BETWEEN ? AND ? AND s.status != 'cancelled' AND s.customer_name IS NOT NULL AND s.customer_name != ''
      GROUP BY COALESCE(s.customer_id::text, s.customer_phone), s.customer_id, s.customer_name, s.customer_phone
      ORDER BY total_spent DESC
      LIMIT ?
    `).all(dateFrom, dateTo, topLimit);

    // Top customers by frequency
    const topByFrequency = await db.prepare(`
      SELECT
        s.customer_id, s.customer_name, s.customer_phone,
        COUNT(*) as order_count,
        COALESCE(SUM(s.grand_total), 0) as total_spent,
        MAX(date(s.created_at)) as last_order_date
      FROM sales s
      WHERE date(s.created_at) BETWEEN ? AND ? AND s.status != 'cancelled' AND s.customer_name IS NOT NULL AND s.customer_name != ''
      GROUP BY COALESCE(s.customer_id::text, s.customer_phone), s.customer_id, s.customer_name, s.customer_phone
      ORDER BY order_count DESC
      LIMIT ?
    `).all(dateFrom, dateTo, topLimit);

    // New vs returning
    const newVsReturning = await db.prepare(`
      SELECT
        CASE WHEN prev.cnt > 0 THEN 'returning' ELSE 'new' END as type,
        COUNT(DISTINCT COALESCE(s.customer_id::text, s.customer_phone)) as customers,
        COALESCE(SUM(s.grand_total), 0) as revenue
      FROM sales s
      LEFT JOIN (
        SELECT COALESCE(customer_id::text, customer_phone) as ckey, COUNT(*) as cnt
        FROM sales WHERE date(created_at) < ? AND status != 'cancelled'
        GROUP BY ckey
      ) prev ON COALESCE(s.customer_id::text, s.customer_phone) = prev.ckey
      WHERE date(s.created_at) BETWEEN ? AND ? AND s.status != 'cancelled' AND s.customer_name IS NOT NULL AND s.customer_name != ''
      GROUP BY type
    `).all(dateFrom, dateFrom, dateTo);

    // Credit balances (outstanding)
    const creditBalances = await db.prepare(`
      SELECT id, name, phone, credit_balance
      FROM users
      WHERE credit_balance > 0
      ORDER BY credit_balance DESC
      LIMIT 10
    `).all();

    const totalOutstanding = await db.prepare(`
      SELECT COALESCE(SUM(credit_balance), 0) as total FROM users WHERE credit_balance > 0
    `).get();

    // Order type preference
    const orderTypes = await db.prepare(`
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
router.get('/employee-performance', authenticate, authorize('owner', 'manager'), async (req, res, next) => {
  try {
    const db = await getAsyncDb();
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
    const salesPerformance = await db.prepare(`
      SELECT
        u.id as user_id, u.name, u.role,
        COUNT(s.id) as total_sales,
        COALESCE(SUM(s.grand_total), 0) as total_revenue,
        COALESCE(AVG(s.grand_total), 0) as avg_sale
      FROM users u
      LEFT JOIN sales s ON s.created_by = u.id AND date(s.created_at) BETWEEN ? AND ? AND s.status != 'cancelled'
      WHERE u.role IN ('owner', 'manager', 'employee', 'counter_staff') ${userFilter}
      GROUP BY u.id
      ORDER BY total_revenue DESC
    `).all(...params);

    // Production performance
    const productionPerformance = await db.prepare(`
      SELECT
        u.id as user_id, u.name,
        COUNT(pl.id) as items_produced,
        COALESCE(SUM(pl.quantity), 0) as total_qty
      FROM users u
      LEFT JOIN production_logs pl ON pl.produced_by = u.id AND date(pl.created_at) BETWEEN ? AND ?
      WHERE u.role IN ('owner', 'manager', 'employee', 'counter_staff') ${userFilter}
      GROUP BY u.id
      ORDER BY total_qty DESC
    `).all(...params);

    // Attendance summary
    const attendanceSummary = await db.prepare(`
      SELECT
        u.id as user_id, u.name,
        COUNT(DISTINCT a.date) as days_present,
        COALESCE(SUM(a.total_hours), 0) as total_hours,
        COUNT(DISTINCT CASE WHEN a.late_arrival = 1 THEN a.date END) as late_days
      FROM users u
      LEFT JOIN attendance a ON a.user_id = u.id AND a.date BETWEEN ? AND ? AND a.clock_in IS NOT NULL
      WHERE u.role IN ('owner', 'manager', 'employee', 'counter_staff', 'delivery_partner') ${userFilter}
      GROUP BY u.id
      ORDER BY total_hours DESC
    `).all(...params);

    // Delivery performance (for delivery partners)
    const deliveryPerformance = await db.prepare(`
      SELECT
        u.id as user_id, u.name,
        COUNT(d.id) as total_deliveries,
        COUNT(CASE WHEN d.status = 'delivered' THEN 1 END) as completed,
        COUNT(CASE WHEN d.status = 'failed' THEN 1 END) as failed,
        COALESCE(AVG(
          CASE WHEN d.delivered_time IS NOT NULL AND d.pickup_time IS NOT NULL
          THEN EXTRACT(EPOCH FROM (d.delivered_time::timestamp - d.pickup_time::timestamp)) / 60
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
router.get('/dashboard', authenticate, authorize('owner', 'manager'), async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const today = localToday();
    const { location_id } = req.query;

    const locFilter = location_id ? 'AND s.location_id = ?' : '';
    const locParams = location_id ? [location_id] : [];

    // Yesterday's sales (for comparison)
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth()+1).padStart(2,'0')}-${String(yesterday.getDate()).padStart(2,'0')}`;

    // This week
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    const weekStartStr = `${weekStart.getFullYear()}-${String(weekStart.getMonth()+1).padStart(2,'0')}-${String(weekStart.getDate()).padStart(2,'0')}`;

    // This month
    const monthStart = `${today.slice(0, 8)}01`;

    // Run all independent dashboard queries in parallel
    const [
      todaySales,
      yesterdaySales,
      weekSales,
      monthSales,
      pendingOrders,
      todayExpenses,
      staffPresent,
      lowStockCount,
      hourlySales,
      dailyTrend,
    ] = await Promise.all([
      db.prepare(`
        SELECT COUNT(*) as orders, COALESCE(SUM(grand_total), 0) as revenue
        FROM sales s WHERE date(s.created_at) = ? AND s.status != 'cancelled' ${locFilter}
      `).get(today, ...locParams),
      db.prepare(`
        SELECT COUNT(*) as orders, COALESCE(SUM(grand_total), 0) as revenue
        FROM sales s WHERE date(s.created_at) = ? AND s.status != 'cancelled' ${locFilter}
      `).get(yesterdayStr, ...locParams),
      db.prepare(`
        SELECT COUNT(*) as orders, COALESCE(SUM(grand_total), 0) as revenue
        FROM sales s WHERE date(s.created_at) BETWEEN ? AND ? AND s.status != 'cancelled' ${locFilter}
      `).get(weekStartStr, today, ...locParams),
      db.prepare(`
        SELECT COUNT(*) as orders, COALESCE(SUM(grand_total), 0) as revenue
        FROM sales s WHERE date(s.created_at) BETWEEN ? AND ? AND s.status != 'cancelled' ${locFilter}
      `).get(monthStart, today, ...locParams),
      db.prepare(`
        SELECT COUNT(*) as count FROM sales s WHERE s.status IN ('pending', 'preparing') ${locFilter}
      `).get(...locParams),
      db.prepare(`
        SELECT COALESCE(SUM(amount), 0) as total FROM expenses
        WHERE date(created_at) = ? ${location_id ? 'AND location_id = ?' : ''}
      `).get(...(location_id ? [today, location_id] : [today])),
      db.prepare(`
        SELECT COUNT(DISTINCT user_id) as count FROM attendance WHERE date = ? AND clock_in IS NOT NULL AND clock_out IS NULL
      `).get(today),
      db.prepare(`
        SELECT COUNT(*) as count FROM (
          SELECT m.id FROM materials m
          LEFT JOIN material_stock ms ON m.id = ms.material_id
          GROUP BY m.id
          HAVING COALESCE(SUM(ms.quantity), 0) <= m.min_stock_alert AND m.min_stock_alert > 0
        )
      `).get(),
      db.prepare(`
        SELECT
          EXTRACT(HOUR FROM s.created_at::timestamp)::INTEGER as hour,
          COUNT(*) as orders,
          COALESCE(SUM(s.grand_total), 0) as revenue
        FROM sales s
        WHERE date(s.created_at) = ? AND s.status != 'cancelled' ${locFilter}
        GROUP BY hour
        ORDER BY hour
      `).all(today, ...locParams),
      db.prepare(`
        SELECT
          date(s.created_at) as day,
          COUNT(*) as orders,
          COALESCE(SUM(s.grand_total), 0) as revenue
        FROM sales s
        WHERE date(s.created_at) >= (?::date - INTERVAL '6 days') AND s.status != 'cancelled' ${locFilter}
        GROUP BY day
        ORDER BY day
      `).all(today, ...locParams),
    ]);

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

// ═══════════════════════════════════════════════════════════════
// STAFF SALES (owner only): orders, amount, discounts, undos per seller
// Seller = COALESCE(sold_by, created_by). Cancelled sales count nowhere.
// ═══════════════════════════════════════════════════════════════
function staffSalesRange(req) {
  const today = localToday();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : today;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : today;
  const locationId = req.query.location_id ? parseInt(req.query.location_id, 10) : null;
  return { from, to, locationId: Number.isInteger(locationId) ? locationId : null };
}

router.get('/staff-sales', authenticate, authorize('owner'), async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const { from, to, locationId } = staffSalesRange(req);
    const locSql = locationId ? ' AND s.location_id = ?' : '';
    const locParams = locationId ? [locationId] : [];
    const inPeriod = (col) => `${col} >= ?::date AND ${col} < (?::date + 1)`;

    const sold = await db.prepare(`
      SELECT COALESCE(s.sold_by, s.created_by) AS user_id,
        COUNT(*) AS orders,
        COALESCE(SUM(s.grand_total), 0) AS amount,
        COUNT(*) FILTER (WHERE COALESCE(s.discount_amount, 0) > 0) AS discount_count,
        COALESCE(SUM(s.discount_amount) FILTER (WHERE COALESCE(s.discount_amount, 0) > 0), 0) AS discount_total,
        COUNT(*) FILTER (WHERE s.discount_approved_by IS NOT NULL
          AND s.discount_approved_by <> COALESCE(s.sold_by, s.created_by)) AS override_count
      FROM sales s
      WHERE ${inPeriod('s.created_at')} AND s.status != 'cancelled'${locSql}
      GROUP BY COALESCE(s.sold_by, s.created_by)
    `).all(from, to, ...locParams);

    const refunded = await db.prepare(`
      SELECT COALESCE(s.sold_by, s.created_by) AS user_id, COALESCE(SUM(r.amount), 0) AS refunds
      FROM refunds r JOIN sales s ON s.id = r.sale_id
      WHERE COALESCE(r.status, 'processed') = 'processed'
        AND ${inPeriod('s.created_at')} AND s.status != 'cancelled'${locSql}
      GROUP BY COALESCE(s.sold_by, s.created_by)
    `).all(from, to, ...locParams);

    const undone = await db.prepare(`
      SELECT s.undone_by AS user_id, COUNT(*) AS undone_count, COALESCE(SUM(s.grand_total), 0) AS undone_total
      FROM sales s
      WHERE s.entry_mode = 'quick' AND s.undone_by IS NOT NULL
        AND ${inPeriod('s.undone_at')}${locSql}
      GROUP BY s.undone_by
    `).all(from, to, ...locParams);

    const topups = await db.prepare(`
      SELECT s.created_by AS user_id, COUNT(*) AS topup_count, COALESCE(SUM(s.grand_total), 0) AS topup_total
      FROM sales s
      WHERE s.entry_mode = 'close_topup' AND s.status != 'cancelled'
        AND ${inPeriod('s.created_at')}${locSql}
      GROUP BY s.created_by
    `).all(from, to, ...locParams);

    const byUser = new Map();
    const blank = (id) => ({
      user_id: id, orders: 0, amount: 0, refunds: 0, net: 0, discount_count: 0, discount_total: 0,
      override_count: 0, undone_count: 0, undone_total: 0, topup_count: 0, topup_total: 0,
    });
    const merge = (list) => {
      for (const r of list) {
        if (r.user_id == null) continue;
        const row = byUser.get(r.user_id) || blank(r.user_id);
        for (const k of Object.keys(r)) if (k !== 'user_id') row[k] = Number(r[k]);
        byUser.set(r.user_id, row);
      }
    };
    [sold, refunded, undone, topups].forEach(merge);

    const ids = [...byUser.keys()];
    const people = ids.length
      ? await db.prepare(`SELECT id, name, role, is_active FROM users WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)
      : [];
    const personById = new Map(people.map((u) => [u.id, u]));

    const rows = [...byUser.values()].map((r) => {
      const u = personById.get(r.user_id) || {};
      const net = Math.round((r.amount - r.refunds) * 100) / 100;
      return { ...r, name: u.name || `User #${r.user_id}`, role: u.role || null, is_active: u.is_active, net };
    }).sort((a, b) => b.net - a.net);

    res.json({ success: true, data: { from, to, rows } });
  } catch (err) { next(err); }
});

router.get('/staff-sales/:userId/sales', authenticate, authorize('owner'), async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const { from, to, locationId } = staffSalesRange(req);
    const userId = parseInt(req.params.userId, 10);
    if (!Number.isInteger(userId)) return res.status(400).json({ success: false, message: 'Pick a person from the list.' });
    const params = [userId, from, to];
    let locSql = '';
    if (locationId) { locSql = ' AND s.location_id = ?'; params.push(locationId); }
    const rows = await db.prepare(`
      SELECT s.id, s.sale_number, s.created_at, s.grand_total, s.status, s.order_type, s.customer_name
      FROM sales s
      WHERE COALESCE(s.sold_by, s.created_by) = ? AND s.status != 'cancelled'
        AND s.created_at >= ?::date AND s.created_at < (?::date + 1)${locSql}
      ORDER BY s.created_at DESC, s.id DESC
    `).all(...params);
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

module.exports = router;
