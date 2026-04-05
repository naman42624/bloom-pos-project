/**
 * Performance Diagnostics Routes
 * Add to server.js: app.use('/api/diagnostics', require('./routes/diagnostics'));
 * 
 * Endpoints:
 *   GET /api/diagnostics/metrics      - Summary of all metrics
 *   GET /api/diagnostics/by-endpoint  - Breakdown by endpoint
 *   GET /api/diagnostics/slow-queries - List of slowest requests
 *   GET /api/diagnostics/reset        - Clear all metrics
 */

const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const perf = require('../middleware/performance-monitor');

/**
 * GET /api/diagnostics/metrics
 * Overall performance summary
 */
router.get('/metrics', (req, res) => {
  // Allow public access in development for testing
  if (process.env.NODE_ENV === 'production' && !req.user?.id) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.send(perf.getMetricsSummary());
});

/**
 * GET /api/diagnostics/by-endpoint
 * Breakdown by each endpoint
 */
router.get('/by-endpoint', (req, res) => {
  // Allow public access in development for testing  
  if (process.env.NODE_ENV === 'production' && !req.user?.id) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.send(perf.getEndpointMetrics());
});

/**
 * GET /api/diagnostics/slow-queries
 * List of slowest individual requests
 */
router.get('/slow-queries', (req, res) => {
  // Allow public access in development for testing
  if (process.env.NODE_ENV === 'production' && !req.user?.id) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  const limit = parseInt(req.query.limit) || 10;
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.send(perf.getSlowestRequests(limit));
});

/**
 * GET /api/diagnostics/json
 * Machine-readable metrics (for graphing/analysis)
 */
router.get('/json', (req, res) => {
  // Allow public access in development for testing
  if (process.env.NODE_ENV === 'production' && !req.user?.id) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  const reqs = perf.metrics.requests;
  
  if (reqs.length === 0) {
    return res.json({ error: 'No requests recorded yet' });
  }
  
  const stats = {
    recordedRequests: reqs.length,
    slowRequests: perf.metrics.slowQueries.length,
    averageTime: reqs.reduce((sum, r) => sum + r.totalMs, 0) / reqs.length,
    maxTime: Math.max(...reqs.map(r => r.totalMs)),
    minTime: Math.min(...reqs.map(r => r.totalMs)),
    averageDbTime: reqs.reduce((sum, r) => sum + r.dbTimeMs, 0) / reqs.length,
    averageQueriesPerReq: reqs.reduce((sum, r) => sum + r.queryCount, 0) / reqs.length,
    lastRequests: reqs.slice(-20),
  };
  
  res.json(stats);
});

/**
 * POST /api/diagnostics/reset
 * Clear all metrics (for fresh test)
 */
router.post('/reset', (req, res) => {
  // Allow public access in development for testing
  if (process.env.NODE_ENV === 'production' && !req.user?.id) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  perf.metrics.requests = [];
  perf.metrics.slowQueries = [];
  res.json({ success: true, message: 'Metrics cleared' });
});

module.exports = router;
