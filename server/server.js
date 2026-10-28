require('dotenv').config();
require('express-async-errors');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');

const authRoutes = require('./routes/auth');
const usersRoutes = require('./routes/users');
const locationsRoutes = require('./routes/locations');
const settingsRoutes = require('./routes/settings');
const categoriesRoutes = require('./routes/categories');
const materialsRoutes = require('./routes/materials');
const suppliersRoutes = require('./routes/suppliers');
const purchaseOrdersRoutes = require('./routes/purchase-orders');
const stockRoutes = require('./routes/stock');
const productsRoutes = require('./routes/products');
const salesRoutes = require('./routes/sales');
const expensesRoutes = require('./routes/expenses');
const customersRoutes = require('./routes/customers');
const orderRequestsRoutes = require('./routes/order-requests');
const productionRoutes = require('./routes/production');
const deliveriesRoutes = require('./routes/deliveries');
const trackRoutes = require('./routes/track');
const slipPublicRoutes = require('./routes/slip-public');
const orderRequestPublicRoutes = require('./routes/order-request-public');
const deliveryRoutesRoutes = require('./routes/delivery-routes');
const recurringOrdersRoutes = require('./routes/recurring-orders');
const { processRecurringOrders } = require('./routes/recurring-orders');
const attendanceRoutes = require('./routes/attendance');
const staffManagementRoutes = require('./routes/staff-management');
const deliveryTrackingRoutes = require('./routes/delivery-tracking');
const reportsRoutes = require('./routes/reports');
const notificationsRoutes = require('./routes/notifications');
const uploadRoutes = require('./routes/upload');
const saleAttachmentsRoutes = require('./routes/sale-attachments');
const diagnosticsRoutes = require('./routes/diagnostics');
const { errorHandler, notFound } = require('./middleware/errorHandler');
const { performanceMonitor } = require('./middleware/performance-monitor');
const { getDb, closeDb } = require('./config/database');
const { getDb: getAsyncDb, closeDb: closeAsyncDb } = require('./config/database-async');
const { todayStr, parseServerDate, getTimezone } = require('./utils/time');
const { normalizeSegments, timestampToMinutes, matchSegmentForTime } = require('./utils/shift-work');
const http = require('http');
const { Server: SocketServer } = require('socket.io');
const jwt = require('jsonwebtoken');

const app = express();
// One Nginx hop in production (VPS_DEPLOYMENT_GUIDE.md §9). If a CDN such as
// Cloudflare is put in front, raise this or every visitor counts as one for
// the public rate limiters.
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3001;

// ─── Middleware ───────────────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors({ origin: '*' })); // Allow all origins in dev; restrict in production
app.use(morgan('dev'));
app.use(performanceMonitor); // ⚡ Performance tracking middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ─── Health Check ────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({
    success: true,
    message: 'BloomCart POS API is running',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
  });
});

// ─── Routes ──────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/locations', locationsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/categories', categoriesRoutes);
app.use('/api/materials', materialsRoutes);
app.use('/api/suppliers', suppliersRoutes);
app.use('/api/purchase-orders', purchaseOrdersRoutes);
app.use('/api/stock', stockRoutes);
app.use('/api/products', productsRoutes);
app.use('/api/sales', salesRoutes);
app.use('/api/sales', saleAttachmentsRoutes);
app.use('/api/expenses', expensesRoutes);
app.use('/api/customers', customersRoutes);
app.use('/api/order-requests', orderRequestsRoutes);
app.use('/api/production', productionRoutes);
app.use('/api/deliveries', deliveriesRoutes);
// No `authenticate` middleware — this is the app's first public route.
// See server/routes/track.js and server/utils/tracking-token.js.
app.use('/api/track', trackRoutes);
// No `authenticate` middleware: public slip QR scan page. Own 60/min
// limiter (see server/routes/slip-public.js), not shared with track's.
app.use('/api/slip', slipPublicRoutes);
// No `authenticate` middleware — public, like /api/track. Own rate
// limiter (see server/routes/order-request-public.js), not shared with
// track's.
app.use('/api/order-request', orderRequestPublicRoutes);
app.use('/api/delivery-routes', deliveryRoutesRoutes);
app.use('/api/recurring-orders', recurringOrdersRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/staff', staffManagementRoutes);
app.use('/api/delivery-tracking', deliveryTrackingRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/diagnostics', diagnosticsRoutes); // ⚡ Performance metrics API

// ─── Error Handling ──────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ─── Initialize DB & Start Server ────────────────────────────
getDb(); // Initialize database and create tables
getAsyncDb().catch((err) => {
  console.error('Async DB warm-up failed:', err.message);
});

const httpServer = http.createServer(app);

// ─── Socket.io for live delivery tracking ────────────────────
const io = new SocketServer(httpServer, {
  cors: { origin: '*' },
  pingInterval: 25000,
  pingTimeout: 60000,
});

// Socket.io auth middleware
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Authentication required'));
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'bloomcart-secret-key-2026');
    socket.user = decoded;
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  const { user } = socket;
  console.log(`📍 Socket connected: ${user.id} (${user.role})`);

  // Delivery partner joins their own room
  if (user.role === 'delivery_partner') {
    socket.join(`partner:${user.id}`);
  }

  // Manager/Owner join tracking room
  if (user.role === 'owner' || user.role === 'manager') {
    socket.join('tracking:managers');
  }

  // Delivery partner sends location update
  socket.on('location:update', (data) => {
    if (user.role !== 'delivery_partner') return;

    const locationData = {
      user_id: user.id,
      ...data,
      timestamp: new Date().toISOString(),
    };

    // Broadcast to managers
    io.to('tracking:managers').emit('partner:location', locationData);
  });

  // Customer tracks their delivery
  socket.on('track:delivery', (deliveryId) => {
    socket.join(`delivery:${deliveryId}`);
  });

  socket.on('disconnect', () => {
    console.log(`📍 Socket disconnected: ${user.id}`);
    if (user.role === 'delivery_partner') {
      io.to('tracking:managers').emit('partner:offline', { user_id: user.id });
    }
  });
});

