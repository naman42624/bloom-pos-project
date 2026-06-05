require('dotenv').config();
const { getDb } = require('./config/database-async');

const specificCustomerId = process.argv[2] ? Number(process.argv[2]) : null;

async function runFix() {
  if (specificCustomerId) {
    console.log(`--- Starting Customer Dues Reconciliation for Customer ID: ${specificCustomerId} ---`);
  } else {
    console.log('--- Starting Customer Dues Reconciliation (ALL CUSTOMERS) ---');
  }
  try {
    const db = await getDb();
    
    await db.exec('BEGIN');
    
    // Step 1: Find all unallocated credit payments
    let unallocatedCredits;
    if (specificCustomerId) {
      unallocatedCredits = await db.prepare(`
        SELECT * FROM credit_payments 
        WHERE sale_id IS NULL AND customer_id = ?
        ORDER BY created_at ASC
      `).all(specificCustomerId);
    } else {
      unallocatedCredits = await db.prepare(`
        SELECT * FROM credit_payments 
        WHERE sale_id IS NULL
        ORDER BY created_at ASC
      `).all();
    }

    console.log(`Found ${unallocatedCredits.length} unallocated credit payments.`);

    for (const credit of unallocatedCredits) {
      let remainingAmount = credit.amount;
      const customerId = credit.customer_id;

      // Find oldest unpaid sales for this customer
      const unpaidSales = await db.prepare(`
        SELECT s.id, s.grand_total, COALESCE((SELECT SUM(amount) FROM payments WHERE sale_id = s.id), 0) as total_paid
        FROM sales s
        WHERE (s.customer_id = ? OR s.sender_customer_id = ?) 
          AND s.status != 'cancelled' 
          AND s.payment_status != 'paid'
        ORDER BY s.created_at ASC
      `).all(customerId, customerId);

      for (const sale of unpaidSales) {
        if (remainingAmount <= 0.01) break;

        const saleUnpaid = Math.max(0, sale.grand_total - sale.total_paid);
        if (saleUnpaid > 0) {
          const allocation = Math.min(saleUnpaid, remainingAmount);
          
          await db.prepare(`
            INSERT INTO payments (sale_id, method, amount, reference_number, received_by, created_at) 
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(sale.id, credit.method, allocation, `Credit-${credit.id}-Fix`, credit.recorded_by, credit.created_at);
          
          remainingAmount -= allocation;

          const newTotalPaid = sale.total_paid + allocation;
          const roundedGrandTotal = Math.round(Number(sale.grand_total || 0) * 100) / 100;
          const roundedTotalPaid = Math.round(Number(newTotalPaid || 0) * 100) / 100;
          
          let paymentStatus = 'pending';
          if (roundedTotalPaid >= roundedGrandTotal - 0.01) paymentStatus = 'paid';
          else if (roundedTotalPaid > 0) paymentStatus = 'partial';
          
          await db.prepare('UPDATE sales SET payment_status = ? WHERE id = ?').run(paymentStatus, sale.id);
        }
      }
    }

    // Step 1.5: Reallocate payments from cancelled orders
    let cancelledPayments;
    if (specificCustomerId) {
      cancelledPayments = await db.prepare(`
        SELECT p.*, s.customer_id, s.sender_customer_id
        FROM payments p
        JOIN sales s ON p.sale_id = s.id
        WHERE s.status = 'cancelled' AND (s.customer_id = ? OR s.sender_customer_id = ?)
      `).all(specificCustomerId, specificCustomerId);
    } else {
      cancelledPayments = await db.prepare(`
        SELECT p.*, s.customer_id, s.sender_customer_id
        FROM payments p
        JOIN sales s ON p.sale_id = s.id
        WHERE s.status = 'cancelled'
      `).all();
    }

    console.log(`Found ${cancelledPayments.length} payments on cancelled orders to reallocate.`);

    for (const pmt of cancelledPayments) {
      const customerId = pmt.customer_id || pmt.sender_customer_id;
      if (!customerId) continue;

      let remainingAmount = Number(pmt.amount || 0);

      const unpaidSales = await db.prepare(`
        SELECT s.id, s.grand_total, COALESCE((SELECT SUM(amount) FROM payments WHERE sale_id = s.id), 0) as total_paid
        FROM sales s
        WHERE (s.customer_id = ? OR s.sender_customer_id = ?) 
          AND s.status != 'cancelled' 
          AND s.payment_status != 'paid'
        ORDER BY s.created_at ASC
      `).all(customerId, customerId);

      for (const sale of unpaidSales) {
        if (remainingAmount <= 0.01) break;

        const grandTotal = Number(sale.grand_total || 0);
        const totalPaid = Number(sale.total_paid || 0);
        const saleUnpaid = Math.max(0, grandTotal - totalPaid);
        
        if (saleUnpaid > 0) {
          const allocation = Math.min(saleUnpaid, remainingAmount);
          
          await db.prepare(`
            INSERT INTO payments (sale_id, method, amount, reference_number, received_by, created_at) 
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(sale.id, pmt.method, allocation, pmt.reference_number || 'Reallocated from Cancelled', pmt.received_by, pmt.created_at);
          
          remainingAmount -= allocation;

          const newTotalPaid = totalPaid + allocation;
          const roundedGrandTotal = Math.round(grandTotal * 100) / 100;
          const roundedTotalPaid = Math.round(newTotalPaid * 100) / 100;
          
          let paymentStatus = 'pending';
          if (roundedTotalPaid >= roundedGrandTotal - 0.01) paymentStatus = 'paid';
          else if (roundedTotalPaid > 0) paymentStatus = 'partial';
          
          await db.prepare('UPDATE sales SET payment_status = ? WHERE id = ?').run(paymentStatus, sale.id);
        }
      }

      // Delete the original payment from the cancelled order so it isn't double counted
      await db.prepare('DELETE FROM payments WHERE id = ?').run(pmt.id);
      
      // If there's still money left over, it's an unapplied credit. 
      // We'll store it in credit_payments so it's not lost.
      if (remainingAmount > 0.01) {
         await db.prepare(`
           INSERT INTO credit_payments (customer_id, amount, method, recorded_by, created_at, notes)
           VALUES (?, ?, ?, ?, ?, ?)
         `).run(customerId, remainingAmount, pmt.method, pmt.received_by, pmt.created_at, 'Overpayment from cancelled order');
      }
    }

    // Step 2: Recalculate credit_balance and total_spent for EVERY customer (or just the specific one)
    let customers;
    if (specificCustomerId) {
      customers = await db.prepare("SELECT id FROM users WHERE id = ? AND role = 'customer'").all(specificCustomerId);
    } else {
      customers = await db.prepare("SELECT id FROM users WHERE role = 'customer'").all();
    }
    console.log(`Recalculating balances for ${customers.length} customers...`);

    let updatedCount = 0;
    for (const customer of customers) {
      const customerId = customer.id;

      const sales = await db.prepare(`
        SELECT s.id, s.grand_total, COALESCE((SELECT SUM(amount) FROM payments WHERE sale_id = s.id), 0) as total_paid
        FROM sales s
        WHERE (s.customer_id = ? OR s.sender_customer_id = ?) 
          AND s.status != 'cancelled'
      `).all(customerId, customerId);

      let actualTotalSpent = 0;
      let actualUnpaidAmount = 0;

      for (const sale of sales) {
        const grandTotal = Number(sale.grand_total || 0);
        const totalPaid = Number(sale.total_paid || 0);
        actualTotalSpent += grandTotal;
        const unpaid = Math.max(0, grandTotal - totalPaid);
        actualUnpaidAmount += unpaid;
      }

      await db.prepare('UPDATE users SET total_spent = ?, credit_balance = ? WHERE id = ?')
        .run(actualTotalSpent, actualUnpaidAmount, customerId);
        
      updatedCount++;
    }

    await db.exec('COMMIT');
    console.log(`Successfully reconciled data for ${updatedCount} customers.`);
    console.log('--- Done ---');
  } catch (err) {
    console.error('Error during reconciliation:', err);
  } finally {
    process.exit(0);
  }
}

runFix();
