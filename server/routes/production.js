const express = require('express');
const { body, query, validationResult } = require('express-validator');
const { getDb } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { createNotification, notifyByRole } = require('./notifications');
const { todayStr: localToday } = require('../utils/time');

const router = express.Router();

// ═══════════════════════════════════════════════════════════════
// PRODUCE — Staff makes products for display (not tied to an order)
// ═══════════════════════════════════════════════════════════════

router.post(
  '/produce',
  authenticate,
  authorize('owner', 'manager', 'employee'),
  [
    body('product_id').isInt().withMessage('Product is required'),
    body('location_id').isInt().withMessage('Location is required'),
    body('quantity').isInt({ min: 1 }).withMessage('Quantity must be at least 1'),
    body('notes').optional().trim(),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });

      const db = getDb();
      const { product_id, location_id, quantity, notes } = req.body;

      // Get product & BOM
      const product = db.prepare('SELECT id, name FROM products WHERE id = ? AND is_active = 1').get(product_id);
      if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

      const bom = db.prepare('SELECT material_id, quantity as qty_needed FROM product_materials WHERE product_id = ?').all(product_id);
      if (bom.length === 0) return res.status(400).json({ success: false, message: 'Product has no BOM — cannot produce' });

      // Check material availability
      const getStock = db.prepare('SELECT quantity FROM material_stock WHERE material_id = ? AND location_id = ?');
      for (const b of bom) {
        const needed = b.qty_needed * quantity;
        const stock = getStock.get(b.material_id, location_id);
        if (!stock || stock.quantity < needed) {
          const mat = db.prepare('SELECT name FROM materials WHERE id = ?').get(b.material_id);
          return res.status(400).json({
            success: false,
            message: `Insufficient ${mat?.name || 'material'}: need ${needed}, have ${stock?.quantity || 0}`,
          });
        }
      }

      const produce = db.transaction(() => {
        // 1. Deduct materials
        const deductStock = db.prepare('UPDATE material_stock SET quantity = quantity - ?, updated_at = CURRENT_TIMESTAMP WHERE material_id = ? AND location_id = ?');
        const logMaterialTx = db.prepare(
          `INSERT INTO material_transactions (material_id, location_id, type, quantity, reference_type, reference_id, notes, created_by)
           VALUES (?, ?, 'usage', ?, 'production', ?, ?, ?)`
        );
        for (const b of bom) {
          const usedQty = b.qty_needed * quantity;
          deductStock.run(usedQty, b.material_id, location_id);
          logMaterialTx.run(b.material_id, location_id, usedQty, product_id, `Produced ${quantity}x ${product.name}`, req.user.id);
        }

        // 2. Add to product_stock
        const existing = db.prepare('SELECT id, quantity FROM product_stock WHERE product_id = ? AND location_id = ?').get(product_id, location_id);
        if (existing) {
          db.prepare('UPDATE product_stock SET quantity = quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(quantity, existing.id);
        } else {
          db.prepare('INSERT INTO product_stock (product_id, location_id, quantity) VALUES (?, ?, ?)').run(product_id, location_id, quantity);
        }

        // 3. Log production
        const logResult = db.prepare(
          'INSERT INTO production_logs (product_id, location_id, quantity, produced_by, notes) VALUES (?, ?, ?, ?, ?)'
        ).run(product_id, location_id, quantity, req.user.id, notes || '');

        return logResult.lastInsertRowid;
      });

      const logId = produce();
      const log = db.prepare(`
        SELECT pl.*, p.name as product_name, u.name as produced_by_name
        FROM production_logs pl
        JOIN products p ON pl.product_id = p.id
        JOIN users u ON pl.produced_by = u.id
        WHERE pl.id = ?
      `).get(logId);

      // Return updated stock
      const stock = db.prepare('SELECT quantity FROM product_stock WHERE product_id = ? AND location_id = ?').get(product_id, location_id);

      res.status(201).json({ success: true, data: { log, ready_qty: stock?.quantity || 0 } });
    } catch (err) { next(err); }
  }
);

// ═══════════════════════════════════════════════════════════════
// CUSTOM PRODUCE — Create a product on the fly and add to stock
// ═══════════════════════════════════════════════════════════════