// Make io accessible to routes
app.set('io', io);

const server = httpServer.listen(PORT, () => {
  console.log(`\n🌸 BloomCart POS API running on http://localhost:${PORT}`);
  console.log(`📋 Health check: http://localhost:${PORT}/api/health`);
  console.log(`🔌 Socket.io: enabled for live delivery tracking`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}\n`);

  // Process recurring orders on startup and every 30 minutes
  processRecurringOrders();
  setInterval(processRecurringOrders, 30 * 60 * 1000);

  // ─── Geofence timeout auto clock-out (check every 60 seconds) ──
  const CLOCKOUT_SWEEP_GRACE_HOURS = 4; // hours past the last matched shift-segment end before auto-closing
  const CLOCKOUT_SWEEP_FALLBACK_HOURS = 16; // no shift configured at all — flat safety net
  setInterval(() => {
    try {
      const db = getDb();
      const today = todayStr();

      // ── Part 1: existing geofence-exit-triggered timeout (unchanged
      // in intent, two real bugs fixed — see this task's header) ──
      const exitEvents = db.prepare(`
        SELECT ge.*, es.geofence_timeout_minutes,
               a.id as attendance_id, a.clock_in, a.clock_out
        FROM geofence_events ge
        JOIN employee_shifts es ON ge.user_id = es.user_id AND ge.location_id = es.location_id AND es.is_active = 1
        LEFT JOIN attendance a ON a.user_id = ge.user_id AND a.date = ?
        WHERE ge.event_type = 'exit' AND ge.processed = 0
        AND ge.created_at + (es.geofence_timeout_minutes * INTERVAL '1 minute') <= NOW()
        AND a.clock_in IS NOT NULL AND a.clock_out IS NULL
      `).all(today);

      for (const event of exitEvents) {
        const reenter = db.prepare(`
          SELECT id FROM geofence_events
          WHERE user_id = ? AND location_id = ? AND event_type = 'enter'
          AND created_at > ?
          LIMIT 1
        `).get(event.user_id, event.location_id, event.created_at);

        if (reenter) {
          db.prepare('UPDATE geofence_events SET processed = 1, auto_action = ? WHERE id = ?').run('cancelled_returned', event.id);
          continue;
        }

        const activeOutdoor = db.prepare(`
          SELECT id FROM outdoor_duty_requests
          WHERE user_id = ? AND attendance_id = ? AND status IN ('approved', 'requested')
        `).get(event.user_id, event.attendance_id);

        if (activeOutdoor) continue;

        const nowDate = new Date();
        const now = nowDate.toISOString();
        const clockInDate = parseServerDate(event.clock_in);
        const totalHours = clockInDate ? Math.max(0, (nowDate.getTime() - clockInDate.getTime()) / (1000 * 60 * 60)) : 0;

        db.prepare(`
          UPDATE attendance SET clock_out = ?, clock_out_method = 'auto_timeout',
          total_hours = ?, effective_hours = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(now, Math.round(totalHours * 100) / 100, Math.round(totalHours * 100) / 100, event.attendance_id);

        db.prepare('UPDATE geofence_events SET processed = 1, auto_action = ? WHERE id = ?').run('auto_clock_out', event.id);

        console.log(`⏰ Auto clock-out: user ${event.user_id} after ${event.geofence_timeout_minutes}min geofence timeout`);
      }

      // ── Part 2: clock-out recovery sweep (new) — catches sessions with
      // NO geofence activity at all, e.g. the phone died or the app was
      // force-quit before any exit event could fire. Needs no join to
      // geofence_events. ──
      const openSessions = db.prepare(`
        SELECT a.*, es.shift_start, es.shift_end, es.shift_segments
        FROM attendance a
        LEFT JOIN employee_shifts es ON es.user_id = a.user_id AND es.location_id = a.location_id AND es.is_active = 1
        WHERE a.clock_out IS NULL
      `).all();

      for (const session of openSessions) {
        const clockInDate = parseServerDate(session.clock_in);
        if (!clockInDate) continue;

        let estimatedEndEpoch = null; // best-guess "should have left by" instant
        const segments = normalizeSegments(session.shift_start, session.shift_end, session.shift_segments);
        const clockInMinutesOfDay = timestampToMinutes(session.clock_in);
        if (segments.length > 0 && clockInMinutesOfDay != null) {
          // Use the segment actually matched to this clock-in — the same
          // "latest start at-or-before" rule §6 already established — not
          // the shift's overall last segment. A forgotten MID-shift
          // clock-out on a split shift has to be estimated against ITS OWN
          // segment's end: taking the day's final segment end instead
          // treats a 07:00-12:00 morning session as running to 22:00,
          // inflating total_hours ~3x and leaving the session open (so the
          // employee can't clock in again for their evening segment) for
          // half a day longer than it should be. Single-segment shifts are
          // unaffected — the matched segment IS the last one.
          const matchedSegment = matchSegmentForTime(clockInMinutesOfDay, segments);
          const segmentEndMinutes = matchedSegment ? matchedSegment.end : Math.max(...segments.map((s) => s.end));
          // Anchor to shop-timezone midnight of the clock-in's own day via
          // epoch arithmetic (avoids constructing a Date with an explicit
          // UTC-offset string, which Intl doesn't hand back directly).
          const shopMidnightEpoch = clockInDate.getTime() - clockInMinutesOfDay * 60000;
          estimatedEndEpoch = shopMidnightEpoch + segmentEndMinutes * 60000;
        }

        // The estimate is anchored to the clock-in's OWN calendar day, so a
        // clock-in that lands after its matched segment's end — a stale or
        // simply wrong shift row, entirely plausible given shift rows were
        // never read by anything until this redesign — produces an estimate
        // EARLIER than the clock-in itself. Never let that make a session
        // due before the grace period has even elapsed since it started:
        // anchor the due-time to whichever is later.
        const dueAnchorEpoch = estimatedEndEpoch != null
          ? Math.max(estimatedEndEpoch, clockInDate.getTime())
          : clockInDate.getTime();
        const closeAfterEpoch = estimatedEndEpoch != null
          ? dueAnchorEpoch + CLOCKOUT_SWEEP_GRACE_HOURS * 60 * 60 * 1000
          : dueAnchorEpoch + CLOCKOUT_SWEEP_FALLBACK_HOURS * 60 * 60 * 1000;

        if (Date.now() < closeAfterEpoch) continue; // not due yet

        const activeOutdoor = db.prepare(`
          SELECT id FROM outdoor_duty_requests
          WHERE user_id = ? AND attendance_id = ? AND status IN ('approved', 'requested')
        `).get(session.user_id, session.id);

        if (activeOutdoor) continue;

        // Record the estimated shift-end time as the clock-out when it is
        // genuinely AFTER the clock-in — closer to reality than "whenever
        // this cron tick happened to run," which could be hours after the
        // grace window opened. When the estimate is nonsensical (before the
        // clock-in — the stale-shift-config case guarded above) or there's
        // no shift at all, fall back to now: a clock_out must never precede
        // its clock_in, which would silently write total_hours = 0 (via the
        // Math.max below) and void real worked — and for hourly staff, paid
        // — time, on an internally impossible row.
        const clockOutEpoch = (estimatedEndEpoch != null && estimatedEndEpoch > clockInDate.getTime())
          ? estimatedEndEpoch : Date.now();
        const clockOutIso = new Date(clockOutEpoch).toISOString();
        const totalHours = Math.max(0, (clockOutEpoch - clockInDate.getTime()) / (1000 * 60 * 60));

        db.prepare(`
          UPDATE attendance SET clock_out = ?, clock_out_method = 'auto_shift_end',
          total_hours = ?, effective_hours = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(clockOutIso, Math.round(totalHours * 100) / 100, Math.round(totalHours * 100) / 100, session.id);

        console.log(`⏰ Clock-out sweep: closed session ${session.id} for user ${session.user_id}, open since ${session.clock_in}`);
      }
    } catch (e) {
      // Silent — don't crash the server for cron errors
    }
  }, 60 * 1000);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🔄 Shutting down gracefully...');
  closeDb();
  closeAsyncDb().catch(() => {});
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  closeDb();
  closeAsyncDb().catch(() => {});
  server.close(() => process.exit(0));
});

module.exports = app;
