const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  // Побольше соединений в пуле - синхронизация теперь обрабатывает заказы параллельно
  // (см. services/syncService.js), а в проде это Supabase Postgres через transaction pooler
  // (PgBouncer), который сам мультиплексирует много логических соединений поверх немногих
  // реальных - раздувать пул с нашей стороны безопасно.
  max: 20
});

const schema = `
-- Весь скрипт уходит одним простым запросом, то есть одной неявной транзакцией, и
-- держит AccessExclusiveLock на таблицах до самого конца. Два холодных старта разом
-- (на serverless это норма) успевали взять блокировки навстречу друг другу и один из
-- них падал с deadlock detected, унося с собой весь инстанс. Консультативная блокировка
-- выстраивает их в очередь: второй просто дождётся первого и увидит уже готовую схему.
-- Именно xact-версия, а не сессионная: она снимается по концу транзакции, что
-- обязательно при работе через PgBouncer в transaction-режиме.
SELECT pg_advisory_xact_lock(918273645);

-- Магазины
CREATE TABLE IF NOT EXISTS stores (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  api_token VARCHAR(500) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Заказы
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  store_id INTEGER REFERENCES stores(id),
  kaspi_order_id VARCHAR(255) UNIQUE NOT NULL,
  order_code VARCHAR(100),
  status VARCHAR(100),
  state VARCHAR(50), -- 'NEW', 'SIGN_REQUIRED', 'PICKUP', 'DELIVERY', 'KASPI_DELIVERY', 'ARCHIVE'
  stage VARCHAR(50), -- 'active', 'shipping', 'completed', 'cancelled'
  delivery_date DATE,
  urgency VARCHAR(50), -- 'overdue', 'today', 'upcoming'
  raw_data JSONB,
  synced_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Каталог товаров магазина (наполняется из заказов и/или импортом из кабинета Kaspi).
-- Один товар (по артикулу) -> много позиций в order_items (один-ко-многим).
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  store_id INTEGER REFERENCES stores(id),
  sku VARCHAR(255) NOT NULL,
  name VARCHAR(500) NOT NULL,
  category VARCHAR(255),
  price NUMERIC,
  image_url TEXT,
  units_per_space INTEGER DEFAULT 1, -- УСТАРЕЛО, оставлено для совместимости - см. spaces_per_unit
  spaces_per_unit NUMERIC(10,4) DEFAULT 1, -- сколько мест накладной занимает 1 единица товара.
                                            -- Для мелких товаров (много штук в одном месте) это дробь < 1
                                            -- (например 0.1 = 10 шт в 1 месте). Для крупных/громоздких
                                            -- товаров (несколько мест на 1 шт) это число >= 1
                                            -- (например 4 = 1 шт занимает 4 места).
  source VARCHAR(20) DEFAULT 'order', -- 'order' (найден в заказе) или 'import' (загружен из CSV)
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(store_id, sku)
);

-- Позиции заказов
CREATE TABLE IF NOT EXISTS order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id),
  product_code VARCHAR(255),
  sku VARCHAR(255),
  name VARCHAR(500),
  quantity INTEGER,
  image_url TEXT,
  raw_data JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(order_id, product_code)
);

-- История синхронизации
CREATE TABLE IF NOT EXISTS sync_history (
  id SERIAL PRIMARY KEY,
  store_id INTEGER REFERENCES stores(id),
  status VARCHAR(50), -- 'success', 'error'
  message TEXT,
  synced_count INTEGER,
  error_count INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Push-уведомления (для Web Push API)
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id SERIAL PRIMARY KEY,
  endpoint TEXT UNIQUE NOT NULL,
  auth VARCHAR(255),
  p256dh VARCHAR(255),
  active BOOLEAN DEFAULT TRUE,
  subscribed_at TIMESTAMP DEFAULT NOW(),
  last_updated TIMESTAMP DEFAULT NOW()
);

-- История уведомлений
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  title VARCHAR(255),
  message TEXT,
  data JSONB,
  sent_count INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Индексы для быстрого поиска
CREATE INDEX IF NOT EXISTS idx_products_store ON products(store_id);
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
CREATE INDEX IF NOT EXISTS idx_orders_store_id ON orders(store_id);
CREATE INDEX IF NOT EXISTS idx_orders_delivery_date ON orders(delivery_date);
CREATE INDEX IF NOT EXISTS idx_orders_urgency ON orders(urgency);
CREATE INDEX IF NOT EXISTS idx_orders_stage ON orders(stage);
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product_code ON order_items(product_code);
CREATE INDEX IF NOT EXISTS idx_sync_history_store ON sync_history(store_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at);

-- Миграция: spaces_per_unit вместо старого units_per_space (шт. в 1 месте).
-- Переносим старые значения в новый формат: мест на 1 шт = 1 / units_per_space.
ALTER TABLE products ADD COLUMN IF NOT EXISTS spaces_per_unit NUMERIC(10,4) DEFAULT 1;
UPDATE products
SET spaces_per_unit = ROUND(1.0 / units_per_space, 4)
WHERE units_per_space IS NOT NULL AND units_per_space > 1 AND spaces_per_unit = 1;

-- Миграция: дата создания заказа в Kaspi (order_date) - отдельно от delivery_date
-- (плановая дата доставки клиенту) и synced_at (когда мы сами его затянули в базу).
-- Нужна для фильтра "новые заказы за сегодня/вчера/месяц".
ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_date TIMESTAMP;
CREATE INDEX IF NOT EXISTS idx_orders_order_date ON orders(order_date);

-- Миграция: плановая дата передачи курьеру (kaspiDelivery.courierTransmissionPlanningDate).
-- Именно её продавец видит в кабинете Kaspi как «Планируемая дата передачи курьеру», и
-- именно по ней он планирует день отгрузки. delivery_date - это другая дата, плановое
-- прибытие к клиенту (обычно на 1-3 дня позже), поэтому фильтр по дням отгрузки на неё
-- опираться не может: за один и тот же день числа расходятся в разы.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS ship_date DATE;
CREATE INDEX IF NOT EXISTS idx_orders_ship_date ON orders(ship_date);

-- Миграция: хеш присланного Kaspi JSON заказа. У Kaspi нет фильтра "изменённые с ...",
-- он всегда отдаёт все заказы за 14 дней, поэтому изменившиеся мы вычисляем сами -
-- сравнением хеша. Без этого каждая синхронизация переписывала все ~1300 заказов,
-- хотя реально между запусками меняются единицы (см. services/syncService.js).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS raw_hash TEXT;

-- Внутренние статусы компании (CRM-режим) - своя воронка работы поверх статусов Kaspi.
-- Пользователь переименовывает, добавляет и удаляет их прямо в интерфейсе, поэтому это
-- таблица, а не список в коде. Заказ ссылается на статус; при удалении статуса заказы
-- не пропадают, а просто остаются без внутреннего статуса.
CREATE TABLE IF NOT EXISTS crm_statuses (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  color VARCHAR(20) NOT NULL DEFAULT '#8A8177',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS crm_status_id INTEGER
  REFERENCES crm_statuses(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS crm_status_changed_at TIMESTAMP;
CREATE INDEX IF NOT EXISTS idx_orders_crm_status ON orders(crm_status_id);

-- Роли пользователей. Здесь перечислены исключения: кто не указан - администратор,
-- а менеджеров владелец добавляет явно (см. middleware/requireAuth.js).
CREATE TABLE IF NOT EXISTS app_users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  role VARCHAR(20) NOT NULL DEFAULT 'manager' CHECK (role IN ('admin', 'manager')),
  note VARCHAR(200),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Стартовый набор колонок доски - только если пользователь ещё ничего не заводил
INSERT INTO crm_statuses (name, color, position)
SELECT * FROM (VALUES
  ('Новый',       '#6E93B8', 1),
  ('В работе',    '#D6A756', 2),
  ('Собран',      '#7FA07F', 3),
  ('Отгружен',    '#5F7D8C', 4),
  ('Проблемный',  '#E0524A', 5)
) AS seed(name, color, position)
WHERE NOT EXISTS (SELECT 1 FROM crm_statuses);
`;

// Схема и все миграции выполняются одним запросом, а не по одному на выражение.
// Это происходит на каждом холодном старте функции, а до базы (Supabase в Токио) круг
// занимает сотни миллисекунд - десяток отдельных запросов заметно задерживал и синк,
// и первый ответ дашборду. Параметров здесь нет, поэтому весь скрипт уходит одним пакетом.
async function initDB() {
  try {
    await pool.query(schema);
    console.log('✓ Schema and migrations verified');
    return pool;
  } catch (error) {
    console.error('Database initialization error:', error);
    throw error;
  }
}

module.exports = {
  pool,
  initDB,
  query: (text, params) => pool.query(text, params)
};