router.post(
  '/produce/custom',
  authenticate,
  authorize('owner', 'manager', 'employee'),
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('location_id').isInt().withMessage('Location is required'),
    body('quantity').isInt({ min: 1 }).withMessage('Quantity must be at least 1'),
    body('selling_price').isFloat({ min: 0 }).withMessage('Price is required'),
    body('category').optional().trim(),
    body('materials').optional().isArray(),
    body('notes').optional().trim(),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });

      const db = getDb();
      const { name, location_id, quantity, selling_price, category, materials, notes } = req.body;

      const loc = db.prepare('SELECT id FROM locations WHERE id = ?').get(location_id);
      if (!loc) return res.status(404).json({ success: false, message: 'Location not found' });

      const result = db.transaction(() => {
        // 1. Create the product
        const sku = 'CUST-' + Date.now().toString(36).toUpperCase();
        const prodResult = db.prepare(
          `INSERT INTO products (name, sku, category, type, selling_price, is_active, created_by)
           VALUES (?, ?, ?, 'standard', ?, 1, ?)`
        ).run(name, sku, category || 'other', selling_price, req.user.id);
        const productId = prodResult.lastInsertRowid;

        // 2. Add BOM materials and deduct stock if provided
        if (materials && materials.length > 0) {
          const getStock = db.prepare('SELECT quantity FROM material_stock WHERE material_id = ? AND location_id = ?');
          const deductStock = db.prepare('UPDATE material_stock SET quantity = quantity - ?, updated_at = CURRENT_TIMESTAMP WHERE material_id = ? AND location_id = ?');
          const logTx = db.prepare(
            `INSERT INTO material_transactions (material_id, location_id, type, quantity, reference_type, reference_id, notes, created_by)
             VALUES (?, ?, 'usage', ?, 'production', ?, ?, ?)`
          );
          const insertBom = db.prepare('INSERT INTO product_materials (product_id, material_id, quantity) VALUES (?, ?, ?)');

          for (const m of materials) {
            if (!m.material_id || !m.quantity || m.quantity <= 0) continue;
            insertBom.run(productId, m.material_id, m.quantity);

            const totalNeeded = m.quantity * quantity;
            const stock = getStock.get(m.material_id, location_id);
            if (stock && stock.quantity >= totalNeeded) {
              deductStock.run(totalNeeded, m.material_id, location_id);
              logTx.run(m.material_id, location_id, totalNeeded, productId, `Custom produced ${quantity}x ${name}`, req.user.id);
            }
          }
        }

        // 3. Add to product_stock
        db.prepare('INSERT INTO product_stock (product_id, location_id, quantity) VALUES (?, ?, ?)').run(productId, location_id, quantity);

        // 4. Log production
        const logResult = db.prepare(
          'INSERT INTO production_logs (product_id, location_id, quantity, produced_by, notes) VALUES (?, ?, ?, ?, ?)'
        ).run(productId, location_id, quantity, req.user.id, notes || `Custom: ${name}`);

        return { productId, logId: logResult.lastInsertRowid };
      })();

      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(result.productId);
      const stock = db.prepare('SELECT quantity FROM product_stock WHERE product_id = ? AND location_id = ?').get(result.productId, location_id);

      res.status(201).json({
        success: true,
        data: { product, ready_qty: stock?.quantity || 0 },
      });
    } catch (err) { next(err); }
  }
);

// ═══════════════════════════════════════════════════════════════
// PRODUCT STOCK — Adjust ready product inventory
// ═══════════════════════════════════════════════════════════════

// GET /api/production/product-stock — Get all product stock across locations
router.get('/product-stock', authenticate, (req, res, next) => {
  try {
    const db = getDb();
    const { location_id } = req.query;

    let sql = `
      SELECT ps.*, p.name as product_name, p.sku, p.selling_price, p.image_url,
             l.name as location_name
      FROM product_stock ps
      JOIN products p ON ps.product_id = p.id
      JOIN locations l ON ps.location_id = l.id
      WHERE p.is_active = 1
    `;
    const params = [];
    if (location_id) { sql += ' AND ps.location_id = ?'; params.push(Number(location_id)); }
    sql += ' ORDER BY p.name ASC';

    const stock = db.prepare(sql).all(...params);
    res.json({ success: true, data: stock });
  } catch (err) { next(err); }
});

