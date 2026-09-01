require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const orderRoutes = require('./routes/orders');
const pushRoutes = require('./routes/push');
const requireAuth = require('./middleware/requireAuth');
const { initDB, query } = require('./db/init');
const SyncService = require('./services/syncService');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Health check - без авторизации и без ожидания готовности БД, чтобы всегда быстро отвечать
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

let syncService = null;

// Инициализация (подключение к БД, загрузка магазинов) выполняется один раз и кешируется
// в промисе. Локально это происходит перед app.listen; на Vercel (serverless) отдельного
// "старта" нет - каждый холодный старт функции ждёт этот же промис перед первым запросом.
const ready = (async () => {
  await initDB();
  console.log('✓ Database initialized');

  syncService = new SyncService();

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

  // setInterval-синхронизация работает только для обычного долгоживущего процесса
  // (локально/на VPS). На Vercel serverless-функция не живёт между запросами - там
  // расписание держит Vercel Cron (см. vercel.json -> /api/cron/sync раз в сутки на
  // тарифе Hobby) плюс ручная кнопка "Синхронизировать" в интерфейсе.
  if (!process.env.VERCEL && Object.keys(syncService.services).length > 0) {
    syncService.startCron(parseInt(process.env.SYNC_INTERVAL_MINUTES || 15));
  }

  app.locals.syncService = syncService;
})();

ready.catch(err => console.error('Initialization error:', err));

// Дожидаемся готовности (БД + магазины) перед обработкой любого запроса, кроме /api/health выше
app.use((req, res, next) => {
  ready.then(() => next()).catch(next);
});

// Все заказы/товары - только для вошедших пользователей (см. middleware/requireAuth.js).
app.use('/api/orders', requireAuth, orderRoutes);
app.use('/api/push', pushRoutes);

// GET /api/stores - Список магазинов для переключателя
app.get('/api/stores', requireAuth, async (req, res, next) => {
  try {
    const result = await query('SELECT id, name FROM stores ORDER BY name');
    res.json({ data: result.rows });
  } catch (error) {
    next(error);
  }
});

// GET /api/cron/sync - вызывается Vercel Cron (см. vercel.json), раз в сутки на тарифе Hobby.
// Vercel сам добавляет заголовок Authorization: Bearer <CRON_SECRET> к своим запросам, если
// задана переменная окружения CRON_SECRET - проверяем её, чтобы эндпоинт нельзя было дёрнуть
// кем попало (без CRON_SECRET в .env проверка просто пропускается - удобно для локальной разработки).
app.get('/api/cron/sync', async (req, res, next) => {
  try {
    if (process.env.CRON_SECRET) {
      const authHeader = req.headers.authorization || '';
      if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }
    const results = await syncService.syncAll();
    res.json({ message: 'Cron sync completed', results, timestamp: new Date().toISOString() });
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

// Локальный запуск (node index.js / npm start) - на Vercel этот файл просто экспортирует app,
// без собственного app.listen (это делает рантайм @vercel/node).
if (require.main === module) {
  ready.then(() => {
    const server = app.listen(PORT, () => {
      console.log(`\n✓ Server running on http://localhost:${PORT}`);
      console.log(`✓ Dashboard: http://localhost:3000`);
      console.log(`✓ API health: http://localhost:${PORT}/api/health`);
    });

    process.on('SIGTERM', () => {
      console.log('\n⛔ SIGTERM received, shutting down gracefully');
      server.close(() => {
        console.log('Server closed');
        process.exit(0);
      });
    });
  }).catch(error => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });
}

module.exports = app;
