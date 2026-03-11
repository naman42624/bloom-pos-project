/**
 * Rate Limiting Middleware
 *
 * Protects against brute-force and DDoS attacks.
 * Uses Redis store in production for multi-instance support.
 */

const rateLimit = require('express-rate-limit');

// Try to use Redis store if available
let store;
try {
  if (process.env.REDIS_URL) {
    const { RedisStore } = require('rate-limit-redis');
    const { getRedis } = require('../config/redis');
    store = new RedisStore({
      sendCommand: (...args) => getRedis().call(...args),
    });
  }
} catch {
  // Redis not available — use in-memory store (fine for single instance)
}

/**
 * General API rate limiter: 100 requests per minute per IP
 */
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please try again later.' },
  ...(store ? { store } : {}),
});

/**
 * Auth rate limiter: 10 attempts per 15 minutes per IP
 * Prevents brute-force login attacks
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many login attempts. Please try again in 15 minutes.' },
  ...(store ? { store } : {}),
});

/**
 * Upload rate limiter: 20 uploads per minute
 */
const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many uploads. Please try again later.' },
  ...(store ? { store } : {}),
});

module.exports = {
  generalLimiter,
  authLimiter,
  uploadLimiter,
};