// POST /api/production/product-stock/adjust — Manual stock adjustment (wastage, correction)
router.post(
  '/product-stock/adjust',
  authenticate,
  authorize('owner', 'manager'),
  [
    body('product_id').isInt(),
    body('location_id').isInt(),
    body('adjustment').isNumeric().withMessage('Adjustment amount is required'),
    body('reason').optional().trim(),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });

      const db = getDb();
      const { product_id, location_id, adjustment, reason } = req.body;

      const existing = db.prepare('SELECT id, quantity FROM product_stock WHERE product_id = ? AND location_id = ?').get(product_id, location_id);
      const currentQty = existing ? existing.quantity : 0;
      const newQty = Math.max(0, currentQty + adjustment);

      if (existing) {
        db.prepare('UPDATE product_stock SET quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newQty, existing.id);
      } else {
        db.prepare('INSERT INTO product_stock (product_id, location_id, quantity) VALUES (?, ?, ?)').run(product_id, location_id, newQty);
      }

      // Log as production with notes indicating adjustment
      db.prepare(
        'INSERT INTO production_logs (product_id, location_id, quantity, produced_by, notes) VALUES (?, ?, ?, ?, ?)'
      ).run(product_id, location_id, adjustment, req.user.id, `Adjustment: ${reason}`);

      res.json({ success: true, data: { product_id, location_id, previous_qty: currentQty, new_qty: newQty } });
    } catch (err) { next(err); }
  }
);

// ═══════════════════════════════════════════════════════════════
// PRODUCTION TASKS — Order-driven task management
// ═══════════════════════════════════════════════════════════════

// GET /api/production/tasks — Get all production tasks (queue)
router.get('/tasks', authenticate, authorize('owner', 'manager', 'employee'), (req, res, next) => {
  try {
    const db = getDb();
    const { location_id, status, assigned_to, sale_id } = req.query;

    let sql = `
      SELECT pt.*,
             p.name as product_name, p.sku as product_sku, p.image_url as product_image,
             s.sale_number, s.order_type, s.customer_name, s.scheduled_date, s.scheduled_time, s.special_instructions,
             l.name as location_name,
             a.name as assigned_to_name,
             pk.name as picked_by_name
      FROM production_tasks pt
      JOIN products p ON pt.product_id = p.id
      JOIN sales s ON pt.sale_id = s.id
      JOIN locations l ON pt.location_id = l.id
      LEFT JOIN users a ON pt.assigned_to = a.id
      LEFT JOIN users pk ON pt.picked_by = pk.id
      WHERE pt.status != 'cancelled'
    `;
    const params = [];

    if (location_id) { sql += ' AND pt.location_id = ?'; params.push(Number(location_id)); }
    if (status) { sql += ' AND pt.status = ?'; params.push(status); }
    if (assigned_to) { sql += ' AND (pt.assigned_to = ? OR pt.picked_by = ?)'; params.push(Number(assigned_to), Number(assigned_to)); }
    if (sale_id) { sql += ' AND pt.sale_id = ?'; params.push(Number(sale_id)); }

    // Scope by location for employees and managers
    if (req.user.role === 'employee' || req.user.role === 'manager') {
      const userLocs = db.prepare('SELECT location_id FROM user_locations WHERE user_id = ?').all(req.user.id).map(r => r.location_id);
      if (userLocs.length > 0 && !location_id) {
        sql += ` AND pt.location_id IN (${userLocs.map(() => '?').join(',')})`;
        params.push(...userLocs);
      }
    }

    sql += ` ORDER BY
      CASE WHEN pt.status = 'completed' THEN 1 ELSE 0 END,
      CASE pt.priority WHEN 'urgent' THEN 0 ELSE 1 END,
      CASE pt.status WHEN 'in_progress' THEN 0 WHEN 'assigned' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END,
      s.scheduled_date ASC NULLS LAST,
      pt.created_at ASC`;

    const tasks = db.prepare(sql).all(...params);

    // Attach BOM (material composition) for each task
    const getBOM = db.prepare(`
      SELECT pm.material_id, pm.quantity as qty_per_unit,
             mat.name as material_name, mat.sku as material_sku,
             mat.image_url as material_image,
             mc.name as category_name, mc.unit
      FROM product_materials pm
      JOIN materials mat ON pm.material_id = mat.id
      JOIN material_categories mc ON mat.category_id = mc.id
      WHERE pm.product_id = ?
      ORDER BY mc.name, mat.name
    `);
    const getStock = db.prepare(
      'SELECT quantity FROM material_stock WHERE material_id = ? AND location_id = ?'
    );

    for (const task of tasks) {
      const bom = getBOM.all(task.product_id);
      task.materials = bom.map(b => {
        const stock = getStock.get(b.material_id, task.location_id);
        const needed = b.qty_per_unit * task.quantity;
        return {
          ...b,
          total_needed: needed,
          in_stock: stock ? stock.quantity : 0,
          sufficient: stock ? stock.quantity >= needed : false,
        };
      });
    }

    res.json({ success: true, data: tasks });
  } catch (err) { next(err); }
});

