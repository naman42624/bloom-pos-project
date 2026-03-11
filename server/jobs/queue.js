/**
 * Bull Queue Setup
 *
 * Redis-backed job queue for background processing.
 * Replaces in-process setInterval for production.
 *
 * Queues:
 *  - recurringOrders: Process scheduled recurring orders
 *  - geofenceTimeout: Auto clock-out after geofence timeout
 *  - notifications:   Send push notifications in background
 */

const Queue = require('bull');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// Create queues
const recurringOrdersQueue = new Queue('recurring-orders', REDIS_URL, {
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 50,
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  },
});

const geofenceQueue = new Queue('geofence-timeout', REDIS_URL, {
  defaultJobOptions: {
    removeOnComplete: 50,
    removeOnFail: 20,
    attempts: 2,
  },
});

const notificationQueue = new Queue('notifications', REDIS_URL, {
  defaultJobOptions: {
    removeOnComplete: 200,
    removeOnFail: 50,
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
  },
});

/**
 * Schedule repeating jobs
 * Call this once on server startup
 */
async function scheduleJobs() {
  // Process recurring orders every 30 minutes
  await recurringOrdersQueue.add('process', {}, {
    repeat: { every: 30 * 60 * 1000 },
    jobId: 'recurring-orders-cron',
  });

  // Check geofence timeouts every 60 seconds
  await geofenceQueue.add('check', {}, {
    repeat: { every: 60 * 1000 },
    jobId: 'geofence-timeout-cron',
  });

  console.log('📋 Background jobs scheduled');
}

module.exports = {
  recurringOrdersQueue,
  geofenceQueue,
  notificationQueue,
  scheduleJobs,
};
