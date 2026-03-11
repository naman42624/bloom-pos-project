/**
 * Recurring Orders Worker
 *
 * Processes scheduled recurring orders: generates sales, sale items,
 * production tasks, deliveries, and updates next run dates.
 *
 * In SQLite mode (development), requires the recurring-orders route export.
 * In PG mode (production), runs the same logic against PostgreSQL.
 */

const { recurringOrdersQueue } = require('./queue');

function register() {
  // For SQLite / current dev mode, just call the exported function
  // In production PG mode, this would use database.pg.js async queries
  let processRecurringOrders;
  try {
    ({ processRecurringOrders } = require('../routes/recurring-orders'));
  } catch (e) {
    console.error('Failed to load processRecurringOrders:', e.message);
    return;
  }

  recurringOrdersQueue.process('process', async (_job) => {
    processRecurringOrders();
    return { processed: true, timestamp: new Date().toISOString() };
  });

  recurringOrdersQueue.on('failed', (job, err) => {
    console.error(`❌ Recurring orders job ${job.id} failed:`, err.message);
  });

  recurringOrdersQueue.on('completed', (job, result) => {
    if (result?.processed) {
      console.log(`✅ Recurring orders processed at ${result.timestamp}`);
    }
  });
}

module.exports = { register };