// GET /api/production/my-tasks — Current employee's tasks
router.get('/my-tasks', authenticate, (req, res, next) => {
  try {
    const db = getDb();
    const tasks = db.prepare(`
      SELECT pt.*,
             p.name as product_name, p.sku as product_sku, p.image_url as product_image,
             s.sale_number, s.order_type, s.customer_name, s.scheduled_date, s.scheduled_time, s.special_instructions,
             l.name as location_name
      FROM production_tasks pt
      JOIN products p ON pt.product_id = p.id
      JOIN sales s ON pt.sale_id = s.id
      JOIN locations l ON pt.location_id = l.id
      WHERE (pt.assigned_to = ? OR pt.picked_by = ?)
        AND pt.status IN ('assigned', 'in_progress')
      ORDER BY
        CASE pt.priority WHEN 'urgent' THEN 0 ELSE 1 END,
        pt.created_at ASC
    `).all(req.user.id, req.user.id);

    res.json({ success: true, data: tasks });
  } catch (err) { next(err); }
});

// PUT /api/production/tasks/:id/assign — Manager assigns task to employee
router.put(
  '/tasks/:id/assign',
  authenticate,
  authorize('owner', 'manager'),
  [body('assigned_to').isInt().withMessage('Employee is required')],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });

      const db = getDb();
      const task = db.prepare('SELECT * FROM production_tasks WHERE id = ?').get(req.params.id);
      if (!task) return res.status(404).json({ success: false, message: 'Task not found' });
      if (task.status === 'completed' || task.status === 'cancelled') {
        return res.status(400).json({ success: false, message: 'Cannot assign a finished task' });
      }

      const { assigned_to } = req.body;
      const employee = db.prepare("SELECT id, name FROM users WHERE id = ? AND role IN ('employee','manager','owner')").get(assigned_to);
      if (!employee) return res.status(404).json({ success: false, message: 'Employee not found' });

      db.prepare("UPDATE production_tasks SET assigned_to = ?, status = 'assigned', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(assigned_to, task.id);

      const updated = db.prepare(`
        SELECT pt.*, p.name as product_name, a.name as assigned_to_name
        FROM production_tasks pt
        JOIN products p ON pt.product_id = p.id
        LEFT JOIN users a ON pt.assigned_to = a.id
        WHERE pt.id = ?
      `).get(task.id);

      res.json({ success: true, data: updated });

      // Notify assigned employee
      createNotification({
        userIds: assigned_to,
        title: 'Task Assigned',
        body: `You've been assigned: ${task.quantity || ''}x ${updated.product_name || 'product'}`,
        type: 'production',
        data: { taskId: task.id, screen: 'ProductionQueue' },
      });
    } catch (err) { next(err); }
  }
);

