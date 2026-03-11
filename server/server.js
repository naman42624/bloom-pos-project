require('dotenv').config();

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
const productionRoutes = require('./routes/production');
const deliveriesRoutes = require('./routes/deliveries');
const recurringOrdersRoutes = require('./routes/recurring-orders');
const { processRecurringOrders } = require('./routes/recurring-orders');
const attendanceRoutes = require('./routes/attendance');
const staffManagementRoutes = require('./routes/staff-management');
const deliveryTrackingRoutes = require('./routes/delivery-tracking');
const reportsRoutes = require('./routes/reports');
const notificationsRoutes = require('./routes/notifications');
const { errorHandler, notFound } = require('./middleware/errorHandler');
const { getDb, closeDb } = require('./config/database');
const http = require('http');
const { Server: SocketServer } = require('socket.io');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Middleware ───────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: '*' })); // Allow all origins in dev; restrict in production
app.use(morgan('dev'));
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
app.use('/api/expenses', expensesRoutes);
app.use('/api/customers', customersRoutes);
app.use('/api/production', productionRoutes);
app.use('/api/deliveries', deliveriesRoutes);
app.use('/api/recurring-orders', recurringOrdersRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/staff', staffManagementRoutes);
app.use('/api/delivery-tracking', deliveryTrackingRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/notifications', notificationsRoutes);

// ─── Error Handling ──────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ─── Initialize DB & Start Server ────────────────────────────
getDb(); // Initialize database and create tables

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
  setInterval(() => {
    try {
      const db = getDb();
      const n = new Date();
      const today = `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;

      // Find unprocessed exit events older than the employee's timeout
      const exitEvents = db.prepare(`
        SELECT ge.*, es.geofence_timeout_minutes,
               a.id as attendance_id, a.clock_in, a.clock_out
        FROM geofence_events ge
        JOIN employee_shifts es ON ge.user_id = es.user_id AND ge.location_id = es.location_id AND es.is_active = 1
        LEFT JOIN attendance a ON a.user_id = ge.user_id AND a.date = ?
        WHERE ge.event_type = 'exit' AND ge.processed = 0
        AND datetime(ge.created_at, '+' || es.geofence_timeout_minutes || ' minutes') <= datetime('now')
        AND a.clock_in IS NOT NULL AND a.clock_out IS NULL
      `).all(today);

      for (const event of exitEvents) {
        // Check if there's a more recent enter event
        const reenter = db.prepare(`
          SELECT id FROM geofence_events
          WHERE user_id = ? AND location_id = ? AND event_type = 'enter'
          AND created_at > ?
          LIMIT 1
        `).get(event.user_id, event.location_id, event.created_at);

        if (reenter) {
          // Employee returned, mark exit as processed
          db.prepare('UPDATE geofence_events SET processed = 1, auto_action = ? WHERE id = ?').run('cancelled_returned', event.id);
          continue;
        }

        // Check for active outdoor duty (pauses geofence timeout)
        const activeOutdoor = db.prepare(`
          SELECT id FROM outdoor_duty_requests
          WHERE user_id = ? AND attendance_id = ? AND status IN ('approved', 'requested')
        `).get(event.user_id, event.attendance_id);

        if (activeOutdoor) {
          continue; // Skip — outdoor duty is active
        }

        // Auto clock-out
        const now = new Date().toISOString();
        const clockIn = event.clock_in;
        const totalHours = clockIn ? Math.max(0, (new Date(now) - new Date(clockIn)) / (1000 * 60 * 60)) : 0;

        db.prepare(`
          UPDATE attendance SET clock_out = ?, clock_out_method = 'auto_timeout',
          total_hours = ?, effective_hours = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(now, Math.round(totalHours * 100) / 100, Math.round(totalHours * 100) / 100, event.attendance_id);

        db.prepare('UPDATE geofence_events SET processed = 1, auto_action = ? WHERE id = ?').run('auto_clock_out', event.id);

        console.log(`⏰ Auto clock-out: user ${event.user_id} after ${event.geofence_timeout_minutes}min timeout`);
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
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  closeDb();
  server.close(() => process.exit(0));
});

module.exports = app;
