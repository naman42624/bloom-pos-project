require('dotenv').config();
const { getDb } = require('./config/database-async');

const saleId = process.argv[2];

if (!saleId) {
  console.error('Please provide a sale ID. Usage: node restore_order.js <SALE_ID>');
  process.exit(1);
}

async function restoreOrder() {
  console.log(`--- Restoring Order #${saleId} ---`);
  try {
    const db = await getDb();
    
    const sale = await db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
    if (!sale) {
      console.error(`Order ${saleId} not found.`);
      process.exit(1);
    }

    if (sale.status !== 'cancelled') {
      console.error(`Order ${saleId} is not cancelled (current status: ${sale.status}). Cannot restore.`);
      process.exit(1);
    }

    await db.exec('BEGIN');

    // 1. Change status back to pending
    await db.prepare("UPDATE sales SET status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(saleId);
    console.log(`✅ Set sale status to 'pending'`);

    // 2. Restore production tasks
    const tasks = await db.prepare("UPDATE production_tasks SET status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE sale_id = ? AND status = 'cancelled'").run(saleId);
    console.log(`✅ Restored ${tasks.changes} production tasks to 'pending'`);

    // 3. Update customer dues
    const duesCustomerId = (sale.order_type === 'delivery' && sale.sender_customer_id) ? sale.sender_customer_id : sale.customer_id;
    if (duesCustomerId) {
      // Find how much was actually paid on this order (probably 0 if our previous script re-allocated them)
      const totalPaidObj = await db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE sale_id = ?').get(sale.id);
      const totalPaid = totalPaidObj ? Number(totalPaidObj.total) : 0;
      
      const unpaid = Math.max(0, Number(sale.grand_total) - totalPaid);
      
      await db.prepare('UPDATE users SET total_spent = total_spent + ?, credit_balance = credit_balance + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(sale.grand_total, unpaid, duesCustomerId);
        
      console.log(`✅ Increased customer ${duesCustomerId} total_spent by ₹${sale.grand_total} and credit_balance by ₹${unpaid}`);
    }

    // Note: We do NOT deduct stock automatically here. 
    // The sale's stock_deducted flag was set to 0 when it was cancelled.
    // By setting status to 'pending', the normal app workflow will deduct stock when the staff marks tasks as completed!

    await db.exec('COMMIT');
    console.log(`--- Successfully Restored Order #${saleId} ---`);
    console.log(`NOTE: Any payments originally on this order may have been re-allocated to other orders when it was cancelled. If the customer paid for this, you may need to manually click 'Record Payment' on this order again.`);
    
  } catch (err) {
    console.error('Error during restoration:', err);
  } finally {
    process.exit(0);
  }
}

restoreOrder();