// PUT /api/production/tasks/:id/pick — Employee self-picks a task
router.put(
  '/tasks/:id/pick',
  authenticate,
  authorize('owner', 'manager', 'employee'),
  (req, res, next) => {
    try {
      const db = getDb();
      const task = db.prepare('SELECT * FROM production_tasks WHERE id = ?').get(req.params.id);
      if (!task) return res.status(404).json({ success: false, message: 'Task not found' });
      if (task.status !== 'pending') {
        return res.status(400).json({ success: false, message: 'Only pending tasks can be picked' });
      }

      db.prepare("UPDATE production_tasks SET picked_by = ?, assigned_to = ?, status = 'assigned', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(req.user.id, req.user.id, task.id);

      const updated = db.prepare(`
        SELECT pt.*, p.name as product_name, a.name as assigned_to_name
        FROM production_tasks pt
        JOIN products p ON pt.product_id = p.id
        LEFT JOIN users a ON pt.assigned_to = a.id
        WHERE pt.id = ?
      `).get(task.id);

      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  }
);

// PUT /api/production/tasks/:id/start — Begin working on a task
router.put(
  '/tasks/:id/start',
  authenticate,
  authorize('owner', 'manager', 'employee'),
  (req, res, next) => {
    try {
      const db = getDb();
      const task = db.prepare('SELECT * FROM production_tasks WHERE id = ?').get(req.params.id);
      if (!task) return res.status(404).json({ success: false, message: 'Task not found' });
      if (task.status !== 'assigned') {
        return res.status(400).json({ success: false, message: 'Only assigned tasks can be started' });
      }
      // Only the assigned person or a manager can start
      if (req.user.role === 'employee' && task.assigned_to !== req.user.id) {
        return res.status(403).json({ success: false, message: 'Not your task' });
      }

      db.prepare("UPDATE production_tasks SET status = 'in_progress', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(task.id);

      // Also update the sale to 'preparing' if not already
      const sale = db.prepare('SELECT status FROM sales WHERE id = ?').get(task.sale_id);
      if (sale && sale.status === 'pending') {
        db.prepare("UPDATE sales SET status = 'preparing', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(task.sale_id);
      }

      res.json({ success: true, message: 'Task started' });
    } catch (err) { next(err); }
  }
);

// PUT /api/production/tasks/:id/complete — Task done: deduct materials, log production
router.put(
  '/tasks/:id/complete',
  authenticate,
  authorize('owner', 'manager', 'employee'),
  (req, res, next) => {
    try {
      const db = getDb();
      const task = db.prepare('SELECT * FROM production_tasks WHERE id = ?').get(req.params.id);
      if (!task) return res.status(404).json({ success: false, message: 'Task not found' });
      if (task.status === 'completed' || task.status === 'cancelled') {
        return res.status(400).json({ success: false, message: 'Task already finished' });
      }
      if (req.user.role === 'employee' && task.assigned_to !== req.user.id) {
        return res.status(403).json({ success: false, message: 'Not your task' });
      }

      const product = db.prepare('SELECT id, name FROM products WHERE id = ?').get(task.product_id);
      const bom = db.prepare('SELECT material_id, quantity as qty_needed FROM product_materials WHERE product_id = ?').all(task.product_id);
      const sale = db.prepare('SELECT sale_number FROM sales WHERE id = ?').get(task.sale_id);

      const completeTx = db.transaction(() => {
        // 1. Deduct materials via BOM
        if (bom.length > 0) {
          const deductStock = db.prepare('UPDATE material_stock SET quantity = GREATEST(0, quantity - ?), updated_at = CURRENT_TIMESTAMP WHERE material_id = ? AND location_id = ?');
          const logMaterialTx = db.prepare(
            `INSERT INTO material_transactions (material_id, location_id, type, quantity, reference_type, reference_id, notes, created_by)
             VALUES (?, ?, 'usage', ?, 'sale', ?, ?, ?)`
          );
          for (const b of bom) {
            const usedQty = b.qty_needed * task.quantity;
            deductStock.run(usedQty, b.material_id, task.location_id);
            logMaterialTx.run(b.material_id, task.location_id, usedQty, task.sale_id, `Task #${task.id} for ${sale?.sale_number || ''}`, req.user.id);
          }
        }

        // 2. Mark sale_item as materials_deducted
        if (task.sale_item_id) {
          db.prepare('UPDATE sale_items SET materials_deducted = 1 WHERE id = ?').run(task.sale_item_id);
        }

        // 3. Log production (for employee tracking/incentives)
        db.prepare(
          'INSERT INTO production_logs (product_id, location_id, quantity, sale_id, task_id, produced_by, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(task.product_id, task.location_id, task.quantity, task.sale_id, task.id, req.user.id, `Order ${sale?.sale_number || ''}`);

        // 4. Mark task complete
        db.prepare("UPDATE production_tasks SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(task.id);

        // 5. Update sale stock_deducted and check if ALL tasks for this sale are done
        const remaining = db.prepare(
          "SELECT COUNT(*) as cnt FROM production_tasks WHERE sale_id = ? AND status NOT IN ('completed', 'cancelled')"
        ).get(task.sale_id);

        if (remaining.cnt === 0) {
          // All tasks done — mark sale as ready
          db.prepare("UPDATE sales SET status = 'ready', stock_deducted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(task.sale_id);
        } else {
          // At least some materials deducted
          db.prepare("UPDATE sales SET stock_deducted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND stock_deducted = 0").run(task.sale_id);
        }
      });

      completeTx();
      res.json({ success: true, message: 'Task completed' });

      // Check for low stock alerts after material deduction
      try {
        const db2 = getDb();
        const bom = db2.prepare('SELECT material_id, quantity as qty_per FROM product_materials WHERE product_id = ?').all(task.product_id);
        for (const b of bom) {
          const lowStock = db2.prepare(`
            SELECT ms.quantity, m.min_stock_alert, m.name
            FROM material_stock ms JOIN materials m ON ms.material_id = m.id
            WHERE ms.material_id = ? AND ms.location_id = ? AND ms.quantity <= m.min_stock_alert AND m.min_stock_alert > 0
          `).get(b.material_id, task.location_id);
          if (lowStock) {
            notifyByRole({
              roles: ['owner', 'manager'],
              locationId: task.location_id,
              title: 'Low Stock Alert',
              body: `${lowStock.name} is low: ${lowStock.quantity} remaining (alert threshold: ${lowStock.min_stock_alert})`,
              type: 'low_stock',
              data: { materialId: b.material_id, screen: 'MaterialDetail' },
            });
          }
        }
      } catch (e) { console.error('Low stock check error:', e.message); }

      // Notify if all tasks done → sale is ready
      try {
        const db2 = getDb();
        const remaining = db2.prepare("SELECT COUNT(*) as cnt FROM production_tasks WHERE sale_id = ? AND status NOT IN ('completed','cancelled')").get(task.sale_id);
        if (remaining.cnt === 0) {
          const sale = db2.prepare('SELECT customer_id, sale_number, order_type FROM sales WHERE id = ?').get(task.sale_id);
          if (sale?.customer_id) {
            createNotification({
              userIds: sale.customer_id,
              title: 'Order Ready',
              body: `Your order ${sale.sale_number} is ready${sale.order_type === 'pickup' ? ' for pickup!' : '!'}`,
              type: 'order_status',
              data: { saleId: task.sale_id, screen: 'CustomerOrderDetail' },
            });
          }
        }
      } catch (e) { console.error('Ready notification error:', e.message); }
    } catch (err) { next(err); }
  }
);

// ═══════════════════════════════════════════════════════════════
// DASHBOARD SUMMARY — Counts for action items
// ═══════════════════════════════════════════════════════════════

router.get('/dashboard-summary', authenticate, authorize('owner', 'manager', 'employee'), (req, res, next) => {
  try {
    const db = getDb();
    const { location_id } = req.query;
    const role = req.user.role;

    let locFilter = '';
    const locParams = [];

    if (location_id) {
      locFilter = ' AND location_id = ?';
      locParams.push(Number(location_id));
    } else if (role === 'manager') {
      const userLocs = db.prepare('SELECT location_id FROM user_locations WHERE user_id = ?').all(req.user.id).map(r => r.location_id);
      if (userLocs.length > 0) {
        locFilter = ` AND location_id IN (${userLocs.map(() => '?').join(',')})`;
        locParams.push(...userLocs);
      }
    }

    // Pending orders count
    const pendingOrders = db.prepare(
      `SELECT COUNT(*) as cnt FROM sales WHERE status = 'pending'${locFilter}`
    ).get(...locParams);

    // Preparing orders count
    const preparingOrders = db.prepare(
      `SELECT COUNT(*) as cnt FROM sales WHERE status = 'preparing'${locFilter}`
    ).get(...locParams);

    // Ready orders count
    const readyOrders = db.prepare(
      `SELECT COUNT(*) as cnt FROM sales WHERE status = 'ready'${locFilter}`
    ).get(...locParams);

    // Unassigned tasks (for managers/owners)
    let taskLocFilter = locFilter.replace(/location_id/g, 'pt.location_id');
    let taskLocParams = [...locParams];
    const unassignedTasks = db.prepare(
      `SELECT COUNT(*) as cnt FROM production_tasks pt WHERE pt.status = 'pending' AND pt.assigned_to IS NULL${taskLocFilter}`
    ).get(...taskLocParams);

    // Total pending tasks (not completed/cancelled)
    const pendingTasks = db.prepare(
      `SELECT COUNT(*) as cnt FROM production_tasks pt WHERE pt.status IN ('pending', 'assigned', 'in_progress')${taskLocFilter}`
    ).get(...taskLocParams);

    // Material shortage count (for managers/owners)
    let materialShortages = 0;
    if (role === 'owner' || role === 'manager') {
      let orderLocFilter = '';
      const orderLocParams = [];
      if (location_id) {
        orderLocFilter = ' AND s.location_id = ?';
        orderLocParams.push(Number(location_id));
      } else if (locParams.length > 0) {
        orderLocFilter = ` AND s.location_id IN (${locParams.map(() => '?').join(',')})`;
        orderLocParams.push(...locParams);
      }
      const pendingItems = db.prepare(`
        SELECT si.product_id, si.quantity, s.location_id
        FROM sale_items si
        JOIN sales s ON si.sale_id = s.id
        WHERE s.status IN ('pending', 'preparing')${orderLocFilter}
          AND si.product_id IS NOT NULL AND si.materials_deducted = 0
      `).all(...orderLocParams);

      const materialNeeds = {};
      const getBOM = db.prepare('SELECT material_id, quantity as qty_needed FROM product_materials WHERE product_id = ?');
      for (const item of pendingItems) {
        const bom = getBOM.all(item.product_id);
        for (const b of bom) {
          const key = `${b.material_id}_${item.location_id}`;
          if (!materialNeeds[key]) materialNeeds[key] = { material_id: b.material_id, location_id: item.location_id, needed: 0 };
          materialNeeds[key].needed += b.qty_needed * item.quantity;
        }
      }
      for (const key of Object.keys(materialNeeds)) {
        const need = materialNeeds[key];
        const stock = db.prepare('SELECT quantity FROM material_stock WHERE material_id = ? AND location_id = ?').get(need.material_id, need.location_id);
        if (!stock || stock.quantity < need.needed) materialShortages++;
      }
    }

    res.json({
      success: true,
      data: {
        pending_orders: pendingOrders.cnt,
        preparing_orders: preparingOrders.cnt,
        ready_orders: readyOrders.cnt,
        unassigned_tasks: unassignedTasks.cnt,
        pending_tasks: pendingTasks.cnt,
        material_shortages: materialShortages,
      },
    });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
// PRODUCTION STATS — Employee production tracking (incentives)
// ═══════════════════════════════════════════════════════════════

router.get('/stats', authenticate, (req, res, next) => {
  try {
    const db = getDb();
    const { location_id, date_from, date_to, user_id } = req.query;

    const today = localToday();
    const from = date_from || today;
    const to = date_to || today;

    let userFilter = '';
    const params = [from, to];
    if (user_id) { userFilter = ' AND pl.produced_by = ?'; params.push(Number(user_id)); }

    let locFilter = '';
    if (location_id) { locFilter = ' AND pl.location_id = ?'; params.push(Number(location_id)); }

    // Per-employee breakdown
    const byEmployee = db.prepare(`
      SELECT pl.produced_by, u.name as employee_name,
             COUNT(*) as total_logs,
             SUM(pl.quantity) as total_produced,
             COUNT(DISTINCT pl.product_id) as unique_products
      FROM production_logs pl
      JOIN users u ON pl.produced_by = u.id
      WHERE DATE(pl.created_at) >= ? AND DATE(pl.created_at) <= ?
        AND pl.notes NOT LIKE 'Adjustment:%'
        ${userFilter}${locFilter}
      GROUP BY pl.produced_by, u.name
      ORDER BY total_produced DESC
    `).all(...params);

    // Per-product breakdown
    const params2 = [from, to];
    if (user_id) params2.push(Number(user_id));
    if (location_id) params2.push(Number(location_id));

    const byProduct = db.prepare(`
      SELECT pl.product_id, p.name as product_name,
             SUM(pl.quantity) as total_produced
      FROM production_logs pl
      JOIN products p ON pl.product_id = p.id
      WHERE DATE(pl.created_at) >= ? AND DATE(pl.created_at) <= ?
        AND pl.notes NOT LIKE 'Adjustment:%'
        ${userFilter}${locFilter}
      GROUP BY pl.product_id, p.name
      ORDER BY total_produced DESC
    `).all(...params2);

    res.json({ success: true, data: { byEmployee, byProduct } });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
// MATERIAL ALERTS — Check materials needed for upcoming orders
// ═══════════════════════════════════════════════════════════════

router.get('/material-alerts', authenticate, authorize('owner', 'manager'), (req, res, next) => {
  try {
    const db = getDb();
    const { location_id } = req.query;

    // Get all pending/preparing orders' items and their BOM requirements
    let orderFilter = "s.status IN ('pending', 'preparing')";
    const params = [];
    if (location_id) { orderFilter += ' AND s.location_id = ?'; params.push(Number(location_id)); }

    const pendingItems = db.prepare(`
      SELECT si.product_id, si.quantity, s.location_id, s.sale_number, s.scheduled_date,
             si.materials_deducted
      FROM sale_items si
      JOIN sales s ON si.sale_id = s.id
      WHERE ${orderFilter} AND si.product_id IS NOT NULL AND si.materials_deducted = 0
    `).all(...params);

    // Calculate total materials needed
    const materialNeeds = {};
    const getBOM = db.prepare('SELECT material_id, quantity as qty_needed FROM product_materials WHERE product_id = ?');

    for (const item of pendingItems) {
      const bom = getBOM.all(item.product_id);
      for (const b of bom) {
        const key = `${b.material_id}_${item.location_id}`;
        if (!materialNeeds[key]) {
          materialNeeds[key] = { material_id: b.material_id, location_id: item.location_id, needed: 0, orders: [] };
        }
        materialNeeds[key].needed += b.qty_needed * item.quantity;
        if (!materialNeeds[key].orders.includes(item.sale_number)) {
          materialNeeds[key].orders.push(item.sale_number);
        }
      }
    }

    // Compare with current stock
    const alerts = [];
    for (const key of Object.keys(materialNeeds)) {
      const need = materialNeeds[key];
      const stock = db.prepare('SELECT quantity FROM material_stock WHERE material_id = ? AND location_id = ?').get(need.material_id, need.location_id);
      const currentQty = stock ? stock.quantity : 0;
      const shortage = need.needed - currentQty;

      const material = db.prepare(`
        SELECT m.name, m.sku, mc.unit, mc.name as category_name
        FROM materials m JOIN material_categories mc ON m.category_id = mc.id
        WHERE m.id = ?
      `).get(need.material_id);

      const location = db.prepare('SELECT name FROM locations WHERE id = ?').get(need.location_id);

      alerts.push({
        material_id: need.material_id,
        material_name: material?.name || 'Unknown',
        material_sku: material?.sku || '',
        unit: material?.unit || 'pcs',
        category: material?.category_name || '',
        location_id: need.location_id,
        location_name: location?.name || 'Unknown',
        needed: need.needed,
        in_stock: currentQty,
        shortage: Math.max(0, shortage),
        sufficient: shortage <= 0,
        order_count: need.orders.length,
      });
    }

    // Sort: shortages first, then by severity
    alerts.sort((a, b) => {
      if (a.sufficient !== b.sufficient) return a.sufficient ? 1 : -1;
      return b.shortage - a.shortage;
    });

    res.json({ success: true, data: alerts });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
// PRODUCTION LOGS — View production history
// ═══════════════════════════════════════════════════════════════

router.get('/logs', authenticate, (req, res, next) => {
  try {
    const db = getDb();
    const { location_id, user_id, product_id, date_from, date_to, limit: lim } = req.query;

    let sql = `
      SELECT pl.*, p.name as product_name, p.sku as product_sku,
             u.name as produced_by_name, l.name as location_name,
             s.sale_number
      FROM production_logs pl
      JOIN products p ON pl.product_id = p.id
      JOIN users u ON pl.produced_by = u.id
      JOIN locations l ON pl.location_id = l.id
      LEFT JOIN sales s ON pl.sale_id = s.id
      WHERE 1=1
    `;
    const params = [];

    if (location_id) { sql += ' AND pl.location_id = ?'; params.push(Number(location_id)); }
    if (user_id) { sql += ' AND pl.produced_by = ?'; params.push(Number(user_id)); }
    if (product_id) { sql += ' AND pl.product_id = ?'; params.push(Number(product_id)); }
    if (date_from) { sql += ' AND DATE(pl.created_at) >= ?'; params.push(date_from); }
    if (date_to) { sql += ' AND DATE(pl.created_at) <= ?'; params.push(date_to); }

    sql += ' ORDER BY pl.created_at DESC';
    sql += ` LIMIT ?`;
    params.push(parseInt(lim) || 50);

    const logs = db.prepare(sql).all(...params);
    res.json({ success: true, data: logs });
  } catch (err) { next(err); }
});

module.exports = router;
