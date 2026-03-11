/**
 * Redis Configuration
 *
 * Used for:
 *  - Rate limiting (express-rate-limit store)
 *  - Session/token caching
 *  - Socket.io adapter (multi-instance messaging)
 *  - Settings cache (avoid DB reads)
 *  - Bull job queues
 */

const Redis = require('ioredis');

let redis;

function getRedis() {
  if (!redis) {
    const url = process.env.REDIS_URL || 'redis://localhost:6379';

    redis = new Redis(url, {
      maxRetriesPerRequest: 3,
      retryDelayOnFailover: 100,
      enableReadyCheck: true,
      lazyConnect: false,
    });

    redis.on('connect', () => {
      console.log('✅ Redis connected');
    });

    redis.on('error', (err) => {
      console.error('Redis error:', err.message);
    });
  }
  return redis;
}

async function closeRedis() {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}

/**
 * Cache helpers with TTL
 */
async function cacheGet(key) {
  const data = await getRedis().get(key);
  return data ? JSON.parse(data) : null;
}

async function cacheSet(key, value, ttlSeconds = 300) {
  await getRedis().setex(key, ttlSeconds, JSON.stringify(value));
}

async function cacheDel(key) {
  await getRedis().del(key);
}

async function cacheDelPattern(pattern) {
  const keys = await getRedis().keys(pattern);
  if (keys.length > 0) {
    await getRedis().del(...keys);
  }
}

module.exports = {
  getRedis,
  closeRedis,
  cacheGet,
  cacheSet,
  cacheDel,
  cacheDelPattern,
};
