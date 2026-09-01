require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const orderRoutes = require('./routes/orders');
const authRoutes = require('./routes/auth');
const pushRoutes = require('./routes/push');
const { initDB, query } = require('./db/init');
const SyncService = require('./services/syncService');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/push', pushRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// GET /api/stores - Список магазинов для переключателя
app.get('/api/stores', async (req, res, next) => {
  try {
    const result = await query('SELECT id, name FROM stores ORDER BY name');
    res.json({ data: result.rows });
  } catch (error) {
    next(error);
  }
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// Global sync service
let syncService = null;

// Start server
async function start() {
  try {
    // Initialize database
    await initDB();
    console.log('✓ Database initialized');

    // Initialize sync service with configured stores from DB
    syncService = new SyncService();

    // Получить магазины из БД
    const storesResult = await query('SELECT id, name, api_token FROM stores WHERE api_token IS NOT NULL');
    for (const store of storesResult.rows) {
      syncService.addStore(store.id, store.api_token, store.name);
      console.log(`✓ Store loaded: ${store.name} (ID: ${store.id})`);
    }

    if (storesResult.rows.length === 0) {
      console.warn('⚠️  No stores configured in database');
    } else {
      console.log(`✓ Sync service initialized with ${storesResult.rows.length} store(s)`);
    }

    // Запустить периодическую синхронизацию
    if (Object.keys(syncService.services).length > 0) {
      syncService.startCron(parseInt(process.env.SYNC_INTERVAL_MINUTES || 15));
    }

    // Сделать sync service доступным в routes
    app.locals.syncService = syncService;

    const server = app.listen(PORT, () => {
      console.log(`\n✓ Server running on http://localhost:${PORT}`);
      console.log(`✓ Dashboard: http://localhost:3000`);
      console.log(`✓ API health: http://localhost:${PORT}/api/health`);
    });

    // Graceful shutdown
    process.on('SIGTERM', () => {
      console.log('\n⛔ SIGTERM received, shutting down gracefully');
      server.close(() => {
        console.log('Server closed');
        process.exit(0);
      });
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
