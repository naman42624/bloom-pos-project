/**
 * Performance Monitoring Middleware
 * Tracks request timing, database query time, and identifies bottlenecks
 * Helps determine if async migration is actually needed
 */

const path = require('path');

// Store metrics for analysis
const metrics = {
  requests: [],
  slowQueries: [],
};

function formatMs(ms) {
  return `${Math.round(ms * 100) / 100}ms`;
}

function getRouteLabel(pathname) {
  // Simplify paths: /api/sales/134 → /api/sales/:id
  return pathname
    .replace(/\/\d+$/g, '/:id')
    .replace(/\/\d+\//g, '/:id/')
    .substring(0, 50);
}

/**
 * Main middleware: Tracks all requests
 */
function performanceMonitor(req, res, next) {
  const startTime = performance.now();
  const startCpu = process.cpuUsage();
  
  // Store original methods to intercept database calls
  const originalSend = res.send;
  
  res.send = function(data) {
    const endTime = performance.now();
    const endCpu = process.cpuUsage(startCpu);
    const totalMs = endTime - startTime;
    const cpuMs = (endCpu.user + endCpu.system) / 1000;
    
    const metric = {
      timestamp: new Date().toISOString(),
      method: req.method,
      path: req.path,
      status: res.statusCode,
      totalMs: Math.round(totalMs * 100) / 100,
      cpuMs: Math.round(cpuMs * 100) / 100,
      dbTimeMs: req.dbTime || 0,
      ioTimeMs: totalMs - cpuMs - (req.dbTime || 0),
      queryCount: req.queryCount || 0,
    };
    
    metrics.requests.push(metric);
    
    // Keep only last 1000 requests
    if (metrics.requests.length > 1000) {
      metrics.requests.shift();
    }
    
    // Log slow requests (> 200ms)
    if (totalMs > 200) {
      console.log(
        `⚠️  [SLOW] ${metric.method} ${getRouteLabel(metric.path)} ` +
        `${formatMs(totalMs)} (DB: ${formatMs(metric.dbTimeMs)}, CPU: ${formatMs(metric.cpuMs)}, ` +
        `IO: ${formatMs(metric.ioTimeMs)}, Queries: ${metric.queryCount})`
      );
      
      metrics.slowQueries.push(metric);
      if (metrics.slowQueries.length > 100) {
        metrics.slowQueries.shift();
      }
    }
    
    // Add timing headers
    res.set('X-Response-Time-Ms', Math.round(totalMs));
    res.set('X-DB-Time-Ms', Math.round(req.dbTime || 0));
    res.set('X-Query-Count', req.queryCount || 0);
    
    return originalSend.call(this, data);
  };
  
  // Initialize tracking
  req.dbTime = 0;
  req.queryCount = 0;
  req.queryTimings = [];
  
  next();
}

/**
 * Database query timer: Wrap db.prepare() to measure query time
 * Usage: Add to routes BEFORE database calls
 */
function startQueryTimer(req) {
  return performance.now();
}

function endQueryTimer(req, startTime, queryType) {
  const duration = performance.now() - startTime;
  req.dbTime += duration;
  req.queryCount += 1;
  req.queryTimings.push({
    type: queryType,
    durationMs: Math.round(duration * 100) / 100,
  });
  
  // Log very slow individual queries (> 50ms)
  if (duration > 50) {
    console.log(`  📊 Query took ${formatMs(duration)} (${queryType})`);
  }
  
  return duration;
}

/**
 * Get metrics summary for diagnostics
 */
function getMetricsSummary() {
  if (metrics.requests.length === 0) {
    return 'No requests recorded yet';
  }
  
  const reqs = metrics.requests;
  const totalTime = reqs.reduce((sum, r) => sum + r.totalMs, 0);
  const avgTime = totalTime / reqs.length;
  const maxTime = Math.max(...reqs.map(r => r.totalMs));
  const minTime = Math.min(...reqs.map(r => r.totalMs));
  
  const dbTime = reqs.reduce((sum, r) => sum + r.dbTimeMs, 0);
  const cpuTime = reqs.reduce((sum, r) => sum + r.cpuMs, 0);
  const ioTime = reqs.reduce((sum, r) => sum + r.ioTimeMs, 0);
  
  const avgQueriesPerReq = reqs.reduce((sum, r) => sum + r.queryCount, 0) / reqs.length;
  
  return `
╔════════════════════════════════════════════════════════════════╗
║          PERFORMANCE METRICS SUMMARY (Last ${reqs.length} requests)          ║
╠════════════════════════════════════════════════════════════════╣
║ Total Time Breakdown:                                          ║
║   • Average: ${formatMs(avgTime).padEnd(40)} (${Math.round(avgTime * 100) / 100}ms)
║   • Min:     ${formatMs(minTime).padEnd(40)}
║   • Max:     ${formatMs(maxTime).padEnd(40)}
║                                                                ║
║ Time Categories (% of total):                                  ║
║   • Database time:    ${formatMs(dbTime / reqs.length).padEnd(15)} (${Math.round((dbTime / totalTime) * 100)}%)
║   • CPU time:         ${formatMs(cpuTime / reqs.length).padEnd(15)} (${Math.round((cpuTime / totalTime) * 100)}%)
║   • I/O time:         ${formatMs(ioTime / reqs.length).padEnd(15)} (${Math.round((ioTime / totalTime) * 100)}%)
║                                                                ║
║ Query Stats:                                                   ║
║   • Avg queries/req:  ${avgQueriesPerReq.toFixed(1)}
║   • Total queries:    ${reqs.reduce((sum, r) => sum + r.queryCount, 0)}
║                                                                ║
║ Slow Requests (>200ms): ${metrics.slowQueries.length}               ║
╚════════════════════════════════════════════════════════════════╝
  `;
}

/**
 * Get detailed breakdown by endpoint
 */
function getEndpointMetrics() {
  if (metrics.requests.length === 0) {
    return 'No requests recorded yet';
  }
  
  const byEndpoint = {};
  
  for (const req of metrics.requests) {
    const endpoint = `${req.method} ${getRouteLabel(req.path)}`;
    if (!byEndpoint[endpoint]) {
      byEndpoint[endpoint] = {
        count: 0,
        times: [],
        queries: [],
        dbTimes: [],
      };
    }
    byEndpoint[endpoint].count += 1;
    byEndpoint[endpoint].times.push(req.totalMs);
    byEndpoint[endpoint].queries.push(req.queryCount);
    byEndpoint[endpoint].dbTimes.push(req.dbTimeMs);
  }
  
  let report = '\n╔════════════════════════════════════════════════════════════════╗\n';
  report += '║          METRICS BY ENDPOINT                                   ║\n';
  report += '╠════════════════════════════════════════════════════════════════╣\n';
  
  // Sort by avg time descending (slowest first)
  const sorted = Object.entries(byEndpoint)
    .map(([endpoint, data]) => ({
      endpoint,
      count: data.count,
      avgTime: data.times.reduce((a, b) => a + b, 0) / data.times.length,
      maxTime: Math.max(...data.times),
      minTime: Math.min(...data.times),
      avgQueries: data.queries.reduce((a, b) => a + b, 0) / data.queries.length,
      avgDbTime: data.dbTimes.reduce((a, b) => a + b, 0) / data.dbTimes.length,
    }))
    .sort((a, b) => b.avgTime - a.avgTime);
  
  for (const item of sorted.slice(0, 15)) {
    const slowness = item.avgTime > 300 ? '🔴' : item.avgTime > 150 ? '🟡' : '🟢';
    report += `║ ${slowness} ${item.endpoint.padEnd(40)} ${formatMs(item.avgTime).padStart(10)} ║\n`;
    report += `║    (${item.count}x) min: ${formatMs(item.minTime).padStart(8)}, max: ${formatMs(item.maxTime).padStart(8)}, queries: ${item.avgQueries.toFixed(1)} ║\n`;
    report += `║    DB: ${formatMs(item.avgDbTime).padStart(8)} (${Math.round((item.avgDbTime / item.avgTime) * 100)}%) ║\n`;
  }
  
  report += '║                                                                ║\n';
  report += '║ Legend: 🟢 <150ms (Good)  🟡 150-300ms (OK)  🔴 >300ms (Slow) ║\n';
  report += '╚════════════════════════════════════════════════════════════════╝\n';
  
  return report;
}

/**
 * Get list of slowest queries
 */
function getSlowestRequests(limit = 10) {
  if (metrics.slowQueries.length === 0) {
    return 'No slow requests recorded (all under 200ms)';
  }
  
  const sorted = [...metrics.slowQueries]
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, limit);
  
  let report = `\n📊 SLOWEST REQUESTS (${sorted.length} found):\n`;
  report += '─'.repeat(80) + '\n';
  
  for (let i = 0; i < sorted.length; i++) {
    const req = sorted[i];
    const dbPct = Math.round((req.dbTimeMs / req.totalMs) * 100);
    const cpuPct = Math.round((req.cpuMs / req.totalMs) * 100);
    const ioPct = 100 - dbPct - cpuPct;
    
    report += `${i + 1}. ${req.method} ${getRouteLabel(req.path)}\n`;
    report += `   Total: ${formatMs(req.totalMs)} | DB: ${formatMs(req.dbTimeMs)} (${dbPct}%) | CPU: ${formatMs(req.cpuMs)} (${cpuPct}%) | IO: (${ioPct}%) | Queries: ${req.queryCount}\n`;
  }
  
  return report;
}

module.exports = {
  performanceMonitor,
  startQueryTimer,
  endQueryTimer,
  getMetricsSummary,
  getEndpointMetrics,
  getSlowestRequests,
  metrics,
};
